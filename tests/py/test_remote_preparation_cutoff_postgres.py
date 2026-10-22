"""Explicit fresh pre-0132 SQL transition; never backfills a post-cutoff database."""
import json
from uuid import uuid4

from psycopg import sql

from music_app.services.album_top_remote_sources import project_remote_summary
from music_app.services.owned_album_tops import BROWSE
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.remote_preparation_cutoff_support import cutoff_transition
from tests.py.remote_top_postgres_support import STORE_SQL, payload, runtime, sql_error
from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.postgres_runtime_role_contract import assert_runtime_role


def plan_nodes(node):
    yield node
    for child in node.get("Plans", []):
        yield from plan_nodes(child)


def assert_legacy_candidate_generic_plans(case, record_property, *, retired_count=0):
    """Executed only by root's admitted dedicated cutoff run.

    These are index-eligibility proofs on genuine legacy rows. Forced generic
    plans prevent parameter-specific simplification. Disabling sequential and
    bitmap scans makes the small fixture deterministic; this does NOT establish
    the planner's natural cost choice at production scale. Predicate SQL matches
    the actual maintenance owner; FOR UPDATE is omitted because runtime rightly
    has SELECT only. Actual owner locking/cleanup is exercised separately below.
    """
    actor = case.db.owner.account_id
    refs = sorted(row["ref"] for row in case.rows() if row["actor_account_id"] == actor)
    assert len(refs) == 513
    with runtime(case.db) as connection:
        assert_runtime_role(connection, case.db)
        definitions = {row["proname"]: row["definition"] for row in connection.execute("""
            select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'
            and p.proname in ('top_remote_has_maintenance','maintain_top_remote_preparations','reserve_top_remote_attempt')
            """).fetchall()}
        probe = definitions["top_remote_has_maintenance"]
        maintain = definitions["maintain_top_remote_preparations"]
        assert "sampled timestamptz:=clock_timestamp()" in probe
        assert "expires_at<=sampled" in probe and "expires_at<=clock_timestamp()" not in probe
        assert "ref>coalesce(budget.legacy_cursor,'00000000-0000-0000-0000-000000000000'::uuid)" in maintain
        assert "budget.legacy_cursor is null or ref>" not in maintain
        assert "and preparation_ref is null and expires_at<=sampled order by expires_at,ref limit 256" in maintain
        sampled = connection.execute("select clock_timestamp() as sampled").fetchone()["sampled"]
        assert connection.execute("select count(*) as count from app.album_top_remote_acquisitions "
            "where actor_account_id=%s and preparation_ref is null and expires_at>%s", (actor, sampled)).fetchone()["count"] == 513
        connection.execute("set local plan_cache_mode=force_generic_plan")
        connection.execute("set local enable_seqscan=off")
        connection.execute("set local enable_bitmapscan=off")
        statements = {
            "c2_legacy_exists": ("bigint,timestamptz", "select exists(select 1 from app.album_top_remote_acquisitions "
                "where actor_account_id=$1 and preparation_ref is null and expires_at<=$2)"),
            "c2_legacy_expiry": ("bigint,timestamptz", "select ref from app.album_top_remote_acquisitions "
                "where actor_account_id=$1 and preparation_ref is null and expires_at<=$2 order by expires_at,ref limit 256"),
            "c2_legacy_cursor": ("bigint,uuid", "select ref from app.album_top_remote_acquisitions "
                "where actor_account_id=$1 and preparation_ref is null "
                "and ref>coalesce($2,'00000000-0000-0000-0000-000000000000'::uuid) order by ref limit 256"),
            "c2_legacy_retirement": ("bigint", "select ref from app.album_top_remote_acquisitions "
                "where actor_account_id=$1 and preparation_ref is null and retired_at is not null order by retired_at,ref limit 256"),
        }
        # Tie each prepared predicate, comparison operator, ordering and limit
        # to actual installed function bytes (whitespace alone is normalized).
        probe_sql, maintain_sql, reserve_sql = (" ".join(body.split())
            for body in (probe, maintain, definitions["reserve_top_remote_attempt"]))
        exists_sql = statements["c2_legacy_exists"][1]
        actual_exists = exists_sql.removeprefix("select ").replace("$1", "p_actor").replace("$2", "sampled")
        assert actual_exists in probe_sql and actual_exists in reserve_sql
        expiry_sql = statements["c2_legacy_expiry"][1]
        assert expiry_sql.replace("$1", "p_actor").replace("$2", "sampled") in maintain_sql
        cursor_sql = statements["c2_legacy_cursor"][1]
        assert (cursor_sql.replace("select ref", "select *", 1).replace("$1", "p_actor")
            .replace("$2", "budget.legacy_cursor") + " for update") in maintain_sql
        assert statements["c2_legacy_retirement"][1].replace("$1", "p_actor") in maintain_sql
        for name, (types, query) in statements.items():
            connection.execute(sql.SQL("prepare {} ({}) as {}").format(sql.Identifier(name), sql.SQL(types), sql.SQL(query)))
        for label, name, args, index, condition, count in (
            ("exists_live_only", "c2_legacy_exists", (actor, sampled), "legacy_expiry_idx", "expires_at <= $2", 0),
            ("expiry_live_only", "c2_legacy_expiry", (actor, sampled), "legacy_expiry_idx", "expires_at <= $2", 0),
            ("cursor_first", "c2_legacy_cursor", (actor, None), "legacy_cursor_idx", "ref > COALESCE($2,", 256),
            ("cursor_resume", "c2_legacy_cursor", (actor, refs[255]), "legacy_cursor_idx", "ref > COALESCE($2,", 256),
            ("cursor_last", "c2_legacy_cursor", (actor, refs[511]), "legacy_cursor_idx", "ref > COALESCE($2,", 1),
            ("cursor_empty_sentinel", "c2_legacy_cursor", (actor, refs[512]), "legacy_cursor_idx", "ref > COALESCE($2,", 0),
            ("retirement", "c2_legacy_retirement", (actor,), "legacy_retirement_idx", "actor_account_id = $1", retired_count),
        ):
            query = sql.SQL("explain (analyze,buffers,format json) execute {} ({})").format(
                sql.Identifier(name), sql.SQL(",").join(sql.Literal(value) for value in args))
            document = connection.execute(query).fetchone()["QUERY PLAN"]
            record_property("c2_generic_plan_retired_" + str(retired_count) + "_" + label,
                json.dumps(document, sort_keys=True, default=str))
            nodes = list(plan_nodes(document[0]["Plan"]))
            scans = [node for node in nodes if node.get("Relation Name") == "album_top_remote_acquisitions"]
            assert len(scans) == 1
            scan = scans[0]
            assert scan["Node Type"] in {"Index Scan", "Index Only Scan"}
            assert scan["Index Name"] == "album_top_remote_acquisitions_" + index
            assert "actor_account_id = $1" in scan["Index Cond"] and condition in scan["Index Cond"]
            assert scan["Actual Rows"] == count and scan["Actual Loops"] == 1
            assert scan.get("Rows Removed by Filter", 0) == 0
        cached = connection.execute("select name,generic_plans,custom_plans from pg_prepared_statements "
            "where name like 'c2_legacy_%%' order by name").fetchall()
        assert len(cached) == 4 and all(row["generic_plans"] >= 1 and row["custom_plans"] == 0 for row in cached)
        for name in statements:
            connection.execute(sql.SQL("deallocate {}").format(sql.Identifier(name)))


def test_real_cutoff_exact_replay_keyset_sentinel_retirement_and_discard(cutoff_transition, record_property):
    case = cutoff_transition
    seeded = case.seed_old_writer(513)
    late_command = payload()
    late_args = case.store_args(late_command)
    # An old application's exact absence lookup has passed before the schema
    # cutoff. It has not yet called the old structural writer after provider I/O.
    with runtime(case.db) as connection:
        assert connection.execute("select ref from app.album_top_remote_acquisitions where actor_account_id=%s and request_key=%s",
            (case.db.owner.account_id, late_command["request_key"])).fetchone() is None
    original_rows = case.rows()
    overlap = case.apply_with_old_writer_overlap()
    with runtime(case.db) as connection:
        sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, late_args), constraint="top_remote_version_required")
        command, ref = seeded[0]
        assert str(connection.execute(STORE_SQL, case.store_args(command)).fetchone()["ref"]) == ref
    # Added nullable columns are the only row-shape difference, never a new fact.
    assert [{key: value for key, value in row.items() if key not in {"preparation_ref", "attempt_ref"}}
        for row in case.rows() if row["actor_account_id"] == case.db.owner.account_id] == original_rows
    assert_legacy_candidate_generic_plans(case, record_property)
    # Current Python owner must preserve the exact old response, authority and
    # unknown-key semantics after SQL cutoff. These are genuinely pre-cutoff
    # facts, not a fresh-v1 shim or synthetic success injected into the service.
    command, original_ref = seeded[0]
    before_replay = case.rows()
    receipt = case.acquire(command)
    assert receipt["acquisition_ref"] == original_ref
    assert receipt["evidence_version"] == case.facts.digest
    assert receipt["album"] == project_remote_summary(case.facts)
    assert "version" not in receipt and "preparation_ref" not in receipt
    assert case.acquire(command) == receipt
    denied = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != BROWSE)
    assert_error(lambda: case.acquire(command, constraints=denied), "forbidden", 403)
    assert_error(lambda: case.acquire(dict(command, release_group_id=str(uuid4()))), "request_key_conflict", 409)
    assert case.rows() == before_replay and case.calls == []
    one = case.maintain()
    assert one["branch"] == "legacy_initialization" and one["inspected"] == 256
    assert one["capacity"]["legacy_initialized"] is False
    assert one["capacity"]["actor_pending_count"] == 256 and one["capacity"]["counts_complete"] is False
    counted_ref = str(sorted((row for row in case.rows() if row["actor_account_id"] == case.db.owner.account_id),
        key=lambda row: row["ref"])[0]["ref"])
    with case.db.connect() as connection:
        connection.execute("update app.album_top_remote_acquisitions set retired_at=clock_timestamp() where ref=%s", (counted_ref,))
    assert_legacy_candidate_generic_plans(case, record_property, retired_count=1)
    two = case.maintain()
    assert two["inspected"] == 256 and two["capacity"]["actor_pending_count"] == 512
    three = case.maintain()
    assert three["inspected"] == 1 and three["capacity"]["actor_pending_count"] == 513
    assert three["capacity"]["legacy_initialized"] is False
    sentinel = case.maintain()
    assert sentinel["inspected"] == 0 and sentinel["capacity"]["legacy_initialized"] is True
    cleanup = case.maintain()
    assert cleanup["branch"] == "legacy_cleanup" and cleanup["removed_facts"] == 1
    assert cleanup["capacity"]["actor_pending_count"] == 512
    assert not any(str(row["ref"]) == counted_ref for row in case.rows())
    discard = case.maintain(mode="discard_legacy")
    assert discard["removed_facts"] == 256 and discard["more_work"] is True
    assert discard["capacity"]["actor_pending_count"] == 256
    final = case.maintain(mode="discard_legacy")
    assert final["removed_facts"] == 256 and final["more_work"] is False
    assert final["capacity"]["actor_pending_count"] == final["capacity"]["actor_pending_bytes"] == 0
    with runtime(case.db) as connection:
        command, _ = seeded[0]
        sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, case.store_args(command)),
            constraint="top_remote_version_required")
    assert_error(lambda: case.acquire(command), "remote_acquisition_version_required", 409)
    assert case.calls == []
    assert not [row for row in case.rows() if row["actor_account_id"] == case.db.owner.account_id]
    assert len([row for row in case.rows() if row["actor_account_id"] == overlap["actor"].account_id]) == int(overlap["committed_before_cutoff"])
