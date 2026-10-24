"""Actual v3 Prepare/Apply/source/association/native/finalizer callers, unexecuted."""
from copy import deepcopy
from dataclasses import replace
import json
from uuid import uuid4
import pytest
from tests.py.foobar_account_associations_v3_testing import (
    install,prepare,apply,prepared,history,p,a,f,associations,readiness,
    PAYLOAD,CAPACITY,SOURCE,GEN,requested_context,
)
from tests.py.test_foobar_account_matching_chain import install_status_boundary


def seed_source(db):
    cmd,receipt=prepare(db,library=None)
    apply(db,cmd,receipt)
    assert not db.history and len(db.source_rows)==1
    return next(iter(db.source_rows))


def test_never_decided_initial_import_composes_source_association_taste_and_finalizer(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db)
    original=prepared(db); seal=original[4][0]
    assert len(original)==5 and seal[8:] == ['never_decided',21]
    assert receipt.association_review==((1,original[2][0][2],'never_decided',True),)
    apply_cmd,result=apply(db,cmd,receipt)
    terminal=json.loads(result.terminal_bytes)
    assert terminal[0]=='foobar_acct_v4' and len(terminal)==24
    assert terminal[11:13]==[0,1] and terminal[22]==1
    assert db.revision==1 and len(db.history)==len(db.bindings)==len(db.source_rows)==1
    assert db.tastes[21]['rating']==4 and db.tastes[21]['love_tier']=='loved'
    assert db.calls.index(p.source._insert_revisions_sql())<db.calls.index(associations._WRITE)<db.calls.index(f._COMMIT_SQL)
    assert db.calls.count(associations._WRITE)==1


def test_saved_binding_overrides_path_and_same_target_reimport_never_appends(monkeypatch):
    db=install(monkeypatch); ref=seed_source(db)
    saved=history(db,ref,track=22)
    cmd,receipt=prepare(db); original=prepared(db)
    assert original[4][0][8:] == ['saved',22]
    apply(db,cmd,receipt)
    assert db.tastes[22]['rating']==4 and db.tastes[21]['rating'] is None
    assert db.bindings[(7,ref)]['decision']==saved['decision'] and len(db.history[(7,ref)])==1
    cmd,receipt=prepare(db); _,result=apply(db,cmd,receipt)
    assert json.loads(result.terminal_bytes)[22]==0
    assert len(db.history[(7,ref)])==1 and associations._WRITE not in db.association_calls


@pytest.mark.parametrize('resolution,action',[('explicit_detach','detach'),('availability_lost','match')])
def test_history_without_binding_blocks_path_guess_and_never_recreates(monkeypatch,resolution,action):
    db=install(monkeypatch); ref=seed_source(db)
    history(db,ref,track=21,action=action,version=17,binding=False)
    before=deepcopy(db.tastes)
    cmd,receipt=prepare(db); original=prepared(db)
    assert original[4][0][8:]==[resolution,None] and original[3]==[]
    _,result=apply(db,cmd,receipt)
    assert json.loads(result.terminal_bytes)[22]==0
    assert not db.bindings and len(db.history[(7,ref)])==1 and db.tastes==before
    assert associations._WRITE not in db.association_calls


def test_association_only_commit_increments_revision_without_source_or_taste_write(monkeypatch):
    db=install(monkeypatch); ref=seed_source(db)
    # Real manual protections stop native rating/love writes; source is unchanged.
    db.tastes[21].update(rating=5,love_tier='off',rating_protected=True,favorite_protected=True,preference_id=51)
    before_source=deepcopy(db.source_rows); before_taste=deepcopy(db.tastes); revision=db.revision
    cmd,receipt=prepare(db); start=len(db.calls)
    _,result=apply(db,cmd,receipt); terminal=json.loads(result.terminal_bytes)
    assert terminal[11:13]==[revision,revision+1]
    assert terminal[16:23]==[1,0,0,0,0,0,1]
    assert db.source_rows==before_source and db.tastes==before_taste and len(db.history[(7,ref)])==1
    assert p.taste._foobar_taste_write_sql() not in db.calls[start:]


@pytest.mark.parametrize('change',['new_binding','history_head','lost_binding'])
def test_prepared_association_seals_stale_before_any_source_native_or_finalizer_write(monkeypatch,change):
    db=install(monkeypatch); ref=seed_source(db)
    if change!='new_binding': history(db,ref,track=21)
    cmd,receipt=prepare(db)
    if change=='lost_binding': db.bindings.pop((7,ref))
    else: history(db,ref,track=22,version=2 if change=='history_head' else 1)
    before=deepcopy((db.source_rows,db.tastes,db.history,db.bindings,db.revision)); start=len(db.calls)
    with pytest.raises(p.SourceStale): apply(db,cmd,receipt)
    assert (db.source_rows,db.tastes,db.history,db.bindings,db.revision)==before
    assert not any(q in (associations._WRITE,p.source._insert_revisions_sql(),
        p.taste._foobar_taste_write_sql(),f._COMMIT_SQL) for q in db.calls[start:])


def test_no_library_calls_no_association_catalog_or_native_owner(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db,library=None)
    assert prepared(db)[4][0][8:]==['no_library',None]
    _,result=apply(db,cmd,receipt)
    assert not db.association_calls and not db.native_calls and readiness._SCHEMA_SQL not in db.calls
    assert json.loads(result.terminal_bytes)[22]==0 and not db.history


def test_real_ready_status_recovers_same_command_and_review_without_local_io(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db)
    status=install_status_boundary(monkeypatch,db)
    before=(len(db.native_calls),len(db.association_calls),db.calls.count(readiness._SCHEMA_SQL))
    result=status.read_foobar_import_status('synthetic:no-network',requested_context(None),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert result.original_prepare_command==cmd and result.association_review==receipt.association_review
    assert before==(len(db.native_calls),len(db.association_calls),db.calls.count(readiness._SCHEMA_SQL))


def test_deleted_library_committed_replay_and_status_ignore_associations_and_catalog(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db); apply_cmd,result=apply(db,cmd,receipt)
    db.membership=False; db.files.clear(); db.bindings.clear()
    before=(len(db.native_calls),len(db.association_calls),db.calls.count(readiness._SCHEMA_SQL))
    again=a.apply_foobar_import('synthetic:no-network',requested_context(None),
        command=apply_cmd,intake_capacity=CAPACITY)
    status=install_status_boundary(monkeypatch,db)
    recovered=status.read_foobar_import_status('synthetic:no-network',requested_context(None),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert again==result and recovered.state=='committed' and recovered.association_review is None
    assert recovered.original_prepare_command is None
    assert before==(len(db.native_calls),len(db.association_calls),db.calls.count(readiness._SCHEMA_SQL))


def test_external_duplicate_projection_suppresses_auto_and_taste_but_retains_source(monkeypatch):
    db=install(monkeypatch); db.external_conflicts={21}
    cmd,receipt=prepare(db)
    assert prepared(db)[4][0][8:]==['never_decided',None]
    _,result=apply(db,cmd,receipt)
    assert len(db.source_rows)==1 and not db.history and not db.bindings
    assert json.loads(result.terminal_bytes)[22]==0 and db.tastes[21]['rating'] is None


def test_within_upload_duplicate_path_uses_occurrence_identity_and_suppresses_both(monkeypatch):
    db=install(monkeypatch)
    payload=PAYLOAD+PAYLOAD.split(b'\n',1)[1]
    cmd,receipt=prepare(db,payload=payload); original=prepared(db)
    assert len(original[2])==2 and all(s[9] is None for s in original[4])
    assert original[2][0][1]!=original[2][1][1]
    _,result=apply(db,cmd,receipt)
    assert len(db.source_rows)==2 and all(r[1]=='occurrence' for r in db.source_rows.values())
    assert not db.history and all(t['rating'] is None for t in db.tastes.values())
    assert json.loads(result.terminal_bytes)[22]==0


def test_same_source_identity_independent_of_library_and_local_conflict(monkeypatch):
    identities=[]
    for library,conflict in ((None,False),(7,False),(8,False),(7,True)):
        db=install(monkeypatch,library=library or 7)
        if conflict: db.external_conflicts={21}
        cmd,receipt=prepare(db,library=library)
        identities.append(prepared(db)[2][0][1])
    assert len(set(identities))==1


def test_saved_but_unprojected_candidate_reserves_target_against_other_upload_row(monkeypatch):
    db=install(monkeypatch)
    payload=PAYLOAD.split(b'\n',1)[0]+b'\n'+PAYLOAD.split(b'\n',1)[1].replace(
        b'/synthetic.flac',b'/other.flac')+PAYLOAD.split(b'\n',1)[1]
    cmd,receipt=prepare(db,library=None,payload=payload); apply(db,cmd,receipt)
    ref=next(ref for ref,row in db.source_rows.items() if b'/other.flac' in bytes.fromhex(row[2]))
    saved=history(db,ref,track=21)
    cmd,receipt=prepare(db,payload=payload); original=prepared(db)
    assert original[4][0][8:]==['saved',None]
    assert original[4][1][8:]==['never_decided',None]
    _,result=apply(db,cmd,receipt)
    assert db.bindings[(7,ref)]['decision']==saved['decision'] and len(db.bindings)==1
    assert db.tastes[21]['rating'] is None and json.loads(result.terminal_bytes)[22]==0
    # Also exercise the independent actual owner against a forged planned target.
    # Valid row framing alone must not bypass a saved reservation with plannedNone.
    frozen=p.envelope._freeze(original)
    forged=(frozen[4][0],frozen[4][1][:9]+(21,))
    with pytest.raises(p.SourceStale):
        associations.check_foobar_association_seals_on_connection(db,requested_context(7),
            source_ref=SOURCE,matching_library_id=7,rows=frozen[2],seals=forged)


def test_per_library_associations_are_distinct_while_source_identity_is_retained(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db); apply(db,cmd,receipt)
    source=deepcopy(db.source_rows); ref=next(iter(source)); first=db.bindings[(7,ref)]['decision']
    db.library=8
    db.files={31:'/synthetic.flac',32:'/other.flac'}
    db.tastes={track:dict(db.taste_row,track_id=track) for track in db.files}
    cmd,receipt=prepare(db,library=8); apply(db,cmd,receipt)
    assert db.source_rows==source and set(db.bindings)=={(7,ref),(8,ref)}
    assert db.bindings[(7,ref)]['decision']==first and db.bindings[(8,ref)]['track']==31


def test_association_write_failure_rolls_back_source_taste_receipt_and_revision(monkeypatch):
    db=install(monkeypatch); cmd,receipt=prepare(db); db.fail_sql=associations._WRITE
    before=deepcopy((db.source_rows,db.tastes,db.history,db.bindings,db.revision,db.receipt))
    with pytest.raises(p.SourceUnavailable): apply(db,cmd,receipt)
    assert (db.source_rows,db.tastes,db.history,db.bindings,db.revision,db.receipt)==before
    assert f._COMMIT_SQL not in db.calls


def test_actual_ready_prepare_replay_uses_shared_saved_binding_resolver(monkeypatch):
    db=install(monkeypatch); ref=seed_source(db); history(db,ref,track=22)
    cmd,receipt=prepare(db)
    again=p.prepare_foobar_import('synthetic:no-network',requested_context(7),
        command=cmd,payload=PAYLOAD,intake_capacity=CAPACITY)
    assert again==receipt and again.association_review==((1,ref,'saved',True),)
    assert db.calls.count(p._INSERT_READY_SQL)==2  # source-only seed + this READY
    assert associations._WRITE not in db.association_calls
