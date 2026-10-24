"""Importer-specific durable checkpoints, never an authority or scheduler shim.

All public operations use the genuine account/session transaction and source
row lock. Protocol hooks run inside actual Prepare/Apply transactions. No raw
upload is stored. A missing historical receipt is not proof of noncommit.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from uuid import UUID, uuid5

from . import foobar_account_prepare_gate as gate
from . import foobar_account_apply_command as apply_codec
from . import foobar_account_import_terminal as terminal
from .foobar_account_authority import current_foobar_account_transaction, require_account_foobar
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query
from . import foobar_snapshot_parser as parser
from .foobar_account_import_jobs_readiness import require_foobar_job_schema_on_connection

JOB_PHASE_BYTES=65536
MAX_FRAME_BYTES=4096
_COUNTERS=('unchanged_count','source_only_count','taste_only_count','both_count',
           'ratings_count','favorites_count','association_count')
_NAMESPACE=UUID('d09448ba-3bd9-5c2e-a0a4-a3a3d6e805e7')


class FoobarJobUnresolved(SourceUnavailable):
    """Original receipt/transaction cannot currently be proved safe to resume."""
    code='import_job_unresolved'


@dataclass(frozen=True,slots=True)
class FoobarJobCommand:
    source_ref: str
    job_ref: str
    upload_sha256: str
    parser_version: str
    mapping_name: str
    original_matching_library_id: int | None
    original_generation: int
    total_rows: int


@dataclass(frozen=True,slots=True)
class FoobarJobBatch:
    source_ref: str
    job_ref: str
    batch_no: int
    attempt_no: int
    original_session_id: int
    state: str
    prepare_command: gate.FoobarPrepareCommand
    apply_command: apply_codec.FoobarApplyCommand | None
    window_end: int | None
    terminal_bytes: bytes | None


@dataclass(frozen=True,slots=True)
class FoobarJobStatus:
    command: FoobarJobCommand
    version: int
    confirmed_through: int
    next_batch_no: int
    cancel_requested: bool
    disposition: str
    current_batch: FoobarJobBatch | None
    source_revision: int
    current_generation: int
    confirmed_counts: tuple


_F="""with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
 x as materialized(select (j->>'account_id')::bigint account_id,
 (j->>'source_ref')::uuid source_ref,(j->>'job_ref')::uuid job_ref,j from f)
"""
_JOB_COLUMNS="""j.job_ref::text job_ref,encode(j.upload_sha256,'hex') upload_sha256,
j.parser_version,j.mapping_name,j.original_matching_library_id,j.original_generation,
j.total_rows,j.version,j.confirmed_through,j.next_batch_no,j.cancel_requested,j.created_at,j.updated_at,
j.unchanged_count,j.source_only_count,j.taste_only_count,j.both_count,
j.ratings_count,j.favorites_count,j.association_count"""
_JOB_SQL=_F+"select "+_JOB_COLUMNS+""" from integration.foobar_import_jobs_v1 j cross join x
 where (j.account_id,j.source_ref,j.job_ref)=(x.account_id,x.source_ref,x.job_ref) for update of j"""
_INSERT_JOB_SQL=_F+"""insert into integration.foobar_import_jobs_v1
 (account_id,source_ref,job_ref,upload_sha256,parser_version,mapping_name,
 original_matching_library_id,original_generation,total_rows,version,confirmed_through,
 next_batch_no,cancel_requested,created_at,updated_at,
 unchanged_count,source_only_count,taste_only_count,both_count,ratings_count,favorites_count,association_count)
 select account_id,source_ref,job_ref,decode(j->>'upload_sha256','hex'),j->>'parser_version',
 j->>'mapping_name',(j->>'original_matching_library_id')::bigint,
 (j->>'original_generation')::bigint,(j->>'total_rows')::integer,0,0,1,false,
 clock_timestamp(),clock_timestamp(),0,0,0,0,0,0,0 from x returning job_ref::text job_ref
"""
_ATTEMPT_COLUMNS="""a.batch_no,a.attempt_no,a.generation,a.original_session_id,a.window_start,a.window_end,
a.expected_revision,encode(a.inventory_sha256,'hex') inventory_sha256,a.prepare_key::text prepare_key,
encode(a.prepare_command_sha256,'hex') prepare_command_sha256,a.apply_key::text apply_key,
encode(a.apply_command_sha256,'hex') apply_command_sha256,a.receipt_ref::text receipt_ref,
encode(a.prepared_sha256,'hex') prepared_sha256,encode(a.decision_sha256,'hex') decision_sha256,
encode(a.authority_sha256,'hex') authority_sha256,a.state,
case when octet_length(a.terminal_bytes)<=669 then a.terminal_bytes end terminal_bytes,
encode(a.terminal_sha256,'hex') terminal_sha256,a.committed_revision,a.created_at,a.updated_at"""
_ATTEMPT_SQL=_F+"select "+_ATTEMPT_COLUMNS+""" from integration.foobar_import_job_attempts_v1 a cross join x
 where (a.account_id,a.source_ref,a.job_ref,a.batch_no)=
 (x.account_id,x.source_ref,x.job_ref,(x.j->>'batch_no')::bigint)
 and (x.j->>'attempt_no' is null or a.attempt_no=(x.j->>'attempt_no')::bigint)
 order by a.attempt_no desc limit 1 for update of a"""
_FIND_PREPARE_SQL=_F+"""select a.job_ref::text job_ref,a.batch_no,a.attempt_no
 from integration.foobar_import_job_attempts_v1 a cross join x
 where (a.account_id,a.source_ref,a.generation)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint)
 and (a.prepare_key=(x.j->>'request_key')::uuid or a.apply_key=(x.j->>'request_key')::uuid)"""
_FIND_APPLY_SQL=_F+"""select a.job_ref::text job_ref,a.batch_no,a.attempt_no
 from integration.foobar_import_job_attempts_v1 a cross join x
 where (a.account_id,a.source_ref,a.generation)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint)
 and (a.receipt_ref=(x.j->>'receipt_ref')::uuid
 or a.prepare_key=(x.j->>'request_key')::uuid or a.apply_key=(x.j->>'request_key')::uuid)"""
_COLLISION_SQL=_F+"""select 1 as collision from integration.foobar_import_request_keys_v2 k cross join x
 where (k.account_id,k.source_ref,k.generation)=(x.account_id,x.source_ref,(x.j->>'generation')::bigint)
 and k.request_key in ((x.j->>'prepare_key')::uuid,(x.j->>'apply_key')::uuid)
 union all select 1 as collision from integration.foobar_import_job_attempts_v1 a cross join x
 where (a.account_id,a.source_ref,a.generation)=(x.account_id,x.source_ref,(x.j->>'generation')::bigint)
 and (a.prepare_key in ((x.j->>'prepare_key')::uuid,(x.j->>'apply_key')::uuid)
 or a.apply_key in ((x.j->>'prepare_key')::uuid,(x.j->>'apply_key')::uuid)) limit 1"""
_INSERT_ATTEMPT_SQL=_F+"""insert into integration.foobar_import_job_attempts_v1
 (account_id,source_ref,job_ref,batch_no,attempt_no,generation,original_session_id,
 window_start,expected_revision,inventory_sha256,prepare_key,prepare_command_sha256,
 apply_key,state,created_at,updated_at)
 select account_id,source_ref,job_ref,(j->>'batch_no')::bigint,(j->>'attempt_no')::bigint,
 (j->>'generation')::bigint,(j->>'session_id')::bigint,(j->>'window_start')::integer,
 (j->>'expected_revision')::bigint,decode(j->>'inventory_sha256','hex'),
 (j->>'prepare_key')::uuid,decode(j->>'prepare_command_sha256','hex'),
 (j->>'apply_key')::uuid,'claimed',clock_timestamp(),clock_timestamp() from x
 returning batch_no,attempt_no
"""
_JOB_CAS_SQL=_F+"""update integration.foobar_import_jobs_v1 j
 set version=j.version+1,confirmed_through=(x.j->>'confirmed_through')::integer,
 next_batch_no=(x.j->>'next_batch_no')::bigint,cancel_requested=(x.j->>'cancel_requested')::boolean,
 unchanged_count=(x.j->>'unchanged_count')::integer,source_only_count=(x.j->>'source_only_count')::integer,
 taste_only_count=(x.j->>'taste_only_count')::integer,both_count=(x.j->>'both_count')::integer,
 ratings_count=(x.j->>'ratings_count')::integer,favorites_count=(x.j->>'favorites_count')::integer,
 association_count=(x.j->>'association_count')::integer,
 updated_at=clock_timestamp() from x
 where (j.account_id,j.source_ref,j.job_ref,j.version)=
 (x.account_id,x.source_ref,x.job_ref,(x.j->>'expected_version')::bigint)
 returning j.version
"""
_READY_SQL=_F+"""update integration.foobar_import_job_attempts_v1 a
 set state='ready',window_end=(x.j->>'window_end')::integer,receipt_ref=(x.j->>'receipt_ref')::uuid,
 prepared_sha256=decode(x.j->>'prepared_sha256','hex'),decision_sha256=decode(x.j->>'decision_sha256','hex'),
 authority_sha256=decode(x.j->>'authority_sha256','hex'),
 apply_command_sha256=decode(x.j->>'apply_command_sha256','hex'),updated_at=clock_timestamp()
 from x where (a.account_id,a.source_ref,a.job_ref,a.batch_no,a.attempt_no)=
 (x.account_id,x.source_ref,x.job_ref,(x.j->>'batch_no')::bigint,(x.j->>'attempt_no')::bigint)
 and a.state='claimed' returning a.batch_no,a.attempt_no
"""
_CONFIRM_SQL=_F+"""update integration.foobar_import_job_attempts_v1 a
 set state='confirmed',terminal_bytes=decode(x.j->>'terminal_hex','hex'),
 committed_revision=(x.j->>'committed_revision')::bigint,updated_at=clock_timestamp()
 from x where (a.account_id,a.source_ref,a.job_ref,a.batch_no,a.attempt_no)=
 (x.account_id,x.source_ref,x.job_ref,(x.j->>'batch_no')::bigint,(x.j->>'attempt_no')::bigint)
 and a.state='ready' returning a.batch_no,a.attempt_no
"""
_DISCARD_SQL=_F+"""update integration.foobar_import_job_attempts_v1 a
 set state='discarded',updated_at=clock_timestamp() from x
 where (a.account_id,a.source_ref,a.job_ref,a.batch_no,a.attempt_no)=
 (x.account_id,x.source_ref,x.job_ref,(x.j->>'batch_no')::bigint,(x.j->>'attempt_no')::bigint)
 and a.state in ('claimed','ready') returning a.batch_no,a.attempt_no
"""

# No prepared payload leaves PostgreSQL through this bounded metadata query.
_RECEIPT_SQL=_F+"""select r.receipt_ref::text receipt_ref,r.prepare_key::text prepare_key,
 r.apply_key::text apply_key,r.original_session_id,r.state,r.expected_revision,r.committed_revision,
 encode(r.upload_sha256,'hex') upload_sha256,r.parser_version,r.mapping_name,r.total_rows,
 r.window_start,r.window_end,encode(r.inventory_sha256,'hex') inventory_sha256,
 encode(r.authority_sha256,'hex') authority_sha256,encode(r.prepared_sha256,'hex') prepared_sha256,
 encode(r.decision_sha256,'hex') decision_sha256,r.created_at,r.ready_until,r.expires_at,
 case when octet_length(r.terminal_bytes)<=669 then r.terminal_bytes end terminal_bytes,
 encode(r.terminal_sha256,'hex') terminal_sha256
 from integration.foobar_import_receipts_v2 r cross join x
 where (r.account_id,r.source_ref,r.generation,r.prepare_key)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'prepare_key')::uuid)
"""
_KEYS_SQL=_F+"""select k.request_key::text request_key,k.operation,
 encode(k.command_sha256,'hex') command_sha256,k.state,
 k.receipt_ref::text receipt_ref,k.original_receipt_ref::text original_receipt_ref
 from integration.foobar_import_request_keys_v2 k cross join x
 where (k.account_id,k.source_ref,k.generation)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint)
 and k.request_key in ((x.j->>'prepare_key')::uuid,(x.j->>'apply_key')::uuid)
 order by k.operation
"""
_TOMBSTONE_SQL=_F+"""update integration.foobar_import_request_keys_v2 k
 set state='tombstone',receipt_ref=null,retired_at=clock_timestamp(),retired_reason='discarded'
 from x where (k.account_id,k.source_ref,k.generation,k.request_key)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'prepare_key')::uuid)
 and k.operation='prepare' and k.state='active'
 and k.receipt_ref=(x.j->>'receipt_ref')::uuid
 returning k.request_key::text request_key
"""
_DELETE_READY_SQL=_F+"""delete from integration.foobar_import_receipts_v2 r using x
 where (r.account_id,r.source_ref,r.generation,r.receipt_ref)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'receipt_ref')::uuid)
 and r.prepare_key=(x.j->>'prepare_key')::uuid and r.state='ready'
 returning r.receipt_ref::text receipt_ref
"""


def _frame(live,source_ref,job_ref=None,**fields):
    if not gate._uuid(source_ref) or job_ref is not None and not gate._uuid(job_ref):
        raise SourceUnavailable()
    value=dict(account_id=live.actor.account_id,source_ref=source_ref,job_ref=job_ref,**fields)
    payload=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return payload


def _one(connection,sql,frame,*,optional=False):
    rows=_query(connection,sql,frame,maximum=1)
    if not rows and optional:
        return None
    if len(rows)!=1 or type(rows[0]) is not dict:
        raise SourceUnavailable()
    return rows[0]


def require_job_schema_on_connection(connection):
    """Required final-account-import dependency, never schema creation/proof."""
    require_foobar_job_schema_on_connection(connection)


def _stream(connection,live,source_ref,*,roll=False):
    frame=json.dumps((live.actor.account_id,None,live.actor.session_id,source_ref,1,None),
                     separators=(',',':')).encode('ascii')
    stream=gate._stream_result(_query(connection,gate._LOCK_SQL,frame,maximum=1))
    if roll:
        stream=gate._stream_result(_query(connection,gate._ROLL_SQL,frame,maximum=1))
    return stream


def _command(value):
    if (type(value) is not FoobarJobCommand or not gate._uuid(value.source_ref)
            or not gate._uuid(value.job_ref) or not gate._hex(value.upload_sha256)
            or value.mapping_name not in (gate.MAPPING,gate.ENHANCED_MAPPING)
            or value.parser_version!=gate.parser_for_mapping(value.mapping_name)
            or not gate._integer(value.original_generation,1,2147483647)
            or not gate._integer(value.total_rows,1,100000)
            or value.original_matching_library_id is not None
                and not gate._integer(value.original_matching_library_id,1,gate._MAX)):
        raise gate.PrepareInvalid()


def _job(connection,live,source_ref,job_ref,*,optional=False):
    row=_one(connection,_JOB_SQL,_frame(live,source_ref,job_ref),optional=optional)
    if row is None:
        return None
    keys={'job_ref','upload_sha256','parser_version','mapping_name','original_matching_library_id',
          'original_generation','total_rows','version','confirmed_through','next_batch_no',
          'cancel_requested','created_at','updated_at'}|set(_COUNTERS)
    if set(row)!=keys or row['job_ref']!=job_ref:
        raise SourceUnavailable()
    _command(_job_command(source_ref,row))
    if (not gate._integer(row['version'],0,gate._MAX)
            or not gate._integer(row['confirmed_through'],0,row['total_rows'])
            or not gate._integer(row['next_batch_no'],1,100001)
            or row['next_batch_no']>row['confirmed_through']+1
            or type(row['cancel_requested']) is not bool):
        raise SourceUnavailable()
    _times(row)
    counts=tuple(row[k] for k in _COUNTERS)
    if (any(not gate._integer(n,0,row['total_rows']) for n in counts)
            or sum(counts[:4])!=row['confirmed_through']
            or counts[4]>counts[2]+counts[3] or counts[5]>counts[2]+counts[3]
            or counts[4]+counts[5]<counts[2]+counts[3]
            or counts[6]>row['confirmed_through']):
        raise SourceUnavailable()
    return row


def _job_command(source_ref,row):
    return FoobarJobCommand(source_ref,row['job_ref'],row['upload_sha256'],row['parser_version'],
        row['mapping_name'],row['original_matching_library_id'],row['original_generation'],row['total_rows'])


def _times(row):
    if any(type(row[k]) is not datetime or row[k].tzinfo is None
           or row[k].utcoffset().total_seconds()!=0 for k in ('created_at','updated_at')):
        raise SourceUnavailable()
    if row['updated_at']<row['created_at']:
        raise SourceUnavailable()


def _attempt(connection,live,source_ref,job,*,batch_no=None,attempt_no=None):
    batch_no=job['next_batch_no'] if batch_no is None else batch_no
    if not gate._integer(batch_no,1,100000) or attempt_no is not None and not gate._integer(attempt_no,1,gate._MAX):
        raise SourceUnavailable()
    row=_one(connection,_ATTEMPT_SQL,_frame(live,source_ref,job['job_ref'],
        batch_no=batch_no,attempt_no=attempt_no),optional=True)
    if row is None:
        return None
    keys={'batch_no','attempt_no','generation','original_session_id','window_start','window_end',
          'expected_revision','inventory_sha256','prepare_key','prepare_command_sha256','apply_key',
          'apply_command_sha256','receipt_ref','prepared_sha256','decision_sha256','authority_sha256',
          'state','terminal_bytes','terminal_sha256','committed_revision','created_at','updated_at'}
    if (set(row)!=keys or row['batch_no']!=batch_no
            or not gate._integer(row['attempt_no'],1,gate._MAX)
            or attempt_no is not None and row['attempt_no']!=attempt_no
            or not gate._integer(row['generation'],1,2147483647)
            or not gate._integer(row['original_session_id'],1,gate._MAX)
            or not gate._integer(row['window_start'],1,job['total_rows'])
            or not gate._integer(row['expected_revision'],0,gate._MAX)
            or row['state'] not in ('claimed','ready','confirmed','discarded')):
        raise SourceUnavailable()
    for key in ('inventory_sha256','prepare_command_sha256'):
        if not gate._hex(row[key]): raise SourceUnavailable()
    if not gate._uuid(row['prepare_key']) or not gate._uuid(row['apply_key']) or row['prepare_key']==row['apply_key']:
        raise SourceUnavailable()
    bound=row['receipt_ref'] is not None
    for key in ('prepared_sha256','decision_sha256','authority_sha256','apply_command_sha256'):
        if (bound and not gate._hex(row[key])) or (not bound and row[key] is not None):
            raise SourceUnavailable()
    if bound:
        if (not gate._uuid(row['receipt_ref']) or not gate._integer(row['window_end'],row['window_start']+1,
                min(job['total_rows']+1,row['window_start']+100)) or row['state']=='claimed'):
            raise SourceUnavailable()
    elif row['window_end'] is not None or row['state'] in ('ready','confirmed'):
        raise SourceUnavailable()
    if row['state']=='confirmed':
        _cached_terminal(live,source_ref,job,row)
    elif any(row[k] is not None for k in ('terminal_bytes','terminal_sha256','committed_revision')):
        raise SourceUnavailable()
    _times(row)
    cmd=_prepare_command(source_ref,job,row)
    if gate.prepare_command_digest(cmd,account_id=live.actor.account_id,
            library_id=job['original_matching_library_id'],session_id=row['original_session_id'])!=row['prepare_command_sha256']:
        raise SourceUnavailable()
    if bound and apply_codec.apply_command_digest(_apply_command(source_ref,job,row),
            account_id=live.actor.account_id,library_id=job['original_matching_library_id'],
            session_id=row['original_session_id'])!=row['apply_command_sha256']:
        raise SourceUnavailable()
    return row


def _prepare_command(source_ref,job,a):
    return gate.FoobarPrepareCommand(source_ref,a['generation'],a['prepare_key'],a['expected_revision'],
        job['upload_sha256'],job['mapping_name'],a['window_start']-1,a['inventory_sha256'],
        job['original_matching_library_id'])


def _apply_command(source_ref,job,a):
    return apply_codec.FoobarApplyCommand(source_ref,a['generation'],a['apply_key'],a['receipt_ref'],
                                        a['decision_sha256'],job['original_matching_library_id'])


def _batch(source_ref,job,a):
    if a is None: return None
    return FoobarJobBatch(source_ref,job['job_ref'],a['batch_no'],a['attempt_no'],a['original_session_id'],
        a['state'],_prepare_command(source_ref,job,a),None if a['receipt_ref'] is None else _apply_command(source_ref,job,a),
        a['window_end'],a['terminal_bytes'])


def _keys(job_ref,batch_no,attempt_no):
    stem=f'{job_ref}:{batch_no}:{attempt_no}'
    return (str(uuid5(_NAMESPACE,'prepare:'+stem)),str(uuid5(_NAMESPACE,'apply:'+stem)))


def _cas(connection,live,source_ref,job,*,confirmed_through=None,next_batch_no=None,cancel_requested=None,counts=None):
    if job['version']==gate._MAX: raise SourceUnavailable()
    row=_one(connection,_JOB_CAS_SQL,_frame(live,source_ref,job['job_ref'],
        expected_version=job['version'],confirmed_through=job['confirmed_through'] if confirmed_through is None else confirmed_through,
        next_batch_no=job['next_batch_no'] if next_batch_no is None else next_batch_no,
        cancel_requested=job['cancel_requested'] if cancel_requested is None else cancel_requested,
        **{key:job[key] if counts is None else counts[i] for i,key in enumerate(_COUNTERS)}))
    if row!={'version':job['version']+1} or type(row['version']) is not int:
        raise SourceUnavailable()


def _pair_result(row,a):
    if row!={'batch_no':a['batch_no'],'attempt_no':a['attempt_no']} or any(type(v) is not int for v in row.values()):
        raise SourceUnavailable()


def _terminal_header(live,source_ref,job,a,committed_revision):
    return (terminal.VERSION,terminal.terminal_scope_sha256(live.actor.account_id,source_ref,a['generation']),
        source_ref,a['receipt_ref'],a['prepare_key'],a['apply_key'],a['prepared_sha256'],a['decision_sha256'],
        job['upload_sha256'],a['inventory_sha256'],a['authority_sha256'],a['expected_revision'],
        committed_revision,job['total_rows'],a['window_start'],a['window_end'],a['generation'])


def _cached_terminal(live,source_ref,job,a):
    body=a['terminal_bytes']
    if (type(body) is not bytes or not 1<=len(body)<=terminal.MAX_WIRE_BYTES
            or not gate._hex(a['terminal_sha256']) or sha256(body).hexdigest()!=a['terminal_sha256']
            or not gate._integer(a['committed_revision'],a['expected_revision'],
                                  min(gate._MAX,a['expected_revision']+1))):
        raise SourceUnavailable()
    try:
        outcome=terminal.decode_foobar_terminal(body,expected_header=_terminal_header(
            live,source_ref,job,a,a['committed_revision']))
    except terminal.FoobarTerminalUnavailable:
        raise SourceUnavailable() from None
    if job['original_matching_library_id'] is None and any(outcome[i] for i in (18,19,20,21,22)):
        raise SourceUnavailable()
    return body


def _receipt(connection,live,source_ref,job,a):
    row=_one(connection,_RECEIPT_SQL,_frame(live,source_ref,job['job_ref'],
        generation=a['generation'],prepare_key=a['prepare_key']),optional=True)
    if row is None: return None
    keys={'receipt_ref','prepare_key','apply_key','original_session_id','state','expected_revision',
          'committed_revision','upload_sha256','parser_version','mapping_name','total_rows',
          'window_start','window_end','inventory_sha256','authority_sha256','prepared_sha256',
          'decision_sha256','created_at','ready_until','expires_at','terminal_bytes','terminal_sha256'}
    if set(row)!=keys or row['state'] not in ('ready','committed'):
        raise SourceUnavailable()
    exact={'prepare_key':a['prepare_key'],'original_session_id':a['original_session_id'],
           'expected_revision':a['expected_revision'],'upload_sha256':job['upload_sha256'],
           'parser_version':job['parser_version'],'mapping_name':job['mapping_name'],
           'total_rows':job['total_rows'],'window_start':a['window_start'],
           'inventory_sha256':a['inventory_sha256']}
    if any(type(row[k]) is not type(v) or row[k]!=v for k,v in exact.items()):
        raise SourceUnavailable()
    if (not gate._uuid(row['receipt_ref']) or not gate._integer(row['window_end'],a['window_start']+1,
            min(job['total_rows']+1,a['window_start']+100))
            or any(not gate._hex(row[k]) for k in ('authority_sha256','prepared_sha256','decision_sha256'))):
        raise SourceUnavailable()
    if a['receipt_ref'] is not None and any(row[k]!=a[k] for k in
            ('receipt_ref','window_end','prepared_sha256','decision_sha256','authority_sha256')):
        raise SourceUnavailable()
    bound=dict(a,**{k:row[k] for k in ('receipt_ref','window_end','prepared_sha256','decision_sha256','authority_sha256')})
    bound['apply_command_sha256']=apply_codec.apply_command_digest(_apply_command(source_ref,job,bound),
        account_id=live.actor.account_id,library_id=job['original_matching_library_id'],session_id=a['original_session_id'])
    key_rows=_query(connection,_KEYS_SQL,_frame(live,source_ref,job['job_ref'],
        generation=a['generation'],prepare_key=a['prepare_key'],apply_key=a['apply_key']),maximum=2)
    expected=[dict(request_key=a['prepare_key'],operation='prepare',command_sha256=a['prepare_command_sha256'],
        state='active',receipt_ref=row['receipt_ref'],original_receipt_ref=row['receipt_ref'])]
    if row['state']=='committed':
        if row['apply_key']!=a['apply_key']:
            raise SourceUnavailable()
        expected.insert(0,dict(request_key=a['apply_key'],operation='apply',command_sha256=bound['apply_command_sha256'],
            state='active',receipt_ref=row['receipt_ref'],original_receipt_ref=row['receipt_ref']))
        bound.update(terminal_bytes=row['terminal_bytes'],terminal_sha256=row['terminal_sha256'],
                     committed_revision=row['committed_revision'])
        _cached_terminal(live,source_ref,job,bound)
    elif any(row[k] is not None for k in ('apply_key','committed_revision','terminal_bytes','terminal_sha256')):
        raise SourceUnavailable()
    if key_rows!=expected:
        raise SourceUnavailable()
    return row,bound


def _record(connection,live,source_ref,job,a):
    if a['state']=='discarded': raise SourceStale()
    if a['state']=='confirmed':
        if job['confirmed_through']<a['window_end']-1 or job['next_batch_no']<=a['batch_no']:
            raise SourceUnavailable()
        return a
    proof=_receipt(connection,live,source_ref,job,a)
    if proof is None:
        raise FoobarJobUnresolved()
    row,bound=proof
    if (job['confirmed_through']!=a['window_start']-1 or job['next_batch_no']!=a['batch_no']):
        raise SourceStale()
    if a['state']=='claimed':
        _pair_result(_one(connection,_READY_SQL,_frame(live,source_ref,job['job_ref'],
            batch_no=a['batch_no'],attempt_no=a['attempt_no'],window_end=bound['window_end'],
            receipt_ref=bound['receipt_ref'],prepared_sha256=bound['prepared_sha256'],
            decision_sha256=bound['decision_sha256'],authority_sha256=bound['authority_sha256'],
            apply_command_sha256=bound['apply_command_sha256'])),a)
        bound['state']='ready'
    if row['state']=='committed':
        _pair_result(_one(connection,_CONFIRM_SQL,_frame(live,source_ref,job['job_ref'],
            batch_no=a['batch_no'],attempt_no=a['attempt_no'],terminal_hex=row['terminal_bytes'].hex(),
            committed_revision=row['committed_revision'])),a)
        outcome=terminal.decode_foobar_terminal(row['terminal_bytes'],expected_header=_terminal_header(
            live,source_ref,job,bound,row['committed_revision']))
        counts=tuple(job[key]+outcome[16+i] for i,key in enumerate(_COUNTERS))
        _cas(connection,live,source_ref,job,confirmed_through=bound['window_end']-1,
             next_batch_no=a['batch_no']+1,counts=counts)
        bound['state']='confirmed'
    elif a['state']=='claimed':
        _cas(connection,live,source_ref,job)
    return bound


def _discover(connection,live,*,command,operation):
    require_job_schema_on_connection(connection)
    if operation=='prepare':
        gate.validate_prepare_command(command)
        sql=_FIND_PREPARE_SQL
        fields=dict(generation=command.generation,request_key=command.request_key)
    elif operation=='apply':
        apply_codec.validate_apply_command(command)
        sql=_FIND_APPLY_SQL
        fields=dict(generation=command.generation,receipt_ref=command.receipt_ref,request_key=command.request_key)
    else:
        raise SourceUnavailable()
    found=_one(connection,sql,_frame(live,command.source_ref,**fields),optional=True)
    if found is None: return None
    if (set(found)!={'job_ref','batch_no','attempt_no'} or not gate._uuid(found['job_ref'])
            or not gate._integer(found['batch_no'],1,100000)
            or not gate._integer(found['attempt_no'],1,gate._MAX)):
        raise SourceUnavailable()
    job=_job(connection,live,command.source_ref,found['job_ref'])
    a=_attempt(connection,live,command.source_ref,job,batch_no=found['batch_no'],attempt_no=found['attempt_no'])
    if a is None: raise SourceUnavailable()
    expected=_prepare_command(command.source_ref,job,a) if operation=='prepare' else _apply_command(command.source_ref,job,a)
    if command!=expected or live.actor.session_id!=a['original_session_id']:
        raise SourceStale()
    if a['state']=='discarded': raise SourceStale()
    if a['state']!='confirmed':
        if (job['cancel_requested'] or job['next_batch_no']!=a['batch_no']
                or job['confirmed_through']!=a['window_start']-1):
            raise SourceStale()
        latest=_attempt(connection,live,command.source_ref,job)
        if latest is None or latest['attempt_no']!=a['attempt_no']:
            raise SourceStale()
    return job,a


def guard_foobar_job_protocol_on_connection(connection,live,*,command,operation,constraints=None):
    """Actual protocol guard, invoked after its source lock and before writes."""
    require_account_foobar(live,constraints)
    _stream(connection,live,command.source_ref)
    _discover(connection,live,command=command,operation=operation)
    require_account_foobar(live,constraints)


def record_foobar_job_protocol_on_connection(connection,live,*,command,operation,constraints=None):
    """Read real receipt and checkpoint within the same outer commit, never a flag."""
    require_account_foobar(live,constraints)
    _stream(connection,live,command.source_ref)
    found=_discover(connection,live,command=command,operation=operation)
    if found is not None:
        job,a=found
        _record(connection,live,command.source_ref,job,a)
    require_account_foobar(live,constraints)


@dataclass(frozen=True,slots=True)
class FoobarJobReconciliation:
    disposition: str
    status: FoobarJobStatus
    batch: FoobarJobBatch


def _status(connection,live,source_ref,job):
    complete=job['confirmed_through']==job['total_rows']
    a=None if complete else _attempt(connection,live,source_ref,job)
    disposition=('completed' if complete else 'cancelled' if job['cancel_requested'] else
        'needs_file' if a is None or a['state']=='discarded' else
        'needs_resume' if a['original_session_id']!=live.actor.session_id else a['state'])
    stream=_stream(connection,live,source_ref)
    return FoobarJobStatus(_job_command(source_ref,job),job['version'],job['confirmed_through'],
        job['next_batch_no'],job['cancel_requested'],disposition,_batch(source_ref,job,a),
        stream['revision'],stream['current_generation'],tuple(job[k] for k in _COUNTERS))


def start_foobar_import_job(database_url,context,*,command,constraints=None):
    """Create/idempotently select exact job identity; does not claim preflight passed."""
    _command(command)
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        stream=_stream(connection,live,command.source_ref,roll=True)
        job=_job(connection,live,command.source_ref,command.job_ref,optional=True)
        if job is not None:
            if _job_command(command.source_ref,job)!=command: raise SourceStale()
        else:
            if command.original_generation!=stream['current_generation']:
                raise SourceStale()
            fields={name:getattr(command,name) for name in (
                'upload_sha256','parser_version','mapping_name','original_matching_library_id','original_generation','total_rows')}
            row=_one(connection,_INSERT_JOB_SQL,_frame(live,command.source_ref,command.job_ref,**fields))
            if row!={'job_ref':command.job_ref}: raise SourceUnavailable()
            job=_job(connection,live,command.source_ref,command.job_ref)
        result=_status(connection,live,command.source_ref,job)
    return result


def read_foobar_import_job(database_url,context,*,source_ref,job_ref,constraints=None):
    """Bounded account-only status: one job and at most one current attempt."""
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        _stream(connection,live,source_ref)
        job=_job(connection,live,source_ref,job_ref)
        result=_status(connection,live,source_ref,job)
    return result


def cancel_foobar_import_job(database_url,context,*,source_ref,job_ref,constraints=None):
    """Pause future work only after any current source transaction has settled."""
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        _stream(connection,live,source_ref)
        job=_job(connection,live,source_ref,job_ref)
        if not job['cancel_requested'] and job['confirmed_through']<job['total_rows']:
            _cas(connection,live,source_ref,job,cancel_requested=True)
            job=_job(connection,live,source_ref,job_ref)
        result=_status(connection,live,source_ref,job)
    return result


def claim_next_foobar_job_batch(database_url,context,*,source_ref,job_ref,inventory_sha256,
        expected_revision,expected_generation,constraints=None):
    """Allocate one stable attempt; no queue and no automatic old-session replacement.

    Inventory hash is original command data, not authority. Actual indexed
    Prepare checks it against genuine current native inventory and policy.
    """
    if (not gate._hex(inventory_sha256) or not gate._integer(expected_revision,0,gate._MAX)
            or not gate._integer(expected_generation,1,2147483647)):
        raise gate.PrepareInvalid()
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        stream=_stream(connection,live,source_ref,roll=True)
        if stream['revision']!=expected_revision or stream['current_generation']!=expected_generation:
            raise SourceStale()
        job=_job(connection,live,source_ref,job_ref)
        if job['cancel_requested'] or job['confirmed_through']==job['total_rows']:
            raise SourceStale()
        a=_attempt(connection,live,source_ref,job)
        if a is not None and a['state']!='discarded':
            if (a['original_session_id']!=live.actor.session_id or a['inventory_sha256']!=inventory_sha256
                    or a['expected_revision']!=expected_revision or a['generation']!=expected_generation
                    or not stream['retired_through']<a['generation']<=stream['current_generation']):
                raise SourceStale()
            result=_batch(source_ref,job,a)
        else:
            attempt_no=1 if a is None else a['attempt_no']+1
            if attempt_no>gate._MAX: raise SourceUnavailable()
            prepare_key,apply_key=_keys(job_ref,job['next_batch_no'],attempt_no)
            if _query(connection,_COLLISION_SQL,_frame(live,source_ref,job_ref,
                    generation=stream['current_generation'],prepare_key=prepare_key,apply_key=apply_key),maximum=1):
                raise SourceStale()
            cmd=gate.FoobarPrepareCommand(source_ref,stream['current_generation'],prepare_key,stream['revision'],
                job['upload_sha256'],job['mapping_name'],job['confirmed_through'],inventory_sha256,
                job['original_matching_library_id'])
            digest=gate.prepare_command_digest(cmd,account_id=live.actor.account_id,
                library_id=job['original_matching_library_id'],session_id=live.actor.session_id)
            fields=dict(batch_no=job['next_batch_no'],attempt_no=attempt_no,generation=cmd.generation,
                session_id=live.actor.session_id,window_start=cmd.offset+1,expected_revision=cmd.expected_revision,
                inventory_sha256=inventory_sha256,prepare_key=prepare_key,apply_key=apply_key,
                prepare_command_sha256=digest)
            row=_one(connection,_INSERT_ATTEMPT_SQL,_frame(live,source_ref,job_ref,**fields))
            _pair_result(row,fields)
            _cas(connection,live,source_ref,job)
            job=_job(connection,live,source_ref,job_ref)
            a=_attempt(connection,live,source_ref,job)
            result=_batch(source_ref,job,a)
    return result


def reconcile_foobar_job_batch(database_url,context,*,source_ref,job_ref,batch_no,attempt_no,constraints=None):
    """Current authenticated account reads original proof, never impersonates session."""
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        stream=_stream(connection,live,source_ref)
        job=_job(connection,live,source_ref,job_ref)
        a=_attempt(connection,live,source_ref,job,batch_no=batch_no,attempt_no=attempt_no)
        if a is None: raise FoobarJobUnresolved()
        if a['state']=='confirmed':
            # _attempt has validated the retained terminal. Also require the
            # atomic job prefix to include it; never report contradictory proof.
            _record(connection,live,source_ref,job,a)
            disposition='confirmed'
        elif a['state']=='discarded':
            disposition='discarded'
        else:
            proof=_receipt(connection,live,source_ref,job,a)
            if proof is None:
                # Even a still-claimed row is not silently converted to a fresh
                # attempt. Resume has a stricter exact-key/generation fence.
                disposition='unresolved'
            else:
                a=_record(connection,live,source_ref,job,a)
                job=_job(connection,live,source_ref,job_ref)
                disposition='confirmed' if a['state']=='confirmed' else 'ready'
        result=FoobarJobReconciliation(disposition,_status(connection,live,source_ref,job),_batch(source_ref,job,a))
    return result


def resume_foobar_import_job(database_url,context,*,source_ref,job_ref,constraints=None):
    """Explicit current-session resume after exact reconciliation/fencing.

    No upload or native library authority is inferred. The caller must reselect
    the identical file after restart, rerun current preflight, then claim work.
    Old-session READY commands are never adopted as current-session authority.
    """
    with current_foobar_account_transaction(database_url,context,constraints=constraints) as (connection,live,now):
        require_job_schema_on_connection(connection)
        stream=_stream(connection,live,source_ref,roll=True)
        job=_job(connection,live,source_ref,job_ref)
        if job['confirmed_through']==job['total_rows']:
            result=_status(connection,live,source_ref,job)
        else:
            a=_attempt(connection,live,source_ref,job)
            if a is not None and a['state'] not in ('confirmed','discarded'):
                proof=_receipt(connection,live,source_ref,job,a)
                if proof is not None and proof[0]['state']=='committed':
                    _record(connection,live,source_ref,job,a)
                    job=_job(connection,live,source_ref,job_ref)
                else:
                    # Holding the actual source lock proves no Apply/Prepare is
                    # still in-flight; lock timeout instead aborts this operation.
                    if not stream['retired_through']<a['generation']<=stream['current_generation']:
                        raise FoobarJobUnresolved()
                    if proof is None:
                        keys=_query(connection,_KEYS_SQL,_frame(live,source_ref,job_ref,
                            generation=a['generation'],prepare_key=a['prepare_key'],apply_key=a['apply_key']),maximum=2)
                        # Never infer noncommit from receipt absence alone. A
                        # still-claimed atomic-hook row plus no exact retained
                        # keys in a live generation is the only empty case.
                        if a['state']!='claimed' or keys:
                            raise FoobarJobUnresolved()
                    else:
                        receipt,bound=proof
                        if receipt['state']!='ready': raise FoobarJobUnresolved()
                        # Existing receipt guard explicitly allows READY delete;
                        # existing key transition preserves its original digest.
                        _pair=dict(generation=a['generation'],prepare_key=a['prepare_key'],receipt_ref=receipt['receipt_ref'])
                        changed=_one(connection,_TOMBSTONE_SQL,_frame(live,source_ref,job_ref,**_pair))
                        if changed!={'request_key':a['prepare_key']}: raise SourceUnavailable()
                        deleted=_one(connection,_DELETE_READY_SQL,_frame(live,source_ref,job_ref,**_pair))
                        if deleted!={'receipt_ref':receipt['receipt_ref']}: raise SourceUnavailable()
                    _pair_result(_one(connection,_DISCARD_SQL,_frame(live,source_ref,job_ref,
                        batch_no=a['batch_no'],attempt_no=a['attempt_no'])),a)
            # A source erased during account cleanup cannot reach here: its
            # source/job rows are required and are never recreated by resume.
            _cas(connection,live,source_ref,job,cancel_requested=False)
            job=_job(connection,live,source_ref,job_ref)
            result=_status(connection,live,source_ref,job)
    return result
