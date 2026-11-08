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


_STORAGE_UNAVAILABLE = "Can't read local art right now. Retrying."


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


def local_inventory_tracks_exist(track_paths):
    return any(Path(path).is_file() for path in track_paths)


def context_key(paths):
    return hashlib.sha256(json.dumps(sorted({root_key(path) for path in paths})).encode()).hexdigest()


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
                    library.local_cover_inventory_contexts.foreground_requested or excluded.foreground_requested
                    returning root_path, error""",
                {"key": context_key(paths), "paths": Jsonb(sorted({root_key(path) for path in paths})), "foreground": foreground},
            ).fetchone()
            connection.commit()
        return dict(row) if row else {}

    def defer_context(self, key, revision, *, delay_seconds=30, error=_STORAGE_UNAVAILABLE):
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventory_contexts
                    set error = case when %(delay)s > 0 then %(error)s else error end,
                    retry_after = now() + %(delay)s * interval '1 second'
                    where library_id = ({_LIBRARY}) and context_key = %(key)s and revision = %(revision)s""",
                {"key": key, "revision": revision, "delay": delay_seconds, "error": error},
            )
            connection.commit()

    def next_context(self, *, background):
        with self._connection() as connection:
            row = connection.execute(
                f"""with pending as (select library_id, context_key from library.local_cover_inventory_contexts
                    where library_id = ({_LIBRARY}) and root_path is null
                    and (retry_after is null or retry_after <= now())
                    and (%(background)s or foreground_requested)
                    order by foreground_requested desc, context_key limit 1 for update skip locked)
                    update library.local_cover_inventory_contexts as context
                    set retry_after = now() + interval '30 seconds' from pending
                    where context.library_id = pending.library_id and context.context_key = pending.context_key
                    returning context.context_key, context.track_paths, context.foreground_requested, context.revision""",
                {"background": background},
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

    def invalidate_paths(self, paths, *, context_changed=False, subtree_paths=()):
        paths = list(paths)
        subtrees = {root_key(path) for path in subtree_paths}
        ancestors = {root_key(parent) for value in paths for parent in Path(value).parents}
        ancestors.update(root_key(path) for path in paths)
        ancestors.update(subtrees)
        if not ancestors:
            return
        parameters = {"roots": sorted(ancestors), "prefixes": sorted(path.rstrip(os.sep) + os.sep for path in subtrees)}
        affected_roots = "root_path = any(%(roots)s::text[])"
        if subtrees:
            affected_roots += " or exists(select 1 from unnest(%(prefixes)s::text[]) as subtree(prefix) where starts_with(root_path, subtree.prefix))"
        affected_contexts = affected_roots
        if context_changed:
            from music_app.services.cover_workflow import is_disc_like_folder
            disc_parents = {root_key(Path(path).parent) for path in [*paths, *subtrees] if is_disc_like_folder(Path(path))}
            pending_roots = {root_key(Path(path).parent) for path in paths if root_key(path) not in subtrees}
            pending_roots.update(subtrees | disc_parents)
            parameters["context_prefixes"] = sorted(path.rstrip(os.sep) + os.sep for path in pending_roots)
            affected_contexts += """ or (root_path is null and exists(
                select 1 from jsonb_array_elements_text(track_paths) as track(path)
                cross join unnest(%(context_prefixes)s::text[]) as changed(prefix)
                where starts_with(track.path, changed.prefix)))"""
            if disc_parents:
                parameters["disc_prefixes"] = sorted(path.rstrip(os.sep) + os.sep for path in disc_parents)
                affected_contexts += " or exists(select 1 from unnest(%(disc_prefixes)s::text[]) as disc(prefix) where starts_with(root_path, disc.prefix))"
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventories set revision = revision + 1, retry_after = null
                    where library_id = ({_LIBRARY}) and ({affected_roots})""",
                parameters,
            )
            if context_changed:
                connection.execute(
                    f"""update library.local_cover_inventory_contexts
                        set root_path = null, retry_after = null, revision = revision + 1
                        where library_id = ({_LIBRARY}) and ({affected_contexts})""",
                    parameters,
                )
            connection.commit()

    def invalidate_all(self):
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventories set revision = revision + 1,
                    retry_after = null where library_id = ({_LIBRARY})"""
            )
            connection.execute(f"update library.local_cover_inventory_contexts set root_path = null, retry_after = null, revision = revision + 1 where library_id = ({_LIBRARY})")
            connection.commit()

    def remove_path(self, path):
        roots = [root_key(parent) for parent in Path(path).parents]
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventories as inventory
                    set candidates = (select coalesce(jsonb_agg(candidate), '[]'::jsonb)
                        from jsonb_array_elements(inventory.candidates) as candidate
                        where ops.cover_path_key(candidate ->> 'path', %(case_insensitive)s)
                      <> ops.cover_path_key(%(path)s, %(case_insensitive)s)),
                        revision = revision + 1, retry_after = null
                    where library_id = ({_LIBRARY}) and root_path = any(%(roots)s::text[])""",
                {"roots": roots, "path": root_key(path), "case_insensitive": os.name == "nt"},
            )
            connection.commit()

    def next_pending(self, *, background=True):
        with self._connection() as connection:
            row = connection.execute(
                f"""with pending as (select library_id, root_path from library.local_cover_inventories
                    where library_id = ({_LIBRARY}) and indexed_revision < revision
                    and (retry_after is null or retry_after <= now())
                    and (%(background)s or foreground_requested)
                    order by foreground_requested desc, retry_after nulls first, root_path limit 1 for update skip locked)
                    update library.local_cover_inventories as inventory
                    set retry_after = now() + interval '5 minutes' from pending
                    where inventory.library_id = pending.library_id and inventory.root_path = pending.root_path
                    returning inventory.root_path, inventory.revision, inventory.foreground_requested"""
                , {"background": background}
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

    def defer(self, root, revision, *, delay_seconds=30):
        with self._connection() as connection:
            connection.execute(
                f"""update library.local_cover_inventories set retry_after = now() + %(delay)s * interval '1 second',
                    error = case when %(delay)s > 0 then 'Local artwork could not be read. Checking again shortly.' else error end
                    where library_id = ({_LIBRARY}) and root_path = %(root)s
                    and revision = %(revision)s""",
                {"root": root_key(root), "revision": revision, "delay": delay_seconds},
            )
            connection.commit()

    def next_album(self, after_id):
        with self._connection() as connection:
            row = connection.execute(
                f"""with next_album as (
                    select id from library.local_albums where library_id = ({_LIBRARY})
                    and id > %(after_id)s order by id limit 1
                ) select next_album.id, array_remove(array_agg(files.private_path), null) as paths
                from next_album left join library.local_tracks as tracks on tracks.album_id = next_album.id
                left join library.local_track_files as files on files.track_id = tracks.id
                    and files.scan_cache_stale is false group by next_album.id""",
                {"after_id": after_id},
            ).fetchone()
        return dict(row) if row else None

    def has_foreground_requests(self):
        with self._connection() as connection:
            return bool(connection.execute(
                f"""select exists(select 1 from library.local_cover_inventories
                    where library_id = ({_LIBRARY}) and indexed_revision < revision and foreground_requested
                    and (retry_after is null or retry_after <= now()))
                    or exists(select 1 from library.local_cover_inventory_contexts
                    where library_id = ({_LIBRARY}) and root_path is null and foreground_requested
                    and (retry_after is null or retry_after <= now())) as waiting"""
            ).fetchone()["waiting"])


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
    """One background filesystem reader; Postgres coalesces requests by root."""

    def __init__(self, config, *, repository=None, logger=None):
        self.config = config
        self.repository = repository or LocalCoverInventoryRepository(config)
        self._logger = logger or logging.getLogger("music_app")
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._after_album_id = 0
        self._backfill_done = False
        self._foreground_at = time.monotonic()
        self._priority_checked_at = 0.0
        self._priority_waiting = False

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
        self._wake.set()

    def request_context(self, paths):
        result = self.repository.request_context(paths)
        self._wake.set()
        return result

    def invalidate_paths(self, paths, *, context_changed=False, subtree_paths=()):
        self.repository.invalidate_paths(list(paths), context_changed=context_changed, subtree_paths=list(subtree_paths))
        self._wake.set()

    def rescan(self):
        self.repository.invalidate_all()
        self._after_album_id = 0
        self._backfill_done = False
        self._wake.set()

    def remove_path(self, path):
        self.repository.remove_path(path)
        self._wake.set()

    def _backfill_one(self):
        album = self.repository.next_album(self._after_album_id)
        if not album:
            self._backfill_done = True
            return
        self._after_album_id = int(album["id"])
        paths = set(album["paths"] or [])
        if paths:
            self.repository.request_context(paths, foreground=False)

    def _cancel_requested(self, foreground):
        if self._stop.is_set():
            return True
        if foreground:
            return False
        now = time.monotonic()
        if now - self._foreground_at <= 5:
            return True
        if now - self._priority_checked_at > 0.25:
            self._priority_checked_at = now
            self._priority_waiting = self.repository.has_foreground_requests()
        return self._priority_waiting

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(1.0)
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                with self.repository.work_slot() as admitted:
                    if not admitted:
                        continue
                    background = time.monotonic() - self._foreground_at > 5
                    context = self.repository.next_context(background=background)
                    if context:
                        from music_app.services.cover_workflow import resolve_album_root_from_track_paths
                        cancelled = lambda: self._cancel_requested(context["foreground_requested"])
                        try:
                            root = resolve_album_root_from_track_paths(self.config, set(context["track_paths"]), cancel_requested=cancelled)
                            if cancelled():
                                raise InterruptedError("Local cover context resolution cancelled")
                            # NEW-003: the alert must tell the truth. Files that exist are never
                            # "unavailable"; an album spread over several folders still gets its art.
                            root = root or local_inventory_root_for_tracks(self.config, context["track_paths"])
                            if root:
                                self.repository.publish_context(context["context_key"], context["revision"], root, foreground=context["foreground_requested"])
                            elif local_inventory_tracks_exist(context["track_paths"]):
                                self.repository.defer_context(context["context_key"], context["revision"], delay_seconds=3600, error=None)
                            else:
                                self.repository.defer_context(context["context_key"], context["revision"])
                        except InterruptedError:
                            self.repository.defer_context(context["context_key"], context["revision"], delay_seconds=0)
                        except (OSError, ValueError):
                            self.repository.defer_context(context["context_key"], context["revision"])
                    if self._stop.is_set():
                        return
                    pending = self.repository.next_pending(background=background)
                    if pending:
                        cancelled = lambda: self._cancel_requested(pending["foreground_requested"])
                        try:
                            candidates = discover_local_cover_inventory(pending["root_path"], self.config, cancel_requested=cancelled)
                            if cancelled():
                                raise InterruptedError("Local cover inventory refresh cancelled")
                            self.repository.publish(pending["root_path"], pending["revision"], candidates)
                        except InterruptedError:
                            self.repository.defer(pending["root_path"], pending["revision"], delay_seconds=0)
                        except OSError:
                            self.repository.defer(pending["root_path"], pending["revision"])
                    elif not self._backfill_done and time.monotonic() - self._foreground_at > 5:
                        self._backfill_one()
            except Exception:
                self._logger.exception("Local cover inventory refresh failed.")
                self._stop.wait(5.0)
