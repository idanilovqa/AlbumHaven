from __future__ import annotations
from collections.abc import Callable
from concurrent.futures import Future
import logging
from pathlib import Path

from music_app.services.json_files import load_json_file
from music_app.services.metadata import normalize_exception_value
from music_app.services.runtime_shutdown import create_daemon_executor

_CACHE_WRITE_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-cache")
_LOGGER = logging.getLogger(__name__)
_AUTHORITATIVE_COVER_FIELDS = frozenset(
    {
        "cover_path",
        "cover_revision",
        "local_cover_width",
        "local_cover_height",
        "cover_validation_path",
        "cover_validation_mtime_ns",
        "cover_validation_size",
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    }
)
_MISSING_CACHE_FIELD = object()


def _cache_rebase_comparison_value(key: str, value: object) -> object:
    if key == "exception_type" and value is not _MISSING_CACHE_FIELD:
        return normalize_exception_value(value)
    return value


def _cache_updates_path(cache_path: Path) -> Path:
    return cache_path.with_name(f"{cache_path.stem}.updates{cache_path.suffix}")


def _payload_matches_identity(payload: dict[str, object], root_identity: object) -> bool:
    if isinstance(root_identity, Path):
        return payload.get("music_root") == str(root_identity)
    return payload.get("library_root_identity") == str(root_identity)


def serialize_file_entry(entry: dict[str, object]) -> dict[str, object]:
    serialized = {
        "path": str(entry["path"]), "mtime": entry["mtime"], "size": entry["size"],
        "album": entry["album"], "album_artist": entry["album_artist"], "title": entry["title"],
        "genre": entry.get("genre"),
        "track_number": entry["track_number"], "disc_number": entry["disc_number"], "disc_number_raw": entry.get("disc_number_raw"), "artist": entry["artist"],
        "duration_seconds": entry["duration_seconds"], "cover_path": entry.get("cover_path"),
        "cover_revision": entry.get("cover_revision"),
        "local_cover_width": entry.get("local_cover_width"), "local_cover_height": entry.get("local_cover_height"),
        "cover_validation_path": entry.get("cover_validation_path"),
        "cover_validation_mtime_ns": entry.get("cover_validation_mtime_ns"),
        "cover_validation_size": entry.get("cover_validation_size"),
        "remote_cover_url": entry.get("remote_cover_url"), "remote_cover_thumbnail_url": entry.get("remote_cover_thumbnail_url"),
        "remote_cover_source": entry.get("remote_cover_source"), "remote_cover_source_label": entry.get("remote_cover_source_label"),
        "remote_cover_album_url": entry.get("remote_cover_album_url"), "remote_cover_width": entry.get("remote_cover_width"),
        "remote_cover_height": entry.get("remote_cover_height"),
        "year": entry.get("year"), "release_date": entry.get("release_date"),
        "edition": entry.get("edition"), "album_rating": entry.get("album_rating"),
        "library_root_id": entry.get("library_root_id"), "library_root_category": entry.get("library_root_category"),
        "exception_type": entry.get("exception_type"),
    }
    if "metadata_schema_version" in entry:
        serialized["metadata_schema_version"] = entry.get("metadata_schema_version")
    return serialized

def deserialize_file_entry(entry: dict[str, object]) -> dict[str, object]:
    deserialized = {
        "path": str(entry["path"]), "mtime": float(entry["mtime"]), "size": int(entry["size"]),
        "album": str(entry.get("album") or "") if "album" in entry else "Unknown Album", "album_artist": entry.get("album_artist") or "Unknown Artist",
        "genre": entry.get("genre"),
        "title": entry.get("title") or Path(str(entry["path"])).stem, "track_number": entry.get("track_number"),
        "disc_number": entry.get("disc_number"), "disc_number_raw": entry.get("disc_number_raw"), "artist": entry.get("artist"),
        "duration_seconds": entry.get("duration_seconds"), "cover_path": entry.get("cover_path"),
        "cover_revision": entry.get("cover_revision"),
        "local_cover_width": entry.get("local_cover_width"), "local_cover_height": entry.get("local_cover_height"),
        "cover_validation_path": entry.get("cover_validation_path"),
        "cover_validation_mtime_ns": entry.get("cover_validation_mtime_ns"),
        "cover_validation_size": entry.get("cover_validation_size"),
        "remote_cover_url": entry.get("remote_cover_url"), "remote_cover_thumbnail_url": entry.get("remote_cover_thumbnail_url"),
        "remote_cover_source": entry.get("remote_cover_source"), "remote_cover_source_label": entry.get("remote_cover_source_label"),
        "remote_cover_album_url": entry.get("remote_cover_album_url"), "remote_cover_width": entry.get("remote_cover_width"),
        "remote_cover_height": entry.get("remote_cover_height"),
        "year": entry.get("year"), "edition": entry.get("edition"), "album_rating": entry.get("album_rating"),
        "library_root_id": entry.get("library_root_id"), "library_root_category": entry.get("library_root_category"),
        "exception_type": entry.get("exception_type"),
    }
    if "release_date" in entry:
        deserialized["release_date"] = entry.get("release_date")
    if "metadata_schema_version" in entry:
        deserialized["metadata_schema_version"] = entry.get("metadata_schema_version")
    return deserialized


def _sorted_text_values(values) -> list[str]:
    return sorted(
        [str(value or "").strip() for value in (values or []) if str(value or "").strip()],
        key=lambda value: value.casefold(),
    )


def serialize_relation_views(relation_views: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(relation_views, dict):
        return {}

    artists_sidebar: list[dict[str, object]] = []
    for entry in relation_views.get("artists_sidebar") or []:
        if not isinstance(entry, dict):
            continue
        artist = str(entry.get("artist") or "").strip()
        if not artist:
            continue
        artists_sidebar.append({
            "artist": artist,
            "count": int(entry.get("count") or 0),
        })

    sidebar_families: list[dict[str, object]] = []
    for entry in relation_views.get("sidebar_families") or []:
        if not isinstance(entry, dict):
            continue
        family = str(entry.get("family") or "").strip()
        label = str(entry.get("label") or family).strip()
        artists = _sorted_text_values(entry.get("artists") or [])
        if not family:
            continue
        sidebar_families.append({
            "family": family,
            "label": label,
            "artists": artists,
            "count": int(entry.get("count") or len(artists)),
        })

    return {
        "artists": _sorted_text_values(relation_views.get("artists") or []),
        "artists_sidebar": artists_sidebar,
        "family_to_artists": {
            str(family): _sorted_text_values(members)
            for family, members in (relation_views.get("family_to_artists") or {}).items()
            if str(family or "").strip()
        },
        "folder_related": {
            str(artist): _sorted_text_values(related)
            for artist, related in (relation_views.get("folder_related") or {}).items()
            if str(artist or "").strip()
        },
        "sidebar_families": sidebar_families,
        "alias_to_canonical": {
            str(alias): str(canonical)
            for alias, canonical in (relation_views.get("alias_to_canonical") or {}).items()
            if str(alias or "").strip() and str(canonical or "").strip()
        },
        "canonical_to_aliases": {
            str(canonical): _sorted_text_values(aliases)
            for canonical, aliases in (relation_views.get("canonical_to_aliases") or {}).items()
            if str(canonical or "").strip()
        },
    }


def deserialize_relation_views(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        return {}

    artists_sidebar: list[dict[str, object]] = []
    for entry in payload.get("artists_sidebar") or []:
        if not isinstance(entry, dict):
            continue
        artist = str(entry.get("artist") or "").strip()
        if not artist:
            continue
        artists_sidebar.append({
            "artist": artist,
            "count": int(entry.get("count") or 0),
        })

    sidebar_families: list[dict[str, object]] = []
    for entry in payload.get("sidebar_families") or []:
        if not isinstance(entry, dict):
            continue
        family = str(entry.get("family") or "").strip()
        label = str(entry.get("label") or family).strip()
        artists = _sorted_text_values(entry.get("artists") or [])
        if not family:
            continue
        sidebar_families.append({
            "family": family,
            "label": label,
            "artists": artists,
            "count": int(entry.get("count") or len(artists)),
        })

    return {
        "artists": _sorted_text_values(payload.get("artists") or []),
        "artists_sidebar": artists_sidebar,
        "family_to_artists": {
            str(family): set(_sorted_text_values(members))
            for family, members in (payload.get("family_to_artists") or {}).items()
            if str(family or "").strip()
        },
        "folder_related": {
            str(artist): set(_sorted_text_values(related))
            for artist, related in (payload.get("folder_related") or {}).items()
            if str(artist or "").strip()
        },
        "sidebar_families": sidebar_families,
        "alias_to_canonical": {
            str(alias): str(canonical)
            for alias, canonical in (payload.get("alias_to_canonical") or {}).items()
            if str(alias or "").strip() and str(canonical or "").strip()
        },
        "canonical_to_aliases": {
            str(canonical): _sorted_text_values(aliases)
            for canonical, aliases in (payload.get("canonical_to_aliases") or {}).items()
            if str(canonical or "").strip()
        },
    }


def _select_runtime_scan_cache_adapter(config: dict[str, object]):
    from music_app.services.scan_cache_persistence import select_scan_cache_adapter

    return select_scan_cache_adapter(config)


def _load_cache_snapshot_from_file(
    cache_path: Path,
    root_identity: object,
) -> tuple[dict[str, dict[str, object]], float, dict[str, object], float, str | None]:
    if not cache_path.exists():
        return {}, 0.0, {}, 0.0, None
    try:
        payload = load_json_file(cache_path, default={}, malformed="raise")
        if not _payload_matches_identity(payload, root_identity):
            return {}, 0.0, {}, 0.0, None
        raw_files = payload.get("files", {})
        file_cache = {path_str: deserialize_file_entry(entry) for path_str, entry in raw_files.items()}
        relation_views = deserialize_relation_views(payload.get("relation_views"))
        relations_last_built = float(payload.get("relations_last_built", 0.0) or 0.0)
        updates_path = _cache_updates_path(cache_path)
        if updates_path.exists():
            try:
                updates_payload = load_json_file(updates_path, default={}, malformed="raise")
                raw_updates = updates_payload.get("files", {})
                for path_str, entry in raw_updates.items():
                    file_cache[path_str] = deserialize_file_entry(entry)
            except Exception:
                pass
        return file_cache, float(payload.get("last_scan", 0.0)), relation_views, relations_last_built, None
    except Exception as exc:
        return {}, 0.0, {}, 0.0, f"Could not read cache file: {exc}"


def load_cache_snapshot_from_disk(
    cache_path: Path,
    root_identity: object,
) -> tuple[dict[str, dict[str, object]], float, dict[str, object], float, str | None]:
    return _load_cache_snapshot_from_file(cache_path, root_identity)


def save_cache_to_disk_for_config(
    config: dict[str, object],
    cache_path: Path,
    file_cache: dict[str, dict[str, object]],
    root_identity: object,
    last_scan: float,
    *,
    relation_views: dict[str, object] | None = None,
    relations_last_built: float | None = None,
    separate_release_keys: set[str] | None = None,
    seed_missing_album_ratings: bool = False,
    album_rating_seed_guard: Callable[[Callable[[], object]], object] | None = None,
    publication_commit_guard: Callable[[Callable[[], object]], object] | None = None,
    before_commit: Callable[[object], object] | None = None,
    expected_cover_mutation_revision: int | None = None,
    expected_inventory_mutation_revision: int | None = None,
    rebuild_relation_projection: bool = False,
) -> dict[str, object] | None:
    snapshot_options: dict[str, object] = {
        "relation_views": relation_views,
        "relations_last_built": relations_last_built,
    }
    if separate_release_keys is not None:
        snapshot_options["separate_release_keys"] = {
            str(key).strip()
            for key in separate_release_keys
            if str(key).strip()
        }
    if seed_missing_album_ratings:
        snapshot_options["seed_missing_album_ratings"] = True
        if album_rating_seed_guard is not None:
            snapshot_options["album_rating_seed_guard"] = album_rating_seed_guard
    if expected_cover_mutation_revision is not None:
        snapshot_options["expected_cover_mutation_revision"] = expected_cover_mutation_revision
    if expected_inventory_mutation_revision is not None:
        snapshot_options["expected_inventory_mutation_revision"] = (
            expected_inventory_mutation_revision
        )
    if publication_commit_guard is not None:
        snapshot_options["publication_commit_guard"] = publication_commit_guard
    if before_commit is not None:
        snapshot_options["before_commit"] = before_commit
    if rebuild_relation_projection:
        snapshot_options["rebuild_relation_projection"] = True
    return _select_runtime_scan_cache_adapter(config).save_snapshot(
        cache_path,
        file_cache,
        root_identity,
        last_scan,
        **snapshot_options,
    )


def save_cache_updates_to_disk_for_config(
    config: dict[str, object],
    cache_path: Path,
    changed_entries: dict[str, dict[str, object]],
    *,
    expected_cover_mutation_revision: int | None = None,
    expected_inventory_mutation_revision: int | None = None,
    baseline_file_cache: dict[str, dict[str, object]] | None = None,
    rebuild_relation_projection: bool = False,
    before_commit: Callable[[object], object] | None = None,
) -> dict[str, object] | None:
    if not changed_entries:
        return
    adapter = _select_runtime_scan_cache_adapter(config)
    from music_app.services.library_roots import library_root_cache_identity

    root_identity = library_root_cache_identity(config)
    load_cover_mutation_revision = getattr(
        adapter,
        "load_cover_mutation_revision",
        None,
    )
    if not callable(load_cover_mutation_revision):
        raise RuntimeError(
            "Scan-cache updates require a cover-mutation revision guard."
        )
    if expected_cover_mutation_revision is None:
        expected_cover_mutation_revision = int(load_cover_mutation_revision())
    load_inventory_mutation_revision = getattr(
        adapter,
        "load_inventory_mutation_revision",
        None,
    )
    if (
        expected_inventory_mutation_revision is None
        and callable(load_inventory_mutation_revision)
    ):
        expected_inventory_mutation_revision = int(
            load_inventory_mutation_revision()
        )
    file_cache, last_scan, relation_views, relations_last_built, error = adapter.load_snapshot(
        cache_path,
        root_identity,
    )
    if error:
        raise RuntimeError(error)
    intent_baseline_file_cache = (
        baseline_file_cache
        if isinstance(baseline_file_cache, dict)
        else file_cache
    )
    merged_file_cache = _rebase_non_cover_cache_entry_changes(
        baseline_file_cache=intent_baseline_file_cache,
        changed_entries=changed_entries,
        latest_file_cache=file_cache,
    )
    try:
        snapshot_options: dict[str, object] = {
            "relation_views": relation_views,
            "relations_last_built": relations_last_built,
            "expected_cover_mutation_revision": expected_cover_mutation_revision,
        }
        if expected_inventory_mutation_revision is not None:
            snapshot_options["expected_inventory_mutation_revision"] = (
                expected_inventory_mutation_revision
            )
        if rebuild_relation_projection:
            snapshot_options["rebuild_relation_projection"] = True
        if before_commit is not None:
            snapshot_options["before_commit"] = before_commit
        return adapter.save_snapshot(
            cache_path,
            merged_file_cache,
            root_identity,
            last_scan,
            **snapshot_options,
        )
    except Exception as exc:
        from music_app.services.scan_cache_persistence import (
            ScanCachePublicationSuperseded,
        )

        if not isinstance(exc, ScanCachePublicationSuperseded):
            raise
        retry_cover_mutation_revision = int(load_cover_mutation_revision())
        retry_inventory_mutation_revision = (
            int(load_inventory_mutation_revision())
            if callable(load_inventory_mutation_revision)
            else None
        )
        (
            latest_file_cache,
            latest_last_scan,
            latest_relation_views,
            latest_relations_last_built,
            latest_error,
        ) = adapter.load_snapshot(cache_path, root_identity)
        if latest_error:
            raise RuntimeError(latest_error) from exc
        rebased_file_cache = _rebase_non_cover_cache_entry_changes(
            baseline_file_cache=intent_baseline_file_cache,
            changed_entries=changed_entries,
            latest_file_cache=latest_file_cache,
        )
        retry_snapshot_options: dict[str, object] = {
            "relation_views": latest_relation_views,
            "relations_last_built": latest_relations_last_built,
            "expected_cover_mutation_revision": retry_cover_mutation_revision,
        }
        if retry_inventory_mutation_revision is not None:
            retry_snapshot_options["expected_inventory_mutation_revision"] = (
                retry_inventory_mutation_revision
            )
        if rebuild_relation_projection:
            retry_snapshot_options["rebuild_relation_projection"] = True
        if before_commit is not None:
            retry_snapshot_options["before_commit"] = before_commit
        return adapter.save_snapshot(
            cache_path,
            rebased_file_cache,
            root_identity,
            latest_last_scan,
            **retry_snapshot_options,
        )


def _rebase_non_cover_cache_entry_changes(
    *,
    baseline_file_cache: dict[str, dict[str, object]],
    changed_entries: dict[str, dict[str, object]],
    latest_file_cache: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    rebased_file_cache = dict(latest_file_cache)
    for raw_path, queued_entry in changed_entries.items():
        path = str(raw_path)
        baseline_entry = baseline_file_cache.get(path)
        latest_entry = latest_file_cache.get(path)
        if baseline_entry is None and latest_entry is None:
            rebased_file_cache[path] = {
                key: value
                for key, value in queued_entry.items()
                if key not in _AUTHORITATIVE_COVER_FIELDS
            }
            continue
        if not isinstance(baseline_entry, dict) or not isinstance(latest_entry, dict):
            raise RuntimeError(
                "Queued scan-cache update cannot rebase a missing inventory entry."
            )
        rebased_entry = dict(latest_entry)
        candidate_keys = set(baseline_entry) | set(queued_entry)
        for key in candidate_keys:
            if key in _AUTHORITATIVE_COVER_FIELDS:
                continue
            baseline_value = baseline_entry.get(key, _MISSING_CACHE_FIELD)
            queued_value = queued_entry.get(key, _MISSING_CACHE_FIELD)
            comparable_baseline_value = _cache_rebase_comparison_value(
                key,
                baseline_value,
            )
            comparable_queued_value = _cache_rebase_comparison_value(
                key,
                queued_value,
            )
            if comparable_queued_value == comparable_baseline_value:
                continue
            latest_value = latest_entry.get(key, _MISSING_CACHE_FIELD)
            comparable_latest_value = _cache_rebase_comparison_value(
                key,
                latest_value,
            )
            if (
                comparable_latest_value != comparable_baseline_value
                and comparable_latest_value != comparable_queued_value
            ):
                raise RuntimeError(
                    "Queued scan-cache update conflicts with a newer value for "
                    f"{key!r} at {path!r}."
                )
            if queued_value is _MISSING_CACHE_FIELD:
                rebased_entry.pop(key, None)
            else:
                rebased_entry[key] = queued_value
        rebased_file_cache[path] = rebased_entry
    return rebased_file_cache


def persist_cover_selection_for_tracks_for_config(
    config: dict[str, object],
    track_paths: set[str],
    selected_cover_path: Path | None,
    *,
    cover_revision: str | None = None,
    remote_cover_url: str | None = None,
    remote_cover_thumbnail_url: str | None = None,
    remote_cover_source: str | None = None,
    remote_cover_source_label: str | None = None,
    remote_cover_album_url: str | None = None,
    remote_cover_width: int | None = None,
    remote_cover_height: int | None = None,
    cover_selection_origin: str | None = None,
    reject_if_user_controlled: bool = False,
    clear_selection: bool = False,
    expected_cover_selection_origin: str | None = None,
    expected_cover_revision: str | None = None,
    commit_guard: Callable[[Callable[[], object]], object] | None = None,
    logger=None,
) -> dict[str, object]:
    del logger
    adapter = _select_runtime_scan_cache_adapter(config)
    persistence_options: dict[str, object] = {}
    if cover_revision:
        persistence_options["cover_revision"] = cover_revision
    if remote_cover_url:
        persistence_options.update(
            remote_cover_url=remote_cover_url,
            remote_cover_thumbnail_url=remote_cover_thumbnail_url,
            remote_cover_source=remote_cover_source,
            remote_cover_source_label=remote_cover_source_label,
            remote_cover_album_url=remote_cover_album_url,
            remote_cover_width=remote_cover_width,
            remote_cover_height=remote_cover_height,
        )
    if cover_selection_origin is not None:
        persistence_options["cover_selection_origin"] = cover_selection_origin
        persistence_options["reject_if_user_controlled"] = reject_if_user_controlled
    if clear_selection:
        persistence_options["clear_selection"] = True
    if expected_cover_selection_origin is not None or expected_cover_revision is not None:
        persistence_options["expected_cover_selection_origin"] = expected_cover_selection_origin
        persistence_options["expected_cover_revision"] = expected_cover_revision
    if commit_guard is not None:
        persistence_options["commit_guard"] = commit_guard
    return adapter.persist_cover_selection(
        track_paths=track_paths,
        selected_cover_path=selected_cover_path,
        **persistence_options,
    )


def persist_structural_tag_edit_for_config(
    config: dict[str, object],
    *,
    changed_paths: set[str],
    previous_file_entries: dict[str, dict[str, object]],
    updated_file_entries: dict[str, dict[str, object]],
    changed_field_names: set[str],
    commit_guard: Callable[[Callable[[], object]], object] | None = None,
    before_commit: Callable[[object], object] | None = None,
    rebuild_relation_projection: bool = False,
) -> dict[str, object]:
    adapter = _select_runtime_scan_cache_adapter(config)
    persistence_options: dict[str, object] = {}
    if commit_guard is not None:
        persistence_options["commit_guard"] = commit_guard
    if before_commit is not None:
        persistence_options["before_commit"] = before_commit
    if rebuild_relation_projection:
        persistence_options["rebuild_relation_projection"] = True
    return adapter.persist_structural_tag_edit(
        changed_paths=set(changed_paths),
        previous_file_entries=previous_file_entries,
        updated_file_entries=updated_file_entries,
        changed_field_names=set(changed_field_names),
        **persistence_options,
    )


def validate_structural_tag_edit_for_config(
    config: dict[str, object],
    *,
    changed_paths: set[str],
    previous_file_entries: dict[str, dict[str, object]],
    updated_file_entries: dict[str, dict[str, object]],
    changed_field_names: set[str],
) -> None:
    _select_runtime_scan_cache_adapter(config).validate_structural_tag_edit(
        changed_paths=set(changed_paths),
        previous_file_entries=previous_file_entries,
        updated_file_entries=updated_file_entries,
        changed_field_names=set(changed_field_names),
    )


def schedule_cache_updates_save_for_config(
    config: dict[str, object],
    cache_path: Path,
    changed_entries: dict[str, dict[str, object]],
    *,
    baseline_file_cache: dict[str, dict[str, object]] | None = None,
    rebuild_relation_projection: bool = False,
    before_commit: Callable[[object], object] | None = None,
) -> Future[dict[str, object] | None] | None:
    if not changed_entries:
        return
    snapshot = {
        str(path_str): dict(entry)
        for path_str, entry in changed_entries.items()
        if isinstance(entry, dict)
    }
    if not snapshot:
        return
    adapter = _select_runtime_scan_cache_adapter(config)
    from music_app.services.library_roots import library_root_cache_identity

    root_identity = library_root_cache_identity(config)
    if baseline_file_cache is None:
        (
            loaded_baseline_file_cache,
            _baseline_last_scan,
            _baseline_relation_views,
            _baseline_relations_last_built,
            baseline_error,
        ) = adapter.load_snapshot(cache_path, root_identity)
        if baseline_error:
            raise RuntimeError(baseline_error)
        baseline_file_cache = loaded_baseline_file_cache
    else:
        baseline_file_cache = {
            str(path): dict(entry)
            for path, entry in baseline_file_cache.items()
            if isinstance(entry, dict)
        }
    load_cover_mutation_revision = getattr(
        adapter,
        "load_cover_mutation_revision",
        None,
    )
    if not callable(load_cover_mutation_revision):
        raise RuntimeError(
            "Queued scan-cache updates require a cover-mutation revision guard."
        )
    queued_cover_mutation_revision = int(load_cover_mutation_revision())
    load_inventory_mutation_revision = getattr(
        adapter,
        "load_inventory_mutation_revision",
        None,
    )
    queued_inventory_mutation_revision = (
        int(load_inventory_mutation_revision())
        if callable(load_inventory_mutation_revision)
        else None
    )
    save_options: dict[str, object] = {
        "expected_cover_mutation_revision": queued_cover_mutation_revision,
    }
    if queued_inventory_mutation_revision is not None:
        save_options["expected_inventory_mutation_revision"] = (
            queued_inventory_mutation_revision
        )
    if rebuild_relation_projection:
        save_options["rebuild_relation_projection"] = True
    if before_commit is not None:
        save_options["before_commit"] = before_commit
    future = _CACHE_WRITE_EXECUTOR.submit(
        save_cache_updates_to_disk_for_config,
        config,
        cache_path,
        snapshot,
        baseline_file_cache=baseline_file_cache,
        **save_options,
    )
    future.add_done_callback(_log_cache_update_failure)
    return future


def _log_cache_update_failure(future) -> None:
    try:
        error = future.exception()
    except Exception:
        _LOGGER.exception("Queued scan-cache update could not report completion")
        return
    if error is not None:
        _LOGGER.error(
            "Queued scan-cache update failed without overwriting newer inventory state",
            exc_info=(type(error), error, error.__traceback__),
        )
