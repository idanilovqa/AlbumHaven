from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.background import BackgroundTask

from music_app.services.app_logging import log_app_event
from music_app.services.covers import (
    find_existing_cover_display_variant,
    normalize_cover_variant_priority,
    normalize_cover_variant_size,
    resolve_cover_display_variant,
)
from music_app.services.gallery_display import (
    DEFAULT_GALLERY_DISPLAY_MODE,
    DEFAULT_GALLERY_SCALE_PERCENT,
    normalize_gallery_display_mode,
    normalize_gallery_scale_percent,
)
from music_app.services.gallery_scope import normalize_gallery_scope, normalize_visible_categories
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library_roots import (
    configured_library_root_paths_snapshot,
    get_primary_music_root,
    resolve_album_open_directories,
    resolve_configured_media_path,
)
from music_app.services.loops import resolve_loop_media_path, resolve_loop_preview_path
from music_app.services.playlist_read_seams import build_view_surface_payload, resolve_active_view_surface
from music_app.services.runtime_shutdown import create_daemon_executor
from music_app.services.shell_layout_seams import build_shell_layout_payload
from music_app.services.startup_bootstrap import (
    COVER_CACHE_PROCESS_TOKEN,
    build_initial_view_preview,
    build_startup_preview_contract,
    library_browse_postgres_is_effective,
    normalize_selected_artist_family_display_mode,
    resolve_effective_selected_artist,
)
from music_app.services.system_open import open_in_system_file_explorer
from music_app.services import state as state_service
from music_app.services.view_payloads import build_news_payload
from version import RELEASE_VERSION

_COVER_RESPONSE_EXECUTOR = create_daemon_executor(
    max_workers=8,
    thread_name_prefix="albumhaven-cover-response",
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _app_config(request: Request):
    return request.app.state.config


def _app_logger(request: Request):
    return getattr(request.app.state, "logger", logger)


def _library_state(request: Request) -> dict[str, object]:
    return request.app.state.library_state


_COLD_SCAN_CLAIM_LEASE_SECONDS = 5.0


def _claim_pending_cold_scan(request: Request) -> int | None:
    library_state = _library_state(request)
    lock = request.app.state.cold_scan_handoff_lock
    with lock:
        status = str(library_state.get("cold_scan_handoff_status") or "idle")
        claimed_at = float(library_state.get("cold_scan_claimed_at") or 0.0)
        stale_claim = status == "claimed" and not library_state.get("scan_in_progress") and (
            time.monotonic() - claimed_at >= _COLD_SCAN_CLAIM_LEASE_SECONDS
        )
        if not library_state.get("cold_scan_pending") and not stale_claim:
            return None
        token = int(library_state.get("cold_scan_claim_token") or 0) + 1
        library_state["cold_scan_pending"] = False
        library_state["cold_scan_handoff_status"] = "claimed"
        library_state["cold_scan_handoff_error"] = ""
        library_state["cold_scan_claim_token"] = token
        library_state["cold_scan_claimed_at"] = time.monotonic()
        return token


def _cold_scan_handoff_is_active(request: Request) -> bool:
    library_state = _library_state(request)
    lock = request.app.state.cold_scan_handoff_lock
    with lock:
        status = str(library_state.get("cold_scan_handoff_status") or "idle")
        return status == "claimed" or (status == "started" and bool(library_state.get("scan_in_progress")))


def _requeue_cold_scan_claim(request: Request, token: int, error: str = "") -> None:
    library_state = _library_state(request)
    lock = request.app.state.cold_scan_handoff_lock
    with lock:
        if int(library_state.get("cold_scan_claim_token") or 0) != token:
            return
        library_state["cold_scan_pending"] = True
        library_state["cold_scan_handoff_status"] = "pending"
        library_state["cold_scan_handoff_error"] = error
        library_state["cold_scan_claimed_at"] = 0.0


def _start_claimed_cold_scan(request: Request, token: int) -> None:
    library_state = _library_state(request)
    lock = request.app.state.cold_scan_handoff_lock
    error = ""
    failure: Exception | None = None
    with lock:
        if int(library_state.get("cold_scan_claim_token") or 0) != token:
            return
        try:
            # The normal start seam mutates scan state and submits directly to
            # its executor; it does not acquire the cold-handoff lock.
            state_service.start_background_refresh_for_state(
                library_state,
                _app_config(request),
                _app_logger(request),
                force=False,
                scan_mode="background",
            )
        except Exception as exc:
            failure = exc
            error = f"Cold-start scan handoff failed: {exc}"
            library_state["scan_in_progress"] = False
            library_state["scan_phase"] = "idle"
            library_state["scan_mode"] = "idle"
            library_state["cold_scan_pending"] = True
            library_state["cold_scan_handoff_status"] = "failed"
            library_state["cold_scan_handoff_error"] = error
            library_state["cold_scan_claimed_at"] = 0.0
            library_state["last_error"] = error
        else:
            library_state["cold_scan_handoff_status"] = "started"
    if error:
        _app_logger(request).exception("Cold-start scan handoff failed", exc_info=failure)


_FLASK_NOT_FOUND_BODY = (
    "<!doctype html>\n"
    "<html lang=en>\n"
    "<title>404 Not Found</title>\n"
    "<h1>Not Found</h1>\n"
    "<p>The requested URL was not found on the server. If you entered the URL manually "
    "please check your spelling and try again.</p>\n"
)


def _not_found() -> HTMLResponse:
    return HTMLResponse(_FLASK_NOT_FOUND_BODY, status_code=404)


def _template_url_for(request: Request, name: str, **path_params: object) -> str:
    if name == "static" and "filename" in path_params:
        return "/static/" + quote(str(path_params["filename"]).lstrip("/"), safe="/")
    return str(request.url_for(name, **path_params))


def _runtime_asset_version(asset_paths: tuple[Path, ...] | None = None) -> str:
    if asset_paths is None:
        static_root = Path(__file__).resolve().parent.parent / "static"
        asset_paths = (
            static_root / "app.js",
            static_root / "js" / "runtime-bundle.js",
            static_root / "js" / "audio-worklets" / "gapless-playback-processor.js",
        )
    digest = hashlib.sha256()
    try:
        for asset_path in asset_paths:
            digest.update(asset_path.name.encode("utf-8"))
            with asset_path.open("rb") as asset_file:
                for chunk in iter(lambda: asset_file.read(64 * 1024), b""):
                    digest.update(chunk)
    except OSError:
        return "missing"
    return digest.hexdigest()[:20]


def _template_response(request: Request, context: dict[str, object]) -> Response:
    return request.app.state.templates.TemplateResponse(
        request,
        "index.html",
        {
            "request": request,
            "url_for": lambda name, **path_params: _template_url_for(request, name, **path_params),
            "runtime_asset_version": request.app.state.runtime_asset_version,
            **context,
        },
    )


def _request_targets_home_root_surface(query_args: Any, query_raw: str, selected_artist: str) -> bool:
    if str(query_args.get("surface") or "").strip():
        return False
    return _request_targets_root_albums_surface(query_args, query_raw, selected_artist)


def _request_targets_root_albums_surface(query_args: Any, query_raw: str, selected_artist: str) -> bool:
    if query_raw or selected_artist or str(query_args.get("playlist_id") or "").strip():
        return False
    if list(query_args.getlist("related_artist") or []):
        return False
    if str(query_args.get("primary_filter", "")).strip().casefold() in {"1", "true", "yes", "on"}:
        return False
    if normalize_gallery_scope(query_args.get("gallery_scope")) != "all":
        return False
    if normalize_gallery_display_mode(query_args.get("gallery_display")) != DEFAULT_GALLERY_DISPLAY_MODE:
        return False
    if normalize_gallery_scale_percent(query_args.get("gallery_scale_percent")) != DEFAULT_GALLERY_SCALE_PERCENT:
        return False
    if any(str(value or "").strip() for value in query_args.getlist("category")):
        return False
    if str(query_args.get("family_display") or "").strip():
        return False
    surface = resolve_active_view_surface(query_args.get("surface"))
    return surface in {"home", "albums"}


def _build_empty_initial_view(
    *,
    config: dict[str, object],
    query_raw: str,
    selected_artist: str,
    active_surface: str = "albums",
    requested_playlist_id: str = "",
    related_filter_artists: list[str] | None = None,
    primary_filter_active: bool = False,
    selected_artist_family_display_mode: str = "grouped",
    gallery_scope: str = "all",
    gallery_display_mode: str = DEFAULT_GALLERY_DISPLAY_MODE,
    gallery_scale_percent: int = DEFAULT_GALLERY_SCALE_PERCENT,
    visible_library_categories: list[str] | None = None,
) -> dict[str, object]:
    payload = {
        "surface": build_view_surface_payload(active_surface),
        "shell_layout": build_shell_layout_payload(
            active_surface=active_surface,
            selected_artist=selected_artist,
            has_playlist_detail=bool(str(requested_playlist_id or "").strip()),
        ),
        "artist_groups": [],
        "primary_artist_groups": [],
        "family_artist_groups": [],
        "artists_sidebar": [],
        "related_artists": [],
        "album_count": 0,
        "artist_count": 0,
        "query": query_raw,
        "selected_artist": selected_artist,
        "all_artists_active": False,
        "show_all_artists_sidebar_link": True,
        "related_filter_artists": list(related_filter_artists or []),
        "primary_filter_active": bool(primary_filter_active),
        "gallery_scope": gallery_scope,
        "gallery_display_mode": normalize_gallery_display_mode(gallery_display_mode),
        "gallery_scale_percent": normalize_gallery_scale_percent(gallery_scale_percent),
        "visible_library_categories": list(visible_library_categories or ["main_library", "hoard", "new_arrivals"]),
        "music_dir": str(get_primary_music_root(config)),
        "app_name": config.get("APP_NAME", "Album Haven"),
        "app_version": config.get("APP_VERSION", RELEASE_VERSION),
        "ignored_version_keys": [],
        "manual_version_links": {},
        "non_album_tracks": [],
        "non_album_exception_values": [],
        "initial_view_partial": False,
    }
    if selected_artist:
        payload["selected_artist_family_display_mode"] = normalize_selected_artist_family_display_mode(
            selected_artist_family_display_mode
        )
    return payload


def _build_startup_hydration_endpoint(
    query_raw: str,
    selected_artist: str,
    related_filter_artists: list[str],
    primary_filter_active: bool,
    selected_artist_family_display_mode: str,
    gallery_scope: str,
    gallery_display_mode: str,
    gallery_scale_percent: int,
    visible_library_categories: list[str],
    *,
    active_surface: str = "albums",
    payload_tier: str = "",
    omit_sidebar: bool = False,
) -> str:
    normalized_surface = resolve_active_view_surface(active_surface)
    if normalized_surface == "home":
        return "/home-data"
    params: list[tuple[str, str]] = [("surface", normalized_surface)]
    normalized_payload_tier = str(payload_tier or "").strip().casefold()
    if normalized_payload_tier:
        params.append(("payload_tier", normalized_payload_tier))
    if omit_sidebar:
        params.append(("omit_sidebar", "1"))
    if query_raw:
        params.append(("q", query_raw))
    if selected_artist:
        params.append(("artist", selected_artist))
    normalized_family_display_mode = normalize_selected_artist_family_display_mode(
        selected_artist_family_display_mode
    )
    if selected_artist and normalized_family_display_mode != "grouped":
        params.append(("family_display", normalized_family_display_mode))
    normalized_scope = normalize_gallery_scope(gallery_scope)
    normalized_categories = normalize_visible_categories(visible_library_categories, normalized_scope)
    default_categories = normalize_visible_categories([], "all")
    if normalized_scope != "all":
        params.append(("gallery_scope", normalized_scope))
    normalized_display_mode = normalize_gallery_display_mode(gallery_display_mode)
    if normalized_display_mode != DEFAULT_GALLERY_DISPLAY_MODE:
        params.append(("gallery_display", normalized_display_mode))
    normalized_scale_percent = normalize_gallery_scale_percent(gallery_scale_percent)
    if normalized_scale_percent != DEFAULT_GALLERY_SCALE_PERCENT:
        params.append(("gallery_scale_percent", str(normalized_scale_percent)))
    if normalized_scope != "all" or normalized_categories != default_categories:
        for category in normalized_categories:
            category_text = str(category or "").strip()
            if category_text:
                params.append(("category", category_text))
    for artist in related_filter_artists:
        artist_text = str(artist or "").strip()
        if artist_text:
            params.append(("related_artist", artist_text))
    if primary_filter_active:
        params.append(("primary_filter", "1"))
    endpoint = "/view-data"
    if not params:
        return endpoint
    return f"{endpoint}?{urlencode(params, doseq=True)}"


def _build_startup_hydration_contract(
    query_raw: str,
    selected_artist: str,
    related_filter_artists: list[str],
    primary_filter_active: bool,
    selected_artist_family_display_mode: str,
    gallery_scope: str,
    gallery_display_mode: str,
    gallery_scale_percent: int,
    visible_library_categories: list[str],
    preview_mode: str,
    *,
    active_surface: str,
    initial_view_partial: bool,
    embedded_view_patch: dict[str, object] | None = None,
    allow_sidebar_followup_fetch: bool = True,
) -> dict[str, object]:
    hydration_required = bool(initial_view_partial) or preview_mode == "empty_shell"
    normalized_surface = resolve_active_view_surface(active_surface)
    normalized_embedded_patch = (
        dict(embedded_view_patch)
        if isinstance(embedded_view_patch, dict)
        else None
    )
    if normalized_surface == "home":
        return {
            "required": hydration_required,
            "trigger": "after_runtime_boot" if hydration_required else "none",
            "endpoint": _build_startup_hydration_endpoint(
                query_raw,
                selected_artist,
                related_filter_artists,
                primary_filter_active,
                selected_artist_family_display_mode,
                gallery_scope,
                gallery_display_mode,
                gallery_scale_percent,
                visible_library_categories,
                active_surface=normalized_surface,
            ),
            "followupEndpoint": "",
            "embeddedViewPatch": None,
            "tier": "full",
            "reason": (
                "home_root_requires_runtime_hydration"
                if hydration_required
                else "preview_is_sufficient_for_boot"
            ),
        }
    if (
        normalized_surface == "albums"
        and normalized_embedded_patch is not None
        and list(normalized_embedded_patch.get("artists_sidebar") or [])
        and (preview_mode == "empty_shell" or initial_view_partial)
    ):
        followup_endpoint = (
            _build_startup_hydration_endpoint(
                query_raw,
                selected_artist,
                related_filter_artists,
                primary_filter_active,
                selected_artist_family_display_mode,
                gallery_scope,
                gallery_display_mode,
                gallery_scale_percent,
                visible_library_categories,
                active_surface=normalized_surface,
                omit_sidebar=True,
            )
            if allow_sidebar_followup_fetch
            else ""
        )
        return {
            "required": True,
            "trigger": "after_runtime_boot",
            "endpoint": _build_startup_hydration_endpoint(
                query_raw,
                selected_artist,
                related_filter_artists,
                primary_filter_active,
                selected_artist_family_display_mode,
                gallery_scope,
                gallery_display_mode,
                gallery_scale_percent,
                visible_library_categories,
                active_surface=normalized_surface,
                payload_tier="sidebar",
            ),
            "followupEndpoint": followup_endpoint,
            "embeddedViewPatch": normalized_embedded_patch,
            "tier": "sidebar",
            "reason": (
                "embedded_sidebar_requires_full_view_fetch"
                if allow_sidebar_followup_fetch
                else "embedded_sidebar_is_startup_complete"
            ),
        }
    if preview_mode == "empty_shell":
        reason = "empty_shell_requires_view_fetch"
    elif initial_view_partial:
        reason = "preview_requires_full_view_fetch"
    else:
        reason = "preview_is_sufficient_for_boot"
    return {
        "required": hydration_required,
        "trigger": "after_runtime_boot" if hydration_required else "none",
        "endpoint": _build_startup_hydration_endpoint(
            query_raw,
            selected_artist,
            related_filter_artists,
            primary_filter_active,
            selected_artist_family_display_mode,
            gallery_scope,
            gallery_display_mode,
            gallery_scale_percent,
            visible_library_categories,
            active_surface=normalized_surface,
        ),
        "followupEndpoint": "",
        "embeddedViewPatch": None,
        "tier": "full",
        "reason": reason,
    }


def _build_startup_preview_view(
    initial_view: dict[str, object],
    embedded_view_patch: dict[str, object] | None,
) -> dict[str, object]:
    if not isinstance(embedded_view_patch, dict):
        return initial_view
    sidebar = list(embedded_view_patch.get("artists_sidebar") or [])
    if not sidebar:
        return initial_view
    startup_preview_view = dict(initial_view)
    startup_preview_view["artists_sidebar"] = sidebar
    startup_preview_view["artist_count"] = int(
        embedded_view_patch.get("artist_count") or initial_view.get("artist_count") or len(sidebar)
    )
    startup_preview_view["album_count"] = int(
        embedded_view_patch.get("album_count") or initial_view.get("album_count") or 0
    )
    startup_preview_view["payload_tier"] = str(
        embedded_view_patch.get("payload_tier") or initial_view.get("payload_tier") or ""
    ).strip()
    return startup_preview_view


def _build_postgres_root_startup_view(
    *,
    config: dict[str, object],
    query_args: Any,
) -> tuple[dict[str, object], dict[str, object] | None, float]:
    payload_started_at = time.perf_counter()
    payload = PostgresLibraryBrowseRepository(config).build_root_sidebar_payload(
        query_params=query_args,
    )
    initial_view = build_initial_view_preview(payload)
    preview_sidebar = [
        dict(item)
        for item in list(initial_view.get("artists_sidebar") or [])
        if isinstance(item, dict) and str(item.get("artist") or "").strip()
    ]
    embedded_view_patch = None
    if preview_sidebar:
        embedded_view_patch = {
            "artist_groups": list(initial_view.get("artist_groups") or []),
            "primary_artist_groups": list(initial_view.get("primary_artist_groups") or []),
            "family_artist_groups": list(initial_view.get("family_artist_groups") or []),
            "artists_sidebar": preview_sidebar,
            "artist_count": int(payload.get("artist_count") or len(preview_sidebar)),
            "album_count": int(payload.get("album_count") or 0),
            "payload_tier": "sidebar",
        }
    payload_elapsed_ms = round((time.perf_counter() - payload_started_at) * 1000, 2)
    return initial_view, embedded_view_patch, payload_elapsed_ms


def _build_postgres_selected_artist_startup_view(
    *,
    config: dict[str, object],
    query_args: Any,
    library_state: dict[str, object],
) -> tuple[dict[str, object] | None, float]:
    selected_artist = str(query_args.get("artist") or "").strip()
    if not selected_artist:
        return None, 0.0
    payload_started_at = time.perf_counter()
    repository = PostgresLibraryBrowseRepository(config)
    payload = repository.build_selected_artist_payload(
        query_params=query_args,
        library_state=library_state,
    )
    root_sidebar: list[object] | None = None
    if not str(query_args.get("q") or "").strip():
        root_sidebar_payload = repository.build_root_sidebar_payload(
            query_params=query_args,
        )
        root_sidebar = list(
            root_sidebar_payload.get("artists_sidebar") or []
        )
        payload["artists_sidebar"] = root_sidebar
        payload["artist_count"] = int(
            root_sidebar_payload.get("artist_count")
            or len(root_sidebar)
        )
        payload["show_all_artists_sidebar_link"] = (
            root_sidebar_payload.get("show_all_artists_sidebar_link") is not False
        )
    initial_view = build_initial_view_preview(payload)
    if root_sidebar is not None:
        initial_view["artists_sidebar"] = root_sidebar
    payload_elapsed_ms = round((time.perf_counter() - payload_started_at) * 1000, 2)
    return initial_view, payload_elapsed_ms


def _build_bootstrap_payload(
    *,
    query_args: Any,
    config: dict[str, object],
    logger: object,
    library_state: dict[str, object],
    query_raw: str,
    selected_artist: str,
    refreshed: bool,
    request_started_epoch_ms: int,
) -> tuple[dict[str, object], float, dict[str, object]]:
    payload_elapsed_ms = 0.0
    library_browse_uses_postgres = library_browse_postgres_is_effective(config)
    requested_root_albums_surface = _request_targets_root_albums_surface(query_args, query_raw, selected_artist)
    requested_home_root_surface = _request_targets_home_root_surface(query_args, query_raw, selected_artist)
    active_surface = (
        "albums"
        if requested_home_root_surface
        else resolve_active_view_surface(query_args.get("surface"))
    )
    preview_mode = "empty_shell"
    embedded_view_patch = None
    if library_browse_uses_postgres:
        if requested_root_albums_surface:
            (
                initial_view,
                embedded_view_patch,
                payload_elapsed_ms,
            ) = _build_postgres_root_startup_view(
                config=config,
                query_args=query_args,
            )
            if library_state.get("cold_scan_pending") and int(initial_view.get("album_count") or 0) == 0:
                preview_mode = "empty_shell"
            else:
                preview_mode = "fresh_preview" if bool(initial_view.get("initial_view_partial")) else "full_view"
        else:
            if selected_artist:
                initial_view, payload_elapsed_ms = _build_postgres_selected_artist_startup_view(
                    config=config,
                    query_args=query_args,
                    library_state=library_state,
                )
                if initial_view is None:
                    initial_view = _build_empty_initial_view(
                        config=config,
                        query_raw=query_raw,
                        selected_artist=selected_artist,
                        active_surface=active_surface,
                        requested_playlist_id=query_args.get("playlist_id", "").strip(),
                        related_filter_artists=list(query_args.getlist("related_artist") or []),
                        primary_filter_active=str(query_args.get("primary_filter", "")).strip().casefold()
                        in {"1", "true", "yes", "on"},
                        selected_artist_family_display_mode=query_args.get("family_display"),
                        gallery_scope=str(query_args.get("gallery_scope") or "all").strip() or "all",
                        gallery_display_mode=str(query_args.get("gallery_display") or DEFAULT_GALLERY_DISPLAY_MODE).strip()
                        or DEFAULT_GALLERY_DISPLAY_MODE,
                        gallery_scale_percent=normalize_gallery_scale_percent(query_args.get("gallery_scale_percent")),
                        visible_library_categories=[
                            str(value).strip()
                            for value in query_args.getlist("category")
                            if str(value).strip()
                        ],
                    )
                    preview_mode = "empty_shell"
                else:
                    preview_mode = "fresh_preview" if bool(initial_view.get("initial_view_partial")) else "full_view"
            else:
                initial_view = _build_empty_initial_view(
                    config=config,
                    query_raw=query_raw,
                    selected_artist=selected_artist,
                    active_surface=active_surface,
                    requested_playlist_id=query_args.get("playlist_id", "").strip(),
                    related_filter_artists=list(query_args.getlist("related_artist") or []),
                    primary_filter_active=str(query_args.get("primary_filter", "")).strip().casefold()
                    in {"1", "true", "yes", "on"},
                    selected_artist_family_display_mode=query_args.get("family_display"),
                    gallery_scope=str(query_args.get("gallery_scope") or "all").strip() or "all",
                    gallery_display_mode=str(query_args.get("gallery_display") or DEFAULT_GALLERY_DISPLAY_MODE).strip()
                    or DEFAULT_GALLERY_DISPLAY_MODE,
                    gallery_scale_percent=normalize_gallery_scale_percent(query_args.get("gallery_scale_percent")),
                    visible_library_categories=[
                        str(value).strip()
                        for value in query_args.getlist("category")
                        if str(value).strip()
                    ],
                )
                preview_mode = "empty_shell"
    else:
        raise ValueError("Postgres is required for the library browse startup payload.")

    render_gallery_markup = preview_mode != "empty_shell" and (not query_raw or bool(selected_artist))
    startup_preview = build_startup_preview_contract(
        _build_startup_preview_view(initial_view, embedded_view_patch),
        preview_mode,
        render_gallery_markup=render_gallery_markup,
    )
    payload_ready_epoch_ms = int(time.time() * 1000)
    initial_view_partial = bool(initial_view.get("initial_view_partial"))
    startup_hydration = _build_startup_hydration_contract(
        query_raw,
        selected_artist,
        list(initial_view.get("related_filter_artists") or []),
        bool(initial_view.get("primary_filter_active")),
        str(initial_view.get("selected_artist_family_display_mode") or "grouped"),
        str(initial_view.get("gallery_scope") or "all"),
        str(initial_view.get("gallery_display_mode") or DEFAULT_GALLERY_DISPLAY_MODE),
        int(initial_view.get("gallery_scale_percent") or DEFAULT_GALLERY_SCALE_PERCENT),
        [
            str(value or "").strip()
            for value in list(initial_view.get("visible_library_categories") or [])
            if str(value or "").strip()
        ],
        preview_mode,
        active_surface=active_surface,
        initial_view_partial=initial_view_partial,
        embedded_view_patch=embedded_view_patch,
        allow_sidebar_followup_fetch=True,
    )
    bootstrap_payload = {
        "startup_payload": {
            "first_paint_view": initial_view,
        },
        "initial_view": initial_view,
        "bootstrap": {
            "coverCacheToken": COVER_CACHE_PROCESS_TOKEN,
            "refreshed": refreshed,
            "lastScanDisplay": state_service.format_timestamp(float(library_state.get("last_scan") or 0.0)),
            "scanInProgress": bool(library_state.get("scan_in_progress")),
            "scanPhase": str(library_state.get("scan_phase") or "idle"),
            "scanMode": str(library_state.get("scan_mode") or "idle"),
            "relationsInProgress": bool(library_state.get("relations_in_progress")),
            "relationProjection": {
                "ready": bool(library_state.get("relation_projection_ready")),
                "builderVersion": str(library_state.get("relation_projection_builder_version") or ""),
                "startupRebuilt": bool(library_state.get("relation_projection_startup_rebuilt")),
                "rebuildReason": str(library_state.get("relation_projection_rebuild_reason") or ""),
                "durationMs": float(library_state.get("relation_projection_duration_ms") or 0.0),
            },
            "coversInProgress": bool(library_state.get("covers_in_progress")),
            "partialView": initial_view_partial,
            "startupPreview": {
                "mode": preview_mode,
                "isPartial": initial_view_partial,
                "renderStrategy": "server_markup",
                "renderedGalleryMarkup": render_gallery_markup,
            },
            "startupTiming": {
                "serverRequestStartedAtEpochMs": int(request_started_epoch_ms),
                "bootstrapPayloadReadyAtEpochMs": payload_ready_epoch_ms,
                "payloadBuildMs": payload_elapsed_ms,
                "relationProjection": {
                    "ready": bool(library_state.get("relation_projection_ready")),
                    "builderVersion": str(library_state.get("relation_projection_builder_version") or ""),
                    "startupRebuilt": bool(library_state.get("relation_projection_startup_rebuilt")),
                    "rebuildReason": str(library_state.get("relation_projection_rebuild_reason") or ""),
                    "durationMs": float(library_state.get("relation_projection_duration_ms") or 0.0),
                },
            },
            "startupPayloadTiers": {
                "firstPaint": {
                    "kind": "shell_plus_preview",
                    "targetFirstPaintMs": 500,
                    "previewMode": preview_mode,
                    "includesGalleryMarkup": render_gallery_markup,
                },
                "hydration": startup_hydration,
            },
            "startupHydration": startup_hydration,
        },
    }
    return bootstrap_payload, payload_elapsed_ms, startup_preview


async def _json_payload(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _file_response(path: Path, *, max_age: int | None = None, no_cache: bool = False) -> FileResponse:
    response = FileResponse(path, filename=path.name, content_disposition_type="inline")
    if max_age is not None:
        response.headers["Cache-Control"] = f"public, max-age={max_age}"
    elif no_cache:
        response.headers["Cache-Control"] = "no-cache"
    return response


def _etag_matches(if_none_match: str, etag: str) -> bool:
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        if candidate.startswith("W/"):
            candidate = candidate[2:].strip()
        if candidate == etag:
            return True
    return False


def _not_modified_since_matches(if_modified_since: str, mtime: float) -> bool:
    try:
        parsed = parsedate_to_datetime(if_modified_since)
    except (TypeError, ValueError):
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() >= int(mtime)


def _not_modified_response(response: FileResponse) -> Response:
    headers = {
        "ETag": response.headers.get("etag", ""),
        "Cache-Control": response.headers.get("cache-control", ""),
        "Last-Modified": response.headers.get("last-modified", ""),
        "Content-Disposition": response.headers.get("content-disposition", ""),
    }
    return Response(
        status_code=304,
        headers={key: value for key, value in headers.items() if value},
    )


def _conditional_file_response(
    request: Request,
    path: Path,
    *,
    max_age: int | None = None,
    no_cache: bool = False,
) -> Response:
    stat_result = path.stat()
    response = FileResponse(
        path,
        stat_result=stat_result,
        filename=path.name,
        content_disposition_type="inline",
    )
    if max_age is not None:
        response.headers["Cache-Control"] = f"public, max-age={max_age}"
    elif no_cache:
        response.headers["Cache-Control"] = "no-cache"

    if_none_match = request.headers.get("if-none-match")
    etag = response.headers.get("etag")
    if if_none_match and etag:
        if _etag_matches(if_none_match, etag):
            return _not_modified_response(response)
        return response

    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since and _not_modified_since_matches(if_modified_since, stat_result.st_mtime):
        return _not_modified_response(response)
    return response


@router.get("/favicon.ico")
async def favicon() -> Response:
    return Response(status_code=204, headers={"Cache-Control": "public, max-age=86400"})


@router.get("/", response_class=HTMLResponse)
async def index(request: Request) -> Response:
    request_started_at = time.perf_counter()
    request_started_epoch_ms = int(time.time() * 1000)
    query_args = request.query_params
    config = _app_config(request)
    route_logger = _app_logger(request)
    library_state = _library_state(request)
    query_raw = query_args.get("q", "").strip()
    selected_artist = query_args.get("artist", "").strip()
    refreshed = query_args.get("refreshed") == "1"
    cold_scan_waiting = bool(library_state.get("cold_scan_pending")) or str(
        library_state.get("cold_scan_handoff_status") or "idle"
    ) == "claimed"
    bootstrap_payload, payload_elapsed_ms, startup_preview = _build_bootstrap_payload(
        query_args=query_args,
        config=config,
        logger=route_logger,
        library_state=library_state,
        query_raw=query_raw,
        selected_artist=selected_artist,
        refreshed=refreshed,
        request_started_epoch_ms=request_started_epoch_ms,
    )
    initial_view_partial = bool(bootstrap_payload["bootstrap"]["partialView"])
    startup_preview_mode = str(
        bootstrap_payload["bootstrap"].get("startupPreview", {}).get("mode") or "empty_shell"
    )
    started_background_refresh = False
    if cold_scan_waiting or _cold_scan_handoff_is_active(request):
        bootstrap_payload["bootstrap"]["scanInProgress"] = True
        bootstrap_payload["bootstrap"]["scanPhase"] = "discovering"
        bootstrap_payload["bootstrap"]["scanMode"] = "background"
    response = _template_response(
        request,
        {
            "query": query_raw,
            "selected_artist": selected_artist,
            "effective_selected_artist": resolve_effective_selected_artist(
                bootstrap_payload.get("initial_view")
            ),
            "music_dir": config["MUSIC_DIR"],
            "last_error": library_state.get("last_error"),
            "app_name": config.get("APP_NAME", "Album Haven"),
            "app_version": config.get("APP_VERSION", RELEASE_VERSION),
            "bootstrap_payload": bootstrap_payload,
            "startup_preview": startup_preview,
        },
    )
    claim_token = _claim_pending_cold_scan(request)
    if claim_token is not None:
        try:
            response.background = BackgroundTask(_start_claimed_cold_scan, request, claim_token)
        except Exception:
            _requeue_cold_scan_claim(request, claim_token)
            raise
        started_background_refresh = True
    total_elapsed_ms = round((time.perf_counter() - request_started_at) * 1000, 2)
    log_app_event(
        config,
        route_logger,
        "Index request completed",
        level="info",
        elapsed_ms=total_elapsed_ms,
        payload_elapsed_ms=payload_elapsed_ms,
        query=query_raw,
        selected_artist=selected_artist,
        album_count=0,
        artist_count=0,
        scan_in_progress=bool(library_state.get("scan_in_progress")) or started_background_refresh,
        hydrate_in_progress=bool(library_state.get("hydrate_in_progress")),
        covers_in_progress=bool(library_state.get("covers_in_progress")),
        bootstrap_mode=startup_preview_mode
        if initial_view_partial or startup_preview_mode != "empty_shell"
        else "shell_only",
    )
    return response


@router.get("/news", response_class=HTMLResponse)
async def news_center(request: Request) -> Response:
    query_args = request.query_params
    config = _app_config(request)
    route_logger = _app_logger(request)
    library_state = _library_state(request)
    payload = build_news_payload(
        query_args=query_args,
        tab=query_args.get("tab"),
        source=query_args.get("source"),
        config=config,
        logger=route_logger,
        library_state=library_state,
    )
    bootstrap_payload = {
        "bootstrap": {
            "appName": config.get("APP_NAME", "Album Haven"),
            "appVersion": config.get("APP_VERSION", RELEASE_VERSION),
            "requestSurface": "news",
            "resolvedSurface": "news",
            "loadedFromCache": False,
            "initialPayloadTier": "full",
            "partialView": False,
            "startupPreview": {"mode": "news_page"},
            "payloadElapsedMs": 0.0,
            "renderElapsedMs": 0.0,
            "scanInProgress": bool(library_state.get("scan_in_progress")),
            "scanMode": str(library_state.get("scan_mode") or "idle"),
            "relationsInProgress": bool(library_state.get("relations_in_progress")),
            "coversInProgress": bool(library_state.get("covers_in_progress")),
            "refreshed": False,
            "statusApiUrl": "/status",
            "startupHydration": {
                "required": False,
                "trigger": "none",
                "endpoint": "",
                "followupEndpoint": "",
                "tier": "full",
                "reason": "discovery_center_page_bootstrap",
            },
        },
        "initial_view": payload,
    }
    startup_preview = {
        "mode": "news_page",
        "sidebar_html": "",
        "related_html": "",
        "related_expanded": False,
        "has_related": False,
        "initial_view_partial": False,
    }
    return _template_response(
        request,
        {
            "query": "",
            "selected_artist": "",
            "effective_selected_artist": "",
            "music_dir": config["MUSIC_DIR"],
            "last_error": library_state.get("last_error"),
            "app_name": config.get("APP_NAME", "Album Haven"),
            "app_version": config.get("APP_VERSION", RELEASE_VERSION),
            "bootstrap_payload": bootstrap_payload,
            "startup_preview": startup_preview,
        },
    )


@router.get("/bootstrap-data")
async def bootstrap_data(request: Request) -> JSONResponse:
    request_started_epoch_ms = int(time.time() * 1000)
    query_args = request.query_params
    query_raw = query_args.get("q", "").strip()
    selected_artist = query_args.get("artist", "").strip()
    refreshed = query_args.get("refreshed") == "1"
    bootstrap_payload, _payload_elapsed_ms, _startup_preview = _build_bootstrap_payload(
        query_args=query_args,
        config=_app_config(request),
        logger=_app_logger(request),
        library_state=_library_state(request),
        query_raw=query_raw,
        selected_artist=selected_artist,
        refreshed=refreshed,
        request_started_epoch_ms=request_started_epoch_ms,
    )
    return JSONResponse(bootstrap_payload)


@router.post("/refresh-api")
async def refresh_api(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    route_logger = _app_logger(request)
    route_logger.warning(
        "refresh_api: payload keys=%s",
        list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__,
    )
    config = _app_config(request)
    library_state = _library_state(request)
    full_rescan = bool(payload.get("full_rescan"))
    accepted_state_updates: dict[str, object] = {}
    if full_rescan:
        if not library_state.get("albums"):
            state_service.hydrate_library_state_for_config(
                library_state,
                config,
                logger_for_prewarm=route_logger,
            )
        accepted_state_updates = {
            "rescan_ignore_existing_cache": True,
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
        }
    accepted = state_service.start_background_refresh_for_state(
        library_state,
        config,
        route_logger,
        # An explicit user request must bypass the cache-age early return. The
        # full-rescan flag separately controls whether the scanner may reuse
        # the existing file cache through rescan_ignore_existing_cache.
        force=True,
        scan_mode="manual_full_rescan" if full_rescan else "background",
        accepted_state_updates=accepted_state_updates,
    )
    if accepted is False:
        return JSONResponse(
            {
                "ok": False,
                "already_running": True,
                "error_code": "already_running",
                "error": "Library scan is already running.",
                "full_rescan": full_rescan,
            },
            status_code=409,
        )
    return JSONResponse({"ok": True, "full_rescan": full_rescan})


@router.post("/cancel-refresh-api")
async def cancel_refresh_api(request: Request) -> JSONResponse:
    cancelled = state_service.cancel_background_refresh_for_state(_library_state(request))
    return JSONResponse({"ok": True, "cancelled": bool(cancelled)})


@router.get("/refresh")
async def refresh(request: Request) -> RedirectResponse:
    query_args = request.query_params
    state_service.start_background_refresh_for_state(
        _library_state(request),
        _app_config(request),
        _app_logger(request),
        force=True,
        scan_mode="background",
    )
    location = "/?" + urlencode(
        [
            ("refreshed", "1"),
            ("artist", query_args.get("artist", "")),
            ("q", query_args.get("q", "")),
        ]
    )
    return RedirectResponse(location, status_code=302)


@router.get("/track")
async def track(request: Request, path: str = "") -> FileResponse:
    resolved = resolve_configured_media_path(_app_config(request), path)
    if resolved is None:
        return _not_found()
    return _conditional_file_response(request, resolved, no_cache=True)


@router.get("/loops/media/{loop_id}")
async def saved_loop_media(request: Request, loop_id: str) -> FileResponse:
    resolved = resolve_loop_media_path(_app_config(request), loop_id)
    if resolved is None:
        return _not_found()
    return _conditional_file_response(request, resolved, no_cache=True)


@router.get("/loops/pitch-preview/{preview_id}")
async def saved_loop_pitch_preview(request: Request, preview_id: str) -> FileResponse:
    resolved = resolve_loop_preview_path(_app_config(request), preview_id)
    if resolved is None:
        return _not_found()
    return _conditional_file_response(request, resolved, no_cache=True)


def _cover_response(request: Request, path: str, size: str | None) -> Response:
    config = _app_config(request)
    resolved = resolve_configured_media_path(
        config,
        path,
        configured_root_paths=configured_library_root_paths_snapshot(config),
    )
    if resolved is None:
        return _not_found()
    requested_size = normalize_cover_variant_size(size)
    if requested_size > 0:
        request_priority = normalize_cover_variant_priority(
            request.headers.get("x-album-haven-cover-priority")
        )
        try:
            cached_variant = find_existing_cover_display_variant(
                resolved,
                cache_root=Path(config["DATA_DIR"]),
                max_size=requested_size,
            )
            if cached_variant is not None:
                resolved = cached_variant
            else:
                resolved = resolve_cover_display_variant(
                    resolved,
                    cache_root=Path(config["DATA_DIR"]),
                    max_size=requested_size,
                    priority=request_priority,
                )
        except Exception:
            _app_logger(request).exception("cover: failed to prepare display variant for %s", resolved)
    return _conditional_file_response(request, resolved, max_age=300)


@router.get("/cover")
async def cover(request: Request, path: str = "", size: str | None = None) -> Response:
    return await asyncio.get_running_loop().run_in_executor(
        _COVER_RESPONSE_EXECUTOR,
        _cover_response,
        request,
        path,
        size,
    )


@router.post("/open-album-location")
async def open_album_location(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    route_logger = _app_logger(request)
    route_logger.warning(
        "open_album_location: payload keys=%s",
        list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__,
    )
    album = payload.get("album") if isinstance(payload, dict) else None
    if not isinstance(album, dict):
        route_logger.warning("open_album_location: invalid album payload=%r", album)
        return JSONResponse({"ok": False, "error": "Invalid album payload"}, status_code=400)

    route_logger.warning(
        "open_album_location: album name=%r track_count=%s",
        album.get("name"),
        len(album.get("tracks") or []),
    )
    paths = resolve_album_open_directories(_app_config(request), album)
    if not paths:
        route_logger.warning("open_album_location: no valid album paths found for album=%r", album.get("name"))
        return JSONResponse({"ok": False, "error": "No valid album paths found"}, status_code=404)

    try:
        route_logger.warning("open_album_location: opening resolved paths=%s", [str(path) for path in paths])
        open_in_system_file_explorer(paths)
    except Exception as exc:
        route_logger.exception("open_album_location: open_in_system_file_explorer failed: %s", exc)
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

    route_logger.warning("open_album_location: success opened=%s", [str(path) for path in paths])
    return JSONResponse({"ok": True, "opened": [str(path) for path in paths]})
