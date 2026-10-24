"""Focused genuine service admission/dispatch and route parsing; synthetic IO."""
from contextlib import contextmanager
from dataclasses import replace
from hashlib import sha256
import pytest
from starlette.requests import Request
from music_app.services import foobar_account_import_service as service
from music_app.services import foobar_account_temporary_source as temporary
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.foobar_account_service_testing import CONFIG, context
from music_app.routes import foobar_account_import_asgi as routes

SOURCE='00000000-0000-4000-8000-000000000001'
JOB='00000000-0000-4000-8000-000000000002'
BODY=b'path\tplay_count\n/music/synthetic.flac\t2\n'


def setup(monkeypatch,enabled=True):
    monkeypatch.setattr(service,'_PROCESS_OWNER',None)
    handle=service.create_foobar_import_service(dict(CONFIG,ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED=enabled),database_url='synthetic:no-network')
    handle.owner.state=service._State.OPEN
    command=service.review.FoobarReviewRequest(SOURCE,JOB,None,False,0,None,0,service.prepare_command.MAPPING)
    identity=temporary.TemporarySourceIdentity(SOURCE,JOB,command.mapping_name,sha256(BODY).hexdigest(),len(BODY))
    return handle,command,identity


def test_retained_review_uses_existing_worker_slot_and_genuine_intake(monkeypatch,tmp_path):
    h,command,identity=setup(monkeypatch)
    ticket=h.begin_review(context=context(),constraints=PolicyEvaluationConstraints(),request=command,
        length=len(BODY),retained_identity=identity)
    op=h.owner.current
    assert op.stage is service._Stage.DISPATCH and op.enhanced_channel is None
    assert h.owner.thread is None
    path=tmp_path/'owned-source';path.write_bytes(BODY);calls=[]
    @contextmanager
    def materialize(url,ctx,**kwargs):
        assert kwargs['identity']==identity;calls.append('load')
        yield temporary.EnhancedUploadArtifact(path,identity.upload_sha256,len(BODY))
    def review(owner,operation):
        assert owner is h.owner and operation is op and operation.intake._payload==BODY
        assert operation.retained_loaded is True
        calls.append('fresh-review')
        return service.review.FoobarReviewProgress(ctx.actor.account_id,ctx.actor.session_id,command,'reviewing')
    ctx=context()
    monkeypatch.setattr(temporary,'materialize_temporary_source',materialize)
    monkeypatch.setattr(service.review,'run_foobar_review',review)
    result=service._call_once(h.owner,op)
    assert result.phase=='reviewing' and calls==['load','fresh-review']
    assert op.retained_loaded is False
    h.abandon(ticket)


@pytest.mark.parametrize('field,value',[('source_ref','00000000-0000-4000-8000-000000000003'),('job_ref','00000000-0000-4000-8000-000000000003'),('byte_length',999)])
def test_wrong_retained_identity_rejected_before_slot_allocation(monkeypatch,field,value):
    h,command,identity=setup(monkeypatch)
    with pytest.raises(service.SourceStale):
        h.begin_review(context=context(),constraints=PolicyEvaluationConstraints(),request=command,
            length=len(BODY),retained_identity=replace(identity,**{field:value}))
    assert h.owner.current is None


def test_retained_intake_rejected_when_deployment_disabled(monkeypatch):
    h,command,identity=setup(monkeypatch,False)
    with pytest.raises(service.SourceStale):
        h.begin_review(context=context(),constraints=PolicyEvaluationConstraints(),request=command,
            length=len(BODY),retained_identity=identity)
    assert h.owner.current is None


def test_real_upload_opt_in_uses_ordinary_upload_stage(monkeypatch):
    h,command,identity=setup(monkeypatch)
    ticket=h.begin_review(context=context(),constraints=PolicyEvaluationConstraints(),request=command,
        length=len(BODY),retain_source=True)
    assert h.owner.current.stage is service._Stage.INTAKE
    assert h.owner.current.retain_source is True
    h.append_prepare(ticket,BODY);h.finish_prepare(ticket)
    assert h.owner.current.intake._payload==BODY
    h.abandon(ticket)


def request(headers,body=b''):
    sent=False
    async def receive():
        nonlocal sent
        if sent:return {'type':'http.disconnect'}
        sent=True;return {'type':'http.request','body':body,'more_body':False}
    return Request({'type':'http','method':'POST','path':'/synthetic','query_string':b'',
        'headers':[(k.lower().encode(),v.encode()) for k,v in headers]},receive)


@pytest.mark.asyncio
async def test_retained_route_requires_empty_body_and_valid_explicit_identity(monkeypatch):
    _,command,identity=setup(monkeypatch)
    headers=[('Content-Type','application/octet-stream'),('Content-Length','0'),
        ('X-Album-Haven-Foobar-Bytes',str(len(BODY))),('X-AlbumHaven-Retained-Source',identity.upload_sha256)]
    length,retain,stored=await routes._temporary_upload_options(request(headers),command)
    assert (length,retain,stored)==(len(BODY),False,identity)
    with pytest.raises(routes._Invalid):await routes._temporary_upload_options(request(headers,b'unexpected'),command)


@pytest.mark.asyncio
@pytest.mark.parametrize('extra',[[('X-AlbumHaven-Retain-Source','0')],[('X-AlbumHaven-Retain-Source','1'),('X-AlbumHaven-Retain-Source','1')]])
async def test_retention_duplicate_or_invalid_consent_header_rejected(monkeypatch,extra):
    _,command,_=setup(monkeypatch)
    headers=[('Content-Type','text/tab-separated-values'),('Content-Length',str(len(BODY))),('X-Album-Haven-Foobar-Bytes',str(len(BODY)))]+extra
    with pytest.raises(routes._Invalid):await routes._temporary_upload_options(request(headers,BODY),command)


def test_temporary_metadata_route_keeps_account_permission_and_private_error_protocol():
    from music_app.services import private_route_boundary as boundary
    path='/integrations/foobar/account/temporary-source/status'
    assert boundary._PRIVATE_ROUTE_ACTIONS[('POST',path)]=='account.self.foobar.write'
    assert path in boundary._FOOBAR_ACCOUNT_PATHS
    assert boundary._foobar_response_protocol(path)=='foobar_temporary_source_v1'
    assert ('GET',path) not in boundary._PRIVATE_ROUTE_ACTIONS
