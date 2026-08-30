from __future__ import annotations

import pytest

from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    build_lookup_matches_from_candidates,
)


def _logger():
    return type("Logger", (), {"verbose": lambda self, *args, **kwargs: None})()


@pytest.fixture(autouse=True)
def _reset_youtube_music_client_state(monkeypatch):
    from music_app.services import cover_provider_youtube_music as ytm

    ytm.reset_youtube_music_client_state()
    yield
    ytm.reset_youtube_music_client_state()


def test_optional_dependency_unavailable_skips_client_search(monkeypatch):
    from music_app.services import cover_provider_youtube_music as ytm

    events: list[dict[str, object]] = []
    monkeypatch.setattr(ytm, "YTMusic", None)

    candidates = ytm.search_youtube_music_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        build_query_variants=lambda *args: [],
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        probe_match_candidates=lambda **kwargs: [],
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )

    assert candidates == []
    assert ytm.youtube_music_enabled(config=object()) is False
    assert events[0]["action"] == "YouTube Music search skipped"
    assert events[0]["reason"] == "client_unavailable"


def test_client_initialization_failure_logs_and_uses_false_sentinel(monkeypatch):
    from music_app.services import cover_provider_youtube_music as ytm

    events: list[dict[str, object]] = []
    attempts = 0

    class BrokenYTMusic:
        def __init__(self):
            nonlocal attempts
            attempts += 1
            raise RuntimeError("boom")

    monkeypatch.setattr(ytm, "YTMusic", BrokenYTMusic)

    first = ytm.youtube_music_client(
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )
    second = ytm.youtube_music_client(
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )

    assert first is None
    assert second is None
    assert attempts == 1
    assert events == [
        {
            "action": "YouTube Music client initialization failed",
            "level": "info",
            "reason": "RuntimeError",
            "detail": "boom",
        }
    ]


def test_client_reuses_singleton_instance(monkeypatch):
    from music_app.services import cover_provider_youtube_music as ytm

    class FakeYTMusic:
        pass

    monkeypatch.setattr(ytm, "YTMusic", FakeYTMusic)

    first = ytm.youtube_music_client(log_event=None, logger=_logger())
    second = ytm.youtube_music_client(log_event=None, logger=_logger())

    assert first is second
    assert isinstance(first, FakeYTMusic)


def test_search_shapes_results_with_browse_url_raw_payload_and_probe_call():
    from music_app.services import cover_provider_youtube_music as ytm

    class FakeClient:
        def __init__(self):
            self.calls: list[dict[str, object]] = []

        def search(self, query, *, filter, limit, ignore_spelling):
            self.calls.append({
                "query": query,
                "filter": filter,
                "limit": limit,
                "ignore_spelling": ignore_spelling,
            })
            return [
                {
                    "title": "Test Album",
                    "artists": [{"name": "Test Artist"}],
                    "year": "2001",
                    "browseId": "MPREb_test",
                    "thumbnails": [
                        {"url": "https://yt3.googleusercontent.com/cover=s220", "width": 220, "height": 220},
                        {"url": "https://yt3.googleusercontent.com/cover=s544", "width": 544, "height": 544},
                    ],
                },
                {"title": "No Image", "browseId": "skip"},
            ]

    client = FakeClient()
    probe_calls: list[dict[str, object]] = []

    def fake_probe_match_candidates(**kwargs):
        probe_calls.append(kwargs)
        score, image_url, metadata = kwargs["matches"][0]
        return [
            CoverCandidate(
                source="youtube_music",
                url=image_url,
                score=score,
                width=544,
                height=544,
                debug_payload=metadata,
            )
        ]

    candidates = ytm.search_youtube_music_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        client_getter=lambda **kwargs: client,
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, 2001)],
        match_score=lambda **kwargs: 0.94 if kwargs["candidate_album"] == "Test Album" else 0,
        parse_year=lambda value: 2001 if value else None,
        probe_match_candidates=fake_probe_match_candidates,
        dedupe_candidates=lambda items: items,
        log_event=lambda *args, **kwargs: None,
        logger=_logger(),
    )

    assert client.calls == [
        {
            "query": "Test Artist Test Album 2001",
            "filter": "albums",
            "limit": 10,
            "ignore_spelling": True,
        },
        {
            "query": "Test Artist Test Album",
            "filter": "albums",
            "limit": 10,
            "ignore_spelling": True,
        },
    ]
    assert len(candidates) == 2
    assert probe_calls[0]["source"] == "youtube_music"
    assert probe_calls[0]["query_mode"] == "artist+album+year:native"
    assert probe_calls[0]["raw_results"][0]["browseId"] == "MPREb_test"
    assert probe_calls[0]["probe_limit"] is None
    assert probe_calls[0]["use_score_cutoff"] is False
    assert probe_calls[0]["matches"][0][1] == "https://yt3.googleusercontent.com/cover=s0"
    assert probe_calls[0]["matches"][0][2] == {
        "title": "Test Album",
        "artists": [{"name": "Test Artist"}],
        "year": 2001,
        "browseId": "MPREb_test",
        "album_url": "https://music.youtube.com/browse/MPREb_test",
        "source_label": "YouTube Music",
        "query_mode": "artist+album+year:native",
        "variant": "album-search",
    }
    assert build_lookup_matches_from_candidates(candidates, lookup_group="service")[0]["display_only"] is False


def test_search_failure_logs_and_continues_to_next_query():
    from music_app.services import cover_provider_youtube_music as ytm

    events: list[dict[str, object]] = []

    class FlakyClient:
        def __init__(self):
            self.calls = 0

        def search(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("temporary")
            return []

    ytm.search_youtube_music_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        client_getter=lambda **kwargs: FlakyClient(),
        build_query_variants=lambda *args: [("Test Artist", "Test Album", None, 2001)],
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: None,
        probe_match_candidates=lambda **kwargs: [],
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        logger=_logger(),
    )

    assert any(
        event["action"] == "YouTube Music search failed"
        and event["reason"] == "RuntimeError"
        and event["detail"] == "temporary"
        for event in events
    )
    assert any(event["action"] == "YouTube Music search found no viable matches" for event in events)


def test_best_thumbnail_promotes_largest_google_variant_to_original_size():
    from music_app.services import cover_provider_youtube_music as ytm

    selected = ytm.youtube_music_best_thumbnail([
        {"url": "https://yt3.googleusercontent.com/cover=s220", "width": 220, "height": 220},
        {"url": "https://yt3.googleusercontent.com/cover=s544", "width": 544, "height": 544},
        {"url": "https://yt3.googleusercontent.com/cover=s120", "width": 120, "height": 120},
    ])

    assert selected == ("https://yt3.googleusercontent.com/cover=s0", 544, 544)


def test_page_thumbnail_extraction_handles_escaped_urls_og_precedence_dedupe_and_filters():
    from music_app.services import cover_provider_youtube_music as ytm

    html = r'''
    <meta property="og:image" content="https://lh3.googleusercontent.com/og=w120-h120">
    {"thumbnailUrl":"https:\/\/yt3.googleusercontent.com\/album=s544"}
    "https:\/\/yt3.googleusercontent.com\/album=s544"
    "https:\/\/yt3.googleusercontent.com\/avatar-bad=s544"
    "https:\/\/yt3.googleusercontent.com\/channel_bad=s544"
    "https:\/\/yt3.googleusercontent.com\/photo.jpg=s544"
    '''

    candidates = ytm.extract_youtube_music_page_thumbnails(
        html,
        extract_og_image=lambda page: "https://lh3.googleusercontent.com/og=w120-h120",
    )

    assert candidates == [
        "https://lh3.googleusercontent.com/og=s0",
        "https://yt3.googleusercontent.com/album=s0",
    ]


def test_manual_page_adapter_uses_fetch_context_metadata_score_fallback_and_probe_settings():
    from music_app.services import cover_provider_youtube_music as ytm

    fetch_calls: list[dict[str, object]] = []
    probe_calls: list[dict[str, object]] = []
    html = """
    <meta property="og:title" content="Manual Album">
    <meta property="og:description" content="Released 2005">
    <meta property="og:image" content="https://yt3.googleusercontent.com/manual=s544">
    """

    def fake_http_get_text(url, user_agent, *, service, context):
        fetch_calls.append({"url": url, "user_agent": user_agent, "service": service, "context": context})
        return html

    def fake_probe_match_candidates(**kwargs):
        probe_calls.append(kwargs)
        score, image_url, metadata = kwargs["matches"][0]
        return [CoverCandidate(source="youtube_music", url=image_url, score=score, debug_payload=metadata)]

    candidates = ytm.youtube_music_candidates_from_page_url(
        "https://music.youtube.com/playlist?list=OLAK5uy_test",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Target Artist",
        target_album="Target Album",
        target_edition=None,
        target_year=2005,
        http_get_text=fake_http_get_text,
        extract_meta_content=lambda page, *names: "Manual Album" if "title" in names else "Released 2005",
        extract_og_image=lambda page: "https://yt3.googleusercontent.com/manual=s544",
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: 2005 if "2005" in str(value) else None,
        probe_match_candidates=fake_probe_match_candidates,
    )

    assert len(candidates or []) == 1
    assert fetch_calls == [{
        "url": "https://music.youtube.com/playlist?list=OLAK5uy_test",
        "user_agent": "AlbumHavenTests/1.0",
        "service": "youtube_music",
        "context": "manual-page:https://music.youtube.com/playlist?list=OLAK5uy_test",
    }]
    assert probe_calls[0]["query_mode"] == "manual-youtube-music"
    assert probe_calls[0]["probe_limit"] == 1
    assert probe_calls[0]["use_score_cutoff"] is False
    assert probe_calls[0]["matches"][0] == (
        1.0,
        "https://yt3.googleusercontent.com/manual=s0",
        {
            "album": "Manual Album",
            "artist": "Target Artist",
            "year": 2005,
            "album_url": "https://music.youtube.com/playlist?list=OLAK5uy_test",
            "variant": "manual-page",
            "host": "music.youtube.com",
            "source_label": "YouTube Music",
        },
    )
    assert candidates[0].debug_payload["source_label"] == "YouTube Music"
