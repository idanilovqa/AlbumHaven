"""Every recent-authenticated admin mutation checks its final locked session."""
from datetime import timedelta
import importlib

import pytest

from music_app.services.admin_member_mutation_postgres import RecentAuthenticationRequired


@pytest.mark.parametrize("action", ["update_account", "revoke_sessions", "issue_copy", "queue_email", "queue_welcome", "queue_password_reset"])
@pytest.mark.parametrize("failure", ["missing", "revoked", "idle", "absolute", "stale"])
def test_recent_admin_actions_reject_invalid_locked_actor_session(action, failure):
    module_name = ("test_admin_member_mutation_postgres" if action in {"update_account", "revoke_sessions"}
        else "test_admin_account_invitations_postgres" if action in {"issue_copy", "queue_email"}
        else "test_admin_mail_actions_postgres")
    fixture = importlib.import_module("tests.py." + module_name)

    class Connection(fixture.Connection):
        def execute(self, sql, params=()):
            result = super().execute(sql, params)
            if "from app.account_sessions" in sql and "for update" in sql:
                if failure == "missing":
                    result.rows.clear()
                else:
                    row = result.rows[0]
                    if failure == "revoked":
                        row["revoked_at"] = fixture.NOW
                    elif failure == "idle":
                        row["idle_expires_at"] = fixture.NOW
                    elif failure == "absolute":
                        row["absolute_expires_at"] = fixture.NOW
                    else:
                        row["authenticated_at"] = fixture.NOW - timedelta(minutes=11)
            return result

    connection = Connection()
    if action in {"issue_copy", "queue_email"}:
        source = importlib.import_module("music_app.services.admin_account_invitations_postgres")
        service = fixture._service(source, connection)
    else:
        service = fixture._service(connection)
    arguments = dict(actor_account_id=7, actor_session_id=11,
        actor_authenticated_at=fixture.NOW, library_id=9, target_account_id=41,
        request_ref="stale-actor-session")
    if action == "update_account":
        arguments.update(is_active=False, current_library_access=True,
            capability_keys=("library.browse.read",), confirm_disable=True, confirm_remove_access=False)
    elif action == "revoke_sessions":
        arguments["confirmed"] = True
    with pytest.raises(RecentAuthenticationRequired):
        getattr(service, action)(**arguments)
    statements = [sql for sql, _ in connection.operations]
    account_lock = next(i for i, sql in enumerate(statements) if "with locked_accounts" in sql)
    session_lock = next(i for i, sql in enumerate(statements) if "from app.account_sessions" in sql)
    assert account_lock < session_lock
    assert not any(sql.startswith(("insert ", "update ", "delete ", "audit")) for sql in statements)
    assert connection.events == ["begin", "rollback"]