"""Actual admission CHECK shape enforcement with otherwise valid trusted history."""
from uuid import uuid4
import pytest
from tests.py.remote_top_postgres_support import remote, db, urls, sql_error
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_remote_album_credited_evidence import ARTIST


@pytest.mark.parametrize('array_sql', [
    'ARRAY[]::uuid[]', 'array_fill(%s::uuid,ARRAY[101])', 'ARRAY[NULL]::uuid[]',
    'ARRAY[%s::uuid,NULL]', 'array_fill(%s::uuid,ARRAY[1],ARRAY[0])',
    'array_fill(%s::uuid,ARRAY[1],ARRAY[2])', 'array_fill(%s::uuid,ARRAY[1,1])',
])
def test_direct_admission_shape_rejects_invalid_vector_before_retention_charge(retained, array_sql):
    case = retained
    source = case.top()
    pending = case.pending(source, facts=credit_facts(case.remote))
    catalog = case.mapping(pending)
    admission = case.retain(source, pending, catalog)
    target = case.top()
    before = case.counts(target)
    sql = '''insert into app.album_top_remote_admissions(
        ref,top_ref,library_id,owner_account_id,catalog_ref,
        provider,entity_kind,external_id,evidence_version,title,artist_display,
        first_release_date,primary_type,initiating_actor_account_id,original_session_id,
        original_acquisition_ref,original_destination_kind,original_destination_ref,
        original_context_ref,acquired_at,admission_deadline,admitted_at,credited_artist_ids)
        select %s,%s,library_id,owner_account_id,catalog_ref,
        provider,entity_kind,external_id,evidence_version,title,artist_display,
        first_release_date,primary_type,initiating_actor_account_id,original_session_id,
        original_acquisition_ref,'top',%s,original_context_ref,
        acquired_at,admission_deadline,admitted_at,''' + array_sql + '''
        from app.album_top_remote_admissions where ref=%s'''
    args = (str(uuid4()), target['top_ref'], target['top_ref'])
    if '%s' in array_sql:
        args += (ARTIST,)
    args += (admission,)
    with case.db.connect() as connection:
        sql_error(connection, '23514', lambda: connection.execute(sql, args))
        assert connection.execute('select ref from app.album_top_remote_admissions where top_ref=%s',
            (target['top_ref'],)).fetchall() == []
    assert case.counts(target) == before
