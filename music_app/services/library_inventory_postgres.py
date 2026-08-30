from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
DEFAULT_NON_ALBUM_CANDIDATE_LIMIT = 1000
MAX_NON_ALBUM_CANDIDATE_LIMIT = 5000


def local_inventory_identity_key(value: object) -> str:
    """Return the durable Phase 6 identity key without rewriting display text."""
    return " ".join(str(value or "").strip().casefold().split())


def is_library_inventory_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class PostgresLibraryInventoryRepository:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_support_state(self, *, connection: Any | None = None) -> dict[str, object]:
        """Load version support state in one snapshot-safe, non-multiplying query."""
        if connection is None:
            with self._connect_to_database() as owned_connection:
                cursor = owned_connection.execute(_support_state_sql(), {})
                row = cursor.fetchone()
        else:
            cursor = connection.execute(_support_state_sql(), {})
            row = cursor.fetchone()
        payload = _row_mapping(
            row,
            ("ignored_version_keys", "manual_version_links"),
        )
        ignored_version_keys = sorted(
            str(value)
            for value in (payload.get("ignored_version_keys") or [])
            if str(value or "").strip()
        )
        manual_version_links = payload.get("manual_version_links")
        if not isinstance(manual_version_links, Mapping):
            manual_version_links = {}
        return {
            "ignored_version_keys": ignored_version_keys,
            "manual_version_links": {
                str(child_key): str(manual_version_links[child_key])
                for child_key in sorted(manual_version_links, key=lambda value: str(value))
            },
        }

    def load_non_album_candidates(
        self,
        *,
        track_ids: Iterable[object] | None = None,
        private_paths: Iterable[object] | None = None,
        limit: object = DEFAULT_NON_ALBUM_CANDIDATE_LIMIT,
        connection: Any | None = None,
    ) -> list[dict[str, object]]:
        """Load bounded raw inventory candidates without shaping browse payloads."""
        normalized_track_ids = sorted(
            {
                int(track_id)
                for track_id in (track_ids or ())
                if str(track_id or "").strip() and int(track_id) > 0
            }
        )
        normalized_private_paths = sorted(
            {
                str(private_path).strip()
                for private_path in (private_paths or ())
                if str(private_path or "").strip()
            }
        )
        bounded_limit = max(1, min(int(limit), MAX_NON_ALBUM_CANDIDATE_LIMIT))
        params = {
            "track_ids": normalized_track_ids,
            "track_id_count": len(normalized_track_ids),
            "private_paths": normalized_private_paths,
            "private_path_count": len(normalized_private_paths),
            "limit": bounded_limit,
        }
        if connection is None:
            with self._connect_to_database() as owned_connection:
                cursor = owned_connection.execute(_non_album_candidates_sql(), params)
                return [dict(_row_mapping(row)) for row in cursor.fetchall()]
        cursor = connection.execute(_non_album_candidates_sql(), params)
        return [dict(_row_mapping(row)) for row in cursor.fetchall()]

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres library inventory."
            )
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres library inventory.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _row_mapping(
    row: object,
    columns: tuple[str, ...] = (),
) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)):
        return dict(zip(columns, row, strict=False))
    return {}


def _non_album_value_predicate_sql(value_expression: str) -> str:
    normalized_value = f"lower(btrim({value_expression}))"
    return f"""(
      {normalized_value} in (
        '', 'unknown', 'unknown artist', 'unknown album', 'none', 'null'
      )
      or {normalized_value} ~ '^[!\\-\\s\\[\\(]*non[\\s\\-_]*album(?:\\y.*)?$'
    )"""


def _bootstrap_context_sql() -> str:
    return """
        select library.libraries.id as library_id
        from app.bootstrap_owners
        join library.libraries
          on library.libraries.owner_account_id = app.bootstrap_owners.account_id
         and library.libraries.name = 'Local Library'
         and library.libraries.library_kind = 'local'
        where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
        limit 1
    """


def _support_state_sql() -> str:
    return f"""
        with bootstrap_context as (
          {_bootstrap_context_sql()}
        ),
        ignored_version_state as (
          select coalesce(
            array_agg(library.ignored_versions.version_key order by library.ignored_versions.version_key),
            array[]::text[]
          ) as ignored_version_keys
          from library.ignored_versions
          join bootstrap_context
            on bootstrap_context.library_id = library.ignored_versions.library_id
        ),
        manual_version_state as (
          select coalesce(
            jsonb_object_agg(
              library.manual_versions.child_key,
              library.manual_versions.parent_key
              order by library.manual_versions.child_key
            ),
            '{{}}'::jsonb
          ) as manual_version_links
          from library.manual_versions
          join bootstrap_context
            on bootstrap_context.library_id = library.manual_versions.library_id
        )
        select
          (select ignored_version_keys from ignored_version_state) as ignored_version_keys,
          (select manual_version_links from manual_version_state) as manual_version_links;
    """


def _non_album_candidates_sql() -> str:
    stored_file_album = "coalesce(library.local_track_files.scan_file_album, '')"
    stored_non_album_predicate = _non_album_value_predicate_sql(stored_file_album)
    effective_album = """coalesce(
      library.local_track_files.scan_file_album,
      library.local_tracks.metadata ->> 'album',
      library.local_albums.title,
      ''
    )"""
    effective_non_album_predicate = _non_album_value_predicate_sql(effective_album)
    return f"""
        with bootstrap_context as (
          {_bootstrap_context_sql()}
        ),
        eligible_track_file_ids as (
          select library.local_track_files.id as track_file_id
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
          where library.local_track_files.scan_cache_stale is false
            and {stored_non_album_predicate}

          union

          select library.local_track_files.id as track_file_id
          from library.exception_overrides
          join bootstrap_context
            on bootstrap_context.library_id = library.exception_overrides.library_id
          join library.local_track_files
            on library.local_track_files.private_path = library.exception_overrides.track_key
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
           and library.local_tracks.library_id = library.exception_overrides.library_id

          union

          select library.local_track_files.id as track_file_id
          from library.exception_overrides
          join bootstrap_context
            on bootstrap_context.library_id = library.exception_overrides.library_id
          join library.local_tracks
            on library.local_tracks.id = library.exception_overrides.track_id
           and library.local_tracks.library_id = library.exception_overrides.library_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
        ),
        active_track_files as (
          select
            library.local_track_files.id,
            library.local_track_files.track_id,
            library.local_track_files.private_path
          from library.local_track_files
          join eligible_track_file_ids
            on eligible_track_file_ids.track_file_id = library.local_track_files.id
          where library.local_track_files.scan_cache_stale is false
            and (
              %(private_path_count)s = 0
              or library.local_track_files.private_path = any(%(private_paths)s::text[])
            )
        ),
        exception_candidates as (
          select
            active_track_files.id as track_file_id,
            library.exception_overrides.id,
            library.exception_overrides.track_key,
            library.exception_overrides.override_payload,
            library.exception_overrides.updated_at,
            0 as match_priority
          from library.exception_overrides
          join bootstrap_context
            on bootstrap_context.library_id = library.exception_overrides.library_id
          join active_track_files
            on active_track_files.private_path = library.exception_overrides.track_key
          join library.local_tracks
            on library.local_tracks.id = active_track_files.track_id
           and library.local_tracks.library_id = library.exception_overrides.library_id

          union all

          select
            active_track_files.id as track_file_id,
            library.exception_overrides.id,
            library.exception_overrides.track_key,
            library.exception_overrides.override_payload,
            library.exception_overrides.updated_at,
            1 as match_priority
          from library.exception_overrides
          join bootstrap_context
            on bootstrap_context.library_id = library.exception_overrides.library_id
          join library.local_tracks
            on library.local_tracks.id = library.exception_overrides.track_id
           and library.local_tracks.library_id = library.exception_overrides.library_id
          join active_track_files
            on active_track_files.track_id = library.local_tracks.id
        ),
        ranked_exception_overrides as (
          select
            exception_candidates.*,
            row_number() over (
              partition by exception_candidates.track_file_id
              order by
                exception_candidates.match_priority,
                exception_candidates.updated_at desc,
                exception_candidates.id desc
            ) as match_rank
          from exception_candidates
        )
        select
          library.local_tracks.id as track_id,
          library.local_tracks.track_key,
          library.local_tracks.title as track_title,
          library.local_tracks.disc_number,
          library.local_tracks.track_number,
          library.local_tracks.duration_seconds,
          library.local_tracks.metadata as track_metadata,
          library.local_tracks.metadata ->> 'album' as raw_track_album,
          library.local_tracks.metadata ->> 'album_artist' as raw_track_album_artist,
          library.local_artists.id as artist_id,
          library.local_artists.artist_key,
          library.local_artists.name as artist_name,
          library.local_artists.sort_name as artist_sort_name,
          library.local_artists.metadata as artist_metadata,
          library.local_albums.id as album_id,
          library.local_albums.album_key,
          library.local_albums.title as album_title,
          library.local_albums.release_year as album_release_year,
          library.local_albums.cover_path as album_cover_path,
          library.local_albums.metadata as album_metadata,
          library.local_albums.metadata ->> 'album_artist' as raw_album_artist,
          active_track_files.id as track_file_id,
          active_track_files.private_path,
          library.local_track_files.relative_path,
          library.local_track_files.file_size_bytes,
          library.local_track_files.modified_at,
          library.local_track_files.content_signature,
          library.local_track_files.metadata as track_file_metadata,
          library.local_track_files.metadata #> '{{scan_cache,file_entry}}' as file_entry,
          library.local_track_files.metadata #>> '{{scan_cache,file_entry,album}}' as raw_file_album,
          library.local_track_files.metadata #>> '{{scan_cache,file_entry,album_artist}}' as raw_file_album_artist,
          library.local_track_files.metadata #>> '{{scan_cache,file_entry,artist}}' as raw_file_artist,
          library.local_track_files.metadata #>> '{{scan_cache,file_entry,title}}' as raw_file_title,
          library.local_track_files.metadata #>> '{{scan_cache,file_entry,library_root_category}}' as raw_file_category,
          library.library_roots.id as root_id,
          library.library_roots.root_path,
          library.library_roots.root_kind,
          library.library_roots.metadata as root_metadata,
          coalesce(
            nullif(library.local_track_files.metadata ->> 'library_root_category', ''),
            nullif(
              library.local_track_files.metadata #>> '{{scan_cache,file_entry,library_root_category}}',
              ''
            ),
            library.library_roots.root_kind
          ) as library_root_category,
          exception_override.id as exception_override_id,
          exception_override.track_key as exception_override_track_key,
          exception_override.override_payload as exception_override_payload,
          exception_override.exception_type,
          coalesce(
            exception_override.override_payload ? 'exception_type',
            false
          ) as exception_override_present
        from library.local_tracks
        join bootstrap_context
          on bootstrap_context.library_id = library.local_tracks.library_id
        join active_track_files
          on active_track_files.track_id = library.local_tracks.id
        join library.local_track_files
          on library.local_track_files.id = active_track_files.id
        left join library.local_artists
          on library.local_artists.id = library.local_tracks.artist_id
         and library.local_artists.library_id = library.local_tracks.library_id
        left join library.local_albums
          on library.local_albums.id = library.local_tracks.album_id
         and library.local_albums.library_id = library.local_tracks.library_id
        join library.library_roots
          on library.library_roots.id = library.local_track_files.library_root_id
         and library.library_roots.library_id = library.local_tracks.library_id
         and library.library_roots.is_active is true
        left join (
          select
            ranked_exception_overrides.track_file_id,
            ranked_exception_overrides.id,
            ranked_exception_overrides.track_key,
            ranked_exception_overrides.override_payload,
            coalesce(
              nullif(btrim(ranked_exception_overrides.override_payload ->> 'exception_type'), ''),
              case
                when jsonb_typeof(ranked_exception_overrides.override_payload) = 'string'
                then nullif(btrim(ranked_exception_overrides.override_payload #>> '{{}}'), '')
              end
            ) as exception_type
          from ranked_exception_overrides
          where ranked_exception_overrides.match_rank = 1
        ) exception_override
          on exception_override.track_file_id = active_track_files.id
        where (
            %(track_id_count)s = 0
            or library.local_tracks.id = any(%(track_ids)s::bigint[])
          )
          and (
            {effective_non_album_predicate}
            or exception_override.exception_type is not null
          )
        order by
          coalesce(nullif(library.local_artists.sort_name, ''), library.local_artists.name, ''),
          library.local_tracks.title,
          active_track_files.private_path,
          active_track_files.id
        limit %(limit)s;
    """
