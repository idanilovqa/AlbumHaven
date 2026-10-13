"""R3: classifier exemptions cannot exceed the existing native dispatch owner.

Playlists historically casefolds without stripping; Tops strips and casefolds.
These tests preserve those accepted values. Whitespace-padded Playlist values
with personal syntax must reject safely, not acquire a newly invented alias or
enter the ordinary/file-backed/transient producer. Existing exact-surface
coverage remains independently protected.
"""
import json

import pytest

from music_app.routes import api_read_asgi_routes as routes
from tests.py.asgi_testing import run_asgi_request
from tests.py.test_global_private_search_postgres import BROWSE, db, isolated_urls, connect
from tests.py.test_global_search_review_surface_dispatch import native_playlists
from tests.py.test_global_search_review_cold_dispatch import cold_dispatch, empty_shell, dispatch_hydration


def forbid_fallback(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Surface dispatch bypassed the protected native owner into ordinary/transient fallback")
    for name in ("_transient_scan_view_response", "_hydrate_cached_library_for_asgi", "build_view_payload"):
        monkeypatch.setattr(routes, name, forbidden)


def configure_scan(db, enabled):
    if not enabled:
        return
    db.app.state.library_state.update(scan_in_progress=True, scan_generation=1,
        active_scan_preview_state={"scan_generation": 1, "publication_state": {},
            "browse_snapshot": {"albums": [{"key": "unfiltered-normalization-sentinel"}],
                                "file_cache": {}, "separate_release_keys": set()}})
    browse = routes.resolve_active_scan_browse_state(db.app.state.library_state)
    assert routes._should_use_transient_scan_browse_state(db.app.state.library_state, browse)


def surface_read(db, surface, query, *, context):
    headers = {"cookie": "__Host-album_haven_session=" + "s" * 43}
    if context:
        headers["x-albumhaven-context"] = db.context_ref()
    db.sql.clear()
    status, response_headers, body = run_asgi_request(db.app, "GET", "/view-data",
        query={"surface": surface, "q": query}, headers=headers)
    assert {"private", "no-store"} <= {
        value.strip().lower() for value in response_headers["cache-control"].split(",")}
    return status, json.loads(body)


@pytest.mark.parametrize("surface", ["playlists", "PLAYLISTS", "PlayLists"])
@pytest.mark.parametrize("query", [":loved", "@night"])
@pytest.mark.parametrize("scan", [False, True], ids=["ordinary-state", "live-transient-state"])
@pytest.mark.parametrize("context", [False, True], ids=["no-search-context", "matching-context"])
def test_existing_playlist_casefold_variants_stay_on_real_native_reader(
        native_playlists, monkeypatch, surface, query, scan, context):
    db = native_playlists.db
    forbid_fallback(monkeypatch)
    configure_scan(db, scan)
    status, payload = surface_read(db, surface, query, context=context)
    assert status == 200, (status, payload)
    expected = [row for row in native_playlists.rows
                if row["scope"] == "own" and query.casefold() in row["title"].casefold()]
    expected.sort(key=lambda row: (row["index"], row["ref"]), reverse=True)
    assert expected
    assert payload["playlist_index"]["query"] == query
    assert [row["playlist_id"] for row in payload["playlist_index"]["playlists"]] == [row["ref"] for row in expected]
    assert payload["context_ref"] == db.context_ref()
    assert "private_search" not in payload
    assert any("from app.playlists" in sql.casefold() for sql, _count in db.sql)
    serialized = json.dumps(payload)
    assert "private-other-account" not in serialized and "other-library" not in serialized


@pytest.mark.parametrize("surface", [" playlists ", "\tPLAYLISTS\n"])
@pytest.mark.parametrize("query", [":loved", "@night"])
@pytest.mark.parametrize("scan", [False, True], ids=["ordinary-state", "live-transient-state"])
@pytest.mark.parametrize("context", [False, True], ids=["no-search-context", "matching-context"])
def test_noncanonical_playlist_surface_with_personal_query_fails_closed_before_fallback(
        db, monkeypatch, surface, query, scan, context):
    forbid_fallback(monkeypatch)
    configure_scan(db, scan)
    status, payload = surface_read(db, surface, query, context=context)
    assert status == 400, (status, payload)
    assert payload["error_code"] == "invalid_private_search_request"
    assert not {"tracks", "artist_groups", "playlist_index", "sidebar", "music_dir"} & payload.keys()
    assert db.sql == [], "Malformed surface must fail before protected membership SQL"


@pytest.mark.parametrize("surface", ["playlists", "PLAYLISTS", "PlayLists"])
@pytest.mark.parametrize("query", [":loved", "@night"])
def test_native_casefold_playlist_reader_still_rechecks_durable_grant_with_live_scan(
        native_playlists, monkeypatch, surface, query):
    db = native_playlists.db
    forbid_fallback(monkeypatch)
    configure_scan(db, True)
    with connect(db.setup) as connection:
        connection.execute("""update app.capabilities set revoked_at=now()
            where account_id=%s and scope_kind='library' and scope_id=%s and capability_key=%s""",
            (db.account, db.library, BROWSE))
    status, payload = surface_read(db, surface, query, context=False)
    assert status == 403
    assert payload == {"ok": False, "error": "forbidden"}
    assert not any("from app.playlists" in sql.casefold() for sql, _count in db.sql)


@pytest.mark.parametrize("surface", ["album_tops", "ALBUM_TOPS", " album_tops "])
@pytest.mark.parametrize("query", [":loved", "@night"])
def test_existing_tops_strip_and_casefold_variants_keep_native_invalid_query_owner(db, monkeypatch, surface, query):
    forbid_fallback(monkeypatch)
    configure_scan(db, True)
    status, payload = surface_read(db, surface, query, context=False)
    assert status == 400
    assert payload == {"ok": False, "error": "invalid_query"}
    assert db.sql == []


@pytest.mark.parametrize("surface", [" playlists ", "\tPLAYLISTS\n"])
@pytest.mark.parametrize("query", [":loved", "@night"])
def test_noncanonical_playlist_personal_cold_entry_preserves_invalidity_to_native_rejection(cold_dispatch, surface, query):
    shell = empty_shell(cold_dispatch, [("surface", surface), ("q", query), ("artist", "Requested Artist")])
    dispatch_hydration(cold_dispatch, shell, status=400,
                       code="invalid_private_search_request", context=True)
