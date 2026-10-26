"""Bounded replay-metadata expiry. Never deletes imported history or jobs.

Inactive source preparation: caller must reserve MAINTENANCE_PHASE_BYTES and
dispatch through the existing single worker. No automatic retry on uncertainty.
"""
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta

from . import foobar_account_import_jobs as jobs
from .foobar_account_authority import current_foobar_account_transaction
from .foobar_account_source_postgres import SourceUnavailable, _query
from . import foobar_account_import_readiness as import_readiness

MAX_RECEIPTS = 20
MAX_KEYS = 100
MAINTENANCE_PHASE_BYTES = 262144


@dataclass(frozen=True, slots=True)
class MaintenanceCursor:
    expires_at: str
    generation: int
    receipt_ref: str


@dataclass(frozen=True, slots=True)
class MaintenanceRequest:
    source_ref: str
    cursor: MaintenanceCursor | None = None


@dataclass(frozen=True, slots=True)
class MaintenanceResult:
    source_ref: str
    inspected: int
    removed_receipts: int
    protected_receipts: int
    removed_keys: int
    retired_through: int
    next_cursor: MaintenanceCursor | None
    more_retired_keys: bool


def _timestamp(value):
    if type(value) is not datetime or value.tzinfo is None:
        raise SourceUnavailable()
    return value.astimezone(timezone.utc).isoformat(timespec='microseconds')


def validate_request(request):
    try:
        if type(request) is not MaintenanceRequest or not jobs.gate._uuid(request.source_ref):
            raise ValueError()
        c = request.cursor
        if c is not None:
            if (type(c) is not MaintenanceCursor or not jobs.gate._uuid(c.receipt_ref)
                    or not jobs.gate._integer(c.generation, 1, 2147483647)
                    or type(c.expires_at) is not str or len(c.expires_at) != 32
                    or _timestamp(datetime.fromisoformat(c.expires_at)) != c.expires_at):
                raise ValueError()
    except (ValueError, TypeError, AttributeError, SourceUnavailable):
        raise jobs.gate.PrepareInvalid() from None


_F = jobs._F
_CANDIDATES = _F + """select r.expires_at,r.generation,r.receipt_ref::text receipt_ref,
 r.prepare_key::text prepare_key,r.apply_key::text apply_key,r.state,
 r.created_at,r.ready_until,r.committed_at
 from integration.foobar_import_receipts_v2 r
 where r.account_id=(select account_id from x) and r.source_ref=(select source_ref from x)
 and r.expires_at <= (select (j->>'observed_at')::timestamptz from x)
 {after}
 order by r.expires_at,r.generation,r.receipt_ref limit 21"""
_AFTER = """and (r.expires_at,r.generation,r.receipt_ref) >
 ((select (j->>'expires_at')::timestamptz from x),
  (select (j->>'generation')::bigint from x),(select (j->>'receipt_ref')::uuid from x))"""
_JOB_OWNER = _F + """select a.job_ref::text job_ref,a.batch_no,a.attempt_no
 from integration.foobar_import_job_attempts_v1 a
 where a.account_id=(select account_id from x) and a.source_ref=(select source_ref from x)
 and a.generation=(select (j->>'generation')::bigint from x)
 and a.prepare_key=(select (j->>'prepare_key')::uuid from x) limit 2"""
_KEYS = _F + """select k.request_key::text request_key,k.operation,k.state,
 k.receipt_ref::text receipt_ref,k.original_receipt_ref::text original_receipt_ref
 from integration.foobar_import_request_keys_v2 k
 where k.account_id=(select account_id from x) and k.source_ref=(select source_ref from x)
 and k.generation=(select (j->>'generation')::bigint from x)
 and k.original_receipt_ref=(select (j->>'receipt_ref')::uuid from x)
 order by k.operation limit 3"""
_TOMBSTONE = _F + """update integration.foobar_import_request_keys_v2 k
 set state='tombstone',receipt_ref=null,retired_at=clock_timestamp(),retired_reason='expired'
 from x where (k.account_id,k.source_ref,k.generation,k.request_key)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'request_key')::uuid)
 and k.state='active' and k.receipt_ref=(x.j->>'receipt_ref')::uuid
 returning k.request_key::text request_key"""
_DELETE_RECEIPT = _F + """delete from integration.foobar_import_receipts_v2 r using x
 where (r.account_id,r.source_ref,r.generation,r.receipt_ref)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'receipt_ref')::uuid)
 and r.expires_at <= (x.j->>'observed_at')::timestamptz
 returning r.receipt_ref::text receipt_ref"""
_OLDEST_RECEIPT = _F + """select r.generation from integration.foobar_import_receipts_v2 r
 where r.account_id=(select account_id from x) and r.source_ref=(select source_ref from x)
 order by r.generation,r.expires_at,r.receipt_ref limit 1"""
_OLDEST_JOB = _F + """select a.generation from integration.foobar_import_job_attempts_v1 a
 where a.account_id=(select account_id from x) and a.source_ref=(select source_ref from x)
 and a.state='{state}' order by a.generation limit 1"""
_RETIRE = _F + """update integration.foobar_import_streams_v2 s
 set retired_through=(x.j->>'floor')::bigint,updated_at=clock_timestamp()
 from x where (s.account_id,s.source_ref)=(x.account_id,x.source_ref)
 and s.retired_through <= (x.j->>'floor')::bigint
 and s.current_generation > (x.j->>'floor')::bigint
 returning s.retired_through"""
_RETIRED_KEYS = _F + """select k.generation,k.request_key::text request_key,k.state
 from integration.foobar_import_request_keys_v2 k
 where k.account_id=(select account_id from x) and k.source_ref=(select source_ref from x)
 and k.generation <= (select (j->>'floor')::bigint from x)
 order by k.generation,k.request_key limit 101"""
_DELETE_KEY = _F + """delete from integration.foobar_import_request_keys_v2 k using x
 where (k.account_id,k.source_ref,k.generation,k.request_key)=
 (x.account_id,x.source_ref,(x.j->>'generation')::bigint,(x.j->>'request_key')::uuid)
 and k.state='tombstone' and k.generation <= (x.j->>'floor')::bigint
 returning k.request_key::text request_key"""

_INDEXES = """with expected(tab,cols,uniq) as (values
 ('foobar_import_receipts_v2',array['account_id','source_ref','expires_at','generation','receipt_ref']::text[],false),
 ('foobar_import_receipts_v2',array['account_id','source_ref','generation','expires_at','receipt_ref']::text[],false),
 ('foobar_import_request_keys_v2',array['account_id','source_ref','generation','request_key']::text[],true),
 ('foobar_import_request_keys_v2',array['account_id','source_ref','generation','original_receipt_ref','operation']::text[],true),
 ('foobar_import_job_attempts_v1',array['account_id','source_ref','generation','prepare_key']::text[],true),
 ('foobar_import_job_attempts_v1',array['account_id','source_ref','state','generation']::text[],false)
 ) select not exists(select 1 from expected e where not exists(
 select 1 from pg_catalog.pg_index i
 join pg_catalog.pg_class r on r.oid=i.indrelid
 join pg_catalog.pg_namespace n on n.oid=r.relnamespace
 join pg_catalog.pg_class ix on ix.oid=i.indexrelid
 join pg_catalog.pg_am am on am.oid=ix.relam
 where n.nspname='integration' and r.relname=e.tab and am.amname='btree'
 and i.indisvalid and i.indisready and i.indislive and (not e.uniq or i.indisunique)
 and i.indpred is null and i.indexprs is null
 and i.indnkeyatts=cardinality(e.cols) and i.indnatts=i.indnkeyatts
 and (select array_agg(a.attname::text order by k.ordinality)
 from unnest(i.indkey) with ordinality k(attnum,ordinality)
 join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.attnum)=e.cols
 and (select bool_and(v=0) from unnest(i.indoption) v)
 and not exists(select 1 from unnest(i.indclass) opid
 join pg_catalog.pg_opclass op on op.oid=opid
 join pg_catalog.pg_namespace ns on ns.oid=op.opcnamespace
 where not op.opcdefault or ns.nspname<>'pg_catalog')
 and not exists(select 1 from unnest(i.indcollation) with ordinality co(collation,ordinality)
 join unnest(i.indkey) with ordinality k(attnum,ordinality) using(ordinality)
 join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.attnum
 where co.collation<>a.attcollation)
 )) and has_table_privilege('integration.foobar_import_receipts_v2','DELETE')
 and has_table_privilege('integration.foobar_import_request_keys_v2','DELETE')
 and has_column_privilege('integration.foobar_import_streams_v2','retired_through','UPDATE')
 and has_column_privilege('integration.foobar_import_request_keys_v2','state','UPDATE')
 and has_column_privilege('integration.foobar_import_request_keys_v2','receipt_ref','UPDATE')
 and has_column_privilege('integration.foobar_import_request_keys_v2','retired_at','UPDATE')
 and has_column_privilege('integration.foobar_import_request_keys_v2','retired_reason','UPDATE') as ready"""


def require_maintenance_indexes(connection):
    # Same transaction, no second pool and no cached caller attestation.
    # Existing schema check remains partial; trigger-body/security QA is not
    # inferred from these structural prerequisites.
    for sql,field in ((import_readiness._SCHEMA_SQL,'structural_ready'),(_INDEXES,'ready')):
        cursor = connection.execute(sql)
        try:
            rows = cursor.fetchmany(2)
        finally:
            cursor.close()
        if (type(rows) is not list or rows!=[{field:True}]
                or type(rows[0][field]) is not bool):
            raise SourceUnavailable()


def _confirmed_or_ordinary(connection, live, source_ref, receipt):
    frame = jobs._frame(live, source_ref, generation=receipt['generation'],
                        prepare_key=receipt['prepare_key'])
    owners = _query(connection, _JOB_OWNER, frame, maximum=2)
    if len(owners) > 1:
        raise SourceUnavailable()
    if not owners:
        return True
    owner = owners[0]
    if set(owner) != {'job_ref', 'batch_no', 'attempt_no'}:
        raise SourceUnavailable()
    job = jobs._job(connection, live, source_ref, owner['job_ref'])
    attempt = jobs._attempt(connection, live, source_ref, job,
                            batch_no=owner['batch_no'], attempt_no=owner['attempt_no'])
    if attempt is None:
        raise SourceUnavailable()
    if attempt['state'] != 'confirmed':
        return False
    jobs._record(connection, live, source_ref, job, attempt)  # confirmed branch: no writes
    proof = jobs._receipt(connection, live, source_ref, job, attempt)
    if (proof is None or proof[0]['state'] != 'committed'
            or proof[0]['receipt_ref'] != receipt['receipt_ref']
            or proof[0]['terminal_bytes'] != jobs._cached_terminal(live, source_ref, job, attempt)):
        raise SourceUnavailable()
    return True


def _expire(connection, live, source_ref, receipt, observed_at):
    frame = jobs._frame(live, source_ref, generation=receipt['generation'],
        receipt_ref=receipt['receipt_ref'], observed_at=observed_at)
    keys = _query(connection, _KEYS, frame, maximum=3)
    expected = [{'request_key': receipt['prepare_key'], 'operation': 'prepare',
                 'state': 'active', 'receipt_ref': receipt['receipt_ref'],
                 'original_receipt_ref': receipt['receipt_ref']}]
    if receipt['state'] == 'committed':
        expected.insert(0, dict(expected[0], request_key=receipt['apply_key'], operation='apply'))
    if keys != expected:
        raise SourceUnavailable()
    for key in keys:
        row = jobs._one(connection, _TOMBSTONE, jobs._frame(live, source_ref,
            generation=receipt['generation'], receipt_ref=receipt['receipt_ref'],
            request_key=key['request_key']))
        if row != {'request_key': key['request_key']}:
            raise SourceUnavailable()
    if jobs._one(connection, _DELETE_RECEIPT, frame) != {'receipt_ref': receipt['receipt_ref']}:
        raise SourceUnavailable()


def maintain_foobar_source(database_url, context, *, request, constraints=None):
    validate_request(request)
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        jobs.require_job_schema_on_connection(connection)
        require_maintenance_indexes(connection)
        stream = jobs._stream(connection, live, request.source_ref, roll=True)
        observed = _timestamp(stream['observed_at'])
        cursor = request.cursor
        fields = {} if cursor is None else dict(expires_at=cursor.expires_at,
            generation=cursor.generation, receipt_ref=cursor.receipt_ref)
        candidates = _query(connection, _CANDIDATES.format(after='' if cursor is None else _AFTER),
            jobs._frame(live, request.source_ref, observed_at=observed, **fields), maximum=21)
        more = len(candidates) > MAX_RECEIPTS
        candidates = candidates[:MAX_RECEIPTS]
        removed = protected = 0
        last = None
        previous = None if cursor is None else (cursor.expires_at, cursor.generation, cursor.receipt_ref)
        for row in candidates:
            if (set(row) != {'expires_at','generation','receipt_ref','prepare_key','apply_key','state',
                            'created_at','ready_until','committed_at'}
                    or not jobs.gate._integer(row['generation'],1,2147483647)
                    or not jobs.gate._uuid(row['receipt_ref']) or not jobs.gate._uuid(row['prepare_key'])
                    or row['state'] not in ('ready','committed')
                    or row['state']=='ready' and row['apply_key'] is not None
                    or row['state']=='committed' and not jobs.gate._uuid(row['apply_key'])):
                raise SourceUnavailable()
            # Do not rely on readiness attesting the complex timestamp CHECK.
            _timestamp(row['created_at']);_timestamp(row['ready_until'])
            if row['ready_until']!=row['created_at']+timedelta(hours=1):
                raise SourceUnavailable()
            if row['state']=='ready':
                if row['committed_at'] is not None or row['expires_at']!=row['ready_until']:
                    raise SourceUnavailable()
            else:
                _timestamp(row['committed_at'])
                if (not row['created_at']<=row['committed_at']<row['ready_until']
                        or row['expires_at']!=row['committed_at']+timedelta(hours=168)):
                    raise SourceUnavailable()
            stamp = _timestamp(row['expires_at'])
            order = (stamp,row['generation'],row['receipt_ref'])
            if stamp > observed or previous is not None and order <= previous:
                raise SourceUnavailable()
            previous = order
            last = MaintenanceCursor(*order)
            receipt = dict(row, expires_at=stamp)
            if _confirmed_or_ordinary(connection, live, request.source_ref, receipt):
                _expire(connection, live, request.source_ref, receipt, observed)
                removed += 1
            else:
                protected += 1
        frame = jobs._frame(live, request.source_ref)
        frontier = [stream['current_generation']]
        for sql in (_OLDEST_RECEIPT, _OLDEST_JOB.format(state='claimed'), _OLDEST_JOB.format(state='ready')):
            rows = _query(connection, sql, frame, maximum=1)
            if rows:
                if set(rows[0]) != {'generation'} or not jobs.gate._integer(rows[0]['generation'],1,stream['current_generation']):
                    raise SourceUnavailable()
                frontier.append(rows[0]['generation'])
        floor = min(frontier)-1
        if floor < stream['retired_through']:
            raise SourceUnavailable()
        if jobs._one(connection, _RETIRE, jobs._frame(live,request.source_ref,floor=floor)) != {'retired_through':floor}:
            raise SourceUnavailable()
        keys = _query(connection, _RETIRED_KEYS, jobs._frame(live,request.source_ref,floor=floor), maximum=101)
        more_keys = len(keys)>MAX_KEYS
        for key in keys[:MAX_KEYS]:
            if (set(key)!={'generation','request_key','state'} or key['state']!='tombstone'
                    or not jobs.gate._integer(key['generation'],1,floor)
                    or not jobs.gate._uuid(key['request_key'])):
                raise SourceUnavailable()
            if jobs._one(connection,_DELETE_KEY,jobs._frame(live,request.source_ref,floor=floor,**key)) != {'request_key':key['request_key']}:
                raise SourceUnavailable()
        result = MaintenanceResult(request.source_ref,len(candidates),removed,protected,
            min(len(keys),MAX_KEYS),floor,last if more else None,more_keys)
    return result
