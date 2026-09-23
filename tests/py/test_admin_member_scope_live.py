"""Account mutations must enforce the same library scope as the roster."""

from datetime import datetime, timezone

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip


@pytest.mark.parametrize("operation", ["disable", "grant", "revoke"])
def test_live_admin_rejects_unrelated_account_mutations(monkeypatch, operation):
    from music_app.services.admin_member_mutation_postgres import PostgresAdminMemberMutationService
    from music_app.services.admin_members_postgres import PostgresAdminMembersService
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
    now = datetime.now(timezone.utc)
    try:
        isolatedPostgres.reset_application_tables(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            authority = connection.execute("""
                select owner.account_id, library.id as library_id
                from app.bootstrap_owners owner
                join library.libraries library on library.owner_account_id = owner.account_id
                where owner.owner_key = 'local-bootstrap-owner' and library.library_kind = 'local'
            """).fetchone()
            target_id = connection.execute("""
                insert into app.accounts (display_name, account_kind, username_display,
                    username_normalized, contact_email, contact_email_normalized)
                values ('Unrelated', 'managed_user', 'scope-unrelated', 'scope-unrelated',
                    'scope-unrelated@example.test', 'scope-unrelated@example.test') returning id
            """).fetchone()["id"]
            connection.execute("""
                insert into app.capabilities (account_id, capability_key, scope_kind, scope_id, revoked_at)
                values (%s, 'library.browse.read', 'library', %s, %s)
            """, (target_id, authority["library_id"] + 100000, now))
        sessions = PostgresAuthSessionService(config, clock=lambda: now)
        actor_session = sessions.issue_session(authority["account_id"])
        sessions.issue_session(target_id)
        roster = PostgresAdminMembersService(config, clock=lambda: now).load_roster(
            actor_account_id=authority["account_id"], library_id=authority["library_id"],
        )
        assert target_id not in {member.account_id for member in roster.members}

        def snapshot():
            # Table/column names are fixed test constants, never request input.
            with isolatedPostgres._connect(setup_url) as connection:
                return [connection.execute(
                    f"select to_jsonb(row) as value from {table} row where {column} = %s order by to_jsonb(row)::text",
                    (target_id,),
                ).fetchall() for table, column in [
                    ("app.accounts", "id"), ("app.account_sessions", "account_id"),
                    ("app.capabilities", "account_id"), ("library.library_memberships", "account_id"),
                    ("app.security_audit_events", "target_account_id"),
                ]]

        before = snapshot()
        service = PostgresAdminMemberMutationService(config, clock=lambda: now)
        arguments = dict(actor_account_id=authority["account_id"],
            actor_session_id=actor_session.session_id, actor_authenticated_at=now,
            library_id=authority["library_id"], target_account_id=target_id,
            request_ref="unrelated-account-rejected")
        with pytest.raises(PermissionError, match="not permitted"):
            if operation == "revoke":
                service.revoke_sessions(**arguments, confirmed=True)
            else:
                service.update_account(**arguments, is_active=operation != "disable",
                    current_library_access=operation == "grant",
                    capability_keys=("library.browse.read",) if operation == "grant" else (),
                    confirm_disable=True, confirm_remove_access=True)
        assert snapshot() == before
    finally:
        isolatedPostgres.reset_application_tables(setup_url)
