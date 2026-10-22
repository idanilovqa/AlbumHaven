"""Durable demand-run scopes and compare-and-set progress boundary tests."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services import library_popularity_jobs as jobs

NOW = datetime(2026, 10, 13, 22, tzinfo=timezone.utc)
CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test.invalid/owned-test"}
RUN = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def database():
    state = SimpleNamespace(calls=[], row=None, open=0)
    class Connection:
        def execute(self, sql, params=()):
            state.calls.append((sql, params))
            return self
        def fetchone(self):
            return state.row
    state.connection = Connection()
    @contextmanager
    def connect(url):
        assert url == CONFIG["ALBUM_HAVEN_APP_DATABASE_URL"]
        state.open += 1
        try:
            yield state.connection
        finally:
            state.open -= 1
    state.connect = connect
    return state


def test_request_captures_local_library_high_water_without_restarting_active_run(database):
    jobs.request_refresh(CONFIG, 7, connect=database.connect, clock=lambda: NOW)
    sql, params = database.calls[0]
    assert params[1:] == (NOW, NOW, NOW, 7)
    assert "coalesce(max(t.id),0)" in sql
    assert "l.library_kind='local'" in sql
    assert "where library.popularity_refresh_jobs.status in ('complete','blocked','cancelled')" in sql
    assert "last_track_id=0" in sql
    assert database.open == 0


@pytest.mark.parametrize("library_id", [None, True, 0, -1, "7"])
def test_invalid_demand_library_is_rejected_before_connection(database, library_id):
    with pytest.raises(ValueError):
        jobs.request_refresh(CONFIG, library_id, connect=database.connect)
    assert database.calls == []


def test_cancel_is_library_scoped_and_only_changes_active_states(database):
    jobs.cancel_refresh(CONFIG, 7, connect=database.connect)
    sql, params = database.calls[0]
    assert "where library_id=%s and status in ('queued','running')" in sql
    assert "status='cancelled'" in sql
    assert params == (7,)
    assert database.open == 0


def test_active_run_check_pins_run_identity_and_optional_share_lock(database):
    database.row = {"run_ref": RUN}
    assert jobs.job_active(database.connection, 7, RUN, lock=True) is True
    sql, params = database.calls[-1]
    assert "library_id=%s and run_ref=%s" in sql
    assert "status in ('queued','running')" in sql
    assert sql.endswith(" for share")
    assert params == (7, RUN)
    database.row = None
    assert jobs.job_active(database.connection, 7, RUN) is False
    assert not database.calls[-1][0].endswith(" for share")


def test_progress_update_cannot_resurrect_cancelled_or_superseded_run(database):
    jobs.update_job(database.connection, {"library_id": 7, "run_ref": RUN}, status="queued",
        now=NOW, delay=timedelta(minutes=1), cursor=25, examined=25, requests=24)
    sql, params = database.calls[0]
    assert "where library_id=%s and run_ref=%s and status in ('queued','running')" in sql
    assert "examined_tracks=examined_tracks+%s" in sql
    assert "provider_requests=provider_requests+%s" in sql
    assert params == ("queued", NOW, NOW + timedelta(minutes=1), 25, 25, 24, 7, RUN)


@pytest.mark.parametrize("status", ["complete", "blocked", "cancelled"])
def test_terminal_jobs_do_not_schedule_provider_continuation(database, status):
    database.row = {"status": status, "next_batch_at": NOW}
    assert jobs.pending_refresh_delay(CONFIG, 7, connect=database.connect) is None
    assert database.open == 0
