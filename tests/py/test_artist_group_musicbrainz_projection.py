from __future__ import annotations

from music_app.services import library_browse_postgres as browse

NEAL = "c0926f5d-098c-4f29-a463-5489b43a273a"
RESONANCE = "e4525c90-2536-46ef-9ae3-01105208bc55"


def _row(artist_name: str, mbid: str | None, canonical: str | None = None) -> dict[str, object]:
    return {
        "artist_name": artist_name, "artist_mbid": mbid, "artist_canonical_name": canonical or artist_name,
        "artist_native_name": None, "artist_country": "US", "artist_genres": ["progressive rock"],
        "artist_discogs_artist_id": None,
    }


def test_alias_combined_group_takes_the_projection_named_like_the_group():
    rows = [_row("Neal Morse", NEAL), _row("Neal Morse", NEAL), _row("Neal Morse & The Resonance", RESONANCE)]

    assert browse._artist_musicbrainz_projection_from_rows(rows) is None, "without the group artist a conflict stays unresolved"
    assert browse._artist_musicbrainz_projection_from_rows(rows, artist="Neal Morse")["artist_mbid"] == NEAL


def test_alias_combined_group_prefers_its_own_local_artist_over_a_differently_named_projection():
    """Rhapsody's albums match Rhapsody of Fire; the alias-combined group also holds
    Luca Turilli's Rhapsody albums, and neither MusicBrainz name is "Rhapsody"."""
    fire, turilli = "4e0dffde-ad2d-45b7-9c75-d57ce55de061", "87f8cdb8-bea9-4460-978f-f76e0f1b9a5b"
    rows = [*[_row("Rhapsody", fire, "Rhapsody of Fire")] * 11,
            *[_row("Luca Turilli's Rhapsody", turilli, "Luca Turilli's Rhapsody")] * 2]

    assert browse._artist_musicbrainz_projection_from_rows(rows, artist="Rhapsody")["artist_mbid"] == fire


def test_group_projection_stays_empty_when_no_candidate_is_named_like_the_group():
    rows = [_row("Anderson Bruford Wakeman Howe", "11111111-1111-1111-1111-111111111111", "Yes"),
            _row("Anderson Bruford Wakeman Howe", "22222222-2222-2222-2222-222222222222", "ABWH")]

    assert browse._artist_musicbrainz_projection_from_rows(rows, artist="Anderson Bruford Wakeman Howe") is None


def test_family_groups_receive_their_member_projection():
    groups = [{"artist": "The Neal Morse Band", "albums": []}, {"artist": "Cosmic Cathedral", "albums": []},
              {"artist": "Unmatched Friends", "albums": []}]
    rows = [_row("The Neal Morse Band", "38c69101-243a-474b-851a-b82e0a35b173"),
            _row("Cosmic Cathedral", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            _row("Unmatched Friends", None)]

    browse._attach_family_group_musicbrainz_projections(groups, rows, {})

    assert groups[0]["artist_musicbrainz"]["artist_mbid"] == "38c69101-243a-474b-851a-b82e0a35b173"
    assert groups[1]["artist_musicbrainz"]["canonical_name"] == "Cosmic Cathedral"
    assert "artist_musicbrainz" not in groups[2]


def test_family_group_projection_follows_the_alias_map():
    groups = [{"artist": "Кипелов", "albums": []}]
    rows = [_row("Kipelov", "33333333-3333-3333-3333-333333333333", "Кипелов")]

    browse._attach_family_group_musicbrainz_projections(groups, rows, {"Kipelov": "Кипелов"})

    assert groups[0]["artist_musicbrainz"]["artist_mbid"] == "33333333-3333-3333-3333-333333333333"


def test_family_preview_rows_select_the_shared_projection_columns():
    sql = browse._artist_preview_rows_sql(family_only=True)

    assert browse._artist_musicbrainz_projection_columns_sql() in sql
    assert "left join library.local_artist_musicbrainz_matches artist_match" in sql
    assert "artist_match.local_artist_id = matched_album_rows.artist_id" in sql
