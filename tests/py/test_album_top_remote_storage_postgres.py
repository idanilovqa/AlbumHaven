"""Exact SQL privilege, immutable-fact, and finite-storage admission contracts.

Fresh pending setup uses acknowledged v2 reserve/finish transactions. Historical
retained fixtures remain immutable history; old-writer replay uses a dedicated
pre-cutoff database. No production limits or accounting results are replaced.
"""
from datetime import timedelta
from uuid import UUID, uuid4

import pytest

from tests.py.postgres_runtime_role_contract import assert_runtime_role

from tests.py.test_owned_album_tops_postgres import assert_error
from tests.py.remote_preparation_cutoff_support import cutoff_transition
from tests.py.remote_top_postgres_support import (
    CONTEXT, MBID, RELATIONS, STORE_SIGNATURE, STORE_SQL,
    db, urls, remote, payload, prepared_payload, destination, evidence, runtime, sql_error,
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


# The obsolete lifetime-history 2,000/10,000 and live 100/1,000 expansions
# are explicitly mapped in CONTRACT-MAP.md to real consumed-batch growth and
# A's 512/2,048 physical-capacity owners. No fabricated fresh-v1 seed survives.


def test_final_sql_admission_rechecks_capacity_that_filled_during_provider_io(remote):
    command = remote.prepare_v2()
    parent = {'preparation_ref': command['preparation_ref']}
    target = command['destination']
    for _ in range(510):
        prepared = prepared_payload(parent, target)
        assert remote.finish_v2(prepared, remote.reserve_v2(prepared))['state'] == 'pending'
    seen = []
    def fill_remaining_capacity():
        # The first dispatch owns its committed reservation before the final
        # free slot fills. No long bulk setup runs inside its bounded lease.
        for _ in range(1):
            another = prepared_payload(parent, target)
            reservation = remote.reserve_v2(another)
            assert reservation['dispatch'] is True
            assert remote.finish_v2(another, reservation)['state'] == 'pending'
        before = remote.c2_state()
        refused = remote.reserve_v2(prepared_payload(parent, target))
        assert refused['state'] == 'limit' and refused['resource'] == 'attempts'
        assert remote.c2_state() == before
        seen.append(before)
    remote.provider_hook = fill_remaining_capacity
    receipt = remote.acquire(command)
    assert len(remote.calls) == 1 and len(seen) == 1
    after = remote.c2_state()
    assert len(after['album_top_remote_acquisitions']) == 512
    assert after['album_top_remote_preparations'][0]['pending_count'] == 512
    assert after['album_top_remote_preparations'][0]['reservation_count'] == 0
    assert after['album_top_remote_preparations'][0]['attempt_count'] == 512
    assert remote.acquire(command) == receipt and remote.c2_state() == after


def test_actor_live_capacity_spans_current_libraries_and_draft_buckets(remote):
    database = remote.db
    with database.connect() as connection:
        library = database.library_for(connection, database.owner)
        other_actor = database.member(connection, database.owner, library)
    first = None
    for actor in (database.owner, other_actor, database.owner, other_actor):
        parent, target = remote.begin_v2(actor=actor)
        for _ in range(512):
            command = prepared_payload(parent, target)
            reservation = remote.reserve_v2(command, actor=actor)
            assert reservation['dispatch'] is True
            finished = remote.finish_v2(command, reservation, actor=actor)
            assert finished['state'] == 'pending'
            first = first or (command, finished['facts'])
    state = remote.c2_state()
    assert len(state['album_top_remote_acquisitions']) == 2048
    assert {row['library_id'] for row in state['album_top_remote_acquisitions']} == {database.library, library}
    budget = state['album_top_remote_pending_budgets'][0]
    assert budget['pending_count'] == 2048 and budget['reservation_count'] == 0
    assert budget['pending_bytes'] == sum(row['facts_bytes'] for row in state['album_top_remote_acquisitions'])
    assert remote.reserve_v2(first[0])['facts'] == first[1]
    parent, target = remote.begin_v2()
    before = remote.c2_state()
    refused = remote.reserve_v2(prepared_payload(parent, target))
    assert refused['state'] == 'limit' and refused['resource'] == 'pending'
    assert remote.c2_state() == before and remote.calls == []


def test_sql_bytes_are_derived_not_caller_supplied_and_oversize_is_atomic(remote):
    legacy = payload()
    with runtime(remote.db) as connection:
        sql_error(connection, '55000', lambda: connection.execute(STORE_SQL, remote.store_args(legacy)),
            constraint='top_remote_version_required')
    command = remote.prepare_v2()
    reservation = remote.reserve_v2(command)
    before = remote.c2_state()
    facts = remote.facts
    args = [*remote.binding_v2(command), reservation['attempt_ref'], reservation['acquisition_ref'],
        facts.digest, '\U0001f600' * 5000, facts.artist_display, facts.first_release_date, facts.primary_type]
    with runtime(remote.db) as connection:
        sql_error(connection, '55000', lambda: connection.execute('select app.finish_top_remote_attempt('
            + ','.join(['%s'] * len(args)) + ')', args), constraint='top_remote_expired')
    assert remote.c2_state() == before and remote.rows() == []
    finished = remote.finish_v2(command, reservation)
    row = remote.rows()[0]
    assert row['facts_bytes'] == fact_bytes(remote, facts)
    assert row['expires_at'] - row['created_at'] == timedelta(minutes=30)
    assert row['evidence_version'] == finished['facts']['evidence_version']
    state = remote.c2_state()
    assert state['album_top_remote_pending_budgets'][0]['pending_bytes'] == row['facts_bytes']
    assert state['album_top_remote_preparations'][0]['pending_bytes'] == row['facts_bytes']


def test_sql_helper_exact_key_keeps_first_version_and_conflicting_scope_never_rewrites(cutoff_transition):
    """One explicit seed→A→B run also preserves mixed and legacy HTTP contracts.

    Each fixture invocation needs an independently supplied empty admitted DB;
    this test deliberately does not request the ordinary post-cutoff db fixture.
    """
    from music_app.services.owned_album_tops import BROWSE
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    from tests.py.test_album_top_collaboration_postgres import member, new_session, write
    from tests.py.test_album_top_remote_acquisition_routes import application, call, ready, ACQUIRE, mutation_headers
    from tests.py.remote_top_retention_postgres_support import retention_case, invoke, RETAIN
    from tests.py.test_album_top_remote_membership_postgres import membership_case, pending
    remote = cutoff_transition
    command, first = remote.seed_old_writer(1)[0]
    first_args = remote.store_args(command, ref=first)
    pure_facts = evidence(mbid=str(uuid4()), title='Pre-cutoff pure legacy')
    pure_command = payload(mbid=pure_facts.release_group_id)
    pure_ref = remote.seed_old_command(pure_command, facts=pure_facts)
    mixed_facts = evidence(mbid=str(uuid4()), title='Pre-cutoff mixed legacy')
    mixed_command = payload(mbid=mixed_facts.release_group_id)
    mixed_ref = remote.seed_old_command(mixed_command, facts=mixed_facts)
    app = application(remote)
    auth = mutation_headers(app, remote.db.owner)
    http_facts = evidence(mbid=str(uuid4()), title='Pre-cutoff HTTP')
    http_command = payload(mbid=http_facts.release_group_id)
    http_ref = remote.seed_old_command(http_command, facts=http_facts, context_ref=auth['x-albumhaven-context'])
    top, _ = remote.db.create(refs=[])
    editor = member(remote.db)
    top, _ = write(remote.db, 'grant_editor', top, account_id=editor.account_id, role='editor')
    top_facts = evidence(mbid=str(uuid4()), title='Pre-cutoff editor Top')
    top_command = payload(destination(top), mbid=top_facts.release_group_id)
    remote.seed_old_command(top_command, actor=editor, facts=top_facts)
    original = remote.rows()
    remote.apply_cutoff()
    remote.apply_consumption()
    revised = evidence(title='Later provider result')
    with runtime(remote.db) as connection:
        second = str(connection.execute(STORE_SQL, remote.store_args(command, facts=revised)).fetchone()['ref'])
    assert first == second == first_args[0]
    before = remote.rows()
    assert [{key: value for key, value in row.items() if key not in {'preparation_ref', 'attempt_ref'}}
        for row in before] == original
    for index, value in ((4, 'b' * 64), (6, str(uuid4())), (10, 'f' * 64), (11, str(uuid4()))):
        conflicting = list(first_args); conflicting[0] = str(uuid4()); conflicting[index] = value
        with runtime(remote.db) as connection:
            sql_error(connection, '55000', lambda: connection.execute(STORE_SQL, conflicting),
                constraint='top_remote_request_conflict')
    assert remote.rows() == before
    first_receipt = remote.acquire(command)
    assert first_receipt['acquisition_ref'] == first and 'version' not in first_receipt
    assert remote.acquire(command) == first_receipt
    assert_error(lambda: remote.acquire(command, actor=new_session(remote.db, remote.db.owner)),
        'remote_evidence_unavailable', 409)
    assert_error(lambda: remote.acquire(command, context_ref='b' * 64), 'request_key_conflict', 409)
    for changed in ({**command, 'release_group_id': str(uuid4())}, {**command, 'destination': destination()},
                    {**command, 'destination': destination(top)}):
        assert_error(lambda changed=changed: remote.acquire(changed), 'request_key_conflict', 409)
    with remote.db.connect() as connection:
        other_library = remote.db.library_for(connection, remote.db.owner)
        other_actor = remote.db.member(connection, remote.db.owner, other_library)
    assert_error(lambda: remote.acquire(command, actor=other_actor), 'request_key_conflict', 409)
    denied = lambda context: PolicyEvaluationConstraints(request_origin_allowed=context.action != BROWSE)
    assert_error(lambda: remote.acquire(command, constraints=denied), 'forbidden', 403)
    editor_receipt = remote.acquire(top_command, actor=editor)
    assert_error(lambda: remote.acquire(top_command, actor=new_session(remote.db, editor)), 'remote_evidence_unavailable', 409)
    saved, _ = write(remote.db, 'save', top, title='Later exact Top revision')
    assert_error(lambda: remote.acquire(top_command, actor=editor), 'revision_conflict', 409)
    assert_error(lambda: remote.acquire({**top_command, 'destination': destination(saved)}, actor=editor), 'request_key_conflict', 409)
    saved, _ = write(remote.db, 'revoke_editor', saved, grant_ref=top['grant_ref'])
    assert_error(lambda: remote.acquire(top_command, actor=editor), 'top_unavailable', 404)
    http_receipt = ready(call(app, ACQUIRE, headers=auth, payload=http_command))
    assert http_receipt['acquisition_ref'] == http_ref and 'version' not in http_receipt
    assert ready(call(app, ACQUIRE, headers=auth, payload=http_command)) == http_receipt
    status, body, headers = call(app, ACQUIRE, headers=auth, payload={**http_command, 'destination': destination()})
    assert status == 409 and body == {'ok': False, 'error': 'request_key_conflict'}
    assert headers[b'cache-control'] == b'private, no-store'
    assert remote.rows() == before and remote.calls == []

    with retention_case(remote) as storage, membership_case(storage) as mixed:
        mixed.external_ids.extend([pure_facts.release_group_id, mixed_facts.release_group_id])
        pure_receipt = remote.acquire(pure_command)
        assert pure_receipt['acquisition_ref'] == pure_ref
        pure_top, _ = mixed.create(local=False, acquired=pure_receipt)
        # No preparation initialization is required to retain genuine legacy.
        budgets = remote.c2_state()['album_top_remote_pending_budgets']
        assert not budgets or all(row['legacy_initialized'] is False for row in budgets)
        legacy_rows = [row for row in remote.rows() if row['preparation_ref'] is None]
        assert legacy_rows == before
        # Real bounded scan plus a real empty sentinel, never initialized by DML.
        while not remote.maintain()['capacity']['legacy_initialized']:
            pass
        initial_budget = next(row for row in remote.c2_state()['album_top_remote_pending_budgets']
            if row['actor_account_id'] == remote.db.owner.account_id)
        legacy = remote.acquire(mixed_command)
        fresh = mixed.acquire(target=mixed_command['destination'])
        membership = mixed.command('create', title='Genuine mixed versions',
            draft_ref=mixed_command['destination']['draft_ref'], selections=[pending(legacy), pending(fresh)])
        created = mixed.execute(membership)
        assert len(mixed.read(created)['items']) == 2
        assert [row for row in remote.rows() if row['preparation_ref'] is None] == legacy_rows
        after_budget = next(row for row in remote.c2_state()['album_top_remote_pending_budgets']
            if row['actor_account_id'] == remote.db.owner.account_id)
        assert after_budget['pending_count'] == initial_budget['pending_count']
        assert after_budget['pending_bytes'] == initial_budget['pending_bytes']
        terminals = remote.c2_state()['album_top_remote_attempts']
        assert len(terminals) == 1 and terminals[0]['state'] == 'consumed'
        assert str(terminals[0]['acquisition_ref']) == fresh['acquisition_ref']
        first_admission = next(row for row in mixed.rows('album_top_remote_admissions')
            if str(row['original_acquisition_ref']) == mixed_ref)
        original_fact = next(row for row in legacy_rows if str(row['ref']) == mixed_ref)
        assert first_admission['original_session_id'] == original_fact['original_session_id']
        assert first_admission['original_context_ref'] == original_fact['context_ref']
        assert first_admission['acquired_at'] == original_fact['created_at']
        assert first_admission['admission_deadline'] == original_fact['expires_at']
        item = next(row for row in mixed.read(created)['items'] if row['catalog_ref'] == str(first_admission['catalog_ref']))
        created = mixed.execute(mixed.command('remove', created, item_refs=[item['ref']]))
        same = mixed.acquire(created, facts=mixed_facts)
        created = mixed.execute(mixed.command('add', created, selections=[pending(same)]))
        assert next(row for row in mixed.rows('album_top_remote_admissions') if row['ref'] == first_admission['ref']) == first_admission
        assert len([row for row in mixed.rows('album_top_remote_admissions') if str(row['top_ref']) == created['top_ref']]) == 2
        assert len(remote.calls) == 2

        # Legal one-way retirement retains exact legacy error shape and cannot
        # contact the provider or convert the old key into a fresh acquisition.
        remote.retire_pending(first)
        remote.retire_pending(http_ref)
        retired_before, calls = remote.rows(), len(remote.calls)
        assert_error(lambda: remote.acquire(command), 'remote_evidence_unavailable', 409)
        status, body, headers = call(app, ACQUIRE, headers=auth, payload=http_command)
        assert status == 409 and body == {'ok': False, 'error': 'remote_evidence_unavailable'}
        assert headers[b'cache-control'] == b'private, no-store'
        assert remote.rows() == retired_before and len(remote.calls) == calls

        # True legacy retention holds the same complete runtime prefix as bounded
        # cleanup. A competing real discard must wait, then may reclaim only
        # temporary legacy facts after the outer retention transaction commits.
        pure_admission = next(row for row in mixed.rows('album_top_remote_admissions')
            if str(row['original_acquisition_ref']) == pure_ref)
        pending_before = remote.c2_state()
        durable_before = {key: value for key, value in mixed.snapshot().items()
            if key not in {'pending_acquisitions', 'c2_state'}}
        with runtime(remote.db) as holder:
            assert_runtime_role(holder, remote.db)
            storage.locks(holder, pure_top, pending=pure_receipt)
            assert str(invoke(holder, RETAIN, storage.retain_args(pure_top, pure_receipt,
                str(pure_admission['catalog_ref'])))) == str(pure_admission['ref'])
            with runtime(remote.db) as waiting:
                assert_runtime_role(waiting, remote.db)
                waiting.execute("set local lock_timeout='150ms'")
                sql_error(waiting, '55P03', lambda: waiting.execute(
                    'select app.maintain_top_remote_preparations(%s,%s,%s)',
                    (remote.db.owner.account_id, remote.db.library, 'discard_legacy')))
            assert remote.c2_state() == pending_before
            assert {key: value for key, value in mixed.snapshot().items()
                if key not in {'pending_acquisitions', 'c2_state'}} == durable_before
        charged = [row for row in pending_before['album_top_remote_acquisitions']
            if row['actor_account_id'] == remote.db.owner.account_id and row['preparation_ref'] is None]
        old_budget = next(row for row in pending_before['album_top_remote_pending_budgets']
            if row['actor_account_id'] == remote.db.owner.account_id)
        while True:
            step = remote.maintain(mode='discard_legacy')
            assert step['inspected'] <= 256
            if not step['more_work']:
                break
        after_cleanup = remote.c2_state()
        new_budget = next(row for row in after_cleanup['album_top_remote_pending_budgets']
            if row['actor_account_id'] == remote.db.owner.account_id)
        assert new_budget['pending_count'] == old_budget['pending_count'] - len(charged)
        assert new_budget['pending_bytes'] == old_budget['pending_bytes'] - sum(row['facts_bytes'] for row in charged)
        assert new_budget['reservation_count'] == old_budget['reservation_count']
        removed = {row['ref'] for row in charged}
        assert after_cleanup['album_top_remote_acquisitions'] == [row for row in pending_before['album_top_remote_acquisitions']
            if row['ref'] not in removed]
        assert {key: value for key, value in mixed.snapshot().items()
            if key not in {'pending_acquisitions', 'c2_state'}} == durable_before
        assert next(row for row in mixed.rows('album_top_remote_admissions') if row['ref'] == pure_admission['ref']) == pure_admission
        assert len(remote.calls) == calls

    with runtime(remote.db) as connection:
        sql_error(connection, '55000', lambda: connection.execute(STORE_SQL, remote.store_args(payload())),
            constraint='top_remote_version_required')
    while remote.maintain(mode='discard_legacy')['more_work']:
        pass
    with runtime(remote.db) as connection:
        sql_error(connection, '55000', lambda: connection.execute(STORE_SQL, first_args),
            constraint='top_remote_version_required')
    assert_error(lambda: remote.acquire(command), 'remote_acquisition_version_required', 409)
    assert len(remote.calls) == calls


def test_runtime_role_select_definer_execution_and_absence_of_direct_dml_are_real(remote):
    with runtime(remote.db) as connection:
        runtime_role = assert_runtime_role(connection, remote.db)
        sql_error(connection, "55000", lambda: connection.execute(STORE_SQL, remote.store_args(payload())),
            constraint="top_remote_version_required")
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
        ref = remote.acquire(remote.prepare_v2())["acquisition_ref"]
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
