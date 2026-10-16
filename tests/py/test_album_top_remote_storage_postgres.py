"""Exact SQL privilege, immutable-fact, and finite-storage admission contracts.

Quota data is bounded SQL-generated synthetic history with exact JSONB byte
accounting. The real 10,000/2,000 retained, 1,000/100 live, 32/8 MiB and 16 KiB
limits are never monkeypatched or approximated by low test-only limits.
"""
from datetime import timedelta
from uuid import UUID, uuid4

import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role

from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.remote_top_postgres_support import (
    CONTEXT, MBID, RELATIONS, STORE_SIGNATURE, STORE_SQL,
    db, urls, remote, payload, destination, evidence, runtime, sql_error,
)


def fact_bytes(remote, facts):
    with remote.db.connect() as connection:
        return connection.execute("""select octet_length(jsonb_build_array(
            1,'musicbrainz','release-group',%s::text,%s::text,%s::text,%s::text,%s::text,%s::text)::text) as n""",
            (facts.release_group_id, facts.title, facts.artist_display,
             facts.first_release_date, facts.primary_type, facts.digest)).fetchone()["n"]


def sized_facts(remote, size):
    """Exact valid UTF-8 text payload, measured with PostgreSQL's own projection."""
    minimum = fact_bytes(remote, evidence(title="x", artist="x"))
    extra = size - minimum
    assert 0 <= extra <= 7992
    def text(extra_bytes):
        fours, tail = divmod(extra_bytes, 4)
        return "x" + "\U0001f600" * fours + ("", "a", "é", "€")[tail]
    result = evidence(title=text(min(extra, 3996)), artist=text(max(0, extra - 3996)))
    assert len(result.title) <= 1000 and len(result.artist_display) <= 1000
    assert fact_bytes(remote, result) == size
    return result


def seed_exact_bytes(remote, total, *, target=None, state="expired"):
    """At most 5,000 rows; distribute actor history over separate draft buckets."""
    small = fact_bytes(remote, evidence(title="x", artist="x"))
    large_facts = evidence(title="x" + "\U0001f600" * 999, artist="x" + "\U0001f600" * 999)
    large = fact_bytes(remote, large_facts)
    complete, remainder = divmod(total, large)
    groups = [(complete, large_facts)]
    if remainder:
        if remainder < small:
            groups = [(complete - 1, large_facts), (1, sized_facts(remote, large - small)),
                      (1, sized_facts(remote, small + remainder))]
        else:
            groups.append((1, sized_facts(remote, remainder)))
    assert 0 < sum(count for count, _ in groups) <= 5000
    for count, facts in groups:
        while count:
            chunk = min(count, 500)
            remote.seed(chunk, command=payload(target or destination()), facts=facts, state=state)
            count -= chunk
    assert remote.counts(target)["bytes"] == total


@pytest.mark.parametrize("scope,kind,limit", [
    ("destination", "retained", 2000), ("actor", "retained", 10000),
    ("destination", "live", 100), ("actor", "live", 1000),
])
def test_exact_count_and_live_caps_allow_last_slot_then_replay_but_refuse_growth(remote, scope, kind, limit):
    target = destination()
    state = "expired" if kind == "retained" else "live"
    remaining = limit - 1
    chunk_limit = 1900 if kind == "retained" else 99
    while remaining:
        count = min(remaining, chunk_limit)
        remote.seed(count, command=payload(target if scope == "destination" else destination()), state=state)
        remaining -= count
    before = remote.counts(target if scope == "destination" else None)
    assert before[kind] == limit - 1
    command = payload(target)
    receipt = remote.acquire(command)
    after = remote.counts(target if scope == "destination" else None)
    assert after[kind] == limit
    assert remote.acquire(command) == receipt
    assert remote.counts(target if scope == "destination" else None) == after
    assert len(remote.calls) == 1
    # A new actor-level request uses another draft to prove aggregate accounting.
    next_target = target if scope == "destination" else destination()
    assert_error(lambda: remote.acquire(payload(next_target)), "remote_acquisition_limit", 429)
    assert len(remote.calls) == 1 and remote.counts(target if scope == "destination" else None) == after


@pytest.mark.parametrize("scope,maximum", [("destination", 8 * 1024 * 1024), ("actor", 32 * 1024 * 1024)])
@pytest.mark.parametrize("over", [0, 1])
def test_exact_retained_jsonb_byte_cap_includes_expired_and_retired_history(remote, scope, maximum, over):
    target = destination()
    candidate_size = fact_bytes(remote, remote.facts)
    total = maximum - candidate_size + over
    seed_exact_bytes(remote, total, target=target if scope == "destination" else None,
                     state="expired" if over == 0 else "retired")
    before = remote.counts(target if scope == "destination" else None)
    assert before["bytes"] == total and before["live"] == 0
    command = payload(target)
    if over:
        # Preflight sees space (< cap), but the actual exact SQL addition fails.
        assert total < maximum
        assert_error(lambda: remote.acquire(command), "remote_acquisition_limit", 429)
        assert remote.counts(target if scope == "destination" else None) == before
    else:
        receipt = remote.acquire(command)
        after = remote.counts(target if scope == "destination" else None)
        assert after["bytes"] == maximum and after["retained"] == before["retained"] + 1
        assert remote.acquire(command) == receipt
        assert_error(lambda: remote.acquire(payload(target if scope == "destination" else destination())),
                     "remote_acquisition_limit", 429)
        assert remote.counts(target if scope == "destination" else None) == after
    assert len(remote.calls) == 1


def test_final_sql_admission_rechecks_capacity_that_filled_during_provider_io(remote):
    target = destination()
    remote.provider_hook = lambda: remote.seed(100, command=payload(target), state="live")
    assert_error(lambda: remote.acquire(payload(target)), "remote_acquisition_limit", 429)
    assert len(remote.calls) == 1
    assert remote.counts(target)["retained"] == remote.counts(target)["live"] == 100
    assert all(row["title"] == remote.facts.title for row in remote.rows())


def test_actor_live_capacity_spans_current_libraries_and_draft_buckets(remote):
    database = remote.db
    with database.connect() as connection:
        other_library = database.library_for(connection, database.owner)
        other_context_actor = database.member(connection, database.owner, other_library)
    for _ in range(10):
        remote.seed(100, command=payload(), state="live", actor=other_context_actor)
    assert remote.counts()["live"] == 1000
    assert_error(lambda: remote.acquire(payload()), "remote_acquisition_limit", 429)
    assert remote.calls == [] and remote.counts()["retained"] == 1000


def test_sql_bytes_are_derived_not_caller_supplied_and_oversize_is_atomic(remote):
    command = payload()
    before = remote.rows()
    args = list(remote.store_args(command))
    # Deliberately oversized server-only invocation reaches the real 16 KiB
    # aggregate guard before any INSERT. No fabricated facts_bytes are passed.
    args[13] = "\U0001f600" * 5000
    with runtime(remote.db) as connection:
        sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, args), constraint="top_remote_budget")
    assert remote.rows() == before
    receipt = remote.acquire(command)
    row = remote.rows()[0]
    assert row["facts_bytes"] == fact_bytes(remote, remote.facts)
    assert row["expires_at"] - row["created_at"] == timedelta(minutes=30)
    assert row["evidence_version"] == receipt["evidence_version"]


def test_sql_helper_exact_key_keeps_first_version_and_conflicting_scope_never_rewrites(remote):
    command = payload()
    first_args = remote.store_args(command)
    with runtime(remote.db) as connection:
        first = str(connection.execute(STORE_SQL, first_args).fetchone()["ref"])
    revised = evidence(title="Later provider result")
    with runtime(remote.db) as connection:
        second = str(connection.execute(STORE_SQL, remote.store_args(command, facts=revised)).fetchone()["ref"])
    assert first == second == first_args[0]
    before = remote.rows()
    assert before[0]["title"] == remote.facts.title
    for index, value in ((4, "b" * 64), (6, str(uuid4())), (10, "f" * 64), (11, str(uuid4()))):
        conflicting = list(first_args)
        conflicting[0] = str(uuid4())
        conflicting[index] = value
        with runtime(remote.db) as connection:
            sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, conflicting), constraint="top_remote_request_conflict")
    assert remote.rows() == before


def test_runtime_role_select_definer_execution_and_absence_of_direct_dml_are_real(remote):
    with runtime(remote.db) as connection:
        runtime_role = assert_runtime_role(connection, remote.db)
        for relation in RELATIONS:
            assert connection.execute(f"select * from app.{relation} where false").fetchall() == []
            for sql in (f"insert into app.{relation} default values", f"delete from app.{relation} where false",
                        f"truncate app.{relation}"):
                sql_error(connection, "42501", lambda sql=sql: connection.execute(sql))
            column = "catalog_ref" if relation == "album_list_item_remote_sources" else "retired_at"
            sql_error(connection, "42501", lambda: connection.execute(f"update app.{relation} set {column}={column} where false"))
    with remote.db.connect() as connection:
        assert connection.execute("select rolsuper from pg_roles where rolname=current_user").fetchone()["rolsuper"] is False
        for relation in RELATIONS:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"):
                actual = connection.execute("""select has_table_privilege('album_haven_app',%s,%s) as runtime,
                    has_table_privilege(%s,%s,%s) as connected,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly""",
                    ("app." + relation, privilege, runtime_role, "app." + relation, privilege, "app." + relation, privilege)).fetchone()
                assert actual == {"runtime": privilege == "SELECT", "connected": privilege == "SELECT", "readonly": False}
            assert connection.execute("""select count(*) as n from pg_class c cross join lateral
                aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
                where c.oid=%s::regclass and a.grantee=0""", ("app." + relation,)).fetchone()["n"] == 0
        actual = connection.execute("""select p.prosecdef,p.proconfig,r.rolsuper,
            has_function_privilege('album_haven_app',p.oid,'EXECUTE') as runtime,
            has_function_privilege(%s,p.oid,'EXECUTE') as connected,
            has_function_privilege('album_haven_readonly',p.oid,'EXECUTE') as readonly
            from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=%s::regprocedure""", (runtime_role, STORE_SIGNATURE)).fetchone()
        assert actual == {"prosecdef": True, "proconfig": ["search_path=pg_catalog"], "rolsuper": False,
                          "runtime": True, "connected": True, "readonly": False}
        assert connection.execute("""select count(*) as n from pg_proc p cross join lateral
            aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where p.oid=%s::regprocedure and a.grantee=0""", (STORE_SIGNATURE,)).fetchone()["n"] == 0
        for role in dict.fromkeys(('album_haven_app', runtime_role)):
            assert connection.execute("select has_function_privilege(%s,'app.guard_top_remote_facts()','EXECUTE') as allowed",
                                      (role,)).fetchone()["allowed"] is False


def retained(remote):
    """Trusted synthetic retained shape; there is deliberately no R-A writer."""
    database = remote.db
    top, _ = database.create(refs=database.album_refs[:1])
    item = database.read(top)["items"][0]
    admission, missing_pending = str(uuid4()), str(uuid4())
    facts = remote.facts
    with database.connect() as connection:
        connection.execute("""insert into app.album_top_remote_admissions(ref,top_ref,library_id,owner_account_id,
            catalog_ref,provider,entity_kind,external_id,evidence_version,title,artist_display,first_release_date,
            primary_type,initiating_actor_account_id,original_session_id,original_acquisition_ref,
            original_destination_kind,original_destination_ref,original_context_ref,acquired_at,
            admission_deadline,admitted_at)
            values(%s,%s,%s,%s,%s,'musicbrainz','release-group',%s,%s,%s,%s,%s,%s,%s,%s,%s,
                   'top',%s,%s,statement_timestamp()-interval '2 minutes',
                   statement_timestamp()+interval '28 minutes',statement_timestamp()-interval '1 minute')""",
            (admission, top["top_ref"], database.library, database.owner.account_id, item["catalog_ref"],
             facts.release_group_id, facts.digest, facts.title, facts.artist_display, facts.first_release_date,
             facts.primary_type, database.owner.account_id, database.owner.session_id,
             missing_pending, top["top_ref"], CONTEXT))
    return top, item, admission, missing_pending


@pytest.mark.parametrize("relation", ["album_top_remote_acquisitions", "album_top_remote_admissions"])
def test_facts_are_immutable_even_to_trusted_owner_and_retirement_is_monotonic(remote, relation):
    if relation == "album_top_remote_acquisitions":
        ref = remote.acquire(payload())["acquisition_ref"]
    else:
        _, _, ref, _ = retained(remote)
    with remote.db.connect() as connection:
        for sql in (f"update app.{relation} set title='Rewritten' where ref=%s",
                    f"delete from app.{relation} where ref=%s",
                    f"update app.{relation} set retired_at=null where ref=%s"):
            sql_error(connection, "55000", lambda sql=sql: connection.execute(sql, (ref,)), constraint="top_remote_facts_immutable")
        original = connection.execute(f"select * from app.{relation} where ref=%s", (ref,)).fetchone()
        connection.execute(f"update app.{relation} set retired_at=clock_timestamp() where ref=%s", (ref,))
        retired_row = connection.execute(f"select * from app.{relation} where ref=%s", (ref,)).fetchone()
        assert retired_row["retired_at"] is not None
        assert {key: value for key, value in retired_row.items() if key != "retired_at"} == {
            key: value for key, value in original.items() if key != "retired_at"}
        for value in ("null", "retired_at", "retired_at+interval '1 second'"):
            sql_error(connection, "55000", lambda value=value: connection.execute(
                f"update app.{relation} set retired_at={value} where ref=%s", (ref,)), constraint="top_remote_facts_immutable")
        sql_error(connection, "55000", lambda: connection.execute(f"delete from app.{relation} where ref=%s", (ref,)),
                  constraint="top_remote_facts_immutable")


def test_retained_schema_has_exact_item_top_library_owner_catalog_keys_and_no_pending_lifetime_dependency(remote):
    database = remote.db
    top, item, admission, missing_pending = retained(remote)
    other_top, _ = database.create(refs=database.album_refs[1:2])
    other_item = database.read(other_top)["items"][0]
    with database.connect() as connection:
        assert connection.execute("select ref from app.album_top_remote_acquisitions where ref=%s", (missing_pending,)).fetchone() is None
        sql = """insert into app.album_list_item_remote_sources
            (top_ref,item_ref,library_id,owner_account_id,catalog_ref,admission_ref) values(%s,%s,%s,%s,%s,%s)"""
        values = [top["top_ref"], item["ref"], database.library, database.owner.account_id, item["catalog_ref"], admission]
        for index, value in ((0, other_top["top_ref"]), (1, other_item["ref"]), (2, database.library + 1000000),
                             (3, database.owner.account_id + 1000000), (4, other_item["catalog_ref"]), (5, str(uuid4()))):
            wrong = list(values)
            wrong[index] = value
            sql_error(connection, "23503", lambda wrong=wrong: connection.execute(sql, wrong))
        connection.execute(sql, values)
        assert connection.execute("select admission_ref from app.album_list_item_remote_sources where top_ref=%s and item_ref=%s",
                                  (top["top_ref"], item["ref"])).fetchone()["admission_ref"] == UUID(admission)
        # Removing the source-owning item only removes the item bridge. The
        # retained admission survives, independently of pending acquisition.
        connection.execute("delete from app.album_list_items where ref=%s", (item["ref"],))
        assert connection.execute("select * from app.album_list_item_remote_sources where top_ref=%s", (top["top_ref"],)).fetchall() == []
        assert connection.execute("select ref from app.album_top_remote_admissions where ref=%s", (admission,)).fetchone() is not None
        assert connection.execute("select * from catalog.release_group_provider_identities where external_id=%s", (MBID,)).fetchall() == []
        foreign = connection.execute("""select confrelid::regclass::text as target from pg_constraint
            where conrelid='app.album_top_remote_admissions'::regclass and contype='f'""").fetchall()
        assert not {"app.album_top_remote_acquisitions", "app.album_list_items"} & {row["target"] for row in foreign}
