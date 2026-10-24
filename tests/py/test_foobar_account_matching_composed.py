"""AUTHORED, NOT EXECUTED. Genuine composed owners; SQL results are synthetic.

Requires the frozen matching source and matching test packets in one isolated
future authorized source tree. Does not prove native locks or DB durability.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import json

import pytest

from tests.py.foobar_account_matching_composed_boundary import (
    p,a,f,authority,scalars,bridge,context,command,SOURCE,GEN,KEY,APPLY_KEY,
    PAYLOAD,CAPACITY,BROWSE,TASTE,install,preview_command,prepare,apply,
    apply_command,requested_context,
)
from tests.py.test_foobar_account_matching_chain import install_status_boundary
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.foobar_import_policy import evaluate_foobar_track_policy


@pytest.mark.parametrize('rating,love,protected,counts',[
    (None,'off',False,(0,0,0,1,1,1)),
    (2,'loved',True,(0,1,0,0,0,0)),
    (None,'off',True,(0,1,0,0,0,0)),  # Explicit manual clear is protected too.
    (5,'obsessed',True,(0,1,0,0,0,0)),
])
def test_actual_optional_prepare_inventory_apply_taste_finalizer(monkeypatch,rating,love,protected,counts):
    db=install(monkeypatch,rating=rating,love=love,protected=protected)
    before=deepcopy(db.taste_row)
    cmd,receipt=prepare(db)
    original=p.envelope._freeze(json.loads(db.receipt['prepared']))
    assert original[1][1]==7 and len(original[3])==1
    assert original[3][0][11:]==(True,True)
    assert original[2][0][9:]==(0,4,True)
    result=apply(db,apply_command(receipt,7))
    record=tuple(json.loads(result.terminal_bytes))
    assert record[16:22]==counts
    assert record[22]==1 and len(db.history)==len(db.bindings)==1
    assert db.revision==1 and db.receipt['state']=='committed'
    if protected:
        assert db.taste_row==before
        assert p.taste._foobar_taste_write_sql() not in db.calls
    else:
        row=db.taste_row
        assert (row['rating'],row['love_tier'])==(4,'loved')
        assert row['rating_observation_ref']==row['favorite_observation_ref']==db.source_row[0]
        assert row['rating_source_revision']==row['favorite_source_revision']==1
        assert db.calls.count(p.taste._foobar_taste_write_sql())==1
    # These genuine owners actually traversed the fixture, not success stubs.
    for sql in (scalars._foobar_inventory_scalar_sql(),bridge._path_projection_sql(),
                p.taste._foobar_taste_read_sql(),p.source._insert_revisions_sql(),f._COMMIT_SQL):
        assert sql in db.calls
    source_write=db.calls.index(p.source._insert_revisions_sql())
    terminal_write=db.calls.index(f._COMMIT_SQL)
    assert source_write<terminal_write
    if not protected:
        assert source_write<db.calls.index(p.taste._foobar_taste_write_sql())<terminal_write
    assert all(cursor.closed for cursor in db.cursors)


def deny_action(action):
    # Genuine narrowing constraint only. Durable grants and aliases still run
    # through the actual evaluator before this constraint can deny the action.
    return lambda target: PolicyEvaluationConstraints(
        client_surface_allowed=target.action != action)


@pytest.mark.parametrize('revoked',[BROWSE,TASTE])
def test_permission_revoked_after_real_preview_blocks_prepare(monkeypatch,revoked):
    db=install(monkeypatch)
    cmd=preview_command(db)
    constraints=deny_action(revoked)
    with pytest.raises(p.SourceUnavailable):
        prepare(db,cmd,constraints=constraints)
    assert db.receipt is None and db.source_row is None and db.keys=={}
    assert p.taste._foobar_taste_write_sql() not in db.calls


@pytest.mark.parametrize('revoked',[BROWSE,TASTE])
def test_permission_revoked_after_ready_blocks_actual_apply_without_business_writes(monkeypatch,revoked):
    db=install(monkeypatch)
    cmd,receipt=prepare(db)
    constraints=deny_action(revoked)
    before=deepcopy(db.taste_row)
    with pytest.raises(p.SourceUnavailable):
        apply(db,apply_command(receipt,7),constraints=constraints)
    assert db.receipt['state']=='ready' and db.source_row is None and db.revision==0
    assert db.taste_row==before and APPLY_KEY not in db.keys
    assert p.source._insert_revisions_sql() not in db.calls


def test_actual_optional_key_changed_library_conflict_before_native_lookup(monkeypatch):
    db=install(monkeypatch)
    cmd,receipt=prepare(db)
    native_count=len(db.native_calls)
    with pytest.raises(p.SourceStale):
        p.prepare_foobar_import('synthetic:no-network',requested_context(8),
            command=replace(cmd,matching_library_id=8),payload=PAYLOAD,intake_capacity=CAPACITY)
    with pytest.raises(p.SourceStale):
        apply(db,apply_command(receipt,8),requested_context(8))
    assert len(db.native_calls)==native_count
    assert db.source_row is None and len(db.keys)==1


def test_deleted_library_replays_real_optional_commit_and_status(monkeypatch):
    db=install(monkeypatch)
    cmd,receipt=prepare(db)
    retry=apply_command(receipt,7)
    db.lose_ack=True
    with pytest.raises(a.FoobarApplyCommitUncertain):
        apply(db,retry)
    assert db.receipt['state']=='committed'
    original_terminal=db.receipt['terminal']
    original_taste=deepcopy(db.taste_row)
    db.membership=False
    db.grants=()
    native_count=len(db.native_calls)
    # No ambient library after deletion, but the original command survives.
    assert apply(db,retry,context()).terminal_bytes==original_terminal
    assert p.prepare_foobar_import('synthetic:no-network',context(),command=cmd,
        payload=PAYLOAD,intake_capacity=CAPACITY).terminal_bytes==original_terminal
    status=install_status_boundary(monkeypatch,db)
    result=status.read_foobar_import_status('synthetic:no-network',context(),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert result.state=='committed' and result.terminal_bytes==original_terminal
    assert result.original_prepare_command is None  # Never infer a deleted scope.
    assert result.prepare_key==KEY and result.apply_key==APPLY_KEY
    assert len(db.native_calls)==native_count and db.taste_row==original_taste
    assert db.calls.count(p.source._insert_revisions_sql())==1
    assert db.calls.count(p.taste._foobar_taste_write_sql())==1
    assert db.calls.count(f._COMMIT_SQL)==1


def test_actual_no_library_path_never_consults_native_state_even_with_ambient_selection(monkeypatch):
    db=install(monkeypatch)
    db.membership=False
    before=deepcopy(db.taste_row)
    receipt=p.prepare_foobar_import('synthetic:no-network',requested_context(7),
        command=command(),payload=PAYLOAD,intake_capacity=CAPACITY)
    result=apply(db,apply_command(receipt,None),requested_context(7))
    assert tuple(json.loads(result.terminal_bytes))[16:22]==(0,1,0,0,0,0)
    assert tuple(json.loads(result.terminal_bytes))[22]==0
    assert db.association_calls==[] and db.history=={} and db.bindings=={}
    assert db.native_calls==[] and db.taste_row==before


def test_real_prepare_source_identity_equal_across_a_b_none_and_native_conflict(monkeypatch):
    identities=[]
    evidence=[]
    for library,selection in ((7,'ok'),(8,'ok'),(7,'conflict'),(None,'ok')):
        db=install(monkeypatch,library=library or 7,selection=selection)
        if library is None:
            receipt=p.prepare_foobar_import('synthetic:no-network',context(),command=command(),
                payload=PAYLOAD,intake_capacity=CAPACITY)
        else:
            unused,receipt=prepare(db)
        original=p.envelope._freeze(json.loads(db.receipt['prepared']))
        identities.append(original[2][0][1])
        evidence.append(original[2][0][6:9])
        if selection=='conflict' or library is None:
            assert original[2][0][9:]==(None,None,False)
    assert len(set(identities))==1
    assert all(value==evidence[0] for value in evidence)
    # This matrix has a unique upload path. Duplicate/blank-path occurrence
    # identities intentionally retain upload+ordinal ambiguity (frozen suite).


@pytest.mark.parametrize('error',[PrivateLibraryAuthorityError,p.taste.FoobarTasteStale])
def test_actual_apply_normalizes_native_stale_errors_without_prepare_alias(monkeypatch,error):
    db=install(monkeypatch)
    unused,receipt=prepare(db)

    @contextmanager
    def rejected_transaction(*args,**kwargs):
        raise error('synthetic native boundary stale')
        yield  # Keep an actual context manager, not a protocol result stub.

    monkeypatch.setattr(p,'current_foobar_import_transaction',rejected_transaction)
    # The direct imported exception owner must work even if Prepare never
    # exports an alias. The old prepare.PrivateLibraryAuthorityError handler
    # raised AttributeError here while trying to normalize either error class.
    monkeypatch.delattr(p,'PrivateLibraryAuthorityError',raising=False)
    with pytest.raises(p.SourceStale) as failure:
        apply(db,apply_command(receipt,7))
    assert failure.value.status_code==409
    assert not isinstance(failure.value,a.FoobarApplyCommitUncertain)
    assert db.receipt['state']=='ready' and db.source_row is None


def test_direct_taste_grant_removal_preserves_real_browse_alias(monkeypatch):
    db=install(monkeypatch)
    cmd=preview_command(db)
    db.grants=(BROWSE,)
    ctx=requested_context(7)
    live=authority.lock_foobar_matching_context(db,authority.require_account_foobar(ctx),ctx,7)
    policy=evaluate_foobar_track_policy(live,track_id=21)
    assert policy.browse_allowed and policy.taste_allowed
    denied=evaluate_foobar_track_policy(live,track_id=21,constraints=deny_action(TASTE))
    assert denied.browse_allowed and not denied.taste_allowed
    # Removing only the redundant direct grant after preview does not change
    # inventory policy outcomes. The actual Prepare must remain possible.
    unused,receipt=prepare(db,cmd)
    assert receipt.receipt_ref==db.receipt['receipt_ref']
    result=apply(db,apply_command(receipt,7))
    assert tuple(json.loads(result.terminal_bytes))[16:22]==(0,0,0,1,1,1)
    assert (db.taste_row['rating'],db.taste_row['love_tier'])==(4,'loved')
    assert db.calls.count(p.taste._foobar_taste_write_sql())==1


def test_redundant_grant_removal_after_ready_stales_authority_not_taste_policy(monkeypatch):
    db=install(monkeypatch)
    unused,receipt=prepare(db)
    db.grants=(BROWSE,)
    ctx=requested_context(7)
    live=authority.lock_foobar_matching_context(db,authority.require_account_foobar(ctx),ctx,7)
    assert evaluate_foobar_track_policy(live,track_id=21).taste_allowed
    with pytest.raises(p.SourceStale):
        apply(db,apply_command(receipt,7))
    assert db.receipt['state']=='ready' and db.source_row is None
    assert APPLY_KEY not in db.keys


def test_genuine_optional_ready_status_recovers_exact_command_without_native_io(monkeypatch):
    db=install(monkeypatch)
    cmd,receipt=prepare(db)
    status=install_status_boundary(monkeypatch,db)
    native_count=len(db.native_calls)
    result=status.read_foobar_import_status('synthetic:no-network',context(),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert result.state=='ready'
    assert result.original_prepare_command==cmd
    assert result.original_prepare_command.matching_library_id==7
    assert result.prepare_key==cmd.request_key and result.apply_key is None
    assert result.terminal_bytes is None
    assert len(db.native_calls)==native_count
    assert len(db.keys)==1 and db.source_row is None
