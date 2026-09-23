from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
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


def test_cover_lookup_handler_injects_lease_fenced_candidate_snapshot_repository():
    from music_app.jobs.cover_handlers import build_cover_lookup_handler

    repository = _Repository()
    generation = "7fd1c5cc-6e48-41a1-8174-65bcb75d094e"
    repository.scope = SimpleNamespace(**{**vars(repository.scope), "task_key": generation})
    snapshot_mutations = []

    def mutate_claimed_lookup_candidate_snapshot(**kwargs):
        snapshot_mutations.append(kwargs)
        return True

    repository.mutate_claimed_lookup_candidate_snapshot = (
        mutate_claimed_lookup_candidate_snapshot
    )

    def run_lookup(**kwargs):
        factory = kwargs["config"]["COVER_CANDIDATE_SNAPSHOT_REPOSITORY_FACTORY"]
        snapshot_repository = factory(
            album_id=101,
            search_generation=generation,
            search_kind="manual",
        )
        assert snapshot_repository.publish_generation(
            album_id=101,
            search_generation=generation,
            search_kind="manual",
            search_started_at=NOW.isoformat(),
            candidates=[
                {
                    "id": "candidate-1",
                    "url": "https://images.example/cover.jpg",
                    "art_kind": "cover",
                }
            ],
            best_candidate_id="candidate-1",
            automatic_improvement=False,
        )
        kwargs["publish"](status="completed", progress=100)

    outcome = build_cover_lookup_handler(
        cover_repository=repository,
        config={"MUSICBRAINZ_USER_AGENT": "Album Haven tests"},
        logger=SimpleNamespace(),
        run_lookup=run_lookup,
        build_deadline=lambda _config: 1.0,
        clock=lambda: NOW,
    )(
        _claim(
            subject_ref=generation,
            idempotency_key=f"cover-lookup:9:{generation}",
        ),
        _Context(),
    )

    assert outcome.next_state == JobState.SUCCEEDED
    assert snapshot_mutations[0]["album_id"] == 101
    assert snapshot_mutations[0]["job_id"] == 71
    assert snapshot_mutations[0]["lease_token"] == "cover-lease-a"


def test_cover_lookup_handler_fails_when_candidate_snapshot_publication_fails():
    from music_app.jobs.cover_handlers import build_cover_lookup_handler

    repository = _Repository()
    generation = "7fd1c5cc-6e48-41a1-8174-65bcb75d094e"
    repository.scope = SimpleNamespace(**{**vars(repository.scope), "task_key": generation})
    repository.mutate_claimed_lookup_candidate_snapshot = lambda **_kwargs: False

    def run_lookup(**kwargs):
        factory = kwargs["config"]["COVER_CANDIDATE_SNAPSHOT_REPOSITORY_FACTORY"]
        snapshot_repository = factory(
            album_id=101,
            search_generation=generation,
            search_kind="manual",
        )
        if not snapshot_repository.publish_generation(
            album_id=101,
            search_generation=generation,
            search_kind="manual",
            search_started_at=NOW.isoformat(),
            candidates=[
                {
                    "id": "candidate-1",
                    "url": "https://images.example/cover.jpg",
                    "art_kind": "cover",
                }
            ],
            best_candidate_id="candidate-1",
            automatic_improvement=False,
        ):
            raise RuntimeError("candidate snapshot publication lost its claim")

    outcome = build_cover_lookup_handler(
        cover_repository=repository,
        config={"MUSICBRAINZ_USER_AGENT": "Album Haven tests"},
        logger=SimpleNamespace(),
        run_lookup=run_lookup,
        build_deadline=lambda _config: 1.0,
        clock=lambda: NOW,
    )(
        _claim(
            subject_ref=generation,
            idempotency_key=f"cover-lookup:9:{generation}",
        ),
        _Context(),
    )

    assert outcome.next_state == JobState.FAILED
    assert outcome.reason_code == "cover_lookup_failed"


def test_post_scan_cover_refresh_uses_shared_claimed_core_and_publishes_progress():
    from music_app.jobs.cover_handlers import build_cover_refresh_handler

    claim = _claim(
        job_id=88,
        kind="post_scan_cover_refresh",
        subject_kind="inventory_revision",
        subject_ref="revision-12",
        parameters={"inventory_revision": 12},
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        idempotency_key="post-scan-cover-refresh:9:12",
    )
    scope = SimpleNamespace(
        task_id=51,
        task_key="post-scan-12",
        row_revision=1,
        file_cache={"C:/Music/Artist/Album/01.flac": {"path": "C:/Music/Artist/Album/01.flac"}},
        progress_total=1,
        mode="post_scan",
        force_search=False,
    )

    class Repository:
        def __init__(self):
            self.checkpoints = []
            self.finished = []
            self.selections = []

        def begin_claimed_cover_refresh(self, **_kwargs):
            return scope

        def cover_refresh_cancel_requested(self, **_kwargs):
            return False

        def checkpoint_claimed_cover_refresh(self, **kwargs):
            self.checkpoints.append(kwargs)
            return kwargs["expected_row_revision"] + 1

        def finish_claimed_cover_refresh(self, **kwargs):
            self.finished.append(kwargs)
            return True

        def persist_claimed_automatic_cover_selection(self, **kwargs):
            self.selections.append(kwargs)
            return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    repository = Repository()
    runs = []

    def run_refresh(**kwargs):
        runs.append(kwargs)
        kwargs["config"]["CLAIMED_COVER_SELECTION_PERSISTER"](
            {"C:/Music/Artist/Album/01.flac"},
            Path("C:/Music/Artist/Album/cover.jpg"),
            cover_revision="revision-1",
            cover_selection_origin="automatic",
            reject_if_user_controlled=True,
        )
        kwargs["progress"](current=1, total=1, downloaded=0, safe_label="Album")
        return {"processed": 1, "downloaded": 0, "failed": 0}

    outcome = build_cover_refresh_handler(
        cover_repository=repository,
        config={},
        logger=SimpleNamespace(),
        run_refresh=run_refresh,
        clock=lambda: NOW,
    )(claim, _Context())

    assert outcome.next_state == JobState.SUCCEEDED
    assert outcome.reason_code == "cover_refresh_completed"
    assert runs[0]["scope"] is scope
    assert repository.checkpoints[0]["safe_display_label"] == "Album"
    assert repository.selections[0]["job_id"] == claim.job_id
    assert repository.selections[0]["task_id"] == scope.task_id
    assert repository.finished[0]["next_status"] == "completed"


def test_cover_refresh_handler_injects_lease_fenced_candidate_snapshot_repository():
    from music_app.jobs.cover_handlers import build_cover_refresh_handler

    claim = _claim(
        job_id=88,
        kind="post_scan_cover_refresh",
        subject_kind="inventory_revision",
        subject_ref="revision-12",
        parameters={"inventory_revision": 12},
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        idempotency_key="post-scan-cover-refresh:9:12",
    )
    scope = SimpleNamespace(
        task_id=51,
        task_key="post-scan-12",
        row_revision=1,
        file_cache={},
        progress_total=0,
        mode="post_scan",
        force_search=False,
    )

    class Repository:
        def __init__(self):
            self.snapshot_mutations = []

        def begin_claimed_cover_refresh(self, **_kwargs):
            return scope

        def cover_refresh_cancel_requested(self, **_kwargs):
            return False

        def finish_claimed_cover_refresh(self, **_kwargs):
            return True

        def mutate_claimed_refresh_candidate_snapshot(self, **kwargs):
            self.snapshot_mutations.append(kwargs)
            return True

    repository = Repository()

    def run_refresh(**kwargs):
        factory = kwargs["config"]["COVER_CANDIDATE_SNAPSHOT_REPOSITORY_FACTORY"]
        snapshot_repository = factory(
            album_id=101,
            search_generation="7fd1c5cc-6e48-41a1-8174-65bcb75d094e",
            search_kind="automatic",
        )
        assert snapshot_repository.finish_generation(
            album_id=101,
            search_generation="7fd1c5cc-6e48-41a1-8174-65bcb75d094e",
            status="completed",
        )
        return {"processed": 0, "downloaded": 0, "failed": 0}

    outcome = build_cover_refresh_handler(
        cover_repository=repository,
        config={},
        logger=SimpleNamespace(),
        run_refresh=run_refresh,
        clock=lambda: NOW,
    )(claim, _Context())

    assert outcome.next_state == JobState.SUCCEEDED
    assert repository.snapshot_mutations[0]["task_id"] == 51
    assert repository.snapshot_mutations[0]["job_id"] == 88
    assert repository.snapshot_mutations[0]["operation"] == "finish_completed"


def test_post_scan_cover_refresh_real_runtime_finishes_no_jobs_once(tmp_path, monkeypatch):
    from music_app.jobs.cover_handlers import build_cover_refresh_handler
    from music_app.services import state as state_service
    from music_app.services.cover_refresh_runtime import run_claimed_cover_refresh

    claim = _claim(
        job_id=88,
        kind="post_scan_cover_refresh",
        subject_kind="inventory_revision",
        subject_ref="revision-12",
        parameters={"inventory_revision": 12},
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        idempotency_key="post-scan-cover-refresh:9:12",
    )
    scope = SimpleNamespace(
        task_id=51,
        task_key="post-scan-12",
        row_revision=1,
        file_cache={},
        progress_total=0,
        mode="post_scan",
        force_search=False,
    )

    class Repository:
        def __init__(self):
            self.finished = []
            self.checkpoints = []

        def begin_claimed_cover_refresh(self, **_kwargs):
            return scope

        def cover_refresh_cancel_requested(self, **_kwargs):
            return False

        def checkpoint_claimed_cover_refresh(self, **kwargs):
            self.checkpoints.append(kwargs)
            return kwargs["expected_row_revision"] + 1

        def finish_claimed_cover_refresh(self, **kwargs):
            self.finished.append(kwargs)
            return True

    logged = []
    monkeypatch.setattr(
        state_service,
        "select_background_cover_refresh_jobs",
        lambda **_kwargs: [],
    )
    monkeypatch.setattr(
        state_service,
        "log_cover_refresh_completion",
        lambda **kwargs: logged.append(kwargs),
    )
    repository = Repository()
    outcome = build_cover_refresh_handler(
        cover_repository=repository,
        config={
            "COVER_CACHE_PATH": str(tmp_path / "covers.json"),
            "IMAGE_EXTENSIONS": {".jpg"},
            "MUSICBRAINZ_USER_AGENT": "album-haven-tests",
            "BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS": 60,
            "BULK_COVER_JOB_WORKERS": 1,
        },
        logger=logging.getLogger("test.cover.post_scan"),
        run_refresh=run_claimed_cover_refresh,
        clock=lambda: NOW,
    )(claim, _Context())

    assert outcome.next_state == JobState.SUCCEEDED
    assert outcome.reason_code == "cover_refresh_completed"
    assert len(logged) == 1
    assert repository.checkpoints
    assert len(repository.finished) == 1
    assert repository.finished[0]["next_status"] == "completed"
    assert repository.finished[0]["processed_count"] == 0


def test_claimed_cover_refresh_preserves_split_same_identity_releases(monkeypatch):
    from music_app.services import state as state_service
    from music_app.services.cover_refresh_runtime import run_claimed_cover_refresh

    def entry(path: str, year: int) -> dict[str, object]:
        return {
            "path": path,
            "title": f"Track {year}",
            "artist": "Artist",
            "album_artist": "Artist",
            "album": "Same Title",
            "year": year,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "edition": "",
            "album_rating": 0,
            "duration_seconds": 180,
            "cover_path": None,
        }

    observed = {}

    def refresh(library_state, *_args, **_kwargs):
        observed.update(library_state)
        return {"processed": 0, "downloaded": 0, "failed": 0}

    monkeypatch.setattr(
        state_service, "refresh_unsuccessful_cover_artwork_for_state", refresh
    )
    scope = SimpleNamespace(
        file_cache={
            "C:/Music/Artist/Same Title/2001/01.flac": entry(
                "C:/Music/Artist/Same Title/2001/01.flac", 2001
            ),
            "C:/Music/Artist/Same Title/2011/01.flac": entry(
                "C:/Music/Artist/Same Title/2011/01.flac", 2011
            ),
        },
        separate_release_keys=("artist::same title",),
        progress_total=2,
        mode="manual",
        force_search=False,
    )

    run_claimed_cover_refresh(
        scope=scope,
        config={},
        logger=SimpleNamespace(),
        should_cancel=lambda: False,
        progress=lambda **_kwargs: True,
    )

    assert observed["separate_release_keys"] == {"artist::same title"}
    assert sorted(album.year for album in observed["albums"]) == [2001, 2011]


def test_shared_cover_refresh_core_cancels_when_projection_fence_is_lost():
    from music_app.jobs.cover_handlers import build_cover_refresh_handler

    claim = _claim(
        job_id=88,
        kind="post_scan_cover_refresh",
        subject_kind="inventory_revision",
        subject_ref="revision-12",
        parameters={"inventory_revision": 12},
        account_id=None,
        capability_key=None,
        request_origin_id=None,
        idempotency_key="post-scan-cover-refresh:9:12",
    )

    class Repository:
        def begin_claimed_cover_refresh(self, **_kwargs):
            return SimpleNamespace(
                task_id=51,
                task_key="post-scan-12",
                row_revision=1,
                file_cache={},
                progress_total=0,
                mode="post_scan",
                force_search=False,
            )

        def cover_refresh_cancel_requested(self, **_kwargs):
            return False

        def checkpoint_claimed_cover_refresh(self, **_kwargs):
            return None

        def finish_claimed_cover_refresh(self, **_kwargs):
            return False

    def run_refresh(**kwargs):
        assert kwargs["progress"](current=0, total=0, downloaded=0, safe_label="") is False
        assert kwargs["should_cancel"]() is True
        return {"processed": 0, "downloaded": 0, "failed": 0}

    outcome = build_cover_refresh_handler(
        cover_repository=Repository(),
        config={},
        logger=SimpleNamespace(),
        run_refresh=run_refresh,
        clock=lambda: NOW,
    )(claim, _Context())

    assert outcome.next_state == JobState.CANCELED
    assert outcome.reason_code == "cover_refresh_lease_lost"


def test_remote_cover_save_handler_uses_claimed_scope_and_checkpoint_callbacks():
    from music_app.jobs.cover_handlers import build_cover_remote_save_handler

    claim = _claim(
        job_id=99,
        kind="cover_remote_save",
        parameters={
            "task_id": 31,
            "candidate_generation": "11111111-1111-4111-8111-111111111111",
            "candidate_id": "candidate-1",
        },
        capability_key="library.covers.write",
        idempotency_key=(
            "cover-remote-save:9:lookup-abc:"
            "11111111-1111-4111-8111-111111111111:candidate-1"
        ),
        max_attempts=1,
    )
    scope = SimpleNamespace(
        checkpoint_id=61,
        checkpoint="accepted",
        checkpoint_revision=0,
        task_revision=4,
        candidate_generation="11111111-1111-4111-8111-111111111111",
        candidate_id="candidate-1",
        selected_candidate={"id": "candidate-1", "url": "https://covers.invalid/a.jpg"},
        library_root_path="C:/Music/Artist/Album",
        track_paths=("C:/Music/Artist/Album/01.flac",),
    )

    class Repository:
        def __init__(self):
            self.checkpoints = []
            self.persisted = []
            self.published = []

        def load_claimed_remote_save(self, **_kwargs):
            return scope

        def checkpoint_claimed_remote_save(self, **kwargs):
            self.checkpoints.append(kwargs)
            return kwargs["expected_row_revision"] + 1

        def persist_claimed_remote_cover_selection(self, **kwargs):
            self.persisted.append(kwargs)
            return kwargs["expected_checkpoint_revision"] + 1

        def publish_claimed_remote_save(self, **kwargs):
            self.published.append(kwargs)
            return kwargs["expected_checkpoint_revision"] + 1, 5

    repository = Repository()

    def run_save(**kwargs):
        assert kwargs["scope"] is scope
        revision = kwargs["checkpoint"]("download_started")
        revision = kwargs["persist_selection"](
            expected_checkpoint_revision=revision,
            selected_cover_path="C:/Music/Artist/Album/cover.jpg",
            selected_cover_revision="revision-1",
            linked_remote=False,
        )
        assert kwargs["publish"](
            expected_checkpoint_revision=revision,
            selected_cover_path="C:/Music/Artist/Album/cover.jpg",
            linked_remote=False,
        )
        return {"status": "succeeded"}

    outcome = build_cover_remote_save_handler(
        cover_repository=repository,
        config={},
        logger=SimpleNamespace(),
        run_save=run_save,
        clock=lambda: NOW,
    )(claim, _Context())

    assert outcome.next_state == JobState.SUCCEEDED
    assert repository.checkpoints[0]["next_checkpoint"] == "download_started"
    assert repository.persisted[0]["checkpoint_id"] == scope.checkpoint_id
    assert repository.published[0]["expected_task_revision"] == scope.task_revision
