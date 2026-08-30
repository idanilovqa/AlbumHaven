from __future__ import annotations

from music_app.services import cover_provider_apple
from music_app.services import cover_provider_fallback_web as fallback_web
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_runtime


def test_genius_extractors_prefer_page_data_cover_arts():
    html = (
        '<meta itemprop="page_data" content="{&quot;album&quot;:{&quot;cover_arts&quot;:['
        '{&quot;image_url&quot;:&quot;https://t2.genius.com/unsafe/300x300/https%3A%2F%2Fimages.genius.com%2Fcover.jpg&quot;},'
        '{&quot;thumbnail_image_url&quot;:&quot;https://images.genius.com/thumb.jpg&quot;}]}}">'
        '<div class="header_with_cover_art-cover_art"><img class="cover_art-image" '
        'src="https://images.genius.com/header.jpg"></div>'
    )

    assert fallback_web.extract_genius_image_candidates(html) == [
        "https://images.genius.com/cover.jpg",
        "https://images.genius.com/thumb.jpg",
    ]


def test_genius_extractors_use_header_then_album_field_fallbacks():
    header_html = (
        '<div class="header_with_cover_art-cover_art">'
        '<img class="cover_art-image" src="https://images.genius.com/header.jpg">'
        "</div>"
        '"cover_art_url":"https://images.genius.com/field.jpg"'
    )
    field_html = '"header_image_url":"//images.genius.com/field-header.webp"'

    assert fallback_web.extract_genius_image_candidates(header_html) == ["https://images.genius.com/header.jpg"]
    assert fallback_web.extract_genius_image_candidates(field_html) == ["https://images.genius.com/field-header.webp"]


def test_genius_metadata_and_search_links_are_album_specific():
    html = (
        '<meta property="og:title" content="Blue Rev by Alvvays | Genius">'
        '<meta property="og:description" content="Blue Rev by Alvvays. Released in 2022.">'
        '"cover_art_url":"https://images.genius.com/blue-rev.jpg"'
    )
    search_html = (
        '<a href="/l/?uddg=https%3A%2F%2Fgenius.com%2Falbums%2FAlvvays%2FBlue-rev">Album</a>'
        '<a href="https://genius.com/Alvvays-after-the-earthquake-lyrics">Song</a>'
        '<a href="https://example.com/albums/Alvvays/Blue-rev">Other</a>'
    )

    assert fallback_web.extract_genius_album_page_metadata(html, "https://genius.com/albums/Alvvays/Blue-rev") == (
        "Blue Rev",
        "Alvvays",
        2022,
        ["https://images.genius.com/blue-rev.jpg"],
    )
    assert fallback_web.extract_genius_album_links_from_search_html(search_html) == [
        "https://genius.com/albums/Alvvays/Blue-rev"
    ]


def test_search_genius_candidates_uses_web_discovery_and_probing():
    fetched: list[tuple[str, str, str]] = []

    def http_get_text(url: str, user_agent: str, *, service: str, context: str):
        fetched.append((url, service, context))
        if "duckduckgo" in url:
            return '<a href="https://genius.com/albums/Alvvays/Blue-rev">Blue Rev</a>'
        if "bing" in url:
            return ""
        return (
            '<meta property="og:title" content="Blue Rev by Alvvays | Genius">'
            '<meta property="og:description" content="Released in 2022">'
            '"cover_art_url":"https://images.genius.com/blue-rev.jpg"'
        )

    def probe_match_candidates(**kwargs):
        assert kwargs["source"] == "genius"
        assert kwargs["query_mode"] == "genius-album-page"
        score, image_url, payload = kwargs["matches"][0]
        assert score == 0.91
        assert image_url == "https://images.genius.com/blue-rev.jpg"
        assert payload["source_label"] == "Genius"
        return [
            fallback_web.CoverCandidate(
                source="genius",
                url=image_url,
                score=score,
                matched_artist=payload["artist"],
                matched_album=payload["album"],
                matched_year=payload["year"],
                debug_payload={"query_mode": kwargs["query_mode"], **payload},
            )
        ]

    candidates = fallback_web.search_genius_candidates(
        "Alvvays",
        "Blue Rev",
        None,
        2022,
        "UA",
        http_get_text=http_get_text,
        match_score=lambda **kwargs: 0.91,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=probe_match_candidates,
        dedupe_candidates=lambda candidates: candidates,
    )

    assert [candidate.source for candidate in candidates] == ["genius"]
    assert any(service == "genius-discovery" for _, service, _ in fetched)
    assert any(service == "genius" for _, service, _ in fetched)


def test_manual_genius_fetch_failure_missing_probe_and_unprobed_fallback():
    events: list[dict[str, object]] = []

    def log_event(config, logger, action, **fields):
        events.append({"action": action, **fields})

    failure = fallback_web.expand_manual_genius_album_url_candidates(
        "https://genius.com/albums/Alvvays/Blue-rev",
        target_artist="Alvvays",
        target_album="Blue Rev",
        target_edition=None,
        target_year=2022,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: "",
        match_score=lambda **kwargs: 1.0,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [],
        log_event=log_event,
        logger=None,
    )
    assert failure == []
    assert any(event["action"] == "Manual Genius album fetch failed" for event in events)

    events.clear()
    missing = fallback_web.expand_manual_genius_album_url_candidates(
        "https://genius.com/albums/Alvvays/Blue-rev",
        target_artist="Alvvays",
        target_album="Blue Rev",
        target_edition=None,
        target_year=2022,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: '<meta property="og:title" content="Blue Rev by Alvvays | Genius">',
        match_score=lambda **kwargs: 1.0,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [],
        log_event=log_event,
        logger=None,
    )
    assert missing == []
    assert any(event["action"] == "Manual Genius album image missing" for event in events)

    events.clear()
    html = (
        '<meta property="og:title" content="Blue Rev by Alvvays | Genius">'
        '"cover_art_url":"https://images.genius.com/blue-rev.jpg"'
    )
    probed = fallback_web.expand_manual_genius_album_url_candidates(
        "https://genius.com/albums/Alvvays/Blue-rev",
        target_artist="Alvvays",
        target_album="Blue Rev",
        target_edition=None,
        target_year=2022,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: html,
        match_score=lambda **kwargs: 0.88,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [
            fallback_web.CoverCandidate(
                source="direct_url",
                url="https://images.genius.com/blue-rev.jpg",
                score=0.88,
                debug_payload={"query_mode": "manual-url", "source_label": "Genius"},
            )
        ],
        log_event=log_event,
        logger=None,
    )
    assert probed[0].source == "direct_url"
    assert probed[0].debug_payload["source_label"] == "Genius"
    assert any(event["action"] == "Manual Genius album candidates probed" for event in events)

    events.clear()
    unprobed = fallback_web.expand_manual_genius_album_url_candidates(
        "https://genius.com/albums/Alvvays/Blue-rev",
        target_artist="Alvvays",
        target_album="Blue Rev",
        target_edition=None,
        target_year=2022,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: html,
        match_score=lambda **kwargs: 0.88,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [],
        log_event=log_event,
        logger=None,
    )
    assert unprobed[0].source == "direct_url"
    assert unprobed[0].debug_payload["query_mode"] == "manual-url"
    assert unprobed[0].debug_payload["source_label"] == "Genius"
    assert any(event["action"] == "Manual Genius album candidates fell back to unprobed images" for event in events)


def test_amazon_extracts_payload_patterns_cleans_sizing_and_uses_og_fallback():
    html = r'''
        {"hiRes":"https://m.media-amazon.com/images/I/hires._SX300_.jpg"}
        {"large":"https://m.media-amazon.com/images/I/large.jpg"}
        data-old-hires="https://m.media-amazon.com/images/I/old-hires.jpg"
        <img id="landingImage" src="https://m.media-amazon.com/images/I/landing.jpg">
        data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/dynamic.jpg&quot;:[1000,1000]}"
        "mainUrl":"https:\/\/m.media-amazon.com\/images\/I\/main.jpg"
        "image":"https:\/\/images-na.ssl-images-amazon.com\/images\/I\/image.jpg"
    '''

    assert fallback_web.extract_amazon_image_candidates(html) == [
        "https://m.media-amazon.com/images/I/hires.jpg",
        "https://m.media-amazon.com/images/I/large.jpg",
        "https://m.media-amazon.com/images/I/old-hires.jpg",
        "https://m.media-amazon.com/images/I/landing.jpg",
        "https://m.media-amazon.com/images/I/dynamic.jpg",
        "https://m.media-amazon.com/images/I/main.jpg",
        "https://images-na.ssl-images-amazon.com/images/I/image.jpg",
    ]
    assert fallback_web.extract_amazon_image_candidates(
        '<meta property="og:image" content="https://m.media-amazon.com/images/I/og._SL1500_.jpg">'
    ) == ["https://m.media-amazon.com/images/I/og.jpg"]


def test_manual_amazon_product_requires_dp_path_and_serializes_manual_product():
    def probe_match_candidates(**kwargs):
        assert kwargs["source"] == "amazon"
        assert kwargs["query_mode"] == "manual-product"
        score, image_url, payload = kwargs["matches"][0]
        return [
            fallback_web.CoverCandidate(
                source="amazon",
                url=image_url,
                score=score,
                matched_album=payload["album"],
                debug_payload={"query_mode": kwargs["query_mode"], **payload},
            )
        ]

    assert fallback_web.expand_manual_amazon_product_url_candidates(
        "https://www.amazon.com/not-product",
        target_artist="Artist",
        target_album="Album",
        target_edition=None,
        target_year=2001,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not fetch")),
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        match_score=lambda **kwargs: 1.0,
        probe_match_candidates=probe_match_candidates,
    ) is None

    candidates = fallback_web.expand_manual_amazon_product_url_candidates(
        "https://www.amazon.com/dp/B000000001?tag=test",
        target_artist="Artist",
        target_album="Album",
        target_edition=None,
        target_year=2001,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: (
            '<meta property="og:title" content="Album: Amazon.com">'
            '"hiRes":"https://m.media-amazon.com/images/I/cover.jpg"'
        ),
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        match_score=lambda **kwargs: 0.77,
        probe_match_candidates=probe_match_candidates,
    )

    assert candidates is not None
    assert candidates[0].source == "amazon"
    assert candidates[0].debug_payload["variant"] == "manual-product"
    assert candidates[0].debug_payload["source_label"] == "Amazon"


def test_generic_manual_direct_image_probe_failure_and_page_og_image():
    direct = fallback_web.expand_manual_direct_image_url_candidates(
        "https://example.com/cover.jpg",
        target_artist="Artist",
        target_album="Album",
        target_year=2001,
        user_agent="UA",
        manual_source_details=lambda url: ("direct_url", "example.com"),
        probe_match_candidates=lambda **kwargs: [],
    )

    assert direct[0].source == "direct_url"
    assert direct[0].url == "https://example.com/cover.jpg"
    assert direct[0].debug_payload["source_label"] == "example.com"
    assert direct[0].debug_payload["art_kind"] == "cover"
    assert direct[0].debug_payload["art_label"] == "Front cover"

    page = fallback_web.expand_generic_manual_page_url_candidates(
        "https://example.com/albums/album",
        target_artist="Artist",
        target_album="Album",
        target_edition=None,
        target_year=2001,
        user_agent="UA",
        http_get_text=lambda *args, **kwargs: (
            '<meta property="og:title" content="Album page">'
            '<meta property="og:description" content="Released 2001">'
            '<meta property="og:image" content="https://example.com/og.jpg">'
        ),
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        manual_source_details=lambda url: ("direct_url", "example.com"),
        match_score=lambda **kwargs: 0.66,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [
            fallback_web.CoverCandidate(
                source=kwargs["source"],
                url=kwargs["matches"][0][1],
                score=kwargs["matches"][0][0],
                debug_payload={"query_mode": kwargs["query_mode"], **kwargs["matches"][0][2]},
            )
        ],
    )

    assert page[0].debug_payload["variant"] == "manual-page"
    assert page[0].debug_payload["album_url"] == "https://example.com/albums/album"


def test_manual_direct_image_classification_survives_probe_path(monkeypatch):
    expected = {
        "https://example.com/scans/other-art-1.jpg": ("other", "Other art"),
        "https://example.com/scans/booklet-page-02.jpg": ("other", "Booklet"),
        "https://example.com/scans/back-cover.jpg": ("other", "Back cover"),
        "https://example.com/scans/disc-1.png": ("other", "Disc art"),
        "https://example.com/scans/media.webp": ("other", "Media art"),
        "https://example.com/media/front-cover.jpg": ("cover", "Front cover"),
    }

    monkeypatch.setattr(
        cover_provider_runtime,
        "probe_candidate_metrics",
        lambda *_args, **_kwargs: {
            "raw_bytes": b"image-bytes",
            "width": 1000,
            "height": 1000,
            "area": 1_000_000,
            "sharpness": 1.0,
        },
    )
    monkeypatch.setattr(cover_provider_runtime.LOGGER, "verbose", lambda *_args, **_kwargs: None, raising=False)

    for image_url, (art_kind, art_label) in expected.items():
        candidates = fallback_web.expand_manual_direct_image_url_candidates(
            image_url,
            target_artist="Artist",
            target_album="Album",
            target_year=2001,
            user_agent="UA",
            manual_source_details=lambda _url: ("direct_url", "example.com"),
            probe_match_candidates=cover_provider_runtime.probe_match_candidates,
        )

        assert candidates[0].debug_payload["art_kind"] == art_kind
        assert candidates[0].debug_payload["art_label"] == art_label


def test_artist_website_discovery_blocks_hosts_uses_musicbrainz_threshold_bing_and_deadline():
    events: list[dict[str, object]] = []
    calls: list[tuple[str, str]] = []

    def http_get_json(url: str, user_agent: str, *, service: str, context: str):
        calls.append((service, context))
        if "artist/?" in url:
            return {"artists": [{"id": "artist-1", "name": "Example Band"}]}
        return {
            "relations": [
                {"type": "official homepage", "url": {"resource": "https://exampleband.com/?utm=1"}},
                {"type": "official homepage", "url": {"resource": "https://facebook.com/exampleband"}},
            ]
        }

    discovered = fallback_web.discover_artist_website_urls_via_musicbrainz(
        "Example Band",
        "UA",
        http_get_json=http_get_json,
        similarity=lambda left, right: 0.82,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=None,
    )
    assert discovered == ["https://exampleband.com/"]
    assert events[-1]["action"] == "Artist website MusicBrainz discovery completed"
    assert events[-1]["matched_artist_score"] == 0.82

    below_threshold = fallback_web.discover_artist_website_urls_via_musicbrainz(
        "Example Band",
        "UA",
        http_get_json=http_get_json,
        similarity=lambda left, right: 0.2,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=None,
    )
    assert below_threshold == []

    web = fallback_web.discover_artist_website_urls_via_web_search(
        "Example Band",
        "UA",
        http_get_text=lambda *args, **kwargs: (
            '<a href="https://facebook.com/exampleband">social</a>'
            '<a href="/l/?uddg=https%3A%2F%2Fexampleband.com%2Fhome%3Fx%3D1">home</a>'
        ),
    )
    assert web == ["https://exampleband.com/home"]
    assert fallback_web.discover_artist_website_urls_via_web_search(
        "Example Band",
        "UA",
        http_get_text=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("deadline should stop search")),
        deadline=0.0,
        deadline_expired=lambda deadline: True,
    ) == []


def test_artist_website_musicbrainz_prefers_shared_identity_over_higher_fuzzy_score():
    detail_requests: list[str] = []

    def http_get_json(url: str, _user_agent: str, **_kwargs):
        if "artist/?" in url:
            return {
                "artists": [
                    {"id": "similar-first", "name": "Morse Portnoy Georg"},
                    {"id": "shared-identity", "name": "Morse Portnoy George"},
                ],
            }
        detail_requests.append(url)
        return {
            "relations": [{
                "type": "official homepage",
                "url": {"resource": "https://mpg.example/"},
            }],
        }

    discovered = fallback_web.discover_artist_website_urls_via_musicbrainz(
        "Morse, Portnoy & George",
        "UA",
        http_get_json=http_get_json,
        similarity=lambda _left, right: 0.99 if right == "Morse Portnoy Georg" else 0.8,
        log_event=None,
    )

    assert discovered == ["https://mpg.example/"]
    assert len(detail_requests) == 1
    assert "/artist/shared-identity?" in detail_requests[0]


def test_artist_website_musicbrainz_rejects_incompatible_identity_markers():
    detail_requests: list[str] = []

    def http_get_json(url: str, _user_agent: str, **_kwargs):
        if "artist/?" in url:
            return {"artists": [{"id": "tribute", "name": "Example Band Tribute"}]}
        detail_requests.append(url)
        return {}

    assert fallback_web.discover_artist_website_urls_via_musicbrainz(
        "Example Band",
        "UA",
        http_get_json=http_get_json,
        similarity=lambda _left, _right: 0.99,
        log_event=None,
    ) == []
    assert detail_requests == []


def test_artist_website_musicbrainz_rejects_added_orchestra_identity():
    detail_requests: list[str] = []

    def http_get_json(url: str, _user_agent: str, **_kwargs):
        if "artist/?" in url:
            return {"artists": [{"id": "orchestra", "name": "Electric Light Orchestra"}]}
        detail_requests.append(url)
        return {}

    assert fallback_web.discover_artist_website_urls_via_musicbrainz(
        "Electric Light",
        "UA",
        http_get_json=http_get_json,
        similarity=lambda _left, _right: 0.99,
        log_event=None,
    ) == []
    assert detail_requests == []


def test_artist_website_search_logs_completion_and_uses_bing_fallback():
    events: list[dict[str, object]] = []

    def http_get_text(url: str, user_agent: str, *, service: str, context: str):
        if context.startswith("artist-website:"):
            return '<a href="https://exampleband.com">home</a>'
        if context.startswith("artist-album-page:"):
            return '<a href="https://exampleband.com/albums/album">album</a>'
        if context.startswith("album-page:"):
            return (
                '<meta property="og:title" content="Album">'
                '<meta property="og:description" content="2001">'
                '<meta property="og:image" content="https://exampleband.com/cover.jpg">'
            )
        return ""

    candidates = fallback_web.search_artist_website_candidates(
        "Example Band",
        "Album",
        None,
        2001,
        "UA",
        http_get_text=http_get_text,
        http_get_json=lambda *args, **kwargs: {},
        extract_meta_content=cover_provider_apple.extract_apple_meta_content,
        match_score=lambda **kwargs: 0.74,
        parse_year=cover_provider_matching.parse_year,
        probe_match_candidates=lambda **kwargs: [
            fallback_web.CoverCandidate(
                source="artist_website",
                url=kwargs["matches"][0][1],
                score=kwargs["matches"][0][0],
                debug_payload={"query_mode": kwargs["query_mode"], **kwargs["matches"][0][2]},
            )
        ],
        dedupe_candidates=lambda candidates: candidates,
        similarity=lambda left, right: 0.0,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=None,
        now=lambda: 1.0,
    )

    assert candidates[0].source == "artist_website"
    assert candidates[0].debug_payload["source_label"] == "Artist Website"
    assert any(event["action"] == "Artist website search completed" and event["candidate_count"] == 1 for event in events)
