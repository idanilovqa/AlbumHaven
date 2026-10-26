"""SOURCE ONLY. Registered handlers and middleware, real auth and bounded owner.

Controlled scheduler tests do not boot ASGI or establish deployed concurrency.
Real worker tests are authored, never executed during this source-only task.
"""
from dataclasses import replace
import json

import pytest

from tests.py.foobar_account_job_discovery_testing import install, seed, listed, discovery as d, requested_context
from tests.py.foobar_account_route_testing import request, scheduler, route
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_service_readiness_testing import install_catalog
from tests.py.foobar_account_job_worker_testing import (
    sign_ui_request, running, command, submit, block_sql, settled, jobs, f, payload_rows,
)
from music_app.services import private_route_boundary as perimeter
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

PATH = '/integrations/foobar/account/job/list'
PROTOCOL = 'foobar_account_job_list_v1'


def list_request(monkeypatch, handle, *, value=None, body=None, **kwargs):
    if body is None:
        body = json.dumps(value if value is not None else dict(version=PROTOCOL,
            unfinished=False, cursor=None), allow_nan=False).encode()
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    req.scope.update(path=PATH, raw_path=PATH.encode())
    sign_ui_request(req)
    return req, auth, reads


def decode(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    value = json.loads(response.body)
    assert value['protocol'] == PROTOCOL
    return value


def registered_handler():
    entries = [entry for entry in route.router.routes if entry.path == PATH]
    assert len(entries) == 1 and entries[0].methods == {'POST'}
    assert entries[0].endpoint is route.foobar_account_job_list
    return entries[0].endpoint


@pytest.mark.asyncio
async def test_registered_list_uses_one_genuine_repository_invocation_and_retains_caches(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    # Opaque cache sentinels verify preservation; no success/authority is derived from them.
    previous_review = object()
    previous_job = s.job_worker.FoobarJobProgress(1, command(db, payload_rows(1), 1)[0], None, 'unavailable')
    handle.owner.last_review, handle.owner.last_job = previous_review, previous_job
    steps = scheduler(monkeypatch, handle)
    req, auth, reads = list_request(monkeypatch, handle)
    before = handle.owner.next_ticket
    response = await registered_handler()(req)
    value = decode(response)
    assert response.status_code == 200 and value['operation'] == 'list'
    result = value['result']
    assert result['snapshot_kind'] == 'durable_page' and result['busy'] is False
    assert len(result['items']) == 20 and result['next_cursor'] is not None
    assert set(result) == {'unfinished', 'snapshot_kind', 'busy', 'items', 'next_cursor'}
    assert handle.owner.last_review is previous_review and handle.owner.last_job is previous_job
    assert handle.owner.next_ticket == before + 1 and len(steps) == 1 and reads[0] >= 1
    assert len(db.discovery_frames) == 1 and not db.job_rows and not db.attempts
    assert len(response.body) <= route.MAX_RESPONSE_BYTES
    assert handle.owner.thread is None  # Controlled scheduler, not worker-start evidence.


@pytest.mark.asyncio
async def test_missing_discovery_indexes_only_refuses_list_without_consuming_prior_cache(monkeypatch):
    db = install(monkeypatch)
    db.discovery_catalog = [{'discovery_ready': False}]
    install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    retained = object()
    handle.owner.last_review = retained
    scheduler(monkeypatch, handle)
    req, auth, reads = list_request(monkeypatch, handle)
    response = await registered_handler()(req)
    assert response.status_code == 503 and decode(response)['error'] == 'unavailable'
    assert handle.owner.last_review is retained and not db.discovery_frames


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['session', 'context'])
async def test_response_current_session_or_ui_context_change_suppresses_page(monkeypatch, failure):
    db = install(monkeypatch)
    seed(db, 1)
    install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    req, auth, reads = list_request(monkeypatch, handle)
    def changed():
        if failure == 'session': auth.session_id = 4
        else: req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    scheduler(monkeypatch, handle, after=changed)
    response = await registered_handler()(req)
    assert response.status_code in (400, 409)
    assert 'result' not in decode(response)


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [b'{}', b'{"version":"foobar_account_job_list_v1","unfinished":1,"cursor":null}',
    b'{"version":"foobar_account_job_list_v1","unfinished":false,"unfinished":true,"cursor":null}',
    b'{"version":"foobar_account_job_list_v1","unfinished":false,"cursor":{}}',
    b'{"version":"foobar_account_job_list_v1","unfinished":false,"cursor":null,"account_id":2}',
    b'{"version":"foobar_account_job_list_v1","unfinished":NaN,"cursor":null}', b' ' * 2049])
async def test_invalid_json_never_admits_or_touches_repository(monkeypatch, body):
    db = install(monkeypatch)
    handle, = handles(monkeypatch)
    req, auth, reads = list_request(monkeypatch, handle, body=body)
    before = handle.owner.next_ticket
    response = await registered_handler()(req)
    assert response.status_code == 400 and decode(response)['error'] == 'invalid_import_request'
    assert handle.owner.next_ticket == before and handle.owner.current is None and not db.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['revoked', 'inactive', 'csrf', 'origin', 'context'])
async def test_actual_registered_perimeter_auth_csrf_context_errors_use_list_protocol(monkeypatch, failure):
    req, auth, reads = list_request(monkeypatch, None, csrf=failure != 'csrf',
        origin='https://foreign.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    if failure == 'inactive': auth.active = False
    if failure == 'context': req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    captured, routed = {}, []
    req.app.routes = []
    req.app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function):
            captured['middleware'] = function
            return function
        return register
    req.app.middleware = middleware
    perimeter.install_private_route_boundary(req.app)
    async def invoke(request):
        routed.append(True)
        return await registered_handler()(request)
    response = await captured['middleware'](req, invoke)
    assert response.status_code in (400, 401, 403, 409)
    assert 'result' not in decode(response) and reads[0] == 0
    assert routed == ([True] if failure == 'context' else [])
    assert perimeter.private_action_for_route('POST', PATH) == 'account.self.foobar.write'
    assert perimeter.csrf_mode_for_route('POST', PATH) == 'session_header'
    assert not perimeter._is_public('GET', PATH)


@pytest.mark.asyncio
async def test_busy_real_job_uses_immutable_snapshot_no_list_db_or_new_ticket(monkeypatch):
    db = install(monkeypatch)
    entered, release, unused = block_sql(monkeypatch, db, f._COMMIT_SQL)
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        payload = payload_rows(1)
        cmd, inventory = command(db, payload, 1)
        submit(handle, cmd, inventory, payload)
        assert entered.wait(3.0)
        operation, ticket = handle.owner.current, handle.owner.next_ticket
        before = tuple(db.calls)
        db.discovery_catalog = [{'discovery_ready': False}]  # Not consulted for in-process snapshot.
        req, auth, reads = list_request(monkeypatch, handle)
        response = await registered_handler()(req)
        result = decode(response)['result']
        assert response.status_code == 200 and result['busy'] is True
        assert result['snapshot_kind'] == 'in_process' and result['next_cursor'] is None
        assert len(result['items']) == 1
        item = result['items'][0]
        assert item['source_ref'] == cmd.source_ref and item['job_ref'] == cmd.job_ref
        assert item['created_at'] is item['updated_at'] is None
        assert tuple(db.calls) == before and not db.discovery_frames
        status = handle.current_job_progress(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), source_ref=cmd.source_ref, job_ref=cmd.job_ref)
        assert status.command == cmd and status.status.confirmed_through == 0
        assert tuple(db.calls) == before
        assert handle.owner.current is operation and handle.owner.next_ticket == ticket
        snapshot = handle.busy_job_discovery(context=requested_context(None),
            constraints=PolicyEvaluationConstraints(), unfinished=False)
        foreign = replace(requested_context(None), actor=replace(requested_context(None).actor,
            account_id=2, session_id=5), target_account_id=2)
        hidden = handle.busy_job_discovery(context=foreign, constraints=PolicyEvaluationConstraints(), unfinished=False)
        assert route._job_list_wire(hidden)['items'] == []
        release.set()
        final = settled(handle)
        assert final.phase == 'completed' and snapshot.confirmed_rows == 0
        assert route._job_list_wire(snapshot)['items'][0]['confirmed_rows'] == 0


def test_busy_other_operation_returns_no_retained_job_or_review_details_and_no_queue(monkeypatch):
    db = install(monkeypatch)
    handle, = handles(monkeypatch)
    context = requested_context(None)
    ticket = handle.begin_job_discovery(context=context, constraints=PolicyEvaluationConstraints(), unfinished=False)
    before = handle.owner.next_ticket
    result = handle.busy_job_discovery(context=context, constraints=PolicyEvaluationConstraints(), unfinished=False)
    assert route._job_list_wire(result) == dict(unfinished=False, snapshot_kind='in_process', busy=True,
        items=[], next_cursor=None)
    with pytest.raises(s.SourceUnavailable):
        handle.begin_job_discovery(context=context, constraints=PolicyEvaluationConstraints(), unfinished=False)
    assert handle.owner.next_ticket == before and handle.owner.current.ticket is ticket and not db.calls


@pytest.mark.parametrize('bad', ['too_many', 'nonfinite', 'duplicate', 'cursor', 'dates', 'bool_count'])
def test_public_projection_rejects_malformed_typed_pages(monkeypatch, bad):
    db = install(monkeypatch)
    seed(db, 20)
    page = listed(db)
    if bad == 'too_many': page = replace(page, items=page.items + page.items[:1])
    elif bad == 'nonfinite': page = replace(page, items=(replace(page.items[0], confirmed_rows=float('inf')),))
    elif bad == 'duplicate': page = replace(page, items=(page.items[0], page.items[0]))
    elif bad == 'cursor': page = replace(page, next_cursor=d.FoobarJobListCursor(
        page.items[0].updated_at, page.items[0].source_ref, page.items[0].job_ref))
    elif bad == 'dates': page = replace(page, items=(replace(page.items[0], created_at='not a date'),))
    elif bad == 'bool_count': page = replace(page, items=(replace(page.items[0], total_rows=True),))
    with pytest.raises((s.SourceUnavailable, d.FoobarJobListInvalid)):
        route._job_list_wire(page)


def test_list_admission_charges_retained_detail_and_review_plus_two_discovery_phases(monkeypatch):
    db = install(monkeypatch)
    handle, = handles(monkeypatch)
    handle.owner.last_review = object()
    required = (handle.owner.limits.intake_bytes + s.prepare.MAX_PRIVATE_BYTES + s.review.DETAIL_HOLD_BYTES
        + s.review.REVIEW_HOLD_BYTES + 2 * d.DISCOVERY_PHASE_BYTES
        + s.JOB_SCHEMA_PHASE_BYTES + s.JOB_DISCOVERY_SCHEMA_PHASE_BYTES
        + s.HISTORY_SCHEMA_PHASE_BYTES)
    handle.owner.limits = replace(handle.owner.limits, total_logical_bytes=required - 1)
    with pytest.raises(s.SourceUnavailable):
        handle.begin_job_discovery(context=requested_context(None), constraints=PolicyEvaluationConstraints(), unfinished=False)
    assert handle.owner.current is None
    handle.owner.limits = replace(handle.owner.limits, total_logical_bytes=required)
    handle.begin_job_discovery(context=requested_context(None), constraints=PolicyEvaluationConstraints(), unfinished=False)
    assert handle.owner.current.kind is s._Kind.JOB_LIST and handle.owner.current.intake is None


@pytest.mark.asyncio
async def test_failed_list_is_not_retried_reconciled_or_dispatched_as_import(monkeypatch):
    db = install(monkeypatch)
    install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    original, attempts = db.execute, []
    def failed(sql, params=None, **kwargs):
        if sql in d._LIST_SQL.values():
            attempts.append(sql)
            raise OSError('synthetic bounded read failure')
        return original(sql, params, **kwargs)
    monkeypatch.setattr(db, 'execute', failed)
    scheduler(monkeypatch, handle)
    req, auth, reads = list_request(monkeypatch, handle)
    response = await registered_handler()(req)
    assert response.status_code == 503 and decode(response)['error'] == 'unavailable'
    assert len(attempts) == 1 and not db.attempts and not db.job_rows
    assert not any('request_keys' in sql or 'insert ' in sql.lower() for sql in db.calls)


def test_selection_still_calls_actual_status_and_refuses_unavailable_source(monkeypatch):
    from tests.py.foobar_account_import_jobs_testing import start
    db = install(monkeypatch)
    context, cmd, batch, upload = start(db)
    try:
        # A list projection does not require source availability or confer a source lock.
        row = db.job_rows[(1, cmd.source_ref, cmd.job_ref)]
        db.discovery_rows = [dict(account_id=1, source_ref=cmd.source_ref, job_ref=cmd.job_ref,
            created_at=row['created_at'], updated_at=row['updated_at'],
            confirmed_rows=row['confirmed_through'], total_rows=row['total_rows'],
            cancel_requested=row['cancel_requested'])]
        db.sources.remove((1, cmd.source_ref))
        page = listed(db)
        assert page.items[0].job_ref == cmd.job_ref
        with pytest.raises(s.SourceStale):
            jobs.read_foobar_import_job('synthetic:no-network', context,
                source_ref=page.items[0].source_ref, job_ref=page.items[0].job_ref)
        assert db.job_rows[(1, cmd.source_ref, cmd.job_ref)] == row
    finally:
        upload.close()


@pytest.mark.asyncio
async def test_registered_perimeter_actor_failure_uses_list_protocol_without_body_or_route(monkeypatch):
    req, auth, reads = list_request(monkeypatch, None)
    captured = {}
    req.app.routes = []
    req.app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function):
            captured['middleware'] = function
            return function
        return register
    req.app.middleware = middleware
    perimeter.install_private_route_boundary(req.app)
    async def failed_actor(request):
        raise RuntimeError('private synthetic actor failure')
    async def forbidden_route(request):
        pytest.fail('Route must not execute after actor failure')
    monkeypatch.setattr(perimeter, 'current_actor_from_request', failed_actor)
    response = await captured['middleware'](req, forbidden_route)
    assert response.status_code == 503 and decode(response) == dict(protocol=PROTOCOL, error='unavailable')
    assert reads[0] == 0 and b'private synthetic' not in response.body
