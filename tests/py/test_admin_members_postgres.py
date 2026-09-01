from datetime import datetime, timezone


NOW = datetime(2026, 8, 31, 22, 0, tzinfo=timezone.utc)


class Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc, tb):
        return False


class Connection:
    def __init__(self, rows):
        self.rows = rows
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction()

    def execute(self, sql, params=()):
        self.operations.append((" ".join(sql.casefold().split()), params))
        return Cursor(self.rows)


def test_member_roster_revalidates_owner_and_returns_bounded_operational_summary():
    from music_app.services.admin_members_postgres import (
        PostgresAdminMembersService,
        _account_status,
    )

    rows = (
        {
            "library_id": 9,
            "library_name": "Rendref's Library",
            "account_id": 7,
            "username_display": "Rendref",
            "contact_email": "rendref@example.test",
            "is_active": True,
            "disabled_at": None,
            "is_bootstrap_owner": True,
            "membership_role": "owner",
            "capability_keys": [],
            "welcome_status": None,
            "active_session_count": 1,
            "last_active_at": NOW,
            "has_credential": True,
            "invitation_delivery_status": None,
        },
        {
            "library_id": 9,
            "library_name": "Rendref's Library",
            "account_id": 41,
            "username_display": "test.user+1",
            "contact_email": "test.user+1@example.test",
            "is_active": True,
            "disabled_at": None,
            "is_bootstrap_owner": False,
            "membership_role": "member",
            "capability_keys": ["library.browse.read", "library.playlists.create"],
            "welcome_status": None,
            "active_session_count": 0,
            "last_active_at": None,
            "has_credential": False,
            "invitation_delivery_status": "sent",
        },
        {
            "library_id": 9,
            "library_name": "Rendref's Library",
            "account_id": 42,
            "username_display": "disabled.user",
            "contact_email": "disabled.user@example.test",
            "is_active": False,
            "disabled_at": NOW,
            "is_bootstrap_owner": False,
            "membership_role": "member",
            "capability_keys": ["library.browse.read"],
            "welcome_status": None,
            "active_session_count": 0,
            "last_active_at": None,
            "has_credential": True,
            "invitation_delivery_status": "failed",
        },
    )
    connection = Connection(rows)
    service = PostgresAdminMembersService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
        clock=lambda: NOW,
    )

    roster = service.load_roster(actor_account_id=7, library_id=9)

    assert roster.library_id == 9
    assert roster.library_name == "Rendref's Library"
    assert [member.username for member in roster.members] == [
        "Rendref",
        "test.user+1",
        "disabled.user",
    ]
    assert roster.members[0].is_bootstrap_owner is True
    assert roster.members[0].has_credential is True
    assert roster.members[0].account_status == "Enabled"
    assert roster.members[1].is_active is True
    assert roster.members[1].has_credential is False
    assert roster.members[1].account_status == "Pending invitation"
    assert roster.members[1].invitation_delivery_status == "sent"
    assert roster.members[2].is_active is False
    assert roster.members[2].account_status == "Disabled"
    assert roster.members[2].invitation_delivery_status == "failed"
    assert roster.members[1].capability_keys == (
        "library.browse.read",
        "library.playlists.create",
    )
    assert roster.members[1].welcome_status is None
    assert _account_status(is_active=True, has_credential=True) == "Enabled"
    assert _account_status(is_active=True, has_credential=False) == "Pending invitation"
    assert _account_status(is_active=False, has_credential=False) == "Disabled"
    sql = connection.operations[0][0]
    assert "local-bootstrap-owner" in sql
    assert "library_roots" not in sql
    assert "root_path" not in sql
    assert "left join app.account_credentials credential" in sql
    assert "(credential.account_id is not null) as has_credential" in sql
    assert "message_category = 'account_invitation'" in sql
    assert "invitation_delivery_status" in sql
    assert connection.operations[0][1] == (9, 7, NOW, NOW)


def test_member_roster_fails_closed_when_durable_owner_authority_returns_no_rows():
    from music_app.services.admin_members_postgres import PostgresAdminMembersService

    connection = Connection(())
    service = PostgresAdminMembersService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
        clock=lambda: NOW,
    )

    try:
        service.load_roster(actor_account_id=7, library_id=9)
    except PermissionError:
        pass
    else:
        raise AssertionError("missing durable owner authority must fail closed")
