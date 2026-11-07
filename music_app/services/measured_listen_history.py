"""Atomic scoped rendered-frame sessions in the existing listen ledger."""
from datetime import datetime, timezone
from contextlib import contextmanager, nullcontext
import hashlib
import json
import math
import uuid

VERSION = "rendered-pcm-v1"
SOURCE = "rendered_local_listen_session"
_SERVER_FIELDS = {
    "id", "recorded_at", "scrobbled", "scrobble_error", "scrobble_retryable",
    "scrobble_reauthentication_required", "scrobble_submission_state",
    "scrobble_retry_count", "scrobble_retry_exhausted", "last_scrobble_attempt_at",
    "scrobbled_at", "sync_problem",
}
_HANDOFF_FINGERPRINT_DOMAIN = b"album-haven:playback-handoff-completion:v1:json\0"
NO_HANDOFF_COMPLETION_DIGEST = hashlib.sha256(
    b"album-haven:playback-handoff-completion:v1:null"
).digest()


class MeasuredListenError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def _is_nonnegative_number(value):
    if type(value) not in (int, float) or value < 0:
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate_playback_completion(entry):
    """Reject malformed measured-completion JSON before any coercion."""
    if not isinstance(entry, dict):
        raise MeasuredListenError("Invalid playback completion")

    string_fields = (
        "path", "track_ref", "title", "track", "artist", "album", "album_artist",
        "albumArtist", "cover_path", "track_number", "trackNumber", "started_at",
        "ended_at", "completion_reason", "measurement_version", "device_id", "session_id",
        "library_track_id", "canonical_track_id", "canonical_release_id",
        "client_kind", "origin_type", "origin_id", "clientId", "clientSurface",
        "claimToken",
    )
    numeric_fields = (
        "duration_seconds", "duration", "started_at_unix", "timestamp",
        "total_listened_seconds",
        "max_contiguous_seconds",
    )
    measurement_fields = ("measured_listened_seconds", "max_measured_contiguous_seconds")
    boolean_fields = (
        "finalized", "finished_fully", "skipped", "scrobble_eligible", "scrobbled",
    )
    if any(key in entry and type(entry[key]) is not str for key in string_fields):
        raise MeasuredListenError("Invalid playback completion")
    if any(key in entry and not _is_nonnegative_number(entry[key]) for key in numeric_fields):
        raise MeasuredListenError("Invalid playback completion")
    if any(key in entry and not _is_nonnegative_number(entry[key]) for key in measurement_fields):
        raise MeasuredListenError("Invalid listen measurement")
    if "sequence" in entry and (
        type(entry["sequence"]) is not int
        or not 0 <= entry["sequence"] <= 2**63 - 1
    ):
        raise MeasuredListenError("Invalid playback completion")
    if any(key in entry and type(entry[key]) is not bool for key in boolean_fields):
        raise MeasuredListenError("Invalid playback completion")

    if "segments" in entry:
        segments = entry["segments"]
        if type(segments) is not list:
            raise MeasuredListenError("Invalid playback completion")
        for segment in segments:
            if type(segment) is not dict or set(segment) != {"start_seconds", "end_seconds"}:
                raise MeasuredListenError("Invalid playback completion")
            start = segment["start_seconds"]
            end = segment["end_seconds"]
            if (not _is_nonnegative_number(start) or not _is_nonnegative_number(end)
                    or end < start):
                raise MeasuredListenError("Invalid playback completion")

    if "request_origin" in entry:
        origin = entry["request_origin"]
        fields = {"client_kind", "origin_type", "origin_id"}
        if (type(origin) is not dict or set(origin) != fields
                or any(type(origin[key]) is not str for key in fields)):
            raise MeasuredListenError("Invalid playback completion")


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


def playback_handoff_completion_digest(entry):
    """The fingerprint of a [normalize_measurement]-normalized handoff entry, or of none."""
    if entry is None:
        return NO_HANDOFF_COMPLETION_DIGEST
    submitted = {
        key: value for key, value in entry.items()
        if key not in _SERVER_FIELDS and not key.startswith("scrobble_")
    }
    canonical = json.dumps(
        submitted, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(_HANDOFF_FINGERPRINT_DOMAIN + canonical).digest()


def append_measured(adapter, entry, *, account_id, library_id, connection=None):
    from psycopg.types.json import Jsonb
    item = normalize_measurement(entry, account_id=account_id, library_id=library_id)
    identity = f"{account_id}:{library_id}:{item['device_id']}:{item['session_id']}"
    item["id"] = hashlib.sha256(identity.encode()).hexdigest()
    def submitted_fields(value):
        return {key: item for key, item in value.items()
                if key not in _SERVER_FIELDS and not key.startswith("scrobble_")}
    connection_scope = (nullcontext(connection) if connection is not None
                        else adapter._connect_to_database())
    with connection_scope as connection:
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
            for key in _SERVER_FIELDS:
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


def load_measured(connection, *, account_id, library_id, device_id, session_id):
    row = connection.execute("""select metadata from integration.listen_history
        where account_id=%s and library_id=%s and device_id=%s and session_id=%s
          and measurement_version=%s""",
        (account_id, library_id, device_id, session_id, VERSION)).fetchone()
    if row is None:
        raise MeasuredListenError("Persisted listen completion is unavailable", 409)
    return dict(row["metadata"]["source_payload"])


@contextmanager
def measured_provider_guard(config, *, account_id, library_id, device_id, session_id):
    from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
    identity = f"provider:{account_id}:{library_id}:{device_id}:{session_id}"
    lock_key = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)
    with PostgresListenHistoryAdapter(config)._connect_to_database() as connection:
        connection.execute("select pg_advisory_xact_lock(%s)", (lock_key,))
        yield connection
