"""Actual post-receipt consumption keeps immutable credits and refunds exact bytes."""
from uuid import UUID, uuid4
import pytest
from tests.py.remote_top_postgres_support import remote, db, urls, evidence
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_remote_album_credited_evidence import ARTIST, OTHER


@pytest.mark.parametrize('action', ['create', 'add', 'save'])
def test_real_receipt_consumption_and_replay_keep_credit_lineage(mixed, action):
    case = mixed
    case.remote.facts = evidence(mbid=str(uuid4()))
    facts = credit_facts(case.remote)
    if action == 'create':
        acquired = case.acquire(facts=facts)
        command = case.command('create', title='Credited Top',
            draft_ref=acquired['destination']['draft_ref'], selections=[pending(acquired)])
    else:
        top, _ = case.create(local=False)
        acquired = case.acquire(top, facts=facts)
        if action == 'add':
            command = case.command('add', top, selections=[pending(acquired)])
        else:
            prior = case.read(top)['edit_draft']['item_selections'][0]
            command = case.command('save', top, title='Credited Top',
                item_selections=[prior, {'kind': 'new_remote', 'source': pending(acquired)}])
    captured = case.acquisitions[acquired['acquisition_ref']]['fact']
    assert captured['credited_artist_ids'] == [UUID(ARTIST), UUID(OTHER), UUID(ARTIST)]
    result = case.execute(command)  # Existing owner asserts receipt, bridge, terminal and exact refund.
    admissions = case.rows('album_top_remote_admissions')
    exact = [entry for entry in admissions if entry['evidence_version'] == facts.digest]
    assert len(exact) == 1
    assert exact[0]['credited_artist_ids'] == captured['credited_artist_ids']
    assert exact[0]['original_acquisition_ref'] == captured['ref']
    before = case.snapshot()
    calls = list(case.remote.calls)
    assert case.execute(command) == result
    assert case.snapshot() == before
    assert case.remote.calls == calls
