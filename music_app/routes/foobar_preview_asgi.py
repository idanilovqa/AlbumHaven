"""Private preview-only TSV endpoints. No source mutation or receipt."""
from __future__ import annotations

import asyncio
import hmac

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from music_app.routes.activity_native_targets_asgi import native_activity_context
from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.private_ui_context import private_ui_context_ref
from music_app.services.policy_asgi import require_action
from music_app.services.private_route_boundary import _valid_session_csrf
from music_app.services.foobar_preview_service import (
    FoobarPreviewError, FoobarPreviewService, MAX_INPUT_BYTES,
    capabilities, error_wire, _wire,
)

router = APIRouter()
_HEADERS = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}


def _response(body, status=200):
    return Response(body, status_code=status, media_type="application/json", headers=_HEADERS)


def _error(code, status):
    return _response(error_wire(code), status)


def _decimal(value, maximum):
    if (
        type(value) is not str or not 1 <= len(value) <= len(str(maximum))
        or not value.isascii() or not value.isdecimal()
        or (len(value) > 1 and value.startswith("0"))
    ):
        raise FoobarPreviewError("preview_invalid", 400)
    result = int(value)
    if result > maximum:
        raise FoobarPreviewError("preview_invalid", 400)
    return result


async def _read_upload(request, lease):
    async for chunk in request.stream():
        lease.append(chunk)


@router.get("/integrations/foobar/preview-capabilities")
async def foobar_preview_capabilities(request: Request):
    try:
        await require_action("library.browse.read")(request)
        if request.scope.get("query_string", b""):
            raise FoobarPreviewError("preview_invalid", 400)
        context_ref = private_ui_context_ref(request)
        supplied_context = request.headers.getlist("x-albumhaven-context")
        if (
            context_ref is None or len(supplied_context) != 1
            or len(supplied_context[0]) != 64 or not supplied_context[0].isascii()
            or not hmac.compare_digest(supplied_context[0], context_ref)
        ):
            raise FoobarPreviewError("preview_stale_context", 409)
        return _response(_wire(capabilities(getattr(request.app.state, "foobar_preview_service", None), context_ref)))
    except HTTPException as error:
        return _error("authentication_required" if error.status_code == 401 else "preview_denied", error.status_code)
    except FoobarPreviewError as error:
        return _error(error.code, error.status_code)
    except Exception:
        return _error("preview_unavailable", 503)


@router.post("/integrations/foobar/preview")
async def foobar_preview(request: Request):
    lease = None
    future = None
    try:
        await require_action("library.browse.read")(request)
        if not _valid_session_csrf(request):
            return _error("preview_denied", 403)
        service = getattr(request.app.state, "foobar_preview_service", None)
        if type(service) is not FoobarPreviewService or not service.available:
            raise FoobarPreviewError("preview_capacity_unavailable")
        raw_query = request.scope.get("query_string", b"")
        if type(raw_query) is not bytes or len(raw_query) > 32:
            raise FoobarPreviewError("preview_invalid", 400)
        pairs = list(request.query_params.multi_items())
        if pairs and (len(pairs) != 1 or pairs[0][0] != "offset"):
            raise FoobarPreviewError("preview_invalid", 400)
        offset = _decimal(pairs[0][1], 99999) if pairs else 0
        content_types = request.headers.getlist("content-type")
        if len(content_types) != 1 or content_types[0].lower().replace(" ", "") not in (
            "text/tab-separated-values", "text/tab-separated-values;charset=utf-8",
        ):
            raise FoobarPreviewError("preview_invalid", 400)
        lengths = request.headers.getlist("x-album-haven-foobar-bytes")
        if len(lengths) != 1:
            raise FoobarPreviewError("preview_invalid", 400)
        declared = _decimal(lengths[0], MAX_INPUT_BYTES)
        if declared == 0:
            raise FoobarPreviewError("preview_invalid", 400)
        content_lengths = request.headers.getlist("content-length")
        if content_lengths and (
            len(content_lengths) != 1 or _decimal(content_lengths[0], MAX_INPUT_BYTES) != declared
        ):
            raise FoobarPreviewError("preview_invalid", 400)
        context_ref = private_ui_context_ref(request)
        supplied_context = request.headers.getlist("x-albumhaven-context")
        if (
            context_ref is None or len(supplied_context) != 1
            or len(supplied_context[0]) != 64 or not supplied_context[0].isascii()
            or not hmac.compare_digest(supplied_context[0], context_ref)
        ):
            raise FoobarPreviewError("preview_stale_context", 409)
        context, constraints = native_activity_context(request)
        lease = service.acquire(declared)
        # Admission precedes the first body read. No temp upload file is created.
        await asyncio.wait_for(_read_upload(request, lease), timeout=30)
        lease.finish_upload()
        future = service.submit(lease, context, offset, constraints, context_ref)
        status, body = await asyncio.wrap_future(future)
        await current_actor_from_request(request, refresh=True)
        if private_ui_context_ref(request) != context_ref:
            raise FoobarPreviewError("preview_stale_context", 409)
        return _response(body, status)
    except HTTPException as error:
        return _error("authentication_required" if error.status_code == 401 else "preview_denied", error.status_code)
    except FoobarPreviewError as error:
        return _error(error.code, error.status_code)
    except TimeoutError:
        return _error("preview_unavailable", 503)
    except Exception:
        return _error("preview_unavailable", 503)
    finally:
        if lease is not None:
            # A running worker retains its slot after HTTP cancellation. A queued
            # cancelled Future clears its owned raw payload in the done callback.
            if future is not None and not future.done():
                future.cancel()
            lease.finish_request()

