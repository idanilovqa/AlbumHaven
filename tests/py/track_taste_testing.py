"""Owned real-SQL fixtures for scoped taste contracts; never use a real library."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.asgi_testing import decode_json, run_asgi_request
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip


@pytest.fixture(scope="module")
def taste_database():
    # The existing resolver enforces loopback, fixture-owned database names,
    # distinct migrator/runtime roles, pgpass, and a failed CI prerequisite.
    with pytest.MonkeyPatch.context() as monkeypatch:
        setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
        ownership = isolatedPostgres.IsolatedDatabaseOwnershipLock(database_url=setup_url)
        ownership.acquire()
        database = SimpleNamespace(setup_url=setup_url, runtime_url=runtime_url, cleanup_blocked=False)
        try:
            isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
                    select o.account_id,l.id,'owner' from app.bootstrap_owners o
                    join library.libraries l on l.owner_account_id=o.account_id
                    where o.owner_key='local-bootstrap-owner' and l.name='Local Library'
                    on conflict(library_id,account_id) do nothing""")
            yield database
        finally:
            # A failed test-owned worker cancellation aborts the lane. Do not
            # mutate/reset its database or release its ownership while live.
            if not database.cleanup_blocked:
                try:
                    isolatedPostgres.reset_application_tables(setup_url)
                finally:
                    ownership.release()


@dataclass
class TasteFixture:
    database: object
    prefix: str
    a: int
    b: int
    l1: int
    l2: int
    album_id: int
    artist_id: int
    album_key: str
    tracks: list[dict] = field(default_factory=list)

    @property
    def config(self):
        return {"ALBUM_HAVEN_APP_DATABASE_URL": self.database.runtime_url}

    def connect(self, *, runtime=False):
        return isolatedPostgres._connect(
            self.database.runtime_url if runtime else self.database.setup_url
        )

    def add_track(self, suffix, *, library_id=None, key=None, paths=None):
        from psycopg.types.json import Jsonb
        library_id = self.l1 if library_id is None else library_id
        key = key or f"{self.prefix}:logical:{suffix}"
        paths = paths or [f"/fixture/{self.prefix}/Música/{suffix}.flac"]
        with self.connect() as connection:
            row = connection.execute(
                """insert into library.local_tracks
                     (library_id, album_id, artist_id, track_key, title,
                      track_number, disc_number, duration_seconds)
                   values (%s, %s, %s, %s, %s, 1, 1, 60) returning id""",
                (library_id, self.album_id if library_id == self.l1 else None,
                 self.artist_id if library_id == self.l1 else None, key, suffix),
            ).fetchone()
            track = {"id": int(row["id"]), "key": key, "paths": paths,
                     "library_id": library_id, "title": suffix}
            for path in paths:
                entry = {"path": path, "title": suffix, "album": "Taste Album",
                         "album_artist": "Taste Artist", "artist": "Taste Artist",
                         "track_number": 1, "disc_number": 1, "duration_seconds": 60,
                         "library_root_category": "main_library"}
                connection.execute(
                    """insert into library.local_track_files (track_id, private_path, metadata)
                       values (%s, %s, %s)""",
                    (track["id"], path, Jsonb({"library_root_category": "main_library",
                     "scan_cache": {"stale": False, "file_entry": entry}})),
                )
        self.tracks.append(track)
        return track

    def seed_preference(self, account_id, track, *, library_id="track", key=None,
                        rating=2, love_tier="loved", track_id=None, metadata=None):
        from psycopg.types.json import Jsonb
        if library_id == "track":
            library_id = track["library_id"]
        with self.connect() as connection:
            return connection.execute(
                """insert into app.track_preferences
                     (account_id, library_id, track_id, track_key, rating, love_tier,
                      updated_at, metadata)
                   values (%s, %s, %s, %s, %s, %s, '2020-01-02T03:04:05Z', %s)
                   returning id""",
                (account_id, library_id, track_id, key or track["key"], rating,
                 love_tier, Jsonb(metadata if metadata is not None else
                                  {"source": "fixture-import", "cleared": True,
                                   "provenance": {"retained": [1, "x"]}})),
            ).fetchone()["id"]

    def rows(self):
        # JSON representation includes the entire persisted row, including IDs,
        # timestamps, optional track_id and nested metadata, for rollback proofs.
        with self.connect() as connection:
            return [row["payload"] for row in connection.execute(
                """select to_jsonb(p) as payload from app.track_preferences p
                   where account_id in (%s, %s) and
                     (track_key like %s or library_id = %s)
                   order by id""", (self.a, self.b, f"%{self.prefix}%", self.l2),
            ).fetchall()]

    def row(self, row_id):
        return next(row for row in self.rows() if row["id"] == row_id)

    def actor(self, account_id=None, *, library_id=None, write=True, bootstrap=False):
        from music_app.services.current_actor import (
            ActorState, CapabilityGrant, CurrentActor, LibraryRelationship,
        )
        account_id = self.b if account_id is None else account_id
        library_id = self.l1 if library_id is None else library_id
        actions = ["library.browse.read"]
        if write:
            actions.append("library.track_preferences.manage")
        return CurrentActor(
            state=ActorState.ACTIVE, account_id=account_id, session_id=1,
            username_display=f"taste-{account_id}", is_bootstrap_owner=bootstrap,
            current_library_id=library_id,
            library_relationships=(LibraryRelationship(library_id, "member", False),),
            capability_grants=tuple(CapabilityGrant(a, "library", library_id) for a in actions),
        )


@pytest.fixture
def taste(taste_database):
    from psycopg.types.json import Jsonb
    prefix = "taste-" + uuid.uuid4().hex
    with isolatedPostgres._connect(taste_database.setup_url) as connection:
        owner = connection.execute(
            """select o.account_id, l.id as library_id from app.bootstrap_owners o
               join library.libraries l on l.owner_account_id=o.account_id
               where o.owner_key='local-bootstrap-owner' and l.name='Local Library'
                 and l.library_kind='local'"""
        ).fetchone()
        a, l1 = int(owner["account_id"]), int(owner["library_id"])
        b = connection.execute(
            """insert into app.accounts (display_name, account_kind, username_display,
                 username_normalized, contact_email, contact_email_normalized)
               values (%s, 'managed_user', %s, %s, %s, %s) returning id""",
            (prefix, prefix, prefix, prefix+"@example.test", prefix+"@example.test"),
        ).fetchone()["id"]
        l2 = connection.execute(
            "insert into library.libraries (owner_account_id, name) values (%s, %s) returning id",
            (a, prefix),
        ).fetchone()["id"]
        for account_id, library_id in ((b, l1), (a, l2), (b, l2)):
            connection.execute(
                """insert into library.library_memberships (account_id, library_id, membership_role)
                   values (%s, %s, 'member')""", (account_id, library_id),
            )
        for action in ("library.browse.read", "library.track_preferences.manage"):
            connection.execute(
                """insert into app.capabilities (account_id, capability_key, scope_kind, scope_id)
                   values (%s, %s, 'library', %s)""", (b, action, l1),
            )
        artist_id = connection.execute(
            """insert into library.local_artists (library_id, artist_key, name)
               values (%s, %s, 'Taste Artist') returning id""", (l1, prefix),
        ).fetchone()["id"]
        album_key = prefix + "::album"
        album_id = connection.execute(
            """insert into library.local_albums (library_id, artist_id, album_key, title, metadata)
               values (%s, %s, %s, 'Taste Album', %s) returning id""",
            (l1, artist_id, album_key, Jsonb({"album_artist": "Taste Artist"})),
        ).fetchone()["id"]
    fixture = TasteFixture(taste_database, prefix, a, b, l1, l2, album_id, artist_id, album_key)
    try:
        yield fixture
    finally:
        if not taste_database.cleanup_blocked:
            with fixture.connect() as connection:
                connection.execute("delete from app.track_preferences where account_id=%s and track_key like %s",
                                   (a, f"%{prefix}%"))
                connection.execute("delete from app.accounts where id=%s", (b,))
                connection.execute("delete from library.local_tracks where id=any(%s)",
                                   ([t["id"] for t in fixture.tracks],))
                connection.execute("delete from library.local_albums where id=%s", (album_id,))
                connection.execute("delete from library.local_artists where id=%s", (artist_id,))
                connection.execute("delete from library.libraries where id=%s", (l2,))


@pytest.fixture
def taste_app(taste, asgi_app):
    from music_app.services.auth_sessions_postgres import PostgresAuthSessionService
    from music_app.services.current_actor_postgres import PostgresCurrentActorResolver
    asgi_app.state.config.update(taste.config)
    asgi_app.state.config["PERSISTENCE_BACKENDS"] = {"track_preferences": "postgres", "library_browse": "postgres"}
    asgi_app.state.media_host_library_id = taste.l1
    sessions = PostgresAuthSessionService(taste.config)
    issued = {account: sessions.issue_session(account) for account in (taste.a, taste.b)}
    tokens = {account: session.raw_token for account, session in issued.items()}
    asgi_app.state.current_actor_resolver = PostgresCurrentActorResolver(taste.config, session_service=sessions)

    def request(method, path, *, account=None, headers=None, **kwargs):
        from music_app.services.auth_session_csrf import issue_session_csrf
        token = tokens[taste.b if account is None else account]
        csrf = issue_session_csrf(token, asgi_app.state.auth_policy_config)
        request_headers = {"cookie": f"__Host-album_haven_session={token}; __Host-album_haven_csrf={csrf}",
                           "x-album-haven-csrf": csrf, **(headers or {})}
        status, response_headers, body = run_asgi_request(asgi_app, method, path, headers=request_headers, **kwargs)
        return status, response_headers, decode_json(body)

    try:
        yield SimpleNamespace(app=asgi_app, request=request, tokens=tokens)
    finally:
        if not taste.database.cleanup_blocked:
            with taste.connect() as connection:
                connection.execute("delete from app.account_sessions where id=any(%s)",
                                   ([session.session_id for session in issued.values()],))


def assert_taste_locations(album, path, *, rating, love_tier, editable):
    found = {"tracks": 0, "track_rows": 0, "gallery": 0}
    def inspect(container):
        for track in container.get("tracks", []):
            if track.get("path") != path:
                continue
            found["tracks"] += 1
            check(track["track_preference_overlay"])
            if "track_preference" in track:
                check(track["track_preference"])
            if "can_edit_preferences" in track:
                assert track["can_edit_preferences"] is editable
        for label, rows in (("track_rows", container.get("track_rows", [])),
                            ("gallery", container.get("gallery_list_block", {}).get("track_rows", []))):
            for row in rows:
                if row.get("track_ref") == path:
                    found[label] += 1
                    check(row["track_preference"])
                    assert row["can_edit_preferences"] is editable
        for source in container.get("duplicate_sources", []):
            inspect(source)
    def check(value):
        assert value["rating"] == rating
        assert value["love_tier"] == love_tier
        assert value["allowed_actions"]["can_rate"] is editable
        assert value["allowed_actions"]["can_set_love_tier"] is editable
    inspect(album)
    assert all(found.values()), found


class OwnedWorkers:
    """One bounded lifecycle for real writers, competing SQL and barriers."""
    def __init__(self, database):
        self.database = database
        self.workers = []
        self.connections = []
        self.pids = []
        self.connected = Event()
        self.releases = []
        self.closing = False

    def __enter__(self):
        return self

    def connect(self, url):
        if self.closing:
            raise RuntimeError("owned worker attempted a connection during cancellation")
        connection = isolatedPostgres._connect(url)
        self.connections.append(connection)
        self.pids.append(connection.info.backend_pid)
        self.connected.set()
        if self.closing:
            connection.close()
            raise RuntimeError("owned connection completed during cancellation")
        return connection

    def runtime_connection(self, _url=None):
        return self.connect(self.database.runtime_url)

    def setup_connection(self):
        return self.connect(self.database.setup_url)

    def start(self, operation):
        result, errors, done = [], [], Event()
        def run():
            try:
                result.append(operation())
            except BaseException as error:
                errors.append(error)
            finally:
                done.set()
        thread = Thread(target=run, daemon=True)
        worker = SimpleNamespace(thread=thread, done=done, result=result, errors=errors)
        self.workers.append(worker)
        thread.start()
        return worker

    def finish(self, worker):
        worker.thread.join(5)
        assert worker.done.is_set() and not worker.thread.is_alive(), "owned SQL worker did not finish"
        return worker

    def barrier(self):
        reached, release = Event(), Event()
        self.releases.append(release)
        def pause():
            reached.set()
            assert release.wait(5), "test did not release owned transaction barrier"
        return SimpleNamespace(reached=reached, release=release, pause=pause)

    def __exit__(self, kind, value, traceback):
        # Every barrier releases even when the first assertion/join fails.
        # External row blockers must be inner context managers, so they have
        # already exited before this owner drains any worker.
        for release in self.releases:
            release.set()
        for worker in self.workers:
            if worker.thread.ident is not None:
                worker.thread.join(5)
        alive = [worker for worker in self.workers if worker.thread.is_alive()]
        self.closing = True
        for connection in self.connections:
            try:
                cancel = getattr(connection, "cancel_safe", None)
                if alive and not connection.closed and callable(cancel):
                    cancel(timeout=2)
            except Exception:
                pass
            finally:
                try:
                    # Also close a leaked transaction whose worker terminated.
                    connection.close()
                except Exception:
                    pass
        for worker in alive:
            worker.thread.join(5)
        if (any(worker.thread.is_alive() for worker in self.workers)
                or any(not connection.closed for connection in self.connections)):
            self.database.cleanup_blocked = True
            pytest.exit(
                "Owned SQL activity survived bounded cleanup; stop the isolated "
                "lane without further fixture mutation or ownership release.",
                returncode=2,
            )
        return False


def observe_lock_wait(taste, pid):
    deadline = time.monotonic() + 2
    with taste.connect() as connection:
        while time.monotonic() < deadline:
            row = connection.execute(
                """select exists(select 1 from pg_locks
                   where pid=any(%s) and not granted) as waiting""",
                (list(pid) if isinstance(pid, list) else [pid],),
            ).fetchone()
            if row["waiting"]:
                return
            time.sleep(0.01)
    pytest.fail("taste writer never entered a database conflict wait")


class ObservedConnection:
    """Transparent real connection proxy: barriers are test orchestration only."""
    def __init__(self, connection, *, after_dml=None, before_commit=None):
        self.connection = connection
        self.after_dml = after_dml
        self.before_commit = before_commit
        self.saw_dml = False

    def __getattr__(self, name):
        return getattr(self.connection, name)

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None and self.before_commit is not None:
            try:
                self.before_commit()
            except BaseException as error:
                try:
                    self.connection.__exit__(type(error), error, error.__traceback__)
                except BaseException as cleanup_error:
                    raise error from cleanup_error
                raise
        return self.connection.__exit__(kind, value, traceback)

    def execute(self, statement, params=None, **kwargs):
        cursor = self.connection.execute(statement, params, **kwargs)
        text = str(statement).casefold()
        if "insert into app.track_preferences" in text or "update app.track_preferences" in text:
            self.saw_dml = True
            if self.after_dml is not None:
                self.after_dml()
        return cursor
