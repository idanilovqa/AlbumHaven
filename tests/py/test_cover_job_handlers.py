from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from music_app.services.jobs.models import ClaimedJob, JobState


NOW = datetime(2026, 9, 6, 22, 0, tzinfo=timezone.utc)


def _claim(**overrides) -> ClaimedJob:
    values = {
        "job_id": 71,
        "kind": "cover_lookup",
        "subject_kind": "cover_lookup_task",
        "subject_ref": "lookup-abc",
        "parameters": {"task_id": 31},
        "account_id": 7,
        "library_id": 9,
        "capability_key": "library.covers.lookup",
        "request_origin_id": 23,
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "private_web",
        "idempotency_key": "cover-lookup:9:lookup-abc",
        "attempt": 1,
        "max_attempts": 2,
        "worker_id": "worker-cover-a",
        "lease_token": "cover-lease-a",
        "lease_expires_at": NOW + timedelta(minutes=5),
        "scheduled_at": NOW - timedelta(minutes=2),
        "resource_revision": 12,
    }
    values.update(overrides)
    return ClaimedJob(**values)


class _Context:
    def __init__(self):
        self.cancel_requested = False
        self.lease_active = True
        self.allowed = True

    def reauthorize(self):
        return SimpleNamespace(allowed=self.allowed)


class _Repository:
    def __init__(self):
        self.scope = SimpleNamespace(
            task_key="lookup-abc",
            task_id=31,
            row_revision=3,
            status="pending",
            cancel_requested=False,
            album={"id": 101, "album_artist": "Artist", "name": "Album", "year": 2020},
            track_paths=("C:/Music/Artist/Album/01.flac",),
            manual_urls=("https://covers.example/manual.jpg",),
            task_payload={"id": "lookup-abc", "status": "pending", "progress": 0},
        )
        self.validate_result = True
        self.loads = []
        self.updates = []
        self.cancel_requested = False

    def validate_claimed_candidate_lookup(self, **kwargs):
        self.loads.append(("validate", kwargs))
        return self.validate_result

    def load_claimed_candidate_lookup(self, **kwargs):
        self.loads.append(("load", kwargs))
        return self.scope

    def candidate_lookup_cancel_requested(self, **kwargs):
        self.loads.append(("cancel", kwargs))
        return self.cancel_requested

    def candidate_lookup_cancellation_state(self, **kwargs):
        self.loads.append(("cancel-state", kwargs))
        return self.cancel_requested, self.scope.row_revision

    def finalize_claimed_candidate_lookup_canceled(self, **kwargs):
        self.updates.append(kwargs)
        self.scope = SimpleNamespace(
            **{
                **vars(self.scope),
                "row_revision": self.scope.row_revision + 1,
                "status": "canceled",
                "task_payload": {
                    **self.scope.task_payload,
                    "status": "canceled",
                    "cancel_requested": True,
                },
            }
        )
        return self.scope

    def publish_claimed_candidate_lookup(self, **kwargs):
        self.updates.append(kwargs)
        self.scope = SimpleNamespace(
            **{
                **vars(self.scope),
                "row_revision": self.scope.row_revision + 1,
                "status": kwargs["task_payload"].get("status", self.scope.status),
                "task_payload": dict(kwargs["task_payload"]),
            }
        )
        return self.scope


def test_cover_lookup_validator_rejects_malformed_or_stale_scope():
    from music_app.jobs.cover_handlers import build_cover_lookup_resource_validator

    repository = _Repository()
    validator = build_cover_lookup_resource_validator(cover_repository=repository)

    assert validator(_claim(subject_ref="31"), None, NOW).allowed is False
    repository.validate_result = False
    decision = validator(_claim(), None, NOW)
    assert decision.allowed is False
    assert decision.reason_code == "cover_lookup_scope_stale"


def test_cover_lookup_handler_starts_deadline_at_claim_and_fences_updates():
    from music_app.jobs.cover_handlers import build_cover_lookup_handler

    repository = _Repository()
    context = _Context()
    deadlines = []
    runtime_calls = []

    def run_lookup(**kwargs):
        runtime_calls.append(kwargs)
        kwargs["publish"](status="running", progress=12, progress_label="Searching music services...")
        kwargs["publish"](
            status="completed",
            progress=100,
            progress_label="Completed",
            result_kind="no-results",
        )

    handler = build_cover_lookup_handler(
        cover_repository=repository,
        config={"MUSICBRAINZ_USER_AGENT": "Album Haven tests"},
        logger=SimpleNamespace(),
        run_lookup=run_lookup,
        build_deadline=lambda _config: deadlines.append("built") or 123.5,
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), context)

    assert outcome.next_state == JobState.SUCCEEDED
    assert outcome.reason_code == "cover_lookup_completed"
    assert deadlines == ["built"]
    assert runtime_calls[0]["provider_deadline_at"] == 123.5
    assert runtime_calls[0]["track_paths"] == {"C:/Music/Artist/Album/01.flac"}
    assert [update["expected_row_revision"] for update in repository.updates] == [3, 4]
    assert all(update["job_id"] == 71 for update in repository.updates)
    assert all(update["lease_token"] == "cover-lease-a" for update in repository.updates)


def test_cover_lookup_handler_observes_durable_cancel_before_provider_work():
    from music_app.jobs.cover_handlers import build_cover_lookup_handler

    repository = _Repository()
    repository.cancel_requested = True
    calls = []
    handler = build_cover_lookup_handler(
        cover_repository=repository,
        config={"MUSICBRAINZ_USER_AGENT": "Album Haven tests"},
        logger=SimpleNamespace(),
        run_lookup=lambda **kwargs: calls.append(kwargs),
        build_deadline=lambda _config: 1.0,
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), _Context())

    assert outcome.next_state == JobState.CANCELED
    assert outcome.reason_code == "cover_lookup_canceled"
    assert calls == []


def test_cover_lookup_handler_stops_after_lost_publication_fence():
    from music_app.jobs.cover_handlers import build_cover_lookup_handler

    repository = _Repository()
    repository.publish_claimed_candidate_lookup = lambda **_kwargs: None
    observed = []

    def run_lookup(**kwargs):
        observed.append(kwargs["publish"](status="running", progress=12))
        assert kwargs["should_cancel"]() is True

    handler = build_cover_lookup_handler(
        cover_repository=repository,
        config={"MUSICBRAINZ_USER_AGENT": "Album Haven tests"},
        logger=SimpleNamespace(),
        run_lookup=run_lookup,
        build_deadline=lambda _config: 1.0,
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), _Context())

    assert observed == [False]
    assert outcome.next_state == JobState.CANCELED
    assert outcome.reason_code == "cover_lookup_lease_lost"
