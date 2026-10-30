from __future__ import annotations

from collections import ChainMap
from contextlib import nullcontext
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
    TagEditRecoveryCommitIntegrityFailure,
    TagEditRecoveryCommitPending,
    _recovery_partitions,
    _resolved_recovery_entry,
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
    commit_unknown=False,
    terminal_status="completed",
    authority_error=None,
    authority_overrides=None,
    evidence_logs=None,
):
    recovery_calls = []
    effect_calls = []
    failures = []

    class IntentRepository:
        def __init__(self, _config):
            pass

        def load_unfinished_intents(self, *args, **kwargs):
            return [{"id": "intent-1", "status": "prepared", "changes": changes}]

        def claim_unfinished_intent(self, _intent_id, **_kwargs):
            return nullcontext(self.load_unfinished_intents()[0])

        def complete_in_transaction(self, *_args, **_kwargs):
            pass

        def load_intent_for_recovery(self, _intent_id, **_kwargs):
            return {
                "id": "intent-1",
                "library_root_identity": "active-root",
                "status": terminal_status,
            }

        def mark_recovery_failed(self, intent_id, error):
            failures.append((intent_id, str(error)))

    class SnapshotAdapter:
        def load_snapshot(self, _cache_path, _root_identity):
            return file_cache, None, {}, None, None

        def load_recovered_tag_edit_state(self, changed_paths):
            if authority_error is not None:
                raise authority_error
            return {
                "inventory_mutation_revision": 2,
                "file_entries": {
                    path: {**file_cache[path], **refreshed_entries[path]}
                    for path in changed_paths
                },
                "exception_overrides": {
                    path: dict((authority_overrides or {}).get(path) or {})
                    for path in changed_paths
                },
            }

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
    def persist_recovery(*_args, **kwargs):
        captured = dict(kwargs)
        captured["previous_file_entries_snapshot"] = {
            path: dict(entry)
            for path, entry in kwargs["previous_file_entries"].items()
        }
        recovery_calls.append(captured)
        result = {
            "inventory_mutation_revision": 2,
            "structural_partition_ran": bool(kwargs["structural_field_names"]),
        }
        if commit_unknown:
            raise scan_cache_persistence.RecoveredTagEditCommitUnknown(result)
        return result

    monkeypatch.setattr(
        cache,
        "persist_recovered_tag_edit_for_config",
        persist_recovery,
        raising=False,
    )
    monkeypatch.setattr(
        cache,
        "persist_structural_tag_edit_for_config",
        lambda *_args, **_kwargs: pytest.fail(
            "startup recovery used the ordinary structural writer"
        ),
    )
    monkeypatch.setattr(
        cache,
        "finalize_recovered_tag_edit_for_config",
        lambda config, *, structural_partition_ran: effect_calls.append(
            (config, structural_partition_ran)
        ),
        raising=False,
    )
    monkeypatch.setattr(
        cache,
        "save_cache_updates_to_disk_for_config",
        lambda *_args, **_kwargs: pytest.fail(
            "startup recovery used the generic snapshot writer"
        ),
    )

    runtime = SimpleNamespace(
        config={
            "CACHE_PATH": tmp_path / "inert-cache.json",
            "MUSIC_DIR": tmp_path,
        },
        logger=SimpleNamespace(
            info=lambda *_args: None,
            error=lambda *_args, **_kwargs: None,
            warning=lambda *args, **kwargs: (
                evidence_logs.append((args, kwargs))
                if evidence_logs is not None
                else None
            ),
        ),
    )
    summary = reconcile_unfinished_tag_edit_intents_on_startup(runtime)
    return summary, recovery_calls, failures, effect_calls


def test_recovery_finishes_fully_written_files_forward():
    payload = intent(
        {"album": "Old", "title": "Old title", "exception_type": "non_album_rarity"},
        {"album": "New", "title": "New title", "exception_type": ""},
    )

    summary, persisted, restored, failed = run_recovery(
        payload,
        {"album": "New", "title": "New title"},
    )

    assert summary == {
        "completed": 1,
        "rolled_back": 0,
        "reconciled_external": 0,
        "commit_pending": 0,
        "integrity_failed": 0,
        "failed": 0,
    }
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

    assert summary == {
        "completed": 0,
        "rolled_back": 0,
        "reconciled_external": 0,
        "commit_pending": 0,
        "integrity_failed": 0,
        "failed": 0,
    }
    assert calls == []


@pytest.mark.parametrize(
    ("recorded_fields", "expected"),
    [
        pytest.param({"album"}, ({"album"}, set()), id="structural"),
        pytest.param({"title"}, (set(), {"title"}), id="inventory"),
        pytest.param(
            {"artist", "album_artist", "genre"},
            ({"artist", "album_artist"}, {"genre"}),
            id="mixed",
        ),
        pytest.param(
            {"exception_type", "custom_collection_name"},
            (set(), set()),
            id="app-owned-only",
        ),
    ],
)
def test_recovery_partitions_only_supported_field_owners(recorded_fields, expected):
    structural, inventory = _recovery_partitions(recorded_fields)
    assert (set(structural), set(inventory)) == expected


@pytest.mark.parametrize(
    "recorded_fields",
    [
        pytest.param({"edition"}, id="unsupported-field"),
        pytest.param({"album", "year"}, id="unsupported-structural-combination"),
        pytest.param({"album", "metadata_schema_version"}, id="unowned-reread-field"),
    ],
)
def test_recovery_partitions_reject_unsupported_or_ambiguous_ownership(recorded_fields):
    with pytest.raises(ValueError, match="supported persistence owner"):
        _recovery_partitions(recorded_fields)


def test_recovered_entry_preserves_canonical_cover_authority():
    resolved = _resolved_recovery_entry(
        baseline_entry={
            "album": "Before",
            "cover_path": "covers/current.jpg",
            "cover_revision": "current-revision",
        },
        refreshed_entry={
            "album": "After",
            "cover_path": "covers/stale.jpg",
            "cover_revision": "stale-revision",
        },
        recorded_fields={"album"},
    )

    assert resolved == {
        "album": "After",
        "cover_path": "covers/current.jpg",
        "cover_revision": "current-revision",
    }


def test_recovered_entry_rejects_unowned_reread_drift():
    with pytest.raises(ValueError, match="unowned metadata drift.*edition"):
        _resolved_recovery_entry(
            baseline_entry={"album": "Before", "edition": ""},
            refreshed_entry={"album": "After", "edition": "Deluxe"},
            recorded_fields={"album"},
        )


def test_confirmed_lost_commit_ack_uses_targeted_authority_without_marking_failed(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")
    summary, recovery_calls, failures, effect_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: {"title": "Old"}},
        changes=[
            {
                "path": track_path,
                "old_values": {"title": "Old"},
                "requested_values": {"title": "New"},
            }
        ],
        physical_values={track_path: {"title": "New"}},
        refreshed_entries={track_path: {"title": "New"}},
        commit_unknown=True,
    )

    assert len(recovery_calls) == 1
    assert failures == []
    assert summary["completed"] == 1
    assert len(effect_calls) == 1
    assert effect_calls[0][1] is False


def test_unfinished_lost_commit_ack_stays_pending_without_marking_failed(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")
    summary, _recovery_calls, failures, effect_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: {"title": "Old"}},
        changes=[
            {
                "path": track_path,
                "old_values": {"title": "Old"},
                "requested_values": {"title": "New"},
            }
        ],
        physical_values={track_path: {"title": "New"}},
        refreshed_entries={track_path: {"title": "New"}},
        commit_unknown=True,
        terminal_status="files_verified",
    )

    assert failures == []
    assert summary["commit_pending"] == 1
    assert summary["failed"] == 0
    assert effect_calls == []


def test_lost_commit_ack_authority_read_failure_stays_pending(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")

    summary, _recovery_calls, failures, effect_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: {"title": "Old"}},
        changes=[
            {
                "path": track_path,
                "old_values": {"title": "Old"},
                "requested_values": {"title": "New"},
            }
        ],
        physical_values={track_path: {"title": "New"}},
        refreshed_entries={track_path: {"title": "New"}},
        commit_unknown=True,
        authority_error=RuntimeError("authority temporarily unavailable"),
    )

    assert failures == []
    assert summary["commit_pending"] == 1
    assert summary["failed"] == 0
    assert effect_calls == []


@pytest.mark.parametrize(
    ("error_type", "outcome"),
    [
        pytest.param(
            TagEditRecoveryCommitPending,
            "commit_pending",
            id="pending",
        ),
        pytest.param(
            TagEditRecoveryCommitIntegrityFailure,
            "integrity_failed",
            id="integrity",
        ),
    ],
)
def test_typed_commit_outcomes_emit_bounded_private_evidence_without_replay(
    error_type,
    outcome,
):
    reads = []
    failures = []
    evidence = []
    cause = ConnectionError("private database endpoint and credentials")
    error = error_type(
        "authority unavailable\nC:/private/library/" + ("sensitive" * 80)
    )
    error.__cause__ = cause

    summary = reconcile_tag_edit_intents(
        [intent({"title": "Old"}, {"title": "New"})],
        read_physical_values=lambda path, fields: (
            reads.append((path, set(fields))) or {"title": "New"}
        ),
        restore_physical_values=lambda *_args: pytest.fail(
            "typed commit outcome replayed media"
        ),
        persist_resolution=lambda **_kwargs: (_ for _ in ()).throw(error),
        mark_recovery_failed=lambda *args: failures.append(args),
        record_recovery_evidence=lambda item: evidence.append(dict(item)),
    )

    assert summary[outcome] == 1
    assert summary["failed"] == 0
    assert reads == [(PATH, {"title"})]
    assert failures == []
    assert len(evidence) == 1
    assert evidence[0]["intent_id"] == "intent-1"
    assert evidence[0]["outcome"] == outcome
    assert evidence[0]["cause_class"] == "ConnectionError"
    assert "\n" not in evidence[0]["reason"]
    assert "C:/private/library" not in evidence[0]["reason"]
    assert len(evidence[0]["reason"]) <= 160


def test_confirmed_lost_commit_ack_installs_authoritative_exception_override(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")
    file_cache = {
        track_path: {
            "path": track_path,
            "title": "Old",
            "exception_type": None,
            "custom_collection_name": None,
        }
    }

    summary, _calls, failures, _effects = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache=file_cache,
        changes=[
            {
                "path": track_path,
                "old_values": {
                    "title": "Old",
                    "exception_type": "",
                    "custom_collection_name": "",
                },
                "requested_values": {
                    "title": "New",
                    "exception_type": "Custom Collection",
                    "custom_collection_name": "Night drive",
                },
            }
        ],
        physical_values={track_path: {"title": "New"}},
        refreshed_entries={
            track_path: {
                "path": track_path,
                "title": "New",
                "exception_type": None,
                "custom_collection_name": None,
            }
        },
        commit_unknown=True,
        authority_overrides={
            track_path: {
                "exception_type": "Custom Collection",
                "custom_collection_name": "Night drive",
            }
        },
    )

    assert summary["completed"] == 1
    assert failures == []
    assert file_cache[track_path]["exception_type"] == "Custom Collection"
    assert file_cache[track_path]["custom_collection_name"] == "Night drive"


def test_startup_recovery_composes_structural_and_inventory_partitions(
    monkeypatch,
    tmp_path,
):
    track_path = str(tmp_path / "track-01.mp3")
    previous_entry = {
        "album": "Old album",
        "title": "Old title",
        "track_number": "1",
    }
    resolved_entry = {
        **previous_entry,
        "album": "New album",
        "title": "New title",
    }

    summary, recovery_calls, failures, _effect_calls = run_startup_recovery(
        monkeypatch,
        tmp_path,
        file_cache={track_path: previous_entry},
        changes=[
            {
                "path": track_path,
                "old_values": {"album": "Old album", "title": "Old title"},
                "requested_values": {"album": "New album", "title": "New title"},
            }
        ],
        physical_values={track_path: {"album": "New album", "title": "New title"}},
        refreshed_entries={
            track_path: {"album": "New album", "title": "New title"}
        },
    )

    assert summary["completed"] == 1
    assert failures == []
    assert len(recovery_calls) == 1
    call = recovery_calls[0]
    assert call["structural_field_names"] == {"album"}
    assert call["inventory_field_names"] == {"title"}
    assert call["resolved_file_entries"] == {track_path: resolved_entry}
    assert call["previous_file_entries_snapshot"] == {track_path: previous_entry}


@pytest.mark.parametrize(
    ("requested_updates", "expected_structural", "expected_inventory"),
    [
        pytest.param({"album": "New album"}, {"album"}, set(), id="album"),
        pytest.param({"year": "2025"}, {"year"}, set(), id="year"),
        pytest.param(
            {"album_artist": "New artist"},
            {"album_artist"},
            set(),
            id="album-artist",
        ),
        pytest.param(
            {"album": "New album", "album_artist": "New artist"},
            {"album", "album_artist"},
            set(),
            id="album-and-album-artist",
        ),
        pytest.param(
            {"album": "New album", "exception_type": "Non-album rarity"},
            {"album"},
            set(),
            id="album-and-exception",
        ),
        pytest.param(
            {"title": "New title", "genre": "Rock"},
            set(),
            {"title", "genre"},
            id="inventory",
        ),
    ],
)
def test_startup_recovery_dispatches_from_exact_changed_field_set(
    monkeypatch,
    tmp_path,
    requested_updates,
    expected_structural,
    expected_inventory,
):
    track_path = str(tmp_path / "track-01.mp3")
    previous_entry = {
        "album": "Old album",
        "album_artist": "Old artist",
        "year": "2024",
        "edition": "",
        "exception_type": "",
        "title": "Opening",
        "genre": "",
        "track_number": "1",
    }
    resolved_entry = {**previous_entry, **requested_updates}
    if "exception_type" in requested_updates:
        resolved_entry["custom_collection_name"] = None
    old_values = {
        field: previous_entry[field]
        for field in requested_updates
    }

    summary, recovery_calls, failures, _effect_calls = run_startup_recovery(
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
    assert failures == []
    assert len(recovery_calls) == 1
    call = recovery_calls[0]
    assert call["structural_field_names"] == expected_structural
    assert call["inventory_field_names"] == expected_inventory
    assert call["resolved_file_entries"] == {track_path: resolved_entry}
    assert call["previous_file_entries_snapshot"] == {track_path: previous_entry}
    assert callable(call["before_commit"])


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

    summary, recovery_calls, failures, _effect_calls = run_startup_recovery(
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
    assert failures == []
    assert len(recovery_calls) == 1
    assert recovery_calls[0]["changed_paths"] == {changed_path}
    assert recovery_calls[0]["previous_file_entries"] is previous_cache
    assert isinstance(recovery_calls[0]["resolved_file_entries"], ChainMap)
    assert recovery_calls[0]["resolved_file_entries"].maps[1] is previous_cache
    assert set(recovery_calls[0]["resolved_file_entries"].maps[0]) == {
        changed_path
    }
    assert recovery_calls[0]["resolved_file_entries"] == {
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
def test_startup_recovery_claims_one_intent_at_a_time_before_loading_inventory(monkeypatch, tmp_path, busy):
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
    def reconcile(_runtime, _repository, claimed, _file_cache):
        events.append(("reconcile", claimed["id"]))
        return {
            "completed": 1,
            "rolled_back": 0,
            "reconciled_external": 0,
            "commit_pending": 0,
            "integrity_failed": 0,
            "failed": 0,
        }
    monkeypatch.setattr(tag_edit_intents_postgres, "PostgresTagEditIntentRepository", Repository)
    monkeypatch.setattr(library_roots, "library_root_cache_identity", lambda _config: "root")
    monkeypatch.setattr(scan_cache_persistence, "select_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(recovery, "_reconcile_claimed_tag_edit_intent", reconcile, raising=False)
    runtime = SimpleNamespace(config={"CACHE_PATH": tmp_path / "unused"}, logger=SimpleNamespace(info=lambda *_args: None))
    summary = recovery.reconcile_unfinished_tag_edit_intents_on_startup(runtime)
    if busy:
        assert summary["completed"] == 0
        assert events == [("claim", "one"), ("release", "one"), ("claim", "two"), ("release", "two")]
    else:
        assert summary["completed"] == 2
        assert events == [("claim", "one"), ("snapshot", None), ("reconcile", "one"), ("release", "one"), ("claim", "two"), ("reconcile", "two"), ("release", "two")]
