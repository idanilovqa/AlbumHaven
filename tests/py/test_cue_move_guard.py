from pathlib import Path

import pytest

from music_app.services.cue_move_guard import CueMoveDependencyError, validate_cue_bundle_move


class Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class Connection:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql):
        assert "cue_move_dependencies" in sql
        return Cursor(self.rows)


def test_cue_bundle_move_accepts_program_and_media_wholly_inside_album(tmp_path):
    album = tmp_path / "Artist" / "Album"
    album.mkdir(parents=True)
    rows = [{
        "root_path": str(tmp_path),
        "source_identity": "Artist/Album/album.cue",
        "private_path": str(album / "image.flac"),
        "referencing_sources": ["Artist/Album/album.cue"],
    }]

    dependencies = validate_cue_bundle_move(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        album,
        connect=lambda _url: Connection(rows),
    )

    assert dependencies == {album / "album.cue", album / "image.flac"}


@pytest.mark.parametrize("outside_key", ["private_path", "referencing_sources"])
def test_cue_bundle_move_blocks_external_or_shared_sources(tmp_path, outside_key):
    album = tmp_path / "Artist" / "Album"
    album.mkdir(parents=True)
    row = {
        "root_path": str(tmp_path),
        "source_identity": "Artist/Album/album.cue",
        "private_path": str(album / "image.flac"),
        "referencing_sources": ["Artist/Album/album.cue"],
    }
    if outside_key == "private_path":
        row[outside_key] = str(tmp_path / "Shared" / "image.flac")
    else:
        row[outside_key] = ["Artist/Album/album.cue", "Other/other.cue"]

    with pytest.raises(CueMoveDependencyError, match="shared|outside"):
        validate_cue_bundle_move(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
            album,
            connect=lambda _url: Connection([row]),
        )
