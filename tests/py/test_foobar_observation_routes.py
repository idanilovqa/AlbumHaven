"""Authored only: genuine ASGI handlers, signed context and worker owners.
Synthetic request/SQL boundaries only; no application or backend execution.
"""
import json
import pytest
from tests.py.foobar_account_review_testing import (
    running,reviewed,review_sha,review_request,settled_review,decoded,route,
    payload_rows,snapshot,
)


def inspection_header(req,after=0,raw=None):
    result=[]
    for key,value in req.scope['headers']:
        if key==b'x-albumhaven-foobar-command':
            command=json.loads(value)
            command.update(observation_after=after,observation_raw=raw)
            value=json.dumps(command,separators=(',',':')).encode()
        result.append((key,value))
    req.scope['headers'][:]=result


@pytest.mark.asyncio
async def test_actual_signed_route_review_continuation_exposes_only_requested_bounded_evidence(monkeypatch):
    payload=payload_rows(23)
    with running(monkeypatch) as (db,handle,catalog):
        first=reviewed(handle,payload);before=snapshot(db)
        req,auth,reads=review_request(monkeypatch,handle,'start',payload=payload,
            previous_review_sha256=review_sha(first))
        inspection_header(req)
        response=await route.foobar_account_review_start(req)
        assert response.status_code==202 and reads[0]==1
        actual=settled_review(handle,first)
        assert actual.phase=='review_ready'
        req,auth,reads=review_request(monkeypatch,handle,'status')
        response=await route.foobar_account_review_status(req)
        assert response.status_code==200 and len(response.body)<=131072
        value=decoded(response)
        assert value['protocol']=='foobar_account_review_v4'
        detail=value['result']['review']['observations']
        assert len(detail['items'])==20 and detail['remaining']==3 and detail['next']==20
        assert detail['raw_chunk'] is None
        assert value['result']['review']['review_sha256']==review_sha(first)
        for forbidden in ('/unknown-','observation_ref','track_id','prepared_sha256','window_seals'):
            assert forbidden not in response.body.decode()
        assert snapshot(db)==before


@pytest.mark.asyncio
@pytest.mark.parametrize('raw',[
    {'ordinal':1,'side':'incoming','field':'path','offset':0},
    {'ordinal':1,'side':'incoming','field':'play_count','offset':1},
    {'ordinal':True,'side':'incoming','field':'play_count','offset':0},
    {'ordinal':1,'side':'incoming','field':'play_count','offset':0,'extra':1},
])
async def test_raw_inspection_request_rejects_unknown_or_unbounded_shapes_before_body(monkeypatch,raw):
    payload=payload_rows(1)
    with running(monkeypatch) as (db,handle,catalog):
        first=reviewed(handle,payload)
        req,auth,reads=review_request(monkeypatch,handle,'start',payload=payload,
            previous_review_sha256=review_sha(first))
        inspection_header(req,raw=raw)
        response=await route.foobar_account_review_start(req)
        assert response.status_code==400 and reads[0]==0
        assert handle.owner.current is None and not db.receipts


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['csrf','origin','account'])
async def test_inspection_keeps_real_private_request_authority(monkeypatch,failure):
    payload=payload_rows(1)
    with running(monkeypatch) as (db,handle,catalog):
        first=reviewed(handle,payload)
        req,auth,reads=review_request(monkeypatch,handle,'start',payload=payload,
            previous_review_sha256=review_sha(first),csrf=failure!='csrf',
            origin='https://other.invalid' if failure=='origin' else 'https://synthetic.invalid')
        inspection_header(req)
        if failure=='account':auth.active=False
        response=await route.foobar_account_review_start(req)
        assert response.status_code in (401,403) and reads[0]==0
        assert handle.owner.current is None and not db.receipts
