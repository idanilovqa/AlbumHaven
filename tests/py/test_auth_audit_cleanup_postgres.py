from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.auth_audit_cleanup_postgres import (
    PostgresSecurityAuditCleanupService,
)


NOW = datetime(2026, 8, 31, 18, 0, tzinfo=timezone.utc)


class Cursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Connection:
    def __init__(self, rows=((1,), (2,))):
        self.rows = rows
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def transaction(self):
        return Transaction()

    def execute(self, sql, params):
        self.operations.append((" ".join(sql.split()), params))
        return Cursor(self.rows)


def _config(**overrides):
    config = {
        "ALBUM_HAVEN_MIGRATOR_DATABASE_URL": "postgresql://migrator@localhost/db",
        "audit_retention_seconds": 90 * 24 * 60 * 60,
    }
    config.update(overrides)
    return config


def test_cleanup_deletes_only_one_ordered_bounded_batch_before_cutoff():
    connection = Connection()
    connected_urls = []
    service = PostgresSecurityAuditCleanupService(
        _config(),
        connect=lambda url: connected_urls.append(url) or connection,
        clock=lambda: NOW,
    )

    assert service.cleanup(batch_size=250) == 2

    sql, params = connection.operations[0]
    assert "occurred_at < %s" in sql
    assert "order by occurred_at, id" in sql
    assert "limit %s" in sql
    assert "for update skip locked" in sql
    assert "delete from app.security_audit_events" in sql
    assert params == (NOW - timedelta(days=90), 250)
    assert connected_urls == ["postgresql://migrator@localhost/db"]


@pytest.mark.parametrize(
    "config",
    [
        _config(audit_retention_seconds=90 * 24 * 60 * 60 - 1),
        _config(audit_retention_seconds=True),
        _config(ALBUM_HAVEN_MIGRATOR_DATABASE_URL=""),
    ],
)
def test_cleanup_rejects_unsafe_or_missing_configuration(config):
    with pytest.raises((ValueError, RuntimeError), match="audit cleanup"):
        PostgresSecurityAuditCleanupService(config)


@pytest.mark.parametrize("batch_size", [0, -1, True, 10_001, "100"])
def test_cleanup_rejects_unbounded_or_invalid_batch_sizes(batch_size):
    service = PostgresSecurityAuditCleanupService(
        _config(), connect=lambda _url: Connection(), clock=lambda: NOW
    )

    with pytest.raises(ValueError, match="batch size"):
        service.cleanup(batch_size=batch_size)


def test_cleanup_redacts_database_failures():
    secret = "postgresql://user:private-password@localhost/db"

    def fail(_url):
        raise RuntimeError(secret)

    service = PostgresSecurityAuditCleanupService(
        _config(ALBUM_HAVEN_MIGRATOR_DATABASE_URL=secret),
        connect=fail,
        clock=lambda: NOW,
    )

    with pytest.raises(RuntimeError, match="Security audit cleanup failed") as raised:
        service.cleanup(batch_size=100)
    assert "private-password" not in str(raised.value)
