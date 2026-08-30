from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_MAINTENANCE_DATABASE_URL_KEY = "ALBUM_HAVEN_DATABASE_URL"
_TARGET_RELATION = "library.local_album_featured_artists"
_TARGET_MIGRATION = "0019_create_local_album_featured_artists.sql"


@dataclass(frozen=True)
class RepairReport:
    deleted_rows: int
    inserted_rows: int
    distinct_artist_count: int
    distinct_album_count: int


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required to rebuild local album featured artists.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _database_url_for_mode(*, apply: bool) -> str:
    candidate_keys = (
        (_MAINTENANCE_DATABASE_URL_KEY, _APP_DATABASE_URL_KEY)
        if apply
        else (_APP_DATABASE_URL_KEY, _MAINTENANCE_DATABASE_URL_KEY)
    )
    for key in candidate_keys:
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    if apply:
        raise RuntimeError(
            f"{_MAINTENANCE_DATABASE_URL_KEY} or {_APP_DATABASE_URL_KEY} is required for --apply."
        )
    raise RuntimeError(
        f"{_APP_DATABASE_URL_KEY} or {_MAINTENANCE_DATABASE_URL_KEY} is required."
    )


def _apply_preflight_sql() -> str:
    return f"""
        with target_relation as (
          select to_regclass('{_TARGET_RELATION}') as relation_oid
        )
        select
          relation_oid is not null as relation_exists,
          coalesce(has_table_privilege(current_user, relation_oid, 'DELETE'), false) as has_delete,
          coalesce(has_table_privilege(current_user, relation_oid, 'INSERT'), false) as has_insert,
          coalesce(has_table_privilege(current_user, relation_oid, 'UPDATE'), false) as has_update
        from target_relation;
    """


def _ensure_apply_ready(connection: Any) -> None:
    row = connection.execute(_apply_preflight_sql()).fetchone()
    payload = dict(row or {})
    if not bool(payload.get("relation_exists")):
        raise RuntimeError(
            f"{_TARGET_RELATION} is missing. Apply migrations through {_TARGET_MIGRATION} before rerunning this repair."
        )
    missing_privileges = [
        privilege
        for privilege, allowed in (
            ("DELETE", payload.get("has_delete")),
            ("INSERT", payload.get("has_insert")),
            ("UPDATE", payload.get("has_update")),
        )
        if not bool(allowed)
    ]
    if missing_privileges:
        joined = ", ".join(missing_privileges)
        raise RuntimeError(
            f"Current database role lacks {joined} on {_TARGET_RELATION}. "
            f"Prefer {_MAINTENANCE_DATABASE_URL_KEY} with album_haven_migrator credentials for --apply."
        )


def _bootstrap_context_cte() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
    """


def _repair_source_rows_sql() -> str:
    return (
        _bootstrap_context_cte()
        + """
        ,
        owner_rows as (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.artist_id,
            'owner'::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.artist_id is not null
        ),
        metadata_member_rows as (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_artists.id as artist_id,
            'featured_member'::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          join lateral jsonb_array_elements_text(
            coalesce(library.local_albums.metadata -> 'featured_artists', '[]'::jsonb)
          ) as featured_artist(name)
            on true
          join library.local_artists
            on library.local_artists.library_id = library.local_albums.library_id
           and library.local_artists.artist_key = lower(featured_artist.name)
          where library.local_artists.id <> coalesce(library.local_albums.artist_id, -1)
        ),
        track_rows as (
          select distinct
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.artist_id,
            case
              when library.local_tracks.artist_id = library.local_albums.artist_id then 'owner'
              else 'featured_track_artist'
            end::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_albums
            on library.local_albums.id = library.local_tracks.album_id
          where library.local_tracks.album_id is not null
            and library.local_tracks.artist_id is not null
        ),
        source_rows as (
          select * from owner_rows
          union
          select * from metadata_member_rows
          union
          select * from track_rows
        )
        select
          count(*)::integer as inserted_rows,
          count(distinct artist_id)::integer as distinct_artist_count,
          count(distinct album_id)::integer as distinct_album_count
        from source_rows;
    """
    )


def _apply_repair_sql() -> str:
    return (
        _bootstrap_context_cte()
        + """
        ,
        deleted_rows as (
          delete from library.local_album_featured_artists
          using bootstrap_context
          where library.local_album_featured_artists.library_id = bootstrap_context.library_id
          returning 1
        ),
        owner_rows as (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_albums.artist_id,
            'owner'::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.artist_id is not null
        ),
        metadata_member_rows as (
          select distinct
            library.local_albums.library_id,
            library.local_albums.id as album_id,
            library.local_artists.id as artist_id,
            'featured_member'::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_albums
          join bootstrap_context
            on bootstrap_context.library_id = library.local_albums.library_id
          join lateral jsonb_array_elements_text(
            coalesce(library.local_albums.metadata -> 'featured_artists', '[]'::jsonb)
          ) as featured_artist(name)
            on true
          join library.local_artists
            on library.local_artists.library_id = library.local_albums.library_id
           and library.local_artists.artist_key = lower(featured_artist.name)
          where library.local_artists.id <> coalesce(library.local_albums.artist_id, -1)
        ),
        track_rows as (
          select distinct
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            library.local_tracks.artist_id,
            case
              when library.local_tracks.artist_id = library.local_albums.artist_id then 'owner'
              else 'featured_track_artist'
            end::text as featured_kind,
            jsonb_build_object('source', 'repair_featured_artist_backfill')
              as metadata
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_albums
            on library.local_albums.id = library.local_tracks.album_id
          where library.local_tracks.album_id is not null
            and library.local_tracks.artist_id is not null
        ),
        source_rows as (
          select * from owner_rows
          union
          select * from metadata_member_rows
          union
          select * from track_rows
        ),
        inserted_rows as (
          insert into library.local_album_featured_artists (
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          )
          select
            library_id,
            album_id,
            artist_id,
            featured_kind,
            metadata
          from source_rows
          on conflict (library_id, album_id, artist_id, featured_kind) do update
            set last_seen_at = now(),
                metadata = library.local_album_featured_artists.metadata || excluded.metadata
          returning artist_id, album_id
        )
        select
          (select count(*)::integer from deleted_rows) as deleted_rows,
          count(*)::integer as inserted_rows,
          count(distinct artist_id)::integer as distinct_artist_count,
          count(distinct album_id)::integer as distinct_album_count
        from inserted_rows;
    """
    )


def rebuild_featured_artist_rows(*, apply: bool) -> RepairReport:
    database_url = _database_url_for_mode(apply=apply)
    with _connect(database_url) as connection:
        if apply:
            _ensure_apply_ready(connection)
        sql = _apply_repair_sql() if apply else _repair_source_rows_sql()
        row = connection.execute(sql).fetchone()
        if apply:
            connection.commit()
        payload = dict(row or {})
    return RepairReport(
        deleted_rows=int(payload.get("deleted_rows") or 0),
        inserted_rows=int(payload.get("inserted_rows") or 0),
        distinct_artist_count=int(payload.get("distinct_artist_count") or 0),
        distinct_album_count=int(payload.get("distinct_album_count") or 0),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild local album featured-artist rows from persisted local albums and tracks.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the rebuild. Without this flag, the script reports the rows it would write.",
    )
    args = parser.parse_args()
    report = rebuild_featured_artist_rows(apply=bool(args.apply))
    mode = "applied" if args.apply else "dry-run"
    print(
        f"{mode}: deleted={report.deleted_rows} inserted={report.inserted_rows} "
        f"artists={report.distinct_artist_count} albums={report.distinct_album_count}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
