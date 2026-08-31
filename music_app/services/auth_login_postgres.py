"""Durable, enumeration-resistant local-login authentication."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import hashlib
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
from music_app.services.auth_tokens import (
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


class LoginOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"
    THROTTLED = "throttled"


@dataclass(frozen=True, slots=True)
class LoginResult:
    outcome: LoginOutcome
    account_id: int | None = None
    administrator_set: bool | None = None


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

    def authenticate(
        self,
        *,
        entered_username: object,
        password: object,
        source_key: object,
    ) -> LoginResult:
        now = _aware_now(self._clock)
        normalized, lookup_allowed = _candidate_identifier(entered_username)
        source, source_allowed = _source_key(source_key)
        verification_password, password_allowed = self._verification_password(password)
        lookup_allowed = lookup_allowed and source_allowed and password_allowed
        buckets = self._buckets(normalized, source)

        reservation = self._reserve_capacity(buckets, now)
        if reservation is None:
            return LoginResult(LoginOutcome.THROTTLED)
        if not self._semaphore.acquire(blocking=False):
            self._finalize_failure(reservation, now)
            return LoginResult(LoginOutcome.THROTTLED)

        account: Mapping[str, object] | None = None
        credential: _CredentialSnapshot | None = None
        verification = PasswordVerification(valid=False, needs_rehash=False)
        used_real_credential = False
        try:
            if lookup_allowed:
                account, credential = self._load_identity(normalized)
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
            except Exception:
                verification = PasswordVerification(valid=False, needs_rehash=False)
        finally:
            self._semaphore.release()

        succeeded = bool(
            lookup_allowed
            and used_real_credential
            and account is not None
            and credential is not None
            and _account_is_active(account)
            and verification.valid
        )
        replacement: PasswordCredential | None = None
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

        if succeeded:
            succeeded = self._finalize_success(
                account,
                credential,
                reservation,
                now,
                replacement=replacement,
            )
        else:
            self._finalize_failure(reservation, now)
        if not succeeded:
            return LoginResult(LoginOutcome.INVALID)
        return LoginResult(
            LoginOutcome.SUCCESS,
            account_id=_positive_integer(account.get("id"), "account id"),
            administrator_set=credential.administrator_set,
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
        self, buckets: tuple[tuple[str, bytes], ...], now: datetime
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
                    return None
                if now < expires and count >= self._limits[kind]:
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
    ) -> None:
        with self._operation() as connection:
            rows = self._lock_reserved_throttles(connection, reservation)
            for raw_row, reserved in zip(rows, reservation, strict=True):
                row = _row(raw_row, _THROTTLE_COLUMNS)
                count = _nonnegative_integer(row.get("failure_count"), "failure count")
                if count >= self._limits[reserved.kind]:
                    _execute(
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
    ) -> bool:
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
            rows = self._lock_reserved_throttles(connection, reservation)
            for raw_row, reserved in zip(rows, reservation, strict=True):
                if identity_current:
                    _execute(
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
                else:
                    row = _row(raw_row, _THROTTLE_COLUMNS)
                    count = _nonnegative_integer(
                        row.get("failure_count"), "failure count"
                    )
                    if count >= self._limits[reserved.kind]:
                        _execute(
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
        return identity_current

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
        return _timestamp(clock())
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
