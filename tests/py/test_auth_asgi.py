from __future__ import annotations

import asyncio
import base64
import re
from http.cookies import SimpleCookie
from importlib import import_module, util
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI

from music_app.services.auth_login_postgres import LoginOutcome, LoginResult
from music_app.services.auth_password_reset_request_postgres import (
    PasswordResetDelivery,
    PasswordResetRequestResult,
)
from music_app.services.auth_password_reset_lifecycle_postgres import (
    IssuedResetTransaction,
    ResetCompletionOutcome,
)
from music_app.services.auth_invitation_csrf import issue_invitation_csrf
from music_app.services.auth_invitation_models import (
    InvitationCompletionOutcome,
    IssuedInvitationTransaction,
)
from music_app.services.auth_passwords import PasswordPolicyError
from music_app.services.auth_reset_csrf import issue_reset_csrf
from music_app.services.auth_preauth_postgres import IssuedPreAuthToken
from music_app.services.auth_session_csrf import matches_session_csrf
from music_app.services.auth_sessions_postgres import IssuedBrowserSession


MODULE = "music_app.routes.auth_asgi"
CSRF_COOKIE = "__Host-album_haven_login_csrf"
FORGOT_CSRF_COOKIE = "__Host-album_haven_forgot_csrf"
SESSION_COOKIE = "__Host-album_haven_session"
CSRF = "c" * 43
NEXT_CSRF = "n" * 43
SESSION = "s" * 43
RESET_TRANSACTION = "s" * 43
INVITATION_COOKIE = "__Host-album_haven_invitation"
INVITATION_RAW = base64.urlsafe_b64encode(bytes([0x11]) * 32).decode("ascii").rstrip("=")
NEXT_INVITATION_RAW = base64.urlsafe_b64encode(bytes([0x12]) * 32).decode("ascii").rstrip("=")
INVITATION_TRANSACTION = base64.urlsafe_b64encode(bytes([0x22]) * 32).decode("ascii").rstrip("=")
WRONG_INVITATION_CSRF = base64.urlsafe_b64encode(bytes([0x44]) * 32).decode("ascii").rstrip("=")


def test_auth_asgi_contract_is_present_and_registered_in_factory():
    assert util.find_spec(MODULE) is not None
    source = (__import__("pathlib").Path(__file__).resolve().parents[2] / "music_app" / "__init__.py").read_text(encoding="utf-8")
    assert "auth_asgi" in source and "auth_asgi_router" in source


@pytest.fixture
def auth_asgi():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class FakePreAuth:
    def __init__(self):
        self.issued = [CSRF, NEXT_CSRF]
        self.consumed = []
        self.consume_result = True

    def issue_login_token(self):
        raw = self.issued.pop(0)
        return IssuedPreAuthToken(raw_token=raw, token_id=1, expires_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc))

    def consume_login_token(self, raw):
        self.consumed.append(raw)
        return self.consume_result

    def issue_forgot_token(self):
        return self.issue_login_token()

    def consume_forgot_token(self, raw):
        return self.consume_login_token(raw)


class FakeLogin:
    def __init__(self, outcome=LoginOutcome.INVALID):
        self.outcome = outcome
        self.calls = []

    def authenticate(self, **kwargs):
        self.calls.append(kwargs)
        if self.outcome is LoginOutcome.SUCCESS:
            from datetime import datetime, timedelta, timezone
            now = datetime.now(timezone.utc)
            session = IssuedBrowserSession(SESSION, 8, 41, now, now + timedelta(hours=12), now + timedelta(days=7))
            return LoginResult(LoginOutcome.SUCCESS, 41, True, session)
        return LoginResult(self.outcome)


class FakeSessions:
    def __init__(self):
        self.revoked = []
        self.result = True

    def revoke_current(self, raw_token, reason=None):
        self.revoked.append((raw_token, reason))
        return self.result


class FakeResetRequests:
    def __init__(self, *, eligible=False):
        self.calls = []
        self.eligible = eligible

    def request_reset(self, **kwargs):
        self.calls.append(kwargs)
        delivery = (
            PasswordResetDelivery(81, 41, "member@example.test", "r" * 43)
            if self.eligible
            else None
        )
        return PasswordResetRequestResult(delivery=delivery)


class FakeResetLifecycle:
    def __init__(self):
        self.exchanges = []
        self.valid = True
        self.completions = []
        self.outcome = ResetCompletionOutcome.SUCCESS

    def exchange_reset_token(self, raw, *, request_ref):
        self.exchanges.append((raw, request_ref))
        if not self.valid:
            return None
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        return IssuedResetTransaction(RESET_TRANSACTION, 61, now + timedelta(minutes=15))

    def validate_transaction(self, raw):
        return self.valid and raw == RESET_TRANSACTION

    def complete_reset(self, raw, *, new_password, request_ref):
        self.completions.append((raw, new_password, request_ref))
        return self.outcome


class FakeInvitationLifecycle:
    def __init__(self):
        self.exchanges = []
        self.valid = True
        self.completions = []
        self.outcome = InvitationCompletionOutcome.SUCCESS
        self.password_policy_error = False

    def exchange_invitation_token(self, raw, *, request_ref):
        self.exchanges.append((raw, request_ref))
        if not self.valid:
            return None
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        return IssuedInvitationTransaction(
            INVITATION_TRANSACTION, 71, now + timedelta(minutes=15)
        )

    def validate_transaction(self, raw):
        return self.valid and raw == INVITATION_TRANSACTION

    def complete_invitation(self, raw, *, new_password, request_ref):
        self.completions.append((raw, new_password, request_ref))
        if self.password_policy_error:
            raise PasswordPolicyError("private password policy detail")
        return self.outcome


def _app(auth_asgi, *, outcome=LoginOutcome.INVALID, origins=("https://music.test",), proxies=()):
    app = FastAPI()
    preauth = FakePreAuth()
    login = FakeLogin(outcome)
    sessions = FakeSessions()
    app.state.auth_preauth_service = preauth
    app.state.auth_login_service = login
    app.state.auth_session_service = sessions
    app.state.auth_policy_config = {
        "trusted_origins": origins,
        "trusted_proxies": proxies,
        "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7},
        "cookie": {"name": SESSION_COOKIE, "secure": True, "http_only": True, "same_site": "Lax", "path": "/", "domain": None},
    }
    app.include_router(auth_asgi.router)
    return app, preauth, login


async def _request_async(app, method, path="/login", *, form=None, headers=None, scheme="https", client="127.0.0.1", host="music.test", query=""):
    body = urlencode(form or {}).encode("utf-8") if form is not None else b""
    raw_headers = [(b"host", host.encode("ascii"))]
    for key, value in (headers or {}).items():
        raw_headers.append((key.lower().encode("latin1"), value.encode("latin1")))
    if form is not None:
        raw_headers.extend([(b"content-type", b"application/x-www-form-urlencoded"), (b"content-length", str(len(body)).encode())])
    messages = []
    sent = False
    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}
    async def send(message):
        messages.append(message)
    await app({"type":"http","asgi":{"version":"3.0"},"http_version":"1.1","method":method,"scheme":scheme,"path":path,"raw_path":path.encode(),"query_string":query.encode("ascii"),"headers":raw_headers,"client":(client,50000),"server":(host,443 if scheme=="https" else 80)}, receive, send)
    start = next(message for message in messages if message["type"] == "http.response.start")
    response_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    response_headers = [(key.decode("latin1").lower(), value.decode("latin1")) for key, value in start.get("headers", [])]
    return int(start["status"]), response_headers, response_body


def _request(*args, **kwargs):
    return asyncio.run(_request_async(*args, **kwargs))


def _set_cookies(headers):
    return [value for key, value in headers if key == "set-cookie"]


def _valid_form(**overrides):
    payload = {"username": "Rendref", "password": "private-password", "csrf_token": CSRF, "return_to": "/albums?view=grid"}
    payload.update(overrides)
    return payload


def _valid_headers(**overrides):
    payload = {"origin": "https://music.test", "cookie": f"{CSRF_COOKIE}={CSRF}", "user-agent": "Browser"}
    payload.update(overrides)
    return payload


def test_get_login_mints_hidden_one_time_token_and_hardened_cookie(auth_asgi):
    app, preauth, login = _app(auth_asgi)
    status, headers, body = _request(app, "GET")
    assert status == 200 and login.calls == [] and preauth.consumed == []
    rendered = body.decode()
    assert 'name="csrf_token"' in rendered and f'value="{CSRF}"' in rendered
    assert "no-store" in dict(headers)["cache-control"]
    cookie = next(value for value in _set_cookies(headers) if value.startswith(CSRF_COOKIE + "="))
    assert all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/"))
    assert "Domain=" not in cookie


def test_get_login_renders_approved_v007_semantic_controls_and_assets(auth_asgi):
    app, _, _ = _app(auth_asgi)

    status, _, body = _request(app, "GET")
    rendered = body.decode()

    assert status == 200
    assert '<meta name="viewport" content="width=device-width, initial-scale=1">' in rendered
    assert 'class="login-glow"' in rendered
    assert 'src="/static/images/album-haven-cloud-vinyl.png"' in rendered
    assert 'href="/static/css/login.css"' in rendered
    assert 'src="/static/js/login.js"' in rendered
    assert '<label for="login-username">Username</label>' in rendered
    assert 'id="login-username"' in rendered and 'autocomplete="username"' in rendered
    assert '<label for="login-password">Password</label>' in rendered
    assert 'id="login-password"' in rendered and 'autocomplete="current-password"' in rendered
    assert 'type="button"' in rendered and 'aria-controls="login-password"' in rendered
    assert 'aria-pressed="false"' in rendered and '>Show<' in rendered
    assert '<button class="login-submit" type="submit">' in rendered
    assert 'required' in rendered
    assert 'href="/forgot-password"' in rendered


def test_get_forgot_password_mints_purpose_bound_csrf_and_renders_approved_recovery(auth_asgi):
    app, preauth, _ = _app(auth_asgi)

    status, headers, body = _request(app, "GET", path="/forgot-password")

    rendered = body.decode()
    assert status == 200
    assert 'action="/forgot-password"' in rendered
    assert 'name="candidate"' in rendered
    assert f'value="{CSRF}"' in rendered
    assert 'href="/static/css/password-recovery.css"' in rendered
    assert 'src="/static/js/password-recovery.js"' in rendered
    assert "Reset your password" in rendered
    assert dict(headers)["referrer-policy"] == "same-origin"
    assert '<meta name="referrer" content="same-origin">' in rendered
    cookie = next(
        value for value in _set_cookies(headers)
        if value.startswith(FORGOT_CSRF_COOKIE + "=")
    )
    assert all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/"))
    assert preauth.consumed == []


@pytest.mark.parametrize("eligible", [False, True])
def test_forgot_password_submission_has_one_generic_response_and_background_delivery(auth_asgi, eligible):
    app, preauth, _ = _app(auth_asgi)
    reset_requests = FakeResetRequests(eligible=eligible)
    delivered = []
    app.state.password_reset_request_service = reset_requests
    app.state.password_reset_delivery = lambda delivery: delivered.append(delivery)

    status, headers, body = _request(
        app,
        "POST",
        path="/forgot-password",
        form={"candidate": "member@example.test", "csrf_token": CSRF},
        headers={
            "origin": "https://music.test",
            "cookie": f"{FORGOT_CSRF_COOKIE}={CSRF}",
        },
    )

    assert status == 200
    assert b"Check your email" in body
    assert b"member@example.test" not in body
    assert preauth.consumed == [CSRF]
    assert len(reset_requests.calls) == 1
    assert bool(delivered) is eligible
    assert any(
        value.startswith(FORGOT_CSRF_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )


def test_reset_link_exchanges_to_httponly_clean_url_transaction(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    app.state.password_reset_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/reset-password",
        query="purpose=password-reset&token=" + CSRF,
    )

    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/reset-password"
    assert CSRF.encode() not in body and CSRF not in dict(headers)["location"]
    cookie = next(
        value for value in _set_cookies(headers)
        if value.startswith("__Host-album_haven_reset=")
    )
    assert RESET_TRANSACTION in cookie
    assert all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/"))
    assert lifecycle.exchanges[0][0] == CSRF


def test_reset_link_rejects_duplicate_or_invalid_query_without_reflecting_token(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    app.state.password_reset_lifecycle_service = lifecycle

    status, _, body = _request(
        app,
        "GET",
        path="/reset-password",
        query=(
            "purpose=password-reset&token=" + CSRF + "&token=" + NEXT_CSRF
        ),
    )

    assert status == 400
    assert CSRF.encode() not in body and NEXT_CSRF.encode() not in body
    assert lifecycle.exchanges == []


def test_expired_reset_link_redirects_to_a_clean_invalid_url(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    lifecycle.valid = False
    app.state.password_reset_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/reset-password",
        query="purpose=password-reset&token=" + CSRF,
    )

    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/reset-password?invalid=1"
    assert CSRF not in dict(headers)["location"]


def test_clean_reset_page_uses_transaction_bound_csrf(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    app.state.password_reset_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/reset-password",
        headers={"cookie": f"__Host-album_haven_reset={RESET_TRANSACTION}"},
    )

    csrf = issue_reset_csrf(RESET_TRANSACTION, app.state.auth_policy_config)
    rendered = body.decode()
    assert status == 200
    assert 'action="/reset-password"' in rendered
    assert f'value="{csrf}"' in rendered
    assert RESET_TRANSACTION not in rendered
    assert dict(headers)["referrer-policy"] == "same-origin"
    assert '<meta name="referrer" content="same-origin">' in rendered


def test_reset_completion_requires_origin_csrf_and_matching_passwords_then_clears_state(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    app.state.password_reset_lifecycle_service = lifecycle
    csrf = issue_reset_csrf(RESET_TRANSACTION, app.state.auth_policy_config)

    status, headers, body = _request(
        app,
        "POST",
        path="/reset-password",
        form={
            "new_password": "a private replacement password",
            "confirm_password": "a private replacement password",
            "csrf_token": csrf,
        },
        headers={
            "origin": "https://music.test",
            "cookie": f"__Host-album_haven_reset={RESET_TRANSACTION}",
        },
    )

    assert status == 200
    assert b"Password changed" in body
    assert len(lifecycle.completions) == 1
    assert any(
        value.startswith("__Host-album_haven_reset=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )

    invalid_status, _, _ = _request(
        app,
        "POST",
        path="/reset-password",
        form={
            "new_password": "one private replacement",
            "confirm_password": "different replacement",
            "csrf_token": csrf,
        },
        headers={
            "origin": "https://music.test",
            "cookie": f"__Host-album_haven_reset={RESET_TRANSACTION}",
        },
    )
    assert invalid_status == 400
    assert len(lifecycle.completions) == 1


def test_reset_completion_accepts_matching_unicode_password_without_compare_error(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeResetLifecycle()
    app.state.password_reset_lifecycle_service = lifecycle
    csrf = issue_reset_csrf(RESET_TRANSACTION, app.state.auth_policy_config)
    password = "très-long-private-password"

    status, _, _ = _request(
        app,
        "POST",
        path="/reset-password",
        form={
            "new_password": password,
            "confirm_password": password,
            "csrf_token": csrf,
        },
        headers={
            "origin": "https://music.test",
            "cookie": f"__Host-album_haven_reset={RESET_TRANSACTION}",
        },
    )

    assert status == 200
    assert lifecycle.completions[0][1] == password


def test_invitation_link_exchanges_to_strict_httponly_clean_url_transaction(
    auth_asgi, caplog
):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle
    raw_invite = INVITATION_RAW

    status, headers, body = _request(
        app,
        "GET",
        path="/accept-invitation",
        query="purpose=account-invitation&token=" + raw_invite,
        headers={"cookie": f"{INVITATION_COOKIE}={NEXT_INVITATION_RAW}"},
    )

    response_headers = dict(headers)
    assert status == 303 and body == b""
    assert response_headers["location"] == "/accept-invitation"
    assert response_headers["cache-control"] == "no-store, max-age=0"
    assert response_headers["referrer-policy"] == "no-referrer"
    invitation_cookies = [
        value for value in _set_cookies(headers)
        if value.startswith(INVITATION_COOKIE + "=")
    ]
    deletion = next(
        value for value in invitation_cookies if "Max-Age=0" in value
    )
    cookie = next(
        value for value in invitation_cookies if "Max-Age=0" not in value
    )
    assert invitation_cookies.index(deletion) < invitation_cookies.index(cookie)
    assert all(
        flag in deletion
        for flag in ("HttpOnly", "Secure", "SameSite=strict", "Path=/")
    )
    assert INVITATION_TRANSACTION in cookie
    assert raw_invite not in cookie
    assert NEXT_INVITATION_RAW not in cookie
    assert all(
        flag in cookie
        for flag in ("HttpOnly", "Secure", "SameSite=strict", "Path=/")
    )
    assert raw_invite.encode() not in body
    assert raw_invite not in caplog.text
    assert lifecycle.exchanges[0][0] == raw_invite


@pytest.mark.parametrize(
    "query",
    (
        "purpose=wrong-purpose&token=" + INVITATION_RAW,
        (
            "purpose=account-invitation&token="
            + INVITATION_RAW
            + "&token="
            + NEXT_INVITATION_RAW
        ),
    ),
    ids=("invalid", "duplicate"),
)
def test_invalid_or_duplicate_invitation_query_redirects_clean_and_clears_stale_cookie(
    auth_asgi, query
):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/accept-invitation",
        query=query,
        headers={"cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}"},
    )

    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/accept-invitation"
    assert any(
        value.startswith(INVITATION_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )
    assert INVITATION_RAW.encode() not in body
    assert NEXT_INVITATION_RAW.encode() not in body
    assert lifecycle.exchanges == []


def test_expired_invitation_query_redirects_clean_and_clears_stale_cookie(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    lifecycle.valid = False
    app.state.invitation_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/accept-invitation",
        query="purpose=account-invitation&token=" + INVITATION_RAW,
        headers={"cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}"},
    )

    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/accept-invitation"
    assert any(
        value.startswith(INVITATION_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )
    assert lifecycle.exchanges[0][0] == INVITATION_RAW


def test_invitation_exchange_failure_redirects_clean_and_clears_stale_cookie(
    auth_asgi,
):
    class FailingInvitationLifecycle(FakeInvitationLifecycle):
        def exchange_invitation_token(self, raw, *, request_ref):
            self.exchanges.append((raw, request_ref))
            raise RuntimeError(f"provider leaked {raw}")

    app, _, _ = _app(auth_asgi)
    lifecycle = FailingInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/accept-invitation",
        query="purpose=account-invitation&token=" + INVITATION_RAW,
        headers={"cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}"},
    )

    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/accept-invitation"
    assert any(
        value.startswith(INVITATION_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )
    assert INVITATION_RAW.encode() not in body
    assert all(
        INVITATION_RAW not in key and INVITATION_RAW not in value
        for key, value in headers
    )


def test_clean_invitation_page_uses_transaction_bound_csrf_and_no_referrer(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle

    status, headers, body = _request(
        app,
        "GET",
        path="/accept-invitation",
        headers={"cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}"},
    )

    csrf = issue_invitation_csrf(
        INVITATION_TRANSACTION, app.state.auth_policy_config
    )
    rendered = body.decode()
    assert status == 200
    assert 'action="/accept-invitation"' in rendered
    assert f'value="{csrf}"' in rendered
    assert INVITATION_TRANSACTION not in rendered
    assert dict(headers)["referrer-policy"] == "no-referrer"
    assert '<meta name="referrer" content="no-referrer">' in rendered


def test_invitation_completion_requires_origin_csrf_and_matching_passwords_then_clears_state(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle
    csrf = issue_invitation_csrf(
        INVITATION_TRANSACTION, app.state.auth_policy_config
    )
    form = {
        "new_password": "Phase Seven Recipient Passphrase 2026!",
        "confirm_password": "Phase Seven Recipient Passphrase 2026!",
        "csrf_token": csrf,
    }

    status, headers, body = _request(
        app,
        "POST",
        path="/accept-invitation",
        headers={
            "origin": "https://music.test",
            "cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}",
        },
        form=form,
    )

    assert status == 200
    assert b"password has been created" in body
    assert len(lifecycle.completions) == 1
    assert any(
        value.startswith(INVITATION_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )

    for origin, confirmation, supplied_csrf in (
        ("https://evil.test", form["confirm_password"], csrf),
        (
            "https://music.test",
            "Different Recipient Passphrase 2026!",
            csrf,
        ),
        (
            "https://music.test",
            form["confirm_password"],
            WRONG_INVITATION_CSRF,
        ),
    ):
        invalid_status, _, _ = _request(
            app,
            "POST",
            path="/accept-invitation",
            headers={
                "origin": origin,
                "cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}",
            },
            form=dict(
                form,
                confirm_password=confirmation,
                csrf_token=supplied_csrf,
            ),
        )
        assert invalid_status == 400
    assert len(lifecycle.completions) == 1


def test_invalid_invitation_completion_clears_transaction_cookie(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    lifecycle.outcome = InvitationCompletionOutcome.INVALID
    app.state.invitation_lifecycle_service = lifecycle
    csrf = issue_invitation_csrf(
        INVITATION_TRANSACTION, app.state.auth_policy_config
    )

    status, headers, _ = _request(
        app,
        "POST",
        path="/accept-invitation",
        headers={
            "origin": "https://music.test",
            "cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}",
        },
        form={
            "new_password": "Phase Seven Recipient Passphrase 2026!",
            "confirm_password": "Phase Seven Recipient Passphrase 2026!",
            "csrf_token": csrf,
        },
    )

    assert status == 400
    assert any(
        value.startswith(INVITATION_COOKIE + "=") and "Max-Age=0" in value
        for value in _set_cookies(headers)
    )


def test_invitation_password_policy_error_preserves_transaction_and_generic_detail(auth_asgi):
    app, _, _ = _app(auth_asgi)
    lifecycle = FakeInvitationLifecycle()
    lifecycle.password_policy_error = True
    app.state.invitation_lifecycle_service = lifecycle
    csrf = issue_invitation_csrf(
        INVITATION_TRANSACTION, app.state.auth_policy_config
    )

    status, headers, body = _request(
        app,
        "POST",
        path="/accept-invitation",
        headers={
            "origin": "https://music.test",
            "cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}",
        },
        form={
            "new_password": "Phase Seven Recipient Passphrase 2026!",
            "confirm_password": "Phase Seven Recipient Passphrase 2026!",
            "csrf_token": csrf,
        },
    )

    assert status == 400
    assert b"private password policy detail" not in body
    assert not any("Max-Age=0" in value for value in _set_cookies(headers))
    assert dict(headers)["cache-control"] == "no-store, max-age=0"


def test_invitation_completion_accepts_direct_loopback_http_same_origin(auth_asgi):
    app, _, _ = _app(auth_asgi, origins=("https://music.test",))
    lifecycle = FakeInvitationLifecycle()
    app.state.invitation_lifecycle_service = lifecycle
    csrf = issue_invitation_csrf(
        INVITATION_TRANSACTION, app.state.auth_policy_config
    )

    status, headers, _ = _request(
        app,
        "POST",
        path="/accept-invitation",
        scheme="http",
        client="127.0.0.1",
        host="localhost",
        headers={
            "origin": "http://localhost",
            "cookie": f"{INVITATION_COOKIE}={INVITATION_TRANSACTION}",
        },
        form={
            "new_password": "Phase Seven Recipient Passphrase 2026!",
            "confirm_password": "Phase Seven Recipient Passphrase 2026!",
            "csrf_token": csrf,
        },
    )

    assert status == 200
    assert len(lifecycle.completions) == 1
    assert any(
        value.startswith(INVITATION_COOKIE + "=")
        and "Max-Age=0" in value
        and "Secure" in value
        for value in _set_cookies(headers)
    )


def test_login_preserves_only_safe_return_target_on_get_and_failed_retry(auth_asgi):
    app, _, _ = _app(auth_asgi, outcome=LoginOutcome.INVALID)
    status, _, body = _request(
        app,
        "GET",
        query="return_to=%2Falbums%3Fview%3Dgrid",
    )
    assert status == 200
    assert 'name="return_to" value="/albums?view=grid"' in body.decode()

    status, _, body = _request(
        app,
        "POST",
        form=_valid_form(return_to="/albums?view=grid"),
        headers=_valid_headers(),
    )
    assert status == 401
    assert 'name="return_to" value="/albums?view=grid"' in body.decode()


@pytest.mark.parametrize("outcome", [LoginOutcome.INVALID, LoginOutcome.THROTTLED])
def test_invalid_and_throttled_are_one_generic_contract_with_fresh_csrf(auth_asgi, outcome):
    app, preauth, login = _app(auth_asgi, outcome=outcome)
    preauth.issued = [NEXT_CSRF]
    status, headers, body = _request(app, "POST", form=_valid_form(), headers=_valid_headers())
    assert status == 401
    assert b"Sign-in failed" in body and b"private-password" not in body
    assert preauth.consumed == [CSRF] and len(login.calls) == 1
    assert NEXT_CSRF.encode() in body
    assert any(value.startswith(CSRF_COOKIE + "=" + NEXT_CSRF) for value in _set_cookies(headers))


@pytest.mark.parametrize(
    "headers,form",
    [
        ({"cookie": f"{CSRF_COOKIE}={CSRF}"}, _valid_form()),
        (_valid_headers(origin="https://evil.test"), _valid_form()),
        (_valid_headers(cookie=f"{CSRF_COOKIE}=wrong"), _valid_form()),
        (_valid_headers(), _valid_form(csrf_token="wrong")),
    ],
)
def test_origin_and_cookie_form_csrf_fail_before_consume_or_login(auth_asgi, headers, form):
    app, preauth, login = _app(auth_asgi)
    status, _, body = _request(app, "POST", form=form, headers=headers)
    assert status == 400 and b"private-password" not in body
    assert preauth.consumed == [] and login.calls == []


def test_non_ascii_csrf_is_rejected_without_consuming_or_authenticating(auth_asgi):
    app, preauth, login = _app(auth_asgi)

    status, _, body = _request(
        app,
        "POST",
        form=_valid_form(csrf_token="snowman-\u2603"),
        headers=_valid_headers(),
    )

    assert status == 400 and body == b"Sign-in request was invalid."
    assert preauth.consumed == [] and login.calls == []


def test_lazy_service_initialization_failure_is_generic_unavailable(auth_asgi, monkeypatch):
    app, _, _ = _app(auth_asgi)
    monkeypatch.setattr(
        auth_asgi,
        "_services",
        lambda _request: (_ for _ in ()).throw(RuntimeError("provider detail")),
    )

    get_status, _, get_body = _request(app, "GET")
    post_status, _, post_body = _request(
        app,
        "POST",
        form=_valid_form(),
        headers=_valid_headers(),
    )

    assert (get_status, get_body) == (503, b"Sign-in is temporarily unavailable.")
    assert (post_status, post_body) == (503, b"Sign-in is temporarily unavailable.")


def test_success_consumes_then_authenticates_sets_unrelated_session_and_clears_preauth(auth_asgi):
    app, preauth, login = _app(auth_asgi, outcome=LoginOutcome.SUCCESS)
    status, headers, body = _request(app, "POST", form=_valid_form(), headers=_valid_headers())
    assert status == 303 and body == b""
    assert dict(headers)["location"] == "/albums?view=grid"
    assert preauth.consumed == [CSRF] and len(login.calls) == 1
    call = login.calls[0]
    assert call["entered_username"] == "Rendref" and call["password"] == "private-password"
    assert call["source_class"] == "loopback" and re.fullmatch(r"[a-f0-9]{32}", call["request_ref"])
    cookies = _set_cookies(headers)
    session_cookie = next(value for value in cookies if value.startswith(SESSION_COOKIE + "=" + SESSION))
    assert all(flag in session_cookie for flag in ("HttpOnly", "Secure", "SameSite=lax", "Path=/"))
    assert "Domain=" not in session_cookie and CSRF not in session_cookie
    assert any(value.startswith(CSRF_COOKIE + "=") and "Max-Age=0" in value for value in cookies)
    csrf_cookie = next(
        value
        for value in cookies
        if value.startswith("__Host-album_haven_csrf=")
    )
    assert "HttpOnly" not in csrf_cookie
    assert all(flag in csrf_cookie for flag in ("Secure", "SameSite=lax", "Path=/"))
    parsed = SimpleCookie()
    parsed.load(csrf_cookie)
    assert matches_session_csrf(
        SESSION,
        parsed["__Host-album_haven_csrf"].value,
        app.state.auth_policy_config,
    )


def test_logout_requires_session_bound_csrf_revokes_and_clears_cookies(auth_asgi):
    from music_app.services.auth_session_csrf import issue_session_csrf

    app, _, _ = _app(auth_asgi)
    token = issue_session_csrf(SESSION, app.state.auth_policy_config)
    headers = {
        "origin": "https://music.test",
        "cookie": (
            f"{SESSION_COOKIE}={SESSION}; "
            f"__Host-album_haven_csrf={token}"
        ),
    }

    status, response_headers, body = _request(
        app,
        "POST",
        path="/logout",
        form={"csrf_token": token},
        headers=headers,
    )

    assert status == 303 and body == b""
    assert dict(response_headers)["location"] == "/login"
    revoked = app.state.auth_session_service.revoked
    assert revoked[0][0] == SESSION
    assert str(getattr(revoked[0][1], "value", revoked[0][1])) == "logout"
    cookies = _set_cookies(response_headers)
    assert any(value.startswith(SESSION_COOKIE + "=") and "Max-Age=0" in value for value in cookies)
    assert any(value.startswith("__Host-album_haven_csrf=") and "Max-Age=0" in value for value in cookies)


@pytest.mark.parametrize(
    ("headers", "form"),
    [
        (
            {"cookie": f"{SESSION_COOKIE}={SESSION}"},
            {"csrf_token": "x" * 43},
        ),
        (
            {"origin": "https://evil.test", "cookie": f"{SESSION_COOKIE}={SESSION}"},
            {"csrf_token": "x" * 43},
        ),
        (
            {"origin": "https://music.test", "cookie": f"{SESSION_COOKIE}={SESSION}"},
            {"csrf_token": "x" * 43},
        ),
    ],
)
def test_logout_rejects_missing_origin_or_session_bound_csrf_before_revocation(
    auth_asgi, headers, form
):
    app, _, _ = _app(auth_asgi)

    status, _, _ = _request(
        app,
        "POST",
        path="/logout",
        form=form,
        headers=headers,
    )

    assert status == 400
    assert app.state.auth_session_service.revoked == []


def test_logout_rejects_cookie_mismatch_and_non_ascii_csrf_without_error(auth_asgi):
    from music_app.services.auth_session_csrf import issue_session_csrf

    app, _, _ = _app(auth_asgi)
    token = issue_session_csrf(SESSION, app.state.auth_policy_config)

    for supplied in ("x" * 43, "snowman-☃"):
        status, _, _ = _request(
            app,
            "POST",
            path="/logout",
            form={"csrf_token": supplied},
            headers={
                "origin": "https://music.test",
                "cookie": (
                    f"{SESSION_COOKIE}={SESSION}; "
                    f"__Host-album_haven_csrf={token}"
                ),
            },
        )
        assert status == 400

    assert app.state.auth_session_service.revoked == []


@pytest.mark.parametrize("return_to", ["https://evil.test/x", "//evil.test/x", "/%2f%2fevil.test", "/\\evil.test", "/%5cevil.test", "/safe\nSet-Cookie:x"])
def test_unsafe_return_targets_fall_back_to_root(auth_asgi, return_to):
    app, _, _ = _app(auth_asgi, outcome=LoginOutcome.SUCCESS)
    status, headers, _ = _request(app, "POST", form=_valid_form(return_to=return_to), headers=_valid_headers())
    assert status == 303 and dict(headers)["location"] == "/"


def test_loopback_http_cookie_exception_and_nonloopback_http_rejection(auth_asgi):
    app, _, _ = _app(auth_asgi, origins=("https://music.test",))
    get_status, get_headers, _ = _request(app, "GET", scheme="http", client="127.0.0.1", host="localhost")
    assert get_status == 200 and "Secure" in _set_cookies(get_headers)[0]

    app, _, _ = _app(auth_asgi, outcome=LoginOutcome.SUCCESS, origins=("https://music.test",))
    post_status, post_headers, _ = _request(
        app,
        "POST",
        form=_valid_form(),
        headers=_valid_headers(origin="http://localhost"),
        scheme="http",
        client="127.0.0.1",
        host="localhost",
    )
    assert post_status == 303
    assert "Secure" in next(value for value in _set_cookies(post_headers) if value.startswith(SESSION_COOKIE))

    app, _, login = _app(auth_asgi, origins=("https://music.test",))
    status, _, _ = _request(app, "POST", form=_valid_form(), headers=_valid_headers(origin="http://music.test"), scheme="http", client="203.0.113.8")
    assert status == 400 and login.calls == []


def test_trusted_proxy_https_controls_secure_cookie_and_forwarded_source(auth_asgi):
    app, _, login = _app(
        auth_asgi,
        outcome=LoginOutcome.SUCCESS,
        proxies=("127.0.0.0/8",),
    )
    headers = _valid_headers(
        **{"x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9"}
    )
    status, response_headers, _ = _request(
        app,
        "POST",
        form=_valid_form(),
        headers=headers,
        scheme="http",
        client="127.0.0.1",
    )
    assert status == 303
    session_cookie = next(
        value
        for value in _set_cookies(response_headers)
        if value.startswith(SESSION_COOKIE + "=" + SESSION)
    )
    assert "Secure" in session_cookie
    assert login.calls[0]["source_key"] == "203.0.113.9"
    assert login.calls[0]["source_class"] == "trusted_proxy"


def test_trusted_proxy_selects_nearest_untrusted_forwarded_hop(auth_asgi):
    app, _, login = _app(
        auth_asgi,
        outcome=LoginOutcome.SUCCESS,
        proxies=("127.0.0.0/8", "10.0.0.0/8"),
    )
    headers = _valid_headers(
        **{
            "x-forwarded-proto": "https",
            "x-forwarded-for": "192.0.2.44, 198.51.100.7, 10.1.2.3",
        }
    )

    status, _, _ = _request(
        app,
        "POST",
        form=_valid_form(),
        headers=headers,
        scheme="http",
        client="127.0.0.1",
    )

    assert status == 303
    assert login.calls[0]["source_key"] == "198.51.100.7"
    assert login.calls[0]["source_class"] == "trusted_proxy"
