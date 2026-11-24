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
