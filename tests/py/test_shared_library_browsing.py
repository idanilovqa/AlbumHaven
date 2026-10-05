"""Shared browsing must not become a second library maintenance writer."""
from types import SimpleNamespace

import pytest


def test_shared_browse_rejects_lost_relations_without_callback():
    from music_app.services.library_hydration import hydrate_library_state_from_disk

    with pytest.raises(RuntimeError, match="Shared browsing"):
        hydrate_library_state_from_disk(
            {"albums": [object()]}, {"SHARED_LIBRARY_BROWSE_ONLY": True},
            ensure_relation_views=lambda *_args: pytest.fail("Must not rebuild"),
        )


def test_shared_browse_rejects_relation_refresh_before_state_or_persistence_changes():
    from music_app.services.state import refresh_relation_views_for_state

    state = {"albums": ["unchanged"]}
    with pytest.raises(RuntimeError, match="Shared browsing"):
        refresh_relation_views_for_state(state, {"SHARED_LIBRARY_BROWSE_ONLY": True})
    assert state == {"albums": ["unchanged"]}


def test_shared_browse_rejects_scan_submission_before_state_changes(monkeypatch):
    from music_app.services import state as service

    monkeypatch.setattr(service, "_SCAN_EXECUTOR", SimpleNamespace(submit=lambda *_args: pytest.fail("Must not submit")))

    state = {"albums": ["unchanged"]}
    with pytest.raises(RuntimeError, match="Shared browsing"):
        service.start_background_refresh_for_state(state, {"SHARED_LIBRARY_BROWSE_ONLY": True}, None)
    assert state == {"albums": ["unchanged"]}


def test_shared_browse_stale_projection_never_opens_writer_connection(monkeypatch):
    from music_app.services import relation_projection_postgres as projection

    calls = []

    class Connection:
        def __enter__(self):
            calls.append("read")
            assert len(calls) == 1
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, _sql):
            return SimpleNamespace(fetchone=lambda: {})

    with pytest.raises(RuntimeError, match="Shared browsing"):
        projection.ensure_relation_projection_ready(
            {"SHARED_LIBRARY_BROWSE_ONLY": True, "ALBUM_HAVEN_APP_DATABASE_URL": "fixture"},
            connect=lambda _url: Connection(),
        )
    assert calls == ["read"]


def test_shared_hydration_strictly_reads_without_sanitizing_saving_or_prewarming(monkeypatch):
    from music_app.services import library_hydration as hydration
    from tests.py.test_library_hydration import FakeSelectedScanCacheAdapter

    views = {"artists": ["fixture"], "artists_sidebar": [], "sidebar_families": [],
             "alias_to_canonical": {}, "canonical_to_aliases": {}, "family_to_artists": {}, "folder_related": {}}
    adapter = FakeSelectedScanCacheAdapter({"fixture": {"path": "fixture"}}, 1, views)
    monkeypatch.setattr(hydration, "library_root_cache_identity", lambda _config: "fixture")
    monkeypatch.setattr(hydration, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(hydration, "build_albums_from_file_cache", lambda *_args: ["album"])
    monkeypatch.setattr(hydration, "select_runtime_persistence_adapter", lambda *_args: SimpleNamespace(effective_backend="postgres"))
    monkeypatch.setattr(hydration, "sanitize_hydrated_file_cache", lambda *_args, **_kwargs: pytest.fail("Must not sanitize"))
    state = {}
    assert hydration.hydrate_library_state_from_disk(
        state, {"SHARED_LIBRARY_BROWSE_ONLY": True, "CACHE_PATH": "fixture"},
        scan_cache_adapter=adapter, validate_cache=True,
        ensure_relation_views=lambda *_args: pytest.fail("Must not rebuild"),
        queue_problematic_albums_prewarm=lambda: pytest.fail("Must not prewarm"),
    )
    assert len(adapter.strict_load_calls) == 1
    assert adapter.save_calls == []
    assert state["relation_views"] == views
