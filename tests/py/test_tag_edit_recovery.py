from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import (
    cache,
    library_roots,
    metadata,
    gallery_projection_postgres,
    relation_projection_postgres,
    scan_cache_persistence,
    tag_edit_intents_postgres,
)
from music_app.services.tag_edit_recovery import (
    reconcile_tag_edit_intents,
    reconcile_unfinished_tag_edit_intents_on_startup,
)


PATH = "X:/SyntheticMusic/Fictional Artist/track.mp3"


def intent(old, requested, *, status="prepared"):
    return {
        "id": "intent-1",
        "status": status,
        "changes": [
            {
                "path": PATH,
                "old_values": dict(old),
                "requested_values": dict(requested),
            }
        ],
    }


def run_recovery(intent_payload, physical):
    persisted = []
    restored = []
    failed = []

    def read_values(path, fields):
        assert path == PATH
        if isinstance(physical, BaseException):
            raise physical
        return {field: physical[field] for field in fields}

    summary = reconcile_tag_edit_intents(
        [intent_payload],
        read_physical_values=read_values,
        restore_physical_values=lambda path, values: restored.append((path, dict(values))),
        persist_resolution=lambda **kwargs: persisted.append(dict(kwargs)),
        mark_recovery_failed=lambda intent_id, error: failed.append((intent_id, str(error))),
    )
    return summary, persisted, restored, failed


def run_startup_recovery(
    monkeypatch,
    tmp_path,
    *,
    file_cache,
    changes,
    physical_values,
    refreshed_entries,
    readiness_error=None,
    readiness_stage="relations",
    physical_accesses=None,
):
    structural_calls = []
    generic_calls = []

    def capture_generic_call(*args, **kwargs):
        captured_kwargs = dict(kwargs)
        captured_kwargs["baseline_file_cache"] = {
            path: dict(entry)
            for path, entry in kwargs["baseline_file_cache"].items()
        }
        generic_calls.append((args, captured_kwargs))

    class IntentRepository:
        def __init__(self, _config):
            pass

        def load_unfinished_intents(self, *args, **kwargs):
            return [{"id": "intent-1", "status": "prepared", "changes": changes}]

        def claim_unfinished_intent(self, _intent_id, **_kwargs):
            return nullcontext(self.load_unfinished_intents()[0])

        def complete_in_transaction(self, *_args, **_kwargs):
            pass

        def mark_recovery_failed(self, *_args):
            if readiness_error is None:
                raise AssertionError("startup recovery unexpectedly failed")

    class SnapshotAdapter:
        def load_snapshot(self, _cache_path, _root_identity):
            pytest.fail("Recovery must not load the full library snapshot")

        def load_file_entries(self, paths):
            return {path: dict(file_cache[path]) for path in paths if path in file_cache}

    monkeypatch.setattr(
        tag_edit_intents_postgres,
        "PostgresTagEditIntentRepository",
        IntentRepository,
    )
    monkeypatch.setattr(
        library_roots,
        "library_root_cache_identity",
        lambda _config: "active-root",
    )
    monkeypatch.setattr(
        library_roots,
        "resolve_configured_media_path",
        lambda _config, raw_path, **_kwargs: Path(raw_path),
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "select_scan_cache_adapter",
        lambda _config: SnapshotAdapter(),
    )
    def ensure_relations(*_args, **_kwargs):
        if readiness_error is not None and readiness_stage == "relations":
            raise readiness_error
        return {"ready": readiness_stage != "not_ready"}
    def initialize_gallery(*_args):
        if readiness_error is not None and readiness_stage == "gallery":
            raise readiness_error
    monkeypatch.setattr(relation_projection_postgres, "ensure_relation_projection_ready", ensure_relations)
    monkeypatch.setattr(gallery_projection_postgres, "initialize_gallery_membership", initialize_gallery)
    def read_physical(path, fields):
        if physical_accesses is not None:
            physical_accesses.append(str(path))
        return {field: physical_values[str(path)][field] for field in fields}
    monkeypatch.setattr(
        metadata,
        "read_editable_tag_values",
        read_physical,
    )
    monkeypatch.setattr(
        metadata,
        "read_metadata_for_file",
        lambda path: dict(refreshed_entries[str(path)]),
    )
    monkeypatch.setattr(
        cache,
        "persist_structural_tag_edit_for_config",
        lambda *_args, **kwargs: structural_calls.append(dict(kwargs)),
    )
    monkeypatch.setattr(
        cache,
        "save_cache_updates_to_disk_for_config",
        capture_generic_call,
    )

    runtime = SimpleNamespace(
        config={
            "CACHE_PATH": tmp_path / "inert-cache.json",
            "MUSIC_DIR": tmp_path,
        },
        logger=SimpleNamespace(info=lambda *_args: None),
    )
    summary = reconcile_unfinished_tag_edit_intents_on_startup(runtime)
    return summary, structural_calls, generic_calls


def test_recovery_finishes_fully_written_files_forward():
    payload = intent(
        {"album": "Old", "title": "Old title", "exception_type": "non_album_rarity"},
        {"album": "New", "title": "New title", "exception_type": ""},
    )

    summary, persisted, restored, failed = run_recovery(
        payload,
        {"album": "New", "title": "New title"},
    )

    assert summary == {"completed": 1, "rolled_back": 0, "reconciled_external": 0, "failed": 0}
    assert restored == []
    assert failed == []
    assert persisted == [
        {
            "intent": payload,
            "resolved_values": {PATH: {"album": "New", "title": "New title"}},
            "exception_updates": {PATH: ""},
            "status": "completed",
            "last_error": None,
        }
    ]


def test_recovery_keeps_wholly_old_files_and_rolls_back_database_state():
    payload = intent({"album": "Old"}, {"album": "New"})

    summary, persisted, restored, failed = run_recovery(payload, {"album": "Old"})

    assert summary["rolled_back"] == 1
    assert restored == []
    assert failed == []
    assert persisted[0]["resolved_values"] == {PATH: {"album": "Old"}}
    assert persisted[0]["status"] == "rolled_back"


def test_recovery_restores_mixed_old_and_requested_fields_to_old_values():
    payload = intent(
        {"album": "Old", "title": "Old title"},
        {"album": "New", "title": "New title"},
    )

    summary, persisted, restored, failed = run_recovery(
        payload,
        {"album": "New", "title": "Old title"},
    )

    assert summary["rolled_back"] == 1
    assert restored == [(PATH, {"album": "Old", "title": "Old title"})]
    assert failed == []
    assert persisted[0]["resolved_values"] == {
        PATH: {"album": "Old", "title": "Old title"}
    }
    assert persisted[0]["status"] == "rolled_back"


def test_recovery_preserves_external_value_and_repairs_postgres_to_reality():
    payload = intent(
        {"album": "Old", "exception_type": "non_album_rarity"},
        {"album": "Requested", "exception_type": ""},
    )

    summary, persisted, restored, failed = run_recovery(
        payload,
        {"album": "External editor value"},
    )

    assert summary["reconciled_external"] == 1
    assert restored == []
    assert failed == []
    assert persisted[0]["resolved_values"] == {
        PATH: {"album": "External editor value"}
    }
    assert persisted[0]["exception_updates"] == {PATH: "non_album_rarity"}
    assert persisted[0]["status"] == "reconciled_external"
    assert "external" in persisted[0]["last_error"].lower()


def test_recovery_keeps_unreadable_intent_retryable_and_continues():
    payload = intent({"album": "Old"}, {"album": "New"})

    summary, persisted, restored, failed = run_recovery(
        payload,
        FileNotFoundError(PATH),
    )

    assert summary["failed"] == 1
    assert persisted == []
    assert restored == []
    assert failed == [("intent-1", PATH)]


def test_exception_only_recovery_does_not_require_reading_the_media_file():
    payload = intent(
        {"exception_type": "non_album_rarity"},
        {"exception_type": ""},
        status="files_verified",
    )
    persisted = []

    summary = reconcile_tag_edit_intents(
        [payload],
        read_physical_values=lambda *_args: (_ for _ in ()).throw(
            AssertionError("exception-only recovery read media")
        ),
        restore_physical_values=lambda *_args: None,
        persist_resolution=lambda **kwargs: persisted.append(dict(kwargs)),
        mark_recovery_failed=lambda *_args: None,
    )

    assert summary["completed"] == 1
    assert persisted[0]["exception_updates"] == {PATH: ""}


def test_custom_collection_recovery_is_app_owned_and_does_not_read_media():
    payload = intent(
        {"exception_type": "", "custom_collection_name": ""},
        {"exception_type": "Custom Collection", "custom_collection_name": "Road trip"},
        status="files_verified",
    )
    persisted = []
    summary = reconcile_tag_edit_intents(
        [payload],
        read_physical_values=lambda *_args: pytest.fail("collection recovery read media"),
        restore_physical_values=lambda *_args: pytest.fail("collection recovery wrote media"),
        persist_resolution=lambda **kwargs: persisted.append(dict(kwargs)),
        mark_recovery_failed=lambda *_args: pytest.fail("collection recovery failed"),
    )
    assert summary["completed"] == 1
    assert persisted[0]["exception_updates"][PATH] == {
        "exception_type": "Custom Collection",
        "custom_collection_name": "Road trip",
    }


def test_terminal_intents_are_ignored_when_recovery_is_repeated():
    payload = intent({"album": "Old"}, {"album": "New"}, status="completed")
    calls = []

    summary = reconcile_tag_edit_intents(
        [payload],
        read_physical_values=lambda *_args: calls.append("read"),
        restore_physical_values=lambda *_args: calls.append("restore"),
        persist_resolution=lambda **_kwargs: calls.append("persist"),
        mark_recovery_failed=lambda *_args: calls.append("failed"),
    )

    assert summary == {"completed": 0, "rolled_back": 0, "reconciled_external": 0, "failed": 0}
    assert calls == []


@pytest.mark.parametrize("failure_stage", ["relations", "not_ready", "gallery"])
def test_startup_recovery_does_not_touch_media_before_projection_readiness(monkeypatch, tmp_path, failure_stage):
    path = str(tmp_path / 'selected.mp3')
    accesses = []
    summary, structural, generic = run_startup_recovery(
        monkeypatch, tmp_path,
        file_cache={path: {'album': 'Old'}},
        changes=[{'path': path, 'old_values': {'album': 'Old'}, 'requested_values': {'album': 'New'}}],
        physical_values={path: {'album': 'New'}}, refreshed_entries={path: {'album': 'New'}},
        readiness_error=RuntimeError('Normalized projection baseline is unavailable'),
        readiness_stage=failure_stage,
        physical_accesses=accesses,
    )
    assert summary == {'completed': 0, 'rolled_back': 0, 'reconciled_external': 0, 'failed': 1}
    assert accesses == []
    assert structural == generic == []


def test_startup_recovery_dispatches_external_identity_changes_but_not_file_statistics(monkeypatch, tmp_path):
    path = str(tmp_path / 'selected.mp3')
    before = {'title': 'Old', 'album_artist': 'Old artist', 'year': 2026, 'mtime': 1, 'size': 10}
    after = {**before, 'title': 'Requested', 'album_artist': 'External artist', 'year': 2025,
             'mtime': 2, 'size': 20, 'cover_revision': 'external'}
    summary, calls, generic = run_startup_recovery(
        monkeypatch, tmp_path, file_cache={path: before},
        changes=[{'path': path, 'old_values': {'title': 'Old'}, 'requested_values': {'title': 'Requested'}}],
        physical_values={path: {'title': 'Requested'}}, refreshed_entries={path: after},
    )
    assert summary['completed'] == 1
    assert generic == []
    assert calls[0]['changed_field_names'] == {'title', 'album_artist', 'year'}
    assert calls[0]['updated_file_entries'] == {path: after}


def test_startup_recovery_album_artist_uses_only_selected_inventory(monkeypatch, tmp_path):
    path = str(tmp_path / 'selected.mp3')
    unrelated = str(tmp_path / 'unrelated.mp3')
    previous = {'album': 'Album', 'album_artist': 'To', 'artist': 'To/Die/For'}
    summary, structural, generic = run_startup_recovery(
        monkeypatch, tmp_path,
        file_cache={path: previous, unrelated: {'album': 'Unrelated'}},
        changes=[{'path': path, 'old_values': {'album_artist': 'To'},
                  'requested_values': {'album_artist': 'To/Die/For'}}],
        physical_values={path: {'album_artist': 'To/Die/For'}},
        refreshed_entries={path: {**previous, 'album_artist': 'To/Die/For'}},
    )
    assert summary == {'completed': 1, 'rolled_back': 0, 'reconciled_external': 0, 'failed': 0}
    assert generic == []
    assert len(structural) == 1
    assert structural[0]['changed_field_names'] == {'album_artist'}
    assert structural[0]['previous_file_entries'] == {path: previous}
    assert set(structural[0]['updated_file_entries']) == {path}
    assert callable(structural[0]['before_commit'])


def test_startup_recovery_uses_scoped_persistence_for_album_and_year_change(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")
    previous_entry = {
        "album": "Old album",
        "year": "2024",
        "title": "Opening",
        "track_number": "1",
    }
    resolved_entry = {
        **previous_entry,
        "album": "New album",
        "year": "2025",
    }

    summary, structural_calls, generic_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: previous_entry},
        changes=[
            {
                "path": track_path,
                "old_values": {"album": "Old album", "year": "2024"},
                "requested_values": {"album": "New album", "year": "2025"},
            }
        ],
        physical_values={track_path: {"album": "New album", "year": "2025"}},
        refreshed_entries={
            track_path: {"album": "New album", "year": "2025", "title": "Opening"}
        },
    )

    assert summary["completed"] == 1
    assert generic_calls == []
    assert len(structural_calls) == 1
    assert structural_calls[0]["updated_file_entries"] == {track_path: resolved_entry}
    assert structural_calls[0]["previous_file_entries"] == {track_path: previous_entry}
    assert structural_calls[0]["changed_field_names"] == {"album", "year"}


@pytest.mark.parametrize(
    "requested_updates",
    [
        pytest.param({"album": "New album"}, id="album"),
        pytest.param({"year": "2025"}, id="year"),
        pytest.param(
            {"album_artist": "New artist"},
            id="album-artist",
        ),
        pytest.param({"edition": "Deluxe"}, id="edition"),
        pytest.param(
            {"album": "New album", "album_artist": "New artist"},
            id="album-and-album-artist",
        ),
        pytest.param(
            {"album": "New album", "exception_type": "Non-album rarity"},
            id="album-and-exception-targeted",
        ),
        pytest.param(
            {"year": "2025", "edition": "Deluxe"},
            id="year-and-edition",
        ),
        pytest.param({"exception_type": "Non-album rarity"}, id="exception-only"),
        pytest.param({"exception_type": "Custom Collection", "custom_collection_name": "Mix"}, id="collection"),
    ],
)
def test_startup_recovery_dispatches_from_exact_changed_field_set(
    monkeypatch,
    tmp_path,
    requested_updates,
):
    track_path = str(tmp_path / "track-01.mp3")
    previous_entry = {
        "album": "Old album",
        "album_artist": "Old artist",
        "year": "2024",
        "edition": "",
        "exception_type": "",
        "custom_collection_name": None,
        "title": "Opening",
        "track_number": "1",
    }
    resolved_entry = {**previous_entry, **requested_updates}
    old_values = {
        field: previous_entry[field]
        for field in requested_updates
    }

    summary, structural_calls, generic_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: previous_entry},
        changes=[
            {
                "path": track_path,
                "old_values": old_values,
                "requested_values": requested_updates,
            }
        ],
        physical_values={track_path: requested_updates},
        refreshed_entries={track_path: resolved_entry},
    )

    assert summary["completed"] == 1
    assert generic_calls == []
    assert len(structural_calls) == 1
    call = structural_calls[0]
    assert call["changed_field_names"] == set(requested_updates)
    assert call["updated_file_entries"] == {track_path: resolved_entry}
    assert call["previous_file_entries"] == {track_path: previous_entry}
    assert callable(call["before_commit"])
    assert call["rebuild_relation_projection"] is True


def test_startup_recovery_leaves_sibling_discovery_to_scoped_persistence_for_blank_album_change(
    monkeypatch,
    tmp_path,
):
    changed_path = str(tmp_path / "track-01.mp3")
    sibling_path = str(tmp_path / "track-02.mp3")
    previous_cache = {
        changed_path: {
            "album": "Numbered album",
            "title": "Opening",
            "track_number": "1",
        },
        sibling_path: {
            "album": "Numbered album",
            "title": "Second",
            "track_number": "2",
        },
    }
    resolved_changed_entry = {**previous_cache[changed_path], "album": ""}

    summary, structural_calls, generic_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache=previous_cache,
        changes=[
            {
                "path": changed_path,
                "old_values": {"album": "Numbered album"},
                "requested_values": {"album": ""},
            }
        ],
        physical_values={changed_path: {"album": ""}},
        refreshed_entries={
            changed_path: {
                "album": "",
                "title": "Opening",
                "track_number": "1",
            }
        },
    )

    assert summary["completed"] == 1
    assert generic_calls == []
    assert len(structural_calls) == 1
    assert structural_calls[0]["changed_paths"] == {changed_path}
    assert structural_calls[0]["updated_file_entries"] == {
        changed_path: resolved_changed_entry,
    }


def test_startup_recovery_rejects_journal_paths_outside_configured_media_roots(
    monkeypatch,
    tmp_path,
):
    configured_root = tmp_path / "media"
    configured_root.mkdir()
    outside_path = tmp_path / "outside" / "track.mp3"
    outside_path.parent.mkdir()
    outside_path.write_bytes(b"journal recovery must not read this file")
    failed = []
    load_calls = []
    metadata_calls = []

    class IntentRepository:
        def __init__(self, _config):
            pass

        def load_unfinished_intents(self, *args, **kwargs):
            load_calls.append((args, kwargs))
            self.rows = [
                {
                    "id": "intent-outside-root",
                    "library_root_identity": "active-root",
                    "status": "prepared",
                    "changes": [
                        {
                            "path": str(outside_path),
                            "old_values": {"album": "Old"},
                            "requested_values": {"album": "New"},
                        }
                    ],
                },
                {
                    "id": "intent-outside-root-exception-only",
                    "library_root_identity": "active-root",
                    "status": "prepared",
                    "changes": [
                        {
                            "path": str(outside_path),
                            "old_values": {"exception_type": ""},
                            "requested_values": {
                                "exception_type": "Non-album rarity"
                            },
                        }
                    ],
                }
            ]

            return self.rows

        def claim_unfinished_intent(self, intent_id, **_kwargs):
            return nullcontext(next(row for row in self.rows if row["id"] == intent_id))

        def mark_recovery_failed(self, intent_id, error):
            failed.append((intent_id, str(error)))

    class SnapshotAdapter:
        def load_snapshot(self, _cache_path, _root_identity):
            return {}, None, {}, None, None

    def reject_outside_path(_config, raw_path, **_kwargs):
        assert Path(raw_path) == outside_path
        return None

    def record_metadata_access(operation):
        def access(*args, **kwargs):
            metadata_calls.append((operation, args, kwargs))
            raise AssertionError(f"startup recovery attempted metadata {operation}")

        return access

    monkeypatch.setattr(
        tag_edit_intents_postgres,
        "PostgresTagEditIntentRepository",
        IntentRepository,
    )
    monkeypatch.setattr(
        library_roots,
        "library_root_cache_identity",
        lambda _config: "active-root",
    )
    monkeypatch.setattr(
        library_roots,
        "resolve_configured_media_path",
        reject_outside_path,
    )
    monkeypatch.setattr(
        scan_cache_persistence,
        "select_scan_cache_adapter",
        lambda _config: SnapshotAdapter(),
    )
    monkeypatch.setattr(
        metadata,
        "read_editable_tag_values",
        record_metadata_access("read"),
    )
    monkeypatch.setattr(
        metadata,
        "apply_text_repairs_to_file",
        record_metadata_access("restore"),
    )

    runtime = SimpleNamespace(
        config={
            "CACHE_PATH": tmp_path / "inert-cache.json",
            "MUSIC_DIR": configured_root,
        },
        logger=SimpleNamespace(info=lambda *_args: None),
    )

    summary = reconcile_unfinished_tag_edit_intents_on_startup(runtime)

    assert load_calls
    assert summary["failed"] == 2
    assert {intent_id for intent_id, _error in failed} == {
        "intent-outside-root",
        "intent-outside-root-exception-only",
    }
    assert all(
        "not one configured existing media file" in error
        for _intent_id, error in failed
    )
    assert metadata_calls == []


@pytest.mark.parametrize("busy", [True, False])
def test_startup_recovery_claims_one_intent_at_a_time_before_reconciling(monkeypatch, tmp_path, busy):
    from contextlib import contextmanager
    from music_app.services import tag_edit_recovery as recovery
    events = []
    class Repository:
        def __init__(self, _config):
            pass
        def load_unfinished_intents(self, **_kwargs):
            return [{"id": "one"}, {"id": "two"}]
        @contextmanager
        def claim_unfinished_intent(self, intent_id, **_kwargs):
            events.append(("claim", intent_id))
            try:
                yield None if busy else {"id": intent_id}
            finally:
                events.append(("release", intent_id))
    class Adapter:
        def load_snapshot(self, *_args):
            events.append(("snapshot", None))
            return {}, None, {}, None, None
    def reconcile(_runtime, _repository, claimed, *, before_recovery):
        before_recovery()
        events.append(("reconcile", claimed["id"]))
        return {"completed": 1, "rolled_back": 0, "reconciled_external": 0, "failed": 0}
    monkeypatch.setattr(tag_edit_intents_postgres, "PostgresTagEditIntentRepository", Repository)
    monkeypatch.setattr(library_roots, "library_root_cache_identity", lambda _config: "root")
    monkeypatch.setattr(scan_cache_persistence, "select_scan_cache_adapter", lambda _config: Adapter())
    def ensure_relations(*_args, **_kwargs):
        events.append(("relations", None))
        return {"ready": True}
    monkeypatch.setattr(relation_projection_postgres, "ensure_relation_projection_ready", ensure_relations)
    monkeypatch.setattr(gallery_projection_postgres, "initialize_gallery_membership", lambda *_args: events.append(("gallery", None)))
    monkeypatch.setattr(recovery, "_reconcile_claimed_tag_edit_intent", reconcile, raising=False)
    runtime = SimpleNamespace(config={"CACHE_PATH": tmp_path / "unused"}, logger=SimpleNamespace(info=lambda *_args: None))
    summary = recovery.reconcile_unfinished_tag_edit_intents_on_startup(runtime)
    if busy:
        assert summary["completed"] == 0
        assert events == [("claim", "one"), ("release", "one"), ("claim", "two"), ("release", "two")]
    else:
        assert summary["completed"] == 2
        assert events == [("claim", "one"), ("relations", None), ("gallery", None), ("reconcile", "one"), ("release", "one"), ("claim", "two"), ("reconcile", "two"), ("release", "two")]
