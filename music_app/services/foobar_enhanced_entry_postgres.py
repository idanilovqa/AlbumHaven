"""Bounded Enhanced current-vector maintenance inside the real source transaction.

No transaction/commit, authority bypass, schema creation or public mutation API.
The v4 source writer must hold its genuine source lock and exact source postimage.
"""
from dataclasses import dataclass
import hashlib
import json
from uuid import UUID

from . import foobar_enhanced_entry_projection as codec
from .foobar_source_postgres import SourceUnavailable

MAX_PHASE_BYTES = 4194304
MAX_FRAME_BYTES = 262144
CHUNK_ENTRIES = 128


@dataclass(frozen=True, slots=True)
class EnhancedProjectionQuota:
    header_bytes: int
    child_bytes: int
    previous_header_bytes: int
    previous_child_bytes: int
    previous_count: int
    final_delta: int
    peak_delta: int


def projection_write_phase_bytes(*,retained_bytes,effective_length,display_length):
    if type(retained_bytes) is not int or retained_bytes<0:
        raise SourceUnavailable()
    return retained_bytes+codec.projection_phase_bytes(effective_length,display_length)


def _admit(retained_bytes,effective_bytes,display_bytes):
    if (type(effective_bytes) is not bytes or type(display_bytes) is not bytes
            or projection_write_phase_bytes(retained_bytes=retained_bytes,
                effective_length=len(effective_bytes),display_length=len(display_bytes))>MAX_PHASE_BYTES):
        raise SourceUnavailable()


def _uuid(value):
    try:
        return type(value) is str and len(value)==36 and str(UUID(value))==value
    except ValueError:
        return False


def _scope(account_id,source_ref,observation_ref,revision,previous_revision):
    if (type(account_id) is not int or not 1<=account_id<=9223372036854775807
            or not _uuid(source_ref) or not _uuid(observation_ref)
            or type(revision) is not int or not 1<=revision<=9223372036854775807
            or previous_revision is not None and (type(previous_revision) is not int
                or not 1<=previous_revision<=revision)):
        raise SourceUnavailable()


def _frame(values):
    payload=json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return payload


def _query(connection,sql,values,maximum):
    frame=_frame(values)
    cursor=connection.execute(sql,(frame,),binary=True)
    try:
        rows=cursor.fetchmany(maximum+1)
        if (type(rows) is not list or len(rows)>maximum
                or any(type(row) is not dict for row in rows)):
            raise SourceUnavailable()
        return rows
    finally:
        cursor.close()


_BASE="""with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
(j->>2)::uuid observation_ref,(j->>3)::bigint source_revision,j from f)
"""
_OLD=_BASE+"""select p.source_revision,p.evidence_kind,
octet_length(p.projection_bytes)::bigint header_bytes,p.local_entry_count,
c.n,c.lo,c.hi,c.child_bytes
from x join integration.foobar_import_history_projection_v1 p
on (p.account_id,p.source_ref,p.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
cross join lateral (select count(*)::bigint n,min(e.source_ordinal) lo,max(e.source_ordinal) hi,
coalesce(sum(octet_length(e.projection_bytes)),0)::bigint child_bytes
from integration.foobar_import_local_entries_v1 e
where (e.account_id,e.source_ref,e.observation_ref,e.source_revision)
=(p.account_id,p.source_ref,p.observation_ref,p.source_revision)) c
"""
_INSERT=_BASE+"""insert into integration.foobar_import_local_entries_v1
(account_id,source_ref,observation_ref,source_revision,source_ordinal,raw_filetime_le,
resolved,sort_key,projection_bytes)
select x.account_id,x.source_ref,x.observation_ref,x.source_revision,(e->>0)::integer,
decode(e->>1,'hex'),(e->>2)::boolean,(e->>3)::bigint,decode(e->>4,'hex')
from x join integration.foobar_import_observations_v2 o
on (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
=(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
join integration.foobar_import_revisions_v2 r
on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
=(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
cross join lateral jsonb_array_elements(j->6) e
where r.evidence_sha256=decode(j->>4,'hex') and r.display_sha256=decode(j->>5,'hex')
returning source_ordinal
"""
_HEADER=_BASE+"""insert into integration.foobar_import_history_projection_v1 as p
(account_id,source_ref,observation_ref,source_revision,effective_evidence_sha256,display_sha256,
projection_bytes,standard_first,standard_last,enhanced_first,enhanced_last,
standard_last_present,enhanced_last_present,evidence_kind,local_entry_count,local_vector_sha256)
select x.account_id,x.source_ref,x.observation_ref,x.source_revision,r.evidence_sha256,r.display_sha256,
decode(j->>6,'hex'),null,-9223372036854775808,null,-9223372036854775808,
false,false,'enhanced_store',(j->>7)::integer,decode(j->>8,'hex')
from x join integration.foobar_import_observations_v2 o
on (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
=(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
join integration.foobar_import_revisions_v2 r
on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
=(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
where r.evidence_sha256=decode(j->>4,'hex') and r.display_sha256=decode(j->>5,'hex')
on conflict(account_id,source_ref,observation_ref) do update set
source_revision=excluded.source_revision,effective_evidence_sha256=excluded.effective_evidence_sha256,
display_sha256=excluded.display_sha256,projection_bytes=excluded.projection_bytes,
standard_first=excluded.standard_first,standard_last=excluded.standard_last,
enhanced_first=excluded.enhanced_first,enhanced_last=excluded.enhanced_last,
standard_last_present=false,enhanced_last_present=false,evidence_kind=excluded.evidence_kind,
local_entry_count=excluded.local_entry_count,local_vector_sha256=excluded.local_vector_sha256
where p.source_revision=(select (j->>9)::bigint from f) and p.evidence_kind='enhanced_store'
returning observation_ref::text observation_ref
"""
_DELETE=_BASE.rstrip()+""", with_removed as (
delete from integration.foobar_import_local_entries_v1 e using x
where (e.account_id,e.source_ref,e.observation_ref,e.source_revision)
=(x.account_id,x.source_ref,x.observation_ref,(j->>4)::bigint)
returning source_ordinal)
select count(*)::bigint n from with_removed
"""
_VERIFY_HEADER=_BASE+"""select p.source_revision,p.evidence_kind,
case when octet_length(p.projection_bytes)<=2048 then p.projection_bytes end projection_bytes,
encode(p.projection_sha256,'hex') projection_sha256,p.local_entry_count,
encode(case when octet_length(p.local_vector_sha256)=32 then p.local_vector_sha256 end,'hex') local_vector_sha256,
encode(p.effective_evidence_sha256,'hex') effective_sha256,encode(p.display_sha256,'hex') display_sha256,
p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,
p.standard_last_present,p.enhanced_last_present,o.current_revision,
encode(r.evidence_sha256,'hex') actual_effective_sha256,encode(r.display_sha256,'hex') actual_display_sha256
from x join integration.foobar_import_history_projection_v1 p
on (p.account_id,p.source_ref,p.observation_ref)=(x.account_id,x.source_ref,x.observation_ref)
join integration.foobar_import_observations_v2 o
on (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
=(p.account_id,p.source_ref,p.observation_ref,p.source_revision)
join integration.foobar_import_revisions_v2 r
on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
=(p.account_id,p.source_ref,p.observation_ref,p.source_revision)
"""
_READ=_BASE+"""select e.source_ordinal,
case when octet_length(e.raw_filetime_le)=8 then e.raw_filetime_le end raw_filetime_le,
e.resolved,e.sort_key,
case when octet_length(e.projection_bytes)<=512 then e.projection_bytes end projection_bytes,
encode(e.projection_sha256,'hex') projection_sha256
from x join integration.foobar_import_local_entries_v1 e
on (e.account_id,e.source_ref,e.observation_ref,e.source_revision)
=(x.account_id,x.source_ref,x.observation_ref,x.source_revision)
where e.source_ordinal>=(j->>4)::integer order by e.source_ordinal limit 129
"""


def _old(connection,scope,previous_revision):
    rows=_query(connection,_OLD,scope,1)
    if previous_revision is None:
        if rows:
            raise SourceUnavailable()
        return 0,0,0
    if len(rows)!=1:
        raise SourceUnavailable()
    row=rows[0]
    if (set(row)!={'source_revision','evidence_kind','header_bytes','local_entry_count','n','lo','hi','child_bytes'}
            or row['source_revision']!=previous_revision or type(row['source_revision']) is not int
            or row['evidence_kind']!='enhanced_store'
            or type(row['header_bytes']) is not int or not 1<=row['header_bytes']<=2048
            or type(row['child_bytes']) is not int or not 0<=row['child_bytes']<=32766*512
            or type(row['n']) is not int or not 0<=row['n']<=32766
            or row['local_entry_count'] is not None and (type(row['local_entry_count']) is not int
                or not 0<=row['local_entry_count']<=32766)
            or row['n']!=(row['local_entry_count'] or 0)
            or not row['n']<=row['child_bytes']<=row['n']*512
            or row['n']==0 and (row['lo'] is not None or row['hi'] is not None)
            or row['n']>0 and (row['lo']!=0 or row['hi']!=row['n']-1)):
        raise SourceUnavailable()
    return row['header_bytes'],row['child_bytes'],row['n']


def enhanced_projection_quota_on_connection(connection,*,account_id,source_ref,observation_ref,
        source_revision,previous_revision,effective_bytes,display_bytes,retained_bytes):
    """Exact projection-only delta/peak after raw bytes; caller combines raw peak."""
    _scope(account_id,source_ref,observation_ref,source_revision,previous_revision)
    _admit(retained_bytes,effective_bytes,display_bytes)
    if previous_revision==source_revision:
        raise SourceUnavailable()
    old_header,old_children,old_count=_old(connection,
        (account_id,source_ref,observation_ref,source_revision),previous_revision)
    header,children,count=codec.projection_size_summary(effective_bytes=effective_bytes,
        display_bytes=display_bytes,source_revision=source_revision)
    header_delta=header-old_header
    return EnhancedProjectionQuota(header,children,old_header,old_children,old_count,
        children+header_delta-old_children,max(0,children,children+header_delta))


def _chunks(effective_bytes):
    batch=[]
    for entry in codec.iter_local_entry_projections(effective_bytes):
        payload=codec.encode_local_entry(entry)
        batch.append((entry.ordinal,entry.raw_filetime_le.hex(),entry.state=='resolved',
            entry.sort_key,payload.hex()))
        if len(batch)==CHUNK_ENTRIES:
            yield batch
            batch=[]
    if batch:
        yield batch


def _verify(connection,scope,header,payload,effective_bytes):
    rows=_query(connection,_VERIFY_HEADER,scope,1)
    if len(rows)!=1:
        raise SourceUnavailable()
    row=rows[0]
    expected={
        'source_revision':header.source_revision,'evidence_kind':'enhanced_store',
        'projection_bytes':payload,'projection_sha256':hashlib.sha256(payload).hexdigest(),
        'local_entry_count':header.local_entry_count,'local_vector_sha256':header.local_vector_sha256,
        'effective_sha256':header.effective_evidence_sha256,'display_sha256':header.display_sha256,
        'standard_first':None,'standard_last':codec.UNKNOWN_TIME,'enhanced_first':None,
        'enhanced_last':codec.UNKNOWN_TIME,'standard_last_present':False,'enhanced_last_present':False,
        'current_revision':header.source_revision,'actual_effective_sha256':header.effective_evidence_sha256,
        'actual_display_sha256':header.display_sha256,
    }
    if set(row)!=set(expected) or any(type(row[k]) is not type(v) or row[k]!=v for k,v in expected.items()):
        raise SourceUnavailable()
    count=0
    for batch in _chunks(effective_bytes):
        rows=_query(connection,_READ,(*scope,count),129)
        if len(rows)<len(batch) or len(batch)<CHUNK_ENTRIES and len(rows)!=len(batch):
            raise SourceUnavailable()
        for actual,entry in zip(rows,batch):
            ordinal,raw,resolved,sort_key,hex_payload=entry
            entry_payload=bytes.fromhex(hex_payload)
            expected_entry={'source_ordinal':ordinal,'raw_filetime_le':bytes.fromhex(raw),
                'resolved':resolved,'sort_key':sort_key,'projection_bytes':entry_payload,
                'projection_sha256':hashlib.sha256(entry_payload).hexdigest()}
            if (set(actual)!=set(expected_entry)
                    or any(type(actual[k]) is not type(v) or actual[k]!=v for k,v in expected_entry.items())):
                raise SourceUnavailable()
        count+=len(batch)
        # Do not retain result/frame/payload batches while constructing the next.
        rows=actual=entry=entry_payload=expected_entry=batch=None
    if count!=(header.local_entry_count or 0) or _query(connection,_READ,(*scope,count),129):
        raise SourceUnavailable()


def maintain_enhanced_history_on_connection(connection,*,account_id,source_ref,observation_ref,
        source_revision,previous_revision,effective_bytes,display_bytes,changed,retained_bytes):
    """Within actual source savepoint; never commits or owns final stream revision.

    Source writer has already persisted and verified the exact source postimage.
    Planning MUST have admitted the matching raw and projection intermediate peaks.
    Here fixed phase admission repeats before codec work. No-op verifies retained
    bytes/children without DML; raw-only revision rebinds the same effective vector.
    """
    _scope(account_id,source_ref,observation_ref,source_revision,previous_revision)
    _admit(retained_bytes,effective_bytes,display_bytes)
    if type(changed) is not bool or (not changed and previous_revision!=source_revision):
        raise SourceUnavailable()
    if changed and previous_revision is not None and previous_revision>=source_revision:
        raise SourceUnavailable()
    scope=(account_id,source_ref,observation_ref,source_revision)
    header=codec.build_enhanced_history_header(effective_bytes=effective_bytes,
        display_bytes=display_bytes,source_revision=source_revision)
    payload=codec.encode_enhanced_history_header(header)
    if changed:
        old_header,old_children,old_count=_old(connection,scope,previous_revision)
        for batch in _chunks(effective_bytes):
            rows=_query(connection,_INSERT,(*scope,header.effective_evidence_sha256,
                header.display_sha256,batch),CHUNK_ENTRIES)
            expected_ordinals=[item[0] for item in batch]
            if (len(rows)!=len(batch) or any(set(row)!={'source_ordinal'}
                    or type(row['source_ordinal']) is not int for row in rows)
                    or sorted(row['source_ordinal'] for row in rows)!=expected_ordinals):
                raise SourceUnavailable()
            rows=batch=expected_ordinals=None
        rows=_query(connection,_HEADER,(*scope,header.effective_evidence_sha256,
            header.display_sha256,payload.hex(),header.local_entry_count,
            header.local_vector_sha256,previous_revision),1)
        if rows!=[{'observation_ref':observation_ref}]:
            raise SourceUnavailable()
        if previous_revision is not None:
            rows=_query(connection,_DELETE,(*scope,previous_revision),1)
            if (len(rows)!=1 or set(rows[0])!={'n'} or type(rows[0]['n']) is not int
                    or rows[0]['n']!=old_count):
                raise SourceUnavailable()
    _verify(connection,scope,header,payload,effective_bytes)
