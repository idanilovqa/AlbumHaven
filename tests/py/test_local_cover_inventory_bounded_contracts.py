"""Bounded-interaction contract for the local cover inventory.

A scan, a live root change and a watcher event each re-list only the folders they
changed. The real scan, root-change wiring, repository and worker run over real
folders; only the two inventory tables are an in-memory stand-in that counts the
rows each statement writes.
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


class _InventoryTables:
    """The two inventory tables, answering the repository's statements."""

    def __init__(self):
        self.listings: dict[str, dict[str, object]] = {}
        self.contexts: dict[str, dict[str, object]] = {}
        self.written = 0
        self.idle = False

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
        sql = " ".join(str(query).split())
        rows = self._answer(sql, params or {})
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
        if "with pending as (select library_id, context_key" in sql:
            for key, row in self.contexts.items():
                if not row["root"] and not row["claimed"]:
                    self.idle = False
                    self._write(row, claimed=True)
                    return [{"context_key": key, "track_paths": row["paths"], "revision": row["revision"],
                             "foreground_requested": False}]
            self.idle = True
            return []
        if "with pending as (select library_id, root_path" in sql:
            for key, row in self.listings.items():
                if row["indexed"] < row["revision"] and not row["claimed"]:
                    self.idle = False
                    self._write(row, claimed=True)
                    return [{"root_path": key, "revision": row["revision"], "foreground_requested": False}]
            return []
        if "with next_album as" in sql:
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
        if "update library.local_cover_inventory_contexts set error" in sql or "retry_after = now() + %(delay)s" in sql:
            self.written += 1  # a deferral: the row stays claimed, so this run does not retry it
            return []
        if "update library.local_cover_inventories set revision = revision + 1" in sql:
            return self._invalidate_listings(params)
        if "set root_path = null" in sql:
            return self._invalidate_contexts(params)
        raise AssertionError(f"unexpected inventory statement: {sql}")

    def _invalidate_listings(self, params) -> list[dict[str, object]]:
        changed = []
        for key, row in self.listings.items():
            if params and key not in params["roots"] and not key.startswith(tuple(params["prefixes"])):
                continue
            self._write(row, revision=row["revision"] + 1, claimed=False)
            changed.append({"root_path": key})
        return changed

    def _invalidate_contexts(self, params) -> list[dict[str, object]]:
        changed = []
        for key, row in self.contexts.items():
            root = row["root"]
            if params:
                if root:
                    prefixes = (*params["prefixes"], *params.get("disc_prefixes", ()))
                    affected = root in params["roots"] or root.startswith(prefixes)
                else:
                    affected = any(path.startswith(tuple(params["context_prefixes"])) for path in row["paths"])
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
        "IMAGE_EXTENSIONS": {".jpg"}, "CACHE_PATH": base / "cache", "CACHE_MAX_AGE_SECONDS": 0,
        "_library_root_paths_snapshot": tuple(Path(root["path"]) for root in roots),
    }
    worker = LocalCoverInventoryWorker(
        config, repository=LocalCoverInventoryRepository(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://inventory.invalid/contract"}, connect=lambda _url: tables,
        ),
    )
    return SimpleNamespace(
        roots=roots, album=albums[0], file_cache=file_cache, tables=tables, config=config, worker=worker,
    )


def _scan(monkeypatch, library, checked_at: dict[str, float]) -> None:
    class Adapter:
        def load_snapshot(self, _cache_path, _identity):
            return {}, 0.0, {}, 0.0, None

        def load_cover_inventory_checked_at(self):
            return dict(checked_at)

    monkeypatch.setattr(scan_state, "_scan_cache_adapter", lambda _config: Adapter())
    monkeypatch.setattr(scan_state, "load_separate_release_keys", lambda _config: set())
    monkeypatch.setattr(scan_state, "library_root_cache_identity", lambda _config: "roots")
    monkeypatch.setattr(scan_state, "resolve_media_host_history_scope", lambda _config: None)
    monkeypatch.setattr(scan_state, "log_app_event", lambda *_args, **_kwargs: None)
    state = {
        "file_cache": dict(library.file_cache), "albums": [], "last_scan": time.time() - 3600,
        "relation_views": {"artists": ["Artist"]}, "scan_generation": 0,
    }

    def scan(*, publication_state, **options):
        publication_state["observed_library_root_ids"] = {root["id"] for root in library.roots}
        return library_indexing.scan_library_file_cache(
            state, roots=[Path(root["path"]) for root in library.roots], root_definitions=library.roots,
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


def _drain(monkeypatch, library) -> None:
    """Run the real worker, idle long enough for background work, until nothing is left."""
    worker = LocalCoverInventoryWorker(library.config, repository=library.worker.repository)
    worker._foreground_at -= 3600
    passes = 0

    def next_pass(_timeout=None):
        nonlocal passes
        passes += 1
        assert passes < 2000, "the inventory worker did not settle"
        settled = library.tables.idle and all(
            row["claimed"] or row["indexed"] >= row["revision"] for row in library.tables.listings.values()
        )
        if settled:
            worker._stop.set()
        return True

    monkeypatch.setattr(worker._wake, "wait", next_pass)
    monkeypatch.setattr(cover_workflow, "get_library_roots", lambda _config: list(library.roots))
    worker._run()


@pytest.mark.parametrize(("change", "relisted"), [
    ("scan finds nothing changed", 0),
    ("scan without a recorded check time", 0),
    ("scan finds an image the watcher missed", 1),
    ("scan finds an overwritten image", 1),
    ("scan finds a removed track", 1),
    ("root removed", 1),
    ("roots saved unchanged", 0),
    ("watcher reports an image", 1),
])
def test_local_cover_inventory_contract_relists_only_changed_folders_at_production_library_size(
    tmp_path, monkeypatch, change, relisted,
):
    from tests.py.bounded_interactions import _checked_in_entries

    def run(album_count: int) -> OperationCounts:
        library = _seed_library(tmp_path / str(album_count), album_count)
        checked_at = {} if "without" in change else {root["id"]: time.time() - 3600 for root in library.roots}
        if change == "scan finds an image the watcher missed":
            shutil.copy2(library.album / "cover.jpg", library.album / "back.jpg")
        elif change == "scan finds an overwritten image":
            (library.album / "cover.jpg").write_bytes(b"replaced in place")
        elif change == "scan finds a removed track":
            (library.album / "02.mp3").unlink()

        if change.startswith("scan"):
            _scan(monkeypatch, library, checked_at)
        elif change == "root removed":
            _change_roots(monkeypatch, library, library.roots[:1])
        elif change == "roots saved unchanged":
            _change_roots(monkeypatch, library, library.roots)
        else:
            library.worker.invalidate_paths([str(library.album / "cover.jpg")])

        listed_before = {key: row["revision"] for key, row in library.tables.listings.items()}
        stale = [key for key, row in library.tables.listings.items() if row["indexed"] < row["revision"]]
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts):
            _drain(monkeypatch, library)
        counts.affected_rows = library.tables.written
        assert len(stale) == relisted, stale
        assert all(row["indexed"] == listed_before[key] for key, row in library.tables.listings.items())
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
