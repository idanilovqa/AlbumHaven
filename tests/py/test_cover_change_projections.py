"""A cover change racing a projection build or reload is never lost.

Rules is the cached projection that shows covers; Problematic Files reads its
persisted index, which the database journal keeps current per album."""

from __future__ import annotations

import pytest

from music_app.services import library_browse_postgres as browse

URL = "postgresql://album_haven_app@localhost/cover_changes"
KEY = (URL, "rules")


@pytest.fixture
def repository(monkeypatch):
    for name in (
        "_UTILITY_PROJECTION_CACHE", "_UTILITY_PROJECTION_GENERATIONS",
        "_UTILITY_PROJECTION_SINGLEFLIGHT", "_UTILITY_COVER_CHANGES",
    ):
        monkeypatch.setattr(browse, name, {})
    return browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": URL}, connect=lambda _url: None)


def _save(*paths):
    browse.record_cover_change_in_utility_projections(database_url=URL, track_paths=set(paths))


def test_a_change_during_a_reload_waits_for_the_next_read(repository):
    browse._UTILITY_PROJECTION_CACHE[KEY] = {"saves": 0}
    _save("a")
    reloaded = []

    def reload(payload, paths):
        reloaded.append(paths)
        if len(reloaded) == 1:
            _save("a")  # the same album again
        return {"saves": payload["saves"] + 1}

    for _read in range(3):
        repository._apply_cover_changes("rules", reload)

    assert reloaded == [{"a"}, {"a"}]
    assert browse._UTILITY_PROJECTION_CACHE[KEY] == {"saves": 2}


def test_a_reload_never_overwrites_a_rebuild_that_finished_meanwhile(repository):
    browse._UTILITY_PROJECTION_CACHE[KEY] = {"build": 1}
    _save("a")

    def reload(payload, _paths):
        if payload["build"] == 1:
            browse._UTILITY_PROJECTION_CACHE[KEY] = {"build": 2}
        return {**payload, "reloaded": True}

    repository._apply_cover_changes("rules", reload)

    assert browse._UTILITY_PROJECTION_CACHE[KEY] == {"build": 2, "reloaded": True}


def test_a_change_during_a_rules_build_is_applied_on_the_next_read(repository, monkeypatch):
    monkeypatch.setattr(repository, "_load_utility_rules_rows", lambda: _save("a") or [])
    monkeypatch.setattr(
        repository, "_utility_rules_with_reloaded_covers",
        lambda payload, paths: {**payload, "reloaded": paths},
    )

    assert "reloaded" not in repository.build_utility_rules_payload()
    assert repository.build_utility_rules_payload()["reloaded"] == {"a"}


def test_a_full_invalidation_discards_the_noted_changes(repository):
    browse._UTILITY_PROJECTION_CACHE[KEY] = {"rules": []}
    _save("a")

    browse.invalidate_postgres_utility_projection_cache(database_url=URL)

    assert KEY not in browse._UTILITY_COVER_CHANGES


def test_a_change_keeps_every_projection_cached(repository):
    other = (URL, "duplicate-identities")
    browse._UTILITY_PROJECTION_CACHE.update({KEY: {}, other: {}})

    _save("a")

    assert KEY in browse._UTILITY_PROJECTION_CACHE and other in browse._UTILITY_PROJECTION_CACHE
    assert browse._UTILITY_COVER_CHANGES[KEY].keys() == {"a"}
    assert other not in browse._UTILITY_COVER_CHANGES
