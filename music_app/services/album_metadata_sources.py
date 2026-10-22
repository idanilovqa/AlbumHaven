"""Private exact-container evidence maintained by inventory transactions only."""
from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from music_app.services.metadata import label_origin


def reconcile_album_metadata_sources(connection, *, album_keys=None, paths=None) -> None:
    """Reconcile persisted facts after writes, preserving every physical copy.

    The caller holds the library write lock before its first inventory mutation.
    Targeted edits include both former source albums and current memberships;
    this keeps unaffected containers of a logical album in the reconciliation.
    Save/publication consumers must never call this producer.
    """
    params = {
        "all_inventory": album_keys is None and paths is None,
        "album_keys": sorted(album_keys or ()),
        "paths": sorted(paths or ()),
    }
    path_flavor = "windows" if os.name == "nt" else "posix"
    scope = connection.execute("""
        with owner_library as (
          select l.id from library.libraries l join app.bootstrap_owners o
            on o.account_id=l.owner_account_id
          where o.owner_key='local-bootstrap-owner'
            and l.name='Local Library' and l.library_kind='local'
        ), selected_albums as (
          select a.id from library.local_albums a join owner_library l on l.id=a.library_id
          where %(all_inventory)s or a.album_key=any(%(album_keys)s::text[])
          union
          select t.album_id from library.local_track_files f
          join library.local_tracks t on t.id=f.track_id
          join owner_library l on l.id=t.library_id
          where f.private_path=any(%(paths)s::text[])
          union
          select s.local_album_id from library.local_track_files f
          join library.album_metadata_sources s on s.ref=f.metadata_source_ref
          join owner_library l on l.id=s.library_id
          where f.private_path=any(%(paths)s::text[])
        )
        select l.id as library_id, array(select id from selected_albums where id is not null) as album_ids
        from owner_library l
    """, params).fetchone()
    if scope is None:
        return
    params.update(library_id=scope["library_id"], album_ids=scope["album_ids"])
    rows = connection.execute("""
        select f.id, f.private_path, f.library_root_id, t.album_id,
          t.id as track_id, t.title as track_title, a.name as track_artist,
          f.scan_cache_stale, r.is_active as root_active,
          f.metadata #> '{scan_cache,file_entry}' as file_entry
        from library.local_track_files f
        join library.local_tracks t on t.id=f.track_id
        left join library.local_artists a on a.id=t.artist_id and a.library_id=t.library_id
        join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
        where t.library_id=%(library_id)s and (
          %(all_inventory)s or t.album_id=any(%(album_ids)s::bigint[])
          or f.private_path=any(%(paths)s::text[]))
        order by f.id
    """, params).fetchall()
    groups = {}
    track_origins = {}
    unassociated = []
    for row in rows:
        entry = row["file_entry"] if isinstance(row["file_entry"], dict) else {}
        origins = track_origins.setdefault(row["track_id"], {"title": set(), "artist": set()})
        for field in ("title", "artist"):
            value = str(entry.get(field) or "").strip()
            origins[field].add(label_origin(value, entry.get(f"{field}_origin"))
                               if value == row[f"track_{field}"] else "unknown")
        if row["album_id"] is None:
            unassociated.append(row["id"])
            continue
        # Native Path semantics preserve POSIX case/backslash distinctions and
        # never collapse a CD1/CD2 name or climb to a guessed album directory.
        path = Path(row["private_path"])
        container = str(path.parent)
        if (not path.is_absolute() or ".." in path.parts
                or len(row["private_path"].encode("utf-8")) > 16384
                or len(container.encode("utf-8")) > 8192):
            unassociated.append(row["id"])
            continue
        key = (row["album_id"], row["library_root_id"], container)
        group = groups.setdefault(key, {"files": [], "titles": set(), "artists": set(), "years": set(), "valid": True})
        title = str(entry.get("album") or "").strip() or None
        artist = str(entry.get("album_artist") or "").strip() or None
        bounded_labels = all(value is None or len(value) <= 1000 for value in (title, artist))
        if title is not None and len(title) > 1000:
            title = None
        if artist is not None and len(artist) > 1000:
            artist = None
        year = entry.get("year")
        valid_year = year is None or (type(year) is int and 1 <= year <= 9999)
        group["files"].append(row["id"])
        group["titles"].add(title)
        group["artists"].add(artist)
        group["years"].add(year if valid_year else None)
        group["valid"] &= (
            valid_year and bounded_labels and row["root_active"] and not row["scan_cache_stale"]
            and label_origin(title, entry.get("album_origin")) == "tag_metadata"
            and label_origin(artist, entry.get("album_artist_origin")) == "tag_metadata"
        )
    origin_rows = [
        {"track_id": track_id, **{
            f"{field}_origin": next(iter(values)) if len(values) == 1 else "unknown"
            for field, values in origins.items()
        }}
        for track_id, origins in track_origins.items()
    ]
    for start in range(0, len(origin_rows), 1000):
        connection.execute("""
            update library.local_tracks t set title_origin=i.title_origin, artist_origin=i.artist_origin
            from jsonb_to_recordset(%(rows)s::jsonb) as i(
              track_id bigint,title_origin text,artist_origin text)
            where t.id=i.track_id and (t.title_origin,t.artist_origin)
              is distinct from (i.title_origin,i.artist_origin)
        """, {"rows": json.dumps(origin_rows[start:start + 1000])})
    sources = []
    for (album_id, root_id, container), group in groups.items():
        consistent = all(len(group[field]) == 1 for field in ("titles", "artists", "years"))
        valid = group["valid"] and consistent
        sources.append({
            "ref": str(uuid4()), "album_id": album_id, "root_id": root_id,
            "container": container, "path_flavor": path_flavor, "files": group["files"],
            "state": "active" if valid else "invalid",
            "title": next(iter(group["titles"])) if len(group["titles"]) == 1 else None,
            "artist": next(iter(group["artists"])) if len(group["artists"]) == 1 else None,
            "year": next(iter(group["years"])) if len(group["years"]) == 1 else None,
            "origin": "tag_metadata" if valid else "unknown",
        })
    for start in range(0, len(sources), 1000):
        batch = {"library_id": params["library_id"], "rows": json.dumps(sources[start:start + 1000])}
        connection.execute("""
            insert into library.album_metadata_sources as s (
              ref,library_id,local_album_id,library_root_id,container_identity,path_flavor,
              capture_builder_version,state,title,artist,year,title_origin,artist_origin)
            select i.ref,%(library_id)s,i.album_id,i.root_id,i.container,i.path_flavor,1,
              i.state,i.title,i.artist,i.year,i.origin,i.origin
            from jsonb_to_recordset(%(rows)s::jsonb) as i(
              ref uuid,album_id bigint,root_id bigint,container text,path_flavor text,state text,
              title text,artist text,year integer,origin text)
            on conflict(library_id,local_album_id,library_root_id,path_flavor,(pg_catalog.md5(container_identity)))
            do update set capture_builder_version=1,state=excluded.state,
              title=excluded.title,artist=excluded.artist,year=excluded.year,
              title_origin=excluded.title_origin,artist_origin=excluded.artist_origin
            where s.container_identity collate "C"=excluded.container_identity collate "C"
              and (s.capture_builder_version,s.state,s.title,s.artist,s.year,s.title_origin,s.artist_origin)
              is distinct from (1,excluded.state,excluded.title,excluded.artist,excluded.year,
                excluded.title_origin,excluded.artist_origin)
        """, batch)
        # A digest conflict is not identity. Re-read every exact input after
        # the upsert (also its unchanged rows) before associating this batch.
        # A collision must escape the surrounding transaction, rolling back
        # prior inventory/provenance writes and any earlier source batches.
        missing = connection.execute("""
            select exists (
              select 1 from jsonb_to_recordset(%(rows)s::jsonb) as i(
                album_id bigint,root_id bigint,container text,path_flavor text)
              where not exists (
                select 1 from library.album_metadata_sources s
                where s.library_id=%(library_id)s and s.local_album_id=i.album_id
                  and s.library_root_id=i.root_id and s.path_flavor=i.path_flavor
                  and pg_catalog.md5(s.container_identity)=pg_catalog.md5(i.container)
                  and s.container_identity collate "C"=i.container collate "C")
            ) as missing_identity
        """, batch).fetchone()
        if missing["missing_identity"]:
            raise RuntimeError("Metadata source identity conflict.")
        connection.execute("""
            update library.local_track_files f set metadata_source_ref=s.ref
            from jsonb_to_recordset(%(rows)s::jsonb) as i(
              album_id bigint,root_id bigint,container text,path_flavor text,files jsonb)
            cross join lateral jsonb_array_elements_text(i.files) as member(file_id)
            join library.album_metadata_sources s on s.library_id=%(library_id)s
              and s.local_album_id=i.album_id and s.library_root_id=i.root_id
              and s.path_flavor=i.path_flavor
              and pg_catalog.md5(s.container_identity)=pg_catalog.md5(i.container)
              and s.container_identity collate "C"=i.container collate "C"
            where f.id=member.file_id::bigint
              and f.metadata_source_ref is distinct from s.ref
        """, batch)
    connection.execute("""
        update library.local_track_files set metadata_source_ref=null
        where id=any(%(ids)s::bigint[]) and metadata_source_ref is not null
    """, {"ids": unassociated})
    params["sources"] = json.dumps([
        {key: source[key] for key in ("album_id", "root_id", "container", "path_flavor")}
        for source in sources
    ])
    connection.execute("""
        update library.album_metadata_sources s set state='invalid'
        where s.library_id=%(library_id)s and s.state<>'invalid'
          and (%(all_inventory)s or s.local_album_id=any(%(album_ids)s::bigint[]))
          and not exists (
            select 1 from jsonb_to_recordset(%(sources)s::jsonb) as i(
              album_id bigint,root_id bigint,container text,path_flavor text)
            where i.album_id=s.local_album_id and i.root_id=s.library_root_id
              and i.path_flavor=s.path_flavor
              and pg_catalog.md5(i.container)=pg_catalog.md5(s.container_identity)
              and i.container collate "C"=s.container_identity collate "C")
    """, params)
