from __future__ import annotations

import hashlib
from importlib import import_module, util

import pytest


MODULE = "music_app.services.auth_breached_passwords"
PASSWORD = "correct horse battery staple!"
SHA1 = hashlib.sha1(PASSWORD.encode("utf-8"), usedforsecurity=False).hexdigest().upper()
PREFIX, SUFFIX = SHA1[:5], SHA1[5:]
USER_AGENT = "Album-Haven-Password-Screen/1.0"


def test_breached_password_checker_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 breached-password checker: "
        "music_app/services/auth_breached_passwords.py"
    )


@pytest.fixture
def breached_passwords():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class FakeResponse:
    def __init__(self, body: bytes, *, status=200, final_url=None):
        self.body = body
        self.status = status
        self.final_url = final_url
        self.read_limits: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, limit: int = -1) -> bytes:
        self.read_limits.append(limit)
        return self.body if limit < 0 else self.body[:limit]

    def getcode(self):
        return self.status

    def geturl(self):
        return self.final_url


class RecordingOpener:
    def __init__(self, body: bytes = b"", *, status=200, final_url=None):
        self.response = FakeResponse(body, status=status, final_url=final_url)
        self.calls = []
        self.failure: Exception | None = None

    def __call__(self, request, *, timeout):
        self.calls.append((request, timeout))
        if self.failure is not None:
            raise self.failure
        if self.response.final_url is None:
            self.response.final_url = request.full_url
        return self.response


def _checker(module, opener, *, timeout=3.0):
    return module.HibpRangePasswordChecker(opener=opener, timeout_seconds=timeout)


@pytest.mark.parametrize("count", ["1", "981273"])
def test_checker_uses_sha1_prefix_k_anonymity_and_required_headers(
    breached_passwords, count
):
    opener = RecordingOpener(f"{SUFFIX}:{count}\r\n{'A' * 35}:0\r\n".encode("ascii"))

    assert _checker(breached_passwords, opener)(PASSWORD) is True

    request, timeout = opener.calls[0]
    assert request.full_url == f"https://api.pwnedpasswords.com/range/{PREFIX}"
    headers = {key.casefold(): value for key, value in request.header_items()}
    assert headers["add-padding"].casefold() == "true"
    assert headers["user-agent"] == USER_AGENT
    assert timeout == 3.0
    assert PASSWORD not in request.full_url
    assert SHA1 not in request.full_url


def test_checker_returns_false_for_a_strict_valid_nonmatch(breached_passwords):
    opener = RecordingOpener(f"{'A' * 35}:12\n{'B' * 35}:0\n".encode("ascii"))

    assert _checker(breached_passwords, opener)(PASSWORD) is False


def test_suffix_comparisons_do_not_short_circuit_after_match(
    breached_passwords, monkeypatch
):
    comparisons = []
    original = breached_passwords.hmac.compare_digest

    def recording_compare(left, right):
        comparisons.append((left, right))
        return original(left, right)

    monkeypatch.setattr(breached_passwords.hmac, "compare_digest", recording_compare)
    opener = RecordingOpener(
        f"{SUFFIX}:2\n{'A' * 35}:9\n{'B' * 35}:0\n".encode("ascii")
    )

    assert _checker(breached_passwords, opener)(PASSWORD) is True
    assert len(comparisons) == 3


@pytest.mark.parametrize("timeout", [0, -1, 5.01, True, "3"])
def test_checker_rejects_unbounded_or_invalid_timeout(breached_passwords, timeout):
    with pytest.raises(ValueError, match="configuration"):
        _checker(breached_passwords, RecordingOpener(), timeout=timeout)


def test_range_url_override_allows_only_official_service_or_loopback(
    breached_passwords,
):
    breached_passwords.HibpRangePasswordChecker(
        range_url_template="https://api.pwnedpasswords.com/range/{}"
    )
    breached_passwords.HibpRangePasswordChecker(
        range_url_template="http://127.0.0.1:6182/range/{}"
    )
    with pytest.raises(ValueError, match="HTTPS outside loopback"):
        breached_passwords.HibpRangePasswordChecker(
            range_url_template="http://password-screen.example/range/{}"
        )
    with pytest.raises(ValueError, match="official service or loopback"):
        breached_passwords.HibpRangePasswordChecker(
            range_url_template="https://password-screen.example/range/{}"
        )
    for invalid in (
        "https://password-screen.example/range/static",
        "https://user:secret@password-screen.example/range/{}",
        "https://password-screen.example/range/{}?leak=true",
    ):
        with pytest.raises(ValueError, match="template is invalid"):
            breached_passwords.HibpRangePasswordChecker(
                range_url_template=invalid
            )


@pytest.mark.parametrize(
    "body",
    [
        b"not-a-suffix:1\n",
        f"{SUFFIX}:not-a-count\n".encode("ascii"),
        f"{SUFFIX}:-1\n".encode("ascii"),
        f"{SUFFIX}:1:2\n".encode("ascii"),
        f"{SUFFIX.lower()}:1\n".encode("ascii"),
        f"{SUFFIX}:1\n{SUFFIX}:2\n".encode("ascii"),
        b"\xff:1\n",
        b"",
    ],
)
def test_malformed_or_ambiguous_range_response_fails_closed(
    breached_passwords, body
):
    with pytest.raises(
        breached_passwords.BreachedPasswordCheckError,
        match="screening unavailable",
    ):
        _checker(breached_passwords, RecordingOpener(body))(PASSWORD)


def test_network_failure_is_generic_and_does_not_expose_password(breached_passwords):
    opener = RecordingOpener()
    opener.failure = OSError(f"network failed for {PASSWORD}")

    with pytest.raises(breached_passwords.BreachedPasswordCheckError) as caught:
        _checker(breached_passwords, opener)(PASSWORD)

    assert PASSWORD not in str(caught.value)


@pytest.mark.parametrize(
    ("status", "final_url"),
    [
        (503, f"https://api.pwnedpasswords.com/range/{PREFIX}"),
        (200, f"http://api.pwnedpasswords.com/range/{PREFIX}"),
        (200, f"https://attacker.example/range/{PREFIX}"),
        (200, f"https://api.pwnedpasswords.com/range/{PREFIX}/extra"),
    ],
)
def test_non_200_or_redirected_response_fails_closed(
    breached_passwords, status, final_url
):
    opener = RecordingOpener(
        f"{SUFFIX}:1\n".encode("ascii"),
        status=status,
        final_url=final_url,
    )

    with pytest.raises(
        breached_passwords.BreachedPasswordCheckError,
        match="screening unavailable",
    ):
        _checker(breached_passwords, opener)(PASSWORD)


@pytest.mark.parametrize("password", [None, b"secret", ""])
def test_invalid_password_input_fails_before_network(breached_passwords, password):
    opener = RecordingOpener()

    with pytest.raises(ValueError, match="password"):
        _checker(breached_passwords, opener)(password)

    assert opener.calls == []
