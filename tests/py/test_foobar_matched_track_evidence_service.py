"""Authored source only: actual single-worker lifecycle over controlled DB."""
from dataclasses import replace
import inspect
import pytest
from tests.py.foobar_account_history_native_testing import checked_native_driver, install, context, read_constraints
from tests.py.foobar_account_service_testing import handles,s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.test_foobar_matched_track_evidence import evidence_driver,row,reader


def begin(handle):
    return handle.begin_track_evidence(context=context(),constraints=read_constraints,
        request=reader.TrackEvidenceRequest(21,'standard',None))


def settle(handle):
    assert handle.owner.current.stage is s._Stage.DISPATCH
    handle.owner.current.stage=s._Stage.RUNNING
    s._invoke(handle.owner)
    assert not handle.owner.current.cleanup_failed
    handle.owner.current.stage=s._Stage.DELIVERY


def test_actual_worker_serializes_read_and_releases_delivery(monkeypatch):
    db=install(monkeypatch);install_catalog(monkeypatch);evidence_driver(monkeypatch,db,[row(db)])
    first,second=handles(monkeypatch,count=2);db.service_owner=first.owner
    ticket=begin(first)
    with pytest.raises(s.SourceUnavailable):begin(second)
    assert first.owner is second.owner and first.owner.thread is None and not db.calls
    settle(first);delivery=first.take_delivery(ticket)
    assert delivery.kind is s._Kind.TRACK_EVIDENCE and delivery.outcome is s._Outcome.SUCCESS
    assert delivery.receipt.items[0].count==1 and first.owner.current is None
    assert db.checkouts==db.exits==db.commits==1 and not db.physical


def test_read_uncertain_exit_never_reconciles_or_retries(monkeypatch):
    db=install(monkeypatch);install_catalog(monkeypatch);evidence_driver(monkeypatch,db,[row(db)])
    handle,=handles(monkeypatch);db.lose_ack=True
    def forbidden(*args,**kwargs):raise AssertionError('Evidence read must not reconcile or retry')
    monkeypatch.setattr(s,'_reconciled',forbidden)
    ticket=begin(handle);settle(handle);delivery=handle.take_delivery(ticket)
    assert delivery.outcome is s._Outcome.UNAVAILABLE and delivery.receipt is None
    assert db.checkouts==db.exits==1 and db.commits==0
    assert handle.owner.current is None


def test_abandon_before_dispatch_performs_no_read(monkeypatch):
    db=install(monkeypatch);handle,=handles(monkeypatch)
    ticket=begin(handle);handle.abandon(ticket)
    assert handle.owner.current is None and handle.owner.thread is None
    assert not db.calls and db.checkouts==0


def test_two_read_phase_reservations_precede_ticket(monkeypatch):
    install(monkeypatch);handle,=handles(monkeypatch);owner=handle.owner
    required=owner.limits.intake_bytes+s.prepare.MAX_PRIVATE_BYTES+s.HISTORY_SCHEMA_PHASE_BYTES+2*reader.TRACK_EVIDENCE_PHASE_BYTES
    owner.limits=replace(owner.limits,total_logical_bytes=required-1)
    with pytest.raises(s.SourceUnavailable):begin(handle)
    assert owner.current is None and owner.next_ticket==1
    owner.limits=replace(owner.limits,total_logical_bytes=required)
    ticket=begin(handle);assert owner.current.ticket is ticket
    handle.abandon(ticket)


def test_read_kind_not_in_retry_or_reconciliation_dispatch():
    assert '_Kind.TRACK_EVIDENCE' not in inspect.getsource(s._call_bounded)
