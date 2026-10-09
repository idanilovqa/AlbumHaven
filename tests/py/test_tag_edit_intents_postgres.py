from __future__ import annotations

from contextlib import contextmanager, nullcontext

import pytest

from music_app.services.tag_edit_intents_postgres import (
    PostgresTagEditIntentRepository,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"


class FakeCursor:
    def __init__(self, *, row=None, rows=None):
        self._row = row
        self._rows = list(rows or [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, cursors):
        self.cursors = list(cursors)
        self.calls = []
        self.events = []

    def execute(self, sql, params=None):
        raw_params = dict(params or {})
        self.calls.append(
            (
                " ".join(sql.lower().split()),
                {
                    key: getattr(value, "obj", value)
                    for key, value in raw_params.items()
                },
            )
        )
        return self.cursors.pop(0)

    @contextmanager
    def transaction(self):
        self.events.append("transaction-enter")
        try:
            yield
        except BaseException:
            self.events.append("transaction-rollback")
            raise
        self.events.append("transaction-commit")


def repository_for(connection):
    return PostgresTagEditIntentRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: (
            nullcontext(connection)
            if database_url == DATABASE_URL
            else pytest.fail(f"unexpected database URL: {database_url}")
        ),
    )


def changes():
    return [
        {
            "path": "X:/SyntheticMusic/Fictional Artist/track.mp3",
            "old_values": {"album": "Folkstone", "exception_type": "non_album_rarity"},
            "requested_values": {"album": "", "exception_type": ""},
        }
    ]


def test_prepare_intent_commits_before_returning_and_serializes_changed_values():
    connection = FakeConnection([FakeCursor(row={"id": "intent-1"})])

    intent_id = repository_for(connection).prepare_intent(
        library_root_identity="X:/SyntheticMusic",
        changes=changes(),
    )

    assert intent_id == "intent-1"
    assert connection.events == ["transaction-enter", "transaction-commit"]
    sql, params = connection.calls[0]
    assert "insert into library.tag_edit_intents" in sql
    assert params["library_root_identity"] == "X:/SyntheticMusic"
    assert params["changes"] == changes()
    assert params["intent_id"]


def test_mark_terminal_in_transaction_uses_callers_connection_without_committing():
    connection = FakeConnection([FakeCursor(row={"id": "intent-1"})])
    repository = repository_for(connection)

    repository.mark_terminal_in_transaction(
        connection,
        "intent-1",
        status="completed",
    )

    assert connection.events == []
    sql, params = connection.calls[0]
    assert "update library.tag_edit_intents" in sql
    assert "completed_at" in sql
    assert params == {
        "intent_id": "intent-1",
        "status": "completed",
        "last_error": None,
    }


def test_complete_in_transaction_persists_exception_values_before_terminal_marker():
    connection = FakeConnection(
        [
            FakeCursor(row={"ready": True}),
            FakeCursor(),
            FakeCursor(row={"id": "intent-1"}),
        ]
    )

    repository_for(connection).complete_in_transaction(
        connection,
        "intent-1",
        exception_updates={"X:/SyntheticMusic/Fictional Artist/track.mp3": ""},
    )

    assert connection.events == []
    bootstrap_sql = connection.calls[0][0]
    override_sql = connection.calls[1][0]
    assert "from app.bootstrap_owners" in bootstrap_sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in bootstrap_sql
    assert "app.bootstrap_owners.is_local" not in bootstrap_sql
    assert "insert into library.exception_overrides" in override_sql
    assert "app.bootstrap_owners.owner_key = 'local-bootstrap-owner'" in override_sql
    assert "app.bootstrap_owners.is_local" not in override_sql
    assert "update library.tag_edit_intents" in connection.calls[2][0]
    assert connection.calls[1][1] == {
        "track_key": "X:/SyntheticMusic/Fictional Artist/track.mp3",
        "override_payload": {"exception_type": ""},
    }


def test_load_unfinished_intents_filters_by_active_library_root_identity():
    connection = FakeConnection(
        [
            FakeCursor(
                rows=[
                    {
                        "id": "intent-1",
                        "library_root_identity": "X:/SyntheticMusic",
                        "status": "prepared",
                        "changes": changes(),
                        "created_at": "2026-08-13T12:00:00+00:00",
                        "updated_at": "2026-08-13T12:00:00+00:00",
                        "completed_at": None,
                        "last_error": None,
                    }
                ]
            )
        ]
    )

    intents = repository_for(connection).load_unfinished_intents(
        library_root_identity="X:/SyntheticMusic",
    )

    assert intents[0]["changes"] == changes()
    sql, params = connection.calls[0]
    assert "where status in ('prepared', 'files_verified', 'recovery_failed')" in sql
    assert "library_root_identity = %(library_root_identity)s" in sql
    assert params == {"library_root_identity": "X:/SyntheticMusic"}
    assert "order by created_at, id" in sql


def test_repository_rejects_empty_or_malformed_changes_before_opening_postgres():
    repository = PostgresTagEditIntentRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda _database_url: pytest.fail("invalid intent opened Postgres"),
    )

    with pytest.raises(ValueError, match="at least one changed path"):
        repository.prepare_intent(library_root_identity="X:/SyntheticMusic", changes=[])
    with pytest.raises(ValueError, match="old and requested values"):
        repository.prepare_intent(
            library_root_identity="X:/SyntheticMusic",
            changes=[{"path": "X:/SyntheticMusic/track.mp3", "old_values": {}, "requested_values": {}}],
        )


class LeaseConnection(FakeConnection):
    def __enter__(self):
        self.events.append("open")
        return self

    def __exit__(self, *_args):
        self.events.append("close")


def lease_repository(connection):
    return PostgresTagEditIntentRepository({"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL}, connect=lambda _url: connection)


def test_intent_lease_locks_before_prepared_commit_and_releases_once():
    connection = LeaseConnection([FakeCursor(), FakeCursor(row={}), FakeCursor()])
    lease = lease_repository(connection).intent_lease()
    intent_id = lease.prepare_intent(library_root_identity="root", changes=changes())
    assert intent_id
    assert "pg_advisory_lock" in connection.calls[0][0]
    assert "insert into library.tag_edit_intents" in connection.calls[1][0]
    assert "close" not in connection.events
    lease.release()
    lease.release()
    assert "pg_advisory_unlock" in connection.calls[2][0]
    assert connection.events.count("close") == 1


def test_recovery_claim_skips_busy_intent_without_reading_journal():
    connection = LeaseConnection([FakeCursor(row={"locked": False})])
    with lease_repository(connection).claim_unfinished_intent("00000000-0000-0000-0000-000000000001", library_root_identity="root") as claimed:
        assert claimed is None
    assert len(connection.calls) == 1
    assert "pg_try_advisory_lock" in connection.calls[0][0]
    assert connection.events[-1] == "close"


def test_recovery_claim_rereads_and_skips_completed_intent():
    connection = LeaseConnection([FakeCursor(row={"locked": True}), FakeCursor(row=None), FakeCursor()])
    with lease_repository(connection).claim_unfinished_intent("00000000-0000-0000-0000-000000000001", library_root_identity="root") as claimed:
        assert claimed is None
    assert "status in" in connection.calls[1][0]
    assert connection.calls[1][1]["library_root_identity"] == "root"
    assert "pg_advisory_unlock" in connection.calls[2][0]
    assert connection.events[-1] == "close"


def test_intent_lease_preparation_failure_closes_owned_session():
    class BrokenConnection(LeaseConnection):
        def execute(self, sql, params=None):
            if "insert into" in sql.lower():
                raise RuntimeError("insert failed")
            return super().execute(sql, params)
    connection = BrokenConnection([FakeCursor(), FakeCursor()])
    lease = lease_repository(connection).intent_lease()
    with pytest.raises(RuntimeError, match="insert failed"):
        lease.prepare_intent(library_root_identity="root", changes=changes())
    assert connection.events[-1] == "close"
    assert "pg_advisory_unlock" in connection.calls[-1][0]
