"""Log History never shows a filesystem path, even one with spaces embedded bare in an error."""
from __future__ import annotations

import pytest

from music_app.services.log_history import _sanitize_text

PATH_PARTS = ("media root", "Synthetic Artist", "Two Song Album", "01 - First Song Here.mp3")
POSIX_PATH = "/srv/" + "/".join(PATH_PARTS)
WINDOWS_PATH = "D:\\" + "\\".join(PATH_PARTS)
UNC_PATH = "\\\\server\\" + "\\".join(PATH_PARTS)


def media_write_error(path: str) -> str:
    # The shape edit_workflows records for a failed media write, with its compensation suffix.
    failure = OSError(21, "Is a directory", path)
    return f"Failed to repair {path}: {failure}; media compensation also failed: {path}: {failure}"


@pytest.mark.parametrize("path", [POSIX_PATH, WINDOWS_PATH, UNC_PATH], ids=["posix", "windows", "unc"])
def test_media_write_error_keeps_no_fragment_of_a_path_with_spaces(path):
    redacted = _sanitize_text(media_write_error(path))

    for part in PATH_PARTS:
        assert part not in redacted
    assert redacted == (
        "Failed to repair [path]: [Errno 21] Is a directory: [path]; "
        "media compensation also failed: [path]: [Errno 21] Is a directory: [path]"
    )


@pytest.mark.parametrize("path", [POSIX_PATH, WINDOWS_PATH], ids=["posix", "windows"])
def test_a_bare_path_with_spaces_at_the_end_of_an_error_is_redacted(path):
    redacted = _sanitize_text(f"Track path no longer matches the planned source folder: {path}")

    assert redacted == "Track path no longer matches the planned source folder: [path]"


@pytest.mark.parametrize("text", [
    "Retried 3 / 5 times, and/or skipped: see the album card.",
    "Spotify answered 429; retry in 30 s.",
    "Album Synthetic Artist - Two Song Album was not found.",
])
def test_text_without_a_path_is_kept(text):
    assert _sanitize_text(text) == text
