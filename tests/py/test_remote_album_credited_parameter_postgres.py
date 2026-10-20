"""Actual service forwards UUID-array-compatible facts to the real SQL owner."""
from uuid import UUID
import pytest
from tests.py.remote_preparation_postgres_support import preparations, db, urls
from tests.py.test_album_top_remote_membership_postgres import record_owner_sql
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_remote_album_credited_evidence import ARTIST, OTHER


@pytest.mark.parametrize('ids', [None, (ARTIST,), (ARTIST, OTHER, ARTIST)])
def test_actual_service_finish_binds_uuid_objects_without_changing_credit_order(preparations, ids):
    case = preparations
    case.facts = credit_facts(case, ids)
    parent, target = case.begin()
    command = case.command(parent, target)
    with record_owner_sql(case.db) as statements:
        result = case.acquire(command)
    completions = [(sql, params) for _, sql, params in statements
        if sql.startswith('select app.finish_top_remote_attempt(')]
    assert len(completions) == 1
    _, params = completions[0]
    assert len(params) == 20
    if ids is None:
        assert params[-1] is None
    else:
        assert type(params[-1]) is list
        assert all(type(value) is UUID for value in params[-1])
        assert tuple(str(value) for value in params[-1]) == ids
    assert result['evidence_version'] == case.facts.digest
    assert len(case.calls) == 1
    acquired = case.rows()
    assert len(acquired) == 1
    assert str(acquired[0]['ref']) == result['acquisition_ref']
    assert acquired[0]['credited_artist_ids'] == (None if ids is None else [UUID(value) for value in ids])
