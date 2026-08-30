from __future__ import annotations

import logging
import time
from collections.abc import Iterable, Mapping

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_edit_helpers import (
    build_problematic_album_detail_payload,
    build_problematic_albums_payload,
)
from music_app.services.app_logging import log_app_event
from music_app.services.log_history import (
    load_log_history_revision,
    load_log_history_snapshot,
)
from music_app.services.loops import load_loops
from music_app.services.state import (
    format_timestamp,
    hydrate_library_state_for_config,
    refresh_relation_views_for_state,
)
from music_app.services.opinion_read_seams import build_crowd_opinion_modal_payload
from music_app.services.page_resource_seams import (
    build_company_page_seam,
    build_person_page_seam,
    build_soundtrack_page_seam,
    build_work_page_seam,
)
from music_app.services.album_details import build_album_detail_payload
from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.listen_through import (
    apply_album_preference_overlay,
    default_album_preference_overlay,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.scan_state import resolve_active_scan_browse_state
from music_app.services.view_payloads import build_home_payload, build_view_payload
from music_app.services.client_surfaces import resolve_client_surface_class
from config import PERSISTENCE_BACKEND_POSTGRES

router = APIRouter()

_POSTGRES_SELECTED_ARTIST_PARAMS = {
    "artist",
    "q",
    "payload_tier",
    "surface",
    "gallery_scope",
    "gallery_display",
    "gallery_display_mode",
    "family_display",
    "selected_artist_family_display_mode",
    "gallery_scale_percent",
    "category",
    "omit_sidebar",
    "root_sidebar",
    "related_artist",
    "primary_filter",
    "page_mode",
    "timeline_at",
    "client_surface",
    "client_surface_class",
}

_FILE_BACKED_SELECTED_ARTIST_HYDRATION_PARAMS = _POSTGRES_SELECTED_ARTIST_PARAMS | {
    "page_mode",
    "family_display",
    "selected_artist_family_display_mode",
    "timeline_at",
    "client_surface",
    "client_surface_class",
}

_ALBUM_NOTE_MUTATION_ERROR = "Album note mutations land on the dedicated /album-notes route family in later phases."
_ALBUM_NOTE_REPLY_MUTATION_ERROR = (
    "Album note reply mutations land on the dedicated /album-note-replies route family in later phases."
)
_ALBUM_OPINION_ROUTE_FAMILY = "/album-opinions"
_ALBUM_CROWD_OPINION_ERROR = (
    "Crowd Opinion detail lands on the dedicated /album-opinions "
    "route family in later phases."
)
_RESOURCE_PAGE_TRANSPORT = "cache_only_page"
_PEOPLE_ROUTE_FAMILY = "/people"
_WORKS_ROUTE_FAMILY = "/works"
_SOUNDTRACKS_ROUTE_FAMILY = "/soundtracks"
_COMPANIES_ROUTE_FAMILY = "/companies"
_PERSON_PAGE_ERROR = (
    "Person page reads land on the dedicated /people route family in later phases."
)
_WORK_PAGE_ERROR = (
    "Work page reads land on the dedicated /works route family in later phases."
)
_SOUNDTRACK_PAGE_ERROR = (
    "Soundtrack page reads land on the dedicated /soundtracks route family in later phases."
)
_COMPANY_PAGE_ERROR = (
    "Company page reads land on the dedicated /companies route family in later phases."
)


def _app_config(request: Request):
    return request.app.state.config


def _app_logger(request: Request):
    return getattr(request.app.state, "logger", logging.getLogger("music_app.asgi.read"))


def _library_state(request: Request) -> dict[str, object]:
    return request.app.state.library_state


class _AsgiQueryArgs:
    def __init__(self, query_params):
        self._query_params = query_params

    def get(self, key: str, default=None, type=None):
        values = self._query_params.getlist(key)
        if not values:
            return default
        value = values[0]
        if type is None:
            return value
        try:
            return type(value)
        except (TypeError, ValueError):
            return default

    def getlist(self, key: str):
        return list(self._query_params.getlist(key))


def _first_query_value(request: Request, key: str) -> str | None:
    values = request.query_params.getlist(key)
    if not values:
        return None
    return values[0]


def _request_flag_value(value: object) -> bool:
    return str(value or "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _hydrate_cached_library_for_asgi(request: Request, *, ensure_relations: bool = False) -> None:
    library_state = _library_state(request)
    if library_state.get("scan_in_progress"):
        return
    if library_state.get("albums") and not ensure_relations:
        return
    hydrate_library_state_for_config(
        library_state,
        _app_config(request),
        ensure_relations=ensure_relations,
        validate_cache=False,
    )
    if ensure_relations and not (_library_state(request).get("relation_views") or {}).get("artists"):
        refresh_relation_views_for_state(library_state, _app_config(request))


def _postgres_browse_library_state(request: Request) -> Mapping[str, object] | None:
    library_state = _library_state(request)
    return library_state if isinstance(library_state, Mapping) else None


def _should_use_transient_scan_browse_state(
    library_state: Mapping[str, object],
    browse_state: Mapping[str, object],
) -> bool:
    return (
        bool(library_state.get("scan_in_progress"))
        and bool(browse_state.get("albums"))
        and not bool(library_state.get("albums"))
    )


def _transient_view_album_payloads(payload: Mapping[str, object]) -> list[dict[str, object]]:
    albums: list[dict[str, object]] = []
    seen_album_objects: set[int] = set()
    for field in ("artist_groups", "primary_artist_groups", "family_artist_groups"):
        for group in payload.get(field) or []:
            if not isinstance(group, Mapping):
                continue
            for album in group.get("albums") or []:
                if not isinstance(album, dict) or id(album) in seen_album_objects:
                    continue
                seen_album_objects.add(id(album))
                albums.append(album)
    return albums


def _apply_transient_scan_album_rating_overlays(
    request: Request,
    album_payloads: Iterable[object],
) -> None:
    if not str(_app_config(request).get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip():
        return

    albums_by_key: dict[str, list[dict[str, object]]] = {}
    for album in album_payloads:
        if not isinstance(album, dict):
            continue
        album_key = str(album.get("key") or album.get("album_ref") or "").strip()
        if album_key:
            albums_by_key.setdefault(album_key, []).append(album)
    if not albums_by_key:
        return

    rating_rows = PostgresAlbumRatingsService(_app_config(request)).load_album_ratings(
        albums_by_key
    )
    for album_key, albums in albums_by_key.items():
        rating_row = rating_rows.get(album_key)
        for album in albums:
            overlay = default_album_preference_overlay()
            if rating_row is not None:
                overlay["rating"] = rating_row.get("rating")
                overlay["provenance"] = rating_row.get("provenance")
                overlay["can_edit"] = True
            apply_album_preference_overlay(album, overlay)


def _log_view_data_request_from_asgi(
    request: Request,
    payload: dict[str, object],
    request_started_at: float,
) -> None:
    total_elapsed_ms = round((time.perf_counter() - request_started_at) * 1000, 2)
    log_app_event(
        _app_config(request),
        _app_logger(request),
        "View data request completed",
        level="info",
        elapsed_ms=total_elapsed_ms,
        query=payload.get("query", ""),
        selected_artist=payload.get("selected_artist", ""),
        album_count=payload.get("album_count", 0),
        artist_count=payload.get("artist_count", 0),
    )


def _client_surface_class_from_asgi(request: Request) -> str:
    requested_value = (
        _first_query_value(request, "client_surface")
        or _first_query_value(request, "client_surface_class")
        or request.headers.get("X-Album-Haven-Client-Surface")
        or request.headers.get("X-Album-Haven-Client-Surface-Class")
    )
    return resolve_client_surface_class(requested_value)


@router.get("/status")
async def status(request: Request) -> JSONResponse:
    library_state = _library_state(request)
    # Status is observational: API-only clients see pending discovery, but only
    # the root response handoff or an explicit manual refresh starts the scan.
    with request.app.state.cold_scan_handoff_lock:
        payload = _build_status_payload_from_state(library_state)
        payload["log_history_revision"] = load_log_history_revision(_app_config(request))
        handoff_status = str(library_state.get("cold_scan_handoff_status") or "idle")
        if library_state.get("cold_scan_pending") or handoff_status == "claimed":
            payload["scan_in_progress"] = True
            payload["scan_phase"] = "discovering"
            payload["scan_mode"] = "background"
    return JSONResponse(payload)


def _state_percent(library_state: dict[str, object], *, processed_key: str, total_key: str) -> int:
    total = int(library_state.get(total_key) or 0)
    processed = int(library_state.get(processed_key) or 0)
    if total <= 0:
        return 0
    return int((processed / total) * 100)


def _build_status_payload_from_state(library_state: dict[str, object]) -> dict[str, object]:
    browse_state = resolve_active_scan_browse_state(library_state)
    return {
        "scan_in_progress": bool(library_state.get("scan_in_progress")),
        "scan_generation": int(library_state.get("scan_generation") or 0),
        "scan_processed": int(library_state.get("scan_processed") or 0),
        "scan_total": int(library_state.get("scan_total") or 0),
        "scan_percent": _state_percent(
            library_state,
            processed_key="scan_processed",
            total_key="scan_total",
        ),
        "scan_current_path": library_state.get("scan_current_path") or "",
        "scan_elapsed_seconds": float(library_state.get("scan_elapsed_seconds") or 0.0),
        "scan_estimated_remaining_seconds": float(library_state.get("scan_estimated_remaining_seconds") or 0.0),
        "scan_files_per_second": float(library_state.get("scan_files_per_second") or 0.0),
        "scan_album_folders_processed": int(library_state.get("scan_album_folders_processed") or 0),
        "scan_album_folders_total": int(library_state.get("scan_album_folders_total") or 0),
        "scan_phase": str(library_state.get("scan_phase") or "idle"),
        "scan_mode": str(library_state.get("scan_mode") or "idle"),
        "scan_outcome": str(library_state.get("scan_outcome") or "idle"),
        "relations_in_progress": bool(library_state.get("relations_in_progress")),
        "relations_processed": int(library_state.get("relations_processed") or 0),
        "relations_total": int(library_state.get("relations_total") or 0),
        "relations_percent": _state_percent(
            library_state,
            processed_key="relations_processed",
            total_key="relations_total",
        ),
        "relations_phase": library_state.get("relations_phase", "Idle"),
        "relations_source": library_state.get("relations_source", "local"),
        "relation_projection": {
            "ready": bool(library_state.get("relation_projection_ready")),
            "builder_version": str(library_state.get("relation_projection_builder_version") or ""),
            "startup_rebuilt": bool(library_state.get("relation_projection_startup_rebuilt")),
            "rebuild_reason": str(library_state.get("relation_projection_rebuild_reason") or ""),
            "duration_ms": float(library_state.get("relation_projection_duration_ms") or 0.0),
        },
        "covers_in_progress": bool(library_state.get("covers_in_progress")),
        "covers_processed": int(library_state.get("covers_processed") or 0),
        "covers_total": int(library_state.get("covers_total") or 0),
        "covers_downloaded": int(library_state.get("covers_downloaded") or 0),
        "covers_current_folder": library_state.get("covers_current_folder") or "",
        "pending_cover_refresh_after_scan": bool(library_state.get("pending_cover_refresh_after_scan")),
        "last_scan_display": format_timestamp(float(library_state.get("last_scan") or 0.0)),
        "last_error": library_state.get("last_error"),
        "album_total": len(browse_state.get("albums", []) or []),
    }


@router.get("/view-data")
def view_data(request: Request) -> JSONResponse:
    library_state = _library_state(request)
    browse_state = resolve_active_scan_browse_state(library_state)
    if _should_use_transient_scan_browse_state(library_state, browse_state):
        request_started_at = time.perf_counter()
        payload = build_view_payload(
            query_args=_AsgiQueryArgs(request.query_params),
            config=_app_config(request),
            logger=_app_logger(request),
            library_state=browse_state,
            client_surface_class=_client_surface_class_from_asgi(request),
        )
        _apply_transient_scan_album_rating_overlays(
            request,
            _transient_view_album_payloads(payload),
        )
        _log_view_data_request_from_asgi(request, payload, request_started_at)
        return JSONResponse(payload)

    if _is_postgres_root_sidebar_request(request):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_root_sidebar_payload(
            query_params=request.query_params,
        )
        return JSONResponse(payload)
    if _is_postgres_selected_artist_request(request):
        repository = PostgresLibraryBrowseRepository(_app_config(request))
        payload = repository.build_selected_artist_payload(
            query_params=request.query_params,
            library_state=_postgres_browse_library_state(request),
        )
        if _request_flag_value(request.query_params.get("root_sidebar")):
            root_sidebar_payload = repository.build_root_sidebar_payload(
                query_params=request.query_params,
            )
            payload.update(
                {
                    field: root_sidebar_payload[field]
                    for field in (
                        "artists_sidebar",
                        "artist_count",
                        "show_all_artists_sidebar_link",
                    )
                    if field in root_sidebar_payload
                }
            )
        return JSONResponse(payload)
    if _is_postgres_album_search_request(request):
        request_started_at = time.perf_counter()
        query = str(request.query_params.get("q") or "").strip()
        log_app_event(
            _app_config(request),
            _app_logger(request),
            "Postgres album search request started",
            level="info",
            query=query,
        )
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_search_payload(
            query_params=request.query_params,
            library_state=_postgres_browse_library_state(request),
        )
        _log_view_data_request_from_asgi(request, payload, request_started_at)
        return JSONResponse(payload)
    if _is_postgres_root_album_browse_request(request):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_root_album_browse_payload(
            query_params=request.query_params,
        )
        return JSONResponse(payload)
    unsupported_selected_artist_response = _unsupported_postgres_selected_artist_browse_response(request)
    if unsupported_selected_artist_response is not None:
        return unsupported_selected_artist_response
    unsupported_album_search_response = _unsupported_postgres_album_search_response(request)
    if unsupported_album_search_response is not None:
        return unsupported_album_search_response
    unsupported_root_album_browse_response = _unsupported_postgres_root_album_browse_response(request)
    if unsupported_root_album_browse_response is not None:
        return unsupported_root_album_browse_response

    if _should_hydrate_file_backed_view_data(request):
        _hydrate_cached_library_for_asgi(request)
    request_started_at = time.perf_counter()
    payload = build_view_payload(
        query_args=_AsgiQueryArgs(request.query_params),
        config=_app_config(request),
        logger=_app_logger(request),
        library_state=_library_state(request),
        client_surface_class=_client_surface_class_from_asgi(request),
    )
    _log_view_data_request_from_asgi(request, payload, request_started_at)
    return JSONResponse(payload)


def _is_postgres_root_sidebar_request(request: Request) -> bool:
    allowed_root_sidebar_params = {
        "payload_tier",
        "surface",
        "gallery_scope",
        "gallery_display",
        "gallery_display_mode",
        "gallery_scale_percent",
        "category",
    }
    if any(str(key) not in allowed_root_sidebar_params for key in request.query_params.keys()):
        return False
    if str(request.query_params.get("payload_tier") or "").strip().casefold() != "sidebar":
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() not in {"", "albums", "library"}:
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _is_postgres_selected_artist_request(request: Request) -> bool:
    if any(str(key) not in _POSTGRES_SELECTED_ARTIST_PARAMS for key in request.query_params.keys()):
        return False
    artist = str(request.query_params.get("artist") or "").strip()
    if not artist:
        return False
    payload_tier = str(request.query_params.get("payload_tier") or "").strip().casefold()
    if payload_tier not in {"", "full"}:
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() not in {"", "albums"}:
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _is_postgres_selected_artist_browse_candidate(request: Request) -> bool:
    artist = str(request.query_params.get("artist") or "").strip()
    if not artist:
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        return False
    browse_flow_keys = {
        "surface",
        "payload_tier",
        "q",
        "omit_sidebar",
        "root_sidebar",
        "related_artist",
        "primary_filter",
        "gallery_scope",
        "gallery_display",
        "gallery_display_mode",
        "gallery_scale_percent",
        "category",
    }
    return any(str(key) in browse_flow_keys for key in request.query_params.keys())


def _unsupported_postgres_selected_artist_browse_response(request: Request) -> JSONResponse | None:
    if not _is_postgres_selected_artist_browse_candidate(request):
        return None
    if _is_postgres_selected_artist_request(request):
        return None
    return JSONResponse(
        {
            "ok": False,
            "error": "Unsupported Postgres selected-artist browse request shape",
            "error_code": "unsupported_postgres_selected_artist_browse_request",
            "selected_artist": str(request.query_params.get("artist") or "").strip(),
        },
        status_code=400,
    )


def _is_postgres_album_search_request(request: Request) -> bool:
    allowed_search_params = {
        "q",
        "surface",
        "all_artists",
        "gallery_scope",
        "gallery_display",
        "gallery_display_mode",
        "gallery_scale_percent",
        "category",
        "omit_sidebar",
    }
    if any(str(key) not in allowed_search_params for key in request.query_params.keys()):
        return False
    query = str(request.query_params.get("q") or "").strip()
    if not query or _query_requires_file_backed_search_semantics(query):
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() != "albums":
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _is_postgres_album_search_candidate(request: Request) -> bool:
    query = str(request.query_params.get("q") or "").strip()
    if not query:
        return False
    if str(request.query_params.get("artist") or "").strip():
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() != "albums":
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _unsupported_postgres_album_search_response(request: Request) -> JSONResponse | None:
    if not _is_postgres_album_search_candidate(request):
        return None
    if _is_postgres_album_search_request(request):
        return None
    return JSONResponse(
        {
            "ok": False,
            "error": "Unsupported Postgres album-search request shape",
            "error_code": "unsupported_postgres_album_search_request",
            "query": str(request.query_params.get("q") or "").strip(),
        },
        status_code=400,
    )


def _should_hydrate_file_backed_view_data(request: Request) -> bool:
    if _is_file_backed_omit_sidebar_follow_up_request(request):
        return False
    return not _is_file_backed_selected_artist_complex_request(request)


def _is_file_backed_omit_sidebar_follow_up_request(request: Request) -> bool:
    if not _request_flag_value(request.query_params.get("omit_sidebar")):
        return False
    if str(request.query_params.get("artist") or "").strip():
        return False
    if str(request.query_params.get("q") or "").strip():
        return False
    return str(request.query_params.get("surface") or "").strip().casefold() == "albums"


def _is_file_backed_selected_artist_complex_request(request: Request) -> bool:
    if str(request.query_params.get("artist") or "").strip() == "":
        return False
    if _is_postgres_selected_artist_request(request):
        return False
    if any(str(key) not in _FILE_BACKED_SELECTED_ARTIST_HYDRATION_PARAMS for key in request.query_params.keys()):
        return True
    surface = str(request.query_params.get("surface") or "").strip().casefold()
    if surface not in {"", "albums"}:
        return True
    if surface == "albums" and str(request.query_params.get("q") or "").strip():
        return True
    if any(str(request.query_params.get(key) or "").strip() for key in ("search", "related_artist", "primary_filter")):
        return True
    payload_tier = str(request.query_params.get("payload_tier") or "").strip().casefold()
    return payload_tier == "sidebar"


def _is_postgres_root_album_browse_request(request: Request) -> bool:
    allowed_root_album_browse_params = {
        "surface",
        "gallery_scope",
        "gallery_display",
        "gallery_display_mode",
        "gallery_scale_percent",
        "category",
        "omit_sidebar",
    }
    if any(str(key) not in allowed_root_album_browse_params for key in request.query_params.keys()):
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() != "albums":
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _is_postgres_root_album_browse_candidate(request: Request) -> bool:
    if str(request.query_params.get("artist") or "").strip():
        return False
    if str(request.query_params.get("q") or "").strip():
        return False
    if str(request.query_params.get("surface") or "").strip().casefold() != "albums":
        return False
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _unsupported_postgres_root_album_browse_response(request: Request) -> JSONResponse | None:
    if not _is_postgres_root_album_browse_candidate(request):
        return None
    if _is_postgres_root_album_browse_request(request):
        return None
    return JSONResponse(
        {
            "ok": False,
            "error": "Unsupported Postgres root album browse request shape",
            "error_code": "unsupported_postgres_root_album_browse_request",
        },
        status_code=400,
    )


def _query_requires_file_backed_search_semantics(query: str) -> bool:
    normalized = str(query or "").strip()
    if not normalized:
        return True
    for token in normalized.split():
        candidate = token[1:] if token.startswith("-") else token
        if "%" in candidate or "_" in candidate:
            return True
        if candidate.startswith("#"):
            return True
        if ":" in candidate:
            return True
    return False


@router.get("/home-data")
async def home_data(request: Request) -> JSONResponse:
    _hydrate_cached_library_for_asgi(request)
    request_started_at = time.perf_counter()
    library_state = _library_state(request)
    browse_state = resolve_active_scan_browse_state(library_state)
    payload = build_home_payload(
        query_args=_AsgiQueryArgs(request.query_params),
        config=_app_config(request),
        logger=_app_logger(request),
        library_state=browse_state,
        client_surface_class=resolve_client_surface_class(
            request.query_params.get("client_surface")
            or request.query_params.get("client_surface_class")
            or request.headers.get("X-Album-Haven-Client-Surface")
            or request.headers.get("X-Album-Haven-Client-Surface-Class")
        ),
    )
    if not library_state.get("scan_in_progress"):
        selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
        if selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES:
            omit_sidebar = _request_flag_value(request.query_params.get("omit_sidebar"))
            repository = PostgresLibraryBrowseRepository(_app_config(request))
            payload_builder = (
                repository.build_root_counts_payload
                if omit_sidebar
                else repository.build_root_sidebar_payload
            )
            root_sidebar_payload = await run_in_threadpool(
                payload_builder,
                query_params=request.query_params,
            )
            authoritative_fields = [
                "artist_count",
                "album_count",
                "show_all_artists_sidebar_link",
            ]
            if not omit_sidebar:
                authoritative_fields.insert(0, "artists_sidebar")
            payload.update(
                {
                    field: root_sidebar_payload[field]
                    for field in authoritative_fields
                    if field in root_sidebar_payload
                }
            )
    _log_view_data_request_from_asgi(request, payload, request_started_at)
    return JSONResponse(payload)


@router.get("/album-details")
async def album_details(request: Request) -> JSONResponse:
    album_key = str(request.query_params.get("album_key") or "").strip()
    if not album_key:
        return JSONResponse({"ok": False, "error": "Missing album_key"}, status_code=400)
    unsupported_postgres_non_album_response = _unsupported_postgres_non_album_modal_response(
        request,
        album_key,
    )
    if unsupported_postgres_non_album_response is not None:
        return unsupported_postgres_non_album_response

    client_surface_class = resolve_client_surface_class(
        request.query_params.get("client_surface")
        or request.query_params.get("client_surface_class")
        or request.headers.get("X-Album-Haven-Client-Surface")
        or request.headers.get("X-Album-Haven-Client-Surface-Class")
    )
    browse_state = resolve_active_scan_browse_state(_library_state(request))

    if _should_use_postgres_album_detail_path(request, browse_state=browse_state):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_album_detail_payload(
            album_key,
            client_surface_class=client_surface_class,
        )
        if payload is None:
            return JSONResponse({"ok": False, "error": "Album not found"}, status_code=404)
        return JSONResponse({"ok": True, "album": payload})

    _hydrate_cached_library_for_asgi(request)
    payload = build_album_detail_payload(
        album_key,
        client_surface_class=client_surface_class,
        config=_app_config(request),
        library_state=browse_state,
    )
    if payload is None:
        return JSONResponse({"ok": False, "error": "Album not found"}, status_code=404)
    if browse_state.get("scan_in_progress"):
        _apply_transient_scan_album_rating_overlays(request, [payload])
    return JSONResponse({"ok": True, "album": payload})


def _should_use_postgres_album_detail_path(
    request: Request,
    *,
    browse_state: dict[str, object] | None = None,
) -> bool:
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        return False
    allowed_detail_params = {
        "album_key",
        "client_surface",
        "client_surface_class",
    }
    if any(str(key) not in allowed_detail_params for key in request.query_params.keys()):
        return False
    album_key = str(request.query_params.get("album_key") or "").strip()
    if not album_key or album_key.startswith("non-album::"):
        return False
    resolved_state = (
        browse_state
        if browse_state is not None
        else resolve_active_scan_browse_state(_library_state(request))
    )
    if _should_use_transient_scan_browse_state(_library_state(request), resolved_state):
        for album in list(resolved_state.get("albums") or []):
            runtime_album_key = str(
                getattr(album, "key", "")
                or (album.get("key") if isinstance(album, dict) else "")
            ).strip()
            if runtime_album_key == album_key:
                return False
    return True


def _unsupported_postgres_non_album_modal_response(
    request: Request,
    album_key: str,
) -> JSONResponse | None:
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    if selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        return None
    allowed_detail_params = {
        "album_key",
        "client_surface",
        "client_surface_class",
    }
    if any(str(key) not in allowed_detail_params for key in request.query_params.keys()):
        return None
    if not str(album_key or "").startswith("non-album::"):
        return None
    return JSONResponse(
        {
            "ok": False,
            "error": "Album not found",
            "error_code": "unsupported_postgres_non_album_modal_request",
            "album_key": album_key,
        },
        status_code=404,
    )


@router.get("/utilities/problematic-files")
def utilities_problematic_files(request: Request) -> JSONResponse:
    if _is_postgres_utility_projection_request(request):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_problematic_files_payload()
        return JSONResponse(payload)
    _hydrate_cached_library_for_asgi(request)
    payload = build_problematic_albums_payload(
        config=_app_config(request),
        library_state=_library_state(request),
        logger=_app_logger(request),
    )
    return JSONResponse(payload)


@router.get("/utilities/problematic-files/detail")
def utilities_problematic_file_detail_query(request: Request) -> JSONResponse:
    album_key = str(request.query_params.get("album_key", "") or "")
    if not album_key:
        return JSONResponse({"ok": False, "error": "Missing album_key."}, status_code=400)
    if _is_postgres_utility_projection_request(request):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_problematic_file_detail_payload(album_key)
        if payload is None:
            return JSONResponse(
                {"ok": False, "error": "Problematic album not found."},
                status_code=404,
            )
        return JSONResponse(payload)
    _hydrate_cached_library_for_asgi(request)
    payload = build_problematic_album_detail_payload(
        album_key,
        config=_app_config(request),
        library_state=_library_state(request),
        logger=_app_logger(request),
    )
    if payload is None:
        return JSONResponse(
            {"ok": False, "error": "Problematic album not found."},
            status_code=404,
        )
    return JSONResponse(payload)


@router.get("/utilities/problematic-files/{album_key:path}")
def utilities_problematic_file_detail(request: Request, album_key: str) -> JSONResponse:
    if _is_postgres_utility_projection_request(request):
        payload = PostgresLibraryBrowseRepository(_app_config(request)).build_problematic_file_detail_payload(album_key)
        if payload is None:
            return JSONResponse(
                {"ok": False, "error": "Problematic album not found."},
                status_code=404,
            )
        return JSONResponse(payload)
    _hydrate_cached_library_for_asgi(request)
    payload = build_problematic_album_detail_payload(
        album_key,
        config=_app_config(request),
        library_state=_library_state(request),
        logger=_app_logger(request),
    )
    if payload is None:
        return JSONResponse(
            {"ok": False, "error": "Problematic album not found."},
            status_code=404,
        )
    return JSONResponse(payload)


def _is_postgres_utility_projection_request(request: Request) -> bool:
    selection = select_runtime_persistence_adapter("library_browse", _app_config(request))
    return selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


@router.get("/utilities/loops")
async def utilities_loops(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "loops": load_loops(_app_config(request))})


@router.get("/utilities/log-history")
async def utilities_log_history(request: Request) -> JSONResponse:
    snapshot = load_log_history_snapshot(_app_config(request))
    return JSONResponse(
        {"ok": True, **snapshot},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/album-notes")
async def album_notes_create_reserved() -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": _ALBUM_NOTE_MUTATION_ERROR},
        status_code=409,
    )


@router.patch("/album-notes/{note_ref}")
@router.delete("/album-notes/{note_ref}")
async def album_notes_mutate_reserved(note_ref: str) -> JSONResponse:
    del note_ref
    return JSONResponse(
        {"ok": False, "error": _ALBUM_NOTE_MUTATION_ERROR},
        status_code=409,
    )


@router.post("/album-note-replies")
async def album_note_replies_create_reserved() -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": _ALBUM_NOTE_REPLY_MUTATION_ERROR},
        status_code=409,
    )


@router.patch("/album-note-replies/{reply_ref}")
@router.delete("/album-note-replies/{reply_ref}")
async def album_note_replies_mutate_reserved(reply_ref: str) -> JSONResponse:
    del reply_ref
    return JSONResponse(
        {"ok": False, "error": _ALBUM_NOTE_REPLY_MUTATION_ERROR},
        status_code=409,
    )


@router.get("/album-opinions/{album_ref}/crowd")
async def album_opinions_crowd_read_reserved(album_ref: str) -> JSONResponse:
    normalized_album_ref = str(album_ref or "").strip()
    return JSONResponse(
        {
            "ok": False,
            "error": _ALBUM_CROWD_OPINION_ERROR,
            "transport": "cache_only_detail",
            "route_family": _ALBUM_OPINION_ROUTE_FAMILY,
            "response_kind": "crowd_opinion_detail",
            "crowd_opinion": build_crowd_opinion_modal_payload(normalized_album_ref),
        },
        status_code=409,
    )


@router.get("/people/{person_ref}")
async def people_read_reserved(request: Request, person_ref: str) -> JSONResponse:
    normalized_person_ref = str(person_ref or "").strip()
    return JSONResponse(
        {
            "ok": False,
            "error": _PERSON_PAGE_ERROR,
            "transport": _RESOURCE_PAGE_TRANSPORT,
            "route_family": _PEOPLE_ROUTE_FAMILY,
            "response_kind": "person_page",
            "page_kind": "person",
            "person_ref": normalized_person_ref,
            "person_page": build_person_page_seam(
                normalized_person_ref,
                page_mode=request.query_params.get("page_mode"),
                family_display_mode=request.query_params.get("family_display"),
                timeline_at=request.query_params.get("timeline_at"),
                role_focus=request.query_params.get("role_focus"),
            ),
        },
        status_code=409,
    )


@router.get("/works/{work_ref}")
async def works_read_reserved(work_ref: str) -> JSONResponse:
    normalized_work_ref = str(work_ref or "").strip()
    return JSONResponse(
        {
            "ok": False,
            "error": _WORK_PAGE_ERROR,
            "transport": _RESOURCE_PAGE_TRANSPORT,
            "route_family": _WORKS_ROUTE_FAMILY,
            "response_kind": "work_page",
            "page_kind": "work",
            "work_ref": normalized_work_ref,
            "work_page": build_work_page_seam(normalized_work_ref),
        },
        status_code=409,
    )


@router.get("/soundtracks/{soundtrack_ref}")
async def soundtracks_read_reserved(request: Request, soundtrack_ref: str) -> JSONResponse:
    normalized_soundtrack_ref = str(soundtrack_ref or "").strip()
    return JSONResponse(
        {
            "ok": False,
            "error": _SOUNDTRACK_PAGE_ERROR,
            "transport": _RESOURCE_PAGE_TRANSPORT,
            "route_family": _SOUNDTRACKS_ROUTE_FAMILY,
            "response_kind": "soundtrack_page",
            "page_kind": "soundtrack",
            "soundtrack_ref": normalized_soundtrack_ref,
            "soundtrack_page": build_soundtrack_page_seam(
                normalized_soundtrack_ref,
                page_mode=request.query_params.get("page_mode"),
            ),
        },
        status_code=409,
    )


@router.get("/companies/{company_ref}")
async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:
    normalized_company_ref = str(company_ref or "").strip()
    return JSONResponse(
        {
            "ok": False,
            "error": _COMPANY_PAGE_ERROR,
            "transport": _RESOURCE_PAGE_TRANSPORT,
            "route_family": _COMPANIES_ROUTE_FAMILY,
            "response_kind": "company_page",
            "page_kind": "company",
            "company_ref": normalized_company_ref,
            "company_page": build_company_page_seam(
                normalized_company_ref,
                page_mode=request.query_params.get("page_mode"),
            ),
        },
        status_code=409,
    )
