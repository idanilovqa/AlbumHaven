"""Real rollback-only review on the existing importer worker.

A semantic digest is a user-intent equality constraint, never authorization.
No raw upload survives settlement and no job/checkpoint is created by review.
"""
from dataclasses import dataclass
from hashlib import sha256
import json
from uuid import UUID, uuid5

from . import foobar_account_import_prepare as prepare
from . import foobar_account_import_jobs as jobs
from . import foobar_account_prepare_gate as gate
from . import foobar_account_indexed_upload as indexed
from . import foobar_account_import_preflight as preflight
from . import foobar_source_window as window
from . import foobar_enhanced_raw_windows as enhanced_windows
from .foobar_account_source_postgres import SourceStale, SourceUnavailable
from .foobar_account_source_postgres import FoobarSourceCapacityExceeded

REVIEW_HOLD_BYTES=preflight.REVIEW_AGGREGATE_BYTES
CONFLICT_HOLD_BYTES=prepare.CONFLICT_CONTROL_BYTES
DETAIL_HOLD_BYTES=CONFLICT_HOLD_BYTES+prepare.PROBLEM_CONTROL_BYTES+prepare.observation_preview.CONTROL_BYTES


@dataclass(frozen=True,slots=True)
class FoobarReviewRequest:
    source_ref: str
    job_ref: str
    matching_library_id: int | None
    resume: bool
    conflict_after: int = 0
    previous_review_sha256: str | None = None
    problem_after: int = 0
    mapping_name: str = gate.MAPPING
    observation_after: int | None = None
    observation_raw: prepare.observation_preview.RawFieldRequest | None = None


@dataclass(frozen=True,slots=True)
class FoobarReviewResult:
    command: jobs.FoobarJobCommand
    inventory_sha256: str
    resume: bool
    proposed: preflight.FoobarGlobalPreflight


@dataclass(frozen=True,slots=True)
class FoobarReviewProgress:
    account_id: int
    session_id: int
    request: FoobarReviewRequest
    phase: str
    result: FoobarReviewResult | None = None
    error: str | None = None


def validate_review_request(request):
    if (type(request) is not FoobarReviewRequest or not gate._uuid(request.source_ref)
            or not gate._uuid(request.job_ref) or type(request.resume) is not bool
            or not gate._integer(request.conflict_after,0,200001)
            or not gate._integer(request.problem_after,0,3200031)
            or request.previous_review_sha256 is not None and not gate._hex(request.previous_review_sha256)
            or (request.conflict_after>0 or request.problem_after>0) and request.previous_review_sha256 is None
            or request.matching_library_id is not None and not gate._integer(request.matching_library_id,1,gate._MAX)):
        raise gate.PrepareInvalid()
    gate.parser_for_mapping(request.mapping_name)
    if request.observation_after is not None:
        try:
            prepare.observation_preview.validate_page(request.observation_after,raw=request.observation_raw)
        except SourceUnavailable:
            raise gate.PrepareInvalid() from None
        if (request.mapping_name!=gate.MAPPING or request.conflict_after!=0 or request.problem_after!=0
                or request.previous_review_sha256 is None):
            raise gate.PrepareInvalid()
    elif request.observation_raw is not None:
        raise gate.PrepareInvalid()
    if request.mapping_name==gate.ENHANCED_MAPPING and (
            request.conflict_after!=0
            or request.problem_after!=0 or request.previous_review_sha256 is not None):
        raise gate.PrepareInvalid()



def checked_observation_continuation(request,cached):
    """Only an exact currently reviewed page/field continuation, never authority."""
    if (request.observation_after is None
            or request.mapping_name!=cached.request.mapping_name
            or request.matching_library_id!=cached.request.matching_library_id
            or request.resume!=cached.request.resume):
        raise SourceStale()
    report=cached.result.proposed
    after=request.observation_after
    raw=request.observation_raw
    if report.observation_after is None:
        if after!=report.start_offset or raw is not None:
            raise SourceStale()
        return
    if after==report.observation_next and raw is None:
        return
    if after!=report.observation_after:
        raise SourceStale()
    if raw is None:
        return
    if raw.ordinal not in tuple(item.ordinal for item in report.observation_items):
        raise SourceStale()
    if raw.offset==0:
        return
    prior=report.observation_chunk
    if (prior is None or (raw.ordinal,raw.side,raw.field,raw.offset)!=
            (prior.ordinal,prior.side,prior.field,prior.next_offset)):
        raise SourceStale()


def review_intent_sha256(command,inventory_sha256,resume,proposal_sha256):
    jobs._command(command)
    if (not gate._hex(inventory_sha256) or not gate._hex(proposal_sha256)
            or type(resume) is not bool):
        raise SourceUnavailable()
    value=(command.source_ref,command.job_ref,command.upload_sha256,command.parser_version,
        command.mapping_name,command.original_matching_library_id,command.original_generation,
        command.total_rows,inventory_sha256,resume,proposal_sha256)
    return sha256(b'albumhaven.foobar.review.intent.v1\n'+json.dumps(value,
        ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')).hexdigest()


class _ResolvedRollback(Exception):
    def __init__(self,value):
        self.value=value


def _resolve(database_url,context,*,request,scan,capacity,retained_bytes,constraints):
    """Read real source/job/current inventory under real locks; roll back clock."""
    checked=prepare._checked_constraints(constraints)
    if request.mapping_name==gate.ENHANCED_MAPPING:
        if type(scan) is not enhanced_windows.EnhancedRawIndex:
            raise gate.PrepareInvalid()
        upload_hash,parser_version,total=scan.upload_sha256,gate.ENHANCED_PARSER,scan.records
    else:
        upload_hash,parser_version,total=scan.source_sha256,scan.contract_version,scan.summary.data_rows
    try:
        deadline=prepare._Deadline()
        with prepare.current_foobar_import_transaction(database_url,context,
                matching_library_id=request.matching_library_id,constraints=checked) as (raw,live,now):
            connection=prepare._Connection(raw,deadline)
            jobs.require_job_schema_on_connection(connection)
            stream=jobs._stream(connection,live,request.source_ref,roll=True)
            if request.resume:
                job=jobs._job(connection,live,request.source_ref,request.job_ref)
                command=jobs._job_command(request.source_ref,job)
                if (command.upload_sha256!=upload_hash or command.parser_version!=parser_version
                        or command.total_rows!=total
                        or command.mapping_name!=request.mapping_name
                        or command.original_matching_library_id!=request.matching_library_id):
                    raise SourceStale()
                offset=job['confirmed_through']
                if offset==command.total_rows:
                    raise SourceStale()
            else:
                # A retained identity is recovered through explicit resume, not
                # reset to a new command merely because the UI lost local state.
                if jobs._job(connection,live,request.source_ref,request.job_ref,optional=True) is not None:
                    raise SourceStale()
                command=jobs.FoobarJobCommand(request.source_ref,request.job_ref,
                    upload_hash,parser_version,request.mapping_name,
                    request.matching_library_id,stream['current_generation'],total)
                jobs._command(command)
                offset=0
            live=prepare._matching_context(connection,live,context,request.matching_library_id,
                constraints=checked)
            if request.matching_library_id is None:
                inventory_sha256=prepare.NO_LIBRARY_INVENTORY_SHA256
            else:
                from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
                require_foobar_match_schema_on_connection(connection)
                prepare.intake._admit(capacity,retained_bytes+prepare.preview.SCALAR_WORK_BYTES
                    +prepare.INVENTORY_FORWARDING_BYTES+REVIEW_HOLD_BYTES)
                scalars=prepare.read_foobar_inventory_scalars_on_connection(connection,live,constraints=checked)
                prepare.intake._admit(capacity,retained_bytes+REVIEW_HOLD_BYTES+
                    prepare._inventory_intake_bytes(0,0,len(scalars),sum(row.path_bytes for row in scalars)))
                inventory=prepare.read_foobar_preview_inventory_on_connection(connection,live,
                    expected_files=scalars,constraints=checked)
                inventory_sha256=inventory.revision
            if not gate._hex(inventory_sha256):
                raise SourceUnavailable()
            base=gate.FoobarPrepareCommand(command.source_ref,stream['current_generation'],
                str(uuid5(UUID(command.job_ref),'foobar-global-preflight')),stream['revision'],
                command.upload_sha256,command.mapping_name,offset,inventory_sha256,
                command.original_matching_library_id)
            prepare.require_account_foobar(live,checked)
            deadline.check()
            raw.rollback()
            if (raw.closed is not False or prepare.taste.psycopg is None
                    or raw.info.transaction_status!=prepare.taste.psycopg.pq.TransactionStatus.IDLE):
                raise SourceUnavailable()
            deadline.check()
            raise _ResolvedRollback((command,base))
    except _ResolvedRollback as done:
        return done.value
    except (SourceStale,SourceUnavailable,gate.PrepareInvalid):
        raise
    except Exception:
        raise SourceUnavailable() from None


def _publish(owner,operation,phase,*,result=None,error=None):
    with owner.condition:
        if owner.current is not operation:
            raise SourceUnavailable()
        if phase=='review_ready' and operation.job_cancel.is_set():
            phase,result,error='cancelled_review',None,None
        old=operation.review_progress
        value=FoobarReviewProgress(old.account_id,old.session_id,old.request,phase,result,error)
        operation.review_progress=value
        owner.condition.notify_all()
        return value


def run_foobar_review(owner,operation):
    from . import foobar_account_import_service as service
    if (type(owner) is not service._ProcessOwner or owner.current is not operation
            or type(operation.review_request) is not FoobarReviewRequest):
        raise SourceUnavailable()
    request=operation.review_request
    validate_review_request(request)
    raw_index=None
    try:
        _publish(owner,operation,'validating_source')
        is_enhanced=request.mapping_name==gate.ENHANCED_MAPPING
        if is_enhanced:
            scan=operation.indexed_upload
            if type(scan) is not enhanced_windows.EnhancedRawIndex:
                raise SourceUnavailable()
            total=scan.records
            retained_bytes=enhanced_windows.index_retained_logical_bytes(total)
        else:
            raw_index=window.build_foobar_upload_index(operation.intake._payload,
                mapping_name=gate.MAPPING,intake_capacity=owner.intake_capacity)
            scan=raw_index.terminal
            total=scan.summary.data_rows
            retained_bytes=window.indexed_upload_intake_bytes(raw_index.payload_bytes)
        if not 1<=total<=100000:
            raise gate.PrepareInvalid()
        command,base=_resolve(owner.database_url,operation.context,request=request,scan=scan,
            capacity=owner.intake_capacity,
            retained_bytes=retained_bytes,
            constraints=operation.constraints)
        previous=operation.continuation_review
        if previous is not None and command!=previous:
            raise SourceStale()
        if operation.job_cancel.is_set():
            return _publish(owner,operation,'cancelled_review')
        if not is_enhanced:
            operation.indexed_upload=indexed.adopt_account_indexed_upload(operation.context,
                upload=raw_index,command=base,intake_capacity=owner.intake_capacity)
            raw_index=None
        _publish(owner,operation,'reviewing')
        proposed=preflight.preflight_indexed_foobar_import(owner.database_url,operation.context,
            upload=operation.indexed_upload,command=base,intake_capacity=owner.intake_capacity,
            cancel_event=operation.job_cancel,constraints=operation.constraints,
            conflict_after=None if is_enhanced or request.observation_after is not None else request.conflict_after,
            problem_after=None if is_enhanced or request.observation_after is not None else request.problem_after,
            **({} if request.observation_after is None else dict(
                observation_after=request.observation_after,observation_raw=request.observation_raw)))
        if operation.job_cancel.is_set() or proposed.status!='complete_preflight':
            return _publish(owner,operation,'cancelled_review')
        if proposed.start_offset!=base.offset or proposed.remaining_rows!=0:
            raise SourceUnavailable()
        if previous is not None and review_intent_sha256(command,base.inventory_sha256,
                request.resume,proposed.proposal_sha256)!=request.previous_review_sha256:
            raise SourceStale()
        return _publish(owner,operation,'review_ready',result=FoobarReviewResult(
            command,base.inventory_sha256,request.resume,proposed))
    except FoobarSourceCapacityExceeded:
        return _publish(owner,operation,'review_unavailable',error='foobar_source_quota_exceeded')
    except (gate.PrepareInvalid,prepare.intake.FoobarPreparationRejected):
        return _publish(owner,operation,'invalid_source',error='invalid_import_request')
    except SourceStale:
        return _publish(owner,operation,'needs_review',error='stale_import')
    except Exception:
        return _publish(owner,operation,'review_unavailable',error='unavailable')
    finally:
        if raw_index is not None:
            raw_index.close()


def checked_cached_review(value,context,source_ref,job_ref,review_sha256):
    """Exact server-owned cached review; digest equality is not authority."""
    if (type(value) is not FoobarReviewProgress or value.phase!='review_ready'
            or type(value.result) is not FoobarReviewResult
            or (value.account_id,value.session_id)!=(context.actor.account_id,context.actor.session_id)
            or (value.request.source_ref,value.request.job_ref)!=(source_ref,job_ref)
            or review_intent_sha256(value.result.command,value.result.inventory_sha256,
                value.result.resume,value.result.proposed.proposal_sha256)!=review_sha256):
        raise SourceStale()
    return value
