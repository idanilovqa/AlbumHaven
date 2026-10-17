"""Real PostgreSQL support for dormant Top-native remote acquisition contracts.

Only this test fixture's own synthetic actors/libraries are cleaned. Runtime uses
its real role and real authority owner. Trusted setup can insert immutable test
retained history only. Fresh pending facts use the actual version-2 lifecycle.
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


def prepared_payload(preparation, target, *, key=None, mbid=MBID):
    """Explicit v2 wire; payload() above remains the exact legacy-v1 builder."""
    return {"version": 2, "preparation_ref": preparation["preparation_ref"],
            "request_key": key or str(uuid4()), "destination": target, "release_group_id": mbid}


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
        self.preparation_forms = {}
        self.reservation_states = {}
        self.reservation_commits = []
        self.facts = evidence()
        self.original_connect = database.service._connect
        connect = self.original_connect
        case = self

        class ObservedConnection:
            """Transparent observation of real SQL; never supplies query results."""
            def __init__(self, real):
                self.real = real
                self.reserved = False

            def execute(self, sql, params=None):
                result = self.real.execute(sql, params)
                normalized = " ".join(sql.lower().split())
                case.statements.append(normalized)
                self.reserved = self.reserved or normalized.startswith("select app.reserve_top_remote_attempt(")
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
                    observed_connection = ObservedConnection(connection)
                    yield observed_connection
                finally:
                    self.active_connections.remove((identity, connection))
            # This line is reached only after the real owner connection context
            # exits successfully and acknowledges commit. Observe persisted SQL
            # state even if cancellation prevents entering the provider at all.
            if observed_connection.reserved:
                self.reservation_commits.append((identity, self.c2_state()))
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
        self.reservation_states[get_ident()] = self.c2_state()
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

    def acquire(self, command, *, actor=None, **options):
        """Dispatch exactly this body; never create a parent or convert a version."""
        return self.service.acquire(self.db.context(actor), payload=command,
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

    def begin_v2(self, target=None, *, actor=None, form_ref=None, context_ref=CONTEXT):
        """Real service maintenance sentinel and begin, under the intended scope."""
        actor = actor or self.db.owner
        target = target or destination()
        context = self.db.context(actor)
        progress = self.service.maintain_preparations(context, payload={"mode": "reclaim"}, context_ref=context_ref)
        assert progress["capacity"]["legacy_initialized"] is True
        scope = (actor.account_id, actor.session_id, actor.current_library_id, context_ref,
                 target["kind"], target.get("top_ref", target.get("draft_ref")), target.get("revision"))
        stable_form = form_ref or target.get("draft_ref") or self.preparation_forms.setdefault(scope, str(uuid4()))
        parent = self.service.begin_preparation(context, payload={"destination": target, "form_ref": stable_form},
            context_ref=context_ref)
        assert parent["version"] == 2 and parent["state"] == "ready"
        assert parent["destination"] == target and parent["form_ref"] == stable_form
        return parent, target

    def prepare_v2(self, target=None, *, actor=None, form_ref=None, context_ref=CONTEXT, key=None, mbid=MBID):
        """Visible fresh setup convenience; acquire() never invokes this helper."""
        parent, target = self.begin_v2(target, actor=actor, form_ref=form_ref, context_ref=context_ref)
        return prepared_payload(parent, target, key=key, mbid=mbid)

    def binding_v2(self, command, *, actor=None, context_ref=CONTEXT):
        actor = actor or self.db.owner
        target = command["destination"]
        owner = actor.account_id
        if target["kind"] == "top":
            with self.db.connect() as connection:
                owner = connection.execute("select owner_account_id from app.album_lists where ref=%s",
                    (target["top_ref"],)).fetchone()["owner_account_id"]
        normalized = normalize_remote_acquisition(command)
        return (command["preparation_ref"], actor.current_library_id, actor.account_id, actor.session_id,
            context_ref, target["kind"], target.get("top_ref", target.get("draft_ref")), owner,
            int(target["revision"]) if target["kind"] == "top" else None,
            normalized.request_key, normalized.digest, normalized.release_group_id)

    def reserve_v2(self, command, *, actor=None, context_ref=CONTEXT, connection=None):
        if connection is not None:
            # The caller must acknowledge this transaction before finish_v2.
            assert connection.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
            assert_runtime_role(connection, self.db)
            return connection.execute("select app.reserve_top_remote_attempt(" + ",".join(["%s"] * 12)
                + ") as result", self.binding_v2(command, actor=actor, context_ref=context_ref)).fetchone()["result"]
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            result = connection.execute("select app.reserve_top_remote_attempt(" + ",".join(["%s"] * 12)
                + ") as result", self.binding_v2(command, actor=actor, context_ref=context_ref)).fetchone()["result"]
        # Returning happens after the real connection context acknowledged commit.
        return result

    def finish_v2(self, command, reservation, *, actor=None, facts=None, context_ref=CONTEXT, connection=None):
        facts = facts or self.facts
        args = (*self.binding_v2(command, actor=actor, context_ref=context_ref), reservation["attempt_ref"],
            reservation["acquisition_ref"], facts.digest, facts.title, facts.artist_display,
            facts.first_release_date, facts.primary_type)
        if connection is not None:
            assert connection.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
            assert_runtime_role(connection, self.db)
            return connection.execute("select app.finish_top_remote_attempt(" + ",".join(["%s"] * len(args))
                + ") as result", args).fetchone()["result"]
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            result = connection.execute("select app.finish_top_remote_attempt(" + ",".join(["%s"] * len(args))
                + ") as result", args).fetchone()["result"]
        return result

    def c2_state(self):
        with runtime(self.db) as connection:
            assert_runtime_role(connection, self.db)
            return {name: connection.execute("select * from app." + name
                + " where actor_account_id=any(%s) order by 1", (self.db.account_ids,)).fetchall()
                for name in ("album_top_remote_pending_budgets", "album_top_remote_preparations",
                    "album_top_remote_attempts", "album_top_remote_acquisitions")}

    def retire_pending(self, acquisition_ref):
        with self.db.connect() as connection:
            connection.execute("update app.album_top_remote_acquisitions set retired_at=clock_timestamp() where ref=%s",
                (acquisition_ref,))

    def cleanup_pending(self):
        """Guard-preserving, exact-actor cleanup; no immutable trigger bypass."""
        self.db.service._connect = self.original_connect
        with self.db.connect() as connection:
            owner = connection.execute("select rolsuper,current_user=pg_get_userbyid(c.relowner) as owns "
                "from pg_roles r cross join pg_class c where r.rolname=current_user "
                "and c.oid='app.album_top_remote_preparations'::regclass").fetchone()
            assert owner == {"rolsuper": False, "owns": True}
            connection.execute("select id from app.accounts where id=any(%s) order by id for update",
                (self.db.account_ids,)).fetchall()
            connection.execute("select actor_account_id from app.album_top_remote_pending_budgets "
                "where actor_account_id=any(%s) order by actor_account_id for update", (self.db.account_ids,)).fetchall()
            parents = connection.execute("select ref from app.album_top_remote_preparations "
                "where actor_account_id=any(%s) order by ref for update", (self.db.account_ids,)).fetchall()
            for parent in parents:
                connection.execute("select app.reclaim_top_remote_parent_locked(%s,true)", (parent["ref"],)).fetchone()
            assert not connection.execute("select ref from app.album_top_remote_acquisitions "
                "where actor_account_id=any(%s)", (self.db.account_ids,)).fetchall()
            connection.execute("delete from app.album_top_remote_pending_budgets where actor_account_id=any(%s)",
                (self.db.account_ids,))

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
        case.cleanup_pending()
        # Retained-history teardown remains separately scoped to fixture libraries.
        with db.connect() as connection:
            assert connection.execute("select rolsuper from pg_roles where rolname=current_user").fetchone()["rolsuper"] is False
            assert connection.execute("select current_user=pg_get_userbyid(relowner) as owns from pg_class "
                "where oid='app.album_top_remote_admissions'::regclass").fetchone()["owns"] is True
            connection.execute("alter table app.album_top_remote_admissions disable trigger top_remote_admission_immutable")
            connection.execute("delete from app.album_list_item_remote_sources where library_id=any(%s)", (db.library_ids,))
            connection.execute("delete from app.album_top_remote_admissions where library_id=any(%s)", (db.library_ids,))
            connection.execute("alter table app.album_top_remote_admissions enable trigger top_remote_admission_immutable")
