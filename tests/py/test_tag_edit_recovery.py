from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import (
    cache,
    library_roots,
    metadata,
    scan_cache_persistence,
    tag_edit_intents_postgres,
)
from music_app.services.tag_edit_recovery import (
    _recovery_structural_field,
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

        def complete_in_transaction(self, *_args, **_kwargs):
            pass

        def mark_recovery_failed(self, *_args):
            raise AssertionError("startup recovery unexpectedly failed")

    class SnapshotAdapter:
        def load_snapshot(self, _cache_path, _root_identity):
            return file_cache, None, {}, None, None

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
    monkeypatch.setattr(
        metadata,
        "read_editable_tag_values",
        lambda path, fields: {
            field: physical_values[str(path)][field] for field in fields
        },
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


def test_recovery_routes_album_changes_through_structural_persistence():
    assert _recovery_structural_field(
        previous_entries={PATH: {"album": "Old", "year": 2026}},
        updated_entries={PATH: {"album": "New", "year": 2026}},
    ) == "album"


def test_recovery_keeps_exception_only_changes_on_generic_persistence():
    assert _recovery_structural_field(
        previous_entries={PATH: {"album": "Old", "exception_type": ""}},
        updated_entries={
            PATH: {"album": "Old", "exception_type": "Non-album rarity"},
        },
    ) == ""


def test_startup_recovery_uses_generic_persistence_for_album_and_year_change(
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
    assert structural_calls == []
    assert len(generic_calls) == 1
    args, kwargs = generic_calls[0]
    assert args[2] == {track_path: resolved_entry}
    assert kwargs["baseline_file_cache"] == {track_path: previous_entry}


@pytest.mark.parametrize(
    ("requested_updates", "expected_targeted_field"),
    [
        pytest.param({"album": "New album"}, "album", id="album-only-targeted"),
        pytest.param({"year": "2025"}, "year", id="year-only-targeted"),
        pytest.param(
            {"album_artist": "New artist"},
            None,
            id="album-artist-only-generic",
        ),
        pytest.param({"edition": "Deluxe"}, None, id="edition-only-generic"),
        pytest.param(
            {"album": "New album", "album_artist": "New artist"},
            None,
            id="album-and-album-artist-generic",
        ),
        pytest.param(
            {"year": "2025", "edition": "Deluxe"},
            None,
            id="year-and-edition-generic",
        ),
    ],
)
def test_startup_recovery_dispatches_from_exact_changed_field_set(
    monkeypatch,
    tmp_path,
    requested_updates,
    expected_targeted_field,
):
    track_path = str(tmp_path / "track-01.mp3")
    previous_entry = {
        "album": "Old album",
        "album_artist": "Old artist",
        "year": "2024",
        "edition": "",
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
    if expected_targeted_field is not None:
        assert generic_calls == []
        assert len(structural_calls) == 1
        call = structural_calls[0]
        assert call["changed_field_names"] == {expected_targeted_field}
    else:
        assert structural_calls == []
        assert len(generic_calls) == 1
        args, call = generic_calls[0]
        assert args[2] == {track_path: resolved_entry}
        assert call["baseline_file_cache"] == {track_path: previous_entry}
    assert callable(call["before_commit"])
    assert call["rebuild_relation_projection"] is True


def test_startup_recovery_passes_merged_inventory_for_blank_album_change(
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
        sibling_path: previous_cache[sibling_path],
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
            return [
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
