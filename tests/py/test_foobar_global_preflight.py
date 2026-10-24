"""Authored only; genuine planners/authority, synthetic driver results, no SQL.

Pool exit snapshots model rollback, NOT PostgreSQL rollback certification.
The real transaction owner and its real session validator run without replacing
candidate planning, gates, policy, lookup, evidence, matching or quota owners.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace
import json
import threading

import pytest

from music_app.services import foobar_account_import_preflight as global_preflight
from tests.py.foobar_account_associations_v3_testing import (
    V3Boundary, p, a, authority, associations, make_command, requested_context,
    prepared, apply, PAYLOAD, CAPACITY,
)
from tests.py.test_foobar_indexed_prepare_integration import (
    open_upload, reject_raw, run_prepare,
)


STATE = ('receipt', 'keys', 'revision', 'source_rows', 'source_versions',
         'history', 'bindings', 'tastes', 'metadata_touches', 'history_projections')


def snapshot(db):
    return deepcopy(tuple(getattr(db, name) for name in STATE))


class DriverBoundary(V3Boundary):
    def __init__(self):
        super().__init__()
        self.rollbacks = []
        self.metadata_touches = 0
        self.rollback_failure = False
        self.account_active = True
        self.session_revoked = False
        self.quota = None
        self.after_rollback = None
        self.closed = False
        self.info = SimpleNamespace(transaction_status=2)
        self.explicit_rollback_mode = 'ok'
        self.explicit_rollbacks = 0

    def rollback(self):
        self.explicit_rollbacks += 1
        if self.explicit_rollback_mode == 'raise':
            raise OSError('synthetic explicit rollback failure')
        for name, value in zip(STATE, deepcopy(self.transaction_before)):
            setattr(self, name, value)
        self.closed = self.explicit_rollback_mode == 'closed'
        self.info.transaction_status = 2 if self.explicit_rollback_mode == 'nonidle' else 0

    @contextmanager
    def pool(self, url):
        assert url == 'synthetic:no-network'
        before = snapshot(self)
        self.transaction_before = before
        self.info.transaction_status = 2
        try:
            yield self
        except BaseException as error:
            for name, value in zip(STATE, before):
                setattr(self, name, value)
            self.rollbacks.append(type(error))
            if self.after_rollback is not None:
                self.after_rollback(self)
            if self.rollback_failure:
                raise OSError('synthetic rollback acknowledgement failure') from error
            raise
        else:
            self.commits += 1

    def execute(self, sql, params=None, **kwargs):
        if sql in (
            'set transaction isolation level read committed',
            "set local lock_timeout = '250ms'",
            "set local statement_timeout = '1000ms'",
            "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))",
        ):
            self.calls.append(sql)
            return self.cursor([])
        if sql == 'select id,is_active,disabled_at from app.accounts where id=%s for update':
            assert params == (1,) and not kwargs
            self.calls.append(sql)
            return self.cursor([dict(id=1, is_active=self.account_active, disabled_at=None)])
        if 'from app.account_sessions' in sql:
            assert params == (3, 1) and not kwargs
            self.calls.append(sql)
            return self.cursor([dict(id=3, account_id=1, authenticated_at=self.now,
                idle_expires_at=self.now + timedelta(days=1),
                absolute_expires_at=self.now + timedelta(days=1),
                revoked_at=self.now if self.session_revoked else None)])
        return super().execute(sql, params, **kwargs)

    def dispatch(self, sql, params):
        if sql in (p.gate._LOCK_SQL, p.gate._ROLL_SQL):
            self.metadata_touches += 1
        if sql == p._CAPACITY_SQL and self.quota is not None:
            return [dict(zip(('observation_count', 'revision_count', 'source_bytes'), self.quota))]
        return super().dispatch(sql, params)


def install_real_owner(monkeypatch):
    db = DriverBoundary()

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return db.now

    # Driver, deterministic time, and pooled connection boundaries only.
    monkeypatch.setattr(authority, 'datetime', FrozenDateTime)
    monkeypatch.setattr(authority, 'pooled_connection', db.pool)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', authority.current_foobar_import_transaction)
    return db


def payload_rows(n):
    return PAYLOAD.split(b'\n', 1)[0] + b'\n' + b''.join(
        ('/unknown-%d.flac\tTrack %d\t4\t1\t19\n' % (i, i)).encode() for i in range(n))


def run(ctx, cmd, upload, event=None):
    return global_preflight.preflight_indexed_foobar_import('synthetic:no-network', ctx,
        upload=upload, command=cmd, intake_capacity=CAPACITY,
        cancel_event=threading.Event() if event is None else event)


def assert_no_business_sql(db, start=0):
    prohibited = (p._INSERT_READY_SQL, p.source._insert_observations_sql(),
        p.source._insert_revisions_sql(), p.source._advance_pointers_sql(),
        p.taste._foobar_taste_write_sql(), associations._WRITE)
    assert not any(sql in prohibited for sql in db.calls[start:])


def test_real_transaction_exception_rolls_back_metadata_and_all_business_state(monkeypatch):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    before = snapshot(db)
    try:
        result = run(ctx, cmd, upload)
        assert result.status == 'complete_preflight'
        assert result.proposed_counts == (0, 0, 0, 1, 1, 1, 1)
        assert result.proposed_quota_additions[:2] == (1, 1)
        assert result.proposed_quota_additions[2] > 0
        assert snapshot(db) == before and db.commits == 0
        assert db.rollbacks == [p._PreflightRolledBack]
        assert db.explicit_rollbacks == 1 and db.info.transaction_status == 0
        assert any('from app.account_sessions' in sql for sql in db.calls)
        assert_no_business_sql(db)
        # Normal Prepare still traverses the same real candidate and READY path.
        receipt = run_prepare(ctx, cmd, upload)
        original = prepared(db)
        assert receipt.receipt_ref == original[1][6]
        assert db.receipt['authority_sha256'] == original[1][15]
        assert db.calls.count(p._INSERT_READY_SQL) == 1 and db.commits == 1
        # Independent exact-byte quota expectation from actual prepared source.
        row = original[2][0]
        from music_app.services import foobar_account_history_projection as history_codec
        projection = history_codec.build_account_history_projection(
            effective_evidence_bytes=bytes.fromhex(row[7]), display_bytes=bytes.fromhex(row[8]),
            source_revision=cmd.expected_revision + 1)
        assert result.proposed_quota_additions[2] == (
            sum(len(bytes.fromhex(row[i])) for i in (1, 6, 7, 8))
            + len(history_codec.encode_account_history_projection(projection)))
        _, terminal = apply(db, cmd, receipt)
        assert tuple(json.loads(terminal.terminal_bytes)[16:23]) == result.proposed_counts
    finally:
        upload.close()


def test_rollback_failure_never_returns_proposed_success(monkeypatch):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    before = snapshot(db)
    db.rollback_failure = True
    try:
        with pytest.raises(p.SourceUnavailable):
            run(ctx, cmd, upload)
        assert db.rollbacks == [p._PreflightRolledBack]
        assert snapshot(db) == before and db.commits == 0
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_full_203_row_coverage_uses_real_index_without_raw_rescanning(monkeypatch):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db, payload_rows(203), library=None)
    reject_raw(monkeypatch)
    before = snapshot(db)
    observed = []
    real = p.preflight_indexed_foobar_window

    def inspect(*args, **kwargs):
        result = real(*args, **kwargs)
        observed.append(result)
        return result

    monkeypatch.setattr(p, 'preflight_indexed_foobar_window', inspect)
    try:
        result = run(ctx, cmd, upload)
        assert result.status == 'complete_preflight'
        assert (result.total_rows, result.checked_rows, result.remaining_rows) == (203, 203, 0)
        assert observed[0].offset == 0 and observed[-1].end == 203
        assert all(a.end == b.offset for a, b in zip(observed, observed[1:]))
        assert all(0 < w.end-w.offset <= 100 for w in observed)
        assert result.proposed_counts == (0, 203, 0, 0, 0, 0, 0)
        assert result.proposed_quota_additions[:2] == (203, 203)
        assert result.proposed_changed_batches == len(observed)
        assert len(db.rollbacks) == len(observed) >= 3
        assert snapshot(db) == before
        assert_no_business_sql(db)
    finally:
        upload.close()


@pytest.mark.parametrize('change', ['source', 'session', 'account', 'membership', 'inventory', 'quota'])
def test_current_changes_between_real_windows_stop(monkeypatch, change):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db, payload_rows(103))

    def mutate(owner):
        owner.after_rollback = None
        if change == 'source': owner.revision += 1
        elif change == 'session': owner.session_revoked = True
        elif change == 'account': owner.account_active = False
        elif change == 'membership': owner.membership = False
        elif change == 'inventory': owner.files[21] = '/changed.flac'
        else: owner.quota = (1, 1, 1)

    db.after_rollback = mutate
    try:
        with pytest.raises((p.SourceStale, p.SourceUnavailable)):
            run(ctx, cmd, upload)
        assert len(db.rollbacks) >= 2 and db.commits == 0
        assert db.receipt is None and not db.source_rows and not db.keys
        assert_no_business_sql(db)
    finally:
        upload.close()


@pytest.mark.parametrize('axis,limit', [(0, 100000), (1, 1000000), (2, 268435456)])
def test_cumulative_quota_rejects_even_when_each_real_window_fits(monkeypatch, axis, limit):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db, payload_rows(103), library=None)
    try:
        first = p.preflight_indexed_foobar_window('synthetic:no-network', ctx,
            upload=upload, command=cmd, intake_capacity=CAPACITY)
        tail = p.preflight_indexed_foobar_window('synthetic:no-network', ctx,
            upload=upload, command=replace(cmd, offset=first.end), intake_capacity=CAPACITY)
        baseline = [0, 0, 0]
        baseline[axis] = limit - max(first.quota_additions[axis], tail.quota_additions[axis])
        db.quota = tuple(baseline)
        for offset in (0, first.end):
            p.preflight_indexed_foobar_window('synthetic:no-network', ctx,
                upload=upload, command=replace(cmd, offset=offset), intake_capacity=CAPACITY)
        before = snapshot(db)
        with pytest.raises(p.SourceUnavailable):
            run(ctx, cmd, upload)
        assert snapshot(db) == before and db.commits == 0
        assert_no_business_sql(db)
    finally:
        upload.close()


@pytest.mark.parametrize('when', ['before', 'between', 'final'])
def test_cancellation_reports_only_checked_rows_and_never_complete(monkeypatch, when):
    db = install_real_owner(monkeypatch)
    n = 1 if when == 'final' else 103
    ctx, cmd, upload = open_upload(db, payload_rows(n), library=None)
    event = threading.Event()
    if when == 'before': event.set()
    else: db.after_rollback = lambda owner: event.set()
    try:
        result = run(ctx, cmd, upload, event)
        assert result.status == 'cancelled_preflight'
        assert result.checked_rows + result.remaining_rows == n
        assert sum(result.proposed_counts[:4]) == result.checked_rows
        if when == 'before': assert result.checked_rows == 0 and not db.rollbacks
        elif when == 'final': assert result.checked_rows == 1 and result.remaining_rows == 0
        else: assert 0 < result.checked_rows <= 100 and result.remaining_rows > 0
        assert db.commits == 0
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_late_malformed_row_cannot_produce_index_or_preflight_output(monkeypatch):
    db = install_real_owner(monkeypatch)
    payload = payload_rows(203) + b'bad\textra\n'
    before = snapshot(db)
    with pytest.raises(p.intake.FoobarPreparationRejected):
        open_upload(db, payload, library=None)
    assert snapshot(db) == before and not db.rollbacks and not db.commits
    assert_no_business_sql(db)


@pytest.mark.parametrize('mode', ['raise', 'closed', 'nonidle'])
def test_explicit_rollback_must_finish_open_and_idle_before_success(monkeypatch, mode):
    db = install_real_owner(monkeypatch)
    db.explicit_rollback_mode = mode
    ctx, cmd, upload = open_upload(db)
    before = snapshot(db)
    try:
        with pytest.raises(p.SourceUnavailable):
            run(ctx, cmd, upload)
        assert db.explicit_rollbacks == 1
        assert p._PreflightRolledBack not in db.rollbacks
        assert snapshot(db) == before and db.commits == 0
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_association_only_prediction_counts_changed_batch_but_zero_source_quota(monkeypatch):
    db = install_real_owner(monkeypatch)
    ctx, cmd, upload = open_upload(db, library=None)
    try:
        receipt = run_prepare(ctx, cmd, upload)
        apply(db, cmd, receipt)
    finally:
        upload.close()
    db.receipt = None  # Existing fixture models one current receipt, not history storage.
    db.tastes[21].update(rating=5, love_tier='off', rating_protected=True,
        favorite_protected=True, preference_id=51)
    ctx, cmd, upload = open_upload(db)
    before = snapshot(db)
    start = len(db.calls)
    try:
        result = run(ctx, cmd, upload)
        assert result.proposed_counts == (1, 0, 0, 0, 0, 0, 1)
        assert result.proposed_quota_additions == (0, 0, 0)
        assert result.proposed_changed_batches == 1
        assert snapshot(db) == before
        assert_no_business_sql(db, start)
    finally:
        upload.close()


def test_cumulative_revision_overflow_is_not_per_window_success(monkeypatch):
    db = install_real_owner(monkeypatch)
    db.revision = p.gate._MAX - 1
    ctx, cmd, upload = open_upload(db, payload_rows(103), library=None)
    before = snapshot(db)
    try:
        with pytest.raises(p.SourceUnavailable):
            run(ctx, cmd, upload)
        assert len(db.rollbacks) >= 2 and snapshot(db) == before
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_cross_window_duplicate_target_never_awards_first_window_taste(monkeypatch):
    db = install_real_owner(monkeypatch)
    header, row = PAYLOAD.split(b'\n', 1)
    payload = header + b'\n' + row + payload_rows(99).split(b'\n', 1)[1] + row
    ctx, cmd, upload = open_upload(db, payload)
    reject_raw(monkeypatch)
    try:
        result = run(ctx, cmd, upload)
        assert result.checked_rows == 101
        assert result.proposed_counts == (0, 101, 0, 0, 0, 0, 0)
        assert result.proposed_quota_additions[:2] == (101, 101)
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_original_parser_warnings_survive_complete_proposed_result(monkeypatch):
    db = install_real_owner(monkeypatch)
    payload = PAYLOAD.replace(b'\t4\t1\t19', b'\tnot-a-rating\t1\t19')
    ctx, cmd, upload = open_upload(db, payload)
    summary = upload._upload.terminal.summary
    try:
        result = run(ctx, cmd, upload)
        assert result.status == 'complete_preflight' and result.checked_rows == 1
        assert result.rows_with_field_errors == summary.rows_with_field_errors == 1
        assert result.field_error_count == summary.field_error_count > 0
        assert result.unsupported_nonempty_field_count == summary.unsupported_nonempty_field_count
        assert result.diagnostics_truncated == summary.diagnostics_truncated
        assert result.proposed_counts[4] == 0  # Invalid rating is not proposed as written.
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_genuine_private_byte_shrink_advances_exact_contiguous_prefix(monkeypatch):
    db = install_real_owner(monkeypatch)
    payload = b'path\ttitle\trating\tfavorite\tplay_count\n' + b''.join(
        ('/wide-%d.flac\t' % i).encode() + b'x' * 2048 + b'\t4\t1\t19\n'
        for i in range(103))
    ctx, cmd, upload = open_upload(db, payload, library=None)
    reject_raw(monkeypatch)
    before = snapshot(db)
    observed = []
    real = p.preflight_indexed_foobar_window

    def inspect(*args, **kwargs):
        result = real(*args, **kwargs)
        observed.append(result)
        return result

    monkeypatch.setattr(p, 'preflight_indexed_foobar_window', inspect)
    try:
        result = run(ctx, cmd, upload)
        assert result.status == 'complete_preflight' and result.checked_rows == 103
        assert observed[0].offset == 0 and observed[-1].end == 103
        assert p.MAX_PRIVATE_BYTES == 4 * 1024 * 1024
        assert 0 < observed[0].end < 100  # Actual byte sizing, not a canned short result.
        assert all(left.end == right.offset for left, right in zip(observed, observed[1:]))
        assert all(0 < window.end-window.offset <= 100 for window in observed)
        assert sum(window.end-window.offset for window in observed) == 103
        assert [row for window in observed for row in range(window.offset, window.end)] == list(range(103))
        assert len(observed) == result.planned_batches
        assert snapshot(db) == before and db.commits == 0
        assert result.proposed_counts == (0, 103, 0, 0, 0, 0, 0)
        assert_no_business_sql(db)
    finally:
        upload.close()



def test_single_oversized_row_cannot_fit_private_budget_or_mutate_state(monkeypatch):
    db = install_real_owner(monkeypatch)
    payload = (b'path\ttitle\trating\tfavorite\tplay_count\n'
        + b'/wide-0.flac\t' + b'x' * 8192 + b'\t4\t1\t19\n')
    ctx, cmd, upload = open_upload(db, payload, library=None)
    reject_raw(monkeypatch)
    before = snapshot(db)
    try:
        assert p.MAX_PRIVATE_BYTES == 4 * 1024 * 1024
        with pytest.raises(p.SourceUnavailable):
            run(ctx, cmd, upload)
        assert snapshot(db) == before and db.commits == 0
        assert db.receipt is None and not db.keys and not db.source_rows
        assert_no_business_sql(db)
    finally:
        upload.close()
