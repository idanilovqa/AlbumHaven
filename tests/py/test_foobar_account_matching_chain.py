"""AUTHORED ONLY: actual callers/codecs against an explicit synthetic DB boundary.

No test in this file proves native SQL execution, concurrency or durable commits.
"""
from dataclasses import replace
import hashlib
import inspect
import json

import pytest

from tests.py.foobar_account_matching_synthetic import (
    p, a, f, GEN, SOURCE, KEY, APPLY_KEY, PAYLOAD, CAPACITY, context, command, install,
)


def ready(cmd=None):
    return p.prepare_foobar_import('synthetic:no-network', context(),
        command=cmd or command(), payload=PAYLOAD, intake_capacity=CAPACITY)


def apply_command(receipt, library=None):
    return a.apply_command.FoobarApplyCommand(SOURCE, GEN, APPLY_KEY,
        receipt.receipt_ref, receipt.decision_sha256, library)


def apply(cmd, ctx=None):
    return a.apply_foobar_import('synthetic:no-network', ctx or context(),
        command=cmd, intake_capacity=CAPACITY)


def forbidden(*args, **kwargs):
    raise AssertionError('Unexpected native library access')


def guard_library_io(monkeypatch):
    monkeypatch.setattr(p, '_matching_context', forbidden)
    for name in ('read_foobar_inventory_scalars_on_connection',
                 'read_foobar_preview_inventory_on_connection'):
        monkeypatch.setattr(p, name, forbidden)
    for name in ('read_foobar_taste_on_connection',
                 'apply_foobar_taste_with_postimages_on_connection',
                 'apply_foobar_taste_on_connection'):
        monkeypatch.setattr(p.taste, name, forbidden)


@pytest.mark.parametrize('library', [None, 7, 8])
def test_apply_mapping_retains_explicit_scope_in_serialized_job(library):
    cmd = a.apply_command.FoobarApplyCommand(SOURCE, GEN, APPLY_KEY,
        '44444444-4444-4444-8444-444444444444', 'a'*64, library)
    # Model the durable job payload with ordinary JSON, then the actual mapper.
    mapping = a.apply_command.apply_command_to_mapping(cmd)
    assert mapping['version'] == 'foobar_account_apply_command_v4'
    restored = a.apply_command.apply_command_from_mapping(json.loads(json.dumps(mapping)))
    assert restored == cmd and restored.matching_library_id == library
    wire = a.apply_command.apply_command_bytes(restored, account_id=1,
        library_id=library, session_id=3)
    assert json.loads(wire)[2] == library
    missing = dict(mapping); del missing['matching_library_id']
    with pytest.raises(a.apply_command.ApplyInvalid):
        a.apply_command.apply_command_from_mapping(missing)
    for invalid in (True, False, 0, -1, '7', 2**63):
        with pytest.raises(a.apply_command.ApplyInvalid):
            a.apply_command.apply_command_from_mapping(dict(mapping, matching_library_id=invalid))


def test_actual_no_library_prepare_apply_lost_ack_and_replay(monkeypatch):
    db = install(monkeypatch)
    for name in ('read_foobar_taste_on_connection', 'apply_foobar_taste_with_postimages_on_connection',
                 'apply_foobar_taste_on_connection'):
        monkeypatch.setattr(p.taste, name, forbidden)
    receipt = ready()
    cmd = apply_command(receipt)
    db.lose_ack = True
    with pytest.raises(a.FoobarApplyCommitUncertain):
        apply(cmd)
    assert db.receipt['state'] == 'committed'
    guard_library_io(monkeypatch)
    replay = apply(cmd)
    assert ready().terminal_bytes == replay.terminal_bytes
    assert db.revision == 1
    for sql in (p.source._insert_revisions_sql(), f._COMMIT_SQL):
        assert db.calls.count(sql) == 1
    assert not any('library.' in sql or 'app.track_preferences' in sql for sql in db.calls)


@pytest.mark.parametrize('changed_scope', [7, 8])
def test_changed_prepare_and_apply_scope_conflicts_before_local_authority(monkeypatch, changed_scope):
    db = install(monkeypatch)
    receipt = ready()
    guard_library_io(monkeypatch)
    start = len(db.calls)
    with pytest.raises(p.SourceStale):
        ready(replace(command(), matching_library_id=changed_scope))
    assert p.gate._KEY_SQL in db.calls[start:]
    start = len(db.calls)
    with pytest.raises(p.SourceStale):
        apply(apply_command(receipt, changed_scope))
    # Original Prepare association lookup is actually traversed with absent Apply key.
    assert db.calls[start:].count(a._APPLY_KEY_SQL) == 2
    assert db.source_row is None and db.revision == 0 and len(db.keys) == 1


def seeded_scoped_ready(db, library):
    """Seed a scope-bound durable receipt using REAL codecs/digests, not Prepare.

    This synthetic fixture deliberately has zero matched native taste targets.
    It tests recovery/replay admission, NOT optional inventory preparation.
    """
    receipt = ready()
    original = p.envelope._freeze(json.loads(db.receipt['prepared']))
    cmd = replace(command(), matching_library_id=library)
    h = list(original[1]); h[1] = library
    seals = tuple((*seal[:8], 'no_library' if library is None else 'never_decided', None)
                  for seal in original[4])
    value = (original[0], tuple(h), original[2], (), seals)
    body, prepared, decision = p.envelope.encode_prepared_envelope(value,
        original_command=cmd, expected_header=tuple(h))
    db.receipt.update(header=tuple(h), prepared=body, prepared_sha256=prepared,
                      decision_sha256=decision)
    db.keys[KEY]['command_sha256'] = p.gate.prepare_command_digest(cmd,
        account_id=1, library_id=library, session_id=3)
    return replace(receipt, prepared_sha256=prepared, decision_sha256=decision,
                   association_review=p._association_review(value)), cmd


@pytest.mark.parametrize('library', [None, 7, 8])
def test_ready_recovery_uses_hashed_original_scope_not_current_ui(monkeypatch, library):
    db = install(monkeypatch)
    receipt, cmd = seeded_scoped_ready(db, library)
    guard_library_io(monkeypatch)
    args = dict(account_id=1, session_id=3, source_ref=SOURCE, generation=GEN,
        receipt_ref=receipt.receipt_ref, prepared_sha256=receipt.prepared_sha256,
        decision_sha256=receipt.decision_sha256, command_sha256=db.keys[KEY]['command_sha256'])
    recovered, header = p.envelope.recover_prepared_command(db.receipt['prepared'], **args)
    assert recovered == cmd and header[1] == library
    for key, wrong in (('account_id', 2), ('session_id', 4),
                       ('command_sha256', 'f'*64), ('prepared_sha256', 'f'*64)):
        with pytest.raises(p.SourceUnavailable):
            p.envelope.recover_prepared_command(db.receipt['prepared'], **dict(args, **{key:wrong}))
    value = json.loads(db.receipt['prepared']); value[1][1] = 9
    corrupt = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    with pytest.raises(p.SourceUnavailable):
        p.envelope.recover_prepared_command(corrupt, **args)


@pytest.mark.parametrize('library', [7, 8])
def test_committed_optional_scope_replay_after_library_deletion(monkeypatch, library):
    db = install(monkeypatch)
    # Obtain a genuine account-source committed terminal, then explicitly seed
    # a scope-bound receipt/key. This does NOT claim optional Prepare executed.
    original_receipt = ready()
    committed = apply(apply_command(original_receipt))
    r = db.receipt
    original = replace(command(), matching_library_id=library)
    scoped_apply = apply_command(original_receipt, library)
    r['header'] = tuple(library if i == 1 else v for i,v in enumerate(r['header']))
    db.keys[KEY]['command_sha256'] = p.gate.prepare_command_digest(original,
        account_id=1, library_id=library, session_id=3)
    db.keys[APPLY_KEY]['command_sha256'] = a.apply_command.apply_command_digest(scoped_apply,
        account_id=1, library_id=library, session_id=3)
    guard_library_io(monkeypatch)
    start = len(db.calls)
    # Request has no live library, relationships or grants: original scope is data.
    assert apply(scoped_apply, context()) == committed
    assert ready(original).terminal_bytes == committed.terminal_bytes
    assert not any('library.' in sql or 'app.track_preferences' in sql for sql in db.calls[start:])
    assert db.calls.count(p.source._insert_revisions_sql()) == 1
    with pytest.raises(p.SourceStale):
        apply(replace(scoped_apply, matching_library_id=None))
    with pytest.raises(p.SourceStale):
        apply(replace(scoped_apply, request_key='55555555-5555-4555-8555-555555555555'))


def test_source_identity_excludes_local_matching_but_keeps_upload_duplicates():
    proof = p.window.prove_foobar_source_window(PAYLOAD, offset=0,
        mapping_name=p.gate.MAPPING, intake_capacity=CAPACITY)
    plan = p.lookup.plan_source_identities(proof, (False,))
    assert plan[0].identity_kind == 'path' and not plan[0].identity_conflict
    # Account identity API rejects accidental native-conflict coupling.
    with pytest.raises(p.SourceUnavailable):
        p.lookup.plan_source_identities(proof, (True,))
    payload = PAYLOAD + PAYLOAD.splitlines(keepends=True)[1]
    duplicates = p.window.prove_foobar_source_window(payload, offset=0,
        mapping_name=p.gate.MAPPING, intake_capacity=CAPACITY)
    plans = p.lookup.plan_source_identities(duplicates, (False, False))
    assert all(row.identity_kind == 'occurrence' and row.identity_conflict for row in plans)
    assert plans[0].identity_sha256 != plans[1].identity_sha256
    source = inspect.getsource(p._prepare_candidate)
    assert '_prepare_candidate(' in inspect.getsource(p._new_receipt)
    assert 'native_conflicts=tuple(False for path in proof.paths)' in source


def install_status_boundary(monkeypatch, db):
    from contextlib import contextmanager
    from music_app.services import foobar_account_import_status as status
    dispatch = db.dispatch

    @contextmanager
    def outer(url, live, *, constraints=None):
        with db.outer(url,live,matching_library_id=None,constraints=constraints) as result:
            yield result

    def status_dispatch(sql, params):
        values = json.loads(params[0])
        if sql == status._SCALAR_SQL:
            r = dict(db.receipt, prepared_null=db.receipt['prepared'] is None,
                terminal_null=db.receipt['terminal'] is None,
                prepared_size=len(db.receipt['prepared'] or b''),
                terminal_size=len(db.receipt['terminal'] or b''), observed_at=db.now)
            assert values == [1,None,SOURCE,GEN,db.receipt['receipt_ref']]
            return [{key:r[key] for key in status._SCALAR_FIELDS}]
        if sql == status._KEY_SQL:
            rows = []
            for key, stored in sorted(db.keys.items(),key=lambda pair:pair[1]['operation']):
                row = dict(stored,request_key=key,created_at=db.receipt['created_at'],
                           retired_at=None,retired_reason=None,observed_at=db.now)
                rows.append({field:row[field] for field in status._KEY_FIELDS})
            return rows
        return dispatch(sql,params)

    monkeypatch.setattr(status,'current_foobar_account_transaction',outer)
    monkeypatch.setattr(db,'dispatch',status_dispatch)
    return status


@pytest.mark.parametrize('library',[None,7,8])
def test_actual_status_recovers_ready_original_scope_without_local_io(monkeypatch, library):
    db = install(monkeypatch)
    receipt, original = seeded_scoped_ready(db,library)
    status = install_status_boundary(monkeypatch,db)
    guard_library_io(monkeypatch)
    start = len(db.calls)
    result = status.read_foobar_import_status('synthetic:no-network',context(),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert result.state == 'ready' and result.original_prepare_command == original
    assert result.terminal_bytes is None and result.apply_key is None
    assert p.gate._ROLL_SQL not in db.calls[start:]
    assert len(db.keys)==1 and db.source_row is None
    assert not any('library.' in sql or 'app.track_preferences' in sql for sql in db.calls[start:])


def test_actual_committed_status_returns_terminal_without_guessing_scope_or_new_keys(monkeypatch):
    db = install(monkeypatch)
    receipt = ready()
    result = apply(apply_command(receipt))
    status = install_status_boundary(monkeypatch,db)
    guard_library_io(monkeypatch)
    start = len(db.calls)
    recovered = status.read_foobar_import_status('synthetic:no-network',context(),
        source_ref=SOURCE,generation=GEN,receipt_ref=receipt.receipt_ref)
    assert recovered.state == 'committed'
    assert recovered.original_prepare_command is None
    assert recovered.terminal_bytes == result.terminal_bytes
    assert recovered.prepare_key == KEY and recovered.apply_key == APPLY_KEY
    assert recovered.prepare_command_sha256 == db.keys[KEY]['command_sha256']
    assert recovered.apply_command_sha256 == db.keys[APPLY_KEY]['command_sha256']
    assert p.gate._ROLL_SQL not in db.calls[start:]
    assert len(db.keys)==2 and db.revision==1
