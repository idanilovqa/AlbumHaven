"""Import-only admission and authenticated retirement, with synthetic IO.

Real route/auth/CSRF/policy/command/service owners; no app boot, worker thread,
raw-copy database or uploaded user file. This is not cleanup/cascade proof.
"""
import asyncio
from dataclasses import asdict, replace
from hashlib import sha256
import json
from types import SimpleNamespace

import pytest
from starlette.requests import Request
from music_app.services import foobar_account_import_service as service
from music_app.services import foobar_account_temporary_source as temporary
from music_app.services import postgres_connections
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_service_testing import CONFIG, context
from tests.py.foobar_account_route_testing import request as authenticated_request
from music_app.routes import foobar_account_import_asgi as routes

SOURCE='00000000-0000-4000-8000-000000000001'
JOB='00000000-0000-4000-8000-000000000002'
BODY=b'path\tplay_count\n/music/synthetic.flac\t2\n'
PROTOCOL='foobar_temporary_source_v1'
PATH='/integrations/foobar/account/temporary-source/status'


def setup(monkeypatch,enabled=True,*,enhanced=False):
    monkeypatch.setattr(service,'_PROCESS_OWNER',None)
    config=dict(CONFIG)
    if enabled is not None:
        config['ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED']=enabled
    handle=service.create_foobar_import_service(config,database_url='synthetic:no-network')
    handle.owner.state=service._State.OPEN
    mapping=service.prepare_command.ENHANCED_MAPPING if enhanced else service.prepare_command.MAPPING
    command=service.review.FoobarReviewRequest(SOURCE,JOB,None,False,0,None,0,mapping)
    return handle,command


def job_command(command,body=BODY):
    return service.jobs.FoobarJobCommand(SOURCE,JOB,sha256(body).hexdigest(),
        service.prepare_command.parser_for_mapping(command.mapping_name),command.mapping_name,None,1,1)


def admit(handle,command,kind,**options):
    common=dict(context=context(),constraints=PolicyEvaluationConstraints(),length=len(BODY),**options)
    if kind=='review':
        return handle.begin_review(request=command,**common)
    return handle.begin_job(command=job_command(command),inventory_sha256='a'*64,
        review_sha256='b'*64,**common)


def legacy_identity(command):
    # This is stale caller data, not an assertion that the retired DTO must stay.
    constructor=getattr(temporary,'TemporarySourceIdentity',SimpleNamespace)
    return constructor(source_ref=SOURCE,job_ref=JOB,mapping_name=command.mapping_name,
        upload_sha256=sha256(BODY).hexdigest(),byte_length=len(BODY))


@pytest.mark.parametrize('enabled',[None,False,True])
@pytest.mark.parametrize('kind',['review','job'])
@pytest.mark.parametrize('option',['retain_source','retained_identity'])
def test_stale_retention_call_rejected_before_slot_or_ticket_allocation(monkeypatch,enabled,kind,option):
    h,command=setup(monkeypatch,enabled)
    argument=True if option=='retain_source' else legacy_identity(command)
    before=h.owner.next_ticket
    try:
        with pytest.raises((service.SourceStale,service.SourceUnavailable,
                            service.prepare_command.PrepareInvalid,TypeError)) as caught:
            admit(h,command,kind,**{option:argument})
        if isinstance(caught.value,TypeError):
            assert 'unexpected keyword argument' in str(caught.value) and option in str(caught.value)
        assert h.owner.current is None and h.owner.next_ticket==before
        assert h.owner.thread is None
    finally:
        if h.owner.current is not None:
            h.abandon(h.owner.current.ticket)


@pytest.mark.parametrize('field,value',[('source_ref','00000000-0000-4000-8000-000000000003'),
    ('job_ref','00000000-0000-4000-8000-000000000003'),('byte_length',999)])
def test_wrong_retained_identity_rejected_before_slot_allocation(monkeypatch,field,value):
    h,command=setup(monkeypatch)
    identity=legacy_identity(command)
    identity=replace(identity,**{field:value}) if not isinstance(identity,SimpleNamespace) else SimpleNamespace(**(vars(identity)|{field:value}))
    before=h.owner.next_ticket
    with pytest.raises((service.SourceStale,service.SourceUnavailable,service.prepare_command.PrepareInvalid,TypeError)) as caught:
        admit(h,command,'review',retained_identity=identity)
    if isinstance(caught.value,TypeError):
        assert 'unexpected keyword argument' in str(caught.value) and 'retained_identity' in str(caught.value)
    assert h.owner.current is None and h.owner.next_ticket==before


@pytest.mark.parametrize('kind',['review','job'])
def test_ordinary_upload_keeps_genuine_intake_and_original_local_file(monkeypatch,tmp_path,kind):
    h,command=setup(monkeypatch)
    original=tmp_path/'original.tsv';original.write_bytes(BODY)
    ticket=admit(h,command,kind)
    try:
        assert h.owner.current.stage is service._Stage.INTAKE
        h.append_prepare(ticket,original.read_bytes());h.finish_prepare(ticket)
        assert h.owner.current.intake._payload==BODY
        assert h.owner.current.stage is service._Stage.DISPATCH
    finally:
        h.abandon(ticket)
    assert original.read_bytes()==BODY
    assert h.owner.current is None and h.owner.thread is None


async def route_request(monkeypatch,handle,body,*,path=PATH,headers=(),**kwargs):
    req,auth,reads=authenticated_request(monkeypatch,body,handle=handle,**kwargs)
    # Use the genuine session actor and genuine signed UI marker, not a stub.
    await routes._authorize(req)
    marker=routes.foobar_account_ui_context_ref(req)
    req.scope.update(path=path,raw_path=path.encode())
    replace_names={key for key,value in headers}
    req.scope['headers'][:]=[(key,value) for key,value in req.scope['headers'] if key not in replace_names]
    req.scope['headers'].extend(headers)
    req.scope['headers'].append((b'x-albumhaven-foobar-context',marker.encode()))
    auth.calls.clear()
    return Request(req.scope,req.receive),auth,reads


def wire_command(command,kind,body):
    if kind=='review':
        return dict(version=routes.REVIEW_PROTOCOL,source_ref=SOURCE,job_ref=JOB,
            mapping_name=command.mapping_name,matching_library_id=None,resume=False,
            conflict_after=0,problem_after=0,previous_review_sha256=None)
    return dict(version=routes.JOB_PROTOCOL,**asdict(job_command(command,body)),
        inventory_sha256=service.prepare.NO_LIBRARY_INVENTORY_SHA256,
        review_sha256='b'*64)


async def upload_request(monkeypatch,h,command,kind,body,extra=()):
    enhanced=command.mapping_name==service.prepare_command.ENHANCED_MAPPING
    return await route_request(monkeypatch,h,body,path=f'/integrations/foobar/account/{kind}/start',headers=(
        (b'content-type',b'application/vnd.sqlite3' if enhanced else b'text/tab-separated-values'),
        (b'x-album-haven-foobar-bytes',str(len(body)).encode()),
        (b'x-albumhaven-foobar-command',json.dumps(wire_command(command,kind,body)).encode()),*extra))


@pytest.mark.asyncio
@pytest.mark.parametrize('kind,operation',[('review','start'),('job','start'),('job','resume')])
@pytest.mark.parametrize('extra',[
    ((b'x-albumhaven-retain-source',b'1'),),
    ((b'x-albumhaven-retain-source',b'0'),),
    ((b'x-albumhaven-retain-source',b''),),
    ((b'x-albumhaven-retain-source',b'1'),(b'x-albumhaven-retain-source',b'1')),
    ((b'x-albumhaven-retained-source',b'a'*64),),
    ((b'x-albumhaven-retained-source',b'invalid'),),
    ((b'x-albumhaven-retained-source',b''),),
    ((b'x-albumhaven-retained-source',b'a'*64),(b'x-albumhaven-retained-source',b'a'*64)),
])
async def test_retired_upload_headers_rejected_before_body_or_admission(monkeypatch,kind,operation,extra):
    h,command=setup(monkeypatch)
    req,auth,reads=await upload_request(monkeypatch,h,command,kind,BODY,extra)
    req.scope.update(path=f'/integrations/foobar/account/{kind}/{operation}')
    before=h.owner.next_ticket
    try:
        response=await (routes._run_review(req,'start') if kind=='review' else routes._run_job(req,operation))
        assert response.status_code==400
        assert json.loads(response.body)['error']=='invalid_import_request'
        assert reads[0]==0 and h.owner.current is None and h.owner.next_ticket==before
    finally:
        if h.owner.current is not None:h.abandon(h.owner.current.ticket)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind,operation',[('review','start'),('job','start'),('job','resume')])
async def test_formerly_valid_empty_body_reuse_rejected_before_receive(monkeypatch,kind,operation):
    h,command=setup(monkeypatch)
    req,auth,reads=await upload_request(monkeypatch,h,command,kind,BODY,
        ((b'x-albumhaven-retained-source',sha256(BODY).hexdigest().encode()),))
    req.scope['headers'][:]=[(k,v) for k,v in req.scope['headers'] if k not in (b'content-type',b'content-length')]
    req.scope['headers'].extend(((b'content-type',b'application/octet-stream'),(b'content-length',b'0')))
    async def empty_receive():
        reads[0]+=1
        return {'type':'http.request','body':b'','more_body':False}
    req=Request(req.scope,empty_receive)
    before=h.owner.next_ticket
    try:
        response=await (routes._run_review(req,'start') if kind=='review' else routes._run_job(req,operation))
        assert response.status_code==400 and json.loads(response.body)['error']=='invalid_import_request'
        assert reads[0]==0 and h.owner.current is None and h.owner.next_ticket==before
    finally:
        if h.owner.current is not None:h.abandon(h.owner.current.ticket)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind,operation',[('review','start'),('job','start'),('job','resume')])
@pytest.mark.parametrize('enhanced',[False,True])
async def test_ordinary_routes_admit_real_tsv_or_enhanced_bytes_without_retention(monkeypatch,kind,operation,enhanced):
    h,command=setup(monkeypatch,enhanced=enhanced)
    body=b'SQLite format 3\0'+b'x'*84 if enhanced else BODY
    req,auth,reads=await upload_request(monkeypatch,h,command,kind,body)
    req.scope.update(path=f'/integrations/foobar/account/{kind}/{operation}')
    try:
        response=await (routes._run_review(req,'start') if kind=='review' else routes._run_job(req,operation))
        assert response.status_code==202 and reads[0]>0
        value=json.loads(response.body)
        assert value['durable_start_confirmed'] is False
        assert (value['source_ref'],value['job_ref'])==(SOURCE,JOB)
        assert h.owner.current is not None and h.owner.thread is None
        if not enhanced:assert h.owner.current.intake._payload==BODY
    finally:
        if h.owner.current is not None:h.abandon(h.owner.current.ticket)


def status_body():
    return json.dumps(dict(version=PROTOCOL,source_ref=SOURCE,job_ref=JOB)).encode()


def forbid_raw_work(monkeypatch,h):
    calls=[]
    def forbidden(*args,**kwargs):
        calls.append(True)
        raise AssertionError('Tombstone must not allocate any importer operation')
    monkeypatch.setattr(h.owner,'begin',forbidden)
    monkeypatch.setattr(postgres_connections,'pooled_connection',forbidden)
    for name in ('current_foobar_account_transaction','temporary_source_status',
                 'materialize_temporary_source','save_temporary_source'):
        if hasattr(temporary,name):monkeypatch.setattr(temporary,name,forbidden)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize('enabled',[None,False,True])
@pytest.mark.parametrize('installed',[False,True])
async def test_authenticated_tombstone_returns_no_source_without_raw_worker(monkeypatch,enabled,installed):
    h,_=setup(monkeypatch,enabled);calls=forbid_raw_work(monkeypatch,h)
    req,auth,reads=await route_request(monkeypatch,h if installed else None,status_body())
    response=await routes.foobar_account_temporary_source_status(req)
    value=json.loads(response.body)
    assert response.status_code==200 and value['source'] is None and value['protocol']==PROTOCOL
    assert response.headers['cache-control']=='private, no-store'
    assert len(value['context_ref'])==64 and value['context_scope']=='account-foobar-v1'
    assert reads[0]==1 and not calls and h.owner.current is None and h.owner.next_ticket==1
    assert sum('from app.account_sessions s' in sql for sql in auth.calls)>=2
    assert all('integration.foobar_temporary' not in sql for sql in auth.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['revoked','inactive','csrf','origin'])
async def test_tombstone_early_authority_denial_never_reads_body_or_allocates(monkeypatch,failure):
    h,_=setup(monkeypatch);calls=forbid_raw_work(monkeypatch,h)
    req,auth,reads=await route_request(monkeypatch,h,status_body())
    if failure=='revoked':auth.revoked=True
    if failure=='inactive':auth.active=False
    if failure=='csrf':req.scope['headers'][:]=[(k,v) for k,v in req.scope['headers'] if k!=b'x-album-haven-csrf']
    if failure=='origin':req.scope['headers'][:]=[(k,b'https://foreign.invalid' if k==b'origin' else v) for k,v in req.scope['headers']]
    response=await routes.foobar_account_temporary_source_status(req)
    assert response.status_code in (401,403) and 'source' not in json.loads(response.body)
    assert reads[0]==0 and not calls and h.owner.current is None


@pytest.mark.asyncio
@pytest.mark.parametrize('change,expected',[('session',409),('revoked',401),('inactive',401),('policy',403),('context',409)])
async def test_tombstone_rechecks_authority_after_awaited_body(monkeypatch,change,expected):
    h,_=setup(monkeypatch);calls=forbid_raw_work(monkeypatch,h)
    req,auth,reads=await route_request(monkeypatch,h,status_body())
    entered=asyncio.Event();release=asyncio.Event();receive=req.receive
    async def held_receive():
        entered.set();await release.wait();return await receive()
    req=Request(req.scope,held_receive)
    task=asyncio.create_task(routes.foobar_account_temporary_source_status(req))
    body_wait=asyncio.create_task(entered.wait())
    try:
        await asyncio.wait((task,body_wait),return_when=asyncio.FIRST_COMPLETED)
        assert entered.is_set(), 'Route returned before its bounded body read'
        if change=='session':auth.session_id=4
        if change=='revoked':auth.revoked=True
        if change=='inactive':auth.active=False
        if change=='policy':req.app.state.policy_constraint_resolver=lambda ctx:PolicyEvaluationConstraints(request_origin_allowed=False)
        if change=='context':req.scope['headers'][:]=[(k,b'e'*64 if k==b'x-albumhaven-foobar-context' else v) for k,v in req.scope['headers']]
        release.set();response=await task
        assert response.status_code==expected and 'source' not in json.loads(response.body)
        assert reads[0]==1 and not calls and h.owner.current is None
    finally:
        release.set()
        for pending in (task,body_wait):
            if not pending.done():pending.cancel()
        await asyncio.gather(task,body_wait,return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('patch',[{'version':'old'}, {'source_ref':'invalid'}, {'job_ref':'invalid'}, {'source_ref':None}, {'job_ref':1}])
async def test_tombstone_validates_protocol_and_uuid_without_worker(monkeypatch,patch):
    h,_=setup(monkeypatch);calls=forbid_raw_work(monkeypatch,h)
    value=dict(version=PROTOCOL,source_ref=SOURCE,job_ref=JOB);value.update(patch)
    req,auth,reads=await route_request(monkeypatch,h,json.dumps(value).encode())
    response=await routes.foobar_account_temporary_source_status(req)
    assert response.status_code==400 and json.loads(response.body)['error']=='invalid_import_request'
    assert not calls and h.owner.current is None


def test_temporary_metadata_route_keeps_account_permission_and_private_error_protocol():
    from music_app.services import private_route_boundary as boundary
    path='/integrations/foobar/account/temporary-source/status'
    assert boundary._PRIVATE_ROUTE_ACTIONS[('POST',path)]=='account.self.foobar.write'
    assert path in boundary._FOOBAR_ACCOUNT_PATHS
    assert boundary._foobar_response_protocol(path)=='foobar_temporary_source_v1'
    assert ('GET',path) not in boundary._PRIVATE_ROUTE_ACTIONS
