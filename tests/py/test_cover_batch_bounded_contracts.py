"""Bounded-interaction contracts for the whole-library cover refresh batches.

"Fetch covers for unsuccessful albums" and the background cover refresh are
deliberate whole-library batches. Their contracts prove what the code does:
the request only reserves the batch, rapid triggers coalesce into one running
batch, a cancelled reservation queues nothing, and a repeat run over an
unchanged library does no new provider work. The provider search (network) is
the only stand-in; the cover planning, execution, and negative cache are real.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.py.asgi_testing import create_test_asgi_app, decode_json, run_asgi_request
from tests.py.bounded_interactions import OperationCounts, assert_plateau, measure_scale_pair


def _registered(interaction_id: str) -> dict[str, object]:
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[interaction_id]
    growth = entry["growth"]
    return {
        "interaction_id": interaction_id,
        "small": entry["cardinalities"]["small"],
        "large": entry["cardinalities"]["production"],
        "budgets": entry["budgets"],
        "growth": (growth["metric"], growth["largeMinusSmallMax"]),
    }


class _CountingFileCache(dict):
    """A published file cache that counts every entry a reader walks."""

    counts = OperationCounts()

    def _walk(self, values):
        for value in values:
            self.counts.candidate_rows += 1
            yield value

    def __iter__(self):
        return self._walk(super().__iter__())

    def keys(self):
        return self._walk(super().keys())

    def values(self):
        return self._walk(super().values())

    def items(self):
        return self._walk(super().items())


class _CapturingExecutor:
    """Holds submitted cover work until the contract runs it."""

    def __init__(self):
        self.submitted: list = []

    def submit(self, function, *args):
        self.submitted.append((function, args))

    def run_all(self) -> int:
        ran = 0
        while self.submitted:
            function, args = self.submitted.pop(0)
            function(*args)
            ran += 1
        return ran


def _cover_library(root: Path, *, covered: int, missing: int) -> dict[str, dict[str, object]]:
    """`covered` album folders with a large local cover and `missing` without one."""
    from PIL import Image

    file_cache = {}
    for index in range(covered + missing):
        folder = root / f"Artist {index:05d}" / "Album"
        folder.mkdir(parents=True)
        entry = {"title": "One", "album": f"Album {index}", "album_artist": f"Artist {index:05d}", "artist": f"Artist {index:05d}"}
        if index < covered:
            cover = folder / "cover.jpg"
            Image.new("RGB", (1600, 1600), "red").save(cover)
            entry["cover_path"] = str(cover)
        path = str(folder / "01.mp3")
        file_cache[path] = {"path": path, **entry}
    return file_cache


@pytest.fixture
def cover_state(tmp_path, monkeypatch):
    from music_app.services import cover_refresh_provider
    from music_app.services import state as state_service

    app = create_test_asgi_app(tmp_path, monkeypatch)
    executor = _CapturingExecutor()
    monkeypatch.setattr(state_service, "_COVER_EXECUTOR", executor)
    searches: list[tuple[str, str]] = []

    def search_remote_cover(*, artist, album, **_kwargs):
        # The provider (network) finds nothing; the real negative cache records it.
        searches.append((artist, album))
        return None, [{"status": "no_candidate"}]

    monkeypatch.setattr(cover_refresh_provider, "search_primary_remote_cover", search_remote_cover)
    return app, executor, searches


def _count_job_planning(monkeypatch) -> list[int]:
    """Counts whole-library cover job planning passes."""
    from music_app.services import cover_refresh_planning

    plan = cover_refresh_planning.build_cover_refresh_jobs
    passes = [0]

    def counted_plan(*args, **kwargs):
        passes[0] += 1
        return plan(*args, **kwargs)

    monkeypatch.setattr(cover_refresh_planning, "build_cover_refresh_jobs", counted_plan)
    return passes


_MISSING_COVER_ALBUMS = 2


def _run_converging_waves(trigger_wave, library_state, executor, searches) -> None:
    """Three waves of rapid triggers over an unchanged library: each wave runs
    one batch, and repeat batches search the provider for nothing new because
    the misses stay in the negative cache."""
    searches_after_wave = []
    for _wave in range(3):
        trigger_wave()
        assert len(executor.submitted) == 1
        executor.run_all()
        assert library_state["covers_in_progress"] is False
        searches_after_wave.append(len(searches))
    assert searches_after_wave[0] == _MISSING_COVER_ALBUMS
    assert_plateau(searches_after_wave, warmup_samples=1, label="cover provider searches")


@pytest.mark.parametrize("interaction_id", [
    "py:services/cover_refresh_runtime.py#start_manual_cover_refresh_request",
    "py:services/cover_refresh_runtime.py#start_manual_cover_refresh",
])
def test_unsuccessful_cover_batch_contract_coalesces_triggers_and_converges_at_production_trigger_count(
    cover_state, tmp_path, monkeypatch, interaction_id,
):
    from music_app.services import cover_refresh_runtime as runtime
    from music_app.services import state as state_service

    app, executor, searches = cover_state
    config, logger = app.state.config, app.state.logger

    def start(library_state):
        snapshot = lambda: state_service.cover_file_cache_snapshot_for_state(library_state, config)  # noqa: E731
        refresh = lambda force_search=False, prepared=None: (  # noqa: E731
            state_service.refresh_unsuccessful_cover_artwork_for_state(
                library_state, config, logger, force_search=force_search, prepared=prepared,
            )
        )
        common = {
            "config": config, "logger": logger, "cache_lock": state_service._CACHE_LOCK,
            "get_state": lambda: library_state,
            "start_background_refresh": lambda **_kwargs: pytest.fail("a published library needs no indexing"),
            "get_file_cache_snapshot": snapshot, "submit_cover_job": executor.submit, "defer_preparation": True,
        }
        if interaction_id.endswith("#start_manual_cover_refresh_request"):
            return runtime.start_manual_cover_refresh_request(refresh_unsuccessful_cover_artwork=refresh, **common)
        return runtime.start_manual_cover_refresh(
            build_cover_jobs=lambda file_cache, **kwargs: runtime.build_cover_jobs_for_snapshot(
                get_file_cache_snapshot=lambda: file_cache, logger=logger, **kwargs,
            ),
            refresh_manual_cover_artwork_worker=runtime.build_manual_cover_refresh_runner(
                get_state=lambda: library_state, refresh_unsuccessful_cover_artwork=refresh,
                cache_lock=state_service._CACHE_LOCK,
            ),
            **common,
        )

    planning_passes = _count_job_planning(monkeypatch)

    def run(trigger_count: int) -> OperationCounts:
        searches.clear()
        planning_passes[0] = 0
        library_state = app.state.library_state
        # Each cardinality starts with an empty provider cache.
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{trigger_count}.json"
        library_state.update({
            "file_cache": _cover_library(tmp_path / f"library-{trigger_count}", covered=4, missing=_MISSING_COVER_ALBUMS),
            "covers_in_progress": False, "scan_in_progress": False,
        })
        def wave():
            results = [start(library_state) for _ in range(trigger_count)]
            assert results[0]["started"] is True
            assert all(result.get("already_running") for result in results[1:])

        _run_converging_waves(wave, library_state, executor, searches)
        # A cancelled reservation plans and queues nothing.
        planned = planning_passes[0]
        assert start(library_state)["started"] is True
        runtime.cancel_cover_refresh(lambda: library_state, cache_lock=state_service._CACHE_LOCK)
        executor.run_all()
        assert planning_passes[0] == planned
        return OperationCounts(builder_calls=planning_passes[0], queue_claims=len(searches))

    measure_scale_pair(run=run, **_registered(interaction_id))


def test_fetch_unsuccessful_covers_route_contract_only_reserves_the_batch_at_production_track_count(cover_state):
    from functools import partial

    from music_app.services import cover_refresh_runtime as runtime

    app, executor, _searches = cover_state

    def run(track_count: int) -> OperationCounts:
        counts = OperationCounts()
        file_cache = _CountingFileCache({
            f"/music/Artist {index:06d}/Album/01.mp3": {"album": "Album", "album_artist": f"Artist {index:06d}"}
            for index in range(track_count)
        })
        file_cache.counts = counts
        library_state = app.state.library_state
        library_state.update({"file_cache": file_cache, "albums": [object()], "covers_in_progress": False, "scan_in_progress": False})
        executor.submitted.clear()
        status, _headers, body = run_asgi_request(app, "POST", "/utilities/fetch-covers-unsuccessful", json_body={})
        assert status == 200, body
        assert decode_json(body)["started"] is True
        # The request reserved one batch; its whole-library preparation runs on
        # the cover executor, not on the request thread.
        ((job, _args),) = executor.submitted
        assert isinstance(job, partial) and job.func is runtime.start_manual_cover_refresh
        assert job.keywords["_reservation"][0] is library_state
        assert library_state["covers_in_progress"] is True
        counts.builder_calls = len(executor.submitted)
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_fetch_covers_unsuccessful"))


def test_background_cover_refresh_contract_coalesces_triggers_and_converges_at_production_trigger_count(
    cover_state, tmp_path, monkeypatch,
):
    from music_app.services import cover_refresh_planning
    from music_app.services import cover_refresh_runtime as runtime
    from music_app.services import state as state_service
    from music_app.services.app_logging import log_app_event
    from music_app.services.cover_refresh_execution import run_cover_jobs
    from music_app.services.cover_refresh_jobs import log_cover_refresh_completion, select_background_cover_refresh_jobs
    from music_app.services.library import build_albums_from_file_cache

    app, executor, searches = cover_state
    config, logger = app.state.config, app.state.logger
    planning_passes = _count_job_planning(monkeypatch)

    def start(library_state) -> None:
        # The post-scan trigger, wired as state.py wires it.
        runtime.start_background_cover_refresh_request(
            get_state=lambda: library_state,
            cache_lock=state_service._CACHE_LOCK,
            submit_cover_job=executor.submit,
            refresh_cover_artwork=lambda: runtime.refresh_cover_artwork_request(
                get_state=lambda: library_state,
                cache_lock=state_service._CACHE_LOCK,
                config=config,
                logger=logger,
                log_app_event=log_app_event,
                select_background_cover_refresh_jobs=select_background_cover_refresh_jobs,
                # Resolved per call so the planning counter sees each pass.
                build_cover_jobs=lambda file_cache, **kwargs: cover_refresh_planning.build_cover_refresh_jobs(
                    file_cache, **kwargs,
                ),
                run_cover_jobs=run_cover_jobs,
                log_cover_refresh_completion=log_cover_refresh_completion,
                bulk_negative_cache_ttl_seconds=state_service._BULK_NEGATIVE_CACHE_TTL_SECONDS,
                job_workers=1,
            ),
        )

    def run(trigger_count: int) -> OperationCounts:
        searches.clear()
        planning_passes[0] = 0
        library_state = app.state.library_state
        # Each cardinality starts with an empty provider cache.
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{trigger_count}.json"
        file_cache = _cover_library(tmp_path / f"library-{trigger_count}", covered=4, missing=_MISSING_COVER_ALBUMS)
        library_state.update({
            "file_cache": file_cache, "albums": build_albums_from_file_cache(file_cache),
            "covers_in_progress": False, "scan_in_progress": False,
        })
        _run_converging_waves(
            lambda: [start(library_state) for _ in range(trigger_count)], library_state, executor, searches,
        )
        return OperationCounts(builder_calls=planning_passes[0], queue_claims=len(searches))

    measure_scale_pair(
        run=run, **_registered("py:services/cover_refresh_runtime.py#refresh_cover_artwork_request"),
    )


def test_watcher_cover_refresh_drain_contract_reads_only_the_queued_album_at_production_album_count(
    cover_state, tmp_path, monkeypatch,
):
    from music_app.services import state as state_service
    from music_app.services.library import album_to_dict, build_albums_from_file_cache

    app, executor, searches = cover_state
    config, logger = app.state.config, app.state.logger

    class CountingAlbums(list):
        counts = OperationCounts()

        def __iter__(self):
            for album in super().__iter__():
                self.counts.candidate_rows += 1
                yield album

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        counts = OperationCounts()
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{album_count}.json"
        # The watcher added one album without a cover to a library of `album_count` albums.
        added = _cover_library(tmp_path / f"added-{album_count}", covered=0, missing=1)
        library = {
            path: {"path": path, "title": "One", "album": "Album", "album_artist": f"Artist {index:05d}"}
            for index in range(album_count - 1)
            for path in (f"/music/Artist {index:05d}/Album/01.mp3",)
        }
        (added_album,) = build_albums_from_file_cache(added)

        class Repository:
            """The Postgres browse repository answers keyed reads for the queued paths."""

            def __init__(self, _config):
                pass

            def build_album_payloads_by_track_paths(self, track_paths):
                assert set(track_paths) == set(added)
                counts.returned_rows += 1
                return [album_to_dict(added_album)]

            def build_track_file_entries_by_paths(self, track_paths):
                assert set(track_paths) == set(added)
                counts.returned_rows += len(track_paths)
                return {path: dict(added[path]) for path in track_paths}

        monkeypatch.setattr(state_service, "PostgresLibraryBrowseRepository", Repository)
        library_state = app.state.library_state
        file_cache = _CountingFileCache({**library, **added})
        albums = CountingAlbums(build_albums_from_file_cache({**library, **added}))
        file_cache.counts = albums.counts = counts
        library_state.update({
            "file_cache": file_cache, "albums": albums, "covers_in_progress": False, "scan_in_progress": False,
        })
        state_service.queue_watcher_cover_refresh_for_track_paths_for_state(library_state, config, logger, set(added))
        assert len(executor.submitted) == 1
        executor.run_all()
        # A provider miss is retried up to the watcher's attempt cap, each
        # attempt reading only the queued album; the negative cache keeps it to
        # one provider search, and the queue drains.
        assert counts.returned_rows == 2 * state_service._WATCHER_COVER_REFRESH_MAX_ATTEMPTS
        assert len(searches) == 1
        assert not library_state["_watcher_cover_refresh_pending_track_paths"]
        counts.queue_claims = len(searches)
        return counts

    measure_scale_pair(
        run=run, **_registered("py:services/state.py#_drain_watcher_cover_refresh_queue"),
    )
