"""The persisted Problematic Files index (migration 0188) and duplicate results (0268).

Problematic Files used to find its albums with a whole-library candidate pass
(22-55 s on a 160k-file library after every restart). The index keeps the
listed items with their sort keys and search text, so pages and search are
keyset reads. Album changes are marked by the database journal; the albums a
mark names (and their duplicate peers) are re-evaluated with the same loaders
and builder the list always used, so an indexed item equals a rebuilt one.
The same evaluation stores each album's duplicate result, which gallery and
search cards read instead of computing it (FTC-TAGS-015). Those results have
their own version, backfill and progress, so adding them never rebuilds the
Problematic Files items.

Until an index of the current builder version is ready, callers keep their
previous path and a background backfill fills it.
"""
from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Mapping
from threading import Lock
from typing import Any

from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)

# Bump when an item's content for the same library data changes; a different
# version backfills the index again.
BUILDER_VERSION = "1"
# Bump when a stored duplicate result changes for the same library data; a different
# version backfills only library.album_duplicate_results.
DUPLICATE_RESULTS_VERSION = "1"
# More marked albums than this are evaluated in the background, not by a read.
INLINE_ALBUM_LIMIT = 50
# Albums evaluated per transaction by the backfill.
BACKFILL_BATCH = 500
_LOCK_NAMESPACE = 188  # pg advisory lock (namespace, library id)
# On unless set to 0; the Python test suite turns it off so a background backfill
# never races another test's database reset (index tests turn it back on).
ENABLED_KEY = "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED"

_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-problematic-index")
_QUEUED: set[str] = set()
_QUEUED_LOCK = Lock()
# After a failed pass, per database: no new pass before this monotonic time.
_RETRY_NOT_BEFORE: dict[str, float] = {}
RETRY_AFTER_FAILURE_SECONDS = 300
# Databases whose first-page detail this process has already built once.
_WARMED: set[str] = set()
# Databases this process has seen with a ready index, and those with a pass running.
_READY: set[str] = set()
_RUNNING: set[str] = set()
_UNAVAILABLE_DATABASES: set[str] = set()
# Albums checked by a running backfill of this process, per database.
_PROGRESS: dict[str, dict[str, int]] = {}
# Databases whose duplicate results this process has seen ready.
_DUPLICATES_READY: set[str] = set()

_LIBRARY_SQL = """
    select libraries.id
    from app.bootstrap_owners owners
    join library.libraries libraries
      on libraries.owner_account_id = owners.account_id
     and libraries.name = 'Local Library'
     and libraries.library_kind = 'local'
    where owners.owner_key = 'local-bootstrap-owner'
    limit 1
"""

# The albums whose items can change with the marked ones: themselves and every
# album sharing a duplicate identity with them now (0093 index) or when they
# were last indexed. Also each scoped album's current identities.
_SCOPE_SQL = """
    with identities as materialized (
      select library.duplicate_identity_text(files.scan_file_album_artist) as artist_identity,
             library.duplicate_identity_text(files.scan_file_album) as album_identity,
             library.duplicate_identity_year(files.scan_file_year) as album_year
      from library.local_tracks tracks
      join library.local_track_files files on files.track_id = tracks.id
      where tracks.library_id = %(library_id)s
        and tracks.album_id = any(%(album_ids)s::bigint[])
        and files.scan_cache_stale is false
        and files.scan_file_entry_is_object is true
      union
      select split_part(old, chr(31), 1), split_part(old, chr(31), 2),
             nullif(split_part(old, chr(31), 3), '')::integer
      from unnest(%(old_identities)s::text[]) old
    ), scoped as (
      select unnest(%(album_ids)s::bigint[]) as id
      union
      select tracks.album_id
      from identities
      join library.local_track_files files
        on library.duplicate_identity_text(files.scan_file_album_artist) = identities.artist_identity
       and library.duplicate_identity_text(files.scan_file_album) = identities.album_identity
       and library.duplicate_identity_year(files.scan_file_year) = identities.album_year
       and files.scan_cache_stale is false
       and files.scan_file_entry_is_object is true
      join library.local_tracks tracks on tracks.id = files.track_id
      where identities.artist_identity <> '' and identities.album_identity <> ''
        and tracks.library_id = %(library_id)s and tracks.album_id is not null
    )
    select scoped.id as album_id, albums.album_key,
      coalesce(array(
        select distinct concat_ws(chr(31),
          library.duplicate_identity_text(files.scan_file_album_artist),
          library.duplicate_identity_text(files.scan_file_album),
          coalesce(library.duplicate_identity_year(files.scan_file_year)::text, ''))
        from library.local_tracks tracks
        join library.local_track_files files on files.track_id = tracks.id
        where tracks.album_id = scoped.id
          and files.scan_cache_stale is false
          and files.scan_file_entry_is_object is true
      ), '{}'::text[]) as identities
    from scoped
    left join library.local_albums albums on albums.id = scoped.id and albums.library_id = %(library_id)s
"""

_DUPLICATE_RESULT_SQL = """
    insert into library.album_duplicate_results (library_id, album_id, album_key, result, linked_album_ids)
    values (%(library_id)s, %(album_id)s, %(album_key)s, %(result)s::jsonb, %(linked_album_ids)s::bigint[])
"""

# The albums whose stored duplicate result can change with the marked ones without sharing
# their file identities: a stray copy's tracks take its owner's identity, and setting or
# clearing that link marks only the stray album. So follow the stored references both
# ways, and the marked albums' current owners.
_LINKED_ALBUMS_SQL = """
    select unnest(%(album_ids)s::bigint[]) as album_id
    union
    select results.album_id
    from library.album_duplicate_results results
    where results.library_id = %(library_id)s and results.linked_album_ids && %(album_ids)s::bigint[]
    union
    select unnest(results.linked_album_ids)
    from library.album_duplicate_results results
    where results.library_id = %(library_id)s and results.album_id = any(%(album_ids)s::bigint[])
    union
    select (albums.metadata #>> '{stray_duplicate_of,album_id}')::bigint
    from library.local_albums albums
    where albums.library_id = %(library_id)s and albums.id = any(%(album_ids)s::bigint[])
      and albums.metadata #>> '{stray_duplicate_of,album_id}' is not null
"""

_UPSERT_SQL = """
    insert into library.problematic_index_items
      (library_id, item_key, album_id, sort_name, sort_artist, sort_year, sort_key,
       search_text, duplicate_identities, item)
    values (%(library_id)s, %(item_key)s, %(album_id)s, %(sort_name)s, %(sort_artist)s,
            %(sort_year)s, %(sort_key)s, %(search_text)s, %(duplicate_identities)s, %(item)s::jsonb)
    on conflict (library_id, item_key) do update set
      album_id = excluded.album_id, sort_name = excluded.sort_name,
      sort_artist = excluded.sort_artist, sort_year = excluded.sort_year,
      sort_key = excluded.sort_key, search_text = excluded.search_text,
      duplicate_identities = excluded.duplicate_identities, item = excluded.item
"""


def _browse():
    from music_app.services import library_browse_postgres as browse
    return browse


def _value(row: object, key: str) -> Any:
    return _browse()._row_mapping(row).get(key)


def _is_undefined_table(error: BaseException) -> bool:
    return getattr(error, "sqlstate", None) == "42P01"


def search_text(item: Mapping[str, object]) -> str:
    """The text a Problematic Files search matches, lowered (same as the list filter)."""
    return _browse()._problematic_summary_search_text(item)


def _duplicate_result_rows(repository: Any, connection: Any, library_id: int,
                           albums: Mapping[str, int]) -> list[dict[str, object]]:
    """The stored duplicate results of ``albums`` (album key -> album id) that change a card."""
    encode = _browse().encode_duplicate_result
    return [
        {"library_id": library_id, "album_id": albums[key], "album_key": key, "result": encode(result),
         "linked_album_ids": result["_linked_album_ids"]}
        for key, result in repository.compute_duplicate_results_for_album_keys(connection, albums).items()
    ]


def _index_rows(repository: Any, connection: Any, library_id: int, album_ids: list[int],
                include_loose: bool, *, duplicates: bool = True,
                ) -> tuple[list[dict[str, object]], list[dict[str, object]], list[int]]:
    """Fresh items and duplicate results of ``album_ids`` (plus duplicate peers), and the
    loose-track items when asked.

    Returns the item rows, the duplicate result rows (none without ``duplicates``) and
    every album id whose old rows they replace. A pair a save formed or broke is in scope
    through either identity or through the stored references, so both albums' results are
    rewritten together.
    """
    browse = _browse()
    if duplicates and album_ids:
        album_ids = sorted({int(_value(row, "album_id")) for row in connection.execute(
            _LINKED_ALBUMS_SQL, {"library_id": library_id, "album_ids": album_ids},
        ).fetchall()})
    old_identities = [
        identity
        for row in connection.execute(
            """select unnest(duplicate_identities) as identity from library.problematic_index_items
               where library_id = %(library_id)s and album_id = any(%(album_ids)s::bigint[])""",
            {"library_id": library_id, "album_ids": album_ids},
        ).fetchall()
        if (identity := _value(row, "identity"))
    ] if album_ids else []
    scope = connection.execute(
        _SCOPE_SQL,
        {"library_id": library_id, "album_ids": album_ids, "old_identities": old_identities},
    ).fetchall() if album_ids else []
    scoped_ids = sorted({int(_value(row, "album_id")) for row in scope})
    identities_by_album = {int(_value(row, "album_id")): list(_value(row, "identities") or []) for row in scope}
    album_keys = [str(key) for row in scope if (key := _value(row, "album_key"))]
    existing_ids = [album_id for row in scope if _value(row, "album_key") and (album_id := int(_value(row, "album_id")))]
    duplicate_rows = _duplicate_result_rows(repository, connection, library_id, {
        str(_value(row, "album_key")): int(_value(row, "album_id")) for row in scope if _value(row, "album_key")
    }) if duplicates else []
    rows = [
        # An album emptied by a move or rename keeps its row without tracks; the list
        # never shows it (only missing albums are listed without files, from their own rows).
        row for row in (
            repository._load_problematic_file_rows(connection=connection, album_ids=existing_ids)
            if existing_ids else []
        )
        if _value(row, "track_id") is not None
    ]
    if include_loose:
        rows = [*rows, *repository._load_problematic_loose_file_rows(connection=connection, limit=None)]
    missing_rows = (
        repository._load_missing_album_rows(connection=connection, album_keys=album_keys)
        if album_keys else []
    )
    if not rows and not missing_rows:
        return [], duplicate_rows, scoped_ids
    payload = repository._build_problematic_files_payload_from_rows(
        connection=connection,
        rows=rows,
        missing_rows=missing_rows,
        include_initial_detail=False,
        cache_albums=True,
    )
    album_id_by_key: dict[str, int] = {}
    album_id_by_path: dict[str, int] = {}
    for row in [*rows, *missing_rows]:
        if (album_id := _value(row, "album_id")) is None:
            continue
        if key := _value(row, "album_key"):
            album_id_by_key[str(key)] = int(album_id)
        if path := _value(row, "file_private_path"):
            album_id_by_path[str(path)] = int(album_id)
    albums = payload.get(browse._PROBLEMATIC_PAGE_ALBUMS_KEY) or {}
    index_rows = []
    for item in payload.get("items") or []:
        key = str(item.get("key") or "")
        album = albums.get(key) or {}
        album_id = None
        if not browse._is_problematic_loose_tracks_key(key):
            album_id = next((
                album_id_by_key.get(candidate) or album_id_by_path.get(candidate)
                for candidate in (str(album.get("_persisted_album_key") or ""), key, *map(str, item.get("track_paths") or []))
                if album_id_by_key.get(candidate) or album_id_by_path.get(candidate)
            ), None)
            if album_id is None:
                # Without its album an item could never be replaced again.
                raise RuntimeError(f"Problematic Files index found no album for {key!r}.")
        sort_name, sort_artist, sort_year, sort_key = browse._problematic_summary_sort_key(item)
        index_rows.append({
            "library_id": library_id,
            "item_key": key,
            "album_id": album_id,
            "sort_name": sort_name,
            "sort_artist": sort_artist,
            "sort_year": sort_year,
            "sort_key": sort_key,
            "search_text": search_text(item),
            "duplicate_identities": identities_by_album.get(album_id, []) if album_id is not None else [],
            "item": json.dumps(item, default=str),
        })
    return index_rows, duplicate_rows, scoped_ids


def _write(connection: Any, library_id: int, index_rows: list[dict[str, object]],
           duplicate_rows: list[dict[str, object]], replaced_album_ids: list[int], *,
           replace_loose: bool) -> None:
    connection.execute(
        """delete from library.problematic_index_items
           where library_id = %(library_id)s
             and (album_id = any(%(album_ids)s::bigint[]) or (%(loose)s and album_id is null))""",
        {"library_id": library_id, "album_ids": replaced_album_ids, "loose": replace_loose},
    )
    connection.execute(
        """delete from library.album_duplicate_results
           where library_id = %(library_id)s and album_id = any(%(album_ids)s::bigint[])""",
        {"library_id": library_id, "album_ids": replaced_album_ids},
    )
    if index_rows:
        connection.cursor().executemany(_UPSERT_SQL, index_rows)
    if duplicate_rows:
        connection.cursor().executemany(_DUPLICATE_RESULT_SQL, duplicate_rows)


def _library_id(connection: Any) -> int | None:
    row = connection.execute(_LIBRARY_SQL).fetchone()
    return int(_value(row, "id")) if row is not None else None


def _state(connection: Any, library_id: int) -> str | None:
    row = connection.execute(
        "select builder_version, status from library.problematic_index_state where library_id = %s",
        (library_id,),
    ).fetchone()
    if row is None or _value(row, "builder_version") != BUILDER_VERSION:
        return None
    return str(_value(row, "status"))


def _worker_connection(repository: Any) -> Any:
    """The maintenance worker's own connection: it keeps a session lock for a whole pass,
    which a pool lease must not (AGENTS.md)."""
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(repository._database_url, row_factory=dict_row, autocommit=True)


def _locked(connection: Any, library_id: int) -> bool:
    row = connection.execute(
        "select pg_try_advisory_lock(%s, %s::integer) as locked", (_LOCK_NAMESPACE, library_id),
    ).fetchone()
    return bool(_value(row, "locked"))


def _locked_for_transaction(connection: Any, library_id: int) -> bool:
    row = connection.execute(
        "select pg_try_advisory_xact_lock(%s, %s::integer) as locked", (_LOCK_NAMESPACE, library_id),
    ).fetchone()
    return bool(_value(row, "locked"))


def _unlock(connection: Any, library_id: int) -> None:
    connection.execute("select pg_advisory_unlock(%s, %s::integer)", (_LOCK_NAMESPACE, library_id))


def _available(repository: Any) -> bool:
    enabled = str(repository._config.get(ENABLED_KEY, os.environ.get(ENABLED_KEY, "1")))
    return (
        enabled.strip().casefold() not in {"0", "false", "no"}
        and repository._use_shared_connection_pool
        and repository._database_url not in _UNAVAILABLE_DATABASES
    )


def refresh(repository: Any, *, inline_limit: int = INLINE_ALBUM_LIMIT) -> bool:
    """Bring the index up to date when that is cheap; whether it may be read now.

    A missing or outdated index queues the backfill, and many marked albums
    queue a background pass; either way the caller keeps its previous path
    only while no ready index exists. A request never waits for a running pass.
    """
    if not _available(repository):
        return False
    try:
        # The checks run on a pooled connection (a new one costs ~250 ms); only evaluating
        # marked albums needs a connection of its own.
        with repository._browse_connection_context() as connection:
            library_id = _library_id(connection)
            ready = library_id is not None and _state(connection, library_id) == "ready"
            marks = connection.execute(
                """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
                   where library_id = %s limit %s""",
                (library_id, inline_limit + 1),
            ).fetchall() if ready else []
        if library_id is None:
            return False
        if not ready:
            queue_maintenance(repository)
            return False
        _READY.add(repository._database_url)
        if not marks:
            return True
        if len(marks) > inline_limit:
            queue_maintenance(repository)
            return True
        with repository._connect_to_database() as connection:
            _drain(repository, connection, library_id, marks, try_lock=True)
        return True
    except Exception as error:
        if _is_undefined_table(error):
            _UNAVAILABLE_DATABASES.add(repository._database_url)
            return False
        if getattr(error, "sqlstate", None) == "40001":  # serialization_failure
            return True  # another evaluator wrote these albums while this one took the lock
        _LOGGER.warning("Problematic Files index refresh failed.", exc_info=True)
        return False


def _drain(repository: Any, connection: Any, library_id: int, marks: list[object], *,
           try_lock: bool = False) -> None:
    """Evaluate ``marks`` and clear exactly those marks (a later mark survives).

    With ``try_lock`` (a request on a pool lease) only if no other evaluator holds them:
    that lock ends with the transaction and is never waited for.
    """
    album_ids = sorted({int(_value(row, "album_id")) for row in marks} - {0})
    include_loose = any(int(_value(row, "album_id")) == 0 for row in marks)
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read")
        if try_lock and not _locked_for_transaction(connection, library_id):
            return
        connection.execute("set local work_mem = '16MB'")
        connection.execute("set local jit = off")
        index_rows, duplicate_rows, replaced = _index_rows(repository, connection, library_id, album_ids, include_loose)
        _write(connection, library_id, index_rows, duplicate_rows, sorted({*replaced, *album_ids}),
               replace_loose=include_loose)
    connection.execute(
        """delete from library.problematic_index_dirty_albums dirty
           using unnest(%(album_ids)s::bigint[], %(xids)s::text[]) claimed(album_id, marked_xid)
           where dirty.library_id = %(library_id)s and dirty.album_id = claimed.album_id
             and dirty.marked_xid = claimed.marked_xid::xid8""",
        {
            "library_id": library_id,
            "album_ids": [int(_value(row, "album_id")) for row in marks],
            "xids": [str(_value(row, "marked_xid")) for row in marks],
        },
    )


def _backfill(repository: Any, connection: Any, library_id: int) -> None:
    """Fill the index from the whole library, then clear the marks it covered."""
    connection.execute(
        """insert into library.problematic_index_state (library_id, builder_version, status)
           values (%s, %s, 'building')
           on conflict (library_id) do update set builder_version = excluded.builder_version,
             status = 'building', updated_at = now()""",
        (library_id, BUILDER_VERSION),
    )
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read")
        connection.execute("set local work_mem = '16MB'")
        connection.execute("set local jit = off")
        snapshot = str(_value(connection.execute("select pg_current_snapshot()::text as snapshot").fetchone(), "snapshot"))
        candidate_ids = sorted(repository._problematic_candidate_album_ids(connection))
        missing_ids = sorted({
            int(album_id) for row in repository._load_missing_album_rows(connection=connection)
            if (album_id := _value(row, "album_id")) is not None
        })
        album_ids = sorted({*candidate_ids, *missing_ids})
        _PROGRESS[repository._database_url] = {"done": 0, "total": len(album_ids)}
        index_rows: list[dict[str, object]] = []
        for start in range(0, max(len(album_ids), 1), BACKFILL_BATCH):
            # The duplicate results backfill after this pass (see below).
            rows, _duplicate_rows, _replaced = _index_rows(
                repository, connection, library_id, album_ids[start:start + BACKFILL_BATCH],
                include_loose=start == 0, duplicates=False,
            )
            index_rows.extend(rows)
            _PROGRESS[repository._database_url] = {
                "done": min(start + BACKFILL_BATCH, len(album_ids)), "total": len(album_ids)}
        connection.execute("delete from library.problematic_index_items where library_id = %s", (library_id,))
        connection.cursor().executemany(_UPSERT_SQL, list({row["item_key"]: row for row in index_rows}.values()))
        connection.execute(
            """update library.problematic_index_state set status = 'ready', updated_at = now()
               where library_id = %s and builder_version = %s""",
            (library_id, BUILDER_VERSION),
        )
    connection.execute(
        """delete from library.problematic_index_dirty_albums
           where library_id = %s and pg_visible_in_snapshot(marked_xid, %s::pg_snapshot)""",
        (library_id, snapshot),
    )
    # Those marks also named albums whose stored duplicate results they would have
    # refreshed: rebuild the results as well (only after a builder-version change).
    connection.execute(
        "update library.album_duplicate_results_state set status = 'building' where library_id = %s",
        (library_id,),
    )
    _DUPLICATES_READY.discard(repository._database_url)


def _duplicate_results_state(connection: Any, library_id: int) -> str | None:
    row = connection.execute(
        "select version, status from library.album_duplicate_results_state where library_id = %s",
        (library_id,),
    ).fetchone()
    if row is None or _value(row, "version") != DUPLICATE_RESULTS_VERSION:
        return None
    return str(_value(row, "status"))


def _backfill_duplicate_results(repository: Any, connection: Any, library_id: int) -> None:
    """Store every album's duplicate result (one-time pass, with its own progress).

    The journal marks stay: the Problematic Files items still need them, and draining
    them afterwards rewrites the results of albums changed during this pass.
    """
    started = time.monotonic()
    connection.execute(
        """insert into library.album_duplicate_results_state (library_id, version, status)
           values (%s, %s, 'building')
           on conflict (library_id) do update set version = excluded.version,
             status = 'building', updated_at = now()""",
        (library_id, DUPLICATE_RESULTS_VERSION),
    )
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read")
        connection.execute("set local work_mem = '16MB'")
        connection.execute("set local jit = off")
        albums = {
            str(_value(row, "album_key")): int(_value(row, "id"))
            for row in connection.execute(
                "select id, album_key from library.local_albums where library_id = %s", (library_id,),
            ).fetchall()
        }
        album_keys = sorted(albums)
        rows: list[dict[str, object]] = []
        for start in range(0, len(album_keys), BACKFILL_BATCH):
            batch = album_keys[start:start + BACKFILL_BATCH]
            rows.extend(_duplicate_result_rows(repository, connection, library_id, {key: albums[key] for key in batch}))
        connection.execute("delete from library.album_duplicate_results where library_id = %s", (library_id,))
        if rows:
            connection.cursor().executemany(_DUPLICATE_RESULT_SQL, rows)
        connection.execute(
            """update library.album_duplicate_results_state set status = 'ready', updated_at = now()
               where library_id = %s and version = %s""",
            (library_id, DUPLICATE_RESULTS_VERSION),
        )
    _LOGGER.info("Duplicate results backfill completed %s", json.dumps({
        "albums": len(album_keys), "stored_results": len(rows),
        "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
    }))


def _maintain(repository: Any) -> None:
    """Backfill when no ready index exists, then evaluate every marked album."""
    with _QUEUED_LOCK:
        # A request arriving from now on queues another pass for marks made meanwhile.
        _QUEUED.discard(repository._database_url)
        _RUNNING.add(repository._database_url)
    try:
        with _worker_connection(repository) as connection:
            library_id = _library_id(connection)
            if library_id is None or not _locked(connection, library_id):
                return
            try:
                if _state(connection, library_id) != "ready":
                    try:
                        _backfill(repository, connection, library_id)
                    finally:
                        _PROGRESS.pop(repository._database_url, None)
                _READY.add(repository._database_url)
                if _duplicate_results_state(connection, library_id) != "ready":
                    _backfill_duplicate_results(repository, connection, library_id)
                _DUPLICATES_READY.add(repository._database_url)
                while marks := connection.execute(
                    """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
                       where library_id = %s order by album_id limit %s""",
                    (library_id, BACKFILL_BATCH),
                ).fetchall():
                    _drain(repository, connection, library_id, marks)
                first = connection.execute(
                    """select item_key from library.problematic_index_items where library_id = %s
                       order by sort_name, sort_artist, sort_year, sort_key limit 1""",
                    (library_id,),
                ).fetchone()
            finally:
                _unlock(connection, library_id)
        # The first page opens on this album's detail: building it once per process warms the
        # connection pool and alias maps a restarted server would otherwise pay on first open.
        if first is not None and repository._database_url not in _WARMED:
            _WARMED.add(repository._database_url)
            repository.build_problematic_file_detail_payload(_value(first, "item_key"))
    except Exception:
        _LOGGER.warning("Problematic Files index maintenance failed; retrying in %d s.", RETRY_AFTER_FAILURE_SECONDS,
                        exc_info=True)
        with _QUEUED_LOCK:
            _RETRY_NOT_BEFORE[repository._database_url] = time.monotonic() + RETRY_AFTER_FAILURE_SECONDS
    finally:
        with _QUEUED_LOCK:
            _RUNNING.discard(repository._database_url)


def duplicate_results_readable(repository: Any) -> bool:
    """Whether cards may read stored duplicate results now, after evaluating the last save's
    marks unless a running pass holds them. Readiness comes first, and a read never waits.
    False until both backfills are done; /status shows that work as pending."""
    if not _available(repository):
        return False
    database_url = repository._database_url
    if database_url not in _DUPLICATES_READY:
        try:
            with repository._browse_connection_context() as connection:
                library_id = _library_id(connection)
                ready = library_id is not None and _duplicate_results_state(connection, library_id) == "ready"
        except Exception as error:
            if _is_undefined_table(error):
                return False
            raise
        if not ready:
            queue_maintenance(repository)
            return False
        _DUPLICATES_READY.add(database_url)
    return refresh(repository)


def indexing_progress(repository: Any) -> dict[str, int] | None:
    """While no ready index exists: the backfill's progress (zeros until it knows its albums).

    None when this repository does not use the index at all.
    """
    if not _available(repository):
        return None
    return dict(_PROGRESS.get(repository._database_url) or {"done": 0, "total": 0})


def maintain_now(repository: Any) -> bool:
    """One maintenance pass in this thread (fixture preparation); whether the index is ready."""
    if not _available(repository):
        return False
    _maintain(repository)
    with _QUEUED_LOCK:
        return repository._database_url in _READY


def in_progress(repository: Any) -> bool:
    """For /status: index work is pending (no ready index seen yet, or a pass queued or running).

    False for a repository that does not keep the index (it is disabled, or a browse-only
    instance leaves the work to the writer).
    """
    if not _available(repository) or repository._config.get("SHARED_LIBRARY_BROWSE_ONLY"):
        return False
    database_url = repository._database_url
    with _QUEUED_LOCK:
        pending = database_url not in _READY or database_url not in _DUPLICATES_READY
        busy = database_url in _QUEUED or database_url in _RUNNING
    if pending and not busy:
        # Nothing has checked this database yet (no startup pass, no Problematic Files read).
        queue_maintenance(repository)
    return pending or busy


def queue_maintenance(repository: Any) -> None:
    """Backfill or evaluate marked albums in the background (startup, saves, watcher passes)."""
    if not _available(repository) or repository._config.get("SHARED_LIBRARY_BROWSE_ONLY"):
        return
    with _QUEUED_LOCK:
        # A failed pass (a backfill costs minutes) waits before the next poll may start another.
        if repository._database_url in _QUEUED or time.monotonic() < _RETRY_NOT_BEFORE.get(repository._database_url, 0):
            return
        _QUEUED.add(repository._database_url)
    _EXECUTOR.submit(_maintain, repository)


def wait_for_background_work(timeout: float = 600) -> None:
    """Tests: wait until queued index work has finished."""
    for _ in range(3):
        _EXECUTOR.submit(lambda: None).result(timeout=timeout)


def read_page(repository: Any, *, limit: int | None, after: tuple[str, str, str, str] | None,
              needle: str = "") -> list[dict[str, object]] | None:
    """Up to ``limit + 1`` items (every item when None) after ``after`` matching ``needle``.

    None when no ready index exists yet.
    """
    if not refresh(repository):
        return None
    with repository._browse_connection_context() as connection:
        rows = connection.execute(
            f"""select items.item
                from library.problematic_index_items items
                where items.library_id = ({_LIBRARY_SQL})
                  and (%(after)s::text[] is null
                       or (items.sort_name, items.sort_artist, items.sort_year, items.sort_key)
                          > ((%(after)s::text[])[1], (%(after)s::text[])[2],
                             (%(after)s::text[])[3], (%(after)s::text[])[4]))
                  and (%(needle)s = '' or strpos(items.search_text, %(needle)s) > 0)
                order by items.sort_name, items.sort_artist, items.sort_year, items.sort_key
                limit %(limit)s""",
            {"after": list(after) if after is not None else None, "needle": needle,
             "limit": None if limit is None else limit + 1},
        ).fetchall()
    return [
        json.loads(item) if isinstance(item, str) else dict(item)
        for row in rows
        if (item := _value(row, "item")) is not None
    ]


def listed_as_missing(repository: Any, item_key: str, connection: Any) -> bool | None:
    """Whether the index lists ``item_key`` as a missing album; None when it cannot say."""
    if not _available(repository):
        return None
    try:
        row = connection.execute(
            f"""select item -> 'problem_reasons' ? 'Album not found' as missing
                from library.problematic_index_items
                where library_id = ({_LIBRARY_SQL}) and item_key = %s""",
            (item_key,),
        ).fetchone()
    except Exception as error:
        if _is_undefined_table(error):
            _UNAVAILABLE_DATABASES.add(repository._database_url)
            return None
        raise
    return None if row is None else bool(_value(row, "missing"))


def loose_group_detail(repository: Any, item_key: str) -> dict[str, object] | None:
    """The detail of an indexed loose-track group, from its files alone."""
    if not refresh(repository):
        return None
    browse = _browse()
    with repository._browse_connection_context() as connection:
        row = connection.execute(
            f"""select item from library.problematic_index_items
                where library_id = ({_LIBRARY_SQL}) and item_key = %s""",
            (item_key,),
        ).fetchone()
        item = _value(row, "item") if row is not None else None
        item = json.loads(item) if isinstance(item, str) else item
        paths = {str(path) for path in (item or {}).get("track_paths") or [] if str(path or "").strip()}
        if not paths:
            return None
        rows = repository._load_problematic_loose_file_rows(
            connection=connection, limit=None, album_keys={item_key}, seed_private_paths=paths,
        )
        payload = repository._build_problematic_files_payload_from_rows(
            connection=connection, rows=rows, missing_rows=[], include_initial_detail=False, cache_albums=True,
        )
    album = (payload.get(browse._PROBLEMATIC_PAGE_ALBUMS_KEY) or {}).get(item_key)
    return browse._problematic_album_detail_payload(album) if album else None
