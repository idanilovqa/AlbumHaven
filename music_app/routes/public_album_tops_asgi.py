"""Explicitly deployed metadata-only immutable Album Top reads.

The same URL returns the same public metadata for signed-in visitors. Working
Top navigation and media/progress authorization are separate later owners.
"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.policy import RequestOrigin
from music_app.services.private_route_boundary import public_share_request_origin
from music_app.services.public_album_tops import normalize_public_top_query, public_ref
from music_app.services.public_album_tops_postgres import PostgresPublicAlbumTopsService

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer"}


def _response(request, value, status=200):
    response = JSONResponse(value, status_code=status, headers=_HEADERS)
    if request.method == "HEAD":
        # Retain representation headers while sending no body; authorization and
        # current publication validation are identical to GET.
        response.body = b""
    return response


async def _read(request, share_ref, item_ref=None):
    try:
        origin = public_share_request_origin(request)
        if origin is None:
            raise AlbumTopError("unavailable", 404)
        share_ref = public_ref(share_ref)
        item_ref = public_ref(item_ref) if item_ref is not None else None
        page = normalize_public_top_query(list(request.query_params.multi_items()),
                                         kind="item" if item_ref is not None else "top")
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
        return _response(request, {"status": "ready", "data": value})
    except AlbumTopError as error:
        return _response(request, {"ok": False, "error": error.code}, error.status_code)
    except Exception:
        return _response(request, {"ok": False, "error": "unavailable"}, 503)


@router.api_route("/public/album-tops/{share_ref}", methods=["GET", "HEAD"])
async def read_public_album_top(request: Request, share_ref: str):
    return await _read(request, share_ref)


@router.api_route("/public/album-tops/{share_ref}/items/{item_ref}", methods=["GET", "HEAD"])
async def read_public_album_top_item(request: Request, share_ref: str, item_ref: str):
    return await _read(request, share_ref, item_ref)
