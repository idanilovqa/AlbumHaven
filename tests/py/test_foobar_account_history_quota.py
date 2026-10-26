"""AUTHORED ONLY. Genuine quota/planner/Prepare/Apply/worker owners, no SQL.

Driver quota values are explicitly synthetic. Exact compact bytes are produced
by the real codec from genuine prepared originals, never a copied formula codec.
"""
from copy import deepcopy
from dataclasses import replace
import json
import pytest
from tests.py.foobar_account_history_testing import (
    install, install_existing_genuine, prepare, writer, codec, p, a, f, URL, CAPACITY,
    SOURCE, requested_context, payload, materialize,
)
from tests.py.test_foobar_account_existing_chain import prepare as prepare_existing, apply as apply_existing
from tests.py.test_foobar_global_preflight import (
    install_real_owner, open_upload, run, payload_rows, snapshot, assert_no_business_sql,
)
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_service_readiness_testing import install_catalog

LIMIT = 268435456


def exact_projection_bytes(row, revision):
    return codec.encode_account_history_projection(codec.build_account_history_projection(
        effective_evidence_bytes=bytes.fromhex(row[7]), display_bytes=bytes.fromhex(row[8]), source_revision=revision))


def override_quota(monkeypatch, db, quota):
    original = db.dispatch
    def dispatch(sql, params):
        if sql == p._CAPACITY_SQL:
            return [dict(zip(('observation_count', 'revision_count', 'source_bytes'), quota))]
        return original(sql, params)
    monkeypatch.setattr(db, 'dispatch', dispatch)


def test_new_projection_is_in_shared_prepare_capacity_exactly_once(monkeypatch):
    db = install(monkeypatch)
    command, receipt = prepare(db, library=None, payload=payload(play_count=2))
    original = p.envelope._freeze(json.loads(db.receipt['prepared']))
    row = original[2][0]
    expected = sum(len(bytes.fromhex(row[i])) for i in (1, 6, 7, 8)) + len(exact_projection_bytes(row, 1))
    live = p.require_account_foobar(requested_context(None))
    current, added, peak = p._source_capacity_check(db, live, command=command,
        original_value=original, source_changes=(True,))
    assert current == (0, 0, 0) and added == (1, 1, expected) and peak == expected
    assert not db.history_projections and not db.source_rows  # Capacity never writes/backfills.


def test_signed_replacement_delta_and_noop_keep_current_bytes_not_append(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    old = payload(title='x' * 96, artist='y' * 48, album='z' * 48, play_count=19)
    unused, unused_receipt, unused_original, command = prepare_existing(db, old, 1)
    apply_existing(command)
    old_size = len(next(iter(db.history_projections.values()))['projection_bytes'])
    unused, unused_receipt, original, unused_apply = prepare_existing(db,
        payload(title='x', artist='y', album='z', play_count=2), 2)
    row = original[2][0]
    expected = len(exact_projection_bytes(row, 2)) - old_size
    assert expected < 0
    delta, peak = writer.projection_quota_delta_on_connection(db, account_id=1, source_ref=SOURCE,
        expected_revision=1, original_rows=original[2], source_changes=(True,))
    assert (delta, peak) == (expected, 0)
    before = deepcopy(db.history_projections); start = len(db.calls)
    assert writer.projection_quota_delta_on_connection(db, account_id=1, source_ref=SOURCE,
        expected_revision=1, original_rows=original[2], source_changes=(False,)) == (0, 0)
    assert writer._OLD_SIZE_SQL not in db.calls[start:] and db.history_projections == before


def test_real_maximum_stream_revision_noop_keeps_retained_projection_without_successor(monkeypatch):
    db = install_existing_genuine(monkeypatch)
    data = payload(play_count=2)
    unused, unused_receipt, unused_original, command = prepare_existing(db, data, 1)
    apply_existing(command)
    before = deepcopy((db.source_row, db.revisions, db.history_projections))
    db.revision = p.source.MAX_REVISION
    start = len(db.calls)
    unused, unused_receipt, unused_original, noop = prepare_existing(db, data, 2)
    result = apply_existing(noop)
    assert tuple(json.loads(result.terminal_bytes))[11:13] == (p.source.MAX_REVISION,) * 2
    assert db.revision == p.source.MAX_REVISION
    assert (db.source_row, db.revisions, db.history_projections) == before
    assert writer._UPSERT_SQL not in db.calls[start:]
    assert writer._OLD_SIZE_SQL not in db.calls[start:]
    assert writer._VERIFY_SQL in db.calls[start:]


def test_ordered_replacement_peak_is_not_just_final_net_delta(monkeypatch):
    new_db = install(monkeypatch)
    prepare(new_db, library=None, payload=payload(path='/second.flac', play_count=2))
    new_row = p.envelope._freeze(json.loads(new_db.receipt['prepared']))[2][0]
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, apply_command = prepare_existing(db,
        payload(title='x' * 96, artist='y' * 48, album='z' * 48, play_count=19), 1)
    apply_existing(apply_command)
    old_size = len(next(iter(db.history_projections.values()))['projection_bytes'])
    unused, unused_receipt, original, unused_apply = prepare_existing(db,
        payload(title='x', artist='y', album='z', play_count=2), 2)
    existing = original[2][0]
    assert new_row[2] != existing[2] and new_row[1] != existing[1]
    growth = len(exact_projection_bytes(new_row, 2))
    shrink = len(exact_projection_bytes(existing, 2)) - old_size
    assert growth > 0 and shrink < 0
    # Genuine prepared originals from independent snapshots exercise this scalar
    # owner's sequence contract; this is not a claimed two-row Apply receipt.
    delta, peak = writer.projection_quota_delta_on_connection(db, account_id=1, source_ref=SOURCE,
        expected_revision=1, original_rows=(new_row, existing), source_changes=(True, True))
    assert delta == growth + shrink and peak == growth and peak > delta
    reverse_delta, reverse_peak = writer.projection_quota_delta_on_connection(db, account_id=1, source_ref=SOURCE,
        expected_revision=1, original_rows=(existing, new_row), source_changes=(True, True))
    assert reverse_delta == delta and reverse_peak == max(0, delta) and reverse_peak < peak


@pytest.mark.parametrize('which', ['prepare', 'ready_replay', 'apply'])
def test_net_fit_but_raw_first_intermediate_peak_over_limit_is_typed_nonretryable(monkeypatch, which):
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, seed_command = prepare_existing(db,
        payload(title='x' * 96, artist='y' * 48, album='z' * 48, play_count=19), 1)
    apply_existing(seed_command)
    data = payload(title='x', artist='y', album='z', play_count=2)
    prepare_command, receipt, original, apply_command = prepare_existing(db, data, 2)
    row = original[2][0]
    old_size = len(next(iter(db.history_projections.values()))['projection_bytes'])
    new_size = len(exact_projection_bytes(row, 2))
    raw_added = sum(len(bytes.fromhex(row[i])) for i in (6, 7, 8))
    final_added = raw_added + new_size - old_size
    assert 0 < final_added < raw_added
    # Final bytes exactly fit, but the real write order first retains all raw
    # revisions and has not yet freed the replaced compact row's difference.
    override_quota(monkeypatch, db, (1, 1, LIMIT - final_added))
    before = deepcopy((db.source_row, db.revisions, db.history_projections, db.revision))
    start = len(db.calls)
    with pytest.raises(p.source.FoobarSourceCapacityExceeded) as failure:
        if which == 'apply': apply_existing(apply_command)
        elif which == 'ready_replay':
            p.prepare_foobar_import(URL, requested_context(None), payload=data,
                command=prepare_command, intake_capacity=CAPACITY)
        else:
            prepare_existing(db, data, 3)
    assert failure.value.code == 'foobar_source_quota_exceeded'
    assert failure.value.status_code == 409 and failure.value.retryable is False
    assert (db.source_row, db.revisions, db.history_projections, db.revision) == before
    assert writer._UPSERT_SQL not in db.calls[start:] and p.source._insert_revisions_sql() not in db.calls[start:]


@pytest.mark.parametrize('bad', ['missing', 'revision', 'digest', 'boolean_size', 'oversize', 'extra'])
def test_existing_quota_size_is_fenced_to_current_projection_and_source(monkeypatch, bad):
    db = install_existing_genuine(monkeypatch)
    unused, unused_receipt, unused_original, command = prepare_existing(db, payload(play_count=19), 1)
    apply_existing(command)
    unused, unused_receipt, original, unused_apply = prepare_existing(db, payload(play_count=2), 2)
    current = next(iter(db.history_projections.values()))
    row = dict(source_revision=1, projection_size=len(current['projection_bytes']),
        effective_evidence_sha256=current['effective_evidence_sha256'], display_sha256=current['display_sha256'],
        current_revision=1, current_effective_sha256=current['effective_evidence_sha256'], current_display_sha256=current['display_sha256'])
    if bad == 'missing': rows = []
    else:
        if bad == 'revision': row['current_revision'] = 2
        if bad == 'digest': row['current_effective_sha256'] = '0' * 64
        if bad == 'boolean_size': row['projection_size'] = True
        if bad == 'oversize': row['projection_size'] = 8193
        if bad == 'extra': row['extra'] = True
        rows = [row]
    db.history_override = rows
    with pytest.raises(p.SourceUnavailable):
        writer.projection_quota_delta_on_connection(db, account_id=1, source_ref=SOURCE,
            expected_revision=1, original_rows=original[2], source_changes=(True,))


@pytest.mark.parametrize('base_revision', [8, 98])
def test_genuine_global_preflight_counts_future_revision_digit_growth_across_real_windows(monkeypatch, base_revision):
    db = install_real_owner(monkeypatch); db.revision = base_revision
    context, command, upload = open_upload(db, payload_rows(203), library=None)
    windows = []
    actual = p._source_capacity_check
    def observe(connection, live, **kwargs):
        result = actual(connection, live, **kwargs)
        windows.append((kwargs['original_value'][2], kwargs['source_changes'], result))
        return result
    monkeypatch.setattr(p, '_source_capacity_check', observe)
    before = snapshot(db)
    try:
        result = run(context, command, upload)
        assert result.status == 'complete_preflight' and result.checked_rows == 203
        assert result.planned_batches == len(windows) >= 3
        expected = 0
        for offset, (rows, changes, quota) in enumerate(windows):
            assert all(changes)
            revision = base_revision + offset + 1
            expected += sum(sum(len(bytes.fromhex(row[i])) for i in (1, 6, 7, 8))
                + len(exact_projection_bytes(row, revision)) for row in rows)
        assert result.proposed_quota_additions == (203, 203, expected)
        dry_run_sum = sum(quota[1][2] for rows, changes, quota in windows)
        # First window is revision 9/99; all subsequent actual writes use an
        # additional decimal digit despite dry-run snapshots staying unchanged.
        assert expected - dry_run_sum == sum(len(rows) for rows, changes, quota in windows[1:])
        assert snapshot(db) == before and not db.history_projections
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_genuine_global_preflight_rejects_cumulative_quota_after_individual_windows_fit(monkeypatch):
    db = install_real_owner(monkeypatch)
    context, command, upload = open_upload(db, payload_rows(203), library=None)
    try:
        planned = run(context, command, upload)
        db.quota = (0, 0, LIMIT - planned.proposed_quota_additions[2] + 1)
        before = snapshot(db)
        with pytest.raises(p.source.FoobarSourceCapacityExceeded): run(context, command, upload)
        assert snapshot(db) == before and not db.history_projections
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_revision_overflow_in_future_real_windows_cannot_wrap_codec_revision(monkeypatch):
    db = install_real_owner(monkeypatch); db.revision = 9223372036854775806
    context, command, upload = open_upload(db, payload_rows(203), library=None)
    before = snapshot(db)
    try:
        with pytest.raises(p.SourceUnavailable): run(context, command, upload)
        assert snapshot(db) == before and not db.history_projections
        assert_no_business_sql(db)
    finally:
        upload.close()


def test_real_service_quota_refusal_is_not_reconciled_or_retried(monkeypatch):
    db = install(monkeypatch); install_catalog(monkeypatch)
    override_quota(monkeypatch, db, (0, 0, LIMIT))
    actual_reconcile, reconciliations = s.reconcile_foobar_attempt, []
    def observe_reconcile(*args, **kwargs):
        reconciliations.append((args, kwargs))
        return actual_reconcile(*args, **kwargs)
    monkeypatch.setattr(s, 'reconcile_foobar_attempt', observe_reconcile)
    handle, = handles(monkeypatch)
    data = payload(play_count=2)
    from tests.py.foobar_account_associations_v3_testing import make_command
    command = make_command(db, library=None, payload=data)
    ticket = handle.begin_prepare(context=requested_context(None), constraints=s.PolicyEvaluationConstraints(),
        command=command, length=len(data))
    handle.append_prepare(ticket, data); handle.finish_prepare(ticket)
    operation = handle.owner.current; operation.stage = s._Stage.RUNNING
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.SOURCE_CAPACITY
    assert operation.delivery.receipt is None and handle.owner.next_ticket == 2
    assert db.calls.count(p._CAPACITY_SQL) == 1
    assert reconciliations == []  # Observational wrapper never replaces a result.
    assert not db.source_rows and not db.history_projections and db.receipt is None


def test_real_job_quota_failure_preserves_confirmed_prefix_and_does_not_retry(monkeypatch):
    from tests.py.foobar_account_job_worker_testing import running, command, submit, settled
    from tests.py.foobar_account_import_jobs_testing import payload_rows as job_payload
    with running(monkeypatch) as (db, handle, catalog):
        original = db.dispatch
        quota_calls = []
        def constrained(sql, params):
            if sql == p._CAPACITY_SQL and db.revision > 0:
                quota_calls.append(db.revision)
                return [dict(observation_count=len(db.source_rows), revision_count=len(db.source_rows), source_bytes=LIMIT)]
            return original(sql, params)
        monkeypatch.setattr(db, 'dispatch', constrained)
        data = job_payload(103)
        cmd, inventory = command(db, data, 103)
        submit(handle, cmd, inventory, data)
        result = settled(handle)
        assert result.phase == 'needs_preflight' and result.error == 'foobar_source_quota_exceeded'
        assert result.uncertain is False and result.status is not None
        confirmed = result.status.confirmed_through
        assert 0 < confirmed < 103 and result.status.confirmed_counts == (0, confirmed, 0, 0, 0, 0, 0)
        assert len(db.source_rows) == len(db.history_projections) == confirmed
        assert db.revision == 1 and db.calls.count(f._COMMIT_SQL) == 1
        assert len(quota_calls) == 1  # Typed quota refusal is not an availability retry.
        assert handle.owner.next_ticket == 3  # One real review and one real job, no per-window queue.
