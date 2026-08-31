from __future__ import annotations

import asyncio
from email.message import EmailMessage
from importlib import import_module, util
import ssl
from typing import Any

import pytest
from aiosmtplib.errors import SMTPRecipientRefused, SMTPRecipientsRefused


MODULE = "music_app.services.auth_mail"
TOKEN = "reset +/=?&token value"


def test_auth_mail_contract_is_present():
    try:
        auth_mail = import_module(MODULE)
    except ModuleNotFoundError as exc:
        pytest.fail(f"Phase 7 authentication mail contract is not implemented: {exc}")

    assert callable(auth_mail.compose_welcome_email)
    assert callable(auth_mail.compose_password_reset_email)
    assert callable(auth_mail.send_auth_email)


@pytest.fixture
def auth_mail():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


def _config(**overrides: Any) -> dict[str, Any]:
    config = {
        "public_base_url": "https://music.example.test/haven",
        "host": "smtp.example.test",
        "port": 587,
        "security": "starttls",
        "username": " smtp-user ",
        "password": " smtp-secret ",
        "sender_address": "album-haven@example.test",
        "sender_name": "Album Haven",
        "connect_timeout_seconds": 5,
        "command_timeout_seconds": 11,
    }
    config.update(overrides)
    return config


def _body_parts(message: EmailMessage) -> tuple[str, str]:
    text = message.get_body(preferencelist=("plain",))
    html = message.get_body(preferencelist=("html",))
    assert text is not None
    assert html is not None
    return text.get_content(), html.get_content()


def test_welcome_email_has_normal_login_link_and_never_contains_a_password_or_activation(
    auth_mail,
):
    message = auth_mail.compose_welcome_email(
        username="Rendref",
        recipient="rendref+music@example.test",
        config=_config(),
    )

    assert isinstance(message, EmailMessage)
    assert message["To"] == "rendref+music@example.test"
    assert message["From"] == "Album Haven <album-haven@example.test>"
    text, html = _body_parts(message)
    for body in (text, html):
        assert "Rendref" in body
        assert "https://music.example.test/haven/login" in body
        assert "password" not in body.casefold()
        assert "activat" not in body.casefold()


def test_reset_email_uses_a_purpose_bound_url_encoded_token_and_redacts_repr(
    auth_mail,
):
    message = auth_mail.compose_password_reset_email(
        username="Rendref",
        recipient="rendref+music@example.test",
        token=TOKEN,
        config=_config(),
    )

    assert message["To"] == "rendref+music@example.test"
    text, html = _body_parts(message)
    for body in (text, html):
        assert "Rendref" in body
        assert "purpose=password-reset" in body
        assert "token=reset%20%2B%2F%3D%3F%26token%20value" in body
        assert TOKEN not in body
    assert TOKEN not in repr(message)


@pytest.mark.parametrize(
    ("composer", "kwargs", "secret"),
    [
        ("compose_welcome_email", {"username": "Rendref\r\nBcc: victim@example.test"}, "victim@example.test"),
        ("compose_welcome_email", {"recipient": "rendref@example.test\nBcc: victim@example.test"}, "victim@example.test"),
        ("compose_password_reset_email", {"token": "opaque\r\nBcc: victim@example.test"}, "opaque"),
    ],
)
def test_composers_reject_header_and_url_crlf_without_echoing_sensitive_input(
    auth_mail, composer, kwargs, secret
):
    arguments = {
        "username": "Rendref",
        "recipient": "rendref+music@example.test",
        "config": _config(),
    }
    if composer == "compose_password_reset_email":
        arguments["token"] = TOKEN
    arguments.update(kwargs)

    with pytest.raises(ValueError) as caught:
        getattr(auth_mail, composer)(**arguments)

    assert secret not in str(caught.value)


class FakeSMTP:
    instances: list["FakeSMTP"] = []
    send_error: BaseException | None = None
    send_result: Any = ({}, "ok")
    phase_errors: dict[str, BaseException] = {}

    def __init__(self, **kwargs: Any):
        self.kwargs = kwargs
        self.calls: list[tuple[str, Any]] = []
        type(self).instances.append(self)

    async def connect(self):
        self.calls.append(("connect", None))
        self._raise_for("connect")

    async def starttls(self, **kwargs: Any):
        self.calls.append(("starttls", kwargs))
        self._raise_for("starttls")

    async def login(self, username: str, password: str, **kwargs: Any):
        self.calls.append(("login", (username, password, kwargs)))
        self._raise_for("login")

    async def send_message(self, message: EmailMessage, **kwargs: Any):
        self.calls.append(("send_message", (message, kwargs)))
        self._raise_for("send")
        if self.send_error is not None:
            raise self.send_error
        return self.send_result

    async def quit(self, **kwargs: Any):
        self.calls.append(("quit", kwargs))
        self._raise_for("quit")

    def close(self):
        self.calls.append(("close", None))

    def _raise_for(self, phase: str):
        failure = self.phase_errors.get(phase)
        if failure is not None:
            raise failure


def _reset_fake(*, phase_errors: dict[str, BaseException] | None = None):
    FakeSMTP.instances.clear()
    FakeSMTP.send_error = None
    FakeSMTP.send_result = ({}, "ok")
    FakeSMTP.phase_errors = phase_errors or {}


def _welcome(auth_mail, config: dict[str, Any]) -> EmailMessage:
    return auth_mail.compose_welcome_email(
        username="Rendref",
        recipient="rendref+music@example.test",
        config=config,
    )


@pytest.mark.parametrize("security", ["tls", "starttls"])
def test_send_uses_verified_tls_credentials_timeouts_and_clean_quit(auth_mail, security):
    _reset_fake()
    config = _config(security=security, port=465 if security == "tls" else 587)

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    smtp = FakeSMTP.instances[-1]
    context = smtp.kwargs["tls_context"]
    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    expected_kwargs = {
        "hostname": "smtp.example.test",
        "port": config["port"],
        "use_tls": security == "tls",
        "tls_context": context,
        "timeout": 5,
    }
    if security == "starttls":
        expected_kwargs["start_tls"] = False
    assert smtp.kwargs == expected_kwargs
    names = [name for name, _ in smtp.calls]
    assert names == (["connect", "starttls", "login", "send_message", "quit"] if security == "starttls" else ["connect", "login", "send_message", "quit"])
    if security == "starttls":
        assert smtp.calls[1][1]["timeout"] == 11
    login = next(value for name, value in smtp.calls if name == "login")
    assert login == (" smtp-user ", " smtp-secret ", {"timeout": 11})
    sent = next(value for name, value in smtp.calls if name == "send_message")
    assert sent[1] == {"timeout": 11}
    assert result.delivered is True
    assert "smtp-secret" not in repr(result)


@pytest.mark.parametrize(
    ("failure", "reason"),
    [(ConnectionRefusedError("smtp-secret leaked"), "failed"), (TimeoutError("smtp-secret leaked"), "unknown")],
)
def test_send_returns_generic_failure_and_closes_after_refusal_or_timeout(
    auth_mail, failure, reason
):
    FakeSMTP.instances.clear()
    FakeSMTP.send_error = failure
    config = _config()

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    smtp = FakeSMTP.instances[-1]
    names = [name for name, _ in smtp.calls]
    assert names[-2:] == ["quit", "close"]
    assert result.delivered is False
    assert result.reason == reason
    assert "smtp-secret" not in repr(result)
    assert "smtp-secret" not in str(result)


def test_send_classifies_returned_recipient_refusal_without_exposing_details(auth_mail):
    _reset_fake()
    FakeSMTP.send_result = (
        {"rendref+music@example.test": (550, "smtp-secret mailbox rejected")},
        "partial refusal",
    )
    config = _config()

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    assert result.delivered is False
    assert result.reason == "refused"
    assert "smtp-secret" not in repr(result)
    assert "smtp-secret" not in str(result)


def test_validated_plaintext_loopback_uses_no_tls_or_starttls(auth_mail):
    _reset_fake()
    config = _config(
        host="127.0.0.1",
        port=1025,
        security="plaintext",
        username=None,
        password=None,
    )

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    smtp = FakeSMTP.instances[-1]
    assert smtp.kwargs == {
        "hostname": "127.0.0.1",
        "port": 1025,
        "use_tls": False,
        "timeout": 5,
    }
    assert "starttls" not in [name for name, _ in smtp.calls]
    assert "login" not in [name for name, _ in smtp.calls]
    assert result.delivered is True


@pytest.mark.parametrize(
    "config",
    [
        _config(security="smtps-plus"),
        _config(security="plaintext", host="smtp.example.test"),
    ],
)
def test_send_fails_closed_on_invalid_transport_without_constructing_smtp(
    auth_mail, config
):
    calls = []

    def forbidden_factory(**kwargs):
        calls.append(kwargs)
        raise AssertionError("SMTP factory must not be called")

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=forbidden_factory
        )
    )

    assert result.delivered is False
    assert result.reason == "invalid_config"
    assert calls == []


@pytest.mark.parametrize("phase", ["connect", "starttls", "login"])
def test_pre_send_timeout_is_definite_and_closes(auth_mail, phase):
    _reset_fake(phase_errors={phase: TimeoutError("timed out")})
    config = _config()

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    assert result == auth_mail.DeliveryResult(delivered=False, reason="timeout")
    assert FakeSMTP.instances[-1].calls[-1][0] == "close"


def test_factory_timeout_is_definite_without_a_connection_to_close(auth_mail):
    def timed_out_factory(**kwargs):
        raise TimeoutError("timed out")

    config = _config()
    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=timed_out_factory
        )
    )

    assert result == auth_mail.DeliveryResult(delivered=False, reason="timeout")


def test_send_timeout_is_ambiguous_and_closes(auth_mail):
    _reset_fake(phase_errors={"send": TimeoutError("timed out")})
    config = _config()

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    assert result == auth_mail.DeliveryResult(delivered=False, reason="unknown")
    assert FakeSMTP.instances[-1].calls[-1][0] == "close"


@pytest.mark.parametrize(
    "failure",
    [
        SMTPRecipientRefused(550, "mailbox rejected", "rendref@example.test"),
        SMTPRecipientsRefused(
            [SMTPRecipientRefused(550, "mailbox rejected", "rendref@example.test")]
        ),
    ],
)
def test_raised_aiosmtplib_recipient_refusal_is_generic_and_closes(
    auth_mail, failure
):
    _reset_fake(phase_errors={"send": failure})
    config = _config()

    result = asyncio.run(
        auth_mail.send_auth_email(
            _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
        )
    )

    assert result == auth_mail.DeliveryResult(delivered=False, reason="refused")
    assert FakeSMTP.instances[-1].calls[-1][0] == "close"


@pytest.mark.parametrize("phase", ["connect", "starttls", "login", "send", "quit"])
def test_cancellation_at_every_async_phase_propagates_and_closes(auth_mail, phase):
    _reset_fake(phase_errors={phase: asyncio.CancelledError()})
    config = _config()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            auth_mail.send_auth_email(
                _welcome(auth_mail, config), config=config, smtp_factory=FakeSMTP
            )
        )

    assert FakeSMTP.instances[-1].calls[-1][0] == "close"
