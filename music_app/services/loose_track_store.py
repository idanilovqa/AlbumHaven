"""Loose Tracks kept one row per track (freeze guard case 64; migration NNNN+1, a draft until approved).

Triggers mark the tracks a write may have changed. A drain rebuilds only those tracks' rows and deletes the
rows of tracks that are no longer loose. A read returns the stored rows and never builds the store. Only the
start-up preparation, a builder change or an owner rebuild builds it whole.

A row stores the loader's raw candidate rows for the track's files, for every root and uncapped. The read
applies what may change without a mark: root activity, the loader's cap in its exact order, and the relation
alias maps (canonical artist names).
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Mapping
from typing import Any

BUILDER_VERSION = 1
# A read drains inline only while this few tracks wait; more wait for the background drain.
INLINE_DRAIN_LIMIT = 50
DRAIN_BATCH = 500
FAILED_BUILD_RETRY_SECONDS = 300

_LOGGER = logging.getLogger("music_app")

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
        {"rows": json.dumps([{"track_id": track_id, "track": track} for track_id, track in rows.items()])},
    )


def drain(inventory: Any, connection: Any, *, limit: int = DRAIN_BATCH) -> int:
    """Rebuild the rows of up to ``limit`` marked tracks; return how many marks were cleared."""
    marks = [dict(row) for row in connection.execute(
        f"""select track_id, marked_xid::text as marked_xid from library.non_album_track_marks
            where library_id = {_LIBRARY_SQL} order by track_id limit %(limit)s""",
        {"limit": int(limit)},
    ).fetchall()]
    if not marks:
        return 0
    track_ids = [int(mark["track_id"]) for mark in marks]
    rows = _rows_by_track(_load_candidates(inventory, connection, track_ids))
    _write_rows(connection, rows)
    gone = sorted(set(track_ids) - set(rows))
    if gone:
        connection.execute(
            f"""delete from library.non_album_track_rows
                where library_id = {_LIBRARY_SQL} and track_id = any(%(track_ids)s::bigint[])""",
            {"track_ids": gone},
        )
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


def needs_build(state: Mapping[str, object] | None) -> bool:
    """Start-up preparation: no store, a builder change, or a failed build whose retry time has come."""
    if not state or state.get("builder_version") != BUILDER_VERSION:
        return True
    if state.get("status") == "building":
        return True  # a build interrupted by a restart
    if state.get("status") == "failed":
        from datetime import datetime, timezone

        retry_after = state.get("retry_after")
        return retry_after is None or retry_after <= datetime.now(timezone.utc)
    return False


def build(inventory: Any, connect: Any, *, progress=None) -> int:
    """Build every row once (start-up, builder change or owner rebuild); return the tracks written."""
    report = progress or (lambda stage, **values: _LOGGER.info("Loose Tracks store: %s %s", stage, values))
    with connect() as connection:
        _set_state(connection, "building")
        connection.commit()
    try:
        with connect() as connection:
            # Marks committed before this snapshot are covered by the build; later ones stay for the drain.
            horizon = dict(connection.execute(
                "select pg_snapshot_xmin(pg_current_snapshot())::text as horizon"
            ).fetchone())["horizon"]
            report("reading")
            rows = _rows_by_track(_load_candidates(inventory, connection))
            report("writing", tracks=len(rows))
            connection.execute(f"delete from library.non_album_track_rows where library_id = {_LIBRARY_SQL}")
            _write_rows(connection, rows)
            connection.execute(
                f"""delete from library.non_album_track_marks
                    where library_id = {_LIBRARY_SQL} and marked_xid < %(horizon)s::xid8""",
                {"horizon": horizon},
            )
            _set_state(connection, "ready")
            connection.commit()
        report("ready", tracks=len(rows))
        return len(rows)
    except Exception as error:
        _LOGGER.exception("Loose Tracks store build failed; it is retried after its own backoff.")
        with connect() as connection:
            _set_state(connection, "failed", error=str(error)[:500], retry_seconds=FAILED_BUILD_RETRY_SECONDS)
            connection.commit()
        raise


def prepare(inventory: Any, connect: Any) -> None:
    """The background owner: build when start-up preparation needs it, then drain every waiting mark."""
    with connect() as connection:
        state = load_state(connection)
    if needs_build(state):
        build(inventory, connect)
    while True:
        with connect() as connection:
            cleared = drain(inventory, connection)
            connection.commit()
        if not cleared:
            return
