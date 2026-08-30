from __future__ import annotations

import asyncio
import json
from pathlib import Path
from threading import Event, Thread
from types import ModuleType
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


def _make_asgi_app():
    from music_app import create_asgi_app

    return create_asgi_app()


def test_asgi_read_routes_register_natively(asgi_app):
    route_paths = _collect_route_paths(asgi_app)
    for route_path in (
        "/status",
        "/home-data",
        "/view-data",
        "/album-details",
        "/utilities/problematic-files",
        "/utilities/problematic-files/detail",
        "/utilities/problematic-files/{album_key:path}",
        "/utilities/loops",
        "/utilities/log-history",
        "/album-notes",
        "/album-notes/{note_ref}",
        "/album-note-replies",
        "/album-note-replies/{reply_ref}",
        "/album-opinions/{album_ref}/crowd",
        "/people/{person_ref}",
        "/works/{work_ref}",
        "/soundtracks/{soundtrack_ref}",
        "/companies/{company_ref}",
    ):
        assert route_path in route_paths


def test_asgi_status_route_preserves_current_payload_shape(app):
    asgi_app = _make_asgi_app()

    status, headers, body = _run_asgi_request(asgi_app, "GET", "/status")

    assert status == 200
    assert headers["content-type"].startswith("application/json")
    payload = _decode_json(body)
    assert payload["scan_in_progress"] is False
    assert payload["scan_percent"] == 0
    assert payload["scan_mode"] == "idle"
    assert payload["scan_outcome"] == "idle"
    assert payload["relations_percent"] == 0
    assert payload["covers_in_progress"] is False
    assert payload["album_total"] == 0
    assert payload["last_scan_display"] == "Never"
    revision_epoch, revision_counter = payload["log_history_revision"].rsplit(":", 1)
    assert revision_epoch
    assert revision_counter == "0"


def test_status_payload_counts_matching_active_scan_preview_without_leaking_preview_metadata():
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    library_state = {
        "scan_in_progress": True,
        "scan_generation": 3,
        "albums": [],
        "last_scan": 10.0,
        "relation_views": {"artists": ["Durable Artist"]},
        "relations_processed": 4,
        "relations_total": 5,
        "active_scan_preview_state": {
            "scan_generation": 3,
            "publication_state": {
                "albums": [{"key": "unsafe-publication-album"}],
                "last_scan": 999.0,
            },
            "browse_snapshot": {
                "file_cache": {},
                "albums": [{"key": "partial-1"}, {"key": "partial-2"}],
                "separate_release_keys": set(),
            },
        },
    }

    payload = asgi_read_routes._build_status_payload_from_state(library_state)

    assert payload["scan_generation"] == 3
    assert payload["album_total"] == 2
    assert payload["last_scan_display"] == asgi_read_routes.format_timestamp(10.0)
    assert payload["relations_processed"] == 4
    assert payload["relations_total"] == 5


def test_asgi_status_route_does_not_enter_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_flask_app(_request):
        raise AssertionError("ASGI status route must not read state through the Flask bridge")

    app.library_state["albums"] = []
    app.library_state["scan_processed"] = 0
    app.library_state["scan_total"] = 10
    asgi_app.state.library_state = {
        **app.library_state,
        "albums": [{"key": "album-1"}, {"key": "album-2"}],
        "scan_processed": 2,
        "scan_total": 4,
    }
    assert not hasattr(asgi_read_routes, "_flask_app")

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/status")

    assert status == 200
    payload = _decode_json(body)
    assert payload["album_total"] == 2
    assert payload["scan_percent"] == 50


def test_asgi_status_remains_responsive_while_view_data_build_is_blocked(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    view_data_entered = Event()
    status_completed = Event()
    release_view_data = Event()
    observation: dict[str, bool] = {}
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 1,
        "scan_mode": "background",
        "scan_phase": "indexing",
        "albums": [],
        "active_scan_preview_state": {
            "scan_generation": 1,
            "publication_state": {
                "file_cache": {},
                "albums": [{"key": "unsafe-publication-album"}],
                "separate_release_keys": set(),
            },
            "browse_snapshot": {
                "file_cache": {},
                "albums": [{"key": "partial-album"}],
                "separate_release_keys": set(),
            },
        },
    }

    def blocked_build_view_payload(**kwargs):
        assert kwargs["library_state"] is not asgi_app.state.library_state
        assert kwargs["library_state"]["albums"] == [{"key": "partial-album"}]
        view_data_entered.set()
        assert release_view_data.wait(timeout=3.0)
        return {
            "view_data_source": "transient_scan_state",
            "album_count": 1,
        }

    monkeypatch.setattr(asgi_read_routes, "build_view_payload", blocked_build_view_payload)

    async def request(path: str, query_string: bytes = b"") -> tuple[int, bytes]:
        messages: list[dict[str, object]] = []
        request_sent = False

        async def receive() -> dict[str, object]:
            nonlocal request_sent
            if request_sent:
                return {"type": "http.disconnect"}
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message: dict[str, object]) -> None:
            messages.append(message)

        await asgi_app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": path,
                "raw_path": path.encode("ascii"),
                "query_string": query_string,
                "headers": [(b"host", b"testserver")],
                "client": ("testclient", 50000),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        start = next(message for message in messages if message["type"] == "http.response.start")
        body = b"".join(
            message.get("body", b"")
            for message in messages
            if message["type"] == "http.response.body"
        )
        return int(start["status"]), body

    def release_after_status_observation() -> None:
        if not view_data_entered.wait(timeout=3.0):
            observation["view_data_entered"] = False
            release_view_data.set()
            return
        observation["view_data_entered"] = True
        observation["status_completed_before_release"] = status_completed.wait(timeout=1.0)
        release_view_data.set()

    controller = Thread(target=release_after_status_observation, daemon=True)
    controller.start()

    async def exercise_requests() -> tuple[tuple[int, bytes], tuple[int, bytes]]:
        view_data_task = asyncio.create_task(
            request("/view-data", b"surface=albums&omit_sidebar=1")
        )
        assert await asyncio.to_thread(view_data_entered.wait, 3.0)
        status_result = await request("/status")
        status_completed.set()
        return await view_data_task, status_result

    try:
        view_data_result, status_result = asyncio.run(exercise_requests())
    finally:
        release_view_data.set()
        controller.join(timeout=3.0)

    assert not controller.is_alive()
    assert observation == {
        "view_data_entered": True,
        "status_completed_before_release": True,
    }
    assert view_data_result[0] == 200
    assert _decode_json(view_data_result[1]) == {
        "view_data_source": "transient_scan_state",
        "album_count": 1,
    }
    assert status_result[0] == 200
    status_payload = _decode_json(status_result[1])
    assert status_payload["scan_in_progress"] is True
    assert status_payload["scan_mode"] == "background"
    assert status_payload["scan_phase"] == "indexing"
    assert status_payload["album_total"] == 1


@pytest.mark.parametrize(
    ("query", "expected_query"),
    [
        pytest.param(
            {"payload_tier": "sidebar", "surface": "library"},
            {"payload_tier": "sidebar", "surface": "library"},
            id="root-sidebar",
        ),
        pytest.param(
            {"artist": "Broadcast", "surface": "albums"},
            {"artist": "Broadcast", "surface": "albums"},
            id="selected-artist",
        ),
        pytest.param(
            {"q": "tender", "surface": "albums", "omit_sidebar": "1"},
            {"q": "tender", "surface": "albums", "omit_sidebar": "1"},
            id="album-search",
        ),
        pytest.param(
            {"surface": "albums", "omit_sidebar": "1"},
            {"surface": "albums", "omit_sidebar": "1"},
            id="root-album-browse",
        ),
    ],
)
def test_asgi_view_data_uses_generation_owned_preview_during_active_scan(
    app,
    asgi_app,
    monkeypatch,
    query,
    expected_query,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    transient_albums = [{"key": "partial-album", "artist": "Broadcast", "title": "Tender Buttons"}]
    preview_browse_snapshot = {
        "file_cache": {"partial.mp3": {"album": "Tender Buttons"}},
        "albums": transient_albums,
        "separate_release_keys": {"partial-release"},
    }
    preview_publication_state = {
        "file_cache": {"unsafe.mp3": {"album": "Unsafe Publication Album"}},
        "albums": [{"key": "unsafe-publication-album"}],
        "separate_release_keys": {"unsafe-publication-release"},
        "last_scan": 999.0,
        "relation_views": {"artists": ["Unsafe Partial Artist"]},
        "album_ratings": {"partial-album": 1},
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 4,
        "albums": [],
        "file_cache": {},
        "separate_release_keys": {"durable-release"},
        "last_scan": 10.0,
        "relation_views": {
            "artists": ["Durable Artist"],
            "folder_related": {"Durable Artist": []},
            "casefold_alias_to_canonical": {"STALE": "Stale"},
            "casefold_canonical_to_aliases": {"Stale": ["STALE"]},
        },
        "album_ratings": {"durable-album": 8},
        "active_scan_preview_state": {
            "scan_generation": 4,
            "publication_state": preview_publication_state,
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    build_calls: list[dict[str, object]] = []

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Active-scan view data must not hydrate file or cache state")

    class FailPostgresBrowseRepository:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("Active-scan view data must use the transient runtime snapshot")

    def fake_build_view_payload(**kwargs):
        build_calls.append(kwargs)
        resolved_state = kwargs["library_state"]
        assert resolved_state is not asgi_app.state.library_state
        assert resolved_state is not preview_publication_state
        assert resolved_state["file_cache"] is preview_browse_snapshot["file_cache"]
        assert resolved_state["albums"] is transient_albums
        assert resolved_state["separate_release_keys"] == {"partial-release"}
        assert resolved_state["scan_in_progress"] is True
        assert resolved_state["scan_generation"] == 4
        assert resolved_state["last_scan"] == 10.0
        assert resolved_state["relation_views"] == {
            "artists": ["Durable Artist"],
            "folder_related": {"Durable Artist": []},
        }
        assert resolved_state["relation_views"] is not (
            asgi_app.state.library_state["relation_views"]
        )
        assert resolved_state["album_ratings"] == {"durable-album": 8}
        assert kwargs["config"] is app.config
        assert kwargs["client_surface_class"] == "private_web"
        query_args = kwargs["query_args"]
        assert {key: query_args.get(key) for key in expected_query} == expected_query
        return {
            "view_data_source": "transient_scan_state",
            "album_count": len(kwargs["library_state"]["albums"]),
        }

    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "refresh_relation_views_for_state", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FailPostgresBrowseRepository)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fake_build_view_payload)

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/view-data", query=query)

    assert status == 200
    assert _decode_json(body) == {
        "view_data_source": "transient_scan_state",
        "album_count": 1,
    }
    assert len(build_calls) == 1
    assert asgi_app.state.library_state["albums"] == []
    assert asgi_app.state.library_state["active_scan_preview_state"]["publication_state"] is (
        preview_publication_state
    )
    assert asgi_app.state.library_state["active_scan_preview_state"]["browse_snapshot"] is (
        preview_browse_snapshot
    )


def test_asgi_active_scan_album_search_prefers_postgres_committed_library_over_transient_preview(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    committed_albums = [
        {"key": "committed-album", "artist": "Broadcast", "title": "Tender Buttons"},
    ]
    preview_browse_snapshot = {
        "file_cache": {"preview.mp3": {"album": "Future Tender Buttons"}},
        "albums": [
            {
                "key": "preview-album",
                "artist": "Broadcast",
                "title": "Future Tender Buttons",
            },
        ],
        "separate_release_keys": set(),
    }
    committed_library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 11,
        "albums": committed_albums,
        "active_scan_preview_state": {
            "scan_generation": 11,
            "publication_state": {
                "file_cache": {},
                "albums": [{"key": "uncommitted-publication-album"}],
                "separate_release_keys": set(),
            },
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    asgi_app.state.library_state = committed_library_state
    postgres_calls: list[tuple[object, object]] = []

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError(
            "Eligible Postgres search during an active scan must not hydrate file-backed state"
        )

    def fail_build_view_payload(*_args, **_kwargs):
        raise AssertionError(
            "Eligible Postgres search with committed albums must not build the transient preview"
        )

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config is app.config

        def build_search_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("q") == "tender"
            assert query_params.get("surface") == "albums"
            assert query_params.get("omit_sidebar") == "1"
            assert library_state is committed_library_state
            assert library_state["albums"] is committed_albums
            postgres_calls.append((query_params, library_state))
            return {
                "query": "tender",
                "album_count": 1,
                "view_data_source": "postgres_library_browse",
            }

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "refresh_relation_views_for_state", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"q": "tender", "surface": "albums", "omit_sidebar": "1"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "query": "tender",
        "album_count": 1,
        "view_data_source": "postgres_library_browse",
    }
    assert len(postgres_calls) == 1


def test_active_scan_preview_real_view_build_isolates_and_rebuilds_casefold_relation_cache(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.services import view_payloads as view_payloads_module

    monkeypatch.setattr(view_payloads_module, "load_manual_version_links", lambda *_args: {})
    monkeypatch.setattr(view_payloads_module, "load_ignored_version_keys", lambda *_args: set())
    monkeypatch.setattr(
        view_payloads_module,
        "get_primary_music_root",
        lambda *_args, **_kwargs: app.config["MUSIC_DIR"],
    )

    def album(key, artist, name):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=2026,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    first_albums = [
        album("mono-lower", "Mono", "First Partial"),
        album("mono-upper", "MONO", "Second Partial"),
    ]
    second_albums = [
        album("low-title", "Low", "First Later Partial"),
        album("low-upper", "LOW", "Second Later Partial"),
    ]
    durable_relation_views = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
        "durable_marker": {"preserved": True},
    }
    publication_state = {
        "file_cache": {"unsafe.mp3": {}},
        "albums": [album("unsafe", "Unsafe", "Unsafe Publication Album")],
        "separate_release_keys": {"unsafe-release"},
    }
    preview = {
        "scan_generation": 9,
        "publication_state": publication_state,
        "browse_snapshot": {
            "file_cache": {},
            "albums": first_albums,
            "separate_release_keys": set(),
        },
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 9,
        "file_cache": {},
        "albums": [],
        "relation_views": durable_relation_views,
        "active_scan_preview_state": preview,
    }
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = ""

    first_status, _first_headers, first_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"artist": "MONO", "surface": "albums"},
    )

    assert first_status == 200
    assert _decode_json(first_body)["selected_artist"] == "Mono"
    assert asgi_app.state.library_state["relation_views"] is durable_relation_views
    assert durable_relation_views == {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
        "durable_marker": {"preserved": True},
    }

    later_browse_snapshot = {
        "file_cache": {},
        "albums": second_albums,
        "separate_release_keys": set(),
    }
    preview["browse_snapshot"] = later_browse_snapshot
    second_status, _second_headers, second_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"artist": "LOW", "surface": "albums"},
    )

    assert second_status == 200
    assert _decode_json(second_body)["selected_artist"] == "Low"
    assert preview["browse_snapshot"] is later_browse_snapshot
    assert preview["publication_state"] is publication_state
    assert asgi_app.state.library_state["relation_views"] is durable_relation_views
    assert "casefold_alias_to_canonical" not in durable_relation_views
    assert "casefold_canonical_to_aliases" not in durable_relation_views


def test_asgi_view_data_overlays_app_rating_on_transient_scan_payload(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services.listen_through import default_album_preference_overlay

    preview_browse_snapshot = {
        "file_cache": {"rated.mp3": {"album": "Rated Album"}},
        "albums": [{"key": "rated-album", "album_rating": 9}],
        "separate_release_keys": set(),
    }
    preview_publication_state = {
        "file_cache": {"unsafe.mp3": {}},
        "albums": [{"key": "unsafe-publication-album"}],
        "separate_release_keys": {"unsafe-release"},
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 5,
        "albums": [],
        "active_scan_preview_state": {
            "scan_generation": 5,
            "publication_state": preview_publication_state,
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/pytest_album_ratings_e2e"
    )
    rating_loads: list[list[object]] = []

    class FakePostgresAlbumRatingsService:
        def __init__(self, config):
            assert config is app.config

        def load_album_ratings(self, album_keys):
            rating_loads.append(list(album_keys))
            return {
                "rated-album": {
                    "rating": 5,
                    "provenance": "explicit_import",
                }
            }

    def fake_build_view_payload(**kwargs):
        assert kwargs["library_state"]["albums"] is preview_browse_snapshot["albums"]
        assert kwargs["library_state"]["scan_in_progress"] is True
        return {
            "artist_groups": [
                {
                    "artist": "Rated Artist",
                    "albums": [
                        {
                            "key": "rated-album",
                            "album_rating": 9,
                            "tag_album_rating": 9,
                            "tag_album_rating_source": "file_tag",
                            "album_preference": default_album_preference_overlay(),
                            "gallery_list_block": {
                                "summary": {
                                    "album_preference": default_album_preference_overlay(),
                                }
                            },
                        }
                    ],
                }
            ],
            "album_count": 1,
        }

    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresAlbumRatingsService",
        FakePostgresAlbumRatingsService,
        raising=False,
    )
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fake_build_view_payload)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"surface": "albums", "omit_sidebar": "1"},
    )

    assert status == 200
    album_payload = _decode_json(body)["artist_groups"][0]["albums"][0]
    assert album_payload["album_preference"] == {
        "rating": 5,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "to_listen": False,
        "is_relisten": False,
        "can_toggle_to_listen": False,
        "provenance": "explicit_import",
        "can_edit": True,
    }
    assert album_payload["tag_album_rating"] == 9
    assert album_payload["tag_album_rating_source"] == "file_tag"
    assert album_payload["gallery_list_block"]["summary"]["album_preference"] == (
        album_payload["album_preference"]
    )
    assert rating_loads == [["rated-album"]]


@pytest.mark.parametrize(
    "scan_state",
    [
        pytest.param({"scan_in_progress": True, "albums": []}, id="empty-partial-state"),
        pytest.param(
            {"scan_in_progress": False, "albums": [{"key": "completed-album"}]},
            id="completed-scan",
        ),
    ],
)
def test_asgi_view_data_scan_guard_preserves_postgres_root_sidebar_routing(
    app,
    asgi_app,
    monkeypatch,
    scan_state,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    asgi_app.state.library_state = {**app.library_state, **scan_state}
    repository_calls: list[dict[str, str]] = []

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Postgres root/sidebar routing must not hydrate file or cache state")

    def fail_build_view_payload(**_kwargs):
        raise AssertionError("The scan guard must preserve Postgres repository routing")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config is app.config

        def build_root_sidebar_payload(self, *, query_params=None):
            repository_calls.append(dict(query_params))
            return {
                "payload_tier": "sidebar",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self, *args, **kwargs: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "refresh_relation_views_for_state", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakePostgresBrowseRepository)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"payload_tier": "sidebar", "surface": "library"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "payload_tier": "sidebar",
        "view_data_source": "postgres_library_browse",
    }
    assert repository_calls == [{"payload_tier": "sidebar", "surface": "library"}]


def test_asgi_view_and_home_routes_hydrate_and_log_through_explicit_asgi_dependencies(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[str] = []
    logged_calls: list[tuple[dict[str, object], float]] = []
    build_view_kwargs: dict[str, object] = {}

    def fail_flask_app(_request):
        raise AssertionError("ASGI view-data fallback must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI view-data fallback must not enter Flask test_request_context")

    def fake_hydrate_library_from_disk(*, ensure_relations=False, validate_cache=False):
        hydrate_calls.append(f"{ensure_relations}:{validate_cache}")
        return False

    def fake_hydrate_library_state_for_config(library_state, config, *, ensure_relations=False, validate_cache=False):
        assert library_state is not None
        assert config is app.config
        return fake_hydrate_library_from_disk(
            ensure_relations=ensure_relations,
            validate_cache=validate_cache,
        )

    def fake_build_view_payload(**kwargs) -> dict[str, object]:
        build_view_kwargs.update(kwargs)
        query_args = kwargs["query_args"]
        assert kwargs["config"] is app.config
        assert kwargs["logger"] is not None
        assert kwargs["library_state"] is not None
        assert kwargs["client_surface_class"] == "mobile"
        return {
            "kind": "view",
            "query": query_args.get("q", ""),
            "selected_artist": query_args.get("artist", ""),
            "album_count": 3,
            "artist_count": 2,
        }

    def fake_build_home_payload(**kwargs) -> dict[str, object]:
        assert kwargs["config"]["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        assert kwargs["library_state"] is not None
        assert kwargs["query_args"].get("q") == "ignored"
        return {
            "kind": "home",
            "query": "ignored",
            "selected_artist": "",
            "album_count": 0,
            "artist_count": 0,
        }

    # The Flask compatibility app no longer exists; the ASGI route contract above
    # is now the direct proof that no bridge context is entered.
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "memory"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda _request, payload, started: logged_calls.append((payload, started)))
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fake_build_view_payload)
    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)

    perf_values = iter([10.0, 20.0])
    monkeypatch.setattr(asgi_read_routes.time, "perf_counter", lambda: next(perf_values))

    view_status, _view_headers, view_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "q": ["mono", "ignored-last-query-value"],
            "artist": "Mono",
            "client_surface": ["mobile", "tv"],
        },
        headers={"X-Album-Haven-Client-Surface": "tv"},
    )
    home_status, _home_headers, home_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/home-data",
        query={"q": "ignored"},
    )

    view_payload = _decode_json(view_body)
    home_payload = _decode_json(home_body)
    assert view_status == 200
    assert home_status == 200
    assert view_payload == {
        "kind": "view",
        "query": "mono",
        "selected_artist": "Mono",
        "album_count": 3,
        "artist_count": 2,
    }
    assert home_payload == {
        "kind": "home",
        "query": "ignored",
        "selected_artist": "",
        "album_count": 0,
        "artist_count": 0,
    }
    assert hydrate_calls == ["False:False", "False:False"]
    assert build_view_kwargs["query_args"].get("q") == "mono"
    assert build_view_kwargs["query_args"].getlist("q") == ["mono", "ignored-last-query-value"]
    assert build_view_kwargs["query_args"].get("artist") == "Mono"
    assert logged_calls == [
        (view_payload, 10.0),
        (home_payload, 20.0),
    ]


def test_log_view_data_request_from_asgi_records_request_summary(app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    recorded = {}

    def fake_log_app_event(config, logger, message, **kwargs):
        recorded["config"] = config
        recorded["logger"] = logger
        recorded["message"] = message
        recorded["kwargs"] = kwargs

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(config=app.config, logger=app.logger)))
    monkeypatch.setattr(asgi_read_routes, "log_app_event", fake_log_app_event)
    monkeypatch.setattr(asgi_read_routes.time, "perf_counter", lambda: 10.125)

    asgi_read_routes._log_view_data_request_from_asgi(
        request,
        {
            "query": "mono",
            "selected_artist": "Mono",
            "album_count": 7,
            "artist_count": 2,
        },
        request_started_at=10.0,
    )

    assert recorded["config"] is app.config
    assert recorded["logger"] is app.logger
    assert recorded["message"] == "View data request completed"
    assert recorded["kwargs"]["level"] == "info"
    assert "emit_to_file" not in recorded["kwargs"]
    assert recorded["kwargs"]["elapsed_ms"] == 125.0
    assert recorded["kwargs"]["query"] == "mono"
    assert recorded["kwargs"]["selected_artist"] == "Mono"
    assert recorded["kwargs"]["album_count"] == 7
    assert recorded["kwargs"]["artist_count"] == 2


def test_asgi_home_data_uses_asgi_state_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    logged_calls: list[tuple[dict[str, object], float]] = []

    def fail_flask_app(_request):
        raise AssertionError("ASGI home-data route must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI home-data route must not enter Flask test_request_context")

    def fake_build_home_payload(**kwargs) -> dict[str, object]:
        assert kwargs["config"]["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        assert kwargs["library_state"] is not None
        return {
            "kind": "home",
            "query": "from-asgi",
            "selected_artist": "",
            "album_count": 0,
            "artist_count": 0,
        }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is False
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "memory"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda _request, payload, started: logged_calls.append((payload, started)))
    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)
    monkeypatch.setattr(asgi_read_routes.time, "perf_counter", lambda: 30.0)

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/home-data")

    payload = _decode_json(body)
    assert status == 200
    assert payload["kind"] == "home"
    assert hydrate_calls == [True]
    assert logged_calls == [(payload, 30.0)]


def test_asgi_home_data_hydrates_empty_state_with_explicit_config(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services import state as state_service

    asgi_library_state = {
        **app.library_state,
        "albums": [],
        "file_cache": {},
        "scan_in_progress": False,
    }
    asgi_app.state.library_state = asgi_library_state
    hydrate_calls: list[tuple[dict[str, object], dict[str, object], bool, bool, bool, bool]] = []

    def fail_flask_app(_request):
        raise AssertionError("ASGI home-data route must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI home-data route must not enter Flask test_request_context")

    def fake_hydrate_library_state_from_disk(
        library_state,
        config,
        *,
        ensure_relations=True,
        validate_cache=True,
        ensure_relation_views=None,
        load_exception_overrides=None,
        queue_problematic_albums_prewarm=None,
        queue_utility_rules_prewarm=None,
    ):
        hydrate_calls.append(
            (
                library_state,
                config,
                ensure_relations,
                validate_cache,
                ensure_relation_views is not None,
                queue_problematic_albums_prewarm is not None or queue_utility_rules_prewarm is not None,
            )
        )
        assert load_exception_overrides is not None
        library_state["albums"] = [{"key": "album-1"}]
        return True

    def fake_build_home_payload(**kwargs) -> dict[str, object]:
        assert kwargs["config"] is app.config
        assert kwargs["library_state"] is asgi_library_state
        return {
            "kind": "home",
            "query": "",
            "selected_artist": "",
            "album_count": len(kwargs["library_state"]["albums"]),
            "artist_count": 0,
        }

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(state_service, "hydrate_library_state_from_disk", fake_hydrate_library_state_from_disk)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "memory"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda *_args: None)
    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/home-data")

    assert status == 200
    assert _decode_json(body)["album_count"] == 1
    assert hydrate_calls == [(asgi_library_state, app.config, False, False, False, False)]


def test_asgi_home_data_uses_postgres_root_sidebar_as_authoritative_state(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    repository_calls: list[dict[str, object]] = []
    threadpool_calls: list[tuple[object, tuple[object, ...], dict[str, object]]] = []
    threadpool_active = False

    async def fake_run_in_threadpool(function, *args, **kwargs):
        nonlocal threadpool_active
        threadpool_calls.append((function, args, kwargs))
        threadpool_active = True
        try:
            return function(*args, **kwargs)
        finally:
            threadpool_active = False

    def fake_build_home_payload(**_kwargs) -> dict[str, object]:
        return {
            "kind": "home",
            "recent_listens": [{"album": "Preserved home content"}],
            "artists_sidebar": [
                {"artist": "Stale runtime artist", "artist_display": "Stale runtime artist", "count": 1},
            ],
            "artist_count": 1,
            "album_count": 99,
            "show_all_artists_sidebar_link": False,
        }

    class FakePostgresSidebarRepository:
        def __init__(self, config):
            assert config is app.config

        def build_root_sidebar_payload(self, *, query_params=None):
            assert threadpool_active is True
            repository_calls.append(
                {
                    "gallery_display": query_params.get("gallery_display"),
                    "categories": query_params.getlist("category"),
                }
            )
            return {
                "artists_sidebar": [
                    {"artist": "Frank Churchill", "artist_display": "Frank Churchill", "count": 1},
                    {"artist": "Larry Morey", "artist_display": "Larry Morey", "count": 1},
                ],
                "artist_count": 2,
                "album_count": 2,
                "show_all_artists_sidebar_link": True,
                "persistence_backend": "postgres",
                "view_data_source": "postgres_library_browse",
            }

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", lambda _request: None)
    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakePostgresSidebarRepository)
    monkeypatch.setattr(
        asgi_read_routes,
        "run_in_threadpool",
        fake_run_in_threadpool,
        raising=False,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda *_args: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/home-data",
        query={
            "gallery_display": "covers",
            "category": ["main_library", "new_arrivals"],
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert payload["kind"] == "home"
    assert payload["recent_listens"] == [{"album": "Preserved home content"}]
    assert payload["artists_sidebar"] == [
        {"artist": "Frank Churchill", "artist_display": "Frank Churchill", "count": 1},
        {"artist": "Larry Morey", "artist_display": "Larry Morey", "count": 1},
    ]
    assert payload["artist_count"] == 2
    assert payload["album_count"] == 2
    assert payload["show_all_artists_sidebar_link"] is True
    assert repository_calls == [
        {
            "gallery_display": "covers",
            "categories": ["main_library", "new_arrivals"],
        }
    ]
    assert len(threadpool_calls) == 1
    threadpool_function, threadpool_args, threadpool_kwargs = threadpool_calls[0]
    assert threadpool_function.__name__ == "build_root_sidebar_payload"
    assert threadpool_args == ()
    assert threadpool_kwargs["query_params"].get("gallery_display") == "covers"


def test_asgi_home_data_omit_sidebar_keeps_postgres_counts_without_readding_sidebar(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    repository_queries: list[dict[str, object]] = []
    threadpool_functions: list[str] = []

    async def fake_run_in_threadpool(function, *args, **kwargs):
        threadpool_functions.append(function.__name__)
        return function(*args, **kwargs)

    def fake_build_home_payload(**kwargs) -> dict[str, object]:
        assert kwargs["query_args"].get("omit_sidebar") == "1"
        return {
            "kind": "home",
            "artist_count": 1,
            "album_count": 99,
            "show_all_artists_sidebar_link": False,
        }

    class FakePostgresSidebarRepository:
        def __init__(self, config):
            assert config is app.config

        def build_root_sidebar_payload(self, *, query_params=None):
            raise AssertionError("omit_sidebar must not build the full Postgres sidebar payload")

        def build_root_counts_payload(self, *, query_params=None):
            repository_queries.append(
                {
                    "omit_sidebar": query_params.get("omit_sidebar"),
                    "gallery_display": query_params.get("gallery_display"),
                    "categories": query_params.getlist("category"),
                }
            )
            return {
                "artist_count": 2,
                "album_count": 3,
                "show_all_artists_sidebar_link": True,
            }

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", lambda _request: None)
    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakePostgresSidebarRepository)
    monkeypatch.setattr(
        asgi_read_routes,
        "run_in_threadpool",
        fake_run_in_threadpool,
        raising=False,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda *_args: None)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/home-data",
        query={
            "omit_sidebar": "1",
            "gallery_display": "list",
            "category": ["main_library", "new_arrivals"],
        },
    )

    payload = _decode_json(body)
    assert status == 200
    assert "artists_sidebar" not in payload
    assert payload["artist_count"] == 2
    assert payload["album_count"] == 3
    assert payload["show_all_artists_sidebar_link"] is True
    assert repository_queries == [
        {
            "omit_sidebar": "1",
            "gallery_display": "list",
            "categories": ["main_library", "new_arrivals"],
        }
    ]
    assert threadpool_functions == ["build_root_counts_payload"]


def test_asgi_home_data_preserves_transient_sidebar_while_scan_is_active(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    transient_sidebar = [
        {"artist": "New scan artist", "artist_display": "New scan artist", "count": 1},
    ]
    preview_browse_snapshot = {
        "file_cache": {"new.mp3": {"album": "New Scan Album"}},
        "albums": [{"key": "new-scan-album"}],
        "separate_release_keys": {"new-release"},
    }
    preview_publication_state = {
        "file_cache": {"unsafe.mp3": {}},
        "albums": [{"key": "unsafe-publication-album"}],
        "separate_release_keys": {"unsafe-release"},
    }
    asgi_app.state.library_state.update({
        "scan_in_progress": True,
        "scan_generation": 6,
        "albums": [],
        "file_cache": {},
        "active_scan_preview_state": {
            "scan_generation": 6,
            "publication_state": preview_publication_state,
            "browse_snapshot": preview_browse_snapshot,
        },
    })

    def fail_postgres_selection(*_args, **_kwargs):
        raise AssertionError("An active scan must keep its transient home sidebar")

    def fake_build_home_payload(**kwargs):
        resolved_state = kwargs["library_state"]
        assert resolved_state is not asgi_app.state.library_state
        assert resolved_state["albums"] is preview_browse_snapshot["albums"]
        assert resolved_state["file_cache"] is preview_browse_snapshot["file_cache"]
        assert resolved_state["scan_in_progress"] is True
        return {
            "kind": "home",
            "artists_sidebar": transient_sidebar,
            "artist_count": 1,
            "show_all_artists_sidebar_link": True,
        }

    monkeypatch.setattr(asgi_read_routes, "build_home_payload", fake_build_home_payload)
    monkeypatch.setattr(asgi_read_routes, "select_runtime_persistence_adapter", fail_postgres_selection)
    monkeypatch.setattr(asgi_read_routes, "_log_view_data_request_from_asgi", lambda *_args: None)

    status, _headers, body = _run_asgi_request(asgi_app, "GET", "/home-data")

    payload = _decode_json(body)
    assert status == 200
    assert payload["artists_sidebar"] == transient_sidebar
    assert payload["artist_count"] == 1


def test_asgi_sidebar_root_uses_postgres_browse_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_hydrate():
        raise AssertionError("Postgres sidebar path must not hydrate the JSON cache")

    def fail_build_view_payload():
        raise AssertionError("Postgres sidebar path must not call build_view_payload")

    class FailingBridgeContext:
        def __enter__(self):
            raise AssertionError("Postgres sidebar path must not enter Flask test_request_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_test_request_context(*_args, **_kwargs):
        return FailingBridgeContext()

    def fail_flask_app(_request):
        raise AssertionError("Postgres sidebar path must not read config through the Flask bridge")

    class FakePostgresSidebarRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_root_sidebar_payload(self, *, query_params=None):
            assert query_params.get("gallery_display") == "covers"
            assert query_params.get("gallery_scale_percent") == "120"
            assert query_params.getlist("category") == ["main_library", "new_arrivals"]
            return {
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 2},
                    {"artist": "Mono", "artist_display": "Mono", "count": 1},
                ],
                "album_count": 3,
                "artist_count": 2,
                "gallery_display_mode": "covers",
                "gallery_scale_percent": 120,
                "visible_library_categories": ["main_library", "new_arrivals"],
                "selected_artist": "",
                "all_artists_active": False,
                "show_all_artists_sidebar_link": True,
                "payload_tier": "sidebar",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresSidebarRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "payload_tier": "sidebar",
            "surface": "albums",
            "gallery_display": "covers",
            "gallery_scale_percent": "120",
            "category": ["main_library", "new_arrivals"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["payload_tier"] == "sidebar"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["album_count"] == 3
    assert payload["artist_count"] == 2
    assert payload["gallery_display_mode"] == "covers"
    assert payload["gallery_scale_percent"] == 120
    assert payload["visible_library_categories"] == ["main_library", "new_arrivals"]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Broadcast", "Mono"]


def test_asgi_selected_artist_uses_postgres_browse_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        library_state["relation_views"] = {"artists": ["Broadcast"]}
        library_state["relations_last_built"] = 123.0
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload():
        raise AssertionError("Postgres selected artist path must not call build_view_payload")

    class FailingBridgeContext:
        def __enter__(self):
            raise AssertionError("Postgres selected artist path must not enter Flask test_request_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_test_request_context(*_args, **_kwargs):
        return FailingBridgeContext()

    def fail_flask_app(_request):
        raise AssertionError("Postgres selected artist path must not read config through the Flask bridge")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("gallery_display") == "covers"
            assert query_params.get("omit_sidebar") == "1"
            assert query_params.getlist("category") == ["main_library"]
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "gallery_display": "covers",
            "omit_sidebar": "1",
            "category": ["main_library"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["payload_tier"] == "full"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"


def test_asgi_selected_artist_without_omit_sidebar_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        library_state["relation_views"] = {"artists": ["Broadcast"]}
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Ordinary Postgres selected artist requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_root_sidebar_payload(self, *, query_params=None):
            raise AssertionError("Ordinary selected artist requests must not build the root sidebar payload")

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("omit_sidebar") is None
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["artists_sidebar"] == [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}]
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_selected_artist_root_sidebar_composes_only_root_sidebar_fields(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }
    repository_instances: list[object] = []
    calls: list[str] = []

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Root-sidebar composition must remain on the Postgres selected-artist route")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"
            repository_instances.append(self)

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("root_sidebar") == "1"
            assert query_params.getlist("category") == ["main_library"]
            assert library_state is asgi_app.state.library_state
            calls.append("selected")
            return {
                "selected_artist": "Broadcast",
                "artist_groups": [
                    {
                        "artist": "Broadcast",
                        "albums": [{"key": "broadcast-tender-buttons", "title": "Tender Buttons"}],
                    }
                ],
                "primary_artist_groups": [],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}
                ],
                "album_count": 1,
                "artist_count": 1,
                "show_all_artists_sidebar_link": False,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

        def build_root_sidebar_payload(self, *, query_params=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("root_sidebar") == "1"
            assert query_params.getlist("category") == ["main_library"]
            calls.append("root_sidebar")
            return {
                "artist_groups": [{"artist": "Wrong Root Preview", "albums": []}],
                "artists_sidebar": [
                    {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
                    {"artist": "Mono", "artist_display": "Mono", "count": 2},
                ],
                "album_count": 73,
                "artist_count": 2,
                "show_all_artists_sidebar_link": True,
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "root_sidebar": "1",
            "category": ["main_library"],
        },
    )

    assert status == 200
    assert len(repository_instances) == 1
    assert calls == ["selected", "root_sidebar"]
    payload = _decode_json(body)
    assert payload["selected_artist"] == "Broadcast"
    assert payload["artist_groups"] == [
        {
            "artist": "Broadcast",
            "albums": [{"key": "broadcast-tender-buttons", "title": "Tender Buttons"}],
        }
    ]
    assert payload["album_count"] == 1
    assert payload["artists_sidebar"] == [
        {"artist": "Broadcast", "artist_display": "Broadcast", "count": 1},
        {"artist": "Mono", "artist_display": "Mono", "count": 2},
    ]
    assert payload["artist_count"] == 2
    assert payload["show_all_artists_sidebar_link"] is True
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_selected_artist_query_context_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        library_state["relation_views"] = {"artists": ["Broadcast"]}
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Postgres selected artist query-context requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("q") == "tender"
            assert query_params.get("omit_sidebar") == "1"
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "query": "tender",
                "artist_groups": [],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "q": "tender",
            "omit_sidebar": "1",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["query"] == "tender"
    assert payload["payload_tier"] == "full"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"


def test_asgi_selected_artist_family_display_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Selected-artist family-display requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("family_display") == "chronological"
            assert query_params.get("omit_sidebar") == "1"
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "selected_artist_family_display_mode": "chronological",
                "artist_groups": [],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [{"artist": "Trish Keenan", "albums": []}],
                "related_artists": ["Trish Keenan"],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 2,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "family_display": "chronological",
            "omit_sidebar": "1",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["selected_artist_family_display_mode"] == "chronological"
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_selected_artist_related_artist_filter_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Selected-artist related-artist requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.getlist("related_artist") == ["James Cargill"]
            assert query_params.get("omit_sidebar") == "1"
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "related_filter_artists": ["James Cargill"],
                "primary_filter_active": False,
                "artist_groups": [{"artist": "James Cargill", "albums": []}],
                "primary_artist_groups": [],
                "family_artist_groups": [{"artist": "James Cargill", "albums": []}],
                "related_artists": ["Trish Keenan", "James Cargill"],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "related_artist": ["James Cargill"],
            "omit_sidebar": "1",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["James Cargill"]
    assert payload["primary_filter_active"] is False
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_selected_artist_primary_filter_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Selected-artist primary-filter requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") == "albums"
            assert query_params.get("primary_filter") == "1"
            assert query_params.get("omit_sidebar") == "1"
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "related_filter_artists": [],
                "primary_filter_active": True,
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": ["Trish Keenan"],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "surface": "albums",
            "primary_filter": "1",
            "omit_sidebar": "1",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is True
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_album_search_uses_postgres_browse_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        library_state["relation_views"] = {"artists": ["Broadcast"]}
        library_state["relations_last_built"] = 123.0
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload():
        raise AssertionError("Postgres album search path must not call build_view_payload")

    class FailingBridgeContext:
        def __enter__(self):
            raise AssertionError("Postgres album search path must not enter Flask test_request_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_test_request_context(*_args, **_kwargs):
        return FailingBridgeContext()

    def fail_flask_app(_request):
        raise AssertionError("Postgres album search path must not read config through the Flask bridge")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_search_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("q") == "tender"
            assert query_params.get("surface") == "albums"
            assert query_params.get("gallery_display") == "covers"
            assert query_params.getlist("category") == ["main_library"]
            assert library_state is asgi_app.state.library_state
            return {
                "query": "tender",
                "selected_artist": "",
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "q": "tender",
            "surface": "albums",
            "gallery_display": "covers",
            "category": ["main_library"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["query"] == "tender"
    assert payload["selected_artist"] == ""
    assert payload["payload_tier"] == "full"
    assert payload["view_data_source"] == "postgres_library_browse"


def test_asgi_album_search_all_artists_without_omit_sidebar_uses_postgres_browse(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {
        "albums": ["loaded"],
        "relation_views": {},
    }

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        library_state["relation_views"] = {"artists": ["Broadcast"]}
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(*args, **kwargs):
        raise AssertionError("Ordinary Postgres all-artists search requests must not fall back to build_view_payload")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_search_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("q") == "tender"
            assert query_params.get("surface") == "albums"
            assert query_params.get("all_artists") == "1"
            assert query_params.get("omit_sidebar") is None
            assert library_state is asgi_app.state.library_state
            return {
                "query": "tender",
                "selected_artist": "",
                "all_artists_active": True,
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
                "album_count": 1,
                "artist_count": 1,
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "q": "tender",
            "surface": "albums",
            "all_artists": "1",
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert hydrate_calls == []
    assert payload["query"] == "tender"
    assert payload["selected_artist"] == ""
    assert payload["all_artists_active"] is True
    assert payload["artists_sidebar"] == [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}]
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"


def test_postgres_browse_library_state_does_not_hydrate_when_postgres_family_lookup_is_unavailable(app, asgi_app, monkeypatch):
    from starlette.requests import Request
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    asgi_app.state.library_state = {}
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"

    def fake_hydrate_cached_library_for_asgi(request, *, ensure_relations=False):
        raise AssertionError("Postgres browse state should not hydrate cached relation views during read routing")

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fake_hydrate_cached_library_for_asgi)

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/view-data",
            "query_string": b"artist=Broadcast&surface=albums&omit_sidebar=1",
            "headers": [],
            "app": asgi_app,
        }
    )

    returned_state = asgi_read_routes._postgres_browse_library_state(request)

    assert hydrate_calls == []
    assert returned_state is asgi_app.state.library_state
    assert returned_state == {}


def test_postgres_album_search_request_allows_search_scoped_all_artists(app, asgi_app, monkeypatch):
    from starlette.requests import Request
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/view-data",
            "query_string": b"q=tender&surface=albums&all_artists=1&omit_sidebar=1",
            "headers": [],
            "app": asgi_app,
        }
    )

    assert asgi_read_routes._is_postgres_album_search_request(request) is True


def test_postgres_album_search_request_allows_search_scoped_all_artists_without_omit_sidebar(app, asgi_app, monkeypatch):
    from starlette.requests import Request
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/view-data",
            "query_string": b"q=tender&surface=albums&all_artists=1",
            "headers": [],
            "app": asgi_app,
        }
    )

    assert asgi_read_routes._is_postgres_album_search_request(request) is True


def test_postgres_selected_artist_request_allows_query_context(app, asgi_app, monkeypatch):
    from starlette.requests import Request
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/view-data",
            "query_string": "q=%D0%90%D1%80%D0%B8%D1%8F&artist=%D0%91%D0%98-2&surface=albums&omit_sidebar=1".encode("ascii"),
            "headers": [],
            "app": asgi_app,
        }
    )

    assert asgi_read_routes._is_postgres_selected_artist_request(request) is True


def test_postgres_selected_artist_request_does_not_require_omit_sidebar(app, asgi_app, monkeypatch):
    from starlette.requests import Request
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self: None})(),
    )

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/view-data",
            "query_string": b"artist=Broadcast&surface=albums",
            "headers": [],
            "app": asgi_app,
        }
    )

    assert asgi_read_routes._is_postgres_selected_artist_request(request) is True


def test_asgi_root_album_browse_uses_postgres_browse_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_hydrate():
        raise AssertionError("Postgres root album browse path must not hydrate the JSON cache")

    def fail_build_view_payload():
        raise AssertionError("Postgres root album browse path must not call build_view_payload")

    class FailingBridgeContext:
        def __enter__(self):
            raise AssertionError("Postgres root album browse path must not enter Flask test_request_context")

        def __exit__(self, exc_type, exc, traceback):
            return False

    def fail_test_request_context(*_args, **_kwargs):
        return FailingBridgeContext()

    def fail_flask_app(_request):
        raise AssertionError("Postgres root album browse path must not read config through the Flask bridge")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_root_album_browse_payload(self, *, query_params=None):
            assert query_params.get("surface") == "albums"
            assert query_params.get("gallery_display") == "covers"
            assert query_params.get("gallery_scale_percent") == "120"
            assert query_params.get("omit_sidebar") == "1"
            assert query_params.getlist("category") == ["main_library", "new_arrivals"]
            return {
                "surface": {"active_surface": "albums"},
                "shell_layout": {"active_surface": "albums"},
                "artist_groups": [{"artist": "Broadcast", "albums": []}],
                "primary_artist_groups": [{"artist": "Broadcast", "albums": []}],
                "family_artist_groups": [],
                "related_artists": [],
                "artist_family_filters": [],
                "artists_sidebar": [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}],
                "album_count": 1,
                "artist_count": 1,
                "query": "",
                "selected_artist": "",
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "surface": "albums",
            "gallery_display": "covers",
            "gallery_scale_percent": "120",
            "omit_sidebar": "1",
            "category": ["main_library", "new_arrivals"],
        },
    )

    assert status == 200
    payload = _decode_json(body)
    assert payload["query"] == ""
    assert payload["selected_artist"] == ""
    assert payload["payload_tier"] == "full"
    assert payload["view_data_source"] == "postgres_library_browse"
    assert payload["persistence_backend"] == "postgres"
    assert payload["persistence_seam"] == "library_browse"
    assert payload["album_count"] == 1
    assert "connection" not in headers
    assert payload["artist_count"] == 1


def test_asgi_sidebar_postgres_selection_raises_when_adapter_unavailable(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[str] = []

    def fake_hydrate_library_from_disk(*, ensure_relations=False, validate_cache=False):
        hydrate_calls.append(f"{ensure_relations}:{validate_cache}")
        return False

    def fake_build_view_payload() -> dict[str, object]:
        return {
            "payload_tier": "sidebar",
            "view_data_source": "file_fixture",
            "artists_sidebar": [],
            "album_count": 0,
            "artist_count": 0,
        }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", None)

    def unavailable_library_browse_selection(seam_id, config):
        from music_app.services.persistence_selection import select_runtime_persistence_adapter

        return select_runtime_persistence_adapter(
            seam_id,
            config,
            available_backends={"library_browse": set()},
        )

    monkeypatch.setattr(asgi_read_routes, "select_runtime_persistence_adapter", unavailable_library_browse_selection)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fake_build_view_payload)

    with pytest.raises(
        ValueError,
        match="Postgres runtime persistence adapter is unavailable for library_browse.",
    ):
        _run_asgi_request(
            asgi_app,
            "GET",
            "/view-data",
            query={"payload_tier": "sidebar"},
        )

    assert hydrate_calls == []


def test_asgi_sidebar_postgres_selection_requires_exact_root_sidebar_request(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[str] = []

    def fake_hydrate_library_from_disk(*, ensure_relations=False, validate_cache=False):
        hydrate_calls.append(f"{ensure_relations}:{validate_cache}")
        return False

    def fake_hydrate_library_state_for_config(
        _library_state,
        _config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        return fake_hydrate_library_from_disk(
            ensure_relations=ensure_relations,
            validate_cache=validate_cache,
        )

    def fake_build_view_payload(**kwargs) -> dict[str, object]:
        query_args = kwargs["query_args"]
        return {
            "payload_tier": "sidebar",
            "selected_artist": query_args.get("artist", ""),
            "view_data_source": "file_fixture",
        }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fake_build_view_payload)

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={"payload_tier": "sidebar", "artist": "Broadcast"},
    )

    assert status == 400
    assert _decode_json(body) == {
        "ok": False,
        "error": "Unsupported Postgres selected-artist browse request shape",
        "error_code": "unsupported_postgres_selected_artist_browse_request",
        "selected_artist": "Broadcast",
    }
    assert hydrate_calls == []


def test_asgi_selected_artist_postgres_selection_rejects_unsupported_browse_requests(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_hydrate_library_state_for_config(*_args, **_kwargs):
        raise AssertionError("Unsupported Postgres selected-artist browse requests must not hydrate file-backed state")

    def fail_build_view_payload(**_kwargs):
        raise AssertionError("Unsupported Postgres selected-artist browse requests must not fall back to build_view_payload")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self, *args, **kwargs: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)

    unsupported_queries = [
        {"artist": "Broadcast", "payload_tier": "sidebar"},
        {"artist": "Broadcast", "surface": "albums", "payload_tier": "sidebar"},
        {"artist": "Broadcast", "surface": "albums", "genre": "psych"},
        {"artist": "Broadcast", "surface": "albums", "search": "tender"},
    ]

    for query in unsupported_queries:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "GET",
            "/view-data",
            query=query,
        )
        assert status == 400
        payload = _decode_json(body)
        assert payload == {
            "ok": False,
            "error": "Unsupported Postgres selected-artist browse request shape",
            "error_code": "unsupported_postgres_selected_artist_browse_request",
            "selected_artist": "Broadcast",
        }


def test_asgi_selected_artist_page_shapes_without_surface_use_postgres_browse(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is True
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    def fail_build_view_payload(**_kwargs):
        raise AssertionError("Selected-artist page-shape requests must not hydrate file-backed view payloads")

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://album_haven_app@localhost/app"

        def build_selected_artist_payload(self, *, query_params=None, library_state=None):
            assert query_params.get("artist") == "Broadcast"
            assert query_params.get("surface") is None
            assert query_params.get("page_mode") == "info"
            assert query_params.get("family_display") == "chronological"
            assert query_params.get("timeline_at") == "2000-05-01"
            assert query_params.get("client_surface_class") == "tv"
            assert library_state is asgi_app.state.library_state
            return {
                "selected_artist": "Broadcast",
                "page_mode": "info",
                "selected_artist_family_display_mode": "chronological",
                "timeline_at": "2000-05-01",
                "payload_tier": "full",
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr(
        "music_app.services.library_browse_postgres.psycopg",
        type("FakePsycopg", (), {"connect": lambda self, *args, **kwargs: None})(),
    )
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/view-data",
        query={
            "artist": "Broadcast",
            "page_mode": "info",
            "family_display": "chronological",
            "timeline_at": "2000-05-01",
            "client_surface_class": "tv",
        },
    )

    assert status == 200
    assert _decode_json(body) == {
        "selected_artist": "Broadcast",
        "page_mode": "info",
        "selected_artist_family_display_mode": "chronological",
        "timeline_at": "2000-05-01",
        "payload_tier": "full",
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
    }
    assert hydrate_calls == []


def test_asgi_album_search_postgres_selection_rejects_unsupported_search_requests(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_hydrate_library_state_for_config(*_args, **_kwargs):
        raise AssertionError("Unsupported Postgres album-search requests must not hydrate file-backed state")

    def fail_build_view_payload(**_kwargs):
        raise AssertionError("Unsupported Postgres album-search requests must not fall back to build_view_payload")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)

    complex_queries = [
        {"q": "tender", "surface": "albums", "related_artist": "United States of America"},
        {"q": "tender", "surface": "albums", "primary_filter": "1"},
        {"q": "tender", "surface": "albums", "payload_tier": "full"},
        {"q": "artist:Broadcast", "surface": "albums"},
        {"q": "persons:Mike", "surface": "albums"},
        {"q": "#loved", "surface": "albums"},
        {"q": "%", "surface": "albums"},
        {"q": "_", "surface": "albums"},
        {"q": "tender", "surface": "albums", "genre": "psych"},
    ]

    for query in complex_queries:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "GET",
            "/view-data",
            query=query,
        )
        assert status == 400
        assert _decode_json(body) == {
            "ok": False,
            "error": "Unsupported Postgres album-search request shape",
            "error_code": "unsupported_postgres_album_search_request",
            "query": "tender" if query["q"] == "tender" else query["q"],
        }


def test_asgi_root_album_browse_postgres_selection_rejects_unsupported_requests(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_hydrate_library_state_for_config(*_args, **_kwargs):
        raise AssertionError("Unsupported Postgres root album browse requests must not hydrate file-backed state")

    def fail_build_view_payload(**_kwargs):
        raise AssertionError("Unsupported Postgres root album browse requests must not fall back to build_view_payload")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.setattr("music_app.services.library_browse_postgres.psycopg", type("FakePsycopg", (), {"connect": lambda self: None})())
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_view_payload", fail_build_view_payload)

    complex_queries = [
        {"surface": "albums", "payload_tier": "full"},
        {"surface": "albums", "all_artists": "1"},
        {"surface": "albums", "related_artist": "United States of America"},
        {"surface": "albums", "primary_filter": "1"},
        {"surface": "albums", "playlist": "favorites"},
        {"surface": "albums", "genre": "psych"},
    ]

    for query in complex_queries:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "GET",
            "/view-data",
            query=query,
        )
        assert status == 400
        assert _decode_json(body) == {
            "ok": False,
            "error": "Unsupported Postgres root album browse request shape",
            "error_code": "unsupported_postgres_root_album_browse_request",
        }


def test_asgi_album_details_preserves_statuses_and_client_surface(app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    detail_calls: list[tuple[str, object]] = []

    def fake_hydrate_library_state_for_config(
        _library_state,
        _config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert ensure_relations is False
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    def fake_build_album_detail_payload(album_key, *, client_surface_class, config, library_state):
        assert config["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        assert library_state is not None
        detail_calls.append((album_key, client_surface_class))
        if album_key == "missing":
            return None
        return {"album_key": album_key, "surface": str(client_surface_class)}

    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fake_build_album_detail_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "file"},
        )(),
    )

    asgi_app = _make_asgi_app()
    missing_key_status, _missing_key_headers, missing_key_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
    )
    missing_album_status, _missing_album_headers, missing_album_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "missing"},
    )
    success_status, _success_headers, success_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "album-1", "client_surface": "tv"},
    )

    assert missing_key_status == 400
    assert _decode_json(missing_key_body) == {"ok": False, "error": "Missing album_key"}
    assert missing_album_status == 404
    assert _decode_json(missing_album_body) == {"ok": False, "error": "Album not found"}
    assert success_status == 200
    assert _decode_json(success_body) == {
        "ok": True,
        "album": {"album_key": "album-1", "surface": "tv"},
    }
    assert hydrate_calls == [True, True]
    assert detail_calls == [("missing", "private_web"), ("album-1", "tv")]


def test_asgi_album_details_uses_postgres_repository_when_library_browse_is_postgres(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    postgres_calls: list[tuple[str, object]] = []

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Postgres album-details should not hydrate file-backed library state first")

    def fail_build_album_detail_payload(*_args, **_kwargs):
        raise AssertionError("Postgres album-details should not use the file-backed album detail builder")

    class FakeRepository:
        def __init__(self, config):
            assert config["MUSIC_DIR"] == app.config["MUSIC_DIR"]

        def build_album_detail_payload(self, album_key, *, client_surface_class=None):
            postgres_calls.append((album_key, client_surface_class))
            if album_key == "missing::album":
                return None
            return {"key": album_key, "surface": client_surface_class, "detail_loaded": True}

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fail_build_album_detail_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    success_status, _success_headers, success_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "3::to the power of three", "client_surface": "tv"},
    )
    missing_status, _missing_headers, missing_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "missing::album"},
    )

    assert success_status == 200
    assert _decode_json(success_body) == {
        "ok": True,
        "album": {"key": "3::to the power of three", "surface": "tv", "detail_loaded": True},
    }
    assert missing_status == 404
    assert _decode_json(missing_body) == {"ok": False, "error": "Album not found"}
    assert postgres_calls == [("3::to the power of three", "tv"), ("missing::album", "private_web")]


def test_asgi_album_details_uses_transient_runtime_album_during_active_scan(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    transient_album = {"key": "partial-album", "title": "Partial Album"}
    preview_browse_snapshot = {
        "file_cache": {"partial.mp3": {"album": "Partial Album"}},
        "albums": [transient_album],
        "separate_release_keys": set(),
    }
    preview_publication_state = {
        "file_cache": {"unsafe.mp3": {}},
        "albums": [{"key": "unsafe-publication-album"}],
        "separate_release_keys": {"unsafe-release"},
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 7,
        "albums": [],
        "active_scan_preview_state": {
            "scan_generation": 7,
            "publication_state": preview_publication_state,
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    runtime_calls: list[tuple[str, object]] = []

    class FailPostgresBrowseRepository:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("Active-scan album details must use the transient runtime album")

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Active-scan album details must not hydrate durable library state")

    def fake_build_album_detail_payload(album_key, *, client_surface_class, config, library_state):
        assert config is app.config
        assert library_state is not asgi_app.state.library_state
        assert library_state["albums"] is preview_browse_snapshot["albums"]
        assert library_state["scan_in_progress"] is True
        runtime_calls.append((album_key, client_surface_class))
        return {"key": album_key, "surface": client_surface_class, "source": "transient_runtime"}

    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FailPostgresBrowseRepository)
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fake_build_album_detail_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "partial-album", "client_surface": "tv"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "album": {"key": "partial-album", "surface": "tv", "source": "transient_runtime"},
    }
    assert runtime_calls == [("partial-album", "tv")]


def test_asgi_active_scan_album_details_prefers_postgres_for_existing_committed_album(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    committed_album = {
        "key": "committed-album",
        "artist": "Broadcast",
        "title": "Tender Buttons",
    }
    preview_browse_snapshot = {
        "file_cache": {"preview.mp3": {"album": "Tender Buttons"}},
        "albums": [
            {
                "key": "committed-album",
                "artist": "Broadcast",
                "title": "Uncommitted Preview Title",
            },
        ],
        "separate_release_keys": set(),
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 12,
        "albums": [committed_album],
        "active_scan_preview_state": {
            "scan_generation": 12,
            "publication_state": {
                "file_cache": {},
                "albums": [{"key": "uncommitted-publication-album"}],
                "separate_release_keys": set(),
            },
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    postgres_calls: list[tuple[str, object]] = []

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError(
            "Existing committed album details must not hydrate file-backed state during a scan"
        )

    def fail_build_album_detail_payload(*_args, **_kwargs):
        raise AssertionError(
            "Existing committed album details must not build the transient preview album"
        )

    class FakePostgresBrowseRepository:
        def __init__(self, config):
            assert config is app.config

        def build_album_detail_payload(self, album_key, *, client_surface_class=None):
            postgres_calls.append((album_key, client_surface_class))
            return {
                "key": album_key,
                "surface": client_surface_class,
                "source": "postgres_repo",
            }

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_hydrate)
    monkeypatch.setattr(
        asgi_read_routes,
        "build_album_detail_payload",
        fail_build_album_detail_payload,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresLibraryBrowseRepository",
        FakePostgresBrowseRepository,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "committed-album", "client_surface": "tv"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "album": {
            "key": "committed-album",
            "surface": "tv",
            "source": "postgres_repo",
        },
    }
    assert postgres_calls == [("committed-album", "tv")]


def test_asgi_album_details_overlays_app_rating_on_transient_scan_payload(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services.listen_through import default_album_preference_overlay

    preview_browse_snapshot = {
        "file_cache": {"rated.mp3": {"album": "Rated Album"}},
        "albums": [{"key": "rated-album", "album_rating": 9}],
        "separate_release_keys": set(),
    }
    preview_publication_state = {
        "file_cache": {"unsafe.mp3": {}},
        "albums": [{"key": "unsafe-publication-album"}],
        "separate_release_keys": {"unsafe-release"},
    }
    asgi_app.state.library_state = {
        **app.library_state,
        "scan_in_progress": True,
        "scan_generation": 8,
        "albums": [],
        "active_scan_preview_state": {
            "scan_generation": 8,
            "publication_state": preview_publication_state,
            "browse_snapshot": preview_browse_snapshot,
        },
    }
    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/pytest_album_ratings_e2e"
    )
    rating_loads: list[list[object]] = []

    class FakePostgresAlbumRatingsService:
        def __init__(self, config):
            assert config is app.config

        def load_album_ratings(self, album_keys):
            rating_loads.append(list(album_keys))
            return {
                "rated-album": {
                    "rating": 5,
                    "provenance": "explicit_import",
                }
            }

    def fake_build_album_detail_payload(
        album_key,
        *,
        client_surface_class,
        config,
        library_state,
    ):
        assert album_key == "rated-album"
        assert client_surface_class == "tv"
        assert config is app.config
        assert library_state is not asgi_app.state.library_state
        assert library_state["albums"] is preview_browse_snapshot["albums"]
        return {
            "key": album_key,
            "album_rating": 9,
            "tag_album_rating": 9,
            "tag_album_rating_source": "file_tag",
            "album_preference": default_album_preference_overlay(),
            "gallery_list_block": {
                "summary": {
                    "album_preference": default_album_preference_overlay(),
                }
            },
        }

    monkeypatch.setattr(
        asgi_read_routes,
        "PostgresAlbumRatingsService",
        FakePostgresAlbumRatingsService,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "build_album_detail_payload",
        fake_build_album_detail_payload,
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "rated-album", "client_surface": "tv"},
    )

    assert status == 200
    album_payload = _decode_json(body)["album"]
    assert album_payload["album_preference"]["rating"] == 5
    assert album_payload["album_preference"]["provenance"] == "explicit_import"
    assert album_payload["album_preference"]["can_edit"] is True
    summary_preference = album_payload["gallery_list_block"]["summary"]["album_preference"]
    assert summary_preference["rating"] == 5
    assert summary_preference["provenance"] == "explicit_import"
    assert summary_preference["can_edit"] is True
    assert album_payload["tag_album_rating"] == 9
    assert album_payload["tag_album_rating_source"] == "file_tag"
    assert rating_loads == [["rated-album"]]


def test_asgi_album_details_uses_postgres_repository_for_regular_album_keys_without_separator(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    postgres_calls: list[tuple[str, object]] = []
    app.library_state["albums"] = [{"key": "album-1"}]

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Postgres album-details must not hydrate file-backed state for regular album keys")

    def fail_build_album_detail_payload(*_args, **_kwargs):
        raise AssertionError("Postgres album-details must not use the file-backed album detail builder for regular album keys")

    class FakeRepository:
        def __init__(self, config):
            assert config is app.config

        def build_album_detail_payload(self, album_key, *, client_surface_class=None):
            postgres_calls.append((album_key, client_surface_class))
            return {"key": album_key, "surface": client_surface_class, "source": "postgres_repo"}

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fail_build_album_detail_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "album-1", "client_surface": "tv"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "album": {"key": "album-1", "surface": "tv", "source": "postgres_repo"},
    }
    assert postgres_calls == [("album-1", "tv")]


def test_asgi_album_details_postgres_selection_rejects_non_album_requests(
    asgi_app,
    app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    app.library_state["albums"] = [
        {"key": "non-album::mono::type::non-album rarity::"},
    ]

    def fail_hydrate(*_args, **_kwargs):
        raise AssertionError("Postgres non-album modal requests must not hydrate file-backed state")

    def fail_build_album_detail_payload(*_args, **_kwargs):
        raise AssertionError("Postgres non-album modal requests must not use the file-backed album detail builder")

    class FakeRepository:
        def __init__(self, _config):
            pass

        def build_album_detail_payload(self, *_args, **_kwargs):
            raise AssertionError("Non-album album-details requests must not use the Postgres detail repository")

    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_hydrate)
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fail_build_album_detail_payload)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakeRepository)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "postgres"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "non-album::mono::type::non-album rarity::", "client_surface": "tv"},
    )

    assert status == 404
    assert _decode_json(body) == {
        "ok": False,
        "error": "Album not found",
        "error_code": "unsupported_postgres_non_album_modal_request",
        "album_key": "non-album::mono::type::non-album rarity::",
    }


def test_asgi_album_details_uses_query_inputs_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    hydrate_calls: list[bool] = []
    detail_calls: list[tuple[str, object]] = []

    def fail_flask_app(_request):
        raise AssertionError("ASGI album-details route must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI album-details route must not enter Flask test_request_context")

    def fake_build_album_detail_payload(album_key, *, client_surface_class, config, library_state):
        assert config["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        assert library_state is not None
        detail_calls.append((album_key, client_surface_class))
        return {"album_key": album_key, "surface": client_surface_class}

    def fake_hydrate_library_state_for_config(
        library_state,
        config,
        *,
        ensure_relations=False,
        validate_cache=False,
    ):
        assert library_state is asgi_app.state.library_state
        assert config is app.config
        assert ensure_relations is False
        assert validate_cache is False
        hydrate_calls.append(True)
        return False

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(asgi_read_routes, "hydrate_library_state_for_config", fake_hydrate_library_state_for_config)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "compat"},
        )(),
    )
    monkeypatch.setattr(asgi_read_routes, "build_album_detail_payload", fake_build_album_detail_payload)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "file"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "album-1", "client_surface": "tv"},
    )

    assert status == 200
    assert _decode_json(body) == {
        "ok": True,
        "album": {"album_key": "album-1", "surface": "tv"},
    }
    assert hydrate_calls == [True]
    assert detail_calls == [("album-1", "tv")]


def test_asgi_album_details_invokes_track_overlay_seams_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services import album_details as album_detail_service
    from music_app.services.track_stats import normalize_track_ref

    track_ref = str((Path(app.config["MUSIC_DIR"]) / "Artist One" / "Album One" / "01 Track.flac").resolve())
    normalized_track_ref = normalize_track_ref(track_ref)
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
            year=2001,
            release_date="2001-01-01",
            edition="",
            album_rating=8,
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
                    year=2001,
                    release_date="2001-01-01",
                    edition="",
                    album_rating=8,
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
                )
            ],
            is_compilation=False,
            library_root_id=None,
            library_root_category=None,
            root_provenance=None,
        ),
    ]
    app.library_state["file_cache"] = {}
    app.library_state["scan_in_progress"] = False

    scrobble_calls: list[list[object]] = []
    preference_calls: list[tuple[object, list[object]]] = []

    def fail_flask_app(_request):
        raise AssertionError("ASGI album-details route must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI album-details route must not enter Flask test_request_context")

    def fake_scrobble_lookup(config, track_refs):
        assert config["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        scrobble_calls.append(list(track_refs))
        return {normalized_track_ref: 7}

    def fake_track_preference_lookup(config, *, client_surface_class=None, track_refs=None):
        assert config["MUSIC_DIR"] == app.config["MUSIC_DIR"]
        preference_calls.append((client_surface_class, list(track_refs or [])))
        return {
            normalized_track_ref: {
                "rating": 5,
                "love_tier": "obsessed",
                "allowed_actions": {
                    "client_surface_class": client_surface_class,
                    "can_rate": True,
                    "can_set_love_tier": True,
                },
            },
        }

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(album_detail_service, "build_scrobbled_play_count_lookup", fake_scrobble_lookup)
    monkeypatch.setattr(album_detail_service, "build_track_preference_overlay_lookup", fake_track_preference_lookup)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "file"},
        )(),
    )

    original_module_class = album_detail_service.__class__

    class GuardedAlbumDetailModule(ModuleType):
        def __setattr__(self, name, value):
            if name in {"current_app", "has_app_context"}:
                raise AssertionError(
                    "ASGI album-details must pass explicit config/state instead of patching service globals"
                )
            super().__setattr__(name, value)

    album_detail_service.__class__ = GuardedAlbumDetailModule
    try:
        status, _headers, body = _run_asgi_request(
            asgi_app,
            "GET",
            "/album-details",
            query={"album_key": "album-1", "client_surface": "tv"},
        )
    finally:
        album_detail_service.__class__ = original_module_class

    payload = _decode_json(body)
    assert status == 200
    assert scrobble_calls == [[track_ref]]
    assert preference_calls == [("tv", [track_ref])]
    assert payload["album"]["track_rows"][0]["track_stats"]["scrobble_count"] == 7
    assert payload["album"]["track_rows"][0]["track_preference"] == {
        "rating": 5,
        "love_tier": "obsessed",
        "allowed_actions": {
            "client_surface_class": "tv",
            "can_rate": True,
            "can_set_love_tier": True,
        },
    }


def test_asgi_album_details_preserves_album_setup_and_viewer_opinions_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.models.library import Album, Track
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    from music_app.services import album_details as album_detail_service
    from music_app.services import library as library_service

    track_path = Path(app.config["MUSIC_DIR"]) / "Artist One" / "Album One" / "01 Track.flac"
    track = Track(
        path=track_path,
        title="Track One",
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Artist One",
        album="Album One",
        album_artist="Artist One",
        year=2001,
        release_date="2001-01-01",
        album_rating=8,
        duration_seconds=245,
    )
    track.track_popularity = {
        "scrobble_count": 42,
        "listener_count": 12,
        "loved_count": 3,
        "match_key": "artist one::track one",
        "match_coverage_state": "exact",
        "metric_availability": {
            "scrobbles": True,
            "listeners": True,
            "loved": True,
        },
        "freshness_state": "fresh",
    }
    album = Album(
        key="album-1",
        name="Album One",
        album_artist="Artist One",
        tracks=[track],
        artists=["Artist One"],
        year=2001,
        release_date="2001-01-01",
        album_rating=8,
        total_duration_seconds=245,
    )
    album.crowd_opinion = {
        "blended_score_10": 8.4,
        "display_stars": 4.2,
        "source_count_used": 2,
        "source_count_total": 3,
        "freshness_state": "fresh",
    }
    album.friends_opinion = {
        "average_rating": 9,
        "rating_count": 4,
        "freshness_state": "fresh",
    }
    album.album_popularity = {
        "scrobble_count": 120,
        "listener_count": 34,
        "matched_track_count": 1,
        "total_track_count": 1,
        "available_sort_metrics": ["scrobbles", "listeners"],
        "freshness_state": "fresh",
    }

    asgi_config = {
        **app.config,
        "ASGI_CONFIG_MARKER": "explicit-album-details-config",
    }
    asgi_library_state = {
        **app.library_state,
        "albums": [album],
        "file_cache": {},
        "scan_in_progress": False,
        "viewer_opinion_preferences": {
            "show_crowd_opinion": True,
            "show_friends_opinions": True,
        },
    }
    app.library_state["viewer_opinion_preferences"] = {
        "show_crowd_opinion": False,
        "show_friends_opinions": False,
    }
    asgi_app.state.config = asgi_config
    asgi_app.state.library_state = asgi_library_state

    def fail_flask_app(_request):
        raise AssertionError("ASGI album-details route must not enter the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI album-details route must not enter Flask test_request_context")

    def fake_move_availability(album_arg, config):
        assert album_arg is album
        assert config["ASGI_CONFIG_MARKER"] == "explicit-album-details-config"
        return {
            "is_available": True,
            "source": "asgi-explicit-config",
        }

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(album_detail_service, "build_scrobbled_play_count_lookup", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(album_detail_service, "build_track_preference_overlay_lookup", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(library_service, "build_move_availability_payload", fake_move_availability)
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, _config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "file"},
        )(),
    )

    status, _headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-details",
        query={"album_key": "album-1"},
    )

    payload = _decode_json(body)
    assert status == 200
    album_payload = payload["album"]
    assert album_payload["move_availability"] == {
        "is_available": True,
        "source": "asgi-explicit-config",
    }
    assert album_payload["crowd_opinion"]["is_visible"] is True
    assert album_payload["crowd_opinion"]["blended_score_10"] == 8.4
    assert album_payload["friends_opinion"]["is_visible"] is True
    assert album_payload["friends_opinion"]["average_rating"] == 9
    assert album_payload["album_popularity"]["is_visible"] is True
    assert album_payload["album_popularity"]["scrobble_count"] == 120
    assert album_payload["track_rows"][0]["track_popularity"]["is_visible"] is True
    assert album_payload["track_rows"][0]["track_popularity"]["scrobble_count"] == 42
    assert album_payload["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is True


def test_asgi_utility_read_routes_preserve_payloads_statuses_and_problematic_fallback_without_flask_bridge(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes
    loops_path = Path(app.config["DATA_DIR"]) / "loops" / "loops.json"
    loops_path.parent.mkdir(parents=True, exist_ok=True)
    loops_path.write_text(
        json.dumps({"loops": [{"id": "loop-1", "name": "Intro loop"}]}),
        encoding="utf-8",
    )
    asgi_config = {
        **app.config,
        "ASGI_CONFIG_MARKER": "explicit-problematic-fallback-config",
    }
    asgi_library_state = {
        **app.library_state,
        "albums": [{"key": "from-asgi-state"}],
        "file_cache": {"from-asgi-state": {"path": "from-asgi-state"}},
    }
    asgi_logger = SimpleNamespace(name="problematic-fallback-logger")
    asgi_app.state.config = asgi_config
    asgi_app.state.library_state = asgi_library_state
    asgi_app.state.logger = asgi_logger

    detail_calls: list[str] = []
    fallback_calls: list[tuple[str, dict[str, object], dict[str, object], object]] = []

    def fail_flask_app(_request):
        raise AssertionError("ASGI problematic-files fallback must not read through the Flask bridge")

    def fail_test_request_context(*_args, **_kwargs):
        raise AssertionError("ASGI problematic-files fallback must not enter Flask test_request_context")

    def fake_build_problematic_albums_payload(
        *,
        config=None,
        library_state=None,
        logger=None,
    ) -> dict[str, object]:
        fallback_calls.append(("list", config, library_state, logger))
        return {
            "count": 1,
            "context_music_dir": str(config["MUSIC_DIR"]),
            "state_album_count": len(library_state["albums"]),
            "logger_name": logger.name,
        }

    def fake_build_problematic_album_detail_payload(
        album_key: str,
        *,
        config=None,
        library_state=None,
        logger=None,
    ) -> dict[str, object] | None:
        detail_calls.append(album_key)
        fallback_calls.append((album_key, config, library_state, logger))
        if album_key == "missing":
            return None
        return {
            "key": album_key,
            "config_marker": config["ASGI_CONFIG_MARKER"],
            "state_album_count": len(library_state["albums"]),
            "logger_name": logger.name,
            "detail_loaded": True,
        }

    monkeypatch.setattr(
        asgi_read_routes,
        "build_problematic_albums_payload",
        fake_build_problematic_albums_payload,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "build_problematic_album_detail_payload",
        fake_build_problematic_album_detail_payload,
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "load_loops",
        lambda config: [{"id": "loop-1", "name": "Intro loop"}],
    )
    monkeypatch.setattr(
        asgi_read_routes,
        "load_log_history_snapshot",
        lambda config: {
            "items": [{"id": "entry-1", "message": "Refresh started"}],
            "revision": "test-process:4",
        },
    )
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "select_runtime_persistence_adapter",
        lambda seam_id, config: type(
            "Selection",
            (),
            {"seam_id": seam_id, "effective_backend": "unavailable"},
        )(),
    )

    list_status, _list_headers, list_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files",
    )
    path_detail_status, _path_detail_headers, path_detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/artist/album",
    )
    query_detail_status, _query_detail_headers, query_detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/detail",
        query={"album_key": "query-album"},
    )
    missing_key_status, _missing_key_headers, missing_key_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/detail",
    )
    missing_album_status, _missing_album_headers, missing_album_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/missing",
    )
    loops_status, _loops_headers, loops_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/loops",
    )
    log_status, log_headers, log_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/log-history",
    )

    assert list_status == 200
    assert _decode_json(list_body) == {
        "count": 1,
        "context_music_dir": str(asgi_config["MUSIC_DIR"]),
        "state_album_count": 1,
        "logger_name": "problematic-fallback-logger",
    }
    assert path_detail_status == 200
    assert _decode_json(path_detail_body) == {
        "key": "artist/album",
        "config_marker": "explicit-problematic-fallback-config",
        "state_album_count": 1,
        "logger_name": "problematic-fallback-logger",
        "detail_loaded": True,
    }
    assert query_detail_status == 200
    assert _decode_json(query_detail_body) == {
        "key": "query-album",
        "config_marker": "explicit-problematic-fallback-config",
        "state_album_count": 1,
        "logger_name": "problematic-fallback-logger",
        "detail_loaded": True,
    }
    assert missing_key_status == 400
    assert _decode_json(missing_key_body) == {"ok": False, "error": "Missing album_key."}
    assert missing_album_status == 404
    assert _decode_json(missing_album_body) == {
        "ok": False,
        "error": "Problematic album not found.",
    }
    assert loops_status == 200
    assert _decode_json(loops_body) == {"ok": True, "loops": [{"id": "loop-1", "name": "Intro loop"}]}
    assert log_status == 200
    assert _decode_json(log_body) == {
        "ok": True,
        "items": [{"id": "entry-1", "message": "Refresh started"}],
        "revision": "test-process:4",
    }
    assert log_headers["cache-control"] == "no-store"
    assert detail_calls == ["artist/album", "query-album", "missing"]
    assert fallback_calls == [
        ("list", asgi_config, asgi_library_state, asgi_logger),
        ("artist/album", asgi_config, asgi_library_state, asgi_logger),
        ("query-album", asgi_config, asgi_library_state, asgi_logger),
        ("missing", asgi_config, asgi_library_state, asgi_logger),
    ]


def test_asgi_loops_and_log_history_use_asgi_config_without_flask_bridge(app, asgi_app, monkeypatch):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    def fail_flask_app(_request):
        raise AssertionError("ASGI utility metadata routes must not read config through the Flask bridge")

    seen_config_markers: list[str] = []

    def fake_load_loops(config):
        seen_config_markers.append(str(config["ASGI_CONFIG_MARKER"]))
        return [{"id": "loop-1", "name": "Intro loop"}]

    def fake_load_log_history_snapshot(config):
        seen_config_markers.append(str(config["ASGI_CONFIG_MARKER"]))
        return {
            "items": [{"id": "entry-1", "message": "Refresh started"}],
            "revision": "test-process:4",
        }

    app.config["ASGI_CONFIG_MARKER"] = "from-request-app-state"
    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(asgi_read_routes, "load_loops", fake_load_loops)
    monkeypatch.setattr(
        asgi_read_routes,
        "load_log_history_snapshot",
        fake_load_log_history_snapshot,
    )

    loops_status, _loops_headers, loops_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/loops",
    )
    log_status, log_headers, log_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/log-history",
    )

    assert loops_status == 200
    assert _decode_json(loops_body) == {"ok": True, "loops": [{"id": "loop-1", "name": "Intro loop"}]}
    assert log_status == 200
    assert _decode_json(log_body) == {
        "ok": True,
        "items": [{"id": "entry-1", "message": "Refresh started"}],
        "revision": "test-process:4",
    }
    assert log_headers["cache-control"] == "no-store"
    assert seen_config_markers == ["from-request-app-state", "from-request-app-state"]


def test_asgi_log_history_returns_non_cacheable_empty_transient_snapshot(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    assert not hasattr(asgi_read_routes, "_flask_app")
    monkeypatch.setattr(
        asgi_read_routes,
        "load_log_history_snapshot",
        lambda _config: {"items": [], "revision": "test-process:0"},
    )

    status, headers, body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/log-history",
    )

    assert status == 200
    assert headers["cache-control"] == "no-store"
    assert _decode_json(body) == {"ok": True, "items": [], "revision": "test-process:0"}


def test_asgi_problematic_files_use_postgres_repository_without_fixture_env_or_runtime_hydration(
    app,
    asgi_app,
    monkeypatch,
):
    from music_app.routes import api_read_asgi_routes as asgi_read_routes

    repository_configs: list[dict[str, object]] = []

    class FakePostgresRepository:
        def __init__(self, config):
            repository_configs.append(config)

        def build_problematic_files_payload(self):
            return {
                "count": 1,
                "items": [
                    {
                        "key": "broken-album",
                        "detail_loaded": False,
                    }
                ],
                "initial_detail": {
                    "key": "broken-album",
                    "detail_loaded": True,
                    "track_problem_rows": [{"filename": "01.flac"}],
                    "persistence_backend": "postgres",
                    "persistence_seam": "library_browse",
                    "view_data_source": "postgres_library_browse",
                },
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

        def build_problematic_file_detail_payload(self, album_key):
            if album_key == "missing":
                return None
            return {
                "key": album_key,
                "detail_loaded": True,
                "persistence_backend": "postgres",
                "persistence_seam": "library_browse",
                "view_data_source": "postgres_library_browse",
            }

    def fail_runtime_fallback(*_args, **_kwargs):
        raise AssertionError("Postgres Problematic Files must not use hydrated runtime state")

    app.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://album_haven_app@localhost/app"
    app.config["PERSISTENCE_BACKENDS"] = {"library_browse": "postgres"}
    monkeypatch.delenv("ALBUM_HAVEN_E2E_PROBLEMATIC_SEED_KEY", raising=False)
    monkeypatch.delenv("ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH", raising=False)
    monkeypatch.setattr(asgi_read_routes, "_hydrate_cached_library_for_asgi", fail_runtime_fallback)
    monkeypatch.setattr(asgi_read_routes, "build_problematic_albums_payload", fail_runtime_fallback)
    monkeypatch.setattr(asgi_read_routes, "build_problematic_album_detail_payload", fail_runtime_fallback)
    monkeypatch.setattr(asgi_read_routes, "PostgresLibraryBrowseRepository", FakePostgresRepository)

    list_status, _list_headers, list_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files",
    )
    path_detail_status, _path_detail_headers, path_detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/broken-album",
    )
    query_detail_status, _query_detail_headers, query_detail_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/detail",
        query={"album_key": "query-album"},
    )
    missing_key_status, _missing_key_headers, missing_key_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/detail",
    )
    missing_album_status, _missing_album_headers, missing_album_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/utilities/problematic-files/missing",
    )

    assert list_status == 200
    list_payload = _decode_json(list_body)
    assert list_payload == {
        "count": 1,
        "items": [
            {
                "key": "broken-album",
                "detail_loaded": False,
            }
        ],
        "initial_detail": {
            "key": "broken-album",
            "detail_loaded": True,
            "track_problem_rows": [{"filename": "01.flac"}],
            "persistence_backend": "postgres",
            "persistence_seam": "library_browse",
            "view_data_source": "postgres_library_browse",
        },
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
    }
    assert path_detail_status == 200
    assert _decode_json(path_detail_body) == {
        "key": "broken-album",
        "detail_loaded": True,
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
    }
    assert query_detail_status == 200
    assert _decode_json(query_detail_body) == {
        "key": "query-album",
        "detail_loaded": True,
        "persistence_backend": "postgres",
        "persistence_seam": "library_browse",
        "view_data_source": "postgres_library_browse",
    }
    assert missing_key_status == 400
    assert _decode_json(missing_key_body) == {"ok": False, "error": "Missing album_key."}
    assert missing_album_status == 404
    assert _decode_json(missing_album_body) == {
        "ok": False,
        "error": "Problematic album not found.",
    }
    assert repository_configs == [app.config, app.config, app.config, app.config]


def test_asgi_album_note_reserved_mutation_routes_preserve_fail_closed_contract(app):
    asgi_app = _make_asgi_app()

    responses = [
        _run_asgi_request(
            asgi_app,
            "POST",
            "/album-notes",
            json_body={"album_ref": "album-1", "body": "First draft"},
        ),
        _run_asgi_request(
            asgi_app,
            "PATCH",
            "/album-notes/note-1",
            json_body={"body": "Revised draft"},
        ),
        _run_asgi_request(asgi_app, "DELETE", "/album-notes/note-1"),
    ]

    for status, _headers, body in responses:
        assert status == 409
        assert _decode_json(body) == {
            "ok": False,
            "error": "Album note mutations land on the dedicated /album-notes route family in later phases.",
        }


def test_asgi_album_note_reply_reserved_mutation_routes_preserve_fail_closed_contract(app):
    asgi_app = _make_asgi_app()

    responses = [
        _run_asgi_request(
            asgi_app,
            "POST",
            "/album-note-replies",
            json_body={"note_ref": "note-1", "body": "Reply draft"},
        ),
        _run_asgi_request(
            asgi_app,
            "PATCH",
            "/album-note-replies/reply-1",
            json_body={"body": "Reply revision"},
        ),
        _run_asgi_request(asgi_app, "DELETE", "/album-note-replies/reply-1"),
    ]

    for status, _headers, body in responses:
        assert status == 409
        assert _decode_json(body) == {
            "ok": False,
            "error": (
                "Album note reply mutations land on the dedicated "
                "/album-note-replies route family in later phases."
            ),
        }


def test_asgi_album_opinion_and_resource_reserved_read_routes_preserve_payloads(app):
    asgi_app = _make_asgi_app()

    opinion_status, _opinion_headers, opinion_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/album-opinions/mono-1/crowd",
    )
    person_status, _person_headers, person_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/people/hans-zimmer",
        query={
            "page_mode": "info",
            "family_display": "chronological",
            "timeline_at": "2000-05-01",
            "role_focus": "source_media",
        },
    )
    work_status, _work_headers, work_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/works/work-123",
    )
    soundtrack_status, _soundtrack_headers, soundtrack_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/soundtracks/soundtrack-456",
        query={"page_mode": "gallery"},
    )
    company_status, _company_headers, company_body = _run_asgi_request(
        asgi_app,
        "GET",
        "/companies/company-789",
        query={"page_mode": "invalid"},
    )

    opinion_payload = _decode_json(opinion_body)
    person_payload = _decode_json(person_body)
    work_payload = _decode_json(work_body)
    soundtrack_payload = _decode_json(soundtrack_body)
    company_payload = _decode_json(company_body)

    assert opinion_status == 409
    assert opinion_payload == {
        "ok": False,
        "error": (
            "Crowd Opinion detail lands on the dedicated /album-opinions "
            "route family in later phases."
        ),
        "transport": "cache_only_detail",
        "route_family": "/album-opinions",
        "response_kind": "crowd_opinion_detail",
        "crowd_opinion": {
            "album_ref": "mono-1",
            "detail_kind": "crowd_opinion_modal",
            "blended_score_10": None,
            "source_count_used": None,
            "source_count_total": None,
            "sources": [],
            "freshness_state": "missing",
            "read_seam": {
                "source_kind": "external_album_crowd_opinion_snapshot",
                "visibility_scope": "viewer_scoped",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "background_only",
            },
            "modal_contract": {
                "open_action": "crowd_rating_activate",
                "source_rows_field": "sources",
                "source_link_field": "source_url",
            },
        },
    }
    assert person_status == 409
    assert person_payload == {
        "ok": False,
        "error": (
            "Person page reads land on the dedicated /people route family in later phases."
        ),
        "transport": "cache_only_page",
        "route_family": "/people",
        "response_kind": "person_page",
        "page_kind": "person",
        "person_ref": "hans-zimmer",
        "person_page": {
            "person_ref": "hans-zimmer",
            "page_modes": ["gallery", "info"],
            "default_page_mode": "gallery",
            "active_page_mode": "info",
            "family_display_mode": "chronological",
            "timeline_at": "2000-05-01",
            "role_focus": "source_media",
        },
    }
    assert work_status == 409
    assert work_payload == {
        "ok": False,
        "error": (
            "Work page reads land on the dedicated /works route family in later phases."
        ),
        "transport": "cache_only_page",
        "route_family": "/works",
        "response_kind": "work_page",
        "page_kind": "work",
        "work_ref": "work-123",
        "work_page": {
            "work_ref": "work-123",
            "freshness_state": "missing",
            "last_enriched_at": None,
            "queued_refresh_state": "not_queued",
            "source_attributions": [],
            "local_library_status": {
                "state": "unknown",
                "album_count": 0,
                "album_refs": [],
            },
            "read_seam": {
                "source_kind": "work_snapshot",
                "visibility_scope": "viewer_safe",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "enqueue_only",
            },
            "visit_refresh": {
                "trigger": "page_visit",
                "enqueue_mode": "enqueue_only",
                "job_kind": "visit_deepen",
                "entity_kind": "work",
                "blocking": "never",
            },
        },
    }
    assert soundtrack_status == 409
    assert soundtrack_payload == {
        "ok": False,
        "error": (
            "Soundtrack page reads land on the dedicated /soundtracks route family in later phases."
        ),
        "transport": "cache_only_page",
        "route_family": "/soundtracks",
        "response_kind": "soundtrack_page",
        "page_kind": "soundtrack",
        "soundtrack_ref": "soundtrack-456",
        "soundtrack_page": {
            "soundtrack_ref": "soundtrack-456",
            "page_modes": ["info", "gallery"],
            "default_page_mode": "info",
            "active_page_mode": "gallery",
            "gallery_bar": {
                "component_kind": "gallery_bar",
                "surface_family": "resource_page",
                "page_mode_query_parameter": "page_mode",
                "page_modes": ["info", "gallery"],
                "default_page_mode": "info",
                "active_page_mode": "gallery",
                "info_drawer_toggle": {
                    "control_kind": "drawer_toggle",
                    "drawer_slot": "resource_page_info",
                },
            },
            "info_drawer": {
                "component_kind": "info_drawer",
                "surface_family": "resource_page",
                "drawer_slot": "resource_page_info",
                "placement": "right",
                "default_state": "closed",
                "content_kind": "soundtrack_source_media_drawer",
            },
            "source_media": {
                "facts": [],
                "source_attributions": [],
            },
            "freshness_state": "missing",
            "last_enriched_at": None,
            "queued_refresh_state": "not_queued",
            "source_attributions": [],
            "local_library_status": {
                "state": "unknown",
                "album_count": 0,
                "album_refs": [],
            },
            "read_seam": {
                "source_kind": "soundtrack_snapshot",
                "visibility_scope": "viewer_safe",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "enqueue_only",
            },
            "visit_refresh": {
                "trigger": "page_visit",
                "enqueue_mode": "enqueue_only",
                "job_kind": "visit_deepen",
                "entity_kind": "soundtrack",
                "blocking": "never",
            },
        },
    }
    assert company_status == 409
    assert company_payload == {
        "ok": False,
        "error": (
            "Company page reads land on the dedicated /companies route family in later phases."
        ),
        "transport": "cache_only_page",
        "route_family": "/companies",
        "response_kind": "company_page",
        "page_kind": "company",
        "company_ref": "company-789",
        "company_page": {
            "company_ref": "company-789",
            "page_modes": ["info", "gallery"],
            "default_page_mode": "info",
            "active_page_mode": "info",
            "gallery_bar": {
                "component_kind": "gallery_bar",
                "surface_family": "resource_page",
                "page_mode_query_parameter": "page_mode",
                "page_modes": ["info", "gallery"],
                "default_page_mode": "info",
                "active_page_mode": "info",
                "info_drawer_toggle": {
                    "control_kind": "drawer_toggle",
                    "drawer_slot": "resource_page_info",
                },
            },
            "info_drawer": {
                "component_kind": "info_drawer",
                "surface_family": "resource_page",
                "drawer_slot": "resource_page_info",
                "placement": "right",
                "default_state": "closed",
                "content_kind": "company_soundtrack_drawer",
            },
            "soundtrack_browse": {
                "browse_kind": "exact_company_soundtracks",
                "scope_ref": "company-789",
                "scope_kind": "exact_company",
                "result_kind": "soundtrack_page",
                "rows": [],
                "row_fields": [
                    "source_title",
                    "release_year",
                    "media_type",
                    "primary_soundtrack_composer",
                    "local_library_status",
                    "local_soundtrack_album_refs",
                ],
            },
            "freshness_state": "missing",
            "last_enriched_at": None,
            "queued_refresh_state": "not_queued",
            "source_attributions": [],
            "local_library_status": {
                "state": "unknown",
                "album_count": 0,
                "album_refs": [],
            },
            "read_seam": {
                "source_kind": "company_soundtrack_snapshot",
                "visibility_scope": "viewer_safe",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "enqueue_only",
            },
            "visit_refresh": {
                "trigger": "page_visit",
                "enqueue_mode": "enqueue_only",
                "job_kind": "visit_deepen",
                "entity_kind": "company",
                "blocking": "never",
            },
        },
    }
