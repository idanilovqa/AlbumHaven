"""Account-owned Foobar ingress adapter, gated by server service readiness.

One exact command/key crosses the worker boundary. This adapter neither retries
mutations nor invents replacement keys. Durable recovery belongs to the account
protocol, not HTTP cancellation. No configuration value is request supplied.
"""
import asyncio
import json
import hmac

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from music_app.services import foobar_account_import_service as service_owner
from music_app.services import foobar_account_import_review as review_owner
from music_app.services.foobar_account_ui_context import (
    foobar_account_ui_context_ref, FOOBAR_ACCOUNT_CONTEXT_SCOPE,
)
from music_app.services import foobar_account_prepare_gate as prepare_command
from music_app.services import foobar_account_apply_command as apply_command
from music_app.services import foobar_account_import_prepare as prepare
from music_app.services import foobar_account_import_apply as apply
from music_app.services import foobar_account_import_status as status
from music_app.services import foobar_account_import_terminal as terminal_codec
from music_app.services import foobar_account_match_decisions as match_decisions
from music_app.services.foobar_default_source import AccountFoobarSourceSelection
from music_app.services.foobar_account_authority import require_account_foobar
from music_app.services.foobar_account_authority import require_account_foobar_read
from music_app.services import foobar_account_history_projection as history_projection
from music_app.services.foobar_account_history_postgres import FoobarHistoryInvalid
from music_app.services.foobar_account_source_postgres import SourceUnavailable, SourceStale
from music_app.services.foobar_snapshot_parser import MAX_INPUT_BYTES
from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.policy import PolicyContext, ResourceScope
from music_app.services.policy_asgi import require_action, _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import _valid_session_csrf
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError

router=APIRouter()
PROTOCOL='foobar_account_import_v4'
MAX_COMMAND_BYTES=2048
# At most 100 bounded association-review tuples plus the exact recovered
# command and receipt. This HTTP projection is separate from terminal's 669
# byte persistence cap and the worker's fixed prepared-memory ceiling.
MAX_RESPONSE_BYTES=12288
MAX_REVIEW_RESPONSE_BYTES=65536
MAX_OBSERVATION_RESPONSE_BYTES=131072
_HEADERS={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}
_STATUS_FIELDS=frozenset(('version','source_ref','generation','receipt_ref'))


class _Invalid(ValueError):
    pass


def _response(value, code=200, *, maximum=MAX_RESPONSE_BYTES):
    body=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if maximum not in (MAX_RESPONSE_BYTES,MAX_REVIEW_RESPONSE_BYTES,MAX_OBSERVATION_RESPONSE_BYTES) or len(body)>maximum:
        raise SourceUnavailable()
    return Response(body,status_code=code,media_type='application/json',headers=_HEADERS)


def _error(code, http_status):
    return _response({'protocol':PROTOCOL,'error':code},http_status)


def _integer(text):
    if (not 1<=len(text)<=19 or not text.isascii() or not text.isdecimal()
            or len(text)>1 and text[0]=='0'):
        raise _Invalid()
    return int(text)


def _reject(*unused):
    raise _Invalid()


def _request_uuid(value):
    try:
        return prepare_command._uuid(value)
    except (ValueError,TypeError,AttributeError):
        return False


def _pairs(pairs,*,maximum=10,boolean_fields=(),array_fields=(),object_fields=()):
    if len(pairs)>maximum:
        raise _Invalid()
    result={}
    for key,value in pairs:
        if (type(key) is not str or key in result
                or type(value) not in (str,int,type(None)) and not (
                    type(value) is bool and key in boolean_fields) and not (
                    type(value) is list and key in array_fields) and not (
                    type(value) is dict and key in object_fields)):
            raise _Invalid()
        result[key]=value
    return result


def _command_json(payload,*,kind=None):
    if type(payload) is not bytes or not 1<=len(payload)<=MAX_COMMAND_BYTES:
        raise _Invalid()
    try:
        if kind not in (None,'job','review','personal','job-list','history','history-native'):
            raise _Invalid()
        hook=lambda pairs:_pairs(pairs,maximum=11 if kind in ('job','review') else 10,
            boolean_fields=('resume',) if kind=='review' else ('unfinished',) if kind=='job-list' else (),
            array_fields=('choices',) if kind=='personal' else ('observations',) if kind=='history-native' else (),
            object_fields=('cursor',) if kind in ('job-list','history') else ('observation_raw',) if kind=='review' else ())
        value=json.loads(payload.decode('utf-8'),object_pairs_hook=hook,
            parse_int=_integer,parse_float=_reject,parse_constant=_reject)
    except (ValueError,TypeError,UnicodeError,RecursionError,OverflowError):
        raise _Invalid() from None
    if type(value) is not dict:
        raise _Invalid()
    return value


def _one_header(request,name,*,required=False):
    values=request.headers.getlist(name)
    if len(values)>1 or required and len(values)!=1:
        raise _Invalid()
    return values[0] if values else None


def _content(request, *, upload):
    if request.scope.get('query_string',b'')!=b'':
        raise _Invalid()
    if _one_header(request,'content-encoding') is not None:
        raise _Invalid()
    content=_one_header(request,'content-type',required=True)
    allowed=('text/tab-separated-values','text/tab-separated-values;charset=utf-8') if upload else (
        'application/json','application/json;charset=utf-8')
    if len(content)>128 or content.lower().replace(' ','') not in allowed:
        raise _Invalid()
    length=_one_header(request,'content-length')
    return None if length is None else _integer(length)


def _persistence_upload_length(request,*,enhanced):
    if enhanced:
        if (request.scope.get('query_string',b'')!=b''
                or _one_header(request,'content-encoding') is not None
                or _one_header(request,'content-type',required=True)!='application/vnd.sqlite3'):
            raise _Invalid()
        supplied=_one_header(request,'content-length')
        content_length=None if supplied is None else _integer(supplied)
        minimum,maximum=100,service_owner.enhanced_upload.MAX_UPLOAD_BYTES
    else:
        content_length=_content(request,upload=True)
        minimum,maximum=1,MAX_INPUT_BYTES
    declared=_integer(_one_header(request,'x-album-haven-foobar-bytes',required=True))
    if not minimum<=declared<=maximum or content_length is not None and content_length!=declared:
        raise _Invalid()
    return declared


async def _temporary_upload_options(request,command):
    retain=_one_header(request,'x-albumhaven-retain-source')
    stored=_one_header(request,'x-albumhaven-retained-source')
    if retain not in (None,'1'):
        raise _Invalid()
    enhanced=command.mapping_name==prepare_command.ENHANCED_MAPPING
    if stored is None:
        return _persistence_upload_length(request,enhanced=enhanced),retain=='1',None
    if (not prepare_command._hex(stored) or request.scope.get('query_string',b'')!=b''
            or _one_header(request,'content-encoding') is not None
            or _one_header(request,'content-type',required=True)!='application/octet-stream'
            or _one_header(request,'content-length') not in (None,'0')):
        raise _Invalid()
    length=_integer(_one_header(request,'x-album-haven-foobar-bytes',required=True))
    if not (100 if enhanced else 1)<=length<=(service_owner.enhanced_upload.MAX_UPLOAD_BYTES if enhanced else MAX_INPUT_BYTES):
        raise _Invalid()
    async def empty():
        async for chunk in request.stream():
            if chunk:
                raise _Invalid()
    await asyncio.wait_for(empty(),timeout=10)
    identity=service_owner.temporary_source.TemporarySourceIdentity(command.source_ref,command.job_ref,
        command.mapping_name,stored,length)
    return length,False,identity


async def _json_body(request,*,kind=None):
    length=_content(request,upload=False)
    if length is not None and not 1<=length<=MAX_COMMAND_BYTES:
        raise _Invalid()
    body=bytearray()
    async for chunk in request.stream():
        if type(chunk) is not bytes or len(body)+len(chunk)>MAX_COMMAND_BYTES:
            raise _Invalid()
        body.extend(chunk)
    if length is not None and len(body)!=length:
        raise _Invalid()
    return _command_json(bytes(body),kind=kind)


async def _authorize(request):
    await require_action('account.self.foobar.write',refresh_actor=True)(request)
    if not _valid_session_csrf(request):
        raise HTTPException(status_code=403,detail='Action not permitted.')
    actor=request.state.current_actor
    # Preserve the actual request actor's selection solely so the native
    # optional matching owner can verify an explicitly requested local effect.
    # Account source/status owners independently erase ambient library power.
    context=PolicyContext.build(actor=actor,action='account.self.foobar.write',
        target_account_id=actor.account_id,library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver=getattr(request.app.state,'policy_constraint_resolver',None)
    # Preserve the actual server-owned resolver, as native_activity_context
    # does. Do not snapshot its answer or wrap it in a Request-capturing closure;
    # native account/matching owners evaluate it against their current context.
    constraints=resolver if callable(resolver) else PolicyEvaluationConstraints()
    require_account_foobar(context,constraints)
    return context,constraints,(actor.account_id,actor.session_id)


def _terminal(payload):
    if type(payload) is not bytes or not 1<=len(payload)<=terminal_codec.MAX_WIRE_BYTES:
        raise SourceUnavailable()
    try:
        record=tuple(json.loads(payload.decode('ascii'),parse_int=_integer,
                                parse_float=_reject,parse_constant=_reject))
        terminal_codec._record(record)
        if terminal_codec.encode_foobar_terminal(record)!=payload:
            raise SourceUnavailable()
    except Exception:
        raise SourceUnavailable() from None
    return record


def _receipt_wire(kind,receipt):
    """Explicit native result projection; never dataclass-asdict of internals."""
    if kind=='match-preview':
        if type(receipt) is not match_decisions.FoobarMatchPreview:
            raise SourceUnavailable()
        command=_match_command_wire(receipt.command)
        if not prepare_command._integer(receipt.next_match_version,1,prepare_command._MAX):
            raise SourceUnavailable()
        if (receipt.command.expected_match_version is not None
                and receipt.next_match_version<=receipt.command.expected_match_version):
            raise SourceUnavailable()
        replay=None if receipt.replay is None else _match_decision_wire(receipt.replay)
        if replay is not None and (replay['command']!=command
                                  or replay['match_version']!=receipt.next_match_version):
            raise SourceUnavailable()
        return {'command':command,'next_match_version':receipt.next_match_version,'replay':replay}
    if kind=='match-apply':
        return _match_decision_wire(receipt)
    if kind=='source':
        if type(receipt) is not AccountFoobarSourceSelection:
            raise SourceUnavailable()
        if (not prepare_command._uuid(receipt.source_ref)
                or not prepare_command._integer(receipt.generation,1,2147483647)
                or not prepare_command._integer(receipt.source_revision,0,prepare_command._MAX)
                or receipt.ownership_protocol!='foobar_account_source_v2'):
            raise SourceUnavailable()
        return {'source_ref':receipt.source_ref,'generation':receipt.generation,
                'source_revision':receipt.source_revision,'ownership_protocol':receipt.ownership_protocol}
    expected={'prepare':prepare.FoobarPreparedReceipt,'apply':apply.FoobarAppliedReceipt,
              'status':status.FoobarReceiptStatus}.get(kind)
    if expected is None or type(receipt) is not expected:
        raise SourceUnavailable()
    if (not prepare_command._uuid(receipt.source_ref) or not prepare_command._uuid(receipt.receipt_ref)
            or not prepare_command._integer(receipt.generation,1,2147483647)):
        raise SourceUnavailable()
    result={'source_ref':receipt.source_ref,'generation':receipt.generation,
            'receipt_ref':receipt.receipt_ref,'expires_at':prepare._utc(receipt.expires_at)}
    if kind=='apply':
        result.update(state='committed',terminal=_terminal(receipt.terminal_bytes))
        return result
    for field in ('prepared_sha256','decision_sha256'):
        value=getattr(receipt,field)
        if not prepare_command._hex(value):
            raise SourceUnavailable()
        result[field]=value
    if kind=='prepare':
        if (not prepare_command._integer(receipt.total_rows,1,100000)
                or not prepare_command._integer(receipt.window_start,1,receipt.total_rows)
                or not prepare_command._integer(receipt.window_end,receipt.window_start+1,
                                                min(receipt.total_rows+1,receipt.window_start+100))):
            raise SourceUnavailable()
        result.update(state='committed' if receipt.terminal_bytes is not None else 'ready',
            window_start=receipt.window_start,window_end=receipt.window_end,total_rows=receipt.total_rows,
            terminal=None if receipt.terminal_bytes is None else _terminal(receipt.terminal_bytes))
        result['association_review']=_association_review(receipt.association_review,
            committed=receipt.terminal_bytes is not None,
            start=receipt.window_start,end=receipt.window_end)
        return result
    if receipt.state not in ('ready','committed'):
        raise SourceUnavailable()
    if (not prepare_command._uuid(receipt.prepare_key)
            or not prepare_command._hex(receipt.prepare_command_sha256)):
        raise SourceUnavailable()
    result.update(state=receipt.state,prepare_key=receipt.prepare_key,
        prepare_command_sha256=receipt.prepare_command_sha256,
        apply_key=receipt.apply_key,apply_command_sha256=receipt.apply_command_sha256)
    if receipt.state=='ready':
        if (receipt.apply_key is not None or receipt.apply_command_sha256 is not None
                or receipt.terminal_bytes is not None or receipt.terminal_outcome is not None):
            raise SourceUnavailable()
        result['original_prepare_command']=prepare_command.prepare_command_to_mapping(receipt.original_prepare_command)
        result['terminal']=None
        result['association_review']=_association_review(receipt.association_review,committed=False,
            start=receipt.original_prepare_command.offset+1)
    else:
        if (receipt.original_prepare_command is not None or not prepare_command._uuid(receipt.apply_key)
                or not prepare_command._hex(receipt.apply_command_sha256)):
            raise SourceUnavailable()
        terminal=_terminal(receipt.terminal_bytes)
        if terminal!=receipt.terminal_outcome:
            raise SourceUnavailable()
        result.update(original_prepare_command=None,terminal=terminal)
        result['association_review']=_association_review(receipt.association_review,committed=True)
    return result


def _association_review(value,*,committed,start=None,end=None):
    if committed:
        if value is not None:
            raise SourceUnavailable()
        return None
    if (type(value) is not tuple or not 1<=len(value)<=100
            or not prepare_command._integer(start,1,100000)
            or end is not None and len(value)!=end-start):
        raise SourceUnavailable()
    seen=set()
    for offset,row in enumerate(value):
        if (type(row) is not tuple or len(row)!=4
                or type(row[0]) is not int or row[0]!=start+offset
                or not prepare_command._uuid(row[1]) or row[1] in seen
                or row[2] not in ('saved','explicit_detach','availability_lost',
                                  'never_decided','no_library')
                or type(row[3]) is not bool
                or row[3] and row[2] not in ('saved','never_decided')):
            raise SourceUnavailable()
        seen.add(row[1])
    return value


def _match_command_wire(command):
    try:
        return match_decisions.command_to_mapping(command)
    except Exception:
        # Malformed trusted native output is not a malformed client command.
        raise SourceUnavailable() from None


def _match_decision_wire(receipt):
    if type(receipt) is not match_decisions.FoobarMatchDecision:
        raise SourceUnavailable()
    command=match_decisions.FoobarMatchDecisionCommand(
        receipt.source_ref,receipt.observation_ref,receipt.operation_ref,receipt.action,
        receipt.library_id,receipt.original_track_id,receipt.expected_decision_ref,
        receipt.expected_match_version)
    mapped=_match_command_wire(command)
    if (not prepare_command._uuid(receipt.decision_ref)
            or not prepare_command._integer(receipt.match_version,1,prepare_command._MAX)
            or receipt.expected_match_version is not None
                and receipt.match_version<=receipt.expected_match_version):
        raise SourceUnavailable()
    return {'command':mapped,'decision_ref':receipt.decision_ref,
            'match_version':receipt.match_version,'created_at':prepare._utc(receipt.created_at)}


async def _upload(request,service,ticket):
    async for chunk in request.stream():
        service.append_prepare(ticket,chunk)
    service.finish_prepare(ticket)


async def _delivery(request,service,ticket):
    while True:
        delivery=service.take_delivery(ticket)
        if delivery is not None:
            return delivery
        if await request.is_disconnected():
            raise SourceUnavailable()
        await asyncio.sleep(.05)


async def _run(request,kind,*,ui=False):
    service=ticket=None
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        if ui:
            ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle or not service.available:
            raise SourceUnavailable()
        if kind=='prepare':
            content_length=_content(request,upload=True)
            declared=_integer(_one_header(request,'x-album-haven-foobar-bytes',required=True))
            if not 1<=declared<=MAX_INPUT_BYTES or content_length is not None and content_length!=declared:
                raise _Invalid()
            raw=_one_header(request,'x-albumhaven-foobar-command',required=True)
            if len(raw)>MAX_COMMAND_BYTES or not raw.isascii():
                raise _Invalid()
            command=prepare_command.prepare_command_from_mapping(_command_json(raw.encode('ascii')))
            ticket=service.begin_prepare(context=context,constraints=constraints,command=command,length=declared)
            await asyncio.wait_for(_upload(request,service,ticket),timeout=30)
        else:
            value=await asyncio.wait_for(_json_body(request),timeout=10)
            if kind=='source':
                if set(value)!={'source_ref'} or value['source_ref'] is not None and not _request_uuid(value['source_ref']):
                    raise _Invalid()
                ticket=service.begin_select_source(context=context,constraints=constraints,source_ref=value['source_ref'])
            elif kind=='apply':
                command=apply_command.apply_command_from_mapping(value)
                ticket=service.begin_apply(context=context,constraints=constraints,command=command)
            elif kind=='status':
                if (set(value)!=_STATUS_FIELDS or value['version']!='foobar_account_status_v3'
                        or not _request_uuid(value['source_ref'])
                        or not _request_uuid(value['receipt_ref'])
                        or not prepare_command._integer(value['generation'],1,2147483647)):
                    raise _Invalid()
                ticket=service.begin_status(context=context,constraints=constraints,
                    source_ref=value['source_ref'],generation=value['generation'],
                    receipt_ref=value['receipt_ref'])
            elif kind in ('match-preview','match-apply'):
                command=match_decisions.command_from_mapping(value)
                if kind=='match-preview':
                    ticket=service.begin_match_preview(context=context,constraints=constraints,command=command)
                else:
                    ticket=service.begin_match_apply(context=context,constraints=constraints,command=command)
            else:
                raise SourceUnavailable()
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=60)
        if type(delivery) is not service_owner._Delivery:
            raise SourceUnavailable()
        await require_action('account.self.foobar.write',refresh_actor=True)(request)
        actor=await current_actor_from_request(request)
        if (actor.account_id,actor.session_id)!=identity:
            raise SourceStale()
        outcome=delivery.outcome.value
        if delivery.kind.value!=kind:
            raise SourceUnavailable()
        if outcome!='success':
            errors={'invalid_import_request':400,'stale_import':409,'unavailable':503,
                    'commit_uncertain':503,'source_choice_required':409,
                    'foobar_source_quota_exceeded':409}
            if outcome not in errors:
                raise SourceUnavailable()
            return _error(outcome,errors[outcome])
        if ui:
            if _ui_context(request)!=ui_ref:
                raise SourceStale()
            return _ui_response({'protocol':PROTOCOL,'operation':kind,
                'result':_receipt_wire(kind,delivery.receipt)},ui_ref)
        return _response({'protocol':PROTOCOL,'operation':kind,'result':_receipt_wire(kind,delivery.receipt)})
    except HTTPException as error:
        return _error('authentication_required' if error.status_code==401 else 'forbidden',error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid,apply_command.ApplyInvalid):
        return _error('invalid_import_request',400)
    except SourceStale:
        return _error('stale_import',409)
    except Exception:
        # In particular, delivery timeout is not a claim of rollback. Same-key
        # recovery remains possible; cancellation never replaces the worker.
        return _error('unavailable',503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


@router.post('/integrations/foobar/account/source')
async def foobar_account_source(request: Request):
    return await _run(request,'source')


@router.post('/integrations/foobar/account/prepare')
async def foobar_account_prepare(request: Request):
    return await _run(request,'prepare')


@router.post('/integrations/foobar/account/apply')
async def foobar_account_apply(request: Request):
    return await _run(request,'apply')


@router.post('/integrations/foobar/account/status')
async def foobar_account_status(request: Request):
    return await _run(request,'status')


@router.post('/integrations/foobar/account/match-preview')
async def foobar_account_match_preview(request: Request):
    return await _run(request,'match-preview')


@router.post('/integrations/foobar/account/match-apply')
async def foobar_account_match_apply(request: Request):
    return await _run(request,'match-apply')


JOB_PROTOCOL='foobar_account_job_v3'
JOB_LIST_PROTOCOL='foobar_account_job_list_v1'
REVIEW_PROTOCOL='foobar_account_review_v4'
_JOB_COMMAND_FIELDS=('source_ref','job_ref','upload_sha256','parser_version','mapping_name',
    'original_matching_library_id','original_generation','total_rows')


def _job_command(value):
    from music_app.services import foobar_account_import_jobs as jobs
    if (set(value)!=set(_JOB_COMMAND_FIELDS)|{'version','inventory_sha256','review_sha256'}
            or value['version']!=JOB_PROTOCOL
            or not prepare_command._hex(value['inventory_sha256'])
            or not prepare_command._hex(value['review_sha256'])):
        raise _Invalid()
    command=jobs.FoobarJobCommand(**{name:value[name] for name in _JOB_COMMAND_FIELDS})
    jobs._command(command)
    return command


def _job_wire(progress=None, *, durable=None):
    from music_app.services import foobar_account_import_jobs as jobs
    from music_app.services import foobar_account_job_worker as worker
    if progress is not None:
        if type(progress) is not worker.FoobarJobProgress or durable is not None:
            raise SourceUnavailable()
        command,known=progress.command,progress.status
        result={'phase':progress.phase,'snapshot_kind':'last_confirmed',
            'uncertain':progress.uncertain,'cancel_pending':progress.cancel_pending,
            'error':progress.error}
    else:
        if type(durable) is not jobs.FoobarJobStatus:
            raise SourceUnavailable()
        command,known=durable.command,durable
        result={'phase':durable.disposition,'snapshot_kind':'durable',
            'uncertain':durable.current_batch is not None and durable.current_batch.state=='claimed',
            'cancel_pending':False,'error':None}
    jobs._command(command)
    result['command']={name:getattr(command,name) for name in _JOB_COMMAND_FIELDS}
    result.update(confirmed_rows=None,remaining_rows=None,confirmed_counts=None,
                  disposition=None,cancel_requested=None,pending_attempt=None)
    if known is not None:
        if type(known) is not jobs.FoobarJobStatus or known.command!=command:
            raise SourceUnavailable()
        result.update(confirmed_rows=known.confirmed_through,
            remaining_rows=command.total_rows-known.confirmed_through,
            confirmed_counts=known.confirmed_counts,disposition=known.disposition,
            cancel_requested=known.cancel_requested)
        if known.current_batch is not None:
            batch=known.current_batch
            result['pending_attempt']={'batch_no':batch.batch_no,'attempt_no':batch.attempt_no,
                                       'state':batch.state}
    if progress is not None and progress.proposed is not None:
        report=progress.proposed
        result['preflight']={'checked_rows':report.checked_rows,'start_offset':report.start_offset,
            'planned_batches':report.planned_batches,'proposed_counts':report.proposed_counts,
            'field_error_count':report.field_error_count,'status':report.status,
            'advisory_not_reservation':True}
    return result


async def _job_identity(request,identity):
    context,constraints,current=await _authorize(request)
    if current!=identity:
        raise SourceStale()
    return context,constraints


def _settled_wire(value):
    if value is None:
        return None
    # Only diagnostics, never cached counts, completion or current authority.
    return {'phase':value.phase,'error':value.error,'uncertain':value.uncertain,
            'snapshot_kind':'settled_process_diagnostic','durable_proof':False}


def _job_error(code,http_status,diagnostic=None,context_ref=None):
    return _ui_response({'protocol':JOB_PROTOCOL,'error':code,
                      'settled_diagnostic':_settled_wire(diagnostic)},context_ref,http_status)


async def _run_job(request,kind):
    service=ticket=None
    accepted=False
    diagnostic=None
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if (type(service) is not service_owner.FoobarImportHandle
                or kind in ('start','resume') and not service.available):
            raise SourceUnavailable()
        if kind in ('start','resume'):
            raw=_one_header(request,'x-albumhaven-foobar-command',required=True)
            if len(raw)>MAX_COMMAND_BYTES or not raw.isascii():
                raise _Invalid()
            value=_command_json(raw.encode('ascii'),kind='job')
            command=_job_command(value)
            enhanced=command.mapping_name==prepare_command.ENHANCED_MAPPING
            declared,retain,stored=await _temporary_upload_options(request,command)
            ticket=service.begin_job(context=context,constraints=constraints,command=command,
                inventory_sha256=value['inventory_sha256'],review_sha256=value['review_sha256'],
                length=declared,resume=kind=='resume',retain_source=retain,retained_identity=stored)
            if stored is None:
                await asyncio.wait_for((_enhanced_upload_body if enhanced else _upload)(request,service,ticket),
                    timeout=service_owner.enhanced_upload.MAX_UPLOAD_SECONDS if enhanced else 30)
            await _job_identity(request,identity)
            if _ui_context(request)!=ui_ref:
                raise SourceStale()
            response=_ui_response({'protocol':JOB_PROTOCOL,'operation':kind,
                'source_ref':command.source_ref,'job_ref':command.job_ref,
                'phase':'accepted_for_validation','durable_start_confirmed':False},ui_ref,202)
            accepted=True
            return response
        value=await asyncio.wait_for(_json_body(request),timeout=10)
        if (set(value)!={'version','source_ref','job_ref'} or value['version']!=JOB_PROTOCOL
                or not _request_uuid(value['source_ref']) or not _request_uuid(value['job_ref'])):
            raise _Invalid()
        context,constraints=await _job_identity(request,identity)
        progress=service.current_job_progress(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'],cancel=kind=='cancel')
        if progress is not None:
            return _ui_response({'protocol':JOB_PROTOCOL,'operation':kind,'result':_job_wire(progress)},
                ui_ref,202 if progress.cancel_pending else 200)
        diagnostic=service.settled_job_diagnostic(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'])
        ticket=service.begin_job_control(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'],cancel=kind=='cancel')
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=60)
        await _job_identity(request,identity)
        if (type(delivery) is not service_owner._Delivery
                or delivery.kind.value!='job-'+kind):
            raise SourceUnavailable()
        outcome=delivery.outcome.value
        if outcome!='success':
            return _job_error(outcome,{'invalid_import_request':400,'stale_import':409}.get(outcome,503),diagnostic,ui_ref)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        return _ui_response({'protocol':JOB_PROTOCOL,'operation':kind,
                          'result':_job_wire(durable=delivery.receipt),'settled_diagnostic':_settled_wire(diagnostic)},ui_ref)
    except HTTPException as error:
        return _job_error('authentication_required' if error.status_code==401 else 'forbidden',error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _job_error('invalid_import_request',400,context_ref=ui_ref)
    except SourceStale:
        return _job_error('stale_import',409,context_ref=ui_ref)
    except Exception:
        if diagnostic is not None:
            try:
                await _job_identity(request,identity)
            except Exception:
                diagnostic=None
        return _job_error('unavailable',503,diagnostic,ui_ref)
    finally:
        if not accepted and service is not None and ticket is not None:
            service.abandon(ticket)


@router.post('/integrations/foobar/account/job/start')
async def foobar_account_job_start(request: Request):
    return await _run_job(request,'start')


@router.post('/integrations/foobar/account/job/resume')
async def foobar_account_job_resume(request: Request):
    return await _run_job(request,'resume')


@router.post('/integrations/foobar/account/job/status')
async def foobar_account_job_status(request: Request):
    return await _run_job(request,'status')


@router.post('/integrations/foobar/account/job/cancel')
async def foobar_account_job_cancel(request: Request):
    return await _run_job(request,'cancel')


def _ui_context(request):
    supplied=_one_header(request,'x-albumhaven-foobar-context',required=True)
    actual=foobar_account_ui_context_ref(request)
    if (not prepare_command._hex(supplied) or not prepare_command._hex(actual)
            or not hmac.compare_digest(supplied,actual)):
        raise SourceStale()
    return actual


def _ui_response(value,context_ref,code=200):
    if context_ref is not None:
        if not prepare_command._hex(context_ref):
            raise SourceUnavailable()
        value=dict(value,context_ref=context_ref,context_scope=FOOBAR_ACCOUNT_CONTEXT_SCOPE)
    result=value.get('result')
    report=result.get('review') if type(result) is dict else None
    observation=type(report) is dict and 'observations' in report
    return _response(value,code,maximum=(MAX_OBSERVATION_RESPONSE_BYTES if observation else MAX_REVIEW_RESPONSE_BYTES)
        if value.get('protocol')==REVIEW_PROTOCOL else MAX_RESPONSE_BYTES)


def _observation_wire(progress):
    owner=prepare.observation_preview
    report=progress.result.proposed
    total=progress.result.command.total_rows
    after=report.observation_after
    if (not prepare_command._integer(after,report.start_offset,total)
            or after!=progress.request.observation_after
            or type(report.observation_items) is not tuple or len(report.observation_items)>owner.MAX_ROWS
            or not prepare_command._integer(report.observation_remaining,0,total-after)
            or len(report.observation_items)+report.observation_remaining!=total-after):
        raise SourceUnavailable()
    items=[]
    previous=after
    for row in report.observation_items:
        if type(row) is not owner.ObservationRow or row.ordinal!=previous+1:
            raise SourceUnavailable()
        previous=row.ordinal
        sides={}
        for side in ('incoming','effective'):
            fields=getattr(row,side)
            if type(fields) is not tuple or len(fields)!=len(owner.FIELDS):
                raise SourceUnavailable()
            public=[]
            for name,field in zip(owner.FIELDS,fields):
                if type(field) is not owner.ObservationField or field.field!=name:
                    raise SourceUnavailable()
                is_count=name in ('play_count','play_count_enhanced')
                if (field.state not in ('absent','empty','unavailable','valid','invalid')
                        or not is_count and field.state=='invalid'
                        or field.code!=('invalid_count' if field.state=='invalid' else None)
                        or not prepare_command._integer(field.raw_characters,0,65536)):
                    raise SourceUnavailable()
                if is_count and field.state=='valid':
                    if (type(field.count) is not str or not field.count.isascii()
                            or not field.count.isdecimal() or len(field.count)>19
                            or str(int(field.count))!=field.count or int(field.count)>9223372036854775807):
                        raise SourceUnavailable()
                elif field.count is not None:
                    raise SourceUnavailable()
                if field.state=='absent':
                    if field.origin is not None or field.raw_prefix is not None or field.raw_characters!=0:
                        raise SourceUnavailable()
                else:
                    origin=field.origin
                    if (type(origin) is not tuple or len(origin)!=3
                            or not prepare_command._hex(origin[0])
                            or not prepare_command._integer(origin[1],1,100000)
                            or not prepare_command._integer(origin[2],0,255)
                            or type(field.raw_prefix) is not str
                            or len(field.raw_prefix)!=min(owner.RAW_PREFIX_CHARACTERS,field.raw_characters)):
                        raise SourceUnavailable()
                public.append({name:getattr(field,name) for name in
                    ('field','state','count','code','origin','raw_prefix','raw_characters')})
            sides[side]=public
        items.append(dict(row=row.ordinal,source_artist=_source_label_wire(row.source_artist,48),
            source_title=_source_label_wire(row.source_title,96),source_album=_source_label_wire(row.source_album,48),**sides))
    if (report.observation_next!=(previous if report.observation_remaining else None)
            or report.observation_remaining and len(items)!=owner.MAX_ROWS):
        raise SourceUnavailable()
    chunk=report.observation_chunk
    raw=None
    if chunk is not None:
        request=progress.request.observation_raw
        if (type(chunk) is not owner.RawFieldChunk or request is None
                or (chunk.ordinal,chunk.side,chunk.field,chunk.offset)!=(request.ordinal,request.side,request.field,request.offset)
                or type(chunk.text) is not str
                or not prepare_command._integer(chunk.total_characters,chunk.offset,65536)
                or len(chunk.text)!=min(owner.RAW_CHUNK_CHARACTERS,chunk.total_characters-chunk.offset)
                or chunk.next_offset!=(chunk.offset+len(chunk.text)
                    if chunk.offset+len(chunk.text)<chunk.total_characters else None)):
            raise SourceUnavailable()
        selected=next((row for row in report.observation_items if row.ordinal==chunk.ordinal),None)
        selected_field=next((field for field in getattr(selected,chunk.side,())
            if field.field==chunk.field),None)
        if (selected_field is None or selected_field.raw_characters!=chunk.total_characters
                or chunk.offset==0 and not chunk.text.startswith(selected_field.raw_prefix or '')):
            raise SourceUnavailable()
        raw={name:getattr(chunk,name) for name in ('ordinal','side','field','offset','total_characters','text','next_offset')}
    elif progress.request.observation_raw is not None:
        raise SourceUnavailable()
    return dict(items=items,after=after,next=report.observation_next,remaining=report.observation_remaining,
        raw_chunk=raw,date_state_is_raw_parser_evidence=True,families_are_not_added=True)


def _review_wire(progress):
    if type(progress) is not review_owner.FoobarReviewProgress:
        raise SourceUnavailable()
    result={'phase':progress.phase,'error':progress.error,'review':None,
            'source_ref':progress.request.source_ref,'job_ref':progress.request.job_ref}
    if progress.result is None:
        return result
    review=progress.result
    if type(review) is not review_owner.FoobarReviewResult or progress.phase!='review_ready':
        raise SourceUnavailable()
    report=review.proposed
    if (report.status!='complete_preflight' or report.remaining_rows!=0
            or len(report.review_counts)!=6 or len(report.proposed_counts)!=7
            or len(report.review_problems)>32
            or any(type(n) is not int or not 0<=n<=100000 for n in report.review_counts+report.proposed_counts)):
        raise SourceUnavailable()
    problems=[]
    for ordinal,code,field in report.review_problems:
        if (not prepare_command._integer(ordinal,1,review.command.total_rows)
                or code not in prepare._REVIEW_PROBLEM_CODES
                or field is not None and field not in prepare.parser.FIELD_NAMES):
            raise SourceUnavailable()
        problems.append({'row':ordinal,'code':code,'field':field})
    conflicts=[]
    if (type(report.conflicts) is not tuple or len(report.conflicts)>32
            or not prepare_command._integer(report.conflict_count,0,200000)
            or not prepare_command._integer(report.conflict_after,0,200001)
            or not prepare_command._integer(report.conflict_remaining,0,report.conflict_count)
            or report.conflict_next is not None and not prepare_command._integer(
                report.conflict_next,report.conflict_after+1,200001)):
        raise SourceUnavailable()
    for item in report.conflicts:
        if (type(item) is not prepare.FoobarPersonalConflict
                or not prepare_command._integer(item.ordinal,1,review.command.total_rows)
                or type(item.eligible) is not bool
                or item.ineligible_reason not in (None,'provenance_requires_review')
                or item.eligible!=(item.ineligible_reason is None)):
            raise SourceUnavailable()
        conflicts.append(dict(_personal_field_wire(item.ordinal,item.field,item.existing,item.incoming),
            consequence=item.consequence,eligible=item.eligible,reason=item.ineligible_reason,
            source_artist=_source_label_wire(item.source_artist,48),
            source_title=_source_label_wire(item.source_title,96),
            source_album=_source_label_wire(item.source_album,48)))
        if item.consequence!=('replace_personal_rating' if item.field=='rating' else 'set_personal_favorite'):
            raise SourceUnavailable()
    problem_items=[]
    if (type(report.problem_items) is not tuple or len(report.problem_items)>32
            or not prepare_command._integer(report.problem_count,0,32*report.checked_rows)
            or not prepare_command._integer(report.problem_after,0,32*review.command.total_rows+31)
            or not prepare_command._integer(report.problem_remaining,0,report.problem_count)
            or report.problem_remaining+len(report.problem_items)>report.problem_count
            or report.problem_after!=progress.request.problem_after
            or report.conflict_after!=progress.request.conflict_after):
        raise SourceUnavailable()
    previous_cursor=report.problem_after
    for item in report.problem_items:
        if (type(item) is not prepare.FoobarDiagnosticProblem
                or not prepare_command._integer(item.ordinal,report.start_offset+1,review.command.total_rows)
                or not prepare_command._integer(item.cursor,previous_cursor+1,32*review.command.total_rows+31)
                or item.cursor//32!=item.ordinal
                or item.code not in prepare._REVIEW_PROBLEM_CODES
                or item.field is not None and item.field not in prepare.parser.FIELD_NAMES):
            raise SourceUnavailable()
        previous_cursor=item.cursor
        problem_items.append({'cursor':item.cursor,'row':item.ordinal,'code':item.code,'field':item.field,
            'source_artist':_source_label_wire(item.source_artist,48),
            'source_title':_source_label_wire(item.source_title,96),
            'source_album':_source_label_wire(item.source_album,48)})
    if (report.problem_remaining>0 and (len(problem_items)!=32 or report.problem_next!=previous_cursor)
            or report.problem_remaining==0 and report.problem_next is not None
            or report.problem_after==0 and report.problem_count!=len(problem_items)+report.problem_remaining):
        raise SourceUnavailable()
    result['review']={
        'command':{name:getattr(review.command,name) for name in _JOB_COMMAND_FIELDS},
        'inventory_sha256':review.inventory_sha256,'resume':review.resume,
        'review_sha256':review_owner.review_intent_sha256(review.command,review.inventory_sha256,
            review.resume,report.proposal_sha256),
        'checked_rows':report.checked_rows,'start_offset':report.start_offset,
        'planned_batches':report.planned_batches,'proposed_counts':report.proposed_counts,
        'review_counts':report.review_counts,'problems':problems,
        'problems_truncated':report.review_truncated,'advisory_not_reservation':True,
        'conflicts':conflicts,'conflict_count':report.conflict_count,
        'conflict_after':report.conflict_after,'conflict_next':report.conflict_next,
        'conflict_remaining':report.conflict_remaining,
        'problem_items':problem_items,'problem_count':report.problem_count,
        'problem_after':report.problem_after,'problem_next':report.problem_next,
        'problem_remaining':report.problem_remaining,
    }
    if progress.request.observation_after is not None:
        result['review']['observations']=_observation_wire(progress)
    return result


def _source_label_wire(value,maximum):
    import unicodedata
    if (type(value) is not str or len(value)>maximum
            or any(unicodedata.category(character).startswith('C')
                or character in '\u2028\u2029' for character in value)
            or len(value.encode('utf-8'))>maximum):
        raise SourceUnavailable()
    return value


def _personal_field_wire(row,field,existing,proposed):
    if (not prepare_command._integer(row,1,100000)
            or field not in ('rating','favorite')
            or field=='rating' and (not prepare_command._integer(proposed,1,5)
                or existing is not None and not prepare_command._integer(existing,1,5))
            or field=='favorite' and (proposed!='loved' or existing!='off')):
        raise SourceUnavailable()
    return {'row':row,'field':field,'existing':existing,'proposed':proposed}


async def _run_review(request,kind):
    service=ticket=None
    accepted=False
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        if kind=='start':
            if not service.available:
                raise SourceUnavailable()
            raw=_one_header(request,'x-albumhaven-foobar-command',required=True)
            if len(raw)>MAX_COMMAND_BYTES or not raw.isascii():
                raise _Invalid()
            value=_command_json(raw.encode('ascii'),kind='review')
            required={'version','source_ref','job_ref','matching_library_id','resume',
                    'conflict_after','previous_review_sha256','problem_after','mapping_name'}
            if set(value) not in (required,required|{'observation_after','observation_raw'}) or value['version']!=REVIEW_PROTOCOL:
                raise _Invalid()
            raw_field=value.get('observation_raw')
            if raw_field is not None:
                if type(raw_field) is not dict or set(raw_field)!={'ordinal','side','field','offset'}:
                    raise _Invalid()
                raw_field=prepare.observation_preview.RawFieldRequest(**raw_field)
            command=review_owner.FoobarReviewRequest(value['source_ref'],value['job_ref'],
                value['matching_library_id'],value['resume'],value['conflict_after'],
                value['previous_review_sha256'],value['problem_after'],value['mapping_name'],
                value.get('observation_after'),raw_field)
            review_owner.validate_review_request(command)
            enhanced=command.mapping_name==prepare_command.ENHANCED_MAPPING
            declared,retain,stored=await _temporary_upload_options(request,command)
            ticket=service.begin_review(context=context,constraints=constraints,request=command,length=declared,
                retain_source=retain,retained_identity=stored)
            if stored is None:
                await asyncio.wait_for((_enhanced_upload_body if enhanced else _upload)(request,service,ticket),
                    timeout=service_owner.enhanced_upload.MAX_UPLOAD_SECONDS if enhanced else 30)
            await _job_identity(request,identity)
            if _ui_context(request)!=ui_ref:
                raise SourceStale()
            response=_ui_response({'protocol':REVIEW_PROTOCOL,'operation':'start',
                'source_ref':command.source_ref,'job_ref':command.job_ref,
                'phase':'accepted_for_review','durable_start_confirmed':False},ui_ref,202)
            accepted=True
            return response
        value=await asyncio.wait_for(_json_body(request),timeout=10)
        if (set(value)!={'version','source_ref','job_ref'} or value['version']!=REVIEW_PROTOCOL
                or not _request_uuid(value['source_ref']) or not _request_uuid(value['job_ref'])
                or kind not in ('status','cancel')):
            raise _Invalid()
        context,constraints=await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        progress=service.current_review_progress(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'],cancel=kind=='cancel')
        return _ui_response({'protocol':REVIEW_PROTOCOL,'operation':kind,'result':_review_wire(progress)},ui_ref)
    except HTTPException as error:
        return _ui_response({'protocol':REVIEW_PROTOCOL,
            'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _ui_response({'protocol':REVIEW_PROTOCOL,'error':'invalid_import_request'},ui_ref,400)
    except SourceStale:
        return _ui_response({'protocol':REVIEW_PROTOCOL,'error':'stale_import'},ui_ref,409)
    except Exception:
        return _ui_response({'protocol':REVIEW_PROTOCOL,'error':'unavailable'},ui_ref,503)
    finally:
        if not accepted and service is not None and ticket is not None:
            service.abandon(ticket)


@router.post('/integrations/foobar/account/ui/source')
async def foobar_account_ui_source(request: Request):
    return await _run(request,'source',ui=True)


@router.post('/integrations/foobar/account/review/start')
async def foobar_account_review_start(request: Request):
    return await _run_review(request,'start')


@router.post('/integrations/foobar/account/review/status')
async def foobar_account_review_status(request: Request):
    return await _run_review(request,'status')


@router.post('/integrations/foobar/account/review/cancel')
async def foobar_account_review_cancel(request: Request):
    return await _run_review(request,'cancel')


@router.post('/integrations/foobar/account/review/personal-changes')
async def foobar_account_review_personal_changes(request: Request):
    service=ticket=None
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle or not service.available:
            raise SourceUnavailable()
        value=await asyncio.wait_for(_json_body(request,kind='personal'),timeout=10)
        if (set(value)!={'version','source_ref','job_ref','review_sha256','choices'}
                or value['version']!=REVIEW_PROTOCOL or type(value['choices']) is not list
                or not 1<=len(value['choices'])<=32
                or any(type(item) is not list or len(item)!=2
                    or not prepare_command._integer(item[0],1,100000)
                    or type(item[1]) is not str or item[1] not in ('rating','favorite')
                    for item in value['choices'])):
            raise _Invalid()
        context,constraints=await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        ticket=service.begin_personal_changes(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'],review_sha256=value['review_sha256'],
            choices=tuple(tuple(item) for item in value['choices']))
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=60)
        await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref or delivery.kind is not service_owner._Kind.PERSONAL_CHANGE:
            raise SourceStale()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            error=delivery.outcome.value
            codes={'invalid_import_request':400,'stale_import':409,'unavailable':503,'commit_uncertain':503}
            if error not in codes:
                raise SourceUnavailable()
            return _ui_response({'protocol':REVIEW_PROTOCOL,'error':error},ui_ref,codes[error])
        receipt=delivery.receipt
        if (type(receipt) is not service_owner.personal_changes.FoobarPersonalChangesResult
                or type(receipt.changed_fields) is not tuple or not 1<=len(receipt.changed_fields)<=32):
            raise SourceUnavailable()
        fields=[_personal_field_wire(*item) for item in receipt.changed_fields]
        return _ui_response({'protocol':REVIEW_PROTOCOL,'operation':'personal-changes',
            'result':{'phase':'personal_changes_applied','changed_fields':fields,'import_started':False}},ui_ref)
    except HTTPException as error:
        return _ui_response({'protocol':REVIEW_PROTOCOL,
            'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _ui_response({'protocol':REVIEW_PROTOCOL,'error':'invalid_import_request'},ui_ref,400)
    except SourceStale:
        return _ui_response({'protocol':REVIEW_PROTOCOL,'error':'stale_import'},ui_ref,409)
    except Exception:
        # Once admitted, timeout/disconnect is not proof that the selected
        # action rolled back. The consumed review can never be redispatched.
        return _ui_response({'protocol':REVIEW_PROTOCOL,
            'error':'commit_uncertain' if ticket is not None else 'unavailable'},ui_ref,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


def _job_list_cursor_wire(cursor):
    if cursor is None:
        return None
    discovery=service_owner.discovery
    discovery.validate_discovery_request(unfinished=False,cursor=cursor)
    return {name:getattr(cursor,name) for name in ('updated_at','source_ref','job_ref')}


def _job_list_wire(value):
    discovery=service_owner.discovery
    if type(value) is service_owner._BusyJobDiscovery:
        items=[]
        if value.command is not None:
            service_owner.jobs._command(value.command)
            if (value.confirmed_rows is not None and not prepare_command._integer(
                    value.confirmed_rows,0,value.command.total_rows)
                    or value.cancel_requested is not None and type(value.cancel_requested) is not bool):
                raise SourceUnavailable()
            items.append({'source_ref':value.command.source_ref,'job_ref':value.command.job_ref,
                'created_at':None,'updated_at':None,'confirmed_rows':value.confirmed_rows,
                'total_rows':value.command.total_rows,'cancel_requested':value.cancel_requested})
        if type(value.unfinished) is not bool:
            raise SourceUnavailable()
        return {'unfinished':value.unfinished,'snapshot_kind':'in_process','busy':True,
            'items':items,'next_cursor':None}
    if (type(value) is not discovery.FoobarJobListPage or type(value.unfinished) is not bool
            or type(value.items) is not tuple or len(value.items)>20):
        raise SourceUnavailable()
    items=[]
    previous=None
    for item in value.items:
        if (type(item) is not discovery.FoobarJobListItem
                or not prepare_command._integer(item.total_rows,1,100000)
                or not prepare_command._integer(item.confirmed_rows,0,item.total_rows)
                or type(item.cancel_requested) is not bool
                or value.unfinished and item.confirmed_rows==item.total_rows):
            raise SourceUnavailable()
        cursor=discovery.FoobarJobListCursor(item.updated_at,item.source_ref,item.job_ref)
        discovery.validate_discovery_request(unfinished=value.unfinished,cursor=cursor)
        discovery.validate_discovery_request(unfinished=value.unfinished,
            cursor=discovery.FoobarJobListCursor(item.created_at,item.source_ref,item.job_ref))
        key=(item.updated_at,item.source_ref,item.job_ref)
        if item.created_at>item.updated_at or previous is not None and key>=previous:
            raise SourceUnavailable()
        previous=key
        items.append({name:getattr(item,name) for name in ('source_ref','job_ref','created_at',
            'updated_at','confirmed_rows','total_rows','cancel_requested')})
    next_cursor=_job_list_cursor_wire(value.next_cursor)
    if next_cursor is not None and (len(items)!=20 or next_cursor!={
            name:items[-1][name] for name in ('updated_at','source_ref','job_ref')}):
        raise SourceUnavailable()
    return {'unfinished':value.unfinished,'snapshot_kind':'durable_page','busy':False,
        'items':items,'next_cursor':next_cursor}


@router.post('/integrations/foobar/account/job/list')
async def foobar_account_job_list(request: Request):
    """One bounded account-owned discovery; selection uses genuine status."""
    service=ticket=None
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        _content(request,upload=False)
        value=await asyncio.wait_for(_json_body(request,kind='job-list'),timeout=30)
        if set(value)!={'version','unfinished','cursor'} or value['version']!=JOB_LIST_PROTOCOL:
            raise _Invalid()
        cursor=value['cursor']
        if cursor is not None:
            if type(cursor) is not dict or set(cursor)!={'updated_at','source_ref','job_ref'}:
                raise _Invalid()
            cursor=service_owner.discovery.FoobarJobListCursor(**cursor)
        service_owner.discovery.validate_discovery_request(unfinished=value['unfinished'],cursor=cursor)
        context,constraints=await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        result=service.busy_job_discovery(context=context,constraints=constraints,
            unfinished=value['unfinished'],cursor=cursor)
        if result is None:
            ticket=service.begin_job_discovery(context=context,constraints=constraints,
                unfinished=value['unfinished'],cursor=cursor)
            delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=30)
            await _job_identity(request,identity)
            if _ui_context(request)!=ui_ref:
                raise SourceStale()
            if delivery.kind is not service_owner._Kind.JOB_LIST:
                raise SourceUnavailable()
            if delivery.outcome is not service_owner._Outcome.SUCCESS:
                error=delivery.outcome.value
                codes={'invalid_import_request':400,'stale_import':409,'unavailable':503}
                if error not in codes:
                    raise SourceUnavailable()
                return _ui_response({'protocol':JOB_LIST_PROTOCOL,'error':error},ui_ref,codes[error])
            result=delivery.receipt
        await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        return _ui_response({'protocol':JOB_LIST_PROTOCOL,'operation':'list',
            'result':_job_list_wire(result)},ui_ref)
    except HTTPException as error:
        return _ui_response({'protocol':JOB_LIST_PROTOCOL,
            'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _ui_response({'protocol':JOB_LIST_PROTOCOL,'error':'invalid_import_request'},ui_ref,400)
    except SourceStale:
        return _ui_response({'protocol':JOB_LIST_PROTOCOL,'error':'stale_import'},ui_ref,409)
    except Exception:
        return _ui_response({'protocol':JOB_LIST_PROTOCOL,'error':'unavailable'},ui_ref,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


HISTORY_PROTOCOL='foobar_account_history_v1'
MAX_HISTORY_RESPONSE_BYTES=131072


class _HistoryContextStale(SourceStale):
    pass


def _history_decimal(value, *, minimum=0):
    if (type(value) is not str or not 1<=len(value)<=20
            or value.startswith('+') or value=='-0'):
        raise _Invalid()
    try:
        number=int(value)
    except ValueError:
        raise _Invalid() from None
    if str(number)!=value or not minimum<=number<=9223372036854775807:
        raise _Invalid()
    return number


async def _history_authorize(request, *, identity=None, marker=None):
    await require_action('account.self.foobar.read',refresh_actor=True)(request)
    if not _valid_session_csrf(request):
        raise HTTPException(status_code=403,detail='Action not permitted.')
    actor=request.state.current_actor
    current=(actor.account_id,actor.session_id)
    if identity is not None and identity!=current:
        raise _HistoryContextStale()
    context=PolicyContext.build(actor=actor,action='account.self.foobar.read',
        target_account_id=actor.account_id,library_id=None,
        deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver=getattr(request.app.state,'policy_constraint_resolver',None)
    constraints=resolver if callable(resolver) else PolicyEvaluationConstraints()
    require_account_foobar_read(context,constraints)
    try:
        actual=_ui_context(request)
    except SourceStale:
        raise _HistoryContextStale() from None
    if marker is not None and actual!=marker:
        raise _HistoryContextStale()
    return context,constraints,current,actual


def _history_response(value,marker,code=200):
    value=dict(value,protocol=HISTORY_PROTOCOL)
    if marker is not None:
        if not prepare_command._hex(marker):
            raise SourceUnavailable()
        value.update(context_ref=marker,context_scope=FOOBAR_ACCOUNT_CONTEXT_SCOPE)
    # Separate history-only admission; import/review caps are unchanged.
    body=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(body)>MAX_HISTORY_RESPONSE_BYTES:
        raise SourceUnavailable()
    return Response(body,status_code=code,media_type='application/json',headers=_HEADERS)


def _history_cursor(value,context,marker,*,sources):
    if value is None:
        return None
    expected={'context_ref','source_ref'} if sources else {
        'context_ref','source_ref','source_revision','family','mode','sort_key','kind','observation_ref'}
    if type(value) is not dict or set(value)!=expected:
        raise _Invalid()
    if value['context_ref']!=marker:
        raise _HistoryContextStale()
    if sources:
        cursor=service_owner.history.FoobarHistorySourceCursor(
            context.actor.account_id,value['source_ref'])
        service_owner.history.validate_foobar_history_source_cursor(cursor)
        return cursor
    return service_owner.history.FoobarHistoryCursor(
        account_id=context.actor.account_id,source_ref=value['source_ref'],
        source_revision=_history_decimal(value['source_revision']),
        family=value['family'],mode=value['mode'],
        sort_key=_history_decimal(value['sort_key'],minimum=-(2**63)),
        kind=value['kind'],observation_ref=value['observation_ref'])


def _history_cursor_wire(cursor,marker,*,sources):
    if cursor is None:
        return None
    result={'context_ref':marker,'source_ref':cursor.source_ref}
    if not sources:
        result.update(source_revision=str(cursor.source_revision),family=cursor.family,
            mode=cursor.mode,sort_key=str(cursor.sort_key),kind=cursor.kind,
            observation_ref=cursor.observation_ref)
    return result


def _history_wire(page,marker,*,sources):
    history=service_owner.history
    if sources:
        if type(page) is not history.FoobarHistorySourcePage or len(page.items)>20:
            raise SourceUnavailable()
        items=[]
        for item in page.items:
            if (not prepare_command._uuid(item.source_ref)
                    or type(item.is_default) is not bool
                    or not prepare_command._integer(item.observation_count,0,100000)):
                raise SourceUnavailable()
            items.append({'source_ref':item.source_ref,'created_at':item.created_at,
                'is_default':item.is_default,'observation_count':str(item.observation_count)})
        return {'items':items,'next_cursor':_history_cursor_wire(page.next_cursor,marker,sources=True)}
    if (type(page) is not history.FoobarHistoryPage or len(page.items)>20
            or not prepare_command._uuid(page.source_ref)
            or not prepare_command._integer(page.source_revision,0,9223372036854775807)
            or page.family not in ('standard','enhanced') or page.mode not in ('grouped','individual')):
        raise SourceUnavailable()
    items=[]
    for item in page.items:
        if (not prepare_command._uuid(item.observation_ref)
                or item.kind not in ('grouped_aggregate','first_boundary','unknown_dates_bucket')):
            raise SourceUnavailable()
        items.append({'observation_ref':item.observation_ref,'kind':item.kind,
            'projection':history_projection.public_family_projection(item.projection,family=page.family)})
    return {'source_ref':page.source_ref,'source_revision':str(page.source_revision),
        'family':page.family,'mode':page.mode,'items':items,
        'next_cursor':_history_cursor_wire(page.next_cursor,marker,sources=False)}


async def _run_history(request,*,sources):
    service=ticket=None
    marker=None
    try:
        context,constraints,identity,marker=await _history_authorize(request)
        value=await asyncio.wait_for(_json_body(request,kind='history'),timeout=10)
        expected={'version','cursor'} if sources else {'version','source_ref','family','mode','cursor'}
        if set(value)!=expected or value['version']!=HISTORY_PROTOCOL:
            raise _Invalid()
        cursor=_history_cursor(value['cursor'],context,marker,sources=sources)
        context,constraints,_,_=await _history_authorize(request,identity=identity,marker=marker)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        if sources:
            ticket=service.begin_history_sources(context=context,constraints=constraints,cursor=cursor)
            expected_kind=service_owner._Kind.HISTORY_SOURCES
        else:
            command=service_owner.history.FoobarHistoryRequest(
                value['source_ref'],value['family'],value['mode'],cursor)
            ticket=service.begin_history(context=context,constraints=constraints,request=command)
            expected_kind=service_owner._Kind.HISTORY
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=30)
        await _history_authorize(request,identity=identity,marker=marker)
        if delivery.kind is not expected_kind:
            raise SourceUnavailable()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            errors={service_owner._Outcome.INVALID:('invalid_history_request',400),
                service_owner._Outcome.STALE:('stale_history',409),
                service_owner._Outcome.UNAVAILABLE:('unavailable',503)}
            if delivery.outcome not in errors:
                raise SourceUnavailable()
            error,code=errors[delivery.outcome]
            return _history_response({'error':error},marker,code)
        result=_history_wire(delivery.receipt,marker,sources=sources)
        return _history_response({'operation':'sources' if sources else 'history','result':result},marker)
    except HTTPException as error:
        return _history_response({'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except _HistoryContextStale:
        return _history_response({'error':'stale_context'},None,409)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _history_response({'error':'invalid_history_request'},marker,400)
    except SourceStale:
        return _history_response({'error':'stale_history'},marker,409)
    except Exception:
        return _history_response({'error':'unavailable'},marker,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


@router.post('/integrations/foobar/account/history/sources')
async def foobar_account_history_sources(request: Request):
    return await _run_history(request,sources=True)


@router.post('/integrations/foobar/account/history/list')
async def foobar_account_history_list(request: Request):
    return await _run_history(request,sources=False)


HISTORY_NATIVE_PROTOCOL='foobar_account_history_native_v1'
# Six native strings are individually <=4096 UTF-8 bytes. ASCII JSON escaping
# is at most six bytes per input byte, plus fixed keys/numeric/context framing.
# This separate private handoff cap does not enlarge public history/import caps.
MAX_HISTORY_NATIVE_RESPONSE_BYTES=262144


async def _history_native_authorize(request, *, identity=None, marker=None):
    await require_action('account.self.foobar.read',refresh_actor=True)(request)
    await require_action('library.browse.read',refresh_actor=True)(request)
    if not _valid_session_csrf(request):
        raise HTTPException(status_code=403,detail='Action not permitted.')
    actor=request.state.current_actor
    current=(actor.account_id,actor.session_id,actor.current_library_id)
    if identity is not None and current!=identity:
        raise _HistoryContextStale()
    context=PolicyContext.build(actor=actor,action='account.self.foobar.read',
        target_account_id=actor.account_id,library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver=getattr(request.app.state,'policy_constraint_resolver',None)
    constraints=resolver if callable(resolver) else PolicyEvaluationConstraints()
    require_account_foobar_read(context,constraints)
    actual=private_ui_context_ref(request)
    supplied=_one_header(request,'x-albumhaven-context',required=True)
    if (not prepare_command._hex(actual) or type(supplied) is not str
            or not prepare_command._hex(supplied) or not hmac.compare_digest(actual,supplied)
            or marker is not None and marker!=actual):
        raise _HistoryContextStale()
    return context,constraints,current,actual


def _history_native_command(value, *, play):
    native=service_owner.history_native
    if (set(value)!={'version','source_ref','source_revision','observations'}
            or value['version']!=HISTORY_NATIVE_PROTOCOL or type(value['observations']) is not list
            or not 1<=len(value['observations'])<=(1 if play else 20)):
        raise _Invalid()
    rows=[]
    for row in value['observations']:
        if type(row) is not list or len(row)!=2:
            raise _Invalid()
        rows.append(native.FoobarHistoryObservation(row[0],_history_decimal(row[1],minimum=1)))
    command=native.FoobarHistoryNativeRequest(value['source_ref'],
        _history_decimal(value['source_revision']),tuple(rows))
    native.validate_foobar_history_native_request(command,play=play)
    return command


def _history_native_wire(value,command,*,play):
    native=service_owner.history_native
    if not play:
        if type(value) is not tuple or len(value)!=len(command.observations):
            raise SourceUnavailable()
        result=[]
        for item,requested in zip(value,command.observations):
            if (type(item) is not native.FoobarHistoryEligibility
                    or item.observation_ref!=requested.observation_ref
                    or type(item.can_attempt_play) is not bool):
                raise SourceUnavailable()
            result.append({'observation_ref':item.observation_ref,'can_attempt_play':item.can_attempt_play})
        return result
    if type(value) is not native.FoobarHistoryPrivatePlayTarget:
        raise SourceUnavailable()
    fields=('track_ref','path','title','artist','album_title','duration_seconds','inventory_track_ref')
    result={field:getattr(value,field) for field in fields}
    # Revalidate the private bounded target at the serialization boundary.
    native._private_target(result)
    result['playback_state']={'can_start_here':True}
    return result


def _history_native_response(value,marker,code=200):
    value=dict(value,protocol=HISTORY_NATIVE_PROTOCOL)
    if marker is not None:
        if not prepare_command._hex(marker):
            raise SourceUnavailable()
        value['context_ref']=marker
    body=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(body)>MAX_HISTORY_NATIVE_RESPONSE_BYTES:
        raise SourceUnavailable()
    return Response(body,status_code=code,media_type='application/json',headers=_HEADERS)


async def _run_history_native(request,*,play):
    service=ticket=None
    marker=None
    try:
        context,constraints,identity,marker=await _history_native_authorize(request)
        value=await asyncio.wait_for(_json_body(request,kind='history-native'),timeout=10)
        command=_history_native_command(value,play=play)
        context,constraints,_,_=await _history_native_authorize(request,identity=identity,marker=marker)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        ticket=service.begin_history_native(context=context,constraints=constraints,request=command,play=play)
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=30)
        await _history_native_authorize(request,identity=identity,marker=marker)
        expected=service_owner._Kind.HISTORY_PLAY if play else service_owner._Kind.HISTORY_ELIGIBILITY
        if delivery.kind is not expected:
            raise SourceUnavailable()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            errors={service_owner._Outcome.INVALID:('invalid_native_request',400),
                service_owner._Outcome.STALE:('stale_history',409),
                service_owner._Outcome.UNAVAILABLE:('native_target_unavailable',503)}
            if delivery.outcome not in errors:
                raise SourceUnavailable()
            error,code=errors[delivery.outcome]
            return _history_native_response({'error':error},marker,code)
        result=_history_native_wire(delivery.receipt,command,play=play)
        if play:
            # Only the genuine worker's bounded target supplies this identity.
            # Do not impose a broad media grant in place of actual track policy.
            parts=result['inventory_track_ref'].split(':')
            if (len(parts)!=3 or parts[0]!='inventory-track'
                    or parts[1]!=str(identity[2])):
                raise SourceUnavailable()
            track=_history_decimal(parts[2],minimum=1)
            await require_action('library.media.read',
                resource=ResourceScope('track',str(track)),refresh_actor=True)(request)
            await _history_native_authorize(request,identity=identity,marker=marker)
        return _history_native_response({'operation':'play' if play else 'eligibility',
            'result':result},marker)
    except HTTPException as error:
        return _history_native_response({'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_HistoryContextStale,PrivateUIContextError):
        return _history_native_response({'error':'stale_context'},None,409)
    except (_Invalid,prepare_command.PrepareInvalid,service_owner.history_native.FoobarHistoryInvalid):
        return _history_native_response({'error':'invalid_native_request'},marker,400)
    except SourceStale:
        return _history_native_response({'error':'stale_history'},marker,409)
    except Exception:
        return _history_native_response({'error':'native_target_unavailable'},marker,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


@router.post('/integrations/foobar/account/history/native/eligibility')
async def foobar_account_history_native_eligibility(request: Request):
    return await _run_history_native(request,play=False)


@router.post('/integrations/foobar/account/history/native/play')
async def foobar_account_history_native_play(request: Request):
    return await _run_history_native(request,play=True)


ENHANCED_REVIEW_PROTOCOL='foobar_enhanced_review_v1'


def _enhanced_response(value,marker=None,code=200):
    result=dict(value,protocol=ENHANCED_REVIEW_PROTOCOL)
    if marker is not None:
        if not prepare_command._hex(marker):
            raise SourceUnavailable()
        result['context_ref']=marker
    return _response(result,code,maximum=MAX_REVIEW_RESPONSE_BYTES)


def _enhanced_command(value):
    owner=service_owner.enhanced_review
    if (set(value)!={'version','source_ref','generation','expected_revision','request_ref',
            'offset','previous_upload_sha256'} or value['version']!=ENHANCED_REVIEW_PROTOCOL):
        raise _Invalid()
    command=owner.EnhancedReviewCommand(value['source_ref'],value['generation'],
        _history_decimal(value['expected_revision']),value['request_ref'],value['offset'],
        value['previous_upload_sha256'])
    owner.validate_enhanced_review_command(command)
    return command


def _enhanced_wire(result,command):
    owner=service_owner.enhanced_review
    if (type(result) is not owner.EnhancedReviewResult or result.command!=command
            or result.contract_version!=ENHANCED_REVIEW_PROTOCOL
            or not prepare_command._hex(result.upload_sha256)
            or not prepare_command._hex(result.evidence_sha256)
            or type(result.items) is not tuple or len(result.items)>20):
        raise SourceUnavailable()
    counts=('records','aliases','parsed_records','unavailable_records','local_entries',
        'cached_lastfm_entries','unresolved_local','unresolved_cached_lastfm','payload_bytes','alias_bytes')
    values={}
    for name in counts:
        number=getattr(result,name)
        if type(number) is not int or not 0<=number<=prepare_command._MAX:
            raise SourceUnavailable()
        values[name]=str(number)
    if (result.records>100000 or result.aliases>250000
            or result.payload_bytes+result.alias_bytes>67108864
            or result.local_entries+result.cached_lastfm_entries>32766*result.parsed_records
            or result.parsed_records+result.unavailable_records!=result.records
            or result.unresolved_local>result.local_entries
            or result.unresolved_cached_lastfm>result.cached_lastfm_entries
            or len(result.items)!=min(20,max(0,result.records-command.offset))):
        raise SourceUnavailable()
    items=[]
    for index,item in enumerate(result.items):
        if (type(item) is not owner.EnhancedRecordReview or item.ordinal!=command.offset+index
                or type(item.store_key) is not str or len(item.store_key)>20
                or item.data_state not in ('parsed','null','malformed','unsupported','oversized','unavailable')
                or item.mapping_state not in ('mapped','unresolved')
                or type(item.aliases) is not int or not 0<=item.aliases<=250000
                or (item.mapping_state=='mapped')!=(item.aliases>0)
                or item.local_provenance not in (None,'incomplete_possibly_seeded')
                or type(item.diagnostics) is not tuple or len(item.diagnostics)>8):
            raise SourceUnavailable()
        try:
            key=int(item.store_key)
            if str(key)!=item.store_key or not -(2**63)<=key<2**63:
                raise ValueError()
        except ValueError:
            raise SourceUnavailable() from None
        # Explicit public source-evidence fields only. Never serialize alias
        # paths, internal handles, staged paths, account IDs or session IDs.
        row={'ordinal':item.ordinal,'store_key':item.store_key,'data_state':item.data_state,
            'mapping_state':item.mapping_state,'aliases':item.aliases,
            'local_provenance':item.local_provenance,'diagnostics':[]}
        for name in ('local_entries','cached_lastfm_entries','unresolved_local','unresolved_cached_lastfm'):
            number=getattr(item,name)
            if number is not None and (type(number) is not int or not 0<=number<=32766):
                raise SourceUnavailable()
            row[name]=number
        if item.data_state=='parsed':
            if (any(row[name] is None for name in ('local_entries','cached_lastfm_entries',
                    'unresolved_local','unresolved_cached_lastfm'))
                    or item.local_provenance!='incomplete_possibly_seeded'
                    or row['local_entries']+row['cached_lastfm_entries']>32766
                    or row['unresolved_local']>row['local_entries']
                    or row['unresolved_cached_lastfm']>row['cached_lastfm_entries']):
                raise SourceUnavailable()
        elif item.local_provenance is not None or any(row[name] is not None for name in
                ('local_entries','cached_lastfm_entries','unresolved_local','unresolved_cached_lastfm')):
            raise SourceUnavailable()
        for diagnostic in item.diagnostics:
            if (type(diagnostic) is not tuple or len(diagnostic)!=2
                    or any(type(part) is not str or not part.isascii() or len(part)>64 for part in diagnostic)):
                raise SourceUnavailable()
            row['diagnostics'].append(list(diagnostic))
        items.append(row)
    if (result.next_offset is None)!=(command.offset+len(items)==result.records):
        raise SourceUnavailable()
    if result.next_offset is not None and (type(result.next_offset) is not int
            or result.next_offset!=command.offset+len(items) or not result.next_offset<result.records):
        raise SourceUnavailable()
    return dict(values,source_ref=command.source_ref,generation=command.generation,
        source_revision=str(command.expected_revision),request_ref=command.request_ref,
        upload_sha256=result.upload_sha256,evidence_sha256=result.evidence_sha256,
        offset=command.offset,next_offset=result.next_offset,items=items,
        persistence='not_applied',local_evidence='incomplete_possibly_seeded',
        cached_lastfm='separate_not_local_plays')


async def _enhanced_upload_body(request,service,ticket):
    async for chunk in request.stream():
        if type(chunk) is not bytes or len(chunk)>service_owner.enhanced_upload.MAX_CHUNK_BYTES:
            raise _Invalid()
        if not chunk:
            continue
        while not service.offer_enhanced_upload(ticket,chunk):
            # Request.stream is the sole ASGI receive owner until EOF. A
            # separate disconnect poll here can consume the next body frame.
            # Channel/route deadlines and task cancellation bound this wait.
            await asyncio.sleep(.01)
        del chunk
    service.finish_enhanced_upload(ticket)


@router.post('/integrations/foobar/account/enhanced/review')
async def foobar_account_enhanced_review(request: Request):
    service=ticket=None
    marker=None
    try:
        context,constraints,identity=await _authorize(request)
        marker=_ui_context(request)
        if (request.scope.get('query_string',b'')!=b''
                or _one_header(request,'content-encoding') is not None
                or _one_header(request,'content-type',required=True)!='application/vnd.sqlite3'):
            raise _Invalid()
        declared=_integer(_one_header(request,'x-album-haven-foobar-bytes',required=True))
        actual=_one_header(request,'content-length')
        if (not 100<=declared<=service_owner.enhanced_upload.MAX_UPLOAD_BYTES
                or actual is not None and _integer(actual)!=declared):
            raise _Invalid()
        raw=_one_header(request,'x-albumhaven-foobar-command',required=True)
        if len(raw)>MAX_COMMAND_BYTES or not raw.isascii():
            raise _Invalid()
        command=_enhanced_command(_command_json(raw.encode('ascii')))
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle or not service.available:
            raise SourceUnavailable()
        ticket=service.begin_enhanced_review(context=context,constraints=constraints,
            command=command,length=declared)
        await asyncio.wait_for(_enhanced_upload_body(request,service,ticket),
            timeout=service_owner.enhanced_upload.MAX_UPLOAD_SECONDS)
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=75)
        await _job_identity(request,identity)
        if _ui_context(request)!=marker:
            raise SourceStale()
        if delivery.kind is not service_owner._Kind.ENHANCED_REVIEW:
            raise SourceUnavailable()
        if delivery.outcome is service_owner._Outcome.STALE:
            raise SourceStale()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            raise SourceUnavailable()
        return _enhanced_response({'result':_enhanced_wire(delivery.receipt,command)},marker)
    except HTTPException as error:
        return _enhanced_response({'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_Invalid,service_owner.enhanced_review.EnhancedReviewInvalid):
        return _enhanced_response({'error':'invalid_enhanced_review_request'},marker,400)
    except SourceStale:
        return _enhanced_response({'error':'stale_enhanced_review'},marker,409)
    except Exception:
        return _enhanced_response({'error':'enhanced_review_unavailable'},marker,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


ENHANCED_HISTORY_PROTOCOL='foobar_account_enhanced_history_v1'


def _enhanced_history_response(value,marker,code=200):
    value=dict(value,protocol=ENHANCED_HISTORY_PROTOCOL)
    if marker is not None:
        if not prepare_command._hex(marker):
            raise SourceUnavailable()
        value.update(context_ref=marker,context_scope=FOOBAR_ACCOUNT_CONTEXT_SCOPE)
    body=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if len(body)>MAX_HISTORY_RESPONSE_BYTES:
        raise SourceUnavailable()
    return Response(body,status_code=code,media_type='application/json',headers=_HEADERS)


def _enhanced_history_wire(page,marker):
    owner=service_owner.enhanced_history
    if (type(page) is not owner.EnhancedHistoryPage or len(page.items)>20
            or not prepare_command._uuid(page.source_ref)
            or not prepare_command._integer(page.source_revision,0,9223372036854775807)
            or page.view not in ('entries','records')):
        raise SourceUnavailable()
    items=[]
    for item in page.items:
        if type(item) is not owner.EnhancedHistoryItem or not prepare_command._uuid(item.observation_ref):
            raise SourceUnavailable()
        h=item.header
        owner.codec.encode_enhanced_history_header(h)
        entry=item.entry
        if (page.view=='entries')!=(entry is not None):
            raise SourceUnavailable()
        if entry is not None:
            owner.codec.encode_local_entry(entry)
        items.append({'observation_ref':item.observation_ref,'observation_revision':str(h.source_revision),
            'effective_sha256':h.effective_evidence_sha256,'display_sha256':h.display_sha256,
            'label':h.label,'label_kind':h.label_kind,'label_truncated':h.label_truncated,
            'local_vector_count':None if h.local_entry_count is None else str(h.local_entry_count),
            'count_meaning':'reported_local_vector_entries_not_lifetime_plays',
            'local_provenance':h.local_provenance,'entry':None if entry is None else {
                'ordinal':entry.ordinal,'raw_filetime_ticks':str(entry.raw_filetime_ticks),
                'unix_100ns':None if entry.unix_100ns is None else str(entry.unix_100ns),
                'state':entry.state,'code':entry.code,'iso_utc':entry.iso_utc,
                'provenance':entry.local_provenance}})
    def cursor_wire(c):
        if c is None:
            return None
        owner.validate_request(owner.EnhancedHistoryRequest(page.source_ref,page.view,c))
        if c.source_revision!=page.source_revision:
            raise SourceUnavailable()
        return {'context_ref':marker,'source_ref':c.source_ref,'source_revision':str(c.source_revision),
            'view':c.view,'sort_key':str(c.sort_key),'observation_ref':c.observation_ref,
            'ordinal':str(c.ordinal),'direction':c.direction}
    return {'source_ref':page.source_ref,'source_revision':str(page.source_revision),
        'view':page.view,'ordering':'resolved_time_then_undated' if page.view=='entries' else 'source_record_identity',
        'items':items,'next_cursor':cursor_wire(page.next_cursor),'previous_cursor':cursor_wire(page.previous_cursor)}


@router.post('/integrations/foobar/account/history/enhanced')
async def foobar_account_enhanced_history(request: Request):
    service=ticket=None
    marker=None
    try:
        context,constraints,identity,marker=await _history_authorize(request)
        value=await asyncio.wait_for(_json_body(request,kind='history'),timeout=10)
        if set(value)!={'version','source_ref','view','cursor'} or value['version']!=ENHANCED_HISTORY_PROTOCOL:
            raise _Invalid()
        owner=service_owner.enhanced_history
        c=value['cursor']
        if c is not None:
            if (type(c) is not dict or set(c)!={'context_ref','source_ref','source_revision','view','sort_key','observation_ref','ordinal','direction'}):
                raise _Invalid()
            if c['context_ref']!=marker:
                raise _HistoryContextStale()
            c=owner.EnhancedHistoryCursor(context.actor.account_id,c['source_ref'],
                _history_decimal(c['source_revision']),c['view'],
                _history_decimal(c['sort_key'],minimum=-(2**63)),c['observation_ref'],
                _history_decimal(c['ordinal'],minimum=-1),c['direction'])
        command=owner.EnhancedHistoryRequest(value['source_ref'],value['view'],c)
        owner.validate_request(command)
        context,constraints,_,_=await _history_authorize(request,identity=identity,marker=marker)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        ticket=service.begin_enhanced_history(context=context,constraints=constraints,request=command)
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=60)
        await _history_authorize(request,identity=identity,marker=marker)
        if (type(delivery) is not service_owner._Delivery or delivery.kind is not service_owner._Kind.ENHANCED_HISTORY):
            raise SourceUnavailable()
        if delivery.outcome is service_owner._Outcome.STALE:
            raise SourceStale()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            raise SourceUnavailable()
        page=delivery.receipt
        if (type(page) is not owner.EnhancedHistoryPage
                or (page.source_ref,page.view)!=(command.source_ref,command.view)):
            raise SourceUnavailable()
        return _enhanced_history_response({'result':_enhanced_history_wire(page,marker)},marker)
    except HTTPException as error:
        return _enhanced_history_response({'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid,FoobarHistoryInvalid):
        return _enhanced_history_response({'error':'invalid_history_request'},marker,400)
    except _HistoryContextStale:
        return _enhanced_history_response({'error':'stale_history_context'},None,409)
    except SourceStale:
        return _enhanced_history_response({'error':'stale_history'},marker,409)
    except Exception:
        return _enhanced_history_response({'error':'history_unavailable'},marker,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)


TRACK_EVIDENCE_PROTOCOL='foobar_account_track_evidence_v1'


def _track_evidence_command(value):
    owner=service_owner.track_evidence
    if (type(value) is not dict or set(value)!={'version','track_id','family','cursor'}
            or value['version']!=TRACK_EVIDENCE_PROTOCOL):
        raise _Invalid()
    cursor=value['cursor']
    if cursor is not None:
        if type(cursor) is not dict or set(cursor)!={'account_id','library_id','track_id','track_sha256','family','source_ref','observation_ref'}:
            raise _Invalid()
        cursor=owner.TrackEvidenceCursor(_history_decimal(cursor['account_id'],minimum=1),
            _history_decimal(cursor['library_id'],minimum=1),_history_decimal(cursor['track_id'],minimum=1),
            cursor['track_sha256'],cursor['family'],cursor['source_ref'],cursor['observation_ref'])
    result=owner.TrackEvidenceRequest(_history_decimal(value['track_id'],minimum=1),value['family'],cursor)
    owner.validate_request(result)
    return result


def _track_evidence_semantics(item):
    if item.evidence_kind=='enhanced_store':
        return ((item.count_state=='valid' and item.count is not None and item.count<=32766
                 and item.status=='ready' and item.reason is None)
            or (item.count_state=='unavailable' and item.count is None and item.status=='unavailable'
                and item.reason=='local_timestamp_vector_unavailable'))
    if item.count_state!='valid':
        return (item.count is None and ((item.count_state=='invalid'
                and item.status=='needs_reconciliation' and item.reason=='invalid_count')
            or (item.count_state in ('absent','empty','unavailable')
                and item.status=='unavailable' and item.reason=='count_unavailable')))
    if item.count is None: return False
    if item.status=='ready': return item.reason is None
    if item.status!='needs_reconciliation': return False
    return ((item.reason=='zero_count_with_boundaries' and item.count==0)
        or (item.reason=='boundary_order_conflict' and item.count>0)
        or (item.reason=='single_count_boundary_conflict' and item.count==1))


def _track_evidence_wire(page,command):
    owner=service_owner.track_evidence
    if (type(page) is not owner.TrackEvidencePage or page.track_id!=command.track_id
            or page.family!=command.family or type(page.items) is not tuple or len(page.items)>20
            or page.consistency!='current_page_refresh_to_restart'):
        raise SourceUnavailable()
    items=[]
    for item in page.items:
        if (type(item) is not owner.TrackEvidenceItem
                or not _request_uuid(item.source_ref) or not _request_uuid(item.observation_ref)
                or type(item.source_created_at) is not str or len(item.source_created_at)!=27
                or type(item.source_revision) is not int or not 1<=item.source_revision<=9223372036854775807
                or type(item.association_version) is not int or not 1<=item.association_version<=9223372036854775807
                or item.evidence_kind not in ('tsv_snapshot','enhanced_store')
                or item.count_state not in ('valid','invalid','unavailable','absent','empty')
                or item.count is not None and (type(item.count) is not int or not 0<=item.count<=9223372036854775807)
                or item.status not in ('ready','unavailable','needs_reconciliation')
                or item.reason is not None and (type(item.reason) is not str or len(item.reason)>128)
                or not _track_evidence_semantics(item)):
            raise SourceUnavailable()
        items.append(dict(source_ref=item.source_ref,source_created_at=item.source_created_at,
            observation_ref=item.observation_ref,source_revision=str(item.source_revision),
            association_version=str(item.association_version),evidence_kind=item.evidence_kind,
            count_state=item.count_state,count=str(item.count) if item.count is not None else None,
            status=item.status,reason=item.reason))
    c=page.next_cursor
    if c is not None:
        owner.validate_request(owner.TrackEvidenceRequest(command.track_id,command.family,c))
        if not items or (c.source_ref,c.observation_ref)!=(items[-1]['source_ref'],items[-1]['observation_ref']):
            raise SourceUnavailable()
    cursor=None if c is None else dict(account_id=str(c.account_id),library_id=str(c.library_id),
        track_id=str(c.track_id),track_sha256=c.track_sha256,family=c.family,
        source_ref=c.source_ref,observation_ref=c.observation_ref)
    return dict(track_id=str(page.track_id),family=page.family,items=items,next_cursor=cursor,
        consistency=page.consistency)


def _track_evidence_response(value,marker,code=200):
    value=dict(value,protocol=TRACK_EVIDENCE_PROTOCOL,context_ref=marker)
    body=json.dumps(value,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('ascii')
    if len(body)>service_owner.track_evidence.MAX_RESPONSE_BYTES:
        raise SourceUnavailable()
    return Response(body,status_code=code,media_type='application/json',headers={
        'Cache-Control':'private, no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer',
        'X-Content-Type-Options':'nosniff'})


@router.post('/integrations/foobar/account/history/native/evidence')
async def foobar_account_track_evidence(request: Request):
    service=ticket=None
    marker=None
    try:
        context,constraints,identity,marker=await _history_native_authorize(request)
        value=await asyncio.wait_for(_json_body(request,kind='history'),timeout=10)
        command=_track_evidence_command(value)
        await require_action('library.browse.read',resource=ResourceScope('track',str(command.track_id)),refresh_actor=True)(request)
        context,constraints,_,_=await _history_native_authorize(request,identity=identity,marker=marker)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle: raise SourceUnavailable()
        ticket=service.begin_track_evidence(context=context,constraints=constraints,request=command)
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=30)
        await require_action('library.browse.read',resource=ResourceScope('track',str(command.track_id)),refresh_actor=True)(request)
        await _history_native_authorize(request,identity=identity,marker=marker)
        if delivery.kind is not service_owner._Kind.TRACK_EVIDENCE: raise SourceUnavailable()
        if delivery.outcome is not service_owner._Outcome.SUCCESS:
            errors={service_owner._Outcome.INVALID:('invalid_evidence_request',400),
                service_owner._Outcome.STALE:('stale_evidence',409),
                service_owner._Outcome.UNAVAILABLE:('evidence_unavailable',503)}
            if delivery.outcome not in errors: raise SourceUnavailable()
            error,code=errors[delivery.outcome]
            return _track_evidence_response({'error':error},marker,code)
        return _track_evidence_response({'result':_track_evidence_wire(delivery.receipt,command)},marker)
    except HTTPException as error:
        return _track_evidence_response({'error':'authentication_required' if error.status_code==401 else 'forbidden'},None,error.status_code)
    except (_HistoryContextStale,PrivateUIContextError):
        return _track_evidence_response({'error':'stale_context'},None,409)
    except (_Invalid,prepare_command.PrepareInvalid,FoobarHistoryInvalid):
        return _track_evidence_response({'error':'invalid_evidence_request'},marker,400)
    except SourceStale:
        return _track_evidence_response({'error':'stale_evidence'},marker,409)
    except Exception:
        return _track_evidence_response({'error':'evidence_unavailable'},marker,503)
    finally:
        if service is not None and ticket is not None: service.abandon(ticket)


MAINTENANCE_PROTOCOL='foobar_account_maintenance_v1'


def _maintenance_command(value):
    owner=service_owner.maintenance
    if (type(value) is not dict or set(value)!={'version','source_ref','cursor'}
            or value['version']!=MAINTENANCE_PROTOCOL or not _request_uuid(value['source_ref'])):
        raise _Invalid()
    c=value['cursor']
    if c is not None:
        if type(c) is not dict or set(c)!={'expires_at','generation','receipt_ref'}:
            raise _Invalid()
        c=owner.MaintenanceCursor(c['expires_at'],c['generation'],c['receipt_ref'])
    command=owner.MaintenanceRequest(value['source_ref'],c)
    owner.validate_request(command)
    return command


def _maintenance_wire(result,command):
    owner=service_owner.maintenance
    if (type(result) is not owner.MaintenanceResult or result.source_ref!=command.source_ref
            or any(type(v) is not int or not 0<=v<=20 for v in
                (result.inspected,result.removed_receipts,result.protected_receipts))
            or result.removed_receipts+result.protected_receipts!=result.inspected
            or type(result.removed_keys) is not int or not 0<=result.removed_keys<=100
            or type(result.retired_through) is not int or not 0<=result.retired_through<2147483647
            or type(result.more_retired_keys) is not bool):
        raise SourceUnavailable()
    c=result.next_cursor
    if c is not None:
        owner.validate_request(owner.MaintenanceRequest(command.source_ref,c))
        if result.inspected!=20: raise SourceUnavailable()
    cursor=None if c is None else dict(expires_at=c.expires_at,generation=c.generation,receipt_ref=c.receipt_ref)
    return dict(source_ref=result.source_ref,inspected=result.inspected,
        removed_receipts=result.removed_receipts,protected_receipts=result.protected_receipts,
        removed_keys=result.removed_keys,retired_through=result.retired_through,
        next_cursor=cursor,more_retired_keys=result.more_retired_keys,
        history_deleted=False,job_reconciled=False)


@router.post('/integrations/foobar/account/maintenance')
async def foobar_account_maintenance(request: Request):
    service=ticket=None
    marker=None
    dispatched=False
    try:
        context,constraints,identity=await _authorize(request)
        marker=_ui_context(request)
        command=_maintenance_command(await asyncio.wait_for(_json_body(request,kind='history'),timeout=10))
        context,constraints=await _job_identity(request,identity)
        if _ui_context(request)!=marker: raise SourceStale()
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle: raise SourceUnavailable()
        ticket=service.begin_maintenance(context=context,constraints=constraints,request=command)
        dispatched=True
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=60)
        await _job_identity(request,identity)
        if _ui_context(request)!=marker: raise SourceStale()
        if delivery.kind is not service_owner._Kind.MAINTENANCE: raise SourceUnavailable()
        if delivery.outcome is not service_owner._Outcome.SUCCESS: raise SourceUnavailable()
        return _ui_response(dict(protocol=MAINTENANCE_PROTOCOL,
            result=_maintenance_wire(delivery.receipt,command)),marker)
    except HTTPException as error:
        return _ui_response(dict(protocol=MAINTENANCE_PROTOCOL,error='authentication_required'
            if error.status_code==401 else 'forbidden',outcome_uncertain=dispatched),None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _ui_response(dict(protocol=MAINTENANCE_PROTOCOL,error='invalid_maintenance_request',
            outcome_uncertain=dispatched),marker,400)
    except SourceStale:
        return _ui_response(dict(protocol=MAINTENANCE_PROTOCOL,error='stale_context',
            outcome_uncertain=dispatched),marker,409)
    except Exception:
        return _ui_response(dict(protocol=MAINTENANCE_PROTOCOL,error='maintenance_unavailable',
            outcome_uncertain=dispatched),marker,503)
    finally:
        if service is not None and ticket is not None: service.abandon(ticket)


@router.post('/integrations/foobar/account/temporary-source/status')
async def foobar_account_temporary_source_status(request: Request):
    protocol='foobar_temporary_source_v1'
    service=ticket=None
    ui_ref=None
    try:
        context,constraints,identity=await _authorize(request)
        ui_ref=_ui_context(request)
        service=getattr(request.app.state,'foobar_account_import_service',None)
        if type(service) is not service_owner.FoobarImportHandle:
            raise SourceUnavailable()
        value=await asyncio.wait_for(_json_body(request),timeout=10)
        if set(value)!={'version','source_ref','job_ref'} or value['version']!=protocol:
            raise _Invalid()
        ticket=service.begin_temporary_status(context=context,constraints=constraints,
            source_ref=value['source_ref'],job_ref=value['job_ref'])
        delivery=await asyncio.wait_for(_delivery(request,service,ticket),timeout=15)
        await _job_identity(request,identity)
        if _ui_context(request)!=ui_ref:
            raise SourceStale()
        if delivery.kind.value!='temporary-status' or delivery.outcome.value!='success':
            raise SourceUnavailable()
        result=delivery.receipt
        if type(result) is not service_owner.temporary_source.TemporarySourceStatus:
            raise SourceUnavailable()
        item=result.identity
        source=None if item is None else dict(source_ref=item.source_ref,job_ref=item.job_ref,
            mapping_name=item.mapping_name,upload_sha256=item.upload_sha256,
            byte_length=item.byte_length,expires_at=result.expires_at)
        return _ui_response(dict(protocol=protocol,source=source),ui_ref)
    except HTTPException as error:
        return _ui_response(dict(protocol=protocol,error='authentication_required' if error.status_code==401 else 'forbidden'),None,error.status_code)
    except (_Invalid,prepare_command.PrepareInvalid):
        return _ui_response(dict(protocol=protocol,error='invalid_import_request'),ui_ref,400)
    except SourceStale:
        return _ui_response(dict(protocol=protocol,error='stale_import'),ui_ref,409)
    except Exception:
        return _ui_response(dict(protocol=protocol,error='unavailable'),ui_ref,503)
    finally:
        if service is not None and ticket is not None:
            service.abandon(ticket)
