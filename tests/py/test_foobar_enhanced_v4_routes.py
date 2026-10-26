"""Authored only: actual route/auth/CSRF/service and sole receive ownership."""
import json
from dataclasses import replace

import pytest
from starlette.requests import Request
from tests.py.foobar_account_route_testing import request, route
from tests.py.foobar_account_service_testing import handles, s
from tests.py.foobar_account_job_worker_testing import sign_ui_request, running, settled_review, settled, review_sha
from tests.py.foobar_enhanced_account_v4_testing import install, RawBoundary, SOURCE, JOB, p, jobs, checked_v4_driver
from tests.py.test_foobar_enhanced_upload import FileBoundary

BODY = b'SQLite format 3\0'+b'x'*84
PATH = '/integrations/foobar/account/review/start'


def stream_boundary(monkeypatch):
    boundary = RawBoundary(monkeypatch, 1)
    boundary.fingerprint = (1, 2, len(BODY), 4, 5)
    return boundary


def wire():
    return dict(version='foobar_account_review_v4', source_ref=SOURCE, job_ref=JOB,
        matching_library_id=None, resume=False, conflict_after=0,
        previous_review_sha256=None, problem_after=0, mapping_name=p.gate.ENHANCED_MAPPING)


def incoming(monkeypatch, handle, *, value=None, body=BODY, **kwargs):
    req, auth, reads = request(monkeypatch, body, handle=handle, **kwargs)
    req.scope.update(path=PATH, raw_path=PATH.encode())
    req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'content-type'] + [
        (b'content-type', b'application/vnd.sqlite3'),
        (b'x-album-haven-foobar-bytes', str(len(body)).encode()),
        (b'x-albumhaven-foobar-command', json.dumps(wire() if value is None else value).encode())]
    sign_ui_request(req)
    return req, auth, reads


def decoded(response):
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    return json.loads(response.body)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['session', 'account', 'csrf', 'origin', 'marker'])
async def test_real_auth_csrf_context_reject_before_receiving_stream(monkeypatch, failure):
    handle, = handles(monkeypatch)
    req, auth, reads = incoming(monkeypatch, handle, csrf=failure != 'csrf',
        origin='https://other.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'session': auth.revoked = True
    if failure == 'account': auth.active = False
    if failure == 'marker':
        req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    response = await route.foobar_account_review_start(req)
    assert response.status_code in (400, 401, 403, 409)
    assert 'result' not in decoded(response) and reads[0] == 0
    assert handle.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['v3', 'missing_mapping', 'invalid_library', 'mime', 'short', 'oversize', 'duplicate_length', 'encoding'])
async def test_v4_command_and_enhanced_upload_perimeter_precede_admission(monkeypatch, failure):
    handle, = handles(monkeypatch)
    value = wire()
    if failure == 'v3': value['version'] = 'foobar_account_review_v3'
    if failure == 'missing_mapping': del value['mapping_name']
    if failure == 'invalid_library': value['matching_library_id'] = True
    req, auth, reads = incoming(monkeypatch, handle, value=value)
    if failure in ('mime', 'short', 'oversize'):
        name = b'content-type' if failure == 'mime' else b'x-album-haven-foobar-bytes'
        val = b'text/tab-separated-values' if failure == 'mime' else b'99' if failure == 'short' else b'536870913'
        req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != name]+[(name, val)]
    if failure == 'duplicate_length': req.scope['headers'].append((b'content-length', b'100'))
    if failure == 'encoding': req.scope['headers'].append((b'content-encoding', b'gzip'))
    response = await route.foobar_account_review_start(req)
    assert response.status_code == 400 and decoded(response)['error'] == 'invalid_import_request'
    assert reads[0] == 0 and handle.owner.current is None


@pytest.mark.asyncio
async def test_backpressure_does_not_poll_receive_or_lose_second_asgi_frame(monkeypatch):
    handle, = handles(monkeypatch)
    req, auth, _ = incoming(monkeypatch, handle)
    frames = [dict(type='http.request', body=BODY[:50], more_body=True),
              dict(type='http.request', body=BODY[50:], more_body=False)]
    reads, drained = [], []
    async def receive():
        reads.append(len(reads))
        assert frames, 'A second receive owner consumed past EOF'
        return frames.pop(0)
    req = Request(req.scope, receive)
    async def backpressure(delay):
        assert delay == .01 and len(reads) == 2
        assert not frames
        operation = handle.owner.current
        drained.append(operation.enhanced_channel.receive())
    monkeypatch.setattr(route.asyncio, 'sleep', backpressure)
    response = await route.foobar_account_review_start(req)
    assert response.status_code == 202 and decoded(response)['durable_start_confirmed'] is False
    channel = handle.owner.current.enhanced_channel
    drained.append(channel.receive())
    assert channel.receive() is None
    assert b''.join(drained) == BODY and len(reads) == 2
    channel.close()


@pytest.mark.asyncio
async def test_genuine_stream_stage_index_rollback_review_confirm_and_apply(monkeypatch):
    db = install(monkeypatch)
    raw = stream_boundary(monkeypatch)
    files = FileBoundary(); files.install(monkeypatch)
    with running(monkeypatch, db=db) as (_, handle, _):
        req, auth, reads = incoming(monkeypatch, handle)
        response = await route.foobar_account_review_start(req)
        assert response.status_code == 202 and reads[0] == 1
        progress = settled_review(handle)
        assert progress.phase == 'review_ready' and db.explicit_rollbacks >= 2
        assert not db.job_rows and not db.receipts and not db.source_rows
        assert files.events[-1] == 'cleanup' and raw.connection.closed == 1
        result = progress.result
        # Reupload the same finalized bytes to the actual existing job endpoint.
        value = dict(version=route.JOB_PROTOCOL, inventory_sha256=result.inventory_sha256,
            review_sha256=review_sha(progress),
            **{field:getattr(result.command, field) for field in route._JOB_COMMAND_FIELDS})
        req, auth, reads = incoming(monkeypatch, handle, value=value)
        req.scope.update(path='/integrations/foobar/account/job/start',
            raw_path=b'/integrations/foobar/account/job/start')
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 202 and reads[0] == 1
        completed = settled(handle)
        assert completed.phase == 'completed'
        assert len(db.job_rows) == len(db.source_rows) == len(db.entry_children) == 1
        assert files.events.count('cleanup') == 2 and raw.connection.closed == 2
        assert db.revision_rows == 1 and not db.bindings and not db.native_calls


@pytest.mark.asyncio
async def test_review_confirm_mismatch_preserves_only_original_durable_job_metadata(monkeypatch):
    db = install(monkeypatch)
    raw = stream_boundary(monkeypatch)
    files = FileBoundary(); files.install(monkeypatch)
    with running(monkeypatch, db=db) as (_, handle, _):
        req, _, _ = incoming(monkeypatch, handle)
        assert (await route.foobar_account_review_start(req)).status_code == 202
        progress = settled_review(handle)
        assert progress.phase == 'review_ready'
        result = progress.result
        value = dict(version=route.JOB_PROTOCOL, inventory_sha256=result.inventory_sha256,
            review_sha256='f'*64,
            **{field:getattr(result.command, field) for field in route._JOB_COMMAND_FIELDS})
        req, _, _ = incoming(monkeypatch, handle, value=value)
        response = await route.foobar_account_job_start(req)
        assert response.status_code == 202
        progress = settled(handle)
        assert progress.phase == 'needs_review'
        assert len(db.job_rows) == 1
        saved = db.job_rows[(1, SOURCE, JOB)]
        assert saved['version'] == saved['confirmed_through'] == 0
        assert saved['next_batch_no'] == 1
        assert saved['upload_sha256'] == result.command.upload_sha256
        assert not db.source_rows and not db.receipts and not db.entry_headers
        assert not db.entry_children and not db.attempts and not db.keys


@pytest.mark.asyncio
async def test_staging_cleanup_failure_cannot_publish_a_usable_review(monkeypatch):
    db = install(monkeypatch)
    stream_boundary(monkeypatch)
    files = FileBoundary(cleanup_error=True); files.install(monkeypatch)
    with running(monkeypatch, db=db) as (_, handle, _):
        req, _, _ = incoming(monkeypatch, handle)
        response = await route.foobar_account_review_start(req)
        assert response.status_code == 202
        with handle.owner.condition:
            assert handle.owner.condition.wait_for(lambda: handle.owner.state is s._State.FAULTED, timeout=5.0)
        assert handle.owner.last_review is None
        assert not handle.available
        assert not db.job_rows and not db.source_rows and not db.receipts
        assert files.events[-1] == 'cleanup'


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['view', 'source_uuid', 'observation_uuid', 'direction', 'ordinal', 'sort_range'])
async def test_genuine_enhanced_history_invalid_inputs_return400_before_worker_dispatch(monkeypatch, failure):
    from tests.py.test_foobar_account_history_routes import history_request
    handle, = handles(monkeypatch)
    value = dict(version=route.ENHANCED_HISTORY_PROTOCOL, source_ref=SOURCE, view='entries', cursor=None)
    req, _, _ = history_request(monkeypatch, handle, value=value)
    marker = next(v.decode() for k, v in req.scope['headers'] if k == b'x-albumhaven-foobar-context')
    if failure == 'view': value['view'] = 'cached_lastfm'
    elif failure == 'source_uuid': value['source_ref'] = 'bad'
    else:
        value['cursor'] = dict(context_ref=marker, source_ref=SOURCE, source_revision='1', view='entries',
            sort_key='1', observation_ref='11111111-1111-4111-8111-111111111111', ordinal='0', direction='older')
        if failure == 'observation_uuid': value['cursor']['observation_ref'] = 'bad'
        if failure == 'direction': value['cursor']['direction'] = 'sideways'
        if failure == 'ordinal': value['cursor']['ordinal'] = '32766'
        if failure == 'sort_range': value['cursor']['sort_key'] = '2534023008000000000'
    req, _, reads = history_request(monkeypatch, handle, value=value)
    req.scope.update(path='/integrations/foobar/account/history/enhanced',
        raw_path=b'/integrations/foobar/account/history/enhanced')
    response = await route.foobar_account_enhanced_history(req)
    assert response.status_code == 400
    assert decoded(response)['error'] == 'invalid_history_request'
    assert reads[0] == 1 and handle.owner.current is None and handle.owner.next_ticket == 1


def history_incoming(monkeypatch, handle, value):
    from tests.py.test_foobar_account_history_routes import history_request
    req, auth, reads = history_request(monkeypatch, handle, value=value)
    req.scope.update(path='/integrations/foobar/account/history/enhanced',
        raw_path=b'/integrations/foobar/account/history/enhanced')
    return req, auth, reads


@pytest.mark.asyncio
async def test_registered_enhanced_reader_route_preserves_wire_precision_and_cursor_context(monkeypatch):
    from tests.py import foobar_enhanced_history_v4_testing as h
    from tests.py.foobar_account_route_testing import scheduler
    from tests.py.foobar_account_service_readiness_testing import install_catalog
    db = h.install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    selected = [entry for entry in route.router.routes if entry.path == '/integrations/foobar/account/history/enhanced']
    assert len(selected) == 1 and selected[0].endpoint is route.foobar_account_enhanced_history
    rows = h.entry_rows((h.BASE+1,)*21)
    db.page(list(reversed(rows)))
    scheduler(monkeypatch, handle)
    value = dict(version=route.ENHANCED_HISTORY_PROTOCOL, source_ref=SOURCE, view='entries', cursor=None)
    req, auth, reads = history_incoming(monkeypatch, handle, value)
    response = await selected[0].endpoint(req)
    assert response.status_code == 200 and reads[0] == 2  # Body plus bounded disconnect probe.
    body = decoded(response); first = body['result']
    assert len(first['items']) == 20 and first['previous_cursor'] is None
    assert first['next_cursor']['context_ref'] == body['context_ref']
    assert first['next_cursor']['source_revision'] == '1'
    assert first['next_cursor']['ordinal'] == '1'
    assert all(item['entry']['raw_filetime_ticks'] == str(h.BASE+1) for item in first['items'])
    assert all(type(item['entry']['unix_100ns']) is str for item in first['items'])
    assert all(item['entry']['iso_utc'].endswith('0000001Z') for item in first['items'])
    assert len(response.body) <= route.MAX_HISTORY_RESPONSE_BYTES
    anchor = h.position(rows[1])
    db.page(rows[:1], anchor=anchor)
    value['cursor'] = first['next_cursor']
    req, _, _ = history_incoming(monkeypatch, handle, value)
    response = await selected[0].endpoint(req)
    assert response.status_code == 200
    last = decoded(response)['result']
    assert [item['entry']['ordinal'] for item in last['items']] == [0]
    assert last['next_cursor'] is None and last['previous_cursor']['direction'] == 'newer'
    assert not db.driver_errors and not db.pages
    h.assert_no_side_effects(db)


@pytest.mark.asyncio
@pytest.mark.parametrize('drift', ['session', 'revoked', 'marker'])
async def test_enhanced_history_post_worker_auth_context_drift_never_discloses_rows(monkeypatch, drift):
    from tests.py import foobar_enhanced_history_v4_testing as h
    from tests.py.foobar_account_route_testing import scheduler
    from tests.py.foobar_account_service_readiness_testing import install_catalog
    db = h.install(monkeypatch); install_catalog(monkeypatch)
    handle, = handles(monkeypatch)
    db.page(h.entry_rows((h.BASE,)))
    value = dict(version=route.ENHANCED_HISTORY_PROTOCOL, source_ref=SOURCE, view='entries', cursor=None)
    req, auth, reads = history_incoming(monkeypatch, handle, value)
    def after():
        if drift == 'session': auth.session_id = 4
        elif drift == 'revoked': auth.revoked = True
        else:
            req.scope['headers'][:] = [(k, v) for k, v in req.scope['headers'] if k != b'x-albumhaven-foobar-context']
    scheduler(monkeypatch, handle, after=after)
    response = await route.foobar_account_enhanced_history(req)
    assert response.status_code == {'session': 409, 'revoked': 401, 'marker': 400}[drift]
    assert 'result' not in decoded(response)
    assert handle.owner.current is None and len(db.page_calls) == 1
    assert not db.driver_errors and not db.pages


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['csrf', 'origin', 'revoked'])
async def test_actual_private_perimeter_blocks_before_enhanced_persistence_route(monkeypatch, failure):
    from music_app.services import private_route_boundary as perimeter
    handle, = handles(monkeypatch)
    req, auth, reads = incoming(monkeypatch, handle, csrf=failure != 'csrf',
        origin='https://other.invalid' if failure == 'origin' else 'https://synthetic.invalid')
    if failure == 'revoked': auth.revoked = True
    captured, routed = {}, []
    req.app.routes = []; req.app.get = lambda path: lambda function: function
    def middleware(kind):
        assert kind == 'http'
        def register(function): captured['call'] = function; return function
        return register
    req.app.middleware = middleware
    perimeter.install_private_route_boundary(req.app)
    async def next_handler(request):
        routed.append(True)
        return await route.foobar_account_review_start(request)
    response = await captured['call'](req, next_handler)
    assert response.status_code in (401, 403)
    assert not routed and reads[0] == 0 and handle.owner.current is None
    assert perimeter.private_action_for_route('POST', PATH) == 'account.self.foobar.write'
    assert perimeter.csrf_mode_for_route('POST', PATH) == 'session_header'


@pytest.mark.asyncio
async def test_enhanced_selected_library_header_is_intent_not_trusted_authority(monkeypatch):
    handle, = handles(monkeypatch)
    value = wire(); value['matching_library_id'] = 7
    req, auth, reads = incoming(monkeypatch, handle, value=value)
    response = await route.foobar_account_review_start(req)
    assert response.status_code == 202
    assert decoded(response)['durable_start_confirmed'] is False
    assert handle.owner.current is not None
    # Admission is not a match or write. Genuine worker authority and association
    # checks are exercised separately by the composed selected-library chain.


@pytest.mark.asyncio
async def test_selected_library_actual_stream_review_confirm_worker_ready_apply(monkeypatch):
    db = install(monkeypatch, library=7)
    raw = stream_boundary(monkeypatch)
    raw.aliases[0] = ('/synthetic.flac',)
    files = FileBoundary(); files.install(monkeypatch)
    with running(monkeypatch, db=db) as (_, handle, _):
        value = wire(); value['matching_library_id'] = 7
        req, auth, reads = incoming(monkeypatch, handle, value=value)
        response = await route.foobar_account_review_start(req)
        assert response.status_code == 202 and reads[0] == 1
        progress = settled_review(handle)
        assert progress.phase == 'review_ready'
        assert progress.result.command.original_matching_library_id == 7
        assert progress.result.proposed.proposed_counts[-1] == 1
        assert not db.job_rows and not db.receipts and not db.bindings
        result = progress.result
        value = dict(version=route.JOB_PROTOCOL, inventory_sha256=result.inventory_sha256,
            review_sha256=review_sha(progress),
            **{field:getattr(result.command, field) for field in route._JOB_COMMAND_FIELDS})
        req, auth, reads = incoming(monkeypatch, handle, value=value)
        req.scope.update(path='/integrations/foobar/account/job/start',
            raw_path=b'/integrations/foobar/account/job/start')
        assert (await route.foobar_account_job_start(req)).status_code == 202
        completed = settled(handle)
        assert completed.phase == 'completed'
        assert len(db.source_rows) == len(db.bindings) == len(db.entry_children) == 1
        assert files.events.count('cleanup') == 2 and raw.connection.closed == 2
        assert p._INSERT_READY_SQL in db.calls
        assert p.taste._foobar_taste_read_sql() not in db.calls
        assert p.taste._foobar_taste_write_sql() not in db.calls


@pytest.mark.parametrize('library, inventory, review_digest', [
    (None, 'a'*64, 'b'*64),
    (None, 'invalid', 'b'*64),
    (7, 'invalid', 'b'*64),
    (7, 'a'*64, 'invalid'),
])
def test_enhanced_job_invalid_inventory_or_review_never_admits_worker(
        monkeypatch, library, inventory, review_digest):
    from tests.py.foobar_account_import_jobs_testing import requested_context
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    handle, = handles(monkeypatch)
    command = jobs.FoobarJobCommand(SOURCE, JOB, 'c'*64,
        p.gate.ENHANCED_PARSER, p.gate.ENHANCED_MAPPING, library, 1, 1)
    assert inventory != p.NO_LIBRARY_INVENTORY_SHA256
    with pytest.raises(p.gate.PrepareInvalid):
        handle.begin_job(context=requested_context(library),
            constraints=PolicyEvaluationConstraints(), command=command,
            inventory_sha256=inventory, review_sha256=review_digest, length=len(BODY))
    assert handle.owner.current is None and handle.owner.next_ticket == 1
