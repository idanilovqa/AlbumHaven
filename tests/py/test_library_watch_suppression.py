from pathlib import Path

from music_app.services.library_watch_suppression import LibraryWatchSuppression


def test_suppression_covers_active_write_and_bounded_delivery_grace(tmp_path: Path):
    now = [0.0]
    suppression = LibraryWatchSuppression(grace_seconds=5.0, clock=lambda: now[0])
    cover = tmp_path / "cover.jpg"

    assert suppression.contains(cover) is False
    with suppression.suppress((cover,)):
        assert suppression.contains(cover) is True
    assert suppression.contains(cover) is True

    now[0] = 5.01
    assert suppression.contains(cover) is False


def test_nested_suppression_remains_active_until_outer_write_finishes(tmp_path: Path):
    suppression = LibraryWatchSuppression(grace_seconds=0.0, clock=lambda: 1.0)
    cover = tmp_path / "cover.jpg"

    with suppression.suppress((cover,)):
        with suppression.suppress((cover,)):
            assert suppression.contains(cover) is True
        assert suppression.contains(cover) is True
