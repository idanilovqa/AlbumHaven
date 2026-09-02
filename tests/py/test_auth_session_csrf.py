from __future__ import annotations

import base64
from importlib import import_module, util

import pytest


MODULE = "music_app.services.auth_session_csrf"
SESSION = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii").rstrip("=")
CONFIG = {
    "hmac": {
        "secret": "0123456789abcdef0123456789abcdef",
        "key_version": 7,
    }
}


def test_session_csrf_contract_is_present():
    assert util.find_spec(MODULE) is not None


@pytest.fixture
def csrf():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


def test_token_is_deterministic_session_bound_versioned_and_urlsafe(csrf):
    token = csrf.issue_session_csrf(SESSION, CONFIG)

    assert len(token) == 43
    assert set(token) <= set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    assert token == csrf.issue_session_csrf(SESSION, CONFIG)
    assert token != csrf.issue_session_csrf("s" * 43, CONFIG)
    assert token != csrf.issue_session_csrf(
        SESSION,
        {"hmac": {"secret": CONFIG["hmac"]["secret"], "key_version": 8}},
    )


def test_validation_is_exact_and_rejects_other_sessions_or_malformed_values(csrf):
    token = csrf.issue_session_csrf(SESSION, CONFIG)

    assert csrf.matches_session_csrf(SESSION, token, CONFIG) is True
    assert csrf.matches_session_csrf("s" * 43, token, CONFIG) is False
    assert csrf.matches_session_csrf(SESSION, token[:-1] + "x", CONFIG) is False
    assert csrf.matches_session_csrf(SESSION, "bad token", CONFIG) is False
    assert csrf.matches_session_csrf(None, token, CONFIG) is False


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"hmac": {"secret": "short", "key_version": 1}},
        {"hmac": {"secret": "x" * 32, "key_version": 0}},
    ],
)
def test_invalid_policy_fails_without_echoing_session_or_secret(csrf, config):
    with pytest.raises(ValueError) as exc_info:
        csrf.issue_session_csrf(SESSION, config)

    rendered = str(exc_info.value)
    assert SESSION not in rendered
    secret = str(config.get("hmac", {}).get("secret", ""))
    if secret:
        assert secret not in rendered
