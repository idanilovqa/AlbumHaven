"""PostgreSQL authority for the Discogs fallback (MusicBrainz Delivery 2, S3).

One job per local artist MusicBrainz did not find (job kind ``discogs_fallback``). Its
outcome stores the Discogs artist and the albums Discogs certainly has, flags what
MusicBrainz lacks for contribution, and queues the artist's MusicBrainz match again when
Discogs led to a MusicBrainz artist: the matcher reads those artists as hints.
"""
from __future__ import annotations

import json
from datetime import datetime

from music_app.services.musicbrainz_enrichment_postgres import (
    _JOB_KIND as ARTIST_JOB_KIND,
    _active_library_cte,
    _aware_utc,
    _bounded_text,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity_postgres import EnrichmentJobQueue

JOB_KIND = "discogs_fallback"


class DiscogsFallbackPostgresRepository(EnrichmentJobQueue):
    job_kind = JOB_KIND

    def enqueue(self, *, reason: str, observed_at: datetime, local_artist_id: int | None = None) -> int:
        """Artists MusicBrainz did not find, with albums, that Discogs has not answered for in
        the last 30 days (owner 2026-11-09: "For all the artists in this not found list just
        do discogs fallback")."""
        params = {"reason": _bounded_text(reason, 128, required=True), "observed_at": _aware_utc(observed_at),
                  "job_kind": JOB_KIND,
                  "local_artist_id": _positive_id(local_artist_id) if local_artist_id is not None else None}
        sql = _active_library_cte() + """
            , eligible as (
              select matches.library_id, matches.local_artist_id
              from active_library
              join library.local_artist_musicbrainz_matches matches
                on matches.library_id = active_library.library_id and matches.state = 'not_found'
              left join library.local_artist_discogs_identities discogs
                on discogs.library_id = matches.library_id and discogs.local_artist_id = matches.local_artist_id
              where (%(local_artist_id)s::bigint is null or matches.local_artist_id = %(local_artist_id)s::bigint)
                and (discogs.local_artist_id is null or discogs.observed_at < %(observed_at)s - interval '30 days')
                -- An artist whose fallback used up its retries rests a week before the next try.
                and not exists (
                  select 1 from ops.metadata_enrichment_jobs recent
                  where recent.library_id = matches.library_id and recent.local_artist_id = matches.local_artist_id
                    and recent.job_kind = %(job_kind)s and recent.state = 'exhausted'
                    and recent.updated_at > %(observed_at)s - interval '7 days')
                and exists (select 1 from library.local_albums albums
                            join library.local_tracks tracks
                              on tracks.library_id = albums.library_id and tracks.album_id = albums.id
                            where albums.library_id = matches.library_id and albums.artist_id = matches.local_artist_id)
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

    def load_context(self, *, job_id: int, worker_id: str) -> dict[str, object] | None:
        params = {"job_id": _positive_id(job_id), "worker_id": _bounded_text(worker_id, 128, required=True),
                  "job_kind": JOB_KIND}
        sql = _active_library_cte() + """
            select artists.id as local_artist_id, artists.name as local_name,
                   json_agg(json_build_object('id', albums.id, 'title', albums.title, 'year', albums.release_year,
                                              'tracks', album_tracks.tracks) order by albums.title, albums.id) as albums
            from active_library
            join ops.metadata_enrichment_jobs jobs
              on jobs.library_id = active_library.library_id and jobs.id = %(job_id)s
             and jobs.job_kind = %(job_kind)s and jobs.state = 'leased' and jobs.lease_owner = %(worker_id)s
            join library.local_artists artists on artists.library_id = jobs.library_id and artists.id = jobs.local_artist_id
            join library.local_albums albums on albums.library_id = artists.library_id and albums.artist_id = artists.id
            join lateral (
              select json_agg(json_build_object('title', tracks.title, 'duration_seconds', tracks.duration_seconds,
                                                'disc_number', coalesce(nullif(tracks.disc_number, 0), 1),
                                                'track_number', tracks.track_number)
                              order by coalesce(nullif(tracks.disc_number, 0), 1), tracks.track_number, tracks.title)
                       as tracks
              from library.local_tracks tracks
              where tracks.library_id = albums.library_id and tracks.album_id = albums.id
              having count(*) > 0
            ) album_tracks on true
            group by artists.id, artists.name;
        """
        return self._one(sql, params) or None

    def record(self, *, job_id: int, worker_id: str, outcome: dict[str, object], observed_at: datetime) -> bool:
        """Store the outcome; True when the artist's MusicBrainz match was queued again."""
        observed = _aware_utc(observed_at)
        artist = outcome.get("discogs_artist") or None
        found = outcome.get("classification") == "found" and artist
        albums = outcome.get("albums") or []
        params = {
            "job_id": _positive_id(job_id), "worker_id": _bounded_text(worker_id, 128, required=True),
            "job_kind": JOB_KIND, "artist_job_kind": ARTIST_JOB_KIND, "observed_at": observed,
            "state": "found" if found else "not_found",
            "discogs_artist_id": int(artist["id"]) if found else None,
            "hints": json.dumps([_hint(hint) for hint in outcome.get("musicbrainz_hints") or []]),
            "evidence_summary": _bounded_text(outcome.get("evidence_summary"), 1024) or None,
            "remote_info_needed": bool(outcome.get("remote_info_needed", True)),
            "albums": json.dumps([{"local_album_id": album.get("local_album_id"),
                                   "discogs_release_id": int(album["discogs_release_id"]),
                                   "discogs_master_id": album.get("discogs_master_id"),
                                   "signals": list(album.get("signals") or []),
                                   "track_sections": album.get("track_sections") or []} for album in albums]),
        }
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                if found:
                    connection.execute(_UPSERT_ARTIST, {
                        "id": int(artist["id"]), "name": _bounded_text(artist.get("name"), 512) or "[unknown]",
                        "real_name": _bounded_text(artist.get("real_name"), 512) or None,
                        "name_variations": [str(name)[:512] for name in artist.get("name_variations") or []][:50],
                        "aliases": json.dumps([{"id": alias["id"], "name": str(alias["name"])[:512]}
                                               for alias in artist.get("aliases") or []][:50]),
                        "observed_at": observed})
                for album in albums:
                    connection.execute(_UPSERT_RELEASE, {
                        "id": int(album["discogs_release_id"]), "master_id": album.get("discogs_master_id"),
                        "title": _bounded_text(album.get("discogs_title") or album.get("local_title"), 1024) or "[untitled]",
                        "release_year": _year(album.get("discogs_year")), "barcodes": list(album.get("barcodes") or [])[:20],
                        "tracks": json.dumps(album.get("tracks") or []), "observed_at": observed})
                row = connection.execute(_RECORD, params).fetchone()
        return bool(_row_mapping(row).get("requeued"))


def _year(value: object) -> str | None:
    text = str(value or "").strip()
    return text if len(text) == 4 and text.isdigit() and text != "0000" else None


def _hint(hint: dict[str, object]) -> dict[str, object]:
    return {key: hint.get(key) for key in ("artist_mbid", "via", "barcode", "release_mbid", "name") if hint.get(key)}


_UPSERT_ARTIST = """
    insert into integration.discogs_artists (id, name, real_name, name_variations, aliases, refreshed_at,
                                             created_at, updated_at)
    values (%(id)s, %(name)s, %(real_name)s, %(name_variations)s::text[], %(aliases)s::jsonb, %(observed_at)s,
            %(observed_at)s, %(observed_at)s)
    on conflict (id) do update
    set name = excluded.name, real_name = excluded.real_name, name_variations = excluded.name_variations,
        aliases = excluded.aliases, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at;
"""

_UPSERT_RELEASE = """
    insert into integration.discogs_releases (id, master_id, title, release_year, barcodes, tracks, refreshed_at,
                                              created_at, updated_at)
    values (%(id)s, %(master_id)s, %(title)s, %(release_year)s, %(barcodes)s::text[], %(tracks)s::jsonb,
            %(observed_at)s, %(observed_at)s, %(observed_at)s)
    on conflict (id) do update
    set master_id = excluded.master_id, title = excluded.title, barcodes = excluded.barcodes,
        tracks = excluded.tracks, refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at;
"""

# Everything for the leased job's own artist only.
_RECORD = _active_library_cte() + """
    , job as (
      select jobs.library_id, jobs.local_artist_id from ops.metadata_enrichment_jobs jobs
      join active_library on active_library.library_id = jobs.library_id
      where jobs.id = %(job_id)s and jobs.job_kind = %(job_kind)s and jobs.state = 'leased'
        and jobs.lease_owner = %(worker_id)s
    ), identity as (
      insert into library.local_artist_discogs_identities (
        library_id, local_artist_id, state, discogs_artist_id, musicbrainz_hints, evidence_summary, observed_at,
        created_at, updated_at)
      select job.library_id, job.local_artist_id, %(state)s, %(discogs_artist_id)s, %(hints)s::jsonb,
             %(evidence_summary)s, %(observed_at)s, %(observed_at)s, %(observed_at)s
      from job
      on conflict (library_id, local_artist_id) do update
      set state = excluded.state, discogs_artist_id = excluded.discogs_artist_id,
          musicbrainz_hints = excluded.musicbrainz_hints, evidence_summary = excluded.evidence_summary,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at
      returning 1
    ), artist_albums as (
      select albums.library_id, albums.album_key, albums.id from job
      join library.local_albums albums on albums.library_id = job.library_id and albums.artist_id = job.local_artist_id
    ), removed_albums as (
      delete from library.local_album_discogs_releases stored using artist_albums
      where stored.library_id = artist_albums.library_id and stored.album_key = artist_albums.album_key
      returning 1
    ), incoming as (
      select artist_albums.library_id, artist_albums.album_key, rows.*
      from (select count(*) from removed_albums) settled
      cross join jsonb_to_recordset(%(albums)s::jsonb)
        as rows(local_album_id bigint, discogs_release_id bigint, discogs_master_id bigint, signals text[],
                track_sections jsonb)
      join artist_albums on artist_albums.id = rows.local_album_id
    ), stored_albums as (
      insert into library.local_album_discogs_releases (
        library_id, album_key, discogs_release_id, discogs_master_id, signals, track_sections, observed_at,
        created_at, updated_at)
      select library_id, album_key, discogs_release_id, discogs_master_id, coalesce(signals, '{}'::text[]),
             coalesce(track_sections, '[]'::jsonb), %(observed_at)s, %(observed_at)s, %(observed_at)s
      from incoming
      on conflict (library_id, album_key) do update
      set discogs_release_id = excluded.discogs_release_id, discogs_master_id = excluded.discogs_master_id,
          signals = excluded.signals, track_sections = excluded.track_sections, observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
      returning 1
    ), cleared_flag as (
      delete from library.musicbrainz_contribution_flags flags using job
      where flags.library_id = job.library_id and flags.local_artist_id = job.local_artist_id
        and flags.target_kind = 'artist' and flags.source = 'automatic' and not %(remote_info_needed)s
      returning 1
    ), raised_flag as (
      -- "MBID: Remote info update needed": an artist MusicBrainz still lacks.
      insert into library.musicbrainz_contribution_flags (
        library_id, target_kind, local_artist_id, source, reason, created_at, updated_at)
      select job.library_id, 'artist', job.local_artist_id, 'automatic', 'missing_from_musicbrainz',
             %(observed_at)s, %(observed_at)s
      from job where %(remote_info_needed)s
      on conflict (library_id, local_artist_id, source) where target_kind = 'artist' do nothing
      returning 1
    ), requeued as (
      -- Discogs led to MusicBrainz artists: match this artist again with them as hints.
      insert into ops.metadata_enrichment_jobs (
        library_id, local_artist_id, target_kind, job_kind, reason, state, next_attempt_at, created_at, updated_at)
      select job.library_id, job.local_artist_id, 'artist', %(artist_job_kind)s, 'discogs_hint', 'queued',
             %(observed_at)s, %(observed_at)s, %(observed_at)s
      from job where jsonb_array_length(%(hints)s::jsonb) > 0
      on conflict (library_id, local_artist_id, job_kind) where state in ('queued', 'leased', 'retry_wait')
      do nothing
      returning 1
    )
    select (select count(*) from identity) as identity, (select count(*) from stored_albums) as albums,
           (select count(*) from cleared_flag) + (select count(*) from raised_flag) as flags,
           exists (select 1 from requeued) as requeued;
"""
