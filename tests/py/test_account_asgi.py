import asyncio
from datetime import datetime, timezone
import re
from urllib.parse import urlencode

from fastapi import FastAPI

from music_app.services.auth_profile_password_postgres import (
    ProfileAccountView,
    ProfilePasswordOutcome,
    ProfileSessionView,
)
from music_app.services.auth_session_csrf import issue_session_csrf
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import ActorState, CurrentActor


NOW = datetime(2026, 8, 31, 21, 0, tzinfo=timezone.utc)


class Service:
    def __init__(self):
        self.profile_calls = []
        self.password_calls = []
        self.dismiss_calls = []

    def load_profile(self, **kwargs):
        self.profile_calls.append(kwargs)
        return ProfileAccountView(
            username="member.one",
            administrator_set_suggestion=True,
            sessions=(
                ProfileSessionView(11, "Windows browser", NOW, True),
                ProfileSessionView(12, "Android", NOW, False),
            ),
        )

    def change_password(self, **kwargs):
        self.password_calls.append(kwargs)
        return ProfilePasswordOutcome.SUCCESS

    def dismiss_suggestion(self, **kwargs):
        self.dismiss_calls.append(kwargs)
        return True


def _app(*, is_bootstrap_owner=False, password_min=8):
    from music_app.routes.account_asgi import router

    app = FastAPI()
    service = Service()
    app.state.profile_password_service = service
    app.state.auth_policy_config = {
        "hmac": {"secret": "s" * 48, "key_version": 1},
        "trusted_origins": ["https://music.test"],
        "password": {"min_codepoints": password_min, "max_codepoints": 256, "max_utf8_bytes": 1024},
    }

    @app.middleware("http")
    async def actor(request, call_next):
        request.state.current_actor = CurrentActor(
            state=ActorState.ACTIVE,
            account_id=41,
            session_id=11,
            username_display="member.one",
            is_bootstrap_owner=is_bootstrap_owner,
        )
        return await call_next(request)

    app.include_router(router)
    return app, service


def _session():
    return issue_opaque_token(random_bytes=lambda count: bytes(range(count))).raw


async def _request_async(app, method, path, *, session, data=None):
    body = urlencode(data or {}).encode("utf-8")
    headers = [(b"host", b"music.test"), (b"cookie", f"__Host-album_haven_session={session}".encode("ascii"))]
    if method == "POST":
        headers.extend((
            (b"content-type", b"application/x-www-form-urlencoded"),
            (b"content-length", str(len(body)).encode("ascii")),
            (b"origin", b"https://music.test"),
        ))
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

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("music.test", 443),
        },
        receive,
        send,
    )
    start = next(item for item in messages if item["type"] == "http.response.start")
    response_headers = {
        key.decode("latin-1"): value.decode("latin-1")
        for key, value in start["headers"]
    }
    response_body = b"".join(
        item.get("body", b"") for item in messages if item["type"] == "http.response.body"
    )
    return start["status"], response_headers, response_body.decode("utf-8")


def _request(app, method, path, *, session, data=None):
    return asyncio.run(_request_async(app, method, path, session=session, data=data))


def test_account_page_renders_approved_security_profile_without_cacheable_secrets():
    app, _service = _app()
    session = _session()

    status, headers, body = _request(app, "GET", "/account", session=session)

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    assert "Password &amp; security" in body
    assert "member.one" in body
    assert "Make this password your own" in body
    assert "Windows browser" in body
    assert 'action="/logout"' in body
    assert "Sign Out" in body
    assert session not in body
    assert body.count('minlength="8"') == 2


def test_account_password_form_minimum_length_comes_from_password_policy():
    app, _service = _app(password_min=13)

    status, _headers, body = _request(
        app,
        "GET",
        "/account",
        session=_session(),
    )

    assert status == 200
    assert body.count('minlength="13"') == 2
    assert 'minlength="8"' not in body


def test_my_account_navigation_keeps_personal_password_and_connected_devices():
    app, service = _app()

    status, _headers, body = _request(app, "GET", "/account", session=_session())

    assert status == 200
    assert re.search(r'href="/account"[^>]*aria-current="page"[^>]*>.*My account</span></a>', body)
    assert len(re.findall(r'\bdata-settings-nav(?=\s|>)', body)) == 1
    assert body.count('data-settings-host') == 1
    assert body.count('src="/static/js/settings-navigation.js"') == 1
    assert "member.one" in body
    assert 'action="/account/password"' in body
    assert "Active sessions" in body
    assert "Windows browser" in body
    assert "Android" in body
    assert service.profile_calls == [{"account_id": 41, "current_session_id": 11}]
    assert 'href="/admin/members"' not in body


def test_my_account_navigation_offers_users_to_authorized_owner():
    app, service = _app(is_bootstrap_owner=True)

    status, _headers, body = _request(app, "GET", "/account", session=_session())

    assert status == 200
    assert re.search(r'href="/admin/members"[^>]*>.*Users</span></a>', body)
    assert service.profile_calls == [{"account_id": 41, "current_session_id": 11}]


def test_account_password_form_requires_session_csrf_and_never_echoes_passwords():
    app, service = _app()
    session = _session()
    csrf = issue_session_csrf(session, app.state.auth_policy_config)
    payload = {
        "current_password": "current secret",
        "new_password": "new private passphrase",
        "confirm_password": "new private passphrase",
        "csrf_token": csrf,
    }

    status, headers, body = _request(
        app, "POST", "/account/password", session=session, data=payload
    )

    assert status == 303
    assert headers["location"] == "/account?changed=1"
    assert service.password_calls[0]["current_password"] == payload["current_password"]
    assert payload["current_password"] not in body
    assert payload["new_password"] not in body


def test_account_suggestion_dismissal_is_a_separate_csrf_protected_action():
    app, service = _app()
    session = _session()
    csrf = issue_session_csrf(session, app.state.auth_policy_config)

    status, headers, _body = _request(
        app,
        "POST",
        "/account/password-suggestion/dismiss",
        session=session,
        data={"csrf_token": csrf},
    )

    assert status == 303
    assert headers["location"] == "/account"
    assert service.dismiss_calls[0]["account_id"] == 41
