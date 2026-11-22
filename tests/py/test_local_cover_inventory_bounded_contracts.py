"""Bounded-interaction contract for the local cover inventory.

A scan and a watcher event re-list only the folders they changed; a root change or
an event at or above a root writes nothing; an open repairs its own album; and a
restart re-lists none, whatever backlog is stored. The real scan,
root-change wiring, repository and worker run over real folders; only the two
inventory tables are an in-memory stand-in that counts the rows each statement
writes and the folders it hands out.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import cover_workflow, library_indexing, scan_state
from music_app.services.local_cover_inventory import (
    LocalCoverInventoryRepository,
    LocalCoverInventoryWorker,
    context_key,
    root_key,
)
from music_app.services.metadata import FILE_METADATA_SCHEMA_VERSION
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_WORKER = "py:services/local_cover_inventory.py#LocalCoverInventoryWorker._run"
_DAY = 86400.0
# A pass that finds its queued key already done writes nothing, so one quiet pass is not the end.
_QUIET_PASSES = 3
_ROOT_CHANGES = {"root added", "root changed", "root removed", "nested root removed", "roots saved unchanged"}
_ROOT_LEVEL_EVENTS = {"root deleted", "root moved", "drive gone"}


class _InventoryTables:
    """The two inventory tables, answering the repository's statements."""

    def __init__(self):
        self.listings: dict[str, dict[str, object]] = {}
        self.contexts: dict[str, dict[str, object]] = {}
        self.listed: list[str] = []
        self.written = 0
        self.statements = 0
        self.values_sent = 0
        self.album_walk_steps = 0

    def seed(self, album: Path, tracks: list[Path]) -> None:
        self.listings[root_key(album)] = {"revision": 1, "indexed": 1, "claimed": False}
        self.contexts[context_key([str(track) for track in tracks])] = {
            "paths": [root_key(track) for track in tracks], "root": root_key(album), "revision": 1, "claimed": False,
        }

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def commit(self):
        pass

    def close(self):
        pass

    def execute(self, query, params=None):
        self.statements += 1
        self.values_sent += sum(len(value) for value in (params or {}).values() if isinstance(value, list))
        rows = self._answer(" ".join(str(query).split()), params or {})
        return SimpleNamespace(fetchone=lambda: rows[0] if rows else None, fetchall=lambda: rows, rowcount=len(rows))

    def _write(self, row: dict[str, object], **values) -> None:
        row.update(values)
        self.written += 1

    def _answer(self, sql: str, params) -> list[dict[str, object]]:
        if "pg_try_advisory_lock" in sql:
            return [{"acquired": True}]
        if "pg_advisory_unlock" in sql:
            return []
        if "as waiting" in sql:
            return [{"waiting": False}]
        if "with next_album as" in sql:
            self.album_walk_steps += 1
            return []
        if "interval '30 seconds'" in sql and "insert into" not in sql:
            return self._claim_context(params)
        if "interval '5 minutes'" in sql:
            return self._claim_listing(params)
        if "insert into library.local_cover_inventory_contexts" in sql:
            row = self.contexts[params["key"]]
            return [{"root_path": row["root"], "revision": row["revision"], "error": None}]
        if sql.startswith("select") and "local_cover_inventory_contexts" in sql:
            row = self.contexts.get(params["key"])
            return [{"root_path": row["root"], "revision": row["revision"], "track_paths": row["paths"]}] if row else []
        if "set root_path = null" in sql and "key" in params:
            row = self.contexts[params["key"]]
            if row["revision"] == params["revision"]:
                self._write(row, root=None, revision=row["revision"] + 1, claimed=False)
            return []
        if "insert into library.local_cover_inventories " in sql:
            self._write(self.listings.setdefault(params["root"], {"revision": 1, "indexed": 0, "claimed": False}))
            return []
        if "update library.local_cover_inventories set candidates" in sql:
            row = self.listings[params["root"]]
            self._write(row, indexed=row["revision"], claimed=False)
            return [{"root_path": params["root"]}]
        if "update library.local_cover_inventory_contexts set root_path = %(root)s" in sql:
            self._write(self.contexts[params["key"]], root=params["root"], claimed=False)
            return []
        if "retry_after = now() + %(delay)s" in sql:
            self.written += 1  # a deferral: the row stays claimed, so this run does not retry it
            return []
        if "update library.local_cover_inventories set revision = revision + 1" in sql:
            return self._invalidate_listings(params)
        if "set root_path = null" in sql:
            return self._invalidate_contexts(params)
        raise AssertionError(f"unexpected inventory statement: {sql}")

    def _claim_context(self, params) -> list[dict[str, object]]:
        for key, row in self.contexts.items():
            if params.get("key", key) == key and not row["root"] and not row["claimed"]:
                self._write(row, claimed=True)
                return [{"context_key": key, "track_paths": row["paths"], "revision": row["revision"],
                         "foreground_requested": False}]
        return []

    def _claim_listing(self, params) -> list[dict[str, object]]:
        for key, row in self.listings.items():
            if params.get("root", key) == key and row["indexed"] < row["revision"] and not row["claimed"]:
                self._write(row, claimed=True)
                self.listed.append(key)
                return [{"root_path": key, "revision": row["revision"], "foreground_requested": False}]
        return []

    @staticmethod
    def _rebuilt(path: str, params) -> bool:
        return path.startswith(tuple(params["rebuild_prefixes"])) and not path.startswith(tuple(params["kept_prefixes"]))

    def _invalidate_listings(self, params) -> list[dict[str, object]]:
        changed = []
        for key, row in self.listings.items():
            if "rebuild_prefixes" in params:
                if not self._rebuilt(key, params):
                    continue
            elif params and key not in params["roots"] and not key.startswith(tuple(params["prefixes"])):
                continue
            self._write(row, revision=row["revision"] + 1, claimed=False)
            changed.append({"root_path": key})
        return changed

    def _invalidate_contexts(self, params) -> list[dict[str, object]]:
        changed = []
        for key, row in self.contexts.items():
            root = row["root"]
            if "rebuild_prefixes" in params:
                if not any(self._rebuilt(path, params) for path in ([root] if root else row["paths"])):
                    continue
            elif params:
                if root:
                    prefixes = (*params["prefixes"], *params.get("disc_prefixes", ()))
                    affected = root in params["roots"] or root.startswith(prefixes)
                else:
                    affected = key in params.get("pending_contexts", (key,)) and any(
                        path.startswith(tuple(params["context_prefixes"])) for path in row["paths"]
                    )
                if not affected:
                    continue
            self._write(row, root=None, revision=row["revision"] + 1, claimed=False)
            changed.append({"context_key": key})
        return changed


def _seed_library(base: Path, album_count: int):
    """`album_count` listed albums in Main and one in a second root, all untouched for a day."""
    roots = [
        {"id": root_id, "path": str((base / root_id).resolve()), "layout_mode": "artist", "category": category}
        for root_id, category in (("main", "main_library_roots"), ("extra", "hoarding_library_roots"))
    ]
    albums = [Path(roots[0]["path"]) / f"Artist {index:04d}" / "Album" for index in range(album_count)]
    albums.append(Path(roots[1]["path"]) / "Artist" / "Album")
    tables = _InventoryTables()
    file_cache = {}
    long_ago = time.time() - _DAY
    for index, album in enumerate(albums):
        album.mkdir(parents=True)
        tracks = [album / "01.mp3", album / "02.mp3"]
        for path in (*tracks, album / "cover.jpg"):
            path.write_bytes(b"seeded")
            os.utime(path, (long_ago, long_ago))
        for number, track in enumerate(tracks, start=1):
            stat = track.stat()
            file_cache[str(track)] = {
                "path": str(track), "mtime": stat.st_mtime, "size": stat.st_size, "title": f"Track {number}",
                "album": f"Album {index}", "album_artist": f"Artist {index}", "artist": f"Artist {index}",
                "track_number": number, "metadata_schema_version": FILE_METADATA_SCHEMA_VERSION, "release_date": None,
                "library_root_id": "main" if index < album_count else "extra",
            }
        tables.seed(album, tracks)
    for folder in [path for path in base.rglob("*") if path.is_dir()]:
        os.utime(folder, (long_ago, long_ago))
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://inventory.invalid/contract",
        "IMAGE_EXTENSIONS": {".jpg"}, "CACHE_PATH": base / "cache", "CACHE_MAX_AGE_SECONDS": 0,
        "_library_root_paths_snapshot": tuple(Path(root["path"]) for root in roots),
    }
    worker = LocalCoverInventoryWorker(
        config,
        repository=LocalCoverInventoryRepository(config, connect=lambda _url: tables),
        # The worker logs and retries what fails; here that is a failed contract.
        logger=SimpleNamespace(exception=lambda message, *_args: pytest.fail(message)),
    )
    return SimpleNamespace(
        roots=roots, album=albums[0], file_cache=file_cache, tables=tables, config=config, worker=worker,
    )


def _scan(monkeypatch, library, checked_at: dict[str, float], *, full_rescan=False, away="", incomplete="") -> None:
    class Adapter:
        def load_snapshot(self, _cache_path, _identity):
            return {}, 0.0, {}, 0.0, None

        def load_cover_inventory_checked_at(self):
            return dict(checked_at)

    monkeypatch.setattr(scan_state, "_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(scan_state, "pin_library_scan_roots", lambda _config: (list(library.roots), "roots"))
    monkeypatch.setattr(scan_state, "resolve_media_host_history_scope", lambda _config: None)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *_args, **_kwargs: None)
    state = {
        "file_cache": dict(library.file_cache), "albums": [], "last_scan": time.time() - 3600,
        "relation_views": {"artists": ["Artist"]}, "scan_generation": 0,
        "rescan_ignore_existing_cache": full_rescan,
    }
    reachable = [root for root in library.roots if root["id"] != away]
    if full_rescan:
        # A Full Rescan reads every file again; these seeded files answer with what was seeded.
        monkeypatch.setattr(library_indexing, "read_metadata_for_file", lambda path: dict(library.file_cache[str(path)]))

    def scan(*, publication_state, **options):
        publication_state["observed_library_root_ids"] = {root["id"] for root in reachable}
        if incomplete:
            publication_state["scan_incomplete_root_ids"] = {incomplete}
        return library_indexing.scan_library_file_cache(
            state, roots=[Path(root["path"]) for root in reachable], root_definitions=library.roots,
            supported_extensions={".mp3"}, image_extensions={".jpg"}, exception_overrides={},
            publication_state=publication_state, **options,
        )

    scan_state.refresh_library_state(
        state,
        config={**library.config, "_LOCAL_COVER_INVENTORY": library.worker},
        logger=SimpleNamespace(exception=lambda *_args: None, warning=lambda *_args: None),
        force=True,
        cache_lock=threading.Lock(),
        scan_music_incremental=scan,
        refresh_relation_views=lambda **_options: None,
        start_manual_cover_refresh=lambda **_options: {},
        start_background_cover_refresh=lambda: None,
    )
    assert state["scan_outcome"] == "completed"


def _change_roots(monkeypatch, library, roots: list[dict[str, object]]) -> None:
    """The live root change, through the application's own wiring."""
    from music_app import create_asgi_app
    from music_app.services import lastfm_retry, library_reconciliation, library_roots, runtime_shutdown, state
    from tests.py.runtime_testing import stub_targeted_reconciliation_repository

    stub_targeted_reconciliation_repository(monkeypatch)
    monkeypatch.setattr(library_roots, "get_library_roots", lambda _config: list(library.roots))
    monkeypatch.setattr(library_reconciliation, "WatchdogLibraryEventSource", lambda _roots: None)
    monkeypatch.setattr(library_reconciliation, "LibraryWatchService", lambda *_args: SimpleNamespace(
        start=lambda: True, stop=lambda *_a, **_k: True, replace_roots=lambda _roots: True,
    ))
    monkeypatch.setattr(state, "hydrate_runtime_library_state_on_startup", lambda _runtime: True)
    monkeypatch.setattr(state, "ensure_runtime_relation_projection_ready", lambda _runtime: None)
    monkeypatch.setattr(lastfm_retry, "start_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(lastfm_retry, "stop_lastfm_retry_worker", lambda _runtime: None)
    monkeypatch.setattr(runtime_shutdown, "request_runtime_shutdown", lambda _runtime: True)
    monkeypatch.setattr(library.worker, "start", lambda: None)
    app = create_asgi_app()
    app.state.local_cover_inventory = library.worker

    async def change():
        async with app.router.lifespan_context(app):
            app.state.replace_library_watch_roots(roots)

    asyncio.run(change())


def _changed_roots(library, change: str) -> list[dict[str, object]]:
    main, extra = library.roots
    if change == "root added":
        return [main, extra, {**extra, "id": "added", "path": str(Path(extra["path"]).with_name("added"))}]
    if change == "root changed":
        return [{**main, "layout_mode": "genre/artist"}, extra]
    if change == "root removed":
        return [main]
    if change == "nested root removed":
        library.roots = [main, extra, {**main, "id": "nested", "path": str(library.album.parent)}]
    return [main, extra]


def _open_album(library, change: str) -> tuple[str, str | None]:
    """An open as the gallery route makes it; returns the context and the folder it must end with."""
    album = library.album if "removed root" not in change else Path(library.roots[1]["path"]) / "Artist" / "Album"
    paths = [str(album / "01.mp3"), str(album / "02.mp3")]
    key, shown = context_key(paths), root_key(album)
    if "removed root" in change:
        library.roots = library.roots[:1]
        library.config["_library_root_paths_snapshot"] = (Path(library.roots[0]["path"]),)
        shown = None
    elif "boundary moved" in change:
        library.tables.contexts[key]["root"] = root_key(album.parent)
    stored = library.worker.repository.root_for_tracks(paths)
    if stored is None:
        library.worker.request_context(paths)
    else:
        library.worker.recheck_context(paths)
    return key, shown


def _drain(monkeypatch, library, worker) -> None:
    """Run the real worker, idle long enough for background work, until it writes nothing more."""
    worker._stop.clear()  # the application's shutdown stopped it
    worker._foreground_at -= 3600
    passes = quiet = 0
    written = None

    def next_pass(_timeout=None):
        nonlocal passes, quiet, written
        passes += 1
        assert passes < 2000, "the inventory worker did not settle"
        quiet = quiet + 1 if library.tables.written == written else 0
        written = library.tables.written
        if quiet >= _QUIET_PASSES:
            worker._stop.set()
        return True

    monkeypatch.setattr(worker._wake, "wait", next_pass)
    monkeypatch.setattr(cover_workflow, "get_library_roots", lambda _config: list(library.roots))
    worker._run()


@pytest.mark.parametrize("root_ids", [("main", "extra"), (7, 8)], ids=["text ids", "numeric ids"])
@pytest.mark.parametrize("unreadable", ["away", "incomplete"])
def test_a_full_rescan_hands_the_inventory_exactly_the_roots_it_read(tmp_path, monkeypatch, root_ids, unreadable):
    """The scan names its roots as text, whatever type the settings stored: an id compared by type
    would keep a readable root's stale folders, or rebuild an unreadable one's."""
    roots = [
        {"id": root_id, "path": str(tmp_path / name), "layout_mode": "artist", "category": "main_library_roots"}
        for root_id, name in zip(root_ids, ("main", "extra"))
    ]
    rescanned = []

    class Adapter:
        def load_snapshot(self, _cache_path, _identity):
            return {}, 0.0, {}, 0.0, None

        def load_cover_inventory_checked_at(self):
            return {}

    monkeypatch.setattr(scan_state, "_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(scan_state, "pin_library_scan_roots", lambda _config: (list(roots), "roots"))
    monkeypatch.setattr(scan_state, "resolve_media_host_history_scope", lambda _config: None)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *_args, **_kwargs: None)
    state = {
        "file_cache": {}, "albums": [], "last_scan": time.time() - 3600,
        "relation_views": {"artists": ["Artist"]}, "scan_generation": 0, "rescan_ignore_existing_cache": True,
    }

    def scan(*, publication_state, **_options):
        walked = roots[:1] if unreadable == "away" else roots
        publication_state["observed_library_root_ids"] = {str(root["id"]).strip() for root in walked}
        if unreadable == "incomplete":
            publication_state["scan_incomplete_root_ids"] = {str(roots[1]["id"]).strip()}
        return {}, time.time()

    scan_state.refresh_library_state(
        state,
        config={
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://inventory.invalid/contract", "IMAGE_EXTENSIONS": {".jpg"},
            "CACHE_PATH": tmp_path / "cache", "CACHE_MAX_AGE_SECONDS": 0,
            "_library_root_paths_snapshot": tuple(Path(root["path"]) for root in roots),
            "_LOCAL_COVER_INVENTORY": SimpleNamespace(rescan=rescanned.append),
        },
        logger=SimpleNamespace(exception=lambda *_args: None, warning=lambda *_args: None),
        force=True,
        cache_lock=threading.Lock(),
        scan_music_incremental=scan,
        refresh_relation_views=lambda **_options: None,
        start_manual_cover_refresh=lambda **_options: {},
        start_background_cover_refresh=lambda: None,
    )

    assert state["scan_outcome"] == "completed"
    assert rescanned == [[roots[0]["path"]]], "exactly the readable root's folders are rebuilt"


@pytest.mark.parametrize("unreadable", ["away", "incomplete"])
@pytest.mark.parametrize("first_attempt_fails", [False, True])
def test_a_full_rescan_keeps_an_unreadable_roots_stored_folders_and_survives_a_failure(
    tmp_path, monkeypatch, unreadable, first_attempt_fails,
):
    library = _seed_library(tmp_path, 3)
    worker, tables = library.worker, library.tables
    invalidate_all, attempts = worker.repository.invalidate_all, []

    def attempt(*args, **kwargs):
        attempts.append(True)
        if first_attempt_fails and len(attempts) == 1:
            raise RuntimeError("database unavailable")
        return invalidate_all(*args, **kwargs)

    monkeypatch.setattr(worker.repository, "invalidate_all", attempt)
    worker._logger = SimpleNamespace(exception=lambda *_args: None)

    _scan(monkeypatch, library, {}, full_rescan=True, **{unreadable: "extra"})
    worker._retry_scheduled_invalidation()

    kept = root_key(library.roots[1]["path"]) + os.sep
    assert len(attempts) == (2 if first_attempt_fails else 1), "a failed Full Rescan is not lost"
    for key, row in tables.listings.items():
        assert (row["revision"] == 1) is key.startswith(kept), key
    for row in tables.contexts.values():
        if row["paths"][0].startswith(kept):
            assert row["root"] and row["revision"] == 1, "unavailable storage keeps its stored cover folder"
        else:
            assert row["root"] is None and row["revision"] == 2


@pytest.mark.parametrize(("change", "relisted"), [
    ("scan finds nothing changed", 0),
    ("scan without a recorded check time", 0),
    ("scan finds an image the watcher missed", 1),
    ("scan finds an overwritten image", 1),
    ("scan finds a removed track", 1),
    ("root added", 0),
    ("root changed", 0),
    ("root removed", 0),
    ("nested root removed", 0),
    ("roots saved unchanged", 0),
    ("root deleted", 0),
    ("root moved", 0),
    ("drive gone", 0),
    ("open of an album under a removed root", 0),
    ("open of an album whose folder boundary moved", 0),
    ("open of an album whose folder is unchanged", 0),
    ("watcher reports an image", 1),
    ("watcher reports a removed track", 1),
    ("watcher reports a moved folder", 1),
    ("removal while a Full Rescan's queue waits", 1),
    ("restart over a stale backlog", 0),
])
def test_local_cover_inventory_contract_relists_only_changed_folders_at_production_library_size(
    tmp_path, monkeypatch, change, relisted,
):
    from tests.py.bounded_interactions import _checked_in_entries

    def run(album_count: int) -> OperationCounts:
        library = _seed_library(tmp_path / str(album_count), album_count)
        album, tables, worker = library.album, library.tables, library.worker
        checked_at = {} if "without" in change else {root["id"]: time.time() - 3600 for root in library.roots}
        moved = album.with_name("Album moved")
        if change == "scan finds an image the watcher missed":
            shutil.copy2(album / "cover.jpg", album / "back.jpg")
        elif change == "scan finds an overwritten image":
            (album / "cover.jpg").write_bytes(b"replaced in place")
        elif change in ("scan finds a removed track", "watcher reports a removed track"):
            (album / "02.mp3").unlink()
        elif change == "watcher reports a moved folder":
            album.rename(moved)

        if change.startswith("scan"):
            _scan(monkeypatch, library, checked_at)
        elif change in _ROOT_CHANGES:
            _change_roots(monkeypatch, library, _changed_roots(library, change))
        elif change in _ROOT_LEVEL_EVENTS:
            main = Path(library.roots[0]["path"])
            gone = {"root deleted": [main], "root moved": [main, main.parent], "drive gone": [main.parent]}[change]
            worker.invalidate_paths(gone, subtree_paths=gone, context_changed=True)
        elif change.startswith("open"):
            opened, shown = _open_album(library, change)
        elif change == "watcher reports an image":
            worker.invalidate_paths([str(album / "cover.jpg")])
        elif change == "watcher reports a removed track":
            worker.invalidate_paths([str(album / "02.mp3")], context_changed=True)
        elif change == "watcher reports a moved folder":
            worker.invalidate_paths([album, moved], subtree_paths=[album, moved], context_changed=True)
        elif change.startswith("removal while"):
            worker.rescan([root["path"] for root in library.roots])
            for row in list(tables.contexts.values()):
                worker.request_context(row["paths"])
            tables.written = tables.values_sent = 0
            revisions = {key: row["revision"] for key, row in tables.listings.items()}
            counts = OperationCounts()
            with count_filesystem_and_media(monkeypatch, counts):
                worker.invalidate_paths([str(album / "02.mp3")], context_changed=True)
            counts.affected_rows, counts.candidate_rows = tables.written, tables.values_sent
            assert sum(row["revision"] != revisions[key] for key, row in tables.listings.items()) == relisted
            return counts
        else:
            for row in (*tables.listings.values(), *tables.contexts.values()):
                row["revision"] += 1
            for row in list(tables.contexts.values())[1:]:
                row["root"] = None
            worker = LocalCoverInventoryWorker(library.config, repository=worker.repository, logger=worker._logger)
            tables.statements = 0

        restarted = change.startswith("restart")
        invalidated = [] if restarted else [key for key, row in tables.listings.items() if row["revision"] > 1]
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            _drain(monkeypatch, library, worker)
        counts.affected_rows = tables.written
        assert len(invalidated) == relisted, invalidated
        assert sorted(set(tables.listed)) == sorted(invalidated), "only the changed folders are listed again"
        if change in _ROOT_CHANGES | _ROOT_LEVEL_EVENTS or change.endswith("folder is unchanged"):
            assert tables.written == 0, "a root change, a root-level event or an unchanged open writes nothing"
        if change.startswith("open"):
            assert tables.contexts[opened]["root"] == shown, "the open ends with the right folder, or none"
            others = [row for key, row in tables.contexts.items() if key != opened]
            assert all(row["revision"] == 1 and row["root"] for row in others), "an open writes only its own rows"
        assert tables.album_walk_steps == 0, "nothing walks the library's albums"
        if restarted:
            assert tables.statements == 0, "an idle poll reads nothing, whatever backlog is stored"
        return counts

    entry = _checked_in_entries()[_WORKER]
    growth = entry["growth"]
    measure_scale_pair(
        interaction_id=_WORKER,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=run,
        budgets=entry["budgets"],
        growth=(growth["metric"], growth["largeMinusSmallMax"]),
    )
