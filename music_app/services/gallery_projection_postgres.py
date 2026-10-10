"""Derived root membership; source data and the browse selector stay authoritative."""
from __future__ import annotations

import hashlib
import json
import logging
from threading import Lock

from psycopg.types.json import Jsonb

from music_app.services.library_roots import library_category_slugs

BUILDER_VERSION = "root-gallery-v2"
_LOGGER = logging.getLogger(__name__)
_PENDING = {}
_PENDING_LOCK = Lock()
_OCCURRENCE_FIELDS = frozenset({
    "artist_id", "artist_name", "artist_sort_name", "album_id", "album_key",
    "album_title", "album_release_year", "missing_album_key",
})


def gallery_projection_scope_key(view_state):
    scope = {
        "builder_version": BUILDER_VERSION,
        **{key: view_state.get(key) for key in ("gallery_scope", "visible_library_categories")},
    }
    selected_categories = set(scope.get("visible_library_categories") or ())
    scope["visible_library_categories"] = [
        category for category in library_category_slugs()
        if category in selected_categories
    ]
    return hashlib.sha256(json.dumps(scope, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def projection_occurrences(snapshot):
    result = []
    for source in snapshot["ordered"]:
        row = {key: value for key, value in source.items() if key in _OCCURRENCE_FIELDS}
        if source.get("missing_album") is not None:
            row["missing_album_key"] = source["album_key"]
        result.append(row)
    return result


def _first(cursor):
    if callable(getattr(cursor, "fetchone", None)):
        return cursor.fetchone()
    rows = cursor.fetchall()
    return rows[0] if rows else None


def gallery_projection_context(connection):
    """Absent migration means compatibility fallback, not a failed transaction."""
    installed = _first(connection.execute(
        "select to_regclass('library.gallery_projection_state') is not null as installed"))
    if not isinstance(installed, dict) or installed.get("installed") is not True:
        return None
    return _first(connection.execute("""
        select state.library_id, state.generation
        from app.bootstrap_owners owner
        join library.libraries library on library.owner_account_id = owner.account_id
          and library.name = 'Local Library' and library.library_kind = 'local'
        join library.gallery_projection_state state on state.library_id = library.id
        where owner.owner_key = 'local-bootstrap-owner'
    """))


def _ready_header(connection, context, view_state):
    return _first(connection.execute("""
        select revision, sidebar, album_count, occurrence_count
        from library.gallery_projection_snapshots
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and source_generation = %(generation)s and builder_version = %(builder_version)s
    """, {**context, "scope_key": gallery_projection_scope_key(view_state), "builder_version": BUILDER_VERSION}))


def _latest_compatible_header(connection, context, view_state):
    return _first(connection.execute("""
        select source_generation, revision, sidebar, album_count, occurrence_count
        from library.gallery_projection_snapshots
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and builder_version = %(builder_version)s
        order by source_generation desc
        limit 1
    """, {**context, "scope_key": gallery_projection_scope_key(view_state), "builder_version": BUILDER_VERSION}))


def load_gallery_projection_page(connection, view_state, params, *, context=None, allow_stale=False):
    from music_app.services.library_browse_postgres import (
        _root_gallery_anchor_metadata, _root_gallery_cursor, _root_gallery_page_bounds,
        _root_gallery_page_metadata,
    )
    context = context if context is not None else gallery_projection_context(connection)
    if not context:
        return None
    header = _ready_header(connection, context, view_state)
    stale = False
    if not header and allow_stale:
        header = _latest_compatible_header(connection, context, view_state)
        stale = header is not None
    if not header:
        return None
    count = int(header["occurrence_count"])
    anchor_artist = str(params.get("gallery_anchor_artist") or "").strip()
    anchor_offset = None
    if anchor_artist and not params.get("gallery_cursor"):
        anchor_row = _first(connection.execute("""
            select min(ordinal) as ordinal
            from library.gallery_projection_occurrences
            where library_id = %(library_id)s and scope_key = %(scope_key)s
              and payload->>'artist_name' = %(anchor_artist)s
        """, {
            "library_id": context["library_id"],
            "scope_key": gallery_projection_scope_key(view_state),
            "anchor_artist": anchor_artist,
        }))
        if anchor_row and anchor_row.get("ordinal") is not None:
            anchor_offset = int(anchor_row["ordinal"])
        else:
            raise ValueError("Gallery artist anchor is unavailable.")
    size, nominal_offset = _root_gallery_page_bounds(
        params,
        header["revision"],
        count,
        anchor_offset=anchor_offset,
    )
    scope_key = gallery_projection_scope_key(view_state)

    def artist_bounds(ordinal):
        if not count:
            return 0, 0
        boundary = _first(connection.execute("""
            with target as (
                select payload->>'artist_id' as artist_id
                from library.gallery_projection_occurrences
                where library_id = %(library_id)s and scope_key = %(scope_key)s
                  and ordinal = %(ordinal)s
            )
            select min(occurrence.ordinal) as first_ordinal,
                   max(occurrence.ordinal) + 1 as end_ordinal
            from library.gallery_projection_occurrences occurrence
            cross join target
            where occurrence.library_id = %(library_id)s and occurrence.scope_key = %(scope_key)s
              and occurrence.payload->>'artist_id' = target.artist_id
        """, {
            "library_id": context["library_id"],
            "scope_key": scope_key,
            "ordinal": min(max(0, int(ordinal)), count - 1),
        }))
        if not boundary or boundary.get("first_ordinal") is None or boundary.get("end_ordinal") is None:
            raise ValueError("Gallery artist boundary is unavailable.")
        return int(boundary["first_ordinal"]), int(boundary["end_ordinal"])

    group_bounded = bool(anchor_artist or params.get("gallery_page_direction") == "previous")
    if count and group_bounded:
        offset, _ = artist_bounds(nominal_offset)
        required_end = max(offset + size, (anchor_offset + 1) if anchor_offset is not None else 0)
        _, end = artist_bounds(min(count - 1, required_end - 1))
    elif count:
        offset = nominal_offset
        end = min(count, offset + size)
    else:
        offset = end = 0
    rows = connection.execute("""
        select payload from library.gallery_projection_occurrences
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and ordinal >= %(offset)s and ordinal < %(end)s
        order by ordinal
    """, {"library_id": context["library_id"], "scope_key": gallery_projection_scope_key(view_state),
            "offset": offset, "end": end}).fetchall()
    page = [dict(row["payload"]) for row in rows]
    if len(page) != end - offset:
        return None
    metadata = _root_gallery_page_metadata(header["revision"], count, size, offset, len(page))
    if group_bounded:
        previous_cursor = None
        if offset > 0:
            previous_offset, _ = artist_bounds(max(0, offset - size))
            if previous_offset < offset:
                previous_cursor = _root_gallery_cursor(header["revision"], previous_offset)
        metadata.update({"previous_cursor": previous_cursor, "has_previous": previous_cursor is not None})
    metadata.update(_root_gallery_anchor_metadata(page, anchor_artist, anchor_offset))
    if stale:
        metadata.update({
            "projection_stale": True,
            "source_generation": int(header["source_generation"]),
        })
    return page, header["sidebar"], int(header["album_count"]), metadata


def publish_gallery_projection(config, context, view_state, snapshot, *, connect=None):
    from music_app.services.library_browse_postgres import _connect
    if config.get("SHARED_LIBRARY_BROWSE_ONLY") or not context:
        return False
    connector = connect or _connect
    with connector(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        row = _first(connection.execute("""
            select library.replace_gallery_projection(
                %(library_id)s, %(scope_key)s, %(generation)s, %(builder_version)s,
                %(revision)s, %(sidebar)s, %(album_count)s, %(occurrences)s
            ) as published
        """, {**context, "scope_key": gallery_projection_scope_key(view_state),
              "builder_version": BUILDER_VERSION, "revision": snapshot["revision"],
              "sidebar": Jsonb(snapshot["sidebar"]), "album_count": snapshot["album_count"],
              "occurrences": Jsonb(projection_occurrences(snapshot))}))
        return bool(row and row.get("published"))


def _queue(config, key, action, *, trailing=False, generation=None):
    if config.get("SHARED_LIBRARY_BROWSE_ONLY") or not config.get("ALBUM_HAVEN_APP_DATABASE_URL"):
        return None
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR
    identity = (config["ALBUM_HAVEN_APP_DATABASE_URL"], key)
    with _PENDING_LOCK:
        if identity in _PENDING:
            _, pending_generation = _PENDING[identity]
            if trailing and (generation is None or generation >= pending_generation):
                _PENDING[identity] = (action, generation)
            return None
        _PENDING[identity] = (None, generation)
    try:
        future = _CACHE_WRITE_EXECUTOR.submit(action)
    except Exception:
        with _PENDING_LOCK:
            _PENDING.pop(identity, None)
        _LOGGER.exception("Gallery projection could not be queued; computed browse remains available")
        return None

    def finished(completed):
        with _PENDING_LOCK:
            following, following_generation = _PENDING.pop(identity)
        try:
            completed.result()
        except Exception:
            _LOGGER.exception("Gallery projection publication failed; computed browse remains available")
        if following is not None:
            _queue(config, key, following, trailing=trailing, generation=following_generation)
    future.add_done_callback(finished)
    return future


def queue_gallery_projection_snapshot(config, context, view_state, snapshot, *, connect=None):
    if not context:
        return None
    key = (context["library_id"], gallery_projection_scope_key(view_state))
    return _queue(config, key, lambda: publish_gallery_projection(
        config, context, view_state, snapshot, connect=connect), trailing=True, generation=context["generation"])


def schedule_gallery_projection_refresh(config, *, connect=None):
    return _queue(config, "refresh", lambda: ensure_gallery_projection_ready(config, connect=connect), trailing=True)


def ensure_gallery_projection_ready(config, *, connect=None, cancel_requested=None):
    """Prepare common startup scopes once, using one coherent source snapshot."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services.relation_projection_postgres import _raise_if_projection_cancelled
    if config.get("SHARED_LIBRARY_BROWSE_ONLY"):
        return {"built": 0}
    repository = browse.PostgresLibraryBrowseRepository(config, connect=connect)
    pending = []
    with repository._connect_to_database() as connection:
        connection.execute("set transaction isolation level repeatable read, read only")
        context = gallery_projection_context(connection)
        if not context:
            return {"built": 0}
        scopes = [browse._root_sidebar_view_state(params) for params in ({}, {"gallery_scope": "new_arrivals"})]
        stale = [state for state in scopes if not _ready_header(connection, context, state)]
        if not stale:
            return {"built": 0}
        aliases = repository._load_relation_alias_maps(connection=connection)
        if aliases.get("projection_stale_reason"):
            return {"built": 0}
        root_aliases = browse._root_browse_alias_to_canonical(aliases["alias_to_canonical"])
        missing_rows = repository._load_missing_album_rows(connection=connection)
        for state in stale:
            _raise_if_projection_cancelled(cancel_requested)
            rows = connection.execute(browse._root_gallery_membership_sql(), browse._root_sidebar_params(state)).fetchall()
            missing = browse._missing_album_projection_payloads(missing_rows, view_state=state)
            pending.append((state, browse._prepare_root_gallery_snapshot(rows, missing, root_aliases, state)))
    built = 0
    for state, snapshot in pending:
        _raise_if_projection_cancelled(cancel_requested)
        built += int(publish_gallery_projection(config, context, state, snapshot, connect=connect))
    return {"built": built}
