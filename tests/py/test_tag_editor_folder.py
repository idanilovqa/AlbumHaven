from pathlib import Path

import pytest

from music_app.services import tag_editor_folder


def _config(root: Path) -> dict[str, object]:
    return {
        "SUPPORTED_EXTENSIONS": {".mp3", ".flac"},
        "_library_root_paths_snapshot": (root.resolve(),),
    }


def test_load_folder_files_validates_membership_filters_and_naturally_orders(tmp_path, monkeypatch):
    root = tmp_path / "music"
    folder = root / "album"
    folder.mkdir(parents=True)
    source = folder / "01.mp3"
    source.write_bytes(b"one")
    (folder / "10.mp3").write_bytes(b"ten")
    (folder / "2.flac").write_bytes(b"two")
    (folder / "cover.jpg").write_bytes(b"image")
    (folder / "disc 2").mkdir()
    (folder / "disc 2" / "03.mp3").write_bytes(b"nested")
    monkeypatch.setattr(
        tag_editor_folder,
        "read_editable_tag_values",
        lambda path, _fields: {"title": path.stem, "album": "Album"},
    )

    payload = tag_editor_folder.load_tag_editor_folder_files(
        _config(root),
        str(source),
        indexed_paths={str(source)},
    )

    assert payload["folder_path"] == str(folder.resolve())
    assert [Path(track["path"]).name for track in payload["tracks"]] == ["01.mp3", "2.flac", "10.mp3"]


def test_load_folder_files_rejects_unindexed_or_outside_source(tmp_path):
    root = tmp_path / "music"
    root.mkdir()
    source = root / "one.mp3"
    source.write_bytes(b"one")

    with pytest.raises(ValueError, match="not in this editor"):
        tag_editor_folder.load_tag_editor_folder_files(_config(root), str(source), indexed_paths=set())

    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"outside")
    with pytest.raises(ValueError, match="outside the active library"):
        tag_editor_folder.load_tag_editor_folder_files(
            _config(root),
            str(outside),
            indexed_paths={str(outside)},
        )


def test_load_folder_files_skips_unreadable_metadata(tmp_path, monkeypatch):
    root = tmp_path / "music"
    root.mkdir()
    source = root / "one.mp3"
    broken = root / "two.mp3"
    source.write_bytes(b"one")
    broken.write_bytes(b"two")

    def read(path, _fields):
        if path == broken.resolve():
            raise RuntimeError("bad tags")
        return {"title": path.stem}

    monkeypatch.setattr(tag_editor_folder, "read_editable_tag_values", read)
    payload = tag_editor_folder.load_tag_editor_folder_files(
        _config(root),
        str(source),
        indexed_paths={str(source)},
    )

    assert [Path(track["path"]).name for track in payload["tracks"]] == ["one.mp3"]

