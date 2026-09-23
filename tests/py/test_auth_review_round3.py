"""Focused production-boundary regressions from the third complete review."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.admin_account_creation import AdminAccountCreationService
from music_app.services.admin_account_creation_postgres import PostgresAdminAccountRepository
from tests.py.test_admin_account_creation import Repository, _owner
from tests.py.test_admin_account_creation_postgres import Connection, Cursor
from tests.py.test_auth_preauth_postgres import RecordingConnection, RAW_TOKEN, _service


def _create(service, actor=None):
    return service.create_account(actor=actor or _owner(), username="review.member",
        contact_email="review.member@example.test", capability_keys=("library.browse.read",),
        send_invitation=True, request_ref="round3-create")


def test_creation_forwards_the_admitted_session():
    repository = Repository()
    _create(AdminAccountCreationService(repository=repository, invitation_token_seconds=600))
    assert repository.calls[0].get("actor_session_id") == 11


@pytest.mark.parametrize("state", ["missing", "revoked", "wrong_account", "idle_expired", "absolute_expired", "live_old_auth"])
def test_creation_revalidates_live_session_without_an_extra_reauth_prompt(state):
    now = datetime.now(timezone.utc)

    class SessionConnection(Connection):
        def execute(self, sql, params=()):
            if "from app.account_sessions" in " ".join(sql.lower().split()):
                self.operations.append((" ".join(sql.lower().split()), params))
                row = {"id": 11, "account_id": 7, "authenticated_at": now - timedelta(hours=1),
                    "idle_expires_at": now + timedelta(hours=2),
                    "absolute_expires_at": now + timedelta(hours=3), "revoked_at": None}
                if state == "missing":
                    return Cursor()
                if state == "revoked":
                    row["revoked_at"] = now
                if state == "wrong_account":
                    row["account_id"] = 8
                if state == "idle_expired":
                    row["idle_expires_at"] = now - timedelta(seconds=1)
                if state == "absolute_expired":
                    row["absolute_expires_at"] = now - timedelta(seconds=1)
                return Cursor([row])
            return super().execute(sql, params)

    connection = SessionConnection()
    service = AdminAccountCreationService(repository=PostgresAdminAccountRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"}, connect=lambda _url: connection),
        invitation_token_seconds=600)
    if state == "live_old_auth":
        assert _create(service).account_id == 41
    else:
        with pytest.raises(PermissionError):
            _create(service)
        assert not any(sql.startswith("insert") for sql, _ in connection.operations)


@pytest.mark.parametrize("purpose", ["login", "forgot"])
@pytest.mark.parametrize("delay", ["connect", "lock"])
def test_preauth_expiry_is_checked_after_connection_and_lock_waits(purpose, delay):
    from music_app.services import auth_preauth_postgres as preauth
    now = datetime(2026, 9, 9, tzinfo=timezone.utc)
    clock = [now]
    expires = now + timedelta(seconds=1)

    class DelayedConnection(RecordingConnection):
        def __enter__(self):
            if delay == "connect":
                clock[0] = expires + timedelta(seconds=1)
            return super().__enter__()

        def execute(self, sql, params=None):
            statement = " ".join(sql.lower().split())
            self.operations.append((statement, params))
            if delay == "lock" and ("for update" in statement or statement.startswith("update")):
                clock[0] = expires + timedelta(seconds=1)
            if statement.startswith("select"):
                return Cursor([{"id": 71}])
            if statement.startswith("update"):
                return Cursor([{"id": 71}] if params[-1] < expires else [])
            raise AssertionError(statement)

    connection = DelayedConnection()
    service = _service(preauth, connection, clock=lambda: clock[0])
    assert getattr(service, f"consume_{purpose}_token")(RAW_TOKEN) is False


@pytest.mark.parametrize("chunks", [(b"x" * 17,), (b"{}", b"x" * 15)])
def test_json_rejects_overflow_before_copying_the_chunk(monkeypatch, chunks):
    from music_app.routes import bounded_json
    copied, yielded = [], []

    class TrackedBody(bytearray):
        def extend(self, chunk):
            copied.append(len(chunk))
            return super().extend(chunk)

    class Request:
        headers = {}

        async def stream(self):
            for chunk in (*chunks, b"must not be read"):
                yielded.append(chunk)
                yield chunk

    monkeypatch.setattr(bounded_json, "bytearray", TrackedBody, raising=False)
    with pytest.raises(bounded_json.JSONBodyTooLarge):
        asyncio.run(bounded_json.read_bounded_json_object(Request(), max_bytes=16))
    assert copied == ([2] if len(chunks) == 2 else [])
    assert yielded == list(chunks)


@pytest.mark.parametrize("chunks", [(b"{}" + b" " * 14,), (b"{", b"}")])
def test_json_accepts_exact_limit_and_split_objects(chunks):
    from music_app.routes.bounded_json import read_bounded_json_object

    class Request:
        headers = {}

        async def stream(self):
            for chunk in chunks:
                yield chunk

    assert asyncio.run(read_bounded_json_object(Request(), max_bytes=16)) == {}
