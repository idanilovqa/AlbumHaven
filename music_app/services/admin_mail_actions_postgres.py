"""Recent-authenticated, privacy-safe administrator mail actions."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Iterator

from music_app.services.admin_member_mutation_postgres import (
    RecentAuthenticationRequired,
)
from music_app.services.auth_password_reset_request_postgres import (
    PasswordResetDelivery,
)
from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
    issue_opaque_token,
    keyed_bucket_digest,
)

try:  # pragma: no cover - exercised with the optional runtime driver.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_RECENT_AUTH_WINDOW = timedelta(minutes=10)
_FUTURE_SKEW = timedelta(minutes=5)
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_WELCOME_DOMAIN = "album-haven:welcome-account"
_RESET_DOMAIN = "album-haven:reset-account"


@dataclass(frozen=True, repr=False, slots=True)
class AdminMailActionResult:
    accepted: bool = True
    welcome_outbox_id: int | None = None
    password_reset_delivery: PasswordResetDelivery | None = None
    throttled: bool = False

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(accepted=True, "
            f"welcome_outbox_id={self.welcome_outbox_id!r}, "
            "password_reset_delivery=<redacted>, "
            f"throttled={self.throttled!r})"
        )


class PostgresAdminMailActionService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        token_issuer: Callable[[], object] = issue_opaque_token,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(
            payload.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
        ).strip()
        hmac_config = payload.get("hmac")
        throttles = payload.get("throttles")
        if (
            not self._database_url
            or not isinstance(hmac_config, Mapping)
            or not isinstance(throttles, Mapping)
        ):
            raise RuntimeError("Administrator mail actions are not configured.")
        secret = hmac_config.get("secret")
        if not isinstance(secret, str) or len(secret.encode("utf-8")) < 32:
            raise ValueError("Administrator mail-action policy is invalid.")
        self._hmac_secret = secret.encode("utf-8")
        self._hmac_key_version = _positive_id(hmac_config.get("key_version"))
        self._policies: dict[str, tuple[int, int]] = {}
        for kind in ("welcome_account", "reset_account"):
            policy = throttles.get(kind)
            if not isinstance(policy, Mapping):
                raise ValueError("Administrator mail-action policy is invalid.")
            self._policies[kind] = (
                _positive_id(policy.get("limit")),
                _positive_id(policy.get("window_seconds")),
            )
        self._reset_token_seconds = _positive_id(payload.get("reset_token_seconds"))
        if self._reset_token_seconds > 1800 or not callable(token_issuer):
            raise ValueError("Administrator mail-action policy is invalid.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._token_issuer = token_issuer

    def queue_welcome(
        self,
        *,
        actor_account_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        request_ref: object,
    ) -> AdminMailActionResult:
        actor_id, current_library_id, target_id, reference, now = self._inputs(
            actor_account_id,
            actor_authenticated_at,
            library_id,
            target_account_id,
            request_ref,
        )
        try:
            with self._operation() as connection:
                target = self._lock_authority_and_target(
                    connection, actor_id, current_library_id, target_id
                )
                if not _eligible(target):
                    self._audit(connection, actor_id, target_id, "welcome_resend_ineligible", "invalid", reference, now)
                    return AdminMailActionResult()
                if self._charge(
                    connection, "welcome_account", _WELCOME_DOMAIN, target_id, now
                ):
                    self._audit(connection, actor_id, target_id, "welcome_resend_throttled", "throttled", reference, now)
                    return AdminMailActionResult(throttled=True)
                outbox_id = _returned_id(
                    connection.execute(
                        """
                        insert into app.mail_outbox (
                          account_id, message_category, delivery_status,
                          attempt_count, created_at, next_attempt_at
                        ) values (%s, 'welcome', 'pending', 0, %s, %s)
                        returning id
                        """,
                        (target_id, now, now),
                    ).fetchall()
                )
                self._audit(connection, actor_id, target_id, "welcome_resend_queued", "success", reference, now)
            return AdminMailActionResult(welcome_outbox_id=outbox_id)
        except (PermissionError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Administrator welcome delivery could not be queued.") from None

    def queue_password_reset(
        self,
        *,
        actor_account_id: object,
        actor_authenticated_at: object,
        library_id: object,
        target_account_id: object,
        request_ref: object,
    ) -> AdminMailActionResult:
        actor_id, current_library_id, target_id, reference, now = self._inputs(
            actor_account_id,
            actor_authenticated_at,
            library_id,
            target_account_id,
            request_ref,
        )
        try:
            with self._operation() as connection:
                target = self._lock_authority_and_target(
                    connection, actor_id, current_library_id, target_id
                )
                if not _eligible(target):
                    self._audit(connection, actor_id, target_id, "password_reset_ineligible", "invalid", reference, now)
                    return AdminMailActionResult()
                if self._charge(
                    connection, "reset_account", _RESET_DOMAIN, target_id, now
                ):
                    self._audit(connection, actor_id, target_id, "password_reset_throttled", "throttled", reference, now)
                    return AdminMailActionResult(throttled=True)
                issued = _issued_token(self._token_issuer)
                credential_version = _positive_id(target.get("credential_version"))
                connection.execute(
                    """
                    update app.password_reset_tokens
                    set revoked_at = %s
                    where account_id = %s and purpose = 'password_reset'
                      and consumed_at is null and revoked_at is null
                    """,
                    (now, target_id),
                )
                reset_id = _returned_id(
                    connection.execute(
                        """
                        insert into app.password_reset_tokens (
                          account_id, token_hash, purpose, credential_version,
                          created_at, expires_at, request_ref
                        ) values (%s, %s, 'password_reset', %s, %s, %s, %s)
                        returning id
                        """,
                        (
                            target_id,
                            issued.digest,
                            credential_version,
                            now,
                            now + timedelta(seconds=self._reset_token_seconds),
                            reference,
                        ),
                    ).fetchall()
                )
                outbox_id = _returned_id(
                    connection.execute(
                        """
                        insert into app.mail_outbox (
                          account_id, reset_token_id, message_category,
                          delivery_status, attempt_count, created_at
                        ) values (%s, %s, 'password_reset', 'pending', 0, %s)
                        returning id
                        """,
                        (target_id, reset_id, now),
                    ).fetchall()
                )
                self._audit(connection, actor_id, target_id, "password_reset_queued", "success", reference, now)
                delivery = PasswordResetDelivery(
                    outbox_id=outbox_id,
                    account_id=target_id,
                    recipient=_recipient(target.get("contact_email")),
                    raw_token=issued.raw,
                )
            return AdminMailActionResult(password_reset_delivery=delivery)
        except (PermissionError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Administrator password reset could not be queued.") from None

    def _inputs(self, actor: object, authenticated_at: object, library: object, target: object, reference: object):
        now = _aware_utc(self._clock())
        authenticated = _aware_utc(authenticated_at)
        if authenticated > now + _FUTURE_SKEW or now - authenticated > _RECENT_AUTH_WINDOW:
            raise RecentAuthenticationRequired("Recent authentication is required.")
        return (
            _positive_id(actor),
            _positive_id(library),
            _positive_id(target),
            _request_ref(reference),
            now,
        )

    @staticmethod
    def _lock_authority_and_target(connection: Any, actor_id: int, library_id: int, target_id: int) -> Mapping[str, object]:
        rows = connection.execute(
            """
            with locked_accounts as (
              select id, is_active, disabled_at, contact_email
              from app.accounts where id in (%s, %s) order by id for update
            ), locked_library as (
              select id, owner_account_id from library.libraries
              where id = %s for update
            )
            select actor.id as actor_account_id,
                   locked_library.id as library_id,
                   target.id as target_account_id,
                   target.is_active as target_is_active,
                   target.disabled_at as target_disabled_at,
                   target.contact_email,
                   credential.credential_version
            from locked_accounts actor
            join app.bootstrap_owners authority
              on authority.account_id = actor.id
             and authority.owner_key = 'local-bootstrap-owner'
            join locked_library on locked_library.owner_account_id = actor.id
            join locked_accounts target on target.id = %s
            join library.library_memberships membership
              on membership.library_id = locked_library.id
             and membership.account_id = target.id
            join app.account_credentials credential on credential.account_id = target.id
            where actor.id = %s and actor.is_active is true
              and actor.disabled_at is null
            for update of credential, membership
            """,
            (actor_id, target_id, library_id, target_id, actor_id),
        ).fetchall()
        if len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise PermissionError("Administrator mail action is not permitted.")
        return rows[0]

    def _charge(self, connection: Any, kind: str, domain: str, target_id: int, now: datetime) -> bool:
        limit, window_seconds = self._policies[kind]
        digest = keyed_bucket_digest(
            secret=self._hmac_secret,
            key_version=self._hmac_key_version,
            domain=domain,
            normalized_value=str(target_id),
        ).digest
        expires_at = now + timedelta(seconds=window_seconds)
        connection.execute(
            """
            insert into app.auth_throttles (
              bucket_kind, bucket_hash, key_version, window_started_at,
              window_expires_at, failure_count, updated_at
            ) values (%s, %s, %s, %s, %s, 0, %s)
            on conflict (bucket_kind, key_version, bucket_hash) do nothing
            """,
            (kind, digest, self._hmac_key_version, now, expires_at, now),
        )
        rows = connection.execute(
            """
            select bucket_kind, window_started_at, failure_count,
                   window_expires_at, blocked_until
            from app.auth_throttles
            where key_version = %s and bucket_kind = %s and bucket_hash = %s
            for update
            """,
            (self._hmac_key_version, kind, digest),
        ).fetchall()
        if len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise RuntimeError
        row = rows[0]
        count = _nonnegative(row.get("failure_count"))
        expires = _aware_utc(row.get("window_expires_at"))
        blocked_until = row.get("blocked_until")
        if now >= expires:
            count = 0
            connection.execute(
                """
                update app.auth_throttles
                set window_started_at = %s, window_expires_at = %s,
                    failure_count = 0, blocked_until = null, updated_at = %s
                where bucket_kind = %s and key_version = %s and bucket_hash = %s
                """,
                (now, expires_at, now, kind, self._hmac_key_version, digest),
            )
        elif count >= limit or (
            blocked_until is not None and now < _aware_utc(blocked_until)
        ):
            return True
        connection.execute(
            """
            update app.auth_throttles
            set failure_count = failure_count + 1, updated_at = %s
            where bucket_kind = %s and key_version = %s and bucket_hash = %s
            """,
            (now, kind, self._hmac_key_version, digest),
        )
        return False

    @staticmethod
    def _audit(connection: Any, actor_id: int, target_id: int, reason: str, outcome: str, reference: str, now: datetime) -> None:
        connection.execute(
            f"""
            insert into app.security_audit_events (
              actor_account_id, target_account_id, event_category,
              outcome, reason_code, request_ref, occurred_at, metadata
            ) values (%s, %s, 'account_management', '{outcome}',
                      '{reason}', %s, %s, '{{}}'::jsonb)
            """,
            (actor_id, target_id, reference, now),
        )

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        with self._connect(self._database_url) as connection:
            transaction = getattr(connection, "transaction", None)
            if not callable(transaction):
                raise RuntimeError
            with transaction():
                yield connection


def _eligible(row: Mapping[str, object]) -> bool:
    return bool(
        row.get("target_is_active") is True
        and row.get("target_disabled_at") is None
        and isinstance(row.get("contact_email"), str)
        and str(row.get("contact_email")).strip()
        and isinstance(row.get("credential_version"), int)
        and not isinstance(row.get("credential_version"), bool)
        and int(row.get("credential_version")) >= 1
    )


def _issued_token(provider: Callable[[], object]) -> IssuedOpaqueToken:
    value = provider()
    if not isinstance(value, IssuedOpaqueToken):
        raise RuntimeError
    try:
        valid = hash_opaque_token(value.raw) == value.digest
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise RuntimeError
    return value


def _recipient(value: object) -> str:
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        raise RuntimeError
    return value


def _returned_id(rows: object) -> int:
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], Mapping):
        raise RuntimeError
    return _positive_id(rows[0].get("id"))


def _positive_id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("Administrator mail-action reference is invalid.")
    return value


def _nonnegative(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError
    return value


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Administrator mail-action request reference is invalid.")
    return value


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RecentAuthenticationRequired("Recent authentication is required.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for administrator mail actions.")
    return psycopg.connect(database_url, row_factory=dict_row)
