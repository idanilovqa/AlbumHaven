"""Password validation, hashing, and verification for local authentication."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import unicodedata

from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from argon2.low_level import ARGON2_VERSION, Type


_MIN_CODEPOINTS = 8
_MAX_CODEPOINTS = 256
_MAX_UTF8_BYTES = 1_024

# Deliberately small: comprehensive breach screening belongs to the injected
# checker, while this list rejects ubiquitous choices even if it is unavailable.
_COMMON_PASSWORDS = frozenset(
    {
        "passwordpassword",
        "password123456",
        "qwertyqwertyqwerty",
    }
)


class PasswordPolicyError(ValueError):
    """A password cannot be accepted under the current policy."""


@dataclass(frozen=True, repr=False)
class PasswordCredential:
    """A stored password hash and its separately versioned policy."""

    encoded_hash: str
    policy_version: int

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(encoded_hash='<redacted>', "
            f"policy_version={self.policy_version!r})"
        )


@dataclass(frozen=True)
class PasswordVerification:
    """The non-throwing result of a credential verification attempt."""

    valid: bool
    needs_rehash: bool


def _context_fragments(username: str, email: str) -> tuple[str, ...]:
    normalized_username = unicodedata.normalize("NFC", username).casefold()
    normalized_email = unicodedata.normalize("NFC", email).casefold()
    email_local, separator, email_domain = normalized_email.rpartition("@")
    if not separator:
        email_local = normalized_email
        email_domain = ""
    return (
        normalized_username,
        normalized_email,
        email_local,
        email_domain,
        "album haven",
        "album-haven",
        "album_haven",
        "albumhaven",
    )


def _compact(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


_COMPACT_COMMON_PASSWORDS = frozenset(map(_compact, _COMMON_PASSWORDS))


def validate_password(
    raw: str,
    *,
    username: str,
    email: str,
    breached_checker: Callable[[str], bool],
) -> str:
    """Validate and return the NFC password without trimming or case changes."""

    normalized = unicodedata.normalize("NFC", raw)
    if not _MIN_CODEPOINTS <= len(normalized) <= _MAX_CODEPOINTS:
        raise PasswordPolicyError("Password length is outside the allowed range")
    if len(normalized.encode("utf-8")) > _MAX_UTF8_BYTES:
        raise PasswordPolicyError("Password length is outside the allowed range")

    folded = normalized.casefold()
    context_fragments = _context_fragments(username, email)
    compacted = _compact(normalized)
    if (
        folded in _COMMON_PASSWORDS
        or compacted in _COMPACT_COMMON_PASSWORDS
        or any(fragment and fragment in folded for fragment in context_fragments)
        or any(
            len(compact_fragment) >= 3 and compact_fragment in compacted
            for compact_fragment in map(_compact, context_fragments)
        )
    ):
        raise PasswordPolicyError("This password is not allowed")

    try:
        breached = breached_checker(normalized)
    except Exception:
        raise PasswordPolicyError("Password screening could not be completed") from None
    if breached:
        raise PasswordPolicyError("This password is not allowed")
    return normalized


def _hasher(argon2: Mapping[str, int]) -> PasswordHasher:
    return PasswordHasher(
        memory_cost=argon2["memory_cost"],
        time_cost=argon2["time_cost"],
        parallelism=argon2["parallelism"],
        salt_len=argon2["salt_len"],
        hash_len=argon2["hash_len"],
        type=Type.ID,
    )


def hash_password(
    raw: str,
    *,
    username: str,
    email: str,
    breached_checker: Callable[[str], bool],
    argon2: Mapping[str, int],
    policy_version: int,
) -> PasswordCredential:
    """Validate a password and hash its normalized value with Argon2id."""

    normalized = validate_password(
        raw,
        username=username,
        email=email,
        breached_checker=breached_checker,
    )
    return PasswordCredential(
        encoded_hash=_hasher(argon2).hash(normalized),
        policy_version=policy_version,
    )


def rehash_verified_password(
    raw: str,
    *,
    argon2: Mapping[str, int],
    policy_version: int,
) -> PasswordCredential:
    """Rehash an already-verified password under the current Argon2id policy."""

    if (
        not isinstance(raw, str)
        or isinstance(policy_version, bool)
        or not isinstance(policy_version, int)
        or policy_version < 1
        or not isinstance(argon2, Mapping)
    ):
        raise ValueError("Unable to rehash verified password")
    try:
        normalized = unicodedata.normalize("NFC", raw)
        encoded_hash = _hasher(argon2).hash(normalized)
    except Exception:
        raise ValueError("Unable to rehash verified password") from None
    return PasswordCredential(
        encoded_hash=encoded_hash,
        policy_version=policy_version,
    )


def _parameters_meet_floor(encoded_hash: str, floor: Mapping[str, int]) -> bool:
    parameters = extract_parameters(encoded_hash)
    return (
        parameters.type is Type.ID
        and parameters.version == ARGON2_VERSION
        and parameters.memory_cost >= floor["memory_cost"]
        and parameters.time_cost >= floor["time_cost"]
        and parameters.parallelism >= floor["parallelism"]
        and parameters.salt_len >= floor["salt_len"]
        and parameters.hash_len >= floor["hash_len"]
    )


def verify_password(
    raw: str,
    encoded_hash: str,
    *,
    stored_policy_version: int,
    argon2: Mapping[str, int],
    current_policy_version: int,
) -> PasswordVerification:
    """Verify a candidate and report whether a valid credential needs upgrade."""

    if not isinstance(raw, str) or not isinstance(encoded_hash, str):
        return PasswordVerification(valid=False, needs_rehash=False)

    normalized = unicodedata.normalize("NFC", raw)
    hasher = _hasher(argon2)
    try:
        valid = hasher.verify(encoded_hash, normalized)
        meets_floor = _parameters_meet_floor(encoded_hash, argon2)
    except (InvalidHashError, VerificationError, VerifyMismatchError, ValueError):
        return PasswordVerification(valid=False, needs_rehash=False)

    if not valid:
        return PasswordVerification(valid=False, needs_rehash=False)
    return PasswordVerification(
        valid=True,
        needs_rehash=(
            stored_policy_version < current_policy_version or not meets_floor
        ),
    )
