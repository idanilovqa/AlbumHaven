"""The picker identity follows exact saved media bytes; persistence remains canonical."""
import hashlib
from pathlib import Path

from music_app.services.cover_state import selected_local_cover_source, serialize_cover_gallery_payload


def candidate(path: Path):
    return {"path": str(path)}


def test_matching_source_is_selected_without_changing_canonical_file(tmp_path):
    canonical = tmp_path / "cover.jpg"
    original = tmp_path / "cover-original.jpg"
    alternative = tmp_path / "cover-alternate.jpg"
    canonical.write_bytes(b"selected image")
    alternative.write_bytes(b"selected image")
    original.write_bytes(b"original image")
    digest = hashlib.sha256(canonical.read_bytes()).hexdigest()
    rows = [candidate(original), candidate(alternative), candidate(canonical)]
    assert selected_local_cover_source(rows, canonical, digest) == str(alternative)
    assert canonical.read_bytes() == b"selected image"
    assert original.read_bytes() == b"original image"


def test_source_falls_back_when_deleted_or_changed_even_at_same_size(tmp_path):
    canonical, source = tmp_path / "cover.jpg", tmp_path / "alternate.jpg"
    canonical.write_bytes(b"image-a")
    source.write_bytes(b"image-b")
    digest = hashlib.sha256(canonical.read_bytes()).hexdigest()
    rows = [candidate(source), candidate(canonical)]
    assert selected_local_cover_source(rows, canonical, digest) == str(canonical)
    source.unlink()
    assert selected_local_cover_source(rows, canonical, digest) == str(canonical)
    assert selected_local_cover_source(rows, None, None) is None


def test_initial_unrevisioned_media_retains_canonical_identity_despite_identical_sources(tmp_path):
    canonical, source = tmp_path / "cover.jpg", tmp_path / "cover-original.jpg"
    canonical.write_bytes(b"original")
    source.write_bytes(b"original")
    for rows in ([candidate(canonical), candidate(source)], [candidate(source), candidate(canonical)]):
        assert selected_local_cover_source(rows, canonical, None) == str(canonical)


def test_gallery_keeps_canonical_authority_and_exposes_picker_source(tmp_path):
    canonical, source = tmp_path / "cover.jpg", tmp_path / "alternate.jpg"
    canonical.write_bytes(b"saved")
    source.write_bytes(b"saved")
    revision = hashlib.sha256(b"saved").hexdigest()
    cache = {"track.mp3": {"cover_path": str(canonical), "cover_revision": revision}}
    payload = serialize_cover_gallery_payload(album_root=tmp_path, track_paths={"track.mp3"},
        file_cache=cache, image_extensions={".jpg"}, image_dimensions=lambda _path: (32, 32),
        is_squareish_cover=lambda _width, _height: True)
    assert payload["active_cover_path"] == str(canonical)
    assert payload["selected_source_path"] == str(source)
    active = [item for item in payload["local_covers"] if item["is_active"]]
    assert len(active) == 1
    assert active[0]["path"] == str(canonical)
    assert active[0]["cover_revision"] == revision
    source_row = next(row for row in payload["local_covers"] if row["path"] == str(source))
    assert source_row["cover_revision"] == revision
    cache["track.mp3"]["remote_cover_url"] = "https://example.test/cover.jpg"
    remote = serialize_cover_gallery_payload(album_root=tmp_path, track_paths={"track.mp3"},
        file_cache=cache, image_extensions={".jpg"}, image_dimensions=lambda _path: (32, 32),
        is_squareish_cover=lambda _width, _height: True)
    assert remote["selected_source_path"] is None
    assert not any(item["is_active"] for item in remote["local_covers"])


def test_initial_gallery_keeps_canonical_candidate_without_claiming_a_saved_source(tmp_path):
    canonical, source = tmp_path / "cover.jpg", tmp_path / "CD.JPG"
    canonical.write_bytes(b"initial cover")
    source.write_bytes(b"initial cover")
    cache = {"track.mp3": {"cover_path": str(canonical)}}
    payload = serialize_cover_gallery_payload(album_root=tmp_path, track_paths={"track.mp3"},
        file_cache=cache, image_extensions={".jpg"}, image_dimensions=lambda _path: (32, 32),
        is_squareish_cover=lambda _width, _height: True)
    assert payload["active_cover_path"] == str(canonical)
    assert payload["selected_source_path"] == str(canonical)
    assert [row["path"] for row in payload["local_covers"] if row["is_active"]] == [str(canonical)]
    assert all("cover_revision" not in row for row in payload["local_covers"])


def test_initial_gallery_identifies_exact_duplicates_without_removing_local_files(tmp_path):
    canonical = tmp_path / "cover.jpg"
    original = tmp_path / "cover-original.jpg"
    alternate = tmp_path / "cover-alternate.jpg"
    canonical.write_bytes(b"image-a")
    original.write_bytes(b"image-a")
    alternate.write_bytes(b"image-b")  # Same length and dimensions are not equality.
    cache = {"track.mp3": {"cover_path": str(canonical)}}
    def read():
        return serialize_cover_gallery_payload(album_root=tmp_path, track_paths={"track.mp3"},
            file_cache=cache, image_extensions={".jpg"}, image_dimensions=lambda _path: (32, 32),
            is_squareish_cover=lambda _width, _height: True)
    payload = read()
    rows = {row["path"]: row for row in payload["local_covers"]}
    assert set(rows) == {str(canonical), str(original), str(alternate)}
    assert rows[str(original)].get("duplicate_of") == str(canonical)
    assert "duplicate_of" not in rows[str(alternate)]
    assert "duplicate_of" not in rows[str(canonical)]
    assert payload["selected_source_path"] == str(canonical)
    assert all("cover_revision" not in row for row in rows.values())
    original.write_bytes(b"image-c")
    assert all("duplicate_of" not in row for row in read()["local_covers"])
    original.unlink()
    assert len(read()["local_covers"]) == 2
    canonical.unlink()
    assert all("duplicate_of" not in row for row in read()["local_covers"])


def test_saved_or_remote_cover_does_not_apply_initial_duplicate_projection(tmp_path):
    canonical, source = tmp_path / "cover.jpg", tmp_path / "source.jpg"
    canonical.write_bytes(b"saved")
    source.write_bytes(b"saved")
    revision = hashlib.sha256(b"saved").hexdigest()
    cache = {"track.mp3": {"cover_path": str(canonical), "cover_revision": revision}}
    def read():
        return serialize_cover_gallery_payload(album_root=tmp_path, track_paths={"track.mp3"},
            file_cache=cache, image_extensions={".jpg"}, image_dimensions=lambda _path: (32, 32),
            is_squareish_cover=lambda _width, _height: True)
    saved = read()
    assert saved["selected_source_path"] == str(source)
    assert all("duplicate_of" not in row for row in saved["local_covers"])
    cache["track.mp3"].pop("cover_revision")
    cache["track.mp3"]["remote_cover_url"] = "https://example.test/cover.jpg"
    remote = read()
    assert remote["selected_source_path"] is None
    assert all("duplicate_of" not in row for row in remote["local_covers"])
