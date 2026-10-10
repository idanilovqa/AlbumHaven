from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from inspect import isawaitable
import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncIterator


class _BoundedExecutorAdmission:
    """Bound queued and running work submitted to an owned executor."""

    def __init__(self, executor, *, max_outstanding: int) -> None:
        self._executor = executor
        self._slots = threading.BoundedSemaphore(max(1, int(max_outstanding)))

    def submit(self, function, *args):
        if not self._slots.acquire(blocking=False):
            return None
        try:
            future = self._executor.submit(function, *args)
        except BaseException:
            self._slots.release()
            raise
        future.add_done_callback(lambda _completed: self._slots.release())
        return future

    def shutdown(self, **kwargs) -> None:
        self._executor.shutdown(**kwargs)


class _LibraryWarmupHandle:
    def __init__(self, worker: threading.Thread, stop_requested: threading.Event) -> None:
        self._worker = worker
        self._stop_requested = stop_requested

    @property
    def daemon(self) -> bool:
        return self._worker.daemon

    def request_stop(self) -> None:
        self._stop_requested.set()

    async def stop(self, *, timeout_seconds: float = 30.0) -> None:
        self.request_stop()
        await asyncio.to_thread(self._worker.join, timeout_seconds)
        if self._worker.is_alive():
            raise TimeoutError(
                "Library background warm-up did not stop within "
                f"{timeout_seconds:g} seconds."
            )


def _start_library_warmup(
    runtime,
    hydrate,
    ensure_relations,
    prewarm_postgres,
    hydrate_metadata=None,
    recover_persistence=None,
):
    stop_requested = threading.Event()
    database_url = str(
        runtime.config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
    ).strip()
    postgres_authoritative = bool(database_url)
    if postgres_authoritative:
        runtime.logger.info(
            "Startup scan-cache hydration deferred; Postgres browse remains authoritative."
        )

    def warm_library_state() -> None:
        try:
            if postgres_authoritative:
                try:
                    prewarm_postgres(database_url)
                except Exception:
                    runtime.logger.exception("Postgres connection pool prewarm failed.")
                if stop_requested.is_set():
                    return
                if recover_persistence is not None:
                    recover_persistence(runtime)
                if stop_requested.is_set():
                    return
                if hydrate_metadata is not None:
                    try:
                        hydrate_metadata(runtime)
                    except InterruptedError:
                        raise
                    except Exception:
                        runtime.logger.exception("Postgres scan timestamp hydration failed.")
                if stop_requested.is_set():
                    return
                ensure_relations(runtime, cancel_requested=stop_requested)
                return
            hydrated = hydrate(runtime)
            if stop_requested.is_set():
                return
            library_state = runtime.library_state
            if (
                hydrated
                and library_state.get("scan_metadata_repair_required")
                and not library_state.get("scan_in_progress")
            ):
                if stop_requested.is_set():
                    return
                with runtime.cold_scan_handoff_lock:
                    library_state["cold_scan_pending"] = True
                    library_state["cold_scan_force"] = True
                    library_state["cold_scan_is_cold_start"] = False
                    library_state["cold_scan_handoff_status"] = "pending"
                    library_state["cold_scan_handoff_error"] = ""
            if (
                not hydrated
                and not library_state.get("last_error")
                and not library_state.get("albums")
                and not library_state.get("file_cache")
                and not library_state.get("scan_in_progress")
                and library_state.get("cold_scan_handoff_status") == "idle"
            ):
                if stop_requested.is_set():
                    return
                with runtime.cold_scan_handoff_lock:
                    if stop_requested.is_set():
                        return
                    library_state["cold_scan_pending"] = True
                    library_state["cold_scan_handoff_status"] = "pending"
                    library_state["cold_scan_handoff_error"] = ""
        except InterruptedError:
            return
        except Exception:
            runtime.logger.exception("Library background warm-up failed.")

    worker = threading.Thread(
        target=warm_library_state,
        name="albumhaven-library-warmup",
        daemon=True,
    )
    worker.start()
    return _LibraryWarmupHandle(worker, stop_requested)


def _stop_library_watch_runtime(
    *,
    watch_service,
    event_coordinator,
    targeted_executor=None,
    targeted_reconciler=None,
) -> None:
    try:
        if watch_service is not None:
            watch_service.stop()
    finally:
        try:
            if event_coordinator is not None:
                event_coordinator.stop()
        finally:
            try:
                if targeted_reconciler is not None:
                    targeted_reconciler.stop()
            finally:
                if targeted_executor is not None:
                    targeted_executor.shutdown(wait=False, cancel_futures=True)


def _build_runtime_config() -> dict[str, object]:
    from config import APP_NAME, APP_VERSION, Config

    config = {
        key: value
        for key, value in vars(Config).items()
        if key.isupper()
    }
    config["APP_NAME"] = APP_NAME
    config["APP_VERSION"] = APP_VERSION
    return config


def _create_asgi_runtime_state():
    from music_app.services.app_logging import configure_app_logging
    from music_app.services.state import init_state

    runtime = SimpleNamespace(
        config=_build_runtime_config(),
        logger=logging.getLogger("music_app"),
        cold_scan_handoff_lock=threading.Lock(),
    )
    configure_app_logging(runtime)
    init_state(runtime)
    return runtime


def _configure_asgi_app(app, runtime) -> None:
    from fastapi.staticfiles import StaticFiles
    from fastapi.templating import Jinja2Templates

    from music_app.routes.api_read_asgi_routes import router as api_read_asgi_router
    from music_app.routes.auth_asgi import router as auth_asgi_router
    from music_app.routes.admin_asgi import router as admin_asgi_router
    from music_app.routes.account_asgi import router as account_asgi_router
    from music_app.routes.appearance_asgi import router as appearance_asgi_router
    from music_app.routes.client_layout_asgi import router as client_layout_asgi_router
    from music_app.routes.selection_accent_asgi import router as selection_accent_asgi_router
    from music_app.routes.api_wave_a_asgi_routes import router as api_wave_a_asgi_router
    from music_app.routes.api_wave_b_asgi_routes import router as api_wave_b_asgi_router
    from music_app.routes.api_wave_c_asgi_routes import router as api_wave_c_asgi_router
    from music_app.routes.api_wave_d_asgi_routes import router as api_wave_d_asgi_router
    from music_app.routes.playback_stream_asgi import (
        PlaybackPcmRegistry,
        router as playback_stream_asgi_router,
    )
    from music_app.services.waveform_peak_cache_postgres import (
        PostgresWaveformPeakCacheRepository,
    )
    from music_app.services.saved_loop_waveform_peak_cache_postgres import (
        PostgresSavedLoopWaveformPeakCacheRepository,
    )
    from music_app.services.waveform_peaks import WaveformPeaksRegistry
    from music_app.services.private_route_boundary import install_private_route_boundary
    from music_app.services.library_watch_health import (
        LibraryWatchHealthService,
        PostgresLibraryWatchHealthStore,
    )
    from music_app.routes.web_asgi import (
        _runtime_asset_version,
        router as web_asgi_router,
    )

    package_root = Path(__file__).resolve().parent
    static_dir = package_root / "static"
    template_dir = package_root / "templates"

    app.state.config = runtime.config
    app.state.media_host_library_id = None
    app.state.library_state = runtime.library_state
    app.state.logger = runtime.logger
    app.state.cold_scan_handoff_lock = runtime.cold_scan_handoff_lock
    runtime.library_watch_health_service = LibraryWatchHealthService(
        PostgresLibraryWatchHealthStore(runtime.config)
    )
    app.state.library_watch_health_service = runtime.library_watch_health_service
    app.state.playback_pcm_registry = PlaybackPcmRegistry()
    waveform_cache_repository = (
        PostgresWaveformPeakCacheRepository(runtime.config)
        if str(runtime.config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        else None
    )
    app.state.waveform_peaks_registry = WaveformPeaksRegistry(
        cache_repository=waveform_cache_repository
    )
    app.state.saved_loop_waveform_peak_cache_repository = (
        PostgresSavedLoopWaveformPeakCacheRepository(runtime.config)
        if str(runtime.config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        else None
    )
    app.state.templates = Jinja2Templates(directory=str(template_dir))
    app.state.runtime_asset_version = _runtime_asset_version()
    app.state.auth_service_lock = threading.Lock()
    app.state.database_identity_status = None
    app.state.database_identity_status_lock = threading.Lock()
    install_private_route_boundary(app)
    immutable_nested_javascript_paths = {
        "/static/js/audio-worklets/gapless-playback-processor.js",
        "/static/js/runtime/alert-components.js",
    }

    def is_versioned_live_asset(path: str) -> bool:
        if path == "/static/app.js" or path.startswith("/static/css/"):
            return True
        if path in immutable_nested_javascript_paths:
            return True
        if not path.startswith("/static/js/"):
            return False
        return "/" not in path.removeprefix("/static/js/")

    @app.middleware("http")
    async def require_runtime_javascript_revalidation(request, call_next):
        if not request.url.path.startswith("/static/"):
            cover_preview_backfill = getattr(
                app.state,
                "cover_preview_backfill",
                None,
            )
            if cover_preview_backfill is not None:
                cover_preview_backfill.note_foreground_activity()
        response = await call_next(request)
        path = request.url.path
        if (
            path == "/static/app.js"
            or path.startswith("/static/js/")
            or path.startswith("/static/css/")
        ):
            requested_versions = request.query_params.getlist("v")
            runtime_asset_version = app.state.runtime_asset_version
            if (
                response.status_code == 200
                and is_versioned_live_asset(path)
                and runtime_asset_version != "missing"
                and requested_versions == [runtime_asset_version]
            ):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                response.headers["Cache-Control"] = "no-store, max-age=0"
        if str(response.headers.get("content-type") or "").lower().startswith("text/html"):
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    app.include_router(auth_asgi_router)
    app.include_router(account_asgi_router)
    app.include_router(appearance_asgi_router)
    app.include_router(client_layout_asgi_router)
    app.include_router(selection_accent_asgi_router)
    app.include_router(admin_asgi_router)
    app.include_router(web_asgi_router)
    app.include_router(api_read_asgi_router)
    app.include_router(api_wave_a_asgi_router)
    app.include_router(api_wave_b_asgi_router)
    app.include_router(api_wave_c_asgi_router)
    app.include_router(api_wave_d_asgi_router)
    app.include_router(playback_stream_asgi_router)


def create_asgi_app():
    from fastapi import FastAPI

    from config import APP_NAME, APP_VERSION
    from music_app.services.cover_preview_backfill import CoverPreviewBackfill
    from music_app.services.library_reconciliation import (
        LibraryWatchService,
        WatchdogLibraryEventSource,
    )
    from music_app.services.library_roots import get_library_roots
    from music_app.services.library_event_coordinator import (
        CoordinatorProblem,
        LibraryEventCoordinator,
    )
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository
    from music_app.services.watcher_recovery_postgres import (
        PostgresWatcherRecoveryRepository,
    )
    from music_app.services.cover_jobs_postgres import PostgresCoverJobRepository
    from music_app.services.runtime_shutdown import request_runtime_shutdown
    from music_app.services.postgres_connections import prewarm_connection_pool
    from music_app.services.state import (
        ensure_runtime_relation_projection_ready,
        hydrate_runtime_library_state_on_startup,
        hydrate_runtime_scan_metadata_on_startup,
        recover_runtime_library_persistence_on_startup,
    )

    runtime = _create_asgi_runtime_state()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        for template_name in _app.state.templates.env.list_templates():
            _app.state.templates.env.get_template(template_name)
        from music_app.services.log_history import resolve_media_host_history_scope
        host_scope = resolve_media_host_history_scope(runtime.config)
        _app.state.media_host_library_id = host_scope.library_id if host_scope is not None else None
        _app.state.cover_preview_backfill = CoverPreviewBackfill(
            runtime.config,
            logger=runtime.logger,
        )
        _app.state.library_warmup_thread = None
        targeted_database_url = str(
            runtime.config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        targeted_roots = (
            tuple(get_library_roots(runtime.config))
            if targeted_database_url
            else ()
        )
        runtime.library_event_coordinator = None
        runtime.library_watch_service = None

        async def shutdown_resources() -> None:
            warmup = _app.state.library_warmup_thread
            if warmup is not None:
                warmup.request_stop()
            shutdown_errors: list[tuple[str, BaseException]] = []
            shutdown_stages = (
                (
                    "cover preview backfill",
                    _app.state.cover_preview_backfill.stop,
                ),
                (
                    "library warmup",
                    warmup.stop if warmup is not None else lambda: None,
                ),
                (
                    "library filesystem watcher",
                    lambda: _stop_library_watch_runtime(
                        watch_service=runtime.library_watch_service,
                        event_coordinator=runtime.library_event_coordinator,
                    ),
                ),
                ("waveform peaks", _app.state.waveform_peaks_registry.shutdown),
                ("playback PCM", _app.state.playback_pcm_registry.shutdown),
                ("runtime", lambda: request_runtime_shutdown(runtime)),
            )
            for stage, shutdown in shutdown_stages:
                try:
                    result = shutdown()
                    if isawaitable(result):
                        await result
                except BaseException as exc:
                    shutdown_errors.append((stage, exc))
            if shutdown_errors:
                details = "; ".join(
                    f"{stage}: {error}" for stage, error in shutdown_errors
                )
                raise RuntimeError(
                    f"application shutdown failed: {details}"
                ) from shutdown_errors[0][1]

        scan_jobs = PostgresScanJobRepository(
            database_url=targeted_database_url
        )
        _app.state.scan_job_repository = scan_jobs
        _app.state.cover_job_repository = (
            PostgresCoverJobRepository(database_url=targeted_database_url)
            if targeted_database_url
            else None
        )
        from music_app.services.lastfm_retry_jobs_postgres import (
            PostgresLastfmRetryJobRepository,
        )

        _app.state.lastfm_retry_job_repository = (
            PostgresLastfmRetryJobRepository(database_url=targeted_database_url)
            if targeted_database_url
            else None
        )
        watcher_library_id = (
            host_scope.library_id if targeted_database_url and host_scope is not None else None
        )
        watcher_recovery = (
            PostgresWatcherRecoveryRepository(database_url=targeted_database_url)
            if targeted_database_url
            else None
        )
        _app.state.watcher_recovery_repository = watcher_recovery

        def configure_durable_health(library_id: int) -> None:
            from music_app.services.library_watch_health import (
                LibraryWatchHealthService,
                PostgresLibraryWatchHealthStore,
            )

            if watcher_recovery is None:
                return
            if runtime.library_watch_health_service.uses_durable_repository(
                watcher_recovery,
                library_id,
            ):
                return
            durable_health_service = LibraryWatchHealthService(watcher_recovery)
            if durable_health_service is not runtime.library_watch_health_service:
                durable_health_service.configure_mixed_version_read(
                    legacy_store=PostgresLibraryWatchHealthStore(runtime.config),
                    library_id=library_id,
                )
                runtime.library_watch_health_service = durable_health_service
                _app.state.library_watch_health_service = durable_health_service

        if watcher_library_id is not None:
            configure_durable_health(watcher_library_id)

        def watcher_library() -> int | None:
            nonlocal watcher_library_id
            if host_scope is None and targeted_database_url:
                watcher_library_id = scan_jobs.resolve_local_library_id()
                if watcher_library_id is not None:
                    _app.state.media_host_library_id = watcher_library_id
                    configure_durable_health(watcher_library_id)
            return watcher_library_id

        def observation_time(value) -> datetime:
            if not isinstance(value, datetime):
                return datetime.now(timezone.utc)
            if value.tzinfo is None:
                raise ValueError("watcher observation time must be timezone-aware")
            return value.astimezone(timezone.utc)

        def accept_library_watch_event(event) -> None:
            library_id = watcher_library()
            if library_id is None or watcher_recovery is None:
                raise RuntimeError("durable watcher admission is unavailable")
            watcher_recovery.accept_event(
                library_id=library_id,
                event=event,
                accepted_at=observation_time(event.observed_at),
            )

        def persist_library_watch_problem(problem) -> None:
            library_id = watcher_library()
            if library_id is None or watcher_recovery is None:
                raise RuntimeError("durable watcher admission is unavailable")
            watcher_recovery.record_problem(
                library_id=library_id,
                problem=problem,
                observed_at=datetime.now(timezone.utc),
            )

        try:
            runtime.library_event_coordinator = LibraryEventCoordinator(
                accept_library_watch_event,
                record_problem=persist_library_watch_problem,
            )
            runtime.library_watch_service = LibraryWatchService(
                WatchdogLibraryEventSource(targeted_roots),
                runtime.library_event_coordinator.accept,
            )
            _app.state.library_watch_service = runtime.library_watch_service
            _app.state.cover_preview_backfill.start()
            _app.state.library_warmup_thread = _start_library_warmup(
                runtime,
                hydrate_runtime_library_state_on_startup,
                ensure_runtime_relation_projection_ready,
                prewarm_connection_pool,
                hydrate_metadata=hydrate_runtime_scan_metadata_on_startup,
                recover_persistence=recover_runtime_library_persistence_on_startup,
            )
        except BaseException:
            await shutdown_resources()
            raise

        def replace_live_library_roots(roots) -> None:
            root_definitions = tuple(dict(root) for root in roots)
            try:
                runtime.library_watch_service.replace_roots(root_definitions)
            except Exception:
                for root in root_definitions:
                    persist_library_watch_problem(CoordinatorProblem("root_unavailable", str(root.get("id") or "")))
                raise

        runtime.replace_library_watch_roots = replace_live_library_roots
        _app.state.replace_library_watch_roots = replace_live_library_roots

        try:
            runtime.library_watch_service.start()
        except BaseException:
            await shutdown_resources()
            raise
        try:
            yield
        finally:
            await shutdown_resources()

    app = FastAPI(
        title=APP_NAME,
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    _configure_asgi_app(app, runtime)
    return app
