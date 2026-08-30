from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import inspect
import io
import os
from pathlib import Path
import sys
from threading import Event, Thread
import time
from types import SimpleNamespace

import pytest

from music_app.services import cover_lookup_runtime, cover_workflow
from music_app.services import cover_lookup_tasks
from music_app.services.cover_provider_candidates import SelectedRemoteImage
from music_app.services.library_roots import save_library_root_settings
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    paths["data_dir"].mkdir(parents=True, exist_ok=True)
    paths["music_dir"].mkdir(parents=True, exist_ok=True)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
        "MUSICBRAINZ_USER_AGENT": "AlbumHavenTests/1.0",
        "PERSISTENCE_BACKENDS": {
            "cover_lookup_tasks": "postgres",
            "library_roots": "postgres",
        },
    }


@pytest.fixture
def logger():
    return SimpleNamespace(
        name="cover-lookup-runtime-test-logger",
        debug=lambda *args, **kwargs: None,
        info=lambda *args, **kwargs: None,
        warning=lambda *args, **kwargs: None,
        error=lambda *args, **kwargs: None,
        log=lambda *args, **kwargs: None,
    )


@pytest.fixture
def library_state():
    return {}


@pytest.fixture(autouse=True)
def postgres_runtime_fakes(config, monkeypatch):
    from music_app.services.library_roots import normalize_library_root_settings

    config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"

    def reject_unisolated_candidate_snapshot_connection(_database_url):
        pytest.fail(
            "cover lookup runtime unit tests must inject the candidate snapshot "
            "repository instead of connecting to Postgres"
        )

    monkeypatch.setattr(
        "music_app.services.album_cover_candidate_snapshots_postgres._connect",
        reject_unisolated_candidate_snapshot_connection,
    )
    candidate_snapshot_resolve_calls: list[set[str]] = []

    class FakeAlbumCoverCandidateSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            candidate_snapshot_resolve_calls.append(set(track_paths))
            return None

    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        FakeAlbumCoverCandidateSnapshotRepository,
    )
    persisted_notifications: list[dict[str, object]] = []
    persisted_root_settings = normalize_library_root_settings(
        {},
        fallback_main_root=Path(config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )

    class FakeCoverLookupTasksPostgresAdapter:
        def __init__(self, _config):
            pass

        def load_notifications(self):
            return list(persisted_notifications)

        def save_notifications(self, tasks):
            persisted_notifications[:] = list(tasks)

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            return dict(persisted_root_settings)

        def save_settings(self, raw_payload):
            persisted_root_settings.clear()
            persisted_root_settings.update(
                normalize_library_root_settings(
                    raw_payload,
                    fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
                )
            )
            return dict(persisted_root_settings)

    def fake_select_runtime_persistence_adapter(_seam_id, _config):
        return SimpleNamespace(effective_backend="postgres")

    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.CoverLookupTasksPostgresAdapter",
        FakeCoverLookupTasksPostgresAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.cover_lookup_notifications.select_runtime_persistence_adapter",
        fake_select_runtime_persistence_adapter,
    )
    monkeypatch.setattr(
        "music_app.services.persistence_selection.select_runtime_persistence_adapter",
        fake_select_runtime_persistence_adapter,
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )
    config["PERSISTENCE_BACKENDS"] = {
        **dict(config.get("PERSISTENCE_BACKENDS") or {}),
        "cover_lookup_tasks": "postgres",
        "library_roots": "postgres",
    }
    config["_TEST_COVER_LOOKUP_NOTIFICATIONS"] = persisted_notifications
    config["_TEST_CANDIDATE_SNAPSHOT_RESOLVE_CALLS"] = candidate_snapshot_resolve_calls


def test_cover_lookup_runtime_tests_do_not_depend_on_flask_runtime_helpers():
    source = Path(__file__).read_text(encoding="utf-8")
    forbidden_terms = [
        "tests.py." "flask_fixtures",
        "from " "flask",
        "has_" "app_context",
        "app." "app_context(",
        "app." "config",
        "app." "logger",
        "app." "library_state",
    ]

    assert not [term for term in forbidden_terms if term in source]


def _album_payload(track_path: Path) -> dict[str, object]:
    return {
        "name": "Test Album",
        "album_artist": "Test Artist",
        "year": 2001,
        "edition": "",
        "tracks": [{"path": str(track_path)}],
    }


def _jpeg_bytes(color: tuple[int, int, int] = (40, 120, 220)) -> bytes:
    from music_app.services.covers import Image

    assert Image is not None
    buffer = io.BytesIO()
    Image.new("RGB", (12, 12), color).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def _capture_task_update(
    updates: list[dict[str, object]],
    task_id: str,
    *,
    expected_config,
    **kwargs,
) -> None:
    payload = dict(kwargs)
    assert payload.pop("config", None) is expected_config
    updates.append({"task_id": task_id, **payload})


_EXPECTED_RUNTIME_PHASES = ["discovery", "fetch", "scoring", "persistence"]


def _assert_runtime_phase_shapes(task: dict[str, object]) -> None:
    timings = task["phase_timings_ms"]
    counts = task["phase_counts"]
    assert isinstance(timings, dict)
    assert isinstance(counts, dict)
    assert list(timings) == _EXPECTED_RUNTIME_PHASES
    assert list(counts) == _EXPECTED_RUNTIME_PHASES
    assert all(isinstance(value, (int, float)) and value >= 0 for value in timings.values())
    assert all(isinstance(value, int) and value >= 0 for value in counts.values())


class _FakeCoverLookupProviderRegistry:
    provider_group_names = [
        "music_services",
        "manual_urls",
        "bandcamp",
        "cover_art_archive",
        "discogs",
        "artist_website_fallback",
    ]

    def __init__(
        self,
        *,
        service_matches=None,
        manual_matches=None,
        bandcamp_matches=None,
        discogs_archive_matches=None,
        artist_website_matches=None,
    ) -> None:
        self.service_matches = service_matches
        self.manual_matches = manual_matches
        self.bandcamp_matches = bandcamp_matches
        self.discogs_archive_matches = discogs_archive_matches
        self.artist_website_matches = artist_website_matches
        self.discogs_archive_should_cancel: list[object] = []

    def _value(self, value, *args, **kwargs):
        if callable(value):
            return value(*args, **kwargs)
        return value or []

    def search_music_service_matches(self, query, *, manual_urls=None, should_cancel=None):
        return (
            self._value(self.service_matches, query, manual_urls=manual_urls, should_cancel=should_cancel),
            self._value(self.manual_matches, query, manual_urls=manual_urls, should_cancel=should_cancel),
        )

    def search_bandcamp_matches(self, query):
        return self._value(self.bandcamp_matches, query)

    def search_discogs_and_cover_art_archive_matches(self, query, *, should_cancel=None):
        self.discogs_archive_should_cancel.append(should_cancel)
        result = self._value(self.discogs_archive_matches, query)
        return result if isinstance(result, tuple) else ([], [])

    def search_artist_website_matches(self, query):
        return self._value(self.artist_website_matches, query)


def test_merge_lookup_matches_deduplicates_by_id_then_url():
    existing = [
        {"id": "same-id", "url": "https://images.example/one.jpg"},
        {"url": "https://images.example/two.jpg"},
    ]
    incoming = [
        {"id": "same-id", "url": "https://images.example/one-new.jpg"},
        {"url": "https://images.example/two.jpg"},
        {"id": "new-id", "url": "https://images.example/three.jpg"},
    ]

    merged = cover_lookup_runtime.merge_lookup_matches(existing, incoming)

    assert merged == [
        {"id": "same-id", "url": "https://images.example/one.jpg"},
        {"url": "https://images.example/two.jpg"},
        {"id": "new-id", "url": "https://images.example/three.jpg"},
    ]


@pytest.mark.parametrize(
    ("raw_url", "expected_url"),
    [
        ("//images.example/cover.jpg#fragment", "https://images.example/cover.jpg"),
        (
            "http://coverartarchive.org/release/abc/front.jpg#cover",
            "https://coverartarchive.org/release/abc/front.jpg",
        ),
    ],
)
def test_fetch_remote_cover_bytes_uses_extracted_download_owner_and_explicit_config(config, logger, library_state,
    monkeypatch,
    raw_url,
    expected_url,
):
    captured: dict[str, object] = {}

    def fake_fetch_remote_image(image_url: str, **kwargs):
        captured["image_url"] = image_url
        captured.update(kwargs)
        return SimpleNamespace(payload=b"image-bytes", mime_type="image/jpeg")

    monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_image", fake_fetch_remote_image)

    payload, mime_type = cover_lookup_runtime.fetch_remote_cover_bytes(raw_url, config=config)

    assert payload == b"image-bytes"
    assert mime_type == "image/jpeg"
    assert captured == {
        "image_url": expected_url,
        "user_agent": config["MUSICBRAINZ_USER_AGENT"],
        "service": "manual-remote",
        "context": f"remote-image:{expected_url}",
    }


def test_fetch_remote_cover_bytes_requires_explicit_config_or_user_agent(config, logger, library_state, monkeypatch):
    def fail_fetch_remote_image(*_args, **_kwargs):
        raise AssertionError("Missing explicit dependencies must fail before fetching")

    monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_image", fail_fetch_remote_image)

    with pytest.raises(ValueError, match="requires explicit config or user_agent"):
        cover_lookup_runtime.fetch_remote_cover_bytes("https://images.example/no-fallback.jpg")


def test_fetch_remote_cover_bytes_accepts_explicit_config_without_flask_context(config, logger, library_state, monkeypatch):
    captured: dict[str, object] = {}

    def fake_fetch_remote_image(image_url: str, **kwargs):
        captured["image_url"] = image_url
        captured.update(kwargs)
        return SimpleNamespace(payload=b"asgi-image-bytes", mime_type="image/png")

    monkeypatch.setattr(cover_lookup_runtime, "fetch_remote_image", fake_fetch_remote_image)

    payload, mime_type = cover_lookup_runtime.fetch_remote_cover_bytes(
        "//images.example/asgi-cover.png#preview",
        config=config,
        user_agent="AlbumHavenASGI/1.0",
    )

    assert payload == b"asgi-image-bytes"
    assert mime_type == "image/png"
    assert captured == {
        "image_url": "https://images.example/asgi-cover.png",
        "user_agent": "AlbumHavenASGI/1.0",
        "service": "manual-remote",
        "context": "remote-image:https://images.example/asgi-cover.png",
    }


def test_queue_cover_lookup_task_registers_background_future(config, logger, library_state, monkeypatch, tmp_path: Path):
    calls: dict[str, object] = {}
    queue_events: list[str] = []
    cancel_event = object()
    album = _album_payload(tmp_path / "song.mp3")
    requested_track_paths = {str(tmp_path / "song.mp3")}
    manual_urls = ["https://example.com/cover"]

    class FakeExecutor:
        def submit(self, fn, *args):
            calls["fn"] = fn
            calls["args"] = args
            return "fake-future"

    monkeypatch.setattr(cover_lookup_runtime, "_COVER_LOOKUP_EXECUTOR", FakeExecutor())
    monkeypatch.setattr(
        cover_lookup_runtime,
        "create_cover_lookup_task",
        lambda album, track_paths, manual_urls=None: (
            queue_events.append("create-task") or ("task-123", cancel_event)
        ),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "build_cover_lookup_provider_deadline_at",
        lambda _candidate_config: (_ for _ in ()).throw(
            AssertionError("Provider budget must not start while the task is queued")
        ),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "register_cover_lookup_future",
        lambda task_id, future: calls.setdefault("registered", (task_id, future)),
    )

    task_id = cover_lookup_runtime.queue_cover_lookup_task(
        album=album,
        requested_track_paths=requested_track_paths,
        manual_urls=manual_urls,
        config=config,
        logger=logger,
    )

    assert task_id == "task-123"
    assert calls["fn"] is cover_lookup_runtime._run_cover_lookup_job
    assert len(calls["args"]) == 1
    runtime_job = calls["args"][0]
    assert runtime_job.task_id == "task-123"
    assert runtime_job.config is config
    assert runtime_job.logger is logger
    assert runtime_job.user_agent == config["MUSICBRAINZ_USER_AGENT"]
    assert runtime_job.album == album
    assert runtime_job.requested_track_paths == requested_track_paths
    assert runtime_job.cancel_event is cancel_event
    assert runtime_job.manual_urls == manual_urls
    assert not hasattr(runtime_job, "provider_deadline_at")
    assert queue_events == ["create-task"]
    assert runtime_job.job_contract["job_kind"] == "candidate_lookup"
    assert runtime_job.job_contract["provider_groups"] == [
        "music_services",
        "manual_urls",
        "bandcamp",
        "cover_art_archive",
        "discogs",
        "artist_website_fallback",
    ]
    assert calls["registered"] == ("task-123", "fake-future")


def test_run_cover_lookup_job_starts_provider_deadline_inside_worker(monkeypatch):
    captured: dict[str, object] = {}
    runtime_job = SimpleNamespace(
        task_id="task-queued-deadline",
        config={"MUSICBRAINZ_USER_AGENT": "AlbumHavenTest/1.0"},
        logger=object(),
        user_agent="AlbumHavenTest/1.0",
        album={"album_artist": "Test Artist", "name": "Test Album"},
        requested_track_paths={"C:/Music/Test/song.mp3"},
        cancel_event=Event(),
        manual_urls=["https://example.com/cover"],
    )

    def build_deadline(candidate_config):
        captured["deadline_config"] = candidate_config
        return 765.5

    monkeypatch.setattr(
        cover_lookup_runtime,
        "build_cover_lookup_provider_deadline_at",
        build_deadline,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "_run_cover_lookup_task",
        lambda *args, **kwargs: captured.update({"args": args, "kwargs": kwargs}),
    )

    cover_lookup_runtime._run_cover_lookup_job(runtime_job)

    assert captured["args"] == (
        runtime_job.task_id,
        runtime_job.config,
        runtime_job.logger,
        runtime_job.user_agent,
        runtime_job.album,
        runtime_job.requested_track_paths,
        runtime_job.cancel_event,
        runtime_job.manual_urls,
    )
    assert captured["kwargs"] == {"provider_deadline_at": 765.5}
    assert captured["deadline_config"] is runtime_job.config


def test_queued_fifth_cover_lookup_gets_full_provider_budget_after_worker_saturation(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    executor = ThreadPoolExecutor(max_workers=4)
    release_workers = Event()
    worker_started = [Event() for _index in range(4)]
    deadline_calls: list[dict[str, object]] = []
    lookup_ran = Event()

    def occupy_worker(index: int) -> None:
        worker_started[index].set()
        assert release_workers.wait(2)

    blocker_futures = [
        executor.submit(occupy_worker, index)
        for index in range(4)
    ]
    for started in worker_started:
        assert started.wait(1)

    monkeypatch.setattr(cover_lookup_runtime, "_COVER_LOOKUP_EXECUTOR", executor)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "create_cover_lookup_task",
        lambda *_args, **_kwargs: ("task-fifth", Event()),
    )
    monkeypatch.setattr(cover_lookup_runtime, "register_cover_lookup_future", lambda *_args: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "build_cover_lookup_provider_deadline_at",
        lambda candidate_config: (
            deadline_calls.append(candidate_config) or 987.25
        ),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "_run_cover_lookup_task",
        lambda *_args, **kwargs: (
            deadline_calls.append({"deadline_at": kwargs["provider_deadline_at"]}),
            lookup_ran.set(),
        ),
    )

    try:
        cover_lookup_runtime.queue_cover_lookup_task(
            album=_album_payload(tmp_path / "song.mp3"),
            requested_track_paths={str(tmp_path / "song.mp3")},
            config=config,
            logger=logger,
        )

        time.sleep(0.02)
        assert deadline_calls == []

        release_workers.set()
        assert lookup_ran.wait(1)
        assert deadline_calls == [
            config,
            {"deadline_at": 987.25},
        ]
    finally:
        release_workers.set()
        for future in blocker_futures:
            future.result(timeout=1)
        executor.shutdown(wait=True)


def test_queue_cover_lookup_save_remote_task_submits_runtime_job(monkeypatch, tmp_path: Path):
    calls: dict[str, object] = {}
    config = {"MUSICBRAINZ_USER_AGENT": "AlbumHavenTest/1.0"}
    logger = object()
    library_state: dict[str, object] = {"albums": []}
    requested_track_paths = {str(tmp_path / "song.mp3")}

    class FakeExecutor:
        def submit(self, fn, *args, **kwargs):
            calls["fn"] = fn
            calls["args"] = args
            calls["kwargs"] = kwargs
            return "fake-future"

    def fake_apply_cover_selection_for_tracks(track_paths, **changes):
        return [dict(changes)], {"track_paths": sorted(track_paths)}

    monkeypatch.setattr(cover_lookup_runtime, "_COVER_LOOKUP_EXECUTOR", FakeExecutor())
    monkeypatch.setattr(
        cover_lookup_runtime,
        "register_cover_lookup_future",
        lambda task_id, future: calls.setdefault("registered", (task_id, future)),
    )

    cover_lookup_runtime.queue_cover_lookup_save_remote_task(
        task_id="task-123",
        album_root=tmp_path,
        requested_track_paths=requested_track_paths,
        candidate_id="candidate-1",
        selected_match={
            "url": "https://images.example/cover.jpg",
            "thumbnail_url": "https://images.example/thumb.jpg",
            "source": "discogs",
            "source_label": "Discogs",
            "album_url": "https://example.com/album",
            "width": 1200,
            "height": 1200,
            "display_only": True,
        },
        config=config,
        logger=logger,
        library_state=library_state,
        user_agent="ExplicitAgent/2.0",
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert calls["fn"] is cover_lookup_runtime._run_cover_lookup_save_remote_task
    assert calls["args"][:8] == (
        "task-123",
        config,
        logger,
        library_state,
        "ExplicitAgent/2.0",
        tmp_path,
        requested_track_paths,
        "candidate-1",
    )
    assert isinstance(calls["args"][8], SelectedRemoteImage)
    assert calls["args"][8].url == "https://images.example/cover.jpg"
    assert calls["args"][8].thumbnail_url == "https://images.example/thumb.jpg"
    assert calls["args"][8].source == "discogs"
    assert calls["args"][8].source_label == "Discogs"
    assert calls["args"][8].album_url == "https://example.com/album"
    assert calls["args"][8].width == 1200
    assert calls["args"][8].height == 1200
    assert calls["args"][8].display_only is True
    assert calls["args"][8].art_kind == "cover"
    assert calls["kwargs"]["apply_cover_selection_for_tracks"] is fake_apply_cover_selection_for_tracks
    assert calls["registered"] == ("task-123", "fake-future")


def test_run_cover_lookup_task_queries_discogs_and_cover_art_archive_in_parallel(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    cover_art_archive_started = Event()
    discogs_started = Event()
    updates: list[dict[str, object]] = []
    observed_parallel_overlap: list[bool] = []
    artist_website_calls: list[bool] = []
    discarded_task_ids: list[str] = []

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: discarded_task_ids.append(task_id))
    monkeypatch.setattr(cover_lookup_runtime, "finalize_cover_lookup_task_canceled", lambda task_id, **_kwargs: (_ for _ in ()).throw(AssertionError(f"Unexpected cancel for {task_id}")))
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    def fake_search_cover_art_archive_candidates():
        cover_art_archive_started.set()
        observed_parallel_overlap.append(discogs_started.wait(1))
        return []

    def fake_search_discogs_cover_candidates():
        discogs_started.set()
        observed_parallel_overlap.append(cover_art_archive_started.wait(1))
        return []

    def fake_search_artist_website_cover_candidates(_query):
        artist_website_calls.append(True)
        return []

    def fake_discogs_and_archive(_query):
        with ThreadPoolExecutor(max_workers=2) as executor:
            caa_future = executor.submit(fake_search_cover_art_archive_candidates)
            discogs_future = executor.submit(fake_search_discogs_cover_candidates)
            for future in as_completed([caa_future, discogs_future]):
                future.result()
        return [], []

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[],
            bandcamp_matches=[],
            discogs_archive_matches=fake_discogs_and_archive,
            artist_website_matches=fake_search_artist_website_cover_candidates,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-parallel",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert cover_art_archive_started.is_set() is True
    assert discogs_started.is_set() is True
    assert observed_parallel_overlap == [True, True]
    assert artist_website_calls == [True]
    assert discarded_task_ids == ["task-parallel"]
    assert any(update.get("progress_label") == "Searching Discogs and Cover Art Archive..." for update in updates)
    assert any(update.get("progress_label") == "Checking artist website..." for update in updates)
    assert any(
        update.get("status") == "completed"
        and update.get("result_kind") == "no-results"
        and update.get("progress") == 100
        for update in updates
    )


@pytest.mark.parametrize(
    ("provider_with_match", "expected_sources", "artist_website_expected"),
    [
        ("bandcamp", ["bandcamp"], True),
        ("discogs", ["discogs"], True),
        ("cover_art_archive", ["cover_art_archive"], True),
        ("artist_website", ["artist_website"], True),
    ],
)
def test_run_cover_lookup_task_outer_fallback_provider_matrix(config, logger, library_state,
    monkeypatch,
    tmp_path: Path,
    provider_with_match: str,
    expected_sources: list[str],
    artist_website_expected: bool,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    artist_website_calls: list[bool] = []
    discarded_task_ids: list[str] = []

    def provider_match(source: str) -> list[dict[str, object]]:
        return [{"id": f"{source}-1", "source": source, "url": f"https://images.example/{source}.jpg"}]

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: discarded_task_ids.append(task_id))
    monkeypatch.setattr(cover_lookup_runtime, "finalize_cover_lookup_task_canceled", lambda task_id, **_kwargs: (_ for _ in ()).throw(AssertionError(f"Unexpected cancel for {task_id}")))
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    def fake_search_artist_website_cover_candidates(_query):
        artist_website_calls.append(True)
        return provider_match("artist_website") if provider_with_match == "artist_website" else []

    discogs_matches = provider_match("discogs") if provider_with_match == "discogs" else []
    archive_matches = provider_match("cover_art_archive") if provider_with_match == "cover_art_archive" else []
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[],
            manual_matches=[],
            bandcamp_matches=provider_match("bandcamp") if provider_with_match == "bandcamp" else [],
            discogs_archive_matches=(discogs_matches, archive_matches),
            artist_website_matches=fake_search_artist_website_cover_candidates,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        f"task-{provider_with_match}",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    completed_updates = [update for update in updates if update.get("status") == "completed"]
    assert discarded_task_ids == [f"task-{provider_with_match}"]
    assert completed_updates
    assert completed_updates[-1].get("result_kind") == "possible-matches"
    assert [match.get("source") for match in completed_updates[-1].get("possible_matches", [])] == expected_sources
    assert bool(artist_website_calls) is artist_website_expected
    assert any(update.get("progress_label") == "Checking Bandcamp..." for update in updates)
    assert any(update.get("progress_label") == "Searching Discogs and Cover Art Archive..." for update in updates)
    assert any(update.get("progress_label") == "Checking artist website..." for update in updates)


def test_run_cover_lookup_task_preserves_provider_grouping_and_candidate_order(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )
    service_matches = [{
            "id": "service-apple",
            "source": "apple",
            "lookup_group": "services",
            "url": "https://images.example/apple.jpg",
        }]
    manual_matches = [{
            "id": "manual-1",
            "source": "direct_url",
            "lookup_group": "manual_links",
            "url": "https://images.example/manual.jpg",
        }]
    bandcamp_matches = [{
            "id": "bandcamp-1",
            "source": "bandcamp",
            "lookup_group": "services",
            "url": "https://images.example/bandcamp.jpg",
        }]
    discogs_matches = [{
            "id": "discogs-1",
            "source": "discogs",
            "lookup_group": "discogs",
            "url": "https://images.example/discogs.jpg",
        }]
    archive_matches = [{
            "id": "caa:release-1:0",
            "source": "cover_art_archive",
            "lookup_group": "cover_art_archive",
            "url": "https://images.example/caa.jpg",
        }]
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=service_matches,
            manual_matches=manual_matches,
            bandcamp_matches=bandcamp_matches,
            discogs_archive_matches=(discogs_matches, archive_matches),
            artist_website_matches=[],
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-grouping",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
        manual_urls=["https://images.example/manual.jpg"],
    )

    completed = [update for update in updates if update.get("status") == "completed"][-1]
    assert completed["result_kind"] == "possible-matches"
    assert [
        (match.get("id"), match.get("source"), match.get("lookup_group"))
        for match in completed["possible_matches"]
    ] == [
        ("service-apple", "apple", "services"),
        ("manual-1", "direct_url", "manual_links"),
        ("bandcamp-1", "bandcamp", "services"),
        ("discogs-1", "discogs", "discogs"),
        ("caa:release-1:0", "cover_art_archive", "cover_art_archive"),
    ]
    assert completed["caa_empty_notice"] is False
    assert completed["message"] == "Possible matches are ready."


def test_run_cover_lookup_task_does_not_require_bandcamp_after_acceptable_manual_match(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    fallback_calls: list[str] = []
    registry = _FakeCoverLookupProviderRegistry(
        service_matches=[],
        manual_matches=[{
            "id": "manual-1",
            "source": "direct_url",
            "url": "https://images.example/manual.jpg",
            "width": 1400,
            "height": 1400,
            "score": 1.0,
        }],
        bandcamp_matches=lambda *_args, **_kwargs: fallback_calls.append("bandcamp") or [],
        discogs_archive_matches=lambda *_args, **_kwargs: fallback_calls.append("discogs-caa") or ([], []),
        artist_website_matches=lambda *_args, **_kwargs: fallback_calls.append("artist-website") or [],
    )

    monkeypatch.setattr(cover_lookup_runtime, "COVER_LOOKUP_PROVIDER_REGISTRY", registry)
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda *_args: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-manual-sufficient",
        config,
        logger,
        config["MUSICBRAINZ_USER_AGENT"],
        album,
        requested_track_paths,
        cancel_event,
        ["https://images.example/manual.jpg"],
    )

    # Bandcamp is started optimistically beside the main provider group, so it may
    # enter before the manual match is known. Once that match exists, the lookup
    # must not wait for Bandcamp; the remaining provider stages still run.
    assert fallback_calls.count("discogs-caa") == 1
    assert fallback_calls.count("artist-website") == 1
    assert fallback_calls.index("discogs-caa") < fallback_calls.index("artist-website")
    assert fallback_calls.count("bandcamp") <= 1
    assert updates[-1]["status"] == "completed"
    assert updates[-1]["possible_matches"] == [{
        "id": "manual-1",
        "source": "direct_url",
        "url": "https://images.example/manual.jpg",
        "width": 1400,
        "height": 1400,
        "score": 1.0,
    }]


def test_manual_lookup_publishes_each_merged_provider_stage_and_completes_snapshot_generation(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = {**_album_payload(track_path), "id": 41}
    repository_configs: list[object] = []
    publisher_inits: list[dict[str, object]] = []
    published_candidate_ids: list[list[str]] = []
    terminal_calls: list[str] = []

    class FakeRepository:
        def __init__(self, selected_config):
            repository_configs.append(selected_config)

    class FakePublisher:
        def __init__(self, repository, *, album_id, search_generation, search_kind):
            publisher_inits.append({
                "repository": repository,
                "album_id": album_id,
                "search_generation": search_generation,
                "search_kind": search_kind,
            })

        def publish_candidates(self, candidates, **_kwargs):
            published_candidate_ids.append([str(item.get("id") or "") for item in candidates])
            return True

        def complete(self):
            terminal_calls.append("completed")
            return True

        def fail(self):
            terminal_calls.append("failed")
            return True

    def match(source):
        return {
            "id": source,
            "source": source,
            "url": f"https://images.example/{source}.jpg",
        }

    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        FakeRepository,
        raising=False,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidatePublisher",
        FakePublisher,
        raising=False,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[match("apple")],
            manual_matches=[],
            bandcamp_matches=[match("bandcamp")],
            discogs_archive_matches=([match("discogs")], [match("caa")]),
            artist_website_matches=[match("artist-site")],
        ),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda *_args: None)

    cover_lookup_runtime._run_cover_lookup_task(
        "manual-generation-1",
        config,
        logger,
        config["MUSICBRAINZ_USER_AGENT"],
        album,
        {str(track_path)},
        Event(),
    )

    assert repository_configs == [config]
    assert publisher_inits == [{
        "repository": publisher_inits[0]["repository"],
        "album_id": 41,
        "search_generation": "manual-generation-1",
        "search_kind": "manual",
    }]
    assert published_candidate_ids == [
        ["apple"],
        ["apple", "bandcamp"],
        ["apple", "bandcamp", "discogs", "caa"],
        ["apple", "bandcamp", "discogs", "caa", "artist-site"],
    ]
    assert terminal_calls == ["completed"]


def test_manual_lookup_resolves_snapshot_album_id_when_client_payload_omits_it(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    resolved_track_paths: list[set[str]] = []
    publisher_album_ids: list[int] = []

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            resolved_track_paths.append(set(track_paths))
            return 41

    class FakePublisher:
        def __init__(self, _repository, *, album_id, **_kwargs):
            publisher_album_ids.append(album_id)

        def publish_candidates(self, _candidates, **_kwargs):
            return True

        def complete(self):
            return True

        def fail(self):
            return True

    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        FakeRepository,
        raising=False,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidatePublisher",
        FakePublisher,
        raising=False,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[{
                "id": "apple-1",
                "source": "apple",
                "url": "https://images.example/apple.jpg",
            }],
            bandcamp_matches=[],
            discogs_archive_matches=([], []),
            artist_website_matches=[],
        ),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda *_args: None)

    cover_lookup_runtime._run_cover_lookup_task(
        "manual-generation-without-client-id",
        config,
        logger,
        config["MUSICBRAINZ_USER_AGENT"],
        album,
        {str(track_path)},
        Event(),
    )

    assert resolved_track_paths == [{str(track_path)}]
    assert publisher_album_ids == [41]


def test_manual_lookup_snapshot_failure_keeps_task_candidates_and_records_bounded_diagnostic(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = {**_album_payload(track_path), "id": 41}
    updates: list[dict[str, object]] = []

    class FakeRepository:
        def __init__(self, _config):
            pass

    class FailingPublisher:
        def __init__(self, *_args, **_kwargs):
            pass

        def publish_candidates(self, _candidates, **_kwargs):
            raise RuntimeError("database detail " + ("x" * 10_000))

        def complete(self):
            pytest.fail("a generation that never persisted candidates must not be completed")

        def fail(self):
            pytest.fail("snapshot persistence failure is not a provider-search failure")

    monkeypatch.setattr(cover_lookup_runtime, "AlbumCoverCandidateSnapshotRepository", FakeRepository, raising=False)
    monkeypatch.setattr(cover_lookup_runtime, "AlbumCoverCandidatePublisher", FailingPublisher, raising=False)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[{
                "id": "apple-1",
                "source": "apple",
                "url": "https://images.example/apple.jpg",
            }],
            bandcamp_matches=[],
            discogs_archive_matches=([], []),
            artist_website_matches=[],
        ),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda *_args: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "manual-persistence-failure",
        config,
        logger,
        config["MUSICBRAINZ_USER_AGENT"],
        album,
        {str(track_path)},
        Event(),
    )

    completed = [update for update in updates if update.get("status") == "completed"][-1]
    assert [item["id"] for item in completed["possible_matches"]] == ["apple-1"]
    assert completed["candidate_snapshot_diagnostic"] == "durable_candidate_persistence_failed"
    assert "database detail" not in repr(completed)


def test_run_cover_lookup_task_keeps_later_provider_failures_loud_for_acceptable_apple_only_match(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = {**_album_payload(track_path), "id": 41}
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []
    later_provider_calls: list[str] = []
    terminal_calls: list[str] = []

    class FakeRepository:
        def __init__(self, _config):
            pass

    class FakePublisher:
        def __init__(self, *_args, **_kwargs):
            pass

        def publish_candidates(self, _candidates, **_kwargs):
            return True

        def complete(self):
            terminal_calls.append("completed")
            return True

        def fail(self):
            terminal_calls.append("failed")
            return True

    def fail_later_provider(*_args, **_kwargs):
        later_provider_calls.append("discogs-caa")
        raise ValueError("invalid provider width")

    registry = _FakeCoverLookupProviderRegistry(
        service_matches=[{
            "id": "apple-1",
            "source": "apple",
            "url": "https://images.example/apple.jpg",
            "width": 1400,
            "height": 1400,
            "score": 1.0,
        }],
        manual_matches=[],
        bandcamp_matches=[],
        discogs_archive_matches=fail_later_provider,
    )

    monkeypatch.setattr(cover_lookup_runtime, "COVER_LOOKUP_PROVIDER_REGISTRY", registry)
    monkeypatch.setattr(cover_lookup_runtime, "AlbumCoverCandidateSnapshotRepository", FakeRepository, raising=False)
    monkeypatch.setattr(cover_lookup_runtime, "AlbumCoverCandidatePublisher", FakePublisher, raising=False)
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda *_args: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-apple-failure",
        config,
        logger,
        config["MUSICBRAINZ_USER_AGENT"],
        album,
        requested_track_paths,
        Event(),
    )

    assert later_provider_calls == ["discogs-caa"]
    assert updates[-1]["status"] == "failed"
    assert updates[-1]["message"] == "invalid provider width"
    assert updates[-1]["error"] == "invalid provider width"
    assert terminal_calls == ["failed"]


def test_run_cover_lookup_task_uses_provider_registry_for_group_orchestration(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    registry_calls: list[str] = []
    config["COVER_PROVIDER_GROUPS"] = frozenset({"manual_urls"})
    config["ENABLED_MUSIC_SERVICES"] = frozenset({"apple"})

    class FakeProviderRegistry:
        provider_group_names = [
            "music_services",
            "manual_urls",
            "bandcamp",
            "cover_art_archive",
            "discogs",
            "artist_website_fallback",
        ]

        def search_music_service_matches(self, query, *, manual_urls=None, should_cancel=None):
            assert query.artist == "Test Artist"
            assert query.album == "Test Album"
            assert query.year == 2001
            assert query.user_agent == config["MUSICBRAINZ_USER_AGENT"]
            assert query.enabled_provider_groups == frozenset({"manual_urls"})
            assert query.enabled_music_services == frozenset({"apple"})
            assert manual_urls == ["https://images.example/manual.jpg"]
            assert callable(should_cancel)
            registry_calls.append("music_services")
            return [
                {
                    "id": "service-apple",
                    "source": "apple",
                    "lookup_group": "services",
                    "url": "https://images.example/apple.jpg",
                }
            ], [
                {
                    "id": "manual-1",
                    "source": "direct_url",
                    "lookup_group": "manual_links",
                    "url": "https://images.example/manual.jpg",
                }
            ]

        def search_bandcamp_matches(self, query):
            registry_calls.append("bandcamp")
            return [{
                "id": "bandcamp-1",
                "source": "bandcamp",
                "lookup_group": "services",
                "url": "https://images.example/bandcamp.jpg",
            }]

        def search_discogs_and_cover_art_archive_matches(self, query, *, should_cancel=None):
            assert callable(should_cancel)
            assert getattr(should_cancel, "__self__", None) is cancel_event
            registry_calls.append("discogs_cover_art_archive")
            return [
                {
                    "id": "discogs-1",
                    "source": "discogs",
                    "lookup_group": "discogs",
                    "url": "https://images.example/discogs.jpg",
                }
            ], [
                {
                    "id": "caa:release-1:0",
                    "source": "cover_art_archive",
                    "lookup_group": "cover_art_archive",
                    "url": "https://images.example/caa.jpg",
                }
            ]

        def search_artist_website_matches(self, query):
            registry_calls.append("artist_website")
            return []

    monkeypatch.setattr(cover_lookup_runtime, "COVER_LOOKUP_PROVIDER_REGISTRY", FakeProviderRegistry())
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-registry",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
        manual_urls=["https://images.example/manual.jpg"],
    )

    assert set(registry_calls[:3]) == {
        "music_services",
        "bandcamp",
        "discogs_cover_art_archive",
    }
    assert registry_calls[3:] == ["artist_website"]
    completed = [update for update in updates if update.get("status") == "completed"][-1]
    assert [
        (match.get("id"), match.get("source"), match.get("lookup_group"))
        for match in completed["possible_matches"]
    ] == [
        ("service-apple", "apple", "services"),
        ("manual-1", "direct_url", "manual_links"),
        ("bandcamp-1", "bandcamp", "services"),
        ("discogs-1", "discogs", "discogs"),
        ("caa:release-1:0", "cover_art_archive", "cover_art_archive"),
    ]
    assert completed["caa_empty_notice"] is False


def test_run_cover_lookup_task_sanitizes_cover_art_archive_internal_release_metadata(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )
    archive_matches = [{
        "id": "caa:release-1:0",
        "source": "cover_art_archive",
        "url": "https://images.example/caa.jpg",
        "thumbnail_url": "https://images.example/caa-thumb.jpg",
        "width": 1200,
        "height": 1000,
        "area": 1200000,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "art_kind": "cover",
        "art_label": "Front cover",
        "score": 0.9876,
        "source_label": "Cover Art Archive",
        "lookup_group": "cover_art_archive",
    }]
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[],
            manual_matches=[],
            bandcamp_matches=[],
            discogs_archive_matches=([], archive_matches),
            artist_website_matches=[],
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-caa-sanitized",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert config["_TEST_CANDIDATE_SNAPSHOT_RESOLVE_CALLS"] == [requested_track_paths]
    completed = [update for update in updates if update.get("status") == "completed"][-1]
    match = completed["possible_matches"][0]
    assert match == {
        "id": "caa:release-1:0",
        "source": "cover_art_archive",
        "url": "https://images.example/caa.jpg",
        "thumbnail_url": "https://images.example/caa-thumb.jpg",
        "width": 1200,
        "height": 1000,
        "area": 1200000,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "art_kind": "cover",
        "art_label": "Front cover",
        "score": 0.9876,
        "source_label": "Cover Art Archive",
        "lookup_group": "cover_art_archive",
    }


def test_run_cover_lookup_task_preserves_status_label_progression_for_no_results(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-labels",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    label_updates = [
        {
            "status": update.get("status"),
            "progress": update.get("progress"),
            "progress_label": update.get("progress_label"),
        }
        for update in updates
        if "progress_label" in update
    ]
    assert label_updates == [
        {"status": "running", "progress": 12, "progress_label": "Searching music services..."},
        {"status": None, "progress": 52, "progress_label": "Collecting service matches..."},
        {"status": None, "progress": 62, "progress_label": "Checking Bandcamp..."},
        {"status": None, "progress": 72, "progress_label": "Searching Discogs and Cover Art Archive..."},
        {"status": None, "progress": 78, "progress_label": "Checking artist website..."},
        {"status": "completed", "progress": 100, "progress_label": "Completed"},
    ]
    completed = updates[-1]
    assert completed["result_kind"] == "no-results"
    assert completed["possible_matches"] == []
    assert completed["caa_empty_notice"] is True
    assert completed["message"] == (
        "We cannot guarantee Cover Art Archive results. Its API is flaky, you can try doing "
        "the same search later and might see good matches here"
    )


def test_run_cover_lookup_task_no_result_settles_within_shared_provider_deadline(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    provider_calls: list[str] = []
    provider_delay_seconds = 0.12
    config["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] = 0.18

    class SlowNoResultProviderRegistry:
        def pause(self, provider_name: str):
            provider_calls.append(provider_name)
            time.sleep(provider_delay_seconds)
            return []

        def search_music_service_matches(self, _query, *, manual_urls=None, should_cancel=None):
            assert callable(should_cancel)
            return self.pause("music_services"), []

        def search_bandcamp_matches(self, _query):
            return self.pause("bandcamp")

        def search_discogs_and_cover_art_archive_matches(self, _query, *, should_cancel=None):
            assert callable(should_cancel)
            self.pause("discogs_cover_art_archive")
            return [], []

        def search_artist_website_matches(self, _query):
            return self.pause("artist_website")

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        SlowNoResultProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        lambda _config: type(
            "RepositoryStub",
            (),
            {"resolve_album_id_for_track_paths": lambda self, **_kwargs: None},
        )(),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "finalize_cover_lookup_task_canceled",
        lambda task_id, **_kwargs: (_ for _ in ()).throw(
            AssertionError(f"Provider deadline must not mark no-result task {task_id} as user-canceled")
        ),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    started_at = time.perf_counter()
    cover_lookup_runtime._run_cover_lookup_task(
        "task-bounded-no-result",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )
    elapsed_seconds = time.perf_counter() - started_at

    assert elapsed_seconds < 0.32
    assert updates[-1]["status"] == "completed"
    assert updates[-1]["progress_label"] == "Completed"
    assert updates[-1]["result_kind"] == "no-results"
    assert provider_calls


def test_run_cover_lookup_task_keeps_service_candidates_found_before_deadline(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    candidate = {
        "id": "apple-before-deadline",
        "url": "https://images.example/apple-before-deadline.jpg",
        "source": "apple",
        "source_label": "Apple Music",
        "lookup_group": "services",
        "art_kind": "cover",
    }
    bandcamp_candidate = {
        "id": "bandcamp-before-deadline",
        "url": "https://images.example/bandcamp-before-deadline.jpg",
        "source": "bandcamp",
        "source_label": "Bandcamp",
        "lookup_group": "services",
        "art_kind": "cover",
    }
    config["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] = 0.08

    class CandidateThenDeadlineProviderRegistry:
        def search_music_service_matches(
            self,
            _query,
            *,
            manual_urls=None,
            should_cancel=None,
            on_candidates=None,
        ):
            assert manual_urls == []
            assert callable(should_cancel)
            if callable(on_candidates):
                on_candidates([candidate])
            while not should_cancel():
                time.sleep(0.005)
            time.sleep(0.05)
            return [candidate], []

        def search_bandcamp_matches(self, _query):
            return [bandcamp_candidate]

        def search_discogs_and_cover_art_archive_matches(self, _query, *, should_cancel=None):
            assert callable(should_cancel)
            while not should_cancel():
                time.sleep(0.005)
            return [], []

        def search_artist_website_matches(self, _query):
            raise AssertionError("The shared deadline should stop later provider groups")

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        CandidateThenDeadlineProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        lambda _config: type(
            "RepositoryStub",
            (),
            {"resolve_album_id_for_track_paths": lambda self, **_kwargs: None},
        )(),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-candidate-before-deadline",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
        manual_urls=[],
    )

    completed = updates[-1]
    assert completed["status"] == "completed"
    assert completed["result_kind"] == "possible-matches"
    assert completed["possible_matches"] == [candidate, bandcamp_candidate]


def test_run_cover_lookup_task_starts_discogs_and_cover_art_archive_beside_music_services(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    later_providers_started = Event()
    later_providers_started_during_service_search: list[bool] = []
    discogs_candidate = {
        "id": "discogs-parallel",
        "url": "https://images.example/discogs-parallel.jpg",
        "source": "discogs",
        "source_label": "Discogs",
        "lookup_group": "discogs",
        "art_kind": "cover",
    }
    archive_candidate = {
        "id": "caa:parallel:0",
        "url": "https://images.example/caa-parallel.jpg",
        "source": "cover_art_archive",
        "source_label": "Cover Art Archive",
        "lookup_group": "cover_art_archive",
        "art_kind": "cover",
    }
    config["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] = 2.0

    class ParallelLaterProviderRegistry:
        def search_music_service_matches(self, _query, *, manual_urls=None, should_cancel=None):
            assert manual_urls is None
            assert callable(should_cancel)
            later_providers_started_during_service_search.append(
                later_providers_started.wait(0.25)
            )
            return [], []

        def search_bandcamp_matches(self, _query, *, should_cancel=None, deadline_at=None):
            return []

        def search_discogs_and_cover_art_archive_matches(
            self,
            _query,
            *,
            should_cancel=None,
            deadline_at=None,
        ):
            assert callable(should_cancel)
            later_providers_started.set()
            return [discogs_candidate], [archive_candidate]

        def search_artist_website_matches(self, _query):
            return []

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        ParallelLaterProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        lambda _config: type(
            "RepositoryStub",
            (),
            {"resolve_album_id_for_track_paths": lambda self, **_kwargs: None},
        )(),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-parallel-discogs-caa",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert later_providers_started_during_service_search == [True]
    assert updates[-1]["status"] == "completed"
    assert updates[-1]["possible_matches"] == [discogs_candidate, archive_candidate]


def test_run_cover_lookup_task_starts_bandcamp_while_music_services_are_running(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    service_started = Event()
    bandcamp_started = Event()
    bandcamp_candidate = {
        "id": "bandcamp-parallel",
        "url": "https://f4.bcbits.com/img/a987_10.jpg",
        "source": "bandcamp",
        "source_label": "Bandcamp",
        "lookup_group": "services",
        "art_kind": "cover",
    }
    config["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] = 2.0

    class ParallelBandcampProviderRegistry:
        def search_music_service_matches(self, _query, *, manual_urls=None, should_cancel=None):
            assert manual_urls is None
            assert callable(should_cancel)
            service_started.set()
            assert bandcamp_started.wait(0.5), "Bandcamp did not start beside music services"
            return [], []

        def search_bandcamp_matches(self, _query, *, should_cancel=None, deadline_at=None):
            assert service_started.wait(0.5)
            bandcamp_started.set()
            return [bandcamp_candidate]

        def search_discogs_and_cover_art_archive_matches(self, _query, *, should_cancel=None):
            return [], []

        def search_artist_website_matches(self, _query):
            return []

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        ParallelBandcampProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        lambda _config: type(
            "RepositoryStub",
            (),
            {"resolve_album_id_for_track_paths": lambda self, **_kwargs: None},
        )(),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-parallel-bandcamp",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert service_started.is_set()
    assert bandcamp_started.is_set()
    assert updates[-1]["status"] == "completed"
    assert updates[-1]["possible_matches"] == [bandcamp_candidate]


def test_run_cover_lookup_task_does_not_wait_for_parallel_bandcamp_after_service_match(
    config,
    logger,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    updates: list[dict[str, object]] = []
    bandcamp_started = Event()
    bandcamp_stopped = Event()
    service_candidate = {
        "id": "apple-main-result",
        "url": "https://images.example/apple-main-result.jpg",
        "source": "apple",
        "source_label": "Apple Music",
        "lookup_group": "services",
        "art_kind": "cover",
    }
    config["COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS"] = 2.0

    class MainResultProviderRegistry:
        def search_music_service_matches(self, _query, *, manual_urls=None, should_cancel=None):
            assert bandcamp_started.wait(0.5)
            return [service_candidate], []

        def search_bandcamp_matches(self, _query, *, should_cancel=None, deadline_at=None):
            assert callable(should_cancel)
            bandcamp_started.set()
            while not should_cancel():
                time.sleep(0.005)
            bandcamp_stopped.set()
            return []

        def search_discogs_and_cover_art_archive_matches(self, _query, *, should_cancel=None):
            return [], []

        def search_artist_website_matches(self, _query):
            return []

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        MainResultProviderRegistry(),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "AlbumCoverCandidateSnapshotRepository",
        lambda _config: type(
            "RepositoryStub",
            (),
            {"resolve_album_id_for_track_paths": lambda self, **_kwargs: None},
        )(),
    )
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    started_at = time.perf_counter()
    cover_lookup_runtime._run_cover_lookup_task(
        "task-main-result-stops-bandcamp",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )
    elapsed_seconds = time.perf_counter() - started_at

    assert elapsed_seconds < 0.75
    assert bandcamp_stopped.wait(0.5)
    assert updates[-1]["status"] == "completed"
    assert updates[-1]["possible_matches"] == [service_candidate]


def test_provider_should_cancel_observes_shared_deadline_and_stops_running_provider(
    monkeypatch,
):
    cancel_event = Event()
    shared_deadline_reached = Event()
    provider_exited = Event()

    monkeypatch.setattr(
        cover_lookup_runtime,
        "cover_lookup_provider_deadline_reached",
        lambda _deadline_at: shared_deadline_reached.is_set(),
    )

    def controlled_provider(*, should_cancel):
        assert should_cancel() is False
        shared_deadline_reached.set()
        if should_cancel():
            provider_exited.set()
            return "provider-stopped"
        raise AssertionError("Provider did not observe the shared lookup deadline")

    provider_kwargs = cover_lookup_runtime._provider_call_kwargs(
        controlled_provider,
        cancel_event=cancel_event,
        deadline_at=time.perf_counter() + 60,
    )
    result, timed_out = cover_lookup_runtime._run_provider_call_until_deadline(
        lambda: controlled_provider(**provider_kwargs),
        deadline_at=time.perf_counter() + 60,
        cancel_event=cancel_event,
        fallback="deadline-fallback",
    )

    assert cancel_event.is_set() is False
    assert provider_exited.is_set() is True
    assert result == "provider-stopped"
    assert timed_out is False


def test_run_cover_lookup_task_persists_terminal_notification_after_registry_lookup(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(),
    )
    cover_lookup_tasks.reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(album, requested_track_paths)

    cover_lookup_runtime._run_cover_lookup_task(
        task_id,
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    saved_notifications = config["_TEST_COVER_LOOKUP_NOTIFICATIONS"]
    assert saved_notifications[0]["id"] == task_id
    assert saved_notifications[0]["status"] == "completed"
    assert saved_notifications[0]["notification_action_taken"] is False


def test_run_cover_lookup_task_finalizes_canceled_when_requested_before_start(config, logger, library_state, monkeypatch, tmp_path: Path):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    cancel_event.set()
    finalized_task_ids: list[str] = []
    discarded_task_ids: list[str] = []

    monkeypatch.setattr(cover_lookup_runtime, "finalize_cover_lookup_task_canceled", lambda task_id, **_kwargs: finalized_task_ids.append(task_id))
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: discarded_task_ids.append(task_id))
    monkeypatch.setattr(
        cover_lookup_runtime,
        "log_app_event",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Canceled task must not log start")),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Canceled task must not update progress")),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Canceled task must not search providers")),
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-canceled-before-start",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert finalized_task_ids == ["task-canceled-before-start"]
    assert discarded_task_ids == ["task-canceled-before-start"]


def test_run_cover_lookup_task_discards_unpublished_results_when_parallel_bandcamp_cancels(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = tmp_path / "song.mp3"
    album = _album_payload(track_path)
    album["id"] = 42
    requested_track_paths = {str(track_path)}
    cancel_event = Event()
    finalized_task_ids: list[str] = []
    discarded_task_ids: list[str] = []
    updates: list[dict[str, object]] = []
    terminal_events: list[str] = []

    class FakeCandidatePublisher:
        def __init__(self, _repository, *, album_id, search_generation, search_kind):
            assert album_id == 42
            assert search_generation == "task-canceled-during-provider"
            assert search_kind == "manual"

        def publish_candidates(self, candidates):
            assert [candidate["id"] for candidate in candidates] == ["accepted-service-result"]
            terminal_events.append("candidate-accepted")
            return True

        def fail(self):
            terminal_events.append("snapshot-failed")

    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "AlbumCoverCandidatePublisher", FakeCandidatePublisher)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "finalize_cover_lookup_task_canceled",
        lambda task_id, **_kwargs: (
            terminal_events.append("task-canceled"),
            finalized_task_ids.append(task_id),
        ),
    )
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda task_id: discarded_task_ids.append(task_id))
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    def fake_search_bandcamp_cover_candidates(_query):
        cancel_event.set()
        return [{"id": "late-bandcamp-result", "source": "bandcamp"}]

    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        _FakeCoverLookupProviderRegistry(
            service_matches=[{
                "id": "accepted-service-result",
                "source": "apple",
                "url": "https://images.example/accepted.jpg",
            }],
            bandcamp_matches=fake_search_bandcamp_cover_candidates,
            discogs_archive_matches=lambda _query: (_ for _ in ()).throw(AssertionError("Canceled task must not search Discogs or Cover Art Archive")),
            artist_website_matches=lambda _query: (_ for _ in ()).throw(AssertionError("Canceled task must not search artist website")),
        ),
    )

    cover_lookup_runtime._run_cover_lookup_task(
        "task-canceled-during-provider",
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert finalized_task_ids == ["task-canceled-during-provider"]
    assert discarded_task_ids == ["task-canceled-during-provider"]
    assert terminal_events == ["task-canceled"]
    assert not any(update.get("status") == "completed" for update in updates)
    assert all(
        "late-bandcamp-result" not in str(update.get("possible_matches") or [])
        for update in updates
    )
    assert all(update.get("status") != "completed" for update in updates)


def test_run_cover_lookup_task_routes_every_cancel_finalization_through_one_terminal_seam():
    source = inspect.getsource(cover_lookup_runtime._run_cover_lookup_task)

    assert "finalize_cover_lookup_task_canceled(" not in source
    assert "_terminalize_canceled_cover_lookup_task(" in source


def test_run_cover_lookup_save_remote_task_preserves_spotify_linked_cover_without_fetching_bytes(config, logger, library_state, monkeypatch, tmp_path: Path):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []
    persistence_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def fake_apply_cover_selection_for_tracks(
        track_paths,
        *,
        config=None,
        logger=None,
        library_state=None,
        schedule_cache_update=True,
        _expected_config=config,
        _expected_logger=logger,
        _expected_library_state=library_state,
        **changes,
    ):
        assert track_paths == requested_track_paths
        assert config is _expected_config
        assert logger is _expected_logger
        assert library_state is _expected_library_state
        assert schedule_cache_update is False
        assert changes == {
            "cover_path": None,
            "remote_cover_url": "https://images.example/cover.jpg",
            "remote_cover_thumbnail_url": "https://images.example/thumb.jpg",
            "remote_cover_source": "spotify",
            "remote_cover_source_label": "Spotify",
            "remote_cover_album_url": "https://open.spotify.com/album/album-1",
            "remote_cover_width": 1500,
            "remote_cover_height": 1500,
        }
        return [{"key": "album-1"}], {"key": "problem-1"}

    def fake_persist_cover_selection_for_tracks(track_paths, **changes):
        persistence_calls.append({"track_paths": track_paths, "changes": changes})
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        lambda **_kwargs: pytest.fail("Spotify linked covers must not download image bytes"),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/cover.jpg",
            thumbnail_url="https://images.example/thumb.jpg",
            source="spotify",
            source_label="Spotify",
            album_url="https://open.spotify.com/album/album-1",
            width=1500,
            height=1500,
            display_only=True,
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
        persist_cover_selection_for_tracks=fake_persist_cover_selection_for_tracks,
    )

    assert persistence_calls == [{
        "track_paths": requested_track_paths,
        "changes": {
            "cover_path": None,
            "cover_selection_origin": "user",
            "remote_cover_url": "https://images.example/cover.jpg",
            "remote_cover_thumbnail_url": "https://images.example/thumb.jpg",
            "remote_cover_source": "spotify",
            "remote_cover_source_label": "Spotify",
            "remote_cover_album_url": "https://open.spotify.com/album/album-1",
            "remote_cover_width": 1500,
            "remote_cover_height": 1500,
            "config": config,
            "logger": logger,
        },
    }]

    assert updates == [
        {
            "task_id": "task-save",
            "status": "completed",
            "progress": 100,
            "progress_label": "Completed",
            "finished_at": updates[0]["finished_at"],
            "selected_candidate_id": "candidate-1",
            "notification_action_taken": True,
            "message": "Selected remote cover art saved as a linked artwork source.",
            "result_kind": "cover-updated",
            "updated_albums": [{"key": "album-1"}],
            "updated_problematic_album": {"key": "problem-1"},
        }
    ]


def test_successful_remote_save_requests_event_only_lookup_cancellation(config, logger, library_state, tmp_path: Path):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    task_id, cancel_event = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        requested_track_paths,
    )
    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        task_id,
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/cover.jpg",
            thumbnail_url="https://images.example/thumb.jpg",
            source="discogs",
            source_label="Discogs",
            display_only=True,
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=lambda _track_paths, **_changes: ([{"key": "album-1"}], None),
    )

    task = cover_lookup_tasks.cover_lookup_result(task_id)
    assert cancel_event.is_set() is True
    assert task["status"] == "completed"
    assert task["result_kind"] == "cover-updated"
    assert task["selected_candidate_id"] == "candidate-1"
    assert task["cancel_requested"] is False


def test_failed_remote_save_does_not_request_lookup_cancellation(config, logger, library_state, tmp_path: Path):
    track_path = (tmp_path / "Outside" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    task_id, cancel_event = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        requested_track_paths,
    )
    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
        },
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        task_id,
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        track_path.parent,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/cover.jpg",
            source="discogs",
            source_label="Discogs",
            display_only=True,
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Invalid album root must fail before applying the selection")
        ),
    )

    task = cover_lookup_tasks.cover_lookup_result(task_id)
    assert cancel_event.is_set() is False
    assert task["status"] == "failed"
    assert task.get("result_kind") != "cover-updated"


def test_run_cover_lookup_save_remote_task_rejects_display_only_mixed_unsafe_tracks_before_applying(config, logger, library_state,
    monkeypatch,
):
    valid_track = (config["MUSIC_DIR"] / "Artist" / "Album" / "one.mp3").resolve()
    outside_track = (config["MUSIC_DIR"].parent / "Outside" / "Artist" / "Album" / "two.mp3").resolve()
    valid_track.parent.mkdir(parents=True, exist_ok=True)
    outside_track.parent.mkdir(parents=True, exist_ok=True)
    valid_track.write_bytes(b"track")
    outside_track.write_bytes(b"track")
    traversal_track_path = config["MUSIC_DIR"] / ".." / "Outside" / "Artist" / "Album" / "two.mp3"
    requested_track_paths = {str(valid_track), str(traversal_track_path)}
    updates: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
        },
    )

    def fake_apply_cover_selection_for_tracks(
        track_paths,
        *,
        schedule_cache_update=True,
        **changes,
    ):
        apply_calls.append({
            "track_paths": track_paths,
            "changes": changes,
            "schedule_cache_update": schedule_cache_update,
        })
        raise AssertionError("Unsafe display-only selections must not update album cover state")

    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-display-only-unsafe-root",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        valid_track.parent,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/cover.jpg",
            thumbnail_url="https://images.example/thumb.jpg",
            source="discogs",
            source_label="Discogs",
            album_url="https://discogs.example/release/1",
            width=1500,
            height=1500,
            display_only=True,
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert apply_calls == []
    assert not (valid_track.parent / "cover.jpg").exists()
    assert not (outside_track.parent / "cover.jpg").exists()
    assert updates == [
        {
            "task_id": "task-display-only-unsafe-root",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "Album root could not be resolved",
        }
    ]


@pytest.mark.parametrize(
    ("source", "source_label"),
    [
        ("apple", "Apple Music"),
        ("deezer", "Deezer"),
        ("youtube_music", "YouTube Music"),
    ],
)
def test_run_cover_lookup_save_remote_task_applies_written_local_cover_path(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
    source,
    source_label,
):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    written_cover = album_root / "cover.jpg"
    updates: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []
    download_calls: list[dict[str, object]] = []
    fetch_calls: list[dict[str, object]] = []
    persistence_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def fake_fetch_remote_image(image_url: str, **kwargs):
        fetch_calls.append({"image_url": image_url, **kwargs})
        return SimpleNamespace(payload=_jpeg_bytes())

    def delegating_download_remote_cover_to_folder(**kwargs):
        download_calls.append(kwargs)
        return cover_workflow.download_remote_cover_to_folder(
            **kwargs,
            fetch_remote_image_func=fake_fetch_remote_image,
        )

    def fake_apply_cover_selection_for_tracks(
        track_paths,
        *,
        schedule_cache_update=True,
        **changes,
    ):
        apply_calls.append({
            "track_paths": track_paths,
            "changes": changes,
            "schedule_cache_update": schedule_cache_update,
        })
        return [{"key": "album-1", "cover_path": str(written_cover)}], None

    def fake_persist_cover_selection_for_tracks(track_paths, **changes):
        persistence_calls.append({"track_paths": track_paths, "changes": changes})
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        delegating_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-local",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url=f"https://images.example/{source}.jpg",
            thumbnail_url=f"https://images.example/{source}-thumb.jpg",
            source=source,
            source_label=source_label,
            album_url=f"https://catalog.example/{source}/album-1",
            width=1500,
            height=1500,
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
        persist_cover_selection_for_tracks=fake_persist_cover_selection_for_tracks,
    )

    assert download_calls == [{
        "folder": album_root,
        "image_url": f"https://images.example/{source}.jpg",
        "user_agent": config["MUSICBRAINZ_USER_AGENT"],
    }]
    assert fetch_calls == [{
        "image_url": f"https://images.example/{source}.jpg",
        "user_agent": config["MUSICBRAINZ_USER_AGENT"],
        "service": "manual-remote",
        "context": f"manual-cover-download:{album_root.name}",
    }]
    assert written_cover.is_file()
    assert persistence_calls == [{
        "track_paths": requested_track_paths,
        "changes": {
            "cover_path": written_cover,
            "cover_selection_origin": "user",
            "remote_cover_url": None,
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": None,
            "remote_cover_source_label": None,
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "config": config,
            "logger": logger,
        },
    }]
    assert apply_calls == [{
        "track_paths": requested_track_paths,
        "changes": {
            "cover_path": written_cover,
        },
        "schedule_cache_update": False,
    }]
    assert updates == [
        {
            "task_id": "task-save-local",
            "status": "completed",
            "progress": 100,
            "progress_label": "Completed",
            "finished_at": updates[0]["finished_at"],
            "selected_candidate_id": "candidate-1",
            "notification_action_taken": True,
            "message": "Selected cover art saved.",
            "result_kind": "cover-updated",
            "updated_albums": [{"key": "album-1", "cover_path": str(written_cover)}],
            "updated_problematic_album": None,
        }
    ]


def test_downloaded_cover_persistence_failure_restores_prior_cover_and_removes_only_new_reserve(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    prior_cover_bytes = _jpeg_bytes((220, 30, 30))
    preexisting_reserve_bytes = _jpeg_bytes((30, 220, 30))
    downloaded_cover_bytes = _jpeg_bytes((30, 30, 220))
    canonical_cover = album_root / "cover.jpg"
    preexisting_reserve = album_root / "cover-existing-1.jpg"
    canonical_cover.write_bytes(prior_cover_bytes)
    prior_cover_timestamp_ns = 1_700_000_000_123_456_700
    os.utime(
        canonical_cover,
        ns=(prior_cover_timestamp_ns, prior_cover_timestamp_ns),
    )
    preexisting_reserve.write_bytes(preexisting_reserve_bytes)
    updates: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []
    logged_exceptions: list[dict[str, object]] = []
    sensitive_detail = "postgresql://private-user:secret@db/app C:\\Private\\Music"

    def capture_exception(message, *args, **kwargs):
        logged_exceptions.append({
            "message": message,
            "args": args,
            "kwargs": kwargs,
            "detail": str(sys.exc_info()[1]),
        })

    task_logger = SimpleNamespace(**vars(logger), exception=capture_exception)

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def delegating_download_remote_cover_to_folder(*, write_cover_func, **kwargs):
        return cover_workflow.download_remote_cover_to_folder(
            **kwargs,
            write_cover_func=write_cover_func,
            fetch_remote_image_func=lambda *_args, **_kwargs: SimpleNamespace(
                payload=downloaded_cover_bytes,
            ),
        )

    def fail_persistence(*_args, **_kwargs):
        raise RuntimeError(sensitive_detail)

    def capture_apply(*args, **kwargs):
        apply_calls.append({"args": args, "kwargs": kwargs})
        raise AssertionError("Runtime state must not change after persistence fails")

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        delegating_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-persistence-failed",
        config,
        task_logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/new-cover.jpg",
            source="apple",
            source_label="Apple Music",
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=capture_apply,
        persist_cover_selection_for_tracks=fail_persistence,
    )

    assert canonical_cover.read_bytes() == prior_cover_bytes
    assert canonical_cover.stat().st_mtime_ns == prior_cover_timestamp_ns
    assert preexisting_reserve.read_bytes() == preexisting_reserve_bytes
    assert sorted(album_root.glob("cover-existing-*.jpg")) == [preexisting_reserve]
    assert apply_calls == []
    assert library_state == {}
    assert updates == [{
        "task_id": "task-save-persistence-failed",
        "status": "failed",
        "progress": 100,
        "progress_label": "Failed",
        "finished_at": updates[0]["finished_at"],
        "message": "Failed to save selected cover art.",
    }]
    assert sensitive_detail not in str(updates)
    assert logged_exceptions == [{
        "message": "Remote cover selection failed task_id=%s candidate_id=%s source=%s",
        "args": ("task-save-persistence-failed", "candidate-1", "apple"),
        "kwargs": {},
        "detail": sensitive_detail,
    }]


def test_downloaded_cover_persistence_failure_removes_new_cover_when_none_existed(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def delegating_download_remote_cover_to_folder(*, write_cover_func, **kwargs):
        return cover_workflow.download_remote_cover_to_folder(
            **kwargs,
            write_cover_func=write_cover_func,
            fetch_remote_image_func=lambda *_args, **_kwargs: SimpleNamespace(
                payload=_jpeg_bytes((30, 30, 220)),
            ),
        )

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        delegating_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-new-cover-persistence-failed",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/new-cover.jpg",
            source="apple",
            source_label="Apple Music",
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=lambda *args, **kwargs: apply_calls.append(
            {"args": args, "kwargs": kwargs}
        ),
        persist_cover_selection_for_tracks=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("postgresql://private-user:secret@db/app C:\\Private\\Music")
        ),
    )

    assert not (album_root / "cover.jpg").exists()
    assert list(album_root.glob("cover-existing-*.jpg")) == []
    assert apply_calls == []
    assert library_state == {}
    assert updates[0]["message"] == "Failed to save selected cover art."
    assert "secret" not in str(updates)
    assert "Private" not in str(updates)


def test_downloaded_cover_apply_failure_keeps_file_after_persistence_commits(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    prior_cover_bytes = _jpeg_bytes((220, 30, 30))
    downloaded_cover_bytes = _jpeg_bytes((30, 30, 220))
    canonical_cover = album_root / "cover.jpg"
    canonical_cover.write_bytes(prior_cover_bytes)
    persisted_cover_bytes: list[bytes] = []
    updates: list[dict[str, object]] = []
    sensitive_detail = "postgresql://private-user:secret@db/app C:\\Private\\Music"

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def delegating_download_remote_cover_to_folder(*, write_cover_func, **kwargs):
        return cover_workflow.download_remote_cover_to_folder(
            **kwargs,
            write_cover_func=write_cover_func,
            fetch_remote_image_func=lambda *_args, **_kwargs: SimpleNamespace(
                payload=downloaded_cover_bytes,
            ),
        )

    def record_persistence(_track_paths, *, cover_path, **_changes):
        persisted_cover_bytes.append(Path(cover_path).read_bytes())
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        delegating_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-apply-failed",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/new-cover.jpg",
            source="apple",
            source_label="Apple Music",
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError(sensitive_detail)
        ),
        persist_cover_selection_for_tracks=record_persistence,
    )

    assert len(persisted_cover_bytes) == 1
    assert canonical_cover.read_bytes() == persisted_cover_bytes[0]
    assert canonical_cover.read_bytes() != prior_cover_bytes
    reserve_paths = list(album_root.glob("cover-existing-*.jpg"))
    assert len(reserve_paths) == 1
    assert reserve_paths[0].read_bytes() == prior_cover_bytes
    assert library_state == {}
    assert updates[0]["message"] == "Failed to save selected cover art."
    assert sensitive_detail not in str(updates)


def test_fallback_download_with_multiple_new_reserves_rolls_back_and_releases_album_lock(
    config,
    logger,
    library_state,
    monkeypatch,
    tmp_path: Path,
):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    canonical_cover = album_root / "cover.jpg"
    preexisting_reserve = album_root / "cover-existing-1.jpg"
    first_new_reserve = album_root / "cover-existing-2.jpg"
    second_new_reserve = album_root / "cover-existing-3.jpg"
    prior_cover_bytes = _jpeg_bytes((220, 30, 30))
    prior_reserve_bytes = _jpeg_bytes((30, 220, 30))
    canonical_cover.write_bytes(prior_cover_bytes)
    preexisting_reserve.write_bytes(prior_reserve_bytes)
    prior_atime_ns = 1_700_000_000_123_456_700
    prior_mtime_ns = 1_700_000_100_765_432_100
    os.utime(canonical_cover, ns=(prior_atime_ns, prior_mtime_ns))
    updates: list[dict[str, object]] = []
    persistence_calls: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def fallback_download_remote_cover_to_folder(folder, image_url, user_agent):
        assert folder == album_root
        assert image_url == "https://images.example/new-cover.jpg"
        assert user_agent == config["MUSICBRAINZ_USER_AGENT"]
        canonical_cover.write_bytes(_jpeg_bytes((30, 30, 220)))
        first_new_reserve.write_bytes(_jpeg_bytes((40, 40, 210)))
        second_new_reserve.write_bytes(_jpeg_bytes((50, 50, 200)))
        return canonical_cover, {
            "reason": "cover_written",
            "written_path": str(canonical_cover),
        }

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fallback_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(
            updates,
            task_id,
            expected_config=config,
            **kwargs,
        ),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-multiple-reserves",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(
            id="candidate-1",
            url="https://images.example/new-cover.jpg",
            source="apple",
            source_label="Apple Music",
            art_kind="cover",
        ),
        apply_cover_selection_for_tracks=lambda *args, **kwargs: apply_calls.append(
            {"args": args, "kwargs": kwargs}
        ),
        persist_cover_selection_for_tracks=lambda *args, **kwargs: persistence_calls.append(
            {"args": args, "kwargs": kwargs}
        ),
    )

    subsequent_selection_completed = Event()
    selection_thread = Thread(
        target=lambda: cover_workflow.run_serialized_cover_selection(
            album_root,
            subsequent_selection_completed.set,
        ),
        daemon=True,
    )
    selection_thread.start()
    lock_was_released = subsequent_selection_completed.wait(timeout=0.5)

    restored_cover_stat = canonical_cover.stat()
    assert canonical_cover.read_bytes() == prior_cover_bytes
    assert restored_cover_stat.st_atime_ns == prior_atime_ns
    assert restored_cover_stat.st_mtime_ns == prior_mtime_ns
    assert preexisting_reserve.read_bytes() == prior_reserve_bytes
    assert sorted(album_root.glob("cover-existing-*.jpg")) == [preexisting_reserve]
    assert persistence_calls == []
    assert apply_calls == []
    assert library_state == {}
    assert updates == [{
        "task_id": "task-save-multiple-reserves",
        "status": "failed",
        "progress": 100,
        "progress_label": "Failed",
        "finished_at": updates[0]["finished_at"],
        "message": "Failed to save selected cover art.",
    }]
    assert lock_was_released
    selection_thread.join(timeout=0.5)
    assert not selection_thread.is_alive()


def test_run_cover_lookup_save_remote_task_accepts_non_numeric_album_subfolders(config, logger, library_state,
    monkeypatch,
    tmp_path: Path,
):
    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Artist" / "Album").resolve()
    first_track = (album_root / "LP 1" / "one.mp3").resolve()
    second_track = (album_root / "LP 2" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
    requested_track_paths = {str(first_track), str(second_track)}
    written_cover = album_root / "cover.jpg"
    updates: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []
    download_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    def fake_download_remote_cover_to_folder(**kwargs):
        download_calls.append(kwargs)
        written_cover.write_bytes(_jpeg_bytes())
        return written_cover, {"reason": "cover_written", "written_path": str(written_cover)}

    def fake_apply_cover_selection_for_tracks(track_paths, **changes):
        apply_calls.append({"track_paths": track_paths, "changes": changes})
        return [{"key": "album-1", "cover_path": str(written_cover)}], None

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fake_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-subfolders",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert download_calls == [{
        "folder": album_root,
        "image_url": "https://images.example/cover.jpg",
        "user_agent": config["MUSICBRAINZ_USER_AGENT"],
    }]
    assert apply_calls == [{
        "track_paths": requested_track_paths,
        "changes": {"cover_path": written_cover},
    }]
    assert updates == [
        {
            "task_id": "task-save-subfolders",
            "status": "completed",
            "progress": 100,
            "progress_label": "Completed",
            "finished_at": updates[0]["finished_at"],
            "selected_candidate_id": "candidate-1",
            "notification_action_taken": True,
            "message": "Selected cover art saved.",
            "result_kind": "cover-updated",
            "updated_albums": [{"key": "album-1", "cover_path": str(written_cover)}],
            "updated_problematic_album": None,
        }
    ]


def test_run_cover_lookup_save_remote_task_reports_download_failure_without_applying_cover(config, logger, library_state, monkeypatch, tmp_path: Path):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        lambda **kwargs: (None, {"reason": "candidate_download_failed"}),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    def fail_apply_cover_selection_for_tracks(*_args, **_kwargs):
        raise AssertionError("Failed remote downloads must not update album cover state")

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-failed",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/missing.jpg"),
        apply_cover_selection_for_tracks=fail_apply_cover_selection_for_tracks,
    )

    assert updates == [
        {
            "task_id": "task-save-failed",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "candidate_download_failed",
        }
    ]


def test_run_cover_lookup_save_remote_task_reports_write_no_file_without_applying_cover(config, logger, library_state, monkeypatch, tmp_path: Path):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        lambda **kwargs: (None, {"reason": "write_returned_no_file"}),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    def fail_apply_cover_selection_for_tracks(*_args, **_kwargs):
        raise AssertionError("Remote write failures must not update album cover state")

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-write-failed",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=fail_apply_cover_selection_for_tracks,
    )

    assert updates == [
        {
            "task_id": "task-save-write-failed",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "write_returned_no_file",
        }
    ]


def test_run_cover_lookup_save_remote_task_rejects_mismatched_album_root_before_download(config, logger, library_state,
    monkeypatch,
    tmp_path: Path,
):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    outside_root = (tmp_path / "outside" / "Artist" / "Album").resolve()
    requested_track_paths = {str(track_path)}
    updates: list[dict[str, object]] = []
    download_calls: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(config["MUSIC_DIR"]),
                "layout_mode": "artist",
            }],
        },
    )

    def fake_download_remote_cover_to_folder(**kwargs):
        download_calls.append(kwargs)
        outside_root.mkdir(parents=True, exist_ok=True)
        written = outside_root / "cover.jpg"
        written.write_bytes(_jpeg_bytes())
        return written, {"reason": "cover_written", "written_path": str(written)}

    def fake_apply_cover_selection_for_tracks(track_paths, **changes):
        apply_calls.append({"track_paths": track_paths, "changes": changes})
        return [{"key": "album-1"}], None

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fake_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-unsafe-root",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        outside_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert download_calls == []
    assert apply_calls == []
    assert not (outside_root / "cover.jpg").exists()
    assert updates == [
        {
            "task_id": "task-save-unsafe-root",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "Album root could not be resolved",
        }
    ]


def test_run_cover_lookup_save_remote_task_rejects_cross_root_common_parent_before_download(config, logger, library_state,
    monkeypatch,
    tmp_path: Path,
):
    main_root = (tmp_path / "ConfiguredA").resolve()
    sibling_root = (tmp_path / "ConfiguredB").resolve()
    first_track = (main_root / "Artist" / "Album" / "one.mp3").resolve()
    second_track = (sibling_root / "Artist" / "Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
    requested_track_paths = {str(first_track), str(second_track)}
    unsafe_shared_parent = tmp_path.resolve()
    updates: list[dict[str, object]] = []
    download_calls: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [
                {
                    "id": "main-1",
                    "path": str(main_root),
                    "layout_mode": "artist",
                },
                {
                    "id": "main-2",
                    "path": str(sibling_root),
                    "layout_mode": "artist",
                },
            ],
        },
    )

    def fake_download_remote_cover_to_folder(**kwargs):
        download_calls.append(kwargs)
        written = unsafe_shared_parent / "cover.jpg"
        written.write_bytes(_jpeg_bytes())
        return written, {"reason": "cover_written", "written_path": str(written)}

    def fake_apply_cover_selection_for_tracks(track_paths, **changes):
        apply_calls.append({"track_paths": track_paths, "changes": changes})
        return [{"key": "album-1"}], None

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fake_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-cross-root",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        unsafe_shared_parent,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert download_calls == []
    assert apply_calls == []
    assert not (unsafe_shared_parent / "cover.jpg").exists()
    assert updates == [
        {
            "task_id": "task-save-cross-root",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "Album root could not be resolved",
        }
    ]


def test_run_cover_lookup_save_remote_task_rejects_same_root_mixed_album_folders_before_download(config, logger, library_state,
    monkeypatch,
    tmp_path: Path,
):
    library_root = (tmp_path / "Library").resolve()
    first_track = (library_root / "Artist" / "First Album" / "one.mp3").resolve()
    second_track = (library_root / "Artist" / "Second Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
    requested_track_paths = {str(first_track), str(second_track)}
    unsafe_shared_parent = (library_root / "Artist").resolve()
    updates: list[dict[str, object]] = []
    download_calls: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(library_root),
                "layout_mode": "artist",
            }],
        },
    )

    def fake_download_remote_cover_to_folder(**kwargs):
        download_calls.append(kwargs)
        written = unsafe_shared_parent / "cover.jpg"
        written.write_bytes(_jpeg_bytes())
        return written, {"reason": "cover_written", "written_path": str(written)}

    def fake_apply_cover_selection_for_tracks(track_paths, **changes):
        apply_calls.append({"track_paths": track_paths, "changes": changes})
        return [{"key": "album-1"}], None

    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fake_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "update_cover_lookup_task",
        lambda task_id, **kwargs: _capture_task_update(updates, task_id, expected_config=config, **kwargs),
    )

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        "task-save-mixed-album",
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        unsafe_shared_parent,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=fake_apply_cover_selection_for_tracks,
    )

    assert download_calls == []
    assert apply_calls == []
    assert not (unsafe_shared_parent / "cover.jpg").exists()
    assert not (first_track.parent / "cover.jpg").exists()
    assert not (second_track.parent / "cover.jpg").exists()
    assert updates == [
        {
            "task_id": "task-save-mixed-album",
            "status": "failed",
            "progress": 100,
            "progress_label": "Failed",
            "finished_at": updates[0]["finished_at"],
            "message": "Album root could not be resolved",
        }
    ]


def test_candidate_lookup_publishes_partial_and_final_phase_metrics(config, logger, monkeypatch):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    album = _album_payload(track_path)
    requested_track_paths = {str(track_path)}
    task_id, cancel_event = cover_lookup_tasks.create_cover_lookup_task(album, requested_track_paths)
    published_snapshots: list[dict[str, object]] = []
    clock_value = 0.0

    def deterministic_perf_counter():
        nonlocal clock_value
        clock_value += 0.001
        return clock_value

    original_publish = cover_lookup_runtime._publish_candidate_runtime_phase_metrics

    def capture_publish(task_id, **kwargs):
        original_publish(task_id, **kwargs)
        published_snapshots.append(cover_lookup_tasks.cover_lookup_result(task_id))

    monkeypatch.setattr(cover_lookup_runtime.time, "perf_counter", deterministic_perf_counter)
    monkeypatch.setattr(cover_lookup_runtime, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_lookup_runtime, "discard_cover_lookup_future", lambda _task_id: None)
    monkeypatch.setattr(cover_lookup_runtime, "_publish_candidate_runtime_phase_metrics", capture_publish)
    provider_registry = _FakeCoverLookupProviderRegistry(
        service_matches=[{
            "id": "service-1",
            "source": "apple",
            "url": "https://images.example/service.jpg",
        }],
        manual_matches=[],
        bandcamp_matches=[],
        discogs_archive_matches=([], []),
    )
    monkeypatch.setattr(
        cover_lookup_runtime,
        "COVER_LOOKUP_PROVIDER_REGISTRY",
        provider_registry,
    )

    cover_lookup_runtime._run_cover_lookup_task(
        task_id,
        config,
        logger,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album,
        requested_track_paths,
        cancel_event,
    )

    assert len(published_snapshots) >= 3
    partial_snapshot = published_snapshots[0]
    final_snapshot = published_snapshots[-1]
    _assert_runtime_phase_shapes(partial_snapshot)
    _assert_runtime_phase_shapes(final_snapshot)
    assert partial_snapshot["status"] == "running"
    assert partial_snapshot["phase_counts"]["persistence"] >= 1
    assert final_snapshot["status"] == "completed"
    assert final_snapshot["result_kind"] == "possible-matches"
    assert final_snapshot["phase_counts"]["discovery"] > 0
    assert final_snapshot["phase_counts"]["scoring"] > 0
    assert final_snapshot["phase_counts"]["persistence"] > partial_snapshot["phase_counts"]["persistence"]
    assert final_snapshot["phase_counts"]["fetch"] == 0
    assert final_snapshot["phase_timings_ms"]["discovery"] > 0
    assert final_snapshot["phase_timings_ms"]["scoring"] > 0
    assert final_snapshot["phase_timings_ms"]["persistence"] > 0
    assert final_snapshot["phase_timings_ms"]["fetch"] == 0
    assert len(provider_registry.discogs_archive_should_cancel) == 1
    forwarded_predicate = provider_registry.discogs_archive_should_cancel[0]
    assert callable(forwarded_predicate)
    assert getattr(forwarded_predicate, "__self__", None) is cancel_event
    assert forwarded_predicate() is False


def test_successful_remote_save_publishes_fetch_and_persistence_phase_metrics(config, logger, library_state, monkeypatch, tmp_path: Path):
    album_root = (tmp_path / "Album").resolve()
    track_path = album_root / "song.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    requested_track_paths = {str(track_path)}
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        requested_track_paths,
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        phase_timings_ms={
            "discovery": 12.5,
            "fetch": 0.0,
            "scoring": 4.5,
            "persistence": 1.5,
        },
        phase_counts={
            "discovery": 3,
            "fetch": 0,
            "scoring": 3,
            "persistence": 2,
        },
    )
    written_cover = album_root / "cover.jpg"
    published_snapshots: list[dict[str, object]] = []
    clock_value = 0.0
    save_library_root_settings(
        config,
        {
            "main_library_roots": [{
                "id": "main-1",
                "path": str(tmp_path),
                "layout_mode": "album-at-root",
            }],
        },
    )

    def deterministic_perf_counter():
        nonlocal clock_value
        clock_value += 0.002
        return clock_value

    def fake_download_remote_cover_to_folder(**_kwargs):
        written_cover.write_bytes(_jpeg_bytes())
        return written_cover, {"reason": "cover_written"}

    original_publish = cover_lookup_runtime._publish_save_runtime_phase_metrics

    def capture_publish(task_id, **kwargs):
        original_publish(task_id, **kwargs)
        published_snapshots.append(cover_lookup_tasks.cover_lookup_result(task_id))

    monkeypatch.setattr(cover_lookup_runtime.time, "perf_counter", deterministic_perf_counter)
    monkeypatch.setattr(
        cover_lookup_runtime,
        "download_remote_cover_to_folder",
        fake_download_remote_cover_to_folder,
    )
    monkeypatch.setattr(cover_lookup_runtime, "_publish_save_runtime_phase_metrics", capture_publish)

    cover_lookup_runtime._run_cover_lookup_save_remote_task(
        task_id,
        config,
        logger,
        library_state,
        str(config["MUSICBRAINZ_USER_AGENT"]),
        album_root,
        requested_track_paths,
        "candidate-1",
        SelectedRemoteImage(id="candidate-1", url="https://images.example/cover.jpg"),
        apply_cover_selection_for_tracks=lambda _track_paths, **_changes: ([{"key": "album-1"}], None),
    )

    assert len(published_snapshots) == 1
    final_snapshot = published_snapshots[0]
    _assert_runtime_phase_shapes(final_snapshot)
    assert final_snapshot["status"] == "completed"
    assert final_snapshot["result_kind"] == "cover-updated"
    assert final_snapshot["phase_counts"]["discovery"] == 3
    assert final_snapshot["phase_counts"]["scoring"] == 3
    assert final_snapshot["phase_counts"]["fetch"] == 1
    assert final_snapshot["phase_counts"]["persistence"] == 3
    assert final_snapshot["phase_timings_ms"]["discovery"] == 12.5
    assert final_snapshot["phase_timings_ms"]["scoring"] == 4.5
    assert final_snapshot["phase_timings_ms"]["fetch"] > 0
    assert final_snapshot["phase_timings_ms"]["persistence"] > 1.5
