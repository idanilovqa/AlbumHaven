"""Execution-time authorization for claimed durable jobs."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.policy import PolicyContext, RequestOrigin, ResourceScope
from music_app.services.policy_evaluator import (
    PolicyEvaluationConstraints,
    PolicyEvaluator,
)

from .models import ClaimedJob, JobKind
from .registry import policy_for


_POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807
_BOUNDED_TEXT = re.compile(r"[^\x00-\x1f\x7f]{1,1024}\Z")
_REASON_CODE = re.compile(r"[a-z][a-z0-9_]{0,127}\Z")
_APPROVED_DEPLOYMENT_MODES = frozenset(
    {"local_development", "self_hosted", "self_hosted_private_web"}
)


@dataclass(frozen=True, slots=True)
class AuthorizationDecision:
    allowed: bool
    reason_code: str

    def __post_init__(self) -> None:
        if not isinstance(self.allowed, bool) or not isinstance(
            self.reason_code, str
        ) or not _REASON_CODE.fullmatch(self.reason_code):
            raise ValueError("authorization decision is invalid")


@dataclass(frozen=True, slots=True)
class JobAuthorizationContext:
    actor: CurrentActor | None
    session_is_expired: bool
    membership_current: bool
    request_origin_id: int | None
    request_origin_account_id: int | None
    request_origin: RequestOrigin | None
    deployment_allowed: bool
    client_surface_allowed: bool
    library_current: bool
    root_current: bool = False
    resource_current: bool = False
    scope_version: int | None = None
    resource_revision: int | None = None
    integration_session_ref: str | None = None
    public_lifecycle_current: bool = False
    server_scope_current: bool = False


class PostgresJobAuthorizationContextRepository:
    """Load one redacted current-authority snapshot without a browser session."""

    def __init__(
        self,
        database_url: str,
        *,
        connect_to_database: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(database_url or "").strip()
        self._connect_to_database = connect_to_database or _connect_to_database

    def load_authorization_context(
        self, claim: ClaimedJob, now: datetime
    ) -> JobAuthorizationContext:
        if not self._database_url:
            raise RuntimeError("job authorization database URL is required")
        if not isinstance(claim, ClaimedJob):
            raise RuntimeError("job authorization claim is invalid")

        statement = """
            select *
              from app.load_claimed_job_authorization_context(
                %(job_id)s, %(attempt)s, %(worker_id)s,
                %(lease_token)s, %(now)s
              )
        """
        parameters = {
            "job_id": claim.job_id,
            "attempt": claim.attempt,
            "worker_id": claim.worker_id,
            "lease_token": claim.lease_token,
            "now": now,
        }
        with self._connect_to_database(self._database_url) as connection:
            rows = connection.execute(statement, parameters).fetchall()
        if len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise RuntimeError("job authorization snapshot is invalid")
        return _authorization_context_from_row(rows[0], claim)


ResourceValidator = Callable[
    [ClaimedJob, Any, datetime], AuthorizationDecision
]


def build_lastfm_retry_resource_validator(
    *, retry_repository: Any
) -> ResourceValidator:
    """Validate one pending scrobble against its exact claim and session."""

    def validate(
        claim: ClaimedJob, context: Any, now: datetime
    ) -> AuthorizationDecision:
        try:
            pending_id = int(claim.subject_ref)
            active_session_id = int(claim.parameters.get("active_session_ref"))
        except (AttributeError, TypeError, ValueError):
            return AuthorizationDecision(False, "lastfm_retry_scope_invalid")
        if (
            claim.kind not in {JobKind.LASTFM_SCROBBLE_RETRY, "lastfm_scrobble_retry"}
            or claim.subject_kind != "pending_scrobble"
            or pending_id < 1
            or active_session_id < 1
            or set(claim.parameters) != {"active_session_ref"}
            or claim.account_id is None
            or claim.library_id is None
            or claim.capability_key != "integration.lastfm.scrobble"
            or claim.max_attempts != 1
            or claim.scope_version is None
            or claim.resource_revision is None
            or not 1 <= claim.resource_revision <= 5
            or claim.idempotency_key
            != f"lastfm-scrobble:{pending_id}:attempt:{claim.resource_revision}"
        ):
            return AuthorizationDecision(False, "lastfm_retry_scope_invalid")
        if context.integration_session_ref != str(active_session_id):
            return AuthorizationDecision(False, "integration_session_replaced")
        try:
            valid = retry_repository.validate_claimed_retry(
                pending_scrobble_id=pending_id,
                active_session_id=active_session_id,
                account_id=claim.account_id,
                library_id=claim.library_id,
                job_id=claim.job_id,
                attempt=claim.attempt,
                worker_id=claim.worker_id,
                lease_token=claim.lease_token,
                now=now,
                row_revision=claim.scope_version,
                accepted_attempt=claim.resource_revision,
            )
        except Exception:
            return AuthorizationDecision(False, "lastfm_retry_scope_invalid")
        if valid is not True:
            return AuthorizationDecision(False, "lastfm_retry_scope_stale")
        return AuthorizationDecision(True, "lastfm_retry_scope_current")

    return validate


class JobAuthorizationService:
    """Revalidate durable authority without reviving an initiating session."""

    def __init__(
        self,
        *,
        context_repository: Any,
        policy_evaluator: PolicyEvaluator,
        resource_validators: Mapping[str, ResourceValidator],
    ) -> None:
        self._context_repository = context_repository
        self._policy_evaluator = policy_evaluator
        self._resource_validators = dict(resource_validators)

    def authorize(
        self, claim: ClaimedJob, now: datetime
    ) -> AuthorizationDecision:
        if not _valid_claim(claim) or not _aware_datetime(now):
            return AuthorizationDecision(False, "authorization_input_invalid")

        try:
            kind = claim.kind.value if isinstance(claim.kind, JobKind) else claim.kind
            policy = policy_for(kind)
        except (TypeError, ValueError):
            return AuthorizationDecision(False, "job_kind_unregistered")

        validator = self._resource_validators.get(kind)
        if validator is None:
            return AuthorizationDecision(False, "authorization_validator_missing")

        server_owned = policy.server_owned
        public_lifecycle = (
            policy.public_lifecycle
            and claim.account_id is None
            and claim.capability_key is None
        )
        if server_owned and (
            claim.library_id is None
            or any(
                value is not None
                for value in (
                    claim.account_id,
                    claim.capability_key,
                    claim.request_origin_id,
                )
            )
        ):
            return AuthorizationDecision(False, "authorization_input_invalid")
        if (
            not server_owned
            and not public_lifecycle
            and claim.capability_key not in policy.allowed_capability_keys
        ):
            return AuthorizationDecision(False, "capability_revoked")

        if (
            server_owned
            and kind == JobKind.TARGETED_RECONCILIATION.value
            and claim.client_surface == "library_watcher"
        ):
            context = JobAuthorizationContext(
                actor=None,
                session_is_expired=True,
                membership_current=False,
                request_origin_id=None,
                request_origin_account_id=None,
                request_origin=None,
                deployment_allowed=(
                    claim.deployment_mode in _APPROVED_DEPLOYMENT_MODES
                ),
                client_surface_allowed=True,
                library_current=True,
            )
        else:
            try:
                context = self._context_repository.load_authorization_context(
                    claim, now
                )
            except Exception:
                return AuthorizationDecision(
                    False, "authorization_context_invalid"
                )
        if not _valid_context(context):
            return AuthorizationDecision(False, "authorization_context_invalid")
        if server_owned or public_lifecycle:
            if not context.deployment_allowed:
                return AuthorizationDecision(False, "deployment_denied")
            if not context.client_surface_allowed:
                return AuthorizationDecision(False, "client_surface_denied")

        if server_owned:
            return _run_validator(validator, claim, context, now)

        if public_lifecycle:
            if (
                claim.request_origin_id is None
                or context.request_origin_id != claim.request_origin_id
                or not isinstance(context.request_origin, RequestOrigin)
            ):
                return AuthorizationDecision(False, "request_origin_revoked")
            return _run_validator(validator, claim, context, now)

        actor = context.actor
        if (
            not isinstance(actor, CurrentActor)
            or actor.state is not ActorState.ACTIVE
            or actor.account_id != claim.account_id
        ):
            return AuthorizationDecision(False, "actor_inactive")

        if claim.library_id is not None and (
            not context.membership_current
            or not any(
                relationship.library_id == claim.library_id
                for relationship in actor.library_relationships
            )
        ):
            return AuthorizationDecision(False, "membership_revoked")

        if (
            claim.request_origin_id is None
            or context.request_origin_id != claim.request_origin_id
            or context.request_origin_account_id != claim.account_id
            or not isinstance(context.request_origin, RequestOrigin)
        ):
            return AuthorizationDecision(False, "request_origin_revoked")

        if not isinstance(claim.capability_key, str):
            return AuthorizationDecision(False, "capability_revoked")

        try:
            policy_context = PolicyContext.build(
                actor=actor,
                action=claim.capability_key,
                resource=ResourceScope(claim.subject_kind, claim.subject_ref),
                target_account_id=claim.account_id,
                library_id=claim.library_id,
                deployment_mode=claim.deployment_mode,
                request_origin=context.request_origin,
                client_surface_class=claim.client_surface,
            )
            evaluation = self._policy_evaluator.evaluate(
                policy_context,
                constraints=PolicyEvaluationConstraints(
                    deployment_allowed=context.deployment_allowed,
                    client_surface_allowed=context.client_surface_allowed,
                    request_origin_allowed=True,
                ),
            )
        except (AttributeError, TypeError, ValueError):
            return AuthorizationDecision(False, "authorization_context_invalid")

        if not evaluation.decision.allowed:
            reason_code = evaluation.decision.reason_code
            if reason_code in {"actor_inactive", "authentication_required"}:
                reason_code = "actor_inactive"
            elif reason_code in {"capability_required", "bootstrap_only"}:
                reason_code = "capability_revoked"
            return _closed_decision(False, reason_code)

        resource_decision = _run_validator(validator, claim, context, now)
        if not resource_decision.allowed:
            return resource_decision
        if evaluation.decision.reason_code == "bootstrap_owner":
            return AuthorizationDecision(True, "bootstrap_owner")
        return AuthorizationDecision(True, "authorized")


def _run_validator(
    validator: ResourceValidator,
    claim: ClaimedJob,
    context: Any,
    now: datetime,
) -> AuthorizationDecision:
    try:
        decision = validator(claim, context, now)
    except Exception:
        return AuthorizationDecision(False, "authorization_context_invalid")
    if not isinstance(decision, AuthorizationDecision):
        return AuthorizationDecision(False, "authorization_context_invalid")
    return decision


def _closed_decision(allowed: bool, reason_code: Any) -> AuthorizationDecision:
    if not isinstance(reason_code, str) or not _REASON_CODE.fullmatch(reason_code):
        return AuthorizationDecision(False, "authorization_context_invalid")
    return AuthorizationDecision(allowed, reason_code)


def _aware_datetime(value: Any) -> bool:
    return (
        isinstance(value, datetime)
        and value.tzinfo is not None
        and value.utcoffset() is not None
    )


def _positive_bigint(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= _POSTGRES_BIGINT_MAX
    )


def _optional_positive_bigint(value: Any) -> bool:
    return value is None or _positive_bigint(value)


def _optional_revision(value: Any) -> bool:
    return value is None or (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= _POSTGRES_BIGINT_MAX
    )


def _bounded_text(value: Any, *, maximum: int = 128) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= maximum
        and bool(_BOUNDED_TEXT.fullmatch(value))
        and bool(value.strip())
    )


def _valid_claim(claim: Any) -> bool:
    if not isinstance(claim, ClaimedJob):
        return False
    return all(
        (
            _positive_bigint(claim.job_id),
            _optional_positive_bigint(claim.account_id),
            _optional_positive_bigint(claim.library_id),
            _optional_positive_bigint(claim.request_origin_id),
            _bounded_text(claim.subject_kind),
            _bounded_text(claim.subject_ref, maximum=1024),
            _bounded_text(claim.deployment_mode),
            _bounded_text(claim.client_surface),
            _bounded_text(claim.idempotency_key, maximum=1024),
            _bounded_text(claim.worker_id),
            _bounded_text(claim.lease_token),
            isinstance(claim.attempt, int)
            and not isinstance(claim.attempt, bool)
            and claim.attempt > 0,
            isinstance(claim.max_attempts, int)
            and not isinstance(claim.max_attempts, bool)
            and claim.attempt <= claim.max_attempts,
            _aware_datetime(claim.lease_expires_at),
            _aware_datetime(claim.scheduled_at),
            _optional_revision(claim.scope_version),
            _optional_revision(claim.resource_revision),
        )
    )


def _valid_context(context: Any) -> bool:
    try:
        return _valid_context_value(context)
    except Exception:
        return False


def _valid_context_value(context: Any) -> bool:
    required = (
        "actor",
        "session_is_expired",
        "membership_current",
        "request_origin_id",
        "request_origin_account_id",
        "request_origin",
        "deployment_allowed",
        "client_surface_allowed",
        "library_current",
        "root_current",
        "resource_current",
        "scope_version",
        "resource_revision",
        "integration_session_ref",
        "public_lifecycle_current",
        "server_scope_current",
    )
    if context is None or any(not hasattr(context, name) for name in required):
        return False
    if context.actor is not None and not isinstance(context.actor, CurrentActor):
        return False
    if any(
        not isinstance(getattr(context, name), bool)
        for name in (
            "session_is_expired",
            "membership_current",
            "deployment_allowed",
            "client_surface_allowed",
            "library_current",
            "root_current",
            "resource_current",
            "public_lifecycle_current",
            "server_scope_current",
        )
    ):
        return False
    if isinstance(context.actor, CurrentActor):
        if (
            not isinstance(context.actor.state, ActorState)
            or not _optional_positive_bigint(context.actor.account_id)
            or not _optional_positive_bigint(context.actor.session_id)
            or not _optional_positive_bigint(context.actor.current_library_id)
            or not isinstance(context.actor.is_bootstrap_owner, bool)
        ):
            return False
        relationships = context.actor.library_relationships
        if not isinstance(relationships, tuple) or any(
            not isinstance(relationship, LibraryRelationship)
            or not _positive_bigint(relationship.library_id)
            or not _bounded_text(relationship.membership_role)
            or not isinstance(relationship.is_primary_owner, bool)
            for relationship in relationships
        ):
            return False
        capability_grants = context.actor.capability_grants
        if not isinstance(capability_grants, tuple) or any(
            not isinstance(grant, CapabilityGrant)
            or not _bounded_text(grant.capability_key)
            or not _bounded_text(grant.scope_kind)
            or not _optional_positive_bigint(grant.scope_id)
            for grant in capability_grants
        ):
            return False
    return (
        _optional_positive_bigint(context.request_origin_id)
        and _optional_positive_bigint(context.request_origin_account_id)
        and (
            context.request_origin is None
            or isinstance(context.request_origin, RequestOrigin)
        )
        and _optional_revision(context.scope_version)
        and _optional_revision(context.resource_revision)
        and (
            context.integration_session_ref is None
            or _bounded_text(context.integration_session_ref, maximum=1024)
        )
    )


def _authorization_context_from_row(
    row: Mapping[str, Any], claim: ClaimedJob
) -> JobAuthorizationContext:
    account_id = _optional_row_id(row.get("account_id"), "account")
    library_exists = _required_bool(row.get("library_exists"), "library")
    membership_current = _required_bool(
        row.get("membership_current"), "membership"
    )
    bootstrap_owner = _required_bool(
        row.get("is_bootstrap_owner"), "bootstrap owner"
    )
    account_active_value = row.get("account_is_active")
    if account_id is None:
        if account_active_value is not None:
            raise RuntimeError("job authorization account snapshot is invalid")
        actor = None
    else:
        account_active = _required_bool(account_active_value, "account")
        relationships = _library_relationship_rows(row.get("library_relationships"))
        grants = _capability_grant_rows(row.get("capability_grants"))
        actor = CurrentActor(
            state=ActorState.ACTIVE if account_active else ActorState.INACTIVE,
            account_id=account_id,
            session_id=None,
            is_bootstrap_owner=bootstrap_owner,
            current_library_id=(
                claim.library_id
                if library_exists
                and any(item.library_id == claim.library_id for item in relationships)
                else None
            ),
            library_relationships=relationships,
            capability_grants=grants,
        )

    origin_id = _optional_row_id(row.get("request_origin_id"), "request origin")
    origin_account_id = _optional_row_id(
        row.get("request_origin_account_id"), "request origin account"
    )
    origin_type = row.get("request_origin_type")
    origin_surface = row.get("request_origin_surface")
    if origin_id is None:
        if any(value is not None for value in (origin_account_id, origin_type, origin_surface)):
            raise RuntimeError("job authorization request origin snapshot is invalid")
        request_origin = None
    else:
        if not _bounded_text(origin_type) or not _bounded_text(origin_surface):
            raise RuntimeError("job authorization request origin snapshot is invalid")
        try:
            request_origin = RequestOrigin(str(origin_type), f"persisted:{origin_id}")
        except ValueError:
            raise RuntimeError(
                "job authorization request origin snapshot is invalid"
            ) from None

    policy = policy_for(claim.kind)
    origin_matches_surface = origin_surface == claim.client_surface
    server_owned_surface_allowed = (
        policy.server_owned
        and origin_id is None
        and (
            claim.client_surface == "private_web"
            or (
                claim.kind in {JobKind.TARGETED_RECONCILIATION, "targeted_reconciliation"}
                and claim.client_surface == "library_watcher"
            )
        )
    )
    client_surface_allowed = (
        claim.client_surface == "private_web" and origin_matches_surface
    ) or server_owned_surface_allowed
    return JobAuthorizationContext(
        actor=actor,
        session_is_expired=True,
        membership_current=membership_current,
        request_origin_id=origin_id,
        request_origin_account_id=origin_account_id,
        request_origin=request_origin,
        deployment_allowed=claim.deployment_mode in _APPROVED_DEPLOYMENT_MODES,
        client_surface_allowed=client_surface_allowed,
        library_current=library_exists,
        integration_session_ref=(
            str(row["integration_session_ref"])
            if row.get("integration_session_ref") is not None
            else None
        ),
    )


def _library_relationship_rows(value: Any) -> tuple[LibraryRelationship, ...]:
    if not isinstance(value, list):
        raise RuntimeError("job authorization library snapshot is invalid")
    relationships = []
    for item in value:
        if not isinstance(item, Mapping):
            raise RuntimeError("job authorization library snapshot is invalid")
        library_id = _optional_row_id(item.get("library_id"), "library")
        role = item.get("membership_role")
        primary = item.get("is_primary_owner")
        if library_id is None or not _bounded_text(role) or not isinstance(primary, bool):
            raise RuntimeError("job authorization library snapshot is invalid")
        relationships.append(LibraryRelationship(library_id, str(role), primary))
    return tuple(sorted(relationships, key=lambda item: item.library_id))


def _capability_grant_rows(value: Any) -> tuple[Any, ...]:
    from music_app.services.current_actor import CapabilityGrant

    if not isinstance(value, list):
        raise RuntimeError("job authorization capability snapshot is invalid")
    grants = []
    for item in value:
        if not isinstance(item, Mapping):
            raise RuntimeError("job authorization capability snapshot is invalid")
        key = item.get("capability_key")
        scope_kind = item.get("scope_kind")
        scope_id = _optional_row_id(item.get("scope_id"), "capability scope")
        if not _bounded_text(key) or not _bounded_text(scope_kind):
            raise RuntimeError("job authorization capability snapshot is invalid")
        grants.append(CapabilityGrant(str(key), str(scope_kind), scope_id))
    return tuple(
        sorted(
            grants,
            key=lambda item: (
                item.capability_key,
                item.scope_kind,
                item.scope_id is not None,
                item.scope_id or 0,
            ),
        )
    )


def _optional_row_id(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if not _positive_bigint(value):
        raise RuntimeError(f"job authorization {field} snapshot is invalid")
    return value


def _required_bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise RuntimeError(f"job authorization {field} snapshot is invalid")
    return value


def _connect_to_database(database_url: str) -> Any:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        raise RuntimeError("psycopg is required for job authorization") from None
    return psycopg.connect(database_url, row_factory=dict_row)
