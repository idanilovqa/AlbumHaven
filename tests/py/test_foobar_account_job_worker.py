"""AUTHORED ONLY. Actual worker/service/repository/index/Prepare/Apply chain.

Synthetic driver rows and commit-ack faults are the only data seam. These tests
are not executed evidence, database-isolation proof, deployment approval or an
end-to-end production import. They intentionally do not replace the coordinator.
"""
from dataclasses import replace
import json
from threading import Event

import pytest

from tests.py.foobar_account_job_worker_testing import (
    running, command, submit, settled, block_sql, install, jobs, worker,
    s, p, f, reconciliation, requested_context, payload_rows, start, status,
    prepare, URL, JOB, SOURCE, PolicyEvaluationConstraints, UNREVIEWED_SHA256,
    reviewed, review_sha, assert_contiguous_windows, assert_confirmed_terminals,
)


def test_actual_worker_confirms_all_bounded_batches_from_durable_terminals(monkeypatch):
    payload = payload_rows(203)
    with running(monkeypatch) as (db, handle, catalog):
        cmd, inventory = command(db, payload, 203)
        ticket = submit(handle, cmd, inventory, payload)
        result = settled(handle, timeout=30.0)
        assert result.phase == 'completed' and not result.uncertain
        assert result.status.disposition == 'completed'
        assert result.status.confirmed_through == 203
        assert result.status.confirmed_counts == (0, 203, 0, 0, 0, 0, 0)
        assert result.proposed.status == 'complete_preflight'
        assert result.proposed.checked_rows == 203
        assert p.MAX_PRIVATE_BYTES == 4 * 1024 * 1024
        assert 0 < result.proposed.window_seals[0][1] < 100  # genuine byte-limited prefix
        assert result.proposed.planned_batches == len(db.attempts)
        assert len(db.source_rows) == 203 and len(db.receipts) == len(db.attempts)
        terminals = [tuple(json.loads(row['terminal_bytes'])) for row in db.attempts.values()]
        assert result.status.confirmed_counts == tuple(map(sum, zip(*(t[16:23] for t in terminals))))
        assert_confirmed_terminals(db, result, 203)
        assert_contiguous_windows([(a, b) for a, b, _ in result.proposed.window_seals], 203)
        assert handle.owner.next_ticket == ticket.identity + 1  # no per-batch worker tickets
        assert handle.available and handle.owner.last_job is result
        first_prepare = db.calls.index(p._INSERT_READY_SQL)
        assert sum(sql == p.lookup._CARDINALITY_SQL for sql in db.calls[:first_prepare]) >= 4


def test_actual_parser_checks_malformed_late_row_before_any_job_or_import_mutation(monkeypatch):
    payload = payload_rows(203) + b'bad\textra\n'
    with running(monkeypatch) as (db, handle, catalog):
        cmd, inventory = command(db, payload, 203)
        submit(handle, cmd, inventory, payload, review_sha256=UNREVIEWED_SHA256)
        result = settled(handle)
        assert result.phase == 'invalid_source' and result.status is None
        assert db.job_rows == db.attempts == db.receipts == db.source_rows == {}
        assert not db.keys and db.calls.count(p._INSERT_READY_SQL) == 0
        assert handle.available


def test_actual_late_preflight_driver_failure_prevents_first_business_mutation(monkeypatch):
    payload = payload_rows(203)
    db = install(monkeypatch)
    execute, scans = db.execute, []
    def fail_second_window(sql, params=None, **kwargs):
        if sql == p.lookup._CARDINALITY_SQL:
            scans.append(params)
            if len(scans) == 2:
                raise OSError('Synthetic late preflight lookup unavailable')
        return execute(sql, params, **kwargs)
    monkeypatch.setattr(db, 'execute', fail_second_window)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        cmd, inventory = command(db, payload, 203)
        submit(handle, cmd, inventory, payload, review_sha256=UNREVIEWED_SHA256)
        result = settled(handle)
        assert len(scans) == 2 and result.phase == 'needs_reconciliation'
        assert len(db.job_rows) == 1  # metadata is not an imported source mutation
        assert not db.attempts and not db.keys and not db.receipts and not db.source_rows
        assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls


@pytest.mark.parametrize('phase_sql', [p._INSERT_READY_SQL, f._COMMIT_SQL])
def test_actual_lost_ack_reconciles_same_keys_without_repeating_business_writes(monkeypatch, phase_sql):
    db = install(monkeypatch)
    real, injected = db.execute, []
    def lose_selected_ack(sql, params=None, **kwargs):
        value = real(sql, params, **kwargs)
        if sql == phase_sql and not injected:
            db.lose_ack = True
            injected.append(sql)
        return value
    with running(monkeypatch, db=db) as (db, handle, catalog):
        payload = payload_rows(103)
        cmd, inventory = command(db, payload, 103)
        seal = review_sha(reviewed(handle, payload))
        monkeypatch.setattr(db, 'execute', lose_selected_ack)
        submit(handle, cmd, inventory, payload, review_sha256=seal)
        result = settled(handle, timeout=30.0)
        assert result.phase == 'completed' and result.status.confirmed_through == 103
        assert injected == [phase_sql] and reconciliation._KEY_SQL in db.calls
        assert_confirmed_terminals(db, result, 103)
        assert len(db.keys) == 2 * len(db.attempts)
        assert len(db.receipts) == len(db.attempts)
        for row in db.attempts.values():
            assert row['state'] == 'confirmed'
            assert row['prepare_key'] in db.keys and row['apply_key'] in db.keys
            assert row['attempt_no'] == 1


def test_uncertain_ack_keeps_single_slot_and_raw_owner_until_real_reconciliation_settles(monkeypatch):
    db = install(monkeypatch)
    real, injected = db.execute, []
    def lose_apply_ack(sql, params=None, **kwargs):
        value = real(sql, params, **kwargs)
        if sql == f._COMMIT_SQL and not injected:
            injected.append(True)
            db.lose_ack = True
        return value
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        seal = review_sha(reviewed(handle, payload))
        monkeypatch.setattr(db, 'execute', lose_apply_ack)
        entered, release, unused = block_sql(monkeypatch, db, reconciliation._KEY_SQL, release=release)
        ticket = submit(handle, cmd, inventory, payload, review_sha256=seal)
        assert entered.wait(3.0)
        operation = handle.owner.current
        assert operation.ticket is ticket and operation.stage is s._Stage.RUNNING
        assert operation.intake is not None and operation.indexed_upload is not None
        assert not handle.available and operation.job_progress.status.confirmed_through == 0
        assert operation.job_progress.phase == 'applying'
        with pytest.raises(s.SourceUnavailable):
            submit(handle, cmd, inventory, payload, review_sha256=UNREVIEWED_SHA256)
        assert handle.owner.current is operation and handle.owner.next_ticket == 3
        release.set()
        result = settled(handle)
        assert result.phase == 'completed' and result.status.confirmed_through == 1
        assert operation.intake is operation.indexed_upload is operation.context is None
        assert db.calls.count(f._COMMIT_SQL) == 1


def test_cancel_during_real_apply_preserves_commit_and_stops_future_batches(monkeypatch):
    db = install(monkeypatch)
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(203)
        cmd, inventory = command(db, payload, 203)
        seal = review_sha(reviewed(handle, payload))
        entered, release, unused = block_sql(monkeypatch, db, f._COMMIT_SQL, after=True, release=release)
        ticket = submit(handle, cmd, inventory, payload, review_sha256=seal)
        assert entered.wait(30.0)
        operation = handle.owner.current
        pending = handle.current_job_progress(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        assert pending.cancel_pending and pending.status.confirmed_through == 0
        assert operation.ticket is ticket and not handle.available
        release.set()
        result = settled(handle, timeout=30.0)
        assert result.phase == 'cancelled' and result.status.cancel_requested
        first_end = result.proposed.window_seals[0][1]
        assert 0 < first_end <= 100
        assert result.status.confirmed_through == first_end
        assert result.status.confirmed_counts == (0, first_end, 0, 0, 0, 0, 0)
        assert len(db.attempts) == 1 and len(db.source_rows) == first_end
        assert db.calls.count(f._COMMIT_SQL) == db.calls.count(p._INSERT_READY_SQL) == 1
        assert not result.cancel_pending and not result.uncertain


def test_cancel_inflight_final_batch_reports_completed_not_rolled_back(monkeypatch):
    db = install(monkeypatch)
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        seal = review_sha(reviewed(handle, payload))
        entered, release, unused = block_sql(monkeypatch, db, f._COMMIT_SQL, after=True, release=release)
        submit(handle, cmd, inventory, payload, review_sha256=seal)
        assert entered.wait(3.0)
        handle.current_job_progress(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        release.set()
        result = settled(handle)
        assert result.phase == 'completed' and result.status.confirmed_through == 1
        assert not result.cancel_pending and len(db.source_rows) == 1


def test_actual_current_session_resume_fences_ready_and_reuses_identical_source(monkeypatch):
    db = install(monkeypatch)
    payload = payload_rows(103)
    original, cmd, batch, upload = start(db, payload=payload)
    try:
        prepare(original, batch, upload)
    finally:
        upload.close()
    previous = db.attempts[(1, SOURCE, JOB, 1, 1)].copy()
    current = replace(original, actor=replace(original.actor, session_id=4))
    with running(monkeypatch, db=db) as (db, handle, catalog):
        submit(handle, cmd, batch.prepare_command.inventory_sha256, payload, ctx=current, resume=True)
        result = settled(handle, timeout=30.0)
        assert result.phase == 'completed' and result.status.confirmed_through == 103
        assert db.attempts[(1, SOURCE, JOB, 1, 1)]['state'] == 'discarded'
        replacement = db.attempts[(1, SOURCE, JOB, 1, 2)]
        assert replacement['original_session_id'] == 4 and replacement['state'] == 'confirmed'
        assert replacement['prepare_key'] != previous['prepare_key']
        assert db.keys[previous['prepare_key']]['state'] == 'tombstone'
        assert len(db.source_rows) == 103


def test_resume_wrong_source_bytes_cannot_fence_or_replace_old_attempt(monkeypatch):
    db = install(monkeypatch)
    original, cmd, batch, upload = start(db)
    try:
        prepare(original, batch, upload)
    finally:
        upload.close()
    prior = db.attempts[(1, SOURCE, JOB, 1, 1)].copy()
    current = replace(original, actor=replace(original.actor, session_id=4))
    with running(monkeypatch, db=db) as (db, handle, catalog):
        submit(handle, cmd, batch.prepare_command.inventory_sha256,
            payload_rows(1), ctx=current, resume=True, review_sha256=UNREVIEWED_SHA256)
        result = settled(handle)
        assert result.phase == 'invalid_source'
        assert db.attempts[(1, SOURCE, JOB, 1, 1)] == prior
        assert not db.source_rows and len(db.receipts) == 1


def test_revoked_current_resume_session_cannot_advance_or_discard_ready(monkeypatch):
    db = install(monkeypatch)
    original, cmd, batch, upload = start(db)
    try:
        prepare(original, batch, upload)
    finally:
        upload.close()
    prior = db.attempts[(1, SOURCE, JOB, 1, 1)].copy()
    current = replace(original, actor=replace(original.actor, session_id=4))
    db.sessions[(1, 4)] = False
    with running(monkeypatch, db=db) as (db, handle, catalog):
        from tests.py.foobar_account_import_jobs_testing import PAYLOAD
        submit(handle, cmd, batch.prepare_command.inventory_sha256, PAYLOAD, ctx=current, resume=True,
            review_sha256=UNREVIEWED_SHA256)
        result = settled(handle)
        assert result.phase == 'needs_preflight' and result.error == 'stale_import'
        assert not result.uncertain
        assert db.attempts[(1, SOURCE, JOB, 1, 1)] == prior and not db.source_rows


def test_cancel_at_real_retry_reconciliation_boundary_prevents_second_native_dispatch(monkeypatch):
    db = install(monkeypatch)
    real, injected = db.execute, []
    def lose_prepare_ack(sql, params=None, **kwargs):
        value = real(sql, params, **kwargs)
        if sql == p._INSERT_READY_SQL and not injected:
            injected.append(True)
            db.lose_ack = True
        return value
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(103)
        cmd, inventory = command(db, payload, 103)
        seal = review_sha(reviewed(handle, payload))
        monkeypatch.setattr(db, 'execute', lose_prepare_ack)
        entered, release, unused = block_sql(monkeypatch, db, reconciliation._KEY_SQL, release=release)
        submit(handle, cmd, inventory, payload, review_sha256=seal)
        assert entered.wait(30.0)
        operation = handle.owner.current
        handle.current_job_progress(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        assert not handle.owner.retry_permitted(operation)
        release.set()
        result = settled(handle, timeout=30.0)
        assert result.phase == 'cancelled' and result.status.confirmed_through == 0
        assert result.status.cancel_requested and len(db.attempts) == 1
        assert len(db.receipts) == 1 and not db.source_rows
        assert db.calls.count(p._INSERT_READY_SQL) == 1
        assert db.calls.count(f._COMMIT_SQL) == 0
        # The existing READY proof is reconciled, not replaced or auto-applied.
        assert next(iter(db.attempts.values()))['state'] == 'ready'


def test_cancel_while_prepare_inflight_never_dispatches_apply(monkeypatch):
    db = install(monkeypatch)
    release = Event()
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(103)
        cmd, inventory = command(db, payload, 103)
        seal = review_sha(reviewed(handle, payload))
        entered, release, unused = block_sql(monkeypatch, db, p._INSERT_READY_SQL, after=True, release=release)
        submit(handle, cmd, inventory, payload, review_sha256=seal)
        assert entered.wait(30.0)
        handle.current_job_progress(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        release.set()
        result = settled(handle, timeout=30.0)
        assert result.phase == 'cancelled' and result.status.confirmed_through == 0
        assert not db.source_rows and len(db.receipts) == 1 and len(db.attempts) == 1
        assert f._COMMIT_SQL not in db.calls


def test_per_invocation_readiness_failure_releases_slot_with_bounded_separate_diagnostic(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        catalog.job_rows = [{'structural_ready':False}]
        submit(handle, cmd, inventory, payload, review_sha256=UNREVIEWED_SHA256)
        diagnostic = settled(handle)
        assert diagnostic.phase == 'needs_reconciliation' and diagnostic.uncertain
        assert diagnostic.error == 'unavailable' and diagnostic.status is None
        assert diagnostic.proposed is None and not db.job_rows and not db.source_rows
        assert handle.available
        ctx = requested_context(None)
        assert handle.settled_job_diagnostic(context=ctx, constraints=PolicyEvaluationConstraints(),
            source_ref=SOURCE, job_ref=JOB) is diagnostic
        assert handle.settled_job_diagnostic(context=ctx, constraints=PolicyEvaluationConstraints(),
            source_ref=SOURCE, job_ref='66666666-6666-4666-8666-666666666666') is None
        stranger = replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5), target_account_id=2)
        assert handle.settled_job_diagnostic(context=stranger, constraints=PolicyEvaluationConstraints(),
            source_ref=SOURCE, job_ref=JOB) is None
        # Starting new ordinary work clears diagnostic state before dispatch.
        from tests.py.foobar_account_import_jobs_testing import make_command
        seed = make_command(db, payload=payload, library=None)
        catalog.job_rows = [{'structural_ready':True}]
        ticket = handle.begin_prepare(context=ctx, constraints=PolicyEvaluationConstraints(),
            command=seed, length=len(payload))
        assert handle.owner.last_job is None
        handle.abandon(ticket)


def test_actual_multibatch_matching_counts_include_native_effect_in_later_window(monkeypatch):
    from tests.py.foobar_account_import_jobs_testing import PAYLOAD
    payload = payload_rows(102) + PAYLOAD.split(b'\n', 1)[1]
    with running(monkeypatch) as (db, handle, catalog):
        cmd, inventory = command(db, payload, 103, library=7)
        submit(handle, cmd, inventory, payload)
        result = settled(handle, timeout=30.0)
        assert result.phase == 'completed' and result.status.confirmed_through == 103
        assert result.status.confirmed_counts == (0, 102, 0, 1, 1, 1, 1)
        assert result.proposed.proposed_counts == (0, 102, 0, 1, 1, 1, 1)
        terminals = [tuple(json.loads(row['terminal_bytes'])) for row in db.attempts.values()]
        assert_confirmed_terminals(db, result, 103)
        assert all(t[16:23] == (0, t[15] - t[14], 0, 0, 0, 0, 0) for t in terminals[:-1])
        assert terminals[-1][16:23] == (0, terminals[-1][15] - terminals[-1][14] - 1, 0, 1, 1, 1, 1)
        assert len(db.source_rows) == 103 and len(db.bindings) == 1
        assert db.tastes[21]['rating'] == 4 and db.tastes[21]['love_tier'] == 'loved'
        assert db.calls.count(p.taste._foobar_taste_write_sql()) == 1


@pytest.mark.parametrize('change_after', ['preflight', 'first_batch'])
def test_actual_worker_fences_foreign_revision_between_transactions(monkeypatch, change_after):
    db = install(monkeypatch)
    from contextlib import contextmanager
    from tests.py.foobar_account_import_jobs_testing import account_authority, authority
    external, real_pool = [], db.pool
    review_rollbacks, planned = 0, 0
    @contextmanager
    def external_commit_after_driver_exit(url):
        try:
            with real_pool(url) as connection:
                yield connection
        finally:
            # Driver boundary runs after genuine commit OR rollback exit and
            # state restoration, including the preflight rollback sentinel.
            # Wait for the genuine final confirming-preflight rollback.
            preflight_done = bool(db.job_rows) and db.explicit_rollbacks == review_rollbacks + planned and not db.attempts
            batch_done = any(a['state'] == 'confirmed' for a in db.attempts.values())
            if not external and (preflight_done if change_after == 'preflight' else batch_done):
                db.revision += 1
                external.append(db.revision)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        payload = payload_rows(203)
        cmd, inventory = command(db, payload, 203)
        approved = reviewed(handle, payload)
        review_rollbacks = db.explicit_rollbacks
        planned = approved.result.proposed.planned_batches
        for owner in (account_authority, authority):
            monkeypatch.setattr(owner, 'pooled_connection', external_commit_after_driver_exit)
        submit(handle, cmd, inventory, payload, review_sha256=review_sha(approved))
        result = settled(handle, timeout=30.0)
        confirmed = 0 if change_after == 'preflight' else approved.result.proposed.window_seals[0][1]
        assert external and result.phase == 'needs_preflight' and result.error == 'stale_import'
        assert result.status.confirmed_through == confirmed
        assert result.status.confirmed_counts == (0, confirmed, 0, 0, 0, 0, 0)
        assert len(db.source_rows) == confirmed and len(db.attempts) == (0 if confirmed == 0 else 1)
        assert db.calls.count(f._COMMIT_SQL) == (0 if confirmed == 0 else 1)
        assert result.proposed.checked_rows == 203  # checked, never reserved
