from __future__ import annotations

from contextlib import asynccontextmanager
from inspect import isawaitable
import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncIterator

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
    from music_app.services.runtime_shutdown import request_runtime_shutdown
    from music_app.services.state import (
        ensure_runtime_relation_projection_ready,
        hydrate_runtime_library_state_on_startup,
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
        start_lastfm_retry_worker(runtime)
        try:
            yield
        finally:
            shutdown_errors: list[tuple[str, BaseException]] = []
            shutdown_stages = (
                ("Last.fm retry worker", lambda: stop_lastfm_retry_worker(runtime)),
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
