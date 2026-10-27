from __future__ import annotations

from music_app.services.log_history import HistoryScope

import asyncio
import base64
from copy import deepcopy
import hashlib
import io
import importlib
from pathlib import Path
from threading import Event, Timer
from types import SimpleNamespace
from uuid import UUID

from fastapi import FastAPI
import pytest

from music_app.services.cover_lookup_tasks import (
    list_cover_lookup_tasks,
    reset_cover_lookup_runtime_state,
)
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    cover_candidate_to_lookup_match,
)
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import decode_json as _decode_json
from tests.py.asgi_testing import collect_route_methods as _collect_route_methods
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import run_asgi_request as _run_asgi_request
from tests.py.asgi_testing import run_asgi_request_async as _run_asgi_request_async
from tests.py.asgi_testing import runtime_app_from_asgi_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


@pytest.fixture(autouse=True)
def postgres_runtime_fakes(app, monkeypatch):
    from music_app.services.library_roots import normalize_library_root_settings

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    persisted_notifications: list[dict[str, object]] = []
    persisted_root_settings = normalize_library_root_settings(
        {},
        fallback_main_root=Path(app.config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )

    class FakeCoverLookupTasksPostgresAdapter:
        def __init__(self, _config):
            pass

        def load_notifications(self):
            return list(persisted_notifications)

        def load_notification(self, task_id):
            return next(
                (
                    dict(task)
                    for task in persisted_notifications
                    if str(task.get("id") or "") == str(task_id or "")
                ),
                None,
            )

        def count_notifications(self):
            active_count = sum(
                1 for task in persisted_notifications if task.get("status") in {"pending", "running"}
            )
            return {
                "total_count": len(persisted_notifications),
                "active_count": active_count,
                "finished_count": len(persisted_notifications) - active_count,
            }

        def load_notification_summary_page(self, *, limit, cursor, active_only):
            if cursor is not None:
                raise ValueError("invalid cover lookup notification cursor")
            from music_app.services.cover_lookup_tasks import list_cover_lookup_tasks

            items = list_cover_lookup_tasks(config=app.config)
            if active_only:
                items = [task for task in items if task.get("status") in {"pending", "running"}]
            return {
                "items": items[:limit],
                "next_cursor": None,
                "counts": self.count_notifications(),
            }

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

    class FakeAlbumCoverCandidateSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            return 41 if track_paths else None

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            return None

        def mark_seen(self, *, album_id):
            assert album_id == 41
            return None

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
    monkeypatch.setattr(
        "music_app.routes.api_wave_d_asgi_routes.AlbumCoverCandidateSnapshotRepository",
        FakeAlbumCoverCandidateSnapshotRepository,
    )
    app.config["PERSISTENCE_BACKENDS"] = {
        **dict(app.config.get("PERSISTENCE_BACKENDS") or {}),
        "cover_lookup_tasks": "postgres",
        "library_roots": "postgres",
    }
    app.config["_TEST_COVER_LOOKUP_NOTIFICATIONS"] = persisted_notifications


def _make_wave_d_app(flask_app):
    from music_app.routes.api_wave_d_asgi_routes import router

    asgi_app = FastAPI()
    from tests.py.asgi_testing import configure_test_bootstrap_actor
    configure_test_bootstrap_actor(asgi_app)
    asgi_app.state.flask_app = flask_app
    asgi_app.state.config = flask_app.config
    asgi_app.state.library_state = flask_app.library_state
    asgi_app.state.logger = flask_app.logger
    asgi_app.include_router(router)
    return asgi_app


class _FatalFlaskBridge:
    def __init__(self, reason: str = "route must not use Flask bridge"):
        self._reason = reason

    @property
    def config(self):
        raise AssertionError(self._reason)

    @property
    def logger(self):
        raise AssertionError(self._reason)

    def app_context(self):
        raise AssertionError(self._reason)


def test_asgi_wave_d_routes_register_natively(asgi_app):
    route_paths = _collect_route_paths(asgi_app)
    for route_path in (
        "/utilities/cover-lookup/tasks",
        "/utilities/cover-lookup/tasks/clear-completed",
        "/utilities/cover-lookup/task/{task_id}/clear",
        "/utilities/cover-lookup/task/{task_id}/mark-action-taken",
        "/utilities/cover-lookup/gallery",
        "/utilities/cover-lookup/gallery/mark-seen",
        "/utilities/cover-lookup/start",
        "/utilities/cover-lookup/task/{task_id}/cancel",
        "/utilities/cover-lookup/local-select",
        "/utilities/cover-lookup/local-delete",
        "/utilities/cover-lookup/pasted-image-save",
        "/utilities/cover-lookup/save-remote",
        "/utilities/cover-lookup/add-remote",
        "/utilities/cover-lookup/remote-image",
        "/utilities/fetch-cover",
        "/utilities/fetch-covers-unsuccessful",
        "/utilities/cancel-cover-scan",
    ):
        assert route_path in route_paths


def _album_payload(track_path: Path) -> dict[str, object]:
    return {
        "name": "Test Album",
        "album_artist": "Test Artist",
        "year": 2001,
        "edition": "",
        "tracks": [{"path": str(track_path)}],
    }


def _seed_album_state(library_state: dict[str, object], track_path: Path) -> None:
    track = SimpleNamespace(
        path=str(track_path),
        title="Song",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Test Artist",
        album="Test Album",
        album_artist="Test Artist",
        year="2001",
        release_date=None,
        edition="",
        album_rating=0,
        exception_type=None,
        duration_seconds=0,
        cover_path=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
    )
    album = SimpleNamespace(
        key="album-1",
        name="Test Album",
        album_artist="Test Artist",
        artists=["Test Artist"],
        cover_path=None,
        remote_cover_url=None,
        remote_cover_thumbnail_url=None,
        remote_cover_source=None,
        remote_cover_source_label=None,
        remote_cover_album_url=None,
        remote_cover_width=None,
        remote_cover_height=None,
        year="2001",
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[track],
        is_compilation=False,
    )
    library_state["albums"] = [album]
    library_state["file_cache"] = {
        str(track_path): {
            "path": str(track_path),
            "album": "Test Album",
            "album_artist": "Test Artist",
            "artist": "Test Artist",
            "cover_path": None,
        }
    }


def _jpeg_bytes(color: tuple[int, int, int], *, size: tuple[int, int] = (12, 12)) -> bytes:
    image_module = importlib.import_module("music_app.services.covers").Image
    assert image_module is not None
    buffer = io.BytesIO()
    image_module.new("RGB", size, color).save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


def _jpeg_data_url(color: tuple[int, int, int], *, size: tuple[int, int] = (12, 12)) -> str:
    return f"data:image/jpeg;base64,{base64.b64encode(_jpeg_bytes(color, size=size)).decode('ascii')}"


def test_asgi_wave_d_router_exports_cover_endpoint_urls_and_methods(app):
    asgi_app = _make_wave_d_app(app)

    route_methods = _collect_route_methods(asgi_app)

    assert route_methods["/utilities/cover-lookup/tasks"] == {"GET"}
    assert route_methods["/utilities/cover-lookup/tasks/clear-completed"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/task/{task_id}/clear"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/task/{task_id}/mark-action-taken"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/gallery"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/gallery/mark-seen"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/start"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/task/{task_id}/cancel"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/local-select"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/local-delete"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/pasted-image-save"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/save-remote"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/add-remote"] == {"POST"}
    assert route_methods["/utilities/cover-lookup/remote-image"] == {"GET"}
    assert route_methods["/utilities/fetch-cover"] == {"POST"}
    assert route_methods["/utilities/fetch-covers-unsuccessful"] == {"POST"}
    assert route_methods["/utilities/cancel-cover-scan"] == {"POST"}


def test_asgi_cover_lookup_notification_counts_and_page_contract(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    page_calls = []
    monkeypatch.setattr(
        asgi_routes,
        "count_cover_lookup_task_notifications",
        lambda *, config: {"total_count": 528, "active_count": 2, "finished_count": 526},
    )

    def fake_page(*, limit, cursor, active_only, config):
        page_calls.append((limit, cursor, active_only, config))
        if cursor == "bad-cursor":
            raise ValueError("invalid cover lookup notification cursor")
        return {
            "items": [{"id": "task-528"}],
            "next_cursor": "next-page",
            "counts": {
                "total_count": 528,
                "active_count": 2,
                "finished_count": 526,
            },
        }

    monkeypatch.setattr(asgi_routes, "load_cover_lookup_task_summary_page", fake_page)
    asgi_app = _make_wave_d_app(app)

    count_status, _count_headers, count_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks/counts",
    )
    page_status, _page_headers, page_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks",
        query={"limit": 75, "cursor": "page-1", "active_only": "true"},
    )
    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks",
        query={"cursor": "bad-cursor"},
    )

    assert count_status == 200
    assert _decode_json(count_body) == {
        "ok": True,
        "total_count": 528,
        "active_count": 2,
        "finished_count": 526,
    }
    assert page_status == 200
    assert _decode_json(page_body) == {
        "ok": True,
        "tasks": [{"id": "task-528"}],
        "next_cursor": "next-page",
        "total_count": 528,
        "active_count": 2,
        "finished_count": 526,
    }
    assert page_calls[0][:3] == (50, "page-1", True)
    assert invalid_status == 400
    assert _decode_json(invalid_body) == {
        "ok": False,
        "error": "Invalid cover lookup notification cursor",
    }


def test_cover_lookup_notification_reads_use_threadpool_boundary(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    inside_threadpool = False
    threadpool_calls = []

    async def fake_run_in_threadpool(function, *args, **kwargs):
        nonlocal inside_threadpool
        threadpool_calls.append(function)
        inside_threadpool = True
        try:
            return function(*args, **kwargs)
        finally:
            inside_threadpool = False

    def fake_counts(*, config):
        assert inside_threadpool, "notification counts must not block the ASGI event loop"
        return {"total_count": 1, "active_count": 0, "finished_count": 1}

    def fake_page(*, limit, cursor, active_only, config):
        assert inside_threadpool, "notification history must not block the ASGI event loop"
        return {
            "items": [{"id": "task-1"}],
            "next_cursor": None,
            "counts": {"total_count": 1, "active_count": 0, "finished_count": 1},
        }

    def fake_unpaged(*, config):
        assert inside_threadpool, "legacy notification history must not block the ASGI event loop"
        return [{"id": "legacy-task"}]

    monkeypatch.setattr(asgi_routes, "run_in_threadpool", fake_run_in_threadpool)
    monkeypatch.setattr(asgi_routes, "count_cover_lookup_task_notifications", fake_counts)
    monkeypatch.setattr(asgi_routes, "load_cover_lookup_task_summary_page", fake_page)
    monkeypatch.setattr(asgi_routes, "list_cover_lookup_task_summaries", fake_unpaged)
    asgi_app = _make_wave_d_app(app)

    count_status, _count_headers, _count_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks/counts",
    )
    page_status, _page_headers, _page_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks",
        query={"limit": 50},
    )
    legacy_status, _legacy_headers, _legacy_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks",
    )

    assert count_status == 200
    assert page_status == 200
    assert legacy_status == 200
    assert threadpool_calls == [
        asgi_routes.count_cover_lookup_task_notifications,
        asgi_routes.load_cover_lookup_task_summary_page,
        asgi_routes.list_cover_lookup_task_summaries,
    ]


def test_asgi_cover_lookup_notification_page_preserves_each_album_payload(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    items = [
        {
            "id": "angels-task",
            "album": "Ангелы",
            "album_payload": {
                "album_id": 41,
                "key": "black-obelisk::angels::2005",
                "cover_preview_url": "/cover?path=angels&v=one",
            },
        },
        {
            "id": "garip-task",
            "album": "Garip",
            "album_payload": {
                "album_id": 84,
                "key": "altin-gun::garip::2026",
                "cover_preview_url": "/cover?path=garip&v=two",
            },
        },
        {
            "id": "revelations-task",
            "album": "Revelations of Divine Love",
            "album_payload": {
                "album_id": 126,
                "key": "susanne-sundfor::revelations::2026",
                "cover_preview_url": "/cover?path=revelations&v=three",
            },
        },
    ]
    monkeypatch.setattr(
        asgi_routes,
        "load_cover_lookup_task_summary_page",
        lambda **_kwargs: {
            "items": items,
            "next_cursor": None,
            "counts": {"total_count": 3, "active_count": 0, "finished_count": 3},
        },
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "GET",
        "/utilities/cover-lookup/tasks",
        query={"limit": 50},
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["tasks"] == items
    assert [task["album_payload"]["album_id"] for task in payload["tasks"]] == [
        41,
        84,
        126,
    ]
    assert len({task["album_payload"]["cover_preview_url"] for task in payload["tasks"]}) == 3


@pytest.mark.parametrize("operation", ["clear", "mark-action-taken", "cancel"])
def test_asgi_stale_cover_notification_id_returns_only_not_found_and_preserves_other_tasks(app, operation):
    from music_app.services import cover_lookup_tasks

    reset_cover_lookup_runtime_state()
    track_path = (app.config["MUSIC_DIR"] / "Private Artist" / "Private Album" / "song.mp3").resolve()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    before = deepcopy(cover_lookup_tasks.cover_lookup_result(task_id))
    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        f"/utilities/cover-lookup/task/removed-notification/{operation}",
    )
    assert status == 404
    assert _decode_json(body) == {"ok": False, "error": "Lookup task not found"}
    assert cover_lookup_tasks.cover_lookup_result(task_id) == before


def test_asgi_cover_lookup_task_list_mark_clear_and_cancel(app):
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    reset_cover_lookup_runtime_state()
    completed_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    unreviewed_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cancel_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(completed_id, status="completed")
    cover_lookup_tasks.update_cover_lookup_task(unreviewed_id, status="completed")

    asgi_app = _make_wave_d_app(app)
    list_status, _list_headers, list_body = _run_asgi_request(asgi_app, "GET", "/utilities/cover-lookup/tasks")
    mark_status, _mark_headers, mark_body = _run_asgi_request(
        asgi_app,
        "POST",
        f"/utilities/cover-lookup/task/{completed_id}/mark-action-taken",
        json_body={},
    )
    clear_status, _clear_headers, clear_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/tasks/clear-completed",
        json_body={},
    )
    cancel_status, _cancel_headers, cancel_body = _run_asgi_request(
        asgi_app,
        "POST",
        f"/utilities/cover-lookup/task/{cancel_id}/cancel",
    )

    assert list_status == 200
    assert {item["id"] for item in _decode_json(list_body)["tasks"]}.issuperset({completed_id, cancel_id})
    assert mark_status == 200
    assert _decode_json(mark_body)["task"]["notification_action_taken"] is True
    assert clear_status == 200
    assert _decode_json(clear_body)["removed_count"] == 1
    assert unreviewed_id in {item["id"] for item in _decode_json(clear_body)["tasks"]}
    assert cancel_status == 200
    canceled = _decode_json(cancel_body)["task"]
    assert canceled["id"] == cancel_id
    assert canceled["status"] == "canceled"
    assert canceled["cancel_requested"] is True


def test_asgi_cover_lookup_notification_routes_use_asgi_config_without_flask_bridge(app):
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    notifications_path = Path(app.config["DATA_DIR"]) / "cover_lookup_notifications.json"
    notifications_path.parent.mkdir(parents=True, exist_ok=True)
    notifications_path.write_text(
        '{"tasks":[{"id":"stale-file-task","status":"completed"}]}',
        encoding="utf-8",
    )
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        finished_at="2026-05-18T01:30:00+00:00",
        config=app.config,
    )
    reset_cover_lookup_runtime_state()
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge("notification routes must use ASGI config")

    list_status, _list_headers, list_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/tasks",
    )
    mark_status, _mark_headers, mark_body = _run_asgi_request(
        asgi_app,
        "POST",
        f"/utilities/cover-lookup/task/{task_id}/mark-action-taken",
        json_body={},
    )
    clear_status, _clear_headers, clear_body = _run_asgi_request(
        asgi_app,
        "POST",
        f"/utilities/cover-lookup/task/{task_id}/clear",
        json_body={},
    )

    assert list_status == 200
    assert [item["id"] for item in _decode_json(list_body)["tasks"]] == [task_id]
    assert mark_status == 200
    assert _decode_json(mark_body)["task"]["notification_action_taken"] is True
    assert clear_status == 200
    assert _decode_json(clear_body)["removed_count"] == 1
    assert app.config["_TEST_COVER_LOOKUP_NOTIFICATIONS"] == []
    assert notifications_path.read_text(encoding="utf-8") == (
        '{"tasks":[{"id":"stale-file-task","status":"completed"}]}'
    )


def test_asgi_cover_lookup_gallery_validation_and_start_queue(app, monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths",
        lambda _self, _paths: {},
    )
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    (track_path.parent / "cover.jpg").write_bytes(b"cover")
    queued_calls: list[dict[str, object]] = []
    logged_events: list[dict[str, object]] = []

    def fake_queue_cover_lookup_task(album, requested_track_paths, manual_urls, **kwargs):
        queued_calls.append(
            {
                "requested_track_paths": requested_track_paths,
                "manual_urls": manual_urls,
                "config": kwargs.get("config"),
                "logger": kwargs.get("logger"),
                "user_agent": kwargs.get("user_agent"),
            }
        )
        task_id, _cancel_event = cover_lookup_tasks.create_cover_lookup_task(
            album,
            requested_track_paths,
            manual_urls,
        )
        return task_id

    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_task", fake_queue_cover_lookup_task)
    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: pytest.fail("search-only lookup must not mutate cover ownership"),
    )

    def fake_log_app_event(config, logger, message, **kwargs):
        logged_events.append(
            {
                "config": config,
                "logger": logger,
                "message": message,
                "level": kwargs.get("level"),
            }
        )

    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)
    reset_cover_lookup_runtime_state()
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": "nope"},
    )
    start_status, _start_headers, start_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/start",
        json_body={
            "album": _album_payload(track_path),
            "manual_urls": [" https://covers.example/one.jpg ", "", None],
        },
    )
    gallery_status, _gallery_headers, gallery_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": _album_payload(track_path)},
    )
    assert invalid_status == 400
    assert _decode_json(invalid_body) == {"ok": False, "error": "Invalid album payload"}
    assert start_status == 200
    payload = _decode_json(start_body)
    assert payload["ok"] is True
    assert payload["task"]["status"] == "pending"
    assert payload["task"]["job_contract"]["job_kind"] == "candidate_lookup"
    assert payload["task"]["job_contract"]["provider_groups"] == [
        "music_services",
        "manual_urls",
        "bandcamp",
        "cover_art_archive",
        "discogs",
        "artist_website_fallback",
    ]
    assert payload["task"]["manual_urls"] == ["https://covers.example/one.jpg"]
    assert "gallery" not in payload
    assert gallery_status == 200
    gallery_payload = _decode_json(gallery_body)
    assert gallery_payload["ok"] is True
    assert gallery_payload["album_root"] == str(track_path.parent)
    assert gallery_payload["task"] is None
    assert queued_calls == [
        {
            "requested_track_paths": {str(track_path)},
            "manual_urls": ["https://covers.example/one.jpg"],
            "config": app.config,
            "logger": asgi_app.state.logger if hasattr(asgi_app.state, "logger") else asgi_routes.LOGGER,
            "user_agent": app.config["MUSICBRAINZ_USER_AGENT"],
        }
    ]
    assert logged_events == [
        {
            "config": app.config,
            "logger": asgi_app.state.logger,
            "message": "Cover lookup task queued",
            "level": "info",
        }
    ]


def test_asgi_cover_lookup_local_cover_actions_update_asgi_state_without_flask_bridge(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cache as cache_module

    revision_loads: list[int] = []
    snapshot_saves: list[int | None] = []

    class FakeScanCacheAdapter:
        def load_cover_mutation_revision(self):
            revision_loads.append(0)
            return 0

        def load_snapshot(self, _cache_path, _root_identity):
            return (
                {
                    path: dict(entry)
                    for path, entry in app.library_state["file_cache"].items()
                },
                0.0,
                {},
                0.0,
                None,
            )

        def save_snapshot(
            self,
            _cache_path,
            _file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            **_kwargs,
        ):
            snapshot_saves.append(expected_cover_mutation_revision)

    class CompletedFuture:
        def exception(self):
            return None

        def add_done_callback(self, callback):
            callback(self)

    class InlineExecutor:
        def submit(self, callback, *args, **kwargs):
            callback(*args, **kwargs)
            return CompletedFuture()

    fake_adapter = FakeScanCacheAdapter()
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: fake_adapter,
    )
    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", InlineExecutor())

    monkeypatch.setattr("music_app.services.problematic_albums.load_ignored_repair_keys", lambda _config: set())
    monkeypatch.setattr("music_app.services.problematic_albums.load_separate_release_keys", lambda _config: set())
    persisted_origins: list[tuple[str, str | None]] = []

    def persist_user_cover(_track_paths, cover_path, **kwargs):
        persisted_origins.append(
            (str(cover_path) if cover_path else "", kwargs.get("cover_selection_origin"))
        )
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    monkeypatch.setattr(asgi_routes, "persist_cover_selection_for_tracks", persist_user_cover)
    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "selected.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    fallback_image = track_path.parent / "fallback.jpg"
    fallback_image.write_bytes(_jpeg_bytes((220, 160, 30)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    select_status, _select_headers, select_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )
    selected_cover_path = str(track_path.parent / "cover.jpg")

    assert select_status == 200
    select_payload = _decode_json(select_body)
    assert select_payload["selected_cover_path"] == selected_cover_path
    assert "gallery" not in select_payload
    assert asgi_app.state.library_state["file_cache"][str(track_path)]["cover_path"] == selected_cover_path

    delete_status, _delete_headers, delete_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": selected_cover_path},
    )

    assert delete_status == 200
    delete_payload = _decode_json(delete_body)
    next_cover_path = asgi_app.state.library_state["file_cache"][str(track_path)]["cover_path"]
    assert next_cover_path
    assert next_cover_path != selected_cover_path
    assert delete_payload["gallery"]["active_cover_path"] == next_cover_path

    from music_app.services import library_browse_postgres

    hydrated_entry = dict(asgi_app.state.library_state["file_cache"][str(track_path)])
    hydrated_entry["title"] = "Song"
    hydrated_album = _album_payload(track_path)

    class FakePostgresLibraryBrowseRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def build_album_payloads_by_track_paths(self, track_paths):
            assert track_paths == {str(track_path)}
            return [hydrated_album]

        def build_track_file_entries_by_paths(self, track_paths):
            assert track_paths == {str(track_path)}
            return {str(track_path): hydrated_entry}

    monkeypatch.setattr(
        library_browse_postgres,
        "PostgresLibraryBrowseRepository",
        FakePostgresLibraryBrowseRepository,
    )
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://fixture"
    asgi_app.state.library_state["file_cache"] = {}
    asgi_app.state.library_state["albums"] = []

    pasted_status, _pasted_headers, pasted_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/pasted-image-save",
        json_body={"album": _album_payload(track_path), "data_url": _jpeg_data_url((20, 40, 220))},
    )

    assert pasted_status == 200
    pasted_payload = _decode_json(pasted_body)
    assert pasted_payload["selected_cover_path"] == selected_cover_path
    pasted_revision = pasted_payload["cover_revision"]
    assert pasted_revision
    assert pasted_payload["gallery"]["active_cover_path"] == selected_cover_path
    assert pasted_payload["updated_album"]["cover_revision"] == pasted_revision
    assert asgi_app.state.library_state["file_cache"][str(track_path)]["cover_path"] == selected_cover_path
    assert asgi_app.state.library_state["file_cache"][str(track_path)]["cover_revision"] == pasted_revision
    assert revision_loads
    assert snapshot_saves
    assert set(snapshot_saves) == {0}
    assert persisted_origins == [
        (selected_cover_path, "user"),
        (next_cover_path, "user"),
        (selected_cover_path, "user"),
    ]


def test_asgi_cover_lookup_gallery_rehydrates_compact_notification_album(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    hydrated_album_ids = []

    def build_album_detail(*_args, **_kwargs):
        raise AssertionError("Cover Lookup must not build the global album-detail projection")

    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_album_detail_payload_by_id",
        build_album_detail,
    )
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_cover_state_entries_by_paths",
        lambda _self, _paths: {},
    )
    snapshot_reads = []

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_track_context(self, *, album_id, album_key):
            hydrated_album_ids.append(album_id)
            assert album_key is None or album_key == "test artist::test album"
            return {
                "album_id": 41,
                "album_key": "test artist::test album",
                "track_paths": [str(track_path)],
            }

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            snapshot_reads.append(album_id)
            return None

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={
            "album": {
                "id": 41,
                "name": "Test Album",
                "album_artist": "Test Artist",
                "year": 2001,
                "edition": "",
            }
        },
    )

    assert status == 200
    assert _decode_json(body)["album_root"] == str(track_path.parent)

    key_status, _key_headers, key_body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={
            "album": {
                "key": "test artist::test album",
                "name": "Test Album",
                "album_artist": "Test Artist",
                "year": 2001,
                "edition": "",
            }
        },
    )

    assert key_status == 200
    assert _decode_json(key_body)["album_root"] == str(track_path.parent)
    assert hydrated_album_ids == [41, None]
    assert snapshot_reads == [41, 41]


def test_asgi_cover_lookup_gallery_keeps_persisted_task_scope_out_of_any_superset(
    app, monkeypatch
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (
        app.config["MUSIC_DIR"] / "Яруга" / "Я хочу умереть в лесу" / "01.flac"
    ).resolve()
    unrelated_path = (
        app.config["MUSIC_DIR"] / "Unrelated" / "Unknown Album" / "99.flac"
    ).resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    reset_cover_lookup_runtime_state()
    task_id, _cancel_event = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[
            {
                "id": "yaruga-caa-cover",
                "source": "cover_art_archive",
                "url": "https://coverartarchive.org/release/yaruga/front",
                "thumbnail_url": "https://coverartarchive.org/release/yaruga/front-250",
            }
        ],
    )

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 417655

        def resolve_album_track_context(self, *, album_id, album_key):
            assert album_id == 417655
            assert album_key in {None, "legacy catch-all::"}
            return {
                "album_id": 417655,
                "album_key": "legacy catch-all::",
                "track_paths": [str(track_path), str(unrelated_path)],
            }

        def get_for_album_context(self, *, album_id):
            raise AssertionError(
                "A task-scoped lookup must not read a superset album snapshot"
            )

    def build_cover_state_entries(_self, track_paths):
        assert track_paths == {str(track_path)}
        return {}

    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_cover_state_entries_by_paths",
        build_cover_state_entries,
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={
            "album": {
                "name": "Я хочу умереть в лесу",
                "album_artist": "Яруга",
                "year": 2021,
            },
            "task_id": task_id,
        },
    )

    payload = _decode_json(body)
    assert status == 200, payload
    assert payload["album_root"] == str(track_path.parent)
    assert payload["task"]["possible_matches"][0]["id"] == "yaruga-caa-cover"


def test_asgi_cover_lookup_save_remote_rehydrates_compact_notification_album(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    hydrated_album_ids: list[int] = []
    queued_calls: list[tuple[object, ...]] = []

    def build_album_detail(*_args, **_kwargs):
        raise AssertionError("Cover Lookup must not build the global album-detail projection")

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_track_context(self, *, album_id, album_key):
            hydrated_album_ids.append(album_id)
            assert album_key is None
            return {
                "album_id": 41,
                "album_key": "test artist::test album",
                "track_paths": [str(track_path)],
            }

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_album_detail_payload_by_id",
        build_album_detail,
    )
    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **_kwargs: queued_calls.append(args),
    )
    reset_cover_lookup_runtime_state()
    task_id, _cancel = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[{
            "id": "candidate-1",
            "art_kind": "cover",
            "url": "https://images.example/cover.jpg",
            "source": "manual",
            "source_label": "Manual URL",
        }],
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {
                "id": 41,
                "name": "Test Album",
                "album_artist": "Test Artist",
                "year": 2001,
                "edition": "",
            },
            "task_id": task_id,
            "candidate_id": "candidate-1",
        },
    )

    assert status == 200, _decode_json(body)
    assert hydrated_album_ids == [41]
    assert queued_calls[0][2] == {str(track_path)}


def test_asgi_cover_lookup_save_remote_scopes_persisted_unknown_album_notification(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    album_root = (app.config["MUSIC_DIR"] / "Unknown Artist" / "Unknown Album").resolve()
    task_track = album_root / "01.flac"
    unrelated_track = album_root / "99.flac"
    album_root.mkdir(parents=True, exist_ok=True)
    task_track.write_bytes(b"task track")
    unrelated_track.write_bytes(b"unrelated track")
    task_id = "bcfeb05cdbaf494db4473d62216817ba"
    persisted_task = {
        "id": task_id,
        "status": "completed",
        "album_payload": {
            "id": 419738,
            "album_id": 419738,
            "key": "yaruga::vaiga::2020",
            "name": "Vaiga",
            "album_artist": "Yaruga",
            "year": 2020,
            "tracks": [{"path": str(task_track)}],
        },
        "track_paths": [str(task_track)],
        "possible_matches": [
            {
                "id": "yaruga-cover",
                "art_kind": "cover",
                "url": "https://images.example/yaruga.jpg",
                "source": "manual",
                "source_label": "Manual URL",
            }
        ],
    }
    queued_calls: list[tuple[object, ...]] = []

    class FakeSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(task_track)}
            return 417655

    cover_lookup_tasks.reset_cover_lookup_runtime_state()
    monkeypatch.setattr(
        asgi_routes,
        "load_cover_lookup_notification",
        lambda _config, requested_task_id: (
            persisted_task if requested_task_id == task_id else None
        ),
    )
    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeSnapshotRepository,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **_kwargs: queued_calls.append(args),
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {
                "id": 417655,
                "album_id": 417655,
                "key": "unknown artist::",
                "name": "Unknown Album",
                "album_artist": "Unknown Artist",
                "tracks": [
                    {"path": str(task_track)},
                    {"path": str(unrelated_track)},
                ],
            },
            "task_id": task_id,
            "candidate_id": "yaruga-cover",
        },
    )

    assert status == 200, _decode_json(body)
    assert queued_calls[0][2] == {str(task_track)}
    restored_task = cover_lookup_tasks.cover_lookup_result(task_id)
    assert restored_task["album_payload"]["name"] == "Vaiga"
    assert restored_task["possible_matches"][0]["id"] == "yaruga-cover"


def test_asgi_cover_lookup_gallery_reads_saved_snapshot_without_task_or_provider_search(
    app,
    monkeypatch,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths",
        lambda _self, _paths: {},
    )
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    album = {**_album_payload(track_path), "album_id": 41}
    repository_calls: list[dict[str, object]] = []
    candidate = {
        "id": "candidate-1",
        "url": "https://images.example/cover.jpg",
        "source": "discogs",
        "source_label": "Discogs",
    }

    class FakeRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            repository_calls.append({"album_id": album_id})
            return {
                "album_id": album_id,
                "search_kind": "automatic",
                "status": "running",
                "revision": 6,
                "candidates": [candidate],
                "best_candidate_id": "candidate-1",
                "automatic_improvement_revision": 2,
                "seen_automatic_improvement_revision": 1,
            }

    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        FakeRepository,
        raising=False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_task",
        lambda *_args, **_kwargs: pytest.fail("opening saved candidates must not start provider search"),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": album},
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["task"] is None
    assert payload["candidate_snapshot"] == {
        "candidates": [candidate],
        "search_kind": "automatic",
        "status": "running",
        "revision": 6,
        "best_candidate_id": "candidate-1",
        "automatic_improvement_revision": 2,
        "seen_automatic_improvement_revision": 1,
        "unseen_automatic_improvement": True,
        "diagnostic": None,
    }
    assert repository_calls == [{"album_id": 41}]


@pytest.mark.parametrize(
    ("route_path", "extra_payload"),
    [
        ("/utilities/cover-lookup/gallery", {}),
        ("/utilities/cover-lookup/gallery/mark-seen", {}),
        (
            "/utilities/cover-lookup/save-remote",
            {
                "snapshot_generation": "saved-generation",
                "candidate_id": "candidate-1",
            },
        ),
    ],
)
@pytest.mark.parametrize("resolved_album_id", [41, None], ids=["another-album", "removed-album"])
def test_asgi_cover_snapshot_routes_reject_client_album_id_from_another_album(
    app,
    monkeypatch,
    route_path,
    extra_payload,
    resolved_album_id,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist A" / "Album A" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    calls: list[str] = []

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return resolved_album_id

        def get_for_album_context(self, *, album_id):
            calls.append(f"read:{album_id}")
            pytest.fail("mismatched client album ID must not read either snapshot")

        def mark_seen(self, *, album_id):
            calls.append(f"mark:{album_id}")
            pytest.fail("mismatched client album ID must not mutate either snapshot")

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *_args, **_kwargs: pytest.fail("mismatched album must not queue a save"),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        route_path,
        json_body={
            "album": {**_album_payload(track_path), "album_id": 99},
            **extra_payload,
        },
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "error": "Album identity does not match the resolved track inventory",
    }
    assert calls == []


@pytest.mark.parametrize(
    ("route_path", "extra_payload"),
    [
        ("/utilities/cover-lookup/gallery", {}),
        (
            "/utilities/cover-lookup/save-remote",
            {"candidate_id": "task-b-candidate"},
        ),
    ],
)
def test_asgi_cover_routes_reject_lookup_task_from_another_album(
    app,
    monkeypatch,
    route_path,
    extra_payload,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_a = (app.config["MUSIC_DIR"] / "Artist A" / "Album A" / "one.mp3").resolve()
    track_b = (app.config["MUSIC_DIR"] / "Artist B" / "Album B" / "one.mp3").resolve()
    for track_path in (track_a, track_b):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
    reset_cover_lookup_runtime_state()
    task_id, _cancel = cover_lookup_tasks.create_cover_lookup_task(
        {**_album_payload(track_b), "album_id": 42},
        {str(track_b)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        possible_matches=[{
            "id": "task-b-candidate",
            "art_kind": "cover",
            "url": "https://images.example/b.jpg",
        }],
    )
    snapshot_calls: list[int] = []

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            return 41 if track_paths == {str(track_a)} else 42

        def get_for_album_context(self, *, album_id):
            snapshot_calls.append(album_id)
            return None

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *_args, **_kwargs: pytest.fail("cross-album task must not queue a save"),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        route_path,
        json_body={
            "album": {
                **_album_payload(track_a),
                "album_id": 41,
                "identity_resolution": "album_split_choice",
            },
            "task_id": task_id,
            **extra_payload,
        },
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "error": "Lookup task does not belong to this album",
    }
    assert snapshot_calls == []


def test_asgi_cover_lookup_gallery_returns_safe_current_release_choices_for_split_album(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    first_track = (app.config["MUSIC_DIR"] / "Artist" / "Old Album" / "one.mp3").resolve()
    second_track = (app.config["MUSIC_DIR"] / "Artist" / "Old Album" / "two.mp3").resolve()
    for track_path in (first_track, second_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
    old_album = {
        **_album_payload(first_track),
        "album_id": 40,
        "name": "Old Album",
        "tracks": [{"path": str(first_track)}, {"path": str(second_track)}],
    }
    reset_cover_lookup_runtime_state()
    task_id, _cancel = cover_lookup_tasks.create_cover_lookup_task(
        old_album,
        {str(first_track), str(second_track)},
    )
    current_releases = [
        {
            "key": "artist::first release",
            "album_artist": "Artist",
            "name": "First Release",
            "year": 2001,
            "edition": "Expanded",
            "tracks": [{"path": str(first_track)}],
        },
        {
            "key": "artist::second release",
            "album_artist": "Artist",
            "name": "Second Release",
            "year": 2002,
            "tracks": [{"path": str(second_track)}],
        },
    ]

    class SnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            if track_paths == {str(first_track), str(second_track)}:
                return None
            if track_paths == {str(first_track)}:
                return 41
            if track_paths == {str(second_track)}:
                return 42
            raise AssertionError(track_paths)

    class BrowseRepository:
        def __init__(self, _config):
            pass

        def build_album_payloads_by_track_paths(self, track_paths):
            assert track_paths == {str(first_track), str(second_track)}
            return current_releases

    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        SnapshotRepository,
    )
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", BrowseRepository)

    async def serialize_gallery(*_args, **_kwargs):
        return {"ok": True, "local_covers": [], "other_art": []}

    monkeypatch.setattr(asgi_routes, "_serialize_cover_gallery_from_asgi", serialize_gallery)

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": old_album, "task_id": task_id},
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "error": "This album was split—choose the current release",
        "resolution_kind": "album_split",
        "current_releases": [
            {
                "album_id": 41,
                "identity_resolution": "album_split_choice",
                "key": "artist::first release",
                "album_artist": "Artist",
                "name": "First Release",
                "year": 2001,
                "edition": "Expanded",
                "track_count": 1,
            },
            {
                "album_id": 42,
                "identity_resolution": "album_split_choice",
                "key": "artist::second release",
                "album_artist": "Artist",
                "name": "Second Release",
                "year": 2002,
                "edition": "",
                "track_count": 1,
            },
        ],
    }
    assert "path" not in body.decode("utf-8").casefold()

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={
            "album": {
                **current_releases[1],
                "album_id": 42,
                "identity_resolution": "album_split_choice",
            },
            "task_id": task_id,
        },
    )

    assert status == 200
    assert _decode_json(body)["ok"] is True


@pytest.mark.parametrize(
    ("repository_result", "repository_error", "expected_diagnostic"),
    [
        (
            {
                "search_kind": "manual",
                "status": "completed",
                "revision": 3,
                "candidates": {"invalid": "object"},
            },
            None,
            "malformed_candidate_snapshot",
        ),
        (None, RuntimeError("database unavailable"), "candidate_snapshot_read_failed"),
    ],
)
def test_asgi_cover_lookup_gallery_fails_closed_without_searching_on_snapshot_error(
    app,
    monkeypatch,
    repository_result,
    repository_error,
    expected_diagnostic,
):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths",
        lambda _self, _paths: {},
    )
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            if repository_error is not None:
                raise repository_error
            return repository_result

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository, raising=False)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_task",
        lambda *_args, **_kwargs: pytest.fail("snapshot read failure must not start provider search"),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": {**_album_payload(track_path), "album_id": 41}},
    )

    assert status == 200
    snapshot = _decode_json(body)["candidate_snapshot"]
    assert snapshot["candidates"] == []
    assert snapshot["diagnostic"] == expected_diagnostic
    assert snapshot["unseen_automatic_improvement"] is False


def test_asgi_cover_lookup_mark_seen_is_album_scoped_and_returns_refreshed_snapshot(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    calls: list[int] = []

    class FakeRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def mark_seen(self, *, album_id):
            calls.append(album_id)
            return {
                "album_id": album_id,
                "search_kind": "automatic",
                "status": "completed",
                "revision": 8,
                "candidates": [],
                "best_candidate_id": None,
                "automatic_improvement_revision": 4,
                "seen_automatic_improvement_revision": 4,
            }

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository, raising=False)
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery/mark-seen",
        json_body={"album": {**_album_payload(track_path), "album_id": 41}},
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["candidate_snapshot"]["unseen_automatic_improvement"] is False
    assert payload["candidate_snapshot"]["seen_automatic_improvement_revision"] == 4
    assert calls == [41]


def test_asgi_cover_lookup_mark_seen_failure_keeps_unseen_improvement_active(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def mark_seen(self, *, album_id):
            assert album_id == 41
            raise RuntimeError("database unavailable")

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            return {
                "album_id": album_id,
                "search_kind": "automatic",
                "status": "completed",
                "revision": 8,
                "candidates": [],
                "best_candidate_id": None,
                "automatic_improvement_revision": 4,
                "seen_automatic_improvement_revision": 3,
            }

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository, raising=False)
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/gallery/mark-seen",
        json_body={"album": {**_album_payload(track_path), "album_id": 41}},
    )

    assert status == 503
    payload = _decode_json(body)
    assert payload["ok"] is False
    assert payload["candidate_snapshot"]["unseen_automatic_improvement"] is True
    assert payload["candidate_snapshot"]["diagnostic"] == "mark_seen_failed"


def test_asgi_local_cover_selection_response_and_runtime_preserve_explicit_authority(app, monkeypatch):
    from music_app.models.library import Album, Track
    from music_app.routes import api_cover_helpers, api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220), size=(4000, 4000)))
    _seed_album_state(app.library_state, track_path)
    app.library_state["albums"] = [Album(
        key="album-1", name="Test Album", album_artist="Test Artist",
        local_cover_width=1600, local_cover_height=1600,
        tracks=[Track(path=track_path, title="Song", album="Test Album", album_artist="Test Artist")],
    )]
    asgi_app = _make_wave_d_app(app)
    persisted = []
    def persist_selection(*_args, **kwargs):
        persisted.append(kwargs)
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}
    monkeypatch.setattr(api_cover_helpers, "persist_cover_selection_for_tracks_for_config", persist_selection)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        api_cover_helpers,
        "build_problematic_album_detail_payload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("cover selection must not build Problematic Files details")
        ),
    )
    monkeypatch.setattr(
        asgi_routes,
        "_serialize_cover_gallery_from_asgi",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("cover selection must not rebuild the gallery before acknowledgement")
        ),
    )
    status, _headers, body = _run_asgi_request(
        asgi_app, "POST", "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )
    assert status == 200
    response_payload = _decode_json(body)
    updated = response_payload["updated_album"]
    assert updated["cover_selection_origin"] == "user"
    assert updated["cover_selection_provenance"] == "explicit"
    assert (updated["local_cover_width"], updated["local_cover_height"]) == (4000, 4000)
    assert (persisted[0]["local_cover_width"], persisted[0]["local_cover_height"]) == (4000, 4000)
    assert app.library_state["albums"][0].cover_selection_origin == "user"
    assert app.library_state["albums"][0].cover_selection_provenance == "explicit"
    assert app.library_state["albums"][0].local_cover_width == 4000
    assert app.library_state["albums"][0].tracks[0].local_cover_width == 4000
    assert app.library_state["file_cache"][str(track_path)]["cover_selection_origin"] == "user"
    assert app.library_state["file_cache"][str(track_path)]["cover_selection_provenance"] == "explicit"
    assert app.library_state["file_cache"][str(track_path)]["local_cover_width"] == 4000
    assert response_payload["updated_problematic_album"] is None
    assert "gallery" not in response_payload


def test_asgi_local_cover_selection_persists_before_success_and_logs_safe_completion(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()
    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: {"album_rows_updated": 1, "track_file_rows_updated": 1},
    )
    operations: list[str] = []
    logged_events: list[dict[str, object]] = []

    def fake_persist_cover_selection_for_tracks(track_paths, cover_path, **kwargs):
        operations.append("persist")
        assert track_paths == {str(track_path)}
        assert cover_path == track_path.parent / "cover.jpg"
        assert kwargs["config"] is app.config
        assert kwargs["logger"] is asgi_app.state.logger
        assert kwargs["cover_revision"] == hashlib.sha256(selected_image.read_bytes()).hexdigest()
        assert kwargs["cover_selection_origin"] == "user"
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    def fake_apply_cover_path_for_tracks(track_paths, cover_path, **_kwargs):
        operations.append("apply-runtime")
        assert track_paths == {str(track_path)}
        return [
            {
                **_album_payload(track_path),
                "cover_path": str(cover_path),
                "tracks": [{"path": str(track_path), "cover_path": str(cover_path)}],
            }
        ], None

    def fake_log_app_event(config, logger, message, **extra):
        operations.append("log-success")
        logged_events.append(
            {
                "config": config,
                "logger": logger,
                "message": message,
                **extra,
            }
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fake_persist_cover_selection_for_tracks,
        raising=False,
    )
    monkeypatch.setattr(asgi_routes, "apply_cover_path_for_tracks", fake_apply_cover_path_for_tracks)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == 200
    assert _decode_json(body)["selected_cover_path"] == str(track_path.parent / "cover.jpg")
    assert operations == ["persist", "apply-runtime", "log-success"]
    assert len(logged_events) == 1
    event = logged_events[0]
    assert {key: event[key] for key in (
        "config", "logger", "message", "history_scope", "level", "history",
        "artist", "album", "year", "target_filename", "album_rows_updated",
        "track_file_rows_updated",
    )} == {
        "config": app.config,
        "logger": asgi_app.state.logger,
        "message": "Local cover selection persisted",
        "history_scope": HistoryScope(account_id=1, library_id=1, origin_kind="request"),
        "level": "info",
        "history": True,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "target_filename": "cover.jpg",
        "album_rows_updated": 1,
        "track_file_rows_updated": 1,
    }
    assert set(event["timings_ms"]) == {
        "resolve_and_validate",
        "promotion",
        "hash",
        "persistence",
        "lock_wait",
        "database",
        "runtime_refresh",
        "total",
    }
    assert all(value >= 0 for value in event["timings_ms"].values())
    event_text = repr(event)
    assert str(track_path.parent) not in event_text
    assert str(track_path) not in event_text
    assert str(selected_image) not in event_text
    assert selected_image.is_file()
    assert (track_path.parent / "cover.jpg").read_bytes() == selected_image.read_bytes()
    assert list(track_path.parent.glob("cover-existing-*.jpg")) == []


def test_asgi_local_cover_selection_persistence_failure_restores_prior_cover_and_removes_reserve_artifact(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    prior_cover = track_path.parent / "cover.jpg"
    prior_bytes = _jpeg_bytes((220, 30, 30))
    prior_cover.write_bytes(prior_bytes)
    prior_mtime_ns = prior_cover.stat().st_mtime_ns
    selected_image = track_path.parent / "Front.jpg"
    selected_bytes = _jpeg_bytes((30, 30, 220))
    selected_image.write_bytes(selected_bytes)
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == 500
    assert _decode_json(body)["error"] == "Selected cover art could not be persisted."
    assert prior_cover.read_bytes() == prior_bytes
    assert prior_cover.stat().st_mtime_ns == prior_mtime_ns
    assert selected_image.read_bytes() == selected_bytes
    assert list(track_path.parent.glob("cover-existing-*.jpg")) == []


def test_asgi_local_cover_revision_failure_after_promotion_restores_prior_cover_before_persistence(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    prior_cover = track_path.parent / "cover.jpg"
    prior_bytes = _jpeg_bytes((220, 30, 30))
    prior_cover.write_bytes(prior_bytes)
    prior_mtime_ns = prior_cover.stat().st_mtime_ns
    selected_image = track_path.parent / "Front.jpg"
    selected_bytes = _jpeg_bytes((30, 30, 220))
    selected_image.write_bytes(selected_bytes)
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    persistence_calls: list[object] = []
    monkeypatch.setattr(
        asgi_routes,
        "cover_revision_for_path",
        lambda _path: (_ for _ in ()).throw(RuntimeError("revision unavailable")),
    )
    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *args, **kwargs: persistence_calls.append((args, kwargs)),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == 500
    assert _decode_json(body) == {
        "ok": False,
        "error": "Selected cover art could not be persisted.",
    }
    assert persistence_calls == []
    assert prior_cover.read_bytes() == prior_bytes
    assert prior_cover.stat().st_mtime_ns == prior_mtime_ns
    assert selected_image.read_bytes() == selected_bytes
    assert list(track_path.parent.glob("cover-existing-*.jpg")) == []


def test_asgi_local_cover_selection_runtime_refresh_failure_keeps_committed_success_and_logs_safely(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    logged_events: list[dict[str, object]] = []
    private_failure = f"runtime refresh failed for {track_path}"

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: {"album_rows_updated": 1, "track_file_rows_updated": 1},
    )
    monkeypatch.setattr(
        asgi_routes,
        "apply_cover_path_for_tracks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError(private_failure)),
    )
    monkeypatch.setattr(
        asgi_routes,
        "log_app_event",
        lambda config, logger, message, **extra: logged_events.append(
            {"message": message, **extra}
        ),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["selected_cover_path"] == str(track_path.parent / "cover.jpg")
    assert payload["cover_revision"] == hashlib.sha256(selected_image.read_bytes()).hexdigest()
    assert len(payload["updated_albums"]) == 1
    authoritative_album = payload["updated_album"]
    assert authoritative_album["cover_path"] == str(track_path.parent / "cover.jpg")
    assert authoritative_album["cover_revision"] == payload["cover_revision"]
    remote_fields = (
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    )
    assert all(authoritative_album[field] is None for field in remote_fields)
    assert authoritative_album["tracks"][0]["cover_path"] == str(track_path.parent / "cover.jpg")
    assert authoritative_album["tracks"][0]["cover_revision"] == payload["cover_revision"]
    assert all(authoritative_album["tracks"][0][field] is None for field in remote_fields)
    assert [event["message"] for event in logged_events] == [
        "Local cover runtime refresh failed",
        "Local cover selection persisted",
    ]
    refresh_event = logged_events[0]
    assert refresh_event["error_kind"] == "RuntimeError"
    assert private_failure not in repr(refresh_event)
    assert str(track_path) not in repr(refresh_event)


def test_asgi_local_cover_selection_runtime_fallback_repairs_live_state_before_success(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services.cover_state import active_cover_path_for_track_paths

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    stale_cover = track_path.parent / "Art" / "Back.jpg"
    stale_cover.parent.mkdir(parents=True, exist_ok=True)
    stale_cover.write_bytes(_jpeg_bytes((180, 40, 40)))
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    album = app.library_state["albums"][0]
    track = album.tracks[0]
    stale_remote_fields = {
        "remote_cover_url": "https://covers.invalid/stale.jpg",
        "remote_cover_thumbnail_url": "https://covers.invalid/stale-thumb.jpg",
        "remote_cover_source": "stale-provider",
        "remote_cover_source_label": "Stale Provider",
        "remote_cover_album_url": "https://covers.invalid/stale-album",
        "remote_cover_width": 640,
        "remote_cover_height": 640,
    }
    app.library_state["file_cache"][str(track_path)].update(
        {
            "cover_path": str(stale_cover),
            "cover_revision": "stale-cover-revision",
            **stale_remote_fields,
        }
    )
    for media_item in (album, track):
        media_item.cover_path = str(stale_cover)
        media_item.cover_revision = "stale-cover-revision"
        for field, value in stale_remote_fields.items():
            setattr(media_item, field, value)

    def fake_persist_cover_selection(*_args, **kwargs):
        return kwargs["commit_guard"](
            lambda: {"album_rows_updated": 1, "track_file_rows_updated": 1}
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fake_persist_cover_selection,
    )
    monkeypatch.setattr(
        asgi_routes,
        "apply_cover_path_for_tracks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("runtime refresh failed before mutation")
        ),
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    payload = _decode_json(body)
    selected_cover = track_path.parent / "cover.jpg"
    selected_revision = hashlib.sha256(selected_image.read_bytes()).hexdigest()
    assert status == 200
    assert payload["selected_cover_path"] == str(selected_cover)
    file_entry = asgi_app.state.library_state["file_cache"][str(track_path)]
    assert active_cover_path_for_track_paths(
        asgi_app.state.library_state["file_cache"],
        {str(track_path)},
    ) == selected_cover
    live_album = asgi_app.state.library_state["albums"][0]
    live_track = live_album.tracks[0]
    assert file_entry["cover_path"] == str(selected_cover)
    assert file_entry["cover_revision"] == selected_revision
    assert live_album.cover_path == str(selected_cover)
    assert live_album.cover_revision == selected_revision
    assert live_track.cover_path == str(selected_cover)
    assert live_track.cover_revision == selected_revision
    for field in stale_remote_fields:
        assert file_entry.get(field) is None
        assert getattr(live_album, field) is None
        assert getattr(live_track, field) is None


def test_asgi_local_cover_selection_requeues_interrupted_manual_full_rescan(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    app.library_state.update(
        {
            "scan_generation": 12,
            "scan_in_progress": True,
            "scan_mode": "manual_full_rescan",
            "scan_phase": "publishing",
            "rescan_ignore_existing_cache": False,
        }
    )
    requeued_scans: list[dict[str, object]] = []

    def fake_persist_cover_selection(*_args, **kwargs):
        return kwargs["commit_guard"](
            lambda: {"album_rows_updated": 1, "track_file_rows_updated": 1}
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fake_persist_cover_selection,
    )
    monkeypatch.setattr(
        asgi_routes,
        "apply_cover_path_for_tracks",
        lambda *_args, **_kwargs: ([], None),
    )
    monkeypatch.setattr(
        asgi_routes.state_service,
        "start_background_refresh_for_state",
        lambda state, config, logger, **kwargs: requeued_scans.append(
            {"state": state, "config": config, "logger": logger, **kwargs}
        ),
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == 200
    assert _decode_json(body)["ok"] is True
    assert app.library_state["rescan_ignore_existing_cache"] is True
    assert len(requeued_scans) == 1
    assert requeued_scans[0] == {
        "state": app.library_state,
        "config": app.config,
        "logger": asgi_app.state.logger,
        "force": True,
        "scan_mode": "manual_full_rescan",
    }


def test_asgi_local_cover_selection_expands_partial_payload_to_full_live_album(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    album_root = (app.config["MUSIC_DIR"] / "Artist" / "Album").resolve()
    first_track_path = album_root / "01 first.mp3"
    second_track_path = album_root / "02 second.mp3"
    album_root.mkdir(parents=True, exist_ok=True)
    first_track_path.write_bytes(b"first-track")
    second_track_path.write_bytes(b"second-track")
    selected_image = album_root / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, first_track_path)
    album = app.library_state["albums"][0]
    first_track = album.tracks[0]
    second_track = SimpleNamespace(**vars(first_track))
    second_track.path = str(second_track_path)
    second_track.title = "Second Song"
    second_track.track_number = 2
    album.tracks.append(second_track)
    app.library_state["file_cache"][str(second_track_path)] = {
        **app.library_state["file_cache"][str(first_track_path)],
        "path": str(second_track_path),
        "title": "Second Song",
    }
    stale_cover = album_root / "Art" / "Back.jpg"
    stale_remote_fields = {
        "remote_cover_url": "https://covers.invalid/stale.jpg",
        "remote_cover_thumbnail_url": "https://covers.invalid/stale-thumb.jpg",
        "remote_cover_source": "stale-provider",
        "remote_cover_source_label": "Stale Provider",
        "remote_cover_album_url": "https://covers.invalid/stale-album",
        "remote_cover_width": 640,
        "remote_cover_height": 640,
    }
    for path in (first_track_path, second_track_path):
        app.library_state["file_cache"][str(path)].update(
            {
                "cover_path": str(stale_cover),
                "cover_revision": "stale-revision",
                **stale_remote_fields,
            }
        )
    for media_item in (album, first_track, second_track):
        media_item.cover_path = str(stale_cover)
        media_item.cover_revision = "stale-revision"
        for field, value in stale_remote_fields.items():
            setattr(media_item, field, value)

    persisted_track_paths: list[set[str]] = []

    def fake_persist_cover_selection(track_paths, _cover_path, **kwargs):
        persisted_track_paths.append(set(track_paths))
        return kwargs["commit_guard"](
            lambda: {
                "album_rows_updated": 1,
                "track_file_rows_updated": len(track_paths),
            }
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fake_persist_cover_selection,
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)
    asgi_app = _make_wave_d_app(app)
    partial_album_payload = _album_payload(first_track_path)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": partial_album_payload, "source_path": str(selected_image)},
    )

    payload = _decode_json(body)
    selected_cover = album_root / "cover.jpg"
    selected_revision = hashlib.sha256(selected_image.read_bytes()).hexdigest()
    expected_track_paths = {str(first_track_path), str(second_track_path)}
    assert status == 200
    assert payload["ok"] is True
    assert persisted_track_paths == [expected_track_paths]
    live_album = asgi_app.state.library_state["albums"][0]
    assert {track.path for track in live_album.tracks} == expected_track_paths
    for path in expected_track_paths:
        file_entry = asgi_app.state.library_state["file_cache"][path]
        assert file_entry["cover_path"] == str(selected_cover)
        assert file_entry["cover_revision"] == selected_revision
        assert all(file_entry.get(field) is None for field in stale_remote_fields)
    assert live_album.cover_path == str(selected_cover)
    assert live_album.cover_revision == selected_revision
    assert all(getattr(live_album, field) is None for field in stale_remote_fields)
    for live_track in live_album.tracks:
        assert live_track.cover_path == str(selected_cover)
        assert live_track.cover_revision == selected_revision
        assert all(getattr(live_track, field) is None for field in stale_remote_fields)


def test_asgi_local_cover_selection_persistence_failure_is_safe_and_never_reports_success(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()
    apply_calls: list[object] = []
    logged_events: list[dict[str, object]] = []
    private_failure = f"could not update {track_path.parent / 'cover.jpg'}"

    def fail_persist_cover_selection_for_tracks(*_args, **_kwargs):
        raise RuntimeError(private_failure)

    def forbidden_apply_cover_path_for_tracks(*args, **kwargs):
        apply_calls.append((args, kwargs))
        return [], None

    def fake_log_app_event(config, logger, message, **extra):
        logged_events.append(
            {
                "config": config,
                "logger": logger,
                "message": message,
                **extra,
            }
        )

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fail_persist_cover_selection_for_tracks,
        raising=False,
    )
    monkeypatch.setattr(asgi_routes, "apply_cover_path_for_tracks", forbidden_apply_cover_path_for_tracks)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == 500
    assert _decode_json(body) == {
        "ok": False,
        "error": "Selected cover art could not be persisted.",
    }
    assert apply_calls == []
    assert len(logged_events) == 1
    event = logged_events[0]
    assert event == {
        "config": app.config,
        "logger": asgi_app.state.logger,
        "message": "Local cover selection persistence failed",
        "history_scope": HistoryScope(account_id=1, library_id=1, origin_kind="request"),
        "level": "error",
        "history": True,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "target_filename": "cover.jpg",
        "error_kind": "RuntimeError",
    }
    event_text = repr(event)
    assert private_failure not in event_text
    assert str(track_path.parent) not in event_text
    assert str(track_path) not in event_text
    assert str(selected_image) not in event_text


@pytest.mark.parametrize(
    ("persistence_fails", "expected_status"),
    [(False, 200), (True, 500)],
)
def test_asgi_local_cover_selection_log_history_failure_never_masks_persistence_outcome(
    app,
    monkeypatch,
    persistence_fails,
    expected_status,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    apply_calls: list[object] = []

    def persist(*_args, **_kwargs):
        if persistence_fails:
            raise RuntimeError("database unavailable")
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    def apply(*args, **kwargs):
        apply_calls.append((args, kwargs))
        return [], None

    monkeypatch.setattr(asgi_routes, "persist_cover_selection_for_tracks", persist)
    monkeypatch.setattr(asgi_routes, "apply_cover_path_for_tracks", apply)
    monkeypatch.setattr(
        asgi_routes,
        "log_app_event",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("history unavailable")),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )

    assert status == expected_status
    assert len(apply_calls) == (0 if persistence_fails else 1)
    if persistence_fails:
        assert _decode_json(body) == {
            "ok": False,
            "error": "Selected cover art could not be persisted.",
        }
    else:
        assert _decode_json(body)["ok"] is True


def test_asgi_cover_lookup_local_select_delete_and_pasted_image_validation(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    outside_image = (app.config["MUSIC_DIR"] / "Artist" / "other.jpg").resolve()
    outside_image.parent.mkdir(parents=True, exist_ok=True)
    outside_image.write_bytes(_jpeg_bytes((120, 40, 200)))
    selected_image = track_path.parent / "selected.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    outside_delete_image = outside_image.parent / "delete-outside.jpg"
    outside_delete_image.write_bytes(_jpeg_bytes((80, 80, 80)))
    missing_image = track_path.parent / "missing.jpg"
    managed_preview = (
        track_path.parent
        / ".album-haven"
        / "cover_variants"
        / "aa"
        / "aabb.jpg"
    )
    managed_preview.parent.mkdir(parents=True)
    managed_preview.write_bytes(_jpeg_bytes((80, 80, 80)))
    _seed_album_state(app.library_state, track_path)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()
    apply_calls: list[dict[str, object]] = []
    actioned_track_paths: list[set[str]] = []

    def fake_apply_cover_path_for_tracks(track_paths, cover_path, **kwargs):
        apply_calls.append(
            {
                "track_paths": track_paths,
                "cover_path": cover_path,
                "config": kwargs.get("config"),
                "logger": kwargs.get("logger"),
                "library_state": kwargs.get("library_state"),
                "include_problematic_album": kwargs.get("include_problematic_album"),
            }
        )
        return [{"tracks": [{"path": str(track_path), "cover_path": str(cover_path) if cover_path else None}]}], None

    monkeypatch.setattr(asgi_routes, "apply_cover_path_for_tracks", fake_apply_cover_path_for_tracks)
    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: {"album_rows_updated": 1, "track_file_rows_updated": 1},
    )
    monkeypatch.setattr(
        asgi_routes,
        "mark_cover_lookup_notifications_action_taken_for_track_paths",
        lambda track_paths, **_kwargs: actioned_track_paths.append(set(track_paths)) or [],
    )

    select_success_status, _select_success_headers, select_success_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(selected_image)},
    )
    asgi_app.state.library_state["file_cache"][str(track_path)]["cover_path"] = str(track_path.parent / "cover.jpg")
    delete_success_status, _delete_success_headers, delete_success_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": str(track_path.parent / "cover.jpg")},
    )
    pasted_success_status, _pasted_success_headers, pasted_success_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/pasted-image-save",
        json_body={"album": _album_payload(track_path), "data_url": _jpeg_data_url((20, 40, 220))},
    )

    select_status, _select_headers, select_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(outside_image)},
    )
    delete_status, _delete_headers, delete_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": str(missing_image)},
    )
    delete_outside_status, _delete_outside_headers, delete_outside_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": str(outside_delete_image)},
    )
    managed_select_status, _managed_select_headers, managed_select_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-select",
        json_body={"album": _album_payload(track_path), "source_path": str(managed_preview)},
    )
    managed_delete_status, _managed_delete_headers, managed_delete_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": str(managed_preview)},
    )
    pasted_status, _pasted_headers, pasted_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/pasted-image-save",
        json_body={"album": _album_payload(track_path), "data_url": "not-a-data-url"},
    )

    assert select_success_status == 200
    select_success_payload = _decode_json(select_success_body)
    assert select_success_payload["ok"] is True
    assert select_success_payload["selected_cover_path"] == str(track_path.parent / "cover.jpg")
    assert "gallery" not in select_success_payload
    assert delete_success_status == 200
    delete_success_payload = _decode_json(delete_success_body)
    assert delete_success_payload["ok"] is True
    assert delete_success_payload["gallery"]["album_root"] == str(track_path.parent)
    assert pasted_success_status == 200
    pasted_success_payload = _decode_json(pasted_success_body)
    assert pasted_success_payload["ok"] is True
    assert pasted_success_payload["selected_cover_path"] == str(track_path.parent / "cover.jpg")
    assert pasted_success_payload["gallery"]["album_root"] == str(track_path.parent)
    assert actioned_track_paths == [{str(track_path)}]
    assert apply_calls == [
        {
            "track_paths": {str(track_path)},
            "cover_path": track_path.parent / "cover.jpg",
            "config": app.config,
            "logger": asgi_app.state.logger,
            "library_state": asgi_app.state.library_state,
            "include_problematic_album": False,
        },
        {
            "track_paths": {str(track_path)},
            "cover_path": selected_image,
            "config": app.config,
            "logger": asgi_app.state.logger,
            "library_state": asgi_app.state.library_state,
            "include_problematic_album": None,
        },
        {
            "track_paths": {str(track_path)},
            "cover_path": track_path.parent / "cover.jpg",
            "config": app.config,
            "logger": asgi_app.state.logger,
            "library_state": asgi_app.state.library_state,
            "include_problematic_album": None,
        },
    ]
    assert select_status == 400
    assert _decode_json(select_body) == {"ok": False, "error": "Selected image is outside the album folder"}
    assert delete_status == 404
    assert _decode_json(delete_body) == {"ok": False, "error": "Selected image was not found"}
    assert delete_outside_status == 400
    assert _decode_json(delete_outside_body) == {"ok": False, "error": "Selected image is outside the album folder"}
    assert managed_select_status == 400
    assert _decode_json(managed_select_body) == {
        "ok": False,
        "error": "Selected image is an internal managed preview",
    }
    assert managed_delete_status == 400
    assert _decode_json(managed_delete_body) == {
        "ok": False,
        "error": "Selected image is an internal managed preview",
    }
    assert managed_preview.is_file()
    assert pasted_status == 400
    assert _decode_json(pasted_body) == {"ok": False, "error": "Clipboard image format is invalid."}


def test_asgi_cover_lookup_delete_final_local_cover_durably_clears_selection(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path = track_path.parent / "cover.jpg"
    cover_path.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    app.library_state["file_cache"][str(track_path)]["cover_path"] = str(cover_path)
    persisted: list[tuple[set[str], object]] = []

    def persist(track_paths, selected_cover_path, **_kwargs):
        persisted.append((set(track_paths), selected_cover_path))
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    def apply(track_paths, selected_cover_path, **_kwargs):
        assert set(track_paths) == {str(track_path)}
        app.library_state["file_cache"][str(track_path)]["cover_path"] = selected_cover_path
        return [], None

    monkeypatch.setattr(asgi_routes, "persist_cover_selection_for_tracks", persist)
    monkeypatch.setattr(asgi_routes, "apply_cover_path_for_tracks", apply)
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/local-delete",
        json_body={"album": _album_payload(track_path), "source_path": str(cover_path)},
    )

    assert status == 200
    assert _decode_json(body)["ok"] is True
    assert persisted == [({str(track_path)}, None)]
    assert app.library_state["file_cache"][str(track_path)]["cover_path"] is None


def test_asgi_cover_lookup_delete_final_local_cover_persistence_failure_restores_file_and_state(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path = track_path.parent / "cover.jpg"
    cover_bytes = _jpeg_bytes((40, 180, 220))
    cover_path.write_bytes(cover_bytes)
    _seed_album_state(app.library_state, track_path)
    app.library_state["file_cache"][str(track_path)]["cover_path"] = str(cover_path)
    runtime_state_before = deepcopy(app.library_state)
    apply_calls: list[object] = []

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    monkeypatch.setattr(
        asgi_routes,
        "apply_cover_path_for_tracks",
        lambda *args, **kwargs: apply_calls.append((args, kwargs)),
    )
    asgi_app = _make_wave_d_app(app)

    try:
        status, _headers, _body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/cover-lookup/local-delete",
            json_body={"album": _album_payload(track_path), "source_path": str(cover_path)},
        )
    except RuntimeError as exc:
        assert str(exc) == "database unavailable"
    else:
        assert status == 500

    assert cover_path.read_bytes() == cover_bytes
    assert app.library_state == runtime_state_before
    assert apply_calls == []


def test_asgi_pasted_cover_persistence_failure_restores_prior_cover_bytes_and_state(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path = track_path.parent / "cover.jpg"
    prior_bytes = _jpeg_bytes((220, 40, 80))
    cover_path.write_bytes(prior_bytes)
    _seed_album_state(app.library_state, track_path)
    app.library_state["file_cache"][str(track_path)]["cover_path"] = str(cover_path)
    apply_calls: list[object] = []

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    monkeypatch.setattr(
        asgi_routes,
        "apply_cover_path_for_tracks",
        lambda *args, **kwargs: apply_calls.append((args, kwargs)),
    )
    asgi_app = _make_wave_d_app(app)

    try:
        status, _headers, _body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/cover-lookup/pasted-image-save",
            json_body={"album": _album_payload(track_path), "data_url": _jpeg_data_url((20, 40, 220))},
        )
    except RuntimeError as exc:
        assert str(exc) == "database unavailable"
    else:
        assert status == 500
    assert cover_path.read_bytes() == prior_bytes
    assert app.library_state["file_cache"][str(track_path)]["cover_path"] == str(cover_path)
    assert apply_calls == []


def test_asgi_cover_lookup_add_remote_merges_existing_candidates_and_remote_image_fetch(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://unused@localhost/test"
    persisted_remote_url = "https://images.example/persisted-active.jpg"
    cover_state_loads: list[set[str]] = []

    def build_cover_state_entries_by_paths(_repository, track_paths):
        cover_state_loads.append(set(track_paths))
        return {
            str(track_path): {
                "path": str(track_path),
                "remote_cover_url": persisted_remote_url,
            }
        }

    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_cover_state_entries_by_paths",
        build_cover_state_entries_by_paths,
    )
    extraction_calls: list[dict[str, object]] = []
    fetch_calls: list[dict[str, object]] = []
    log_calls: list[dict[str, object]] = []
    update_calls: list[dict[str, object]] = []

    def fake_add_manual_cover_candidates_from_urls(urls, **kwargs):
        extraction_calls.append({"urls": urls, **kwargs})
        return [{"id": "candidate-new", "url": "https://images.example/new.jpg", "art_kind": "cover"}]

    monkeypatch.setattr(asgi_routes, "add_manual_cover_candidates_from_urls", fake_add_manual_cover_candidates_from_urls)

    def fake_fetch_remote_cover_bytes(image_url, **kwargs):
        fetch_calls.append({"image_url": image_url, **kwargs})
        return b"image-bytes", "image/jpeg"

    monkeypatch.setattr(asgi_routes, "fetch_remote_cover_bytes", fake_fetch_remote_cover_bytes)
    original_update_cover_lookup_task = asgi_routes.update_cover_lookup_task

    def fake_log_app_event(config, logger, message, **kwargs):
        log_calls.append({"config": config, "logger": logger, "message": message, **kwargs})

    def recording_update_cover_lookup_task(task_id, **kwargs):
        update_calls.append({"task_id": task_id, **kwargs})
        return original_update_cover_lookup_task(task_id, **kwargs)

    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)
    monkeypatch.setattr(asgi_routes, "update_cover_lookup_task", recording_update_cover_lookup_task)
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[
            {
                "id": "candidate-old",
                "url": "https://images.example/old.jpg",
                "source": "discogs",
                "width": 700,
            }
        ],
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    add_status, _add_headers, add_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/add-remote",
        json_body={
            "album": _album_payload(track_path),
            "task_id": task_id,
            "urls": [" https://manual.example/cover ", ""],
        },
    )
    image_status, image_headers, image_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/remote-image",
        query={"url": "https://images.example/new.jpg"},
    )
    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/remote-image",
    )

    assert add_status == 200
    payload = _decode_json(add_body)
    assert payload["ok"] is True
    assert [item["id"] for item in payload["task"]["possible_matches"]] == ["candidate-old", "candidate-new"]
    assert payload["task"]["possible_matches"][0]["source"] == "discogs"
    assert payload["task"]["possible_matches"][0]["width"] == 700
    assert [item["id"] for item in payload["gallery"]["task"]["possible_matches"]] == [
        "candidate-old",
        "candidate-new",
    ]
    assert payload["gallery"]["remote_cover"]["url"] == persisted_remote_url
    assert cover_state_loads == [{str(track_path)}]
    assert extraction_calls[0]["urls"] == ["https://manual.example/cover"]
    assert extraction_calls[0]["user_agent"] == app.config["MUSICBRAINZ_USER_AGENT"]
    assert [call["message"] for call in log_calls] == [
        "Manual cover link extraction requested",
        "Manual cover link extraction completed",
    ]
    assert all(call["config"] is app.config for call in log_calls)
    assert all(call["logger"] is asgi_app.state.logger for call in log_calls)
    assert update_calls[0]["config"] is app.config
    assert image_status == 200
    assert image_headers["cache-control"] == "public, max-age=3600"
    assert image_headers["content-type"] == "image/jpeg"
    assert image_body == b"image-bytes"
    assert fetch_calls == [
        {
            "image_url": "https://images.example/new.jpg",
            "config": app.config,
            "user_agent": app.config["MUSICBRAINZ_USER_AGENT"],
        }
    ]
    assert missing_status == 400
    assert _decode_json(missing_body) == {"ok": False, "error": "Missing remote image URL"}

    monkeypatch.setattr(asgi_routes, "fetch_remote_cover_bytes", lambda image_url, **kwargs: (None, None))
    failed_status, _failed_headers, failed_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/cover-lookup/remote-image",
        query={"url": "https://images.example/fails.jpg"},
    )

    assert failed_status == 502
    assert _decode_json(failed_body) == {"ok": False, "error": "Failed to load remote image"}


def test_remote_candidate_image_download_does_not_block_cover_lookup_api(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    download_started = Event()
    release_download = Event()
    download_finished = Event()

    def held_remote_cover_fetch(_image_url, **_kwargs):
        download_started.set()
        release_download.wait()
        download_finished.set()
        return b"image-bytes", "image/jpeg"

    monkeypatch.setattr(asgi_routes, "fetch_remote_cover_bytes", held_remote_cover_fetch)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    async def exercise_concurrent_requests():
        image_request = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app,
                "GET",
                "/utilities/cover-lookup/remote-image",
                query={"url": "https://images.example/slow.jpg"},
            )
        )
        while not download_started.is_set() and not image_request.done():
            await asyncio.sleep(0.001)
        tasks_request = asyncio.create_task(
            _run_asgi_request_async(asgi_app, "GET", "/utilities/cover-lookup/tasks")
        )
        tasks_status, _tasks_headers, tasks_body = await tasks_request
        image_still_loading = download_started.is_set() and not download_finished.is_set()
        release_download.set()
        image_status, _image_headers, image_body = await image_request
        return tasks_status, tasks_body, image_still_loading, image_status, image_body

    deadlock_watchdog = Timer(5, release_download.set)
    deadlock_watchdog.daemon = True
    deadlock_watchdog.start()
    try:
        tasks_status, tasks_body, image_still_loading, image_status, image_body = asyncio.run(
            exercise_concurrent_requests()
        )
    finally:
        release_download.set()
        deadlock_watchdog.cancel()

    assert tasks_status == 200
    assert _decode_json(tasks_body)["ok"] is True
    assert image_still_loading is True
    assert image_status == 200
    assert image_body == b"image-bytes"


def test_bulk_cover_preparation_does_not_block_cover_lookup_api(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    preparation_started = Event()
    release_preparation = Event()
    preparation_finished = Event()

    def held_preparation(**_kwargs):
        preparation_started.set()
        release_preparation.wait()
        preparation_finished.set()
        return {"started": True, "queued_count": 3}

    monkeypatch.setattr(asgi_routes, "start_manual_cover_refresh_request", held_preparation)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    async def exercise_concurrent_requests():
        preparation_request = asyncio.create_task(
            _run_asgi_request_async(
                asgi_app, "POST", "/utilities/fetch-covers-unsuccessful",
                json_body={"force_search": True},
            )
        )
        try:
            while not preparation_started.is_set() and not preparation_request.done():
                await asyncio.sleep(0.001)
            tasks_status, _tasks_headers, tasks_body = await _run_asgi_request_async(
                asgi_app, "GET", "/utilities/cover-lookup/tasks"
            )
            preparation_still_running = (
                preparation_started.is_set() and not preparation_finished.is_set()
            )
        finally:
            release_preparation.set()
            preparation_response = await preparation_request
        return tasks_status, tasks_body, preparation_still_running, preparation_response

    deadlock_watchdog = Timer(5, release_preparation.set)
    deadlock_watchdog.daemon = True
    deadlock_watchdog.start()
    try:
        tasks_status, tasks_body, still_running, preparation_response = asyncio.run(
            exercise_concurrent_requests()
        )
    finally:
        release_preparation.set()
        deadlock_watchdog.cancel()
        deadlock_watchdog.join()

    assert tasks_status == 200
    assert _decode_json(tasks_body)["ok"] is True
    assert still_running is True
    status, _headers, body = preparation_response
    assert status == 200
    assert _decode_json(body)["queued_count"] == 3


def test_asgi_cover_lookup_save_remote_queues_selected_candidate(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    queued_calls: list[dict[str, object]] = []
    update_calls: list[dict[str, object]] = []
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[
            {
                "id": "candidate-1",
                "art_kind": "cover",
                "url": "https://images.example/cover.jpg",
                "thumbnail_url": "https://images.example/thumb.jpg",
                "source": "manual",
                "source_label": "Manual URL",
                "width": 1000,
                "height": 1000,
            }
        ],
    )

    original_update_cover_lookup_task = asgi_routes.update_cover_lookup_task

    def recording_update_cover_lookup_task(task_id, **kwargs):
        update_calls.append({"task_id": task_id, **kwargs})
        return original_update_cover_lookup_task(task_id, **kwargs)

    monkeypatch.setattr(asgi_routes, "update_cover_lookup_task", recording_update_cover_lookup_task)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": task_id, "candidate_id": "candidate-1"},
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["queued"] is True
    assert payload["optimistic_cover_path"] == str(track_path.parent / "cover.jpg")
    assert payload["optimistic_remote_url"] == "https://images.example/cover.jpg"
    assert payload["optimistic_remote_thumbnail_url"] == "https://images.example/thumb.jpg"
    assert payload["optimistic_remote_source"] == "manual"
    assert payload["optimistic_remote_source_label"] == "Manual URL"
    assert payload["optimistic_remote_album_url"] == ""
    assert payload["optimistic_remote_width"] == 1000
    assert payload["optimistic_remote_height"] == 1000
    assert payload["task"]["selected_candidate_id"] == "candidate-1"
    assert "gallery" not in payload
    assert update_calls[0]["config"] is app.config
    assert update_calls[0]["job_contract"]["job_kind"] == "save_remote_selection"
    assert update_calls[0]["job_contract"]["provider_groups"] == [
        "remote_image_download",
        "cover_writeback",
    ]
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][1] == track_path.parent
    assert queued_calls[0]["args"][2] == {str(track_path)}
    assert queued_calls[0]["kwargs"]["config"] is app.config
    assert queued_calls[0]["kwargs"]["logger"] is asgi_app.state.logger
    assert queued_calls[0]["kwargs"]["library_state"] is asgi_app.state.library_state
    assert queued_calls[0]["kwargs"]["user_agent"] == app.config["MUSICBRAINZ_USER_AGENT"]
    assert queued_calls[0]["kwargs"]["cover_selection_origin"] == "user"


@pytest.mark.parametrize(
    ("source", "source_label", "expected_display_only"),
    [
        ("apple", "Apple Music", False),
        ("deezer", "Deezer", False),
        ("youtube_music", "YouTube Music", False),
        ("spotify", "Spotify", True),
    ],
)
def test_asgi_cover_lookup_save_remote_honors_serialized_provider_storage_policy(
    app,
    monkeypatch,
    source,
    source_label,
    expected_display_only,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / source / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    candidate = cover_candidate_to_lookup_match(
        CoverCandidate(
            source=source,
            url=f"https://images.example/{source}.jpg",
            width=1600,
            height=1600,
            score=0.99,
            debug_payload={
                "source_label": source_label,
                "thumbnail_url": f"https://images.example/{source}-thumb.jpg",
                "album_url": f"https://catalog.example/{source}/album-1",
            },
        ),
        lookup_group="service",
    )
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[candidate],
    )
    queued_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": _album_payload(track_path),
            "task_id": task_id,
            "candidate_id": candidate["id"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert candidate["display_only"] is expected_display_only
    assert payload["optimistic_cover_path"] == (
        "" if expected_display_only else str(track_path.parent / "cover.jpg")
    )
    assert payload["optimistic_remote_source"] == source
    assert len(queued_calls) == 1
    queued_image = queued_calls[0]["args"][4]
    assert queued_image["source"] == source
    assert queued_image["display_only"] is expected_display_only


def test_asgi_cover_lookup_save_remote_allows_explicit_secondary_art_selection_from_any_provider(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    candidate = cover_candidate_to_lookup_match(
        CoverCandidate(
            source="cover_art_archive",
            url="https://images.example/caa-booklet.jpg",
            debug_payload={"art_kind": "other", "art_label": "Booklet"},
        ),
        lookup_group="cover_art_archive",
    )
    candidate["display_only"] = True  # Existing snapshots used the old preview-only policy.
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[candidate],
    )
    queued_calls = []
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": _album_payload(track_path),
            "task_id": task_id,
            "candidate_id": candidate["id"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["queued"] is True
    assert payload["optimistic_cover_path"] == str(track_path.parent / "cover.jpg")
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][4]["art_kind"] == "other"
    assert queued_calls[0]["args"][4]["display_only"] is False


def test_asgi_cover_lookup_save_remote_rejects_obsolete_snapshot_generation_before_queueing(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    reset_cover_lookup_runtime_state()
    repository_reads = []

    class CurrentSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            repository_reads.append(album_id)
            return {
                "album_id": album_id,
                "search_generation": "current-generation",
                "status": "completed",
                "candidates": [{
                    "id": "same-candidate-id",
                    "art_kind": "cover",
                    "url": "https://private-provider.example/current-cover.jpg",
                }],
            }

    def forbidden_save(*_args, **_kwargs):
        pytest.fail("An obsolete snapshot must not create or queue a save task")

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", CurrentSnapshotRepository)
    monkeypatch.setattr(asgi_routes, "create_cover_lookup_task", forbidden_save)
    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_save_remote_task", forbidden_save)
    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "snapshot_generation": "obsolete-generation",
            "candidate_id": "same-candidate-id",
        },
    )
    assert status == 404
    assert _decode_json(body) == {
        "ok": False,
        "error": "Saved cover candidate generation was not found",
    }
    assert repository_reads == [41]
    assert list_cover_lookup_tasks(config=app.config) == []


def test_asgi_cover_lookup_save_remote_accepts_equivalent_snapshot_uuid_after_restart(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    queued_calls: list[dict[str, object]] = []
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
        config=app.config,
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        config=app.config,
        status="completed",
        progress=100,
        finished_at="2026-10-24T00:00:00+00:00",
        result_kind="possible-matches",
    )
    generation = UUID(task_id)
    reset_cover_lookup_runtime_state()
    assert [task["id"] for task in list_cover_lookup_tasks(config=app.config)] == [task_id]

    class PersistedSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            return {
                "album_id": album_id,
                "search_generation": str(generation),
                "status": "completed",
                "candidates": [{
                    "id": "youtube-candidate",
                    "art_kind": "cover",
                    "url": "https://images.example/youtube.jpg",
                    "source": "youtube",
                }],
            }

    monkeypatch.setattr(
        asgi_routes,
        "AlbumCoverCandidateSnapshotRepository",
        PersistedSnapshotRepository,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "task_id": generation.hex,
            "snapshot_generation": generation.hex,
            "candidate_id": "youtube-candidate",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["task"]["id"] == generation.hex
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][0] == generation.hex
    assert queued_calls[0]["args"][4]["url"] == "https://images.example/youtube.jpg"


def test_asgi_cover_lookup_save_remote_accepts_canonical_snapshot_uuid_for_live_task(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    queued_calls: list[dict[str, object]] = []
    commit_guard_states: list[dict[str, object]] = []
    persisted_calls: list[dict[str, object]] = []
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    canonical_generation = str(UUID(task_id))
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[{
            "id": "generation-a-candidate",
            "art_kind": "cover",
            "url": "https://images.example/generation-a.jpg",
            "source": "apple",
        }],
    )

    class CurrentSnapshotRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            return {
                "album_id": album_id,
                "search_generation": str(UUID(int=2)),
                "status": "running",
                "candidates": [{
                    "id": "generation-b-candidate",
                    "art_kind": "cover",
                    "url": "https://images.example/generation-b.jpg",
                }],
            }

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", CurrentSnapshotRepository)
    monkeypatch.setattr(
        asgi_routes.state_service,
        "run_authoritative_cover_commit_for_state",
        lambda state, commit_action: (
            commit_guard_states.append(state),
            commit_action(),
        )[1],
    )

    def fake_persist_cover_selection(track_paths, cover_path, **kwargs):
        commit_guard = kwargs.get("commit_guard")
        assert callable(commit_guard)
        commit_result = commit_guard(lambda: "committed")
        persisted_calls.append({
            "track_paths": track_paths,
            "cover_path": cover_path,
            "kwargs": kwargs,
            "commit_result": commit_result,
        })
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    monkeypatch.setattr(
        asgi_routes,
        "persist_cover_selection_for_tracks",
        fake_persist_cover_selection,
    )
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "task_id": canonical_generation,
            "snapshot_generation": canonical_generation,
            "candidate_id": "generation-a-candidate",
        },
    )

    assert status == 200
    assert _decode_json(body)["task"]["selected_candidate_id"] == "generation-a-candidate"
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][0] == task_id
    assert queued_calls[0]["args"][4]["url"] == "https://images.example/generation-a.jpg"
    persist_callback = queued_calls[0]["kwargs"]["persist_cover_selection_for_tracks"]
    persisted_cover = track_path.parent / "cover.jpg"
    assert persist_callback(
        {str(track_path)},
        persisted_cover,
        cover_selection_origin="user",
        explicit_selection=True,
    ) == {"album_rows_updated": 1, "track_file_rows_updated": 1}
    assert commit_guard_states == [app.library_state]
    assert persisted_calls[0]["commit_result"] == "committed"


def test_asgi_cover_lookup_save_remote_queues_candidate_from_persisted_snapshot(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    queued_calls: list[dict[str, object]] = []
    repository_calls: list[int] = []
    reset_cover_lookup_runtime_state()

    class FakeRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            repository_calls.append(album_id)
            return {
                "album_id": album_id,
                "search_generation": "saved-generation",
                "search_kind": "automatic",
                "status": "completed",
                "revision": 4,
                "candidates": [
                    {
                        "id": "saved-candidate",
                        "art_kind": "cover",
                        "url": "https://images.example/saved.jpg",
                        "source": "apple",
                        "source_label": "Apple Music",
                        "width": 1400,
                        "height": 1400,
                    }
                ],
                "best_candidate_id": "saved-candidate",
            }

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "snapshot_generation": "saved-generation",
            "candidate_id": "saved-candidate",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["task"]["selected_candidate_id"] == "saved-candidate"
    assert repository_calls == [41]
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][4]["url"] == "https://images.example/saved.jpg"
    assert queued_calls[0]["kwargs"]["cover_selection_origin"] == "user"
    assert queued_calls[0]["kwargs"]["notification_action_taken"] is True
    assert list_cover_lookup_tasks(config=app.config) == []


def test_asgi_cover_lookup_save_remote_uses_requested_snapshot_candidate_when_task_exists(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    queued_calls: list[dict[str, object]] = []
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[
            {
                "id": "task-candidate",
                "art_kind": "cover",
                "url": "https://images.example/task.jpg",
                "source": "apple",
            }
        ],
    )

    class FakeRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            assert album_id == 41
            return {
                "album_id": album_id,
                "search_generation": "saved-generation",
                "search_kind": "automatic",
                "status": "completed",
                "revision": 4,
                "candidates": [
                    {
                        "id": "saved-candidate",
                        "art_kind": "cover",
                        "url": "https://images.example/saved.jpg",
                        "source": "apple",
                        "source_label": "Apple Music",
                        "width": 1400,
                        "height": 1400,
                    }
                ],
                "best_candidate_id": "saved-candidate",
            }

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "task_id": task_id,
            "snapshot_generation": "saved-generation",
            "candidate_id": "saved-candidate",
        },
    )

    assert status == 200
    assert _decode_json(body)["task"]["selected_candidate_id"] == "saved-candidate"
    assert len(queued_calls) == 1
    assert queued_calls[0]["args"][4]["url"] == "https://images.example/saved.jpg"


def test_asgi_cover_lookup_save_remote_recovers_task_from_snapshot_generation(
    app,
    monkeypatch,
):
    from uuid import UUID

    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    reset_cover_lookup_runtime_state()
    candidate = {
        "id": "saved-candidate",
        "art_kind": "cover",
        "url": "https://images.example/saved.jpg",
        "source": "apple",
    }
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
        _album_payload(track_path),
        {str(track_path)},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="running",
        possible_matches=[candidate],
    )
    snapshot_generation = str(UUID(task_id))

    class FakeRepository:
        def __init__(self, selected_config):
            assert selected_config is app.config

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 41

        def get_for_album_context(self, *, album_id):
            return {
                "album_id": album_id,
                "search_generation": snapshot_generation,
                "search_kind": "manual",
                "status": "running",
                "revision": 1,
                "candidates": [candidate],
                "best_candidate_id": candidate["id"],
            }

    queued_calls = []
    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda queued_task_id, *_args, **kwargs: queued_calls.append({
            "task_id": queued_task_id,
            "kwargs": kwargs,
        }),
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={
            "album": {**_album_payload(track_path), "album_id": 41},
            "snapshot_generation": snapshot_generation,
            "candidate_id": candidate["id"],
        },
    )

    assert status == 200
    assert _decode_json(body)["task"]["id"] == task_id
    assert [call["task_id"] for call in queued_calls] == [task_id]
    assert queued_calls[0]["kwargs"]["notification_action_taken"] is False


def test_asgi_cover_lookup_save_remote_keeps_action_taken_through_background_completion(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        config=app.config,
        status="completed",
        finished_at="2026-05-18T05:00:00+00:00",
        possible_matches=[
            {
                "id": "candidate-1",
                "art_kind": "cover",
                "url": "https://images.example/cover.jpg",
                "source": "manual",
                "source_label": "Manual URL",
            }
        ],
    )
    queued_calls = []
    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *_args, **kwargs: queued_calls.append(kwargs),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, _body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": task_id, "candidate_id": "candidate-1"},
    )
    queued_task = next(
        task for task in cover_lookup_tasks.list_cover_lookup_tasks(config=app.config) if task["id"] == task_id
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        config=app.config,
        status="completed",
        progress=100,
        progress_label="Completed",
        finished_at="2026-05-18T05:00:05+00:00",
        selected_candidate_id="candidate-1",
        result_kind="cover-updated",
        notification_action_taken=True,
    )

    assert status == 200
    assert queued_calls[0]["notification_action_taken"] is True
    assert queued_task["status"] == "running"
    assert queued_task["notification_action_taken"] is False
    completed_task = next(
        task for task in cover_lookup_tasks.list_cover_lookup_tasks(config=app.config) if task["id"] == task_id
    )
    assert completed_task["notification_action_taken"] is True
    assert completed_task["notification_completed_at"] == "2026-05-18T05:00:00+00:00"
    persisted_task = next(
        task for task in app.config["_TEST_COVER_LOOKUP_NOTIFICATIONS"] if task["id"] == task_id
    )
    assert persisted_task["notification_action_taken"] is True
    assert persisted_task["notification_completed_at"] == "2026-05-18T05:00:00+00:00"


def test_asgi_cover_lookup_save_remote_failure_remains_unactioned_and_not_bulk_clearable(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    original_lookup_completed_at = "2026-05-18T05:00:00+00:00"
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        config=app.config,
        status="completed",
        finished_at=original_lookup_completed_at,
        possible_matches=[
            {
                "id": "candidate-1",
                "art_kind": "cover",
                "url": "https://images.example/cover.jpg",
                "source": "manual",
                "source_label": "Manual URL",
            }
        ],
    )
    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_save_remote_task", lambda *_args, **_kwargs: None)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    save_status, _save_headers, _save_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": task_id, "candidate_id": "candidate-1"},
    )
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        config=app.config,
        status="failed",
        progress=100,
        progress_label="Save failed",
        finished_at="2026-05-18T05:00:05+00:00",
        message="Failed to download the selected cover",
    )
    failed_task = next(
        task for task in cover_lookup_tasks.list_cover_lookup_tasks(config=app.config) if task["id"] == task_id
    )
    actioned_task_ids = [
        task["id"]
        for task in cover_lookup_tasks.list_cover_lookup_tasks(config=app.config)
        if task["notification_action_taken"]
    ]
    clear_status, _clear_headers, clear_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/tasks/clear-completed",
        json_body={"task_ids": actioned_task_ids},
    )

    assert save_status == 200
    assert failed_task["status"] == "failed"
    assert failed_task["progress_label"] == "Save failed"
    assert failed_task["notification_action_taken"] is False
    assert failed_task["notification_completed_at"] == original_lookup_completed_at
    assert actioned_task_ids == []
    assert clear_status == 200
    clear_payload = _decode_json(clear_body)
    assert clear_payload["removed_count"] == 0
    assert [task["id"] for task in clear_payload["tasks"]] == [task_id]


def test_asgi_cover_lookup_save_remote_validates_task_and_candidate_before_queueing(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(_album_payload(track_path), {str(track_path)})
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[
            {"id": "candidate-other", "art_kind": "cover", "url": "https://images.example/other.jpg"},
            {"id": "candidate-preview", "art_kind": "preview", "url": "https://images.example/preview.jpg"},
        ],
    )

    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Invalid selections must not queue")),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    missing_task_status, _missing_task_headers, missing_task_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": "missing-task", "candidate_id": "candidate-1"},
    )
    missing_candidate_status, _missing_candidate_headers, missing_candidate_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": task_id, "candidate_id": "candidate-missing"},
    )
    preview_status, _preview_headers, preview_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": _album_payload(track_path), "task_id": task_id, "candidate_id": "candidate-preview"},
    )

    assert missing_task_status == 404
    assert _decode_json(missing_task_body) == {"ok": False, "error": "Lookup task not found"}
    assert missing_candidate_status == 404
    assert _decode_json(missing_candidate_body) == {
        "ok": False,
        "error": "Selected remote candidate was not found",
    }
    assert preview_status == 400
    assert _decode_json(preview_body) == {
        "ok": False,
        "error": "This remote image is preview-only and cannot be selected as the album cover",
    }


def test_asgi_cover_lookup_save_remote_rejects_unsafe_roots_and_queues_distributed_albums(
    app,
    monkeypatch,
    tmp_path: Path,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import cover_lookup_tasks
    from music_app.services.library_roots import save_library_root_settings

    library_root = (tmp_path / "Library").resolve()
    album_root = (library_root / "Artist" / "Album").resolve()
    lp_one = (album_root / "LP 1" / "one.mp3").resolve()
    lp_two = (album_root / "LP 2" / "two.mp3").resolve()
    traversal_target = (tmp_path / "Outside" / "Artist" / "Album" / "outside.mp3").resolve()
    other_root = (tmp_path / "OtherLibrary").resolve()
    cross_root_track = (other_root / "Artist" / "Album" / "two.mp3").resolve()
    mixed_album_track = (library_root / "Artist" / "Other Album" / "three.mp3").resolve()
    for track_path in (lp_one, lp_two, traversal_target, cross_root_track, mixed_album_track):
        track_path.parent.mkdir(parents=True, exist_ok=True)
        track_path.write_bytes(b"track")
        app.library_state["file_cache"][str(track_path)] = {"path": str(track_path)}
    valid_album = {
        "name": "Test Album",
        "album_artist": "Test Artist",
        "year": 2001,
        "edition": "",
        "tracks": [{"path": str(lp_one)}, {"path": str(lp_two)}],
    }
    traversal_album = {
        **valid_album,
        "tracks": [{"path": str(library_root / ".." / "Outside" / "Artist" / "Album" / "outside.mp3")}],
    }
    mixed_unsafe_album = {
        **valid_album,
        "tracks": [{"path": str(lp_one)}, {"path": str(library_root / ".." / "Outside" / "Artist" / "Album" / "outside.mp3")}],
    }
    cross_root_album = {
        **valid_album,
        "tracks": [{"path": str(lp_one)}, {"path": str(cross_root_track)}],
    }
    mixed_album_folders = {
        **valid_album,
        "tracks": [{"path": str(lp_one)}, {"path": str(mixed_album_track)}],
    }
    queued_calls: list[dict[str, object]] = []

    save_library_root_settings(
        app.config,
        {
            "main_library_roots": [
                {"id": "main-1", "path": str(library_root), "layout_mode": "artist"},
                {"id": "main-2", "path": str(other_root), "layout_mode": "artist"},
            ],
        },
    )
    reset_cover_lookup_runtime_state()
    task_id, _ = cover_lookup_tasks.create_cover_lookup_task(valid_album, {str(lp_one), str(lp_two)})
    candidate = {"id": "candidate-1", "art_kind": "cover", "url": "https://images.example/cover.jpg"}
    cover_lookup_tasks.update_cover_lookup_task(
        task_id,
        status="completed",
        possible_matches=[candidate],
    )

    monkeypatch.setattr(
        asgi_routes,
        "queue_cover_lookup_save_remote_task",
        lambda *args, **kwargs: queued_calls.append({"args": args, "kwargs": kwargs}),
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    valid_status, _valid_headers, valid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/save-remote",
        json_body={"album": valid_album, "task_id": task_id, "candidate_id": "candidate-1"},
    )
    invalid_payloads = [traversal_album, mixed_unsafe_album]
    for album in invalid_payloads:
        assert asgi_routes.resolve_album_context(app.config, album) is None
        invalid_task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
            album,
            {str(track["path"]) for track in album["tracks"]},
        )
        cover_lookup_tasks.update_cover_lookup_task(
            invalid_task_id,
            status="completed",
            possible_matches=[candidate],
        )
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/cover-lookup/save-remote",
            json_body={"album": album, "task_id": invalid_task_id, "candidate_id": "candidate-1"},
        )
        assert status == 400
        assert _decode_json(body) == {"ok": False, "error": "Album root could not be resolved"}

    for album in (cross_root_album, mixed_album_folders):
        distributed_task_id, _ = cover_lookup_tasks.create_cover_lookup_task(
            album,
            {str(track["path"]) for track in album["tracks"]},
        )
        cover_lookup_tasks.update_cover_lookup_task(
            distributed_task_id,
            status="completed",
            possible_matches=[candidate],
        )
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/cover-lookup/save-remote",
            json_body={"album": album, "task_id": distributed_task_id, "candidate_id": "candidate-1"},
        )
        assert status == 200, body

    assert valid_status == 200
    assert _decode_json(valid_body)["optimistic_cover_path"] == str(album_root / "cover.jpg")
    assert len(queued_calls) == 3
    assert queued_calls[0]["args"][1] == album_root
    assert queued_calls[1]["args"][1] == lp_one.parent
    assert queued_calls[2]["args"][1] == lp_one.parent
    assert not (traversal_target.parent / "cover.jpg").exists()
    assert not (library_root / "Artist" / "cover.jpg").exists()
    assert not (tmp_path / "cover.jpg").exists()


def test_asgi_cover_lookup_gallery_rebinds_persisted_notification_after_album_identity_change(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_cover_state_entries_by_paths",
        lambda _self, _paths: {},
    )

    track_path = (
        app.config["MUSIC_DIR"]
        / "Аквариум"
        / "Сергей Курёхин в Аквариуме"
        / "CD2"
        / "01.mp3"
    ).resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    _seed_album_state(app.library_state, track_path)

    stale_album = {
        "album_id": 418526,
        "key": "аквариум::сергей курёхин в аквариуме: концерт в жуковском",
        "name": "Сергей Курёхин в Аквариуме: Концерт в Жуковском",
        "tracks": [],
    }
    persisted_task = {
        "id": "persisted-stale-notification",
        "status": "completed",
        "track_paths": [str(track_path)],
        "possible_matches": [
            {
                "id": "preserved-candidate",
                "art_kind": "cover",
                "url": "https://images.example/preserved.jpg",
            }
        ],
        "album_payload": stale_album,
    }
    resolved_context_calls = []

    class FakeRepository:
        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            assert track_paths == {str(track_path)}
            return 641037

        def resolve_album_track_context(self, *, album_id, album_key):
            resolved_context_calls.append((album_id, album_key))
            assert album_id == 641037
            assert album_key is None
            return {
                "album_id": 641037,
                "album_key": "аквариум::сергей курёхин в «аквариуме»::концерт в жуковском",
                "track_paths": [str(track_path)],
            }

        def get_for_album_context(self, *, album_id):
            assert album_id == 641037
            return None

    monkeypatch.setattr(asgi_routes, "AlbumCoverCandidateSnapshotRepository", FakeRepository)
    monkeypatch.setattr(asgi_routes, "cover_lookup_result", lambda _task_id: {})
    monkeypatch.setattr(
        asgi_routes,
        "load_cover_lookup_notification",
        lambda _config, task_id: persisted_task if task_id == persisted_task["id"] else None,
        raising=False,
    )

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/gallery",
        json_body={"album": stale_album, "task_id": persisted_task["id"]},
    )
    payload = _decode_json(body)

    assert status == 200
    assert payload["ok"] is True
    assert payload["album_root"] == str(track_path.parent.parent)
    assert payload["task"]["id"] == persisted_task["id"]
    assert payload["task"]["possible_matches"][0]["id"] == "preserved-candidate"
    assert resolved_context_calls == [(641037, None)]


def test_asgi_cover_refresh_routes_preserve_manual_payloads_and_cancel_status(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services import state as state_module

    monkeypatch.setattr("music_app.services.problematic_albums.load_ignored_repair_keys", lambda _config: set())
    monkeypatch.setattr("music_app.services.problematic_albums.load_separate_release_keys", lambda _config: set())
    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    _seed_album_state(app.library_state, track_path)
    app.library_state["covers_in_progress"] = True

    single_refresh_calls: list[dict[str, object]] = []
    background_refresh_calls: list[dict[str, object]] = []
    cache_snapshot_calls: list[dict[str, object]] = []
    unsuccessful_refresh_calls: list[dict[str, object]] = []
    bulk_start_calls: list[dict[str, object]] = []

    def fake_refresh_cover_artwork_for_track_paths_for_state(
        library_state,
        config,
        logger,
        track_paths,
        *,
        force_search,
    ):
        single_refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "track_paths": track_paths,
                "force_search": force_search,
            }
        )
        return {
            "processed": 1,
            "downloaded": 1,
            "skipped": 0,
            "failed": 0,
            "job_results": [{"path": str(track_path), "status": "downloaded"}],
        }

    monkeypatch.setattr(
        asgi_routes.state_service,
        "refresh_cover_artwork_for_track_paths_for_state",
        fake_refresh_cover_artwork_for_track_paths_for_state,
    )

    def fake_start_background_refresh_for_state(library_state, config, logger, **kwargs):
        background_refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": kwargs.get("force"),
                "scan_mode": kwargs.get("scan_mode"),
            }
        )

    monkeypatch.setattr(
        asgi_routes.state_service,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )

    def fake_cover_file_cache_snapshot_for_state(library_state, config):
        cache_snapshot_calls.append({"library_state": library_state, "config": config})
        return {"snap": {"path": "snap"}}

    monkeypatch.setattr(
        asgi_routes.state_service,
        "cover_file_cache_snapshot_for_state",
        fake_cover_file_cache_snapshot_for_state,
    )

    prepared_request = object()

    def fake_refresh_unsuccessful_cover_artwork_for_state(library_state, config, logger, *, force_search, prepared=None):
        assert prepared is prepared_request
        unsuccessful_refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force_search": force_search,
            }
        )
        return {"processed": 3}

    monkeypatch.setattr(
        asgi_routes.state_service,
        "refresh_unsuccessful_cover_artwork_for_state",
        fake_refresh_unsuccessful_cover_artwork_for_state,
    )

    def fake_start_manual_cover_refresh_request(**kwargs):
        bulk_start_calls.append(
            {
                "config": kwargs.get("config"),
                "logger": kwargs.get("logger"),
                "state": kwargs["get_state"](),
                "snapshot": kwargs["get_file_cache_snapshot"](),
                "submit_cover_job": kwargs.get("submit_cover_job"),
                "force_search": kwargs.get("force_search"),
                "defer_preparation": kwargs.get("defer_preparation"),
            }
        )
        kwargs["start_background_refresh"](force=True, scan_mode="manual")
        kwargs["refresh_unsuccessful_cover_artwork"](force_search=True, prepared=prepared_request)
        return {
            "started": True,
            "already_running": False,
            "queued_after_indexing": False,
            "queued_count": 3,
            "current_folder": "Artist/Album",
        }

    monkeypatch.setattr(asgi_routes, "start_manual_cover_refresh_request", fake_start_manual_cover_refresh_request)
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        asgi_routes,
        "find_problematic_album_by_track_paths_in_state",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Cover refresh must not build the global Problematic Files payload")
        ),
        raising=False,
    )
    detail_calls: list[str] = []

    def fake_build_problematic_album_detail_payload(album_key, **_kwargs):
        detail_calls.append(album_key)
        return {"key": album_key}

    monkeypatch.setattr(
        asgi_routes,
        "build_problematic_album_detail_payload",
        fake_build_problematic_album_detail_payload,
        raising=False,
    )
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge("manual cover-refresh routes must use ASGI state")

    single_status, _single_headers, single_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/fetch-cover",
        json_body={"album": _album_payload(track_path)},
    )
    bulk_status, _bulk_headers, bulk_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/fetch-covers-unsuccessful",
        json_body={"force_search": True},
    )
    cancel_status, _cancel_headers, cancel_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cancel-cover-scan",
    )

    single_payload = _decode_json(single_body)
    assert single_status == 200
    assert single_payload["mode"] == "manual-single"
    assert single_payload["force_search_used"] is True
    assert single_payload["processed_count"] == 1
    assert single_payload["job_result"] == {"path": str(track_path), "status": "downloaded"}
    assert single_payload["updated_album"]["key"] == "album-1"
    assert single_payload["updated_problematic_album"] == {"key": "album-1"}
    assert detail_calls == ["album-1"]
    assert single_refresh_calls == [
        {
            "library_state": asgi_app.state.library_state,
            "config": app.config,
            "logger": asgi_app.state.logger,
            "track_paths": {str(track_path)},
            "force_search": True,
        }
    ]
    bulk_payload = _decode_json(bulk_body)
    assert bulk_status == 200
    assert bulk_payload["mode"] == "manual-bulk"
    assert bulk_payload["started"] is True
    assert bulk_payload["queued_count"] == 3
    assert bulk_payload["force_search_used"] is True
    assert bulk_start_calls == [
        {
            "config": app.config,
            "logger": asgi_app.state.logger,
            "state": asgi_app.state.library_state,
            "snapshot": {"snap": {"path": "snap"}},
            "submit_cover_job": asgi_routes.state_service._COVER_EXECUTOR.submit,
            "force_search": True,
            "defer_preparation": True,
        }
    ]
    assert background_refresh_calls == [
        {
            "library_state": asgi_app.state.library_state,
            "config": app.config,
            "logger": asgi_app.state.logger,
            "force": True,
            "scan_mode": "manual",
        }
    ]
    assert cache_snapshot_calls == [{
        "library_state": asgi_app.state.library_state,
        "config": app.config,
    }]
    assert unsuccessful_refresh_calls == [
        {
            "library_state": asgi_app.state.library_state,
            "config": app.config,
            "logger": asgi_app.state.logger,
            "force_search": True,
        }
    ]
    assert cancel_status == 200
    assert _decode_json(cancel_body) == {"ok": True, "cancelled": True, "covers_in_progress": False}
    assert asgi_app.state.library_state["covers_in_progress"] is False


def test_asgi_cover_refresh_manual_single_returns_500_on_refresh_failure(app, monkeypatch):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    log_calls: list[dict[str, object]] = []

    def fail_refresh(*_args, **_kwargs):
        raise RuntimeError("boom")

    def fake_log_app_event(config, logger, message, **kwargs):
        log_calls.append({"config": config, "logger": logger, "message": message, **kwargs})

    monkeypatch.setattr(asgi_routes.state_service, "refresh_cover_artwork_for_track_paths_for_state", fail_refresh)
    monkeypatch.setattr(asgi_routes, "log_app_event", fake_log_app_event)
    asgi_app = _make_wave_d_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/fetch-cover",
        json_body={"album": _album_payload(track_path)},
    )

    assert status == 500
    assert _decode_json(body) == {"ok": False, "error": "boom"}
    assert log_calls == [
        {
            "config": app.config,
            "logger": asgi_app.state.logger,
            "message": "Cover art update failed",
            "history_scope": HistoryScope(account_id=1, library_id=1, origin_kind="request"),
            "level": "error",
            "history": True,
            "artist": "Test Artist",
            "album": "Test Album",
            "error": "boom",
            "mode": "manual",
        }
    ]


def test_local_cover_selection_uses_postgres_inventory_with_empty_runtime_state(app, monkeypatch):
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    original_seed = _seed_album_state
    inventory = {}

    def seed_database_inventory(state, track_path):
        original_seed(state, track_path)
        inventory.update({path: {**entry, "title": "Song"} for path, entry in state["file_cache"].items()})
        state["file_cache"] = {}
        state["albums"] = []

    def selected_entries(self, paths):
        return {path: inventory[path] for path in paths if path in inventory}

    def selected_albums(self, paths):
        return [{"key": "artist-album", "tracks": [
            {**entry, "path": path} for path, entry in selected_entries(self, paths).items()
        ]}]

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://unused@localhost/test"
    monkeypatch.setitem(globals(), "_seed_album_state", seed_database_inventory)
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_track_file_entries_by_paths", selected_entries)
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths", selected_entries)
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_album_payloads_by_track_paths", selected_albums)
    test_asgi_local_cover_selection_persists_before_success_and_logs_safe_completion(app, monkeypatch)


@pytest.mark.parametrize("partial_cache", [False, True])
def test_postgres_local_cover_commit_updates_live_runtime_not_inventory_snapshot(app, monkeypatch, partial_cache):
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.routes import api_cover_helpers
    monkeypatch.setattr(
        api_cover_helpers,
        "build_problematic_album_detail_payload",
        lambda *_args, **_kwargs: None,
    )
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    selected_image = track_path.parent / "Front.jpg"
    selected_image.write_bytes(_jpeg_bytes((40, 180, 220)))
    _seed_album_state(app.library_state, track_path)
    selected_entry = {**app.library_state["file_cache"][str(track_path)], "title": "Song"}
    sibling_path = str(track_path.parent / "second.mp3")
    Path(sibling_path).write_bytes(b"track")
    inventory = {
        str(track_path): selected_entry,
        sibling_path: {**selected_entry, "title": "Second", "path": sibling_path},
    }
    app.library_state["file_cache"] = {str(track_path): dict(selected_entry)} if partial_cache else {}
    app.library_state["albums"] = []
    app.library_state["scan_generation"] = 12
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://unused@localhost/test"
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_album_payloads_by_track_paths",
                        lambda self, paths: [{"tracks": [{**entry, "path": path} for path, entry in inventory.items()]}])
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_track_file_entries_by_paths",
                        lambda self, paths: {path: dict(inventory[path]) for path in paths})
    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths",
                        lambda self, paths: {path: dict(inventory[path]) for path in paths})
    monkeypatch.setattr(routes, "persist_cover_selection_for_tracks",
                        lambda *args, **kwargs: kwargs["commit_guard"](lambda: {"album_rows_updated": 1, "track_file_rows_updated": 2}))
    monkeypatch.setattr(routes, "log_app_event", lambda *args, **kwargs: None)
    album = _album_payload(track_path)
    album["tracks"] = [{"path": sibling_path}]
    status, _, body = _run_asgi_request(_make_wave_d_app(app), "POST", "/utilities/cover-lookup/local-select",
        json_body={"album": album, "source_path": str(selected_image)})
    assert status == 200, body
    assert app.library_state["scan_generation"] == 13
    assert _decode_json(body)["updated_album"]["cover_path"] == str(track_path.parent / "cover.jpg")
    assert {track["path"] for track in _decode_json(body)["updated_album"]["tracks"]} == set(inventory)
    if partial_cache:
        assert app.library_state["file_cache"][str(track_path)]["cover_path"] == str(track_path.parent / "cover.jpg")
    assert set(app.library_state["file_cache"]) == ({str(track_path)} if partial_cache else set())


@pytest.mark.parametrize("cached", [False, True])
def test_cover_gallery_reads_saved_remote_cover_from_postgres_when_runtime_cache_is_stale(
    app,
    monkeypatch,
    cached,
):
    from music_app.routes import api_wave_d_asgi_routes as routes
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (app.config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    entry = {
        "remote_cover_url": "https://images.example/saved-cover.jpg",
        "remote_cover_thumbnail_url": "https://images.example/saved-thumb.jpg",
        "remote_cover_source": "spotify",
        "remote_cover_source_label": "Spotify",
        "remote_cover_album_url": "https://open.spotify.com/album/saved",
        "remote_cover_width": 640,
        "remote_cover_height": 640,
    }
    cached_entry = {
        **entry,
        "remote_cover_url": "https://images.example/stale-cover.jpg",
        "remote_cover_thumbnail_url": "https://images.example/stale-thumb.jpg",
    }
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://unused@localhost/test"
    app.library_state["file_cache"] = (
        {str(track_path): dict(cached_entry)} if cached else {}
    )
    app.library_state["albums"] = []
    loads = []

    def selected_entries(self, paths):
        loads.append(set(paths))
        return {str(track_path): dict(entry)}

    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_cover_state_entries_by_paths", selected_entries)
    repository = SimpleNamespace(get_for_album_context=lambda **kwargs: {})
    monkeypatch.setattr(routes, "_resolved_snapshot_album_context", lambda *args: (repository, 41, None))
    status, _, body = _run_asgi_request(
        _make_wave_d_app(app), "POST", "/utilities/cover-lookup/gallery",
        json_body={"album": _album_payload(track_path)},
    )
    assert status == 200, body
    remote = _decode_json(body)["remote_cover"]
    assert remote is not None
    assert remote["url"] == entry["remote_cover_url"]
    assert remote["thumbnail_url"] == entry["remote_cover_thumbnail_url"]
    assert remote["source"] == "spotify"
    assert remote["source_label"] == "Spotify"
    assert remote["album_url"] == entry["remote_cover_album_url"]
    assert (remote["width"], remote["height"]) == (640, 640)
    assert loads == [{str(track_path)}]
    assert app.library_state["file_cache"] == (
        {str(track_path): cached_entry} if cached else {}
    )


def test_cover_lookup_task_identity_does_not_repeat_validated_album_resolution():
    from music_app.routes import api_wave_d_asgi_routes as routes

    assert routes._task_matches_album_context(
        {"track_paths": ["C:/Music/Artist/Album/song.mp3"]},
        track_paths={"C:/Music/Artist/Album/song.mp3"},
    ) is True


@pytest.mark.parametrize("compact_request", [False, True])
def test_cover_lookup_start_uses_recorded_edit_destination_before_stale_album_lookup(
    app,
    monkeypatch,
    compact_request,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    monkeypatch.setattr(asgi_routes, "perf_counter", lambda: 100.0)

    stale_path = (
        app.config["MUSIC_DIR"] / "Ovderhead" / "Telepathic Minds" / "05.mp3"
    ).resolve()
    current_path = (
        app.config["MUSIC_DIR"] / "Overhead" / "Telepathic Minds" / "05.mp3"
    ).resolve()
    stale_path.parent.mkdir(parents=True, exist_ok=True)
    stale_path.write_bytes(b"stale track")
    current_path.parent.mkdir(parents=True, exist_ok=True)
    current_path.write_bytes(b"track")
    album = {
        **_album_payload(stale_path),
        "album_id": 14674,
        "key": "ovderhead::telepathic minds",
    }
    if compact_request:
        album["tracks"] = []
    refreshed_album = {
        **_album_payload(current_path),
        "album_id": 24674,
        "key": "overhead::telepathic minds",
        "album_artist": "Overhead",
    }
    compact_source_album = {
        **_album_payload(stale_path),
        "album_id": 14674,
        "tracks": [],
    }
    events = []

    class Reservation:
        def release(self):
            events.append("released")

    def acquire_reservation(resource_keys, *, cancel_event=None):
        assert cancel_event is not None
        events.append(("acquired", resource_keys))
        return Reservation()

    def refresh_album(_self, album_id, *, client_surface_class=None):
        events.append(("refreshed", album_id, client_surface_class))
        if album_id == 14674:
            return compact_source_album
        return refreshed_album if album_id == 24674 else None

    def latest_structural_destination(resource_keys, *, completed_after_monotonic):
        assert completed_after_monotonic == pytest.approx(70.0)
        events.append(("reconciled", resource_keys, completed_after_monotonic))
        return {"destination_album_id": 24674}

    def queue_lookup(queued_album, track_paths, manual_urls, **kwargs):
        events.append(
            ("queued", queued_album, track_paths, manual_urls, kwargs.get("prepare"))
        )
        return "task-1"

    monkeypatch.setattr(
        asgi_routes,
        "acquire_structural_tag_edit_reservation",
        acquire_reservation,
        raising=False,
    )
    monkeypatch.setattr(
        PostgresLibraryBrowseRepository,
        "build_album_detail_payload_by_id",
        refresh_album,
        raising=False,
    )
    monkeypatch.setattr(
        asgi_routes,
        "latest_structural_tag_edit_destination",
        latest_structural_destination,
        raising=False,
    )
    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_task", queue_lookup)
    monkeypatch.setattr(
        asgi_routes,
        "cover_lookup_result",
        lambda task_id: {"id": task_id, "status": "queued"},
    )
    monkeypatch.setattr(
        asgi_routes,
        "serialize_cover_lookup_task_payload",
        lambda payload: payload,
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)

    asgi_app = _make_wave_d_app(app)
    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/cover-lookup/start",
        json_body={"album": album, "manual_urls": []},
    )

    assert status == 200
    assert _decode_json(body)["ok"] is True
    assert [event[0] if isinstance(event, tuple) else event for event in events] == [
        "queued"
    ]
    queued = events[0]
    assert queued[1] == album
    assert queued[2] == (set() if compact_request else {str(stale_path)})
    assert callable(queued[4])

    prepared_album, prepared_paths = queued[4](queued[1], queued[2], Event())

    acquired = events[1]
    assert acquired[0] == "acquired"
    assert "album:ovderhead::telepathic minds" in acquired[1]
    stale_path_key = next(iter(asgi_routes.structural_tag_edit_resource_keys(
        "",
        {str(stale_path)},
    )))
    assert (stale_path_key in acquired[1]) is not compact_request
    assert events[2][0] == "reconciled"
    assert events[2][1] == acquired[1]
    assert events[2][2] > 0
    assert events[3] == ("refreshed", 24674, None)
    assert events[4] == "released"
    assert prepared_album["album_artist"] == "Overhead"
    assert prepared_paths == {str(current_path)}


def test_cover_lookup_start_recovers_compact_notification_album_from_persisted_task(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_path = (
        app.config["MUSIC_DIR"] / "Eden" / "Perelandra" / "01.mp3"
    ).resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    compact_album = {
        "key": "eden::perelandra",
        "album_artist": "Eden",
        "name": "Perelandra",
        "year": 1980,
    }
    persisted_task = {
        "id": "persisted-eden-lookup",
        "status": "failed",
        "album_payload": _album_payload(track_path),
    }
    captured = {}

    async def resolve_context(_config, album, *, fallback_track_paths=None):
        captured["fallback_track_paths"] = fallback_track_paths
        hydrated_album = {**album, "tracks": [{"path": str(track_path)}]}
        return hydrated_album, asgi_routes.CoverAlbumContext(
            album_root=track_path.parent,
            track_paths={str(track_path)},
        )

    def queue_lookup(album, track_paths, _manual_urls, **_kwargs):
        captured["queued_album"] = album
        captured["queued_paths"] = track_paths
        captured.update(_kwargs)
        return "new-eden-lookup"

    monkeypatch.setattr(asgi_routes, "_resolve_album_payload_context", resolve_context)
    monkeypatch.setattr(
        asgi_routes,
        "load_cover_lookup_notification",
        lambda _config, task_id: persisted_task if task_id == persisted_task["id"] else None,
    )
    monkeypatch.setattr(
        asgi_routes,
        "cover_lookup_result",
        lambda task_id: (
            {"id": task_id, "status": "pending"}
            if task_id == "new-eden-lookup"
            else {}
        ),
    )
    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_task", queue_lookup)
    monkeypatch.setattr(
        asgi_routes,
        "serialize_cover_lookup_task_payload",
        lambda payload: payload,
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/start",
        json_body={
            "album": compact_album,
            "task_id": persisted_task["id"],
            "manual_urls": [],
        },
    )

    assert status == 200, body
    assert captured["fallback_track_paths"] == {str(track_path)}
    assert captured["queued_paths"] == {str(track_path)}
    assert captured["preferred_task_id"] == persisted_task["id"]
    assert captured["allow_preferred_path_rebind"] is True


def test_cover_lookup_reconciliation_uses_inline_album_detail_track_rows():
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes

    track_row = {"path": "C:/Music/Overhead/Telepathic Minds/05.mp3"}
    compact_album = {
        "tracks": [],
        "gallery_list_block": {
            "track_rows_source": "inline",
            "track_rows": [track_row],
        },
    }

    hydrated_album = asgi_routes._album_with_context_tracks(compact_album)

    assert hydrated_album["tracks"] == [track_row]
    assert compact_album["tracks"] == []


def test_cover_lookup_start_recovers_empty_id_projection_by_track_paths(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes as asgi_routes
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    track_path = (
        app.config["MUSIC_DIR"] / "Ovderhead" / "Telepathic Minds" / "05.mp3"
    ).resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    source_album = {
        **_album_payload(track_path),
        "album_id": 14674,
        "key": "ovderhead::telepathic minds",
    }
    compact_source_album = {**source_album, "tracks": []}
    current_album = {
        **_album_payload(track_path),
        "album_id": 24674,
        "key": "overhead::telepathic minds",
        "album_artist": "Overhead",
    }
    queued = []

    class Reservation:
        def release(self):
            pass

    class Repository:
        def __init__(self, _config):
            pass

        def build_album_detail_payload_by_id(self, album_id, *, client_surface_class=None):
            assert album_id == 14674
            return compact_source_album

        def build_album_payloads_by_track_paths(self, track_paths):
            assert track_paths == {str(track_path)}
            return [current_album]

    def acquire_reservation(_resource_keys, *, cancel_event=None):
        assert cancel_event is not None
        return Reservation()

    def queue_lookup(album, track_paths, _manual_urls, **kwargs):
        queued.append((album, track_paths, kwargs.get("prepare")))
        return "task-1"

    monkeypatch.setattr(
        asgi_routes,
        "acquire_structural_tag_edit_reservation",
        acquire_reservation,
    )
    monkeypatch.setattr(asgi_routes, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(
        asgi_routes,
        "latest_structural_tag_edit_destination",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(asgi_routes, "queue_cover_lookup_task", queue_lookup)
    monkeypatch.setattr(
        asgi_routes,
        "cover_lookup_result",
        lambda task_id: {"id": task_id, "status": "queued"},
    )
    monkeypatch.setattr(
        asgi_routes,
        "serialize_cover_lookup_task_payload",
        lambda payload: payload,
    )
    monkeypatch.setattr(asgi_routes, "log_app_event", lambda *_args, **_kwargs: None)

    status, _headers, body = _run_asgi_request(
        _make_wave_d_app(app),
        "POST",
        "/utilities/cover-lookup/start",
        json_body={"album": source_album, "manual_urls": []},
    )

    assert status == 200, body
    assert queued[0][0] == source_album
    assert queued[0][1] == {str(track_path)}
    assert callable(queued[0][2])

    prepared_album, prepared_paths = queued[0][2](
        queued[0][0],
        queued[0][1],
        Event(),
    )

    assert prepared_album["album_artist"] == "Overhead"
    assert prepared_paths == {str(track_path)}
