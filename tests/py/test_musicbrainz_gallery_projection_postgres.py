from __future__ import annotations

import re

import pytest


ARTIST_MBID = "00000000-0000-4000-8000-000000000041"
SAFE_ARTIST_MUSICBRAINZ = {
    "artist_mbid": ARTIST_MBID,
    "musicbrainz_url": f"https://musicbrainz.org/artist/{ARTIST_MBID}",
    "canonical_name": "Kipelov",
    "native_name": "Кипелов",
    "country": "Russia",
    "genres": ["Heavy Metal", "Power Metal", "Hard Rock"],
}


def _stored_artist_row(*, root_id: int = 1, genres=None):
    return {
        "artist_id": 41,
        "artist_name": "Кипелов",
        "artist_sort_name": "Kipelov",
        "album_id": 101,
        "album_key": "kipelov-reki-vremen",
        "album_title": "Реки времён",
        "album_release_year": 2005,
        "album_cover_path": None,
        "album_metadata": {
            "album_artist": "Кипелов",
            "artists": ["Кипелов"],
        },
        "track_count": 10,
        "total_duration_seconds": 2940,
        "file_library_root_id": root_id,
        "artist_mbid": ARTIST_MBID,
        "artist_canonical_name": "Kipelov",
        "artist_native_name": "Кипелов",
        "artist_country": "Russia",
        "artist_genres": list(
            genres
            if genres is not None
            else ["Heavy Metal", "Power Metal", "Hard Rock", "Fourth Genre"]
        ),
        # Stored accepted display facts survive a provider retry/outage. These
        # operational fields must neither suppress nor leak into browse payloads.
        "musicbrainz_job_state": "retry_wait",
        "musicbrainz_last_error": "provider token=secret at C:\\private\\mirror",
        "provider_payload": {"token": "secret"},
        "raw_tags": [{"name": "epic", "vote_count": 0}],
        "candidate_score": 0.99,
        "evidence_summary": "private matching evidence",
        "library_id": 7,
    }


def _normalized(sql: str) -> str:
    return " ".join(sql.lower().split())


@pytest.mark.parametrize(
    "query_factory",
    [
        pytest.param("_root_album_browse_sql", id="gallery"),
        pytest.param("_selected_artist_sql", id="selected-artist"),
        pytest.param("_album_detail_sql", id="album-detail"),
    ],
)
def test_browse_queries_project_only_current_library_accepted_stored_artist_enrichment(
    query_factory,
):
    from music_app.services import library_browse_postgres as browse

    sql = _normalized(getattr(browse, query_factory)())

    assert "bootstrap_context" in sql
    assert "library.local_artist_musicbrainz_matches" in sql
    assert "integration.musicbrainz_artists" in sql
    assert "integration.musicbrainz_artist_countries" in sql
    assert "integration.musicbrainz_artist_display_genres" in sql
    assert "state = 'matched'" in sql
    assert "artist_mbid is not null" in sql
    assert "display_rank" in sql
    match_join = re.search(
        r"join library\.local_artist_musicbrainz_matches (?P<alias>[a-z_]+)",
        sql,
    )
    assert match_join is not None
    match_alias = match_join.group("alias")
    assert f"{match_alias}.library_id =" in sql
    assert f"{match_alias}.local_artist_id =" in sql
    assert "library.local_artist_musicbrainz_candidates" not in sql
    assert "integration.musicbrainz_artist_tags" not in sql
    assert "library.metadata_enrichment_problems" not in sql
    assert "ops.metadata_enrichment_jobs" not in sql
    assert "provider_payload" not in sql
    assert "raw_payload" not in sql


def test_gallery_and_selected_artist_projection_is_safe_bounded_and_not_duplicated_by_roots():
    from music_app.services import library_browse_postgres as browse

    rows = [_stored_artist_row(root_id=1), _stored_artist_row(root_id=2)]

    gallery_groups = browse._root_album_browse_artist_groups(rows)
    albums = browse._selected_artist_album_payloads(rows, "Кипелов")
    selected_groups = browse._selected_artist_primary_groups(
        "Кипелов",
        albums,
        use_preview_albums=False,
        alias_to_canonical={},
        canonical_to_aliases={},
    )

    assert len(gallery_groups) == 1
    assert len(gallery_groups[0]["albums"]) == 1
    assert gallery_groups[0]["artist_musicbrainz"] == SAFE_ARTIST_MUSICBRAINZ
    assert selected_groups[0]["artist_musicbrainz"] == SAFE_ARTIST_MUSICBRAINZ
    assert albums[0]["artist_musicbrainz"] == SAFE_ARTIST_MUSICBRAINZ
    assert set(gallery_groups[0]["artist_musicbrainz"]) == set(SAFE_ARTIST_MUSICBRAINZ)
    assert "secret" not in repr(gallery_groups[0]["artist_musicbrainz"])
    assert "private" not in repr(gallery_groups[0]["artist_musicbrainz"])


def test_the_first_selected_artist_payload_carries_the_header_projection():
    """The page's first payload uses the gallery_summary tier, whose album payloads
    carry no per-album projection; the header pills arrived 2 s later with the next
    payload. The primary group now takes the artist's projection from its rows."""
    import inspect

    from music_app.services import library_browse_postgres as browse

    rows = [_stored_artist_row()]
    summary_albums = browse._root_album_browse_album_payloads(
        rows, "Кипелов", include_total_duration_seconds=True, include_artist_members=True,
    )
    assert all("artist_musicbrainz" not in album for album in summary_albums)
    groups = browse._selected_artist_primary_groups(
        "Кипелов", summary_albums, use_preview_albums=False,
        artist_musicbrainz=browse._artist_musicbrainz_projection_from_rows(rows, artist="Кипелов"),
        alias_to_canonical={}, canonical_to_aliases={},
    )
    assert groups[0]["artist_musicbrainz"] == SAFE_ARTIST_MUSICBRAINZ
    source = inspect.getsource(browse.PostgresLibraryBrowseRepository.build_selected_artist_payload)
    assert "preview_artist_musicbrainz = _artist_musicbrainz_projection_from_rows(rows, artist=artist_display)" in source


def test_matched_artist_without_an_eligible_stored_genre_keeps_identity_and_explicit_fallback():
    from music_app.services import library_browse_postgres as browse

    groups = browse._root_album_browse_artist_groups(
        [_stored_artist_row(genres=[])]
    )

    assert groups[0]["artist_musicbrainz"] == {
        **SAFE_ARTIST_MUSICBRAINZ,
        "genres": ["Genre unavailable"],
    }


@pytest.mark.parametrize("role", ["viewer", "listener", "musician", "owner", "admin"])
def test_every_connected_role_keeps_ordinary_gallery_and_album_visibility(role):
    from music_app.services.capabilities import (
        capability_keys_for_roles,
        grant_keys_for_action,
    )
    from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS

    grants = set(capability_keys_for_roles([role]))
    accepted_grants = grant_keys_for_action("library.browse.read")

    assert grants & accepted_grants
    assert _PRIVATE_ROUTE_ACTIONS[("GET", "/view-data")] == "library.browse.read"
    assert _PRIVATE_ROUTE_ACTIONS[("GET", "/album-details")] == "library.browse.read"


def test_artist_projection_links_discogs_only_when_musicbrainz_lists_it():
    from music_app.services import library_browse_postgres as browse

    linked = browse._root_album_browse_artist_groups(
        [{**_stored_artist_row(), "artist_discogs_artist_id": 218108}]
    )[0]["artist_musicbrainz"]
    unlinked = browse._root_album_browse_artist_groups(
        [{**_stored_artist_row(), "artist_discogs_artist_id": None}]
    )[0]["artist_musicbrainz"]

    assert linked == {**SAFE_ARTIST_MUSICBRAINZ, "discogs_url": "https://www.discogs.com/artist/218108"}
    assert unlinked == SAFE_ARTIST_MUSICBRAINZ, "no Discogs field at all without a link"


@pytest.mark.parametrize(
    "query_factory", ["_root_album_browse_sql", "_selected_artist_sql"],
)
def test_browse_queries_carry_only_the_stored_discogs_artist_id(query_factory):
    from music_app.services import library_browse_postgres as browse

    sql = _normalized(getattr(browse, query_factory)())
    assert "musicbrainz_artist.discogs_artist_id as artist_discogs_artist_id" in sql


def test_a_split_artist_projects_the_musicbrainz_artists_its_albums_belong_to():
    """Owner decision 2026-11-08: Amarok's albums belong to two MusicBrainz artists."""
    from music_app.services import library_browse_postgres as browse

    polish, spanish = "75d43a2e-ba60-427c-b2c7-bb666053d2f1", "b42d111d-5932-4c00-8562-8bbf7203f850"
    row = {**_stored_artist_row(), "artist_name": "Amarok", "artist_mbid": None, "artist_canonical_name": None,
           "artist_identities": [
               {"artist_mbid": polish, "canonical_name": "Amarok", "disambiguation": "Polish progressive rock band",
                "album_count": 4},
               {"artist_mbid": spanish, "canonical_name": "Amarok", "disambiguation": None, "album_count": 3}]}

    group = browse._root_album_browse_artist_groups([row])[0]

    assert group["artist_musicbrainz"] == {"identities": [
        {"artist_mbid": polish, "musicbrainz_url": f"https://musicbrainz.org/artist/{polish}", "canonical_name": "Amarok",
         "disambiguation": "Polish progressive rock band", "album_count": 4},
        {"artist_mbid": spanish, "musicbrainz_url": f"https://musicbrainz.org/artist/{spanish}", "canonical_name": "Amarok",
         "disambiguation": None, "album_count": 3}]}
    # An artist with neither a match nor identities projects nothing.
    assert "artist_musicbrainz" not in browse._root_album_browse_artist_groups(
        [{**row, "artist_identities": None}])[0]


def test_a_person_projects_the_same_named_band_they_belong_to_as_associated():
    """Owner 2026-11-09: Alice Cooper is one artist, the singer, whose 1969-74 band keeps its MBID."""
    from music_app.services import library_browse_postgres as browse

    band = "4d7928cd-7ed2-4282-8c29-c0c9f966f1bd"
    row = {**_stored_artist_row(), "artist_name": "Alice Cooper", "artist_identities": [
        {"artist_mbid": band, "canonical_name": "Alice Cooper", "disambiguation": "the band", "album_count": 7}]}

    projection = browse._root_album_browse_artist_groups([row])[0]["artist_musicbrainz"]

    assert projection["artist_mbid"] == _stored_artist_row()["artist_mbid"]
    assert projection["associated"] == [
        {"artist_mbid": band, "musicbrainz_url": f"https://musicbrainz.org/artist/{band}", "canonical_name": "Alice Cooper",
         "disambiguation": "the band", "album_count": 7}]
    assert "identities" not in projection

