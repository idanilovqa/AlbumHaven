from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import re
import threading
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from music_app.services import startup_bootstrap
from music_app.services.loops import loop_previews_dir, loops_dir, save_loops
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import decode_json as _decode_json
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import run_asgi_request as _run_asgi_request
from tests.py.asgi_testing import runtime_app_from_asgi_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


def _make_asgi_app(flask_app=None):
    from music_app import create_asgi_app

    asgi_app = create_asgi_app()
    if flask_app is not None:
        asgi_app.state.config = flask_app.config
        asgi_app.state.library_state = flask_app.library_state
        asgi_app.state.logger = flask_app.logger
    return asgi_app


def _configure_selected_postgres_library_roots(config, monkeypatch) -> None:
    from music_app.services.library_roots import normalize_library_root_settings

    class FakePsycopg:
        @staticmethod
        def connect(*_args, **_kwargs):
            raise AssertionError("ASGI web route tests must not open a database connection")

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, store_config):
            self._config = store_config

        def load_settings(self):
            return normalize_library_root_settings(
                {},
                fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
            )

    config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    config["PERSISTENCE_BACKENDS"] = {
        **dict(config.get("PERSISTENCE_BACKENDS") or {}),
        "library_roots": "postgres",
    }
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )


def _assert_flask_like_private_media_not_found(headers: dict[str, str], body: bytes) -> None:
    assert headers.get("content-type", "").startswith("text/html")
    assert b"<!doctype html>" in body
    assert b"<title>404 Not Found</title>" in body
    assert b"<h1>Not Found</h1>" in body


class _FatalFlaskBridge:
    @property
    def config(self):
        raise AssertionError("ASGI media routes must use request.app.state.config")

    @property
    def logger(self):
        raise AssertionError("ASGI media routes must use request.app.state logger")

    def app_context(self):
        raise AssertionError("ASGI media routes must not enter Flask app context")

    def test_request_context(self, *_args, **_kwargs):
        raise AssertionError("ASGI web routes must not enter Flask test_request_context")


class _RecordingLogger:
    def __init__(self):
        self.warnings = []
        self.exceptions = []
        self.exception_kwargs = []
        self.logs = []

    def log(self, level, message, *args, **kwargs):
        self.logs.append((level, message, args, kwargs))

    def warning(self, message, *args):
        self.warnings.append((message, args))

    def exception(self, message, *args, **kwargs):
        self.exceptions.append((message, args))
        self.exception_kwargs.append(kwargs)


def _extract_bootstrap_payload_from_shell(body: bytes) -> dict[str, object]:
    marker = "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = "
    text = body.decode("utf-8")
    start = text.index(marker) + len(marker)
    end = text.index(";", start)
    payload = json.loads(text[start:end])
    assert isinstance(payload, dict)
    return payload


def _configure_selected_postgres_empty_root_bootstrap(monkeypatch, web_asgi) -> None:
    def fake_build_postgres_root_startup_view(*, config, query_args):
        initial_view = web_asgi._build_empty_initial_view(
            config=config,
            query_raw=str(query_args.get("q") or "").strip(),
            selected_artist=str(query_args.get("artist") or "").strip(),
            active_surface="albums",
        )
        initial_view["initial_view_partial"] = True
        return initial_view, None, 0.0

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "get_primary_music_root",
        lambda config: Path(config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )
    monkeypatch.setattr(
        web_asgi,
        "_build_postgres_root_startup_view",
        fake_build_postgres_root_startup_view,
    )


def test_asgi_web_routes_register_natively(asgi_app):
    route_paths = _collect_route_paths(asgi_app)
    for route_path in (
        "/",
        "/bootstrap-data",
        "/track",
        "/cover",
        "/loops/media/{loop_id}",
        "/loops/pitch-preview/{preview_id}",
    ):
        assert route_path in route_paths


def test_asgi_index_and_news_render_current_template_shell(app, monkeypatch):
    from music_app.routes import web_asgi

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "build_news_payload",
        lambda **_kwargs: {
            "shell_layout": {
                "slots": {
                    "main_content": {
                        "content_kind": "discovery_center_page",
                        "surface_ref": "news",
                    },
                    "app_bar": {
                        "header_surfaces": {
                            "discovery_center": {
                                "page_route": "/news",
                            }
                        }
                    },
                },
            },
            "discovery_center": {
                "page_kind": "discovery_center",
                "active_tab": "history",
                "active_source": "suggestion",
                "page_title": "Discovery Center",
                "page_subtitle": "",
                "supported_tabs": ["history"],
                "summary_route": "/news-center/summary",
                "entries_route": "/news-center/entries?tab=history&source=suggestion",
                "preferences_route": "/news-center/preferences",
                "summary": {"drawer_preview": {"empty_state": {"detail": ""}}},
            },
        },
    )
    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        lambda _config: SimpleNamespace(
            build_root_sidebar_payload=lambda **_kwargs: {
                "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
                "artist_count": 1,
                "album_count": 1,
                "selected_artist": "",
                "payload_tier": "sidebar",
                "gallery_display_mode": "covers",
            },
            build_selected_artist_payload=lambda **_kwargs: {
                "selected_artist": "Broadcast",
                "selected_artist_family_display_mode": "chronological",
                "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
                "artist_count": 1,
                "album_count": 1,
                "gallery_display_mode": "covers",
                "payload_tier": "full",
                "surface": {"active_surface": "albums"},
                "shell_layout": {"active_surface": "albums"},
            },
        ),
    )
    assert not hasattr(web_asgi, "flask_web")

    asgi_app = _make_asgi_app()
    asgi_app.state.flask_app = _FatalFlaskBridge()
    index_status, _index_headers, index_body = _run_asgi_request(asgi_app, "GET", "/")
    bootstrap_status, _bootstrap_headers, bootstrap_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/bootstrap-data",
        query={
            "artist": "Broadcast",
            "gallery_display": "covers",
            "family_display": "chronological",
        },
    )
    news_status, _news_headers, news_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/news",
        query={"tab": "history", "source": "suggestion"},
    )

    assert index_status == 200
    assert b"<!doctype html>" in index_body
    assert re.search(rb'src="/static/app\.js\?v=[^"]+"', index_body)
    assert b"window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__" in index_body
    assert bootstrap_status == 200
    bootstrap_payload = _decode_json(bootstrap_body)
    assert bootstrap_payload["initial_view"]["gallery_display_mode"] == "covers"
    assert bootstrap_payload["initial_view"]["selected_artist_family_display_mode"] == "chronological"
    assert news_status == 200
    assert b'data-shell-content-kind="discovery_center_page"' in news_body
    assert b"Discovery Center" in news_body


def test_bootstrap_direct_selected_artist_urls_keep_query_and_sidebar_context_distinct(
    app,
    monkeypatch,
):
    from music_app.routes import web_asgi

    full_root_sidebar = [
        {"artist": "Broadcast", "artist_display": "Broadcast", "count": 2},
        {"artist": "Mono", "artist_display": "Mono", "count": 1},
        {"artist": "Stereolab", "artist_display": "Stereolab", "count": 3},
    ]
    filtered_search_sidebar = [
        {"artist": "Broadcast", "artist_display": "Broadcast", "count": 2},
        {"artist": "Stereolab", "artist_display": "Stereolab", "count": 3},
    ]

    class DirectUrlBrowseRepository:
        def __init__(self, config):
            self.config = config

        def build_root_sidebar_payload(self, *, query_params=None):
            payload = web_asgi._build_empty_initial_view(
                config=self.config,
                query_raw="",
                selected_artist="",
                active_surface="albums",
            )
            payload.update(
                {
                    "artists_sidebar": full_root_sidebar,
                    "artist_count": len(full_root_sidebar),
                    "album_count": 3,
                    "payload_tier": "sidebar",
                }
            )
            return payload

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            query = str((query_params or {}).get("q") or "").strip()
            payload = web_asgi._build_empty_initial_view(
                config=self.config,
                query_raw=query,
                selected_artist="Broadcast",
                active_surface="albums",
            )
            payload.update(
                {
                    "artists_sidebar": (
                        filtered_search_sidebar
                        if query
                        else [full_root_sidebar[0]]
                    ),
                    "artist_count": len(filtered_search_sidebar) if query else 1,
                    "album_count": 1,
                    "payload_tier": "full",
                }
            )
            if query:
                payload["search_context"] = {
                    "committed_query": query,
                    "selected_artist": "Broadcast",
                    "selected_artist_source": "requested_artist",
                }
            return payload

    monkeypatch.setattr(
        web_asgi,
        "library_browse_postgres_is_effective",
        lambda _config: True,
    )
    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        DirectUrlBrowseRepository,
    )
    monkeypatch.setattr(
        web_asgi,
        "get_primary_music_root",
        lambda config: Path(config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )
    asgi_app = _make_asgi_app()

    no_query_status, _headers, no_query_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/bootstrap-data",
        query={"surface": "albums", "artist": "Broadcast"},
    )
    query_status, _headers, query_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/bootstrap-data",
        query={
            "surface": "albums",
            "artist": "Broadcast",
            "q": "Tender Buttons",
        },
    )

    assert (no_query_status, query_status) == (200, 200)
    no_query_view = _decode_json(no_query_body)["initial_view"]
    query_view = _decode_json(query_body)["initial_view"]
    assert {
        "no_query": {
            "query": no_query_view["query"],
            "has_search_context": "search_context" in no_query_view,
            "selected_artist": no_query_view["selected_artist"],
            "artists_sidebar": no_query_view["artists_sidebar"],
        },
        "with_query": {
            "query": query_view["query"],
            "search_context": query_view.get("search_context"),
            "selected_artist": query_view["selected_artist"],
            "artists_sidebar": query_view["artists_sidebar"],
        },
    } == {
        "no_query": {
            "query": "",
            "has_search_context": False,
            "selected_artist": "Broadcast",
            "artists_sidebar": full_root_sidebar,
        },
        "with_query": {
            "query": "Tender Buttons",
            "search_context": {
                "committed_query": "Tender Buttons",
                "selected_artist": "Broadcast",
                "selected_artist_source": "requested_artist",
            },
            "selected_artist": "Broadcast",
            "artists_sidebar": filtered_search_sidebar,
        },
    }


def test_asgi_index_claims_pending_cold_scan_and_starts_after_response_without_bridge(app, monkeypatch):
    from music_app.routes import web_asgi

    refresh_calls = []

    def fake_start_background_refresh_for_state(
        library_state,
        config,
        logger,
        *,
        force=False,
        scan_mode="background",
    ):
        refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": force,
                "scan_mode": scan_mode,
            }
        )
        library_state["scan_in_progress"] = True
        library_state["scan_mode"] = scan_mode

    _configure_selected_postgres_empty_root_bootstrap(monkeypatch, web_asgi)
    monkeypatch.setattr(
        web_asgi.state_service,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )

    asgi_app = _make_asgi_app()
    asgi_logger = _RecordingLogger()
    asgi_app.state.logger = asgi_logger
    library_state = asgi_app.state.library_state
    library_state["albums"] = []
    library_state["file_cache"] = {}
    library_state["scan_in_progress"] = False
    library_state["cold_scan_pending"] = True
    library_state["cold_scan_handoff_status"] = "pending"
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/")
    second_status, _second_headers, second_body = _run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert second_status == 200
    assert b'id="library-loader" hidden' not in body
    assert b"Waiting for the first albums to become available..." in body
    assert b'<div class="albums-scroll" id="albums-scroll" hidden>' in body
    payload = _extract_bootstrap_payload_from_shell(body)
    second_payload = _extract_bootstrap_payload_from_shell(second_body)
    assert payload["bootstrap"]["scanInProgress"] is True
    assert payload["bootstrap"]["scanMode"] == "background"
    assert payload["bootstrap"]["scanPhase"] == "discovering"
    assert second_payload["bootstrap"]["scanInProgress"] is True
    cover_cache_token = payload["bootstrap"]["coverCacheToken"]
    assert isinstance(cover_cache_token, str)
    assert re.fullmatch(r"[0-9a-f]+", cover_cache_token)
    assert cover_cache_token == startup_bootstrap.COVER_CACHE_PROCESS_TOKEN
    assert second_payload["bootstrap"]["coverCacheToken"] == cover_cache_token
    assert library_state["cold_scan_pending"] is False
    assert library_state["cold_scan_handoff_status"] == "started"
    assert refresh_calls == [
        {
            "library_state": library_state,
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "force": False,
            "scan_mode": "background",
        }
    ]


@pytest.mark.parametrize(
    ("full_rescan", "expected_force", "expected_scan_mode"),
    [
        (False, True, "background"),
        (True, True, "manual_full_rescan"),
    ],
)
def test_asgi_refresh_api_preserves_incremental_and_full_rescan_modes(
    app,
    monkeypatch,
    full_rescan,
    expected_force,
    expected_scan_mode,
):
    from music_app.routes import web_asgi

    refresh_calls = []

    def fake_start_background_refresh_for_state(
        library_state,
        config,
        logger,
        *,
        force=False,
        scan_mode="background",
        accepted_state_updates=None,
    ):
        refresh_calls.append({"force": force, "scan_mode": scan_mode})
        library_state.update(accepted_state_updates or {})
        return True

    monkeypatch.setattr(
        web_asgi.state_service,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )

    asgi_app = _make_asgi_app()
    asgi_app.state.library_state["albums"] = [{"name": "Existing album"}]
    asgi_app.state.flask_app = _FatalFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/refresh-api",
        json_body={"full_rescan": full_rescan},
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True, "full_rescan": full_rescan}
    assert refresh_calls == [
        {"force": expected_force, "scan_mode": expected_scan_mode},
    ]
    assert asgi_app.state.library_state.get("rescan_ignore_existing_cache") is full_rescan


def test_asgi_refresh_api_rejects_duplicate_full_rescan_without_resetting_active_progress(
    app,
    monkeypatch,
):
    from music_app.routes import web_asgi

    def reject_active_refresh(
        library_state,
        config,
        logger,
        *,
        force=False,
        scan_mode="background",
        accepted_state_updates=None,
    ):
        assert force is True
        assert scan_mode == "manual_full_rescan"
        assert accepted_state_updates["scan_processed"] == 0
        return False

    monkeypatch.setattr(
        web_asgi.state_service,
        "start_background_refresh_for_state",
        reject_active_refresh,
    )

    asgi_app = _make_asgi_app()
    library_state = asgi_app.state.library_state
    library_state.update(
        {
            "albums": [{"name": "Existing album"}],
            "scan_in_progress": True,
            "scan_mode": "manual_full_rescan",
            "scan_processed": 578,
            "scan_total": 5389,
            "scan_current_path": "Artist/Album",
            "scan_progress_samples": [1, 2, 3],
        }
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/refresh-api",
        json_body={"full_rescan": True},
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "already_running": True,
        "error_code": "already_running",
        "error": "Library scan is already running.",
        "full_rescan": True,
    }
    assert library_state["scan_processed"] == 578
    assert library_state["scan_total"] == 5389
    assert library_state["scan_current_path"] == "Artist/Album"
    assert library_state["scan_progress_samples"] == [1, 2, 3]


def test_asgi_index_records_cold_scan_handoff_failure(app, monkeypatch):
    from music_app.routes import web_asgi

    start_calls = 0
    handoff_error = RuntimeError("executor unavailable")

    def fail_once(*_args, **_kwargs):
        nonlocal start_calls
        start_calls += 1
        if start_calls == 1:
            raise handoff_error

    _configure_selected_postgres_empty_root_bootstrap(monkeypatch, web_asgi)
    monkeypatch.setattr(web_asgi.state_service, "start_background_refresh_for_state", fail_once)
    asgi_app = _make_asgi_app()
    asgi_logger = _RecordingLogger()
    asgi_app.state.logger = asgi_logger
    library_state = asgi_app.state.library_state
    library_state["cold_scan_pending"] = True
    library_state["cold_scan_handoff_status"] = "pending"

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert _extract_bootstrap_payload_from_shell(body)["bootstrap"]["scanPhase"] == "discovering"
    assert library_state["cold_scan_handoff_status"] == "failed"
    assert library_state["cold_scan_pending"] is True
    assert library_state["scan_in_progress"] is False
    assert library_state["scan_phase"] == "idle"
    assert library_state["scan_mode"] == "idle"
    assert library_state["cold_scan_handoff_error"] == "Cold-start scan handoff failed: executor unavailable"
    assert library_state["last_error"] == library_state["cold_scan_handoff_error"]
    assert asgi_logger.exceptions == [("Cold-start scan handoff failed", ())]
    assert asgi_logger.exception_kwargs == [{"exc_info": handoff_error}]
    assert handoff_error.__traceback__ is not None

    retry_status, _retry_headers, _retry_body = _run_asgi_request(asgi_app, "GET", "/")
    assert retry_status == 200
    assert start_calls == 2
    assert library_state["cold_scan_pending"] is False
    assert library_state["cold_scan_handoff_status"] == "started"


def test_pending_cold_scan_claim_is_atomic_across_concurrent_roots():
    from concurrent.futures import ThreadPoolExecutor

    from music_app.routes import web_asgi

    asgi_app = _make_asgi_app()
    request = SimpleNamespace(app=asgi_app)
    library_state = asgi_app.state.library_state
    library_state["cold_scan_pending"] = True
    library_state["cold_scan_handoff_status"] = "pending"

    with ThreadPoolExecutor(max_workers=8) as executor:
        claims = list(executor.map(lambda _index: web_asgi._claim_pending_cold_scan(request), range(16)))

    assert len([claim for claim in claims if claim is not None]) == 1
    assert claims.count(None) == 15
    assert library_state["cold_scan_pending"] is False
    assert library_state["cold_scan_handoff_status"] == "claimed"


def test_stale_cold_scan_claim_can_be_reclaimed_without_old_task_starting(monkeypatch):
    from music_app.routes import web_asgi

    asgi_app = _make_asgi_app()
    request = SimpleNamespace(app=asgi_app)
    state = asgi_app.state.library_state
    state["cold_scan_pending"] = True
    first_token = web_asgi._claim_pending_cold_scan(request)
    state["cold_scan_claimed_at"] = 0.0

    second_token = web_asgi._claim_pending_cold_scan(request)
    starts = []
    monkeypatch.setattr(web_asgi.state_service, "start_background_refresh_for_state", lambda *_a, **_k: starts.append(True))
    web_asgi._start_claimed_cold_scan(request, first_token)
    web_asgi._start_claimed_cold_scan(request, second_token)

    assert second_token == first_token + 1
    assert starts == [True]


def test_cold_scan_start_failure_rolls_back_atomically_before_stale_reclaim(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from music_app.routes import web_asgi

    asgi_app = _make_asgi_app()
    request = SimpleNamespace(app=asgi_app)
    state = asgi_app.state.library_state
    state["cold_scan_pending"] = True
    first_token = web_asgi._claim_pending_cold_scan(request)
    state["cold_scan_claimed_at"] = 0.0
    start_entered = Event()
    reclaim_attempted = Event()
    allow_failure = Event()
    start_calls = 0

    def fail_then_start(*_args, **_kwargs):
        nonlocal start_calls
        start_calls += 1
        if start_calls == 1:
            start_entered.set()
            assert allow_failure.wait(timeout=5)
            state["scan_in_progress"] = True
            state["scan_phase"] = "discovering"
            state["scan_mode"] = "background"
            raise RuntimeError("submit failed")
        state["scan_in_progress"] = True
        state["scan_phase"] = "discovering"
        state["scan_mode"] = "background"

    def attempt_reclaim():
        reclaim_attempted.set()
        return web_asgi._claim_pending_cold_scan(request)

    monkeypatch.setattr(web_asgi.state_service, "start_background_refresh_for_state", fail_then_start)
    with ThreadPoolExecutor(max_workers=2) as executor:
        start_future = executor.submit(web_asgi._start_claimed_cold_scan, request, first_token)
        assert start_entered.wait(timeout=5)
        reclaim_future = executor.submit(attempt_reclaim)
        assert reclaim_attempted.wait(timeout=5)
        allow_failure.set()
        start_future.result(timeout=5)
        second_token = reclaim_future.result(timeout=5)

    assert second_token == first_token + 1
    assert state["scan_in_progress"] is False
    assert state["scan_phase"] == "idle"
    assert state["scan_mode"] == "idle"
    assert state["cold_scan_handoff_status"] == "claimed"
    web_asgi._start_claimed_cold_scan(request, second_token)
    assert start_calls == 2
    assert state["scan_in_progress"] is True
    assert state["cold_scan_handoff_status"] == "started"


def test_status_projects_pending_discovery_without_claiming_or_starting():
    asgi_app = _make_asgi_app()
    state = asgi_app.state.library_state
    state["cold_scan_pending"] = True
    state["cold_scan_handoff_status"] = "pending"

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/status")

    assert status == 200
    payload = _decode_json(body)
    assert payload["scan_in_progress"] is True
    assert payload["scan_phase"] == "discovering"
    assert state["cold_scan_pending"] is True
    assert state["cold_scan_handoff_status"] == "pending"


def test_root_render_failure_leaves_cold_scan_pending_for_next_root(monkeypatch):
    from music_app.routes import web_asgi

    _configure_selected_postgres_empty_root_bootstrap(monkeypatch, web_asgi)
    asgi_app = _make_asgi_app()
    state = asgi_app.state.library_state
    state["cold_scan_pending"] = True
    state["cold_scan_handoff_status"] = "pending"
    original_template_response = web_asgi._template_response
    calls = 0

    def fail_once(request, context):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("template failed")
        return original_template_response(request, context)

    starts = []
    monkeypatch.setattr(web_asgi, "_template_response", fail_once)
    monkeypatch.setattr(web_asgi.state_service, "start_background_refresh_for_state", lambda *_a, **_k: starts.append(True))

    with pytest.raises(RuntimeError, match="template failed"):
        _run_asgi_request(asgi_app, "GET", "/")
    assert state["cold_scan_pending"] is True

    status, _headers, _body = _run_asgi_request(asgi_app, "GET", "/")
    assert status == 200
    assert starts == [True]


def test_asgi_bootstrap_and_refresh_routes_preserve_payloads_and_redirect(app, monkeypatch):
    from music_app.routes import web_asgi

    refresh_calls = []
    cancel_calls = []
    hydrate_calls = []
    selected_view_calls = []
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)

    class SelectedSearchBrowseRepository:
        def __init__(self, config):
            self.config = config

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            selected_view_calls.append(
                {
                    "query": str(query_params.get("q") or ""),
                    "artist": str(query_params.get("artist") or ""),
                    "related_artists": list(query_params.getlist("related_artist")),
                    "categories": list(query_params.getlist("category")),
                    "gallery_scope": str(query_params.get("gallery_scope") or ""),
                    "gallery_display": str(query_params.get("gallery_display") or ""),
                    "gallery_scale_percent": str(
                        query_params.get("gallery_scale_percent") or ""
                    ),
                    "family_display": str(query_params.get("family_display") or ""),
                    "library_state": library_state,
                }
            )
            artist_group = {
                "artist": "Mono",
                "artist_display": "Mono",
                "albums": [],
            }
            payload = web_asgi._build_empty_initial_view(
                config=self.config,
                query_raw="mono",
                selected_artist="Mono",
                active_surface="albums",
                related_filter_artists=["Explosions in the Sky", "Mogwai"],
                selected_artist_family_display_mode="chronological",
                gallery_scope="new_arrivals",
                gallery_display_mode="covers",
                gallery_scale_percent=135,
                visible_library_categories=["new_arrivals"],
            )
            payload.update(
                {
                    "artist_groups": [artist_group],
                    "primary_artist_groups": [artist_group],
                    "artists_sidebar": [
                        {
                            "artist": "Mono",
                            "artist_display": "Mono",
                            "count": 1,
                        }
                    ],
                    "artist_count": 1,
                    "album_count": 1,
                    "payload_tier": "full",
                    "search_context": {
                        "committed_query": "mono",
                        "selected_artist": "Mono",
                        "selected_artist_source": "requested_artist",
                    },
                }
            )
            return payload

    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        SelectedSearchBrowseRepository,
    )

    def fake_hydrate(library_state, config, *, logger_for_prewarm=None, **kwargs):
        hydrate_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger_for_prewarm": logger_for_prewarm,
                "kwargs": kwargs,
            }
        )
        library_state["albums"] = [{"name": "Hydrated"}]
        return True

    def fake_start_background_refresh_for_state(
        library_state,
        config,
        logger,
        *,
        force=False,
        scan_mode="background",
        accepted_state_updates=None,
    ):
        refresh_calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": force,
                "scan_mode": scan_mode,
            }
        )
        library_state.update(accepted_state_updates or {})
        return True

    def fake_cancel_background_refresh_for_state(library_state):
        cancel_calls.append(library_state)
        return True

    monkeypatch.setattr(web_asgi.state_service, "hydrate_library_state_for_config", fake_hydrate)
    monkeypatch.setattr(
        web_asgi.state_service,
        "start_background_refresh_for_state",
        fake_start_background_refresh_for_state,
    )
    monkeypatch.setattr(
        web_asgi.state_service,
        "cancel_background_refresh_for_state",
        fake_cancel_background_refresh_for_state,
    )

    asgi_app = _make_asgi_app()
    _configure_selected_postgres_library_roots(asgi_app.state.config, monkeypatch)
    asgi_logger = _RecordingLogger()
    asgi_app.state.logger = asgi_logger
    library_state = asgi_app.state.library_state
    library_state["albums"] = []
    library_state["scan_processed"] = 12
    library_state["scan_total"] = 34
    library_state["scan_started_at"] = 56.0
    library_state["scan_current_path"] = "Artist/Album"
    library_state["scan_elapsed_seconds"] = 78.0
    library_state["scan_estimated_remaining_seconds"] = 90.0
    library_state["scan_files_per_second"] = 3.5
    library_state["scan_bytes_processed"] = 1024
    library_state["scan_total_bytes"] = 2048
    library_state["scan_album_folders_processed"] = 4
    library_state["scan_album_folders_total"] = 5
    library_state["scan_progress_samples"] = [1, 2, 3]
    fatal_bridge = _FatalFlaskBridge()
    asgi_app.state.flask_app = fatal_bridge
    bootstrap_status, _bootstrap_headers, bootstrap_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/bootstrap-data",
        query={
            "refreshed": "1",
            "q": "mono",
            "artist": "Mono",
            "related_artist": ["Explosions in the Sky", "Mogwai"],
            "category": ["main_library", "new_arrivals"],
            "gallery_scope": "new_arrivals",
            "gallery_display": "covers",
            "gallery_scale_percent": "135",
            "family_display": "chronological",
        },
    )
    refresh_api_status, _refresh_api_headers, refresh_api_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/refresh-api",
        json_body={"full_rescan": True},
    )
    cancel_status, _cancel_headers, cancel_body = _run_asgi_request(asgi_app, "POST", "/cancel-refresh-api")
    refresh_status, refresh_headers, _refresh_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/refresh",
        query={"artist": "Broadcast", "q": "Tender Buttons"},
    )

    assert bootstrap_status == 200
    payload = _decode_json(bootstrap_body)
    assert payload["bootstrap"]["refreshed"] is True
    assert payload["bootstrap"]["startupPreview"]["mode"] == "full_view"
    assert payload["bootstrap"]["startupHydration"]["required"] is False
    assert payload["bootstrap"]["startupHydration"]["trigger"] == "none"
    assert payload["initial_view"]["query"] == "mono"
    assert payload["initial_view"]["selected_artist"] == "Mono"
    assert payload["initial_view"]["search_context"] == {
        "committed_query": "mono",
        "selected_artist": "Mono",
        "selected_artist_source": "requested_artist",
    }
    hydration_endpoint = payload["bootstrap"]["startupHydration"]["endpoint"]
    assert hydration_endpoint.startswith("/view-data?")
    assert "payload_tier=sidebar" not in hydration_endpoint
    assert "q=mono" in hydration_endpoint
    assert "artist=Mono" in hydration_endpoint
    assert "related_artist=Explosions+in+the+Sky" in hydration_endpoint
    assert "related_artist=Mogwai" in hydration_endpoint
    assert "category=new_arrivals" in hydration_endpoint
    assert "category=main_library" not in hydration_endpoint
    assert "gallery_scope=new_arrivals" in hydration_endpoint
    assert "gallery_display=covers" in hydration_endpoint
    assert "gallery_scale_percent=135" in hydration_endpoint
    assert "family_display=chronological" in hydration_endpoint
    assert payload["bootstrap"]["startupHydration"]["followupEndpoint"] == ""
    assert payload["bootstrap"]["startupHydration"]["tier"] == "full"
    assert selected_view_calls == [
        {
            "query": "mono",
            "artist": "Mono",
            "related_artists": ["Explosions in the Sky", "Mogwai"],
            "categories": ["main_library", "new_arrivals"],
            "gallery_scope": "new_arrivals",
            "gallery_display": "covers",
            "gallery_scale_percent": "135",
            "family_display": "chronological",
            "library_state": library_state,
        }
    ]
    assert refresh_api_status == 200
    assert _decode_json(refresh_api_body) == {"ok": True, "full_rescan": True}
    assert cancel_status == 200
    assert _decode_json(cancel_body) == {"ok": True, "cancelled": True}
    assert refresh_status == 302
    assert refresh_headers["location"] == "/?refreshed=1&artist=Broadcast&q=Tender+Buttons"
    assert hydrate_calls == [
        {
            "library_state": library_state,
            "config": asgi_app.state.config,
            "logger_for_prewarm": asgi_logger,
            "kwargs": {},
        }
    ]
    assert refresh_calls == [
        {
            "library_state": library_state,
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "force": True,
            "scan_mode": "manual_full_rescan",
        },
        {
            "library_state": library_state,
            "config": asgi_app.state.config,
            "logger": asgi_logger,
            "force": True,
            "scan_mode": "background",
        },
    ]
    assert cancel_calls == [library_state]
    assert library_state["rescan_ignore_existing_cache"] is True
    assert library_state["scan_processed"] == 0
    assert library_state["scan_total"] == 0
    assert library_state["scan_started_at"] == 0.0
    assert library_state["scan_current_path"] == ""
    assert library_state["scan_elapsed_seconds"] == 0.0
    assert library_state["scan_estimated_remaining_seconds"] == 0.0
    assert library_state["scan_files_per_second"] == 0.0
    assert library_state["scan_bytes_processed"] == 0
    assert library_state["scan_total_bytes"] == 0
    assert library_state["scan_album_folders_processed"] == 0
    assert library_state["scan_album_folders_total"] == 0
    assert library_state["scan_progress_samples"] == []


def test_asgi_view_data_hydrates_cached_library_before_file_payload(app, monkeypatch):
    from music_app.routes import api_read_asgi_routes

    hydrate_calls = []
    build_calls = []

    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_root_sidebar_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_selected_artist_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_album_search_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_root_album_browse_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_unsupported_postgres_album_search_response", lambda _request: None)
    monkeypatch.setattr(api_read_asgi_routes, "_unsupported_postgres_root_album_browse_response", lambda _request: None)

    def fake_hydrate_cached_library_for_asgi(request, *, ensure_relations=False):
        hydrate_calls.append(ensure_relations)
        request.app.state.library_state["albums"] = [SimpleNamespace(name="Hydrated")]

    def fake_build_view_payload(*, library_state=None, **_kwargs):
        build_calls.append(list(library_state.get("albums", [])))
        return {
            "query": "",
            "selected_artist": "",
            "album_count": 1,
            "artist_count": 1,
            "artist_groups": [],
            "artists_sidebar": [],
        }

    monkeypatch.setattr(api_read_asgi_routes, "_hydrate_cached_library_for_asgi", fake_hydrate_cached_library_for_asgi)
    monkeypatch.setattr(api_read_asgi_routes, "build_view_payload", fake_build_view_payload)

    asgi_app = _make_asgi_app(app)
    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"surface": "albums"},
    )

    assert status == 200
    assert _decode_json(body)["album_count"] == 1
    assert hydrate_calls == [False]
    assert len(build_calls) == 1
    assert len(build_calls[0]) == 1
    assert getattr(build_calls[0][0], "name", "") == "Hydrated"


def test_asgi_view_data_omit_sidebar_skips_cached_library_hydration_for_follow_up_payloads(app, monkeypatch):
    from music_app.routes import api_read_asgi_routes

    hydrate_calls = []
    build_calls = []

    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_root_sidebar_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_selected_artist_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_album_search_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_root_album_browse_request", lambda _request: False)
    monkeypatch.setattr(api_read_asgi_routes, "_unsupported_postgres_album_search_response", lambda _request: None)
    monkeypatch.setattr(api_read_asgi_routes, "_unsupported_postgres_root_album_browse_response", lambda _request: None)

    def fake_hydrate_cached_library_for_asgi(_request, *, ensure_relations=False):
        hydrate_calls.append(ensure_relations)

    def fake_build_view_payload(*, library_state=None, **_kwargs):
        build_calls.append(list(library_state.get("albums", [])))
        return {
            "query": "",
            "selected_artist": "",
            "album_count": 0,
            "artist_count": 0,
            "artist_groups": [],
            "artists_sidebar": [],
        }

    monkeypatch.setattr(api_read_asgi_routes, "_hydrate_cached_library_for_asgi", fake_hydrate_cached_library_for_asgi)
    monkeypatch.setattr(api_read_asgi_routes, "build_view_payload", fake_build_view_payload)

    asgi_app = _make_asgi_app(app)
    asgi_app.state.library_state["albums"] = []
    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"surface": "albums", "omit_sidebar": "1"},
    )

    assert status == 200
    assert _decode_json(body)["album_count"] == 0
    assert hydrate_calls == []
    assert build_calls == [[]]


def test_asgi_track_cover_and_loop_media_preserve_private_file_policy(app, monkeypatch):
    from music_app.services.library_roots import normalize_library_root_settings

    persisted_root_settings = normalize_library_root_settings(
        {},
        fallback_main_root=Path(app.config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            return dict(persisted_root_settings)

    persisted_loops: list[dict[str, object]] = []

    class FakeSavedLoopsPostgresAdapter:
        def __init__(self, config):
            self._config = config

        def load_loops(self):
            return list(persisted_loops)

        def save_loops(self, loops):
            persisted_loops[:] = [dict(item) for item in loops]

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )
    monkeypatch.setattr(
        "music_app.services.loops.SavedLoopsPostgresAdapter",
        FakeSavedLoopsPostgresAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.loops.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="postgres"),
    )

    track_path = (Path(app.config["MUSIC_DIR"]) / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track-bytes")
    cover_path = track_path.with_name("cover.jpg")
    cover_path.write_bytes(b"cover-bytes")
    outside_path = (Path(app.config["MUSIC_DIR"]).parent / "Outside" / "song.mp3").resolve()
    outside_path.parent.mkdir(parents=True, exist_ok=True)
    outside_path.write_bytes(b"outside")

    loop_path = (loops_dir(app.config) / "loop-1.mp3").resolve()
    loop_path.write_bytes(b"loop-bytes")
    outside_loop_path = (Path(app.config["DATA_DIR"]) / "outside-loop.mp3").resolve()
    outside_loop_path.write_bytes(b"outside-loop")
    save_loops(
        app.config,
        [
            {"id": "loop-1", "path": str(loop_path)},
            {"id": "outside-loop", "path": str(outside_loop_path)},
        ],
    )

    preview_path = (loop_previews_dir(app.config) / "loop-1_pplus1.mp3").resolve()
    preview_path.write_bytes(b"preview-bytes")

    asgi_app = _make_asgi_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()
    track_status, track_headers, track_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/track",
        query={"path": str(track_path)},
    )
    rejected_track_status, _rejected_track_headers, _rejected_track_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/track",
        query={"path": str(outside_path)},
    )
    cover_status, cover_headers, cover_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path)},
    )
    rejected_cover_status, rejected_cover_headers, rejected_cover_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(outside_path)},
    )
    revalidated_cover_status, revalidated_cover_headers, revalidated_cover_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path)},
        headers={"if-none-match": cover_headers["etag"]},
    )
    revalidated_cover_mtime_status, revalidated_cover_mtime_headers, revalidated_cover_mtime_body = (
        _run_asgi_request(
            asgi_app,
            "GET",
            "/cover",
            query={"path": str(cover_path)},
            headers={"if-modified-since": cover_headers["last-modified"]},
        )
    )
    revalidated_track_status, revalidated_track_headers, revalidated_track_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/track",
        query={"path": str(track_path)},
        headers={"if-modified-since": track_headers["last-modified"]},
    )
    loop_status, loop_headers, loop_body = _run_asgi_request(asgi_app, "GET", "/loops/media/loop-1")
    revalidated_loop_status, revalidated_loop_headers, revalidated_loop_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/media/loop-1",
        headers={"if-modified-since": loop_headers["last-modified"]},
    )
    rejected_loop_status, rejected_loop_headers, rejected_loop_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/media/outside-loop",
    )
    preview_status, preview_headers, preview_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/pitch-preview/loop-1_pplus1",
    )
    revalidated_preview_status, revalidated_preview_headers, revalidated_preview_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/pitch-preview/loop-1_pplus1",
        headers={"if-modified-since": preview_headers["last-modified"]},
    )
    missing_preview_status, missing_preview_headers, missing_preview_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/pitch-preview/missing-preview",
    )

    assert track_status == 200
    assert track_body == b"track-bytes"
    assert track_headers.get("cache-control") == "no-cache"
    assert track_headers.get("content-disposition") == 'inline; filename="song.mp3"'
    assert revalidated_track_status == 304
    assert revalidated_track_headers.get("cache-control") == "no-cache"
    assert revalidated_track_body == b""
    assert rejected_track_status == 404
    _assert_flask_like_private_media_not_found(_rejected_track_headers, _rejected_track_body)
    assert cover_status == 200
    assert cover_body == b"cover-bytes"
    assert "max-age=300" in cover_headers.get("cache-control", "")
    assert cover_headers.get("etag")
    assert rejected_cover_status == 404
    _assert_flask_like_private_media_not_found(rejected_cover_headers, rejected_cover_body)
    assert revalidated_cover_status == 304
    assert revalidated_cover_headers.get("etag") == cover_headers["etag"]
    assert revalidated_cover_body == b""
    assert revalidated_cover_mtime_status == 304
    assert revalidated_cover_mtime_headers.get("etag") == cover_headers["etag"]
    assert revalidated_cover_mtime_body == b""
    assert loop_status == 200
    assert loop_body == b"loop-bytes"
    assert loop_headers.get("cache-control") == "no-cache"
    assert loop_headers.get("content-disposition") == 'inline; filename="loop-1.mp3"'
    assert revalidated_loop_status == 304
    assert revalidated_loop_headers.get("cache-control") == "no-cache"
    assert revalidated_loop_headers.get("content-disposition") == 'inline; filename="loop-1.mp3"'
    assert revalidated_loop_body == b""
    assert rejected_loop_status == 404
    _assert_flask_like_private_media_not_found(rejected_loop_headers, rejected_loop_body)
    assert preview_status == 200
    assert preview_body == b"preview-bytes"
    assert preview_headers.get("cache-control") == "no-cache"
    assert preview_headers.get("content-disposition") == 'inline; filename="loop-1_pplus1.mp3"'
    assert revalidated_preview_status == 304
    assert revalidated_preview_headers.get("cache-control") == "no-cache"
    assert revalidated_preview_headers.get("content-disposition") == 'inline; filename="loop-1_pplus1.mp3"'
    assert revalidated_preview_body == b""
    assert missing_preview_status == 404
    _assert_flask_like_private_media_not_found(missing_preview_headers, missing_preview_body)


def test_asgi_saved_loop_media_uses_canonical_file_for_legacy_persisted_path(
    app,
    monkeypatch,
):
    persisted_loops = []

    class FakeSavedLoopsPostgresAdapter:
        def __init__(self, config):
            self._config = config

        def load_loops(self):
            return list(persisted_loops)

        def save_loops(self, loops):
            persisted_loops[:] = [dict(item) for item in loops]

    monkeypatch.setattr(
        "music_app.services.loops.SavedLoopsPostgresAdapter",
        FakeSavedLoopsPostgresAdapter,
    )
    monkeypatch.setattr(
        "music_app.services.loops.select_runtime_persistence_adapter",
        lambda seam_id, config: SimpleNamespace(seam_id=seam_id, effective_backend="postgres"),
    )
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    canonical_loop = (loops_dir(app.config) / "legacy-loop.mp3").resolve()
    canonical_loop.write_bytes(b"canonical-loop-bytes")
    legacy_loop = (
        Path(app.config["DATA_DIR"]).parent
        / "legacy-data"
        / "loops"
        / "legacy-loop.mp3"
    ).resolve()
    legacy_loop.parent.mkdir(parents=True, exist_ok=True)
    legacy_loop.write_bytes(b"legacy-loop-bytes")
    save_loops(app.config, [{"id": "legacy-loop", "path": str(legacy_loop)}])

    asgi_app = _make_asgi_app(app)
    asgi_app.state.flask_app = _FatalFlaskBridge()
    status, headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/loops/media/legacy-loop",
    )

    assert status == 200
    assert body == b"canonical-loop-bytes"
    assert headers.get("cache-control") == "no-cache"


def test_asgi_cover_uses_dedicated_capacity_instead_of_the_shared_request_worker(
    monkeypatch,
):
    import anyio
    from music_app.routes import web_asgi
    from starlette.concurrency import run_in_threadpool

    shared_worker_started = threading.Event()
    release_shared_worker = threading.Event()
    expected_response = object()

    def occupy_shared_worker():
        shared_worker_started.set()
        release_shared_worker.wait(timeout=5)

    monkeypatch.setattr(web_asgi, "_cover_response", lambda *_args: expected_response)

    async def request_cover():
        limiter = anyio.to_thread.current_default_thread_limiter()
        original_tokens = limiter.total_tokens
        limiter.total_tokens = 1
        shared_worker = asyncio.create_task(run_in_threadpool(occupy_shared_worker))
        try:
            await asyncio.get_running_loop().run_in_executor(None, shared_worker_started.wait)
            return await asyncio.wait_for(
                web_asgi.cover(SimpleNamespace(), path="C:/Music/cover.jpg", size="300"),
                timeout=2,
            )
        finally:
            release_shared_worker.set()
            await shared_worker
            limiter.total_tokens = original_tokens

    assert asyncio.run(request_cover()) is expected_response


@pytest.mark.parametrize(
    "filename",
    [
        "Neal Morse - The Dreamer - Joseph, Pt. One.png",
        "Нил Морс - Джозеф, часть первая.png",
    ],
)
def test_asgi_cover_preserves_rfc_safe_content_disposition_for_punctuation_and_unicode(
    app,
    filename,
    monkeypatch,
):
    cover_path = (Path(app.config["MUSIC_DIR"]) / "Artist" / "Album" / filename).resolve()
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    cover_path.write_bytes(b"cover-bytes")
    _configure_selected_postgres_library_roots(app.config, monkeypatch)
    asgi_app = _make_asgi_app(app)

    status, headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path)},
    )
    expected_disposition = f"inline; filename*=utf-8''{quote(filename)}"

    assert status == 200
    assert body == b"cover-bytes"
    assert headers.get("content-disposition") == expected_disposition
    assert headers.get("etag")
    assert headers.get("content-type") == "image/png"
    assert "max-age=300" in headers.get("cache-control", "")

    revalidated_status, revalidated_headers, revalidated_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path)},
        headers={"if-none-match": headers["etag"]},
    )

    assert revalidated_status == 304
    assert revalidated_body == b""
    assert revalidated_headers.get("content-disposition") == expected_disposition
    assert revalidated_headers.get("etag") == headers["etag"]
    assert revalidated_headers.get("cache-control") == headers["cache-control"]


def test_asgi_cover_serves_opaque_png_display_variant_as_jpeg(app, monkeypatch):
    image_module = pytest.importorskip("PIL.Image")
    cover_path = (Path(app.config["MUSIC_DIR"]) / "Artist" / "Album" / "cover.png").resolve()
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    image_module.new("RGB", (1200, 1200), color=(32, 96, 160)).save(
        cover_path,
        format="PNG",
    )
    _configure_selected_postgres_library_roots(app.config, monkeypatch)
    asgi_app = _make_asgi_app(app)

    status, headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path), "size": "480"},
    )

    assert status == 200
    assert headers.get("content-type") == "image/jpeg"
    assert headers.get("content-disposition", "").endswith('.jpg"')
    with image_module.open(io.BytesIO(body)) as rendered:
        assert rendered.format == "JPEG"
        assert rendered.size == (480, 480)


def test_asgi_open_album_location_preserves_json_statuses(app, monkeypatch):
    from music_app.routes import web_asgi
    from music_app.services.library_roots import normalize_library_root_settings

    opened = []
    opened_calls = []
    album_dir = (Path(app.config["MUSIC_DIR"]) / "Artist" / "Album").resolve()
    album_dir.mkdir(parents=True, exist_ok=True)
    track_path = album_dir / "song.mp3"
    track_path.write_bytes(b"song-bytes")
    persisted_root_settings = normalize_library_root_settings(
        {},
        fallback_main_root=Path(app.config["MUSIC_DIR"]).expanduser().resolve(strict=False),
    )
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            return dict(persisted_root_settings)

    def fake_open_in_system_file_explorer(paths):
        opened_calls.append(paths)
        opened.extend(paths)

    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )
    monkeypatch.setattr(web_asgi, "open_in_system_file_explorer", fake_open_in_system_file_explorer)

    asgi_app = _make_asgi_app(app)
    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/open-album-location",
        json_body={"album": "nope"},
    )
    asgi_app.state.flask_app = _FatalFlaskBridge()
    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/open-album-location",
        json_body={"album": {"name": "Missing"}},
    )
    success_status, _success_headers, success_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/open-album-location",
        json_body={"album": {"name": "Album", "tracks": [{"path": str(track_path)}]}},
    )

    assert invalid_status == 400
    assert _decode_json(invalid_body) == {"ok": False, "error": "Invalid album payload"}
    assert missing_status == 404
    assert _decode_json(missing_body) == {"ok": False, "error": "No valid album paths found"}
    assert success_status == 200
    assert _decode_json(success_body) == {"ok": True, "opened": [str(album_dir)]}
    assert opened_calls == [[album_dir]]
    assert opened == [album_dir]
