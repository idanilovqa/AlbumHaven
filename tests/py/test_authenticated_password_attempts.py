"""The same password has one account guess budget across authenticated routes."""

from datetime import timedelta
from threading import BoundedSemaphore, Event, Thread

import pytest

from music_app.services.admin_reauthentication_postgres import PostgresAdminReauthenticationService
from music_app.services.auth_profile_password_postgres import PostgresProfilePasswordService
from music_app.services.auth_passwords import PasswordCredential, PasswordVerification
from tests.py.test_auth_profile_password_postgres import Connection, Cursor, Audit, NOW
from tests.py.test_auth_login_postgres import _config as login_config


class BudgetConnection(Connection):
    def __init__(self, budget, *, admin=False):
        super().__init__()
        self.budget = budget
        self.admin = admin

    def execute(self, sql, params=()):
        statement = " ".join(sql.casefold().split())
        if "app.auth_throttles" in statement:
            self.operations.append((statement, params))
            if statement.startswith("insert ") and not self.budget:
                self.budget.update(bucket_kind="login_account", failure_count=0,
                    window_started_at=NOW, window_expires_at=NOW + timedelta(seconds=900),
                    blocked_until=None)
            if statement.startswith("select "):
                return Cursor((dict(self.budget),))
            if "failure_count = failure_count + 1" in statement:
                self.budget["failure_count"] += 1
            elif "greatest(failure_count - 1, 0)" in statement:
                self.budget["failure_count"] = max(self.budget["failure_count"] - 1, 0)
            if "set blocked_until =" in statement:
                self.budget["blocked_until"] = params[0]
            return Cursor()
        if self.admin and "join app.account_credentials" in statement:
            self.operations.append((statement, params))
            return Cursor((dict(account_id=41, username_display="member.one", username_normalized="member.one",
                is_active=True, disabled_at=None, encoded_hash="$argon2id$current", hash_policy_version=3,
                credential_version=7, session_id=11, idle_expires_at=NOW + timedelta(hours=1),
                absolute_expires_at=NOW + timedelta(days=1)),))
        return super().execute(sql, params)


def _services(verifier, *, password_hasher=None):
    config = login_config()
    config["password"] = {"min_codepoints": 13, "max_codepoints": 256, "max_utf8_bytes": 1024}
    budget = {}
    profile_connection = BudgetConnection(budget)
    admin_connection = BudgetConnection(budget, admin=True)
    common = dict(clock=lambda: NOW, verifier=verifier, audit_repository=Audit())
    profile = PostgresProfilePasswordService(config, connect=lambda _url: profile_connection,
        password_hasher=password_hasher or (lambda *_a, **_kw: PasswordCredential("$argon2id$new", 3)),
        breached_checker=lambda _password: False, **common)
    admin = PostgresAdminReauthenticationService(config, connect=lambda _url: admin_connection, **common)
    return profile, admin, budget


def _attempt(service, *, password="wrong private password"):
    if isinstance(service, PostgresProfilePasswordService):
        return service.change_password(account_id=41, current_session_id=11, current_password=password,
            new_password="new sufficiently private password", request_ref="shared-attempt")
    return service.reauthenticate(account_id=41, session_id=11, password=password, request_ref="shared-attempt")


def test_authenticated_password_routes_share_existing_five_attempt_account_budget():
    calls = []
    profile, admin, budget = _services(lambda *_a, **_kw:
        calls.append(True) or PasswordVerification(False, False))
    for service in (admin, profile, admin, profile, admin, profile, admin):
        assert _attempt(service).value != "success"
    assert len(calls) == 5
    assert budget["failure_count"] == 5
    assert budget["blocked_until"] == NOW + timedelta(seconds=900)


def test_successful_cross_route_verification_releases_only_its_own_reserved_attempt():
    profile, admin, budget = _services(lambda password, *_a, **_kw:
        PasswordVerification(password == "known password", False))
    for _ in range(3):
        assert _attempt(profile).value == "current_password_invalid"
    assert budget["failure_count"] == 3
    assert _attempt(admin, password="known password").value == "success"
    assert budget["failure_count"] == 3
    assert _attempt(profile, password="known password").value == "success"
    assert budget["failure_count"] == 3


def test_live_route_service_factories_share_one_process_password_capacity(monkeypatch):
    from fastapi import FastAPI
    from starlette.requests import Request
    from music_app.routes import auth_asgi, account_asgi, admin_asgi
    from tests.py.test_auth_login_postgres import DUMMY_HASH

    app = FastAPI()
    app.state.auth_policy_config = login_config()
    app.state.auth_preauth_service = object()
    app.state.breached_password_checker = lambda _password: False
    original = auth_asgi.PostgresLoginAuthService
    monkeypatch.setattr(auth_asgi, "PostgresLoginAuthService",
        lambda config, **kwargs: original(config, dummy_encoded_hash=DUMMY_HASH, **kwargs))
    request = Request({"type": "http", "app": app, "headers": []})
    _preauth, login = auth_asgi._services(request)
    profile = account_asgi._service(request)
    admin = admin_asgi._reauthentication_service(request)
    reset = auth_asgi._reset_lifecycle_service(request)
    invitation = auth_asgi._invitation_lifecycle(request)
    assert all(service._semaphore is login._semaphore for service in (profile, admin, reset, invitation))


@pytest.mark.parametrize("first", ["admin", "profile"])
def test_authenticated_password_routes_share_cpu_capacity_and_release_after_exception(first):
    entered, release = Event(), Event()
    calls, errors = [], []

    def verifier(*_args, **_kwargs):
        calls.append(True)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError("verification failed")
        return PasswordVerification(False, False)

    profile, admin, _budget = _services(verifier)
    semaphore = BoundedSemaphore(1)
    profile._semaphore = admin._semaphore = semaphore
    primary, secondary = (admin, profile) if first == "admin" else (profile, admin)

    def run():
        try:
            _attempt(primary)
        except RuntimeError as exc:
            errors.append(exc)

    worker = Thread(target=run)
    worker.start()
    try:
        assert entered.wait(2)
        assert _attempt(secondary).value != "success"
        assert len(calls) == 1
    finally:
        release.set()
        worker.join(4)
        assert not worker.is_alive()
    assert semaphore.acquire(blocking=False)
    semaphore.release()
    assert _attempt(secondary).value != "success"
    assert len(calls) == 2


@pytest.mark.parametrize("first", ["reset", "invitation"])
def test_token_password_hashes_share_cpu_capacity_without_new_attempt_budget(first):
    from tests.py import test_auth_password_reset_lifecycle_postgres as reset_cases
    from tests.py import test_auth_invitation_lifecycle_postgres as invitation_cases

    entered, release = Event(), Event()
    calls, failures = [], []

    def hasher(*_args, **_kwargs):
        calls.append(True)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError("hash unavailable")
        return PasswordCredential("$argon2id$new", 4)

    reset_connection, invitation_connection = reset_cases.Connection(), invitation_cases.Connection()
    reset = reset_cases._service(reset_connection, reset_cases.Audit(), password_hasher=hasher)
    invitation = invitation_cases._service(invitation_connection, password_hasher=hasher)
    reset._semaphore = invitation._semaphore = BoundedSemaphore(1)
    operations = {
        "reset": lambda: reset.complete_reset(reset_cases.LIFECYCLE_RAW,
            new_password="new sufficiently private password", request_ref="capacity-reset"),
        "invitation": lambda: invitation.complete_invitation(invitation_cases.TRANSACTION_RAW,
            new_password=invitation_cases.PASSWORD, request_ref="capacity-invitation"),
    }
    other = "invitation" if first == "reset" else "reset"

    def run():
        try:
            operations[first]()
        except RuntimeError as exc:
            failures.append(exc)

    worker = Thread(target=run)
    worker.start()
    try:
        assert entered.wait(2)
        with pytest.raises(RuntimeError):
            operations[other]()
        assert len(calls) == 1
    finally:
        release.set()
        worker.join(4)
        assert not worker.is_alive()
    assert len(failures) == 1
    assert operations[other]().value == "success"
    assert len(calls) == 2
    assert not any("app.auth_throttles" in sql for connection in (reset_connection, invitation_connection)
                   for sql, _ in connection.operations)
