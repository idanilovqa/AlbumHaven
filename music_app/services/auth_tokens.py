"""Opaque-token and keyed-bucket primitives for local authentication."""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import hmac
import re
import secrets


_LOGIN_IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._-]{2,63}", re.ASCII)
_URLSAFE_TOKEN = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
_MINIMUM_TOKEN_BYTES = 32


@dataclass(frozen=True, repr=False)
class IssuedOpaqueToken:
    """A newly issued bearer token and the digest stored for later matching."""

    raw: str
    digest: bytes

    def __repr__(self) -> str:
        return f"{type(self).__name__}(raw=<redacted>, digest=<redacted>)"


@dataclass(frozen=True, repr=False)
class KeyedBucketDigest:
    """A versioned HMAC digest suitable for privacy-preserving throttle keys."""

    key_version: int
    digest: bytes

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(key_version={self.key_version!r}, "
            "digest=<redacted>)"
        )


def issue_opaque_token(
    *,
    byte_count: int = _MINIMUM_TOKEN_BYTES,
    random_bytes: Callable[[int], bytes] = secrets.token_bytes,
) -> IssuedOpaqueToken:
    """Issue an unpadded URL-safe bearer token backed by sufficient entropy."""

    if isinstance(byte_count, bool) or not isinstance(byte_count, int):
        raise ValueError("Unable to issue secure token")
    if byte_count < _MINIMUM_TOKEN_BYTES or not callable(random_bytes):
        raise ValueError("Unable to issue secure token")

    try:
        entropy = random_bytes(byte_count)
    except Exception:
        raise ValueError("Unable to issue secure token") from None
    if not isinstance(entropy, bytes) or len(entropy) != byte_count:
        raise ValueError("Unable to issue secure token")

    raw = base64.urlsafe_b64encode(entropy).decode("ascii").rstrip("=")
    return IssuedOpaqueToken(raw=raw, digest=hashlib.sha256(raw.encode("ascii")).digest())


def _validated_raw_token(raw: object) -> str:
    if not isinstance(raw, str) or not _URLSAFE_TOKEN.fullmatch(raw):
        raise ValueError("Invalid token")
    try:
        encoded = raw.encode("ascii")
        padding = b"=" * (-len(encoded) % 4)
        decoded = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
    except (UnicodeEncodeError, ValueError):
        raise ValueError("Invalid token") from None
    if len(decoded) < _MINIMUM_TOKEN_BYTES:
        raise ValueError("Invalid token")
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != raw:
        raise ValueError("Invalid token")
    return raw


def hash_opaque_token(raw: str) -> bytes:
    """Hash a canonical raw opaque token without retaining the bearer value."""

    validated = _validated_raw_token(raw)
    return hashlib.sha256(validated.encode("ascii")).digest()


def matches_opaque_token(raw: object, expected_digest: object) -> bool:
    """Constant-time compare a raw token to a stored SHA-256 digest."""

    if not isinstance(expected_digest, bytes) or len(expected_digest) != 32:
        return False
    try:
        actual_digest = hash_opaque_token(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(actual_digest, expected_digest)


def _length_prefixed(value: bytes) -> bytes:
    return len(value).to_bytes(8, "big") + value


def keyed_bucket_digest(
    *,
    secret: bytes,
    key_version: int,
    domain: str,
    normalized_value: str,
) -> KeyedBucketDigest:
    """Return a domain-separated HMAC digest for a normalized private value."""

    if (
        not isinstance(secret, bytes)
        or len(secret) < 32
        or isinstance(key_version, bool)
        or not isinstance(key_version, int)
        or key_version < 1
        or not isinstance(domain, str)
        or not domain
        or not isinstance(normalized_value, str)
        or not normalized_value
    ):
        raise ValueError("Invalid bucket input")
    try:
        version_bytes = str(key_version).encode("ascii")
        domain_bytes = domain.encode("utf-8")
        value_bytes = normalized_value.encode("utf-8")
        message = b"".join(
            _length_prefixed(part)
            for part in (version_bytes, domain_bytes, value_bytes)
        )
    except (UnicodeEncodeError, OverflowError):
        raise ValueError("Invalid bucket input") from None

    digest = hmac.new(secret, message, hashlib.sha256).digest()
    return KeyedBucketDigest(key_version=key_version, digest=digest)


def normalize_login_identifier(entered: object) -> str:
    """Normalize a strict ASCII username accepted by the login boundary."""

    if not isinstance(entered, str):
        raise ValueError("Invalid login identifier")
    normalized = entered.lower()
    if not _LOGIN_IDENTIFIER.fullmatch(normalized):
        raise ValueError("Invalid login identifier")
    return normalized
