"""Owner (2026-11-24): an album is complete by a full MusicBrainz match; failing that, by its track numbers
running 1..N with no gap, matching the track total where a tag carries one."""
import pytest


def _tracks(*numbers, disc=1, total=None):
    return [{"track_number": number, "disc_number": disc, "total_tracks": total} for number in numbers]


@pytest.mark.parametrize("tracks, complete", [
    (_tracks(1, 2, 3), True),
    (_tracks(1, 3), False),
    (_tracks(2, 3), False),
    (_tracks(1, 2, 3, total=3), True),
    (_tracks(1, 2, 3, total=12), False),
    (_tracks(1, 2, 3) + _tracks(1, 2, disc=2), True),
    (_tracks(1, 2, 3) + _tracks(2, disc=2), False),
    (_tracks(1, 2) + [{"track_number": None, "disc_number": 1, "total_tracks": None}], False),
    ([], False),
])
def test_track_numbers_decide_completeness_without_a_release_match(tracks, complete):
    from music_app.services.album_completeness import album_is_complete

    assert album_is_complete(tracks) is complete


def test_a_full_release_match_decides_before_the_track_numbers(monkeypatch):
    from music_app.services import album_completeness

    monkeypatch.setattr(album_completeness, "full_release_match", lambda tracks: True)
    assert album_completeness.album_is_complete(_tracks(2, 3)) is True
    monkeypatch.setattr(album_completeness, "full_release_match", lambda tracks: False)
    assert album_completeness.album_is_complete(_tracks(1, 2, 3)) is False
