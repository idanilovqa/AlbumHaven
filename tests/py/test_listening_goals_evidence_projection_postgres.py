"""Real stored Goals projection round trips; provider boundary only is synthetic."""
from dataclasses import replace
from uuid import uuid4
import pytest
from music_app.services.listening_goals_postgres import _facts_version
from music_app.services.remote_album_evidence import release_group_facts_digest
from tests.py.test_listening_goals_postgres import db, urls, assert_error


@pytest.mark.parametrize('legacy', [False, True])
def test_validated_provider_facts_bind_exact_persisted_projection(db, legacy):
    ref = db.group()
    full = db.provider(ref, user_agent='synthetic')
    facts = full
    if legacy:
        facts = replace(full, credited_artist_ids=None, digest=release_group_facts_digest(
            release_group_id=ref,title=full.title,artist_display=full.artist_display,
            first_release_date=full.first_release_date,primary_type=full.primary_type))
    service = db.service_for(provider=lambda *args, **kwargs: facts)
    evidence = db.acquire(ref, service=service)
    with db.connect() as con:
        stored = con.execute('select * from app.listening_goal_evidence where ref=%s',
                             (evidence['evidence_ref'],)).fetchone()
    assert stored['evidence_version'] == evidence['evidence_version'] == _facts_version(stored)
    assert (evidence['evidence_version'] == facts.digest) is legacy
    command = db.add_command(evidence)
    receipt = service.execute(db.context(), command)
    snapshot = db.snapshot()
    assert service.execute(db.context(), command) == receipt
    assert db.snapshot() == snapshot


@pytest.mark.parametrize('change', ['digest', 'credits', 'title'])
def test_forged_full_provider_evidence_is_rejected_without_persistence(db, change):
    ref = db.group()
    facts = db.provider(ref, user_agent='synthetic')
    altered = {'digest': {'digest': '0'*64}, 'credits': {'credited_artist_ids': (str(uuid4()),)},
               'title': {'title': facts.title+' changed'}}[change]
    service = db.service_for(provider=lambda *args, **kwargs: replace(facts, **altered))
    before = db.snapshot()
    assert_error(lambda: db.acquire(ref, service=service), 'invalid_provider_metadata', 503)
    assert db.snapshot() == before


@pytest.mark.parametrize('change', ['unknown_version', 'corrupt_title'])
def test_unknown_or_corrupt_stored_projection_remains_fail_closed(db, change):
    evidence = db.acquire()
    cloned = str(uuid4())
    # Insert an independently owned corrupt row via the synthetic migrator;
    # never disable immutable evidence triggers or weaken runtime privileges.
    with db.connect() as con:
        row = con.execute('''insert into app.listening_goal_evidence
            (ref,account_id,original_session_id,provider,entity_kind,external_id,evidence_version,
             title,artist_display,first_release_date,primary_type,created_at,expires_at)
            select %s,account_id,original_session_id,provider,entity_kind,external_id,
                   case when %s then repeat('0',64) else evidence_version end,
                   title || %s,artist_display,first_release_date,primary_type,created_at,expires_at
            from app.listening_goal_evidence where ref=%s returning evidence_version''',
            (cloned,change=='unknown_version',' changed' if change=='corrupt_title' else '',
             evidence['evidence_ref'])).fetchone()
    corrupt = {**evidence,'evidence_ref':cloned,'evidence_version':row['evidence_version']}
    before = db.snapshot()
    assert_error(lambda: db.service.execute(db.context(),db.add_command(corrupt)), 'evidence_unavailable',409)
    assert db.snapshot() == before
