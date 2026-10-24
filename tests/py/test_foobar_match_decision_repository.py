"""Actual association repository + authority/policy; synthetic driver only."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import json
import pytest
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services.policy import ResourceScope
from tests.py.foobar_account_match_testing import (
    m, install, command, preview, apply, requested_context, BROWSE, TASTE, SOURCE, OBS, OP,
)

OP2='99999999-9999-4999-8999-999999999999'
OP3='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
OTHER_SOURCE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'


def test_offline_metadata_browse_only_association_never_requires_taste_playback_or_files(monkeypatch):
    db,catalog=install(monkeypatch)
    db.grants=(BROWSE,)
    evaluated=[]
    def constraints(ctx):
        evaluated.append(ctx.action)
        return PolicyEvaluationConstraints(client_surface_allowed=ctx.action not in (
            TASTE,'library.media.read','library.files.edit_tags'))
    live=m.require_account_foobar(requested_context(7),constraints)
    native=m.lock_foobar_matching_context(db,live,requested_context(7),7,constraints=constraints)
    for action in (TASTE,"library.media.read","library.files.edit_tags"):
        denied=replace(native,action=action,resource=ResourceScope("track","21"))
        assert not PolicyEvaluator().evaluate(denied,constraints=constraints(denied)).decision.allowed
    evaluated.clear()
    initial_revision=db.revision
    initial_clock=(db.updated_at,db.clock_high_water)
    plan=preview(constraints=constraints)
    assert db.revision==initial_revision and (db.updated_at,db.clock_high_water)==initial_clock
    assert m._ADVANCE_ASSOCIATION_REVISION not in db.calls
    assert plan.command==command() and plan.next_match_version==1 and plan.replay is None
    db.now+=timedelta(seconds=1)
    result=apply(plan.command,constraints=constraints)
    assert db.updated_at==db.clock_high_water==db.now
    assert result.match_version==1 and len(db.history)==len(db.bindings)==1
    assert db.revision==initial_revision+1
    assert db.calls.count(m._ADVANCE_ASSOCIATION_REVISION)==1
    assert BROWSE in evaluated and TASTE not in evaluated
    assert all('local_track_files' not in sql and 'watched_roots' not in sql for sql in db.calls)
    assert db.taste_row['rating'] is None and db.taste_row['love_tier']=='off'
    assert catalog.exits==2 and all(cursor.closed for cursor in catalog.cursors)


def test_preview_refreshes_pair_but_apply_never_adopts_it_implicitly(monkeypatch):
    db,_=install(monkeypatch)
    first=apply()
    proposed=command(operation_ref=OP2,action='rematch',original_track_id=22)
    plan=preview(proposed)
    assert plan.command==replace(proposed,expected_decision_ref=first.decision_ref,expected_match_version=1)
    assert plan.next_match_version==2
    before=deepcopy(db.bindings)
    with pytest.raises(m.SourceStale): apply(proposed)
    assert db.bindings==before and len(db.history)==1
    second=apply(plan.command)
    assert second.match_version==2 and db.bindings[(1,SOURCE,OBS,7)]['track_key']=='other-key'


def test_exact_old_replay_precedes_current_and_deleted_library_and_never_rewrites(monkeypatch):
    db,_=install(monkeypatch)
    original=command(); first=apply(original)
    second=apply(preview(command(operation_ref=OP2,original_track_id=22)).command)
    db.membership=False; db.targets.clear()
    before=deepcopy(db.bindings); calls=len(db.native_calls); sql=len(db.calls)
    revision_clock=(db.revision,db.updated_at,db.clock_high_water)
    assert apply(original)==first
    recovered=preview(original)
    assert recovered.replay==first and recovered.next_match_version==1
    assert db.bindings==before and before[(1,SOURCE,OBS,7)]['decision_ref']==second.decision_ref
    assert len(db.native_calls)==calls
    assert not any(q in (m._CURRENT,m._TARGET,m._INSERT,m._BIND,m._ADVANCE_ASSOCIATION_REVISION) for q in db.calls[sql:])
    assert (db.revision,db.updated_at,db.clock_high_water)==revision_clock


@pytest.mark.parametrize('changes',[
    {'original_track_id':22},{'action':'rematch'},{'library_id':8},
    {'observation_ref':OP2},{'expected_decision_ref':OP2,'expected_match_version':1},
])
def test_same_operation_changed_semantics_conflicts_before_local_authority(monkeypatch,changes):
    db,_=install(monkeypatch); apply()
    db.membership=False; before=deepcopy(db.bindings); calls=len(db.native_calls)
    with pytest.raises(m.SourceStale): apply(command(**changes))
    assert db.bindings==before and len(db.history)==1 and len(db.native_calls)==calls


def test_detach_deleted_library_account_only_and_retained_versions_after_cascade(monkeypatch):
    db,_=install(monkeypatch); first=apply()
    db.bindings.clear()  # Native FK cascade result, NOT a simulated history deletion.
    db.membership=False; calls=len(db.native_calls)
    detached=command(operation_ref=OP2,action='detach',original_track_id=None)
    plan=preview(detached)
    assert plan.command.expected_decision_ref is None and plan.command.expected_match_version is None
    assert plan.next_match_version==2
    result=apply(plan.command)
    assert result.match_version==2 and not db.bindings and len(db.history)==2
    assert len(db.native_calls)==calls and db.outer_scopes[-2:]==[None,None]
    assert apply(detached)==result and len(db.native_calls)==calls
    db.membership=True
    rebound=apply(preview(command(operation_ref=OP3)).command)
    assert rebound.match_version==3 and first.decision_ref!=rebound.decision_ref


def test_detach_existing_binding_requires_exact_pair_but_no_library_io(monkeypatch):
    db,_=install(monkeypatch); first=apply(); db.membership=False
    calls=len(db.native_calls)
    cmd=command(operation_ref=OP2,action='detach',original_track_id=None,
        expected_decision_ref=first.decision_ref,expected_match_version=1)
    assert apply(cmd).match_version==2 and not db.bindings
    assert len(db.native_calls)==calls


@pytest.mark.parametrize('mode',['account','source','observation'])
def test_account_source_subject_isolation_no_foreign_replay_or_native_lookup(monkeypatch,mode):
    db,_=install(monkeypatch); apply(); before=deepcopy(db.history)
    ctx=requested_context(7); cmd=command()
    if mode=='account':
        ctx=replace(ctx,actor=replace(ctx.actor,account_id=2),target_account_id=2)
        db.scopes.add((2,SOURCE))
    elif mode=='source':
        cmd=replace(cmd,source_ref=OTHER_SOURCE); db.scopes.add((1,OTHER_SOURCE))
    else:
        cmd=replace(cmd,operation_ref=OP2,observation_ref=OP3)
    calls=len(db.native_calls)
    with pytest.raises(m.SourceStale): apply(cmd,context=ctx)
    assert db.history==before and len(db.native_calls)==calls


@pytest.mark.parametrize('mode',['revoked','hidden'])
def test_current_read_authority_denial_rolls_back_without_history(monkeypatch,mode):
    db,_=install(monkeypatch)
    constraints=None
    if mode=='revoked': db.membership=False
    else:
        constraints=lambda ctx: PolicyEvaluationConstraints(
            client_surface_allowed=not (ctx.action==BROWSE and ctx.resource is not None and ctx.resource.resource_kind=='track'))
    with pytest.raises((m.SourceStale,m.SourceUnavailable)):
        apply(constraints=constraints)
    assert not db.history and not db.bindings and m._TARGET not in db.native_calls


def test_uncertain_outer_commit_is_recovered_by_original_operation_without_library(monkeypatch):
    db,_=install(monkeypatch); db.lose_ack=True
    original_revision=db.revision
    with pytest.raises(m.MatchDecisionCommitUncertain): apply()
    assert len(db.history)==len(db.bindings)==1
    assert db.revision==original_revision+1
    db.membership=False; calls=len(db.native_calls)
    result=apply()
    assert result.decision_ref==db.history[(1,SOURCE,OP)]['decision_ref']
    assert len(db.history)==1 and len(db.native_calls)==calls
    assert db.revision==original_revision+1
    assert db.calls.count(m._ADVANCE_ASSOCIATION_REVISION)==1


@pytest.mark.parametrize('sql,rows',[
    (m._TARGET,[dict(track_id=21,library_id=7,key_bytes=4097,track_key='x'*4097)]),
    (m._TARGET,[dict(track_id=21,library_id=8,key_bytes=1,track_key='x')]),
    (m._TARGET,[dict(track_id=21,library_id=7,key_bytes=1,track_key='é')]),
    (m._TARGET,[{},{}]), (m._MAXIMUM,[{'maximum_version':True}]),
    (m._MAXIMUM,[{'maximum_version':m.gate._MAX}]), (m._CURRENT,[{},{}]),
    (m._REPLAY,[{},{}]),
])
def test_bounded_query_results_fail_closed_without_mutation(monkeypatch,sql,rows):
    db,_=install(monkeypatch); db.overrides[sql]=rows
    with pytest.raises(m.SourceUnavailable): apply()
    assert not db.history and not db.bindings and all(cursor.closed for cursor in db.cursors)


def test_mutation_failure_rolls_back_and_schema_failure_never_enters_transaction(monkeypatch):
    db,catalog=install(monkeypatch); db.fail_sql=m._BIND
    with pytest.raises(m.SourceUnavailable): apply()
    assert not db.history and not db.bindings
    db.fail_sql=None; db.calls.clear(); db.outer_scopes.clear(); catalog.rows=[{'structural_ready':False}]
    with pytest.raises(m.SourceUnavailable): apply()
    assert not db.calls and not db.outer_scopes


def test_permission_revoked_after_preview_and_target_disappeared_are_rechecked(monkeypatch):
    db,_=install(monkeypatch); plan=preview()
    db.grants=()
    with pytest.raises(m.SourceStale): apply(plan.command)
    assert not db.history and not db.bindings
    db.grants=(BROWSE,); db.targets.clear()
    with pytest.raises(m.SourceStale): apply(plan.command)
    assert not db.history and not db.bindings


def test_same_target_new_explicit_operation_appends_history(monkeypatch):
    db,_=install(monkeypatch); first=apply()
    second=apply(preview(command(operation_ref=OP2)).command)
    assert second.match_version==2 and second.original_track_id==first.original_track_id
    assert second.decision_ref!=first.decision_ref and len(db.history)==2
    assert db.revision==2 and db.calls.count(m._ADVANCE_ASSOCIATION_REVISION)==2


def test_target_key_changed_at_postwrite_revalidation_rolls_back(monkeypatch):
    db,_=install(monkeypatch); dispatch=db.dispatch
    def changed(sql,params):
        rows=dispatch(sql,params)
        if sql==m._BIND:
            db.targets[(7,21)]='changed-key'
        return rows
    monkeypatch.setattr(db,'dispatch',changed)
    with pytest.raises(m.SourceStale): apply()
    assert not db.history and not db.bindings


@pytest.mark.parametrize('failure',['cas','updated_after_water','water_after_sample','sample_before_lock','bad_postimage'])
def test_association_revision_failure_rolls_back_history_binding_and_clock(monkeypatch,failure):
    db,_=install(monkeypatch)
    before=deepcopy((db.history,db.bindings,db.revision,db.updated_at,db.clock_high_water))
    dispatch=db.dispatch
    def fail_at_revision(sql,params):
        if sql!=m._ADVANCE_ASSOCIATION_REVISION:
            return dispatch(sql,params)
        assert db.history and db.bindings  # reached after genuine decision writes
        if failure=='cas': db.revision+=1
        elif failure=='updated_after_water': db.updated_at+=timedelta(seconds=1)
        elif failure=='water_after_sample': db.clock_high_water+=timedelta(seconds=1)
        elif failure=='sample_before_lock':
            frame=json.loads(params[0])
            frame[10]=(db.now+timedelta(seconds=1)).isoformat()
            params=(json.dumps(frame).encode(),)
        result=dispatch(sql,params)
        if failure=='bad_postimage':
            assert db.revision==before[2]+1
            result[0]['revision']+=1
        else:
            assert result==[]
        return result
    monkeypatch.setattr(db,'dispatch',fail_at_revision)
    with pytest.raises(m.SourceUnavailable): apply()
    assert (db.history,db.bindings,db.revision,db.updated_at,db.clock_high_water)==before
    assert db.commits==0 and all(cursor.closed for cursor in db.cursors)


@pytest.mark.parametrize('change',['account','source','cas','overflow','updated_after_water','water_after_sample','earlier'])
def test_revision_driver_predicates_reject_without_changing_stored_state(monkeypatch,change):
    db,_=install(monkeypatch)
    frame=json.loads(m._frame(1,command(),db.revision,db.now.isoformat()))
    if change=='account': frame[0]=2
    elif change=='source': frame[1]=OTHER_SOURCE
    elif change=='cas': frame[9]+=1
    elif change=='overflow': db.revision=frame[9]=9223372036854775807
    elif change=='updated_after_water': db.updated_at+=timedelta(seconds=1)
    elif change=='water_after_sample': db.clock_high_water+=timedelta(seconds=1)
    else: frame[10]=(db.now+timedelta(seconds=1)).isoformat()
    before=(db.revision,db.updated_at,db.clock_high_water)
    assert db.dispatch(m._ADVANCE_ASSOCIATION_REVISION,(json.dumps(frame).encode(),))==[]
    assert (db.revision,db.updated_at,db.clock_high_water)==before
    assert not db.history and not db.bindings
