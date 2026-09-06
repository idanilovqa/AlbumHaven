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
    ):
        self.replace_roots(root_definitions)
        self.replace_exception_overrides(exception_overrides)
        self.requests.append((request, root_healthy))
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
    assert reconciler.roots == [repository.roots]
    assert reconciler.exception_overrides == [repository.intent.exception_overrides]
    assert reconciler.requests == [(repository.request, True)]
    assert context.reauthorizations == 1
    assert reconciler.mutations == [repository.request]
    assert repository.fences[0]["connection"] == "inventory-connection"
    assert invalidated == [TargetedReconciliationResult(31, ("artist::album",))]
    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "targeted_reconciliation_completed"


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


def _full_handler(repository, scanner, *, logged=None, watcher=None):
    from music_app.jobs.scan_handlers import build_full_scan_handler

    return build_full_scan_handler(
        scan_repository=repository,
        scan_executor=scanner,
        watcher_coordinator=watcher,
        clock=lambda: NOW,
        log_event=(lambda message: logged.append(message)) if logged is not None else None,
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


def test_full_scan_handler_maps_scanner_failure_to_bounded_generic_outcome():
    secret_path = "C:/Users/private/Music/Artist/Album/01.flac"
    repository = _FullScanRepository()
    scanner = _FullScanner(error=OSError(secret_path))
    logged = []

    outcome = _full_handler(repository, scanner, logged=logged)(
        _full_claim(), _FullContext()
    )

    assert outcome == JobTransitionResult(JobState.FAILED, "full_scan_failed")
    assert secret_path not in repr(outcome)
    assert secret_path not in repr(logged)


def test_full_scan_checkpoint_rejection_fails_closed_as_lease_loss():
    repository = _FullScanRepository()
    repository.checkpoint_claimed_full_scan = lambda **_kwargs: False

    outcome = _full_handler(repository, _FullScanner())(_full_claim(), _FullContext())

    assert outcome == JobTransitionResult(JobState.CANCELED, "full_scan_lease_lost")


def test_full_scan_inventory_revision_conflict_never_reports_success():
    repository = _FullScanRepository(revision=40)
    scanner = _FullScanner(error=RuntimeError("inventory revision conflict"))

    outcome = _full_handler(repository, scanner)(_full_claim(), _FullContext())

    assert outcome == JobTransitionResult(JobState.FAILED, "full_scan_revision_conflict")


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


def test_retried_full_scan_suspends_watcher_overlap_and_resumes_after_completion():
    class Watcher:
        def __init__(self):
            self.events = []

        def suspend_targeted_reconciliation(self):
            self.events.append("suspend")

        def resume_targeted_reconciliation(self):
            self.events.append("resume")

    watcher = Watcher()
    repository = _FullScanRepository()

    outcome = _full_handler(
        repository,
        _FullScanner(),
        watcher=watcher,
    )(_full_claim(), _FullContext())

    assert _full_claim().attempt == 3
    assert watcher.events == ["suspend", "resume"]
    assert outcome.next_state is JobState.SUCCEEDED
