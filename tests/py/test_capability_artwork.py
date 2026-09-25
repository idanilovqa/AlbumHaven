"""A View grant cannot use artwork paths as an alternate raw-media download."""

from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image, PngImagePlugin

from music_app.services.capability_artwork import render_browse_artwork


def test_artwork_reencodes_pixels_without_appended_audio_or_metadata(tmp_path):
    path = tmp_path / "cover.png"
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "private-metadata-must-not-leak")
    Image.new("RGB", (40, 30), "red").save(path, pnginfo=metadata)
    with path.open("ab") as output:
        output.write(b"ID3 appended-raw-audio-must-not-leak")
    original = path.read_bytes()
    response = render_browse_artwork(path)
    assert response.media_type == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in response.headers["cache-control"]
    assert b"private-metadata" not in response.body
    assert b"appended-raw-audio" not in response.body
    with Image.open(BytesIO(response.body)) as decoded:
        assert decoded.size == (40, 30)
        assert decoded.getpixel((0, 0)) == (255, 0, 0)
    assert path.read_bytes() == original


@pytest.mark.parametrize("name,payload", [
    ("track.mp3", b"ID3 raw audio"),
    ("fake-cover.jpg", b"ID3 renamed audio"),
    ("cover.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
])
def test_non_images_are_denied_regardless_of_extension(tmp_path, name, payload):
    path = tmp_path / name
    path.write_bytes(payload)
    with pytest.raises(HTTPException) as error:
        render_browse_artwork(path)
    assert error.value.status_code == 404


def test_missing_artwork_does_not_expose_filesystem_error(tmp_path):
    with pytest.raises(HTTPException) as error:
        render_browse_artwork(tmp_path / "missing.png")
    assert error.value.detail == "Artwork not found."


def test_oversized_pixels_are_denied_before_decoding(tmp_path, monkeypatch):
    path = tmp_path / "cover.png"
    Image.new("RGB", (20, 20)).save(path)
    monkeypatch.setattr("music_app.services.capability_artwork._MAX_PIXELS", 10)
    with pytest.raises(HTTPException) as error:
        render_browse_artwork(path)
    assert error.value.status_code == 404


def test_artwork_output_has_bounded_dimensions(tmp_path):
    path = tmp_path / "cover.jpg"
    Image.new("RGB", (3000, 1000)).save(path)
    response = render_browse_artwork(path)
    with Image.open(BytesIO(response.body)) as decoded:
        assert decoded.width == 2048
        assert decoded.height < 2048
