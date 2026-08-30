from __future__ import annotations

import urllib.parse

from music_app.services.cover_provider_candidates import CoverCandidate, build_lookup_matches_from_candidates


def test_candidate_urls_upgrade_cover_medium_and_dedupe_originals():
    from music_app.services import cover_provider_deezer as deezer

    urls = deezer.deezer_candidate_urls({
        "cover_xl": "https://e-cdns-images.dzcdn.net/images/cover/ABC/1000x1000-000000-80-0-0.jpg",
        "cover_big": "https://e-cdns-images.dzcdn.net/images/cover/ABC/1000x1000-000000-80-0-0.jpg",
        "cover_medium": "https://e-cdns-images.dzcdn.net/images/cover/Medium/250x250-000000-80-0-0.jpg",
        "cover": "https://images.example/original.jpg",
    })

    assert urls[:7] == [
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/2000x2000-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/1800x1800-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/1500x1500-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/1400x1400-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/1200x1200-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/ABC/1000x1000-000000-80-0-0.jpg",
        "https://e-cdns-images.dzcdn.net/images/cover/Medium/2000x2000-000000-80-0-0.jpg",
    ]
    assert urls.count("https://e-cdns-images.dzcdn.net/images/cover/ABC/1000x1000-000000-80-0-0.jpg") == 1
    assert urls[-1] == "https://images.example/original.jpg"


def test_search_deezer_cover_uses_limit_10_query_modes_and_selects_sorted_matches():
    from music_app.services import cover_provider_deezer as deezer

    requested_urls: list[str] = []
    selected_calls: list[dict[str, object]] = []

    def fake_http_get_json(url, user_agent, *, service, context):
        requested_urls.append(url)
        assert user_agent == "AlbumHavenTests/1.0"
        assert service == "deezer"
        assert context.startswith("search:")
        return {
            "data": [
                {
                    "title": "Wrong Album",
                    "artist": {"name": "Wrong Artist"},
                    "release_date": "1999-01-01",
                    "cover_xl": "https://images.example/wrong/1000x1000-000000-80-0-0.jpg",
                },
                {
                    "title": "Test Album",
                    "artist": {"name": "Test Artist"},
                    "release_date": "2001-05-01",
                    "cover_big": "https://images.example/right/1000x1000-000000-80-0-0.jpg",
                },
            ]
        }

    def fake_select_largest_candidate(**kwargs):
        selected_calls.append(kwargs)
        return CoverCandidate(source=kwargs["source"], url=kwargs["matches"][0][1], score=kwargs["matches"][0][0])

    result = deezer.search_deezer_cover(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        http_get_json=fake_http_get_json,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, 2001), ("Test Artist", "Test Album", None, None)],
        match_score=lambda **kwargs: 0.95 if kwargs["candidate_album"] == "Test Album" else 0.15,
        parse_year=lambda value: 2001 if value else None,
        select_largest_candidate=fake_select_largest_candidate,
    )

    assert result is not None
    assert result.source == "deezer"
    assert result.url == "https://images.example/right/2000x2000-000000-80-0-0.jpg"
    assert len(requested_urls) == 1
    first_query = urllib.parse.parse_qs(urllib.parse.urlsplit(requested_urls[0]).query)
    assert first_query["limit"] == ["10"]
    assert '"2001"' in first_query["q"][0]
    assert selected_calls[0]["source"] == "deezer"
    assert selected_calls[0]["query_mode"] == "artist+album+year:native"
    assert [match[0] for match in selected_calls[0]["matches"]] == [0.95, 0.15]


def test_search_deezer_cover_continues_to_non_year_query_when_year_query_has_no_match():
    from music_app.services import cover_provider_deezer as deezer

    queries: list[str] = []

    def fake_http_get_json(url, user_agent, *, service, context):
        queries.append(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["q"][0])
        if len(queries) == 1:
            return {"data": []}
        return {
            "data": [{
                "title": "Test Album",
                "artist": {"name": "Test Artist"},
                "release_date": "",
                "cover": "https://images.example/fallback/1000x1000-000000-80-0-0.jpg",
            }]
        }

    result = deezer.search_deezer_cover(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        http_get_json=fake_http_get_json,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, 2001)],
        match_score=lambda **kwargs: 0.9,
        parse_year=lambda value: None,
        select_largest_candidate=lambda **kwargs: (
            CoverCandidate(source="deezer", url=kwargs["matches"][0][1], score=0.9)
            if kwargs["matches"]
            else None
        ),
    )

    assert result is not None
    assert len(queries) == 2
    assert '"2001"' in queries[0]
    assert '"2001"' not in queries[1]


def test_search_deezer_cover_candidates_logs_and_returns_first_successful_deduped_batch():
    from music_app.services import cover_provider_deezer as deezer

    events: list[dict[str, object]] = []
    issued_urls: list[str] = []

    payloads = [
        None,
        {"payload": "missing-data"},
        {
            "data": [
                {
                    "title": "Test Album",
                    "artist": {"name": "Test Artist"},
                    "release_date": "2001-01-01",
                    "link": "https://www.deezer.com/album/123",
                    "cover_medium": "https://images.example/a/500x500-000000-80-0-0.jpg",
                },
                {
                    "title": "Other Album",
                    "artist": {"name": "Other Artist"},
                    "release_date": "2002-01-01",
                    "link": "https://www.deezer.com/album/456",
                    "cover": "https://images.example/b/500x500-000000-80-0-0.jpg",
                },
            ]
        },
    ]

    def fake_http_get_json(url, user_agent, *, service, context):
        issued_urls.append(url)
        return payloads.pop(0)

    def fake_probe_match_candidates(**kwargs):
        assert kwargs["source"] == "deezer"
        assert kwargs["probe_limit"] is None
        assert kwargs["use_score_cutoff"] is False
        match = kwargs["matches"][0]
        assert match[2]["album_url"] == "https://www.deezer.com/album/123"
        assert match[2]["probe_urls"][0] == "https://images.example/a/2000x2000-000000-80-0-0.jpg"
        return [
            CoverCandidate(source="deezer", url=match[1], score=match[0]),
            CoverCandidate(source="deezer", url=match[1].upper(), score=match[0]),
        ]

    candidates = deezer.search_deezer_cover_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        http_get_json=fake_http_get_json,
        build_query_variants=lambda *args: [
            ("Test Artist", "Test Album", None, 2001),
            ("Test Artist", "Test Album", None, 2001),
            ("Test Artist", "Test Album Expanded", None, 2001),
        ],
        match_score=lambda **kwargs: 0.9 if kwargs["candidate_album"] == "Test Album" else 0.0,
        parse_year=lambda value: 2001 if value else None,
        probe_match_candidates=fake_probe_match_candidates,
        dedupe_candidates=lambda items: items[:1],
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=type("Logger", (), {"verbose": lambda self, *args, **kwargs: None})(),
    )

    assert len(candidates) == 1
    assert urllib.parse.parse_qs(urllib.parse.urlsplit(issued_urls[0]).query)["limit"] == ["25"]
    assert [event["action"] for event in events] == [
        "Deezer search started",
        "Deezer search query issued",
        "Deezer search returned no data",
        "Deezer search query issued",
        "Deezer search payload missing data list",
        "Deezer search query skipped",
        "Deezer search query skipped",
        "Deezer search query issued",
        "Deezer search candidate summary",
        "Deezer search probe completed",
        "Deezer search stopping after probing successful query batch",
    ]


def test_search_deezer_cover_candidates_logs_finished_when_no_viable_candidates():
    from music_app.services import cover_provider_deezer as deezer

    events: list[dict[str, object]] = []

    candidates = deezer.search_deezer_cover_candidates(
        "Test Artist",
        "Missing Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        http_get_json=lambda *args, **kwargs: {"data": [{"title": "Other", "artist": {"name": "Other"}, "cover": ""}]},
        build_query_variants=lambda *args: [("Test Artist", "Missing Album", None, None)],
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: None,
        probe_match_candidates=lambda **kwargs: [],
        dedupe_candidates=lambda items: items,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=type("Logger", (), {"verbose": lambda self, *args, **kwargs: None})(),
    )

    assert candidates == []
    assert [event["action"] for event in events] == [
        "Deezer search started",
        "Deezer search query issued",
        "Deezer search candidate summary",
        "Deezer search found no viable candidate",
        "Deezer search finished",
    ]


def test_expand_deezer_album_url_candidates_uses_album_api_metadata_and_manual_probe_settings():
    from music_app.services import cover_provider_deezer as deezer

    probe_calls: list[dict[str, object]] = []

    def fake_http_get_json(url, user_agent, *, service, context):
        assert url == "https://api.deezer.com/album/123"
        assert service == "deezer"
        assert context == "manual-album:123"
        return {
            "title": "API Album",
            "artist": {"name": "API Artist"},
            "release_date": "2001-02-03",
            "cover": "https://images.example/api/1000x1000-000000-80-0-0.jpg",
        }

    def fake_probe_match_candidates(**kwargs):
        probe_calls.append(kwargs)
        score, image_url, metadata = kwargs["matches"][0]
        return [CoverCandidate(source="deezer", url=image_url, score=score, debug_payload=metadata)]

    candidates = deezer.expand_deezer_album_url_candidates(
        "https://www.deezer.com/us/album/123?utm_source=share",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Target Artist",
        target_album="Target Album",
        target_edition=None,
        target_year=2001,
        http_get_json=fake_http_get_json,
        match_score=lambda **kwargs: 0.77,
        parse_year=lambda value: 2001,
        probe_match_candidates=fake_probe_match_candidates,
    )

    assert len(candidates or []) == 1
    assert probe_calls[0]["query_mode"] == "manual-deezer"
    assert probe_calls[0]["probe_limit"] == 1
    assert probe_calls[0]["use_score_cutoff"] is False
    assert probe_calls[0]["matches"][0][2] == {
        "album": "API Album",
        "artist": "API Artist",
        "year": 2001,
        "album_url": "https://www.deezer.com/us/album/123?utm_source=share",
        "variant": "manual-album",
        "host": "www.deezer.com",
        "source_label": "Deezer",
    }
    assert build_lookup_matches_from_candidates(candidates or [], lookup_group="manual")[0]["display_only"] is False


def test_expand_deezer_album_url_candidates_falls_back_to_target_metadata():
    from music_app.services import cover_provider_deezer as deezer

    candidates = deezer.expand_deezer_album_url_candidates(
        "https://www.deezer.com/album/123",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Target Artist",
        target_album="Target Album",
        target_edition=None,
        target_year=1998,
        http_get_json=lambda *args, **kwargs: {"cover": "https://images.example/fallback/1000x1000-000000-80-0-0.jpg"},
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: None,
        probe_match_candidates=lambda **kwargs: [
            CoverCandidate(source="deezer", url=kwargs["matches"][0][1], score=kwargs["matches"][0][0], debug_payload=kwargs["matches"][0][2])
        ],
    )

    assert candidates
    assert candidates[0].score == 1.0
    assert candidates[0].debug_payload["artist"] == "Target Artist"
    assert candidates[0].debug_payload["album"] == "Target Album"
    assert candidates[0].debug_payload["year"] == 1998
