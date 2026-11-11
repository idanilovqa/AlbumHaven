"""Derived root membership; source data and the browse selector stay authoritative."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError as FutureTimeoutError
import hashlib
import json
import logging
from threading import Lock

from psycopg.types.json import Jsonb

from music_app.services.library_roots import library_category_slugs

BUILDER_VERSION = "root-gallery-v5"
_LOGGER = logging.getLogger(__name__)
_PENDING = {}
_PENDING_LOCK = Lock()
_PREPARATIONS: dict[str | tuple[str, str], Future] = {}
_PREPARATIONS_LOCK = Lock()
_OCCURRENCE_FIELDS = frozenset({
    "artist_id", "artist_name", "artist_sort_name", "album_id", "album_key",
    "album_title", "album_release_year", "featured_kind", "missing_album_key",
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


def membership_rows(snapshot):
    from music_app.services.library_browse_postgres import _artist_tree_display_value
    from music_app.services.utils import artist_collation_key

    return [{
        "artist_id": row["artist_id"], "album_key": row["album_key"],
        "artist_sort": [*artist_collation_key(row["artist_sort_name"]),
                        *artist_collation_key(row["artist_name"])],
        "artist_display": _artist_tree_display_value(row["artist_name"]),
        "album_year": int(row.get("album_release_year") or 9999),
        "album_sort": str(row.get("album_title") or "").casefold(),
        "payload": row,
    } for row in projection_occurrences(snapshot)]


def _membership_installed(connection):
    row = _first(connection.execute(
        "select to_regclass('library.gallery_membership_headers') is not null as installed"))
    return isinstance(row, dict) and row.get("installed") is True


def _membership_header(connection, context, view_state, *, allow_stale=False):
    generation = "" if allow_stale else "and source_generation = %(generation)s"
    params = {**context, "scope_key": gallery_projection_scope_key(view_state),
              "builder_version": BUILDER_VERSION}
    header = _first(connection.execute(f"""
        select source_generation, revision, album_count, occurrence_count,
          coalesce((select jsonb_agg(jsonb_build_object(
            'artist',artist_name,'artist_display',artist_display,'count',artist.occurrence_count)
            order by artist_sort, artist_id collate "C")
            from library.gallery_membership_artists artist
            where artist.library_id = header.library_id and artist.scope_key = header.scope_key), '[]'::jsonb) as sidebar
        from library.gallery_membership_headers header
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and builder_version = %(builder_version)s {generation}
    """, params))
    if not header:
        return None
    return {**header, "incremental_membership": True}


def patch_gallery_membership_in_transaction(
    connection, config, *, affected_album_ids, affected_album_keys,
    alias_to_canonical, expected_generation, expected_target_generation=None,
):
    """Publish changed memberships against an exact, previously ready baseline."""
    from music_app.services import library_browse_postgres as browse

    if expected_generation is None or not _membership_installed(connection):
        return 0
    context = gallery_projection_context(connection)
    if not context:
        return 0
    if expected_target_generation is not None and context['generation'] != expected_target_generation:
        raise RuntimeError('Library sources changed before gallery publication; retry reconciliation.')
    keys = sorted({str(key) for key in affected_album_keys if str(key)})
    params = {**context, "expected_generation": expected_generation,
              "builder_version": BUILDER_VERSION, "affected_album_keys": keys}
    headers = connection.execute("""
        select scope_key, view_state, revision, source_generation
        from library.gallery_membership_headers
        where library_id = %(library_id)s
          and builder_version = %(builder_version)s
    """, params).fetchall()
    if not headers or any(header["source_generation"] != expected_generation for header in headers):
        raise RuntimeError("Gallery membership baseline is unavailable; initialize or reconcile it before editing.")
    repository = browse.PostgresLibraryBrowseRepository(config)
    aliases = browse._root_browse_alias_to_canonical(alias_to_canonical)
    published = 0
    for header in headers:
        state = dict(header["view_state"])
        rows = connection.execute(
            browse._root_gallery_membership_sql(candidate_albums_only=True),
            {**browse._root_sidebar_params(state), "gallery_album_ids": sorted(set(affected_album_ids))},
        ).fetchall() if keys else []
        missing_rows = repository._load_missing_album_rows(album_keys=keys, connection=connection) if keys else []
        missing_payloads = browse._missing_album_projection_payloads(missing_rows, view_state=state)
        from music_app.services.scoped_relation_projection import _published_aliases
        row_aliases = _published_aliases(connection, context['library_id'], {
            *(str(row.get('artist_name') or '').strip() for row in rows),
            *(str(album.get('album_artist') or 'Unknown Artist').strip() for album in missing_payloads),
        } - {''})
        row_aliases.update(aliases)
        snapshot = browse._prepare_root_gallery_snapshot(
            rows, missing_payloads, row_aliases, state,
        )
        revision = hashlib.sha256(f'{header["revision"]}:{snapshot["revision"]}'.encode()).hexdigest()
        result = _first(connection.execute("""
            select library.patch_gallery_membership(
                %(library_id)s, %(scope_key)s, %(expected_generation)s, %(generation)s,
                %(builder_version)s, %(revision)s, %(view_state)s, %(affected_album_keys)s,
                %(rows)s
            ) as published
        """, {**params, "scope_key": header["scope_key"], "revision": revision,
                "view_state": Jsonb(state), "rows": Jsonb(membership_rows(snapshot))}))
        if not result or result.get("published") is not True:
            raise RuntimeError("Gallery membership baseline changed during inventory publication.")
        published += 1
    return published


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
    compatible = _first(connection.execute("""
        select exists (
            select 1 from information_schema.columns
            where table_schema = 'library'
              and table_name = 'gallery_projection_occurrences'
              and column_name = 'revision'
        ) as compatible
    """))
    if not isinstance(compatible, dict) or compatible.get("compatible") is not True:
        return None
    return _first(connection.execute("""
        select state.library_id, state.generation,
          to_regclass('library.gallery_membership_headers') is not null as incremental_membership
        from app.bootstrap_owners owner
        join library.libraries library on library.owner_account_id = owner.account_id
          and library.name = 'Local Library' and library.library_kind = 'local'
        join library.gallery_projection_state state on state.library_id = library.id
        where owner.owner_key = 'local-bootstrap-owner'
    """))


def _ready_header(connection, context, view_state):
    if context.get("incremental_membership"):
        return _membership_header(connection, context, view_state)
    return _first(connection.execute("""
        select revision, sidebar, album_count, occurrence_count
        from library.gallery_projection_snapshots
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and source_generation = %(generation)s and builder_version = %(builder_version)s
    """, {**context, "scope_key": gallery_projection_scope_key(view_state), "builder_version": BUILDER_VERSION}))


def _latest_compatible_header(connection, context, view_state):
    if context.get("incremental_membership"):
        return _membership_header(connection, context, view_state, allow_stale=True)
    return _first(connection.execute("""
        select source_generation, revision, sidebar, album_count, occurrence_count
        from library.gallery_projection_snapshots
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and builder_version = %(builder_version)s
        order by source_generation desc
        limit 1
    """, {**context, "scope_key": gallery_projection_scope_key(view_state), "builder_version": BUILDER_VERSION}))


def load_gallery_projection_sidebar(connection, view_state, *, context=None):
    context = context if context is not None else gallery_projection_context(connection)
    if not context:
        return None
    header = _ready_header(connection, context, view_state)
    if not header:
        return None
    return (
        [dict(item) for item in list(header.get("sidebar") or [])],
        int(header["album_count"]),
    )


def _load_membership_page(connection, context, view_state, params, header, *, stale=False):
    from music_app.services.library_browse_postgres import GalleryProjectionPending

    try:
        return _read_membership_page(connection, context, view_state, params, header, stale=stale)
    except ValueError:
        # A writer may commit between the header, boundaries and page queries.
        # Use the existing retryable response instead of blaming the client's
        # cursor or anchor for a mixed READ COMMITTED snapshot.
        current = _first(connection.execute("""
            select revision from library.gallery_membership_headers
            where library_id = %(library_id)s and scope_key = %(scope_key)s
        """, {"library_id": context["library_id"],
                "scope_key": gallery_projection_scope_key(view_state)}))
        if not current or current.get("revision") != header["revision"]:
            raise GalleryProjectionPending("Gallery is being updated.") from None
        raise


def _read_membership_page(connection, context, view_state, params, header, *, stale=False):
    from music_app.services import library_browse_postgres as browse
    from music_app.services.library_inventory_postgres import local_inventory_identity_key

    base = {"library_id": context["library_id"], "scope_key": gallery_projection_scope_key(view_state),
            "revision": header["revision"]}
    count = int(header["occurrence_count"])
    requested = str(params.get("gallery_anchor_artist") or "").strip()
    anchor = requested
    if anchor and not params.get("gallery_cursor") and not stale:
        alias = _first(connection.execute("""
            select canonical_artist_name from library.local_artist_search_projection_current
            where library_id = %(library_id)s and normalized_artist_key = %(artist_key)s
        """, {**base, "artist_key": local_inventory_identity_key(anchor)}))
        if alias:
            aliases = browse._root_browse_alias_to_canonical({anchor: alias["canonical_artist_name"]})
            anchor = browse._canonical_artist_name(anchor, aliases)

    def bounds(*, artist_name=None, ordinal=None):
        if artist_name is not None:
            target = """select artist_id, artist_sort from library.gallery_membership_artists
                where library_id = %(library_id)s and scope_key = %(scope_key)s
                  and artist_name = %(artist_name)s"""
        else:
            target = """select artist_id, artist_sort from library.gallery_membership_entries
                where library_id = %(library_id)s and scope_key = %(scope_key)s
                order by artist_sort, artist_id collate "C", album_year, album_sort, album_key collate "C"
                offset %(ordinal)s limit 1"""
        row = _first(connection.execute(f"""
            with target as ({target})
            select coalesce(sum(artist.occurrence_count) filter (
                where (artist.artist_sort, artist.artist_id collate "C") <
                      (target.artist_sort, target.artist_id collate "C")), 0) as first_ordinal,
                max(artist.occurrence_count) filter (where artist.artist_id = target.artist_id) as group_count
            from target join library.gallery_membership_artists artist
              on artist.library_id = %(library_id)s and artist.scope_key = %(scope_key)s
             and (artist.artist_sort, artist.artist_id collate "C") <=
                 (target.artist_sort, target.artist_id collate "C")
            group by target.artist_sort, target.artist_id
        """, {**base, "artist_name": artist_name, "ordinal": ordinal}))
        if not row or row.get("group_count") is None:
            raise ValueError("Gallery artist anchor is unavailable." if artist_name else "Gallery artist boundary is unavailable.")
        start = int(row["first_ordinal"])
        return start, start + int(row["group_count"])

    anchor_offset = bounds(artist_name=anchor)[0] if anchor and not params.get("gallery_cursor") else None
    size, nominal_offset = browse._root_gallery_page_bounds(
        params, header["revision"], count, anchor_offset=anchor_offset,
    )
    group_bounded = bool(anchor or params.get("gallery_page_direction") == "previous")
    if count and group_bounded:
        offset = bounds(ordinal=nominal_offset)[0]
        required_end = max(offset + size, (anchor_offset + 1) if anchor_offset is not None else 0)
        end = bounds(ordinal=min(count - 1, required_end - 1))[1]
    else:
        offset, end = (nominal_offset, min(count, nominal_offset + size)) if count else (0, 0)
    rows = connection.execute("""
        select payload from library.gallery_membership_entries
        where library_id = %(library_id)s and scope_key = %(scope_key)s
        order by artist_sort, artist_id collate "C", album_year, album_sort, album_key collate "C"
        offset %(offset)s limit %(length)s
    """, {**base, "offset": offset, "length": end - offset}).fetchall()
    page = [dict(row["payload"]) for row in rows]
    if len(page) != end - offset:
        raise ValueError("Gallery membership page is incomplete.")
    metadata = browse._root_gallery_page_metadata(header["revision"], count, size, offset, len(page))
    if group_bounded:
        previous_cursor = None
        if offset > 0:
            previous_offset = bounds(ordinal=max(0, offset - size))[0]
            if previous_offset < offset:
                previous_cursor = browse._root_gallery_cursor(header["revision"], previous_offset)
        metadata.update(previous_cursor=previous_cursor, has_previous=previous_cursor is not None)
    metadata.update(browse._root_gallery_anchor_metadata(page, anchor, anchor_offset, requested_artist=requested))
    if stale:
        metadata.update(projection_stale=True, source_generation=int(header["source_generation"]))
    current = _first(connection.execute("""
        select revision from library.gallery_membership_headers
        where library_id = %(library_id)s and scope_key = %(scope_key)s
    """, base))
    if not current or current.get("revision") != header["revision"]:
        raise ValueError("Gallery projection changed while loading page.")
    return page, header["sidebar"], int(header["album_count"]), metadata


def load_gallery_projection_page(connection, view_state, params, *, context=None, allow_stale=False):
    from music_app.services.library_browse_postgres import (
        _root_gallery_anchor_metadata, _root_gallery_cursor, _root_gallery_page_bounds,
        _root_gallery_page_metadata,
        _relation_alias_maps_sql, _root_browse_alias_to_canonical, _canonical_artist_name,
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
    if header.get("incremental_membership"):
        return _load_membership_page(connection, context, view_state, params, header, stale=stale)
    count = int(header["occurrence_count"])
    anchor_artist = str(params.get("gallery_anchor_artist") or "").strip()
    requested_artist = anchor_artist
    if anchor_artist and not params.get("gallery_cursor") and not stale:
        alias_row = _first(connection.execute(_relation_alias_maps_sql())) or {}
        aliases = _root_browse_alias_to_canonical(alias_row.get("alias_to_canonical") or {})
        anchor_artist = _canonical_artist_name(anchor_artist, aliases)
    anchor_offset = None
    if anchor_artist and not params.get("gallery_cursor"):
        anchor_row = _first(connection.execute("""
            select min(ordinal) as ordinal
            from library.gallery_projection_occurrences
            where library_id = %(library_id)s and scope_key = %(scope_key)s
              and revision = %(revision)s
              and payload->>'artist_name' = %(anchor_artist)s
        """, {
            "library_id": context["library_id"],
            "scope_key": gallery_projection_scope_key(view_state),
            "revision": header["revision"],
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
                  and revision = %(revision)s
                  and ordinal = %(ordinal)s
            )
            select min(occurrence.ordinal) as first_ordinal,
                   max(occurrence.ordinal) + 1 as end_ordinal
            from library.gallery_projection_occurrences occurrence
            cross join target
            where occurrence.library_id = %(library_id)s and occurrence.scope_key = %(scope_key)s
              and occurrence.revision = %(revision)s
              and occurrence.payload->>'artist_id' = target.artist_id
        """, {
            "library_id": context["library_id"],
            "scope_key": scope_key,
            "revision": header["revision"],
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
          and revision = %(revision)s
          and ordinal >= %(offset)s and ordinal < %(end)s
        order by ordinal
    """, {"library_id": context["library_id"], "scope_key": gallery_projection_scope_key(view_state),
            "revision": header["revision"], "offset": offset, "end": end}).fetchall()
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
    metadata.update(_root_gallery_anchor_metadata(page, anchor_artist, anchor_offset, requested_artist=requested_artist))
    if stale:
        metadata.update({
            "projection_stale": True,
            "source_generation": int(header["source_generation"]),
        })
    return page, header["sidebar"], int(header["album_count"]), metadata


def _publish_gallery_projection_on_connection(
    connection, context, view_state, snapshot,
):
    if context.get("incremental_membership"):
        state = {key: view_state.get(key) for key in ("gallery_scope", "visible_library_categories")}
        row = _first(connection.execute("""
            select library.patch_gallery_membership(
                %(library_id)s, %(scope_key)s, %(generation)s, %(generation)s,
                %(builder_version)s, %(revision)s, %(view_state)s, null, %(rows)s
            ) as published
        """, {**context, "scope_key": gallery_projection_scope_key(view_state),
                "builder_version": BUILDER_VERSION, "revision": snapshot["revision"],
                "view_state": Jsonb(state), "rows": Jsonb(membership_rows(snapshot))}))
        return bool(row and row.get("published"))
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


def publish_gallery_projection(config, context, view_state, snapshot, *, connect=None, allow_shared_seed=False):
    from music_app.services.library_browse_postgres import _connect
    if (config.get("SHARED_LIBRARY_BROWSE_ONLY") and not allow_shared_seed) or not context:
        return False
    connector = connect or _connect
    with connector(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        return _publish_gallery_projection_on_connection(
            connection, context, view_state, snapshot,
        )


def _queue(config, key, action, *, trailing=False, generation=None, allow_shared=False):
    if (config.get("SHARED_LIBRARY_BROWSE_ONLY") and not allow_shared) or not config.get("ALBUM_HAVEN_APP_DATABASE_URL"):
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
        _LOGGER.exception("Gallery projection could not be queued; a later request may retry")
        return None

    def finished(completed):
        with _PENDING_LOCK:
            following, following_generation = _PENDING.pop(identity)
        try:
            completed.result()
        except Exception:
            _LOGGER.exception("Gallery projection publication failed; a later request may retry")
            if key == "refresh" or (isinstance(key, tuple) and key[0] == "refresh"):
                return
        if following is not None:
            _queue(config, key, following, trailing=trailing, generation=following_generation, allow_shared=allow_shared)
    future.add_done_callback(finished)
    return future


def queue_gallery_projection_snapshot(config, context, view_state, snapshot, *, connect=None):
    if not context:
        return None
    key = (context["library_id"], gallery_projection_scope_key(view_state))
    return _queue(config, key, lambda: publish_gallery_projection(
        config, context, view_state, snapshot, connect=connect), trailing=True, generation=context["generation"])


def schedule_gallery_projection_refresh(config, *, connect=None, view_state=None, incremental_membership=False):
    from music_app.services.library_browse_postgres import _root_sidebar_view_state

    key = "refresh"
    options = {"connect": connect}
    if view_state is not None:
        scope = {**view_state, "visible_library_categories": list(view_state.get("visible_library_categories") or [])}
        scope_key = gallery_projection_scope_key(scope)
        common_keys = {
            gallery_projection_scope_key(_root_sidebar_view_state(params))
            for params in ({}, {"gallery_scope": "new_arrivals"})
        }
        if scope_key not in common_keys:
            key = ("refresh", scope_key)
            options["view_state"] = scope
    def refresh():
        from music_app.services.scoped_relation_projection import ensure_pending_relation_projection_ready

        result = ensure_pending_relation_projection_ready(config, connect=connect) if incremental_membership else {}
        if incremental_membership:
            if not result.get("initialized"):
                raise RuntimeError("Incremental gallery membership requires startup initialization.")
            if "view_state" in options:
                from music_app.services.library_browse_postgres import _connect

                with (connect or _connect)(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
                    context = gallery_projection_context(connection)
                    header = _first(connection.execute("""
                        select 1 as present from library.gallery_membership_headers
                        where library_id = %(library_id)s and scope_key = %(scope_key)s
                          and builder_version = %(builder_version)s
                    """, {"library_id": context["library_id"], "scope_key": scope_key,
                            "builder_version": BUILDER_VERSION})) if context else None
                if context and not header:
                    return _ensure_gallery_projection_ready(config, **options, allow_shared_seed=True)
            return result
        return ensure_gallery_projection_ready(config, **options)

    return _queue(config, key, refresh, trailing=True, allow_shared=incremental_membership)


def ensure_gallery_projection_ready(config, *, connect=None, cancel_requested=None, view_state=None):
    """Share one background preparation across startup and queued refreshes."""
    from music_app.services.relation_projection_postgres import _raise_if_projection_cancelled

    if config.get("SHARED_LIBRARY_BROWSE_ONLY"):
        return {"built": 0}
    _raise_if_projection_cancelled(cancel_requested)
    identity = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if view_state is not None:
        identity = (identity, gallery_projection_scope_key(view_state))
    with _PREPARATIONS_LOCK:
        future = _PREPARATIONS.get(identity)
        owns_preparation = future is None
        if owns_preparation:
            future = Future()
            _PREPARATIONS[identity] = future
    if not owns_preparation:
        while True:
            _raise_if_projection_cancelled(cancel_requested)
            try:
                return future.result(timeout=0.1)
            except FutureTimeoutError:
                if future.done():
                    raise
    try:
        result = _ensure_gallery_projection_ready(
            config, connect=connect, cancel_requested=cancel_requested, view_state=view_state,
        )
        future.set_result(result)
        return result
    except BaseException as error:
        future.set_exception(error)
        raise
    finally:
        with _PREPARATIONS_LOCK:
            _PREPARATIONS.pop(identity, None)


def _refresh_all_stray_duplicate_ownership(connection):
    from music_app.services.scoped_relation_projection import _refresh_stray_duplicate_ownership

    context = gallery_projection_context(connection)
    if not context:
        return
    album_ids = connection.execute(
        "select id from library.local_albums where library_id=%s", (context["library_id"],)
    ).fetchall()
    _refresh_stray_duplicate_ownership(
        connection, context["library_id"], (row["id"] for row in album_ids)
    )


def initialize_gallery_membership(config, *, connect=None):
    """Seed migrated membership once before a writer starts serving requests."""
    from music_app.services.library_browse_postgres import _connect, _root_sidebar_view_state

    connector = connect or _connect
    with connector(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        if not _membership_installed(connection):
            raise RuntimeError("Incremental gallery membership migration is not installed.")
        if not config.get("SHARED_LIBRARY_BROWSE_ONLY"):
            _refresh_all_stray_duplicate_ownership(connection)
    result = _ensure_gallery_projection_ready(config, connect=connect, allow_shared_seed=True)
    with connector(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        context = gallery_projection_context(connection)
        if not context or any(
            not _ready_header(connection, context, _root_sidebar_view_state(params))
            for params in ({}, {"gallery_scope": "new_arrivals"})
        ):
            raise RuntimeError("Gallery membership changed during initial publication; startup is not ready.")
    return result


def finish_full_relation_publication(connection, config, relation_views):
    """Refresh existing gallery scopes before clearing a full writer's journal."""
    from music_app.services import library_browse_postgres as browse

    context = gallery_projection_context(connection)
    if not context or not _membership_installed(connection):
        return
    _refresh_all_stray_duplicate_ownership(connection)
    headers = connection.execute("""select scope_key,view_state,source_generation
        from library.gallery_membership_headers where library_id=%s""",
        (context['library_id'],)).fetchall()
    repository = browse.PostgresLibraryBrowseRepository(config)
    aliases = browse._root_browse_alias_to_canonical(relation_views['alias_to_canonical'])
    # This transaction already owns a complete relation snapshot. A gallery
    # failure rolls back both the replacement and this journal acknowledgement.
    connection.execute('delete from library.local_relation_dirty_albums where library_id=%s',
                       (context['library_id'],))
    for header in headers:
        state = header['view_state']
        rows = connection.execute(browse._root_gallery_membership_sql(), browse._root_sidebar_params(state)).fetchall()
        missing = browse._missing_album_projection_payloads(
            repository._load_missing_album_rows(connection=connection), view_state=state)
        snapshot = browse._prepare_root_gallery_snapshot(rows, missing, aliases, state)
        keys = {row['album_key'] for row in snapshot['ordered']}
        keys.update(row['album_key'] for row in connection.execute("""select distinct album_key
            from library.gallery_membership_entries where library_id=%s and scope_key=%s""",
            (context['library_id'], header['scope_key'])).fetchall())
        # A complete current-transaction snapshot covers both removed and new
        # memberships. The existing compare-and-swap keeps concurrent writers
        # from acknowledging an older source generation.
        row = _first(connection.execute("""select library.patch_gallery_membership(
            %(library_id)s,%(scope_key)s,%(expected)s,%(generation)s,%(builder)s,
            %(revision)s,%(view_state)s,%(keys)s,%(rows)s) as published""", {
            **context, 'scope_key': header['scope_key'], 'expected': header['source_generation'],
            'builder': BUILDER_VERSION, 'revision': snapshot['revision'], 'view_state': Jsonb(state),
            'keys': sorted(keys), 'rows': Jsonb(membership_rows(snapshot)),
        }))
        if not row or not row.get('published'):
            raise RuntimeError('Gallery changed during full relation publication.')


def _ensure_gallery_projection_ready(config, *, connect=None, cancel_requested=None, view_state=None, allow_shared_seed=False):
    """Publish each common scope from its own coherent source snapshot."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services.relation_projection_postgres import _raise_if_projection_cancelled
    repository = browse.PostgresLibraryBrowseRepository(config, connect=connect)
    if repository._load_relation_alias_maps().get("projection_stale_reason"):
        from music_app.services.relation_projection_postgres import ensure_relation_projection_ready

        ensure_relation_projection_ready(config, connect=connect, cancel_requested=cancel_requested)
    built = 0
    scopes = ([view_state] if view_state is not None else
              [browse._root_sidebar_view_state(params) for params in ({}, {"gallery_scope": "new_arrivals"})])
    for state in scopes:
        _raise_if_projection_cancelled(cancel_requested)
        with repository._connect_to_database() as connection:
            connection.execute("set transaction isolation level repeatable read, read only")
            context = gallery_projection_context(connection)
            if not context:
                return {"built": built}
            if _ready_header(connection, context, state):
                continue
            aliases = repository._load_relation_alias_maps(connection=connection)
            if aliases.get("projection_stale_reason"):
                return {"built": built}
            root_aliases = browse._root_browse_alias_to_canonical(aliases["alias_to_canonical"])
            missing_rows = repository._load_missing_album_rows(connection=connection)
            rows = connection.execute(browse._root_gallery_membership_sql(), browse._root_sidebar_params(state)).fetchall()
            missing = browse._missing_album_projection_payloads(missing_rows, view_state=state)
            snapshot = browse._prepare_root_gallery_snapshot(rows, missing, root_aliases, state)
        _raise_if_projection_cancelled(cancel_requested)
        options = {"allow_shared_seed": True} if allow_shared_seed else {}
        built += int(publish_gallery_projection(config, context, state, snapshot, connect=connect, **options))
    return {"built": built}
