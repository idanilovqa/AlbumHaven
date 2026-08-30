from __future__ import annotations

import urllib.error
from types import SimpleNamespace

import pytest

from music_app.services.cover_provider_candidates import build_lookup_matches_from_candidates


@pytest.fixture
def spotify():
    from music_app.services import cover_provider_spotify

    cover_provider_spotify.reset_spotify_rate_limit_state()
    with cover_provider_spotify._SPOTIFY_TOKEN_CACHE_LOCK:
        cover_provider_spotify._SPOTIFY_TOKEN_CACHE.clear()
    with cover_provider_spotify._SPOTIFY_REQUEST_PACING_LOCK:
        cover_provider_spotify._SPOTIFY_REQUEST_PACING["next_allowed_at"] = 0.0
        cover_provider_spotify._SPOTIFY_REQUEST_PACING["rate_limited_until"] = 0.0
    return cover_provider_spotify


def _config(**overrides):
    values = {
        "SPOTIFY_API_ENABLED": True,
        "SPOTIFY_CLIENT_ID": "client-id",
        "SPOTIFY_CLIENT_SECRET": "client-secret",
        "SPOTIFY_MARKET": "CA",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_access_token_uses_client_credentials_headers_and_cache(spotify, monkeypatch):
    requests: list[dict[str, object]] = []

    monkeypatch.setattr(spotify.time, "time", lambda: 1000.0)

    def fake_request(url, *, method, headers, data=None, context=""):
        requests.append({
            "url": url,
            "method": method,
            "headers": dict(headers),
            "data": data,
            "context": context,
        })
        return {"access_token": "token-1", "expires_in": 3600}

    first = spotify.spotify_access_token(config=_config(), request_json=fake_request, log_event=lambda *args, **kwargs: None)
    second = spotify.spotify_access_token(config=_config(), request_json=fake_request, log_event=lambda *args, **kwargs: None)

    assert first == "token-1"
    assert second == "token-1"
    assert requests == [
        {
            "url": "https://accounts.spotify.com/api/token",
            "method": "POST",
            "headers": {
                "Authorization": "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            "data": b"grant_type=client_credentials",
            "context": "token",
        }
    ]


def test_access_token_missing_credentials_logs_and_skips_request(spotify):
    events: list[dict[str, object]] = []

    token = spotify.spotify_access_token(
        config=_config(SPOTIFY_API_ENABLED=False, SPOTIFY_CLIENT_ID="", SPOTIFY_CLIENT_SECRET=""),
        api_enabled=lambda: False,
        request_json=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("No request should be made")),
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    assert token is None
    assert events == [
        {
            "action": "Spotify API credentials unavailable",
            "level": "info",
            "has_client_id": False,
            "has_client_secret": False,
        }
    ]


def test_request_json_marks_thread_local_and_global_cooldown_on_429(spotify, monkeypatch):
    class Headers:
        def get(self, name):
            return "7" if name == "Retry-After" else None

    error = urllib.error.HTTPError(
        "https://api.spotify.com/v1/search",
        429,
        "Too Many Requests",
        Headers(),
        None,
    )
    error.read = lambda: b'{"error":"limited"}'
    events: list[str] = []

    monkeypatch.setattr(spotify.time, "time", lambda: 200.0)
    monkeypatch.setattr(spotify.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(spotify.urllib.request, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(error))

    payload = spotify.spotify_request_json(
        "https://api.spotify.com/v1/search",
        method="GET",
        headers={"Accept": "application/json"},
        context="/search",
        log_event=lambda config, logger, action, **fields: events.append(action),
    )

    assert payload is None
    assert spotify.spotify_rate_limited() is True
    with spotify._SPOTIFY_REQUEST_PACING_LOCK:
        assert spotify._SPOTIFY_REQUEST_PACING["rate_limited_until"] == pytest.approx(207.0)
    assert "Spotify API request failed" in events


def test_market_is_sent_to_search_artist_albums_and_album_link_fetch(spotify, monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_api_get(path, *, params=None):
        calls.append({"path": path, "params": dict(params or {})})
        if path == "/search" and params.get("type") == "artist":
            return {"artists": {"items": [{"id": "artist-1", "name": "Test Artist"}]}}
        return {"albums": {"items": []}} if path == "/search" else {"items": []}

    spotify.spotify_collect_album_matches(
        "album query",
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        enforce_year=True,
        query_mode="artist+album+year:native",
        config=_config(SPOTIFY_MARKET="GB"),
        api_get=fake_api_get,
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: None,
        log_event=lambda *args, **kwargs: None,
    )
    spotify.spotify_collect_artist_album_matches(
        "Test Artist",
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        enforce_year=False,
        query_mode="artist+album:native",
        config=_config(SPOTIFY_MARKET="GB"),
        api_get=fake_api_get,
        similarity=lambda left, right: 1.0,
        match_score=lambda **kwargs: 0.0,
        parse_year=lambda value: None,
        log_event=lambda *args, **kwargs: None,
    )
    spotify.spotify_candidates_from_album_url(
        "https://open.spotify.com/album/abc123?si=ignored",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        config=_config(SPOTIFY_MARKET="GB"),
        api_get=fake_api_get,
        match_score=lambda **kwargs: 1.0,
        parse_year=lambda value: None,
        log_event=lambda *args, **kwargs: None,
    )

    assert calls[0]["params"]["market"] == "GB"
    assert calls[1]["params"]["market"] == "GB"
    assert calls[2]["params"]["market"] == "GB"
    assert calls[3] == {"path": "/albums/abc123", "params": {"market": "GB"}}


def test_album_items_shape_raw_results_and_largest_image(spotify):
    matches, raw_results = spotify.spotify_album_matches_from_items(
        [{
            "name": "Test Album",
            "artists": [{"name": "Test Artist"}, {"name": "Guest"}],
            "release_date": "2001-05-01",
            "external_urls": {"spotify": "https://open.spotify.com/album/abc123"},
            "images": [
                {"url": "https://images.example/small.jpg", "width": 300, "height": 300},
                {"url": "https://images.example/large.jpg", "width": 1200, "height": 1200},
            ],
        }],
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        enforce_year=True,
        query_mode="artist+album+year:native",
        match_score=lambda **kwargs: 0.98,
        parse_year=lambda value: 2001,
    )

    assert raw_results == [
        {
            "name": "Test Album",
            "artist": "Test Artist, Guest",
            "year": 2001,
            "album_url": "https://open.spotify.com/album/abc123",
        }
    ]
    assert matches == [
        (
            0.98,
            "https://images.example/large.jpg",
            {
                "album": "Test Album",
                "artist": "Test Artist, Guest",
                "year": 2001,
                "album_url": "https://open.spotify.com/album/abc123",
                "variant": "artist+album+year:native",
                "prefetched_width": 1200,
                "prefetched_height": 1200,
            },
        )
    ]


def test_artist_fallback_uses_best_artist_by_similarity_then_album_matches(spotify):
    calls: list[tuple[str, dict[str, object]]] = []

    def fake_api_get(path, *, params=None):
        calls.append((path, dict(params or {})))
        if path == "/search":
            return {"artists": {"items": [
                {"id": "wrong", "name": "Other Artist"},
                {"id": "best", "name": "Test Artist"},
            ]}}
        assert path == "/artists/best/albums"
        return {"items": [{
            "name": "Test Album",
            "artists": [{"name": "Test Artist"}],
            "release_date": "2001",
            "external_urls": {"spotify": "https://open.spotify.com/album/best"},
            "images": [{"url": "https://images.example/best.jpg", "width": 640, "height": 640}],
        }]}

    matches, raw_results = spotify.spotify_collect_artist_album_matches(
        "Test Artist",
        artist="Test Artist",
        album="Test Album",
        edition=None,
        year=2001,
        enforce_year=False,
        query_mode="artist+album:native",
        config=_config(SPOTIFY_MARKET="US"),
        api_get=fake_api_get,
        similarity=lambda target, candidate: 1.0 if candidate == "Test Artist" else 0.1,
        match_score=lambda **kwargs: 0.91,
        parse_year=lambda value: 2001,
        log_event=lambda *args, **kwargs: None,
    )

    assert calls[1] == (
        "/artists/best/albums",
        {"include_groups": "album,single", "limit": 10, "market": "US"},
    )
    assert matches[0][1] == "https://images.example/best.jpg"
    assert raw_results[0]["album_url"] == "https://open.spotify.com/album/best"


def test_artist_fallback_prefers_shared_identity_before_fetching_albums(spotify):
    requested_paths: list[str] = []

    def api_get(path, *, params):
        requested_paths.append(path)
        if path == "/search":
            return {
                "artists": {
                    "items": [
                        {"id": "tribute", "name": "Morse Portnoy George Tribute"},
                        {"id": "original", "name": "Morse Portnoy George"},
                    ]
                }
            }
        assert path == "/artists/original/albums"
        return {"items": []}

    matches, raw_results = spotify.spotify_collect_artist_album_matches(
        "Morse, Portnoy & George",
        artist="Morse, Portnoy & George",
        album="Cover To Cover",
        edition=None,
        year=2006,
        enforce_year=False,
        query_mode="artist+album:native",
        api_get=api_get,
        similarity=lambda _target, candidate: (
            0.99 if candidate.endswith("Tribute") else 0.61
        ),
        match_score=lambda **_kwargs: 0.0,
        parse_year=lambda _value: None,
        log_event=None,
    )

    assert matches == []
    assert raw_results == []
    assert requested_paths == ["/search", "/artists/original/albums"]


def test_artist_fallback_refuses_incompatible_marker_artist(spotify):
    requested_paths: list[str] = []

    def api_get(path, *, params):
        requested_paths.append(path)
        assert path == "/search"
        return {
            "artists": {
                "items": [
                    {"id": "cover-band", "name": "Morse Portnoy George Cover Band"}
                ]
            }
        }

    matches, raw_results = spotify.spotify_collect_artist_album_matches(
        "Morse, Portnoy & George",
        artist="Morse, Portnoy & George",
        album="Cover To Cover",
        edition=None,
        year=2006,
        enforce_year=False,
        query_mode="artist+album:native",
        api_get=api_get,
        similarity=lambda _target, _candidate: 0.99,
        match_score=lambda **_kwargs: 0.0,
        parse_year=lambda _value: None,
        log_event=None,
    )

    assert matches == []
    assert raw_results == []
    assert requested_paths == ["/search"]


def test_artist_fallback_refuses_added_collaborator_even_with_high_similarity(spotify):
    requested_paths: list[str] = []

    def api_get(path, *, params):
        requested_paths.append(path)
        assert path == "/search"
        return {
            "artists": {
                "items": [{"id": "collaboration", "name": "Metallica & Discrepancies"}]
            }
        }

    matches, raw_results = spotify.spotify_collect_artist_album_matches(
        "Metallica",
        artist="Metallica",
        album="Kill 'Em All",
        edition=None,
        year=1983,
        enforce_year=False,
        query_mode="artist+album:native",
        api_get=api_get,
        similarity=lambda _target, _candidate: 0.99,
        match_score=lambda **_kwargs: 0.0,
        parse_year=lambda _value: None,
        log_event=None,
    )

    assert matches == []
    assert raw_results == []
    assert requested_paths == ["/search"]


def test_pasted_album_link_expands_to_manual_url_candidate_and_serializes_display_only(spotify):
    events: list[dict[str, object]] = []

    def fake_api_get(path, *, params=None):
        assert path == "/albums/abc123"
        assert params == {"market": "US"}
        return {
            "name": "Test Album",
            "artists": [{"name": "Test Artist"}],
            "release_date": "2001-01-01",
            "external_urls": {"spotify": "https://open.spotify.com/album/abc123"},
            "images": [
                {"url": "https://images.example/small.jpg", "width": 64, "height": 64},
                {"url": "https://images.example/large.jpg", "width": 1400, "height": 1400},
            ],
        }

    candidates = spotify.spotify_candidates_from_album_url(
        "https://open.spotify.com/album/abc123?si=share#frag",
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        config=_config(SPOTIFY_MARKET="US"),
        api_get=fake_api_get,
        match_score=lambda **kwargs: 0.99,
        parse_year=lambda value: 2001,
        log_event=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )
    matches = build_lookup_matches_from_candidates(candidates, lookup_group="manual")

    assert len(candidates) == 1
    assert candidates[0].source == "spotify"
    assert candidates[0].url == "https://images.example/large.jpg"
    assert candidates[0].debug_payload["query_mode"] == "manual-url"
    assert candidates[0].debug_payload["probed_contenders"][0]["album_url"] == "https://open.spotify.com/album/abc123"
    assert matches[0]["display_only"] is True
    assert any(event["action"] == "Manual Spotify album candidate created" for event in events)


def test_manual_links_spotify_pasted_link_uses_runtime_api_get(spotify, monkeypatch):
    from music_app.services import cover_manual_links
    from music_app.services import cover_provider_runtime

    monkeypatch.setattr(cover_provider_runtime.Config, "SPOTIFY_API_ENABLED", True)
    monkeypatch.setattr(cover_provider_runtime.Config, "SPOTIFY_CLIENT_ID", "client-id")
    monkeypatch.setattr(cover_provider_runtime.Config, "SPOTIFY_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(cover_provider_runtime.Config, "SPOTIFY_MARKET", "US")
    monkeypatch.setattr(cover_provider_runtime, "log_app_event", lambda *args, **kwargs: None)

    def fake_api_get(path, *, params=None):
        assert path == "/albums/abc123"
        assert params == {"market": "US"}
        return {
            "name": "Test Album",
            "artists": [{"name": "Test Artist"}],
            "release_date": "2001",
            "external_urls": {"spotify": "https://open.spotify.com/album/abc123"},
            "images": [{"url": "https://images.example/large.jpg", "width": 1400, "height": 1400}],
        }

    monkeypatch.setattr(cover_provider_runtime, "spotify_api_get", fake_api_get)

    matches = cover_manual_links.add_manual_cover_candidates_from_urls(
        ["https://open.spotify.com/album/abc123?si=share"],
        target_artist="Test Artist",
        target_album="Test Album",
        target_edition=None,
        target_year=2001,
        user_agent="AlbumHavenTests/1.0",
    )

    assert len(matches) == 1
    assert matches[0]["source"] == "spotify"
    assert matches[0]["query_mode"] == "manual-url"
    assert matches[0]["display_only"] is True
