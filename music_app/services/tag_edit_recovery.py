from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path


_UNFINISHED_STATUSES = frozenset({"prepared", "files_verified", "recovery_failed"})


def reconcile_tag_edit_intents(
    intents: list[dict[str, object]],
    *,
    read_physical_values: Callable[[str, set[str]], dict[str, str]],
    restore_physical_values: Callable[[str, dict[str, str]], None],
    persist_resolution: Callable[..., None],
    mark_recovery_failed: Callable[[str, object], None],
) -> dict[str, int]:
    """Resolve unfinished intents from real files without trusting UI state."""
    summary = {
        "completed": 0,
        "rolled_back": 0,
        "reconciled_external": 0,
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
                physical_fields = set(requested_values).difference({"exception_type"})
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
                change["path"]: _text(change[exception_source]["exception_type"])
                for change in changes
                if "exception_type" in change[exception_source]
            }
            persist_resolution(
                intent=intent,
                resolved_values=resolved_values,
                exception_updates=exception_updates,
                status=resolution_status,
                last_error=last_error,
            )
            summary[resolution_status] += 1
        except Exception as exc:
            mark_recovery_failed(intent_id, exc)
            summary["failed"] += 1
    return summary


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
            if field != "exception_type"
        }
        for change in changes
    }


def _text(value: object) -> str:
    return str(value or "").strip()


def reconcile_unfinished_tag_edit_intents_on_startup(runtime: object) -> dict[str, int]:
    """Reconcile the local library journal before normal state hydration."""
    from music_app.services.cache import (
        persist_structural_tag_edit_for_config,
        save_cache_updates_to_disk_for_config,
    )
    from music_app.services.library_roots import (
        library_root_cache_identity,
        resolve_configured_media_path,
    )
    from music_app.services.metadata import (
        apply_text_repairs_to_file,
        read_editable_tag_values,
        read_metadata_for_file,
    )
    from music_app.services.scan_cache_persistence import select_scan_cache_adapter
    from music_app.services.tag_edit_intents_postgres import (
        PostgresTagEditIntentRepository,
    )

    config = getattr(runtime, "config")
    logger = getattr(runtime, "logger")
    repository = PostgresTagEditIntentRepository(config)
    root_identity = library_root_cache_identity(config)
    intents = repository.load_unfinished_intents(
        library_root_identity=root_identity,
    )
    if not intents:
        return {
            "completed": 0,
            "rolled_back": 0,
            "reconciled_external": 0,
            "failed": 0,
        }

    adapter = select_scan_cache_adapter(config)
    file_cache, _last_scan, _relations, _relations_at, error = adapter.load_snapshot(
        config["CACHE_PATH"],
        root_identity,
    )
    if error:
        raise RuntimeError(
            f"Could not load Postgres inventory for tag edit recovery: {error}"
        )

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
    for intent in intents:
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

    def persist_resolution(
        *,
        intent: dict[str, object],
        resolved_values: dict[str, dict[str, str]],
        exception_updates: dict[str, str],
        status: str,
        last_error: str | None,
    ) -> None:
        intent_id = _text(intent.get("id"))
        changed_entries: dict[str, dict[str, object]] = {}
        recorded_changes = _normalized_changes(intent.get("changes"))
        for change in recorded_changes:
            path = str(change["path"])
            baseline_entry = file_cache.get(path)
            if not isinstance(baseline_entry, dict):
                raise RuntimeError(
                    f"Postgres inventory has no track for recovery path {path}"
                )
            physical_values = resolved_values.get(path, {})
            if physical_values:
                refreshed_entry = read_metadata_for_file(
                    resolved_recovery_paths[path]
                )
                resolved_entry = {**baseline_entry, **refreshed_entry}
            else:
                resolved_entry = dict(baseline_entry)
            if path in exception_updates:
                resolved_entry["exception_type"] = exception_updates[path] or None
            changed_entries[path] = resolved_entry

        repository_hook = lambda connection: repository.complete_in_transaction(
            connection,
            intent_id,
            exception_updates=exception_updates,
            status=status,
            last_error=last_error,
        )
        structural_field = _recovery_structural_field(
            previous_entries={
                str(change["path"]): dict(change["old_values"])
                for change in recorded_changes
            },
            updated_entries={
                str(change["path"]): dict(change["requested_values"])
                for change in recorded_changes
            },
            recorded_fields={
                field
                for change in recorded_changes
                for field in dict(change["requested_values"])
                if field != "exception_type"
            },
        )
        if structural_field:
            persist_structural_tag_edit_for_config(
                config,
                changed_paths=set(changed_entries),
                previous_file_entries=file_cache,
                updated_file_entries={**file_cache, **changed_entries},
                changed_field_names={structural_field},
                before_commit=repository_hook,
                rebuild_relation_projection=True,
            )
        else:
            save_cache_updates_to_disk_for_config(
                config,
                config["CACHE_PATH"],
                changed_entries,
                baseline_file_cache=file_cache,
                before_commit=repository_hook,
                rebuild_relation_projection=True,
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
        mark_recovery_failed=repository.mark_recovery_failed,
    )
    summary["failed"] += preflight_failures
    logger.info(
        "Tag edit recovery completed completed=%s rolled_back=%s external=%s failed=%s",
        summary["completed"],
        summary["rolled_back"],
        summary["reconciled_external"],
        summary["failed"],
    )
    return summary


def _recovery_structural_field(
    *,
    previous_entries: Mapping[str, Mapping[str, object]],
    updated_entries: Mapping[str, Mapping[str, object]],
    recorded_fields: set[str] | None = None,
) -> str:
    changed_fields = set(recorded_fields) if recorded_fields is not None else {
        field
        for path, entry in updated_entries.items()
        for field in entry
        if field != "exception_type"
        and _text(previous_entries.get(path, {}).get(field))
        != _text(entry.get(field))
    }
    return next(iter(changed_fields)) if changed_fields in ({"album"}, {"year"}) else ""
