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


def test_load_folder_files_includes_every_disc_from_the_authoritative_album(tmp_path, monkeypatch):
    root = tmp_path / "music"
    album = root / "Artist" / "Album"
    disc_one = album / "CD1"
    disc_two = album / "CD2"
    disc_one.mkdir(parents=True)
    disc_two.mkdir()
    source = disc_one / "10.mp3"
    earlier = disc_one / "2.mp3"
    second_disc = disc_two / "01.flac"
    for path in (source, earlier, second_disc):
        path.write_bytes(b"track")

    def resolve_album_root(_config, paths):
        assert paths == {str(source), str(earlier), str(second_disc)}
        return album.resolve()

    monkeypatch.setattr(
        tag_editor_folder,
        "resolve_album_root_from_track_paths",
        resolve_album_root,
    )
    monkeypatch.setattr(
        tag_editor_folder,
        "read_editable_tag_values",
        lambda path, _fields: {"title": path.stem, "album": "Album"},
    )

    payload = tag_editor_folder.load_tag_editor_folder_files(
        _config(root),
        str(source),
        indexed_paths={str(source), str(earlier), str(second_disc)},
    )

    assert payload["folder_path"] == str(album.resolve())
    assert [
        Path(track["path"]).relative_to(album.resolve()).as_posix()
        for track in payload["tracks"]
    ] == ["CD1/2.mp3", "CD1/10.mp3", "CD2/01.flac"]


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



def test_folder_files_contract_reads_only_the_selected_album_at_production_album_count(tmp_path, monkeypatch):
    from music_app.services import metadata
    from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    def run(album_count: int) -> OperationCounts:
        root = tmp_path / f"library-{album_count}"
        for index in range(album_count):
            sibling = root / f"Artist {index:04d}" / "Album"
            sibling.mkdir(parents=True)
            (sibling / "01.mp3").write_bytes(b"sibling")
        selected = root / "Selected" / "Album"
        selected.mkdir(parents=True)
        for name in ("01.mp3", "02.mp3", "03.flac", "cover.jpg"):
            (selected / name).write_bytes(b"selected")
        source = selected / "01.mp3"
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(metadata,)):
            payload = tag_editor_folder.load_tag_editor_folder_files(
                _config(root), str(source), indexed_paths={str(source)},
            )
        assert payload["folder_path"] == str(selected.resolve())
        return counts

    small, production = measure_scale_pair(
        interaction_id="py:routes/api_wave_a_asgi_routes.py#tag_editor_folder_files",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 1, "stat_calls": 11, "media_parses": 3},
        growth=("stat_calls", 0),
    )
    assert (small.filesystem_enumerations, small.media_parses) == (production.filesystem_enumerations, production.media_parses)


def test_folder_files_stop_enumerating_at_the_audio_file_cap_before_parsing_media(tmp_path, monkeypatch):
    from music_app.services import metadata
    from tests.py.bounded_interactions import OperationCounts
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    root = tmp_path / "music"
    folder = root / "Huge"
    folder.mkdir(parents=True)
    for index in range(tag_editor_folder._MAX_FOLDER_FILES + 100):
        (folder / f"{index:04d}.mp3").write_bytes(b"track")
    source = folder / "0000.mp3"
    counts = OperationCounts()

    with count_filesystem_and_media(monkeypatch, counts, media_modules=(metadata,)):
        with pytest.raises(ValueError, match="too many audio files"):
            tag_editor_folder.load_tag_editor_folder_files(_config(root), str(source), indexed_paths={str(source)})

    assert counts.media_parses == 0
    assert counts.filesystem_enumerations == 1
    assert counts.stat_calls <= 2 * (tag_editor_folder._MAX_FOLDER_FILES + 1) + 4
