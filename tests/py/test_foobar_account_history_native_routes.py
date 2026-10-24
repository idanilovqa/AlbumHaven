"""AUTHORED ONLY. Real registered route/auth/CSRF/context/service/native stack."""
from dataclasses import replace
import json
import pytest
from tests.py.foobar_account_history_native_testing import checked_native_driver
from tests.py.foobar_account_history_native_testing import (
    install, context, request as native_command, native, SOURCE, OBS, BROWSE, MEDIA,
    PolicyEvaluationConstraints,
)
from tests.py.foobar_account_route_testing import request, scheduler, route
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from music_app.services import private_route_boundary as perimeter

BASE = '/integrations/foobar/account/history/native/'
PROTOCOL = 'foobar_account_history_native_v1'


def wire():
    return dict(version=PROTOCOL, source_ref=SOURCE, source_revision='1', observations=[[OBS, '1']])


def native_request(monkeypatch, handle=None, *, play=False, value=None, body=None, **kwargs):
    body = json.dumps(wire() if value is None else value, allow_nan=False).encode() if body is None else body
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    path = BASE + ('play' if play else 'eligibility')
    req.scope.update(path=path, raw_path=path.encode())
    auth.library_id = 7
    original = auth.execute
    def execute(sql, params=None):
        cursor = original(sql, params)
        if 'app.accounts.id as account_id' in sql:
            cursor.rows[0].update(current_library_id=auth.library_id,
                library_relationships=[] if auth.library_id is None else [dict(library_id=auth.library_id,
                    membership_role='member', is_primary_owner=False)],
                capability_grants=[] if auth.library_id is None else [dict(capability_key=key,
                    scope_kind='library', scope_id=auth.library_id) for key in (BROWSE, MEDIA)])
        return cursor
    monkeypatch.setattr(auth, 'execute', execute)
    req.app.state.policy_constraint_resolver = lambda target: PolicyEvaluationConstraints(
        request_origin_allowed=target.action != 'account.self.foobar.write')
    req.state.current_actor = context().actor
    marker = route.private_ui_context_ref(req)
    del req.state.current_actor
    req.scope['headers'].append((b'x-albumhaven-context', marker.encode()))
    return req, auth, reads


def endpoint(play=False):
    path = BASE + ('play' if play else 'eligibility')
    found = [item for item in route.router.routes if item.path == path]
    assert len(found) == 1 and found[0].methods == {'POST'}
    assert found[0].endpoint is (route.foobar_account_history_native_play if play
        else route.foobar_account_history_native_eligibility)
    return found[0].endpoint


def decoded(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    value = json.loads(response.body)
    assert value['protocol'] == PROTOCOL
    return value


@pytest.mark.asyncio
@pytest.mark.parametrize('play', [False, True])
async def test_registered_native_route_uses_real_owner_and_read_not_write(monkeypatch, play):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch); db.service_owner = handle.owner
    steps = scheduler(monkeypatch, handle)
    req, auth, reads = native_request(monkeypatch, handle, play=play)
    response = await endpoint(play)(req)
    value = decoded(response)
    # One JSON body receive plus one bounded disconnect probe before dispatch.
    assert response.status_code == 200 and reads[0] == 2
    assert value['operation'] == ('play' if play else 'eligibility')
    assert len(value['context_ref']) == 64 and 'context_scope' not in value
    if play:
        assert value['result'] == dict(track_ref='/native/song.flac', path='/native/song.flac',
            title='Synthetic', artist='Artist', album_title='Album', duration_seconds=12,
            inventory_track_ref='inventory-track:7:21', playback_state={'can_start_here': True})
    else:
        assert value['result'] == [dict(observation_ref=OBS, can_attempt_play=True)]
        assert not db.physical and '/native/' not in response.body.decode()
    assert len(response.body) <= route.MAX_HISTORY_NATIVE_RESPONSE_BYTES
    assert handle.owner.next_ticket == 2 and handle.owner.current is None
    assert handle.owner.thread is None and len(steps) == 1
    assert db.checkouts == db.exits == db.commits == 1


@pytest.mark.asyncio
async def test_null_native_metadata_is_preserved_without_source_labels(monkeypatch):
    db = install(monkeypatch); install_catalog(monkeypatch)
    for field in ('title', 'artist', 'album_title', 'duration_seconds'): db.inventory[field] = None
    handle, = handles(monkeypatch); scheduler(monkeypatch, handle)
    req, _, _ = native_request(monkeypatch, handle, play=True)
    response = await endpoint(True)(req)
    assert response.status_code == 200
    result = decoded(response)['result']
    assert all(result[field] is None for field in ('title', 'artist', 'album_title', 'duration_seconds'))


@pytest.mark.asyncio
@pytest.mark.parametrize('play', [False, True])
@pytest.mark.parametrize('failure', ['revoked', 'inactive', 'csrf', 'origin', 'context',
    'account_marker', 'no_library', 'policy'])
async def test_early_native_guard_failure_never_reads_or_admits(monkeypatch, play, failure):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    req, auth, reads = native_request(monkeypatch, handle, play=play, csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    if failure == 'inactive': auth.active = False
    if failure == 'no_library': auth.library_id = None
    if failure in ('context', 'account_marker'):
        req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-context']
    if failure == 'account_marker':
        req.state.current_actor = context().actor
        account_marker = route.foobar_account_ui_context_ref(req)
        del req.state.current_actor
        req.scope['headers'].append((b'x-albumhaven-foobar-context', account_marker.encode()))
    if failure == 'policy': req.app.state.policy_constraint_resolver = lambda ctx: PolicyEvaluationConstraints(request_origin_allowed=False)
    response = await endpoint(play)(req)
    assert response.status_code in (400, 401, 403, 409)
    assert 'result' not in decoded(response) and reads[0] == 0
    assert handle.owner.next_ticket == 1 and handle.owner.current is None and not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('play', [False, True])
@pytest.mark.parametrize('when', ['body', 'worker'])
@pytest.mark.parametrize('change', ['session', 'library', 'revoked', 'context'])
async def test_after_body_and_after_worker_guards_drop_changed_identity(monkeypatch, play, when, change):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, auth, reads = native_request(monkeypatch, handle, play=play)
    def changed():
        if change == 'session': auth.session_id = 4
        if change == 'library': auth.library_id = 8
        if change == 'revoked': auth.revoked = True
        if change == 'context':
            req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-context']
    if when == 'body':
        receive = req._receive
        async def after_body():
            value = await receive(); changed(); return value
        req._receive = after_body
    else:
        scheduler(monkeypatch, handle, after=changed)
    response = await endpoint(play)(req)
    assert response.status_code in (400, 401, 403, 409) and 'result' not in decoded(response)
    assert handle.owner.next_ticket == (1 if when == 'body' else 2)
    assert handle.owner.current is None
    if when == 'body': assert not db.calls
    else: assert db.checkouts == db.exits == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation', ['extra_path', 'extra_library', 'old_protocol', 'numeric_revision',
    'bool_revision', 'leading_zero', 'negative', 'zero_original', 'future_original', 'duplicate',
    'empty', 'twenty_one', 'object_observation', 'numeric_original', 'foreign_uuid_type'])
async def test_strict_native_wire_rejects_identity_injection_and_noncanonical_values(monkeypatch, mutation):
    db = install(monkeypatch); handle, = handles(monkeypatch); value = wire()
    if mutation == 'extra_path': value['path'] = '/native/song.flac'
    if mutation == 'extra_library': value['library_id'] = 7
    if mutation == 'old_protocol': value['version'] = 'foobar_account_history_v1'
    if mutation == 'numeric_revision': value['source_revision'] = 1
    if mutation == 'bool_revision': value['source_revision'] = True
    if mutation == 'leading_zero': value['source_revision'] = '01'
    if mutation == 'negative': value['source_revision'] = '-1'
    if mutation == 'zero_original': value['observations'][0][1] = '0'
    if mutation == 'future_original': value['observations'][0][1] = '2'
    if mutation == 'duplicate': value['observations'] *= 2
    if mutation == 'empty': value['observations'] = []
    if mutation == 'twenty_one': value['observations'] *= 21
    if mutation == 'object_observation': value['observations'] = [{'observation_ref': OBS, 'original_revision': '1'}]
    if mutation == 'numeric_original': value['observations'][0][1] = 1
    if mutation == 'foreign_uuid_type': value['source_ref'] = 1
    req, _, _ = native_request(monkeypatch, handle, value=value)
    response = await endpoint()(req)
    assert response.status_code == 400 and 'result' not in decoded(response)
    assert handle.owner.next_ticket == 1 and not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [b'[]', b'{}', b' ' * 12289,
    b'{"version":"foobar_account_history_native_v1","source_ref":"a","source_ref":"b"}',
    b'{"version":"foobar_account_history_native_v1","observations":NaN}'])
async def test_malformed_json_duplicate_keys_and_oversize_reject_before_dispatch(monkeypatch, body):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    req, _, _ = native_request(monkeypatch, handle, body=body)
    response = await endpoint()(req)
    assert response.status_code == 400 and 'result' not in decoded(response)
    assert not db.calls and handle.owner.next_ticket == 1


@pytest.mark.asyncio
async def test_play_rejects_more_than_one_observation_before_dispatch(monkeypatch):
    db = install(monkeypatch); handle, = handles(monkeypatch); value = wire()
    value['observations'].append([SOURCE, '1'])
    req, _, _ = native_request(monkeypatch, handle, value=value, play=True)
    response = await endpoint(True)(req)
    assert response.status_code == 400 and not db.calls and handle.owner.next_ticket == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['offline', 'uncertain', 'driver'])
async def test_failed_or_uncertain_native_play_never_dispatches_response_target_or_retries(monkeypatch, failure):
    db = install(monkeypatch); install_catalog(monkeypatch)
    if failure == 'offline': db.online = False
    if failure == 'uncertain': db.lose_ack = True
    if failure == 'driver': db.fail_sql = native._PROJECTION
    handle, = handles(monkeypatch); scheduler(monkeypatch, handle)
    req, _, _ = native_request(monkeypatch, handle, play=True)
    response = await endpoint(True)(req)
    assert response.status_code == 503 and 'result' not in decoded(response)
    assert '/native/' not in response.body.decode() and 'inventory-track:' not in response.body.decode()
    assert db.checkouts == db.exits == 1 and handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['revoked', 'csrf', 'origin'])
async def test_private_perimeter_returns_native_protocol_before_handler(monkeypatch, failure):
    req, auth, reads = native_request(monkeypatch, play=True, csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    captured, routed = {}, []
    req.app.routes = []; req.app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function): captured['call'] = function; return function
        return register
    req.app.middleware = middleware
    perimeter.install_private_route_boundary(req.app)
    async def invoke_handler(request):
        routed.append(True); return await endpoint(True)(request)
    response = await captured['call'](req, invoke_handler)
    assert response.status_code in (401, 403) and 'result' not in decoded(response)
    assert not routed and reads[0] == 0
    for suffix in ('eligibility', 'play'):
        assert perimeter.private_action_for_route('POST', BASE+suffix) == BROWSE
        assert perimeter.csrf_mode_for_route('POST', BASE+suffix) == 'session_header'
        assert not perimeter._is_public('GET', BASE+suffix)


def test_eligibility_serialization_checks_exact_order_and_bool():
    command = native_command(2)
    items = tuple(native.FoobarHistoryEligibility(item.observation_ref, True) for item in command.observations)
    for malformed in (list(items), items[:1], tuple(reversed(items)),
        (replace(items[0], can_attempt_play=1), items[1])):
        with pytest.raises(s.SourceUnavailable): route._history_native_wire(malformed, command, play=False)


def test_private_target_wire_revalidation_and_response_caps():
    target = native.FoobarHistoryPrivatePlayTarget('/native/a.flac', '/native/a.flac', None, None, None, None,
        'inventory-track:7:21')
    result = route._history_native_wire(target, native_command(), play=True)
    assert set(result) == {'track_ref', 'path', 'title', 'artist', 'album_title', 'duration_seconds',
        'inventory_track_ref', 'playback_state'}
    for malformed in (replace(target, path='/other'), replace(target, title='\u00e9'*2049),
        replace(target, duration_seconds=float('inf'))):
        with pytest.raises(s.SourceUnavailable): route._history_native_wire(malformed, native_command(), play=True)
    escaped = replace(target, title='\x01'*4096, artist='\x01'*4096, album_title='\x01'*4096)
    response = route._history_native_response({'result': route._history_native_wire(escaped, native_command(), play=True)}, 'a'*64)
    assert len(response.body) <= route.MAX_HISTORY_NATIVE_RESPONSE_BYTES == 262144
    with pytest.raises(s.SourceUnavailable):
        route._history_native_response({'result': 'x' * route.MAX_HISTORY_NATIVE_RESPONSE_BYTES}, None)
    assert route.MAX_RESPONSE_BYTES == 12288 and route.MAX_REVIEW_RESPONSE_BYTES == 65536


@pytest.mark.asyncio
async def test_media_only_narrowing_after_worker_withholds_private_target(monkeypatch):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, _, _ = native_request(monkeypatch, handle, play=True)
    def changed():
        req.app.state.policy_constraint_resolver = lambda target: PolicyEvaluationConstraints(
            request_origin_allowed=target.action != MEDIA)
    scheduler(monkeypatch, handle, after=changed)
    response = await endpoint(True)(req)
    assert response.status_code == 403 and 'result' not in decoded(response)
    assert '/native/' not in response.body.decode() and 'inventory-track:' not in response.body.decode()
    assert db.checkouts == db.exits == db.commits == 1 and handle.owner.current is None


@pytest.mark.asyncio
async def test_final_media_check_is_exact_track_not_broad_library_permission(monkeypatch):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, _, _ = native_request(monkeypatch, handle, play=True)
    media = []
    def constraints(target):
        if target.action == MEDIA:
            media.append(target.resource)
            allowed = target.resource == route.ResourceScope('track', '21')
        else:
            allowed = target.action != 'account.self.foobar.write'
        return PolicyEvaluationConstraints(request_origin_allowed=allowed)
    req.app.state.policy_constraint_resolver = constraints
    scheduler(monkeypatch, handle)
    response = await endpoint(True)(req)
    assert response.status_code == 200 and decoded(response)['result']['playback_state']['can_start_here'] is True
    # Initial resolver, real native, final resolver and refreshed route checks.
    assert len(media) >= 4 and all(scope == route.ResourceScope('track', '21') for scope in media)
    assert db.checkouts == db.exits == db.commits == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['session', 'library', 'revoked'])
async def test_identity_changes_during_final_media_authorization_are_fenced(monkeypatch, change):
    db = install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, auth, _ = native_request(monkeypatch, handle, play=True)
    changed = []
    def after_worker():
        def constraints(target):
            if target.action == MEDIA and not changed:
                assert target.resource == route.ResourceScope('track', '21')
                changed.append(change)
                if change == 'session': auth.session_id = 4
                if change == 'library': auth.library_id = 8
                if change == 'revoked': auth.revoked = True
            return PolicyEvaluationConstraints(request_origin_allowed=target.action != 'account.self.foobar.write')
        req.app.state.policy_constraint_resolver = constraints
    scheduler(monkeypatch, handle, after=after_worker)
    response = await endpoint(True)(req)
    assert changed == [change] and response.status_code in (401, 403, 409)
    assert 'result' not in decoded(response) and '/native/' not in response.body.decode()
    assert db.checkouts == db.exits == db.commits == 1 and handle.owner.current is None
