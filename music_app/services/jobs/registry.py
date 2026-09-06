"""Closed durable-job registry and its privacy/ownership boundary."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from types import MappingProxyType
from typing import Any

from .models import EnqueueJob, JobKind, JobPolicy, RecoveryPolicy


_POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807
JOB_POLICIES: Mapping[str, JobPolicy] = MappingProxyType({
    "full_scan": JobPolicy(
        frozenset({"library.refresh"}), 2, RecoveryPolicy.RETRY_SAFE
    ),
    "targeted_reconciliation": JobPolicy(
        frozenset(), 3, RecoveryPolicy.RETRY_SAFE, server_owned=True
    ),
    "post_scan_cover_refresh": JobPolicy(
        frozenset(), 2, RecoveryPolicy.RETRY_SAFE, server_owned=True
    ),
    "cover_lookup": JobPolicy(
        frozenset({"library.covers.lookup"}), 2, RecoveryPolicy.RETRY_SAFE
    ),
    "cover_remote_save": JobPolicy(
        frozenset({"library.covers.write"}),
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
    ),
    "lastfm_scrobble_retry": JobPolicy(
        frozenset({"integration.lastfm.scrobble"}),
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
    ),
    "auth_welcome_delivery": JobPolicy(
        frozenset({"accounts.welcome.send"}), 3, RecoveryPolicy.RETRY_SAFE
    ),
    "auth_invitation_delivery": JobPolicy(
        frozenset({"accounts.invitation.send"}),
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
    ),
    "auth_password_reset_delivery": JobPolicy(
        frozenset({"accounts.password_reset.send"}),
        1,
        RecoveryPolicy.AMBIGUOUS_ON_STALE_LEASE,
        public_lifecycle=True,
    ),
})

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
_STABLE_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*\Z")
_EMAIL_ADDRESS = re.compile(
    r"(?i)(?<![\w.+-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\."
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*"
)
_WINDOWS_ABSOLUTE_PATH = re.compile(r"(?i)(?<![a-z0-9+.-])[a-z]:[\\/]")
_UNC_PATH = re.compile(r"(?<!\\)\\\\[^\\\s]+\\")
_POSIX_ABSOLUTE_PATH = re.compile(
    r"(?<![a-z0-9/])/(?!/)(?:[^/\s]+/)+[^/\s]*", re.IGNORECASE
)
_BEARER_TOKEN = re.compile(r"(?i)\bbearer\s+\S+")
_OPAQUE_BEARER_VALUE = re.compile(r"[A-Za-z0-9_-]{43,}\Z")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?<![\w-])(?:"
    r"(?:[a-z0-9]+[_-])*(?:api[_-]?key|password|token|secret)\s*=\s*\S+|"
    r"(?:api[_-]?key|password|token|secret|smtp[_-]?password|"
    r"lastfm[_-]?secret)\s*:\s*\S+)"
)
_PATH_SEPARATOR = re.compile(r"[\\/]")
_SENSITIVE_KEY_TOKENS = frozenset(
    {
        "apikey",
        "auth",
        "authorization",
        "bearer",
        "cookie",
        "credential",
        "password",
        "providerpayload",
        "secret",
        "session",
        "smtp",
        "token",
    }
)
_RAW_CARRIER_TOKEN_PAIRS = frozenset(
    {
        ("access", "token"),
        ("api", "key"),
        ("auth", "header"),
        ("client", "secret"),
        ("private", "key"),
        ("provider", "payload"),
    }
)
_STABLE_CONTEXT_METADATA_TOKENS = frozenset({"id", "ref", "revision", "version"})
_PRIVATE_FIXTURE = re.compile(r"(?i)(?:^|[\\/])fixtures[\\/]private[\\/]")
_MEDIA_PATH = re.compile(
    r"(?i)(?:^|[\\/])[^\\/]+\."
    r"(?:aac|aiff?|alac|ape|flac|m4a|mp3|ogg|opus|wav|wma)$"
)

_LIBRARY_SCOPED_KINDS = frozenset(
    {
        JobKind.FULL_SCAN.value,
        JobKind.COVER_LOOKUP.value,
        JobKind.COVER_REMOTE_SAVE.value,
    }
)


def policy_for(kind: str | JobKind) -> JobPolicy:
    """Return the policy for a registered kind, rejecting arbitrary work."""

    key = kind.value if isinstance(kind, JobKind) else kind
    try:
        return JOB_POLICIES[key]
    except (KeyError, TypeError) as exc:
        raise ValueError("unknown job kind") from exc


def _validate_identifier(
    name: str, value: str | None, *, maximum: int, required: bool = True
) -> None:
    if value is None:
        if required:
            raise ValueError(f"{name} is required")
        return
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonblank bounded string")
    if len(value) > maximum or _CONTROL_CHARACTER.search(value):
        raise ValueError(f"{name} must be a bounded string without control characters")
    if not _STABLE_IDENTIFIER.fullmatch(value):
        raise ValueError(f"{name} must be a stable identifier")


def _is_scalar(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _validate_optional_positive_id(name: str, value: Any) -> None:
    if value is not None and (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > _POSTGRES_BIGINT_MAX
    ):
        raise ValueError(f"{name} must be a positive integer when present")


def _validate_optional_revision(name: str, value: Any) -> None:
    if value is not None and (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _POSTGRES_BIGINT_MAX
    ):
        raise ValueError(f"{name} must be a nonnegative integer when present")


def _validate_parameter_shape(parameters: Any) -> Mapping[str, Any]:
    if not isinstance(parameters, Mapping):
        raise ValueError("parameters must be a JSON object")

    for key, value in parameters.items():
        if not isinstance(key, str):
            raise ValueError("parameters must use JSON string keys")
        if _is_scalar(value):
            continue
        if isinstance(value, Mapping):
            if not all(isinstance(child_key, str) and _is_scalar(child)
                       for child_key, child in value.items()):
                raise ValueError("parameters permit only one-level JSON containers")
            continue
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            if not all(_is_scalar(child) for child in value):
                raise ValueError("parameters permit only one-level JSON containers")
            continue
        raise ValueError("parameters contain an unsupported JSON value")

    try:
        encoded = json.dumps(
            parameters,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("parameters must be valid JSON") from exc
    if len(encoded) > 4096:
        raise ValueError("parameters must not exceed 4096 encoded bytes (4 KiB)")
    return parameters


def _unsafe_string(value: str) -> bool:
    return any(
        pattern.search(value)
        for pattern in (
            _EMAIL_ADDRESS,
            _WINDOWS_ABSOLUTE_PATH,
            _UNC_PATH,
            _POSIX_ABSOLUTE_PATH,
            _PATH_SEPARATOR,
            _BEARER_TOKEN,
            _SECRET_ASSIGNMENT,
            _PRIVATE_FIXTURE,
            _MEDIA_PATH,
        )
    )


def _parameter_key_tokens(key: str) -> tuple[str, ...]:
    camel_split = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", key)
    camel_split = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", camel_split)
    return tuple(
        token.casefold()
        for token in re.split(r"[^A-Za-z0-9]+", camel_split)
        if token
    )


def _unsafe_parameter_key(key: str) -> bool:
    tokens = _parameter_key_tokens(key)
    if not tokens:
        return False

    has_sensitive_concept = any(
        token in _SENSITIVE_KEY_TOKENS for token in tokens
    )
    has_raw_carrier = any(
        pair in _RAW_CARRIER_TOKEN_PAIRS
        for pair in zip(tokens, tokens[1:])
    )
    if not has_sensitive_concept and not has_raw_carrier:
        return False
    return tokens[-1] not in _STABLE_CONTEXT_METADATA_TOKENS


def _contains_unsafe_parameter(value: Any, *, key: str | None = None) -> bool:
    if key is not None:
        if _unsafe_string(key) or _unsafe_parameter_key(key):
            return True
    if isinstance(value, str):
        stable_metadata = (
            key is not None
            and _parameter_key_tokens(key)
            and _parameter_key_tokens(key)[-1] in _STABLE_CONTEXT_METADATA_TOKENS
        )
        return _unsafe_string(value) or (
            bool(_OPAQUE_BEARER_VALUE.fullmatch(value)) and not stable_metadata
        )
    if isinstance(value, Mapping):
        return any(
            _contains_unsafe_parameter(child, key=child_key)
            for child_key, child in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_unsafe_parameter(child) for child in value)
    return False


def validate_enqueue(command: EnqueueJob) -> EnqueueJob:
    """Validate a producer request before any durable record is written."""

    policy = policy_for(command.kind)
    kind = command.kind.value if isinstance(command.kind, JobKind) else command.kind

    if (
        not isinstance(command.scheduled_at, datetime)
        or command.scheduled_at.tzinfo is None
        or command.scheduled_at.utcoffset() is None
    ):
        raise ValueError("scheduled_at must be a timezone-aware datetime")

    _validate_optional_positive_id("account_id", command.account_id)
    _validate_optional_positive_id("library_id", command.library_id)
    if (
        isinstance(command.priority, bool)
        or not isinstance(command.priority, int)
        or not -32768 <= command.priority <= 32767
    ):
        raise ValueError("priority must fit the Postgres smallint range")
    _validate_optional_revision("scope_version", command.scope_version)
    _validate_optional_revision("resource_revision", command.resource_revision)

    _validate_identifier("subject_kind", command.subject_kind, maximum=128)
    _validate_identifier("subject_ref", command.subject_ref, maximum=1024)
    _validate_identifier("idempotency_key", command.idempotency_key, maximum=1024)
    _validate_identifier(
        "request_origin_ref",
        command.request_origin_ref,
        maximum=1024,
        required=not policy.server_owned,
    )
    _validate_identifier("deployment_mode", command.deployment_mode, maximum=128)
    _validate_identifier("client_surface", command.client_surface, maximum=128)
    _validate_identifier(
        "capability_key", command.capability_key, maximum=128, required=False
    )

    for name, value in (
        ("subject_kind", command.subject_kind),
        ("subject_ref", command.subject_ref),
        ("idempotency_key", command.idempotency_key),
        ("request_origin_ref", command.request_origin_ref),
        ("deployment_mode", command.deployment_mode),
        ("client_surface", command.client_surface),
    ):
        if value is not None and _unsafe_string(value):
            raise ValueError(f"{name} contains unsafe unredacted data")

    parameters = _validate_parameter_shape(command.parameters)
    if _contains_unsafe_parameter(parameters):
        raise ValueError("parameters must contain only redacted parameters")

    if command.max_attempts != policy.max_attempts:
        raise ValueError("max_attempts does not match the registered job policy")

    if policy.server_owned:
        if command.capability_key is not None:
            raise ValueError("server-owned work cannot carry an actor capability")
        if command.library_id is None or not command.subject_ref.strip():
            raise ValueError("server-owned work requires inherited library and subject scope")
        return command

    if policy.public_lifecycle and command.capability_key is None:
        if command.account_id is not None:
            raise ValueError("public lifecycle work cannot synthesize actor ownership")
        return command

    if command.account_id is None:
        raise ValueError("actor-owned work requires an account ownership context")
    if command.capability_key not in policy.allowed_capability_keys:
        raise ValueError("capability is not allowed for this job kind")
    if kind in _LIBRARY_SCOPED_KINDS and command.library_id is None:
        raise ValueError("actor-owned library work requires library ownership")

    return command
