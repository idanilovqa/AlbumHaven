"""AUTHORED ONLY: real retry/reconciliation + real composed import callers.

Only SQL-result/outer-transaction and deterministic scheduling boundaries vary.
No reconciliation result, business receipt, policy result or protocol is faked.
"""
from contextlib import contextmanager
from dataclasses import replace

import pytest

from tests.py.foobar_account_service_testing import (
    s,reconciliation,handles,install_db,install_reconciliation,prepare,apply_command,
    dispatch_prepare,begin_apply,context,command,KEY,APPLY_KEY,p,a,f,
)
from tests.py.foobar_account_matching_composed_boundary import requested_context


def test_lost_apply_ack_reconciles_actual_original_keys_then_only_replays(monkeypatch):
    db=install_db(monkeypatch)
    unused,receipt=prepare(db)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    cmd=apply_command(receipt,7)
    ticket=begin_apply(handle,cmd,requested_context(7))
    operation=handle.owner.current
    db.lose_ack=True
    result,outcome=s._call_bounded(handle.owner,operation)
    assert outcome is s._Outcome.SUCCESS and result.terminal_bytes==db.receipt['terminal']
    assert operation.command is cmd and operation.ticket is ticket
    assert reconciliation._KEY_SQL in db.calls
    assert db.calls.count(p.source._insert_revisions_sql())==1
    assert db.calls.count(p.taste._foobar_taste_write_sql())==1
    assert db.calls.count(f._COMMIT_SQL)==1
    assert set(db.keys)=={KEY,APPLY_KEY}
    # First Apply committed before the durable key lookup. Second invocation
    # used the genuine Apply entry rather than turning reconciliation into success.
    committed=db.calls.index(f._COMMIT_SQL)
    reconciled=db.calls.index(reconciliation._KEY_SQL)
    assert committed<reconciled
    assert a._APPLY_KEY_SQL in db.calls[reconciled+1:]


def test_lost_prepare_ack_reconciles_actual_ready_envelope_and_same_upload(monkeypatch):
    db=install_db(monkeypatch)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    original=command()
    ticket=dispatch_prepare(handle,original)
    operation=handle.owner.current
    upload=operation.intake._payload
    db.lose_ack=True
    receipt,outcome=s._call_bounded(handle.owner,operation)
    assert outcome is s._Outcome.SUCCESS and receipt.receipt_ref==db.receipt['receipt_ref']
    assert operation.command is original and operation.intake._payload is upload
    assert operation.ticket is ticket and set(db.keys)=={KEY}
    assert db.calls.count(p._INSERT_READY_SQL)==1
    assert reconciliation._KEY_SQL in db.calls


def test_two_failed_native_attempts_stop_without_key_replacement(monkeypatch):
    db=install_db(monkeypatch)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    ticket=dispatch_prepare(handle)
    operation=handle.owner.current
    original=operation.command
    db.fail_sql=p.lookup._CARDINALITY_SQL
    receipt,outcome=s._call_bounded(handle.owner,operation)
    assert receipt is None and outcome is s._Outcome.UNAVAILABLE
    assert db.calls.count(p.lookup._CARDINALITY_SQL)==2
    assert db.calls.count(reconciliation._KEY_SQL)==1
    assert operation.command is original and operation.ticket is ticket
    assert db.keys=={} and db.receipt is None


def test_failed_reconciliation_forbids_second_native_attempt(monkeypatch):
    db=install_db(monkeypatch)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    dispatch_prepare(handle)
    operation=handle.owner.current
    execute=db.execute
    def failed_queries(sql,params=None,**kwargs):
        if sql in (p.lookup._CARDINALITY_SQL,reconciliation._KEY_SQL):
            db.calls.append(sql)
            raise OSError('synthetic database read failure')
        return execute(sql,params,**kwargs)
    monkeypatch.setattr(db,'execute',failed_queries)
    receipt,outcome=s._call_bounded(handle.owner,operation)
    assert receipt is None and outcome is s._Outcome.UNAVAILABLE
    assert db.calls.count(p.lookup._CARDINALITY_SQL)==1
    assert db.calls.count(reconciliation._KEY_SQL)==1


def test_stale_never_reconciles_or_retries(monkeypatch):
    db=install_db(monkeypatch)
    cmd,receipt=prepare(db)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    begin_apply(handle,apply_command(receipt,8),requested_context(8))
    start=len(db.calls)
    receipt,outcome=s._call_bounded(handle.owner,handle.owner.current)
    assert receipt is None and outcome is s._Outcome.STALE
    assert reconciliation._KEY_SQL not in db.calls[start:]
    assert db.source_row is None


def test_cancel_after_first_settled_failure_suppresses_reconciliation(monkeypatch):
    db=install_db(monkeypatch)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    ticket=dispatch_prepare(handle)
    db.fail_sql=p.lookup._CARDINALITY_SQL
    original_outer=db.outer

    @contextmanager
    def cancel_after_exit(*args,**kwargs):
        try:
            with original_outer(*args,**kwargs) as result:
                yield result
        except BaseException:
            handle.abandon(ticket)
            raise

    monkeypatch.setattr(p,'current_foobar_import_transaction',cancel_after_exit)
    receipt,outcome=s._call_bounded(handle.owner,handle.owner.current)
    assert receipt is None and outcome is s._Outcome.UNAVAILABLE
    assert reconciliation._KEY_SQL not in db.calls
    assert handle.owner.current.abandoned and not handle.available
    assert db.calls.count(p.lookup._CARDINALITY_SQL)==1


def test_unknown_commit_stays_uncertain_when_reconciliation_fails(monkeypatch):
    db=install_db(monkeypatch)
    unused,receipt=prepare(db)
    install_reconciliation(monkeypatch,db)
    handle,=handles(monkeypatch)
    begin_apply(handle,apply_command(receipt,7),requested_context(7))
    db.lose_ack=True
    db.fail_sql=reconciliation._KEY_SQL
    result,outcome=s._call_bounded(handle.owner,handle.owner.current)
    assert result is None and outcome is s._Outcome.COMMIT_UNCERTAIN
    assert db.receipt['state']=='committed' and db.revision==1
