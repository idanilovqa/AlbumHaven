"""AUTHORED ONLY. One real service operation, deterministic scheduler boundary."""
from dataclasses import replace
import inspect
import pytest
from tests.py.foobar_account_history_native_testing import checked_native_driver
from tests.py.foobar_account_history_native_testing import install, context, request, read_constraints, native
from tests.py.foobar_account_service_testing import handles, s, CONFIG
from tests.py.foobar_account_service_readiness_testing import install_catalog


def begin(handle, *, play=False):
    return handle.begin_history_native(context=context(), constraints=read_constraints,
        request=request(), play=play)


def settle(handle):
    owner = handle.owner
    assert owner.current.stage is s._Stage.DISPATCH
    owner.current.stage = s._Stage.RUNNING
    s._invoke(owner)
    assert not owner.current.cleanup_failed
    owner.current.stage = s._Stage.DELIVERY


@pytest.mark.parametrize('play', [False, True])
def test_real_service_dispatch_keeps_owner_slot_and_no_lock_across_native_io(monkeypatch, play):
    db = install(monkeypatch); catalog = install_catalog(monkeypatch)
    first, second = handles(monkeypatch, count=2)
    db.service_owner = first.owner
    old_review = object(); first.owner.last_review = old_review
    ticket = begin(first, play=play)
    assert first.owner is second.owner and first.owner.current.ticket is ticket
    with pytest.raises(s.SourceUnavailable): begin(second, play=play)
    assert first.owner.thread is None and not db.calls
    settle(first)
    assert first.owner.last_review is old_review
    delivery = first.take_delivery(ticket)
    assert delivery.outcome is s._Outcome.SUCCESS
    assert delivery.kind is (s._Kind.HISTORY_PLAY if play else s._Kind.HISTORY_ELIGIBILITY)
    assert (type(delivery.receipt) is native.FoobarHistoryPrivatePlayTarget) if play else (
        type(delivery.receipt) is tuple and delivery.receipt[0].can_attempt_play)
    assert first.owner.current is None and first.owner.thread is None
    assert db.checkouts == db.exits == db.commits == 1 and catalog.exits == 3


@pytest.mark.parametrize('play', [False, True])
def test_driver_failure_or_uncertain_native_exit_is_never_retried(monkeypatch, play):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch); db.lose_ack = True
    def forbidden(*args, **kwargs): raise AssertionError('No native history reconciliation/retry')
    monkeypatch.setattr(s, '_reconciled', forbidden)
    ticket = begin(handle, play=play); settle(handle)
    delivery = handle.take_delivery(ticket)
    assert delivery.outcome is s._Outcome.UNAVAILABLE and delivery.receipt is None
    assert db.checkouts == db.exits == 1 and db.commits == 0
    assert handle.owner.current is None and handle.owner.thread is None


@pytest.mark.parametrize('play', [False, True])
def test_abandon_before_dispatch_never_allocates_native_owner(monkeypatch, play):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    ticket = begin(handle, play=play)
    handle.abandon(ticket)
    assert handle.owner.current is None and not db.calls and db.checkouts == 0
    assert handle.owner.thread is None


@pytest.mark.parametrize('play', [False, True])
def test_fixed_native_reservation_is_required_before_ticket(monkeypatch, play):
    install(monkeypatch); handle, = handles(monkeypatch)
    owner = handle.owner
    required = (owner.limits.intake_bytes + s.prepare.MAX_PRIVATE_BYTES + s.HISTORY_SCHEMA_PHASE_BYTES
        + native.HISTORY_NATIVE_PHASE_BYTES)
    owner.limits = replace(owner.limits, total_logical_bytes=required-1)
    with pytest.raises(s.SourceUnavailable): begin(handle, play=play)
    assert owner.current is None and owner.next_ticket == 1 and owner.thread is None
    owner.limits = replace(owner.limits, total_logical_bytes=required)
    ticket = begin(handle, play=play)
    assert owner.current.ticket is ticket
    handle.abandon(ticket)


def test_factory_binds_same_server_configuration_and_rejects_substitution(monkeypatch):
    monkeypatch.setattr(s, '_PROCESS_OWNER', None)
    config = dict(CONFIG)
    first = s.create_foobar_import_service(config, database_url='synthetic:no-network')
    second = s.create_foobar_import_service(config, database_url='synthetic:no-network')
    assert first.owner is second.owner and first.owner.native_configuration is config
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(dict(config), database_url='synthetic:no-network')
    assert first.owner.thread is None


def test_service_source_has_no_new_worker_or_native_retry_or_cached_target():
    once = inspect.getsource(s._call_once)
    assert 'config=owner.native_configuration' in once
    bounded = inspect.getsource(s._call_bounded)
    assert '(_Kind.PREPARE,_Kind.APPLY,_Kind.MATCH_APPLY)' in bounded
    assert '_Kind.HISTORY_PLAY' not in bounded and '_Kind.HISTORY_ELIGIBILITY' not in bounded
    begin_source = inspect.getsource(s._ProcessOwner.begin)
    assert 'history_native.HISTORY_NATIVE_PHASE_BYTES' in begin_source
    assert 'require_account_foobar_read(context,constraints)' in begin_source
