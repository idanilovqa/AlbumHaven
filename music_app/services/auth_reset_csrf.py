"""CSRF derivation bound only to a short-lived reset transaction."""

from __future__ import annotations

import base64
from collections.abc import Mapping
import hmac

from music_app.services.auth_tokens import hash_opaque_token, keyed_bucket_digest


_DOMAIN = "password-reset-csrf"


def issue_reset_csrf(
    raw_transaction: object,
    config: Mapping[str, object] | None,
) -> str:
    transaction = _validated_transaction(raw_transaction)
    secret, key_version = _policy(config)
    digest = keyed_bucket_digest(
        secret=secret,
        key_version=key_version,
        domain=_DOMAIN,
        normalized_value=transaction,
    ).digest
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def matches_reset_csrf(
    raw_transaction: object,
    supplied_csrf: object,
    config: Mapping[str, object] | None,
) -> bool:
    if not isinstance(supplied_csrf, str):
        return False
    try:
        hash_opaque_token(supplied_csrf)
        expected = issue_reset_csrf(raw_transaction, config)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(supplied_csrf, expected)


def _validated_transaction(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Reset CSRF input is invalid.")
    try:
        hash_opaque_token(value)
    except (TypeError, ValueError):
        raise ValueError("Reset CSRF input is invalid.") from None
    return value


def _policy(config: Mapping[str, object] | None) -> tuple[bytes, int]:
    payload = config if isinstance(config, Mapping) else {}
    hmac_value = payload.get("hmac")
    policy = hmac_value if isinstance(hmac_value, Mapping) else {}
    secret_value = policy.get("secret")
    key_version = policy.get("key_version")
    if not isinstance(secret_value, str):
        raise ValueError("Reset CSRF policy is invalid.")
    try:
        secret = secret_value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Reset CSRF policy is invalid.") from None
    if (
        len(secret) < 32
        or isinstance(key_version, bool)
        or not isinstance(key_version, int)
        or key_version < 1
    ):
        raise ValueError("Reset CSRF policy is invalid.")
    return secret, key_version
