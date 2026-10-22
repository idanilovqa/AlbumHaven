"""Native route/fixture adapters for the approved sidebar-only read mode."""
import json
import re

from tests.py.asgi_testing import run_asgi_request
from tests.py.test_global_private_search_postgres import connect, assert_private_payload


SELECTED = "AAA Stable Sidebar Parent"


def seed_parent(db, presentation="albums", selection="all_artists", *, categories=False):
    records = {}
    for name in [SELECTED, *["BBB Sidebar " + str(index).zfill(3) for index in range(51)]]:
        artist = db.artist(name)
        album = db.album(artist, "Sidebar Album " + name)
        track = db.track(album, "Sidebar Witness " + name)
        records[name] = (artist, album, track)
    params = {"search_presentation": presentation}
    params.update(artist=SELECTED) if selection == "selected" else params.update(all_artists="1")
    if categories:
        params["category"] = ["main_library", "hoard", "main_library"]
    parent = db.read(**params)
    assert parent["selection_state"] == selection
    assert parent["sidebar"]["next_cursor"]
    assert parent["sidebar"]["returned_count"] == 50
    with connect(db.setup) as connection:
        order = [row["name"] for row in connection.execute("""select name from library.local_artists
            where library_id=%s order by name,id""", (db.library,)).fetchall()]
    assert [row["artist"] for row in parent["sidebar"]["artists"]] == order[:50]
    return parent, records, order


def child_params(parent):
    values = {"surface": "albums", "q": parent["query"], "search_sidebar_only": "1",
              "search_presentation": parent["presentation"],
              "search_sidebar_cursor": parent["sidebar"]["next_cursor"]}
    if parent["selection_state"] == "selected":
        values["artist"] = parent["selected_artist"]
    else:
        values["all_artists"] = "1"
    return values


def child_read(db, params, *, expected=200, code=None, context="current", parent=None):
    db.sql.clear()
    db.decisions.clear()
    headers = {"cookie": "__Host-album_haven_session=" + "s" * 43}
    if context is not None:
        headers["x-albumhaven-context"] = db.context_ref() if context == "current" else context
    status, response_headers, body = run_asgi_request(db.app, "GET", "/view-data", query=params, headers=headers)
    data = json.loads(body)
    assert status == expected, (status, data)
    assert {"private", "no-store"} <= {
        word.strip().lower() for word in response_headers["cache-control"].split(",")}
    assert_private_payload(data, db)
    if expected != 200:
        if code is not None:
            assert data.get("error_code", data.get("error")) == code
        assert not {"tracks", "artist_groups", "sidebar", "page", "music_dir"} & data.keys()
        return data
    assert parent is not None
    assert set(data) == {"status", "private_search", "contract_version", "sidebar_only", "context_ref",
                         "query", "criteria", "presentation", "selected_artist", "selection_state", "sidebar"}
    assert data["status"] == "ready" and data["private_search"] is True
    assert data["contract_version"] == "own-love-v1" and data["sidebar_only"] is True
    assert data["context_ref"] == db.context_ref()
    for key in ("query", "criteria", "presentation", "selected_artist", "selection_state"):
        assert data[key] == parent[key]
    side = data["sidebar"]
    assert set(side) == {"artists", "returned_count", "has_more", "next_cursor"}
    assert side["returned_count"] == len(side["artists"]) <= 50
    assert type(side["has_more"]) is bool and bool(side["next_cursor"]) is side["has_more"]
    for row in side["artists"]:
        assert set(row) == {"artist", "artist_display"}
        assert isinstance(row["artist"], str) and row["artist"]
        assert row["artist_display"] == row["artist"]
    assert not any(re.match(r"\s*(insert|update|delete|merge)\b", sql, re.I) for sql, _count in db.sql)
    return data


def assert_only_sidebar_sql(trace, db):
    trace.assert_bounded(db)
    assert trace.count("album") == 0, "Sidebar child executed an Album result projection"
    for kind, _size, _columns, statement in trace.statements:
        if kind == "track":
            final_order = re.sub(r"\s+", " ", statement.casefold()).rsplit("order by", 1)[-1]
            # Existing native witness identity resolution/qualification uses
            # Track-ID order. Main Tracks/detail selectors use parent/detail
            # tuples and must not be replayed merely to produce sidebar DTOs.
            assert not any(field in final_order for field in (
                "artist_name", "album_release_year", "album_title", "album_key", "disc_number", "track_number", "title")), statement
        assert not re.search(r"\bselect\s+count\s*\(\s*\*\s*\)\s+from\s+(?:witnesses|search_facts)", statement, re.I)
