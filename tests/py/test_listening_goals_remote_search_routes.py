"""Actual session, private perimeter, CSRF, repository and provider adapter seams."""
import pytest

from tests.py.test_listening_goals_postgres import db, urls
from tests.py.test_listening_goals_routes import application, headers, request, ready, add_payload
from tests.py.test_listening_goals_remote_search_postgres import search_service


PATH = '/account/goals/remote-search'


def test_remote_search_exact_evidence_then_add_http_without_library(db):
    ref = db.group()
    service,calls = search_service(db,ref)
    app = application(db)
    app.state.listening_goals_service = service
    auth = headers(app,db)
    before = db.snapshot()
    found = ready(app,'POST',PATH,headers=auth,payload={'title':'Synthetic','artist':'Artist'})
    assert found['candidates'][0]['release_group_id'] == ref
    assert len(calls) == 1 and db.snapshot() == before
    db.payloads[ref]['title'] = 'Verified after selection'
    evidence = ready(app,'POST','/account/goals/remote-evidence',headers=auth,
                     payload={'release_group_id':ref})
    assert evidence['album']['title'] == 'Verified after selection'
    added = ready(app,'POST','/account/goals/add',headers=auth,payload=add_payload(evidence))
    state = ready(app,'GET','/account/goals',headers=auth)
    assert added['changed'] and state['albums'][0]['title'] == 'Verified after selection'
    assert state['albums'][0]['catalog_ref'] == added['catalog_ref']


@pytest.mark.parametrize('failure',['anonymous','csrf','cross_origin','stale_context'])
def test_search_perimeter_denials_never_call_provider(db,failure):
    service,calls = search_service(db,db.group())
    app = application(db)
    app.state.listening_goals_service = service
    auth = headers(app,db)
    if failure == 'anonymous':
        auth = {}
    elif failure == 'csrf':
        auth.pop('x-album-haven-csrf')
    elif failure == 'cross_origin':
        auth['origin'] = 'https://other.example.test'
    else:
        auth['x-albumhaven-context'] = '0'*64
    before = db.snapshot()
    status,body,response_headers = request(app,'POST',PATH,headers=auth,
        payload={'title':'Album','artist':''})
    assert status == (401 if failure == 'anonymous' else 409 if failure == 'stale_context' else 403)
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert calls == [] and db.snapshot() == before


@pytest.mark.parametrize('payload',[
    {'title':'Album'}, {'artist':'Artist'}, {'title':'','artist':''},
    {'title':'Album','artist':'','account_id':999},
    {'title':'Album','artist':'','url':'https://example.invalid'},
    {'title':'Album','artist':'','limit':100},
    {'title':'Album','artist':'','local_album_id':123},
    {'title':'Album','artist':'','evidence_version':'a'*64},
    {'title':'x'*101,'artist':''}, {'title':'Album','artist':None},
])
def test_search_input_is_exact_bounded_and_cannot_supply_authority(db,payload):
    service,calls = search_service(db,db.group())
    app = application(db)
    app.state.listening_goals_service = service
    before = db.snapshot()
    status,body,response_headers = request(app,'POST',PATH,headers=headers(app,db),payload=payload)
    assert status == 400 and body['error'] in {'invalid_command','invalid_search_query'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert calls == [] and db.snapshot() == before


def test_search_candidate_cannot_be_submitted_as_add_authority(db):
    service,calls = search_service(db,db.group())
    app = application(db)
    app.state.listening_goals_service = service
    auth = headers(app,db)
    found = ready(app,'POST',PATH,headers=auth,payload={'title':'Album','artist':''})
    before = db.snapshot()
    status,body,response_headers = request(app,'POST','/account/goals/add',headers=auth,
                                          payload=found['candidates'][0])
    assert status == 400 and body == {'ok':False,'error':'invalid_command'}
    assert response_headers[b'cache-control'] == b'private, no-store'
    assert db.snapshot() == before and db.provider_calls == []
