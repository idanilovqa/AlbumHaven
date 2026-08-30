from __future__ import annotations

from threading import Event
import time

import pytest

from music_app.services import cover_provider_registry
from music_app.services import cover_manual_links
from music_app.services import cover_provider_bandcamp
from music_app.services import cover_provider_discogs
from music_app.services import cover_provider_fallback_web
from music_app.services import cover_provider_musicbrainz_caa
from music_app.services import cover_provider_matching
from music_app.services import cover_provider_runtime
from music_app.services.cover_provider_registry import (
    CoverLookupProviderQuery,
    CoverLookupProviderRegistry,
)
from music_app.services.cover_provider_candidates import CoverCandidate
from music_app.services.cover_provider_groups import (
    normalize_cover_provider_groups,
    normalize_enabled_music_services,
)


def _query() -> CoverLookupProviderQuery:
    return CoverLookupProviderQuery(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTest/1.0",
    )


def _candidate(source: str, *, acceptable: bool = True) -> CoverCandidate:
    return CoverCandidate(
        source=source,
        url=f"https://images.example/{source}.jpg",
        score=0.95 if acceptable else 0.2,
        width=1200 if acceptable else 200,
        height=1200 if acceptable else 200,
        matched_artist="Test Artist",
        matched_album="Test Album",
        matched_year=2001,
    )


def _patch_service_lookup_output(monkeypatch):
    monkeypatch.setattr(
        cover_provider_registry,
        "build_lookup_matches_from_candidates",
        lambda candidates, **kwargs: [{"source": candidate.source} for candidate in candidates],
    )


def _patch_service_providers(monkeypatch, provider_results: dict[str, object], call_order: list[str]) -> None:
    def provider_search(service_name: str):
        def search(*_args, **_kwargs):
            call_order.append(service_name)
            result = provider_results.get(service_name, [])
            if isinstance(result, Exception):
                raise result
            return result

        return search

    monkeypatch.setattr(cover_provider_runtime, "search_apple_candidates", provider_search("apple"))
    monkeypatch.setattr(cover_provider_runtime, "search_deezer_candidates", provider_search("deezer"))
    monkeypatch.setattr(
        cover_provider_runtime,
        "search_youtube_music_candidates",
        provider_search("youtube_music"),
    )
    monkeypatch.setattr(cover_provider_runtime, "search_spotify_candidates", provider_search("spotify"))
    monkeypatch.setattr(cover_provider_runtime, "search_genius_candidates", provider_search("genius"))


def _search_service_cover_candidates(**kwargs):
    return cover_provider_registry._search_service_cover_candidates(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTests/1.0",
        **kwargs,
    )


def _capture_service_events(monkeypatch) -> list[dict[str, object]]:
    captured_events: list[dict[str, object]] = []
    monkeypatch.setattr(
        cover_provider_runtime,
        "log_app_event",
        lambda config, logger, action, **fields: captured_events.append({"action": action, **fields}),
    )
    return captured_events


def test_cover_lookup_provider_registry_preserves_group_labels_and_order():
    assert CoverLookupProviderRegistry.provider_group_names == [
        "music_services",
        "manual_urls",
        "bandcamp",
        "cover_art_archive",
        "discogs",
        "artist_website_fallback",
    ]


def test_cover_lookup_provider_registry_runs_service_and_manual_groups(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_service_search(**kwargs):
        calls.append({"group": "services", **kwargs})
        return [{"id": "service-1"}]

    def fake_manual_search(raw_urls, **kwargs):
        calls.append({"group": "manual", "raw_urls": raw_urls, **kwargs})
        return [{"id": "manual-1"}]

    monkeypatch.setattr(cover_provider_registry, "_search_service_cover_candidates", fake_service_search)
    monkeypatch.setattr(cover_manual_links, "add_manual_cover_candidates_from_urls", fake_manual_search)
    service_matches, manual_matches = CoverLookupProviderRegistry().search_music_service_matches(
        _query(),
        manual_urls=["https://images.example/manual.jpg"],
        should_cancel=lambda: False,
    )

    assert service_matches == [{"id": "service-1"}]
    assert manual_matches == [{"id": "manual-1"}]
    assert calls == [
        {
            "group": "services",
            "artist": "Test Artist",
            "album": "Test Album",
            "edition": None,
            "year": 2001,
            "user_agent": "AlbumHavenTest/1.0",
            "allow_apple_web_fallback": True,
            "should_cancel": calls[0]["should_cancel"],
            "enabled_services": None,
            "log_event": None,
        },
        {
            "group": "manual",
            "raw_urls": ["https://images.example/manual.jpg"],
            "target_artist": "Test Artist",
            "target_album": "Test Album",
            "target_edition": None,
            "target_year": 2001,
            "user_agent": "AlbumHavenTest/1.0",
            "should_cancel": calls[1]["should_cancel"],
        },
    ]
    assert normalize_cover_provider_groups() == frozenset(
        CoverLookupProviderRegistry.provider_group_names
    )


def test_cover_lookup_provider_registry_does_not_start_manual_urls_after_service_cancellation(monkeypatch):
    cancel_event = Event()
    manual_calls: list[list[str]] = []

    def fake_service_search(**kwargs):
        cancel_event.set()
        return []

    monkeypatch.setattr(cover_provider_registry, "_search_service_cover_candidates", fake_service_search)
    monkeypatch.setattr(
        cover_manual_links,
        "add_manual_cover_candidates_from_urls",
        lambda raw_urls, **kwargs: manual_calls.append(raw_urls) or [],
    )

    service_matches, manual_matches = CoverLookupProviderRegistry().search_music_service_matches(
        _query(),
        manual_urls=["https://music.apple.com/us/album/test/1"],
        should_cancel=cancel_event.is_set,
    )

    assert service_matches == []
    assert manual_matches == []
    assert manual_calls == []


def test_cover_lookup_provider_registry_uses_query_music_service_configuration(monkeypatch):
    calls: list[object] = []
    monkeypatch.setattr(
        cover_provider_registry,
        "_search_service_cover_candidates",
        lambda **kwargs: calls.append(kwargs["enabled_services"]) or [],
    )
    query = CoverLookupProviderQuery(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTest/1.0",
        enabled_music_services=frozenset({"apple"}),
    )

    CoverLookupProviderRegistry().search_music_service_matches(query)

    assert calls == [frozenset({"apple"})]


def test_enabled_music_service_normalization_rejects_unknown_names():
    with pytest.raises(ValueError, match=r"Unknown music service\(s\): tidal"):
        normalize_enabled_music_services("apple,tidal")


@pytest.mark.parametrize("policy", ["manual-only", "offline"])
def test_cover_lookup_provider_registry_suppresses_external_groups_but_keeps_manual_candidates(
    policy,
    monkeypatch,
):
    def fail_external(*_args, **_kwargs):
        raise AssertionError("external provider group must be disabled")

    monkeypatch.setattr(cover_provider_registry, "_search_service_cover_candidates", fail_external)
    monkeypatch.setattr(cover_provider_bandcamp, "search_bandcamp_cover_candidates", fail_external)
    monkeypatch.setattr(cover_provider_discogs, "search_discogs_cover_candidates", fail_external)
    monkeypatch.setattr(
        cover_provider_musicbrainz_caa,
        "search_cover_art_archive_candidates",
        fail_external,
    )
    monkeypatch.setattr(cover_provider_fallback_web, "search_artist_website_candidates", fail_external)
    monkeypatch.setattr(
        cover_manual_links,
        "add_manual_cover_candidates_from_urls",
        lambda raw_urls, **_kwargs: [{"id": "manual-1", "url": raw_urls[0]}],
    )
    query = CoverLookupProviderQuery(
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        user_agent="AlbumHavenTest/1.0",
        enabled_provider_groups=policy,
    )
    registry = CoverLookupProviderRegistry()

    service_matches, manual_matches = registry.search_music_service_matches(
        query,
        manual_urls=["https://images.example/manual.jpg"],
    )

    assert service_matches == []
    assert manual_matches == [{"id": "manual-1", "url": "https://images.example/manual.jpg"}]
    assert registry.search_bandcamp_matches(query) == []
    assert registry.search_discogs_and_cover_art_archive_matches(query) == ([], [])
    assert registry.search_artist_website_matches(query) == []


def test_search_service_cover_candidates_skips_spotify_when_early_primary_match_exists(monkeypatch):
    call_order: list[str] = []
    captured_events = _capture_service_events(monkeypatch)

    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [_candidate("apple")],
            "deezer": [],
            "youtube_music": [],
            "spotify": [_candidate("spotify")],
            "genius": [_candidate("genius")],
        },
        call_order,
    )

    results = _search_service_cover_candidates()

    assert call_order == ["apple", "deezer", "youtube_music"]
    assert results == [{"source": "apple"}]
    assert any(
        event["action"] == "Cover search provider skipped"
        and event.get("service") == "spotify"
        and event.get("reason") == "acceptable_primary_candidate_already_found"
        for event in captured_events
    )


def test_search_service_cover_candidates_keeps_only_largest_acceptable_apple_match(monkeypatch):
    call_order: list[str] = []
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [
                CoverCandidate(
                    source="apple",
                    url="https://images.example/metallica-base.jpg",
                    score=1.59,
                    width=1000,
                    height=1000,
                    matched_artist="Metallica",
                    matched_album="Kill 'Em All",
                    matched_year=1983,
                ),
                CoverCandidate(
                    source="apple",
                    url="https://images.example/metallica-deluxe.jpg",
                    score=1.59,
                    width=1400,
                    height=1400,
                    matched_artist="Metallica",
                    matched_album="Kill 'Em All (Deluxe Edition)",
                    matched_year=1983,
                ),
            ],
        },
        call_order,
    )

    results = cover_provider_registry._search_service_cover_candidates(
        artist="Metallica",
        album="Kill 'Em All",
        edition=None,
        year=1983,
        user_agent="AlbumHavenTests/1.0",
        enabled_services={"apple"},
    )

    assert len(results) == 1
    assert results[0]["source"] == "apple"
    assert results[0]["album"] == "Kill 'Em All (Deluxe Edition)"
    assert results[0]["resolution"] == "1400x1400"


def test_search_service_cover_candidates_runs_genius_when_no_primary_provider_is_acceptable(monkeypatch):
    call_order: list[str] = []

    _capture_service_events(monkeypatch)
    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [],
            "deezer": [],
            "youtube_music": [],
            "spotify": [],
            "genius": [_candidate("genius")],
        },
        call_order,
    )

    results = _search_service_cover_candidates()

    assert call_order == ["apple", "deezer", "youtube_music", "spotify", "genius"]
    assert results == [{"source": "genius"}]


def test_search_service_cover_candidates_enabled_services_runs_only_selected_provider(monkeypatch):
    call_order: list[str] = []

    _capture_service_events(monkeypatch)
    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [_candidate("apple")],
            "deezer": [_candidate("deezer")],
            "youtube_music": [_candidate("youtube_music")],
            "spotify": [_candidate("spotify")],
            "genius": [_candidate("genius")],
        },
        call_order,
    )

    results = _search_service_cover_candidates(enabled_services={"spotify"})

    assert call_order == ["spotify"]
    assert results == [{"source": "spotify"}]


def test_search_service_cover_candidates_publishes_cumulative_provider_results(monkeypatch):
    call_order: list[str] = []
    published_matches: list[list[dict[str, object]]] = []

    _capture_service_events(monkeypatch)
    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [_candidate("apple")],
            "deezer": [_candidate("deezer")],
        },
        call_order,
    )

    results = _search_service_cover_candidates(
        enabled_services={"apple", "deezer"},
        on_candidates=lambda matches: published_matches.append(matches),
    )

    assert call_order == ["apple", "deezer"]
    assert published_matches == [
        [{"source": "apple"}],
        [{"source": "apple"}, {"source": "deezer"}],
    ]
    assert results == [{"source": "apple"}, {"source": "deezer"}]


def test_search_service_cover_candidates_forwards_cancellation_predicate_to_apple(monkeypatch):
    predicate = lambda: False
    captured: list[object] = []

    _capture_service_events(monkeypatch)
    _patch_service_lookup_output(monkeypatch)
    monkeypatch.setattr(
        cover_provider_runtime,
        "search_apple_candidates",
        lambda *args, **kwargs: captured.append(kwargs.get("should_cancel")) or [],
    )

    results = _search_service_cover_candidates(
        enabled_services={"apple"},
        should_cancel=predicate,
    )

    assert results == []
    assert captured == [predicate]


def test_search_service_cover_candidates_cancellation_before_provider_returns_collected_matches(monkeypatch):
    call_order: list[str] = []
    should_cancel_results = iter([False, False, True, True])
    captured_events = _capture_service_events(monkeypatch)

    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [_candidate("apple")],
            "deezer": [_candidate("deezer")],
            "youtube_music": [_candidate("youtube_music")],
            "spotify": [_candidate("spotify")],
            "genius": [_candidate("genius")],
        },
        call_order,
    )

    results = _search_service_cover_candidates(should_cancel=lambda: next(should_cancel_results))

    assert call_order == ["apple"]
    assert results == [{"source": "apple"}]
    assert any(
        event["action"] == "Cover search canceled before provider"
        and event.get("service") == "deezer"
        for event in captured_events
    )


def test_search_service_cover_candidates_cancellation_after_provider_returns_collected_matches(monkeypatch):
    call_order: list[str] = []
    should_cancel_results = iter([False, True, True, True])
    published_matches: list[list[dict[str, object]]] = []
    captured_events = _capture_service_events(monkeypatch)

    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": [_candidate("apple")],
            "deezer": [_candidate("deezer")],
            "youtube_music": [_candidate("youtube_music")],
            "spotify": [_candidate("spotify")],
            "genius": [_candidate("genius")],
        },
        call_order,
    )

    results = _search_service_cover_candidates(
        should_cancel=lambda: next(should_cancel_results),
        on_candidates=lambda matches: published_matches.append(matches),
    )

    assert call_order == ["apple"]
    assert published_matches == []
    assert results == [{"source": "apple"}]
    assert any(
        event["action"] == "Cover search canceled after provider"
        and event.get("service") == "apple"
        for event in captured_events
    )


@pytest.mark.parametrize(
    ("failing_service", "failure"),
    [
        ("apple", ValueError("malformed Apple candidate width")),
        ("deezer", TypeError("invalid Deezer result shape")),
    ],
)
def test_search_service_cover_candidates_reports_and_propagates_unexpected_early_provider_failure(
    failing_service,
    failure,
    monkeypatch,
):
    call_order: list[str] = []
    captured_events = _capture_service_events(monkeypatch)

    _patch_service_lookup_output(monkeypatch)
    _patch_service_providers(
        monkeypatch,
        {
            "apple": failure if failing_service == "apple" else [],
            "deezer": failure if failing_service == "deezer" else [],
            "youtube_music": [],
            "spotify": [],
            "genius": [],
        },
        call_order,
    )

    with pytest.raises(type(failure), match=str(failure)):
        _search_service_cover_candidates()

    assert call_order == (
        ["apple"]
        if failing_service == "apple"
        else ["apple", "deezer"]
    )
    assert any(
        event["action"] == "Cover search provider failed"
        and event.get("service") == failing_service
        and event.get("artist") == "Test Artist"
        and event.get("album") == "Test Album"
        and event.get("error") == str(failure)
        and event.get("error_kind") == "provider-error"
        for event in captured_events
    )


def test_cover_lookup_provider_registry_runs_bandcamp_owner_not_remote_facade(monkeypatch):
    calls: list[dict[str, object]] = []
    should_cancel = lambda: False
    musicbrainz_context_resolver = lambda *_args, **_kwargs: {
        "artists": [],
        "labels": [],
        "artist_account_urls": [],
        "label_account_urls": [],
    }

    def fake_bandcamp_search(*args, **kwargs):
        calls.append({"args": args, **kwargs})
        return [_candidate("bandcamp")]

    monkeypatch.setattr(cover_provider_bandcamp, "search_bandcamp_cover_candidates", fake_bandcamp_search)
    monkeypatch.setattr(
        cover_provider_runtime,
        "fetch_musicbrainz_bandcamp_context",
        musicbrainz_context_resolver,
        raising=False,
    )
    matches = CoverLookupProviderRegistry().search_bandcamp_matches(
        _query(),
        should_cancel=should_cancel,
    )

    assert [(match.get("source"), match.get("url")) for match in matches] == [
        ("bandcamp", "https://images.example/bandcamp.jpg")
    ]
    assert calls[0]["args"] == ()
    assert calls[0]["artist"] == "Test Artist"
    assert calls[0]["album"] == "Test Album"
    assert calls[0]["edition"] is None
    assert calls[0]["year"] == 2001
    assert calls[0]["user_agent"] == "AlbumHavenTest/1.0"
    assert calls[0]["http_get_text"] is cover_provider_runtime.http_get_text
    assert calls[0]["match_score"] is cover_provider_matching.match_score
    assert calls[0]["probe_match_candidates"] is cover_provider_runtime.probe_match_candidates
    assert calls[0]["fetch_musicbrainz_bandcamp_context"] is musicbrainz_context_resolver
    assert calls[0]["should_cancel"] is should_cancel


def test_cover_lookup_provider_registry_runs_discogs_and_cover_art_archive_in_parallel(monkeypatch):
    cover_art_archive_started = Event()
    discogs_started = Event()
    observed_parallel_overlap: list[bool] = []

    def fake_cover_art_archive_search(**_kwargs):
        cover_art_archive_started.set()
        observed_parallel_overlap.append(discogs_started.wait(1))
        return []

    def fake_discogs_search(**_kwargs):
        discogs_started.set()
        observed_parallel_overlap.append(cover_art_archive_started.wait(1))
        return []

    monkeypatch.setattr(cover_provider_musicbrainz_caa, "search_cover_art_archive_candidates", fake_cover_art_archive_search)
    monkeypatch.setattr(cover_provider_discogs, "search_discogs_cover_candidates", fake_discogs_search)
    discogs_matches, archive_matches = CoverLookupProviderRegistry().search_discogs_and_cover_art_archive_matches(_query())

    assert discogs_matches == []
    assert archive_matches == []
    assert cover_art_archive_started.is_set() is True
    assert discogs_started.is_set() is True
    assert observed_parallel_overlap == [True, True]


def test_cover_lookup_provider_registry_forwards_cancellation_to_concurrent_providers(monkeypatch):
    should_cancel = lambda: False
    caa_predicates: list[object] = []
    discogs_predicates: list[object] = []

    def fake_cover_art_archive_search(**kwargs):
        caa_predicates.append(kwargs.get("should_cancel"))
        return []

    def fake_discogs_search(**kwargs):
        discogs_predicates.append(kwargs.get("should_cancel"))
        return []

    monkeypatch.setattr(
        cover_provider_musicbrainz_caa,
        "search_cover_art_archive_candidates",
        fake_cover_art_archive_search,
    )
    monkeypatch.setattr(
        cover_provider_discogs,
        "search_discogs_cover_candidates",
        fake_discogs_search,
    )

    discogs_matches, archive_matches = (
        CoverLookupProviderRegistry().search_discogs_and_cover_art_archive_matches(
            _query(),
            should_cancel=should_cancel,
        )
    )

    assert discogs_matches == []
    assert archive_matches == []
    assert caa_predicates == [should_cancel]
    assert discogs_predicates == [should_cancel]


def test_cover_lookup_provider_registry_bounds_discogs_and_archive_under_one_deadline(monkeypatch):
    provider_timeout_seconds = 0.25
    shared_deadline_seconds = 0.05
    deadline_cancellations: list[str] = []
    providers_started = Event()
    started_count = 0

    monkeypatch.setattr(
        cover_provider_runtime.Config,
        "COVER_LOOKUP_PROVIDER_DEADLINE_SECONDS",
        shared_deadline_seconds,
        raising=False,
    )

    def slow_provider(provider_name: str, **kwargs):
        nonlocal started_count
        started_count += 1
        if started_count == 2:
            providers_started.set()
        assert providers_started.wait(1)
        should_cancel = kwargs["should_cancel"]
        provider_timeout_at = time.perf_counter() + provider_timeout_seconds
        while time.perf_counter() < provider_timeout_at:
            if should_cancel():
                deadline_cancellations.append(provider_name)
                return []
            time.sleep(0.005)
        return []

    monkeypatch.setattr(
        cover_provider_musicbrainz_caa,
        "search_cover_art_archive_candidates",
        lambda **kwargs: slow_provider("cover_art_archive", **kwargs),
    )
    monkeypatch.setattr(
        cover_provider_discogs,
        "search_discogs_cover_candidates",
        lambda **kwargs: slow_provider("discogs", **kwargs),
    )

    started_at = time.perf_counter()
    discogs_matches, archive_matches = (
        CoverLookupProviderRegistry().search_discogs_and_cover_art_archive_matches(
            _query(),
            should_cancel=lambda: False,
        )
    )
    elapsed_seconds = time.perf_counter() - started_at

    assert discogs_matches == []
    assert archive_matches == []
    assert elapsed_seconds < 0.15
    assert sorted(deadline_cancellations) == ["cover_art_archive", "discogs"]


def test_cover_lookup_provider_registry_sanitizes_cover_art_archive_lookup_matches(monkeypatch):
    monkeypatch.setattr(cover_provider_discogs, "search_discogs_cover_candidates", lambda *args, **_kwargs: [])
    monkeypatch.setattr(
        cover_provider_musicbrainz_caa,
        "search_cover_art_archive_candidates",
        lambda *args, **_kwargs: [{
            "id": "release-1:0",
            "source": "cover_art_archive",
            "url": "https://images.example/caa.jpg",
            "thumbnail_url": "https://images.example/caa-thumb.jpg",
            "width": 1200,
            "height": 1000,
            "area": 1200000,
            "artist": "Test Artist",
            "album": "Test Album",
            "year": 2001,
            "release_mbid": "provider-internal-release-id",
            "debug": {
                "release_mbid": "nested-provider-internal-release-id",
                "future_metadata": {"label": "Private CAA detail"},
                "raw_results": [{"release_mbid": "raw-provider-internal-release-id"}],
            },
            "art_kind": "cover",
            "art_label": "Front cover",
            "score": 0.9876,
        }],
    )

    discogs_matches, archive_matches = CoverLookupProviderRegistry().search_discogs_and_cover_art_archive_matches(_query())

    assert discogs_matches == []
    assert archive_matches == [{
        "id": "caa:release-1:0",
        "source": "cover_art_archive",
        "url": "https://images.example/caa.jpg",
        "thumbnail_url": "https://images.example/caa-thumb.jpg",
        "width": 1200,
        "height": 1000,
        "area": 1200000,
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2001,
        "art_kind": "cover",
        "art_label": "Front cover",
        "score": 0.9876,
        "source_label": "Cover Art Archive",
        "lookup_group": "cover_art_archive",
    }]


def test_cover_lookup_provider_registry_runs_artist_website_owner_not_remote_facade(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_artist_website_search(*args, **kwargs):
        calls.append({"args": args, **kwargs})
        return [_candidate("artist_website")]

    monkeypatch.setattr(cover_provider_fallback_web, "search_artist_website_candidates", fake_artist_website_search)
    matches = CoverLookupProviderRegistry().search_artist_website_matches(_query())

    assert [(match.get("source"), match.get("url")) for match in matches] == [
        ("artist_website", "https://images.example/artist_website.jpg")
    ]
    assert calls[0]["args"] == ()
    assert calls[0]["artist"] == "Test Artist"
    assert calls[0]["album"] == "Test Album"
    assert calls[0]["edition"] is None
    assert calls[0]["year"] == 2001
    assert calls[0]["user_agent"] == "AlbumHavenTest/1.0"
    assert calls[0]["http_get_text"] is cover_provider_runtime.http_get_text
    assert calls[0]["http_get_json"] is cover_provider_runtime.http_get_json
    assert calls[0]["probe_match_candidates"] is cover_provider_runtime.probe_match_candidates
