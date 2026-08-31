"""Session-bound CSRF tokens for cookie-authenticated mutations."""

from __future__ import annotations

import base64
from collections.abc import Mapping
import hmac

from music_app.services.auth_tokens import hash_opaque_token, keyed_bucket_digest


_DOMAIN = "session-csrf"


def issue_session_csrf(
    raw_session_token: object,
    config: Mapping[str, object] | None,
) -> str:
    """Derive a public CSRF value from one valid opaque session token."""

    session = _validated_session(raw_session_token)
    secret, key_version = _policy(config)
    digest = keyed_bucket_digest(
        secret=secret,
        key_version=key_version,
        domain=_DOMAIN,
        normalized_value=session,
    ).digest
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def matches_session_csrf(
    raw_session_token: object,
    supplied_csrf_token: object,
    config: Mapping[str, object] | None,
) -> bool:
    """Validate a canonical CSRF value in constant time for this session."""

    if not isinstance(supplied_csrf_token, str):
        return False
    try:
        hash_opaque_token(supplied_csrf_token)
        expected = issue_session_csrf(raw_session_token, config)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(supplied_csrf_token, expected)


def _validated_session(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Session CSRF input is invalid.")
    try:
        hash_opaque_token(value)
    except (TypeError, ValueError):
        raise ValueError("Session CSRF input is invalid.") from None
    return value


def _policy(
    config: Mapping[str, object] | None,
) -> tuple[bytes, int]:
    payload = config if isinstance(config, Mapping) else {}
    hmac_payload = payload.get("hmac")
    policy = hmac_payload if isinstance(hmac_payload, Mapping) else {}
    secret_value = policy.get("secret")
    key_version = policy.get("key_version")
    if not isinstance(secret_value, str):
        raise ValueError("Session CSRF policy is invalid.")
    try:
        secret = secret_value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Session CSRF policy is invalid.") from None
    if len(secret) < 32 or isinstance(key_version, bool) or not isinstance(
        key_version, int
    ) or key_version < 1:
        raise ValueError("Session CSRF policy is invalid.")
    return secret, key_version
