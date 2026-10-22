"""Scripted common-lock-order contracts; not PostgreSQL concurrency evidence.

Companion to the dormant admission persistence/helper-extraction change. These
checks call the real service owners with the repository's scripted SQL seam.
They do not substitute config/application modules or claim to prove DB rollback.
"""
from copy import deepcopy
import hashlib

import pytest

from music_app.services import measured_listen_history as measured
from music_app.services.listen_history_postgres import PostgresListenHistoryAdapter
from tests.py.owned_playlist_testing import ACCOUNT, LIBRARY, Connection, Step


URL = "postgresql://synthetic-invalid/measured-lock-order"
DEVICE = "71000000-0000-4000-8000-000000000001"
SESSION = "71000000-0000-4000-8000-000000000002"
PATH = "/synthetic/measured-lock-order.flac"
TRACK = {"id": 901, "track_key": "synthetic-lock-order-track"}
ACCOUNT_SQL = ("with locked_accounts as ( select id from app.accounts where id in (%s, %s) "
               "order by id for update ) select id from locked_accounts")
ADVISORY_SQL = "select pg_advisory_xact_lock(%s)"
TRACK_SQL = ("select t.id,t.track_key from library.local_tracks t "
             "join library.local_track_files f on f.track_id=t.id "
             "where t.library_id=%s and f.private_path=%s")
ROW_SQL = ("select * from integration.listen_history where account_id=%s and library_id=%s "
           "and device_id=%s and session_id=%s and measurement_version=%s for update")
INSERT_SQL = ("insert into integration.listen_history "
              "(account_id,library_id,track_id,track_key,played_at,source_family,source_entry_id, "
              "device_id,session_id,measurement_version,measured_listened_seconds, "
              "max_measured_contiguous_seconds,last_sequence,finalized,metadata) "
              "values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)")
UPDATE_SQL = ("update integration.listen_history set measured_listened_seconds=%s,"
              "max_measured_contiguous_seconds=%s, last_sequence=%s,finalized=%s,metadata=%s where id=%s")


def entry(**changes):
    return {"measurement_version": "rendered-pcm-v1", "device_id": DEVICE, "session_id": SESSION,
            "sequence": 1, "measured_listened_seconds": 12.5, "max_measured_contiguous_seconds": 11.0,
            "finalized": False, "path": PATH, "track_ref": PATH,
            "canonical_match": {"library_track_id": str(TRACK["id"])},
            "started_at": "2026-10-16T00:00:00+00:00", "recorded_at": "2026-10-16T00:00:13+00:00",
            "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
            "scrobbled": False, **changes}


def identity(item):
    # Independent expected bytes: deliberately do not call the extracted helper.
    return f"{ACCOUNT}:{LIBRARY}:{item['device_id']}:{item['session_id']}"


def advisory_key(value):
    return int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big", signed=True)


def accepted(item):
    return {**deepcopy(item), "id": hashlib.sha256(identity(item).encode()).hexdigest()}


def current(item):
    return {"id": 1234, "track_id": TRACK["id"], "last_sequence": item["sequence"],
            "measured_listened_seconds": item["measured_listened_seconds"],
            "max_measured_contiguous_seconds": item["max_measured_contiguous_seconds"],
            "finalized": item["finalized"], "metadata": {"source_payload": accepted(item)}}


def prefix(item, row=None):
    return [Step(ACCOUNT_SQL, [{"id": ACCOUNT}], (ACCOUNT, ACCOUNT)),
            Step(ADVISORY_SQL, params=(advisory_key(identity(item)),)),
            Step(TRACK_SQL, [TRACK], (LIBRARY, PATH)),
            Step(ROW_SQL, [] if row is None else [row],
                 (ACCOUNT, LIBRARY, item["device_id"], item["session_id"], "rendered-pcm-v1"))]


def append(connection, item):
    adapter = PostgresListenHistoryAdapter({"ALBUM_HAVEN_APP_DATABASE_URL": URL},
                                          connect=lambda _url: connection)
    return measured.append_measured(adapter, item, account_id=ACCOUNT, library_id=LIBRARY)


def assert_prefix(connection, item):
    assert connection.operations[:4] == [
        (ACCOUNT_SQL, (ACCOUNT, ACCOUNT)), (ADVISORY_SQL, (advisory_key(identity(item)),)),
        (TRACK_SQL, (LIBRARY, PATH)),
        (ROW_SQL, (ACCOUNT, LIBRARY, item["device_id"], item["session_id"], "rendered-pcm-v1")),
    ]


def test_first_insert_locks_account_before_unchanged_advisory_in_one_connection():
    item = entry()
    before = deepcopy(item)
    connection = Connection([*prefix(item), Step(INSERT_SQL)])
    result = append(connection, item)
    connection.done()
    assert connection.entered == 1 and connection.exits == [None]
    assert_prefix(connection, item)
    assert len(connection.operations) == 5 and len(connection.writes) == 1
    sql, values = connection.writes[0]
    assert sql == INSERT_SQL
    assert values[:-1] == (ACCOUNT, LIBRARY, TRACK["id"], TRACK["track_key"], item["started_at"],
        "rendered_local_listen_session", identity(item), DEVICE, SESSION, "rendered-pcm-v1", 12.5, 11.0, 1, False)
    assert values[-1].obj == {"source_payload": accepted(item)}
    assert result == accepted(item) and item == before


@pytest.mark.parametrize("submitted_sequence", [0, 1])
def test_stale_and_identical_sequence_keep_original_payload_without_writes(submitted_sequence):
    old = entry(scrobbled=True, scrobble_submission_state="accepted", scrobble_error="")
    item = entry(sequence=submitted_sequence)
    connection = Connection(prefix(item, current(old)))
    assert append(connection, item) == accepted(old)
    connection.done()
    assert_prefix(connection, item)
    assert connection.exits == [None] and connection.writes == []


@pytest.mark.parametrize("changes", [
    {"measured_listened_seconds": 13.0}, {"title": "Changed title"},
])
def test_same_sequence_conflict_remains_409_after_account_then_identity_lock(changes):
    item = entry(**changes)
    connection = Connection(prefix(item, current(entry())))
    with pytest.raises(measured.MeasuredListenError) as caught:
        append(connection, item)
    assert caught.value.status_code == 409
    connection.done()
    assert_prefix(connection, item)
    assert connection.writes == [] and len(connection.exits) == 1 and connection.exits[0] is caught.value


def test_newer_update_keeps_server_provider_fields_and_exact_update_sql():
    old = entry(scrobbled=True, scrobble_error="", scrobble_retryable=False,
                sync_problem={"provider": "lastfm", "status": "accepted"},
                scrobble_submission_state="accepted")
    item = entry(sequence=2, measured_listened_seconds=20.0,
                 max_measured_contiguous_seconds=15.0, finalized=True)
    connection = Connection([*prefix(item, current(old)), Step(UPDATE_SQL)])
    result = append(connection, item)
    connection.done()
    assert_prefix(connection, item)
    assert len(connection.operations) == 5 and connection.exits == [None]
    expected = accepted(item)
    for key in ("scrobbled", "scrobble_error", "scrobble_retryable", "sync_problem", "scrobble_submission_state"):
        expected[key] = old[key]
    assert result == expected
    sql, values = connection.writes[0]
    assert sql == UPDATE_SQL and values[:4] == (20.0, 15.0, 2, True)
    assert values[4].obj == {"source_payload": expected} and values[5:] == (1234,)


@pytest.mark.parametrize("changes", [
    {"measured_listened_seconds": 11.5}, {"max_measured_contiguous_seconds": 10.0},
    {"started_at": "2026-10-16T00:01:00+00:00"}, {"finalized": False},
])
def test_newer_regression_and_identity_rules_are_unchanged(changes):
    old = entry(finalized=True)
    item = entry(sequence=2, finalized=True)
    item.update(changes)
    connection = Connection(prefix(item, current(old)))
    with pytest.raises(measured.MeasuredListenError) as caught:
        append(connection, item)
    assert caught.value.status_code == 409
    connection.done()
    assert connection.writes == []


@pytest.mark.parametrize("failure_at", ["account", "advisory", "commit"])
def test_failures_propagate_without_retry_or_success_receipt(failure_at):
    item = entry()
    failure = RuntimeError("injected lock-order checkpoint failure")
    steps = prefix(item)
    if failure_at == "account":
        steps = [Step(ACCOUNT_SQL, params=(ACCOUNT, ACCOUNT), error=failure)]
    elif failure_at == "advisory":
        steps = [steps[0], Step(ADVISORY_SQL, params=(advisory_key(identity(item)),), error=failure)]
    else:
        steps.append(Step(INSERT_SQL))
    connection = Connection(steps, commit_error=failure if failure_at == "commit" else None)
    with pytest.raises(RuntimeError) as caught:
        append(connection, item)
    assert caught.value is failure
    connection.done()
    assert connection.entered == 1 and len(connection.exits) == 1
    assert sum(sql == ACCOUNT_SQL for sql, _ in connection.operations) == 1
    if failure_at != "commit":
        assert connection.writes == []


def test_provider_guard_keeps_only_outer_provider_advisory_and_inner_append_commits_first(monkeypatch):
    events = []

    class Traced(Connection):
        def __init__(self, name, steps):
            super().__init__(steps)
            self.name = name

        def __enter__(self):
            events.append((self.name, "enter"))
            return super().__enter__()

        def __exit__(self, exc_type, exc, tb):
            result = super().__exit__(exc_type, exc, tb)
            events.append((self.name, "exit"))
            return result

    item = entry()
    provider_identity = "provider:" + identity(item)
    outer = Traced("provider", [Step(ADVISORY_SQL, params=(advisory_key(provider_identity),))])
    inner = Traced("append", [*prefix(item), Step(INSERT_SQL)])
    connections = iter((outer, inner))
    monkeypatch.setattr(PostgresListenHistoryAdapter, "_connect_to_database", lambda self: next(connections))
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": URL}
    with measured.measured_provider_guard(config, account_id=ACCOUNT, library_id=LIBRARY,
                                         device_id=DEVICE, session_id=SESSION):
        result = measured.append_measured(PostgresListenHistoryAdapter(config), item,
                                          account_id=ACCOUNT, library_id=LIBRARY)
        assert result == accepted(item) and inner.exits == [None] and outer.exits == []
        events.append(("provider", "submission_boundary"))
    outer.done()
    inner.done()
    assert outer.operations == [(ADVISORY_SQL, (advisory_key(provider_identity),))]
    assert_prefix(inner, item)
    assert events == [("provider", "enter"), ("append", "enter"), ("append", "exit"),
                      ("provider", "submission_boundary"), ("provider", "exit")]
    # This models the existing bridge's call ordering, without provider I/O.
