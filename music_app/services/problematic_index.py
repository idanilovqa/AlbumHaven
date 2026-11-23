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
from collections.abc import Callable, Mapping
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
# What fills the duplicate results, and the migration that creates them: named by the
# startup refusal.
PREPARE_COMMAND = "python scripts/prepare_duplicate_results.py"
DUPLICATE_RESULTS_MIGRATION = "0268_create_album_duplicate_results.sql"
# A refused start's exit code; uvicorn's own 3 covers every other failed start.
REFUSED_TO_START_EXIT_CODE = 78
# How long a starting app waits for its database, so a reboot in the wrong order recovers.
DATABASE_WAIT_SECONDS = 120
_DATABASE_RETRY_SECONDS = 5
_CONNECT_TIMEOUT_SECONDS = 15  # as the shared pool's
# More marked albums than this are evaluated in the background, not by a read.
INLINE_ALBUM_LIMIT = 50
# Albums evaluated per transaction by the backfill.
BACKFILL_BATCH = 500
# How a clear takes marks: in key order, never waiting for one a writer holds. A writer marks its albums,
# then 0, so a clear that waited could close the cycle (40P01). A skipped mark stays for a later pass.
_TAKE_FREE_MARKS = "order by album_id for update skip locked"
# How often one pass evaluates again because tag saves committed during it.
OUTRUN_RETRIES = 20
_LOCK_NAMESPACE = 188  # pg advisory lock (namespace, library id)
_STEP_LOCK_NAMESPACE = 268  # held for the deploy step's whole run; the startup gate only looks
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
# Lateral subqueries with OFFSET 0 keep every read a lookup per track, identity or album. As
# plain joins the planner hash-joined every active file once an album was a large share of it.
_SCOPE_SQL = """
    with identities as materialized (
      select library.duplicate_identity_text(files.scan_file_album_artist) as artist_identity,
             library.duplicate_identity_text(files.scan_file_album) as album_identity,
             library.duplicate_identity_year(files.scan_file_year) as album_year
      from library.local_tracks tracks
      cross join lateral (
        select files.scan_file_album_artist, files.scan_file_album, files.scan_file_year
        from library.local_track_files files
        where files.track_id = tracks.id
          and files.scan_cache_stale is false
          and files.scan_file_entry_is_object is true
        offset 0
      ) files
      where tracks.library_id = %(library_id)s
        and tracks.album_id = any(%(album_ids)s::bigint[])
      union
      select split_part(old, chr(31), 1), split_part(old, chr(31), 2),
             nullif(split_part(old, chr(31), 3), '')::integer
      from unnest(%(old_identities)s::text[]) old
    ), scoped as (
      select unnest(%(album_ids)s::bigint[]) as id
      union
      select tracks.album_id
      from identities
      cross join lateral (
        select files.track_id
        from library.local_track_files files
        where library.duplicate_identity_text(files.scan_file_album_artist) = identities.artist_identity
          and library.duplicate_identity_text(files.scan_file_album) = identities.album_identity
          and library.duplicate_identity_year(files.scan_file_year) = identities.album_year
          and files.scan_cache_stale is false
          and files.scan_file_entry_is_object is true
        offset 0
      ) files
      cross join lateral (
        select tracks.album_id
        from library.local_tracks tracks
        where tracks.id = files.track_id
          and tracks.library_id = %(library_id)s and tracks.album_id is not null
        offset 0
      ) tracks
      where identities.artist_identity <> '' and identities.album_identity <> ''
    )
    select scoped.id as album_id, albums.album_key,
      coalesce(array(
        select distinct concat_ws(chr(31),
          library.duplicate_identity_text(files.scan_file_album_artist),
          library.duplicate_identity_text(files.scan_file_album),
          coalesce(library.duplicate_identity_year(files.scan_file_year)::text, ''))
        from library.local_tracks tracks
        cross join lateral (
          select files.scan_file_album_artist, files.scan_file_album, files.scan_file_year
          from library.local_track_files files
          where files.track_id = tracks.id
            and files.scan_cache_stale is false
            and files.scan_file_entry_is_object is true
          offset 0
        ) files
        where tracks.album_id = scoped.id
      ), '{}'::text[]) as identities
    from scoped
    left join lateral (
      select albums.album_key
      from library.local_albums albums
      where albums.id = scoped.id and albums.library_id = %(library_id)s
      offset 0
    ) albums on true
"""

_DUPLICATE_RESULT_SQL = """
    insert into library.album_duplicate_results (library_id, album_id, album_key, result, linked_album_ids)
    values (%(library_id)s, %(album_id)s, %(album_key)s, %(result)s::jsonb, %(linked_album_ids)s::bigint[])
    on conflict (library_id, album_id) do update set album_key = excluded.album_key,
      result = excluded.result, linked_album_ids = excluded.linked_album_ids
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
      (library_id, item_key, album_id, root_id, sort_name, sort_artist, sort_year, sort_key,
       search_text, duplicate_identities, item)
    values (%(library_id)s, %(item_key)s, %(album_id)s, %(root_id)s, %(sort_name)s, %(sort_artist)s,
            %(sort_year)s, %(sort_key)s, %(search_text)s, %(duplicate_identities)s, %(item)s::jsonb)
    on conflict (library_id, item_key) do update set
      album_id = excluded.album_id, root_id = excluded.root_id, sort_name = excluded.sort_name,
      sort_artist = excluded.sort_artist, sort_year = excluded.sort_year,
      sort_key = excluded.sort_key, search_text = excluded.search_text,
      duplicate_identities = excluded.duplicate_identities, item = excluded.item
"""


class PreparationError(RuntimeError):
    """Why the deploy step could not make the index ready; safe to show the operator."""


class NotReadyToServeError(PreparationError):
    """Why the app refuses to start serving."""


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
                loose_folders: list[tuple[int, str]] | None = None,
                ) -> tuple[list[dict[str, object]], list[dict[str, object]], list[int]]:
    """Fresh items and duplicate results of ``album_ids`` (plus duplicate peers), and the
    loose-track items of ``loose_folders`` (root id, folder), or of every loose group with
    ``include_loose``. Loose groups are read under every root: a read applies root activity.

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
        loose_folders = [(int(_value(row, "root_id")), str(_value(row, "folder"))) for row in connection.execute(
            "select root_id, folder from library.problematic_loose_groups where library_id = %s", (library_id,),
        ).fetchall()]
    loose_rows = repository._load_problematic_loose_file_rows(
        connection=connection, limit=None, membership_folders=set(loose_folders), all_roots=True,
    ) if loose_folders else []
    rows = [*rows, *loose_rows]
    root_by_loose_key = {
        str(_value(row, "album_key")): _value(row, "file_library_root_id") for row in loose_rows
    }
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
            "root_id": root_by_loose_key.get(key) if album_id is None else None,
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
           replace_loose: bool, loose_keys: list[str] = ()) -> None:
    """``loose_keys`` names the loose groups re-evaluated: their items are replaced by key, and a group
    with no loose file left loses its item."""
    connection.execute(
        """delete from library.problematic_index_items
           where library_id = %(library_id)s
             and (album_id = any(%(album_ids)s::bigint[]) or (%(loose)s and album_id is null)
                  or item_key = any(%(loose_keys)s::text[]))""",
        {"library_id": library_id, "album_ids": replaced_album_ids, "loose": replace_loose,
         "loose_keys": list(loose_keys)},
    )
    if index_rows:
        connection.cursor().executemany(_UPSERT_SQL, index_rows)
    # Last, and in album order, as a tag save writes them: the two cannot deadlock, and a
    # save waits at most for this pass's commit. Where a save committed first, this
    # repeatable-read pass fails here (40001) and evaluates again.
    connection.execute(
        """select album_id from library.album_duplicate_results
           where library_id = %(library_id)s and album_id = any(%(album_ids)s::bigint[])
           order by album_id for update""",
        {"library_id": library_id, "album_ids": replaced_album_ids},
    ).fetchall()
    connection.execute(
        """delete from library.album_duplicate_results
           where library_id = %(library_id)s and album_id = any(%(album_ids)s::bigint[])""",
        {"library_id": library_id, "album_ids": replaced_album_ids},
    )
    if duplicate_rows:
        connection.cursor().executemany(
            _DUPLICATE_RESULT_SQL, sorted(duplicate_rows, key=lambda row: int(row["album_id"])),
        )


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


def _enabled(config: Mapping[str, object]) -> bool:
    enabled = str(config.get(ENABLED_KEY, os.environ.get(ENABLED_KEY, "1")))
    return enabled.strip().casefold() not in {"0", "false", "no"}


def _available(repository: Any) -> bool:
    return (
        _enabled(repository._config)
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
           try_lock: bool = False) -> int:
    """Evaluate ``marks`` and clear exactly those marks (a later mark survives); how many it cleared.

    With ``try_lock`` (a request on a pool lease) only if no other evaluator holds them:
    that lock ends with the transaction and is never waited for.
    """
    album_ids = sorted({int(_value(row, "album_id")) for row in marks} - {0})
    include_loose = any(int(_value(row, "album_id")) == 0 for row in marks)
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read")
        if try_lock and not _locked_for_transaction(connection, library_id):
            return 0
        connection.execute("set local work_mem = '16MB'")
        connection.execute("set local jit = off")
        index_rows, duplicate_rows, replaced = _index_rows(repository, connection, library_id, album_ids, include_loose)
        _write(connection, library_id, index_rows, duplicate_rows, sorted({*replaced, *album_ids}),
               replace_loose=include_loose)
    return connection.execute(
        f"""with free as (
             select dirty.album_id from library.problematic_index_dirty_albums dirty
             join unnest(%(album_ids)s::bigint[], %(xids)s::text[]) claimed(album_id, marked_xid)
               on dirty.album_id = claimed.album_id and dirty.marked_xid = claimed.marked_xid::xid8
             where dirty.library_id = %(library_id)s
             {_TAKE_FREE_MARKS})
           delete from library.problematic_index_dirty_albums dirty using free
           where dirty.library_id = %(library_id)s and dirty.album_id = free.album_id""",
        {
            "library_id": library_id,
            "album_ids": [int(_value(row, "album_id")) for row in marks],
            "xids": [str(_value(row, "marked_xid")) for row in marks],
        },
    ).rowcount


def _backfill(repository: Any, connection: Any, library_id: int,
              report: Callable[[str, int, int], None] | None = None) -> None:
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
            # This pass rebuilds items only; the duplicate results have their own version.
            rows, _duplicate_rows, _replaced = _index_rows(
                repository, connection, library_id, album_ids[start:start + BACKFILL_BATCH],
                include_loose=start == 0, duplicates=False,
            )
            index_rows.extend(rows)
            done = min(start + BACKFILL_BATCH, len(album_ids))
            _PROGRESS[repository._database_url] = {"done": done, "total": len(album_ids)}
            if report:
                report("Problematic Files index", done, len(album_ids))
        connection.execute("delete from library.problematic_index_items where library_id = %s", (library_id,))
        connection.cursor().executemany(_UPSERT_SQL, list({row["item_key"]: row for row in index_rows}.values()))
        connection.execute(
            """update library.problematic_index_state set status = 'ready', updated_at = now()
               where library_id = %s and builder_version = %s""",
            (library_id, BUILDER_VERSION),
        )
    # A mark also says a stored duplicate result may be out of date. Ready results stay
    # readable through this pass and keep their marks for the evaluation that follows it;
    # otherwise their own backfill follows and covers what this pass saw.
    if _duplicate_results_state(connection, library_id) != "ready":
        connection.execute(
            f"""with free as (
                 select album_id from library.problematic_index_dirty_albums
                 where library_id = %(library_id)s and pg_visible_in_snapshot(marked_xid, %(snapshot)s::pg_snapshot)
                 {_TAKE_FREE_MARKS})
               delete from library.problematic_index_dirty_albums dirty using free
               where dirty.library_id = %(library_id)s and dirty.album_id = free.album_id""",
            {"library_id": library_id, "snapshot": snapshot},
        )


def _duplicate_results_state(connection: Any, library_id: int) -> str | None:
    row = connection.execute(
        "select version, status from library.album_duplicate_results_state where library_id = %s",
        (library_id,),
    ).fetchone()
    if row is None or _value(row, "version") != DUPLICATE_RESULTS_VERSION:
        return None
    return str(_value(row, "status"))


def _backfill_duplicate_results(repository: Any, connection: Any, library_id: int,
                                report: Callable[[str, int, int], None] | None = None) -> None:
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
            if report:
                report("Duplicate results", start + len(batch), len(album_keys))
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


def _bring_up_to_date(repository: Any, connection: Any, library_id: int, *, rebuild_duplicates: bool = False,
                      report: Callable[[str, int, int], None] | None = None, walks: int = 1) -> tuple[int, int]:
    """Backfill what is not ready, then evaluate every marked album; (marks left, marks no writer holds).

    The caller holds the lock. A held mark stays for a later pass instead of being waited for. With writers
    live (background maintenance) one walk: a mark set meanwhile is the next pass's. The deploy step, with
    writers stopped, walks again while a free mark is left, up to ``walks``."""
    if rebuild_duplicates:
        # Before anything slow: an app restarted during a rebuild must not find "ready".
        connection.execute(
            """update library.album_duplicate_results_state set status = 'building', updated_at = now()
               where library_id = %s""",
            (library_id,),
        )
    if _state(connection, library_id) != "ready":
        try:
            _backfill(repository, connection, library_id, report)
        finally:
            _PROGRESS.pop(repository._database_url, None)
    _READY.add(repository._database_url)
    if _duplicate_results_state(connection, library_id) != "ready":
        _backfill_duplicate_results(repository, connection, library_id, report)
    _DUPLICATES_READY.add(repository._database_url)
    evaluated = outrun = 0
    # Walks by key, each mark tried once per walk. A drain's own writes set no mark; a writer's mark set
    # during a walk is free to take afterwards, so another walk evaluates it; a mark a writer still holds is
    # not, so it never makes the pass wait or spin.
    free = 0
    for _walk in range(max(1, walks)):
        after = -1  # from the lowest mark (0, the loose files, while it is still stored)
        while marks := connection.execute(
            """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
               where library_id = %s and album_id > %s order by album_id limit %s""",
            (library_id, after, BACKFILL_BATCH),
        ).fetchall():
            try:
                _drain(repository, connection, library_id, marks)
            except Exception as error:
                # serialization_failure: a save wrote these rows after this pass's snapshot.
                if getattr(error, "sqlstate", None) != "40001" or outrun >= OUTRUN_RETRIES:
                    raise
                outrun += 1
                continue
            after = int(_value(marks[-1], "album_id"))
            evaluated += len(marks)
            if report:
                report("Changed albums", evaluated, evaluated)
        free = _free_marks(connection, library_id)
        if not free:
            break
    left = int(_value(connection.execute(
        "select count(*) as marks from library.problematic_index_dirty_albums where library_id = %s",
        (library_id,),
    ).fetchone(), "marks"))
    return left, free


def _free_marks(connection: Any, library_id: int) -> int:
    """Marks no writer holds now: the lock test ends with its statement, so it never waits or keeps a lock."""
    return int(_value(connection.execute(
        f"""select count(*) as marks from (
              select album_id from library.problematic_index_dirty_albums
              where library_id = %s {_TAKE_FREE_MARKS}) free""",
        (library_id,),
    ).fetchone(), "marks"))


def prepare_for_serving(repository: Any, *, rebuild_duplicates: bool = False,
                        report: Callable[[str, int, int], None] | None = None) -> None:
    """The deploy step (scripts/prepare_duplicate_results.py): what maintenance does, in the
    foreground, raising instead of retrying later. A ready backfill is not redone."""
    with _worker_connection(repository) as connection:
        library_id = _library_id(connection)
        if library_id is None:
            raise PreparationError("No Local Library exists in this database.")
        if not _locked(connection, library_id):
            raise PreparationError("Another process is evaluating the index: stop every writer first.")
        # Maintenance holds the lock above too; this one says a deploy step runs, so an app
        # restarted meanwhile waits outside. Closing the connection releases it.
        connection.execute("select pg_advisory_lock(%s, %s::integer)", (_STEP_LOCK_NAMESPACE, library_id))
        try:
            held, _free = _bring_up_to_date(repository, connection, library_id, rebuild_duplicates=rebuild_duplicates,
                                            report=report, walks=OUTRUN_RETRIES + 1)
        finally:
            _unlock(connection, library_id)
    if held:
        raise PreparationError(
            f"{held} changed album(s) were held or marked again by a writer during this pass: stop every writer first.")


def serving_readiness(repository: Any) -> dict[str, object]:
    """Read-only, for the deploy check: both states and the albums still to evaluate."""
    with _worker_connection(repository) as connection:
        library_id = _library_id(connection)
        if library_id is None:
            raise PreparationError("No Local Library exists in this database.")
        marks = connection.execute(
            "select count(*) as marks from library.problematic_index_dirty_albums where library_id = %s",
            (library_id,),
        ).fetchone()
        return {
            "problematic_index": _state(connection, library_id),
            "duplicate_results": _duplicate_results_state(connection, library_id),
            "changed_albums_waiting": int(_value(marks, "marks")),
        }


def _serving_state(database_url: str, connect_timeout: int) -> tuple[bool, bool, bool, bool]:
    """Read-only: whether 0268 exists, its results are ready, the library has albums, and
    the deploy step is running.

    Plain selects, so it neither waits for the fill's locks nor takes one the fill needs.
    """
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(
        database_url, row_factory=dict_row, autocommit=True, connect_timeout=connect_timeout,
    ) as connection:
        connection.execute("set default_transaction_read_only = on")
        connection.execute("set lock_timeout = '5s'")
        tables = connection.execute(
            """select to_regclass('library.album_duplicate_results') is not null
                  and to_regclass('library.album_duplicate_results_state') is not null as present""",
        ).fetchone()
        if not _value(tables, "present"):
            return False, False, False, False
        library_id = _library_id(connection)
        if library_id is None:
            return True, False, False, False
        ready = _duplicate_results_state(connection, library_id) == "ready"
        albums = connection.execute(
            "select exists(select 1 from library.local_albums where library_id = %s) as present", (library_id,),
        ).fetchone()
        step = connection.execute(
            """select exists(
                 select 1 from pg_locks
                 where locktype = 'advisory' and granted and objsubid = 2
                   and database = (select oid from pg_database where datname = current_database())
                   and classid = %s::oid and objid = %s::oid) as running""",
            (_STEP_LOCK_NAMESPACE, library_id),
        ).fetchone()
        return True, ready, bool(_value(albums, "present")), bool(_value(step, "running"))


def _database_name(database_url: str) -> str:
    """The database for a log line: never its user or password."""
    import psycopg
    from psycopg.conninfo import conninfo_to_dict

    try:
        parts = conninfo_to_dict(database_url)
    except psycopg.Error:
        return "the configured database"
    host, port = parts.get("host", "localhost"), parts.get("port", 5432)
    return f"database {parts.get('dbname', '(default)')} on {host}:{port}"


def _wait_for_serving_state(database_url: str) -> tuple[bool, bool, bool, bool]:
    """The state, once the database answers; refuses after ``DATABASE_WAIT_SECONDS``."""
    import psycopg

    deadline = time.monotonic() + DATABASE_WAIT_SECONDS
    while True:
        timeout = min(_CONNECT_TIMEOUT_SECONDS, max(2, int(deadline - time.monotonic())))
        try:
            return _serving_state(database_url, timeout)
        except psycopg.OperationalError as error:
            # A driver's message can quote the connection string: name the failure only.
            failure = error.sqlstate or type(error).__name__
            left = deadline - time.monotonic()
            if left <= 0:
                raise NotReadyToServeError(
                    f"Album Haven will not start: {_database_name(database_url)} did not answer within "
                    f"{DATABASE_WAIT_SECONDS} s ({failure}). Start that database, then Album Haven."
                ) from None
            _LOGGER.warning(
                "Waiting for %s before starting (%s); refusing in %d s.",
                _database_name(database_url), failure, left,
            )
            time.sleep(min(_DATABASE_RETRY_SECONDS, left))
        except psycopg.Error as error:
            raise NotReadyToServeError(
                f"Album Haven will not start: {_database_name(database_url)} could not be checked "
                f"({error.sqlstate or type(error).__name__})."
            ) from None


def refuse_to_serve_until_ready(config: Mapping[str, object]) -> None:
    """The startup gate (owner, 2026-11-22), for every mode that serves gallery or search
    cards: a library with albums is served only from ready duplicate results that cards
    read, since its duplicated cards would otherwise show wrong counts. It only reads; the
    deploy step fills. An unreachable database is waited for, never assumed ready.

    An empty library has nothing to fill, so it serves and maintenance marks it ready.
    """
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not database_url:
        return
    migrated, ready, has_albums, step_running = _wait_for_serving_state(database_url)
    if not migrated:
        raise NotReadyToServeError(
            f"Album Haven will not start: this database lacks migration {DUPLICATE_RESULTS_MIGRATION}. "
            f"Apply it, then run: {PREPARE_COMMAND}"
        )
    if step_running:
        raise NotReadyToServeError(
            f"Album Haven will not start: {PREPARE_COMMAND} is running. Start once it exits 0."
        )
    if not has_albums:
        return
    if not _enabled(config):
        raise NotReadyToServeError(
            f"Album Haven will not start: {ENABLED_KEY} switches off the duplicate results this "
            "library's cards need. Remove that setting."
        )
    if not ready:
        raise NotReadyToServeError(
            "Album Haven will not start: this library's duplicate results are not ready. "
            f"With every writer stopped, run: {PREPARE_COMMAND}"
        )


def _maintain(repository: Any) -> None:
    """Backfill when no ready index exists, then evaluate every marked album."""
    with _QUEUED_LOCK:
        # A request arriving from now on queues another pass for marks made meanwhile.
        _QUEUED.discard(repository._database_url)
        _RUNNING.add(repository._database_url)
    free = 0
    try:
        with _worker_connection(repository) as connection:
            library_id = _library_id(connection)
            if library_id is None or not _locked(connection, library_id):
                return
            try:
                _held, free = _bring_up_to_date(repository, connection, library_id)
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
    # A writer's mark set during this pass that no writer holds: the next pass evaluates it.
    if free:
        queue_maintenance(repository)


def duplicate_results_readable(repository: Any) -> bool:
    """Whether cards may read stored duplicate results now, after evaluating the last save's
    marks unless a running pass holds them. Readiness comes first, and a read never waits.
    The results' own version decides it: they stay readable while the Problematic Files
    items rebuild. False until their backfill is done; /status shows that work as pending."""
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
    refresh(repository)
    return True


def indexing_progress(repository: Any) -> dict[str, int] | None:
    """While no ready index exists: the backfill's progress (zeros until it knows its albums).

    None when this repository does not use the index at all.
    """
    if not _available(repository):
        return None
    return dict(_PROGRESS.get(repository._database_url) or {"done": 0, "total": 0})


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
