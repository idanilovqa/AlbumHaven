from __future__ import annotations

import time
from collections.abc import Mapping
from threading import Lock
from typing import Callable

from music_app.services.app_logging import log_app_event
from music_app.services.library import build_albums_from_file_cache
from music_app.services.library_indexing import ScanCancelled
from music_app.services.library_roots import library_root_cache_identity
from music_app.services.scan_cache_persistence import (
    ScanCachePublicationSuperseded,
    select_scan_cache_adapter,
)
from music_app.services.separate_releases import load_separate_release_keys


def album_key_snapshot(albums) -> set[str]:
    return {
        str(getattr(album, "key", "") or "")
        for album in (albums or [])
        if str(getattr(album, "key", "") or "")
    }


def _scan_cache_adapter(config: dict[str, object]):
    return select_scan_cache_adapter(config)


_ACTIVE_SCAN_PREVIEW_KEY = "active_scan_preview_state"
_SCAN_PREVIEW_BROWSE_FIELDS = (
    "file_cache",
    "albums",
    "separate_release_keys",
)
_REQUEST_LOCAL_RELATION_CACHE_FIELDS = (
    "casefold_alias_to_canonical",
    "casefold_canonical_to_aliases",
)


def _build_scan_browse_snapshot(
    publication_state: Mapping[str, object],
) -> dict[str, object]:
    file_cache = publication_state.get("file_cache")
    albums = publication_state.get("albums")
    separate_release_keys = publication_state.get("separate_release_keys")
    return {
        "file_cache": {} if file_cache is None else file_cache,
        "albums": [] if albums is None else albums,
        "separate_release_keys": (
            set() if separate_release_keys is None else separate_release_keys
        ),
    }


def resolve_active_scan_browse_state(
    library_state: dict[str, object],
) -> dict[str, object]:
    if not library_state.get("scan_in_progress"):
        return library_state

    preview = library_state.get(_ACTIVE_SCAN_PREVIEW_KEY)
    if not isinstance(preview, Mapping):
        return library_state
    if int(preview.get("scan_generation") or 0) != int(
        library_state.get("scan_generation") or 0
    ):
        return library_state
    if not isinstance(preview.get("publication_state"), Mapping):
        return library_state

    browse_snapshot = preview.get("browse_snapshot")
    if not isinstance(browse_snapshot, Mapping) or any(
        field not in browse_snapshot for field in _SCAN_PREVIEW_BROWSE_FIELDS
    ):
        return library_state

    resolved_state = dict(library_state)
    resolved_state.pop(_ACTIVE_SCAN_PREVIEW_KEY, None)
    for field in _SCAN_PREVIEW_BROWSE_FIELDS:
        resolved_state[field] = browse_snapshot[field]

    relation_views = library_state.get("relation_views")
    if isinstance(relation_views, Mapping):
        request_relation_views = dict(relation_views)
        for field in _REQUEST_LOCAL_RELATION_CACHE_FIELDS:
            request_relation_views.pop(field, None)
        resolved_state["relation_views"] = request_relation_views
    return resolved_state


def _preview_matches_scan(
    library_state: dict[str, object],
    *,
    scan_generation: int,
    publication_state: dict[str, object],
) -> bool:
    preview = library_state.get(_ACTIVE_SCAN_PREVIEW_KEY)
    return (
        isinstance(preview, Mapping)
        and int(preview.get("scan_generation") or 0) == scan_generation
        and preview.get("publication_state") is publication_state
    )


def _clear_matching_scan_preview(
    library_state: dict[str, object],
    *,
    scan_generation: int,
    publication_state: dict[str, object],
) -> None:
    if _preview_matches_scan(
        library_state,
        scan_generation=scan_generation,
        publication_state=publication_state,
    ):
        library_state.pop(_ACTIVE_SCAN_PREVIEW_KEY, None)


def finalize_post_scan_actions(
    library_state: dict[str, object],
    *,
    config: dict[str, object],
    logger,
    previous_album_keys: set[str],
    start_manual_cover_refresh: Callable[..., dict[str, object]],
    start_background_cover_refresh: Callable[[], None],
) -> None:
    pending_cover_refresh = bool(library_state.get("pending_cover_refresh_after_scan"))
    pending_cover_force_search = bool(library_state.get("pending_cover_refresh_force_search"))
    if pending_cover_refresh:
        library_state["pending_cover_refresh_after_scan"] = False
        library_state["pending_cover_refresh_force_search"] = False
        log_app_event(
            config,
            logger,
            "Cover art refresh queued after indexing",
            level="info",
            reason="pending_manual_cover_refresh",
            force_search=pending_cover_force_search,
        )
        start_manual_cover_refresh(force_search=pending_cover_force_search)
        return

    current_album_keys = album_key_snapshot(library_state.get("albums", []))
    added_album_keys = current_album_keys - previous_album_keys
    if added_album_keys:
        log_app_event(
            config,
            logger,
            "Cover art refresh queued after indexing",
            level="info",
            added_album_count=len(added_album_keys),
        )
        start_background_cover_refresh()
        return

    log_app_event(
        config,
        logger,
        "Cover art refresh queued after indexing",
        level="info",
        reason="automatic_candidate_refresh",
    )
    start_background_cover_refresh()


def refresh_library_state(
    library_state: dict[str, object],
    *,
    config: dict[str, object],
    logger,
    force: bool,
    cache_lock: Lock,
    scan_music_incremental: Callable[..., tuple[dict[str, dict[str, object]], float]],
    refresh_relation_views: Callable[..., None],
    start_manual_cover_refresh: Callable[..., dict[str, object]],
    start_background_cover_refresh: Callable[[], None],
    queue_problematic_albums_prewarm: Callable[[], None] | None = None,
    queue_utility_rules_prewarm: Callable[[], None] | None = None,
    queue_mbid_assertion_follow_up: Callable[..., object] | None = None,
) -> None:
    cfg = config
    log_app_event(cfg, logger, "Library indexing started", level="info", force=force)

    def _can_skip_scan_with_cache(last_scan_value: float, file_cache_value: dict[str, object]) -> bool:
        if force:
            return False
        if not file_cache_value:
            return False
        if not last_scan_value:
            return False
        if cache_max_age <= 0:
            return True
        cache_age = time.time() - last_scan_value
        return cache_age < cache_max_age

    scan_separate_release_keys = load_separate_release_keys(cfg)
    with cache_lock:
        library_state["scan_generation"] = int(library_state.get("scan_generation") or 0) + 1
        scan_generation = int(library_state.get("scan_generation") or 0)
        library_state["last_error"] = None
        library_state["scan_outcome"] = "running"
        library_state["_file_error_history_counts"] = {}
        cache_path = cfg["CACHE_PATH"]
        cache_max_age = cfg["CACHE_MAX_AGE_SECONDS"]
        scan_cache_adapter = _scan_cache_adapter(cfg)
        existing_cache = dict(library_state.get("file_cache") or {})
        previous_album_keys = album_key_snapshot(library_state.get("albums", []))
        previous_albums = list(library_state.get("albums") or [])
        last_scan = float(library_state.get("last_scan") or 0.0)
        relation_views_missing = not library_state.get("relation_views", {}).get("artists")
        if _can_skip_scan_with_cache(last_scan, existing_cache):
            library_state["separate_release_keys"] = scan_separate_release_keys
            library_state["scan_in_progress"] = False
            library_state["scan_current_path"] = ""
            library_state["scan_phase"] = "idle"
            library_state["scan_mode"] = "idle"
            library_state["scan_outcome"] = "completed"
            log_app_event(cfg, logger, "Library indexing skipped", level="info", reason="cache_fresh")
            should_refresh_relations = relation_views_missing
            skip_scan = True
            ignore_existing_cache = False
        else:
            should_refresh_relations = False
            skip_scan = False
            library_state["scan_in_progress"] = True
            library_state["scan_started_at"] = time.time()
            ignore_existing_cache = bool(library_state.pop("rescan_ignore_existing_cache", False))

    if skip_scan:
        if should_refresh_relations:
            refresh_relation_views()
        if queue_problematic_albums_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_problematic_albums_prewarm()
        if queue_utility_rules_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_utility_rules_prewarm()
        return

    load_cover_mutation_revision = getattr(
        scan_cache_adapter,
        "load_cover_mutation_revision",
        None,
    )
    expected_cover_mutation_revision = (
        int(load_cover_mutation_revision())
        if callable(load_cover_mutation_revision)
        else None
    )
    relations_refreshed_from_disk = False
    file_cache, disk_last_scan, disk_relation_views, disk_relations_last_built, disk_error = scan_cache_adapter.load_snapshot(
        cache_path,
        library_root_cache_identity(cfg),
    )
    if disk_error:
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["last_error"] = disk_error
        log_app_event(
            cfg,
            logger,
            "Library scan cache load failed",
            level="error",
            history=True,
            error=disk_error,
            scan_generation=scan_generation,
        )

    if file_cache and (not existing_cache or disk_last_scan > last_scan):
        rebuilt_albums = build_albums_from_file_cache(file_cache, set(scan_separate_release_keys or set()))
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["file_cache"] = file_cache
                library_state["last_scan"] = disk_last_scan
                library_state["albums"] = rebuilt_albums
                if disk_relation_views:
                    library_state["relation_views"] = disk_relation_views
                if disk_relations_last_built:
                    library_state["relations_last_built"] = disk_relations_last_built
                from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
                from music_app.services.utility_rules import invalidate_utility_rules_payload_cache
                invalidate_problematic_albums_payload_cache(library_state)
                invalidate_utility_rules_payload_cache(library_state)
        with cache_lock:
            generation_is_current = (
                int(library_state.get("scan_generation") or 0) == scan_generation
            )
        if not generation_is_current:
            return
        if disk_relation_views.get("artists"):
            relations_refreshed_from_disk = True
        else:
            try:
                refresh_relation_views(
                    expected_scan_generation=scan_generation,
                )
            except ScanCancelled:
                return
            relations_refreshed_from_disk = True
        existing_cache = file_cache
        last_scan = disk_last_scan

    if _can_skip_scan_with_cache(last_scan, existing_cache):
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["separate_release_keys"] = scan_separate_release_keys
                library_state["scan_in_progress"] = False
                library_state["scan_current_path"] = ""
                library_state["scan_phase"] = "idle"
                library_state["scan_mode"] = "idle"
                library_state["scan_outcome"] = "completed"
        log_app_event(
            cfg,
            logger,
            "Library indexing skipped",
            level="info",
            reason="cache_fresh_on_disk",
        )
        if relation_views_missing and not relations_refreshed_from_disk:
            refresh_relation_views()
        if queue_problematic_albums_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_problematic_albums_prewarm()
        if queue_utility_rules_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_utility_rules_prewarm()
        return

    with cache_lock:
        if (
            int(library_state.get("scan_generation") or 0) != scan_generation
            or not library_state.get("scan_in_progress")
        ):
            return
        current_authoritative_albums = library_state.get("albums")
        publication_state = {
            "file_cache": existing_cache,
            "last_scan": last_scan,
            "separate_release_keys": scan_separate_release_keys,
            "albums": (
                []
                if current_authoritative_albums is None
                else current_authoritative_albums
            ),
            "last_error": library_state.get("last_error"),
        }
        library_state[_ACTIVE_SCAN_PREVIEW_KEY] = {
            "scan_generation": scan_generation,
            "publication_state": publication_state,
            "browse_snapshot": _build_scan_browse_snapshot(publication_state),
        }

    def publish_current_browse_snapshot() -> None:
        with cache_lock:
            if (
                int(library_state.get("scan_generation") or 0) != scan_generation
                or not library_state.get("scan_in_progress")
                or not _preview_matches_scan(
                    library_state,
                    scan_generation=scan_generation,
                    publication_state=publication_state,
                )
            ):
                raise ScanCancelled("Library indexing cancelled")
            preview = library_state.get(_ACTIVE_SCAN_PREVIEW_KEY)
            if not isinstance(preview, dict):
                raise ScanCancelled("Library indexing cancelled")
            preview["browse_snapshot"] = _build_scan_browse_snapshot(
                publication_state
            )

    scan_completed_successfully = False
    try:
        new_file_cache, new_last_scan = scan_music_incremental(
            use_existing_cache=not ignore_existing_cache,
            expected_scan_generation=scan_generation,
            publication_state=publication_state,
            publish_partial_snapshot=publish_current_browse_snapshot,
        )
        new_separate_release_keys = load_separate_release_keys(cfg)
        rebuilt_albums = build_albums_from_file_cache(new_file_cache, set(new_separate_release_keys or set()))
        with cache_lock:
            generation_is_current = (
                int(library_state.get("scan_generation") or 0) == scan_generation
            )
        if not generation_is_current:
            return
        publication_state.update({
            "file_cache": new_file_cache,
            "last_scan": new_last_scan,
            "separate_release_keys": new_separate_release_keys,
            "albums": rebuilt_albums,
            "last_error": None,
            "scan_metadata_repair_required": False,
        })
        publish_current_browse_snapshot()
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["scan_phase"] = "finalizing"
        relation_refresh_options: dict[str, object] = {
            "seed_missing_album_ratings": True,
            "expected_scan_generation": scan_generation,
            "publication_state": publication_state,
        }
        if expected_cover_mutation_revision is not None:
            relation_refresh_options["expected_cover_mutation_revision"] = (
                expected_cover_mutation_revision
            )
        refresh_relation_views(**relation_refresh_options)
        with cache_lock:
            generation_is_current = (
                int(library_state.get("scan_generation") or 0) == scan_generation
            )
            if generation_is_current:
                library_state.update(publication_state)
                _clear_matching_scan_preview(
                    library_state,
                    scan_generation=scan_generation,
                    publication_state=publication_state,
                )
                from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
                from music_app.services.utility_rules import invalidate_utility_rules_payload_cache
                invalidate_problematic_albums_payload_cache(library_state)
                invalidate_utility_rules_payload_cache(library_state)
        if not generation_is_current:
            return
        log_app_event(
            cfg,
            logger,
            "Library indexing completed",
            level="info",
            file_count=len(new_file_cache),
            album_count=len(rebuilt_albums),
        )
        if queue_problematic_albums_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_problematic_albums_prewarm()
        if queue_utility_rules_prewarm is not None and library_state.get("albums") and library_state.get("file_cache"):
            queue_utility_rules_prewarm()
        scan_completed_successfully = True
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["scan_outcome"] = "completed"
    except (ScanCancelled, ScanCachePublicationSuperseded):
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["scan_outcome"] = "cancelled"
        log_app_event(cfg, logger, "Library indexing cancelled", level="info")
    except Exception as exc:
        with cache_lock:
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                log_app_event(
                    cfg,
                    logger,
                    "Library indexing failed",
                    level="error",
                    history=True,
                    id=f"library-status-error:{scan_generation}",
                    error=str(exc),
                    scan_generation=scan_generation,
                    scan_phase=str(library_state.get("scan_phase") or ""),
                    scan_outcome="failed",
                )
                library_state["last_error"] = str(exc)
                library_state["scan_outcome"] = "failed"
    finally:
        with cache_lock:
            _clear_matching_scan_preview(
                library_state,
                scan_generation=scan_generation,
                publication_state=publication_state,
            )
            if int(library_state.get("scan_generation") or 0) == scan_generation:
                library_state["scan_current_path"] = ""
                library_state["scan_in_progress"] = False
                library_state["scan_phase"] = "idle"
                library_state["scan_mode"] = "idle"
                library_state.pop("scan_committed_generation", None)

    if scan_completed_successfully and int(library_state.get("scan_generation") or 0) == scan_generation:
        finalize_post_scan_actions(
            library_state,
            config=cfg,
            logger=logger,
            previous_album_keys=previous_album_keys,
            start_manual_cover_refresh=start_manual_cover_refresh,
            start_background_cover_refresh=start_background_cover_refresh,
        )
        if queue_mbid_assertion_follow_up is not None:
            try:
                queue_mbid_assertion_follow_up(
                    library_state,
                    previous_albums=previous_albums,
                )
            except Exception as exc:
                log_app_event(
                    cfg,
                    logger,
                    "Post-scan MBID assertion follow-up hook failed",
                    level="warning",
                    reason="post_scan_mbid_assertion_hook_failed",
                    error=str(exc),
                )
