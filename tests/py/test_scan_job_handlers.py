from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.jobs.models import ClaimedJob, JobState, JobTransitionResult
from music_app.services.library_event_coordinator import TargetedReconciliationRequest
from music_app.services.targeted_library_reconciliation import (
    TargetedReconciliationResult,
)


NOW = datetime(2026, 9, 6, 20, 0, tzinfo=timezone.utc)


def _claim() -> ClaimedJob:
    return ClaimedJob(
        job_id=901,
        kind="targeted_reconciliation",
        subject_kind="targeted_reconciliation_intent",
        subject_ref="84",
        parameters={"intent_id": 84},
        account_id=None,
        library_id=19,
        capability_key=None,
        request_origin_id=None,
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        idempotency_key="targeted-reconciliation-request:watcher-batch-1",
        attempt=2,
        max_attempts=3,
        worker_id="worker-a",
        lease_token="lease-a",
        lease_expires_at=NOW + timedelta(minutes=5),
        scheduled_at=NOW,
    )


class _Context:
    def __init__(self, *, allowed=True):
        self.claim = _claim()
        self.lease_active = True
        self.cancel_requested = False
        self.allowed = allowed
        self.reauthorizations = 0

    def reauthorize(self):
        self.reauthorizations += 1
        return SimpleNamespace(allowed=self.allowed, reason_code="authorized")

    def request_cancellation(self):
        self.cancel_requested = True

    def mark_lease_lost(self):
        self.lease_active = False


class _ScanRepository:
    def __init__(self, *, healthy=True, roots=None):
        self.request = TargetedReconciliationRequest(
            root_id="root-a",
            deleted_paths=frozenset({Path("C:/Music/Removed/01.flac")}),
            preserved_subtrees=frozenset(
                {Path("C:/Music/Removed/Recreated Disc")}
            ),
        )
        self.intent = SimpleNamespace(
            intent_id=84,
            library_id=19,
            request=self.request,
            exception_overrides={"C:/Music/Removed/01.flac": "Interview"},
        )
        self.roots = roots if roots is not None else (
            {
                "id": "root-a",
                "path": Path("C:/Music"),
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
        )
        self.healthy = healthy
        self.loads = []
        self.scope_loads = []
        self.preparation_loads = []
        self.fences = []
        self.published_attempts = set()

    def load_claimed_targeted_reconciliation(self, **kwargs):
        self.loads.append(kwargs)
        return self.intent

    def load_claimed_targeted_reconciliation_scope(self, **kwargs):
        self.scope_loads.append(kwargs)
        return SimpleNamespace(
            roots=self.roots,
            root_healthy=self.healthy,
            scope_complete=True,
        )

    def load_claimed_targeted_reconciliation_preparation(self, **kwargs):
        self.preparation_loads.append(kwargs)
        return SimpleNamespace(
            separate_release_keys=("artist::album::disc-2",),
            existing_memberships=(),
        )

    def fence_targeted_reconciliation_publication(
        self, *, connection, claim, intent_id, commit, now
    ):
        self.fences.append(
            {
                "connection": connection,
                "job_id": claim.job_id,
                "intent_id": intent_id,
                "attempt": claim.attempt,
                "worker_id": claim.worker_id,
                "lease_token": claim.lease_token,
                "now": now,
            }
        )
        identity = (claim.job_id, claim.attempt)
        if identity in self.published_attempts:
            return False
        self.published_attempts.add(identity)
        commit()
        return True


class _Reconciler:
    def __init__(self, *, before_publication=None):
        self.before_publication = before_publication
        self.roots = []
        self.exception_overrides = []
        self.requests = []
        self.mutations = []

    def replace_roots(self, roots):
        self.roots.append(tuple(roots))

    def replace_exception_overrides(self, overrides):
        self.exception_overrides.append(dict(overrides))

    def reconcile(
        self,
        request,
        *,
        root_healthy,
        publication_guard,
        root_definitions,
        exception_overrides,
        preparation_scope,
    ):
        self.replace_roots(root_definitions)
        self.replace_exception_overrides(exception_overrides)
        self.requests.append((request, root_healthy))
        self.preparation_scope = preparation_scope
        if self.before_publication is not None:
            self.before_publication()
        committed = publication_guard(
            "inventory-connection",
            lambda: self.mutations.append(request),
        )
        if not committed:
            return TargetedReconciliationResult(0, (), "already_published")
        return TargetedReconciliationResult(31, ("artist::album",))


def _handler(scan_repository, reconciler, invalidated):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    return build_targeted_reconciliation_handler(
        scan_repository=scan_repository,
        reconciler=reconciler,
        invalidate_projections=lambda result: invalidated.append(result),
        clock=lambda: NOW,
    )


def test_handler_reloads_private_intent_and_current_roots_before_publication():
    repository = _ScanRepository()
    reconciler = _Reconciler()
    invalidated = []
    context = _Context()

    outcome = _handler(repository, reconciler, invalidated)(_claim(), context)

    assert repository.loads == [
        {"job_id": 901, "worker_id": "worker-a", "lease_token": "lease-a"}
    ]
    assert repository.scope_loads == [
        {
            "intent_id": 84,
            "library_id": 19,
            "job_id": 901,
            "attempt": 2,
            "worker_id": "worker-a",
            "lease_token": "lease-a",
            "now": NOW,
        }
    ]
    assert repository.preparation_loads == repository.scope_loads
    assert reconciler.preparation_scope.separate_release_keys == (
        "artist::album::disc-2",
    )
    assert reconciler.roots == [repository.roots]
    assert reconciler.exception_overrides == [repository.intent.exception_overrides]
    assert reconciler.requests == [(repository.request, True)]
    assert reconciler.requests[0][0].preserved_subtrees == frozenset(
        {Path("C:/Music/Removed/Recreated Disc")}
    )
    assert context.reauthorizations == 1
    assert reconciler.mutations == [repository.request]
    assert repository.fences[0]["connection"] == "inventory-connection"
    assert invalidated == [TargetedReconciliationResult(31, ("artist::album",))]
    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "targeted_reconciliation_completed"


@pytest.mark.parametrize("method", [
    "load_claimed_targeted_reconciliation",
    "load_claimed_targeted_reconciliation_scope",
    "load_claimed_targeted_reconciliation_preparation",
])
@pytest.mark.parametrize(
    "attempt,expected", [(2, JobState.RETRY_WAIT), (3, JobState.FAILED)]
)
def test_targeted_storage_failure_retries_until_attempt_limit(method, attempt, expected):
    import psycopg

    repository = _ScanRepository()

    def unavailable(**_kwargs):
        raise psycopg.OperationalError("private connection failure")

    setattr(repository, method, unavailable)
    reconciler = _Reconciler()
    outcome = _handler(repository, reconciler, [])(
        replace(_claim(), attempt=attempt), _Context()
    )
    assert outcome.next_state is expected
    assert outcome.reason_code == "targeted_reconciliation_unavailable"
    assert (outcome.scheduled_at is not None) is (expected is JobState.RETRY_WAIT)
    assert reconciler.requests == []


def test_targeted_validator_distinguishes_unavailable_storage_from_invalid_scope():
    import psycopg
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_resource_validator

    def unavailable(**_kwargs):
        raise psycopg.OperationalError("private connection failure")

    repository = SimpleNamespace(load_claimed_targeted_reconciliation_scope=unavailable)
    decision = build_targeted_reconciliation_resource_validator(
        scan_repository=repository,
    )(_claim(), None, NOW)
    assert not decision.allowed
    assert decision.reason_code == "authorization_unavailable"
    assert decision.indeterminate is True


@pytest.mark.parametrize(
    ("health", "expected_state", "reason"),
    (
        ("stable_write_unavailable", JobState.FAILED, "targeted_stable_write_unavailable"),
        ("healthy", JobState.SUCCEEDED, "targeted_reconciliation_completed"),
        ("cancelled", JobState.CANCELED, "targeted_root_invalid"),
        (None, JobState.CANCELED, "targeted_root_invalid"),
        ("error", JobState.FAILED, "targeted_reconciliation_failed"),
    ),
)
def test_targeted_handler_preserves_health_reason_for_atomic_job_finalization(
    health, expected_state, reason,
):
    def reconcile(_request, **_kwargs):
        if health == "error":
            raise OSError("private filesystem failure")
        return SimpleNamespace(health=health)

    invalidated = []
    outcome = _handler(
        _ScanRepository(), SimpleNamespace(reconcile=reconcile), invalidated,
    )(_claim(), _Context())

    assert outcome == JobTransitionResult(expected_state, reason)
    assert bool(invalidated) is (health == "healthy")


@pytest.mark.parametrize(
    ("roots", "healthy", "reason"),
    (
        ((), True, "targeted_root_invalid"),
        (
            (
                {
                    "id": "root-a",
                    "path": Path("C:/Music"),
                    "category": "main_library_roots",
                    "library_id": 20,
                    "is_active": True,
                },
            ),
            True,
            "targeted_root_invalid",
        ),
        (
            (
                {
                    "id": "root-a",
                    "path": Path("C:/Music"),
                    "category": "main_library_roots",
                    "library_id": 19,
                    "is_active": False,
                },
            ),
            True,
            "targeted_root_invalid",
        ),
        (None, False, "targeted_root_unhealthy"),
    ),
)
def test_handler_fails_closed_for_removed_cross_library_inactive_or_unhealthy_root(
    roots, healthy, reason
):
    repository = _ScanRepository(roots=roots, healthy=healthy)
    reconciler = _Reconciler()
    invalidated = []

    outcome = _handler(repository, reconciler, invalidated)(_claim(), _Context())

    assert outcome.next_state is JobState.CANCELED
    assert outcome.reason_code == reason
    assert reconciler.requests == []
    assert repository.fences == []
    assert invalidated == []


@pytest.mark.parametrize("lost", ("cancel", "lease"))
def test_cancellation_or_lease_loss_after_parse_prevents_publication(lost):
    context = _Context()
    repository = _ScanRepository()
    before_publication = (
        context.request_cancellation if lost == "cancel" else context.mark_lease_lost
    )
    reconciler = _Reconciler(before_publication=before_publication)
    invalidated = []

    outcome = _handler(repository, reconciler, invalidated)(_claim(), context)

    assert outcome.next_state is JobState.CANCELED
    assert reconciler.mutations == []
    assert repository.fences == []
    assert invalidated == []


def test_duplicate_dispatch_commits_and_invalidates_projection_only_once():
    repository = _ScanRepository()
    invalidated = []
    first_reconciler = _Reconciler()
    second_reconciler = _Reconciler()

    first = _handler(repository, first_reconciler, invalidated)(_claim(), _Context())
    second = _handler(repository, second_reconciler, invalidated)(_claim(), _Context())

    assert first.next_state is JobState.SUCCEEDED
    assert second.next_state is JobState.SUCCEEDED
    assert first_reconciler.mutations == [repository.request]
    assert second_reconciler.mutations == []
    assert len(repository.fences) == 2
    assert len(invalidated) == 1


def _full_claim() -> ClaimedJob:
    return ClaimedJob(
        job_id=902,
        kind="full_scan",
        subject_kind="full_scan_intent",
        subject_ref="85",
        parameters={"intent_id": 85},
        account_id=7,
        library_id=19,
        capability_key="library.refresh",
        request_origin_id=11,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key="full-scan-intent:85",
        attempt=3,
        max_attempts=3,
        worker_id="worker-full",
        lease_token="lease-full",
        lease_expires_at=NOW + timedelta(minutes=5),
        scheduled_at=NOW,
    )


def _post_scan_cover_claim() -> ClaimedJob:
    return ClaimedJob(
        job_id=903,
        kind="post_scan_cover_refresh",
        subject_kind="inventory_revision",
        subject_ref="revision-41",
        parameters={"inventory_revision": 41},
        account_id=None,
        library_id=19,
        capability_key=None,
        request_origin_id=None,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key="post-scan-cover-refresh:19:41",
        attempt=1,
        max_attempts=2,
        worker_id="worker-cover",
        lease_token="lease-cover",
        lease_expires_at=NOW + timedelta(minutes=5),
        scheduled_at=NOW,
        resource_revision=41,
    )


def test_post_scan_cover_validator_requires_current_claimed_inventory_revision():
    from music_app.jobs.scan_handlers import (
        build_post_scan_cover_refresh_resource_validator,
    )

    calls = []
    repository = SimpleNamespace(
        validate_claimed_post_scan_cover_refresh=lambda **kwargs: calls.append(kwargs)
        or True
    )

    decision = build_post_scan_cover_refresh_resource_validator(
        scan_repository=repository
    )(_post_scan_cover_claim(), None, NOW)

    assert decision.allowed is True
    assert decision.reason_code == "post_scan_cover_scope_current"
    assert calls == [
        {
            "library_id": 19,
            "inventory_revision": 41,
            "job_id": 903,
            "attempt": 1,
            "worker_id": "worker-cover",
            "lease_token": "lease-cover",
            "now": NOW,
        }
    ]


@pytest.mark.parametrize(
    "changes",
    (
        {"subject_ref": "C:/private/Album"},
        {"parameters": {"inventory_revision": 40}},
        {"resource_revision": 40},
        {"idempotency_key": "post-scan-cover-refresh:19:40"},
        {"library_id": None},
    ),
)
def test_post_scan_cover_validator_rejects_malformed_or_mismatched_scope(changes):
    from music_app.jobs.scan_handlers import (
        build_post_scan_cover_refresh_resource_validator,
    )

    claim = replace(_post_scan_cover_claim(), **changes)
    repository = SimpleNamespace(
        validate_claimed_post_scan_cover_refresh=lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("malformed claims must not reach the repository")
        )
    )

    decision = build_post_scan_cover_refresh_resource_validator(
        scan_repository=repository
    )(claim, None, NOW)

    assert decision.allowed is False
    assert decision.reason_code == "post_scan_cover_scope_invalid"


def test_post_scan_cover_handler_invokes_existing_cover_bridge_once():
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler

    calls = []
    context = _FullContext()
    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=lambda **kwargs: calls.append(kwargs) or True,
    )(_post_scan_cover_claim(), context)

    assert outcome == JobTransitionResult(
        JobState.SUCCEEDED, "post_scan_cover_refresh_completed"
    )
    assert len(calls) == 1
    assert calls[0]["library_id"] == 19
    assert calls[0]["inventory_revision"] == 41
    assert callable(calls[0]["should_cancel"])


@pytest.mark.parametrize(
    ("mutation", "reason"),
    (
        ("cancel", "post_scan_cover_refresh_canceled"),
        ("lease", "post_scan_cover_refresh_lease_lost"),
        ("authority", "post_scan_cover_scope_stale"),
    ),
)
def test_post_scan_cover_handler_fails_closed_before_cover_work(mutation, reason):
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler

    context = _FullContext()
    if mutation == "cancel":
        context.cancel_requested = True
    elif mutation == "lease":
        context.lease_active = False
    else:
        context.allowed = False
    calls = []

    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=lambda **kwargs: calls.append(kwargs) or True,
    )(_post_scan_cover_claim(), context)

    assert outcome == JobTransitionResult(JobState.CANCELED, reason)
    assert calls == []


def test_post_scan_cover_handler_maps_bridge_failure_without_leaking_details():
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler

    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=lambda **_kwargs: (_ for _ in ()).throw(
            OSError("C:/Users/private/Music/Album/cover.jpg")
        )
    )(_post_scan_cover_claim(), _FullContext())

    assert outcome == JobTransitionResult(
        JobState.FAILED, "post_scan_cover_refresh_failed"
    )


def test_post_scan_cover_handler_revalidates_revision_during_cooperative_work():
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler

    context = _FullContext()

    def run_cover_refresh(*, should_cancel, **_kwargs):
        context.allowed = False
        assert should_cancel() is True
        return False

    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=run_cover_refresh,
    )(_post_scan_cover_claim(), context)

    assert outcome == JobTransitionResult(
        JobState.CANCELED, "post_scan_cover_scope_stale"
    )


def test_post_scan_cover_handler_models_real_context_authorization_cancellation():
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision

    class Authorization:
        allowed = True

        def authorize(self, _claim, _now):
            return AuthorizationDecision(self.allowed, "scope_current")

    authorization = Authorization()
    context = ExecutionContext(
        _post_scan_cover_claim(),
        authorization_service=authorization,
        clock=lambda: NOW,
    )

    def run_cover_refresh(*, should_cancel, **_kwargs):
        authorization.allowed = False
        assert should_cancel() is True
        assert context.cancel_requested is True
        return False

    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=run_cover_refresh,
    )(_post_scan_cover_claim(), context)

    assert outcome == JobTransitionResult(
        JobState.CANCELED, "post_scan_cover_scope_stale"
    )


def test_post_scan_cover_handler_preserves_committed_success_after_late_cancel():
    from music_app.jobs.scan_handlers import build_post_scan_cover_refresh_handler

    context = _FullContext()

    def run_cover_refresh(**_kwargs):
        context.cancel_requested = True
        return True

    outcome = build_post_scan_cover_refresh_handler(
        run_cover_refresh=run_cover_refresh,
    )(_post_scan_cover_claim(), context)

    assert outcome == JobTransitionResult(
        JobState.SUCCEEDED, "post_scan_cover_refresh_completed"
    )


class _FullContext:
    def __init__(self, *, allowed=True):
        self.claim = _full_claim()
        self.allowed = allowed
        self.cancel_requested = False
        self.lease_active = True
        self.reauthorizations = 0

    def reauthorize(self):
        self.reauthorizations += 1
        return SimpleNamespace(allowed=self.allowed, reason_code="authorized")


class _FullScanRepository:
    def __init__(self, *, roots=("root-a",), revision=40):
        self.intent = SimpleNamespace(
            intent_id=85,
            library_id=19,
            initiating_account_id=7,
            mode="manual_full_rescan",
            force=True,
            root_ids=tuple(roots),
            inventory_mutation_revision=revision,
        )
        self.scope = SimpleNamespace(
            roots=tuple(
                {
                    "id": root_id,
                    "path": Path(f"C:/Music/{root_id}"),
                    "library_id": 19,
                    "is_active": True,
                }
                for root_id in roots
            ),
            inventory_mutation_revision=revision,
            scope_complete=True,
        )
        self.loads = []
        self.scope_loads = []
        self.checkpoints = []

    def load_claimed_full_scan(self, **kwargs):
        self.loads.append(kwargs)
        return self.intent

    def load_claimed_full_scan_scope(self, **kwargs):
        self.scope_loads.append(kwargs)
        return self.scope

    def checkpoint_claimed_full_scan(self, **kwargs):
        self.checkpoints.append(kwargs)
        return True


class _FullScanner:
    def __init__(self, *, error=None, before_publish=None, after_publish=None):
        self.error = error
        self.before_publish = before_publish
        self.after_publish = after_publish
        self.calls = []

    def run(self, intent, *, roots, checkpoint, should_cancel, expected_revision):
        self.calls.append((intent, tuple(roots), expected_revision))
        checkpoint(current=1, total=2, current_path="Artist/Private Album/01.flac")
        if self.before_publish is not None:
            self.before_publish()
        if should_cancel():
            return SimpleNamespace(canceled=True)
        if self.error is not None:
            raise self.error
        checkpoint(current=2, total=2, current_path="Artist/Private Album/02.flac")
        result = SimpleNamespace(
            canceled=False,
            inventory_mutation_revision=expected_revision + 1,
        )
        if self.after_publish is not None:
            self.after_publish()
        return result


def test_full_scan_resource_validator_initializes_claim_before_loading_scope():
    from music_app.jobs.scan_handlers import build_full_scan_resource_validator

    repository = _FullScanRepository()
    decision = build_full_scan_resource_validator(scan_repository=repository)(
        _full_claim(),
        SimpleNamespace(),
        NOW,
    )

    assert decision.allowed is True
    assert decision.reason_code == "full_scan_scope_current"
    assert repository.loads == [
        {"job_id": 902, "worker_id": "worker-full", "lease_token": "lease-full"}
    ]
    assert repository.scope_loads == [
        {
            "intent_id": 85,
            "library_id": 19,
            "job_id": 902,
            "attempt": 3,
            "worker_id": "worker-full",
            "lease_token": "lease-full",
            "now": NOW,
        }
    ]


def _full_handler(repository, scanner, *, logged=None):
    from music_app.jobs.scan_handlers import build_full_scan_handler

    return build_full_scan_handler(
        scan_repository=repository,
        scan_executor=scanner,
        clock=lambda: NOW,
        log_event=(lambda message: logged.append(message)) if logged is not None else None,
    )


@pytest.mark.parametrize("failing_load", ("intent", "scope"))
@pytest.mark.parametrize(
    ("attempt", "expected_state"),
    ((1, JobState.RETRY_WAIT), (2, JobState.FAILED)),
)
def test_full_scan_handler_retries_scope_storage_failure_until_attempt_limit(
    failing_load, attempt, expected_state
):
    repository = _FullScanRepository()
    method = (
        "load_claimed_full_scan"
        if failing_load == "intent"
        else "load_claimed_full_scan_scope"
    )
    setattr(
        repository,
        method,
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    claim = replace(_full_claim(), attempt=attempt, max_attempts=2)

    outcome = _full_handler(repository, _FullScanner())(claim, _FullContext())

    assert outcome.next_state is expected_state
    assert outcome.reason_code == "full_scan_scope_unavailable"
    assert (outcome.scheduled_at == NOW + timedelta(seconds=5)) is (
        expected_state is JobState.RETRY_WAIT
    )


def test_full_scan_handler_reloads_scope_checkpoints_and_completes():
    repository = _FullScanRepository()
    scanner = _FullScanner()
    context = _FullContext()

    outcome = _full_handler(repository, scanner)(_full_claim(), context)

    assert repository.loads == [
        {"job_id": 902, "worker_id": "worker-full", "lease_token": "lease-full"}
    ]
    assert repository.scope_loads == [
        {
            "intent_id": 85,
            "library_id": 19,
            "job_id": 902,
            "attempt": 3,
            "worker_id": "worker-full",
            "lease_token": "lease-full",
            "now": NOW,
        }
    ]
    assert scanner.calls[0][2] == 40
    assert [item["current"] for item in repository.checkpoints] == [1, 2]
    assert all(item["job_id"] == 902 and item["attempt"] == 3 for item in repository.checkpoints)
    assert all(item["worker_id"] == "worker-full" for item in repository.checkpoints)
    assert all(item["lease_token"] == "lease-full" for item in repository.checkpoints)
    assert context.reauthorizations >= 3
    assert outcome == JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")


@pytest.mark.parametrize(
    ("mutation", "reason"),
    (
        ("cancel", "full_scan_canceled"),
        ("lease", "full_scan_lease_lost"),
        ("authority", "full_scan_authority_revoked"),
    ),
)
def test_full_scan_handler_stops_cooperatively_before_publication(mutation, reason):
    repository = _FullScanRepository()
    context = _FullContext()

    def stop():
        if mutation == "cancel":
            context.cancel_requested = True
        elif mutation == "lease":
            context.lease_active = False
        else:
            context.allowed = False

    scanner = _FullScanner(before_publish=stop)
    outcome = _full_handler(repository, scanner)(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.CANCELED, reason)
    assert len(repository.checkpoints) == 1


@pytest.mark.parametrize(
    ("interruption", "expected_state", "expected_reason", "preserve_attempt"),
    (
        (
            "shutdown",
            JobState.RETRY_WAIT,
            "full_scan_worker_shutdown",
            True,
        ),
        (
            "cancel",
            JobState.CANCELED,
            "full_scan_canceled",
            False,
        ),
    ),
)
def test_full_scan_handler_distinguishes_resumable_shutdown_from_cancel(
    interruption, expected_state, expected_reason, preserve_attempt
):
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(
            authorize=lambda _claim, _now: AuthorizationDecision(True, "authorized")
        ),
        clock=lambda: NOW,
    )
    request_interruption = (
        context.request_shutdown
        if interruption == "shutdown"
        else context.request_cancellation
    )

    outcome = _full_handler(
        _FullScanRepository(),
        _FullScanner(before_publish=request_interruption),
    )(replace(_full_claim(), attempt=1, max_attempts=1), context)

    assert outcome.next_state is expected_state
    assert outcome.reason_code == expected_reason
    assert outcome.scheduled_at == (
        NOW + timedelta(seconds=5)
        if expected_state is JobState.RETRY_WAIT
        else None
    )
    assert outcome.preserve_attempt is preserve_attempt


@pytest.mark.parametrize(
    ("interruption", "expected_reason"),
    (
        ("cancel", "full_scan_canceled"),
        ("lease", "full_scan_lease_lost"),
        ("authority", "full_scan_authority_revoked"),
    ),
)
def test_full_scan_terminal_interruption_outranks_concurrent_worker_shutdown(
    interruption, expected_reason
):
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision

    allowed = True

    def authorize(_claim, _now):
        return AuthorizationDecision(allowed, "authorized" if allowed else "revoked")

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(authorize=authorize),
        clock=lambda: NOW,
    )

    def interrupt():
        nonlocal allowed
        context.request_shutdown()
        if interruption == "cancel":
            context.request_cancellation()
        elif interruption == "lease":
            context.mark_lease_lost()
        else:
            allowed = False

    outcome = _full_handler(
        _FullScanRepository(),
        _FullScanner(before_publish=interrupt),
    )(replace(_full_claim(), attempt=1, max_attempts=1), context)

    assert outcome == JobTransitionResult(JobState.CANCELED, expected_reason)


@pytest.mark.parametrize(
    ("interruption", "expected_reason"),
    (
        ("cancel", "full_scan_canceled"),
        ("lease", "full_scan_lease_lost"),
        ("authority", "full_scan_authority_revoked"),
    ),
)
@pytest.mark.parametrize("completion", ("raises", "returns"))
def test_full_scan_terminal_interruption_after_observed_shutdown_outranks_shutdown(
    interruption, expected_reason, completion
):
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.library_indexing import ScanCancelled

    allowed = True

    def authorize(_claim, _now):
        return AuthorizationDecision(allowed, "authorized" if allowed else "revoked")

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(authorize=authorize),
        clock=lambda: NOW,
    )

    class InterruptedScanner:
        @staticmethod
        def run(_intent, *, should_cancel, **_kwargs):
            nonlocal allowed
            context.request_shutdown()
            assert should_cancel() is True
            if interruption == "cancel":
                context.request_cancellation()
            elif interruption == "lease":
                context.mark_lease_lost()
            else:
                allowed = False
            if completion == "raises":
                raise ScanCancelled("Library indexing cancelled")
            return SimpleNamespace(canceled=True)

    outcome = _full_handler(
        _FullScanRepository(),
        InterruptedScanner(),
    )(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.CANCELED, expected_reason)


def test_full_scan_uses_interruption_observed_by_cancellation_predicate():
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.library_indexing import ScanCancelled

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(
            authorize=lambda _claim, _now: AuthorizationDecision(True, "authorized")
        ),
        clock=lambda: NOW,
    )

    class InterruptedScanner:
        @staticmethod
        def run(_intent, *, should_cancel, **_kwargs):
            context.mark_lease_lost()
            assert should_cancel() is True
            context.request_shutdown()
            raise ScanCancelled("Library indexing cancelled")

    outcome = _full_handler(
        _FullScanRepository(),
        InterruptedScanner(),
    )(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.CANCELED, "full_scan_lease_lost")


def test_full_scan_does_not_reclassify_unobserved_scan_cancel_as_late_shutdown():
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.library_indexing import ScanCancelled

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(
            authorize=lambda _claim, _now: AuthorizationDecision(True, "authorized")
        ),
        clock=lambda: NOW,
    )

    class UnexpectedCancellationScanner:
        @staticmethod
        def run(_intent, **_kwargs):
            context.request_shutdown()
            raise ScanCancelled("unrelated executor cancellation")

    outcome = _full_handler(
        _FullScanRepository(),
        UnexpectedCancellationScanner(),
    )(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.FAILED, "full_scan_failed")


def test_full_scan_does_not_reclassify_unrelated_cancel_after_shutdown_checkpoint():
    from music_app.jobs.worker import ExecutionContext
    from music_app.services.jobs.authorization import AuthorizationDecision
    from music_app.services.library_indexing import ScanCancelled

    context = ExecutionContext(
        _full_claim(),
        authorization_service=SimpleNamespace(
            authorize=lambda _claim, _now: AuthorizationDecision(True, "authorized")
        ),
        clock=lambda: NOW,
    )

    class UnexpectedCancellationScanner:
        @staticmethod
        def run(_intent, *, checkpoint, **_kwargs):
            context.request_shutdown()
            checkpoint(current=1, total=2)
            raise ScanCancelled("unrelated executor cancellation")

    outcome = _full_handler(
        _FullScanRepository(),
        UnexpectedCancellationScanner(),
    )(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.FAILED, "full_scan_failed")


@pytest.mark.parametrize("mutation", ("cancel", "lease", "authority"))
def test_full_scan_handler_treats_committed_publication_as_success(mutation):
    repository = _FullScanRepository()
    context = _FullContext()

    def mutate_after_publication():
        if mutation == "cancel":
            context.cancel_requested = True
        elif mutation == "lease":
            context.lease_active = False
        else:
            context.allowed = False

    outcome = _full_handler(
        repository,
        _FullScanner(after_publish=mutate_after_publication),
    )(_full_claim(), context)

    assert outcome == JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")


@pytest.mark.parametrize(
    ("scope", "reason"),
    (
        (SimpleNamespace(roots=(), scope_complete=False), "full_scan_root_invalid"),
        (
            SimpleNamespace(
                roots=(
                    {
                        "id": "root-a",
                        "path": Path("C:/Music/root-a"),
                        "library_id": 20,
                        "is_active": True,
                    },
                ),
                scope_complete=True,
            ),
            "full_scan_root_invalid",
        ),
    ),
)
def test_full_scan_handler_rejects_removed_or_cross_library_roots(scope, reason):
    repository = _FullScanRepository()
    repository.scope = scope
    scanner = _FullScanner()

    outcome = _full_handler(repository, scanner)(_full_claim(), _FullContext())

    assert outcome == JobTransitionResult(JobState.CANCELED, reason)
    assert scanner.calls == []


class _FullScanDatabaseFailure(RuntimeError):
    def __init__(
        self,
        *,
        sqlstate: str | None,
        primary: str = "private database failure",
        constraint_name: str | None = None,
        private_detail: str = (
            "C:/Users/private/Music/Artist/Album/01.flac token=secret"
        ),
    ) -> None:
        super().__init__(private_detail)
        self.sqlstate = sqlstate
        self.diag = SimpleNamespace(
            message_primary=primary,
            message_detail=private_detail,
            message_hint=private_detail,
            context=private_detail,
            constraint_name=constraint_name,
        )


@pytest.mark.parametrize(
    ("error", "reason_code", "expected_state"),
    (
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan publication input is invalid",
            ),
            "full_scan_publication_input_invalid",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan publication file scope is invalid",
            ),
            "full_scan_publication_file_scope_invalid",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan publication hierarchy invalid",
            ),
            "full_scan_publication_hierarchy_invalid",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan recovery cutoff is invalid",
            ),
            "full_scan_publication_recovery_cutoff_invalid",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan publication fence lost",
            ),
            "full_scan_revision_conflict",
            JobState.RETRY_WAIT,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="40001"),
            "full_scan_revision_conflict",
            JobState.RETRY_WAIT,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="23505",
                constraint_name="local_albums_semantic_identity_key",
            ),
            "full_scan_semantic_album_conflict",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(
                sqlstate="23505",
                constraint_name="private_unexpected_constraint",
            ),
            "full_scan_publication_integrity_failed",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="23502"),
            "full_scan_publication_integrity_failed",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="23503"),
            "full_scan_publication_integrity_failed",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="23514"),
            "full_scan_publication_integrity_failed",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="22023"),
            "full_scan_publication_integrity_failed",
            JobState.FAILED,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="08006"),
            "full_scan_storage_unavailable",
            JobState.RETRY_WAIT,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="53100"),
            "full_scan_storage_unavailable",
            JobState.RETRY_WAIT,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="57P01"),
            "full_scan_storage_unavailable",
            JobState.RETRY_WAIT,
        ),
        (
            _FullScanDatabaseFailure(sqlstate="40P01"),
            "full_scan_storage_unavailable",
            JobState.RETRY_WAIT,
        ),
        (
            OSError("C:/Users/private/Music/Artist/Album/01.flac token=secret"),
            "full_scan_failed",
            JobState.FAILED,
        ),
    ),
)
def test_full_scan_handler_classifies_failures_into_closed_safe_outcomes(
    error, reason_code, expected_state
):
    private_values = (
        "C:/Users/private/Music/Artist/Album/01.flac",
        "token=secret",
        "private_unexpected_constraint",
    )
    logged = []
    outcome = _full_handler(
        _FullScanRepository(),
        _FullScanner(error=error),
        logged=logged,
    )(
        replace(_full_claim(), attempt=1, max_attempts=2),
        _FullContext(),
    )

    assert outcome.next_state is expected_state
    assert outcome.reason_code == reason_code
    assert (outcome.scheduled_at == NOW + timedelta(seconds=5)) is (
        expected_state is JobState.RETRY_WAIT
    )
    assert logged == [f"Full scan execution failed ({reason_code})."]
    for private_value in private_values:
        assert private_value not in repr(outcome)
        assert private_value not in repr(logged)


def test_full_scan_handler_retries_unclassified_operational_error_for_watcher_repair():
    import psycopg

    repository = _FullScanRepository()
    repository.intent.watcher_repair_id = 613
    scanner = _FullScanner(error=psycopg.OperationalError("connection failed"))

    outcome = _full_handler(repository, scanner)(
        replace(_full_claim(), attempt=1, max_attempts=2),
        _FullContext(),
    )

    assert scanner.calls[0][0].watcher_repair_id == 613
    assert outcome == JobTransitionResult(
        JobState.RETRY_WAIT,
        "full_scan_storage_unavailable",
        scheduled_at=NOW + timedelta(seconds=5),
    )


@pytest.mark.parametrize(
    ("error", "reason_code"),
    (
        (
            _FullScanDatabaseFailure(
                sqlstate="P0001",
                primary="full scan publication fence lost",
            ),
            "full_scan_revision_conflict",
        ),
        (_FullScanDatabaseFailure(sqlstate="40001"), "full_scan_revision_conflict"),
        (_FullScanDatabaseFailure(sqlstate="08006"), "full_scan_storage_unavailable"),
        (_FullScanDatabaseFailure(sqlstate="53100"), "full_scan_storage_unavailable"),
        (_FullScanDatabaseFailure(sqlstate="57P01"), "full_scan_storage_unavailable"),
        (_FullScanDatabaseFailure(sqlstate="40P01"), "full_scan_storage_unavailable"),
    ),
)
def test_full_scan_handler_bounds_retryable_database_failures(error, reason_code):
    outcome = _full_handler(
        _FullScanRepository(),
        _FullScanner(error=error),
    )(
        replace(_full_claim(), attempt=2, max_attempts=2),
        _FullContext(),
    )

    assert outcome == JobTransitionResult(JobState.FAILED, reason_code)


def test_full_scan_checkpoint_rejection_fails_closed_as_lease_loss():
    repository = _FullScanRepository()
    repository.checkpoint_claimed_full_scan = lambda **_kwargs: False

    outcome = _full_handler(repository, _FullScanner())(_full_claim(), _FullContext())

    assert outcome == JobTransitionResult(JobState.CANCELED, "full_scan_lease_lost")


@pytest.mark.parametrize(
    ("attempt", "expected_state"),
    ((1, JobState.RETRY_WAIT), (2, JobState.FAILED)),
)
def test_full_scan_inventory_revision_conflict_retries_until_attempt_limit(
    attempt, expected_state
):
    repository = _FullScanRepository(revision=40)
    scanner = _FullScanner(error=RuntimeError("inventory revision conflict"))
    claim = replace(_full_claim(), attempt=attempt, max_attempts=2)

    outcome = _full_handler(repository, scanner)(claim, _FullContext())

    assert outcome.next_state is expected_state
    assert outcome.reason_code == "full_scan_revision_conflict"
    assert (outcome.scheduled_at == NOW + timedelta(seconds=5)) is (
        expected_state is JobState.RETRY_WAIT
    )


def test_full_scan_retry_reloads_roots_before_atomic_publication(monkeypatch):
    from music_app.jobs import full_scan_executor

    class Repository:
        def __init__(self):
            self.revision = 40
            self.root_ids = ("root-a",)
            self.enumerated_root_ids = []
            self.publications = []

        def load_claimed_full_scan(self, **_kwargs):
            return SimpleNamespace(
                intent_id=85,
                library_id=19,
                initiating_account_id=7,
                mode="manual_full_rescan",
                force=True,
                root_ids=self.root_ids,
                inventory_mutation_revision=self.revision,
                committed_inventory_revision=None,
                watcher_repair_id=613,
            )

        def load_claimed_full_scan_scope(self, **_kwargs):
            return SimpleNamespace(
                roots=tuple(
                    {
                        "id": root_id,
                        "path": Path(f"C:/Music/{root_id}"),
                        "library_id": 19,
                        "is_active": True,
                    }
                    for root_id in self.root_ids
                ),
                inventory_mutation_revision=self.revision,
                scope_complete=True,
                separate_release_keys=(),
                exception_overrides={},
            )

        def checkpoint_claimed_full_scan(self, **_kwargs):
            return True

        def publish_claimed_full_scan(self, **values):
            self.publications.append(values)
            if (
                values["expected_inventory_mutation_revision"] != self.revision
                or set(values["observed_root_ids"]) != set(self.root_ids)
            ):
                return {"publication_won": False}
            return {
                "publication_won": True,
                "inventory_mutation_revision": self.revision + 1,
            }

        def activate_second_root(self):
            self.root_ids = ("root-a", "root-b")
            self.revision = 41

    class Adapter:
        def __init__(self, _config):
            pass

        def prepare_full_scan_inventory(self, _cache, **_kwargs):
            return {"artists": [], "albums": [], "tracks": [], "track_files": []}

    class WatcherRecovery:
        def complete_repair(self, **_values):
            raise AssertionError(
                "publication must complete the watcher repair atomically"
            )

    repository = Repository()
    watcher_recovery = WatcherRecovery()

    def scan_music_incremental(**values):
        root_ids = tuple(str(root["id"]) for root in values["root_definitions"])
        repository.enumerated_root_ids.append(root_ids)
        values["publication_state"]["observed_library_root_ids"] = set(root_ids)
        if len(repository.enumerated_root_ids) == 1:
            repository.activate_second_root()
        return {}, 1.0

    monkeypatch.setattr(
        full_scan_executor.state_service,
        "scan_music_incremental",
        scan_music_incremental,
    )
    monkeypatch.setattr(full_scan_executor, "PostgresScanCacheAdapter", Adapter)
    executor = full_scan_executor.DurableFullScanExecutor(
        config={},
        scan_repository=repository,
        watcher_recovery=watcher_recovery,
    )
    handler = _full_handler(repository, executor)

    first = handler(
        replace(_full_claim(), attempt=1, max_attempts=2),
        _FullContext(),
    )
    second = handler(
        replace(_full_claim(), attempt=2, max_attempts=2),
        _FullContext(),
    )

    assert first == JobTransitionResult(
        JobState.RETRY_WAIT,
        "full_scan_revision_conflict",
        NOW + timedelta(seconds=5),
    )
    assert second == JobTransitionResult(JobState.SUCCEEDED, "full_scan_completed")
    assert repository.enumerated_root_ids == [
        ("root-a",),
        ("root-a", "root-b"),
    ]
    assert [
        publication["expected_inventory_mutation_revision"]
        for publication in repository.publications
    ] == [40, 41]


def test_full_scan_authority_revocation_before_start_never_invokes_scanner():
    repository = _FullScanRepository()
    scanner = _FullScanner()

    outcome = _full_handler(repository, scanner)(
        _full_claim(), _FullContext(allowed=False)
    )

    assert outcome == JobTransitionResult(
        JobState.CANCELED, "full_scan_authority_revoked"
    )
    assert scanner.calls == []


def test_full_scan_generic_identity_is_path_free_while_private_checkpoint_keeps_path():
    claim = _full_claim()
    repository = _FullScanRepository()
    _full_handler(repository, _FullScanner())(claim, _FullContext())

    private_path = repository.checkpoints[0]["current_path"]
    assert private_path
    assert private_path not in claim.subject_ref
    assert private_path not in repr(claim.parameters)
    assert private_path not in claim.idempotency_key


def test_targeted_handler_failure_marks_every_watcher_participant_dirty():
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    claimed_generation = SimpleNamespace(
        generation_id=501,
        intent_id=84,
        library_id=19,
        participants=(
            SimpleNamespace(logical_root_id="root-a"),
            SimpleNamespace(logical_root_id="root-b"),
        ),
        generation_kind="exact",
        barrier_ids=(701,),
    )

    class Recovery:
        def __init__(self):
            self.failures = []

        def claim_generation(self, **_kwargs):
            return claimed_generation

        def fail_generation(self, **kwargs):
            self.failures.append(kwargs)
            return True

    class FailingReconciler(_Reconciler):
        def reconcile(self, *_args, **_kwargs):
            raise OSError("C:/private/music/credential=secret")

    recovery = Recovery()
    repository = _ScanRepository()
    repository.intent.watcher_generation_kind = "exact"
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=FailingReconciler(),
        watcher_recovery=recovery,
        invalidate_projections=lambda _result: None,
        clock=lambda: NOW,
    )

    result = handler(_claim(), _Context())

    assert result == JobTransitionResult(
        JobState.FAILED,
        "targeted_reconciliation_failed",
    )
    assert recovery.failures == [
        {
            "claim": _claim(),
            "generation": claimed_generation,
            "reason_code": "reconciliation_failed",
            "now": NOW,
        }
    ]
    assert "private" not in result.reason_code
    assert "secret" not in result.reason_code


def test_root_catch_up_reconciles_every_available_participant_root(tmp_path):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    root_a = tmp_path / "root-a"
    root_b = tmp_path / "root-b"
    root_a.mkdir()
    root_b.mkdir()
    repository = _ScanRepository(
        healthy=False,
        roots=(
            {
                "id": "root-a",
                "path": root_a,
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
            {
                "id": "root-b",
                "path": root_b,
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
        )
    )
    repository.intent.watcher_generation_kind = "root_catch_up"
    repository.intent.request = TargetedReconciliationRequest(root_id="root-a")
    generation = SimpleNamespace(
        generation_id=84,
        intent_id=84,
        library_id=19,
        participants=(
            SimpleNamespace(logical_root_id="root-a"),
            SimpleNamespace(logical_root_id="root-b"),
        ),
        generation_kind="root_catch_up",
        barrier_ids=(),
    )
    recovery = SimpleNamespace(claim_generation=lambda **_kwargs: generation)
    reconciler = _Reconciler()
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=reconciler,
        watcher_recovery=recovery,
        clock=lambda: NOW,
    )

    assert handler(_claim(), _Context()).next_state is JobState.SUCCEEDED
    assert reconciler.requests[0][0].preserved_subtrees == frozenset(
        {root_a, root_b}
    )


def test_empty_root_catch_up_publishes_full_root_stale_scope(tmp_path):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler
    from music_app.services.scan_cache_persistence import (
        DurableTargetedReconciliationPreparationAdapter,
    )
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )

    root = tmp_path / "root-a"
    root.mkdir()

    class Repository(_ScanRepository):
        def __init__(self):
            super().__init__(
                healthy=False,
                roots=(
                    {
                        "id": "root-a",
                        "path": root,
                        "category": "main_library_roots",
                        "library_id": 19,
                        "is_active": True,
                    },
                ),
            )
            self.publications = []

        def publish_claimed_targeted_reconciliation(self, **kwargs):
            self.publications.append(kwargs)
            return {
                "publication_won": True,
                "inventory_mutation_revision": 31,
                "affected_album_keys": [],
            }

    repository = Repository()
    repository.intent.watcher_generation_kind = "root_catch_up"
    repository.intent.request = TargetedReconciliationRequest(root_id="root-a")
    generation = SimpleNamespace(
        generation_id=84,
        intent_id=84,
        library_id=19,
        participants=(SimpleNamespace(logical_root_id="root-a"),),
        generation_kind="root_catch_up",
        barrier_ids=(),
    )
    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}, "IMAGE_EXTENSIONS": set()},
        repository=DurableTargetedReconciliationPreparationAdapter(
            build_albums=lambda _cache, _separate_release_keys: [],
        ),
        root_definitions=repository.roots,
    )
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=reconciler,
        watcher_recovery=SimpleNamespace(
            claim_generation=lambda **_kwargs: generation,
        ),
        clock=lambda: NOW,
    )

    assert handler(_claim(), _Context()) == JobTransitionResult(
        JobState.SUCCEEDED,
        "targeted_reconciliation_completed",
    )
    assert len(repository.publications) == 1
    assert all(not rows for rows in repository.publications[0]["inventory"].values())
    assert repository.publications[0]["stale_scopes"] == [
        {"root_id": "root-a", "paths": [], "subtrees": [str(root)]},
    ]


def test_root_catch_up_fails_generation_when_a_participant_root_is_unavailable(
    tmp_path,
):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    root_a = tmp_path / "root-a"
    root_a.mkdir()
    repository = _ScanRepository(
        healthy=False,
        roots=(
            {
                "id": "root-a",
                "path": root_a,
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
            {
                "id": "root-b",
                "path": tmp_path / "missing-root-b",
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
        ),
    )
    repository.intent.watcher_generation_kind = "root_catch_up"
    repository.intent.request = TargetedReconciliationRequest(root_id="root-a")
    generation = SimpleNamespace(
        generation_id=84,
        intent_id=84,
        library_id=19,
        participants=(
            SimpleNamespace(logical_root_id="root-a"),
            SimpleNamespace(logical_root_id="root-b"),
        ),
        generation_kind="root_catch_up",
        barrier_ids=(),
    )

    class Recovery:
        def __init__(self):
            self.failures = []

        def claim_generation(self, **_kwargs):
            return generation

        def fail_generation(self, **kwargs):
            self.failures.append(kwargs)
            return True

    recovery = Recovery()
    reconciler = _Reconciler()
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=reconciler,
        watcher_recovery=recovery,
        clock=lambda: NOW,
    )

    result = handler(_claim(), _Context())

    assert result.next_state is JobState.FAILED
    assert recovery.failures == [
        {
            "claim": _claim(),
            "generation": generation,
            "reason_code": "root_unavailable",
            "now": NOW,
        }
    ]
    assert reconciler.requests == []


def test_exact_watcher_generation_remains_canceled_when_scope_is_unhealthy(
    tmp_path,
):
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    root_a = tmp_path / "root-a"
    root_a.mkdir()
    repository = _ScanRepository(
        healthy=False,
        roots=(
            {
                "id": "root-a",
                "path": root_a,
                "category": "main_library_roots",
                "library_id": 19,
                "is_active": True,
            },
        ),
    )
    repository.intent.watcher_generation_kind = "exact"
    generation = SimpleNamespace(
        generation_id=84,
        intent_id=84,
        library_id=19,
        participants=(SimpleNamespace(logical_root_id="root-a"),),
        generation_kind="exact",
        barrier_ids=(),
    )
    reconciler = _Reconciler()
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=reconciler,
        watcher_recovery=SimpleNamespace(
            claim_generation=lambda **_kwargs: generation
        ),
        clock=lambda: NOW,
    )

    result = handler(_claim(), _Context())

    assert result == JobTransitionResult(
        JobState.CANCELED,
        "targeted_root_unhealthy",
    )
    assert reconciler.requests == []


def test_stale_watcher_generation_cancels_before_private_scope_load():
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    repository = _ScanRepository()
    repository.intent.watcher_generation_kind = "exact"
    recovery = SimpleNamespace(claim_generation=lambda **_kwargs: None)
    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=_Reconciler(),
        watcher_recovery=recovery,
        invalidate_projections=lambda _result: None,
        clock=lambda: NOW,
    )

    assert handler(_claim(), _Context()) == JobTransitionResult(
        JobState.CANCELED,
        "watcher_generation_stale",
    )
    assert len(repository.loads) == 1
    assert repository.scope_loads == []


def test_legacy_library_watcher_job_skips_generation_claim():
    from music_app.jobs.scan_handlers import build_targeted_reconciliation_handler

    repository = _ScanRepository()

    def reject_generation_claim(**_kwargs):
        raise AssertionError("legacy watcher job must not use durable generation claim")

    handler = build_targeted_reconciliation_handler(
        scan_repository=repository,
        reconciler=_Reconciler(),
        watcher_recovery=SimpleNamespace(claim_generation=reject_generation_claim),
        invalidate_projections=lambda _result: None,
        clock=lambda: NOW,
    )

    assert handler(_claim(), _Context()) == JobTransitionResult(
        JobState.SUCCEEDED,
        "targeted_reconciliation_completed",
    )
    assert len(repository.loads) == 1
    assert len(repository.scope_loads) == 1
