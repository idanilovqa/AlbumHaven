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


def test_runtime_cache_update_merges_postgres_snapshot_and_propagates_write_contract(
    tmp_path,
    monkeypatch,
):
    cache_path = tmp_path / "library_cache.json"
    existing_track = tmp_path / "existing.mp3"
    changed_track = tmp_path / "changed.mp3"
    config = {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}}
    saved_snapshots: list[dict[str, object]] = []

    class FakePostgresScanCacheAdapter:
        def load_cover_mutation_revision(self):
            return 17

        def load_snapshot(self, received_cache_path, received_root_identity):
            assert received_cache_path == cache_path
            assert received_root_identity == "root-1"
            return (
                {str(existing_track): _cache_entry(existing_track)},
                123.0,
                {"artists": ["Artist"]},
                456.0,
                None,
            )

        def save_snapshot(
            self,
            received_cache_path,
            file_cache,
            received_root_identity,
            last_scan,
            *,
            relation_views=None,
            relations_last_built=None,
            expected_cover_mutation_revision=None,
        ):
            saved_snapshots.append(
                {
                    "cache_path": received_cache_path,
                    "file_cache": dict(file_cache),
                    "root_identity": received_root_identity,
                    "last_scan": last_scan,
                    "relation_views": relation_views,
                    "relations_last_built": relations_last_built,
                    "expected_cover_mutation_revision": expected_cover_mutation_revision,
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
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda received_config: (
            "root-1"
            if received_config is config
            else pytest.fail("runtime config was not forwarded")
        ),
    )

    cache_module.save_cache_updates_to_disk_for_config(
        config,
        cache_path,
        {str(changed_track): _cache_entry(changed_track)},
    )

    assert saved_snapshots == [
        {
            "cache_path": cache_path,
            "file_cache": {
                str(existing_track): _cache_entry(existing_track),
                str(changed_track): _cache_entry(changed_track),
            },
            "root_identity": "root-1",
            "last_scan": 123.0,
            "relation_views": {"artists": ["Artist"]},
            "relations_last_built": 456.0,
            "expected_cover_mutation_revision": 17,
        }
    ]
    assert not cache_path.exists()


def test_runtime_cache_update_propagates_postgres_snapshot_error(tmp_path, monkeypatch):
    class FailingPostgresScanCacheAdapter:
        def load_cover_mutation_revision(self):
            return 23

        def load_snapshot(self, *_args):
            return {}, 0.0, {}, 0.0, "Postgres snapshot unavailable"

    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: FailingPostgresScanCacheAdapter(),
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "root-1",
    )

    with pytest.raises(RuntimeError, match="Postgres snapshot unavailable"):
        cache_module.save_cache_updates_to_disk_for_config(
            {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
            tmp_path / "must-not-exist.json",
            {str(tmp_path / "track.mp3"): _cache_entry(tmp_path / "track.mp3")},
        )

    assert not (tmp_path / "must-not-exist.json").exists()


def test_queued_title_update_preserves_newer_authoritative_cover(tmp_path, monkeypatch):
    from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

    cache_path = tmp_path / "unused.json"
    track_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "song.mp3").resolve())
    stale_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "Art" / "Back.jpg").resolve())
    incidental_queued_cover_path = str(
        (
            tmp_path
            / "Generated"
            / "Kaipa"
            / "Kaipa"
            / "Art"
            / "Incidental.jpg"
        ).resolve()
    )
    selected_cover_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "cover.jpg").resolve())
    store = {
        "cover_mutation_revision": 0,
        "file_cache": {
            track_path: {
                "path": track_path,
                "cover_path": stale_cover_path,
                "cover_revision": "stale-revision",
                "title": "Old Title",
                "play_count": 0,
            }
        },
    }
    events: list[str] = []
    load_calls = 0
    save_calls = 0

    class InterleavedPostgresScanCacheAdapter:
        def load_cover_mutation_revision(self):
            events.append("revision-loaded")
            return store["cover_mutation_revision"]

        def load_snapshot(self, _cache_path, _root_identity):
            nonlocal load_calls
            load_calls += 1
            events.append(f"snapshot-loaded-{load_calls}")
            captured = {
                path: dict(entry)
                for path, entry in store["file_cache"].items()
            }
            if load_calls == 1:
                store["cover_mutation_revision"] = 1
                store["file_cache"][track_path].update(
                    {
                        "cover_path": selected_cover_path,
                        "cover_revision": "selected-revision",
                    }
                )
                events.append("authoritative-cover-committed")
            return captured, 123.0, {"artists": ["Kaipa"]}, 456.0, None

        def save_snapshot(
            self,
            _cache_path,
            file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            **_kwargs,
        ):
            nonlocal save_calls
            save_calls += 1
            events.append(f"queued-writer-save-attempted-{save_calls}")
            if (
                expected_cover_mutation_revision is not None
                and expected_cover_mutation_revision != store["cover_mutation_revision"]
            ):
                raise ScanCachePublicationSuperseded(
                    "Cover mutation advanced after queued update snapshot capture."
                )
            store["file_cache"] = {
                path: dict(entry)
                for path, entry in file_cache.items()
            }

    adapter = InterleavedPostgresScanCacheAdapter()
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: adapter,
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "generated-root",
    )
    queued_entry = {
        "path": track_path,
        "cover_path": incidental_queued_cover_path,
        "cover_revision": "incidental-queued-revision",
        "title": "New Title",
        "play_count": 1,
    }

    cache_module.save_cache_updates_to_disk_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        cache_path,
        {track_path: queued_entry},
    )

    final_entry = store["file_cache"][track_path]
    assert final_entry["cover_path"] == selected_cover_path
    assert final_entry["cover_revision"] == "selected-revision"
    assert final_entry["title"] == "New Title"
    assert final_entry["play_count"] == 1
    assert load_calls == 2
    assert save_calls == 2
    assert events.index("snapshot-loaded-1") < events.index("authoritative-cover-committed")
    assert events.index("authoritative-cover-committed") < events.index(
        "queued-writer-save-attempted-1"
    )
    assert events.index("queued-writer-save-attempted-1") < events.index(
        "snapshot-loaded-2"
    )
    assert events.index("snapshot-loaded-2") < events.index(
        "queued-writer-save-attempted-2"
    )


def test_file_entry_cache_round_trip_preserves_metadata_and_cover_validation_signature(tmp_path):
    cover_path = tmp_path / "Artist" / "Album" / "cover.jpg"
    entry = {
        **_cache_entry(tmp_path / "Artist" / "Album" / "01 - Song.mp3"),
        "genre": "Progressive Rock",
        "release_date": "2004-07-16",
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


def test_queued_cache_update_repeated_revision_conflict_fails_after_one_rebase(
    tmp_path,
    monkeypatch,
):
    from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

    track_path = str((tmp_path / "Generated" / "Artist" / "Album" / "song.mp3").resolve())
    store = {
        "cover_mutation_revision": 0,
        "file_cache": {
            track_path: {
                "path": track_path,
                "cover_path": str(tmp_path / "Generated" / "Artist" / "Album" / "cover.jpg"),
                "cover_revision": "selected-revision",
                "play_count": 0,
            }
        },
    }
    load_calls = 0
    save_calls = 0

    class RepeatedConflictAdapter:
        def load_cover_mutation_revision(self):
            return store["cover_mutation_revision"]

        def load_snapshot(self, _cache_path, _root_identity):
            nonlocal load_calls
            load_calls += 1
            return (
                {path: dict(entry) for path, entry in store["file_cache"].items()},
                123.0,
                {},
                0.0,
                None,
            )

        def save_snapshot(
            self,
            _cache_path,
            _file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            **_kwargs,
        ):
            nonlocal save_calls
            save_calls += 1
            store["cover_mutation_revision"] += 1
            assert expected_cover_mutation_revision < store["cover_mutation_revision"]
            raise ScanCachePublicationSuperseded(
                f"forced queued-writer conflict {save_calls}"
            )

    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: RepeatedConflictAdapter(),
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "generated-root",
    )

    with pytest.raises(
        ScanCachePublicationSuperseded,
        match="forced queued-writer conflict 2",
    ):
        cache_module.save_cache_updates_to_disk_for_config(
            {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
            tmp_path / "unused.json",
            {
                track_path: {
                    **store["file_cache"][track_path],
                    "play_count": 1,
                }
            },
        )

    assert load_calls == 2
    assert save_calls == 2
    assert store["file_cache"][track_path]["play_count"] == 0


def test_scheduled_cache_update_captures_revision_before_delayed_worker_starts(
    tmp_path,
    monkeypatch,
):
    from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

    track_path = str((tmp_path / "Generated" / "Kaipa" / "Kaipa" / "song.mp3").resolve())
    stale_cover_path = str(
        (tmp_path / "Generated" / "Kaipa" / "Kaipa" / "Art" / "Back.jpg").resolve()
    )
    selected_cover_path = str(
        (tmp_path / "Generated" / "Kaipa" / "Kaipa" / "cover.jpg").resolve()
    )
    store = {
        "cover_mutation_revision": 0,
        "file_cache": {
            track_path: {
                "path": track_path,
                "cover_path": stale_cover_path,
                "cover_revision": "stale-revision",
                "play_count": 0,
            }
        },
    }
    execution_stage = "enqueue"
    revision_observations: list[tuple[str, int]] = []
    save_revisions: list[int | None] = []
    delayed_jobs: list[tuple[object, tuple[object, ...], dict[str, object]]] = []

    class DelayedFuture:
        def __init__(self):
            self.callbacks = []

        def add_done_callback(self, callback):
            self.callbacks.append(callback)

    submitted_future = DelayedFuture()

    class DelayedExecutor:
        def submit(self, callback, *args, **kwargs):
            delayed_jobs.append((callback, args, kwargs))
            return submitted_future

    class QueueBoundaryAdapter:
        def load_cover_mutation_revision(self):
            revision = store["cover_mutation_revision"]
            revision_observations.append((execution_stage, revision))
            return revision

        def load_snapshot(self, _cache_path, _root_identity):
            return (
                {path: dict(entry) for path, entry in store["file_cache"].items()},
                123.0,
                {"artists": ["Kaipa"]},
                456.0,
                None,
            )

        def save_snapshot(
            self,
            _cache_path,
            file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            **_kwargs,
        ):
            save_revisions.append(expected_cover_mutation_revision)
            if expected_cover_mutation_revision != store["cover_mutation_revision"]:
                raise ScanCachePublicationSuperseded(
                    "Delayed queued writer observed a newer cover mutation."
                )
            store["file_cache"] = {
                path: dict(entry)
                for path, entry in file_cache.items()
            }

    adapter = QueueBoundaryAdapter()
    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", DelayedExecutor())
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: adapter,
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "generated-root",
    )
    stale_queued_entry = {
        "path": track_path,
        "cover_path": stale_cover_path,
        "cover_revision": "stale-revision",
        "play_count": 1,
    }

    returned_future = cache_module.schedule_cache_updates_save_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        tmp_path / "unused.json",
        {track_path: stale_queued_entry},
    )

    assert returned_future is submitted_future
    assert len(delayed_jobs) == 1
    assert revision_observations == [("enqueue", 0)]
    store["cover_mutation_revision"] = 1
    store["file_cache"][track_path].update(
        {
            "cover_path": selected_cover_path,
            "cover_revision": "selected-revision",
        }
    )
    execution_stage = "worker"
    callback, args, kwargs = delayed_jobs[0]
    callback(*args, **kwargs)

    final_entry = store["file_cache"][track_path]
    assert revision_observations == [("enqueue", 0), ("worker", 1)]
    assert save_revisions == [0, 1]
    assert final_entry["cover_path"] == selected_cover_path
    assert final_entry["cover_revision"] == "selected-revision"
    assert final_entry["play_count"] == 1


def test_scheduled_title_update_uses_request_baseline_when_cover_changed_before_enqueue(
    tmp_path,
    monkeypatch,
):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    old_cover = str((tmp_path / "Artist" / "Album" / "old-cover.jpg").resolve())
    selected_cover = str(
        (tmp_path / "Artist" / "Album" / "selected-cover.jpg").resolve()
    )
    request_baseline = {
        track_path: {
            "path": track_path,
            "title": "Old Title",
            "cover_path": old_cover,
            "cover_revision": "old-cover",
        }
    }
    store = {
        "cover_mutation_revision": 1,
        "file_cache": {
            track_path: {
                **request_baseline[track_path],
                "cover_path": selected_cover,
                "cover_revision": "selected-cover",
            }
        },
    }

    class CompletedFuture:
        def add_done_callback(self, callback):
            callback(self)

        def exception(self):
            return None

    class ImmediateExecutor:
        def submit(self, callback, *args, **kwargs):
            callback(*args, **kwargs)
            return CompletedFuture()

    class Adapter:
        def load_cover_mutation_revision(self):
            return store["cover_mutation_revision"]

        def load_snapshot(self, _cache_path, _root_identity):
            return (
                {
                    path: dict(entry)
                    for path, entry in store["file_cache"].items()
                },
                1.0,
                {},
                0.0,
                None,
            )

        def save_snapshot(
            self,
            _cache_path,
            file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            **_kwargs,
        ):
            assert (
                expected_cover_mutation_revision
                == store["cover_mutation_revision"]
            )
            store["file_cache"] = {
                path: dict(entry)
                for path, entry in file_cache.items()
            }

    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", ImmediateExecutor())
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: Adapter(),
    )
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "root",
    )

    cache_module.schedule_cache_updates_save_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        tmp_path / "unused.json",
        {
            track_path: {
                **request_baseline[track_path],
                "title": "New Title",
            }
        },
        baseline_file_cache=request_baseline,
    )

    assert store["file_cache"][track_path]["title"] == "New Title"
    assert store["file_cache"][track_path]["cover_path"] == selected_cover
    assert store["file_cache"][track_path]["cover_revision"] == "selected-cover"


def test_scheduled_cache_delta_preserves_structural_inventory_changed_before_worker_starts(
    tmp_path,
    monkeypatch,
):
    from music_app.services.scan_cache_persistence import ScanCachePublicationSuperseded

    track_path = str((tmp_path / "Artist" / "Old Album" / "song.mp3").resolve())
    store = {
        "cover_mutation_revision": 0,
        "inventory_mutation_revision": 0,
        "file_cache": {
            track_path: {
                "path": track_path,
                "album": "Old Album",
                "album_artist": "Artist",
                "title": "Song",
                "play_count": 0,
            }
        },
    }
    delayed_jobs = []

    class DelayedFuture:
        def add_done_callback(self, _callback):
            return None

    class DelayedExecutor:
        def submit(self, callback, *args, **kwargs):
            delayed_jobs.append((callback, args, kwargs))
            return DelayedFuture()

    class Adapter:
        def load_cover_mutation_revision(self):
            return store["cover_mutation_revision"]

        def load_inventory_mutation_revision(self):
            return store["inventory_mutation_revision"]

        def load_snapshot(self, _cache_path, _root_identity):
            return (
                {path: dict(entry) for path, entry in store["file_cache"].items()},
                1.0,
                {},
                0.0,
                None,
            )

        def save_snapshot(
            self,
            _cache_path,
            file_cache,
            _root_identity,
            _last_scan,
            *,
            expected_cover_mutation_revision=None,
            expected_inventory_mutation_revision=None,
            **_kwargs,
        ):
            if (
                expected_cover_mutation_revision != store["cover_mutation_revision"]
                or expected_inventory_mutation_revision
                != store["inventory_mutation_revision"]
            ):
                raise ScanCachePublicationSuperseded("inventory advanced")
            store["file_cache"] = {
                path: dict(entry) for path, entry in file_cache.items()
            }

    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", DelayedExecutor())
    monkeypatch.setattr(cache_module, "_select_runtime_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "root",
    )

    cache_module.schedule_cache_updates_save_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        tmp_path / "unused.json",
        {
            track_path: {
                **store["file_cache"][track_path],
                "play_count": 1,
            }
        },
    )

    store["inventory_mutation_revision"] = 1
    store["file_cache"][track_path]["album"] = "Renamed Album"
    callback, args, kwargs = delayed_jobs[0]
    callback(*args, **kwargs)

    assert store["file_cache"][track_path]["album"] == "Renamed Album"
    assert store["file_cache"][track_path]["album_artist"] == "Artist"
    assert store["file_cache"][track_path]["play_count"] == 1


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


def test_scheduled_cache_update_forwards_intent_completion_to_snapshot_transaction(
    tmp_path,
    monkeypatch,
):
    track_path = str((tmp_path / "Artist" / "Album" / "song.mp3").resolve())
    entry = _cache_entry(Path(track_path))
    before_commit = object()
    observed: list[object] = []

    class CompletedFuture:
        def add_done_callback(self, callback):
            callback(self)

        def exception(self):
            return None

        def result(self):
            return None

    class ImmediateExecutor:
        def submit(self, callback, *args, **kwargs):
            callback(*args, **kwargs)
            return CompletedFuture()

    class Adapter:
        def load_cover_mutation_revision(self):
            return 0

        def load_inventory_mutation_revision(self):
            return 0

        def load_snapshot(self, _cache_path, _root_identity):
            return ({track_path: dict(entry)}, 1.0, {}, 0.0, None)

        def save_snapshot(self, *_args, **kwargs):
            observed.append(kwargs.get("before_commit"))

    monkeypatch.setattr(cache_module, "_CACHE_WRITE_EXECUTOR", ImmediateExecutor())
    monkeypatch.setattr(cache_module, "_select_runtime_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(
        "music_app.services.library_roots.library_root_cache_identity",
        lambda _config: "root",
    )

    cache_module.schedule_cache_updates_save_for_config(
        {"PERSISTENCE_BACKENDS": {"scan_cache": PERSISTENCE_BACKEND_POSTGRES}},
        tmp_path / "unused.json",
        {track_path: {**entry, "title": "Changed"}},
        baseline_file_cache={track_path: entry},
        before_commit=before_commit,
    )

    assert observed == [before_commit]


def test_runtime_cache_save_forwards_explicit_scan_rating_seed_intent(
    tmp_path,
    monkeypatch,
):
    seed_intents: list[bool] = []

    class FakePostgresScanCacheAdapter:
        def save_snapshot(
            self,
            *_args,
            seed_missing_album_ratings=False,
            **_kwargs,
        ):
            seed_intents.append(seed_missing_album_ratings)

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
        seed_missing_album_ratings=True,
    )

    assert seed_intents == [True]
