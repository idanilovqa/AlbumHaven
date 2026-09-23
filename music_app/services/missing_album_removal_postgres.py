"""Transactional confirmation of missing-album inventory removal."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

try:  # pragma: no cover - runtime-only optional dependency path.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


class MissingAlbumReappeared(RuntimeError):
    """Raised when an album has an active file at confirmation time."""


class MissingAlbumNotFound(RuntimeError):
    """Raised when the requested album is outside the current library."""


class MissingAlbumRootUnavailable(RuntimeError):
    """Raised when absence cannot be confirmed because an owning root is offline."""


class PostgresMissingAlbumRemovalService:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
        root_health_check: Callable[[str], bool] | None = None,
    ) -> None:
        self._database_url = str(
            config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        self._connect = connect or _connect
        self._root_health_check = root_health_check

    def confirm_removal(self, album_key: object) -> dict[str, object]:
        normalized_key = str(album_key or "").strip()
        if not normalized_key:
            raise ValueError("Invalid album key")
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required")
        with self._connect(self._database_url) as connection:
            with connection.transaction():
                root_ids: list[str] = []
                if self._root_health_check is not None:
                    # Resolve ownership in a fresh statement after publication is
                    # locked; the removal function takes the same transaction lock.
                    connection.execute(
                        "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));"
                    )
                    root_ids = [
                        str(_row_mapping(root).get("root_id") or "").strip()
                        for root in connection.execute(
                            _missing_album_root_ids_sql(), {"album_key": normalized_key},
                        ).fetchall()
                    ]
                row = connection.execute(
                    _confirm_missing_album_removal_sql(),
                    {"album_key": normalized_key},
                ).fetchone()
                result = _row_mapping(row)
                if not result.get("album_found"):
                    raise MissingAlbumNotFound()
                if int(result.get("active_file_count") or 0):
                    raise MissingAlbumReappeared()
                root_paths = [
                    Path(str(path))
                    for path in (result.get("root_private_paths") or [])
                    if str(path).strip()
                ]
                if (
                    int(result.get("unresolved_root_count") or 0)
                    or int(result.get("unhealthy_root_count") or 0)
                    or any(not path.is_dir() for path in root_paths)
                ):
                    raise MissingAlbumRootUnavailable()
                if any(
                    Path(str(path)).exists()
                    for path in (result.get("stale_private_paths") or [])
                    if str(path).strip()
                ):
                    raise MissingAlbumReappeared()
                if int(result.get("removed_album_count") or 0) != 1:
                    raise RuntimeError("Missing album removal did not remove one album")
                if self._root_health_check is not None:
                    try:
                        healthy = bool(root_ids) and all(
                            root_id and self._root_health_check(root_id)
                            for root_id in root_ids
                        )
                    except Exception:
                        healthy = False
                    if not healthy:
                        # This also rolls back changes made by the SQL function.
                        raise MissingAlbumRootUnavailable()
                return {
                    "removed_album_key": str(result.get("removed_album_key") or ""),
                    "library_revision": int(
                        result.get("inventory_mutation_revision") or 0
                    ),
                }


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return dict(row)
    if row is None:
        return {}
    try:
        return dict(row)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {}


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for missing album removal")
    return psycopg.connect(database_url, row_factory=dict_row)


def _confirm_missing_album_removal_sql() -> str:
    return "select * from library.confirm_missing_album_removal(%(album_key)s);"


def _missing_album_root_ids_sql() -> str:
    return """
select distinct coalesce(
  nullif(library.library_roots.metadata ->> 'root_id', ''),
  library.local_track_files.metadata ->> 'library_root_id'
) as root_id
from app.bootstrap_owners
join library.libraries
  on library.libraries.owner_account_id = app.bootstrap_owners.account_id
 and library.libraries.name = 'Local Library'
 and library.libraries.library_kind = 'local'
join library.local_albums
  on library.local_albums.library_id = library.libraries.id
join library.local_tracks
  on library.local_tracks.album_id = library.local_albums.id
join library.local_track_files
  on library.local_track_files.track_id = library.local_tracks.id
left join library.library_roots
  on library.library_roots.id = library.local_track_files.library_root_id
where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  and library.local_albums.album_key = %(album_key)s;
"""
