from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Mapping
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.postgres_connections import pooled_connection


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_JOB_KIND = "musicbrainz_artist_enrichment"
_OWNER_SYNC_REASON = "library_menu_sync"
# The album-evidence matcher. Automatic rows decided by an older version are
# re-checked by the next backfill (migration 0174). Version 3 adds box-set discs,
# matched siblings, Last.fm album identifiers and per-album assignment. Version 4
# gives each album the artist it certainly matches, with no margin (owner, 2026-11-08).
# Version 5 reads every release's title, partial and typo titles with their tracks,
# other scripts and code pages, and compares a split artist's undecided albums (2026-11-09).
MATCHER_VERSION = 5
# Local "artists" that name no artist: never matched, never a problem.
_PLACEHOLDER_ARTIST_NAMES = ("various artists", "various artist", "various", "va", "v.a.", "v/a",
                             "unknown", "unknown artist", "[unknown]", "artist unknown")
_NOT_PLACEHOLDER_ARTIST_SQL = "lower(btrim(artists.name)) <> all(%(placeholder_names)s::text[])"
# Delivery 1 enriches album artists only: an artist that owns a local album with
# tracks. Track-only artists (Various Artists or guest credits) get their
# identity from release tracklists in the album-identity delivery.
# MusicBrainz writers for one artist run one at a time. An advisory lock keeps that
# off library.local_artists, whose rows are only pinned FOR KEY SHARE: a stronger
# row lock deadlocked with scan upserts of the same artists.
_ARTIST_ENRICHMENT_LOCK_SQL = (
    "select pg_advisory_xact_lock(hashtextextended("
    "'album-haven:musicbrainz-artist:' || %(local_artist_id)s::text, 0))"
)
_PRESENT_ALBUM_ARTIST_SQL = """exists (
          select 1
          from library.local_albums owned_albums
          join library.local_tracks owned_tracks
            on owned_tracks.library_id = owned_albums.library_id
           and owned_tracks.album_id = owned_albums.id
          where owned_albums.library_id = artists.library_id
            and owned_albums.artist_id = artists.id
        )"""
_ALBUM_SIGNALS = frozenset({"year", "track_count", "track_list", "durations"})
_MAX_ALIASES = 24
_MAX_CANDIDATES = 25
_MAX_TAGS = 64
_REVIEW_FIELDS = (
    "local_artist_id",
    "local_artist_name",
    "match_state",
    "artist_mbid",
    "canonical_name",
    "native_name",
    "country",
    "genres",
    "confidence",
    "evidence_summary",
    "unresolved_reason",
    "musicbrainz_url",
    "disambiguation",
    "artist_kind",
    "problem_occurrence_id",
    "problem_reason_code",
    "local_album_count",
    "last_checked_at",
    "last_attempt_at",
    "next_attempt_at",
)
_CANDIDATE_REVIEW_FIELDS = (
    "artist_mbid",
    "canonical_name",
    "native_name",
    "disambiguation",
    "artist_kind",
    "country",
    "confidence",
    "evidence_summary",
    "musicbrainz_url",
)


class MusicBrainzEnrichmentPostgresRepository:
    """Current-library PostgreSQL authority for artist enrichment state."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz enrichment.")
        self._connect = connect or _connect

    def enqueue_eligible_artists(self, *, reason: str, observed_at: datetime) -> dict[str, int]:
        params = {
            "reason": _bounded_text(reason, 128, required=True),
            "observed_at": _aware_utc(observed_at),
            "job_kind": _JOB_KIND,
            # Background triggers re-try a recorded unresolved outcome only after
            # a cool-off; the owner's explicit sync re-tries it immediately.
            "retry_recent_unresolved": reason == _OWNER_SYNC_REASON,
            "matcher_version": MATCHER_VERSION,
            "placeholder_names": list(_PLACEHOLDER_ARTIST_NAMES),
        }
        sql = _active_library_cte() + """
            , placeholder_artists as (
              select artists.id as local_artist_id, active_library.library_id
              from active_library
              join library.local_artists artists
                on artists.library_id = active_library.library_id
              where not (""" + _NOT_PLACEHOLDER_ARTIST_SQL + """)
            ), retired_candidates as (
              delete from library.local_artist_musicbrainz_candidates candidates
              using placeholder_artists
              where candidates.library_id = placeholder_artists.library_id
                and candidates.local_artist_id = placeholder_artists.local_artist_id
                and not exists (
                  select 1 from library.local_artist_musicbrainz_matches manual
                  where manual.library_id = candidates.library_id
                    and manual.local_artist_id = candidates.local_artist_id
                    and manual.decision_source = 'manual')
              returning 1
            ), retired_matches as (
              -- "Various" or "Unknown Artist" is no artist identity: an automatic
              -- outcome for one is withdrawn, an owner's own choice is kept.
              update library.local_artist_musicbrainz_matches matches
              set state = 'not_found', artist_mbid = null, confidence = 0, credit_name = null,
                  album_evidence = null, associated_artist_mbids = null, selected_at = null, last_verified_at = null,
                  evidence_summary = 'Not an artist: a display name such as Various Artists.',
                  updated_at = %(observed_at)s
              from placeholder_artists
              where matches.library_id = placeholder_artists.library_id
                and matches.local_artist_id = placeholder_artists.local_artist_id
                and matches.decision_source <> 'manual'
                and (matches.state <> 'not_found' or matches.artist_mbid is not null)
              returning 1
            ), retired_problems as (
              update library.metadata_enrichment_problems problems
              set lifecycle_state = 'resolved', resolved_at = %(observed_at)s,
                  resolution_source = 'not_an_artist'
              from placeholder_artists
              where problems.library_id = placeholder_artists.library_id
                and problems.local_artist_id = placeholder_artists.local_artist_id
                and problems.target_kind = 'artist'
                and problems.lifecycle_state = 'active'
                and not exists (
                  select 1 from library.local_artist_musicbrainz_matches manual
                  where manual.library_id = problems.library_id
                    and manual.local_artist_id = problems.local_artist_id
                    and manual.decision_source = 'manual')
              returning 1
            ), eligible_artists as (
              select distinct artists.id as local_artist_id, active_library.library_id
              from active_library
              join library.local_artists artists
                on artists.library_id = active_library.library_id
              left join library.local_artist_musicbrainz_matches matches
                on matches.library_id = active_library.library_id
               and matches.local_artist_id = artists.id
              where """ + _PRESENT_ALBUM_ARTIST_SQL + """
                and """ + _NOT_PLACEHOLDER_ARTIST_SQL + """
                and (
                  matches.id is null
                  or (
                    matches.decision_source <> 'manual'
                    and matches.matcher_version < %(matcher_version)s
                  )
                  or (
                    not (matches.decision_source = 'manual')
                    and not (
                      matches.state = 'matched'
                      and matches.last_verified_at is not null
                      and matches.last_verified_at >= %(observed_at)s - interval '30 days'
                    )
                    and (
                      %(retry_recent_unresolved)s
                      or matches.state in ('matched', 'pending')
                      or matches.last_observed_at < %(observed_at)s - interval '7 days'
                    )
                  )
                )
            ), inserted as (
              insert into ops.metadata_enrichment_jobs (
                library_id, local_artist_id, target_kind, job_kind, reason,
                state, next_attempt_at, created_at, updated_at
              )
              select library_id, local_artist_id, 'artist', %(job_kind)s,
                     %(reason)s, 'queued', %(observed_at)s, %(observed_at)s,
                     %(observed_at)s
              from eligible_artists
              on conflict (library_id, local_artist_id, job_kind)
                where state in ('queued', 'leased', 'retry_wait')
              do nothing
              returning 1
            )
            select count(*)::integer as enqueued_count from inserted;
        """
        row = self._execute_one(sql, params)
        return {"enqueued_count": _integer(row.get("enqueued_count"))}

    def enqueue_artist(
        self,
        *,
        local_artist_id: int,
        reason: str,
        observed_at: datetime,
    ) -> dict[str, bool]:
        params = {
            "local_artist_id": _positive_id(local_artist_id),
            "reason": _bounded_text(reason, 128, required=True),
            "observed_at": _aware_utc(observed_at),
            "job_kind": _JOB_KIND,
        }
        sql = _active_library_cte() + """
            , eligible_artist as (
              select artists.id as local_artist_id, active_library.library_id
              from active_library
              join library.local_artists artists
                on artists.library_id = active_library.library_id
               and artists.id = %(local_artist_id)s
            ), inserted as (
              insert into ops.metadata_enrichment_jobs (
                library_id, local_artist_id, target_kind, job_kind, reason,
                state, next_attempt_at, created_at, updated_at
              )
              select library_id, local_artist_id, 'artist', %(job_kind)s,
                     %(reason)s, 'queued', %(observed_at)s, %(observed_at)s,
                     %(observed_at)s
              from eligible_artist
              on conflict (library_id, local_artist_id, job_kind)
                where state in ('queued', 'leased', 'retry_wait')
              do nothing
              returning 1
            )
            select exists (select 1 from inserted) as enqueued;
        """
        return {"enqueued": bool(self._execute_one(sql, params).get("enqueued"))}

    def claim_due_job(
        self,
        *,
        worker_id: str,
        now: datetime,
        lease_duration: timedelta,
    ) -> dict[str, object] | None:
        claimed_at = _aware_utc(now)
        if not isinstance(lease_duration, timedelta) or lease_duration <= timedelta(0):
            raise ValueError("MusicBrainz lease duration must be positive.")
        params = {
            "worker_id": _bounded_text(worker_id, 128, required=True),
            "now": claimed_at,
            "lease_expires_at": claimed_at + lease_duration,
            "job_kind": _JOB_KIND,
        }
        sql = _active_library_cte() + """
            , due_job as (
              select jobs.id
              from ops.metadata_enrichment_jobs jobs
              join active_library on active_library.library_id = jobs.library_id
              where jobs.target_kind = 'artist'
                and jobs.job_kind = %(job_kind)s
                and (
                  (
                    jobs.state in ('queued', 'retry_wait')
                    and jobs.next_attempt_at <= %(now)s
                  )
                  or (
                    jobs.state = 'leased'
                    and jobs.lease_expires_at <= %(now)s
                  )
                )
              order by jobs.priority desc, jobs.next_attempt_at, jobs.id
              for update skip locked
              limit 1
            )
            update ops.metadata_enrichment_jobs jobs
            set state = 'leased',
                lease_owner = %(worker_id)s,
                lease_expires_at = %(lease_expires_at)s,
                attempt_count = jobs.attempt_count + 1,
                updated_at = %(now)s
            from due_job
            where jobs.id = due_job.id
            returning jobs.*;
        """
        row = self._execute_one(sql, params)
        return row or None

    def load_artist_context(
        self,
        *,
        job_id: int,
        worker_id: str,
    ) -> dict[str, object] | None:
        params = {
            "job_id": _positive_id(job_id),
            "worker_id": _bounded_text(worker_id, 128, required=True),
        }
        sql = _active_library_cte() + """
            select
              jobs.id as job_id,
              artists.id as local_artist_id,
              artists.name as local_name,
              coalesce(albums.album_titles, array[]::text[]) as album_titles,
              coalesce(album_evidence.albums, '[]'::json) as albums,
              coalesce(siblings.sibling_matches, '[]'::json) as sibling_matches,
              remote.canonical_name as existing_canonical_name,
              coalesce(identifiers.hinted_artist_mbids, array[]::text[])
                as hinted_artist_mbids,
              assertion.artist_mbid as existing_assertion_mbid,
              assertion.confidence as existing_assertion_confidence,
              matches.artist_mbid::text as existing_artist_mbid,
              matches.state as existing_match_state,
              coalesce(matches.decision_source = 'manual', false) as manual_decision,
              coalesce(remote.refreshed_at >= now() - interval '30 days', false)
                as projection_is_fresh
            from active_library
            join ops.metadata_enrichment_jobs jobs
              on jobs.library_id = active_library.library_id
             and jobs.id = %(job_id)s
             and jobs.target_kind = 'artist'
             and jobs.state = 'leased'
             and jobs.lease_owner = %(worker_id)s
            join library.local_artists artists
              on artists.library_id = active_library.library_id
             and artists.id = jobs.local_artist_id
            left join library.local_artist_musicbrainz_matches matches
              on matches.library_id = active_library.library_id
             and matches.local_artist_id = artists.id
            left join integration.musicbrainz_artists remote
              on remote.mbid = matches.artist_mbid
            left join lateral (
              select array_agg(distinct albums.title order by albums.title)
                as album_titles
              from library.local_albums albums
              where albums.library_id = active_library.library_id
                and albums.artist_id = artists.id
            ) albums on true
            left join lateral (
              -- Album evidence: year, and track titles and durations in order.
              select json_agg(json_build_object(
                       'id', album_rows.id, 'title', album_rows.title, 'year', album_rows.release_year,
                       'lastfm_release_mbid', album_rows.lastfm_release_mbid,
                       'tracks', album_rows.tracks) order by album_rows.title) as albums
              from (
                select local_albums.id, local_albums.title, local_albums.release_year,
                       -- An album-level identifier counts only once its title agrees.
                       case when local_albums.evidence_source = 'lastfm.public.albums'
                            then local_albums.mbid::text end as lastfm_release_mbid,
                       coalesce(json_agg(json_build_object(
                         'title', tracks.title, 'duration_seconds', tracks.duration_seconds)
                         order by coalesce(nullif(tracks.disc_number, 0), 1), tracks.track_number, tracks.title)
                         filter (where tracks.id is not null), '[]'::json) as tracks
                from library.local_albums local_albums
                left join library.local_tracks tracks
                  on tracks.library_id = local_albums.library_id
                 and tracks.album_id = local_albums.id
                where local_albums.library_id = active_library.library_id
                  and local_albums.artist_id = artists.id
                group by local_albums.id, local_albums.title, local_albums.release_year
                -- An album row a rescan left without tracks is no evidence.
                having count(tracks.id) > 0
              ) album_rows
            ) album_evidence on true
            left join lateral (
              -- Matched local artists under another spelling of this name ("The
              -- Devin Townsend Project", "Chick Corea"): their MBID is a candidate,
              -- still decided on this artist's own albums.
              select json_agg(json_build_object(
                       'local_artist_id', sibling_rows.id, 'name', sibling_rows.name,
                       'mbid', sibling_rows.artist_mbid, 'canonical_name', sibling_rows.canonical_name)
                     ) as sibling_matches
              from (
                select siblings.id, siblings.name, sibling_matches.artist_mbid::text as artist_mbid,
                       sibling_remote.canonical_name
                from library.local_artists siblings
                join library.local_artist_musicbrainz_matches sibling_matches
                  on sibling_matches.library_id = siblings.library_id
                 and sibling_matches.local_artist_id = siblings.id
                 and sibling_matches.state = 'matched'
                 and sibling_matches.artist_mbid is not null
                left join integration.musicbrainz_artists sibling_remote
                  on sibling_remote.mbid = sibling_matches.artist_mbid
                where siblings.library_id = active_library.library_id
                  and siblings.id <> artists.id
                  and """ + _loose_name_key_sql("siblings.name") + """ = """ + _loose_name_key_sql("artists.name") + """
                order by siblings.id
                limit 5
              ) sibling_rows
            ) siblings on true
            left join lateral (
              -- A stored local artist MBID (Last.fm) is a search hint, not embedded evidence.
              select array[artists.mbid::text] as hinted_artist_mbids
              where artists.mbid is not null
            ) identifiers on true
            left join lateral (
              select assertions.mbid::text as artist_mbid, assertions.confidence
              from library.local_artist_mbid_assertions assertions
              where assertions.artist_id = artists.id
                and assertions.mbid is not null
                and assertions.mbid_assertion_state in ('confirmed', 'high_confidence')
              order by assertions.confidence desc nulls last,
                       assertions.observed_at desc,
                       assertions.id desc
              limit 1
            ) assertion on true;
        """
        row = self._execute_one(sql, params)
        return row or None

    def schedule_retry(
        self,
        *,
        job_id: int,
        worker_id: str,
        classification: str,
        retry_at: datetime,
        safe_error: str,
        observed_at: datetime,
    ) -> bool:
        params = {
            "job_id": _positive_id(job_id),
            "worker_id": _bounded_text(worker_id, 128, required=True),
            "classification": _bounded_text(classification, 64, required=True),
            "retry_at": _aware_utc(retry_at),
            "safe_error": _bounded_text(safe_error, 1024, required=True),
            "observed_at": _aware_utc(observed_at),
        }
        if params["retry_at"] < params["observed_at"]:
            raise ValueError("MusicBrainz retry time cannot precede the observation time.")
        sql = _active_library_cte() + """
            update ops.metadata_enrichment_jobs jobs
            set state = 'retry_wait',
                next_attempt_at = %(retry_at)s,
                lease_owner = null,
                lease_expires_at = null,
                provider_classification = %(classification)s,
                provider_observed_at = %(observed_at)s,
                last_error = %(safe_error)s,
                updated_at = %(observed_at)s
            from active_library
            where jobs.library_id = active_library.library_id
              and jobs.id = %(job_id)s
              and jobs.target_kind = 'artist'
              and jobs.state = 'leased'
              and jobs.lease_owner = %(worker_id)s
            returning true as updated, jobs.local_artist_id;
        """
        return self._update_job_and_sync_problem(
            sql,
            params,
            provider_reason=_provider_problem_reason(params["classification"]),
            provider_context=params["safe_error"],
        )

    def complete_job(
        self,
        *,
        job_id: int,
        worker_id: str,
        state: str,
        classification: str,
        safe_error: str | None,
        observed_at: datetime,
        preserve_existing: bool,
    ) -> bool:
        terminal_state = str(state or "").strip()
        if terminal_state not in {"succeeded", "needs_review", "exhausted"}:
            raise ValueError("MusicBrainz job completion state is invalid.")
        params = {
            "job_id": _positive_id(job_id),
            "worker_id": _bounded_text(worker_id, 128, required=True),
            "state": terminal_state,
            "classification": _bounded_text(classification, 64, required=True),
            "safe_error": _bounded_text(safe_error, 1024) or None,
            "observed_at": _aware_utc(observed_at),
            "preserve_existing": bool(preserve_existing),
        }
        sql = _active_library_cte() + """
            update ops.metadata_enrichment_jobs jobs
            set state = %(state)s,
                lease_owner = null,
                lease_expires_at = null,
                provider_classification = %(classification)s,
                provider_observed_at = %(observed_at)s,
                last_error = %(safe_error)s,
                completed_at = %(observed_at)s,
                updated_at = %(observed_at)s
            from active_library
            where jobs.library_id = active_library.library_id
              and jobs.id = %(job_id)s
              and jobs.target_kind = 'artist'
              and jobs.state = 'leased'
              and jobs.lease_owner = %(worker_id)s
            returning true as updated, jobs.local_artist_id;
        """
        return self._update_job_and_sync_problem(
            sql,
            params,
            provider_reason=(
                _provider_problem_reason(params["classification"])
                if terminal_state == "exhausted"
                else None
            ),
            provider_context=params["safe_error"] or "MusicBrainz provider attempts were exhausted.",
        )

    def _update_job_and_sync_problem(
        self,
        sql: str,
        params: dict[str, object],
        *,
        provider_reason: str | None,
        provider_context: str,
    ) -> bool:
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                row = _row_mapping(connection.execute(sql, params).fetchone())
                if row.get("updated"):
                    connection.execute(_sync_problem_sql(), _problem_params(
                        local_artist_id=row.get("local_artist_id"),
                        observed_at=params["observed_at"],
                        job_id=params["job_id"],
                        provider_reason=provider_reason,
                        provider_context=provider_context,
                    ))
        return bool(row.get("updated"))

    def replace_candidates(
        self,
        *,
        local_artist_id: int,
        candidates: list[dict[str, object]],
        match_state: str,
        evidence_summary: str,
        observed_at: datetime,
    ) -> int:
        local_artist_id = _positive_id(local_artist_id)
        observed_at = _aware_utc(observed_at)
        normalized = _candidate_rows(candidates)
        params = _candidate_array_params(normalized)
        params.update({
            "local_artist_id": local_artist_id,
            "match_state": _candidate_match_state(match_state),
            "evidence_summary": _bounded_text(evidence_summary, 2048, required=True),
            "observed_at": observed_at,
            "matcher_version": MATCHER_VERSION,
        })
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_ARTIST_ENRICHMENT_LOCK_SQL, params)
                connection.execute(_delete_candidates_sql(), params)
                connection.execute(_upsert_candidate_artists_sql(), params)
                connection.execute(_insert_candidates_sql(), params)
                row = _row_mapping(connection.execute(_upsert_candidate_match_sql(), params).fetchone())
                # A candidate outcome means no album was certain: earlier automatic
                # album identities no longer hold.
                connection.execute(_replace_album_identities_sql(), {**params, "album_identities": "[]"})
                connection.execute(_mark_matcher_version_sql(), params)
                connection.execute(_sync_problem_sql(), _problem_params(
                    local_artist_id=local_artist_id, observed_at=observed_at,
                ))
        return _integer(row.get("candidate_count"))

    def record_automatic_outcome(
        self,
        *,
        local_artist_id: int,
        state: str,
        artist: dict[str, object] | None,
        confidence: float,
        evidence_summary: str,
        observed_at: datetime,
        credit_name: str | None = None,
        album_evidence: list[dict[str, object]] | None = None,
        album_identities: list[dict[str, object]] | None = None,
        identity_artists: list[dict[str, object]] | None = None,
        associated_artist_mbids: list[str] | None = None,
    ) -> dict[str, object]:
        """``album_identities`` are the albums a MusicBrainz artist certainly holds;
        ``identity_artists`` names those artists (a split's, or a person's band)."""
        projection = _artist_projection(artist)
        aliases = projection["aliases"] if projection else []
        tags = projection["tags"] if projection else []
        params = {
            "local_artist_id": _positive_id(local_artist_id),
            "provider_state": _bounded_text(state, 64, required=True),
            "match_state": _automatic_match_state(state, projection),
            "confidence": _confidence(confidence),
            "evidence_summary": _bounded_text(evidence_summary, 2048, required=True),
            "observed_at": _aware_utc(observed_at),
            "credit_name": _bounded_text(credit_name, 512) or None,
            "album_evidence": _album_evidence(album_evidence),
            "associated_artist_mbids": [mbid for mbid in map(_optional_mbid, associated_artist_mbids or ()) if mbid]
            or None,
            "matcher_version": MATCHER_VERSION,
            **_projection_params(projection),
            **_alias_array_params(aliases),
            **_tag_array_params(tags),
        }
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_ARTIST_ENRICHMENT_LOCK_SQL, params)
                row = _row_mapping(connection.execute(_automatic_outcome_sql(), params).fetchone())
                connection.execute(_mark_matcher_version_sql(), params)
                if not row.get("protected"):
                    connection.execute(_upsert_identity_artists_sql(), {
                        **params, "identity_artists": json.dumps([
                            {key: value for key, value in _artist_projection(item, required=True).items()
                             if key not in {"aliases", "tags"}}
                            for item in identity_artists or []])})
                    connection.execute(_replace_album_identities_sql(), {
                        **params, "album_identities": _album_identities(album_identities)})
                connection.execute(_sync_problem_sql(), _problem_params(
                    local_artist_id=params["local_artist_id"], observed_at=params["observed_at"],
                ))
        return row

    def assign_manual_match(
        self,
        *,
        local_artist_id: int,
        actor_account_id: int,
        artist: dict[str, object],
        confidence: float,
        evidence_summary: str,
        observed_at: datetime,
        request_ref: str,
    ) -> bool:
        projection = _artist_projection(artist, required=True)
        params = {
            "local_artist_id": _positive_id(local_artist_id),
            "actor_account_id": _positive_id(actor_account_id),
            "confidence": _confidence(confidence),
            "evidence_summary": _bounded_text(evidence_summary, 2048, required=True),
            "observed_at": _aware_utc(observed_at),
            "request_ref": _bounded_text(request_ref, 512, required=True),
            **_projection_params(projection),
            **_alias_array_params(projection["aliases"]),
            **_tag_array_params(projection["tags"]),
        }
        statements = (
            _manual_artist_sql(),
            _manual_aliases_sql(),
            _manual_country_sql(),
            _manual_tags_sql(),
            _manual_match_sql(),
            _manual_assertion_sql(),
            _manual_audit_sql(),
        )
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_ARTIST_ENRICHMENT_LOCK_SQL, params)
                cursors = [connection.execute(sql, params) for sql in statements]
                result = _row_mapping(cursors[-1].fetchone())
                if result.get("assigned"):
                    connection.execute(_sync_problem_sql(), _problem_params(
                        local_artist_id=params["local_artist_id"], observed_at=params["observed_at"],
                    ))
        return bool(result.get("assigned"))

    def refresh_artist_projection(
        self,
        *,
        local_artist_id: int,
        artist: dict[str, object],
        observed_at: datetime,
    ) -> bool:
        projection = _artist_projection(artist, required=True)
        params = {
            "local_artist_id": _positive_id(local_artist_id),
            "observed_at": _aware_utc(observed_at),
            **_projection_params(projection),
            **_alias_array_params(projection["aliases"]),
            **_tag_array_params(projection["tags"]),
        }
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                connection.execute(_ARTIST_ENRICHMENT_LOCK_SQL, params)
                row = _row_mapping(connection.execute(_refresh_artist_sql(), params).fetchone())
                connection.execute(_refresh_aliases_sql(), params)
                connection.execute(_refresh_country_sql(), params)
                connection.execute(_refresh_tags_sql(), params)
        return bool(row.get("refreshed"))

    def list_present_artist_review(self) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            rows = connection.execute(_artist_review_sql(single_artist=False), {}).fetchall()
        return [_review_row(row) for row in rows]

    def list_artist_attention(self) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            rows = connection.execute(_artist_attention_sql(), {}).fetchall()
        return [_attention_row(row) for row in rows]

    def get_artist_problem(self, *, local_artist_id: int) -> dict[str, object] | None:
        params = {"local_artist_id": _positive_id(local_artist_id)}
        with self._connect(self._database_url) as connection:
            row = connection.execute(_artist_review_sql(single_artist=True), params).fetchone()
            if not row:
                return None
            candidates = connection.execute(_artist_candidates_sql(), params).fetchall()
        result = _review_row(row)
        result["candidates"] = [_candidate_review_row(candidate) for candidate in candidates]
        return result

    def list_accepted_artist_mbids(self) -> list[str]:
        """MBIDs of artists matched automatically or assigned by the owner."""
        with self._connect(self._database_url) as connection:
            rows = connection.execute(
                _active_library_cte() + """
                select distinct matches.artist_mbid::text as artist_mbid
                from library.local_artist_musicbrainz_matches matches
                join active_library on active_library.library_id = matches.library_id
                where matches.state = 'matched' and matches.artist_mbid is not null
                order by 1
                """
            ).fetchall()
        return [str(_row_mapping(row)["artist_mbid"]) for row in rows]

    def refresh_artist_external_links(self, *, artist_mbid: str, discogs_artist_id: object) -> bool:
        """Store a refreshed Discogs link only; the artist's match is not touched."""
        row = self._execute_one(
            """
            with refreshed as (
              update integration.musicbrainz_artists
              set discogs_artist_id = %(discogs_artist_id)s::bigint
              where mbid = %(artist_mbid)s::uuid
                and discogs_artist_id is distinct from %(discogs_artist_id)s::bigint
              returning 1
            )
            select count(*)::integer as changed from refreshed
            """,
            {"artist_mbid": _mbid(artist_mbid), "discogs_artist_id": _discogs_artist_id(discogs_artist_id)},
        )
        return bool(_integer(row.get("changed")))

    def _execute_one(self, sql: str, params: dict[str, object]) -> dict[str, object]:
        with self._connect(self._database_url) as connection:
            row = connection.execute(sql, params).fetchone()
        return _row_mapping(row)


def _connect(database_url: str) -> Any:
    return pooled_connection(database_url, workload="background")


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    return transaction() if callable(transaction) else nullcontext()


def _loose_name_key_sql(column: str) -> str:
    """A name without case, accents, a leading article or punctuation. Only finds
    sibling candidates; the matcher compares their names with its own keys."""
    return (
        "regexp_replace(regexp_replace(regexp_replace(normalize(lower(" + column + "), NFKD), "
        "'[\\u0300-\\u036f]', '', 'g'), '^(the|a|an)[^[:alnum:]]+', ''), '[^[:alnum:]]+', '', 'g')"
    )


def _active_library_cte() -> str:
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
        )
    """


def _authorized_artist_cte() -> str:
    return _active_library_cte() + """
        , authorized_artist as (
          select artists.id as local_artist_id, active_library.library_id
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
          join app.accounts actor
            on actor.id = %(actor_account_id)s
           and actor.is_active is true
           and actor.disabled_at is null
          where artists.id = %(local_artist_id)s
            and (
              exists (
                select 1 from app.bootstrap_owners owner
                where owner.account_id = actor.id
                  and owner.owner_key = 'local-bootstrap-owner'
              )
              or exists (
                select 1 from app.capabilities capability
                where capability.account_id = actor.id
                  and capability.capability_key = 'library.metadata_matches.review'
                  and capability.scope_kind = 'library'
                  and capability.scope_id = active_library.library_id
              )
            )
          for key share of artists
          for update of actor
        )
    """


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


# Approved Delivery 1 issue copy for Problematic Files. ``MBID:`` names identity
# results, including metadata still pending for a matched artist; ``MusicBrainz:``
# names the provider.
_PENDING_REASONS = (
    "musicbrainz_mirror_replication_pending",
    # A matched entity that stops resolving is mirror catch-up; the prior match is kept.
    "musicbrainz_matched_entity_unavailable",
)
PROBLEM_LABELS = {
    "musicbrainz_artist_not_found": "MBID: Not found",
    "musicbrainz_artist_ambiguous": "MBID: Multiple matches",
    "musicbrainz_artist_metadata_conflict": "MBID: Metadata conflict",
    # One artist has the name but no album confirms it.
    "musicbrainz_manual_review_required": "MBID: Unconfirmed match",
    **{reason: "MBID: Metadata pending" for reason in _PENDING_REASONS},
    "musicbrainz_provider_retry_exhausted": "MusicBrainz: Provider unavailable",
}
# Every other app surface, such as the Gallery, says only "Metadata pending".
APP_PROBLEM_LABELS = {**PROBLEM_LABELS, **{reason: "Metadata pending" for reason in _PENDING_REASONS}}


def _problem_label_sql() -> str:
    cases = " ".join(f"when '{reason}' then '{label}'" for reason, label in PROBLEM_LABELS.items())
    return f"case problem.reason_code {cases} else null end"


def _artist_attention_sql() -> str:
    """Present artists with one active problem or an active enrichment job.

    Bounded by the active-problem and active-job indexes rather than scanning
    every artist's review projection.
    """
    return _active_library_cte() + f"""
        , attention as (
          select distinct on (problem.local_artist_id)
            problem.local_artist_id, problem.id as problem_occurrence_id,
            problem.reason_code as problem_reason_code
          from active_library
          join library.metadata_enrichment_problems problem
            on problem.library_id = active_library.library_id
           and problem.target_kind = 'artist'
           and problem.lifecycle_state = 'active'
          order by problem.local_artist_id, problem.last_observed_at desc, problem.id desc
        ), pending as (
          select distinct jobs.local_artist_id
          from active_library
          join ops.metadata_enrichment_jobs jobs
            on jobs.library_id = active_library.library_id
           and jobs.target_kind = 'artist'
           and jobs.state in ('queued', 'leased', 'retry_wait')
          where not exists (select 1 from attention where attention.local_artist_id = jobs.local_artist_id)
        ), wanted as (
          select local_artist_id, problem_occurrence_id, problem_reason_code as reason_code from attention
          union all
          select local_artist_id, null::bigint, null::text from pending
        )
        select
          artists.id as local_artist_id,
          artists.name as local_artist_name,
          case when problem.problem_occurrence_id is null then 'pending' end as match_state,
          problem.problem_occurrence_id,
          problem.reason_code as problem_reason_code,
          {_problem_label_sql()} as unresolved_reason,
          (
            select count(*)::integer
            from library.local_albums local_albums
            where local_albums.library_id = active_library.library_id
              and local_albums.artist_id = artists.id
          ) as local_album_count
        from active_library
        join wanted problem on true
        join library.local_artists artists
          on artists.library_id = active_library.library_id
         and artists.id = problem.local_artist_id
        where {_PRESENT_ALBUM_ARTIST_SQL}
        order by lower(artists.name), artists.id;
    """


def _artist_review_sql(*, single_artist: bool) -> str:
    """Stored-projection review rows for present artists in the current library.

    ``pending`` is reported only while a first lookup is queued or running.
    """
    artist_filter = "and artists.id = %(local_artist_id)s" if single_artist else ""
    return _active_library_cte() + f"""
        select
          artists.id as local_artist_id,
          artists.name as local_artist_name,
          case
            when matches.state is not null then matches.state
            when job.state in ('queued', 'leased') then 'pending'
            else 'unmatched'
          end as match_state,
          matches.artist_mbid::text as artist_mbid,
          remote.canonical_name,
          remote.preferred_native_name as native_name,
          remote.disambiguation,
          remote.artist_kind,
          coalesce(country.country_name, country.country_code) as country,
          coalesce(genres.names, array[]::text[]) as genres,
          coalesce(matches.confidence, 0) as confidence,
          left(coalesce(problem.safe_display_context, matches.evidence_summary,
                        'Awaiting MusicBrainz review.'), 2048) as evidence_summary,
          {_problem_label_sql()} as unresolved_reason,
          problem.id as problem_occurrence_id,
          problem.reason_code as problem_reason_code,
          albums.album_count as local_album_count,
          matches.last_observed_at as last_checked_at,
          job.provider_observed_at as last_attempt_at,
          case when job.state in ('queued', 'retry_wait') then job.next_attempt_at end
            as next_attempt_at,
          case when matches.artist_mbid is not null
            then 'https://musicbrainz.org/artist/' || matches.artist_mbid::text
            else null
          end as musicbrainz_url
        from active_library
        join library.local_artists artists
          on artists.library_id = active_library.library_id
         {artist_filter}
        left join library.local_artist_musicbrainz_matches matches
          on matches.library_id = active_library.library_id
         and matches.local_artist_id = artists.id
        left join integration.musicbrainz_artists remote
          on remote.mbid = matches.artist_mbid
        left join lateral (
          select
            (array_agg(countries.country_code order by countries.country_code))[1] as country_code,
            (array_agg(countries.country_name order by countries.country_code))[1] as country_name
          from integration.musicbrainz_artist_countries countries
          where countries.artist_mbid = matches.artist_mbid
        ) country on true
        left join lateral (
          select array_agg(display.tag_name order by display.display_rank) as names
          from integration.musicbrainz_artist_display_genres display
          where display.artist_mbid = matches.artist_mbid
        ) genres on true
        left join lateral (
          select problems.id, problems.reason_code, problems.safe_display_context
          from library.metadata_enrichment_problems problems
          where problems.library_id = active_library.library_id
            and problems.local_artist_id = artists.id
            and problems.target_kind = 'artist'
            and problems.lifecycle_state = 'active'
          order by problems.last_observed_at desc, problems.id desc
          limit 1
        ) problem on true
        left join lateral (
          select jobs.state, jobs.next_attempt_at, jobs.provider_observed_at
          from ops.metadata_enrichment_jobs jobs
          where jobs.library_id = active_library.library_id
            and jobs.local_artist_id = artists.id
            and jobs.target_kind = 'artist'
          order by jobs.updated_at desc, jobs.id desc
          limit 1
        ) job on true
        left join lateral (
          select count(*)::integer as album_count
          from library.local_albums local_albums
          where local_albums.library_id = active_library.library_id
            and local_albums.artist_id = artists.id
        ) albums on true
        where {_PRESENT_ALBUM_ARTIST_SQL}
        order by lower(artists.name), artists.id;
    """


def _artist_candidates_sql() -> str:
    return _active_library_cte() + """
        select
          candidates.artist_mbid::text as artist_mbid,
          remote.canonical_name,
          remote.preferred_native_name as native_name,
          remote.disambiguation,
          remote.artist_kind,
          coalesce(country.country_name, country.country_code) as country,
          candidates.candidate_score as confidence,
          candidates.evidence_summary,
          'https://musicbrainz.org/artist/' || candidates.artist_mbid::text as musicbrainz_url
        from active_library
        join library.local_artist_musicbrainz_candidates candidates
          on candidates.library_id = active_library.library_id
         and candidates.local_artist_id = %(local_artist_id)s
        join integration.musicbrainz_artists remote
          on remote.mbid = candidates.artist_mbid
        left join lateral (
          select
            (array_agg(countries.country_code order by countries.country_code))[1] as country_code,
            (array_agg(countries.country_name order by countries.country_code))[1] as country_name
          from integration.musicbrainz_artist_countries countries
          where countries.artist_mbid = candidates.artist_mbid
        ) country on true
        order by candidates.candidate_score desc, remote.canonical_name, candidates.artist_mbid;
    """


def _candidate_review_row(row: object) -> dict[str, object]:
    source = _row_mapping(row)
    result = {field: source.get(field) for field in _CANDIDATE_REVIEW_FIELDS}
    result["evidence_summary"] = _bounded_text(result.get("evidence_summary"), 2048)
    return result


_ATTENTION_FIELDS = (
    "local_artist_id",
    "local_artist_name",
    "match_state",
    "problem_occurrence_id",
    "problem_reason_code",
    "unresolved_reason",
    "local_album_count",
)


def _attention_row(row: object) -> dict[str, object]:
    source = _row_mapping(row)
    return {field: source.get(field) for field in _ATTENTION_FIELDS}


def _review_row(row: object) -> dict[str, object]:
    source = _row_mapping(row)
    result = {field: source.get(field) for field in _REVIEW_FIELDS}
    result["evidence_summary"] = _bounded_text(result.get("evidence_summary"), 2048)
    genres = result.get("genres")
    result["genres"] = list(genres)[:3] if isinstance(genres, (list, tuple)) else []
    return result


def _integer(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("MusicBrainz persistence reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("MusicBrainz persistence timestamp must be timezone-aware.")
    return value.astimezone(timezone.utc)


def _bounded_text(value: object, limit: int, *, required: bool = False) -> str:
    text = " ".join(str(value or "").split()).strip()[:limit]
    if required and not text:
        raise ValueError("Required MusicBrainz persistence text is missing.")
    return text


def _country_code(value: object) -> str | None:
    code = _bounded_text(value, 8).upper()
    return code if len(code) == 2 and code.isalpha() else None


def _confidence(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("MusicBrainz confidence is invalid.") from None
    if not 0 <= number <= 1:
        raise ValueError("MusicBrainz confidence is invalid.")
    return number


def _mbid(value: object) -> str:
    text = str(value or "").strip().lower()
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError):
        raise ValueError("MusicBrainz artist identifier is invalid.") from None
    if parsed.int == 0 or str(parsed) != text:
        raise ValueError("MusicBrainz artist identifier is invalid.")
    return text


def _match_state(value: object) -> str:
    state = str(value or "").strip().casefold()
    if state not in {"pending", "matched", "ambiguous", "not_found", "conflict", "manual_review"}:
        raise ValueError("MusicBrainz artist match state is invalid.")
    return state


def _candidate_match_state(value: object) -> str:
    state = _match_state(value)
    if state == "matched":
        raise ValueError("Candidate replacement cannot select an artist match.")
    return state


def _automatic_match_state(state: object, artist: dict[str, object] | None) -> str:
    normalized = str(state or "").strip().casefold()
    if normalized == "matched" and artist:
        return "matched"
    if normalized in {"ambiguous", "not_found", "conflict", "manual_review", "per_album"}:
        return normalized
    return "pending"


def _artist_projection(
    artist: object,
    *,
    required: bool = False,
) -> dict[str, object] | None:
    if not isinstance(artist, Mapping):
        if required:
            raise ValueError("MusicBrainz artist projection is required.")
        return None
    projection = {
        "mbid": _mbid(artist.get("mbid")),
        "canonical_name": _bounded_text(artist.get("canonical_name"), 512, required=True),
        "sort_name": _bounded_text(artist.get("sort_name"), 512) or None,
        "preferred_native_name": _bounded_text(artist.get("preferred_native_name"), 512) or None,
        "artist_kind": _bounded_text(artist.get("artist_type") or artist.get("artist_kind"), 64) or None,
        "disambiguation": _bounded_text(artist.get("disambiguation"), 1024) or None,
        "country_code": _bounded_text(artist.get("country_code"), 8).upper() or None,
        "country_name": _bounded_text(artist.get("country_name"), 128) or None,
        "discogs_artist_id": _discogs_artist_id(artist.get("discogs_artist_id")),
        "aliases": _alias_rows(artist.get("aliases")),
        "tags": _artist_tag_rows(artist),
    }
    if projection["country_code"] and (
        len(str(projection["country_code"])) != 2 or not str(projection["country_code"]).isalpha()
    ):
        projection["country_code"] = None
    return projection


def _alias_rows(value: object) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in value if isinstance(value, list) else []:
        if not isinstance(raw, Mapping):
            continue
        name = _bounded_text(raw.get("name"), 512)
        normalized = _bounded_text(raw.get("normalized") or raw.get("normalized_name"), 512)
        if not name or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        rows.append({
            "name": name,
            "normalized": normalized,
            "sort_name": _bounded_text(raw.get("sort_name"), 512) or None,
            "locale": _bounded_text(raw.get("locale"), 32) or None,
            "kind": _bounded_text(raw.get("type") or raw.get("kind"), 64) or None,
            "primary": bool(raw.get("primary")),
        })
        if len(rows) >= _MAX_ALIASES:
            break
    return rows


def _tag_rows(value: object) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in value if isinstance(value, list) else []:
        if not isinstance(raw, Mapping):
            continue
        name = _bounded_text(raw.get("name"), 256)
        normalized = _bounded_text(raw.get("normalized") or raw.get("normalized_name"), 256)
        if not name or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        rows.append({
            "name": name,
            "normalized": normalized,
            "count": _integer(raw.get("count") if "count" in raw else raw.get("vote_count")),
            "is_genre": bool(raw.get("is_genre")),
        })
        if len(rows) >= _MAX_TAGS:
            break
    return rows


def _artist_tag_rows(artist: Mapping[str, object]) -> list[dict[str, object]]:
    rows = _tag_rows(artist.get("tags"))
    by_name = {str(row["normalized"]): row for row in rows}
    for genre in _tag_rows(artist.get("genres")):
        genre["is_genre"] = True
        existing = by_name.get(str(genre["normalized"]))
        if existing is not None:
            existing["count"] = genre["count"]
            existing["is_genre"] = True
            continue
        if len(rows) >= _MAX_TAGS:
            break
        rows.append(genre)
        by_name[str(genre["normalized"])] = genre
    return rows


def _candidate_rows(value: object) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in value if isinstance(value, list) else []:
        if not isinstance(raw, Mapping):
            continue
        mbid = _mbid(raw.get("artist_mbid") or raw.get("mbid"))
        if mbid in seen:
            continue
        seen.add(mbid)
        raw_score = raw.get("candidate_score") if "candidate_score" in raw else raw.get("score")
        try:
            score = float(raw_score)
        except (TypeError, ValueError):
            raise ValueError("MusicBrainz candidate confidence is invalid.") from None
        if 1 < score <= 100:
            score /= 100
        rows.append({
            "mbid": mbid,
            "canonical_name": _bounded_text(raw.get("canonical_name"), 512, required=True),
            "disambiguation": _bounded_text(raw.get("disambiguation"), 1024) or None,
            "artist_kind": _bounded_text(raw.get("artist_kind") or raw.get("artist_type"), 64) or None,
            "country_code": _country_code(raw.get("country_code")),
            "score": _confidence(score),
            "evidence": _bounded_text(raw.get("evidence_summary"), 2048, required=True),
            "rejection": _bounded_text(raw.get("rejection_reason"), 512) or None,
        })
        if len(rows) >= _MAX_CANDIDATES:
            break
    return rows


def _projection_params(projection: dict[str, object] | None) -> dict[str, object]:
    projection = projection or {}
    return {
        "artist_mbid": projection.get("mbid"),
        "canonical_name": projection.get("canonical_name"),
        "sort_name": projection.get("sort_name"),
        "preferred_native_name": projection.get("preferred_native_name"),
        "artist_kind": projection.get("artist_kind"),
        "disambiguation": projection.get("disambiguation"),
        "country_code": projection.get("country_code"),
        "country_name": projection.get("country_name"),
        "discogs_artist_id": projection.get("discogs_artist_id"),
    }


def _discogs_artist_id(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 999_999_999_999 else None


def _alias_array_params(rows: list[dict[str, object]]) -> dict[str, object]:
    return {
        "alias_names": [row["name"] for row in rows],
        "alias_normalized": [row["normalized"] for row in rows],
        "alias_sort_names": [row["sort_name"] for row in rows],
        "alias_locales": [row["locale"] for row in rows],
        "alias_kinds": [row["kind"] for row in rows],
        "alias_primary": [row["primary"] for row in rows],
    }


def _tag_array_params(rows: list[dict[str, object]]) -> dict[str, object]:
    return {
        "tag_names": [row["name"] for row in rows],
        "tag_normalized": [row["normalized"] for row in rows],
        "tag_counts": [row["count"] for row in rows],
        "tag_is_genre": [row["is_genre"] for row in rows],
    }


def _candidate_array_params(rows: list[dict[str, object]]) -> dict[str, object]:
    return {
        "candidate_mbids": [row["mbid"] for row in rows],
        "candidate_names": [row["canonical_name"] for row in rows],
        "candidate_disambiguations": [row["disambiguation"] for row in rows],
        "candidate_kinds": [row["artist_kind"] for row in rows],
        "candidate_countries": [row["country_code"] for row in rows],
        "candidate_scores": [row["score"] for row in rows],
        "candidate_evidence": [row["evidence"] for row in rows],
        "candidate_rejections": [row["rejection"] for row in rows],
    }


_PROVIDER_PROBLEM_REASONS = {
    "catch_up_pending": "musicbrainz_mirror_replication_pending",
    "provider_unavailable": "musicbrainz_provider_retry_exhausted",
    "rate_limited": "musicbrainz_provider_retry_exhausted",
}


def _album_evidence(evidence: object) -> str | None:
    """The albums behind a credited-name or disc match, as stored JSON."""
    if not isinstance(evidence, list):
        return None
    rows = []
    for item in evidence[:64]:
        if not isinstance(item, Mapping):
            continue
        rows.append({
            "local_album_id": _integer(item.get("local_album_id")) or None,
            "local_title": _bounded_text(item.get("local_title"), 512) or None,
            "release_group_mbid": _optional_mbid(item.get("release_group_mbid")),
            "release_mbid": _optional_mbid(item.get("release_mbid")),
            "disc_position": _integer(item.get("disc_position")) or None,
            "signals": sorted({str(signal) for signal in item.get("signals") or ()
                               if str(signal) in _ALBUM_SIGNALS}),
        })
    return json.dumps(rows) if rows else None


def _album_identities(identities: object) -> str:
    """The albums a MusicBrainz artist certainly holds, as JSON rows for the identity table."""
    rows = []
    for item in identities if isinstance(identities, list) else []:
        if not isinstance(item, Mapping):
            continue
        album_id, artist_mbid = _integer(item.get("local_album_id")), _optional_mbid(item.get("artist_mbid"))
        if not album_id or not artist_mbid:
            continue
        rows.append({
            "local_album_id": album_id, "artist_mbid": artist_mbid, "tag_differs": bool(item.get("tag_differs")),
            "evidence": {
                "local_title": _bounded_text(item.get("local_title"), 512) or None,
                "release_group_mbid": _optional_mbid(item.get("release_group_mbid")),
                "release_mbid": _optional_mbid(item.get("release_mbid")),
                "disc_position": _integer(item.get("disc_position")) or None,
                "signals": sorted({str(signal) for signal in item.get("signals") or () if str(signal) in _ALBUM_SIGNALS}),
            },
        })
    return json.dumps(rows)


def _optional_mbid(value: object) -> str | None:
    try:
        return _mbid(value) if value else None
    except ValueError:
        return None


def _provider_problem_reason(classification: object) -> str | None:
    return _PROVIDER_PROBLEM_REASONS.get(str(classification or ""))


def _problem_params(
    *,
    local_artist_id: object,
    observed_at: datetime,
    job_id: object = None,
    provider_reason: str | None = None,
    provider_context: str = "MusicBrainz evidence requires review.",
) -> dict[str, object]:
    return {
        "local_artist_id": _positive_id(local_artist_id),
        "observed_at": observed_at,
        "job_id": _positive_id(job_id) if job_id is not None else None,
        "provider_reason": provider_reason,
        "provider_context": _bounded_text(provider_context, 2048, required=True),
    }


def _sync_problem_sql() -> str:
    """Make the artist's active MI-02 problem follow its stored match.

    Identity outcomes come from the match row as written, so a protected
    manual or matched decision never opens a problem. Provider and mirror
    catch-up problems open only while no durable identity outcome exists.
    A matched artist resolves every active problem.
    """
    return _active_library_cte() + """
        , desired as (
          select
            active_library.library_id,
            artists.id as local_artist_id,
            matches.state as match_state,
            matches.decision_source,
            case
              when matches.state = 'not_found' then 'musicbrainz_artist_not_found'
              when matches.state = 'ambiguous' then 'musicbrainz_artist_ambiguous'
              when matches.state = 'conflict' then 'musicbrainz_artist_metadata_conflict'
              when matches.state = 'manual_review' then 'musicbrainz_manual_review_required'
              when matches.state is null or matches.state = 'pending'
                then %(provider_reason)s::text
              else null
            end as reason_code,
            left(
              case
                when matches.state in ('not_found', 'ambiguous', 'conflict', 'manual_review')
                  then matches.evidence_summary
                else %(provider_context)s
              end,
              2048
            ) as safe_display_context,
            (
              select count(*)::integer
              from library.local_artist_musicbrainz_candidates candidates
              where candidates.library_id = active_library.library_id
                and candidates.local_artist_id = artists.id
            ) as candidate_count
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
           and artists.id = %(local_artist_id)s
          left join library.local_artist_musicbrainz_matches matches
            on matches.library_id = active_library.library_id
           and matches.local_artist_id = artists.id
        ), resolved as (
          update library.metadata_enrichment_problems problems
          set lifecycle_state = 'resolved',
              resolved_at = %(observed_at)s,
              resolution_source = case
                when desired.match_state = 'matched'
                  then coalesce(desired.decision_source, 'automatic') || '_match'
                when desired.match_state = 'per_album' then 'automatic_per_album'
                else 'reclassified'
              end
          from desired
          where problems.library_id = desired.library_id
            and problems.local_artist_id = desired.local_artist_id
            and problems.target_kind = 'artist'
            and problems.lifecycle_state = 'active'
            and problems.reason_code is distinct from desired.reason_code
            and (desired.match_state in ('matched', 'per_album') or desired.reason_code is not null)
          returning problems.id
        )
        insert into library.metadata_enrichment_problems (
          library_id, local_artist_id, target_kind, reason_code, lifecycle_state,
          safe_display_context, candidate_count, related_job_id, observed_at,
          first_observed_at, last_observed_at
        )
        select desired.library_id, desired.local_artist_id, 'artist', desired.reason_code,
               'active', desired.safe_display_context, desired.candidate_count,
               %(job_id)s, %(observed_at)s, %(observed_at)s, %(observed_at)s
        from desired
        where desired.reason_code is not null
        on conflict (library_id, local_artist_id, reason_code) where lifecycle_state = 'active'
        do update set
          safe_display_context = excluded.safe_display_context,
          candidate_count = excluded.candidate_count,
          related_job_id = coalesce(
            excluded.related_job_id,
            library.metadata_enrichment_problems.related_job_id
          ),
          observed_at = excluded.observed_at,
          last_observed_at = excluded.last_observed_at;
    """


def _upsert_identity_artists_sql() -> str:
    """The MusicBrainz artists a split artist's albums belong to, so their identities resolve."""
    return """
        insert into integration.musicbrainz_artists (
          mbid, canonical_name, sort_name, preferred_native_name, artist_kind,
          disambiguation, discogs_artist_id, refreshed_at, created_at, updated_at
        )
        select rows.mbid, rows.canonical_name, rows.sort_name, rows.preferred_native_name, rows.artist_kind,
               rows.disambiguation, rows.discogs_artist_id, %(observed_at)s, %(observed_at)s, %(observed_at)s
        from jsonb_to_recordset(%(identity_artists)s::jsonb) as rows(
          mbid uuid, canonical_name text, sort_name text, preferred_native_name text, artist_kind text,
          disambiguation text, discogs_artist_id bigint)
        on conflict (mbid) do update
        -- A listing from album credits alone never blanks what a full lookup stored.
        set canonical_name = excluded.canonical_name,
            sort_name = coalesce(excluded.sort_name, integration.musicbrainz_artists.sort_name),
            artist_kind = coalesce(excluded.artist_kind, integration.musicbrainz_artists.artist_kind),
            disambiguation = coalesce(excluded.disambiguation, integration.musicbrainz_artists.disambiguation),
            updated_at = excluded.updated_at;
    """


def _replace_album_identities_sql() -> str:
    """An artist's automatic album identities become exactly this re-check's certain albums;
    an owner's own album choice is kept."""
    return _active_library_cte() + """
        , artist_albums as (
          select albums.id, albums.library_id, albums.album_key
          from active_library
          join library.local_albums albums
            on albums.library_id = active_library.library_id
           and albums.artist_id = %(local_artist_id)s
        ), removed as (
          delete from library.local_album_artist_identities identities
          using artist_albums
          where identities.library_id = artist_albums.library_id
            and identities.album_key = artist_albums.album_key
            and identities.decision_source = 'automatic'
          returning 1
        )
        insert into library.local_album_artist_identities (
          library_id, album_key, artist_mbid, decision_source, evidence, tag_differs,
          matcher_version, created_at, updated_at
        )
        select artist_albums.library_id, artist_albums.album_key, rows.artist_mbid, 'automatic',
               rows.evidence, rows.tag_differs, %(matcher_version)s, %(observed_at)s, %(observed_at)s
        from (select count(*) from removed) removed_count
        cross join jsonb_to_recordset(%(album_identities)s::jsonb)
          as rows(local_album_id bigint, artist_mbid uuid, tag_differs boolean, evidence jsonb)
        join artist_albums on artist_albums.id = rows.local_album_id
        on conflict (library_id, album_key) do update
        set artist_mbid = excluded.artist_mbid,
            evidence = excluded.evidence,
            tag_differs = excluded.tag_differs,
            matcher_version = excluded.matcher_version,
            updated_at = excluded.updated_at
        where library.local_album_artist_identities.decision_source <> 'manual';
    """


def _delete_candidates_sql() -> str:
    return _active_library_cte() + """
        , active_artist as (
          select artists.id, active_library.library_id
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
           and artists.id = %(local_artist_id)s
          for key share of artists
        )
        delete from library.local_artist_musicbrainz_candidates candidates
        using active_artist
        where candidates.library_id = active_artist.library_id
          and candidates.local_artist_id = active_artist.id;
    """


def _upsert_candidate_artists_sql() -> str:
    return _active_library_cte() + """
        , active_artist as (
          select artists.id
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
           and artists.id = %(local_artist_id)s
        )
        , candidate_rows as (
          select rows.*
          from active_artist
          cross join unnest(
            %(candidate_mbids)s::uuid[], %(candidate_names)s::text[],
            %(candidate_disambiguations)s::text[], %(candidate_kinds)s::text[],
            %(candidate_countries)s::text[]
          ) as rows(mbid, canonical_name, disambiguation, artist_kind, country_code)
        ), upserted as (
          insert into integration.musicbrainz_artists (
            mbid, canonical_name, disambiguation, artist_kind,
            refreshed_at, created_at, updated_at
          )
          select mbid, canonical_name, disambiguation, artist_kind,
                 %(observed_at)s, %(observed_at)s, %(observed_at)s
          from candidate_rows
          on conflict (mbid) do update
          set canonical_name = excluded.canonical_name,
              disambiguation = coalesce(excluded.disambiguation, integration.musicbrainz_artists.disambiguation),
              artist_kind = coalesce(excluded.artist_kind, integration.musicbrainz_artists.artist_kind),
              refreshed_at = excluded.refreshed_at,
              updated_at = excluded.updated_at
          returning mbid
        )
        insert into integration.musicbrainz_artist_countries (
          artist_mbid, country_code, provenance, observed_at
        )
        select candidate_rows.mbid, candidate_rows.country_code,
               'musicbrainz_lookup', %(observed_at)s
        from candidate_rows
        join upserted on upserted.mbid = candidate_rows.mbid
        where candidate_rows.country_code is not null
        on conflict (artist_mbid, country_code) do nothing;
    """


def _insert_candidates_sql() -> str:
    return _active_library_cte() + """
        insert into library.local_artist_musicbrainz_candidates (
          library_id, local_artist_id, artist_mbid, candidate_score,
          evidence_summary, rejection_reason, observed_at
        )
        select active_library.library_id, artists.id, rows.mbid, rows.score,
               rows.evidence, rows.rejection, %(observed_at)s
        from active_library
        join library.local_artists artists
          on artists.library_id = active_library.library_id
         and artists.id = %(local_artist_id)s
        cross join unnest(
          %(candidate_mbids)s::uuid[], %(candidate_scores)s::numeric[],
          %(candidate_evidence)s::text[], %(candidate_rejections)s::text[]
        ) as rows(mbid, score, evidence, rejection);
    """


def _upsert_candidate_match_sql() -> str:
    return _active_library_cte() + """
        , upserted as (
          insert into library.local_artist_musicbrainz_matches (
            library_id, local_artist_id, state, decision_source, confidence,
            evidence_summary, provider_classification, provider_observed_at,
            first_observed_at, last_observed_at, created_at, updated_at
          )
          select active_library.library_id, artists.id, %(match_state)s,
                 'automatic', 0, %(evidence_summary)s, %(match_state)s,
                 %(observed_at)s, %(observed_at)s, %(observed_at)s,
                 %(observed_at)s, %(observed_at)s
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
           and artists.id = %(local_artist_id)s
          on conflict (library_id, local_artist_id) do update
          set state = excluded.state,
              associated_artist_mbids = null,
              confidence = excluded.confidence,
              evidence_summary = excluded.evidence_summary,
              provider_classification = excluded.provider_classification,
              provider_observed_at = excluded.provider_observed_at,
              last_observed_at = excluded.last_observed_at,
              updated_at = excluded.updated_at
          where library.local_artist_musicbrainz_matches.decision_source <> 'manual'
            and not (
              library.local_artist_musicbrainz_matches.state = 'matched'
              and library.local_artist_musicbrainz_matches.artist_mbid is not null
              and %(match_state)s <> 'conflict'
            )
          returning 1
        )
        select count(*)::integer as candidate_count
        from library.local_artist_musicbrainz_candidates candidates
        join active_library on active_library.library_id = candidates.library_id
        where candidates.local_artist_id = %(local_artist_id)s;
    """


def _mark_matcher_version_sql() -> str:
    """Record that the current matcher decided (or confirmed) an automatic row,
    including a protected match the new evidence left in place."""
    return _active_library_cte() + """
        update library.local_artist_musicbrainz_matches matches
        set matcher_version = %(matcher_version)s
        from active_library
        where matches.library_id = active_library.library_id
          and matches.local_artist_id = %(local_artist_id)s
          and matches.decision_source <> 'manual'
          and matches.matcher_version < %(matcher_version)s;
    """


def _automatic_outcome_sql() -> str:
    return _active_library_cte() + """
        , active_artist as (
          select artists.id, active_library.library_id,
                 """ + _PRESENT_ALBUM_ARTIST_SQL + """ as is_present
          from active_library
          join library.local_artists artists
            on artists.library_id = active_library.library_id
           and artists.id = %(local_artist_id)s
          for key share of artists
        ), upsert_artist as (
          insert into integration.musicbrainz_artists (
            mbid, canonical_name, sort_name, preferred_native_name, artist_kind,
            disambiguation, discogs_artist_id, refreshed_at, created_at, updated_at
          )
          select %(artist_mbid)s::uuid, %(canonical_name)s, %(sort_name)s,
                 %(preferred_native_name)s, %(artist_kind)s, %(disambiguation)s,
                 %(discogs_artist_id)s::bigint, %(observed_at)s, %(observed_at)s, %(observed_at)s
          from active_artist
          where %(artist_mbid)s::uuid is not null
          on conflict (mbid) do update
          set canonical_name = excluded.canonical_name,
              sort_name = excluded.sort_name,
              preferred_native_name = excluded.preferred_native_name,
              artist_kind = excluded.artist_kind,
              disambiguation = excluded.disambiguation,
              discogs_artist_id = excluded.discogs_artist_id,
              refreshed_at = excluded.refreshed_at,
              updated_at = excluded.updated_at
          returning mbid
        ), removed_aliases as (
          delete from integration.musicbrainz_artist_aliases aliases
          using upsert_artist
          where aliases.artist_mbid = upsert_artist.mbid
          returning 1
        ), inserted_aliases as (
          insert into integration.musicbrainz_artist_aliases (
            artist_mbid, alias_name, alias_normalized, sort_name, locale,
            alias_kind, is_primary_for_locale, provenance, observed_at
          )
          select upsert_artist.mbid, rows.name, rows.normalized, rows.sort_name,
                 rows.locale, rows.kind, rows.is_primary, 'musicbrainz',
                 %(observed_at)s
          from upsert_artist
          cross join (select count(*) from removed_aliases) removed
          cross join unnest(
            %(alias_names)s::text[], %(alias_normalized)s::text[],
            %(alias_sort_names)s::text[], %(alias_locales)s::text[],
            %(alias_kinds)s::text[], %(alias_primary)s::boolean[]
          ) as rows(name, normalized, sort_name, locale, kind, is_primary)
          returning 1
        ), removed_countries as (
          delete from integration.musicbrainz_artist_countries countries
          using upsert_artist
          where countries.artist_mbid = upsert_artist.mbid
          returning 1
        ), inserted_country as (
          insert into integration.musicbrainz_artist_countries (
            artist_mbid, country_code, country_name, provenance, observed_at
          )
          select upsert_artist.mbid, %(country_code)s, %(country_name)s,
                 'musicbrainz', %(observed_at)s
          from upsert_artist
          cross join (select count(*) from removed_countries) removed
          where %(country_code)s::text is not null
          returning 1
        ), removed_tags as (
          delete from integration.musicbrainz_artist_tags tags
          using upsert_artist
          where tags.artist_mbid = upsert_artist.mbid
          returning 1
        ), inserted_tags as (
          insert into integration.musicbrainz_artist_tags (
            artist_mbid, tag_name, tag_normalized, vote_count, is_genre,
            provenance, observed_at
          )
          select upsert_artist.mbid, rows.name, rows.normalized, rows.vote_count,
                 rows.is_genre, 'musicbrainz', %(observed_at)s
          from upsert_artist
          cross join (select count(*) from removed_tags) removed
          cross join unnest(
            %(tag_names)s::text[], %(tag_normalized)s::text[],
            %(tag_counts)s::integer[], %(tag_is_genre)s::boolean[]
          ) as rows(name, normalized, vote_count, is_genre)
          returning 1
        ), upsert_match as (
          insert into library.local_artist_musicbrainz_matches (
            library_id, local_artist_id, artist_mbid, state, decision_source,
            confidence, evidence_summary, selected_at, last_verified_at,
            provider_classification, provider_observed_at, first_observed_at,
            last_observed_at, created_at, updated_at, credit_name, album_evidence,
            associated_artist_mbids
          )
          select active_artist.library_id, active_artist.id,
                 (select mbid from upsert_artist), %(match_state)s, 'automatic',
                 %(confidence)s, %(evidence_summary)s,
                 case when %(match_state)s = 'matched' then %(observed_at)s else null end,
                 case when %(match_state)s = 'matched' then %(observed_at)s else null end,
                 %(provider_state)s, %(observed_at)s, %(observed_at)s,
                 %(observed_at)s, %(observed_at)s, %(observed_at)s,
                 case when %(match_state)s = 'matched' then %(credit_name)s else null end,
                 case when %(match_state)s = 'matched' then %(album_evidence)s::jsonb else null end,
                 case when %(match_state)s = 'matched' then %(associated_artist_mbids)s::uuid[] else null end
          from active_artist
          where active_artist.is_present or %(provider_state)s = 'not_present'
          on conflict (library_id, local_artist_id) do update
          set artist_mbid = excluded.artist_mbid,
              state = excluded.state,
              credit_name = excluded.credit_name,
              album_evidence = excluded.album_evidence,
              associated_artist_mbids = excluded.associated_artist_mbids,
              confidence = excluded.confidence,
              evidence_summary = excluded.evidence_summary,
              selected_at = excluded.selected_at,
              last_verified_at = excluded.last_verified_at,
              provider_classification = excluded.provider_classification,
              provider_observed_at = excluded.provider_observed_at,
              last_observed_at = excluded.last_observed_at,
              updated_at = excluded.updated_at
          where library.local_artist_musicbrainz_matches.decision_source <> 'manual'
            and not (
              library.local_artist_musicbrainz_matches.state = 'matched'
              and library.local_artist_musicbrainz_matches.artist_mbid is not null
              and %(match_state)s not in ('matched', 'per_album')
            )
          returning 1
        )
        select
          exists (
            select 1
            from library.local_artist_musicbrainz_matches protected_match
            join active_artist
              on active_artist.library_id = protected_match.library_id
             and active_artist.id = protected_match.local_artist_id
            where protected_match.decision_source = 'manual'
          )
          or not exists (select 1 from upsert_match) as protected;
    """


def _manual_artist_sql() -> str:
    return _authorized_artist_cte() + """
        insert into integration.musicbrainz_artists (
          mbid, canonical_name, sort_name, preferred_native_name, artist_kind,
          disambiguation, discogs_artist_id, refreshed_at, created_at, updated_at
        )
        select %(artist_mbid)s::uuid, %(canonical_name)s, %(sort_name)s,
               %(preferred_native_name)s, %(artist_kind)s, %(disambiguation)s,
               %(discogs_artist_id)s::bigint, %(observed_at)s, %(observed_at)s, %(observed_at)s
        from authorized_artist
        on conflict (mbid) do update
        set canonical_name = excluded.canonical_name,
            sort_name = excluded.sort_name,
            preferred_native_name = excluded.preferred_native_name,
            artist_kind = excluded.artist_kind,
            disambiguation = excluded.disambiguation,
            discogs_artist_id = excluded.discogs_artist_id,
            refreshed_at = excluded.refreshed_at,
            updated_at = excluded.updated_at;
    """


def _matched_artist_cte() -> str:
    return _active_library_cte() + """
        , matched_artist as (
          select matches.artist_mbid
          from active_library
          join library.local_artist_musicbrainz_matches matches
            on matches.library_id = active_library.library_id
           and matches.local_artist_id = %(local_artist_id)s
           and matches.state = 'matched'
           and matches.artist_mbid = %(artist_mbid)s::uuid
        )
    """


def _refresh_artist_sql() -> str:
    return _matched_artist_cte() + """
        insert into integration.musicbrainz_artists (
          mbid, canonical_name, sort_name, preferred_native_name, artist_kind,
          disambiguation, discogs_artist_id, refreshed_at, created_at, updated_at
        )
        select artist_mbid, %(canonical_name)s, %(sort_name)s,
               %(preferred_native_name)s, %(artist_kind)s, %(disambiguation)s,
               %(discogs_artist_id)s::bigint, %(observed_at)s, %(observed_at)s, %(observed_at)s
        from matched_artist
        on conflict (mbid) do update
        set canonical_name = excluded.canonical_name,
            sort_name = excluded.sort_name,
            preferred_native_name = excluded.preferred_native_name,
            artist_kind = excluded.artist_kind,
            disambiguation = excluded.disambiguation,
            discogs_artist_id = excluded.discogs_artist_id,
            refreshed_at = excluded.refreshed_at,
            updated_at = excluded.updated_at
        returning true as refreshed;
    """


def _refresh_aliases_sql() -> str:
    return _matched_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_aliases aliases
          using matched_artist
          where aliases.artist_mbid = matched_artist.artist_mbid
          returning 1
        )
        insert into integration.musicbrainz_artist_aliases (
          artist_mbid, alias_name, alias_normalized, sort_name, locale,
          alias_kind, is_primary_for_locale, provenance, observed_at
        )
        select matched_artist.artist_mbid, rows.name, rows.normalized,
               rows.sort_name, rows.locale, rows.kind, rows.is_primary,
               'musicbrainz', %(observed_at)s
        from matched_artist
        cross join (select count(*) from removed) removed_count
        cross join unnest(
          %(alias_names)s::text[], %(alias_normalized)s::text[],
          %(alias_sort_names)s::text[], %(alias_locales)s::text[],
          %(alias_kinds)s::text[], %(alias_primary)s::boolean[]
        ) as rows(name, normalized, sort_name, locale, kind, is_primary);
    """


def _refresh_country_sql() -> str:
    return _matched_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_countries countries
          using matched_artist
          where countries.artist_mbid = matched_artist.artist_mbid
          returning 1
        )
        insert into integration.musicbrainz_artist_countries (
          artist_mbid, country_code, country_name, provenance, observed_at
        )
        select matched_artist.artist_mbid, %(country_code)s, %(country_name)s,
               'musicbrainz', %(observed_at)s
        from matched_artist
        cross join (select count(*) from removed) removed_count
        where %(country_code)s::text is not null;
    """


def _refresh_tags_sql() -> str:
    return _matched_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_tags tags
          using matched_artist
          where tags.artist_mbid = matched_artist.artist_mbid
          returning 1
        )
    """ + _insert_artist_tags_sql(source="matched_artist", barrier="removed")


def _manual_aliases_sql() -> str:
    return _authorized_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_aliases aliases
          using authorized_artist
          where aliases.artist_mbid = %(artist_mbid)s::uuid
          returning 1
        )
        insert into integration.musicbrainz_artist_aliases (
          artist_mbid, alias_name, alias_normalized, sort_name, locale,
          alias_kind, is_primary_for_locale, provenance, observed_at
        )
        select %(artist_mbid)s::uuid, rows.name, rows.normalized,
               rows.sort_name, rows.locale, rows.kind, rows.is_primary,
               'musicbrainz', %(observed_at)s
        from authorized_artist
        cross join (select count(*) from removed) removed_count
        cross join unnest(
          %(alias_names)s::text[], %(alias_normalized)s::text[],
          %(alias_sort_names)s::text[], %(alias_locales)s::text[],
          %(alias_kinds)s::text[], %(alias_primary)s::boolean[]
        ) as rows(name, normalized, sort_name, locale, kind, is_primary);
    """


def _manual_country_sql() -> str:
    return _authorized_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_countries countries
          using authorized_artist
          where countries.artist_mbid = %(artist_mbid)s::uuid
          returning 1
        )
        insert into integration.musicbrainz_artist_countries (
          artist_mbid, country_code, country_name, provenance, observed_at
        )
        select %(artist_mbid)s::uuid, %(country_code)s, %(country_name)s,
               'musicbrainz', %(observed_at)s
        from authorized_artist
        cross join (select count(*) from removed) removed_count
        where %(country_code)s::text is not null;
    """


def _manual_tags_sql() -> str:
    return _authorized_artist_cte() + """
        , removed as (
          delete from integration.musicbrainz_artist_tags tags
          using authorized_artist
          where tags.artist_mbid = %(artist_mbid)s::uuid
          returning 1
        )
    """ + _insert_artist_tags_sql(source="authorized_artist", barrier="removed")


def _manual_match_sql() -> str:
    return _authorized_artist_cte() + """
        insert into library.local_artist_musicbrainz_matches (
          library_id, local_artist_id, artist_mbid, state, decision_source,
          confidence, evidence_summary, selected_at, decided_by_account_id,
          last_verified_at, provider_classification, provider_observed_at,
          first_observed_at, last_observed_at, created_at, updated_at
        )
        select library_id, local_artist_id, %(artist_mbid)s::uuid, 'matched',
               'manual', %(confidence)s, %(evidence_summary)s, %(observed_at)s,
               %(actor_account_id)s, %(observed_at)s, 'manual', %(observed_at)s,
               %(observed_at)s, %(observed_at)s, %(observed_at)s, %(observed_at)s
        from authorized_artist
        on conflict (library_id, local_artist_id) do update
        set artist_mbid = excluded.artist_mbid,
            state = 'matched',
            decision_source = 'manual',
            associated_artist_mbids = null,
            confidence = excluded.confidence,
            evidence_summary = excluded.evidence_summary,
            selected_at = excluded.selected_at,
            decided_by_account_id = excluded.decided_by_account_id,
            last_verified_at = excluded.last_verified_at,
            provider_classification = excluded.provider_classification,
            provider_observed_at = excluded.provider_observed_at,
            last_observed_at = excluded.last_observed_at,
            updated_at = excluded.updated_at;
    """


def _manual_assertion_sql() -> str:
    return _authorized_artist_cte() + """
        insert into library.local_artist_mbid_assertions (
          artist_id, evidence_source, mbid, mbid_assertion_state, confidence,
          explanation, observed_at, source_payload
        )
        select local_artist_id, 'manual_musicbrainz_review', %(artist_mbid)s::uuid,
               'confirmed', %(confidence)s, %(evidence_summary)s,
               %(observed_at)s, '{}'::jsonb
        from authorized_artist;
    """


def _manual_audit_sql() -> str:
    return _authorized_artist_cte() + """
        , audited as (
          insert into app.security_audit_events (
            actor_account_id, target_account_id, event_category, outcome,
            reason_code, request_ref, occurred_at, metadata
          )
          select %(actor_account_id)s, %(actor_account_id)s,
                 'library_metadata_match', 'success',
                 'musicbrainz_artist_manual_assignment', %(request_ref)s,
                 %(observed_at)s,
                 jsonb_build_object('local_artist_id', local_artist_id,
                                    'artist_mbid', %(artist_mbid)s::text)
          from authorized_artist
          returning 1
        )
        select exists (select 1 from audited) as assigned;
    """


def _insert_artist_tags_sql(
    *,
    source: str | None = None,
    barrier: str | None = None,
) -> str:
    if source:
        barrier_sql = f"cross join (select count(*) from {barrier}) barrier_count " if barrier else ""
        source_sql = f"from {source} {barrier_sql}cross join "
    else:
        source_sql = "from "
    return f"""
        insert into integration.musicbrainz_artist_tags (
          artist_mbid, tag_name, tag_normalized, vote_count, is_genre,
          provenance, observed_at
        )
        select %(artist_mbid)s::uuid, rows.name, rows.normalized, rows.vote_count,
               rows.is_genre, 'musicbrainz', %(observed_at)s
        {source_sql}unnest(
          %(tag_names)s::text[], %(tag_normalized)s::text[],
          %(tag_counts)s::integer[], %(tag_is_genre)s::boolean[]
        ) as rows(name, normalized, vote_count, is_genre);
    """
