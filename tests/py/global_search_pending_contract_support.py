"""New adapters around the unchanged guarded disposable PostgreSQL fixture."""
import json
import re

from tests.py.asgi_testing import run_asgi_request
from tests.py.test_global_private_search_postgres import connect, assert_private_payload
from tests.py.global_search_review_support import bulk_tracks
from tests.py.test_global_search_review_cursor_postgres import open_cursor

SELECTED = "AAA Pending Selected Artist"


def read(db, params, *, expected=200, code=None, context="current"):
    db.sql.clear()
    db.decisions.clear()
    headers = {"cookie": "__Host-album_haven_session=" + "s" * 43}
    if context is not None:
        headers["x-albumhaven-context"] = db.context_ref() if context == "current" else context
    status, response_headers, body = run_asgi_request(db.app, "GET", "/view-data", query=params, headers=headers)
    result = json.loads(body)
    assert status == expected, (status, result)
    assert {"private", "no-store"} <= {word.strip().lower() for word in response_headers["cache-control"].split(",")}
    assert_private_payload(result, db)
    assert not any(re.match(r"\s*(insert|update|delete|merge)\b", sql, re.I) for sql, _count in db.sql)
    if expected != 200:
        if code is not None:
            assert result["error_code"] == code
        assert not {"tracks", "artist_groups", "sidebar", "page", "music_dir"} & result.keys()
        return result
    assert result["private_search"] is True and result["contract_version"] == "own-love-v1"
    assert result["context_ref"] == db.context_ref()
    assert result["query"] == params["q"]
    return result


def seed_selected(db, presentation, mode, *, omit_sidebar=False):
    artist = db.artist(SELECTED)
    heavy = db.album(artist, "ZZ Heavy Selection Witnesses")
    witnesses = bulk_tracks(db, heavy, 205, title="Selected Requalification Witness")
    # Native main ordering starts with another still-readable Album/Track. Its
    # cursor anchor is independent of the selected witness that will be lost.
    stable = db.album(artist, "AA Stable Main Anchor")
    stable_tracks = [db.track(stable, "Stable Main Witness " + str(n), number=n) for n in (1, 2)]
    tail = db.album(artist, "ZZZ Selected Tail")
    tail_tracks = [db.track(tail, "Selected Tail Witness")]
    for index in range(101):
        other = db.artist("BBB Pending Sidebar " + str(index).zfill(3))
        db.track(db.album(other, "Sidebar Fixture Album"), "Sidebar Fixture Witness")
    parent_params = {"artist": SELECTED, "search_presentation": presentation, "search_page_size": "1"}
    if omit_sidebar:
        parent_params["omit_sidebar"] = "1"
    # This is the existing route capability gate. No future service is imported.
    parent = db.read(**parent_params)
    assert parent["status"] == "ready" and parent["selection_state"] == "selected"
    assert parent["selected_artist"] == SELECTED and parent["page"]["next_cursor"]
    params = {"surface": "albums", "q": parent["query"], **parent_params}
    if mode == "child":
        assert not omit_sidebar
        assert parent["sidebar"]["next_cursor"]
        params.pop("search_page_size")
        params.update(search_sidebar_only="1", search_sidebar_cursor=parent["sidebar"]["next_cursor"])
    else:
        params["search_cursor"] = parent["page"]["next_cursor"]
        if not omit_sidebar:
            assert parent["sidebar"]["next_cursor"]
            params["search_sidebar_cursor"] = parent["sidebar"]["next_cursor"]
    token = params["search_sidebar_cursor" if mode == "child" else "search_cursor"]
    selection = open_cursor(token)["selection"]
    assert selection["artist"]["id"] == artist and selection["witness"]["id"] == witnesses[0]
    assert selection["pending"] is None
    db.denied.update(("track", str(track)) for track in witnesses[:200])
    return parent, params, {"artist": artist, "heavy": heavy, "stable": stable,
                            "witnesses": witnesses, "stable_tracks": stable_tracks, "tail_tracks": tail_tracks, "selection": selection}


def advance(params, result, mode):
    values = dict(params)
    if mode == "main":
        assert result["page"]["next_cursor"]
        values["search_cursor"] = result["page"]["next_cursor"]
    if result["sidebar"] is not None:
        assert result["sidebar"]["next_cursor"]
        values["search_sidebar_cursor"] = result["sidebar"]["next_cursor"]
    return values


def assert_pending(result, parent, params, mode, selection):
    common = {"status", "private_search", "contract_version", "context_ref", "query", "criteria", "presentation",
              "selection_state", "selected_artist", "selection_pending", "sidebar"}
    assert set(result) == common | ({"sidebar_only"} if mode == "child" else {"artist_groups", "tracks", "page"})
    assert result["status"] == "pending" and result["selection_pending"] is True
    assert result["selection_state"] == "selected" and result["selected_artist"] == SELECTED
    for key in ("query", "criteria", "presentation", "context_ref", "selected_artist", "selection_state"):
        assert result[key] == parent[key]
    tokens = []
    if mode == "child":
        assert result["sidebar_only"] is True
    else:
        assert result["tracks"] == [] and result["artist_groups"] == []
        page = result["page"]
        assert set(page) == {"limit", "returned_count", "has_more", "next_cursor"}
        assert page["limit"] == int(params["search_page_size"])
        assert page["returned_count"] == 0 and page["has_more"] is True and page["next_cursor"]
        tokens.append((page["next_cursor"], params["search_cursor"]))
    if params.get("omit_sidebar") == "1":
        assert result["sidebar"] is None
    else:
        side = result["sidebar"]
        assert set(side) == {"artists", "returned_count", "has_more", "next_cursor"}
        assert side["artists"] == [] and side["returned_count"] == 0
        assert side["has_more"] is True and side["next_cursor"]
        tokens.append((side["next_cursor"], params["search_sidebar_cursor"]))
    states = []
    for next_token, prior_token in tokens:
        current, prior = open_cursor(next_token), open_cursor(prior_token)
        for key in ("version", "scope", "kind", "position"):
            assert current[key] == prior[key], "Indeterminate selection advanced an independent result/sidebar position"
        state = current["selection"]
        assert set(state) == {"state", "artist", "witness", "pending"}
        assert state["state"] == "selected"
        assert state["artist"] == selection["artist"] and state["witness"] == selection["witness"]
        assert set(state["pending"]) == {"anchor", "pending"}
        assert state["pending"]["anchor"] is None
        progress = state["pending"]["pending"]
        assert set(progress) == {"candidate", "witness"}
        assert progress["candidate"] == state["artist"]
        assert progress["witness"] is not None
        states.append(state)
    assert states and all(state == states[0] for state in states)
    return states[0]


def assert_ready(result, parent, mode):
    assert result["status"] == "ready" and "selection_pending" not in result
    common = {"status", "private_search", "contract_version", "context_ref", "query", "criteria", "presentation",
              "selection_state", "selected_artist", "sidebar"}
    assert set(result) == common | ({"sidebar_only"} if mode == "child" else {"artist_groups", "tracks", "page"})
    for key in ("query", "criteria", "presentation", "context_ref", "selected_artist", "selection_state"):
        assert result[key] == parent[key]
    if mode == "child":
        assert result["sidebar_only"] is True
    cursors = ([result["page"]["next_cursor"]] if mode == "main" else [])
    if result["sidebar"] is not None:
        cursors.append(result["sidebar"]["next_cursor"])
    for token in filter(None, cursors):
        assert open_cursor(token)["selection"]["pending"] is None
