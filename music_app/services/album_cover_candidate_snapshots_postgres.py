from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.album_cover_candidate_publisher import (
    sanitize_persisted_candidate_snapshot,
)

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SEARCH_KINDS = frozenset({"automatic", "manual"})
_TERMINAL_STATUSES = frozenset({"completed", "failed"})
_SNAPSHOT_FIELDS = (
    "album_id",
    "search_generation",
    "search_kind",
    "status",
    "revision",
    "candidates",
    "best_candidate_id",
    "automatic_improvement_revision",
    "seen_automatic_improvement_revision",
    "automatic_improvement_candidate_id",
    "started_at",
    "updated_at",
    "finished_at",
)


class AlbumCoverCandidateSnapshotRepository:
    """Postgres authority for one cover-candidate snapshot per local album."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def get_for_album_context(self, *, album_id: int) -> dict[str, object] | None:
        with self._connect_to_database() as connection:
            cursor = connection.execute(_get_for_album_context_sql(), {"album_id": album_id})
            row = _first_row(cursor)
        return _snapshot_from_row(row)

    def resolve_album_id_for_track_paths(
        self,
        *,
        track_paths: set[str],
    ) -> int | None:
        normalized_paths = sorted(
            {str(path or "").strip() for path in track_paths if str(path or "").strip()}
        )
        if not normalized_paths:
            return None
        with self._connect_to_database() as connection:
            row = _first_row(
                connection.execute(
                    _resolve_album_id_for_track_paths_sql(),
                    {"track_paths": normalized_paths},
                )
            )
        album_id = _row_mapping(row).get("album_id")
        try:
            return int(album_id) if album_id is not None else None
        except (TypeError, ValueError):
            return None

    def publish_generation(
        self,
        *,
        album_id: int,
        search_generation: str,
        search_kind: str,
        search_started_at: str,
        candidates: list[dict[str, object]],
        best_candidate_id: str | None,
        automatic_improvement: bool,
    ) -> bool:
        normalized_kind = str(search_kind or "").strip().casefold()
        if normalized_kind not in _SEARCH_KINDS:
            raise ValueError("search_kind must be 'automatic' or 'manual'")
        normalized_candidates = [dict(item) for item in candidates if isinstance(item, Mapping)]
        if not normalized_candidates:
            return False
        params = {
            "album_id": album_id,
            "search_generation": str(search_generation),
            "search_kind": normalized_kind,
            "search_started_at": str(search_started_at),
            "candidates": _jsonb(normalized_candidates),
            "best_candidate_id": str(best_candidate_id).strip() if best_candidate_id else None,
            "automatic_improvement": bool(automatic_improvement),
        }
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(connection.execute(_publish_generation_sql(), params))
        return bool(_row_mapping(row).get("accepted"))

    def finish_generation(
        self,
        *,
        album_id: int,
        search_generation: str,
        status: str,
    ) -> bool:
        normalized_status = str(status or "").strip().casefold()
        if normalized_status not in _TERMINAL_STATUSES:
            raise ValueError("status must be 'completed' or 'failed'")
        params = {
            "album_id": album_id,
            "search_generation": str(search_generation),
            "status": normalized_status,
        }
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(connection.execute(_finish_generation_sql(), params))
        return bool(_row_mapping(row).get("accepted"))

    def mark_automatic_improvement(
        self,
        *,
        album_id: int,
        search_generation: str,
        candidate_id: str,
    ) -> bool:
        params = {
            "album_id": album_id,
            "search_generation": str(search_generation),
            "candidate_id": str(candidate_id or "").strip(),
        }
        if not params["candidate_id"]:
            return False
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(_mark_automatic_improvement_sql(), params)
                )
        return bool(_row_mapping(row).get("accepted"))

    def mark_seen(self, *, album_id: int) -> dict[str, object] | None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(
                    connection.execute(_mark_seen_sql(), {"album_id": album_id})
                )
        return _snapshot_from_row(row)

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for cover candidate snapshots."
            )
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for cover candidate snapshots.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    return transaction() if callable(transaction) else _NoopTransaction()


class _FallbackJsonb:
    def __init__(self, value: object) -> None:
        self.obj = value


def _jsonb(value: object) -> object:
    return Jsonb(value) if Jsonb is not None else _FallbackJsonb(value)


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    return None


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        return {
            field: row[index]
            for index, field in enumerate(_SNAPSHOT_FIELDS)
            if index < len(row)
        }
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _snapshot_from_row(row: object) -> dict[str, object] | None:
    if row is None:
        return None
    payload = _row_mapping(row)
    shaped_candidates, malformed = sanitize_persisted_candidate_snapshot(
        payload.get("candidates")
    )
    snapshot = {field: payload.get(field) for field in _SNAPSHOT_FIELDS}
    snapshot["candidates"] = shaped_candidates
    if malformed:
        snapshot["diagnostic"] = "malformed_candidate_snapshot"
    return snapshot


def _active_album_context_sql() -> str:
    return """
        with active_album as (
          select library.local_albums.id as album_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          join library.local_albums
            on library.local_albums.library_id = library.libraries.id
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            and library.local_albums.id = %(album_id)s
          limit 1
        )
    """


def _resolve_album_id_for_track_paths_sql() -> str:
    return """
        with active_library as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        requested_paths as (
          select distinct requested_path as private_path
          from unnest(%(track_paths)s::text[]) as requested_path
        ),
        resolved_tracks as (
          select
            requested_paths.private_path,
            library.local_tracks.album_id
          from requested_paths
          join library.local_track_files
            on library.local_track_files.private_path = requested_paths.private_path
           and library.local_track_files.scan_cache_stale is false
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          join active_library
            on active_library.library_id = library.local_tracks.library_id
          where library.local_tracks.album_id is not null
        )
        select case
          when count(distinct resolved_tracks.album_id) = 1
           and count(distinct resolved_tracks.private_path)
               = cardinality(%(track_paths)s::text[])
            then min(resolved_tracks.album_id)
          else null
        end as album_id
        from resolved_tracks;
    """


def _returning_snapshot_sql() -> str:
    return """
          library.local_album_cover_candidate_snapshots.album_id,
          library.local_album_cover_candidate_snapshots.search_generation,
          library.local_album_cover_candidate_snapshots.search_kind,
          library.local_album_cover_candidate_snapshots.status,
          library.local_album_cover_candidate_snapshots.revision,
          library.local_album_cover_candidate_snapshots.candidates,
          library.local_album_cover_candidate_snapshots.best_candidate_id,
          library.local_album_cover_candidate_snapshots.automatic_improvement_revision,
          library.local_album_cover_candidate_snapshots.seen_automatic_improvement_revision,
          library.local_album_cover_candidate_snapshots.automatic_improvement_candidate_id,
          library.local_album_cover_candidate_snapshots.started_at,
          library.local_album_cover_candidate_snapshots.updated_at,
          library.local_album_cover_candidate_snapshots.finished_at
    """


def _get_for_album_context_sql() -> str:
    return (
        _active_album_context_sql()
        + """
        select
    """
        + _returning_snapshot_sql()
        + """
        from library.local_album_cover_candidate_snapshots
        join active_album
          on active_album.album_id = library.local_album_cover_candidate_snapshots.album_id;
    """
    )


def _publish_generation_sql() -> str:
    return (
        _active_album_context_sql()
        + """
        insert into library.local_album_cover_candidate_snapshots (
          album_id,
          search_generation,
          search_kind,
          status,
          revision,
          candidates,
          best_candidate_id,
          automatic_improvement_revision,
          seen_automatic_improvement_revision,
          started_at,
          updated_at,
          finished_at
        )
        select
          active_album.album_id,
          %(search_generation)s::uuid,
          %(search_kind)s,
          'running',
          1,
          %(candidates)s::jsonb,
          %(best_candidate_id)s,
          case when %(automatic_improvement)s then 1 else 0 end,
          0,
          %(search_started_at)s::timestamptz,
          now(),
          null
        from active_album
        on conflict (album_id) do update
        set search_generation = excluded.search_generation,
            search_kind = excluded.search_kind,
            status = 'running',
            revision = case
              when library.local_album_cover_candidate_snapshots.candidates
                     is distinct from excluded.candidates
                or library.local_album_cover_candidate_snapshots.best_candidate_id
                     is distinct from excluded.best_candidate_id
                then library.local_album_cover_candidate_snapshots.revision + 1
              else library.local_album_cover_candidate_snapshots.revision
            end,
            candidates = excluded.candidates,
            best_candidate_id = excluded.best_candidate_id,
            automatic_improvement_revision =
              library.local_album_cover_candidate_snapshots.automatic_improvement_revision
              + case
                  when %(automatic_improvement)s
                   and (
                     library.local_album_cover_candidate_snapshots.candidates
                       is distinct from excluded.candidates
                     or library.local_album_cover_candidate_snapshots.best_candidate_id
                       is distinct from excluded.best_candidate_id
                   )
                    then 1
                  else 0
                end,
            started_at = case
              when library.local_album_cover_candidate_snapshots.search_generation
                   = excluded.search_generation
                then library.local_album_cover_candidate_snapshots.started_at
              else excluded.started_at
            end,
            updated_at = now(),
            finished_at = null
        where (
          library.local_album_cover_candidate_snapshots.search_generation
            = excluded.search_generation
          and library.local_album_cover_candidate_snapshots.status = 'running'
        )
        or (
          excluded.started_at > library.local_album_cover_candidate_snapshots.started_at
          and (
            library.local_album_cover_candidate_snapshots.status in ('completed', 'failed')
            or (
              library.local_album_cover_candidate_snapshots.status = 'running'
              and excluded.search_kind = 'manual'
              and library.local_album_cover_candidate_snapshots.search_kind = 'automatic'
            )
          )
        )
        returning true as accepted;
    """
    )


def _finish_generation_sql() -> str:
    return (
        _active_album_context_sql()
        + """
        update library.local_album_cover_candidate_snapshots
        set status = %(status)s,
            updated_at = now(),
            finished_at = now()
        from active_album
        where library.local_album_cover_candidate_snapshots.album_id = active_album.album_id
          and library.local_album_cover_candidate_snapshots.search_generation = %(search_generation)s::uuid
        returning true as accepted;
    """
    )


def _mark_automatic_improvement_sql() -> str:
    return (
        _active_album_context_sql()
        + """
        update library.local_album_cover_candidate_snapshots
        set automatic_improvement_revision = automatic_improvement_revision + 1,
            automatic_improvement_candidate_id = %(candidate_id)s,
            updated_at = now()
        from active_album
        where library.local_album_cover_candidate_snapshots.album_id = active_album.album_id
          and library.local_album_cover_candidate_snapshots.search_generation = %(search_generation)s::uuid
          and library.local_album_cover_candidate_snapshots.search_kind = 'automatic'
          and library.local_album_cover_candidate_snapshots.automatic_improvement_candidate_id
                is distinct from %(candidate_id)s
          and exists (
            select 1
            from jsonb_array_elements(
              library.local_album_cover_candidate_snapshots.candidates
            ) as candidate
            where candidate ->> 'id' = %(candidate_id)s
          )
        returning true as accepted;
    """
    )


def _mark_seen_sql() -> str:
    return (
        _active_album_context_sql()
        + """
        update library.local_album_cover_candidate_snapshots
        set seen_automatic_improvement_revision =
              library.local_album_cover_candidate_snapshots.automatic_improvement_revision,
            updated_at = now()
        from active_album
        where library.local_album_cover_candidate_snapshots.album_id = active_album.album_id
        returning
    """
        + _returning_snapshot_sql()
        + ";"
    )
