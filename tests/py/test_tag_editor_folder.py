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


@pytest.mark.parametrize('indexed_count', [1, 2])
def test_load_folder_files_disc_one_adds_sibling_disc_using_real_root_resolution(tmp_path, monkeypatch, indexed_count):
    from music_app.services import cover_workflow

    root = tmp_path / 'music'
    release = root / 'Artist' / 'Deluxe Release'
    first_disc = release / 'CD 1 - Main Album'
    second_disc = release / 'CD 2 - Bonus Album'
    first_disc.mkdir(parents=True)
    second_disc.mkdir()
    earlier = first_disc / '2.mp3'
    source = first_disc / '10.mp3'
    bonus = second_disc / '01.flac'
    unrelated = root / 'Artist' / 'Another Release' / '01.mp3'
    unrelated.parent.mkdir()
    nested_unrelated = release / 'Other Album' / '01.mp3'
    nested_unrelated.parent.mkdir()
    for path in (earlier, source, bonus, unrelated, nested_unrelated):
        path.write_bytes(b'audio fixture')
    monkeypatch.setattr(cover_workflow, 'get_library_roots', lambda _config: [
        {'path': str(root), 'layout_mode': 'artist', 'category': 'main_library_roots'},
    ])
    reads = []

    def read_tags(path, _fields):
        reads.append(path)
        is_bonus = path.parent == second_disc
        return {'title': path.stem, 'album': 'Bonus Album' if is_bonus else 'Main Album',
                'artist': 'Guest Artist' if is_bonus else 'Main Artist',
                'disc_number': '2' if is_bonus else '1', 'total_discs': '2'}

    monkeypatch.setattr(tag_editor_folder, 'read_editable_tag_values', read_tags)
    indexed = {str(source)} | ({str(earlier)} if indexed_count == 2 else set())
    payload = tag_editor_folder.load_tag_editor_folder_files(_config(root), str(source), indexed_paths=indexed)
    assert payload['folder_path'] == str(release.resolve())
    assert [Path(row['path']).relative_to(release).as_posix() for row in payload['tracks']] == [
        'CD 1 - Main Album/2.mp3', 'CD 1 - Main Album/10.mp3', 'CD 2 - Bonus Album/01.flac',
    ]
    assert [row['disc_number'] for row in payload['tracks']] == ['1', '1', '2']
    assert payload['tracks'][-1]['album'] == 'Bonus Album'
    assert payload['tracks'][-1]['artist'] == 'Guest Artist'
    assert set(reads) == {earlier, source, bonus}
    assert unrelated not in reads
    assert nested_unrelated not in reads
    assert all(path.read_bytes() == b'audio fixture' for path in (earlier, source, bonus, unrelated, nested_unrelated))


def test_disc_expansion_never_promotes_to_configured_library_root(tmp_path, monkeypatch):
    root = tmp_path / 'music'
    first = root / 'CD1' / '01.mp3'
    second = root / 'CD2' / '02.mp3'
    for path in (first, second):
        path.parent.mkdir(parents=True)
        path.write_bytes(b'audio fixture')
    reads = []
    monkeypatch.setattr(tag_editor_folder, 'read_editable_tag_values',
                        lambda path, _fields: reads.append(path) or {'title': path.stem})
    payload = tag_editor_folder.load_tag_editor_folder_files(_config(root), str(first), indexed_paths={str(first)})
    assert payload['folder_path'] == str(first.parent.resolve())
    assert [row['path'] for row in payload['tracks']] == [str(first.resolve())]
    assert reads == [first.resolve()]


def test_disc_marker_in_album_name_does_not_combine_unrelated_releases(tmp_path, monkeypatch):
    root = tmp_path / 'music'
    first = root / 'Artist' / 'First Album CD1' / '01.mp3'
    second = root / 'Artist' / 'Unrelated Album CD2' / '02.mp3'
    for path in (first, second):
        path.parent.mkdir(parents=True)
        path.write_bytes(b'audio fixture')
    reads = []
    monkeypatch.setattr(tag_editor_folder, 'read_editable_tag_values',
                        lambda path, _fields: reads.append(path) or {'title': path.stem})
    payload = tag_editor_folder.load_tag_editor_folder_files(_config(root), str(first), indexed_paths={str(first)})
    assert payload['folder_path'] == str(first.parent.resolve())
    assert [row['path'] for row in payload['tracks']] == [str(first.resolve())]
    assert reads == [first.resolve()]


def test_disc_aliases_do_not_escape_release_or_duplicate_physical_files(tmp_path, monkeypatch):
    root = tmp_path / 'music'
    release = root / 'Artist' / 'Album'
    first = release / 'CD1' / '01.mp3'
    second = release / 'CD2' / '02.mp3'
    outside = tmp_path / 'outside' / '03.mp3'
    for path in (first, second, outside):
        path.parent.mkdir(parents=True)
        path.write_bytes(b'audio fixture')
    try:
        (release / 'CD3').symlink_to(second.parent, target_is_directory=True)
        (release / 'CD4').symlink_to(outside.parent, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f'Directory symlink capability unavailable: {exc}')
    reads = []
    monkeypatch.setattr(tag_editor_folder, 'read_editable_tag_values',
                        lambda path, _fields: reads.append(path) or {'title': path.stem})
    payload = tag_editor_folder.load_tag_editor_folder_files(_config(root), str(first), indexed_paths={str(first)})
    assert payload['folder_path'] == str(release.resolve())
    assert [row['path'] for row in payload['tracks']] == [str(first.resolve()), str(second.resolve())]
    assert reads == [first.resolve(), second.resolve()]
    assert outside.resolve() not in reads


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

