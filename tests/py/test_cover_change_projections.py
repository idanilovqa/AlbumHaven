"""A cover change racing a projection build or reload is never lost."""

from __future__ import annotations

import pytest

from music_app.services import library_browse_postgres as browse

URL = "postgresql://album_haven_app@localhost/cover_changes"
KEY = (URL, "problematic-files")


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


def test_a_change_during_the_complete_build_is_applied_on_the_next_read(repository, monkeypatch):
    def build():
        _save("a")  # commits after the build took its snapshot
        return {"items": ["before"]}

    reloaded = []
    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build)
    monkeypatch.setattr(
        repository, "_problematic_files_with_reloaded_albums",
        lambda payload, paths: reloaded.append(paths) or {"items": ["after"]},
    )

    assert repository.build_problematic_files_payload()["projection_cache_status"] == "rebuilt"
    assert repository.build_problematic_files_payload()["items"] == ["after"]
    assert repository.build_problematic_files_payload()["items"] == ["after"]
    assert reloaded == [{"a"}]


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
        repository._apply_cover_changes("problematic-files", reload)

    assert reloaded == [{"a"}, {"a"}]
    assert browse._UTILITY_PROJECTION_CACHE[KEY] == {"saves": 2}


def test_a_reload_never_overwrites_a_rebuild_that_finished_meanwhile(repository):
    browse._UTILITY_PROJECTION_CACHE[KEY] = {"build": 1}
    _save("a")

    def reload(payload, _paths):
        if payload["build"] == 1:
            browse._UTILITY_PROJECTION_CACHE[KEY] = {"build": 2}
        return {**payload, "reloaded": True}

    repository._apply_cover_changes("problematic-files", reload)

    assert browse._UTILITY_PROJECTION_CACHE[KEY] == {"build": 2, "reloaded": True}


def test_a_change_during_a_rules_build_keeps_that_build_out_of_the_cache(repository, monkeypatch):
    monkeypatch.setattr(repository, "_load_utility_rules_rows", lambda: _save("a") or [])

    repository.build_utility_rules_payload()

    assert (URL, "rules") not in browse._UTILITY_PROJECTION_CACHE


def test_a_full_invalidation_discards_the_noted_changes(repository):
    browse._UTILITY_PROJECTION_CACHE[KEY] = {"items": []}
    _save("a")

    browse.invalidate_postgres_utility_projection_cache(database_url=URL)

    assert KEY not in browse._UTILITY_COVER_CHANGES


def test_a_change_drops_only_the_unpatchable_first_pages(repository):
    page = (URL, browse._PROBLEMATIC_FILES_PAGE_KIND)
    other = (URL, "duplicate-identities")
    browse._UTILITY_PROJECTION_CACHE.update({KEY: {}, page: {}, other: {}})

    _save("a")

    assert page not in browse._UTILITY_PROJECTION_CACHE
    assert KEY in browse._UTILITY_PROJECTION_CACHE and other in browse._UTILITY_PROJECTION_CACHE
