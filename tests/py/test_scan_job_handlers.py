from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.jobs.models import ClaimedJob, JobState
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
