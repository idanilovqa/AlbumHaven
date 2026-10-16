"""Real PostgreSQL support for dormant Top-native remote acquisition contracts.

Only this test fixture's own synthetic actors/libraries are cleaned. Runtime uses
its real role and real authority owner. Trusted setup can insert immutable test
history, but production retention, identity mapping, and activation stay absent.
"""
from contextlib import contextmanager
from uuid import uuid4
from threading import get_ident

import psycopg
from psycopg.rows import dict_row
import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role

from music_app.services.album_top_remote_acquisition import TopRemoteAcquisitionService
from music_app.services.album_top_remote_sources import normalize_remote_acquisition
from music_app.services.remote_album_evidence import project_release_group_evidence
from tests.py.test_owned_album_tops_postgres import db, urls

CONTEXT = "a" * 64
MBID = "a62a2e84-f917-451e-b16b-34532dd965a5"
ARTIST_MBID = "021d181c-443c-44db-b47f-96c5c6c16670"
RELATIONS = ("album_top_remote_acquisitions", "album_top_remote_admissions", "album_list_item_remote_sources")
STORE_SIGNATURE = "app.store_top_remote_acquisition(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,text,text,text,text,text)"
STORE_SQL = "select app.store_top_remote_acquisition(" + ",".join(["%s"] * 17) + ") as ref"


def evidence(*, mbid=MBID, title="Remote album", artist="Remote artist"):
    return project_release_group_evidence({"id": mbid, "title": title, "primary-type": "Album",
        "artist-credit": [{"name": artist, "artist": {"id": ARTIST_MBID}}],
        "first-release-date": "2000"}, requested_id=mbid)


def destination(top=None):
    return ({"kind": "top", "top_ref": top["top_ref"], "revision": top["revision"]}
            if top else {"kind": "create", "draft_ref": str(uuid4())})


def payload(target=None, *, key=None, mbid=MBID):
    return {"request_key": key or str(uuid4()), "destination": target or destination(),
            "release_group_id": mbid}


@contextmanager
def runtime(database):
    with psycopg.connect(database.app_url, row_factory=dict_row) as connection:
        connection.execute("set local lock_timeout='5s'")
        connection.execute("set local statement_timeout='20s'")
        yield connection


def sql_error(connection, code, callback, *, constraint=None):
    """An actual SQL savepoint contains the expected failed statement."""
    with pytest.raises(psycopg.Error) as caught:
        with connection.transaction():
            callback()
    assert caught.value.sqlstate == code
    if constraint is not None:
        assert caught.value.diag.constraint_name == constraint


class RemoteCase:
    def __init__(self, database):
        self.db = database
        self.calls = []
        self.active_connections = []
        self.connection_pids = {}
        self.connection_history = {}
        self.statements = []
        self.after_statement = None
        self.provider_hook = None
        self.facts = evidence()
        self.original_connect = database.service._connect
        connect = self.original_connect
        case = self

        class ObservedConnection:
            """Transparent observation of real SQL; never supplies query results."""
            def __init__(self, real):
                self.real = real

            def execute(self, sql, params=None):
                result = self.real.execute(sql, params)
                normalized = " ".join(sql.lower().split())
                case.statements.append(normalized)
                if case.after_statement is not None:
                    case.after_statement(normalized, self.real)
                return result

            def __getattr__(self, name):
                return getattr(self.real, name)

        @contextmanager
        def observed(*args, **kwargs):
            with connect(*args, **kwargs) as connection:
                connection.execute("set local lock_timeout='5s'")
                connection.execute("set local statement_timeout='20s'")
                identity = get_ident()
                pid = connection.info.backend_pid
                self.connection_pids.setdefault(identity, set()).add(pid)
                self.connection_history.setdefault(identity, {}).setdefault(pid, []).append(connection)
                self.active_connections.append((identity, connection))
                try:
                    yield ObservedConnection(connection)
                finally:
                    self.active_connections.remove((identity, connection))
        database.service._connect = observed
        self.service = TopRemoteAcquisitionService(database.service, provider=self.provider,
            searcher=self.searcher, user_agent="AlbumHaven-Synthetic-Contract/1.0")

    def outside_authority(self, *, check_locks=True):
        identity = get_ident()
        assert not any(owner == identity for owner, _ in self.active_connections), "Provider entered inside an owner transaction"
        recorded = self.connection_pids.get(identity, set())
        assert recorded, "Provider must follow an observed real authority transaction"
        # The actual app role can inspect its own runtime backend transaction
        # state. A migration-role query could hide another role's xact_start.
        with runtime(self.db) as connection:
            runtime_role = assert_runtime_role(connection, self.db)
            transactions = connection.execute("""select tracked.pid as tracked_pid,
                observed.pid as observed_pid,observed.usename,observed.xact_start
                from unnest(%s::integer[]) as tracked(pid)
                left join pg_stat_activity observed on observed.pid=tracked.pid""",
                (sorted(recorded),)).fetchall()
            assert len(transactions) == len(recorded)
            assert {row["tracked_pid"] for row in transactions} == recorded
            for row in transactions:
                if row["observed_pid"] is None:
                    # A vanished backend is acceptable only when every actual
                    # connection recorded for that PID is now visibly closed.
                    history = self.connection_history[identity][row["tracked_pid"]]
                    assert history and all(real.closed for real in history), row
                else:
                    assert row["usename"] == runtime_role, row
                    assert row["xact_start"] is None, row
        if not check_locks:
            return
        # Keep independent NOWAIT lock probes on the trusted fixture connection.
        # Neither query changes data; both must succeed after authority closed.
        with self.db.connect() as connection:
            connection.execute("select id from app.accounts where id=any(%s) for update nowait",
                               (self.db.account_ids,)).fetchall()
            connection.execute("select ref from app.album_lists where library_id=any(%s) for update nowait",
                               (self.db.library_ids,)).fetchall()

    def provider(self, mbid, **options):
        self.outside_authority()
        self.calls.append(("acquire", mbid, options))
        if self.provider_hook is not None:
            self.provider_hook()
        return self.facts

    def searcher(self, title, artist, **options):
        self.outside_authority()
        self.calls.append(("search", title, artist, options))
        if self.provider_hook is not None:
            self.provider_hook()
        return (self.facts,)

    def acquire(self, command=None, *, actor=None, **options):
        return self.service.acquire(self.db.context(actor), payload=command or payload(),
                                   context_ref=options.pop("context_ref", CONTEXT), **options)

    def rows(self):
        with self.db.connect() as connection:
            return connection.execute("select * from app.album_top_remote_acquisitions where actor_account_id=any(%s) order by ref",
                                      (self.db.account_ids,)).fetchall()

    def unrelated(self):
        with self.db.connect() as connection:
            state = self.db.snapshot()
            for name in ("listening_goals", "listening_goal_evidence", "listening_goal_albums",
                         "listening_goal_assignments", "listening_goal_cycles", "listening_goal_cycle_items",
                         "listening_goal_operations"):
                state[name] = connection.execute(f"select * from app.{name} where account_id=any(%s) order by 1,2",
                                                (self.db.account_ids,)).fetchall()
            state["identities"] = connection.execute("select * from catalog.release_group_provider_identities where external_id=%s",
                                                     (MBID,)).fetchall()
            state["admissions"] = connection.execute("select * from app.album_top_remote_admissions where library_id=any(%s) order by ref",
                                                      (self.db.library_ids,)).fetchall()
            state["sources"] = connection.execute("select * from app.album_list_item_remote_sources where library_id=any(%s) order by top_ref,item_ref",
                                                   (self.db.library_ids,)).fetchall()
            return state

    def store_args(self, command, *, actor=None, facts=None, context_ref=CONTEXT, ref=None):
        actor = actor or self.db.owner
        facts = facts or self.facts
        normalized = normalize_remote_acquisition(command)
        target = normalized.destination
        owner = actor.account_id
        if target.kind == "top":
            with self.db.connect() as connection:
                owner = connection.execute("select owner_account_id from app.album_lists where ref=%s", (target.ref,)).fetchone()["owner_account_id"]
        return (ref or str(uuid4()), actor.current_library_id, actor.account_id, actor.session_id,
                context_ref, target.kind, target.ref, owner, int(target.revision) if target.revision else None,
                normalized.request_key, normalized.digest, facts.release_group_id, facts.digest,
                facts.title, facts.artist_display, facts.first_release_date, facts.primary_type)

    def seed(self, count, *, command=None, facts=None, state="expired", actor=None):
        """One targeted SQL INSERT generates exact, bounded synthetic history.

        Facts and command digest come from the real normalizers; generated request
        keys only differ in the field deliberately excluded from that digest.
        No production budget constant or storage accounting result is replaced.
        """
        assert 1 <= count <= 10000
        assert state in {"expired", "retired", "live"}
        command = command or payload()
        args = self.store_args(command, actor=actor, facts=facts)
        token = uuid4().hex
        with self.db.connect() as connection:
            connection.execute("""with seed as (
                select %s::bigint as library_id,%s::bigint as actor_id,%s::bigint as session_id,
                  %s::text as context_ref,%s::text as kind,%s::uuid as destination,
                  %s::bigint as owner_id,%s::bigint as revision,%s::text as digest,
                  %s::text as external_id,%s::text as version,%s::text as title,%s::text as artist,
                  %s::text as released,%s::text as primary_type,
                  statement_timestamp()-case when %s='expired' then interval '1 hour' else interval '0' end as created
              ) insert into app.album_top_remote_acquisitions(ref,library_id,actor_account_id,original_session_id,
                context_ref,destination_kind,destination_ref,destination_top_ref,destination_owner_account_id,
                destination_revision,request_key,command_digest,provider,entity_kind,external_id,evidence_version,
                title,artist_display,first_release_date,primary_type,facts_bytes,created_at,expires_at,retired_at)
              select md5(%s||':ref:'||g)::uuid,library_id,actor_id,session_id,context_ref,kind,destination,
                case when kind='top' then destination end,owner_id,revision,
                case when %s=1 then %s::uuid else md5(%s||':key:'||g)::uuid end,
                digest,'musicbrainz','release-group',external_id,version,title,artist,released,primary_type,
                octet_length(jsonb_build_array(1,'musicbrainz','release-group',external_id,title,artist,released,primary_type,version)::text),
                created,created+interval '30 minutes',case when %s='retired' then created end
              from seed cross join generate_series(1,%s) as g""",
              (*args[1:9], args[10], *args[11:], state, token, count, command["request_key"], token, state, count))
        return command

    def counts(self, target=None):
        where = "actor_account_id=%s"
        params = [self.db.owner.account_id]
        if target is not None:
            where += " and library_id=%s and destination_kind=%s and destination_ref=%s"
            params += [self.db.library, target["kind"], target.get("draft_ref", target.get("top_ref"))]
        with self.db.connect() as connection:
            return connection.execute(f"""select count(*) as retained,coalesce(sum(facts_bytes),0) as bytes,
                count(*) filter(where retired_at is null and expires_at>clock_timestamp()) as live
                from app.album_top_remote_acquisitions where {where}""", params).fetchone()


@pytest.fixture
def remote(db):
    case = RemoteCase(db)
    try:
        yield case
    finally:
        db.service._connect = case.original_connect
        with db.connect() as connection:
            assert connection.execute("select rolsuper from pg_roles where rolname=current_user").fetchone()["rolsuper"] is False
            for table, trigger in (("album_top_remote_acquisitions", "top_remote_acquisition_immutable"),
                                   ("album_top_remote_admissions", "top_remote_admission_immutable")):
                assert connection.execute("select current_user=pg_get_userbyid(relowner) as owns from pg_class where oid=%s::regclass",
                                          ("app." + table,)).fetchone()["owns"] is True
                connection.execute(f"alter table app.{table} disable trigger {trigger}")
            connection.execute("delete from app.album_list_item_remote_sources where library_id=any(%s)", (db.library_ids,))
            connection.execute("delete from app.album_top_remote_admissions where library_id=any(%s)", (db.library_ids,))
            connection.execute("delete from app.album_top_remote_acquisitions where actor_account_id=any(%s)", (db.account_ids,))
            for table, trigger in (("album_top_remote_acquisitions", "top_remote_acquisition_immutable"),
                                   ("album_top_remote_admissions", "top_remote_admission_immutable")):
                connection.execute(f"alter table app.{table} enable trigger {trigger}")
