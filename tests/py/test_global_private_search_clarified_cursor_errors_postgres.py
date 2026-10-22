"""Root-clarified error causes through actual native main and child reads.

Published assertions with the older stale_context meaning remain untouched.
Each changed anchor is distinct from the selected parent scope where relevant.
"""
from datetime import timedelta
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services.current_actor import CurrentActor
from tests.py.test_global_private_search_postgres import db, isolated_urls, connect
from tests.py.global_search_sidebar_review_support import seed_parent, child_params, child_read, SELECTED


CATEGORIES = ["main_library", "hoard"]


def initial(db, mode, *, selected=False):
    parent, records, order = seed_parent(db, "tracks", "selected" if selected else "all_artists", categories=True)
    if mode == "child":
        return parent, records, order, {**child_params(parent), "category": CATEGORIES}
    if selected:
        _artist, album, _track = records[SELECTED]
        db.track(album, "Second Selected Parent Witness")
    choices = {"artist": SELECTED} if selected else {"all_artists": "1"}
    parent = db.read(search_presentation="tracks", search_page_size="1", category=CATEGORIES, **choices)
    assert parent["page"]["next_cursor"]
    return parent, records, order, {"surface": "albums", "q": parent["query"], "search_presentation": "tracks",
        "search_page_size": "1", "search_cursor": parent["page"]["next_cursor"], "category": CATEGORIES, **choices}


def reject(db, mode, params, *, status=409, code, context="current"):
    # The raw native HTTP adapter's error assertions are common to main/child;
    # it does not require or synthesize a success shape for either one.
    child_read(db, params, expected=status, code=code, context=context)


@pytest.mark.parametrize("mode", ["main", "child"])
@pytest.mark.parametrize("change", ["query", "presentation", "artist", "category"])
def test_same_current_context_criteria_mismatch_requires_restart_not_parent_context_retirement(db, mode, change):
    _parent, _records, _order, params = initial(db, mode, selected=True)
    context = db.context_ref()
    if change == "query":
        params["q"] = ":obsessed"
    elif change == "presentation":
        params["search_presentation"] = "albums"
    elif change == "artist":
        params["artist"] = "BBB Sidebar 001"
    else:
        params["category"] = ["hoard"]
    assert db.context_ref() == context
    reject(db, mode, params, code="search_cursor_restart_required", context=context)


@pytest.mark.parametrize("mode", ["main", "child"])
@pytest.mark.parametrize("change", ["account", "session", "library", "missing-header", "bad-header"])
def test_true_actor_session_library_or_context_continuity_loss_is_stale_context(db, mode, change):
    _parent, _records, _order, params = initial(db, mode)
    context = "current"
    if change == "account":
        db.account = db.accounts[1]
    elif change == "library":
        db.library = db.libraries[1]
    elif change == "session":
        with connect(db.setup) as connection:
            session = connection.execute("""insert into app.account_sessions
                (account_id,session_token_hash,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
                values(%s,%s,%s,%s,%s,%s,%s) returning id""",
                (db.account, sha256(uuid4().bytes).digest(), db.now, db.now, db.now,
                 db.now + timedelta(hours=12), db.now + timedelta(days=1))).fetchone()["id"]
        db.sessions[db.account] = session
    elif change == "missing-header":
        context = None
    else:
        context = "0" * 64
    reject(db, mode, params, code="stale_context", context=context)


@pytest.mark.parametrize("mode", ["main", "child"])
@pytest.mark.parametrize("change", ["deny-track", "deny-album", "deny-artist", "delete", "reorder"])
def test_unreadable_or_moved_cursor_anchor_is_restart_while_parent_context_is_current(db, mode, change):
    _parent, records, order, params = initial(db, mode)
    name = order[49] if mode == "child" else SELECTED
    artist, album, track = records[name]
    before_context = db.context_ref()
    if change.startswith("deny-"):
        kind = change.removeprefix("deny-")
        db.denied.add((kind, str({"track": track, "album": album, "artist": artist}[kind])))
    else:
        with connect(db.setup) as connection:
            if change == "delete":
                connection.execute("delete from library.local_tracks where id=%s and library_id=%s", (track, db.library))
            elif mode == "child":
                connection.execute("update library.local_artists set name=%s where id=%s and library_id=%s",
                                   ("ZZ Changed Cursor Anchor", artist, db.library))
            else:
                connection.execute("update library.local_albums set release_year=1970 where id=%s and library_id=%s", (album, db.library))
    assert db.context_ref() == before_context
    reject(db, mode, params, code="search_cursor_restart_required")


@pytest.mark.parametrize("mode", ["main", "child"])
@pytest.mark.parametrize("change", ["deny-all-witnesses", "deny-selected-artist", "unresolvable", "no-longer-matching"])
def test_selected_scope_loss_is_selection_unavailable_not_child_anchor_restart(db, mode, change):
    parent, records, order, params = initial(db, mode, selected=True)
    assert parent["selected_artist"] == SELECTED
    assert order[49] != SELECTED, "Child anchor must be separate from selected parent scope"
    artist, album, _track = records[SELECTED]
    tracks = [track for track, value in db.tracks.items() if value["album"] == album]
    context = db.context_ref()
    if change == "deny-all-witnesses":
        db.denied.update(("track", str(track)) for track in tracks)
    elif change == "deny-selected-artist":
        db.denied.add(("artist", str(artist)))
    else:
        with connect(db.setup) as connection:
            if change == "unresolvable":
                connection.execute("delete from library.local_artists where id=%s and library_id=%s", (artist, db.library))
            else:
                connection.execute("""update app.track_preferences set love_tier='off'
                    where account_id=%s and library_id=%s and track_id=any(%s::bigint[])""",
                    (db.account, db.library, tracks))
    assert db.context_ref() == context
    reject(db, mode, params, code="search_selection_unavailable")


@pytest.mark.parametrize("mode", ["main", "child"])
@pytest.mark.parametrize("token", ["", "not-a-cursor", "../private-invalid-cursor"])
def test_malformed_cursor_is_private_invalid_request_with_no_silent_restart(db, mode, token):
    _parent, _records, _order, params = initial(db, mode)
    params["search_sidebar_cursor" if mode == "child" else "search_cursor"] = token
    reject(db, mode, params, status=400, code="invalid_private_search_request")
    assert db.sql == []


@pytest.mark.parametrize("change", ["membership", "grant", "account", "session"])
def test_sidebar_child_rechecks_durable_authority_instead_of_trusting_its_parent(db, change):
    _parent, _records, _order, params = initial(db, "child")
    with connect(db.setup) as connection:
        if change == "membership":
            connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (db.account, db.library))
        elif change == "grant":
            connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (db.account,))
        elif change == "account":
            connection.execute("update app.accounts set is_active=false where id=%s", (db.account,))
        else:
            connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.sessions[db.account],))
    reject(db, "child", params, status=403, code="private_search_forbidden")


def test_sidebar_child_anonymous_actor_is_rejected_by_real_middleware(db):
    _parent, _records, _order, params = initial(db, "child")
    db.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: CurrentActor.anonymous())
    child_read(db, params, expected=401, context=None)
