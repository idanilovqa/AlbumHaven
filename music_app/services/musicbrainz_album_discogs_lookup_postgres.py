"""PostgreSQL authority for a matched band's album lookups on Discogs (Delivery 2, 0272).

Every statement names one artist or one album: nothing here reads the whole library.
"""
from __future__ import annotations

import json
from datetime import datetime

from music_app.services.musicbrainz_discogs_fallback_postgres import upsert_discogs_release
from music_app.services.musicbrainz_enrichment_postgres import (
    _active_library_cte,
    _aware_utc,
    _bounded_text,
    _positive_id,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity_postgres import EnrichmentJobQueue

JOB_KIND = "album_discogs_lookup"
# The band has no release of this title. "Waiting" (budget_exhausted) is never asked.
LOOKUP_DIAGNOSTICS = ("no_title_match",)
_ASK_AGAIN_AFTER = "30 days"

# The artist's albums that are due, each with the signature of what would be searched.
_DUE_ALBUMS = f"""
    select albums.id, albums.album_key, albums.title, albums.release_year as year, artists.name as local_name,
           remote.canonical_name, searched.signature, searched.tracks
    from scope
    join library.local_artists artists
      on artists.library_id = scope.library_id and artists.id = scope.local_artist_id
    join library.local_albums albums on albums.library_id = artists.library_id and albums.artist_id = artists.id
    join library.local_album_musicbrainz_releases decision
      on decision.library_id = albums.library_id and decision.album_key = albums.album_key
     and decision.state = 'unresolved' and decision.diagnostic = any(%(diagnostics)s::text[])
    left join library.local_album_artist_identities identities
      on identities.library_id = albums.library_id and identities.album_key = albums.album_key
    left join library.local_artist_musicbrainz_matches matches
      on matches.library_id = artists.library_id and matches.local_artist_id = artists.id
     and matches.state = 'matched'
    join integration.musicbrainz_artists remote on remote.mbid = coalesce(identities.artist_mbid, matches.artist_mbid)
    join lateral (
      select md5(concat_ws(E'\\x1f', albums.title, artists.name, remote.canonical_name,
                           string_agg(concat_ws(E'\\x1e', tracks.disc_number, tracks.track_number, tracks.title,
                                                tracks.duration_seconds), E'\\x1d'
                                      order by tracks.disc_number, tracks.track_number, tracks.id))) as signature,
             json_agg(json_build_object(
               'title', tracks.title, 'duration_seconds', tracks.duration_seconds,
               'disc_number', coalesce(nullif(tracks.disc_number, 0), 1), 'track_number', tracks.track_number)
               order by coalesce(nullif(tracks.disc_number, 0), 1), tracks.track_number, tracks.title) as tracks
      from library.local_tracks tracks
      where tracks.library_id = albums.library_id and tracks.album_id = albums.id
      having count(*) > 0
    ) searched on true
    left join library.local_album_discogs_lookups stored
      on stored.library_id = albums.library_id and stored.album_key = albums.album_key
    where stored.album_key is null
       or stored.searched_signature <> searched.signature
       or stored.observed_at < %(observed_at)s - interval '{_ASK_AGAIN_AFTER}'
"""


class AlbumDiscogsLookupPostgresRepository(EnrichmentJobQueue):
    job_kind = JOB_KIND

    def enqueue(self, *, local_artist_id: int, reason: str, observed_at: datetime) -> int:
        """Queue one artist when it has a due album. An artist whose lookups used up their
        retries rests a week, as in the artist fallback."""
        params = {"local_artist_id": _positive_id(local_artist_id), "job_kind": JOB_KIND,
                  "reason": _bounded_text(reason, 128, required=True), "observed_at": _aware_utc(observed_at),
                  "diagnostics": list(LOOKUP_DIAGNOSTICS)}
        sql = _active_library_cte() + f"""
            , scope as (
              select library_id, %(local_artist_id)s::bigint as local_artist_id from active_library
            ), inserted as (
              insert into ops.metadata_enrichment_jobs (
                library_id, local_artist_id, target_kind, job_kind, reason, state, next_attempt_at,
                created_at, updated_at)
              select scope.library_id, scope.local_artist_id, 'artist', %(job_kind)s, %(reason)s, 'queued',
                     %(observed_at)s, %(observed_at)s, %(observed_at)s
              from scope
              where exists ({_DUE_ALBUMS})
                and not exists (
                  select 1 from ops.metadata_enrichment_jobs recent
                  where recent.library_id = scope.library_id and recent.local_artist_id = scope.local_artist_id
                    and recent.job_kind = %(job_kind)s and recent.state = 'exhausted'
                    and recent.updated_at > %(observed_at)s - interval '7 days')
              on conflict (library_id, local_artist_id, job_kind) where state in ('queued', 'leased', 'retry_wait')
              do nothing
              returning 1
            )
            select count(*)::integer as enqueued from inserted;
        """
        return int(self._one(sql, params).get("enqueued") or 0)

    def load_albums(self, *, job_id: int, worker_id: str, limit: int,
                    observed_at: datetime) -> list[dict[str, object]]:
        params = {**self._job_params(job_id, worker_id), "limit": max(1, int(limit)),
                  "observed_at": _aware_utc(observed_at), "diagnostics": list(LOOKUP_DIAGNOSTICS)}
        sql = _active_library_cte() + f"""
            , scope as ({_LEASED_JOB})
            {_DUE_ALBUMS}
            order by albums.id limit %(limit)s;
        """
        with self._connect(self._database_url) as connection:
            albums = [_row_mapping(row) for row in connection.execute(sql, params).fetchall()]
        for album in albums:
            if isinstance(album.get("tracks"), str):
                album["tracks"] = json.loads(album["tracks"])
        return albums

    def record(self, *, job_id: int, worker_id: str, album: dict[str, object], found: dict[str, object] | None,
               observed_at: datetime) -> None:
        """One album's answer, with the signature of what was searched."""
        observed = _aware_utc(observed_at)
        params = {**self._job_params(job_id, worker_id), "album_id": _positive_id(album["id"]),
                  "signature": _bounded_text(album["signature"], 64, required=True), "observed_at": observed,
                  "state": "found" if found else "not_found",
                  "discogs_release_id": int(found["discogs_release_id"]) if found else None}
        sql = _active_library_cte() + f"""
            , scope as ({_LEASED_JOB})
            insert into library.local_album_discogs_lookups (
              library_id, album_key, state, discogs_release_id, searched_signature, observed_at)
            select albums.library_id, albums.album_key, %(state)s, %(discogs_release_id)s, %(signature)s,
                   %(observed_at)s
            from scope
            join library.local_albums albums
              on albums.library_id = scope.library_id and albums.artist_id = scope.local_artist_id
             and albums.id = %(album_id)s
            on conflict (library_id, album_key) do update
            set state = excluded.state, discogs_release_id = excluded.discogs_release_id,
                searched_signature = excluded.searched_signature, observed_at = excluded.observed_at;
        """
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                if found:
                    upsert_discogs_release(connection, found, observed)
                connection.execute(sql, params)

    def _job_params(self, job_id: int, worker_id: str) -> dict[str, object]:
        return {"job_id": _positive_id(job_id), "job_kind": JOB_KIND,
                "worker_id": _bounded_text(worker_id, 128, required=True)}


_LEASED_JOB = """
    select jobs.library_id, jobs.local_artist_id
    from ops.metadata_enrichment_jobs jobs
    join active_library on active_library.library_id = jobs.library_id
    where jobs.id = %(job_id)s and jobs.job_kind = %(job_kind)s and jobs.state = 'leased'
      and jobs.lease_owner = %(worker_id)s
"""
