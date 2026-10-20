"""Real-role C2-A state, byte, identity, cutoff and cleanup contracts.

Authored source only. SQL/provider/app execution is root-owned. No low testing
quotas, fake query results, cutoff-trigger bypass or immutable-time rewrites.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from math import isfinite
from threading import Barrier
from time import monotonic, sleep
from uuid import UUID, uuid4

import psycopg
import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.remote_top_postgres_support import CONTEXT, STORE_SQL, runtime, sql_error, evidence
from tests.py.test_album_top_remote_membership_postgres import mixed
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.remote_top_postgres_support import remote
from tests.py.remote_top_postgres_support import prepared_payload
from tests.py.remote_preparation_postgres_support import preparations, db, urls


def invoke(connection, function, args):
    return connection.execute("select app." + function + "(" + ",".join(["%s"] * len(args))
        + ") as result", args).fetchone()["result"]


def wait_until(case, instant):
    # Wait against PostgreSQL's actual clock; no caller clock/GUC changes.
    with runtime(case.db) as connection:
        connection.execute("select pg_sleep(greatest(0,extract(epoch from %s::timestamptz-clock_timestamp()))+0.05)",
            (instant,)).fetchone()


def test_status_is_bounded_opaque_read_only_and_first_begin_requests_initialization(preparations):
    case = preparations
    status = case.status()
    assert status["parents"] == [] and status["capacity"]["counts_complete"] is False
    assert case.state()["album_top_remote_pending_budgets"] == []
    parent, target = case.begin(initialize=False)
    assert parent["state"] == "maintenance_required"
    assert parent["resource"] == "legacy_initialization"
    assert case.state()["album_top_remote_preparations"] == []
    step = case.maintain()
    assert step["branch"] == "legacy_initialization" and step["inspected"] == 0
    assert step["capacity"]["counts_complete"] is True
    parent, _ = case.begin(target, initialize=False)
    repeated, _ = case.begin(target, initialize=False)
    assert repeated["preparation_ref"] == parent["preparation_ref"]
    assert repeated["attempt_count"] == 0
    summary = case.status()["parents"][0]
    assert summary["state"] == "accepting"
    assert not {"destination_ref", "destination_kind", "library_id", "title", "context_ref"} & summary.keys()
    created = datetime.fromisoformat(summary["created_at"])
    assert (datetime.fromisoformat(summary["accepts_until"]) - created).total_seconds() == 1800
    assert (datetime.fromisoformat(summary["fully_expires_at"]) - created).total_seconds() == 3600


def test_indexable_candidate_cutoffs_keep_authoritative_mutation_clocks(preparations):
    # Query-plan optimization must never reuse a discovery cutoff to authorize a
    # mutation after waiting. This inspects installed definitions through the
    # actual runtime role; the real lock-expiry tests exercise the behavior.
    with runtime(preparations.db) as connection:
        assert_runtime_role(connection, preparations.db)
        bodies = {row["proname"]: row["definition"] for row in connection.execute("""
            select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'
            and p.proname in ('guard_top_remote_pending_facts','finish_top_remote_attempt',
              'fail_top_remote_attempt','expire_top_remote_attempt_locked','reclaim_top_remote_parent_locked',
              'maintain_top_remote_preparations')
            and (p.proname<>'finish_top_remote_attempt' or p.oid=
              'app.finish_top_remote_attempt(uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text,uuid[])'::regprocedure)
            """).fetchall()}
    guard = bodies["guard_top_remote_pending_facts"]
    assert "sampled:=clock_timestamp()" in guard
    assert "attempt.lease_until<=sampled" in guard and "parent.accepts_until<=sampled" in guard
    assert "OLD.expires_at>clock_timestamp()" in guard
    assert "fact.expires_at<=clock_timestamp()" in bodies["maintain_top_remote_preparations"]
    finish = bodies["finish_top_remote_attempt"]
    assert finish.index("lock_top_remote_preparation(") < finish.index("for update;") < finish.index("captured:=clock_timestamp()")
    assert "attempt.lease_until<=captured" in finish and "parent.accepts_until<=captured" in finish
    assert finish.index("set pending_bytes=pending_bytes-16384+bytes") < finish.index("attempt.lease_until<=clock_timestamp()")
    assert "parent.accepts_until<=clock_timestamp()" in finish
    failure = bodies["fail_top_remote_attempt"]
    assert failure.index("lock_top_remote_preparation(") < failure.index("for update;") < failure.index("attempt.lease_until<=clock_timestamp()")
    assert failure.count("attempt.lease_until<=clock_timestamp()") == 2
    assert failure.count("parent.accepts_until<=clock_timestamp()") == 2
    assert failure.index("set pending_count=pending_count-1") < failure.rindex("attempt.lease_until<=clock_timestamp()")
    expiry = bodies["expire_top_remote_attempt_locked"]
    assert "sampled timestamptz:=clock_timestamp()" in expiry
    assert "attempt.lease_until>sampled" in expiry and "fact.expires_at>sampled" in expiry
    assert "parent.fully_expires_at>clock_timestamp()" in bodies["reclaim_top_remote_parent_locked"]


def test_reservation_commits_one_identity_charge_and_only_inserter_dispatches(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    first = preparations.reserve(command)
    assert first["state"] == "reserved" and first["dispatch"] is True
    assert isfinite(first["remaining_seconds"]) and 0 < first["remaining_seconds"] <= 120
    assert (datetime.fromisoformat(first["lease_until"]) - datetime.fromisoformat(first["sql_now"])).total_seconds() >= first["remaining_seconds"]
    assert first["facts"] is None and first["capacity"]["actor_pending_count"] == 1
    assert first["capacity"]["actor_pending_bytes"] == 16384
    assert first["capacity"]["attempt_slots_remaining"] == 511
    state = preparations.state()
    retry = preparations.reserve(command)
    assert retry["dispatch"] is False and retry["state"] == "reserved"
    assert (retry["attempt_ref"], retry["acquisition_ref"]) == (first["attempt_ref"], first["acquisition_ref"])
    assert preparations.state() == state
    changed = dict(command, release_group_id=str(uuid4()))
    with runtime(preparations.db) as connection:
        sql_error(connection, "55000", lambda: invoke(connection, "reserve_top_remote_attempt",
            preparations.request_args(changed)), constraint="top_remote_request_conflict")
    assert preparations.state() == state


def test_concurrent_same_key_has_one_insert_winner_without_waiting_provider_work(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    barrier = Barrier(2)
    def reserve():
        barrier.wait(timeout=5)
        return preparations.reserve(command)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: reserve(), range(2)))
    assert sorted(value["dispatch"] for value in results) == [False, True]
    assert len({value["attempt_ref"] for value in results}) == 1
    assert preparations.status()["capacity"]["actor_pending_count"] == 1
    assert preparations.calls == []


def test_same_transaction_reserve_finish_cannot_claim_committed_dispatch(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    before = preparations.state()
    with runtime(preparations.db) as connection:
        reservation = invoke(connection, "reserve_top_remote_attempt", preparations.request_args(command))
        facts = preparations.facts
        args = (*preparations.request_args(command), reservation["attempt_ref"], reservation["acquisition_ref"],
            facts.digest, facts.title, facts.artist_display, facts.first_release_date, facts.primary_type,
            None if facts.credited_artist_ids is None else [UUID(value) for value in facts.credited_artist_ids])
        sql_error(connection, "55000", lambda: invoke(connection, "finish_top_remote_attempt", args),
            constraint="top_remote_expired")
        connection.rollback()
    assert preparations.state() == before


def test_success_swaps_exact_jsonb_bytes_and_exact_retry_keeps_first_facts(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    reservation = preparations.reserve(command)
    finished = preparations.finish(command, reservation)
    assert finished["state"] == "pending" and finished["dispatch"] is False
    assert finished["remaining_seconds"] == 0 and finished["facts"]["evidence_version"] == preparations.facts.digest
    assert finished["facts"]["preparation_ref"] == parent["preparation_ref"]
    assert finished["facts"]["attempt_ref"] == reservation["attempt_ref"]
    assert finished["capacity"]["actor_reservations"] == 0
    assert finished["capacity"]["actor_pending_count"] == 1
    assert finished["capacity"]["actor_pending_bytes"] == finished["facts"]["facts_bytes"]
    assert (datetime.fromisoformat(finished["facts"]["expires_at"]) - datetime.fromisoformat(finished["facts"]["created_at"])).total_seconds() == 1800
    before = preparations.state()
    assert preparations.reserve(command)["facts"] == finished["facts"]
    with pytest.raises(psycopg.Error) as caught:
        preparations.finish(command, reservation, facts=evidence(title="Changed response"))
    assert caught.value.diag.constraint_name == "top_remote_expired"
    assert preparations.state() == before


def test_completion_after_real_parent_lock_wait_refuses_expired_lease(preparations):
    parent, target = preparations.insert_timed_parent(age_seconds=1790)
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    facts = preparations.facts
    args = (*preparations.request_args(command), reserved["attempt_ref"], reserved["acquisition_ref"],
        facts.digest, facts.title, facts.artist_display, facts.first_release_date, facts.primary_type,
            None if facts.credited_artist_ids is None else [UUID(value) for value in facts.credited_artist_ids])
    def finish_after_wait():
        with runtime(preparations.db) as connection:
            assert_runtime_role(connection, preparations.db)
            # This one real wait must outlast its 10-second lease rather than
            # being cut short by the ordinary fixture's 5-second lock timeout.
            connection.execute("set local lock_timeout='15s'")
            return invoke(connection, "finish_top_remote_attempt", args)
    with preparations.db.connect() as blocker:
        blocker.execute("select ref from app.album_top_remote_preparations where ref=%s for update",
            (parent["preparation_ref"],)).fetchone()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(finish_after_wait)
            stop = monotonic() + 5
            observed = False
            while monotonic() < stop:
                with runtime(preparations.db) as probe:
                    observed = probe.execute("""select exists(select 1 from pg_stat_activity
                        where usename=current_user and pid<>pg_backend_pid() and wait_event_type='Lock'
                        and query like 'select app.finish_top_remote_attempt(%%') as blocked""").fetchone()["blocked"]
                if observed:
                    break
                sleep(0.01)
            assert observed, "Completion never reached a real parent-row wait"
            wait_until(preparations, reserved["lease_until"])
            blocker.commit()
            with pytest.raises(psycopg.Error) as caught:
                pending.result(timeout=5)
            assert caught.value.diag.constraint_name == "top_remote_expired"
    state = preparations.state()
    assert state["album_top_remote_acquisitions"] == []
    assert state["album_top_remote_attempts"][0]["state"] == "reserved"


def test_finish_counter_fact_state_and_reply_roll_back_as_one_transaction(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    before = preparations.state()
    facts = preparations.facts
    with runtime(preparations.db) as connection:
        result = invoke(connection, "finish_top_remote_attempt", (*preparations.request_args(command),
            reserved["attempt_ref"], reserved["acquisition_ref"], facts.digest, facts.title,
            facts.artist_display, facts.first_release_date, facts.primary_type,
            None if facts.credited_artist_ids is None else [UUID(value) for value in facts.credited_artist_ids]))
        assert result["state"] == "pending" and result["capacity"]["actor_reservations"] == 0
        connection.rollback()
    assert preparations.state() == before
    assert preparations.finish(command, reserved)["state"] == "pending"


def test_failure_refunds_only_pending_reservation_and_never_reexecutes_key(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    result = preparations.fail(command, reserved)
    assert result["state"] == "failed" and result["error_code"] == "provider_unavailable"
    assert result["capacity"]["actor_pending_count"] == result["capacity"]["actor_pending_bytes"] == 0
    assert result["capacity"]["attempt_slots_remaining"] == 511
    before = preparations.state()
    assert preparations.reserve(command)["state"] == "failed"
    assert preparations.reserve(command)["dispatch"] is False
    with pytest.raises(psycopg.Error):
        preparations.fail(command, reserved)
    assert preparations.state() == before
    new = preparations.reserve(preparations.command(parent, target))
    assert new["dispatch"] is True and new["capacity"]["attempt_slots_remaining"] == 510


@pytest.mark.parametrize("code", ["provider_cancelled", "raw server error", "", None])
def test_cancellation_and_unbounded_failure_codes_leave_reservation_spent(preparations, code):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    before = preparations.state()
    with pytest.raises(psycopg.Error) as caught:
        preparations.fail(command, reserved, error=code)
    assert caught.value.diag.constraint_name == "top_remote_scope"
    assert preparations.state() == before


def test_near_acceptance_deadline_caps_lease_then_maintenance_refunds_once(preparations):
    parent, target = preparations.insert_timed_parent(age_seconds=1790)
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    assert 0 < reserved["remaining_seconds"] <= 10
    assert reserved["lease_until"] == reserved["accepts_until"]
    wait_until(preparations, reserved["lease_until"])
    status = preparations.status()
    assert status["parents"][0]["state"] == "draining"
    assert status["parents"][0]["capacity"]["worst_case_new_acquisitions"] == 0
    assert status["parents"][0]["capacity"]["attempt_slots_remaining"] == 511
    late = preparations.reserve(command)
    assert late["state"] == "expired" and late["dispatch"] is False
    assert late["capacity"]["actor_reservations"] == 1
    with pytest.raises(psycopg.Error) as caught:
        preparations.finish(command, reserved)
    assert caught.value.diag.constraint_name == "top_remote_expired"
    step = preparations.maintain()
    assert step["branch"] == "expired_reservations" and step["inspected"] == 1
    assert step["released_bytes"] == 16384
    assert step["capacity"]["actor_reservations"] == step["capacity"]["actor_pending_count"] == 0
    again = preparations.maintain()
    assert again["released_bytes"] == 0
    assert preparations.reserve(command)["state"] == "expired"
    assert preparations.status()["parents"][0]["attempt_count"] == 1


def test_two_parent_four_actor_reservation_caps_are_physical_until_refund(preparations):
    parent, target = preparations.begin()
    commands = [preparations.command(parent, target) for _ in range(3)]
    one, two = (preparations.reserve(command) for command in commands[:2])
    refused = preparations.reserve(commands[2])
    assert refused["state"] == "limit" and refused["resource"] == "reservations"
    assert refused["dispatch"] is False and "attempt_ref" not in refused
    preparations.insert_timed_parent(age_seconds=3601, initialize=False)
    assert preparations.status()["maintenance_required"] is True
    unrelated_cleanup = preparations.reserve(commands[2])
    assert unrelated_cleanup["state"] == "limit" and unrelated_cleanup["resource"] == "reservations"
    second, other = preparations.begin(initialize=False)
    more = [preparations.command(second, other) for _ in range(2)]
    for command in more:
        assert preparations.reserve(command)["dispatch"] is True
    third, target3 = preparations.begin(initialize=False)
    denied = preparations.reserve(preparations.command(third, target3))
    assert denied["state"] == "limit" and denied["capacity"]["actor_reservations"] == 4
    preparations.fail(commands[0], one)
    assert preparations.reserve(commands[2])["dispatch"] is True
    assert preparations.status()["capacity"]["actor_reservations"] == 4


def test_reservation_maintenance_distinguishes_parent_and_actor_buckets(preparations):
    expiring, expiring_target = preparations.insert_timed_parent(age_seconds=1790)
    lease = preparations.reserve(preparations.command(expiring, expiring_target))
    busy, target = preparations.begin(initialize=False)
    for _ in range(2):
        assert preparations.reserve(preparations.command(busy, target))["dispatch"] is True
    third, target3 = preparations.begin(initialize=False)
    assert preparations.reserve(preparations.command(third, target3))["dispatch"] is True
    available, available_target = preparations.begin(initialize=False)
    wait_until(preparations, lease["lease_until"])
    assert preparations.status()["capacity"]["actor_reservations"] == 4
    assert preparations.status()["maintenance_required"] is True
    before = preparations.state()
    parent_limit = preparations.reserve(preparations.command(busy, target))
    assert parent_limit["state"] == "limit" and parent_limit["resource"] == "reservations"
    actor_command = preparations.command(available, available_target)
    actor_limit = preparations.reserve(actor_command)
    assert actor_limit["state"] == "maintenance_required" and actor_limit["resource"] == "reservations"
    assert parent_limit["dispatch"] is actor_limit["dispatch"] is False
    assert preparations.state() == before
    progress = preparations.maintain()
    assert progress["branch"] == "expired_reservations" and progress["inspected"] == 1
    assert progress["released_bytes"] == 16384 and progress["capacity"]["actor_reservations"] == 3
    assert preparations.reserve(actor_command)["dispatch"] is True
    parent_limit = preparations.reserve(preparations.command(busy, target))
    assert parent_limit["state"] == "limit" and parent_limit["resource"] == "reservations"


def test_explicit_close_removes_bounded_children_and_late_worker_cannot_resurrect(preparations):
    parent, target = preparations.begin()
    pending_command, reserved_command = (preparations.command(parent, target) for _ in range(2))
    pending = preparations.reserve(pending_command)
    result = preparations.finish(pending_command, pending)
    reserved = preparations.reserve(reserved_command)
    closed = preparations.close(parent)
    assert closed["removed_attempts"] == 2 and closed["removed_facts"] == 1
    assert closed["released_bytes"] == result["facts"]["facts_bytes"] + 16384
    assert closed["capacity"]["physical_parents"] == closed["capacity"]["actor_pending_count"] == 0
    for action in (lambda: preparations.reserve(pending_command), lambda: preparations.finish(reserved_command, reserved),
                   lambda: preparations.close(parent)):
        with pytest.raises(psycopg.Error) as caught:
            action()
        assert caught.value.diag.constraint_name == "top_remote_preparation_unavailable"
    assert preparations.state()["album_top_remote_attempts"] == []


def test_unknown_parent_and_other_actor_close_cannot_create_or_discard(preparations):
    from tests.py.test_album_top_collaboration_postgres import member
    parent, target = preparations.begin()
    other = member(preparations.db)
    before = preparations.state()
    with pytest.raises(psycopg.Error) as caught:
        preparations.close(parent, actor=other)
    assert caught.value.diag.constraint_name == "top_remote_preparation_unavailable"
    # The failed transaction also rolls back any budget initialization.
    assert preparations.state() == before
    command = preparations.command({"preparation_ref": str(uuid4())}, target)
    with pytest.raises(psycopg.Error):
        preparations.reserve(command)
    assert preparations.state() == before


def test_eight_active_and_two_exact_destination_parent_limits_without_eviction(preparations):
    top, _ = preparations.db.create(refs=[])
    target = {"kind": "top", "top_ref": top["top_ref"], "revision": top["revision"]}
    first, _ = preparations.begin(target)
    second, _ = preparations.begin(target)
    command = preparations.command(first, target)
    pending = preparations.finish(command, preparations.reserve(command))
    before_retirement = preparations.state()
    with preparations.db.connect() as connection:
        assert connection.execute("update app.album_top_remote_acquisitions set retired_at=clock_timestamp() "
            "where ref=%s and retired_at is null", (pending["acquisition_ref"],)).rowcount == 1
    assert preparations.state()["album_top_remote_pending_budgets"] == before_retirement["album_top_remote_pending_budgets"]
    # The legal one-way fact retirement cannot release a live logical parent.
    third, _ = preparations.begin(target, initialize=False)
    assert third["state"] == "limit" and third["resource"] == "parents"
    preparations.insert_timed_parent(age_seconds=3601, initialize=False)
    assert preparations.status()["maintenance_required"] is True
    third, _ = preparations.begin(target, initialize=False)
    assert first["preparation_ref"] != second["preparation_ref"]
    assert third["state"] == "limit" and third["resource"] == "parents"
    for _ in range(6):
        parent, _ = preparations.begin(initialize=False)
        assert parent["state"] == "ready"
    ninth, _ = preparations.begin(initialize=False)
    assert ninth["state"] == "limit"
    assert preparations.status()["capacity"]["physical_parents"] == 9
    assert len(preparations.status()["parents"]) == 9
    assert preparations.status()["maintenance_required"] is True
    assert preparations.maintain()["branch"] == "parent_reclamation"
    ninth, _ = preparations.begin(initialize=False)
    assert ninth["state"] == "limit" and ninth["resource"] == "parents"
    assert preparations.status()["capacity"]["physical_parents"] == 8
    assert preparations.status()["maintenance_required"] is True
    progress = preparations.maintain()
    assert progress["branch"] == "expired_facts" and progress["removed_facts"] == 1
    ninth, _ = preparations.begin(initialize=False)
    assert ninth["state"] == "limit" and ninth["resource"] == "parents"
    assert preparations.status()["capacity"]["physical_parents"] == 8


def test_full_expiry_reclaims_one_parent_without_old_destination_or_empty_autoclose(preparations):
    parent, target = preparations.insert_timed_parent(age_seconds=3601)
    assert preparations.status()["parents"][0]["state"] == "expired"
    step = preparations.maintain()
    assert step["branch"] == "parent_reclamation" and step["inspected"] == 1
    assert step["removed_attempts"] == step["removed_facts"] == 0
    assert step["capacity"]["physical_parents"] == 0
    fresh, _ = preparations.begin(target)
    assert fresh["preparation_ref"] != parent["preparation_ref"]
    assert preparations.status()["parents"][0]["state"] == "accepting"
    assert preparations.maintain()["branch"] == "none"
    assert preparations.status()["capacity"]["physical_parents"] == 1


def test_current_revision_required_for_pending_but_failed_replay_keeps_original_binding(preparations):
    from tests.py.test_album_top_collaboration_postgres import write
    top, _ = preparations.db.create(refs=[])
    target = {"kind": "top", "top_ref": top["top_ref"], "revision": top["revision"]}
    parent, _ = preparations.begin(target)
    failed_command, pending_command = (preparations.command(parent, target) for _ in range(2))
    preparations.fail(failed_command, preparations.reserve(failed_command))
    preparations.finish(pending_command, preparations.reserve(pending_command))
    advanced, _ = write(preparations.db, "save", top, title="Next revision")
    assert advanced["revision"] != top["revision"]
    failed = preparations.reserve(failed_command)
    assert failed["state"] == "failed" and str(failed["destination_revision"]) == target["revision"]
    with pytest.raises(psycopg.Error) as caught:
        preparations.reserve(pending_command)
    assert caught.value.diag.constraint_name == "top_remote_revision"


def test_actual_runtime_privileges_deny_direct_dml_private_helpers_and_forged_consumption(mixed):
    preparations = mixed.remote
    parent, target = preparations.begin_v2()
    command = prepared_payload(parent, target)
    reservation = preparations.reserve_v2(command)
    with runtime(preparations.db) as connection:
        assert_runtime_role(connection, preparations.db)
        for relation in ("album_top_remote_pending_budgets", "album_top_remote_preparations", "album_top_remote_attempts",
                         "album_top_remote_acquisitions"):
            assert connection.execute("select has_table_privilege(current_user,%s,'SELECT') as allowed", ("app." + relation,)).fetchone()["allowed"]
            for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                assert connection.execute("select has_table_privilege(current_user,%s,%s) as allowed",
                    ("app." + relation, privilege)).fetchone()["allowed"] is False
            sql_error(connection, "42501", lambda: connection.execute("delete from app." + relation + " where false"))
        sql_error(connection, "42501", lambda: connection.execute("select app.expire_top_remote_attempt_locked(%s)",
            (reservation["attempt_ref"],)))
        sql_error(connection, "42501", lambda: connection.execute("select app.reclaim_top_remote_parent_locked(%s,true)",
            (parent["preparation_ref"],)))
        connection.execute("select set_config('app.remote_preparation_bypass','true',true)").fetchone()
        sql_error(connection, "42501", lambda: connection.execute("update app.album_top_remote_attempts "
            "set state='consumed',consumed_top_ref=%s where ref=%s", (str(uuid4()), reservation["attempt_ref"])))
    with preparations.db.connect() as connection:
        # B requires INSERT to begin as reserved even with structurally complete
        # terminal linkage. Incomplete and complete consumed forgeries both fail.
        sql_error(connection, "55000", lambda: connection.execute("""insert into app.album_top_remote_attempts
            (ref,preparation_ref,actor_account_id,request_key,acquisition_ref,command_digest,external_id,state,created_at,lease_until)
            select %s,preparation_ref,actor_account_id,%s,%s,command_digest,external_id,'consumed',created_at,lease_until
            from app.album_top_remote_attempts where ref=%s""",
            (str(uuid4()), str(uuid4()), str(uuid4()), reservation["attempt_ref"])), constraint="top_remote_attempt_immutable")

        sql_error(connection, "55000", lambda: connection.execute("""insert into app.album_top_remote_attempts
            (ref,preparation_ref,actor_account_id,request_key,acquisition_ref,command_digest,external_id,state,
             created_at,lease_until,evidence_version,consumed_top_ref,consumed_revision,operation_request_key,
             consumed_admission_ref,consumed_item_ref,consumed_catalog_ref)
            select %s,preparation_ref,actor_account_id,%s,%s,command_digest,external_id,'consumed',
              created_at,lease_until,%s,%s,1,%s,%s,%s,%s
            from app.album_top_remote_attempts where ref=%s""",
            (str(uuid4()), str(uuid4()), str(uuid4()), preparations.facts.digest,
             str(uuid4()), str(uuid4()), str(uuid4()), str(uuid4()), str(uuid4()), reservation['attempt_ref'])),
            constraint='top_remote_attempt_immutable')
    preparations.finish_v2(command, reservation)
    receipt = preparations.acquire(command)
    top, mutation = mixed.create(local=False, acquired=receipt)
    terminal = preparations.c2_state()['album_top_remote_attempts'][0]
    assert terminal['state'] == 'consumed' and str(terminal['consumed_top_ref']) == top['top_ref']
    assert str(terminal['operation_request_key']) == mutation.request_key
    assert preparations.rows() == []


def test_cleanup_foreign_keys_and_retained_immutability_are_structurally_independent(preparations):
    with runtime(preparations.db) as connection:
        rows = connection.execute("""select conrelid::regclass::text as source,confrelid::regclass::text as target
            from pg_constraint where contype='f' and conrelid in ('app.album_top_remote_preparations'::regclass,
              'app.album_top_remote_attempts'::regclass,'app.album_top_remote_pending_budgets'::regclass)
            order by source,target""").fetchall()
        assert {row["target"] for row in rows if row["source"] == "app.album_top_remote_attempts"} == {"app.album_top_remote_preparations"}
        assert {row["target"] for row in rows if row["source"] == "app.album_top_remote_preparations"} == {"app.accounts", "library.libraries"}
        assert all(row["target"] not in {"app.album_lists", "app.album_list_operations", "app.album_top_remote_admissions",
            "app.album_list_items", "catalog.release_groups"} for row in rows)
        trigger = connection.execute("""select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
            where t.tgrelid='app.album_top_remote_admissions'::regclass and t.tgname='top_remote_admission_immutable'""").fetchone()
        assert trigger["proname"] == "guard_top_remote_facts"
        funcs = connection.execute("""select p.oid::regprocedure::text as signature,has_function_privilege(current_user,p.oid,'EXECUTE') as allowed
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'
            and p.proname in ('top_remote_attempt_result','lock_top_remote_preparation_scope',
              'top_remote_pending_capacity','expire_top_remote_attempt_locked','reclaim_top_remote_parent_locked')""").fetchall()
        assert len(funcs) == 5 and all(row["allowed"] is False for row in funcs)


def test_unknown_v1_writer_and_direct_owner_insert_are_unconditionally_cut_off(preparations):
    from tests.py.remote_top_postgres_support import payload
    command = payload()
    args = preparations.store_args(command)
    with runtime(preparations.db) as connection:
        assert_runtime_role(connection, preparations.db)
        sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, args), constraint="top_remote_version_required")
    with preparations.db.connect() as connection:
        connection.execute("select set_config('app.remote_preparation_bypass','true',true)").fetchone()
        sql_error(connection, "55000", lambda: connection.execute("""insert into app.album_top_remote_acquisitions
            (ref,library_id,actor_account_id,original_session_id,context_ref,destination_kind,destination_ref,
            destination_owner_account_id,request_key,command_digest,provider,entity_kind,external_id,evidence_version,
            title,artist_display,facts_bytes,created_at,expires_at)
            values(%s,%s,%s,%s,%s,'create',%s,%s,%s,%s,'musicbrainz','release-group',%s,%s,%s,%s,1,
            clock_timestamp(),clock_timestamp()+interval '30 minutes')""",
            (args[0], args[1], args[2], args[3], args[4], args[6], args[7], args[9], args[10],
             args[11], args[12], args[13], args[14])), constraint="top_remote_version_required")
    assert preparations.rows() == []


def test_v2_retention_and_consumption_require_real_identity_bridge_and_receipt(mixed):
    preparations = mixed.remote
    top, _ = preparations.db.create(refs=[])
    command = preparations.prepare_v2()
    acquired = preparations.acquire(command)
    before = preparations.unrelated(), preparations.c2_state()
    with runtime(preparations.db) as connection:
        args = (str(uuid4()), acquired['acquisition_ref'], preparations.facts.digest, top['top_ref'],
            preparations.db.library, preparations.db.owner.account_id, preparations.db.owner.account_id,
            preparations.db.owner.session_id, CONTEXT, 'create', command['destination']['draft_ref'],
            int(top['revision']), str(uuid4()))
        # Original unmapped random catalog/no receipt setup must still fail.
        sql_error(connection, '55000', lambda: invoke(connection, 'retain_top_remote_acquisition', args),
            constraint='top_remote_identity')
    assert (preparations.unrelated(), preparations.c2_state()) == before
    assert preparations.reserve_v2(command)['state'] == 'pending'
    source = preparations.rows()[0]
    actual, mutation = mixed.create(local=False, acquired=acquired)
    admission = mixed.rows('album_top_remote_admissions')[0]
    terminal = preparations.c2_state()['album_top_remote_attempts'][0]
    assert admission['original_acquisition_ref'] == source['ref']
    assert admission['original_session_id'] == source['original_session_id']
    assert admission['acquired_at'] == source['created_at'] and admission['admission_deadline'] == source['expires_at']
    assert terminal['state'] == 'consumed' and str(terminal['consumed_top_ref']) == actual['top_ref']
    assert terminal['consumed_revision'] == int(actual['revision'])
    assert str(terminal['operation_request_key']) == mutation.request_key
    assert terminal['consumed_admission_ref'] == admission['ref']
    assert preparations.rows() == []
    budget = preparations.c2_state()['album_top_remote_pending_budgets'][0]
    assert budget['pending_count'] == budget['pending_bytes'] == budget['reservation_count'] == 0


def test_512_lifetime_attempt_slots_remain_spent_after_known_failures(preparations):
    parent, target = preparations.begin()
    with runtime(preparations.db) as connection:
        assert_runtime_role(connection, preparations.db)
        connection.execute("set lock_timeout='5s'")
        connection.execute("set statement_timeout='20s'")
        connection.commit()
        for index in range(512):
            command = preparations.command(parent, target)
            args = preparations.request_args(command)
            reservation = invoke(connection, "reserve_top_remote_attempt", args)
            assert reservation["dispatch"] is True
            connection.commit()
            result = invoke(connection, "fail_top_remote_attempt", (*args, reservation["attempt_ref"],
                reservation["acquisition_ref"], "provider_unavailable"))
            assert result["capacity"]["attempt_slots_remaining"] == 511 - index
            connection.commit()
    refused = preparations.reserve(preparations.command(parent, target))
    assert refused["state"] == "limit" and refused["resource"] == "attempts"
    assert refused["capacity"]["actor_pending_count"] == refused["capacity"]["actor_pending_bytes"] == 0
    assert len(preparations.state()["album_top_remote_attempts"]) == 512
    # Genuine unrelated maintenance cannot refund this parent's lifetime keys.
    # Use an empty historical parent with its original fixed deadlines, not a
    # rewritten timestamp, artificial attempt count or shortened testing quota.
    unrelated, _ = preparations.insert_timed_parent(age_seconds=3601, initialize=False)
    assert preparations.status()["maintenance_required"] is True
    exhausted_command = preparations.command(parent, target)
    before = preparations.state()
    refused_with_cleanup = preparations.reserve(exhausted_command)
    assert refused_with_cleanup["state"] == "limit" and refused_with_cleanup["resource"] == "attempts"
    assert refused_with_cleanup["dispatch"] is False and "attempt_ref" not in refused_with_cleanup
    assert refused_with_cleanup["capacity"]["attempt_slots_remaining"] == 0
    assert preparations.state() == before
    cleanup = preparations.maintain()
    assert cleanup["branch"] == "parent_reclamation" and cleanup["inspected"] == 1
    assert cleanup["removed_attempts"] == cleanup["removed_facts"] == 0
    assert all(str(row["ref"]) != unrelated["preparation_ref"]
        for row in preparations.state()["album_top_remote_preparations"])
    refused_after_cleanup = preparations.reserve(exhausted_command)
    assert refused_after_cleanup["state"] == "limit" and refused_after_cleanup["resource"] == "attempts"
    assert refused_after_cleanup["capacity"]["attempt_slots_remaining"] == 0
    assert len(preparations.state()["album_top_remote_attempts"]) == 512
    rollover, _ = preparations.begin(target)
    assert rollover["state"] == "ready" and rollover["preparation_ref"] != parent["preparation_ref"]


def test_32_physical_parent_boundary_requires_one_measured_reclamation(preparations):
    assert preparations.maintain()["capacity"]["legacy_initialized"] is True
    for _ in range(32):
        preparations.insert_timed_parent(age_seconds=3601, initialize=False)
    status = preparations.status()
    assert status["capacity"]["physical_parents"] == len(status["parents"]) == 32
    assert all(parent["state"] == "expired" for parent in status["parents"])
    assert all(parent["capacity"]["worst_case_new_acquisitions"] == 0 for parent in status["parents"])
    refused, target = preparations.begin(initialize=False)
    assert refused["state"] == "maintenance_required" and refused["resource"] == "parents"
    step = preparations.maintain()
    assert step["branch"] == "parent_reclamation" and step["inspected"] == 1
    assert step["capacity"]["physical_parents"] == 31 and step["more_work"] is True
    accepted, _ = preparations.begin(target, initialize=False)
    assert accepted["state"] == "ready" and accepted["capacity"]["physical_parents"] == 32


def test_2048_actor_pending_slots_are_real_distinct_committed_fact_rows(preparations):
    # This intentionally exercises the actual bound, not a shortened quota or
    # fabricated counter. Root may select this expensive contract separately.
    parents = []
    with runtime(preparations.db) as connection:
        assert_runtime_role(connection, preparations.db)
        connection.execute("set lock_timeout='5s'")
        connection.execute("set statement_timeout='20s'")
        connection.commit()
        for _ in range(4):
            parent, target = preparations.begin()
            parents.append(parent)
            for _ in range(512):
                command = preparations.command(parent, target, mbid=str(uuid4()))
                args = preparations.request_args(command)
                reservation = invoke(connection, "reserve_top_remote_attempt", args)
                assert reservation["dispatch"] is True
                connection.commit()
                facts = evidence(mbid=command["release_group_id"])
                result = invoke(connection, "finish_top_remote_attempt", (*args, reservation["attempt_ref"],
                    reservation["acquisition_ref"], facts.digest, facts.title, facts.artist_display,
                    facts.first_release_date, facts.primary_type,
                    None if facts.credited_artist_ids is None else [UUID(value) for value in facts.credited_artist_ids]))
                assert result["state"] == "pending"
                connection.commit()
    state = preparations.state()
    assert len(state["album_top_remote_acquisitions"]) == 2048
    assert len(state["album_top_remote_attempts"]) == 2048
    assert all(parent["pending_count"] == parent["attempt_count"] == 512 for parent in state["album_top_remote_preparations"])
    status = preparations.status()
    assert status["capacity"]["actor_pending_count"] == 2048
    assert status["capacity"]["actor_pending_bytes"] == sum(row["facts_bytes"] for row in state["album_top_remote_acquisitions"])
    next_parent, next_target = preparations.begin()
    preparations.insert_timed_parent(age_seconds=3601, initialize=False)
    assert preparations.status()["maintenance_required"] is True
    before_denial = preparations.state()
    denied = preparations.reserve(preparations.command(next_parent, next_target))
    assert denied["state"] == "limit" and denied["resource"] == "pending"
    assert denied["dispatch"] is False and "attempt_ref" not in denied
    assert preparations.state() == before_denial
    unrelated = preparations.maintain()
    assert unrelated["branch"] == "parent_reclamation" and unrelated["released_bytes"] == 0
    still_denied = preparations.reserve(preparations.command(next_parent, next_target))
    assert still_denied["state"] == "limit" and still_denied["resource"] == "pending"
    # A genuine one-way retirement leaves the original charge until the actual
    # runtime cleanup transition. The immutable guard stays enabled throughout.
    fact = next(row for row in state["album_top_remote_acquisitions"]
        if str(row["preparation_ref"]) == parents[0]["preparation_ref"])
    before_retirement = preparations.state()
    with preparations.db.connect() as connection:
        assert connection.execute("update app.album_top_remote_acquisitions set retired_at=clock_timestamp() "
            "where ref=%s and retired_at is null", (fact["ref"],)).rowcount == 1
    retired = preparations.state()
    for relation in ("album_top_remote_pending_budgets", "album_top_remote_preparations", "album_top_remote_attempts"):
        assert retired[relation] == before_retirement[relation]
    changed_fact = next(row for row in retired["album_top_remote_acquisitions"] if row["ref"] == fact["ref"])
    assert changed_fact["retired_at"] is not None
    assert {key: value for key, value in changed_fact.items() if key != "retired_at"} == {
        key: value for key, value in fact.items() if key != "retired_at"}
    for row in retired["album_top_remote_acquisitions"]:
        if row["ref"] != fact["ref"]:
            assert row in before_retirement["album_top_remote_acquisitions"]
    retry_command = preparations.command(next_parent, next_target)
    remediable = preparations.reserve(retry_command)
    assert remediable["state"] == "maintenance_required" and remediable["resource"] == "pending"
    assert remediable["dispatch"] is False and "attempt_ref" not in remediable
    assert preparations.state() == retired
    progress = preparations.maintain()
    assert progress["branch"] == "expired_facts" and progress["removed_facts"] == progress["inspected"] == 1
    assert progress["released_bytes"] == fact["facts_bytes"]
    assert progress["capacity"]["actor_pending_count"] == 2047
    assert progress["capacity"]["actor_pending_bytes"] == status["capacity"]["actor_pending_bytes"] - fact["facts_bytes"]
    reclaimed = preparations.state()
    assert len(reclaimed["album_top_remote_attempts"]) == 2048
    assert all(row["attempt_count"] == 512 for row in reclaimed["album_top_remote_preparations"]
        if str(row["ref"]) in {parent["preparation_ref"] for parent in parents})
    assert next(row for row in reclaimed["album_top_remote_attempts"] if row["acquisition_ref"] == fact["ref"])["state"] == "expired"
    retry = preparations.reserve(retry_command)
    assert retry["dispatch"] is True and retry["capacity"]["actor_pending_count"] == 2048
    preparations.fail(retry_command, retry)
    closed = preparations.close(parents[0])
    assert closed["removed_facts"] == 511 and closed["removed_attempts"] == 512
    assert closed["capacity"]["actor_pending_count"] == 1536
    assert preparations.reserve(preparations.command(next_parent, next_target))["dispatch"] is True


def test_maximum_normalized_fields_fit_and_oversize_never_spends_more_than_reservation(preparations):
    parent, target = preparations.begin()
    command = preparations.command(parent, target)
    reserved = preparations.reserve(command)
    large = evidence(title="\U0001f600" * 1000, artist="\U0001f600" * 1000)
    pending = preparations.finish(command, reserved, facts=large)
    assert 8000 < pending["facts"]["facts_bytes"] <= 16384
    command2 = preparations.command(parent, target)
    reserved2 = preparations.reserve(command2)
    before = preparations.state()
    with runtime(preparations.db) as connection:
        args = (*preparations.request_args(command2), reserved2["attempt_ref"], reserved2["acquisition_ref"],
            large.digest, "\U0001f600" * 5000, large.artist_display, large.first_release_date, large.primary_type,
            None if large.credited_artist_ids is None else [UUID(value) for value in large.credited_artist_ids])
        sql_error(connection, "55000", lambda: invoke(connection, "finish_top_remote_attempt", args),
            constraint="top_remote_expired")
    assert preparations.state() == before
    with preparations.db.connect() as connection:
        # Theoretical normalized-payload ceilings are separate from the current
        # validator's smaller maximum text payload, not claimed as reached here.
        sql_error(connection, "23514", lambda: connection.execute("update app.album_top_remote_preparations "
            "set pending_bytes=8388609 where ref=%s", (parent["preparation_ref"],)))
    assert preparations.state() == before
