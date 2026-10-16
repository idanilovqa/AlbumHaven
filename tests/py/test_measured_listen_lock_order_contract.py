"""Opt-in, real PostgreSQL common-lock-order contracts, authored without running.

Use the repository's ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL and
DATABASE_MIGRATOR_URL isolation convention. The normal migration runner must
already have provisioned the admission schema. This module never applies a
migration, creates a database/table, changes roles, or truncates shared data.

Two independent operation connections are coordinated at actual SQL boundaries;
a third read-only observer verifies PostgreSQL's blocker graph. There are no
operation/deadlock retries. Synthetic fixture rows alone are created and cleaned.
Mutation cases exercise the existing account-lock primitive plus owned-row SQL,
not the full administrator HTTP/service workflow. No decoder/provider I/O occurs.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import os
import re
from threading import Event
import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services import admin_authority
from music_app.services import listen_history_postgres
from music_app.services import measured_listen_admission as admission
from music_app.services import measured_listen_admission_postgres as persistence
from music_app.services import measured_listen_evidence as evidence
from music_app.services import measured_listen_history as measured
from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.private_library_authority import PrivateLibraryAuthorityError


GRANTS = ("library.browse.read", "library.media.read")
WAIT_SECONDS = 5
RESULT_SECONDS = 15
CONNECT_OPTIONS = ("-c lock_timeout=8000 -c statement_timeout=12000 "
                   "-c idle_in_transaction_session_timeout=20000")


@pytest.fixture(scope="module")
def urls():
    app = os.environ.get("ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL", "")
    setup = os.environ.get("DATABASE_MIGRATOR_URL", "")
    if not app:
        pytest.skip("Requires isolated PostgreSQL contract database; concurrency is unproved when skipped")
    a, s = urlparse(app), urlparse(setup)
    assert a.scheme in {"postgres", "postgresql"} and s.scheme in {"postgres", "postgresql"}
    assert a.hostname in {"127.0.0.1", "localhost", "::1"}
    assert (a.hostname, a.port, a.path) == (s.hostname, s.port, s.path)
    assert re.fullmatch(r"(?:album_haven_ci_|pytest_|album_haven_fake_e2e)[a-z0-9_]*", a.path.lstrip("/"))
    assert not a.query and not s.query
    return app, setup


class Database:
    def __init__(self, urls):
        self.app_url, self.setup_url = urls
        self.now = datetime.now(timezone.utc)
        self.accounts = []
        self.libraries = []

    def open(self, url, *, autocommit=False):
        import psycopg
        from psycopg.rows import dict_row
        assert url in {self.app_url, self.setup_url}
        # Startup options do not start a transaction before the authority owner
        # issues SET TRANSACTION ISOLATION LEVEL READ COMMITTED.
        return psycopg.connect(url, row_factory=dict_row, connect_timeout=5,
                               options=CONNECT_OPTIONS, autocommit=autocommit)

    def require_provisioned_schema(self):
        required = {
            "app.accounts", "app.account_sessions", "app.capabilities", "app.bootstrap_owners",
            "library.libraries", "library.library_memberships", "library.local_tracks",
            "library.local_track_files", "integration.listen_history", "integration.measured_listen_admission",
        }
        with self.open(self.setup_url) as con:
            missing = [table for table in sorted(required)
                       if con.execute("select to_regclass(%s) as relation", (table,)).fetchone()["relation"] is None]
            assert not missing, ("Provision the approved schema with the repository migration runner before "
                                 "opting in; missing: " + ", ".join(missing))
            columns = {row["column_name"] for row in con.execute(
                "select column_name from information_schema.columns "
                "where table_schema='integration' and table_name='measured_listen_admission'").fetchall()}
            assert {"decoder_instance_id", "account_id", "original_library_id", "original_track_id",
                    "original_file_id", "live_library_id", "live_track_id", "live_file_id",
                    "current_admission", "accepted_checkpoint", "accepted_admission", "accepted_digest",
                    "accepted_sequence", "receipt_body", "receipt_status", "accepted_at"} <= columns

    def scope(self, con):
        token = "measured-lock-" + uuid4().hex
        account = con.execute("""insert into app.accounts(display_name,account_kind,
            username_display,username_normalized,contact_email,contact_email_normalized)
            values(%s,'managed_user',%s,%s,%s,%s) returning id""",
            (token, token, token, token + "@example.test", token + "@example.test")).fetchone()["id"]
        self.accounts.append(account)
        session = con.execute("""insert into app.account_sessions(account_id,session_token_hash,
            created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at)
            values(%s,%s,%s,%s,%s,%s,%s) returning id""",
            (account, hashlib.sha256(uuid4().bytes).digest(), self.now, self.now, self.now,
             self.now + timedelta(hours=1), self.now + timedelta(days=1))).fetchone()["id"]
        library = con.execute("insert into library.libraries(owner_account_id,name) values(%s,%s) returning id",
                              (account, token)).fetchone()["id"]
        self.libraries.append(library)
        con.execute("insert into library.library_memberships(account_id,library_id,membership_role) "
                    "values(%s,%s,'member')", (account, library))
        for grant in GRANTS:
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) "
                        "values(%s,%s,'library',%s)", (account, grant, library))
        track = con.execute("insert into library.local_tracks(library_id,track_key,title,duration_seconds) "
                            "values(%s,%s,'Synthetic lock-order track',120) returning id",
                            (library, token)).fetchone()["id"]
        path = "/synthetic-measured-lock-order/" + token + ".flac"
        file_id = con.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s) returning id",
                              (track, path)).fetchone()["id"]
        actor = CurrentActor(state=ActorState.ACTIVE, account_id=account, session_id=session,
            authenticated_at=self.now, current_library_id=library,
            library_relationships=(LibraryRelationship(library, "member", False),),
            capability_grants=tuple(CapabilityGrant(grant, "library", library) for grant in GRANTS))
        return {"account_id": account, "library_id": library, "track_id": track, "file_id": file_id,
                "path": path, "actor": actor}

    def context(self, scope):
        return PolicyContext.build(actor=scope["actor"], action="library.media.read", library_id=scope["library_id"],
            deployment_mode="self_hosted", client_surface_class="private_web",
            request_origin=RequestOrigin("network", "synthetic:measured-lock-order"))

    def rows(self, scope):
        with self.open(self.setup_url) as con:
            ledger = con.execute("select * from integration.listen_history where library_id=%s order by id",
                                 (scope["library_id"],)).fetchall()
            sidecar = con.execute("select * from integration.measured_listen_admission "
                                  "where original_library_id=%s order by decoder_instance_id",
                                  (scope["library_id"],)).fetchall()
        return ledger, sidecar

    def close(self):
        with self.open(self.setup_url) as con:
            # Explicitly remove owned ledger rows before ON DELETE SET NULL can
            # detach their fixture scope. Never clean by global source family.
            con.execute("delete from integration.listen_history where library_id=any(%s)", (self.libraries,))
            con.execute("delete from integration.measured_listen_admission where original_library_id=any(%s)",
                        (self.libraries,))
            for library in self.libraries:
                con.execute("delete from library.libraries where id=%s", (library,))
            for account in self.accounts:
                con.execute("delete from app.accounts where id=%s", (account,))


@pytest.fixture
def db(urls):
    value = Database(urls)
    value.require_provisioned_schema()
    try:
        with value.open(value.setup_url) as con:
            value.own = value.scope(con)
            value.other = value.scope(con)
        yield value
    finally:
        value.close()


class Probe:
    """Observe real SQL and optionally hold its transaction after one lock.

    No lock simulation: execute always delegates to psycopg. Events only select
    scheduling, and pg_blocking_pids supplies evidence of an actual database wait.
    """
    def __init__(self, db, *, pause_after=None):
        self.db = db
        self.pause_after = pause_after
        self.paused = Event()
        self.release = Event()
        self.account_attempted = Event()
        self.account_acquired = Event()
        self.advisory_attempted = Event()
        self.advisory_acquired = Event()
        self.pid = None
        self.connections = 0
        self.commits = 0
        self.rollbacks = 0
        self.operations = []

    @contextmanager
    def connect(self, url):
        self.connections += 1
        try:
            with self.db.open(url) as real:
                self.pid = real.info.backend_pid
                probe = self

                class Connection:
                    def execute(self, sql, params=None):
                        normalized = " ".join(sql.casefold().split())
                        probe.operations.append((normalized, params))
                        stage = ("account" if normalized.startswith("with locked_accounts as (") else
                                 "advisory" if normalized == "select pg_advisory_xact_lock(%s)" else None)
                        if stage:
                            getattr(probe, stage + "_attempted").set()
                        result = real.execute(sql, params)
                        if stage:
                            getattr(probe, stage + "_acquired").set()
                            if probe.pause_after == stage:
                                probe.paused.set()
                                assert probe.release.wait(timeout=12), "Coordinator did not release owned lock"
                        return result

                yield Connection()
            # Reached only after psycopg's actual transaction commit completes.
            self.commits += 1
        except BaseException:
            self.rollbacks += 1
            raise


def ordinary_entry(scope, *, device=None, session=None):
    return {"measurement_version": "rendered-pcm-v1", "device_id": device or str(uuid4()),
            "session_id": session or str(uuid4()), "sequence": 1,
            "measured_listened_seconds": 12.5, "max_measured_contiguous_seconds": 11.0,
            "finalized": False, "path": scope["path"], "track_ref": scope["path"],
            "canonical_match": {"library_track_id": str(scope["track_id"])},
            "started_at": "2026-10-16T00:00:00+00:00",
            "source_provenance": {"kind": "local_playback", "provider": "album_haven"}, "scrobbled": False}


def observation(scope, item, *, session=None):
    identity = admission.AdmissionIdentity(
        evidence.EvidenceScope(scope["account_id"], scope["library_id"], scope["track_id"]),
        item["device_id"], session or item["session_id"], 8000, str(uuid4()))
    return admission.AdmissionMetadata(identity, 0, ((0, 8000),))


def run_ordinary(db, scope, item, probe):
    adapter = listen_history_postgres.PostgresListenHistoryAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url}, connect=probe.connect)
    return measured.append_measured(adapter, item, account_id=scope["account_id"], library_id=scope["library_id"])


def run_observation(db, scope, metadata, probe):
    return persistence.record_observation(db.app_url, db.context(scope), metadata, scope["path"],
        max_instances=8, cancelled=lambda: False, connect=probe.connect, clock=lambda: db.now)


def assert_real_account_wait(db, holder, waiter, future):
    assert waiter.account_attempted.wait(timeout=WAIT_SECONDS), "Waiter never attempted the account lock"
    deadline = time.monotonic() + WAIT_SECONDS
    last = None
    with db.open(db.setup_url, autocommit=True) as observer:
        while time.monotonic() < deadline:
            last = observer.execute("""select pg_blocking_pids(%s) as blockers,
                (select count(*) from pg_locks where pid=%s and locktype='advisory') as advisory_locks""",
                (waiter.pid, waiter.pid)).fetchone()
            if holder.pid in last["blockers"]:
                break
            if future.done():
                # Surface SQL/permission failures instead of disguising them as a timeout.
                future.result()
                pytest.fail("Second operation completed without waiting for the held account lock")
            time.sleep(0.01)
        else:
            pytest.fail(f"No PostgreSQL account blocker observed: {last!r}")
    assert not waiter.account_acquired.is_set()
    assert not waiter.advisory_attempted.is_set(), "Waiter reached advisory before obtaining the account lock"
    assert last["advisory_locks"] == 0 and not future.done()


def wait_for_pause(probe, future):
    if not probe.paused.wait(timeout=WAIT_SECONDS):
        if future.done():
            future.result()
        pytest.fail("First operation did not reach its requested lock boundary")


def assert_one_commit(probe):
    assert probe.connections == 1 and probe.commits == 1 and probe.rollbacks == 0
    account_positions = [n for n, (sql, _) in enumerate(probe.operations) if sql.startswith("with locked_accounts as (")]
    advisory_positions = [n for n, (sql, _) in enumerate(probe.operations) if sql == "select pg_advisory_xact_lock(%s)"]
    assert len(account_positions) == len(advisory_positions) == 1
    assert account_positions[0] < advisory_positions[0]


def assert_admission_row(row, scope, metadata):
    assert str(row["decoder_instance_id"]) == metadata.identity.decoder_instance_id
    assert (row["account_id"], row["original_library_id"], row["original_track_id"], row["original_file_id"]) == (
        scope["account_id"], scope["library_id"], scope["track_id"], scope["file_id"])
    assert str(row["session_id"]) == metadata.identity.session_id
    assert row["current_admission"] == {"metadata_revision": 0, "observed_intervals": [[0, 8000]],
        "extent_state": "observed_partial", "verified_total_frames": None,
        "extent_provenance": None, "admission_limited": False}
    assert row["lifecycle_state"] == "open" and row["retirement_reason"] is None
    assert all(row[name] is None for name in ("accepted_checkpoint", "accepted_admission", "accepted_digest",
               "accepted_sequence", "receipt_body", "receipt_status", "accepted_at"))


@pytest.mark.parametrize("first_kind", ["ordinary", "observation"])
@pytest.mark.parametrize("same_session", [True, False])
def test_first_append_and_observation_overlap_commit_once_in_both_orders(db, first_kind, same_session):
    scope = db.own
    item = ordinary_entry(scope)
    metadata = observation(scope, item, session=None if same_session else str(uuid4()))
    # Ordinary first: hold its identity lock. Admission first: hold its account
    # lock before advisory. Each exposes one side of the previously possible cycle.
    leader = Probe(db, pause_after="advisory" if first_kind == "ordinary" else "account")
    follower = Probe(db)
    ordinary_probe = leader if first_kind == "ordinary" else follower
    admission_probe = follower if first_kind == "ordinary" else leader
    ordinary_call = lambda: run_ordinary(db, scope, item, ordinary_probe)
    admission_call = lambda: run_observation(db, scope, metadata, admission_probe)
    first, second = (ordinary_call, admission_call) if first_kind == "ordinary" else (admission_call, ordinary_call)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(first)
        try:
            wait_for_pause(leader, first_future)
            assert leader.account_acquired.is_set()
            second_future = pool.submit(second)
            assert_real_account_wait(db, leader, follower, second_future)
        finally:
            leader.release.set()
        first_result = first_future.result(timeout=RESULT_SECONDS)
        second_result = second_future.result(timeout=RESULT_SECONDS)
    ordinary_result, observation_result = ((first_result, second_result) if first_kind == "ordinary"
                                          else (second_result, first_result))
    assert observation_result == metadata
    for probe in (leader, follower):
        assert_one_commit(probe)
    ledger, sidecar = db.rows(scope)
    assert len(ledger) == len(sidecar) == 1
    identity = f"{scope['account_id']}:{scope['library_id']}:{item['device_id']}:{item['session_id']}"
    expected_id = hashlib.sha256(identity.encode()).hexdigest()
    assert ordinary_result["id"] == expected_id
    assert ledger[0]["source_entry_id"] == identity and ledger[0]["source_family"] == "rendered_local_listen_session"
    assert ledger[0]["metadata"]["source_payload"] == ordinary_result
    assert ledger[0]["last_sequence"] == 1 and float(ledger[0]["measured_listened_seconds"]) == 12.5
    assert_admission_row(sidecar[0], scope, metadata)
    ordinary_key = [params for sql, params in ordinary_probe.operations if sql == "select pg_advisory_xact_lock(%s)"][0]
    admitted_key = [params for sql, params in admission_probe.operations if sql == "select pg_advisory_xact_lock(%s)"][0]
    assert ordinary_key == (int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True),)
    assert (ordinary_key == admitted_key) is same_session
    assert sum(sql.startswith("insert into integration.listen_history") for sql, _ in ordinary_probe.operations) == 1
    assert sum(sql.startswith("insert into integration.measured_listen_admission") for sql, _ in admission_probe.operations) == 1


def test_distinct_account_observation_commits_while_first_account_is_held(db):
    item = ordinary_entry(db.own)
    other_item = ordinary_entry(db.other, device=item["device_id"], session=item["session_id"])
    metadata = observation(db.other, other_item)
    holder, independent = Probe(db, pause_after="account"), Probe(db)
    with ThreadPoolExecutor(max_workers=2) as pool:
        held = pool.submit(run_ordinary, db, db.own, item, holder)
        try:
            wait_for_pause(holder, held)
            free = pool.submit(run_observation, db, db.other, metadata, independent)
            assert free.result(timeout=WAIT_SECONDS) == metadata
            assert independent.commits == 1 and holder.commits == 0 and not held.done()
        finally:
            holder.release.set()
        held.result(timeout=RESULT_SECONDS)
    assert_one_commit(holder)
    assert_one_commit(independent)
    assert tuple(map(len, db.rows(db.own))) == (1, 0)
    assert tuple(map(len, db.rows(db.other))) == (0, 1)


def test_real_provider_guard_does_not_hold_account_while_inner_append_commits(db, monkeypatch):
    outer, inner = Probe(db), Probe(db)
    # Targeted connector seam only; both paths use independent real PostgreSQL
    # connections, and the ordinary adapter retains its explicit inner connector.
    monkeypatch.setattr(listen_history_postgres, "_connect", outer.connect)
    item = ordinary_entry(db.own)
    with measured.measured_provider_guard({"ALBUM_HAVEN_APP_DATABASE_URL": db.app_url},
            account_id=db.own["account_id"], library_id=db.own["library_id"],
            device_id=item["device_id"], session_id=item["session_id"]):
        result = run_ordinary(db, db.own, item, inner)
        assert inner.commits == 1 and outer.commits == 0
        assert outer.pid != inner.pid
        assert not outer.account_attempted.is_set()
        # This is the existing provider submission boundary, not a network call.
        assert db.rows(db.own)[0][0]["metadata"]["source_payload"] == result
    assert_one_commit(inner)
    assert outer.connections == outer.commits == 1 and outer.rollbacks == 0
    identity = f"provider:{db.own['account_id']}:{db.own['library_id']}:{item['device_id']}:{item['session_id']}"
    key = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)
    assert outer.operations == [("select pg_advisory_xact_lock(%s)", (key,))]


def mutate_owned_account(db, scope, mutation, probe):
    with probe.connect(db.setup_url) as con:
        admin_authority.lock_admin_accounts(con, scope["account_id"], scope["account_id"])
        if mutation == "disable":
            con.execute("update app.accounts set is_active=false,disabled_at=%s where id=%s",
                        (db.now, scope["account_id"]))
        else:
            assert mutation == "delete"
            con.execute("delete from app.accounts where id=%s", (scope["account_id"],))


@pytest.mark.parametrize("mutation", ["disable", "delete"])
@pytest.mark.parametrize("first_kind", ["mutation", "observation"])
def test_account_mutation_and_admission_use_same_lock_order_without_partial_evidence(db, mutation, first_kind):
    scope = db.own
    metadata = observation(scope, ordinary_entry(scope))
    leader = Probe(db, pause_after="account")
    follower = Probe(db)
    mutation_probe = leader if first_kind == "mutation" else follower
    admission_probe = follower if first_kind == "mutation" else leader
    mutation_call = lambda: mutate_owned_account(db, scope, mutation, mutation_probe)
    admission_call = lambda: run_observation(db, scope, metadata, admission_probe)
    first, second = ((mutation_call, admission_call) if first_kind == "mutation"
                     else (admission_call, mutation_call))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(first)
        try:
            wait_for_pause(leader, first_future)
            second_future = pool.submit(second)
            assert_real_account_wait(db, leader, follower, second_future)
        finally:
            leader.release.set()
        first_result = first_future.result(timeout=RESULT_SECONDS)
        if first_kind == "mutation":
            with pytest.raises(PrivateLibraryAuthorityError):
                second_future.result(timeout=RESULT_SECONDS)
            assert admission_probe.connections == admission_probe.rollbacks == 1
            assert admission_probe.commits == 0 and not admission_probe.advisory_attempted.is_set()
        else:
            assert first_result == metadata
            second_future.result(timeout=RESULT_SECONDS)
            assert_one_commit(admission_probe)
    assert mutation_probe.connections == mutation_probe.commits == 1 and mutation_probe.rollbacks == 0
    ledger, sidecar = db.rows(scope)
    assert ledger == []
    if first_kind == "observation" and mutation == "disable":
        assert len(sidecar) == 1
        assert_admission_row(sidecar[0], scope, metadata)
    else:
        assert sidecar == []
    with db.open(db.setup_url) as con:
        account = con.execute("select is_active,disabled_at from app.accounts where id=%s",
                              (scope["account_id"],)).fetchone()
    if mutation == "delete":
        assert account is None
    else:
        assert account == {"is_active": False, "disabled_at": db.now}
