"""COV-003: replacing a cover chosen from Other art must keep that art visible in Cover Look Up."""

import base64
import io
from pathlib import Path

import pytest

Image = pytest.importorskip("PIL.Image")

from music_app.services.cover_state import iter_local_cover_candidates
from music_app.services.cover_workflow import save_pasted_image_as_authoritative_cover
from music_app.services.covers import image_dimensions


def _image_bytes(size, color, fmt="JPEG"):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def _squareish(width, height):
    return width > 0 and height > 0 and abs(width - height) / max(width, height) <= 0.18


def test_pasting_a_new_cover_keeps_the_replaced_other_art_in_the_gallery(tmp_path):
    album = tmp_path / "Тиль Уленшпигель" / "Вавилон"
    album.mkdir(parents=True)
    other_art = _image_bytes((600, 380), (120, 40, 40))  # a wide image the owner chose from Other art
    (album / "cover.jpg").write_bytes(other_art)
    pasted = "data:image/png;base64," + base64.b64encode(_image_bytes((500, 500), (20, 60, 120), "PNG")).decode()

    saved = save_pasted_image_as_authoritative_cover(pasted, album)

    candidates = iter_local_cover_candidates(
        album, image_extensions={".jpg", ".png"}, image_dimensions=image_dimensions,
        is_squareish_cover=_squareish, active_cover_path=saved,
    )
    by_name = {Path(item["path"]).name: item for item in candidates}
    assert by_name["cover.jpg"]["is_squareish"] is True
    kept = [item for name, item in by_name.items() if name.startswith("cover-existing-")]
    assert len(kept) == 1, "the replaced art stays a real, listed file"
    assert kept[0]["is_squareish"] is False, "it is listed under Other art again"
    assert Path(kept[0]["path"]).read_bytes() == other_art
