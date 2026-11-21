"""Generic password-reset requests with durable privacy-minimized throttling."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any

from music_app.services.auth_audit_postgres import (
    RecoveryAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_config import normalize_email_address
from music_app.services.auth_mail_jobs_postgres import (
    AcceptedAuthMailJob,
    PostgresAuthMailJobRepository,
)
from music_app.services.auth_tokens import keyed_bucket_digest, normalize_login_identifier

try:  # pragma: no cover - exercised when the optional runtime driver is present.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_CANDIDATE_DOMAIN = "album-haven:reset-candidate"
_ACCOUNT_DOMAIN = "album-haven:reset-account"
_SOURCE_DOMAIN = "album-haven:reset-source"
_REQUEST_REFERENCE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
_SOURCE_CLASSES = frozenset({"loopback", "private", "public", "trusted_proxy"})
_THROTTLE_COLUMNS = (
    "bucket_kind",
    "window_started_at",
    "failure_count",
    "window_expires_at",
    "blocked_until",
)


@dataclass(frozen=True, repr=False, slots=True)
class PasswordResetRequestResult:
    accepted: bool = True
    accepted_job: AcceptedAuthMailJob | None = None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(accepted=True, accepted_job={self.accepted_job!r})"


class PostgresPasswordResetRequestService:
    """Accept reset requests without exposing identity, throttle, or issue state."""

    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        audit_repository: Any,
        job_repository: Any | None = None,
    ) -> None:
        payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(payload.get(_DATABASE_URL_KEY) or "").strip()
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for password recovery."
            )
        hmac_config = _mapping(payload.get("hmac"), "HMAC configuration")
        secret = hmac_config.get("secret")
        if not isinstance(secret, str):
            raise ValueError("Password recovery configuration is invalid.")
        try:
            self._hmac_secret = secret.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Password recovery configuration is invalid.") from None
        if len(self._hmac_secret) < 32:
            raise ValueError("Password recovery configuration is invalid.")
        self._hmac_key_version = _positive_integer(
            hmac_config.get("key_version"), "HMAC key version"
        )
        throttles = _mapping(payload.get("throttles"), "throttle configuration")
        self._limits: dict[str, int] = {}
        self._windows: dict[str, int] = {}
        for kind in ("reset_candidate", "reset_account", "reset_source"):
            policy = _mapping(throttles.get(kind), f"{kind} throttle configuration")
            self._limits[kind] = _positive_integer(policy.get("limit"), "limit")
            self._windows[kind] = _positive_integer(
                policy.get("window_seconds"), "window"
            )
        self._token_seconds = _positive_integer(
            payload.get("reset_token_seconds"), "reset token lifetime"
        )
        if self._token_seconds > 1800:
            raise ValueError("Password recovery configuration is invalid.")
        if not callable(getattr(audit_repository, "append_in_transaction", None)):
            raise TypeError("Password recovery audit repository is invalid.")
        self._connect = connect or _connect
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._audit = audit_repository
        self._jobs = job_repository or PostgresAuthMailJobRepository(
            database_url=self._database_url,
            connect_to_database=self._connect,
        )

    def request_reset(
        self,
        *,
        candidate: object,
        source_key: object,
        request_ref: object,
        source_class: object = None,
        request_origin_ref: str | None = None,
        deployment_mode: str = "self_hosted",
        client_surface: str = "private_web",
    ) -> PasswordResetRequestResult:
        now = _aware_utc(self._clock())
        request_ref = _request_ref(request_ref)
        source_class = _source_class(source_class)
        normalized_candidate = _candidate(candidate)
        normalized_source = _source(source_key)
        candidate_digest = self._bucket(_CANDIDATE_DOMAIN, normalized_candidate)
        source_digest = self._bucket(_SOURCE_DOMAIN, normalized_source)

        try:
            with self._connect(self._database_url) as connection:
                transaction = getattr(connection, "transaction", None)
                if not callable(transaction):
                    raise RuntimeError
                with transaction():
                    account = self._load_account(connection, normalized_candidate)
                    buckets = [
                        ("reset_candidate", candidate_digest),
                        ("reset_source", source_digest),
                    ]
                    if account is not None:
                        account_id = _positive_integer(account.get("id"), "account id")
                        buckets.append(
                            (
                                "reset_account",
                                self._bucket(_ACCOUNT_DOMAIN, str(account_id)),
                            )
                        )
                    buckets.sort(key=lambda item: item[0])
                    blocked, account_throttle_id, now = self._charge_buckets(
                        connection, buckets, now
                    )
                    if blocked:
                        self._append_audit(
                            connection,
                            outcome=SecurityAuditOutcome.THROTTLED,
                            reason=RecoveryAuditReason.BUCKET_BLOCKED,
                            target_account_id=(
                                _positive_integer(account.get("id"), "account id")
                                if account is not None
                                else None
                            ),
                            request_ref=request_ref,
                            source_class=source_class,
                            now=now,
                        )
                        return PasswordResetRequestResult()

                    if not _eligible(account):
                        self._append_audit(
                            connection,
                            outcome=SecurityAuditOutcome.INVALID,
                            reason=RecoveryAuditReason.ACCOUNT_INELIGIBLE,
                            target_account_id=(
                                _positive_integer(account.get("id"), "account id")
                                if account is not None
                                else None
                            ),
                            request_ref=request_ref,
                            source_class=source_class,
                            now=now,
                        )
                        return PasswordResetRequestResult()

                    assert account is not None
                    account_id = _positive_integer(account.get("id"), "account id")
                    credential_version = _positive_integer(
                        account.get("credential_version"), "credential version"
                    )
                    outbox_rows = connection.execute(
                        """
                        insert into app.mail_outbox (
                          account_id, message_category, delivery_status,
                          attempt_count, next_attempt_at, row_revision,
                          accepted_attempt, authorization_mode,
                          delivery_checkpoint, target_credential_version,
                          lifecycle_expires_at, public_throttle_id,
                          created_at, updated_at
                        ) values (
                          %s, 'password_reset', 'pending', 0, %s, 0, 1,
                          'public_lifecycle', 'accepted', %s, %s, %s, %s, %s
                        )
                        returning id
                        """,
                        (
                            account_id, now, credential_version,
                            now + timedelta(seconds=self._token_seconds),
                            account_throttle_id, now, now,
                        ),
                    ).fetchall()
                    outbox_id = _returned_id(outbox_rows, "outbox")
                    job = self._jobs.compose_existing_intent_in_transaction(
                        connection, outbox_id=outbox_id,
                        category="password_reset", account_id=account_id,
                        actor_account_id=None, library_id=None,
                        request_origin_ref=request_origin_ref,
                        deployment_mode=deployment_mode,
                        client_surface=client_surface,
                        scheduled_at=now,
                    )
                    self._append_audit(
                        connection,
                        outcome=SecurityAuditOutcome.SUCCESS,
                        reason=RecoveryAuditReason.RESET_ISSUED,
                        target_account_id=account_id,
                        request_ref=request_ref,
                        source_class=source_class,
                        now=now,
                    )
            return PasswordResetRequestResult(accepted_job=job)
        except (TypeError, ValueError):
            raise
        except Exception:
            raise RuntimeError("Password recovery persistence operation failed.") from None

    def _load_account(
        self, connection: Any, normalized_candidate: str
    ) -> Mapping[str, object] | None:
        rows = connection.execute(
            """
            select account.id, account.is_active,
                   account.disabled_at, account.contact_email,
                   credential.credential_version
            from app.accounts account
            join app.account_credentials credential
              on credential.account_id = account.id
            where account.username_normalized = %s
               or account.contact_email_normalized = %s
            order by account.id
            limit 1
            for share of account, credential
            """,
            (normalized_candidate, normalized_candidate),
        ).fetchall()
        if not rows:
            return None
        if len(rows) != 1:
            raise RuntimeError
        return _row(rows[0], ("id", "is_active", "disabled_at", "contact_email", "credential_version"))

    def _charge_buckets(
        self,
        connection: Any,
        buckets: list[tuple[str, bytes]],
        now: datetime,
    ) -> tuple[bool, int | None, datetime]:
        # Retain each conflicting bucket against expiry cleanup without
        # replacing its current window, count or cooldown.
        for kind, digest in buckets:
            connection.execute(
                """
                insert into app.auth_throttles (
                  bucket_kind, bucket_hash, key_version, window_started_at,
                  window_expires_at, failure_count, updated_at
                ) values (%s, %s, %s, %s, %s, 0, %s)
                on conflict (bucket_kind, key_version, bucket_hash)
                do update set updated_at = app.auth_throttles.updated_at
                """,
                (
                    kind,
                    digest,
                    self._hmac_key_version,
                    now,
                    now + timedelta(seconds=self._windows[kind]),
                    now,
                ),
            )
        clauses = " or ".join("(bucket_kind = %s and bucket_hash = %s)" for _ in buckets)
        params: list[object] = [self._hmac_key_version]
        for kind, digest in buckets:
            params.extend((kind, digest))
        rows = connection.execute(
            f"""
            select id, bucket_kind, window_started_at, failure_count,
                   window_expires_at, blocked_until
            from app.auth_throttles
            where key_version = %s and ({clauses})
            order by bucket_kind, key_version, bucket_hash
            for update
            """,
            tuple(params),
        ).fetchall()
        if len(rows) != len(buckets):
            raise RuntimeError
        # Every bucket is retained and locked before evaluating a shared budget time.
        now = _aware_utc(self._clock())
        by_kind = dict(buckets)
        blocked = False
        account_throttle_id = None
        for raw in rows:
            row = _row(raw, _THROTTLE_COLUMNS)
            kind = str(row.get("bucket_kind") or "")
            if kind not in by_kind:
                raise RuntimeError
            if kind == "reset_account":
                account_throttle_id = _positive_integer(
                    raw.get("id"), "account throttle id"
                )
            count = _nonnegative_integer(row.get("failure_count"), "failure count")
            expires = _timestamp(row.get("window_expires_at"))
            blocked_until_value = row.get("blocked_until")
            blocked_until = (
                _timestamp(blocked_until_value)
                if blocked_until_value is not None
                else None
            )
            if now >= expires:
                count = 0
                connection.execute(
                    """
                    update app.auth_throttles
                    set window_started_at = %s, window_expires_at = %s,
                        failure_count = 0, blocked_until = null, updated_at = %s
                    where bucket_kind = %s and key_version = %s and bucket_hash = %s
                    """,
                    (
                        now,
                        now + timedelta(seconds=self._windows[kind]),
                        now,
                        kind,
                        self._hmac_key_version,
                        by_kind[kind],
                    ),
                )
            elif count >= self._limits[kind] or (
                blocked_until is not None and now < blocked_until
            ):
                blocked = True
        if not blocked:
            for kind, digest in buckets:
                connection.execute(
                    """
                    update app.auth_throttles
                    set failure_count = failure_count + 1, updated_at = %s
                    where bucket_kind = %s and key_version = %s and bucket_hash = %s
                    """,
                    (now, kind, self._hmac_key_version, digest),
                )
        return blocked, account_throttle_id, now

    def _bucket(self, domain: str, value: str) -> bytes:
        return keyed_bucket_digest(
            secret=self._hmac_secret,
            key_version=self._hmac_key_version,
            domain=domain,
            normalized_value=value,
        ).digest

    def _append_audit(
        self,
        connection: Any,
        *,
        outcome: SecurityAuditOutcome,
        reason: RecoveryAuditReason,
        target_account_id: int | None,
        request_ref: str,
        source_class: str | None,
        now: datetime,
    ) -> None:
        metadata: dict[str, object] = {"hmac_key_version": self._hmac_key_version}
        if source_class is not None:
            metadata["source_class"] = source_class
        self._audit.append_in_transaction(
            connection,
            category=SecurityAuditCategory.PASSWORD_RECOVERY,
            outcome=outcome,
            reason=reason,
            actor_account_id=None,
            target_account_id=target_account_id,
            request_ref=request_ref,
            occurred_at=now,
            metadata=metadata,
        )


def _candidate(value: object) -> str:
    if not isinstance(value, str):
        return "invalid"
    try:
        if "@" in value:
            return normalize_email_address(value, "recovery candidate")
        return normalize_login_identifier(value)
    except ValueError:
        fallback = value.strip().casefold()
        if not fallback or len(fallback) > 256 or any(ord(item) < 32 for item in fallback):
            return "invalid"
        return fallback


def _source(value: object) -> str:
    if not isinstance(value, str):
        return "invalid"
    normalized = value.strip().casefold()
    if not normalized or len(normalized) > 256 or any(ord(item) < 32 for item in normalized):
        return "invalid"
    return normalized


def _eligible(account: Mapping[str, object] | None) -> bool:
    return bool(
        account is not None
        and account.get("is_active") is True
        and account.get("disabled_at") is None
        and isinstance(account.get("contact_email"), str)
        and str(account.get("contact_email")).strip()
        and isinstance(account.get("credential_version"), int)
        and not isinstance(account.get("credential_version"), bool)
        and int(account.get("credential_version")) >= 1
    )


def _request_ref(value: object) -> str:
    if not isinstance(value, str) or _REQUEST_REFERENCE.fullmatch(value) is None:
        raise ValueError("Password recovery request reference is invalid.")
    return value


def _source_class(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value not in _SOURCE_CLASSES:
        raise ValueError("Password recovery source class is invalid.")
    return value


def _mapping(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"Password recovery {field} is invalid.")
    return value


def _row(row: object, columns: tuple[str, ...]) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)):
        return dict(zip(columns, row, strict=False))
    return {}


def _returned_id(rows: list[object], field: str) -> int:
    if len(rows) != 1:
        raise RuntimeError
    return _positive_integer(_row(rows[0], ("id",)).get("id"), field)


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Password recovery {field} is invalid.")
    return value


def _nonnegative_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError(f"Password recovery {field} is invalid.")
    return value


def _timestamp(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError
    return value.astimezone(timezone.utc)


def _aware_utc(value: object) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise RuntimeError("Password recovery clock is invalid.")
    return value.astimezone(timezone.utc)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for password recovery.")
    return psycopg.connect(database_url, row_factory=dict_row)
