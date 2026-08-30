from __future__ import annotations

from threading import Event
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from music_app.services import cover_manual_links
from music_app.services import cover_provider_discogs
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_runtime
from music_app.services.cover_provider_candidates import CoverCandidate


def _parse_year(value: object) -> int | None:
    return cover_provider_matching.parse_year(value)


def _match_score(**_kwargs) -> float:
    return 0.9


def _query_variants(artist: str, album: str, edition: str | None, year: int | None):
    return [(artist, album, edition, year)]


def _probe_from_matches(**kwargs) -> list[CoverCandidate]:
    candidates: list[CoverCandidate] = []
    for score, url, meta in kwargs["matches"]:
        candidates.append(
            CoverCandidate(
                source=kwargs["source"],
                url=url,
                score=score,
                width=1200,
                height=1200,
                matched_artist=str(meta.get("artist") or ""),
                matched_album=str(meta.get("album") or ""),
                matched_year=meta.get("year") if isinstance(meta.get("year"), int) else None,
                debug_payload={
                    **meta,
                    "query_mode": kwargs["query_mode"],
                    "raw_results": kwargs.get("raw_results") or [],
                    "probed_contenders": [{"url": url, "status": "ok"}],
                },
            )
        )
    return candidates


def test_api_get_json_keeps_credentials_optional_and_builds_relative_urls():
    calls: list[dict[str, object]] = []

    def fake_getter(url, user_agent, **kwargs):
        calls.append({"url": url, "user_agent": user_agent, **kwargs})
        return {"ok": True}

    no_credentials = SimpleNamespace(
        DISCOGS_CONSUMER_KEY="",
        DISCOGS_CONSUMER_SECRET="",
        DISCOGS_AUTH_ENABLED=False,
    )
    with_credentials = SimpleNamespace(
        DISCOGS_CONSUMER_KEY="key-1",
        DISCOGS_CONSUMER_SECRET="secret-1",
        DISCOGS_AUTH_ENABLED=True,
    )

    cover_provider_discogs.discogs_api_get_json(
        "/database/search",
        "AlbumHavenTests/1.0",
        params={"q": "Artist Album", "page": 1, "blank": ""},
        context="search",
        config=no_credentials,
        http_get_json=fake_getter,
    )
    cover_provider_discogs.discogs_api_get_json(
        "https://api.discogs.com/releases/1?existing=yes",
        "AlbumHavenTests/1.0",
        params={"page": 2},
        context="release",
        config=with_credentials,
        http_get_json=fake_getter,
    )

    first_url = urlsplit(str(calls[0]["url"]))
    assert first_url.scheme == "https"
    assert first_url.netloc == "api.discogs.com"
    assert first_url.path == "/database/search"
    assert parse_qs(first_url.query) == {"q": ["Artist Album"], "page": ["1"]}
    assert calls[0]["extra_headers"] == {}

    second_url = urlsplit(str(calls[1]["url"]))
    assert second_url.path == "/releases/1"
    assert parse_qs(second_url.query) == {"existing": ["yes"], "page": ["2"]}
    assert calls[1]["extra_headers"] == {
        "Authorization": "Discogs key=key-1, secret=secret-1",
    }


def test_api_get_json_uses_configured_loopback_discogs_base_url():
    calls: list[str] = []
    config = SimpleNamespace(
        DISCOGS_API_BASE_URL="http://127.0.0.1:43991/discogs",
        DISCOGS_CONSUMER_KEY="",
        DISCOGS_CONSUMER_SECRET="",
        DISCOGS_AUTH_ENABLED=False,
    )

    cover_provider_discogs.discogs_api_get_json(
        "/database/search",
        "AlbumHavenTests/1.0",
        params={"q": "Artist Album"},
        context="search",
        config=config,
        http_get_json=lambda url, *_args, **_kwargs: calls.append(url) or {},
    )

    requested_url = urlsplit(calls[0])
    assert requested_url.scheme == "http"
    assert requested_url.netloc == "127.0.0.1:43991"
    assert requested_url.path == "/discogs/database/search"
    assert parse_qs(requested_url.query) == {"q": ["Artist Album"]}


def test_search_uses_master_release_specs_dedupes_ranks_top_8_and_serializes_lookup_group():
    calls: list[dict[str, object]] = []

    def api_get_json(url, user_agent, *, params=None, context=""):
        calls.append({"url": url, "params": params or {}, "context": context})
        if context == "database-search:master-artist-release":
            results = [
                {
                    "id": index,
                    "type": "release",
                    "title": f"Test Artist - Test Album {index}",
                    "year": 2000 + index,
                    "resource_url": f"https://api.discogs.com/releases/{index}",
                    "uri": f"https://www.discogs.com/release/{index}",
                }
                for index in range(1, 11)
            ]
            results.append({**results[0]})
            return {"results": results}
        if context.startswith("database-search:"):
            return {"results": []}
        release_id = str(url).rsplit("/", 1)[-1]
        return {
            "id": int(release_id),
            "title": f"Test Album {release_id}",
            "artists_sort": "Test Artist",
            "year": 2000 + int(release_id),
            "uri": f"https://www.discogs.com/release/{release_id}",
            "images": [
                {"type": "secondary", "uri": f"https://images.example/{release_id}-back.jpg"},
                {"type": "primary", "uri": f"https://images.example/{release_id}-front.jpg", "uri150": f"https://thumbs.example/{release_id}.jpg"},
            ],
        }

    def score(**kwargs) -> float:
        return float(kwargs["candidate_year"] or 0) / 3000

    matches = cover_provider_discogs.search_discogs_cover_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        build_query_variants=_query_variants,
        match_score=score,
        parse_year=_parse_year,
        probe_match_candidates=_probe_from_matches,
        api_get_json=api_get_json,
        log_event=lambda *_args, **_kwargs: None,
    )

    search_contexts = [call["context"] for call in calls if call["context"].startswith("database-search:")]
    assert search_contexts[:4] == [
        "database-search:master-artist-release",
        "database-search:master-q",
        "database-search:release-artist-release",
        "database-search:release-q",
    ]
    assert all(call["params"].get("per_page") == 8 for call in calls if call["context"].startswith("database-search:"))
    detail_contexts = [call["context"] for call in calls if call["context"].startswith("release:")]
    assert len(detail_contexts) == 8
    assert detail_contexts[0] == "release:10"
    assert [match["lookup_group"] for match in matches] == ["services"] * len(matches)
    assert matches[0]["source"] == "discogs"
    assert matches[0]["source_label"] == "Discogs"
    assert matches[0]["variant"] == "database-search-release"
    assert "debug_payload" not in matches[0]
    assert "discogs_type" not in matches[0]
    assert "resource_url" not in matches[0]
    assert matches[0]["debug"]["raw_results"][0]["discogs_type"] == "release"
    assert matches[0]["debug"]["raw_results"][0]["resource_url"] == "https://api.discogs.com/releases/10"


def test_discogs_cancellation_after_search_response_stops_details_and_probes():
    cancel_event = Event()
    api_contexts: list[str] = []
    probe_calls: list[dict[str, object]] = []

    def api_get_json(_url, _user_agent, *, params=None, context=""):
        api_contexts.append(context)
        cancel_event.set()
        return {
            "results": [{
                "id": 1,
                "type": "release",
                "title": "Test Artist - Test Album",
                "year": 2001,
                "resource_url": "https://api.discogs.com/releases/1",
            }],
        }

    matches = cover_provider_discogs.search_discogs_cover_candidates(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        build_query_variants=_query_variants,
        match_score=_match_score,
        parse_year=_parse_year,
        probe_match_candidates=lambda **kwargs: probe_calls.append(kwargs) or [],
        api_get_json=api_get_json,
        should_cancel=cancel_event.is_set,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert cancel_event.is_set() is True
    assert matches == []
    assert api_contexts == ["database-search:master-artist-release"]
    assert probe_calls == []


def test_master_expansion_caps_pagination_fetches_releases_and_orders_primary_images():
    calls: list[dict[str, object]] = []

    def api_get_json(url, user_agent, *, params=None, context=""):
        calls.append({"url": url, "params": params or {}, "context": context})
        if context == "master:55":
            return {"versions_url": "https://api.discogs.com/masters/55/versions"}
        if context.startswith("master-versions:55:page-"):
            page = int(str(context).rsplit("-", 1)[-1])
            return {
                "pagination": {"pages": 12},
                "versions": [
                    {
                        "resource_url": f"https://api.discogs.com/releases/{page}",
                        "title": "Test Album",
                        "format": ["Vinyl", "LP"],
                        "country": "US",
                    }
                ],
            }
        release_id = int(str(url).rsplit("/", 1)[-1])
        return {
            "id": release_id,
            "title": "Test Album",
            "artists_sort": "Test Artist",
            "year": 2001,
            "uri": f"https://www.discogs.com/release/{release_id}",
            "images": [
                {"type": "secondary", "uri": f"https://images.example/{release_id}-back.jpg"},
                {"type": "primary", "uri": f"https://images.example/{release_id}-front.jpg", "uri150": f"https://thumbs.example/{release_id}.jpg"},
            ],
        }

    matches = cover_provider_discogs.fetch_discogs_master_release_matches(
        55,
        normalized_url="https://www.discogs.com/master/55",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        api_get_json=api_get_json,
        match_score=_match_score,
    )

    version_calls = [call for call in calls if call["context"].startswith("master-versions:55")]
    assert [call["params"] for call in version_calls] == [{"per_page": 100, "page": page} for page in range(1, 11)]
    assert len([call for call in calls if call["context"].startswith("release:")]) == 10
    assert matches[0][1] == "https://images.example/1-front.jpg"
    assert matches[0][2]["variant"] == "manual-master"
    assert matches[0][2]["format"] == ["Vinyl", "LP"]
    assert matches[0][2]["country"] == "US"
    assert matches[0][2]["thumbnail_url"] == "https://thumbs.example/1.jpg"
    assert matches[1][2]["art_kind"] == "other"


def test_automatic_master_expansion_rejects_release_with_different_artist_identity():
    def api_get_json(url, user_agent, *, params=None, context=""):
        if context == "master:55":
            return {"versions_url": "https://api.discogs.com/masters/55/versions"}
        if context == "master-versions:55:page-1":
            return {
                "pagination": {"pages": 1},
                "versions": [{
                    "resource_url": "https://api.discogs.com/releases/550",
                    "title": "Kill 'Em All",
                }],
            }
        return {
            "id": 550,
            "title": "Kill 'Em All",
            "artists_sort": "Metallica Orchestra",
            "year": 1983,
            "uri": "https://www.discogs.com/release/550",
            "images": [{"type": "primary", "uri": "https://images.example/false-front.jpg"}],
        }

    matches = cover_provider_discogs.fetch_discogs_master_release_matches(
        55,
        normalized_url="https://www.discogs.com/master/55",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Metallica",
        target_album="Kill 'Em All",
        target_edition=None,
        target_year=1983,
        api_get_json=api_get_json,
        match_score=cover_provider_matching.match_score,
    )

    assert matches == []


def test_automatic_release_detail_rechecks_artist_identity_after_search_match():
    def api_get_json(url, user_agent, *, params=None, context=""):
        if context == "database-search:master-artist-release":
            return {
                "results": [{
                    "id": 550,
                    "type": "release",
                    "title": "Metallica - Kill 'Em All",
                    "year": 1983,
                    "resource_url": "https://api.discogs.com/releases/550",
                    "uri": "https://www.discogs.com/release/550",
                }],
            }
        if context.startswith("database-search:"):
            return {"results": []}
        return {
            "id": 550,
            "title": "Kill 'Em All",
            "artists_sort": "Metallica Orchestra",
            "year": 1983,
            "uri": "https://www.discogs.com/release/550",
            "images": [{"type": "primary", "uri": "https://images.example/false-front.jpg"}],
        }

    matches = cover_provider_discogs.discogs_database_search_matches(
        "Metallica",
        "Kill 'Em All",
        None,
        1983,
        "AlbumHavenTests/1.0",
        build_query_variants=_query_variants,
        match_score=cover_provider_matching.match_score,
        parse_year=_parse_year,
        api_get_json=api_get_json,
        log_event=lambda *_args, **_kwargs: None,
        reset_rate_limit_state=lambda: None,
        is_rate_limited=lambda: False,
    )

    assert matches == []


def test_manual_discogs_master_and_release_url_expansion_semantics():
    payloads = {
        "master:77": {"versions_url": "https://api.discogs.com/masters/77/versions"},
        "master-versions:77:page-1": {
            "pagination": {"pages": 1},
            "versions": [{"resource_url": "https://api.discogs.com/releases/770", "title": "Test Album"}],
        },
        "release:770": {
            "id": 770,
            "title": "Test Album",
            "artists_sort": "Test Artist",
            "year": 2001,
            "uri": "https://www.discogs.com/release/770",
            "images": [{"type": "primary", "uri": "https://images.example/master-front.jpg"}],
        },
        "manual-release:88": {
            "id": 88,
            "title": "Release Album",
            "artists_sort": "Release Artist",
            "year": 2002,
            "uri": "https://www.discogs.com/release/88",
            "images": [{"type": "primary", "uri": "https://images.example/release-front.jpg"}],
        },
    }

    def api_get_json(url, user_agent, *, params=None, context=""):
        return payloads[context]

    master_candidates = cover_provider_discogs.expand_discogs_url_candidates(
        "https://www.discogs.com/master/77-test-album",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        api_get_json=api_get_json,
        match_score=_match_score,
        parse_year=_parse_year,
        probe_match_candidates=_probe_from_matches,
        log_event=lambda *_args, **_kwargs: None,
    )
    release_candidates = cover_provider_discogs.expand_discogs_url_candidates(
        "https://www.discogs.com/release/88-release-album",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        api_get_json=api_get_json,
        match_score=_match_score,
        parse_year=_parse_year,
        probe_match_candidates=_probe_from_matches,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert master_candidates is not None
    assert master_candidates[0].debug_payload["variant"] == "manual-master"
    assert master_candidates[0].debug_payload["album_url"] == "https://www.discogs.com/release/770"
    assert release_candidates is not None
    assert release_candidates[0].debug_payload["variant"] == "manual-release"
    assert release_candidates[0].debug_payload["discogs_id"] == 88
    assert release_candidates[0].matched_artist == "Release Artist"


def test_manual_discogs_unknown_url_returns_none_so_generic_fallback_can_continue():
    candidates = cover_provider_discogs.expand_discogs_url_candidates(
        "https://www.discogs.com/sell/item/123456",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        api_get_json=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Unparsed Discogs URLs must not call the API")),
        match_score=_match_score,
        parse_year=_parse_year,
        probe_match_candidates=_probe_from_matches,
        log_event=lambda *_args, **_kwargs: None,
    )

    assert candidates is None


def test_manual_discogs_release_without_images_returns_empty_list_and_is_handled(monkeypatch):
    monkeypatch.setattr(
        cover_provider_runtime,
        "discogs_api_get_json",
        lambda url, user_agent, *, params=None, context="": {
            "id": 456,
            "title": "Release Album",
            "artists_sort": "Release Artist",
            "year": 2002,
            "uri": "https://www.discogs.com/release/456",
            "images": [],
        },
    )
    monkeypatch.setattr(
        cover_provider_runtime,
        "http_get_text",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Parsed Discogs release should not fall through")),
    )

    adapter_candidates = cover_provider_discogs.expand_discogs_url_candidates(
        "https://www.discogs.com/release/456-release-album",
        user_agent="AlbumHavenTests/1.0",
        target_artist="Release Artist",
        target_album="Release Album",
        target_edition=None,
        target_year=2002,
        api_get_json=cover_provider_runtime.discogs_api_get_json,
        match_score=_match_score,
        parse_year=_parse_year,
        probe_match_candidates=_probe_from_matches,
        log_event=lambda *_args, **_kwargs: None,
    )
    manual_matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        ["https://www.discogs.com/release/456-release-album"],
        target_artist="Release Artist",
        target_album="Release Album",
        target_edition=None,
        target_year=2002,
        user_agent="AlbumHavenTests/1.0",
    )

    assert adapter_candidates == []
    assert manual_matches == []


def test_manual_discogs_direct_image_url_uses_generic_manual_image_handling(monkeypatch):
    monkeypatch.setattr(cover_provider_runtime, "probe_match_candidates", _probe_from_matches)
    monkeypatch.setattr(
        cover_provider_runtime,
        "discogs_api_get_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Direct Discogs image URLs must not call the API")),
    )

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        ["https://i.discogs.com/test-cover-token.jpg"],
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
    )

    assert len(matches) == 1
    assert matches[0]["source"] == "discogs"
    assert matches[0]["source_label"] == "Discogs"
    assert matches[0]["lookup_group"] == "manual_links"
    assert matches[0]["variant"] == "manual-url"
    assert matches[0]["url"] == "https://i.discogs.com/test-cover-token.jpg"


def test_rate_limit_stops_later_searches_and_logs_stopped_event():
    events: list[dict[str, object]] = []
    rate_limited = {"hit": False}

    def api_get_json(url, user_agent, *, params=None, context=""):
        rate_limited["hit"] = True
        return {}

    matches = cover_provider_discogs.discogs_database_search_matches(
        "Test Artist",
        "Test Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        build_query_variants=_query_variants,
        match_score=_match_score,
        parse_year=_parse_year,
        api_get_json=api_get_json,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        reset_rate_limit_state=lambda: rate_limited.update(hit=False),
        is_rate_limited=lambda: rate_limited["hit"],
    )

    assert matches == []
    assert [event["action"] for event in events].count("Discogs search stopped after rate limit") == 1
    assert events[-1]["action"] == "Discogs search matches prepared"
    assert events[-1]["prepared_match_count"] == 0


def test_manual_discogs_release_url_serializes_adapter_candidate(monkeypatch):
    assert cover_provider_discogs.parse_discogs_master_id("https://www.discogs.com/master/123-title") == 123
    assert cover_provider_discogs.parse_discogs_release_id("https://www.discogs.com/release/456-title") == 456

    monkeypatch.setattr(cover_provider_runtime, "discogs_api_get_json", lambda url, user_agent, *, params=None, context="": {
        "id": 456,
        "title": "Release Album",
        "artists_sort": "Release Artist",
        "year": 2002,
        "uri": "https://www.discogs.com/release/456",
        "images": [{"type": "primary", "uri": "https://images.example/facade.jpg"}],
    })
    monkeypatch.setattr(cover_provider_runtime, "probe_match_candidates", _probe_from_matches)

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        ["https://www.discogs.com/release/456-release-album"],
        target_artist="Release Artist",
        target_album="Release Album",
        target_edition=None,
        target_year=2002,
        user_agent="AlbumHavenTests/1.0",
    )

    assert len(matches) == 1
    assert matches[0]["source"] == "discogs"
    assert matches[0]["lookup_group"] == "manual_links"
    assert matches[0]["variant"] == "manual-release"
    assert "debug_payload" not in matches[0]
    assert "resource_url" not in matches[0]
    assert matches[0]["debug"]["raw_results"] == [{
        "artist": "Release Artist",
        "album": "Release Album",
        "year": 2002,
        "album_url": "https://www.discogs.com/release/456",
        "resource_url": "https://api.discogs.com/releases/456",
        "discogs_type": "release",
    }]
