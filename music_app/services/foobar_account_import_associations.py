"""Bounded same-transaction v3 binding snapshots and first-association writes.

No transaction is opened here. The caller owns whole-import rollback, genuine
source writes, current authority and success publication after outer commit.
"""
from dataclasses import dataclass
from dataclasses import replace
import json
from uuid import UUID, uuid5

from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_postgres as source
from .foobar_account_matching_authority import require_account_foobar, lock_foobar_matching_context
from .foobar_account_source_postgres import SourceUnavailable, SourceStale
from .policy import ResourceScope
from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints

MAX_ROWS=100
MAX_FRAME_BYTES=65536
_OPERATION_NAMESPACE=UUID('bfe3cdd2-dc7b-5bae-84e4-e8a26ab9ca06')
_DECISION_NAMESPACE=UUID('28d8f0d7-7671-5608-aa70-9c5bbab5cc27')
_RESOLUTIONS=('saved','explicit_detach','availability_lost','never_decided','no_library')


@dataclass(frozen=True,slots=True)
class AssociationWriteOutcome:
    ordinal: int
    observation_ref: str
    changed: bool
    postseal: tuple


def association_phase_bytes(count):
    if type(count) is not int or not 1<=count<=MAX_ROWS:
        raise SourceUnavailable()
    # Original/control/result/forwarding tuples, canonical frame and native
    # result occurrences. No path/key bytes are ever projected into Python.
    return 262144+8192*count


def association_outcome_bytes(count):
    if type(count) is not int or not 1<=count<=MAX_ROWS:
        raise SourceUnavailable()
    return 1024+2048*count


def _observations(observations):
    if type(observations) is not tuple or not 1<=len(observations)<=MAX_ROWS:
        raise SourceUnavailable()
    last=0
    for i,item in enumerate(observations):
        if (type(item) is not tuple or len(item)!=2
                or not gate._integer(item[0],last+1,100000) or not gate._uuid(item[1])
                or any(p[1]==item[1] for p in observations[:i])):
            raise SourceUnavailable()
        last=item[0]


def _from_rows(rows):
    if type(rows) is not tuple or not 1<=len(rows)<=MAX_ROWS:
        raise SourceUnavailable()
    if any(type(row) is not tuple or len(row)!=12 for row in rows):
        raise SourceUnavailable()
    result=tuple((row[0],row[2]) for row in rows)
    _observations(result)
    return result


def _seals(observations,seals,library_id):
    _observations(observations)
    if type(seals) is not tuple or len(seals)!=len(observations):
        raise SourceUnavailable()
    if library_id is not None and not gate._integer(library_id,1,gate._MAX):
        raise SourceUnavailable()
    for (ordinal,_),s in zip(observations,seals):
        if type(s) is not tuple or len(s)!=10 or s[0]!=ordinal or type(s[0]) is not int:
            raise SourceUnavailable()
        if type(s[8]) is not str or s[8] not in _RESOLUTIONS:
            raise SourceUnavailable()
        if library_id is None:
            if s!=(ordinal,None,None,None,None,None,None,None,'no_library',None):
                raise SourceUnavailable()
            continue
        if s[8]=='no_library':
            raise SourceUnavailable()
        if s[9] is not None and not gate._integer(s[9],1,gate._MAX):
            raise SourceUnavailable()
        if s[8]=='never_decided':
            if any(v is not None for v in s[1:8]):
                raise SourceUnavailable()
            continue
        if (not gate._uuid(s[4]) or not gate._integer(s[5],1,gate._MAX)
                or type(s[6]) is not str or s[6] not in ('match','rematch','detach')):
            raise SourceUnavailable()
        if s[6]=='detach':
            if s[7] is not None:
                raise SourceUnavailable()
        elif not gate._integer(s[7],1,gate._MAX):
            raise SourceUnavailable()
        if s[8]=='saved':
            if (not gate._uuid(s[1]) or not gate._integer(s[2],1,gate._MAX)
                    or s[1]!=s[4] or s[2]!=s[5] or not gate._integer(s[3],1,gate._MAX)
                    or s[3]!=s[7] or s[6]=='detach' or s[9] not in (None,s[3])):
                raise SourceUnavailable()
        elif (any(v is not None for v in s[1:4]) or s[9] is not None
              or (s[8]=='explicit_detach') != (s[6]=='detach')):
            raise SourceUnavailable()


def _frame(account_id,source_ref,library_id,items):
    payload=json.dumps((account_id,source_ref,library_id,items),
        ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    return payload


_F="""with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized(select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
 (j->>2)::bigint library_id from f),
inputs as materialized(select (r->>0)::integer ordinal,(r->>1)::uuid observation_ref,
 (r->>2)::bigint track_id,(r->>3)::uuid operation_ref,(r->>4)::uuid decision_ref
 from f cross join lateral jsonb_array_elements(j->3) r)
"""
_READ=_F+"""
select i.ordinal,m.decision_ref::text binding_decision,m.match_version binding_version,
 t.id binding_track_id,h.decision_ref::text head_decision,h.match_version head_version,
 h.action head_action,h.original_track_id head_track_id
from inputs i cross join x
left join integration.foobar_import_local_matches_v2 m on
 (m.account_id,m.source_ref,m.observation_ref,m.library_id)=
 (x.account_id,x.source_ref,i.observation_ref,x.library_id)
left join library.local_tracks t on (t.library_id,t.track_key)=(m.library_id,m.track_key)
left join lateral (
 select d.decision_ref,d.match_version,d.action,d.original_track_id
 from integration.foobar_import_match_decisions_v2 d
 where (d.account_id,d.source_ref,d.observation_ref,d.original_library_id)=
 (x.account_id,x.source_ref,i.observation_ref,x.library_id)
 order by d.match_version desc limit 1
) h on true
order by i.ordinal
"""
_TARGETS=_F+"""
select i.ordinal,t.id track_id,t.library_id
from inputs i cross join x join library.local_tracks t
 on t.id=i.track_id and t.library_id=x.library_id
where octet_length(t.track_key) between 1 and 4096
order by i.ordinal for share of t
"""
_CONFLICTS=_F+""",
targets as materialized(select v::bigint track_id
 from f cross join lateral jsonb_array_elements_text(j->4) v)
select p.track_id from targets p cross join x
where exists(select 1 from integration.foobar_import_local_matches_v2 m
 join library.local_tracks t on (t.library_id,t.track_key)=(m.library_id,m.track_key)
 where (m.account_id,m.source_ref,m.library_id)=(x.account_id,x.source_ref,x.library_id)
 and t.id=p.track_id
 and not exists(select 1 from inputs i where i.observation_ref=m.observation_ref))
order by p.track_id
"""
_WRITE=_F+""",
history as (
 insert into integration.foobar_import_match_decisions_v2 as d
 (account_id,source_ref,observation_ref,decision_ref,match_version,operation_ref,
  expected_decision_ref,expected_match_version,action,original_library_id,
  original_track_id,actor_account_id)
 select x.account_id,x.source_ref,i.observation_ref,i.decision_ref,1,i.operation_ref,
 null,null,'match',x.library_id,i.track_id,x.account_id
 from inputs i cross join x
 join integration.foobar_import_observations_v2 o on
 (o.account_id,o.source_ref,o.observation_ref)=(x.account_id,x.source_ref,i.observation_ref)
 join library.local_tracks t on t.id=i.track_id and t.library_id=x.library_id
 where octet_length(t.track_key) between 1 and 4096
 and not exists(select 1 from integration.foobar_import_match_decisions_v2 old
  where (old.account_id,old.source_ref,old.observation_ref,old.original_library_id)=
  (x.account_id,x.source_ref,i.observation_ref,x.library_id))
 and not exists(select 1 from integration.foobar_import_local_matches_v2 m
  where (m.account_id,m.source_ref,m.observation_ref,m.library_id)=
  (x.account_id,x.source_ref,i.observation_ref,x.library_id))
 returning d.account_id,d.source_ref,d.observation_ref,d.original_library_id,
 d.original_track_id,d.operation_ref,d.decision_ref,d.match_version
), bindings as (
 insert into integration.foobar_import_local_matches_v2 as m
 (account_id,source_ref,observation_ref,library_id,track_key,decision_ref,match_version)
 select h.account_id,h.source_ref,h.observation_ref,h.original_library_id,
 t.track_key,h.decision_ref,h.match_version from history h
 join library.local_tracks t on t.id=h.original_track_id and t.library_id=h.original_library_id
 returning m.account_id,m.source_ref,m.observation_ref,m.library_id,m.decision_ref,m.match_version
)
select i.ordinal,h.operation_ref::text operation_ref,h.decision_ref::text decision_ref,
 h.match_version,h.original_track_id track_id
from inputs i join history h on h.observation_ref=i.observation_ref
join bindings b on (b.account_id,b.source_ref,b.observation_ref,b.library_id,b.decision_ref,b.match_version)=
 (h.account_id,h.source_ref,h.observation_ref,h.original_library_id,h.decision_ref,h.match_version)
order by i.ordinal
"""


def _scope(connection,context,source_ref,library_id,constraints):
    if not gate._uuid(source_ref):
        raise SourceUnavailable()
    account=require_account_foobar(context,constraints)
    if library_id is None:
        return account
    if not gate._integer(library_id,1,gate._MAX):
        raise SourceUnavailable()
    lock=json.dumps((account.actor.account_id,None,account.actor.session_id,source_ref,1,None),
                    separators=(',',':')).encode('ascii')
    gate._stream_result(source._query(connection,gate._LOCK_SQL,lock,maximum=1))
    return lock_foobar_matching_context(connection,account,context,library_id,constraints=constraints)


def read_import_associations_on_connection(connection,live_context,*,source_ref,
        library_id,observations,constraints=None):
    """Read <=100 bounded real bindings/history; caller already owns publication lock."""
    _observations(observations)
    live=_scope(connection,live_context,source_ref,library_id,constraints)
    if library_id is None:
        return tuple((o,None,None,None,None,None,None,None,'no_library',None) for o,_ in observations)
    items=tuple((o,r,None,None,None) for o,r in observations)
    rows=source._query(connection,_READ,_frame(live.actor.account_id,source_ref,library_id,items),
                       maximum=len(items))
    keys=('ordinal','binding_decision','binding_version','binding_track_id',
          'head_decision','head_version','head_action','head_track_id')
    if len(rows)!=len(items):
        raise SourceUnavailable()
    result=[]
    for expected,row in zip(observations,rows):
        if type(row) is not dict or set(row)!=set(keys) or row['ordinal']!=expected[0]:
            raise SourceUnavailable()
        values=tuple(row[k] for k in keys)
        resolution=('saved' if row['binding_decision'] is not None else
                    'never_decided' if row['head_decision'] is None else
                    'explicit_detach' if row['head_action']=='detach' else 'availability_lost')
        result.append(values+(resolution,None))
    result=tuple(result)
    _seals(observations,result,library_id)
    return result


def check_foobar_association_seals_on_connection(connection,live_context,*,source_ref,
        matching_library_id,rows,seals,constraints=None):
    observations=_from_rows(rows)
    _seals(observations,seals,matching_library_id)
    actual=read_import_associations_on_connection(connection,live_context,source_ref=source_ref,
        library_id=matching_library_id,observations=observations,constraints=constraints)
    if any(a[:9]!=s[:9] for a,s in zip(actual,seals)):
        raise SourceStale()
    planned=tuple(s[9] for s in seals if s[9] is not None)
    if len(set(planned))!=len(planned):
        raise SourceStale()
    # The external query excludes all candidate subjects. Their retained
    # bindings still reserve targets even when their own native projection
    # was suppressed. Never let another candidate claim such a target.
    if any(s[9] is not None and any(other[0]!=s[0] and other[8]=='saved'
            and other[3]==s[9] for other in actual) for s in seals):
        raise SourceStale()
    if planned:
        conflict_live=_scope(connection,live_context,source_ref,matching_library_id,constraints)
        if projection_conflicts_on_connection(connection,conflict_live,
                source_ref=source_ref,observations=observations,track_ids=planned,
                constraints=constraints):
            raise SourceStale()


def projection_conflicts_on_connection(connection,live_context,*,source_ref,
        observations,track_ids,constraints=None):
    """Return only requested IDs bound outside this exact candidate subject set."""
    _observations(observations)
    if (type(track_ids) is not tuple or len(track_ids)>MAX_ROWS
            or any(not gate._integer(v,1,gate._MAX) for v in track_ids)
            or len(set(track_ids))!=len(track_ids)):
        raise SourceUnavailable()
    if not track_ids:
        return frozenset()
    library_id=live_context.library_id
    if not gate._integer(library_id,1,gate._MAX):
        raise SourceUnavailable()
    live=_scope(connection,live_context,source_ref,library_id,constraints)
    items=tuple((o,r,None,None,None) for o,r in observations)
    payload=json.dumps((live.actor.account_id,source_ref,library_id,items,track_ids),
        ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>MAX_FRAME_BYTES:
        raise SourceUnavailable()
    rows=source._query(connection,_CONFLICTS,payload,maximum=len(track_ids))
    last=0
    result=[]
    for row in rows:
        if (type(row) is not dict or set(row)!={'track_id'}
                or not gate._integer(row['track_id'],last+1,gate._MAX)
                or row['track_id'] not in track_ids):
            raise SourceUnavailable()
        last=row['track_id']
        result.append(last)
    return frozenset(result)


def _identities(receipt_ref,observation_ref,library_id):
    name=receipt_ref+':'+observation_ref+':'+str(library_id)
    return str(uuid5(_OPERATION_NAMESPACE,name)),str(uuid5(_DECISION_NAMESPACE,name))


def _postseal(seal,receipt_ref,observation_ref,library_id):
    if seal[8]!='never_decided' or seal[9] is None:
        return seal
    _,decision=_identities(receipt_ref,observation_ref,library_id)
    return (seal[0],decision,1,seal[9],decision,1,'match',seal[9],'saved',seal[9])


def validate_foobar_association_outcomes(rows,seals,outcomes,*,receipt_ref,matching_library_id):
    observations=_from_rows(rows)
    _seals(observations,seals,matching_library_id)
    if not gate._uuid(receipt_ref) or type(outcomes) is not tuple or len(outcomes)!=len(seals):
        raise SourceUnavailable()
    changed=0
    for (ordinal,ref),seal,outcome in zip(observations,seals,outcomes):
        expected=_postseal(seal,receipt_ref,ref,matching_library_id)
        if (type(outcome) is not AssociationWriteOutcome
                or type(outcome.changed) is not bool or type(outcome.ordinal) is not int
                or outcome.ordinal!=ordinal or outcome.observation_ref!=ref
                or outcome.postseal!=expected or outcome.changed!=(expected!=seal)):
            raise SourceUnavailable()
        changed+=int(outcome.changed)
    return changed


def _browse(live,track_id,constraints):
    target=replace(live,action='library.browse.read',resource=ResourceScope('track',str(track_id)),
                   target_account_id=live.actor.account_id)
    try:
        effective=constraints(target) if callable(constraints) else constraints
        if effective is not None and type(effective) is not PolicyEvaluationConstraints:
            raise SourceUnavailable()
        allowed=PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed
        if type(allowed) is not bool:
            raise SourceUnavailable()
    except Exception:
        raise SourceUnavailable() from None
    if not allowed:
        raise SourceStale()


def apply_foobar_associations_on_connection(connection,live_context,*,source_ref,receipt_ref,
        matching_library_id,rows,seals,constraints=None):
    observations=_from_rows(rows)
    if not gate._uuid(receipt_ref):
        raise SourceUnavailable()
    check_foobar_association_seals_on_connection(connection,live_context,source_ref=source_ref,
        matching_library_id=matching_library_id,rows=rows,seals=seals,constraints=constraints)
    items=tuple((o,r,s[9],*_identities(receipt_ref,r,matching_library_id))
                for (o,r),s in zip(observations,seals) if s[8]=='never_decided' and s[9] is not None)
    if items:
        live=_scope(connection,live_context,source_ref,matching_library_id,constraints)
        for item in items:
            _browse(live,item[2],constraints)
        frame=_frame(live.actor.account_id,source_ref,matching_library_id,items)
        targets=source._query(connection,_TARGETS,frame,maximum=len(items))
        expected=[{'ordinal':i[0],'track_id':i[2],'library_id':matching_library_id} for i in items]
        if (targets!=expected or any(type(r) is not dict
                or any(type(v) is not int for v in r.values()) for r in targets)):
            raise SourceStale()
        written=source._query(connection,_WRITE,frame,maximum=len(items))
        expected=[{'ordinal':i[0],'operation_ref':i[3],'decision_ref':i[4],
                   'match_version':1,'track_id':i[2]} for i in items]
        if (written!=expected or any(type(r) is not dict
                or any(type(r[k]) is not int for k in ('ordinal','match_version','track_id'))
                or any(type(r[k]) is not str for k in ('operation_ref','decision_ref')) for r in written)):
            raise SourceUnavailable()
        for item in items:
            _browse(live,item[2],constraints)
        require_account_foobar(live,constraints)
    outcomes=tuple(AssociationWriteOutcome(o,r,_postseal(s,receipt_ref,r,matching_library_id)!=s,
                    _postseal(s,receipt_ref,r,matching_library_id))
                   for (o,r),s in zip(observations,seals))
    check_foobar_association_postimages_on_connection(connection,live_context,source_ref=source_ref,
        receipt_ref=receipt_ref,matching_library_id=matching_library_id,rows=rows,seals=seals,
        outcomes=outcomes,constraints=constraints)
    return outcomes


def check_foobar_association_postimages_on_connection(connection,live_context,*,source_ref,
        receipt_ref,matching_library_id,rows,seals,outcomes,constraints=None):
    validate_foobar_association_outcomes(rows,seals,outcomes,receipt_ref=receipt_ref,
                                        matching_library_id=matching_library_id)
    postseals=tuple(o.postseal for o in outcomes)
    check_foobar_association_seals_on_connection(connection,live_context,source_ref=source_ref,
        matching_library_id=matching_library_id,rows=rows,seals=postseals,constraints=constraints)
