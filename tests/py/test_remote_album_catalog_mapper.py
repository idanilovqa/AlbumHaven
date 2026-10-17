"""Shared mapper/Goals delegation contracts with only scripted in-memory DB calls.

No service instance, connection, provider, migration, configuration or app setup.
These fakes check protocol and error mapping; actual PostgreSQL race/isolation
coverage belongs to the integration suite.
"""
from copy import deepcopy
from uuid import UUID

import pytest

from music_app.services import remote_album_catalog as catalog
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService


GROUP = "c9fdb94c-4975-4ed6-a96f-ef6d80bb7738"
CANDIDATE = "11111111-1111-4111-8111-111111111111"
EXISTING = "22222222-2222-4222-8222-222222222222"
UNRELATED = "33333333-3333-4333-8333-333333333333"
IDENTITY = ("musicbrainz", "release-group", GROUP)
SELECT = ("select catalog_ref from catalog.release_group_provider_identities "
          "where provider=%s and entity_kind=%s and external_id=%s")
INSERT_CATALOG = ("insert into catalog.release_groups(ref,title,artist_display,release_year) "
                  "values(%s,%s,%s,%s)")
INSERT_IDENTITY = ("insert into catalog.release_group_provider_identities "
                   "(provider,entity_kind,external_id,catalog_ref) values(%s,%s,%s,%s)")


class SQLFailure(RuntimeError):
    def __init__(self, state):
        super().__init__("scripted database failure")
        self.sqlstate = state


class Cursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class Savepoint:
    def __init__(self, connection):
        self.connection = connection
        self.snapshot = None

    def __enter__(self):
        connection = self.connection
        assert not connection.in_savepoint
        connection.in_savepoint = True
        self.snapshot = deepcopy(connection.rows)
        connection.events.append(("savepoint_begin",))
        return self

    def __exit__(self, error_type, error, traceback):
        connection = self.connection
        assert connection.in_savepoint
        connection.in_savepoint = False
        if error_type is not None:
            connection.rows = self.snapshot
            connection.events.append(("savepoint_rollback", error))
        else:
            connection.events.append(("savepoint_release",))
        return False


class Connection:
    """Accept only the mapper's three fixed SQL operations and one savepoint."""
    def __init__(self, reads, *, fail_at=None, failure=None):
        self.reads = list(reads)
        self.fail_at = fail_at
        self.failure = failure
        self.events = []
        self.in_savepoint = False
        # A preceding outer-transaction row must survive a losing savepoint.
        self.rows = {UNRELATED: ("Outer transaction row", "Unrelated artist", 1999)}

    def transaction(self):
        return Savepoint(self)

    def execute(self, sql, parameters):
        statement = " ".join(sql.split())
        self.events.append((statement, parameters))
        if statement == SELECT:
            assert parameters == IDENTITY
            assert not self.in_savepoint
            assert self.reads, "Unexpected repeat query/retry"
            result = self.reads.pop(0)
            if isinstance(result, BaseException):
                raise result
            return Cursor(result)
        assert self.in_savepoint, "Candidate writes must remain inside the nested transaction"
        if statement == INSERT_CATALOG:
            if self.fail_at == "catalog":
                raise self.failure
            candidate, title, artist, year = parameters
            assert candidate not in self.rows
            self.rows[candidate] = (title, artist, year)
            return Cursor()
        if statement == INSERT_IDENTITY:
            assert parameters[:3] == IDENTITY
            assert parameters[3] in self.rows
            if self.fail_at == "identity":
                raise self.failure
            return Cursor()
        raise AssertionError("Unexpected mapper SQL: " + statement)


def _evidence(**changes):
    return {"external_id": GROUP, "title": "Original Ω", "artist_display": "Original artist",
            "first_release_date": "2012-05-22", **changes}


def _fixed_uuid(monkeypatch):
    calls = []
    def generate():
        calls.append("uuid4")
        return UUID(CANDIDATE)
    monkeypatch.setattr(catalog, "uuid4", generate)
    return calls


MAPPERS = [catalog.map_release_group_catalog, PostgresListeningGoalsService._catalog]


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
def test_existing_identity_returns_canonical_catalog_without_display_or_candidate_changes(monkeypatch, mapper):
    def forbidden_uuid():
        raise AssertionError("An existing mapping must not allocate a candidate")
    monkeypatch.setattr(catalog, "uuid4", forbidden_uuid)
    connection = Connection([{"catalog_ref": UUID(EXISTING)}])
    before = deepcopy(connection.rows)
    # Existing identity does not need display fields and must not refresh them.
    assert mapper(connection, {"external_id": GROUP}) == EXISTING
    assert connection.events == [(SELECT, IDENTITY)]
    assert connection.rows == before and not connection.reads and not connection.in_savepoint


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
@pytest.mark.parametrize("date,year", [(None, None), ("", None), ("2012", 2012),
                                      ("2012-05", 2012), ("2012-05-22", 2012)])
def test_first_mapping_inserts_original_display_and_fixed_identity_in_one_savepoint(monkeypatch, mapper, date, year):
    calls = _fixed_uuid(monkeypatch)
    connection = Connection([None])
    evidence = _evidence(first_release_date=date, provider="ignored-browser-namespace",
                         entity_kind="ignored", account_id=41, local_album_id=12)
    before = deepcopy(evidence)
    assert mapper(connection, evidence) == CANDIDATE
    assert evidence == before
    assert connection.events == [(SELECT, IDENTITY), ("savepoint_begin",),
        (INSERT_CATALOG, (CANDIDATE, "Original Ω", "Original artist", year)),
        (INSERT_IDENTITY, (*IDENTITY, CANDIDATE)), ("savepoint_release",)]
    assert connection.rows[CANDIDATE] == ("Original Ω", "Original artist", year)
    assert connection.rows[UNRELATED] == ("Outer transaction row", "Unrelated artist", 1999)
    assert calls == ["uuid4"] and not connection.reads and not connection.in_savepoint


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
@pytest.mark.parametrize("fail_at", ["catalog", "identity"])
def test_unique_race_rolls_back_candidate_then_returns_winner_without_whole_command_retry(monkeypatch, mapper, fail_at):
    calls = _fixed_uuid(monkeypatch)
    failure = SQLFailure("23505")
    connection = Connection([None, {"catalog_ref": UUID(EXISTING)}], fail_at=fail_at, failure=failure)
    before = deepcopy(connection.rows)
    assert mapper(connection, _evidence()) == EXISTING
    assert connection.rows == before and CANDIDATE not in connection.rows
    expected = [(SELECT, IDENTITY), ("savepoint_begin",),
                (INSERT_CATALOG, (CANDIDATE, "Original Ω", "Original artist", 2012))]
    if fail_at == "identity":
        expected.append((INSERT_IDENTITY, (*IDENTITY, CANDIDATE)))
    assert connection.events == [*expected, ("savepoint_rollback", failure), (SELECT, IDENTITY)]
    assert calls == ["uuid4"] and not connection.reads and not connection.in_savepoint


def test_unique_race_without_visible_winner_has_narrow_shared_conflict_error(monkeypatch):
    calls = _fixed_uuid(monkeypatch)
    failure = SQLFailure("23505")
    connection = Connection([None, None], fail_at="identity", failure=failure)
    before = deepcopy(connection.rows)
    with pytest.raises(catalog.RemoteCatalogIdentityConflict, match="^identity_conflict$") as caught:
        catalog.map_release_group_catalog(connection, _evidence())
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert connection.events[-2:] == [("savepoint_rollback", failure), (SELECT, IDENTITY)]
    assert connection.rows == before and calls == ["uuid4"] and not connection.reads


def test_goals_maps_only_no_winner_conflict_to_unchanged_outer_error(monkeypatch):
    calls = _fixed_uuid(monkeypatch)
    failure = SQLFailure("23505")
    connection = Connection([None, None], fail_at="identity", failure=failure)
    before = deepcopy(connection.rows)
    with pytest.raises(GoalsError) as caught:
        PostgresListeningGoalsService._catalog(connection, _evidence())
    assert caught.value.code == "identity_conflict" and caught.value.status_code == 409
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert connection.events[-2:] == [("savepoint_rollback", failure), (SELECT, IDENTITY)]
    assert connection.rows == before and calls == ["uuid4"] and not connection.reads


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
@pytest.mark.parametrize("failure", [SQLFailure("23503"), SQLFailure("40001"),
                                     SQLFailure(None), RuntimeError("ordinary failure"),
                                     OSError("connection failure")])
@pytest.mark.parametrize("fail_at", ["catalog", "identity"])
def test_non_unique_failures_propagate_unchanged_after_savepoint_rollback(monkeypatch, mapper, failure, fail_at):
    calls = _fixed_uuid(monkeypatch)
    connection = Connection([None], fail_at=fail_at, failure=failure)
    before = deepcopy(connection.rows)
    with pytest.raises(type(failure)) as caught:
        mapper(connection, _evidence())
    assert caught.value is failure
    assert connection.events[-1] == ("savepoint_rollback", failure)
    assert sum(event[0] == SELECT for event in connection.events) == 1
    assert connection.rows == before and calls == ["uuid4"] and not connection.reads


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
def test_initial_identity_read_failure_propagates_without_savepoint_or_candidate(monkeypatch, mapper):
    calls = _fixed_uuid(monkeypatch)
    failure = OSError("identity lookup unavailable")
    connection = Connection([failure])
    with pytest.raises(OSError) as caught:
        mapper(connection, _evidence())
    assert caught.value is failure
    assert connection.events == [(SELECT, IDENTITY)] and calls == []


@pytest.mark.parametrize("mapper", MAPPERS, ids=["shared_mapper", "goals_delegate"])
def test_race_winner_lookup_failure_is_not_converted_to_identity_conflict(monkeypatch, mapper):
    _fixed_uuid(monkeypatch)
    duplicate = SQLFailure("23505")
    failure = OSError("winner lookup unavailable")
    connection = Connection([None, failure], fail_at="identity", failure=duplicate)
    with pytest.raises(OSError) as caught:
        mapper(connection, _evidence())
    assert caught.value is failure
    assert connection.events[-2:] == [("savepoint_rollback", duplicate), (SELECT, IDENTITY)]
    assert CANDIDATE not in connection.rows


def test_goals_delegates_the_exact_connection_and_evidence_to_the_shared_owner(monkeypatch):
    connection, evidence, seen = object(), _evidence(), []
    def shared(actual_connection, actual_evidence):
        seen.append((actual_connection, actual_evidence))
        assert actual_connection is connection and actual_evidence is evidence
        return EXISTING
    monkeypatch.setattr(catalog, "map_release_group_catalog", shared)
    assert PostgresListeningGoalsService._catalog(connection, evidence) == EXISTING
    assert seen == [(connection, evidence)]


def test_goals_does_not_catch_an_unrelated_shared_runtime_failure(monkeypatch):
    failure = RuntimeError("unexpected mapper failure")
    def shared(connection, evidence):
        raise failure
    monkeypatch.setattr(catalog, "map_release_group_catalog", shared)
    with pytest.raises(RuntimeError) as caught:
        PostgresListeningGoalsService._catalog(object(), _evidence())
    assert caught.value is failure
