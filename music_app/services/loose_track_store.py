"""Loose Tracks kept one row per track (freeze guard case 64; migration 0295).

Triggers mark the tracks a write may have changed. A drain rebuilds only those tracks' rows and deletes the
rows of tracks that are no longer loose. A read returns the stored rows and never builds the store. Only the
start-up preparation, a builder change or an owner rebuild builds it whole.

A row stores the loader's raw candidate rows for the track's files, for every root and uncapped. The read
applies what may change without a mark: root activity, the loader's cap in its exact order, and the relation
alias maps (canonical artist names).

The build commits its rows in keyed batches while its state stays "building", so a read can show the rows
stored so far (owner, 2026-11-22: "If at least one loose track is already indexed let that page show it").
"""
from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterable, Mapping
from typing import Any

BUILDER_VERSION = 1
# A read drains inline only while this few tracks wait; more wait for the background drain.
INLINE_DRAIN_LIMIT = 50
DRAIN_BATCH = 500
# Tracks a build loads and commits at a time (keyed, like a drain).
BUILD_BATCH = 500
FAILED_BUILD_RETRY_SECONDS = 300

_LOGGER = logging.getLogger("music_app")
_PREPARE_LOCK = threading.Lock()
_BUSY_RECHECK_SECONDS = 1.0
# Held for a whole build on a session of its own: the "building" state's owner across processes.
_BUILD_LOCK_KEY = "hashtextextended('album-haven.loose-track-store.build', 0)"
_BUILD_LOCK_SQL = f"select pg_try_advisory_lock({_BUILD_LOCK_KEY}) as held"
_BUILD_UNLOCK_SQL = f"select pg_advisory_unlock({_BUILD_LOCK_KEY})"

_LIBRARY_SQL = """(
  select libraries.id
  from app.bootstrap_owners owners
  join library.libraries libraries
    on libraries.owner_account_id = owners.account_id
   and libraries.name = 'Local Library'
   and libraries.library_kind = 'local'
  where owners.owner_key = 'local-bootstrap-owner'
  limit 1)"""


def load_state(connection: Any) -> dict[str, object] | None:
    row = connection.execute(
        f"""select builder_version, status, error, retry_after, built_at
            from library.non_album_track_store_state where library_id = {_LIBRARY_SQL}"""
    ).fetchone()
    return dict(row) if row else None


def is_ready(state: Mapping[str, object] | None) -> bool:
    return bool(state) and state.get("status") == "ready" and state.get("builder_version") == BUILDER_VERSION


def waiting_marks(connection: Any, *, at_most: int) -> int:
    row = connection.execute(
        f"""select count(*) as waiting from (
              select 1 from library.non_album_track_marks
              where library_id = {_LIBRARY_SQL} limit %(at_most)s) waiting""",
        {"at_most": at_most},
    ).fetchone()
    return int(dict(row)["waiting"])


def _jsonable(value: object) -> object:
    return json.loads(json.dumps(value, default=str))


def _stored_file(candidate: Mapping[str, object]) -> dict[str, object]:
    """A candidate row as the loader returned it, with its sort key in the loader's exact order."""
    stored = _jsonable(dict(candidate))
    stored["_order"] = [
        str(candidate.get("artist_sort_name") or "") or str(candidate.get("artist_name") or ""),
        candidate.get("track_title"),
        candidate.get("private_path"),
        int(candidate.get("track_file_id") or 0),
    ]
    return stored


def _rows_by_track(candidates: Iterable[Mapping[str, object]]) -> dict[int, dict[str, object]]:
    tracks: dict[int, dict[str, object]] = {}
    for candidate in candidates:
        track_id = int(candidate.get("track_id") or 0)
        if track_id:
            tracks.setdefault(track_id, {"files": []})["files"].append(_stored_file(candidate))
    return tracks


def _load_candidates(inventory: Any, connection: Any, track_ids: Iterable[int] | None = None) -> list[dict[str, object]]:
    if connection is None:  # the loader would lease a connection of its own, once per batch
        raise TypeError("A Loose Tracks store batch loads on its caller's connection; none was given.")
    return inventory.load_non_album_candidates(
        track_ids=track_ids, connection=connection, all_roots=True, unlimited=True,
    )


def read_candidates(connection: Any, *, limit: int) -> list[dict[str, object]]:
    """Active roots' stored candidate rows, in the loader's order, capped as the loader caps them."""
    rows = connection.execute(
        f"""select stored.value as candidate
            from library.non_album_track_rows track_rows
            cross join lateral jsonb_array_elements(track_rows.track -> 'files') as stored(value)
            join library.library_roots roots
              on roots.id = (stored.value ->> 'root_id')::bigint and roots.is_active is true
            where track_rows.library_id = {_LIBRARY_SQL}
            order by stored.value -> '_order' ->> 0, stored.value -> '_order' ->> 1,
              stored.value -> '_order' ->> 2, (stored.value -> '_order' ->> 3)::bigint
            limit %(limit)s""",
        {"limit": int(limit)},
    ).fetchall()
    return [dict(dict(row)["candidate"]) for row in rows]


def _write_rows(connection: Any, rows: Mapping[int, Mapping[str, object]]) -> None:
    if not rows:
        return
    connection.execute(
        f"""insert into library.non_album_track_rows (library_id, track_id, track, updated_at)
            select {_LIBRARY_SQL}, (item ->> 'track_id')::bigint, item -> 'track', now()
            from jsonb_array_elements(%(rows)s::jsonb) as rows(item)
            on conflict (library_id, track_id) do update set track = excluded.track, updated_at = now()""",
        # Written in track_id order, so concurrent drains lock rows in one order.
        {"rows": json.dumps([{"track_id": track_id, "track": rows[track_id]} for track_id in sorted(rows)])},
    )


def _delete_rows(connection: Any, track_ids: list[int]) -> None:
    """Delete the rows of tracks that are no longer loose (or gone)."""
    if not track_ids:
        return
    # Locked in track_id order, as rows are written, so two writers never wait on each other in a cycle.
    connection.execute(
        f"""delete from library.non_album_track_rows track_rows
            using (select library_id, track_id from library.non_album_track_rows
                   where library_id = {_LIBRARY_SQL} and track_id = any(%(track_ids)s::bigint[])
                   order by track_id for update) locked
            where track_rows.library_id = locked.library_id and track_rows.track_id = locked.track_id""",
        {"track_ids": track_ids},
    )


def drain(inventory: Any, connection: Any, *, limit: int = DRAIN_BATCH) -> int:
    """Rebuild the rows of up to ``limit`` marked tracks; return how many marks were cleared."""
    # Claimed in this transaction; a concurrent drain skips them and takes others.
    marks = [dict(row) for row in connection.execute(
        f"""select track_id, marked_xid::text as marked_xid from library.non_album_track_marks
            where library_id = {_LIBRARY_SQL} order by track_id limit %(limit)s
            for update skip locked""",
        {"limit": int(limit)},
    ).fetchall()]
    if not marks:
        return 0
    track_ids = [int(mark["track_id"]) for mark in marks]
    rows = _rows_by_track(_load_candidates(inventory, connection, track_ids))
    _write_rows(connection, rows)
    _delete_rows(connection, sorted(set(track_ids) - set(rows)))
    # Only the marks read here: a track marked again meanwhile keeps its newer mark.
    cleared = connection.execute(
        f"""delete from library.non_album_track_marks marks
            using unnest(%(track_ids)s::bigint[], %(xids)s::text[]) as read(track_id, marked_xid)
            where marks.library_id = {_LIBRARY_SQL} and marks.track_id = read.track_id
              and marks.marked_xid = read.marked_xid::xid8
            returning marks.track_id""",
        {"track_ids": track_ids, "xids": [mark["marked_xid"] for mark in marks]},
    ).fetchall()
    return len(cleared)


def _set_state(connection: Any, status: str, *, error: str | None = None, retry_seconds: int | None = None) -> None:
    connection.execute(
        f"""insert into library.non_album_track_store_state
              (library_id, builder_version, status, error, retry_after, built_at, updated_at)
            select {_LIBRARY_SQL}, %(version)s, %(status)s, %(error)s,
              case when %(retry)s::int is null then null else now() + %(retry)s::int * interval '1 second' end,
              case when %(status)s = 'ready' then now() end, now()
            on conflict (library_id) do update set builder_version = excluded.builder_version,
              status = excluded.status, error = excluded.error, retry_after = excluded.retry_after,
              built_at = coalesce(excluded.built_at, library.non_album_track_store_state.built_at),
              updated_at = now()""",
        {"version": BUILDER_VERSION, "status": status, "error": error, "retry": retry_seconds},
    )


def _seconds_until_retry(state: Mapping[str, object] | None) -> float | None:
    """How long a failed build still waits for its retry (0 once due); None when the store is not failed."""
    if not state or state.get("status") != "failed":
        return None
    from datetime import datetime, timezone

    retry_after = state.get("retry_after")
    return 0.0 if retry_after is None else max(0.0, (retry_after - datetime.now(timezone.utc)).total_seconds())


def needs_build(state: Mapping[str, object] | None) -> bool:
    """Start-up preparation: no store, a builder change, or a failed build whose retry time has come."""
    if not state or state.get("builder_version") != BUILDER_VERSION:
        return True
    if state.get("status") == "building":
        return True  # a build interrupted by a restart
    return _seconds_until_retry(state) == 0.0


def build(inventory: Any, connect: Any, *, progress=None) -> int | None:
    """Build every row once (start-up, builder change or owner rebuild); return the tracks written, or None
    while another process holds the build (its "building" state is then not an interrupted build)."""
    with connect() as owner:
        held = bool(dict(owner.execute(_BUILD_LOCK_SQL).fetchone())["held"])
        owner.commit()
        if not held:
            return None
        try:
            return _build_rows(inventory, connect, progress=progress)
        finally:
            owner.execute(_BUILD_UNLOCK_SQL)
            owner.commit()


def _build_rows(inventory: Any, connect: Any, *, progress=None) -> int:
    import time

    report = progress or (lambda stage, **values: _LOGGER.info("Loose Tracks store: %s %s", stage, values))
    started = time.monotonic()
    with connect() as connection:
        _set_state(connection, "building")
        connection.commit()
    try:
        with connect() as connection:
            # Marks committed before this snapshot are covered by the batches; later ones stay for the drain.
            # Rows a batch does not touch keep their older updated_at and are removed at the end, so readers
            # see the earlier list replaced gradually, never emptied (6.5). A retry builds over what is there.
            started_row = dict(connection.execute(
                f"""select pg_snapshot_xmin(pg_current_snapshot())::text as horizon,
                      clock_timestamp() as build_started,
                      (select count(*) from library.local_tracks where library_id = {_LIBRARY_SQL}) as tracks"""
            ).fetchone())
            horizon, build_started, total = (
                started_row["horizon"], started_row["build_started"], int(started_row["tracks"]),
            )
            connection.commit()
            report("reading", total=total)
            written = done = 0
            after = 0
            while True:
                # Keyed batches in track id order: each loads and commits only its own tracks.
                track_ids = [int(dict(row)["id"]) for row in connection.execute(
                    f"""select id from library.local_tracks
                        where library_id = {_LIBRARY_SQL} and id > %(after)s order by id limit %(batch)s""",
                    {"after": after, "batch": BUILD_BATCH},
                ).fetchall()]
                if not track_ids:
                    break
                rows = _rows_by_track(_load_candidates(inventory, connection, track_ids))
                _write_rows(connection, rows)
                _delete_rows(connection, sorted(set(track_ids) - set(rows)))
                connection.commit()
                after, done, written = track_ids[-1], done + len(track_ids), written + len(rows)
                report("batch", done=done, total=max(total, done), tracks=written)
            # Rows no batch touched belong to tracks that are gone.
            connection.execute(
                f"""delete from library.non_album_track_rows
                    where library_id = {_LIBRARY_SQL} and updated_at < %(build_started)s""",
                {"build_started": build_started},
            )
            connection.execute(
                f"""delete from library.non_album_track_marks
                    where library_id = {_LIBRARY_SQL} and marked_xid < %(horizon)s::xid8""",
                {"horizon": horizon},
            )
            _set_state(connection, "ready")
            connection.commit()
        # The phase 2 dry run reads this duration to decide whether "preparing" needs a progress line.
        report("ready", tracks=written, seconds=round(time.monotonic() - started, 1))
        return written
    except Exception as error:
        _LOGGER.exception("Loose Tracks store build failed; it is retried after its own backoff.")
        with connect() as connection:
            _set_state(connection, "failed", error=str(error)[:500], retry_seconds=FAILED_BUILD_RETRY_SECONDS)
            connection.commit()
        raise


class LooseTrackStoreOwner:
    """The start-up owner: prepares the store once in the background, then re-runs ``prepare`` when a failed
    build's retry time has come. That time comes from its own ``prepare``; it waits on a timer, never on a read,
    and with nothing failed it only waits on its stop event, touching no database."""

    def __init__(self, config: Mapping[str, object], *, repository_factory=None, logger=None):
        self._config = config
        self._repository_factory = repository_factory
        self._logger = logger or _LOGGER
        self._stop = None
        self._thread = None

    def _repository(self):
        if self._repository_factory is not None:
            return self._repository_factory()
        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

        return PostgresLibraryBrowseRepository(self._config)

    def prepare_now(self) -> float | None:
        """Prepare on the caller's thread and raise its failure (fixture loading publishes the store)."""
        repository = self._repository()
        return prepare(repository._inventory_repository, repository._owned_connection_context)

    def run_once(self) -> float | None:
        """One owner pass: prepare, and return how long until a failed build's retry (None: nothing failed)."""
        try:
            return self.prepare_now()
        except Exception:
            self._logger.exception("Loose Tracks store preparation failed; its retry waits for its backoff.")
            return float(FAILED_BUILD_RETRY_SECONDS)

    def _run(self) -> None:
        wait = self.run_once()
        while wait is not None:
            if self._stop.wait(wait):
                return
            wait = self.run_once()
        self._stop.wait()

    def start(self) -> None:
        import threading

        if self._config.get("SHARED_LIBRARY_BROWSE_ONLY") or self._thread is not None:
            return
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="albumhaven-loose-track-store", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 30.0) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout)


def prepare(inventory: Any, connect: Any) -> float | None:
    """The background owner: build when start-up preparation needs it, then drain every waiting mark. Returns
    how long a failed build still waits for its retry, or None once the store is ready and drained."""
    # The start-up owner and a queued drain both prepare. One at a time, and never waiting: the running
    # preparation drains every mark, and the single prewarm worker's rules and duplicate-identity work must
    # not queue behind a build. The owner checks again shortly; a queued drain just returns.
    if not _PREPARE_LOCK.acquire(blocking=False):
        return _BUSY_RECHECK_SECONDS
    try:
        with connect() as connection:
            state = load_state(connection)
        wait = _seconds_until_retry(state)
        if wait:
            return wait  # a failed build whose retry time has not come
        if needs_build(state) and build(inventory, connect) is None:
            return _BUSY_RECHECK_SECONDS  # another process holds the build
        while True:
            with connect() as connection:
                cleared = drain(inventory, connection)
                connection.commit()
            if not cleared:
                return None
    finally:
        _PREPARE_LOCK.release()
