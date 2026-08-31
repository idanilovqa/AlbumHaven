from __future__ import annotations

import os
from html import unescape
import io
import json
from pathlib import Path
import threading
from types import SimpleNamespace
from urllib.parse import quote

from PIL import Image
import pytest

from music_app.services import startup_bootstrap
from music_app.services.library_roots import library_root_cache_identity
from music_app.services.loops import loop_previews_dir, loops_dir, save_loops
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import collect_route_paths
from tests.py.asgi_testing import decode_json
from tests.py.asgi_testing import runtime_app_from_asgi_app
from tests.py.asgi_testing import run_asgi_request


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


@pytest.fixture(autouse=True)
def postgres_library_roots_for_shell_tests(app, monkeypatch):
    from music_app.services.library_roots import normalize_library_root_settings

    class FakePsycopg:
        @staticmethod
        def connect(*args, **kwargs):
            raise AssertionError("shell bootstrap tests should not open a database connection")

    class FakePostgresLibraryRootSettingsStore:
        def __init__(self, config):
            self._config = config

        def load_settings(self):
            return normalize_library_root_settings(
                {},
                fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
            )

        def save_settings(self, raw_payload):
            return normalize_library_root_settings(
                raw_payload,
                fallback_main_root=Path(self._config["MUSIC_DIR"]).expanduser().resolve(strict=False),
            )

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    monkeypatch.setattr("music_app.services.library_roots_postgres.psycopg", FakePsycopg())
    monkeypatch.setattr(
        "music_app.services.library_roots.PostgresLibraryRootSettingsStore",
        FakePostgresLibraryRootSettingsStore,
    )


def _extract_bootstrap_payload_from_shell(body: bytes) -> dict[str, object]:
    marker = "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = "
    text = body.decode("utf-8")
    start = text.index(marker) + len(marker)
    end = text.index(";", start)
    payload = json.loads(text[start:end])
    assert isinstance(payload, dict)
    return payload


def test_asgi_bootstrap_registers_pcm_websocket_and_bounded_registry(asgi_app):
    assert "/playback/pcm" in collect_route_paths(asgi_app)
    registry = asgi_app.state.playback_pcm_registry
    assert callable(registry.acquire_connection)
    assert callable(registry.release_connection)
    assert callable(registry.shutdown)
    assert registry.active_connection_count == 0
    assert registry.active_decoder_count == 0


@pytest.mark.parametrize(
    "path",
    [
        "/static/app.js",
        "/static/js/runtime-bundle.js",
        "/static/js/audio-worklets/gapless-playback-processor.js",
    ],
)
@pytest.mark.parametrize(
    ("version_query", "expected_cache_control"),
    [
        ("current", "public, max-age=31536000, immutable"),
        ("missing", "no-store, max-age=0"),
        ("wrong", "no-store, max-age=0"),
        ("duplicate", "no-store, max-age=0"),
    ],
)
def test_runtime_javascript_cache_policy_requires_exact_current_asset_version(
    asgi_app,
    path,
    version_query,
    expected_cache_control,
):
    runtime_asset_version = asgi_app.state.runtime_asset_version
    query = {
        "current": {"v": runtime_asset_version},
        "missing": None,
        "wrong": {"v": f"{runtime_asset_version}-stale"},
        "duplicate": {"v": [runtime_asset_version, runtime_asset_version]},
    }[version_query]

    status, headers, _body = run_asgi_request(asgi_app, "GET", path, query=query)

    assert status == 200
    assert headers["cache-control"] == expected_cache_control


def test_unhashed_split_runtime_javascript_stays_no_store_with_current_version(asgi_app):
    status, headers, _body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/js/runtime/core-state-and-helpers.js",
        query={"v": asgi_app.state.runtime_asset_version},
    )

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"


def test_missing_runtime_javascript_stays_no_store_with_current_version(asgi_app):
    status, headers, _body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/js/runtime/not-a-runtime-asset.js",
        query={"v": asgi_app.state.runtime_asset_version},
    )

    assert status == 404
    assert headers["cache-control"] == "no-store, max-age=0"


def test_not_modified_runtime_javascript_stays_no_store_with_current_version(asgi_app):
    query = {"v": asgi_app.state.runtime_asset_version}
    initial_status, initial_headers, _initial_body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/app.js",
        query=query,
    )

    status, headers, _body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/app.js",
        query=query,
        headers={"if-none-match": initial_headers["etag"]},
    )

    assert initial_status == 200
    assert status == 304
    assert headers["cache-control"] == "no-store, max-age=0"


def test_missing_runtime_digest_never_makes_app_javascript_immutable(asgi_app):
    asgi_app.state.runtime_asset_version = "missing"

    status, headers, _body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/app.js",
        query={"v": "missing"},
    )

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"


def test_runtime_asset_version_is_computed_once_per_asgi_app_and_reused_by_templates(
    tmp_path,
    monkeypatch,
):
    from music_app.routes import web_asgi

    digest_calls = []

    def fake_runtime_asset_version(asset_paths=None):
        digest_calls.append(asset_paths)
        return "startup-runtime-digest"

    monkeypatch.setattr(web_asgi, "_runtime_asset_version", fake_runtime_asset_version)
    asgi_app = create_test_asgi_app(tmp_path / "runtime-digest-app", monkeypatch)

    captured_contexts = []

    class CapturingTemplates:
        def TemplateResponse(self, request, template_name, context):
            assert template_name == "index.html"
            captured_contexts.append(context)
            return context

    asgi_app.state.templates = CapturingTemplates()
    request = SimpleNamespace(app=asgi_app)
    first_context = web_asgi._template_response(request, {})
    second_context = web_asgi._template_response(request, {})

    assert digest_calls == [None]
    assert asgi_app.state.runtime_asset_version == "startup-runtime-digest"
    assert first_context["runtime_asset_version"] == "startup-runtime-digest"
    assert second_context["runtime_asset_version"] == "startup-runtime-digest"
    assert captured_contexts == [first_context, second_context]


def test_runtime_asset_version_changes_for_same_size_same_timestamp_content(tmp_path):
    from music_app.routes import web_asgi

    app_entry = tmp_path / "app.js"
    runtime_bundle = tmp_path / "runtime-bundle.js"
    app_entry.write_bytes(b"first-app")
    runtime_bundle.write_bytes(b"bundle-one")
    fixed_mtime_ns = 1_800_000_000_000_000_000
    os.utime(app_entry, ns=(fixed_mtime_ns, fixed_mtime_ns))
    os.utime(runtime_bundle, ns=(fixed_mtime_ns, fixed_mtime_ns))
    first_version = web_asgi._runtime_asset_version((app_entry, runtime_bundle))

    runtime_bundle.write_bytes(b"bundle-two")
    os.utime(runtime_bundle, ns=(fixed_mtime_ns, fixed_mtime_ns))

    assert web_asgi._runtime_asset_version((app_entry, runtime_bundle)) != first_version


def test_asgi_bootstrap_registers_waveform_route_and_application_state_registry(asgi_app):
    from music_app.routes import playback_stream_asgi

    assert "/playback/waveform" in collect_route_paths(asgi_app)
    registry = asgi_app.state.waveform_peaks_registry
    assert callable(registry.run)
    assert callable(registry.shutdown)
    assert registry.active_job_count == 0
    assert not hasattr(playback_stream_asgi, "waveform_peaks_registry")


def test_startup_gallery_preview_uses_runtime_display_cover_size_and_two_eager_covers():
    view = {
        "artist_groups": [
            {
                "artist": "Broadcast",
                "artist_display": "Broadcast",
                "albums": [
                    {
                        "key": "album-1",
                        "name": "Tender Buttons",
                        "album_artist": "Broadcast",
                        "cover_path": "X:/SyntheticMusic/Synthetic Artist/First Album/cover.jpg",
                        "track_count_preview": 1,
                    },
                    {
                        "key": "album-2",
                        "name": "Haha Sound",
                        "album_artist": "Broadcast",
                        "cover_path": "X:/SyntheticMusic/Synthetic Artist/Second Album/cover.jpg",
                        "track_count_preview": 1,
                    },
                    {
                        "key": "album-3",
                        "name": "The Noise Made By People",
                        "album_artist": "Broadcast",
                        "cover_path": "X:/SyntheticMusic/Synthetic Artist/Third Album/cover.jpg",
                        "track_count_preview": 1,
                    },
                ],
            }
        ],
        "primary_artist_groups": [],
        "family_artist_groups": [],
        "gallery_display_mode": "cards",
    }

    html = str(startup_bootstrap.build_startup_gallery_html(view))

    assert "size=480" in html
    assert "size=320" not in html
    assert "size=640" not in html
    assert html.count('loading="eager"') == 2
    assert html.count('fetchpriority="high"') == 2
    assert html.count('loading="lazy"') == 1
    assert html.count('fetchpriority="low"') == 1


def test_favicon_route_returns_cacheable_empty_response(asgi_app):
    status, headers, body = run_asgi_request(asgi_app, "GET", "/favicon.ico")

    assert status == 204
    assert headers.get("cache-control") == "public, max-age=86400"
    assert body == b""


def test_index_renders_shell_without_legacy_flask_route_module(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    def fake_build_postgres_root_startup_view(*, config, query_args):
        assert config is asgi_app.state.config
        assert query_args.get("surface") is None
        return (
            {
                "surface": {"active": "albums"},
                "shell_layout": {"slots": {"main_content": {"content_kind": "gallery", "surface_ref": "albums"}}},
                "artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "primary_artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "family_artist_groups": [],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                    {"artist": "Mono", "artist_display": "Mono", "count": 1},
                ],
                "artist_count": 2,
                "album_count": 2,
                "query": "",
                "selected_artist": "",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "related_filter_artists": [],
                "primary_filter_active": False,
                "gallery_scope": "all",
                "gallery_display_mode": "cards",
                "gallery_scale_percent": 100,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                "app_name": "Album Haven",
                "app_version": "0.9.30",
                "ignored_version_keys": [],
                "manual_version_links": {},
                "non_album_tracks": [],
                "non_album_exception_values": [],
                "initial_view_partial": True,
            },
            {
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                    {"artist": "Mono", "artist_display": "Mono", "count": 1},
                ],
                "artist_count": 2,
                "album_count": 2,
                "payload_tier": "sidebar",
            },
            0.0,
        )

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "_build_postgres_root_startup_view", fake_build_postgres_root_startup_view)
    status, headers, body = run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    assert headers["pragma"] == "no-cache"
    assert headers["expires"] == "0"
    assert b"<!doctype html>" in body
    assert b"Album Haven" in body
    runtime_asset_version = asgi_app.state.runtime_asset_version
    encoded_runtime_asset_version = runtime_asset_version.encode("ascii")
    assert b'<link rel="preload" href="/static/app.js?v=' + encoded_runtime_asset_version + b'"' in body
    assert (
        b'<link rel="preload" href="/static/js/runtime-bundle.js?v='
        + encoded_runtime_asset_version
        + b'"'
        in body
    )
    assert b'<script src="/static/app.js?v=' + encoded_runtime_asset_version + b'"' in body
    assert (
        b'<script src="/static/js/runtime-bundle.js?v='
        + encoded_runtime_asset_version
        + b'"'
        in body
    )
    assert (
        f'window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ = {json.dumps(runtime_asset_version)};'.encode(
            "utf-8"
        )
        in body
    )
    assert b'id="global-audio-player"' not in body
    assert b'id="global-audio-player-preload"' not in body
    assert body.find(b'<link rel="preload" href="/static/app.js?v=') < body.find(
        b'<link rel="stylesheet"'
    )
    assert body.find(b'<script src="/static/app.js?v=') < body.find(b"</head>")
    assert b"MUSIC_APP_INITIAL_VIEW" not in body
    assert b"MUSIC_APP_BOOTSTRAP" not in body
    assert b"__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__" in body
    assert b'js/runtime/core-state-and-helpers.js' not in body
    payload = _extract_bootstrap_payload_from_shell(body)
    assert payload["initial_view"]["surface"]["active"] == "albums"
    assert payload["bootstrap"]["startupPreview"]["mode"] == "fresh_preview"
    assert [group["artist"] for group in payload["initial_view"]["artist_groups"]] == ["Broadcast"]
    assert [item["artist"] for item in payload["initial_view"]["artists_sidebar"]] == ["Broadcast", "Mono"]
    assert payload["bootstrap"]["startupHydration"]["endpoint"] == "/view-data?surface=albums&payload_tier=sidebar"
    assert payload["bootstrap"]["startupHydration"]["followupEndpoint"] == "/view-data?surface=albums&omit_sidebar=1"
    assert payload["bootstrap"]["startupHydration"]["tier"] == "sidebar"
    assert b'id="library-loader" hidden' in body
    assert b'<div class="albums-scroll" id="albums-scroll" hidden>' not in body
    assert b'data-sidebar-artist="Broadcast"' in body
    assert payload["bootstrap"]["startupHydration"]["embeddedViewPatch"] == {
        "artists_sidebar": [
            {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
            {"artist": "Mono", "artist_display": "Mono", "count": 1},
        ],
        "artist_count": 2,
        "album_count": 2,
        "payload_tier": "sidebar",
    }


def test_postgres_root_startup_embedded_patch_preserves_preview_gallery(monkeypatch):
    from music_app.routes import web_asgi

    preview_payload = {
        "surface": {"active": "albums"},
        "artist_groups": [
            {
                "artist": "Broadcast",
                "artist_display": "Broadcast",
                "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                "sections": [],
            }
        ],
        "primary_artist_groups": [
            {
                "artist": "Broadcast",
                "artist_display": "Broadcast",
                "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                "sections": [],
            }
        ],
        "family_artist_groups": [],
        "artists_sidebar": [
            {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
        ],
        "artist_count": 1,
        "album_count": 1,
        "payload_tier": "sidebar",
        "initial_view_partial": True,
    }

    class FakePostgresLibraryBrowseRepository:
        def __init__(self, _config):
            pass

        def build_root_sidebar_payload(self, *, query_params):
            return preview_payload

    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        FakePostgresLibraryBrowseRepository,
    )

    initial_view, embedded_view_patch, _elapsed_ms = web_asgi._build_postgres_root_startup_view(
        config={},
        query_args={},
    )

    assert initial_view["artist_groups"][0]["artist"] == "Broadcast"
    assert embedded_view_patch is not None
    assert embedded_view_patch["artist_groups"][0]["artist"] == "Broadcast"
    assert embedded_view_patch["primary_artist_groups"][0]["artist"] == "Broadcast"
    assert embedded_view_patch["family_artist_groups"] == []


def test_web_bootstrap_source_has_no_json_or_file_bootstrap_preview_loader():
    from music_app.routes import web_asgi

    source = Path(web_asgi.__file__).read_text(encoding="utf-8")

    assert "from music_app.services.json_files import" not in source
    assert "load_json_file(" not in source
    assert "_bootstrap_cache_path" not in source
    assert "_load_cached_root_startup_preview" not in source
    assert "_start_background_library_hydration_for_state" not in source
    assert 'startup_preview_mode == "cached_preview"' not in source


def test_index_fails_loudly_when_postgres_browse_is_unavailable_without_file_fallback(
    asgi_app,
    tmp_path,
    monkeypatch,
):
    from music_app.routes import web_asgi
    from music_app.services import library_browse_postgres

    def fail_json_load(*_args, **_kwargs):
        raise AssertionError("Production bootstrap must not read a JSON bootstrap preview")

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Unavailable Postgres browse must not hydrate file-backed runtime state")

    asgi_app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    asgi_app.state.config["PERSISTENCE_BACKENDS"] = {
        **asgi_app.state.config.get("PERSISTENCE_BACKENDS", {}),
        "library_browse": "postgres",
    }
    monkeypatch.setattr(library_browse_postgres, "psycopg", None)
    monkeypatch.setattr(web_asgi, "load_json_file", fail_json_load, raising=False)
    monkeypatch.setattr(web_asgi.state_service, "hydrate_library_state_for_config", fail_hydrate)

    cache_path = tmp_path / "library_cache.json"
    asgi_app.state.config["CACHE_PATH"] = cache_path
    bootstrap_path = cache_path.with_name("library_cache.bootstrap.json")
    bootstrap_path.write_text(
        json.dumps(
            {
                "library_root_identity": library_root_cache_identity(asgi_app.state.config),
                "preview_kind": "root_startup",
                "initial_view": {"artists_sidebar": [{"artist": "JSON fallback must not render"}]},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match="Postgres runtime persistence adapter is unavailable for library_browse",
    ):
        run_asgi_request(asgi_app, "GET", "/", query={"surface": "albums"})


def test_bootstrap_data_preserves_startup_hydration_query_contract(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "_build_postgres_selected_artist_startup_view",
        lambda **_kwargs: (
            {
                "surface": {"active": "albums"},
                "shell_layout": {"slots": {"main_content": {"content_kind": "gallery"}}},
                "artist_groups": [],
                "primary_artist_groups": [],
                "family_artist_groups": [],
                "related_artists": [],
                "artists_sidebar": [],
                "album_count": 0,
                "artist_count": 0,
                "query": "",
                "selected_artist": "Broadcast",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "related_filter_artists": ["Stereolab", "Pram"],
                "primary_filter_active": False,
                "gallery_scope": "all",
                "gallery_display_mode": "covers",
                "gallery_scale_percent": 135,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                "app_name": "Album Haven",
                "app_version": "0.9.30",
                "ignored_version_keys": [],
                "manual_version_links": {},
                "non_album_tracks": [],
                "non_album_exception_values": [],
                "initial_view_partial": False,
                "selected_artist_family_display_mode": "chronological",
            },
            0.0,
        ),
    )

    status, _headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/bootstrap-data",
        query={
            "artist": "Broadcast",
            "gallery_display": "covers",
            "gallery_scale_percent": "135",
            "family_display": "chronological",
            "related_artist": ["Stereolab", "Pram"],
        },
    )

    assert status == 200
    payload = decode_json(body)
    assert payload["initial_view"]["gallery_display_mode"] == "covers"
    assert payload["initial_view"]["gallery_scale_percent"] == 135
    assert payload["initial_view"]["selected_artist_family_display_mode"] == "chronological"
    assert payload["bootstrap"]["startupHydration"]["endpoint"] == (
        "/view-data?surface=albums&artist=Broadcast&family_display=chronological"
        "&gallery_display=covers&gallery_scale_percent=135&related_artist=Stereolab&related_artist=Pram"
    )


def test_index_selected_artist_uses_postgres_startup_preview(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    class FakePostgresLibraryBrowseRepository:
        def __init__(self, _config):
            pass

        def build_root_sidebar_payload(self, *, query_params):
            assert query_params.get("artist") == "Broadcast"
            return {
                "artists_sidebar": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "count": 1,
                    },
                    {
                        "artist": "Stereolab",
                        "artist_display": "Stereolab",
                        "count": 1,
                    },
                ],
                "artist_count": 2,
                "show_all_artists_sidebar_link": True,
            }

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            return {
                "surface": {"active": "albums"},
                "shell_layout": {"slots": {"main_content": {"content_kind": "gallery"}}},
                "artist_groups": [],
                "primary_artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                    }
                ],
                "family_artist_groups": [
                    {
                        "artist": "Stereolab",
                        "artist_display": "Stereolab",
                        "albums": [{"key": "album-2", "name": "Dots and Loops", "tracks": []}],
                    }
                ],
                "related_artists": ["Stereolab"],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                    {"artist": "Stereolab", "artist_display": "Stereolab", "count": 1},
                ],
                "album_count": 2,
                "artist_count": 2,
                "query": "",
                "selected_artist": "Broadcast",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "related_filter_artists": [],
                "primary_filter_active": False,
                "gallery_scope": "all",
                "gallery_display_mode": "cards",
                "gallery_scale_percent": 100,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                "app_name": "Album Haven",
                "app_version": "0.9.30",
                "ignored_version_keys": [],
                "manual_version_links": {},
                "non_album_tracks": [],
                "non_album_exception_values": [],
                "initial_view_partial": False,
                "selected_artist_family_display_mode": "grouped",
            }

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "PostgresLibraryBrowseRepository",
        FakePostgresLibraryBrowseRepository,
    )
    status, _headers, body = run_asgi_request(asgi_app, "GET", "/", query={"artist": "Broadcast"})

    assert status == 200
    payload = _extract_bootstrap_payload_from_shell(body)
    assert payload["bootstrap"]["startupPreview"]["mode"] == "full_view"
    assert payload["initial_view"]["selected_artist"] == "Broadcast"
    assert [group["artist"] for group in payload["initial_view"]["family_artist_groups"]] == ["Stereolab"]
    assert payload["bootstrap"]["startupHydration"]["endpoint"] == "/view-data?surface=albums&artist=Broadcast"
def test_index_surface_albums_uses_postgres_root_sidebar_startup_patch(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    monkeypatch.setattr(
        web_asgi,
        "_build_postgres_root_startup_view",
        lambda **_kwargs: (
            {
                "surface": {"active": "albums"},
                "shell_layout": {"slots": {"main_content": {"content_kind": "gallery", "surface_ref": "albums"}}},
                "artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "primary_artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "family_artist_groups": [],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                ],
                "artist_count": 1,
                "album_count": 1,
                "query": "",
                "selected_artist": "",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "related_filter_artists": [],
                "primary_filter_active": False,
                "gallery_scope": "all",
                "gallery_display_mode": "cards",
                "gallery_scale_percent": 100,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                "app_name": "Album Haven",
                "app_version": "0.9.30",
                "ignored_version_keys": [],
                "manual_version_links": {},
                "non_album_tracks": [],
                "non_album_exception_values": [],
                "initial_view_partial": True,
            },
            {
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                ],
                "artist_count": 1,
                "album_count": 1,
                "payload_tier": "sidebar",
            },
            0.0,
        ),
    )
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)

    status, _headers, body = run_asgi_request(asgi_app, "GET", "/", query={"surface": "albums"})

    assert status == 200
    payload = _extract_bootstrap_payload_from_shell(body)
    assert payload["bootstrap"]["startupPreview"]["mode"] == "fresh_preview"
    assert payload["bootstrap"]["startupHydration"]["tier"] == "sidebar"
    assert payload["bootstrap"]["startupHydration"]["endpoint"] == "/view-data?surface=albums&payload_tier=sidebar"
    assert payload["bootstrap"]["startupHydration"]["followupEndpoint"] == "/view-data?surface=albums&omit_sidebar=1"
    assert payload["bootstrap"]["startupHydration"]["embeddedViewPatch"] == {
        "artists_sidebar": [
            {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
        ],
        "artist_count": 1,
        "album_count": 1,
        "payload_tier": "sidebar",
    }


def test_index_surface_albums_ignores_cached_root_startup_preview_when_postgres_browse_is_effective(
    asgi_app,
    tmp_path,
    monkeypatch,
):
    from music_app.routes import web_asgi

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(
        web_asgi,
        "_build_postgres_root_startup_view",
        lambda **_kwargs: (
            {
                "surface": {"active": "albums"},
                "shell_layout": {"slots": {"main_content": {"content_kind": "gallery", "surface_ref": "albums"}}},
                "artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "primary_artist_groups": [
                    {
                        "artist": "Broadcast",
                        "artist_display": "Broadcast",
                        "albums": [{"key": "album-1", "name": "Tender Buttons", "tracks": []}],
                        "sections": [],
                    }
                ],
                "family_artist_groups": [],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                ],
                "artist_count": 1,
                "album_count": 1,
                "query": "",
                "selected_artist": "",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "related_filter_artists": [],
                "primary_filter_active": False,
                "gallery_scope": "all",
                "gallery_display_mode": "cards",
                "gallery_scale_percent": 100,
                "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                "app_name": "Album Haven",
                "app_version": "0.9.30",
                "ignored_version_keys": [],
                "manual_version_links": {},
                "non_album_tracks": [],
                "non_album_exception_values": [],
                "initial_view_partial": True,
            },
            {
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                ],
                "artist_count": 1,
                "album_count": 1,
                "payload_tier": "sidebar",
            },
            0.0,
        ),
    )

    cache_path = tmp_path / "library_cache.json"
    asgi_app.state.config["CACHE_PATH"] = cache_path
    bootstrap_path = cache_path.with_name("library_cache.bootstrap.json")
    bootstrap_path.write_text(
        json.dumps(
            {
                "library_root_identity": library_root_cache_identity(asgi_app.state.config),
                "preview_kind": "root_startup",
                "initial_view": {
                    "surface": {"active": "albums"},
                    "shell_layout": {"slots": {"main_content": {"content_kind": "gallery"}}},
                    "artist_groups": [],
                    "primary_artist_groups": [],
                    "family_artist_groups": [],
                    "artists_sidebar": [
                        {"artist": "Should Not Render", "artist_display": "Should Not Render", "count": 99},
                    ],
                    "album_count": 99,
                    "artist_count": 99,
                    "query": "",
                    "selected_artist": "",
                    "all_artists_active": False,
                    "show_all_artists_sidebar_link": True,
                    "related_filter_artists": [],
                    "primary_filter_active": False,
                    "gallery_scope": "all",
                    "gallery_display_mode": "cards",
                    "gallery_scale_percent": 100,
                    "visible_library_categories": ["main_library", "hoard", "new_arrivals"],
                    "music_dir": str(asgi_app.state.config["MUSIC_DIR"]),
                    "app_name": "Album Haven",
                    "app_version": "0.9.30",
                    "ignored_version_keys": [],
                    "manual_version_links": {},
                    "non_album_tracks": [],
                    "non_album_exception_values": [],
                    "initial_view_partial": True,
                },
                "full_artists_sidebar": [
                    {"artist": "Should Not Render", "artist_display": "Should Not Render", "count": 99},
                ],
            }
        ),
        encoding="utf-8",
    )

    status, _headers, body = run_asgi_request(asgi_app, "GET", "/", query={"surface": "albums"})

    assert status == 200
    payload = _extract_bootstrap_payload_from_shell(body)
    assert payload["bootstrap"]["startupPreview"]["mode"] == "fresh_preview"
    assert [item["artist"] for item in payload["initial_view"]["artists_sidebar"]] == ["Broadcast"]
    assert payload["bootstrap"]["startupHydration"]["endpoint"] == "/view-data?surface=albums&payload_tier=sidebar"
    assert payload["bootstrap"]["startupHydration"]["embeddedViewPatch"] == {
        "artists_sidebar": [
            {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
        ],
        "artist_count": 1,
        "album_count": 1,
        "payload_tier": "sidebar",
    }


def test_build_initial_view_preview_preserves_explicit_partial_flag():
    preview = startup_bootstrap.build_initial_view_preview(
        {
            "artist_groups": [
                {
                    "artist": "Broadcast",
                    "artist_display": "Broadcast",
                    "albums": [{"key": "album-1", "name": "Tender Buttons"}],
                    "sections": [],
                }
            ],
            "primary_artist_groups": [
                {
                    "artist": "Broadcast",
                    "artist_display": "Broadcast",
                    "albums": [{"key": "album-1", "name": "Tender Buttons"}],
                    "sections": [],
                }
            ],
            "family_artist_groups": [],
            "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
            "initial_view_partial": True,
        }
    )

    assert preview["initial_view_partial"] is True


def test_build_initial_view_preview_preserves_compact_album_track_count():
    preview = startup_bootstrap.build_initial_view_preview(
        {
            "artist_groups": [
                {
                    "artist": "ДДТ",
                    "artist_display": "ДДТ",
                    "albums": [
                        {
                            "key": "ddt-studio-records",
                            "name": "Студийные записи",
                            "album_artist": "ДДТ",
                            "track_count_preview": 16,
                            "tracks": [],
                            "preview_only": True,
                        }
                    ],
                }
            ],
            "primary_artist_groups": [],
            "family_artist_groups": [],
            "artists_sidebar": [],
        }
    )

    preview_album = preview["artist_groups"][0]["albums"][0]
    markup = str(startup_bootstrap.build_startup_album_card_html(preview_album))

    assert preview_album["track_count_preview"] == 16
    assert preview_album["tracks"] == []
    assert "16 tracks" in markup


def test_startup_sidebar_artist_links_keep_album_surface_contract():
    markup = startup_bootstrap.build_startup_sidebar_html(
        {
            "query": "dream pop",
            "selected_artist": "Beach House",
            "show_all_artists_sidebar_link": True,
            "all_artists_active": False,
            "artists_sidebar": [
                {
                    "artist": "Beach House",
                    "artist_display": "Beach House",
                    "count": 8,
                }
            ],
        }
    )

    html = str(markup)

    assert 'href="/?surface=albums&amp;q=dream+pop&amp;artist=Beach+House"' in html
    assert 'href="/?q=dream+pop&amp;artist=Beach+House"' not in html


def test_startup_sidebar_uses_artist_count_for_all_artists_total():
    markup = startup_bootstrap.build_startup_sidebar_html(
        {
            "query": "",
            "selected_artist": "",
            "artist_count": 128,
            "show_all_artists_sidebar_link": True,
            "all_artists_active": True,
            "artists_sidebar": [
                {
                    "artist": "3",
                    "artist_display": "3",
                    "count": 1,
                }
            ],
        }
    )

    html = str(markup)

    assert '<span class="artist-count">128</span>' in html
    assert 'data-sidebar-home="1"' not in html


def test_startup_preview_uses_explicit_gallery_mode_dispatch():
    view = {
        "artist_groups": [
            {
                "artist": "Broadcast",
                "artist_display": "Broadcast",
                "albums": [
                    {
                        "key": "album-1",
                        "name": "Tender Buttons",
                        "album_artist": "Broadcast",
                        "tracks": [],
                    }
                ],
            }
        ],
        "primary_artist_groups": [],
        "family_artist_groups": [],
        "gallery_display_mode": "list",
    }

    assert startup_bootstrap.resolve_startup_gallery_render_mode("cards") == "cards"
    assert startup_bootstrap.resolve_startup_gallery_render_mode("covers") == "covers"
    assert startup_bootstrap.resolve_startup_gallery_render_mode("list") == "list"
    assert startup_bootstrap.resolve_startup_gallery_render_mode("unexpected-mode") == "cards"
    assert (
        startup_bootstrap.get_startup_gallery_renderer("covers")
        is startup_bootstrap.build_startup_cards_gallery_html
    )
    assert 'data-startup-preview-section="1"' in str(startup_bootstrap.build_startup_gallery_html(view))


def test_build_startup_cover_url_uses_stable_process_token_without_filesystem_access(monkeypatch):
    cover_path = r"\\fixture.invalid\album-haven-e2e\Artist\Album\cover.jpg"

    original_stat = Path.stat

    def filesystem_access_forbidden(path, *args, **kwargs):
        if str(path) == cover_path:
            raise AssertionError("startup cover URL construction must not access the filesystem")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", filesystem_access_forbidden)
    expected_url = (
        f"/cover?path={quote(cover_path)}&size=480"
        f"&v=process-{startup_bootstrap.COVER_CACHE_PROCESS_TOKEN}"
    )

    assert startup_bootstrap.build_startup_cover_url({"cover_path": cover_path}) == expected_url
    assert startup_bootstrap.build_startup_cover_url({"cover_path": cover_path}) == expected_url


def test_build_startup_cover_url_keeps_explicit_preview_url_authoritative(tmp_path, monkeypatch):
    cover_path = tmp_path / "cover.jpg"
    cover_path.write_bytes(b"real-cover-bytes")
    explicit_url = "/cover?path=canonical-cover.jpg&size=480&v=authoritative"

    assert startup_bootstrap.build_startup_cover_url(
        {
            "cover_path": str(cover_path),
            "cover_preview_url": explicit_url,
        }
    ) == explicit_url


def test_initial_preview_and_server_markup_share_one_canonical_local_cover_url(tmp_path):
    cover_path = tmp_path / "cover.jpg"
    cover_path.write_bytes(b"canonical-cover")
    payload = {
        "artist_groups": [
            {
                "artist": "Broadcast",
                "albums": [
                    {
                        "key": "broadcast::tender-buttons",
                        "name": "Tender Buttons",
                        "album_artist": "Broadcast",
                        "cover_path": str(cover_path),
                        "tracks": [],
                    }
                ],
            }
        ],
        "primary_artist_groups": [],
        "family_artist_groups": [],
        "artists_sidebar": [],
    }

    preview = startup_bootstrap.build_initial_view_preview(payload)
    album = preview["artist_groups"][0]["albums"][0]
    canonical_url = album["cover_preview_url"]
    markup = unescape(str(startup_bootstrap.build_startup_gallery_html(preview)))

    assert canonical_url
    assert canonical_url in markup
    assert markup.count(canonical_url) == 1


def test_build_startup_album_card_html_includes_remote_fallback_for_local_cover_errors():
    markup = startup_bootstrap.build_startup_album_card_html(
        {
            "key": "album-1",
            "name": "One",
            "album_artist": "Artist",
            "cover_path": r"C:\Music\Artist\Album\cover.jpg",
            "remote_cover_thumbnail_url": "https://images.example/thumb.jpg",
            "track_count_preview": 2,
            "album_rating": 7,
        }
    )

    assert 'data-cover-path="C:\\Music\\Artist\\Album\\cover.jpg"' in markup
    assert 'data-remote-cover-url="https://images.example/thumb.jpg"' in markup
    assert "__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__" in markup
    assert "remoteCoverTried" in markup
    assert 'data-cover-visual-state="pending"' in markup
    assert 'aria-hidden="true"' in markup
    assert "naturalWidth&gt;0" in markup
    assert "cover-placeholder cover-placeholder-blank" in markup
    assert "textContent:'No cover art'" not in markup


@pytest.mark.parametrize("rating", [1, 10])
def test_build_startup_album_card_html_renders_only_valid_app_owned_rating(rating):
    markup = startup_bootstrap.build_startup_album_card_html(
        {
            "key": f"app-rated-{rating}",
            "name": f"App Rated {rating}",
            "album_artist": "Rating Artist",
            "album_rating": 4,
            "tag_album_rating": 9,
            "album_preference": {"rating": rating},
            "tracks": [],
        }
    )

    assert '<div class="rating-row">' in markup
    assert f'<div class="stars" role="img" aria-label="Album rating {rating}/10">' in markup
    assert f'<div class="rating-text">{rating}/10</div>' in markup
    assert f'aria-label="Album rating 4/10"' not in markup
    assert f'aria-label="Album rating 9/10"' not in markup
    assert markup.count('<span class="star') == 10
    assert markup.count('class="star filled"') == rating
    assert markup.count('class="star"') == 10 - rating
    assert markup.count("&#9733;") == rating
    assert markup.count("&#9734;") == 10 - rating


@pytest.mark.parametrize(
    "album_preference",
    [
        pytest.param("missing", id="album-preference-absent"),
        pytest.param(None, id="album-preference-null"),
        pytest.param({}, id="rating-absent"),
        pytest.param({"rating": None}, id="rating-explicitly-cleared"),
        pytest.param({"rating": "7"}, id="numeric-string"),
        pytest.param({"rating": "excellent"}, id="malformed-string"),
        pytest.param({"rating": 7.5}, id="non-integer"),
        pytest.param({"rating": 0}, id="zero"),
        pytest.param({"rating": -1}, id="negative"),
        pytest.param({"rating": 11}, id="above-ten"),
        pytest.param({"rating": True}, id="boolean"),
    ],
)
def test_build_startup_album_card_html_renders_invalid_or_cleared_app_rating_as_unrated(
    album_preference,
):
    album = {
        "key": "unrated-album",
        "name": "Unrated Album",
        "album_artist": "Rating Artist",
        "album_rating": 8,
        "tag_album_rating": 9,
        "tracks": [],
    }
    if album_preference != "missing":
        album["album_preference"] = album_preference

    markup = startup_bootstrap.build_startup_album_card_html(album)

    assert '<div class="rating-row">' in markup
    assert '<div class="stars" role="img" aria-label="Album unrated">' in markup
    assert markup.count('<span class="star') == 10
    assert markup.count('class="star filled"') == 0
    assert markup.count('class="star"') == 10
    assert "&#9733;" not in markup
    assert markup.count("&#9734;") == 10
    assert 'aria-label="Album rating' not in markup
    assert 'class="rating-text"' not in markup
    assert "/10" not in markup


def test_initial_view_preview_can_strip_private_album_preference_overlays_for_public_safe_context():
    preview = startup_bootstrap.build_initial_view_preview(
        {
            "artist_groups": [
                {
                    "artist": "Neal Morse",
                    "artist_display": "Neal Morse",
                    "albums": [
                        {
                            "key": "neal-1",
                            "name": "One",
                            "album_artist": "Neal Morse",
                            "artists": ["Neal Morse"],
                            "cover_path": "neal-morse/one/cover.jpg",
                            "album_rating": 9,
                            "album_preference": {
                                "rating": 10,
                                "favorite_override": "on",
                                "is_favorite": True,
                                "favorite_source": "manual_override",
                                "can_edit": True,
                                "to_listen": True,
                                "is_relisten": True,
                                "can_toggle_to_listen": True,
                            },
                            "top_viewer_overlay": {
                                "item_progress": {
                                    "effective_baseline_at": "2026-06-09T12:00:00Z",
                                    "baseline_rating": 7,
                                    "progress_state": "active",
                                    "follow_up_state": "needs_rating",
                                },
                                "viewer_filters": {
                                    "hide_rated_albums": True,
                                    "hide_listened_albums": True,
                                    "action_needed_focus": True,
                                },
                                "can_edit_viewer_filters": True,
                            },
                            "tracks": [{"title": "Track 1"}, {"title": "Track 2"}],
                        }
                    ],
                }
            ],
            "primary_artist_groups": [],
            "family_artist_groups": [],
            "artists_sidebar": [],
        },
        public_safe=True,
    )

    preview_album = preview["artist_groups"][0]["albums"][0]
    assert preview_album["album_ref"] == "neal-1"
    assert preview_album["album_preference"] == {
        "rating": None,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": False,
        "to_listen": False,
        "is_relisten": False,
        "can_toggle_to_listen": False,
    }
    assert preview_album["top_viewer_overlay"] == {
        "item_progress": {
            "effective_baseline_at": None,
            "baseline_rating": None,
            "progress_state": "not_started",
            "follow_up_state": "none",
        },
        "viewer_filters": {
            "hide_rated_albums": False,
            "hide_listened_albums": False,
            "action_needed_focus": False,
        },
        "can_edit_viewer_filters": False,
    }
    assert preview_album["track_count_preview"] == 2
    assert preview_album["tracks"] == []


def test_asgi_cover_route_probes_exact_cached_variant_off_event_loop(app, asgi_app, monkeypatch):
    cover_path = app.config["MUSIC_DIR"] / "Artist" / "Album" / "cover.jpg"
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (2400, 1800), color=(32, 96, 160)).save(cover_path, format="JPEG", quality=92)

    from music_app.services.covers import find_existing_cover_display_variant
    from music_app.services.covers import resolve_cover_display_variant
    from music_app.routes.web_asgi import _conditional_file_response
    from music_app.routes.web_asgi import resolve_configured_media_path

    cached_variant = resolve_cover_display_variant(
        cover_path,
        cache_root=Path(app.config["DATA_DIR"]),
        max_size=320,
    )
    assert cached_variant != cover_path

    event_loop_thread_id = threading.get_ident()
    probe_thread_ids: dict[str, list[int]] = {
        "source": [],
        "cache": [],
        "response_stat": [],
    }

    def record_source_probe(*args, **kwargs):
        probe_thread_ids["source"].append(threading.get_ident())
        return resolve_configured_media_path(*args, **kwargs)

    def record_cache_probe(*args, **kwargs):
        probe_thread_ids["cache"].append(threading.get_ident())
        return find_existing_cover_display_variant(*args, **kwargs)

    def record_response_stat(*args, **kwargs):
        probe_thread_ids["response_stat"].append(threading.get_ident())
        return _conditional_file_response(*args, **kwargs)

    monkeypatch.setattr(
        "music_app.routes.web_asgi.resolve_configured_media_path",
        record_source_probe,
    )

    monkeypatch.setattr(
        "music_app.routes.web_asgi.find_existing_cover_display_variant",
        record_cache_probe,
    )

    def fail_if_cache_miss_is_resolved(*_args, **_kwargs):
        raise AssertionError("the exact cached variant should avoid generation")

    monkeypatch.setattr(
        "music_app.routes.web_asgi.resolve_cover_display_variant",
        fail_if_cache_miss_is_resolved,
    )
    monkeypatch.setattr(
        "music_app.routes.web_asgi._conditional_file_response",
        record_response_stat,
    )

    status, headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path), "size": "320"},
    )

    assert status == 200
    assert "max-age=300" in headers.get("cache-control", "")
    assert all(probe_thread_ids.values())
    assert all(
        thread_id != event_loop_thread_id
        for stage_thread_ids in probe_thread_ids.values()
        for thread_id in stage_thread_ids
    )
    rendered = Image.open(io.BytesIO(body))
    assert rendered.size == (320, 240)
    assert body != cover_path.read_bytes()
    assert body == cached_variant.read_bytes()


def test_asgi_cover_route_reuses_loaded_library_root_paths_for_authorization(
    app,
    asgi_app,
    monkeypatch,
):
    cover_path = app.config["MUSIC_DIR"] / "Artist" / "Album" / "cover.jpg"
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 320), color=(32, 96, 160)).save(cover_path, format="JPEG")
    configured_roots = (Path(app.config["MUSIC_DIR"]).resolve(),)
    observed_root_paths = []

    monkeypatch.setattr(
        "music_app.routes.web_asgi.configured_library_root_paths_snapshot",
        lambda config: configured_roots,
    )

    from music_app.routes.web_asgi import resolve_configured_media_path

    def record_source_probe(config, raw_path, **kwargs):
        observed_root_paths.append(kwargs.get("configured_root_paths"))
        return resolve_configured_media_path(config, raw_path, **kwargs)

    monkeypatch.setattr(
        "music_app.routes.web_asgi.resolve_configured_media_path",
        record_source_probe,
    )

    status, _headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path), "size": "480"},
    )

    assert status == 200
    assert body == cover_path.read_bytes()
    assert observed_root_paths == [configured_roots]


def test_asgi_cover_route_maps_explicit_background_priority_header(app, asgi_app, monkeypatch, tmp_path):
    cover_path = app.config["MUSIC_DIR"] / "Artist" / "Album" / "cover.jpg"
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (640, 640), color=(64, 96, 128)).save(cover_path, format="JPEG")
    bounded_variant = tmp_path / "bounded-background.png"
    Image.new("RGB", (480, 480), color=(64, 96, 128)).save(bounded_variant, format="PNG")
    observed_priorities: list[str] = []

    def fake_resolve(source_path, *, cache_root, max_size, priority):
        observed_priorities.append(str(priority))
        return bounded_variant

    monkeypatch.setattr("music_app.routes.web_asgi.resolve_cover_display_variant", fake_resolve)

    status, headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path), "size": "480"},
        headers={"x-album-haven-cover-priority": "background"},
    )

    assert status == 200
    assert headers["content-type"].startswith("image/png")
    assert body == bounded_variant.read_bytes()
    assert observed_priorities == ["background"]


def test_asgi_cover_route_maps_missing_priority_header_to_foreground(app, asgi_app, monkeypatch, tmp_path):
    cover_path = app.config["MUSIC_DIR"] / "Artist" / "Album" / "cover.jpg"
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (640, 640), color=(64, 96, 128)).save(cover_path, format="JPEG")
    bounded_variant = tmp_path / "bounded-foreground.png"
    Image.new("RGB", (480, 480), color=(64, 96, 128)).save(bounded_variant, format="PNG")
    observed_priorities: list[str] = []

    def fake_resolve(source_path, *, cache_root, max_size, priority):
        observed_priorities.append(str(priority))
        return bounded_variant

    monkeypatch.setattr("music_app.routes.web_asgi.resolve_cover_display_variant", fake_resolve)

    status, headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/cover",
        query={"path": str(cover_path), "size": "480"},
    )

    assert status == 200
    assert headers["content-type"].startswith("image/png")
    assert body == bounded_variant.read_bytes()
    assert observed_priorities == ["foreground"]


def test_asgi_track_and_loop_media_routes_preserve_private_file_policy(app, asgi_app, monkeypatch):
    persisted_loops: list[dict[str, object]] = []

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

    track_path = (Path(app.config["MUSIC_DIR"]) / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track-bytes")

    loop_path = (loops_dir(app.config) / "loop-1.mp3").resolve()
    loop_path.write_bytes(b"loop-bytes")
    save_loops(app.config, [{"id": "loop-1", "path": str(loop_path)}])

    preview_path = (loop_previews_dir(app.config) / "loop-1_pplus1.mp3").resolve()
    preview_path.write_bytes(b"preview-bytes")

    track_status, _track_headers, track_body = run_asgi_request(
        asgi_app,
        "GET",
        "/track",
        query={"path": str(track_path)},
    )
    outside_status, _outside_headers, _outside_body = run_asgi_request(
        asgi_app,
        "GET",
        "/track",
        query={"path": str(track_path.parent.parent.parent / "outside.mp3")},
    )
    loop_status, _loop_headers, loop_body = run_asgi_request(asgi_app, "GET", "/loops/media/loop-1")
    preview_status, _preview_headers, preview_body = run_asgi_request(
        asgi_app,
        "GET",
        "/loops/pitch-preview/loop-1_pplus1",
    )

    assert track_status == 200
    assert track_body == b"track-bytes"
    assert outside_status == 404
    assert loop_status == 200
    assert loop_body == b"loop-bytes"
    assert preview_status == 200
    assert preview_body == b"preview-bytes"


def test_app_js_loads_generated_runtime_bundle_after_bootstrap_payload_setup():
    repo_root = Path(__file__).resolve().parents[2]
    app_js_path = repo_root / "music_app" / "static" / "app.js"
    runtime_bundle_path = repo_root / "music_app" / "static" / "js" / "runtime-bundle.js"
    bootstrap_state_path = repo_root / "music_app" / "static" / "js" / "runtime" / "bootstrap-state.js"
    startup_metrics_path = repo_root / "music_app" / "static" / "js" / "runtime" / "startup-metrics-helpers.js"
    legacy_js_dir = repo_root / "music_app" / "static" / "js"
    app_js = app_js_path.read_text(encoding="utf-8")
    runtime_bundle_js = runtime_bundle_path.read_text(encoding="utf-8")
    bootstrap_state_js = bootstrap_state_path.read_text(encoding="utf-8")
    startup_metrics_js = startup_metrics_path.read_text(encoding="utf-8")

    assert "const runtimeAssetVersion = encodeURIComponent(" in app_js
    assert "const runtimeBundlePath = `js/runtime-bundle.js${runtimeAssetVersion" in app_js
    assert "const scriptPaths = [" not in app_js
    assert "Promise.all(scriptPaths.map" not in app_js
    assert "// BEGIN js/runtime/bootstrap-state.js" in runtime_bundle_js
    assert "// BEGIN js/runtime/bootstrap-init.js" in runtime_bundle_js
    assert runtime_bundle_js.index("// BEGIN js/runtime/bootstrap-state.js") < runtime_bundle_js.index(
        "// BEGIN js/runtime/bootstrap-init.js"
    )
    assert "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__" in app_js
    assert "__ALBUM_HAVEN_STARTUP_MARKS__" in app_js
    assert "renderStartupGalleryPreview" in app_js
    assert "hasBootstrapPayload" in app_js
    assert "window.MUSIC_APP_INITIAL_VIEW" not in app_js
    assert "window.MUSIC_APP_BOOTSTRAP" not in app_js
    assert "window.MUSIC_APP_INITIAL_VIEW" not in bootstrap_state_js
    assert "window.MUSIC_APP_BOOTSTRAP" not in bootstrap_state_js
    assert "runtime_boot_complete" in startup_metrics_js
    assert {path.name for path in legacy_js_dir.glob("*.js")} == {
        "runtime-bundle.js",
        "login.js",
        "password-recovery.js",
        "account.js",
        "admin-members.js",
    }
