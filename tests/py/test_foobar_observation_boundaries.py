"""Authored only: additional genuine merge/Unicode boundary obligations."""
import json
import pytest
from tests.py.test_foobar_observation_review import inspect
from tests.py.foobar_account_review_testing import (
    running,reviewed,confirm,settled,route,p,NEXT_JOB,snapshot,
)


@pytest.mark.parametrize('state,raw,expected',[
    ('invalid','not-a-count',None),('unavailable','N/A','19'),
    ('empty','','19'),('absent',None,'19'),
])
def test_original_invalid_is_not_retention_or_other_family_fallback(monkeypatch,state,raw,expected):
    first=b'path\tplay_count\tplay_count_enhanced\n/a.flac\t19\t7\n'
    if raw is None:
        changed=b'path\tplay_count_enhanced\n/a.flac\t0\n'
    else:
        changed=('path\tplay_count\tplay_count_enhanced\n/a.flac\t'+raw+'\t0\n').encode()
    with running(monkeypatch) as (db,handle,catalog):
        accepted=reviewed(handle,first);confirm(handle,accepted,first)
        assert settled(handle).phase=='completed'
        current=reviewed(handle,changed,job_ref=NEXT_JOB);before=snapshot(db)
        current=inspect(handle,changed,current)
        row=route._review_wire(current)['review']['observations']['items'][0]
        original={f['field']:f for f in row['incoming']}
        effective={f['field']:f for f in row['effective']}
        assert original['play_count']['state']==state and original['play_count']['count'] is None
        assert effective['play_count']['count']==expected
        assert effective['play_count_enhanced']['count']=='0'
        if state=='invalid':
            assert effective['play_count']['state']=='invalid'
            assert effective['play_count']['code']=='invalid_count'
            assert effective['play_count']['origin'][0]==current.result.command.upload_sha256
        else:
            assert effective['play_count']['origin'][0]==accepted.result.command.upload_sha256
        assert snapshot(db)==before


def astral_payload(points):
    date='😀'*points
    header='path\tartist\ttitle\talbum\tplay_count\tplay_count_enhanced\tfirst_played\n'
    lines=[f'/source-{i}.flac\t'+('界'*16)+'\t'+('界'*32)+'\t'+('界'*16)
        +'\t9223372036854775807\t0\t'+date+'\n' for i in range(20)]
    return (header+''.join(lines)).encode()


def test_twenty_admitted_utf8_date_cells_have_bounded_astral_chunk_and_strict_wire(monkeypatch):
    payload=astral_payload(1024)
    with running(monkeypatch) as (db,handle,catalog):
        current=inspect(handle,payload,reviewed(handle,payload));before=snapshot(db)
        request=p.observation_preview.RawFieldRequest(20,'incoming','first_played',0)
        current=inspect(handle,payload,current,raw=request)
        wire=route._review_wire(current)
        page=wire['review']['observations']
        assert len(page['items'])==20 and page['remaining']==0 and page['next'] is None
        assert page['raw_chunk']['text']=='😀'*512
        assert page['raw_chunk']['total_characters']==1024 and page['raw_chunk']['next_offset']==512
        for row in page['items']:
            fields={f['field']:f for f in row['incoming']}
            assert fields['first_played']['raw_prefix']=='😀'*8
            assert fields['play_count']['count']=='9223372036854775807'
            assert fields['play_count_enhanced']['count']=='0'
            assert len(row['source_title'].encode())==96
        response=route._ui_response(dict(protocol=route.REVIEW_PROTOCOL,result=wire),'a'*64)
        assert response.status_code==200 and len(response.body)<=131072
        assert json.loads(response.body)['result']['review']['observations']==json.loads(json.dumps(page))
        assert snapshot(db)==before and not db.receipts


def test_twenty_max_utf8_date_cells_reject_no_fit_without_import_mutation(monkeypatch):
    # Parser accepts 16384 UTF8 bytes, but aggregate Prepare can still reject a
    # single such row under its unchanged 4 MiB retained-evidence bound.
    from tests.py.foobar_account_job_worker_testing import begin_review, settled_review
    payload=astral_payload(4096)
    with running(monkeypatch) as (db,handle,catalog):
        before=snapshot(db)
        begin_review(handle,payload)
        progress=settled_review(handle)
        assert progress.phase == 'review_unavailable' and progress.result is None
        assert snapshot(db)==before and not db.receipts and not db.source_rows
        assert not db.job_rows and not db.keys and not db.attempts
