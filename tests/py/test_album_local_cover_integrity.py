from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image


@pytest.mark.parametrize("explicit", [False, True])
def test_contaminated_inherited_cover_is_repaired_but_explicit_user_choice_is_preserved(tmp_path, explicit):
    from music_app.services.album_local_cover_integrity import apply_scoped_local_cover

    album_root = tmp_path / "Artist" / "Real Album"
    random_root = tmp_path / "Random songs"
    (album_root / "CD1").mkdir(parents=True)
    random_root.mkdir()
    good = album_root / "cover.png"
    unrelated = random_root / "cover.png"
    Image.new("RGB", (1600, 1600), "red").save(good)
    Image.new("RGB", (200, 200), "blue").save(unrelated)
    legitimate = str(album_root / "CD1" / "1.mp3")
    rejected = str(random_root / "copied-song.mp3")
    tracks = [SimpleNamespace(path=Path(legitimate), cover_path=unrelated,
        local_cover_width=200, local_cover_height=200)]
    album = SimpleNamespace(tracks=tracks, cover_path=unrelated, local_cover_width=200,
        local_cover_height=200, cover_selection_origin="user", cover_revision="old-revision",
        cover_selection_provenance="explicit" if explicit else None, remote_cover_url=None)
    cache = {legitimate: {"album": "Real Album", "album_artist": "Artist", "cover_path": str(unrelated)},
        rejected: {"album": "Real Album", "album_artist": "Artist", "cover_path": str(unrelated)}}
    apply_scoped_local_cover(album, cache, {rejected})
    if explicit:
        assert Path(album.cover_path) == unrelated
        assert not hasattr(album, "cover_selection_repair_previous")
    else:
        assert Path(album.cover_path) == good
        assert album.local_cover_width == 1600
        assert album.local_cover_height == 1600
        assert all(Path(track.cover_path) == good for track in album.tracks)
        assert album.cover_selection_repair_previous["cover_path"] == str(unrelated)
