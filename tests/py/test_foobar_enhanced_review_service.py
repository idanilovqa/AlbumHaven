"""Authored-only genuine service/owner dispatch over controlled DB/read boundary."""
from contextlib import contextmanager
from pathlib import Path
import pytest
from tests.py.foobar_enhanced_review_testing import *
from tests.py.foobar_account_service_testing import handles,s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

BODY=b'SQLite format 3\0'+b'x'*84

def admitted(monkeypatch):
    db=install(monkeypatch); install_catalog(monkeypatch)
    handle,=handles(monkeypatch); db.service_owner=handle.owner
    ticket=handle.begin_enhanced_review(context=context(),constraints=PolicyEvaluationConstraints(),
        command=command(),length=len(BODY))
    return db,handle,ticket

def settle(handle):
    op=handle.owner.current
    assert op.stage is s._Stage.DISPATCH
    op.stage=s._Stage.RUNNING
    s._invoke(handle.owner)
    if op.cleanup_failed: handle.owner.state=s._State.FAULTED
    else: op.stage=s._Stage.DELIVERY
    return op

def test_actual_worker_stages_closes_reviews_and_cleans_before_delivery(monkeypatch):
    db,handle,ticket=admitted(monkeypatch)
    seen=[]
    @contextmanager
    def reader_boundary(path,*,cancelled):
        assert path.read_bytes()==BODY
        seen.append(path)
        def generate():
            yield record()
            return reader.StoreReadSummary('foobar_enhanced_sqlite_snapshot_v1','complete',None,1,0,24,0)
        iterator=generate()
        try: yield iterator
        finally: iterator.close()
    monkeypatch.setattr(owner,'open_enhanced_sqlite_snapshot',reader_boundary)
    assert handle.offer_enhanced_upload(ticket,BODY)
    handle.finish_enhanced_upload(ticket)
    op=settle(handle); result=handle.take_delivery(ticket)
    assert result.outcome is s._Outcome.SUCCESS and result.receipt.local_entries==1
    assert seen and not seen[0].exists()
    assert op.intake is op.indexed_upload is op.enhanced_channel is None
    assert op.context is op.constraints is None and handle.owner.current is None
    assert handle.owner.thread is None and db.checkouts==db.exits==3
    assert not db.driver_errors

def test_abandon_before_dispatch_closes_channel_without_staging(monkeypatch):
    db,handle,ticket=admitted(monkeypatch); channel=handle.owner.current.enhanced_channel
    handle.abandon(ticket)
    assert handle.owner.current is None and db.checkouts==0
    with pytest.raises(s.enhanced_upload.EnhancedUploadRejected): channel.offer(BODY)

def test_running_cancel_preserves_slot_until_real_invocation_settles(monkeypatch):
    db,handle,ticket=admitted(monkeypatch); op=handle.owner.current
    op.stage=s._Stage.RUNNING; handle.abandon(ticket)
    assert handle.owner.current is op and op.abandoned and op.job_cancel.is_set()
    with pytest.raises(owner.SourceUnavailable):
        handle.begin_enhanced_review(context=context(),constraints=PolicyEvaluationConstraints(),
            command=command(),length=len(BODY))
    s._invoke(handle.owner)
    assert op.delivery.outcome is s._Outcome.UNAVAILABLE and op.enhanced_channel is None

def test_storage_failure_through_actual_attempt_faults_owner_no_retry(monkeypatch):
    db,handle,ticket=admitted(monkeypatch); stream(monkeypatch,[record()]); calls=[]
    @contextmanager
    def broken(channel):
        calls.append(channel)
        raise s.enhanced_upload.EnhancedUploadStorageFailed()
        yield
    monkeypatch.setattr(s.enhanced_upload,'staged_enhanced_upload',broken)
    op=settle(handle)
    assert op.cleanup_failed and handle.owner.state is s._State.FAULTED and len(calls)==1
    assert op.delivery.outcome is s._Outcome.UNAVAILABLE and op.enhanced_channel is None
    with pytest.raises(owner.SourceUnavailable): handle.take_delivery(ticket)
    assert handle.owner.thread is None

def test_cleanup_error_after_success_does_not_publish_success(monkeypatch):
    db,handle,ticket=admitted(monkeypatch); stream(monkeypatch,[record()])
    @contextmanager
    def broken_cleanup(channel):
        yield s.enhanced_upload.EnhancedUploadArtifact(Path('/synthetic/owned.sqlite'),SHA,100)
        raise s.enhanced_upload.EnhancedUploadStorageFailed()
    monkeypatch.setattr(s.enhanced_upload,'staged_enhanced_upload',broken_cleanup)
    op=settle(handle)
    assert op.cleanup_failed and op.delivery.receipt is None
    assert op.delivery.outcome is s._Outcome.UNAVAILABLE

def test_phase_reservation_failure_precedes_ticket_and_file(monkeypatch):
    db,handle,ticket=admitted(monkeypatch); handle.abandon(ticket)
    from dataclasses import replace
    handle.owner.limits=replace(handle.owner.limits,total_logical_bytes=1)
    with pytest.raises(owner.SourceUnavailable):
        handle.begin_enhanced_review(context=context(),constraints=PolicyEvaluationConstraints(),
            command=command(),length=len(BODY))
    assert handle.owner.current is None and db.checkouts==0
