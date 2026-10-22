"""Opt-in real PostgreSQL contracts on an explicitly admitted synthetic database."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import os
import re
import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.popularity_snapshots import PopularityObservation
from music_app.services.popularity_observations_postgres import put_observation, read_observations


@pytest.fixture(scope="module")
def urls():
    app = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app:
        pytest.skip("Requires admitted synthetic PostgreSQL; real database behavior was not exercised")
    a, s = urlparse(app), urlparse(setup)
    assert a.scheme in {"postgres", "postgresql"} and s.scheme in {"postgres", "postgresql"}
    assert a.hostname in {"127.0.0.1", "localhost", "::1"}
    assert (a.hostname, a.port, a.path) == (s.hostname, s.port, s.path)
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", a.path.lstrip("/"))
    assert not a.query and not s.query
    return app, setup


@pytest.fixture
def database(urls):
    import psycopg
    from psycopg.rows import dict_row
    app, setup = urls
    owned = []
    def connect(admin=False):
        return psycopg.connect(setup if admin else app, row_factory=dict_row)
    def new_observation(**changes):
        source = "popularity-contract:" + uuid4().hex
        owned.append(source)
        now = datetime(2026, 10, 12, tzinfo=timezone.utc)
        fields = dict(provider="lastfm", metric="overall_scrobbles", source_entity_id=source,
                      source_revision="first", observed_at=now, imported_at=now + timedelta(days=1),
                      count=100, attribution_state="resolved")
        fields.update(changes)
        return PopularityObservation(**fields)
    with connect() as connection:
        assert connection.execute("select current_user as role").fetchone()["role"] == "album_haven_app"
        for table in ("popularity_source_slots", "popularity_source_observations"):
            assert connection.execute("select to_regclass(%s) as name", ("catalog." + table,)).fetchone()["name"] is not None
    try:
        yield connect, new_observation
    finally:
        with connect(admin=True) as connection:
            for source in owned:
                args = ("lastfm", "overall_scrobbles", source)
                connection.execute("update catalog.popularity_source_slots set current_revision=null where provider=%s and metric=%s and source_entity_id=%s", args)
                connection.execute("delete from catalog.popularity_source_observations where provider=%s and metric=%s and source_entity_id=%s", args)
                connection.execute("delete from catalog.popularity_source_slots where provider=%s and metric=%s and source_entity_id=%s", args)


def source_key(value):
    return value.provider, value.metric, value.source_entity_id


def test_real_caller_rollback_removes_history_and_pointer(database):
    connect, make = database
    incoming = make()
    writer = connect()
    try:
        assert put_observation(writer, incoming) == ("accepted", incoming)
        with connect() as reader:
            assert read_observations(reader, [source_key(incoming)]) == {}
        writer.rollback()
        with connect() as reader:
            assert read_observations(reader, [source_key(incoming)]) == {}
            assert reader.execute("select count(*) as n from catalog.popularity_source_observations where source_entity_id=%s", (incoming.source_entity_id,)).fetchone()["n"] == 0
    finally:
        writer.close()


@pytest.mark.parametrize("existing_slot", [False, True])
def test_real_blocked_writer_observes_committed_winner(database, existing_slot):
    connect, make = database
    original = make()
    if existing_slot:
        with connect() as initial:
            put_observation(initial, original)
    winner = replace(original, source_revision="winner", observed_at=original.observed_at + timedelta(minutes=10), count=5)
    loser = replace(original, source_revision="loser", observed_at=original.observed_at + timedelta(minutes=5), count=10)
    first, second, observer = connect(), connect(), connect()
    pool = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        assert put_observation(first, winner) == ("accepted", winner)
        future = pool.submit(put_observation, second, loser)
        deadline = time.monotonic() + 10
        blocked = False
        while time.monotonic() < deadline:
            row = observer.execute("select wait_event_type from pg_stat_activity where pid=%s", (second.info.backend_pid,)).fetchone()
            observer.rollback()  # Refresh PostgreSQL statistics snapshot on the next probe.
            if row and row["wait_event_type"] == "Lock":
                blocked = True
                break
            if future.done():
                break
            time.sleep(0.02)
        assert blocked, "Second writer must demonstrably wait on the first transaction"
        first.commit()
        assert future.result(timeout=10) == ("stale", winner)
        second.commit()
        with connect() as reader:
            assert read_observations(reader, [source_key(original)]) == {source_key(original): winner}
            rows = reader.execute("select source_revision from catalog.popularity_source_observations where provider=%s and metric=%s and source_entity_id=%s", source_key(original)).fetchall()
            assert {row["source_revision"] for row in rows} == ({"first", "winner"} if existing_slot else {"winner"})
    finally:
        first.rollback()
        first.close()
        if future is not None and not future.done():
            second.cancel()
        pool.shutdown(wait=True)
        second.rollback()
        second.close()
        observer.close()


@pytest.mark.parametrize("statement", [
    "update catalog.popularity_source_observations set count=3 where source_entity_id=%s",
    "delete from catalog.popularity_source_observations where source_entity_id=%s",
    "delete from catalog.popularity_source_slots where source_entity_id=%s",
    "update catalog.popularity_source_slots set source_entity_id=source_entity_id where source_entity_id=%s",
])
def test_real_app_role_cannot_mutate_history_or_delete_slots(database, statement):
    import psycopg
    connect, make = database
    original = make()
    with connect() as connection:
        put_observation(connection, original)
    connection = connect()
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            connection.execute(statement, (original.source_entity_id,))
        connection.rollback()
        assert read_observations(connection, [source_key(original)]) == {source_key(original): original}
    finally:
        connection.close()


def test_real_two_source_publication_is_invisible_until_caller_commit(database):
    connect, make = database
    originals = sorted([make(), make()], key=source_key)
    with connect() as connection:
        for value in originals:
            put_observation(connection, value)
    replacements = [replace(value, source_revision="new", observed_at=value.observed_at + timedelta(minutes=1), count=0) for value in originals]
    writer = connect()
    try:
        put_observation(writer, replacements[0])
        with connect() as reader:
            assert read_observations(reader, map(source_key, originals)) == {source_key(value): value for value in originals}
        put_observation(writer, replacements[1])
        with connect() as reader:
            assert read_observations(reader, map(source_key, originals)) == {source_key(value): value for value in originals}
        writer.commit()
        with connect() as reader:
            assert read_observations(reader, map(source_key, originals)) == {source_key(value): value for value in replacements}
    finally:
        writer.rollback()
        writer.close()
