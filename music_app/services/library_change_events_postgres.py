"""Reads the live library change log written by migration 0189's triggers."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from music_app.services.postgres_connections import pooled_connection

REPLAY_LIMIT = 500
RETENTION_HOURS = 24


@dataclass(frozen=True, slots=True)
class LibraryChangeEvent:
    revision: int
    kinds: tuple[str, ...]
    refs: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class LibraryChangePage:
    events: tuple[LibraryChangeEvent, ...]
    head: int
    resync: bool


class LibraryChangeEventRepository:
    def __init__(
        self,
        config: Mapping[str, Any],
        *,
        connect: Callable[..., Any] = pooled_connection,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Postgres configuration is required.")
        self._connect = connect

    def head(self) -> int:
        with self._connect(self._database_url, workload="live-events") as connection:
            row = connection.execute(
                "select coalesce(max(revision), 0) as head from library.change_events"
            ).fetchone()
        return int(row["head"])

    def read_since(
        self,
        *,
        library_id: int | None,
        account_id: int | None,
        since: int,
        limit: int = REPLAY_LIMIT,
    ) -> LibraryChangePage:
        """Events after ``since`` for one reader, or a resync when they cannot all be replayed."""
        with self._connect(self._database_url, workload="live-events") as connection:
            bounds = connection.execute(
                """
                select coalesce((select max(revision) from library.change_events), 0) as head,
                       (select pruned_through from library.change_event_watermark) as pruned_through
                """
            ).fetchone()
            head = int(bounds["head"])
            if since < 0 or since > head or since < int(bounds["pruned_through"] or 0):
                return LibraryChangePage(events=(), head=head, resync=True)
            rows = connection.execute(
                """
                select revision, kinds, refs
                from library.change_events
                where revision > %(since)s
                  and revision <= %(head)s
                  and (library_id = %(library_id)s or library_id is null)
                  and (account_id is null or account_id = %(account_id)s)
                order by revision
                limit %(limit)s
                """,
                {"since": since, "head": head, "library_id": library_id,
                 "account_id": account_id, "limit": limit + 1},
            ).fetchall()
        if len(rows) > limit:
            return LibraryChangePage(events=(), head=head, resync=True)
        return LibraryChangePage(
            events=tuple(
                LibraryChangeEvent(int(row["revision"]), tuple(row["kinds"]), dict(row["refs"] or {}))
                for row in rows
            ),
            head=head,
            resync=False,
        )

    def prune(self, *, retention_hours: int = RETENTION_HOURS) -> int:
        with self._connect(self._database_url, workload="live-events") as connection:
            row = connection.execute(
                """
                with removed as (
                    delete from library.change_events
                    where created_at < now() - make_interval(hours => %s)
                    returning revision
                ), marked as (
                    update library.change_event_watermark
                    set pruned_through = greatest(pruned_through, (select max(revision) from removed))
                    where exists (select 1 from removed)
                )
                select count(*) as removed from removed
                """,
                (retention_hours,),
            ).fetchone()
        return int(row["removed"])
