"""Actual HTTP perimeter/dispatch; SQL authority is covered by the separate suite."""
import asyncio
import pytest
from tests.py.test_album_top_remote_preparation_routes import (
    RemoteService, application, response, actor, mutation_headers, payload_for, SEARCH, TOP)


class ScopedService(RemoteService):
    def search_candidates(self, context, **options):
        return self._record('search', context, options)


def invoke(payload, *, headers=True):
    service=ScopedService();current=actor();app=application(service,current)
    result=asyncio.run(response(app,'POST',SEARCH,payload=payload,
        headers=mutation_headers(app,current) if headers else {}))
    return service,result


@pytest.mark.parametrize('mode',['artist','family'])
def test_scope_passes_existing_http_owner_with_exact_current_context(mode):
    payload=payload_for('search');payload['artist_scope']={'root_artist_id':'9223372036854775807','mode':mode}
    service,(status,body,headers)=invoke(payload)
    assert status==200 and body['status']=='ready'
    assert headers[b'cache-control']==b'private, no-store'
    assert len(service.calls)==1
    operation,context,options=service.calls[0]
    assert operation=='search' and options['artist_scope']==payload['artist_scope']
    assert options['destination']==payload['destination']
    assert options['title']==payload['title'] and options['artist']==payload['artist']
    assert options['context_ref']==body['context_ref']
    assert callable(options['should_cancel'])


@pytest.mark.parametrize('scope',[None,False,[],{}, {'root_artist_id':'1'},
    {'root_artist_id':1,'mode':'artist'}, {'root_artist_id':'01','mode':'artist'},
    {'root_artist_id':'1\n','mode':'artist'}, {'root_artist_id':'1','mode':'Family'},
    {'root_artist_id':'1','mode':'artist','extra':True}])
def test_malformed_explicit_scope_rejects_before_service(scope):
    payload=payload_for('search');payload['artist_scope']=scope
    service,(status,body,_)=invoke(payload)
    assert status==422 and body['error']=='invalid_command'
    assert service.calls==[]


@pytest.mark.parametrize('scope',[None,{'root_artist_id':'1','mode':'artist'}])
def test_saved_destination_never_accepts_caller_scope(scope):
    payload=payload_for('search');payload['destination']={'kind':'top','top_ref':TOP,'revision':'1'}
    payload['artist_scope']=scope
    service,(status,body,_)=invoke(payload)
    assert status==422 and body['error']=='invalid_command' and service.calls==[]


def test_ordinary_search_omits_new_keyword():
    service,(status,body,_)=invoke(payload_for('search'))
    assert status==200 and body['status']=='ready'
    assert len(service.calls)==1 and 'artist_scope' not in service.calls[0][2]


def test_scoped_request_keeps_existing_body_limit():
    payload=payload_for('search');payload['artist_scope']={'root_artist_id':'1','mode':'artist'}
    payload['title']='x'*5000
    service,(status,body,_)=invoke(payload)
    assert status==413 and service.calls==[]


def test_scoped_request_cannot_bypass_existing_private_perimeter():
    payload=payload_for('search');payload['artist_scope']={'root_artist_id':'1','mode':'artist'}
    service,(status,body,_)=invoke(payload,headers=False)
    assert status in (403,409) and service.calls==[]
