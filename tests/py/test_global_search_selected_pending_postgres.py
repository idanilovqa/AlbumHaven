"""Native selected requalification remains explicit, bounded and fail closed."""
from copy import deepcopy
import json

import pytest

from tests.py.test_global_private_search_postgres import db, isolated_urls, connect, result_rows, album_ref, track_refs
from tests.py.global_search_review_support import observe_consumption
from tests.py.test_global_search_review_cursor_postgres import open_cursor, seal_cursor
from tests.py.global_search_pending_contract_support import (
    SELECTED, read, seed_selected, advance, assert_pending, assert_ready,
)

MODES = [("main", "albums", True), ("main", "tracks", True),
         ("main", "albums", False), ("main", "tracks", False),
         ("child", "albums", False), ("child", "tracks", False)]


def bounded(db, trace, mode, omit):
    trace.assert_bounded(db, result_limit=1 if mode == "main" else 100, sidebar=not omit)
    if mode == "child":
        assert trace.count("album") == 0, "Selection-pending child replayed the main Album projection"


@pytest.mark.parametrize("mode,presentation,omit", MODES)
@pytest.mark.parametrize("lost_hint", ["denied", "deleted", "off", "wrong-digest", "wrong-parent"])
def test_selected_scope_pending_resumes_without_advancing_main_or_sidebar_and_becomes_ready(
        db, monkeypatch, mode, presentation, omit, lost_hint):
    parent, params, records = seed_selected(db, presentation, mode, omit_sidebar=omit)
    if lost_hint == "deleted":
        with connect(db.setup) as connection:
            connection.execute("delete from library.local_tracks where id=%s and library_id=%s",
                               (records["witnesses"][0], db.library))
    elif lost_hint == "off":
        db.preference(records["witnesses"][0], "off")
    elif lost_hint in {"wrong-digest", "wrong-parent"}:
        hint = deepcopy(records["selection"]["witness"])
        if lost_hint == "wrong-digest":
            hint["digest"] = "0" * 64
        else:
            other = db.read(artist="Middle Artist", search_presentation="tracks", search_page_size="1", omit_sidebar="1")
            hint = open_cursor(other["page"]["next_cursor"])["selection"]["witness"]
        for key in ("search_cursor", "search_sidebar_cursor"):
            if key in params:
                value = open_cursor(params[key])
                value["selection"]["witness"] = deepcopy(hint)
                params[key] = seal_cursor(value)
        records["selection"]["witness"] = deepcopy(hint)
    seen, examined, last, pending_count = set(), set(), 0, 0
    for _ in range(2 * len(records["witnesses"]) + 2):
        with observe_consumption(monkeypatch) as trace:
            result = read(db, params)
        bounded(db, trace, mode, omit)
        if result["status"] == "ready":
            assert pending_count >= 2, "The denied prefix was not represented by bounded unfinished work"
            assert_ready(result, parent, mode)
            if mode == "main":
                if presentation == "albums":
                    assert [row["album_ref"] for row in result_rows(result)] in ([], [album_ref(db, records["heavy"])])
                else:
                    assert [row["inventory_track_ref"] for row in result["tracks"]] in ([], track_refs(db, [records["stable_tracks"][1]]))
                token = result["page"]["next_cursor"]
                assert token, "There are still later selected witnesses/results"
            else:
                assert all(row["artist"] != SELECTED for row in result["sidebar"]["artists"])
                token = result["sidebar"]["next_cursor"]
                assert token, "The fixture has more than one remaining sidebar page"
            state = open_cursor(token)["selection"]
            assert state["artist"] == records["selection"]["artist"]
            assert state["witness"]["id"] == records["witnesses"][200]
            assert state["witness"] != records["selection"]["witness"]
            assert state["pending"] is None
            return
        state = assert_pending(result, parent, params, mode, records["selection"])
        logical = json.dumps(state, sort_keys=True)
        assert logical not in seen, "Selected requalification repeated the same logical prefix"
        seen.add(logical)
        witness = state["pending"]["pending"]["witness"]["id"]
        assert witness > last
        last = witness
        current = {int(ref) for action, kind, ref in db.decisions
                   if action == "library.browse.read" and kind == "track"}
        # Rechecking the original successful hint is permitted, replaying its
        # already examined denied suffix is not. No ready result work yet.
        current.intersection_update(records["witnesses"][1:200])
        assert not examined & current, "Already exhausted selected witness prefix was replayed"
        examined.update(current)
        pending_count += 1
        params = advance(params, result, mode)
    pytest.fail("Finite selected witness stream never reached fresh proof")


@pytest.mark.parametrize("mode,presentation,omit", MODES)
def test_selected_scope_is_unavailable_only_after_bounded_complete_exhaustion(db, monkeypatch, mode, presentation, omit):
    parent, params, records = seed_selected(db, presentation, mode, omit_sidebar=omit)
    db.denied.update(("track", str(track)) for track in records["witnesses"] + records["stable_tracks"] + records["tail_tracks"])
    # Its current result/sidebar position remains unchanged while the selected
    # scope is unresolved, even if that same result row is also now unreadable.
    pending_count, seen = 0, set()
    for _ in range(2 * len(records["witnesses"]) + 2):
        # Use the normal ASGI adapter directly to observe the real terminal
        # status without predicting the request on which exhaustion is proved.
        from tests.py.asgi_testing import run_asgi_request
        from tests.py.test_global_private_search_postgres import assert_private_payload
        db.sql.clear()
        db.decisions.clear()
        with observe_consumption(monkeypatch) as trace:
            status, headers, body = run_asgi_request(db.app, "GET", "/view-data", query=params,
                headers={"cookie": "__Host-album_haven_session=" + "s" * 43,
                         "x-albumhaven-context": db.context_ref()})
        result = json.loads(body)
        assert {"private", "no-store"} <= {part.strip().lower() for part in headers["cache-control"].split(",")}
        assert_private_payload(result, db)
        bounded(db, trace, mode, omit)
        if status == 409:
            assert pending_count >= 2
            assert result["error_code"] == "search_selection_unavailable"
            assert not {"tracks", "artist_groups", "sidebar", "page"} & result.keys()
            return
        assert status == 200
        state = assert_pending(result, parent, params, mode, records["selection"])
        logical = json.dumps(state, sort_keys=True)
        assert logical not in seen
        seen.add(logical)
        pending_count += 1
        params = advance(params, result, mode)
    pytest.fail("Finite exhausted selected scope never returned selection_unavailable")


@pytest.mark.parametrize("mode,presentation,omit", MODES)
@pytest.mark.parametrize("change", ["artist-denied", "artist-deleted", "artist-reordered", "session", "grant", "membership", "account", "bad-context"])
def test_pending_continuation_rechecks_live_selected_scope_and_durable_authority(
        db, monkeypatch, mode, presentation, omit, change):
    parent, params, records = seed_selected(db, presentation, mode, omit_sidebar=omit)
    result = read(db, params)
    assert_pending(result, parent, params, mode, records["selection"])
    params = advance(params, result, mode)
    status, code, context = 403, "private_search_forbidden", "current"
    if change.startswith("artist-"):
        status, code = 409, "search_selection_unavailable"
    if change == "artist-denied":
        db.denied.add(("artist", str(records["artist"])))
    elif change == "bad-context":
        status, code, context = 409, "stale_context", "0" * 64
    else:
        with connect(db.setup) as connection:
            if change == "artist-deleted":
                connection.execute("delete from library.local_artists where id=%s and library_id=%s", (records["artist"], db.library))
            elif change == "artist-reordered":
                connection.execute("update library.local_artists set name=%s where id=%s and library_id=%s",
                                   ("ZZ Changed Selected Identity", records["artist"], db.library))
                assert connection.execute("select id from library.local_artists where library_id=%s and name=%s",
                                          (db.library, params["artist"])).fetchall() == []
            elif change == "session":
                connection.execute("update app.account_sessions set revoked_at=now() where id=%s", (db.sessions[db.account],))
            elif change == "grant":
                connection.execute("update app.capabilities set revoked_at=now() where account_id=%s", (db.account,))
            elif change == "membership":
                connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s", (db.account, db.library))
            else:
                connection.execute("update app.accounts set is_active=false where id=%s", (db.account,))
    with observe_consumption(monkeypatch) as trace:
        read(db, params, expected=status, code=code, context=context)
    assert trace.count("track") <= 101
    assert sum(max(size, 0) for kind, size, _names, _sql in trace.statements if kind == "track") <= 101


@pytest.mark.parametrize("mode,presentation,omit", MODES)
@pytest.mark.parametrize("change", ["candidate", "outer-anchor", "hint", "malformed-witness"])
def test_real_pending_cursor_rejects_structural_tampering_without_broadening(db, mode, presentation, omit, change):
    parent, params, records = seed_selected(db, presentation, mode, omit_sidebar=omit)
    result = read(db, params)
    assert_pending(result, parent, params, mode, records["selection"])
    params = advance(params, result, mode)
    key = "search_sidebar_cursor" if mode == "child" else "search_cursor"
    value = open_cursor(params[key])
    state = value["selection"]
    if change == "candidate":
        state["pending"]["pending"]["candidate"]["id"] += 1
    elif change == "outer-anchor":
        state["pending"]["anchor"] = state["artist"]
    elif change == "hint":
        state["pending"]["anchor_witness"] = state["witness"]
    else:
        state["pending"]["pending"]["witness"]["id"] = True
    params[key] = seal_cursor(value)
    read(db, params, expected=400, code="invalid_private_search_request")


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_sidebar_child_rejects_even_full_payload_tier_while_main_keeps_full_support(db, presentation):
    from tests.py.global_search_sidebar_review_support import seed_parent, child_params
    parent, _records, _order = seed_parent(db, presentation, "selected")
    params = {**child_params(parent), "payload_tier": "full"}
    read(db, params, expected=400, code="invalid_private_search_request")
    assert db.sql == [], "Invalid child-only tier was not rejected before inventory SQL"
    db.read(artist=parent["selected_artist"], search_presentation=presentation, payload_tier="full")
