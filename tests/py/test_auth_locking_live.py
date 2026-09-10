"""Real two-connection authentication lock/snapshot regressions."""

from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from time import monotonic
from types import SimpleNamespace

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas
from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_passwords import PasswordCredential
from music_app.services.auth_tokens import issue_opaque_token


@pytest.fixture
def auth_lock_inventory(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    now = datetime.now(timezone.utc)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
        "public_base_url": "https://music.example.test", "invitation_token_seconds": 86400,
        "argon2": {"memory_cost": 65536, "time_cost": 3, "parallelism": 1},
        "argon2_policy_version": 1}
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            owner = connection.execute("""select owner.account_id, library.id as library_id
                from app.bootstrap_owners owner join library.libraries library
                on library.owner_account_id = owner.account_id
                where owner.owner_key = 'local-bootstrap-owner' and library.library_kind = 'local'""").fetchone()
            target = connection.execute("""insert into app.accounts (display_name, account_kind,
                username_display, username_normalized, contact_email, contact_email_normalized)
                values ('Auth race', 'managed_user', 'auth.race', 'auth.race',
                        'auth.race@example.test', 'auth.race@example.test') returning id""").fetchone()["id"]
            connection.execute("""insert into library.library_memberships (library_id, account_id, membership_role)
                values (%s, %s, 'member')""", (owner["library_id"], target))
        yield SimpleNamespace(setup_url=setup_url, runtime_url=runtime_url, config=config,
            now=now, owner_id=owner["account_id"], library_id=owner["library_id"], target_id=target)
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


def _overlap_after_account_lock(fixture, action, mutation, *, locked_account_id=None):
    started = Event()
    backend = []
    results, failures = [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        started.set()
        return connection

    def run():
        try:
            results.append(action(connect))
        except BaseException as exc:
            failures.append(exc)

    worker = None
    mutation_error = None
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            locker.execute("select id from app.accounts where id = %s for update",
                (fixture.target_id if locked_account_id is None else locked_account_id,)).fetchone()
            worker = Thread(target=run)
            worker.start()
            assert started.wait(2), f"worker did not connect: results={results!r}, failures={failures!r}"
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                deadline = monotonic() + 3
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, "worker did not reach the locked account"
            locker.execute("set local lock_timeout = '500ms'")
            try:
                mutation(locker)
            except BaseException as exc:
                mutation_error = exc
                locker.rollback()
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "cannot clean a database while auth worker is active"
    return results, failures, mutation_error


@pytest.mark.parametrize("locked_row", ["account", "invitation"])
@pytest.mark.parametrize("invitation_expires", [False, True])
def test_live_invitation_exchange_uses_time_after_final_lock(
    auth_lock_inventory, locked_row, invitation_expires,
):
    from music_app.services.auth_invitation_lifecycle_postgres import PostgresInvitationLifecycleService
    from music_app.services.auth_invitation_models import INVITATION_TRANSACTION_SECONDS

    fixture = auth_lock_inventory
    clock = [fixture.now]
    token = issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        token_id = connection.execute("""insert into app.account_invitation_tokens
            (account_id, token_hash, created_at, expires_at, request_ref)
            values (%s, %s, %s, %s, 'exchange-clock-fixture') returning id""",
            (fixture.target_id, token.digest, fixture.now,
             fixture.now + timedelta(minutes=10) if invitation_expires
             else fixture.now + timedelta(hours=24))).fetchone()["id"]

    connected = Event()
    backend, results, failures = [], [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        connected.set()
        return connection

    def exchange():
        try:
            results.append(PostgresInvitationLifecycleService(
                fixture.config, connect=connect, clock=lambda: clock[0],
                breached_checker=lambda _password: False,
                audit_repository=PostgresSecurityAuditRepository(),
            ).exchange_invitation_token(token.raw, request_ref="exchange-clock-race"))
        except BaseException as exc:
            failures.append(exc)

    worker = None
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            if locked_row == "account":
                locker.execute("select id from app.accounts where id = %s for update",
                    (fixture.target_id,)).fetchone()
            else:
                locker.execute("select id from app.account_invitation_tokens where id = %s for update",
                    (token_id,)).fetchone()
            worker = Thread(target=exchange)
            worker.start()
            assert connected.wait(2), f"worker did not connect: {failures!r}"
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                blocked = False
                deadline = monotonic() + 3
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, f"exchange did not reach {locked_row} lock: {failures!r}"
            clock[0] = fixture.now + timedelta(minutes=20)
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "cannot clean database while exchange remains active"
    assert failures == []
    assert len(results) == 1
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stored = connection.execute("""select created_at, expires_at
            from app.account_invitation_transactions where invitation_token_id = %s""",
            (token_id,)).fetchall()
    if invitation_expires:
        assert results == [None]
        assert stored == []
    else:
        assert results[0] is not None
        expected_expiry = clock[0] + timedelta(seconds=INVITATION_TRANSACTION_SECONDS)
        assert results[0].expires_at == expected_expiry
        assert stored == [{"created_at": clock[0], "expires_at": expected_expiry}]
        assert PostgresInvitationLifecycleService(
            fixture.config, clock=lambda: clock[0],
            breached_checker=lambda _password: False,
            audit_repository=PostgresSecurityAuditRepository(),
        ).validate_transaction(results[0].raw_token) is True


def test_live_creation_rejects_session_revoked_while_waiting_for_owner_lock(auth_lock_inventory):
    from music_app.services.admin_account_creation import AdminAccountCreationService
    from music_app.services.admin_account_creation_postgres import PostgresAdminAccountRepository
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
    fixture = auth_lock_inventory
    session = PostgresAuthSessionService(fixture.config).issue_session(fixture.owner_id)
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=fixture.owner_id,
        session_id=session.session_id, is_bootstrap_owner=True, current_library_id=fixture.library_id,
        library_relationships=(LibraryRelationship(fixture.library_id, "owner", True),))
    tables = ("app.accounts", "library.library_memberships", "app.capabilities",
        "app.account_invitation_tokens", "app.mail_outbox", "app.security_audit_events")

    def counts():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return {table: connection.execute(f"select count(*) as n from {table}").fetchone()["n"]
                for table in tables}

    before = counts()

    def action(connect):
        return AdminAccountCreationService(repository=PostgresAdminAccountRepository(
            fixture.config, connect=connect), invitation_token_seconds=86400).create_account(
                actor=actor, username="creation.lock.race", contact_email="creation.lock@example.test",
                capability_keys=("library.browse.read",), send_invitation=True, request_ref="create-lock-race")

    results, failures, mutation_error = _overlap_after_account_lock(fixture, action,
        lambda connection: connection.execute("update app.account_sessions set revoked_at = %s where id = %s",
            (fixture.now, session.session_id)), locked_account_id=fixture.owner_id)
    assert mutation_error is None
    assert results == [], f"creation persisted after session revocation: {results!r}"
    assert len(failures) == 1 and isinstance(failures[0], PermissionError), failures
    assert counts() == before


@pytest.mark.parametrize("purpose", ["login", "forgot"])
def test_live_preauth_rejects_expiry_during_token_lock_wait(auth_lock_inventory, purpose):
    from music_app.services.auth_preauth_postgres import PostgresPreAuthCsrfService
    fixture = auth_lock_inventory
    clock = [fixture.now]
    service = PostgresPreAuthCsrfService(fixture.config, clock=lambda: clock[0])
    issued = getattr(service, f"issue_{purpose}_token")()
    connected = Event()
    backend, results, failures = [], [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        connected.set()
        return connection

    def consume():
        try:
            worker_service = PostgresPreAuthCsrfService(fixture.config, connect=connect, clock=lambda: clock[0])
            results.append(getattr(worker_service, f"consume_{purpose}_token")(issued.raw_token))
        except BaseException as exc:
            failures.append(exc)

    worker = None
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            locker.execute("select id from app.auth_preflight_tokens where id = %s for update",
                (issued.token_id,)).fetchone()
            worker = Thread(target=consume)
            worker.start()
            assert connected.wait(2), failures
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                deadline = monotonic() + 3
                blocked = False
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, "consumer did not reach the token row lock"
            clock[0] = issued.expires_at + timedelta(seconds=1)
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "cannot clean database while token consumer is active"
    assert failures == []
    assert results == [False]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select consumed_at from app.auth_preflight_tokens where id = %s",
            (issued.token_id,)).fetchone()["consumed_at"] is None


def test_live_invitation_rotation_rechecks_credentials_after_account_lock(auth_lock_inventory):
    from music_app.services.admin_account_invitations_postgres import PostgresAdminAccountInvitationService
    fixture = auth_lock_inventory
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    actor_session = PostgresAuthSessionService(fixture.config).issue_session(fixture.owner_id)

    def action(connect):
        return PostgresAdminAccountInvitationService(fixture.config, connect=connect,
            audit_repository=PostgresSecurityAuditRepository()).issue_copy(
                actor_account_id=fixture.owner_id, actor_session_id=actor_session.session_id,
                actor_authenticated_at=fixture.now,
                library_id=fixture.library_id, target_account_id=fixture.target_id,
                request_ref="invitation-race")

    def activate(connection):
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$activated', 1, 1)""", (fixture.target_id,))

    results, failures, mutation_error = _overlap_after_account_lock(fixture, action, activate)
    assert mutation_error is None
    assert results == []
    assert len(failures) == 1 and isinstance(failures[0], PermissionError)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select count(*) as n from app.account_invitation_tokens where account_id = %s",
            (fixture.target_id,)).fetchone()["n"] == 0


def test_live_reset_exchange_never_holds_token_while_waiting_for_account(auth_lock_inventory):
    from music_app.services.auth_password_reset_lifecycle_postgres import PostgresPasswordResetLifecycleService
    fixture = auth_lock_inventory
    token = issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$current', 1, 1)""", (fixture.target_id,))
        token_id = connection.execute("""insert into app.password_reset_tokens
            (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
            values (%s, %s, 1, %s, %s, 'reset-lock-fixture') returning id""",
            (fixture.target_id, token.digest, fixture.now, fixture.now + timedelta(minutes=20))).fetchone()["id"]

    def action(connect):
        return PostgresPasswordResetLifecycleService(fixture.config, connect=connect,
            breached_checker=lambda _password: False, audit_repository=PostgresSecurityAuditRepository(),
            password_hasher=lambda *_a, **_kw: PasswordCredential("$argon2id$new", 1),
        ).exchange_reset_token(token.raw, request_ref="reset-lock-order")

    results, failures, mutation_error = _overlap_after_account_lock(fixture, action,
        lambda connection: connection.execute("update app.password_reset_tokens set consumed_at = %s where id = %s",
            (fixture.now, token_id)))
    assert mutation_error is None, "account owner could not finish its token mutation"
    assert failures == []
    assert results == [None]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select count(*) as n from app.password_reset_transactions where reset_token_id = %s",
            (token_id,)).fetchone()["n"] == 0


def test_live_authenticated_attempts_share_login_account_state_and_preserve_newer_generation(auth_lock_inventory):
    from music_app.services.auth_credential_attempts_postgres import PostgresCredentialAttempts
    from music_app.services.auth_login_postgres import PostgresLoginAuthService
    from tests.py.test_auth_login_postgres import _config, DUMMY_HASH, RecordingSessionService

    fixture = auth_lock_inventory
    config = {**_config(), "ALBUM_HAVEN_APP_DATABASE_URL": fixture.runtime_url}
    clock = [fixture.now]
    attempts = PostgresCredentialAttempts(config, connect=isolatedPostgres._connect, clock=lambda: clock[0])
    login = PostgresLoginAuthService(config, connect=isolatedPostgres._connect,
        dummy_encoded_hash=DUMMY_HASH, session_service=RecordingSessionService(),
        audit_repository=PostgresSecurityAuditRepository(), clock=lambda: clock[0])
    reservation = attempts.reserve("Auth.Race")
    buckets = login._buckets("auth.race", "198.51.100.42")
    login_reservation = login._reserve_capacity(buckets, clock[0], request_ref="shared-budget-live", source_class=None)
    assert reservation is not None and login_reservation is not None
    attempts.finalize(reservation, successful=True)

    def state():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return connection.execute("""select bucket_kind, failure_count, blocked_until, window_started_at
                from app.auth_throttles order by bucket_kind""").fetchall()

    assert [(row["bucket_kind"], row["failure_count"]) for row in state()] == [
        ("login_account", 1), ("login_source", 1)]
    old = attempts.reserve("auth.race")
    newer = fixture.now + timedelta(seconds=1)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update app.auth_throttles set window_started_at = %s,
            window_expires_at = %s, failure_count = 4, blocked_until = null
            where bucket_kind = 'login_account'""", (newer, newer + timedelta(seconds=900)))
    attempts.finalize(old, successful=True)
    assert state()[0]["failure_count"] == 4
    assert state()[0]["window_started_at"] == newer
    clock[0] = newer + timedelta(seconds=1)
    final = attempts.reserve("auth.race")
    assert final is not None
    attempts.finalize(final, successful=False)
    assert attempts.reserve("auth.race") is None
    assert login._reserve_capacity(buckets, clock[0], request_ref="shared-budget-throttled", source_class=None) is None
    final_state = state()
    assert final_state[0]["failure_count"] == 5
    assert final_state[0]["blocked_until"] == clock[0] + timedelta(seconds=900)
    assert final_state[1]["failure_count"] == 1  # Authenticated actions never reserve the source bucket.


def test_live_admin_route_rejects_actor_session_revoked_during_authority_lock(auth_lock_inventory):
    from fastapi import FastAPI
    from music_app.routes.admin_asgi import router
    from music_app.services.admin_member_mutation_postgres import PostgresAdminMemberMutationService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
    from tests.py.asgi_testing import run_asgi_request

    fixture = auth_lock_inventory
    session = PostgresAuthSessionService(fixture.config).issue_session(fixture.owner_id)
    actor = CurrentActor(state=ActorState.ACTIVE, account_id=fixture.owner_id, session_id=session.session_id,
        authenticated_at=session.authenticated_at, is_bootstrap_owner=True, current_library_id=fixture.library_id,
        library_relationships=(LibraryRelationship(fixture.library_id, "owner", True),))

    def action(connect):
        app = FastAPI()
        app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
        app.state.auth_policy_config = {"hmac": {"secret": "s" * 48, "key_version": 1}}
        app.state.admin_member_mutation_service = PostgresAdminMemberMutationService(fixture.config, connect=connect)

        @app.middleware("http")
        async def admitted_actor(request, call_next):
            request.state.current_actor = actor
            return await call_next(request)

        app.include_router(router)
        return run_asgi_request(app, "PATCH", f"/admin/accounts/{fixture.target_id}", json_body={
            "is_active": False, "current_library_access": True,
            "capability_keys": ["library.browse.read"],
            "confirm_disable": True, "confirm_remove_access": False,
        })[0]

    results, failures, mutation_error = _overlap_after_account_lock(fixture, action,
        lambda connection: connection.execute("""update app.account_sessions
            set revoked_at = %s, revocation_reason = 'password_reset' where id = %s""",
            (fixture.now, session.session_id)), locked_account_id=fixture.owner_id)
    assert mutation_error is None
    assert failures == []
    assert results == [409]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select is_active from app.accounts where id = %s",
            (fixture.target_id,)).fetchone()["is_active"] is True



def test_live_reset_completion_rolls_back_all_mutations_when_final_audit_fails(auth_lock_inventory):
    from music_app.services.auth_password_reset_lifecycle_postgres import PostgresPasswordResetLifecycleService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    fixture = auth_lock_inventory
    tokens = [issue_opaque_token(), issue_opaque_token()]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version, administrator_set)
            values (%s, '$argon2id$before-reset', 1, 7, true)""", (fixture.target_id,))
    sessions = PostgresAuthSessionService(fixture.config)
    issued_session = sessions.issue_session(fixture.target_id)
    observed = []
    class FailingFinalAudit(PostgresSecurityAuditRepository):
        def append_in_transaction(self, connection, **kwargs):
            observed.append(connection.execute("""select credential_version from app.account_credentials
                where account_id = %s""", (fixture.target_id,)).fetchone()["credential_version"])
            super().append_in_transaction(connection, **kwargs)
            raise RuntimeError("injected final audit failure")
    service = PostgresPasswordResetLifecycleService(fixture.config, breached_checker=lambda _password: False,
        audit_repository=FailingFinalAudit(), password_hasher=lambda *_a, **_kw: PasswordCredential("$argon2id$after-reset", 1))
    transactions = []
    for token in tokens:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            # Issuing a replacement reset link revokes the preceding active
            # token; its transaction remains as history for the rollback check.
            connection.execute("""update app.password_reset_tokens set revoked_at = %s
                where account_id = %s and consumed_at is null and revoked_at is null""",
                (fixture.now, fixture.target_id))
            connection.execute("""insert into app.password_reset_tokens
                (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
                values (%s, %s, 7, %s, %s, 'rollback-fixture')""",
                (fixture.target_id, token.digest, fixture.now, fixture.now + timedelta(minutes=20)))
        transactions.append(service.exchange_reset_token(token.raw, request_ref="rollback-exchange"))
    assert all(transactions)
    def snapshot():
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            return {
                "credential": connection.execute("select * from app.account_credentials where account_id = %s", (fixture.target_id,)).fetchall(),
                "tokens": connection.execute("select * from app.password_reset_tokens where account_id = %s order by id", (fixture.target_id,)).fetchall(),
                "transactions": connection.execute("""select transaction.* from app.password_reset_transactions transaction
                    join app.password_reset_tokens token on token.id = transaction.reset_token_id
                    where token.account_id = %s order by transaction.id""", (fixture.target_id,)).fetchall(),
                "sessions": connection.execute("select * from app.account_sessions where account_id = %s order by id", (fixture.target_id,)).fetchall(),
                "audit": connection.execute("select count(*) as n from app.security_audit_events").fetchone()["n"],
            }
    before = snapshot()
    with pytest.raises(RuntimeError, match="Password reset completion failed"):
        service.complete_reset(transactions[-1].raw_token, new_password="new sufficiently private password", request_ref="rollback-complete")
    assert observed == [8], "The injected failure must occur after the credential mutation"
    assert snapshot() == before
    assert sessions.resolve_session(issued_session.raw_token) is not None
    assert service.validate_transaction(transactions[-1].raw_token)


@pytest.mark.parametrize("route", ["login", "profile"])
@pytest.mark.parametrize("successful", [True, False], ids=["valid-password", "invalid-password"])
def test_live_expired_throttle_cleanup_during_verification_preserves_auth_result(auth_lock_inventory, route, successful):
    from music_app.services.auth_login_postgres import PostgresLoginAuthService
    from music_app.services.auth_profile_password_postgres import PostgresProfilePasswordService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from music_app.services.auth_throttle_cleanup_postgres import PostgresAuthThrottleCleanupService
    from music_app.services.auth_passwords import PasswordVerification
    from tests.py.test_auth_login_postgres import _config, DUMMY_HASH
    fixture = auth_lock_inventory
    config = {**_config(), "ALBUM_HAVEN_APP_DATABASE_URL": fixture.runtime_url}
    clock = [fixture.now]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$current', 1, 1)""", (fixture.target_id,))
    sessions = PostgresAuthSessionService(config, clock=lambda: clock[0])
    session = sessions.issue_session(fixture.target_id)
    cleanup = PostgresAuthThrottleCleanupService(config, clock=lambda: clock[0])
    cleaned = []
    def verify(*_a, **_kw):
        clock[0] += timedelta(seconds=901)
        cleaned.append(cleanup.cleanup(batch_size=20))
        return PasswordVerification(successful, False)
    common = dict(clock=lambda: clock[0], verifier=verify, audit_repository=PostgresSecurityAuditRepository())
    if route == "login":
        service = PostgresLoginAuthService(config, dummy_encoded_hash=DUMMY_HASH, session_service=sessions, **common)
        result = service.authenticate(entered_username="auth.race", password="known sufficiently private password", source_key="198.51.100.22")
        outcome = result.outcome.value
        assert outcome == ("success" if successful else "invalid")
        assert cleaned == [2]
    else:
        service = PostgresProfilePasswordService(config, password_hasher=lambda *_a, **_kw: PasswordCredential("$argon2id$new", 1),
            breached_checker=lambda _password: False, **common)
        result = service.change_password(account_id=fixture.target_id, current_session_id=session.session_id,
            current_password="known sufficiently private password", new_password="new sufficiently private password", request_ref="cleanup-overlap")
        assert result.value == ("success" if successful else "current_password_invalid")
        assert cleaned == [1]
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select count(*) as n from app.auth_throttles").fetchone()["n"] == 0
        version = connection.execute("select credential_version from app.account_credentials where account_id = %s", (fixture.target_id,)).fetchone()["credential_version"]
        assert version == (2 if route == "profile" and successful else 1)


class _ObservedAuthConnection:
    def __init__(self, connection, after_execute=lambda _sql: None, *, close=True, errors=None):
        self.connection, self.after_execute, self.close = connection, after_execute, close
        self.errors = errors

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self.close:
            return self.connection.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def execute(self, sql, params=()):
        try:
            result = self.connection.execute(sql, params)
        except Exception as exc:
            if self.errors is not None:
                self.errors.append((" ".join(sql.split()), getattr(exc, "sqlstate", None)))
            raise
        self.after_execute(" ".join(sql.casefold().split()))
        return result


def _live_login_service(fixture, *, connect=isolatedPostgres._connect):
    from music_app.services.auth_login_postgres import PostgresLoginAuthService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from tests.py.test_auth_login_postgres import _config, DUMMY_HASH
    config = {**_config(), "ALBUM_HAVEN_APP_DATABASE_URL": fixture.runtime_url}
    sessions = PostgresAuthSessionService(config, clock=lambda: fixture.now)
    return PostgresLoginAuthService(config, connect=connect, dummy_encoded_hash=DUMMY_HASH,
        session_service=sessions, audit_repository=PostgresSecurityAuditRepository(),
        clock=lambda: fixture.now), sessions, config


def test_live_login_failure_audit_does_not_invert_success_account_throttle_locks(auth_lock_inventory):
    from music_app.services.auth_audit_postgres import LoginAuditReason
    from tests.py.test_auth_login_postgres import ENCODED_HASH
    fixture = auth_lock_inventory
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, %s, 3, 1)""", (fixture.target_id, ENCODED_HASH))
    service, sessions, _ = _live_login_service(fixture)
    buckets = service._buckets("auth.race", "198.51.100.45")
    reservations = [service._reserve_capacity(buckets, fixture.now,
        request_ref="lock-reservation", source_class=None) for _ in range(2)]
    account, credential = service._load_identity("auth.race")
    prepared = sessions.prepare_session(fixture.target_id)
    connected, backend, failures = Event(), [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        connected.set()
        return connection

    def fail_login():
        try:
            failing, _, _ = _live_login_service(fixture, connect=connect)
            failing._finalize_failure(reservations[0], fixture.now,
                reason=LoginAuditReason.CREDENTIAL_MISMATCH, request_ref="failure-lock-order",
                source_class=None, target_account_id=fixture.target_id)
        except BaseException as exc:
            failures.append(exc)

    worker, success, success_error, sql_errors = None, None, None, []
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            locker.execute("select id from app.accounts where id = %s for update", (fixture.target_id,))
            worker = Thread(target=fail_login)
            worker.start()
            assert connected.wait(2), f"failure finalizer did not connect: {failures!r}"
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                blocked, deadline = False, monotonic() + 3
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, f"failure finalizer did not wait on account: {failures!r}"
            locker.execute("set local lock_timeout = '500ms'")
            successful, _, _ = _live_login_service(fixture,
                connect=lambda _url: _ObservedAuthConnection(locker, close=False, errors=sql_errors))
            try:
                success = successful._finalize_success(account, credential, reservations[1], fixture.now,
                    replacement=None, prepared=prepared, request_ref="success-lock-order", source_class=None)
            except Exception as exc:
                success_error = exc
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "login worker must exit before database cleanup"
    assert failures == []
    assert success_error is None, f"successful login failed: {success_error!r}; SQL failures: {sql_errors!r}"
    assert success[1] is True
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        audits = connection.execute("""select outcome from app.security_audit_events
            where request_ref in ('failure-lock-order', 'success-lock-order') order by outcome""").fetchall()
        assert [row["outcome"] for row in audits] == ["invalid", "success"]
        assert connection.execute("select count(*) as n from app.account_sessions where account_id = %s",
            (fixture.target_id,)).fetchone()["n"] == 1


@pytest.mark.parametrize("route", ["login", "shared"])
def test_live_reservation_survives_cleanup_between_insert_and_row_lock(auth_lock_inventory, route):
    from music_app.services.auth_credential_attempts_postgres import PostgresCredentialAttempts
    from music_app.services.auth_throttle_cleanup_postgres import PostgresAuthThrottleCleanupService
    fixture = auth_lock_inventory
    login, _, config = _live_login_service(fixture)
    buckets = login._buckets("auth.race", "198.51.100.46")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        for kind, digest in buckets[:2 if route == "login" else 1]:
            connection.execute("""insert into app.auth_throttles
                (bucket_kind, bucket_hash, key_version, window_started_at, window_expires_at, failure_count)
                values (%s, %s, 3, %s, %s, %s)""", (kind, digest,
                fixture.now - timedelta(seconds=1800) if kind == "login_account" else fixture.now,
                fixture.now - timedelta(seconds=1) if kind == "login_account" else fixture.now + timedelta(seconds=900),
                4 if kind == "login_account" else 2))
    cleaned = []
    cleanup = PostgresAuthThrottleCleanupService(config, clock=lambda: fixture.now)

    def after_execute(sql):
        if "insert into app.auth_throttles" in sql and not cleaned:
            cleaned.append(cleanup.cleanup(batch_size=100))

    def connect(_url):
        return _ObservedAuthConnection(isolatedPostgres._connect(fixture.runtime_url), after_execute)

    if route == "login":
        service, _, _ = _live_login_service(fixture, connect=connect)
        reservation = service._reserve_capacity(buckets, fixture.now, request_ref="cleanup-reserve", source_class=None)
    else:
        reservation = PostgresCredentialAttempts(config, connect=connect,
            clock=lambda: fixture.now).reserve("auth.race")
    assert reservation is not None and len(cleaned) == 1
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        rows = connection.execute("""select bucket_kind, failure_count, window_started_at
            from app.auth_throttles order by bucket_kind""").fetchall()
    assert rows[0] == {"bucket_kind": "login_account", "failure_count": 1, "window_started_at": fixture.now}
    if route == "login":
        assert rows[1] == {"bucket_kind": "login_source", "failure_count": 3, "window_started_at": fixture.now}


@pytest.mark.parametrize("locked_row", ["account", "invitation", "outbox"])
@pytest.mark.parametrize("expires", [True, False])
def test_live_invitation_mail_rechecks_expiry_after_final_claim_lock(auth_lock_inventory, locked_row, expires):
    from music_app.services.auth_mail_outbox_postgres import PostgresInvitationOutboxService
    from music_app.services.auth_invitation_models import InvitationDelivery
    fixture = auth_lock_inventory
    clock, token = [fixture.now], issue_opaque_token()
    expiry = fixture.now + timedelta(seconds=10 if expires else 600)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        token_id = connection.execute("""insert into app.account_invitation_tokens
            (account_id, token_hash, created_at, expires_at, request_ref)
            values (%s, %s, %s, %s, 'mail-clock') returning id""",
            (fixture.target_id, token.digest, fixture.now, expiry)).fetchone()["id"]
        outbox_id = connection.execute("""insert into app.mail_outbox
            (account_id, invitation_token_id, message_category) values (%s, %s, 'account_invitation') returning id""",
            (fixture.target_id, token_id)).fetchone()["id"]
    delivery = InvitationDelivery(outbox_id, token_id, fixture.target_id,
        "auth.race@example.test", "auth.race", token.raw, expiry)
    connected, backend, results, failures = Event(), [], [], []

    def connect(_url):
        connection = isolatedPostgres._connect(fixture.runtime_url)
        connection.execute("set statement_timeout = '5s'")
        connection.commit()
        backend.append(connection.info.backend_pid)
        connected.set()
        return connection

    def claim():
        try:
            results.append(PostgresInvitationOutboxService(fixture.config, connect=connect,
                now=lambda: clock[0]).claim_invitation(delivery))
        except BaseException as exc:
            failures.append(exc)

    worker = None
    try:
        with isolatedPostgres._connect(fixture.setup_url) as locker:
            table, row_id = {"account": ("app.accounts", fixture.target_id),
                "invitation": ("app.account_invitation_tokens", token_id),
                "outbox": ("app.mail_outbox", outbox_id)}[locked_row]
            locker.execute(f"select id from {table} where id = %s for update", (row_id,))
            worker = Thread(target=claim)
            worker.start()
            assert connected.wait(2), f"mail claim did not connect: {failures!r}"
            with isolatedPostgres._connect(fixture.setup_url) as inspect:
                blocked, deadline = False, monotonic() + 3
                while monotonic() < deadline:
                    blocked = inspect.execute("select %s = any(pg_blocking_pids(%s)) as blocked",
                        (locker.info.backend_pid, backend[0])).fetchone()["blocked"]
                    if blocked:
                        break
                    Event().wait(0.01)
                assert blocked, f"mail claim did not reach {locked_row}: {failures!r}"
            clock[0] += timedelta(seconds=20)
    finally:
        if worker is not None:
            worker.join(7)
            assert not worker.is_alive(), "mail worker must exit before database cleanup"
    assert failures == [] and len(results) == 1
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stored = connection.execute("select delivery_status, attempt_count, claimed_at from app.mail_outbox where id = %s",
            (outbox_id,)).fetchone()
    if expires:
        assert results == [None]
        assert stored == {"delivery_status": "pending", "attempt_count": 0, "claimed_at": None}
    else:
        assert results[0] is not None and results[0].claimed_at == clock[0]
        assert stored == {"delivery_status": "sending", "attempt_count": 1, "claimed_at": clock[0]}


@pytest.mark.parametrize("mutation", ["disable", "revoke", "eligible"])
def test_live_reset_mail_rechecks_eligibility_after_account_lock(auth_lock_inventory, mutation):
    from music_app.services.auth_mail_outbox_postgres import PostgresPasswordResetOutboxService
    from music_app.services.auth_password_reset_request_postgres import PasswordResetDelivery
    fixture = auth_lock_inventory
    token = issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$fixture', 1, 1)""", (fixture.target_id,))
        token_id = connection.execute("""insert into app.password_reset_tokens
            (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
            values (%s, %s, 1, %s, %s, 'reset-mail-race') returning id""",
            (fixture.target_id, token.digest, fixture.now, fixture.now + timedelta(minutes=10))).fetchone()["id"]
        outbox_id = connection.execute("""insert into app.mail_outbox
            (account_id, reset_token_id, message_category) values (%s, %s, 'password_reset') returning id""",
            (fixture.target_id, token_id)).fetchone()["id"]
    delivery = PasswordResetDelivery(outbox_id, fixture.target_id, "auth.race@example.test", token.raw)

    def change(connection):
        if mutation == "disable":
            connection.execute("update app.accounts set is_active = false, disabled_at = %s where id = %s",
                (fixture.now, fixture.target_id))
        elif mutation == "revoke":
            connection.execute("update app.account_credentials set credential_version = 2 where account_id = %s",
                (fixture.target_id,))
            connection.execute("update app.password_reset_tokens set revoked_at = %s where id = %s",
                (fixture.now, token_id))

    results, failures, mutation_error = _overlap_after_account_lock(fixture,
        lambda connect: PostgresPasswordResetOutboxService(fixture.config, connect=connect,
            now=lambda: fixture.now).claim_password_reset(delivery), change)
    assert failures == [] and mutation_error is None and len(results) == 1
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        stored = connection.execute("select delivery_status, attempt_count, claimed_at from app.mail_outbox where id = %s",
            (outbox_id,)).fetchone()
    if mutation == "eligible":
        assert results[0] is not None
        assert stored == {"delivery_status": "sending", "attempt_count": 1, "claimed_at": fixture.now}
    else:
        assert results == [None]
        assert stored == {"delivery_status": "pending", "attempt_count": 0, "claimed_at": None}


def test_live_reset_mail_rechecks_expiry_after_delayed_claim_query(auth_lock_inventory):
    from music_app.services.auth_mail_outbox_postgres import PostgresPasswordResetOutboxService
    from music_app.services.auth_password_reset_request_postgres import PasswordResetDelivery
    fixture = auth_lock_inventory
    clock, token = [fixture.now], issue_opaque_token()
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""insert into app.account_credentials
            (account_id, encoded_hash, hash_policy_version, credential_version)
            values (%s, '$argon2id$fixture', 1, 1)""", (fixture.target_id,))
        token_id = connection.execute("""insert into app.password_reset_tokens
            (account_id, token_hash, credential_version, created_at, expires_at, request_ref)
            values (%s, %s, 1, %s, %s, 'reset-mail-clock') returning id""",
            (fixture.target_id, token.digest, fixture.now, fixture.now + timedelta(seconds=10))).fetchone()["id"]
        outbox_id = connection.execute("""insert into app.mail_outbox
            (account_id, reset_token_id, message_category) values (%s, %s, 'password_reset') returning id""",
            (fixture.target_id, token_id)).fetchone()["id"]

    def after_execute(sql):
        if "for update of outbox skip locked" in sql:
            clock[0] += timedelta(seconds=20)

    service = PostgresPasswordResetOutboxService(fixture.config, now=lambda: clock[0],
        connect=lambda _url: _ObservedAuthConnection(isolatedPostgres._connect(fixture.runtime_url), after_execute))
    delivery = PasswordResetDelivery(outbox_id, fixture.target_id, "auth.race@example.test", token.raw)
    assert service.claim_password_reset(delivery) is None
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        assert connection.execute("select delivery_status, attempt_count from app.mail_outbox where id = %s",
            (outbox_id,)).fetchone() == {"delivery_status": "pending", "attempt_count": 0}
