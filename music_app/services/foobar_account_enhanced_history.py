"""Own-account current Enhanced evidence, never cached Last.fm or lifetime plays.

Entries are ordered by genuine resolved FILETIME, with unresolved values in an
explicit undated tail. Records is an explicitly nonchronological source-evidence
view, including empty/unavailable vectors. Both are revision-fenced keysets.
"""
from dataclasses import dataclass
from hashlib import sha256
import json

from . import foobar_account_history_postgres as history
from . import foobar_enhanced_entry_projection as codec
from .foobar_account_authority import current_foobar_account_read_transaction
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query

PAGE_SIZE=20
READ_PHASE_BYTES=2097152
MIN_KEY=-9223372036854775808
MAX_KEY=2534023007999999999


@dataclass(frozen=True,slots=True)
class EnhancedHistoryCursor:
    account_id: int
    source_ref: str
    source_revision: int
    view: str
    sort_key: int
    observation_ref: str
    ordinal: int
    direction: str = 'older'


@dataclass(frozen=True,slots=True)
class EnhancedHistoryRequest:
    source_ref: str
    view: str
    cursor: EnhancedHistoryCursor | None = None


@dataclass(frozen=True,slots=True)
class EnhancedHistoryItem:
    observation_ref: str
    header: codec.EnhancedHistoryHeader
    entry: codec.EnhancedLocalEntry | None


@dataclass(frozen=True,slots=True)
class EnhancedHistoryPage:
    source_ref: str
    source_revision: int
    view: str
    items: tuple
    next_cursor: EnhancedHistoryCursor | None
    previous_cursor: EnhancedHistoryCursor | None = None


def validate_request(request):
    if (type(request) is not EnhancedHistoryRequest or not history._uuid(request.source_ref)
            or type(request.view) is not str or request.view not in ('entries','records')):
        raise history.FoobarHistoryInvalid()
    c=request.cursor
    if c is not None and (type(c) is not EnhancedHistoryCursor
            or not history._integer(c.account_id,1) or c.source_ref!=request.source_ref
            or not history._integer(c.source_revision) or c.view!=request.view
            or not history._uuid(c.observation_ref)
            or not history._integer(c.sort_key,MIN_KEY,MAX_KEY)
            or not history._integer(c.ordinal,-1,32765)
            or type(c.direction) is not str or c.direction not in ('older','newer')
            or request.view=='records' and (c.sort_key!=MIN_KEY or c.ordinal!=-1)
            or request.view=='entries' and c.ordinal<0):
        raise history.FoobarHistoryInvalid()


_FRAME="""with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
(j->>2)::bigint sort_key,(j->>3)::uuid observation_ref,(j->>4)::integer ordinal from f)
"""
_LOCK=_FRAME+"""select revision from integration.foobar_import_streams_v2
where account_id=(select account_id from x) and source_ref=(select source_ref from x)
for share"""


def _sql(view,continuation,direction='older'):
    if direction not in ('older','newer'):
        raise history.FoobarHistoryInvalid()
    comparison='<' if direction=='older' else '>'
    order='desc' if direction=='older' else 'asc'
    if view=='entries':
        chosen="""select e.observation_ref,e.source_revision,e.source_ordinal ordinal,e.sort_key,
e.raw_filetime_le,e.resolved,
case when octet_length(e.projection_bytes) between 1 and 512 then e.projection_bytes end entry_bytes,
encode(e.projection_sha256,'hex') entry_sha256
from integration.foobar_import_local_entries_v1 e
where e.account_id=(select account_id from x) and e.source_ref=(select source_ref from x)"""
        if continuation:
            chosen+=' and (e.sort_key,e.observation_ref,e.source_ordinal)'+comparison+'((select sort_key from x),(select observation_ref from x),(select ordinal from x))'
        chosen+=' order by e.sort_key '+order+',e.observation_ref '+order+',e.source_ordinal '+order+' limit 21'
    else:
        chosen="""select p.observation_ref,p.source_revision,-1::integer ordinal,
'-9223372036854775808'::bigint sort_key,null::bytea raw_filetime_le,
null::boolean resolved,null::bytea entry_bytes,null::text entry_sha256
from integration.foobar_import_history_projection_v1 p
where p.account_id=(select account_id from x) and p.source_ref=(select source_ref from x)
and p.evidence_kind='enhanced_store'"""
        if continuation:
            chosen+=' and p.observation_ref'+comparison+'(select observation_ref from x)'
        chosen+=' order by p.observation_ref '+order+' limit 21'
    return _FRAME+', chosen as materialized ('+chosen+")"+"""
select c.observation_ref::text observation_ref,c.source_revision,c.ordinal,c.sort_key,
c.raw_filetime_le,c.resolved,c.entry_bytes,c.entry_sha256,
p.evidence_kind,p.source_revision header_revision,
case when octet_length(p.projection_bytes) between 1 and 2048 then p.projection_bytes end header_bytes,
encode(p.projection_sha256,'hex') header_sha256,
encode(p.effective_evidence_sha256,'hex') effective_sha256,
encode(p.display_sha256,'hex') display_sha256,p.local_entry_count,
encode(p.local_vector_sha256,'hex') local_vector_sha256,o.current_revision,
encode(r.evidence_sha256,'hex') current_effective_sha256,
encode(r.display_sha256,'hex') current_display_sha256
from chosen c left join integration.foobar_import_history_projection_v1 p
on p.account_id=(select account_id from x) and p.source_ref=(select source_ref from x)
and p.observation_ref=c.observation_ref
left join integration.foobar_import_observations_v2 o
on (o.account_id,o.source_ref,o.observation_ref)=(p.account_id,p.source_ref,p.observation_ref)
left join integration.foobar_import_revisions_v2 r
on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
order by c.sort_key desc,c.observation_ref desc,c.ordinal desc
"""


_FIELDS={'observation_ref','source_revision','ordinal','sort_key','raw_filetime_le','resolved',
'entry_bytes','entry_sha256','evidence_kind','header_revision','header_bytes','header_sha256',
'effective_sha256','display_sha256','local_entry_count','local_vector_sha256','current_revision',
'current_effective_sha256','current_display_sha256'}


def _item(row,revision,view):
    if (type(row) is not dict or set(row)!=_FIELDS
            or not history._uuid(row['observation_ref'])
            or type(row['source_revision']) is not int
            or type(row['header_revision']) is not int
            or type(row['current_revision']) is not int
            or not 1<=row['source_revision']<=revision
            or row['source_revision']!=row['header_revision']
            or row['source_revision']!=row['current_revision']
            or row['evidence_kind']!='enhanced_store'):
        raise SourceUnavailable()
    bodies=((row['header_bytes'],row['header_sha256'],2048),)
    if view=='entries':
        bodies+=((row['entry_bytes'],row['entry_sha256'],512),)
    for body,digest,limit in bodies:
        if type(body) is not bytes or not 1<=len(body)<=limit or sha256(body).hexdigest()!=digest:
            raise SourceUnavailable()
    header=codec.decode_enhanced_history_header(row['header_bytes'])
    entry=codec.decode_local_entry(row['entry_bytes']) if view=='entries' else None
    if (header.source_revision!=row['source_revision']
            or header.effective_evidence_sha256!=row['effective_sha256']
            or header.effective_evidence_sha256!=row['current_effective_sha256']
            or header.display_sha256!=row['display_sha256']
            or header.display_sha256!=row['current_display_sha256']
            or (row['local_entry_count'] is not None and type(row['local_entry_count']) is not int)
            or header.local_entry_count!=row['local_entry_count']
            or header.local_vector_sha256!=row['local_vector_sha256']):
        raise SourceUnavailable()
    if entry is None:
        if (type(row['ordinal']) is not int or type(row['sort_key']) is not int
                or row['ordinal']!=-1 or row['sort_key']!=MIN_KEY
                or any(row[k] is not None for k in ('raw_filetime_le','resolved','entry_bytes','entry_sha256'))):
            raise SourceUnavailable()
    elif (header.local_entry_count is None or not 0<=entry.ordinal<header.local_entry_count
            or type(row['ordinal']) is not int or entry.ordinal!=row['ordinal']
            or type(row['sort_key']) is not int or entry.sort_key!=row['sort_key']
            or type(row['resolved']) is not bool or (entry.state=='resolved')!=row['resolved']
            or type(row['raw_filetime_le']) is not bytes or entry.raw_filetime_le!=row['raw_filetime_le']):
        raise SourceUnavailable()
    return EnhancedHistoryItem(str(row['observation_ref']),header,entry)


def read_enhanced_history(database_url,context,request,*,constraints=None):
    validate_request(request)
    try:
        with current_foobar_account_read_transaction(database_url,context,constraints=constraints) as (connection,live,now):
            c=request.cursor
            if c is not None and c.account_id!=live.actor.account_id:
                raise SourceStale()
            require_foobar_history_on_connection(connection)
            if request.view=='records':
                _require_records_index(connection)
            frame=json.dumps((live.actor.account_id,request.source_ref,c.sort_key if c else None,
                c.observation_ref if c else None,c.ordinal if c else None),separators=(',',':')).encode('ascii')
            if len(frame)>1024:
                raise SourceUnavailable()
            locked=_query(connection,_LOCK,frame,maximum=1)
            if (len(locked)!=1 or type(locked[0]) is not dict or set(locked[0])!={'revision'}
                    or not history._integer(locked[0]['revision'])):
                raise SourceStale()
            revision=locked[0]['revision']
            if c is not None and c.source_revision!=revision:
                raise SourceStale()
            direction=c.direction if c else 'older'
            rows=_query(connection,_sql(request.view,c is not None,direction),frame,maximum=21)
            items=tuple(_item(row,revision,request.view) for row in rows)
            previous=None
            for item in items:
                key=(item.entry.sort_key if item.entry else MIN_KEY,item.observation_ref,
                    item.entry.ordinal if item.entry else -1)
                if previous is not None and key>=previous:
                    raise SourceUnavailable()
                if c is not None:
                    anchor=(c.sort_key,c.observation_ref,c.ordinal)
                    if direction=='older' and key>=anchor or direction=='newer' and key<=anchor:
                        raise SourceUnavailable()
                previous=key
            visible=items[:PAGE_SIZE] if direction=='older' else items[-PAGE_SIZE:]
            def position(item,way):
                return EnhancedHistoryCursor(live.actor.account_id,request.source_ref,revision,request.view,
                    item.entry.sort_key if item.entry else MIN_KEY,item.observation_ref,
                    item.entry.ordinal if item.entry else -1,way)
            cursor=(position(visible[-1],'older') if visible and
                (len(items)>PAGE_SIZE if direction=='older' else c is not None) else None)
            prior=(position(visible[0],'newer') if visible and
                (c is not None if direction=='older' else len(items)>PAGE_SIZE) else None)
            result=EnhancedHistoryPage(request.source_ref,revision,request.view,visible,cursor,prior)
        return result
    except (history.FoobarHistoryInvalid,SourceStale,SourceUnavailable):
        raise
    except Exception:
        raise SourceUnavailable() from None


_RECORDS_INDEX_SQL="""
select exists(
 select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace n on n.oid=t.relnamespace
 join pg_catalog.pg_index i on i.indrelid=t.oid
 join pg_catalog.pg_class ix on ix.oid=i.indexrelid
 join pg_catalog.pg_namespace ns on ns.oid=ix.relnamespace
 join pg_catalog.pg_am am on am.oid=ix.relam
 where n.nspname='integration' and t.relname='foobar_import_history_projection_v1'
 and t.relkind='r' and t.relpersistence='p' and ns.nspname='integration'
 and ix.relname='foobar_enhanced_records_v1' and ix.relkind='i' and ix.relpersistence='p'
 and am.amname='btree' and i.indisvalid and i.indisready and i.indislive and i.indimmediate
 and not i.indisunique and not i.indisprimary and not i.indisexclusion
 and i.indnkeyatts=3 and i.indnatts=3 and i.indexprs is null
 and pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(evidence_kind = ''enhanced_store''::text)'
 and array(select a.attname::text from unnest(i.indkey) with ordinality k(num,ord)
   join pg_catalog.pg_attribute a on a.attrelid=t.oid and a.attnum=k.num
   where not a.attisdropped order by ord)=array['account_id','source_ref','observation_ref']::text[]
 and array(select v from unnest(i.indoption) with ordinality k(v,ord) order by ord)=array[0,0,3]::smallint[]
 and array(select v from unnest(i.indcollation) with ordinality k(v,ord) order by ord)=array[0,0,0]::oid[]
 and array(select op.opcname::text from unnest(i.indclass) with ordinality k(num,ord)
   join pg_catalog.pg_opclass op on op.oid=k.num
   join pg_catalog.pg_namespace pn on pn.oid=op.opcnamespace
   where pn.nspname='pg_catalog' and op.opcmethod=am.oid and op.opcdefault order by ord)
   =array['int8_ops','uuid_ops','uuid_ops']::text[]
) ready
"""


def _require_records_index(connection):
    with connection.cursor() as cursor:
        cursor.execute(_RECORDS_INDEX_SQL)
        rows=cursor.fetchmany(2)
    if len(rows)!=1 or type(rows[0]) is not dict or rows[0]!={'ready':True} or type(rows[0]['ready']) is not bool:
        raise SourceUnavailable()
