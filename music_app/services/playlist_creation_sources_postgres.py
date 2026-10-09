"""Bounded live inventory search and immutable per-observation Playlist receipts.

The caller owns the authenticated transaction. Neither a page nor this selection
session claims to be a complete catalogue snapshot.
"""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
import json
from uuid import UUID, uuid4, uuid5

from music_app.services.owned_playlists import (
    PLAYLIST_SOURCE_PROTOCOL, MAX_PLAYLIST_ITEMS_PER_COMMAND, MAX_PLAYLIST_COMMAND_BYTES,
    PlaylistError, evidence_digest, uuid_ref,
)

SOURCE_LIFETIME = timedelta(minutes=30)
PAGE_SIZE = 100
_FACT_FIELDS = ("title", "artist", "album_title", "original_album_id", "release_year",
                "disc_number", "track_number", "duration_seconds", "availability")
_SORT_VERSION = "title-album-v1"
_SORT = """case when %(query)s <> '' and lower(regexp_replace(btrim(t.title), '\\s+', ' ', 'g')) = lower(%(query)s) then 0 else 1 end,
 case when a.id is null then 1 else 0 end,
 case when a.release_year > 0 then a.release_year else 2147483647 end, coalesce(a.id,t.id),
 case when t.disc_number > 0 then t.disc_number else 2147483647 end,
 case when t.track_number > 0 then t.track_number else 2147483647 end, t.id"""
_INVENTORY = """
 select t.id as original_local_track_id, t.title,
        jsonb_build_array(t.track_key, t.artist_id, coalesce((
          select jsonb_agg(jsonb_build_array(f.id, f.library_root_id, f.private_path,
            f.file_size_bytes, f.modified_at, f.content_signature, f.scan_cache_stale,
            r.library_id, r.is_active, r.root_path, r.metadata->>'root_id',
            f.metadata#>>'{scan_cache,stale_marked_at}') order by f.id)
          from library.local_track_files f
          left join library.library_roots r on r.id=f.library_root_id
          where f.track_id=t.id
        ), '[]'::jsonb)) as inventory_evidence,
        ar.name as artist, a.title as album_title, a.id as original_album_id,
        case when a.release_year > 0 then a.release_year end as release_year,
        case when t.disc_number > 0 then t.disc_number end as disc_number,
        case when t.track_number > 0 then t.track_number end as track_number,
        case when t.duration_seconds >= 0 then t.duration_seconds end as duration_seconds,
        case when exists (
          select 1 from library.local_track_files f
          join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
          where f.track_id=t.id and f.scan_cache_stale is false and r.is_active is true
            and not exists (select 1 from library.libraries health where health.id=t.library_id
              and coalesce(health.metadata->'library_watch_health','{}'::jsonb) ?
                coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id'))
        ) then 'local' else 'unresolved' end as availability
 from library.local_tracks t
 left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
 left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
"""


def _plain(row):
    return {key: (float(value) if value.is_finite() else None) if isinstance(value, Decimal) else value
            for key, value in dict(row).items()}


def entry_evidence(row):
    # Private file identity is hashed only, never copied into browser DTOs or
    # saved originals. Replacing a file must invalidate an observed selection
    # even when its title, duration and coarse availability are unchanged.
    return evidence_digest({key: row.get(key) for key in
                            ("original_local_track_id", "inventory_evidence", *_FACT_FIELDS)})


def inventory_rows(connection, library_id, track_ids, *, lock=False, config=None):
    """Resolve expected real IDs, never paths or labels; optionally freeze rows."""
    if not track_ids:
        return {}
    ids = sorted(set(track_ids))
    if lock:
        # Protect identity deletion/replacement. Parent/file observations are
        # re-read after their row locks; no nullable outer-join locking clauses.
        # UPDATE also excludes a new file's FK KEY SHARE lock; SHARE alone
        # would allow phantom child files after validating selected evidence.
        connection.execute("select id from library.local_tracks where library_id=%s and id=any(%s::bigint[]) order by id for update", (library_id, ids)).fetchall()
        connection.execute("select id from library.local_albums where library_id=%s and id in (select album_id from library.local_tracks where library_id=%s and id=any(%s::bigint[])) order by id for share", (library_id, library_id, ids)).fetchall()
        connection.execute("select id from library.local_artists where library_id=%s and id in (select artist_id from library.local_tracks where library_id=%s and id=any(%s::bigint[])) order by id for share", (library_id, library_id, ids)).fetchall()
        connection.execute("select id from library.local_track_files where track_id=any(%s::bigint[]) order by id for share", (ids,)).fetchall()
        connection.execute("select id from library.library_roots where library_id=%s and id in (select library_root_id from library.local_track_files where track_id=any(%s::bigint[])) order by id for share", (library_id, ids)).fetchall()
    rows = connection.execute(_INVENTORY + " where t.library_id=%s and t.id=any(%s::bigint[]) order by t.id", (library_id, ids)).fetchall()
    result={int(row["original_local_track_id"]): _plain(row) for row in rows}
    if config is not None:
        from music_app.services.playlist_availability import confirm_missing_availability
        result=confirm_missing_availability(connection,library_id,result,config=config)
    return result


def begin_source(connection, context, now):
    ceiling = connection.execute("select coalesce(max(id),0) as upper_id from library.local_tracks where library_id=%s", (context.library_id,)).fetchone()["upper_id"]
    source = {"ref": str(uuid4()), "revision": str(uuid4()), "library_id": context.library_id,
              "actor_account_id": context.actor.account_id, "session_id": context.actor.session_id,
              "expires_at": now + SOURCE_LIFETIME, "inventory_upper_id": ceiling}
    connection.execute("""insert into app.playlist_creation_sources
        (ref,revision,actor_account_id,session_id,library_id,protocol,expires_at,inventory_upper_id)
        values (%(ref)s,%(revision)s,%(actor_account_id)s,%(session_id)s,%(library_id)s,
                'library_selection_v1',%(expires_at)s,%(inventory_upper_id)s)""", source)
    return source_envelope(source)


def source_envelope(source):
    return {"source_protocol": source.get("protocol", PLAYLIST_SOURCE_PROTOCOL), "mode": "ordinary",
            "source": {"kind": source.get("source_kind", "library"), "ref": str(source["ref"]), "revision": str(source["revision"])},
            "allowed_actions": {"can_read": True, "can_use_for_playlist": True},
            "expires_at": source["expires_at"].isoformat(), "page_size": PAGE_SIZE,
            "max_selected_entries": MAX_PLAYLIST_ITEMS_PER_COMMAND, "max_command_bytes": MAX_PLAYLIST_COMMAND_BYTES}


def load_source(connection, context, ref, revision, now, *, protocol=PLAYLIST_SOURCE_PROTOCOL, kind="library"):
    ref, revision = uuid_ref(ref), uuid_ref(revision)
    source = connection.execute("""select * from app.playlist_creation_sources
        where ref=%s and actor_account_id=%s and session_id=%s and library_id=%s
        for share""", (ref, context.actor.account_id, context.actor.session_id, context.library_id)).fetchone()
    if source is None:
        raise PlaylistError("source_unavailable", 404)
    if (str(source["revision"]) != revision or source["protocol"] != protocol
            or source.get("source_kind", "library") != kind):
        raise PlaylistError("source_changed", 409)
    if source["expires_at"] <= now:
        raise PlaylistError("source_expired", 410)
    return dict(source)


def _cursor_payload(source, query):
    return {"source": str(source["ref"]), "revision": str(source["revision"]), "query": query,
            "upper": int(source["inventory_upper_id"]), "sort": _SORT_VERSION}


def _decode_cursor(connection, cursor, identity):
    try:
        reference = uuid_ref(cursor)
    except PlaylistError:
        raise PlaylistError("invalid_cursor") from None
    stored = connection.execute("""select payload from app.playlist_source_cursors
        where ref=%s and source_ref=%s""", (reference, identity["source"])).fetchone()
    if stored is None:
        raise PlaylistError("invalid_cursor")
    decoded = stored["payload"]
    if not isinstance(decoded, dict) or set(decoded) != {*identity, "after", "search_revision"}:
        raise PlaylistError("invalid_cursor")
    if any(decoded[key] != value for key, value in identity.items()):
        raise PlaylistError("invalid_cursor")
    after = decoded["after"]
    if (not isinstance(after, list) or len(after) != 7 or any(type(value) is not int or value < 0 or value > 9223372036854775807 for value in after)
            or after[0] not in (0, 1) or after[1] not in (0, 1) or after[-1] > identity["upper"]):
        raise PlaylistError("invalid_cursor")
    try:
        revision = uuid_ref(decoded["search_revision"])
    except PlaylistError:
        raise PlaylistError("invalid_cursor") from None
    return after, revision


def _encode_cursor(connection, identity, row):
    # The browser receives only a random reference. Keyset facts can belong to a
    # filtered-out inventory row and must remain inside this private receipt.
    reference = str(uuid4())
    payload = {**identity, "after": list(row["sort_key"])}
    connection.execute("""insert into app.playlist_source_cursors(ref,source_ref,payload)
        values (%s,%s,%s::jsonb)""", (reference, identity["source"], json.dumps(payload, allow_nan=False)))
    return reference


def _observe_page(connection, source, rows):
    if not rows:
        return []
    observations = []
    for row in rows:
        values = {key: row.get(key) for key in _FACT_FIELDS}
        values.update(ref=str(uuid4()), source_ref=str(source["ref"]),
            selection_ref=str(uuid5(UUID(str(source["ref"])), f"inventory:{source['library_id']}:{row['original_local_track_id']}")),
            original_local_track_id=row["original_local_track_id"], evidence_digest=entry_evidence(row),
            source_lineage=row.get("source_lineage"))
        observations.append(values)
    # One bounded page insert/read, not two network round trips per result.
    encoded = json.dumps(observations, allow_nan=False)
    connection.execute("""insert into app.playlist_creation_entries
      (ref,source_ref,selection_ref,original_local_track_id,evidence_digest,title,artist,
       album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,availability,source_lineage)
      select ref,source_ref,selection_ref,original_local_track_id,evidence_digest,title,artist,
       album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,availability,source_lineage
      from jsonb_to_recordset(%s::jsonb) as input(
       ref uuid,source_ref uuid,selection_ref uuid,original_local_track_id bigint,evidence_digest text,
       title text,artist text,album_title text,original_album_id bigint,release_year integer,
       disc_number integer,track_number integer,duration_seconds numeric,availability text,source_lineage jsonb)
      on conflict(source_ref,original_local_track_id,evidence_digest) do nothing""", (encoded,))
    stored = connection.execute("""select e.* from app.playlist_creation_entries e
      join jsonb_to_recordset(%s::jsonb) as input(original_local_track_id bigint,evidence_digest text)
       on input.original_local_track_id=e.original_local_track_id and input.evidence_digest=e.evidence_digest
      where e.source_ref=%s""", (encoded, str(source["ref"]))).fetchall()
    by_identity = {(row["original_local_track_id"], row["evidence_digest"]): _plain(row) for row in stored}
    if len(by_identity) != len(observations):
        raise RuntimeError("Playlist source observations were not stored.")
    return [by_identity[(row["original_local_track_id"], row["evidence_digest"])] for row in observations]


def project_entry(source, row, *, album_readable=None):
    album_id = row.get("original_album_id")
    if album_id is not None and album_readable is not None and not album_readable(album_id):
        parent_row = {"album_title":None,"release_year":None}
        album_id = None
    else:
        parent_row = row
    parent = {"state": "known" if album_id is not None else "unknown", "album_ref": None,
              "title": parent_row.get("album_title"), "artist": None, "year": parent_row.get("release_year"),
              "availability": "unresolved", "completeness": "unknown",
              "allowed_actions": {"can_read": album_id is not None, "can_view_details": False, "can_create_album_top": False}}
    if album_id is not None:
        parent["album_ref"] = f"inventory-album:{source['library_id']}:{album_id}"
    return {"entry_ref": str(row["ref"]), "selection_ref": str(row["selection_ref"]),
            "inventory_track_ref": (f"inventory-track:{source['library_id']}:{row['original_local_track_id']}"
                if row.get("original_local_track_id") is not None else None),
            "canonical_track_ref": None, **{key: row.get(key) for key in _FACT_FIELDS if key != "original_album_id"},
            "metadata_state": "last_known", "source_kind": source.get("source_kind","library"),
            "source_label":row.get("source_label"),"source_row_ref":row.get("source_row_ref"), "allowed_actions": {"can_read": True, "can_select": True},
            "parent_album": parent}


def search_entries(connection, context, source, *, query="", cursor=None, limit=PAGE_SIZE, is_readable=None, album_readable=None, config=None):
    if not isinstance(query, str) or len(query) > 200 or "\x00" in query or type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
        raise PlaylistError("invalid_source_query")
    query = " ".join(query.strip().split())
    identity = _cursor_payload(source, query)
    after, search_revision = _decode_cursor(connection, cursor, identity) if cursor is not None else (None, str(uuid4()))
    identity["search_revision"] = search_revision
    pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    params = {"library": context.library_id, "query": query, "pattern": pattern,
              "upper": source["inventory_upper_id"], "limit": limit + 1}
    predicate = ""
    if after is not None:
        params.update({f"after_{index}": value for index, value in enumerate(after)})
        predicate = " and ROW(" + _SORT + ") > ROW(" + ",".join(f"%(after_{i})s" for i in range(7)) + ")"
    select = _INVENTORY.replace("select t.id", "select ARRAY[" + _SORT + "]::bigint[] as sort_key, t.id", 1)
    rows = connection.execute(select + """ where t.library_id=%(library)s and t.id<=%(upper)s
       and (%(query)s='' or lower(regexp_replace(concat_ws(' ',t.title,ar.name,a.title), '\\s+', ' ', 'g')) ilike %(pattern)s escape '\\')
       """ + predicate + " order by " + _SORT + " limit %(limit)s", params).fetchall()
    page = [_plain(row) for row in rows[:limit]]
    if config is not None:
        from music_app.services.playlist_availability import confirm_missing_availability
        checked=confirm_missing_availability(connection,context.library_id,
            {row["original_local_track_id"]:row for row in page},config=config)
        page=[checked[row["original_local_track_id"]] for row in page]
    visible = page if is_readable is None else [row for row in page if is_readable(row["original_local_track_id"])]
    entries = [project_entry(source, row, album_readable=album_readable) for row in _observe_page(connection, source, visible)]
    return {**source_envelope(source), "query": query, "search_revision": search_revision,
            "entries": entries, "entries_complete": False, "limit": limit, "has_more": len(rows) > limit,
            "next_cursor": _encode_cursor(connection, identity, page[-1]) if len(rows) > limit else None}


def selected_entries(connection, context, source, entry_refs, *, config=None):
    if not entry_refs:
        return []
    rows = connection.execute("""select * from app.playlist_creation_entries
        where source_ref=%s and ref=any(%s::uuid[])""", (source["ref"], entry_refs)).fetchall()
    by_ref = {str(row["ref"]): _plain(row) for row in rows}
    if set(by_ref) != set(entry_refs):
        raise PlaylistError("source_unavailable", 409)
    selected = [by_ref[ref] for ref in entry_refs]
    ids = [row["original_local_track_id"] for row in selected]
    if len(set(ids)) != len(ids):
        raise PlaylistError("duplicate_identity", 409)
    current = inventory_rows(connection, context.library_id, ids, lock=True, config=config)
    if len(current) != len(ids) or any(entry_evidence(current[row["original_local_track_id"]]) != row["evidence_digest"] for row in selected):
        raise PlaylistError("source_changed", 409)
    return selected
