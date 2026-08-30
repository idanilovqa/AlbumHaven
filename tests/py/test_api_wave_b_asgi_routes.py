from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import decode_json as _decode_json
from tests.py.asgi_testing import collect_route_paths as _collect_route_paths
from tests.py.asgi_testing import run_asgi_request as _run_asgi_request
from tests.py.asgi_testing import runtime_app_from_asgi_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


def _track_ref(app, filename: str = "01 Track.flac") -> str:
    return str((Path(app.config["MUSIC_DIR"]) / "Artist One" / "Album One" / filename).resolve())


def _make_asgi_app():
    from music_app import create_asgi_app

    return create_asgi_app()


class _NoFlaskBridge:
    def __getattr__(self, name: str):
        raise AssertionError(f"ASGI Wave B route used Flask bridge attribute {name}")


@pytest.fixture
def local_log_history_items(app):
    from music_app.services.log_history import load_log_history

    return lambda: load_log_history(app.config)


@pytest.fixture()
def track_preferences_postgres_runtime(app, monkeypatch):
    from music_app.services.track_preferences import normalize_track_preferences_store

    class FakePostgresTrackPreferencesStore:
        payload = {"version": 1, "actors": {}}

        def __init__(self, config):
            self.config = config

        def load_store(self):
            return deepcopy(type(self).payload)

        def load_track_preferences(self, track_refs):
            store = self.load_store()
            actor_payload = (
                (store.get("actors") or {}).get("local")
                if isinstance(store.get("actors"), dict)
                else None
            )
            track_preferences = (
                actor_payload.get("track_preferences")
                if isinstance(actor_payload, dict) and isinstance(actor_payload.get("track_preferences"), dict)
                else {}
            )
            return {
                track_ref: deepcopy(track_preferences.get(track_ref, {}))
                for track_ref in track_refs
                if track_ref in track_preferences
            }

        def save_store(self, raw_payload):
            type(self).payload = normalize_track_preferences_store(raw_payload)
            return deepcopy(type(self).payload)

    FakePostgresTrackPreferencesStore.payload = {"version": 1, "actors": {}}
    app.config.update(
        ALBUM_HAVEN_APP_DATABASE_URL="postgresql://album_haven_app@localhost/app",
        PERSISTENCE_BACKENDS={
            **dict(app.config.get("PERSISTENCE_BACKENDS") or {}),
            "track_preferences": "postgres",
        },
    )
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())
    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        FakePostgresTrackPreferencesStore,
    )
    monkeypatch.setattr("music_app.services.track_stats.load_listen_history", lambda config: [])
    return FakePostgresTrackPreferencesStore


def _post_track_preference(
    asgi_app,
    app,
    *,
    track_ref: str,
    track_preference: dict[str, object],
    query: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()
    return _run_asgi_request(
        asgi_app,
        "POST",
        "/track-preferences",
        query=query,
        headers=headers,
        json_body={
            "track_ref": track_ref,
            "track_preference": track_preference,
        },
    )


def _multipart_body(
    *,
    field_name: str,
    filename: str,
    content: bytes,
    boundary: str = "album-haven-boundary",
) -> tuple[bytes, str]:
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        "Content-Type: application/octet-stream\r\n"
        "\r\n"
    ).encode("utf-8")
    body += content
    body += f"\r\n--{boundary}--\r\n".encode("utf-8")
    return body, f"multipart/form-data; boundary={boundary}"


def test_asgi_wave_b_routes_register_natively(asgi_app):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    route_source = Path(asgi_routes.__file__).read_text(encoding="utf-8")
    route_paths = _collect_route_paths(asgi_app)
    assert not hasattr(asgi_routes, "_flask_app")
    assert "api_playback_routes" not in route_source
    for route_path in (
        "/utilities/integrations",
        "/utilities/integrations/foobar/help",
        "/utilities/integrations/foobar/assets/{asset_key}",
        "/utilities/imports/local-playlists/analyze",
        "/utilities/imports/local-playlists/import",
        "/utilities/integrations/lastfm",
        "/playback/session/now-playing",
        "/playback/session/scrobble",
        "/playback/session/complete",
        "/loops/create",
        "/loops/pitch-preview",
        "/loops/delete",
        "/loops/reorder",
        "/playlists",
        "/playlists/{playlist_ref}",
        "/playlists/{playlist_ref}/items",
        "/playlists/{playlist_ref}/items/{playlist_item_ref}",
        "/playlists/{playlist_ref}/items/reorder",
        "/playlists/{playlist_ref}/cover",
        "/playlists/{playlist_ref}/access-grants",
        "/playlists/{playlist_ref}/access-grants/{grant_ref}",
        "/playlists/derived-popular-tracks",
        "/playlists/{playlist_ref}/regenerate-derived-items",
        "/playlists/{playlist_ref}/default-sort",
        "/playlists/{playlist_ref}/playback-settings",
        "/track-preferences",
    ):
        assert route_path in route_paths


def test_asgi_integrations_and_foobar_asset_routes_preserve_payload_and_file_headers(app):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_status",
        lambda _config: {
            "key": "lastfm",
            "title": "Last.fm",
            "api_configured": False,
            "connected": False,
            "username": "",
            "connected_at": "",
            "user_timezone": "",
        },
    )
    monkeypatch.setattr(
        asgi_routes,
        "build_listen_history_status_counts",
        lambda _config: {"listen_history_count": 0, "pending_scrobble_count": 0},
    )
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_integration_status",
        lambda config, *, base_status, listen_history_count, pending_scrobble_count: {
            **dict(base_status),
            "listen_history_count": listen_history_count,
            "pending_scrobble_count": pending_scrobble_count,
            "sync_state_mode": "local_postgres_orchestration",
            "sync_problem_count": 0,
            "last_retry_summary": {},
        },
    )
    asgi_app = _make_asgi_app()

    integrations_status, _integrations_headers, integrations_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations",
    )
    help_status, _help_headers, help_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations/foobar/help",
    )
    asset_status, asset_headers, asset_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations/foobar/assets/how-to-modal-copy",
    )
    download_status, download_headers, _download_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations/foobar/assets/how-to-modal-copy",
        query={"download": "1"},
    )
    conditional_status, conditional_headers, conditional_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations/foobar/assets/how-to-modal-copy",
        headers={"if-none-match": asset_headers["etag"]},
    )
    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations/foobar/assets/not-a-real-asset",
    )

    integrations_payload = _decode_json(integrations_body)
    local_import = next(item for item in integrations_payload["integrations"] if item["key"] == "local_playlist_import")
    foobar = next(item for item in integrations_payload["integrations"] if item["key"] == "foobar")
    lastfm = next(item for item in integrations_payload["integrations"] if item["key"] == "lastfm")
    assert integrations_status == 200
    assert isinstance(lastfm["listen_history_count"], int)
    assert lastfm["listen_history_count"] >= 0
    assert isinstance(lastfm["pending_scrobble_count"], int)
    assert lastfm["pending_scrobble_count"] >= 0
    assert lastfm["sync_state_mode"] == "local_postgres_orchestration"
    assert isinstance(lastfm["sync_problem_count"], int)
    assert lastfm["sync_problem_count"] >= 0
    assert isinstance(lastfm["last_retry_summary"], dict)
    assert foobar["help_route"] == "/utilities/integrations/foobar/help"
    assert local_import["analyze_route"] == "/utilities/imports/local-playlists/analyze"
    assert help_status == 200
    assert _decode_json(help_body)["reference_asset_count"] == 7
    assert asset_status == 200
    assert asset_headers["content-type"].split(";")[0] in {"text/markdown", "text/plain"}
    assert asset_headers["cache-control"] == "public, max-age=300"
    assert "inline" in asset_headers["content-disposition"].lower()
    assert b"# Foobar2000 Setup Help" in asset_body
    assert download_status == 200
    assert "attachment" in download_headers["content-disposition"].lower()
    assert conditional_status == 304
    assert conditional_headers["cache-control"] == "public, max-age=300"
    assert conditional_body == b""
    assert missing_status == 404
    assert _decode_json(missing_body) == {"ok": False, "error": "Unknown Foobar reference asset."}
    monkeypatch.undo()


def test_asgi_integrations_lastfm_enrichment_uses_route_sources(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    threadpool_calls: list[tuple[object, tuple[object, ...]]] = []
    history_count_calls: list[object] = []

    async def fake_run_in_threadpool(function, *args):
        threadpool_calls.append((function, args))
        return function(*args)

    def fail_if_retried(_config):
        raise AssertionError("GET /utilities/integrations must not retry pending scrobbles")

    def fake_build_listen_history_status_counts(config):
        history_count_calls.append(config)
        return {"listen_history_count": 42, "pending_scrobble_count": 7}

    monkeypatch.setattr(asgi_routes, "run_in_threadpool", fake_run_in_threadpool)
    monkeypatch.setattr(asgi_routes, "retry_pending_lastfm_scrobbles", fail_if_retried)
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_status",
        lambda config: {
            "key": "lastfm",
            "title": "Last.fm",
            "api_configured": True,
            "connected": True,
            "username": "demo-user",
        },
    )
    monkeypatch.setattr(
        asgi_routes,
        "build_listen_history_status_counts",
        fake_build_listen_history_status_counts,
    )

    def fake_build_lastfm_integration_status(
        config,
        *,
        base_status,
        listen_history_count,
        pending_scrobble_count,
    ):
        assert config is app.config
        assert base_status["username"] == "demo-user"
        assert listen_history_count == 42
        assert pending_scrobble_count == 7
        payload = dict(base_status)
        payload.update(
            {
                "listen_history_count": listen_history_count,
                "pending_scrobble_count": pending_scrobble_count,
                "sync_state_mode": "seeded_test_bridge",
                "sync_problem_count": 3,
                "last_retry_summary": {
                    "pending_before": 9,
                    "attempted": 4,
                    "succeeded": 2,
                    "failed": 2,
                    "pending_after": 7,
                },
            }
        )
        return payload

    monkeypatch.setattr(asgi_routes, "build_lastfm_integration_status", fake_build_lastfm_integration_status)

    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/integrations",
    )

    payload = _decode_json(body)
    lastfm = next(item for item in payload["integrations"] if item["key"] == "lastfm")
    assert status == 200
    assert threadpool_calls == [(asgi_routes._build_integrations_payload, (app.config,))]
    assert history_count_calls == [app.config]
    assert lastfm == {
        "key": "lastfm",
        "title": "Last.fm",
        "api_configured": True,
        "connected": True,
        "username": "demo-user",
        "listen_history_count": 42,
        "pending_scrobble_count": 7,
        "sync_state_mode": "seeded_test_bridge",
        "sync_problem_count": 3,
        "last_retry_summary": {
            "pending_before": 9,
            "attempted": 4,
            "succeeded": 2,
            "failed": 2,
            "pending_after": 7,
        },
    }


def test_asgi_local_playlist_import_preserves_missing_file_execute_and_supported_upload_contracts(app):
    upload_body, content_type = _multipart_body(
        field_name="playlist_file",
        filename="road-trip.m3u",
        content=b"#EXTM3U\n",
    )
    asgi_app = _make_asgi_app()

    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/imports/local-playlists/analyze",
    )
    upload_status, _upload_headers, upload_response_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/imports/local-playlists/analyze",
        headers={"content-type": content_type},
        body=upload_body,
    )
    execute_status, _execute_headers, execute_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/imports/local-playlists/import",
        json_body={"playlist_ref": "road-trip"},
    )

    assert missing_status == 400
    assert _decode_json(missing_body) == {
        "ok": False,
        "error": "Select a local playlist file before running analysis.",
    }
    assert upload_status == 200
    upload_payload = _decode_json(upload_response_body)
    assert upload_payload["ok"] is True
    assert upload_payload["analysis"]["source"]["filename"] == "road-trip.m3u"
    assert upload_payload["analysis"]["source"]["size_bytes"] == 8
    assert execute_status == 409
    assert _decode_json(execute_body) == {
        "ok": False,
        "error": "Local playlist import execution lands in later phases after parser and persistence work.",
    }


def test_asgi_local_playlist_import_rejects_oversized_upload_before_multipart_parse(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    parse_calls: list[object] = []
    monkeypatch.setattr(
        asgi_routes,
        "_parse_multipart_file",
        lambda *args, **kwargs: parse_calls.append(args) or None,
    )
    asgi_app = _make_asgi_app()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/imports/local-playlists/analyze",
        headers={
            "content-type": "multipart/form-data; boundary=album-haven-boundary",
            "content-length": str(asgi_routes.MAX_LOCAL_PLAYLIST_ANALYZE_BYTES + 1),
        },
    )
    reserved_status, _reserved_headers, reserved_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playlists",
        headers={
            "content-type": "multipart/form-data; boundary=album-haven-boundary",
            "content-length": str(asgi_routes.MAX_LOCAL_PLAYLIST_ANALYZE_BYTES + 1),
        },
    )

    assert status == 413
    assert _decode_json(body) == {
        "ok": False,
        "error": "Selected playlist file is too large for Phase 3 analysis. Limit: 2 MiB.",
    }
    assert reserved_status == 409
    assert _decode_json(reserved_body) == {
        "ok": False,
        "error": "Playlist mutations land on the dedicated /playlists route family in later phases.",
    }
    assert parse_calls == []


def test_asgi_local_playlist_import_rejects_unsupported_extensions(app):
    upload_body, content_type = _multipart_body(
        field_name="playlist_file",
        filename="notes.txt",
        content=b"not a playlist",
    )
    asgi_app = _make_asgi_app()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/imports/local-playlists/analyze",
        headers={"content-type": content_type},
        body=upload_body,
    )

    assert status == 400
    assert _decode_json(body) == {
        "ok": False,
        "error": "Unsupported playlist file. Supported extensions: .fpl, .m3u, .m3u8, .pls.",
    }


def test_asgi_lastfm_and_playback_routes_preserve_validation_side_effects(
    app,
    monkeypatch,
    local_log_history_items,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes
    from music_app.services.lastfm import LastfmError

    now_playing_calls: list[dict[str, object]] = []

    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda config: False)
    monkeypatch.setattr(asgi_routes, "update_now_playing", lambda config, payload: now_playing_calls.append(payload))

    def fail_scrobble(config, payload):
        raise LastfmError("Scrobble failed")

    monkeypatch.setattr(asgi_routes, "scrobble_track", fail_scrobble)

    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    credentials_status, _credentials_headers, credentials_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={"username": "demo-user", "password": "demo-pass"},
    )
    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/now-playing",
        headers={"content-type": "application/json"},
        body=b'"oops"',
    )
    now_playing_status, _now_playing_headers, now_playing_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/now-playing",
        json_body={"artist": "Artist", "title": "Song", "trackNumber": "07"},
    )
    scrobble_status, _scrobble_headers, scrobble_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/scrobble",
        json_body={"artist": "Artist", "title": "Song", "album": "Album"},
    )

    assert credentials_status == 503
    assert _decode_json(credentials_body) == {
        "ok": False,
        "error": "Last.fm API credentials are not configured on the server.",
    }
    assert invalid_status == 400
    assert _decode_json(invalid_body) == {"ok": False, "error": "Invalid payload"}
    assert now_playing_status == 200
    assert _decode_json(now_playing_body) == {"ok": True}
    assert now_playing_calls == [
        {
            "artist": "Artist",
            "track": "Song",
            "album": "",
            "album_artist": "",
            "duration": 0,
            "track_number": "07",
            "timestamp": 0,
            "request_origin": {
                "client_kind": "private_web",
                "origin_type": "browser_tab",
                "origin_id": "",
            },
        }
    ]
    assert scrobble_status == 400
    assert _decode_json(scrobble_body) == {"ok": False, "error": "Scrobble failed"}
    assert local_log_history_items()[0]["action"] == "Last.fm scrobble failed"


def test_asgi_lastfm_settings_disconnects_saved_session(app):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    clear_calls: list[object] = []
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(asgi_routes, "clear_lastfm_settings", lambda config: clear_calls.append(config))
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_status",
        lambda config: {
            "key": "lastfm",
            "connected": False,
            "user_timezone": "America/Denver",
        },
    )
    monkeypatch.setattr(asgi_routes, "count_scrobbled_listen_history_entries", lambda _config: 0)
    monkeypatch.setattr(asgi_routes, "pending_scrobble_count", lambda _config: 0)
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_integration_status",
        lambda config, *, base_status, listen_history_count, pending_scrobble_count: {
            **dict(base_status),
            "listen_history_count": listen_history_count,
            "pending_scrobble_count": pending_scrobble_count,
            "sync_state_mode": "seeded_test_bridge",
            "sync_problem_count": 0,
            "last_retry_summary": {},
        },
    )
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    try:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/integrations/lastfm",
            json_body={"disconnect": True},
        )
    finally:
        monkeypatch.undo()

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["integration"]["connected"] is False
    assert payload["integration"]["user_timezone"] == "America/Denver"
    assert clear_calls == [app.config]


def test_asgi_lastfm_settings_authenticates_and_saves_session(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    auth_calls: list[dict[str, object]] = []
    retry_calls: list[object] = []
    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda config: True)
    monkeypatch.setattr(
        asgi_routes,
        "retry_pending_lastfm_scrobbles",
        lambda config, *, reauthenticated=False: retry_calls.append((config, reauthenticated)),
    )
    monkeypatch.setattr(asgi_routes, "count_scrobbled_listen_history_entries", lambda _config: 0)
    monkeypatch.setattr(asgi_routes, "pending_scrobble_count", lambda _config: 0)
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_integration_status",
        lambda config, *, base_status, listen_history_count, pending_scrobble_count: {
            **dict(base_status),
            "listen_history_count": listen_history_count,
            "pending_scrobble_count": pending_scrobble_count,
            "sync_state_mode": "seeded_test_bridge",
            "sync_problem_count": 0,
            "last_retry_summary": {},
        },
    )

    def fake_authenticate(config, username, password, connected_at, user_timezone):
        auth_calls.append(
            {
                "config": config,
                "username": username,
                "password": password,
                "connected_at": connected_at,
                "user_timezone": user_timezone,
            }
        )
        return {
            "key": "lastfm",
            "title": "Last.fm",
            "api_configured": True,
            "connected": True,
            "username": username,
            "connected_at": connected_at,
            "user_timezone": user_timezone,
        }

    monkeypatch.setattr(asgi_routes, "authenticate_lastfm", fake_authenticate)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={
            "username": "demo-user",
            "password": "demo-pass",
            "timezone": "America/Denver",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["integration"]["connected"] is True
    assert payload["integration"]["username"] == "demo-user"
    assert payload["integration"]["user_timezone"] == "America/Denver"
    assert auth_calls[0]["password"] == "demo-pass"
    assert auth_calls[0]["user_timezone"] == "America/Denver"
    assert retry_calls == [(app.config, True)]


def test_asgi_lastfm_settings_records_safe_history_when_provider_rejects_connection(
    app,
    monkeypatch,
    local_log_history_items,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes
    from music_app.services.lastfm import LastfmError

    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda _config: True)

    def reject_connection(*_args, **_kwargs):
        raise LastfmError(
            "Invalid username or password (Last.fm error 4)",
            code=4,
            error_kind="invalid_credentials",
        )

    monkeypatch.setattr(asgi_routes, "authenticate_lastfm", reject_connection)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={
            "username": "fixture_listener",
            "password": "fixture-password",
            "timezone": "America/Denver",
        },
    )

    assert status == 400
    assert _decode_json(body) == {
        "ok": False,
        "error": "Invalid username or password (Last.fm error 4)",
    }
    history_items = local_log_history_items()
    assert len(history_items) == 1
    history_entry = history_items[0]
    assert history_entry["action"] == "Last.fm connection failed"
    assert history_entry["integration"] == "Last.fm"
    assert history_entry["status"] == "failed"
    assert history_entry["failure_stage"] == "provider_authentication"
    assert history_entry["error"] == "Invalid username or password."
    assert history_entry["error_kind"] == "invalid_credentials"
    assert history_entry["error_code"] == 4
    assert history_entry["retryable"] is False
    serialized_entry = json.dumps(history_entry, ensure_ascii=False)
    for forbidden_value in (
        "fixture_listener",
        "fixture-password",
        "album-haven-e2e-api-key",
        "album-haven-e2e-api-secret",
        "album-haven-e2e-session-key",
        "api_sig",
        "<lfm",
    ):
        assert forbidden_value not in serialized_entry


def test_asgi_lastfm_settings_records_safe_history_before_reraising_unexpected_connection_error(
    app,
    monkeypatch,
    local_log_history_items,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda _config: True)

    def fail_session_persistence(*_args, **_kwargs):
        raise RuntimeError("database failure containing fixture-password and fixture_listener")

    monkeypatch.setattr(asgi_routes, "authenticate_lastfm", fail_session_persistence)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    with pytest.raises(RuntimeError, match="database failure"):
        _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/integrations/lastfm",
            json_body={
                "username": "fixture_listener",
                "password": "fixture-password",
            },
        )

    history_items = local_log_history_items()
    assert len(history_items) == 1
    history_entry = history_items[0]
    assert history_entry["action"] == "Last.fm connection failed"
    assert history_entry["integration"] == "Last.fm"
    assert history_entry["status"] == "failed"
    assert history_entry["failure_stage"] == "provider_or_session_persistence"
    assert history_entry["error"] == "Album Haven could not complete the Last.fm connection."
    assert history_entry["error_kind"] == "RuntimeError"
    serialized_entry = json.dumps(history_entry, ensure_ascii=False)
    assert "fixture_listener" not in serialized_entry
    assert "fixture-password" not in serialized_entry


def test_asgi_lastfm_settings_preserves_original_error_when_history_and_diagnostic_logging_fail(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    username = "fixture_listener"
    password = "fixture-password"
    provider_api_key = "fixture-provider-api-key"
    provider_api_secret = "fixture-provider-api-secret"
    provider_session_key = "fixture-provider-session-key"
    original_error = RuntimeError(f"database failure containing {username} and {password}")
    history_calls = []
    diagnostic_calls = []

    app.config.update(
        LASTFM_API_KEY=provider_api_key,
        LASTFM_API_SECRET=provider_api_secret,
        LASTFM_SESSION_KEY=provider_session_key,
    )
    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda _config: True)

    def fail_connection(*_args, **_kwargs):
        raise original_error

    def fail_history_write(*args, **kwargs):
        history_calls.append((args, kwargs))
        raise RuntimeError("history write failed")

    def fail_diagnostic_write(*args, **kwargs):
        diagnostic_calls.append((args, kwargs))
        raise RuntimeError("diagnostic write failed")

    monkeypatch.setattr(asgi_routes, "authenticate_lastfm", fail_connection)
    monkeypatch.setattr(asgi_routes, "log_app_event", fail_history_write)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = SimpleNamespace(exception=fail_diagnostic_write)
    asgi_app.state.library_state = app.library_state

    with pytest.raises(RuntimeError) as exc_info:
        _run_asgi_request(
            asgi_app,
            "POST",
            "/utilities/integrations/lastfm",
            json_body={"username": username, "password": password},
        )

    assert exc_info.value is original_error
    assert len(history_calls) == 1
    assert len(diagnostic_calls) == 1
    history_args, history_kwargs = history_calls[0]
    safe_event_arguments = json.dumps(
        {"action": history_args[2:], "fields": history_kwargs},
        ensure_ascii=False,
        default=str,
    )
    for secret in (
        username,
        password,
        provider_api_key,
        provider_api_secret,
        provider_session_key,
    ):
        assert secret not in safe_event_arguments


def test_asgi_lastfm_settings_saves_and_validates_timezone(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes
    from music_app.services.lastfm import LastfmError

    def fake_save_lastfm_user_timezone(_config, timezone_name):
        if timezone_name == "Mars/Olympus_Mons":
            raise LastfmError("Unsupported timezone: Mars/Olympus_Mons")
        return {
            "key": "lastfm",
            "connected": False,
            "user_timezone": timezone_name,
        }

    monkeypatch.setattr(
        asgi_routes,
        "save_lastfm_user_timezone",
        fake_save_lastfm_user_timezone,
    )
    monkeypatch.setattr(asgi_routes, "count_scrobbled_listen_history_entries", lambda _config: 0)
    monkeypatch.setattr(asgi_routes, "pending_scrobble_count", lambda _config: 0)
    monkeypatch.setattr(
        asgi_routes,
        "build_lastfm_integration_status",
        lambda config, *, base_status, listen_history_count, pending_scrobble_count: {
            **dict(base_status),
            "listen_history_count": listen_history_count,
            "pending_scrobble_count": pending_scrobble_count,
            "sync_state_mode": "seeded_test_bridge",
            "sync_problem_count": 0,
            "last_retry_summary": {},
        },
    )
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    save_status, _save_headers, save_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={
            "timezone": "America/New_York",
            "save_timezone_only": True,
        },
    )
    invalid_status, _invalid_headers, invalid_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={
            "timezone": "Mars/Olympus_Mons",
            "save_timezone_only": True,
        },
    )

    assert save_status == 200
    assert _decode_json(save_body)["integration"]["user_timezone"] == "America/New_York"
    assert invalid_status == 400
    assert _decode_json(invalid_body) == {
        "ok": False,
        "error": "Unsupported timezone: Mars/Olympus_Mons",
    }


def test_asgi_lastfm_settings_requires_username_and_password(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    monkeypatch.setattr(asgi_routes, "lastfm_api_enabled", lambda config: True)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/utilities/integrations/lastfm",
        json_body={
            "username": "demo-user",
            "password": "",
        },
    )

    assert status == 400
    assert _decode_json(body) == {
        "ok": False,
        "error": "Last.fm username and password are required.",
    }


@pytest.mark.parametrize(
    "path",
    [
        "/utilities/integrations/lastfm",
        "/playback/session/scrobble",
        "/playback/session/complete",
    ],
)
@pytest.mark.parametrize(
    ("headers", "body"),
    [
        ({"content-type": "application/json"}, b"{"),
        ({"content-type": "application/vnd.album-haven.playback+json; charset=utf-8"}, b"{"),
        ({"content-type": "application/json"}, b'"not-an-object"'),
    ],
)
def test_asgi_lastfm_playback_mutations_reject_invalid_json_payloads(app, path, headers, body):
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _response_headers, response_body = _run_asgi_request(
        asgi_app,
        "POST",
        path,
        headers=headers,
        body=body,
    )

    assert status == 400
    assert _decode_json(response_body) == {"ok": False, "error": "Invalid payload"}


def test_asgi_playback_session_scrobble_logs_success_history_entry(
    app,
    monkeypatch,
    local_log_history_items,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    calls: list[dict[str, object]] = []
    monkeypatch.setattr(asgi_routes, "scrobble_track", lambda config, payload: calls.append(payload))
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/scrobble",
        json_body={
            "artist": "Artist",
            "title": "Song",
            "album": "Album",
            "track_number": "4",
            "timestamp": 12345,
        },
    )

    assert status == 200
    assert _decode_json(body) == {"ok": True}
    assert len(calls) == 1
    history_entry = local_log_history_items()[0]
    assert history_entry["action"] == "Last.fm scrobble succeeded"
    assert history_entry["artist"] == "Artist"
    assert history_entry["album"] == "Album"
    assert history_entry["title"] == "Song"
    assert history_entry["track_number"] == "4"


def test_asgi_playback_session_scrobble_reports_disconnected_no_send(
    app,
    monkeypatch,
    local_log_history_items,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes
    from music_app.services.lastfm import LastfmSubmissionOutcome

    monkeypatch.setattr(
        asgi_routes,
        "scrobble_track",
        lambda config, payload: LastfmSubmissionOutcome(
            sent=False,
            outcome="not_connected",
            message="Last.fm account is not connected.",
        ),
    )
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/scrobble",
        json_body={"artist": "Artist", "title": "Song", "timestamp": 12345},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": False,
        "sent": False,
        "scrobbled": False,
        "outcome": "not_connected",
        "accepted": 0,
        "ignored": 0,
        "ignored_code": None,
        "message": "Last.fm account is not connected.",
    }
    assert local_log_history_items()[0]["action"] == "Last.fm scrobble not submitted"


def test_asgi_playback_session_complete_persists_listen_history(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    calls: list[dict[str, object]] = []
    saved_entries: list[dict[str, object]] = []
    monkeypatch.setattr(asgi_routes, "scrobble_track", lambda config, payload: calls.append(payload))
    monkeypatch.setattr(asgi_routes, "append_listen_history_entry", lambda config, entry: saved_entries.append(entry) or entry)
    monkeypatch.setattr(
        asgi_routes,
        "update_listen_history_entry",
        lambda config, entry_id, updates: saved_entries[0].update(updates) or saved_entries[0],
    )
    monkeypatch.setattr(asgi_routes, "get_lastfm_user_timezone", lambda config: "America/Denver")
    data_dir = Path(app.config["DATA_DIR"])
    (data_dir / "lastfm_settings.json").write_text(
        json.dumps({"user_timezone": "America/Denver"}),
        encoding="utf-8",
    )
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playback/session/complete",
        json_body={
            "path": "C:/Music/song.mp3",
            "title": "Song",
            "artist": "Artist",
            "album": "Album",
            "album_artist": "Artist",
            "started_at": "2026-05-13T12:00:00+00:00",
            "ended_at": "2026-05-13T12:04:00+00:00",
            "started_at_unix": 100,
            "duration_seconds": 240,
            "total_listened_seconds": 180,
            "max_contiguous_seconds": 180,
            "finished_fully": False,
            "skipped": True,
            "completion_reason": "track-change",
            "scrobble_eligible": True,
            "scrobbled": False,
            "segments": [{"start_seconds": 0, "end_seconds": 180}],
            "track_number": "1",
            "request_origin": {
                "client_kind": "private_web",
                "origin_type": "browser_tab",
                "origin_id": "tab-123",
            },
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["scrobbled"] is True
    assert len(calls) == 1

    assert len(saved_entries) == 1
    assert saved_entries[0]["title"] == "Song"
    assert saved_entries[0]["total_listened_seconds"] == 180.0
    assert saved_entries[0]["scrobbled"] is True
    assert saved_entries[0]["user_timezone"] == "America/Denver"
    assert saved_entries[0]["request_origin"] == {
        "client_kind": "private_web",
        "origin_type": "browser_tab",
        "origin_id": "tab-123",
    }
    assert calls[0]["request_origin"] == {
        "client_kind": "private_web",
        "origin_type": "browser_tab",
        "origin_id": "tab-123",
    }


def test_asgi_loop_mutations_preserve_validation_and_create_side_effects(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    source_path = Path(app.config["MUSIC_DIR"]) / "Artist" / "Song.mp3"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"source-audio")
    output_path = Path(app.config["DATA_DIR"]) / "loops" / "new-loop.mp3"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(asgi_routes.uuid, "uuid4", lambda: SimpleNamespace(hex="loop-new"))

    def fake_create_loop_file(config, resolved_source_path, start_seconds, end_seconds, loop_id):
        assert resolved_source_path == source_path.resolve()
        assert start_seconds == 1.5
        assert end_seconds == 4.5
        assert loop_id == "loop-new"
        output_path.write_bytes(b"loop-audio")
        return output_path

    monkeypatch.setattr(asgi_routes, "create_loop_file", fake_create_loop_file)
    monkeypatch.setattr(
        asgi_routes,
        "resolve_configured_media_path",
        lambda config, raw_path: source_path.resolve() if raw_path == str(source_path) else None,
    )
    persisted_loops = []
    monkeypatch.setattr(asgi_routes, "add_loop", lambda config, item: persisted_loops.insert(0, item) or item)
    monkeypatch.setattr(asgi_routes, "load_loops", lambda config: list(persisted_loops))

    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()
    asgi_app.state.library_state["file_cache"] = {
        str(source_path.resolve()): {
            "artist": "Track Artist",
            "title": "Track Title",
            "album": "Track Album",
        },
    }
    create_status, _create_headers, create_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/create",
        json_body={
            "name": "Chorus Loop",
            "source_path": str(source_path),
            "start_seconds": 1.5,
            "end_seconds": 4.5,
        },
    )
    pitch_status, _pitch_headers, pitch_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/pitch-preview",
        json_body={"loop_id": "loop-new", "semitones": "bad"},
    )
    reorder_status, _reorder_headers, reorder_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/reorder",
        json_body={"ordered_ids": "loop-new"},
    )

    assert create_status == 200
    create_payload = _decode_json(create_body)
    assert create_payload["ok"] is True
    assert create_payload["loop"]["id"] == "loop-new"
    assert create_payload["loop"]["artist"] == "Track Artist"
    assert pitch_status == 400
    assert _decode_json(pitch_body) == {"ok": False, "error": "Invalid pitch value"}
    assert reorder_status == 400
    assert _decode_json(reorder_body) == {"ok": False, "error": "ordered_ids must be a list"}


def test_asgi_pitch_preview_uses_current_root_media_for_legacy_saved_loop_path(
    app,
    monkeypatch,
):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    canonical_loop = Path(app.config["DATA_DIR"]) / "loops" / "legacy-loop.mp3"
    canonical_loop.parent.mkdir(parents=True, exist_ok=True)
    canonical_loop.write_bytes(b"current-loop")
    legacy_loop = (
        Path(app.config["DATA_DIR"]).parent
        / "legacy-data"
        / "loops"
        / "legacy-loop.mp3"
    )
    legacy_loop.parent.mkdir(parents=True, exist_ok=True)
    legacy_loop.write_bytes(b"legacy-loop")
    monkeypatch.setattr(
        "music_app.services.loops.load_loops",
        lambda _config: [{"id": "legacy-loop", "path": str(legacy_loop)}],
    )

    captured_sources = []

    def fake_create_pitch_preview_file(config, loop_id, source_path, semitones):
        captured_sources.append(source_path)
        assert loop_id == "legacy-loop"
        assert semitones == 2
        return (
            "legacy-loop_pplus2",
            Path(config["DATA_DIR"]) / "loop_previews" / "legacy-loop_pplus2.mp3",
        )

    monkeypatch.setattr(asgi_routes, "create_pitch_preview_file", fake_create_pitch_preview_file)
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/pitch-preview",
        json_body={"loop_id": "legacy-loop", "semitones": 2},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "preview_id": "legacy-loop_pplus2",
        "media_url": "/loops/pitch-preview/legacy-loop_pplus2",
        "semitones": 2,
    }
    assert captured_sources == [canonical_loop.resolve()]


def test_asgi_create_loop_from_saved_parent_uses_parent_metadata_and_media_path(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    parent_source_path = Path(app.config["DATA_DIR"]) / "loops" / "parent-loop.mp3"
    parent_source_path.parent.mkdir(parents=True, exist_ok=True)
    parent_source_path.write_bytes(b"parent-loop-audio")
    output_path = Path(app.config["DATA_DIR"]) / "loops" / "child-loop.mp3"
    parent_loop = {
        "id": "parent-loop",
        "artist": "Parent Artist",
        "title": "Parent Title",
        "album": "Parent Album",
        "cover_path": "C:/covers/parent.jpg",
    }

    monkeypatch.setattr(asgi_routes.uuid, "uuid4", lambda: SimpleNamespace(hex="child-loop"))
    monkeypatch.setattr(
        asgi_routes,
        "get_loop",
        lambda config, loop_id: parent_loop if loop_id == "parent-loop" else None,
    )
    monkeypatch.setattr(
        asgi_routes,
        "resolve_loop_media_path",
        lambda config, loop_id: parent_source_path if loop_id == "parent-loop" else None,
    )

    def fail_track_source_resolution(config, raw_path):
        raise AssertionError(f"saved-parent loop creation resolved track source path {raw_path}")

    def fake_create_loop_file(config, resolved_source_path, start_seconds, end_seconds, loop_id):
        assert resolved_source_path == parent_source_path
        assert start_seconds == 2.0
        assert end_seconds == 5.0
        assert loop_id == "child-loop"
        output_path.write_bytes(b"child-loop-audio")
        return output_path

    persisted_loops = []
    monkeypatch.setattr(asgi_routes, "resolve_configured_media_path", fail_track_source_resolution)
    monkeypatch.setattr(asgi_routes, "create_loop_file", fake_create_loop_file)
    monkeypatch.setattr(asgi_routes, "add_loop", lambda config, item: persisted_loops.insert(0, item) or item)
    monkeypatch.setattr(asgi_routes, "load_loops", lambda config: list(persisted_loops))

    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/create",
        json_body={
            "name": "Child Loop",
            "source_loop_id": "parent-loop",
            "source_path": "ignored-track-source.mp3",
            "start_seconds": 2,
            "end_seconds": 5,
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["ok"] is True
    assert payload["loop"]["id"] == "child-loop"
    assert payload["loop"]["artist"] == "Parent Artist"
    assert payload["loop"]["title"] == "Parent Title"
    assert payload["loop"]["album"] == "Parent Album"
    assert payload["loop"]["cover_path"] == "C:/covers/parent.jpg"
    assert payload["loop"]["parent_loop_id"] == "parent-loop"
    assert payload["loops"][0]["parent_loop_id"] == "parent-loop"


def test_asgi_delete_loop_returns_404_when_loop_dependency_reports_missing(app, monkeypatch):
    from music_app.routes import api_wave_b_asgi_routes as asgi_routes

    monkeypatch.setattr(asgi_routes, "delete_loop", lambda config, loop_id: (False, []))

    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "POST",
        "/loops/delete",
        json_body={"loop_id": "missing-loop"},
    )

    assert status == 404
    assert _decode_json(body) == {"ok": False, "error": "Loop was not found"}


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("POST", "/playlists", {"title": "Late Night Queue"}),
        ("DELETE", "/playlists/playlist-1", None),
        ("POST", "/playlists/playlist-1/items", {"track_ref": "track-1"}),
        ("DELETE", "/playlists/playlist-1/items/item-1", None),
        ("PUT", "/playlists/playlist-1/cover", {"cover_asset_ref": "cover-1"}),
        ("POST", "/playlists/playlist-1/access-grants", {"viewer_ref": "user-2", "role": "editor"}),
        ("PATCH", "/playlists/playlist-1/access-grants/grant-1", {"role": "viewer"}),
        ("DELETE", "/playlists/playlist-1/access-grants/grant-1", None),
        ("POST", "/playlists/derived-popular-tracks", {"source_kind": "album_top", "songs_per_album": 3}),
        ("POST", "/playlists/playlist-1/regenerate-derived-items", {"songs_per_album": 4}),
        ("POST", "/playlists/playlist-1/default-sort", {"sort_key": "popularity", "sort_direction": "desc"}),
        (
            "POST",
            "/playlists/playlist-1/playback-settings",
            {"playback_mode": "shuffle", "listen_to_suggestions_after_playlist": True},
        ),
    ],
)
def test_asgi_playlist_reserved_mutation_gaps_preserve_409_contracts(
    app,
    method: str,
    path: str,
    json_body: Mapping[str, object] | None,
):
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()

    status, _headers, body = _run_asgi_request(
        asgi_app,
        method,
        path,
        json_body=json_body,
    )

    assert status == 409
    assert _decode_json(body) == {
        "ok": False,
        "error": "Playlist mutations land on the dedicated /playlists route family in later phases.",
    }


def test_asgi_track_preferences_write_persists_in_selected_postgres_store_without_json(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    asgi_app = _make_asgi_app()

    status, _headers, body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 5, "love_tier": "Obsessed"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "actor_id": "local",
        "track_ref": track_ref,
        "track_preference": {
            "rating": 5,
            "love_tier": "obsessed",
            "allowed_actions": {
                "client_surface_class": "private_web",
                "can_rate": True,
                "can_set_love_tier": True,
            },
        },
    }
    assert track_preferences_postgres_runtime.payload == {
        "version": 1,
        "actors": {
            "local": {
                "track_preferences": {
                    track_ref: {
                        "rating": 5,
                        "love_tier": "obsessed",
                    },
                },
            },
        },
    }
    assert not (Path(app.config["DATA_DIR"]) / "track_preferences.json").exists()


def test_asgi_track_preferences_write_ignores_stale_json_when_postgres_selected(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    stale_path = Path(app.config["DATA_DIR"]) / "track_preferences.json"
    stale_path.write_text(
        (
            '{"version": 1, "actors": {"local": {"track_preferences": '
            '{"C:/Music/stale.flac": {"rating": 1, "love_tier": "obsessed"}}}}}'
        ),
        encoding="utf-8",
    )
    asgi_app = _make_asgi_app()

    status, _headers, body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 5, "love_tier": "Obsessed"},
    )

    assert status == 200
    assert _decode_json(body)["track_ref"] == track_ref
    assert track_preferences_postgres_runtime.payload["actors"]["local"]["track_preferences"] == {
        track_ref: {"rating": 5, "love_tier": "obsessed"}
    }
    assert stale_path.exists()


def test_asgi_track_preferences_write_rehydrates_album_detail_track_rows(
    app,
    monkeypatch,
    track_preferences_postgres_runtime,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services.album_details import build_album_detail_payload

    track_ref = _track_ref(app)
    app.library_state["albums"] = [
        SimpleNamespace(
            key="album-1",
            name="Album One",
            album_artist="Artist One",
            artists=["Artist One"],
            cover_path=None,
            local_cover_width=None,
            local_cover_height=None,
            remote_cover_url=None,
            remote_cover_thumbnail_url=None,
            remote_cover_source=None,
            remote_cover_source_label=None,
            remote_cover_album_url=None,
            remote_cover_width=None,
            remote_cover_height=None,
            year=None,
            release_date=None,
            edition="",
            album_rating=None,
            total_duration_seconds=245,
            tracks=[
                SimpleNamespace(
                    path=track_ref,
                    title="Track One",
                    track_number=1,
                    disc_number=1,
                    disc_number_raw="1",
                    artist="Artist One",
                    album="Album One",
                    album_artist="Artist One",
                    year=None,
                    release_date=None,
                    edition="",
                    album_rating=None,
                    exception_type=None,
                    cover_path=None,
                    local_cover_width=None,
                    local_cover_height=None,
                    remote_cover_url=None,
                    remote_cover_thumbnail_url=None,
                    remote_cover_source=None,
                    remote_cover_source_label=None,
                    remote_cover_album_url=None,
                    remote_cover_width=None,
                    remote_cover_height=None,
                    duration_seconds=245,
                    library_root_id=None,
                    library_root_category=None,
                    root_provenance=None,
                ),
            ],
            is_compilation=False,
            library_root_id=None,
            library_root_category=None,
            root_provenance=None,
        ),
    ]
    app.library_state["file_cache"] = {}
    app.library_state["scan_in_progress"] = False

    class FakePostgresLibraryBrowseRepository:
        def __init__(self, config):
            assert config is app.config
            self.config = config

        def build_album_detail_payload(self, album_key, *, client_surface_class=None):
            return build_album_detail_payload(
                album_key,
                client_surface_class=client_surface_class,
                config=self.config,
                library_state=app.library_state,
            )

    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresLibraryBrowseRepository,
    )
    asgi_app = _make_asgi_app()

    save_status, _save_headers, _save_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 4, "love_tier": "Loved"},
    )
    detail_status, _detail_headers, detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "album-1"},
    )

    assert save_status == 200
    assert detail_status == 200
    track_row = _decode_json(detail_body)["album"]["track_rows"][0]
    assert track_row["track_preference"] == {
        "rating": 4,
        "love_tier": "loved",
        "allowed_actions": {
            "client_surface_class": "private_web",
            "can_rate": True,
            "can_set_love_tier": True,
        },
    }
    assert track_row["can_edit_preferences"] is True


@pytest.mark.parametrize(
    ("track_preference", "expected_error"),
    [
        (
            {"love_tier": "Obssesed"},
            "Track preference love_tier must be off, loved, or obsessed.",
        ),
        (
            {"rating": "five", "love_tier": "Loved"},
            "Track preference rating must be null or an integer between 1 and 5.",
        ),
    ],
)
def test_asgi_track_preferences_write_preserves_validation_errors(
    app,
    track_preferences_postgres_runtime,
    track_preference,
    expected_error,
):
    asgi_app = _make_asgi_app()

    status, _headers, body = _post_track_preference(
        asgi_app,
        app,
        track_ref=_track_ref(app),
        track_preference=track_preference,
    )

    assert status == 400
    assert _decode_json(body) == {"ok": False, "error": expected_error}


def test_asgi_track_preferences_write_explicit_clear_removes_store_entry(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    asgi_app = _make_asgi_app()

    save_status, _save_headers, _save_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 5, "love_tier": "Obsessed"},
    )
    clear_status, _clear_headers, clear_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": None, "love_tier": "off"},
    )

    assert save_status == 200
    assert clear_status == 200
    payload = _decode_json(clear_body)
    assert payload["track_preference"]["rating"] is None
    assert payload["track_preference"]["love_tier"] == "off"
    assert track_preferences_postgres_runtime.payload["actors"]["local"]["track_preferences"] == {}
    assert not (Path(app.config["DATA_DIR"]) / "track_preferences.json").exists()


def test_asgi_track_preferences_write_partial_updates_preserve_saved_fields(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    asgi_app = _make_asgi_app()

    save_status, _save_headers, _save_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 5, "love_tier": "Loved"},
    )
    rating_status, _rating_headers, rating_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 2},
    )
    love_status, _love_headers, love_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"love_tier": "Obsessed"},
    )

    assert save_status == 200
    assert rating_status == 200
    rating_payload = _decode_json(rating_body)
    assert rating_payload["track_preference"]["rating"] == 2
    assert rating_payload["track_preference"]["love_tier"] == "loved"
    assert love_status == 200
    love_payload = _decode_json(love_body)
    assert love_payload["track_preference"]["rating"] == 2
    assert love_payload["track_preference"]["love_tier"] == "obsessed"
    assert track_preferences_postgres_runtime.payload["actors"]["local"]["track_preferences"][track_ref] == {
        "rating": 2,
        "love_tier": "obsessed",
    }
    assert not (Path(app.config["DATA_DIR"]) / "track_preferences.json").exists()


def test_asgi_track_preferences_write_projects_client_surface_from_query_and_header(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    asgi_app = _make_asgi_app()

    query_status, _query_headers, query_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 4, "love_tier": "Loved"},
        query={"client_surface": "TV"},
    )
    header_status, _header_headers, header_body = _post_track_preference(
        asgi_app,
        app,
        track_ref=track_ref,
        track_preference={"rating": 5},
        headers={"X-Album-Haven-Client-Surface-Class": "mobile"},
    )

    assert query_status == 200
    query_payload = _decode_json(query_body)
    assert query_payload["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"
    assert header_status == 200
    header_payload = _decode_json(header_body)
    assert header_payload["track_preference"]["allowed_actions"]["client_surface_class"] == "mobile"


def test_asgi_playlist_reserved_mutations_and_track_preferences_preserve_contracts(
    app,
    track_preferences_postgres_runtime,
):
    track_ref = _track_ref(app)
    upload_body, content_type = _multipart_body(
        field_name="playlist_file",
        filename="road-trip.m3u",
        content=b"#EXTM3U\n",
    )
    asgi_app = _make_asgi_app()
    asgi_app.state.config = app.config
    asgi_app.state.logger = app.logger
    asgi_app.state.library_state = app.library_state
    asgi_app.state.flask_app = _NoFlaskBridge()

    create_status, _create_headers, create_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playlists",
        headers={"content-type": content_type},
        body=upload_body,
    )
    update_status, _update_headers, update_body = _run_asgi_request(
        asgi_app,
        "PATCH",
        "/playlists/playlist-1",
        json_body={"title": "Later Night Queue"},
    )
    item_reorder_status, _item_reorder_headers, item_reorder_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/playlists/playlist-1/items/reorder",
        json_body={"ordered_item_refs": ["item-2", "item-1"]},
    )
    cover_delete_status, _cover_delete_headers, cover_delete_body = _run_asgi_request(
        asgi_app,
        "DELETE",
        "/playlists/playlist-1/cover",
    )
    preference_status, _preference_headers, preference_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/track-preferences",
        query={"client_surface": "TV"},
        json_body={
            "track_ref": track_ref,
            "track_preference": {
                "rating": 4,
                "love_tier": "Loved",
            },
        },
    )
    header_preference_status, _header_preference_headers, header_preference_body = _run_asgi_request(
        asgi_app,
        "POST",
        "/track-preferences",
        headers={"X-Album-Haven-Client-Surface-Class": "mobile"},
        json_body={
            "track_ref": track_ref,
            "track_preference": {
                "rating": 5,
            },
        },
    )

    assert create_status == 409
    assert _decode_json(create_body) == {
        "ok": False,
        "error": (
            "Supported local playlist files must use the separate local-playlist import flow "
            "instead of the ordinary /playlists create route."
        ),
        "import_route": "/utilities/imports/local-playlists/import",
        "analyze_route": "/utilities/imports/local-playlists/analyze",
        "supported_extensions": [".fpl", ".m3u", ".m3u8", ".pls"],
    }
    assert update_status == 409
    assert _decode_json(update_body) == {
        "ok": False,
        "error": "Playlist mutations land on the dedicated /playlists route family in later phases.",
    }
    assert item_reorder_status == 409
    assert _decode_json(item_reorder_body) == {
        "ok": False,
        "error": "Playlist mutations land on the dedicated /playlists route family in later phases.",
    }
    assert cover_delete_status == 409
    assert _decode_json(cover_delete_body) == {
        "ok": False,
        "error": "Playlist mutations land on the dedicated /playlists route family in later phases.",
    }
    assert preference_status == 200
    preference_payload = _decode_json(preference_body)
    assert preference_payload["ok"] is True
    assert preference_payload["track_preference"]["love_tier"] == "loved"
    assert preference_payload["track_preference"]["allowed_actions"]["client_surface_class"] == "tv"
    assert header_preference_status == 200
    header_preference_payload = _decode_json(header_preference_body)
    assert header_preference_payload["ok"] is True
    assert header_preference_payload["track_preference"]["rating"] == 5
    assert header_preference_payload["track_preference"]["allowed_actions"]["client_surface_class"] == "mobile"
