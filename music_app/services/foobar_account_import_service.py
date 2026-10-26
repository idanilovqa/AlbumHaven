"""One process-local account-import worker behind server-owned deployment gating.

No queue, replacement keys, mutable enable flag, or new connection pool.
One bounded same-identity retry requires durable original-key reconciliation. The
existing synchronous transaction owners settle before the worker releases its
slot. Structural readiness is necessary, not authorization to deploy this file.
Logical byte limits are conservative data-owner admission, not a total heap or
native-resource accounting claim. Multiple processes each have one worker.
"""
from __future__ import annotations
from dataclasses import dataclass, replace
from enum import Enum
import os
import threading
import time

from . import foobar_account_apply_command as apply_command
from . import foobar_account_import_prepare as prepare
from . import foobar_account_indexed_upload as indexed
from . import foobar_account_import_jobs as jobs
from . import foobar_account_job_discovery as discovery
from . import foobar_account_history_postgres as history
from . import foobar_account_history_native as history_native
from . import foobar_account_track_evidence as track_evidence
from . import foobar_account_import_maintenance as maintenance
from . import foobar_account_temporary_source as temporary_source
from . import foobar_enhanced_upload as enhanced_upload
from . import foobar_account_enhanced_review as enhanced_review
from . import foobar_enhanced_raw_windows as enhanced_windows
from . import foobar_account_enhanced_prepare as enhanced_prepare
from . import foobar_account_enhanced_history as enhanced_history
from .foobar_account_history_readiness import HISTORY_SCHEMA_PHASE_BYTES, require_foobar_history_schema
from .foobar_account_authority import require_account_foobar_read
from . import foobar_account_job_worker as job_worker
from . import foobar_account_import_review as review
from . import foobar_account_personal_changes as personal_changes
from .foobar_account_import_jobs_readiness import require_foobar_job_schema, JOB_SCHEMA_PHASE_BYTES
from .foobar_account_job_discovery_readiness import JOB_DISCOVERY_SCHEMA_PHASE_BYTES
from . import foobar_account_import_apply as apply
from . import foobar_account_prepare_gate as prepare_command
from . import foobar_account_import_status as status
from . import foobar_account_match_decisions as match_decisions
from . import foobar_default_source as source_selection
from .foobar_account_import_readiness import require_account_import_schema
from .foobar_account_retry_reconciliation import (
    reconcile_foobar_attempt, FoobarAttemptReconciliation, RetryDisposition,
)
from .foobar_import_intake import _IntakeBuffer, intake_byte_charges
from .foobar_import_preparation import FoobarIntakeCapacity, FoobarPreparationRejected
from .foobar_snapshot_parser import MAX_INPUT_BYTES
from .foobar_source_postgres import SourceStale, SourceUnavailable
from .foobar_account_source_postgres import FoobarSourceCapacityExceeded
from .policy import PolicyContext
from .policy_evaluator import PolicyEvaluationConstraints

_MAX_INTEGER = 9_223_372_036_854_775_807
_CANONICAL_MODULE = "music_app.services.foobar_account_import_service"
_INTAKE_KEY = "ALBUM_HAVEN_FOOBAR_IMPORT_INTAKE_BYTES"
_TOTAL_KEY = "ALBUM_HAVEN_FOOBAR_IMPORT_TOTAL_LOGICAL_BYTES"
MAX_UPLOAD_BYTES = MAX_INPUT_BYTES

def _positive_configuration_integer(value: object) -> int:
    if type(value) is int:
        number = value
    elif (type(value) is str and 1 <= len(value) <= 19
          and "1" <= value[0] <= "9"
          and all("0" <= item <= "9" for item in value)):
        number = int(value)
    else:
        raise SourceUnavailable()
    if not 1 <= number <= _MAX_INTEGER:
        raise SourceUnavailable()
    return number


@dataclass(frozen=True, slots=True)
class FoobarImportLimits:
    intake_bytes: int
    total_logical_bytes: int

    def __post_init__(self) -> None:
        if (type(self.intake_bytes) is not int
                or type(self.total_logical_bytes) is not int
                or not 1 <= self.intake_bytes <= _MAX_INTEGER
                or not 1 <= self.total_logical_bytes <= _MAX_INTEGER):
            raise SourceUnavailable()


def parse_foobar_import_limits(configuration: dict) -> FoobarImportLimits:
    """Read only the two mandatory server values. No default or env read."""
    if type(configuration) is not dict:
        raise SourceUnavailable()
    return FoobarImportLimits(
        _positive_configuration_integer(configuration.get(_INTAKE_KEY)),
        _positive_configuration_integer(configuration.get(_TOTAL_KEY)),
    )


@dataclass(frozen=True, slots=True)
class FoobarKnownDataCharge:
    """A lower bound, NOT admission of unresolved native/control graphs."""

    inherited_intake: int
    inherited_private: int
    intake_transport: int

    @property
    def total(self) -> int:
        return self.inherited_intake + self.inherited_private + self.intake_transport


def known_prepare_data_charge(limits: FoobarImportLimits, length: int) -> FoobarKnownDataCharge:
    if type(limits) is not FoobarImportLimits:
        raise SourceUnavailable()
    return FoobarKnownDataCharge(
        limits.intake_bytes, prepare.MAX_PRIVATE_BYTES,
        intake_byte_charges(length).maximum,
    )


class _State(Enum):
    DORMANT = "dormant"
    STARTING = "starting"
    OPEN = "open"
    DRAINING = "draining"
    QUIESCENT = "quiescent"
    FAULTED = "faulted"


class _Stage(Enum):
    INTAKE = "intake"
    DISPATCH = "dispatch"
    RUNNING = "running"
    DELIVERY = "delivery"


class _Kind(Enum):
    ENHANCED_REVIEW = "enhanced-review"
    PREPARE = "prepare"
    APPLY = "apply"
    SELECT_SOURCE = "source"
    STATUS = "status"
    MATCH_PREVIEW = "match-preview"
    MATCH_APPLY = "match-apply"
    JOB = "job-start"
    JOB_STATUS = "job-status"
    JOB_CANCEL = "job-cancel"
    JOB_LIST = "job-list"
    HISTORY = "history"
    ENHANCED_HISTORY = "enhanced-history"
    HISTORY_SOURCES = "history-sources"
    HISTORY_ELIGIBILITY = "history-eligibility"
    HISTORY_PLAY = "history-play"
    TRACK_EVIDENCE = "track-evidence"
    MAINTENANCE = "maintenance"
    REVIEW = "review"
    PERSONAL_CHANGE = "personal-changes"
    TEMPORARY_STATUS = "temporary-status"


class _Outcome(Enum):
    SUCCESS = "success"
    INVALID = "invalid_import_request"
    STALE = "stale_import"
    UNAVAILABLE = "unavailable"
    COMMIT_UNCERTAIN = "commit_uncertain"
    SOURCE_CHOICE_REQUIRED = "source_choice_required"
    SOURCE_CAPACITY = "foobar_source_quota_exceeded"


def _enhanced_operation(kind,command):
    if kind is _Kind.ENHANCED_REVIEW:
        return True
    if kind is _Kind.JOB:
        return (type(command) is job_worker.FoobarJobRequest
            and command.command.mapping_name==prepare_command.ENHANCED_MAPPING)
    return (kind is _Kind.REVIEW and type(command) is review.FoobarReviewRequest
        and command.mapping_name==prepare_command.ENHANCED_MAPPING)


@dataclass(frozen=True, slots=True, repr=False)
class _SourceRequest:
    source_ref: str | None


@dataclass(frozen=True, slots=True, repr=False)
class _StatusRequest:
    source_ref: str
    generation: int
    receipt_ref: str


@dataclass(frozen=True, slots=True, repr=False)
class _JobControl:
    source_ref: str
    job_ref: str


@dataclass(frozen=True, slots=True, repr=False)
class _JobListRequest:
    unfinished: bool
    cursor: object | None


@dataclass(frozen=True, slots=True, repr=False)
class _BusyJobDiscovery:
    unfinished: bool
    command: jobs.FoobarJobCommand | None
    confirmed_rows: int | None
    cancel_requested: bool | None


@dataclass(frozen=True, slots=True, repr=False)
class _PersonalRequest:
    source_ref: str
    job_ref: str
    review_sha256: str
    choices: tuple


@dataclass(frozen=True, slots=True, repr=False)
class _Ticket:
    handle: FoobarImportHandle
    identity: int


@dataclass(frozen=True, slots=True, repr=False)
class _Delivery:
    kind: _Kind
    command: object
    outcome: _Outcome
    receipt: object | None


@dataclass(slots=True, repr=False)
class _Operation:
    ticket: _Ticket
    kind: _Kind
    command: object
    context: PolicyContext | None
    constraints: object
    intake: _IntakeBuffer | None
    stage: _Stage
    abandoned: bool = False
    delivery: _Delivery | None = None
    cleanup_failed: bool = False
    indexed_upload: object | None = None
    job_request: object | None = None
    job_progress: object | None = None
    job_cancel: object | None = None
    job_cancel_context: object | None = None
    review_request: object | None = None
    review_progress: object | None = None
    continuation_review: object | None = None
    personal_review: object | None = None
    enhanced_channel: object | None = None
    retain_source: bool = False
    retained_identity: object | None = None
    retained_loaded: bool = False
    retention_attempted: bool = False


def _retain_raw_source(owner,operation,*,payload=None,artifact=None):
    if (not owner.retain_raw_enabled or not operation.retain_source
            or operation.retained_identity is not None or operation.retention_attempted):
        return
    operation.retention_attempted=True
    command=(operation.command.command if operation.kind is _Kind.JOB else operation.command)
    def chunks():
        if artifact is not None:
            with artifact.path.open('rb') as stream:
                while chunk:=stream.read(temporary_source.CHUNK_BYTES):
                    yield chunk
        else:
            for offset in range(0,len(payload),temporary_source.CHUNK_BYTES):
                yield payload[offset:offset+temporary_source.CHUNK_BYTES]
    from hashlib import sha256
    identity=temporary_source.TemporarySourceIdentity(command.source_ref,command.job_ref,
        command.mapping_name,artifact.sha256 if artifact is not None else sha256(payload).hexdigest(),
        artifact.byte_length if artifact is not None else len(payload))
    try:
        temporary_source.save_temporary_source(owner.database_url,operation.context,identity=identity,
            chunks=chunks(),constraints=operation.constraints,cancelled=operation.job_cancel.is_set)
    except Exception:
        # Optional retention failure never retries or blocks the existing import.
        # Status later reports actual durable availability, not presumed save.
        pass


def _call_once(owner,operation):
    """One genuine chain invocation; every native context exits before return."""
    if operation.retained_identity is not None and not operation.retained_loaded:
        with temporary_source.materialize_temporary_source(owner.database_url, operation.context,
                identity=operation.retained_identity, constraints=operation.constraints,
                cancelled=operation.job_cancel.is_set) as artifact:
            operation.retained_loaded=True
            try:
                if _enhanced_operation(operation.kind,operation.command):
                    with enhanced_windows.open_enhanced_raw_index(artifact,
                            logical_capacity_bytes=owner.intake_capacity.logical_bytes-review.REVIEW_HOLD_BYTES,
                            cancelled=operation.job_cancel.is_set) as upload:
                        operation.indexed_upload=upload
                        try:
                            return _call_once(owner,operation)
                        finally:
                            operation.indexed_upload=None
                with artifact.path.open('rb') as stream:
                    while chunk:=stream.read(temporary_source.CHUNK_BYTES):
                        operation.intake.append(chunk)
                operation.intake.finish()
                return _call_once(owner,operation)
            finally:
                operation.retained_loaded=False
    if (operation.kind in (_Kind.JOB,_Kind.REVIEW) and operation.intake is not None
            and operation.intake._payload is not None):
        _retain_raw_source(owner,operation,payload=operation.intake._payload)
    phase_capacity=(FoobarIntakeCapacity(owner.intake_capacity.logical_bytes-review.REVIEW_HOLD_BYTES)
                    if operation.job_request is not None else owner.intake_capacity)
    if (operation.kind in (_Kind.JOB,_Kind.REVIEW)
            and operation.enhanced_channel is not None and operation.indexed_upload is None):
        # A new explicit upload is required for every review/start/resume.
        # Only this settled worker owns the temporary artifact and index.
        # Neither is persisted with durable imported evidence/checkpoints.
        with enhanced_upload.staged_enhanced_upload(operation.enhanced_channel) as artifact:
            _retain_raw_source(owner,operation,artifact=artifact)
            with enhanced_windows.open_enhanced_raw_index(artifact,
                    logical_capacity_bytes=phase_capacity.logical_bytes,
                    cancelled=operation.job_cancel.is_set) as upload:
                operation.indexed_upload=upload
                try:
                    receipt=_call_once(owner,operation)
                finally:
                    operation.indexed_upload=None
        return receipt
    if operation.kind is _Kind.ENHANCED_REVIEW:
        enhanced_review.validate_enhanced_review_context(owner.database_url,
            operation.context,operation.command,constraints=operation.constraints)
        with enhanced_upload.staged_enhanced_upload(operation.enhanced_channel) as artifact:
            receipt=enhanced_review.review_enhanced_artifact(owner.database_url,
                operation.context,operation.command,path=artifact.path,
                upload_sha256=artifact.sha256,logical_capacity_bytes=owner.intake_capacity.logical_bytes,
                cancelled=operation.job_cancel.is_set,constraints=operation.constraints)
            if type(receipt) is not enhanced_review.EnhancedReviewResult:
                raise SourceUnavailable()
    elif operation.kind is _Kind.PERSONAL_CHANGE:
        receipt=personal_changes.apply_foobar_personal_changes(owner.database_url,operation.context,
            review_progress=operation.personal_review,choices=operation.command.choices,
            intake_capacity=FoobarIntakeCapacity(owner.intake_capacity.logical_bytes
                -review.REVIEW_HOLD_BYTES-review.DETAIL_HOLD_BYTES),
            constraints=operation.constraints)
        if type(receipt) is not personal_changes.FoobarPersonalChangesResult:
            raise SourceUnavailable()
    elif operation.kind is _Kind.REVIEW:
        receipt=review.run_foobar_review(owner,operation)
        if type(receipt) is not review.FoobarReviewProgress:
            raise SourceUnavailable()
    elif operation.kind is _Kind.JOB:
        receipt=job_worker.run_foobar_job(owner,operation)
        if type(receipt) is not job_worker.FoobarJobProgress:
            raise SourceUnavailable()
        if owner.retain_raw_enabled and receipt.phase=='completed' and not receipt.uncertain:
            try:
                temporary_source.remove_completed_temporary_source(owner.database_url,operation.context,
                    source_ref=receipt.command.source_ref,job_ref=receipt.command.job_ref,
                    constraints=operation.constraints)
            except Exception:
                pass  # Expiry remains fixed; cleanup retries through janitor only.
    elif operation.kind is _Kind.TEMPORARY_STATUS:
        receipt=temporary_source.temporary_source_status(owner.database_url,operation.context,
            source_ref=operation.command.source_ref,job_ref=operation.command.job_ref,
            constraints=operation.constraints)
    elif operation.kind is _Kind.MAINTENANCE:
        receipt=maintenance.maintain_foobar_source(owner.database_url,operation.context,
            request=operation.command,constraints=operation.constraints)
        if type(receipt) is not maintenance.MaintenanceResult:
            raise SourceUnavailable()
    elif operation.kind is _Kind.TRACK_EVIDENCE:
        receipt=track_evidence.read_track_evidence(owner.database_url,operation.context,
            operation.command,constraints=operation.constraints)
        if type(receipt) is not track_evidence.TrackEvidencePage:
            raise SourceUnavailable()
    elif operation.kind in (_Kind.HISTORY_ELIGIBILITY,_Kind.HISTORY_PLAY):
        action=(history_native.resolve_foobar_history_play if operation.kind is _Kind.HISTORY_PLAY
                else history_native.read_foobar_history_eligibility)
        receipt=action(owner.database_url,operation.context,operation.command,
            config=owner.native_configuration,constraints=operation.constraints)
        if operation.kind is _Kind.HISTORY_PLAY:
            if type(receipt) is not history_native.FoobarHistoryPrivatePlayTarget:
                raise SourceUnavailable()
        elif (type(receipt) is not tuple or len(receipt)!=len(operation.command.observations)
                or any(type(item) is not history_native.FoobarHistoryEligibility
                       or item.observation_ref!=requested.observation_ref
                       or type(item.can_attempt_play) is not bool
                       for item,requested in zip(receipt,operation.command.observations))):
            raise SourceUnavailable()
    elif operation.kind is _Kind.ENHANCED_HISTORY:
        receipt=enhanced_history.read_enhanced_history(owner.database_url,operation.context,
            operation.command,constraints=operation.constraints)
        if type(receipt) is not enhanced_history.EnhancedHistoryPage:
            raise SourceUnavailable()
    elif operation.kind is _Kind.HISTORY:
        receipt=history.read_foobar_history(owner.database_url,operation.context,
            operation.command,constraints=operation.constraints)
        if type(receipt) is not history.FoobarHistoryPage:
            raise SourceUnavailable()
    elif operation.kind is _Kind.HISTORY_SOURCES:
        receipt=history.list_foobar_history_sources(owner.database_url,operation.context,
            cursor=operation.command,constraints=operation.constraints)
        if type(receipt) is not history.FoobarHistorySourcePage:
            raise SourceUnavailable()
    elif operation.kind is _Kind.JOB_LIST:
        receipt=discovery.list_foobar_import_jobs(owner.database_url,operation.context,
            unfinished=operation.command.unfinished,cursor=operation.command.cursor,
            constraints=operation.constraints)
        if type(receipt) is not discovery.FoobarJobListPage:
            raise SourceUnavailable()
    elif operation.kind in (_Kind.JOB_STATUS,_Kind.JOB_CANCEL):
        action=(jobs.read_foobar_import_job if operation.kind is _Kind.JOB_STATUS
                else jobs.cancel_foobar_import_job)
        receipt=action(owner.database_url,operation.context,
            source_ref=operation.command.source_ref,job_ref=operation.command.job_ref,
            constraints=operation.constraints)
        if type(receipt) is not jobs.FoobarJobStatus:
            raise SourceUnavailable()
    elif operation.kind is _Kind.PREPARE:
        if operation.indexed_upload is None:
            if operation.command.mapping_name==prepare_command.ENHANCED_MAPPING:
                raise SourceUnavailable()
            operation.indexed_upload = indexed.open_account_indexed_upload(operation.context,
                payload=operation.intake._payload,command=operation.command,
                intake_capacity=phase_capacity)
        prepare_action=(enhanced_prepare.prepare_indexed_enhanced_import
            if operation.command.mapping_name==prepare_command.ENHANCED_MAPPING
            else prepare.prepare_indexed_foobar_import)
        receipt = prepare_action(owner.database_url,operation.context,
            upload=operation.indexed_upload,command=operation.command,
            intake_capacity=phase_capacity,constraints=operation.constraints)
        if type(receipt) is not prepare.FoobarPreparedReceipt:
            raise SourceUnavailable()
    elif operation.kind is _Kind.APPLY:
        receipt = apply.apply_foobar_import(owner.database_url,operation.context,
            command=operation.command,intake_capacity=phase_capacity,
            constraints=operation.constraints)
        if type(receipt) is not apply.FoobarAppliedReceipt:
            raise SourceUnavailable()
    elif operation.kind is _Kind.SELECT_SOURCE:
        receipt = source_selection.select_account_foobar_source(
            owner.database_url,operation.context,source_ref=operation.command.source_ref,
            constraints=operation.constraints)
        if type(receipt) is not source_selection.AccountFoobarSourceSelection:
            raise SourceUnavailable()
    elif operation.kind is _Kind.STATUS:
        receipt = status.read_foobar_import_status(owner.database_url,operation.context,
            source_ref=operation.command.source_ref,generation=operation.command.generation,
            receipt_ref=operation.command.receipt_ref,constraints=operation.constraints)
        if type(receipt) is not status.FoobarReceiptStatus:
            raise SourceUnavailable()
    elif operation.kind is _Kind.MATCH_PREVIEW:
        receipt=match_decisions.preview_foobar_match_decision(owner.database_url,operation.context,
            command=operation.command,constraints=operation.constraints)
        if type(receipt) is not match_decisions.FoobarMatchPreview:
            raise SourceUnavailable()
    elif operation.kind is _Kind.MATCH_APPLY:
        receipt=match_decisions.apply_foobar_match_decision(owner.database_url,operation.context,
            command=operation.command,constraints=operation.constraints)
        if type(receipt) is not match_decisions.FoobarMatchDecision:
            raise SourceUnavailable()
    else:
        raise SourceUnavailable()
    return receipt


def _attempt(owner,operation):
    # Every caught exception/traceback dies with this subordinate frame before
    # reconciliation or another invocation can allocate native/data owners.
    try:
        return _call_once(owner,operation),_Outcome.SUCCESS
    except FoobarSourceCapacityExceeded:
        return None,_Outcome.SOURCE_CAPACITY
    except enhanced_upload.EnhancedUploadStorageFailed:
        operation.cleanup_failed = True
        return None,_Outcome.UNAVAILABLE
    except (apply.FoobarApplyCommitUncertain,match_decisions.MatchDecisionCommitUncertain,
            personal_changes.FoobarPersonalChangesCommitUncertain):
        return None,_Outcome.COMMIT_UNCERTAIN
    except source_selection.FoobarSourceChoiceRequired:
        return None,_Outcome.SOURCE_CHOICE_REQUIRED
    except (prepare_command.PrepareInvalid,apply_command.ApplyInvalid,FoobarPreparationRejected):
        return None,_Outcome.INVALID
    except SourceStale:
        return None,_Outcome.STALE
    except BaseException:
        return None,_Outcome.UNAVAILABLE


def _reconciled(owner,operation):
    try:
        if operation.kind is _Kind.MATCH_APPLY:
            # Genuine locked operation lookup, not an inferred rollback. Fresh
            # preview may refresh an outdated expected pair; automatic retry
            # must NEVER adopt that changed command. Historical exact replay
            # requires no live library and preserves the newer binding.
            preview=match_decisions.preview_foobar_match_decision(
                owner.database_url,operation.context,command=operation.command,
                constraints=operation.constraints)
            return (type(preview) is match_decisions.FoobarMatchPreview
                    and type(preview.command) is match_decisions.FoobarMatchDecisionCommand
                    and preview.command==operation.command)
        result=reconcile_foobar_attempt(owner.database_url,operation.context,
            operation=operation.kind.value,command=operation.command,
            constraints=operation.constraints)
        return (type(result) is FoobarAttemptReconciliation and
            result.disposition in (RetryDisposition.RETRY_SAME_IDENTITY,
                                   RetryDisposition.REPLAY_SAME_IDENTITY))
    except BaseException:
        return False


def _call_bounded(owner,operation):
    receipt,outcome=_attempt(owner,operation)
    if (outcome not in (_Outcome.UNAVAILABLE,_Outcome.COMMIT_UNCERTAIN)
            or operation.kind not in (_Kind.PREPARE,_Kind.APPLY,_Kind.MATCH_APPLY)
            or not owner.retry_permitted(operation)):
        return receipt,outcome
    # Unavailable never means proven rollback. Inspect durable original-key
    # state only after the first invocation AND its exception frame settled.
    if not owner.wait_retry(operation) or not _reconciled(owner,operation) or not owner.retry_permitted(operation):
        return receipt,outcome
    # Exactly one additional native invocation. Same upload owner and original
    # account/session, constraints, command and key; native authority is fresh.
    second_receipt,second_outcome=_attempt(owner,operation)
    if outcome is _Outcome.COMMIT_UNCERTAIN and second_outcome is not _Outcome.SUCCESS:
        return None,_Outcome.COMMIT_UNCERTAIN
    return second_receipt,second_outcome


def _invoke(owner):
    """Return completely before the persistent loop publishes settlement."""
    operation = owner.current
    receipt = None
    outcome = _Outcome.UNAVAILABLE
    try:
        try:
            require_account_import_schema(owner.database_url)
            require_foobar_job_schema(owner.database_url)
            require_foobar_history_schema(owner.database_url)
            receipt,outcome = _call_bounded(owner,operation)
        except FoobarSourceCapacityExceeded:
            outcome = _Outcome.SOURCE_CAPACITY
        except enhanced_upload.EnhancedUploadStorageFailed:
            operation.cleanup_failed = True
            outcome = _Outcome.UNAVAILABLE
        except (apply.FoobarApplyCommitUncertain,match_decisions.MatchDecisionCommitUncertain,
                personal_changes.FoobarPersonalChangesCommitUncertain):
            outcome = _Outcome.COMMIT_UNCERTAIN
        except source_selection.FoobarSourceChoiceRequired:
            outcome = _Outcome.SOURCE_CHOICE_REQUIRED
        except (prepare_command.PrepareInvalid,apply_command.ApplyInvalid,FoobarPreparationRejected):
            outcome = _Outcome.INVALID
        except SourceStale:
            outcome = _Outcome.STALE
        except BaseException:
            # Unknown Prepare acknowledgement remains unavailable: retry only
            # the identical original command, never invent a replacement key.
            outcome = _Outcome.UNAVAILABLE
        operation.delivery = _Delivery(operation.kind,operation.command,outcome,
            receipt if outcome is _Outcome.SUCCESS else None)
        operation.command = None
    except BaseException:
        operation.cleanup_failed = True
    finally:
        try:
            if operation.enhanced_channel is not None:
                operation.enhanced_channel.close()
            operation.enhanced_channel = None
            if operation.indexed_upload is not None:
                operation.indexed_upload.close()
            operation.indexed_upload = None
            if operation.intake is not None:
                operation.intake.discard()
            operation.intake = None
            operation.context = None
            operation.constraints = None
            operation.job_cancel_context = None
            operation.personal_review = None
            operation.continuation_review = None
        except BaseException:
            operation.cleanup_failed = True
        receipt = operation = None


class FoobarImportHandle:
    """Server-owned handle; opaque per-request tickets prevent stale release."""
    __slots__ = ('owner','closed')

    def __init__(self,owner):
        self.owner = owner
        self.closed = False

    @property
    def available(self):
        self.owner._identity()
        with self.owner.condition:
            return (not self.closed and self in self.owner.handles
                and self.owner.state is _State.OPEN and self.owner.current is None)

    def start(self,timeout=5.0):
        return self.owner.start(self,timeout)

    def begin_enhanced_review(self,*,context,constraints,command,length):
        if type(command) is not enhanced_review.EnhancedReviewCommand:
            raise SourceUnavailable()
        return self.owner.begin(self,_Kind.ENHANCED_REVIEW,context,constraints,command,length)

    def offer_enhanced_upload(self,ticket,chunk):
        return self.owner.enhanced_intake_action(self,ticket,chunk=chunk)

    def finish_enhanced_upload(self,ticket):
        return self.owner.enhanced_intake_action(self,ticket,finish=True)

    def begin_prepare(self,*,context,constraints,command,length):
        prepare_command.validate_prepare_command(command)
        if command.mapping_name==prepare_command.ENHANCED_MAPPING:
            # Enhanced commands enter only via the full finalized-artifact
            # review/job upload owner, never a TSV byte-buffer reinterpretation.
            raise prepare_command.PrepareInvalid()
        charge=known_prepare_data_charge(self.owner.limits,length)
        if (charge.total>self.owner.limits.total_logical_bytes
                or prepare.window.indexed_upload_intake_bytes(length)
                    +7*length+prepare.window.PARSER_WORK_BYTES+prepare.window.WINDOW_WORK_BYTES
                    >self.owner.limits.intake_bytes):
            raise SourceUnavailable()
        return self.owner.begin(self,_Kind.PREPARE,context,constraints,command,length)

    def append_prepare(self,ticket,chunk):
        self.owner.intake_action(self,ticket,chunk=chunk)

    def finish_prepare(self,ticket):
        self.owner.intake_action(self,ticket,finish=True)

    def begin_job(self,*,context,constraints,command,inventory_sha256,review_sha256,length,resume=False,retain_source=False,retained_identity=None):
        jobs._command(command)
        if (not prepare_command._hex(inventory_sha256) or not prepare_command._hex(review_sha256)
                or type(resume) is not bool):
            raise prepare_command.PrepareInvalid()
        if command.mapping_name==prepare_command.ENHANCED_MAPPING:
            if (command.original_matching_library_id is None
                    and inventory_sha256!=prepare.NO_LIBRARY_INVENTORY_SHA256):
                raise prepare_command.PrepareInvalid()
            request=job_worker.FoobarJobRequest(command,inventory_sha256,resume,review_sha256)
            return self.owner.begin(self,_Kind.JOB,context,constraints,request,length,retain_source=retain_source,retained_identity=retained_identity)
        charge=known_prepare_data_charge(self.owner.limits,length)
        if (charge.total+2*jobs.JOB_PHASE_BYTES+review.REVIEW_HOLD_BYTES>self.owner.limits.total_logical_bytes
                or prepare.window.indexed_upload_intake_bytes(length)+review.REVIEW_HOLD_BYTES+8192
                    +7*length+prepare.window.PARSER_WORK_BYTES+prepare.window.WINDOW_WORK_BYTES
                    >self.owner.limits.intake_bytes):
            raise SourceUnavailable()
        request=job_worker.FoobarJobRequest(command,inventory_sha256,resume,review_sha256)
        return self.owner.begin(self,_Kind.JOB,context,constraints,request,length,retain_source=retain_source,retained_identity=retained_identity)

    def begin_review(self,*,context,constraints,request,length,retain_source=False,retained_identity=None):
        review.validate_review_request(request)
        if request.mapping_name==prepare_command.ENHANCED_MAPPING:
            return self.owner.begin(self,_Kind.REVIEW,context,constraints,request,length,retain_source=retain_source,retained_identity=retained_identity)
        charge=known_prepare_data_charge(self.owner.limits,length)
        if (charge.total+2*jobs.JOB_PHASE_BYTES+review.REVIEW_HOLD_BYTES
                    +prepare.CONFLICT_REVIEW_BYTES+prepare.PROBLEM_CONTROL_BYTES+review.DETAIL_HOLD_BYTES>self.owner.limits.total_logical_bytes
                or prepare.window.indexed_upload_intake_bytes(length)+review.REVIEW_HOLD_BYTES
                    +prepare.CONFLICT_REVIEW_BYTES+prepare.PROBLEM_CONTROL_BYTES+7*length+prepare.window.PARSER_WORK_BYTES+prepare.window.WINDOW_WORK_BYTES
                    >self.owner.limits.intake_bytes):
            raise SourceUnavailable()
        return self.owner.begin(self,_Kind.REVIEW,context,constraints,request,length,retain_source=retain_source,retained_identity=retained_identity)

    def begin_temporary_status(self,*,context,constraints,source_ref,job_ref):
        if not self.owner.retain_raw_enabled or not prepare_command._uuid(source_ref) or not prepare_command._uuid(job_ref):
            raise SourceUnavailable()
        return self.owner.begin(self,_Kind.TEMPORARY_STATUS,context,constraints,_JobControl(source_ref,job_ref))

    def begin_personal_changes(self,*,context,constraints,source_ref,job_ref,review_sha256,choices):
        if (not prepare_command._uuid(source_ref) or not prepare_command._uuid(job_ref)
                or not prepare_command._hex(review_sha256) or type(choices) is not tuple
                or not 1<=len(choices)<=32
                or any(type(item) is not tuple or len(item)!=2
                    or not prepare_command._integer(item[0],1,100000)
                    or item[1] not in ('rating','favorite') for item in choices)
                or len(set(choices))!=len(choices)):
            raise prepare_command.PrepareInvalid()
        return self.owner.begin(self,_Kind.PERSONAL_CHANGE,context,constraints,
            _PersonalRequest(source_ref,job_ref,review_sha256,choices))

    def current_review_progress(self,*,context,constraints,source_ref,job_ref,cancel=False):
        self.owner._identity()
        live=prepare.require_account_foobar(context,constraints)
        if (not prepare_command._uuid(source_ref) or not prepare_command._uuid(job_ref)
                or type(cancel) is not bool):
            raise prepare_command.PrepareInvalid()
        with self.owner.condition:
            self.owner._handle(self)
            active=self.owner.current
            value=(active.review_progress if active is not None and active.review_request is not None
                   else self.owner.last_review)
            if (type(value) is not review.FoobarReviewProgress
                    or (value.account_id,value.session_id)!=(live.actor.account_id,live.actor.session_id)
                    or (value.request.source_ref,value.request.job_ref)!=(source_ref,job_ref)):
                raise SourceStale()
            if cancel:
                value=replace(value,phase='cancelled_review',result=None,error=None)
                if active is not None and active.review_request is not None:
                    active.job_cancel.set()
                    active.review_progress=value
                else:
                    self.owner.last_review=value
                self.owner.condition.notify_all()
            return value

    def current_job_progress(self,*,context,constraints,source_ref,job_ref,cancel=False):
        return self.owner.job_progress(self,context,constraints,source_ref,job_ref,cancel=cancel)

    def busy_job_discovery(self,*,context,constraints,unfinished,cursor=None):
        """Bounded own-account snapshot, never a substitute for durable listing."""
        discovery.validate_discovery_request(unfinished=unfinished,cursor=cursor)
        self.owner._identity()
        live=prepare.require_account_foobar(context,constraints)
        with self.owner.condition:
            self.owner._handle(self)
            if self.owner.state is not _State.OPEN:
                raise SourceUnavailable()
            operation=self.owner.current
            if operation is None:
                return None
            # Reserve a small response while the largest existing operation may
            # still own parser, review and native phases. Never spawn a reader.
            if (self.owner.limits.intake_bytes+prepare.MAX_PRIVATE_BYTES
                    +prepare.CONFLICT_REVIEW_BYTES+prepare.PROBLEM_CONTROL_BYTES
                    +review.DETAIL_HOLD_BYTES+review.REVIEW_HOLD_BYTES
                    +2*jobs.JOB_PHASE_BYTES+2*discovery.DISCOVERY_PHASE_BYTES
                    >self.owner.limits.total_logical_bytes):
                raise SourceUnavailable()
            progress=operation.job_progress
            if (type(progress) is not job_worker.FoobarJobProgress
                    or progress.account_id!=live.actor.account_id):
                return _BusyJobDiscovery(unfinished,None,None,None)
            known=progress.status
            confirmed=None if known is None else known.confirmed_through
            paused=None if known is None else known.cancel_requested
            if unfinished and confirmed==progress.command.total_rows:
                return _BusyJobDiscovery(unfinished,None,None,None)
            # Copy only immutable scalar command/progress, never the retained
            # preflight leaves, upload or authority context.
            return _BusyJobDiscovery(unfinished,progress.command,confirmed,paused)

    def begin_job_discovery(self,*,context,constraints,unfinished,cursor=None):
        discovery.validate_discovery_request(unfinished=unfinished,cursor=cursor)
        return self.owner.begin(self,_Kind.JOB_LIST,context,constraints,_JobListRequest(unfinished,cursor))

    def begin_history(self,*,context,constraints,request):
        history.validate_foobar_history_request(request)
        return self.owner.begin(self,_Kind.HISTORY,context,constraints,request)

    def begin_enhanced_history(self,*,context,constraints,request):
        enhanced_history.validate_request(request)
        return self.owner.begin(self,_Kind.ENHANCED_HISTORY,context,constraints,request)

    def begin_history_sources(self,*,context,constraints,cursor=None):
        history.validate_foobar_history_source_cursor(cursor)
        return self.owner.begin(self,_Kind.HISTORY_SOURCES,context,constraints,cursor)

    def begin_maintenance(self,*,context,constraints,request):
        maintenance.validate_request(request)
        return self.owner.begin(self,_Kind.MAINTENANCE,context,constraints,request)

    def begin_track_evidence(self,*,context,constraints,request):
        track_evidence.validate_request(request)
        return self.owner.begin(self,_Kind.TRACK_EVIDENCE,context,constraints,request)

    def begin_history_native(self,*,context,constraints,request,play=False):
        if type(play) is not bool:
            raise SourceUnavailable()
        history_native.validate_foobar_history_native_request(request,play=play)
        return self.owner.begin(self,_Kind.HISTORY_PLAY if play else _Kind.HISTORY_ELIGIBILITY,
            context,constraints,request)

    def settled_job_diagnostic(self,*,context,constraints,source_ref,job_ref):
        self.owner._identity()
        live=prepare.require_account_foobar(context,constraints)
        with self.owner.condition:
            self.owner._handle(self)
            value=self.owner.last_job
            if (type(value) is job_worker.FoobarJobProgress
                    and value.account_id==live.actor.account_id
                    and (value.command.source_ref,value.command.job_ref)==(source_ref,job_ref)):
                return value
            return None

    def begin_job_control(self,*,context,constraints,source_ref,job_ref,cancel=False):
        if (not prepare_command._uuid(source_ref) or not prepare_command._uuid(job_ref)
                or type(cancel) is not bool):
            raise prepare_command.PrepareInvalid()
        return self.owner.begin(self,_Kind.JOB_CANCEL if cancel else _Kind.JOB_STATUS,
            context,constraints,_JobControl(source_ref,job_ref))

    def begin_apply(self,*,context,constraints,command):
        apply_command.validate_apply_command(command)
        return self.owner.begin(self,_Kind.APPLY,context,constraints,command)

    def begin_select_source(self,*,context,constraints,source_ref=None):
        if source_ref is not None and not prepare_command._uuid(source_ref):
            raise prepare_command.PrepareInvalid()
        return self.owner.begin(self,_Kind.SELECT_SOURCE,context,constraints,_SourceRequest(source_ref))

    def begin_status(self,*,context,constraints,source_ref,generation,receipt_ref):
        if (not prepare_command._uuid(source_ref) or not prepare_command._uuid(receipt_ref)
                or not prepare_command._integer(generation,1,2147483647)):
            raise prepare_command.PrepareInvalid()
        return self.owner.begin(self,_Kind.STATUS,context,constraints,
            _StatusRequest(source_ref,generation,receipt_ref))

    def begin_match_preview(self,*,context,constraints,command):
        match_decisions.validate_command(command)
        return self.owner.begin(self,_Kind.MATCH_PREVIEW,context,constraints,command)

    def begin_match_apply(self,*,context,constraints,command):
        match_decisions.validate_command(command)
        return self.owner.begin(self,_Kind.MATCH_APPLY,context,constraints,command)

    def take_delivery(self,ticket):
        return self.owner.take(self,ticket)

    def abandon(self,ticket):
        self.owner.abandon(self,ticket)

    def close(self):
        self.owner.detach(self)

    def join(self,timeout=5.0):
        return self.owner.join(self,timeout)


def _timeout(value):
    if type(value) not in (int,float) or not 0<=value<=30:
        raise SourceUnavailable()
    return float(value)


class _ProcessOwner:
    def __init__(self,limits,database_url,*,native_configuration=None):
        self.pid=os.getpid()
        self.epoch=_MODULE_EPOCH
        self.limits=limits
        self.database_url=database_url
        # Actual server-owned runtime config, never request data or a ready flag.
        # Existing non-native operations do not depend on this optional binding.
        self.native_configuration=native_configuration
        self.retain_raw_enabled=(type(native_configuration) is dict and native_configuration.get("ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED") is True)
        self.last_retention_sweep=0.0
        self.intake_capacity=FoobarIntakeCapacity(limits.intake_bytes)
        self.condition=threading.Condition(threading.Lock())
        self.state=_State.DORMANT
        self.handles=set()
        self.current=None
        self.last_job=None
        self.last_review=None
        self.thread=None
        self.start_attempted=False
        self.next_ticket=1
        self.exited=threading.Event()

    def _identity(self):
        # Never acquire an inherited lock after fork/reload.
        if (__name__!=_CANONICAL_MODULE or self.pid!=os.getpid()
                or self.epoch is not _MODULE_EPOCH):
            raise SourceUnavailable()

    def _handle(self,handle):
        if type(handle) is not FoobarImportHandle or handle.owner is not self or handle.closed or handle not in self.handles:
            raise SourceUnavailable()

    def attach(self):
        self._identity()
        with self.condition:
            if self.state not in (_State.DORMANT,_State.STARTING,_State.OPEN):
                raise SourceUnavailable()
            handle=FoobarImportHandle(self)
            self.handles.add(handle)
            return handle

    def start(self,handle,timeout):
        timeout=_timeout(timeout)
        self._identity()
        with self.condition:
            self._handle(handle)
            if not self.start_attempted:
                if self.state is not _State.DORMANT:
                    raise SourceUnavailable()
                self.start_attempted=True
                self.state=_State.STARTING
                try:
                    self.thread=threading.Thread(target=self._worker,name='foobar-account-import',daemon=False)
                    self.thread.start()
                except BaseException:
                    self.state=_State.FAULTED
                    self.condition.notify_all()
                    raise SourceUnavailable() from None
            deadline=time.monotonic()+timeout
            while self.state is _State.STARTING:
                remaining=deadline-time.monotonic()
                if remaining<=0:
                    return False
                self.condition.wait(remaining)
            return self.state is _State.OPEN

    def begin(self,handle,kind,context,constraints,command,length=None,*,retain_source=False,retained_identity=None):
        self._identity()
        if (type(context) is not PolicyContext
                or (type(constraints) is not PolicyEvaluationConstraints and not callable(constraints))):
            raise SourceUnavailable()
        # Preserve the authenticated server's narrowing resolver by reference.
        # Evaluate real account policy before intake, then the native chain
        # re-evaluates it against fresh account/session/local authority.
        if kind in (_Kind.HISTORY,_Kind.ENHANCED_HISTORY,_Kind.HISTORY_SOURCES,_Kind.TRACK_EVIDENCE,_Kind.HISTORY_ELIGIBILITY,_Kind.HISTORY_PLAY):
            require_account_foobar_read(context,constraints)
        else:
            prepare.require_account_foobar(context,constraints)
        if type(retain_source) is not bool:
            raise SourceUnavailable()
        if retained_identity is not None:
            temporary_source.validate_identity(retained_identity)
            actual=command.command if kind is _Kind.JOB else command
            if (not self.retain_raw_enabled or kind not in (_Kind.JOB,_Kind.REVIEW)
                    or retained_identity.source_ref!=actual.source_ref
                    or retained_identity.job_ref!=actual.job_ref
                    or retained_identity.mapping_name!=actual.mapping_name
                    or retained_identity.byte_length!=length
                    or kind is _Kind.JOB and retained_identity.upload_sha256!=actual.upload_sha256):
                raise SourceStale()
        enhanced_stream=_enhanced_operation(kind,command)
        with self.condition:
            self._handle(handle)
            if self.state is not _State.OPEN or self.current is not None or self.next_ticket>_MAX_INTEGER:
                raise SourceUnavailable()
            cached=None
            if kind is _Kind.PERSONAL_CHANGE:
                cached=review.checked_cached_review(self.last_review,context,command.source_ref,
                    command.job_ref,command.review_sha256)
            elif kind is _Kind.REVIEW and command.previous_review_sha256 is not None:
                cached=review.checked_cached_review(self.last_review,context,command.source_ref,
                    command.job_ref,command.previous_review_sha256)
                if command.observation_after is not None:
                    review.checked_observation_continuation(command,cached)
                else:
                    conflict_page=(command.conflict_after==cached.result.proposed.conflict_next
                        and command.problem_after==cached.request.problem_after)
                    problem_page=(command.problem_after==cached.result.proposed.problem_next
                        and command.conflict_after==cached.request.conflict_after)
                    if (cached.request.observation_after is not None
                            or not (conflict_page or problem_page)
                            or command.matching_library_id!=cached.request.matching_library_id
                            or command.resume!=cached.request.resume):
                        raise SourceStale()
            required_logical=(self.limits.intake_bytes+prepare.MAX_PRIVATE_BYTES+HISTORY_SCHEMA_PHASE_BYTES
                    +(prepare.CONFLICT_REVIEW_BYTES+prepare.PROBLEM_CONTROL_BYTES if kind in (_Kind.REVIEW,_Kind.PERSONAL_CHANGE) else 0)
                    +(review.DETAIL_HOLD_BYTES if kind in (_Kind.REVIEW,_Kind.PERSONAL_CHANGE)
                        or self.last_review is not None else 0)
                    +(2*jobs.JOB_PHASE_BYTES if kind in (_Kind.JOB,_Kind.JOB_STATUS,_Kind.JOB_CANCEL,_Kind.REVIEW) else 0)
                    +(2*discovery.DISCOVERY_PHASE_BYTES+JOB_SCHEMA_PHASE_BYTES
                      +JOB_DISCOVERY_SCHEMA_PHASE_BYTES if kind is _Kind.JOB_LIST else 0)
                    +(2*history.HISTORY_READ_PHASE_BYTES
                      if kind is _Kind.HISTORY else 0)
                    +(2*enhanced_history.READ_PHASE_BYTES
                      if kind is _Kind.ENHANCED_HISTORY else 0)
                    +(2*history.HISTORY_SOURCE_LIST_PHASE_BYTES
                      if kind is _Kind.HISTORY_SOURCES else 0)
                    +(2*maintenance.MAINTENANCE_PHASE_BYTES+JOB_SCHEMA_PHASE_BYTES
                      if kind is _Kind.MAINTENANCE else 0)
                    +(2*track_evidence.TRACK_EVIDENCE_PHASE_BYTES
                      if kind is _Kind.TRACK_EVIDENCE else 0)
                    +(history_native.HISTORY_NATIVE_PHASE_BYTES
                      if kind in (_Kind.HISTORY_ELIGIBILITY,_Kind.HISTORY_PLAY) else 0)
                    +(enhanced_upload.UPLOAD_LOGICAL_BYTES+enhanced_review.REVIEW_PHASE_BYTES
                      if enhanced_stream else 0)
                    +(review.REVIEW_HOLD_BYTES if kind in (_Kind.JOB,_Kind.REVIEW)
                      or self.last_review is not None
                      or self.last_job is not None and self.last_job.proposed is not None else 0)
                    )
            if required_logical>self.limits.total_logical_bytes:
                raise SourceUnavailable()
            retention_fits=required_logical+temporary_source.PHASE_BYTES<=self.limits.total_logical_bytes
            if retained_identity is not None and not retention_fits:
                raise SourceUnavailable()
            retain_source=retain_source and retention_fits
            if kind not in (_Kind.TEMPORARY_STATUS,_Kind.MAINTENANCE,_Kind.JOB_STATUS,_Kind.JOB_CANCEL,_Kind.JOB_LIST,
                            _Kind.HISTORY,_Kind.ENHANCED_HISTORY,_Kind.HISTORY_SOURCES,_Kind.TRACK_EVIDENCE,_Kind.HISTORY_ELIGIBILITY,_Kind.HISTORY_PLAY,
                            _Kind.ENHANCED_REVIEW):
                self.last_job=None
                self.last_review=None
            ticket=_Ticket(handle,self.next_ticket)
            self.next_ticket+=1
            self.current=_Operation(ticket,kind,command,context,constraints,None,
                _Stage.INTAKE if kind in (_Kind.PREPARE,_Kind.JOB,_Kind.REVIEW)
                    and not enhanced_stream and retained_identity is None else _Stage.DISPATCH,
                retain_source=retain_source,retained_identity=retained_identity)
            if enhanced_stream and retained_identity is None:
                try:
                    self.current.job_cancel=threading.Event()
                    self.current.enhanced_channel=enhanced_upload.EnhancedUploadChannel(
                        length,self.current.job_cancel)
                except BaseException:
                    self._discard_locked()
                    raise SourceUnavailable() from None
            if retained_identity is not None:
                self.current.job_cancel=threading.Event()
            if kind is _Kind.PERSONAL_CHANGE:
                # Consumed under the same admission lock before any dispatch.
                # A lost reply cannot redispatch this reviewed choice.
                self.current.personal_review=cached
            if kind is _Kind.REVIEW:
                # Retain only the original bounded command, not a second copy
                # of thousands of leaf digests while the next page is built.
                self.current.continuation_review=cached.result.command if cached is not None else None
                self.current.review_request=command
                if self.current.job_cancel is None:
                    self.current.job_cancel=threading.Event()
                self.current.review_progress=review.FoobarReviewProgress(context.actor.account_id,
                    context.actor.session_id,command,'receiving_source')
            if kind is _Kind.JOB:
                self.current.job_request=command
                if self.current.job_cancel is None:
                    self.current.job_cancel=threading.Event()
                self.current.job_progress=job_worker.FoobarJobProgress(context.actor.account_id,
                    command.command,None,'receiving_source')
            if kind in (_Kind.PREPARE,_Kind.JOB,_Kind.REVIEW) and not enhanced_stream:
                try:
                    self.current.intake=_IntakeBuffer(length,
                        known_byte_budget=intake_byte_charges(length).maximum)
                    self.current.intake.allocate()
                except BaseException:
                    self._discard_locked()
                    raise SourceUnavailable() from None
            self.condition.notify_all()
            return ticket

    def job_progress(self,handle,context,constraints,source_ref,job_ref,*,cancel=False):
        self._identity()
        if type(cancel) is not bool or not prepare_command._uuid(source_ref) or not prepare_command._uuid(job_ref):
            raise prepare_command.PrepareInvalid()
        live=prepare.require_account_foobar(context,constraints)
        with self.condition:
            self._handle(handle)
            operation=self.current
            if operation is None or operation.job_request is None:
                # Idle callers use actual durable status on this same worker;
                # no cached result is substituted for current DB evidence.
                return None
            progress=operation.job_progress
            if (progress.account_id!=live.actor.account_id
                    or (progress.command.source_ref,progress.command.job_ref)!=(source_ref,job_ref)):
                return None
            if cancel:
                operation.job_cancel.set()
                # One bounded control request, no queue. Preserve the real fresh
                # requesting session for its later durable cancel operation.
                operation.job_cancel_context=(context,constraints)
                from dataclasses import replace
                progress=replace(progress,cancel_pending=True)
                operation.job_progress=progress
            return progress

    def _ticket(self,handle,ticket):
        if (type(ticket) is not _Ticket or ticket.handle is not handle
                or handle.owner is not self):
            raise SourceUnavailable()
        return self.current is not None and self.current.ticket is ticket

    def _discard_locked(self):
        # Called only before dispatch or after the complete invocation returned.
        try:
            if self.current.enhanced_channel is not None:
                self.current.enhanced_channel.close()
            if self.current.intake is not None:
                self.current.intake.discard()
            self.current=None
        except BaseException:
            self.state=_State.FAULTED
            raise SourceUnavailable() from None
        finally:
            self.condition.notify_all()

    def enhanced_intake_action(self,handle,ticket,*,chunk=None,finish=False):
        self._identity()
        with self.condition:
            self._handle(handle)
            if (not self._ticket(handle,ticket) or self.state is not _State.OPEN
                    or not _enhanced_operation(self.current.kind,self.current.command)
                    or self.current.stage not in (_Stage.DISPATCH,_Stage.RUNNING)
                    or self.current.enhanced_channel is None):
                raise SourceUnavailable()
            channel=self.current.enhanced_channel
            # Nonblocking channel operations only; worker never acquires this
            # owner lock while holding the channel lock.
            if finish:
                channel.finish()
                return True
            return channel.offer(chunk)

    def intake_action(self,handle,ticket,*,chunk=None,finish=False):
        self._identity()
        with self.condition:
            self._handle(handle)
            if (not self._ticket(handle,ticket) or self.current.stage is not _Stage.INTAKE
                    or self.state is not _State.OPEN):
                raise SourceUnavailable()
            try:
                if finish:
                    self.current.intake.finish()
                    self.current.stage=_Stage.DISPATCH
                else:
                    self.current.intake.append(chunk)
            except BaseException:
                self._discard_locked()
                raise SourceUnavailable() from None
            self.condition.notify_all()

    def take(self,handle,ticket):
        self._identity()
        with self.condition:
            self._handle(handle)
            if not self._ticket(handle,ticket) or self.state is _State.FAULTED:
                raise SourceUnavailable()
            if self.current.stage is not _Stage.DELIVERY:
                return None
            delivery=self.current.delivery
            self.current=None
            self.condition.notify_all()
            return delivery

    def _abandon_locked(self):
        if self.current.stage is _Stage.RUNNING:
            self.current.abandoned=True
            if self.current.job_cancel is not None:
                self.current.job_cancel.set()
        else:
            self._discard_locked()

    def abandon(self,handle,ticket):
        self._identity()
        with self.condition:
            if self._ticket(handle,ticket):
                self._abandon_locked()
            # A completed/previous request is an idempotent no-op, never a
            # release of a newer request even when the handle is shared.
            self.condition.notify_all()

    def detach(self,handle):
        self._identity()
        with self.condition:
            if handle.closed:
                return
            self._handle(handle)
            handle.closed=True
            self.handles.remove(handle)
            if self.current is not None and self.current.ticket.handle is handle:
                self._abandon_locked()
            if not self.handles and self.state not in (_State.FAULTED,_State.QUIESCENT):
                if self.state is _State.DORMANT:
                    self.state=_State.QUIESCENT
                    self.exited.set()
                else:
                    self.state=_State.DRAINING
            self.condition.notify_all()

    def wait_retry(self,operation):
        # Small bounded backoff, interrupted by cancellation/shutdown. The slot
        # and the original upload remain owned; no queue or background timer.
        with self.condition:
            self.condition.wait_for(lambda: self.current is not operation
                or operation.abandoned or self.state is not _State.OPEN
                or operation.job_cancel is not None and operation.job_cancel.is_set(),timeout=0.1)
            return (self.current is operation and not operation.abandoned
                and self.state is _State.OPEN and operation.stage is _Stage.RUNNING
                and (operation.job_cancel is None or not operation.job_cancel.is_set()))

    def retry_permitted(self,operation):
        # This lock is the retry-dispatch cancellation boundary. Cancellation
        # after it observes active work, which must still settle normally.
        with self.condition:
            return (self.current is operation and not operation.abandoned
                and self.state is _State.OPEN and operation.stage is _Stage.RUNNING
                and (operation.job_cancel is None or not operation.job_cancel.is_set()))

    def _worker(self):
        try:
            require_account_import_schema(self.database_url)
            require_foobar_job_schema(self.database_url)
            require_foobar_history_schema(self.database_url)
            with self.condition:
                if self.state is _State.STARTING:
                    self.state=_State.OPEN
                self.condition.notify_all()
            while True:
                if self.retain_raw_enabled and time.monotonic()-self.last_retention_sweep>=60:
                    self.last_retention_sweep=time.monotonic()
                    try:
                        temporary_source.expire_temporary_sources(self.database_url)
                    except Exception:
                        pass  # Optional retention remains inaccessible at expiry.
                with self.condition:
                    if self.state is _State.FAULTED:
                        return
                    if self.state is _State.DRAINING and self.current is None:
                        self.state=_State.QUIESCENT
                        self.condition.notify_all()
                        return
                    if (self.state is _State.OPEN and self.current is not None
                            and self.current.stage is _Stage.DISPATCH):
                        self.current.stage=_Stage.RUNNING
                    else:
                        if self.retain_raw_enabled:
                            self.condition.wait(timeout=60)
                        else:
                            self.condition.wait()
                        continue
                _invoke(self)
                with self.condition:
                    if (self.current is None or self.current.cleanup_failed
                            or type(self.current.delivery) is not _Delivery
                            or self.current.command is not None or self.current.intake is not None
                            or self.current.context is not None or self.current.constraints is not None
                            or self.current.indexed_upload is not None
                            or self.current.enhanced_channel is not None):
                        self.state=_State.FAULTED
                    elif self.current.delivery.kind is _Kind.REVIEW:
                        self.last_review=(replace(self.current.review_progress,
                            phase='cancelled_review',result=None,error=None)
                            if self.current.job_cancel.is_set() else self.current.delivery.receipt
                            if type(self.current.delivery.receipt) is review.FoobarReviewProgress
                            else replace(self.current.review_progress,phase='review_unavailable',
                                result=None,error=self.current.delivery.outcome.value))
                        self.current=None
                    elif self.current.delivery.kind is _Kind.JOB:
                        # Start returned 202; durable job status is the recovery
                        # surface. Do not hold the sole slot waiting for a now
                        # absent HTTP delivery consumer, or retain raw uploads.
                        self.last_job=(self.current.delivery.receipt
                            if type(self.current.delivery.receipt) is job_worker.FoobarJobProgress
                            else replace(self.current.job_progress,phase='needs_reconciliation',
                                uncertain=True,error=self.current.delivery.outcome.value))
                        self.current=None
                    elif self.current.abandoned:
                        self._discard_locked()
                    else:
                        self.current.stage=_Stage.DELIVERY
                    self.condition.notify_all()
        except BaseException:
            with self.condition:
                self.state=_State.FAULTED
                self.condition.notify_all()
        finally:
            # Event witnesses reaching the persistent worker's exit, not merely
            # Thread.join returning after interruption. No new worker is allowed.
            self.exited.set()

    def join(self,handle,timeout):
        timeout=_timeout(timeout)
        self._identity()
        with self.condition:
            if type(handle) is not FoobarImportHandle or handle.owner is not self or not handle.closed:
                raise SourceUnavailable()
            if self.handles:
                # This application's handle is detached; another application
                # still owns the worker. True here is NOT worker termination.
                return True
            if self.state not in (_State.DRAINING,_State.QUIESCENT,_State.FAULTED):
                raise SourceUnavailable()
        if not self.exited.wait(timeout):
            return False
        if self.thread is not None:
            self.thread.join(0)
            return not self.thread.is_alive()
        return True


_MODULE_EPOCH=object()
if '_ROOT_PID' not in globals():
    _ROOT_PID=os.getpid()
    _ROOT_LOCK=threading.Lock()
    _PROCESS_OWNER=None


def create_foobar_import_service(configuration,*,database_url):
    """Construct dormant server owner. Startup separately verifies schema.

    Does not register routes, alter permissions, execute migrations, activate a
    deployment or close shared pools. PID/reload mismatch never replaces a root.
    """
    global _PROCESS_OWNER
    # Server startup deployment choice, never a request flag or readiness
    # assertion. Structural inspection and native policy checks still apply.
    if type(configuration) is not dict or configuration.get('ALBUM_HAVEN_FOOBAR_ACCOUNT_IMPORT_ENABLED') is not True:
        raise SourceUnavailable()
    limits=parse_foobar_import_limits(configuration)
    if type(database_url) is not str or not database_url.strip():
        raise SourceUnavailable()
    if __name__!=_CANONICAL_MODULE or os.getpid()!=_ROOT_PID:
        raise SourceUnavailable()
    with _ROOT_LOCK:
        if _PROCESS_OWNER is None:
            _PROCESS_OWNER=_ProcessOwner(limits,database_url,native_configuration=configuration)
        _PROCESS_OWNER._identity()
        if _PROCESS_OWNER.limits!=limits or _PROCESS_OWNER.database_url!=database_url:
            raise SourceUnavailable()
        if _PROCESS_OWNER.native_configuration is not configuration:
            # A different app/config cannot borrow another app's media host.
            raise SourceUnavailable()
        return _PROCESS_OWNER.attach()
