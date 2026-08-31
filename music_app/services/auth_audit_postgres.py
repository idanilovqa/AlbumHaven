"""Append-only, privacy-minimized Postgres security audit persistence."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from enum import Enum
import re
from typing import Any

try:  # pragma: no cover - exercised when the optional driver is installed.
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    Jsonb = None


class SecurityAuditCategory(str, Enum):
    LOGIN = "login"
    PASSWORD_RECOVERY = "password_recovery"
    CREDENTIAL = "credential"


class SecurityAuditOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"
    THROTTLED = "throttled"


class LoginAuditReason(str, Enum):
    VERIFIED = "verified"
    CREDENTIAL_MISMATCH = "credential_mismatch"
    ACCOUNT_INELIGIBLE = "account_ineligible"
    CANDIDATE_INVALID = "candidate_invalid"
    BUCKET_BLOCKED = "bucket_blocked"
    VERIFICATION_CAPACITY = "verification_capacity"
    CREDENTIAL_RACE = "credential_race"


class RecoveryAuditReason(str, Enum):
    RESET_ISSUED = "reset_issued"
    RESET_COMPLETED = "reset_completed"
    RESET_INVALID = "reset_invalid"
    ACCOUNT_INELIGIBLE = "account_ineligible"
    BUCKET_BLOCKED = "bucket_blocked"


class CredentialAuditReason(str, Enum):
    PASSWORD_CHANGED = "password_changed"
    CURRENT_PASSWORD_INVALID = "current_password_invalid"
    SUGGESTION_DISMISSED = "suggestion_dismissed"
    ADMINISTRATOR_REAUTHENTICATED = "administrator_reauthenticated"
    ADMINISTRATOR_REAUTHENTICATION_INVALID = "administrator_reauthentication_invalid"


_LOGIN_REASON_MATRIX = {
    SecurityAuditOutcome.SUCCESS: frozenset({LoginAuditReason.VERIFIED}),
    SecurityAuditOutcome.INVALID: frozenset(
        {
            LoginAuditReason.CREDENTIAL_MISMATCH,
            LoginAuditReason.ACCOUNT_INELIGIBLE,
            LoginAuditReason.CANDIDATE_INVALID,
            LoginAuditReason.CREDENTIAL_RACE,
        }
    ),
    SecurityAuditOutcome.THROTTLED: frozenset(
        {
            LoginAuditReason.BUCKET_BLOCKED,
            LoginAuditReason.VERIFICATION_CAPACITY,
        }
    ),
}
_RECOVERY_REASON_MATRIX = {
    SecurityAuditOutcome.SUCCESS: frozenset(
        {RecoveryAuditReason.RESET_ISSUED, RecoveryAuditReason.RESET_COMPLETED}
    ),
    SecurityAuditOutcome.INVALID: frozenset(
        {RecoveryAuditReason.ACCOUNT_INELIGIBLE, RecoveryAuditReason.RESET_INVALID}
    ),
    SecurityAuditOutcome.THROTTLED: frozenset({RecoveryAuditReason.BUCKET_BLOCKED}),
}
_CREDENTIAL_REASON_MATRIX = {
    SecurityAuditOutcome.SUCCESS: frozenset(
        {
            CredentialAuditReason.PASSWORD_CHANGED,
            CredentialAuditReason.SUGGESTION_DISMISSED,
            CredentialAuditReason.ADMINISTRATOR_REAUTHENTICATED,
        }
    ),
    SecurityAuditOutcome.INVALID: frozenset(
        {
            CredentialAuditReason.CURRENT_PASSWORD_INVALID,
            CredentialAuditReason.ADMINISTRATOR_REAUTHENTICATION_INVALID,
        }
    ),
    SecurityAuditOutcome.THROTTLED: frozenset(),
}
_SOURCE_CLASSES = frozenset({"loopback", "private", "public", "trusted_proxy"})
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_METADATA_KEYS = frozenset(
    {
        "session_id",
        "hmac_key_version",
        "argon2_policy_version",
        "credential_rehashed",
        "source_class",
    }
)


class PostgresSecurityAuditRepository:
    """Append security events using a transaction owned by the caller."""

    def append_in_transaction(
        self,
        connection: Any,
        *,
        category: SecurityAuditCategory,
        outcome: SecurityAuditOutcome,
        reason: LoginAuditReason | RecoveryAuditReason | CredentialAuditReason,
        actor_account_id: int | None,
        target_account_id: int | None,
        request_ref: str | None,
        occurred_at: datetime,
        metadata: Mapping[str, object] | None,
    ) -> int:
        category = _category(category)
        outcome = _outcome(outcome)
        reason = _reason(category, reason, outcome)
        actor_account_id = _nullable_id(actor_account_id)
        target_account_id = _nullable_id(target_account_id)
        request_ref = _request_reference(request_ref)
        occurred_at = _utc_timestamp(occurred_at)
        metadata_payload = _metadata(metadata)

        try:
            if Jsonb is None:
                raise RuntimeError
            connection.execute(
                """
                insert into app.security_audit_events (
                  actor_account_id, target_account_id, event_category, outcome,
                  reason_code, request_ref, occurred_at, metadata
                ) values (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    actor_account_id,
                    target_account_id,
                    category.value,
                    outcome.value,
                    reason.value,
                    request_ref,
                    occurred_at,
                    Jsonb(metadata_payload),
                ),
            )
            cursor = connection.execute(
                "select currval('app.security_audit_events_id_seq') as id"
            )
            row = cursor.fetchone()
            event_id = _returned_id(row)
            if event_id is None:
                raise ValueError
        except Exception:
            raise RuntimeError("Security audit persistence operation failed.") from None
        return event_id


def _category(value: object) -> SecurityAuditCategory:
    if not isinstance(value, SecurityAuditCategory):
        raise TypeError("Security audit category is invalid.")
    return value


def _outcome(value: object) -> SecurityAuditOutcome:
    if not isinstance(value, SecurityAuditOutcome):
        raise TypeError("Security audit outcome is invalid.")
    return value


def _reason(
    category: SecurityAuditCategory,
    value: object,
    outcome: SecurityAuditOutcome,
) -> LoginAuditReason | RecoveryAuditReason | CredentialAuditReason:
    if category is SecurityAuditCategory.LOGIN:
        valid_type = LoginAuditReason
        matrix = _LOGIN_REASON_MATRIX
    elif category is SecurityAuditCategory.PASSWORD_RECOVERY:
        valid_type = RecoveryAuditReason
        matrix = _RECOVERY_REASON_MATRIX
    else:
        valid_type = CredentialAuditReason
        matrix = _CREDENTIAL_REASON_MATRIX
    if not isinstance(value, valid_type):
        raise TypeError("Security audit reason is invalid.")
    if value not in matrix[outcome]:
        raise ValueError("Security audit outcome and reason are incompatible.")
    return value


def _nullable_id(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Security audit account reference is invalid.")
    return value


def _request_reference(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("Security audit request reference is invalid.")
    if _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Security audit request reference is invalid.")
    return value


def _utc_timestamp(value: object) -> datetime:
    try:
        valid = (
            isinstance(value, datetime)
            and value.tzinfo is not None
            and value.utcoffset() == timedelta(0)
        )
    except Exception:
        raise ValueError("Security audit timestamp is invalid.") from None
    if not valid:
        raise ValueError("Security audit timestamp is invalid.")
    return value


def _metadata(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise TypeError("Security audit metadata is invalid.")
    try:
        payload = dict(value)
    except Exception:
        raise ValueError("Security audit metadata is invalid.") from None
    if set(payload) - _METADATA_KEYS:
        raise ValueError("Security audit metadata is invalid.")

    for key in ("session_id", "hmac_key_version", "argon2_policy_version"):
        if key in payload:
            item = payload[key]
            if isinstance(item, bool) or not isinstance(item, int) or item < 1:
                raise ValueError("Security audit metadata is invalid.")
    if "credential_rehashed" in payload and not isinstance(
        payload["credential_rehashed"], bool
    ):
        raise ValueError("Security audit metadata is invalid.")
    if "source_class" in payload:
        source_class = payload["source_class"]
        if not isinstance(source_class, str) or source_class not in _SOURCE_CLASSES:
            raise ValueError("Security audit metadata is invalid.")
    return payload


def _returned_id(row: object) -> int | None:
    if isinstance(row, Mapping):
        value = row.get("id")
    elif isinstance(row, (tuple, list)) and row:
        value = row[0]
    else:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value
