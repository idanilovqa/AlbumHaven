from __future__ import annotations

from importlib import import_module, util
import unicodedata

from argon2 import PasswordHasher
from argon2.low_level import Type, hash_secret
import pytest


MODULE = "music_app.services.auth_passwords"
ARGON2_FLOOR = {
    "memory_cost": 65_536,
    "time_cost": 3,
    "parallelism": 1,
    "salt_len": 16,
    "hash_len": 32,
}
CURRENT_POLICY_VERSION = 3


def test_password_policy_contract_is_present():
    try:
        module = import_module(MODULE)
    except ModuleNotFoundError as exc:
        pytest.fail(f"Phase 7 password policy contract is not implemented: {exc}")

    assert callable(module.validate_password)
    assert callable(module.hash_password)
    assert callable(module.verify_password)
    assert module.PasswordPolicyError.__mro__[1] is ValueError


@pytest.fixture
def passwords():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


def _validate(passwords, raw: str, **overrides):
    arguments = {
        "username": "Rendref",
        "email": "rendref+music@example.test",
        "breached_checker": lambda _candidate: False,
    }
    arguments.update(overrides)
    return passwords.validate_password(raw, **arguments)


def _hash(passwords, raw: str, **overrides):
    arguments = {
        "username": "Rendref",
        "email": "rendref+music@example.test",
        "breached_checker": lambda _candidate: False,
        "argon2": ARGON2_FLOOR,
        "policy_version": CURRENT_POLICY_VERSION,
    }
    arguments.update(overrides)
    return passwords.hash_password(raw, **arguments)


def _argon2_hash(
    raw: str,
    *,
    memory_cost: int = 65_536,
    time_cost: int = 3,
    parallelism: int = 1,
    salt_len: int = 16,
    hash_len: int = 32,
) -> str:
    return PasswordHasher(
        memory_cost=memory_cost,
        time_cost=time_cost,
        parallelism=parallelism,
        salt_len=salt_len,
        hash_len=hash_len,
        type=Type.ID,
    ).hash(raw)


def test_validation_normalizes_to_nfc_before_breach_check(passwords):
    decomposed = "Cafe\u0301-Long-Secret-2026"
    observed: list[str] = []

    normalized = _validate(
        passwords,
        decomposed,
        breached_checker=lambda candidate: observed.append(candidate) or False,
    )

    assert normalized == unicodedata.normalize("NFC", decomposed)
    assert observed == [normalized]


def test_hashing_uses_the_same_nfc_value_that_validation_returns(passwords):
    decomposed = "Cafe\u0301-Long-Secret-2026"
    normalized = unicodedata.normalize("NFC", decomposed)

    credential = _hash(passwords, decomposed)

    assert credential.policy_version == CURRENT_POLICY_VERSION
    assert PasswordHasher().verify(credential.encoded_hash, normalized)


@pytest.mark.parametrize(
    "candidate",
    [
        "x" * 14,
        "x" * 257,
        "\U0001f642" * 257,
        ("\U0001f642" * 256) + "x",
    ],
)
def test_validation_rejects_passwords_outside_codepoint_or_utf8_bounds(
    passwords, candidate
):
    with pytest.raises(passwords.PasswordPolicyError):
        _validate(passwords, candidate)


@pytest.mark.parametrize(
    "candidate",
    [
        " leading-space-password",
        "trailing-space-password ",
        "lowercase-only-password",
        "123456789012345",
        "!!!!!!!!!!!!!!!",
        "all words with spaces",
    ],
)
def test_validation_preserves_the_password_and_has_no_composition_rules(
    passwords, candidate
):
    assert _validate(passwords, candidate) == candidate


def test_validation_never_casefolds_password_material(passwords):
    candidate = "Stra\u00dfe-Secret-Value"

    assert _validate(passwords, candidate) == candidate


def test_validation_rejects_a_built_in_common_password(passwords):
    with pytest.raises(passwords.PasswordPolicyError, match="not allowed"):
        _validate(passwords, "passwordpassword")


@pytest.mark.parametrize(
    "candidate",
    [
        "password password",
        "password-password",
        " P.a.s.s.w.o.r.d.P.a.s.s.w.o.r.d ",
    ],
)
def test_validation_rejects_compact_variants_of_common_passwords(
    passwords, candidate
):
    with pytest.raises(passwords.PasswordPolicyError, match="not allowed"):
        _validate(passwords, candidate)


def test_validation_rejects_a_password_reported_by_the_injected_breach_checker(
    passwords,
):
    candidate = "unique-looking-secret-2026"
    observed: list[str] = []

    with pytest.raises(passwords.PasswordPolicyError, match="not allowed"):
        _validate(
            passwords,
            candidate,
            breached_checker=lambda value: observed.append(value) or True,
        )

    assert observed == [candidate]


@pytest.mark.parametrize(
    "candidate",
    [
        "Rendref-private-secret",
        "music-rendref+music@example.test",
        "my-Album-Haven-password",
    ],
)
def test_validation_rejects_username_email_or_product_context(passwords, candidate):
    with pytest.raises(passwords.PasswordPolicyError, match="not allowed"):
        _validate(passwords, candidate)


@pytest.mark.parametrize(
    ("username", "email", "candidate"),
    [
        (
            "Cafe\u0301User",
            "owner@example.test",
            "private-Caf\u00e9User-secret",
        ),
        (
            "unrelated-user",
            "cafe\u0301.owner@example.test",
            "private-caf\u00e9.owner-secret",
        ),
    ],
)
def test_validation_nfc_normalizes_identity_context_before_comparison(
    passwords, username, email, candidate
):
    with pytest.raises(passwords.PasswordPolicyError, match="not allowed"):
        _validate(passwords, candidate, username=username, email=email)


def test_hash_password_returns_argon2id_and_policy_version_separately(passwords):
    credential = _hash(passwords, "a-valid-unique-secret")

    assert credential.encoded_hash.startswith(
        "$argon2id$v=19$m=65536,t=3,p=1$"
    )
    assert credential.policy_version == CURRENT_POLICY_VERSION
    assert "policy_version" not in credential.encoded_hash


def test_hash_password_uses_the_configured_floor_salt_and_hash_lengths(passwords):
    credential = _hash(passwords, "another-valid-unique-secret")
    _prefix, _algorithm, _version, _parameters, salt, digest = (
        credential.encoded_hash.split("$")
    )

    # Argon2 uses unpadded base64: 16-byte salt -> 22 chars, 32-byte hash -> 43.
    assert len(salt) == 22
    assert len(digest) == 43


def test_hash_result_repr_redacts_the_encoded_hash(passwords):
    credential = _hash(passwords, "repr-safe-unique-secret")

    assert credential.encoded_hash not in repr(credential)
    assert "repr-safe-unique-secret" not in repr(credential)


def test_verify_password_accepts_the_correct_password(passwords):
    credential = _hash(passwords, "verify-correct-unique-secret")

    result = passwords.verify_password(
        "verify-correct-unique-secret",
        credential.encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is False


def test_verify_password_normalizes_canonically_equivalent_input_to_nfc(passwords):
    normalized = "Caf\u00e9-verify-unique-secret"
    decomposed = unicodedata.normalize("NFD", normalized)
    encoded_hash = _argon2_hash(normalized)

    result = passwords.verify_password(
        decomposed,
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is False


def test_verify_password_rejects_a_wrong_password_without_raising(passwords):
    encoded_hash = _argon2_hash("correct-unique-secret")

    result = passwords.verify_password(
        "wrong-unique-secret",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is False
    assert result.needs_rehash is False


@pytest.mark.parametrize("raw", [None, b"candidate-secret", 42])
def test_verify_password_rejects_non_string_candidates_without_raising(
    passwords, raw
):
    result = passwords.verify_password(
        raw,
        _argon2_hash("candidate-secret-value"),
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is False
    assert result.needs_rehash is False


@pytest.mark.parametrize("encoded_hash", [None, b"not-a-text-hash", 42])
def test_verify_password_rejects_non_string_hashes_without_raising(
    passwords, encoded_hash
):
    result = passwords.verify_password(
        "candidate-secret-value",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is False
    assert result.needs_rehash is False


@pytest.mark.parametrize("encoded_hash", ["", "not-an-argon2-hash", "$argon2id$bad"])
def test_verify_password_rejects_malformed_hashes_without_raising(
    passwords, encoded_hash
):
    result = passwords.verify_password(
        "candidate-secret-value",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is False
    assert result.needs_rehash is False


def test_verify_password_requires_rehash_for_an_older_policy_version(passwords):
    encoded_hash = _argon2_hash("older-policy-secret")

    result = passwords.verify_password(
        "older-policy-secret",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION - 1,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is True


def test_verify_password_accepts_argon2_version_16_but_requires_rehash(passwords):
    raw = "argon2-version-16-secret"
    encoded_hash = hash_secret(
        raw.encode("utf-8"),
        b"0123456789abcdef",
        time_cost=ARGON2_FLOOR["time_cost"],
        memory_cost=ARGON2_FLOOR["memory_cost"],
        parallelism=ARGON2_FLOOR["parallelism"],
        hash_len=ARGON2_FLOOR["hash_len"],
        type=Type.ID,
        version=16,
    ).decode("ascii")

    result = passwords.verify_password(
        raw,
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is True


@pytest.mark.parametrize(
    "weaker",
    [
        {"memory_cost": 32_768},
        {"time_cost": 2},
        {"salt_len": 8},
        {"hash_len": 16},
    ],
)
def test_verify_password_requires_rehash_for_any_weaker_argon2_parameter(
    passwords, weaker
):
    parameters = dict(ARGON2_FLOOR)
    parameters.update(weaker)
    encoded_hash = _argon2_hash("weaker-parameter-secret", **parameters)

    result = passwords.verify_password(
        "weaker-parameter-secret",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is True


def test_verify_password_accepts_equal_or_stronger_argon2_parameters(passwords):
    encoded_hash = _argon2_hash(
        "stronger-parameter-secret",
        memory_cost=65_536,
        time_cost=4,
        parallelism=2,
        salt_len=24,
        hash_len=48,
    )

    result = passwords.verify_password(
        "stronger-parameter-secret",
        encoded_hash,
        stored_policy_version=CURRENT_POLICY_VERSION,
        argon2=ARGON2_FLOOR,
        current_policy_version=CURRENT_POLICY_VERSION,
    )

    assert result.valid is True
    assert result.needs_rehash is False


def test_policy_errors_do_not_disclose_passwords_in_message_or_repr(passwords):
    candidate = "private-breached-value"

    with pytest.raises(passwords.PasswordPolicyError) as captured:
        _validate(passwords, candidate, breached_checker=lambda _value: True)

    assert candidate not in str(captured.value)
    assert candidate not in repr(captured.value)
    assert captured.value.__cause__ is None


def test_breach_checker_errors_are_generic_and_do_not_disclose_passwords(passwords):
    candidate = "private-checker-error-value"

    def broken_checker(_value: str) -> bool:
        raise RuntimeError(f"provider rejected {_value}")

    with pytest.raises(passwords.PasswordPolicyError) as captured:
        _validate(passwords, candidate, breached_checker=broken_checker)

    assert candidate not in str(captured.value)
    assert candidate not in repr(captured.value)
