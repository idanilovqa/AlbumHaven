"""AUTHORED ONLY. Real registered handlers/auth/CSRF/context/service/reader.

Only SQL driver rows and deterministic worker scheduling are controlled. No
application boot, browser, network, product imports or test run occurred here.
"""
from dataclasses import replace
import json
import pytest
from tests.py.foobar_account_history_testing import (
    install, seed, listed, history, read_context, read_only, SOURCE, OTHER_SOURCE,
)
from tests.py.foobar_account_route_testing import request, scheduler, route
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.foobar_account_job_worker_testing import sign_ui_request
from music_app.services import private_route_boundary as perimeter

PROTOCOL = 'foobar_account_history_v1'
BASE = '/integrations/foobar/account/history/'


def history_request(monkeypatch, handle=None, *, sources=False, value=None, body=None, **kwargs):
    if body is None:
        value = value if value is not None else dict(version=PROTOCOL, cursor=None)
        if not sources and set(value) == {'version', 'cursor'}:
            value.update(source_ref=SOURCE, family='standard', mode='individual')
        body = json.dumps(value, allow_nan=False).encode()
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    path = BASE + ('sources' if sources else 'list')
    req.scope.update(path=path, raw_path=path.encode())
    req.app.state.policy_constraint_resolver = read_only
    original = auth.execute
    def no_library(sql, params=None):
        cursor = original(sql, params)
        if 'app.accounts.id as account_id' in sql:
            cursor.rows[0].update(current_library_id=None, library_relationships=[], capability_grants=[])
        return cursor
    monkeypatch.setattr(auth, 'execute', no_library)
    sign_ui_request(req, ctx=read_context())
    return req, auth, reads


def decoded(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    value = json.loads(response.body)
    assert value['protocol'] == PROTOCOL
    return value


def endpoint(sources=False):
    path = BASE + ('sources' if sources else 'list')
    found = [entry for entry in route.router.routes if entry.path == path]
    assert len(found) == 1 and found[0].methods == {'POST'}
    assert found[0].endpoint is (route.foobar_account_history_sources if sources else route.foobar_account_history_list)
    return found[0].endpoint


@pytest.mark.asyncio
@pytest.mark.parametrize('sources', [False, True])
async def test_registered_read_route_needs_no_library_or_write_and_uses_one_real_query(monkeypatch, sources):
    db = install(monkeypatch); seed(db)
    install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    old_review = object(); handle.owner.last_review = old_review
    steps = scheduler(monkeypatch, handle)
    req, auth, reads = history_request(monkeypatch, handle, sources=sources)
    response = await endpoint(sources)(req)
    data = decoded(response)
    # One JSON body receive plus one bounded disconnect probe before dispatch.
    assert response.status_code == 200 and reads[0] == 2
    assert data['operation'] == ('sources' if sources else 'history')
    assert data['context_scope'] == 'account-foobar-v1' and len(data['context_ref']) == 64
    assert handle.owner.next_ticket == 2 and handle.owner.current is None and len(steps) == 1
    assert handle.owner.last_review is old_review and handle.owner.thread is None
    assert not db.native_calls and not db.association_calls and not db.job_rows
    assert req.state.current_actor.current_library_id is None
    assert not any('insert ' in sql.lower() or 'update integration.' in sql.lower() for sql in db.calls)
    if not sources:
        result = data['result']
        assert result['source_revision'] == '1' and len(result['items']) == 20
        assert result['next_cursor']['context_ref'] == data['context_ref']
        assert 'account_id' not in result['next_cursor']
        assert set(result['items'][0]) == {'observation_ref', 'kind', 'projection'}
        assert result['items'][0]['projection']['total'] == '2'
        assert result['items'][0]['projection']['aggregate_remainder'] == '1'
    assert len(response.body) <= route.MAX_HISTORY_RESPONSE_BYTES
    assert route.MAX_RESPONSE_BYTES == 12288 and route.MAX_REVIEW_RESPONSE_BYTES == 65536


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['revoked', 'inactive', 'csrf', 'origin', 'context', 'policy'])
async def test_early_auth_csrf_and_context_failure_never_reads_body_or_admits(monkeypatch, failure):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    req, auth, reads = history_request(monkeypatch, handle, csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    if failure == 'inactive': auth.active = False
    if failure == 'context': req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    if failure == 'policy': req.app.state.policy_constraint_resolver = lambda ctx: s.PolicyEvaluationConstraints(request_origin_allowed=False)
    response = await endpoint()(req)
    assert response.status_code in (400, 401, 403, 409)
    assert 'result' not in decoded(response) and reads[0] == 0
    assert handle.owner.next_ticket == 1 and handle.owner.current is None and not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('when', ['body', 'worker'])
@pytest.mark.parametrize('change', ['session', 'context'])
async def test_authority_and_signed_context_are_rechecked_after_each_await(monkeypatch, when, change):
    db = install(monkeypatch); seed(db, 1); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, auth, reads = history_request(monkeypatch, handle)
    def changed():
        if change == 'session': auth.session_id = 4
        else: req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    if when == 'body':
        receive = req._receive
        async def after_body():
            result = await receive(); changed(); return result
        req._receive = after_body
    else:
        scheduler(monkeypatch, handle, after=changed)
    response = await endpoint()(req)
    assert response.status_code in (400, 409) and 'result' not in decoded(response)
    assert handle.owner.next_ticket == (1 if when == 'body' else 2)
    if when == 'body': assert not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [b'{}', b'[]', b' ' * 2049,
    b'{"version":"foobar_account_history_v1","cursor":null,"cursor":null}',
    b'{"version":"foobar_account_history_v1","cursor":{},"account_id":2}',
    b'{"version":"foobar_account_import_v3","cursor":null}',
    b'{"version":"foobar_account_history_v1","cursor":NaN}',
])
async def test_strict_history_wire_rejects_duplicate_extra_old_protocol_and_oversize(monkeypatch, body):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    req, auth, reads = history_request(monkeypatch, handle, body=body)
    response = await endpoint()(req)
    assert response.status_code == 400 and decoded(response)['error'] == 'invalid_history_request'
    assert handle.owner.next_ticket == 1 and handle.owner.current is None and not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation', ['account_id', 'context', 'source', 'family', 'mode', 'revision_numeric'])
async def test_public_cursor_cannot_supply_account_authority_or_change_selection(monkeypatch, mutation):
    db = install(monkeypatch); seed(db)
    page = listed(db)
    handle, = handles(monkeypatch)
    req, auth, reads = history_request(monkeypatch, handle)
    marker = next(value.decode() for key, value in req.scope['headers'] if key == b'x-albumhaven-foobar-context')
    cursor = route._history_cursor_wire(page.next_cursor, marker, sources=False)
    if mutation == 'account_id': cursor['account_id'] = 2
    if mutation == 'context': cursor['context_ref'] = '0' * 64
    if mutation == 'source': cursor['source_ref'] = OTHER_SOURCE
    if mutation == 'family': cursor['family'] = 'enhanced'
    if mutation == 'mode': cursor['mode'] = 'grouped'
    if mutation == 'revision_numeric': cursor['source_revision'] = 1
    value = dict(version=PROTOCOL, cursor=cursor, source_ref=SOURCE, family='standard', mode='individual')
    req, auth, reads = history_request(monkeypatch, handle, value=value)
    before = tuple(db.calls)
    response = await endpoint()(req)
    assert response.status_code in (400, 409) and 'result' not in decoded(response)
    assert handle.owner.next_ticket == 1 and tuple(db.calls) == before


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['revoked', 'csrf', 'origin', 'context'])
async def test_real_private_perimeter_uses_dedicated_history_protocol(monkeypatch, failure):
    req, auth, reads = history_request(monkeypatch, csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    if failure == 'context': req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    captured, routed = {}, []
    req.app.routes = []; req.app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function): captured['call'] = function; return function
        return register
    req.app.middleware = middleware
    perimeter.install_private_route_boundary(req.app)
    async def invoke(request):
        routed.append(True); return await endpoint()(request)
    response = await captured['call'](req, invoke)
    assert response.status_code in (400, 401, 403, 409) and 'result' not in decoded(response)
    assert reads[0] == 0 and routed == ([True] if failure == 'context' else [])
    for suffix in ('sources', 'list'):
        assert perimeter.private_action_for_route('POST', BASE + suffix) == 'account.self.foobar.read'
        assert perimeter.csrf_mode_for_route('POST', BASE + suffix) == 'session_header'
        assert not perimeter._is_public('GET', BASE + suffix)


@pytest.mark.asyncio
async def test_history_read_failure_is_one_attempt_without_import_retry_or_queue(monkeypatch):
    db = install(monkeypatch); seed(db); install_catalog(monkeypatch)
    db.fail_sql = history._LIST_SQL[('standard', 'individual', None)]
    handle, = handles(monkeypatch); scheduler(monkeypatch, handle)
    req, auth, reads = history_request(monkeypatch, handle)
    response = await endpoint()(req)
    assert response.status_code == 503 and decoded(response)['error'] == 'unavailable'
    assert db.calls.count(db.fail_sql) == 1 and handle.owner.next_ticket == 2
    assert not any('request_keys' in sql for sql in db.calls)
    assert not db.job_rows and not db.attempts


def test_busy_slot_cannot_borrow_cached_review_or_add_history_queue(monkeypatch):
    db = install(monkeypatch); handle, = handles(monkeypatch)
    cached = object(); handle.owner.last_review = cached
    request = history.FoobarHistoryRequest(SOURCE, 'standard', 'grouped')
    ticket = handle.begin_history(context=read_context(), constraints=read_only, request=request)
    serial = handle.owner.next_ticket
    with pytest.raises(s.SourceUnavailable):
        handle.begin_history_sources(context=read_context(), constraints=read_only)
    assert handle.owner.current.ticket is ticket and handle.owner.next_ticket == serial
    assert handle.owner.last_review is cached and not db.calls and handle.owner.thread is None


@pytest.mark.parametrize('sources', [False, True])
def test_admission_retains_cached_review_reservations_and_exact_two_read_phases(monkeypatch, sources):
    handle, = handles(monkeypatch)
    retained = object(); handle.owner.last_review = retained
    phase = history.HISTORY_SOURCE_LIST_PHASE_BYTES if sources else history.HISTORY_READ_PHASE_BYTES
    required = (handle.owner.limits.intake_bytes + s.prepare.MAX_PRIVATE_BYTES + s.review.DETAIL_HOLD_BYTES
        + s.review.REVIEW_HOLD_BYTES + 2 * phase + s.HISTORY_SCHEMA_PHASE_BYTES)
    handle.owner.limits = replace(handle.owner.limits, total_logical_bytes=required - 1)
    def begin():
        if sources: return handle.begin_history_sources(context=read_context(), constraints=read_only)
        return handle.begin_history(context=read_context(), constraints=read_only,
            request=history.FoobarHistoryRequest(SOURCE, 'standard', 'grouped'))
    with pytest.raises(s.SourceUnavailable): begin()
    assert handle.owner.current is None and handle.owner.next_ticket == 1
    handle.owner.limits = replace(handle.owner.limits, total_logical_bytes=required)
    begin()
    assert handle.owner.current.intake is None and handle.owner.last_review is retained


def test_history_json_cap_is_independent_and_rejects_overflow():
    assert route.MAX_HISTORY_RESPONSE_BYTES == 131072
    response = route._history_response({'result': 'x' * 12288}, 'a' * 64)
    assert len(response.body) > route.MAX_RESPONSE_BYTES and response.status_code == 200
    with pytest.raises(s.SourceUnavailable):
        route._history_response({'result': 'x' * 131072}, 'a' * 64)
