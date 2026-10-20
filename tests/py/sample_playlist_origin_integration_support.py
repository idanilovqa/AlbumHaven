"""Real-owner observations for the correction contract; never authority doubles.

Only SQL/cursor forwarding, normal fixture data, and bounded harness coordination.
No product imports or tests were executed while authoring this file.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from threading import Lock
from time import monotonic, sleep
import re
from uuid import uuid4

import pytest
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from test_sample_playlist_receipts_live import destinations, retained, sources


@dataclass
class SQLCall:
    sql: str
    params: object
    pid: int
    rows: list = field(default_factory=list)
    error: object = None


def is_album_update(call):
    return bool(re.search(r"\bfrom library\.local_albums\b", call.sql)) and "for update" in call.sql


def is_track_update(call):
    return bool(re.search(r"\bfrom library\.local_tracks\b", call.sql)) and "for update" in call.sql and "from library.local_albums" not in call.sql


def is_edition_share(call):
    return "from library.catalog_album_links" in call.sql and "join library.local_albums" in call.sql and "for share" in call.sql


def parameter(call, clause):
    """Read an actual bound SQL argument, accepting positional/named placeholders."""
    match = re.search(clause + r"\s*(%s|%\(([^)]+)\)s)", call.sql)
    assert match, (clause, call.sql)
    if match[2] is not None:
        return call.params[match[2]]
    offset = call.sql[:match.start(1)].count("%s")
    return call.params[offset]


def is_album_probe(call):
    return (call.sql.startswith("select ") and "from library.local_tracks" in call.sql
            and re.search(r"\balbum_id\s*=\s*%", call.sql) is not None
            and " limit " in call.sql)


def probe_album(call):
    return parameter(call, r"\balbum_id\s*=")


def probe_limit(call):
    return parameter(call, r"\blimit")


class SQLTrace:
    """Forward to the exact connection/cursor; do not consume or replace rows."""
    def __init__(self, before=None, after=None):
        self.calls = []
        self.connections = []
        self.before, self.after = before, after
        self.guard = Lock()

    def wrap(self, real):
        trace = self

        class Cursor:
            def __init__(self, cursor, call):
                self.real, self.call = cursor, call
            def __getattr__(self, name):
                return getattr(self.real, name)
            def fetchall(self):
                rows = self.real.fetchall()
                self.call.rows.extend(deepcopy(rows))
                return rows
            def fetchone(self):
                row = self.real.fetchone()
                if row is not None:
                    self.call.rows.append(deepcopy(row))
                return row
            def fetchmany(self, *args, **kwargs):
                rows = self.real.fetchmany(*args, **kwargs)
                self.call.rows.extend(deepcopy(rows))
                return rows
            def __iter__(self):
                for row in self.real:
                    self.call.rows.append(deepcopy(row))
                    yield row

        class Connection:
            def __getattr__(self, name):
                return getattr(real, name)
            def execute(self, sql, params=None, *args, **kwargs):
                call = SQLCall(" ".join(str(sql).lower().split()), deepcopy(params), real.info.backend_pid)
                with trace.guard:
                    trace.calls.append(call)
                if trace.before:
                    trace.before(call, real)
                try:
                    cursor = real.execute(sql, params, *args, **kwargs)
                except BaseException as error:
                    call.error = error
                    raise
                if trace.after:
                    trace.after(call, real)
                return Cursor(cursor, call)
        return Connection()

    @contextmanager
    def install(self, owner):
        original = owner._connect
        trace = self
        @contextmanager
        def connect(url):
            with original(url) as real:
                trace.connections.append(real)
                yield trace.wrap(real)
        owner._connect = connect
        try:
            yield self
        finally:
            owner._connect = original

    def rows_for(self, predicate, *, before=None):
        calls = self.calls if before is None else self.calls[:before]
        return [row["id"] for call in calls if predicate(call) for row in call.rows]


def observe_legacy(monkeypatch):
    """Mark real inventory_rows entry and forward every call unchanged."""
    calls = []
    original = sources.inventory_rows
    def observed(connection, library_id, track_ids, **kwargs):
        calls.append((connection.info.backend_pid, tuple(track_ids), kwargs.copy()))
        return original(connection, library_id, track_ids, **kwargs)
    monkeypatch.setattr(sources, "inventory_rows", observed)
    return calls


def another_owner(db):
    with db.connect() as con:
        actor = db.member(con)
    owner = PostgresOwnedPlaylistsService(db.config, connect=db.app_connect, clock=lambda: db.clock_time)
    assert actor.account_id != db.owner.account_id
    return actor, owner


def receipts_for(db, actor=None):
    with db.connect() as con:
        rows = con.execute("""select ref,protocol,actor_account_id from app.playlist_creation_sources
            where library_id=%s order by ref""", (db.library,)).fetchall()
    return [(str(row["ref"]), row["protocol"], row["actor_account_id"]) for row in rows
            if actor is None or row["actor_account_id"] == actor.account_id]


def no_survivors(db, key, before):
    assert retained(db, key) == (None, [])
    assert (destinations(db), receipts_for(db, db.owner)) == before


def assert_real_wait(db, waiter, blocker):
    deadline = monotonic() + 10
    with db.connect() as con:
        while monotonic() < deadline:
            if blocker in con.execute("select pg_blocking_pids(%s) as blockers", (waiter,)).fetchone()["blockers"]:
                return
            sleep(0.01)
    pytest.fail("Expected PostgreSQL wait graph did not form at the actual owner SQL")


def cancel_connections(*traces):
    """Harness failure cleanup only, not a product lock timeout/retry strategy."""
    for trace in traces:
        for con in trace.connections:
            if not con.closed:
                con.cancel()


def top_order(case):
    with case.db.connect() as con:
        return con.execute("""select ref,catalog_ref from app.album_list_items
            where top_ref=%s order by curator_position,ref""", (case.top["top_ref"],)).fetchall()


def add_album(db, *, key=None):
    with db.connect() as con:
        return con.execute("""insert into library.local_albums(library_id,album_key,title)
            values(%s,%s,'Integration sentinel') returning id""",
            (db.library, uuid4().hex if key is None else key)).fetchone()["id"]


def grow_album(db, album, count):
    """Normal migrated fixture rows; no fake inventory response, mapping or files."""
    with db.connect() as con:
        old = con.execute("select count(*) as n from library.local_tracks where library_id=%s and album_id=%s",
                          (db.library, album)).fetchone()["n"]
        assert count >= old
        if count > old:
            con.execute("""insert into library.local_tracks
                (library_id,album_id,track_key,title,disc_number,track_number)
                select %s,%s,%s || n::text,'Budget witness',1,n
                from generate_series(%s,%s) n""", (db.library, album, uuid4().hex, old + 1, count))
        return [row["id"] for row in con.execute("""select id from library.local_tracks
            where library_id=%s and album_id=%s order by id""", (db.library, album)).fetchall()]


def album_set(db, albums):
    return {"kind": "album_set", "selections": [
        {"kind": "local", "inventory_album_ref": f"inventory-album:{db.library}:{identity}"}
        for identity in albums]}
