from music_app.services.library_reachability import missing_reason_for_path


def test_a_missing_file_under_a_readable_root_was_deleted(tmp_path):
    root = tmp_path / "Music"
    (root / "Artist").mkdir(parents=True)
    # The album folder is gone but its artist folder and the root can be read.
    assert missing_reason_for_path(root, root / "Artist" / "Album" / "01.flac") == "deleted"
    # Nothing above the file survives except the root.
    assert missing_reason_for_path(root, root / "Gone" / "Album" / "01.flac") == "deleted"


def test_a_missing_file_whose_root_cannot_be_read_is_unreachable(tmp_path):
    assert missing_reason_for_path(tmp_path / "Unplugged", tmp_path / "Unplugged" / "Album" / "01.flac") == "unreachable"
    assert missing_reason_for_path(None, tmp_path / "Album" / "01.flac") == "unreachable"
