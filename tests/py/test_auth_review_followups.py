"""Focused regressions from the complete second hosted auth review inventory."""

from dataclasses import replace
from datetime import timedelta

import pytest

from music_app.services import auth_sessions_postgres, auth_login_postgres
from music_app.services.auth_credential_attempts_postgres import PostgresCredentialAttempts
from music_app.services.auth_passwords import PasswordVerification
from tests.py import test_admin_asgi as admin_cases
from tests.py import test_admin_members_asgi as member_cases
from tests.py import test_auth_asgi as route_cases
from tests.py import test_auth_sessions_postgres as session_cases
from tests.py import test_auth_login_postgres as login_cases
from tests.py.test_authenticated_password_attempts import BudgetConnection


@pytest.mark.parametrize("path,method", [("/admin/accounts", "POST"), ("/admin/accounts/41", "PATCH")])
@pytest.mark.parametrize("value", [b"[" * 2000 + b"0" + b"]" * 2000, b"9" * 5000], ids=["deep-object", "large-integer"])
def test_admin_json_decoder_failures_return_400_before_mutation(path, method, value):
    app, service, deliveries = admin_cases._app()
    body = b'{"value":' + value + b'}'
    status, _headers, _body = route_cases._request(app, method, path=path,
        headers={"content-type": "application/json", "content-length": str(len(body))}, body_chunks=[body])
    assert status == 400
    assert service.calls == [] and deliveries == []


@pytest.mark.parametrize("membership", [None, "member"])
def test_pending_invitation_controls_follow_current_membership(membership):
    app, _service = member_cases._app(member_library_role=membership)
    status, _headers, body = member_cases._get(app, "/admin/members")
    assert status == 200 and 'test.user+1' in body
    for action in ("copy", "send"):
        assert (f'data-{action}-invitation="41"' in body) is bool(membership)
    assert '/admin/accounts/41' in body, "Detached account management must remain available"


@pytest.mark.parametrize("membership", [None, "member"])
def test_reset_control_follows_current_membership_for_retained_account(membership):
    app, service = member_cases._app(member_library_role=membership)
    original = service.load_roster
    def credentialed(**kwargs):
        roster = original(**kwargs)
        return replace(roster, members=tuple(replace(member, has_credential=True, account_status="Enabled")
            if member.account_id == 41 else member for member in roster.members))
    service.load_roster = credentialed
    status, _headers, body = member_cases._get(app, "/admin/accounts/41")
    assert status == 200 and 'test.user+1' in body
    assert ('data-admin-action="reset"' in body) is bool(membership)
    assert 'name="current_library_access"' in body, "The owner must retain access restoration controls"


@pytest.mark.parametrize("expiry", ["idle_expires_at", "absolute_expires_at"])
def test_session_expiry_uses_clock_after_account_and_session_locks(monkeypatch, expiry):
    clock = [session_cases.NOW]
    payload = session_cases._resolved_row(**{expiry: clock[0] + timedelta(seconds=1)})
    connection = session_cases.RecordingConnection(session_rows=[payload])
    service = auth_sessions_postgres.PostgresAuthSessionService(session_cases._config(),
        connect=lambda _url: connection, clock=lambda: clock[0])
    original = auth_sessions_postgres._discover_and_lock_session
    def delayed_lock(*args):
        result = original(*args)
        clock[0] += timedelta(seconds=2)
        return result
    monkeypatch.setattr(auth_sessions_postgres, "_discover_and_lock_session", delayed_lock)
    assert service.resolve_session(session_cases.RAW_TOKEN) is None
    assert not any(sql.startswith("update app.account_sessions") for sql, _ in connection.operations)


@pytest.mark.parametrize("later_deadline", [False, True])
def test_login_failure_cooldown_uses_locked_time_and_never_shortens_deadline(later_deadline):
    clock = [login_cases.NOW]
    finished = clock[0] + timedelta(seconds=30)
    existing = finished + timedelta(seconds=1200) if later_deadline else None
    class OutOfOrderConnection(login_cases.RecordingConnection):
        def __init__(self):
            super().__init__()
            self.reads = 0
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.auth_throttles" in statement:
                self.reads += 1
                if self.reads > 1:
                    clock[0] = finished
                    self.throttle_rows = [dict(row, failure_count=20, blocked_until=existing)
                        for row in self.throttle_rows]
            cursor = super().execute(sql, params)
            if statement.startswith("update app.auth_throttles") and "set blocked_until =" in statement:
                return login_cases.Cursor(rowcount=1)
            return cursor
    connection = OutOfOrderConnection()
    service, _ = login_cases._service(auth_login_postgres, connection,
        verifier=lambda *_a, **_kw: PasswordVerification(False, False))
    service._clock = lambda: clock[0]
    assert login_cases._authenticate(service).outcome is auth_login_postgres.LoginOutcome.INVALID
    updates = [params for sql, params in connection.operations if "set blocked_until =" in sql]
    assert len(updates) == 2
    assert all(params[0] == (existing or finished + timedelta(seconds=900)) for params in updates)


@pytest.mark.parametrize("later_deadline", [False, True])
def test_authenticated_failure_cooldown_uses_locked_time_and_never_shortens_deadline(later_deadline):
    now = login_cases.NOW
    clock = [now]
    budget = dict(window_started_at=now, window_expires_at=now + timedelta(seconds=900),
        failure_count=0, blocked_until=None)
    connection = BudgetConnection(budget)
    service = PostgresCredentialAttempts(login_cases._config(), connect=lambda _url: connection, clock=lambda: clock[0])
    reservation = service.reserve("rendref")
    finished = now + timedelta(seconds=30)
    existing = finished + timedelta(seconds=1200) if later_deadline else None
    budget.update(failure_count=5, blocked_until=existing)
    original = connection.execute
    def delayed_lock(sql, params=()):
        if "for update" in sql.casefold(): clock[0] = finished
        return original(sql, params)
    connection.execute = delayed_lock
    service.finalize(reservation, successful=False)
    assert budget["blocked_until"] == (existing or finished + timedelta(seconds=900))



@pytest.mark.parametrize("successful", [True, False])
def test_missing_unexpired_login_reservation_remains_fail_closed(successful):
    connection = login_cases.RecordingConnection()
    service, _ = login_cases._service(auth_login_postgres, connection)
    reservation = service._reserve_capacity(service._buckets("rendref", "198.51.100.7"), login_cases.NOW,
        request_ref="missing-unexpired", source_class=None)
    assert reservation is not None
    connection.throttle_rows = []
    connection.operations.clear()
    finalize = service._finalize_success_throttles if successful else service._finalize_failure_in_transaction
    with pytest.raises(RuntimeError, match="Login throttle state is unavailable"):
        finalize(connection, reservation, login_cases.NOW)
    assert not any(sql.startswith("update app.auth_throttles") for sql, _ in connection.operations)


@pytest.mark.parametrize("successful", [True, False])
def test_missing_unexpired_authenticated_reservation_remains_fail_closed(successful):
    now = login_cases.NOW
    budget = dict(window_started_at=now, window_expires_at=now + timedelta(seconds=900), failure_count=0, blocked_until=None)
    connection = BudgetConnection(budget)
    service = PostgresCredentialAttempts(login_cases._config(), connect=lambda _url: connection, clock=lambda: now)
    reservation = service.reserve("rendref")
    original = connection.execute
    def missing(sql, params=()):
        if "for update" in sql.casefold(): return login_cases.Cursor()
        return original(sql, params)
    connection.execute = missing
    connection.operations.clear()
    with pytest.raises(RuntimeError, match="Credential attempt state is unavailable"):
        service.finalize(reservation, successful=successful)
    assert not any(sql.startswith("update app.auth_throttles") for sql, _ in connection.operations)


@pytest.mark.parametrize("missing_kind", ["login_account", "login_source"])
def test_expired_missing_login_bucket_does_not_drop_the_surviving_reservation(missing_kind):
    connection = login_cases.RecordingConnection()
    service, _ = login_cases._service(auth_login_postgres, connection)
    reservation = service._reserve_capacity(service._buckets("rendref", "198.51.100.7"), login_cases.NOW,
        request_ref="partly-retired", source_class=None)
    assert reservation is not None
    connection.throttle_rows = [row for row in connection.throttle_rows if row["bucket_kind"] != missing_kind]
    service._clock = lambda: login_cases.NOW + timedelta(seconds=901)
    connection.operations.clear()
    service._finalize_success_throttles(connection, reservation, login_cases.NOW)
    updates = [params for sql, params in connection.operations if "set failure_count = greatest" in sql]
    assert len(updates) == 1
    assert updates[0][2] == ("login_source" if missing_kind == "login_account" else "login_account")



@pytest.mark.parametrize("query", ["purpose=account-invitation&token=" + route_cases.INVITATION_RAW, "purpose=wrong&token=" + route_cases.NEXT_INVITATION_RAW], ids=["consumed-link", "unrelated-invalid-link"])
def test_failed_invitation_exchange_does_not_delete_a_cookie_withheld_from_request(query):
    from music_app.routes import auth_asgi
    app, _, _ = route_cases._app(auth_asgi)
    lifecycle = route_cases.FakeInvitationLifecycle()
    lifecycle.valid = False
    app.state.invitation_lifecycle_service = lifecycle
    status, headers, body = route_cases._request(app, "GET", path="/accept-invitation", query=query,
        headers={"sec-fetch-site": "cross-site"})
    assert status == 303 and body == b""
    assert not route_cases._set_cookies(headers), "Absence on this request does not establish that the browser has no valid Strict cookie"


@pytest.mark.parametrize("raw_cookie", ["", "stale-invalid-transaction"])
def test_failed_invitation_exchange_still_clears_a_present_invalid_cookie(raw_cookie):
    from music_app.routes import auth_asgi
    app, _, _ = route_cases._app(auth_asgi)
    lifecycle = route_cases.FakeInvitationLifecycle()
    lifecycle.valid = False
    app.state.invitation_lifecycle_service = lifecycle
    status, headers, _body = route_cases._request(app, "GET", path="/accept-invitation",
        query="purpose=wrong&token=" + route_cases.NEXT_INVITATION_RAW,
        headers={"cookie": f"{route_cases.INVITATION_COOKIE}={raw_cookie}"})
    assert status == 303
    assert any("Max-Age=0" in value and value.startswith(route_cases.INVITATION_COOKIE + "=")
        for value in route_cases._set_cookies(headers))
