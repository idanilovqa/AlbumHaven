from __future__ import annotations

import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote_plus

import pytest
from tests.py.asgi_testing import create_test_asgi_app
from tests.py.asgi_testing import query_args_from_url as _query_args_from_url
from tests.py.asgi_testing import runtime_app_from_asgi_app

from music_app.routes import api_view_payload_helpers
from music_app.services import library as library_module
from music_app.services import library_roots as library_roots_module
from music_app.services import view_payloads as view_payloads_module
from music_app.services.state import format_timestamp
from music_app.services.view_payloads import (
    _build_live_selected_artist_group_payloads,
    _build_full_selected_artist_group_cache_key,
    _build_non_album_candidate_cache_key,
    _build_sidebar_cache_key,
    _build_search_bucket_cache_key,
    _build_query_selected_artist_group_cache_key,
    _build_query_artist_group_cache_key,
    _build_root_browse_cache_key,
    _resolve_non_album_candidates,
    _resolve_query_artist_group_index,
    _resolve_artists_sidebar,
    _resolve_search_buckets,
    _warm_query_selected_artist_group_cache,
    _write_full_selected_artist_group_cache_payload,
    _write_root_browse_cache_payload,
    _resolve_view_payload_request,
    build_home_payload as _build_home_payload,
    build_status_payload,
    build_view_payload as _build_view_payload,
)


_ORIGINAL_BUILD_MOVE_AVAILABILITY_PAYLOAD = library_module.build_move_availability_payload


@pytest.fixture
def app(tmp_path, monkeypatch):
    return runtime_app_from_asgi_app(create_test_asgi_app(tmp_path, monkeypatch))


def build_view_payload(*, app, query_args, **kwargs):
    kwargs.setdefault("config", app.config)
    kwargs.setdefault("logger", app.logger)
    kwargs.setdefault("library_state", app.library_state)
    kwargs.setdefault("query_args", query_args)
    return _build_view_payload(**kwargs)


def build_home_payload(*, app, query_args, **kwargs):
    kwargs.setdefault("config", app.config)
    kwargs.setdefault("logger", app.logger)
    kwargs.setdefault("library_state", app.library_state)
    kwargs.setdefault("query_args", query_args)
    return _build_home_payload(**kwargs)


def test_query_args_from_url_preserves_flask_request_args_contract():
    query_args = _query_args_from_url(
        "/view-data?artist=Neal+Morse"
        "&related_artist=Transatlantic"
        "&related_artist=The+Neal+Morse+Band"
        "&q="
    )

    assert query_args.get("artist") == "Neal Morse"
    assert query_args.getlist("related_artist") == [
        "Transatlantic",
        "The Neal Morse Band",
    ]
    assert query_args.get("q") == ""
    assert query_args.get("missing", "fallback") == "fallback"


def test_view_payloads_source_uses_asgi_runtime_carrier_without_direct_flask_imports():
    source = Path(__file__).read_text(encoding="utf-8")
    forbidden = [
        "tests.py." + "flask_fixtures",
        "from " + "flask",
        "import " + "flask",
        "Flask" + "(",
        "has_app" + "_context",
    ]

    assert all(pattern not in source for pattern in forbidden)


def _use_listen_history_read_seam(monkeypatch, items):
    seeded_items = [dict(item) for item in items]
    monkeypatch.setattr(
        "music_app.services.recent_listen_read_seams.load_listen_history",
        lambda _config: [dict(item) for item in seeded_items],
    )
    monkeypatch.setattr(
        "music_app.services.track_stats.load_listen_history",
        lambda _config: [dict(item) for item in seeded_items],
    )


def _use_library_root_settings_read_seam(app, monkeypatch, raw_payload):
    settings = library_roots_module.normalize_library_root_settings(
        raw_payload,
        fallback_main_root=Path(app.config["MUSIC_DIR"]),
    )

    def load_settings(_config):
        copied_settings = {}
        for key, value in settings.items():
            if isinstance(value, list):
                copied_settings[key] = [dict(root) for root in value]
            elif isinstance(value, dict):
                copied_settings[key] = dict(value)
            else:
                copied_settings[key] = value
        return copied_settings

    def build_move_availability_payload_with_seeded_roots(album, config):
        return _ORIGINAL_BUILD_MOVE_AVAILABILITY_PAYLOAD(
            album,
            config,
            load_settings=load_settings,
        )

    monkeypatch.setattr(
        library_roots_module,
        "load_library_root_settings",
        load_settings,
    )
    monkeypatch.setattr(
        library_module,
        "build_move_availability_payload",
        build_move_availability_payload_with_seeded_roots,
    )
    return settings


@pytest.fixture(autouse=True)
def _stub_library_root_settings_read_seam(app, monkeypatch):
    _use_library_root_settings_read_seam(app, monkeypatch, {})


def _seed_artist_family_payload_state(app, albums, relation_views, *, selected_artist_family_projections=None):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key=album["key"],
            name=album["name"],
            album_artist=album["album_artist"],
            artists=list(album["artists"]),
            cover_path=None,
            year=album.get("year", ""),
            release_date=album.get("release_date", ""),
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=album.get("is_compilation", False),
        )
        for album in albums
    ]
    st["file_cache"] = {}
    st["scan_in_progress"] = False
    st["relation_views"] = relation_views
    seeded_projections = {
        str(selected_artist or "").strip(): deepcopy(dict(projection))
        for selected_artist, projection in dict(selected_artist_family_projections or {}).items()
        if str(selected_artist or "").strip() and isinstance(projection, dict)
    }
    app.config["_TEST_SELECTED_ARTIST_FAMILY_PROJECTIONS"] = seeded_projections


def _seed_selected_artist_family_projection_map(
    app,
    projection_map,
    *,
    alias_to_canonical=None,
    canonical_to_aliases=None,
    relations_last_built=0.0,
):
    app.config["_TEST_SELECTED_ARTIST_FAMILY_PROJECTIONS"] = {
        str(selected_artist or "").strip(): {
            "family_artists": [str(artist or "").strip() for artist in list(family_artists or []) if str(artist or "").strip()],
            "relations_last_built": float(relations_last_built or 0.0),
            "loaded": True,
            "alias_to_canonical": dict(alias_to_canonical or {}),
            "canonical_to_aliases": {
                str(canonical or "").strip(): [
                    str(alias or "").strip()
                    for alias in list(aliases or [])
                    if str(alias or "").strip()
                ]
                for canonical, aliases in dict(canonical_to_aliases or {}).items()
                if str(canonical or "").strip()
            },
        }
        for selected_artist, family_artists in dict(projection_map or {}).items()
        if str(selected_artist or "").strip()
    }


@pytest.fixture(autouse=True)
def _seeded_selected_artist_family_projection(app, monkeypatch):
    def fake_load_selected_artist_family_projection(config, artist, **_kwargs):
        seeded = dict(config.get("_TEST_SELECTED_ARTIST_FAMILY_PROJECTIONS") or {})
        projection = seeded.get(str(artist or "").strip())
        if isinstance(projection, dict):
            return deepcopy(projection)
        return {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": False,
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        }

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        fake_load_selected_artist_family_projection,
    )
    yield
    app.config.pop("_TEST_SELECTED_ARTIST_FAMILY_PROJECTIONS", None)


@pytest.fixture(autouse=True)
def _stub_manual_version_links(monkeypatch):
    monkeypatch.setattr(view_payloads_module, "load_manual_version_links", lambda _config: {})


@pytest.fixture(autouse=True)
def _stub_ignored_version_keys(monkeypatch):
    monkeypatch.setattr(view_payloads_module, "load_ignored_version_keys", lambda _config: set())


@pytest.fixture(autouse=True)
def _stub_recent_listen_runtime_seams(monkeypatch):
    monkeypatch.setattr("music_app.services.recent_listen_read_seams.get_lastfm_user_timezone", lambda _config: "")
    monkeypatch.setattr("music_app.services.recent_listen_read_seams.load_listen_history", lambda _config: [])
    monkeypatch.setattr("music_app.services.track_stats.load_listen_history", lambda _config: [])


def test_view_payloads_exposes_neutral_artist_group_seam_without_route_helper_namespace():
    assert not hasattr(view_payloads_module, "api_view_payload_helpers")
    assert hasattr(view_payloads_module, "artist_group_helpers")
    assert view_payloads_module.artist_group_helpers.build_artist_groups is not None
    assert view_payloads_module.artist_group_helpers._build_artist_membership_groups is not None
    assert view_payloads_module.artist_group_helpers._cached_album_matches_group_artist is not None


def _artist_group_helpers():
    assert hasattr(view_payloads_module, "artist_group_helpers")
    return view_payloads_module.artist_group_helpers


def test_build_status_payload_reflects_current_state_counters(app):
    st = app.library_state
    st.update({
        "scan_in_progress": True,
        "scan_processed": 3,
        "scan_total": 6,
        "scan_current_path": "C:/Music/Artist/Album/track.mp3",
        "scan_elapsed_seconds": 9.5,
        "scan_estimated_remaining_seconds": 12.25,
        "scan_files_per_second": 0.4,
        "scan_album_folders_processed": 2,
        "scan_album_folders_total": 4,
        "scan_mode": "manual_full_rescan",
        "relations_in_progress": True,
        "relations_processed": 2,
        "relations_total": 5,
        "relations_phase": "Building",
        "relations_source": "local",
        "covers_in_progress": True,
        "covers_processed": 1,
        "covers_total": 4,
        "covers_downloaded": 1,
        "covers_current_folder": "C:/Music/Artist/Album",
        "pending_cover_refresh_after_scan": True,
        "last_scan": 1716000000.0,
        "last_error": "scan warning",
        "albums": [SimpleNamespace(key="album-1")],
    })

    payload = build_status_payload(library_state=st)

    assert payload == {
        "scan_in_progress": True,
        "scan_processed": 3,
        "scan_total": 6,
        "scan_percent": 50,
        "scan_current_path": "C:/Music/Artist/Album/track.mp3",
        "scan_elapsed_seconds": 9.5,
        "scan_estimated_remaining_seconds": 12.25,
        "scan_files_per_second": 0.4,
        "scan_album_folders_processed": 2,
        "scan_album_folders_total": 4,
        "scan_phase": "idle",
        "scan_mode": "manual_full_rescan",
        "relations_in_progress": True,
        "relations_processed": 2,
        "relations_total": 5,
        "relations_percent": 40,
        "relations_phase": "Building",
        "relations_source": "local",
        "covers_in_progress": True,
        "covers_processed": 1,
        "covers_total": 4,
        "covers_downloaded": 1,
        "covers_current_folder": "C:/Music/Artist/Album",
        "pending_cover_refresh_after_scan": True,
        "last_scan_display": format_timestamp(1716000000.0),
        "last_error": "scan warning",
        "album_total": 1,
        "relation_projection": {
            "ready": False,
            "builder_version": "",
            "startup_rebuilt": False,
            "rebuild_reason": "not_checked",
            "duration_ms": 0.0,
        },
    }


def test_build_status_payload_uses_provided_state_without_flask_context():
    library_state = {
        "scan_in_progress": True,
        "scan_processed": 5,
        "scan_total": 10,
        "relations_in_progress": True,
        "relations_processed": 3,
        "relations_total": 4,
        "albums": [SimpleNamespace(key="album-1"), SimpleNamespace(key="album-2")],
    }

    payload = build_status_payload(library_state=library_state)

    assert payload["scan_percent"] == 50
    assert payload["relations_percent"] == 75
    assert payload["album_total"] == 2
    assert library_state["scan_processed"] == 5
    assert library_state["relations_processed"] == 3


def test_build_status_payload_requires_explicit_state_without_flask_context():
    with pytest.raises(ValueError, match="library_state is required"):
        build_status_payload()


def test_resolve_view_payload_request_normalizes_query_arguments(app):
    query_args = _query_args_from_url(
        "/view-data?surface=playlists&q=%20Post-Rock%20&artist=%20Mono%20"
        "&gallery_scope=new_arrivals&gallery_display=covers&gallery_scale_percent=135"
        "&category=main_library&category=new_arrivals&family_display=chronological"
        "&tree_mode=subtle_genres&payload_tier=sidebar&omit_sidebar=yes"
        "&genre=Post%20Rock&mood=Atmospheric&style=Cinematic"
        "&duration_min=180&duration_max=600&playlist_id=playlist-1"
        "&all_artists=1&related_artist=%20Stereolab%20&related_artist=&primary_filter=true"
        "&page_mode=info&timeline_at=2009-03-24"
    )
    view_request = _resolve_view_payload_request(query_args=query_args)

    assert view_request.query_raw == "Post-Rock"
    assert view_request.query == "post rock"
    assert view_request.active_surface == "playlists"
    assert view_request.gallery_scope == "new_arrivals"
    assert view_request.gallery_display_mode == "covers"
    assert view_request.gallery_scale_percent == 135
    assert view_request.arrivals_only_scope is True
    assert view_request.category_filter_requested is True
    assert view_request.root_aware_filtering_active is True
    assert view_request.selected_artist_family_display_mode == "chronological"
    assert view_request.local_tree_submode == "subtle_genres"
    assert view_request.visible_library_categories == ["new_arrivals"]
    assert view_request.requested_artist == "Mono"
    assert view_request.requested_payload_tier == "sidebar"
    assert view_request.sidebar_only_payload is True
    assert view_request.omit_sidebar is True
    assert view_request.search_filters == {
        "genre": ["Post Rock"],
        "mood": ["Atmospheric"],
        "style": ["Cinematic"],
        "duration": {
            "min_seconds": 180,
            "max_seconds": 600,
        },
    }
    assert view_request.requested_playlist_id == "playlist-1"
    assert view_request.requested_all_artists is True
    assert view_request.requested_related_artists == ["Stereolab"]
    assert view_request.requested_primary_filter is True
    assert view_request.page_mode == "info"
    assert view_request.family_display_mode == "chronological"
    assert view_request.timeline_at == "2009-03-24"


def test_resolve_view_payload_request_does_not_read_flask_request_when_query_args_omitted(app):
    view_request = _resolve_view_payload_request()

    assert view_request.query_raw == ""
    assert view_request.query == ""
    assert view_request.requested_artist == ""
    assert view_request.active_surface == "albums"


def test_resolve_view_payload_request_uses_explicit_query_args_inside_flask_context(app):
    view_request = _resolve_view_payload_request(
        query_args=_query_args_from_url(
            "/view-data?q=Flask%20Context&artist=Mono&surface=albums"
        )
    )

    assert view_request.query_raw == "Flask Context"
    assert view_request.query == "flask context"
    assert view_request.requested_artist == "Mono"
    assert view_request.active_surface == "albums"


def test_resolve_view_payload_request_honors_active_surface_override(app):
    view_request = _resolve_view_payload_request(
        active_surface_override="home",
        query_args=_query_args_from_url("/view-data?surface=playlists"),
    )

    assert view_request.active_surface == "home"


def test_build_root_browse_cache_key_includes_viewer_preference_signature():
    albums_state = object()

    key = _build_root_browse_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=17,
        gallery_scope="library",
        visible_library_categories=["main_library", "new_arrivals"],
        viewer_opinion_preference_signature=(("show_loved", True), ("show_rated", False)),
    )

    assert key == (
        id(albums_state),
        17,
        "library",
        ("main_library", "new_arrivals"),
        (("show_loved", True), ("show_rated", False)),
    )


def test_build_live_selected_artist_group_payloads_uses_filtered_family_artist_order(monkeypatch):
    captured_targets: list[list[str]] = []

    def fake_build_artist_membership_groups(albums, artists, *_args, **_kwargs):
        captured_targets.append(list(artists))
        return []

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fake_build_artist_membership_groups,
    )

    payload = _build_live_selected_artist_group_payloads(
        selected_artist="Mono",
        family_artists=["Broadcast", "Stereolab", "A.A. Williams"],
        related_filter_artists=["Stereolab", "A.A. Williams"],
        primary_filter_active=True,
        visible_family_artist_set={"A.A. Williams", "Stereolab"},
        alias_to_canonical={},
        canonical_to_aliases={},
        album_group_match_cache={},
        album_payload_cache={},
        album_serializer=lambda album: album,
        collect_selected_artist_album_sets=lambda *_args, **_kwargs: ([], set(), [], {}),
        timings={},
        family_display_mode="chronological",
        full_selected_artist_cache_key=None,
        selected_artist_group_cache={},
        requested_related_artists=["Stereolab", "A.A. Williams"],
        requested_primary_filter=True,
        public_safe=False,
    )

    assert payload == {
        "primary_artist_groups": [],
        "family_artist_groups": [],
        "artist_groups": [],
    }
    assert captured_targets == [
        ["Mono"],
        ["Stereolab", "A.A. Williams"],
    ]


def test_write_root_browse_cache_payload_merges_existing_payload_for_exact_cache_key():
    albums_state = object()
    root_browse_cache: dict[object, object] = {}
    cache_key = _build_root_browse_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=23,
        gallery_scope="library",
        visible_library_categories=["main_library"],
        viewer_opinion_preference_signature=(("show_loved", True),),
    )
    root_browse_cache[cache_key] = {
        "artist_groups": [{"artist": "Broadcast"}],
    }

    written_payload = _write_root_browse_cache_payload(
        root_browse_cache,
        cache_key,
        artists_sidebar=[{"artist": "Broadcast"}],
    )

    assert written_payload == {
        "artist_groups": [{"artist": "Broadcast"}],
        "artists_sidebar": [{"artist": "Broadcast"}],
    }
    assert root_browse_cache == {
        cache_key: {
            "artist_groups": [{"artist": "Broadcast"}],
            "artists_sidebar": [{"artist": "Broadcast"}],
        }
    }


def test_build_search_bucket_cache_key_tracks_album_identity_relation_identity_and_query():
    albums_state = object()

    key = _build_search_bucket_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=41,
        query="mono",
    )

    assert key == (
        id(albums_state),
        41,
        "mono",
    )


def test_resolve_search_buckets_reuses_cached_query_results(monkeypatch):
    search_bucket_calls = 0

    def fake_search_buckets(*_args, **_kwargs):
        nonlocal search_bucket_calls
        search_bucket_calls += 1
        return {"albums": [], "direct_artists": [], "related_artists": []}

    monkeypatch.setattr("music_app.services.view_payloads.artist_search_buckets", fake_search_buckets)
    albums_state = object()
    library_state: dict[str, object] = {}

    first_payload = _resolve_search_buckets(
        library_state,
        albums_state=albums_state,
        relation_view_cache_identity=7,
        all_albums=[],
        relation_views={},
        query="mono",
    )
    second_payload = _resolve_search_buckets(
        library_state,
        albums_state=albums_state,
        relation_view_cache_identity=7,
        all_albums=[],
        relation_views={},
        query="mono",
    )

    assert search_bucket_calls == 1
    assert first_payload is second_payload


def test_build_query_artist_group_cache_key_can_include_viewer_preference_signature():
    albums_state = object()
    relation_views_state = object()

    key = _build_query_artist_group_cache_key(
        albums_state=albums_state,
        relation_views_state=relation_views_state,
        query="mono",
        visible_library_categories=["main_library"],
        ordered_artists=["Mono", "MONO"],
        viewer_opinion_preference_signature=(("show_loved", True),),
    )

    assert key == (
        id(albums_state),
        id(relation_views_state),
        "mono",
        ("main_library",),
        ("Mono", "MONO"),
        (("show_loved", True),),
    )


def test_resolve_query_artist_group_index_reuses_cached_query_group_index(monkeypatch):
    match_calls = 0
    library_state: dict[str, object] = {}
    albums_state = object()
    relation_views_state = object()
    filtered_albums = [SimpleNamespace(key="album-1", album_artist="Mono", artists=["Mono"])]

    def fake_matches_group_artist(_album, artist, _alias_to_canonical, _album_group_match_cache):
        nonlocal match_calls
        match_calls += 1
        return artist == "Mono"

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_cached_album_matches_group_artist",
        fake_matches_group_artist,
    )

    first_index, first_key = _resolve_query_artist_group_index(
        library_state,
        albums_state=albums_state,
        relation_views_state=relation_views_state,
        query="mono",
        visible_library_categories=["main_library"],
        ordered_artists=["Mono"],
        filtered_albums=filtered_albums,
        alias_to_canonical={},
        album_group_match_cache={},
    )
    second_index, second_key = _resolve_query_artist_group_index(
        library_state,
        albums_state=albums_state,
        relation_views_state=relation_views_state,
        query="mono",
        visible_library_categories=["main_library"],
        ordered_artists=["Mono"],
        filtered_albums=filtered_albums,
        alias_to_canonical={},
        album_group_match_cache={},
    )

    assert match_calls == 1
    assert first_key == second_key
    assert first_index is second_index


def test_build_query_selected_artist_group_cache_key_tracks_query_scope_artist_and_note_signature():
    key = _build_query_selected_artist_group_cache_key(
        query_group_cache_key=("query-scope",),
        artist="Mono",
        public_safe=False,
        selected_artist_album_note_cache_signature=(("note-1",),),
    )

    assert key == (
        ("query-scope",),
        "Mono",
        False,
        (("note-1",),),
    )


def test_warm_query_selected_artist_group_cache_builds_missing_artist_entries_once():
    build_calls: list[str] = []
    selected_artist_group_cache: dict[object, object] = {}

    _warm_query_selected_artist_group_cache(
        selected_artist_group_cache,
        query_group_cache_key=("query-scope",),
        warm_precompute_artists=["Mono", "MONO"],
        public_safe=False,
        selected_artist_album_note_cache_signature=(("note-1",),),
        build_cached_selected_artist_groups=lambda artist: build_calls.append(artist) or {"artist": artist},
    )

    assert build_calls == ["Mono", "MONO"]
    assert selected_artist_group_cache == {
        (("query-scope",), "Mono", False, (("note-1",),)): {"artist": "Mono"},
        (("query-scope",), "MONO", False, (("note-1",),)): {"artist": "MONO"},
    }


def test_build_full_selected_artist_group_cache_key_tracks_selected_artist_and_note_signature():
    albums_state = object()

    key = _build_full_selected_artist_group_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=29,
        visible_library_categories=["main_library"],
        selected_artist="Mono",
        public_safe=False,
        viewer_opinion_preference_signature=(("show_loved", True),),
        selected_artist_album_note_cache_signature=(("note-1",),),
    )

    assert key == (
        id(albums_state),
        29,
        ("main_library",),
        "Mono",
        False,
        (("show_loved", True),),
        (("note-1",),),
    )


def test_write_full_selected_artist_group_cache_payload_stores_family_groups_and_timings():
    selected_artist_group_cache: dict[object, object] = {}
    cache_key = ("selected-artist-scope",)

    _write_full_selected_artist_group_cache_payload(
        selected_artist_group_cache,
        cache_key,
        family_artists=["Stereolab"],
        primary_artist_groups=[{"artist": "Broadcast"}],
        family_artist_groups=[{"artist": "Stereolab"}],
        timings={
            "selected_artist_primary_album_collection_ms": 1.0,
            "selected_artist_family_album_collection_ms": 2.0,
            "selected_artist_primary_group_build_ms": 3.0,
            "selected_artist_family_group_build_ms": 4.0,
        },
    )

    assert selected_artist_group_cache == {
        cache_key: {
            "family_artists": ["Stereolab"],
            "primary_artist_groups": [{"artist": "Broadcast"}],
            "family_artist_groups": [{"artist": "Stereolab"}],
            "timings": {
                "selected_artist_primary_album_collection_ms": 1.0,
                "selected_artist_family_album_collection_ms": 2.0,
                "selected_artist_primary_group_build_ms": 3.0,
                "selected_artist_family_group_build_ms": 4.0,
            },
        }
    }


def test_build_sidebar_cache_key_tracks_query_scope_and_categories():
    albums_state = object()

    key = _build_sidebar_cache_key(
        albums_state=albums_state,
        relation_view_cache_identity=53,
        query="mono",
        gallery_scope="library",
        visible_library_categories=["main_library", "new_arrivals"],
    )

    assert key == (
        id(albums_state),
        53,
        "mono",
        "library",
        ("main_library", "new_arrivals"),
    )


def test_resolve_artists_sidebar_reuses_cached_sidebar(monkeypatch):
    sidebar_calls = 0

    def fake_build_artists_sidebar(*_args, **_kwargs):
        nonlocal sidebar_calls
        sidebar_calls += 1
        return [{"artist": "Mono"}]

    monkeypatch.setattr("music_app.services.view_payloads.build_artists_sidebar", fake_build_artists_sidebar)
    albums_state = object()
    library_state: dict[str, object] = {}

    first_sidebar = _resolve_artists_sidebar(
        library_state,
        albums_state=albums_state,
        relation_view_cache_identity=53,
        query="mono",
        gallery_scope="library",
        visible_library_categories=["main_library"],
        sidebar_source_albums=[],
        relation_views={},
    )
    second_sidebar = _resolve_artists_sidebar(
        library_state,
        albums_state=albums_state,
        relation_view_cache_identity=53,
        query="mono",
        gallery_scope="library",
        visible_library_categories=["main_library"],
        sidebar_source_albums=[],
        relation_views={},
    )

    assert sidebar_calls == 1
    assert first_sidebar == [{"artist": "Mono"}]
    assert second_sidebar == [{"artist": "Mono"}]


def test_build_non_album_candidate_cache_key_tracks_file_cache_and_category_scope():
    file_cache = object()

    key = _build_non_album_candidate_cache_key(
        file_cache=file_cache,
        relation_view_cache_identity=67,
        visible_library_categories=["main_library", "new_arrivals"],
    )

    assert key == (
        id(file_cache),
        67,
        ("main_library", "new_arrivals"),
    )


def test_resolve_non_album_candidates_reuses_cached_candidates(monkeypatch):
    candidate_calls = 0

    def fake_build_candidates(*_args, **_kwargs):
        nonlocal candidate_calls
        candidate_calls += 1
        return [{"entry": {"path": "track.mp3"}}]

    monkeypatch.setattr("music_app.services.view_payloads._build_non_album_entry_candidates", fake_build_candidates)
    file_cache = object()
    library_state: dict[str, object] = {}
    config = {}

    first_candidates = _resolve_non_album_candidates(
        library_state,
        config=config,
        file_cache=file_cache,
        relation_view_cache_identity=67,
        visible_library_categories=["main_library"],
        alias_to_canonical={},
    )
    second_candidates = _resolve_non_album_candidates(
        library_state,
        config=config,
        file_cache=file_cache,
        relation_view_cache_identity=67,
        visible_library_categories=["main_library"],
        alias_to_canonical={},
    )

    assert candidate_calls == 1
    assert first_candidates == [{"entry": {"path": "track.mp3"}}]
    assert second_candidates == [{"entry": {"path": "track.mp3"}}]


def test_build_view_payload_requires_explicit_config_inside_flask_context(app):
    with pytest.raises(ValueError, match="build_view_payload requires explicit config"):
        view_payloads_module.build_view_payload(
            library_state={"albums": [], "file_cache": {}, "relation_views": {}}
        )


def test_build_view_payload_requires_explicit_config_before_state():
    with pytest.raises(ValueError, match="build_view_payload requires explicit config"):
        view_payloads_module.build_view_payload()


def test_build_view_payload_requires_explicit_state_without_flask_context(app):
    with pytest.raises(ValueError, match="library_state is required"):
        view_payloads_module.build_view_payload(
            config=dict(app.config),
            logger=app.logger,
        )


def test_build_home_payload_requires_explicit_config_inside_flask_context(app):
    with pytest.raises(ValueError, match="build_home_payload requires explicit config"):
        view_payloads_module.build_home_payload(
            library_state={"albums": [], "file_cache": {}, "relation_views": {}}
        )


def test_build_home_payload_requires_explicit_config_before_state():
    with pytest.raises(ValueError, match="build_home_payload requires explicit config"):
        view_payloads_module.build_home_payload()


def test_build_home_payload_requires_explicit_state_without_flask_context(app):
    with pytest.raises(ValueError, match="library_state is required"):
        view_payloads_module.build_home_payload(
            config=dict(app.config),
            logger=app.logger,
        )


def test_build_view_payload_uses_explicit_config_inside_flask_context(app):
    explicit_config = dict(app.config)
    explicit_config["APP_NAME"] = "Explicit Album Haven"
    app.config["APP_NAME"] = "Flask Global Album Haven"

    payload = view_payloads_module.build_view_payload(
        query_args=_query_args_from_url("/view-data"),
        config=explicit_config,
        logger=app.logger,
        library_state={"albums": [], "file_cache": {}, "relation_views": {}},
    )

    assert payload["app_name"] == "Explicit Album Haven"


def test_build_view_payload_does_not_read_flask_request_when_query_args_omitted(app):
    payload = view_payloads_module.build_view_payload(
        config=app.config,
        logger=app.logger,
        library_state={"albums": [], "file_cache": {}, "relation_views": {}},
    )

    assert payload["query"] == ""
    assert payload["selected_artist"] == ""


def test_build_view_payload_uses_explicit_query_args_inside_flask_context(app):
    payload = view_payloads_module.build_view_payload(
        query_args=_query_args_from_url("/view-data?q=Flask%20Context&artist=Mono"),
        config=app.config,
        logger=app.logger,
        library_state={"albums": [], "file_cache": {}, "relation_views": {}},
    )

    assert payload["query"] == "Flask Context"


def test_build_view_payload_keeps_clicked_shared_artist_selected_during_search(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "mpg-1",
                "name": "Cover 2 Cover",
                "album_artist": "Morse Portnoy George",
                "artists": ["Morse Portnoy George"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse & The Resonance": "Neal Morse",
                "Neal Morse": "Neal Morse",
                "Morse Portnoy George": "Morse Portnoy George",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                "Morse Portnoy George": ["Morse Portnoy George"],
            },
            "folder_related": {
                "Neal Morse": {"Morse Portnoy George"},
                "Morse Portnoy George": {"Neal Morse"},
            },
        },
        selected_artist_family_projections={
            "Neal Morse & The Resonance": {
                "family_artists": ["Morse Portnoy George", "Neal Morse"],
                "relations_last_built": 0.0,
                "loaded": True,
                "alias_to_canonical": {
                    "Neal Morse & The Resonance": "Neal Morse",
                    "Neal Morse": "Neal Morse",
                    "Morse Portnoy George": "Morse Portnoy George",
                },
                "canonical_to_aliases": {
                    "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                    "Morse Portnoy George": ["Morse Portnoy George"],
                },
            },
        },
    )
    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=morse&artist=Neal+Morse+%26+The+Resonance"
        ),
    )

    assert payload["selected_artist"] == "Neal Morse & The Resonance"
    assert any(item["artist"] == "Neal Morse & The Resonance" for item in payload["artists_sidebar"])
    assert payload["artist_groups"]
    assert payload["artist_groups"][0]["artist"] == "Neal Morse & The Resonance"


def test_build_view_payload_hides_all_artists_for_single_family_search(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "neal-1",
                "name": "One",
                "album_artist": "Neal Morse",
                "artists": ["Neal Morse"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
            "folder_related": {
                "Neal Morse": {"Neal Morse & The Resonance"},
                "Neal Morse & The Resonance": {"Neal Morse"},
            },
        },
        selected_artist_family_projections={
            "Neal Morse & The Resonance": {
                "family_artists": ["Neal Morse"],
                "relations_last_built": 0.0,
                "loaded": True,
                "alias_to_canonical": {
                    "Neal Morse": "Neal Morse",
                    "Neal Morse & The Resonance": "Neal Morse",
                },
                "canonical_to_aliases": {
                    "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                },
            },
        },
    )
    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=Neal+Morse&artist=Neal+Morse%20%26%20The%20Resonance"
        ),
    )

    assert payload["selected_artist"] == "Neal Morse & The Resonance"
    assert payload["show_all_artists_sidebar_link"] is False
    assert {group["artist"] for group in payload["artist_groups"]} == {
        "Neal Morse",
        "Neal Morse & The Resonance",
    }


def test_build_view_payload_search_sidebar_stays_limited_to_artist_name_matches(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="neal-1",
            name="One",
            album_artist="Neal Morse",
            artists=["Neal Morse"],
            cover_path=None,
            year=2001,
            release_date="",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="spock-1",
            name="V",
            album_artist="Spock's Beard",
            artists=["Spock's Beard"],
            cover_path=None,
            year=2000,
            release_date="",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[
                SimpleNamespace(
                    path=r"X:\SyntheticMusic\Spocks Beard\V\01 - Neal and Jack and Me.mp3",
                    title="Neal and Jack and Me",
                )
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["scan_in_progress"] = False
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=Neal"))

    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Neal Morse"]
    assert payload["artist_count"] == 1
    assert [group["artist"] for group in payload["artist_groups"]] == ["Neal Morse"]


def test_build_view_payload_merges_case_only_variants_for_shared_artist_groups(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "mono-aa-1",
                "name": "Exit in Darkness",
                "album_artist": "MONO / A.A. Williams",
                "artists": ["MONO", "A.A. Williams"],
                "is_compilation": True,
            },
            {
                "key": "mono-aa-2",
                "name": "Live Session",
                "album_artist": "Mono / A.A. Williams",
                "artists": ["Mono", "A.A. Williams"],
                "is_compilation": True,
            },
        ],
        {
            "alias_to_canonical": {
                "MONO": "Mono",
                "Mono": "Mono",
                "A.A. Williams": "A.A. Williams",
            },
            "canonical_to_aliases": {
                "Mono": ["Mono", "MONO"],
                "A.A. Williams": ["A.A. Williams"],
            },
            "folder_related": {},
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert [group["artist"] for group in payload["artist_groups"]] == ["Mono / A.A. Williams"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Exit in Darkness",
        "Live Session",
    ]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Mono / A.A. Williams"]


def test_build_view_payload_merges_case_only_solo_artist_variants_even_when_relation_views_are_stale(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "mono-2009",
                "name": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "artists": ["Mono"],
                "year": 2009,
            },
            {
                "key": "mono-2021",
                "name": "Pilgrimage of the Soul",
                "album_artist": "MONO",
                "artists": ["MONO"],
                "year": 2021,
            },
        ],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["selected_artist"] == "Mono"
    assert [group["artist"] for group in payload["artist_groups"]] == ["Mono"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Hymn to the Immortal Wind",
        "Pilgrimage of the Soul",
    ]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Mono"]


def test_build_view_payload_merges_shared_artist_punctuation_variants_even_when_relation_views_are_stale(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "mpg-1",
                "name": "Cover 2 Cover",
                "album_artist": "Morse Portnoy George",
                "artists": ["Neal Morse", "Mike Portnoy", "Randy George"],
                "year": 2012,
            },
            {
                "key": "mpg-2",
                "name": "Songs from November",
                "album_artist": "Morse, Portnoy & George",
                "artists": ["Neal Morse", "Mike Portnoy", "Randy George"],
                "year": 2024,
            },
        ],
        {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert payload["selected_artist"] == ""
    assert [group["artist"] for group in payload["artist_groups"]] == ["Morse Portnoy George"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Cover 2 Cover",
        "Songs from November",
    ]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Morse Portnoy George"]


def test_build_view_payload_all_artists_request_keeps_search_wide_view_active(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "neal-1",
                "name": "One",
                "album_artist": "Neal Morse",
                "artists": ["Neal Morse"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
            "folder_related": {
                "Neal Morse": {"Neal Morse & The Resonance"},
                "Neal Morse & The Resonance": {"Neal Morse"},
            },
        },
        selected_artist_family_projections={},
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=Neal+Morse&all_artists=1"))

    assert payload["selected_artist"] == ""
    assert payload["all_artists_active"] is True
    assert payload["artist_groups"]
    assert payload["artist_groups"][0]["artist"] == "Neal Morse"
    assert payload["album_count"] == 2
    assert {item["artist"] for item in payload["artists_sidebar"]} == {
        "Neal Morse",
        "Neal Morse & The Resonance",
    }


def test_build_view_payload_selected_artist_exposes_alias_family_groups(app):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "neal-1",
                "name": "One",
                "album_artist": "Neal Morse",
                "artists": ["Neal Morse"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
            {
                "key": "mpg-1",
                "name": "Cover 2 Cover",
                "album_artist": "Morse Portnoy George",
                "artists": ["Morse Portnoy George"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
                "Morse Portnoy George": "Morse Portnoy George",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                "Morse Portnoy George": ["Morse Portnoy George"],
            },
            "folder_related": {
                "Neal Morse": {"Morse Portnoy George"},
                "Morse Portnoy George": {"Neal Morse"},
            },
        },
        selected_artist_family_projections={
            "Neal Morse": {
                "family_artists": ["Morse Portnoy George", "Neal Morse & The Resonance"],
                "relations_last_built": 0.0,
                "loaded": True,
                "alias_to_canonical": {
                    "Neal Morse": "Neal Morse",
                    "Neal Morse & The Resonance": "Neal Morse",
                    "Morse Portnoy George": "Morse Portnoy George",
                },
                "canonical_to_aliases": {
                    "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                    "Morse Portnoy George": ["Morse Portnoy George"],
                },
            },
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Neal+Morse"))

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["related_artists"] == ["Neal Morse & The Resonance", "Morse Portnoy George"]
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Neal Morse"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Neal Morse & The Resonance",
        "Morse Portnoy George",
    ]


def test_build_view_payload_related_artist_filter_can_show_only_alias_family_group(app, monkeypatch):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "neal-1",
                "name": "One",
                "album_artist": "Neal Morse",
                "artists": ["Neal Morse"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
            "folder_related": {
                "Neal Morse": set(),
            },
        },
        selected_artist_family_projections={},
    )
    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Neal Morse & The Resonance"],
            "relations_last_built": 1.0,
            "loaded": True,
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
        },
    )
    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?artist=Neal+Morse&related_artist=Neal%20Morse%20%26%20The%20Resonance"
        ),
    )

    assert payload["related_filter_artists"] == ["Neal Morse & The Resonance"]
    assert payload["primary_artist_groups"] == []
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Neal Morse & The Resonance"]
    assert [group["name"] for group in payload["family_artist_groups"][0]["albums"]] == ["No Hill for a Climber"]


def test_build_view_payload_preserves_query_and_family_filter_contract(app, monkeypatch):
    _seed_artist_family_payload_state(
        app,
        [
            {
                "key": "neal-1",
                "name": "One",
                "album_artist": "Neal Morse",
                "artists": ["Neal Morse"],
            },
            {
                "key": "resonance-1",
                "name": "No Hill for a Climber",
                "album_artist": "Neal Morse & The Resonance",
                "artists": ["Neal Morse & The Resonance"],
            },
        ],
        {
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
            "folder_related": {
                "Neal Morse": set(),
            },
        },
        selected_artist_family_projections={},
    )
    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Neal Morse & The Resonance"],
            "relations_last_built": 1.0,
            "loaded": True,
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            },
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Neal+Morse&q=Neal+Morse"
        "&related_artist=Neal+Morse+%26+The+Resonance&primary_filter=1"
    ))

    assert payload["query"] == "Neal Morse"
    assert payload["selected_artist"] == "Neal Morse"
    assert payload["all_artists_active"] is False
    assert payload["related_filter_artists"] == ["Neal Morse & The Resonance"]
    assert payload["primary_filter_active"] is True
    assert payload["show_all_artists_sidebar_link"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Neal Morse"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Neal Morse & The Resonance"]
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Neal Morse",
        "Neal Morse & The Resonance",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_service_keeps_read_side_contract(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }
    st["artist_popularity_overlays"] = {
        "Mono": {
            "scrobble_count": 2500,
            "listener_count": 725,
            "available_sort_metrics": ["scrobbles", "listeners"],
            "freshness_state": "fresh",
        },
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Mono&page_mode=info&family_display=chronological&timeline_at=2009-03-24"
    ))

    assert payload["selected_artist"] == "Mono"
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1
    assert payload["artist_page"] == {
        "artist_ref": "Mono",
        "page_modes": ["gallery", "info"],
        "default_page_mode": "gallery",
        "active_page_mode": "info",
        "family_display_mode": "chronological",
        "gallery_display_mode": "cards",
        "gallery_scale_percent": 100,
        "timeline_at": "2009-03-24",
        "gallery_bar": {
            "component_kind": "gallery_bar",
            "surface_family": "resource_page",
            "page_mode_query_parameter": "page_mode",
            "page_modes": ["gallery", "info"],
            "default_page_mode": "gallery",
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
            "content_kind": "artist_release_drawer",
        },
        "extra_original_material_query": {
            "query_ref": None,
            "query_state": "idle",
            "trigger_mode": "user_triggered",
            "default_scope": "singles_compilations",
            "scope_label": "Singles + Compilations",
            "supported_scopes": [
                {
                    "scope": "singles_compilations",
                    "label": "Singles + Compilations",
                },
            ],
            "temporary_result_identity_field": "original_material_query_ref",
            "temporary_result_posture": "temporary_read_model",
            "saved_overlay_side_effect": "none",
            "comparison_context": {
                "comparison_basis": "local_library_artist_page",
                "confidence_state": "available",
            },
            "result_labels": {
                "preferred_when_confident_local_library_comparison_available": (
                    "missing from your library"
                ),
                "fallback_when_confident_local_library_comparison_unavailable": (
                    "contains original material"
                ),
                "default_label": "missing from your library",
            },
            "classification_rules": {
                "requires_at_least_one_original_track": True,
                "hide_cover_only_releases": True,
            },
            "results": [],
        },
        "release_overlay_scopes": ["library_scoped", "user_scoped"],
        "release_timing_contract": {
            "release_fields": [
                "release_date",
                "release_date_precision",
                "release_timing_state",
                "countdown_target_at",
            ],
            "optional_fields": ["countdown_target_at"],
            "viewer_local_fields": ["countdown_target_at"],
        },
        "remote_release_overlay_read_contract": {
            "supported_scopes": ["library_scoped", "user_scoped"],
            "scope_visibility": {
                "library_scoped": {
                    "read_visibility": "shared_library_or_server_surface",
                    "precedence_rank": 1,
                },
                "user_scoped": {
                    "read_visibility": "viewer_private_surface",
                    "precedence_rank": 2,
                },
            },
            "dedupe_policy": {
                "logical_release_unit": "one_card_per_logical_remote_release",
                "preferred_scope_order": ["library_scoped", "user_scoped"],
                "collapse_to_local_album_when_available": True,
            },
            "canonical_truth_boundary": {
                "canonical_album_card_source": "local_library_album",
                "overlay_posture": "supplemental_remote_release_only",
                "overlays_do_not_replace_canonical_album_identity": True,
            },
        },
        "artist_popularity": {
            "is_visible": True,
            "scrobble_count": 2500,
            "listener_count": 725,
            "available_sort_metrics": ["scrobbles", "listeners"],
            "freshness_state": "fresh",
            "read_seam": {
                "source_kind": "lastfm_popularity_snapshot",
                "visibility_scope": "viewer_scoped_with_crowd_preference",
                "read_mode": "cache_first",
                "request_fetch_policy": "never",
                "background_refresh_policy": "scan_follow_up_or_stale_background",
            },
        },
        "gallery_payload": {
            "artist_ref": "Mono",
            "payload_source": "top_level_selected_artist_payload",
            "artist_groups_field": "artist_groups",
            "primary_artist_groups_field": "primary_artist_groups",
            "family_artist_groups_field": "family_artist_groups",
            "related_artists_field": "related_artists",
            "artist_family_filters_field": "artist_family_filters",
            "album_count_field": "album_count",
            "artist_count_field": "artist_count",
            "playback_context_field": "playback_context",
            "listen_through_scope_candidates_field": (
                "listen_through_scope_candidates"
            ),
        },
    }
    assert payload["viewer_opinion_preferences"] == {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
        "defaults": {
            "show_crowd_opinion": False,
            "show_friends_opinions": False,
        },
        "preference_scope": "viewer_scoped",
        "control_fields": [
            "show_crowd_opinion",
            "show_friends_opinions",
        ],
        "read_seam": {
            "source_kind": "viewer_opinion_preferences",
            "visibility_scope": "viewer_scoped",
            "read_mode": "state_backed_default",
            "request_fetch_policy": "never",
            "background_refresh_policy": "write_on_change_later",
        },
    }
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert payload["artists_sidebar"] == [
        {
            "artist": "Mono",
            "artist_display": "Mono",
            "count": 1,
        },
    ]
    assert payload["playback_context"] == {
        "kind": "artist_page",
        "end_behavior": "stop",
        "ordered_album_refs": ["mono-1"],
        "albums": [
            {
                "album_ref": "mono-1",
                "can_play": True,
            },
        ],
    }


def test_build_view_payload_home_surface_exposes_explicit_top_level_surface_contract(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?surface=home"))

    assert payload["surface"] == {
        "active": "home",
        "default": "home",
        "supported": ["home", "albums", "playlists"],
        "reserved": ["album_tops"],
    }
    assert payload["shell_layout"] == {
        "kind": "shared_media_shell",
        "slots": {
            "app_bar": {
                "content_kind": "global_search_toolbar",
                "header_surfaces": {
                    "shared_badge_primitives": True,
                    "shared_drawer_primitives": True,
                    "notifications": {
                        "entry_kind": "operational_drawer",
                        "badge_kind": "operational_notifications",
                        "drawer_slot": "info_drawer",
                        "default_drawer_content_kind": "cover_lookup_drawer",
                        "supported_drawer_content_kinds": ["cover_lookup_drawer"],
                        "drawer_content_kind": "cover_lookup_drawer",
                        "page_route": None,
                    },
                    "discovery_center": {
                        "entry_kind": "drawer_plus_page",
                        "badge_kind": "discovery_center",
                        "drawer_content_kind": "discovery_center_preview",
                        "page_route": "/news",
                    },
                },
            },
            "navigation_rail": {
                "content_kind": "artists_sidebar",
                "default_collapsed": True,
            },
            "contextual_pane": {
                "content_kind": "contextual_navigation",
                "is_visible": False,
                "active_pane": "local_tree",
                "supported_panes": [
                    "local_tree",
                    "playlists",
                    "album_tops",
                    "artist_gallery",
                ],
                "local_tree": {
                    "default_submode": "folders",
                    "active_submode": "folders",
                    "supported_submodes": [
                        "folders",
                        "artists",
                        "albums",
                        "broad_genres",
                        "subtle_genres",
                    ],
                },
                "splitter": {
                    "desktop_only": True,
                    "axis": "inline",
                    "placement": "left",
                    "state_scope": "local_first",
                    "mobile_fallback": "drawer",
                },
            },
            "main_content": {
                "surface_ref": "home",
                "content_kind": "gallery",
            },
            "info_drawer": {
                "component_kind": "notification_drawer",
                "content_kind": "cover_lookup_drawer",
                "default_content_kind": "cover_lookup_drawer",
                "supported_content_kinds": ["cover_lookup_drawer"],
                "surface_family": "notifications",
                "default_surface_family": "notifications",
                "placement": "right",
                "is_optional": True,
                "splitter": {
                    "desktop_only": True,
                    "axis": "inline",
                    "placement": "right",
                    "state_scope": "local_first",
                    "mobile_fallback": "sheet_or_drawer",
                },
            },
            "bottom_player": {
                "content_kind": "global_player",
                "is_persistent": True,
            },
        },
    }
    assert payload["local_tree_submode"] == "folders"


def test_build_home_payload_tolerates_dict_album_entries_for_bootstrap_compatibility_without_default_root_gallery(app):
    st = app.library_state
    st["albums"] = [
        {
            "key": "dict-album-1",
            "name": "Dictionary Album",
            "album_artist": "Broadcast",
            "artists": ["Broadcast"],
            "year": 2000,
            "album_rating": 7,
            "tracks": [],
        }
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {"Broadcast": "Broadcast"},
        "canonical_to_aliases": {"Broadcast": ["Broadcast"]},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["surface"]["active"] == "home"
    assert payload["artist_count"] == 1
    assert payload["album_count"] == 1
    assert payload["artist_groups"] == []
    assert payload["primary_artist_groups"] == []
    assert payload["family_artist_groups"] == []
    assert payload["all_artists_active"] is False


def test_build_home_payload_keeps_sidebar_compilation_grouping_without_reusing_root_gallery_groups(app):
    st = app.library_state
    st["albums"] = [
        {
            "key": "dict-compilation-1",
            "name": "Shared Dictionary Album",
            "album_artist": "Neal Morse & Mike Portnoy",
            "artists": ["Neal Morse", "Mike Portnoy"],
            "is_compilation": True,
            "year": 2000,
            "album_rating": 7,
            "tracks": [],
        }
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Mike Portnoy": "Mike Portnoy",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse"],
            "Mike Portnoy": ["Mike Portnoy"],
        },
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["surface"]["active"] == "home"
    assert payload["artist_count"] == 1
    assert payload["album_count"] == 1
    assert payload["artist_groups"] == []
    assert payload["primary_artist_groups"] == []
    assert payload["family_artist_groups"] == []


def test_build_home_payload_adds_recent_local_album_rows_from_listen_history_read_seam(app, monkeypatch):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "recent-local-1",
                "path": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "track_ref": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "title": "Ashes in the Snow",
                "artist": "Mono",
                "album": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "started_at": (now - timedelta(minutes=15)).isoformat(),
                "ended_at": (now - timedelta(minutes=11)).isoformat(),
                "recorded_at": (now - timedelta(minutes=10)).isoformat(),
                "total_listened_seconds": 240,
                "max_contiguous_seconds": 240,
                "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
            },
            {
                "id": "recent-local-2",
                "path": r"C:\Music\Mono\Hymn to the Immortal Wind\02 Burial at Sea.flac",
                "track_ref": r"C:\Music\Mono\Hymn to the Immortal Wind\02 Burial at Sea.flac",
                "title": "Burial at Sea",
                "artist": "Mono",
                "album": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "started_at": (now - timedelta(minutes=9)).isoformat(),
                "ended_at": (now - timedelta(minutes=4)).isoformat(),
                "recorded_at": (now - timedelta(minutes=3)).isoformat(),
                "total_listened_seconds": 300,
                "max_contiguous_seconds": 300,
                "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
            },
            {
                "id": "old-local-1",
                "path": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "track_ref": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "title": "Ashes in the Snow",
                "artist": "Mono",
                "album": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "started_at": (now - timedelta(days=8)).isoformat(),
                "ended_at": (now - timedelta(days=8, minutes=-4)).isoformat(),
                "recorded_at": (now - timedelta(days=8, minutes=-5)).isoformat(),
                "total_listened_seconds": 240,
                "max_contiguous_seconds": 240,
                "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
            },
        ],
    )

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-24",
            edition="",
            album_rating=0,
            total_duration_seconds=540,
            tracks=[
                SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac"),
                SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\02 Burial at Sea.flac"),
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {"Mono": "Mono"},
        "canonical_to_aliases": {"Mono": ["Mono"]},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["recent_not_local_albums"] == []
    assert payload["recent_local_albums"] == [
        {
            "row_kind": "local_album",
            "local_match_state": "matched_local",
            "album_ref": "mono-1",
            "name": "Hymn to the Immortal Wind",
            "album_artist": "Mono",
            "listened_track_count": 2,
            "album_track_count": 2,
            "listened_duration_seconds": 540.0,
            "album_duration_seconds": 540,
            "completion_state": "full",
            "sitting_state": "one_sitting",
            "last_listened_at": (now - timedelta(minutes=3)).isoformat(),
            "allowed_actions": {
                "can_open_album": True,
                "can_play_album": True,
            },
        },
    ]


def test_build_home_payload_counts_identity_matched_imported_local_album_tracks(app, monkeypatch):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "imported-local-1",
                "title": "Ashes in the Snow",
                "artist": "Mono",
                "album": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "started_at": (now - timedelta(minutes=15)).isoformat(),
                "ended_at": (now - timedelta(minutes=11)).isoformat(),
                "recorded_at": (now - timedelta(minutes=10)).isoformat(),
                "total_listened_seconds": 240,
                "max_contiguous_seconds": 240,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            },
        ],
    )

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-24",
            edition="",
            album_rating=0,
            total_duration_seconds=540,
            tracks=[
                SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac"),
                SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\02 Burial at Sea.flac"),
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {"Mono": "Mono"},
        "canonical_to_aliases": {"Mono": ["Mono"]},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["recent_not_local_albums"] == []
    assert payload["recent_local_albums"][0]["album_ref"] == "mono-1"
    assert payload["recent_local_albums"][0]["listened_track_count"] == 1
    assert payload["recent_local_albums"][0]["completion_state"] == "partial"


def test_build_home_payload_recent_fallback_uses_shared_artist_identity_without_accepting_collaborations(
    app,
    monkeypatch,
):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "punctuation-equivalent",
                "title": "Track One",
                "artist": "Morse Portnoy George",
                "album": "Cover To Cover",
                "album_artist": "Morse Portnoy George",
                "recorded_at": (now - timedelta(minutes=5)).isoformat(),
                "total_listened_seconds": 180,
                "max_contiguous_seconds": 180,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            },
            {
                "id": "collaboration",
                "title": "Track Two",
                "artist": "Morse Portnoy George & Guest",
                "album": "Cover To Cover",
                "album_artist": "Morse Portnoy George & Guest",
                "recorded_at": (now - timedelta(minutes=6)).isoformat(),
                "total_listened_seconds": 180,
                "max_contiguous_seconds": 180,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            },
            {
                "id": "unrelated",
                "title": "Track Three",
                "artist": "Unrelated Artist",
                "album": "Cover To Cover",
                "album_artist": "Unrelated Artist",
                "recorded_at": (now - timedelta(minutes=7)).isoformat(),
                "total_listened_seconds": 180,
                "max_contiguous_seconds": 180,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            },
        ],
    )

    app.library_state["albums"] = [
        SimpleNamespace(
            key="cover-to-cover-2006",
            name="Cover To Cover",
            album_artist="Morse, Portnoy & George",
            artists=["Morse, Portnoy & George"],
            cover_path=None,
            year=2006,
            edition="",
            album_rating=0,
            total_duration_seconds=540,
            tracks=[SimpleNamespace(path=r"C:\Music\MPG\Cover To Cover\01 Track One.flac")],
            is_compilation=False,
        ),
    ]
    app.library_state["file_cache"] = {}
    app.library_state["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert [row["album_ref"] for row in payload["recent_local_albums"]] == [
        "cover-to-cover-2006"
    ]
    assert {
        row["album_artist"] for row in payload["recent_not_local_albums"]
    } == {
        "Morse Portnoy George & Guest",
        "Unrelated Artist",
    }


def test_build_home_payload_recent_fallback_keeps_shared_identity_ambiguity_unmatched(
    app,
    monkeypatch,
):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "ambiguous-equivalent",
                "title": "Track One",
                "artist": "Morse Portnoy George",
                "album": "Cover To Cover",
                "album_artist": "Morse Portnoy George",
                "recorded_at": (now - timedelta(minutes=5)).isoformat(),
                "total_listened_seconds": 180,
                "max_contiguous_seconds": 180,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            }
        ],
    )

    def local_album(key, artist):
        return SimpleNamespace(
            key=key,
            name="Cover To Cover",
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=2006,
            edition="",
            album_rating=0,
            total_duration_seconds=540,
            tracks=[SimpleNamespace(path=fr"C:\Music\{key}\01 Track One.flac")],
            is_compilation=False,
        )

    app.library_state["albums"] = [
        local_album("punctuated-credit", "Morse, Portnoy & George"),
        local_album("plain-credit", "Morse Portnoy George"),
    ]
    app.library_state["file_cache"] = {}
    app.library_state["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["recent_local_albums"] == []
    assert [row["album_artist"] for row in payload["recent_not_local_albums"]] == [
        "Morse Portnoy George"
    ]


def test_build_home_payload_keeps_unmatched_external_recent_rows_separate_and_completion_nullable(app, monkeypatch):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "external-1",
                "title": "Remote Song",
                "artist": "Stereolab",
                "album": "Transient Random-Noise Bursts With Announcements",
                "album_artist": "Stereolab",
                "started_at": (now - timedelta(hours=2)).isoformat(),
                "ended_at": (now - timedelta(hours=1, minutes=56)).isoformat(),
                "recorded_at": (now - timedelta(hours=1, minutes=55)).isoformat(),
                "total_listened_seconds": 245,
                "max_contiguous_seconds": 245,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
                "canonical_match": {
                    "library_track_id": "",
                    "canonical_track_id": "",
                    "canonical_release_id": "",
                },
                "remote_cover_url": "https://images.example/stereolab-full.jpg",
                "remote_cover_thumbnail_url": "https://images.example/stereolab-thumb.jpg",
            },
        ],
    )

    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, query_args=_query_args_from_url("/"))

    assert payload["recent_local_albums"] == []
    assert payload["recent_not_local_albums"] == [
        {
            "row_kind": "external_album",
            "local_match_state": "not_local",
            "name": "Transient Random-Noise Bursts With Announcements",
            "album_artist": "Stereolab",
            "listened_track_count": 1,
            "album_track_count": None,
            "listened_duration_seconds": 245.0,
            "album_duration_seconds": None,
            "completion_state": None,
            "sitting_state": "one_sitting",
            "last_listened_at": (now - timedelta(hours=1, minutes=55)).isoformat(),
            "remote_cover_url": "https://images.example/stereolab-full.jpg",
            "remote_cover_thumbnail_url": "https://images.example/stereolab-thumb.jpg",
            "allowed_actions": {
                "can_open_album": False,
                "can_play_album": False,
            },
        },
    ]


def test_build_home_payload_public_safe_omits_private_recent_listen_rows(app, monkeypatch):
    now = datetime.now(timezone.utc)
    _use_listen_history_read_seam(
        monkeypatch,
        [
            {
                "id": "recent-local-public-safe",
                "path": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "track_ref": r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac",
                "title": "Ashes in the Snow",
                "artist": "Mono",
                "album": "Hymn to the Immortal Wind",
                "album_artist": "Mono",
                "started_at": (now - timedelta(minutes=15)).isoformat(),
                "ended_at": (now - timedelta(minutes=11)).isoformat(),
                "recorded_at": (now - timedelta(minutes=10)).isoformat(),
                "total_listened_seconds": 240,
                "max_contiguous_seconds": 240,
                "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
            },
            {
                "id": "recent-external-public-safe",
                "title": "Remote Song",
                "artist": "Stereolab",
                "album": "Transient Random-Noise Bursts With Announcements",
                "album_artist": "Stereolab",
                "started_at": (now - timedelta(hours=2)).isoformat(),
                "ended_at": (now - timedelta(hours=1, minutes=56)).isoformat(),
                "recorded_at": (now - timedelta(hours=1, minutes=55)).isoformat(),
                "total_listened_seconds": 245,
                "max_contiguous_seconds": 245,
                "source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
            },
        ],
    )

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=540,
            tracks=[
                SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac"),
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {"Mono": "Mono"},
        "canonical_to_aliases": {"Mono": ["Mono"]},
        "folder_related": {},
    }

    payload = build_home_payload(app=app, public_safe=True, query_args=_query_args_from_url("/"))

    assert payload["surface"]["active"] == "home"
    assert payload["recent_local_albums"] == []
    assert payload["recent_not_local_albums"] == []


def test_build_view_payload_service_carries_people_query_shell_state(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            '/view-data?q=persons:"Mike Portnoy, Neal Morse"'
        ),
    )

    assert payload["search_context"]["advanced_search"] == {
        "shell_kind": "generic_search_page",
        "supports_page_shell": True,
        "structured_terms": {
            "persons": ["Mike Portnoy", "Neal Morse"],
        },
        "persons_match_mode": "all_of",
        "persons_result_scope": "local_library_only",
    }


def test_build_view_payload_service_projects_album_note_overlay_and_shared_note_summaries_for_selected_artist(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
            is_compilation=False,
            album_note={
                "album_ref": " mono-1 ",
                "note_ref": "note-1",
                "is_present": True,
                "visibility": "private",
                "body": "A private note",
                "updated_at": "2026-06-16T11:00:00Z",
                "revision_count": "2",
                "reply_summary": {
                    "reply_count": "1",
                    "latest_reply_at": "2026-06-16T12:00:00Z",
                },
                "allowed_actions": {
                    "can_edit": True,
                    "can_view_history": True,
                },
            },
            visible_album_notes=[
                {
                    "note_ref": "note-2",
                    "album_ref": None,
                    "visibility": "server_shared",
                    "body_preview": "Shared note preview",
                    "updated_at": "2026-06-16T13:00:00Z",
                    "author_summary": {
                        "author_ref": "user-2",
                        "display_name": "Alice",
                    },
                    "reply_summary": {
                        "reply_count": "3",
                        "latest_reply_at": "2026-06-16T14:00:00Z",
                    },
                    "allowed_actions": {
                        "can_reply": True,
                    },
                },
            ],
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Mono&page_mode=info&family_display=chronological&timeline_at=2009-03-24"
    ))

    album_payload = payload["artist_groups"][0]["albums"][0]

    assert album_payload["album_ref"] == "mono-1"
    assert album_payload["album_note"] == {
        "album_ref": "mono-1",
        "note_ref": "note-1",
        "is_present": True,
        "visibility": "private",
        "body": "A private note",
        "updated_at": "2026-06-16T11:00:00Z",
        "revision_count": 2,
        "reply_summary": {
            "reply_count": 1,
            "latest_reply_at": "2026-06-16T12:00:00Z",
        },
        "allowed_actions": {
            "can_create": False,
            "can_edit": True,
            "can_delete": False,
            "can_share": False,
            "can_view_history": True,
            "can_reply": False,
        },
    }
    assert album_payload["visible_album_notes"] == [
        {
            "note_ref": "note-2",
            "album_ref": "mono-1",
            "visibility": "server_shared",
            "body_preview": "Shared note preview",
            "updated_at": "2026-06-16T13:00:00Z",
            "author_summary": {
                "author_ref": "user-2",
                "display_name": "Alice",
            },
            "reply_summary": {
                "reply_count": 3,
                "latest_reply_at": "2026-06-16T14:00:00Z",
            },
            "allowed_actions": {
                "can_create": False,
                "can_edit": False,
                "can_delete": False,
                "can_share": False,
                "can_view_history": False,
                "can_reply": True,
            },
        },
    ]


def test_build_view_payload_service_keeps_root_artist_groups_lean_without_album_note_seams(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
            is_compilation=False,
            album_note={
                "album_ref": "mono-1",
                "note_ref": "note-1",
                "is_present": True,
                "body": "A private note",
            },
            visible_album_notes=[
                {
                    "note_ref": "note-2",
                    "body_preview": "Shared note preview",
                },
            ],
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    album_payload = payload["artist_groups"][0]["albums"][0]

    assert album_payload["album_ref"] == "mono-1"
    assert "album_note" not in album_payload
    assert "visible_album_notes" not in album_payload
    assert "album_display_metadata" not in album_payload


def test_build_view_payload_service_rehydrates_selected_artist_album_note_seams_after_root_cache_prime(app):
    st = app.library_state
    album = SimpleNamespace(
        key="mono-1",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        cover_path=None,
        year=2009,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
        is_compilation=False,
        album_note={
            "album_ref": "mono-1",
            "note_ref": "note-1",
            "is_present": True,
            "body": "A private note",
        },
        visible_album_notes=[
            {
                "note_ref": "note-2",
                "body_preview": "Shared note preview",
            },
        ],
    )
    st["albums"] = [album]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Mono&page_mode=info&family_display=chronological&timeline_at=2009-03-24"
    ))

    album_payload = payload["artist_groups"][0]["albums"][0]

    assert album_payload["album_ref"] == "mono-1"
    assert album_payload["album_note"]["note_ref"] == "note-1"
    assert album_payload["visible_album_notes"][0]["note_ref"] == "note-2"


def test_build_view_payload_service_refreshes_selected_artist_album_note_seams_after_note_change(app):
    st = app.library_state
    album = SimpleNamespace(
        key="mono-1",
        name="Hymn to the Immortal Wind",
        album_artist="Mono",
        artists=["Mono"],
        cover_path=None,
        year=2009,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
        is_compilation=False,
        album_note={
            "album_ref": "mono-1",
            "note_ref": "note-1",
            "is_present": True,
            "body": "First note",
        },
        visible_album_notes=[
            {
                "note_ref": "note-2",
                "body_preview": "First shared note",
            },
        ],
    )
    st["albums"] = [album]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    first_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    album.album_note = {
        "album_ref": "mono-1",
        "note_ref": "note-1",
        "is_present": True,
        "body": "Updated note",
    }
    album.visible_album_notes = [
        {
            "note_ref": "note-2",
            "body_preview": "Updated shared note",
        },
    ]

    second_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    first_album_payload = first_payload["artist_groups"][0]["albums"][0]
    second_album_payload = second_payload["artist_groups"][0]["albums"][0]

    assert first_album_payload["album_note"]["body"] == "First note"
    assert first_album_payload["visible_album_notes"][0]["body_preview"] == "First shared note"
    assert second_album_payload["album_note"]["body"] == "Updated note"
    assert second_album_payload["visible_album_notes"][0]["body_preview"] == "Updated shared note"


def test_build_view_payload_service_keeps_public_safe_query_selected_cache_free_of_album_notes(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=r"C:\Music\Mono\Hymn to the Immortal Wind\01 Ashes in the Snow.flac")],
            is_compilation=False,
            album_note={
                "album_ref": "mono-1",
                "note_ref": "note-1",
                "is_present": True,
                "body": "A private note",
            },
            visible_album_notes=[
                {
                    "note_ref": "note-2",
                    "body_preview": "Shared note preview",
                },
            ],
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    build_view_payload(app=app, public_safe=True, query_args=_query_args_from_url("/view-data?q=mono&artist=Mono"))

    payload = build_view_payload(app=app, public_safe=True, query_args=_query_args_from_url("/view-data?q=mono&artist=Mono"))

    album_payload = payload["artist_groups"][0]["albums"][0]

    assert "album_note" not in album_payload
    assert "visible_album_notes" not in album_payload
    assert album_payload["album_preference"]["rating"] is None


def test_build_view_payload_service_hides_artist_popularity_when_crowd_opinion_is_disabled(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": False,
        "show_friends_opinions": True,
    }
    st["artist_popularity_overlays"] = {
        "Mono": {
            "scrobble_count": 2500,
            "listener_count": 725,
            "available_sort_metrics": ["scrobbles", "listeners"],
            "freshness_state": "fresh",
        },
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["artist_page"]["artist_popularity"] == {
        "is_visible": False,
        "scrobble_count": None,
        "listener_count": None,
        "available_sort_metrics": [],
        "freshness_state": "missing",
        "read_seam": {
            "source_kind": "lastfm_popularity_snapshot",
            "visibility_scope": "viewer_scoped_with_crowd_preference",
            "read_mode": "cache_first",
            "request_fetch_policy": "never",
            "background_refresh_policy": "scan_follow_up_or_stale_background",
        },
    }


def test_build_view_payload_root_cache_respects_viewer_opinion_preference_changes(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            crowd_opinion={
                "blended_score_10": 8.4,
                "display_stars": 4.2,
                "source_count_used": 2,
                "source_count_total": 3,
                "freshness_state": "fresh",
            },
            friends_opinion={
                "average_rating": 7.5,
                "rating_count": 2,
                "freshness_state": "fresh",
            },
            album_popularity={
                "scrobble_count": 654,
                "listener_count": 210,
                "matched_track_count": 1,
                "total_track_count": 1,
                "available_sort_metrics": ["scrobbles", "listeners"],
                "freshness_state": "fresh",
            },
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    visible_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": False,
        "show_friends_opinions": False,
    }

    hidden_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    visible_album = visible_payload["artist_groups"][0]["albums"][0]
    hidden_album = hidden_payload["artist_groups"][0]["albums"][0]
    assert visible_album["gallery_list_block"]["summary"]["crowd_opinion"]["is_visible"] is True
    assert visible_album["gallery_list_block"]["summary"]["friends_opinion"]["is_visible"] is True
    assert visible_album["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is True
    assert hidden_album["gallery_list_block"]["summary"]["crowd_opinion"]["is_visible"] is False
    assert hidden_album["gallery_list_block"]["summary"]["friends_opinion"]["is_visible"] is False
    assert hidden_album["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is False
    assert visible_payload["popularity_browse"]["is_visible"] is True
    assert visible_payload["popularity_browse"]["surfaces"][0]["surface_id"] == "popular_albums"
    assert hidden_payload["popularity_browse"]["is_visible"] is False


def test_build_view_payload_query_selected_artist_cache_respects_viewer_opinion_preference_changes(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            crowd_opinion={
                "blended_score_10": 8.4,
                "display_stars": 4.2,
                "source_count_used": 2,
                "source_count_total": 3,
                "freshness_state": "fresh",
            },
            friends_opinion={
                "average_rating": 7.5,
                "rating_count": 2,
                "freshness_state": "fresh",
            },
            album_popularity={
                "scrobble_count": 654,
                "listener_count": 210,
                "matched_track_count": 1,
                "total_track_count": 1,
                "available_sort_metrics": ["scrobbles", "listeners"],
                "freshness_state": "fresh",
            },
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    visible_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=mono&artist=Mono"))

    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": False,
        "show_friends_opinions": False,
    }

    hidden_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=mono&artist=Mono"))

    visible_album = visible_payload["artist_groups"][0]["albums"][0]
    hidden_album = hidden_payload["artist_groups"][0]["albums"][0]
    assert visible_album["gallery_list_block"]["summary"]["crowd_opinion"]["is_visible"] is True
    assert visible_album["gallery_list_block"]["summary"]["friends_opinion"]["is_visible"] is True
    assert visible_album["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is True
    assert hidden_album["gallery_list_block"]["summary"]["crowd_opinion"]["is_visible"] is False
    assert hidden_album["gallery_list_block"]["summary"]["friends_opinion"]["is_visible"] is False
    assert hidden_album["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is False


def test_build_view_payload_service_omits_playback_context_for_remote_only_selected_artist_gallery(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            remote_cover_url="https://images.example/mono-hymn.jpg",
            remote_cover_thumbnail_url="https://images.example/mono-hymn-thumb.jpg",
            remote_cover_source="discogs",
            remote_cover_source_label="Discogs",
            remote_cover_album_url="https://discogs.example/release/mono-hymn",
            remote_cover_width=1200,
            remote_cover_height=1200,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["selected_artist"] == "Mono"
    assert payload["album_count"] == 1
    assert "playback_context" not in payload


def test_build_view_payload_service_exposes_structured_search_filters_in_view_and_search_context(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?q=post-rock&artist=Mono&genre=Post%20Rock&genre=Ambient&mood=Atmospheric"
        "&style=Cinematic&duration_min=180&duration_max=600"
    ))

    assert payload["search_filters"] == {
        "genre": ["Post Rock", "Ambient"],
        "mood": ["Atmospheric"],
        "style": ["Cinematic"],
        "duration": {
            "min_seconds": 180,
            "max_seconds": 600,
        },
    }
    assert payload["search_context"]["search_filters"] == payload["search_filters"]


def test_build_view_payload_service_exposes_resolved_gallery_display_contract(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?artist=Mono&gallery_display=covers&gallery_scale_percent=135"
        ),
    )

    assert payload["gallery_display_mode"] == "covers"
    assert payload["gallery_scale_percent"] == 135


def test_build_view_payload_album_previews_expose_gallery_list_block_summary(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-14",
            edition="",
            album_rating=9,
            total_duration_seconds=305,
            crowd_opinion={
                "blended_score_10": 8.4,
                "display_stars": 4.2,
                "source_count_used": 2,
                "source_count_total": 3,
                "freshness_state": "fresh",
            },
            friends_opinion={
                "average_rating": 7.5,
                "rating_count": 2,
                "freshness_state": "fresh",
            },
            album_popularity={
                "scrobble_count": 654,
                "listener_count": 210,
                "matched_track_count": 1,
                "total_track_count": 1,
                "available_sort_metrics": ["scrobbles", "listeners"],
                "freshness_state": "fresh",
            },
            album_display_metadata={
                "display_country": {
                    "name": "Japan",
                    "code": "jp",
                    "source_kind": "artist",
                },
                "generalized_genre": {
                    "name": "Post-Rock",
                    "slug": "post-rock",
                    "source_kind": "release_group",
                },
                "exact_genres": [
                    {
                        "name": "Post-Rock",
                        "slug": "post-rock",
                        "source_kind": "release_group",
                    },
                    {
                        "name": "Ambient",
                        "slug": "ambient",
                        "source_kind": "artist",
                    },
                ],
                "source_provenance": {
                    "provider": "musicbrainz",
                    "provider_record_kind": "release_group",
                    "provider_record_id": "rg-1",
                    "generalized_genre_algorithm_version": "v1",
                },
                "freshness_state": "fresh",
            },
            tracks=[
                SimpleNamespace(
                    path=r"C:\Music\Mono\Hymn\01 Ashes.flac",
                    title="Ashes in the Snow",
                    track_number=1,
                    disc_number=1,
                    disc_number_raw="1",
                    artist="Mono",
                    album="Hymn to the Immortal Wind",
                    album_artist="Mono",
                    year=2009,
                    release_date="2009-03-14",
                    edition="",
                    album_rating=9,
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
                    duration_seconds=305,
                    track_popularity={
                        "scrobble_count": 321,
                        "listener_count": 111,
                        "loved_count": 8,
                        "match_key": "mono::ashes in the snow",
                        "match_coverage_state": "matched",
                        "metric_availability": {
                            "scrobbles": True,
                            "listeners": True,
                            "loved": True,
                        },
                        "freshness_state": "fresh",
                    },
                    library_root_id=None,
                    library_root_category=None,
                    root_provenance=None,
                ),
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    preview_album = payload["artist_groups"][0]["albums"][0]
    assert preview_album["preview_only"] is True
    assert preview_album["tracks"] == []
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
    assert preview_album["tag_album_rating"] == 9
    assert preview_album["tag_album_rating_source"] == "file_tag"
    assert preview_album["album_display_metadata"] == {
        "display_country": {
            "name": "Japan",
            "code": "JP",
            "source_kind": "artist",
        },
        "generalized_genre": {
            "name": "Post-Rock",
            "slug": "post-rock",
            "source_kind": "release_group",
        },
        "exact_genres": [
            {
                "name": "Post-Rock",
                "slug": "post-rock",
                "source_kind": "release_group",
            },
            {
                "name": "Ambient",
                "slug": "ambient",
                "source_kind": "artist",
            },
        ],
        "source_provenance": {
            "provider": "musicbrainz",
            "provider_record_kind": "release_group",
            "provider_record_id": "rg-1",
            "generalized_genre_algorithm_version": "v1",
        },
        "freshness_state": "fresh",
    }
    assert preview_album["gallery_list_block"] == {
        "block_kind": "album",
        "album_key": "mono-1",
        "summary": {
            "title": "Hymn to the Immortal Wind",
            "album_artist": "Mono",
            "year": 2009,
            "album_rating": 9,
            "album_preference": {
                "rating": None,
                "favorite_override": None,
                "is_favorite": False,
                "favorite_source": None,
                "can_edit": False,
                "to_listen": False,
                "is_relisten": False,
                "can_toggle_to_listen": False,
            },
            "tag_album_rating": 9,
            "tag_album_rating_source": "file_tag",
            "track_count": 1,
            "total_duration_seconds": 305,
            "total_duration_display": "5m 05s",
                "crowd_opinion": {
                    "is_visible": True,
                    "blended_score_10": 8.4,
                    "display_stars": 4.2,
                    "source_count_used": 2,
                    "source_count_total": 3,
                    "freshness_state": "fresh",
                    "read_seam": {
                        "source_kind": "external_album_crowd_opinion_snapshot",
                        "visibility_scope": "viewer_scoped",
                        "read_mode": "cache_first",
                        "request_fetch_policy": "never",
                        "background_refresh_policy": "background_only",
                    },
                },
                "friends_opinion": {
                    "is_visible": True,
                    "average_rating": 7.5,
                    "rating_count": 2,
                    "freshness_state": "fresh",
                    "read_seam": {
                        "source_kind": "same_server_album_rating_projection",
                        "visibility_scope": "same_server_viewer_scoped",
                        "read_mode": "cache_first",
                        "request_fetch_policy": "never",
                        "background_refresh_policy": "projection_refresh",
                    },
                },
                "album_popularity": {
                    "is_visible": True,
                    "scrobble_count": 654,
                    "listener_count": 210,
                    "matched_track_count": 1,
                    "total_track_count": 1,
                    "available_sort_metrics": ["scrobbles", "listeners"],
                    "freshness_state": "fresh",
                    "read_seam": {
                        "source_kind": "lastfm_popularity_snapshot",
                        "visibility_scope": "viewer_scoped_with_crowd_preference",
                        "read_mode": "cache_first",
                        "request_fetch_policy": "never",
                        "background_refresh_policy": "scan_follow_up_or_stale_background",
                    },
                },
            },
        "track_rows_source": "album_details",
        "track_rows": [],
        "trailing_divider": {
            "total_duration_seconds": 305,
            "total_duration_display": "5m 05s",
        },
    }


def test_build_view_payload_service_can_strip_private_album_preference_overlays_for_public_safe_context(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    original_serializer = view_payloads_module.album_preview_to_dict

    def preview_with_private_overlays(album, *, public_safe=False, **kwargs):
        payload = original_serializer(album, public_safe=public_safe, **kwargs)
        if not public_safe:
            payload["album_preference"] = {
                "rating": 10,
                "favorite_override": "on",
                "is_favorite": True,
                "favorite_source": "manual_override",
                "can_edit": True,
                "to_listen": True,
                "is_relisten": True,
                "can_toggle_to_listen": True,
            }
            payload["gallery_list_block"] = {
                **payload["gallery_list_block"],
                "summary": {
                    **payload["gallery_list_block"]["summary"],
                    "album_preference": dict(payload["album_preference"]),
                },
            }
            payload["top_viewer_overlay"] = {
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
            }
        return payload

    monkeypatch.setattr(view_payloads_module, "album_preview_to_dict", preview_with_private_overlays)

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=9,
            total_duration_seconds=305,
            tracks=[
                SimpleNamespace(
                    path=r"C:\Music\Mono\Hymn\01 Ashes.flac",
                    title="Ashes in the Snow",
                    track_number=1,
                    disc_number=1,
                    disc_number_raw="1",
                    artist="Mono",
                    album="Hymn to the Immortal Wind",
                    album_artist="Mono",
                    year=2009,
                    release_date="2009-03-14",
                    edition="",
                    album_rating=9,
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
                    duration_seconds=305,
                    library_root_id=None,
                    library_root_category=None,
                    root_provenance=None,
                ),
            ],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["viewer_opinion_preferences"] = {
        "show_crowd_opinion": True,
        "show_friends_opinions": True,
    }
    st["artist_popularity_overlays"] = {
        "Mono": {
            "scrobble_count": 1200,
            "listener_count": 340,
            "available_sort_metrics": ["scrobbles"],
        },
    }

    private_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))
    public_payload = build_view_payload(app=app, public_safe=True, query_args=_query_args_from_url("/view-data?artist=Mono"))

    private_album = private_payload["artist_groups"][0]["albums"][0]
    public_album = public_payload["artist_groups"][0]["albums"][0]

    assert private_album["album_preference"]["rating"] == 10
    assert private_album["album_preference"]["favorite_override"] == "on"
    assert private_album["gallery_list_block"]["summary"]["album_preference"]["is_favorite"] is True
    assert private_payload["artist_page"]["artist_popularity"]["is_visible"] is True

    assert public_album["album_preference"] == {
        "rating": None,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": False,
        "to_listen": False,
        "is_relisten": False,
        "can_toggle_to_listen": False,
    }
    assert public_album["gallery_list_block"]["summary"]["album_preference"] == public_album["album_preference"]
    assert public_album["gallery_list_block"]["summary"]["crowd_opinion"]["is_visible"] is False
    assert public_album["gallery_list_block"]["summary"]["friends_opinion"]["is_visible"] is False
    assert public_album["gallery_list_block"]["summary"]["album_popularity"]["is_visible"] is False
    assert public_payload["artist_page"]["artist_popularity"]["is_visible"] is False
    assert public_album["tag_album_rating"] == 9
    assert public_album["tag_album_rating_source"] == "file_tag"
    assert public_album["top_viewer_overlay"] == {
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
    assert "playback_context" not in public_payload


def test_build_view_payload_service_exposes_shared_search_filter_contract(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=post-rock"))

    assert payload["search_filter_contract"] == {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "fields": {
            "genre": {
                "param": "genre",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "mood": {
                "param": "mood",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "style": {
                "param": "style",
                "value_type": "string",
                "multi_value": "or",
                "supported_result_kinds": [
                    "artists",
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
            },
            "duration": {
                "min_param": "duration_min",
                "max_param": "duration_max",
                "value_type": "seconds",
                "supported_result_kinds": [
                    "albums",
                    "tracks",
                    "playlist_rows",
                    "album_top_items",
                    "favorite_song_rows",
                ],
                "duration_scope_by_result_kind": {
                    "albums": "album",
                    "tracks": "track",
                    "playlist_rows": "track",
                    "album_top_items": "album",
                    "favorite_song_rows": "track",
                },
            },
        },
    }
    assert payload["search_context"]["committed_query"] == "post-rock"


def test_build_view_payload_service_exposes_shared_search_query_contract(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=post-rock"))

    assert payload["search_query_contract"] == {
        "shared_surfaces": [
            "global_search",
            "playlist_detail",
            "album_tops",
            "favorite_songs",
        ],
        "draft_commit_model": {
            "draft_state_owner": "client",
            "committed_state_owner": "server",
            "commit_triggers": ["debounce", "enter"],
            "debounce_ms": 150,
            "draft_sync_policy": "preserve_local_draft_until_committed_view_catches_up",
            "empty_query_behavior": "restore_root_browse",
            "in_flight_request_policy": "interrupt_previous_search_commit",
        },
        "grammar": {
            "supports_cross_field_and": True,
            "supports_same_field_or": True,
            "supports_negation": True,
            "supports_quoted_values": True,
            "supports_comparison_operators": True,
            "supports_fuzzy_commit_matching": True,
            "shortcut_tokens": [
                {
                    "token": ":loved",
                    "expands_to": {
                        "field": "love",
                        "value": "loved",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":obsessed",
                    "expands_to": {
                        "field": "love",
                        "value": "obsessed",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":returns_to",
                    "expands_to": {
                        "field": "return",
                        "value": "returns_to",
                    },
                    "availability": "authorized_private_track_search",
                },
                {
                    "token": ":not_often",
                    "expands_to": {
                        "field": "replay",
                        "value": "not_often",
                    },
                    "availability": "authorized_private_track_search",
                },
            ],
            "field_terms": {
                "artist": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "availability": "shared",
                },
                "genre": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "mood": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "style": {
                    "value_type": "string",
                    "supports_quotes": True,
                    "supports_fuzzy_commit": True,
                    "supports_structured_suggestions": True,
                    "availability": "shared",
                },
                "duration": {
                    "value_type": "duration_comparison",
                    "supports_structured_suggestions": False,
                    "availability": "shared",
                },
                "love": {
                    "value_type": "enum",
                    "allowed_values": ["loved", "obsessed"],
                    "availability": "authorized_private_track_search",
                },
                "return": {
                    "value_type": "enum",
                    "allowed_values": ["returns_to"],
                    "availability": "authorized_private_track_search",
                },
                "replay": {
                    "value_type": "enum",
                    "allowed_values": ["not_often"],
                    "availability": "authorized_private_track_search",
                },
                "persons": {
                    "value_type": "csv_string",
                    "match_mode": "all_of",
                    "supports_fuzzy_commit": True,
                    "availability": "local_library_only",
                },
            },
        },
        "structured_suggestions": {
            "value_fields": ["genre", "mood", "style"],
            "fuzzy_commit_without_exact_suggestion": True,
        },
        "committed_matching": {
            "priority_order": [
                "exact",
                "alias",
                "phrase",
                "prefix",
                "distributed",
                "fuzzy",
            ],
            "numeric_terms_are_near_exact": True,
        },
    }
    assert payload["search_context"]["committed_query"] == "post-rock"
    assert payload["search_context"]["result_surface"] == {
        "kind": "grouped_artist_results",
        "group_order": ["direct_matches", "related_matches"],
        "default_selection_behavior": "explicit_result_selection",
    }
    assert payload["search_context"]["result_groups"] == {
        "direct_matches": [],
        "related_matches": [],
    }

def test_build_view_payload_selected_artist_can_omit_sidebar_when_client_keeps_existing_tree(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-1",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {"Mono": set()},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono&omit_sidebar=1"))

    assert payload["selected_artist"] == "Mono"
    assert [group["artist"] for group in payload["artist_groups"]] == ["Mono"]
    assert "artists_sidebar" not in payload


def test_build_view_payload_playlist_surface_uses_playlist_sidebar_and_shared_playlist_rows(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Road Trip",
            "description": "Loud night-drive tracks.",
            "visibility": "server_shared",
            "allowed_actions": {
                "can_open": True,
                "can_play": True,
                "can_edit": True,
                "can_rename": True,
                "can_delete": False,
                "can_reorder": True,
            },
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-1",
                    "playlist_position": 1,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
                    "title": "Subdivisions",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "track_number": 1,
                    "disc_number": 1,
                    "disc_number_raw": "1",
                    "duration_seconds": 321,
                    "genre": ["Progressive Rock"],
                    "track_preference_overlay": {
                        "rating": 5,
                        "love_tier": "loved",
                        "allowed_actions": {
                            "can_rate": True,
                            "can_set_love_tier": True,
                        },
                    },
                    "track_scrobble_count": 7,
                },
                {
                    "playlist_item_id": "playlist-item-2",
                    "playlist_position": 2,
                    "album_title": "Grace Under Pressure",
                    "path": r"C:\Music\Rush\Grace Under Pressure\02 - Afterimage.flac",
                    "title": "Afterimage",
                    "artist": "Rush",
                    "album": "Grace Under Pressure",
                    "album_artist": "Rush",
                    "track_number": 2,
                    "disc_number": 1,
                    "disc_number_raw": "1",
                    "duration_seconds": 269,
                    "genre": ["Progressive Rock"],
                    "track_preference_overlay": {
                        "rating": 4,
                        "love_tier": "obsessed",
                        "allowed_actions": {
                            "can_rate": True,
                            "can_set_love_tier": True,
                        },
                    },
                    "track_scrobble_count": 3,
                },
            ],
        },
        {
            "playlist_id": "playlist-2",
            "title": "Sunday Wind Down",
            "visibility": "private",
            "allowed_actions": {
                "can_open": True,
                "can_play": False,
                "can_edit": False,
            },
            "tracks": [],
        },
    ]

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            '/view-data?surface=playlists&playlist_id=playlist-1&q=genre:"Progressive Rock"'
        ),
    )

    assert payload["surface"] == {
        "active": "playlists",
        "default": "home",
        "supported": ["home", "albums", "playlists"],
        "reserved": ["album_tops"],
    }
    assert payload["shell_layout"] == {
        "kind": "shared_media_shell",
        "slots": {
            "app_bar": {
                "content_kind": "global_search_toolbar",
                "header_surfaces": {
                    "shared_badge_primitives": True,
                    "shared_drawer_primitives": True,
                    "notifications": {
                        "entry_kind": "operational_drawer",
                        "badge_kind": "operational_notifications",
                        "drawer_slot": "info_drawer",
                        "default_drawer_content_kind": "cover_lookup_drawer",
                        "supported_drawer_content_kinds": ["cover_lookup_drawer"],
                        "drawer_content_kind": "cover_lookup_drawer",
                        "page_route": None,
                    },
                    "discovery_center": {
                        "entry_kind": "drawer_plus_page",
                        "badge_kind": "discovery_center",
                        "drawer_content_kind": "discovery_center_preview",
                        "page_route": "/news",
                    },
                },
            },
            "navigation_rail": {
                "content_kind": "playlist_sidebar",
                "default_collapsed": True,
            },
            "contextual_pane": {
                "content_kind": "contextual_navigation",
                "is_visible": False,
                "active_pane": "playlists",
                "supported_panes": [
                    "local_tree",
                    "playlists",
                    "album_tops",
                    "artist_gallery",
                ],
                "local_tree": {
                    "default_submode": "folders",
                    "active_submode": "folders",
                    "supported_submodes": [
                        "folders",
                        "artists",
                        "albums",
                        "broad_genres",
                        "subtle_genres",
                    ],
                },
                "splitter": {
                    "desktop_only": True,
                    "axis": "inline",
                    "placement": "left",
                    "state_scope": "local_first",
                    "mobile_fallback": "drawer",
                },
            },
            "main_content": {
                "surface_ref": "playlists",
                "content_kind": "playlist_detail",
            },
            "info_drawer": {
                "component_kind": "notification_drawer",
                "content_kind": "cover_lookup_drawer",
                "default_content_kind": "cover_lookup_drawer",
                "supported_content_kinds": ["cover_lookup_drawer"],
                "surface_family": "notifications",
                "default_surface_family": "notifications",
                "placement": "right",
                "is_optional": True,
                "splitter": {
                    "desktop_only": True,
                    "axis": "inline",
                    "placement": "right",
                    "state_scope": "local_first",
                    "mobile_fallback": "sheet_or_drawer",
                },
            },
            "bottom_player": {
                "content_kind": "global_player",
                "is_persistent": True,
            },
        },
    }
    assert payload["local_tree_submode"] == "folders"
    assert payload["playlist_sidebar"] == {
        "active_playlist_id": "playlist-1",
        "items": [
            {
                "playlist_id": "playlist-1",
                "title": "Road Trip",
                "item_count": 2,
                "is_active": True,
                "allowed_actions": {
                    "can_open": True,
                },
            },
            {
                "playlist_id": "playlist-2",
                "title": "Sunday Wind Down",
                "item_count": 0,
                "is_active": False,
                "allowed_actions": {
                    "can_open": True,
                },
            },
        ],
    }
    assert payload["playlist_detail"]["playlist_id"] == "playlist-1"
    assert payload["playlist_detail"]["title"] == "Road Trip"
    assert payload["playlist_detail"]["visibility"] == "server_shared"
    assert payload["playlist_detail"]["query"] == 'genre:"Progressive Rock"'
    assert payload["playlist_detail"]["active_sort"] == {
        "key": "playlist_position",
        "direction": "asc",
    }
    assert payload["playlist_detail"]["saved_default_sort"] == {
        "key": "playlist_position",
        "direction": "asc",
    }
    assert payload["playlist_detail"]["allowed_actions"] == {
        "can_play": True,
        "can_edit": True,
        "can_rename": True,
        "can_delete": False,
        "can_reorder": True,
    }
    assert payload["playlist_detail"]["unsupported_filters"] == []
    assert [row["playlist_item_id"] for row in payload["playlist_detail"]["track_rows"]] == [
        "playlist-item-1",
        "playlist-item-2",
    ]
    assert payload["playlist_detail"]["track_rows"][0]["track_preference"]["love_tier"] == "loved"
    assert payload["playlist_detail"]["track_rows"][0]["track_stats"]["scrobble_count"] == 7
    assert "artists_sidebar" not in payload
    assert "artist_groups" not in payload
    assert "primary_artist_groups" not in payload
    assert "family_artist_groups" not in payload
    assert "related_artists" not in payload
    assert "artist_family_filters" not in payload
    assert "show_all_artists_sidebar_link" not in payload
    assert "artist_page" not in payload


def test_build_view_payload_service_exposes_local_tree_submode_without_changing_surface(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?surface=albums&tree_mode=subtle_genres"))

    assert payload["surface"]["active"] == "albums"
    assert payload["local_tree_submode"] == "subtle_genres"
    assert payload["shell_layout"]["slots"]["contextual_pane"]["active_pane"] == "local_tree"
    assert (
        payload["shell_layout"]["slots"]["contextual_pane"]["local_tree"]["active_submode"]
        == "subtle_genres"
    )


def test_build_view_payload_playlist_surface_filters_index_by_playlist_name(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Road Trip",
            "visibility": "server_shared",
            "allowed_actions": {
                "can_open": True,
                "can_play": True,
                "can_edit": True,
            },
            "tracks": [],
        },
        {
            "playlist_id": "playlist-2",
            "title": "Sunday Wind Down",
            "visibility": "private",
            "allowed_actions": {
                "can_open": True,
                "can_play": False,
                "can_edit": False,
            },
            "tracks": [],
        },
    ]

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?surface=playlists&q=wind"))

    assert payload["surface"]["active"] == "playlists"
    assert payload["playlist_sidebar"]["active_playlist_id"] == ""
    assert payload["playlist_index"] == {
        "query": "wind",
        "playlists": [
            {
                "playlist_id": "playlist-2",
                "title": "Sunday Wind Down",
                "description": "",
                "visibility": "private",
                "item_count": 0,
                "allowed_actions": {
                    "can_open": True,
                    "can_play": False,
                    "can_edit": False,
                },
            },
        ],
    }
    assert "playlist_detail" not in payload
    assert "artists_sidebar" not in payload
    assert "artist_groups" not in payload
    assert "primary_artist_groups" not in payload
    assert "family_artist_groups" not in payload
    assert "related_artists" not in payload
    assert "artist_family_filters" not in payload
    assert "show_all_artists_sidebar_link" not in payload


def test_build_view_payload_playlist_surface_keeps_index_shell_for_unknown_playlist_id(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Road Trip",
            "visibility": "server_shared",
            "tracks": [],
        },
    ]

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?surface=playlists&playlist_id=missing"))

    assert payload["shell_layout"]["slots"]["main_content"] == {
        "surface_ref": "playlists",
        "content_kind": "playlist_index",
    }
    assert payload["playlist_sidebar"]["active_playlist_id"] == "missing"
    assert "playlist_detail" not in payload
    assert "playlist_index" in payload


def test_build_view_payload_playlist_surface_strips_private_track_preferences_for_public_safe_context(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Shared Mix",
            "visibility": "server_shared",
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-1",
                    "playlist_position": 1,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
                    "title": "Subdivisions",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "duration_seconds": 321,
                    "track_preference_overlay": {
                        "rating": 5,
                        "love_tier": "obsessed",
                        "allowed_actions": {
                            "can_rate": True,
                            "can_set_love_tier": True,
                        },
                    },
                },
            ],
        },
    ]

    payload = build_view_payload(
        app=app,
        public_safe=True,
        query_args=_query_args_from_url(
            "/view-data?surface=playlists&playlist_id=playlist-1"
        ),
    )

    row = payload["playlist_detail"]["track_rows"][0]
    assert row["track_preference"] == {
        "rating": None,
        "love_tier": "off",
        "allowed_actions": {
            "client_surface_class": "private_web",
            "can_rate": False,
            "can_set_love_tier": False,
        },
    }
    assert row["can_edit_preferences"] is False
    assert "track_ref" not in row
    assert "path" not in row
    assert row["track_stats"] == {"scrobble_count": None}
    assert row["playback_state"] is None


def test_build_view_payload_playlist_surface_keeps_detail_filtering_scoped_to_query_and_shared_track_facets(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Road Trip",
            "visibility": "server_shared",
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-1",
                    "playlist_position": 1,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\01 - Subdivisions.flac",
                    "title": "Subdivisions",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "duration_seconds": 280,
                    "genre": ["Progressive Rock"],
                    "mood": ["Reflective"],
                    "style": ["Synth Rock"],
                },
                {
                    "playlist_item_id": "playlist-item-2",
                    "playlist_position": 2,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\02 - The Analog Kid.flac",
                    "title": "The Analog Kid",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "duration_seconds": 288,
                    "genre": ["Progressive Rock"],
                    "mood": ["Reflective"],
                    "style": ["Synth Rock"],
                },
                {
                    "playlist_item_id": "playlist-item-3",
                    "playlist_position": 3,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\03 - Chemistry.flac",
                    "title": "Subdivisions",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "duration_seconds": 412,
                    "genre": ["Progressive Rock"],
                    "mood": ["Urgent"],
                    "style": ["Hard Rock"],
                },
            ],
        },
        {
            "playlist_id": "playlist-2",
            "title": "Outside Scope",
            "visibility": "private",
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-4",
                    "playlist_position": 1,
                    "album_title": "Signals",
                    "path": r"C:\Music\Rush\Signals\04 - Digital Man.flac",
                    "title": "Subdivisions",
                    "artist": "Rush",
                    "album": "Signals",
                    "album_artist": "Rush",
                    "duration_seconds": 280,
                    "genre": ["Progressive Rock"],
                    "mood": ["Reflective"],
                    "style": ["Synth Rock"],
                },
            ],
        },
    ]

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?surface=playlists"
        "&playlist_id=playlist-1"
        '&q=title:Subdivisions artist:"Rush" album:Signals'
        "&genre=Progressive+Rock"
        "&mood=Reflective"
        "&style=Synth+Rock"
        "&duration_min=240"
        "&duration_max=300"
    ))

    assert payload["search_filters"] == {
        "genre": ["Progressive Rock"],
        "mood": ["Reflective"],
        "style": ["Synth Rock"],
        "duration": {
            "min_seconds": 240,
            "max_seconds": 300,
        },
    }
    assert payload["search_filter_contract"]["shared_surfaces"] == [
        "global_search",
        "playlist_detail",
        "album_tops",
        "favorite_songs",
    ]
    assert [row["playlist_item_id"] for row in payload["playlist_detail"]["track_rows"]] == [
        "playlist-item-1",
    ]
    assert payload["playlist_detail"]["query"] == 'title:Subdivisions artist:"Rush" album:Signals'
    assert payload["playlist_detail"]["unsupported_filters"] == []


def test_build_view_payload_playlist_surface_escapes_backslash_quote_filter_values(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Escaped Filters",
            "visibility": "server_shared",
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-1",
                    "playlist_position": 1,
                    "album_title": "Quoted Path",
                    "path": r"C:\Music\Quoted\01.flac",
                    "title": "Escaped Match",
                    "artist": "Example",
                    "album": "Quoted Path",
                    "album_artist": "Example",
                    "duration_seconds": 200,
                    "genre": [r'Prog \"Rock'],
                },
            ],
        },
    ]

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        r"/view-data?surface=playlists&playlist_id=playlist-1&genre=Prog%20%5C%22Rock"
    ))

    assert [row["playlist_item_id"] for row in payload["playlist_detail"]["track_rows"]] == [
        "playlist-item-1",
    ]
    assert payload["playlist_detail"]["unsupported_filters"] == []


def test_build_view_payload_playlist_surface_fails_closed_for_malformed_track_query(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    st["playlists"] = [
        {
            "playlist_id": "playlist-1",
            "title": "Malformed Query",
            "visibility": "server_shared",
            "tracks": [
                {
                    "playlist_item_id": "playlist-item-1",
                    "playlist_position": 1,
                    "album_title": "Quoted Path",
                    "path": r"C:\Music\Quoted\01.flac",
                    "title": "Quoted Match",
                    "artist": "Example",
                    "album": "Quoted Path",
                    "album_artist": "Example",
                    "duration_seconds": 200,
                },
            ],
        },
    ]

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?surface=playlists&playlist_id=playlist-1&q=%22"
        ),
    )

    assert payload["playlist_detail"]["track_rows"] == []
    assert payload["playlist_detail"]["unsupported_filters"] == [
        {
            "token": '"',
            "field": "",
            "value": "",
            "reason": "invalid_filter",
        },
    ]


def test_build_view_payload_service_merges_punctuation_variant_gallery_groups_with_combined_header(app):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mpg-0",
            name="Cover to Cover",
            album_artist="Morse, Portnoy & George",
            artists=["Neal Morse", "Mike Portnoy", "Randy George"],
            cover_path=None,
            year=2006,
            release_date="2006-09-01",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="mpg-1",
            name="Cover 2 Cover",
            album_artist="Morse Portnoy George",
            artists=["Neal Morse", "Mike Portnoy", "Randy George"],
            cover_path=None,
            year=2012,
            release_date="2012-09-11",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="mpg-2",
            name="Songs from November",
            album_artist="Morse, Portnoy & George",
            artists=["Neal Morse", "Mike Portnoy", "Randy George"],
            cover_path=None,
            year=2024,
            release_date="2024-08-16",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert [group["artist"] for group in payload["artist_groups"]] == ["Morse Portnoy George"]
    assert payload["artist_groups"][0]["artist_display"] == "Morse Portnoy George / Morse, Portnoy & George"
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Cover to Cover",
        "Cover 2 Cover",
        "Songs from November",
    ]


def test_build_view_payload_service_exposes_root_provenance_and_filters_visible_categories(app, monkeypatch):
    arrivals_root = (Path(app.config["DATA_DIR"]) / "arrivals").resolve()
    hoard_root = (Path(app.config["DATA_DIR"]) / "hoard").resolve()
    main_root = (Path(app.config["DATA_DIR"]) / "library").resolve()
    arrival_track = arrivals_root / "Broadcast" / "Arrival Album" / "01 - Come on Let's Go.mp3"
    arrival_track.parent.mkdir(parents=True, exist_ok=True)
    arrival_track.write_bytes(b"track")

    _use_library_root_settings_read_seam(
        app,
        monkeypatch,
        {
            "main_library_roots": [{"id": "main-1", "path": str(main_root), "layout_mode": "artist"}],
            "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
            "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
            "move_policy": {
                "preferred_main_write_root": "main-1",
                "move_new_arrivals_to": "hoard-1",
            },
        },
    )
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="main-1",
            name="Main Album",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2000,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            library_root_id="main-1",
            library_root_category="main_library",
            root_provenance={
                "root_ids": ["main-1"],
                "categories": ["main_library"],
                "category_labels": ["Main Library"],
                "primary_category": "main_library",
                "primary_category_label": "Main Library",
                "badges": [],
                "is_mixed": False,
            },
        ),
        SimpleNamespace(
            key="arrivals-1",
            name="Arrival Album",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2001,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(
                path=str(arrival_track),
                title="Come on Let's Go",
                track_number=1,
                disc_number=1,
                disc_number_raw="1",
                artist="Broadcast",
                album="Arrival Album",
                album_artist="Broadcast",
                year=2001,
                edition="",
                album_rating=0,
                exception_type=None,
                cover_path=None,
                duration_seconds=181,
            )],
            is_compilation=False,
            library_root_id="arrivals-1",
            library_root_category="new_arrivals",
            root_provenance={
                "root_ids": ["arrivals-1"],
                "categories": ["new_arrivals"],
                "category_labels": ["New Arrivals"],
                "primary_category": "new_arrivals",
                "primary_category_label": "New Arrivals",
                "badges": ["New"],
                "is_mixed": False,
            },
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?category=new_arrivals"))

    assert payload["gallery_scope"] == "all"
    assert payload["visible_library_categories"] == ["new_arrivals"]
    assert payload["album_count"] == 1
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast"]
    filtered_album = payload["artist_groups"][0]["albums"][0]
    assert filtered_album["name"] == "Arrival Album"
    assert filtered_album["root_provenance"]["primary_category"] == "new_arrivals"
    assert filtered_album["root_provenance"]["badges"] == ["New"]
    assert filtered_album["move_availability"]["can_move"] is True
    assert filtered_album["move_availability"]["available_actions"] == ["move_to_hoard", "move_to_library"]


def test_build_view_payload_service_filters_non_album_entries_by_visible_categories(app):
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {
        "main-track.mp3": {
            "path": "main-track.mp3",
            "album": "Non-Album",
            "artist": "Broadcast",
            "album_artist": "Broadcast",
            "title": "Main Track",
            "cover_path": None,
            "exception_type": "Non-album rarity",
            "library_root_id": "main-1",
            "library_root_category": "main_library",
        },
        "arrivals-track.mp3": {
            "path": "arrivals-track.mp3",
            "album": "Non-Album",
            "artist": "Broadcast",
            "album_artist": "Broadcast",
            "title": "Arrival Track",
            "cover_path": None,
            "exception_type": "Non-album rarity",
            "library_root_id": "arrivals-1",
            "library_root_category": "new_arrivals",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?gallery_scope=new_arrivals"))

    assert payload["gallery_scope"] == "new_arrivals"
    assert payload["visible_library_categories"] == ["new_arrivals"]
    assert "non_album_groups" not in payload
    assert "non_album_loose_tracks" not in payload
    assert [track["title"] for track in payload["non_album_tracks"]] == ["Arrival Track"]
    assert payload["non_album_tracks"][0]["reason_label"] == "Non-album rarity"


def test_build_view_payload_service_keeps_new_arrivals_scope_out_of_primary_and_family_split(app):
    def make_album(key: str, name: str, album_artist: str, year: int, category: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=album_artist,
            artists=[album_artist],
            cover_path=None,
            year=year,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            library_root_id=f"{category}-1",
            library_root_category=category,
            root_provenance={
                "root_ids": [f"{category}-1"],
                "categories": [category],
                "category_labels": [category.replace("_", " ").title()],
                "primary_category": category,
                "primary_category_label": category.replace("_", " ").title(),
                "badges": ["New"] if category == "new_arrivals" else [],
                "is_mixed": False,
            },
        )

    st = app.library_state
    st["albums"] = [
        make_album("arrival-1", "Arrival One", "Broadcast", 2000, "new_arrivals"),
        make_album("arrival-2", "Arrival Two", "Stereolab", 2001, "new_arrivals"),
        make_album("main-1", "Main One", "Broadcast", 1999, "main_library"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?gallery_scope=new_arrivals&artist=Broadcast"
            "&related_artist=Stereolab&primary_filter=1"
        ),
    )

    assert payload["gallery_scope"] == "new_arrivals"
    assert payload["visible_library_categories"] == ["new_arrivals"]
    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is False
    assert payload["primary_artist_groups"] == []
    assert payload["family_artist_groups"] == []
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == ["Arrival One"]


def test_build_view_payload_selected_artist_category_filter_hides_root_invisible_family_artists_and_non_album_tracks(app):
    def make_album(key: str, name: str, album_artist: str, year: int, category: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=album_artist,
            artists=[album_artist],
            cover_path=None,
            year=year,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            library_root_id=f"{category}-1",
            library_root_category=category,
            root_provenance={
                "root_ids": [f"{category}-1"],
                "categories": [category],
                "category_labels": [category.replace("_", " ").title()],
                "primary_category": category,
                "primary_category_label": category.replace("_", " ").title(),
                "badges": ["New"] if category == "new_arrivals" else [],
                "is_mixed": False,
            },
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-main", "Tender Buttons", "Broadcast", 2005, "main_library"),
        make_album("stereo-arrival", "Arrival Cluster", "Stereolab", 2006, "new_arrivals"),
    ]
    st["file_cache"] = {
        "stereolab-main-track.mp3": {
            "path": "stereolab-main-track.mp3",
            "album": "Non-Album",
            "artist": "Stereolab",
            "album_artist": "Stereolab",
            "title": "Hidden Family Loose Track",
            "cover_path": None,
            "exception_type": "Non-album rarity",
            "library_root_id": "main_library-1",
            "library_root_category": "main_library",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Broadcast&category=main_library"))

    assert payload["visible_library_categories"] == ["main_library"]
    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_artists"] == []
    assert payload["artist_family_filters"] == [{
        "family_tag_ref": "artist-family:broadcast",
        "display_name": "Broadcast",
        "variation_names": ["Broadcast"],
        "is_selected_artist": True,
    }]
    assert payload["primary_filter_active"] is False
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert payload["family_artist_groups"] == []
    assert [group["artist"] for group in payload["artist_groups"]] == ["Broadcast"]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Broadcast"]
    assert payload["non_album_tracks"] == []


def test_build_view_payload_category_filter_clears_selected_artist_without_visible_root_albums(app):
    def make_album(key: str, name: str, album_artist: str, year: int, category: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=album_artist,
            artists=[album_artist],
            cover_path=None,
            year=year,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
            library_root_id=f"{category}-1",
            library_root_category=category,
            root_provenance={
                "root_ids": [f"{category}-1"],
                "categories": [category],
                "category_labels": [category.replace("_", " ").title()],
                "primary_category": category,
                "primary_category_label": category.replace("_", " ").title(),
                "badges": ["New"] if category == "new_arrivals" else [],
                "is_mixed": False,
            },
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-arrival", "Arrival Broadcast", "Broadcast", 2005, "new_arrivals"),
        make_album("stereo-main", "Dots and Loops", "Stereolab", 1997, "main_library"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Broadcast&category=main_library"))

    assert payload["visible_library_categories"] == ["main_library"]
    assert payload["selected_artist"] == ""
    assert payload["related_artists"] == []
    assert payload["primary_artist_groups"] == []
    assert payload["family_artist_groups"] == []
    assert [group["artist"] for group in payload["artist_groups"]] == ["Stereolab"]
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Stereolab"]
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1


def test_build_view_payload_caches_casefold_alias_views_between_requests(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-2009",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="mono-2021",
            name="Pilgrimage of the Soul",
            album_artist="MONO",
            artists=["MONO"],
            cover_path=None,
            year=2021,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    enrich_calls = 0
    original_enrich = view_payloads_module.enrich_casefold_artist_alias_views

    def counting_enrich(*args, **kwargs):
        nonlocal enrich_calls
        enrich_calls += 1
        return original_enrich(*args, **kwargs)

    monkeypatch.setattr(view_payloads_module, "enrich_casefold_artist_alias_views", counting_enrich)

    first_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))
    second_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert enrich_calls == 1
    assert first_payload["selected_artist"] == "Mono"
    assert second_payload["selected_artist"] == "Mono"
    assert st["relation_views"]["casefold_alias_to_canonical"]["MONO"] == "Mono"


def test_build_view_payload_reuses_persisted_alias_views_without_rebuilding_artist_alias_clusters(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-2009",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="mono-2021",
            name="Pilgrimage of the Soul",
            album_artist="MONO",
            artists=["MONO"],
            cover_path=None,
            year=2021,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {"Mono": "Mono", "MONO": "Mono"},
        "canonical_to_aliases": {"Mono": ["Mono", "MONO"]},
        "folder_related": {},
    }

    def fail_if_rebuilt(*args, **kwargs):
        raise AssertionError("expected persisted alias views to be reused")

    monkeypatch.setattr("music_app.services.artist_alias_views.build_artist_alias_views", fail_if_rebuilt)

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["selected_artist"] == "Mono"
    assert payload["artist_groups"]
    assert st["relation_views"]["casefold_alias_to_canonical"]["MONO"] == "Mono"


def test_resolve_casefold_relation_views_threads_explicit_config_into_alias_rebuild(app, monkeypatch):
    albums = [
        SimpleNamespace(
            key="mono-2009",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
        ),
        SimpleNamespace(
            key="mono-2021",
            name="Pilgrimage of the Soul",
            album_artist="MONO",
            artists=["MONO"],
        ),
    ]
    st = {
        "relation_views": {
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
            "folder_related": {},
        }
    }
    rebuild_calls: list[object] = []
    root_config_calls: list[object] = []

    def fake_get_primary_music_root(config):
        root_config_calls.append(config)
        return config["MUSIC_DIR"]

    def fake_build_artist_alias_views(target_albums, music_root):
        assert list(target_albums) == albums
        rebuild_calls.append(music_root)
        return {
            "alias_to_canonical": {"MONO": "Mono"},
            "canonical_to_aliases": {"Mono": ["Mono", "MONO"]},
        }

    monkeypatch.setattr(
        "music_app.services.artist_alias_views.get_primary_music_root",
        fake_get_primary_music_root,
    )
    monkeypatch.setattr(
        "music_app.services.artist_alias_views.build_artist_alias_views",
        fake_build_artist_alias_views,
    )

    relation_views, alias_to_canonical, canonical_to_aliases = (
        view_payloads_module._resolve_casefold_relation_views(
            st,
            albums,
            config=app.config,
            allow_rebuild_alias_views=True,
        )
    )

    assert root_config_calls == [app.config]
    assert rebuild_calls == [app.config["MUSIC_DIR"]]
    assert relation_views["alias_to_canonical"]["MONO"] == "Mono"
    assert alias_to_canonical["MONO"] == "Mono"
    assert set(canonical_to_aliases["Mono"]) == {"MONO", "Mono"}


def test_build_view_payload_caches_search_buckets_between_same_query_requests(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="neal-1",
            name="One",
            album_artist="Neal Morse",
            artists=["Neal Morse"],
            cover_path=None,
            year=2000,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    search_bucket_calls = 0
    original_search_buckets = view_payloads_module.artist_search_buckets

    def counting_search_buckets(*args, **kwargs):
        nonlocal search_bucket_calls
        search_bucket_calls += 1
        return original_search_buckets(*args, **kwargs)

    monkeypatch.setattr(view_payloads_module, "artist_search_buckets", counting_search_buckets)

    first_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=neal"))
    second_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=neal"))

    assert search_bucket_calls == 1
    assert first_payload["query"] == "neal"
    assert second_payload["query"] == "neal"
    assert first_payload["search_context"] == {
        "transport": "view_data",
        "response_kind": "legacy_artist_gallery",
        "committed_query": "neal",
        "result_surface": {
            "kind": "grouped_artist_results",
            "group_order": ["direct_matches", "related_matches"],
            "default_selection_behavior": "explicit_result_selection",
        },
        "result_groups": {
            "direct_matches": ["Neal Morse"],
            "related_matches": [],
        },
        "search_filters": {
            "genre": [],
            "mood": [],
            "style": [],
            "duration": {
                "min_seconds": None,
                "max_seconds": None,
            },
        },
        "selected_artist": "Neal Morse",
        "selected_artist_source": "auto_top_match",
        "direct_match_artists": ["Neal Morse"],
        "related_match_artists": [],
    }
    assert second_payload["search_context"] == first_payload["search_context"]


def test_build_view_payload_only_precomputes_the_selected_search_artist(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key=f"scan-artist-{index}",
            name=f"Album {index}",
            album_artist=f"Scan Artist {index:03d}",
            artists=[f"Scan Artist {index:03d}"],
            cover_path=None,
            year=2000 + index,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )
        for index in range(1, 4)
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }
    precomputed_artists = []

    def capture_precompute(_cache, **kwargs):
        precomputed_artists.extend(kwargs["warm_precompute_artists"])

    monkeypatch.setattr(
        view_payloads_module,
        "_warm_query_selected_artist_group_cache",
        capture_precompute,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url("/view-data?q=scan+artist"),
    )

    assert payload["selected_artist"] == "Scan Artist 001"
    assert precomputed_artists == ["Scan Artist 001"]


def test_build_view_payload_caches_root_browse_groups_between_requests(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-1",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    root_group_calls = 0
    original_build_artist_groups = _artist_group_helpers().build_artist_groups

    def counting_build_artist_groups(*args, **kwargs):
        nonlocal root_group_calls
        root_group_calls += 1
        return original_build_artist_groups(*args, **kwargs)

    monkeypatch.setattr(_artist_group_helpers(), "build_artist_groups", counting_build_artist_groups)

    first_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))
    second_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert root_group_calls == 1
    assert [group["artist"] for group in first_payload["artist_groups"]] == ["Broadcast", "Mono"]
    assert [group["artist"] for group in second_payload["artist_groups"]] == ["Broadcast", "Mono"]


def test_build_view_payload_sidebar_tier_skips_root_group_build_and_returns_full_sidebar(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-1",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {"Mono": set()},
    }

    def fail_if_root_groups_built(*args, **kwargs):
        raise AssertionError("sidebar startup tier should not build root artist groups")

    monkeypatch.setattr(_artist_group_helpers(), "build_artist_groups", fail_if_root_groups_built)

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?payload_tier=sidebar"))

    assert payload["payload_tier"] == "sidebar"
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Broadcast", "Mono"]
    assert "artist_groups" not in payload
    assert payload["initial_view_partial"] is True


def test_build_view_payload_root_all_artists_count_uses_sidebar_total(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="shared-1",
            name="Shared Record",
            album_artist="Alpha",
            artists=["Alpha", "Beta", "Gamma"],
            cover_path=None,
            year=2001,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    monkeypatch.setattr(
        view_payloads_module,
        "_resolve_root_browse_artist_groups",
        lambda **kwargs: [
            {"artist": "Alpha", "albums": [{"key": "shared-1"}]},
            {"artist": "Beta", "albums": [{"key": "shared-1"}]},
        ],
    )
    monkeypatch.setattr(
        view_payloads_module,
        "_resolve_artists_sidebar",
        lambda *args, **kwargs: [
            {"artist": "Alpha", "artist_display": "Alpha", "count": 1},
            {"artist": "Beta", "artist_display": "Beta", "count": 1},
            {"artist": "Gamma", "artist_display": "Gamma", "count": 1},
        ],
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert payload["artist_count"] == 3
    assert len(payload["artist_groups"]) == 2
    assert [item["artist"] for item in payload["artists_sidebar"]] == ["Alpha", "Beta", "Gamma"]


def test_build_view_payload_root_all_artists_count_survives_omit_sidebar_refresh(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    sidebar_calls = 0

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="shared-1",
            name="Shared Record",
            album_artist="Alpha",
            artists=["Alpha", "Beta", "Gamma"],
            cover_path=None,
            year=2001,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    monkeypatch.setattr(
        view_payloads_module,
        "_resolve_root_browse_artist_groups",
        lambda **kwargs: [
            {"artist": "Alpha", "albums": [{"key": "shared-1"}]},
            {"artist": "Beta", "albums": [{"key": "shared-1"}]},
        ],
    )

    def resolve_sidebar(*args, **kwargs):
        nonlocal sidebar_calls
        sidebar_calls += 1
        return [
            {"artist": "Alpha", "artist_display": "Alpha", "count": 1},
            {"artist": "Beta", "artist_display": "Beta", "count": 1},
            {"artist": "Gamma", "artist_display": "Gamma", "count": 1},
        ]

    monkeypatch.setattr(view_payloads_module, "_resolve_artists_sidebar", resolve_sidebar)

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?omit_sidebar=1"))

    assert sidebar_calls == 1
    assert payload["artist_count"] == 3
    assert "artists_sidebar" not in payload
    assert len(payload["artist_groups"]) == 2


def test_build_view_payload_selected_artist_sidebar_cache_does_not_poison_root_browse_groups(app):
    def make_album(key: str, name: str, artist: str, year: int):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("3-1", "The End Is Begun", "3", 2007),
        make_album("apc-1", "Mer de Noms", "A Perfect Circle", 2000),
        make_album("elp-1", "Brain Salad Surgery", "Emerson Lake & Palmer", 1973),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "3": {"Emerson Lake & Palmer"},
            "Emerson Lake & Palmer": {"3"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"3": ["Emerson Lake & Palmer"]})

    selected_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=3"))

    root_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert selected_payload["selected_artist"] == "3"
    assert [group["artist"] for group in selected_payload["artist_groups"]] == [
        "3",
        "Emerson Lake & Palmer",
    ]
    assert root_payload["selected_artist"] == ""
    assert [group["artist"] for group in root_payload["artist_groups"]] == [
        "3",
        "A Perfect Circle",
        "Emerson Lake & Palmer",
    ]


def test_build_view_payload_selected_artist_reuses_cached_root_groups_before_rescanning_albums(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("3-1", "The End Is Begun", "3", 2007),
        make_album("elp-1", "Brain Salad Surgery", "Emerson Lake & Palmer", 1973),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "3": {"Emerson Lake & Palmer"},
            "Emerson Lake & Palmer": {"3"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"3": ["Emerson Lake & Palmer"]})

    root_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    def fail_if_group_match_runs(*_args, **_kwargs):
        raise AssertionError("selected artist should reuse cached root groups before rescanning albums")

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_cached_album_matches_group_artist",
        fail_if_group_match_runs,
    )

    selected_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=3"))

    assert [group["artist"] for group in root_payload["artist_groups"]] == [
        "3",
        "Emerson Lake & Palmer",
    ]
    assert selected_payload["selected_artist"] == "3"
    assert [group["artist"] for group in selected_payload["artist_groups"]] == [
        "3",
        "Emerson Lake & Palmer",
    ]


def test_build_view_payload_selected_artist_family_display_chronological_flattens_rendered_groups_and_keeps_source_groups(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=fr"C:\Music\{artist}\{name}\01 Track.flac")],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("mono-1", "Hymn to the Immortal Wind", "Mono", 2009, "2009-03-24"),
        make_album("weg-1", "Palmless Prayer / Mass Murder Refrain", "World's End Girlfriend", 2006, "2006-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Mono": ["World's End Girlfriend"]})

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono&family_display=chronological"))

    assert payload["selected_artist"] == "Mono"
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Mono"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["World's End Girlfriend"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Palmless Prayer / Mass Murder Refrain",
        "Hymn to the Immortal Wind",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2
    assert payload["selected_artist_family_display_mode"] == "chronological"
    assert payload["playback_context"] == {
        "kind": "artist_page",
        "end_behavior": "stop",
        "ordered_album_refs": ["weg-1", "mono-1"],
            "albums": [
                {
                    "album_ref": "weg-1",
                    "can_play": True,
                },
                {
                    "album_ref": "mono-1",
                    "can_play": True,
                },
            ],
        }


def test_build_view_payload_selected_artist_family_display_chronological_reuses_cached_root_groups_without_rescan(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("3-1", "The End Is Begun", "3", 2007, "2007-09-18"),
        make_album("elp-1", "Brain Salad Surgery", "Emerson Lake & Palmer", 1973, "1973-12-07"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "3": {"Emerson Lake & Palmer"},
            "Emerson Lake & Palmer": {"3"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"3": ["Emerson Lake & Palmer"]})

    build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    def fail_if_group_match_runs(*_args, **_kwargs):
        raise AssertionError("chronological selected artist should reuse cached root groups before rescanning albums")

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_cached_album_matches_group_artist",
        fail_if_group_match_runs,
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=3&family_display=chronological"))

    assert payload["selected_artist"] == "3"
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Brain Salad Surgery",
        "The End Is Begun",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_selected_artist_related_filter_chronological_reuses_cached_source_groups_without_rescan(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    def fail_if_group_match_runs(*_args, **_kwargs):
        raise AssertionError("filtered chronological selected artist should regroup cached source groups before rescanning albums")

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_cached_album_matches_group_artist",
        fail_if_group_match_runs,
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Broadcast&related_artist=Stereolab&primary_filter=1&family_display=chronological"
    ))

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["Stereolab"]
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_query_selected_artist_related_filter_chronological_regroups_cached_source_groups_without_rebuilding_membership(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    warm_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    assert [group["artist"] for group in warm_payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in warm_payload["family_artist_groups"]] == ["Stereolab"]

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError("query filtered selected artist should regroup cached source groups before rebuilding membership groups")

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&related_artist=Stereolab"
            "&primary_filter=1&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["Stereolab"]
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]


def test_build_view_payload_query_selected_artist_primary_filter_chronological_regroups_cached_source_groups_without_rebuilding_membership(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    warm_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    assert [group["artist"] for group in warm_payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in warm_payload["family_artist_groups"]] == ["Stereolab"]

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError(
            "query primary-filter selected artist should regroup cached source groups "
            "before rebuilding membership groups"
        )

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&primary_filter=1"
            "&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_query_selected_artist_primary_filter_chronological_regroups_cached_source_groups_without_rebuilding_membership_above_warm_threshold(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    extra_albums = [
        make_album(
            f"orchid-{index}",
            f"Orchid Release {index:02d}",
            f"Orchid Artist {index:02d}",
            1980 + index,
            f"{1980 + index}-01-01",
        )
        for index in range(25)
    ]

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
        *extra_albums,
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    warm_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    assert [group["artist"] for group in warm_payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in warm_payload["family_artist_groups"]] == ["Stereolab"]

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError(
            "query primary-filter selected artist should regroup cached source groups "
            "before rebuilding membership groups above the warm threshold"
        )

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&primary_filter=1"
            "&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_query_selected_artist_related_filter_chronological_without_primary_regroups_cached_source_groups_without_rebuilding_membership(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    warm_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    assert [group["artist"] for group in warm_payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in warm_payload["family_artist_groups"]] == ["Stereolab"]

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError(
            "query related-filter selected artist should regroup cached source groups "
            "before rebuilding membership groups"
        )

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&related_artist=Stereolab"
            "&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["Stereolab"]
    assert payload["primary_filter_active"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == []
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
    ]
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1


def test_build_view_payload_query_selected_artist_direct_chronological_keeps_primary_and_family_groups_before_related_regrouping(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    direct_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    related_payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&related_artist=Stereolab"
            "&family_display=chronological"
        ),
    )

    assert direct_payload["selected_artist"] == "Broadcast"
    assert direct_payload["related_filter_artists"] == []
    assert direct_payload["primary_filter_active"] is False
    assert [group["artist"] for group in direct_payload["primary_artist_groups"]] == [
        "Broadcast",
    ]
    assert [group["artist"] for group in direct_payload["family_artist_groups"]] == [
        "Stereolab",
    ]
    assert [group["artist"] for group in direct_payload["artist_groups"]] == [
        "Chronological",
    ]
    assert [album["name"] for album in direct_payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]

    assert related_payload["selected_artist"] == "Broadcast"
    assert related_payload["related_filter_artists"] == ["Stereolab"]
    assert related_payload["primary_filter_active"] is False
    assert [group["artist"] for group in related_payload["primary_artist_groups"]] == []
    assert [group["artist"] for group in related_payload["family_artist_groups"]] == [
        "Stereolab",
    ]
    assert [group["artist"] for group in related_payload["artist_groups"]] == [
        "Chronological",
    ]
    assert [album["name"] for album in related_payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
    ]


def test_build_view_payload_query_selected_artist_same_query_chronological_reuses_cached_groups_without_rebuilding_membership(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    warm_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=o&artist=Broadcast&family_display=chronological"))

    assert [group["artist"] for group in warm_payload["primary_artist_groups"]] == [
        "Broadcast",
    ]
    assert [group["artist"] for group in warm_payload["family_artist_groups"]] == [
        "Stereolab",
    ]

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError(
            "same-query selected artist should reuse warmed query groups "
            "before rebuilding membership groups"
        )

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?q=o&artist=Broadcast&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == [
        "Broadcast",
    ]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Stereolab",
    ]
    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Chronological",
    ]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_selected_artist_strictly_filters_related_artist_values_on_fresh_rebuild(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
        make_album("cibo-1", "Stereo Type A", "Cibo Matto", 1999, "1999-06-23"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
            "Cibo Matto": set(),
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?artist=Broadcast&related_artist=Stereolab"
            "&related_artist=Cibo%20Matto&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["Stereolab"]
    assert payload["primary_filter_active"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == []
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
    ]
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1


def test_build_view_payload_selected_artist_primary_filter_with_no_surviving_related_filters_clears_visible_family_set(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
        make_album("cibo-1", "Stereo Type A", "Cibo Matto", 1999, "1999-06-23"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
            "Cibo Matto": set(),
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?artist=Broadcast&related_artist=Cibo%20Matto"
            "&primary_filter=1&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == []
    assert payload["primary_filter_active"] is True
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == []
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Tender Buttons",
    ]
    assert payload["album_count"] == 1
    assert payload["artist_count"] == 1


def test_build_view_payload_selected_artist_root_browse_clone_fallback_uses_filtered_visible_family_set_without_membership_rebuild(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereo-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
        make_album("cibo-1", "Stereo Type A", "Cibo Matto", 1999, "1999-06-23"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Broadcast": {"Stereolab"},
            "Stereolab": {"Broadcast"},
            "Cibo Matto": set(),
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Broadcast": ["Stereolab"]})

    build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    def fail_if_membership_groups_rebuild(*_args, **_kwargs):
        raise AssertionError(
            "selected-artist root-browse clone fallback should reuse cached root groups "
            "before rebuilding membership groups"
        )

    monkeypatch.setattr(
        _artist_group_helpers(),
        "_build_artist_membership_groups",
        fail_if_membership_groups_rebuild,
    )

    payload = build_view_payload(
        app=app,
        query_args=_query_args_from_url(
            "/view-data?artist=Broadcast&related_artist=Stereolab"
            "&related_artist=Cibo%20Matto&family_display=chronological"
        ),
    )

    assert payload["selected_artist"] == "Broadcast"
    assert payload["related_filter_artists"] == ["Stereolab"]
    assert payload["primary_filter_active"] is False
    assert [group["artist"] for group in payload["primary_artist_groups"]] == ["Broadcast"]
    assert [group["artist"] for group in payload["family_artist_groups"]] == ["Stereolab"]
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [album["name"] for album in payload["artist_groups"][0]["albums"]] == [
        "Dots and Loops",
        "Tender Buttons",
    ]
    assert payload["album_count"] == 2
    assert payload["artist_count"] == 2


def test_build_view_payload_selected_artist_family_display_chronological_keeps_query_all_artists_link_hidden(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("mono-1", "Hymn to the Immortal Wind", "Mono", 2009, "2009-03-24"),
        make_album("weg-1", "Palmless Prayer / Mass Murder Refrain", "World's End Girlfriend", 2006, "2006-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Mono": ["World's End Girlfriend"]})

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=Mono&artist=Mono&family_display=chronological"))

    assert payload["selected_artist"] == "Mono"
    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert payload["show_all_artists_sidebar_link"] is False


def test_build_view_payload_selected_artist_family_payload_exposes_cluster_filter_metadata_without_rewriting_album_credit(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("neal-1", "One", "Neal Morse", 2004, "2004-01-01"),
        make_album("mpg-1", "Cover 2 Cover", "Morse Portnoy George", 2012, "2012-09-11"),
        make_album("resonance-1", "No Hill for a Climber", "Neal Morse & The Resonance", 2024, "2024-11-08"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse",
            "Morse Portnoy George": "Morse Portnoy George",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
            "Morse Portnoy George": ["Morse Portnoy George"],
        },
        "folder_related": {
            "Neal Morse": {"Morse Portnoy George"},
            "Morse Portnoy George": {"Neal Morse"},
        },
    }
    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Morse Portnoy George"],
            "relations_last_built": 99.0,
            "loaded": True,
            "alias_to_canonical": {
                "Neal Morse": "Neal Morse",
                "Neal Morse & The Resonance": "Neal Morse",
                "Morse Portnoy George": "Morse Portnoy George",
            },
            "canonical_to_aliases": {
                "Neal Morse": ["Neal Morse", "Neal Morse & The Resonance"],
                "Morse Portnoy George": ["Morse Portnoy George"],
            },
        },
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Neal+Morse&family_display=chronological"))

    assert payload["artist_family_filters"] == [
        {
            "family_tag_ref": "artist-family:nealmorse",
            "display_name": "Neal Morse",
            "variation_names": ["Neal Morse"],
            "is_selected_artist": True,
        },
        {
            "family_tag_ref": "artist-family:nealmorsetheresonance",
            "display_name": "Neal Morse & The Resonance",
            "variation_names": ["Neal Morse & The Resonance"],
            "is_selected_artist": False,
        },
        {
            "family_tag_ref": "artist-family:morseportnoygeorge",
            "display_name": "Morse Portnoy George",
            "variation_names": ["Morse Portnoy George"],
            "is_selected_artist": False,
        },
    ]
    assert [group["family_tag_ref"] for group in payload["primary_artist_groups"]] == [
        "artist-family:nealmorse",
    ]
    assert [group["family_tag_ref"] for group in payload["family_artist_groups"]] == [
        "artist-family:morseportnoygeorge",
        "artist-family:nealmorsetheresonance",
    ]
    assert [
        (album["key"], album["display_artist"], album["artist_family_tag_refs"])
        for album in payload["artist_groups"][0]["albums"]
    ] == [
        ("neal-1", "Neal Morse", ["artist-family:nealmorse"]),
        ("mpg-1", "Morse Portnoy George", ["artist-family:morseportnoygeorge"]),
        (
            "resonance-1",
            "Neal Morse & The Resonance",
            ["artist-family:nealmorsetheresonance"],
        ),
    ]
    assert payload["artist_groups"][0]["albums"][2]["artist_credits_seen"] == [
        "Neal Morse & The Resonance",
    ]
    assert payload["artist_groups"][0]["albums"][2][
        "artist_family_variation_names_by_tag_ref"
    ] == {
        "artist-family:nealmorsetheresonance": ["Neal Morse & The Resonance"],
    }


def test_build_view_payload_selected_artist_exposes_listen_through_scope_candidates(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("mono-1", "Hymn to the Immortal Wind", "Mono", 2009, "2009-03-24"),
        make_album(
            "weg-1",
            "Palmless Prayer / Mass Murder Refrain",
            "World's End Girlfriend",
            2006,
            "2006-01-01",
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Mono": ["World's End Girlfriend"]})

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono&family_display=chronological"))

    assert payload["listen_through_scope_candidates"] == {
        "artist": {
            "scope_kind": "artist",
            "artist_ref": "Mono",
            "family_tag_ref": "artist-family:mono",
            "in_scope_album_refs": ["mono-1"],
            "local_completion_denominator": {
                "album_refs": ["mono-1"],
                "album_count": 1,
            },
            "missing_releases": [],
        },
        "artist_family": {
            "scope_kind": "artist_family",
            "selected_artist_ref": "Mono",
            "family_tag_refs": [
                "artist-family:mono",
                "artist-family:worldsendgirlfriend",
            ],
            "in_scope_album_refs": ["mono-1", "weg-1"],
            "local_completion_denominator": {
                "album_refs": ["mono-1", "weg-1"],
                "album_count": 2,
            },
            "missing_releases": [],
        },
    }


def test_build_view_payload_selected_artist_prefers_persisted_artist_family_projection(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("stereolab-1", "Dots and Loops", "Stereolab", 1997, "1997-09-22"),
        make_album("tender-1", "The Soft and the Hardcore", "Tender Forever", 2005, "2005-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "artists": {"Tender Forever": {"Broadcast", "Stereolab"}},
        "alias_to_canonical": {
            "Tender Forever": "Tender Forever",
            "Broadcast": "Broadcast",
            "Stereolab": "Stereolab",
        },
        "canonical_to_aliases": {
            "Tender Forever": ["Tender Forever"],
            "Broadcast": ["Broadcast"],
            "Stereolab": ["Stereolab"],
        },
        "folder_related": {
            "Tender Forever": {"Broadcast", "Stereolab"},
        },
    }
    st["relations_last_built"] = 99.0

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda _config, artist, **_kwargs: {
            "family_artists": ["Broadcast", "Stereolab", "Stale Artist"] if artist == "Tender Forever" else [],
            "relations_last_built": 99.0,
            "loaded": True,
        },
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Tender+Forever&family_display=chronological"))

    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Tender Forever",
        "Broadcast",
        "Stereolab",
    ]
    assert [group["artist"] for group in payload["family_artist_groups"]] == [
        "Broadcast",
        "Stereolab",
    ]
    assert "Stale Artist" not in payload["related_artists"]


def test_build_view_payload_selected_artist_ignores_runtime_family_when_projection_is_not_loaded(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("broadcast-1", "Tender Buttons", "Broadcast", 2005, "2005-09-19"),
        make_album("tender-1", "The Soft and the Hardcore", "Tender Forever", 2005, "2005-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "artists": {"Tender Forever": {"Broadcast"}},
        "alias_to_canonical": {
            "Tender Forever": "Tender Forever",
            "Broadcast": "Broadcast",
        },
        "canonical_to_aliases": {
            "Tender Forever": ["Tender Forever"],
            "Broadcast": ["Broadcast"],
        },
        "folder_related": {
            "Tender Forever": {"Broadcast"},
        },
    }
    st["relations_last_built"] = 200.0

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda _config, artist, **_kwargs: {
            "family_artists": ["Broadcast", "Stale Artist"] if artist == "Tender Forever" else [],
            "relations_last_built": 150.0,
            "loaded": False,
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Tender+Forever&family_display=chronological"))

    assert payload["related_artists"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Tender Forever"]
    assert payload["family_artist_groups"] == []


def test_build_view_payload_selected_artist_does_not_sync_or_fallback_when_projection_is_empty(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("neal-1", "One", "Neal Morse", 2000, "2000-01-01"),
        make_album(
            "resonance-1",
            "Two",
            "Neal Morse & The Resonance",
            2024,
            "2024-01-01",
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "artists": ["Neal Morse", "Neal Morse & The Resonance"],
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse & The Resonance",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse"],
            "Neal Morse & The Resonance": ["Neal Morse & The Resonance"],
        },
        "folder_related": {
            "Neal Morse": {"Neal Morse & The Resonance"},
            "Neal Morse & The Resonance": {"Neal Morse"},
        },
    }
    st["relations_last_built"] = 999.0

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": True,
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Neal+Morse"))

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["related_artists"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Neal Morse"]
    assert payload["family_artist_groups"] == []


def test_build_view_payload_query_selected_artist_does_not_refresh_relation_views_or_sync_projection(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    def make_album(key: str, name: str, artist: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=2000,
            release_date="2000-01-01",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("neal-1", "Neal Morse", "Neal Morse"),
        make_album("resonance-1", "No Hill For A Climber", "Neal Morse & The Resonance"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "artists": ["Neal Morse", "Neal Morse & The Resonance"],
        "alias_to_canonical": {
            "Neal Morse": "Neal Morse",
            "Neal Morse & The Resonance": "Neal Morse & The Resonance",
        },
        "canonical_to_aliases": {
            "Neal Morse": ["Neal Morse"],
            "Neal Morse & The Resonance": ["Neal Morse & The Resonance"],
        },
        "folder_related": {"Other Artist": {"Guest Artist"}},
    }
    st["relations_last_built"] = 10.0

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": [],
            "relations_last_built": 0.0,
            "loaded": False,
            "alias_to_canonical": {},
            "canonical_to_aliases": {},
        },
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?q=Neal+Morse"))

    assert payload["selected_artist"] == "Neal Morse"
    assert payload["related_artists"] == []
    assert [item["display_name"] for item in payload["artist_family_filters"]] == ["Neal Morse"]
    assert payload["family_artist_groups"] == []


def test_build_view_payload_selected_artist_groups_expose_section_ready_compatibility_lane(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("mono-1", "Hymn to the Immortal Wind", "Mono", 2009, "2009-03-24"),
        make_album("weg-1", "Palmless Prayer / Mass Murder Refrain", "World's End Girlfriend", 2006, "2006-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }
    _seed_selected_artist_family_projection_map(app, {"Mono": ["World's End Girlfriend"]})

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    expected_group_album_refs = {
        group["artist"]: [album["key"] for album in group["albums"]]
        for group in payload["artist_groups"]
    }

    assert [group["artist"] for group in payload["artist_groups"]] == [
        "Mono",
        "World's End Girlfriend",
    ]
    for group in payload["artist_groups"]:
        assert group["sections"] == [
            {
                "section_ref": "unclassified",
                "section_label": "Unclassified",
                "section_kind": "parent_section",
                "albums": group["albums"],
                "subsections": [],
            },
        ]
        assert [album["key"] for album in group["sections"][0]["albums"]] == (
            expected_group_album_refs[group["artist"]]
        )


def test_build_view_payload_selected_artist_artist_page_gallery_payload_reuses_top_level_contract(app):
    def make_album(key: str, name: str, artist: str, year: int, release_date: str):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=artist,
            artists=[artist],
            cover_path=None,
            year=year,
            release_date=release_date,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[SimpleNamespace(path=fr"C:\Music\{artist}\{name}\01 track.flac")],
            is_compilation=False,
        )

    st = app.library_state
    st["albums"] = [
        make_album("mono-1", "Hymn to the Immortal Wind", "Mono", 2009, "2009-03-24"),
        make_album("weg-1", "Palmless Prayer / Mass Murder Refrain", "World's End Girlfriend", 2006, "2006-01-01"),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono&family_display=chronological"))

    gallery_payload = payload["artist_page"]["gallery_payload"]

    assert gallery_payload == {
        "artist_ref": "Mono",
        "payload_source": "top_level_selected_artist_payload",
        "artist_groups_field": "artist_groups",
        "primary_artist_groups_field": "primary_artist_groups",
        "family_artist_groups_field": "family_artist_groups",
        "related_artists_field": "related_artists",
        "artist_family_filters_field": "artist_family_filters",
        "album_count_field": "album_count",
        "artist_count_field": "artist_count",
        "playback_context_field": "playback_context",
        "listen_through_scope_candidates_field": (
            "listen_through_scope_candidates"
        ),
    }
    assert payload[gallery_payload["artist_groups_field"]][0]["artist"] == (
        "Chronological"
    )
    assert payload[gallery_payload["playback_context_field"]]["kind"] == (
        "artist_page"
    )


def test_build_view_payload_repeated_family_tree_selection_stays_under_expected_budget(app):
    expected_warm_tree_response_ms = 250

    def make_album(key: str, name: str, album_artist: str, artists: list[str], year: int):
        return SimpleNamespace(
            key=key,
            name=name,
            album_artist=album_artist,
            artists=artists,
            cover_path=None,
            year=year,
            release_date=f"{year}-01-01",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        )

    st = app.library_state
    family_artists = [
        "Cosmic Cathedral",
        "Transatlantic",
        "Mike Portnoy",
        "Randy George",
        "Bill Hubauer",
        "Phil Keaggy",
        "Roine Stolt",
        "The Resonance",
        "Flying Colors",
        "John Petrucci",
    ]
    albums = [
        make_album(
            key=f"neal-{index}",
            name=f"Neal Morse Album {index}",
            album_artist="Neal Morse",
            artists=["Neal Morse"],
            year=2000 + index,
        )
        for index in range(12)
    ]
    for artist_index, artist in enumerate(family_artists, start=1):
        for album_index in range(4):
            albums.append(make_album(
                key=f"{artist.casefold().replace(' ', '-')}-{album_index}",
                name=f"{artist} Album {album_index}",
                album_artist=artist,
                artists=[artist],
                year=2010 + artist_index + album_index,
            ))
    for index in range(240):
        artist = f"Background Artist {index % 40}"
        albums.append(make_album(
            key=f"background-{index}",
            name=f"Background Album {index}",
            album_artist=artist,
            artists=[artist],
            year=1990 + (index % 30),
        ))

    related_family = {"Neal Morse", *family_artists}
    st["albums"] = albums
    st["file_cache"] = {}
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            artist: set(related_family - {artist})
            for artist in related_family
        },
    }

    warm_url = f"/view-data?q={quote_plus('Neal Morse')}&artist={quote_plus('Neal Morse')}"
    warm_payload = build_view_payload(app=app, query_args=_query_args_from_url(warm_url))

    measured_artists = ["Neal Morse", "Cosmic Cathedral", "Transatlantic", "Mike Portnoy"] * 2
    elapsed_ms = []
    for artist in measured_artists:
        request_url = f"/view-data?q={quote_plus('Neal Morse')}&artist={quote_plus(artist)}"
        started_at = time.perf_counter()
        payload = build_view_payload(app=app, query_args=_query_args_from_url(request_url))
        elapsed_ms.append((time.perf_counter() - started_at) * 1000)
        assert payload["query"] == "Neal Morse"
        assert payload["selected_artist"] == artist
        assert payload["artist_groups"]

    assert warm_payload["selected_artist"] == "Neal Morse"
    representative_warm_response_ms = sorted(elapsed_ms)[len(elapsed_ms) // 2]
    assert representative_warm_response_ms < expected_warm_tree_response_ms, (
        f"expected representative warm filtered-tree response under {expected_warm_tree_response_ms}ms, "
        f"got representative={round(representative_warm_response_ms, 2)}ms "
        f"from {[round(value, 2) for value in elapsed_ms]}"
    )


def test_build_view_payload_logs_selected_artist_timing_breakdown(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    captured_logs: list[dict[str, object]] = []

    def capture_log_event(*_args, **kwargs):
        captured_logs.append(kwargs)

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="mono-collab-1",
            name="Affectionately",
            album_artist="World's End Girlfriend",
            artists=["World's End Girlfriend"],
            cover_path=None,
            year=2005,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {
        "mono-loose.mp3": {
            "path": "mono-loose.mp3",
            "album": "Loose Tracks",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Com(?)",
            "cover_path": None,
            "exception_type": "Non-album rarity",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"World's End Girlfriend"},
            "World's End Girlfriend": {"Mono"},
        },
    }

    monkeypatch.setattr(view_payloads_module, "log_app_event", capture_log_event)

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["selected_artist"] == "Mono"
    timings = captured_logs[-1]["timings"]
    assert timings["selected_artist_primary_album_collection_ms"] >= 0
    assert timings["selected_artist_family_album_collection_ms"] >= 0
    assert timings["selected_artist_primary_group_build_ms"] >= 0
    assert timings["selected_artist_family_group_build_ms"] >= 0
    assert timings["non_album_entries_ms"] >= 0


def test_build_view_payload_caches_non_album_path_resolution_between_selected_artist_requests(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {
        "mono-track.mp3": {
            "path": "mono-track.mp3",
            "album": "Loose Tracks",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Ashes in the Snow",
            "cover_path": None,
            "exception_type": "Non-album rarity",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {"Mono": set()},
    }

    non_album_candidate_build_calls = 0
    original_build_non_album_entry_candidates = view_payloads_module._build_non_album_entry_candidates

    def counting_build_non_album_entry_candidates(*args, **kwargs):
        nonlocal non_album_candidate_build_calls
        non_album_candidate_build_calls += 1
        return original_build_non_album_entry_candidates(*args, **kwargs)

    monkeypatch.setattr(
        view_payloads_module,
        "_build_non_album_entry_candidates",
        counting_build_non_album_entry_candidates,
    )

    first_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))
    second_payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert first_payload["non_album_tracks"]
    assert second_payload["non_album_tracks"]
    assert non_album_candidate_build_calls == 1


def test_build_view_payload_prefers_persisted_artist_family_projection_without_syncing_on_read(app, monkeypatch):
    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-24",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-1",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            release_date="2005-09-19",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="stereolab-1",
            name="Dots and Loops",
            album_artist="Stereolab",
            artists=["Stereolab"],
            cover_path=None,
            year=1997,
            release_date="1997-09-22",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {
        "artists": ["Mono", "Broadcast", "Stereolab"],
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"Broadcast", "Stereolab"},
            "Broadcast": {"Mono"},
            "Stereolab": {"Mono"},
        },
    }
    st["relations_last_built"] = 999.0

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Broadcast"],
            "relations_last_built": 100.0,
            "loaded": True,
        },
    )
    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono"))

    assert payload["selected_artist"] == "Mono"
    assert payload["related_artists"] == ["Broadcast"]
    assert [item["display_name"] for item in payload["artist_family_filters"]] == [
        "Mono",
        "Broadcast",
    ]


def test_build_view_payload_selected_artist_filters_do_not_rebuild_runtime_family_views(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-1",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-24",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-1",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            release_date="2005-09-19",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {}
    st["relation_views"] = {}

    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Broadcast"],
            "relations_last_built": 1.0,
            "loaded": True,
            "alias_to_canonical": {
                "Mono": "Mono",
                "Broadcast": "Broadcast",
            },
            "canonical_to_aliases": {
                "Mono": ["Mono"],
                "Broadcast": ["Broadcast"],
            },
        },
    )
    monkeypatch.setattr(
        view_payloads_module,
        "ensure_relation_views",
        lambda *_args, **_kwargs: pytest.fail(
            "selected-artist filters should not rebuild runtime relation views"
        ),
        raising=False,
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url(
        "/view-data?artist=Mono&related_artist=Broadcast&primary_filter=1"
    ))

    assert payload["selected_artist"] == "Mono"
    assert payload["related_artists"] == ["Broadcast"]
    assert payload["related_filter_artists"] == ["Broadcast"]
    assert payload["primary_filter_active"] is True


def test_build_view_payload_does_not_repeat_non_album_path_probe_during_display_shaping(app, monkeypatch):
    library_root = Path(r"X:\SyntheticMusic")
    _use_library_root_settings_read_seam(
        app,
        monkeypatch,
        {
            "main_library_roots": [{"id": "main-1", "path": str(library_root), "layout_mode": "artist"}],
            "hoarding_library_roots": [],
            "new_arrivals_roots": [],
            "move_policy": {},
        },
    )
    st = app.library_state
    st["albums"] = []
    st["file_cache"] = {
        "blocked-track.mp3": {
            "path": r"X:\SyntheticMusic\Blocked\track.mp3",
            "album": "!Non album",
            "artist": "Metallica",
            "album_artist": "Metallica",
            "title": "Imperial March",
            "cover_path": None,
            "exception_type": "Non-album rarity",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {},
    }

    matching_exists_calls = []

    original_exists = Path.exists

    def observed_exists(self):
        if str(self).startswith(str(library_root / "Blocked")):
            matching_exists_calls.append(str(self))
            raise OSError(5, "Access is denied")
        return original_exists(self)

    monkeypatch.setattr(Path, "exists", observed_exists)

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data"))

    assert "non_album_groups" not in payload
    assert "non_album_loose_tracks" not in payload
    assert payload["non_album_tracks"][0]["artist"] == "Metallica"
    assert payload["non_album_tracks"][0]["title"] == "Imperial March"
    assert payload["non_album_tracks"][0]["display_path"] == r"Blocked\track.mp3"
    assert matching_exists_calls == [r"X:\SyntheticMusic\Blocked\track.mp3"]


def test_build_view_payload_scopes_non_album_tracks_to_selected_artist_family(app, monkeypatch):
    from music_app.services import view_payloads as view_payloads_module

    st = app.library_state
    st["albums"] = [
        SimpleNamespace(
            key="mono-album",
            name="Hymn to the Immortal Wind",
            album_artist="Mono",
            artists=["Mono"],
            cover_path=None,
            year=2009,
            release_date="2009-03-24",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
        SimpleNamespace(
            key="broadcast-album",
            name="Tender Buttons",
            album_artist="Broadcast",
            artists=["Broadcast"],
            cover_path=None,
            year=2005,
            release_date="2005-09-19",
            edition="",
            album_rating=0,
            total_duration_seconds=0,
            tracks=[],
            is_compilation=False,
        ),
    ]
    st["file_cache"] = {
        "mono-rarity": {
            "path": r"C:\Music\Mono\Loose\Com(?).mp3",
            "album": "!Non album",
            "artist": "Mono",
            "album_artist": "Mono",
            "title": "Com(?)",
            "year": 2001,
            "cover_path": None,
            "exception_type": "Non-album rarity",
        },
        "broadcast-single": {
            "path": r"C:\Music\Broadcast\Loose\Pendulum.mp3",
            "album": "!Non album",
            "artist": "Broadcast",
            "album_artist": "Broadcast",
            "title": "Pendulum",
            "year": 2003,
            "cover_path": None,
            "exception_type": "Single-only track",
        },
        "outsider-track": {
            "path": r"C:\Music\Stereolab\Loose\Miss Modular.mp3",
            "album": "!Non album",
            "artist": "Stereolab",
            "album_artist": "Stereolab",
            "title": "Miss Modular",
            "year": 1997,
            "cover_path": None,
            "exception_type": "Non-album rarity",
        },
    }
    st["relation_views"] = {
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
        "folder_related": {
            "Mono": {"Broadcast"},
            "Broadcast": {"Mono"},
        },
    }
    monkeypatch.setattr(
        view_payloads_module,
        "load_selected_artist_family_projection",
        lambda *_args, **_kwargs: {
            "family_artists": ["Broadcast"],
            "relations_last_built": 1.0,
            "loaded": True,
            "alias_to_canonical": {
                "Mono": "Mono",
                "Broadcast": "Broadcast",
            },
            "canonical_to_aliases": {
                "Mono": ["Mono"],
                "Broadcast": ["Broadcast"],
            },
        },
    )

    payload = build_view_payload(app=app, query_args=_query_args_from_url("/view-data?artist=Mono&family_display=chronological"))

    assert [group["artist"] for group in payload["artist_groups"]] == ["Chronological"]
    assert [track["artist"] for track in payload["non_album_tracks"]] == ["Broadcast", "Mono"]
    assert [track["title"] for track in payload["non_album_tracks"]] == ["Pendulum", "Com(?)"]


def test_merge_duplicate_artist_groups_keeps_one_group_and_preserves_both_visible_spellings():
    merged = api_view_payload_helpers._merge_duplicate_artist_groups([
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George",
            "albums": [{
                "name": "Cover 2 Cover",
                "album_artist": "Morse Portnoy George",
                "year": 2012,
                "release_date": "2012-09-11",
            }],
        },
        {
            "artist": "Morse, Portnoy & George",
            "artist_display": "Morse, Portnoy & George",
            "albums": [{
                "name": "Cover to Cover",
                "album_artist": "Morse, Portnoy & George",
                "year": 2006,
                "release_date": "2006-09-01",
            }],
        },
        {
            "artist": "Morse Portnoy George",
            "artist_display": "Morse Portnoy George",
            "albums": [{
                "name": "Songs from November",
                "album_artist": "Morse, Portnoy & George",
                "year": 2024,
                "release_date": "2024-08-16",
            }],
        },
    ])

    assert [group["artist"] for group in merged] == ["Morse Portnoy George"]
    assert merged[0]["artist_display"] == "Morse Portnoy George / Morse, Portnoy & George"
    assert [album["name"] for album in merged[0]["albums"]] == [
        "Cover to Cover",
        "Cover 2 Cover",
        "Songs from November",
    ]


def test_public_safe_album_payload_strips_private_app_rating_but_preserves_shared_tag_rating():
    from music_app.services.library import strip_private_album_preference_overlays

    private_preference = {
        "rating": 10,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": True,
        "to_listen": False,
        "is_relisten": False,
        "can_toggle_to_listen": False,
    }
    private_payload = {
        "key": "rated-album",
        "album_preference": private_preference,
        "tag_album_rating": 7,
        "tag_album_rating_source": "file_tag",
        "gallery_list_block": {
            "summary": {
                "album_preference": dict(private_preference),
                "tag_album_rating": 7,
                "tag_album_rating_source": "file_tag",
            },
        },
    }

    public_payload = strip_private_album_preference_overlays(private_payload)

    assert public_payload["album_preference"]["rating"] is None
    assert public_payload["album_preference"]["can_edit"] is False
    assert public_payload["gallery_list_block"]["summary"]["album_preference"] == public_payload[
        "album_preference"
    ]
    assert public_payload["tag_album_rating"] == 7
    assert public_payload["tag_album_rating_source"] == "file_tag"
    assert public_payload["gallery_list_block"]["summary"]["tag_album_rating"] == 7
    assert private_payload["album_preference"] == private_preference
