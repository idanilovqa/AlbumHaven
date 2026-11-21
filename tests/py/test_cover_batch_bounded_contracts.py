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


@pytest.mark.parametrize(("interaction_id", "claimed_commits"), [
    ("py:services/cover_refresh_runtime.py#start_manual_cover_refresh_request", False),
    ("py:services/cover_refresh_runtime.py#start_manual_cover_refresh", False),
    # The batch worker the reservation runs, through its state.py wiring.
    ("py:services/cover_refresh_runtime.py#refresh_unsuccessful_cover_artwork_request", False),
    ("py:services/state.py#refresh_unsuccessful_cover_artwork_for_state", False),
    pytest.param("py:services/cover_refresh_runtime.py#refresh_unsuccessful_cover_artwork_request", True, id="claimed-commits"),
])
def test_unsuccessful_cover_batch_contract_coalesces_triggers_and_converges_at_production_trigger_count(
    cover_state, tmp_path, monkeypatch, interaction_id, claimed_commits,
):
    if claimed_commits:
        _measure_claimed_cover_commit_batch(cover_state, tmp_path, monkeypatch, interaction_id)
        return
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
        if not interaction_id.endswith("#start_manual_cover_refresh"):
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


@pytest.mark.parametrize("interaction_id", [
    "py:services/cover_refresh_runtime.py#refresh_cover_artwork_request",
    # The whole-library pass context the background batch builds.
    "py:services/cover_refresh_runtime.py#build_cover_refresh_context",
])
def test_background_cover_refresh_contract_coalesces_triggers_and_converges_at_production_trigger_count(
    cover_state, tmp_path, monkeypatch, interaction_id,
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

    measure_scale_pair(run=run, **_registered(interaction_id))


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


@pytest.mark.parametrize("interaction_id", [
    "py:services/state.py#refresh_cover_artwork_for_track_paths_for_state",
    "py:services/cover_refresh_runtime.py#refresh_cover_artwork_for_track_paths_request",
])
def test_fetch_cover_refresh_contract_reads_and_republishes_only_the_selected_album_at_production_album_count(
    cover_state, tmp_path, monkeypatch, interaction_id,
):
    """Fetch cover for one album plans, fetches, and republishes that album
    alone: no file-cache or album-list walk at any library size."""
    from PIL import Image

    from music_app.services import cover_refresh_execution
    from music_app.services import state as state_service
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import library_album_index, publish_library_albums

    app, _executor, searches = cover_state
    config, logger = app.state.config, app.state.logger
    persisted: list[set[str]] = []

    def persist_cover_selection(_config, track_paths, _cover_path, *, commit_guard, **_options):
        # The Postgres cover-selection commit for the selected tracks.
        persisted.append(set(track_paths))
        return commit_guard(lambda: {"track_file_rows_updated": len(track_paths)})

    monkeypatch.setattr(cover_refresh_execution, "persist_cover_selection_in_shared_transaction", persist_cover_selection)

    class CountingAlbums(list):
        counts = OperationCounts()

        def __iter__(self):
            for album in super().__iter__():
                self.counts.candidate_rows += 1
                yield album

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{album_count}.json"
        library = {
            path: {"path": path, "title": "One", "album": "Album", "album_artist": f"Artist {index:05d}"}
            for index in range(album_count - 1)
            for path in (f"/music/Artist {index:05d}/Album/01.mp3",)
        }
        # The selected album's folder holds a cover its cache entry does not know yet.
        selected = _cover_library(tmp_path / f"selected-{album_count}", covered=0, missing=1)
        (selected_path,) = selected
        cover = Path(selected_path).with_name("cover.jpg")
        Image.new("RGB", (1600, 1600), "red").save(cover)
        library_state = app.state.library_state
        library_state.update({"covers_in_progress": False, "scan_in_progress": False})
        publish_library_albums(library_state, CountingAlbums(build_albums_from_file_cache({**library, **selected})))
        file_cache = _CountingFileCache({**library, **selected})
        library_state["file_cache"] = file_cache
        counts = OperationCounts()
        file_cache.counts = library_state["albums"].counts = counts

        result = state_service.refresh_cover_artwork_for_track_paths_for_state(
            library_state, config, logger, {selected_path}, force_search=True,
        )
        assert result["changed"] is True
        assert persisted[-1] == {selected_path}
        assert dict.get(file_cache, selected_path)["cover_path"] == str(cover)
        (republished,) = library_album_index(library_state).albums_with_any_track([selected_path])
        assert Path(republished.cover_path) == cover
        assert list.__len__(library_state["albums"]) == album_count
        counts.queue_claims = len(searches)
        return counts

    measure_scale_pair(run=run, **_registered(interaction_id))



class _CountingCoverDatabase:
    """Stands in for Postgres behind the scan-cache adapter's cover commits.
    Counts every checkout, physical connection opened, and statement run, and
    answers each statement the way a one-album cover commit expects."""

    def __init__(self, counts: OperationCounts):
        self.counts = counts
        self.cleared: list[set[str]] = []
        self.album_ids: dict[str, int] = {}
        self.selections: dict[int, dict[str, object]] = {}
        self.cover_revision = 0
        self.claimed_commits: list[dict[str, object]] = []
        self.selection_reads = 0
        self.connections = []

    def connect(self, _database_url):
        self.counts.pool_leases += 1
        return self.open_connection()

    def open_connection(self):
        self.counts.physical_connections += 1
        database = self

        class Rows:
            def __init__(self, row):
                self._row = row

            def fetchone(self):
                row = (self._row[0] if self._row else None) if isinstance(self._row, list) else self._row
                database.counts.returned_rows += int(row is not None)
                return row

            def fetchall(self):
                rows = self._row if isinstance(self._row, list) else [self._row]
                database.counts.returned_rows += len(rows)
                return rows

        class Connection:
            closed = False
            autocommit = False

            def __init__(self):
                self.advisory_locks = set()

            def execute(self, sql, params=None):
                database.counts.sql_statements += 1
                if "pg_advisory_unlock(" in sql:
                    assert tuple(params) in self.advisory_locks
                    self.advisory_locks.remove(tuple(params))
                    return Rows({"pg_advisory_unlock": True})
                if "pg_advisory_lock(" in sql:
                    assert tuple(params) not in self.advisory_locks
                    self.advisory_locks.add(tuple(params))
                    return Rows({"pg_advisory_lock": None})
                if isinstance(params, dict) and "album_ids" in params:
                    database.selection_reads += 1
                    return Rows([
                        {"album_id": album_id, "selected_cover_path": database.selections[album_id]["cover_path"],
                         "cover_selection_origin": "automatic", "cover_revision": database.selections[album_id]["cover_revision"]}
                        for album_id in params["album_ids"]
                    ])
                if "library.resolve_cover_mutation_identity(" in sql:
                    album_ids = {database.album_ids[path] for path in params["track_paths"]}
                    assert len(album_ids) == 1
                    return Rows({"library_id": 1, "local_album_id": album_ids.pop()})
                if "library.load_cover_mutation_baseline(" in sql:
                    selection = database.selections[params["album_id"]]
                    return Rows({
                        "inventory_revision": 0,
                        "cover_mutation_revision": database.cover_revision,
                        "selected_cover_path": selection["cover_path"],
                        "selected_cover_revision": selection["cover_revision"],
                    })
                if "ops.persist_claimed_automatic_cover_selection(" in sql:
                    assert params["library_id"] == params["expected_library_id"] == 1
                    assert params["task_id"] == 7 and params["job_id"] == 11
                    assert params["attempt"] == 1 and params["worker_id"] == "contract-worker"
                    assert params["lease_token"] == "contract-lease"
                    assert params["expected_inventory_revision"] == 0
                    assert params["expected_cover_mutation_revision"] == database.cover_revision
                    paths = set(params["track_paths"])
                    assert {database.album_ids[path] for path in paths} == {params["expected_album_id"]}
                    database.cover_revision += 1
                    database.selections[params["expected_album_id"]] = {
                        "cover_path": params["selected_cover_path"],
                        "cover_revision": params["cover_revision"],
                    }
                    database.claimed_commits.append(dict(params))
                    return Rows({
                        "input_path_count": len(paths), "resolved_path_count": len(paths),
                        "selected_album_count": 1, "album_rows_updated": 1,
                        "album_track_file_count": len(paths), "track_file_rows_updated": len(paths),
                    })
                if isinstance(params, dict) and "track_paths" in params:
                    count = len(params["track_paths"])
                    if params.get("selected_cover_path") is None:
                        database.cleared.append(set(params["track_paths"]))
                    return Rows({
                        "input_path_count": count, "resolved_path_count": count, "selected_album_count": 1,
                        "album_track_file_count": count, "album_rows_updated": 1, "track_file_rows_updated": count,
                    })
                if "inventory_mutation_revision" in str(sql):
                    return Rows({"library_id": 1, "inventory_mutation_revision": 0, "cover_mutation_revision": database.cover_revision})
                return Rows({"ready": True})

            def commit(self):
                database.counts.transactions += 1

            def rollback(self):
                pass

            def close(self):
                assert not self.advisory_locks
                self.closed = True

            # As psycopg: leaving the block commits (or rolls back) and closes.
            def __enter__(self):
                return self

            def __exit__(self, exc_type, *_exc):
                if self.autocommit:
                    return False
                self.rollback() if exc_type else self.commit()
                self.close()
                return False

        connection = Connection()
        self.connections.append(connection)
        return connection


def _with_counting_cover_database(app, monkeypatch, counts: OperationCounts) -> _CountingCoverDatabase:
    """Routes the real cover commits to a counting stand-in; the album
    candidate snapshots and provider outcomes (their own stores) stay out."""
    from types import SimpleNamespace

    from music_app.services import cover_refresh_execution, scan_cache_persistence

    database = _CountingCoverDatabase(counts)
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = "postgresql://contract/cover-commits"
    monkeypatch.setattr(scan_cache_persistence, "_connect", database.connect)
    monkeypatch.setattr(
        cover_refresh_execution, "AlbumCoverCandidateSnapshotRepository",
        lambda _config: SimpleNamespace(resolve_album_ids_for_track_path_sets=lambda sets: [None] * len(sets)),
    )
    monkeypatch.setattr(cover_refresh_execution, "persist_cover_provider_outcomes", lambda *_args, **_kwargs: None)
    return database


def _missing_cover_albums(root: Path, count: int) -> dict[str, dict[str, object]]:
    """`count` albums whose recorded automatic cover file no longer exists."""
    file_cache = {}
    for index in range(count):
        folder = root / f"Artist {index:05d}" / "Album"
        folder.mkdir(parents=True)
        path = str(folder / "01.mp3")
        file_cache[path] = {
            "path": path, "title": "One", "album": f"Album {index}", "album_artist": f"Artist {index:05d}",
            "artist": f"Artist {index:05d}", "cover_path": str(folder / "cover.jpg"),
            "cover_revision": "gone", "cover_selection_origin": "automatic",
        }
    return file_cache


def _with_library_roots(monkeypatch, *roots: Path) -> None:
    """The configured library roots the cover run probes for reachability."""
    from music_app.services import cover_refresh_execution

    monkeypatch.setattr(cover_refresh_execution, "configured_library_root_paths_snapshot", lambda _config: tuple(roots))


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
def test_claimed_cover_refresh_contract_runs_real_worker_at_production_album_count(
    cover_state, tmp_path, monkeypatch, mode,
):
    _measure_claimed_cover_commit_batch(
        cover_state, tmp_path, monkeypatch,
        "py:services/cover_refresh_runtime.py#run_claimed_cover_refresh", runtime_mode=mode,
    )


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
def test_claimed_cover_refresh_reuses_connections_for_recovered_existing_covers(
    cover_state, tmp_path, monkeypatch, mode, request,
):
    _measure_claimed_cover_commit_batch(
        cover_state, tmp_path, monkeypatch,
        "py:services/cover_refresh_runtime.py#run_claimed_cover_refresh",
        runtime_mode=mode, recover_existing=True, proof_node_id=request.node.nodeid,
    )


def _measure_claimed_cover_commit_batch(
    cover_state, tmp_path, monkeypatch, interaction_id, *, runtime_mode=None, recover_existing=False,
    proof_node_id=None,
):
    from datetime import datetime, timezone
    from io import BytesIO

    from PIL import Image

    from music_app.services import cover_jobs_postgres, cover_mutations_postgres, cover_refresh_provider, postgres_connections
    from music_app.services import state as state_service
    from music_app.services import cover_refresh_execution, cover_refresh_planning, cover_refresh_runtime, library
    from music_app.services.cover_provider_candidates import CoverCandidate

    app, _executor, searches = cover_state
    real_album_builder = library.build_albums_from_file_cache
    real_job_planner = cover_refresh_planning.build_cover_refresh_jobs
    real_execute = cover_refresh_runtime.execute_cover_refresh_request
    real_recover = cover_refresh_execution._recover_existing_cover_selection
    image_bytes = BytesIO()
    with Image.new("RGB", (1200, 1200), "teal") as image:
        image.save(image_bytes, format="JPEG")
    candidate = CoverCandidate(
        source="bandcamp", url="https://covers.example.test/cover.jpg",
        width=1200, height=1200, raw_bytes=image_bytes.getvalue(),
    )

    def search_remote_cover(*, artist, album, **_kwargs):
        searches.append((artist, album))
        if recover_existing:
            return None, [{"status": "not_found"}]
        return candidate, [{"status": "candidate"}]

    monkeypatch.setattr(cover_refresh_provider, "search_primary_remote_cover", search_remote_cover)

    proof_scales = []

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        counts = OperationCounts()
        database = _with_counting_cover_database(app, monkeypatch, counts)
        default_mutation_connects = []

        def default_mutation_connect(database_url):
            default_mutation_connects.append(database_url)
            return database.connect(database_url)

        monkeypatch.setattr(cover_mutations_postgres, "_default_connect", default_mutation_connect)
        monkeypatch.setattr(cover_jobs_postgres, "_default_connect", database.connect)

        from types import SimpleNamespace
        from psycopg.pq import TransactionStatus
        from psycopg_pool import ConnectionPool

        lock_connections = []
        lock_checkouts = []

        class LockTransport:
            @classmethod
            def connect(cls, _conninfo, **options):
                assert options["autocommit"] is True
                connection = database.open_connection()
                connection.autocommit = True
                connection.pgconn = SimpleNamespace(transaction_status=TransactionStatus.IDLE)
                lock_connections.append(connection)
                return connection

        class CountedPool(ConnectionPool):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, connection_class=LockTransport, **kwargs)

            def getconn(self, timeout=None):
                connection = super().getconn(timeout=timeout)
                counts.pool_leases += 1
                lock_checkouts.append(connection)
                return connection

        pools = {}
        monkeypatch.setattr(postgres_connections, "ConnectionPool", CountedPool)
        monkeypatch.setattr(postgres_connections, "_pools", pools)
        root = tmp_path / f"claimed-library-{album_count}"
        _with_library_roots(monkeypatch, root)
        file_cache = _missing_cover_albums(root, album_count)
        recovered_paths = []
        if recover_existing:
            for path, entry in file_cache.items():
                entry["cover_path"] = entry["cover_revision"] = None
                Path(path).with_name("cover.jpg").write_bytes(image_bytes.getvalue())

            def recover_existing_selection(**options):
                assert options["cover_path"].is_file()
                assert not options["job"].get("selected_cover_path")
                result = real_recover(**options)
                assert result == (True, False)
                recovered_paths.append(options["cover_path"])
                return result

            monkeypatch.setattr(cover_refresh_execution, "_recover_existing_cover_selection", recover_existing_selection)
        database.album_ids = {path: index for index, path in enumerate(file_cache, start=1)}
        if runtime_mode is not None:
            for path, entry in file_cache.items():
                entry["album_id"] = database.album_ids[path]
        database.selections = {database.album_ids[path]: dict(entry) for path, entry in file_cache.items()}
        config = app.state.config
        config["COVER_CACHE_PATH"] = tmp_path / f"claimed-cache-{album_count}.json"
        repository = cover_jobs_postgres.PostgresCoverJobRepository(database_url=config["ALBUM_HAVEN_APP_DATABASE_URL"])

        def persist_claimed(track_paths, selected_cover_path, **options):
            return repository.persist_claimed_automatic_cover_selection(
                task_id=7, library_id=1, job_id=11, attempt=1,
                worker_id="contract-worker", lease_token="contract-lease", now=datetime.now(timezone.utc),
                track_paths=track_paths, selected_cover_path=selected_cover_path, **options,
            )

        config["CLAIMED_COVER_SELECTION_PERSISTER"] = persist_claimed
        state = app.state.library_state
        state.update({"file_cache": file_cache, "covers_in_progress": False, "scan_in_progress": False})
        observed_states = []
        progress_updates = []

        def observe_execute(**options):
            worker_state = options["context"].library_state
            assert isinstance(worker_state, cover_refresh_runtime._DurableCoverRefreshState)
            observed_states.append(worker_state)
            counts.queue_claims += len(options["jobs"])
            assert database.selection_reads == 1
            assert counts.pool_leases == counts.physical_connections == 1
            return real_execute(**options)

        def count_album_builder(entries, *args, **kwargs):
            counts.builder_calls += 1
            counts.membership_rows += len(entries)
            return real_album_builder(entries, *args, **kwargs)

        def count_job_planner(entries, *args, **kwargs):
            counts.builder_calls += 1
            counts.membership_rows += len(entries)
            return real_job_planner(entries, *args, **kwargs)

        try:
            if runtime_mode is None:
                state_service.refresh_unsuccessful_cover_artwork_for_state(state, config, app.state.logger, force_search=True)
            else:
                source = _CountingFileCache(file_cache)
                source.counts = counts
                with monkeypatch.context() as patch:
                    patch.setattr(library, "build_albums_from_file_cache", count_album_builder)
                    patch.setattr(cover_refresh_planning, "build_cover_refresh_jobs", count_job_planner)
                    patch.setattr(state_service, "build_cover_refresh_jobs", count_job_planner)
                    patch.setattr(cover_refresh_runtime, "execute_cover_refresh_request", observe_execute)
                    result = cover_refresh_runtime.run_claimed_cover_refresh(
                        scope=SimpleNamespace(file_cache=source, separate_release_keys=(), progress_total=album_count,
                                              mode=runtime_mode, force_search=True),
                        config=config, logger=app.state.logger, should_cancel=lambda: False,
                        progress=lambda **values: progress_updates.append(values) or True,
                    )
                assert len(observed_states) == 1
                state = observed_states[0]
                assert state is not app.state.library_state
                assert state["file_cache"] is not source
                assert all(entry["cover_revision"] == (None if recover_existing else "gone") for entry in file_cache.values())
                assert result["processed"] == album_count
                assert result["downloaded"] == (0 if recover_existing else album_count)
                assert progress_updates
                assert counts.candidate_rows == album_count
                assert counts.builder_calls == 2
                assert counts.membership_rows == 2 * album_count
                assert counts.queue_claims == album_count
                assert database.selection_reads == 1
                counts.provider_calls = len(searches)
        finally:
            for pool in pools.values():
                pool.close()
        assert len(lock_checkouts) == album_count
        assert len(lock_connections) == 1
        assert all(connection.closed and not connection.advisory_locks for connection in lock_connections)
        assert all(connection.closed and not connection.advisory_locks for connection in database.connections)
        preparation_read = int(runtime_mode is not None)
        assert counts.pool_leases == album_count + 1 + preparation_read
        assert counts.physical_connections == 2 + preparation_read
        expected_searches = 0 if recover_existing and runtime_mode == "post_scan" else album_count
        assert len(searches) == expected_searches
        assert len(database.claimed_commits) == album_count
        assert database.cleared == []
        if recover_existing:
            assert len(recovered_paths) == len(set(recovered_paths)) == album_count
            assert default_mutation_connects == []
        for path, entry in state["file_cache"].items():
            saved = database.selections[database.album_ids[path]]
            assert entry["cover_path"] == saved["cover_path"]
            assert entry["cover_revision"] == saved["cover_revision"]
            assert Path(saved["cover_path"]).is_file()
            if recover_existing:
                assert Path(saved["cover_path"]).read_bytes() == image_bytes.getvalue()
        if proof_node_id is not None:
            proof_scales.append({
                "cardinality": album_count,
                "physicalConnections": counts.physical_connections,
                "checkouts": counts.pool_leases,
                "recoveryHits": len(recovered_paths),
                "defaultConnectorCalls": len(default_mutation_connects),
                "cleanupComplete": True,
            })
        return counts

    measure_scale_pair(run=run, **_registered(interaction_id))
    if proof_node_id is not None:
        _record_recovered_cover_proof(
            node_id=proof_node_id, kind="unit", mode=runtime_mode, scales=proof_scales,
        )


def _record_recovered_cover_proof(*, node_id, kind, mode, scales):
    """Record scoped native measurements only after their teardown assertions."""
    import json
    import os

    evidence = os.environ.get("BOUNDED_INTERACTION_EVIDENCE")
    if evidence:
        with Path(evidence).open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "id": "py:services/cover_refresh_runtime.py#run_claimed_cover_refresh",
                "test": node_id.split("::")[-1].split("[")[0],
                "nodeId": node_id,
                "proof": {"schemaVersion": 1, "kind": kind, "mode": mode, "scales": scales},
            }) + "\n")


def test_fetch_cover_keeps_a_missing_cover_selection_and_writes_nothing_at_production_album_count(
    cover_state, tmp_path, monkeypatch,
):
    """Fetch cover for one album whose cover file is gone, when the search finds
    nothing, keeps that album's saved cover selection, reports the missing
    file, and commits nothing, however large the library."""
    from music_app.services import state as state_service
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import publish_library_albums

    app, _executor, searches = cover_state
    config, logger = app.state.config, app.state.logger

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        counts = OperationCounts()
        database = _with_counting_cover_database(app, monkeypatch, counts)
        _with_library_roots(monkeypatch, tmp_path / f"selected-{album_count}")
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{album_count}.json"
        library = {
            path: {"path": path, "title": "One", "album": "Album", "album_artist": f"Other {index:05d}"}
            for index in range(album_count - 1)
            for path in (f"/music/Other {index:05d}/Album/01.mp3",)
        }
        selected = _missing_cover_albums(tmp_path / f"selected-{album_count}", 1)
        (selected_path,) = selected
        saved = dict(selected[selected_path])
        library_state = app.state.library_state
        library_state.update({"covers_in_progress": False, "scan_in_progress": False, "file_cache": {**library, **selected}})
        publish_library_albums(library_state, build_albums_from_file_cache(library_state["file_cache"]))

        result = state_service.refresh_cover_artwork_for_track_paths_for_state(
            library_state, config, logger, {selected_path}, force_search=True,
        )
        assert result["changed"] is False
        assert database.cleared == []
        assert counts.transactions == 0
        assert library_state["file_cache"][selected_path] == saved
        (job_result,) = result["job_results"]
        assert job_result["reason"] == "selected_cover_file_missing"
        assert job_result["search_reason"] == "remote_search_returned_no_candidate"
        assert job_result["message"] == "Cover file missing; saved choice kept."
        assert result["summary"] == "1 album(s) have a missing cover file; saved choice kept."
        assert len(searches) == 1
        return counts

    measure_scale_pair(run=run, **_registered("py:services/cover_refresh_runtime.py#refresh_cover_artwork_for_track_paths_request"))


def test_unsuccessful_cover_batch_keeps_each_missing_cover_selection_and_writes_nothing_at_production_album_count(
    cover_state, tmp_path, monkeypatch,
):
    """Fetch covers for unsuccessful albums, over albums whose cover files are
    gone and for which the search finds nothing, keeps every saved selection:
    20 albums or 1,000, nothing is committed."""
    from music_app.services import state as state_service

    app, _executor, searches = cover_state
    config, logger = app.state.config, app.state.logger

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        counts = OperationCounts()
        database = _with_counting_cover_database(app, monkeypatch, counts)
        _with_library_roots(monkeypatch, tmp_path / f"library-{album_count}")
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{album_count}.json"
        file_cache = _missing_cover_albums(tmp_path / f"library-{album_count}", album_count)
        saved = {path: dict(entry) for path, entry in file_cache.items()}
        library_state = app.state.library_state
        library_state.update({"covers_in_progress": False, "scan_in_progress": False, "file_cache": file_cache})

        state_service.refresh_unsuccessful_cover_artwork_for_state(library_state, config, logger, force_search=True)
        assert database.cleared == []
        assert counts.transactions == 0
        assert dict(library_state["file_cache"]) == saved
        assert len(searches) == album_count
        return counts

    measure_scale_pair(run=run, **_registered("py:services/cover_refresh_runtime.py#refresh_unsuccessful_cover_artwork_request"))


def test_unsuccessful_cover_batch_skips_an_offline_library_root_without_searching_or_writing_at_production_album_count(
    cover_state, tmp_path, monkeypatch,
):
    """Fetch covers for unsuccessful albums while their library root is
    offline: no album is searched, published or changed, each says so by the
    root's label, and the root is probed once, at 20 albums or 1,000."""
    import shutil

    from music_app.services import cover_refresh_execution
    from music_app.services import cover_refresh_runtime as runtime
    from music_app.services import state as state_service

    app, _executor, searches = cover_state
    config, logger = app.state.config, app.state.logger
    results: list[dict] = []
    real_execute = runtime.execute_cover_refresh_request
    monkeypatch.setattr(
        runtime, "execute_cover_refresh_request",
        lambda **kwargs: results.append(real_execute(**kwargs)) or results[-1],
    )

    def run(album_count: int) -> OperationCounts:
        searches.clear()
        results.clear()
        counts = OperationCounts()
        database = _with_counting_cover_database(app, monkeypatch, counts)
        offline_root = tmp_path / f"offline-{album_count}"
        _with_library_roots(monkeypatch, offline_root)
        config["COVER_CACHE_PATH"] = tmp_path / f"cover-cache-{album_count}.json"
        # The albums were indexed while the share was online; it is gone now.
        file_cache = _missing_cover_albums(offline_root, album_count)
        for entry in file_cache.values():
            entry["library_root_category"] = "hoard"
        shutil.rmtree(offline_root)
        saved = {path: dict(entry) for path, entry in file_cache.items()}
        library_state = app.state.library_state
        library_state.update({"covers_in_progress": False, "scan_in_progress": False, "file_cache": file_cache})
        probes: list[str] = []
        real_isdir = cover_refresh_execution.os.path.isdir
        monkeypatch.setattr(cover_refresh_execution.os.path, "isdir", lambda path: probes.append(str(path)) or real_isdir(path))
        try:
            state_service.refresh_unsuccessful_cover_artwork_for_state(library_state, config, logger, force_search=True)
        finally:
            monkeypatch.setattr(cover_refresh_execution.os.path, "isdir", real_isdir)
        assert searches == []
        assert database.cleared == []
        assert counts.transactions == 0
        assert dict(library_state["file_cache"]) == saved
        assert probes == [str(offline_root)]
        (result,) = results
        assert {item["reason"] for item in result["job_results"]} == {"library_root_unavailable"}
        assert {item["message"] for item in result["job_results"]} == {
            "Hoard is offline, so this album was skipped. Its saved cover was not changed.",
        }
        assert result["summary"] == "Cover search skipped: Hoard is offline. Saved covers were not changed."
        assert (result["skipped"], result["failed"], result["downloaded"]) == (album_count, 0, 0)
        counts.stat_calls = len(probes)
        return counts

    measure_scale_pair(run=run, **_registered("py:services/cover_refresh_runtime.py#refresh_unsuccessful_cover_artwork_request"))
