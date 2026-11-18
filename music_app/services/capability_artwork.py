"""Image-only artwork projection for an actor without raw-media permission.

The legacy /cover?path= endpoint accepts only paths the library names as covers, and
/cover/{reference} only references; a browse grant must never make either an audio route.
Re-encode decoded pixels, discarding metadata and appended/non-image payloads.
The established full-media path is unchanged for already-authorized users.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

_MAX_INPUT_BYTES = 32 * 1024 * 1024
_MAX_PIXELS = 40_000_000
_MAX_EDGE = 2048
_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF"})


def sanitized_artwork(path: Path, *, max_edge: int = _MAX_EDGE, image_format: str = "PNG") -> bytes:
    """Decoded pixels of an already root-validated image, re-encoded without metadata.

    [max_edge] bounds the longer side; JPEG output drops transparency. Raises HTTP 404 for
    anything that is not a bounded supported image, naming no path.
    """
    try:
        with path.open("rb") as source:
            payload = source.read(_MAX_INPUT_BYTES + 1)
        if len(payload) > _MAX_INPUT_BYTES:
            raise ValueError("Artwork exceeds the image limit.")
        with Image.open(BytesIO(payload)) as image:
            if image.format not in _IMAGE_FORMATS or image.width * image.height > _MAX_PIXELS:
                raise ValueError("Artwork is not a supported bounded image.")
            edge = min(_MAX_EDGE, max(1, max_edge))
            image.thumbnail((edge, edge))
            alpha = image_format != "JPEG" and ("A" in image.getbands() or "transparency" in image.info)
            mode = "RGBA" if alpha else "RGB"
            pixels = image.convert(mode)
            # A fresh image deliberately omits EXIF, comments and other metadata.
            sanitized = Image.new(mode, pixels.size)
            sanitized.paste(pixels)
            output = BytesIO()
            sanitized.save(output, format=image_format, **({"quality": 85} if image_format == "JPEG" else {}))
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(status_code=404, detail="Artwork not found.") from None
    return output.getvalue()


def render_browse_artwork(path: Path, *, max_edge: int = _MAX_EDGE, cache_control: str = "private, no-store",
                          etag: str = "") -> Response:
    """Return only decoded image pixels from an already root-validated path."""
    headers = {"Cache-Control": cache_control, "X-Content-Type-Options": "nosniff"}
    if etag:
        headers["ETag"] = etag
    return Response(sanitized_artwork(path, max_edge=max_edge), media_type="image/png", headers=headers)


async def browse_artwork_response(request) -> Response | None:
    """Use the restricted representation only when raw media is not allowed."""
    if any(key in request.query_params for key in ("library_id", "album_id", "selection_id")):
        from music_app.services.ordered_cover_presentation import selected_cover_artwork_response

        try:
            return await selected_cover_artwork_response(request)
        except HTTPException as error:
            # Saved identities are stable across source recovery and library
            # switches. Do not let a cached failure outlive this request.
            error.headers = {**(error.headers or {}), "Cache-Control": "private, no-store"}
            raise
    from music_app.services.policy_asgi import allowed_actions_for_request

    allowed = allowed_actions_for_request(request, ("library.media.read",)).as_payload()
    if allowed.get("library.media.read") is True:
        return None
    from music_app.services.library_roots import resolve_configured_media_path

    config = getattr(request.app.state, "config", {})
    raw_path = str(request.query_params.get("path") or "")
    loop_id = request.query_params.get("loop_id")
    if loop_id:
        from music_app.services.loop_request_scope import saved_loop_scope
        from music_app.services.loops import get_loop

        scope = await saved_loop_scope(request)
        item = await run_in_threadpool(get_loop, config, loop_id, **scope)
        if item is None or not item.get("cover_path"):
            raise HTTPException(status_code=404, detail="Artwork not found.")
        # Ignore a supplied path: only this owned loop's stored cover is eligible.
        raw_path = str(item["cover_path"])
    else:
        from music_app.services.cover_references import legacy_cover_path_is_named

        store = getattr(request.app.state, "cover_reference_store", None)
        actor = getattr(request.state, "current_actor", None)
        if not await run_in_threadpool(legacy_cover_path_is_named, store, actor, raw_path):
            raise HTTPException(status_code=404, detail="Artwork not found.")
    resolved = await run_in_threadpool(resolve_configured_media_path, config, raw_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Artwork not found.")
    return await run_in_threadpool(render_browse_artwork, resolved)
