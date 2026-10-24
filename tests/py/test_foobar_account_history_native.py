"""AUTHORED ONLY; actual policy/projection/native composition, no runtime claim."""
from copy import deepcopy
from dataclasses import asdict, replace
import inspect
import json
import pytest
from tests.py.foobar_account_history_native_testing import checked_native_driver
from tests.py.foobar_account_history_native_testing import (
    install, invoke, request, context, read_constraints, native, authority,
    inventory, root_store, readiness, match_readiness, SOURCE, OTHER_SOURCE, OBS, DECISION,
    BROWSE, MEDIA, CONFIG, PolicyEvaluationConstraints,
)


def test_eligibility_twenty_exact_public_hints_without_native_or_root_reads(monkeypatch):
    db = install(monkeypatch)
    req = request(20)
    for item in req.observations:
        db.projections[item.observation_ref] = deepcopy(db.projections[OBS])
        db.bindings[item.observation_ref] = deepcopy(db.binding)
    result = invoke(db, req=req)
    assert len(result) == 20 and all(item.can_attempt_play is True for item in result)
    wire = [asdict(item) for item in result]
    assert all(set(item) == {'observation_ref', 'can_attempt_play'} for item in wire)
    assert len(json.dumps(wire, separators=(',', ':')).encode()) <= native.MAX_ELIGIBILITY_RESPONSE_BYTES
    assert db.checkouts == db.commits == db.exits == 1 and not db.physical
    assert db.calls.count(native._PROJECTION) == db.calls.count(native._BINDING) == 20
    assert native._NATIVE_TRACK_LOCK not in db.calls and native._ROOT_SELECTOR_LOCK not in db.calls
    assert not any('local_track_files' in sql or 'settings_payload' in sql for sql in db.calls
        if sql not in (readiness._SCHEMA_SQL, match_readiness._SCHEMA_SQL))
    assert all('path' not in row and 'inventory_track_ref' not in row for row in wire)


def test_play_uses_real_native_once_fresh_root_store_same_connection(monkeypatch):
    db = install(monkeypatch)
    target = invoke(db, play=True)
    assert type(target) is native.FoobarHistoryPrivatePlayTarget
    assert asdict(target) == dict(track_ref='/native/song.flac', path='/native/song.flac',
        title='Synthetic', artist='Artist', album_title='Album', duration_seconds=12,
        inventory_track_ref='inventory-track:7:21')
    assert '/native/' not in repr(target)
    assert native.PrivateNativeTargets.__module__ == 'music_app.services.private_native_targets'
    assert native.current_library_transaction is authority.current_library_transaction
    assert db.checkouts == db.commits == db.exits == 1
    assert db.calls.count(root_store._load_library_root_settings_sql()) == 1
    assert sum(sql.startswith(inventory._INVENTORY) for sql in db.calls) == 1
    assert db.host_library != db.library
    assert db.calls.index(native._NATIVE_FILES_SIZE) < db.calls.index(native._ROOT_SELECTOR_LOCK)
    assert db.calls.index(native._ROOT_PATH_ADMISSION) < db.calls.index(root_store._load_library_root_settings_sql())
    inventory_index = next(i for i, sql in enumerate(db.calls) if sql.startswith(inventory._INVENTORY))
    assert db.calls.index(root_store._load_library_root_settings_sql()) < inventory_index
    assert sum('from app.account_sessions' in sql for sql in db.calls) == 2
    assert db.physical


@pytest.mark.parametrize('play', [False, True])
@pytest.mark.parametrize('change', ['foreign_source', 'foreign_account', 'no_library', 'no_member',
    'inactive', 'revoked', 'source_revision', 'observation_revision', 'projection_digest',
    'evidence_digest', 'display_digest', 'projection_absent'])
def test_authority_and_projection_fail_closed_before_native(monkeypatch, play, change):
    db = install(monkeypatch); req = request(); ctx = context()
    if change == 'foreign_source': req = replace(req, source_ref=OTHER_SOURCE)
    if change == 'foreign_account':
        db.account, db.session = 2, 5
        ctx = context(account=2, session=5)
    if change == 'no_library': ctx = replace(ctx, library_id=None, actor=replace(ctx.actor, current_library_id=None))
    if change == 'no_member': db.member = False
    if change == 'inactive': db.active = False
    if change == 'revoked': db.session_live = False
    if change == 'source_revision': db.sources[(1, SOURCE)] = 2
    if change == 'observation_revision': db.projections[OBS]['current_revision'] = 2
    if change == 'projection_digest': db.projections[OBS]['projection_sha256'] = '0' * 64
    if change == 'evidence_digest': db.projections[OBS]['current_effective_sha256'] = '0' * 64
    if change == 'display_digest': db.projections[OBS]['current_display_sha256'] = '0' * 64
    if change == 'projection_absent': db.projections.clear()
    with pytest.raises((native.SourceUnavailable, native.SourceStale)):
        invoke(db, req=req, ctx=ctx, play=play)
    assert native._NATIVE_TRACK_LOCK not in db.calls and not db.physical and not db.commits


@pytest.mark.parametrize('play', [False, True])
@pytest.mark.parametrize('change', ['detached', 'deleted', 'reused_key', 'rematched', 'head_version',
    'head_decision', 'head_action', 'saved_version', 'saved_decision', 'saved_track'])
def test_binding_exact_saved_and_latest_identity_never_authorizes_replacement(monkeypatch, play, change):
    db = install(monkeypatch)
    if change in ('detached', 'deleted'): db.bindings.clear()
    elif change == 'reused_key': db.binding['binding_track_id'] = 22
    elif change == 'rematched': db.binding['head_track_id'] = 22
    elif change == 'head_version': db.binding['head_version'] = 2
    elif change == 'head_decision': db.binding['head_decision'] = OTHER_SOURCE
    elif change == 'head_action': db.binding['head_action'] = 'detach'
    elif change == 'saved_version': db.binding['saved_version'] = 2
    elif change == 'saved_decision': db.binding['saved_decision'] = OTHER_SOURCE
    elif change == 'saved_track': db.binding['saved_track_id'] = 22
    if play:
        with pytest.raises(native.NativeTargetError): invoke(db, play=True)
    else:
        assert invoke(db)[0].can_attempt_play is False
    assert native._NATIVE_TRACK_LOCK not in db.calls and not db.physical


@pytest.mark.parametrize('action', [BROWSE, MEDIA])
@pytest.mark.parametrize('play', [False, True])
def test_scoped_resource_deny_does_not_leak_private_target(monkeypatch, action, play):
    db = install(monkeypatch)
    def scoped(target):
        read_constraints(target)
        return PolicyEvaluationConstraints(
            request_origin_allowed=not (target.action == action and target.resource is not None))
    if play:
        with pytest.raises(native.NativeTargetError): invoke(db, play=True, constraints=scoped)
    else:
        assert invoke(db, constraints=scoped)[0].can_attempt_play is False
    assert native._NATIVE_TRACK_LOCK not in db.calls and not db.physical


def test_current_grants_are_reread_not_taken_from_request(monkeypatch):
    db = install(monkeypatch); db.grants = (BROWSE,)
    assert invoke(db)[0].can_attempt_play is False
    assert native._NATIVE_TRACK_LOCK not in db.calls


@pytest.mark.parametrize('play', [False, True])
def test_read_narrowing_does_not_require_account_write(monkeypatch, play):
    db = install(monkeypatch); seen = []
    def constraints(target):
        seen.append(target)
        return read_constraints(target)
    result = invoke(db, play=play, constraints=constraints)
    assert result is not None
    assert any(target.action == 'account.self.foobar.read' for target in seen)
    assert not any(target.action == 'account.self.foobar.write' for target in seen)
    assert not any('for update' in sql and 'app.accounts' in sql for sql in db.calls)


@pytest.mark.parametrize('play', [False, True])
def test_final_session_revocation_never_escapes_transaction(monkeypatch, play):
    db = install(monkeypatch)
    def after(driver, sql):
        if sql == native._BINDING: driver.session_live = False
    db.after = after
    with pytest.raises(native.SourceUnavailable): invoke(db, play=play)
    assert db.commits == 0 and db.exits == 1


@pytest.mark.parametrize('failure', ['offline', 'unresolved', 'foreign_selected_root', 'foreign_host_root'])
def test_offline_or_either_root_confinement_failure_has_no_private_target(monkeypatch, failure):
    db = install(monkeypatch)
    if failure == 'offline': db.online = False
    if failure == 'unresolved': db.local = False
    if failure == 'foreign_selected_root': db.file['root_path'] = '/other'
    if failure == 'foreign_host_root': db.settings['main_library_roots'][0]['path'] = '/other'
    with pytest.raises(native.NativeTargetError): invoke(db, play=True)
    assert db.commits == 0


def test_host_settings_are_fresh_each_play_not_cached_authority(monkeypatch):
    db = install(monkeypatch)
    assert invoke(db, play=True).path == '/native/song.flac'
    db.settings['main_library_roots'][0]['path'] = '/revoked'
    with pytest.raises(native.NativeTargetError): invoke(db, play=True)
    assert db.calls.count(root_store._load_library_root_settings_sql()) == 2
    assert db.checkouts == db.exits == 2 and db.commits == 1


@pytest.mark.parametrize('sql,rows', [
    (native._NATIVE_FILES_LOCK, [{'id': i} for i in range(33)]),
    (native._NATIVE_ROOTS_LOCK, [{'id': i} for i in range(33)]),
    (native._NATIVE_TRACK_SIZE, [dict(track_key=4097, title=1, album_title=1, artist=1)]),
    (native._NATIVE_FILES_SIZE, [dict(id=31, private_path=4097, content_signature=1,
        root_path=1, root_metadata=2, file_metadata=2)]),
    (native._NATIVE_FILES_SIZE, [dict(id=31, private_path=1, content_signature=1,
        root_path=1, root_metadata=8193, file_metadata=2)]),
    (native._NATIVE_FILES_SIZE, []),
    (native._NATIVE_TRACK_LOCK, []),
])
def test_native_cardinality_width_admission_precedes_unbounded_owner_reads(monkeypatch, sql, rows):
    db = install(monkeypatch); db.overrides[sql] = rows
    with pytest.raises((native.SourceUnavailable, native.NativeTargetError)): invoke(db, play=True)
    assert not any(call.startswith(inventory._INVENTORY) for call in db.calls)
    assert root_store._load_library_root_settings_sql() not in db.calls and not db.physical
    assert all(size <= 33 for _, kind, size in db.fetches if kind == 'many')


@pytest.mark.parametrize('sql,rows', [
    (native._ROOT_SELECTOR_LOCK, []),
    (native._ROOT_SELECTOR_LOCK, [{'library_id': 99}, {'library_id': 100}]),
    (native._ROOT_SETTINGS_ADMISSION, [dict(library_id=7, payload_bytes=2, main_count=1, hoard_count=0, arrivals_count=0)]),
    (native._ROOT_SETTINGS_ADMISSION, [dict(library_id=99, payload_bytes=65537, main_count=1, hoard_count=0, arrivals_count=0)]),
    (native._ROOT_SETTINGS_ADMISSION, [dict(library_id=99, payload_bytes=2, main_count=32, hoard_count=1, arrivals_count=0)]),
    (native._ROOT_PATH_ADMISSION, [dict(path_bytes=4097)]),
    (native._ROOT_PATH_ADMISSION, []),
])
def test_root_admission_has_no_selected_library_fallback(monkeypatch, sql, rows):
    db = install(monkeypatch); db.overrides[sql] = rows
    with pytest.raises(native.SourceUnavailable): invoke(db, play=True)
    assert root_store._load_library_root_settings_sql() not in db.calls
    assert not db.physical and db.commits == 0


@pytest.mark.parametrize('count,play', [(0, False), (21, False), (2, True)])
def test_observation_cap_rejects_before_checkout(monkeypatch, count, play):
    db = install(monkeypatch)
    with pytest.raises(native.FoobarHistoryInvalid): invoke(db, req=request(count), play=play)
    assert not db.calls and db.checkouts == 0


@pytest.mark.parametrize('invalid', ['duplicate', 'bool_revision', 'future_revision', 'wrong_type'])
def test_exact_request_shapes_reject_before_checkout(monkeypatch, invalid):
    db = install(monkeypatch); req = request()
    if invalid == 'duplicate': req = replace(req, observations=req.observations * 2)
    if invalid == 'bool_revision': req = replace(req, expected_source_revision=True)
    if invalid == 'future_revision': req = replace(req, observations=(replace(req.observations[0], original_revision=2),))
    if invalid == 'wrong_type': req = asdict(req)
    with pytest.raises(native.FoobarHistoryInvalid): invoke(db, req=req)
    assert not db.calls and db.checkouts == 0


def test_unknown_driver_error_and_uncertain_exit_never_return_private_target(monkeypatch):
    db = install(monkeypatch); db.lose_ack = True
    with pytest.raises(native.SourceUnavailable): invoke(db, play=True)
    assert db.checkouts == db.exits == 1 and db.commits == 0
    assert sum(sql.startswith(inventory._INVENTORY) for sql in db.calls) == 1


@pytest.mark.parametrize('field,value', [('title', '\u00e9' * 2049), ('duration_seconds', float('nan')),
    ('duration_seconds', True), ('duration_seconds', -1)])
def test_real_native_response_is_validated_before_handoff(monkeypatch, field, value):
    db = install(monkeypatch); db.inventory[field] = value
    with pytest.raises(native.SourceUnavailable): invoke(db, play=True)
    assert db.commits == 0


def test_binding_sql_and_transaction_order_pin_no_broadening():
    assert 'read_only=True,inventory_publication_first=True' in inspect.getsource(native._resolve)
    assert 'order by z.match_version desc limit 1' in native._BINDING
    assert '(t.library_id,t.track_key)=(m.library_id,m.track_key)' in native._BINDING
    assert '(m.account_id,m.source_ref,m.observation_ref,m.library_id)' in native._BINDING
    assert 'for share of m,d,t' in native._BINDING
    assert 'octet_length(p.projection_bytes) between 1 and 8192' in native._PROJECTION
    assert native.HISTORY_NATIVE_PHASE_BYTES == 33554432
    body = inspect.getsource(native)
    assert body.count('native.resolve(') == 1
    assert not any(word in body for word in ('threading.', 'lru_cache', 'pooled_connection(', 'auth_config'))
    assert 'load_settings(connection=connection)' in body
    assert 'if play and result is None:' in body


def test_one_eligibility_hint_is_not_a_native_availability_promise(monkeypatch):
    db = install(monkeypatch); db.online = False; db.local = False
    assert invoke(db)[0].can_attempt_play is True
    assert not db.physical
    with pytest.raises(native.NativeTargetError): invoke(db, play=True)


@pytest.mark.parametrize('sql', [native._LOCK_SOURCE, native._PROJECTION, native._BINDING])
def test_bounded_driver_overflow_closes_cursor_before_unavailable(monkeypatch, sql):
    db = install(monkeypatch)
    row = {'revision': 1} if sql == native._LOCK_SOURCE else db.projections[OBS] if sql == native._PROJECTION else db.binding
    db.overrides[sql] = [deepcopy(row), deepcopy(row)]
    with pytest.raises(native.SourceUnavailable): invoke(db)
    assert db.cursors[-1].closed and not db.physical


def test_current_schema_absent_is_not_a_permission_hint(monkeypatch):
    db = install(monkeypatch)
    db.overrides[match_readiness._SCHEMA_SQL] = [{'structural_ready': False}]
    with pytest.raises(native.SourceUnavailable): invoke(db)
    assert native._LOCK_SOURCE not in db.calls and not db.physical


@pytest.mark.parametrize('play', [False, True])
def test_final_resource_policy_narrowing_is_rechecked_before_return(monkeypatch, play):
    db = install(monkeypatch); calls = 0
    def constraints(target):
        nonlocal calls
        read_constraints(target)
        if target.action == MEDIA and target.resource is not None:
            calls += 1
        # Eligibility has one initial check; real native Play adds a second.
        return PolicyEvaluationConstraints(request_origin_allowed=calls < (3 if play else 2))
    with pytest.raises(native.SourceUnavailable): invoke(db, play=play, constraints=constraints)
    assert calls == (3 if play else 2) and db.commits == 0


def test_exact_native_file_limit_is_admitted_but_never_retains_batch_targets(monkeypatch):
    db = install(monkeypatch)
    db.overrides[native._NATIVE_FILES_LOCK] = [dict(id=i) for i in range(1, 33)]
    db.overrides[native._NATIVE_FILES_SIZE] = [dict(id=i, private_path=4096, content_signature=4096,
        root_path=4096, root_metadata=8192, file_metadata=8192) for i in range(1, 33)]
    target = invoke(db, play=True)
    assert target.inventory_track_ref == 'inventory-track:7:21'
    assert sum(sql.startswith(inventory._INVENTORY) for sql in db.calls) == 1
