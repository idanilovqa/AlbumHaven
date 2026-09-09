"""Real database coverage for reset budgets, replay and welcome retry delivery."""

from datetime import timedelta
from threading import Barrier, Event, Thread
from time import monotonic

import pytest

from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_passwords import PasswordCredential
from music_app.services.auth_tokens import issue_opaque_token
from tests.e2e.support import isolatedPostgres
from tests.py.test_auth_locking_live import auth_lock_inventory, _ObservedAuthConnection


def _seed_credential(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$before-reset', 1, 7)""", (fixture.target_id,))


def _reset_service(fixture, clock, *, connect=None):
    from music_app.services.auth_password_reset_request_postgres import PostgresPasswordResetRequestService
    from tests.py.test_auth_password_reset_request_postgres import _config
    return PostgresPasswordResetRequestService(
        {**_config(), "ALBUM_HAVEN_APP_DATABASE_URL": fixture.runtime_url},
        clock=lambda: clock[0], connect=connect or isolatedPostgres._connect,
        audit_repository=PostgresSecurityAuditRepository(),
    )


def _request(service, candidate="auth.race", source="198.51.100.14"):
    return service.request_reset(candidate=candidate, source_key=source,
        request_ref="recovery-live", source_class="public")


def _delivery_snapshot(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return [connection.execute(
            f"select * from {table} where account_id = %s order by id", (fixture.target_id,),
        ).fetchall() for table in ("app.password_reset_tokens", "app.mail_outbox")]


@pytest.mark.parametrize("expired_kind", ["reset_candidate", "reset_account", "reset_source"])
def test_live_reset_reservation_retains_expired_bucket_against_cleanup(auth_lock_inventory, expired_kind):
    from music_app.services.auth_throttle_cleanup_postgres import PostgresAuthThrottleCleanupService
    fixture = auth_lock_inventory
    _seed_credential(fixture)
    clock = [fixture.now]
    service = _reset_service(fixture, clock)
    assert _request(service).delivery is not None
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update app.auth_throttles
            set window_started_at = %s, window_expires_at = %s, failure_count = 4
            where bucket_kind = %s""",
            (fixture.now - timedelta(hours=2), fixture.now - timedelta(seconds=1), expired_kind))
        before = connection.execute("select bucket_kind, window_started_at from app.auth_throttles").fetchall()
    cleanup = PostgresAuthThrottleCleanupService(fixture.config, clock=lambda: clock[0])
    cleaned = []

    class AfterConflict(_ObservedAuthConnection):
        def execute(self, sql, params=()):
            result = self.connection.execute(sql, params)
            if "insert into app.auth_throttles" in " ".join(sql.casefold().split()) and params[0] == expired_kind:
                cleaned.append(cleanup.cleanup(batch_size=20))
            return result

    result = _request(_reset_service(fixture, clock,
        connect=lambda url: AfterConflict(isolatedPostgres._connect(url))))
    assert result.accepted and result.delivery is not None
    assert cleaned == [0], "The actual cleanup must skip the reserved conflicting row"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("select bucket_kind, window_started_at, failure_count from app.auth_throttles").fetchall()
    assert len(rows) == 3
    starts = {row["bucket_kind"]: row["window_started_at"] for row in before}
    for row in rows:
        assert row["failure_count"] == (1 if row["bucket_kind"] == expired_kind else 2)
        assert row["window_started_at"] == (fixture.now if row["bucket_kind"] == expired_kind else starts[row["bucket_kind"]])


@pytest.mark.parametrize("kind", ["reset_candidate", "reset_account", "reset_source"])
def test_live_reset_limits_are_independent_and_roll_over_without_losing_pending_token(auth_lock_inventory, kind):
    fixture = auth_lock_inventory
    clock = [fixture.now]
    service = _reset_service(fixture, clock)
    if kind == "reset_candidate":
        # No credential exists yet, so these charge no account budget.
        for index in range(5):
            assert _request(service, source=f"198.51.100.{index + 1}").delivery is None
        _seed_credential(fixture)
        assert _request(service, "auth.race@example.test", "203.0.113.2").delivery is not None
    else:
        _seed_credential(fixture)
        assert _request(service, "auth.race@example.test", "203.0.113.2").delivery is not None
        if kind == "reset_source":
            for index in range(20):
                assert _request(service, f"absent-{index}").delivery is None
        else:
            for index in range(4):
                candidate = "auth.race" if index % 2 == 0 else "auth.race@example.test"
                assert _request(service, candidate, f"203.0.113.{index + 3}").delivery is not None
    before = _delivery_snapshot(fixture)
    result = _request(service)
    assert result.accepted and result.delivery is None
    assert _delivery_snapshot(fixture) == before, "Blocked recovery must not revoke or issue anything"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        # Keep all other buckets current across the tested bucket's boundary.
        connection.execute("""update app.auth_throttles set window_started_at = %s,
            window_expires_at = %s where bucket_kind <> %s""",
            (fixture.now + timedelta(minutes=59), fixture.now + timedelta(minutes=119), kind))
        current = connection.execute("select id, failure_count, window_started_at from app.auth_throttles where bucket_kind <> %s", (kind,)).fetchall()
    clock[0] = fixture.now + timedelta(hours=1)
    result = _request(service)
    assert result.accepted and result.delivery is not None
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        refreshed = connection.execute("""select failure_count, window_started_at from app.auth_throttles
            where bucket_kind = %s and window_started_at = %s""", (kind, clock[0])).fetchall()
        after = connection.execute("select id, failure_count, window_started_at from app.auth_throttles where bucket_kind <> %s", (kind,)).fetchall()
    assert refreshed and all(row["failure_count"] == 1 for row in refreshed)
    old = {row["id"]: row for row in current}
    for row in after:
        if row["id"] in old:
            assert row["window_started_at"] == old[row["id"]]["window_started_at"]
            assert row["failure_count"] in (old[row["id"]]["failure_count"], old[row["id"]]["failure_count"] + 1)


def test_live_concurrent_reset_completion_commits_exactly_one_winner(auth_lock_inventory):
    from music_app.services.auth_password_reset_lifecycle_postgres import PostgresPasswordResetLifecycleService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    fixture = auth_lock_inventory
    _seed_credential(fixture)
    sessions = PostgresAuthSessionService(fixture.config)
    old_sessions = [sessions.issue_session(fixture.target_id) for _ in range(2)]
    token = issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.password_reset_tokens
            (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
            values (%s, %s, 7, %s, %s, 'concurrent-reset')""",
            (fixture.target_id, token.digest, fixture.now, fixture.now + timedelta(minutes=20)))
    barrier = Barrier(2, timeout=3)
    backend_pids, outcomes, failures = [], [], []

    def connect(url):
        connection = isolatedPostgres._connect(url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        return connection

    def hasher(*_args, **_kwargs):
        barrier.wait()
        return PasswordCredential("$argon2id$one-winner", 1)

    def service(*, racing=False):
        def observed_connect(url):
            connection = connect(url)
            def observe(sql):
                if sql.startswith("select id") and "from app.accounts" in sql and "for update" in sql:
                    backend_pids.append(connection.info.backend_pid)
            # Record admission before the blocking execute, not after it.
            class Observed(_ObservedAuthConnection):
                def execute(self, sql, params=()):
                    observe(" ".join(sql.casefold().split()))
                    return self.connection.execute(sql, params)
            return Observed(connection)
        return PostgresPasswordResetLifecycleService(fixture.config,
            connect=observed_connect if racing else connect, breached_checker=lambda _password: False,
            audit_repository=PostgresSecurityAuditRepository(), password_hasher=hasher)

    transaction = service().exchange_reset_token(token.raw, request_ref="concurrent-exchange")
    assert transaction is not None

    def complete():
        try:
            outcomes.append(service(racing=True).complete_reset(transaction.raw_token,
                new_password="new sufficiently private password", request_ref="concurrent-complete").value)
        except BaseException as error:
            failures.append(error)

    workers = []
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            locker.execute("select id from app.accounts where id = %s for update", (fixture.target_id,))
            workers = [Thread(target=complete) for _ in range(2)]
            for worker in workers:
                worker.start()
            deadline = monotonic() + 4
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                while monotonic() < deadline:
                    # A second tuple waiter can queue behind the first waiter,
                    # rather than report the original locker directly.
                    waiting = [pid for pid in tuple(backend_pids) if inspect.execute(
                        "select cardinality(pg_blocking_pids(%s)) > 0 as waiting",
                        (pid,)).fetchone()["waiting"]]
                    if len(waiting) == 2:
                        break
                    Event().wait(0.01)
                assert len(waiting) == 2, f"Both completions must reach the final lock: {failures!r}"
    finally:
        for worker in workers:
            worker.join(7)
        assert all(not worker.is_alive() for worker in workers)
    assert failures == []
    assert sorted(outcomes) == ["invalid", "success"]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        credential = connection.execute("select credential_version, encoded_hash from app.account_credentials where account_id = %s", (fixture.target_id,)).fetchone()
        assert credential == {"credential_version": 8, "encoded_hash": "$argon2id$one-winner"}
        assert connection.execute("select count(*) as n from app.password_reset_tokens where account_id = %s and consumed_at is not null", (fixture.target_id,)).fetchone()["n"] == 1
        assert connection.execute("select consumed_at from app.password_reset_transactions where id = %s", (transaction.transaction_id,)).fetchone()["consumed_at"] is not None
        assert connection.execute("select count(*) as n from app.account_sessions where account_id = %s and revoked_at is null", (fixture.target_id,)).fetchone()["n"] == 0
        assert connection.execute("select count(*) as n from app.security_audit_events where target_account_id = %s and reason_code = 'reset_completed'", (fixture.target_id,)).fetchone()["n"] == 1
    assert all(sessions.resolve_session(session.raw_token) is None for session in old_sessions)


def test_live_welcome_worker_retries_only_due_known_failure_after_restart(auth_lock_inventory):
    import asyncio
    from music_app.services.auth_mail import DeliveryResult
    from music_app.services.auth_mail_outbox_postgres import PostgresWelcomeOutboxService, deliver_welcome
    from music_app.services.auth_welcome_worker import WelcomeMailWorker
    fixture = auth_lock_inventory
    clock = [fixture.now]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        pending = connection.execute("""insert into app.mail_outbox
            (account_id, message_category, delivery_status, attempt_count, created_at)
            values (%s, 'welcome', 'pending', 0, %s) returning id""", (fixture.target_id, fixture.now)).fetchone()["id"]
        for status, attempts, due in [("unknown", 1, None), ("sent", 1, None),
                ("failed", 5, fixture.now), ("failed", 1, None),
                ("failed", 1, fixture.now + timedelta(hours=2))]:
            connection.execute("""insert into app.mail_outbox
                (account_id, message_category, delivery_status, attempt_count, created_at, next_attempt_at)
                values (%s, 'welcome', %s, %s, %s, %s)""", (fixture.target_id, status, attempts, fixture.now, due))
    repository = PostgresWelcomeOutboxService(fixture.config,
        connect=isolatedPostgres._connect, now=lambda: clock[0])
    config = {"welcome_enabled": True, "connect_timeout_seconds": 1, "command_timeout_seconds": 1}
    calls = []
    async def sender(_message, *, config):
        calls.append(clock[0])
        return DeliveryResult(delivered=len(calls) > 1, reason="delivered" if len(calls) > 1 else "failed")
    async def scenario():
        await deliver_welcome(pending, config=config, repository=repository,
            composer=lambda **_kwargs: object(), sender=sender)
        worker = WelcomeMailWorker(repository=repository, config=config,
            composer=lambda **_kwargs: object(), sender=sender)
        clock[0] += timedelta(seconds=59)
        assert await worker.run_once() == 0
        clock[0] += timedelta(seconds=1)
        assert await worker.run_once() == 1
        assert await worker.run_once() == 0
        await worker.stop()
    asyncio.run(scenario())
    assert calls == [fixture.now, fixture.now + timedelta(seconds=60)]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute("select delivery_status, attempt_count, next_attempt_at from app.mail_outbox where id = %s", (pending,)).fetchone()
        assert row == {"delivery_status": "sent", "attempt_count": 2, "next_attempt_at": None}
        assert connection.execute("select count(*) as n from app.mail_outbox where id <> %s and attempt_count > 1 and delivery_status <> 'failed'", (pending,)).fetchone()["n"] == 0


def test_live_welcome_workers_share_one_claim_and_reconcile_stale_send_without_resending(auth_lock_inventory):
    import asyncio
    from music_app.services.auth_mail import DeliveryResult
    from music_app.services.auth_mail_outbox_postgres import PostgresWelcomeOutboxService
    from music_app.services.auth_welcome_worker import WelcomeMailWorker
    fixture = auth_lock_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        pending = connection.execute("""insert into app.mail_outbox (account_id, message_category, created_at)
            values (%s, 'welcome', %s) returning id""", (fixture.target_id, fixture.now)).fetchone()["id"]
        stale = connection.execute("""insert into app.mail_outbox
            (account_id, message_category, delivery_status, attempt_count, created_at, claimed_at)
            values (%s, 'welcome', 'sending', 1, %s, %s) returning id""",
            (fixture.target_id, fixture.now - timedelta(hours=2), fixture.now - timedelta(hours=2))).fetchone()["id"]
    selected = Barrier(2, timeout=3)
    class Repository(PostgresWelcomeOutboxService):
        def list_due_welcome_ids(self, *, limit):
            rows = super().list_due_welcome_ids(limit=limit)
            assert set(rows) == {pending, stale}
            selected.wait()
            return rows
    calls = []
    async def sender(_message, *, config):
        calls.append(True)
        await asyncio.sleep(0)
        return DeliveryResult(True, "delivered")
    async def scenario():
        workers = [WelcomeMailWorker(repository=Repository(fixture.config,
            connect=isolatedPostgres._connect, now=lambda: fixture.now),
            config={"welcome_enabled": True, "connect_timeout_seconds": 1, "command_timeout_seconds": 1},
            sender=sender, composer=lambda **_kwargs: object()) for _ in range(2)]
        try:
            await asyncio.gather(*(worker.run_once() for worker in workers))
        finally:
            for worker in workers:
                await worker.stop()
    asyncio.run(scenario())
    assert calls == [True]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("select id, delivery_status, attempt_count from app.mail_outbox where id = any(%s) order by id", ([pending, stale],)).fetchall()
    assert rows == [{"id": pending, "delivery_status": "sent", "attempt_count": 1},
                    {"id": stale, "delivery_status": "unknown", "attempt_count": 1}]
