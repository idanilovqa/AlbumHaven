"""Authored, not executed. Controlled boundary tests are NOT PostgreSQL validation."""
from dataclasses import replace
from datetime import timedelta
import hashlib
import inspect
import json
import re

import pytest

from tests.py.foobar_account_chain_synthetic import (
    p, a, f, NOW, GEN, SOURCE, KEY, APPLY_KEY, PAYLOAD, CAPACITY, context, command, install,
)
from music_app.services import foobar_account_authority_snapshot as snapshot


def ready(db, ctx=None, cmd=None, payload=PAYLOAD):
    return p.prepare_foobar_import('synthetic:no-network', ctx or context(),
        command=cmd or command(payload), payload=payload, intake_capacity=CAPACITY)


def apply_command(receipt):
    return a.apply_command.FoobarApplyCommand(SOURCE, GEN, APPLY_KEY,
        receipt.receipt_ref, receipt.decision_sha256, None)


def apply(cmd, ctx=None):
    return a.apply_foobar_import('synthetic:no-network', ctx or context(),
        command=cmd, intake_capacity=CAPACITY)


def forbidden(*args, **kwargs):
    raise AssertionError('No-library chain attempted native taste I/O')


def test_full_prepare_apply_and_exact_replays_keep_real_callees(monkeypatch):
    db = install(monkeypatch)
    # Do not patch codecs, gate, source lookup, merge, writer or finalizer.
    # Fail fast if any library taste read/write is attempted, including empty calls.
    for name in ('read_foobar_taste_on_connection',
                 'apply_foobar_taste_on_connection', '_foobar_taste_query',
                 'apply_foobar_taste_with_postimages_on_connection',
                 'read_foobar_taste_postimages_on_connection'):
        if hasattr(p.taste, name):
            monkeypatch.setattr(p.taste, name, forbidden)
    receipt = ready(db)
    assert db.commits == 1 and db.revision == 0 and db.source_row is None
    original = p.envelope.decode_prepared_envelope(db.receipt['prepared'],
        original_command=command(), expected_header=db.receipt['header'],
        prepared_sha256=receipt.prepared_sha256, decision_sha256=receipt.decision_sha256)
    assert original[1][1] is None and original[3] == ()
    assert original[2][0][9:] == (None, None, False)
    raw = p.evidence.decode_evidence(bytes.fromhex(original[2][0][6]))
    assert any(field[0] == 'valid' and field[1] == '4' for field in raw)
    assert ready(db) == receipt
    result = apply(apply_command(receipt))
    assert db.revision == 1 and db.receipt['prepared'] is None
    assert db.source_row[6] == original[2][0][7]
    assert db.source_row[8] == original[2][0][6]
    assert len(result.terminal_bytes) <= 669
    record = tuple(json.loads(result.terminal_bytes))
    assert record[0] == 'foobar_acct_v4'
    assert len(record) == 24 and record[22] == 0
    assert record[16:22] == (0, 1, 0, 0, 0, 0)
    assert record[11:13] == (0, 1)
    mutation_sql = (p._INSERT_READY_SQL, p.source._insert_observations_sql(),
                    p.source._insert_revisions_sql(), f._ADVANCE_SQL, f._COMMIT_SQL)
    counts = tuple(db.calls.count(sql) for sql in mutation_sql)
    assert counts == (1, 1, 1, 1, 1)
    assert apply(apply_command(receipt)) == result
    assert ready(db).terminal_bytes == result.terminal_bytes
    assert tuple(db.calls.count(sql) for sql in mutation_sql) == counts
    assert all(cursor.closed for cursor in db.cursors)
    # Actual query dispatch proves these owners were traversed, not success stubs.
    for sql in (p.lookup._CARDINALITY_SQL, p.lookup._COMPARE_SQL,
                p.sizing._MERGED_SIZE_SQL, p.gate._KEY_SQL, p._CURRENT_SOURCE_SQL,
                p._CAPACITY_SQL, p.source._current_sql(), f._GUARD_SQL, f._COMMIT_SQL):
        assert sql in db.calls
    assert all('library.' not in sql and 'app.track_preferences' not in sql for sql in db.calls)


def test_lost_apply_ack_reconciles_original_key_without_duplicate_appends(monkeypatch):
    db = install(monkeypatch)
    receipt = ready(db)
    cmd = apply_command(receipt)
    db.lose_ack = True
    with pytest.raises(a.FoobarApplyCommitUncertain):
        apply(cmd)
    assert db.receipt['state'] == 'committed' and db.revision == 1
    result = apply(cmd)
    assert result.terminal_bytes == db.receipt['terminal']
    assert db.calls.count(p.source._insert_revisions_sql()) == 1
    assert db.calls.count(f._COMMIT_SQL) == 1


def test_lost_prepare_ack_replays_ready_without_second_insert(monkeypatch):
    db = install(monkeypatch)
    db.lose_ack = True
    with pytest.raises(p.SourceUnavailable):
        ready(db)
    assert db.receipt['state'] == 'ready'
    result = ready(db)
    assert result.receipt_ref == db.receipt['receipt_ref']
    assert db.calls.count(p._INSERT_READY_SQL) == 1


def test_precommit_failure_rolls_back_synthetic_boundary_state(monkeypatch):
    db = install(monkeypatch)
    receipt = ready(db)
    db.fail_sql = f._COMMIT_SQL
    with pytest.raises(p.SourceUnavailable) as error:
        apply(apply_command(receipt))
    assert not isinstance(error.value, a.FoobarApplyCommitUncertain)
    assert db.source_row is None and db.revision == 0
    assert db.receipt['state'] == 'ready' and APPLY_KEY not in db.keys
    db.fail_sql = None
    assert apply(apply_command(receipt)).terminal_bytes == db.receipt['terminal']


@pytest.mark.parametrize('scope', ['session', 'account'])
def test_changed_scope_never_returns_receipt_or_writes(monkeypatch, scope):
    db = install(monkeypatch)
    receipt = ready(db)
    ctx = context()
    if scope == 'session':
        ctx = replace(ctx, actor=replace(ctx.actor, session_id=4))
    else:
        ctx = replace(ctx, actor=replace(ctx.actor, account_id=2), target_account_id=2)
    with pytest.raises(p.SourceUnavailable):
        apply(apply_command(receipt), ctx)
    assert db.source_row is None and db.revision == 0


def test_ambient_library_never_changes_explicit_no_library_command(monkeypatch):
    # The v1 blanket rejection of ambient selected libraries is superseded by
    # explicit command scope. Account/session isolation above still rejects;
    # matching-chain regressions reject a changed explicit library before I/O.
    db = install(monkeypatch)
    ambient = replace(context(), library_id=7)
    receipt = ready(db, ctx=ambient)
    result = apply(apply_command(receipt), ambient)
    record = tuple(json.loads(result.terminal_bytes))
    assert record[16:23] == (0, 1, 0, 0, 0, 0, 0)
    assert not any('library.' in sql or 'app.track_preferences' in sql
                   or 'foobar_match_' in sql for sql in db.calls)


def test_retirement_precedes_key_lookup_and_does_not_remint(monkeypatch):
    db = install(monkeypatch)
    receipt = ready(db)
    db.current_generation = GEN+1
    db.now = NOW+timedelta(days=1)
    db.retired_through = GEN
    start = len(db.calls)
    with pytest.raises(p.SourceStale):
        apply(apply_command(receipt))
    assert a._APPLY_KEY_SQL not in db.calls[start:]
    assert db.source_row is None and len(db.keys) == 1


def test_bad_decision_does_not_reach_source_writer(monkeypatch):
    db = install(monkeypatch)
    receipt = ready(db)
    with pytest.raises(p.SourceUnavailable):
        apply(replace(apply_command(receipt), decision_sha256='f'*64))
    assert p.source._insert_observations_sql() not in db.calls
    assert db.receipt['state'] == 'ready'


def test_actual_source_layout_uses_five_member_writer_frame(monkeypatch):
    db = install(monkeypatch)
    ready(db)
    original = p.envelope._freeze(json.loads(db.receipt['prepared']))
    size = len(db.receipt['prepared'])
    items = a._reconstruct_source_items(original, prepared_bytes=size)
    layout = a._source_layout_from_original(original, prepared_bytes=size)
    phase, frame_size, base, result = p.source.source_write_phase_bytes(items,
        account_id=1, source_ref=SOURCE, generation=GEN, expected_revision=0)
    assert (layout[4], layout[5], layout[2], layout[6]) == (phase, frame_size, base, result)
    wire = p.source._frame(items, 1, SOURCE, GEN, 0)
    assert len(wire) == frame_size
    assert len(json.loads(wire)) == 5
    assert json.loads(wire)[:4] == [1, SOURCE, GEN, 0]
    assert f._association_admission(original, size) <= p.MAX_PRIVATE_BYTES


@pytest.mark.parametrize('change', ['library', 'taste', 'rating', 'favorite', 'version'])
def test_envelope_rejects_native_scope_and_taste_members(monkeypatch, change):
    db = install(monkeypatch)
    ready(db)
    value = json.loads(db.receipt['prepared'])
    if change == 'library':
        value[1][1] = 7
    elif change == 'taste':
        value[3] = [[1]]
    elif change == 'rating':
        value[2][0][10] = 4
    elif change == 'favorite':
        value[2][0][11] = True
    else:
        value[0] = 'foobar_prepared_v2'
    value = p.envelope._freeze(value)
    with pytest.raises(p.SourceUnavailable):
        p.envelope.encode_prepared_envelope(value, original_command=command(),
            expected_header=value[1])


@pytest.mark.parametrize('mutation', [lambda b: b+b' ', lambda b: b' '+b,
    lambda b: b.replace(b'null', b'NaN', 1), lambda b: b.replace(b'null', b'false', 1),
    lambda b: b'['*100+b, lambda b: b'{"duplicate":1,"duplicate":2}',
    lambda b: b.replace(b'foobar_account_prepared_v4', b'foobar_account_prepared_v2'),
    lambda b: b.replace(b'foobar_account_prepared_v4', b'foobar_account_prepared_v3')])
def test_malformed_envelope_rejected_even_with_recomputed_untrusted_hashes(monkeypatch, mutation):
    db = install(monkeypatch)
    ready(db)
    body = mutation(db.receipt['prepared'])
    prepared, decision = p.envelope._digests(body)
    with pytest.raises(p.SourceUnavailable):
        p.envelope.decode_prepared_envelope(body, original_command=command(),
            expected_header=db.receipt['header'], prepared_sha256=prepared, decision_sha256=decision)


def test_scope_digest_separates_account_session_and_command_domains():
    cmd = command()
    digest = lambda account, session: p.gate.prepare_command_digest(cmd,
        account_id=account, library_id=None, session_id=session)
    assert len({digest(1,3), digest(2,3), digest(1,4)}) == 3
    assert p.gate.VERSION == 'foobar_account_prepare_command_v4'
    assert p.envelope.VERSION == 'foobar_account_prepared_v4'
    assert a.apply_command.VERSION == 'foobar_account_apply_command_v4'
    assert snapshot.VERSION == 'foobar_account_authority_v1'
    assert p.terminal_codec.VERSION == 'foobar_acct_v4'
    assert p.NO_LIBRARY_INVENTORY_SHA256 == hashlib.sha256(
        b'albumhaven.foobar.account.no-library.v1\n').hexdigest()
    for ids in ((1,), [], None):
        with pytest.raises(p.SourceUnavailable):
            snapshot.authority_snapshot_phase_bytes(context(), track_ids=ids)
    # The private no-library value owner still rejects ambient native scope.
    # The public snapshot owner now legitimately delegates explicit local scope.
    with pytest.raises(p.SourceUnavailable):
        snapshot._value(replace(context(), library_id=1), ())


def test_terminal_maximum_record_and_malformed_wire():
    t = p.terminal_codec
    record = (t.VERSION, 'a'*64, SOURCE, KEY, APPLY_KEY,
        '44444444-4444-4444-8444-444444444444', *('b'*64 for _ in range(5)),
        t.MAX_BIGINT-1, t.MAX_BIGINT, 100000, 99901, 100001,
        0, 0, 0, 100, 100, 100, 100, 2147483647)
    body = t.encode_foobar_terminal(record)
    assert len(body) == 669
    assert t.MAX_WIRE_BYTES == 669
    header = record[:16]+(record[23],)
    assert t.decode_foobar_terminal(body, expected_header=header) == record
    for bad in (body+b' '*4, body+b' '*5, body+b' ', b' '+body, body.replace(b'foobar_acct_v4', b'foobar_acct_end_v2'),
                body[:-1]+b',0]', body.replace(b'100000', b'1e5', 1)):
        with pytest.raises(t.FoobarTerminalUnavailable):
            t.decode_foobar_terminal(bad, expected_header=header)
    wrong = list(record); wrong[20] = 101
    with pytest.raises(t.FoobarTerminalUnavailable):
        t.encode_foobar_terminal(tuple(wrong))


@pytest.mark.parametrize('counter', ['taste', 'associations'])
def test_no_library_persisted_terminal_rejects_local_counters(monkeypatch, counter):
    db = install(monkeypatch)
    receipt = ready(db)
    cmd = apply_command(receipt)
    apply(cmd)
    # Malformed persisted-row fixture, not a manufactured successful result.
    # Generic v3 permits optional-local counters; the actual no-library replay
    # caller must independently reject them even with a matching byte checksum.
    record = list(json.loads(db.receipt['terminal']))
    if counter == 'taste':
        record[17:22] = [0, 1, 0, 1, 0]
    else:
        record[22] = 1
    body = p.terminal_codec.encode_foobar_terminal(tuple(record))
    db.receipt.update(terminal=body, terminal_sha256=hashlib.sha256(body).hexdigest())
    with pytest.raises(p.SourceUnavailable):
        apply(cmd)
    assert db.calls.count(p.source._insert_revisions_sql()) == 1
    assert db.calls.count(f._COMMIT_SQL) == 1


def test_raw_unavailable_survives_real_prepared_source_validator(monkeypatch):
    db = install(monkeypatch)
    ready(db)
    prior = p.envelope._freeze(json.loads(db.receipt['prepared']))
    old = p.evidence.decode_evidence(bytes.fromhex(prior[2][0][7]))
    upload = PAYLOAD.replace(b'\t19\n', b'\tN/A\n')
    cmd = replace(command(upload), expected_revision=1)
    parsed = p.parser.parse_foobar_snapshot(upload, mapping_name=p.gate.MAPPING)
    incoming = p.evidence.fields_from_row(parsed.rows[0], upload_sha256=cmd.upload_sha256)
    merged = p.evidence.merge_fields(old, incoming)
    index = p.parser.FIELD_NAMES.index('play_count')
    assert merged[index] == old[index] and incoming[index] != old[index]
    raw = p.evidence.encode_evidence(incoming)
    effective = p.evidence.encode_evidence(merged)
    display = p.source.display.encode_display(merged)
    old_e = bytes.fromhex(prior[2][0][7]); old_d = bytes.fromhex(prior[2][0][8])
    identity = bytes.fromhex(prior[2][0][1])
    sha = lambda value: hashlib.sha256(value).hexdigest()
    h = list(prior[1]); h[7] = 1; h[8] = cmd.upload_sha256
    row = (1, identity.hex(), prior[2][0][2], 1, sha(old_e), sha(old_d),
           raw.hex(), effective.hex(), display.hex(), None, None, False)
    original = (p.envelope.VERSION, tuple(h), (row,), (), prior[4])
    body, prepared, decision = p.envelope.encode_prepared_envelope(original,
        original_command=cmd, expected_header=tuple(h))
    original = p.envelope.decode_prepared_envelope(body, original_command=cmd,
        expected_header=tuple(h), prepared_sha256=prepared, decision_sha256=decision)
    dispatch = db.dispatch

    def immutable(sql, params):
        if sql == p.original_sources._SCALAR_SQL:
            return [dict(identity_bytes_size=len(identity), evidence_bytes_size=len(old_e),
                display_bytes_size=len(old_d), identity_sha256=sha(identity), identity_kind='path',
                incoming_evidence_bytes_size=len(old_e), incoming_evidence_sha256=sha(old_e))]
        if sql == p.original_sources._RAW_SQL:
            return [dict(identity_bytes=identity, evidence_bytes=old_e,
                         display_bytes=old_d, incoming_evidence_bytes=old_e)]
        return dispatch(sql, params)

    monkeypatch.setattr(db, 'dispatch', immutable)
    connection = p._Connection(db, p._Deadline())
    p._original_source_admission(connection, context(), original)
    assert p.original_sources.validate_prepared_sources_on_connection(connection, context(),
        original_value=original, original_command=cmd, expected_header=tuple(h)) == (True,)
    items = a._reconstruct_source_items(original, prepared_bytes=len(body))
    assert items[0].incoming_evidence_bytes == raw
    assert items[0].evidence_bytes == effective
    assert raw != effective
    outcome = p.source.SourceWriteOutcome(items[0].observation_ref, True, 2, sha(raw))
    association_outcomes = a.associations.apply_foobar_associations_on_connection(
        connection, context(), source_ref=SOURCE, receipt_ref=h[6],
        matching_library_id=None, rows=original[2], seals=original[4])
    assert len(association_outcomes) == 1 and not association_outcomes[0].changed
    counts, revision = f._actual_counts(original, items, (outcome,), (), (), association_outcomes)
    assert counts == (0, 1, 0, 0, 0, 0, 0) and revision == 2
    wrong = list(row); wrong[7] = raw.hex()
    corrupted = (original[0], original[1], (tuple(wrong),), (), original[4])
    with pytest.raises(p.SourceUnavailable):
        p.original_sources.validate_prepared_sources_on_connection(connection, context(),
            original_value=corrupted, original_command=cmd, expected_header=tuple(h))
