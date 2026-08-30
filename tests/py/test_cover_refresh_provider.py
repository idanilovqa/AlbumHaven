from __future__ import annotations

import hashlib
import io

import pytest

from music_app.services import cover_refresh_provider
from music_app.services import cover_provider_apple
from music_app.services import cover_provider_deezer
from music_app.services import cover_provider_http
from music_app.services.cover_provider_candidates import CoverCandidate
from music_app.services.cover_provider_cache import CoverSearchCache


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
    assert calls == [("apple", True), ("deezer", None)]
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
    monkeypatch.setattr(cover_refresh_provider, "_search_spotify", no_candidate("spotify"))

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
    assert calls == ["apple", "deezer", "spotify"]
    assert [item["resolver"] for item in trace] == [
        "_search_apple",
        "_search_deezer",
        "_search_spotify",
    ]


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


def test_user_controlled_cover_publishes_improvement_without_writing_bytes(
    tmp_path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    current_cover = folder / "cover.jpg"
    original_bytes = b"user-selected-cover"
    current_cover.write_bytes(original_bytes)
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
        cover_selection_origin="user",
        reject_if_user_controlled=True,
        candidate_callback=publish_candidate,
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
    assert automatic_result[2]["reason"] == "successful_cache_and_local_cover_present"
    assert search_calls == []

    user_result = cover_refresh_provider.ensure_best_cover_for_folder(
        folder,
        "Artist",
        "Album",
        None,
        2001,
        {".jpg"},
        cache,
        "AlbumHavenTests/1.0",
        cover_selection_origin="user",
        reject_if_user_controlled=True,
        search_remote_cover_func=search,
    )
    assert user_result[2]["reason"] == "remote_search_returned_no_candidate"
    assert search_calls == [True]


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
        cover_selection_origin="user",
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
