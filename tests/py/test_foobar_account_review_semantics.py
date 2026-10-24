"""AUTHORED ONLY: genuine review, preflight and actual batch semantic equality.

This suite has not been imported, parsed, collected or executed. Synthetic
pooled driver rows model external changes; no SQL or authority result is faked.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import pytest

from tests.py.foobar_account_job_worker_testing import assert_contiguous_windows

from tests.py.foobar_account_review_testing import (
    running, command, submit, settled, block_sql, install, jobs, review, s, p, a, f,
    requested_context, payload_rows, PAYLOAD, SOURCE, JOB, NEXT_JOB,
    PolicyEvaluationConstraints, begin_review, settled_review, reviewed, review_sha,
    snapshot, business_snapshot, confirm, account_authority, authority, route,
)


def test_actual_whole_upload_review_rolls_back_every_owner_without_durable_job(monkeypatch):
    payload = payload_rows(203)
    with running(monkeypatch) as (db, handle, catalog):
        before = snapshot(db)
        result = reviewed(handle, payload)
        report = result.result.proposed
        assert snapshot(db) == before
        assert db.explicit_rollbacks == 1 + report.planned_batches  # resolution plus every real window
        assert report.status == 'complete_preflight' and report.checked_rows == 203
        assert report.proposed_counts == (0, 203, 0, 0, 0, 0, 0)
        assert report.review_counts == (203, 203, 0, 0, 0, 0)
        assert_contiguous_windows([(start, end) for start, end, digest in report.window_seals], 203)
        assert len(report.window_seals) == report.planned_batches
        assert all(len(digest) == 64 for start, end, digest in report.window_seals)
        assert len(report.review_problems) == 32 and report.review_truncated
        assert not db.job_rows and not db.attempts and not db.keys and not db.receipts
        assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls
        assert p.taste._foobar_taste_write_sql() not in db.calls
        assert handle.owner.current is None and handle.available


def test_real_fresh_ids_and_clock_change_do_not_change_review_semantics(monkeypatch):
    generated, original_uuid = [], p.uuid4
    def observed_uuid():
        value = original_uuid()
        generated.append(str(value))
        return value
    monkeypatch.setattr(p, 'uuid4', observed_uuid)
    with running(monkeypatch) as (db, handle, catalog):
        first = reviewed(handle, PAYLOAD, library=7)
        cut = len(generated)
        db.now += timedelta(seconds=1)
        second = reviewed(handle, PAYLOAD, library=7)
        assert cut >= 2 and len(generated) >= 2 * cut
        assert len(set(generated)) == len(generated)
        assert first.result.proposed.window_seals == second.result.proposed.window_seals
        assert first.result.proposed.proposal_sha256 == second.result.proposed.proposal_sha256
        assert review_sha(first) == review_sha(second)
        assert not db.receipts and not db.source_rows and not db.job_rows
        confirm(handle, second, PAYLOAD)
        result = settled(handle)
        assert result.phase == 'completed' and result.status.confirmed_through == 1
        assert result.status.confirmed_counts == (0, 0, 0, 1, 1, 1, 1)
        assert db.calls.count(f._COMMIT_SQL) == 1 and len(db.bindings) == 1


def test_matching_inventory_and_command_are_derived_by_current_server_owners(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        first = reviewed(handle, PAYLOAD, library=7)
        result = first.result
        assert result.command.upload_sha256 == p.hashlib.sha256(PAYLOAD).hexdigest()
        assert result.command.total_rows == 1 and result.command.original_generation == db.current_generation
        assert result.command.original_matching_library_id == 7
        assert result.inventory_sha256 != p.NO_LIBRARY_INVENTORY_SHA256
        db.files[22] = '/a-different-unmatched-file.flac'
        second = reviewed(handle, PAYLOAD, library=7)
        assert second.result.inventory_sha256 != result.inventory_sha256
        assert second.result.proposed.proposed_counts == result.proposed.proposed_counts
        assert second.result.proposed.review_counts == result.proposed.review_counts
        assert review_sha(second) != review_sha(first)
        before = business_snapshot(db)
        confirm(handle, first, PAYLOAD)
        stopped = settled(handle)
        assert stopped.phase in ('needs_preflight', 'needs_review')
        assert business_snapshot(db) == before and not db.attempts
        assert f._COMMIT_SQL not in db.calls


@pytest.mark.parametrize('change', ['manual_rating', 'explicit_protection', 'taste_state', 'taste_identity'])
def test_equal_counts_do_not_authorize_changed_native_taste_or_protection(monkeypatch, change):
    with running(monkeypatch) as (db, handle, catalog):
        db.tastes[21].update(preference_id=51, rating=2)
        first = reviewed(handle, PAYLOAD, library=7)
        if change == 'manual_rating':
            db.tastes[21]['rating'] = 3
        elif change == 'explicit_protection':
            db.tastes[21]['rating_protected'] = True
        elif change == 'taste_state':
            db.tastes[21]['state_seal'] = 'd' * 64
        else:
            db.tastes[21]['identity_seal'] = 'e' * 64
        second = reviewed(handle, PAYLOAD, library=7)
        assert first.result.proposed.proposed_counts == second.result.proposed.proposed_counts
        assert first.result.proposed.review_counts == second.result.proposed.review_counts
        assert first.result.proposed.review_counts[4] == 1
        assert first.result.proposed.window_seals != second.result.proposed.window_seals
        assert review_sha(first) != review_sha(second)
        before = business_snapshot(db)
        confirm(handle, first, PAYLOAD)
        stopped = settled(handle)
        assert stopped.phase == 'needs_review' and stopped.error == 'stale_import'
        assert stopped.proposed.proposed_counts == first.result.proposed.proposed_counts
        assert business_snapshot(db) == before and not db.attempts
        assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls


@pytest.mark.parametrize('change', ['prior_revision', 'association_decision'])
def test_equal_counts_bind_exact_existing_source_and_association_history(monkeypatch, change):
    from tests.py.foobar_account_associations_v3_testing import history
    with running(monkeypatch) as (db, handle, catalog):
        seeded = reviewed(handle, PAYLOAD, library=7)
        confirm(handle, seeded, PAYLOAD)
        assert settled(handle).phase == 'completed'
        ref = next(iter(db.source_rows))
        first = reviewed(handle, PAYLOAD, library=7, job_ref=NEXT_JOB)
        if change == 'prior_revision':
            db.source_versions[ref] += 1
            db.revision += 1
        else:
            history(db, ref, track=21, version=2)
        second = reviewed(handle, PAYLOAD, library=7, job_ref=NEXT_JOB)
        assert first.result.proposed.proposed_counts == second.result.proposed.proposed_counts
        assert first.result.proposed.review_counts == second.result.proposed.review_counts
        assert first.result.proposed.window_seals != second.result.proposed.window_seals
        before = business_snapshot(db)
        apply_calls = db.calls.count(f._COMMIT_SQL)
        confirm(handle, first, PAYLOAD)
        stopped = settled(handle)
        assert stopped.phase == 'needs_review'
        assert business_snapshot(db) == before and db.calls.count(f._COMMIT_SQL) == apply_calls
        assert all(row['state'] == 'confirmed' for row in db.attempts.values())


@pytest.mark.parametrize('change', ['session', 'account', 'scope', 'file', 'job_identity'])
def test_equal_totals_cannot_transfer_review_to_changed_identity_scope_or_file(monkeypatch, change):
    payload = payload_rows(1)
    with running(monkeypatch) as (db, handle, catalog):
        first = reviewed(handle, payload)
        ctx, library, second_payload, job_ref = requested_context(None), None, payload, JOB
        if change == 'session':
            ctx = replace(ctx, actor=replace(ctx.actor, session_id=4))
        elif change == 'account':
            db.sources.add((2, SOURCE))
            ctx = replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5), target_account_id=2)
        elif change == 'scope':
            library, ctx = 7, requested_context(7)
        elif change == 'file':
            second_payload = payload.replace(b'Track', b'Other')
        else:
            job_ref = NEXT_JOB
        second = reviewed(handle, second_payload, ctx=ctx, library=library, job_ref=job_ref)
        assert second.result.proposed.proposed_counts == first.result.proposed.proposed_counts
        assert second.result.proposed.review_counts == first.result.proposed.review_counts
        assert review_sha(second) != review_sha(first)
        before = business_snapshot(db)
        confirm(handle, second, second_payload, ctx=ctx, seal=review_sha(first))
        stopped = settled(handle)
        assert stopped.phase == 'needs_review' and stopped.status.confirmed_through == 0
        assert business_snapshot(db) == before and not db.attempts
        assert f._COMMIT_SQL not in db.calls


@pytest.mark.parametrize('matching_late', [False, True])
def test_actual_ready_leaf_drift_stops_before_its_apply_even_after_confirm_root_matches(monkeypatch, matching_late):
    payload = PAYLOAD if not matching_late else payload_rows(100) + PAYLOAD.split(b'\n', 1)[1]
    with running(monkeypatch) as (db, handle, catalog):
        approved = reviewed(handle, payload, library=7)
        windows = approved.result.proposed.window_seals
        matching_batch = len(windows)
        assert matching_batch > 1 if matching_late else matching_batch == 1
        before_rollbacks = db.explicit_rollbacks
        real_pool, changed = db.pool, []
        @contextmanager
        def drift_after_final_preflight(url):
            try:
                with real_pool(url) as connection:
                    yield connection
            finally:
                if (not changed and db.job_rows and db.explicit_rollbacks ==
                        before_rollbacks + approved.result.proposed.planned_batches):
                    # Model a concurrent native taste update after the final
                    # rollback has exited. Never alter the semantic hash owner.
                    db.tastes[21]['state_seal'] = 'd' * 64
                    changed.append(True)
        for owner in (account_authority, authority):
            monkeypatch.setattr(owner, 'pooled_connection', drift_after_final_preflight)
        confirm(handle, approved, payload)
        result = settled(handle, timeout=30.0 if matching_late else 5.0)
        confirmed = windows[-1][0]
        assert changed and result.proposed.proposal_sha256 == approved.result.proposed.proposal_sha256
        assert result.phase == 'needs_review' and result.error == 'stale_import'
        assert result.status.confirmed_through == confirmed
        assert result.status.confirmed_counts == (0, confirmed, 0, 0, 0, 0, 0)
        assert len(db.source_rows) == confirmed and not db.bindings and not db.history
        assert db.tastes[21]['rating'] is None and db.tastes[21]['love_tier'] == 'off'
        assert db.calls.count(p._INSERT_READY_SQL) == matching_batch
        assert db.calls.count(f._COMMIT_SQL) == matching_batch - 1
        assert list(db.attempts.values())[-1]['state'] == 'ready'


def test_matching_review_reports_protection_without_overriding_manual_rating(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        db.tastes[21].update(preference_id=51, rating=2, favorite_protected=True)
        before = snapshot(db)
        result = reviewed(handle, PAYLOAD, library=7)
        report = result.result.proposed
        assert report.review_counts == (1, 0, 0, 0, 1, 0)
        assert report.proposed_counts == (0, 1, 0, 0, 0, 0, 1)
        assert (1, 'protected_rating', 'rating') in report.review_problems
        assert (1, 'protected_favorite', 'favorite') in report.review_problems
        assert snapshot(db) == before
        confirm(handle, result, PAYLOAD)
        assert settled(handle).phase == 'completed'
        assert db.tastes[21]['rating'] == 2 and db.tastes[21]['love_tier'] == 'off'
        assert p.taste._foobar_taste_write_sql() not in db.calls


@pytest.mark.parametrize('cancel_via', ['status_control', 'abandon'])
def test_review_cancel_or_disconnect_drops_raw_owner_without_checkpoint(monkeypatch, cancel_via):
    db = install(monkeypatch)
    entered, release, captured = block_sql(monkeypatch, db, p.lookup._CARDINALITY_SQL)
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        before = snapshot(db)
        ticket = begin_review(handle, payload_rows(203))
        assert entered.wait(3.0)
        operation = handle.owner.current
        assert operation.intake is not None and operation.indexed_upload is not None
        if cancel_via == 'status_control':
            current = handle.current_review_progress(context=requested_context(None),
                constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
            assert current.phase == 'cancelled_review' and current.result is None
        else:
            handle.abandon(ticket)
        assert handle.owner.current is operation and operation.job_cancel.is_set()
        release.set()
        result = settled_review(handle)
        assert result.phase == 'cancelled_review' and result.result is None
        assert snapshot(db) == before and not db.attempts and not db.job_rows
        assert operation.intake is operation.indexed_upload is operation.context is None
        assert f._COMMIT_SQL not in db.calls and p._INSERT_READY_SQL not in db.calls


def test_retained_review_status_is_exact_account_session_source_and_job_scoped(monkeypatch):
    with running(monkeypatch) as (db, handle, catalog):
        result = reviewed(handle, payload_rows(1))
        ctx = requested_context(None)
        assert handle.current_review_progress(context=ctx, constraints=PolicyEvaluationConstraints(),
            source_ref=SOURCE, job_ref=JOB) is result
        contexts = (replace(ctx, actor=replace(ctx.actor, session_id=4)),
            replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5), target_account_id=2))
        for foreign in contexts:
            with pytest.raises(s.SourceStale):
                handle.current_review_progress(context=foreign, constraints=PolicyEvaluationConstraints(),
                    source_ref=SOURCE, job_ref=JOB, cancel=True)
        with pytest.raises(s.SourceStale):
            handle.current_review_progress(context=ctx, constraints=PolicyEvaluationConstraints(),
                source_ref=SOURCE, job_ref=NEXT_JOB)
        assert handle.owner.last_review is result and not db.job_rows


@pytest.mark.parametrize('retained', ['review', 'job'])
@pytest.mark.parametrize('cancel', [False, True])
def test_cached_genuine_report_is_charged_during_control_and_cleared_by_new_work(monkeypatch, retained, cancel):
    from tests.py.foobar_account_import_jobs_testing import make_command
    with running(monkeypatch) as (db, handle, catalog):
        progress = reviewed(handle, payload_rows(1))
        if retained == 'job':
            confirm(handle, progress, payload_rows(1))
            cached = settled(handle)
            assert cached.proposed is not None and handle.owner.last_job is cached
        else:
            cached = progress
            assert handle.owner.last_review is cached
        owner, original_limits = handle.owner, handle.owner.limits
        threshold = (original_limits.intake_bytes + p.MAX_PRIVATE_BYTES
            + s.HISTORY_SCHEMA_PHASE_BYTES
            + 2 * jobs.JOB_PHASE_BYTES + review.REVIEW_HOLD_BYTES
            + (review.DETAIL_HOLD_BYTES if retained == 'review' else 0))
        owner.limits = replace(original_limits, total_logical_bytes=threshold - 1)
        ticket_number, before = owner.next_ticket, snapshot(db)
        with pytest.raises(s.SourceUnavailable):
            handle.begin_job_control(context=requested_context(None),
                constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=cancel)
        assert owner.next_ticket == ticket_number and owner.current is None and snapshot(db) == before
        assert (owner.last_review if retained == 'review' else owner.last_job) is cached
        owner.limits = replace(original_limits, total_logical_bytes=threshold)
        # A control delivery retains its ticket until taken or abandoned, so
        # this is race-safe without recursively acquiring the non-reentrant lock.
        ticket = handle.begin_job_control(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=cancel)
        assert owner.current.ticket is ticket
        assert (owner.last_review if retained == 'review' else owner.last_job) is cached
        handle.abandon(ticket)
        with owner.condition:
            assert owner.condition.wait_for(lambda: owner.current is None, timeout=5.0)
        owner.limits = original_limits
        seed = make_command(db, payload=PAYLOAD, library=None)
        ticket = handle.begin_prepare(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), command=seed, length=len(PAYLOAD))
        assert owner.last_review is None and owner.last_job is None
        handle.abandon(ticket)
        assert owner.current is None and handle.available


@pytest.mark.parametrize('account,source,previous', [
    (3, SOURCE, False),
    (1, '99999999-9999-4999-8999-999999999999', False),
    (2, SOURCE, True),
])
def test_scalar_driver_never_admits_unregistered_scope_or_foreign_prior(monkeypatch, account, source, previous):
    import json
    from copy import deepcopy
    from tests.py.foobar_account_import_jobs_testing import install
    db = install(monkeypatch)
    db.sources.add((2, SOURCE))
    if previous:
        db.source_rows['prior'] = ('prior',)
    frame = [None] * 18
    frame[0:4] = [account, None, source, 'prior' if previous else None]
    frame[13] = ''
    before = deepcopy((db.source_rows, db.source_versions, db.sources, db.revision))
    with pytest.raises(AssertionError):
        db.dispatch(p.sizing._MERGED_SIZE_SQL, (json.dumps(frame).encode(),))
    assert (db.source_rows, db.source_versions, db.sources, db.revision) == before
