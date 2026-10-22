"""Image-only artwork projection for an actor without raw-media permission.

The existing /cover endpoint also accepts arbitrary configured media paths.
A browse grant must never make that endpoint an alternate audio download route.
Re-encode decoded pixels, discarding metadata and appended/non-image payloads.
The established full-media path is unchanged for already-authorized users.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from music_app.services.artwork_pixels import (
    IMAGE_FORMATS, ArtworkPixelsUnavailable, sanitize_artwork_pixels,
)

_MAX_INPUT_BYTES = 32 * 1024 * 1024
_MAX_PIXELS = 40_000_000
_MAX_EDGE = 2048
_IMAGE_FORMATS = IMAGE_FORMATS


def render_browse_artwork(path: Path) -> Response:
    """Return only decoded image pixels from an already root-validated path."""
    try:
        with path.open("rb") as source:
            payload = source.read(_MAX_INPUT_BYTES + 1)
        artwork = sanitize_artwork_pixels(payload, max_input_bytes=_MAX_INPUT_BYTES,
            max_pixels=_MAX_PIXELS, max_edge=_MAX_EDGE)
    except (OSError, ValueError, ArtworkPixelsUnavailable):
        raise HTTPException(status_code=404, detail="Artwork not found.") from None
    return Response(
        artwork.png, media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


async def browse_artwork_response(request) -> Response | None:
    """Use the restricted representation only when raw media is not allowed."""
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
    resolved = await run_in_threadpool(resolve_configured_media_path, config, raw_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Artwork not found.")
    return await run_in_threadpool(render_browse_artwork, resolved)
