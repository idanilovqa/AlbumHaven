"""Shared password-work capacity and the existing durable account guess budget."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import threading
from typing import Any

from music_app.services.auth_tokens import keyed_bucket_digest, normalize_login_identifier


_PROCESS_CAPACITY = threading.BoundedSemaphore(2)


class _SingleWorkerCapacity:
    def __init__(self):
        self._local = threading.BoundedSemaphore(1)

    def acquire(self, blocking=False):
        if not self._local.acquire(blocking=blocking):
            return False
        if _PROCESS_CAPACITY.acquire(blocking=blocking):
            return True
        self._local.release()
        return False

    def release(self):
        _PROCESS_CAPACITY.release()
        self._local.release()


_SINGLE_WORKER_CAPACITY = _SingleWorkerCapacity()


def shared_verification_capacity(config: Mapping[str, object]):
    """Every service uses one process-wide ceiling, including a configured limit of one."""
    limit = config.get("verification_semaphore", 2)
    if type(limit) is not int or limit not in (1, 2):
        raise ValueError("Password verification capacity is invalid.")
    return _SINGLE_WORKER_CAPACITY if limit == 1 else _PROCESS_CAPACITY


@dataclass(frozen=True, repr=False)
class _Reservation:
    digest: bytes
    window_started_at: datetime


def _utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise RuntimeError("Credential attempt state is unavailable.")
    return value.astimezone(timezone.utc)


class PostgresCredentialAttempts:
    """Use login_account only; authenticated actions have no login-source bucket."""
    def __init__(self, config: Mapping[str, object], *, connect: Callable[[str], Any], clock):
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        hmac_config = config.get("hmac")
        throttles = config.get("throttles")
        if not isinstance(hmac_config, Mapping) or not isinstance(throttles, Mapping):
            raise ValueError("Credential attempt configuration is invalid.")
        policy = throttles.get("login_account")
        secret = hmac_config.get("secret")
        if not isinstance(policy, Mapping) or not isinstance(secret, str):
            raise ValueError("Credential attempt configuration is invalid.")
        self._secret = secret.encode("utf-8")
        self._version = hmac_config.get("key_version")
        self._limit = policy.get("limit")
        self._window = policy.get("window_seconds")
        self._cooldown = throttles.get("login_cooldown_seconds")
        if len(self._secret) < 32 or any(type(value) is not int or value < 1
                for value in (self._version, self._limit, self._window, self._cooldown)):
            raise ValueError("Credential attempt configuration is invalid.")
        self._connect, self._clock = connect, clock

    def reserve(self, username: str):
        digest = keyed_bucket_digest(secret=self._secret, key_version=self._version,
            domain="album-haven:login-account", normalized_value=normalize_login_identifier(username)).digest
        now = _utc(self._clock())
        with self._connect(self._database_url) as connection, connection.transaction():
            connection.execute("""insert into app.auth_throttles
                (bucket_kind, bucket_hash, key_version, window_started_at, window_expires_at, failure_count)
                values ('login_account', %s, %s, %s, %s, 0)
                on conflict (bucket_kind, key_version, bucket_hash) do nothing""",
                (digest, self._version, now, now + timedelta(seconds=self._window)))
            row = self._locked(connection, digest)
            expires = _utc(row.get("window_expires_at"))
            blocked = row.get("blocked_until")
            count = self._count(row)
            if blocked is not None and now < _utc(blocked):
                return None
            if now < expires and count >= self._limit:
                return None
            started = _utc(row.get("window_started_at"))
            if now >= expires:
                started = now
                self._updated(connection.execute("""update app.auth_throttles
                    set window_started_at = %s, window_expires_at = %s, failure_count = 0,
                        blocked_until = null, updated_at = %s
                    where bucket_kind = 'login_account' and key_version = %s and bucket_hash = %s""",
                    (now, now + timedelta(seconds=self._window), now, self._version, digest)))
            self._updated(connection.execute("""update app.auth_throttles
                set failure_count = failure_count + 1, updated_at = %s
                where bucket_kind = 'login_account' and key_version = %s and bucket_hash = %s""",
                (now, self._version, digest)))
        return _Reservation(digest, started)

    def finalize(self, reservation, *, successful: bool):
        now = _utc(self._clock())
        with self._connect(self._database_url) as connection, connection.transaction():
            row = self._locked(connection, reservation.digest)
            if _utc(row.get("window_started_at")) != reservation.window_started_at:
                return
            count = self._count(row)
            if successful:
                self._updated(connection.execute("""update app.auth_throttles
                    set failure_count = greatest(failure_count - 1, 0),
                        blocked_until = case when greatest(failure_count - 1, 0) < %s
                            then null else blocked_until end, updated_at = %s
                    where bucket_kind = 'login_account' and key_version = %s and bucket_hash = %s
                        and window_started_at = %s""",
                    (self._limit, now, self._version, reservation.digest, reservation.window_started_at)))
            elif count >= self._limit:
                self._updated(connection.execute("""update app.auth_throttles
                    set blocked_until = %s, updated_at = %s
                    where bucket_kind = 'login_account' and key_version = %s and bucket_hash = %s
                        and window_started_at = %s""",
                    (now + timedelta(seconds=self._cooldown), now, self._version,
                     reservation.digest, reservation.window_started_at)))

    def _locked(self, connection, digest):
        rows = connection.execute("""select window_started_at, window_expires_at,
                failure_count, blocked_until from app.auth_throttles
            where bucket_kind = 'login_account' and key_version = %s and bucket_hash = %s
            for update""", (self._version, digest)).fetchall()
        if len(rows) != 1 or not isinstance(rows[0], Mapping):
            raise RuntimeError("Credential attempt state is unavailable.")
        return rows[0]

    @staticmethod
    def _count(row):
        count = row.get("failure_count")
        if type(count) is not int or count < 0:
            raise RuntimeError("Credential attempt state is unavailable.")
        return count

    @staticmethod
    def _updated(cursor):
        if getattr(cursor, "rowcount", None) != 1:
            raise RuntimeError("Credential attempt persistence failed.")
