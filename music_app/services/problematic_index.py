"""The persisted Problematic Files index (migration 0188).

Problematic Files used to find its albums with a whole-library candidate pass
(22-55 s on a 160k-file library after every restart). The index keeps the
listed items with their sort keys and search text, so pages and search are
keyset reads. Album changes are marked by the database journal; the albums a
mark names (and their duplicate peers) are re-evaluated with the same loaders
and builder the list always used, so an indexed item equals a rebuilt one.

Until an index of the current builder version is ready, callers keep their
previous path and a background backfill fills it.
"""
from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping
from threading import Lock
from typing import Any

from music_app.services.runtime_shutdown import create_daemon_executor

_LOGGER = logging.getLogger(__name__)

# Bump when an item's content for the same library data changes; a different
# version backfills the index again.
BUILDER_VERSION = "1"
# More marked albums than this are evaluated in the background, not by a read.
INLINE_ALBUM_LIMIT = 50
# Albums evaluated per transaction by the backfill.
BACKFILL_BATCH = 500
_IDENTITY_SEPARATOR = "\x1f"
_LOCK_NAMESPACE = 188  # pg advisory lock (namespace, library id)
# On unless set to 0; the Python test suite turns it off so a background backfill
# never races another test's database reset (index tests turn it back on).
ENABLED_KEY = "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED"

_EXECUTOR = create_daemon_executor(max_workers=1, thread_name_prefix="albumhaven-problematic-index")
_QUEUED: set[str] = set()
_QUEUED_LOCK = Lock()
_UNAVAILABLE_DATABASES: set[str] = set()
# Albums checked by a running backfill of this process, per database.
_PROGRESS: dict[str, dict[str, int]] = {}

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


class _Retry(Exception):
    """Duplicate sources were not resolved; evaluate again later."""


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


def _index_rows(repository: Any, connection: Any, library_id: int, album_ids: list[int],
                include_loose: bool) -> tuple[list[dict[str, object]], list[int]]:
    """Fresh items of ``album_ids`` (plus duplicate peers) and of loose tracks when asked.

    Returns the rows to write and every album id whose old rows they replace.
    """
    browse = _browse()
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
        return [], scoped_ids
    payload = repository._build_problematic_files_payload_from_rows(
        connection=connection,
        rows=rows,
        missing_rows=missing_rows,
        include_initial_detail=False,
        cache_albums=True,
    )
    if payload.get("duplicate_resolution_pending"):
        raise _Retry()
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
    return index_rows, scoped_ids


def _write(connection: Any, library_id: int, index_rows: list[dict[str, object]],
           replaced_album_ids: list[int], *, replace_loose: bool) -> None:
    connection.execute(
        """delete from library.problematic_index_items
           where library_id = %(library_id)s
             and (album_id = any(%(album_ids)s::bigint[]) or (%(loose)s and album_id is null))""",
        {"library_id": library_id, "album_ids": replaced_album_ids, "loose": replace_loose},
    )
    for row in index_rows:
        connection.execute(_UPSERT_SQL, row)


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


def _locked(connection: Any, library_id: int) -> bool:
    row = connection.execute(
        "select pg_try_advisory_lock(%s, %s::integer) as locked", (_LOCK_NAMESPACE, library_id),
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
    only while no ready index exists.
    """
    if not _available(repository):
        return False
    try:
        with repository._connect_to_database() as connection:
            connection.autocommit = True
            library_id = _library_id(connection)
            if library_id is None:
                return False
            if _state(connection, library_id) != "ready":
                queue_maintenance(repository)
                return False
            marks = connection.execute(
                """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
                   where library_id = %s limit %s""",
                (library_id, inline_limit + 1),
            ).fetchall()
            if not marks:
                return True
            if len(marks) > inline_limit:
                queue_maintenance(repository)
                return True
            if not _locked(connection, library_id):
                return True  # another evaluator holds the marks; the index stays readable
            try:
                _drain(repository, connection, library_id, marks)
            finally:
                _unlock(connection, library_id)
            return True
    except Exception as error:
        if _is_undefined_table(error):
            _UNAVAILABLE_DATABASES.add(repository._database_url)
            return False
        _LOGGER.warning("Problematic Files index refresh failed.", exc_info=True)
        return False


def _drain(repository: Any, connection: Any, library_id: int, marks: list[object]) -> bool:
    """Evaluate ``marks`` and clear exactly those marks (a later mark survives).

    False when duplicate sources were not resolved yet: the marks stay for a later pass.
    """
    album_ids = sorted({int(_value(row, "album_id")) for row in marks} - {0})
    include_loose = any(int(_value(row, "album_id")) == 0 for row in marks)
    with connection.transaction():
        connection.execute("set transaction isolation level repeatable read")
        connection.execute("set local work_mem = '16MB'")
        connection.execute("set local jit = off")
        try:
            index_rows, replaced = _index_rows(repository, connection, library_id, album_ids, include_loose)
        except _Retry:
            return False
        _write(connection, library_id, index_rows, sorted({*replaced, *album_ids}), replace_loose=include_loose)
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
    return True


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
        # Marked albums too: the candidate ids may be cached from before their change,
        # and the marks this snapshot sees are cleared below.
        marked_ids = [
            int(_value(row, "album_id")) for row in connection.execute(
                "select album_id from library.problematic_index_dirty_albums where library_id = %s and album_id > 0",
                (library_id,),
            ).fetchall()
        ]
        album_ids = sorted({*candidate_ids, *missing_ids, *marked_ids})
        _PROGRESS[repository._database_url] = {"done": 0, "total": len(album_ids)}
        index_rows: list[dict[str, object]] = []
        for start in range(0, max(len(album_ids), 1), BACKFILL_BATCH):
            for attempt in range(2):
                try:
                    rows, _replaced = _index_rows(
                        repository, connection, library_id, album_ids[start:start + BACKFILL_BATCH],
                        include_loose=start == 0,
                    )
                    break
                except _Retry:
                    if attempt:
                        raise
            index_rows.extend(rows)
            _PROGRESS[repository._database_url] = {
                "done": min(start + BACKFILL_BATCH, len(album_ids)), "total": len(album_ids)}
        connection.execute("delete from library.problematic_index_items where library_id = %s", (library_id,))
        for row in {row["item_key"]: row for row in index_rows}.values():
            connection.execute(_UPSERT_SQL, row)
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


def _maintain(repository: Any) -> None:
    """Backfill when no ready index exists, then evaluate every marked album."""
    with _QUEUED_LOCK:
        # A request arriving from now on queues another pass for marks made meanwhile.
        _QUEUED.discard(repository._database_url)
    try:
        with repository._connect_to_database() as connection:
            connection.autocommit = True
            library_id = _library_id(connection)
            if library_id is None or not _locked(connection, library_id):
                return
            try:
                if _state(connection, library_id) != "ready":
                    try:
                        _backfill(repository, connection, library_id)
                    finally:
                        _PROGRESS.pop(repository._database_url, None)
                while marks := connection.execute(
                    """select album_id, marked_xid::text as marked_xid from library.problematic_index_dirty_albums
                       where library_id = %s order by album_id limit %s""",
                    (library_id, BACKFILL_BATCH),
                ).fetchall():
                    if not _drain(repository, connection, library_id, marks):
                        break  # duplicate sources still resolving; a later read or save retries
            finally:
                _unlock(connection, library_id)
    except Exception:
        _LOGGER.warning("Problematic Files index maintenance failed.", exc_info=True)


def indexing_progress(repository: Any) -> dict[str, int] | None:
    """While no ready index exists: the backfill's progress (zeros until it knows its albums).

    None when this repository does not use the index at all.
    """
    if not _available(repository):
        return None
    return dict(_PROGRESS.get(repository._database_url) or {"done": 0, "total": 0})


def queue_maintenance(repository: Any) -> None:
    """Backfill or evaluate marked albums in the background (startup, saves, watcher passes)."""
    if not _available(repository) or repository._config.get("SHARED_LIBRARY_BROWSE_ONLY"):
        return
    with _QUEUED_LOCK:
        if repository._database_url in _QUEUED:
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
