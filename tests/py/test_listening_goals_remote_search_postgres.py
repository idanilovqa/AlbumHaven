"""Authenticated search/evidence/Add on the real repository, without a library."""
from dataclasses import replace
from datetime import timedelta

import pytest

from music_app.services.listening_goals_postgres import PostgresListeningGoalsService
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.remote_album_search import search_release_group_candidates
from music_app.services.musicbrainz_http import STRICT_EVIDENCE_POLICY
from tests.py.test_listening_goals_postgres import db, urls, USER_AGENT, assert_error


def search_service(db, ref, *, after_lookup=None, before=None, after=None):
    calls = []
    def getter(url, agent, **options):
        calls.append((url, agent, options))
        if after_lookup:
            after_lookup()
        return {'release-groups':[db.payloads[ref]]}, {
            'status':'network','evidence_policy':STRICT_EVIDENCE_POLICY}
    def searcher(title, artist, **options):
        return search_release_group_candidates(title, artist, get_json=getter, **options)
    service = PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},
        connect=db.connector(before=before,after=after), clock=lambda:db.now,
        provider=db.provider, searcher=searcher, user_agent=USER_AGENT)
    return service, calls


def test_search_produces_only_lookup_targets_then_exact_evidence_and_add(db):
    ref = db.group()
    service, calls = search_service(db,ref)
    before = db.snapshot()
    found = service.search_candidates(db.context(),'Synthetic','Artist')
    assert db.owner.current_library_id is None
    assert len(calls) == 1 and found['limit'] == 10
    candidate = found['candidates'][0]
    assert set(candidate) == {'provider','entity_kind','release_group_id','title',
                              'artist_display','first_release_date','primary_type'}
    assert candidate['provider'] == 'musicbrainz' and candidate['entity_kind'] == 'release-group'
    assert candidate['release_group_id'] == ref
    assert db.snapshot() == before and db.provider_calls == []
    # Search metadata has no admission authority. Exact lookup sees fresh facts;
    # neither the search preview nor its content digest can stand in for evidence.
    db.payloads[ref]['title'] = 'Fresh exact lookup title'
    evidence = service.acquire_evidence(db.context(),candidate['release_group_id'])
    assert evidence['album']['title'] == 'Fresh exact lookup title'
    assert len(db.provider_calls) == 1
    command = db.add_command(evidence)
    added = service.execute(db.context(),command)
    assert added['changed'] and service.read(db.context())['albums'][0]['title'] == 'Fresh exact lookup title'
    assert service.execute(db.context(),command) == added


@pytest.mark.parametrize('failure',['origin','disabled','expired','forged_session'])
def test_search_denied_before_provider_when_account_session_or_constraints_fail(db,failure):
    ref = db.group()
    service,calls = search_service(db,ref)
    actor, constraints = db.owner, None
    if failure == 'origin':
        constraints = PolicyEvaluationConstraints(request_origin_allowed=False)
    elif failure == 'forged_session':
        actor = replace(db.owner,session_id=db.other_actor().session_id)
    else:
        with db.connect() as connection:
            if failure == 'disabled':
                connection.execute('update app.accounts set is_active=false,disabled_at=%s where id=%s',
                                   (db.now,db.owner.account_id))
            else:
                connection.execute('update app.account_sessions set idle_expires_at=%s where id=%s',
                                   (db.now,db.owner.session_id))
    before = db.snapshot()
    assert_error(lambda:service.search_candidates(db.context(actor),'Album','',constraints=constraints),
                 'forbidden',403)
    assert calls == [] and db.snapshot() == before


def test_search_releases_locks_during_io_and_rechecks_session_afterwards(db):
    ref = db.group()
    def revoke():
        with db.connect() as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                               (db.now,db.owner.session_id))
    service,calls = search_service(db,ref,after_lookup=revoke)
    before = db.snapshot()
    assert_error(lambda:service.search_candidates(db.context(),'Album',''),'forbidden',403)
    assert len(calls) == 1 and db.snapshot() == before


@pytest.mark.parametrize('checkpoint',['before','provider','final_session'])
def test_search_cancellation_discards_preview_and_creates_no_evidence(db,checkpoint):
    ref = db.group()
    cancelled = [checkpoint == 'before']
    session_checks = []
    def after(sql,params):
        if 'from app.account_sessions' in sql and 'for update' in sql:
            session_checks.append(True)
            # First authorization has entry/final checks. The second has the
            # post-provider entry and the final response-boundary check.
            if checkpoint == 'final_session' and len(session_checks) == 4:
                cancelled[0] = True
    def after_lookup():
        if checkpoint == 'provider':
            cancelled[0] = True
    service,calls = search_service(db,ref,after_lookup=after_lookup,after=after)
    before = db.snapshot()
    assert_error(lambda:service.search_candidates(db.context(),'Album','',should_cancel=lambda:cancelled[0]),
                 'provider_cancelled',503)
    assert len(calls) == (0 if checkpoint == 'before' else 1)
    if checkpoint == 'final_session':
        assert len(session_checks) == 4
    assert db.snapshot() == before


def test_search_final_session_expiry_discards_preview_without_storage(db):
    ref = db.group()
    checks = []
    def after(sql,params):
        if 'from app.account_sessions' in sql and 'for update' in sql:
            checks.append(True)
            if len(checks) == 4:
                db.now += timedelta(days=2)
    service,calls = search_service(db,ref,after=after)
    before = db.snapshot()
    assert_error(lambda:service.search_candidates(db.context(),'Album',''),'forbidden',403)
    assert len(calls) == 1 and len(checks) == 4 and db.snapshot() == before
