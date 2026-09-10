from datetime import datetime, timezone

import pytest

from music_app.services.auth_throttle_cleanup_postgres import (
    PostgresAuthThrottleCleanupService,
)


NOW = datetime(2026, 8, 31, 20, 0, tzinfo=timezone.utc)


class Cursor:
    def fetchall(self):
        return ((1,), (2,), (3,))


class Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Connection:
    def __init__(self):
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def transaction(self):
        return Transaction()

    def execute(self, sql, params):
        self.operations.append((" ".join(sql.split()), params))
        return Cursor()


def test_cleanup_deletes_only_expired_unblocked_buckets_in_one_bounded_batch():
    connection = Connection()
    service = PostgresAuthThrottleCleanupService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@localhost/db"},
        connect=lambda _url: connection,
        clock=lambda: NOW,
    )

    assert service.cleanup(batch_size=250) == 3

    sql, params = connection.operations[0]
    assert "window_expires_at <= %s" in sql
    assert "blocked_until is null or blocked_until <= %s" in sql
    assert "order by window_expires_at, id" in sql
    assert "limit %s" in sql
    assert "for update skip locked" in sql
    assert "delete from app.auth_throttles" in sql
    assert params == (NOW, NOW, 250)


@pytest.mark.parametrize("batch_size", [0, -1, True, 10_001, "100"])
def test_cleanup_rejects_unbounded_or_invalid_batch_sizes(batch_size):
    service = PostgresAuthThrottleCleanupService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@localhost/db"},
        connect=lambda _url: Connection(),
        clock=lambda: NOW,
    )

    with pytest.raises(ValueError, match="batch size"):
        service.cleanup(batch_size=batch_size)


def test_cleanup_requires_runtime_database_and_redacts_failures():
    with pytest.raises(RuntimeError, match="not configured"):
        PostgresAuthThrottleCleanupService({})

    service = PostgresAuthThrottleCleanupService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://user:secret@localhost/db"},
        connect=lambda _url: (_ for _ in ()).throw(RuntimeError("secret")),
        clock=lambda: NOW,
    )
    with pytest.raises(RuntimeError, match="cleanup failed") as raised:
        service.cleanup(batch_size=100)
    assert "secret@" not in str(raised.value)
