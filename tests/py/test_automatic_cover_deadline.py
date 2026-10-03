from __future__ import annotations

import time
import socket
import urllib.error

import pytest
import requests


def test_automatic_cover_budget_clamps_network_timeout():
    from music_app.services.cover_provider_deadline import (
        automatic_cover_budget,
        remaining_automatic_cover_seconds,
    )

    with automatic_cover_budget(5.0):
        remaining = remaining_automatic_cover_seconds(15.0)
        assert 0 < remaining <= 5.0
        with automatic_cover_budget(2.0):
            assert 0 < remaining_automatic_cover_seconds(15.0) <= 2.0
        assert 0 < remaining_automatic_cover_seconds(15.0) <= 5.0


def test_expired_automatic_cover_budget_raises_before_network_request():
    from music_app.services.cover_provider_deadline import (
        AutomaticCoverDeadlineExceeded,
        automatic_cover_budget,
        remaining_automatic_cover_seconds,
    )

    with automatic_cover_budget(0.001):
        time.sleep(0.005)
        with pytest.raises(AutomaticCoverDeadlineExceeded):
            remaining_automatic_cover_seconds(15.0)


def test_automatic_http_request_uses_remaining_budget(monkeypatch):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import automatic_cover_budget

    seen = {}

    class Response:
        status = 200
        url = "https://images.example/cover.jpg"

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"cover"

    def fake_urlopen(_request, *, timeout, context):
        seen["timeout"] = timeout
        return Response()

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", fake_urlopen)
    with automatic_cover_budget(3.0):
        payload = cover_provider_http._http_get_bytes(
            "https://images.example/cover.jpg", "AlbumHavenTests/1.0",
        )

    assert payload == b"cover"
    assert 0 < seen["timeout"] <= 3.0


def test_automatic_http_socket_timeout_is_retryable(monkeypatch):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import (
        AutomaticCoverDeadlineExceeded,
        automatic_cover_budget,
    )

    def timeout(*_args, **_kwargs):
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", timeout)
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverDeadlineExceeded):
            cover_provider_http._http_get_bytes(
                "https://images.example/cover.jpg", "AlbumHavenTests/1.0",
            )


@pytest.mark.parametrize("status", [429, 503])
def test_automatic_http_transient_status_is_retryable(monkeypatch, status):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(urllib.error.HTTPError("https://example.test", status, "retry", {}, None))
    ))
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverSearchFailed):
            cover_provider_http._http_get_bytes("https://example.test", "AlbumHavenTests/1.0")


def test_automatic_http_connection_failure_is_retryable(monkeypatch):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(urllib.error.URLError("connection reset"))
    ))
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverSearchFailed):
            cover_provider_http._http_get_bytes("https://example.test", "AlbumHavenTests/1.0")


@pytest.mark.parametrize("payload", [b'{"error":{"code":4,"message":"quota"}}', b"{invalid-json", b"[]", b"null", b""])
def test_automatic_deezer_api_error_or_malformed_json_is_retryable(monkeypatch, payload):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", lambda *_args, **_kwargs: payload)
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverSearchFailed):
            cover_provider_http._http_get_json(
                "https://api.deezer.com/search/album", "AlbumHavenTests/1.0", service="deezer",
            )


@pytest.mark.parametrize("payload", [b"{}", b'{"data":null}', b'{"data":{}}'])
def test_automatic_deezer_missing_result_list_is_retryable(monkeypatch, payload):
    from music_app.services import cover_provider_http, cover_refresh_provider
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", lambda *_args, **_kwargs: payload)
    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        cover_refresh_provider._search_deezer("Artist", "Album", None, 2001, "AlbumHavenTests/1.0")


@pytest.mark.parametrize("payload", [b"[]", b"null", b"{}", b'{"results":null}', b'{"results":{}}'])
def test_automatic_apple_missing_result_list_is_retryable(monkeypatch, payload):
    from music_app.services import cover_provider_http, cover_refresh_provider
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", lambda *_args, **_kwargs: payload)
    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        cover_refresh_provider._search_apple(
            "Artist", "Album", None, 2001, "AlbumHavenTests/1.0", allow_web_fallback=False,
        )


@pytest.mark.parametrize("payload", [b"{invalid-json", b"[]", b"null", b'{"error":{"status":503}}'])
def test_automatic_spotify_invalid_response_is_retryable(monkeypatch, payload):
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return payload

    monkeypatch.setattr(spotify, "spotify_wait_for_request_slot", lambda: None)
    monkeypatch.setattr(spotify.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        spotify.spotify_request_json("https://api.spotify.com/v1/search", method="GET", headers={}, log_event=None)


@pytest.mark.parametrize("payload", [{}, {"albums": {}}, {"albums": {"items": None}}, {"albums": {"items": {}}}])
def test_automatic_spotify_missing_result_list_is_retryable(payload):
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        spotify.spotify_collect_album_matches(
            "Artist Album", artist="Artist", album="Album", edition=None, year=2001,
            enforce_year=True, query_mode="test", api_get=lambda *_args, **_kwargs: payload,
            match_score=lambda **_kwargs: 0.0, parse_year=lambda _value: None, log_event=None,
        )


def test_automatic_spotify_missing_token_is_retryable(monkeypatch):
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(spotify, "_SPOTIFY_TOKEN_CACHE", {"token": "", "expires_at": 0.0})
    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        spotify.spotify_access_token(
            api_enabled=lambda: True, request_json=lambda *_args, **_kwargs: {}, log_event=None,
        )


@pytest.mark.parametrize("status", ["blocked", "connection_error", "invalid_payload", "http_503", "cached_miss", "canceled"])
def test_automatic_musicbrainz_dependency_failure_is_retryable(status):
    from music_app.services import cover_provider_http
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    with automatic_cover_budget(2.0), pytest.raises(AutomaticCoverSearchFailed):
        cover_provider_http._http_get_json(
            "https://musicbrainz.org/ws/2/artist", "AlbumHavenTests/1.0", service="musicbrainz",
            musicbrainz_json_getter=lambda *_args, **_kwargs: (None, {"status": status}),
        )


@pytest.mark.parametrize("provider, payload", [("apple", b'{"results":[]}'), ("deezer", b'{"data":[]}')])
def test_automatic_empty_provider_results_remain_no_match(monkeypatch, provider, payload):
    from music_app.services import cover_provider_http, cover_refresh_provider
    from music_app.services.cover_provider_deadline import automatic_cover_budget

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", lambda *_args, **_kwargs: payload)
    resolver = getattr(cover_refresh_provider, f"_search_{provider}")
    options = {"allow_web_fallback": False} if provider == "apple" else {}
    with automatic_cover_budget(2.0):
        assert resolver("Artist", "Album", None, 2001, "AlbumHavenTests/1.0", **options) is None


@pytest.mark.parametrize("provider", ["refresh", "runtime"])
def test_automatic_probe_keeps_best_prior_candidate_after_expired_later_probe(monkeypatch, provider):
    from music_app.services import cover_provider_deadline, cover_provider_runtime, cover_refresh_provider

    clock = [0.0]
    monkeypatch.setattr(cover_provider_deadline.time, "perf_counter", lambda: clock[0])
    module = cover_refresh_provider if provider == "refresh" else cover_provider_runtime
    logger_name = "_LOGGER" if provider == "refresh" else "LOGGER"
    probe_name = "_probe_candidate_metrics" if provider == "refresh" else "probe_candidate_metrics"
    monkeypatch.setattr(module, logger_name, type("Logger", (), {"verbose": lambda self, *_args: None})())

    def probe(url, **_kwargs):
        if "third" in url:
            clock[0] = 3.0
            raise cover_provider_deadline.AutomaticCoverDeadlineExceeded()
        edge = 900 if "first" in url else 800
        return {"raw_bytes": b"cover", "width": edge, "height": edge, "area": edge * edge, "sharpness": 1.0}

    monkeypatch.setattr(module, probe_name, probe)
    probe_matches = module._probe_match_candidates if provider == "refresh" else module.probe_match_candidates

    def resolver():
        candidates = probe_matches(
            source="youtube_music",
            matches=[(score, f"https://example.test/{name}.jpg", {"artist": "Artist", "album": "Album"})
                     for score, name in [(0.95, "first"), (0.9, "second"), (0.89, "third")]],
            user_agent="AlbumHavenTests/1.0", query_mode="test", artist="Artist", album="Album", year=None,
        )
        return max(candidates, key=lambda candidate: candidate.score)

    candidate = cover_refresh_provider._run_automatic_provider(resolver, (), 2.0)
    assert candidate.width == 900


@pytest.mark.parametrize("payload, expected", [
    (b'{"error":{"code":4,"message":"quota"}}', {"error": {"code": 4, "message": "quota"}}),
    (b"{invalid-json", None),
    (b'{"data":[]}', {"data": []}),
])
def test_manual_deezer_json_behavior_is_unchanged(monkeypatch, payload, expected):
    from music_app.services import cover_provider_http

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", lambda *_args, **_kwargs: payload)
    assert cover_provider_http._http_get_json(
        "https://api.deezer.com/search/album", "AlbumHavenTests/1.0", service="deezer",
    ) == expected


def test_spotify_pacing_does_not_sleep_past_automatic_budget(monkeypatch):
    from music_app.services import cover_provider_spotify
    from music_app.services.cover_provider_deadline import (
        AutomaticCoverDeadlineExceeded,
        automatic_cover_budget,
    )

    monkeypatch.setattr(cover_provider_spotify.time, "sleep", lambda _seconds: pytest.fail("long pacing sleep"))
    with cover_provider_spotify._SPOTIFY_REQUEST_PACING_LOCK:
        cover_provider_spotify._SPOTIFY_REQUEST_PACING["next_allowed_at"] = time.time() + 60.0
    try:
        with automatic_cover_budget(1.0):
            with pytest.raises(AutomaticCoverDeadlineExceeded):
                cover_provider_spotify.spotify_wait_for_request_slot()
    finally:
        with cover_provider_spotify._SPOTIFY_REQUEST_PACING_LOCK:
            cover_provider_spotify._SPOTIFY_REQUEST_PACING["next_allowed_at"] = 0.0


def test_automatic_youtube_session_clamps_library_timeout(monkeypatch):
    import requests
    from music_app.services import cover_provider_youtube_music as ytm
    from music_app.services.cover_provider_deadline import automatic_cover_budget

    seen = {}
    monkeypatch.setattr(requests.Session, "request", lambda self, method, url, **kwargs: seen.update(kwargs))

    class FakeYTMusic:
        def __init__(self, *, requests_session):
            self.session = requests_session

    monkeypatch.setattr(ytm, "YTMusic", FakeYTMusic)
    with automatic_cover_budget(2.0):
        with ytm.automatic_youtube_music_client() as client:
            client.session.request("POST", "https://music.youtube.com/youtubei/v1/search", timeout=30)

    assert 0 < seen["timeout"] <= 2.0


def test_automatic_youtube_timeout_is_retryable():
    from music_app.services import cover_provider_youtube_music as ytm
    from music_app.services.cover_provider_deadline import (
        AutomaticCoverDeadlineExceeded,
        automatic_cover_budget,
    )

    class Client:
        def search(self, *_args, **_kwargs):
            raise TimeoutError("timed out")

    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverDeadlineExceeded):
            ytm.search_youtube_music_candidates(
                "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
                automatic=True, max_queries=2,
                client_getter=lambda **_kwargs: Client(),
                build_query_variants=lambda *_args: [("Artist", "Album", None, 2001)],
                match_score=lambda **_kwargs: 0.0,
                parse_year=lambda _value: 2001,
                probe_match_candidates=lambda **_kwargs: [],
                log_event=None,
            )


def test_automatic_youtube_connection_failure_is_retryable():
    from music_app.services import cover_provider_youtube_music as ytm
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed

    class Client:
        def search(self, *_args, **_kwargs):
            raise requests.ConnectionError("connection reset")

    with pytest.raises(AutomaticCoverSearchFailed):
        ytm.search_youtube_music_candidates(
            "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
            automatic=True, max_queries=2,
            client_getter=lambda **_kwargs: Client(),
            build_query_variants=lambda *_args: [("Artist", "Album", None, 2001)],
            match_score=lambda **_kwargs: 0.0,
            parse_year=lambda _value: 2001,
            probe_match_candidates=lambda **_kwargs: [],
            log_event=None,
        )


def test_automatic_spotify_socket_timeout_is_retryable(monkeypatch):
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import (
        AutomaticCoverDeadlineExceeded,
        automatic_cover_budget,
    )

    monkeypatch.setattr(spotify.urllib.request, "urlopen", lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(socket.timeout("timed out"))
    ))
    with spotify._SPOTIFY_REQUEST_PACING_LOCK:
        spotify._SPOTIFY_REQUEST_PACING["next_allowed_at"] = 0.0
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverDeadlineExceeded):
            spotify.spotify_request_json(
                "https://api.spotify.com/v1/search", method="GET", headers={}, log_event=None,
            )


def test_automatic_spotify_rate_limit_is_retryable(monkeypatch):
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed, automatic_cover_budget

    monkeypatch.setattr(spotify.urllib.request, "urlopen", lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(urllib.error.HTTPError("https://api.spotify.com/v1/search", 429, "rate limited", {}, None))
    ))
    with spotify._SPOTIFY_REQUEST_PACING_LOCK:
        spotify._SPOTIFY_REQUEST_PACING["next_allowed_at"] = 0.0
    with automatic_cover_budget(2.0):
        with pytest.raises(AutomaticCoverSearchFailed):
            spotify.spotify_request_json(
                "https://api.spotify.com/v1/search", method="GET", headers={}, log_event=None,
            )


def test_runtime_probe_keeps_valid_cover_on_later_timeout(monkeypatch):
    from music_app.services import cover_provider_runtime
    from music_app.services.cover_provider_deadline import AutomaticCoverDeadlineExceeded, automatic_cover_budget

    monkeypatch.setattr(cover_provider_runtime, "LOGGER", type("Logger", (), {"verbose": lambda self, *_args: None})())

    def probe(url, **_kwargs):
        if "second" in url:
            raise AutomaticCoverDeadlineExceeded()
        return {"raw_bytes": b"cover", "width": 900, "height": 900, "area": 810000, "sharpness": 1.0}

    monkeypatch.setattr(cover_provider_runtime, "probe_candidate_metrics", probe)
    with automatic_cover_budget(2.0):
        candidates = cover_provider_runtime.probe_match_candidates(
            source="youtube_music",
            matches=[
                (0.95, "https://example.test/first.jpg", {"artist": "Artist", "album": "Album"}),
                (0.9, "https://example.test/second.jpg", {"artist": "Artist", "album": "Album"}),
            ],
            user_agent="AlbumHavenTests/1.0", query_mode="test", artist="Artist", album="Album", year=None,
        )

    assert len(candidates) == 1
    assert candidates[0].width == 900


def test_automatic_spotify_cooldown_is_retryable():
    from music_app.services import cover_provider_spotify as spotify
    from music_app.services.cover_provider_deadline import AutomaticCoverSearchFailed

    with pytest.raises(AutomaticCoverSearchFailed):
        spotify.search_spotify(
            "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
            automatic=True,
            api_enabled=lambda: True,
            global_rate_limit_active=lambda: True,
            reset_rate_limit_state=lambda: None,
            rate_limited=lambda: True,
            search_timed_out=lambda _started: False,
            build_query_variants=lambda *_args: [],
            collect_album_matches=lambda *_args, **_kwargs: pytest.fail("query should not run"),
            collect_artist_album_matches=lambda *_args, **_kwargs: pytest.fail("query should not run"),
            select_largest_candidate=lambda **_kwargs: None,
            log_event=None,
        )
