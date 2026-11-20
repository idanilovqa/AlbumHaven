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


def test_suppression_contract_resolves_only_the_written_paths_however_many_are_suppressed(
    tmp_path: Path,
    monkeypatch,
):
    from music_app.services import library_watch_suppression as module
    from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    written = (tmp_path / "Album" / "cover.jpg", tmp_path / "Album" / ".cover.jpg.tmp")

    def run(suppressed_paths: int) -> OperationCounts:
        suppression = LibraryWatchSuppression(grace_seconds=5.0, clock=lambda: 1.0)
        # Other writes in flight or in their grace period; their keys are opaque.
        suppression._entries.update({f"other-{index}": (1, 1.0) for index in range(suppressed_paths)})
        monkeypatch.setattr(module, "library_watch_suppression", suppression)
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            with module.suppress_library_watch_events(written):
                pass
        assert all(suppression.contains(path) for path in written)
        assert len(suppression._entries) == suppressed_paths + len(written)
        return counts

    small, production = measure_scale_pair(
        interaction_id="py:services/library_watch_suppression.py#suppress_library_watch_events",
        small=20,
        large=160_000,
        run=run,
        budgets={"path_resolves": 2, "stat_calls": 0, "filesystem_enumerations": 0, "open_calls": 0},
        growth=("path_resolves", 0),
    )

    assert small.path_resolves == production.path_resolves == len(written)
