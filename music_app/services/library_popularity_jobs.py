"""Durable, finite demand-refresh progress; no provider requests or actor authority."""
from datetime import datetime, timezone
from uuid import uuid4

from music_app.services.postgres_connections import pooled_connection


def refresh_is_configured(config):
    """Configuration-only admission, without importing the provider stack."""
    return (config.get("LASTFM_API_ENABLED") is True
            and bool(config.get("LASTFM_API_KEY"))
            and bool(config.get("LASTFM_API_ROOT"))
            and bool(config.get("ALBUM_HAVEN_APP_DATABASE_URL")))


def request_refresh(config, library_id, *, connect=pooled_connection, clock=None):
    """The caller has already authorized this current-library Mix request."""
    if type(library_id) is not int or library_id < 1:
        raise ValueError("A current local library is required")
    now = clock() if clock else datetime.now(timezone.utc)
    with connect(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        connection.execute("""insert into library.popularity_refresh_jobs
            (library_id,run_ref,status,upper_track_id,started_at,updated_at,next_batch_at)
            select l.id,%s,'queued',coalesce(max(t.id),0),%s,%s,%s
            from library.libraries l left join library.local_tracks t on t.library_id=l.id
            where l.id=%s and l.library_kind='local' group by l.id
            on conflict(library_id) do update set run_ref=excluded.run_ref,status='queued',
              upper_track_id=excluded.upper_track_id,last_track_id=0,
              started_at=excluded.started_at,updated_at=excluded.updated_at,
              next_batch_at=excluded.next_batch_at,examined_tracks=0,provider_requests=0
            where library.popularity_refresh_jobs.status in ('complete','blocked','cancelled')""",
            (str(uuid4()), now, now, now, library_id))


def cancel_refresh(config, library_id, *, connect=pooled_connection):
    """For an authorized explicit cancellation; in-flight I/O cannot be recalled."""
    with connect(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        connection.execute("""update library.popularity_refresh_jobs
            set status='cancelled',updated_at=now()
            where library_id=%s and status in ('queued','running')""", (library_id,))


def read_job(connection, library_id):
    return connection.execute("select * from library.popularity_refresh_jobs where library_id=%s",
                              (library_id,)).fetchone()


def pending_refresh_delay(config, library_id, *, connect=pooled_connection):
    """Used after a local worker completes to avoid losing a concurrent demand."""
    with connect(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as connection:
        job = read_job(connection, library_id)
    if job and job["status"] in ("queued", "running"):
        return max(1.0, (job["next_batch_at"] - datetime.now(timezone.utc)).total_seconds())
    return None


def job_active(connection, library_id, run_ref, *, lock=False):
    row = connection.execute("""select run_ref from library.popularity_refresh_jobs
        where library_id=%s and run_ref=%s and status in ('queued','running')"""
        + (" for share" if lock else ""), (library_id, run_ref)).fetchone()
    return row is not None


def update_job(connection, job, *, status, now, delay, cursor, examined, requests):
    connection.execute("""update library.popularity_refresh_jobs
        set status=%s,updated_at=%s,next_batch_at=%s,last_track_id=%s,
          examined_tracks=examined_tracks+%s,provider_requests=provider_requests+%s
        where library_id=%s and run_ref=%s and status in ('queued','running')""",
        (status, now, now + delay, cursor, examined, requests,
         job["library_id"], job["run_ref"]))
