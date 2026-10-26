# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Generation-aware Prepare entry gate, not a receipt or public success response.

Caller owns current_foobar_account_transaction(...),
its real locked context, complete intake reservation and an additional
PREPARE_GATE_BYTES reservation. No raw upload or payload projection occurs here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import re
from uuid import UUID

from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _authority, _query
from .track_preferences_postgres import _foobar_taste_connection
from .foobar_account_authority import require_account_foobar

VERSION = "foobar_account_prepare_command_v4"
MAPPING = "foobar_text_tools_snapshot_v1"
ENHANCED_MAPPING = "foobar_enhanced_playcount_store_v1"
ENHANCED_PARSER = "foobar_enhanced_sqlite_record_v1"
COMMAND_DOMAIN = b"albumhaven.foobar.account.prepare.command.v4\n"
MAX_FRAME_BYTES = 1024
# C + 6F + 4 + 4V + 2S: includes one deadline parameter view F+2.
PREPARE_GATE_BYTES = 8192 + 6 * MAX_FRAME_BYTES + 4 + 4 * 8192 + 2 * 4096 + 256
_MAX = 9223372036854775807
_HEX = re.compile(r"[0-9a-f]{64}\Z")


def _account_context(context, constraints=None):
    """Account-self authorization; original matching scope is command data."""
    return require_account_foobar(context, constraints)


class PrepareInvalid(ValueError):
    code = "invalid_import_request"
    status_code = 400
    retryable = False

    def __init__(self):
        super().__init__("Import request is invalid.")


@dataclass(frozen=True, slots=True)
class FoobarPrepareCommand:
    source_ref: str
    generation: int
    request_key: str
    expected_revision: int
    upload_sha256: str
    mapping_name: str
    offset: int
    inventory_sha256: str
    matching_library_id: int | None


@dataclass(frozen=True, slots=True)
class FoobarPrepareTicket:
    """Private lock-held disposition only. This is NOT a prepared receipt."""
    command_sha256: str
    disposition: str
    source_revision: int
    current_generation: int
    retired_through: int
    observed_at: datetime
    receipt_ref: str | None
    prepared_sha256: str | None
    decision_sha256: str | None
    inventory_sha256: str | None
    authority_sha256: str | None
    prepared_bytes_size: int
    terminal_bytes_size: int
    expires_at: datetime | None


def _uuid(value):
    return (type(value) is str and len(value) == 36
            and str(UUID(value)) == value)


def _hex(value):
    return type(value) is str and len(value) == 64 and _HEX.fullmatch(value) is not None


def _integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def parser_for_mapping(mapping):
    """Exact format discriminator; never infer a format from uploaded bytes."""
    if type(mapping) is not str:
        raise PrepareInvalid()
    if mapping==MAPPING:
        return MAPPING
    if mapping==ENHANCED_MAPPING:
        return ENHANCED_PARSER
    raise PrepareInvalid()


def validate_prepare_command(command):
    try:
        valid = (
            type(command) is FoobarPrepareCommand
            and _uuid(command.source_ref) and _uuid(command.request_key)
            and _integer(command.generation, 1, 2147483647)
            and _integer(command.expected_revision, 0, _MAX)
            and _hex(command.upload_sha256) and _hex(command.inventory_sha256)
            and type(command.mapping_name) is str and command.mapping_name in (MAPPING,ENHANCED_MAPPING)
            and _integer(command.offset, 0, 100000)
            and (command.matching_library_id is None
                 or _integer(command.matching_library_id, 1, _MAX))
        )
    except (ValueError, AttributeError, TypeError):
        valid = False
    if not valid:
        raise PrepareInvalid()


def prepare_command_bytes(command, *, account_id, library_id, session_id):
    """Bind original optional matching scope, never an ambient library selection.

    library_id is the original command field, not an authorization requirement.
    """
    validate_prepare_command(command)
    if (type(library_id) is not type(command.matching_library_id)
            or library_id != command.matching_library_id
            or any(not _integer(value, 1, _MAX) for value in (account_id, session_id))):
        raise SourceUnavailable()
    value = (
        VERSION, account_id, command.matching_library_id, session_id, command.source_ref,
        command.generation, command.request_key, command.expected_revision,
        command.upload_sha256, command.mapping_name, command.offset,
        command.inventory_sha256,
    )
    # Validated fixed widths imply <1024 bytes BEFORE ordinary encoding.
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    if len(encoded) > MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return encoded


def prepare_command_digest(command, *, account_id, library_id, session_id):
    encoded = prepare_command_bytes(command, account_id=account_id,
                                    library_id=library_id, session_id=session_id)
    digest = hashlib.sha256()
    digest.update(COMMAND_DOMAIN)
    digest.update(encoded)
    return digest.hexdigest()


_FRAME = """
with frame as materialized (
 select convert_from(%b::bytea,'UTF8')::jsonb j
), scope as (
 select (j->>0)::bigint account_id,         (j->>2)::bigint session_id, (j->>3)::uuid source_ref,
        (j->>4)::bigint generation, (j->>5)::uuid request_key
 from frame
)
"""

_STREAM_FIELDS = frozenset((
    "revision", "current_generation", "retired_through", "prepared_today",
    "receipt_count", "ready_count", "receipt_reserved_bytes", "request_key_count",
    "observed_at", "isolation",
))
_STREAM_PROJECTION = """
s.revision,s.current_generation,s.retired_through,s.prepared_today,
s.receipt_count,s.ready_count,s.receipt_reserved_bytes,s.request_key_count,
clock_timestamp() as observed_at,current_setting('transaction_isolation') as isolation
"""

_LOCK_SQL = _FRAME + """
select """ + _STREAM_PROJECTION + """
from integration.foobar_import_streams_v2 s cross join scope x
where (s.account_id,s.source_ref)=(x.account_id,x.source_ref)
for update of s
"""

_ROLL_SQL = _FRAME + """
update integration.foobar_import_streams_v2 s
set current_generation=(clock_timestamp() at time zone 'UTC')::date-date '1970-01-01',
    updated_at=clock_timestamp()
from scope x
where (s.account_id,s.source_ref)=(x.account_id,x.source_ref)
returning """ + _STREAM_PROJECTION

_KEY_FIELDS = frozenset((
    "operation", "command_sha256", "original_receipt_ref", "key_state", "receipt_ref",
    "receipt_state", "original_session_id", "expected_revision", "prepare_key",
    "prepared_sha256", "decision_sha256", "inventory_sha256", "authority_sha256",
    "expires_at", "observed_at", "prepared_bytes_size", "terminal_bytes_size",
))
_KEY_SQL = _FRAME + """
select k.operation,encode(k.command_sha256,'hex') as command_sha256,
       k.original_receipt_ref::text as original_receipt_ref,k.state as key_state,
       k.receipt_ref::text as receipt_ref,r.state as receipt_state,
       r.original_session_id,r.expected_revision,r.prepare_key::text as prepare_key,
       encode(r.prepared_sha256,'hex') as prepared_sha256,
       encode(r.decision_sha256,'hex') as decision_sha256,
       encode(r.inventory_sha256,'hex') as inventory_sha256,
       encode(r.authority_sha256,'hex') as authority_sha256,
       r.expires_at,clock_timestamp() as observed_at,
       octet_length(r.prepared_bytes) as prepared_bytes_size,
       octet_length(r.terminal_bytes) as terminal_bytes_size
from scope x join integration.foobar_import_request_keys_v2 k
 on (k.account_id,k.source_ref,k.generation,k.request_key)
  = (x.account_id,x.source_ref,x.generation,x.request_key)
left join integration.foobar_import_receipts_v2 r
 on (r.account_id,r.source_ref,r.generation,r.receipt_ref)
  = (k.account_id,k.source_ref,k.generation,k.receipt_ref)
"""


def _time(value):
    return type(value) is datetime and value.tzinfo is not None and value.utcoffset() is not None


def _stream_result(rows):
    if not rows:
        raise SourceStale()
    if len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != _STREAM_FIELDS:
        raise SourceUnavailable()
    row = rows[0]
    limits = {
        "revision": (0, _MAX), "current_generation": (1, 2147483647),
        "retired_through": (0, 2147483646), "prepared_today": (0, 4000),
        "receipt_count": (0, 40000), "ready_count": (0, 8),
        "receipt_reserved_bytes": (0, 67108864), "request_key_count": (0, 80000),
    }
    if (any(not _integer(row[key], *bounds) for key, bounds in limits.items())
            or row["retired_through"] >= row["current_generation"]
            or not _time(row["observed_at"]) or row["isolation"] != "read committed"):
        raise SourceUnavailable()
    return row


def _classify_key(rows, command, command_digest, stream, session_id):
    """No payload bytes, receipt construction, key minting or replay success."""
    if not rows:
        if (command.generation != stream["current_generation"]
                or command.expected_revision != stream["revision"]):
            raise SourceStale()
        # These are actual N3 resource ceilings, not a capacity increase.
        if (stream["prepared_today"] >= 4000 or stream["receipt_count"] >= 40000
                or stream["ready_count"] >= 8
                or stream["request_key_count"] + stream["ready_count"] + 2 > 80000
                or stream["receipt_reserved_bytes"] > 67108864 - 4194304):
            raise SourceUnavailable()
        return FoobarPrepareTicket(
            command_digest, "new", stream["revision"], stream["current_generation"],
            stream["retired_through"], stream["observed_at"],
            None, None, None, None, None, 0, 0, None,
        )
    if len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != _KEY_FIELDS:
        raise SourceUnavailable()
    row = rows[0]
    try:
        if (row["operation"] not in ("prepare", "apply")
                or row["key_state"] not in ("active", "tombstone")
                or not _hex(row["command_sha256"]) or not _uuid(row["original_receipt_ref"])
                or not _time(row["observed_at"])):
            raise SourceUnavailable()
        # The later query must not hide an observed within-day clock regression.
        # This detects only these samples, not future expiry or a hard deadline.
        if row["observed_at"] < stream["observed_at"]:
            raise SourceUnavailable()
        if row["operation"] != "prepare" or row["command_sha256"] != command_digest:
            raise SourceStale()
        if row["key_state"] == "tombstone":
            # Never reinterpret a retired identity as a new command.
            if row["receipt_ref"] is not None:
                raise SourceUnavailable()
            raise SourceStale()
        if (not _uuid(row["receipt_ref"])
                or row["receipt_ref"] != row["original_receipt_ref"]
                or row["receipt_state"] not in ("ready", "committed")
                or not _integer(row["original_session_id"], 1, _MAX)
                or not _integer(row["expected_revision"], 0, _MAX)
                or not _uuid(row["prepare_key"]) or not _time(row["expires_at"])
                or any(not _hex(row[key]) for key in (
                    "prepared_sha256", "decision_sha256", "inventory_sha256", "authority_sha256"))):
            raise SourceUnavailable()
        if (row["original_session_id"] != session_id or row["prepare_key"] != command.request_key
                or row["expected_revision"] != command.expected_revision
                or row["inventory_sha256"] != command.inventory_sha256):
            raise SourceUnavailable()
        if row["observed_at"] >= row["expires_at"]:
            raise SourceStale()
        ready = row["receipt_state"] == "ready"
        if ready:
            if (not _integer(row["prepared_bytes_size"], 1, 4194304)
                    or row["terminal_bytes_size"] is not None):
                raise SourceUnavailable()
            if stream["revision"] != command.expected_revision:
                raise SourceStale()
        elif (row["prepared_bytes_size"] is not None
              or not _integer(row["terminal_bytes_size"], 1, 669)):
            raise SourceUnavailable()
        return FoobarPrepareTicket(
            command_digest, "ready_replay" if ready else "committed_replay",
            stream["revision"], stream["current_generation"], stream["retired_through"],
            row["observed_at"], row["receipt_ref"], row["prepared_sha256"],
            row["decision_sha256"], row["inventory_sha256"], row["authority_sha256"],
            row["prepared_bytes_size"] or 0, row["terminal_bytes_size"] or 0, row["expires_at"],
        )
    except SourceUnavailable:
        raise
    except (ValueError, TypeError, AttributeError):
        raise SourceUnavailable() from None


def begin_foobar_prepare_on_connection(connection, live_context, *, command, constraints=None):
    """Lock and classify only; caller must not expose this ticket as readiness.

    Entry always requires the genuine locked account transaction and
    admission of PREPARE_GATE_BYTES plus every actual retained caller owner.
    External Prepare additionally requires its newly verified complete upload
    matching command.upload_sha256 and the separately admitted intake owners.
    Alternate internal Apply entry requires a genuine same-account
    durable receipt, bounded validated original header/generation and the exact
    persisted original Prepare-key command digest/receipt association. The
    outer Apply owner establishes those facts before this call. READY must
    fully verify the persisted original/source before business changes/output.
    COMMITTED replay instead verifies retained terminal/header/hashes and both
    original key associations: prepared bytes were cleared at commit and are
    not falsely claimed revalidated. Only the mandatory clock touch occurs here.
    This is not permission to fabricate a receipt, ticket or upload proof.
    Stream lock is retained by the outer caller. See CONTRACT.md in the pinned
    foobar-prepare-gate-provenance-n4-20261022 source packet.
    """
    validate_prepare_command(command)
    try:
        _foobar_taste_connection(connection)
        _account_context(live_context, constraints)
        actor = live_context.actor
        _authority(live_context, constraints)
        command_digest = prepare_command_digest(
            command, account_id=actor.account_id, library_id=command.matching_library_id,
            session_id=actor.session_id,
        )
        frame = json.dumps(
            (actor.account_id, None, actor.session_id, command.source_ref,
             command.generation, command.request_key),
            ensure_ascii=True, separators=(",", ":"), allow_nan=False,
        ).encode("ascii")
        if len(frame) > MAX_FRAME_BYTES:
            raise SourceUnavailable()
        with connection.transaction():
            # Native FOR UPDATE first; fresh rollover/clock guard after any wait.
            locked = _query(connection, _LOCK_SQL, frame, maximum=1)
            _stream_result(locked)
            del locked
            stream = _stream_result(_query(connection, _ROLL_SQL, frame, maximum=1))
            # Must run BEFORE request-key lookup, including an otherwise valid replay.
            if not stream["retired_through"] < command.generation <= stream["current_generation"]:
                raise SourceStale()
            keys = _query(connection, _KEY_SQL, frame, maximum=1)
            ticket = _classify_key(keys, command, command_digest, stream, actor.session_id)
            _authority(live_context, constraints)
            return ticket
    except (SourceUnavailable, SourceStale, PrepareInvalid):
        raise
    except Exception:
        raise SourceUnavailable() from None



_PREPARE_KEYS = ('source_ref','generation','request_key','expected_revision',
                 'upload_sha256','mapping_name','offset','inventory_sha256','matching_library_id')
_PREPARE_WIRE_KEYS = frozenset(('version',)+_PREPARE_KEYS)


def prepare_command_from_mapping(value):
    """Closed job/request shape; original matching scope is never inferred."""
    if (type(value) is not dict or len(value) != 10 or set(value) != _PREPARE_WIRE_KEYS
            or type(value['version']) is not str or value['version'] != VERSION):
        raise PrepareInvalid()
    command = FoobarPrepareCommand(*(value[key] for key in _PREPARE_KEYS))
    validate_prepare_command(command)
    return command


def prepare_command_to_mapping(command):
    """Serialize every retry input, including explicit null/original local scope."""
    validate_prepare_command(command)
    return {'version':VERSION,**{key:getattr(command,key) for key in _PREPARE_KEYS}}
