from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.postgres_connections import pooled_connection as _pooled_connection

try:  # pragma: no cover - optional outside the Postgres runtime.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_UNKNOWN_IDENTITY_VALUES = {
    "",
    "unknown",
    "unknown artist",
    "unknown album",
    "none",
    "null",
}
_FIELDS = (
    "album_id",
    "album_key",
    "title",
    "album_artist",
    "release_year",
    "depth",
    "cycle_detected",
    "matched_path_count",
    "requested_path_count",
    "track_count",
)


class AlbumIdentityLineageRepository:
    """Resolve historical local-album identities within the active library."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(
            config.get(_APP_DATABASE_URL_KEY) or config.get("APP_DATABASE_URL") or ""
        ).strip()
        self._use_shared_connection_pool = connect is None
        self._connect = connect or _connect

    def resolve(
        self,
        *,
        album_id: int | None = None,
        album_key: str | None = None,
        track_paths: set[str] | None = None,
    ) -> dict[str, object]:
        normalized_key = str(album_key or "").strip() or None
        normalized_paths = sorted(
            {str(path or "").strip() for path in track_paths or set() if str(path or "").strip()}
        )
        if album_id is None and normalized_key is None:
            return _result("unresolved")

        with self._connect_to_database() as connection:
            rows = connection.execute(
                _resolution_sql(),
                {
                    "album_id": album_id,
                    "album_key": normalized_key,
                    "track_paths": normalized_paths,
                },
            ).fetchall()

        candidates = [_row_mapping(row) for row in rows]
        if any(bool(candidate.get("cycle_detected")) for candidate in candidates):
            return _result("invalid")

        live = [
            candidate
            for candidate in candidates
            if candidate.get("album_id") is not None
            and not _is_synthetic_unknown_album(candidate)
        ]
        if not live:
            return _result("unresolved")

        complete_path_matches = [
            candidate
            for candidate in live
            if int(candidate.get("requested_path_count") or 0) > 0
            and int(candidate.get("matched_path_count") or 0)
            == int(candidate.get("requested_path_count") or 0)
        ]
        if len(complete_path_matches) == 1:
            live = complete_path_matches

        albums = sorted((_album(candidate) for candidate in live), key=lambda item: item["album_id"])
        if len(albums) > 1:
            return {"status": "split", "album": None, "choices": albums}

        status = "current" if int(live[0].get("depth") or 0) == 0 else "resolved"
        return {"status": status, "album": albums[0], "choices": []}

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for album identity lineage."
            )
        if self._use_shared_connection_pool:
            return _pooled_connection(self._database_url, workload="default")
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for album identity lineage.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _result(status: str) -> dict[str, object]:
    return {"status": status, "album": None, "choices": []}


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        return {field: row[index] for index, field in enumerate(_FIELDS) if index < len(row)}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _album(candidate: Mapping[str, object]) -> dict[str, object]:
    album = {
        "album_id": int(candidate["album_id"]),
        "album_key": str(candidate.get("album_key") or ""),
        "name": str(candidate.get("title") or ""),
        "album_artist": str(candidate.get("album_artist") or ""),
        "year": candidate.get("release_year"),
    }
    if candidate.get("track_count") is not None:
        album["track_count"] = int(candidate["track_count"])
    return album


def _is_synthetic_unknown_album(candidate: Mapping[str, object]) -> bool:
    return (
        str(candidate.get("title") or "").strip().casefold() in _UNKNOWN_IDENTITY_VALUES
        and str(candidate.get("album_artist") or "").strip().casefold()
        in _UNKNOWN_IDENTITY_VALUES
    )


def _resolution_sql() -> str:
    return """
        /* album_identity_lineage_resolution_v1 */
        with recursive active_library as (
          select libraries.id as library_id
          from app.bootstrap_owners as owners
          join library.libraries
            on libraries.owner_account_id = owners.account_id
           and libraries.name = 'Local Library'
           and libraries.library_kind = 'local'
          where owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        lineage as (
          select
            transitions.library_id,
            transitions.successor_album_id as album_id,
            transitions.successor_album_key as album_key,
            1 as depth,
            array[
              transitions.predecessor_album_id::text || ':' || transitions.predecessor_album_key,
              transitions.successor_album_id::text || ':' || transitions.successor_album_key
            ] as visited,
            false as cycle_detected
          from library.local_album_identity_transitions as transitions
          join active_library using (library_id)
          where (%(album_id)s::bigint is not null
                 and transitions.predecessor_album_id = %(album_id)s::bigint)
             or (%(album_key)s::text is not null
                 and transitions.predecessor_album_key = %(album_key)s::text)

          union all

          select
            transitions.library_id,
            transitions.successor_album_id,
            transitions.successor_album_key,
            lineage.depth + 1,
            array_append(
              lineage.visited,
              transitions.successor_album_id::text || ':' || transitions.successor_album_key
            ),
            (transitions.successor_album_id::text || ':' || transitions.successor_album_key)
              = any(lineage.visited)
          from lineage
          join library.local_album_identity_transitions as transitions
            on transitions.library_id = lineage.library_id
           and transitions.predecessor_album_id = lineage.album_id
           and transitions.predecessor_album_key = lineage.album_key
          where lineage.depth < 16
            and lineage.cycle_detected is false
        ),
        current_identity as (
          select albums.library_id, albums.id as album_id, albums.album_key, 0 as depth,
                 false as cycle_detected
          from active_library
          join library.local_albums as albums using (library_id)
          where (%(album_id)s::bigint is not null and albums.id = %(album_id)s::bigint)
             or (%(album_key)s::text is not null and albums.album_key = %(album_key)s::text)
        ),
        live_candidates as (
          select distinct on (albums.id)
            albums.library_id,
            albums.id as album_id,
            albums.album_key,
            albums.title,
            coalesce(artists.name, '') as album_artist,
            albums.release_year,
            identities.depth,
            identities.cycle_detected,
            active_tracks.track_count
          from (
            select * from current_identity
            union all
            select library_id, album_id, album_key, depth, cycle_detected from lineage
          ) as identities
          join library.local_albums as albums
            on albums.library_id = identities.library_id
           and albums.id = identities.album_id
           and albums.album_key = identities.album_key
          left join library.local_artists as artists on artists.id = albums.artist_id
          cross join lateral (
            select count(distinct tracks.id)::integer as track_count
            from library.local_tracks as tracks
            join library.local_track_files as files
              on files.track_id = tracks.id
             and files.scan_cache_stale is false
            where tracks.library_id = albums.library_id
              and tracks.album_id = albums.id
          ) as active_tracks
          where active_tracks.track_count > 0
          order by albums.id, identities.depth desc
        ),
        requested_paths as (
          select distinct requested_path as private_path
          from unnest(%(track_paths)s::text[]) as requested_path
        ),
        path_matches as (
          select tracks.album_id, count(distinct requested_paths.private_path) as matched_path_count
          from requested_paths
          join library.local_track_files as files
            on files.private_path = requested_paths.private_path
           and files.scan_cache_stale is false
          join library.local_tracks as tracks on tracks.id = files.track_id
          join active_library on active_library.library_id = tracks.library_id
          group by tracks.album_id
        ),
        invalid_lineage as (
          select coalesce(bool_or(lineage.cycle_detected), false)
                 or exists (
                   select 1
                   from lineage as boundary
                   join library.local_album_identity_transitions as next_transition
                     on next_transition.library_id = boundary.library_id
                    and next_transition.predecessor_album_id = boundary.album_id
                    and next_transition.predecessor_album_key = boundary.album_key
                   where boundary.depth = 16
                     and boundary.cycle_detected is false
                 ) as invalid
          from lineage
        )
        select
          live_candidates.album_id,
          live_candidates.album_key,
          live_candidates.title,
          live_candidates.album_artist,
          live_candidates.release_year,
          live_candidates.depth,
          invalid_lineage.invalid as cycle_detected,
          coalesce(path_matches.matched_path_count, 0) as matched_path_count,
          cardinality(%(track_paths)s::text[]) as requested_path_count,
          live_candidates.track_count
        from live_candidates
        cross join invalid_lineage
        left join path_matches on path_matches.album_id = live_candidates.album_id

        union all

        select null, null, null, null, null, 16, true, 0,
               cardinality(%(track_paths)s::text[]), null
        from invalid_lineage
        where invalid_lineage.invalid is true;
    """
