"""PostgreSQL authority for local album release identity (MusicBrainz Delivery 2, S1).

One background job per local artist (job kind ``musicbrainz_album_releases``) compares the
artist's albums with the releases of the MusicBrainz artist each album belongs to: its own
per-album identity first, else the artist's accepted match; an artist the matcher left
without one (S2: collaborations, credited performers, "Various Artists") has its albums found
by their release credits. The job runs after the artist's own job, in the same enrichment
queue, and never touches media.
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _bounded_text,
    _connect,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity import DIAGNOSTICS, RELEASE_MATCHER_VERSION
from music_app.services.tracklist_sections import section_retry_at

JOB_KIND = "musicbrainz_album_releases"
_DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
_STALE_AFTER = "30 days"

# An artist the matcher left without an identity (a collaboration, a performer credited with
# a composer, a display name such as "Various Artists"): its albums are found by their
# release credits instead. Split artists' undecided albums and owner decisions are left alone.
_CREDITED_ONLY_SQL = "(matches.decision_source = 'automatic' and matches.state in ('manual_review', 'ambiguous', 'not_found'))"
# An artist whose albums are compared: an accepted match, per-album identities or credits.
_ARTIST_WITH_IDENTITY_SQL = """
    exists (
      select 1 from library.local_albums albums
      left join library.local_album_artist_identities identities
        on identities.library_id = albums.library_id and identities.album_key = albums.album_key
      where albums.library_id = artists.library_id and albums.artist_id = artists.id
        and (identities.artist_mbid is not null or (matches.state = 'matched' and matches.artist_mbid is not null)
             or """ + _CREDITED_ONLY_SQL + """)
        and exists (select 1 from library.local_tracks tracks
                    where tracks.library_id = albums.library_id and tracks.album_id = albums.id)
    )
"""


class EnrichmentJobQueue:
    """Claim and finish one kind of per-artist enrichment job in the shared queue."""

    job_kind = ""

    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz enrichment.")
        self._connect = connect or _connect

    def claim_due_job(self, *, worker_id: str, now: datetime, lease_duration: timedelta,
                      min_priority: int | None = None) -> dict[str, object] | None:
        """The next due job, highest priority first; ``min_priority`` claims only jobs at or
        above it (the owner's manual lookups)."""
        claimed_at = _aware_utc(now)
        params = {"worker_id": _bounded_text(worker_id, 128, required=True), "now": claimed_at,
                  "lease_expires_at": claimed_at + lease_duration, "job_kind": self.job_kind,
                  "min_priority": min_priority}
        sql = _active_library_cte() + """
            , due_job as (
              select jobs.id from ops.metadata_enrichment_jobs jobs
              join active_library on active_library.library_id = jobs.library_id
              where jobs.job_kind = %(job_kind)s
                and (%(min_priority)s::integer is null or jobs.priority >= %(min_priority)s::integer)
                and ((jobs.state in ('queued', 'retry_wait') and jobs.next_attempt_at <= %(now)s)
                     or (jobs.state = 'leased' and jobs.lease_expires_at <= %(now)s))
              order by jobs.priority desc, jobs.next_attempt_at, jobs.id
              for update skip locked
              limit 1
            )
            update ops.metadata_enrichment_jobs jobs
            set state = 'leased', lease_owner = %(worker_id)s, lease_expires_at = %(lease_expires_at)s,
                attempt_count = jobs.attempt_count + 1, updated_at = %(now)s
            from due_job where jobs.id = due_job.id
            returning jobs.*;
        """
        return self._one(sql, params) or None

    def finish(self, *, job_id: int, worker_id: str, state: str, classification: str, observed_at: datetime,
               retry_at: datetime | None = None, safe_error: str | None = None) -> bool:
        if state not in {"succeeded", "retry_wait", "exhausted"}:
            raise ValueError("Enrichment job state is invalid.")
        params = {"job_id": _positive_id(job_id), "worker_id": _bounded_text(worker_id, 128, required=True),
                  "job_kind": self.job_kind, "state": state,
                  "classification": _bounded_text(classification, 64, required=True),
                  "observed_at": _aware_utc(observed_at), "retry_at": _aware_utc(retry_at) if retry_at else None,
                  "safe_error": _bounded_text(safe_error, 1024) or None}
        sql = """
            update ops.metadata_enrichment_jobs
            set state = %(state)s, lease_owner = null, lease_expires_at = null,
                next_attempt_at = coalesce(%(retry_at)s, next_attempt_at),
                provider_classification = %(classification)s, provider_observed_at = %(observed_at)s,
                last_error = %(safe_error)s, updated_at = %(observed_at)s,
                completed_at = case when %(state)s = 'retry_wait' then null else %(observed_at)s end
            where id = %(job_id)s and job_kind = %(job_kind)s and state = 'leased' and lease_owner = %(worker_id)s
            returning true as updated;
        """
        return bool(self._one(sql, params).get("updated"))

    def _one(self, sql: str, params: dict[str, object]) -> dict[str, object]:
        with self._connect(self._database_url) as connection:
            return _row_mapping(connection.execute(sql, params).fetchone())


class MusicBrainzReleaseIdentityPostgresRepository(EnrichmentJobQueue):
    job_kind = JOB_KIND

    def enqueue(self, *, reason: str, observed_at: datetime, local_artist_id: int | None = None,
                force: bool = False) -> int:
        """Queue album comparison for artists with an identity whose albums have no current
        decision (new albums, an older matcher, older than 30 days, or ``force`` after the
        artist's own match changed). One active job per artist."""
        params = {
            "reason": _bounded_text(reason, 128, required=True), "observed_at": _aware_utc(observed_at),
            "job_kind": JOB_KIND, "matcher_version": RELEASE_MATCHER_VERSION,
            "local_artist_id": _positive_id(local_artist_id) if local_artist_id is not None else None,
            "force": bool(force),
        }
        sql = _active_library_cte() + """
            , eligible as (
              select artists.library_id, artists.id as local_artist_id
              from active_library
              join library.local_artists artists on artists.library_id = active_library.library_id
              left join library.local_artist_musicbrainz_matches matches
                on matches.library_id = artists.library_id and matches.local_artist_id = artists.id
              where (%(local_artist_id)s::bigint is null or artists.id = %(local_artist_id)s::bigint)
                and """ + _ARTIST_WITH_IDENTITY_SQL + """
                and (%(force)s or exists (
                  select 1 from library.local_albums albums
                  left join library.local_album_musicbrainz_releases releases
                    on releases.library_id = albums.library_id and releases.album_key = albums.album_key
                  where albums.library_id = artists.library_id and albums.artist_id = artists.id
                    and exists (select 1 from library.local_tracks tracks
                                where tracks.library_id = albums.library_id and tracks.album_id = albums.id)
                    and (releases.album_key is null
                         or (releases.decision_source = 'automatic'
                             and (releases.matcher_version < %(matcher_version)s
                                  or releases.diagnostic = 'budget_exhausted'
                                  or releases.observed_at < %(observed_at)s - interval '""" + _STALE_AFTER + """')))))
            ), inserted as (
              insert into ops.metadata_enrichment_jobs (
                library_id, local_artist_id, target_kind, job_kind, reason, state, next_attempt_at,
                created_at, updated_at)
              select library_id, local_artist_id, 'artist', %(job_kind)s, %(reason)s, 'queued',
                     %(observed_at)s, %(observed_at)s, %(observed_at)s
              from eligible
              on conflict (library_id, local_artist_id, job_kind) where state in ('queued', 'leased', 'retry_wait')
              do nothing
              returning 1
            )
            select count(*)::integer as enqueued from inserted;
        """
        return int(self._one(sql, params).get("enqueued") or 0)

    def load_context(self, *, job_id: int, worker_id: str) -> list[dict[str, object]]:
        """The leased artist's albums with tracks, grouped by the MusicBrainz artist each
        belongs to (none for albums found by their credits): one resolver context per group."""
        params = {"job_id": _positive_id(job_id), "worker_id": _bounded_text(worker_id, 128, required=True),
                  "job_kind": JOB_KIND}
        sql = _active_library_cte() + """
            select artists.id as local_artist_id, artists.name as local_name,
                   coalesce(identities.artist_mbid,
                            case when matches.state = 'matched' then matches.artist_mbid end)::text as artist_mbid,
                   remote.canonical_name,
                   json_agg(json_build_object(
                     'id', albums.id, 'title', albums.title, 'year', albums.release_year, 'tracks', album_tracks.tracks)
                     order by albums.title, albums.id) as albums
            from active_library
            join ops.metadata_enrichment_jobs jobs
              on jobs.library_id = active_library.library_id and jobs.id = %(job_id)s
             and jobs.job_kind = %(job_kind)s and jobs.state = 'leased' and jobs.lease_owner = %(worker_id)s
            join library.local_artists artists on artists.library_id = jobs.library_id and artists.id = jobs.local_artist_id
            join library.local_albums albums on albums.library_id = artists.library_id and albums.artist_id = artists.id
            left join library.local_album_artist_identities identities
              on identities.library_id = albums.library_id and identities.album_key = albums.album_key
            left join library.local_artist_musicbrainz_matches matches
              on matches.library_id = artists.library_id and matches.local_artist_id = artists.id
            join lateral (
              select json_agg(json_build_object(
                       'title', tracks.title, 'duration_seconds', tracks.duration_seconds,
                       'disc_number', coalesce(nullif(tracks.disc_number, 0), 1), 'track_number', tracks.track_number,
                       'artist', track_artists.name)
                       order by coalesce(nullif(tracks.disc_number, 0), 1), tracks.track_number, tracks.title) as tracks
              from library.local_tracks tracks
              left join library.local_artists track_artists
                on track_artists.library_id = tracks.library_id and track_artists.id = tracks.artist_id
              where tracks.library_id = albums.library_id and tracks.album_id = albums.id
              having count(*) > 0
            ) album_tracks on true
            left join integration.musicbrainz_artists remote
              on remote.mbid = coalesce(identities.artist_mbid,
                                        case when matches.state = 'matched' then matches.artist_mbid end)
            where coalesce(identities.artist_mbid, case when matches.state = 'matched' then matches.artist_mbid end)
                  is not null or """ + _CREDITED_ONLY_SQL + """
            group by artists.id, artists.name, 3, remote.canonical_name
            order by 3;
        """
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(sql, params).fetchall()]

    def record(self, *, job_id: int, worker_id: str, outcomes: list[dict[str, object]], observed_at: datetime) -> int:
        """Store the release groups and releases seen with the series each is part of, then
        each compared album's decision. An owner's manual choice is kept; albums no longer
        present simply have no row."""
        observed = _aware_utc(observed_at)
        groups, releases, albums = {}, {}, []
        for outcome in outcomes:
            groups.update(outcome.get("release_groups") or {})
            releases.update(outcome.get("releases") or {})
            for album in outcome.get("albums") or []:
                albums.append({**album, "artist_mbid": outcome.get("artist_mbid")})
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                for group in groups.values():
                    connection.execute(_UPSERT_GROUP, _group_params(group, observed))
                for release in releases.values():
                    connection.execute(_UPSERT_RELEASE, _release_params(release, groups, observed))
                _replace_series(connection, groups.values(), releases.values(), observed)
                row = connection.execute(_REPLACE_ALBUMS, {
                    "job_id": _positive_id(job_id), "worker_id": _bounded_text(worker_id, 128, required=True),
                    "job_kind": JOB_KIND, "observed_at": observed, "matcher_version": RELEASE_MATCHER_VERSION,
                    "rows": json.dumps([_album_row(album, releases, observed) for album in albums]),
                }).fetchone()
        # The decided albums' data corrections (S4), stored for Problematic Files.
        from music_app.services.musicbrainz_corrections_postgres import MusicBrainzCorrectionsPostgresRepository

        try:
            MusicBrainzCorrectionsPostgresRepository(
                {"ALBUM_HAVEN_APP_DATABASE_URL": self._database_url}, connect=self._connect,
            ).refresh(album_ids=[album["local_album_id"] for album in albums if album.get("local_album_id")],
                      observed_at=observed)
        except Exception:
            logging.getLogger(__name__).warning("MusicBrainz data corrections could not be refreshed.")
        return int(_row_mapping(row).get("stored") or 0)


    def claim_section_retry(self, *, now: datetime) -> dict[str, object] | None:
        """The " / " album whose Discogs check is most overdue, held for 15 minutes so another
        lane skips it. None when nothing is due."""
        sql = _active_library_cte() + """
            , due as (
              select decision.library_id, decision.album_key
              from active_library
              join library.local_album_musicbrainz_releases decision on decision.library_id = active_library.library_id
              where decision.discogs_section_retry_at <= %(now)s and decision.state = 'release'
                and decision.decision_source = 'automatic'
              order by decision.discogs_section_retry_at
              limit 1
              for update of decision skip locked
            ), held as (
              update library.local_album_musicbrainz_releases decision
              set discogs_section_retry_at = %(now)s + interval '15 minutes'
              from due where decision.library_id = due.library_id and decision.album_key = due.album_key
              returning decision.library_id, decision.album_key, decision.release_mbid,
                        decision.discogs_section_first_failed_at
            )
            select held.library_id, held.album_key, held.release_mbid::text as release_mbid,
                   held.discogs_section_first_failed_at as first_failed_at, albums.id as local_album_id,
                   albums.title, artists.name as local_name, releases.barcode, album_tracks.tracks
            from held
            join library.local_albums albums
              on albums.library_id = held.library_id and albums.album_key = held.album_key
            join library.local_artists artists on artists.library_id = albums.library_id and artists.id = albums.artist_id
            join integration.musicbrainz_releases releases on releases.mbid = held.release_mbid
            join lateral (
              select json_agg(json_build_object(
                       'title', tracks.title, 'duration_seconds', tracks.duration_seconds,
                       'disc_number', coalesce(nullif(tracks.disc_number, 0), 1), 'track_number', tracks.track_number)
                       order by coalesce(nullif(tracks.disc_number, 0), 1), tracks.track_number, tracks.title) as tracks
              from library.local_tracks tracks
              where tracks.library_id = albums.library_id and tracks.album_id = albums.id
            ) album_tracks on true;
        """
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                row = connection.execute(sql, {"now": _aware_utc(now)}).fetchone()
        return _row_mapping(row) if row else None

    def store_section_retry(self, *, row: dict[str, object], track_sections: list[dict[str, object]] | None,
                            retry_at: datetime | None, observed_at: datetime) -> None:
        """A definitive answer (``track_sections``, possibly empty) ends the retries; None counts
        one more unavailable answer and schedules ``retry_at`` (None once a week has passed)."""
        failed = track_sections is None
        with self._connect(self._database_url) as connection:
            connection.execute(
                """
                update library.local_album_musicbrainz_releases
                set track_sections = case when %(failed)s then track_sections else %(sections)s::jsonb end,
                    discogs_section_attempts = case when %(failed)s then discogs_section_attempts + 1 else 0 end,
                    discogs_section_first_failed_at = case when %(failed)s then discogs_section_first_failed_at end,
                    discogs_section_retry_at = %(retry_at)s, updated_at = %(observed_at)s
                where library_id = %(library_id)s and album_key = %(album_key)s
                  and release_mbid = %(release_mbid)s::uuid and discogs_section_attempts > 0
                """,
                {"failed": failed, "sections": json.dumps(track_sections or []),
                 "observed_at": _aware_utc(observed_at), "retry_at": _aware_utc(retry_at) if retry_at else None,
                 "library_id": row["library_id"], "album_key": row["album_key"], "release_mbid": row["release_mbid"]})

    def unsized_series(self, *, limit: int) -> list[str]:
        """Series stored without their size yet, oldest first."""
        with self._connect(self._database_url) as connection:
            return [str(_row_mapping(row)["mbid"]) for row in connection.execute(
                "select mbid::text from integration.musicbrainz_series where member_count is null"
                " order by created_at, mbid limit %(limit)s", {"limit": max(1, int(limit))}).fetchall()]

    def store_series_size(self, *, mbid: str, member_count: int, observed_at: datetime) -> None:
        """How many release groups and releases MusicBrainz lists in the series; the computed
        kind follows. An owner's choice of kind is untouched."""
        with self._connect(self._database_url) as connection:
            connection.execute(
                "update integration.musicbrainz_series set member_count = %(count)s, updated_at = %(observed_at)s"
                " where mbid = %(mbid)s::uuid",
                {"mbid": mbid, "count": max(0, int(member_count)), "observed_at": _aware_utc(observed_at)})


def _date(value: object) -> str | None:
    text = str(value or "").strip()
    return text if _DATE.match(text) else None


def _text(value: object, limit: int) -> str | None:
    text = str(value or "").strip()
    return text[:limit] or None


def _group_params(group: dict[str, object], observed: datetime) -> dict[str, object]:
    return {"mbid": group["id"], "title": _text(group.get("title"), 1024) or "[untitled]",
            "primary_type": _text(group.get("primary_type"), 64),
            "secondary_types": [str(kind)[:64] for kind in group.get("secondary_types") or [] if kind],
            "first_release_date": _date(group.get("first_release_date")),
            "disambiguation": _text(group.get("disambiguation"), 1024),
            "genres": json.dumps([{"name": str(genre["name"])[:128], "count": int(genre.get("count") or 0)}
                                  for genre in group.get("genres") or [] if genre.get("name")][:20]),
            "observed_at": observed}


def _release_params(release: dict[str, object], groups: dict[str, object], observed: datetime) -> dict[str, object]:
    group_id = release.get("release_group_id")
    return {"mbid": release["id"], "release_group_mbid": group_id if group_id in groups else None,
            "title": _text(release.get("title"), 1024) or "[untitled]", "release_date": _date(release.get("date")),
            "country": _text(release.get("country"), 8), "barcode": _text(release.get("barcode"), 64),
            "status": _text(release.get("status"), 64), "disambiguation": _text(release.get("disambiguation"), 1024),
            "artist_credit": json.dumps(release.get("artist_credit") or []),
            "media": json.dumps(release.get("media") or []), "observed_at": observed}


def _series_rows(entity: dict[str, object]) -> list[dict[str, object]]:
    return [{"mbid": part["mbid"], "name": str(part.get("name") or "")[:1024] or "[untitled]",
             "type": _text(part.get("type"), 64), "disambiguation": _text(part.get("disambiguation"), 1024),
             "number": _text(part.get("number"), 64), "ordering_key": part.get("ordering_key")}
            for part in entity.get("series") or [] if isinstance(part, dict) and part.get("mbid")]


def _replace_series(connection, groups, releases, observed: datetime) -> None:
    """Each looked-up release group and release gets exactly the series MusicBrainz named
    for it. A lookup made without series relations (no ``series`` key) changes nothing."""
    looked_up = [(table, column, entity) for table, column, entities in (
        ("integration.musicbrainz_release_group_series", "release_group_mbid", groups),
        ("integration.musicbrainz_release_series", "release_mbid", releases)) for entity in entities
        if isinstance(entity.get("series"), list)]
    series = {row["mbid"]: row for _table, _column, entity in looked_up for row in _series_rows(entity)}
    if series:
        connection.execute(_UPSERT_SERIES, {"series": json.dumps(list(series.values())), "observed_at": observed})
    for table, column, entity in looked_up:
        params = {"mbid": entity["id"], "series": json.dumps(_series_rows(entity))}
        connection.execute(f"delete from {table} where {column} = %(mbid)s::uuid", params)
        connection.execute(
            f"insert into {table} ({column}, series_mbid, ordering_number, ordering_key)"
            " select distinct on (rows.mbid) %(mbid)s::uuid, rows.mbid, rows.number, rows.ordering_key"
            " from jsonb_to_recordset(%(series)s::jsonb) as rows(mbid uuid, number text, ordering_key integer)",
            params)


def _album_row(album: dict[str, object], releases: dict[str, object], observed: datetime) -> dict[str, object]:
    main = album.get("main_disc") or {}
    unavailable = bool(album.get("discogs_sections_unavailable"))
    original = album.get("original_release_mbid")
    diagnostic = album.get("diagnostic")
    edition = album.get("edition") if album.get("state") == "release" else None
    return {"local_album_id": album.get("local_album_id"), "state": album.get("state"),
            "artist_mbid": album.get("artist_mbid"), "release_group_mbid": album.get("release_group_mbid"),
            "release_mbid": album.get("release_mbid"),
            "original_release_mbid": original if original in releases else None,
            "disc_position": album.get("disc_position"),
            "diagnostic": diagnostic if diagnostic in DIAGNOSTICS else None,
            "main_disc_count": main.get("main_disc_count"), "main_disc_source": main.get("source"),
            "track_artists": album.get("track_artists") or [], "track_sections": album.get("track_sections") or [],
            "signals": list(album.get("signals") or []),
            # Discogs did not answer: a fresh retry schedule starts now.
            "discogs_section_first_failed_at": observed.isoformat() if unavailable else None,
            "discogs_section_retry_at": section_retry_at(observed, observed).isoformat() if unavailable else None,
            "match_quality": (edition or {}).get("match_quality"),
            "track_pairing": (edition or {}).get("track_pairing") or [],
            "track_order_differs": bool((edition or {}).get("track_order_differs"))}


_UPSERT_GROUP = """
    insert into integration.musicbrainz_release_groups (
      mbid, title, primary_type, secondary_types, first_release_date, disambiguation, genres, refreshed_at,
      created_at, updated_at)
    values (%(mbid)s::uuid, %(title)s, %(primary_type)s, %(secondary_types)s::text[], %(first_release_date)s,
            %(disambiguation)s, %(genres)s::jsonb, %(observed_at)s, %(observed_at)s, %(observed_at)s)
    on conflict (mbid) do update
    set title = excluded.title, primary_type = excluded.primary_type, secondary_types = excluded.secondary_types,
        first_release_date = excluded.first_release_date, disambiguation = excluded.disambiguation,
        genres = excluded.genres, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at;
"""

_UPSERT_SERIES = """
    insert into integration.musicbrainz_series (mbid, name, series_type, disambiguation, refreshed_at, created_at,
                                                updated_at)
    select rows.mbid, rows.name, rows.type, rows.disambiguation, %(observed_at)s, %(observed_at)s, %(observed_at)s
    from jsonb_to_recordset(%(series)s::jsonb) as rows(mbid uuid, name text, type text, disambiguation text)
    on conflict (mbid) do update
    set name = excluded.name, series_type = excluded.series_type, disambiguation = excluded.disambiguation,
        refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at;
"""

_UPSERT_RELEASE = """
    insert into integration.musicbrainz_releases (
      mbid, release_group_mbid, title, release_date, country, barcode, status, disambiguation, artist_credit, media,
      refreshed_at, created_at, updated_at)
    values (%(mbid)s::uuid, %(release_group_mbid)s::uuid, %(title)s, %(release_date)s, %(country)s, %(barcode)s,
            %(status)s, %(disambiguation)s, %(artist_credit)s::jsonb, %(media)s::jsonb, %(observed_at)s,
            %(observed_at)s, %(observed_at)s)
    on conflict (mbid) do update
    set release_group_mbid = coalesce(excluded.release_group_mbid, integration.musicbrainz_releases.release_group_mbid),
        title = excluded.title, release_date = excluded.release_date, country = excluded.country,
        barcode = excluded.barcode, status = excluded.status, disambiguation = excluded.disambiguation,
        artist_credit = excluded.artist_credit, media = excluded.media, refreshed_at = excluded.refreshed_at,
        updated_at = excluded.updated_at;
"""

# Rows only for the leased job's own artist's albums; the artist MBID must be stored (a
# per-album identity or the accepted match), else the album keeps no artist link.
_REPLACE_ALBUMS = _active_library_cte() + """
    , job as (
      select jobs.library_id, jobs.local_artist_id from ops.metadata_enrichment_jobs jobs
      join active_library on active_library.library_id = jobs.library_id
      where jobs.id = %(job_id)s and jobs.job_kind = %(job_kind)s and jobs.state = 'leased'
        and jobs.lease_owner = %(worker_id)s
    ), incoming as (
      select albums.library_id, albums.album_key, rows.*
      from job
      cross join jsonb_to_recordset(%(rows)s::jsonb) as rows(
        local_album_id bigint, state text, artist_mbid uuid, release_group_mbid uuid, release_mbid uuid,
        original_release_mbid uuid, disc_position integer, diagnostic text, main_disc_count integer,
        main_disc_source text, track_artists jsonb, track_sections jsonb, signals text[],
        discogs_section_first_failed_at timestamptz, discogs_section_retry_at timestamptz,
        match_quality text, track_pairing jsonb, track_order_differs boolean)
      join library.local_albums albums
        on albums.library_id = job.library_id and albums.artist_id = job.local_artist_id
       and albums.id = rows.local_album_id
    ), stored as (
      insert into library.local_album_musicbrainz_releases (
        library_id, album_key, state, artist_mbid, release_group_mbid, release_mbid, original_release_mbid,
        disc_position, diagnostic, main_disc_count, main_disc_source, track_artists, track_sections, signals,
        discogs_section_attempts, discogs_section_first_failed_at, discogs_section_retry_at,
        match_quality, track_pairing, track_order_differs,
        decision_source, matcher_version, observed_at, created_at, updated_at)
      select incoming.library_id, incoming.album_key, incoming.state,
             (select mbid from integration.musicbrainz_artists where mbid = incoming.artist_mbid),
             incoming.release_group_mbid, incoming.release_mbid, incoming.original_release_mbid,
             incoming.disc_position, incoming.diagnostic, incoming.main_disc_count, incoming.main_disc_source,
             coalesce(incoming.track_artists, '[]'::jsonb), coalesce(incoming.track_sections, '[]'::jsonb),
             coalesce(incoming.signals, '{}'::text[]),
             case when incoming.discogs_section_first_failed_at is null then 0 else 1 end,
             incoming.discogs_section_first_failed_at, incoming.discogs_section_retry_at,
             incoming.match_quality, coalesce(incoming.track_pairing, '[]'::jsonb),
             coalesce(incoming.track_order_differs, false), 'automatic',
             %(matcher_version)s, %(observed_at)s, %(observed_at)s, %(observed_at)s
      from incoming
      on conflict (library_id, album_key) do update
      set state = excluded.state, artist_mbid = excluded.artist_mbid,
          release_group_mbid = excluded.release_group_mbid, release_mbid = excluded.release_mbid,
          original_release_mbid = excluded.original_release_mbid, disc_position = excluded.disc_position,
          diagnostic = excluded.diagnostic, main_disc_count = excluded.main_disc_count,
          main_disc_source = excluded.main_disc_source, track_artists = excluded.track_artists,
          -- Discogs did not answer: the same release keeps the headings it had.
          track_sections = case
            when excluded.discogs_section_attempts > 0
             and library.local_album_musicbrainz_releases.release_mbid = excluded.release_mbid
            then library.local_album_musicbrainz_releases.track_sections else excluded.track_sections end,
          discogs_section_attempts = excluded.discogs_section_attempts,
          discogs_section_first_failed_at = excluded.discogs_section_first_failed_at,
          discogs_section_retry_at = excluded.discogs_section_retry_at,
          match_quality = excluded.match_quality, track_pairing = excluded.track_pairing,
          track_order_differs = excluded.track_order_differs,
          signals = excluded.signals, matcher_version = excluded.matcher_version,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at
      where library.local_album_musicbrainz_releases.decision_source <> 'manual'
      returning library_id, album_key, release_group_mbid, diagnostic
    ), flagged as (
      -- "MusicBrainz has no info" (S5): no release of the artist has this album's title. An
      -- owner's manual decision is never stored here, so it never raises a flag.
      insert into library.musicbrainz_contribution_flags (
        library_id, target_kind, album_key, source, reason, created_at, updated_at)
      select library_id, 'album', album_key, 'automatic', 'missing_from_musicbrainz',
             %(observed_at)s, %(observed_at)s
      from stored where release_group_mbid is null and diagnostic = 'no_title_match'
      on conflict (library_id, album_key, source) where target_kind = 'album' do nothing
      returning 1
    ), cleared as (
      -- Cleared once the album resolves; the owner's own flags (source manual) stay.
      delete from library.musicbrainz_contribution_flags flags using stored
      where flags.library_id = stored.library_id and flags.album_key = stored.album_key
        and flags.target_kind = 'album' and flags.source = 'automatic'
        and stored.release_group_mbid is not null
      returning 1
    )
    select count(*)::integer as stored from stored;
"""


def album_track_pairing(connection: Any, *, library_id: int, album_key: str) -> dict[str, object] | None:
    """How a certainly matched album's local tracks pair with its MusicBrainz edition, for the
    data correction (S4): ``release_mbid`` (the edition), ``match_quality`` and, when
    ``reordered``, ``pairing`` from (disc_number, track_number) to (release_disc,
    release_position). ``order_exact`` pairs by position; ``ambiguous`` pairs nothing and goes
    to review. None when the album has no certain release or was decided before track order."""
    row = connection.execute(
        """
        select release_mbid::text as release_mbid, match_quality, track_pairing, track_order_differs
        from library.local_album_musicbrainz_releases
        where library_id = %(library_id)s and album_key = %(album_key)s and state = 'release'
          and match_quality is not null
        """,
        {"library_id": library_id, "album_key": album_key},
    ).fetchone()
    return parse_track_pairing(_row_mapping(row)) if row else None


def parse_track_pairing(row: Mapping[str, object]) -> dict[str, object] | None:
    """album_track_pairing's answer from a decision row with release_mbid, match_quality,
    track_pairing and track_order_differs (None before the album was re-checked)."""
    if not row.get("match_quality"):
        return None
    pairing = row.get("track_pairing")
    if isinstance(pairing, str):
        pairing = json.loads(pairing)
    return {"release_mbid": row.get("release_mbid"), "match_quality": row["match_quality"],
            "track_order_differs": bool(row.get("track_order_differs")),
            "pairing": {(int(item["disc_number"]), int(item["track_number"])):
                        (int(item["release_disc"]), int(item["release_position"])) for item in pairing or []}}
