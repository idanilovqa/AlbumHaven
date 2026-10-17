"""B2/B3: whole-request hydrated witness bounds and live visible anchors."""
import json

import pytest

from tests.py.test_global_private_search_postgres import (
    db, isolated_urls, connect, result_rows, album_ref, track_refs,
)
from tests.py.global_search_review_support import bulk_tracks, observe_consumption


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_fifty_large_artists_share_one_hydrated_witness_budget_with_results(db, monkeypatch, presentation):
    for index in range(51):
        artist = db.artist("AAA Budget Artist " + str(index).zfill(3))
        bulk_tracks(db, db.album(artist, "Large Early Success Album"), 101)
    with observe_consumption(monkeypatch) as trace:
        payload = db.read(search_presentation=presentation, all_artists="1", search_page_size="100")
    assert payload["sidebar"]["returned_count"] <= 50
    assert payload["sidebar"]["has_more"] is True
    assert result_rows(payload), "Readable first candidates must make useful progress"
    trace.assert_bounded(db)
    # Every hydrated Track counts, even when SQL fetched it for a sidebar
    # witness and fetched the same identity again for the result projection.
    assert trace.count("track") >= len({ref for _action, kind, ref in db.decisions if kind == "track"})
    assert payload["page"]["returned_count"] <= 100


def test_hundred_large_albums_do_not_fetch_a_full_witness_window_per_album(db, monkeypatch):
    artist = db.artist("AAA Budget Album Artist")
    for index in range(101):
        album = db.album(artist, "Large Album " + str(index).zfill(3))
        bulk_tracks(db, album, 101)
    with observe_consumption(monkeypatch) as trace:
        payload = db.read(all_artists="1", omit_sidebar="1", search_page_size="100")
    assert payload["sidebar"] is None
    assert payload["page"]["has_more"] is True
    refs = [row["album_ref"] for row in result_rows(payload)]
    assert refs and len(refs) == len(set(refs)) <= 100
    trace.assert_bounded(db, sidebar=False)


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
def test_denied_first_hundred_witnesses_resume_with_actual_aggregate_fetch_bound(db, monkeypatch, kind):
    artist = db.artist("AAA Pending Budget Artist")
    album = db.album(artist, "Pending Budget Album")
    ids = bulk_tracks(db, album, 101, title="Pending Budget Witness")
    db.denied.update(("track", str(value)) for value in ids[:100])
    params = {"search_page_size": "100"}
    if kind == "albums":
        params.update(all_artists="1", omit_sidebar="1")
    with observe_consumption(monkeypatch) as first_trace:
        first = db.read(**params)
    assert result_rows(first) == []
    first_trace.assert_bounded(db, sidebar=kind == "sidebar")
    cursor_key = "search_cursor" if kind == "albums" else "search_sidebar_cursor"
    source = first["page"] if kind == "albums" else first["sidebar"]
    assert source["has_more"] is True
    with observe_consumption(monkeypatch) as next_trace:
        second = db.read(**params, **{cursor_key: source["next_cursor"]})
    next_trace.assert_bounded(db, sidebar=kind == "sidebar")
    refs = [row["album_ref"] for row in result_rows(second)]
    assert refs.count(album_ref(db, album)) == 1
    assert all(db.tracks[value]["title"] not in json.dumps(second) for value in ids[:100])
    if kind == "sidebar":
        assert first["selection_state"] == "pending_page"
        assert second["selection_state"] == "selected"
        assert second["selected_artist"] == "AAA Pending Budget Artist"


@pytest.mark.parametrize("denial", ["track", "artist"])
def test_visible_all_artist_album_anchor_rechecks_its_only_witness(db, monkeypatch, denial):
    artist = db.artist("AAA Visible Album Anchor")
    album = db.album(artist, "Anchor Album")
    track = db.track(album, "Only Album Anchor Witness")
    first = db.read(all_artists="1", omit_sidebar="1", search_page_size="1")
    assert [row["album_ref"] for row in result_rows(first)] == [album_ref(db, album)]
    assert first["page"]["next_cursor"]
    db.denied.add((denial, str(track if denial == "track" else artist)))
    # The Album resource itself remains readable, so checking only the outer
    # Album cannot satisfy this current-visibility continuation requirement.
    assert ("album", str(album)) not in db.denied
    with observe_consumption(monkeypatch) as trace:
        db.read(all_artists="1", omit_sidebar="1", search_page_size="1",
            search_cursor=first["page"]["next_cursor"], expected=409,
            code="search_cursor_restart_required")
    assert trace.count("track") <= 101


def seed_sidebar_anchors(db):
    records = {}
    for index in range(52):
        name = "AAA Sidebar Anchor " + str(index).zfill(3)
        artist = db.artist(name)
        album = db.album(artist, "Only Sidebar Album")
        track = db.track(album, "Only Sidebar Witness")
        records[name] = (artist, album, track)
    return records


@pytest.mark.parametrize("denial", ["track", "album"])
def test_visible_sidebar_anchor_rechecks_containing_album_and_track(db, monkeypatch, denial):
    records = seed_sidebar_anchors(db)
    first = db.read(all_artists="1", search_page_size="1")
    assert first["sidebar"]["returned_count"] == 50
    assert first["sidebar"]["next_cursor"]
    name = first["sidebar"]["artists"][-1]["artist"]
    artist, album, track = records[name]
    db.denied.add((denial, str(track if denial == "track" else album)))
    assert ("artist", str(artist)) not in db.denied
    with observe_consumption(monkeypatch) as trace:
        db.read(all_artists="1", search_page_size="1",
            search_sidebar_cursor=first["sidebar"]["next_cursor"], expected=409,
            code="search_cursor_restart_required")
    assert trace.count("track") <= 101


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
def test_previously_denied_scanned_anchor_can_continue_without_false_restart(db, monkeypatch, kind):
    if kind == "sidebar":
        records = seed_sidebar_anchors(db)
        artist, album, track = records["AAA Sidebar Anchor 049"]
        params = {"all_artists": "1", "search_page_size": "1"}
    else:
        artist = db.artist("AAA Denied Album Anchor")
        album = db.album(artist, "Denied Anchor Album")
        track = db.track(album, "Denied Anchor Witness")
        params = {"all_artists": "1", "omit_sidebar": "1", "search_page_size": "1"}
    db.denied.add(("track", str(track)))
    first = db.read(**params)
    cursor_key = "search_sidebar_cursor" if kind == "sidebar" else "search_cursor"
    page = first["sidebar"] if kind == "sidebar" else first["page"]
    assert page["has_more"] is True
    assert album_ref(db, album) not in [row["album_ref"] for row in result_rows(first)]
    with observe_consumption(monkeypatch) as trace:
        second = db.read(**params, **{cursor_key: page["next_cursor"]})
    trace.assert_bounded(db, result_limit=1, sidebar=kind == "sidebar")
    if kind == "sidebar":
        assert [row["artist"] for row in second["sidebar"]["artists"]][:2] == [
            "AAA Sidebar Anchor 050", "AAA Sidebar Anchor 051"]
    else:
        assert result_rows(second)


@pytest.mark.parametrize("kind", ["albums", "sidebar"])
@pytest.mark.parametrize("change", ["delete", "reorder"])
def test_visible_outer_anchor_deletion_or_order_change_requires_restart(db, kind, change):
    if kind == "sidebar":
        records = seed_sidebar_anchors(db)
        params = {"all_artists": "1", "search_page_size": "1"}
        first = db.read(**params)
        artist, album, track = records[first["sidebar"]["artists"][-1]["artist"]]
    else:
        artist = db.artist("AAA Changed Album Anchor")
        album = db.album(artist, "Changed Anchor Album")
        track = db.track(album, "Changed Anchor Witness")
        params = {"all_artists": "1", "omit_sidebar": "1", "search_page_size": "1"}
        first = db.read(**params)
    with connect(db.setup) as connection:
        if change == "delete":
            connection.execute("delete from library.local_tracks where id=%s and library_id=%s", (track, db.library))
        elif kind == "sidebar":
            connection.execute("update library.local_artists set name=%s where id=%s and library_id=%s",
                ("ZZ Reordered Anchor", artist, db.library))
        else:
            connection.execute("update library.local_albums set release_year=1980 where id=%s and library_id=%s",
                (album, db.library))
    cursor_key = "search_sidebar_cursor" if kind == "sidebar" else "search_cursor"
    page = first["sidebar"] if kind == "sidebar" else first["page"]
    assert page["next_cursor"]
    db.read(**params, **{cursor_key: page["next_cursor"]}, expected=409,
        code="search_cursor_restart_required")


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_explicit_pending_artist_exhaustion_is_unavailable_not_autoselection_empty(db, presentation):
    name = "AAA Explicit Pending Artist"
    artist = db.artist(name)
    album = db.album(artist, "Explicit Pending Album")
    tracks = bulk_tracks(db, album, 101)
    db.denied.update(("track", str(value)) for value in tracks[:100])
    first = db.read(artist=name, search_presentation=presentation)
    assert first["selection_state"] == "pending_page"
    assert first["sidebar"]["next_cursor"]
    db.denied.add(("track", str(tracks[-1])))
    db.read(artist=name, search_presentation=presentation,
        search_sidebar_cursor=first["sidebar"]["next_cursor"], expected=409,
        code="search_selection_unavailable")
