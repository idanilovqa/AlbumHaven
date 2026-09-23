"""Recovery budget and issuance timestamps follow real PostgreSQL lock waits."""

from datetime import timedelta
from threading import Event, Thread
from time import monotonic

import pytest

from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_password_reset_request_postgres import PostgresPasswordResetRequestService
from music_app.services.auth_tokens import issue_opaque_token
from tests.e2e.support import isolatedPostgres
from tests.py.test_auth_locking_live import auth_lock_inventory  # noqa: F401


@pytest.mark.parametrize("locked_row, remains_blocked", [
    ("account", False), ("source_bucket", False), ("source_bucket", True),
])
def test_live_reset_request_refreshes_time_after_lock_wait(
    auth_lock_inventory, locked_row, remains_blocked,
):
    fixture = auth_lock_inventory
    clock = [fixture.now]
    config = {**fixture.config, "hmac": {"secret": "r" * 32, "key_version": 1},
        "reset_token_seconds": 10,
        "throttles": {kind: {"limit": 1, "window_seconds": 10}
            for kind in ("reset_account", "reset_candidate", "reset_source")}}
    audit = PostgresSecurityAuditRepository()
    service = PostgresPasswordResetRequestService(config, clock=lambda: clock[0], audit_repository=audit)
    buckets = [
        ("reset_account", service._bucket("album-haven:reset-account", str(fixture.target_id))),
        ("reset_candidate", service._bucket("album-haven:reset-candidate", "auth.race")),
        ("reset_source", service._bucket("album-haven:reset-source", "203.0.113.9")),
    ]
    old_token = issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$reset-clock', 1, 1)""", (fixture.target_id,))
        old_id = connection.execute("""insert into app.password_reset_tokens
            (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
            values (%s, %s, 1, %s, %s, 'reset-clock-seed') returning id""",
            (fixture.target_id, old_token.digest, fixture.now,
             fixture.now + timedelta(minutes=5))).fetchone()["id"]
        for kind, digest in buckets:
            expiry = fixture.now + timedelta(seconds=60 if remains_blocked and kind == "reset_source" else 10)
            connection.execute("""insert into app.auth_throttles
                (bucket_kind, bucket_hash, key_version, window_started_at, window_expires_at,
                 failure_count, updated_at) values (%s, %s, 1, %s, %s, 1, %s)""",
                (kind, digest, fixture.now, expiry, fixture.now))

    started = Event()
    backend, results, failures = [], [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        started.set()
        return connection

    def request():
        try:
            results.append(PostgresPasswordResetRequestService(config, connect=connect,
                clock=lambda: clock[0], audit_repository=audit).request_reset(
                    candidate="auth.race", source_key="203.0.113.9", request_ref="reset-clock-wait"))
        except BaseException as exc:
            failures.append(exc)

    worker = None
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            if locked_row == "account":
                locker.execute("select id from app.accounts where id = %s for update",
                    (fixture.target_id,)).fetchone()
            else:
                locker.execute("""select bucket_kind from app.auth_throttles
                    where bucket_kind = 'reset_source' and key_version = 1 and bucket_hash = %s
                    for update""", (buckets[-1][1],)).fetchone()
            worker = Thread(target=request)
            worker.start()
            assert started.wait(2), f"request did not connect: {failures!r}"
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                deadline, blocked = monotonic() + 3, False
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, "request did not reach the held lock"
            clock[0] += timedelta(seconds=20)
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "cannot clean the database while request is active"

    assert failures == []
    assert len(results) == 1 and results[0].accepted is True
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        tokens = connection.execute("""select id, created_at, expires_at, revoked_at
            from app.password_reset_tokens where account_id = %s order by id""",
            (fixture.target_id,)).fetchall()
        outbox = connection.execute("select created_at from app.mail_outbox where account_id = %s",
            (fixture.target_id,)).fetchall()
        events = connection.execute("""select occurred_at, outcome from app.security_audit_events
            where request_ref = 'reset-clock-wait'""").fetchall()
        budgets = connection.execute("""select bucket_kind, failure_count, window_started_at,
            window_expires_at, updated_at from app.auth_throttles where key_version = 1
            order by bucket_kind""").fetchall()
    assert tokens[0]["id"] == old_id
    assert events == [{"occurred_at": clock[0], "outcome": "throttled" if remains_blocked else "success"}]
    if remains_blocked:
        assert results[0].delivery is None
        assert len(tokens) == 1 and tokens[0]["revoked_at"] is None
        assert outbox == []
        assert [row["failure_count"] for row in budgets] == [0, 0, 1]
        assert budgets[-1]["window_started_at"] == fixture.now
        assert budgets[-1]["updated_at"] == fixture.now
    else:
        assert results[0].delivery is not None
        assert len(tokens) == 2 and tokens[0]["revoked_at"] == clock[0]
        assert tokens[1]["created_at"] == clock[0]
        assert tokens[1]["expires_at"] == clock[0] + timedelta(seconds=10)
        assert tokens[1]["revoked_at"] is None
        assert outbox == [{"created_at": clock[0]}]
        assert len(budgets) == 3
        for row in budgets:
            assert row["failure_count"] == 1
            assert row["window_started_at"] == row["updated_at"] == clock[0]
            assert row["window_expires_at"] == clock[0] + timedelta(seconds=10)
