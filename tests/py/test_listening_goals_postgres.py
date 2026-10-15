"""Account-owned Goals against the normal isolated PostgreSQL contract database.

Only the official provider boundary is replaced with projected fixture facts.
The repository, policy evaluator, domain transitions, roles and SQL are real.
No inventory, active library, application bootstrap or alternate harness is used.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from threading import Barrier
from uuid import uuid4

import pytest

from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command
from music_app.services.listening_goals_postgres import (
    EVIDENCE_LIFETIME, MAX_PENDING_EVIDENCE, PostgresListeningGoalsService,
)
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.remote_album_evidence import (
    RemoteAlbumEvidenceError, project_release_group_evidence,
)
from tests.py.test_owned_album_tops_postgres import urls


READ = "account.self.goals.read"
WRITE = "account.self.goals.write"
PERIODS = ("week", "month", "six-months", "year")
CURSOR_SECRET = "synthetic-listening-goals-history-key-32-bytes"
USER_AGENT = "AlbumHaven-contract/1.0"
ARTIST = "8e68819d-71be-4e7d-b41d-f1df81b01d3f"
GOAL_TABLES = (
    "listening_goal_operations", "listening_goal_cycle_items", "listening_goal_cycles",
    "listening_goal_assignments", "listening_goal_albums", "listening_goals",
    "listening_goal_evidence",
)


class ObservedConnection:
    """Observe/fault real SQL without substituting a repository or SQL result."""

    def __init__(self, real, database, before=None, after=None):
        self.real, self.database, self.before, self.after = real, database, before, after

    def __getattr__(self, name):
        # In particular, preserve psycopg's real transaction/savepoint handling.
        return getattr(self.real, name)

    def execute(self, sql, params=None):
        normalized = " ".join(sql.lower().split())
        if normalized.startswith("insert into catalog.release_groups"):
            # Track even rolled-back/losing candidates, so leaks cannot escape
            # either assertions or fixture cleanup.
            self.database.catalog_refs.append(str(params[0]))
        if self.before is not None:
            self.before(normalized, params)
        result = self.real.execute(sql, params)
        if self.after is not None:
            self.after(normalized, params)
        return result


class GoalsDatabase:
    def __init__(self, urls):
        self.app_url, self.setup_url = urls
        self.now = datetime.now(timezone.utc)
        self.token = uuid4().hex
        self.account_ids, self.library_ids, self.catalog_refs = [], [], []
        self.payloads, self.provider_calls, self.session_tokens = {}, [], {}
        self.service = self.service_for()

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.setup_url, row_factory=dict_row)

    def connector(self, *, before=None, after=None):
        @contextmanager
        def connect(url):
            import psycopg
            from psycopg.rows import dict_row
            with psycopg.connect(url, row_factory=dict_row) as real:
                yield ObservedConnection(real, self, before, after)
        return connect

    def provider(self, ref, *, user_agent, should_cancel=None):
        self.provider_calls.append((ref, user_agent, should_cancel))
        return project_release_group_evidence(self.payloads[ref], requested_id=ref)

    def service_for(self, *, provider=None, before=None, after=None):
        return PostgresListeningGoalsService(
            {"ALBUM_HAVEN_APP_DATABASE_URL": self.app_url},
            connect=self.connector(before=before, after=after), clock=lambda: self.now,
            provider=provider or self.provider, user_agent=USER_AGENT,
        )

    def actor(self, connection):
        # Same actual account/session convention as the established Top fixture,
        # deliberately without its library, capabilities or inventory setup.
        name = "goals-" + uuid4().hex
        account = connection.execute("""insert into app.accounts(display_name,account_kind,
            username_display,username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (name, name, name, name + "@example.test", name + "@example.test")).fetchone()["id"]
        self.account_ids.append(account)
        session = self.session(connection, account)
        return CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=session,
                            authenticated_at=self.now)

    def session(self, connection, account):
        token = issue_opaque_token()
        session = connection.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",
            (account, token.digest, self.now, self.now, self.now,
             self.now + timedelta(hours=1), self.now + timedelta(days=1))).fetchone()["id"]
        self.session_tokens[session] = token.raw
        return session

    def other_actor(self):
        with self.connect() as connection:
            return self.actor(connection)

    def renewed_actor(self, actor=None):
        actor = actor or self.owner
        with self.connect() as connection:
            session = self.session(connection, actor.account_id)
        return replace(actor, session_id=session, authenticated_at=self.now)

    def context(self, actor=None):
        actor = actor or self.owner
        return PolicyContext.build(actor=actor, action=READ, library_id=actor.current_library_id,
            target_account_id=actor.account_id, deployment_mode="self_hosted",
            request_origin=RequestOrigin("network", "synthetic:goals-contract"),
            client_surface_class="private_web")

    def group(self, *, title=None):
        ref = str(uuid4())
        self.payloads[ref] = {
            "id": ref, "title": title or f"Synthetic Goal {self.token} {len(self.payloads)}",
            "first-release-date": "2012-05-22", "primary-type": "Album",
            "artist-credit": [{"name": "Synthetic Artist", "joinphrase": "",
                               "artist": {"id": ARTIST}}],
            # Projected fixtures must drop provider fields outside the allowlist.
            "source_private_path": "/private/never-a-goal-source.flac",
            "source_url": "https://private.example.test/source",
        }
        return ref

    def acquire(self, ref=None, *, actor=None, service=None):
        return (service or self.service).acquire_evidence(self.context(actor), ref or self.group())

    def add_command(self, evidence, *, revision="1", period="week", request_key=None, **changes):
        return normalize_goal_command("add", {
            "request_key": request_key or str(uuid4()), "revision": revision,
            "period": period, "timezone_name": "UTC",
            "evidence_ref": evidence["evidence_ref"],
            "evidence_version": evidence["evidence_version"], **changes,
        })

    def reset_command(self, state, *, period="week", request_key=None, **changes):
        cycle = state["periods"][period]["cycle"]
        return normalize_goal_command("reset", {
            "request_key": request_key or str(uuid4()), "revision": state["revision"],
            "period": period, "timezone_name": "UTC",
            "expected_cycle_id": cycle["cycle_id"] if cycle else None, **changes,
        })

    def add(self, evidence=None, *, actor=None, period="week"):
        evidence = evidence or self.acquire(actor=actor)
        context = self.context(actor)
        state = self.service.read(context)
        command = self.add_command(evidence, revision=state["revision"], period=period)
        return self.service.execute(context, command), command

    def history(self, *, actor=None, period="week", **options):
        return self.service.history(self.context(actor), period=period,
                                    cursor_secret=CURSOR_SECRET, **options)

    def snapshot(self):
        with self.connect() as connection:
            result = {table: connection.execute(
                f"select * from app.{table} where account_id=any(%s) order by to_jsonb({table})::text",
                (self.account_ids,)).fetchall() for table in GOAL_TABLES}
            result["identities"] = connection.execute("""select * from catalog.release_group_provider_identities
                where external_id=any(%s) order by external_id""", (list(self.payloads),)).fetchall()
            result["catalog"] = connection.execute("""select * from catalog.release_groups
                where ref=any(%s::uuid[]) order by ref""", (self.catalog_refs,)).fetchall()
            return result

    def close(self):
        with self.connect() as connection:
            # urls is the existing loopback/synthetic-name guard. CI's bootstrap
            # applies migrations as DATABASE_MIGRATOR_URL's isolated DB owner.
            # Assert that exact ownership before any test-only trigger changes.
            owned = connection.execute("""select bool_and(pg_get_userbyid(relowner)=current_user) as owned
                from pg_class where oid in ('app.listening_goal_cycles'::regclass,
                                           'app.listening_goal_cycle_items'::regclass)""").fetchone()
            assert owned["owned"] is True, "Isolated migrator must own retention tables for fixture cleanup"
            connection.execute("""lock table app.listening_goal_cycles,
                app.listening_goal_cycle_items in access exclusive mode""")
            connection.execute("""alter table app.listening_goal_cycles
                disable trigger listening_goal_cycle_write""")
            connection.execute("""alter table app.listening_goal_cycle_items
                disable trigger listening_goal_cycle_item_write""")
            try:
                # A failed delete rolls this savepoint back before finally can
                # restore both triggers. Outer rollback also restores all DDL.
                with connection.transaction():
                    for table in GOAL_TABLES:
                        connection.execute(f"delete from app.{table} where account_id=any(%s)",
                                           (self.account_ids,))
                    connection.execute("""delete from catalog.release_group_provider_identities
                        where external_id=any(%s) and provider='musicbrainz' and entity_kind='release-group'""",
                        (list(self.payloads),))
                    connection.execute("delete from catalog.release_groups where ref=any(%s::uuid[])",
                                       (self.catalog_refs,))
                    for library in reversed(self.library_ids):
                        connection.execute("delete from library.libraries where id=%s", (library,))
                    for account in self.account_ids:
                        connection.execute("delete from app.accounts where id=%s", (account,))
            finally:
                connection.execute("""alter table app.listening_goal_cycle_items
                    enable trigger listening_goal_cycle_item_write""")
                connection.execute("""alter table app.listening_goal_cycles
                    enable trigger listening_goal_cycle_write""")


@pytest.fixture
def db(urls):
    database = GoalsDatabase(urls)
    try:
        with database.connect() as connection:
            database.owner = database.actor(connection)
        yield database
    finally:
        database.close()


def assert_error(callback, code, status):
    with pytest.raises(GoalsError) as caught:
        callback()
    assert (caught.value.code, caught.value.status) == (code, status)


def assert_private(value):
    encoded = json.dumps(value)
    for forbidden in ("source_private_path", "/private/", "source_url", "private.example.test",
                      "local_album_id", "library_id", "account_id", "original_session_id",
                      "evidence_ref", "evidence_version", "command_digest", "session_token"):
        assert forbidden not in encoded


def test_empty_reads_are_stable_private_and_do_not_materialize_goals(db):
    assert db.owner.current_library_id is None
    before = db.snapshot()
    first = db.service.read(db.context())
    second = db.service.read(db.context())
    assert first == second
    assert first["goal_ref"] is None and first["revision"] == "1" and first["albums"] == []
    assert first["allowed_actions"] == {"can_read": True, "can_add": True, "can_reset": True}
    assert set(first["periods"]) == set(PERIODS)
    for view in first["periods"].values():
        assert view["top_ref"] is None
        assert view["cycle"] is None and view["album_refs"] == []
        assert view["completed"] == view["total"] == view["percent"] == 0
    assert db.history() == {"cycles": [], "next_cursor": None}
    assert db.service.read_operation(db.context(), str(uuid4())) == {"status": "unknown"}
    assert db.snapshot() == before
    assert db.provider_calls == []
    assert_private(first)


def test_acquire_add_read_reset_history_and_acknowledge_without_any_library(db):
    ref = db.group()
    evidence = db.acquire(ref)
    assert db.provider_calls == [(ref, USER_AGENT, None)]
    assert set(evidence) == {"evidence_ref", "evidence_version", "expires_at", "album"}
    assert datetime.fromisoformat(evidence["expires_at"]) == db.now + EVIDENCE_LIFETIME
    acquired = db.snapshot()
    assert len(acquired["listening_goal_evidence"]) == 1
    assert acquired["listening_goals"] == acquired["identities"] == acquired["catalog"] == []
    receipt, command = db.add(evidence)
    assert receipt["ok"] and receipt["changed"] and receipt["action"] == "add"
    assert receipt["revision"] == "2"
    state = db.service.read(db.context())
    assert state["goal_ref"] == receipt["goal_ref"] and state["revision"] == "2"
    assert state["albums"] == [{"catalog_ref": receipt["catalog_ref"], **evidence["album"]}]
    for view in state["periods"].values():
        assert view["album_refs"] == [receipt["catalog_ref"]]
        assert view["total"] == 1 and view["completed"] == 0 and view["percent"] == 0
        assert view["manual_completed_at"] == {receipt["catalog_ref"]: None}
    reset = db.service.execute(db.context(), db.reset_command(state))
    assert reset["changed"] and reset["revision"] == "3"
    current = db.service.read(db.context())
    assert current["periods"]["week"]["cycle"]["cycle_id"] != receipt["cycle_id"]
    assert current["periods"]["week"]["album_refs"] == [receipt["catalog_ref"]]
    for period in PERIODS[1:]:
        assert current["periods"][period] == state["periods"][period]
    archived = db.history()["cycles"]
    assert len(archived) == 1 and archived[0]["cycle_id"] == receipt["cycle_id"]
    assert archived[0]["albums"] == [{**state["albums"][0], "manual_completed_at": None}]
    before = db.snapshot()
    assert db.service.execute(db.context(), command) == receipt
    assert db.service.read_operation(db.context(), command.request_key) == {
        "status": "committed", "receipt": receipt,
    }
    assert db.snapshot() == before
    assert len(db.provider_calls) == 1
    assert db.service.read(db.context())["revision"] == "3", "A receipt is not current state"
    with db.connect() as connection:
        assert connection.execute("select count(*) as n from library.libraries where owner_account_id=%s",
                                  (db.owner.account_id,)).fetchone()["n"] == 0
        assert connection.execute("select count(*) as n from library.catalog_album_links where catalog_ref=%s",
                                  (receipt["catalog_ref"],)).fetchone()["n"] == 0
    for value in (state, current, db.history(), receipt):
        assert_private(value)


def test_empty_reset_records_only_a_replayable_noop_receipt(db):
    state = db.service.read(db.context())
    command = db.reset_command(state)
    receipt = db.service.execute(db.context(), command)
    assert receipt["changed"] is False and receipt["reason"] == "empty_period"
    assert receipt["goal_ref"] is None and receipt["cycle_id"] is None and receipt["revision"] == "1"
    after = db.snapshot()
    assert len(after["listening_goal_operations"]) == 1
    assert all(not rows for table, rows in after.items() if table != "listening_goal_operations")
    assert db.service.execute(db.context(), command) == receipt
    assert db.snapshot() == after


def test_stale_revision_and_changed_request_digest_do_not_commit(db):
    first, second = db.acquire(), db.acquire()
    receipt, original = db.add(first)
    stale = db.add_command(second)
    changed = normalize_goal_command("add", {**original.data,
        "request_key": original.request_key, "period": "month"})
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), stale), "revision_conflict", 409)
    assert_error(lambda: db.service.execute(db.context(), changed), "idempotency_key_reused", 409)
    assert db.service.read_operation(db.context(), stale.request_key) == {"status": "unknown"}
    assert db.service.execute(db.context(), original) == receipt
    assert db.snapshot() == before


def test_operation_receipts_belong_to_the_original_session_and_account(db):
    receipt, command = db.add()
    new_session = db.renewed_actor()
    foreign = db.other_actor()
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(new_session), command), "operation_unavailable", 404)
    for actor in (new_session, foreign):
        assert db.service.read_operation(db.context(actor), command.request_key) == {"status": "unknown"}
    assert db.service.read(db.context(new_session))["goal_ref"] == receipt["goal_ref"]
    assert db.service.read(db.context(foreign))["goal_ref"] is None
    assert db.snapshot() == before


@pytest.mark.parametrize("invalid", ["unknown", "foreign", "version", "expired", "revoked"])
def test_unavailable_evidence_never_admits_catalog_or_goal_rows(db, invalid):
    owner = db.other_actor() if invalid == "foreign" else db.owner
    evidence = db.acquire(actor=owner)
    if invalid == "unknown":
        evidence = {**evidence, "evidence_ref": str(uuid4())}
    elif invalid == "version":
        evidence = {**evidence, "evidence_version": "f" * 64}
    elif invalid == "expired":
        db.now = datetime.fromisoformat(evidence["expires_at"])
    elif invalid == "revoked":
        with db.connect() as connection:
            connection.execute("update app.listening_goal_evidence set revoked_at=%s where ref=%s",
                               (db.now, evidence["evidence_ref"]))
    command = db.add_command(evidence)
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(), command), "evidence_unavailable", 409)
    assert db.snapshot() == before
    assert db.service.read_operation(db.context(), command.request_key) == {"status": "unknown"}


def test_evidence_valid_until_exact_expiry_then_only_committed_retry_survives(db):
    evidence = db.acquire()
    expiry = datetime.fromisoformat(evidence["expires_at"])
    db.now = expiry - timedelta(microseconds=1)
    receipt, original = db.add(evidence)
    db.now = expiry
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(),
        db.add_command(evidence, revision=receipt["revision"])), "evidence_unavailable", 409)
    assert db.service.execute(db.context(), original) == receipt
    assert db.service.read_operation(db.context(), original.request_key)["receipt"] == receipt
    assert db.service.read(db.context())["periods"]["week"]["total"] == 1
    assert db.snapshot() == before


def test_revocation_blocks_new_admission_but_preserves_retained_state_and_receipt(db):
    evidence = db.acquire()
    receipt, original = db.add(evidence)
    with db.connect() as connection:
        connection.execute("update app.listening_goal_evidence set revoked_at=%s where ref=%s",
                           (db.now, evidence["evidence_ref"]))
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(),
        db.add_command(evidence, revision=receipt["revision"], period="month")), "evidence_unavailable", 409)
    assert db.service.execute(db.context(), original) == receipt
    assert db.service.read(db.context())["albums"][0]["catalog_ref"] == receipt["catalog_ref"]
    assert db.snapshot() == before


def test_weekly_fifth_slot_duplicate_noop_and_sixth_rollback(db):
    evidences = [db.acquire() for _ in range(6)]
    receipts = [db.add(evidence)[0] for evidence in evidences[:5]]
    state = db.service.read(db.context())
    assert state["periods"]["week"]["total"] == 5 and state["revision"] == "6"
    before = db.snapshot()
    duplicate = db.add_command(evidences[0], revision="6")
    noop = db.service.execute(db.context(), duplicate)
    assert noop["changed"] is False and noop["reason"] == "already_added" and noop["revision"] == "6"
    after_noop = db.snapshot()
    for table in GOAL_TABLES:
        if table != "listening_goal_operations":
            assert after_noop[table] == before[table]
    assert len(after_noop["listening_goal_operations"]) == 6
    sixth = db.add_command(evidences[5], revision="6")
    assert_error(lambda: db.service.execute(db.context(), sixth), "weekly_capacity", 409)
    assert db.snapshot() == after_noop
    assert db.service.read_operation(db.context(), sixth.request_key) == {"status": "unknown"}
    assert len(after_noop["identities"]) == len(after_noop["catalog"]) == 5
    assert state["periods"]["week"]["album_refs"] == [item["catalog_ref"] for item in receipts]
    # Larger periods accept six albums while the selected week remains full.
    added, _ = db.add(evidences[5], period="month")
    assert added["changed"] and added["revision"] == "7"
    current = db.service.read(db.context())
    assert current["periods"]["week"]["total"] == 5
    assert all(current["periods"][period]["total"] == 6 for period in PERIODS[1:])


def test_distinct_provider_ids_with_equal_display_metadata_stay_distinct(db):
    title = "Same display title " + db.token
    first, _ = db.add(db.acquire(db.group(title=title)))
    second, _ = db.add(db.acquire(db.group(title=title)))
    assert first["catalog_ref"] != second["catalog_ref"]
    assert len(db.snapshot()["identities"]) == 2
    assert [album["title"] for album in db.service.read(db.context())["albums"]] == [title, title]


def test_two_accounts_share_provider_identity_without_sharing_goals_or_history(db):
    other = db.other_actor()
    ref = db.group()
    own_evidence, foreign_evidence = db.acquire(ref), db.acquire(ref, actor=other)
    own, _ = db.add(own_evidence)
    foreign, foreign_command = db.add(foreign_evidence, actor=other)
    assert own["catalog_ref"] == foreign["catalog_ref"] and own["goal_ref"] != foreign["goal_ref"]
    before_other = db.service.read(db.context(other))
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    assert len(db.history()["cycles"]) == 1 and db.history(actor=other)["cycles"] == []
    assert db.service.read(db.context(other)) == before_other
    assert db.service.read_operation(db.context(), foreign_command.request_key) == {"status": "unknown"}
    snapshot = db.snapshot()
    assert len(snapshot["identities"]) == len(snapshot["catalog"]) == 1
    assert len(snapshot["listening_goals"]) == len(snapshot["listening_goal_albums"]) == 2
    for value in (db.service.read(db.context()), before_other, db.history(), db.history(actor=other)):
        assert_private(value)


def test_concurrent_two_account_admission_loses_no_identity_and_leaves_no_orphan(db):
    other = db.other_actor()
    ref = db.group()
    commands = [db.add_command(db.acquire(ref, actor=actor)) for actor in (db.owner, other)]
    candidates_ready = Barrier(2, timeout=10)

    def before(sql, params):
        if sql.startswith("insert into catalog.release_groups"):
            candidates_ready.wait()

    services = [db.service_for(before=before), db.service_for(before=before)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(service.execute, db.context(actor), command)
                   for service, actor, command in zip(services, (db.owner, other), commands)]
        receipts = [future.result(timeout=20) for future in futures]
    assert len(db.catalog_refs) == 2, "Both real transactions must enter the missing-identity race"
    assert receipts[0]["catalog_ref"] == receipts[1]["catalog_ref"]
    assert receipts[0]["goal_ref"] != receipts[1]["goal_ref"]
    snapshot = db.snapshot()
    assert len(snapshot["catalog"]) == len(snapshot["identities"]) == 1
    assert len(snapshot["listening_goals"]) == len(snapshot["listening_goal_operations"]) == 2
    assert str(snapshot["identities"][0]["catalog_ref"]) == receipts[0]["catalog_ref"]
    for actor, receipt in zip((db.owner, other), receipts):
        assert db.service.read(db.context(actor))["periods"]["week"]["album_refs"] == [receipt["catalog_ref"]]


def test_concurrent_add_and_reset_serialize_at_one_account_revision(db):
    db.add()
    state = db.service.read(db.context())
    add = db.add_command(db.acquire(), revision=state["revision"])
    reset = db.reset_command(state)
    starting = Barrier(2, timeout=10)

    def before(sql, params):
        if "from app.accounts" in sql and "for update" in sql:
            starting.wait()

    def execute(command):
        try:
            return db.service_for(before=before).execute(db.context(), command)
        except GoalsError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(execute, command) for command in (add, reset)]
        results = [future.result(timeout=20) for future in futures]
    succeeded = [result for result in results if isinstance(result, dict)]
    rejected = [result for result in results if isinstance(result, GoalsError)]
    assert len(succeeded) == len(rejected) == 1
    assert (rejected[0].code, rejected[0].status) == ("revision_conflict", 409)
    assert succeeded[0]["revision"] == "3"
    current = db.service.read(db.context())
    assert current["revision"] == "3"
    assert len(db.snapshot()["listening_goal_operations"]) == 2
    if succeeded[0]["action"] == "reset":
        assert current["periods"]["week"]["total"] == 1 and len(db.history()["cycles"]) == 1
    else:
        assert current["periods"]["week"]["total"] == 2 and db.history()["cycles"] == []


@pytest.mark.parametrize("fault,after", [
    ("insert into catalog.release_group_provider_identities", False),
    ("insert into app.listening_goals", True),
    ("insert into app.listening_goal_albums", True),
    ("insert into app.listening_goal_assignments", True),
    ("insert into app.listening_goal_cycle_items", True),
    ("insert into app.listening_goal_operations", False),
    ("insert into app.listening_goal_operations", True),
])
def test_fault_rolls_back_catalog_identity_aggregate_memberships_and_receipt(db, fault, after):
    evidence = db.acquire()
    command = db.add_command(evidence)
    observed = []

    def inject(sql, params):
        if sql.startswith(fault):
            observed.append(True)
            raise RuntimeError("injected Goals SQL fault")

    service = db.service_for(**{"after" if after else "before": inject})
    before = db.snapshot()
    with pytest.raises(RuntimeError, match="injected Goals SQL fault"):
        service.execute(db.context(), command)
    assert observed == [True]
    assert db.snapshot() == before
    assert db.service.read_operation(db.context(), command.request_key) == {"status": "unknown"}
    receipt = db.service.execute(db.context(), command)
    assert receipt["changed"]
    snapshot = db.snapshot()
    assert len(snapshot["identities"]) == len(snapshot["catalog"]) == 1
    assert len(snapshot["listening_goals"]) == len(snapshot["listening_goal_operations"]) == 1


def test_reset_fault_restores_current_cycle_and_preserves_history_atomically(db):
    db.add()
    state = db.service.read(db.context())
    command = db.reset_command(state)
    observed = []

    def after(sql, params):
        if sql.startswith("update app.listening_goal_cycles set closed_at"):
            observed.append(True)
            raise RuntimeError("injected archive fault")

    before = db.snapshot()
    with pytest.raises(RuntimeError, match="injected archive fault"):
        db.service_for(after=after).execute(db.context(), command)
    assert observed == [True] and db.snapshot() == before
    assert db.service.read(db.context()) == state
    assert db.history()["cycles"] == []
    assert db.service.execute(db.context(), command)["changed"]


@pytest.mark.parametrize("revocation", ["disabled", "inactive", "session_revoked", "session_expired"])
def test_live_account_and_session_authority_gates_reads_replays_writes_and_provider(db, revocation):
    receipt, command = db.add()
    fresh = db.acquire()
    with db.connect() as connection:
        if revocation == "disabled":
            connection.execute("update app.accounts set disabled_at=%s,is_active=false where id=%s",
                               (db.now, db.owner.account_id))
        elif revocation == "inactive":
            connection.execute("update app.accounts set is_active=false where id=%s", (db.owner.account_id,))
        elif revocation == "session_revoked":
            connection.execute("update app.account_sessions set revoked_at=%s where id=%s",
                               (db.now, db.owner.session_id))
        else:
            connection.execute("update app.account_sessions set idle_expires_at=%s where id=%s",
                               (db.now, db.owner.session_id))
    before, provider_calls = db.snapshot(), list(db.provider_calls)
    calls = (
        lambda: db.service.read(db.context()), lambda: db.history(),
        lambda: db.service.read_operation(db.context(), command.request_key),
        lambda: db.service.execute(db.context(), command),
        lambda: db.service.execute(db.context(), db.add_command(fresh, revision=receipt["revision"])),
        lambda: db.acquire(),
    )
    for call in calls:
        assert_error(call, "forbidden", 403)
    assert db.snapshot() == before and db.provider_calls == provider_calls


@pytest.mark.parametrize("forged_field", ["account_id", "session_id"])
def test_forged_actor_cannot_pair_another_active_account_or_session(db, forged_field):
    receipt, original = db.add()
    evidence = db.acquire()
    state = db.service.read(db.context())
    other = db.other_actor()
    # Both IDs are real and active. Only their claimed account/session pairing
    # is invalid, so neither cached actor flags nor ID existence is authority.
    forged = replace(db.owner, **{forged_field: getattr(other, forged_field)})
    context = db.context(forged)
    ref = db.group()
    calls = (
        lambda: db.service.read(context),
        lambda: db.service.history(context, period="week", cursor_secret=CURSOR_SECRET),
        lambda: db.service.read_operation(context, original.request_key),
        lambda: db.service.execute(context, original),
        lambda: db.service.execute(context, db.add_command(evidence, revision=receipt["revision"])),
        lambda: db.service.execute(context, db.reset_command(state)),
        lambda: db.service.acquire_evidence(context, ref),
    )
    before, provider_calls = db.snapshot(), list(db.provider_calls)
    for call in calls:
        assert_error(call, "forbidden", 403)
    assert db.snapshot() == before and db.provider_calls == provider_calls


@pytest.mark.parametrize("operation", ["acquire", "add", "reset", "read", "history", "operation", "replay"])
def test_action_constraints_are_rechecked_for_every_account_entry_point(db, operation):
    receipt, command = db.add()
    evidence = db.acquire()
    state = db.service.read(db.context())
    denied = PolicyEvaluationConstraints(request_origin_allowed=False)
    calls = {
        "acquire": lambda: db.service.acquire_evidence(db.context(), db.group(), constraints=denied),
        "add": lambda: db.service.execute(db.context(),
            db.add_command(evidence, revision=receipt["revision"]), constraints=denied),
        "reset": lambda: db.service.execute(db.context(), db.reset_command(state), constraints=denied),
        "read": lambda: db.service.read(db.context(), constraints=denied),
        "history": lambda: db.service.history(db.context(), period="week", cursor_secret=CURSOR_SECRET,
                                             constraints=denied),
        "operation": lambda: db.service.read_operation(db.context(), command.request_key, constraints=denied),
        "replay": lambda: db.service.execute(db.context(), command, constraints=denied),
    }
    before, provider_calls = db.snapshot(), list(db.provider_calls)
    assert_error(calls[operation], "forbidden", 403)
    assert db.snapshot() == before and db.provider_calls == provider_calls


@pytest.mark.parametrize("operation,checkpoint", [
    ("acquire", "insert into app.listening_goal_evidence"),
    ("add", "insert into app.listening_goal_operations"),
    ("reset", "insert into app.listening_goal_operations"),
    ("read", "select * from app.listening_goal_cycle_items"),
    ("history", "select * from app.listening_goal_cycles"),
    ("operation", "select receipt from app.listening_goal_operations"),
    ("replay", "select original_session_id,command_digest,receipt"),
])
def test_expiry_after_sql_rejects_response_and_rolls_back_before_commit(db, operation, checkpoint):
    receipt, original = db.add()
    evidence = db.acquire()
    state = db.service.read(db.context())
    command = db.add_command(evidence, revision=receipt["revision"])
    reset = db.reset_command(state)
    ref = db.group()
    advanced = []
    initial_now = db.now

    def after(sql, params):
        if sql.startswith(checkpoint):
            advanced.append(True)
            db.now = initial_now + timedelta(days=2)

    service = db.service_for(after=after)
    calls = {
        "acquire": lambda: service.acquire_evidence(db.context(), ref),
        "add": lambda: service.execute(db.context(), command),
        "reset": lambda: service.execute(db.context(), reset),
        "read": lambda: service.read(db.context()),
        "history": lambda: service.history(db.context(), period="week", cursor_secret=CURSOR_SECRET),
        "operation": lambda: service.read_operation(db.context(), original.request_key),
        "replay": lambda: service.execute(db.context(), original),
    }
    before = db.snapshot()
    assert_error(calls[operation], "forbidden", 403)
    assert advanced == [True], "The real operation must reach its post-authority expiry checkpoint"
    assert db.snapshot() == before


def test_provider_lookup_holds_no_account_lock_and_rechecks_revoked_session(db):
    ref = db.group()
    callbacks = []

    def provider(group, **options):
        # If acquisition retains an account/session lock across IO, this real
        # second connection times out instead of silently accepting the test.
        with db.connect() as connection:
            connection.execute("set local lock_timeout = '5s'")
            connection.execute("update app.account_sessions set revoked_at=%s where id=%s",
                               (db.now, db.owner.session_id))
        callbacks.append(True)
        return db.provider(group, **options)

    before = db.snapshot()
    assert_error(lambda: db.acquire(ref, service=db.service_for(provider=provider)), "forbidden", 403)
    assert callbacks == [True] and db.snapshot() == before


@pytest.mark.parametrize("code", ["provider_unavailable", "provider_cancelled", "invalid_provider_metadata"])
def test_failed_provider_creates_no_success_evidence_or_catalog(db, code):
    def provider(*args, **options):
        raise RemoteAlbumEvidenceError(code)

    ref = db.group()
    before = db.snapshot()
    assert_error(lambda: db.acquire(ref, service=db.service_for(provider=provider)), code, 503)
    assert db.snapshot() == before


def test_provider_cancellation_after_valid_facts_creates_no_evidence(db):
    cancelled = [False]

    def provider(group, **options):
        facts = db.provider(group, **options)
        cancelled[0] = True
        return facts

    ref = db.group()
    before = db.snapshot()
    assert_error(lambda: db.service_for(provider=provider).acquire_evidence(
        db.context(), ref, should_cancel=lambda: cancelled[0]), "provider_cancelled", 503)
    assert db.snapshot() == before


@pytest.mark.parametrize("checkpoint", ["evidence_insert", "final_session_check"])
def test_cancellation_during_real_sql_rolls_back_evidence_before_commit(db, checkpoint):
    db.acquire()
    ref = db.group()
    cancelled = [False]
    inserted, final_session_checks, flipped = [], [], []

    def after(sql, params):
        if sql.startswith("insert into app.listening_goal_evidence"):
            inserted.append(True)
            if checkpoint == "evidence_insert":
                cancelled[0] = True
                flipped.append(checkpoint)
        elif inserted and "from app.account_sessions" in sql and "for update" in sql:
            # This is the real final session lookup after the evidence write,
            # not either pre-provider or write-phase entry authorization.
            final_session_checks.append(True)
            if checkpoint == "final_session_check":
                cancelled[0] = True
                flipped.append(checkpoint)

    def should_cancel():
        return cancelled[0]

    before = db.snapshot()
    assert_error(lambda: db.service_for(after=after).acquire_evidence(
        db.context(), ref, should_cancel=should_cancel), "provider_cancelled", 503)
    assert inserted == [True], "Cancellation must arrive after a real evidence INSERT"
    assert flipped == [checkpoint]
    assert final_session_checks == ([True] if checkpoint == "final_session_check" else [])
    assert db.provider_calls[-1] == (ref, USER_AGENT, should_cancel)
    assert db.snapshot() == before, "The inserted evidence must roll back with the transaction"


def test_pending_evidence_limit_and_expired_slot_boundary_are_explicit(db):
    assert EVIDENCE_LIFETIME == timedelta(minutes=30) and MAX_PENDING_EVIDENCE == 100
    evidence = db.acquire()
    # Seed immutable, identically validated fact snapshots under the migrator to
    # reach the real SQL limit without 99 redundant provider transactions.
    with db.connect() as connection:
        for _ in range(MAX_PENDING_EVIDENCE - 1):
            connection.execute("""insert into app.listening_goal_evidence
                (ref,account_id,original_session_id,provider,entity_kind,external_id,evidence_version,
                 title,artist_display,first_release_date,primary_type,created_at,expires_at)
                select %s,account_id,original_session_id,provider,entity_kind,external_id,evidence_version,
                       title,artist_display,first_release_date,primary_type,created_at,expires_at
                from app.listening_goal_evidence where ref=%s""", (str(uuid4()), evidence["evidence_ref"]))
    ref = db.group()
    before = db.snapshot()
    assert len(before["listening_goal_evidence"]) == MAX_PENDING_EVIDENCE
    assert_error(lambda: db.acquire(ref), "evidence_limit", 429)
    assert db.snapshot() == before
    db.now = datetime.fromisoformat(evidence["expires_at"])
    renewed = db.acquire(ref)
    assert renewed["evidence_ref"] != evidence["evidence_ref"]
    assert len(db.snapshot()["listening_goal_evidence"]) == MAX_PENDING_EVIDENCE + 1


def test_reset_retains_assignments_archives_marks_and_leaves_larger_periods_unchanged(db):
    receipt, _ = db.add()
    with db.connect() as connection:
        connection.execute("""update app.listening_goal_cycle_items set manual_completed_at=%s
            where account_id=%s and catalog_ref=%s""", (db.now, db.owner.account_id, receipt["catalog_ref"]))
    before = db.snapshot()
    state = db.service.read(db.context())
    assert all(state["periods"][period]["completed"] == 1 for period in PERIODS)
    db.now += timedelta(minutes=1)
    reset = db.service.execute(db.context(), db.reset_command(state))
    current = db.service.read(db.context())
    assert reset["changed"] and current["periods"]["week"]["completed"] == 0
    assert current["periods"]["week"]["album_refs"] == state["periods"]["week"]["album_refs"]
    assert db.snapshot()["listening_goal_assignments"] == before["listening_goal_assignments"]
    for period in PERIODS[1:]:
        assert current["periods"][period] == state["periods"][period]
    archived = db.history()["cycles"][0]
    assert archived["cycle_id"] == receipt["cycle_id"]
    assert archived["albums"][0]["manual_completed_at"] == (db.now - timedelta(minutes=1)).isoformat()
    retained = db.history()
    db.service.execute(db.context(), db.reset_command(current))
    assert db.history()["cycles"][0] == retained["cycles"][0]


def test_reset_rejects_foreign_or_stale_cycle_without_archiving(db):
    db.add()
    state = db.service.read(db.context())
    db.service.execute(db.context(), db.reset_command(state))
    current = db.service.read(db.context())
    before = db.snapshot()
    for cycle in (state["periods"]["week"]["cycle"]["cycle_id"], str(uuid4()), None):
        command = db.reset_command(current, expected_cycle_id=cycle)
        assert_error(lambda: db.service.execute(db.context(), command), "cycle_conflict", 409)
    assert db.snapshot() == before


def test_history_paginates_equal_timestamps_without_duplicates_and_is_private(db):
    db.add()
    expected = []
    for _ in range(4):
        current = db.service.read(db.context())
        expected.append(current["periods"]["week"]["cycle"]["cycle_id"])
        db.service.execute(db.context(), db.reset_command(current))
    first = db.history(limit=2)
    assert [cycle["cycle_id"] for cycle in first["cycles"]] == expected[:2]
    assert isinstance(first["next_cursor"], str)
    second = db.history(limit=2, cursor=first["next_cursor"])
    assert [cycle["cycle_id"] for cycle in second["cycles"]] == expected[2:]
    assert second["next_cursor"] is None
    assert len({cycle["closed_at"] for cycle in first["cycles"] + second["cycles"]}) == 1
    assert_private(first)
    assert_private(second)


@pytest.mark.parametrize("scope", ["account", "session", "period", "revision"])
def test_history_cursor_cannot_be_reused_outside_its_original_scope(db, scope):
    db.add()
    for _ in range(2):
        db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    cursor = db.history(limit=1)["next_cursor"]
    actor, period = db.owner, "week"
    if scope == "account":
        actor = db.other_actor()
    elif scope == "session":
        actor = db.renewed_actor()
    elif scope == "period":
        period = "month"
    else:
        db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    before = db.snapshot()
    assert_error(lambda: db.history(actor=actor, period=period, cursor=cursor), "invalid_cursor", 400)
    assert db.snapshot() == before


def test_current_and_history_survive_library_membership_and_library_removal(db):
    with db.connect() as connection:
        library = connection.execute("""insert into library.libraries(owner_account_id,name)
            values(%s,%s) returning id""", (db.owner.account_id, "Empty Goals library " + db.token)).fetchone()["id"]
        db.library_ids.append(library)
        connection.execute("""insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')""", (db.owner.account_id, library))
    linked = replace(db.owner, current_library_id=library,
                     library_relationships=(LibraryRelationship(library, "member", False),))
    receipt, _ = db.add(actor=linked)
    db.service.execute(db.context(linked), db.reset_command(db.service.read(db.context(linked))))
    current, history = db.service.read(db.context(linked)), db.history(actor=linked)
    before = db.snapshot()
    with db.connect() as connection:
        assert connection.execute("select count(*) as n from library.local_albums where library_id=%s",
                                  (library,)).fetchone()["n"] == 0
        connection.execute("delete from library.library_memberships where account_id=%s and library_id=%s",
                           (db.owner.account_id, library))
        connection.execute("delete from library.libraries where id=%s", (library,))
    assert db.service.read(db.context()) == current
    assert db.history() == history
    # Even a cached current-library hint cannot make account Goals library-owned.
    assert db.service.read(db.context(linked)) == current
    assert db.snapshot() == before
    assert current["albums"][0]["catalog_ref"] == receipt["catalog_ref"]


def test_expired_evidence_does_not_roll_over_current_cycles_or_remove_history(db):
    evidence = db.acquire()
    db.add(evidence)
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    current, history = db.service.read(db.context()), db.history()
    db.now += timedelta(days=400)
    fresh_session = db.renewed_actor()
    before = db.snapshot()
    assert db.service.read(db.context(fresh_session)) == current
    assert db.history(actor=fresh_session) == history
    assert db.snapshot() == before


@pytest.mark.parametrize("violation", ["album_goal", "album_evidence", "assignment_album", "item_album"])
def test_runtime_composite_foreign_keys_reject_cross_account_goal_links(db, violation):
    import psycopg

    own, _ = db.add()
    other = db.other_actor()
    ref = db.group()
    foreign_evidence = db.acquire(ref, actor=other)
    foreign, _ = db.add(foreign_evidence, actor=other)
    own_evidence = db.acquire(ref)
    assert own["goal_ref"] != foreign["goal_ref"]
    assert own["catalog_ref"] != foreign["catalog_ref"]
    assert own_evidence["album"] == foreign_evidence["album"]
    account, goal = db.owner.account_id, own["goal_ref"]
    if violation in {"album_goal", "album_evidence"}:
        # The catalog album exists globally but has not been admitted by this
        # owner. Its metadata and an owner-bound evidence version are available;
        # replace exactly one foreign ownership component in each negative case.
        album = own_evidence["album"]
        evidence = foreign_evidence if violation == "album_evidence" else own_evidence
        sql = """insert into app.listening_goal_albums
            (account_id,goal_ref,catalog_ref,original_position,title,artist_display,
             first_release_date,primary_type,evidence_ref,evidence_version,admitted_at)
            values(%s,%s,%s,2,%s,%s,%s,%s,%s,%s,%s)"""
        params = (account, foreign["goal_ref"] if violation == "album_goal" else goal,
                  foreign["catalog_ref"], album["title"], album["artist_display"],
                  album["first_release_date"], album["primary_type"],
                  evidence["evidence_ref"], evidence["evidence_version"], db.now)
        table = "app.listening_goal_albums"
        if violation == "album_goal":
            columns, referenced_table, referenced_columns = (
                ["account_id", "goal_ref"], "app.listening_goals", ["account_id", "ref"])
        else:
            columns, referenced_table, referenced_columns = (
                ["account_id", "evidence_ref", "evidence_version"], "app.listening_goal_evidence",
                ["account_id", "ref", "evidence_version"])
    else:
        columns = referenced_columns = ["account_id", "goal_ref", "catalog_ref"]
        referenced_table = "app.listening_goal_albums"
        if violation == "assignment_album":
            table = "app.listening_goal_assignments"
            sql = """insert into app.listening_goal_assignments
                (assignment_id,account_id,goal_ref,catalog_ref,period,assigned_at,position)
                values(%s,%s,%s,%s,'week',%s,2)"""
            params = (str(uuid4()), account, goal, foreign["catalog_ref"], db.now)
        else:
            table = "app.listening_goal_cycle_items"
            # Use the owner's actual current cycle, so the retention trigger
            # passes and the composite album FK is the rejecting authority.
            sql = """insert into app.listening_goal_cycle_items
                (account_id,goal_ref,cycle_id,catalog_ref,position,manual_completed_at)
                values(%s,%s,%s,%s,2,null)"""
            params = (account, goal, own["cycle_id"], foreign["catalog_ref"])
    before = db.snapshot()
    with db.connect() as connection:
        # PostgreSQL chooses names for these declared composite FKs. Match the
        # actual columns and referenced relation instead of guessing a name or
        # accepting an unrelated FK, uniqueness or privilege failure.
        constraints = connection.execute("""select c.conname,
            array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,n)
                  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
                  order by k.n) as columns,
            array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum,n)
                  join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum
                  order by k.n) as referenced_columns
            from pg_constraint c where c.contype='f'
            and c.conrelid=%s::regclass and c.confrelid=%s::regclass""",
            (table, referenced_table)).fetchall()
    expected_names = [row["conname"] for row in constraints
                      if row["columns"] == columns and row["referenced_columns"] == referenced_columns]
    assert len(expected_names) == 1, "The exact account-bound composite FK must exist"
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute(sql, params)
    assert (caught.value.sqlstate, caught.value.diag.constraint_name) == ("23503", expected_names[0])
    assert db.snapshot() == before


def test_runtime_cannot_insert_a_new_admitted_album_into_a_closed_cycle(db):
    import psycopg

    archived, _ = db.add()
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    added, _ = db.add()
    before = db.snapshot()
    assert added["goal_ref"] == archived["goal_ref"]
    assert added["catalog_ref"] != archived["catalog_ref"]
    assert added["cycle_id"] != archived["cycle_id"]
    archived_items = [row for row in before["listening_goal_cycle_items"]
                      if str(row["cycle_id"]) == archived["cycle_id"]]
    assert [(str(row["catalog_ref"]), row["position"]) for row in archived_items] == [
        (archived["catalog_ref"], 1),
    ]
    # The album is already admitted to this account and goal; neither its key
    # nor position is present in the old cycle. INSERT is a runtime grant, so
    # only the retention trigger should reject this otherwise-valid write.
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute("""insert into app.listening_goal_cycle_items
                (account_id,goal_ref,cycle_id,catalog_ref,position,manual_completed_at)
                values(%s,%s,%s,%s,2,null)""",
                (db.owner.account_id, archived["goal_ref"], archived["cycle_id"], added["catalog_ref"]))
    assert caught.value.sqlstate == "23514"
    assert caught.value.diag.constraint_name == "listening_goal_archive_items_immutable"
    assert db.snapshot() == before


def test_runtime_cannot_rewrite_archived_items_cycles_or_admission_metadata(db):
    import psycopg

    receipt, _ = db.add()
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    before = db.snapshot()
    statements = (
        ("update app.listening_goal_cycles set closed_at=closed_at where cycle_id=%s", (receipt["cycle_id"],)),
        ("delete from app.listening_goal_cycles where cycle_id=%s", (receipt["cycle_id"],)),
        ("update app.listening_goal_albums set title='Rewritten' where account_id=%s", (db.owner.account_id,)),
        ("delete from app.listening_goal_cycle_items where cycle_id=%s", (receipt["cycle_id"],)),
        ("update catalog.release_group_provider_identities set catalog_ref=%s where catalog_ref=%s",
         (receipt["catalog_ref"], receipt["catalog_ref"])),
    )
    for sql, params in statements:
        with pytest.raises(psycopg.Error) as caught:
            with db.connector()(db.app_url) as connection:
                connection.execute(sql, params)
        assert caught.value.sqlstate in {"42501", "23514"}
    assert db.snapshot() == before


def test_goals_tables_have_no_public_or_readonly_access_and_no_runtime_deletes(db):
    tables = ["app." + table for table in GOAL_TABLES] + ["catalog.release_group_provider_identities"]
    with db.connect() as connection:
        for table in tables:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                row = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    (table, privilege, table, privilege)).fetchone()
                # UPDATE is granted only for named columns, not whole tables.
                assert row == {"app": privilege in {"SELECT", "INSERT"}, "readonly": False}, (table, privilege)
            assert connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) p
                where c.oid=%s::regclass and p.grantee=0""", (table,)).fetchone()["n"] == 0
        for table, columns in (
            ("app.listening_goals", ("revision", "updated_at")),
            ("app.listening_goal_cycles", ("closed_at",)),
            ("app.listening_goal_evidence", ("revoked_at",)),
        ):
            for column in columns:
                assert connection.execute("""select has_column_privilege(
                    'album_haven_app',%s,%s,'UPDATE') as allowed""", (table, column)).fetchone()["allowed"] is True
