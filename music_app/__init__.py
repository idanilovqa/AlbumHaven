from __future__ import annotations

from contextlib import asynccontextmanager
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


def _stop_library_watch_runtime(
    *,
    watch_service,
    event_coordinator,
    targeted_executor,
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


def _recover_library_watch_after_manual_scan(
    *,
    health_service,
    targeted_reconciler,
    watch_service,
    root_definitions,
    scan_mode,
    scan_started_at,
    observed_root_ids,
) -> int:
    clear_error = None
    cleared = 0
    try:
        cleared = health_service.clear_after_scan(
            scan_mode=scan_mode,
            scan_started_at=scan_started_at,
            observed_root_ids=observed_root_ids,
        )
    except Exception as exc:
        clear_error = exc
    normalized_roots = tuple(dict(root) for root in root_definitions)
    targeted_reconciler.replace_roots(normalized_roots)
    watch_service.replace_roots(normalized_roots)
    if clear_error is not None:
        raise clear_error
    return cleared

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
    app.state.templates = Jinja2Templates(directory=str(template_dir))
    app.state.runtime_asset_version = _runtime_asset_version()
    app.state.auth_service_lock = threading.Lock()
    install_private_route_boundary(app)
    immutable_runtime_asset_paths = {
        "/static/app.js",
        "/static/js/runtime-bundle.js",
        "/static/js/audio-worklets/gapless-playback-processor.js",
    }

    @app.middleware("http")
    async def require_runtime_javascript_revalidation(request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/static/app.js" or path.startswith("/static/js/"):
            requested_versions = request.query_params.getlist("v")
            runtime_asset_version = app.state.runtime_asset_version
            if (
                response.status_code == 200
                and path in immutable_runtime_asset_paths
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
    from music_app.services.lastfm_retry import start_lastfm_retry_worker, stop_lastfm_retry_worker
    from music_app.services.library_reconciliation import (
        LibraryWatchService,
        WatchdogLibraryEventSource,
    )
    from music_app.services.library_roots import get_library_roots
    from music_app.services.library_event_coordinator import (
        CoordinatorProblem,
        LibraryEventCoordinator,
    )
    from music_app.services.exception_overrides import load_exception_overrides
    from music_app.services.runtime_shutdown import create_daemon_executor
    from music_app.services.scan_cache_persistence import select_scan_cache_adapter
    from music_app.services.save_tasks import acquire_structural_tag_edit_reservation
    from music_app.services.targeted_library_reconciliation import (
        TargetedLibraryReconciler,
    )
    from music_app.services.runtime_shutdown import request_runtime_shutdown
    from music_app.services.state import (
        ensure_runtime_relation_projection_ready,
        hydrate_runtime_library_state_on_startup,
        invalidate_targeted_library_projections,
        start_background_refresh_for_state,
    )

    runtime = _create_asgi_runtime_state()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        hydrated = hydrate_runtime_library_state_on_startup(runtime)
        ensure_runtime_relation_projection_ready(runtime)
        library_state = runtime.library_state
        if (
            hydrated
            and library_state.get("scan_metadata_repair_required")
            and not library_state.get("scan_in_progress")
        ):
            start_background_refresh_for_state(
                library_state,
                runtime.config,
                runtime.logger,
                force=True,
                scan_mode="background",
            )
        if (
            not hydrated
            and not library_state.get("last_error")
            and not library_state.get("albums")
            and not library_state.get("file_cache")
            and not library_state.get("scan_in_progress")
            and library_state.get("cold_scan_handoff_status") == "idle"
        ):
            with runtime.cold_scan_handoff_lock:
                library_state["cold_scan_pending"] = True
                library_state["cold_scan_handoff_status"] = "pending"
                library_state["cold_scan_handoff_error"] = ""
        lastfm_started = False
        targeted_executor = None
        targeted_reconciler = None
        runtime.library_event_coordinator = None
        runtime.library_watch_service = None

        async def shutdown_resources() -> None:
            runtime.config.pop("_LIBRARY_WATCH_MANUAL_RECOVERY_CALLBACK", None)
            shutdown_errors: list[tuple[str, BaseException]] = []
            shutdown_stages = (
                (
                    "library filesystem watcher",
                    lambda: _stop_library_watch_runtime(
                        watch_service=runtime.library_watch_service,
                        event_coordinator=runtime.library_event_coordinator,
                        targeted_executor=targeted_executor,
                        targeted_reconciler=targeted_reconciler,
                    ),
                ),
                (
                    "Last.fm retry worker",
                    lambda: stop_lastfm_retry_worker(runtime)
                    if lastfm_started
                    else None,
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

        lastfm_started = True
        try:
            start_lastfm_retry_worker(runtime)
            targeted_executor = _BoundedExecutorAdmission(
                create_daemon_executor(
                    max_workers=1,
                    thread_name_prefix="albumhaven-targeted-reconciliation",
                ),
                max_outstanding=256,
            )
            targeted_reconciler = TargetedLibraryReconciler(
                runtime.config,
                repository=select_scan_cache_adapter(runtime.config),
                root_definitions=get_library_roots(runtime.config),
                exception_overrides_provider=lambda: load_exception_overrides(
                    runtime.config
                ),
                after_commit=lambda result: invalidate_targeted_library_projections(
                    runtime.library_state,
                    runtime.config,
                    revision=result.revision,
                    affected_album_keys=result.affected_album_keys,
                ),
                reservation_acquirer=acquire_structural_tag_edit_reservation,
                publication_guard=runtime.library_watch_health_service.publication_guard,
            )
        except BaseException:
            await shutdown_resources()
            raise

        def targeted_request_root_ids(request) -> tuple[str, ...]:
            root_ids = {str(request.root_id)}
            for move in request.moves:
                root_ids.add(str(move.source_root_id))
                root_ids.add(str(move.destination_root_id))
            return tuple(sorted(root_id for root_id in root_ids if root_id))

        def reconcile_targeted_request(request) -> None:
            root_healthy = all(
                runtime.library_watch_health_service
                .root_allows_destructive_reconciliation(root_id)
                for root_id in targeted_request_root_ids(request)
            )
            result = targeted_reconciler.reconcile(
                request,
                root_healthy=root_healthy,
            )
            if getattr(result, "health", None) == "stable_write_unavailable":
                for root_id in targeted_request_root_ids(request):
                    persist_library_watch_problem(
                        CoordinatorProblem("stable_write_unavailable", root_id)
                    )

        def submit_targeted_reconciliation(request) -> None:
            affected_root_ids = targeted_request_root_ids(request)
            future = targeted_executor.submit(reconcile_targeted_request, request)
            if future is None:
                runtime.logger.error(
                    "Targeted library reconciliation backlog is full."
                )
                for root_id in affected_root_ids:
                    persist_library_watch_problem(
                        CoordinatorProblem("overflow", root_id)
                    )
                return

            def report_reconciliation_failure(completed) -> None:
                try:
                    completed.result()
                except Exception:
                    runtime.logger.exception(
                        "Targeted library reconciliation failed."
                    )
                    for root_id in affected_root_ids:
                        persist_library_watch_problem(
                            CoordinatorProblem(
                                "reconciliation_failed",
                                root_id,
                            )
                        )

            future.add_done_callback(report_reconciliation_failure)

        def persist_library_watch_health(event) -> None:
            try:
                runtime.library_watch_health_service.record_event(event)
            except Exception:
                runtime.logger.exception(
                    "Unable to persist library watcher health event."
                )

        def persist_library_watch_problem(problem) -> None:
            try:
                runtime.library_watch_health_service.record_problem(problem)
            except Exception:
                runtime.logger.exception(
                    "Unable to persist library watcher health problem."
                )

        try:
            runtime.library_event_coordinator = LibraryEventCoordinator(
                emit_request=submit_targeted_reconciliation,
                emit_health_event=persist_library_watch_health,
                emit_problem=persist_library_watch_problem,
                auto_schedule=True,
            )
            runtime.library_watch_service = LibraryWatchService(
                WatchdogLibraryEventSource(get_library_roots(runtime.config)),
                runtime.library_event_coordinator.accept,
            )
            _app.state.library_watch_service = runtime.library_watch_service
        except BaseException:
            await shutdown_resources()
            raise

        def replace_live_library_roots(roots) -> None:
            root_definitions = tuple(dict(root) for root in roots)
            targeted_reconciler.replace_roots(root_definitions)
            try:
                runtime.library_watch_service.replace_roots(root_definitions)
            except Exception:
                for root in root_definitions:
                    persist_library_watch_problem(CoordinatorProblem("reconciliation_failed", str(root.get("id") or "")))
                raise

        runtime.replace_library_watch_roots = replace_live_library_roots
        _app.state.replace_library_watch_roots = replace_live_library_roots

        def recover_library_watch_after_manual_scan(
            *,
            scan_mode,
            scan_started_at,
            observed_root_ids,
        ) -> int:
            return _recover_library_watch_after_manual_scan(
                health_service=runtime.library_watch_health_service,
                targeted_reconciler=targeted_reconciler,
                watch_service=runtime.library_watch_service,
                root_definitions=get_library_roots(runtime.config),
                scan_mode=scan_mode,
                scan_started_at=scan_started_at,
                observed_root_ids=observed_root_ids,
            )

        runtime.config["_LIBRARY_WATCH_MANUAL_RECOVERY_CALLBACK"] = (
            recover_library_watch_after_manual_scan
        )
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
