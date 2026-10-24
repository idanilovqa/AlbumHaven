"""Explicit account-owned binding decisions and source concurrency revision.

No source evidence, listening, quota, or taste mutation.

This protocol is separate from all import envelopes. An exact historical
operation replay is resolved before current binding or library inspection.
"""
from dataclasses import dataclass, replace
from datetime import datetime
import json
from uuid import uuid4

from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_postgres as source
from . import foobar_account_import_prepare as prepare
from .foobar_account_matching_authority import (
    current_foobar_import_transaction, lock_foobar_matching_context, require_account_foobar,
)
from .foobar_account_source_postgres import SourceUnavailable, SourceStale
from .foobar_account_match_readiness import require_foobar_match_schema
from .policy import ResourceScope
from .policy_evaluator import PolicyEvaluator, PolicyEvaluationConstraints

VERSION = 'foobar_account_match_decision_v1'
MAX_KEY_BYTES = 4096
CONTROL_BYTES = 262144  # Local scalar/frame owners; native authority retains its own bounds.
_FIELDS = ('source_ref','observation_ref','operation_ref','action','library_id',
           'original_track_id','expected_decision_ref','expected_match_version')
_KEYS = frozenset(('version',) + _FIELDS)


class MatchDecisionInvalid(gate.PrepareInvalid):
    pass


class MatchDecisionCommitUncertain(SourceUnavailable):
    commit_uncertain = True


@dataclass(frozen=True, slots=True)
class FoobarMatchDecisionCommand:
    source_ref: str
    observation_ref: str
    operation_ref: str
    action: str
    library_id: int
    original_track_id: int | None
    expected_decision_ref: str | None
    expected_match_version: int | None


@dataclass(frozen=True, slots=True)
class FoobarMatchDecision:
    source_ref: str
    observation_ref: str
    operation_ref: str
    action: str
    library_id: int
    original_track_id: int | None
    expected_decision_ref: str | None
    expected_match_version: int | None
    decision_ref: str
    match_version: int
    created_at: datetime


@dataclass(frozen=True, slots=True)
class FoobarMatchPreview:
    command: FoobarMatchDecisionCommand
    next_match_version: int
    replay: FoobarMatchDecision | None


def validate_command(command):
    try:
        if (type(command) is not FoobarMatchDecisionCommand
                or any(not gate._uuid(getattr(command,k)) for k in _FIELDS[:3])
                or type(command.action) is not str
                or command.action not in ('match','rematch','detach')
                or not gate._integer(command.library_id,1,gate._MAX)):
            raise MatchDecisionInvalid()
        if command.action == 'detach':
            if command.original_track_id is not None:
                raise MatchDecisionInvalid()
        elif not gate._integer(command.original_track_id,1,gate._MAX):
            raise MatchDecisionInvalid()
        if command.expected_decision_ref is None:
            if command.expected_match_version is not None:
                raise MatchDecisionInvalid()
        elif (not gate._uuid(command.expected_decision_ref)
              or not gate._integer(command.expected_match_version,1,gate._MAX)):
            raise MatchDecisionInvalid()
    except MatchDecisionInvalid:
        raise
    except Exception:
        raise MatchDecisionInvalid() from None


def command_from_mapping(value):
    if (type(value) is not dict or len(value)!=9 or set(value)!=_KEYS
            or type(value['version']) is not str or value['version']!=VERSION):
        raise MatchDecisionInvalid()
    command=FoobarMatchDecisionCommand(*(value[k] for k in _FIELDS))
    validate_command(command)
    return command


def command_to_mapping(command):
    validate_command(command)
    return dict(version=VERSION, **{k:getattr(command,k) for k in _FIELDS})


def _frame(account_id, command, *tail):
    values=(account_id,)+(tuple(getattr(command,k) for k in _FIELDS))+tail
    # Fixed typed controls and a prebounded internal key; never raw library paths.
    payload=json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(payload)>32768:
        raise SourceUnavailable()
    return payload


_F = "with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j) "
_SUBJECT = """
select o.observation_ref::text observation_ref
from integration.foobar_import_observations_v2 o cross join f
where (o.account_id,o.source_ref,o.observation_ref)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid)
"""
_PROJECTION = """d.source_ref::text source_ref,d.observation_ref::text observation_ref,
d.operation_ref::text operation_ref,d.action,d.original_library_id library_id,
d.original_track_id,d.expected_decision_ref::text expected_decision_ref,
d.expected_match_version,d.decision_ref::text decision_ref,d.match_version,d.created_at"""
_REPLAY = _F + "select " + _PROJECTION + """
 from integration.foobar_import_match_decisions_v2 d cross join f
 where (d.account_id,d.source_ref,d.operation_ref)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>3)::uuid)
"""
_CURRENT = _F + """
select m.decision_ref::text decision_ref,m.match_version,d.action
from integration.foobar_import_local_matches_v2 m
join integration.foobar_import_match_decisions_v2 d on
 (d.account_id,d.source_ref,d.observation_ref,d.decision_ref,d.original_library_id,d.match_version)=
 (m.account_id,m.source_ref,m.observation_ref,m.decision_ref,m.library_id,m.match_version)
cross join f
where (m.account_id,m.source_ref,m.observation_ref,m.library_id)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid,(j->>5)::bigint)
for update of m
"""
_MAXIMUM = _F + """
select coalesce((select d.match_version
 from integration.foobar_import_match_decisions_v2 d
 where (d.account_id,d.source_ref,d.observation_ref,d.original_library_id)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid,(j->>5)::bigint)
 order by d.match_version desc limit 1),0)::bigint maximum_version from f
"""
_TARGET = _F + """
select t.id track_id,t.library_id,
 octet_length(t.track_key) key_bytes,
 case when octet_length(t.track_key) between 1 and 4096 then t.track_key end track_key
from library.local_tracks t cross join f
where t.id=(j->>6)::bigint and t.library_id=(j->>5)::bigint
for share of t
"""
_INSERT = _F + """
insert into integration.foobar_import_match_decisions_v2 as d
(account_id,source_ref,observation_ref,operation_ref,action,original_library_id,
 original_track_id,expected_decision_ref,expected_match_version,
 decision_ref,match_version,actor_account_id)
select (j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid,(j->>3)::uuid,j->>4,
 (j->>5)::bigint,(j->>6)::bigint,(j->>7)::uuid,(j->>8)::bigint,
 (j->>9)::uuid,(j->>10)::bigint,(j->>0)::bigint from f
returning """ + _PROJECTION
_BIND = _F + """
insert into integration.foobar_import_local_matches_v2 as m
(account_id,source_ref,observation_ref,library_id,track_key,decision_ref,match_version)
select (j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid,(j->>5)::bigint,
 j->>11,(j->>9)::uuid,(j->>10)::bigint from f
on conflict(account_id,source_ref,observation_ref,library_id) do update
set track_key=excluded.track_key,decision_ref=excluded.decision_ref,
 match_version=excluded.match_version
returning m.decision_ref::text decision_ref,m.match_version
"""
_DETACH = _F + """
delete from integration.foobar_import_local_matches_v2 m using f
where (m.account_id,m.source_ref,m.observation_ref,m.library_id)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>2)::uuid,(j->>5)::bigint)
returning m.decision_ref::text decision_ref,m.match_version
"""


def _decision(rows, command):
    if len(rows)!=1 or type(rows[0]) is not dict or set(rows[0])!=set(_FIELDS+(
            'decision_ref','match_version','created_at')):
        raise SourceUnavailable()
    row=rows[0]
    stored=FoobarMatchDecisionCommand(*(row[k] for k in _FIELDS))
    try:
        validate_command(stored)
        valid=(gate._uuid(row['decision_ref']) and gate._integer(row['match_version'],1,gate._MAX)
               and gate._time(row['created_at']))
    except Exception:
        raise SourceUnavailable() from None
    if not valid:
        raise SourceUnavailable()
    if stored!=command:
        raise SourceStale()
    return FoobarMatchDecision(*(row[k] for k in _FIELDS),
        row['decision_ref'],row['match_version'],row['created_at'])


def _current(connection, frame):
    rows=source._query(connection,_CURRENT,frame,maximum=1)
    if not rows:
        return None,None
    row=rows[0]
    if (type(row) is not dict or set(row)!= {'decision_ref','match_version','action'}
            or not gate._uuid(row['decision_ref'])
            or not gate._integer(row['match_version'],1,gate._MAX)
            or row['action'] not in ('match','rematch')):
        raise SourceUnavailable()
    return row['decision_ref'],row['match_version']


def _target(connection, live, context, command, frame, constraints):
    if command.action=='detach':
        return None
    matching=lock_foobar_matching_context(connection,live,context,command.library_id,constraints=constraints)
    target_context=replace(matching,action='library.browse.read',
        resource=ResourceScope('track',str(command.original_track_id)),
        target_account_id=live.actor.account_id)
    try:
        effective=constraints(target_context) if callable(constraints) else constraints
        if effective is not None and type(effective) is not PolicyEvaluationConstraints:
            raise SourceUnavailable()
        allowed=PolicyEvaluator().evaluate(target_context,constraints=effective).decision.allowed
        if type(allowed) is not bool:
            raise SourceUnavailable()
    except Exception:
        raise SourceUnavailable() from None
    if not allowed:
        raise SourceStale()
    rows=source._query(connection,_TARGET,frame,maximum=1)
    if not rows:
        raise SourceStale()
    row=rows[0]
    if (type(row) is not dict or set(row)!= {'track_id','library_id','key_bytes','track_key'}
            or type(row['track_id']) is not int or row['track_id']!=command.original_track_id
            or type(row['library_id']) is not int or row['library_id']!=command.library_id
            or not gate._integer(row['key_bytes'],1,MAX_KEY_BYTES)
            or type(row['track_key']) is not str
            or len(row['track_key'])>MAX_KEY_BYTES
            or len(row['track_key'].encode('utf8'))!=row['key_bytes']):
        raise SourceUnavailable()
    return row['track_key']


def _run(database_url, context, *, command, constraints, apply):
    validate_command(command)
    commit_attempted=False
    try:
        require_foobar_match_schema(database_url)
        prepare._private(CONTROL_BYTES)
        checked=prepare._checked_constraints(constraints)
        deadline=prepare._Deadline()
        with current_foobar_import_transaction(database_url,context,
                matching_library_id=None if command.action=='detach' else command.library_id,
                constraints=checked) as (raw,live,now):
            connection=prepare._Connection(raw,deadline)
            frame=_frame(live.actor.account_id,command)
            lock=json.dumps((live.actor.account_id,None,live.actor.session_id,
                             command.source_ref,1,None),separators=(',',':')).encode('ascii')
            stream=gate._stream_result(source._query(connection,gate._LOCK_SQL,lock,maximum=1))
            if stream['observed_at']<now:
                raise SourceUnavailable()
            original_revision = stream['revision']
            original_observed = stream['observed_at']
            del lock,stream
            rows=source._query(connection,_REPLAY,frame,maximum=1)
            if rows:
                historical=_decision(rows,command)
                result=historical if apply else FoobarMatchPreview(command,historical.match_version,historical)
            else:
                subject=source._query(connection,_F+_SUBJECT,frame,maximum=1)
                if subject!=[{'observation_ref':command.observation_ref}]:
                    raise SourceStale()
                expected=_current(connection,frame)
                if apply and expected!=(command.expected_decision_ref,command.expected_match_version):
                    raise SourceStale()
                proposed=replace(command,expected_decision_ref=expected[0],expected_match_version=expected[1])
                frame=_frame(live.actor.account_id,proposed)
                target=_target(connection,live,context,proposed,frame,checked)
                versions=source._query(connection,_MAXIMUM,frame,maximum=1)
                if (len(versions)!=1 or type(versions[0]) is not dict
                        or set(versions[0])!={'maximum_version'}
                        or not gate._integer(versions[0]['maximum_version'],0,gate._MAX-1)):
                    raise SourceUnavailable()
                version=versions[0]['maximum_version']+1
                if expected[1] is not None and expected[1]>=version:
                    raise SourceUnavailable()
                if not apply:
                    result=FoobarMatchPreview(proposed,version,None)
                else:
                    if original_revision == gate._MAX:
                        raise SourceUnavailable()
                    new_ref=str(uuid4())
                    mutation=_frame(live.actor.account_id,command,new_ref,version,target)
                    result=_decision(source._query(connection,_INSERT,mutation,maximum=1),command)
                    if result.decision_ref!=new_ref or result.match_version!=version:
                        raise SourceUnavailable()
                    changed=source._query(connection,_DETACH if command.action=='detach' else _BIND,
                                          mutation,maximum=1)
                    wanted=([] if expected[0] is None else
                            [{'decision_ref':expected[0],'match_version':expected[1]}]) if command.action=='detach' else [
                                {'decision_ref':new_ref,'match_version':version}]
                    if changed!=wanted:
                        raise SourceUnavailable()
                    after=_current(connection,frame)
                    if after!=((None,None) if command.action=='detach' else (new_ref,version)):
                        raise SourceUnavailable()
                    if command.action!='detach' and _target(
                            connection,live,context,command,frame,checked)!=target:
                        raise SourceStale()
                    verified=_decision(source._query(connection,_REPLAY,frame,maximum=1),command)
                    if verified!=result:
                        raise SourceUnavailable()
                    _advance_association_revision(connection,live,command,
                        expected_revision=original_revision,earlier=original_observed)
            require_account_foobar(live,checked)
            deadline.check()
            commit_attempted=apply
        deadline.check()
        return result
    except Exception as exc:
        if commit_attempted:
            raise MatchDecisionCommitUncertain() from None
        if isinstance(exc,(SourceUnavailable,SourceStale,MatchDecisionInvalid)):
            raise
        raise SourceUnavailable() from None


def preview_foobar_match_decision(database_url,context,*,command,constraints=None):
    """Return actual current expected pair; this preview is not authority."""
    return _run(database_url,context,command=command,constraints=constraints,apply=False)


def apply_foobar_match_decision(database_url,context,*,command,constraints=None):
    """Append explicit decision/binding and advance revision once, or replay history.

    Exactly the same command can be retried after a settled uncertain outcome.
    No internal retry is performed. Replay never writes a newer current binding.
    """
    return _run(database_url,context,command=command,constraints=constraints,apply=True)


_ADVANCE_ASSOCIATION_REVISION = _F + """,
sampled as materialized(select clock_timestamp() observed_at)
update integration.foobar_import_streams_v2 s
set revision=s.revision+1,updated_at=sampled.observed_at,
    clock_high_water=sampled.observed_at
from f cross join sampled
where (s.account_id,s.source_ref,s.revision)=
 ((j->>0)::bigint,(j->>1)::uuid,(j->>9)::bigint)
 and s.revision<9223372036854775807
 and s.updated_at<=s.clock_high_water
 and s.clock_high_water<=sampled.observed_at
 and sampled.observed_at>=(j->>10)::timestamptz
returning s.revision,s.updated_at,s.clock_high_water
"""


def _advance_association_revision(connection,live,command,*,expected_revision,earlier):
    """Same existing source lock/outer transaction; no receipt or business quota.

    Every new explicit history decision changes the source's association state.
    Exact historical replay and preview never call this owner. Overflow/CAS or
    clock/postimage mismatch rolls back the decision and binding together.
    """
    if not gate._integer(expected_revision,0,gate._MAX-1):
        raise SourceUnavailable()
    frame = _frame(live.actor.account_id,command,expected_revision,prepare._utc(earlier))
    rows = source._query(connection,_ADVANCE_ASSOCIATION_REVISION,frame,maximum=1)
    if (len(rows)!=1 or type(rows[0]) is not dict
            or set(rows[0])!={'revision','updated_at','clock_high_water'}):
        raise SourceUnavailable()
    row=rows[0]
    if (type(row['revision']) is not int or row['revision']!=expected_revision+1
            or not gate._time(row['updated_at']) or not gate._time(row['clock_high_water'])
            or row['updated_at']!=row['clock_high_water'] or row['updated_at']<earlier):
        raise SourceUnavailable()
