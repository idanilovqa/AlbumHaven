from __future__ import annotations

import importlib
from urllib.parse import parse_qs, urlparse

import pytest


ARTIST_ID = "00000000-0000-4000-8000-000000000001"


def _client_api():
    try:
        return importlib.import_module("music_app.services.musicbrainz_client")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz artist client is not implemented yet", pytrace=False)


def test_client_normalizes_configured_base_url_and_builds_exact_artist_url():
    api = _client_api()
    calls = []

    def get_json(url, _user_agent, **_kwargs):
        calls.append(url)
        return {"id": ARTIST_ID, "name": "Fixture Artist", "type": "Group"}, {
            "status": "network",
            "http_status": 200,
            "cache_hit": False,
        }

    client = api.MusicBrainzClient(
        base_url=" https://mirror.test/custom/ws/2/// ",
        user_agent="AlbumHaven/Test",
        get_json=get_json,
    )

    result = client.lookup_artist(ARTIST_ID)

    assert calls == [
        f"https://mirror.test/custom/ws/2/artist/{ARTIST_ID}?fmt=json&inc=aliases%2Bgenres%2Btags"
    ]
    assert result["classification"] == "matched"
    assert result["artist"]["source_url"] == f"https://musicbrainz.org/artist/{ARTIST_ID}"
    assert api.artist_url(ARTIST_ID) == f"https://musicbrainz.org/artist/{ARTIST_ID}"


def test_artist_url_rejects_non_artist_or_invalid_identifiers():
    api = _client_api()
    for invalid in ("", "not-an-mbid", f"release/{ARTIST_ID}", "00000000-0000-0000-0000-000000000000"):
        assert api.artist_url(invalid) is None


def test_search_paginates_to_the_configured_bounds_and_returns_deterministic_candidates():
    api = _client_api()
    calls = []
    pages = {
        0: {"count": 5, "offset": 0, "artists": [{"id": "00000000-0000-4000-8000-000000000003", "name": "Same", "score": 90}]},
        2: {"count": 5, "offset": 2, "artists": [
            {"id": "00000000-0000-4000-8000-000000000002", "name": "Same", "score": 100},
            {"id": "00000000-0000-4000-8000-000000000001", "name": "Same", "score": 100},
        ]},
    }

    def get_json(url, _user_agent, **_kwargs):
        calls.append(url)
        query = parse_qs(urlparse(url).query)
        return pages[int(query["offset"][0])], {"status": "network", "http_status": 200, "cache_hit": False}

    client = api.MusicBrainzClient(
        base_url="https://mirror.test/ws/2",
        user_agent="AlbumHaven/Test",
        get_json=get_json,
        search_page_size=2,
        max_search_pages=2,
        max_candidates=3,
    )

    result = client.search_artists("Same")

    assert [parse_qs(urlparse(url).query)["offset"] for url in calls] == [["0"], ["2"]]
    assert [candidate["mbid"] for candidate in result["candidates"]] == [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
    ]
    assert result["classification"] == "complete"
    assert result["truncated"] is True


def test_search_requires_every_bounded_page_before_classifying_not_found():
    api = _client_api()
    responses = iter((
        ({"count": 3, "offset": 0, "artists": []}, {"status": "network", "http_status": 200, "cache_hit": False}),
        (None, {"status": "http_503", "http_status": 503, "cache_hit": False}),
    ))
    client = api.MusicBrainzClient(
        base_url="https://mirror.test/ws/2",
        user_agent="AlbumHaven/Test",
        get_json=lambda *_args, **_kwargs: next(responses),
        search_page_size=2,
        max_search_pages=2,
    )

    result = client.search_artists("Missing")

    assert result["classification"] == "provider_unavailable"
    assert result["candidates"] == []


def test_lookup_classifies_transport_failures_without_erasing_status():
    api = _client_api()
    cases = (
        ({"status": "http_404", "http_status": 404}, "not_found"),
        ({"status": "http_429", "http_status": 429}, "rate_limited"),
        ({"status": "http_503", "http_status": 503}, "provider_unavailable"),
        ({"status": "timeout"}, "provider_unavailable"),
        ({"status": "invalid_response"}, "invalid_response"),
    )
    for metadata, expected in cases:
        client = api.MusicBrainzClient(
            base_url="https://mirror.test/ws/2",
            user_agent="AlbumHaven/Test",
            get_json=lambda *_args, _metadata=metadata, **_kwargs: (None, _metadata),
        )
        result = client.lookup_artist(ARTIST_ID)
        assert result["classification"] == expected
        assert result["transport"] == metadata


def test_direct_404_after_a_search_hit_is_mirror_catch_up_not_not_found():
    api = _client_api()
    client = api.MusicBrainzClient(
        base_url="https://mirror.test/ws/2",
        user_agent="AlbumHaven/Test",
        get_json=lambda *_args, **_kwargs: (
            None,
            {"status": "http_404", "http_status": 404, "cache_hit": False},
        ),
    )

    result = client.lookup_artist(ARTIST_ID, discovered_by_search=True)

    assert result["classification"] == "catch_up_pending"
    assert result["transport"]["http_status"] == 404


def test_artist_projection_is_bounded_normalized_and_keeps_all_review_tags_with_votes():
    api = _client_api()
    payload = {
        "id": ARTIST_ID,
        "name": "  Änglagård  ",
        "sort-name": "Anglagard",
        "type": "Group",
        "country": "SE",
        "aliases": [
            {"name": "Anglagard", "locale": "en", "primary": True, "type": "Artist name"},
            {"name": " ÄNGLAGÅRD ", "locale": "sv", "primary": True, "type": "Artist name"},
        ],
        "tags": [
            {"name": " Progressive Rock ", "count": 12},
            {"name": "mellotron", "count": 4},
            {"name": "progressive rock", "count": 2},
            {"name": "Moody", "count": 0},
            {"name": "noise", "count": -2},
        ],
        "genres": [
            {"name": "Progressive Rock", "count": 12},
            {"name": "Symphonic Rock", "count": 0},
        ],
    }

    projected = api.project_artist(payload, max_aliases=8, max_tags=8, max_genres=8)

    assert projected == {
        "mbid": ARTIST_ID,
        "canonical_name": "Änglagård",
        "sort_name": "Anglagard",
        "artist_type": "Group",
        "disambiguation": None,
        "country_code": "SE",
        "preferred_native_name": "Änglagård",
        "source_url": f"https://musicbrainz.org/artist/{ARTIST_ID}",
        "aliases": [
            {"name": "Anglagard", "normalized_name": "anglagard", "locale": "en", "primary": True},
            {"name": "ÄNGLAGÅRD", "normalized_name": "änglagård", "locale": "sv", "primary": True},
        ],
        "tags": [
            {"name": "Progressive Rock", "normalized_name": "progressive rock", "vote_count": 14},
            {"name": "mellotron", "normalized_name": "mellotron", "vote_count": 4},
            {"name": "Moody", "normalized_name": "moody", "vote_count": 0},
            {"name": "noise", "normalized_name": "noise", "vote_count": -2},
        ],
        "genres": [
            {"name": "Progressive Rock", "normalized_name": "progressive rock", "vote_count": 12},
            {"name": "Symphonic Rock", "normalized_name": "symphonic rock", "vote_count": 0},
        ],
    }


def test_artist_projection_rejects_wrong_entity_shape():
    api = _client_api()
    assert api.project_artist({"id": ARTIST_ID, "title": "This is a release, not an artist"}) is None
    assert api.project_artist({"id": "not-an-mbid", "name": "Artist"}) is None


def test_display_genres_prefers_positive_votes_then_normalized_name_and_limits_to_three():
    api = _client_api()
    genres = [
        {"name": "Z Rock", "normalized_name": "z rock", "vote_count": 5},
        {"name": "Art Rock", "normalized_name": "art rock", "vote_count": 5},
        {"name": "Metal", "normalized_name": "metal", "vote_count": 9},
        {"name": "Folk", "normalized_name": "folk", "vote_count": 2},
        {"name": "Ambient", "normalized_name": "ambient", "vote_count": 0},
        {"name": "Noise", "normalized_name": "noise", "vote_count": -1},
    ]

    assert api.select_display_genres(genres) == ["Metal", "Art Rock", "Z Rock"]


def test_display_genres_uses_zero_vote_fallback_only_when_no_positive_genre_exists():
    api = _client_api()
    assert api.select_display_genres([
        {"name": "Zeuhl", "normalized_name": "zeuhl", "vote_count": 0},
        {"name": "Art Rock", "normalized_name": "art rock", "vote_count": 0},
        {"name": "Noise", "normalized_name": "noise", "vote_count": -1},
    ]) == ["Art Rock", "Zeuhl"]
    assert api.select_display_genres([
        {"name": "Noise", "normalized_name": "noise", "vote_count": -1},
    ]) == ["Genre unavailable"]


def test_default_client_transport_never_negative_caches_identity_lookups():
    from music_app.services import musicbrainz_client, musicbrainz_http

    assert musicbrainz_client.default_get_json.func is musicbrainz_http.get_json
    assert musicbrainz_client.default_get_json.keywords == {"cache_failures": False}
