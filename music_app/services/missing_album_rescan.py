"""Re-scan one missing album: restore it where it was, find it where it moved, or say why it is missing."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from time import monotonic

from music_app.services.library_event_coordinator import TargetedMove, TargetedReconciliationRequest
from music_app.services.library_reachability import (
    MISSING_UNREACHABLE,
    folder_is_readable,
    missing_reason_for_path,
)
from music_app.services.missing_album_removal_postgres import MissingAlbumNotFound, _connect, _row_mapping
from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

RESTORED = "restored"
MOVED = "moved"
MISSING = "missing"
SEARCHING = "searching"
_DEFAULT_SEARCH_SECONDS = 15.0


class MissingAlbumSearches:
    """One background search per missing album; a second Re-scan joins the one running.

    Results are kept for the album's next poll; shutdown stops every search without a result."""

    def __init__(self, *, start: Callable[[str, Callable[[], dict[str, object]]], None] | None = None) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, object]] = {}
        self._done: dict[str, threading.Event] = {}
        self._threads: list[threading.Thread] = []
        self.stopping = threading.Event()
        self._start = start

    def start(self, album_key: str, run: Callable[[], dict[str, object]]) -> dict[str, object]:
        with self._lock:
            if self._jobs.get(album_key, {}).get("status") == SEARCHING or self.stopping.is_set():
                return {"status": SEARCHING}
            self._jobs[album_key] = {"status": SEARCHING}
            self._done[album_key] = threading.Event()
        if self._start is not None:
            self._start(album_key, run)
            return {"status": SEARCHING}
        thread = threading.Thread(target=self._run, args=(album_key, run), name="albumhaven-missing-album-search", daemon=True)
        with self._lock:
            self._threads = [alive for alive in self._threads if alive.is_alive()] + [thread]
        thread.start()
        return {"status": SEARCHING}

    def _run(self, album_key: str, run: Callable[[], dict[str, object]]) -> None:
        result: dict[str, object] | None
        try:
            result = run()
        except Exception:
            logging.getLogger("music_app").exception("Missing album search failed.")
            result = {"status": MISSING, "reason": MISSING_UNREACHABLE}
        with self._lock:
            if self.stopping.is_set() or result is None:
                self._jobs.pop(album_key, None)
            else:
                self._jobs[album_key] = result
            done = self._done.get(album_key)
        if done is not None:
            done.set()

    def result(self, album_key: str) -> dict[str, object] | None:
        with self._lock:
            job = self._jobs.get(album_key)
            return dict(job) if job is not None else None

    def wait(self, album_key: str, timeout: float) -> bool:
        with self._lock:
            done = self._done.get(album_key)
        return done.wait(timeout) if done is not None else True

    def stop(self, timeout: float = 30.0) -> None:
        self.stopping.set()
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join(timeout)


class MissingAlbumRescan:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        reconcile: Callable[[TargetedReconciliationRequest], object],
        roots: list[Mapping[str, object]],
        connect: Callable[[str], object] | None = None,
        search_seconds: float = _DEFAULT_SEARCH_SECONDS,
        searches: MissingAlbumSearches | None = None,
    ) -> None:
        self._config = config
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._reconcile = reconcile
        self._roots = {
            str(root.get("id") or "").strip(): Path(str(root.get("path") or ""))
            for root in roots
            if str(root.get("id") or "").strip() and str(root.get("path") or "").strip()
        }
        self._connect = connect or _connect
        self._search_seconds = search_seconds
        self._searches = searches

    def rescan(self, album_key: str) -> dict[str, object]:
        """Look the album up where it was and where a move to another root puts it; list no folder.

        Found nowhere, the walk of the library runs in the background (``searches``), and the
        answer is ``searching``. Without ``searches`` it runs here, as before (used by tests)."""
        files = self._album_files(album_key)
        if not files:
            raise MissingAlbumNotFound()
        root_id = str(files[0]["root_id"] or "")
        paths = [Path(str(row["private_path"])) for row in files]
        album_dir = Path(os.path.commonpath([str(path.parent) for path in paths]))
        if any(path.is_file() for path in paths):
            # Present where it was: re-read the folder; files still gone stay missing as deleted.
            return self._publish(RESTORED, TargetedReconciliationRequest(
                root_id=root_id, paths=frozenset({album_dir}), deleted_subtrees=frozenset({album_dir}),
            ))
        moved = self._find_under_other_roots(album_dir, paths)
        if moved is not None:
            return self._restore_moved(root_id, album_dir, paths, moved)
        if self._searches is None:
            return self._search(album_key, root_id, album_dir, paths) or {"status": MISSING, "reason": MISSING_UNREACHABLE}
        return self._searches.start(album_key, lambda: self._search(album_key, root_id, album_dir, paths))

    def _restore_moved(self, root_id: str, album_dir: Path, paths: list[Path], moved: tuple[str, Path]) -> dict[str, object]:
        destination_root_id, destination = moved
        # The tracks follow their files, so ratings, loops and play preferences stay with them.
        self._repoint_tracks(album_dir, destination, destination_root_id, paths)
        return self._publish(MOVED, TargetedReconciliationRequest(
            root_id=destination_root_id,
            moves=(TargetedMove(album_dir, destination, root_id, destination_root_id, is_directory=True),),
        ))

    def _search(self, album_key: str, root_id: str, album_dir: Path, paths: list[Path]) -> dict[str, object] | None:
        """Walk each readable root once within the time cap; None once shutdown stopped it."""
        moved = self._find_moved_folder(album_dir, paths)
        if self._stopping():
            return None
        if moved is not None:
            return self._restore_moved(root_id, album_dir, paths, moved)
        reason = missing_reason_for_path(self._roots.get(root_id), paths[0])
        self._record_reason(album_key, reason)
        return {"status": MISSING, "reason": reason}

    def _stopping(self) -> bool:
        return self._searches is not None and self._searches.stopping.is_set()

    @staticmethod
    def _holds_album(candidate: Path, album_dir: Path, paths: list[Path]) -> bool:
        """At least half of the album's files at the same places below ``candidate``: one check per file."""
        present = sum((candidate / path.relative_to(album_dir)).is_file() for path in paths)
        return present * 2 >= len(paths)

    def _find_under_other_roots(self, album_dir: Path, paths: list[Path]) -> tuple[str, Path] | None:
        """The same relative path under each other configured root, on disk or already recorded there."""
        candidates: list[tuple[str, Path]] = []
        for source_root in self._roots.values():
            try:
                relative = album_dir.relative_to(source_root)
            except ValueError:
                continue
            candidates.extend(
                (root_id, root_path / relative)
                for root_id, root_path in self._roots.items()
                if root_path / relative != album_dir
            )
        if not candidates:
            return None
        for root_id, candidate in candidates:
            if self._holds_album(candidate, album_dir, paths):
                return root_id, candidate
        # A watcher or scan may already have recorded the files at their new place.
        expected = {
            str(candidate / path.relative_to(album_dir)): (root_id, candidate)
            for root_id, candidate in candidates for path in paths
        }
        with self._connect(self._database_url) as connection:
            recorded = [
                str(_row_mapping(row)["private_path"])
                for row in connection.execute(_RECORDED_PATHS_SQL, {"paths": sorted(expected)}).fetchall()
            ]
        for root_id, candidate in candidates:
            if sum(expected.get(path) == (root_id, candidate) for path in recorded) * 2 >= len(paths):
                return root_id, candidate
        return None

    def _publish(self, status: str, request: TargetedReconciliationRequest) -> dict[str, object]:
        result = self._reconcile(request)
        health = str(getattr(result, "health", "healthy") or "healthy")
        if health != "healthy":
            # The watcher refused the change (an unhealthy or unreadable root).
            return {"status": MISSING, "reason": MISSING_UNREACHABLE}
        return {"status": status, "library_revision": int(getattr(result, "revision", 0) or 0)}

    def _find_moved_folder(self, album_dir: Path, paths: list[Path]) -> tuple[str, Path] | None:
        """A folder with the album's folder name holding at least half of its files at the same places.

        Each readable root is walked once, within the search time, and stops at shutdown;
        a candidate folder is checked file by file, never listed."""
        wanted = album_dir.name.casefold()
        deadline = monotonic() + self._search_seconds
        readable = {root_id: path for root_id, path in self._roots.items() if folder_is_readable(path)}
        for root_id, root_path in readable.items():
            for dirpath, dirnames, _filenames in os.walk(root_path):
                if monotonic() > deadline or self._stopping():
                    return None
                dirnames[:] = [name for name in dirnames if not name.startswith(".")]
                for name in dirnames:
                    candidate = Path(dirpath) / name
                    if name.casefold() == wanted and candidate != album_dir and self._holds_album(candidate, album_dir, paths):
                        return root_id, candidate
        return None

    def _repoint_tracks(self, album_dir: Path, destination: Path, destination_root_id: str, paths: list[Path]) -> None:
        """Give each moved file's track and file rows its new path before the folder is re-read."""
        root = self._roots[destination_root_id]
        moves = [
            (str(path), str(target), str(target.relative_to(root)))
            for path in paths
            if (target := destination / path.relative_to(album_dir)).is_file()
        ]
        if not moves:
            return
        old, new, relative = (list(column) for column in zip(*moves))
        with self._connect(self._database_url) as connection:
            connection.execute(inventory_publication_advisory_lock_sql())
            repointed = connection.execute(_REPOINT_SQL, {
                "old": old, "new": new, "relative": relative, "root_id": destination_root_id,
            }).rowcount
        if repointed:
            self._hand_journaled_albums_to_owner()

    def _album_files(self, album_key: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(_ALBUM_FILES_SQL, {"album_key": album_key}).fetchall()]

    def _record_reason(self, album_key: str, reason: str) -> None:
        with self._connect(self._database_url) as connection:
            recorded = connection.execute(_RECORD_REASON_SQL, {"album_key": album_key, "reason": reason}).rowcount
        if recorded:
            self._hand_journaled_albums_to_owner()

    def _hand_journaled_albums_to_owner(self) -> None:
        """The committed rows journal their album for relations (migration 0108); the keyed drain owns it."""
        from music_app.services.gallery_projection_postgres import queue_journaled_relation_drain

        queue_journaled_relation_drain(self._config)


_ALBUM_FILES_SQL = """
    select files.private_path,
           coalesce(nullif(roots.metadata ->> 'root_id', ''), files.metadata ->> 'library_root_id') as root_id
    from library.local_albums albums
    join library.local_tracks tracks on tracks.album_id = albums.id
    join library.local_track_files files on files.track_id = tracks.id
    left join library.library_roots roots on roots.id = files.library_root_id
    join app.bootstrap_owners owners on owners.owner_key = 'local-bootstrap-owner'
    join library.libraries libraries
      on libraries.id = albums.library_id and libraries.owner_account_id = owners.account_id
     and libraries.name = 'Local Library' and libraries.library_kind = 'local'
    where albums.album_key = %(album_key)s
    order by files.private_path
"""

# A destination already published as its own track (a scan found the copy first) is left alone.
_REPOINT_SQL = """
    with moved as (
      select old_path, new_path, relative_path
      from unnest(%(old)s::text[], %(new)s::text[], %(relative)s::text[]) as m(old_path, new_path, relative_path)
      where not exists (select 1 from library.local_track_files existing where existing.private_path = m.new_path)
    ),
    destination as (
      select roots.id from library.library_roots roots where roots.metadata ->> 'root_id' = %(root_id)s limit 1
    ),
    tracks as (
      update library.local_tracks
         set track_key = moved.new_path
        from moved
       where library.local_tracks.track_key = moved.old_path
         and not exists (
           select 1 from library.local_tracks existing
           where existing.library_id = library.local_tracks.library_id and existing.track_key = moved.new_path)
      returning library.local_tracks.id
    )
    update library.local_track_files
       set private_path = moved.new_path,
           relative_path = moved.relative_path,
           library_root_id = coalesce((select id from destination), library.local_track_files.library_root_id)
      from moved
     where library.local_track_files.private_path = moved.old_path
"""

# The unique private_path index answers this; it reads only the paths asked for.
_RECORDED_PATHS_SQL = """
    select files.private_path
    from library.local_track_files files
    where files.private_path = any(%(paths)s::text[]) and not files.scan_cache_stale
"""

# Only rows whose reason changed are rewritten.
_RECORD_REASON_SQL = """
    update library.local_track_files files
       set metadata = jsonb_set(files.metadata, '{scan_cache}',
             coalesce(files.metadata -> 'scan_cache', '{}'::jsonb)
               || jsonb_build_object('missing_reason', %(reason)s::text, 'missing_checked_at', now()::text))
    from library.local_tracks tracks
    join library.local_albums albums on albums.id = tracks.album_id
    where files.track_id = tracks.id and albums.album_key = %(album_key)s
      and files.scan_cache_stale
      and files.metadata #>> '{scan_cache,missing_reason}' is distinct from %(reason)s::text
"""
