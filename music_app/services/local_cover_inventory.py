from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import threading
import time

from psycopg.types.json import Jsonb

from music_app.services.postgres_connections import pooled_connection


_LIBRARY = """select libraries.id from library.libraries as libraries
join app.bootstrap_owners as owners on owners.account_id = libraries.owner_account_id
where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'
and libraries.library_kind = 'local' limit 1"""


_STORAGE_UNAVAILABLE = "Local artwork storage is unavailable. Checking again shortly."
_RETRY_SECONDS = 30
_UNRESOLVED_FOLDER_RETRY_SECONDS = 3600
# File times are coarse (2 s on FAT), so a scan's check reaches this far behind the last one's start.
_SCAN_CHECK_OVERLAP_SECONDS = 2.0


def root_key(root: Path | str) -> str:
    return os.path.normcase(os.path.normpath(str(root)))


def local_inventory_root_for_tracks(config, track_paths):
    """Read-only discovery folder for an album the strict cover-write resolver declines.

    Albums spread over several folders (disc folders with free-form names, or copies in two
    places) still have local art. Disc folders of one album share their album folder; otherwise
    the folder holding most of the tracks is used. Never a library root or anything above one.
    Returns None when no track file exists (storage really is unavailable) or no folder fits."""
    from collections import Counter

    from music_app.services.library_roots import configured_library_root_paths_snapshot

    roots = [Path(root_key(root)) for root in configured_library_root_paths_snapshot(dict(config))]
    folders = Counter(Path(root_key(path)).parent for path in track_paths if Path(path).is_file())
    if not folders:
        return None

    def below_a_root(folder):
        return any(folder != root and folder.is_relative_to(root) for root in roots)

    parents = {folder.parent for folder in folders}
    if len(folders) > 1 and len(parents) == 1 and below_a_root(next(iter(parents))):
        return next(iter(parents))
    folder = min(folders, key=lambda candidate: (-folders[candidate], str(candidate)))
    return folder if below_a_root(folder) else None


def watch_request_relocates_tracks(request, image_extensions):
    """Whether a watcher batch can change which folder an album's art is in.

    BUGFIX-19 (owner): a rewritten track (tags or embedded art after a save) stays in its folder, so
    it keeps its album's known art folder; only removed or moved tracks, or removed folders, change it."""
    relocated = [*request.deleted_paths, *(path for move in request.moves for path in (move.source, move.destination))]
    return bool(request.deleted_subtrees) or any(
        Path(path).suffix.lower() not in image_extensions for path in relocated
    )


def local_inventory_tracks_exist(track_paths):
    return any(Path(path).is_file() for path in track_paths)


def context_key(paths):
    return hashlib.sha256(json.dumps(sorted({root_key(path) for path in paths})).encode()).hexdigest()


def changed_library_root_paths(previous, current):
    """The roots whose albums can get another art folder: added, removed, re-pathed or with another layout."""
    def rules(roots):
        return {(root_key(root["path"]), str(root.get("layout_mode") or "artist")) for root in roots if root.get("path")}

    return sorted({path for path, _layout in rules(previous) ^ rules(current)})


def _prefix_range(folders):
    """The "C"-order range of every path below each folder: what migration 0292 indexes."""
    prefixes = sorted(folder.rstrip(os.sep) + os.sep for folder in folders)
    return prefixes, [prefix[:-1] + chr(ord(prefix[-1]) + 1) for prefix in prefixes]


class LocalCoverScanCheck:
    """What one library scan saw change in the album art folders, per library root.

    Known limit: an image overwritten in place with its old modification time is not seen."""

    def __init__(self, started_at, checked_at, *, full_rescan=False):
        """``checked_at`` is None when it could not be read: tracks alone are checked and no time advances."""
        self._started_at = started_at
        self._times_unknown = checked_at is None and not full_rescan
        self._checked_at = {} if full_rescan else dict(checked_at or {})
        self._full_rescan = full_rescan
        self._changed = set()

    def changed_since(self, root_id):
        """When to look for changed folders and images from; None looks at track changes only."""
        checked_at = self._checked_at.get(root_id)
        return None if checked_at is None else float(checked_at) - _SCAN_CHECK_OVERLAP_SECONDS

    def note(self, path, root, since, read_stat):
        from music_app.services.generated_preview_storage import is_generated_cover_artifact, is_managed_preview_path

        try:
            if read_stat().st_mtime < since:
                return
        except OSError:
            return  # removed during the walk: its folder's own time records that
        if not is_managed_preview_path(path) and not is_generated_cover_artifact(Path(path), root):
            self._changed.add(str(path))

    def apply(self, worker, *, previous, scanned, readable_root_ids):
        """Invalidate what changed; return each readable root's new check time, or none to check again.

        An empty previous cache says nothing about which tracks changed, so it never means all of them."""
        if not self._full_rescan:
            changed, removed = set(self._changed), []
            for path, entry in previous.items():
                current = scanned.get(path)
                if current is None:
                    if entry.get("library_root_id") in readable_root_ids:
                        removed.append(path)
                elif (entry.get("mtime"), entry.get("size")) != (current.get("mtime"), current.get("size")):
                    changed.add(path)
            if previous:
                changed.update(path for path in scanned if path not in previous)
            if changed and not worker.invalidate_or_retry(sorted(changed)):
                return {}
            if removed and not worker.invalidate_or_retry(removed, context_changed=True):
                return {}
            if self._times_unknown:
                return {}
        return {root_id: self._started_at for root_id in readable_root_ids}


class _WorkQueue:
    """The keys this process was given: by an open, or by a change the watcher, a scan or a root change found.

    Never a stored backlog: after a restart that waits for its album to be opened."""

    def __init__(self):
        self._lock = threading.Lock()
        self._opened = {}
        self._changed = {}
        self._taken = None

    def add(self, keys, *, foreground=False, delay=0.0):
        due = time.monotonic() + delay
        with self._lock:
            for key in keys:
                queued = min(due, self._opened.get(key, due), self._changed.get(key, due))
                if foreground or key in self._opened:
                    self._changed.pop(key, None)
                    self._opened[key] = queued
                else:
                    self._changed[key] = queued

    def _due(self, background):
        now = time.monotonic()
        for pending in (self._opened, self._changed) if background else (self._opened,):
            for key, due in pending.items():
                if due <= now:
                    return pending, key
        return None, None

    def waiting(self, *, background):
        with self._lock:
            return self._due(background)[1] is not None

    def take(self, *, background):
        with self._lock:
            pending, key = self._due(background)
            if key is not None:
                del pending[key]
            self._taken = key
            return key

    def known(self):
        """Every key queued or being worked."""
        with self._lock:
            return sorted({*self._opened, *self._changed, *([self._taken] if self._taken else [])})


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

    @contextmanager
    def work_slot(self):
        # One filesystem reader across all servers sharing this database.
        with self._connection() as connection:
            acquired = bool(connection.execute(
                "select pg_try_advisory_lock(hashtextextended('albumhaven-local-cover-inventory', 0)) as acquired"
            ).fetchone()["acquired"])
            connection.commit()
            try:
                yield acquired
            finally:
                if acquired:
                    try:
                        connection.execute("select pg_advisory_unlock(hashtextextended('albumhaven-local-cover-inventory', 0))")
                        connection.commit()
                    except Exception:
                        connection.close()
                        raise

    def get(self, root):
        with self._connection() as connection:
            row = connection.execute(
                f"""select candidates, error, indexed_revision > 0 as available,
                    indexed_revision = revision as complete from library.local_cover_inventories
                    where library_id = ({_LIBRARY}) and root_path = %(root)s""",
                {"root": root_key(root)},
            ).fetchone()
        return dict(row) if row else None

    def root_for_tracks(self, paths):
        if not paths:
            return None
        with self._connection() as connection:
            row = connection.execute(
                f"""select root_path from library.local_cover_inventory_contexts
                    where library_id = ({_LIBRARY}) and context_key = %(key)s and track_paths = %(paths)s""",
                {"key": context_key(paths), "paths": Jsonb(sorted({root_key(path) for path in paths}))},
            ).fetchone()
        return Path(row["root_path"]) if row and row["root_path"] else None

    def request_context(self, paths, *, foreground=True):
        with self._connection() as connection:
            row = connection.execute(
                f"""insert into library.local_cover_inventory_contexts
                    (library_id, context_key, track_paths, foreground_requested)
                    select ({_LIBRARY}), %(key)s, %(paths)s, %(foreground)s
                    on conflict (library_id, context_key) do update set foreground_requested =
                    library.local_cover_inventory_contexts.foreground_requested or excluded.foreground_requested,
                    retry_after = case
                        -- An open retries an unresolved folder's hour-long deferral once it is {_RETRY_SECONDS} s old;
                        -- a claim and the short deferral are never that far ahead.
                        when excluded.foreground_requested
                          and library.local_cover_inventory_contexts.retry_after > now() + interval '{_RETRY_SECONDS} seconds'
                          and library.local_cover_inventory_contexts.retry_after
                            <= now() + interval '{_UNRESOLVED_FOLDER_RETRY_SECONDS - _RETRY_SECONDS} seconds'
                        then null else library.local_cover_inventory_contexts.retry_after end
                    returning root_path, error""",
                {"key": context_key(paths), "paths": Jsonb(sorted({root_key(path) for path in paths})), "foreground": foreground},
            ).fetchone()
            connection.commit()
        return dict(row) if row else {}

    def defer_context(self, key, revision, *, delay_seconds=_RETRY_SECONDS, error=_STORAGE_UNAVAILABLE):
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventory_contexts
                    set error = case when %(delay)s > 0 then %(error)s else error end,
                    retry_after = now() + %(delay)s * interval '1 second'
                    where library_id = ({_LIBRARY}) and context_key = %(key)s and revision = %(revision)s""",
                {"key": key, "revision": revision, "delay": delay_seconds, "error": error},
            )
            connection.commit()

    def next_context(self, key):
        """Claim one queued context, if it still has to be resolved."""
        with self._connection() as connection:
            row = connection.execute(
                f"""update library.local_cover_inventory_contexts
                    set retry_after = now() + interval '{_RETRY_SECONDS} seconds'
                    where library_id = ({_LIBRARY}) and context_key = %(key)s and root_path is null
                    and (retry_after is null or retry_after <= now())
                    returning context_key, track_paths, foreground_requested, revision""",
                {"key": key},
            ).fetchone()
            connection.commit()
        return dict(row) if row else None

    def publish_context(self, key, revision, root, *, foreground):
        self.request(root, foreground=foreground)
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventory_contexts set root_path = %(root)s,
                    retry_after = null, error = null, foreground_requested = false where library_id = ({_LIBRARY}) and context_key = %(key)s
                    and revision = %(revision)s""",
                {"key": key, "root": root_key(root), "revision": revision},
            )
            connection.commit()

    def request(self, root, *, foreground=True):
        with self._connection() as connection:
            connection.execute(
                f"""insert into library.local_cover_inventories (library_id, root_path, foreground_requested)
                    select ({_LIBRARY}), %(root)s, %(foreground)s
                    on conflict (library_id, root_path) do update set foreground_requested =
                    library.local_cover_inventories.foreground_requested or excluded.foreground_requested""",
                {"root": root_key(root), "foreground": foreground},
            )
            connection.commit()

    def invalidate_paths(self, paths, *, context_changed=False, subtree_paths=(), pending_contexts=()):
        """Mark what is at, above or (for subtrees) below these paths; return the listings and contexts marked.

        Every lookup is by key or by a migration 0292 range, hence the explicit "C" collation and the
        arrays: an OR over a join would read the whole table. An unresolved context has no indexed
        folder, so only those in ``pending_contexts``, the caller's own work, are matched by track path."""
        paths = list(paths)
        subtrees = {root_key(path) for path in subtree_paths}
        ancestors = {root_key(parent) for value in paths for parent in Path(value).parents}
        ancestors.update(root_key(path) for path in paths)
        ancestors.update(subtrees)
        if not ancestors:
            return [], []
        prefixes, prefix_ends = _prefix_range(subtrees)
        parameters = {"roots": sorted(ancestors), "prefixes": prefixes, "prefix_ends": prefix_ends}
        below_changed = """array(select listed.root_path
                from unnest(%(prefixes)s::text[], %(prefix_ends)s::text[]) as changed(prefix, prefix_end)
                join library.local_cover_inventories as listed on listed.library_id = ({library})
                  and listed.root_path collate "C" >= changed.prefix
                  and listed.root_path collate "C" < changed.prefix_end)""".format(library=_LIBRARY)
        affected_roots = f"%(roots)s::text[] || {below_changed}" if subtrees else "%(roots)s::text[]"
        if context_changed:
            from music_app.services.cover_workflow import is_disc_like_folder
            disc_parents = {root_key(Path(path).parent) for path in [*paths, *subtrees] if is_disc_like_folder(Path(path))}
            pending_roots = {root_key(Path(path).parent) for path in paths if root_key(path) not in subtrees}
            pending_roots.update(subtrees | disc_parents)
            parameters["context_prefixes"] = _prefix_range(pending_roots)[0]
            parameters["pending_contexts"] = list(pending_contexts)
            parameters["disc_prefixes"], parameters["disc_prefix_ends"] = _prefix_range(disc_parents)
        with self._connection() as connection:
            listings = connection.execute(
                f"""update library.local_cover_inventories set revision = revision + 1, retry_after = null
                    where library_id = ({_LIBRARY}) and root_path = any({affected_roots})
                    returning root_path""",
                parameters,
            ).fetchall()
            contexts = []
            if context_changed:
                contexts = connection.execute(
                    f"""update library.local_cover_inventory_contexts
                        set root_path = null, retry_after = null, revision = revision + 1
                        where library_id = ({_LIBRARY}) and context_key = any(
                          array(select context_key from library.local_cover_inventory_contexts
                            where library_id = ({_LIBRARY}) and root_path is not null
                              and root_path collate "C" = any(%(roots)s::text[]))
                          || array(select resolved.context_key
                            from unnest(%(prefixes)s::text[] || %(disc_prefixes)s::text[],
                              %(prefix_ends)s::text[] || %(disc_prefix_ends)s::text[]) as changed(prefix, prefix_end)
                            join library.local_cover_inventory_contexts as resolved
                              on resolved.library_id = ({_LIBRARY}) and resolved.root_path is not null
                              and resolved.root_path collate "C" >= changed.prefix
                              and resolved.root_path collate "C" < changed.prefix_end)
                          || array(select unresolved.context_key
                            from library.local_cover_inventory_contexts as unresolved
                            where unresolved.library_id = ({_LIBRARY})
                              and unresolved.context_key = any(%(pending_contexts)s::text[])
                              and unresolved.root_path is null and exists(
                                select 1 from jsonb_array_elements_text(unresolved.track_paths) as track(path)
                                cross join unnest(%(context_prefixes)s::text[]) as changed(prefix)
                                where starts_with(track.path, changed.prefix))))
                        returning context_key""",
                    parameters,
                ).fetchall()
            connection.commit()
        return [row["root_path"] for row in listings], [row["context_key"] for row in contexts]

    def invalidate_all(self):
        with self._connection() as connection:
            listings = connection.execute(
                f"""update library.local_cover_inventories set revision = revision + 1,
                    retry_after = null where library_id = ({_LIBRARY}) returning root_path"""
            ).fetchall()
            contexts = connection.execute(
                f"""update library.local_cover_inventory_contexts set root_path = null, retry_after = null,
                    revision = revision + 1 where library_id = ({_LIBRARY}) returning context_key"""
            ).fetchall()
            connection.commit()
        return [row["root_path"] for row in listings], [row["context_key"] for row in contexts]

    def remove_path(self, path):
        roots = [root_key(parent) for parent in Path(path).parents]
        with self._connection() as connection:
            listings = connection.execute(
                f"""update library.local_cover_inventories as inventory
                    set candidates = (select coalesce(jsonb_agg(candidate), '[]'::jsonb)
                        from jsonb_array_elements(inventory.candidates) as candidate
                        where ops.cover_path_key(candidate ->> 'path', %(case_insensitive)s)
                      <> ops.cover_path_key(%(path)s, %(case_insensitive)s)),
                        revision = revision + 1, retry_after = null
                    where library_id = ({_LIBRARY}) and root_path = any(%(roots)s::text[]) returning root_path""",
                {"roots": roots, "path": root_key(path), "case_insensitive": os.name == "nt"},
            ).fetchall()
            connection.commit()
        return [row["root_path"] for row in listings]

    def next_pending(self, root):
        """Claim one queued listing, if it still has to be read."""
        with self._connection() as connection:
            row = connection.execute(
                f"""update library.local_cover_inventories
                    set retry_after = now() + interval '5 minutes'
                    where library_id = ({_LIBRARY}) and root_path = %(root)s and indexed_revision < revision
                    and (retry_after is null or retry_after <= now())
                    returning root_path, revision, foreground_requested""",
                {"root": root},
            ).fetchone()
            connection.commit()
        return dict(row) if row else None

    def publish(self, root, revision, candidates):
        with self._connection() as connection:
            row = connection.execute(
                f"""update library.local_cover_inventories set candidates = %(candidates)s,
                    indexed_revision = revision, updated_at = now(), retry_after = null, error = null, foreground_requested = false
                    where library_id = ({_LIBRARY}) and root_path = %(root)s
                    and revision = %(revision)s returning root_path""",
                {"root": root_key(root), "revision": revision, "candidates": Jsonb(candidates)},
            ).fetchone()
            connection.commit()
        return row is not None

    def defer(self, root, revision, *, delay_seconds=_RETRY_SECONDS):
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventories set retry_after = now() + %(delay)s * interval '1 second',
                    error = case when %(delay)s > 0 then 'Local artwork could not be read. Checking again shortly.' else error end
                    where library_id = ({_LIBRARY}) and root_path = %(root)s
                    and revision = %(revision)s""",
                {"root": root_key(root), "revision": revision, "delay": delay_seconds},
            )
            connection.commit()


def discover_local_cover_inventory(root, config, *, cancel_requested=None):
    from music_app.services.cover_state import _file_sha256, iter_local_cover_candidates
    from music_app.services.covers import image_dimensions

    # Roots are stored by case-folded key; scan from the folder's real spelling so listed paths match the
    # album's own paths. realpath also follows junctions, so it is used only when it names the same folder.
    real_root = os.path.realpath(str(root))
    if root_key(real_root) == root_key(root):
        root = real_root
    candidates = iter_local_cover_candidates(
        Path(root), image_extensions=set(config["IMAGE_EXTENSIONS"]),
        image_dimensions=image_dimensions,
        is_squareish_cover=lambda width, height: width > 0 and height > 0 and abs(width - height) / max(width, height) <= 0.18,
        active_cover_path=None,
        cancel_requested=cancel_requested,
    )
    for candidate in candidates:
        candidate["sha256"] = _file_sha256(Path(candidate["path"]), cancel_requested=cancel_requested)
    return candidates


class LocalCoverInventoryWorker:
    """One background filesystem reader of what this process was given; Postgres coalesces requests by root.

    It never works through a stored backlog or the library's albums. Each database has one server."""

    _INVALIDATION_RETRY_BASE_SECONDS = 1.0
    _INVALIDATION_RETRY_MAX_SECONDS = 60.0

    def __init__(self, config, *, repository=None, logger=None):
        self.config = config
        self.repository = repository or LocalCoverInventoryRepository(config)
        self._logger = logger or logging.getLogger("music_app")
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._invalidation_retry_lock = threading.Lock()
        self._invalidation_retries = {}
        self._contexts = _WorkQueue()
        self._listings = _WorkQueue()
        self._foreground_at = time.monotonic()
        # What the worker has finished since start, so a request waiting for one folder is woken by
        # the worker instead of polling Postgres (freeze guard BI-05).
        self._finished = threading.Condition()
        self._finished_marks = {}

    def _mark_finished(self, key):
        with self._finished:
            self._finished_marks[key] = self._finished_marks.get(key, 0) + 1
            if len(self._finished_marks) > 512:
                self._finished_marks.pop(next(iter(self._finished_marks)))
            self._finished.notify_all()

    def _wait_for_mark(self, key, timeout):
        with self._finished:
            seen = self._finished_marks.get(key, 0)
            self._finished.wait_for(lambda: self._finished_marks.get(key, 0) != seen, timeout=max(0.0, timeout))

    def wait_for_context(self, paths, timeout):
        """Wait until the worker has resolved the folder of these tracks, or until `timeout`."""
        self._wait_for_mark(("context", context_key(paths)), timeout)

    def wait_for_listing(self, root, timeout):
        """Wait until the worker has listed this folder, or until `timeout`."""
        self._wait_for_mark(("root", root_key(root)), timeout)

    def note_foreground_activity(self):
        self._foreground_at = time.monotonic()

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="albumhaven-local-cover-inventory", daemon=True)
        self._thread.start()

    async def stop(self):
        self._stop.set()
        self._wake.set()
        if self._thread:
            await asyncio.to_thread(self._thread.join, 30)
            if self._thread.is_alive():
                raise TimeoutError("Local cover inventory worker did not stop in time.")

    def request(self, root):
        self.repository.request(root)
        self._listings.add([root_key(root)], foreground=True)
        self._wake.set()

    def request_context(self, paths):
        result = self.repository.request_context(paths)
        self._contexts.add([context_key(paths)], foreground=True)
        self._wake.set()
        return result

    def _queue_changed(self, changed):
        listings, contexts = changed
        self._listings.add(listings)
        self._contexts.add(contexts)

    def _invalidate(self, paths, *, context_changed, subtree_paths):
        self._queue_changed(self.repository.invalidate_paths(
            paths, context_changed=context_changed, subtree_paths=subtree_paths,
            pending_contexts=self._contexts.known() if context_changed else [],
        ))

    def invalidate_paths(self, paths, *, context_changed=False, subtree_paths=()):
        self._invalidate(list(paths), context_changed=context_changed, subtree_paths=list(subtree_paths))
        self._wake.set()

    def invalidate_or_retry(self, paths, *, context_changed=False, subtree_paths=()):
        try:
            self.invalidate_paths(paths, context_changed=context_changed, subtree_paths=subtree_paths)
        except Exception:
            self._logger.exception("Could not mark changed local cover listings; retrying.")
            self.schedule_invalidation_retry(paths, context_changed=context_changed, subtree_paths=subtree_paths)
            return False
        return True

    def roots_changed(self, previous, current):
        changed = changed_library_root_paths(previous, current)
        if changed:
            self.invalidate_or_retry(changed, context_changed=True, subtree_paths=changed)

    def schedule_invalidation_retry(self, paths, *, context_changed=False, subtree_paths=()):
        key = (
            tuple(sorted({root_key(path) for path in paths})),
            bool(context_changed),
            tuple(sorted({root_key(path) for path in subtree_paths})),
        )
        if not key[0] and not key[2]:
            return
        with self._invalidation_retry_lock:
            self._invalidation_retries.setdefault(key, (time.monotonic(), 0))
        self._wake.set()

    def _retry_scheduled_invalidation(self):
        now = time.monotonic()
        with self._invalidation_retry_lock:
            due = next(
                (
                    (key, state)
                    for key, state in self._invalidation_retries.items()
                    if state[0] <= now
                ),
                None,
            )
        if due is None:
            return
        key, state = due
        paths, context_changed, subtree_paths = key
        try:
            self._invalidate(paths, context_changed=context_changed, subtree_paths=subtree_paths)
        except Exception:
            attempts = state[1] + 1
            delay = min(
                self._INVALIDATION_RETRY_BASE_SECONDS
                * (2 ** min(attempts - 1, 6)),
                self._INVALIDATION_RETRY_MAX_SECONDS,
            )
            with self._invalidation_retry_lock:
                if self._invalidation_retries.get(key) == state:
                    self._invalidation_retries[key] = (now + delay, attempts)
            self._logger.exception(
                "Local cover inventory invalidation retry failed; retrying in %.1f seconds.",
                delay,
            )
            return
        with self._invalidation_retry_lock:
            if self._invalidation_retries.get(key) == state:
                self._invalidation_retries.pop(key, None)

    def rescan(self):
        """An owner-started Full Rescan: the one whole-library invalidation."""
        self._queue_changed(self.repository.invalidate_all())
        self._wake.set()

    def remove_path(self, path):
        self._listings.add(self.repository.remove_path(path))
        self._wake.set()

    def _cancel_requested(self, foreground):
        if self._stop.is_set():
            return True
        if foreground:
            return False
        return (
            time.monotonic() - self._foreground_at <= 5
            or self._contexts.waiting(background=False)
            or self._listings.waiting(background=False)
        )

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(1.0)
            self._wake.clear()
            if self._stop.is_set():
                return
            background = time.monotonic() - self._foreground_at > 5
            if not (
                self._invalidation_retries
                or self._contexts.waiting(background=background)
                or self._listings.waiting(background=background)
            ):
                continue  # an idle poll reads nothing and takes no work slot
            key = root = None
            try:
                with self.repository.work_slot() as admitted:
                    if not admitted:
                        continue
                    self._retry_scheduled_invalidation()
                    key = self._contexts.take(background=background)
                    context = self.repository.next_context(key) if key else None
                    if context:
                        from music_app.services.cover_workflow import resolve_album_root_from_track_paths
                        cancelled = lambda: self._cancel_requested(context["foreground_requested"])
                        try:
                            album_root = resolve_album_root_from_track_paths(self.config, set(context["track_paths"]), cancel_requested=cancelled)
                            if cancelled():
                                raise InterruptedError("Local cover context resolution cancelled")
                            # NEW-003: the alert must tell the truth. Files that exist are never
                            # "unavailable"; an album spread over several folders still gets its art.
                            album_root = album_root or local_inventory_root_for_tracks(self.config, context["track_paths"])
                            if album_root:
                                self.repository.publish_context(context["context_key"], context["revision"], album_root, foreground=context["foreground_requested"])
                                self._listings.add([root_key(album_root)], foreground=context["foreground_requested"])
                            elif local_inventory_tracks_exist(context["track_paths"]):
                                self.repository.defer_context(context["context_key"], context["revision"], delay_seconds=_UNRESOLVED_FOLDER_RETRY_SECONDS, error=None)
                                self._contexts.add([key], delay=_UNRESOLVED_FOLDER_RETRY_SECONDS)
                            else:
                                self.repository.defer_context(context["context_key"], context["revision"])
                                self._contexts.add([key], delay=_RETRY_SECONDS)
                            self._mark_finished(("context", context["context_key"]))
                        except InterruptedError:
                            self.repository.defer_context(context["context_key"], context["revision"], delay_seconds=0)
                            self._contexts.add([key], foreground=context["foreground_requested"])
                        except (OSError, ValueError):
                            self.repository.defer_context(context["context_key"], context["revision"])
                            self._contexts.add([key], delay=_RETRY_SECONDS)
                    key = None
                    if self._stop.is_set():
                        return
                    root = self._listings.take(background=background)
                    pending = self.repository.next_pending(root) if root else None
                    if pending:
                        cancelled = lambda: self._cancel_requested(pending["foreground_requested"])
                        try:
                            candidates = discover_local_cover_inventory(pending["root_path"], self.config, cancel_requested=cancelled)
                            if cancelled():
                                raise InterruptedError("Local cover inventory refresh cancelled")
                            self.repository.publish(pending["root_path"], pending["revision"], candidates)
                            self._mark_finished(("root", root_key(pending["root_path"])))
                        except InterruptedError:
                            self.repository.defer(pending["root_path"], pending["revision"], delay_seconds=0)
                            self._listings.add([root], foreground=pending["foreground_requested"])
                        except OSError:
                            self.repository.defer(pending["root_path"], pending["revision"])
                            self._listings.add([root], delay=_RETRY_SECONDS)
                            self._mark_finished(("root", root_key(pending["root_path"])))
            except Exception:
                # A database failure loses no work this process was given.
                if key:
                    self._contexts.add([key], delay=_RETRY_SECONDS)
                if root:
                    self._listings.add([root], delay=_RETRY_SECONDS)
                self._logger.exception("Local cover inventory refresh failed.")
                self._stop.wait(5.0)
