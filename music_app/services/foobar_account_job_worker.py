"""Concrete importer job runner on the existing process worker, no new executor."""
from dataclasses import dataclass, replace
import json
import hmac
from uuid import UUID, uuid5

from . import foobar_account_import_jobs as jobs
from . import foobar_account_prepare_gate as gate
from . import foobar_account_indexed_upload as indexed
from . import foobar_source_window as window
from . import foobar_enhanced_raw_windows as enhanced_windows
from . import foobar_account_import_preflight as preflight
from . import foobar_account_import_terminal as terminal
from . import foobar_account_import_review as review
from .foobar_account_source_postgres import SourceStale, SourceUnavailable
from .foobar_account_source_postgres import FoobarSourceCapacityExceeded
from .foobar_import_preparation import FoobarPreparationRejected


@dataclass(frozen=True,slots=True)
class FoobarJobRequest:
    command: jobs.FoobarJobCommand
    inventory_sha256: str
    resume: bool
    review_sha256: str


@dataclass(frozen=True,slots=True)
class FoobarJobProgress:
    account_id: int
    command: jobs.FoobarJobCommand
    status: jobs.FoobarJobStatus | None
    phase: str
    uncertain: bool = False
    cancel_pending: bool = False
    proposed: preflight.FoobarGlobalPreflight | None = None
    error: str | None = None


def _publish(owner, operation, *, phase, status=None, uncertain=False, error=None, proposed=None):
    # Only the real process worker writes progress. Request threads only set the
    # bounded cancellation signal/context under this same existing condition.
    with owner.condition:
        if owner.current is not operation:
            raise SourceUnavailable()
        old=operation.job_progress
        status=old.status if status is None else status
        if status is not None and (type(status) is not jobs.FoobarJobStatus
                or status.command!=operation.job_request.command):
            raise SourceStale()
        result=FoobarJobProgress(old.account_id,old.command,status,phase,uncertain,
            operation.job_cancel.is_set() and (status is None or
                status.disposition!='completed' and not status.cancel_requested),
            old.proposed if proposed is None else proposed,error)
        operation.job_progress=result
        owner.condition.notify_all()
        return result


def _cancel(owner,operation):
    if not operation.job_cancel.is_set():
        return None
    with owner.condition:
        cancel_context=operation.job_cancel_context
    context,constraints=(cancel_context if cancel_context is not None
                         else (operation.context,operation.constraints))
    request=operation.job_request.command
    status=jobs.cancel_foobar_import_job(owner.database_url,context,
        source_ref=request.source_ref,job_ref=request.job_ref,constraints=constraints)
    return _publish(owner,operation,phase='completed' if status.disposition=='completed' else 'cancelled',
                    status=status)


def _phase(owner,operation,kind,command):
    from . import foobar_account_import_service as service
    if not owner.retry_permitted(operation):
        raise SourceStale()
    # The SAME real current operation owns its slot, context, upload and retry
    # reconciliation. Never mint another worker ticket or callback result.
    operation.kind,operation.command=kind,command
    try:
        return service._call_bounded(owner,operation)
    finally:
        operation.kind,operation.command=service._Kind.JOB,operation.job_request


def _reconcile(owner,operation,batch):
    result=jobs.reconcile_foobar_job_batch(owner.database_url,operation.context,
        source_ref=batch.source_ref,job_ref=batch.job_ref,batch_no=batch.batch_no,
        attempt_no=batch.attempt_no,constraints=operation.constraints)
    if (type(result) is not jobs.FoobarJobReconciliation
            or type(result.batch) is not jobs.FoobarJobBatch
            or (result.batch.source_ref,result.batch.job_ref,result.batch.batch_no,result.batch.attempt_no)
                !=(batch.source_ref,batch.job_ref,batch.batch_no,batch.attempt_no)):
        raise SourceUnavailable()
    return result


def _committed_revision(result,batch):
    # This is metadata extraction AFTER the genuine repository authenticated the
    # exact durable terminal and operation associations, not a success decoder
    # for caller bytes. No expected header is invented from untrusted bytes.
    if result.disposition!='confirmed' or type(result.batch.terminal_bytes) is not bytes:
        raise jobs.FoobarJobUnresolved()
    record=tuple(json.loads(result.batch.terminal_bytes.decode('ascii')))
    terminal._record(record)
    command=batch.prepare_command
    if (record[2]!=command.source_ref or record[4]!=command.request_key
            or record[8]!=command.upload_sha256 or record[11]!=command.expected_revision
            or record[14]!=command.offset+1 or record[23]!=command.generation
            or result.batch.window_end!=record[15]
            or result.status.confirmed_through!=record[15]-1):
        raise jobs.FoobarJobUnresolved()
    return record[12]


def run_foobar_job(owner,operation):
    from . import foobar_account_import_service as service
    if (type(owner) is not service._ProcessOwner or owner.current is not operation
            or type(operation.job_request) is not FoobarJobRequest):
        raise SourceUnavailable()
    request=operation.job_request
    command=request.command
    raw_index=None
    try:
        _publish(owner,operation,phase='validating_source')
        is_enhanced=command.mapping_name==gate.ENHANCED_MAPPING
        if is_enhanced:
            upload=operation.indexed_upload
            if (type(upload) is not enhanced_windows.EnhancedRawIndex
                    or upload.upload_sha256!=command.upload_sha256
                    or upload.records!=command.total_rows or command.parser_version!=gate.ENHANCED_PARSER):
                raise gate.PrepareInvalid()
        else:
            raw_index=window.build_foobar_upload_index(operation.intake._payload,
                mapping_name=command.mapping_name,intake_capacity=owner.intake_capacity)
            scan=raw_index.terminal
            if (scan.source_sha256!=command.upload_sha256 or scan.contract_version!=command.parser_version
                    or scan.summary.data_rows!=command.total_rows):
                raise gate.PrepareInvalid()
        # Real parser completion precedes even durable job metadata creation.
        if request.resume:
            status=jobs.read_foobar_import_job(owner.database_url,operation.context,
                source_ref=command.source_ref,job_ref=command.job_ref,constraints=operation.constraints)
            if status.command!=command:
                raise SourceStale()
            status=jobs.resume_foobar_import_job(owner.database_url,operation.context,
                source_ref=command.source_ref,job_ref=command.job_ref,constraints=operation.constraints)
        else:
            try:
                status=jobs.start_foobar_import_job(owner.database_url,operation.context,
                    command=command,constraints=operation.constraints)
            except (gate.PrepareInvalid,SourceStale):
                raise
            except Exception:
                # Unknown start acknowledgement: read the SAME durable identity,
                # never repeat with a replacement key or assume rollback.
                status=jobs.read_foobar_import_job(owner.database_url,operation.context,
                    source_ref=command.source_ref,job_ref=command.job_ref,constraints=operation.constraints)
        if type(status) is not jobs.FoobarJobStatus or status.command!=command:
            raise SourceStale()
        _publish(owner,operation,phase='preflighting',status=status)
        if status.disposition=='completed':
            return _publish(owner,operation,phase='completed',status=status)
        if status.cancel_requested or status.disposition=='needs_resume':
            return _publish(owner,operation,phase='needs_resume',status=status)
        if operation.job_cancel.is_set():
            return _cancel(owner,operation)
        base=gate.FoobarPrepareCommand(command.source_ref,status.current_generation,
            str(uuid5(UUID(command.job_ref),'foobar-global-preflight')),
            status.source_revision,command.upload_sha256,command.mapping_name,
            status.confirmed_through,request.inventory_sha256,command.original_matching_library_id)
        if not is_enhanced:
            operation.indexed_upload=indexed.adopt_account_indexed_upload(operation.context,
                upload=raw_index,command=base,intake_capacity=owner.intake_capacity)
            raw_index=None
        proposed=preflight.preflight_indexed_foobar_import(owner.database_url,operation.context,
            upload=operation.indexed_upload,command=base,intake_capacity=owner.intake_capacity,
            cancel_event=operation.job_cancel,constraints=operation.constraints)
        _publish(owner,operation,phase='preflight_ready',status=status,proposed=proposed)
        if operation.job_cancel.is_set():
            return _cancel(owner,operation)
        if (proposed.status!='complete_preflight' or proposed.start_offset!=status.confirmed_through
                or proposed.checked_rows+status.confirmed_through!=command.total_rows
                or proposed.remaining_rows!=0):
            raise SourceUnavailable()
        if (not gate._hex(request.review_sha256) or not hmac.compare_digest(request.review_sha256,
                review.review_intent_sha256(command,request.inventory_sha256,request.resume,
                                           proposed.proposal_sha256))):
            return _publish(owner,operation,phase='needs_review',status=status,error='stale_import')
        # Keep only bounded semantic leaves, never original prepared envelopes.
        leaves=proposed.window_seals
        leaf_index=0
        if not 1<=len(leaves)<=4000:
            raise SourceUnavailable()
        expected_revision,expected_generation=base.expected_revision,base.generation
        while status.confirmed_through<command.total_rows:
            if operation.job_cancel.is_set():
                return _cancel(owner,operation)
            if not owner.retry_permitted(operation):
                if operation.job_cancel.is_set():
                    return _cancel(owner,operation)
                return _publish(owner,operation,phase='paused',status=status)
            batch=jobs.claim_next_foobar_job_batch(owner.database_url,operation.context,
                source_ref=command.source_ref,job_ref=command.job_ref,
                inventory_sha256=request.inventory_sha256,expected_revision=expected_revision,
                expected_generation=expected_generation,constraints=operation.constraints)
            if (type(batch) is not jobs.FoobarJobBatch
                    or batch.original_session_id!=operation.context.actor.session_id
                    or batch.prepare_command.offset!=status.confirmed_through
                    or batch.prepare_command.expected_revision!=expected_revision
                    or batch.prepare_command.generation!=expected_generation):
                raise SourceStale()
            _publish(owner,operation,phase='preparing',status=status)
            receipt,outcome=_phase(owner,operation,service._Kind.PREPARE,batch.prepare_command)
            result=_reconcile(owner,operation,batch)
            status=result.status
            _publish(owner,operation,phase='reconciled_prepare',status=status,
                uncertain=result.disposition=='unresolved')
            if result.disposition=='confirmed':
                expected_revision=_committed_revision(result,batch)
            else:
                if operation.job_cancel.is_set():
                    return _cancel(owner,operation)
                if outcome in (service._Outcome.INVALID,service._Outcome.STALE,service._Outcome.SOURCE_CAPACITY):
                    return _publish(owner,operation,phase='needs_preflight',status=status,error=outcome.value)
                if result.disposition!='ready' or result.batch.apply_command is None:
                    return _publish(owner,operation,phase='needs_reconciliation',status=status,uncertain=True)
                if (leaf_index>=len(leaves) or type(receipt) is not service.prepare.FoobarPreparedReceipt
                        or (receipt.window_start-1,receipt.window_end-1)!=leaves[leaf_index][:2]
                        or receipt.proposal_sha256 is None
                        or not hmac.compare_digest(receipt.proposal_sha256,leaves[leaf_index][2])):
                    return _publish(owner,operation,phase='needs_review',status=status,error='stale_import')
                _publish(owner,operation,phase='applying',status=status)
                applied,apply_outcome=_phase(owner,operation,service._Kind.APPLY,result.batch.apply_command)
                result=_reconcile(owner,operation,result.batch)
                status=result.status
                if result.disposition!='confirmed':
                    if operation.job_cancel.is_set():
                        return _cancel(owner,operation)
                    return _publish(owner,operation,phase='needs_reconciliation',status=status,
                        uncertain=apply_outcome in (service._Outcome.UNAVAILABLE,service._Outcome.COMMIT_UNCERTAIN),
                        error=apply_outcome.value)
                expected_revision=_committed_revision(result,batch)
            leaf_index+=1
            _publish(owner,operation,phase='batch_confirmed',status=status)
            if status.source_revision!=expected_revision:
                return _publish(owner,operation,phase='needs_preflight',status=status,error='stale_import')
        # Only the actual durable contiguous checkpoint establishes completion.
        if status.disposition!='completed':
            raise jobs.FoobarJobUnresolved()
        return _publish(owner,operation,phase='completed',status=status)
    except FoobarSourceCapacityExceeded:
        return _publish(owner,operation,phase='needs_preflight',uncertain=False,
                        error='foobar_source_quota_exceeded')
    except (gate.PrepareInvalid,FoobarPreparationRejected):
        return _publish(owner,operation,phase='invalid_source',error='invalid_import_request')
    except SourceStale:
        if operation.job_cancel.is_set() and operation.job_progress.status is not None:
            try:
                return _cancel(owner,operation)
            except Exception:
                return _publish(owner,operation,phase='needs_reconciliation',uncertain=True,error='unavailable')
        return _publish(owner,operation,phase='needs_preflight',error='stale_import')
    except Exception:
        return _publish(owner,operation,phase='needs_reconciliation',uncertain=True,error='unavailable')
    finally:
        if raw_index is not None:
            raw_index.close()
