from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image


def test_integrity_repair_never_selects_managed_preview(tmp_path):
    from music_app.services.album_local_cover_integrity import apply_scoped_local_cover

    album_root = tmp_path / "Artist" / "Real Album"
    random_root = tmp_path / "Random songs"
    track_path = album_root / "CD1" / "1.mp3"
    unrelated = random_root / "cover.png"
    managed_preview = (
        track_path.parent
        / ".album-haven"
        / "cover_variants"
        / "aa"
        / "aabb.png"
    )
    track_path.parent.mkdir(parents=True)
    random_root.mkdir()
    managed_preview.parent.mkdir(parents=True)
    Image.new("RGB", (200, 200), "blue").save(unrelated)
    Image.new("RGB", (1600, 1600), "red").save(managed_preview)
    rejected = str(random_root / "copied-song.mp3")
    track = SimpleNamespace(
        path=track_path,
        cover_path=unrelated,
        local_cover_width=200,
        local_cover_height=200,
    )
    album = SimpleNamespace(
        tracks=[track],
        cover_path=unrelated,
        local_cover_width=200,
        local_cover_height=200,
        cover_selection_origin="automatic",
        cover_selection_provenance=None,
        remote_cover_url=None,
        cover_revision="old-revision",
    )
    cache = {
        str(track_path): {"cover_path": str(unrelated)},
        rejected: {"cover_path": str(unrelated)},
    }

    apply_scoped_local_cover(album, cache, {rejected})

    assert album.cover_path is None
    assert track.cover_path is None


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


@pytest.mark.parametrize("origin", ["automatic", "user"])
@pytest.mark.parametrize("selected", ["local", "unknown", "missing"])
def test_uncontaminated_album_rebuild_does_not_inspect_cover_files(tmp_path, monkeypatch, origin, selected):
    from music_app.services import album_local_cover_integrity as integrity

    root = tmp_path / "Artist" / "Album"
    track_path = root / "track.flac"
    cover = {"local": root / "cover.jpg", "unknown": tmp_path / "legacy.jpg", "missing": None}[selected]
    album = SimpleNamespace(tracks=[SimpleNamespace(path=track_path)], cover_path=cover,
        cover_selection_origin=origin, cover_selection_provenance=None, remote_cover_url=None)
    unrelated = str(tmp_path / "Rejected" / "track.flac")
    cache = {str(track_path): {"cover_path": str(cover or "")},
        unrelated: {"cover_path": str(tmp_path / "Rejected" / "cover.jpg")}}

    def unexpected_io(*args, **kwargs):
        pytest.fail("Uncontaminated inventory rebuild must not inspect cover files")

    monkeypatch.setattr(Path, "iterdir", unexpected_io)
    monkeypatch.setattr(integrity, "image_dimensions", unexpected_io)
    integrity.apply_scoped_local_cover(album, cache, {unrelated})
    assert album.cover_path == cover
    assert not hasattr(album, "cover_selection_repair_previous")


@pytest.mark.parametrize("origin", [None, "automatic"])
def test_ambiguous_loose_folder_drops_non_user_local_cover(tmp_path, origin):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    folder = tmp_path / "Loose tracks"
    cover = folder / "AlbumArt_{GUID}_Large.jpg"
    first = folder / "first.mp3"
    second = folder / "second.mp3"
    cache = {
        str(first): {
            "path": str(first), "album": "First Album", "album_artist": "First Artist",
            "cover_path": str(cover), "cover_revision": "wrong", "cover_selection_origin": origin,
            "local_cover_width": 200, "local_cover_height": 200,
        },
        str(second): {
            "path": str(second), "album": "Second Album", "album_artist": "Second Artist",
            "cover_path": str(cover), "cover_revision": "wrong", "cover_selection_origin": origin,
            "local_cover_width": 200, "local_cover_height": 200,
        },
    }

    changed = clear_ambiguous_folder_covers(cache)

    assert set(changed) == set(cache)
    assert all(entry["cover_path"] is None for entry in cache.values())
    assert all(entry["cover_selection_origin"] is None for entry in cache.values())


@pytest.mark.parametrize("authority", [("user", None), (None, "explicit")])
def test_ambiguous_loose_folder_preserves_user_local_cover(tmp_path, authority):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    folder = tmp_path / "Loose tracks"
    cover = folder / "cover.jpg"
    first = folder / "first.mp3"
    second = folder / "second.mp3"
    origin, provenance = authority
    cache = {
        str(first): {
            "path": str(first), "album": "First Album", "album_artist": "First Artist",
            "cover_path": str(cover), "cover_selection_origin": origin,
            "cover_selection_provenance": provenance,
        },
        str(second): {
            "path": str(second), "album": "Second Album", "album_artist": "Second Artist",
            "cover_path": str(cover), "cover_selection_origin": origin,
            "cover_selection_provenance": provenance,
        },
    }

    assert clear_ambiguous_folder_covers(cache) == {}
    assert all(entry["cover_path"] == str(cover) for entry in cache.values())


def test_ambiguous_loose_folder_preserves_structurally_inherited_cover(tmp_path):
    from music_app.services.album_local_cover_integrity import (
        clear_ambiguous_folder_covers,
    )

    folder = tmp_path / "Split album"
    cover = folder / "cover.jpg"
    first = folder / "first.mp3"
    second = folder / "second.mp3"
    cache = {
        str(first): {
            "path": str(first),
            "album": "Original Album",
            "cover_path": str(cover),
            "cover_inherited_from_structural_edit": True,
        },
        str(second): {
            "path": str(second),
            "album": "Split Album",
            "cover_path": str(cover),
            "cover_inherited_from_structural_edit": True,
        },
    }

    assert clear_ambiguous_folder_covers(cache) == {}
    assert all(entry["cover_path"] == str(cover) for entry in cache.values())


def test_same_album_folder_keeps_art_across_track_artist_and_year_variation(tmp_path):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    folder = tmp_path / "Compilation"
    cover = folder / "front.jpg"
    cache = {
        str(folder / "first.mp3"): {
            "album": "Shared Album", "album_artist": "Various Artists", "year": 2000,
            "cover_path": str(cover),
        },
        str(folder / "second.mp3"): {
            "album": "Shared Album", "album_artist": "Guest Artist", "year": None,
            "cover_path": str(cover),
        },
    }

    assert clear_ambiguous_folder_covers(cache) == {}


def test_shared_inferred_cover_is_cleared_only_from_foreign_release(tmp_path):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    owner_track = tmp_path / "Owner" / "Album" / "song.mp3"
    foreign_track = tmp_path / "Other" / "Album" / "song.mp3"
    shared_cover = owner_track.parent / "cover.jpg"
    cache = {
        str(owner_track): {
            "path": str(owner_track),
            "album": "Album",
            "cover_path": str(shared_cover),
            "cover_revision": "shared",
        },
        str(foreign_track): {
            "path": str(foreign_track),
            "album": "Other Album",
            "cover_path": str(shared_cover),
            "cover_revision": "shared",
            "cover_selection_origin": "automatic",
            "local_cover_width": 800,
            "local_cover_height": 800,
        }
    }

    changed = clear_ambiguous_folder_covers(cache)

    assert str(owner_track) not in changed
    assert changed[str(foreign_track)]["cover_path"] is None
    assert cache[str(owner_track)]["cover_path"] == str(shared_cover)


def test_shared_legacy_cover_without_provenance_is_not_inferred_as_automatic(tmp_path):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    owner_track = tmp_path / "Owner" / "Album" / "song.mp3"
    foreign_track = tmp_path / "Other" / "Album" / "song.mp3"
    shared_cover = owner_track.parent / "cover.jpg"
    cache = {
        str(owner_track): {
            "path": str(owner_track),
            "album": "Album",
            "cover_path": str(shared_cover),
        },
        str(foreign_track): {
            "path": str(foreign_track),
            "album": "Other Album",
            "cover_path": str(shared_cover),
        },
    }

    assert clear_ambiguous_folder_covers(cache) == {}
    assert cache[str(foreign_track)]["cover_path"] == str(shared_cover)


def test_single_legacy_foreign_cover_without_provenance_is_preserved(tmp_path):
    from music_app.services.album_local_cover_integrity import clear_ambiguous_folder_covers

    track = tmp_path / "Artist" / "Album" / "song.mp3"
    legacy_cover = tmp_path / "Legacy choices" / "cover.jpg"
    cache = {str(track): {"path": str(track), "album": "Album", "cover_path": str(legacy_cover)}}

    assert clear_ambiguous_folder_covers(cache) == {}
    assert cache[str(track)]["cover_path"] == str(legacy_cover)
