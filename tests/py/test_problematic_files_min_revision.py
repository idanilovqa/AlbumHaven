from __future__ import annotations

import music_app.services.library_browse_postgres as library_browse_postgres_module


def test_cached_problematic_files_older_than_the_callers_edit_are_rebuilt(monkeypatch):
    """PF-NEW-PROBLEMS (owner): after a save the list must not come from before that save."""
    database_url = "postgresql://album_haven_app@localhost/pf-min-revision"
    cache_key = (database_url, "problematic-files")
    repository = library_browse_postgres_module.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": database_url},
        connect=lambda _database_url: None,
    )
    built_revisions = iter([41, 42])

    def build_payload():
        revision = next(built_revisions)
        return {"items": [{"key": f"built-at-{revision}"}], "count": 1, "inventory_revision": revision}

    monkeypatch.setattr(repository, "_build_problematic_files_payload_uncached", build_payload)
    with library_browse_postgres_module._UTILITY_PROJECTION_CACHE_LOCK:
        library_browse_postgres_module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        library_browse_postgres_module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)
    try:
        assert repository.build_problematic_files_payload()["items"][0]["key"] == "built-at-41"
        # Same or older revision: the cached list is current enough.
        assert repository.build_problematic_files_payload(min_inventory_revision=41)["items"][0]["key"] == "built-at-41"
        # The caller saw edit 42: the list from 41 is rebuilt, and the rebuild is cached.
        assert repository.build_problematic_files_payload(min_inventory_revision=42)["items"][0]["key"] == "built-at-42"
        assert repository.build_problematic_files_payload()["items"][0]["key"] == "built-at-42"
    finally:
        with library_browse_postgres_module._UTILITY_PROJECTION_CACHE_LOCK:
            library_browse_postgres_module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
            library_browse_postgres_module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)
