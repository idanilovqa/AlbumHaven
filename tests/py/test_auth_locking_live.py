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
