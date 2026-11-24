"""Derived root membership; source data and the browse selector stay authoritative."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError as FutureTimeoutError
import hashlib
import json
import logging
from threading import Lock
import time

from psycopg.types.json import Jsonb

from music_app.services import browse_query_diagnostics  # TEMPORARY FTC-OPS-016 diagnostics
from music_app.services.library_roots import library_category_slugs

BUILDER_VERSION = "root-gallery-v5"
# Earlier builders whose stored occurrences and sidebar this code still reads. While a new
# builder's first snapshot is prepared, the newest of theirs keeps serving (marked stale), so a
# builder bump never answers "Gallery is being prepared." when a snapshot exists. A bump that
# changes what an occurrence or sidebar entry holds leaves its predecessor out.
SERVABLE_PREVIOUS_BUILDER_VERSIONS = ("root-gallery-v4",)
_LOGGER = logging.getLogger(__name__)
_PENDING = {}
_PENDING_LOCK = Lock()
# Counts the queued runs that published a snapshot in this process. /status reports it, so an
# open page reloads its tree once per publication, whatever changed the gallery's sources.
_PUBLICATION_REVISION = 0
_PREPARATIONS: dict[str | tuple[str, str], Future] = {}
_PREPARATIONS_LOCK = Lock()
_OCCURRENCE_FIELDS = frozenset({
    "artist_id", "artist_name", "artist_sort_name", "album_id", "album_key",
    "album_title", "album_release_year", "featured_kind", "missing_album_key",
})


def gallery_projection_scope_key(view_state, builder_version=None):
    scope = {
        "builder_version": builder_version or BUILDER_VERSION,
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


def _latest_compatible_header(connection, context, view_state, builder_version=None):
    builder_version = builder_version or BUILDER_VERSION
    return _first(connection.execute("""
        select source_generation, revision, sidebar, album_count, occurrence_count
        from library.gallery_projection_snapshots
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and builder_version = %(builder_version)s
        order by source_generation desc
        limit 1
    """, {**context, "scope_key": gallery_projection_scope_key(view_state, builder_version),
          "builder_version": builder_version}))


def _servable_header(connection, context, view_state, *, allow_stale):
    """The snapshot to serve, its scope key and whether it is stale: the current one, else (when
    stale is allowed) this builder's newest, else the newest of a servable previous builder."""
    header = _ready_header(connection, context, view_state)
    if header or not allow_stale:
        return header, gallery_projection_scope_key(view_state), False
    for builder_version in (BUILDER_VERSION, *SERVABLE_PREVIOUS_BUILDER_VERSIONS):
        header = _latest_compatible_header(connection, context, view_state, builder_version)
        if header:
            return header, gallery_projection_scope_key(view_state, builder_version), True
    return None, gallery_projection_scope_key(view_state), False


def load_gallery_projection_sidebar(connection, view_state, *, context=None, allow_stale=False):
    """The sidebar and album count of the snapshot to serve, and whether it is stale. A stale
    sidebar is served only from the current library generation (a previous builder's snapshot
    while the new builder's is prepared): the tree never lists another generation's artists
    (FTC-GALLERY-STARTUP-005Q)."""
    context = context if context is not None else gallery_projection_context(connection)
    if not context:
        return None
    header, _scope_key, stale = _servable_header(connection, context, view_state, allow_stale=allow_stale)
    if not header or (stale and header.get("source_generation") != context.get("generation")):
        return None
    return (
        [dict(item) for item in list(header.get("sidebar") or [])],
        int(header["album_count"]),
        stale,
    )


# Statistics predate a just-published revision, so the planner expects 1 row for it. The scalar
# subquery runs once as an InitPlan, so the artist range stays one index scan instead of a
# nested loop that repeats the target lookup for every occurrence in the revision.
_ARTIST_BOUNDS_SQL = """
    select min(ordinal) as first_ordinal, max(ordinal) + 1 as end_ordinal
    from library.gallery_projection_occurrences
    where library_id = %(library_id)s and scope_key = %(scope_key)s
      and revision = %(revision)s
      and payload->>'artist_id' = (
        select payload->>'artist_id'
        from library.gallery_projection_occurrences
        where library_id = %(library_id)s and scope_key = %(scope_key)s
          and revision = %(revision)s and ordinal = %(ordinal)s
      )
"""


def load_gallery_projection_page(connection, view_state, params, *, context=None, allow_stale=False):
    from music_app.services.library_browse_postgres import (
        _root_gallery_anchor_metadata, _root_gallery_cursor, _root_gallery_page_bounds,
        _root_gallery_page_metadata,
        _relation_alias_maps_sql, _root_browse_alias_to_canonical, _canonical_artist_name,
    )
    context = context if context is not None else gallery_projection_context(connection)
    if not context:
        return None
    header, scope_key, stale = _servable_header(connection, context, view_state, allow_stale=allow_stale)
    if not header:
        return None
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
            "scope_key": scope_key,
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

    def artist_bounds(ordinal):
        if not count:
            return 0, 0
        boundary = _first(connection.execute(_ARTIST_BOUNDS_SQL, {
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
    """, {"library_id": context["library_id"], "scope_key": scope_key,
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


def publish_gallery_projection(config, context, view_state, snapshot, *, connect=None):
    from music_app.services.library_browse_postgres import _connect
    if config.get("SHARED_LIBRARY_BROWSE_ONLY") or not context:
        return False
    connector = connect or _connect
    with connector(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        return _publish_gallery_projection_on_connection(
            connection, context, view_state, snapshot,
        )


def _run_callbacks(callbacks):
    for callback in callbacks:
        try:
            callback()
        except Exception:
            _LOGGER.exception("Gallery projection completion callback failed")


def _queue(config, key, action, *, trailing=False, generation=None, on_done=None):
    """Run ``action`` once per key at a time; a trailing call replaces the run that follows.

    ``on_done`` runs once a run that started after this call has finished (successfully or
    not), or at once when nothing is queued, so a caller can wait for the publication that
    includes its change."""
    callbacks = [on_done] if on_done is not None else []
    if config.get("SHARED_LIBRARY_BROWSE_ONLY") or not config.get("ALBUM_HAVEN_APP_DATABASE_URL"):
        _run_callbacks(callbacks)
        return None
    from music_app.services.cache import _CACHE_WRITE_EXECUTOR
    identity = (config["ALBUM_HAVEN_APP_DATABASE_URL"], key)
    with _PENDING_LOCK:
        if identity in _PENDING:
            following, pending_generation, following_callbacks = _PENDING[identity]
            if trailing and (generation is None or generation >= pending_generation):
                following, pending_generation = action, generation
            _PENDING[identity] = (following, pending_generation, following_callbacks + callbacks)
            return None
        _PENDING[identity] = (None, generation, [])
    try:
        future = _CACHE_WRITE_EXECUTOR.submit(action)
    except Exception:
        with _PENDING_LOCK:
            _PENDING.pop(identity, None)
        _LOGGER.exception("Gallery projection could not be queued; a later request may retry")
        _run_callbacks(callbacks)
        return None

    def finished(completed):
        global _PUBLICATION_REVISION
        with _PENDING_LOCK:
            following, following_generation, following_callbacks = _PENDING.pop(identity)
        _run_callbacks(callbacks)
        try:
            result = completed.result()
            # After the callbacks: a page that sees this publication also sees the inventory
            # revision whose hold the publication released.
            if (result.get("built") if isinstance(result, dict) else result):
                with _PENDING_LOCK:
                    _PUBLICATION_REVISION += 1
        except Exception:
            _LOGGER.exception("Gallery projection publication failed; a later request may retry")
            if key == "refresh" or (isinstance(key, tuple) and key[0] == "refresh"):
                _run_callbacks(following_callbacks)
                return
        if following is not None:
            _queue(config, key, following, trailing=trailing, generation=following_generation,
                   on_done=lambda: _run_callbacks(following_callbacks))
        else:
            _run_callbacks(following_callbacks)
    future.add_done_callback(finished)
    return future


def gallery_publication_revision() -> int:
    """Lock-free, for /status: read it before the inventory revision (see ``_queue``)."""
    return _PUBLICATION_REVISION


def refresh_gallery_projection_if_out_of_date(config, *, connect=None) -> bool:
    """Queue a refresh when the library gallery's sources changed since it was published, as a
    MusicBrainz match that labels a split name does. Three small reads when it is current."""
    from music_app.services.library_browse_postgres import _connect, _root_sidebar_view_state

    if config.get("SHARED_LIBRARY_BROWSE_ONLY") or not config.get("ALBUM_HAVEN_APP_DATABASE_URL"):
        return False
    with (connect or _connect)(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        context = gallery_projection_context(connection)
        if not context or _ready_header(connection, context, _root_sidebar_view_state({})):
            return False
    schedule_gallery_projection_refresh(config, connect=connect)
    return True


def queue_gallery_projection_snapshot(config, context, view_state, snapshot, *, connect=None):
    if not context:
        return None
    key = (context["library_id"], gallery_projection_scope_key(view_state))
    return _queue(config, key, lambda: publish_gallery_projection(
        config, context, view_state, snapshot, connect=connect), trailing=True, generation=context["generation"])


def schedule_gallery_projection_refresh(config, *, connect=None, view_state=None, on_published=None):
    """Queue the refresh; ``on_published`` runs once a refresh that includes the current source
    has finished (see ``_queue``)."""
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
    return _queue(config, key, lambda: ensure_gallery_projection_ready(config, **options), trailing=True,
                  on_done=on_published)


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


def _ensure_gallery_projection_ready(config, *, connect=None, cancel_requested=None, view_state=None):
    """Publish each common scope from its own coherent source snapshot.

    While a relation rebuild is pending, the scopes first publish with the last
    published families, so watcher-found artists show at once (ungrouped until
    their relations exist); the rebuilt relations then change the source
    generation and the scopes publish again.
    """
    from music_app.services import library_browse_postgres as browse
    from music_app.services.relation_projection_postgres import _raise_if_projection_cancelled
    repository = browse.PostgresLibraryBrowseRepository(config, connect=connect)
    scopes = ([view_state] if view_state is not None else
              [browse._root_sidebar_view_state(params) for params in ({}, {"gallery_scope": "new_arrivals"})])

    def publish_scopes():
        built = 0
        for state in scopes:
            _raise_if_projection_cancelled(cancel_requested)
            started_at = time.perf_counter()  # TEMPORARY FTC-OPS-016 diagnostics; remove before PR 80 merges
            with repository._connect_to_database() as connection:
                connection.execute("set transaction isolation level repeatable read, read only")
                context = gallery_projection_context(connection)
                if not context:
                    return built
                if _ready_header(connection, context, state):
                    continue
                aliases = repository._load_relation_alias_maps(connection=connection)
                if not browse._relation_aliases_servable(aliases):
                    return built
                root_aliases = browse._root_browse_alias_to_canonical(aliases["alias_to_canonical"])
                missing_rows = repository._load_missing_album_rows(connection=connection)
                rows = connection.execute(browse._root_gallery_membership_sql(), browse._root_sidebar_params(state)).fetchall()
                missing = browse._missing_album_projection_payloads(missing_rows, view_state=state)
                snapshot = browse._prepare_root_gallery_snapshot(rows, missing, root_aliases, state)
            _raise_if_projection_cancelled(cancel_requested)
            prepared_at = time.perf_counter()
            built += int(publish_gallery_projection(config, context, state, snapshot, connect=connect))
            if browse_query_diagnostics.enabled():  # TEMPORARY FTC-OPS-016 diagnostics
                _LOGGER.warning(
                    "BROWSE-DIAG gallery projection rebuilt: scope=%s albums=%s occurrences=%s prepare_ms=%.0f publish_ms=%.0f",
                    state.get("gallery_scope") or "all", snapshot.get("album_count"), len(snapshot.get("ordered") or ()),
                    (prepared_at - started_at) * 1000, (time.perf_counter() - prepared_at) * 1000)
        return built

    built = 0
    if repository._load_relation_alias_maps().get("projection_stale_reason"):
        from music_app.services.relation_projection_postgres import ensure_relation_projection_ready

        built = publish_scopes()
        ensure_relation_projection_ready(config, connect=connect, cancel_requested=cancel_requested)
    return {"built": built + publish_scopes()}
