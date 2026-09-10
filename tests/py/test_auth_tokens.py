from __future__ import annotations

import base64
import hashlib
from importlib import import_module, util

import pytest


MODULE = "music_app.services.auth_tokens"
VALID_RAW = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii").rstrip("=")


def test_auth_token_contract_is_present():
    try:
        auth_tokens = import_module(MODULE)
    except ModuleNotFoundError as exc:
        pytest.fail(f"Phase 7 token contract is not implemented: {exc}")

    assert callable(auth_tokens.issue_opaque_token)
    assert callable(auth_tokens.hash_opaque_token)
    assert callable(auth_tokens.matches_opaque_token)
    assert callable(auth_tokens.keyed_bucket_digest)
    assert callable(auth_tokens.normalize_login_identifier)


@pytest.fixture
def tokens():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


def test_opaque_token_uses_injected_256_bit_entropy_and_returns_unpadded_urlsafe_text(tokens):
    requested_sizes: list[int] = []
    entropy = bytes(range(32))

    issued = tokens.issue_opaque_token(
        random_bytes=lambda size: requested_sizes.append(size) or entropy
    )

    assert requested_sizes == [32]
    assert issued.raw == base64.urlsafe_b64encode(entropy).decode("ascii").rstrip("=")
    assert "=" not in issued.raw
    assert set(issued.raw) <= set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    assert issued.digest == hashlib.sha256(issued.raw.encode("ascii")).digest()
    assert len(issued.digest) == 32


def test_opaque_token_rejects_short_or_non_bytes_entropy(tokens):
    with pytest.raises(ValueError, match="Unable to issue secure token"):
        tokens.issue_opaque_token(random_bytes=lambda _size: b"x" * 31)

    with pytest.raises(ValueError, match="Unable to issue secure token"):
        tokens.issue_opaque_token(random_bytes=lambda _size: "x" * 32)


def test_opaque_token_allows_a_larger_entropy_request_but_never_less_than_32_bytes(tokens):
    requested_sizes: list[int] = []

    issued = tokens.issue_opaque_token(
        byte_count=48,
        random_bytes=lambda size: requested_sizes.append(size) or b"x" * size,
    )

    assert requested_sizes == [48]
    assert len(base64.urlsafe_b64decode(issued.raw + "==")) == 48
    with pytest.raises(ValueError, match="Unable to issue secure token"):
        tokens.issue_opaque_token(byte_count=31, random_bytes=lambda _size: b"x" * 31)


def test_opaque_token_repr_discloses_neither_raw_token_nor_digest(tokens):
    issued = tokens.issue_opaque_token(random_bytes=lambda _size: b"z" * 32)

    rendered = repr(issued)

    assert issued.raw not in rendered
    assert issued.digest.hex() not in rendered
    assert "redacted" in rendered.lower()


def test_hash_opaque_token_is_sha256_of_exact_raw_ascii_token(tokens):
    raw = VALID_RAW

    assert tokens.hash_opaque_token(raw) == hashlib.sha256(raw.encode("ascii")).digest()


@pytest.mark.parametrize("raw", ["", "abc", " padded", "padded ", "not+urlsafe", "caf\N{LATIN SMALL LETTER E WITH ACUTE}", "line\nbreak"])
def test_hash_opaque_token_rejects_malformed_raw_values_without_echoing_them(tokens, raw):
    with pytest.raises(ValueError, match="Invalid token") as exc_info:
        tokens.hash_opaque_token(raw)

    if raw:
        assert raw not in str(exc_info.value)


def test_token_match_uses_constant_time_digest_comparison(tokens, monkeypatch):
    calls: list[tuple[bytes, bytes]] = []

    def recording_compare(left: bytes, right: bytes) -> bool:
        calls.append((left, right))
        return left == right

    monkeypatch.setattr(tokens.hmac, "compare_digest", recording_compare)
    raw = VALID_RAW
    expected = hashlib.sha256(raw.encode("ascii")).digest()

    assert tokens.matches_opaque_token(raw, expected) is True
    assert calls == [(expected, expected)]


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("bad token", b"x" * 32),
        (VALID_RAW, b"short"),
        (VALID_RAW, "not-bytes"),
        (None, b"x" * 32),
    ],
)
def test_token_match_treats_malformed_material_as_a_safe_non_match(tokens, raw, expected):
    assert tokens.matches_opaque_token(raw, expected) is False


def test_keyed_bucket_digest_is_versioned_domain_separated_hmac_sha256(tokens):
    secret = b"s" * 32

    bucket = tokens.keyed_bucket_digest(
        secret=secret,
        key_version=7,
        domain="login-candidate",
        normalized_value="rendref",
    )

    assert bucket.key_version == 7
    assert isinstance(bucket.digest, bytes)
    assert len(bucket.digest) == 32
    assert bucket.digest != hashlib.sha256(b"rendref").digest()
    assert bucket.digest == tokens.keyed_bucket_digest(
        secret=secret,
        key_version=7,
        domain="login-candidate",
        normalized_value="rendref",
    ).digest
    assert bucket.digest != tokens.keyed_bucket_digest(
        secret=secret,
        key_version=8,
        domain="login-candidate",
        normalized_value="rendref",
    ).digest
    assert bucket.digest != tokens.keyed_bucket_digest(
        secret=secret,
        key_version=7,
        domain="reset-candidate",
        normalized_value="rendref",
    ).digest


def test_keyed_bucket_framing_prevents_delimiter_collisions(tokens):
    secret = b"k" * 32

    left = tokens.keyed_bucket_digest(
        secret=secret, key_version=1, domain="a", normalized_value="b:c"
    )
    right = tokens.keyed_bucket_digest(
        secret=secret, key_version=1, domain="a:b", normalized_value="c"
    )

    assert left.digest != right.digest


@pytest.mark.parametrize(
    "kwargs",
    [
        {"secret": b"short", "key_version": 1, "domain": "login", "normalized_value": "rendref"},
        {"secret": b"s" * 32, "key_version": 0, "domain": "login", "normalized_value": "rendref"},
        {"secret": b"s" * 32, "key_version": 1, "domain": "", "normalized_value": "rendref"},
        {"secret": b"s" * 32, "key_version": 1, "domain": "login", "normalized_value": ""},
    ],
)
def test_keyed_bucket_rejects_invalid_inputs_with_non_disclosing_error(tokens, kwargs):
    with pytest.raises(ValueError, match="Invalid bucket input") as exc_info:
        tokens.keyed_bucket_digest(**kwargs)

    rendered = str(exc_info.value)
    assert "short" not in rendered
    assert "rendref" not in rendered
    assert (b"s" * 32).hex() not in rendered


def test_bucket_repr_does_not_disclose_secret_candidate_or_digest(tokens):
    secret = b"private-server-secret-material!!"
    candidate = "sensitive-candidate"
    bucket = tokens.keyed_bucket_digest(
        secret=secret,
        key_version=3,
        domain="login-candidate",
        normalized_value=candidate,
    )

    rendered = repr(bucket)

    assert secret.decode("ascii") not in rendered
    assert candidate not in rendered
    assert bucket.digest.hex() not in rendered
    assert "redacted" in rendered.lower()


@pytest.mark.parametrize(
    "entered, expected",
    [
        ("Rendref", "rendref"),
        ("USER.Name_2-Test", "user.name_2-test"),
        ("abc", "abc"),
        ("a" + "b" * 63, "a" + "b" * 63),
    ],
)
def test_login_identifier_normalization_is_ascii_and_case_insensitive(tokens, entered, expected):
    assert tokens.normalize_login_identifier(entered) == expected


@pytest.mark.parametrize(
    "entered",
    [
        "ab",
        "a" + "b" * 64,
        "_rendref",
        "rendref@home",
        "rend ref",
        " rendref",
        "rendref ",
        "r\N{LATIN SMALL LETTER E WITH ACUTE}ndref",
        "rendref\n",
        "rendref\x00",
        "",
        None,
    ],
)
def test_login_identifier_rejection_is_generic_and_does_not_echo_input(tokens, entered):
    with pytest.raises(ValueError, match="Invalid login identifier") as exc_info:
        tokens.normalize_login_identifier(entered)

    if isinstance(entered, str) and entered:
        assert entered not in str(exc_info.value)
