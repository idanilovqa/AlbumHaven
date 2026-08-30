from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from music_app.services.discovery_center_read_seams import (
    build_discovery_center_entries_payload,
    build_discovery_center_insights_payload,
    build_discovery_center_preferences_payload,
    build_discovery_center_summary_payload,
    build_discovery_lookup_payload,
    build_recent_discovery_lookup_payload,
    create_discovery_lookup_payload,
    save_discovery_center_preferences,
)
from music_app.services.page_resource_seams import (
    build_virtual_artist_page_seam,
    build_virtual_release_page_seam,
)
from music_app.services.virtual_artist_snapshots import (
    create_virtual_artist_snapshot,
    get_virtual_artist_release_scope_label,
    list_recent_virtual_artist_lookups,
    normalize_virtual_artist_release_scope,
    read_virtual_artist_snapshot,
    record_recent_virtual_artist_lookup,
)
from music_app.services.virtual_discography_search import (
    search_virtual_artist_candidates,
)
from music_app.services.virtual_release_snapshots import (
    read_virtual_release_snapshot,
)


router = APIRouter()

JsonDict = dict[str, object]
ResponseValue = JsonDict | tuple[JsonDict, int]

_VIRTUAL_ARTIST_ROUTE_FAMILY = "/virtual-artists"
_VIRTUAL_RELEASE_ROUTE_FAMILY = "/virtual-releases"
_DEFAULT_RELEASE_SCOPE = "studio_ep"
_VIRTUAL_ARTIST_RECENT_REOPENABLE_FRESHNESS_STATES = ("fresh", "stale")
_VIRTUAL_ARTIST_FRESH_WINDOW_DAYS = 7
_VIRTUAL_ARTIST_RETENTION_WINDOW_DAYS = 14
_VIRTUAL_ARTIST_RECENT_ACTOR_COOKIE = "album_haven_virtual_artist_recent_actor"


def _app_config(request: Request):
    return request.app.state.config


async def _json_payload(request: Request) -> JsonDict:
    try:
        payload = await request.json()
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _json_response(value: ResponseValue) -> JSONResponse:
    if isinstance(value, tuple):
        payload, status_code = value
        return JSONResponse(payload, status_code=status_code)
    return JSONResponse(value)


def _build_release_scope_contract() -> JsonDict:
    return {
        "query_parameter": "release_scope",
        "default_scope": _DEFAULT_RELEASE_SCOPE,
        "switch_transport": "same_virtual_artist_read",
        "supported_scopes": [
            {
                "scope": scope,
                "label": get_virtual_artist_release_scope_label(scope),
            }
            for scope in ("studio_ep", "live", "compilation", "others", "all")
        ],
    }


def _build_recent_lookup_read_contract() -> JsonDict:
    return {
        "reopen_transport": "same_virtual_artist_read",
        "read_route_pattern": "/virtual-artists/{virtual_artist_ref}",
        "row_identity_field": "virtual_artist_ref",
        "row_scope_field": "active_release_scope",
        "row_scope_label_field": "active_release_scope_label",
        "freshness_field": "freshness_state",
        "expires_at_field": "expires_at",
        "reopenable_freshness_states": list(
            _VIRTUAL_ARTIST_RECENT_REOPENABLE_FRESHNESS_STATES
        ),
        "expired_reopen_behavior": "requires_new_lookup",
        "fresh_window_days": _VIRTUAL_ARTIST_FRESH_WINDOW_DAYS,
        "retention_window_days": _VIRTUAL_ARTIST_RETENTION_WINDOW_DAYS,
    }


def _resolve_active_release_scope(
    request: Request,
    default_scope: object = _DEFAULT_RELEASE_SCOPE,
) -> tuple[str, str]:
    fallback_scope = normalize_virtual_artist_release_scope(default_scope)
    requested_scope = request.query_params.get("release_scope")
    active_scope = (
        normalize_virtual_artist_release_scope(requested_scope)
        if requested_scope is not None
        else fallback_scope
    )
    return active_scope, get_virtual_artist_release_scope_label(active_scope)


def _resolve_virtual_artist_recent_actor_key(
    request: Request,
    *,
    mint_if_missing: bool,
) -> tuple[str | None, bool]:
    actor_key = str(
        request.cookies.get(_VIRTUAL_ARTIST_RECENT_ACTOR_COOKIE) or ""
    ).strip()
    if actor_key:
        return actor_key, False
    if not mint_if_missing:
        return None, False
    return f"visitor-{uuid4().hex}", True


def _build_cookie_response(
    payload: JsonDict,
    *,
    status_code: int = 200,
    actor_key: str | None = None,
    set_actor_cookie: bool = False,
) -> JSONResponse:
    response = JSONResponse(payload, status_code=status_code)
    if set_actor_cookie and actor_key:
        response.set_cookie(
            _VIRTUAL_ARTIST_RECENT_ACTOR_COOKIE,
            actor_key,
            httponly=True,
            samesite="lax",
        )
    return response


@router.get("/news-center/summary")
async def news_center_summary() -> JSONResponse:
    return JSONResponse(build_discovery_center_summary_payload())


@router.get("/news-center/entries")
async def news_center_entries(request: Request) -> JSONResponse:
    return JSONResponse(
        build_discovery_center_entries_payload(
            tab=request.query_params.get("tab"),
            source=request.query_params.get("source"),
        )
    )


@router.get("/news-center/insights")
async def news_center_insights(request: Request) -> JSONResponse:
    return JSONResponse(
        build_discovery_center_insights_payload(
            window=request.query_params.get("window")
        )
    )


@router.get("/news-center/preferences")
async def news_center_preferences(request: Request) -> JSONResponse:
    return JSONResponse(
        build_discovery_center_preferences_payload(_app_config(request))
    )


@router.post("/news-center/preferences")
async def save_news_center_preferences(request: Request) -> JSONResponse:
    return JSONResponse(
        save_discovery_center_preferences(
            _app_config(request),
            await _json_payload(request),
        )
    )


@router.post("/discovery-lookups")
async def create_discovery_lookup(request: Request) -> JSONResponse:
    return JSONResponse(
        create_discovery_lookup_payload(
            _app_config(request),
            await _json_payload(request),
        ),
        status_code=201,
    )


@router.get("/discovery-lookups/recent")
async def recent_discovery_lookups(request: Request) -> JSONResponse:
    return JSONResponse(build_recent_discovery_lookup_payload(_app_config(request)))


@router.get("/discovery-lookups/{lookup_ref}")
async def discovery_lookup_detail(request: Request, lookup_ref: str) -> JSONResponse:
    payload = build_discovery_lookup_payload(_app_config(request), lookup_ref)
    if payload is None:
        return JSONResponse(
            {"ok": False, "error": "Discovery lookup not found"},
            status_code=404,
        )
    return JSONResponse(payload)


@router.get("/virtual-artists/search")
async def virtual_artists_search(request: Request) -> JSONResponse:
    search_payload = search_virtual_artist_candidates(request.query_params.get("q"))
    response: JsonDict = {
        "transport": "remote_discovery",
        "route_family": _VIRTUAL_ARTIST_ROUTE_FAMILY,
        "response_kind": "virtual_artist_candidates",
        **search_payload,
    }
    if search_payload.get("ok") is False:
        response["error"] = search_payload.get("error") or (
            "Virtual Discography candidate search is temporarily unavailable."
        )
        return JSONResponse(response, status_code=503)
    return JSONResponse(response)


@router.post("/virtual-artists")
async def virtual_artists_create(request: Request) -> JSONResponse:
    actor_key, set_actor_cookie = _resolve_virtual_artist_recent_actor_key(
        request,
        mint_if_missing=True,
    )
    snapshot_payload = create_virtual_artist_snapshot(
        _app_config(request),
        await _json_payload(request),
        actor_key=actor_key,
    )
    response: JsonDict = {
        "transport": "remote_discovery",
        "route_family": _VIRTUAL_ARTIST_ROUTE_FAMILY,
        "response_kind": "virtual_artist_lookup_submit",
    }
    if snapshot_payload.get("ok") is False:
        response["ok"] = False
        response["error"] = snapshot_payload.get("error") or (
            "Virtual Discography lookup submit is temporarily unavailable."
        )
        return _build_cookie_response(
            response,
            status_code=int(snapshot_payload.get("status_code") or 503),
            actor_key=actor_key,
            set_actor_cookie=set_actor_cookie,
        )

    active_scope = str(
        snapshot_payload.get("default_release_scope") or _DEFAULT_RELEASE_SCOPE
    ).strip()
    virtual_artist_ref = str(snapshot_payload.get("virtual_artist_ref") or "").strip()
    response.update(
        {
            "ok": True,
            "page_kind": "virtual_artist",
            "virtual_artist_ref": virtual_artist_ref,
            "artist_summary": dict(snapshot_payload.get("artist_summary") or {}),
            "source_provenance": dict(snapshot_payload.get("source_provenance") or {}),
            "created_at": snapshot_payload.get("created_at"),
            "expires_at": snapshot_payload.get("expires_at"),
            "freshness_state": snapshot_payload.get("freshness_state"),
            "refresh_state": snapshot_payload.get("refresh_state"),
            "active_release_scope": active_scope,
            "active_release_scope_label": get_virtual_artist_release_scope_label(
                active_scope
            ),
            "read_route_pattern": "/virtual-artists/{virtual_artist_ref}",
            "read_route": (
                f"/virtual-artists/{virtual_artist_ref}?release_scope={active_scope}"
            ),
        }
    )
    return _build_cookie_response(
        response,
        status_code=201,
        actor_key=actor_key,
        set_actor_cookie=set_actor_cookie,
    )


@router.get("/virtual-artists/recent")
async def virtual_artists_recent(request: Request) -> JSONResponse:
    actor_key, set_actor_cookie = _resolve_virtual_artist_recent_actor_key(
        request,
        mint_if_missing=True,
    )
    payload = {
        "ok": True,
        "transport": "remote_discovery",
        "route_family": _VIRTUAL_ARTIST_ROUTE_FAMILY,
        "response_kind": "virtual_artist_recent_lookups",
        "recent_lookups": list_recent_virtual_artist_lookups(
            _app_config(request),
            actor_key=actor_key,
        ),
        "recent_lookup_read_contract": _build_recent_lookup_read_contract(),
    }
    return _build_cookie_response(
        payload,
        actor_key=actor_key,
        set_actor_cookie=set_actor_cookie,
    )


@router.get("/virtual-artists/{virtual_artist_ref}")
async def virtual_artists_read(
    request: Request,
    virtual_artist_ref: str,
) -> JSONResponse:
    normalized_ref = str(virtual_artist_ref or "").strip()
    config = _app_config(request)
    snapshot_payload = read_virtual_artist_snapshot(config, normalized_ref)
    response: JsonDict = {
        "transport": "remote_discovery",
        "route_family": _VIRTUAL_ARTIST_ROUTE_FAMILY,
        "response_kind": "virtual_artist_page",
        "page_kind": "virtual_artist",
        "virtual_artist_ref": normalized_ref,
    }
    if snapshot_payload.get("ok") is False:
        status = str(snapshot_payload.get("status") or "missing").strip()
        if status == "expired":
            response.update(
                {
                    "ok": False,
                    "error": (
                        "Virtual Discography snapshot expired and requires a new lookup."
                    ),
                    "expires_at": snapshot_payload.get("expires_at"),
                    "freshness_state": snapshot_payload.get("freshness_state"),
                    "refresh_state": snapshot_payload.get("refresh_state"),
                }
            )
            return JSONResponse(response, status_code=410)
        response.update(
            {
                "ok": False,
                "error": "Virtual Discography snapshot was not found.",
            }
        )
        return JSONResponse(response, status_code=404)

    active_scope, active_scope_label = _resolve_active_release_scope(
        request,
        snapshot_payload.get("default_release_scope"),
    )
    actor_key, _set_actor_cookie = _resolve_virtual_artist_recent_actor_key(
        request,
        mint_if_missing=False,
    )
    if actor_key:
        record_recent_virtual_artist_lookup(
            config,
            actor_key=actor_key,
            virtual_artist_ref=normalized_ref,
            active_release_scope=active_scope,
        )
    response.update(
        {
            "ok": True,
            "artist_summary": dict(snapshot_payload.get("artist_summary") or {}),
            "source_provenance": dict(snapshot_payload.get("source_provenance") or {}),
            "created_at": snapshot_payload.get("created_at"),
            "expires_at": snapshot_payload.get("expires_at"),
            "freshness_state": snapshot_payload.get("freshness_state"),
            "refresh_state": snapshot_payload.get("refresh_state"),
            "sections": [],
            "artist_family_filters": [],
            "artist_page": build_virtual_artist_page_seam(
                normalized_ref,
                page_mode=request.query_params.get("page_mode"),
                family_display_mode=request.query_params.get("family_display"),
                gallery_display_mode=request.query_params.get("gallery_display"),
                gallery_scale_percent=request.query_params.get(
                    "gallery_scale_percent"
                ),
                timeline_at=request.query_params.get("timeline_at"),
            ),
            "active_release_scope": active_scope,
            "active_release_scope_label": active_scope_label,
            "release_scope_contract": _build_release_scope_contract(),
        }
    )
    return JSONResponse(response)


@router.get("/virtual-releases/{virtual_release_ref}")
async def virtual_releases_read(
    request: Request,
    virtual_release_ref: str,
) -> JSONResponse:
    virtual_release_ref_value = str(virtual_release_ref or "").strip()
    snapshot_payload = read_virtual_release_snapshot(
        _app_config(request),
        virtual_release_ref_value,
    )
    response: JsonDict = {
        "transport": "remote_discovery",
        "route_family": _VIRTUAL_RELEASE_ROUTE_FAMILY,
        "response_kind": "virtual_release_page",
        "page_kind": "virtual_release",
        "virtual_release_ref": virtual_release_ref_value,
    }
    if snapshot_payload.get("ok") is False:
        status = str(snapshot_payload.get("status") or "missing").strip()
        if status == "expired":
            response.update(
                {
                    "ok": False,
                    "error": (
                        "Virtual release snapshot expired and requires a new lookup."
                    ),
                    "expires_at": snapshot_payload.get("expires_at"),
                    "freshness_state": snapshot_payload.get("freshness_state"),
                    "refresh_state": snapshot_payload.get("refresh_state"),
                }
            )
            return JSONResponse(response, status_code=410)
        response.update(
            {
                "ok": False,
                "error": "Virtual release snapshot was not found.",
            }
        )
        return JSONResponse(response, status_code=404)

    response.update(
        {
            "ok": True,
            "created_at": snapshot_payload.get("created_at"),
            "expires_at": snapshot_payload.get("expires_at"),
            "freshness_state": snapshot_payload.get("freshness_state"),
            "refresh_state": snapshot_payload.get("refresh_state"),
            "virtual_release": build_virtual_release_page_seam(
                virtual_release_ref_value,
                snapshot_payload.get("release_detail"),
            ),
        }
    )
    return JSONResponse(response)
