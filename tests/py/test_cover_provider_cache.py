from __future__ import annotations

import json
import os
from pathlib import Path

from music_app.services import cover_provider_cache
from music_app.services.cover_provider_cache import CoverSearchCache


def test_cover_search_cache_loads_missing_and_malformed_files_as_empty(tmp_path):
    cache_path = (tmp_path / "cover_search_cache.json").resolve()

    missing_cache = CoverSearchCache(cache_path)

    assert missing_cache.get("artist::album") is None

    for payload in (
        "not-json",
        json.dumps(["not", "a", "mapping"]),
        json.dumps({"queries": ["not", "a", "mapping"]}),
        json.dumps({"queries": {"artist::album": ["malformed", "entry"]}}),
    ):
        cache_path.write_text(payload, encoding="utf-8")
        malformed_cache = CoverSearchCache(cache_path)

        assert malformed_cache.get("artist::album") is None


def test_cover_search_cache_logs_permission_read_errors(tmp_path, monkeypatch, caplog):
    cache_path = (tmp_path / "cover_search_cache.json").resolve()
    original_exists = Path.exists

    def raise_permission_error(self: Path) -> bool:
        if self == cache_path:
            raise PermissionError("locked")
        return original_exists(self)

    monkeypatch.setattr(Path, "exists", raise_permission_error)

    with caplog.at_level("WARNING"):
        cache = CoverSearchCache(cache_path)

    assert cache.get("artist::album") is None
    assert "Cover search cache read skipped" in caplog.text


def test_cover_search_cache_get_and_set_use_shallow_copies_and_ignore_malformed_queries(tmp_path):
    cache = CoverSearchCache((tmp_path / "cover_search_cache.json").resolve())
    nested = {"inner": "original"}
    value = {"url": "https://images.example/cover.jpg", "nested": nested}

    cache.set("artist::album", value)
    value["url"] = "mutated"
    nested["inner"] = "mutated"
    first_hit = cache.get("artist::album")
    assert first_hit == {"url": "https://images.example/cover.jpg", "nested": {"inner": "mutated"}}

    first_hit["url"] = "changed"
    assert cache.get("artist::album") == {
        "url": "https://images.example/cover.jpg",
        "nested": {"inner": "mutated"},
    }

    cache._payload["queries"] = "malformed"
    cache._dirty = False
    cache.set("ignored", {"value": True})
    assert cache._dirty is False
    assert cache.get("ignored") is None


def test_cover_search_cache_save_failure_keeps_dirty_for_retry(tmp_path, monkeypatch, caplog):
    cache_path = (tmp_path / "cover_search_cache.json").resolve()
    cache = CoverSearchCache(cache_path)
    previous = {"url": "https://images.example/previous.jpg"}
    cache.set("artist::album", previous)
    cache.save()
    previous_bytes = cache_path.read_bytes()
    cache.set("artist::album", {"url": "https://images.example/cover.jpg"})
    original_replace = os.replace
    attempted_sources = []

    def raise_permission_error(source, destination, *args, **kwargs):
        if Path(destination) == cache_path:
            attempted_sources.append(Path(source))
            assert Path(source).parent == cache_path.parent
            assert Path(source) != cache_path
            assert json.loads(Path(source).read_text(encoding="utf-8"))["queries"]["artist::album"] == {
                "url": "https://images.example/cover.jpg",
            }
            raise PermissionError("locked")
        return original_replace(source, destination, *args, **kwargs)

    monkeypatch.setattr(os, "replace", raise_permission_error)

    with caplog.at_level("WARNING"):
        cache.save()

    assert "Cover search cache write skipped" in caplog.text
    assert cache._dirty is True
    assert attempted_sources
    assert cache_path.read_bytes() == previous_bytes
    assert CoverSearchCache(cache_path).get("artist::album") == previous
    assert set(tmp_path.iterdir()) == {cache_path}

    monkeypatch.setattr(os, "replace", original_replace)

    cache.save()

    assert cache._dirty is False
    saved_text = cache_path.read_text(encoding="utf-8")
    assert saved_text.startswith('{\n  "queries": {')
    assert json.loads(saved_text) == {
        "queries": {
            "artist::album": {
                "url": "https://images.example/cover.jpg",
            },
        },
    }
    assert CoverSearchCache(cache_path).get("artist::album") == {
        "url": "https://images.example/cover.jpg",
    }
    assert set(tmp_path.iterdir()) == {cache_path}


def test_cover_search_cache_publishes_complete_checkpoint_by_atomic_replace(tmp_path, monkeypatch):
    cache_path = tmp_path / "cover_search_cache.json"
    cache = CoverSearchCache(cache_path)
    cache.set("old", {"status": "no_match"})
    cache.save()
    previous_bytes = cache_path.read_bytes()
    cache.set("new", {"url": "https://images.example/new.jpg"})
    original_replace = os.replace
    replacements = []

    def observe_replace(source, destination, *args, **kwargs):
        if Path(destination) == cache_path:
            assert cache_path.read_bytes() == previous_bytes
            assert Path(source).parent == cache_path.parent
            assert Path(source) != cache_path
            staged = json.loads(Path(source).read_text(encoding="utf-8"))
            assert set(staged["queries"]) == {"old", "new"}
            replacements.append(Path(source))
        return original_replace(source, destination, *args, **kwargs)

    monkeypatch.setattr(os, "replace", observe_replace)
    cache.save()

    assert len(replacements) == 1
    reloaded = CoverSearchCache(cache_path)
    assert reloaded.get("old") == {"status": "no_match"}
    assert reloaded.get("new") == {"url": "https://images.example/new.jpg"}
    assert cache._dirty is False
    assert set(tmp_path.iterdir()) == {cache_path}
    cache.save()
    assert len(replacements) == 1


def test_cover_search_cache_cleanup_permission_failure_preserves_checkpoint(tmp_path, monkeypatch, caplog):
    cache_path = tmp_path / "cover_search_cache.json"
    cache = CoverSearchCache(cache_path)
    cache.set("old", {"status": "no_match"})
    cache.save()
    previous_bytes = cache_path.read_bytes()
    cache.set("new", {"url": "https://images.example/new.jpg"})
    original_replace = os.replace
    original_unlink = Path.unlink
    owned_temporary_paths = []

    def deny_replace(source, destination, *args, **kwargs):
        if Path(destination) == cache_path:
            owned_temporary_paths.append(Path(source))
            raise PermissionError("checkpoint locked")
        return original_replace(source, destination, *args, **kwargs)

    def deny_owned_cleanup(self, *args, **kwargs):
        if self in owned_temporary_paths:
            raise PermissionError("temporary checkpoint locked")
        return original_unlink(self, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(os, "replace", deny_replace)
        patch.setattr(Path, "unlink", deny_owned_cleanup)
        with caplog.at_level("WARNING"):
            cache.save()

    assert cache._dirty is True
    assert cache_path.read_bytes() == previous_bytes
    assert CoverSearchCache(cache_path).get("old") == {"status": "no_match"}
    assert CoverSearchCache(cache_path).get("new") is None
    assert "Cover search cache write skipped" in caplog.text
    assert "cleanup" in caplog.text.casefold()
    assert len(owned_temporary_paths) == 1
    assert owned_temporary_paths[0].exists()
    assert json.loads(owned_temporary_paths[0].read_text(encoding="utf-8"))["queries"]["new"] == {
        "url": "https://images.example/new.jpg",
    }


def test_cover_query_key_preserves_automatic_refresh_normalization():
    assert (
        cover_provider_cache.cover_query_key("Beyonce & Jay-Z", "Lemonade!", "Deluxe Edition", 2016)
        == "beyonce and jay z::lemonade exclamation mark::deluxe edition::2016"
    )
    assert cover_provider_cache.cover_query_key(" Artist ", " Album ", None, None) == "artist::album::::"


def test_musicbrainz_release_disk_cache_namespace_filters_and_skips_empty(tmp_path, monkeypatch):
    cache = CoverSearchCache((tmp_path / "cover_search_cache.json").resolve())
    monkeypatch.setattr(cover_provider_cache, "_MUSICBRAINZ_RELEASE_DISK_CACHE", cache)
    monkeypatch.setattr(cover_provider_cache.time, "time", lambda: 1234.0)

    cover_provider_cache._set_musicbrainz_release_disk_cache("artist::album", ["malformed"])

    assert cache.get("musicbrainz-release::artist::album") is None

    cover_provider_cache._set_musicbrainz_release_disk_cache(
        "artist::album",
        [
            {"id": "release-1", "title": "Album"},
            "malformed",
            {"id": "release-2", "title": "Deluxe"},
        ],
    )

    assert cache.get("artist::album") is None
    assert cache.get("musicbrainz-release::artist::album") == {
        "updated_at": 1234.0,
        "releases": [
            {"id": "release-1", "title": "Album"},
            {"id": "release-2", "title": "Deluxe"},
        ],
    }
    assert cover_provider_cache._get_musicbrainz_release_disk_cache("artist::album") == [
        {"id": "release-1", "title": "Album"},
        {"id": "release-2", "title": "Deluxe"},
    ]


def test_caa_results_disk_cache_namespace_filters_ttl_and_skips_empty(tmp_path, monkeypatch):
    cache = CoverSearchCache((tmp_path / "cover_search_cache.json").resolve())
    now = 2_000.0
    monkeypatch.setattr(cover_provider_cache, "_MUSICBRAINZ_RELEASE_DISK_CACHE", cache)
    monkeypatch.setattr(cover_provider_cache.time, "time", lambda: now)

    cover_provider_cache._set_caa_results_disk_cache("release-1", ["malformed"])

    assert cache.get("caa-results::release-1") is None

    cover_provider_cache._set_caa_results_disk_cache(
        "release-1",
        [
            {"image": "https://images.example/front.jpg"},
            "malformed",
            {"image": "https://images.example/back.jpg"},
        ],
    )

    assert cache.get("release-1") is None
    assert cache.get("caa-results::release-1") == {
        "updated_at": now,
        "ttl_seconds": cover_provider_cache._CAA_RESULTS_CACHE_TTL_SECONDS,
        "candidates": [
            {"image": "https://images.example/front.jpg"},
            {"image": "https://images.example/back.jpg"},
        ],
    }
    assert cover_provider_cache._get_caa_results_disk_cache("release-1") == [
        {"image": "https://images.example/front.jpg"},
        {"image": "https://images.example/back.jpg"},
    ]

    cache.set(
        "caa-results::expired",
        {
            "updated_at": now - cover_provider_cache._CAA_RESULTS_CACHE_TTL_SECONDS - 1,
            "candidates": [{"image": "https://images.example/old.jpg"}],
        },
    )
    cache.set(
        "caa-results::malformed",
        {
            "updated_at": now,
            "candidates": {"image": "https://images.example/not-a-list.jpg"},
        },
    )
    cache.set(
        "caa-results::stored-ttl-is-ignored",
        {
            "updated_at": now - 1,
            "ttl_seconds": 0,
            "candidates": [{"image": "https://images.example/fresh.jpg"}],
        },
    )

    assert cover_provider_cache._get_caa_results_disk_cache("expired") is None
    assert cover_provider_cache._get_caa_results_disk_cache("malformed") is None
    assert cover_provider_cache._get_caa_results_disk_cache("stored-ttl-is-ignored") == [
        {"image": "https://images.example/fresh.jpg"},
    ]
