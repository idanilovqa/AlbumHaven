"""Postgres authority for user-chosen additional album artboxes (slot 1 only)."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from music_app.services.postgres_connections import pooled_connection as _pooled_connection

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
ADDITIONAL_ARTWORK_SLOTS = frozenset({1})
_SOURCE_KINDS = frozenset({"local", "remote"})


class AlbumAdditionalArtworkRepository:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._use_shared_connection_pool = connect is None
        self._connect = connect or _connect

    def list_for_album(self, *, album_id: int) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            rows = connection.execute(_LIST_SQL, {"album_id": album_id}).fetchall()
        return [artwork_payload(row) for row in rows]

    def save(
        self,
        *,
        album_id: int,
        slot: int,
        source_kind: str,
        cover_path: str | None,
        remote_url: str | None,
        account_id: int | None,
    ) -> list[dict[str, object]]:
        if slot not in ADDITIONAL_ARTWORK_SLOTS:
            raise ValueError("Only one additional artbox is allowed")
        if source_kind not in _SOURCE_KINDS:
            raise ValueError("Unsupported artwork source")
        with self._connect_to_database() as connection:
            with connection.transaction():
                connection.execute(_UPSERT_SQL, {
                    "album_id": album_id,
                    "slot": slot,
                    "source_kind": source_kind,
                    "cover_path": cover_path if source_kind == "local" else None,
                    "remote_url": remote_url if source_kind == "remote" else None,
                    "account_id": account_id,
                })
                rows = connection.execute(_LIST_SQL, {"album_id": album_id}).fetchall()
        return [artwork_payload(row) for row in rows]

    def remove(self, *, album_id: int, slot: int) -> list[dict[str, object]]:
        with self._connect_to_database() as connection:
            with connection.transaction():
                connection.execute(_DELETE_SQL, {"album_id": album_id, "slot": slot})
                rows = connection.execute(_LIST_SQL, {"album_id": album_id}).fetchall()
        return [artwork_payload(row) for row in rows]

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for additional artworks.")
        if self._use_shared_connection_pool:
            return _pooled_connection(self._database_url, workload="default")
        return self._connect(self._database_url)


def artwork_payload(row: Mapping[str, object]) -> dict[str, object]:
    """Client contract: one entry per extra artbox, shaped like an album cover source."""
    source_kind = str(row.get("source_kind") or "")
    payload: dict[str, object] = {"slot": int(row.get("slot") or 0), "source_kind": source_kind}
    if source_kind == "local":
        payload["cover_path"] = str(row.get("cover_path") or "")
    else:
        payload["remote_cover_url"] = str(row.get("remote_url") or "")
    return payload


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for additional artworks.")
    return psycopg.connect(database_url, row_factory=dict_row)


_LIST_SQL = """
select slot, source_kind, cover_path, remote_url
from library.local_album_additional_artworks
where album_id = %(album_id)s
order by slot
"""

_UPSERT_SQL = """
insert into library.local_album_additional_artworks
  (album_id, slot, source_kind, cover_path, remote_url, selected_by_account_id, selected_at)
values
  (%(album_id)s, %(slot)s, %(source_kind)s, %(cover_path)s, %(remote_url)s, %(account_id)s, now())
on conflict (album_id, slot) do update set
  source_kind = excluded.source_kind,
  cover_path = excluded.cover_path,
  remote_url = excluded.remote_url,
  selected_by_account_id = excluded.selected_by_account_id,
  selected_at = excluded.selected_at
"""

_DELETE_SQL = """
delete from library.local_album_additional_artworks
where album_id = %(album_id)s and slot = %(slot)s
"""
