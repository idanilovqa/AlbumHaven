"""Existing HTTP owner with only acquisition service as recorded dispatch seam."""
import asyncio
import pytest
from tests.py.test_album_top_remote_preparation_routes import RemoteService,application,response,actor,mutation_headers,payload_for,ACQUIRE,TOP

class PreviewService(RemoteService):
    def acquire(self,context,**options):return self._record('acquire',context,options)


def invoke(payload,headers=True):
    service=PreviewService();current=actor();app=application(service,current)
    result=asyncio.run(response(app,'POST',ACQUIRE,payload=payload,headers=mutation_headers(app,current) if headers else {}))
    return service,result

@pytest.mark.parametrize('mode',['artist','family'])
def test_scope_is_separate_from_unchanged_acquisition_command(mode):
    body=payload_for('acquire');scope={'root_artist_id':'3','mode':mode};body['artist_scope']=scope
    service,(status,result,headers)=invoke(body)
    assert status==200 and result['status']=='ready' and headers[b'cache-control']==b'private, no-store'
    assert len(service.calls)==1
    operation,context,options=service.calls[0]
    assert operation=='acquire' and options['payload']==payload_for('acquire')
    assert options['artist_scope']==scope and options['context_ref']==result['context_ref']
    assert callable(options['should_cancel'])

@pytest.mark.parametrize('scope',[None,False,[],{}, {'root_artist_id':1,'mode':'artist'}, {'root_artist_id':'1\n','mode':'artist'}, {'root_artist_id':'1','mode':'Artist'}])
def test_invalid_explicit_scope_refuses_before_dispatch(scope):
    body=payload_for('acquire');body['artist_scope']=scope
    service,(status,result,_)=invoke(body)
    assert status==422 and result['error']=='invalid_command' and service.calls==[]

@pytest.mark.parametrize('scope',[None,{'root_artist_id':'1','mode':'artist'}])
def test_saved_scope_override_refuses_before_dispatch(scope):
    body=payload_for('acquire');body.update(destination={'kind':'top','top_ref':TOP,'revision':'1'},artist_scope=scope)
    service,(status,result,_)=invoke(body)
    assert status==422 and result['error']=='invalid_command' and service.calls==[]

def test_ordinary_acquisition_does_not_gain_keyword():
    service,(status,result,_)=invoke(payload_for('acquire'))
    assert status==200 and result['status']=='ready'
    assert 'artist_scope' not in service.calls[0][2] and service.calls[0][2]['payload']==payload_for('acquire')

def test_scoped_acquisition_keeps_actual_private_perimeter():
    body=payload_for('acquire');body['artist_scope']={'root_artist_id':'1','mode':'artist'}
    service,(status,_,_)=invoke(body,headers=False)
    assert status in (403,409) and service.calls==[]
