"""Authored, not executed. Genuine repository + automatic Prepare/Apply hooks.

All result/state injections are at the SQL/pooled-connection boundary. No job
hook, terminal codec, protocol result, resolver, or successful flag is mocked.
"""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
from uuid import uuid4
import json

import pytest

from tests.py.foobar_account_import_jobs_testing import (
    install, start, status, claim, prepare, apply, reconcile, resume, cancel,
    row, snapshot, payload_rows, jobs, readiness, account_authority, authority,
    p, a, f, associations, indexed, make_command, requested_context,
    PAYLOAD, CAPACITY, SOURCE, OTHER_SOURCE, GEN, JOB, URL, JOB_FIELDS,
    ATTEMPT_FIELDS, COUNTERS,
)
from tests.py.test_foobar_indexed_prepare_integration import reject_raw


def test_stable_claim_reconstructs_original_keys_digests_scope_and_actual_locks(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    try:
        first = deepcopy(row(db, cmd, batch))
        same = claim(ctx, cmd, batch.prepare_command.inventory_sha256)
        assert same == batch and row(db, cmd, batch) == first
        current = status(ctx, cmd)
        assert (current.source_revision, current.current_generation) == (0, GEN)
        assert current.confirmed_counts == (0,) * 7
        assert current.current_batch == batch and current.disposition == 'claimed'
        assert first['prepare_key'] == batch.prepare_command.request_key
        assert first['prepare_key'] != first['apply_key']
        assert first['original_session_id'] == ctx.actor.session_id
        assert batch.prepare_command.matching_library_id == 7
        assert batch.prepare_command.upload_sha256 == cmd.upload_sha256
        assert first['prepare_command_sha256'] == p.gate.prepare_command_digest(
            batch.prepare_command, account_id=1, library_id=7, session_id=3)
        account_lock = db.calls.index('select id,is_active,disabled_at from app.accounts where id=%s for update')
        session_lock = next(i for i, sql in enumerate(db.calls) if 'from app.account_sessions' in sql)
        source_lock = db.calls.index(p.gate._LOCK_SQL)
        job_lock = db.calls.index(jobs._JOB_SQL)
        assert account_lock < session_lock < source_lock < job_lock
        assert jobs.current_foobar_account_transaction is account_authority.current_foobar_account_transaction
        assert p.current_foobar_import_transaction is authority.current_foobar_import_transaction
    finally:
        upload.close()


def test_genuine_short_prefixes_are_contiguous_and_totals_come_from_real_terminals(monkeypatch):
    db = install(monkeypatch)
    # Retain a real byte-limited short prefix; the separate8192-byte case
    # below proves no-fit rejection under the unchanged4MiB ceiling.
    payload = payload_rows(103, wide=True).replace(b'x' * 8192, b'x' * 2048)
    ctx, cmd, batch, upload = start(db, payload=payload)
    reject_raw(monkeypatch)
    windows, terminals, originals = [], [], []
    try:
        while True:
            original = batch.prepare_command
            receipt = prepare(ctx, batch, upload)
            ready = status(ctx, cmd).current_batch
            assert ready.state == 'ready' and ready.prepare_command == original
            assert receipt.window_start == original.offset + 1
            assert ready.window_end == receipt.window_end
            terminal = apply(ctx, ready)
            result = reconcile(ctx, cmd, ready)
            assert result.disposition == 'confirmed'
            assert result.batch.terminal_bytes == terminal.terminal_bytes
            windows.append((receipt.window_start, receipt.window_end))
            terminals.append(tuple(json.loads(terminal.terminal_bytes)[16:23]))
            originals.append((original, ready.apply_command))
            current = result.status
            assert current.confirmed_through == receipt.window_end - 1
            assert current.next_batch_no == ready.batch_no + 1
            assert current.confirmed_counts == tuple(map(sum, zip(*terminals)))
            if current.disposition == 'completed': break
            batch = claim(ctx, cmd, original.inventory_sha256)
            assert batch.prepare_command.offset == receipt.window_end - 1
            assert batch.batch_no == ready.batch_no + 1 and batch.attempt_no == 1
            assert batch.prepare_command.expected_revision == current.source_revision
            assert batch.prepare_command.upload_sha256 == cmd.upload_sha256
        assert 1 < windows[0][1] < 101  # Genuine private-byte admission, no canned prefix.
        assert windows[0][0] == 1 and windows[-1][1] == 104
        assert all(left[1] == right[0] for left, right in zip(windows, windows[1:]))
        assert all(0 < end - begin <= 100 for begin, end in windows)
        assert current.confirmed_counts == (0, 103, 0, 0, 0, 0, 0)
        assert len({pc.request_key for pc, ac in originals}) == len(windows)
        assert len({ac.request_key for pc, ac in originals}) == len(windows)
        assert len(db.source_rows) == 103 and len(db.attempts) == len(windows)
        assert db.calls.count(p._INSERT_READY_SQL) == db.calls.count(f._COMMIT_SQL) == len(windows)
    finally:
        upload.close()


def test_real_ready_and_confirmed_checkpoint_exist_before_outer_commit(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    observed = []

    def inspect(owner):
        attempt = row(owner, cmd, batch)
        if owner.receipt is not None:
            if owner.receipt['state'] == 'ready':
                assert attempt['state'] == 'ready'
                assert attempt['receipt_ref'] == owner.receipt['receipt_ref']
            else:
                assert attempt['state'] == 'confirmed'
                assert attempt['terminal_bytes'] == owner.receipt['terminal']
                job = owner.job_rows[(1, SOURCE, JOB)]
                assert job['confirmed_through'] == attempt['window_end'] - 1
                assert tuple(job[k] for k in COUNTERS) == tuple(json.loads(owner.receipt['terminal'])[16:23])
            observed.append(owner.receipt['state'])

    db.before_commit = inspect
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        apply(ctx, ready)
        assert 'ready' in observed and observed[-1] == 'committed'
        assert row(db, cmd, batch)['state'] == 'confirmed'
    finally:
        upload.close()


@pytest.mark.parametrize('failure', ['ready', 'confirm', 'advance'])
def test_checkpoint_failure_rolls_back_actual_same_transaction_effects(monkeypatch, failure):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    try:
        if failure != 'ready':
            prepare(ctx, batch, upload)
            batch = status(ctx, cmd).current_batch
        before = snapshot(db)
        commits = db.commits
        db.fail_sql = {'ready': jobs._READY_SQL, 'confirm': jobs._CONFIRM_SQL,
                       'advance': jobs._JOB_CAS_SQL}[failure]
        with pytest.raises(p.SourceUnavailable):
            if failure == 'ready': prepare(ctx, batch, upload)
            else: apply(ctx, batch)
        assert snapshot(db) == before and db.commits == commits
        assert row(db, cmd, batch)['state'] == ('claimed' if failure == 'ready' else 'ready')
        assert not db.source_rows and not db.history and not db.bindings
        assert all(t['rating'] is None and t['love_tier'] == 'off' for t in db.tastes.values())
        assert row(db, cmd, batch)['terminal_bytes'] is None
    finally:
        upload.close()


def test_lost_prepare_ack_retries_exact_claim_without_new_key_or_receipt(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        db.lose_ack = True
        with pytest.raises(p.SourceUnavailable): prepare(ctx, batch, upload)
        persisted = status(ctx, cmd).current_batch
        assert persisted.state == 'ready'
        assert persisted.prepare_command == batch.prepare_command
        assert claim(ctx, cmd, batch.prepare_command.inventory_sha256) == persisted
        recovered = prepare(ctx, batch, upload)
        assert recovered.receipt_ref == persisted.apply_command.receipt_ref
        assert len(db.receipts) == len(db.attempts) == 1
        assert db.calls.count(p._INSERT_READY_SQL) == 1
        assert status(ctx, cmd).confirmed_through == 0
    finally:
        upload.close()


def test_lost_apply_ack_reconciles_and_replays_without_duplicate_effects(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        db.lose_ack = True
        with pytest.raises(a.FoobarApplyCommitUncertain): apply(ctx, ready)
        settled = reconcile(ctx, cmd, ready)
        assert settled.disposition == 'confirmed'
        terminal = settled.batch.terminal_bytes
        before = snapshot(db)
        replay = apply(ctx, ready)
        assert replay.terminal_bytes == terminal and snapshot(db) == before
        assert db.calls.count(f._COMMIT_SQL) == 1
        assert db.calls.count(jobs._CONFIRM_SQL) == 1
        assert len(db.source_rows) == len(db.history) == len(db.bindings) == 1
        assert settled.status.confirmed_counts == tuple(json.loads(terminal)[16:23])
    finally:
        upload.close()


def test_generic_apply_cannot_evade_assigned_key_with_same_job_receipt(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        before = snapshot(db)
        different = replace(ready.apply_command, request_key=str(uuid4()))
        with pytest.raises(p.SourceStale):
            a.apply_foobar_import(URL, ctx, command=different, intake_capacity=CAPACITY)
        assert snapshot(db) == before
        assert jobs._FIND_APPLY_SQL in db.calls and f._COMMIT_SQL not in db.calls
        assert jobs._CONFIRM_SQL not in db.calls and not db.source_rows
    finally:
        upload.close()


@pytest.mark.parametrize('field,value', [
    ('matching_library_id', 8), ('expected_revision', 1), ('inventory_sha256', 'e' * 64),
    ('upload_sha256', 'd' * 64), ('offset', 1),
])
def test_same_prepare_key_cannot_change_original_command_scope(monkeypatch, field, value):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7, payload=payload_rows(2))
    try:
        changed = replace(batch.prepare_command, **{field: value})
        before = snapshot(db)
        with pytest.raises((p.SourceStale, p.gate.PrepareInvalid)):
            p.prepare_foobar_import(URL, ctx, payload=payload_rows(2),
                command=changed, intake_capacity=CAPACITY)
        assert snapshot(db) == before and not db.receipts
    finally:
        upload.close()


@pytest.mark.parametrize('field,value', [
    ('upload_sha256', 'a' * 64), ('original_matching_library_id', 7),
    ('original_generation', GEN + 1), ('total_rows', 2),
])
def test_same_job_identity_rejects_changed_interpretation(monkeypatch, field, value):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        before = snapshot(db)
        with pytest.raises(p.SourceStale):
            jobs.start_foobar_import_job(URL, ctx, command=replace(cmd, **{field: value}))
        assert snapshot(db) == before
    finally:
        upload.close()


def test_duplicate_key_claimed_by_two_jobs_fails_closed_at_actual_discovery(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        other = str(uuid4())
        db.job_rows[(1, SOURCE, other)] = dict(db.job_rows[(1, SOURCE, JOB)], job_ref=other)
        db.attempts[(1, SOURCE, other, 1, 1)] = deepcopy(row(db, cmd, batch))
        before = snapshot(db)
        with pytest.raises(p.SourceUnavailable): prepare(ctx, batch, upload)
        assert snapshot(db) == before and p._INSERT_READY_SQL not in db.calls
        # Deliberate malformed driver rows, not a claim that PostgreSQL permits
        # duplicate key constraints. Repository must reject multiplicity too.
    finally:
        upload.close()


@pytest.mark.parametrize('operation', ['status', 'claim', 'cancel', 'resume', 'reconcile'])
@pytest.mark.parametrize('axis', ['account', 'source'])
def test_job_status_and_mutations_are_account_source_scoped(monkeypatch, operation, axis):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        other_ctx = replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5), target_account_id=2)
        selected = other_ctx if axis == 'account' else ctx
        selected_cmd = cmd if axis == 'account' else replace(cmd, source_ref=OTHER_SOURCE)
        before = snapshot(db)
        with pytest.raises((p.SourceStale, p.SourceUnavailable)):
            if operation == 'status': status(selected, selected_cmd)
            elif operation == 'claim': claim(selected, selected_cmd, batch.prepare_command.inventory_sha256)
            elif operation == 'cancel': cancel(selected, selected_cmd)
            elif operation == 'resume': resume(selected, selected_cmd)
            else: reconcile(selected, selected_cmd, batch)
        assert snapshot(db) == before
    finally:
        upload.close()


@pytest.mark.parametrize('change', ['revision', 'generation'])
def test_claim_never_silently_refreshes_stale_preflight_fence(monkeypatch, change):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        if change == 'revision': db.revision += 1
        else: db.current_generation += 1
        before = snapshot(db)
        with pytest.raises(p.SourceStale):
            jobs.claim_next_foobar_job_batch(URL, ctx, source_ref=SOURCE, job_ref=JOB,
                inventory_sha256=batch.prepare_command.inventory_sha256,
                expected_revision=0, expected_generation=GEN)
        assert snapshot(db) == before and len(db.attempts) == 1
    finally:
        upload.close()


@pytest.mark.parametrize('ready', [False, True])
def test_cancel_lock_failure_is_not_success_then_fence_denies_fresh_work(monkeypatch, ready):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        if ready:
            prepare(ctx, batch, upload)
            batch = status(ctx, cmd).current_batch
        before = snapshot(db)
        db.fail_sql = p.gate._LOCK_SQL
        start_calls = len(db.calls)
        with pytest.raises((OSError, p.SourceUnavailable)): cancel(ctx, cmd)
        assert jobs._JOB_CAS_SQL not in db.calls[start_calls:] and snapshot(db) == before
        db.fail_sql = None
        cancelled = cancel(ctx, cmd)
        assert cancelled.cancel_requested and cancelled.confirmed_through == 0
        assert cancelled.disposition == 'cancelled'
        with pytest.raises(p.SourceStale): claim(ctx, cmd, batch.prepare_command.inventory_sha256)
        with pytest.raises(p.SourceStale): prepare(ctx, batch, upload)
        if ready:
            with pytest.raises(p.SourceStale): apply(ctx, batch)
        assert not db.source_rows and len(db.attempts) == 1
    finally:
        upload.close()


def test_current_session_resume_fences_ready_without_impersonating_original_session(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    second_upload = None
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        original = deepcopy(row(db, cmd, batch))
        current = replace(ctx, actor=replace(ctx.actor, session_id=4))
        assert status(current, cmd).disposition == 'needs_resume'
        with pytest.raises(p.SourceStale): apply(current, ready)
        with pytest.raises(p.SourceStale):
            p.prepare_foobar_import(URL, current, payload=PAYLOAD,
                command=batch.prepare_command, intake_capacity=CAPACITY)
        assert reconcile(current, cmd, ready).disposition == 'ready'
        assert row(db, cmd, batch) == original
        resumed = resume(current, cmd)
        assert resumed.disposition == 'needs_file' and resumed.confirmed_through == 0
        assert row(db, cmd, batch)['state'] == 'discarded'
        key = db.keys[original['prepare_key']]
        assert key['state'] == 'tombstone' and key['receipt_ref'] is None
        assert key['original_receipt_ref'] == original['receipt_ref']
        assert key['command_sha256'] == original['prepare_command_sha256']
        assert original['receipt_ref'] not in db.receipts
        replacement = claim(current, cmd, batch.prepare_command.inventory_sha256)
        assert replacement.batch_no == batch.batch_no and replacement.attempt_no == 2
        assert replacement.original_session_id == 4
        assert replacement.prepare_command.request_key != original['prepare_key']
        assert row(db, cmd, batch)['original_session_id'] == 3
        second_upload = indexed.open_account_indexed_upload(current, payload=PAYLOAD,
            command=replacement.prepare_command, intake_capacity=CAPACITY)
        prepare(current, replacement, second_upload)
        apply(current, status(current, cmd).current_batch)
        assert status(current, cmd).confirmed_through == 1
        assert db.calls.count(f._COMMIT_SQL) == 1
    finally:
        if second_upload is not None: second_upload.close()
        upload.close()


@pytest.mark.parametrize('retained_key', [False, True])
def test_missing_ready_receipt_is_unresolved_even_after_expiry(monkeypatch, retained_key):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        db.now += timedelta(days=8)
        db.receipts.clear()
        db.receipt = None
        if not retained_key:
            db.keys.clear()
            db.key_scopes.clear()
        before = snapshot(db)
        uncertain = reconcile(ctx, cmd, ready)
        assert uncertain.disposition == 'unresolved'
        assert uncertain.status.confirmed_through == 0
        assert uncertain.batch.state == 'ready' and uncertain.batch.terminal_bytes is None
        with pytest.raises(jobs.FoobarJobUnresolved): resume(ctx, cmd)
        assert snapshot(db) == before
        assert jobs._DISCARD_SQL not in db.calls and jobs._DELETE_READY_SQL not in db.calls
    finally:
        upload.close()


def test_claimed_missing_receipt_retired_generation_cannot_be_replaced(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        db.retired_through = GEN
        db.current_generation = GEN + 1
        before = snapshot(db)
        assert reconcile(ctx, cmd, batch).disposition == 'unresolved'
        with pytest.raises(jobs.FoobarJobUnresolved): resume(ctx, cmd)
        assert snapshot(db) == before and len(db.attempts) == 1
    finally:
        upload.close()


def test_cached_confirmed_proof_survives_receipt_expiry_and_library_loss(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, library=7)
    try:
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        terminal = apply(ctx, ready).terminal_bytes
        db.receipts.clear()
        db.receipt = None
        db.keys.clear()
        db.key_scopes.clear()
        db.now += timedelta(days=8)
        db.membership = False
        current = replace(ctx, actor=replace(ctx.actor, session_id=4))
        first = len(db.calls)
        before = snapshot(db)
        result = reconcile(current, cmd, ready)
        assert result.disposition == 'confirmed' and result.batch.terminal_bytes == terminal
        assert result.status.disposition == 'completed'
        assert result.status.confirmed_counts == tuple(json.loads(terminal)[16:23])
        assert resume(current, cmd).disposition == 'completed'
        assert snapshot(db) == before
        assert jobs._RECEIPT_SQL not in db.calls[first:]
        assert jobs._DELETE_READY_SQL not in db.calls[first:]
        assert not any(sql in db.native_calls for sql in db.calls[first:])
    finally:
        upload.close()


def test_confirmed_prefix_and_totals_survive_a_later_batch_rollback(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, first, upload = start(db, payload=payload_rows(103))
    try:
        prepare(ctx, first, upload)
        ready = status(ctx, cmd).current_batch
        terminal = apply(ctx, ready).terminal_bytes
        prefix = status(ctx, cmd)
        assert 0 < prefix.confirmed_through < cmd.total_rows
        second = claim(ctx, cmd, first.prepare_command.inventory_sha256)
        prepare(ctx, second, upload)
        second = status(ctx, cmd).current_batch
        before = snapshot(db)
        db.fail_sql = jobs._CONFIRM_SQL
        with pytest.raises(p.SourceUnavailable): apply(ctx, second)
        assert snapshot(db) == before
        db.fail_sql = None
        current = status(ctx, cmd)
        assert current.confirmed_through == prefix.confirmed_through
        assert current.confirmed_counts == prefix.confirmed_counts
        assert reconcile(ctx, cmd, first).batch.terminal_bytes == terminal
        assert row(db, cmd, second)['state'] == 'ready'
        assert len(db.source_rows) == prefix.confirmed_through
    finally:
        upload.close()


@pytest.mark.parametrize('bad_schema', [[], [{'structural_ready': False}],
    [{'structural_ready': 1}], [{'structural_ready': None}],
    [{'structural_ready': True, 'extra': True}],
    [{'structural_ready': True}, {'structural_ready': True}]])
@pytest.mark.parametrize('entry', ['job', 'ordinary_prepare', 'ordinary_apply'])
def test_absent_partial_or_malformed_schema_never_falls_back(monkeypatch, bad_schema, entry):
    db = install(monkeypatch)
    ctx = requested_context(None)
    upload = None
    try:
        if entry == 'ordinary_apply':
            seed = make_command(db, library=None)
            receipt = p.prepare_foobar_import(URL, ctx, payload=PAYLOAD,
                command=seed, intake_capacity=CAPACITY)
            command = a.apply_command.FoobarApplyCommand(SOURCE, GEN, str(uuid4()),
                receipt.receipt_ref, receipt.decision_sha256, None)
        db.schema = bad_schema
        before = snapshot(db)
        if entry == 'job':
            command = jobs.FoobarJobCommand(SOURCE, JOB, sha256(PAYLOAD).hexdigest(),
                p.parser._VERSION, p.gate.MAPPING, None, GEN, 1)
        with pytest.raises(p.SourceUnavailable):
            if entry == 'job': jobs.start_foobar_import_job(URL, ctx, command=command)
            elif entry == 'ordinary_prepare':
                p.prepare_foobar_import(URL, ctx, payload=PAYLOAD,
                    command=make_command(db, library=None), intake_capacity=CAPACITY)
            else: a.apply_foobar_import(URL, ctx, command=command, intake_capacity=CAPACITY)
        assert snapshot(db) == before and readiness._SCHEMA_SQL in db.calls
        assert not db.source_rows
    finally:
        if upload is not None: upload.close()


def test_durable_metadata_has_no_payload_path_upload_locator_or_caller_success_flag(monkeypatch):
    db = install(monkeypatch)
    payload = PAYLOAD.replace(b'Synthetic', b'PRIVATE RAW TITLE NOT DURABLE')
    ctx, cmd, batch, upload = start(db, payload=payload)
    try:
        prepare(ctx, batch, upload)
        apply(ctx, status(ctx, cmd).current_batch)
        assert set(db.job_rows[(1, SOURCE, JOB)]) == set(JOB_FIELDS)
        assert set(row(db, cmd, batch)) == set(ATTEMPT_FIELDS)
        metadata = repr((db.job_rows, db.attempts, db.job_frames))
        assert 'PRIVATE RAW TITLE NOT DURABLE' not in metadata
        assert '/synthetic.flac' not in metadata
        for forbidden in ('raw_payload', 'upload_bytes', 'payload_bytes', 'upload_path',
                          'upload_url', 'object_storage_key', 'success', 'committed_ok'):
            assert forbidden not in metadata
        assert row(db, cmd, batch)['terminal_bytes'] == db.receipt['terminal']
    finally:
        upload.close()


@pytest.mark.parametrize('corrupt', ['hash', 'body', 'counts', 'binding'])
def test_durable_confirmation_corruption_cannot_be_called_confirmed(monkeypatch, corrupt):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        prepare(ctx, batch, upload)
        apply(ctx, status(ctx, cmd).current_batch)
        attempt = row(db, cmd, batch)
        if corrupt == 'hash': attempt['terminal_sha256'] = '0' * 64
        elif corrupt == 'body':
            attempt['terminal_bytes'] = b'[]'
            attempt['terminal_sha256'] = sha256(b'[]').hexdigest()
        elif corrupt == 'counts': db.job_rows[(1, SOURCE, JOB)]['source_only_count'] = 0
        else: attempt['prepare_command_sha256'] = 'e' * 64
        before = snapshot(db)
        with pytest.raises(p.SourceUnavailable): reconcile(ctx, cmd, batch)
        assert snapshot(db) == before
    finally:
        upload.close()


def test_generic_prepare_cannot_consume_reserved_apply_key(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        reserved = row(db, cmd, batch)['apply_key']
        foreign = replace(batch.prepare_command, request_key=reserved)
        before = snapshot(db)
        with pytest.raises(p.SourceStale):
            p.prepare_foobar_import(URL, ctx, payload=PAYLOAD,
                command=foreign, intake_capacity=CAPACITY)
        assert snapshot(db) == before and p._INSERT_READY_SQL not in db.calls
    finally:
        upload.close()


@pytest.mark.parametrize('key_field', ['prepare_key', 'apply_key'])
def test_generic_apply_cannot_use_reserved_key_on_unrelated_receipt(monkeypatch, key_field):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        ordinary = make_command(db, library=None)
        receipt = p.prepare_foobar_import(URL, ctx, payload=PAYLOAD,
            command=ordinary, intake_capacity=CAPACITY)
        reserved = row(db, cmd, batch)[key_field]
        foreign = a.apply_command.FoobarApplyCommand(SOURCE, GEN, reserved,
            receipt.receipt_ref, receipt.decision_sha256, None)
        before = snapshot(db)
        with pytest.raises(p.SourceStale):
            a.apply_foobar_import(URL, ctx, command=foreign, intake_capacity=CAPACITY)
        assert snapshot(db) == before and f._COMMIT_SQL not in db.calls
        assert row(db, cmd, batch)['state'] == 'claimed'
    finally:
        upload.close()


@pytest.mark.parametrize('reserved_index', [0, 1])
@pytest.mark.parametrize('existing_operation', ['prepare', 'apply'])
def test_new_claim_rejects_preexisting_ordinary_request_key_of_either_kind(
        monkeypatch, reserved_index, existing_operation):
    db = install(monkeypatch)
    ctx = requested_context(None)
    reserved = jobs._keys(JOB, 1, 1)[reserved_index]
    ordinary = make_command(db, library=None)
    if existing_operation == 'prepare': ordinary = replace(ordinary, request_key=reserved)
    receipt = p.prepare_foobar_import(URL, ctx, payload=PAYLOAD,
        command=ordinary, intake_capacity=CAPACITY)
    if existing_operation == 'apply':
        ordinary_apply = a.apply_command.FoobarApplyCommand(SOURCE, GEN, reserved,
            receipt.receipt_ref, receipt.decision_sha256, None)
        a.apply_foobar_import(URL, ctx, command=ordinary_apply, intake_capacity=CAPACITY)
    cmd = jobs.FoobarJobCommand(SOURCE, JOB, ordinary.upload_sha256,
        p.parser._VERSION, p.gate.MAPPING, None, GEN, 1)
    jobs.start_foobar_import_job(URL, ctx, command=cmd)
    before = snapshot(db)
    with pytest.raises(p.SourceStale):
        jobs.claim_next_foobar_job_batch(URL, ctx, source_ref=SOURCE, job_ref=JOB,
            inventory_sha256=ordinary.inventory_sha256,
            expected_revision=db.revision, expected_generation=GEN)
    assert snapshot(db) == before and not db.attempts
    assert jobs._COLLISION_SQL in db.calls


@pytest.mark.parametrize('candidate_index', [0, 1])
@pytest.mark.parametrize('existing_field', ['prepare_key', 'apply_key'])
def test_new_claim_rejects_key_reserved_in_other_job_either_column(
        monkeypatch, candidate_index, existing_field):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        other_job = str(uuid4())
        other_cmd = replace(cmd, job_ref=other_job)
        jobs.start_foobar_import_job(URL, ctx, command=other_cmd)
        candidate_key = jobs._keys(other_job, 1, 1)[candidate_index]
        # Model an already retained cross-kind key at the driver boundary.
        # Discovery validates full rows; collision checking must reject before
        # reading/reinterpreting the other job's command or writing a new claim.
        row(db, cmd, batch)[existing_field] = candidate_key
        before = snapshot(db)
        with pytest.raises(p.SourceStale):
            jobs.claim_next_foobar_job_batch(URL, ctx, source_ref=SOURCE,
                job_ref=other_job, inventory_sha256=batch.prepare_command.inventory_sha256,
                expected_revision=0, expected_generation=GEN)
        assert snapshot(db) == before and len(db.attempts) == 1
    finally:
        upload.close()


def test_ready_tombstone_and_delete_are_atomic_on_discard_failure(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        prepare(ctx, batch, upload)
        original = deepcopy(row(db, cmd, batch))
        before = snapshot(db)
        db.fail_sql = jobs._DELETE_READY_SQL
        with pytest.raises((OSError, p.SourceUnavailable)): resume(ctx, cmd)
        assert snapshot(db) == before
        assert db.keys[original['prepare_key']]['state'] == 'active'
        assert original['receipt_ref'] in db.receipts
        assert row(db, cmd, batch)['state'] == 'ready'
    finally:
        upload.close()


def test_cancel_then_explicit_resume_preserves_confirmed_prefix_counts_and_proof(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, first, upload = start(db, payload=payload_rows(103))
    try:
        prepare(ctx, first, upload)
        terminal = apply(ctx, status(ctx, cmd).current_batch).terminal_bytes
        confirmed = status(ctx, cmd)
        second = claim(ctx, cmd, first.prepare_command.inventory_sha256)
        prepare(ctx, second, upload)
        second = status(ctx, cmd).current_batch
        cancelled = cancel(ctx, cmd)
        assert cancelled.cancel_requested and cancelled.confirmed_counts == confirmed.confirmed_counts
        assert cancelled.confirmed_through == confirmed.confirmed_through
        resumed = resume(ctx, cmd)
        assert not resumed.cancel_requested and resumed.disposition == 'needs_file'
        assert resumed.confirmed_through == confirmed.confirmed_through
        assert resumed.confirmed_counts == confirmed.confirmed_counts
        assert row(db, cmd, first)['terminal_bytes'] == terminal
        assert row(db, cmd, first)['state'] == 'confirmed'
        assert row(db, cmd, second)['state'] == 'discarded'
        assert second.apply_command.receipt_ref not in db.receipts
        assert first.prepare_command.request_key in db.keys
        assert db.keys[first.prepare_command.request_key]['state'] == 'active'
        replacement = claim(ctx, cmd, first.prepare_command.inventory_sha256)
        assert replacement.batch_no == second.batch_no and replacement.attempt_no == 2
        assert replacement.prepare_command.offset == confirmed.confirmed_through
    finally:
        upload.close()


@pytest.mark.parametrize('change', ['inactive_account', 'revoked_session', 'missing_current_session'])
def test_historical_job_session_does_not_replace_current_authenticated_authority(monkeypatch, change):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        current = replace(ctx, actor=replace(ctx.actor, session_id=4))
        if change == 'inactive_account': db.accounts[1] = False
        elif change == 'revoked_session': db.sessions[(1, 4)] = False
        else: del db.sessions[(1, 4)]
        before = snapshot(db)
        first = len(db.calls)
        with pytest.raises(p.SourceStale): reconcile(current, cmd, batch)
        assert snapshot(db) == before
        assert jobs._JOB_SQL not in db.calls[first:] and p.gate._LOCK_SQL not in db.calls[first:]
    finally:
        upload.close()


def test_cached_terminal_cannot_confirm_internally_valid_earlier_job_prefix(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db)
    try:
        prepare(ctx, batch, upload)
        terminal = apply(ctx, status(ctx, cmd).current_batch).terminal_bytes
        job = db.job_rows[(1, SOURCE, JOB)]
        job.update(confirmed_through=0, next_batch_no=1)
        job.update({name: 0 for name in COUNTERS})
        assert row(db, cmd, batch)['terminal_bytes'] == terminal
        assert row(db, cmd, batch)['terminal_sha256'] == sha256(terminal).hexdigest()
        before = snapshot(db)
        first = len(db.calls)
        with pytest.raises(p.SourceUnavailable): reconcile(ctx, cmd, batch)
        assert snapshot(db) == before
        assert jobs._CONFIRM_SQL not in db.calls[first:]
        assert jobs._JOB_CAS_SQL not in db.calls[first:]
    finally:
        upload.close()


def test_real_retry_reconciliation_and_status_filter_exact_retained_receipt(monkeypatch):
    from tests.py.foobar_account_import_jobs_testing import retry, receipt_status
    db = install(monkeypatch)
    ctx, cmd, first, upload = start(db, payload=payload_rows(103))
    try:
        prepare(ctx, first, upload)
        ready = status(ctx, cmd).current_batch
        first_terminal = apply(ctx, ready).terminal_bytes
        second = claim(ctx, cmd, first.prepare_command.inventory_sha256)
        prepare(ctx, second, upload)
        second_ready = status(ctx, cmd).current_batch
        assert len(db.receipts) == 2 and len(db.keys) == 3
        before = snapshot(db)
        old = receipt_status.read_foobar_import_status(URL, ctx, source_ref=SOURCE,
            generation=GEN, receipt_ref=ready.apply_command.receipt_ref)
        current = receipt_status.read_foobar_import_status(URL, ctx, source_ref=SOURCE,
            generation=GEN, receipt_ref=second_ready.apply_command.receipt_ref)
        assert old.state == 'committed' and old.terminal_bytes == first_terminal
        assert current.state == 'ready' and current.original_prepare_command == second.prepare_command
        first_result = retry.reconcile_foobar_attempt(URL, ctx, operation='apply', command=ready.apply_command)
        second_result = retry.reconcile_foobar_attempt(URL, ctx, operation='prepare', command=second.prepare_command)
        pending_result = retry.reconcile_foobar_attempt(URL, ctx, operation='apply', command=second_ready.apply_command)
        assert first_result.disposition is retry.RetryDisposition.REPLAY_SAME_IDENTITY
        assert second_result.disposition is retry.RetryDisposition.REPLAY_SAME_IDENTITY
        assert pending_result.disposition is retry.RetryDisposition.RETRY_SAME_IDENTITY
        # The pointer is a test-driver cursor selection, not durable state.
        # All durable projections and source effects remain byte-identical.
        db.receipt = db.receipts[second_ready.apply_command.receipt_ref]
        assert snapshot(db) == before
        assert retry.current_foobar_account_transaction is account_authority.current_foobar_account_transaction
        assert receipt_status.current_foobar_account_transaction is account_authority.current_foobar_account_transaction
    finally:
        upload.close()


def test_real_preflight_rollback_preserves_claim_without_dispatching_job_hooks(monkeypatch):
    from music_app.services import foobar_account_import_preflight as preflight
    import threading
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, payload=payload_rows(203))
    try:
        before = snapshot(db)
        first = len(db.calls)
        commits = db.commits
        result = preflight.preflight_indexed_foobar_import(URL, ctx, upload=upload,
            command=batch.prepare_command, intake_capacity=CAPACITY,
            cancel_event=threading.Event())
        assert result.status == 'complete_preflight' and result.checked_rows == 203
        assert db.explicit_rollbacks >= 3 and db.commits == commits
        assert snapshot(db) == before
        assert jobs._FIND_PREPARE_SQL not in db.calls[first:]
        assert jobs._READY_SQL not in db.calls[first:]
        assert p._INSERT_READY_SQL not in db.calls[first:]
        assert row(db, cmd, batch)['state'] == 'claimed'
    finally:
        upload.close()


def test_single_oversized_row_refuses_without_import_mutation(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, batch, upload = start(db, payload=payload_rows(1, wide=True))
    before = snapshot(db)
    try:
        with pytest.raises(p.SourceUnavailable):
            prepare(ctx, batch, upload)
        assert snapshot(db) == before
        assert not db.source_rows and not db.receipts and not db.keys
        assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls
    finally:
        upload.close()
