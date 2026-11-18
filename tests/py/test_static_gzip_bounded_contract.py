"""The static gzip warm-up compresses the app's own assets once per process."""

from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_STATIC_FILES = 6


def test_static_gzip_warmup_contract_compresses_once_per_process_however_often_it_is_requested(tmp_path, monkeypatch):
    from music_app.services import compressed_static_files

    def run_inline(*, target, args, **_kwargs):
        # The warm-up thread's work, run on the test thread so it is counted.
        class _Inline:
            def start(self):
                target(*args)
        return _Inline()

    monkeypatch.setattr(compressed_static_files.threading, "Thread", run_inline)

    def run(requests: int) -> OperationCounts:
        root = tmp_path / f"static-{requests}"
        root.mkdir()
        for index in range(_STATIC_FILES):
            (root / f"asset-{index}.js").write_text("console.log('asset');\n" * 200, encoding="utf-8")
        cache = compressed_static_files._GzipCache()
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            for _request in range(requests):
                cache.warm_in_background(root)
        assert len(cache._bodies) == _STATIC_FILES
        return counts

    measure_scale_pair(
        interaction_id="py:services/compressed_static_files.py#_GzipCache.warm",
        small=1,
        large=100,
        run=run,
        budgets={"filesystem_enumerations": 1, "stat_calls": 24, "open_calls": 6},
        growth=("stat_calls", 0),
    )
