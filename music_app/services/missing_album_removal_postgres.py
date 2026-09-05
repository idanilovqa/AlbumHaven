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
    ) -> None:
        self._database_url = str(
            config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        self._connect = connect or _connect

    def confirm_removal(self, album_key: object) -> dict[str, object]:
        normalized_key = str(album_key or "").strip()
        if not normalized_key:
            raise ValueError("Invalid album key")
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required")
        with self._connect(self._database_url) as connection:
            with connection.transaction():
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
                if int(result.get("unresolved_root_count") or 0) or any(
                    not path.is_dir() for path in root_paths
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
