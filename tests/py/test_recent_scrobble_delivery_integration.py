"""Recent delivery integration contracts. Normal product imports; no copied owners.

These tests are authored source only in this packet. Repository tests keep the
real read/_validated_snapshot/_create/_page lifecycle, with in-memory database
transport and explicit authority/revision boundary doubles. They do not prove
PostgreSQL isolation, SQL correctness, or authorization enforcement by a DB.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from music_app.services import home_activity as activity
from music_app.services import home_activity_postgres as storage
from music_app.services import lastfm
from music_app.services.allowed_actions import AllowedActions

NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
SECRET = b"independent-recent-row-secret-001"
MEASURED = "rendered_local_listen_session"
LEGACY = "runtime_listen_history_adapter"
BACKFILL = "phase_6_json_file_backfill"
SCOPE = activity.ActivityScope(71, 83, 97)
WINDOW = activity.ActivityWindow(NOW - timedelta(days=7), NOW, "UTC", "Last week", "Capture range")
PRIVATE = "private-provider-detail-must-not-escape"


def grant(_kind, _reference):
    return AllowedActions(("library.browse.read", "library.social.history.read"))


def row(number=1, *, source=MEASURED, payload=None, **changes):
    facts = {
        "title": "Occurrence", "artist": "Artist", "album": "Album",
        "total_listened_seconds": 90, "max_contiguous_seconds": 40,
        "scrobbled": False, "scrobble_eligible": True,
        "scrobble_submission_state": "not_sent", "scrobble_retryable": True,
        "source_provenance": {"kind": "local_playback", "provider": "album_haven"},
        "provider_error": PRIVATE, "username": PRIVATE, "path": "/private/test.flac",
    }
    if payload is not None:
        facts.update(payload)
    result = {
        "id": number, "account_id": 71, "library_id": 97,
        "track_id": 101, "track_key": "track-one", "album_id": 201,
        "played_at": NOW - timedelta(minutes=10),
        "source_family": source,
        "measurement_version": "rendered-pcm-v1" if source == MEASURED else None,
        "finalized": True, "measured_listened_seconds": 90,
        "metadata": {"source_payload": facts}, "scrobble_status": "pending",
        "resolved_track_id": 101, "resolved_track_title": "Track",
        "resolved_track_artist_id": 301, "resolved_track_artist_name": "Artist",
        "resolved_album_id": 201, "resolved_album_title": "Album",
        "resolved_album_artist_id": 302, "resolved_album_artist_name": "Album artist",
        "resolved_duration_seconds": 240, "active_file": True,
    }
    result.update(changes)
    return result


def project(rows, *, scope=SCOPE, kind="listens", state="connected", policy=grant, **options):
    return activity.build_activity_projection(
        rows, scope=scope, kind=kind, window=WINDOW,
        allowed_actions_for_resource=policy, row_key_secret=SECRET,
        scrobble_connection_state=state, **options,
    )


def without_delivery(rows):
    return [{key: value for key, value in item.items() if key != "scrobble_delivery"} for item in rows]


def test_occurrence_delivery_is_closed_preserves_multiplicity_identity_and_order():
    inputs = [row(1), row(3, source=BACKFILL), row(2, source=LEGACY)]
    before = deepcopy(inputs)
    connected = project(inputs)
    disconnected = project(inputs, state="disconnected")
    assert inputs == before
    assert connected.total_listens == disconnected.total_listens == 3
    assert [item["id"] for item in connected.rows] == [
        "activity_" + hmac.new(SECRET, f"listen:event:{number}".encode(), hashlib.sha256).hexdigest()
        for number in (3, 2, 1)
    ]
    assert [item["listen_count"] for item in connected.rows] == [1, 1, 1]
    assert without_delivery(connected.rows) == without_delivery(disconnected.rows)
    assert connected.events == disconnected.events
    assert connected.resources == disconnected.resources
    assert list(connected.groups) == list(disconnected.groups)
    assert [event["event_id"] for event in connected.events] == [1, 2, 3]
    assert connected.events[0]["resources"] == [
        ("listen_history", 1), ("track", 101), ("album", 201), ("artist", 301), ("artist", 302),
    ]
    assert all(item["scrobble_delivery"] == {
        "state": "not_sent", "next_step": "retry_check", "show_status": True,
    } for item in connected.rows)
    assert all(item["scrobble_delivery"] == {
        "state": "not_sent", "next_step": "none", "show_status": False,
    } for item in disconnected.rows)
    serialized = json.dumps({"rows": connected.rows, "coverage": connected.coverage})
    assert PRIVATE not in serialized and "/private/test.flac" not in serialized
    assert "source_payload" not in serialized and "account_id" not in serialized
    assert "can_send" not in serialized


@pytest.mark.parametrize("changes", [
    {"account_id": 72}, {"library_id": 98}, {"identity_conflict": True},
    {"source_family": "foobar_history", "measurement_version": None},
    {"measurement_version": "future-version"},
])
def test_unadmitted_rows_never_reach_delivery_classifier(monkeypatch, changes):
    classifier = Mock(side_effect=AssertionError("Unadmitted occurrence reached classifier"))
    monkeypatch.setattr(activity, "build_recent_scrobble_delivery", classifier)
    result = project([row(**changes)])
    assert result.rows == [] and result.total_listens == 0
    classifier.assert_not_called()


@pytest.mark.parametrize("denied", [
    ("listen_history", 1), ("track", 101), ("album", 201), ("artist", 301), ("artist", 302),
])
def test_every_resource_denial_precedes_delivery_classification(monkeypatch, denied):
    classifier = Mock(side_effect=AssertionError("Denied occurrence reached classifier"))
    monkeypatch.setattr(activity, "build_recent_scrobble_delivery", classifier)
    result = project([row()], policy=lambda kind, ref: AllowedActions(()) if (kind, ref) == denied else grant(kind, ref))
    assert result.rows == [] and result.events == [] and result.total_listens == 0
    classifier.assert_not_called()


def test_classifier_receives_trusted_row_provenance_after_all_resource_grants(monkeypatch):
    original = activity.build_recent_scrobble_delivery
    calls = []

    def policy(kind, ref):
        calls.append((kind, ref))
        return grant(kind, ref)

    def observed(payload, **kwargs):
        assert calls == [("listen_history", 1), ("track", 101), ("album", 201), ("artist", 301), ("artist", 302)]
        assert kwargs == {"source_family": MEASURED, "measurement_version": "rendered-pcm-v1",
                          "connection_state": "connected"}
        return original(payload, **kwargs)

    monkeypatch.setattr(activity, "build_recent_scrobble_delivery", observed)
    item = row(payload={"source_family": "foobar_history", "measurement_version": "forged",
                        "scrobbled": True, "scrobble_submission_state": "accepted"})
    assert project([item], policy=policy).rows[0]["scrobble_delivery"]["state"] == "accepted"


def test_payload_provenance_is_not_repaired_by_normalizer():
    item = row(payload={"source_provenance": {"kind": "lastfm_import", "provider": "lastfm"},
                        "scrobbled": True})
    assert project([item]).rows[0]["scrobble_delivery"] == {
        "state": "not_eligible", "next_step": "none", "show_status": False,
    }


@pytest.mark.parametrize("metadata", [None, [], {}, {"source_payload": None}, {"source_payload": []}])
def test_trusted_positive_column_preserves_acceptance_with_missing_metadata(metadata):
    result = project([row(metadata=metadata, scrobble_status="scrobbled")])
    assert result.total_listens == 1
    assert result.rows[0]["scrobble_delivery"] == {
        "state": "accepted", "next_step": "none", "show_status": True,
    }


@pytest.mark.parametrize("audience,kind,viewer_side", [
    ("own", "tracks", False), ("own", "albums", False), ("own", "artists", False),
    ("friend", "listens", False), ("friend", "tracks", False),
    ("comparison", "tracks", False), ("comparison", "tracks", True),
    ("comparison", "albums", True), ("comparison", "artists", False),
])
def test_grouped_and_social_projection_ignore_delivery_state_entirely(audience, kind, viewer_side):
    scope = SCOPE if audience == "own" else activity.ActivityScope(71, 83, 97, 72, audience)
    owner = 71 if viewer_side else scope.source_account_id
    options = {"source_account_id": owner}
    rows = [row(account_id=owner)]
    first = project(rows, scope=scope, kind=kind, state="connected", **options)
    second = project(rows, scope=scope, kind=kind, state={"invalid": "ignored"}, **options)
    assert first == second
    assert "scrobble_delivery" not in first.coverage
    assert all("scrobble_delivery" not in item for item in first.rows)


@pytest.mark.parametrize("state", [None, True, {}, "CONNECTED", ""])
def test_own_occurrences_require_closed_connection_enum(state):
    with pytest.raises(activity.HomeActivityError):
        project([row()], state=state)


def test_safe_capture_metadata_and_row_facts_both_change_fingerprint():
    connected = project([row(payload={"scrobbled": True})])
    unavailable = project([row(payload={"scrobbled": True})], state="unavailable")
    assert connected.rows == unavailable.rows
    assert connected.fingerprint != unavailable.fingerprint
    assert connected.coverage["scrobble_delivery"] == {
        "connection_state": "connected", "captured_at": NOW.isoformat(), "semantics": "snapshot",
    }
    changed = project([row(payload={"scrobble_submission_state": "uncertain"})])
    assert changed.fingerprint != connected.fingerprint
    assert without_delivery(changed.rows) == without_delivery(connected.rows)
    assert connected.coverage["complete_for_requested_period"] is False


@pytest.mark.parametrize("status,expected", [
    ({"connected": False}, "disconnected"),
    ({"connected": True, "api_configured": True, "username": PRIVATE}, "connected"),
    ({"connected": True, "api_configured": False}, "unavailable"),
    ({"connected": 1, "api_configured": True}, "unavailable"),
    ({"connected": True, "api_configured": 1}, "unavailable"),
    ({}, "unavailable"), (None, "unavailable"), ([], "unavailable"),
])
def test_status_adapter_uses_exact_account_and_safe_boolean_mapping(monkeypatch, status, expected):
    config = {"test_marker": "not-a-real-config"}
    provider = Mock(return_value=status)
    monkeypatch.setattr(lastfm, "build_lastfm_status", provider)
    assert activity._recent_scrobble_connection_state(config, account_id=71) == expected
    provider.assert_called_once_with(config, account_id=71)


def test_status_failure_is_unavailable_not_disconnected(monkeypatch):
    monkeypatch.setattr(lastfm, "build_lastfm_status", Mock(side_effect=RuntimeError(PRIVATE)))
    assert activity._recent_scrobble_connection_state({}, account_id=71) == "unavailable"


def actor(**changes):
    values = dict(is_authenticated=True, account_id=71, session_id=83, current_library_id=97,
                  library_relationships=(SimpleNamespace(library_id=97),))
    values.update(changes)
    return SimpleNamespace(**values)


def read(repository, *, query=None, now=NOW, **options):
    return activity.read_home_activity(
        {}, actor=actor(), query=query or activity.ActivityQuery(kind="listens"),
        allowed_actions_for_resource=grant, now=now, repository=repository, **options,
    )


class Conflict(Exception):
    sqlstate = "40001"


class Result:
    def __init__(self, *, one=None, many=()):
        self.one, self.many = one, many

    def fetchone(self):
        return self.one

    def fetchall(self):
        return list(self.many)


class ReceiptConnection:
    """Transport double only; actual repository methods consume its canned rows."""
    def __init__(self, *, conflict=False):
        self.conflict = conflict
        self.chunks = [[row(1)], [row(2)], []]
        self.snapshot = None
        self.payloads = []
        self.operations = []
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        return False

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.operations.append("rollback")

    def close(self):
        self.operations.append("close")

    def execute(self, sql, parameters=()):
        self.operations.append(sql)
        if sql == storage._LEDGER_READ:
            return Result(many=self.chunks.pop(0))
        if "insert into app.activity_snapshots(" in sql:
            self.snapshot = {
                "id": 401, "row_secret": parameters[1], "ledger_revision": 5, "inventory_revision": 6,
                "authority_fingerprint": "granted", "audience": "own", "kind": "listens",
                "expires_at": NOW + timedelta(minutes=30), "period_label": "Last week",
                "range_label": "Capture range", "total_rows": 0, "total_listens": 0, "coverage": {},
            }
            return Result(one=self.snapshot)
        if "update app.activity_snapshots set ready=true" in sql:
            if self.conflict:
                raise Conflict("Synthetic serialization conflict after both ledger chunks")
            self.snapshot.update(total_listens=parameters[0], total_rows=len(self.payloads),
                                 coverage=deepcopy(parameters[2].obj))
            return Result(one=self.snapshot)
        if "select * from app.activity_snapshots" in sql:
            return Result(one=self.snapshot)
        if "select payload from app.activity_snapshot_rows" in sql:
            ordered = sorted(self.payloads, key=lambda item: item[3], reverse=True)
            return Result(many=[{"payload": deepcopy(item[6].obj)} for item in ordered])
        if any(marker in sql for marker in (
            "pg_advisory_lock(", "pg_advisory_unlock(", "set transaction isolation level",
            "delete from app.activity_snapshots", "insert into app.activity_source_revisions",
            "with numbered as", "update app.activity_snapshots set expires_at",
        )):
            return Result()
        raise AssertionError(f"Unexpected database boundary statement: {sql}")

    def cursor(self):
        return self

    def executemany(self, sql, parameters):
        if "insert into app.activity_snapshot_rows(" in sql:
            self.payloads.extend(parameters)
        else:
            assert "insert into app.activity_snapshot_events(" in sql


def repository_harness(monkeypatch, connections, *, denied=False):
    """Keep real read, validation, create, storage, and page methods unpatched."""
    provider = Mock(return_value={"connected": True, "api_configured": True})
    timezone_reader = Mock(return_value="UTC")
    trace = []

    def authority(_connection, _scope, _now):
        trace.append("authority")
        if denied:
            raise activity.HomeActivityError("Denied", 403, "activity_denied")
        return "granted"

    def status(config, *, account_id):
        assert trace and trace[0] == "authority"
        return provider(config, account_id=account_id)

    monkeypatch.setattr(lastfm, "build_lastfm_status", status)
    monkeypatch.setattr(storage, "get_lastfm_user_timezone", timezone_reader)
    cls = storage.HomeActivityPostgresRepository
    monkeypatch.setattr(cls, "_authority", staticmethod(authority))
    monkeypatch.setattr(cls, "_revisions", staticmethod(lambda *_args, **_kwargs: (5, 6)))
    monkeypatch.setattr(cls, "_validate_policy", staticmethod(lambda *_args: None))
    monkeypatch.setattr(cls, "_lock_authority", staticmethod(lambda *_args: NOW))
    remaining = iter(connections)
    repository = cls({"ALBUM_HAVEN_APP_DATABASE_URL": "unit-transport-no-network"},
                     connect=lambda _url: next(remaining))
    return repository, provider, timezone_reader


@pytest.mark.parametrize("failure", [False, True])
def test_real_snapshot_empty_coverage_and_multiple_chunks_share_one_status(monkeypatch, failure):
    connection = ReceiptConnection()
    repository, provider, timezone_reader = repository_harness(monkeypatch, [connection])
    if failure:
        provider.side_effect = RuntimeError(PRIVATE)
    result = read(repository)
    provider.assert_called_once_with({}, account_id=71)
    # This pre-existing settings read remains separate from the new status call.
    timezone_reader.assert_called_once_with(repository.config, account_id=71)
    assert result["data"]["total_listens"] == 2
    assert len(result["data"]["rows"]) == 2
    assert len([sql for sql in connection.operations if sql == storage._LEDGER_READ]) == 3
    assert result["data"]["coverage"]["scrobble_delivery"]["connection_state"] == (
        "unavailable" if failure else "connected")
    assert all(item["scrobble_delivery"]["next_step"] == (
        "check_connection" if failure else "retry_check") for item in result["data"]["rows"])


def test_real_repository_serialization_retry_refreshes_for_new_secret(monkeypatch):
    first, second = ReceiptConnection(conflict=True), ReceiptConnection()
    repository, provider, timezone_reader = repository_harness(monkeypatch, [first, second])
    provider.side_effect = [{"connected": True, "api_configured": True}, {"connected": False}]
    result = read(repository)
    assert provider.call_count == timezone_reader.call_count == 2
    assert all(call.kwargs == {"account_id": 71} for call in provider.call_args_list)
    assert first.snapshot["row_secret"] is not second.snapshot["row_secret"]
    assert "rollback" in first.operations
    assert result["data"]["total_listens"] == 2
    assert result["data"]["coverage"]["scrobble_delivery"]["connection_state"] == "disconnected"
    assert all(not item["scrobble_delivery"]["show_status"] for item in result["data"]["rows"])


def test_existing_receipt_keeps_aged_state_without_status_or_timezone_refresh(monkeypatch):
    connection = ReceiptConnection()
    repository, provider, timezone_reader = repository_harness(monkeypatch, [connection, connection])
    captured = read(repository)
    provider.reset_mock()
    timezone_reader.reset_mock()
    provider.side_effect = AssertionError("Existing receipt must not refresh connection state")
    paged = read(repository, query=activity.ActivityQuery(
        kind="listens", snapshot_ref=captured["data"]["snapshot_ref"]), now=NOW + timedelta(minutes=5))
    assert paged == captured
    provider.assert_not_called()
    timezone_reader.assert_not_called()
    assert paged["data"]["coverage"]["scrobble_delivery"]["captured_at"] == NOW.isoformat()


def test_repository_authority_denial_never_reads_status(monkeypatch):
    repository, provider, timezone_reader = repository_harness(monkeypatch, [ReceiptConnection()], denied=True)
    with pytest.raises(activity.HomeActivityError) as caught:
        read(repository)
    assert caught.value.code == "activity_denied"
    provider.assert_not_called()
    timezone_reader.assert_not_called()


@pytest.mark.parametrize("kind,subject,comparison", [
    ("tracks", None, False), ("albums", None, False), ("artists", None, False),
    ("listens", 72, False), ("tracks", 72, True),
])
def test_unrelated_callback_never_reads_status(monkeypatch, kind, subject, comparison):
    provider = Mock(side_effect=AssertionError("Out-of-scope status read"))
    monkeypatch.setattr(lastfm, "build_lastfm_status", provider)

    class CallbackProbe:
        # Callback-only seam, not a claim about actual DB authority or persistence.
        def read(self, *, scope, query, now, build_projection):
            assert provider.call_count == 0
            owners = [scope.account_id, scope.source_account_id] if comparison else [scope.source_account_id]
            outputs = [build_projection([], WINDOW, SECRET)]
            outputs += [build_projection([row(account_id=owner)], WINDOW, SECRET, owner) for owner in owners]
            return outputs

    query = (activity.ComparisonQuery if comparison else activity.ActivityQuery)(kind=kind)
    projections = read(CallbackProbe(), query=query, subject_account_id=subject, comparison=comparison)
    provider.assert_not_called()
    for projection in projections:
        assert "scrobble_delivery" not in projection.coverage
        assert all("scrobble_delivery" not in item for item in projection.rows)


def test_callback_construction_and_unauthenticated_request_do_not_read_status(monkeypatch):
    provider = Mock(side_effect=AssertionError("Premature status read"))
    monkeypatch.setattr(lastfm, "build_lastfm_status", provider)
    repository = Mock()
    repository.read.return_value = "no projection invoked"
    assert read(repository) == "no projection invoked"
    with pytest.raises(activity.HomeActivityError):
        activity.read_home_activity({}, actor=actor(is_authenticated=False),
            query=activity.ActivityQuery(kind="listens"), allowed_actions_for_resource=grant,
            repository=repository, now=NOW)
    assert repository.read.call_count == 1
    provider.assert_not_called()


def test_direct_projection_default_remains_unknown_connection():
    result = activity.build_activity_projection(
        [row()], scope=SCOPE, kind="listens", window=WINDOW,
        allowed_actions_for_resource=grant, row_key_secret=SECRET,
    )
    assert result.coverage["scrobble_delivery"]["connection_state"] == "unknown"
    assert result.rows[0]["scrobble_delivery"] == {
        "state": "not_sent", "next_step": "check_connection", "show_status": True,
    }



@pytest.mark.parametrize("submission", [None, "not_sent", "attempting", "sent", "uncertain", "accepted"])
@pytest.mark.parametrize("source", [MEASURED, LEGACY, BACKFILL])
def test_positive_trusted_column_dominates_conflicting_retry_facts(submission, source):
    item = row(source=source, scrobble_status="scrobbled", payload={
        "scrobbled": False, "scrobble_submission_state": submission,
        "scrobble_eligible": True, "scrobble_retryable": True,
    })
    before = deepcopy(item)
    result = project([item])
    assert result.rows[0]["scrobble_delivery"] == {
        "state": "accepted", "next_step": "none", "show_status": True,
    }
    assert item == before


@pytest.mark.parametrize("status", [None, "pending", "failed", "accepted", True, 1, "SCROBBLED"])
def test_nonpositive_column_never_manufactures_known_unsent(status):
    item = row(scrobble_status=status, payload={"scrobble_submission_state": None})
    assert project([item]).rows[0]["scrobble_delivery"] == {
        "state": "unknown", "next_step": "none", "show_status": True,
    }


@pytest.mark.parametrize("provenance", [None, [], {"kind": "lastfm_import", "provider": "lastfm"},
                                      {"kind": "local_playback", "provider": "foobar"}])
def test_positive_column_does_not_repair_disallowed_provenance(provenance):
    item = row(scrobble_status="scrobbled", payload={"source_provenance": provenance})
    assert project([item]).rows[0]["scrobble_delivery"] == {
        "state": "not_eligible", "next_step": "none", "show_status": False,
    }


def test_positive_column_change_changes_fresh_projection_fingerprint():
    item = row(scrobble_status="pending")
    unsent = project([item])
    item["scrobble_status"] = "scrobbled"
    accepted = project([item])
    assert unsent.rows[0]["scrobble_delivery"]["next_step"] == "retry_check"
    assert accepted.rows[0]["scrobble_delivery"]["next_step"] == "none"
    assert accepted.fingerprint != unsent.fingerprint
    assert accepted.events == unsent.events
    assert without_delivery(accepted.rows) == without_delivery(unsent.rows)


def test_real_home_ledger_query_projects_only_existing_delivery_column():
    # Source contract, not SQL execution or database-schema acceptance.
    assert "h.metadata, h.scrobble_status," in storage._LEDGER_READ
    assert "from integration.listen_history h" in storage._LEDGER_READ
