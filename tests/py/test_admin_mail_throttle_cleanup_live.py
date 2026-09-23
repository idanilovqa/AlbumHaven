"""Real admin-mail throttle reservations against concurrent expired-row cleanup."""

from datetime import timedelta

import pytest

from music_app.services.admin_mail_actions_postgres import PostgresAdminMailActionService
from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
from music_app.services.auth_throttle_cleanup_postgres import PostgresAuthThrottleCleanupService
from tests.e2e.support import isolatedPostgres
from tests.py.test_auth_locking_live import auth_lock_inventory, _ObservedAuthConnection


@pytest.mark.parametrize("kind", ["welcome_account", "reset_account"])
def test_admin_mail_reserves_expired_throttle_before_cleanup(auth_lock_inventory, kind):
    fixture = auth_lock_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into library.library_memberships
            (library_id, account_id, membership_role) values (%s, %s, 'owner')
            on conflict (library_id, account_id) do nothing""", (fixture.library_id, fixture.owner_id))
        connection.execute("""update app.accounts
            set contact_email='throttle.owner@example.test',
                contact_email_normalized='throttle.owner@example.test'
            where id=%s""", (fixture.owner_id,))
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$owned-mail-fixture', 1, 1)
            on conflict (account_id) do nothing""", (fixture.owner_id,))
    session = PostgresAuthSessionService(fixture.config, clock=lambda: fixture.now).issue_session(fixture.owner_id)
    config = {
        **fixture.config,
        "hmac": {"secret": "s" * 48, "key_version": 2},
        "throttles": {
            "welcome_account": {"limit": 5, "window_seconds": 86400},
            "reset_account": {"limit": 4, "window_seconds": 3600},
        },
        "reset_token_seconds": 900,
    }

    def queue(connect=isolatedPostgres._connect):
        service = PostgresAdminMailActionService(config, connect=connect, clock=lambda: fixture.now)
        action = service.queue_welcome if kind == "welcome_account" else service.queue_password_reset
        return action(actor_account_id=fixture.owner_id, actor_session_id=session.session_id,
            actor_authenticated_at=fixture.now, library_id=fixture.library_id,
            target_account_id=fixture.owner_id, request_ref="owned-admin-throttle-cleanup")

    first = queue()
    assert not first.throttled
    assert first.welcome_outbox_id is not None if kind == "welcome_account" else first.password_reset_delivery is not None
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update app.auth_throttles
            set window_started_at=%s, window_expires_at=%s, failure_count=4
            where bucket_kind=%s""",
            (fixture.now - timedelta(days=2), fixture.now - timedelta(seconds=1), kind))
    cleaned = []
    cleanup = PostgresAuthThrottleCleanupService(fixture.config, clock=lambda: fixture.now)

    class CleanupAfterInsert(_ObservedAuthConnection):
        def execute(self, sql, params=()):
            result = self.connection.execute(sql, params)
            if "insert into app.auth_throttles" in " ".join(sql.casefold().split()):
                # A real second connection runs SKIP LOCKED cleanup precisely
                # after the conflict statement, before the service's row lock.
                cleaned.append(cleanup.cleanup(batch_size=20))
            return result

    result = queue(lambda url: CleanupAfterInsert(isolatedPostgres._connect(url)))
    assert result.accepted and not result.throttled
    assert cleaned == [0], "Cleanup must skip the conflicting row reserved by this mail action"
    if kind == "welcome_account":
        assert result.welcome_outbox_id is not None
    else:
        assert result.password_reset_delivery is not None
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("""select window_started_at, failure_count
            from app.auth_throttles where bucket_kind=%s""", (kind,)).fetchall()
    assert rows == [{"window_started_at": fixture.now, "failure_count": 1}]
    assert not queue().throttled
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("""select window_started_at, failure_count
            from app.auth_throttles where bucket_kind=%s""", (kind,)).fetchall()
    assert rows == [{"window_started_at": fixture.now, "failure_count": 2}]
