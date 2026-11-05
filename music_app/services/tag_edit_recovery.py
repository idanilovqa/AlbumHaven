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
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository

    config = getattr(runtime, "config")
    repository = PostgresTagEditIntentRepository(config)
    root_identity = library_root_cache_identity(config)
    summary = {"completed": 0, "rolled_back": 0, "reconciled_external": 0, "failed": 0}
    projections_ready = False

    def prepare_projections() -> None:
        nonlocal projections_ready
        if projections_ready:
            return
        from music_app.services.relation_projection_postgres import ensure_relation_projection_ready
        from music_app.services.gallery_projection_postgres import initialize_gallery_membership

        result = ensure_relation_projection_ready(config, logger=runtime.logger)
        if not result.get("ready"):
            raise RuntimeError("Relation projection is not ready for tag edit recovery.")
        initialize_gallery_membership(config)
        projections_ready = True

    for candidate in repository.load_unfinished_intents(
        library_root_identity=root_identity
    ):
        with repository.claim_unfinished_intent(
            str(candidate["id"]), library_root_identity=root_identity,
        ) as claimed:
            if claimed is None:
                continue
            result = _reconcile_claimed_tag_edit_intent(
                runtime, repository, claimed, before_recovery=prepare_projections,
            )
            for key in summary:
                summary[key] += result[key]
    return summary


def _reconcile_claimed_tag_edit_intent(runtime, repository, claimed_intent, *, before_recovery):
    from music_app.services.cache import persist_structural_tag_edit_for_config
    from music_app.services.scan_cache_persistence import TARGETED_TAG_EDIT_FIELDS, select_scan_cache_adapter
    from music_app.services.library_roots import resolve_configured_media_path
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
    file_cache: dict[str, dict[str, object]] = {}
    preflight_failures = 0
    for intent in [claimed_intent]:
        intent_id = str(intent.get("id") or "").strip()
        try:
            for change in _normalized_changes(intent.get("changes")):
                raw_path = str(change["path"])
                resolved_recovery_paths[raw_path] = resolve_recovery_path(raw_path)
            file_cache = select_scan_cache_adapter(config).load_file_entries(
                set(resolved_recovery_paths)
            )
            if any(path not in file_cache for path in resolved_recovery_paths):
                raise RuntimeError("Postgres inventory is missing a selected tag edit recovery file.")
            before_recovery()
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
                resolved_entry = {**baseline_entry, **refreshed_entry}
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
        persist_structural_tag_edit_for_config(
            config,
            changed_paths=set(changed_entries),
            previous_file_entries=file_cache,
            updated_file_entries=changed_entries,
            changed_field_names=(
                {field for change in recorded_changes for field in change["requested_values"]}
                | {field for path, entry in changed_entries.items() for field in TARGETED_TAG_EDIT_FIELDS
                   if _text(file_cache[path].get(field)) != _text(entry.get(field))}
            ),
            before_commit=repository_hook,
            rebuild_relation_projection=True,
        )

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
