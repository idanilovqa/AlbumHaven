"""Durable one-time pre-authentication state for public login CSRF."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
    issue_opaque_token,
)

try:  # pragma: no cover - exercised when the optional driver is installed.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_LOGIN_PURPOSE = "login"
_FORGOT_PURPOSE = "forgot_password"
_MAXIMUM_TTL_SECONDS = 600
_CLEANUP_BATCH_SIZE = 100


@dataclass(frozen=True, repr=False, slots=True)
class IssuedPreAuthToken:
    raw_token: str
    token_id: int
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(raw_token=<redacted>, "
            f"token_id={self.token_id!r}, expires_at={self.expires_at!r})"
        )


class PostgresPreAuthCsrfService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        token_issuer: Callable[[], object] = issue_opaque_token,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for pre-authentication state."
            )
        self._ttl_seconds = _ttl_seconds(payload.get("preauth_token_seconds", 600))
        if not callable(token_issuer):
            raise TypeError("Pre-authentication token provider is invalid.")
        self._connect = connect or _connect
        self._token_issuer = token_issuer
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def issue_login_token(self) -> IssuedPreAuthToken:
        return self._issue_token(_LOGIN_PURPOSE)

    def issue_forgot_token(self) -> IssuedPreAuthToken:
        return self._issue_token(_FORGOT_PURPOSE)

    def _issue_token(self, purpose: str) -> IssuedPreAuthToken:
        now = _aware_now(self._clock)
        issued = _issued_token(self._token_issuer)
        expires_at = now + timedelta(seconds=self._ttl_seconds)
        with self._operation() as connection:
            _execute(
                connection,
                """
                delete from app.auth_preflight_tokens
                where id in (
                  select id from app.auth_preflight_tokens
                  where expires_at <= %s
                  order by expires_at, id
                  limit %s
                )
                """,
                (now, _CLEANUP_BATCH_SIZE),
            )
            rows = _fetchall(
                connection,
                """
                insert into app.auth_preflight_tokens (
                  token_hash, purpose, created_at, expires_at
                ) values (%s, %s, %s, %s)
                returning id
                """,
                (issued.digest, purpose, now, expires_at),
            )
            token_id = _single_returned_id(rows)
        return IssuedPreAuthToken(
            raw_token=issued.raw,
            token_id=token_id,
            expires_at=expires_at,
        )

    def consume_login_token(self, raw_token: object) -> bool:
        return self._consume_token(raw_token, _LOGIN_PURPOSE)

    def consume_forgot_token(self, raw_token: object) -> bool:
        return self._consume_token(raw_token, _FORGOT_PURPOSE)

    def _consume_token(self, raw_token: object, purpose: str) -> bool:
        try:
            digest = hash_opaque_token(raw_token)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
        now = _aware_now(self._clock)
        with self._operation() as connection:
            rows = _fetchall(
                connection,
                """
                update app.auth_preflight_tokens
                set consumed_at = %s
                where purpose = %s and token_hash = %s
                  and consumed_at is null and expires_at > %s
                returning id
                """,
                (now, purpose, digest, now),
            )
            if not rows:
                return False
            _single_returned_id(rows)
            return True

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        try:
            with self._connect(self._database_url) as connection:
                transaction = getattr(connection, "transaction", None)
                if not callable(transaction):
                    raise RuntimeError
                with transaction():
                    yield connection
        except Exception:
            raise RuntimeError("Pre-authentication persistence operation failed.") from None


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for pre-authentication state.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _fetchall(connection: Any, sql: str, params: object) -> list[object]:
    try:
        return list(_execute(connection, sql, params).fetchall())
    except Exception:
        raise RuntimeError("Pre-authentication persistence operation failed.") from None


def _execute(connection: Any, sql: str, params: object) -> Any:
    try:
        return connection.execute(sql, params)
    except Exception:
        raise RuntimeError("Pre-authentication persistence operation failed.") from None


def _single_returned_id(rows: list[object]) -> int:
    if len(rows) != 1:
        raise RuntimeError("Pre-authentication persistence operation failed.")
    row = rows[0]
    if isinstance(row, Mapping):
        value = row.get("id")
    elif isinstance(row, (tuple, list)) and row:
        value = row[0]
    else:
        value = None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise RuntimeError("Pre-authentication persistence operation failed.")
    return value


def _issued_token(provider: Callable[[], object]) -> IssuedOpaqueToken:
    try:
        value = provider()
        if not isinstance(value, IssuedOpaqueToken):
            raise ValueError
        expected_digest = hash_opaque_token(value.raw)
        if value.digest != expected_digest:
            raise ValueError
    except Exception:
        raise RuntimeError("Pre-authentication token issuance failed.") from None
    return value


def _aware_now(clock: Callable[[], datetime]) -> datetime:
    try:
        value = clock()
        if (
            not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() is None
        ):
            raise ValueError
        return value.astimezone(timezone.utc)
    except Exception:
        raise RuntimeError("Pre-authentication clock is unavailable.") from None


def _ttl_seconds(value: object) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > _MAXIMUM_TTL_SECONDS
    ):
        raise ValueError("Pre-authentication token lifetime is invalid.")
    return value
