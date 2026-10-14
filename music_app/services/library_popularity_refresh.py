"""Bounded background ingestion into app-owned global-popularity projections.

Existing startup/scan work queues this job. Provider requests run outside every
transaction. A durable lease serializes processes, with a fixed request budget,
one-second spacing, a one-day cache and conservative error backoff.
"""
from datetime import datetime, timedelta, timezone
from time import sleep
from uuid import uuid4

from music_app.services.lastfm import LastfmError
from music_app.services.lastfm_track_popularity import (
    PopularityIdentityError, fetch_track_popularity,
)
from music_app.services.library_mix_inventory_postgres import (
    inventory_revision, local_identity, read_inventory,
)
from music_app.services.popularity_observations_postgres import put_observation
from music_app.services.popularity_snapshots import PopularityObservation
from music_app.services.postgres_connections import pooled_connection
from music_app.services.library_popularity_jobs import (
    job_active, read_job, update_job, refresh_is_configured,
)

MAX_LOOKUPS_PER_REFRESH = 25
MAX_INVENTORY_ROWS_PER_BATCH = 5000
CACHE_TTL = timedelta(days=1)
ERROR_BACKOFF = timedelta(minutes=15)
REFRESH_COOLDOWN = timedelta(minutes=1)
LEASE_LIFETIME = timedelta(minutes=15)


def _lease(connection, now):
    token = str(uuid4())
    row = connection.execute("""update catalog.popularity_api_refresh_state
        set lease_token=%s, lease_until=%s where provider='lastfm'
          and next_attempt_at <= %s and (lease_until is null or lease_until <= %s)
        returning provider""", (token, now + LEASE_LIFETIME, now, now)).fetchone()
    return token if row else None


def _check_lease(connection, token, now):
    row = connection.execute("""select provider from catalog.popularity_api_refresh_state
        where provider='lastfm' and lease_token=%s and lease_until > %s for share""",
        (token, now)).fetchone()
    if row is None:
        raise RuntimeError("Popularity refresh lease expired")


def _record(connection, library_id, original_rows, result, reason, token, now, *, run_ref=None):
    _check_lease(connection, token, now)
    if run_ref is not None and not job_active(connection, library_id, run_ref, lock=True):
        return 0
    originals = {row["original_local_track_id"]: row for row in original_rows}
    current = read_inventory(connection, library_id, track_ids=sorted(originals), lock=True)
    accepted = [row for row in current if row["availability"] == "local"
                and inventory_revision(row) == inventory_revision(originals[row["original_local_track_id"]])]
    if not accepted:
        return 0
    if result is not None:
        observation = PopularityObservation("lastfm", "overall_scrobbles",
            result.source_entity_id, "api:" + str(uuid4()), now, now, result.count,
            "resolved" if result.count is not None else "missing")
        status, _stored = put_observation(connection, observation)
        if status not in ("accepted", "idempotent"):
            return 0
    for row in accepted:
        track_id = row["original_local_track_id"]
        fingerprint = inventory_revision(row)
        revision = row["mapping_revision"]
        if result is not None:
            if not (revision and row["mapped_inventory_revision"] == fingerprint
                    and row["mapped_recording_mbid"] == result.recording_mbid
                    and row["mapped_artist_mbid"] == result.artist_mbid
                    and row["source_entity_id"] == result.source_entity_id):
                revision = str(uuid4())
                connection.execute("""insert into library.track_popularity_mapping_versions
                    (track_id,revision,inventory_revision,recording_mbid,artist_mbid,
                     source_entity_id,mapped_at) values (%s,%s,%s,%s,%s,%s,%s)""",
                    (track_id, revision, fingerprint, result.recording_mbid,
                     result.artist_mbid, result.source_entity_id, now))
            outcome = "ready" if result.count is not None else "missing_global_metric"
            retry_after = now + CACHE_TTL
        else:
            outcome = reason
            retry_after = now + (ERROR_BACKOFF if reason == "provider_unavailable" else CACHE_TTL)
            # Provider outages preserve a previously verified mapping. A newer
            # explicit identity mismatch or missing recording invalidates it.
            if reason != "provider_unavailable":
                revision = None
        connection.execute("""insert into library.track_popularity_mapping_slots
            (track_id,current_revision,checked_inventory_revision,last_attempt_at,retry_after,last_result)
            values (%s,%s,%s,%s,%s,%s) on conflict(track_id) do update set
              current_revision=excluded.current_revision,
              checked_inventory_revision=excluded.checked_inventory_revision,
              last_attempt_at=excluded.last_attempt_at,retry_after=excluded.retry_after,
              last_result=excluded.last_result""",
            (track_id, revision, fingerprint, now, retry_after, outcome))
    return len(accepted) if result is not None else 0


def plan_batch(rows, now, job=None, *, complete_range=True):
    """A finite demand run advances once through its captured high-water range."""
    groups, examined = {}, 0
    cursor = job["last_track_id"] if job else 0
    if job:
        rows = sorted((row for row in rows if cursor < row["original_local_track_id"]
                       <= job["upper_track_id"]), key=lambda row: row["original_local_track_id"])
    else:
        rows = sorted(rows, key=lambda row: (row["last_attempt_at"] is not None,
            row["last_attempt_at"] or datetime.min.replace(tzinfo=timezone.utc),
            row["original_local_track_id"]))
    for row in rows:
        recording, artist, reason = local_identity(row)
        already_examined = bool(job and row["last_attempt_at"] is not None
                                and row["last_attempt_at"] >= job["started_at"])
        fresh = (row["checked_inventory_revision"] == inventory_revision(row)
                 and row["retry_after"] is not None and row["retry_after"] > now)
        due = row["availability"] == "local" and not reason and not fresh and not already_examined
        key = (recording, artist)
        if due and key not in groups and len(groups) >= MAX_LOOKUPS_PER_REFRESH:
            break
        examined += 1
        cursor = row["original_local_track_id"]
        if due:
            groups.setdefault(key, []).append(row)
    else:
        if job and complete_range:
            cursor = job["upper_track_id"]
    return groups, cursor, examined


def refresh_library_popularity(config, *, library_id=None, connect=pooled_connection,
                               fetch=fetch_track_popularity, clock=None, pause=sleep,
                               stopping=None, demand_only=False):
    """Refresh at most 25 due recording identities; a later trigger resumes work.

    An absent library ID means the established server-local scan inventory.
    Failures never fabricate an empty complete snapshot or a zero playcount.
    """
    if not refresh_is_configured(config):
        return {"status": "not_configured", "requests": 0, "mapped_tracks": 0}
    clock = clock or (lambda: datetime.now(timezone.utc))
    if stopping is None:
        from music_app.services.runtime_shutdown import runtime_shutdown_requested
        stopping = runtime_shutdown_requested
    url = config["ALBUM_HAVEN_APP_DATABASE_URL"]
    now = clock()
    with connect(url) as connection:
        if library_id is None:
            row = connection.execute("""select l.id from library.libraries l
                join app.bootstrap_owners b on b.account_id=l.owner_account_id
                where b.owner_key='local-bootstrap-owner' and l.name='Local Library'
                  and l.library_kind='local'""").fetchone()
            library_id = row["id"] if row else None
        if type(library_id) is not int or library_id < 1:
            return {"status": "no_library", "requests": 0, "mapped_tracks": 0}
        row = connection.execute("select id from library.libraries where id=%s and library_kind='local'",
                                 (library_id,)).fetchone()
        if row is None:
            return {"status": "no_library", "requests": 0, "mapped_tracks": 0}
        job = read_job(connection, library_id)
        job = job if job and job["status"] in ("queued", "running") else None
        if demand_only and job is None:
            return {"status": "inactive", "requests": 0, "mapped_tracks": 0}
        if job and job["next_batch_at"] > now:
            return {"status": "deferred", "requests": 0, "mapped_tracks": 0,
                    "next_batch_in": (job["next_batch_at"] - now).total_seconds()}
        token = _lease(connection, now)
        deferred_delay = REFRESH_COOLDOWN
        if token is None and job:
            budget = connection.execute("""select next_attempt_at,lease_until
                from catalog.popularity_api_refresh_state where provider='lastfm'""").fetchone()
            if budget is None:
                raise RuntimeError("Popularity provider budget is unavailable")
            deferred_delay = max(REFRESH_COOLDOWN, budget["next_attempt_at"] - now,
                                 (budget["lease_until"] or now) - now)
            update_job(connection, job, status="queued", now=now,
                       delay=deferred_delay, cursor=job["last_track_id"], examined=0, requests=0)
        if token and job:
            update_job(connection, job, status="running", now=now,
                       delay=REFRESH_COOLDOWN, cursor=job["last_track_id"], examined=0, requests=0)
    if token is None:
        return {"status": "deferred", "requests": 0, "mapped_tracks": 0,
                "next_batch_in": deferred_delay.total_seconds() if job else None}
    requests, mapped, backoff = 0, 0, REFRESH_COOLDOWN
    try:
        with connect(url) as connection:
            complete_range = True
            if job:
                ids = [row["id"] for row in connection.execute("""select id
                    from library.local_tracks where library_id=%s and id>%s and id<=%s
                    order by id limit %s""", (library_id, job["last_track_id"],
                    job["upper_track_id"], MAX_INVENTORY_ROWS_PER_BATCH + 1)).fetchall()]
                complete_range = len(ids) <= MAX_INVENTORY_ROWS_PER_BATCH
                rows = read_inventory(connection, library_id,
                                      track_ids=ids[:MAX_INVENTORY_ROWS_PER_BATCH])
            else:
                rows = read_inventory(connection, library_id)
        groups, cursor, examined = plan_batch(rows, now, job, complete_range=complete_range)
        interrupted = False
        for (recording, artist), targets in groups.items():
            if requests:
                pause(1.0)
            if stopping():
                interrupted = True
                break
            if job:
                with connect(url) as connection:
                    if not job_active(connection, library_id, job["run_ref"]):
                        return {"status": "cancelled", "requests": requests, "mapped_tracks": mapped}
            requests += 1
            result, reason, stop = None, None, False
            try:
                result = fetch(config, recording, artist_mbid=artist)
            except PopularityIdentityError:
                reason = "ambiguous_attribution"
            except LastfmError as error:
                if error.code in (6, 7):
                    reason = "missing_provider_mapping"
                else:
                    reason, stop = "provider_unavailable", True
                    backoff = CACHE_TTL if error.code in (4, 10, 26) else ERROR_BACKOFF
            with connect(url) as connection:
                mapped += _record(connection, library_id, targets, result, reason, token, clock(),
                                  run_ref=job["run_ref"] if job else None)
            if stop:
                break
        status = "paused" if interrupted else "provider_unavailable" if backoff != REFRESH_COOLDOWN else "complete_batch"
        next_batch_in = None
        if job:
            failed = backoff != REFRESH_COOLDOWN
            status = "blocked" if failed else "queued" if interrupted or cursor < job["upper_track_id"] else "complete"
            with connect(url) as connection:
                if not job_active(connection, library_id, job["run_ref"], lock=True):
                    return {"status": "cancelled", "requests": requests, "mapped_tracks": mapped}
                update_job(connection, job, status=status, now=clock(), delay=backoff,
                    cursor=job["last_track_id"] if interrupted or failed else cursor,
                    examined=0 if interrupted or failed else examined, requests=requests)
            if status == "queued" and not interrupted:
                next_batch_in = REFRESH_COOLDOWN.total_seconds()
        return {"status": status, "requests": requests, "mapped_tracks": mapped,
                "next_batch_in": next_batch_in}
    except Exception:
        backoff = ERROR_BACKOFF
        if job:
            with connect(url) as connection:
                update_job(connection, job, status="blocked", now=clock(), delay=backoff,
                           cursor=job["last_track_id"], examined=0, requests=requests)
        raise
    finally:
        with connect(url) as connection:
            connection.execute("""update catalog.popularity_api_refresh_state
                set lease_token=null,lease_until=null,next_attempt_at=%s
                where provider='lastfm' and lease_token=%s""", (clock() + backoff, token))
