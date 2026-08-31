"""Opaque browser-session persistence for local authentication."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import hmac
from typing import Any
import unicodedata

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
_RESOLVED_COLUMNS = (
    "session_id",
    "account_id",
    "is_active",
    "disabled_at",
    "created_at",
    "authenticated_at",
    "last_seen_at",
    "idle_expires_at",
    "absolute_expires_at",
    "revoked_at",
    "revocation_reason",
    "user_agent",
)


class SessionRevocationReason(str, Enum):
    LOGOUT = "logout"
    PASSWORD_RESET = "password_reset"
    PASSWORD_CHANGE = "password_change"
    ACCOUNT_DISABLED = "account_disabled"
    ADMIN_REVOKE = "admin_revoke"
    SESSION_CAP = "session_cap"
    IDLE_EXPIRED = "idle_expired"
    ABSOLUTE_EXPIRED = "absolute_expired"


@dataclass(frozen=True, repr=False, slots=True)
class IssuedBrowserSession:
    raw_token: str
    session_id: int
    account_id: int
    authenticated_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(raw_token=<redacted>, "
            f"session_id={self.session_id!r}, account_id={self.account_id!r}, "
            f"authenticated_at={self.authenticated_at!r}, "
            f"idle_expires_at={self.idle_expires_at!r}, "
            f"absolute_expires_at={self.absolute_expires_at!r})"
        )


@dataclass(frozen=True, slots=True)
class ResolvedBrowserSession:
    session_id: int
    account_id: int
    created_at: datetime
    authenticated_at: datetime
    last_seen_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime
    user_agent: str | None


class PostgresAuthSessionService:
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
                "ALBUM_HAVEN_APP_DATABASE_URL is required for auth sessions."
            )
        session = payload.get("session")
        session_policy = session if isinstance(session, Mapping) else {}
        self._idle_seconds = _positive_integer(
            session_policy.get("idle_seconds", 12 * 60 * 60), "idle lifetime"
        )
        self._absolute_seconds = _positive_integer(
            session_policy.get("absolute_seconds", 7 * 24 * 60 * 60),
            "absolute lifetime",
        )
        self._activity_seconds = _positive_integer(
            session_policy.get("activity_write_seconds", 5 * 60),
            "activity interval",
        )
        compatibility_cap = session_policy.get("active_cap", 10)
        self._active_cap = _positive_integer(
            payload.get("active_session_cap", compatibility_cap), "active session cap"
        )
        if self._idle_seconds > self._absolute_seconds:
            raise ValueError("Session lifetime configuration is invalid.")
        self._connect = connect or _connect
        self._token_issuer = token_issuer
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def issue_session(
        self,
        account_id: int,
        user_agent: str | None = None,
        connection: Any | None = None,
    ) -> IssuedBrowserSession:
        account_id = _positive_integer(account_id, "account id")
        user_agent = _validated_user_agent(user_agent)
        issued = _issued_token(self._token_issuer)
        now = _aware_now(self._clock)
        idle_expires_at = now + timedelta(seconds=self._idle_seconds)
        absolute_expires_at = now + timedelta(seconds=self._absolute_seconds)

        with self._operation(connection) as active_connection:
            account_rows = _fetchall(active_connection,
                """
                select id, is_active, disabled_at
                from app.accounts
                where id = %s
                for update
                """,
                (account_id,),
            )
            if len(account_rows) != 1 or not _account_is_active(account_rows[0]):
                raise RuntimeError("Account is not eligible for a session.")

            active_rows = _fetchall(active_connection,
                """
                select id
                from app.account_sessions
                where account_id = %s
                  and revoked_at is null
                  and idle_expires_at > %s
                  and absolute_expires_at > %s
                order by created_at, id
                for update
                """,
                (account_id, now, now),
            )
            excess = max(0, len(active_rows) + 1 - self._active_cap)
            if excess:
                oldest_ids = [
                    _positive_integer(_row(row, ("id",)).get("id"), "session id")
                    for row in active_rows[:excess]
                ]
                _execute(active_connection,
                    """
                    update app.account_sessions
                    set revoked_at = %s, revocation_reason = %s
                    where id = any(%s) and revoked_at is null
                    """,
                    (now, SessionRevocationReason.SESSION_CAP.value, oldest_ids),
                )

            inserted = _fetchone(active_connection,
                """
                insert into app.account_sessions (
                  account_id, session_token_hash, created_at, authenticated_at,
                  last_seen_at, idle_expires_at, absolute_expires_at, user_agent
                ) values (%s, %s, %s, %s, %s, %s, %s, %s)
                returning id
                """,
                (
                    account_id,
                    issued.digest,
                    now,
                    now,
                    now,
                    idle_expires_at,
                    absolute_expires_at,
                    user_agent,
                ),
            )
            session_id = _positive_integer(
                _row(inserted, ("id",)).get("id"), "session id"
            )

        return IssuedBrowserSession(
            raw_token=issued.raw,
            session_id=session_id,
            account_id=account_id,
            authenticated_at=now,
            idle_expires_at=idle_expires_at,
            absolute_expires_at=absolute_expires_at,
        )

    def resolve_session(self, raw_token: object) -> ResolvedBrowserSession | None:
        digest = _token_digest(raw_token)
        if digest is None:
            return None
        now = _aware_now(self._clock)
        with self._operation(None) as connection:
            locked = _discover_and_lock_session(connection, digest)
            if locked is None:
                return None
            payload, account = locked
            if (
                not _account_is_active(account)
                or not _account_is_active(payload)
                or payload.get("revoked_at") is not None
            ):
                return None
            idle_expiry = _datetime_field(payload, "idle_expires_at")
            absolute_expiry = _datetime_field(payload, "absolute_expires_at")
            if now >= idle_expiry or now >= absolute_expiry:
                return None

            last_seen = _datetime_field(payload, "last_seen_at")
            if now - last_seen >= timedelta(seconds=self._activity_seconds):
                last_seen = now
                idle_expiry = min(
                    now + timedelta(seconds=self._idle_seconds), absolute_expiry
                )
                _execute(connection,
                    """
                    update app.account_sessions
                    set last_seen_at = %s, idle_expires_at = %s
                    where id = %s and revoked_at is null
                    """,
                    (last_seen, idle_expiry, payload.get("session_id")),
                )

            return ResolvedBrowserSession(
                session_id=_positive_integer(payload.get("session_id"), "session id"),
                account_id=_positive_integer(payload.get("account_id"), "account id"),
                created_at=_datetime_field(payload, "created_at"),
                authenticated_at=_datetime_field(payload, "authenticated_at"),
                last_seen_at=last_seen,
                idle_expires_at=idle_expiry,
                absolute_expires_at=absolute_expiry,
                user_agent=(
                    str(payload["user_agent"])
                    if payload.get("user_agent") is not None
                    else None
                ),
            )

    def revoke_current(
        self,
        raw_token: object,
        reason: SessionRevocationReason = SessionRevocationReason.LOGOUT,
    ) -> bool:
        reason = _revocation_reason(reason)
        digest = _token_digest(raw_token)
        if digest is None:
            return False
        now = _aware_now(self._clock)
        with self._operation(None) as connection:
            locked = _discover_and_lock_session(connection, digest)
            if locked is None:
                return False
            payload, _account = locked
            session_id = _positive_integer(
                payload.get("session_id"),
                "session id",
            )
            cursor = _execute(connection,
                """
                update app.account_sessions
                set revoked_at = %s, revocation_reason = %s
                where id = %s and revoked_at is null
                returning id
                """,
                (now, reason.value, session_id),
            )
            rows = _cursor_rows(cursor)
            rowcount = getattr(cursor, "rowcount", None)
            return bool(rows) or rowcount == 1

    def revoke_all(
        self,
        account_id: int,
        reason: SessionRevocationReason,
        connection: Any | None = None,
    ) -> int:
        account_id = _positive_integer(account_id, "account id")
        reason = _revocation_reason(reason)
        now = _aware_now(self._clock)
        with self._operation(connection) as active_connection:
            accounts = _fetchall(active_connection,
                "select id from app.accounts where id = %s for update",
                (account_id,),
            )
            if len(accounts) != 1:
                raise RuntimeError("Account session context is invalid.")
            active_rows = _fetchall(active_connection,
                """
                select id
                from app.account_sessions
                where account_id = %s and revoked_at is null
                order by created_at, id
                for update
                """,
                (account_id,),
            )
            cursor = _execute(active_connection,
                """
                update app.account_sessions
                set revoked_at = %s, revocation_reason = %s
                where account_id = %s and revoked_at is null
                """,
                (now, reason.value, account_id),
            )
            rowcount = getattr(cursor, "rowcount", None)
            return int(rowcount) if isinstance(rowcount, int) and rowcount >= 0 else len(active_rows)

    @contextmanager
    def _operation(self, connection: Any | None) -> Iterator[Any]:
        if connection is not None:
            yield connection
            return
        with self._connect(self._database_url) as owned_connection:
            transaction = getattr(owned_connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError("Postgres auth sessions require transaction support.")
            with transaction():
                yield owned_connection


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for auth sessions.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _issued_token(issuer: Callable[[], object]) -> IssuedOpaqueToken:
    try:
        value = issuer()
        if isinstance(value, IssuedOpaqueToken):
            expected_digest = hash_opaque_token(value.raw)
            if (
                len(value.digest) != 32
                or not hmac.compare_digest(expected_digest, value.digest)
            ):
                raise ValueError
            return value
        if isinstance(value, str):
            return IssuedOpaqueToken(raw=value, digest=hash_opaque_token(value))
    except Exception:
        raise ValueError("Unable to issue secure session token.") from None
    raise ValueError("Unable to issue secure session token.")


def _token_digest(raw_token: object) -> bytes | None:
    try:
        return hash_opaque_token(raw_token)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Invalid {label}.")
    return value


def _aware_now(clock: Callable[[], datetime]) -> datetime:
    try:
        value = clock()
    except Exception:
        raise RuntimeError("Session clock is unavailable.") from None
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise RuntimeError("Session clock must return an aware timestamp.")
    return value


def _validated_user_agent(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 1024:
        raise ValueError("Invalid session user agent.")
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise ValueError("Invalid session user agent.")
    return value


def _revocation_reason(value: object) -> SessionRevocationReason:
    if not isinstance(value, SessionRevocationReason):
        raise TypeError("Session revocation reason is invalid.")
    return value


def _row(row: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)):
        return dict(zip(columns, row, strict=False))
    return {}


def _account_is_active(row: object) -> bool:
    payload = _row(row, ("id", "is_active", "disabled_at"))
    return payload.get("is_active") is True and payload.get("disabled_at") is None


def _datetime_field(row: Mapping[str, object], key: str) -> datetime:
    value = row.get(key)
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise RuntimeError("Session persistence returned an invalid timestamp.")
    return value


def _discover_and_lock_session(
    connection: Any, digest: bytes
) -> tuple[Mapping[str, object], Mapping[str, object]] | None:
    discovery_rows = _fetchall(
        connection,
        """
        select s.id as session_id, s.account_id,
               a.is_active, a.disabled_at, s.created_at,
               s.authenticated_at, s.last_seen_at, s.idle_expires_at,
               s.absolute_expires_at, s.revoked_at,
               s.revocation_reason, s.user_agent
        from app.account_sessions s
        join app.accounts a on a.id = s.account_id
        where s.session_token_hash = %s
        """,
        (digest,),
    )
    if len(discovery_rows) != 1:
        return None
    discovered = _row(discovery_rows[0], _RESOLVED_COLUMNS)
    account_id = _positive_integer(discovered.get("account_id"), "account id")

    account_rows = _fetchall(
        connection,
        """
        select id, is_active, disabled_at
        from app.accounts
        where id = %s
        for update
        """,
        (account_id,),
    )
    if len(account_rows) != 1:
        return None
    account = _row(account_rows[0], ("id", "is_active", "disabled_at"))

    locked_rows = _fetchall(
        connection,
        """
        select s.id as session_id, s.account_id,
               a.is_active, a.disabled_at, s.created_at,
               s.authenticated_at, s.last_seen_at, s.idle_expires_at,
               s.absolute_expires_at, s.revoked_at,
               s.revocation_reason, s.user_agent
        from app.account_sessions s
        join app.accounts a on a.id = s.account_id
        where s.session_token_hash = %s
          and s.account_id = %s
        order by s.created_at, s.id
        for update of s
        """,
        (digest, account_id),
    )
    if len(locked_rows) != 1:
        return None
    return _row(locked_rows[0], _RESOLVED_COLUMNS), account


def _execute(connection: Any, sql: str, params: object = None) -> Any:
    try:
        return connection.execute(sql, params)
    except Exception:
        raise RuntimeError("Session persistence operation failed.") from None


def _cursor_rows(cursor: Any) -> list[object]:
    try:
        return list(cursor.fetchall())
    except Exception:
        raise RuntimeError("Session persistence operation failed.") from None


def _fetchall(connection: Any, sql: str, params: object = None) -> list[object]:
    return _cursor_rows(_execute(connection, sql, params))


def _fetchone(connection: Any, sql: str, params: object = None) -> object | None:
    try:
        return _execute(connection, sql, params).fetchone()
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("Session persistence operation failed.") from None
