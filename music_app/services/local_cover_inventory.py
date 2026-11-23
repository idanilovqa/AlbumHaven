"""One album's stored local-art listing, for Cover Look Up to show at once.

Ported from #65's local cover inventory (0125, same table) without its library-wide paths. An open reads that
album's folders by primary key and shows them; its follow-up read, and each of the app's cover writes, refreshes
those folders alone, so a change nobody reported heals on the next open. A walk gets its own short-lived thread,
so a hung drive can hold a walk but never a request or a save. Nothing polls Postgres, walks the library or runs
at start (owner's large-data rule; freeze guard backlog case 50).
"""
from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterable
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
import logging
import os
from pathlib import Path
import threading
from time import monotonic

from psycopg.types.json import Jsonb

from music_app.services.postgres_connections import pooled_connection

LIBRARY_ID_SQL = """select libraries.id from library.libraries as libraries
join app.bootstrap_owners as owners on owners.account_id = libraries.owner_account_id
where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'
and libraries.library_kind = 'local' limit 1"""

STORAGE_UNAVAILABLE = "Local artwork could not be read. Showing the last known covers."
STORAGE_SLOW = "Local artwork is taking too long to read. Showing the last known covers."
# Folders read at the same time, whatever number of albums are opened.
WALK_LIMIT = 4
# Opens waiting for a walk; past this an open answers with what is stored. A write's walk is never refused.
WAITING_LIMIT = 32
WALK_WAIT_SECONDS = 8.0
CLOSE_WAIT_SECONDS = 3.0


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


def discover_local_cover_inventory(root, config, *, previous=()):
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
        require_readable=True,
    )
    for candidate in candidates:
        path = candidate["path"]
        candidate.update(size=stats[path].st_size, mtime_ns=stats[path].st_mtime_ns)
        candidate["sha256"] = (
            unchanged[path]["sha256"] if path in unchanged
            else cover_state._file_sha256(Path(path))
        )
    return candidates


class LocalCoverInventory:
    """An album's listings for the gallery and the cover writers. Every walk is asked for by one of them."""

    def __init__(self, config, *, repository=None, logger=None):
        self.config = config
        self.repository = repository or LocalCoverInventoryRepository(config)
        self._logger = logger or logging.getLogger("music_app")
        self._lock = threading.Lock()
        self._closed = False
        self._walking: dict[str, Future] = {}
        self._waiting: OrderedDict[str, tuple[Path, Future]] = OrderedDict()

    def stored(self, roots) -> dict[str, dict[str, object]]:
        if self._closed:
            return {}
        try:
            return self.repository.get(roots)
        except Exception:
            self._logger.exception("Could not read stored local cover listings.")
            return {}

    def listed_roots(self, album_root: Path, copy_roots: Iterable[Path], track_paths: set[str]) -> list[Path]:
        """The folders the gallery lists for an album. A writer asks before it commits."""
        from music_app.services.cover_workflow import restrict_album_root_to_represented_disc

        return [restrict_album_root_to_represented_disc(album_root, track_paths), *copy_roots]

    def album_listings(
        self, roots: list[Path], track_paths: set[str], *, stored_first: bool,
    ) -> tuple[list[tuple[Path, dict[str, object]]], bool]:
        """The album's listings, and whether they are the stored ones that a follow-up read replaces."""
        from music_app.services.cover_workflow import is_disc_like_folder

        covered = [root_key(root) for root in roots]
        # A copy whose files are away resolves to no folder, so it is looked up by its tracks' folders.
        # Paths are compared as written: resolving one asks the drive.
        unresolved: dict[str, Path] = {}
        for track_path in track_paths:
            folder = Path(track_path).parent
            key = root_key(folder)
            if any(key == root or key.startswith(root.rstrip(os.sep) + os.sep) for root in covered):
                continue
            for candidate in (folder, folder.parent) if is_disc_like_folder(folder) else (folder,):
                unresolved[root_key(candidate)] = candidate
        rows = self.stored([*roots, *unresolved.values()]) if stored_first or unresolved else {}
        shown = [*roots, *(folder for key, folder in unresolved.items() if (rows.get(key) or {}).get("available"))]
        if stored_first and all((rows.get(root_key(root)) or {}).get("available") for root in shown):
            return [(root, rows[root_key(root)]) for root in shown], True
        return self.read_folders(shown), False

    def read_folders(self, roots, *, after_write: bool = False) -> list[tuple[Path, dict[str, object]]]:
        """Read an album's folders within one bounded wait; a folder that is late keeps its stored covers."""
        walks = [(root, self._ask(root, after_write=after_write)) for root in roots]
        deadline = monotonic() + WALK_WAIT_SECONDS
        listings = []
        for root, walk in walks:
            listing = None
            if walk is not None:
                try:
                    listing = walk.result(timeout=max(0.0, deadline - monotonic()))
                except FutureTimeoutError:
                    listing = None
            listings.append((root, listing or self._kept(root, STORAGE_SLOW)))
        return listings

    def refresh(self, root, *, after_write: bool = False) -> dict[str, object]:
        return self.read_folders([root], after_write=after_write)[0][1]

    def after_write(self, album_root, track_paths, *, removed=None) -> None:
        """Follow a committed write without asking the drive, waiting on it or failing the write.

        The album's stored folders are found by key from its paths as written. A removed cover leaves them now,
        and each gets a walk that begins after the write, which the album's next read waits for.
        """
        try:
            from music_app.services.cover_workflow import is_disc_like_folder

            folders: dict[str, Path] = {}
            for track_path in track_paths:
                folder = Path(track_path).parent
                # A disc's album is its parent; any other parent (an artist folder, a library root) is not this album.
                for candidate in (folder, folder.parent) if is_disc_like_folder(folder) else (folder,):
                    folders.setdefault(root_key(candidate), candidate)
            if album_root is not None:
                folders[root_key(album_root)] = Path(album_root)
            rows = self.stored(folders.values())
            with self._lock:
                listed = [key for key in folders if key in rows or key in self._walking or key in self._waiting]
            for key in listed:
                if removed is not None:
                    self._drop(folders[key], removed)
                self._ask(folders[key], after_write=True)
        except Exception:
            self._logger.exception("Could not update the local cover listing after a cover write.")

    def close(self) -> None:
        """Refuse new walks, answer waiting ones and give running ones a bounded time. The pool is then left alone."""
        with self._lock:
            self._closed = True
            waiting, self._waiting = list(self._waiting.values()), OrderedDict()
            running = list(self._walking.values())
        for _root, walk in waiting:
            walk.set_result(None)
        deadline = monotonic() + CLOSE_WAIT_SECONDS
        for walk in running:
            try:
                walk.result(timeout=max(0.0, deadline - monotonic()))
            except FutureTimeoutError:
                self._logger.warning("A local cover folder was still being read at shutdown.")

    def _kept(self, root, error: str) -> dict[str, object]:
        row = self.stored([root]).get(root_key(root)) or {}
        return {"candidates": list(row.get("candidates") or []), "error": error}

    def _drop(self, root, path) -> None:
        for _attempt in range(3):
            row = self.stored([root]).get(root_key(root))
            stored = list((row or {}).get("candidates") or [])
            kept = [item for item in stored if root_key(item["path"]) != root_key(path)]
            if len(kept) == len(stored) or self.repository.publish(root, kept, expected_revision=row["revision"]):
                return

    def _ask(self, root, *, after_write: bool) -> Future | None:
        key = root_key(root)
        with self._lock:
            if self._closed:
                return None
            waiting = self._waiting.get(key)
            if waiting:
                return waiting[1]  # Not started: it sees everything written so far.
            if not after_write:
                if key in self._walking:
                    return self._walking[key]
                if len(self._waiting) >= WAITING_LIMIT:
                    return None
            walk = Future()
            self._waiting[key] = (Path(root), walk)
            self._start_waiting_walks()
            return walk

    def _start_waiting_walks(self) -> None:
        for key, (root, walk) in list(self._waiting.items()):
            if len(self._walking) >= WALK_LIMIT:
                return
            if key in self._walking:
                continue
            del self._waiting[key]
            self._walking[key] = walk
            threading.Thread(
                target=self._walk, args=(root, key, walk), name="albumhaven-local-cover-walk", daemon=True,
            ).start()

    def _walk(self, root: Path, key: str, walk: Future) -> None:
        listing = None
        try:
            listing = self._refresh(root, key)
        except Exception:
            self._logger.exception("Could not read a local cover folder.")
            listing = self._kept(root, STORAGE_UNAVAILABLE)
        finally:
            # The walk leaves the map before it completes: nobody who asks afterwards is handed its answer.
            with self._lock:
                del self._walking[key]
                self._start_waiting_walks()
            walk.set_result(listing)

    def _refresh(self, root, key: str) -> dict[str, object]:
        found: list[dict[str, object]] = []
        for _attempt in range(3):
            row = self.stored([root]).get(key)
            stored = list((row or {}).get("candidates") or [])
            try:
                found = discover_local_cover_inventory(root, self.config, previous=stored)
            except OSError:
                try:
                    if not self._closed:
                        self.repository.mark_unreadable(root)
                except Exception:
                    self._logger.exception("Could not record an unreadable local cover folder.")
                return {"candidates": stored, "error": STORAGE_UNAVAILABLE}
            if self._closed or (row and row.get("complete") and not row.get("error") and found == stored):
                break
            try:
                if self.repository.publish(root, found, expected_revision=row["revision"] if row else None):
                    break
            except Exception:
                self._logger.exception("Could not store a local cover listing.")
                break
        return {"candidates": found, "error": None}
