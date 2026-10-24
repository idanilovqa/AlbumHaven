"""Current imported Foobar history, scoped to one explicit own-account source.

Independent Standard/Enhanced families; no Last.fm/native-library joins. Each
page uses genuine read authority and a source revision fence. This is bounded
current aggregate evidence, not reconstructed individual scrobbles or an audit.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from uuid import UUID

from . import foobar_account_prepare_gate as gate
from .foobar_account_authority import current_foobar_account_read_transaction
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_account_history_projection_writer import decode_bound_projection, individual_last_present
from .foobar_account_history_projection import AccountHistoryProjection

HISTORY_READ_PHASE_BYTES = 2097152
HISTORY_SOURCE_LIST_PHASE_BYTES = 65536
MAX_FRAME_BYTES = 1024
MAX_SQL_BYTES = 8192
PAGE_SIZE = 20
_MAX = 9223372036854775807
_MIN = -9223372036854775808
_FAMILIES = ('standard','enhanced')
_MODES = ('grouped','individual')
_RANK = {'first_boundary':1,'unknown_dates_bucket':0,'grouped_aggregate':0}


class FoobarHistoryInvalid(gate.PrepareInvalid):
    """Malformed selector/cursor, before database work or service busy handling."""


class FoobarHistoryStale(SourceStale):
    """The source/snapshot/scope changed; refresh instead of mixing pages."""


@dataclass(frozen=True, slots=True)
class FoobarHistoryCursor:
    account_id: int
    source_ref: str
    source_revision: int
    family: str
    mode: str
    sort_key: int
    kind: str
    observation_ref: str


@dataclass(frozen=True, slots=True)
class FoobarHistoryRequest:
    source_ref: str
    family: str
    mode: str
    cursor: FoobarHistoryCursor | None = None


@dataclass(frozen=True, slots=True)
class FoobarHistoryItem:
    observation_ref: str
    kind: str
    sort_key: int
    projection: AccountHistoryProjection


@dataclass(frozen=True, slots=True)
class FoobarHistoryPage:
    source_ref: str
    source_revision: int
    family: str
    mode: str
    items: tuple[FoobarHistoryItem, ...]
    next_cursor: FoobarHistoryCursor | None


@dataclass(frozen=True, slots=True)
class FoobarHistorySourceCursor:
    account_id: int
    source_ref: str


@dataclass(frozen=True, slots=True)
class FoobarHistorySourceItem:
    source_ref: str
    created_at: str
    is_default: bool
    observation_count: int


@dataclass(frozen=True, slots=True)
class FoobarHistorySourcePage:
    items: tuple[FoobarHistorySourceItem, ...]
    next_cursor: FoobarHistorySourceCursor | None


def _uuid(value):
    if type(value) is not str or len(value)!=36:
        return False
    try:
        return str(UUID(value))==value
    except ValueError:
        return False


def _integer(value, minimum=0, maximum=_MAX):
    return type(value) is int and minimum<=value<=maximum


def validate_foobar_history_request(request):
    if (type(request) is not FoobarHistoryRequest or not _uuid(request.source_ref)
            or type(request.family) is not str or request.family not in _FAMILIES
            or type(request.mode) is not str or request.mode not in _MODES):
        raise FoobarHistoryInvalid()
    cursor = request.cursor
    if cursor is None:
        return
    kinds = ('grouped_aggregate',) if request.mode=='grouped' else ('first_boundary','unknown_dates_bucket')
    if (type(cursor) is not FoobarHistoryCursor or not _integer(cursor.account_id,1)
            or not _uuid(cursor.source_ref) or not _uuid(cursor.observation_ref)
            or not _integer(cursor.source_revision) or not _integer(cursor.sort_key,_MIN)
            or type(cursor.family) is not str or type(cursor.mode) is not str
            or type(cursor.kind) is not str or cursor.kind not in kinds
            or cursor.source_ref!=request.source_ref or cursor.family!=request.family
            or cursor.mode!=request.mode):
        raise FoobarHistoryInvalid()


def validate_foobar_history_source_cursor(cursor):
    if cursor is not None and (type(cursor) is not FoobarHistorySourceCursor
            or not _integer(cursor.account_id,1) or not _uuid(cursor.source_ref)):
        raise FoobarHistoryInvalid()


_FRAME_SQL = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>'account_id')::bigint account_id,(j->>'source_ref')::uuid source_ref,
(j->>'sort_key')::bigint sort_key,(j->>'observation_ref')::uuid observation_ref from f)
"""
_LOCK_SQL = _FRAME_SQL + """select s.revision from integration.foobar_import_streams_v2 s
where s.account_id=(select account_id from x) and s.source_ref=(select source_ref from x)
for share of s"""


def _arm_sql(family, kind, cursor_kind):
    """Only fixed whitelisted identifiers; scalar InitPlans preserve index bounds."""
    first = kind=='first_boundary'
    column = family+('_first' if first else '_last')
    rank = _RANK[kind]
    sql = ('select p.observation_ref,p.'+column+' sort_key,'+str(rank)+' arm_rank '
           'from integration.foobar_import_history_projection_v1 p '
           'where p.account_id=(select account_id from x) '
           'and p.source_ref=(select source_ref from x) '
           "and p.evidence_kind='tsv_snapshot'")
    if first:
        sql += ' and p.'+column+' is not null'
    elif kind=='unknown_dates_bucket':
        sql += ' and p.'+family+'_last_present'
    if cursor_kind is not None:
        cursor_rank = _RANK[cursor_kind]
        if rank==cursor_rank:
            sql += (' and (p.'+column+',p.observation_ref)<'
                    '((select sort_key from x),(select observation_ref from x))')
        elif rank<cursor_rank:
            sql += ' and p.'+column+'<=(select sort_key from x)'
        else:
            sql += ' and p.'+column+'<(select sort_key from x)'
    return sql+' order by p.'+column+' desc,p.observation_ref desc limit 21'


_PROJECTION_SELECT_SQL = """
select c.observation_ref::text observation_ref,c.sort_key,c.arm_rank,
p.source_revision,p.projection_bytes,encode(p.projection_sha256,'hex') projection_sha256,
encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,encode(p.display_sha256,'hex') display_sha256,
p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,p.standard_last_present,p.enhanced_last_present,
o.current_revision,encode(r.evidence_sha256,'hex') current_effective_sha256,
encode(r.display_sha256,'hex') current_display_sha256
from chosen c left join integration.foobar_import_history_projection_v1 p
 on p.account_id=(select account_id from x) and p.source_ref=(select source_ref from x)
 and p.observation_ref=c.observation_ref
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=(p.account_id,p.source_ref,p.observation_ref)
left join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)
  =(o.account_id,o.source_ref,o.observation_ref,o.current_revision)
order by c.sort_key desc,c.arm_rank desc,c.observation_ref desc
"""


def _list_sql(family, mode, cursor_kind):
    if mode=='grouped':
        return _FRAME_SQL+', chosen as materialized ('+_arm_sql(family,'grouped_aggregate',cursor_kind)+')'+_PROJECTION_SELECT_SQL
    # Expand before pagination: two independently seekable <=21 scalar streams,
    # merge <=42, then top21. Only then fetch bounded compact projection payloads.
    return (_FRAME_SQL+', first_arm as materialized ('+_arm_sql(family,'first_boundary',cursor_kind)+'), '
            'last_arm as materialized ('+_arm_sql(family,'unknown_dates_bucket',cursor_kind)+'), '
            'chosen as materialized (select * from ('
            'select * from first_arm union all select * from last_arm) candidates '
            'order by sort_key desc,arm_rank desc,observation_ref desc limit 21)'+_PROJECTION_SELECT_SQL)


_LIST_SQL = {(family,mode,kind):_list_sql(family,mode,kind)
             for family in _FAMILIES for mode in _MODES
             for kind in ((None,'grouped_aggregate') if mode=='grouped'
                          else (None,'first_boundary','unknown_dates_bucket'))}


def _frame(account_id, source_ref, cursor):
    fields = dict(account_id=account_id,source_ref=source_ref,sort_key=None,observation_ref=None)
    if cursor is not None:
        fields.update(sort_key=cursor.sort_key,observation_ref=cursor.observation_ref)
    result = json.dumps(fields,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(result)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return result


def _key(item):
    return item.sort_key,_RANK[item.kind],item.observation_ref


def _item(row, request, revision):
    if (type(row) is not dict or not _uuid(row.get('observation_ref'))
            or not _integer(row.get('sort_key'),_MIN)
            or type(row.get('arm_rank')) is not int or row['arm_rank'] not in (0,1)):
        raise SourceUnavailable()
    projection = decode_bound_projection({key:value for key,value in row.items()
        if key not in ('observation_ref','sort_key','arm_rank')})
    if projection.source_revision>revision:
        raise SourceUnavailable()
    family = getattr(projection,request.family)
    if request.mode=='grouped':
        if row['arm_rank']!=0 or row['sort_key']!=family.grouped_sort_key:
            raise SourceUnavailable()
        kind = 'grouped_aggregate'
    elif row['arm_rank']==1:
        if family.first_marker_weight!=1 or row['sort_key']!=family.first_sort_key:
            raise SourceUnavailable()
        kind = 'first_boundary'
    else:
        if not individual_last_present(family) or row['sort_key']!=family.remainder_sort_key:
            raise SourceUnavailable()
        kind = 'unknown_dates_bucket'
    return FoobarHistoryItem(row['observation_ref'],kind,row['sort_key'],projection)


def read_foobar_history(database_url, context, request, *, constraints=None):
    """At most20 rows; cursor is account/source/family/mode/revision-bound position.

    All pages are current snapshots. A new source revision invalidates continuation
    before the listing query. No cursor supplies authority or selects an account.
    The account/session owner rechecks current authority before any result exits.
    """
    validate_foobar_history_request(request)
    try:
        with current_foobar_account_read_transaction(database_url,context,constraints=constraints) as (connection,live,now):
            account_id = live.actor.account_id
            cursor = request.cursor
            if cursor is not None and cursor.account_id!=account_id:
                raise FoobarHistoryStale()
            require_foobar_history_on_connection(connection)
            frame = _frame(account_id,request.source_ref,cursor)
            locked = _query(connection,_LOCK_SQL,frame,maximum=1)
            if not locked:
                raise FoobarHistoryStale()
            if (len(locked)!=1 or type(locked[0]) is not dict or set(locked[0])!={'revision'}
                    or not _integer(locked[0]['revision'])):
                raise SourceUnavailable()
            revision = locked[0]['revision']
            if cursor is not None and cursor.source_revision!=revision:
                raise FoobarHistoryStale()
            sql = _LIST_SQL[(request.family,request.mode,cursor.kind if cursor else None)]
            if not sql.isascii() or len(sql)>MAX_SQL_BYTES:
                raise SourceUnavailable()
            rows = _query(connection,sql,frame,maximum=21)
            items = tuple(_item(row,request,revision) for row in rows)
            previous = _key(cursor) if cursor is not None else None
            for item in items:
                key = _key(item)
                if previous is not None and key>=previous:
                    raise SourceUnavailable()
                previous = key
            visible = items[:PAGE_SIZE]
            last = visible[-1] if len(items)>PAGE_SIZE else None
            next_cursor = (FoobarHistoryCursor(account_id,request.source_ref,revision,request.family,
                request.mode,last.sort_key,last.kind,last.observation_ref) if last is not None else None)
            result = FoobarHistoryPage(request.source_ref,revision,request.family,request.mode,visible,next_cursor)
        return result
    except (FoobarHistoryInvalid,SourceStale,SourceUnavailable):
        raise
    except Exception:
        raise SourceUnavailable() from None


_SOURCE_FRAME_SQL = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref from f)
"""
_SOURCE_SELECT_SQL = """select s.source_ref::text source_ref,s.created_at,s.is_default,s.observation_count
from integration.foobar_import_streams_v2 s where s.account_id=(select account_id from x)"""
_SOURCE_LIST_SQL = {
    False:_SOURCE_FRAME_SQL+_SOURCE_SELECT_SQL+' order by s.source_ref asc limit 21',
    True:_SOURCE_FRAME_SQL+_SOURCE_SELECT_SQL+' and s.source_ref>(select source_ref from x) order by s.source_ref asc limit 21',
}


def _source_item(row):
    if (type(row) is not dict or set(row)!={'source_ref','created_at','is_default','observation_count'}
            or not _uuid(row['source_ref']) or type(row['is_default']) is not bool
            or not _integer(row['observation_count'],0,100000)
            or type(row['created_at']) is not datetime or row['created_at'].tzinfo is None
            or row['created_at'].utcoffset() is None):
        raise SourceUnavailable()
    created = row['created_at'].astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
    if len(created)!=27:
        raise SourceUnavailable()
    return FoobarHistorySourceItem(row['source_ref'],created,row['is_default'],row['observation_count'])


def list_foobar_history_sources(database_url,context,*,cursor=None,constraints=None):
    """Read <=21 source scalars by account PK; never create a default source.

    This selector is not a combined history across sources. A selected source is
    freshly locked and authorized by read_foobar_history. Source additions/deletes
    across source pages are not frozen, and the list cursor is position only.
    """
    validate_foobar_history_source_cursor(cursor)
    try:
        with current_foobar_account_read_transaction(database_url,context,constraints=constraints) as (connection,live,now):
            account_id = live.actor.account_id
            if cursor is not None and cursor.account_id!=account_id:
                raise FoobarHistoryStale()
            require_foobar_history_on_connection(connection)
            frame = json.dumps((account_id,cursor.source_ref if cursor else None),separators=(',',':')).encode('ascii')
            if len(frame)>MAX_FRAME_BYTES:
                raise SourceUnavailable()
            rows = _query(connection,_SOURCE_LIST_SQL[cursor is not None],frame,maximum=21)
            items = tuple(_source_item(row) for row in rows)
            previous = cursor.source_ref if cursor else None
            for item in items:
                if previous is not None and item.source_ref<=previous:
                    raise SourceUnavailable()
                previous = item.source_ref
            visible = items[:PAGE_SIZE]
            next_cursor = FoobarHistorySourceCursor(account_id,visible[-1].source_ref) if len(items)>PAGE_SIZE else None
            result = FoobarHistorySourcePage(visible,next_cursor)
        return result
    except (FoobarHistoryInvalid,SourceStale,SourceUnavailable):
        raise
    except Exception:
        raise SourceUnavailable() from None
