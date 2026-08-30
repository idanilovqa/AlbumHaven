from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import uuid

from music_app.services.scan_cache_persistence import (
    StructuralTagEditDestinationConflict,
)


JsonDict = dict[str, object]
ConfigDict = dict[str, object]
FileCache = dict[str, JsonDict]
StateDict = dict[str, object]
TrackPathSet = set[str]
RepairBuilder = Callable[[JsonDict], dict[str, str]]
AliasRepairBuilder = Callable[[JsonDict, dict[str, str] | None], dict[str, str]]
RepairWorker = Callable[[str, dict[str, str]], tuple[str, bool, list[str]]]
CacheEntryUpdater = Callable[[Path, JsonDict, dict[str, str]], JsonDict]
AlbumDictBuilder = Callable[[FileCache, FileCache, TrackPathSet, TrackPathSet, set[str]], list[JsonDict]]
AlbumMatcher = Callable[[TrackPathSet], list[JsonDict]]
ProblematicAlbumMatcher = Callable[[TrackPathSet], JsonDict | None]
AlbumStateRebuilder = Callable[[StateDict, FileCache, FileCache, TrackPathSet, set[str]], None]
SetLoader = Callable[[ConfigDict], set[str]]
SetSaver = Callable[[ConfigDict, set[str]], None]
ExceptionNormalizer = Callable[[object], str]
AppEventLogger = Callable[..., None]
LogHistoryAppender = Callable[[ConfigDict, JsonDict], None]
SaveTaskCreator = Callable[[str], str]
SaveTaskFinalizer = Callable[..., None]
ExceptionOverrideSaver = Callable[[ConfigDict, str, object], str]
ExceptionOverrideBatchSaver = Callable[[ConfigDict, dict[str, object]], dict[str, str]]
StructuralTagEditPrevalidator = Callable[..., object]
StructuralTagEditReservationAcquirer = Callable[[set[str]], object]
TagEditIntentPreparer = Callable[..., str]
TagEditIntentCheckpoint = Callable[[str], None]

_ALLOWED_TAG_EDIT_FIELDS = {
    "artist",
    "album_artist",
    "album",
    "title",
    "genre",
    "year",
    "track_number",
    "disc_number",
    "edition",
    "album_rating",
    "exception_type",
}


def _album_log_context(album: JsonDict) -> dict[str, object]:
    return {
        "artist": str(album.get("album_artist") or ""),
        "album": str(album.get("name") or album.get("album") or ""),
    }


def _record_tag_edit_failure(
    *,
    album: JsonDict,
    paths: list[str] | set[str],
    error_text: str,
    config: ConfigDict,
    logger: object,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
) -> JsonDict:
    files = sorted({str(path or "") for path in paths if str(path or "")})
    log_entry = {
        "id": uuid.uuid4().hex,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "Tag edit failed",
        **_album_log_context(album),
        "file_count": len(files),
        "files": files,
        "error": error_text,
    }
    try:
        append_log_history(config, log_entry)
    except Exception:
        pass
    try:
        log_app_event(
            config,
            logger,
            "Tag edit failed",
            level="error",
            files=files,
            error=error_text,
            **_album_log_context(album),
        )
    except Exception:
        pass
    return {"ok": False, "error": error_text, "log_entry": log_entry}


def _run_edit_jobs(
    *,
    album: JsonDict,
    repair_jobs: list[tuple[str, JsonDict, dict[str, str]]],
    config: ConfigDict,
    logger: object,
    apply_repairs_worker: RepairWorker,
    update_cache_entry_after_repairs: CacheEntryUpdater,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    updated_file_cache: FileCache,
    action_name: str,
    failure_prefix: str,
    edit_write_workers: int,
) -> tuple[list[JsonDict], list[str], JsonDict | None]:
    changed_files: list[JsonDict] = []
    skipped_files: list[str] = []
    if not repair_jobs:
        return changed_files, skipped_files, None

    future_map = {}
    completed_changes: list[tuple[int, str, JsonDict, dict[str, str], list[str]]] = []
    failures: list[tuple[int, str, Exception]] = []
    with ThreadPoolExecutor(max_workers=edit_write_workers) as executor:
        for job_index, (raw_path, entry, repairs) in enumerate(repair_jobs):
            future = executor.submit(apply_repairs_worker, raw_path, repairs)
            future_map[future] = (job_index, raw_path, entry, repairs)

        for future in as_completed(future_map):
            job_index, raw_path, entry, repairs = future_map[future]
            try:
                _path, changed, changed_fields = future.result()
            except Exception as exc:
                failures.append((job_index, raw_path, exc))
                continue

            requested_fields = set(repairs)
            committed_fields = {
                str(field or "") for field in changed_fields if str(field or "")
            }
            missing_fields = sorted(requested_fields - committed_fields)
            unexpected_fields = sorted(committed_fields - requested_fields)
            if not changed or missing_fields or unexpected_fields:
                mismatch_parts = []
                if missing_fields:
                    mismatch_parts.append("missing fields " + ", ".join(missing_fields))
                if unexpected_fields:
                    mismatch_parts.append(
                        "unexpected fields " + ", ".join(unexpected_fields)
                    )
                if not changed and not mismatch_parts:
                    mismatch_parts.append("writer reported no committed changes")
                failures.append(
                    (
                        job_index,
                        raw_path,
                        RuntimeError("; ".join(mismatch_parts)),
                    )
                )
                if committed_fields:
                    completed_changes.append(
                        (job_index, raw_path, entry, repairs, sorted(committed_fields))
                    )
                continue
            completed_changes.append(
                (job_index, raw_path, entry, repairs, changed_fields)
            )

    if failures:
        compensation_failures: list[str] = []
        for _job_index, raw_path, entry, repairs, changed_fields in sorted(
            completed_changes
        ):
            reverse_repairs = {
                field: str(
                    (entry.get("release_date") or entry.get("year"))
                    if field == "year"
                    else (entry.get(field) or "")
                )
                for field in changed_fields
                if field in repairs
            }
            if not reverse_repairs:
                continue
            try:
                apply_repairs_worker(raw_path, reverse_repairs)
            except Exception as exc:
                compensation_failures.append(f"{raw_path}: {exc}")

        _job_index, failed_path, failure = min(failures)
        error_text = f"{failure_prefix} {failed_path}: {failure}"
        if compensation_failures:
            error_text += (
                "; media compensation also failed: "
                + "; ".join(compensation_failures)
            )
        failure_payload = _record_tag_edit_failure(
            album=album,
            paths=[path for _index, path, _exc in sorted(failures)],
            error_text=error_text,
            config=config,
            logger=logger,
            append_log_history=append_log_history,
            log_app_event=log_app_event,
        )
        return [], [], failure_payload

    for _job_index, raw_path, entry, repairs, changed_fields in sorted(
        completed_changes
    ):
        applied_repairs = {
            field: repairs[field]
            for field in changed_fields
            if field in repairs
        }
        updated_file_cache[raw_path] = update_cache_entry_after_repairs(
            Path(raw_path),
            entry,
            applied_repairs,
        )
        changed_files.append({
            "path": raw_path,
            "fields": changed_fields,
        })

    return changed_files, skipped_files, None


def handle_repair_album_request(
    *,
    payload: JsonDict,
    album: JsonDict,
    requested_track_paths: TrackPathSet,
    config: ConfigDict,
    logger: object,
    get_state: Callable[[], StateDict],
    create_save_task: SaveTaskCreator,
    queue_finalize_save_task: SaveTaskFinalizer,
    build_text_repairs_for_entry: RepairBuilder,
    build_artist_alias_repairs_for_entry: AliasRepairBuilder,
    build_disc_marker_repairs_for_entry: RepairBuilder,
    apply_repairs_worker: RepairWorker,
    update_cache_entry_after_repairs: CacheEntryUpdater,
    build_affected_album_dicts: AlbumDictBuilder,
    find_problematic_album_by_track_paths: ProblematicAlbumMatcher,
    find_albums_by_track_paths: AlbumMatcher,
    rebuild_affected_albums_in_state: AlbumStateRebuilder,
    load_ignored_repair_keys: SetLoader,
    save_ignored_repair_keys: SetSaver,
    load_separate_release_keys: SetLoader,
    save_separate_release_keys: SetSaver,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    structural_edit_fields: set[str],
    edit_write_workers: int,
) -> JsonDict | tuple[JsonDict, int]:
    selected_rows = payload.get("selected_rows")
    if not isinstance(selected_rows, list):
        return {"ok": False, "error": "No selected repairs were provided"}, 400
    ignored_rows = payload.get("ignored_rows")
    if not isinstance(ignored_rows, list):
        ignored_rows = []
    separate_release_rows = payload.get("separate_release_keys")
    if not isinstance(separate_release_rows, list):
        separate_release_rows = []

    selected_row_keys = {str(value).strip() for value in selected_rows if str(value).strip()}
    ignored_row_keys_to_save = {str(value).strip() for value in ignored_rows if str(value).strip()}
    separate_release_keys_to_save = {str(value).strip() for value in separate_release_rows if str(value).strip()}
    if ignored_row_keys_to_save:
        return {
            "ok": False,
            "error": (
                "Problem exclusions must use the dedicated problem exclusion API"
            ),
        }, 400

    if not selected_row_keys:
        if separate_release_keys_to_save:
            existing_separate = load_separate_release_keys(config)
            existing_separate.update(separate_release_keys_to_save)
            save_separate_release_keys(config, existing_separate)
            st = get_state()
            st["separate_release_keys"] = existing_separate
            file_cache = st.get("file_cache", {}) or {}
            rebuild_affected_albums_in_state(st, file_cache, file_cache, requested_track_paths, existing_separate)
            log_app_event(
                config,
                logger,
                "Release exception created",
                level="info",
                history=True,
                separate_release_keys=sorted(separate_release_keys_to_save),
            )
        if separate_release_keys_to_save:
            return {
                "ok": True,
                "changed_files": [],
                "skipped_files": [],
                "changed_count": 0,
                "updated_problematic_album": find_problematic_album_by_track_paths(requested_track_paths),
                "updated_albums": find_albums_by_track_paths(requested_track_paths),
                "requires_view_refresh": bool(separate_release_keys_to_save),
            }
        return {"ok": False, "error": "No repairs were selected"}, 400

    tracks = album.get("tracks")
    st = get_state()
    file_cache = st.get("file_cache", {}) or {}
    relation_views = st.get("relation_views", {}) or {}
    alias_to_canonical = relation_views.get("alias_to_canonical", {}) or {}
    updated_file_cache = dict(file_cache)
    repair_jobs: list[tuple[str, JsonDict, dict[str, str]]] = []
    skipped_files: list[str] = []
    seen_paths: set[str] = set()

    for track in tracks:
        if not isinstance(track, dict):
            continue
        raw_path = str(track.get("path") or "")
        if not raw_path or raw_path in seen_paths:
            continue
        seen_paths.add(raw_path)

        entry = file_cache.get(raw_path)
        if not isinstance(entry, dict):
            skipped_files.append(raw_path)
            continue

        all_repairs = build_text_repairs_for_entry(entry)
        all_repairs.update(build_artist_alias_repairs_for_entry(entry, alias_to_canonical))
        repairs = {
            field: value
            for field, value in all_repairs.items()
            if f"{raw_path}::{field}" in selected_row_keys
        }
        if f"{raw_path}::album_disc_marker" in selected_row_keys:
            repairs.update(build_disc_marker_repairs_for_entry(entry))
        if not repairs:
            skipped_files.append(raw_path)
            continue
        repair_jobs.append((raw_path, entry, repairs))

    changed_files, job_skipped_files, job_error = _run_edit_jobs(
        album=album,
        repair_jobs=repair_jobs,
        config=config,
        logger=logger,
        apply_repairs_worker=apply_repairs_worker,
        update_cache_entry_after_repairs=update_cache_entry_after_repairs,
        append_log_history=append_log_history,
        log_app_event=log_app_event,
        updated_file_cache=updated_file_cache,
        action_name="Tag repair failed",
        failure_prefix="Failed to repair",
        edit_write_workers=edit_write_workers,
    )
    if job_error is not None:
        return job_error, 500
    skipped_files.extend(job_skipped_files)

    separate_release_keys = set(st.get("separate_release_keys") or load_separate_release_keys(config))
    if separate_release_keys_to_save:
        separate_release_keys.update(separate_release_keys_to_save)
        save_separate_release_keys(config, separate_release_keys)
        st["separate_release_keys"] = separate_release_keys
        log_app_event(
            config,
            logger,
            "Release exception created",
            level="info",
            history=True,
            separate_release_keys=sorted(separate_release_keys_to_save),
        )

    changed_paths = {str(item.get("path") or "") for item in changed_files if str(item.get("path") or "")}
    changed_field_names = {
        str(field or "")
        for item in changed_files
        for field in item.get("fields", [])
        if str(field or "")
    }
    requires_view_refresh = bool(separate_release_keys_to_save or (changed_field_names & structural_edit_fields))
    updated_albums = build_affected_album_dicts(
        file_cache,
        updated_file_cache,
        requested_track_paths,
        changed_paths or requested_track_paths,
        separate_release_keys,
    )
    task_id = ""
    if changed_files:
        task_id = create_save_task("repair-tags")
        queue_finalize_save_task(
            task_id=task_id,
            config=config,
            logger=logger,
            updated_file_cache=dict(updated_file_cache),
            previous_file_cache=dict(file_cache),
            changed_paths=set(changed_paths),
            requested_track_paths=set(requested_track_paths),
            separate_release_keys=set(separate_release_keys),
            changed_field_names=set(changed_field_names),
            log_entry={
                "id": uuid.uuid4().hex,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "Tags repaired",
                **_album_log_context(album),
                "file_count": len(changed_paths),
                "files": sorted(changed_paths),
            },
        )

    return {
        "ok": True,
        "changed_files": changed_files,
        "skipped_files": skipped_files,
        "changed_count": len(changed_files),
        "updated_album": updated_albums[0] if updated_albums else None,
        "updated_albums": updated_albums,
        "updated_problematic_album": None,
        "requires_view_refresh": requires_view_refresh,
        "save_task_id": task_id,
    }


def handle_edit_tags_request(
    *,
    acquire_structural_tag_edit_reservation: (
        StructuralTagEditReservationAcquirer | None
    ) = None,
    structural_tag_edit_resource_keys: set[str] | None = None,
    structural_tag_edit_reservation: object | None = None,
    **workflow_options,
) -> JsonDict | tuple[JsonDict, int]:
    reservation = structural_tag_edit_reservation
    if (
        reservation is None
        and acquire_structural_tag_edit_reservation is not None
    ):
        reservation = acquire_structural_tag_edit_reservation(
            set(structural_tag_edit_resource_keys or set())
        )
    try:
        result = _handle_edit_tags_request_after_reservation(
            structural_tag_edit_reservation=reservation,
            **workflow_options,
        )
        result_payload = result[0] if isinstance(result, tuple) else result
        if (
            reservation is not None
            and isinstance(result_payload, dict)
            and str(result_payload.get("save_task_id") or "").strip()
        ):
            reservation = None
        return result
    finally:
        if reservation is not None:
            release = getattr(reservation, "release", None)
            if callable(release):
                release()


def _handle_edit_tags_request_after_reservation(
    *,
    album: JsonDict,
    updates: JsonDict,
    requested_track_paths: TrackPathSet,
    config: ConfigDict,
    logger: object,
    get_state: Callable[[], StateDict],
    create_save_task: SaveTaskCreator,
    queue_finalize_save_task: SaveTaskFinalizer,
    apply_repairs_worker: RepairWorker,
    update_cache_entry_after_repairs: CacheEntryUpdater,
    build_affected_album_dicts: AlbumDictBuilder,
    load_separate_release_keys: SetLoader,
    normalize_exception_value: ExceptionNormalizer,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    structural_edit_fields: set[str],
    edit_write_workers: int,
    save_track_exception_override: ExceptionOverrideSaver,
    save_track_exception_overrides: ExceptionOverrideBatchSaver | None = None,
    prevalidate_structural_tag_edit: StructuralTagEditPrevalidator | None = None,
    structural_tag_edit_reservation: object | None = None,
    prepare_tag_edit_intent: TagEditIntentPreparer | None = None,
    mark_tag_edit_files_verified: TagEditIntentCheckpoint | None = None,
) -> JsonDict | tuple[JsonDict, int]:
    st = get_state()
    file_cache = st.get("file_cache", {}) or {}
    updated_file_cache = dict(file_cache)
    repair_jobs: list[tuple[str, JsonDict, dict[str, str]]] = []
    skipped_files: list[str] = []
    exception_updates: list[tuple[str, JsonDict, str]] = []

    for raw_path, raw_edits in updates.items():
        path = str(raw_path or "")
        if not path or not isinstance(raw_edits, dict):
            continue

        entry = file_cache.get(path)
        if not isinstance(entry, dict):
            skipped_files.append(path)
            continue

        repairs: dict[str, str] = {}
        exception_value = None
        for field, value in raw_edits.items():
            field_name = str(field or "")
            if field_name not in _ALLOWED_TAG_EDIT_FIELDS:
                continue
            text_value = normalize_exception_value(value) if field_name == "exception_type" else str(value or "").strip()
            current_value = str(entry.get(field_name) or "").strip()
            if text_value != current_value:
                if field_name == "exception_type":
                    exception_value = text_value
                else:
                    repairs[field_name] = text_value

        if exception_value is not None:
            exception_updates.append((path, entry, exception_value))

        if not repairs and exception_value is None:
            skipped_files.append(path)
            continue
        if repairs:
            repair_jobs.append((path, entry, repairs))

    if prevalidate_structural_tag_edit is not None and repair_jobs:
        prospective_file_cache = dict(file_cache)
        prospective_changed_paths: set[str] = set()
        prospective_changed_fields: set[str] = set()
        for raw_path, entry, repairs in repair_jobs:
            prospective_file_cache[raw_path] = update_cache_entry_after_repairs(
                Path(raw_path),
                entry,
                repairs,
            )
            prospective_changed_paths.add(raw_path)
            prospective_changed_fields.update(repairs)
        try:
            prevalidate_structural_tag_edit(
                changed_paths=prospective_changed_paths,
                previous_file_entries=file_cache,
                updated_file_entries=prospective_file_cache,
                changed_field_names=prospective_changed_fields,
            )
        except StructuralTagEditDestinationConflict as exc:
            failure_payload = _record_tag_edit_failure(
                album=album,
                paths=prospective_changed_paths,
                error_text=str(exc),
                config=config,
                logger=logger,
                append_log_history=append_log_history,
                log_app_event=log_app_event,
            )
            return failure_payload, 409
        except Exception as exc:
            failure_payload = _record_tag_edit_failure(
                album=album,
                paths=prospective_changed_paths,
                error_text=str(exc),
                config=config,
                logger=logger,
                append_log_history=append_log_history,
                log_app_event=log_app_event,
            )
            return failure_payload, 500

    exception_values_by_path = {
        path: exception_value
        for path, _entry, exception_value in exception_updates
    }
    repairs_by_path = {
        path: dict(repairs)
        for path, _entry, repairs in repair_jobs
    }
    tag_edit_intent_id = ""
    if prepare_tag_edit_intent is not None:
        intent_changes: list[dict[str, object]] = []
        for raw_path in updates:
            path = str(raw_path or "")
            entry = file_cache.get(path)
            if not isinstance(entry, dict):
                continue
            requested_values = dict(repairs_by_path.get(path, {}))
            if path in exception_values_by_path:
                requested_values["exception_type"] = exception_values_by_path[path]
            if not requested_values:
                continue
            old_values = {
                field: str(
                    (entry.get("release_date") or entry.get("year") or "")
                    if field == "year"
                    else (entry.get(field) or "")
                ).strip()
                for field in requested_values
            }
            intent_changes.append(
                {
                    "path": path,
                    "old_values": old_values,
                    "requested_values": requested_values,
                }
            )
        if intent_changes:
            try:
                tag_edit_intent_id = str(
                    prepare_tag_edit_intent(changes=intent_changes) or ""
                ).strip()
                if not tag_edit_intent_id:
                    raise RuntimeError("Tag edit intent persistence returned no intent ID.")
            except Exception as exc:
                failure_payload = _record_tag_edit_failure(
                    album=album,
                    paths=[change["path"] for change in intent_changes],
                    error_text=f"Failed to persist tag edit intent: {exc}",
                    config=config,
                    logger=logger,
                    append_log_history=append_log_history,
                    log_app_event=log_app_event,
                )
                return failure_payload, 500

    changed_files, job_skipped_files, job_error = _run_edit_jobs(
        album=album,
        repair_jobs=repair_jobs,
        config=config,
        logger=logger,
        apply_repairs_worker=apply_repairs_worker,
        update_cache_entry_after_repairs=update_cache_entry_after_repairs,
        append_log_history=append_log_history,
        log_app_event=log_app_event,
        updated_file_cache=updated_file_cache,
        action_name="Tag edit failed",
        failure_prefix="Failed to edit tags for",
        edit_write_workers=edit_write_workers,
    )
    if job_error is not None:
        return job_error, 500
    skipped_files.extend(job_skipped_files)

    if tag_edit_intent_id and mark_tag_edit_files_verified is not None:
        try:
            mark_tag_edit_files_verified(tag_edit_intent_id)
        except Exception as exc:
            checkpoint_paths = sorted(
                set(repairs_by_path) | set(exception_values_by_path)
            )
            checkpoint_error = f"Failed to checkpoint verified tag files: {exc}"
            try:
                log_app_event(
                    config,
                    logger,
                    "Tag edit files-verified checkpoint failed",
                    level="error",
                    history=True,
                    tag_edit_intent_id=tag_edit_intent_id,
                    files=checkpoint_paths,
                    error=checkpoint_error,
                    **_album_log_context(album),
                )
            except Exception:
                log_exception = getattr(logger, "exception", None)
                if callable(log_exception):
                    try:
                        log_exception(
                            "Tag edit files-verified checkpoint failed "
                            "intent_id=%s files=%s error=%s",
                            tag_edit_intent_id,
                            checkpoint_paths,
                            checkpoint_error,
                        )
                    except Exception:
                        pass

    changed_file_map = {
        str(item.get("path") or ""): {
            "path": str(item.get("path") or ""),
            "fields": [str(field or "") for field in item.get("fields", []) if str(field or "")],
        }
        for item in changed_files
        if str(item.get("path") or "")
    }
    for path, _entry, repairs in repair_jobs:
        if path not in changed_file_map or "album" not in repairs:
            continue
        refreshed_entry = dict(updated_file_cache.get(path) or {})
        # Tag readers may omit a removed TALB frame. Keep the request-owned
        # blank in the queued snapshot so runtime and Postgres agree.
        refreshed_entry["album"] = str(repairs.get("album") or "").strip()
        updated_file_cache[path] = refreshed_entry
    try:
        normalized_exception_updates = (
            dict(exception_values_by_path)
            if tag_edit_intent_id
            else (
            save_track_exception_overrides(
                config,
                {
                    path: exception_value
                    for path, _entry, exception_value in exception_updates
                },
            )
            if exception_updates and save_track_exception_overrides is not None
            else {}
            )
        )
    except Exception as exc:
        compensation_failures: list[str] = []
        changed_fields_by_path = {
            path: set(item.get("fields") or [])
            for path, item in changed_file_map.items()
        }
        for path, entry, repairs in repair_jobs:
            reverse_repairs = {
                field: str(
                    (entry.get("release_date") or entry.get("year"))
                    if field == "year"
                    else (entry.get(field) or "")
                )
                for field in changed_fields_by_path.get(path, set())
                if field in repairs
            }
            if not reverse_repairs:
                continue
            try:
                apply_repairs_worker(path, reverse_repairs)
            except Exception as compensation_exc:
                compensation_failures.append(f"{path}: {compensation_exc}")
        error_text = f"Failed to save track exceptions: {exc}"
        if compensation_failures:
            error_text += (
                "; media compensation also failed: "
                + "; ".join(compensation_failures)
            )
        failure_payload = _record_tag_edit_failure(
            album=album,
            paths=[path for path, _entry, _value in exception_updates],
            error_text=error_text,
            config=config,
            logger=logger,
            append_log_history=append_log_history,
            log_app_event=log_app_event,
        )
        return failure_payload, 500
    for path, entry, exception_value in exception_updates:
        normalized_value = (
            normalized_exception_updates.get(path, normalize_exception_value(exception_value))
            if tag_edit_intent_id or save_track_exception_overrides is not None
            else save_track_exception_override(config, path, exception_value)
        )
        updated_file_cache[path] = update_cache_entry_after_repairs(
            Path(path),
            updated_file_cache.get(path, entry),
            {"exception_type": normalized_value},
        )
        file_change = changed_file_map.setdefault(path, {"path": path, "fields": []})
        if "exception_type" not in file_change["fields"]:
            file_change["fields"].append("exception_type")
    changed_files = list(changed_file_map.values())

    changed_paths = {str(item.get("path") or "") for item in changed_files if str(item.get("path") or "")}
    changed_field_names = {
        str(field or "")
        for item in changed_files
        for field in item.get("fields", [])
        if str(field or "")
    }
    separate_release_keys = set(st.get("separate_release_keys") or load_separate_release_keys(config))
    updated_albums = build_affected_album_dicts(
        file_cache,
        updated_file_cache,
        requested_track_paths,
        changed_paths or requested_track_paths,
        separate_release_keys,
    )
    requires_view_refresh = bool(changed_field_names & structural_edit_fields)
    task_id = ""
    if changed_files:
        task_id = create_save_task("edit-tags")
        finalizer_options: dict[str, object] = {}
        if structural_tag_edit_reservation is not None:
            finalizer_options["structural_tag_edit_reservation"] = (
                structural_tag_edit_reservation
            )
        queue_finalize_save_task(
            task_id=task_id,
            config=config,
            logger=logger,
            updated_file_cache=dict(updated_file_cache),
            previous_file_cache=dict(file_cache),
            changed_paths=set(changed_paths),
            requested_track_paths=set(requested_track_paths),
            separate_release_keys=set(separate_release_keys),
            changed_field_names=set(changed_field_names),
            tag_edit_intent_id=tag_edit_intent_id,
            exception_updates=dict(normalized_exception_updates),
            log_entry={
                "id": uuid.uuid4().hex,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "Tags edited",
                **_album_log_context(album),
                "file_count": len(changed_paths),
                "files": sorted(changed_paths),
            },
            **finalizer_options,
        )

    return {
        "ok": True,
        "changed_files": changed_files,
        "committed_values": {
            path: {
                field: str(
                    ""
                    if (updated_file_cache.get(path) or {}).get(field) is None
                    else (updated_file_cache.get(path) or {}).get(field)
                ).strip()
                for field in raw_edits
                if field in _ALLOWED_TAG_EDIT_FIELDS
            }
            for path, raw_edits in updates.items()
            if path in changed_file_map and isinstance(raw_edits, dict)
        },
        "skipped_files": skipped_files,
        "changed_count": len(changed_files),
        "updated_album": updated_albums[0] if updated_albums else None,
        "updated_albums": updated_albums,
        "updated_problematic_album": None,
        "requires_view_refresh": requires_view_refresh,
        "save_task_id": task_id,
        "tag_edit_intent_id": tag_edit_intent_id,
    }
