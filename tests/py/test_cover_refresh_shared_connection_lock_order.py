from __future__ import annotations

import threading
import logging
from unittest.mock import Mock

from music_app.services import cover_refresh_execution, scan_cache_persistence
from music_app.services.cover_refresh_runtime import _DurableCoverRefreshState


def test_parallel_cover_completion_publishes_progress_outside_cache_lock(tmp_path, monkeypatch):
    cache_lock = threading.Lock()
    progress_entered = threading.Event()
    commit_entered = threading.Event()
    blocked_commits, worker_threads = [], []
    database_url = "postgresql://unit/cover-lock-order"

    class Connection:
        closed = False

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            self.closed = True

    connection = Connection()
    monkeypatch.setattr(scan_cache_persistence, "_connect", lambda _url: connection)
    monkeypatch.setattr(cover_refresh_execution, "_unreachable_album_roots", lambda *_args: set())

    def progress(*, safe_label, **_values):
        if safe_label == "A" and not progress_entered.is_set():
            progress_entered.set()
            assert commit_entered.wait(3), "the other cover worker must reach its commit"
        with scan_cache_persistence.scan_cache_transaction(database_url):
            pass
        return True

    library_state = _DurableCoverRefreshState(
        {"file_cache": {}, "albums": [], "cover_generation": 1, "scan_generation": 0,
         "covers_processed": 0, "covers_total": 2, "covers_downloaded": 0},
        progress=progress, should_cancel=lambda: False,
    )

    def execute_cover_job(*, job, **_options):
        worker_threads.append(threading.current_thread())
        if job["album"] == "B":
            assert progress_entered.wait(3), "completion must overlap the second commit"
            with scan_cache_persistence.scan_cache_transaction(database_url):
                commit_entered.set()
                # The production commit guard takes this same cache lock. The
                # timeout only lets a broken ordering unwind and join cleanly.
                if not cache_lock.acquire(timeout=2):
                    blocked_commits.append("shared SQL lock -> cache lock")
                    raise RuntimeError("cover commit and progress have inverted lock order")
                cache_lock.release()
        return None, False, {"reason": "remote_search_returned_no_candidate"}

    monkeypatch.setattr(cover_refresh_execution, "execute_cover_job", execute_cover_job)
    logger = logging.getLogger("test.cover.shared-connection-lock-order")
    monkeypatch.setattr(logger, "verbose", logger.debug, raising=False)
    jobs = []
    for album in ("A", "B"):
        folder = tmp_path / album
        folder.mkdir()
        jobs.append({"folder": folder, "artist": "Artist", "album": album, "track_paths": []})

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config={"ALBUM_HAVEN_APP_DATABASE_URL": database_url, "MUSIC_DIR": str(tmp_path)},
        logger=logger, cache_lock=cache_lock, jobs=jobs, file_cache={},
        separate_release_keys=set(), image_extensions={".jpg"}, user_agent="test",
        cover_cache=Mock(), scan_generation=0, cover_generation=1, job_workers=2,
    )
    assert progress_entered.is_set() and commit_entered.is_set()
    assert not blocked_commits, "progress must release the cache lock before borrowing shared SQL"
    assert result["processed"] == 2
    assert all(not worker.is_alive() for worker in worker_threads)
    assert connection.closed
