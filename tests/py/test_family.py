from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from music_app.services.family import build_family_index


def _album(track_path: Path, album_artist: str, artists: list[str]):
    track = SimpleNamespace(path=str(track_path))
    return SimpleNamespace(album_artist=album_artist, artists=artists, tracks=[track])


def test_build_family_index_uses_cached_album_paths_without_child_directory_rewalk(tmp_path: Path, monkeypatch):
    music_dir = tmp_path / "Music"
    first_track = music_dir / "Collective" / "Shared Era" / "Artist One" / "Album One" / "song-1.mp3"
    second_track = music_dir / "Collective" / "Shared Era" / "Artist Two" / "Album Two" / "song-2.mp3"
    first_track.parent.mkdir(parents=True)
    second_track.parent.mkdir(parents=True)
    first_track.write_bytes(b"a")
    second_track.write_bytes(b"b")

    def fail_iterdir(self):
        raise AssertionError("build_family_index should not re-read child directories from disk")

    monkeypatch.setattr(Path, "iterdir", fail_iterdir)

    family_to_artists, folder_related, artist_names = build_family_index(
        music_dir,
        [
            _album(first_track, "Artist One", ["Artist One"]),
            _album(second_track, "Artist Two", ["Artist Two"]),
        ],
    )

    assert artist_names == ["Artist One", "Artist Two"]
    assert family_to_artists == {"Collective\\Shared Era": {"Artist One", "Artist Two"}}
    assert folder_related["Artist One"] == {"Artist Two"}
    assert folder_related["Artist Two"] == {"Artist One"}
