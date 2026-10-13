"""B1: canonical native Artist identity is shared by sidebar and result reads."""
import json

import pytest

from tests.py.test_global_private_search_postgres import (
    db, isolated_urls, connect, result_rows, album_ref, track_refs,
)
from tests.py.global_search_review_support import (
    build_native_alias_projection, place_alias_evidence,
)

CANONICAL = "AAA Native"
RAW_ALIAS = "AAA--NATIVE"


def seed_alias_inventory(db, *, canonical_row):
    alias = db.artist(RAW_ALIAS)
    alias_albums, alias_tracks = [], []
    for index in range(2):
        album = db.album(alias, "Alias Album " + str(index), year=1990 + index)
        alias_albums.append(album)
        alias_tracks.append(db.track(album, "Alias Witness " + str(index)))
        place_alias_evidence(db, album, CANONICAL)
    if canonical_row:
        native = db.artist(CANONICAL)
        album = db.album(native, "Canonical Album", year=1992)
        alias_albums.append(album)
        alias_tracks.append(db.track(album, "Canonical Witness"))
        place_alias_evidence(db, album, CANONICAL)
    collaboration_name = CANONICAL + " feat. Guest"
    collaboration = db.artist(collaboration_name)
    collaboration_album = db.album(collaboration, "Collaboration Album")
    db.track(collaboration_album, "Collaboration Witness")
    place_alias_evidence(db, collaboration_album, CANONICAL)
    family = db.artist("Unrelated Family Artist")
    family_album = db.album(family, "Unrelated Family Album")
    db.track(family_album, "Unrelated Family Witness")
    place_alias_evidence(db, family_album, "Unrelated Family Artist")
    views = build_native_alias_projection(db)
    # Fixture setup evidence comes from the unchanged native relation builder.
    assert views["alias_to_canonical"][RAW_ALIAS] == CANONICAL
    assert views["alias_to_canonical"][collaboration_name] == CANONICAL
    assert "Unrelated Family Artist" in views["folder_related"].get(CANONICAL, [])
    from music_app.services.library_browse_postgres import (
        _root_browse_alias_to_canonical, _expanded_primary_artist_names,
    )
    primary = _root_browse_alias_to_canonical(views["alias_to_canonical"])
    assert collaboration_name not in primary
    assert set(_expanded_primary_artist_names(CANONICAL, primary,
               views["canonical_to_aliases"])) == {CANONICAL, RAW_ALIAS}
    return alias_albums, alias_tracks


def assert_identity_rows(db, payload, albums, tracks):
    assert payload["selected_artist"] == CANONICAL
    assert payload["selection_state"] == "selected"
    if payload["presentation"] == "tracks":
        assert [row["inventory_track_ref"] for row in payload["tracks"]] == track_refs(db, tracks)
        assert {row["artist"] for row in payload["tracks"]} == {CANONICAL}
    else:
        assert [row["album_ref"] for row in result_rows(payload)] == [album_ref(db, value) for value in albums]
        assert {group["artist"] for group in payload["artist_groups"]} == {CANONICAL}
    assert "Unrelated Family Album" not in json.dumps(result_rows(payload))
    assert "Collaboration Album" not in json.dumps(result_rows(payload))


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("canonical_row", [False, True], ids=["alias-only", "multiple-raw-ids"])
@pytest.mark.parametrize("requested", [None, RAW_ALIAS, CANONICAL, "  aaa--native  "])
def test_native_alias_identity_contains_all_primary_ids_without_family_expansion(
        db, presentation, canonical_row, requested):
    albums, tracks = seed_alias_inventory(db, canonical_row=canonical_row)
    params = {"search_presentation": presentation}
    if requested is not None:
        params["artist"] = requested
    payload = db.read(**params)
    assert_identity_rows(db, payload, albums, tracks)
    names = [row["artist"] for row in payload["sidebar"]["artists"]]
    assert names.count(CANONICAL) == 1
    assert RAW_ALIAS not in names
    # Every visible sidebar selection must remain usable through the same
    # native Artist value. This includes the separately owned collaboration.
    for entry in payload["sidebar"]["artists"]:
        clicked = db.read(search_presentation=presentation, artist=entry["artist"])
        assert clicked["selected_artist"] == entry["artist"]
        assert result_rows(clicked)


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("requested", [None, RAW_ALIAS, "aaa--native"])
def test_alias_selected_result_cursor_accepts_equivalent_artist_and_retains_all_members(
        db, presentation, requested):
    albums, tracks = seed_alias_inventory(db, canonical_row=True)
    first = db.read(search_presentation=presentation, search_page_size="1", artist=RAW_ALIAS)
    assert first["selected_artist"] == CANONICAL
    assert first["page"]["has_more"] is True
    rows = result_rows(first)
    cursor, seen = first["page"]["next_cursor"], set()
    while cursor:
        assert cursor not in seen and len(seen) <= len(tracks)
        seen.add(cursor)
        params = {"search_presentation": presentation, "search_page_size": "1",
                  "search_cursor": cursor, "omit_sidebar": "1"}
        if requested is not None:
            params["artist"] = requested
        page = db.read(**params)
        assert page["selected_artist"] == CANONICAL
        rows.extend(result_rows(page))
        cursor = page["page"]["next_cursor"]
    field = "inventory_track_ref" if presentation == "tracks" else "album_ref"
    expected = track_refs(db, tracks) if presentation == "tracks" else [album_ref(db, value) for value in albums]
    assert [row[field] for row in rows] == expected


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_alias_selected_sidebar_cursor_preserves_canonical_artist(db, presentation):
    albums, tracks = seed_alias_inventory(db, canonical_row=False)
    for index in range(52):
        artist = db.artist("ZZ Later " + str(index).zfill(3))
        db.track(db.album(artist, "Later Album"), "Later Witness")
    build_native_alias_projection(db)
    first = db.read(search_presentation=presentation)
    assert first["selected_artist"] == CANONICAL
    assert first["sidebar"]["has_more"] is True
    second = db.read(search_presentation=presentation,
        search_sidebar_cursor=first["sidebar"]["next_cursor"], artist=RAW_ALIAS)
    assert_identity_rows(db, second, albums, tracks)


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_selected_cursor_restarts_when_native_projection_changes_canonical_display(db, presentation):
    albums, _tracks = seed_alias_inventory(db, canonical_row=False)
    first = db.read(search_presentation=presentation, search_page_size="1", artist=RAW_ALIAS)
    assert first["selected_artist"] == CANONICAL
    assert first["page"]["next_cursor"]
    for album in albums:
        place_alias_evidence(db, album, "Aaa Native")
    # The change is rebuilt through the real native projection owner; no
    # monkeypatch or fabricated cursor scope supplies the expected outcome.
    views = build_native_alias_projection(db)
    assert views["alias_to_canonical"][RAW_ALIAS] == "Aaa Native"
    db.read(search_presentation=presentation, search_page_size="1", omit_sidebar="1",
        search_cursor=first["page"]["next_cursor"], expected=409,
        code="search_cursor_restart_required")


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_genuinely_ambiguous_raw_labels_stay_unavailable(db, presentation):
    for index in range(2):
        artist = db.artist("Exact Ambiguous Label")
        db.track(db.album(artist, "Different Identity " + str(index)), "Ambiguous Witness")
    db.read(search_presentation=presentation, artist="Exact Ambiguous Label",
        expected=409, code="search_selection_unavailable")
