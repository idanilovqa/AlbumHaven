"""Authenticated self-service password changes for Profile/Account."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import re
from typing import Any, Iterator

from music_app.services.auth_audit_postgres import (
    CredentialAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_passwords import (
    PasswordCredential,
    PasswordVerification,
    hash_password,
    verify_password,
)

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_SNAPSHOT_COLUMNS = (
    "account_id",
    "username_display",
    "contact_email",
    "is_active",
    "disabled_at",
    "encoded_hash",
    "hash_policy_version",
    "credential_version",
    "administrator_set",
)


class ProfilePasswordOutcome(str, Enum):
    SUCCESS = "success"
    CURRENT_PASSWORD_INVALID = "current_password_invalid"
    STALE = "stale"


@dataclass(frozen=True, slots=True)
class ProfileSessionView:
    session_id: int
    device_label: str
    last_seen_at: datetime
    current: bool


@dataclass(frozen=True, slots=True)
class ProfileAccountView:
    username: str
    administrator_set_suggestion: bool
    sessions: tuple[ProfileSessionView, ...]


@dataclass(frozen=True, repr=False, slots=True)
class _CredentialSnapshot:
    account_id: int
    username: str
    email: str
    encoded_hash: str
    hash_policy_version: int
    credential_version: int
    administrator_set: bool

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(account_id={self.account_id!r}, "
            "username=<redacted>, email=<redacted>, encoded_hash=<redacted>, "
            "hash_policy_version=<redacted>, credential_version=<redacted>, "
            "administrator_set=<redacted>)"
        )


class PostgresProfilePasswordService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        verifier: Callable[..., PasswordVerification] = verify_password,
        password_hasher: Callable[..., PasswordCredential] = hash_password,
        breached_checker: Callable[[str], bool],
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for profile credentials."
            )
        argon2 = payload.get("argon2")
        if not isinstance(argon2, Mapping):
            raise ValueError("Profile password configuration is invalid.")
        self._argon2 = dict(argon2)
        self._policy_version = _positive_integer(
            payload.get("argon2_policy_version"), "Argon2 policy version"
        )
        if not all(callable(item) for item in (verifier, password_hasher, breached_checker)):
            raise TypeError("Profile password provider is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Profile password audit repository is invalid.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._verifier = verifier
        self._password_hasher = password_hasher
        self._breached_checker = breached_checker
        self._audit = audit_repository

    def load_profile(
        self,
        *,
        account_id: object,
        current_session_id: object,
    ) -> ProfileAccountView | None:
        account_id = _positive_integer(account_id, "account id")
        current_session_id = _positive_integer(current_session_id, "session id")
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                accounts = connection.execute(
                    """
                    select app.accounts.username_display,
                           app.account_credentials.administrator_set
                    from app.accounts
                    join app.account_credentials
                      on app.account_credentials.account_id = app.accounts.id
                    where app.accounts.id = %s and app.accounts.is_active is true
                      and app.accounts.disabled_at is null
                    """,
                    (account_id,),
                ).fetchall()
                sessions = connection.execute(
                    """
                    select id, user_agent, last_seen_at
                    from app.account_sessions
                    where account_id = %s and revoked_at is null
                      and idle_expires_at > %s and absolute_expires_at > %s
                    order by case when id = %s then 0 else 1 end,
                             last_seen_at desc, id
                    """,
                    (account_id, now, now, current_session_id),
                ).fetchall()
            if len(accounts) != 1:
                return None
            account = _row(accounts[0], ("username_display", "administrator_set"))
            views = tuple(
                ProfileSessionView(
                    session_id=_positive_integer(
                        _row(item, ("id", "user_agent", "last_seen_at")).get("id"),
                        "session id",
                    ),
                    device_label=_session_device_label(
                        _row(item, ("id", "user_agent", "last_seen_at")).get(
                            "user_agent"
                        )
                    ),
                    last_seen_at=_aware_utc(
                        _row(item, ("id", "user_agent", "last_seen_at")).get("last_seen_at")
                    ),
                    current=(
                        _row(item, ("id", "user_agent", "last_seen_at")).get("id")
                        == current_session_id
                    ),
                )
                for item in sessions
            )
            if not any(item.current for item in views):
                return None
            return ProfileAccountView(
                username=_required_text(account.get("username_display"), "username"),
                administrator_set_suggestion=account.get("administrator_set") is True,
                sessions=views,
            )
        except Exception:
            raise RuntimeError("Profile view persistence failed.") from None

    def change_password(
        self,
        *,
        account_id: object,
        current_session_id: object,
        current_password: object,
        new_password: object,
        request_ref: object,
    ) -> ProfilePasswordOutcome:
        account_id = _positive_integer(account_id, "account id")
        current_session_id = _positive_integer(current_session_id, "session id")
        request_ref = _request_ref(request_ref)
        now = _aware_utc(self._clock())
        if not isinstance(current_password, str) or not isinstance(new_password, str):
            return ProfilePasswordOutcome.CURRENT_PASSWORD_INVALID
        snapshot = self._load_snapshot(account_id)
        if snapshot is None:
            return ProfilePasswordOutcome.STALE
        verification = self._verifier(
            current_password,
            snapshot.encoded_hash,
            stored_policy_version=snapshot.hash_policy_version,
            argon2=self._argon2,
            current_policy_version=self._policy_version,
        )
        if not isinstance(verification, PasswordVerification) or not verification.valid:
            with self._operation() as connection:
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.INVALID,
                    reason=CredentialAuditReason.CURRENT_PASSWORD_INVALID,
                    account_id=account_id,
                    request_ref=request_ref,
                    now=now,
                )
            return ProfilePasswordOutcome.CURRENT_PASSWORD_INVALID
        credential = self._password_hasher(
            new_password,
            username=snapshot.username,
            email=snapshot.email,
            breached_checker=self._breached_checker,
            argon2=self._argon2,
            policy_version=self._policy_version,
        )
        if not isinstance(credential, PasswordCredential):
            raise RuntimeError("Profile password hashing failed.")

        try:
            with self._operation() as connection:
                if not self._lock_current(
                    connection,
                    snapshot,
                    current_session_id,
                ):
                    return ProfilePasswordOutcome.STALE
                update = connection.execute(
                    """
                    update app.account_credentials
                    set encoded_hash = %s, hash_policy_version = %s,
                        credential_version = credential_version + 1,
                        administrator_set = false, password_set_at = %s,
                        updated_at = %s
                    where account_id = %s and encoded_hash = %s
                      and credential_version = %s
                    """,
                    (
                        credential.encoded_hash,
                        credential.policy_version,
                        now,
                        now,
                        account_id,
                        snapshot.encoded_hash,
                        snapshot.credential_version,
                    ),
                )
                _require_updated(update)
                connection.execute(
                    """
                    update app.password_reset_tokens
                    set revoked_at = %s
                    where account_id = %s and consumed_at is null and revoked_at is null
                    """,
                    (now, account_id),
                )
                connection.execute(
                    """
                    update app.password_reset_transactions
                    set consumed_at = %s
                    where reset_token_id in (
                      select id from app.password_reset_tokens where account_id = %s
                    ) and consumed_at is null
                    """,
                    (now, account_id),
                )
                connection.execute(
                    """
                    update app.account_sessions
                    set revoked_at = %s, revocation_reason = 'password_change'
                    where account_id = %s and id <> %s and revoked_at is null
                    """,
                    (now, account_id, current_session_id),
                )
                current_update = connection.execute(
                    """
                    update app.account_sessions
                    set authenticated_at = %s, last_seen_at = %s
                    where id = %s and account_id = %s and revoked_at is null
                    """,
                    (now, now, current_session_id, account_id),
                )
                _require_updated(current_update)
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.SUCCESS,
                    reason=CredentialAuditReason.PASSWORD_CHANGED,
                    account_id=account_id,
                    request_ref=request_ref,
                    now=now,
                )
            return ProfilePasswordOutcome.SUCCESS
        except (TypeError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Profile password persistence failed.") from None

    def dismiss_suggestion(
        self,
        *,
        account_id: object,
        request_ref: object,
    ) -> bool:
        account_id = _positive_integer(account_id, "account id")
        request_ref = _request_ref(request_ref)
        now = _aware_utc(self._clock())
        try:
            with self._operation() as connection:
                accounts = connection.execute(
                    """
                    select id, is_active, disabled_at from app.accounts
                    where id = %s for update
                    """,
                    (account_id,),
                ).fetchall()
                credentials = connection.execute(
                    """
                    select account_id, administrator_set
                    from app.account_credentials where account_id = %s for update
                    """,
                    (account_id,),
                ).fetchall()
                if len(accounts) != 1 or len(credentials) != 1:
                    return False
                account = _row(accounts[0], ("id", "is_active", "disabled_at"))
                if account.get("is_active") is not True or account.get("disabled_at") is not None:
                    return False
                connection.execute(
                    """
                    update app.account_credentials
                    set administrator_set = false, updated_at = %s
                    where account_id = %s and administrator_set is true
                    """,
                    (now, account_id),
                )
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.SUCCESS,
                    reason=CredentialAuditReason.SUGGESTION_DISMISSED,
                    account_id=account_id,
                    request_ref=request_ref,
                    now=now,
                )
            return True
        except Exception:
            raise RuntimeError("Profile suggestion persistence failed.") from None

    def _load_snapshot(self, account_id: int) -> _CredentialSnapshot | None:
        with self._operation() as connection:
            rows = connection.execute(
                """
                select app.accounts.id as account_id,
                       app.accounts.username_display,
                       app.accounts.contact_email,
                       app.accounts.is_active, app.accounts.disabled_at,
                       app.account_credentials.encoded_hash,
                       app.account_credentials.hash_policy_version,
                       app.account_credentials.credential_version,
                       app.account_credentials.administrator_set
                from app.accounts
                join app.account_credentials
                  on app.account_credentials.account_id = app.accounts.id
                where app.accounts.id = %s
                """,
                (account_id,),
            ).fetchall()
        if len(rows) != 1:
            return None
        row = _row(rows[0], _SNAPSHOT_COLUMNS)
        if row.get("is_active") is not True or row.get("disabled_at") is not None:
            return None
        return _CredentialSnapshot(
            account_id=account_id,
            username=_required_text(row.get("username_display"), "username"),
            email=_required_text(row.get("contact_email"), "contact email"),
            encoded_hash=_required_text(row.get("encoded_hash"), "encoded hash"),
            hash_policy_version=_positive_integer(
                row.get("hash_policy_version"), "hash policy version"
            ),
            credential_version=_positive_integer(
                row.get("credential_version"), "credential version"
            ),
            administrator_set=row.get("administrator_set") is True,
        )

    def _lock_current(
        self,
        connection: Any,
        snapshot: _CredentialSnapshot,
        current_session_id: int,
    ) -> bool:
        accounts = connection.execute(
            "select id, is_active, disabled_at from app.accounts where id = %s for update",
            (snapshot.account_id,),
        ).fetchall()
        credentials = connection.execute(
            """
            select account_id, encoded_hash, hash_policy_version,
                   credential_version, administrator_set
            from app.account_credentials where account_id = %s for update
            """,
            (snapshot.account_id,),
        ).fetchall()
        sessions = connection.execute(
            """
            select id from app.account_sessions
            where account_id = %s and revoked_at is null
            order by created_at, id for update
            """,
            (snapshot.account_id,),
        ).fetchall()
        if len(accounts) != 1 or len(credentials) != 1:
            return False
        account = _row(accounts[0], ("id", "is_active", "disabled_at"))
        credential = _row(
            credentials[0],
            (
                "account_id",
                "encoded_hash",
                "hash_policy_version",
                "credential_version",
                "administrator_set",
            ),
        )
        session_ids = {
            _positive_integer(_row(item, ("id",)).get("id"), "session id")
            for item in sessions
        }
        return bool(
            account.get("is_active") is True
            and account.get("disabled_at") is None
            and credential.get("encoded_hash") == snapshot.encoded_hash
            and credential.get("credential_version") == snapshot.credential_version
            and current_session_id in session_ids
        )

    def _append_audit(
        self,
        connection: Any,
        *,
        outcome: SecurityAuditOutcome,
        reason: CredentialAuditReason,
        account_id: int,
        request_ref: str,
        now: datetime,
    ) -> None:
        self._audit.append_in_transaction(
            connection,
            category=SecurityAuditCategory.CREDENTIAL,
            outcome=outcome,
            reason=reason,
            actor_account_id=account_id,
            target_account_id=account_id,
            request_ref=request_ref,
            occurred_at=now,
            metadata=None,
        )

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError
            with transaction():
                yield connection


def _row(value: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, (tuple, list)):
        return dict(zip(columns, value, strict=False))
    return {}


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Profile password {field} is invalid.")
    return value


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError(f"Profile password {field} is invalid.")
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or "\r" in value or "\n" in value:
        raise RuntimeError("Profile session user agent is invalid.")
    return value[:1024]


def _session_device_label(value: object) -> str:
    user_agent = _optional_text(value)
    if user_agent is None:
        return "Unknown browser"
    normalized = user_agent.casefold()
    for marker, label in (
        ("ipad", "iPad"),
        ("iphone", "iPhone"),
        ("android", "Android"),
        ("windows", "Windows"),
        ("macintosh", "Mac"),
        ("linux", "Linux"),
    ):
        if marker in normalized:
            return label
    return "Unknown browser"


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Profile password request reference is invalid.")
    return value


def _require_updated(cursor: object) -> None:
    if getattr(cursor, "rowcount", None) != 1:
        raise RuntimeError


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Profile password clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for profile credentials.")
    return psycopg.connect(database_url, row_factory=dict_row)
