"""Validated, secret-redacting SMTP delivery configuration."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from music_app.services.auth_config import (
    normalize_email_address,
    normalize_host,
    validate_public_base_url,
)


class MailConfig(dict[str, Any]):
    """Dictionary-compatible mail config whose representation omits credentials."""

    def __repr__(self) -> str:
        safe = dict(self)
        if safe.get("password") is not None:
            safe["password"] = "<redacted>"
        return repr(safe)


def _boolean(env: Mapping[str, str], key: str, default: bool = False) -> bool:
    raw = env.get(key)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"true", "1", "yes", "on"}:
        return True
    if value in {"false", "0", "no", "off"}:
        return False
    raise ValueError(f"{key} must be true or false")


def _integer(
    env: Mapping[str, str], key: str, default: int, *, maximum: int | None = None
) -> int:
    raw = env.get(key)
    try:
        value = default if raw is None else int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key} must be at most {maximum}")
    return value


def _mail_field(env: Mapping[str, str], key: str, *, required: bool) -> str | None:
    raw = env.get(key)
    value = None if raw is None else raw.strip()
    if required and not value:
        raise ValueError(f"{key} is required when email delivery is enabled")
    if value is not None and ("\r" in value or "\n" in value):
        raise ValueError(f"{key} cannot contain line breaks")
    return value or None


def _credential(env: Mapping[str, str], key: str) -> str | None:
    if key not in env:
        return None
    value = env.get(key)
    if value is None or value == "":
        raise ValueError(f"{key} cannot be empty")
    if "\r" in value or "\n" in value:
        raise ValueError(f"{key} cannot contain line breaks")
    return value


def build_public_url(base_url: str, path: str) -> str:
    """Join an application-relative path without discarding a base path prefix."""

    base = validate_public_base_url(base_url)
    parsed_path = urlsplit(path)
    if parsed_path.scheme or parsed_path.netloc or parsed_path.query or parsed_path.fragment:
        raise ValueError("public URL path must be application-relative")
    return f"{base.rstrip('/')}/{parsed_path.path.lstrip('/')}"


def build_mail_config(env: Mapping[str, str]) -> MailConfig:
    """Build SMTP configuration and reject insecure production transport."""

    welcome_enabled = _boolean(env, "ALBUM_HAVEN_WELCOME_EMAIL_ENABLED")
    reset_enabled = _boolean(env, "ALBUM_HAVEN_PASSWORD_RESET_EMAIL_ENABLED")
    invitation_enabled = _boolean(env, "ALBUM_HAVEN_INVITATION_EMAIL_ENABLED")
    delivery_enabled = welcome_enabled or reset_enabled or invitation_enabled

    base_raw = env.get("ALBUM_HAVEN_PUBLIC_BASE_URL", "").strip()
    if delivery_enabled and not base_raw:
        raise ValueError(
            "ALBUM_HAVEN_PUBLIC_BASE_URL is required when email delivery is enabled"
        )
    public_base_url = validate_public_base_url(base_raw) if base_raw else None

    host = _mail_field(env, "ALBUM_HAVEN_SMTP_HOST", required=delivery_enabled)
    if host is not None:
        try:
            host = normalize_host(host, "ALBUM_HAVEN_SMTP_HOST")
        except ValueError as exc:
            raise ValueError("ALBUM_HAVEN_SMTP_HOST must be a valid host") from exc
    sender_address = _mail_field(
        env, "ALBUM_HAVEN_SMTP_FROM_ADDRESS", required=delivery_enabled
    )
    if sender_address is not None:
        try:
            sender_address = normalize_email_address(
                sender_address, "ALBUM_HAVEN_SMTP_FROM_ADDRESS"
            )
        except ValueError as exc:
            raise ValueError(
                "ALBUM_HAVEN_SMTP_FROM_ADDRESS must be a valid email address"
            ) from exc
    sender_name = _mail_field(env, "ALBUM_HAVEN_SMTP_FROM_NAME", required=False)
    username = _credential(env, "ALBUM_HAVEN_SMTP_USERNAME")
    password = _credential(env, "ALBUM_HAVEN_SMTP_PASSWORD")
    if (username is None) != (password is None):
        missing = (
            "ALBUM_HAVEN_SMTP_PASSWORD"
            if username is not None
            else "ALBUM_HAVEN_SMTP_USERNAME"
        )
        raise ValueError(f"{missing} is required when SMTP credentials are configured")

    security = env.get("ALBUM_HAVEN_SMTP_SECURITY", "starttls").strip().lower()
    if security not in {"tls", "starttls", "plaintext"}:
        raise ValueError(
            "ALBUM_HAVEN_SMTP_SECURITY must be tls, starttls, or plaintext"
        )
    if security == "plaintext":
        loopback = host is not None and host.lower() in {"localhost", "127.0.0.1", "::1"}
        if not loopback or not _boolean(
            env, "ALBUM_HAVEN_SMTP_ALLOW_PLAINTEXT_LOOPBACK"
        ):
            raise ValueError(
                "plaintext SMTP is allowed only for an explicitly enabled loopback fake"
            )

    return MailConfig(
        public_base_url=public_base_url,
        welcome_enabled=welcome_enabled,
        password_reset_enabled=reset_enabled,
        invitation_enabled=invitation_enabled,
        host=host,
        port=_integer(env, "ALBUM_HAVEN_SMTP_PORT", 587, maximum=65_535),
        security=security,
        username=username,
        password=password,
        sender_address=sender_address,
        sender_name=sender_name or "Album Haven",
        connect_timeout_seconds=_integer(
            env, "ALBUM_HAVEN_SMTP_CONNECT_TIMEOUT_SECONDS", 10
        ),
        command_timeout_seconds=_integer(
            env, "ALBUM_HAVEN_SMTP_COMMAND_TIMEOUT_SECONDS", 30
        ),
    )
