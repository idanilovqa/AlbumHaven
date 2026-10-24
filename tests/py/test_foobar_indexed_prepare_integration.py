"""Authored only: genuine index/Prepare/worker with v3 driver-result boundary.

No tests were executed while authoring. These fixtures replace transport/driver
results and deterministic scheduling, never the resolver, evidence, index,
Prepare, reconciliation, account policy, association or receipt owners.
"""
from contextlib import contextmanager
from dataclasses import replace
from uuid import uuid4

import pytest

from music_app.services import foobar_account_indexed_upload as indexed
from music_app.services import foobar_snapshot_parser as parser
from tests.py.foobar_account_associations_v3_testing import (
    install, make_command, prepared, requested_context, p, CAPACITY, PAYLOAD,
    bridge, scalars, authority, associations,
)
from tests.py.foobar_account_service_testing import (
    s, handles, install_reconciliation, reconciliation,
)
from tests.py.foobar_account_service_readiness_testing import install_catalog
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


def consume(stream):
    rows = []
    try:
        while True:
            try:
                rows.append(next(stream))
            except StopIteration as done:
                return tuple(rows), done.value
    finally:
        stream.close()


def forbidden(*args, **kwargs):
    raise AssertionError('Indexed Prepare unexpectedly used the full raw scan')


def open_upload(db, payload=PAYLOAD, library=7, offset=0):
    cmd = replace(make_command(db, library=library, payload=payload), offset=offset)
    ctx = requested_context(library)
    upload = indexed.open_account_indexed_upload(ctx, payload=payload,
        command=cmd, intake_capacity=CAPACITY)
    return ctx, cmd, upload


def run_prepare(ctx, cmd, upload):
    return p.prepare_indexed_foobar_import('synthetic:no-network', ctx,
        upload=upload, command=cmd, intake_capacity=CAPACITY)


def reject_raw(monkeypatch):
    monkeypatch.setattr(parser, 'iter_foobar_snapshot_rows', forbidden)
    monkeypatch.setattr(p.preview, '_scan', forbidden)
    monkeypatch.setattr(p.window, 'prove_foobar_source_window', forbidden)


@pytest.mark.parametrize('offset', [0, 100])
def test_actual_selected_scans_keep_original_evidence_and_terminal(monkeypatch, offset):
    db = install(monkeypatch)
    payload = b'\xef\xbb\xbf' + b'title\tpath\trating\tfavorite\tplay_count\r\n' + b''.join(
        ('Track %d\t/track-%d.flac\t4\t1\t19\r\n' % (i, i)).encode()
        for i in range(103))
    expected, terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=p.gate.MAPPING))
    ctx, cmd, upload = open_upload(db, payload, library=None, offset=offset)
    calls = []
    real = indexed.iter_source_rows

    def selected(value, *, offset):
        assert value is upload
        rows, end = consume(real(value, offset=offset))
        assert rows == expected[offset:offset + p.window.MAX_WINDOW_ROWS]
        assert end == terminal and end is upload._upload.terminal
        calls.append(offset)
        yield from rows
        return end

    monkeypatch.setattr(indexed, 'iter_source_rows', selected)
    reject_raw(monkeypatch)
    try:
        receipt = run_prepare(ctx, cmd, upload)
        original = prepared(db)
        assert receipt.total_rows == 103
        assert receipt.window_start == offset + 1
        assert calls == [offset] * 4  # plans, sizing, reconstruction, evidence verification
        assert original[1][8] == terminal.source_sha256
        assert original[1][9] == p.evidence.PARSER_VERSION
        assert original[1][10] == terminal.contract_version
        for row, parsed in zip(original[2], expected[offset:]):
            incoming = p.evidence.encode_evidence(p.evidence.fields_from_row(
                parsed, upload_sha256=terminal.source_sha256))
            assert bytes.fromhex(row[6]) == incoming
        assert len(original[2]) == receipt.window_end - receipt.window_start
    finally:
        upload.close()


def test_global_native_counts_include_later_window_and_reuse_current_inventory(monkeypatch):
    db = install(monkeypatch)
    header, row = PAYLOAD.split(b'\n', 1)
    payload = header + b'\n' + row + b''.join(
        row.replace(b'/synthetic.flac', ('/unknown-%d.flac' % i).encode())
        for i in range(99)) + row
    ctx, cmd, upload = open_upload(db, payload)
    scans = []
    real_rows = indexed._AccountIndexedUpload.rows

    def rows(owner, offset):
        scans.append(offset)
        return real_rows(owner, offset)

    monkeypatch.setattr(indexed._AccountIndexedUpload, 'rows', rows)
    reject_raw(monkeypatch)
    try:
        proof = upload.proof(0, CAPACITY)
        live = authority.lock_foobar_matching_context(db, authority.require_account_foobar(ctx), ctx, 7)
        inventory, projections, terminal, counts = p._read_inventory(db, live,
            payload=upload, proof=proof, command=cmd, constraints=None, capacity=CAPACITY)
        assert dict(counts) == {bridge._opaque_reference('track', 1, 7, 21): 2} and terminal.summary.data_rows == 101
        assert scans == [0, 100]
        before = (db.calls.count(scalars._foobar_inventory_scalar_sql()),
                  db.calls.count(bridge._path_projection_sql()))
        again = p._read_inventory(db, live, payload=upload, proof=upload.proof(100, CAPACITY),
            command=replace(cmd, offset=100), constraints=None, capacity=CAPACITY)
        assert again[3] is counts and scans == [0, 100]
        assert db.calls.count(scalars._foobar_inventory_scalar_sql()) > before[0]
        assert db.calls.count(bridge._path_projection_sql()) > before[1]
        receipt = run_prepare(ctx, cmd, upload)
        assert receipt.total_rows == 101
        assert prepared(db)[4][0][9] is None  # duplicate outside selected window suppresses target
        assert associations._READ in db.association_calls
    finally:
        upload.close()


def test_actual_changed_projection_rejected_not_just_caller_digest(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    try:
        proof = upload.proof(0, CAPACITY)
        live = authority.lock_foobar_matching_context(db, authority.require_account_foobar(ctx), ctx, 7)
        p._read_inventory(db, live, payload=upload, proof=proof, command=cmd,
            constraints=None, capacity=CAPACITY)
        counts = upload._counts
        db.files[21] = '/changed.flac'
        # Exercise the actual inventory/cache seam with the genuine new digest.
        # The public indexed entry additionally rejects this changed scope.
        changed = make_command(db)
        with pytest.raises(p.SourceStale):
            p._read_inventory(db, live, payload=upload, proof=proof, command=changed,
                constraints=None, capacity=CAPACITY)
        assert upload._counts is counts and dict(counts) == {bridge._opaque_reference('track', 1, 7, 21): 1}
        with pytest.raises(p.SourceStale):
            run_prepare(ctx, changed, upload)
    finally:
        upload.close()


@pytest.mark.parametrize('field,value', [
    ('source_ref', '44444444-4444-4444-8444-444444444444'),
    ('generation', 2), ('upload_sha256', 'f' * 64),
    ('matching_library_id', 8), ('inventory_sha256', 'e' * 64),
])
def test_changed_command_scope_rejected_before_transaction(monkeypatch, field, value):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    try:
        monkeypatch.setattr(p, 'current_foobar_import_transaction', forbidden)
        with pytest.raises(p.SourceStale):
            run_prepare(ctx, replace(cmd, **{field: value}), upload)
        upload.validate(ctx, replace(cmd, expected_revision=cmd.expected_revision + 1,
            offset=100, request_key=str(uuid4())))
        with pytest.raises(p.gate.PrepareInvalid):
            p.prepare_foobar_import('synthetic:no-network', ctx, payload=upload,
                command=cmd, intake_capacity=CAPACITY)
    finally:
        upload.close()


@pytest.mark.parametrize('field,value', [('session_id', 99), ('account_id', 2)])
def test_changed_actor_scope_is_not_index_authority(monkeypatch, field, value):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    try:
        actor = replace(ctx.actor, **{field: value})
        changed = replace(ctx, actor=actor,
            target_account_id=value if field == 'account_id' else ctx.target_account_id)
        monkeypatch.setattr(p, 'current_foobar_import_transaction', forbidden)
        with pytest.raises(p.SourceStale):
            run_prepare(changed, cmd, upload)
    finally:
        upload.close()


def dispatched(monkeypatch, db, payload=PAYLOAD):
    install_catalog(monkeypatch)
    install_reconciliation(monkeypatch, db)
    handle, = handles(monkeypatch)
    cmd = make_command(db, payload=payload)
    ticket = handle.begin_prepare(context=requested_context(7),
        constraints=PolicyEvaluationConstraints(), command=cmd, length=len(payload))
    handle.append_prepare(ticket, payload)
    handle.finish_prepare(ticket)
    handle.owner.current.stage = s._Stage.RUNNING  # scheduler boundary, not business substitute
    return handle, ticket, cmd


def test_one_genuine_worker_index_survives_reconciliation_then_closes(monkeypatch):
    db = install(monkeypatch)
    handle, ticket, cmd = dispatched(monkeypatch, db)
    operation = handle.owner.current
    built, invocations, settled = [], [], []
    real_build = indexed.open_account_indexed_upload
    real_prepare = p.prepare_indexed_foobar_import
    real_outer = p.current_foobar_import_transaction

    def build(*args, **kwargs):
        value = real_build(*args, **kwargs)
        built.append(value)
        return value

    def prepare(*args, **kwargs):
        invocations.append((kwargs['upload'], kwargs['command']))
        assert kwargs['upload']._upload.terminal.source_sha256 == cmd.upload_sha256
        return real_prepare(*args, **kwargs)

    @contextmanager
    def outer(*args, **kwargs):
        try:
            with real_outer(*args, **kwargs) as value:
                yield value
        finally:
            assert built[0]._upload.terminal.source_sha256 == cmd.upload_sha256
            settled.append(True)

    monkeypatch.setattr(indexed, 'open_account_indexed_upload', build)
    monkeypatch.setattr(p, 'prepare_indexed_foobar_import', prepare)
    monkeypatch.setattr(p, 'current_foobar_import_transaction', outer)
    db.lose_ack = True
    s._invoke(handle.owner)
    assert len(built) == 1 and len(invocations) == len(settled) == 2
    assert all(value is built[0] and command is cmd for value, command in invocations)
    assert operation.delivery.outcome is s._Outcome.SUCCESS
    assert operation.delivery.command is cmd and operation.ticket is ticket
    assert db.calls.count(p._INSERT_READY_SQL) == 1 and set(db.keys) == {cmd.request_key}
    assert reconciliation._KEY_SQL in db.calls
    assert operation.indexed_upload is operation.intake is operation.context is None
    assert not operation.cleanup_failed
    with pytest.raises(parser.FoobarIndexedUploadClosed):
        _ = built[0]._upload.terminal


def test_running_cancellation_holds_index_until_transaction_settles(monkeypatch):
    db = install(monkeypatch)
    handle, ticket, cmd = dispatched(monkeypatch, db)
    operation = handle.owner.current
    held = []
    real_outer = p.current_foobar_import_transaction

    @contextmanager
    def outer(*args, **kwargs):
        with real_outer(*args, **kwargs) as value:
            held.append(operation.indexed_upload)
            handle.abandon(ticket)
            assert not handle.available and operation.indexed_upload is held[0]
            assert held[0]._upload.terminal.source_sha256 == cmd.upload_sha256
            yield value
        assert held[0]._upload.terminal.source_sha256 == cmd.upload_sha256

    monkeypatch.setattr(p, 'current_foobar_import_transaction', outer)
    s._invoke(handle.owner)
    assert operation.abandoned and not operation.cleanup_failed
    assert operation.indexed_upload is operation.intake is None
    assert reconciliation._KEY_SQL not in db.calls
    with pytest.raises(parser.FoobarIndexedUploadClosed):
        _ = held[0]._upload.terminal


def test_failed_worker_index_construction_discards_intake_without_prepare(monkeypatch):
    db = install(monkeypatch)
    malformed = PAYLOAD + b'bad\textra\n'
    handle, ticket, cmd = dispatched(monkeypatch, db, malformed)
    operation = handle.owner.current
    monkeypatch.setattr(p, 'prepare_indexed_foobar_import', forbidden)
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.INVALID
    assert operation.indexed_upload is operation.intake is operation.context is None
    assert db.receipt is None and not operation.cleanup_failed
    assert reconciliation._KEY_SQL not in db.calls


def test_successful_parser_index_is_closed_when_command_hash_mismatches(monkeypatch):
    db = install(monkeypatch)
    ctx = requested_context(7)
    cmd = replace(make_command(db), upload_sha256='f' * 64)
    built = []
    real_build = p.window.build_foobar_upload_index

    def build(*args, **kwargs):
        value = real_build(*args, **kwargs)
        built.append(value)
        return value

    monkeypatch.setattr(p.window, 'build_foobar_upload_index', build)
    with pytest.raises(p.gate.PrepareInvalid):
        indexed.open_account_indexed_upload(ctx, payload=PAYLOAD, command=cmd, intake_capacity=CAPACITY)
    assert len(built) == 1
    with pytest.raises(parser.FoobarIndexedUploadClosed):
        _ = built[0].terminal


def test_retained_cache_and_new_inventory_both_enter_actual_admission(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    charges = []
    real_admit = p.intake._admit

    def admit(capacity, required):
        charges.append(required)
        return real_admit(capacity, required)

    monkeypatch.setattr(p.intake, '_admit', admit)
    try:
        live = authority.lock_foobar_matching_context(db, authority.require_account_foobar(ctx), ctx, 7)
        proof = upload.proof(0, CAPACITY)
        base = upload.retained_bytes
        p._read_inventory(db, live, payload=upload, proof=proof, command=cmd,
            constraints=None, capacity=CAPACITY)
        retained = upload.retained_bytes
        cache = retained - base
        assert cache > 0
        charges.clear()
        p._read_inventory(db, live, payload=upload, proof=proof, command=cmd,
            constraints=None, capacity=CAPACITY)
        assert (retained + cache + p._inventory_intake_bytes(len(PAYLOAD),
            p.window.source_window_proof_bytes(proof), len(db.files),
            sum(len(path.encode()) for path in db.files.values()))) in charges
        low = p.intake.FoobarIntakeCapacity(retained + p.window.WINDOW_WORK_BYTES - 1)
        with pytest.raises(p.intake.FoobarInventoryUnavailable):
            upload.proof(0, low)
        assert charges[-1] == retained + p.window.WINDOW_WORK_BYTES
        assert charges[-1] == low.logical_bytes + 1
        assert upload.retained_bytes == retained
        assert db.receipt is None and not db.keys and not db.source_rows
        # Rejection leaves the cached indexed upload usable at its original cap.
        assert upload.proof(0, CAPACITY) == proof
    finally:
        upload.close()


def test_handle_admits_index_before_allocating_intake(monkeypatch):
    db = install(monkeypatch)
    cmd = make_command(db)
    handle, = handles(monkeypatch)
    n = len(PAYLOAD)
    required = (p.window.indexed_upload_intake_bytes(n) + 7*n
        + p.window.PARSER_WORK_BYTES + p.window.WINDOW_WORK_BYTES)
    handle.owner.limits = s.FoobarImportLimits(required - 1, 1024*1024*1024)
    with pytest.raises(s.SourceUnavailable):
        handle.begin_prepare(context=requested_context(7),
            constraints=PolicyEvaluationConstraints(), command=cmd, length=n)
    assert handle.owner.current is None and handle.owner.next_ticket == 1


@pytest.mark.parametrize('offset', [1, 100000])
def test_valid_command_outside_actual_upload_preserves_invalid_classification(monkeypatch, offset):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db, offset=offset)
    try:
        p.gate.validate_prepare_command(cmd)
        with pytest.raises(p.intake.FoobarPreparationRejected):
            p.prepare_foobar_import('synthetic:no-network', ctx, payload=PAYLOAD,
                command=cmd, intake_capacity=CAPACITY)
        with pytest.raises(p.intake.FoobarPreparationRejected):
            run_prepare(ctx, cmd, upload)
        assert db.receipt is None and not db.keys
        upload.close()
        with pytest.raises(p.SourceUnavailable):
            upload.proof(0, CAPACITY)
    finally:
        upload.close()


def test_cached_index_does_not_replace_current_matching_authority(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    try:
        first = run_prepare(ctx, cmd, upload)
        assert first.association_review and upload._counts is not None
        before = len(db.native_calls)
        db.membership = False
        with pytest.raises((p.SourceUnavailable, p.SourceStale)):
            run_prepare(ctx, cmd, upload)
        assert len(db.native_calls) > before
        assert db.calls.count(p._INSERT_READY_SQL) == 1
        assert upload._upload.terminal.source_sha256 == cmd.upload_sha256
    finally:
        upload.close()


def test_unsupported_mapping_fails_before_index_or_transaction(monkeypatch):
    db = install(monkeypatch)
    ctx, cmd, upload = open_upload(db)
    try:
        monkeypatch.setattr(p, 'current_foobar_import_transaction', forbidden)
        with pytest.raises(p.gate.PrepareInvalid):
            run_prepare(ctx, replace(cmd, mapping_name='different-mapping'), upload)
    finally:
        upload.close()


def test_worker_outside_actual_upload_is_invalid_without_reconciliation(monkeypatch):
    db = install(monkeypatch)
    handle, ticket, cmd = dispatched(monkeypatch, db)
    operation = handle.owner.current
    operation.command = replace(cmd, offset=1)  # still a valid wire command
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.INVALID
    assert reconciliation._KEY_SQL not in db.calls and db.receipt is None
    assert operation.indexed_upload is operation.intake is None
    assert not operation.cleanup_failed
