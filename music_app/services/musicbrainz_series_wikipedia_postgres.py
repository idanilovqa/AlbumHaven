"""PostgreSQL authority for a series' Wikipedia introduction (MusicBrainz Delivery 2, S6).

Only series the library has are looked up: once, then again 90 days after the last answer.
A failed lookup rests a day, then twice as long after each further failure, at most a month.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _connect,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_series_wikipedia import failure_rest


class SeriesWikipediaPostgresRepository:
    def __init__(self, config, *, connect: Callable[[str], Any] | None = None) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz enrichment.")
        self._connect = connect or _connect

    def due_series(self, *, limit: int, now: datetime, refresh_after: timedelta) -> list[str]:
        """Series of the library's decided albums never looked up, or last answered longer
        ago than ``refresh_after``, and not resting after a failure; never looked up first."""
        sql = _active_library_cte() + """
            select series.mbid::text as mbid
            from integration.musicbrainz_series series
            where (series.wikipedia_checked_at is null or series.wikipedia_checked_at < %(now)s - %(refresh_after)s)
              and (series.wikipedia_next_attempt_at is null or series.wikipedia_next_attempt_at <= %(now)s)
              and exists (select 1 from library.local_album_musicbrainz_series albums
                          join active_library on active_library.library_id = albums.library_id
                          where albums.series_mbid = series.mbid)
            order by series.wikipedia_checked_at nulls first, series.created_at, series.mbid
            limit %(limit)s
        """
        with self._connect(self._database_url) as connection:
            return [str(_row_mapping(row)["mbid"]) for row in connection.execute(
                sql, {"limit": max(1, int(limit)), "now": _aware_utc(now), "refresh_after": refresh_after}).fetchall()]

    def store(self, *, mbid: str, found: dict[str, str] | bool | None, observed_at: datetime) -> None:
        """The article and its introduction (a dict), no article (False: any stored one is
        removed), or a failed lookup (None: the stored article stays and the series rests)."""
        observed = _aware_utc(observed_at)
        params = {"mbid": mbid, "observed_at": observed}
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                if found is None:
                    row = connection.execute(
                        "select wikipedia_failure_count from integration.musicbrainz_series"
                        " where mbid = %(mbid)s::uuid for update", params).fetchone()
                    if row is None:
                        return
                    failures = int(_row_mapping(row)["wikipedia_failure_count"] or 0) + 1
                    connection.execute(
                        "update integration.musicbrainz_series set wikipedia_failure_count = %(failures)s,"
                        " wikipedia_next_attempt_at = %(next_attempt_at)s where mbid = %(mbid)s::uuid",
                        {**params, "failures": failures, "next_attempt_at": observed + failure_rest(failures)})
                    return
                if found:
                    connection.execute(_UPSERT_ARTICLE, {**params, **{key: found[key] for key in (
                        "language", "title", "url", "extract")}})
                else:
                    connection.execute("delete from integration.musicbrainz_series_wikipedia"
                                       " where series_mbid = %(mbid)s::uuid", params)
                connection.execute(
                    "update integration.musicbrainz_series set wikipedia_checked_at = %(observed_at)s,"
                    " wikipedia_failure_count = 0, wikipedia_next_attempt_at = null where mbid = %(mbid)s::uuid",
                    params)


_UPSERT_ARTICLE = """
    insert into integration.musicbrainz_series_wikipedia (series_mbid, language, title, url, extract, fetched_at,
                                                          created_at, updated_at)
    select series.mbid, %(language)s, %(title)s, %(url)s, %(extract)s, %(observed_at)s, %(observed_at)s,
           %(observed_at)s
    from integration.musicbrainz_series series where series.mbid = %(mbid)s::uuid
    on conflict (series_mbid) do update
    set language = excluded.language, title = excluded.title, url = excluded.url, extract = excluded.extract,
        fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
"""
