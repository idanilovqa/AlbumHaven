"""Additive actual-image checks for the shared pixel sanitizer (root-run only)."""
from io import BytesIO
import struct

import pytest
from PIL import Image, ImageFile, PngImagePlugin

from music_app.services import artwork_pixels as pixels
from music_app.services import capability_artwork as browse


def encoded(format="PNG", *, mode="RGB", size=(31, 19), **save_options):
    output = BytesIO()
    with Image.new(mode, size, (200, 30, 80, 120) if mode == "RGBA" else (200, 30, 80)) as image:
        image.save(output, format=format, **save_options)
    return output.getvalue()


def sanitize(payload, **budgets):
    return pixels.sanitize_artwork_pixels(payload, **{
        "max_input_bytes": 16 * 1024 * 1024, "max_pixels": 16_000_000,
        "max_edge": 256, "max_output_bytes": 320 * 1024, **budgets})


def png_chunks(payload):
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    names = []
    while offset < len(payload):
        size, name = struct.unpack(">I4s", payload[offset:offset + 8])
        names.append(name)
        end = offset + 12 + size
        assert end <= len(payload)
        offset = end
        if name == b"IEND":
            assert offset == len(payload)
            break
    assert names[-1] == b"IEND"
    return names


@pytest.mark.parametrize("format", sorted(pixels.IMAGE_FORMATS))
def test_every_fixed_raster_format_becomes_fresh_png(format):
    result = sanitize(encoded(format))
    assert (result.width, result.height, result.input_pixels) == (31, 19, 589)
    assert result.input_bytes > 0
    assert set(png_chunks(result.png)) <= {b"IHDR", b"IDAT", b"IEND"}
    with Image.open(BytesIO(result.png)) as decoded:
        assert decoded.format == "PNG"
        assert decoded.mode == "RGB"
        assert decoded.info == {}
        assert decoded.size == (31, 19)


def test_png_metadata_and_appended_polyglot_do_not_survive():
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "private-comment-token")
    metadata.add_itxt("source", "private-path-token")
    payload = encoded(pnginfo=metadata, icc_profile=b"private-profile-token")
    payload += b"ID3 private-appended-audio-token <script>private-script-token</script>"
    result = sanitize(payload)
    assert result.input_bytes == len(payload)
    for token in (b"private-comment-token", b"private-path-token", b"private-profile-token",
                  b"private-appended-audio-token", b"private-script-token"):
        assert token not in result.png
    assert set(png_chunks(result.png)) <= {b"IHDR", b"IDAT", b"IEND"}


def test_jpeg_exif_and_profile_are_not_copied():
    exif = Image.Exif()
    exif[270] = "private-exif-token"
    result = sanitize(encoded("JPEG", exif=exif, icc_profile=b"private-profile-token"))
    with Image.open(BytesIO(result.png)) as decoded:
        assert not decoded.getexif()
        assert decoded.info == {}
    assert b"private-exif-token" not in result.png
    assert b"private-profile-token" not in result.png


@pytest.mark.parametrize("format", ["GIF", "TIFF", "PNG", "WEBP"])
def test_only_first_frame_is_decoded_and_encoded(format):
    output = BytesIO()
    with Image.new("RGB", (12, 9), "red") as first, Image.new("RGB", (12, 9), "blue") as later:
        first.save(output, format=format, save_all=True, append_images=[later],
                   duration=50, loop=0, lossless=True)
    result = sanitize(output.getvalue())
    with Image.open(BytesIO(result.png)) as decoded:
        assert decoded.n_frames == 1
        assert decoded.convert("RGB").getpixel((0, 0)) == (255, 0, 0)


def test_alpha_survives_without_metadata():
    result = sanitize(encoded(mode="RGBA"))
    with Image.open(BytesIO(result.png)) as decoded:
        assert decoded.mode == "RGBA"
        assert decoded.getpixel((0, 0)) == (200, 30, 80, 120)
        assert decoded.info == {}


def test_palette_transparency_survives_as_rgba():
    output = BytesIO()
    with Image.new("P", (8, 8), 0) as image:
        image.putpalette([255, 0, 0] + [0, 0, 0] * 255)
        image.save(output, format="PNG", transparency=0)
    result = sanitize(output.getvalue())
    with Image.open(BytesIO(result.png)) as decoded:
        assert decoded.mode == "RGBA"
        assert decoded.getpixel((0, 0))[3] == 0
        assert decoded.info == {}


@pytest.mark.parametrize("payload", [b"", b"ID3 renamed-audio", b"<svg></svg>",
    b"<html><img src='https://example.invalid/private'></html>", b"%PDF-1.7"])
def test_non_raster_input_is_rejected(payload):
    with pytest.raises(pixels.ArtworkPixelsUnavailable):
        sanitize(payload)


def test_unsupported_raster_format_is_rejected():
    with pytest.raises(pixels.ArtworkPixelsUnavailable):
        sanitize(encoded("PPM"))


def test_corrupt_and_truncated_png_are_rejected():
    payload = encoded()
    corrupt = bytearray(payload)
    # The IHDR width change has an invalid checksum and cannot be decoded.
    corrupt[19] ^= 1
    for invalid in (payload[:len(payload) // 2], payload[:-12], bytes(corrupt)):
        with pytest.raises(pixels.ArtworkPixelsUnavailable):
            sanitize(invalid)


def test_encoded_input_budget_is_inclusive_and_checked_before_open(monkeypatch):
    payload = encoded()
    assert sanitize(payload, max_input_bytes=len(payload)).input_bytes == len(payload)
    def forbidden(*args, **kwargs):
        raise AssertionError("oversize input reached decoder")
    monkeypatch.setattr(pixels.Image, "open", forbidden)
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_input_limit"):
        sanitize(payload, max_input_bytes=len(payload) - 1)


def test_decoded_pixel_budget_is_inclusive_and_precedes_load(monkeypatch):
    payload = encoded(size=(20, 20))
    assert sanitize(payload, max_pixels=400).input_pixels == 400
    def forbidden(*args, **kwargs):
        raise AssertionError("oversize dimensions reached pixel load")
    monkeypatch.setattr(PngImagePlugin.PngImageFile, "load", forbidden)
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_pixel_limit"):
        sanitize(payload, max_pixels=399)


def test_edge_budget_preserves_aspect_ratio_without_upscaling():
    result = sanitize(encoded(size=(1024, 512)))
    assert (result.width, result.height) == (256, 128)
    small = sanitize(encoded(size=(10, 20)))
    assert (small.width, small.height) == (10, 20)


def test_output_budget_is_inclusive_and_checked_while_encoding():
    payload = encoded(mode="RGBA")
    result = sanitize(payload)
    assert sanitize(payload, max_output_bytes=len(result.png)).png == result.png
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_output_limit"):
        sanitize(payload, max_output_bytes=len(result.png) - 1)


def test_bounded_output_does_not_retain_overflow_bytes():
    output = pixels._BoundedOutput(3)
    output.write(b"ab")
    with pytest.raises(pixels.ArtworkPixelsUnavailable):
        output.write(b"cd")
    assert output.getvalue() == b"ab"


def test_ambient_truncated_decoder_mode_fails_closed(monkeypatch):
    monkeypatch.setattr(ImageFile, "LOAD_TRUNCATED_IMAGES", True)
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_decoder_unavailable"):
        sanitize(encoded())
    assert ImageFile.LOAD_TRUNCATED_IMAGES is True


@pytest.mark.parametrize("budget,value", [("max_input_bytes", True), ("max_pixels", 0),
    ("max_edge", -1), ("max_output_bytes", "1")])
def test_invalid_budget_is_not_an_unbounded_fallback(budget, value):
    with pytest.raises(ValueError, match="invalid_artwork_budget"):
        sanitize(encoded(), **{budget: value})


def test_private_renderer_uses_same_sanitizer_and_preserves_its_budgets(tmp_path, monkeypatch):
    assert (browse._MAX_INPUT_BYTES, browse._MAX_PIXELS, browse._MAX_EDGE) == (
        32 * 1024 * 1024, 40_000_000, 2048)
    path = tmp_path / "cover.png"
    path.write_bytes(encoded(size=(3000, 1000)))
    calls = []
    real = browse.sanitize_artwork_pixels
    def checked(payload, **kwargs):
        calls.append(kwargs)
        return real(payload, **kwargs)
    monkeypatch.setattr(browse, "sanitize_artwork_pixels", checked)
    response = browse.render_browse_artwork(path)
    assert calls == [{"max_input_bytes": 32 * 1024 * 1024,
                      "max_pixels": 40_000_000, "max_edge": 2048}]
    assert response.media_type == "image/png"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    with Image.open(BytesIO(response.body)) as decoded:
        assert decoded.width == 2048


def test_actual_public_sixteen_million_pixel_boundary():
    at_limit = encoded(size=(4000, 4000))
    assert sanitize(at_limit).input_pixels == 16_000_000
    above_limit = encoded(size=(4001, 4000))
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_pixel_limit"):
        sanitize(above_limit)


def test_actual_public_sixteen_mebibyte_input_boundary():
    image = encoded()
    at_limit = image + b"x" * (16 * 1024 * 1024 - len(image))
    assert sanitize(at_limit).input_bytes == 16 * 1024 * 1024
    with pytest.raises(pixels.ArtworkPixelsUnavailable, match="artwork_input_limit"):
        sanitize(at_limit + b"x")


def test_full_rgba_noise_thumbnail_fits_public_output_budget():
    import random
    output = BytesIO()
    plane = random.Random(417).randbytes(256 * 256 * 4)
    with Image.frombytes("RGBA", (256, 256), plane) as image:
        image.save(output, format="PNG")
    result = sanitize(output.getvalue())
    assert (result.width, result.height) == (256, 256)
    assert 256 * 1024 < len(result.png) <= 320 * 1024
    with Image.open(BytesIO(result.png)) as image:
        assert image.tobytes() == plane


def test_public_budgets_do_not_reduce_private_input_or_pixel_limits(tmp_path):
    path = tmp_path / "private.png"
    path.write_bytes(encoded(size=(4001, 4000)))
    response = browse.render_browse_artwork(path)
    with Image.open(BytesIO(response.body)) as image:
        assert max(image.size) == 2048
    small = encoded()
    path.write_bytes(small + b"x" * (32 * 1024 * 1024 - len(small)))
    assert browse.render_browse_artwork(path).media_type == "image/png"
    with path.open("ab") as output:
        output.write(b"x")
    with pytest.raises(browse.HTTPException) as error:
        browse.render_browse_artwork(path)
    assert error.value.status_code == 404
