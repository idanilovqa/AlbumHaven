"""Compose and deliver authentication mail without exposing sensitive values."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from html import escape
import ssl
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlencode

from aiosmtplib import SMTP
from aiosmtplib.errors import SMTPRecipientRefused, SMTPRecipientsRefused

from music_app.services.auth_config import normalize_email_address
from music_app.services.mail_config import build_public_url


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    """A deliberately small, safe-to-log SMTP delivery outcome."""

    delivered: bool
    reason: str


def _reject_line_breaks(value: str, field: str) -> None:
    if "\r" in value or "\n" in value:
        raise ValueError(f"{field} cannot contain line breaks")


def _message_headers(
    message: EmailMessage, *, recipient: str, config: Mapping[str, Any]
) -> None:
    normalized_recipient = normalize_email_address(recipient, "recipient")
    sender = normalize_email_address(str(config["sender_address"]), "sender address")
    sender_name = str(config["sender_name"])
    _reject_line_breaks(sender_name, "sender name")
    message["To"] = normalized_recipient
    message["From"] = formataddr((sender_name, sender))


def _multipart_message(
    *,
    subject: str,
    username: str,
    recipient: str,
    text: str,
    html: str,
    config: Mapping[str, Any],
) -> EmailMessage:
    _reject_line_breaks(username, "username")
    message = EmailMessage()
    _message_headers(message, recipient=recipient, config=config)
    message["Subject"] = subject
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    return message


def compose_welcome_email(
    *, username: str, recipient: str, config: Mapping[str, Any]
) -> EmailMessage:
    """Build the password-free welcome message for an active account."""

    _reject_line_breaks(username, "username")
    login_url = build_public_url(str(config["public_base_url"]), "/login")
    return _multipart_message(
        subject="Welcome to Album Haven",
        username=username,
        recipient=recipient,
        text=(
            f"Welcome to Album Haven, {username}.\n\n"
            f"Sign in at {login_url}\n"
        ),
        html=(
            "<p>Welcome to Album Haven, "
            f"{escape(username)}.</p>"
            f'<p><a href="{escape(login_url, quote=True)}">Sign in to Album Haven</a></p>'
        ),
        config=config,
    )


def compose_password_reset_email(
    *, username: str, recipient: str, token: str, config: Mapping[str, Any]
) -> EmailMessage:
    """Build a purpose-bound password-reset message containing an opaque token."""

    _reject_line_breaks(username, "username")
    _reject_line_breaks(token, "reset token")
    reset_page_url = build_public_url(
        str(config["public_base_url"]), "/reset-password"
    )
    reset_url = reset_page_url + "?" + urlencode(
        {"purpose": "password-reset", "token": token}, quote_via=quote
    )
    return _multipart_message(
        subject="Reset your Album Haven password",
        username=username,
        recipient=recipient,
        text=(
            f"Hello {username},\n\n"
            f"Use this single-use link to reset your Album Haven sign-in: {reset_url}\n"
        ),
        html=(
            f"<p>Hello {escape(username)},</p>"
            f'<p><a href="{escape(reset_url, quote=True)}">Reset your Album Haven sign-in</a></p>'
        ),
        config=config,
    )


def _has_refusals(send_result: Any) -> bool:
    refusals = send_result[0] if isinstance(send_result, tuple) else send_result
    return isinstance(refusals, Mapping) and bool(refusals)


async def _cleanup_failed_smtp(smtp: Any, command_timeout: int) -> None:
    try:
        await smtp.quit(timeout=command_timeout)
    except Exception:
        pass
    finally:
        smtp.close()


def _failure_result(exc: Exception, *, send_started: bool) -> DeliveryResult:
    if isinstance(exc, (SMTPRecipientRefused, SMTPRecipientsRefused)):
        return DeliveryResult(delivered=False, reason="refused")
    if isinstance(exc, ConnectionRefusedError):
        return DeliveryResult(delivered=False, reason="failed")
    if isinstance(exc, TimeoutError):
        reason = "unknown" if send_started else "timeout"
        return DeliveryResult(delivered=False, reason=reason)
    return DeliveryResult(delivered=False, reason="failed")


async def send_auth_email(
    message: EmailMessage,
    *,
    config: Mapping[str, Any],
    smtp_factory: Callable[..., Any] = SMTP,
) -> DeliveryResult:
    """Submit one authentication email through a validated SMTP configuration."""

    security = str(config["security"])
    host = str(config["host"])
    if security not in {"tls", "starttls", "plaintext"} or (
        security == "plaintext"
        and host.casefold() not in {"localhost", "127.0.0.1", "::1"}
    ):
        return DeliveryResult(delivered=False, reason="invalid_config")

    command_timeout = config["command_timeout_seconds"]
    smtp_kwargs: dict[str, Any] = {
        "hostname": host,
        "port": config["port"],
        "use_tls": security == "tls",
        "timeout": config["connect_timeout_seconds"],
    }
    if security in {"tls", "starttls"}:
        smtp_kwargs["tls_context"] = ssl.create_default_context()
    if security == "starttls":
        smtp_kwargs["start_tls"] = False

    try:
        smtp = smtp_factory(**smtp_kwargs)
    except Exception as exc:
        return _failure_result(exc, send_started=False)

    send_started = False
    try:
        await smtp.connect()
        if security == "starttls":
            await smtp.starttls(timeout=command_timeout)
        if config.get("username") is not None:
            await smtp.login(
                config["username"], config["password"], timeout=command_timeout
            )
        send_started = True
        send_result = await smtp.send_message(message, timeout=command_timeout)
    except asyncio.CancelledError:
        await _cleanup_failed_smtp(smtp, command_timeout)
        raise
    except Exception as exc:
        await _cleanup_failed_smtp(smtp, command_timeout)
        return _failure_result(exc, send_started=send_started)

    try:
        await smtp.quit(timeout=command_timeout)
    except asyncio.CancelledError:
        smtp.close()
        raise
    except Exception:
        smtp.close()

    if _has_refusals(send_result):
        return DeliveryResult(delivered=False, reason="refused")
    return DeliveryResult(delivered=True, reason="delivered")
