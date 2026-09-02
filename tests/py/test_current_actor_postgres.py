from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module, util

import pytest

from music_app.services.auth_sessions_postgres import ResolvedBrowserSession


MODULE = "music_app.services.current_actor_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven"
RAW_SESSION = "s" * 43
NOW = datetime(2026, 8, 31, 18, 0, tzinfo=timezone.utc)


def test_current_actor_contract_is_present():
    assert util.find_spec(MODULE) is not None


@pytest.fixture
def actors():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return list(self.rows)


class Connection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.operations.append((" ".join(sql.casefold().split()), params))
        return Cursor(self.rows)


class Sessions:
    def __init__(self, resolved):
        self.resolved = resolved
        self.received = []

    def resolve_session(self, raw):
        self.received.append(raw)
        return self.resolved


def _resolved():
    return ResolvedBrowserSession(
        session_id=8,
        account_id=41,
        created_at=NOW,
        authenticated_at=NOW,
        last_seen_at=NOW,
        idle_expires_at=NOW + timedelta(hours=12),
        absolute_expires_at=NOW + timedelta(days=7),
        user_agent="Browser",
    )


def _row(**overrides):
    row = {
        "account_id": 41,
        "username_display": "Rendref",
        "display_name": "Rendref",
        "is_active": True,
        "disabled_at": None,
        "is_bootstrap_owner": True,
        "current_library_id": 73,
        "library_relationships": [
            {
                "library_id": 73,
                "membership_role": "owner",
                "is_primary_owner": True,
            }
        ],
        "capability_grants": [
            {
                "capability_key": "system.admin",
                "scope_kind": "global",
                "scope_id": None,
            },
            {
                "capability_key": "library.read",
                "scope_kind": "library",
                "scope_id": 73,
            },
        ],
    }
    row.update(overrides)
    return row


def _resolver(actors, sessions, connection):
    return actors.PostgresCurrentActorResolver(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        session_service=sessions,
        connect=lambda url: connection if url == DATABASE_URL else None,
    )


def test_missing_or_invalid_session_is_anonymous_without_actor_query(actors):
    sessions = Sessions(None)
    connection = Connection((_row(),))

    actor = _resolver(actors, sessions, connection).resolve(RAW_SESSION)

    assert actor.state is actors.ActorState.ANONYMOUS
    assert actor.is_authenticated is False
    assert actor.account_id is None
    assert actor.library_relationships == ()
    assert actor.capability_grants == ()
    assert connection.operations == []


def test_explicit_falsy_session_service_is_still_the_session_authority(actors):
    class FalsySessions(Sessions):
        def __bool__(self):
            return False

    sessions = FalsySessions(None)
    connection = Connection((_row(),))

    actor = _resolver(actors, sessions, connection).resolve(RAW_SESSION)

    assert actor.state is actors.ActorState.ANONYMOUS
    assert sessions.received == [RAW_SESSION]
    assert connection.operations == []


def test_active_actor_loads_bootstrap_memberships_and_grants_in_one_snapshot(actors):
    sessions = Sessions(_resolved())
    connection = Connection((_row(),))

    actor = _resolver(actors, sessions, connection).resolve(RAW_SESSION)

    assert sessions.received == [RAW_SESSION]
    assert actor.state is actors.ActorState.ACTIVE
    assert actor.is_authenticated is True
    assert actor.account_id == 41
    assert actor.session_id == 8
    assert actor.username_display == "Rendref"
    assert actor.is_bootstrap_owner is True
    assert actor.current_library_id == 73
    assert actor.library_relationships == (
        actors.LibraryRelationship(73, "owner", True),
    )
    assert actor.capability_grants == (
        actors.CapabilityGrant("library.read", "library", 73),
        actors.CapabilityGrant("system.admin", "global", None),
    )
    assert len(connection.operations) == 1
    sql, params = connection.operations[0]
    assert "from app.accounts" in sql
    assert "from app.bootstrap_owners" in sql
    assert "from library.library_memberships" in sql
    assert "local-bootstrap-owner" in sql
    assert "from app.capabilities" in sql
    assert "revoked_at is null" in sql
    assert params == (41,)
    assert RAW_SESSION not in repr(connection.operations)


def test_account_disabled_after_session_resolution_returns_inactive_without_authority(
    actors,
):
    sessions = Sessions(_resolved())
    connection = Connection(
        (_row(is_active=False, disabled_at=NOW, capability_grants=[]),)
    )

    actor = _resolver(actors, sessions, connection).resolve(RAW_SESSION)

    assert actor.state is actors.ActorState.INACTIVE
    assert actor.is_authenticated is False
    assert actor.account_id == 41
    assert actor.session_id == 8
    assert actor.library_relationships == ()
    assert actor.capability_grants == ()
    assert actor.current_library_id is None


def test_actor_without_current_library_membership_fails_closed(actors):
    row = _row(
        current_library_id=99,
        library_relationships=[
            {"library_id": 73, "membership_role": "member", "is_primary_owner": False}
        ],
    )

    with pytest.raises(RuntimeError, match="current library"):
        _resolver(actors, Sessions(_resolved()), Connection((row,))).resolve(RAW_SESSION)


@pytest.mark.parametrize("rows", [(), (_row(), _row())])
def test_missing_or_duplicate_account_context_fails_closed(actors, rows):
    resolver = _resolver(actors, Sessions(_resolved()), Connection(rows))

    with pytest.raises(RuntimeError, match="actor context"):
        resolver.resolve(RAW_SESSION)


def test_actor_repr_omits_session_and_contact_secrets(actors):
    actor = _resolver(
        actors, Sessions(_resolved()), Connection((_row(),))
    ).resolve(RAW_SESSION)

    rendered = repr(actor)
    assert RAW_SESSION not in rendered
    assert "contact_email" not in rendered
    assert "session_token" not in rendered
