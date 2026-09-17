"""Atomic scoped rendered-frame sessions in the existing listen ledger."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import math
import uuid

VERSION = "rendered-pcm-v1"
SOURCE = "rendered_local_listen_session"


class MeasuredListenError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def normalize_measurement(entry, *, account_id, library_id):
    if any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
        raise MeasuredListenError("Authenticated listen scope is required")
    if not isinstance(entry, dict) or entry.get("measurement_version") != VERSION:
        raise MeasuredListenError("Unsupported listen measurement")
    item = dict(entry)
    for key in ("device_id", "session_id"):
        try:
            item[key] = str(uuid.UUID(item[key]))
        except (ValueError, TypeError, AttributeError):
            raise MeasuredListenError("Invalid listen identity") from None
    for key in ("measured_listened_seconds", "max_measured_contiguous_seconds"):
        value = item.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise MeasuredListenError("Invalid listen measurement")
        item[key] = float(value)
    if item["max_measured_contiguous_seconds"] > item["measured_listened_seconds"]:
        raise MeasuredListenError("Invalid contiguous listen measurement")
    if type(item.get("sequence")) is not int or item["sequence"] < 0:
        raise MeasuredListenError("Invalid listen sequence")
    if type(item.get("finalized")) is not bool:
        raise MeasuredListenError("Invalid listen finalization")
    try:
        start = datetime.fromisoformat(str(item["started_at"]).replace("Z", "+00:00"))
        if start.tzinfo is None:
            raise ValueError()
    except (ValueError, KeyError):
        raise MeasuredListenError("Invalid listen start time") from None
    item["started_at"] = start.astimezone(timezone.utc).isoformat()
    if item.get("source_provenance") != {"kind": "local_playback", "provider": "album_haven"}:
        raise MeasuredListenError("Invalid listen provenance")
    return item


def append_measured(adapter, entry, *, account_id, library_id):
    from psycopg.types.json import Jsonb
    item = normalize_measurement(entry, account_id=account_id, library_id=library_id)
    identity = f"{account_id}:{library_id}:{item['device_id']}:{item['session_id']}"
    item["id"] = hashlib.sha256(identity.encode()).hexdigest()
    server_fields = {"id", "recorded_at", "scrobbled", "scrobble_error", "scrobble_retryable", "sync_problem"}
    def submitted_fields(value):
        return {key: item for key, item in value.items() if key not in server_fields and not key.startswith("scrobble_")}
    with adapter._connect_to_database() as connection:
        # The transaction-scoped identity lock also serializes first-row creation.
        lock_key = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)
        connection.execute("select pg_advisory_xact_lock(%s)", (lock_key,))
        path = str(item.get("path") or item.get("track_ref") or "")
        claimed = str((item.get("canonical_match") or {}).get("library_track_id") or "")
        track = connection.execute("""select t.id,t.track_key from library.local_tracks t
            join library.local_track_files f on f.track_id=t.id
            where t.library_id=%s and f.private_path=%s""", (library_id, path)).fetchone()
        if track is None or (claimed and claimed != str(track["id"])):
            raise MeasuredListenError("Listen track does not belong to the current library")
        current = connection.execute("""select * from integration.listen_history
            where account_id=%s and library_id=%s and device_id=%s and session_id=%s
              and measurement_version=%s for update""",
            (account_id, library_id, item["device_id"], item["session_id"], VERSION)).fetchone()
        if current is not None:
            previous = dict(current["metadata"]["source_payload"])
            if item["sequence"] < current["last_sequence"]:
                return previous
            if current["track_id"] != track["id"] or any(item.get(key) != previous.get(key)
                    for key in ("started_at", "source_provenance", "measurement_version")):
                raise MeasuredListenError("Listen identity changed", 409)
            if item["sequence"] == current["last_sequence"]:
                if submitted_fields(item) != submitted_fields(previous):
                    raise MeasuredListenError("Conflicting listen sequence", 409)
                return previous
            if (item["measured_listened_seconds"] < current["measured_listened_seconds"]
                    or item["max_measured_contiguous_seconds"] < current["max_measured_contiguous_seconds"]
                    or (current["finalized"] and not item["finalized"])):
                raise MeasuredListenError("Listen counters cannot regress", 409)
            # Provider state belongs to the server's exact-row update path.
            for key in ("scrobbled", "scrobble_error", "scrobble_retryable", "sync_problem", "scrobble_submission_state"):
                if key in previous:
                    item[key] = previous[key]
        item.setdefault("recorded_at", datetime.now(timezone.utc).isoformat())
        metadata = Jsonb({"source_payload": item})
        values = (item["measured_listened_seconds"], item["max_measured_contiguous_seconds"],
                  item["sequence"], item["finalized"], metadata)
        if current is not None:
            connection.execute("""update integration.listen_history set
                measured_listened_seconds=%s,max_measured_contiguous_seconds=%s,
                last_sequence=%s,finalized=%s,metadata=%s where id=%s""", (*values, current["id"]))
        else:
            connection.execute("""insert into integration.listen_history
                (account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id,
                 device_id,session_id,measurement_version,measured_listened_seconds,
                 max_measured_contiguous_seconds,last_sequence,finalized,metadata)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (account_id,library_id,track["id"],track["track_key"],item["started_at"],SOURCE,identity,
                 item["device_id"],item["session_id"],VERSION,*values))
    return item


@contextmanager
def measured_provider_guard(config, *, account_id, library_id, device_id, session_id):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    identity = f"provider:{account_id}:{library_id}:{device_id}:{session_id}"
    lock_key = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)
    with PostgresListenHistoryAdapter(config)._connect_to_database() as connection:
        connection.execute("select pg_advisory_xact_lock(%s)", (lock_key,))
        yield
