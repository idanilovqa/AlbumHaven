from __future__ import annotations

import urllib.parse

from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    build_lookup_matches_from_candidates,
)


def _logger():
    return type("Logger", (), {"verbose": lambda self, *args, **kwargs: None})()


def test_artist_page_urls_prefer_shared_identity_and_reject_marker_mismatch():
    from music_app.services import cover_provider_apple as apple

    urls = apple.collect_apple_artist_page_urls(
        "Morse, Portnoy & George",
        "AlbumHavenTests/1.0",
        http_get_json=lambda *_args, **_kwargs: {
            "results": [
                {
                    "artistName": "Morse Portnoy George Tribute",
                    "artistLinkUrl": "https://music.apple.com/us/artist/tribute/2",
                },
                {
                    "artistName": "Morse Portnoy George",
                    "artistLinkUrl": "https://music.apple.com/us/artist/original/1",
                },
            ]
        },
        similarity=lambda _target, candidate: (
            0.99 if candidate.endswith("Tribute") else 0.61
        ),
    )

    assert urls == ["https://music.apple.com/us/artist/original/1"]


def test_artist_ids_prefer_shared_identity_and_reject_marker_mismatch():
    from music_app.services import cover_provider_apple as apple

    artist_ids = apple.collect_apple_artist_ids(
        "Morse, Portnoy & George",
        "AlbumHavenTests/1.0",
        http_get_json=lambda *_args, **_kwargs: {
            "results": [
                {
                    "artistName": "Morse Portnoy George Cover Band",
                    "artistId": 2,
                },
                {
                    "artistName": "Morse Portnoy George",
                    "artistId": 1,
                },
            ]
        },
        similarity=lambda _target, candidate: (
            0.99 if candidate.endswith("Cover Band") else 0.61
        ),
    )

    assert artist_ids == [1]


def test_artist_page_urls_reject_added_identity_member_even_with_high_similarity():
    from music_app.services import cover_provider_apple as apple

    urls = apple.collect_apple_artist_page_urls(
        "Jimi Hendrix",
        "AlbumHavenTests/1.0",
        http_get_json=lambda *_args, **_kwargs: {
            "results": [{
                "artistName": "The Jimi Hendrix Experience",
                "artistLinkUrl": "https://music.apple.com/us/artist/experience/2",
            }]
        },
        similarity=lambda _target, _candidate: 0.99,
    )

    assert urls == []


def test_apple_artwork_urls_upgrade_and_page_art_rejects_non_square():
    from music_app.services import cover_provider_apple as apple

    assert apple.apple_candidate(
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/100x100bb.jpg"
    ) == "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/9999x9999-100.jpg"
    assert apple.apple_page_candidate(
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/600x600bb-60.jpg"
    ) == "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/9999x9999bb-100.jpg"
    assert apple.apple_page_candidate(
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/600x600-60.jpg"
    ) == "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/9999x9999-100.jpg"
    assert apple.apple_page_candidate(
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/abc/600x500bb-60.jpg"
    ) is None


def test_dedupe_apple_matches_orders_by_score_variant_priority_and_artwork_identity():
    from music_app.services import cover_provider_apple as apple

    matches = [
        (0.92, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/shared/9999x9999bb-100.jpg", {"variant": "page-srcset"}),
        (0.94, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/shared/9999x9999-100.jpg", {"variant": "api-artwork"}),
        (0.94, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/page/9999x9999bb-100.jpg", {"variant": "page-srcset"}),
        (0.94, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/web/9999x9999bb-100.jpg", {"variant": "page-web-discovery"}),
        (0.94, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/other/9999x9999bb-100.jpg", {"variant": "other"}),
    ]

    deduped = apple.dedupe_apple_matches(matches)

    assert [item[1].split("/")[-2] for item in deduped] == ["shared", "page", "web", "other"]
    assert deduped[0][2]["variant"] == "api-artwork"


def test_collect_apple_matches_logs_no_payload():
    from music_app.services import cover_provider_apple as apple

    requested: list[str] = []
    verbose_messages: list[tuple[object, ...]] = []

    def fake_http_get_json(url, user_agent, *, service, context):
        requested.append(url)
        assert user_agent == "AlbumHavenTests/1.0"
        assert service == "apple"
        assert context == "search:Test Artist Test Album"
        return None

    matches, raw_results = apple.collect_apple_matches(
        "Test Artist Test Album",
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        enforce_year=False,
        http_get_json=fake_http_get_json,
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
        logger=type("Logger", (), {"verbose": lambda self, *args: verbose_messages.append(args)})(),
    )

    query = urllib.parse.parse_qs(urllib.parse.urlsplit(requested[0]).query)
    assert query == {"term": ["Test Artist Test Album"], "entity": ["album"], "limit": ["20"]}
    assert verbose_messages == [("Apple search returned no payload query=%r", "Test Artist Test Album")]
    assert matches == []
    assert raw_results == []


def test_collect_apple_matches_returns_raw_results_probes_sufficient_api_and_fetches_top_two_pages():
    from music_app.services import cover_provider_apple as apple

    page_fetches: list[str] = []
    probe_calls: list[str] = []

    payload = {
        "results": [
            {
                "artistName": "Test Artist",
                "collectionName": "Test Album",
                "releaseDate": "2001-01-01",
                "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/api/100x100bb.jpg",
                "collectionViewUrl": "https://music.apple.com/us/album/test/1",
            },
            {
                "artistName": "Test Artist",
                "collectionName": "Test Album Deluxe",
                "releaseDate": "2001-01-01",
                "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/api2/100x100bb.jpg",
                "collectionViewUrl": "https://music.apple.com/us/album/test-deluxe/2",
            },
            {
                "artistName": "Test Artist",
                "collectionName": "Test Album Live",
                "releaseDate": "2001-01-01",
                "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/api3/100x100bb.jpg",
                "collectionViewUrl": "https://music.apple.com/us/album/test-live/3",
            },
        ]
    }

    def fake_http_get_json(url, user_agent, *, service, context):
        return payload

    def fake_probe_candidate_metrics(url, **kwargs):
        probe_calls.append(url)
        return {"raw_bytes": b"img", "width": 3200, "height": 3200, "area": 10_240_000, "sharpness": 5.2}

    def fake_http_get_text(url, user_agent, *, service, context):
        page_fetches.append(url)
        page_id = "page1" if url.endswith("/1") else "page2"
        return (
            f'<div slot="artwork"><img alt="Test Album" '
            f'srcset="https://is1-ssl.mzstatic.com/image/thumb/Music/v4/{page_id}/600x600bb.jpg 1x"></div>'
        )

    matches, raw_results = apple.collect_apple_matches(
        "Test Artist Test Album",
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        enforce_year=True,
        stop_on_sufficient=False,
        http_get_json=fake_http_get_json,
        http_get_text=fake_http_get_text,
        match_score=lambda **kwargs: 1.1 if kwargs["candidate_album"] == "Test Album" else 1.02,
        parse_year=lambda value: 2001 if value else None,
        probe_candidate_metrics=fake_probe_candidate_metrics,
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: album in alt,
        logger=_logger(),
    )

    assert raw_results == payload["results"]
    assert len(probe_calls) == 1
    assert page_fetches == [
        "https://music.apple.com/us/album/test/1",
        "https://music.apple.com/us/album/test-deluxe/2",
    ]
    assert matches[0][2]["variant"] == "api-artwork"
    assert matches[0][2]["prefetched_width"] == 3200
    assert {match[2]["variant"] for match in matches} == {"api-artwork", "page-srcset"}


def test_collect_apple_matches_discards_response_when_canceled_during_request():
    from music_app.services import cover_provider_apple as apple

    canceled = False
    probe_calls: list[str] = []

    def fake_http_get_json(*args, **kwargs):
        nonlocal canceled
        canceled = True
        return {
            "results": [{
                "artistName": "Test Artist",
                "collectionName": "Test Album",
                "artworkUrl100": "https://images.example/100x100bb.jpg",
            }]
        }

    matches, raw_results = apple.collect_apple_matches(
        "Test Artist Test Album",
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        enforce_year=False,
        http_get_json=fake_http_get_json,
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        probe_candidate_metrics=lambda url, **kwargs: probe_calls.append(url),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
        should_cancel=lambda: canceled,
        logger=_logger(),
    )

    assert matches == []
    assert raw_results == []
    assert probe_calls == []


def test_apple_web_discovery_stops_before_next_request_after_cancellation():
    from music_app.services import cover_provider_apple as apple

    canceled = False
    requested: list[str] = []

    def fake_http_get_text_with_url(url, *args, **kwargs):
        nonlocal canceled
        requested.append(url)
        canceled = True
        return ('<a href="https://music.apple.com/us/album/test/1">Test</a>', url)

    discovered = apple.discover_apple_album_urls_via_web_search(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        http_get_text_with_url=fake_http_get_text_with_url,
        should_cancel=lambda: canceled,
        log_event=None,
        logger=_logger(),
    )

    assert discovered == []
    assert len(requested) == 1


def test_apple_web_discovery_uses_configured_loopback_search_endpoints(monkeypatch):
    from music_app.services import cover_provider_apple as apple

    requested: list[str] = []
    loopback_origin = "http://127.0.0.1:43991"
    monkeypatch.setattr(
        apple.Config,
        "DUCKDUCKGO_SEARCH_BASE_URL",
        f"{loopback_origin}/duckduckgo/html/",
        raising=False,
    )
    monkeypatch.setattr(
        apple.Config,
        "BING_SEARCH_BASE_URL",
        f"{loopback_origin}/bing/search",
        raising=False,
    )

    def fake_http_get_text_with_url(url, *_args, **_kwargs):
        requested.append(url)
        return "", url

    discovered = apple.discover_apple_album_urls_via_web_search(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        http_get_text_with_url=fake_http_get_text_with_url,
        log_event=None,
        logger=_logger(),
    )

    assert discovered == []
    assert requested
    assert {urllib.parse.urlsplit(url).netloc for url in requested} == {"127.0.0.1:43991"}
    assert {urllib.parse.urlsplit(url).path for url in requested} == {
        "/duckduckgo/html/",
        "/bing/search",
    }


def test_runtime_candidate_probe_discards_response_after_cancellation(monkeypatch):
    from music_app.services import cover_provider_runtime

    canceled = False
    requested: list[str] = []

    def fake_probe_candidate_metrics(url, **kwargs):
        nonlocal canceled
        requested.append(url)
        canceled = True
        return {"raw_bytes": b"img", "width": 1200, "height": 1200, "area": 1_440_000, "sharpness": 5.0}

    monkeypatch.setattr(cover_provider_runtime, "probe_candidate_metrics", fake_probe_candidate_metrics)
    monkeypatch.setattr(cover_provider_runtime, "LOGGER", _logger())
    candidates = cover_provider_runtime.probe_match_candidates(
        source="apple",
        matches=[(1.0, "https://images.example/cover.jpg", {})],
        user_agent="AlbumHavenTests/1.0",
        query_mode="album",
        artist="Test Artist",
        album="Test Album",
        year=None,
        should_cancel=lambda: canceled,
    )

    assert candidates == []
    assert requested == ["https://images.example/cover.jpg"]


def test_search_apple_fallback_order_and_web_fallback_gate(monkeypatch):
    from music_app.services import cover_provider_apple as apple

    calls: list[str] = []

    monkeypatch.setattr(apple, "collect_apple_matches", lambda *args, **kwargs: calls.append("api") or ([], []))
    monkeypatch.setattr(apple, "log_apple_miss", lambda *args, **kwargs: calls.append("miss"))
    monkeypatch.setattr(apple, "collect_apple_artist_lookup_matches", lambda *args, **kwargs: calls.append("artist") or ([], []))
    monkeypatch.setattr(apple, "collect_apple_web_matches", lambda *args, **kwargs: calls.append("web") or [(0.9, "https://images.example/web.jpg", {})])

    result_without_web = apple.search_apple(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        allow_web_fallback=False,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, None)],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        select_largest_candidate=lambda **kwargs: CoverCandidate(source="apple", url=kwargs["matches"][0][1]),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert result_without_web is None
    assert calls == ["api", "miss", "artist"]

    calls.clear()
    result_with_web = apple.search_apple(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        allow_web_fallback=True,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, None)],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        select_largest_candidate=lambda **kwargs: CoverCandidate(source="apple", url=kwargs["matches"][0][1]),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert result_with_web is not None
    assert result_with_web.url == "https://images.example/web.jpg"
    assert calls == ["api", "miss", "artist", "web"]


def test_search_apple_candidates_probes_all_matches_without_cutoff_and_dedupes(monkeypatch):
    from music_app.services import cover_provider_apple as apple

    monkeypatch.setattr(
        apple,
        "collect_apple_matches",
        lambda *args, **kwargs: (
            [
                (0.91, "https://images.example/a.jpg", {"artistName": "Test Artist", "collectionName": "Test Album"}),
                (0.9, "https://images.example/b.jpg", {"artistName": "Test Artist", "collectionName": "Test Album"}),
            ],
            [{"raw": True}],
        ),
    )

    probe_calls: list[dict[str, object]] = []

    def fake_probe_match_candidates(**kwargs):
        probe_calls.append(kwargs)
        return [
            CoverCandidate(source="apple", url=kwargs["matches"][0][1], score=0.91),
            CoverCandidate(source="apple", url=kwargs["matches"][0][1].upper(), score=0.9),
        ]

    should_cancel = lambda: False
    candidates = apple.search_apple_candidates(
        "Test Artist",
        "Test Album",
        None,
        None,
        "AlbumHavenTests/1.0",
        allow_web_fallback=True,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, None)],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=fake_probe_match_candidates,
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
        should_cancel=should_cancel,
    )

    assert len(candidates) == 1
    assert probe_calls[0]["probe_limit"] is None
    assert probe_calls[0]["use_score_cutoff"] is False
    assert probe_calls[0]["raw_results"] == [{"raw": True}]
    assert probe_calls[0]["should_cancel"] is should_cancel


def test_search_apple_candidates_stops_after_strict_query_yields_candidates():
    from music_app.services import cover_provider_apple as apple

    collected_queries: list[str] = []
    probed_matches: list[list[tuple[float, str, dict]]] = []

    def collect_matches(query_text, *_args, **_kwargs):
        collected_queries.append(query_text)
        return (
            [
                (
                    0.98,
                    "https://images.example/base.jpg",
                    {"collectionName": 'Kill "Em" All'},
                ),
                (
                    0.97,
                    "https://images.example/deluxe.jpg",
                    {"collectionName": "Kill 'Em All (Deluxe Edition)"},
                ),
            ],
            [],
        )

    def probe_match_candidates(**kwargs):
        probed_matches.append(kwargs["matches"])
        return [
            CoverCandidate(
                source="apple",
                url=url,
                score=score,
                width=width,
                height=width,
            )
            for width, (score, url, _metadata) in zip(
                (1000, 1400),
                kwargs["matches"],
                strict=True,
            )
        ]

    candidates = apple.search_apple_candidates(
        "Metallica",
        "Kill 'Em All",
        None,
        1983,
        "AlbumHavenTests/1.0",
        allow_web_fallback=False,
        build_query_variants=lambda *args: [
            ("Metallica", "Kill 'Em All", None, 1983)
        ],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=probe_match_candidates,
        collect_matches=collect_matches,
        collect_artist_lookup_matches=lambda *args, **kwargs: ([], []),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert collected_queries == ["Metallica Kill 'Em All 1983"]
    assert len(probed_matches) == 1
    assert len(probed_matches[0]) == 2
    assert [(candidate.url, candidate.width) for candidate in candidates] == [
        ("https://images.example/base.jpg", 1000),
        ("https://images.example/deluxe.jpg", 1400),
    ]


def test_search_apple_candidates_uses_looser_query_when_strict_query_has_no_candidate():
    from music_app.services import cover_provider_apple as apple

    collected_queries: list[str] = []

    def collect_matches(query_text, *_args, **_kwargs):
        collected_queries.append(query_text)
        if query_text.endswith(" 1983"):
            return [], []
        return [
            (
                0.98,
                "https://images.example/base.jpg",
                {"collectionName": 'Kill "Em" All'},
            )
        ], []

    candidates = apple.search_apple_candidates(
        "Metallica",
        "Kill 'Em All",
        None,
        1983,
        "AlbumHavenTests/1.0",
        allow_web_fallback=False,
        build_query_variants=lambda *args: [
            ("Metallica", "Kill 'Em All", None, 1983)
        ],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=lambda **kwargs: [
            CoverCandidate(
                source="apple",
                url=kwargs["matches"][0][1],
                score=kwargs["matches"][0][0],
            )
        ],
        collect_matches=collect_matches,
        collect_artist_lookup_matches=lambda *args, **kwargs: ([], []),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert collected_queries == [
        "Metallica Kill 'Em All 1983",
        "Metallica Kill 'Em All",
    ]
    assert [candidate.url for candidate in candidates] == [
        "https://images.example/base.jpg"
    ]


def test_search_apple_candidates_defers_one_web_sweep_until_native_queries_are_exhausted():
    from music_app.services import cover_provider_apple as apple

    calls: list[str] = []

    def collect_matches(query_text, *_args, **_kwargs):
        calls.append(f"api:{query_text}")
        return [], []

    def collect_artist_lookup_matches(*_args, enforce_year, **_kwargs):
        calls.append(f"artist:{enforce_year}")
        return [], []

    def collect_web_matches(*_args, enforce_year, **_kwargs):
        calls.append(f"web:{enforce_year}")
        return []

    candidates = apple.search_apple_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_web_fallback=True,
        build_query_variants=lambda *args: [
            ("Test Artist", "Test Album", None, 2001)
        ],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=lambda **kwargs: [],
        collect_matches=collect_matches,
        collect_artist_lookup_matches=collect_artist_lookup_matches,
        collect_web_matches=collect_web_matches,
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert candidates == []
    assert calls == [
        "api:Test Artist Test Album 2001",
        "artist:True",
        "api:Test Artist Test Album",
        "artist:False",
        "web:False",
    ]


def test_search_apple_candidates_reuses_identical_artist_search_response_across_fallbacks():
    from music_app.services import cover_provider_apple as apple

    requested_urls: list[str] = []

    def fake_http_get_json(url, *_args, **_kwargs):
        requested_urls.append(url)
        return {"results": []}

    candidates = apple.search_apple_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_web_fallback=True,
        build_query_variants=lambda *args: [
            ("Test Artist", "Test Album", None, 2001)
        ],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=lambda **kwargs: [],
        http_get_json=fake_http_get_json,
        http_get_text=lambda *_args, **_kwargs: None,
        http_get_text_with_url=lambda url, *_args, **_kwargs: ("", url),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
        log_event=None,
    )

    artist_search_urls = [
        url
        for url in requested_urls
        if "entity=musicArtist" in url
    ]
    album_search_urls = [
        url
        for url in requested_urls
        if "entity=album" in url
    ]
    assert candidates == []
    assert len(artist_search_urls) == 1
    assert len(album_search_urls) == 2


def test_search_apple_candidates_uses_looser_query_when_strict_candidate_is_too_small():
    from music_app.services import cover_provider_apple as apple

    collected_queries: list[str] = []

    def collect_matches(query_text, *_args, **_kwargs):
        collected_queries.append(query_text)
        if query_text.endswith(" 1983"):
            return [
                (
                    0.98,
                    "https://images.example/small.jpg",
                    {"collectionName": 'Kill "Em" All'},
                )
            ], []
        return [
            (
                0.97,
                "https://images.example/large.jpg",
                {"collectionName": "Kill 'Em All (Deluxe Edition)"},
            )
        ], []

    def probe_match_candidates(**kwargs):
        score, url, _metadata = kwargs["matches"][0]
        edge = 900 if url.endswith("/small.jpg") else 1400
        return [
            CoverCandidate(
                source="apple",
                url=url,
                score=score,
                width=edge,
                height=edge,
            )
        ]

    candidates = apple.search_apple_candidates(
        "Metallica",
        "Kill 'Em All",
        None,
        1983,
        "AlbumHavenTests/1.0",
        allow_web_fallback=False,
        build_query_variants=lambda *args: [
            ("Metallica", "Kill 'Em All", None, 1983)
        ],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        similarity=lambda left, right: 1.0,
        probe_candidate_metrics=lambda *args, **kwargs: None,
        probe_match_candidates=probe_match_candidates,
        collect_matches=collect_matches,
        collect_artist_lookup_matches=lambda *args, **kwargs: ([], []),
        extract_og_image=lambda html: None,
        album_name_in_alt=lambda album, alt: True,
    )

    assert collected_queries == [
        "Metallica Kill 'Em All 1983",
        "Metallica Kill 'Em All",
    ]
    assert [(candidate.url, candidate.width) for candidate in candidates] == [
        ("https://images.example/small.jpg", 900),
        ("https://images.example/large.jpg", 1400),
    ]


def test_extract_manual_apple_candidates_returns_manual_metadata():
    from music_app.services import cover_provider_apple as apple

    html = """
    <html>
      <head>
        <meta property="og:title" content="Manual Album by Manual Artist on Apple Music">
        <meta name="description" content="Manual Album by Manual Artist on Apple Music. Released 2005.">
        <meta property="og:image" content="https://is1-ssl.mzstatic.com/image/thumb/Music/v4/manual/600x600bb.jpg">
      </head>
    </html>
    """
    probe_calls: list[dict[str, object]] = []

    def fake_probe_match_candidates(**kwargs):
        probe_calls.append(kwargs)
        score, image_url, metadata = kwargs["matches"][0]
        return [CoverCandidate(source="apple", url=image_url, score=score, debug_payload=metadata)]

    candidates = apple.extract_manual_apple_candidates_from_url(
        "https://music.apple.com/us/album/manual/123",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Target Artist",
        target_album="Target Album",
        target_edition=None,
        target_year=2005,
        http_get_text=lambda *args, **kwargs: html,
        match_score=lambda **kwargs: 0.87,
        parse_year=lambda value: 2005 if "2005" in str(value) else None,
        probe_match_candidates=fake_probe_match_candidates,
        extract_og_image=lambda page: apple.extract_apple_meta_content(page, "og:image"),
        album_name_in_alt=lambda album, alt: True,
    )

    assert len(candidates or []) == 1
    assert probe_calls[0]["query_mode"] == "manual-apple"
    assert probe_calls[0]["probe_limit"] == 1
    assert probe_calls[0]["use_score_cutoff"] is False
    assert probe_calls[0]["matches"][0][2] == {
        "album": "Manual Album",
        "artist": "Manual Artist",
        "year": 2005,
        "album_url": "https://music.apple.com/us/album/manual/123",
        "variant": "manual-apple",
        "host": "music.apple.com",
        "source_label": "Apple Music",
    }
    serialized = build_lookup_matches_from_candidates(candidates or [], lookup_group="manual")[0]
    assert serialized["source"] == "apple"
    assert serialized["source_label"] == "Apple Music"
    assert serialized["album_url"] == "https://music.apple.com/us/album/manual/123"
    assert serialized["display_only"] is False


def test_apple_trace_caps_at_eight_events_and_clears_after_finish():
    from music_app.services import cover_provider_apple as apple

    apple.begin_apple_request_trace()
    for index in range(10):
        apple.append_apple_request_trace(context=f"request-{index}", status="ok", elapsed_ms=index + 0.126)

    events = apple.finish_apple_request_trace()

    assert len(events) == 8
    assert events[0] == {"context": "request-0", "status": "ok", "elapsed_ms": 0.13}
    assert events[-1]["context"] == "request-7"
    assert apple.finish_apple_request_trace() == []
