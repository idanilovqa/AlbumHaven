"""Real issued anchor hints are efficiency evidence, never saved authority."""
from copy import deepcopy
import json

import pytest

from tests.py.test_global_private_search_postgres import db, isolated_urls, connect, result_rows, album_ref
from tests.py.global_search_review_support import observe_consumption
from tests.py.test_global_search_review_cursor_postgres import open_cursor, seal_cursor, first_cursor
from tests.py.test_global_search_visible_anchor_liveness_postgres import (
    MODES, fixture_records, params_for, cursor_of, identifiers,
)


def seeded_anchor(db, kind, presentation):
    artist, album, tracks, following = fixture_records(db, count=205)
    db.denied.update(("track", str(track)) for track in tracks[1:200])
    prefix = []
    if kind == "sidebar":
        for index in range(49):
            name = "000 Anchor Hint Prefix " + str(index).zfill(3)
            prefix.append(name)
            row_artist = db.artist(name)
            db.track(db.album(row_artist, "Prefix Album"), "Prefix Witness")
    params = params_for(kind, presentation)
    parent = db.read(**params)
    expected = [album_ref(db, album)] if kind == "albums" else [*prefix, "AAA Heavy Visible Anchor"]
    assert identifiers(parent, kind) == expected
    value = open_cursor(cursor_of(parent, kind))
    assert value["position"]["anchor"]["id"] == (album if kind == "albums" else artist)
    hint = value["position"].get("anchor_witness")
    assert hint is not None and hint["id"] == tracks[0] and hint["readable"] is True
    return parent, params, value, (artist, album, tracks, following, prefix)


def assert_safe_cursor(value, db):
    def walk(node):
        if isinstance(node, dict):
            assert not {"path", "private_path", "album_key", "track_key", "alias", "sort", "order_tuple", "grant", "capability"} & node.keys()
            if "digest" in node:
                assert set(node) == {"id", "digest", "readable"}
                assert type(node["id"]) is int and 0 < node["id"] <= 9223372036854775807
                assert isinstance(node["digest"], str) and len(node["digest"]) == 64
                assert all(char in "0123456789abcdef" for char in node["digest"])
                assert type(node["readable"]) is bool
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
    walk(value)
    text = json.dumps(value)
    for track in db.tracks.values():
        assert not any(track[key] in text for key in ("path", "key", "title"))
    for album in db.albums.values():
        assert album["name"] not in text and album["key"] not in text
    assert all(name not in text for name in db.artist_names.values())


@pytest.mark.parametrize("kind,presentation", MODES)
@pytest.mark.parametrize("change", ["denied", "deleted", "no-longer-matching", "reordered", "moved", "wrong-parent", "wrong-digest", "legacy-no-hint"])
def test_lost_or_untrusted_hint_requalifies_same_anchor_without_replaying_prefix_or_reemitting(
        db, monkeypatch, kind, presentation, change):
    parent, params, value, records = seeded_anchor(db, kind, presentation)
    artist, album, tracks, following, prefix = records
    # A genuine independently selected witness supplies a syntactically valid
    # but wrong-parent hint; no invented digest or private module is required.
    if change == "wrong-parent":
        other = db.read(artist="Middle Artist", search_presentation="tracks", search_page_size="1", omit_sidebar="1")
        value["position"]["anchor_witness"] = deepcopy(open_cursor(other["page"]["next_cursor"])["selection"]["witness"])
    elif change == "wrong-digest":
        value["position"]["anchor_witness"]["digest"] = "0" * 64
    elif change == "legacy-no-hint":
        value["position"].pop("anchor_witness")
    elif change == "no-longer-matching":
        db.preference(tracks[0], "off")
    elif change in {"deleted", "reordered", "moved"}:
        reordered_album = db.album(artist, "000 Reordered Hint Parent") if change == "reordered" else None
        with connect(db.setup) as connection:
            if change == "deleted":
                connection.execute("delete from library.local_tracks where id=%s and library_id=%s", (tracks[0], db.library))
            elif change == "reordered":
                # Same raw Artist, changed containing Album/native witness
                # ordering; the original outer Album/Artist stays unchanged.
                connection.execute("update library.local_tracks set album_id=%s where id=%s and library_id=%s",
                                   (reordered_album, tracks[0], db.library))
            else:
                connection.execute("update library.local_tracks set album_id=%s,artist_id=%s where id=%s and library_id=%s",
                    (db.main_album, db.albums[db.main_album]["artist"], tracks[0], db.library))
    # All cases lose initial proof, including valid-but-forged and legacy hints.
    db.denied.add(("track", str(tracks[0])))
    cursor = seal_cursor(value)
    values, seen, examined, pending_count = identifiers(parent, kind), set(), set(), 0
    key = "search_cursor" if kind == "albums" else "search_sidebar_cursor"
    for _ in range(2 * len(tracks) + len(db.artist_names) + 2):
        if cursor is None:
            assert pending_count >= 2
            expected = ([album_ref(db, album), album_ref(db, following), album_ref(db, db.main_album)]
                        if kind == "albums" else [*prefix, "AAA Heavy Visible Anchor", "BBB Following Visible Anchor", "Middle Artist"])
            assert values == expected
            return
        decoded = open_cursor(cursor)
        assert_safe_cursor(decoded, db)
        logical = json.dumps(decoded, sort_keys=True)
        assert logical not in seen, "The same logical anchor continuation was repeated"
        seen.add(logical)
        with observe_consumption(monkeypatch) as trace:
            result = db.read(**params, **{key: cursor})
        trace.assert_bounded(db, result_limit=1, sidebar=kind == "sidebar")
        rows = identifiers(result, kind)
        assert not set(rows) & set(values), "An already emitted anchor was re-emitted"
        values.extend(rows)
        cursor = cursor_of(result, kind)
        if not rows and cursor:
            current = open_cursor(cursor)["position"]
            assert current["anchor"] == value["position"]["anchor"]
            assert "anchor_witness" not in current, "Unusable hint survived unresolved anchor qualification"
            assert current["pending"]["candidate"] == current["anchor"]
            assert current["pending"]["witness"] is not None
            decisions = {int(ref) for action, resource, ref in db.decisions
                         if action == "library.browse.read" and resource == "track"}
            decisions.intersection_update(tracks[1:200])
            assert not examined & decisions, "Already conclusively examined denied prefix was replayed"
            examined.update(decisions)
            pending_count += 1
    pytest.fail("Finite anchor requalification did not finish")


@pytest.mark.parametrize("kind,presentation", MODES)
@pytest.mark.parametrize("change", ["deleted-outer", "reordered-outer", "denied-outer"])
def test_valid_saved_hint_does_not_override_lost_outer_anchor(db, monkeypatch, kind, presentation, change):
    parent, params, value, records = seeded_anchor(db, kind, presentation)
    artist, album, _tracks, _following, _prefix = records
    if change == "denied-outer":
        db.denied.add(("album" if kind == "albums" else "artist", str(album if kind == "albums" else artist)))
    else:
        with connect(db.setup) as connection:
            if change == "deleted-outer":
                if kind == "albums":
                    connection.execute("delete from library.local_albums where id=%s and library_id=%s", (album, db.library))
                else:
                    connection.execute("delete from library.local_artists where id=%s and library_id=%s", (artist, db.library))
            elif kind == "albums":
                connection.execute("update library.local_albums set release_year=1970 where id=%s and library_id=%s", (album, db.library))
            else:
                connection.execute("update library.local_artists set name=%s where id=%s and library_id=%s", ("ZZ Moved Outer Anchor", artist, db.library))
    key = "search_cursor" if kind == "albums" else "search_sidebar_cursor"
    with observe_consumption(monkeypatch) as trace:
        db.read(**params, **{key: cursor_of(parent, kind)}, expected=409, code="search_cursor_restart_required")
    assert trace.count("track") <= 101
    assert sum(max(size, 0) for row_kind, size, _names, _sql in trace.statements if row_kind == "track") <= 101


@pytest.mark.parametrize("kind", ["albums", "sidebar", "tracks", "detail"])
def test_real_issued_cursor_without_optional_hint_remains_accepted(db, kind):
    token, params = first_cursor(db, kind)
    value = open_cursor(token)
    value["position"].pop("anchor_witness", None)
    assert set(value["position"]) == {"anchor", "pending"}
    key = "search_sidebar_cursor" if kind == "sidebar" else "search_cursor"
    db.read(**params, **{key: seal_cursor(value)})


@pytest.mark.parametrize("kind", ["albums", "sidebar", "tracks", "detail"])
@pytest.mark.parametrize("bad_hint", [None, {"id": True, "digest": "0" * 64, "readable": True},
                                       {"id": 1, "digest": "0" * 64, "readable": False}])
def test_real_native_route_rejects_malformed_optional_hint(db, kind, bad_hint):
    token, params = first_cursor(db, kind)
    value = open_cursor(token)
    value["position"]["anchor_witness"] = deepcopy(bad_hint)
    key = "search_sidebar_cursor" if kind == "sidebar" else "search_cursor"
    db.read(**params, **{key: seal_cursor(value)}, expected=400, code="invalid_private_search_request")
