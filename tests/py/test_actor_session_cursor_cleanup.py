"""Real shared session validator over a synthetic query-result boundary."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services.admin_member_mutation_postgres import (
    lock_current_actor_session, RecentAuthenticationRequired,
)

NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)


@pytest.mark.parametrize('outcome', ['valid', 'missing', 'revoked', 'fetch-error'])
def test_shared_session_cursor_closes_on_success_rejection_and_fetch_error(outcome):
    row = dict(id=3, account_id=1, authenticated_at=NOW,
               idle_expires_at=NOW + timedelta(hours=1),
               absolute_expires_at=NOW + timedelta(days=1),
               revoked_at=NOW if outcome == 'revoked' else None)
    class Cursor:
        closed = False
        def fetchall(self):
            assert not self.closed
            if outcome == 'fetch-error': raise OSError('synthetic result failure')
            return [] if outcome == 'missing' else [row]
        def close(self):
            assert not self.closed
            self.closed = True
    cursor = Cursor()
    calls = []
    def execute(sql, parameters):
        calls.append((sql, parameters))
        assert 'from app.account_sessions' in sql and 'for update' in sql
        assert parameters == (3, 1)
        return cursor
    connection = SimpleNamespace(execute=execute)
    if outcome == 'valid':
        assert lock_current_actor_session(connection, actor_account_id=1,
            actor_session_id=3, clock=lambda: NOW) == NOW
    else:
        with pytest.raises(OSError if outcome == 'fetch-error' else RecentAuthenticationRequired):
            lock_current_actor_session(connection, actor_account_id=1,
                actor_session_id=3, clock=lambda: NOW)
    assert cursor.closed and len(calls) == 1
