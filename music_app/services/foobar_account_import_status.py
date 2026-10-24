"""Account-only v4 receipt recovery; never submits or authorizes Apply.

The existing account/session and source are locked by their native owners. No
library is read, selected, inferred or required. READY can recover its original
command from authenticated stored bytes; committed bytes cannot recover that
command's optional matching scope and this service deliberately does not guess.
The genuine recovery codec requires the five-member v4 original and exact
association seal grammar. Old unpublished v2 bytes are not accepted or upgraded.
Status never reads live bindings/libraries to reinterpret an immutable receipt.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import hashlib
import json

from . import foobar_account_import_prepare as prepare
from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_postgres as source
from .foobar_account_authority import current_foobar_account_transaction, require_account_foobar
from .foobar_account_source_postgres import SourceUnavailable, SourceStale

# Fixed controls cover simultaneous input/output scopes, two scalar snapshots,
# two key snapshots, returned command/header and query forwarding occurrences.
_CONTROLS = 65536
_SCALAR_SQL = prepare._RECEIPT_SCALAR_SQL.replace(
    'clock_timestamp() observed_at',
    'r.prepared_bytes is null prepared_null,r.terminal_bytes is null terminal_null,'
    'clock_timestamp() observed_at')
_SCALAR_FIELDS = prepare._RECEIPT_KEYS[:-1] + ('prepared_null','terminal_null','observed_at')
_KEY_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select k.request_key::text request_key,k.operation,
 encode(k.command_sha256,'hex') command_sha256,
 k.original_receipt_ref::text original_receipt_ref,k.receipt_ref::text receipt_ref,
 k.state,k.created_at,k.retired_at,k.retired_reason,clock_timestamp() observed_at
from integration.foobar_import_request_keys_v2 k cross join f
where (k.account_id,k.source_ref,k.generation,k.original_receipt_ref)=
 ((j->>0)::bigint,(j->>2)::uuid,(j->>3)::bigint,(j->>4)::uuid)
order by k.operation,k.request_key
"""
_KEY_FIELDS = ('request_key','operation','command_sha256','original_receipt_ref',
               'receipt_ref','state','created_at','retired_at','retired_reason','observed_at')


@dataclass(frozen=True, slots=True)
class FoobarReceiptStatus:
    """Persisted recovery data, not permission for any native side effect."""
    source_ref: str
    generation: int
    receipt_ref: str
    state: str
    original_session_id: int
    prepare_key: str
    prepare_command_sha256: str
    apply_key: str | None
    apply_command_sha256: str | None
    prepared_sha256: str
    decision_sha256: str
    expires_at: datetime
    original_prepare_command: gate.FoobarPrepareCommand | None
    terminal_bytes: bytes | None
    terminal_outcome: tuple | None
    association_review: tuple | None = None


def _frame(values):
    payload=json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>gate.MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return payload


def _clock(connection, scope, *, generation, earlier, expires_at=None):
    rows=source._query(connection,prepare._CLOCK_SQL,_frame(scope[:3]),maximum=1)
    if len(rows)!=1:
        raise SourceStale()
    row=rows[0]
    if (type(row) is not dict or set(row)!=
            {'updated_at','clock_high_water','current_generation','retired_through','observed_at'}):
        raise SourceUnavailable()
    for key in ('updated_at','clock_high_water','observed_at'):
        prepare._utc(row[key])
    if (not row['updated_at']<=row['clock_high_water']<=row['observed_at']
            or row['observed_at']<earlier
            or not gate._integer(row['current_generation'],1,2147483647)
            or not gate._integer(row['retired_through'],0,row['current_generation']-1)
            or row['current_generation']>(row['observed_at'].date()-date(1970,1,1)).days):
        raise SourceUnavailable()
    if not row['retired_through']<generation<=row['current_generation']:
        raise SourceStale()
    prepare._check_sampled_receipt_expiry(row['observed_at'],expires_at)
    return row['observed_at']


def _scalar(connection, scope, *, session_id, earlier):
    rows=source._query(connection,_SCALAR_SQL,_frame(scope),maximum=1)
    if not rows:
        raise SourceStale()
    if len(rows)!=1 or type(rows[0]) is not dict or tuple(rows[0])!=_SCALAR_FIELDS:
        raise SourceUnavailable()
    r=rows[0]
    for key in ('created_at','ready_until','expires_at','observed_at'):
        prepare._utc(r[key])
    if (r['observed_at']<earlier or r['created_at']>r['observed_at']
            or (r['created_at'].date()-date(1970,1,1)).days!=scope[3]
            or not gate._integer(r['original_session_id'],1,gate._MAX)
            or not gate._integer(r['expected_revision'],0,gate._MAX)
            or not gate._uuid(r['prepare_key'])
            or r['mapping_name'] not in (gate.MAPPING,gate.ENHANCED_MAPPING)
            or r['parser_version']!=gate.parser_for_mapping(r['mapping_name'])
            or not gate._integer(r['total_rows'],1,100000)
            or not gate._integer(r['window_start'],1,r['total_rows'])
            or not gate._integer(r['window_end'],r['window_start']+1,
                                 min(r['total_rows']+1,r['window_start']+100))
            or any(not gate._hex(r[k]) for k in ('upload_sha256','inventory_sha256',
                'authority_sha256','decision_sha256','prepared_sha256'))
            or r['ready_until']!=r['created_at']+timedelta(hours=1)
            or type(r['prepared_null']) is not bool or type(r['terminal_null']) is not bool
            or not gate._integer(r['prepared_size'],0,prepare.envelope.MAX_BYTES)
            or not gate._integer(r['terminal_size'],0,prepare.terminal_codec.MAX_WIRE_BYTES)):
        raise SourceUnavailable()
    if r['original_session_id']!=session_id:
        raise SourceStale()
    prepare._check_sampled_receipt_expiry(r['observed_at'],r['expires_at'])
    if r['state']=='ready':
        if (r['prepared_null'] or r['prepared_size']==0 or not r['terminal_null']
                or r['terminal_size']!=0 or r['terminal_sha256'] is not None
                or r['apply_key'] is not None or r['committed_at'] is not None
                or r['committed_revision'] is not None or r['expires_at']!=r['ready_until']):
            raise SourceUnavailable()
    elif r['state']=='committed':
        prepare._utc(r['committed_at'])
        if (not r['prepared_null'] or r['prepared_size']!=0 or r['terminal_null']
                or r['terminal_size']==0 or not gate._hex(r['terminal_sha256'])
                or not gate._uuid(r['apply_key']) or r['apply_key']==r['prepare_key']
                or not gate._integer(r['committed_revision'],r['expected_revision'],gate._MAX)
                or r['committed_revision']-r['expected_revision'] not in (0,1)
                or not r['created_at']<=r['committed_at']<r['ready_until']
                or r['committed_at']>r['observed_at']
                or r['expires_at']!=r['committed_at']+timedelta(hours=168)):
            raise SourceUnavailable()
    else:
        raise SourceUnavailable()
    return r


def _keys(connection, scope, scalar):
    rows=source._query(connection,_KEY_SQL,_frame(scope),maximum=2)
    expected=('prepare',) if scalar['state']=='ready' else ('apply','prepare')
    if len(rows)!=len(expected):
        raise SourceUnavailable()
    earlier=scalar['observed_at']
    result=[]
    for row,operation in zip(rows,expected):
        if type(row) is not dict or tuple(row)!=_KEY_FIELDS:
            raise SourceUnavailable()
        prepare._utc(row['observed_at'])
        prepare._utc(row['created_at'])
        if (row['operation']!=operation or not gate._uuid(row['request_key'])
                or row['request_key']!=scalar[operation+'_key']
                or not gate._hex(row['command_sha256'])
                or row['original_receipt_ref']!=scope[4] or row['receipt_ref']!=scope[4]
                or row['state']!='active' or row['retired_at'] is not None
                or row['retired_reason'] is not None or row['observed_at']<earlier
                or not scalar['created_at']<=row['created_at']<=row['observed_at']):
            raise SourceUnavailable()
        earlier=row['observed_at']
        result.append((operation,row['request_key'],row['command_sha256']))
    return tuple(result),earlier


def _payload(connection, scope, scalar, *, earlier):
    terminal=scalar['state']=='committed'
    size=scalar['terminal_size'] if terminal else scalar['prepared_size']
    digest=scalar['terminal_sha256'] if terminal else scalar['prepared_sha256']
    # Admission precedes the native byte projection. Retained controls are
    # additional to the full genuine recovery/codec contribution and four
    # native/result/caller payload owners; no alias or zero-copy credit.
    phase=(prepare.terminal_codec.DECODE_CONTRIBUTION+1024 if terminal else
           prepare.envelope.recover_prepared_command_phase_bytes(size))
    prepare._private(_CONTROLS+4*size+phase)
    frame=_frame(scope+(digest,size,prepare._utc(scalar['expires_at'])))
    rows=source._query(connection,prepare._receipt_payload_sql(terminal),frame,maximum=1)
    if not rows:
        raise SourceStale()
    if (len(rows)!=1 or type(rows[0]) is not dict
            or tuple(rows[0])!=('payload','observed_at')
            or type(rows[0]['payload']) is not bytes or len(rows[0]['payload'])!=size):
        raise SourceUnavailable()
    prepare._utc(rows[0]['observed_at'])
    if rows[0]['observed_at']<earlier:
        raise SourceUnavailable()
    prepare._check_sampled_receipt_expiry(rows[0]['observed_at'],scalar['expires_at'])
    return rows[0]['payload'],rows[0]['observed_at']


def read_foobar_import_status(database_url, context, *, source_ref, generation,
                              receipt_ref, constraints=None):
    """Read only the authenticated session's persisted receipt and original keys.

    Existing rows are locked but no durable state is changed. No key, receipt,
    source observation, inventory, matching grant or Apply is created.
    Returned READY recovery is not evidence of present matching authority.
    """
    try:
        if (not gate._uuid(source_ref) or not gate._uuid(receipt_ref)
                or not gate._integer(generation,1,2147483647)):
            raise gate.PrepareInvalid()
    except (ValueError,TypeError,AttributeError):
        raise gate.PrepareInvalid() from None
    try:
        prepare._private(_CONTROLS+gate.PREPARE_GATE_BYTES)
        checked=prepare._checked_constraints(constraints)
        deadline=prepare._Deadline()
        with current_foobar_account_transaction(database_url,context,constraints=checked) as (raw,live,now):
            connection=prepare._Connection(raw,deadline)
            require_account_foobar(live,checked)
            prepare._utc(now)
            scope=(live.actor.account_id,None,source_ref,generation,receipt_ref)
            lock_frame=_frame((live.actor.account_id,None,live.actor.session_id,
                               source_ref,generation,None))
            locked=gate._stream_result(source._query(connection,gate._LOCK_SQL,lock_frame,maximum=1))
            prepare._utc(locked['observed_at'])
            if locked['observed_at']<now:
                raise SourceUnavailable()
            earlier=locked['observed_at']
            del locked
            del lock_frame
            # Unlike Prepare/Apply this read does not advance the generation or
            # high-water. An older current_generation is valid after midnight;
            # future generation/high-water values still fail closed. Existing
            # receipt generation must remain within the retained stream range.
            earlier=_clock(connection,scope,generation=generation,earlier=earlier)
            scalar=_scalar(connection,scope,session_id=live.actor.session_id,earlier=earlier)
            keys,earlier=_keys(connection,scope,scalar)
            prepare_digest=keys[-1][2]
            apply_digest=keys[0][2] if scalar['state']=='committed' else None
            body,earlier=_payload(connection,scope,scalar,earlier=earlier)
            command=terminal=outcome=review=None
            if scalar['state']=='ready':
                command,header=prepare.envelope.recover_prepared_command(body,
                    account_id=live.actor.account_id,session_id=live.actor.session_id,
                    source_ref=source_ref,generation=generation,receipt_ref=receipt_ref,
                    prepared_sha256=scalar['prepared_sha256'],decision_sha256=scalar['decision_sha256'],
                    command_sha256=prepare_digest)
                expected=(live.actor.account_id,command.matching_library_id,scalar['original_session_id'],
                    source_ref,generation,scalar['prepare_key'],receipt_ref,scalar['expected_revision'],
                    scalar['upload_sha256'],scalar['parser_version'],scalar['mapping_name'],
                    scalar['total_rows'],scalar['window_start'],scalar['window_end'],
                    scalar['inventory_sha256'],scalar['authority_sha256'],prepare._utc(scalar['created_at']))
                if header!=expected:
                    raise SourceUnavailable()
                # The recovery decoder has retired its frame. Authenticate the
                # same bounded body again before projecting its sealed review;
                # this never consults current library or binding authority.
                original=prepare.envelope.decode_prepared_envelope(body,
                    original_command=command,expected_header=header,
                    prepared_sha256=scalar['prepared_sha256'],
                    decision_sha256=scalar['decision_sha256'])
                review=prepare._association_review(original)
                del original
                del header,expected,body
            else:
                if hashlib.sha256(body).hexdigest()!=scalar['terminal_sha256']:
                    raise SourceUnavailable()
                expected=(prepare.terminal_codec.VERSION,prepare.terminal_codec.terminal_scope_sha256(
                    live.actor.account_id,source_ref,generation),source_ref,receipt_ref,scalar['prepare_key'],
                    scalar['apply_key'],scalar['prepared_sha256'],scalar['decision_sha256'],
                    scalar['upload_sha256'],scalar['inventory_sha256'],scalar['authority_sha256'],
                    scalar['expected_revision'],scalar['committed_revision'],scalar['total_rows'],
                    scalar['window_start'],scalar['window_end'],generation)
                outcome=prepare.terminal_codec.decode_foobar_terminal(body,expected_header=expected)
                terminal=body
                del expected,body
            # Re-read actual durable associations, not a fabricated gate ticket.
            # Small recovered outputs and terminal occurrences fit _CONTROLS.
            prepare._private(_CONTROLS+gate.PREPARE_GATE_BYTES)
            require_account_foobar(live,checked)
            scalar2=_scalar(connection,scope,session_id=live.actor.session_id,earlier=earlier)
            keys2,earlier=_keys(connection,scope,scalar2)
            if keys2!=keys or any(scalar2[k]!=scalar[k] for k in _SCALAR_FIELDS if k!='observed_at'):
                raise SourceUnavailable()
            _clock(connection,scope,generation=generation,earlier=earlier,expires_at=scalar['expires_at'])
            require_account_foobar(live,checked)
            deadline.check()
            result=FoobarReceiptStatus(source_ref,generation,receipt_ref,scalar['state'],
                scalar['original_session_id'],scalar['prepare_key'],prepare_digest,scalar['apply_key'],
                apply_digest,scalar['prepared_sha256'],scalar['decision_sha256'],scalar['expires_at'],
                command,terminal,outcome,review)
        deadline.check()
        return result
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None
