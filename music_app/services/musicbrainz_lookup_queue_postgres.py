"""PostgreSQL authority for the owner's manual MusicBrainz lookups (Delivery 2, S5).

A lookup names one local artist or one local album. It runs as a job in the shared
enrichment queue (``ops.metadata_enrichment_jobs``) at manual priority, so it goes before
the sync backlog: an artist lookup is the artist's own enrichment job, an album lookup
re-resolves its artist's albums. "Queue" lookups wait together and start as one batch when
the oldest is an hour old or the owner runs Library -> MusicBrainz sync; a "Search" starts
at once in a batch of its own. Each batch is one notification card, and every request keeps
its result: the MBID found, or the Problematic Files label saying why not.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from music_app.services.musicbrainz_enrichment_postgres import (
    _JOB_KIND as ARTIST_JOB_KIND,
    _active_library_cte,
    _aware_utc,
    _connect,
    _positive_id,
    _problem_label_sql,
    _row_mapping,
    _transaction,
)
from music_app.services.musicbrainz_release_identity_postgres import JOB_KIND as ALBUM_JOB_KIND

# Above every automatic job (priority 0): the claim order is priority first.
MANUAL_LOOKUP_PRIORITY = 100
QUEUE_DELAY = timedelta(hours=1)
TARGET_KINDS = frozenset({"artist", "album"})
MODES = frozenset({"queue", "search"})
# Problematic Files wording for an album without a release (G1 mockup, owner-approved).
RELEASE_NOT_FOUND_LABEL = "Release not found on MusicBrainz"
LOOKUP_INCOMPLETE_LABEL = "MusicBrainz lookup incomplete"
PROVIDER_UNAVAILABLE_LABEL = "MusicBrainz: Provider unavailable"
ARTIST_NOT_FOUND_LABEL = "MBID: Not found"
_RECENT_BATCHES = 20

_JOB_KIND_SQL = f"case %s when 'artist' then '{ARTIST_JOB_KIND}' else '{ALBUM_JOB_KIND}' end"


class MusicBrainzLookupQueuePostgresRepository:
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any] | None = None) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        if not self._database_url:
            raise RuntimeError("Database configuration is required for MusicBrainz lookups.")
        self._connect = connect or _connect

    def request(self, *, target_kind: str, mode: str, actor_account_id: int | None, observed_at: datetime,
                local_artist_id: int | None = None, album_key: str | None = None) -> dict[str, object] | None:
        """Queue (or, for a search, start) one lookup. An artist is named by its id or by one
        of its albums; an album by its key. Asking again for a waiting or running lookup
        returns it; a search for a queued one starts it now. None: no such artist or album."""
        if target_kind not in TARGET_KINDS or mode not in MODES:
            raise ValueError("MusicBrainz lookup request is invalid.")
        if (local_artist_id is None) == (album_key is None) or (target_kind == "album" and album_key is None):
            raise ValueError("Name exactly one artist or album.")
        observed = _aware_utc(observed_at)
        params = {"target_kind": target_kind, "mode": mode, "observed_at": observed,
                  "account_id": actor_account_id,
                  "local_artist_id": _positive_id(local_artist_id) if local_artist_id is not None else None,
                  "album_key": str(album_key) if album_key is not None else None}
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                row = _row_mapping(connection.execute(_REQUEST_SQL, params).fetchone())
                if not row.get("id"):
                    return None
                if mode == "search" and row["state"] == "queued":
                    started = _row_mapping(connection.execute(_START_SQL, {
                        "request_id": row["id"], "due_before": None, "now": observed,
                        "priority": MANUAL_LOOKUP_PRIORITY}).fetchone())
                    row = {**row, "state": "running", "batch_id": started.get("batch_id")}
        return {"request_id": int(row["id"]), "state": str(row["state"]),
                "batch_id": int(row["batch_id"]) if row.get("batch_id") else None}

    def start_queued(self, *, observed_at: datetime, due_only: bool) -> int | None:
        """Start every waiting "Queue" lookup as one batch: always (the owner ran MusicBrainz
        sync), or only once the oldest has waited an hour. Returns the batch id."""
        observed = _aware_utc(observed_at)
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                return self._start_queued(connection, observed, due_only)

    def advance(self, *, observed_at: datetime) -> None:
        """One worker step: start the due queue, then settle finished lookups."""
        observed = _aware_utc(observed_at)
        with self._connect(self._database_url) as connection:
            with _transaction(connection):
                self._start_queued(connection, observed, True)
                connection.execute(_SETTLE_SQL, {"now": observed})
                connection.execute(_FINISH_BATCHES_SQL, {"now": observed})

    def list_lookups(self) -> dict[str, object]:
        """The waiting lookups (S4's "MusicBrainz Look Up" tab lists them) and the recent
        batches still shown as notification cards."""
        with self._connect(self._database_url) as connection:
            queued = [_row_mapping(row) for row in connection.execute(_QUEUED_SQL).fetchall()]
            batches = [_row_mapping(row) for row in connection.execute(
                _BATCHES_SQL, {"batch_id": None, "limit": _RECENT_BATCHES}).fetchall()]
        oldest = min((row["requested_at"] for row in queued), default=None)
        return {"queued": queued, "queue_starts_at": oldest + QUEUE_DELAY if oldest else None,
                "batches": batches}

    def get_batch(self, *, batch_id: int) -> dict[str, object] | None:
        params = {"batch_id": _positive_id(batch_id), "limit": 1}
        with self._connect(self._database_url) as connection:
            batch = _row_mapping(connection.execute(_BATCHES_SQL, params).fetchone())
            if not batch:
                return None
            items = [_row_mapping(row) for row in connection.execute(_BATCH_ITEMS_SQL, params).fetchall()]
        return {**batch, "items": items}

    def target_status(self, *, album_key: str) -> dict[str, object] | None:
        """Whether an album and its artist already have an MBID (the album menu offers
        "Search MusicBrainz for …" only when not)."""
        with self._connect(self._database_url) as connection:
            return _row_mapping(connection.execute(_TARGET_SQL, {"album_key": str(album_key)}).fetchone()) or None

    def dismiss_batch(self, *, batch_id: int, observed_at: datetime) -> bool:
        params = {"batch_id": _positive_id(batch_id), "now": _aware_utc(observed_at)}
        with self._connect(self._database_url) as connection:
            return bool(_row_mapping(connection.execute(_DISMISS_SQL, params).fetchone()).get("dismissed"))

    def remove_queued(self, *, request_id: int) -> bool:
        """Drop a lookup that has not started (Settings → Edits Queue)."""
        with self._connect(self._database_url) as connection:
            return bool(_row_mapping(connection.execute(
                _REMOVE_QUEUED_SQL, {"request_id": _positive_id(request_id)}).fetchone()).get("removed"))

    @staticmethod
    def _start_queued(connection, observed: datetime, due_only: bool) -> int | None:
        row = _row_mapping(connection.execute(_START_SQL, {
            "request_id": None, "due_before": observed - QUEUE_DELAY if due_only else None, "now": observed,
            "priority": MANUAL_LOOKUP_PRIORITY}).fetchone())
        return int(row["batch_id"]) if row.get("batch_id") else None


# The target in the active library; an album names its own artist.
_REQUEST_SQL = _active_library_cte() + """
    , target as (
      select active_library.library_id, artists.id as local_artist_id,
             case when %(target_kind)s = 'album' then named_album.album_key end as album_key
      from active_library
      left join library.local_albums named_album
        on named_album.library_id = active_library.library_id and named_album.album_key = %(album_key)s
      join library.local_artists artists
        on artists.library_id = active_library.library_id
       and artists.id = coalesce(%(local_artist_id)s::bigint, named_album.artist_id)
    ), inserted as (
      insert into ops.musicbrainz_lookup_requests (
        library_id, target_kind, local_artist_id, album_key, mode, state, requested_by_account_id, requested_at)
      select library_id, %(target_kind)s, local_artist_id, album_key, %(mode)s, 'queued', %(account_id)s,
             %(observed_at)s
      from target
      on conflict (library_id, target_kind, local_artist_id, (coalesce(album_key, '')))
        where state in ('queued', 'running')
      do nothing
      returning id, state, batch_id
    )
    select id, state, batch_id from inserted
    union all
    select requests.id, requests.state, requests.batch_id
    from target
    join ops.musicbrainz_lookup_requests requests
      on requests.library_id = target.library_id and requests.target_kind = %(target_kind)s
     and requests.local_artist_id = target.local_artist_id
     and coalesce(requests.album_key, '') = coalesce(target.album_key, '')
     and requests.state in ('queued', 'running')
    where not exists (select 1 from inserted)
    limit 1;
"""

# Starts one request (a search) or the whole waiting queue as one batch: each distinct
# artist job is queued at manual priority, or an active one is raised to it and, if still
# waiting, moved forward. A job already retrying keeps its backoff.
_START_SQL = _active_library_cte() + """
    , picked as (
      select requests.id, requests.library_id, requests.local_artist_id,
             """ + _JOB_KIND_SQL % "requests.target_kind" + """ as job_kind
      from ops.musicbrainz_lookup_requests requests
      join active_library on active_library.library_id = requests.library_id
      where requests.state = 'queued'
        and (%(request_id)s::bigint is null or requests.id = %(request_id)s::bigint)
        and (%(request_id)s::bigint is not null or requests.mode = 'queue')
        and (%(due_before)s::timestamptz is null or exists (
          select 1 from ops.musicbrainz_lookup_requests oldest
          where oldest.library_id = requests.library_id and oldest.state = 'queued' and oldest.mode = 'queue'
            and oldest.requested_at <= %(due_before)s::timestamptz))
      for update of requests skip locked
    ), batch as (
      insert into ops.musicbrainz_lookup_batches (library_id, started_at)
      select distinct library_id, %(now)s from picked
      returning id, library_id
    ), jobs as (
      insert into ops.metadata_enrichment_jobs (
        library_id, local_artist_id, target_kind, job_kind, reason, state, priority, next_attempt_at,
        created_at, updated_at)
      select distinct library_id, local_artist_id, 'artist', job_kind, 'manual_lookup', 'queued',
             %(priority)s, %(now)s, %(now)s, %(now)s
      from picked
      on conflict (library_id, local_artist_id, job_kind) where state in ('queued', 'leased', 'retry_wait')
      do update set
        priority = greatest(ops.metadata_enrichment_jobs.priority, excluded.priority),
        next_attempt_at = case when ops.metadata_enrichment_jobs.state = 'queued'
          then least(ops.metadata_enrichment_jobs.next_attempt_at, excluded.next_attempt_at)
          else ops.metadata_enrichment_jobs.next_attempt_at end,
        updated_at = excluded.updated_at
      returning id, local_artist_id, job_kind
    ), started as (
      update ops.musicbrainz_lookup_requests requests
      set state = 'running', batch_id = batch.id, job_id = jobs.id, started_at = %(now)s
      from picked
      join batch on batch.library_id = picked.library_id
      join jobs on jobs.local_artist_id = picked.local_artist_id and jobs.job_kind = picked.job_kind
      where requests.id = picked.id
      returning requests.batch_id
    )
    select min(batch_id) as batch_id from started;
"""

# A running lookup is done once its job ended (or is gone). An artist is matched with its
# accepted MBID, or per album when its albums carry their own; an album with its release
# (or release group). Otherwise the label is the one Problematic Files shows.
_SETTLE_SQL = _active_library_cte() + """
    , done as (
      select requests.id, requests.target_kind, requests.library_id, requests.local_artist_id,
             requests.album_key, requests.started_at, jobs.state as job_state
      from ops.musicbrainz_lookup_requests requests
      join active_library on active_library.library_id = requests.library_id
      left join ops.metadata_enrichment_jobs jobs on jobs.id = requests.job_id
      where requests.state = 'running'
        and (jobs.id is null or jobs.state in ('succeeded', 'needs_review', 'exhausted'))
      for update of requests skip locked
    ), judged as (
      select done.id,
             case when done.target_kind = 'artist'
               then (matches.state = 'matched' and matches.artist_mbid is not null) or exists (
                 select 1 from library.local_albums albums
                 join library.local_album_artist_identities identities
                   on identities.library_id = albums.library_id and identities.album_key = albums.album_key
                 where albums.library_id = done.library_id and albums.artist_id = done.local_artist_id
                   and identities.artist_mbid is not null)
               else releases.release_group_mbid is not null
             end as matched,
             case when done.target_kind = 'artist'
               then case when matches.state = 'matched' then matches.artist_mbid end
               else coalesce(releases.release_mbid, releases.release_group_mbid)
             end as mbid,
             case
               when done.job_state = 'exhausted' then '""" + PROVIDER_UNAVAILABLE_LABEL + """'
               when done.target_kind = 'artist' then coalesce(problem.label, '""" + ARTIST_NOT_FOUND_LABEL + """')
               when releases.diagnostic = 'budget_exhausted' then '""" + LOOKUP_INCOMPLETE_LABEL + """'
               -- Not compared again (its artist has no MusicBrainz identity): the artist's label.
               when releases.album_key is null or releases.observed_at < done.started_at
                 then coalesce(problem.label, '""" + RELEASE_NOT_FOUND_LABEL + """')
               else '""" + RELEASE_NOT_FOUND_LABEL + """'
             end as label
      from done
      left join library.local_artist_musicbrainz_matches matches
        on matches.library_id = done.library_id and matches.local_artist_id = done.local_artist_id
      left join library.local_album_musicbrainz_releases releases
        on releases.library_id = done.library_id and releases.album_key = done.album_key
      left join lateral (
        select """ + _problem_label_sql() + """ as label
        from library.metadata_enrichment_problems problem
        where problem.library_id = done.library_id and problem.local_artist_id = done.local_artist_id
          and problem.target_kind = 'artist' and problem.lifecycle_state = 'active'
        order by problem.observed_at desc, problem.id desc
        limit 1
      ) problem on true
    )
    update ops.musicbrainz_lookup_requests requests
    set state = 'finished', finished_at = %(now)s,
        outcome = case when judged.matched then 'matched' else 'not_matched' end,
        result_mbid = case when judged.matched then judged.mbid end,
        problem_label = case when judged.matched then null else judged.label end
    from judged
    where requests.id = judged.id;
"""

_FINISH_BATCHES_SQL = _active_library_cte() + """
    update ops.musicbrainz_lookup_batches batches
    set finished_at = %(now)s
    from active_library
    where batches.library_id = active_library.library_id and batches.finished_at is null
      and not exists (select 1 from ops.musicbrainz_lookup_requests requests
                      where requests.batch_id = batches.id and requests.state <> 'finished');
"""

_QUEUED_SQL = _active_library_cte() + """
    select requests.id as request_id, requests.target_kind, requests.local_artist_id,
           artists.name as artist_name, requests.album_key, albums.title as album_title,
           albums.release_year as year, requests.requested_at
    from ops.musicbrainz_lookup_requests requests
    join active_library on active_library.library_id = requests.library_id
    join library.local_artists artists
      on artists.library_id = requests.library_id and artists.id = requests.local_artist_id
    left join library.local_albums albums
      on albums.library_id = requests.library_id and albums.album_key = requests.album_key
    where requests.state = 'queued'
    order by requests.requested_at, requests.id;
"""

# Recent batches still shown as cards, or one batch by id (dismissed or not).
_BATCHES_SQL = _active_library_cte() + """
    select batches.id as batch_id, batches.started_at, batches.finished_at,
           counts.total, counts.matched, counts.not_matched, counts.artists, counts.albums,
           single.title as single_title, single.artist_name as single_artist_name,
           single.target_kind as single_target_kind, single.outcome as single_outcome,
           single.problem_label as single_problem_label
    from ops.musicbrainz_lookup_batches batches
    join active_library on active_library.library_id = batches.library_id
    join lateral (
      select count(*)::integer as total,
             count(*) filter (where outcome = 'matched')::integer as matched,
             count(*) filter (where outcome = 'not_matched')::integer as not_matched,
             count(*) filter (where target_kind = 'artist')::integer as artists,
             count(*) filter (where target_kind = 'album')::integer as albums
      from ops.musicbrainz_lookup_requests requests where requests.batch_id = batches.id
    ) counts on true
    left join lateral (
      select coalesce(albums.title, artists.name) as title, artists.name as artist_name,
             requests.target_kind, requests.outcome, requests.problem_label
      from ops.musicbrainz_lookup_requests requests
      join library.local_artists artists
        on artists.library_id = requests.library_id and artists.id = requests.local_artist_id
      left join library.local_albums albums
        on albums.library_id = requests.library_id and albums.album_key = requests.album_key
      where requests.batch_id = batches.id and counts.total = 1
    ) single on true
    where (%(batch_id)s::bigint is null and batches.dismissed_at is null) or batches.id = %(batch_id)s::bigint
    order by batches.started_at desc, batches.id desc
    limit %(limit)s;
"""

_BATCH_ITEMS_SQL = _active_library_cte() + """
    select requests.id as request_id, requests.target_kind, requests.local_artist_id,
           artists.name as artist_name, requests.album_key, albums.title as album_title,
           albums.release_year as year, requests.state, requests.outcome, requests.result_mbid::text,
           -- Which MusicBrainz page the MBID opens.
           case when requests.result_mbid is null then null
                when requests.target_kind = 'artist' then 'artist'
                when exists (select 1 from integration.musicbrainz_releases releases
                             where releases.mbid = requests.result_mbid) then 'release'
                else 'release-group' end as result_entity,
           requests.problem_label,
           (select problem.id from library.metadata_enrichment_problems problem
            where problem.library_id = requests.library_id and problem.local_artist_id = requests.local_artist_id
              and problem.target_kind = 'artist' and problem.lifecycle_state = 'active'
            order by problem.observed_at desc, problem.id desc limit 1) as problem_occurrence_id
    from ops.musicbrainz_lookup_requests requests
    join active_library on active_library.library_id = requests.library_id
    join library.local_artists artists
      on artists.library_id = requests.library_id and artists.id = requests.local_artist_id
    left join library.local_albums albums
      on albums.library_id = requests.library_id and albums.album_key = requests.album_key
    where requests.batch_id = %(batch_id)s
    order by requests.outcome = 'matched' desc, coalesce(albums.title, artists.name), requests.id;
"""

_TARGET_SQL = _active_library_cte() + """
    select albums.album_key, artists.id as local_artist_id, artists.name as artist_name,
           coalesce(identities.artist_mbid is not null
                    or (matches.state = 'matched' and matches.artist_mbid is not null), false) as artist_has_mbid,
           coalesce(releases.release_group_mbid is not null, false) as album_has_mbid
    from active_library
    join library.local_albums albums
      on albums.library_id = active_library.library_id and albums.album_key = %(album_key)s
    join library.local_artists artists on artists.library_id = albums.library_id and artists.id = albums.artist_id
    left join library.local_album_artist_identities identities
      on identities.library_id = albums.library_id and identities.album_key = albums.album_key
    left join library.local_artist_musicbrainz_matches matches
      on matches.library_id = artists.library_id and matches.local_artist_id = artists.id
    left join library.local_album_musicbrainz_releases releases
      on releases.library_id = albums.library_id and releases.album_key = albums.album_key;
"""

# Only a finished batch's card can be deleted; a running one stays until it ends.
_DISMISS_SQL = _active_library_cte() + """
    , dismissed as (
      update ops.musicbrainz_lookup_batches batches
      set dismissed_at = %(now)s
      from active_library
      where batches.library_id = active_library.library_id and batches.id = %(batch_id)s
        and batches.finished_at is not null and batches.dismissed_at is null
      returning 1
    )
    select exists (select 1 from dismissed) as dismissed;
"""

_REMOVE_QUEUED_SQL = _active_library_cte() + """
    , removed as (
      delete from ops.musicbrainz_lookup_requests requests
      using active_library
      where requests.library_id = active_library.library_id and requests.id = %(request_id)s
        and requests.state = 'queued'
      returning 1
    )
    select exists (select 1 from removed) as removed;
"""
