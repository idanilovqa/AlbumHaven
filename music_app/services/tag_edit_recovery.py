from __future__ import annotations

from collections import ChainMap
from collections.abc import Callable, Mapping
from pathlib import Path


_UNFINISHED_STATUSES = frozenset({"prepared", "files_verified", "recovery_failed"})
_APP_OWNED_FIELDS = frozenset({"exception_type", "custom_collection_name"})
_CANONICAL_COVER_FIELDS = frozenset(
    {
        "cover_path",
        "cover_revision",
        "cover_selection_origin",
        "cover_selection_provenance",
        "local_cover_width",
        "local_cover_height",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    }
)
_INVENTORY_FIELDS = frozenset({"title", "genre", "track_number", "disc_number"})
_STRUCTURAL_FIELD_SETS = frozenset(
    {
        frozenset({"album"}),
        frozenset({"artist"}),
        frozenset({"album_artist"}),
        frozenset({"artist", "album_artist"}),
        frozenset({"album", "artist"}),
        frozenset({"album", "album_artist"}),
        frozenset({"album", "artist", "album_artist"}),
        frozenset({"year"}),
    }
)


class TagEditRecoveryCommitPending(RuntimeError):
    """Commit acknowledgement is unknown and authority is not yet decisive."""


class TagEditRecoveryCommitIntegrityFailure(RuntimeError):
    """Journal and authoritative inventory contradict a possible commit."""


def reconcile_tag_edit_intents(
    intents: list[dict[str, object]],
    *,
    read_physical_values: Callable[[str, set[str]], dict[str, str]],
    restore_physical_values: Callable[[str, dict[str, str]], None],
    persist_resolution: Callable[..., None],
    mark_recovery_failed: Callable[[str, object], None],
    record_recovery_evidence: Callable[[Mapping[str, str]], None] | None = None,
) -> dict[str, int]:
    """Resolve unfinished intents from real files without trusting UI state."""
    summary = {
        "completed": 0,
        "rolled_back": 0,
        "reconciled_external": 0,
        "commit_pending": 0,
        "integrity_failed": 0,
        "failed": 0,
    }
    for intent in intents:
        status = str(intent.get("status") or "").strip().casefold()
        if status not in _UNFINISHED_STATUSES:
            continue
        intent_id = str(intent.get("id") or "").strip()
        try:
            changes = _normalized_changes(intent.get("changes"))
            observed: dict[str, dict[str, str]] = {}
            field_states: list[str] = []
            for change in changes:
                path = change["path"]
                old_values = change["old_values"]
                requested_values = change["requested_values"]
                physical_fields = set(requested_values).difference(
                    {"exception_type", "custom_collection_name"}
                )
                actual_values = (
                    {
                        field: _text(value)
                        for field, value in read_physical_values(
                            path,
                            physical_fields,
                        ).items()
                    }
                    if physical_fields
                    else {}
                )
                if set(actual_values) != physical_fields:
                    missing = sorted(physical_fields.difference(actual_values))
                    raise RuntimeError(
                        f"Physical tag read omitted fields for {path}: {', '.join(missing)}"
                    )
                observed[path] = actual_values
                for field in physical_fields:
                    actual = actual_values[field]
                    old = _text(old_values[field])
                    requested = _text(requested_values[field])
                    if actual == requested:
                        field_states.append("requested")
                    elif actual == old:
                        field_states.append("old")
                    else:
                        field_states.append("external")

            if "external" in field_states:
                resolution_status = "reconciled_external"
                resolved_values = observed
                exception_source = "old_values"
                last_error = (
                    "External tag values were detected during startup recovery; "
                    "Postgres was reconciled to the real files."
                )
            elif field_states and all(state == "old" for state in field_states):
                resolution_status = "rolled_back"
                resolved_values = _physical_values(changes, "old_values")
                exception_source = "old_values"
                last_error = None
            elif not field_states or all(
                state == "requested" for state in field_states
            ):
                resolution_status = "completed"
                resolved_values = _physical_values(changes, "requested_values")
                exception_source = "requested_values"
                last_error = None
            else:
                resolution_status = "rolled_back"
                resolved_values = _physical_values(changes, "old_values")
                exception_source = "old_values"
                last_error = None
                for path, values in resolved_values.items():
                    restore_physical_values(path, values)

            exception_updates = {
                change["path"]: _app_owned_override(change[exception_source])
                for change in changes
                if any(
                    field in change[exception_source]
                    for field in ("exception_type", "custom_collection_name")
                )
            }
            persist_resolution(
                intent=intent,
                resolved_values=resolved_values,
                exception_updates=exception_updates,
                status=resolution_status,
                last_error=last_error,
            )
            summary[resolution_status] += 1
        except TagEditRecoveryCommitPending as error:
            if record_recovery_evidence is not None:
                record_recovery_evidence(
                    _typed_commit_outcome_evidence(
                        intent_id,
                        "commit_pending",
                        error,
                    )
                )
            summary["commit_pending"] += 1
        except TagEditRecoveryCommitIntegrityFailure as error:
            if record_recovery_evidence is not None:
                record_recovery_evidence(
                    _typed_commit_outcome_evidence(
                        intent_id,
                        "integrity_failed",
                        error,
                    )
                )
            summary["integrity_failed"] += 1
        except Exception as exc:
            mark_recovery_failed(intent_id, exc)
            summary["failed"] += 1
    return summary


def _typed_commit_outcome_evidence(
    intent_id: str,
    outcome: str,
    error: BaseException,
) -> dict[str, str]:
    reason = (
        "Commit acknowledgement remains unconfirmed."
        if outcome == "commit_pending"
        else "Commit authority failed integrity confirmation."
    )
    cause = error.__cause__ or error
    return {
        "intent_id": intent_id,
        "outcome": outcome,
        "reason": reason,
        "cause_class": type(cause).__name__,
    }


def _normalized_changes(raw_changes: object) -> list[dict[str, object]]:
    if not isinstance(raw_changes, list) or not raw_changes:
        raise ValueError("Tag edit recovery requires recorded changes.")
    changes: list[dict[str, object]] = []
    for raw_change in raw_changes:
        if not isinstance(raw_change, Mapping):
            raise ValueError("Tag edit recovery change is malformed.")
        path = _text(raw_change.get("path"))
        old_values = raw_change.get("old_values")
        requested_values = raw_change.get("requested_values")
        if (
            not path
            or not isinstance(old_values, Mapping)
            or not isinstance(requested_values, Mapping)
            or set(old_values) != set(requested_values)
        ):
            raise ValueError("Tag edit recovery values are incomplete.")
        changes.append(
            {
                "path": path,
                "old_values": {str(key): _text(value) for key, value in old_values.items()},
                "requested_values": {
                    str(key): _text(value)
                    for key, value in requested_values.items()
                },
            }
        )
    return changes


def _physical_values(
    changes: list[dict[str, object]],
    value_key: str,
) -> dict[str, dict[str, str]]:
    return {
        str(change["path"]): {
            field: _text(value)
            for field, value in dict(change[value_key]).items()
            if field not in {"exception_type", "custom_collection_name"}
        }
        for change in changes
    }


def _text(value: object) -> str:
    return str(value or "").strip()


def _app_owned_override(values: dict[str, object]) -> object:
    exception_type = _text(values.get("exception_type"))
    if "custom_collection_name" not in values:
        return exception_type
    return {
        "exception_type": exception_type,
        "custom_collection_name": _text(values.get("custom_collection_name")),
    }


def reconcile_unfinished_tag_edit_intents_on_startup(runtime: object) -> dict[str, int]:
    """Recover only journals whose owning writer session has released its lease."""
    from music_app.services.library_roots import library_root_cache_identity
    from music_app.services.scan_cache_persistence import select_scan_cache_adapter
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository

    config = getattr(runtime, "config")
    repository = PostgresTagEditIntentRepository(config)
    root_identity = library_root_cache_identity(config)
    summary = {
        "completed": 0,
        "rolled_back": 0,
        "reconciled_external": 0,
        "commit_pending": 0,
        "integrity_failed": 0,
        "failed": 0,
    }
    file_cache = None
    for candidate in repository.load_unfinished_intents(
        library_root_identity=root_identity
    ):
        with repository.claim_unfinished_intent(
            str(candidate["id"]), library_root_identity=root_identity,
        ) as claimed:
            if claimed is None:
                continue
            if file_cache is None:
                adapter = select_scan_cache_adapter(config)
                file_cache, _last_scan, _relations, _relations_at, error = adapter.load_snapshot(
                    config["CACHE_PATH"], root_identity,
                )
                if error:
                    raise RuntimeError(f"Could not load Postgres inventory for tag edit recovery: {error}")
            result = _reconcile_claimed_tag_edit_intent(runtime, repository, claimed, file_cache)
            for key in summary:
                summary[key] += result[key]
    return summary


def _reconcile_claimed_tag_edit_intent(runtime, repository, claimed_intent, file_cache):
    from music_app.services.cache import (
        finalize_recovered_tag_edit_for_config,
        persist_recovered_tag_edit_for_config,
    )
    from music_app.services.library_roots import resolve_configured_media_path
    from music_app.services.scan_cache_persistence import (
        RecoveredTagEditCommitUnknown,
        select_scan_cache_adapter,
    )
    from music_app.services.metadata import (
        apply_text_repairs_to_file,
        read_editable_tag_values,
        read_metadata_for_file,
    )

    config = getattr(runtime, "config")
    logger = getattr(runtime, "logger")
    def resolve_recovery_path(raw_path: str) -> Path:
        resolved = resolve_configured_media_path(config, raw_path)
        if resolved is None:
            raise RuntimeError(
                "Tag edit recovery path is not one configured existing media file: "
                f"{raw_path}"
            )
        return resolved

    resolved_recovery_paths: dict[str, Path] = {}
    recoverable_intents: list[dict[str, object]] = []
    preflight_failures = 0
    for intent in [claimed_intent]:
        intent_id = str(intent.get("id") or "").strip()
        try:
            for change in _normalized_changes(intent.get("changes")):
                raw_path = str(change["path"])
                resolved_recovery_paths[raw_path] = resolve_recovery_path(raw_path)
        except Exception as exc:
            repository.mark_recovery_failed(intent_id, exc)
            preflight_failures += 1
            continue
        recoverable_intents.append(intent)

    def mark_recovery_failed(intent_id: str, error: object) -> None:
        logger.error(
            "Tag edit recovery failed intent_id=%s",
            intent_id,
            exc_info=(type(error), error, getattr(error, "__traceback__", None)),
        )
        repository.mark_recovery_failed(intent_id, error)

    def record_recovery_evidence(evidence: Mapping[str, str]) -> None:
        logger.warning(
            "Tag edit recovery deferred intent_id=%s outcome=%s reason=%s cause_class=%s",
            evidence["intent_id"],
            evidence["outcome"],
            evidence["reason"],
            evidence["cause_class"],
        )

    def persist_resolution(
        *,
        intent: dict[str, object],
        resolved_values: dict[str, dict[str, str]],
        exception_updates: dict[str, object],
        status: str,
        last_error: str | None,
    ) -> None:
        intent_id = _text(intent.get("id"))
        changed_entries: dict[str, dict[str, object]] = {}
        recorded_changes = _normalized_changes(intent.get("changes"))
        recorded_fields = {
            field
            for change in recorded_changes
            for field in dict(change["requested_values"])
        }
        structural_fields, inventory_fields = _recovery_partitions(recorded_fields)
        for change in recorded_changes:
            path = str(change["path"])
            baseline_entry = file_cache.get(path)
            if not isinstance(baseline_entry, dict):
                raise RuntimeError(
                    "Postgres inventory has no track for recovery path "
                    f"{path}; loaded_entries={len(file_cache)}"
                )
            physical_values = resolved_values.get(path, {})
            if physical_values:
                refreshed_entry = read_metadata_for_file(
                    resolved_recovery_paths[path]
                )
                resolved_entry = _resolved_recovery_entry(
                    baseline_entry=baseline_entry,
                    refreshed_entry=refreshed_entry,
                    recorded_fields=set(dict(change["requested_values"])),
                )
            else:
                resolved_entry = dict(baseline_entry)
            if path in exception_updates:
                override = exception_updates[path]
                if isinstance(override, dict):
                    resolved_entry["exception_type"] = override.get("exception_type") or None
                    resolved_entry["custom_collection_name"] = (
                        override.get("custom_collection_name") or None
                    )
                else:
                    resolved_entry["exception_type"] = override or None
                    resolved_entry["custom_collection_name"] = None
            changed_entries[path] = resolved_entry

        repository_hook = lambda connection: repository.complete_in_transaction(
            connection,
            intent_id,
            exception_updates=exception_updates,
            status=status,
            last_error=last_error,
        )
        previous_file_entries = file_cache
        try:
            persist_recovered_tag_edit_for_config(
                config,
                changed_paths=set(changed_entries),
                previous_file_entries=previous_file_entries,
                resolved_file_entries=ChainMap(changed_entries, previous_file_entries),
                structural_field_names=set(structural_fields),
                inventory_field_names=set(inventory_fields),
                before_commit=repository_hook,
                commit_guard=lambda commit: commit(),
            )
        except RecoveredTagEditCommitUnknown as unknown:
            try:
                journal = repository.load_intent_for_recovery(
                    intent_id,
                    library_root_identity=str(
                        intent.get("library_root_identity") or ""
                    ).strip(),
                )
                authority = select_scan_cache_adapter(
                    config
                ).load_recovered_tag_edit_state(set(changed_entries))
            except Exception as error:
                raise TagEditRecoveryCommitPending(
                    "Recovered tag edit authority could not be confirmed."
                ) from error
            _confirm_recovered_tag_edit_commit(
                journal=journal,
                authority=authority,
                prepared_result=unknown.persistence_result,
                expected_status=status,
                expected_entries=changed_entries,
                admitted_fields=structural_fields.union(inventory_fields),
            )
            finalize_recovered_tag_edit_for_config(
                config,
                structural_partition_ran=bool(
                    unknown.persistence_result.get("structural_partition_ran")
                ),
            )
            changed_entries = {
                path: dict(entry)
                for path, entry in dict(authority["file_entries"]).items()
            }
            authoritative_overrides = dict(authority["exception_overrides"])
            for path, entry in changed_entries.items():
                override = dict(authoritative_overrides[path])
                exception_type = _text(override.get("exception_type"))
                custom_collection_name = _text(
                    override.get("custom_collection_name")
                )
                entry["exception_type"] = exception_type or None
                entry["custom_collection_name"] = (
                    custom_collection_name
                    if exception_type == "Custom Collection"
                    else None
                )
        file_cache.update(changed_entries)

    summary = reconcile_tag_edit_intents(
        recoverable_intents,
        read_physical_values=lambda path, fields: read_editable_tag_values(
            resolved_recovery_paths[path],
            fields,
        ),
        restore_physical_values=lambda path, values: apply_text_repairs_to_file(
            resolved_recovery_paths[path],
            values,
        ),
        persist_resolution=persist_resolution,
        mark_recovery_failed=mark_recovery_failed,
        record_recovery_evidence=record_recovery_evidence,
    )
    summary["failed"] += preflight_failures
    logger.info(
        "Tag edit recovery completed completed=%s rolled_back=%s external=%s "
        "commit_pending=%s integrity_failed=%s failed=%s",
        summary["completed"],
        summary["rolled_back"],
        summary["reconciled_external"],
        summary["commit_pending"],
        summary["integrity_failed"],
        summary["failed"],
    )
    return summary


def _recovery_partitions(
    recorded_fields: set[str] | frozenset[str],
) -> tuple[frozenset[str], frozenset[str]]:
    physical_fields = frozenset(recorded_fields).difference(_APP_OWNED_FIELDS)
    inventory_fields = physical_fields.intersection(_INVENTORY_FIELDS)
    structural_fields = physical_fields.difference(inventory_fields)
    if structural_fields and structural_fields not in _STRUCTURAL_FIELD_SETS:
        raise ValueError("Tag edit recovery fields have no supported persistence owner.")
    return structural_fields, inventory_fields


def _resolved_recovery_entry(
    *,
    baseline_entry: Mapping[str, object],
    refreshed_entry: Mapping[str, object],
    recorded_fields: set[str],
) -> dict[str, object]:
    structural_fields, inventory_fields = _recovery_partitions(recorded_fields)
    admitted_fields = structural_fields.union(inventory_fields)
    ancillary_fields = {"mtime", "size"}
    if "year" in structural_fields:
        ancillary_fields.add("release_date")
    ignored_authority_fields = _APP_OWNED_FIELDS.union(_CANONICAL_COVER_FIELDS)
    unexpected = sorted(
        field
        for field, value in refreshed_entry.items()
        if field not in admitted_fields
        and field not in ancillary_fields
        and field not in ignored_authority_fields
        and _text(baseline_entry.get(field)) != _text(value)
    )
    if unexpected:
        raise ValueError(
            "Tag edit recovery observed unowned metadata drift: "
            + ", ".join(unexpected)
        )
    resolved = dict(baseline_entry)
    for field in admitted_fields.union(ancillary_fields):
        if field in refreshed_entry:
            resolved[field] = refreshed_entry[field]
    return resolved


def _confirm_recovered_tag_edit_commit(
    *,
    journal: Mapping[str, object] | None,
    authority: Mapping[str, object],
    prepared_result: Mapping[str, object],
    expected_status: str,
    expected_entries: Mapping[str, Mapping[str, object]],
    admitted_fields: frozenset[str],
) -> None:
    journal_status = str((journal or {}).get("status") or "").strip().casefold()
    if journal_status in _UNFINISHED_STATUSES or not journal_status:
        raise TagEditRecoveryCommitPending(
            "Recovered tag edit commit is not yet confirmed."
        )
    if journal_status != str(expected_status or "").strip().casefold():
        raise TagEditRecoveryCommitIntegrityFailure(
            "Recovered tag edit journal terminal state is contradictory."
        )
    prepared_revision = int(
        prepared_result.get("inventory_mutation_revision") or 0
    )
    authority_revision = int(authority.get("inventory_mutation_revision") or 0)
    if authority_revision < prepared_revision:
        raise TagEditRecoveryCommitIntegrityFailure(
            "Recovered tag edit inventory revision is contradictory."
        )
    if authority_revision > prepared_revision:
        return
    authoritative_entries = authority.get("file_entries")
    if not isinstance(authoritative_entries, Mapping):
        raise TagEditRecoveryCommitPending(
            "Recovered tag edit authority is unavailable."
        )
    for path, expected in expected_entries.items():
        current = authoritative_entries.get(path)
        if not isinstance(current, Mapping):
            raise TagEditRecoveryCommitIntegrityFailure(
                "Recovered tag edit authority omitted a changed path."
            )
        if any(
            _text(current.get(field)) != _text(expected.get(field))
            for field in admitted_fields
        ):
            raise TagEditRecoveryCommitIntegrityFailure(
                "Recovered tag edit authority contradicts the prepared values."
            )
