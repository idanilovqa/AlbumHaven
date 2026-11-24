"""A write names the gallery refresh it queues: the whole-library form or the keyed journal drain.

Two operations used to share one name, so the freeze guard could not forbid the
whole-library form on a scoped save without also forbidding the drain the
save's journal needs (backlog case 31).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services import cache
from music_app.services import gallery_projection_postgres as gallery
from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter

CONFIG = {"PERSISTENCE_BACKENDS": {"scan_cache": "postgres"}}


@pytest.fixture
def queued(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(gallery, "schedule_full_gallery_projection_refresh",
                        lambda _config, **_kwargs: calls.append("full"), raising=False)
    monkeypatch.setattr(gallery, "queue_journaled_relation_drain",
                        lambda _config, **_kwargs: calls.append("drain"))
    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh",
                        lambda _config, **_kwargs: calls.append("unnamed"))
    return calls


def test_a_snapshot_save_queues_the_full_refresh(monkeypatch, queued, tmp_path):
    adapter = object.__new__(PostgresScanCacheAdapter)
    adapter._connect = None
    adapter.save_snapshot = lambda *_args, **_kwargs: {"saved": True}
    monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda _config: adapter)

    cache.save_cache_to_disk_for_config(CONFIG, tmp_path / "cache.json", {}, "root", 0.0)

    assert queued == ["full"]


def test_a_targeted_inventory_update_queues_the_full_refresh(monkeypatch, queued):
    adapter = SimpleNamespace(
        _connect=None,
        load_file_entries=lambda paths: {path: {"path": path} for path in paths},
        persist_targeted_inventory_mutation=lambda **_kwargs: {"inventory_mutation_revision": 1},
    )
    monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda _config: adapter)
    monkeypatch.setattr(cache, "_publication_root_id", lambda _config, _entries: "main")

    cache.save_cache_updates_to_disk_for_config(CONFIG, {"a.mp3": {"path": "a.mp3", "title": "A"}})

    assert queued == ["full"]


def test_a_cover_save_queues_the_keyed_journal_drain(monkeypatch, queued):
    adapter = SimpleNamespace(persist_cover_selection=lambda **_kwargs: {"album_rows_updated": 1})
    monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda _config: adapter)

    cache.persist_cover_selection_for_tracks_for_config(CONFIG, {"a.mp3"}, None)

    assert queued == ["drain"]


def test_a_structural_save_queues_the_keyed_journal_drain(queued):
    adapter = SimpleNamespace(
        _config=CONFIG, _connect=None,
        _persist_structural_tag_edit_transaction=lambda **_kwargs: {"committed": True},
    )

    PostgresScanCacheAdapter.persist_structural_tag_edit(
        adapter, changed_paths={"a.mp3"}, previous_file_entries={}, updated_file_entries={},
        changed_field_names={"album"},
    )

    assert queued == ["drain"]


def test_a_full_watcher_invalidation_queues_the_full_refresh(monkeypatch):
    from music_app.services import state

    calls: list[str] = []
    monkeypatch.setattr(state, "schedule_full_gallery_projection_refresh",
                        lambda _config, **_kwargs: calls.append("full"), raising=False)
    monkeypatch.setattr(state, "schedule_gallery_projection_refresh",
                        lambda _config, **_kwargs: calls.append("unnamed"), raising=False)
    for name in ("invalidate_problematic_albums_payload_cache", "invalidate_utility_rules_payload_cache",
                 "invalidate_postgres_utility_projection_cache"):
        monkeypatch.setattr(state, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(state, "library_browse_postgres_is_effective", lambda _config: False)

    state.invalidate_targeted_library_projections(
        {}, {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://forms"}, revision=1, affected_album_keys=("a",),
    )

    assert calls == ["full"]


def test_the_generic_scheduler_is_private_to_its_module():
    from pathlib import Path

    assert not hasattr(gallery, "schedule_gallery_projection_refresh")
    assert callable(gallery._schedule_gallery_projection_refresh)
    root = Path(gallery.__file__).resolve().parents[1]
    outside = sorted(
        str(path.relative_to(root)) for path in root.rglob("*.py")
        if path.name != "gallery_projection_postgres.py"
        and "schedule_gallery_projection_refresh" in path.read_text(encoding="utf-8")
    )
    assert outside == []
