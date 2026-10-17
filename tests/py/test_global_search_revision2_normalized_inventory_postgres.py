"""R1: actual normalized-equivalent raw Artist rows share native identity.

These are stored inventory spelling variations, not merely differently cased
request strings. Existing native builder/readiness helpers determine canonical
identity; no fixture alias mapping is invented or production result replaced.
"""
import pytest

from music_app.services.library_inventory_postgres import local_inventory_identity_key
from tests.py.test_global_private_search_postgres import db, isolated_urls, result_rows, album_ref, track_refs
from tests.py.global_search_review_support import build_native_alias_projection, place_alias_evidence


RAW_NAMES = {
    "case": ("AAA NATIVE", "aaa native"),
    "whitespace": ("AAA  Native", "AAA \tNative"),
}


def normalized_inventory(db, spelling, population, *, later_artists=False):
    display_evidence = "AAA Native"
    raw_names = list(RAW_NAMES[spelling])
    if population == "canonical-plus-alias":
        raw_names.append(display_evidence)
    albums, tracks = [], []
    for index, raw in enumerate(raw_names):
        artist = db.artist(raw)
        album = db.album(artist, "Normalized Album " + str(index), year=1990 + index)
        albums.append(album)
        tracks.extend(db.track(album, "Normalized Witness " + str(index) + "-" + str(n)) for n in range(2))
        place_alias_evidence(db, album, display_evidence)
    if later_artists:
        for index in range(52):
            artist = db.artist("ZZ Normalized Sidebar " + str(index).zfill(3))
            db.track(db.album(artist, "Later Album"), "Later Witness")
    views = build_native_alias_projection(db)
    canonical = views["alias_to_canonical"][raw_names[0]]
    assert {views["alias_to_canonical"][raw] for raw in raw_names} == {canonical}
    assert len({local_inventory_identity_key(raw) for raw in raw_names + [canonical]}) == 1
    assert all(raw in views["canonical_to_aliases"][canonical] for raw in raw_names)
    assert len({db.albums[album]["artist"] for album in albums}) == len(raw_names)
    if population == "alias-only":
        assert canonical not in raw_names, "Fixture must have no physical canonical-display Artist row"
    else:
        assert canonical in raw_names, "Fixture must include the canonical and distinct alias raw IDs"
    return canonical, raw_names, albums, tracks


def assert_membership(db, payload, canonical, albums, tracks):
    assert payload["selection_state"] == "selected"
    assert payload["selected_artist"] == canonical
    if payload["presentation"] == "tracks":
        assert [row["inventory_track_ref"] for row in result_rows(payload)] == track_refs(db, tracks)
        assert {row["artist"] for row in result_rows(payload)} == {canonical}
    else:
        assert [row["album_ref"] for row in result_rows(payload)] == [album_ref(db, item) for item in albums]
        assert len(payload["artist_groups"]) == 1
        assert payload["artist_groups"][0]["artist"] == canonical
        assert payload["artist_groups"][0]["artist_display"] == canonical


@pytest.mark.parametrize("spelling", ["case", "whitespace"])
@pytest.mark.parametrize("population", ["alias-only", "canonical-plus-alias"])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("request_kind", ["default", "canonical", "raw-alias", "normalized-request"])
def test_native_projection_merges_actual_case_and_internal_whitespace_inventory_rows(
        db, spelling, population, presentation, request_kind):
    canonical, raw, albums, tracks = normalized_inventory(db, spelling, population)
    params = {"search_presentation": presentation}
    if request_kind != "default":
        params["artist"] = (canonical if request_kind == "canonical" else
                            raw[0] if request_kind == "raw-alias" else
                            "  " + "   ".join(canonical.swapcase().split()) + "  ")
    payload = db.read(**params)
    assert_membership(db, payload, canonical, albums, tracks)
    names = [entry["artist"] for entry in payload["sidebar"]["artists"]]
    assert names.count(canonical) == 1
    assert not (set(raw) - {canonical}) & set(names), "Equivalent native identity split in sidebar"
    for entry in payload["sidebar"]["artists"]:
        clicked = db.read(search_presentation=presentation, artist=entry["artist"])
        assert clicked["selected_artist"] == entry["artist"]
        assert result_rows(clicked)
        if entry["artist"] == canonical:
            assert_membership(db, clicked, canonical, albums, tracks)


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
@pytest.mark.parametrize("requested", ["aaa native", "aaa   native"])
def test_ready_canonical_only_projection_preserves_native_request_normalization(db, presentation, requested):
    artist = db.artist("AAA Native")
    album = db.album(artist, "Only Canonical Album")
    tracks = [db.track(album, "Only Canonical Witness")]
    place_alias_evidence(db, album, "AAA Native")
    views = build_native_alias_projection(db)
    canonical = views["alias_to_canonical"]["AAA Native"]
    assert views["canonical_to_aliases"][canonical] == [canonical]
    payload = db.read(search_presentation=presentation, artist=requested)
    assert_membership(db, payload, canonical, [album], tracks)


@pytest.mark.parametrize("spelling", ["case", "whitespace"])
@pytest.mark.parametrize("population", ["alias-only", "canonical-plus-alias"])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_normalized_inventory_result_continuation_keeps_all_native_members(db, spelling, population, presentation):
    canonical, raw, albums, tracks = normalized_inventory(db, spelling, population)
    first = db.read(search_presentation=presentation, search_page_size="1", artist=raw[0])
    assert first["selected_artist"] == canonical
    rows = list(result_rows(first))
    cursor = first["page"]["next_cursor"]
    seen = set()
    while cursor:
        # Logical positions, not random encrypted bytes, establish progress.
        from tests.py.test_global_search_review_cursor_postgres import open_cursor
        import json
        logical = json.dumps(open_cursor(cursor), sort_keys=True)
        assert logical not in seen and len(seen) <= len(tracks) + len(albums)
        seen.add(logical)
        params = {"search_presentation": presentation, "search_page_size": "1",
                  "search_cursor": cursor, "omit_sidebar": "1"}
        if len(seen) % 2:
            params["artist"] = raw[1]
        page = db.read(**params)
        assert page["selected_artist"] == canonical
        rows.extend(result_rows(page))
        cursor = page["page"]["next_cursor"]
    field = "inventory_track_ref" if presentation == "tracks" else "album_ref"
    expected = track_refs(db, tracks) if presentation == "tracks" else [album_ref(db, item) for item in albums]
    assert [row[field] for row in rows] == expected


@pytest.mark.parametrize("spelling", ["case", "whitespace"])
@pytest.mark.parametrize("population", ["alias-only", "canonical-plus-alias"])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_normalized_inventory_sidebar_continuation_keeps_selected_native_identity(db, spelling, population, presentation):
    canonical, raw, albums, tracks = normalized_inventory(db, spelling, population, later_artists=True)
    first = db.read(search_presentation=presentation)
    assert first["selected_artist"] == canonical
    assert first["sidebar"]["next_cursor"]
    second = db.read(search_presentation=presentation, artist=raw[1],
                     search_sidebar_cursor=first["sidebar"]["next_cursor"])
    assert_membership(db, second, canonical, albums, tracks)
    names = [entry["artist"] for page in (first, second) for entry in page["sidebar"]["artists"]]
    assert names.count(canonical) == 1
    assert not (set(raw) - {canonical}) & set(names)
    assert len(names) == len(set(names)) == 54
    assert second["sidebar"]["has_more"] is False


@pytest.mark.parametrize("spelling", ["case", "whitespace"])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_changed_native_display_invalidates_normalized_identity_cursor(db, spelling, presentation):
    canonical, raw, albums, _tracks = normalized_inventory(db, spelling, "alias-only")
    first = db.read(search_presentation=presentation, search_page_size="1", artist=raw[0])
    assert first["selected_artist"] == canonical
    assert first["page"]["next_cursor"]
    for album in albums:
        place_alias_evidence(db, album, "Aaa Native")
    views = build_native_alias_projection(db)
    changed = views["alias_to_canonical"][raw[0]]
    assert changed != canonical and local_inventory_identity_key(changed) == local_inventory_identity_key(canonical)
    db.read(search_presentation=presentation, search_page_size="1", omit_sidebar="1",
            search_cursor=first["page"]["next_cursor"], expected=409,
            code="search_cursor_restart_required")
