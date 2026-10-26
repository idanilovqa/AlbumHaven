"""AUTHORED ONLY. Deterministic lifecycle state checks, not concurrency proof."""
from dataclasses import replace
import inspect

import pytest

from tests.py.foobar_account_service_testing import (
    s,CONFIG,handles,context,command,PAYLOAD,begin_prepare,dispatch_prepare,
    PolicyEvaluationConstraints,
)


def test_default_disabled_and_strict_server_configuration(monkeypatch):
    monkeypatch.setattr(s,'_PROCESS_OWNER',None)
    for enabled in (None,False,1,'true'):
        configuration=dict(CONFIG,ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED=enabled)
        with pytest.raises(s.SourceUnavailable):
            s.create_foobar_import_service(configuration,database_url='synthetic:no-network')
    assert s._PROCESS_OWNER is None
    for value in (True,0,-1,'01','+1','1.0',2**63):
        with pytest.raises(s.SourceUnavailable):
            s.parse_foobar_import_limits(dict(CONFIG,ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES=value))


def test_one_owner_per_process_configuration_mismatch_and_no_replacement(monkeypatch):
    first,second=handles(monkeypatch,2,open=False)
    assert first.owner is second.owner
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:other')
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(dict(CONFIG,ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES=123),
            database_url='synthetic:no-network')
    first.close()
    assert first.join(0) is True and not second.closed
    second.close()
    assert second.owner.state is s._State.QUIESCENT
    assert second.join(0) is True
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:no-network')
    assert s._PROCESS_OWNER is second.owner


def test_pid_and_reload_epoch_fail_closed_without_replacing_owner(monkeypatch):
    handle,=handles(monkeypatch,open=False)
    owner=handle.owner
    monkeypatch.setattr(s.os,'getpid',lambda:owner.pid+1)
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:no-network')
    monkeypatch.setattr(s.os,'getpid',lambda:owner.pid)
    monkeypatch.setattr(s,'_MODULE_EPOCH',object())
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:no-network')
    assert s._PROCESS_OWNER is owner


def test_one_slot_and_exact_ticket_identity_not_just_matching_fields(monkeypatch):
    first,second=handles(monkeypatch,2)
    ticket=begin_prepare(first)
    assert not first.available and not second.available
    with pytest.raises(s.SourceUnavailable):
        begin_prepare(second)
    with pytest.raises(s.SourceUnavailable):
        second.append_prepare(ticket,PAYLOAD)
    forged=s._Ticket(first,ticket.identity)
    with pytest.raises(s.SourceUnavailable):
        first.append_prepare(forged,PAYLOAD)
    first.abandon(forged)
    assert first.owner.current.ticket is ticket
    first.abandon(ticket)
    newer=begin_prepare(first)
    first.abandon(ticket)
    assert first.owner.current.ticket is newer
    first.abandon(newer)
    assert first.available


def test_cancel_and_shutdown_running_work_hold_slot_until_settlement(monkeypatch):
    handle,=handles(monkeypatch)
    ticket=dispatch_prepare(handle)
    operation=handle.owner.current
    handle.abandon(ticket)
    assert operation.abandoned and handle.owner.current is operation
    assert not handle.available and not handle.owner.retry_permitted(operation)
    with pytest.raises(s.SourceUnavailable):
        begin_prepare(handle)
    handle.close()
    assert handle.owner.state is s._State.DRAINING
    assert handle.join(0) is False
    assert handle.owner.current is operation
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:no-network')
    assert handle.owner.current is operation


def test_start_failure_does_not_spawn_replacement(monkeypatch):
    handle,=handles(monkeypatch,open=False)
    attempts=[]

    class FailedThread:
        def __init__(self,**kwargs):
            attempts.append(kwargs)
        def start(self):
            raise RuntimeError('synthetic thread start failure')

    monkeypatch.setattr(s.threading,'Thread',FailedThread)
    with pytest.raises(s.SourceUnavailable):
        handle.start(0)
    assert handle.owner.state is s._State.FAULTED
    assert handle.start(0) is False
    assert len(attempts)==1 and attempts[0]['daemon'] is False
    assert handle.owner.start_attempted


def test_bounded_intake_releases_failed_input_but_not_newer_ticket(monkeypatch):
    handle,=handles(monkeypatch)
    ticket=begin_prepare(handle)
    with pytest.raises(s.SourceUnavailable):
        handle.append_prepare(ticket,PAYLOAD+b'excess')
    assert handle.available
    for length in (True,0,-1,s.MAX_UPLOAD_BYTES+1):
        with pytest.raises(s.SourceUnavailable):
            handle.begin_prepare(context=context(),constraints=PolicyEvaluationConstraints(),
                command=command(),length=length)
    assert handle.owner.current is None


def test_authentic_narrowing_resolver_is_retained_not_replaced(monkeypatch):
    handle,=handles(monkeypatch)
    calls=[]
    def resolver(target):
        calls.append(target.action)
        return PolicyEvaluationConstraints()
    ticket=begin_prepare(handle,constraints=resolver)
    assert handle.owner.current.constraints is resolver
    assert 'account.self.foobar.write' in calls
    handle.abandon(ticket)
    def denied(target):
        return PolicyEvaluationConstraints(client_surface_allowed=False)
    with pytest.raises(s.SourceUnavailable):
        begin_prepare(handle,constraints=denied)
    assert handle.owner.current is None


def test_shutdown_code_never_closes_shared_pool_and_only_one_thread_constructor():
    source=inspect.getsource(s)
    assert source.count('threading.Thread(')==1
    assert 'ThreadPoolExecutor' not in source
    assert 'close_all_pools' not in source and 'close_pool(' not in source
    assert '_PROCESS_OWNER=None' in source
    assert 'self.exited.wait(timeout)' in inspect.getsource(s._ProcessOwner.join)


def test_start_timeout_never_means_termination_or_replacement(monkeypatch):
    handle,=handles(monkeypatch,open=False)
    attempts=[]
    class PausedThread:
        def __init__(self,**kwargs):
            attempts.append(kwargs)
        def start(self):
            pass  # Controlled scheduler has not entered the worker yet.
        def join(self,timeout):
            raise AssertionError('No join before witnessed worker exit')
        def is_alive(self):
            return True
    monkeypatch.setattr(s.threading,'Thread',PausedThread)
    assert handle.start(0) is False
    original=handle.owner.thread
    assert handle.start(0) is False and len(attempts)==1
    handle.close()
    assert handle.join(0) is False
    assert handle.owner.thread is original and handle.owner.state is s._State.DRAINING
    with pytest.raises(s.SourceUnavailable):
        s.create_foobar_import_service(CONFIG,database_url='synthetic:no-network')
