"""Explicitly deployed metadata-only immutable Album Top representations.

The same URL returns the same public metadata for signed-in visitors. Working
Top navigation and media/progress authorization are separate later owners.
"""
from pathlib import Path
import re
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy import RequestOrigin
from music_app.services.private_route_boundary import public_share_request_origin
from music_app.services.public_album_tops import normalize_public_top_query, public_ref
from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "Vary": "Accept"}
_TEMPLATES = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))
_MEDIA = re.compile(r"(?:[a-z0-9!#$&^_.+-]+|\*)/(?:[a-z0-9!#$&^_.+-]+|\*)\Z", re.ASCII)
_QUALITY = re.compile(r"(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)\Z", re.ASCII)
_ITEM_FIELDS = ("item_ref", "original_position", "curator_position", "album_ref", "presentation_ref",
                "title", "artist", "year", "artwork_ref", "details_path")
_TRACK_FIELDS = ("track_ref", "position", "title", "artist", "duration_ms")


def _wants_html(request):
    """Explicit HTML only; preserve JSON defaults and bound header parsing."""
    values = request.headers.getlist("accept")
    if not values or sum(len(value) for value in values) + len(values) - 1 > 8192:
        return False
    ranges = ",".join(values).lower().split(",")
    if len(ranges) > 64:
        return False
    qualities = {"text/html": (-1, 0), "application/json": (-1, 0)}
    explicit_html = False
    for value in ranges:
        parts = [part.strip() for part in value.split(";")]
        media = parts[0]
        if not _MEDIA.fullmatch(media) or media.startswith("*/") and media != "*/*":
            return False
        quality, seen_quality = 1000, False
        for parameter in parts[1:]:
            name, separator, argument = parameter.partition("=")
            if not separator or not name.strip() or not argument.strip():
                return False
            if name.strip() == "q":
                argument = argument.strip()
                if seen_quality or not _QUALITY.fullmatch(argument):
                    return False
                seen_quality = True
                quality = int(argument[0]) * 1000 + int((argument.partition(".")[2] + "000")[:3])
        explicit_html = explicit_html or media == "text/html" and quality > 0
        for candidate in qualities:
            specificity = (2 if media == candidate else 1 if media == candidate.split("/")[0] + "/*"
                           else 0 if media == "*/*" else -1)
            if specificity >= 0 and (specificity, quality) > qualities[candidate]:
                qualities[candidate] = (specificity, quality)
    return explicit_html and qualities["text/html"][1] > qualities["application/json"][1]


def _page_path(share_ref, item_ref=None):
    path = "/public/album-tops/" + public_ref(share_ref)
    return path + "/items/" + public_ref(item_ref) if item_ref is not None else path


def _html_payload(value, *, share_ref, item_ref, page):
    """Serialize only the existing public DTO, never a future private field."""
    source = value["data"]
    if (source["share_ref"] != share_ref or source["allowed_actions"] != {
            "can_read": True, "can_open_item": True}):
        raise ValueError("Invalid public metadata projection")
    data = {key: source[key] for key in ("share_ref", "publication_ref", "publication_revision", "next_cursor")}
    data["allowed_actions"] = {key: source["allowed_actions"][key] for key in ("can_read", "can_open_item")}
    cursor = data["next_cursor"]
    if cursor is not None and (type(cursor) is not str or not 1 <= len(cursor) <= 4096):
        raise ValueError("Invalid public metadata cursor")
    if item_ref is None:
        rows = source["items"]
        if type(rows) is not list or len(rows) > page["limit"]:
            raise ValueError("Invalid public metadata page")
        data.update(title=source["title"], description=source["description"],
                    items=[{key: row[key] for key in _ITEM_FIELDS} for row in rows])
    else:
        rows = source["tracks"]
        if source["item"]["item_ref"] != item_ref or type(rows) is not list or len(rows) > page["limit"]:
            raise ValueError("Invalid public metadata page")
        data.update(item={key: source["item"][key] for key in _ITEM_FIELDS},
                    tracks=[{key: row[key] for key in _TRACK_FIELDS} for row in rows],
                    track_count=source["track_count"])
    return {"kind": "item" if item_ref is not None else "top", "share_ref": share_ref,
            "item_ref": item_ref, "limit": page["limit"], "data": data}


def _html_response(request, value, status, *, share_ref=None, item_ref=None, page=None):
    try:
        payload = _html_payload(value, share_ref=share_ref, item_ref=item_ref, page=page) if status == 200 else None
        path = _page_path(share_ref, item_ref) if share_ref is not None else None
        first_page = path + "?" + urlencode({"limit": page["limit"]}) if path and page else path
        next_page = (path + "?" + urlencode({"limit": page["limit"], "cursor": payload["data"]["next_cursor"]})
                     if payload is not None and payload["data"]["next_cursor"] is not None else None)
        context = {"request": request, "payload": payload, "status": status,
                   "page_title": "Shared Album Top" if item_ref is None else "Shared album",
                   "error_message": ("This page has changed or the page request is invalid. Open the first page to try again."
                                     if value.get("error") in {"invalid_cursor", "invalid_query"}
                                     else "This shared Album Top is unavailable."),
                   "top_path": _page_path(share_ref) if share_ref is not None and item_ref is not None else None,
                   "first_page": first_page, "next_page": next_page,
                   "runtime_asset_version": getattr(request.app.state, "runtime_asset_version", "missing")}
        templates = getattr(request.app.state, "templates", _TEMPLATES)
        return templates.TemplateResponse(request, "public-album-top.html", context,
                                          status_code=status, headers=_HEADERS)
    except Exception:
        # A broken renderer must not expose a partial snapshot or exception.
        return HTMLResponse("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
            "<title>Shared Album Top</title><body><main><h1>Shared Album Top</h1>"
            "<p>This shared Album Top is unavailable.</p></main></body></html>",
            status_code=503, headers=_HEADERS)


def _response(request, value, status=200, **subject):
    response = (_html_response(request, value, status, **subject) if _wants_html(request)
                else JSONResponse(value, status_code=status, headers=_HEADERS))
    if request.method == "HEAD":
        # Retain representation headers while sending no body; authorization and
        # current publication validation are identical to GET.
        response.body = b""
    return response


async def _read(request, share_ref, item_ref=None):
    subject = {}
    try:
        origin = public_share_request_origin(request)
        if origin is None:
            raise AlbumTopError("unavailable", 404)
        share_ref = public_ref(share_ref)
        item_ref = public_ref(item_ref) if item_ref is not None else None
        subject = {"share_ref": share_ref, "item_ref": item_ref}
        page = normalize_public_top_query(list(request.query_params.multi_items()),
                                         kind="item" if item_ref is not None else "top")
        subject["page"] = page
        service = getattr(request.app.state, "public_album_tops_service", None)
        if service is None:
            service = PostgresPublicAlbumTopsService(request.app.state.config)
        resolver = getattr(request.app.state, "policy_constraint_resolver", None)
        value = await run_in_threadpool(service.read_guest, share_ref=share_ref, item_ref=item_ref,
            request_origin=RequestOrigin("network", origin),
            cursor_secret=request.app.state.auth_policy_config["hmac"]["secret"],
            constraints=resolver if callable(resolver) else None, **page)
        if public_share_request_origin(request) != origin:
            raise AlbumTopError("unavailable", 404)
        return _response(request, {"status": "ready", "data": value}, **subject)
    except AlbumTopError as error:
        return _response(request, {"ok": False, "error": error.code}, error.status_code, **subject)
    except Exception:
        return _response(request, {"ok": False, "error": "unavailable"}, 503, **subject)


@router.api_route("/public/album-tops/{share_ref}", methods=["GET", "HEAD"])
async def read_public_album_top(request: Request, share_ref: str):
    return await _read(request, share_ref)


@router.api_route("/public/album-tops/{share_ref}/items/{item_ref}", methods=["GET", "HEAD"])
async def read_public_album_top_item(request: Request, share_ref: str, item_ref: str):
    return await _read(request, share_ref, item_ref)
