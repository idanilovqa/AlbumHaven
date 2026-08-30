from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping

from music_app.services.app_logging import log_app_event
from music_app.services.cover_refresh_execution import run_cover_jobs
from music_app.services.cover_refresh_jobs import (
    log_cover_refresh_completion,
    select_background_cover_refresh_jobs,
    select_manual_bulk_cover_refresh_jobs,
    select_manual_track_cover_refresh_jobs,
)
from music_app.services.cover_refresh_runtime import (
    refresh_cover_artwork_for_track_paths_request,
    refresh_cover_artwork_request,
    refresh_unsuccessful_cover_artwork_request,
    start_background_cover_refresh_request,
    start_manual_cover_refresh_request,
)
from music_app.services.cover_refresh_planning import build_cover_refresh_jobs
from music_app.services.exception_overrides import load_exception_overrides
from music_app.services.library_hydration import (
    hydrate_library_state_from_disk,
    refresh_cached_cover_paths_in_library_state,
)
from music_app.services.library_indexing import ScanCancelled, scan_library_file_cache
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.ignored_repairs import migrate_legacy_album_exclusions
from music_app.services.startup_bootstrap import library_browse_postgres_is_effective
from music_app.services.cache import save_cache_to_disk_for_config
from music_app.services.library_roots import get_library_roots, iter_library_root_paths, library_root_cache_identity
from music_app.services.local_mbid_assertions import (
    queue_post_scan_artist_mbid_assertion_follow_up,
    run_post_scan_artist_mbid_assertion_follow_up,
)
from music_app.services.relation_state import (
    empty_relation_views,
    ensure_relation_views,
    refresh_relation_views_in_state,
)
from music_app.services.cover_provider_cache import _BULK_NEGATIVE_CACHE_TTL_SECONDS
from music_app.services.runtime_shutdown import create_daemon_executor
from music_app.services.scan_state import refresh_library_state
from music_app.services.scan_cache_persistence import select_scan_cache_adapter
from music_app.services.relation_projection_postgres import (
    RELATION_PROJECTION_BUILDER_VERSION,
    ensure_relation_projection_ready,
)

_CACHE_LOCK = threading.Lock()
_SCAN_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-scan")
_HYDRATE_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-hydrate")
_COVER_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-cover")
_MBID_ASSERTION_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-mbid")
_BULK_COVER_JOB_WORKERS = 1
_SCAN_FILE_ERROR_HISTORY_LIMIT = 50


def run_runtime_state_mutation_for_state(
    mutation_action: Callable[[], object],
) -> object:
    """Serialize a live-state mutation without changing scan generations."""
    with _CACHE_LOCK:
        return mutation_action()


def _bounded_file_error_history_recorder(
    config: dict[str, object],
    logger: object,
    *,
    scan_generation: int,
    summary_action: str = "Additional library file errors omitted",
    summary_id_prefix: str = "library-file-errors-omitted",
    counter_state: dict[str, int] | None = None,
) -> Callable[..., None]:
    counters = counter_state if counter_state is not None else {}
    counter_key = f"{summary_id_prefix}:{scan_generation}"

    def record_file_error(action: str, **fields: object) -> None:
        recorded_file_errors = int(counters.get(counter_key) or 0) + 1
        counters[counter_key] = recorded_file_errors
        if recorded_file_errors <= _SCAN_FILE_ERROR_HISTORY_LIMIT:
            log_app_event(
                config,
                logger,
                action,
                level="error",
                history=True,
                scan_generation=scan_generation,
                **fields,
            )
        elif recorded_file_errors == _SCAN_FILE_ERROR_HISTORY_LIMIT + 1:
            log_app_event(
                config,
                logger,
                summary_action,
                level="error",
                history=True,
                id=counter_key,
                scan_generation=scan_generation,
                detail_limit=_SCAN_FILE_ERROR_HISTORY_LIMIT,
            )

    return record_file_error


def _call_hydrate_library_state_from_disk(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    ensure_relations: bool,
    validate_cache: bool,
    queue_problematic_albums_prewarm=None,
    queue_utility_rules_prewarm=None,
    scan_cache_adapter=None,
    strict_scan_cache_load: bool = False,
    logger=None,
):
    hydrate_kwargs = {
        "ensure_relations": ensure_relations,
        "validate_cache": validate_cache,
        "ensure_relation_views": ensure_relation_views if ensure_relations else None,
        "load_exception_overrides": load_exception_overrides,
        "queue_problematic_albums_prewarm": queue_problematic_albums_prewarm,
        "queue_utility_rules_prewarm": queue_utility_rules_prewarm,
    }
    if scan_cache_adapter is not None:
        hydrate_kwargs["scan_cache_adapter"] = scan_cache_adapter
    if strict_scan_cache_load:
        hydrate_kwargs["strict_scan_cache_load"] = True
    if logger is not None:
        counter_state = library_state.get("_file_error_history_counts")
        if not isinstance(counter_state, dict):
            counter_state = {}
            library_state["_file_error_history_counts"] = counter_state
        hydrate_kwargs["record_file_error"] = _bounded_file_error_history_recorder(
            config,
            logger,
            scan_generation=int(library_state.get("scan_generation") or 0),
            summary_action="Additional library hydration file errors omitted",
            summary_id_prefix="library-hydration-file-errors-omitted",
            counter_state=counter_state,
        )
    return hydrate_library_state_from_disk(
        library_state,
        config,
        **hydrate_kwargs,
    )

def init_state(app) -> None:
    app.library_state = {
        "albums": [],
        "file_cache": {},
        "last_scan": 0.0,
        "last_error": None,
        "separate_release_keys": set(),
        "scan_in_progress": False,
        "scan_processed": 0,
        "scan_total": 0,
        "scan_started_at": 0.0,
        "scan_current_path": "",
        "scan_elapsed_seconds": 0.0,
        "scan_estimated_remaining_seconds": 0.0,
        "scan_files_per_second": 0.0,
        "scan_bytes_processed": 0,
        "scan_total_bytes": 0,
        "scan_album_folders_processed": 0,
        "scan_album_folders_total": 0,
        "scan_progress_samples": [],
        "scan_generation": 0,
        "scan_phase": "idle",
        "scan_mode": "idle",
        "scan_outcome": "idle",
        "cold_scan_pending": False,
        "cold_scan_handoff_status": "idle",
        "cold_scan_handoff_error": "",
        "cold_scan_claim_token": 0,
        "cold_scan_claimed_at": 0.0,
        "rescan_ignore_existing_cache": False,
        "scan_metadata_repair_required": False,
        "relation_views": empty_relation_views(),
        "relations_in_progress": False,
        "relations_last_built": 0.0,
        "relations_processed": 0,
        "relations_total": 0,
        "relations_phase": "Idle",
        "relations_source": "local",
        "relation_projection_ready": False,
        "relation_projection_builder_version": "",
        "relation_projection_startup_rebuilt": False,
        "relation_projection_rebuild_reason": "not_checked",
        "relation_projection_duration_ms": 0.0,
        "hydrate_in_progress": False,
        "covers_in_progress": False,
        "covers_processed": 0,
        "covers_total": 0,
        "covers_downloaded": 0,
        "covers_current_folder": "",
        "cover_path_refresh_at": 0.0,
        "cover_generation": 0,
        "pending_cover_refresh_after_scan": False,
        "pending_cover_refresh_force_search": False,
    }


def hydrate_runtime_library_state_on_startup(app) -> bool:
    from music_app.services.tag_edit_recovery import (
        reconcile_unfinished_tag_edit_intents_on_startup,
    )

    reconcile_unfinished_tag_edit_intents_on_startup(app)
    scan_cache_adapter = select_scan_cache_adapter(app.config)
    with _CACHE_LOCK:
        hydrated = _call_hydrate_library_state_from_disk(
            app.library_state,
            app.config,
            ensure_relations=False,
            validate_cache=False,
            scan_cache_adapter=scan_cache_adapter,
            strict_scan_cache_load=True,
            logger=app.logger,
        )
    if hydrated:
        migration_result = migrate_legacy_album_exclusions(app.config)
        app.logger.info(
            "Startup scan-cache hydration completed files=%s albums=%s",
            len(app.library_state.get("file_cache") or {}),
            len(app.library_state.get("albums") or []),
        )
        if migration_result["migrated_album_count"]:
            app.logger.info(
                "Legacy album exclusions migrated albums=%s removed_rules=%s created_rules=%s",
                migration_result["migrated_album_count"],
                migration_result["removed_legacy_rule_count"],
                migration_result["created_album_rule_count"],
            )
    elif app.library_state.get("last_error"):
        app.logger.warning(
            "Startup scan-cache hydration did not load a snapshot: %s",
            app.library_state.get("last_error"),
        )
    return hydrated


def ensure_runtime_relation_projection_ready(app) -> dict[str, object]:
    library_state = app.library_state
    library_state["relation_projection_ready"] = False
    try:
        result = ensure_relation_projection_ready(app.config, logger=app.logger)
    except Exception as exc:
        library_state["last_error"] = str(exc)
        library_state["relation_projection_rebuild_reason"] = "startup_rebuild_failed"
        raise
    library_state["relation_views"] = dict(result.get("relation_views") or {})
    library_state["relation_projection_ready"] = bool(result.get("ready"))
    library_state["relation_projection_builder_version"] = str(
        result.get("builder_version") or RELATION_PROJECTION_BUILDER_VERSION
    )
    library_state["relation_projection_startup_rebuilt"] = bool(
        result.get("startup_rebuilt")
    )
    library_state["relation_projection_rebuild_reason"] = str(
        result.get("rebuild_reason") or "healthy"
    )
    library_state["relation_projection_duration_ms"] = float(
        result.get("duration_ms") or 0.0
    )
    return result

def scan_percent_for_state(library_state: dict[str, object]) -> int:
    total = int(library_state.get("scan_total") or 0)
    processed = int(library_state.get("scan_processed") or 0)
    if total <= 0:
        return 0
    return int((processed / total) * 100)


def relations_percent_for_state(library_state: dict[str, object]) -> int:
    total = int(library_state.get("relations_total") or 0)
    processed = int(library_state.get("relations_processed") or 0)
    if total <= 0:
        return 0
    return int((processed / total) * 100)


def format_timestamp(value: float) -> str:
    if not value:
        return "Never"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value))


def refresh_cached_cover_paths_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    min_interval_seconds: float = 5.0,
) -> bool:
    with _CACHE_LOCK:
        return refresh_cached_cover_paths_in_library_state(
            library_state,
            config,
            min_interval_seconds=min_interval_seconds,
            now=time.time(),
        )


def cover_file_cache_snapshot_for_state(library_state: dict[str, object]) -> dict[str, dict[str, object]]:
    with _CACHE_LOCK:
        return {
            path: dict(entry) if isinstance(entry, dict) else entry
            for path, entry in dict(library_state.get("file_cache") or {}).items()
        }


def hydrate_library_state_for_config(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    ensure_relations: bool = True,
    validate_cache: bool = True,
    logger_for_prewarm=None,
) -> bool:
    queue_problematic_albums_prewarm = None
    queue_utility_rules_prewarm = None
    if logger_for_prewarm is not None:
        queue_problematic_albums_prewarm = lambda: __import__(
            "music_app.services.problematic_albums",
            fromlist=["queue_problematic_albums_prewarm"],
        ).queue_problematic_albums_prewarm(
            library_state=library_state,
            config=config,
            logger=logger_for_prewarm,
        )
        queue_utility_rules_prewarm = lambda: __import__(
            "music_app.services.utility_rules",
            fromlist=["queue_utility_rules_prewarm"],
        ).queue_utility_rules_prewarm(
            library_state=library_state,
            config=config,
            logger=logger_for_prewarm,
            load_ignored_version_keys=__import__(
                "music_app.services.ignored_versions",
                fromlist=["load_ignored_version_keys"],
            ).load_ignored_version_keys,
            load_ignored_repair_keys=__import__(
                "music_app.services.ignored_repairs",
                fromlist=["load_ignored_repair_keys"],
            ).load_ignored_repair_keys,
            album_to_dict=lambda album: __import__(
                "music_app.services.library",
                fromlist=["album_to_dict"],
            ).album_to_dict(album, config=config),
        )
    with _CACHE_LOCK:
        try:
            return _call_hydrate_library_state_from_disk(
                library_state,
                config,
                ensure_relations=ensure_relations,
                validate_cache=validate_cache,
                queue_problematic_albums_prewarm=queue_problematic_albums_prewarm,
                queue_utility_rules_prewarm=queue_utility_rules_prewarm,
                logger=logger_for_prewarm,
            )
        except ValueError as exc:
            if "runtime persistence adapter is unavailable" not in str(exc):
                raise
            library_state["last_error"] = str(exc)
            return False


def refresh_relation_views_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    seed_missing_album_ratings: bool = False,
    expected_scan_generation: int | None = None,
    expected_cover_mutation_revision: int | None = None,
    publication_state: dict[str, object] | None = None,
) -> None:
    guarded_live_repair = (
        expected_scan_generation is not None
        and publication_state is None
        and not seed_missing_album_ratings
    )
    target_state = (
        dict(library_state)
        if guarded_live_repair
        else publication_state if publication_state is not None else library_state
    )
    postgres_relation_projection = bool(
        str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    )
    snapshot_options: dict[str, object] = {
        "separate_release_keys": set(
            target_state.get("separate_release_keys") or set()
        ),
    }
    if postgres_relation_projection:
        snapshot_options["rebuild_relation_projection"] = True
    else:
        relation_views = refresh_relation_views_in_state(target_state, config)
        target_state["relation_views"] = relation_views
        snapshot_options["relation_views"] = relation_views
        snapshot_options["relations_last_built"] = float(
            target_state.get("relations_last_built") or 0.0
        )
    if expected_cover_mutation_revision is not None:
        snapshot_options["expected_cover_mutation_revision"] = (
            expected_cover_mutation_revision
        )
    if seed_missing_album_ratings:
        if expected_scan_generation is None:
            raise ValueError(
                "expected_scan_generation is required when seeding album ratings"
            )
        snapshot_options["seed_missing_album_ratings"] = True
        snapshot_options["album_rating_seed_guard"] = (
            lambda seed_action: _run_album_rating_seed_for_current_generation(
                library_state,
                expected_scan_generation,
                seed_action,
            )
        )
    elif guarded_live_repair:
        snapshot_options["publication_commit_guard"] = (
            lambda commit_action: _run_snapshot_commit_for_current_generation(
                library_state,
                expected_scan_generation,
                commit_action,
            )
        )
    def save_relation_snapshot() -> None:
        committed_relation_state = save_cache_to_disk_for_config(
            config,
            config["CACHE_PATH"],
            dict(target_state.get("file_cache") or {}),
            library_root_cache_identity(config),
            float(target_state.get("last_scan") or 0.0),
            **snapshot_options,
        )
        if postgres_relation_projection:
            if not isinstance(committed_relation_state, dict) or not isinstance(
                committed_relation_state.get("relation_views"),
                dict,
            ):
                raise RuntimeError(
                    "Postgres publication returned no canonical relation projection state."
                )
            target_state["relation_views"] = dict(
                committed_relation_state["relation_views"]
            )
            target_state["relations_last_built"] = float(
                committed_relation_state.get("relations_last_built") or 0.0
            )
            canonical_artist_total = len(
                target_state["relation_views"].get("artists") or []
            )
            target_state["relations_total"] = canonical_artist_total
            target_state["relations_processed"] = canonical_artist_total
            target_state["relations_phase"] = "Artist Family ready"
            target_state["relations_source"] = "local"
            target_state["relations_in_progress"] = False
        target_state["relation_projection_ready"] = True
        target_state["relation_projection_builder_version"] = RELATION_PROJECTION_BUILDER_VERSION

    if guarded_live_repair:
        save_relation_snapshot()
        with _CACHE_LOCK:
            if int(library_state.get("scan_generation") or 0) != expected_scan_generation:
                raise ScanCancelled()
            for key in (
                "relation_views",
                "relations_in_progress",
                "relations_processed",
                "relations_total",
                "relations_phase",
                "relations_source",
                "relations_last_built",
                "relation_projection_ready",
                "relation_projection_builder_version",
                "relation_projection_startup_rebuilt",
                "relation_projection_rebuild_reason",
                "relation_projection_duration_ms",
            ):
                if key in target_state:
                    library_state[key] = target_state[key]
        return

    save_relation_snapshot()


def _run_snapshot_commit_for_current_generation(
    library_state: dict[str, object],
    expected_scan_generation: int,
    commit_action: Callable[[], object],
) -> object:
    with _CACHE_LOCK:
        if int(library_state.get("scan_generation") or 0) != expected_scan_generation:
            raise ScanCancelled()
        return commit_action()


def _run_album_rating_seed_for_current_generation(
    library_state: dict[str, object],
    expected_scan_generation: int,
    seed_action: Callable[[], object],
) -> object:
    with _CACHE_LOCK:
        if int(library_state.get("scan_generation") or 0) != expected_scan_generation:
            raise ScanCancelled()
        result = seed_action()
        library_state["scan_committed_generation"] = expected_scan_generation
        return result

def scan_music_incremental(
    use_existing_cache: bool = True,
    *,
    config: dict[str, object],
    logger: object,
    library_state: dict[str, object],
    expected_scan_generation: int | None = None,
    publication_state: dict[str, object] | None = None,
    publish_partial_snapshot: Callable[[], None] | None = None,
) -> tuple[dict[str, dict[str, object]], float]:
    cfg = config
    configured_roots = iter_library_root_paths(cfg)
    scan_roots = [root for root in configured_roots if root.exists()]
    if not scan_roots:
        raise FileNotFoundError(
            "No configured library roots are currently available: "
            + ", ".join([str(root) for root in configured_roots] or [str(cfg["MUSIC_DIR"])])
        )
    counter_state = library_state.get("_file_error_history_counts")
    if not isinstance(counter_state, dict):
        counter_state = {}
        library_state["_file_error_history_counts"] = counter_state
    record_file_error = _bounded_file_error_history_recorder(
        cfg,
        logger,
        scan_generation=int(expected_scan_generation or 0),
        counter_state=counter_state,
    )
    return scan_library_file_cache(
        library_state,
        roots=scan_roots,
        supported_extensions=cfg["SUPPORTED_EXTENSIONS"],
        image_extensions=cfg["IMAGE_EXTENSIONS"],
        exception_overrides=load_exception_overrides(cfg),
        use_existing_cache=use_existing_cache,
        expected_scan_generation=expected_scan_generation,
        root_definitions=get_library_roots(cfg),
        publication_state=publication_state,
        publish_partial_snapshot=publish_partial_snapshot,
        record_file_error=record_file_error,
    )


def refresh_cover_artwork_for_track_paths_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    logger: object,
    track_paths: set[str],
    *,
    force_search: bool = False,
) -> dict[str, object]:
    return refresh_cover_artwork_for_track_paths_request(
        get_state=lambda: library_state,
        cache_lock=_CACHE_LOCK,
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        track_paths=track_paths,
        force_search=force_search,
        select_manual_track_cover_refresh_jobs=select_manual_track_cover_refresh_jobs,
        build_cover_jobs=build_cover_refresh_jobs,
        run_cover_jobs=run_cover_jobs,
        log_cover_refresh_completion=log_cover_refresh_completion,
    )


def refresh_unsuccessful_cover_artwork_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    logger: object,
    *,
    force_search: bool = False,
) -> dict[str, object]:
    return refresh_unsuccessful_cover_artwork_request(
        get_state=lambda: library_state,
        cache_lock=_CACHE_LOCK,
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        force_search=force_search,
        select_manual_bulk_cover_refresh_jobs=select_manual_bulk_cover_refresh_jobs,
        build_cover_jobs=build_cover_refresh_jobs,
        run_cover_jobs=run_cover_jobs,
        log_cover_refresh_completion=log_cover_refresh_completion,
        bulk_negative_cache_ttl_seconds=config.get(
            "BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS",
            _BULK_NEGATIVE_CACHE_TTL_SECONDS,
        ),
        job_workers=config.get("BULK_COVER_JOB_WORKERS", _BULK_COVER_JOB_WORKERS),
    )


def _queue_problematic_albums_prewarm_for_state(library_state, config, logger) -> None:
    if library_browse_postgres_is_effective(config):
        PostgresLibraryBrowseRepository(config).queue_utility_projection_prewarm(
            "problematic-files"
        )
        return
    __import__(
        "music_app.services.problematic_albums",
        fromlist=["queue_problematic_albums_prewarm"],
    ).queue_problematic_albums_prewarm(
        library_state=library_state,
        config=config,
        logger=logger,
    )


def _queue_utility_rules_prewarm_for_state(library_state, config, logger) -> None:
    if library_browse_postgres_is_effective(config):
        PostgresLibraryBrowseRepository(config).queue_utility_projection_prewarm("rules")
        return
    __import__(
        "music_app.services.utility_rules",
        fromlist=["queue_utility_rules_prewarm"],
    ).queue_utility_rules_prewarm(
        library_state=library_state,
        config=config,
        logger=logger,
        load_ignored_version_keys=__import__(
            "music_app.services.ignored_versions",
            fromlist=["load_ignored_version_keys"],
        ).load_ignored_version_keys,
        load_ignored_repair_keys=__import__(
            "music_app.services.ignored_repairs",
            fromlist=["load_ignored_repair_keys"],
        ).load_ignored_repair_keys,
        album_to_dict=lambda album: __import__(
            "music_app.services.library",
            fromlist=["album_to_dict"],
        ).album_to_dict(album, config=config),
    )


def _prewarm_root_browse_payload_for_state(library_state, config, logger) -> None:
    if not library_state.get("albums"):
        return

    class _RootBrowseQueryArgs:
        def get(self, key, default=None, type=None):
            value = "albums" if key == "surface" else ("1" if key == "omit_sidebar" else default)
            if type is None:
                return value
            try:
                return type(value)
            except (TypeError, ValueError):
                return default

        def getlist(self, key):
            return []

    __import__(
        "music_app.services.view_payloads",
        fromlist=["build_view_payload"],
    ).build_view_payload(
        query_args=_RootBrowseQueryArgs(),
        config=config,
        logger=logger,
        library_state=library_state,
    )


def refresh_library_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    logger: object,
    *,
    force: bool = False,
) -> None:
    def refresh_relation_views(
        *,
        seed_missing_album_ratings: bool = False,
        expected_scan_generation: int | None = None,
        expected_cover_mutation_revision: int | None = None,
        publication_state: dict[str, object] | None = None,
    ) -> None:
        options: dict[str, object] = {}
        if seed_missing_album_ratings:
            options["seed_missing_album_ratings"] = True
        if expected_scan_generation is not None:
            options["expected_scan_generation"] = expected_scan_generation
        if expected_cover_mutation_revision is not None:
            options["expected_cover_mutation_revision"] = expected_cover_mutation_revision
        if publication_state is not None:
            options["publication_state"] = publication_state
        refresh_relation_views_for_state(
            library_state,
            config,
            **options,
        )

    refresh_library_state(
        library_state,
        config=config,
        logger=logger,
        force=force,
        cache_lock=_CACHE_LOCK,
        scan_music_incremental=lambda **kwargs: scan_music_incremental(
            config=config,
            logger=logger,
            library_state=library_state,
            **kwargs,
        ),
        refresh_relation_views=refresh_relation_views,
        start_manual_cover_refresh=lambda *, force_search=False: start_manual_cover_refresh_request(
            config=config,
            logger=logger,
            get_state=lambda: library_state,
            start_background_refresh=lambda force=False, scan_mode="background": start_background_refresh_for_state(
                library_state,
                config,
                logger,
                force=force,
                scan_mode=scan_mode,
            ),
            get_file_cache_snapshot=lambda: cover_file_cache_snapshot_for_state(library_state),
            submit_cover_job=_COVER_EXECUTOR.submit,
            refresh_unsuccessful_cover_artwork=lambda *, force_search=False: refresh_unsuccessful_cover_artwork_for_state(
                library_state,
                config,
                logger,
                force_search=force_search,
            ),
            force_search=force_search,
        ),
        start_background_cover_refresh=lambda: start_background_cover_refresh_request(
            get_state=lambda: library_state,
            submit_cover_job=_COVER_EXECUTOR.submit,
            refresh_cover_artwork=lambda: refresh_cover_artwork_request(
                get_state=lambda: library_state,
                cache_lock=_CACHE_LOCK,
                config=config,
                logger=logger,
                log_app_event=log_app_event,
                select_background_cover_refresh_jobs=select_background_cover_refresh_jobs,
                build_cover_jobs=build_cover_refresh_jobs,
                run_cover_jobs=run_cover_jobs,
                log_cover_refresh_completion=log_cover_refresh_completion,
                bulk_negative_cache_ttl_seconds=config.get(
                    "BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS",
                    _BULK_NEGATIVE_CACHE_TTL_SECONDS,
                ),
                job_workers=config.get("BULK_COVER_JOB_WORKERS", _BULK_COVER_JOB_WORKERS),
            ),
        ),
        queue_problematic_albums_prewarm=lambda: _queue_problematic_albums_prewarm_for_state(
            library_state,
            config,
            logger,
        ),
        queue_utility_rules_prewarm=lambda: _queue_utility_rules_prewarm_for_state(
            library_state,
            config,
            logger,
        ),
        queue_mbid_assertion_follow_up=lambda library_state, *, previous_albums: queue_post_scan_artist_mbid_assertion_follow_up(
            library_state,
            previous_albums=previous_albums,
            config=config,
            submit_follow_up=lambda **kwargs: _MBID_ASSERTION_EXECUTOR.submit(
                _run_mbid_assertion_follow_up,
                logger,
                kwargs,
            ),
        ),
    )


def start_background_refresh_for_state(
    library_state: dict[str, object],
    config: dict[str, object],
    logger: object,
    *,
    force: bool = False,
    scan_mode: str = "background",
    accepted_state_updates: Mapping[str, object] | None = None,
) -> bool:
    with _CACHE_LOCK:
        if library_state.get("scan_in_progress"):
            return False
        if accepted_state_updates:
            library_state.update(accepted_state_updates)
        library_state["scan_in_progress"] = True
        library_state["scan_phase"] = "discovering"
        library_state["scan_mode"] = str(scan_mode or "background")
        library_state["scan_outcome"] = "running"
        library_state["last_error"] = None
        if not library_state.get("scan_started_at"):
            library_state["scan_started_at"] = time.time()
    _SCAN_EXECUTOR.submit(_refresh_library_worker, library_state, config, logger, force)
    return True


def run_authoritative_cover_commit_for_state(
    library_state: dict[str, object],
    commit_action: Callable[[], object],
) -> object:
    """Commit a cover mutation and supersede prepared in-process scans."""
    with _CACHE_LOCK:
        interrupted_scan = bool(library_state.get("scan_in_progress"))
        interrupted_mode = str(library_state.get("scan_mode") or "background")
        result = commit_action()
        library_state["scan_generation"] = int(
            library_state.get("scan_generation") or 0
        ) + 1
        library_state["scan_in_progress"] = False
        library_state["scan_mode"] = "idle"
        if interrupted_scan:
            library_state["scan_outcome"] = "cancelled"
        library_state["scan_current_path"] = ""
        library_state.pop("active_scan_preview_state", None)
        library_state.pop("scan_committed_generation", None)
        if interrupted_scan:
            library_state["cover_selection_interrupted_scan_mode"] = interrupted_mode
        return result


def take_cover_selection_interrupted_scan_mode_for_state(
    library_state: dict[str, object],
) -> str | None:
    with _CACHE_LOCK:
        value = str(
            library_state.pop("cover_selection_interrupted_scan_mode", "") or ""
        ).strip()
        if value == "manual_full_rescan":
            library_state["rescan_ignore_existing_cache"] = True
        return value or None


def cancel_background_refresh_for_state(library_state: dict[str, object]) -> bool:
    with _CACHE_LOCK:
        if not library_state.get("scan_in_progress"):
            return False
        current_generation = int(library_state.get("scan_generation") or 0)
        if int(library_state.get("scan_committed_generation") or -1) == current_generation:
            return False
        library_state["scan_generation"] = current_generation + 1
        library_state["scan_in_progress"] = False
        library_state["scan_mode"] = "idle"
        library_state["scan_outcome"] = "cancelled"
        library_state["scan_current_path"] = ""
        library_state["scan_elapsed_seconds"] = 0.0
        library_state["scan_estimated_remaining_seconds"] = 0.0
        library_state["scan_files_per_second"] = 0.0
        library_state["scan_progress_samples"] = []
        library_state["scan_phase"] = "idle"
        return True

def _refresh_library_worker(
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    force: bool,
):
    refresh_library_for_state(library_state, config, logger, force=force)


def _hydrate_library_state_worker(
    library_state: dict[str, object],
    config: dict[str, object],
    logger,
    ensure_relations: bool,
    validate_cache: bool,
    enable_prewarm: bool = True,
) -> None:
    try:
        hydrated = hydrate_library_state_for_config(
            library_state,
            config,
            ensure_relations=ensure_relations,
            validate_cache=validate_cache,
            logger_for_prewarm=logger if enable_prewarm else None,
        )
        if hydrated and not enable_prewarm:
            _prewarm_root_browse_payload_for_state(library_state, config, logger)
    except Exception as exc:
        library_state["last_error"] = str(exc)
        if logger is not None:
            logger.exception("Background library hydration failed")
    finally:
        with _CACHE_LOCK:
            library_state["hydrate_in_progress"] = False


def _run_mbid_assertion_follow_up(logger, kwargs: dict[str, object]) -> None:
    try:
        run_post_scan_artist_mbid_assertion_follow_up(**kwargs)
    except Exception:
        if logger is not None:
            logger.exception("Post-scan MBID assertion follow-up failed")
