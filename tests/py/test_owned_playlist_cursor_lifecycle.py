"""Faithful scripted-cursor cleanup only, not live PostgreSQL verification."""
import pytest
from psycopg import InterfaceError

from music_app.services.admin_member_mutation_postgres import (
    RecentAuthenticationRequired, lock_current_actor_session,
)
from tests.py.owned_playlist_testing import (
    ACCOUNT, NOW, SESSION, Connection, Cursor, authority_steps,
)


def test_scripted_cursor_close_is_idempotent_and_rejects_later_fetches():
    original = [{"id": SESSION}]
    cursor = Cursor(original)
    original[0]["id"] = -1
    fetched = cursor.fetchall()
    assert fetched == [{"id": SESSION}]
    assert cursor.fetchone() == fetched[0]
    assert cursor.closed is False and cursor.close_calls == 0

    assert cursor.close() is None
    assert cursor.closed is True and cursor.close_calls == 1
    assert cursor.rows == []
    assert fetched == [{"id": SESSION}]  # Closing cannot erase fetched results.
    for fetch in (cursor.fetchone, cursor.fetchall):
        with pytest.raises(InterfaceError, match="the cursor is closed"):
            fetch()
    assert cursor.close() is None
    assert cursor.closed is True and cursor.close_calls == 2


@pytest.mark.parametrize("state", ["valid", "missing", "revoked"])
def test_real_session_lock_closes_once_before_post_lock_clock(state):
    step = authority_steps()[3]
    if state == "missing":
        step.rows = []
    elif state == "revoked":
        step.rows[0]["revoked_at"] = NOW
    connection = Connection([step])
    clock_calls = []

    def clock():
        assert len(connection.cursors) == 1
        cursor = connection.cursors[0]
        assert cursor.closed is True and cursor.close_calls == 1
        clock_calls.append(NOW)
        return NOW

    def call():
        return lock_current_actor_session(connection, actor_account_id=ACCOUNT,
            actor_session_id=SESSION, clock=clock)

    if state == "valid":
        assert call() == NOW
    else:
        with pytest.raises(RecentAuthenticationRequired):
            call()
    connection.done()
    assert clock_calls == [NOW]
    assert connection.cursors[0].closed is True
    assert connection.cursors[0].close_calls == 1
    assert connection.writes == []


def test_real_session_lock_closes_on_fetch_failure_without_sampling_clock(monkeypatch):
    connection = Connection([authority_steps()[3]])
    failure = RuntimeError("scripted fetch failure")

    def fail_fetch(cursor):
        assert cursor.closed is False
        raise failure

    def forbidden_clock():
        pytest.fail("Post-lock clock must not be sampled after fetch failure")

    monkeypatch.setattr(Cursor, "fetchall", fail_fetch)
    with pytest.raises(RuntimeError) as caught:
        lock_current_actor_session(connection, actor_account_id=ACCOUNT,
            actor_session_id=SESSION, clock=forbidden_clock)
    assert caught.value is failure
    connection.done()
    assert len(connection.cursors) == 1
    assert connection.cursors[0].closed is True
    assert connection.cursors[0].close_calls == 1
    assert connection.writes == []
