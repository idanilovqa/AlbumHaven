"""Durable, enumeration-resistant local-login authentication."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import hashlib
import hmac
import re
import threading
from typing import Any
import unicodedata

from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import InvalidHashError
from argon2.low_level import ARGON2_VERSION, Type

from music_app.services.auth_passwords import (
    PasswordCredential,
    PasswordVerification,
    rehash_verified_password,
    verify_password,
)
from music_app.services.auth_audit_postgres import (
    LoginAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_sessions_postgres import (
    IssuedBrowserSession,
    PreparedBrowserSession,
)
from music_app.services.auth_tokens import (
    hash_opaque_token,
    keyed_bucket_digest,
    normalize_login_identifier,
)

try:  # pragma: no cover - exercised when the optional driver is installed.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_ACCOUNT_DOMAIN = "album-haven:login-account"
_SOURCE_DOMAIN = "album-haven:login-source"
_ACCOUNT_COLUMNS = ("id", "username_normalized", "is_active", "disabled_at")
_CREDENTIAL_COLUMNS = (
    "account_id",
    "encoded_hash",
    "hash_policy_version",
    "credential_version",
    "administrator_set",
)
_THROTTLE_COLUMNS = (
    "bucket_kind",
    "window_started_at",
    "failure_count",
    "window_expires_at",
    "blocked_until",
)
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_SOURCE_CLASSES = frozenset({"loopback", "private", "public", "trusted_proxy"})
_PREPARED_SESSION_MAX_CLOCK_SKEW = timedelta(seconds=5)


class LoginOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"
    THROTTLED = "throttled"


@dataclass(frozen=True, slots=True)
class LoginResult:
    outcome: LoginOutcome
    account_id: int | None = None
    administrator_set: bool | None = None
    session: IssuedBrowserSession | None = None


@dataclass(frozen=True, repr=False, slots=True)
class _CredentialSnapshot:
    account_id: int
    encoded_hash: str
    hash_policy_version: int
    credential_version: int
    administrator_set: bool

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(account_id={self.account_id!r}, "
            "encoded_hash=<redacted>, hash_policy_version=<redacted>, "
            "credential_version=<redacted>, administrator_set=<redacted>)"
        )


@dataclass(frozen=True, repr=False, slots=True)
class _ReservedBucket:
    kind: str
    digest: bytes
    window_started_at: datetime

    def __repr__(self) -> str:
        return f"{type(self).__name__}(kind={self.kind!r}, digest=<redacted>, window_started_at=<redacted>)"


class PostgresLoginAuthService:
    """Authenticate one local credential behind durable two-bucket throttling."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        verifier: Callable[..., PasswordVerification] = verify_password,
        dummy_encoded_hash: str | None = None,
        verification_semaphore: Any | None = None,
        clock: Callable[[], datetime] | None = None,
        rehasher: Callable[..., PasswordCredential] | None = None,
        session_service: Any,
        audit_repository: Any,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for login authentication."
            )
        hmac_config = _mapping(payload.get("hmac"), "HMAC configuration")
        secret = hmac_config.get("secret")
        if not isinstance(secret, str):
            raise ValueError("Login authentication configuration is invalid.")
        try:
            self._hmac_secret = secret.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Login authentication configuration is invalid.") from None
        if len(self._hmac_secret) < 32:
            raise ValueError("Login authentication configuration is invalid.")
        self._hmac_key_version = _positive_integer(
            hmac_config.get("key_version"), "HMAC key version"
        )
        self._argon2 = dict(_mapping(payload.get("argon2"), "Argon2 configuration"))
        self._argon2_policy_version = _positive_integer(
            payload.get("argon2_policy_version"), "Argon2 policy version"
        )
        password_policy = payload.get("password")
        password_config = password_policy if isinstance(password_policy, Mapping) else {}
        self._password_max_codepoints = _positive_integer(
            password_config.get("max_codepoints", 256), "password maximum"
        )
        self._password_max_utf8_bytes = _positive_integer(
            password_config.get("max_utf8_bytes", 1_024), "password byte maximum"
        )
        throttles = _mapping(payload.get("throttles"), "throttle configuration")
        account_policy = _mapping(
            throttles.get("login_account"), "account throttle configuration"
        )
        source_policy = _mapping(
            throttles.get("login_source"), "source throttle configuration"
        )
        self._limits = {
            "login_account": _positive_integer(account_policy.get("limit"), "limit"),
            "login_source": _positive_integer(source_policy.get("limit"), "limit"),
        }
        self._windows = {
            "login_account": _positive_integer(
                account_policy.get("window_seconds"), "window"
            ),
            "login_source": _positive_integer(
                source_policy.get("window_seconds"), "window"
            ),
        }
        self._cooldown_seconds = _positive_integer(
            throttles.get("login_cooldown_seconds"), "cooldown"
        )
        if dummy_encoded_hash is None:
            dummy_encoded_hash = _generate_dummy_hash(self._argon2)
        _validate_dummy_hash(dummy_encoded_hash, self._argon2)
        self._dummy_encoded_hash = dummy_encoded_hash
        self._connect = connect or _connect
        self._verifier = verifier
        self._rehasher = rehasher or rehash_verified_password
        self._semaphore = verification_semaphore or threading.BoundedSemaphore(
            _positive_integer(
                payload.get("verification_semaphore"), "verification capacity"
            )
        )
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        if not callable(getattr(session_service, "prepare_session", None)) or not callable(
            getattr(session_service, "persist_prepared_for_locked_account", None)
        ):
            raise TypeError("Login session service is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Login audit repository is invalid.")
        self._session_service = session_service
        self._audit_repository = audit_repository

    def authenticate(
        self,
        *,
        entered_username: object,
        password: object,
        source_key: object,
        user_agent: str | None = None,
        request_ref: str | None = None,
        source_class: str | None = None,
    ) -> LoginResult:
        request_ref = _request_reference(request_ref)
        source_class = _source_class(source_class)
        now = _aware_now(self._clock)
        normalized, lookup_allowed = _candidate_identifier(entered_username)
        source, source_allowed = _source_key(source_key)
        verification_password, password_allowed = self._verification_password(password)
        lookup_allowed = lookup_allowed and source_allowed and password_allowed
        buckets = self._buckets(normalized, source)

        reservation = self._reserve_capacity(
            buckets,
            now,
            request_ref=request_ref,
            source_class=source_class,
        )
        if reservation is None:
            return LoginResult(LoginOutcome.THROTTLED)
        try:
            acquired = self._semaphore.acquire(blocking=False)
        except Exception:
            self._finalize_failure(
                reservation,
                now,
                reason=LoginAuditReason.CREDENTIAL_RACE,
                request_ref=request_ref,
                source_class=source_class,
            )
            raise RuntimeError("Login persistence operation failed.") from None
        if not acquired:
            self._finalize_failure(
                reservation,
                now,
                reason=LoginAuditReason.VERIFICATION_CAPACITY,
                request_ref=request_ref,
                source_class=source_class,
            )
            return LoginResult(LoginOutcome.THROTTLED)

        account: Mapping[str, object] | None = None
        credential: _CredentialSnapshot | None = None
        verification = PasswordVerification(valid=False, needs_rehash=False)
        used_real_credential = False
        verification_failure = False
        operation_failure = False
        try:
            if lookup_allowed:
                try:
                    account, credential = self._load_identity(normalized)
                except Exception:
                    operation_failure = True
            if not operation_failure:
                used_real_credential = bool(
                    lookup_allowed
                    and account is not None
                    and credential is not None
                    and _account_is_active(account)
                )
                if used_real_credential:
                    encoded_hash = credential.encoded_hash
                    stored_policy = credential.hash_policy_version
                else:
                    encoded_hash = self._dummy_encoded_hash
                    stored_policy = self._argon2_policy_version
                try:
                    candidate_result = self._verifier(
                        verification_password,
                        encoded_hash,
                        stored_policy_version=stored_policy,
                        argon2=self._argon2,
                        current_policy_version=self._argon2_policy_version,
                    )
                    if (
                        isinstance(candidate_result, PasswordVerification)
                        and type(candidate_result.valid) is bool
                        and type(candidate_result.needs_rehash) is bool
                    ):
                        verification = candidate_result
                    else:
                        verification_failure = True
                except Exception:
                    verification_failure = True
        finally:
            try:
                self._semaphore.release()
            except Exception:
                operation_failure = True

        if operation_failure:
            self._finalize_failure(
                reservation,
                now,
                reason=LoginAuditReason.CREDENTIAL_RACE,
                request_ref=request_ref,
                source_class=source_class,
                target_account_id=_account_id_or_none(account),
            )
            raise RuntimeError("Login persistence operation failed.") from None

        succeeded = bool(
            lookup_allowed
            and used_real_credential
            and account is not None
            and credential is not None
            and _account_is_active(account)
            and verification.valid
        )
        replacement: PasswordCredential | None = None
        post_verification_failure = False
        if succeeded and verification.needs_rehash:
            try:
                replacement = self._rehasher(
                    verification_password,
                    argon2=self._argon2,
                    policy_version=self._argon2_policy_version,
                )
            except Exception:
                replacement = None
            if not isinstance(replacement, PasswordCredential):
                succeeded = False
                post_verification_failure = True

        if succeeded:
            # Token generation and validation deliberately happen before the final
            # persistence transaction; the prepared token is not usable unless that
            # transaction commits its session row.
            try:
                prepared = self._session_service.prepare_session(
                    _positive_integer(account.get("id"), "account id"),
                    user_agent=user_agent,
                )
                prepared = _validated_prepared_session(
                    prepared,
                    _positive_integer(account.get("id"), "account id"),
                    now,
                )
            except Exception:
                self._finalize_failure(
                    reservation,
                    now,
                    reason=LoginAuditReason.CREDENTIAL_RACE,
                    request_ref=request_ref,
                    source_class=source_class,
                    target_account_id=_account_id_or_none(account),
                )
                raise RuntimeError("Login persistence operation failed.") from None
            session, succeeded = self._finalize_success(
                account,
                credential,
                reservation,
                now,
                replacement=replacement,
                prepared=prepared,
                request_ref=request_ref,
                source_class=source_class,
            )
        else:
            if verification_failure or post_verification_failure:
                reason = LoginAuditReason.CREDENTIAL_RACE
            elif not lookup_allowed:
                reason = LoginAuditReason.CANDIDATE_INVALID
            elif not used_real_credential:
                reason = LoginAuditReason.ACCOUNT_INELIGIBLE
            else:
                reason = LoginAuditReason.CREDENTIAL_MISMATCH
            self._finalize_failure(
                reservation,
                now,
                reason=reason,
                request_ref=request_ref,
                source_class=source_class,
                target_account_id=_account_id_or_none(account),
            )
        if not succeeded:
            return LoginResult(LoginOutcome.INVALID)
        return LoginResult(
            LoginOutcome.SUCCESS,
            account_id=_positive_integer(account.get("id"), "account id"),
            administrator_set=credential.administrator_set,
            session=session,
        )

    def _verification_password(self, value: object) -> tuple[str, bool]:
        if not isinstance(value, str):
            return "invalid-login-password", False
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError:
            return "invalid-login-password", False
        if (
            len(value) > self._password_max_codepoints
            or len(encoded) > self._password_max_utf8_bytes
        ):
            return "invalid-login-password", False
        return value, True

    def _buckets(
        self, normalized: str, source: str
    ) -> tuple[tuple[str, bytes], tuple[str, bytes]]:
        account = keyed_bucket_digest(
            secret=self._hmac_secret,
            key_version=self._hmac_key_version,
            domain=_ACCOUNT_DOMAIN,
            normalized_value=normalized,
        )
        source_bucket = keyed_bucket_digest(
            secret=self._hmac_secret,
            key_version=self._hmac_key_version,
            domain=_SOURCE_DOMAIN,
            normalized_value=source,
        )
        return (
            ("login_account", account.digest),
            ("login_source", source_bucket.digest),
        )

    def _reserve_capacity(
        self,
        buckets: tuple[tuple[str, bytes], ...],
        now: datetime,
        *,
        request_ref: str | None,
        source_class: str | None,
    ) -> tuple[_ReservedBucket, ...] | None:
        with self._operation() as connection:
            for kind, digest in buckets:
                _execute(
                    connection,
                    """
                    insert into app.auth_throttles (
                      bucket_kind, bucket_hash, key_version,
                      window_started_at, window_expires_at, failure_count
                    ) values (%s, %s, %s, %s, %s, 0)
                    on conflict (bucket_kind, key_version, bucket_hash) do nothing
                    """,
                    (
                        kind,
                        digest,
                        self._hmac_key_version,
                        now,
                        now + timedelta(seconds=self._windows[kind]),
                    ),
                )
            rows = _fetchall(
                connection,
                """
                select bucket_kind, window_started_at, failure_count,
                       window_expires_at, blocked_until
                from app.auth_throttles
                where key_version = %s
                  and ((bucket_kind = %s and bucket_hash = %s)
                    or (bucket_kind = %s and bucket_hash = %s))
                order by bucket_kind, key_version, bucket_hash
                for update
                """,
                (
                    self._hmac_key_version,
                    buckets[0][0],
                    buckets[0][1],
                    buckets[1][0],
                    buckets[1][1],
                ),
            )
            if len(rows) != 2:
                raise RuntimeError("Login throttle state is unavailable.")
            parsed = [_row(row, _THROTTLE_COLUMNS) for row in rows]
            reserved: list[_ReservedBucket] = []
            for row in parsed:
                kind = str(row.get("bucket_kind") or "")
                if kind not in self._limits:
                    raise RuntimeError("Login throttle state is unavailable.")
                expires = _timestamp(row.get("window_expires_at"))
                blocked = row.get("blocked_until")
                blocked_until = _timestamp(blocked) if blocked is not None else None
                count = _nonnegative_integer(row.get("failure_count"), "failure count")
                if blocked_until is not None and now < blocked_until:
                    self._append_audit(
                        connection,
                        outcome=SecurityAuditOutcome.THROTTLED,
                        reason=LoginAuditReason.BUCKET_BLOCKED,
                        now=now,
                        request_ref=request_ref,
                        source_class=source_class,
                    )
                    return None
                if now < expires and count >= self._limits[kind]:
                    self._append_audit(
                        connection,
                        outcome=SecurityAuditOutcome.THROTTLED,
                        reason=LoginAuditReason.BUCKET_BLOCKED,
                        now=now,
                        request_ref=request_ref,
                        source_class=source_class,
                    )
                    return None
                if now >= expires:
                    count = 0
                    window_started_at = now
                    _execute(
                        connection,
                        """
                        update app.auth_throttles
                        set window_started_at = %s, window_expires_at = %s,
                            failure_count = 0, updated_at = %s
                        where bucket_kind = %s and key_version = %s and bucket_hash = %s
                        """,
                        (
                            now,
                            now + timedelta(seconds=self._windows[kind]),
                            now,
                            kind,
                            self._hmac_key_version,
                            dict(buckets)[kind],
                        ),
                    )
                else:
                    window_started_at = _timestamp(row.get("window_started_at"))
                reserved.append(
                    _ReservedBucket(
                        kind=kind,
                        digest=dict(buckets)[kind],
                        window_started_at=window_started_at,
                    )
                )
            for kind, digest in buckets:
                _execute(
                    connection,
                    """
                    update app.auth_throttles
                    set failure_count = failure_count + 1, updated_at = %s
                    where bucket_kind = %s and key_version = %s and bucket_hash = %s
                    """,
                    (now, kind, self._hmac_key_version, digest),
                )
        return tuple(reserved)

    def _finalize_failure(
        self,
        reservation: tuple[_ReservedBucket, ...],
        now: datetime,
        *,
        reason: LoginAuditReason,
        request_ref: str | None,
        source_class: str | None,
        target_account_id: int | None = None,
    ) -> None:
        with self._operation() as connection:
            self._finalize_failure_in_transaction(connection, reservation, now)
            self._append_audit(
                connection,
                outcome=(
                    SecurityAuditOutcome.THROTTLED
                    if reason is LoginAuditReason.VERIFICATION_CAPACITY
                    else SecurityAuditOutcome.INVALID
                ),
                reason=reason,
                now=now,
                request_ref=request_ref,
                source_class=source_class,
                target_account_id=target_account_id,
            )

    def _load_identity(
        self, normalized: str
    ) -> tuple[Mapping[str, object] | None, _CredentialSnapshot | None]:
        with self._operation() as connection:
            accounts = _fetchall(
                connection,
                """
                select id, username_normalized, is_active, disabled_at
                from app.accounts where username_normalized = %s
                """,
                (normalized,),
            )
            if len(accounts) != 1:
                return None, None
            account = _row(accounts[0], _ACCOUNT_COLUMNS)
            account_id = _positive_integer(account.get("id"), "account id")
            credentials = _fetchall(
                connection,
                """
                select account_id, encoded_hash, hash_policy_version,
                       credential_version, administrator_set
                from app.account_credentials where account_id = %s
                """,
                (account_id,),
            )
            if len(credentials) != 1:
                return account, None
            return account, _credential_snapshot(credentials[0])

    def _finalize_success(
        self,
        account: Mapping[str, object],
        original: _CredentialSnapshot,
        reservation: tuple[_ReservedBucket, ...],
        now: datetime,
        *,
        replacement: PasswordCredential | None,
        prepared: PreparedBrowserSession,
        request_ref: str | None,
        source_class: str | None,
    ) -> tuple[IssuedBrowserSession | None, bool]:
        account_id = _positive_integer(account.get("id"), "account id")
        with self._operation() as connection:
            accounts = _fetchall(
                connection,
                """
                select id, username_normalized, is_active, disabled_at
                from app.accounts where id = %s for update
                """,
                (account_id,),
            )
            credentials = _fetchall(
                connection,
                """
                select account_id, encoded_hash, hash_policy_version,
                       credential_version, administrator_set
                from app.account_credentials where account_id = %s for update
                """,
                (account_id,),
            )
            locked_account = (
                _row(accounts[0], _ACCOUNT_COLUMNS)
                if len(accounts) == 1
                else None
            )
            try:
                locked_credential = (
                    _credential_snapshot(credentials[0])
                    if len(credentials) == 1
                    else None
                )
            except (RuntimeError, ValueError):
                locked_credential = None
            identity_current = not (
                locked_account is None
                or not _account_is_active(locked_account)
                or locked_credential != original
            )
            if identity_current and replacement is not None:
                cursor = _execute(
                    connection,
                    """
                    update app.account_credentials
                    set encoded_hash = %s, hash_policy_version = %s, updated_at = %s
                    where account_id = %s and encoded_hash = %s
                      and credential_version = %s
                    """,
                    (
                        replacement.encoded_hash,
                        replacement.policy_version,
                        now,
                        account_id,
                        original.encoded_hash,
                        original.credential_version,
                    ),
                )
                if getattr(cursor, "rowcount", None) != 1:
                    identity_current = False
            if not identity_current:
                self._finalize_failure_in_transaction(connection, reservation, now)
                self._append_audit(
                    connection,
                    outcome=SecurityAuditOutcome.INVALID,
                    reason=LoginAuditReason.CREDENTIAL_RACE,
                    now=now,
                    request_ref=request_ref,
                    source_class=source_class,
                    target_account_id=account_id,
                )
                return None, False

            issued = self._session_service.persist_prepared_for_locked_account(
                prepared, connection
            )
            if not _issued_session_matches_prepared(
                issued, prepared, account_id, now
            ):
                raise RuntimeError("Login persistence operation failed.")
            self._finalize_success_throttles(connection, reservation, now)
            self._append_audit(
                connection,
                outcome=SecurityAuditOutcome.SUCCESS,
                reason=LoginAuditReason.VERIFIED,
                now=now,
                request_ref=request_ref,
                source_class=source_class,
                actor_account_id=account_id,
                target_account_id=account_id,
                session=issued,
                credential_rehashed=replacement is not None,
            )
        return issued, True

    def _finalize_failure_in_transaction(
        self,
        connection: Any,
        reservation: tuple[_ReservedBucket, ...],
        now: datetime,
    ) -> None:
        rows = self._lock_reserved_throttles(connection, reservation)
        for raw_row, reserved in zip(rows, reservation, strict=True):
            row = _row(raw_row, _THROTTLE_COLUMNS)
            count = _nonnegative_integer(row.get("failure_count"), "failure count")
            if count >= self._limits[reserved.kind]:
                cursor = _execute(
                    connection,
                    """
                    update app.auth_throttles
                    set blocked_until = %s, updated_at = %s
                    where bucket_kind = %s and key_version = %s
                      and bucket_hash = %s and window_started_at = %s
                    """,
                    (
                        now + timedelta(seconds=self._cooldown_seconds),
                        now,
                        reserved.kind,
                        self._hmac_key_version,
                        reserved.digest,
                        reserved.window_started_at,
                    ),
                )
                _single_updated_row(cursor)

    def _finalize_success_throttles(
        self,
        connection: Any,
        reservation: tuple[_ReservedBucket, ...],
        now: datetime,
    ) -> None:
        self._lock_reserved_throttles(connection, reservation)
        for reserved in reservation:
            cursor = _execute(
                connection,
                """
                update app.auth_throttles
                set failure_count = greatest(failure_count - 1, 0),
                    blocked_until = case
                      when greatest(failure_count - 1, 0) < %s then null
                      else blocked_until end,
                    updated_at = %s
                where bucket_kind = %s and key_version = %s
                  and bucket_hash = %s and window_started_at = %s
                """,
                (
                    self._limits[reserved.kind],
                    now,
                    reserved.kind,
                    self._hmac_key_version,
                    reserved.digest,
                    reserved.window_started_at,
                ),
            )
            _single_updated_row(cursor)

    def _append_audit(
        self,
        connection: Any,
        *,
        outcome: SecurityAuditOutcome,
        reason: LoginAuditReason,
        now: datetime,
        request_ref: str | None,
        source_class: str | None,
        actor_account_id: int | None = None,
        target_account_id: int | None = None,
        session: IssuedBrowserSession | None = None,
        credential_rehashed: bool | None = None,
    ) -> None:
        metadata: dict[str, object] = {
            "hmac_key_version": self._hmac_key_version,
            "argon2_policy_version": self._argon2_policy_version,
        }
        if source_class is not None:
            metadata["source_class"] = source_class
        if credential_rehashed is not None:
            metadata["credential_rehashed"] = credential_rehashed
        if session is not None:
            metadata["session_id"] = session.session_id
        self._audit_repository.append_in_transaction(
            connection,
            category=SecurityAuditCategory.LOGIN,
            outcome=outcome,
            reason=reason,
            actor_account_id=actor_account_id,
            target_account_id=target_account_id,
            request_ref=request_ref,
            occurred_at=now,
            metadata=metadata,
        )

    def _lock_reserved_throttles(
        self, connection: Any, reservation: tuple[_ReservedBucket, ...]
    ) -> list[object]:
        rows = _fetchall(
            connection,
            """
            select bucket_kind, window_started_at, failure_count,
                   window_expires_at, blocked_until
            from app.auth_throttles
            where key_version = %s
              and ((bucket_kind = %s and bucket_hash = %s)
                or (bucket_kind = %s and bucket_hash = %s))
            order by bucket_kind, key_version, bucket_hash
            for update
            """,
            (
                self._hmac_key_version,
                reservation[0].kind,
                reservation[0].digest,
                reservation[1].kind,
                reservation[1].digest,
            ),
        )
        if len(rows) != len(reservation):
            raise RuntimeError("Login throttle state is unavailable.")
        return rows

    @contextmanager
    def _operation(self) -> Iterator[Any]:
        try:
            with self._connect(self._database_url) as connection:
                transaction = getattr(connection, "transaction", None)
                if not callable(transaction):
                    raise RuntimeError("Login persistence requires transaction support.")
                with transaction():
                    yield connection
        except RuntimeError as exc:
            if str(exc) in {
                "Login throttle state is unavailable.",
                "Login persistence requires transaction support.",
            }:
                raise
            raise RuntimeError("Login persistence operation failed.") from None
        except Exception:
            raise RuntimeError("Login persistence operation failed.") from None


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for login authentication.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _execute(connection: Any, sql: str, params: object = None) -> Any:
    try:
        return connection.execute(sql, params)
    except Exception:
        raise RuntimeError("Login persistence operation failed.") from None


def _fetchall(connection: Any, sql: str, params: object = None) -> list[object]:
    try:
        return list(_execute(connection, sql, params).fetchall())
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("Login persistence operation failed.") from None


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"Invalid {label}.")
    return value


def _row(value: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, (tuple, list)):
        return dict(zip(columns, value, strict=False))
    return {}


def _positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Invalid {label}.")
    return value


def _account_id_or_none(account: Mapping[str, object] | None) -> int | None:
    if account is None:
        return None
    try:
        return _positive_integer(account.get("id"), "account id")
    except (AttributeError, TypeError, ValueError):
        return None


def _request_reference(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Login audit request reference is invalid.")
    return value


def _source_class(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value not in _SOURCE_CLASSES:
        raise ValueError("Login audit source class is invalid.")
    return value


def _issued_session_matches_prepared(
    issued: object,
    prepared: object,
    account_id: int,
    authenticated_at: datetime,
) -> bool:
    try:
        if not isinstance(issued, IssuedBrowserSession) or not isinstance(
            prepared, PreparedBrowserSession
        ):
            return False
        _positive_integer(issued.session_id, "session id")
        if _positive_integer(issued.account_id, "account id") != account_id:
            return False
        _validated_prepared_session(prepared, account_id, authenticated_at)
        hash_opaque_token(issued.raw_token)
        authenticated_at = _utc_timestamp(issued.authenticated_at)
        idle_expires_at = _utc_timestamp(issued.idle_expires_at)
        absolute_expires_at = _utc_timestamp(issued.absolute_expires_at)
        if not (authenticated_at < idle_expires_at <= absolute_expires_at):
            return False
    except (TypeError, ValueError, OverflowError):
        return False
    return bool(
        hmac.compare_digest(issued.raw_token, prepared.raw_token)
        and issued.authenticated_at == prepared.authenticated_at
        and issued.idle_expires_at == prepared.idle_expires_at
        and issued.absolute_expires_at == prepared.absolute_expires_at
    )


def _validated_prepared_session(
    value: object, account_id: int, expected_authenticated_at: datetime
) -> PreparedBrowserSession:
    try:
        if not isinstance(value, PreparedBrowserSession):
            raise TypeError
        if _positive_integer(value.account_id, "account id") != account_id:
            raise ValueError
        _validated_user_agent(value.user_agent)
        expected_digest = hash_opaque_token(value.raw_token)
        if (
            not isinstance(value.token_digest, bytes)
            or len(value.token_digest) != 32
            or not hmac.compare_digest(expected_digest, value.token_digest)
        ):
            raise ValueError
        authenticated_at = _utc_timestamp(value.authenticated_at)
        idle_expires_at = _utc_timestamp(value.idle_expires_at)
        absolute_expires_at = _utc_timestamp(value.absolute_expires_at)
        if (
            abs(authenticated_at - expected_authenticated_at)
            > _PREPARED_SESSION_MAX_CLOCK_SKEW
            or not (authenticated_at < idle_expires_at <= absolute_expires_at)
        ):
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Prepared browser session is invalid.") from None
    return value


def _validated_user_agent(value: object) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) > 1_024
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise ValueError("Prepared browser session is invalid.")
    return value


def _utc_timestamp(value: object) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() != timedelta(0)
    ):
        raise ValueError("Prepared browser session is invalid.")
    return value


def _single_updated_row(cursor: Any) -> None:
    """Reject missing, ambiguous, and non-truthful final throttle updates."""
    rowcount = getattr(cursor, "rowcount", None)
    if isinstance(rowcount, bool) or not isinstance(rowcount, int) or rowcount != 1:
        raise RuntimeError("Login throttle finalization is unavailable.")


def _nonnegative_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError(f"Invalid {label}.")
    return value


def _timestamp(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise RuntimeError("Login persistence returned an invalid timestamp.")
    return value


def _aware_now(clock: Callable[[], datetime]) -> datetime:
    try:
        return _timestamp(clock()).astimezone(timezone.utc)
    except Exception:
        raise RuntimeError("Login authentication clock is unavailable.") from None


def _candidate_identifier(value: object) -> tuple[str, bool]:
    try:
        return normalize_login_identifier(value), True
    except (TypeError, ValueError):
        if isinstance(value, str):
            try:
                material = value.encode("utf-8", errors="surrogatepass")
            except Exception:
                material = b"invalid"
        else:
            material = b"invalid"
        return "invalid-" + hashlib.sha256(material).hexdigest(), False


def _source_key(value: object) -> tuple[str, bool]:
    valid = bool(
        isinstance(value, str)
        and value
        and len(value) <= 256
        and not any(
            character.isspace()
            or unicodedata.category(character).startswith("C")
            for character in value
        )
    )
    if valid:
        return value, True
    if isinstance(value, str):
        material = value.encode("utf-8", errors="surrogatepass")
    else:
        material = b"invalid"
    return "invalid-" + hashlib.sha256(material).hexdigest(), False


def _account_is_active(value: object) -> bool:
    payload = _row(value, _ACCOUNT_COLUMNS)
    return payload.get("is_active") is True and payload.get("disabled_at") is None


def _credential_snapshot(value: object) -> _CredentialSnapshot:
    payload = _row(value, _CREDENTIAL_COLUMNS)
    encoded_hash = payload.get("encoded_hash")
    if not isinstance(encoded_hash, str):
        raise RuntimeError("Login credential state is unavailable.")
    administrator_set = payload.get("administrator_set", False)
    if not isinstance(administrator_set, bool):
        raise RuntimeError("Login credential state is unavailable.")
    return _CredentialSnapshot(
        account_id=_positive_integer(payload.get("account_id"), "account id"),
        encoded_hash=encoded_hash,
        hash_policy_version=_positive_integer(
            payload.get("hash_policy_version"), "hash policy version"
        ),
        credential_version=_positive_integer(
            payload.get("credential_version"), "credential version"
        ),
        administrator_set=administrator_set,
    )


def _generate_dummy_hash(argon2: Mapping[str, object]) -> str:
    try:
        return PasswordHasher(
            memory_cost=int(argon2["memory_cost"]),
            time_cost=int(argon2["time_cost"]),
            parallelism=int(argon2["parallelism"]),
            salt_len=int(argon2["salt_len"]),
            hash_len=int(argon2["hash_len"]),
            type=Type.ID,
        ).hash("album-haven-dummy-login-verification")
    except Exception:
        raise ValueError("Login authentication configuration is invalid.") from None


def _validate_dummy_hash(
    encoded_hash: object, argon2: Mapping[str, object]
) -> None:
    if not isinstance(encoded_hash, str):
        raise ValueError("Login authentication configuration is invalid.")
    try:
        parameters = extract_parameters(encoded_hash)
    except (InvalidHashError, TypeError, ValueError):
        raise ValueError("Login authentication configuration is invalid.") from None
    try:
        meets_floor = (
            parameters.type is Type.ID
            and parameters.version == ARGON2_VERSION
            and parameters.memory_cost >= int(argon2["memory_cost"])
            and parameters.time_cost >= int(argon2["time_cost"])
            and parameters.parallelism >= int(argon2["parallelism"])
            and parameters.salt_len >= int(argon2["salt_len"])
            and parameters.hash_len >= int(argon2["hash_len"])
        )
    except Exception:
        meets_floor = False
    if not meets_floor:
        raise ValueError("Login authentication configuration is invalid.")
