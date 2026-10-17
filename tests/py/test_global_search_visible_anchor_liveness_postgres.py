"""R4: live requalification of an emitted heavy anchor cannot starve its child."""
import json

import pytest

from tests.py.test_global_private_search_postgres import db, isolated_urls, connect, result_rows, album_ref
from tests.py.global_search_review_support import bulk_tracks, observe_consumption
from tests.py.test_global_search_review_cursor_postgres import open_cursor


MODES = [("albums", "albums"), ("sidebar", "albums"), ("sidebar", "tracks")]


def fixture_records(db, *, count=100):
    artist = db.artist("AAA Heavy Visible Anchor")
    album = db.album(artist, "Heavy Visible Anchor Album")
    tracks = bulk_tracks(db, album, count, title="Heavy Anchor Witness")
    following_artist = db.artist("BBB Following Visible Anchor")
    following_album = db.album(following_artist, "Following Visible Album")
    db.track(following_album, "Following Visible Witness")
    return artist, album, tracks, following_album


def params_for(kind, presentation):
    params = {"all_artists": "1", "search_presentation": presentation, "search_page_size": "1"}
    if kind == "albums":
        params["omit_sidebar"] = "1"
    return params


def cursor_of(payload, kind):
    return payload["page" if kind == "albums" else "sidebar"]["next_cursor"]


def identifiers(payload, kind):
    return ([row["album_ref"] for row in result_rows(payload)] if kind == "albums" else
            [row["artist"] for row in payload["sidebar"]["artists"]])


def complete_stream(db, monkeypatch, kind, params, first):
    values = identifiers(first, kind)
    cursor = cursor_of(first, kind)
    seen = set()
    ceiling = 2 * (len(db.tracks) + len(db.albums) + len(db.artist_names)) + 2
    for _ in range(ceiling):
        if cursor is None:
            return values
        logical = json.dumps(open_cursor(cursor), sort_keys=True)
        assert logical not in seen, "Visible-anchor requalification repeated its logical continuation forever"
        seen.add(logical)
        key = "search_cursor" if kind == "albums" else "search_sidebar_cursor"
        with observe_consumption(monkeypatch) as trace:
            page = db.read(**params, **{key: cursor})
        trace.assert_bounded(db, result_limit=1, sidebar=kind == "sidebar")
        current = identifiers(page, kind)
        assert not set(current) & set(values), "Already emitted anchor was re-emitted after revalidation"
        values.extend(current)
        cursor = cursor_of(page, kind)
    pytest.fail("Finite visible-anchor fixture failed to finish its advertised continuation")


@pytest.mark.parametrize("kind,presentation", MODES)
def test_emitted_ninety_nine_denied_one_readable_anchor_eventually_advances(db, monkeypatch, kind, presentation):
    _artist, album, tracks, following = fixture_records(db)
    db.denied.update(("track", str(track)) for track in tracks[:99])
    params = params_for(kind, presentation)
    with observe_consumption(monkeypatch) as trace:
        first = db.read(**params)
    trace.assert_bounded(db, result_limit=1, sidebar=kind == "sidebar")
    expected_first = album_ref(db, album) if kind == "albums" else "AAA Heavy Visible Anchor"
    assert identifiers(first, kind) == [expected_first]
    assert cursor_of(first, kind), "The next readable candidate must remain represented"
    actual = complete_stream(db, monkeypatch, kind, params, first)
    expected = ([album_ref(db, album), album_ref(db, following), album_ref(db, db.main_album)]
                if kind == "albums" else ["AAA Heavy Visible Anchor", "BBB Following Visible Anchor", "Middle Artist"])
    assert actual == expected


@pytest.mark.parametrize("kind,presentation", MODES)
@pytest.mark.parametrize("revocation", ["track", "album", "artist", "delete-witness", "reorder"])
def test_heavy_visible_anchor_is_revalidated_and_restarts_when_no_longer_valid(
        db, monkeypatch, kind, presentation, revocation):
    artist, album, tracks, _following = fixture_records(db)
    db.denied.update(("track", str(track)) for track in tracks[:99])
    params = params_for(kind, presentation)
    first = db.read(**params)
    assert identifiers(first, kind) == [album_ref(db, album) if kind == "albums" else "AAA Heavy Visible Anchor"]
    if revocation in {"track", "album", "artist"}:
        resource = {"track": tracks[-1], "album": album, "artist": artist}[revocation]
        db.denied.add((revocation, str(resource)))
    else:
        with connect(db.setup) as connection:
            if revocation == "delete-witness":
                connection.execute("delete from library.local_tracks where id=%s and library_id=%s", (tracks[-1], db.library))
            elif kind == "albums":
                connection.execute("update library.local_albums set release_year=1970 where id=%s and library_id=%s", (album, db.library))
            else:
                connection.execute("update library.local_artists set name=%s where id=%s and library_id=%s",
                                   ("ZZ Reordered Heavy Anchor", artist, db.library))
    key = "search_cursor" if kind == "albums" else "search_sidebar_cursor"
    with observe_consumption(monkeypatch) as trace:
        db.read(**params, **{key: cursor_of(first, kind)}, expected=409, code="search_cursor_restart_required")
    assert trace.count("track") <= 101
    assert sum(max(size, 0) for row_kind, size, _names, _sql in trace.statements if row_kind == "track") <= 101


@pytest.mark.parametrize("kind,presentation", MODES)
def test_incomplete_live_revalidation_resumes_without_reemitting_previous_anchor(db, monkeypatch, kind, presentation):
    _artist, album, tracks, following = fixture_records(db, count=201)
    # Initially the first witness is readable. At the next read the first 200
    # are denied; a later witness still proves the previously emitted anchor.
    db.denied.update(("track", str(track)) for track in tracks[1:200])
    prefix_names = []
    if kind == "sidebar":
        # The 50th emitted Artist is the heavy anchor. All records exist before
        # the first request; no runtime trimming manufactures a cursor.
        for index in range(49):
            name = "000 Earlier Artist " + str(index).zfill(3)
            prefix_names.append(name)
            artist = db.artist(name)
            db.track(db.album(artist, "Earlier Album"), "Earlier Witness")
    params = params_for(kind, presentation)
    first = db.read(**params)
    assert identifiers(first, kind) == ([album_ref(db, album)] if kind == "albums" else
                                       [*prefix_names, "AAA Heavy Visible Anchor"])
    db.denied.add(("track", str(tracks[0])))
    actual = complete_stream(db, monkeypatch, kind, params, first)
    assert actual == ([album_ref(db, album), album_ref(db, following), album_ref(db, db.main_album)]
                      if kind == "albums" else [*prefix_names, "AAA Heavy Visible Anchor",
                                                "BBB Following Visible Anchor", "Middle Artist"])
