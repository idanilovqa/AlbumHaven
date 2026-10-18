"""Explicitly deployed immutable public metadata and approved sanitized PNGs.

The same URL returns the same public metadata for signed-in visitors. Working
Top navigation and media/progress authorization are separate later owners.
"""
from pathlib import Path
import re
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy import RequestOrigin
from music_app.services.private_route_boundary import public_share_request_origin, album_top_working_link_path
from music_app.services.public_album_tops import (
    MAX_PUBLIC_PNG_BYTES, MAX_PUBLIC_RESPONSE_BYTES, normalize_public_top_query,
    public_ref, snapshot_integer, validate_snapshot_v2,
)
from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "Vary": "Accept"}
_PNG_HEADERS = {key: value for key, value in _HEADERS.items() if key != "Vary"}
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
    if "publication_contract_version" in source:
        validate_snapshot_v2(source, share_ref=share_ref, item_ref=item_ref, limit=page["limit"])
        data["publication_contract_version"] = 2
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
                   "working_path": album_top_working_link_path(request, share_ref) if payload is not None else None,
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


def _response(request, value, status=200, *, bounded=False, **subject):
    response = (_html_response(request, value, status, **subject) if _wants_html(request)
                else JSONResponse(value, status_code=status, headers=_HEADERS))
    if bounded and len(response.body) > MAX_PUBLIC_RESPONSE_BYTES:
        raise AlbumTopError("unavailable", 503)
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
        is_v2 = "publication_contract_version" in value
        if is_v2:
            validate_snapshot_v2(value, share_ref=share_ref, item_ref=item_ref, limit=page["limit"])
            publication_ref = public_ref(value["publication_ref"])
        else:
            # A missing version must never turn artwork into legacy data and
            # bypass post-construction admission. Preserve valid v1 doubles and
            # its existing HTML positive projection of unrelated extra fields.
            rows = value.get("items", [])
            if type(rows) is not list or len(rows) > 100:
                raise AlbumTopError("unavailable", 503)
            if "item" in value:
                rows = [*rows, value["item"]]
            if any(type(row) is not dict or row.get("artwork_ref") is not None for row in rows):
                raise AlbumTopError("unavailable", 503)
        response = _response(request, {"status": "ready", "data": value}, bounded=is_v2, **subject)
        if is_v2 and response.status_code == 200:
            # Response construction is complete, including HEAD's suppressed
            # representation. Fresh current authority is not a cached read.
            await run_in_threadpool(service.recheck_guest_response, share_ref=share_ref,
                publication_ref=publication_ref, publication_contract_version=2, item_ref=item_ref,
                request_origin=RequestOrigin("network", origin),
                constraints=resolver if callable(resolver) else None)
            if public_share_request_origin(request) != origin:
                raise AlbumTopError("unavailable", 404)
            # No render, response SQL, hashing or intervening await follows.
        return response
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


def _png_error(request, *, status, code):
    response = JSONResponse({"ok": False, "error": code}, status_code=status, headers=_PNG_HEADERS)
    if request.method == "HEAD":
        response.body = b""
    return response


@router.api_route("/public/album-tops/{share_ref}/publications/{publication_ref}/items/{item_ref}/artwork/{asset_ref}.png",
                  methods=["GET", "HEAD"])
async def read_public_album_top_artwork(request: Request, share_ref: str, publication_ref: str,
                                        item_ref: str, asset_ref: str):
    try:
        origin = public_share_request_origin(request)
        if origin is None:
            raise AlbumTopError("unavailable", 404)
        share_ref, publication_ref = public_ref(share_ref), public_ref(publication_ref)
        item_ref, asset_ref = public_ref(item_ref), public_ref(asset_ref)
        if request.scope.get("query_string", b""):
            raise AlbumTopError("invalid_query", 400)
        service = getattr(request.app.state, "public_album_tops_service", None)
        if service is None:
            service = PostgresPublicAlbumTopsService(request.app.state.config)
        resolver = getattr(request.app.state, "policy_constraint_resolver", None)
        constraints = resolver if callable(resolver) else None
        head_only = request.method == "HEAD"
        value = await run_in_threadpool(service.read_guest_artwork, share_ref=share_ref,
            publication_ref=publication_ref, item_ref=item_ref, asset_ref=asset_ref,
            head_only=head_only, request_origin=RequestOrigin("network", origin), constraints=constraints)
        if (type(value) is not dict or set(value) != {"content_type", "content_length", "body"}
                or value["content_type"] != "image/png" or type(value["body"]) is not bytes):
            raise AlbumTopError("unavailable", 503)
        length = snapshot_integer(value["content_length"], maximum=MAX_PUBLIC_PNG_BYTES)
        if len(value["body"]) != (0 if head_only else length):
            raise AlbumTopError("unavailable", 503)
        response = Response(value["body"], media_type="image/png",
            headers={**_PNG_HEADERS, "Content-Length": str(length)})
        # Conditional/Range headers never select a cache or partial-body path.
        # GET bytes/hash and HEAD metadata were validated by the fixed reader;
        # even GET's final admission uses a header-only query.
        await run_in_threadpool(service.recheck_guest_response, share_ref=share_ref,
            publication_ref=publication_ref, publication_contract_version=2,
            item_ref=item_ref, asset_ref=asset_ref,
            request_origin=RequestOrigin("network", origin), constraints=constraints)
        if public_share_request_origin(request) != origin:
            raise AlbumTopError("unavailable", 404)
        return response
    except AlbumTopError as error:
        # The new image perimeter discloses no private authorization distinction.
        status = error.status_code if error.status_code in (400, 404, 503) else 404
        code = "invalid_query" if status == 400 and error.code == "invalid_query" else "unavailable"
        return _png_error(request, status=status, code=code)
    except Exception:
        return _png_error(request, status=503, code="unavailable")
