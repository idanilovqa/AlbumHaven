"""Review B5: keep native Playlist/Tops query owners and global admission.

Playlist tests use the established guarded disposable-Postgres fixture, actual
/view-data middleware/dispatch and existing PostgresOwnedPlaylistsService. No
Playlist or Search service/SQL result is replaced. Each fixture owns its seeded
playlists and deletes them before the shared database fixture's teardown.

The separate ordinary transport tests double only ordinary browse repository
I/O. They do not establish ordinary SQL correctness or authentication storage.
No proposed Search module is imported by this additive suite.
"""
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI

from music_app.routes import api_read_asgi_routes as routes
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.private_route_boundary import install_private_route_boundary
from tests.py.asgi_testing import run_asgi_request
from tests.py.test_global_private_search_postgres import (
    BROWSE, HMAC, connect, db, isolated_urls,
)


TITLES = ("Mix: 2026", "Evening :loved selections", "@night listening",
          "Cafe@home", "Chill afternoon")


@pytest.fixture
def native_playlists(db):
    rows = []
    # All references are generated for this one test. The secondary account and
    # library are already uniquely owned by the established guarded PG fixture.
    for index, title in enumerate(TITLES):
        rows.append({"ref": str(uuid4()), "title": title, "owner": db.account,
                     "library": db.library, "scope": "own", "index": index})
        rows.append({"ref": str(uuid4()), "title": title + " private-other-account",
                     "owner": db.accounts[1], "library": db.library,
                     "scope": "other_account", "index": index})
        rows.append({"ref": str(uuid4()), "title": title + " other-library",
                     "owner": db.account, "library": db.libraries[1],
                     "scope": "other_library", "index": index})
    try:
        with connect(db.setup) as connection:
            assert connection.execute("select to_regclass('app.playlists') as name").fetchone()["name"], (
                "Normal hosted Playlist migrations are required")
            for row in rows:
                connection.execute("""insert into app.playlists
                    (ref, owner_account_id, library_id, title, description, visibility, updated_at)
                    values (%s, %s, %s, %s, '', 'private', %s + %s * interval '1 second')""",
                    (row["ref"], row["owner"], row["library"], row["title"], db.now, row["index"]))
        yield SimpleNamespace(db=db, rows=rows)
    finally:
        with connect(db.setup) as connection:
            connection.execute("""delete from app.playlists
                where ref=any(%s::uuid[]) and library_id=any(%s::bigint[])""",
                ([row["ref"] for row in rows], db.libraries))


def native_read(fixture, query, *, context=False):
    headers = {"cookie": "__Host-album_haven_session=" + "s" * 43}
    if context:
        headers["x-albumhaven-context"] = fixture.db.context_ref()
    fixture.db.sql.clear()
    fixture.db.decisions.clear()
    status, response_headers, body = run_asgi_request(
        fixture.db.app, "GET", "/view-data", query={"surface": "playlists", "q": query}, headers=headers)
    assert {"private", "no-store"} <= {
        part.strip().lower() for part in response_headers["cache-control"].split(",")}
    return status, json.loads(body)


@pytest.mark.parametrize("query", ["Mix: 2026", ":loved", "@night", "Cafe@home", "  mix: 2026  ", "Chill"])
@pytest.mark.parametrize("context", [False, True], ids=["no-search-context", "matching-context"])
def test_native_playlist_title_search_keeps_colon_and_at_substring_semantics(
        native_playlists, query, context):
    status, payload = native_read(native_playlists, query, context=context)
    assert status == 200, (status, payload)
    assert payload["query"] == query
    assert payload["playlist_index"]["query"] == query
    assert payload["context_ref"] == native_playlists.db.context_ref()
    assert "private_search" not in payload and "error_code" not in payload
    expected = [row for row in native_playlists.rows
                if row["scope"] == "own" and query.strip().casefold() in row["title"].casefold()]
    expected.sort(key=lambda row: (row["index"], row["ref"]), reverse=True)
    cards = payload["playlist_index"]["playlists"]
    assert [card["playlist_id"] for card in cards] == [row["ref"] for row in expected]
    assert [card["title"] for card in cards] == [row["title"] for row in expected]
    assert cards, "The fixture must contain a real native title match"
    for card in cards:
        assert card["allowed_actions"]["can_read"] is True
        assert card["allowed_actions"]["can_play"] is False
        assert card["allowed_actions"]["can_edit"] is False
    assert payload["playlist_actions"]["can_create"] is False
    own_refs = {row["ref"] for row in native_playlists.rows if row["scope"] == "own"}
    assert {row["playlist_id"] for row in payload["playlist_sidebar"]["items"]} == own_refs
    serialized = json.dumps(payload)
    assert "private-other-account" not in serialized and "other-library" not in serialized
    assert any("from app.playlists" in statement.casefold() for statement, _count in native_playlists.db.sql)
    assert not any(statement.lstrip().casefold().startswith(("insert ", "update ", "delete ", "merge "))
                   for statement, _count in native_playlists.db.sql)
    # This proves current-session revalidation in the real reader, not merely
    # a route stub returning a canned playlist_index.
    assert sum("from app.account_sessions" in statement.casefold()
               for statement, _count in native_playlists.db.sql) >= 2


@pytest.mark.parametrize("query", ["Mix: 2026", "@night"])
def test_native_playlist_query_still_enforces_live_revoked_browse_grant(native_playlists, query):
    db = native_playlists.db
    with connect(db.setup) as connection:
        connection.execute("""update app.capabilities set revoked_at=now()
            where account_id=%s and scope_kind='library' and scope_id=%s and capability_key=%s""",
            (db.account, db.library, BROWSE))
    # The actor adapter intentionally still claims its original browse grant;
    # the unchanged authorized Playlist read must reload current durable truth.
    status, payload = native_read(native_playlists, query)
    assert status == 403
    assert payload == {"ok": False, "error": "forbidden"}
    assert not any("from app.playlists" in statement.casefold() for statement, _count in db.sql)


@pytest.mark.parametrize("query", [":loved", "love:loved", ":obsessed", "love:obsessed"])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_global_personal_missing_context_precedes_real_transient_and_selected_artist_dispatch(
        db, query, presentation):
    # Real scan-state resolution and branch predicate remain active. The shared
    # fixture's forbidden ordinary producer asserts against fallback before any
    # untrusted sentinel needs to be projected as an actual Album object.
    db.app.state.library_state.update(
        scan_in_progress=True, scan_generation=1,
        active_scan_preview_state={"scan_generation": 1, "publication_state": {},
            "browse_snapshot": {"albums": [{"key": "unfiltered-scan-sentinel"}],
                                "file_cache": {}, "separate_release_keys": set()}})
    browse = routes.resolve_active_scan_browse_state(db.app.state.library_state)
    assert routes._should_use_transient_scan_browse_state(db.app.state.library_state, browse)
    db.read(query, expected=409, code="stale_context", context="",
            artist="Middle Artist", search_presentation=presentation)
    assert db.sql == [], "Missing context must fail before any private database read"


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_explicit_global_surface_reaches_private_owner_after_native_navigation(db, presentation):
    # Global UI transitions must select this existing Albums transport explicitly.
    # The reader and witness SQL are real; title semantics on Playlists remain
    # independently tested above.
    payload = db.read(":loved", search_presentation=presentation, artist="Middle Artist")
    assert payload["presentation"] == presentation
    assert payload["selected_artist"] == "Middle Artist"
    assert payload["page"]["returned_count"] == (1 if presentation == "albums" else 2)
    assert "playlist_index" not in payload and "top_ref" not in payload


@pytest.mark.parametrize("query", ["Mix: 2026", "@night", ":loved"])
def test_native_tops_keeps_its_existing_invalid_query_error_owner(db, query):
    status, headers, body = run_asgi_request(db.app, "GET", "/view-data",
        query={"surface": "album_tops", "q": query})
    assert status == 400
    assert json.loads(body) == {"ok": False, "error": "invalid_query"}
    assert {"private", "no-store"} <= {part.strip().lower() for part in headers["cache-control"].split(",")}


@pytest.fixture
def ordinary_transport(monkeypatch):
    """Exercise ordinary HTTP success with no new private Search context header."""
    calls = []
    current = CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8,
        current_library_id=73, library_relationships=(LibraryRelationship(73, "member", False),),
        capability_grants=(CapabilityGrant(BROWSE, "library", 73),))
    app = FastAPI()
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = HMAC
    app.state.library_state = {"albums": [], "scan_in_progress": False}
    app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: current)
    app.include_router(routes.router)
    install_private_route_boundary(app)

    class OrdinaryRepository:
        def __init__(self, _config):
            pass

        def payload(self, *, query_params, library_state):
            calls.append(list(query_params.multi_items()))
            return {"query": query_params.get("q", ""), "artist_groups": [
                {"artist": "Ordinary Artist", "albums": [{"name": "Ordinary Search Album"}]}],
                "artists_sidebar": [], "non_album_tracks": [], "album_count": 1}

        build_search_payload = payload
        build_selected_artist_payload = payload

    monkeypatch.setattr(routes, "PostgresLibraryBrowseRepository", OrdinaryRepository)
    monkeypatch.setattr(routes, "select_runtime_persistence_adapter",
        lambda *_args: SimpleNamespace(effective_backend=routes.PERSISTENCE_BACKEND_POSTGRES))
    return SimpleNamespace(app=app, calls=calls)


@pytest.mark.parametrize("artist", [None, "Ordinary Artist"], ids=["ordinary-search", "selected-artist"])
def test_ordinary_view_data_success_does_not_acquire_private_search_context_requirement(ordinary_transport, artist):
    query = {"surface": "albums", "q": "ordinary text"}
    if artist is not None:
        query["artist"] = artist
    status, headers, body = run_asgi_request(ordinary_transport.app, "GET", "/view-data", query=query)
    assert status == 200, body
    payload = json.loads(body)
    assert payload["query"] == "ordinary text"
    assert payload["artist_groups"][0]["albums"][0]["name"] == "Ordinary Search Album"
    assert "private_search" not in payload and "error_code" not in payload
    assert len(ordinary_transport.calls) == 1
    assert {"private", "no-store"} <= {part.strip().lower() for part in headers["cache-control"].split(",")}
