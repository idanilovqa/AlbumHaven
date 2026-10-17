"""Synthetic adapter contracts. These do not prove PostgreSQL concurrency or grants."""
from dataclasses import asdict, FrozenInstanceError, replace
from datetime import datetime, timedelta, timezone
import re

import pytest

from music_app.services.popularity_snapshots import PopularityObservation
from music_app.services.popularity_observations_postgres import put_observation, read_observations

UTC = timezone.utc
NOW = datetime(2026, 10, 12, 5, tzinfo=UTC)
FIELDS = tuple(PopularityObservation.__dataclass_fields__)


def observation(**changes):
    values = dict(provider="lastfm", metric="overall_scrobbles", source_entity_id="recording:A",
                  source_revision="rev:9", observed_at=NOW, imported_at=NOW + timedelta(hours=1),
                  count=100, attribution_state="resolved")
    values.update(changes)
    return PopularityObservation(**values)


def key(value):
    return value.provider, value.metric, value.source_entity_id


class Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows[:]


class DatabaseFailure(Exception):
    pass


class Connection:
    """Narrow SQL seam, not a SQL engine, transaction manager or lock simulator."""
    autocommit = False

    def __init__(self, *accepted):
        self.slots = {}
        self.history = {}
        self.calls = []
        self.locked = set()
        self.after_lock = None
        self.fail_at = None
        self.failure = DatabaseFailure("database failure sentinel")
        self.batch_rows = None
        for value in accepted:
            self.seed(value)

    def seed(self, value):
        self.history[(*key(value), value.source_revision)] = asdict(value)
        self.slots[key(value)] = value.source_revision

    def commit(self):
        pytest.fail("The caller owns commit")

    def rollback(self):
        pytest.fail("The caller owns rollback")

    def __enter__(self):
        pytest.fail("The adapter must not own a connection context")

    def __exit__(self, *args):
        pytest.fail("The adapter must not own a connection context")

    def execute(self, sql, params=()):
        sql = " ".join(str(sql).lower().split())
        params = tuple(params)
        assert ";" not in sql.rstrip(";"), "No multiple-statement snapshot shortcuts"
        self.calls.append((sql, params))
        if self.fail_at == len(self.calls):
            raise self.failure
        if sql.startswith("insert into catalog.popularity_source_slots"):
            assert "on conflict" in sql and "do nothing" in sql
            assert "do update" not in sql
            assert len(params) == 3
            self.slots.setdefault(params, None)
            return Rows()
        if "for update" in sql:
            assert sql.startswith("select ") and "catalog.popularity_source_slots" in sql
            assert "catalog.popularity_source_observations" not in sql
            assert len(params) == 3 and params in self.slots
            for column in ("provider", "metric", "source_entity_id"):
                assert re.search(rf"\b{column}\s*=\s*%s", sql)
            if self.after_lock:
                callback, self.after_lock = self.after_lock, None
                callback(self)
            self.locked.add(params)
            return Rows([dict(zip(("provider", "metric", "source_entity_id"), params),
                              current_revision=self.slots[params])])
        if sql.startswith("insert into catalog.popularity_source_observations"):
            assert "on conflict" not in sql, "Accepted history is immutable"
            assert len(params) == 8
            row = dict(zip(FIELDS, params))
            source = params[:3]
            identity = params[:4]
            assert source in self.locked and identity not in self.history
            self.history[identity] = row
            return Rows([row])
        if sql.startswith("update catalog.popularity_source_slots"):
            assert len(params) == 4
            revision, *source = params
            source = tuple(source)
            assert source in self.locked
            assert (*source, revision) in self.history, "History must precede pointer"
            assert re.search(r"set current_revision\s*=\s*%s", sql)
            for column in ("provider", "metric", "source_entity_id"):
                assert re.search(rf"\b{column}\s*=\s*%s", sql)
            self.slots[source] = revision
            return Rows()
        if (sql.startswith("select ") or sql.startswith("with ")) and "unnest" in sql:
            assert "for update" not in sql
            assert "catalog.popularity_source_slots" in sql
            assert "catalog.popularity_source_observations" in sql
            assert "current_revision" in sql and "source_revision" in sql
            assert len(params) == 3 and len({len(array) for array in params}) == 1
            requested = list(zip(*params))
            assert len(requested) == len(set(requested)), "Deduplicate before SQL"
            if self.batch_rows is not None:
                return Rows(self.batch_rows)
            return Rows(self.history[(*source, self.slots[source])]
                        for source in requested if self.slots.get(source) is not None)
        if sql.startswith("select ") and "catalog.popularity_source_observations" in sql:
            source = params[:3]
            assert source in self.locked, "Read state only after the slot lock returns"
            assert len(params) in (4, 5)
            for column in ("provider", "metric", "source_entity_id"):
                assert re.search(rf"\b{column}\s*=\s*%s", sql)
            return Rows(row for identity, row in self.history.items()
                        if identity[:3] == source and identity[3] in params[3:])
        pytest.fail(f"Unexpected SQL in bounded adapter seam: {sql}")


def state(connection):
    return dict(connection.slots), {identity: dict(row) for identity, row in connection.history.items()}


def test_first_observation_creates_history_before_pointer_without_owning_transaction():
    connection = Connection()
    incoming = observation()
    assert put_observation(connection, incoming) == ("accepted", incoming)
    assert connection.slots == {key(incoming): incoming.source_revision}
    assert connection.history == {(*key(incoming), incoming.source_revision): asdict(incoming)}
    sql = [query for query, _ in connection.calls]
    assert sql[0].startswith("insert into catalog.popularity_source_slots")
    assert "for update" in sql[1]
    assert sql[-2].startswith("insert into catalog.popularity_source_observations")
    assert sql[-1].startswith("update catalog.popularity_source_slots")


@pytest.mark.parametrize("count", [99, 0, 2**53 - 1])
def test_newer_observation_accepts_decreases_zero_and_maximum(count):
    old = observation(source_revision="zzz")
    incoming = observation(source_revision="000", observed_at=NOW + timedelta(minutes=1), count=count)
    connection = Connection(old)
    assert put_observation(connection, incoming) == ("accepted", incoming)
    assert len(connection.history) == 2
    assert connection.history[(*key(old), old.source_revision)] == asdict(old)


@pytest.mark.parametrize("historical", [False, True])
def test_exact_replay_retains_original_import_time_and_never_rewinds(historical):
    old = observation()
    current = observation(source_revision="next", observed_at=NOW + timedelta(minutes=2), count=4)
    connection = Connection(old, current) if historical else Connection(old)
    before = state(connection)
    incoming = replace(old, imported_at=NOW + timedelta(days=9))
    assert put_observation(connection, incoming) == ("idempotent", current if historical else old)
    assert state(connection) == before
    assert not any(sql.startswith("insert into catalog.popularity_source_observations") or sql.startswith("update ")
                   for sql, _ in connection.calls)


@pytest.mark.parametrize("historical", [False, True])
@pytest.mark.parametrize("change", [dict(count=101), dict(observed_at=NOW + timedelta(minutes=9)),
                                    dict(attribution_state="ambiguous")])
def test_mutation_of_any_accepted_revision_conflicts(historical, change):
    old = observation()
    current = observation(source_revision="next", observed_at=NOW + timedelta(minutes=2))
    connection = Connection(old, current) if historical else Connection(old)
    before = state(connection)
    assert put_observation(connection, replace(old, **change)) == ("conflict", current if historical else old)
    assert state(connection) == before


@pytest.mark.parametrize("delta,status", [(-1, "stale"), (0, "conflict")])
def test_unseen_old_or_equal_time_revision_never_enters_history(delta, status):
    current = observation()
    connection = Connection(current)
    before = state(connection)
    incoming = observation(source_revision="unseen", observed_at=NOW + timedelta(seconds=delta),
                           imported_at=NOW + timedelta(days=10))
    assert put_observation(connection, incoming) == (status, current)
    assert state(connection) == before


@pytest.mark.parametrize("attribution,count", [("missing", None), ("ambiguous", None), ("ambiguous", 0), ("ambiguous", 7)])
def test_newer_unknown_or_ambiguous_values_are_preserved(attribution, count):
    connection = Connection(observation())
    incoming = observation(source_revision="unavailable", observed_at=NOW + timedelta(minutes=1),
                           attribution_state=attribution, count=count)
    assert put_observation(connection, incoming) == ("accepted", incoming)
    assert read_observations(connection, [key(incoming)]) == {key(incoming): incoming}


@pytest.mark.parametrize("empty_slot", [False, True])
def test_post_lock_state_controls_reconciliation_after_synthetic_wait(empty_slot):
    old = observation()
    connection = Connection() if empty_slot else Connection(old)
    winner = observation(source_revision="winner", observed_at=NOW + timedelta(minutes=10), count=9)
    connection.after_lock = lambda db: db.seed(winner)
    incoming = observation(source_revision="loser", observed_at=NOW + timedelta(minutes=5), count=20)
    assert put_observation(connection, incoming) == ("stale", winner)
    assert (*key(incoming), incoming.source_revision) not in connection.history
    assert connection.slots[key(incoming)] == "winner"


@pytest.mark.parametrize("fail_at", [1, 2, 3, 4, 5])
def test_database_failures_propagate_without_retry_commit_or_rollback(fail_at):
    connection = Connection()
    connection.fail_at = fail_at
    with pytest.raises(DatabaseFailure) as caught:
        put_observation(connection, observation())
    assert caught.value is connection.failure
    assert len(connection.calls) == fail_at


INVALID_CHANGES = [dict(provider="other"), dict(metric="plays"), dict(count=True), dict(count=-1),
                   dict(count=2**53), dict(count=1.0), dict(count="1"), dict(count=None),
                   dict(attribution_state="missing"), dict(attribution_state="error"),
                   dict(observed_at=NOW.replace(tzinfo=None)), dict(imported_at=NOW - timedelta(seconds=1)),
                   dict(observed_at=NOW.astimezone(timezone(timedelta(hours=1))))]
@pytest.mark.parametrize("changes", INVALID_CHANGES)
def test_invalid_observations_fail_before_sql(changes):
    connection = Connection()
    with pytest.raises(ValueError):
        put_observation(connection, observation(**changes))
    assert connection.calls == []


@pytest.mark.parametrize("field", ["source_entity_id", "source_revision"])
@pytest.mark.parametrize("value", ["", " \t\n", "\u2003", "x" * 513, "é" * 257, "a\x00b", "\ud800", None, 123])
def test_invalid_identity_and_utf8_bounds_fail_before_sql(field, value):
    connection = Connection()
    with pytest.raises(ValueError):
        put_observation(connection, observation(**{field: value}))
    assert connection.calls == []


@pytest.mark.parametrize("value", ["x", "é" * 256, " x ", "REV:000", "Rev:000", "e\u0301"])
def test_exact_nonblank_identity_and_revision_are_not_normalized(value):
    connection = Connection()
    incoming = observation(source_entity_id=value, source_revision=value)
    assert put_observation(connection, incoming) == ("accepted", incoming)
    assert read_observations(connection, [key(incoming)]) == {key(incoming): incoming}


@pytest.mark.parametrize("operation", ["put", "read"])
def test_autocommit_is_rejected_before_sql(operation):
    connection = Connection()
    connection.autocommit = True
    with pytest.raises(ValueError):
        put_observation(connection, observation()) if operation == "put" else read_observations(connection, [key(observation())])
    assert connection.calls == []
    assert connection.autocommit is True


def test_batch_empty_input_never_queries():
    connection = Connection()
    assert read_observations(connection, iter(())) == {}
    assert connection.calls == []


def test_batch_deduplicates_omits_absent_and_empty_slots_and_preserves_exact_source():
    first = observation(source_entity_id=" A ")
    second = observation(source_entity_id="a", count=0)
    connection = Connection(first, second)
    empty = ("lastfm", "overall_scrobbles", "empty")
    absent = ("lastfm", "overall_scrobbles", "absent")
    connection.slots[empty] = None
    result = read_observations(connection, iter([key(first), absent, key(second), key(first), empty]))
    assert result == {key(first): first, key(second): second}
    assert len(connection.calls) == 1
    with pytest.raises(FrozenInstanceError):
        result[key(first)].count = 10


@pytest.mark.parametrize("bad", [None, [], ["lastfm", "overall_scrobbles", "a"], ("lastfm", "overall_scrobbles"),
    ("lastfm", "overall_scrobbles", "a", "extra"), ("other", "overall_scrobbles", "a"),
    ("lastfm", "other", "a"), ("lastfm", "overall_scrobbles", None),
    ("lastfm", "overall_scrobbles", "\u2003"), ("lastfm", "overall_scrobbles", "x" * 513),
    ("lastfm", "overall_scrobbles", "é" * 257), ("lastfm", "overall_scrobbles", "\x00"),
    ("lastfm", "overall_scrobbles", "\ud800")])
def test_all_batch_keys_validate_before_any_sql(bad):
    connection = Connection()
    with pytest.raises(ValueError):
        read_observations(connection, [key(observation()), bad])
    assert connection.calls == []


@pytest.mark.parametrize("duplicate", [False, True])
def test_batch_limit_counts_supplied_keys_and_stops_at_1001(duplicate):
    connection = Connection()
    consumed = []
    def keys():
        for index in range(1002):
            consumed.append(index)
            yield ("lastfm", "overall_scrobbles", "same" if duplicate else str(index))
    with pytest.raises(ValueError):
        read_observations(connection, keys())
    assert len(consumed) == 1001
    assert connection.calls == []


def test_maximum_batch_is_one_statement_not_chunks_or_n_plus_one():
    accepted = [observation(source_entity_id=str(index), count=index) for index in range(1000)]
    connection = Connection(*accepted)
    assert read_observations(connection, map(key, accepted)) == {key(value): value for value in accepted}
    assert len(connection.calls) == 1


@pytest.mark.parametrize("operation", ["read", "put"])
def test_database_timestamps_normalize_to_utc_before_domain_validation(operation):
    original = observation()
    connection = Connection(original)
    stored = connection.history[(*key(original), original.source_revision)]
    offset = timezone(timedelta(hours=5, minutes=30))
    stored["observed_at"] = original.observed_at.astimezone(offset)
    stored["imported_at"] = original.imported_at.astimezone(offset)
    result = read_observations(connection, [key(original)])[key(original)] if operation == "read" else put_observation(connection, original)[1]
    assert result == original
    assert result.observed_at.utcoffset() == timedelta(0)
    assert result.imported_at.utcoffset() == timedelta(0)


@pytest.mark.parametrize("change", [dict(count=-1), dict(count=2**53), dict(count=True), dict(count=None),
    dict(attribution_state="missing"), dict(attribution_state="error"), dict(source_revision="\x00"),
    dict(source_revision="é" * 257), dict(source_entity_id=""), dict(provider="other"),
    dict(observed_at=NOW.replace(tzinfo=None)), dict(imported_at=NOW - timedelta(seconds=1))])
@pytest.mark.parametrize("operation", ["read", "put"])
def test_corrupt_stored_rows_fail_closed(change, operation):
    original = observation()
    connection = Connection(original)
    connection.history[(*key(original), original.source_revision)].update(change)
    with pytest.raises(ValueError):
        if operation == "read":
            read_observations(connection, [key(original)])
        else:
            put_observation(connection, observation(source_revision="next", observed_at=NOW + timedelta(minutes=2)))
    assert not any(sql.startswith("update ") or sql.startswith("insert into catalog.popularity_source_observations")
                   for sql, _ in connection.calls)
