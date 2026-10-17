from __future__ import annotations

import hashlib
import io
import time
from types import SimpleNamespace

import pytest

from music_app.services import cover_refresh_provider
from music_app.services import cover_provider_apple
from music_app.services import cover_provider_deezer
from music_app.services import cover_provider_http
from music_app.services.cover_provider_candidates import CoverCandidate
from music_app.services.cover_provider_cache import CoverSearchCache


@pytest.mark.parametrize("location", ["parent", "other"])
@pytest.mark.parametrize("valid", [True, False, None])
def test_protected_selected_artwork_outside_folder_is_validated_and_retained(tmp_path, location, valid):
    from types import SimpleNamespace

    image = pytest.importorskip("PIL.Image")
    folder = tmp_path / "Album" / "CD1"
    folder.mkdir(parents=True)
    selected = (folder.parent if location == "parent" else tmp_path) / "selected.png"
    if valid:
        image.new("RGB", (500, 500), "red").save(selected)
    elif valid is False:
        selected.write_bytes(b"corrupt image")
    image.new("RGB", (300, 300), "blue").save(folder / "cover.png")
    path, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".png"},
        SimpleNamespace(get=lambda _key: {}, set=lambda *_args: None), "Tests/1.0",
        cover_selection_origin="user", cover_selection_provenance="explicit", reject_if_user_controlled=True,
        selected_cover_path=str(selected),
        search_remote_cover_func=lambda **_kwargs: (None, [{"resolver": "_search_apple", "status": "failed"}]),
    )
    assert path == (selected if valid else None)
    assert downloaded is False
    assert detail["local_area"] == (250000 if valid else 0)
    assert detail["reason"] == "remote_search_failed"


@pytest.mark.parametrize("guard_result", [False, None])
def test_invalid_selection_does_not_fall_back_after_unsuccessful_write(tmp_path, guard_result):
    from types import SimpleNamespace

    image = pytest.importorskip("PIL.Image")
    folder = tmp_path / "Album"
    folder.mkdir()
    image.new("RGB", (300, 300), "blue").save(folder / "cover.png")
    raw = io.BytesIO()
    image.new("RGB", (1600, 1600), "red").save(raw, format="PNG")
    candidate = CoverCandidate(source="apple", url="https://images.example/cover.png", width=1600, height=1600, score=0.99, matched_artist="Artist", matched_album="Album")
    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".png"},
        SimpleNamespace(get=lambda _key: {}, set=lambda *_args: None), "Tests/1.0",
        selected_cover_path=str(tmp_path / "missing.png"),
        automatic_write_guard=lambda *_args, **_kwargs: guard_result,
        search_remote_cover_func=lambda *_args, **_kwargs: (candidate, []),
        http_get_bytes_func=lambda *_args, **_kwargs: raw.getvalue(),
    )
    assert selected is None
    assert downloaded is False
    assert detail["reason"] == ("automatic_write_blocked_by_user_selection" if guard_result is False else "write_returned_no_file")


def test_automatic_write_guard_receives_final_encoded_cover_revision(tmp_path):
    image_module = pytest.importorskip("PIL.Image")
    raw = io.BytesIO()
    image_module.new("RGB", (1600, 1600), (30, 120, 220)).save(raw, format="PNG")
    raw_bytes = raw.getvalue()
    candidate = CoverCandidate(
        source="apple",
        url="https://images.example/final-revision.png",
        width=1600,
        height=1600,
        score=0.99,
        matched_artist="Artist",
        matched_album="Album",
    )
    observed = {}

    def guard(write_action, *, cover_selection_origin):
        written = write_action()
        observed["origin"] = cover_selection_origin
        observed["provisional"] = write_action.provisional_cover_revision
        observed["actual"] = hashlib.sha256(written.read_bytes()).hexdigest()
        assert (write_action.local_cover_width, write_action.local_cover_height) == (1600, 1600)
        return written

    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    written, downloaded, _detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2026,
        {".jpg"},
        CoverSearchCache(tmp_path / "cache.json"),
        "AlbumHavenTests/1.0",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
        automatic_write_guard=guard,
        search_remote_cover_func=lambda *_args, **_kwargs: (candidate, []),
        http_get_bytes_func=lambda *_args, **_kwargs: raw_bytes,
    )

    assert downloaded is True
    assert written == folder / "cover.jpg"
    assert observed == {
        "origin": "automatic",
        "provisional": observed["actual"],
        "actual": observed["actual"],
    }


def test_satisfactory_local_cover_skips_remote_without_lookup_cache(tmp_path):
    image_module = pytest.importorskip("PIL.Image")
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover = folder / "cover.jpg"
    image_module.new("RGB", (1200, 1200), (20, 30, 40)).save(cover)

    resolved, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".jpg"},
        CoverSearchCache(tmp_path / "lookup.json"), "AlbumHavenTests/1.0",
        search_remote_cover_func=lambda *_args, **_kwargs: pytest.fail("remote search should not run"),
    )

    assert (resolved, downloaded) == (cover, False)
    assert detail["reason"] == "satisfactory_local_cover_present"


def test_search_primary_remote_cover_keeps_apple_provider_threshold(monkeypatch):
    calls: list[str] = []

    def fake_apple(*_args, **_kwargs):
        calls.append("apple")
        return CoverCandidate(
            source="apple",
            url="https://images.example/apple.jpg",
            width=1200,
            height=1200,
            score=0.86,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fake_deezer(*_args, **_kwargs):
        calls.append("deezer")
        return CoverCandidate(
            source="deezer",
            url="https://images.example/deezer.jpg",
            width=1500,
            height=1500,
            score=0.92,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fail_spotify(*_args, **_kwargs):
        raise AssertionError("Deezer should be acceptable before Spotify runs")

    monkeypatch.setattr(cover_provider_apple, "begin_apple_request_trace", lambda: None)
    monkeypatch.setattr(cover_provider_apple, "finish_apple_request_trace", lambda: [])
    monkeypatch.setattr(cover_provider_apple, "search_apple", fake_apple)
    monkeypatch.setattr(cover_provider_deezer, "search_deezer_cover", fake_deezer)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", fail_spotify)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=True,
        has_local_cover=False,
    )

    assert selected is not None
    assert selected.source == "deezer"
    assert calls == ["apple", "deezer"]
    assert trace[0]["resolver"] == "_search_apple"
    assert trace[0]["acceptable"] is False
    assert trace[1]["resolver"] == "_search_deezer"
    assert trace[1]["acceptable"] is True


def test_search_primary_remote_cover_publishes_each_candidate_before_acceptance(monkeypatch):
    events: list[tuple[str, str]] = []

    def fake_apple(*_args, **_kwargs):
        events.append(("searched", "apple"))
        return CoverCandidate(
            source="apple",
            url="https://images.example/apple.jpg",
            width=900,
            height=900,
            score=0.8,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fake_deezer(*_args, **_kwargs):
        events.append(("searched", "deezer"))
        return CoverCandidate(
            source="deezer",
            url="https://images.example/deezer.jpg",
            width=1500,
            height=1500,
            score=0.92,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fail_spotify(*_args, **_kwargs):
        raise AssertionError("The first acceptable candidate must stop later providers")

    monkeypatch.setattr(cover_refresh_provider, "_search_apple", fake_apple)
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", fake_deezer)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", fail_spotify)

    selected, _trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False,
        has_local_cover=False,
        candidate_callback=lambda candidate, **_kwargs: events.append(
            ("published", candidate.source)
        ),
    )

    assert selected is not None
    assert selected.source == "deezer"
    assert events == [
        ("searched", "apple"),
        ("published", "apple"),
        ("searched", "deezer"),
        ("published", "deezer"),
    ]


def test_search_primary_remote_cover_logs_candidate_callback_failure_and_continues(
    monkeypatch,
    caplog,
):
    provider_calls: list[str] = []

    def candidate(source, *, width, score):
        def search(*_args, **_kwargs):
            provider_calls.append(source)
            return CoverCandidate(
                source=source,
                url=f"https://images.example/{source}.jpg",
                width=width,
                height=width,
                score=score,
                matched_artist="Artist",
                matched_album="Album",
            )

        return search

    monkeypatch.setattr(
        cover_refresh_provider,
        "_search_apple",
        candidate("apple", width=900, score=0.8),
    )
    monkeypatch.setattr(
        cover_refresh_provider,
        "_search_deezer",
        candidate("deezer", width=1500, score=0.92),
    )
    monkeypatch.setattr(
        cover_refresh_provider,
        "_search_spotify",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Deezer should stop provider traversal")
        ),
    )

    def reject_publication(_candidate, **_kwargs):
        raise RuntimeError("snapshot unavailable")

    with caplog.at_level("WARNING"):
        selected, _trace = cover_refresh_provider.search_primary_remote_cover(
            "Artist",
            "Album",
            None,
            2001,
            "AlbumHavenTests/1.0",
            allow_apple_web_fallback=False,
            has_local_cover=False,
            candidate_callback=reject_publication,
        )

    assert selected is not None
    assert selected.source == "deezer"
    assert provider_calls == ["apple", "deezer"]
    assert "snapshot unavailable" in caplog.text


def test_search_primary_remote_cover_uses_extracted_primary_resolvers(monkeypatch):
    calls: list[tuple[str, bool | None]] = []

    def fake_apple(*_args, allow_web_fallback, **_kwargs):
        calls.append(("apple", allow_web_fallback))
        return CoverCandidate(
            source="apple",
            url="https://images.example/apple.jpg",
            width=900,
            height=900,
            score=0.8,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fake_deezer(*_args, **_kwargs):
        calls.append(("deezer", None))
        return CoverCandidate(
            source="deezer",
            url="https://images.example/deezer.jpg",
            width=1500,
            height=1500,
            score=0.92,
            matched_artist="Artist",
            matched_album="Album",
        )

    def fail_spotify(*_args, **_kwargs):
        raise AssertionError("Deezer should be acceptable before Spotify runs")

    monkeypatch.setattr(cover_provider_apple, "search_apple", fake_apple)
    monkeypatch.setattr(cover_provider_deezer, "search_deezer_cover", fake_deezer)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", fail_spotify)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=True,
        has_local_cover=False,
    )

    assert selected is not None
    assert selected.source == "deezer"
    assert calls == [("apple", False), ("deezer", None)]
    assert [item["resolver"] for item in trace] == ["_search_apple", "_search_deezer"]


def test_search_primary_remote_cover_uses_extracted_apple_trace(monkeypatch):
    original_begin = cover_provider_apple.begin_apple_request_trace

    def fake_begin():
        cover_provider_apple.append_apple_request_trace(
            context="stale",
            status="should-clear",
            elapsed_ms=1,
        )
        original_begin()

    def fake_apple(*_args, **_kwargs):
        cover_provider_apple.append_apple_request_trace(
            context="apple-search",
            status="success:200",
            elapsed_ms=12.345,
        )
        return None

    monkeypatch.setattr(cover_provider_apple, "begin_apple_request_trace", fake_begin)
    monkeypatch.setattr(cover_provider_apple, "search_apple", fake_apple)
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", lambda *_args, **_kwargs: None)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False,
        has_local_cover=False,
    )

    assert selected is None
    assert trace[0]["resolver"] == "_search_apple"
    assert trace[0]["status"] == "no_candidate"
    assert trace[0]["apple_http_trace"] == [
        {
            "context": "apple-search",
            "status": "success:200",
            "elapsed_ms": 12.35,
        }
    ]


def test_search_primary_remote_cover_uses_only_configured_apple_service(monkeypatch):
    calls: list[str] = []

    def fake_apple(*_args, **_kwargs):
        calls.append("apple")
        return None

    def unexpected_deezer(*_args, **_kwargs):
        calls.append("deezer")
        raise AssertionError("Deezer is disabled for automatic cover refresh")

    def unexpected_spotify(*_args, **_kwargs):
        calls.append("spotify")
        raise AssertionError("Spotify is disabled for automatic cover refresh")

    monkeypatch.setattr(
        cover_refresh_provider.Config,
        "ENABLED_MUSIC_SERVICES",
        frozenset({"apple"}),
    )
    monkeypatch.setattr(
        cover_refresh_provider.Config,
        "COVER_PROVIDER_GROUPS",
        frozenset({"music_services"}),
    )
    monkeypatch.setattr(cover_refresh_provider, "_search_apple", fake_apple)
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", unexpected_deezer)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", unexpected_spotify)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False,
        has_local_cover=False,
    )

    assert selected is None
    assert calls == ["apple"]
    assert [item["resolver"] for item in trace] == ["_search_apple"]


def test_search_primary_remote_cover_keeps_default_automatic_services(monkeypatch):
    calls: list[str] = []

    def no_candidate(provider):
        def search(*_args, **_kwargs):
            calls.append(provider)
            return None

        return search

    monkeypatch.setattr(
        cover_refresh_provider.Config,
        "ENABLED_MUSIC_SERVICES",
        cover_refresh_provider.normalize_enabled_music_services(None),
    )
    monkeypatch.setattr(cover_refresh_provider, "_search_apple", no_candidate("apple"))
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", no_candidate("deezer"))
    monkeypatch.setattr(cover_refresh_provider, "_search_youtube_music", no_candidate("youtube_music"), raising=False)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", no_candidate("spotify"))
    monkeypatch.setattr(cover_refresh_provider, "_search_bandcamp", no_candidate("bandcamp"), raising=False)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist",
        "Album",
        None,
        2001,
        "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False,
        has_local_cover=False,
    )

    assert selected is None
    assert calls == ["apple", "deezer", "youtube_music", "spotify", "bandcamp"]
    assert [item["resolver"] for item in trace] == [
        "_search_apple",
        "_search_deezer",
        "_search_youtube_music",
        "_search_spotify",
        "_search_bandcamp",
    ]


def test_automatic_apple_stops_at_confident_1200_square(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider, "_search_apple", lambda *_args, **_kwargs: CoverCandidate(
        source="apple", url="https://images.example/apple.jpg", width=1200,
        height=1200, score=0.92, matched_artist="Artist", matched_album="Album",
    ))
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", lambda *_args, **_kwargs: pytest.fail("Deezer should not run"))
    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False,
    )
    assert selected.source == "apple"
    assert [item["resolver"] for item in trace] == ["_search_apple"]


def test_automatic_apple_uses_api_only_even_when_web_fallback_is_requested(monkeypatch):
    seen = {}

    def fake_search(*_args, **kwargs):
        seen.update(kwargs)
        return None

    monkeypatch.setattr(cover_provider_apple, "search_apple", fake_search)
    cover_refresh_provider._search_apple(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_web_fallback=True,
    )
    assert seen["api_only"] is True
    assert seen["allow_web_fallback"] is False
    assert seen["max_queries"] == 2


def test_automatic_query_variants_choose_exact_then_normalized_retry():
    variants = cover_refresh_provider._automatic_query_variants("Simon & Garfunkel", "Album", None, 2001)
    assert variants == [
        ("Simon & Garfunkel", "Album", None, 2001),
        ("Simon and Garfunkel", "Album", None, 2001),
    ]


def test_automatic_query_variants_use_yearless_retry_when_no_normalization():
    variants = cover_refresh_provider._automatic_query_variants("Artist", "Album", None, 2001)
    assert variants == [
        ("Artist", "Album", None, 2001),
        ("Artist", "Album", None, None),
    ]


def test_automatic_service_wrappers_request_two_query_api_paths(monkeypatch):
    from music_app.services import cover_provider_runtime, cover_provider_spotify

    seen = {}
    monkeypatch.setattr(cover_provider_deezer, "search_deezer_cover", lambda *_args, **kwargs: seen.setdefault("deezer", kwargs))
    def fake_youtube(*_args, **kwargs):
        seen["youtube_music"] = kwargs
        return []
    monkeypatch.setattr(cover_provider_runtime, "search_youtube_music_candidates", fake_youtube)
    monkeypatch.setattr(cover_provider_spotify, "search_spotify", lambda *_args, **kwargs: seen.setdefault("spotify", kwargs))

    for provider in (
        cover_refresh_provider._search_deezer,
        cover_refresh_provider._search_youtube_music,
        cover_refresh_provider._search_spotify,
    ):
        provider("Artist", "Album", None, 2001, "AlbumHavenTests/1.0")

    for name in ("deezer", "youtube_music", "spotify"):
        assert seen[name]["automatic"] is True
        assert seen[name]["max_queries"] == 2
        assert seen[name]["build_query_variants"]("Artist", "Album", None, 2001) == [
            ("Artist", "Album", None, 2001),
            ("Artist", "Album", None, None),
        ]


def test_bandcamp_does_not_run_when_a_smaller_primary_cover_exists(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider, "_search_apple", lambda *_args, **_kwargs: CoverCandidate(
        source="apple", url="https://images.example/apple.jpg", width=800,
        height=800, score=0.95, matched_artist="Artist", matched_album="Album",
    ))
    for provider in ("_search_deezer", "_search_youtube_music", "_search_spotify"):
        monkeypatch.setattr(cover_refresh_provider, provider, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(cover_refresh_provider, "_search_bandcamp", lambda *_args, **_kwargs: pytest.fail("Bandcamp should not run"))
    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False,
    )
    assert selected.source == "apple"
    assert [item["resolver"] for item in trace] == [
        "_search_apple", "_search_deezer", "_search_youtube_music", "_search_spotify",
    ]


def test_spotify_quota_disables_only_the_current_automatic_run(monkeypatch):
    from music_app.services.cover_provider_spotify import SpotifyCooldown
    calls = []
    monkeypatch.setattr(cover_refresh_provider.cover_provider_spotify, "spotify_cooldown_until", lambda: 0)
    for provider in ("_search_apple", "_search_deezer", "_search_youtube_music", "_search_bandcamp"):
        monkeypatch.setattr(cover_refresh_provider, provider, lambda *_args, _name=provider, **_kwargs: calls.append(_name))
    def quota(*_args, **_kwargs):
        calls.append("_search_spotify")
        raise SpotifyCooldown(212.0, quota_response=True)
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", quota)
    run = cover_refresh_provider.AutomaticCoverSearchRun()
    def search(context):
        return cover_refresh_provider.search_primary_remote_cover(
            "Artist", "Album", None, 2001, "Tests/1.0",
            allow_apple_web_fallback=False, has_local_cover=False, search_run=context,
        )[1]
    first = search(run)
    assert next(item for item in first if item["resolver"] == "_search_spotify")["reason"] == "spotify_quota_exceeded"
    second = search(run)
    assert all(item["resolver"] != "_search_spotify" for item in second)
    assert calls.count("_search_spotify") == 1
    assert calls.count("_search_bandcamp") == 2
    search(cover_refresh_provider.AutomaticCoverSearchRun())
    assert calls.count("_search_spotify") == 2


def test_existing_spotify_cooldown_skips_provider_without_blaming_an_album(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider.cover_provider_spotify, "spotify_cooldown_until", lambda: float("inf"))
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", lambda *_args, **_kwargs: pytest.fail("Cooling down"))
    for provider in ("_search_apple", "_search_deezer", "_search_youtube_music", "_search_bandcamp"):
        monkeypatch.setattr(cover_refresh_provider, provider, lambda *_args, **_kwargs: None)
    run = cover_refresh_provider.AutomaticCoverSearchRun()
    _, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "Tests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False, search_run=run,
    )
    assert run.spotify_disabled
    assert all(item["status"] == "no_candidate" for item in trace)
    assert all(item["resolver"] != "_search_spotify" for item in trace)


def test_inflight_quota_response_is_attributed_after_another_worker_observes_cooldown(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider.cover_provider_spotify, "spotify_cooldown_until", lambda: 0)
    run = cover_refresh_provider.AutomaticCoverSearchRun()
    assert run.disable_spotify(quota_response=False) is False
    assert run.spotify_disabled is True
    assert run.disable_spotify(quota_response=True) is True
    assert run.disable_spotify(quota_response=True) is False


def test_automatic_timeout_is_reported_separately_from_no_match(monkeypatch):
    from music_app.services.cover_provider_deadline import AutomaticCoverDeadlineExceeded

    monkeypatch.setattr(cover_refresh_provider, "_search_apple", lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(AutomaticCoverDeadlineExceeded())
    ))
    for provider in ("_search_deezer", "_search_youtube_music", "_search_spotify", "_search_bandcamp"):
        monkeypatch.setattr(cover_refresh_provider, provider, lambda *_args, **_kwargs: None)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False,
    )

    assert selected is None
    assert trace[0]["status"] == "timeout"
    assert trace[1]["resolver"] == "_search_deezer"


def test_slow_provider_budget_expires_and_next_provider_can_progress(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider, "_AUTOMATIC_PROVIDER_BUDGET_SECONDS", 0.005, raising=False)

    def slow_apple(*_args, **_kwargs):
        time.sleep(0.02)
        return CoverCandidate(
            source="apple", url="https://images.example/apple.jpg", width=1200,
            height=1200, score=0.95, matched_artist="Artist", matched_album="Album",
        )

    monkeypatch.setattr(cover_refresh_provider, "_search_apple", slow_apple)
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", lambda *_args, **_kwargs: CoverCandidate(
        source="deezer", url="https://images.example/deezer.jpg", width=1200,
        height=1200, score=0.95, matched_artist="Artist", matched_album="Album",
    ))
    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False,
    )

    assert selected.source == "deezer"
    assert [item["status"] for item in trace] == ["timeout", "matched"]


def test_timed_out_automatic_lookup_is_not_negative_cached(tmp_path):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cache = CoverSearchCache(tmp_path / "lookup.json")

    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".jpg"}, cache,
        "AlbumHavenTests/1.0",
        search_remote_cover_func=lambda *_args, **_kwargs: (
            None, [{"resolver": "_search_apple", "status": "timeout", "elapsed_ms": 10}]
        ),
    )

    assert (selected, downloaded) == (None, False)
    assert detail["reason"] == "remote_search_timed_out"
    assert cache.get(detail["cache_key"]) is None


@pytest.mark.parametrize("failure_reason", ["candidate_download_failed", "candidate_decode_failed"])
@pytest.mark.parametrize("expired_negative", [False, True])
@pytest.mark.parametrize("user_cover", [False, True])
def test_candidate_transfer_failure_keeps_normal_search_retryable(
    tmp_path, failure_reason, expired_negative, user_cover,
):
    from music_app.services.cover_provider_cache import cover_query_key

    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    selected_cover = folder / "cover.png" if user_cover else None
    if selected_cover:
        image = pytest.importorskip("PIL.Image")
        image.new("RGB", (300, 300), "blue").save(selected_cover)
    original_artwork = selected_cover.read_bytes() if selected_cover else None
    cache = CoverSearchCache(tmp_path / "lookup.json")
    cache_key = cover_query_key("Artist", "Album", None, 2001)
    baseline = {"updated_at": 1.0, "missing": True} if expired_negative else None
    if baseline:
        cache.set(cache_key, baseline)
    searches = []
    downloads = []
    candidate = CoverCandidate(source="apple", url="https://images.example/cover.png",
                               width=1600, height=1600, score=0.99)

    def search(*_args, **_kwargs):
        searches.append(True)
        return (candidate if len(searches) == 1 else None), [
            {"resolver": "_search_apple", "status": "matched" if len(searches) == 1 else "no_candidate"},
        ]

    def download(*_args, **_kwargs):
        downloads.append(True)
        return None if failure_reason == "candidate_download_failed" else b"invalid-image"

    def lookup():
        return cover_refresh_provider.ensure_best_cover_for_folder(
            folder, "Artist", "Album", None, 2001, {".png"}, cache, "AlbumHavenTests/1.0",
            negative_cache_ttl_seconds=60,
            cover_selection_origin="user" if user_cover else "automatic",
        cover_selection_provenance="explicit" if user_cover else None,
            reject_if_user_controlled=user_cover,
            selected_cover_path=str(selected_cover) if selected_cover else None,
            search_remote_cover_func=search, http_get_bytes_func=download,
            decode_image_func=lambda _raw: None,
            write_cover_func=lambda *_args, **_kwargs: pytest.fail("Failed candidate must not replace artwork"),
            automatic_write_guard=lambda *_args, **_kwargs: pytest.fail("Failed candidate must not promote a selection"),
        )

    selected, downloaded, detail = lookup()
    assert (selected, downloaded) == (selected_cover, False)
    assert detail["reason"] == failure_reason
    assert searches == [True] and downloads == [True]
    assert cache.get(cache_key) == baseline
    selected, downloaded, detail = lookup()
    assert (selected, downloaded) == (selected_cover, False)
    assert detail["reason"] == "remote_search_returned_no_candidate"
    assert searches == [True, True] and downloads == [True]
    genuine_negative = cache.get(cache_key)
    assert genuine_negative["missing"] is True
    assert genuine_negative["updated_at"] > 1.0
    selected, downloaded, detail = lookup()
    assert (selected, downloaded) == (selected_cover, False)
    assert detail["reason"] == "negative_cache_ttl_active"
    assert searches == [True, True] and downloads == [True]
    assert cache.get(cache_key) == genuine_negative
    if selected_cover:
        assert selected_cover.read_bytes() == original_artwork
    else:
        assert list(folder.iterdir()) == []


def test_failed_automatic_lookup_is_not_negative_cached(tmp_path):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cache = CoverSearchCache(tmp_path / "lookup.json")

    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".jpg"}, cache,
        "AlbumHavenTests/1.0",
        search_remote_cover_func=lambda *_args, **_kwargs: (
            None, [{"resolver": "_search_apple", "status": "exception", "elapsed_ms": 10}]
        ),
    )

    assert (selected, downloaded) == (None, False)
    assert detail["reason"] == "remote_search_failed"
    assert cache.get(detail["cache_key"]) is None


def test_bandcamp_only_group_skips_music_services(monkeypatch):
    monkeypatch.setattr(cover_refresh_provider, "_search_apple", lambda *_args, **_kwargs: pytest.fail("Apple disabled"))
    monkeypatch.setattr(cover_refresh_provider, "_search_deezer", lambda *_args, **_kwargs: pytest.fail("Deezer disabled"))
    monkeypatch.setattr(cover_refresh_provider, "_search_youtube_music", lambda *_args, **_kwargs: pytest.fail("YouTube disabled"))
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", lambda *_args, **_kwargs: pytest.fail("Spotify disabled"))
    monkeypatch.setattr(cover_refresh_provider, "_search_bandcamp", lambda *_args, **_kwargs: None)

    selected, trace = cover_refresh_provider.search_primary_remote_cover(
        "Artist", "Album", None, 2001, "AlbumHavenTests/1.0",
        allow_apple_web_fallback=False, has_local_cover=False,
        enabled_provider_groups=frozenset({"bandcamp"}),
    )

    assert selected is None
    assert [item["resolver"] for item in trace] == ["_search_bandcamp"]


def test_bandcamp_only_group_reaches_resolver_from_album_refresh(tmp_path):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    seen = {}

    def search(**kwargs):
        seen["groups"] = kwargs["enabled_provider_groups"]
        return None, [{"resolver": "_search_bandcamp", "status": "no_candidate"}]

    _selected, _downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".jpg"}, CoverSearchCache(tmp_path / "cache.json"),
        "AlbumHavenTests/1.0", enabled_provider_groups=frozenset({"bandcamp"}),
        search_remote_cover_func=search,
    )

    assert seen["groups"] == frozenset({"bandcamp"})
    assert detail["reason"] == "remote_search_returned_no_candidate"


def test_automatic_deezer_probe_stops_after_satisfactory_candidate(monkeypatch):
    from music_app.services.cover_provider_deadline import automatic_cover_budget

    seen = []
    monkeypatch.setattr(cover_refresh_provider, "_LOGGER", type("Logger", (), {"verbose": lambda self, *_args: None})())

    def probe(url, **_kwargs):
        seen.append(url)
        if len(seen) > 1:
            pytest.fail("second probe should not run after a satisfactory cover")
        return {"raw_bytes": b"cover", "width": 1400, "height": 1400, "area": 1960000, "sharpness": 1.0}

    monkeypatch.setattr(cover_refresh_provider, "_probe_candidate_metrics", probe)
    with automatic_cover_budget(2.0):
        candidates = cover_refresh_provider._probe_match_candidates(
            source="deezer",
            matches=[
                (0.95, "https://example.test/first.jpg", {"artist": "Artist", "album": "Album"}),
                (0.9, "https://example.test/second.jpg", {"artist": "Artist", "album": "Album"}),
            ],
            user_agent="AlbumHavenTests/1.0", query_mode="test", artist="Artist", album="Album", year=None,
        )

    assert len(candidates) == 1
    assert seen == ["https://example.test/first.jpg"]


def test_automatic_probe_keeps_smaller_candidate_on_later_timeout(monkeypatch):
    from music_app.services.cover_provider_deadline import AutomaticCoverDeadlineExceeded, automatic_cover_budget
    monkeypatch.setattr(cover_refresh_provider, "_LOGGER", type("Logger", (), {"verbose": lambda self, *_args: None})())

    def probe(url, **_kwargs):
        if "second" in url:
            raise AutomaticCoverDeadlineExceeded()
        return {"raw_bytes": b"cover", "width": 900, "height": 900, "area": 810000, "sharpness": 1.0}

    monkeypatch.setattr(cover_refresh_provider, "_probe_candidate_metrics", probe)
    with automatic_cover_budget(2.0):
        candidates = cover_refresh_provider._probe_match_candidates(
            source="deezer",
            matches=[
                (0.95, "https://example.test/first.jpg", {"artist": "Artist", "album": "Album"}),
                (0.9, "https://example.test/second.jpg", {"artist": "Artist", "album": "Album"}),
            ],
            user_agent="AlbumHavenTests/1.0", query_mode="test", artist="Artist", album="Album", year=None,
        )

    assert len(candidates) == 1
    assert candidates[0].width == 900


def test_refresh_http_get_bytes_uses_extracted_http_owner(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_http_get_bytes(url, user_agent, accept="*/*", **kwargs):
        calls.append({
            "url": url,
            "user_agent": user_agent,
            "accept": accept,
            **kwargs,
        })
        return b"image-bytes"

    monkeypatch.setattr(cover_provider_http, "_http_get_bytes", fake_http_get_bytes)

    payload = cover_refresh_provider._http_get_bytes(
        "https://images.example/cover.jpg",
        user_agent="AlbumHavenTests/1.0",
        service="apple",
        context="cover-download:Artist - Album",
    )

    assert payload == b"image-bytes"
    assert calls == [
        {
            "url": "https://images.example/cover.jpg",
            "user_agent": "AlbumHavenTests/1.0",
            "accept": "*/*",
            "service": "apple",
            "context": "cover-download:Artist - Album",
            "append_apple_request_trace": cover_provider_apple.append_apple_request_trace,
        }
    ]


@pytest.mark.parametrize("policy", ["manual-only", "offline"])
def test_cover_refresh_suppresses_external_search_for_manual_only_and_offline_policies(
    policy,
    tmp_path,
):
    def fail_external_search(*_args, **_kwargs):
        raise AssertionError("cover refresh must not call an external provider")

    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        tmp_path / "Artist" / "Album",
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        CoverSearchCache(tmp_path / "cover-cache.json"),
        "AlbumHavenTests/1.0",
        enabled_provider_groups=policy,
        search_remote_cover_func=fail_external_search,
    )

    assert selected is None
    assert downloaded is False
    assert detail["reason"] == "remote_provider_group_disabled"


@pytest.mark.parametrize("external_selection", [False, True])
def test_user_controlled_cover_publishes_improvement_without_writing_bytes(
    tmp_path,
    monkeypatch,
    external_selection,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    current_cover = (tmp_path if external_selection else folder) / "cover.jpg"
    original_bytes = b"user-selected-cover"
    current_cover.write_bytes(original_bytes)
    if external_selection:
        pytest.importorskip("PIL.Image").new("RGB", (400, 400), "red").save(current_cover)
        original_bytes = current_cover.read_bytes()
    candidate = CoverCandidate(
        source="cover_art_archive",
        url="https://images.example/improvement.jpg",
        raw_bytes=b"automatic-improvement",
        width=1600,
        height=1600,
        score=0.99,
        matched_artist="Artist",
        matched_album="Album",
    )
    publication_events: list[tuple[CoverCandidate, bool]] = []

    class DecodedImage:
        def close(self):
            return None

    def fake_search(*_args, candidate_callback, **_kwargs):
        candidate_callback(candidate)
        return candidate, []

    def publish_candidate(discovered, *, automatic_improvement=False):
        publication_events.append((discovered, automatic_improvement))

    monkeypatch.setattr(cover_refresh_provider, "find_cover_image", lambda *_args: current_cover)
    monkeypatch.setattr(cover_refresh_provider, "image_dimensions", lambda *_args: (400, 400))
    monkeypatch.setattr(cover_refresh_provider, "image_area", lambda *_args: 160_000)
    monkeypatch.setattr(cover_refresh_provider, "image_sharpness", lambda *_args: 1.0)
    monkeypatch.setattr(cover_refresh_provider, "measure_image_sharpness", lambda *_args: 2.0)

    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        CoverSearchCache(tmp_path / "cover-cache.json"),
        "AlbumHavenTests/1.0",
        cover_selection_origin="user", cover_selection_provenance="explicit",
        reject_if_user_controlled=True,
        candidate_callback=publish_candidate,
        selected_cover_path=str(current_cover) if external_selection else None,
        search_remote_cover_func=fake_search,
        decode_image_func=lambda _raw: (DecodedImage(), 1600, 1600),
        write_cover_func=lambda *_args: (_ for _ in ()).throw(
            AssertionError("A user-controlled cover must never be overwritten")
        ),
    )

    assert selected == current_cover
    assert downloaded is False
    assert current_cover.read_bytes() == original_bytes
    assert publication_events[0] == (candidate, False)
    assert publication_events[-1] == (candidate, True)
    assert detail["reason"] == "user_controlled_improvement_available"


def test_user_controlled_cover_bypasses_positive_result_cache_to_find_new_candidates(
    tmp_path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    current_cover = folder / "cover.jpg"
    current_cover.write_bytes(b"user-selected-cover")
    cache = CoverSearchCache(tmp_path / "cover-cache.json")
    cache.set(
        "artist::album::::2001",
        {
            "updated_at": 1.0,
            "missing": False,
            "source": "apple",
            "url": "https://images.example/previous.jpg",
            "matched_artist": "Artist",
            "matched_album": "Album",
            "matched_year": 2001,
        },
    )
    search_calls = []

    monkeypatch.setattr(cover_refresh_provider, "find_cover_image", lambda *_args: current_cover)
    monkeypatch.setattr(cover_refresh_provider, "image_dimensions", lambda *_args: (1600, 1600))
    monkeypatch.setattr(cover_refresh_provider, "image_area", lambda *_args: 2_560_000)
    monkeypatch.setattr(cover_refresh_provider, "image_sharpness", lambda *_args: 2.0)

    def search(**_kwargs):
        search_calls.append(True)
        return None, []

    automatic_result = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        cache,
        "AlbumHavenTests/1.0",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
        search_remote_cover_func=search,
    )
    assert automatic_result[2]["reason"] == "satisfactory_local_cover_present"
    assert search_calls == []

    monkeypatch.setattr(cover_refresh_provider, "image_dimensions", lambda *_args: (600, 600))
    monkeypatch.setattr(cover_refresh_provider, "image_area", lambda *_args: 360_000)

    user_result = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        cache,
        "AlbumHavenTests/1.0",
        cover_selection_origin="user", cover_selection_provenance="explicit",
        reject_if_user_controlled=True,
        search_remote_cover_func=search,
    )
    assert user_result[2]["reason"] == "remote_search_returned_no_candidate"
    assert search_calls == [True]


@pytest.mark.parametrize("dimensions", [(1200, 1200), (1600, 1600), (1800, 1200)])
def test_explicit_satisfactory_selected_cover_skips_automatic_provider_queries(tmp_path, dimensions):
    image = pytest.importorskip("PIL.Image")
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    selected = tmp_path / "selected.png"
    image.new("RGB", dimensions, "red").save(selected)
    image.new("RGB", (200, 200), "blue").save(folder / "cover.png")
    chosen, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".png"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        selected_cover_path=str(selected), cover_selection_origin="user", cover_selection_provenance="explicit",
        reject_if_user_controlled=True,
        search_remote_cover_func=lambda **_kwargs: pytest.fail("satisfactory explicit artwork queried provider"),
    )
    assert chosen == selected
    assert downloaded is False
    assert detail["reason"] == "satisfactory_local_cover_present"


@pytest.mark.parametrize("dimensions", [(1199, 1600), (1600, 1199)])
def test_rectangular_explicit_artwork_with_one_small_edge_still_checks_providers(tmp_path, dimensions):
    image = pytest.importorskip("PIL.Image")
    folder = tmp_path / "Album"
    folder.mkdir()
    selected = folder / "selected.png"
    image.new("RGB", dimensions, "green").save(selected)
    calls = []
    cover_refresh_provider.ensure_best_cover_for_folder(
        folder, "Artist", "Album", None, 2001, {".png"},
        SimpleNamespace(get=lambda *_args: None, set=lambda *_args: None), "Tests/1.0",
        selected_cover_path=str(selected), cover_selection_origin="user", cover_selection_provenance="explicit", reject_if_user_controlled=True,
        search_remote_cover_func=lambda **kwargs: (calls.append(kwargs) or None, []),
    )
    assert len(calls) == 1


def test_user_controlled_cover_accepts_better_same_art_upgrade_and_marks_guard_policy(
    tmp_path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    current_cover = folder / "cover.jpg"
    original_bytes = b"user-selected-cover"
    upgraded_bytes = b"better-same-art-cover"
    current_cover.write_bytes(original_bytes)
    candidate = CoverCandidate(
        source="apple",
        url="https://images.example/same-art-upgrade.jpg",
        raw_bytes=upgraded_bytes,
        width=1600,
        height=1600,
        score=0.99,
        matched_artist="Artist",
        matched_album="Album",
    )
    observed = {}

    class DecodedImage:
        def close(self):
            return None

    monkeypatch.setattr(cover_refresh_provider, "find_cover_image", lambda *_args: current_cover)
    monkeypatch.setattr(cover_refresh_provider, "image_dimensions", lambda *_args: (400, 400))
    monkeypatch.setattr(cover_refresh_provider, "image_area", lambda *_args: 160_000)
    monkeypatch.setattr(cover_refresh_provider, "image_sharpness", lambda *_args: 1.0)
    monkeypatch.setattr(cover_refresh_provider, "measure_image_sharpness", lambda *_args: 2.0)
    monkeypatch.setattr(
        cover_refresh_provider,
        "images_are_visually_similar",
        lambda existing_path, raw_bytes: existing_path == current_cover and raw_bytes == upgraded_bytes,
        raising=False,
    )

    def write_cover(target_folder, raw_bytes):
        assert target_folder == folder
        current_cover.write_bytes(raw_bytes)
        return current_cover

    def guard(write_action, *, cover_selection_origin):
        observed.update(
            origin=cover_selection_origin,
            preserve_user_ownership=getattr(write_action, "preserve_user_ownership", False),
            expected_cover_revision=getattr(write_action, "expected_cover_revision", ""),
            prepared_cover_bytes=getattr(write_action, "prepared_cover_bytes", b""),
        )
        return write_action()

    selected, downloaded, detail = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        CoverSearchCache(tmp_path / "cover-cache.json"),
        "AlbumHavenTests/1.0",
        cover_selection_origin="user", cover_selection_provenance="explicit",
        reject_if_user_controlled=True,
        automatic_write_guard=guard,
        search_remote_cover_func=lambda **_kwargs: (candidate, []),
        decode_image_func=lambda _raw: (DecodedImage(), 1600, 1600),
        write_cover_func=write_cover,
    )

    assert selected == current_cover
    assert downloaded is True
    assert current_cover.read_bytes() == upgraded_bytes
    assert detail["reason"] == "cover_written"
    assert observed == {
        "origin": "automatic",
        "preserve_user_ownership": True,
        "expected_cover_revision": hashlib.sha256(original_bytes).hexdigest(),
        "prepared_cover_bytes": upgraded_bytes,
    }


def test_automatic_cover_write_guard_blocks_before_write_or_commits_with_origin(
    tmp_path,
    monkeypatch,
):
    blocked_folder = tmp_path / "Blocked" / "Album"
    accepted_folder = tmp_path / "Accepted" / "Album"
    blocked_folder.mkdir(parents=True)
    accepted_folder.mkdir(parents=True)
    blocked_cover = blocked_folder / "cover.jpg"
    blocked_cover.write_bytes(b"user-controlled-cover")
    accepted_cover = accepted_folder / "cover.jpg"
    candidate = CoverCandidate(
        source="cover_art_archive",
        url="https://images.example/automatic.jpg",
        raw_bytes=b"automatic-cover",
        width=1600,
        height=1600,
        score=0.99,
        matched_artist="Artist",
        matched_album="Album",
    )
    events: list[tuple[str, str]] = []
    blocked_publications: list[tuple[CoverCandidate, bool]] = []

    class DecodedImage:
        def close(self):
            return None

    monkeypatch.setattr(
        cover_refresh_provider,
        "find_cover_image",
        lambda folder, _extensions: blocked_cover if folder == blocked_folder else None,
    )
    monkeypatch.setattr(cover_refresh_provider, "image_dimensions", lambda *_args: (400, 400))
    monkeypatch.setattr(cover_refresh_provider, "image_area", lambda *_args: 160_000)
    monkeypatch.setattr(cover_refresh_provider, "image_sharpness", lambda *_args: 1.0)
    monkeypatch.setattr(cover_refresh_provider, "measure_image_sharpness", lambda *_args: 2.0)

    def fake_search(**_kwargs):
        return candidate, []

    def blocked_guard(write_action, *, cover_selection_origin):
        events.append(("blocked-guard", cover_selection_origin))
        return False

    blocked_result = cover_refresh_provider.ensure_best_cover_for_folder(
        blocked_folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        CoverSearchCache(tmp_path / "blocked-cache.json"),
        "AlbumHavenTests/1.0",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
        automatic_write_guard=blocked_guard,
        candidate_callback=lambda discovered, *, automatic_improvement=False: (
            blocked_publications.append((discovered, automatic_improvement))
        ),
        search_remote_cover_func=fake_search,
        decode_image_func=lambda _raw: (DecodedImage(), 1600, 1600),
        write_cover_func=lambda *_args: (_ for _ in ()).throw(
            AssertionError("The ownership guard blocked this write")
        ),
    )

    def accepted_write(folder, raw_bytes):
        events.append(("write", "automatic"))
        assert folder == accepted_folder
        assert raw_bytes == b"automatic-cover"
        accepted_cover.write_bytes(raw_bytes)
        return accepted_cover

    def accepted_guard(write_action, *, cover_selection_origin):
        events.append(("accepted-guard", cover_selection_origin))
        return write_action()

    accepted_result = cover_refresh_provider.ensure_best_cover_for_folder(
        accepted_folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        CoverSearchCache(tmp_path / "accepted-cache.json"),
        "AlbumHavenTests/1.0",
        cover_selection_origin="automatic",
        reject_if_user_controlled=True,
        automatic_write_guard=accepted_guard,
        search_remote_cover_func=fake_search,
        decode_image_func=lambda _raw: (DecodedImage(), 1600, 1600),
        write_cover_func=accepted_write,
    )

    assert blocked_result[0] == blocked_cover
    assert blocked_result[1] is False
    assert blocked_cover.read_bytes() == b"user-controlled-cover"
    assert blocked_publications == [(candidate, True)]
    assert accepted_result[0] == accepted_cover
    assert accepted_result[1] is True
    assert events == [
        ("blocked-guard", "automatic"),
        ("accepted-guard", "automatic"),
        ("write", "automatic"),
    ]
