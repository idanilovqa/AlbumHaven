"""Shared pixel-only artwork sanitizer; no file, authority or network access.

Limits are supplied by the owning representation. Private browse artwork keeps
its established budgets; immutable public thumbnails use their smaller budget.
Only a newly allocated RGB/RGBA pixel plane is encoded, never the source image.
"""
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageFile, UnidentifiedImageError


IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF"})


class ArtworkPixelsUnavailable(ValueError):
    """No sanitized result was produced; contains no source paths or metadata."""


@dataclass(frozen=True)
class SanitizedArtworkPixels:
    png: bytes
    width: int
    height: int
    input_bytes: int
    input_pixels: int


class _BoundedOutput(BytesIO):
    def __init__(self, maximum):
        super().__init__()
        self.maximum = maximum

    def write(self, value):
        if self.maximum is not None and self.tell() + len(value) > self.maximum:
            raise ArtworkPixelsUnavailable("artwork_output_limit")
        return super().write(value)


def sanitize_artwork_pixels(payload, *, max_input_bytes, max_pixels, max_edge,
                            max_output_bytes=None):
    """Decode frame zero within explicit budgets and return metadata-free PNG.

    Encoded input and advertised dimensions are bounded before pixel decoding.
    Output writes are bounded while encoding. An ambient permissive truncated
    image setting is refused rather than changing Pillow process-global state.
    Appended bytes may be present in input; only decoded pixels reach output.
    """
    if (any(type(value) is not int or value <= 0
            for value in (max_input_bytes, max_pixels, max_edge))
            or max_output_bytes is not None
            and (type(max_output_bytes) is not int or max_output_bytes <= 0)):
        raise ValueError("invalid_artwork_budget")
    if type(payload) is not bytes or not payload or len(payload) > max_input_bytes:
        raise ArtworkPixelsUnavailable("artwork_input_limit")
    if ImageFile.LOAD_TRUNCATED_IMAGES:
        raise ArtworkPixelsUnavailable("artwork_decoder_unavailable")
    try:
        with Image.open(BytesIO(payload), formats=tuple(sorted(IMAGE_FORMATS))) as image:
            width, height = image.size
            if (image.format not in IMAGE_FORMATS or width <= 0 or height <= 0
                    or width * height > max_pixels):
                raise ArtworkPixelsUnavailable("artwork_pixel_limit")
            # Verify container checksums/termination where the format provides
            # verification, then reopen the same bounded immutable byte string.
            image.verify()
        with Image.open(BytesIO(payload), formats=tuple(sorted(IMAGE_FORMATS))) as image:
            # Never advance through animation or enumerate later frame sizes.
            image.seek(0)
            image.thumbnail((max_edge, max_edge))
            image.load()
            mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
            with image.convert(mode) as pixels:
                with Image.new(mode, pixels.size) as sanitized:
                    sanitized.paste(pixels)
                    with _BoundedOutput(max_output_bytes) as output:
                        sanitized.save(output, format="PNG")
                        return SanitizedArtworkPixels(output.getvalue(), sanitized.width,
                            sanitized.height, len(payload), width * height)
    except ArtworkPixelsUnavailable:
        raise
    except (OSError, ValueError, SyntaxError, EOFError, UnidentifiedImageError,
            Image.DecompressionBombError):
        raise ArtworkPixelsUnavailable("artwork_invalid") from None
