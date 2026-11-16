from __future__ import annotations

import json
from pathlib import Path

import pytest

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services import cache as cache_module
from music_app.services.cache import load_cache_snapshot_from_disk


def _cache_entry(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "mtime": 1.0,
        "size": 4,
        "album": "Album",
        "album_artist": "Artist",
        "title": "Song",
        "artist": "Artist",
        "track_number": 1,
        "disc_number": None,
        "duration_seconds": 180,
    }


def test_file_entry_round_trip_preserves_local_membership_rejection(tmp_path):
    entry = _cache_entry(tmp_path / "orphan.flac")
    entry["local_album_membership_problem"] = "Duplicate track outside album folder"
    serialized = cache_module.serialize_file_entry(entry)
    assert serialized["local_album_membership_problem"] == entry["local_album_membership_problem"]
    assert cache_module.deserialize_file_entry(serialized)["local_album_membership_problem"] == entry["local_album_membership_problem"]


def test_file_entry_round_trip_preserves_structured_track_artists(tmp_path):
    entry = _cache_entry(tmp_path / "joint-credit.flac")
    entry["artist"] = "Brian Eno & David Byrne"
    entry["artists"] = ["Brian Eno", "David Byrne"]

    serialized = cache_module.serialize_file_entry(entry)
    hydrated = cache_module.deserialize_file_entry(serialized)

    assert serialized["artists"] == ["Brian Eno", "David Byrne"]
    assert hydrated["artists"] == ["Brian Eno", "David Byrne"]


def test_file_entry_round_trip_preserves_structural_cover_inheritance(tmp_path):
    entry = _cache_entry(tmp_path / "split.flac")
    entry["cover_inherited_from_structural_edit"] = True

    serialized = cache_module.serialize_file_entry(entry)

    assert serialized["cover_inherited_from_structural_edit"] is True
    assert (
        cache_module.deserialize_file_entry(serialized)[
            "cover_inherited_from_structural_edit"
        ]
        is True
    )


def _write_migration_cache(
    cache_path: Path,
    *,
    root_identity: str,
    entries: dict[str, dict[str, object]],
) -> None:
    cache_path.write_text(
        json.dumps(
            {
                "library_root_identity": root_identity,
                "last_scan": 123.0,
                "files": {
                    path: cache_module.serialize_file_entry(entry)
                    for path, entry in entries.items()
                },
                "relation_views": {"artists": ["Artist"]},
                "relations_last_built": 456.0,
            }
        ),
        encoding="utf-8",
    )


def test_cache_persistence_seams_source_stays_flask_free():
    source = Path(__file__).read_text(encoding="utf-8")
    forbidden = [
        "from " + "flask",
        "import " + "flask",
        "Flask" + "(",
        "has_app" + "_context",
        ".app_" + "context(",
    ]

    assert all(pattern not in source for pattern in forbidden)


def test_migration_cache_snapshot_reader_preserves_malformed_cache_error(tmp_path):
    cache_path = tmp_path / "library_cache.json"
    cache_path.write_text("{not-json", encoding="utf-8")

    file_cache, last_scan, relation_views, relations_last_built, error = (
        load_cache_snapshot_from_disk(cache_path, "root-1")
    )

    assert file_cache == {}
    assert last_scan == 0.0
    assert relation_views == {}
    assert relations_last_built == 0.0
    assert error is not None
    assert "Could not read cache file" in error


def test_migration_cache_snapshot_reader_merges_update_file(tmp_path):
    cache_path = tmp_path / "library_cache.json"
    first_track = tmp_path / "first.mp3"
    updated_track = tmp_path / "updated.mp3"
    _write_migration_cache(
        cache_path,
        root_identity="root-1",
        entries={str(first_track): _cache_entry(first_track)},
    )
    cache_path.with_name("library_cache.updates.json").write_text(
        json.dumps(
            {
                "files": {
                    str(updated_track): cache_module.serialize_file_entry(
                        _cache_entry(updated_track)
                    )
                }
            }
        ),
        encoding="utf-8",
    )

    file_cache, last_scan, relation_views, relations_last_built, error = (
        load_cache_snapshot_from_disk(cache_path, "root-1")
    )

    assert error is None
    assert last_scan == 123.0
    assert set(file_cache) == {str(first_track), str(updated_track)}
    assert relation_views["artists"] == ["Artist"]
    assert relations_last_built == 456.0


def test_disk_cache_readers_are_migration_owned_and_runtime_file_writers_stay_removed():
    cache_source = Path("music_app/services/cache.py").read_text(encoding="utf-8")
    migration_source = Path("scripts/migrate_app_data_to_postgres.py").read_text(
        encoding="utf-8"
    )

    assert "def load_cache_snapshot_from_disk(" in cache_source
    assert "def load_cache_from_disk(" not in cache_source
    assert "load_cache_snapshot_from_disk" in migration_source
    assert "save_json_file" not in cache_source
    assert "def save_cache_to_disk(" not in cache_source
    assert "def save_cache_updates_to_disk(" not in cache_source
    assert "def _save_cache_to_file(" not in cache_source
    assert "def _save_cache_updates_to_file(" not in cache_source
    assert "class FileScanCacheAdapter" not in Path(
        "music_app/services/scan_cache_persistence.py"
    ).read_text(encoding="utf-8")
    assert not Path("music_app/services/musicbrainz.py").exists()


def test_runtime_cache_save_forwards_complete_snapshot_to_selected_postgres_adapter(
    tmp_path,
    monkeypatch,
):
    cache_path = tmp_path / "library_cache.json"
    track_path = tmp_path / "track.mp3"
    config = {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}}
    saved_snapshots: list[dict[str, object]] = []

    class FakePostgresScanCacheAdapter:
        backend = PERSISTENCE_BACKEND_POSTGRES

        def save_snapshot(
            self,
            received_cache_path,
            file_cache,
            received_root_identity,
            last_scan,
            *,
            relation_views=None,
            relations_last_built=None,
            separate_release_keys=None,
        ):
            saved_snapshots.append(
                {
                    "cache_path": received_cache_path,
                    "file_cache": dict(file_cache),
                    "root_identity": received_root_identity,
                    "last_scan": last_scan,
                    "relation_views": relation_views,
                    "relations_last_built": relations_last_built,
                    "separate_release_keys": separate_release_keys,
                }
            )

    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda received_config: (
            FakePostgresScanCacheAdapter()
            if received_config is config
            else pytest.fail("runtime config was not forwarded")
        ),
    )

    cache_module.save_cache_to_disk_for_config(
        config,
        cache_path,
        {str(track_path): _cache_entry(track_path)},
        "root-1",
        123.0,
        relation_views={"artists": ["Artist"]},
        relations_last_built=456.0,
        separate_release_keys={"artist::album"},
    )

    assert saved_snapshots == [
        {
            "cache_path": cache_path,
            "file_cache": {str(track_path): _cache_entry(track_path)},
            "root_identity": "root-1",
            "last_scan": 123.0,
            "relation_views": {"artists": ["Artist"]},
            "relations_last_built": 456.0,
            "separate_release_keys": {"artist::album"},
        }
    ]
    assert not cache_path.exists()


def test_runtime_cache_save_propagates_postgres_adapter_selection_failure(
    tmp_path,
    monkeypatch,
):
    selection_error = ValueError(
        "Postgres runtime persistence adapter is unavailable for scan_cache."
    )
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: (_ for _ in ()).throw(selection_error),
    )

    with pytest.raises(ValueError) as raised:
        cache_module.save_cache_to_disk_for_config(
            {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
            tmp_path / "must-not-exist.json",
            {},
            "root-1",
            123.0,
        )

    assert raised.value is selection_error
    assert not (tmp_path / "must-not-exist.json").exists()


class _TargetedInventoryAdapter:
    """Stands in for the Postgres scan-cache adapter's targeted surface: entry
    loads by path, revision reads, and the revision-guarded targeted mutation."""

    def __init__(self, file_cache, *, cover_mutation_revision=0, inventory_mutation_revision=0):
        self.file_cache = {path: dict(entry) for path, entry in file_cache.items()}
        self.cover_mutation_revision = cover_mutation_revision
        self.inventory_mutation_revision = inventory_mutation_revision
        self.loaded_paths: list[set[str]] = []
        self.publications: list[dict[str, object]] = []
        self.after_load = None

    def load_cover_mutation_revision(self):
        return self.cover_mutation_revision

    def load_inventory_mutation_revision(self):
        return self.inventory_mutation_revision

    def load_file_entries(self, paths):
        self.loaded_paths.append(set(paths))
        loaded = {path: dict(self.file_cache[path]) for path in paths if path in self.file_cache}
        if self.after_load is not None:
            self.after_load(self)
        return loaded

    def load_snapshot(self, *_args):
        pytest.fail("a queued cache update must not load the whole scan snapshot")

    def save_snapshot(self, *_args, **_kwargs):
        pytest.fail("a queued cache update must not republish the whole scan snapshot")

    def persist_targeted_inventory_mutation(
        self,
        *,
        root_id,
        active_file_entries,
        expected_cover_mutation_revision,
        expected_inventory_mutation_revision,
        before_commit,
    ):
        from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

        self.publications.append({
            "root_id": root_id,
            "active_file_entries": {path: dict(entry) for path, entry in active_file_entries.items()},
            "expected_revisions": (expected_cover_mutation_revision, expected_inventory_mutation_revision),
        })
        if (expected_cover_mutation_revision, expected_inventory_mutation_revision) != (
            self.cover_mutation_revision, self.inventory_mutation_revision,
        ):
            raise ScanCachePublicationSuperseded(f"forced queued-writer conflict {len(self.publications)}")
        if before_commit is not None:
            before_commit("transaction")
        self.file_cache.update({path: dict(entry) for path, entry in active_file_entries.items()})
        self.inventory_mutation_revision += 1
        return {"inventory_mutation_revision": self.inventory_mutation_revision, "affected_album_keys": ["artist::album"]}


@pytest.fixture
def targeted_adapter(monkeypatch):
    """Installs a targeted adapter double; the gallery refresh records its trigger."""
    from music_app.services import gallery_projection_postgres

    installed: dict[str, object] = {"refreshes": 0}

    def install(file_cache, **revisions):
        adapter = _TargetedInventoryAdapter(file_cache, **revisions)
        installed["adapter"] = adapter
        return adapter

    monkeypatch.setattr(cache_module, "_select_runtime_scan_cache_adapter", lambda _config: installed["adapter"])
    monkeypatch.setattr(
        gallery_projection_postgres, "schedule_gallery_projection_refresh",
        lambda _config, **_kwargs: installed.__setitem__("refreshes", installed["refreshes"] + 1),
    )
    install.installed = installed
    return install


_POSTGRES_CONFIG = {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}}


def test_runtime_cache_update_publishes_only_the_changed_entries_and_leaves_relations_stale(tmp_path, targeted_adapter):
    existing_track = tmp_path / "existing.mp3"
    changed_track = tmp_path / "changed.mp3"
    adapter = targeted_adapter(
        {str(existing_track): _cache_entry(existing_track), str(changed_track): _cache_entry(changed_track)},
        cover_mutation_revision=17,
        inventory_mutation_revision=4,
    )
    changed_entry = {**_cache_entry(changed_track), "title": "Changed", "library_root_id": "main"}

    result = cache_module.save_cache_updates_to_disk_for_config(
        _POSTGRES_CONFIG, {str(changed_track): changed_entry},
    )

    assert adapter.loaded_paths == [{str(changed_track)}]
    assert adapter.publications == [{
        "root_id": "main",
        "active_file_entries": {str(changed_track): changed_entry},
        "expected_revisions": (17, 4),
    }]
    assert result == {"inventory_mutation_revision": 5, "affected_album_keys": ["artist::album"], "projection_mode": "stale"}
    # The stale relation projection is rebuilt by the background gallery refresh.
    assert targeted_adapter.installed["refreshes"] == 1


def test_runtime_cache_update_propagates_postgres_inventory_load_error(tmp_path, targeted_adapter):
    adapter = targeted_adapter({})

    def fail(_adapter):
        raise RuntimeError("Postgres inventory unavailable")

    adapter.after_load = fail

    with pytest.raises(RuntimeError, match="Postgres inventory unavailable"):
        cache_module.save_cache_updates_to_disk_for_config(
            _POSTGRES_CONFIG,
            {str(tmp_path / "track.mp3"): _cache_entry(tmp_path / "track.mp3")},
        )

    assert adapter.publications == []
    assert targeted_adapter.installed["refreshes"] == 0


def test_queued_title_update_preserves_newer_authoritative_cover(tmp_path, targeted_adapter):
    track_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "song.mp3").resolve())
    stale_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "Art" / "Back.jpg").resolve())
    incidental_queued_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "Art" / "Incidental.jpg").resolve())
    selected_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "cover.jpg").resolve())
    adapter = targeted_adapter({
        track_path: {
            "path": track_path, "cover_path": stale_cover_path, "cover_revision": "stale-revision",
            "title": "Old Title", "play_count": 0, "library_root_id": "main",
        }
    })

    def commit_authoritative_cover_after_first_load(store):
        # An authoritative cover selection commits between the first load and publication.
        if len(store.loaded_paths) == 1:
            store.cover_mutation_revision = 1
            store.file_cache[track_path].update({"cover_path": selected_cover_path, "cover_revision": "selected-revision"})

    adapter.after_load = commit_authoritative_cover_after_first_load

    cache_module.save_cache_updates_to_disk_for_config(
        _POSTGRES_CONFIG,
        {track_path: {
            "path": track_path, "cover_path": incidental_queued_cover_path,
            "cover_revision": "incidental-queued-revision", "title": "New Title", "play_count": 1,
            "library_root_id": "main",
        }},
    )

    final_entry = adapter.file_cache[track_path]
    assert final_entry["cover_path"] == selected_cover_path
    assert final_entry["cover_revision"] == "selected-revision"
    assert final_entry["title"] == "New Title"
    assert final_entry["play_count"] == 1
    assert [publication["expected_revisions"] for publication in adapter.publications] == [(0, 0), (1, 0)]


def test_file_entry_cache_round_trip_preserves_metadata_and_cover_validation_signature(tmp_path):
    from music_app.services.problem_suggestions import build_problem_suggestions

    cover_path = tmp_path / "Artist" / "Album" / "cover.jpg"
    entry = {
        **_cache_entry(tmp_path / "Artist" / "Album" / "01 - Song.mp3"),
        "album": "Album (Deluxe Edition)",
        "edition": "",
        "genre": "Progressive Rock",
        "release_date": "2004-07-16",
        "total_discs": 2,
        "disc_subtitle": "Bonus",
        "cover_validation_path": str(cover_path),
        "cover_validation_mtime_ns": 1_785_057_493_000_000_000,
        "cover_validation_size": 321_987,
    }

    serialized = cache_module.serialize_file_entry(entry)
    hydrated = cache_module.deserialize_file_entry(serialized)

    assert serialized["genre"] == "Progressive Rock"
    assert serialized["release_date"] == "2004-07-16"
    assert hydrated["genre"] == "Progressive Rock"
    assert hydrated["release_date"] == "2004-07-16"
    assert serialized["total_discs"] == 2
    assert serialized["disc_subtitle"] == "Bonus"
    assert hydrated["total_discs"] == 2
    assert hydrated["disc_subtitle"] == "Bonus"
    original_proposal = next(
        item for item in build_problem_suggestions(entry["path"], entry)
        if item["field"] == "album_edition"
    )
    hydrated_proposal = next(
        item for item in build_problem_suggestions(entry["path"], hydrated)
        if item["field"] == "album_edition"
    )
    assert hydrated_proposal == original_proposal
    assert serialized["cover_validation_path"] == str(cover_path)
    assert serialized["cover_validation_mtime_ns"] == 1_785_057_493_000_000_000
    assert serialized["cover_validation_size"] == 321_987
    assert hydrated["cover_validation_path"] == str(cover_path)
    assert hydrated["cover_validation_mtime_ns"] == 1_785_057_493_000_000_000
    assert hydrated["cover_validation_size"] == 321_987


def test_incomplete_schema_v2_entry_keeps_release_date_absent_after_hydration(
    tmp_path,
):
    entry = {
        **_cache_entry(tmp_path / "Artist" / "Album" / "01 - Song.mp3"),
        "metadata_schema_version": 2,
    }
    entry.pop("release_date", None)

    hydrated = cache_module.deserialize_file_entry(entry)

    assert "release_date" not in hydrated


def test_queued_cache_update_never_rebases_authoritative_cover_fields():
    track_path = "C:/Music/Kaipa/Kaipa/song.mp3"
    baseline_entry = {
        "path": track_path,
        "title": "Old Title",
        **{
            field: f"baseline-{field}"
            for field in cache_module._AUTHORITATIVE_COVER_FIELDS
        },
    }
    queued_entry = {
        "path": track_path,
        "title": "New Title",
        **{
            field: f"queued-{field}"
            for field in cache_module._AUTHORITATIVE_COVER_FIELDS
        },
    }
    latest_entry = {
        "path": track_path,
        "title": "Old Title",
        **{
            field: f"authoritative-{field}"
            for field in cache_module._AUTHORITATIVE_COVER_FIELDS
        },
    }

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={track_path: baseline_entry},
        changed_entries={track_path: queued_entry},
        latest_file_cache={track_path: latest_entry},
    )

    assert rebased[track_path]["title"] == "New Title"
    assert {
        field: rebased[track_path][field]
        for field in cache_module._AUTHORITATIVE_COVER_FIELDS
    } == {
        field: f"authoritative-{field}"
        for field in cache_module._AUTHORITATIVE_COVER_FIELDS
    }


def test_queued_cache_update_rejects_divergent_same_field_conflict():
    track_path = "C:/Music/song.mp3"

    with pytest.raises(RuntimeError, match="title"):
        cache_module._rebase_non_cover_cache_entry_changes(
            baseline_file_cache={
                track_path: {
                    "path": track_path,
                    "title": "Old Title",
                    "play_count": 0,
                }
            },
            changed_entries={
                track_path: {
                    "path": track_path,
                    "title": "Queued Title",
                    "play_count": 1,
                }
            },
            latest_file_cache={
                track_path: {
                    "path": track_path,
                    "title": "Concurrent Title",
                    "play_count": 0,
                }
            },
        )


def test_queued_cache_update_accepts_already_committed_empty_exception_value():
    track_path = "C:/Music/song.mp3"

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "Non-album rarity",
            }
        },
        changed_entries={
            track_path: {
                "path": track_path,
                "exception_type": "",
            }
        },
        latest_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": None,
            }
        },
    )

    assert rebased[track_path]["exception_type"] == ""


def test_queued_cache_update_accepts_already_committed_empty_collection_name():
    track_path = "C:/Music/song.mp3"

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": "Custom Collection",
                "custom_collection_name": "Road trip",
            }
        },
        changed_entries={
            track_path: {
                "path": track_path,
                "exception_type": "",
                "custom_collection_name": "",
            }
        },
        latest_file_cache={
            track_path: {
                "path": track_path,
                "exception_type": None,
                "custom_collection_name": None,
            }
        },
    )

    assert rebased[track_path]["custom_collection_name"] == ""


def test_queued_cache_update_accepts_already_committed_numeric_year_value():
    track_path = "C:/Music/song.mp3"

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={
            track_path: {
                "path": track_path,
                "year": 1988,
            }
        },
        changed_entries={
            track_path: {
                "path": track_path,
                "year": "1999",
            }
        },
        latest_file_cache={
            track_path: {
                "path": track_path,
                "year": 1999,
            }
        },
    )

    assert rebased[track_path]["year"] == "1999"


def test_queued_cache_update_accepts_already_committed_numeric_track_number_value():
    track_path = "C:/Music/song.mp3"

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={
            track_path: {
                "path": track_path,
                "track_number": 14,
            }
        },
        changed_entries={
            track_path: {
                "path": track_path,
                "track_number": "4",
            }
        },
        latest_file_cache={
            track_path: {
                "path": track_path,
                "track_number": 4,
            }
        },
    )

    assert rebased[track_path]["track_number"] == "4"


def test_queued_cache_update_repeated_revision_conflict_fails_after_one_rebase(tmp_path, targeted_adapter):
    from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

    track_path = str((tmp_path / "Generated" / "Artist" / "Album" / "song.mp3").resolve())
    adapter = targeted_adapter({track_path: {"path": track_path, "play_count": 0, "library_root_id": "main"}})

    def commit_cover_after_every_load(store):
        store.cover_mutation_revision += 1

    adapter.after_load = commit_cover_after_every_load

    with pytest.raises(ScanCachePublicationSuperseded, match="forced queued-writer conflict 2"):
        cache_module.save_cache_updates_to_disk_for_config(
            _POSTGRES_CONFIG,
            {track_path: {"path": track_path, "play_count": 1, "library_root_id": "main"}},
        )

    assert len(adapter.loaded_paths) == 2
    assert len(adapter.publications) == 2
    assert adapter.file_cache[track_path]["play_count"] == 0
    assert targeted_adapter.installed["refreshes"] == 0


class _HeldExecutor:
    """Holds submitted publications until the test runs them."""

    def __init__(self):
        self.submitted = []

    def submit(self, callback, *args, **kwargs):
        self.submitted.append((callback, args, kwargs))

    def run_all(self) -> int:
        ran = 0
        while self.submitted:
            callback, args, kwargs = self.submitted.pop(0)
            callback(*args, **kwargs)
            ran += 1
        return ran


@pytest.fixture
def held_executor(monkeypatch):
    executor = _HeldExecutor()
    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", executor)
    monkeypatch.setattr(cache_module, "_RUNNING_CACHE_UPDATES", set())
    monkeypatch.setattr(cache_module, "_TRAILING_CACHE_UPDATES", {})
    return executor


def test_scheduled_cache_update_rebases_onto_a_cover_committed_before_the_worker_starts(
    tmp_path, targeted_adapter, held_executor,
):
    track_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "song.mp3").resolve())
    stale_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "Art" / "Back.jpg").resolve())
    selected_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "cover.jpg").resolve())
    stale_entry = {
        "path": track_path, "cover_path": stale_cover_path, "cover_revision": "stale-revision",
        "play_count": 0, "library_root_id": "main",
    }
    adapter = targeted_adapter({track_path: stale_entry})

    future = cache_module.schedule_cache_updates_save_for_config(
        _POSTGRES_CONFIG, {track_path: {**stale_entry, "play_count": 1}},
    )

    # With no request baseline, the enqueue loads only the changed entry.
    assert adapter.loaded_paths == [{track_path}]
    assert not future.done()
    adapter.cover_mutation_revision = 1
    adapter.file_cache[track_path].update({"cover_path": selected_cover_path, "cover_revision": "selected-revision"})
    assert held_executor.run_all() == 1

    assert future.result()["projection_mode"] == "stale"
    assert [publication["expected_revisions"] for publication in adapter.publications] == [(1, 0)]
    final_entry = adapter.file_cache[track_path]
    assert final_entry["cover_path"] == selected_cover_path
    assert final_entry["cover_revision"] == "selected-revision"
    assert final_entry["play_count"] == 1


def test_scheduled_title_update_uses_request_baseline_when_cover_changed_before_enqueue(
    tmp_path, targeted_adapter, held_executor,
):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    old_cover = str((tmp_path / "Artist" / "Album" / "old-cover.jpg").resolve())
    selected_cover = str((tmp_path / "Artist" / "Album" / "selected-cover.jpg").resolve())
    request_baseline = {
        track_path: {"path": track_path, "title": "Old Title", "cover_path": old_cover, "cover_revision": "old-cover"}
    }
    adapter = targeted_adapter(
        {track_path: {**request_baseline[track_path], "cover_path": selected_cover, "cover_revision": "selected-cover", "library_root_id": "main"}},
        cover_mutation_revision=1,
    )

    future = cache_module.schedule_cache_updates_save_for_config(
        _POSTGRES_CONFIG,
        {track_path: {**request_baseline[track_path], "title": "New Title"}},
        baseline_file_cache=request_baseline,
    )
    held_executor.run_all()

    assert future.exception() is None
    assert adapter.file_cache[track_path]["title"] == "New Title"
    assert adapter.file_cache[track_path]["cover_path"] == selected_cover
    assert adapter.file_cache[track_path]["cover_revision"] == "selected-cover"


def test_scheduled_cache_delta_preserves_structural_inventory_changed_before_worker_starts(
    tmp_path, targeted_adapter, held_executor,
):
    track_path = str((tmp_path / "Artist" / "Old Album" / "song.mp3").resolve())
    entry = {"path": track_path, "album": "Old Album", "album_artist": "Artist", "title": "Song", "play_count": 0, "library_root_id": "main"}
    adapter = targeted_adapter({track_path: entry})

    future = cache_module.schedule_cache_updates_save_for_config(
        _POSTGRES_CONFIG, {track_path: {**entry, "play_count": 1}},
    )
    adapter.inventory_mutation_revision = 1
    adapter.file_cache[track_path]["album"] = "Renamed Album"
    held_executor.run_all()

    assert future.exception() is None
    assert adapter.file_cache[track_path]["album"] == "Renamed Album"
    assert adapter.file_cache[track_path]["album_artist"] == "Artist"
    assert adapter.file_cache[track_path]["play_count"] == 1


def test_scheduled_cache_update_runs_intent_completion_inside_the_publication_transaction(
    tmp_path, targeted_adapter, held_executor,
):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    entry = {**_cache_entry(Path(track_path)), "library_root_id": "main"}
    targeted_adapter({track_path: entry})
    completed: list[object] = []

    future = cache_module.schedule_cache_updates_save_for_config(
        _POSTGRES_CONFIG,
        {track_path: {**entry, "title": "Changed"}},
        baseline_file_cache={track_path: entry},
        before_commit=completed.append,
    )
    held_executor.run_all()

    assert future.exception() is None
    assert completed == ["transaction"]


def _rapid_title_saves(path: str, entry: dict[str, object], count: int, hooks: list[int]):
    """`count` successive title edits of one track, each derived from the last."""
    return [
        (
            {path: {**entry, "title": f"Title {index}"}},
            {path: {**entry, "title": f"Title {index - 1}" if index else entry["title"]}},
            lambda _connection, index=index: hooks.append(index),
        )
        for index in range(count)
    ]


def test_rapid_scheduled_saves_coalesce_into_one_running_and_one_trailing_publication(
    tmp_path, targeted_adapter, held_executor,
):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    entry = {**_cache_entry(Path(track_path)), "library_root_id": "main"}
    adapter = targeted_adapter({track_path: entry})
    hooks: list[int] = []
    saves = _rapid_title_saves(track_path, entry, 10, hooks)
    futures = []

    def schedule(changed, baseline, hook):
        futures.append(cache_module.schedule_cache_updates_save_for_config(
            _POSTGRES_CONFIG, changed, baseline_file_cache=baseline, before_commit=hook,
        ))

    def arrive_while_the_first_publication_runs(_store):
        adapter.after_load = None
        for save in saves[1:]:
            schedule(*save)

    schedule(*saves[0])
    adapter.after_load = arrive_while_the_first_publication_runs

    assert len(held_executor.submitted) == 1
    assert held_executor.run_all() == 2
    assert len(adapter.publications) == 2
    # Each save is acknowledged only once its own entries commit.
    assert all(future.result()["projection_mode"] == "stale" for future in futures)
    assert hooks == list(range(10))
    assert adapter.file_cache[track_path]["title"] == "Title 9"
    assert adapter.inventory_mutation_revision == 2


def test_a_failing_save_in_a_trailing_batch_does_not_fail_the_saves_merged_with_it(
    tmp_path, targeted_adapter, held_executor,
):
    first_path = str((tmp_path / "Artist" / "Album" / "01.mp3").resolve())
    second_path = str((tmp_path / "Artist" / "Album" / "02.mp3").resolve())
    first_entry = {**_cache_entry(Path(first_path)), "library_root_id": "main"}
    second_entry = {**_cache_entry(Path(second_path)), "library_root_id": "main"}
    adapter = targeted_adapter({first_path: first_entry, second_path: second_entry})

    def schedule(path, changed, baseline, hook=None):
        return cache_module.schedule_cache_updates_save_for_config(
            _POSTGRES_CONFIG, {path: changed}, baseline_file_cache={path: baseline}, before_commit=hook,
        )

    def failing_hook(_connection):
        raise RuntimeError("intent completion failed")

    running = schedule(first_path, {**first_entry, "title": "Running"}, first_entry)
    failing = schedule(first_path, {**first_entry, "title": "Failing"}, {**first_entry, "title": "Running"}, failing_hook)
    merged = schedule(second_path, {**second_entry, "title": "Merged"}, second_entry)
    held_executor.run_all()

    assert running.exception() is None
    assert str(failing.exception()) == "intent completion failed"
    assert merged.exception() is None
    assert adapter.file_cache[first_path]["title"] == "Running"
    assert adapter.file_cache[second_path]["title"] == "Merged"


def test_cache_delta_rebase_preserves_newer_inventory_removal():
    path = "C:/Music/Artist/Album/song.mp3"
    baseline_entry = {"path": path, "title": "Old title"}

    rebased = cache_module._rebase_non_cover_cache_entry_changes(
        baseline_file_cache={path: baseline_entry},
        changed_entries={path: {**baseline_entry, "title": "New title"}},
        latest_file_cache={},
    )

    assert rebased == {}


def test_runtime_cover_selection_uses_targeted_postgres_mutation_without_republishing_snapshot(
    tmp_path,
    monkeypatch,
):
    track_path = (tmp_path / "Artist" / "Album" / "song.mp3").resolve()
    cover_path = track_path.parent / "cover.jpg"
    adapter_calls: list[dict[str, object]] = []

    class FakePostgresScanCacheAdapter:
        def persist_cover_selection(self, *, track_paths, selected_cover_path):
            adapter_calls.append(
                {
                    "track_paths": set(track_paths),
                    "selected_cover_path": selected_cover_path,
                }
            )
            return {"album_rows_updated": 1, "track_file_rows_updated": 1}

        def load_snapshot(self, *_args, **_kwargs):
            pytest.fail("interactive cover selection must not reload the whole scan snapshot")

        def save_snapshot(self, *_args, **_kwargs):
            pytest.fail("interactive cover selection must not republish the whole scan snapshot")

    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: FakePostgresScanCacheAdapter(),
    )
    persist_cover_selection = getattr(
        cache_module,
        "persist_cover_selection_for_tracks_for_config",
        None,
    )

    assert callable(persist_cover_selection), (
        "interactive cover selection requires a targeted synchronous Postgres persistence seam"
    )
    result = persist_cover_selection(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        {str(track_path)},
        cover_path,
    )

    assert result == {"album_rows_updated": 1, "track_file_rows_updated": 1}
    assert adapter_calls == [
        {
            "track_paths": {str(track_path)},
            "selected_cover_path": cover_path,
        }
    ]


def test_runtime_cache_save_forwards_the_publication_commit_guard(
    tmp_path,
    monkeypatch,
):
    forwarded_guards: list[object] = []

    def guard(commit_action):
        return commit_action()

    class FakePostgresScanCacheAdapter:
        def save_snapshot(
            self,
            *_args,
            publication_commit_guard=None,
            **_kwargs,
        ):
            forwarded_guards.append(publication_commit_guard)

    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: FakePostgresScanCacheAdapter(),
    )

    cache_module.save_cache_to_disk_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        tmp_path / "must-not-exist.json",
        {},
        "root-1",
        123.0,
        publication_commit_guard=guard,
    )

    assert forwarded_guards == [guard]


def test_structural_tag_persistence_invalidates_utility_projections(monkeypatch):
    from music_app.services import cache as cache_module
    from music_app.services import library_browse_postgres as browse_module

    calls: list[dict[str, object]] = []

    class Adapter:
        def persist_structural_tag_edit(self, **options):
            calls.append(options)
            return {"track_rows_updated": 1}

    invalidations: list[dict[str, object]] = []
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: Adapter(),
    )
    monkeypatch.setattr(
        browse_module,
        "invalidate_postgres_utility_projection_cache",
        lambda **options: invalidations.append(options),
    )

    result = cache_module.persist_structural_tag_edit_for_config(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://runtime/library"},
        changed_paths={"track.flac"},
        previous_file_entries={"track.flac": {"album": "Before"}},
        updated_file_entries={"track.flac": {"album": "After"}},
        changed_field_names={"album"},
    )

    assert result == {"track_rows_updated": 1}
    assert calls[0]["changed_paths"] == {"track.flac"}
    assert invalidations == [
        {"database_url": "postgresql://runtime/library"}
    ]


class _Rows:
    description = ("rows",)
    rowcount = -1

    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)


class _OneAlbumLibraryDatabase:
    """Postgres double: one album of `album_paths` inside a library of
    `track_count` tracks. Targeted reads return the album's persisted rows;
    only library-wide reads (relation source rows, an unfiltered file load)
    return `track_count` rows, so any global work shows up as growth."""

    def __init__(self, *, track_count: int, entries: dict[str, dict[str, object]]):
        self.track_count = track_count
        self.entries = {path: dict(entry) for path, entry in entries.items()}
        self.inventory_mutation_revision = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def commit(self):
        pass

    def pipeline(self):
        from contextlib import nullcontext

        return nullcontext()

    def _album_rows(self, paths):
        return [
            {
                "private_path": path, "album_id": 1, "album_key": "broadcast::tender buttons",
                "album_owner_key": "broadcast", "album_title": "Tender Buttons", "album_artist": "Broadcast",
                "artist_key": "broadcast", "library_root_id": "main", "file_entry": dict(self.entries[path]),
            }
            for path in sorted(paths)
            if path in self.entries
        ]

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split()).lower()
        params = params or {}
        if "relation_locations as materialized" in text or ("{scan_cache,file_entry}" in text and set(params) == {"source"}):
            return _Rows({"private_path": f"/library/{index}.mp3"} for index in range(self.track_count))
        if "bootstrap_context_ready" in text:
            return _Rows([{"bootstrap_context_ready": 1}])
        if "update library.libraries" in text and "inventory_mutation_revision" in text:
            self.inventory_mutation_revision += 1
            return _Rows([{"inventory_mutation_revision": self.inventory_mutation_revision}])
        if "as inventory_mutation_revision" in text:
            return _Rows([{"inventory_mutation_revision": self.inventory_mutation_revision}])
        if "as cover_mutation_revision" in text:
            return _Rows([{"cover_mutation_revision": 0}])
        if "insert into library.local_track_files" in text:
            for row in params["rows"]:
                self.entries[row["private_path"]] = dict(row["metadata"]["scan_cache"]["file_entry"])
            return _Rows([])
        if "{scan_cache,file_entry}" in text:
            return _Rows(self._album_rows(params.get("paths", self.entries)))
        if "active_paths" in params:
            return _Rows(self._album_rows(params["active_paths"]))
        return _Rows([])


def test_queued_cache_update_contract_publishes_only_the_edited_album_and_coalesces_rapid_saves_at_production_track_count(
    tmp_path, monkeypatch, held_executor,
):
    from music_app.services import gallery_projection_postgres, relation_projection_builder, scan_cache_persistence
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair
    from tests.py.filesystem_operation_counting import count_filesystem_and_media
    from tests.py.test_library_route_bounded_contracts import _registered

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    current: dict[str, OperationCounts] = {}
    for module, name in (
        (scan_cache_persistence, "load_relation_source_rows_sql"),
        (scan_cache_persistence, "relation_source_fingerprint"),
        (scan_cache_persistence, "build_relation_views_from_postgres_rows"),
        (relation_projection_builder, "build_postgres_relation_views"),
    ):
        original = getattr(module, name)
        monkeypatch.setattr(module, name, lambda *args, original=original, **kwargs: (
            current["counts"].count("builder_calls"), original(*args, **kwargs))[1])
    # The background owner that rebuilds the stale relation projection.
    monkeypatch.setattr(
        gallery_projection_postgres, "schedule_gallery_projection_refresh",
        lambda _config, **_kwargs: current["counts"].count("invalidations"),
    )
    album_root = (tmp_path / "Broadcast" / "Tender Buttons").resolve()
    album = {
        str(album_root / f"{number:02d}.mp3"): {
            **_cache_entry(album_root / f"{number:02d}.mp3"),
            "album": "Tender Buttons", "album_artist": "Broadcast", "artist": "Broadcast",
            "title": f"Song {number}", "track_number": number, "library_root_id": "main",
            "library_root_category": "main",
        }
        for number in range(1, 13)
    }
    edited_path = next(iter(album))
    config = {**_POSTGRES_CONFIG, "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated.invalid/cache-save"}
    rapid_save_count = 25

    def run(track_count: int) -> OperationCounts:
        database = _OneAlbumLibraryDatabase(track_count=track_count, entries=album)
        counts = current["counts"] = OperationCounts()
        adapter = PostgresScanCacheAdapter(config, connect=lambda _url: CountingConnection(database, counts))
        monkeypatch.setattr(cache_module, "_select_runtime_scan_cache_adapter", lambda _config: adapter)
        hooks: list[int] = []
        saves = _rapid_title_saves(edited_path, album[edited_path], rapid_save_count, hooks)
        futures = []

        def schedule(changed, baseline, hook):
            futures.append(cache_module.schedule_cache_updates_save_for_config(
                config, changed, baseline_file_cache=baseline, before_commit=hook,
            ))

        with count_filesystem_and_media(monkeypatch, counts):
            schedule(*saves[0])
            original_load = adapter.load_file_entries

            def load_while_saves_arrive(paths):
                # The remaining saves arrive while the first publication runs.
                adapter.load_file_entries = original_load
                loaded = original_load(paths)
                for save in saves[1:]:
                    schedule(*save)
                return loaded

            adapter.load_file_entries = load_while_saves_arrive
            publications = held_executor.run_all()

        assert publications == 2
        counts.count("generation_changes", database.inventory_mutation_revision)
        assert all(future.result()["projection_mode"] == "stale" for future in futures)
        assert hooks == list(range(rapid_save_count))
        assert database.entries[edited_path]["title"] == f"Title {rapid_save_count - 1}"
        assert all(database.entries[path]["title"] == entry["title"] for path, entry in album.items() if path != edited_path)
        return counts

    small, production = measure_scale_pair(
        run=run, **_registered("py:services/cache.py#save_cache_updates_to_disk_for_config"),
    )
    assert small.generation_changes == production.generation_changes == 2
    assert small.sql_statements == production.sql_statements
