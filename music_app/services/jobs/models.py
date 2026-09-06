"""Data-only contracts shared by durable job producers and workers."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Mapping


class JobKind(str, Enum):
    FULL_SCAN = "full_scan"
    TARGETED_RECONCILIATION = "targeted_reconciliation"
    POST_SCAN_COVER_REFRESH = "post_scan_cover_refresh"
    COVER_LOOKUP = "cover_lookup"
    COVER_REMOTE_SAVE = "cover_remote_save"
    LASTFM_SCROBBLE_RETRY = "lastfm_scrobble_retry"
    AUTH_WELCOME_DELIVERY = "auth_welcome_delivery"
    AUTH_INVITATION_DELIVERY = "auth_invitation_delivery"
    AUTH_PASSWORD_RESET_DELIVERY = "auth_password_reset_delivery"


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    RETRY_WAIT = "retry_wait"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"
    AMBIGUOUS = "ambiguous"


class RecoveryPolicy(str, Enum):
    RETRY_SAFE = "retry_safe"
    AMBIGUOUS_ON_STALE_LEASE = "ambiguous_on_stale_lease"


@dataclass(frozen=True)
class JobPolicy:
    allowed_capability_keys: frozenset[str]
    max_attempts: int
    recovery_policy: RecoveryPolicy
    server_owned: bool = False
    public_lifecycle: bool = False


@dataclass(frozen=True)
class EnqueueJob:
    kind: str | JobKind
    subject_kind: str
    subject_ref: str
    parameters: Mapping[str, Any]
    account_id: int | None
    library_id: int | None
    capability_key: str | None
    request_origin_ref: str | None
    deployment_mode: str
    client_surface: str
    idempotency_key: str
    scheduled_at: datetime
    max_attempts: int


@dataclass(frozen=True)
class ClaimedJob:
    job_id: int
    kind: str | JobKind
    subject_kind: str
    subject_ref: str
    parameters: Mapping[str, Any]
    account_id: int | None
    library_id: int | None
    capability_key: str | None
    request_origin_ref: str | None
    deployment_mode: str
    client_surface: str
    idempotency_key: str
    attempt: int
    max_attempts: int
    worker_id: str
    lease_token: str
    lease_expires_at: datetime
    scheduled_at: datetime


@dataclass(frozen=True)
class JobTransitionResult:
    next_state: JobState
    reason_code: str
    scheduled_at: datetime | None = None
    details: Mapping[str, Any] = field(default_factory=dict)
