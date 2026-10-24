"""Current source-labelled Foobar evidence for an authorized library track.

No aggregate across sources/providers, native mutation, media probe or path.
Pages are current reads, not a historical all-source snapshot; refresh restarts.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from datetime import datetime as Timestamp
from hashlib import sha256
import json

from . import foobar_account_history_native as native
from .foobar_account_history_evidence import decode_current_projection, EXTRA_KEYS, snapshots
from .foobar_account_history_postgres import FoobarHistoryInvalid, FoobarHistoryStale
from .foobar_account_source_postgres import SourceUnavailable, _query
from .foobar_account_authority import require_account_foobar_read
from .foobar_account_history_readiness import require_foobar_history_on_connection
from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
from .private_library_authority import current_library_transaction, require_private_action
from .policy import ResourceScope

PAGE_SIZE = 20
TRACK_EVIDENCE_PHASE_BYTES = 2_097_152
MAX_RESPONSE_BYTES = 65536

@dataclass(frozen=True, slots=True)
class TrackEvidenceCursor:
    account_id: int
    library_id: int
    track_id: int
    track_sha256: str
    family: str
    source_ref: str
    observation_ref: str

@dataclass(frozen=True, slots=True)
class TrackEvidenceRequest:
    track_id: int
    family: str
    cursor: TrackEvidenceCursor | None = None

@dataclass(frozen=True, slots=True)
class TrackEvidenceItem:
    source_ref: str
    source_created_at: str
    observation_ref: str
    source_revision: int
    association_version: int
    evidence_kind: str
    count_state: str
    count: int | None
    status: str
    reason: str | None

@dataclass(frozen=True, slots=True)
class TrackEvidencePage:
    track_id: int
    family: str
    items: tuple[TrackEvidenceItem, ...]
    next_cursor: TrackEvidenceCursor | None
    consistency: str = 'current_page_refresh_to_restart'


def validate_request(request):
    if (type(request) is not TrackEvidenceRequest or type(request.track_id) is not int
            or not 1 <= request.track_id <= 9223372036854775807
            or request.family not in ('standard', 'enhanced')):
        raise FoobarHistoryInvalid()
    c = request.cursor
    if c is not None and (type(c) is not TrackEvidenceCursor
            or any(type(v) is not int or not 1 <= v <= 9223372036854775807
                   for v in (c.account_id,c.library_id,c.track_id))
            or c.track_id != request.track_id or c.family != request.family
            or type(c.track_sha256) is not str or len(c.track_sha256) != 64
            or any(x not in '0123456789abcdef' for x in c.track_sha256)
            or not native._uuid(c.source_ref) or not native._uuid(c.observation_ref)):
        raise FoobarHistoryInvalid()

_TRACK = """select t.id,case when octet_length(t.track_key) between 1 and 4096
 then t.track_key end track_key from library.local_tracks t
 where t.library_id=%s and t.id=%s for share of t"""
_INDEX = """select exists(
 select 1 from pg_catalog.pg_index i
 join pg_catalog.pg_class x on x.oid=i.indexrelid
 join pg_catalog.pg_class r on r.oid=i.indrelid
 join pg_catalog.pg_namespace n on n.oid=r.relnamespace
 join pg_catalog.pg_am am on am.oid=x.relam
 where n.nspname='integration' and r.relname='foobar_import_local_matches_v2'
 and am.amname='btree' and i.indisvalid and i.indisready and i.indislive
 and i.indpred is null and i.indexprs is null and i.indnkeyatts=5 and i.indnatts=5
 and (select array_agg(a.attname::text order by k.ordinality)
      from unnest(i.indkey) with ordinality k(attnum,ordinality)
      join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.attnum)
     =array['account_id','library_id','track_key','source_ref','observation_ref']::text[]
 and (select bool_and(v=0) from unnest(i.indoption) v)
 and not exists(select 1 from unnest(i.indclass) with ordinality k(opclass,ordinality)
   join pg_catalog.pg_opclass op on op.oid=k.opclass
   join pg_catalog.pg_namespace ns on ns.oid=op.opcnamespace
   where not op.opcdefault or ns.nspname<>'pg_catalog')
 and not exists(select 1 from unnest(i.indcollation) with ordinality co(collation,ordinality)
   join unnest(i.indkey) with ordinality k(attnum,ordinality) using(ordinality)
   join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum=k.attnum
   where co.collation<>a.attcollation)
) as ready"""
_FRAME = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::bigint library_id,
 (j->>2)::bigint track_id,(j->>3)::uuid source_ref,(j->>4)::uuid observation_ref from f)
"""
_CHOSEN = """, chosen as materialized (
 select m.account_id,m.source_ref,m.observation_ref,m.library_id,m.track_key,
 m.decision_ref,m.match_version from integration.foobar_import_local_matches_v2 m
 where m.account_id=(select account_id from x) and m.library_id=(select library_id from x)
 and m.track_key=(select t.track_key from library.local_tracks t
  where t.library_id=(select library_id from x) and t.id=(select track_id from x))
 {cursor}
 order by m.source_ref,m.observation_ref limit 21)
"""
_SELECT = """select c.source_ref::text source_ref,c.observation_ref::text observation_ref,
s.created_at source_created_at,p.source_revision,case when octet_length(p.projection_bytes) between 1 and 8192
 then p.projection_bytes end projection_bytes,
encode(p.projection_sha256,'hex') projection_sha256,
encode(p.effective_evidence_sha256,'hex') effective_evidence_sha256,
encode(p.display_sha256,'hex') display_sha256,
p.standard_first,p.standard_last,p.enhanced_first,p.enhanced_last,
p.standard_last_present,p.enhanced_last_present,o.current_revision,
encode(r.evidence_sha256,'hex') current_effective_sha256,
encode(r.display_sha256,'hex') current_display_sha256,
case when p.evidence_kind in ('tsv_snapshot','enhanced_store') then p.evidence_kind end evidence_kind,
p.local_entry_count,case when octet_length(p.local_vector_sha256)=32
 then encode(p.local_vector_sha256,'hex') end local_vector_sha256,
c.decision_ref::text binding_decision,c.match_version binding_version,t.id binding_track_id,
d.decision_ref::text saved_decision,d.match_version saved_version,case when d.action in ('match','rematch','detach') then d.action end saved_action,
d.original_track_id saved_track_id,h.decision_ref::text head_decision,
h.match_version head_version,case when h.action in ('match','rematch','detach') then h.action end head_action,h.original_track_id head_track_id
from chosen c
left join library.local_tracks t on (t.library_id,t.track_key)=(c.library_id,c.track_key)
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=(c.account_id,c.source_ref,c.observation_ref)
left join integration.foobar_import_revisions_v2 r
 on (r.account_id,r.source_ref,r.observation_ref,r.source_revision)=
 (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
left join integration.foobar_import_history_projection_v1 p
 on (p.account_id,p.source_ref,p.observation_ref)=(c.account_id,c.source_ref,c.observation_ref)
left join integration.foobar_import_match_decisions_v2 d
 on (d.account_id,d.source_ref,d.observation_ref,d.decision_ref,d.original_library_id,d.match_version)=
 (c.account_id,c.source_ref,c.observation_ref,c.decision_ref,c.library_id,c.match_version)
left join lateral(select z.decision_ref,z.match_version,z.action,z.original_track_id
 from integration.foobar_import_match_decisions_v2 z
 where (z.account_id,z.source_ref,z.observation_ref,z.original_library_id)=
 (c.account_id,c.source_ref,c.observation_ref,c.library_id)
 order by z.match_version desc limit 1) h on true
left join integration.foobar_import_sources_v2 s on (s.account_id,s.source_ref)=(c.account_id,c.source_ref)
order by c.source_ref,c.observation_ref"""
_QUERIES = {False: _FRAME + _CHOSEN.format(cursor='') + _SELECT,
 True: _FRAME + _CHOSEN.format(cursor='and (m.source_ref,m.observation_ref)>((select source_ref from x),(select observation_ref from x))') + _SELECT}


def read_track_evidence(database_url, context, request, *, constraints=None):
    validate_request(request)
    with current_library_transaction(database_url, context, constraints=constraints,
            read_only=True, inventory_publication_first=True) as (connection, live, now):
        require_account_foobar_read(live,constraints)
        resource=ResourceScope('track',str(request.track_id))
        require_private_action(live,'library.browse.read',resource=resource,constraints=constraints)
        account, library=live.actor.account_id,live.library_id
        require_foobar_history_on_connection(connection)
        require_foobar_match_schema_on_connection(connection)
        rows=native._native_rows(connection,_INDEX,(),1)
        if rows != [{'ready':True}] or type(rows[0]['ready']) is not bool:
            raise SourceUnavailable()
        rows=native._native_rows(connection,_TRACK,(library,request.track_id),1)
        if (len(rows)!=1 or set(rows[0])!={'id','track_key'}
                or type(rows[0]['id']) is not int or rows[0]['id']!=request.track_id
                or type(rows[0]['track_key']) is not str
                or not 1<=len(rows[0]['track_key'].encode('utf-8'))<=4096):
            raise FoobarHistoryStale()
        target_sha=sha256(rows[0]['track_key'].encode('utf-8')).hexdigest()
        c=request.cursor
        if c is not None and (c.account_id!=account or c.library_id!=library or c.track_sha256!=target_sha):
            raise FoobarHistoryStale()
        frame=json.dumps((account,library,request.track_id,c.source_ref if c else None,
            c.observation_ref if c else None),separators=(',',':')).encode('ascii')
        if len(frame)>256: raise FoobarHistoryInvalid()
        rows=_query(connection,_QUERIES[c is not None],frame,maximum=PAGE_SIZE+1)
        projection_keys=snapshots._BINDING_KEYS | EXTRA_KEYS
        all_keys=projection_keys | native._BINDING_KEYS | {'source_ref','observation_ref','source_created_at'}
        previous=(c.source_ref,c.observation_ref) if c else None
        items=[]
        for row in rows:
            if (type(row) is not dict or set(row)!=all_keys
                    or not native._uuid(row['source_ref']) or not native._uuid(row['observation_ref'])):
                raise SourceUnavailable()
            key=(row['source_ref'],row['observation_ref'])
            if previous is not None and key<=previous: raise SourceUnavailable()
            previous=key
            if native._binding([{k:row[k] for k in native._BINDING_KEYS}])!=request.track_id:
                raise FoobarHistoryStale()
            created=row['source_created_at']
            if type(created) is not Timestamp or created.tzinfo is None or created.utcoffset() is None:
                raise SourceUnavailable()
            stamp=created.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
            if len(stamp)!=27: raise SourceUnavailable()
            kind,projection=decode_current_projection({k:row[k] for k in projection_keys})
            if kind=='enhanced_store':
                count=projection.local_entry_count
                state='unavailable' if count is None else 'valid'
                status='unavailable' if count is None else 'ready'
                reason='local_timestamp_vector_unavailable' if count is None else None
            else:
                family=getattr(projection,request.family)
                count,state,status,reason=family.total,family.count_state,family.status,family.reason
            items.append(TrackEvidenceItem(row['source_ref'],stamp,row['observation_ref'],
                row['source_revision'],row['binding_version'],kind,state,count,status,reason))
        more=len(items)>PAGE_SIZE
        visible=tuple(items[:PAGE_SIZE])
        next_cursor=None
        if more:
            last=visible[-1]
            next_cursor=TrackEvidenceCursor(account,library,request.track_id,target_sha,request.family,
                last.source_ref,last.observation_ref)
        native.lock_current_actor_session(connection,actor_account_id=account,
            actor_session_id=live.actor.session_id,clock=lambda:datetime.now(timezone.utc))
        require_account_foobar_read(live,constraints)
        require_private_action(live,'library.browse.read',resource=resource,constraints=constraints)
        return TrackEvidencePage(request.track_id,request.family,visible,next_cursor)
