"""Contract-first actual-role credit facts; only synthetic provider facts supplied."""
from dataclasses import replace
from uuid import UUID

import psycopg
import pytest

from music_app.services.remote_album_evidence import release_group_facts_digest
from tests.py.remote_preparation_postgres_support import preparations, db, urls
from tests.py.remote_top_postgres_support import runtime, sql_error, STORE_SQL, payload
from tests.py.test_remote_preparation_storage_postgres import invoke
from tests.py.test_remote_album_credited_evidence import ARTIST, OTHER

BASE_TYPES = "uuid,bigint,bigint,bigint,text,text,uuid,bigint,bigint,uuid,text,text,uuid,uuid,text,text,text,text,text"
FINISH_OLD = "app.finish_top_remote_attempt(" + BASE_TYPES + ")"
FINISH_NEW = "app.finish_top_remote_attempt(" + BASE_TYPES + ",uuid[])"
BYTES_OLD = "app.top_remote_fact_bytes(text,text,text,text,text,text,text,text)"
BYTES_NEW = "app.top_remote_fact_bytes(text,text,text,text,text,text,text,text,uuid[])"


def credit_facts(case, ids=(ARTIST, OTHER, ARTIST)):
    old = case.facts
    digest = release_group_facts_digest(release_group_id=old.release_group_id,
        title=old.title, artist_display=old.artist_display,
        first_release_date=old.first_release_date, primary_type=old.primary_type,
        credited_artist_ids=ids)
    return replace(old, credited_artist_ids=ids, digest=digest)


def reserved(case):
    parent, target = case.begin()
    command = case.command(parent, target)
    return command, case.reserve(command)


def finish_args(case, command, reservation, facts):
    return (*case.request_args(command), reservation['attempt_ref'],
        reservation['acquisition_ref'], facts.digest, facts.title,
        facts.artist_display, facts.first_release_date, facts.primary_type)


@pytest.mark.parametrize('ids', [None, (ARTIST,), (ARTIST, OTHER, ARTIST), (ARTIST,) * 100])
def test_old_and_extended_finish_keep_exact_facts_and_jsonb_charge(preparations, ids):
    case = preparations
    command, reservation = reserved(case)
    facts = credit_facts(case, ids)
    args = finish_args(case, command, reservation, facts)
    if ids is not None:
        args += ([UUID(value) for value in ids],)
    result = case.sql('finish_top_remote_attempt', args)
    assert result['state'] == 'pending'
    row = case.state()['album_top_remote_acquisitions'][0]
    assert row['evidence_version'] == facts.digest
    assert row['credited_artist_ids'] == (None if ids is None else [UUID(value) for value in ids])
    with case.db.connect() as connection:
        measured = connection.execute('''select octet_length(jsonb_build_array(
            %s::integer,'musicbrainz','release-group',%s::text,%s::text,%s::text,
            %s::text,%s::text,%s::text)::text) as bytes''',
            (1, facts.release_group_id, facts.title, facts.artist_display,
             facts.first_release_date, facts.primary_type, facts.digest)).fetchone()['bytes'] if ids is None else connection.execute('''
            select octet_length(jsonb_build_array(2,'musicbrainz','release-group',
            %s::text,%s::text,%s::text,%s::text,%s::text,%s::uuid[],%s::text)::text) as bytes''',
            (facts.release_group_id, facts.title, facts.artist_display,
             facts.first_release_date, facts.primary_type, [UUID(value) for value in ids], facts.digest)).fetchone()['bytes']
    assert row['facts_bytes'] == measured
    assert result['capacity']['actor_pending_bytes'] == measured
    before = case.state()
    assert case.reserve(command)['facts'] == result['facts']
    assert case.state() == before


@pytest.mark.parametrize('array_sql', [
    "ARRAY[]::uuid[]", "array_fill(%s::uuid,ARRAY[101])",
    "ARRAY[NULL]::uuid[]", "ARRAY[%s::uuid,NULL]",
    "array_fill(%s::uuid,ARRAY[1],ARRAY[0])",
    "array_fill(%s::uuid,ARRAY[1],ARRAY[2])",
    "array_fill(%s::uuid,ARRAY[1,1])",
])
def test_extended_finish_rejects_invalid_sql_array_without_partial_charge(preparations, array_sql):
    case = preparations
    command, reservation = reserved(case)
    facts = credit_facts(case)
    before = case.state()
    args = finish_args(case, command, reservation, facts)
    sql = 'select app.finish_top_remote_attempt(' + ','.join(['%s'] * 19) + ',' + array_sql + ')'
    params = args + ((ARTIST,) if '%s' in array_sql else ())
    with runtime(case.db) as connection:
        with pytest.raises(psycopg.Error):
            with connection.transaction():
                connection.execute(sql, params).fetchone()
    assert case.state() == before


def test_credit_column_is_immutable_after_completion(preparations):
    case = preparations
    command, reservation = reserved(case)
    facts = credit_facts(case)
    case.sql('finish_top_remote_attempt', finish_args(case, command, reservation, facts)
        + ([UUID(value) for value in facts.credited_artist_ids],))
    before = case.state()
    with case.db.connect() as connection:
        sql_error(connection, '55000', lambda: connection.execute(
            'update app.album_top_remote_acquisitions set credited_artist_ids=%s where ref=%s',
            ([UUID(OTHER)], reservation['acquisition_ref'])))
    assert case.state() == before


def test_legacy_store_still_cannot_create_fresh_facts(preparations):
    case = preparations
    old = credit_facts(case, None)
    before = case.state()
    with runtime(case.db) as connection:
        sql_error(connection, '55000', lambda: connection.execute(STORE_SQL,
            case.store_args(payload(), facts=old)), constraint='top_remote_version_required')
    assert case.state() == before


def test_finish_entrypoint_privileges_and_internal_helper_denials(preparations):
    with preparations.db.connect() as connection:
        for signature in (FINISH_OLD, FINISH_NEW):
            row = connection.execute('''select has_function_privilege('album_haven_app',%s,'EXECUTE') as app,
                has_function_privilege('album_haven_readonly',%s,'EXECUTE') as readonly''',
                (signature, signature)).fetchone()
            assert row == {'app': True, 'readonly': False}
        for signature in (BYTES_OLD, BYTES_NEW):
            row = connection.execute('''select has_function_privilege('album_haven_app',%s,'EXECUTE') as app,
                has_function_privilege('album_haven_readonly',%s,'EXECUTE') as readonly''',
                (signature, signature)).fetchone()
            assert row == {'app': False, 'readonly': False}
        for signature in (FINISH_OLD, FINISH_NEW, BYTES_OLD, BYTES_NEW):
            assert connection.execute('''select not exists(select 1 from pg_proc p,
                lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                where p.oid=%s::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as denied''',
                (signature,)).fetchone()['denied'] is True
        for relation in ('app.album_top_remote_acquisitions', 'app.album_top_remote_admissions'):
            for privilege in ('INSERT', 'UPDATE', 'DELETE'):
                assert connection.execute("select has_table_privilege('album_haven_app',%s,%s) as allowed",
                    (relation, privilege)).fetchone()['allowed'] is False


def test_same_transaction_reservation_cannot_finish_credit_facts(preparations):
    case = preparations
    parent, target = case.begin()
    command = case.command(parent, target)
    before = case.state()
    with runtime(case.db) as connection:
        reservation = invoke(connection, 'reserve_top_remote_attempt', case.request_args(command))
        facts = credit_facts(case)
        args = finish_args(case, command, reservation, facts) + ([UUID(value) for value in facts.credited_artist_ids],)
        sql_error(connection, '55000', lambda: invoke(connection, 'finish_top_remote_attempt', args),
            constraint='top_remote_expired')
        connection.rollback()
    assert case.state() == before
