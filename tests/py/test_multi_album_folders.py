"""Owner (2026-11-24): the multi-album rule is strict. A folder holds several albums only when its files carry two or
more album tags, each of those albums is complete, and nothing else is in the folder. Copies proven to belong
to another album folder don't count against it. Decided from the files' tags alone, never from names."""
from pathlib import PureWindowsPath

DUPLICATE = "Duplicate track outside album folder"


def _album(folder, album, numbers, *, artist="Artist", disc=1, total=None, **extra):
    return [
        {"path": str(PureWindowsPath(folder) / f"{album[:3]}-{disc}-{number:02d}.flac"), "album": album,
         "album_artist": artist, "artist": artist, "track_number": number, "disc_number": disc,
         "total_tracks": total, **extra}
        for number in numbers
    ]


def _strict(entries):
    from music_app.services.multi_album_folders import strict_multi_album_folders

    return strict_multi_album_folders(entries)


def _folder(path):
    from music_app.services.album_local_membership import physical_album_folder

    return physical_album_folder(path)


def test_two_complete_albums_alone_in_one_folder_are_a_multi_album_folder():
    entries = _album(r"C:\Music\Shared", "First Album", (1, 2, 3)) + _album(r"C:\Music\Shared", "Second Album", (1, 2), total=2)
    assert _strict(entries) == {_folder(r"C:\Music\Shared\x.flac")}


def test_a_copy_folder_is_not_one():
    entries = (_album(r"C:\Music\First Album", "First Album", (1, 2, 3))
               + _album(r"C:\Music\Second Album", "Second Album", (1, 2, 3))
               + _album(r"C:\Music\Copies", "First Album", (1, 2), local_album_membership_problem=DUPLICATE)
               + _album(r"C:\Music\Copies", "Second Album", (3,), local_album_membership_problem=DUPLICATE))
    assert _strict(entries) == set()


def test_partial_albums_in_one_folder_are_not_one():
    entries = _album(r"C:\Music\Mixed", "First Album", (5,)) + _album(r"C:\Music\Mixed", "Second Album", (6, 7))
    assert _strict(entries) == set()


def test_a_tagged_total_that_is_not_reached_makes_an_album_partial():
    entries = _album(r"C:\Music\Mixed", "First Album", (1, 2), total=12) + _album(r"C:\Music\Mixed", "Second Album", (1, 2))
    assert _strict(entries) == set()


def test_a_loose_song_beside_complete_albums_disqualifies_the_folder():
    entries = (_album(r"C:\Music\Shared", "First Album", (1, 2)) + _album(r"C:\Music\Shared", "Second Album", (1, 2))
               + [{"path": r"C:\Music\Shared\loose.flac", "album": "", "album_artist": "Artist", "artist": "Artist",
                   "track_number": None, "disc_number": None}])
    assert _strict(entries) == set()


def test_one_album_on_two_discs_in_one_folder_is_not_one():
    entries = _album(r"C:\Music\Double", "Double Album", (1, 2, 3)) + _album(r"C:\Music\Double", "Double Album", (1, 2), disc=2)
    assert _strict(entries) == set()


def test_disc_subfolders_of_one_album_are_not_one():
    entries = (_album(r"C:\Music\Soundtrack\CD1", "Soundtrack", (1, 2, 7)) + _album(r"C:\Music\Soundtrack\CD1", "Soundtrack", (3,), artist="Unknown Artist")
               + _album(r"C:\Music\Soundtrack\CD2", "Soundtrack", (1, 5), disc=2) + _album(r"C:\Music\Soundtrack\CD2", "Soundtrack", (2,), disc=2, artist="Unknown Artist"))
    assert _strict(entries) == set()


def test_one_album_spanning_two_sibling_folders_disqualifies_both():
    entries = (_album(r"C:\Music\Covers", "Complete Album", (1, 2)) + _album(r"C:\Music\Covers", "Spanning Album", (19, 20))
               + _album(r"C:\Music\Various", "Other Complete", (1,), total=1) + _album(r"C:\Music\Various", "Spanning Album", (1, 2, 3)))
    assert _strict(entries) == set()
