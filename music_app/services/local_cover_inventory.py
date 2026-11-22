"""One album's stored local-art listing, for Cover Look Up to show at once.

Ported from #65's local cover inventory (0125, same table) without its library-wide paths. An open reads that
album's folders by primary key, shows them, and queues those folders alone for a refresh, so a change nobody
reported heals on the next open. Nothing here polls Postgres, walks the library, or runs at start (owner's
large-data rule; freeze guard backlog case 50).
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Iterable
import logging
import os
from pathlib import Path
import threading

from psycopg.types.json import Jsonb

from music_app.services.postgres_connections import pooled_connection

LIBRARY_ID_SQL = """select libraries.id from library.libraries as libraries
join app.bootstrap_owners as owners on owners.account_id = libraries.owner_account_id
where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'
and libraries.library_kind = 'local' limit 1"""

STORAGE_UNAVAILABLE = "Local artwork could not be read. Showing the last known covers."
# An open queues one folder per copy of its album; past this, the oldest waiting folder waits for its next open.
QUEUE_LIMIT = 32


def root_key(root: Path | str) -> str:
    return os.path.normcase(os.path.normpath(str(root)))


class LocalCoverInventoryRepository:
    def __init__(self, config, *, connect=None):
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._connect = connect

    def _connection(self):
        if not self._database_url:
            raise RuntimeError("Postgres is required for local cover inventory.")
        return self._connect(self._database_url) if self._connect else pooled_connection(
            self._database_url, workload="cover_inventory"
        )

    def get(self, roots: Iterable[Path | str]) -> dict[str, dict[str, object]]:
        keys = sorted({root_key(root) for root in roots})
        if not keys:
            return {}
        with self._connection() as connection:
            rows = connection.execute(
                f"""select root_path, candidates, error, revision, indexed_revision > 0 as available,
                    indexed_revision = revision as complete from library.local_cover_inventories
                    where library_id = ({LIBRARY_ID_SQL}) and root_path = any(%(roots)s::text[])""",
                {"roots": keys},
            ).fetchall()
        return {row["root_path"]: dict(row) for row in rows}

    def publish(self, root, candidates, *, expected_revision: int | None) -> bool:
        """Store a listing unless another writer changed it since `expected_revision` was read."""
        if expected_revision is None:
            sql = f"""insert into library.local_cover_inventories
                (library_id, root_path, candidates, indexed_revision, updated_at)
                select ({LIBRARY_ID_SQL}), %(root)s, %(candidates)s, 1, now()
                on conflict (library_id, root_path) do nothing returning root_path"""
        else:
            sql = f"""update library.local_cover_inventories set candidates = %(candidates)s,
                revision = revision + 1, indexed_revision = revision + 1, updated_at = now(),
                retry_after = null, error = null, foreground_requested = false
                where library_id = ({LIBRARY_ID_SQL}) and root_path = %(root)s
                and revision = %(revision)s returning root_path"""
        with self._connection() as connection:
            row = connection.execute(
                sql, {"root": root_key(root), "candidates": Jsonb(candidates), "revision": expected_revision},
            ).fetchone()
            connection.commit()
        return row is not None

    def mark_unreadable(self, root) -> None:
        """Say the folder cannot be read; the last known listing stays."""
        with self._connection() as connection:
            connection.execute(
                f"""insert into library.local_cover_inventories as inventory (library_id, root_path, error)
                    select ({LIBRARY_ID_SQL}), %(root)s, %(error)s
                    on conflict (library_id, root_path) do update set error = excluded.error
                    where inventory.error is distinct from excluded.error""",
                {"root": root_key(root), "error": STORAGE_UNAVAILABLE},
            )
            connection.commit()


def discover_local_cover_inventory(root, config, *, previous=(), cancel_requested=None):
    """A folder's images. Only new or changed files are decoded and hashed."""
    from music_app.services import cover_state, covers

    # Rows are stored by case-folded key; scan from the folder's real spelling so listed paths match the album's
    # own paths. realpath also follows junctions, so it is used only when it names the same folder.
    real_root = os.path.realpath(str(root))
    if root_key(real_root) == root_key(root):
        root = real_root
    known = {root_key(item["path"]): item for item in previous if item.get("path")}
    stats, unchanged = {}, {}

    def dimensions(path: Path):
        stats[str(path)] = stat = path.stat()
        before = known.get(root_key(path))
        if before and before.get("sha256") and (before.get("size"), before.get("mtime_ns")) == (stat.st_size, stat.st_mtime_ns):
            unchanged[str(path)] = before
            return before.get("width") or 0, before.get("height") or 0
        return covers.image_dimensions(path)

    candidates = cover_state.iter_local_cover_candidates(
        Path(root), image_extensions=set(config["IMAGE_EXTENSIONS"]),
        image_dimensions=dimensions,
        is_squareish_cover=lambda width, height: width > 0 and height > 0 and abs(width - height) / max(width, height) <= 0.18,
        active_cover_path=None,
        cancel_requested=cancel_requested,
        require_readable=True,
    )
    for candidate in candidates:
        path = candidate["path"]
        candidate.update(size=stats[path].st_size, mtime_ns=stats[path].st_mtime_ns)
        candidate["sha256"] = (
            unchanged[path]["sha256"] if path in unchanged
            else cover_state._file_sha256(Path(path), cancel_requested=cancel_requested)
        )
    return candidates


class LocalCoverInventoryWorker:
    """One background folder reader, fed only by opens and the app's own cover saves and deletes."""

    def __init__(self, config, *, repository=None, logger=None):
        self.config = config
        self.repository = repository or LocalCoverInventoryRepository(config)
        self._logger = logger or logging.getLogger("music_app")
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._queue_lock = threading.Lock()
        self._queue: OrderedDict[str, Path] = OrderedDict()
        self._thread = None

    def request(self, root) -> None:
        key = root_key(root)
        with self._queue_lock:
            self._queue.pop(key, None)
            self._queue[key] = Path(root)
            if len(self._queue) > QUEUE_LIMIT:
                self._queue.popitem(last=False)
        self._wake.set()

    def take_next(self) -> Path | None:
        """The folder opened last: it is the one on screen."""
        with self._queue_lock:
            return self._queue.popitem()[1] if self._queue else None

    def refresh(self, root) -> None:
        key = root_key(root)
        row = self.repository.get([root]).get(key)
        stored = list((row or {}).get("candidates") or [])
        try:
            found = discover_local_cover_inventory(
                root, self.config, previous=stored, cancel_requested=self._stop.is_set,
            )
        except InterruptedError:
            return
        except OSError:
            self.repository.mark_unreadable(root)
            return
        if row and row.get("complete") and not row.get("error") and found == stored:
            return
        if not self.repository.publish(root, found, expected_revision=row["revision"] if row else None):
            self.request(root)

    def remove_path(self, root, path) -> None:
        """Drop a cover the app deleted from its album's listing at once."""
        row = self.repository.get([root]).get(root_key(root))
        if row and row.get("available"):
            kept = [item for item in row["candidates"] if root_key(item["path"]) != root_key(path)]
            if self.repository.publish(root, kept, expected_revision=row["revision"]):
                return
        self.request(root)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="albumhaven-local-cover-inventory", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(30)
            if self._thread.is_alive():
                raise TimeoutError("Local cover inventory worker did not stop in time.")

    async def stop(self) -> None:
        await asyncio.to_thread(self.close)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait()
            self._wake.clear()
            while not self._stop.is_set() and (root := self.take_next()) is not None:
                try:
                    self.refresh(root)
                except Exception:
                    self._logger.exception("Local cover inventory refresh failed.")
