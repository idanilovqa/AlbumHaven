"""Image-only artwork projection for an actor without raw-media permission.

The existing /cover endpoint also accepts arbitrary configured media paths.
A browse grant must never make that endpoint an alternate audio download route.
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


def render_browse_artwork(path: Path) -> Response:
    """Return only decoded image pixels from an already root-validated path."""
    try:
        with path.open("rb") as source:
            payload = source.read(_MAX_INPUT_BYTES + 1)
        if len(payload) > _MAX_INPUT_BYTES:
            raise ValueError("Artwork exceeds the image limit.")
        with Image.open(BytesIO(payload)) as image:
            if image.format not in _IMAGE_FORMATS or image.width * image.height > _MAX_PIXELS:
                raise ValueError("Artwork is not a supported bounded image.")
            image.thumbnail((_MAX_EDGE, _MAX_EDGE))
            mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
            pixels = image.convert(mode)
            # A fresh image deliberately omits EXIF, comments and other metadata.
            sanitized = Image.new(mode, pixels.size)
            sanitized.paste(pixels)
            output = BytesIO()
            sanitized.save(output, format="PNG")
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(status_code=404, detail="Artwork not found.") from None
    return Response(
        output.getvalue(), media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


async def browse_artwork_response(request) -> Response | None:
    """Use the restricted representation only when raw media is not allowed."""
    from music_app.services.policy_asgi import allowed_actions_for_request

    allowed = allowed_actions_for_request(request, ("library.media.read",)).as_payload()
    if allowed.get("library.media.read") is True:
        return None
    # Saved-loop artwork uses its own resource ownership path in web_asgi. It is
    # not resolved through a user-supplied path under browse-only authority.
    if request.query_params.get("loop_id"):
        raise HTTPException(status_code=403, detail="Action not permitted.")
    from music_app.services.library_roots import resolve_configured_media_path

    config = getattr(request.app.state, "config", {})
    raw_path = str(request.query_params.get("path") or "")
    resolved = await run_in_threadpool(resolve_configured_media_path, config, raw_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Artwork not found.")
    return await run_in_threadpool(render_browse_artwork, resolved)
