"""Bounded same-connection Apply metadata finalizer; NOT a public Apply API.

Only the genuine locked outer Apply sequence may supply verified originals and
the actual inputs/outputs of the source and taste writers. Its failures MUST
escape and abort that outer transaction, including earlier source/taste work.
A returned private value is not a commit claim or an authorization grant.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import hashlib
import json

from . import foobar_apply_command as apply
from . import foobar_import_prepare as prepare
from . import foobar_import_terminal as terminal
from . import foobar_prepare_gate as gate
from . import foobar_prepared_envelope as envelope
from . import foobar_source_evidence as evidence
from . import foobar_source_postgres as source
from . import track_preferences_postgres as taste
from .foobar_source_postgres import SourceUnavailable, SourceStale

MAX_FRAME_BYTES = 540
MAX_RESULT_BYTES = 4096
_MAX = 9223372036854775807
_HEX = "0123456789abcdef"


@dataclass(frozen=True, slots=True)
class FoobarFinalizedMetadata:
    """Private, uncommitted metadata. The outer caller still owes final checks."""
    receipt_ref: str
    generation: int
    source_revision: int
    terminal_bytes: bytes
    terminal_sha256: str
    committed_at: datetime
    expires_at: datetime
    observed_at: datetime


def _time(value):
    if type(value) is not datetime or value.utcoffset() != timedelta(0):
        raise SourceUnavailable()
    return value


def _one(connection, sql, frame, terminal_bytes=None):
    # All parameter/forwarding owners are admitted before this helper.
    parameters = (frame,) if terminal_bytes is None else (frame, terminal_bytes)
    rows = prepare._parameters_query(connection, sql, parameters, maximum=1)
    if not rows:
        raise SourceStale()
    # The cursor/native result is closed by the real helper before transfer.
    # Remove the Python array occurrence before retaining/validating its row.
    row = rows.pop()
    if type(row) is not dict:
        raise SourceUnavailable()
    return row


def _same_hex(raw, text):
    # Complete byte equality with the original canonical hex, without allocating
    # another encoded string or treating a SHA match as identity equality.
    if type(raw) is not bytes or type(text) is not str or 2 * len(raw) != len(text):
        return False
    return all(text[2*i] == _HEX[value >> 4] and text[2*i+1] == _HEX[value & 15]
               for i, value in enumerate(raw))


def _phase_bytes(original_value):
    """Actual original-based version of the accepted Prepare terminal recipe.

    Requires the previously bounded/verified original, not arbitrary client
    objects. No source bytes, whole state copy, terminal record or frame is
    allocated by this count. The unchanged four-MiB gate applies before them.
    """
    if (type(original_value) is not tuple or len(original_value) != 4
            or type(original_value[2]) is not tuple or not 1 <= len(original_value[2]) <= 100
            or type(original_value[3]) is not tuple or len(original_value[3]) > len(original_value[2])):
        raise SourceUnavailable()
    rows, states = original_value[2], original_value[3]
    if any(type(row) is not tuple or len(row) != 12 for row in rows):
        raise SourceUnavailable()
    if any(type(row[index]) is not str for row in rows for index in (1,6,7,8)):
        raise SourceUnavailable()
    p, k = evidence._json_size(original_value), len(rows)
    controls = (32768 + 6*evidence._json_size(states) + 5*(1024+128*k)
                + 4*(1024+640*k) + 2*(1024+128*k))
    raw = sum((len(row[1])+len(row[6])+len(row[7])+len(row[8]))//2 for row in rows)
    write_owner = raw + 1024 + 640*k
    outcomes = 4096 + 320*k
    required = (controls + 5*p + 2*write_owner + outcomes
                + terminal.ENCODE_CONTRIBUTION + terminal.DECODE_CONTRIBUTION
                + apply.MAX_PHASE_BYTES + 10*2048 + 5 + 2*MAX_RESULT_BYTES
                + terminal.MAX_WIRE_BYTES)
    prepare._private(required)
    return p, required


def _association_admission(original_value, prepared_bytes):
    """Scalar-only reuse of the already reserved genuine source-writer phase.

    No source-input tuple is passed to this counting helper. All variable sizes
    come from the already verified original hex. It delegates the actual phase
    algebra to the same scalar owner used by Prepare, without creating bytes,
    source records, tuple slices or a source-frame representation to measure.
    """
    header, rows = original_value[1], original_value[2]
    k = len(rows)
    raw = row_sizes = max_i = max_e = max_d = max_n = 0
    for row in rows:
        i,e,d,n = len(row[1])//2,len(row[7])//2,len(row[8])//2,len(row[6])//2
        if row[1].startswith("5b2270617468222c"):
            kind = "path"
        elif row[1].startswith("5b226f6363757272656e6365222c"):
            kind = "occurrence"
        else:
            raise SourceUnavailable()
        raw += i+e+d+n
        row_sizes += (9+38+evidence._json_size(kind)+evidence._json_size(row[3])
                      +evidence._json_size(row[4])+evidence._json_size(row[5])+2*(i+e+d+n)+9)
        max_i,max_e,max_d,max_n = max(max_i,i),max(max_e,e),max(max_d,d),max(max_n,n)
    scope = evidence._json_size((header[0],header[1],header[3],header[4],header[7],()))
    phase, unused_frame, base, unused_result = source._source_write_phase_from_sizes(
        count=k,raw=raw,row_sizes=row_sizes,maximum_identity=max_i,
        maximum_evidence=max_e,maximum_display=max_d,maximum_incoming_evidence=max_n,scope_size=scope)
    del unused_frame, unused_result
    controls = (32768+6*evidence._json_size(original_value[3])+5*(1024+128*k)
                +4*(1024+640*k)+2*(1024+128*k))
    required = controls+5*prepared_bytes+base+phase
    prepare._private(required)
    return required


def _actual_counts(original_value, source_items, source_outcomes, taste_items, taste_outcomes):
    """Association checks, not a substitute for the genuine writers/postchecks."""
    header, rows, states = original_value[1], original_value[2], original_value[3]
    k = len(rows)
    if (type(source_items) is not tuple or type(source_outcomes) is not tuple
            or len(source_items) != k or len(source_outcomes) != k
            or type(taste_items) is not tuple or type(taste_outcomes) is not tuple
            or len(taste_items) != len(states) or len(taste_outcomes) != len(states)):
        raise SourceUnavailable()
    for index, row in enumerate(rows):
        item, outcome = source_items[index], source_outcomes[index]
        if (type(item) is not source.SourceWrite or type(outcome) is not source.SourceWriteOutcome
                or not gate._uuid(item.observation_ref) or not gate._uuid(outcome.observation_ref)
                or item.observation_ref != row[2] or outcome.observation_ref != row[2]
                or (item.previous_revision is not None and not gate._integer(item.previous_revision,1,_MAX))
                or item.previous_revision != row[3]
                or item.previous_evidence_sha256 != row[4] or item.previous_display_sha256 != row[5]
                or not _same_hex(item.identity_bytes,row[1])
                or not _same_hex(item.incoming_evidence_bytes,row[6])
                or not _same_hex(item.evidence_bytes,row[7])
                or not _same_hex(item.display_bytes,row[8])
                or not gate._hex(outcome.incoming_evidence_sha256)
                or type(outcome.source_changed) is not bool
                or not gate._integer(outcome.source_revision,1,_MAX)):
            raise SourceUnavailable()
        if outcome.source_changed:
            if header[7] == _MAX:
                raise SourceStale()
            if outcome.source_revision != header[7]+1:
                raise SourceUnavailable()
        else:
            if row[3] is None or outcome.source_revision != row[3]:
                raise SourceUnavailable()
            # Necessary only. Equal hashes are NOT a full-byte no-op proof;
            # that proof belongs to the actual source writer and final fence.
            if (hashlib.sha256(item.evidence_bytes).hexdigest() != row[4]
                    or hashlib.sha256(item.display_bytes).hexdigest() != row[5]):
                raise SourceUnavailable()
    for target_index, values in enumerate(states):
        representative = next(index for index,row in enumerate(rows) if row[9] == target_index)
        row = rows[representative]
        item, outcome = taste_items[target_index], taste_outcomes[target_index]
        if (type(item) is not taste.FoobarTasteChange or type(outcome) is not taste.FoobarTasteOutcome
                or type(item.track_id) is not int or type(outcome.track_id) is not int
                or item.track_id != values[0] or outcome.track_id != values[0]
                or not gate._uuid(item.observation_ref) or not gate._uuid(outcome.observation_ref)
                or item.observation_ref != row[2] or outcome.observation_ref != row[2]
                or type(item.source_revision) is not int
                or item.source_revision != source_outcomes[representative].source_revision
                or (item.rating is not None and not gate._integer(item.rating,1,5))
                or item.rating != row[10] or type(item.favorite) is not bool or item.favorite != row[11]
                or type(outcome.rating_written) is not bool or type(outcome.favorite_promoted) is not bool):
            raise SourceUnavailable()
        state = taste.FoobarTasteState(*values)
        flags = taste._foobar_taste_mutation_flags(state,rating=item.rating,favorite=item.favorite)
        if flags != (outcome.rating_written,outcome.favorite_promoted):
            raise SourceUnavailable()
        del state, flags
    unchanged = source_only = taste_only = both = ratings = favorites = 0
    for index, row in enumerate(rows):
        rating_written = favorite_promoted = False
        if row[9] is not None and not any(rows[j][9] == row[9] for j in range(index)):
            outcome = taste_outcomes[row[9]]
            rating_written, favorite_promoted = outcome.rating_written,outcome.favorite_promoted
        changed = rating_written or favorite_promoted
        if source_outcomes[index].source_changed:
            if changed:
                both += 1
            else:
                source_only += 1
        elif changed:
            taste_only += 1
        else:
            unchanged += 1
        ratings += int(rating_written)
        favorites += int(favorite_promoted)
    mutation = source_only + taste_only + both > 0
    if mutation and header[7] == _MAX:
        raise SourceStale()
    return (unchanged,source_only,taste_only,both,ratings,favorites), header[7]+int(mutation)


def _terminal_record(header, command, prepared_sha256, decision_sha256, counts, revision):
    return (terminal.VERSION,
            terminal.terminal_scope_sha256(header[0],header[1],header[3],header[4]),
            header[3],header[6],header[5],command.request_key,prepared_sha256,decision_sha256,
            header[8],header[14],header[15],header[7],revision,header[11],header[12],header[13],
            *counts,header[4])


# No prepared/evidence/terminal bytea is projected by this bounded scalar guard.
# Native text fields are schema-capped at64 UTF-8 bytes; all other strings below
# are fixed UUID/SHA or a closed status. Exact result envelope is <4096 bytes.
_GUARD_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select r.prepare_key::text prepare_key,r.original_session_id,r.expected_revision,
 encode(r.upload_sha256,'hex') upload_sha256,r.parser_version,r.mapping_name,
 r.total_rows,r.window_start,r.window_end,encode(r.inventory_sha256,'hex') inventory_sha256,
 encode(r.authority_sha256,'hex') authority_sha256,encode(r.prepared_sha256,'hex') prepared_sha256,
 encode(r.decision_sha256,'hex') decision_sha256,r.created_at,r.ready_until,
 case when r.state='ready' then 'ready' when r.state='committed' then 'committed' else 'invalid' end state,
 s.revision,s.current_generation,s.retired_through,s.updated_at,s.clock_high_water,
 clock_timestamp() observed_at,
 coalesce(encode(k.command_sha256,'hex'),'') prepare_command_sha256,
 coalesce(k.operation='prepare' and k.state='active'
   and k.original_receipt_ref=r.receipt_ref and k.receipt_ref=r.receipt_ref,false) prepare_key_valid,
 not exists(select 1 from integration.foobar_import_request_keys a
   where (a.account_id,a.library_id,a.source_ref,a.generation,a.request_key)=
     (r.account_id,r.library_id,r.source_ref,r.generation,(j->>11)::uuid)) apply_key_absent
from f join integration.foobar_import_streams s
 on (s.account_id,s.library_id,s.source_ref)=((j->>0)::bigint,(j->>1)::bigint,(j->>2)::uuid)
join integration.foobar_import_receipts r
 on (r.account_id,r.library_id,r.source_ref,r.generation,r.receipt_ref)=
    (s.account_id,s.library_id,s.source_ref,(j->>3)::bigint,(j->>4)::uuid)
left join integration.foobar_import_request_keys k
 on (k.account_id,k.library_id,k.source_ref,k.generation,k.request_key)=
    (r.account_id,r.library_id,r.source_ref,r.generation,r.prepare_key)
"""


_ADVANCE_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
 t as materialized (select clock_timestamp() observed_at),
 changed as (
 update integration.foobar_import_streams s
 set revision=(j->>8)::bigint,
     current_generation=greatest(s.current_generation,floor(extract(epoch from t.observed_at)/86400)::bigint),
     updated_at=t.observed_at
 from f,t
 where (s.account_id,s.library_id,s.source_ref)=((j->>0)::bigint,(j->>1)::bigint,(j->>2)::uuid)
   and s.revision=(j->>7)::bigint and s.retired_through<(j->>3)::bigint
   and (j->>3)::bigint<=s.current_generation
   and exists(select 1 from integration.foobar_import_receipts r
     where (r.account_id,r.library_id,r.source_ref,r.generation,r.receipt_ref)=
       (s.account_id,s.library_id,s.source_ref,(j->>3)::bigint,(j->>4)::uuid)
       and r.state='ready' and r.prepare_key=(j->>5)::uuid
       and r.original_session_id=(j->>6)::bigint and r.expected_revision=(j->>7)::bigint
       and r.prepared_sha256=decode(j->>9,'hex') and r.decision_sha256=decode(j->>10,'hex')
       and r.expires_at>t.observed_at)
   and not exists(select 1 from integration.foobar_import_request_keys k
     where (k.account_id,k.library_id,k.source_ref,k.generation,k.request_key)=
       (s.account_id,s.library_id,s.source_ref,(j->>3)::bigint,(j->>11)::uuid))
 returning s.revision,s.current_generation,s.retired_through,s.updated_at,s.clock_high_water
)
select changed.*,clock_timestamp() observed_at from changed
"""


# The explicit parent advance is a DIFFERENT statement. Receipt/key accounting
# triggers and their reciprocal deferred constraints remain the real owners.
_COMMIT_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
 b as materialized (select %b::bytea payload),
 t as materialized (select clock_timestamp() observed_at),
 changed as (
 update integration.foobar_import_receipts r
 set state='committed',prepared_bytes=null,apply_key=(j->>11)::uuid,
     committed_revision=(j->>8)::bigint,terminal_bytes=b.payload,
     committed_at=t.observed_at,expires_at=t.observed_at+interval '168 hours'
 from f,b,t
 where (r.account_id,r.library_id,r.source_ref,r.generation,r.receipt_ref)=
    ((j->>0)::bigint,(j->>1)::bigint,(j->>2)::uuid,(j->>3)::bigint,(j->>4)::uuid)
   and r.state='ready' and r.prepare_key=(j->>5)::uuid
   and r.original_session_id=(j->>6)::bigint and r.expected_revision=(j->>7)::bigint
   and r.prepared_sha256=decode(j->>9,'hex') and r.decision_sha256=decode(j->>10,'hex')
   and r.expires_at>t.observed_at and octet_length(b.payload)=(j->>14)::integer
   and sha256(b.payload)=decode(j->>13,'hex')
   and exists(select 1 from integration.foobar_import_streams s
     where (s.account_id,s.library_id,s.source_ref)=(r.account_id,r.library_id,r.source_ref)
       and s.revision=(j->>8)::bigint and s.retired_through<r.generation
       and r.generation<=s.current_generation)
   and not exists(select 1 from integration.foobar_import_request_keys k
     where (k.account_id,k.library_id,k.source_ref,k.generation,k.request_key)=
       (r.account_id,r.library_id,r.source_ref,r.generation,(j->>11)::uuid))
 returning r.account_id,r.library_id,r.source_ref,r.generation,r.receipt_ref,
     r.apply_key,r.committed_revision,r.terminal_sha256,r.committed_at,r.expires_at,r.ready_until
), inserted as (
 insert into integration.foobar_import_request_keys
 (account_id,library_id,source_ref,generation,request_key,operation,command_sha256,
  original_receipt_ref,receipt_ref,state,created_at)
 select c.account_id,c.library_id,c.source_ref,c.generation,c.apply_key,'apply',
        decode(j->>12,'hex'),c.receipt_ref,c.receipt_ref,'active',c.committed_at
 from changed c cross join f
 returning receipt_ref
)
select c.receipt_ref::text receipt_ref,c.generation,c.committed_revision,
 encode(c.terminal_sha256,'hex') terminal_sha256,c.committed_at,c.expires_at,c.ready_until,
 clock_timestamp() observed_at
from changed c join inserted i on i.receipt_ref=c.receipt_ref
"""


_GUARD_KEYS = frozenset(("prepare_key","original_session_id","expected_revision","upload_sha256",
 "parser_version","mapping_name","total_rows","window_start","window_end","inventory_sha256",
 "authority_sha256","prepared_sha256","decision_sha256","created_at","ready_until","state",
 "revision","current_generation","retired_through","updated_at","clock_high_water","observed_at",
 "prepare_command_sha256","prepare_key_valid","apply_key_absent"))
_STREAM_KEYS = frozenset(("current_generation","retired_through","updated_at","clock_high_water","observed_at"))
_COMMIT_KEYS = frozenset(("receipt_ref","generation","committed_revision","terminal_sha256",
                         "committed_at","expires_at","ready_until","observed_at"))


def _stream_clock(row, *, generation, earlier, ready_until, allow_roll=False):
    observed = _time(row["observed_at"])
    today = (observed.date()-date(1970,1,1)).days
    if (not _time(row["updated_at"]) <= _time(row["clock_high_water"]) <= observed
            or observed < _time(earlier)
            or not gate._integer(row["current_generation"],1,2147483647)
            or not gate._integer(row["retired_through"],0,row["current_generation"]-1)
            or row["current_generation"] > today
            or (not allow_roll and row["current_generation"] != today)):
        raise SourceUnavailable()
    if not row["retired_through"] < generation <= row["current_generation"]:
        raise SourceStale()
    prepare._check_sampled_receipt_expiry(observed,ready_until)
    return observed


def _guard_result(row, header, *, prepared_sha256, decision_sha256, prepare_sha256, earlier):
    if set(row) != _GUARD_KEYS:
        raise SourceUnavailable()
    for name in ("original_session_id","expected_revision","total_rows","window_start","window_end","revision"):
        if not gate._integer(row[name],0,_MAX):
            raise SourceUnavailable()
    for name in ("upload_sha256","inventory_sha256","authority_sha256","prepared_sha256",
                 "decision_sha256","prepare_command_sha256"):
        if not gate._hex(row[name]):
            raise SourceUnavailable()
    if (not gate._uuid(row["prepare_key"]) or type(row["parser_version"]) is not str
            or type(row["mapping_name"]) is not str or type(row["state"]) is not str
            or row["state"] not in ("ready","committed")
            or type(row["prepare_key_valid"]) is not bool or type(row["apply_key_absent"]) is not bool):
        raise SourceUnavailable()
    if (row["prepare_key"] != header[5] or row["original_session_id"] != header[2]
            or row["expected_revision"] != header[7] or row["upload_sha256"] != header[8]
            or row["parser_version"] != header[9] or row["mapping_name"] != header[10]
            or row["total_rows"] != header[11] or row["window_start"] != header[12]
            or row["window_end"] != header[13] or row["inventory_sha256"] != header[14]
            or row["authority_sha256"] != header[15] or row["prepared_sha256"] != prepared_sha256
            or row["decision_sha256"] != decision_sha256 or not row["prepare_key_valid"]
            or row["prepare_command_sha256"] != prepare_sha256
            or prepare._utc(_time(row["created_at"])) != header[16]
            or _time(row["ready_until"]) != row["created_at"]+timedelta(hours=1)):
        raise SourceUnavailable()
    observed = _stream_clock(row,generation=header[4],earlier=earlier,ready_until=row["ready_until"],allow_roll=True)
    if row["state"] != "ready" or row["revision"] != header[7] or not row["apply_key_absent"]:
        raise SourceStale()
    return row["ready_until"],observed


def _advance_result(row, *, header, revision, earlier, ready_until):
    if set(row) != _STREAM_KEYS | {"revision"} or not gate._integer(row["revision"],0,_MAX):
        raise SourceUnavailable()
    if row["revision"] != revision:
        raise SourceUnavailable()
    if _time(row["updated_at"]) < _time(earlier):
        raise SourceUnavailable()
    return _stream_clock(row,generation=header[4],earlier=earlier,ready_until=ready_until)


def _commit_result(row, *, header, revision, terminal_sha256, earlier, ready_until):
    if (set(row) != _COMMIT_KEYS or not gate._uuid(row["receipt_ref"])
            or not gate._integer(row["generation"],1,2147483647)
            or not gate._integer(row["committed_revision"],0,_MAX)
            or not gate._hex(row["terminal_sha256"])):
        raise SourceUnavailable()
    if (row["receipt_ref"] != header[6] or row["generation"] != header[4]
            or row["committed_revision"] != revision or row["terminal_sha256"] != terminal_sha256
            or _time(row["ready_until"]) != ready_until
            or not _time(earlier) <= _time(row["committed_at"]) <= _time(row["observed_at"])
            or _time(row["expires_at"]) != row["committed_at"]+timedelta(hours=168)):
        raise SourceUnavailable()
    prepare._check_sampled_receipt_expiry(row["observed_at"],ready_until)
    return row["committed_at"],row["expires_at"],row["observed_at"]


def finalize_foobar_apply_on_connection(
    connection, live_context, *, original_value, original_command, expected_header,
    command, prepared_sha256, decision_sha256, source_items, source_outcomes,
    taste_items, taste_outcomes, observed_at, constraints=None,
):
    """Finalize actual writes; caller MUST propagate failure to outer rollback.

    The caller owns the real locked current_library_transaction, verified
    original/key provenance, actual writer execution, all retained intake/native
    owners, and subsequent complete final checks and successful outer commit.
    This helper does not provide replay or a public success response.
    """
    apply.validate_apply_command(command)  # External malformed command stays400.
    try:
        if type(connection) is not prepare._Connection:
            raise SourceUnavailable()
        taste._foobar_taste_connection(connection)
        taste._foobar_taste_context(live_context)
        p, unused_required = _phase_bytes(original_value)
        del unused_required
        envelope._validate(original_value,original_command=original_command,expected_header=expected_header)
        header = original_value[1]
        if not gate._hex(prepared_sha256) or not gate._hex(decision_sha256):
            raise SourceUnavailable()
        _time(observed_at)
        if (header[:3] != (live_context.actor.account_id,live_context.library_id,live_context.actor.session_id)
                or command.source_ref != header[3] or command.generation != header[4]
                or command.receipt_ref != header[6] or command.decision_sha256 != decision_sha256):
            raise SourceStale()
        _association_admission(original_value,p)
        counts, revision = _actual_counts(original_value,source_items,source_outcomes,taste_items,taste_outcomes)
        record = _terminal_record(header,command,prepared_sha256,decision_sha256,counts,revision)
        payload = terminal.encode_foobar_terminal(record)
        digest = hashlib.sha256(payload).hexdigest()
        del record, counts
        command_sha = apply.apply_command_digest(command,account_id=header[0],library_id=header[1],session_id=header[2])
        prepare_sha = gate.prepare_command_digest(original_command,account_id=header[0],library_id=header[1],session_id=header[2])
        values = (header[0],header[1],header[3],header[4],header[6],header[5],header[2],
                  header[7],revision,prepared_sha256,decision_sha256,command.request_key,
                  command_sha,digest,len(payload))
        if evidence._json_size(values) > MAX_FRAME_BYTES:
            raise SourceUnavailable()
        frame = json.dumps(values,ensure_ascii=True,separators=(",",":"),allow_nan=False).encode("ascii")
        del values
        with connection.transaction():
            source._authority(live_context,constraints)
            row = _one(connection,_GUARD_SQL,frame)
            ready_until, earlier = _guard_result(row,header,prepared_sha256=prepared_sha256,
                decision_sha256=decision_sha256,prepare_sha256=prepare_sha,earlier=observed_at)
            del row
            row = _one(connection,_ADVANCE_SQL,frame)
            earlier = _advance_result(row,header=header,revision=revision,earlier=earlier,ready_until=ready_until)
            del row
            row = _one(connection,_COMMIT_SQL,frame,payload)
            committed_at,expires_at,earlier = _commit_result(row,header=header,revision=revision,
                terminal_sha256=digest,earlier=earlier,ready_until=ready_until)
            del row
            # AFTER child accounting triggers have completed, read the actual
            # stream high-water and a fresh DB sample. No old native row survives.
            source._authority(live_context,constraints)
            row = _one(connection,prepare._CLOCK_SQL,frame)
            if set(row) != _STREAM_KEYS:
                raise SourceUnavailable()
            final_observed = _stream_clock(row,generation=header[4],earlier=earlier,ready_until=ready_until)
            del row, frame
            result = FoobarFinalizedMetadata(header[6],header[4],revision,payload,digest,
                                             committed_at,expires_at,final_observed)
        return result  # Still inside caller's outer transaction, NOT committed.
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None

