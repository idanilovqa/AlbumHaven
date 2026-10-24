"""Authored only: actual worker/review/rollback owners over retained SQL fixtures.
No execution, native SQL, physical memory or browser claim.
"""
from dataclasses import replace
import pytest
from tests.py.foobar_account_review_testing import (
    running, reviewed, settled_review, review_sha, review, p, route,
    requested_context, PolicyEvaluationConstraints, snapshot, payload_rows,
    confirm, settled, JOB, SOURCE, NEXT_JOB,
)


def inspect(handle,payload,previous,*,after=0,raw=None,library=None):
    request=review.FoobarReviewRequest(previous.request.source_ref,previous.request.job_ref,library,previous.request.resume,
        previous_review_sha256=review_sha(previous),observation_after=after,observation_raw=raw)
    ticket=handle.begin_review(context=requested_context(library),
        constraints=PolicyEvaluationConstraints(),request=request,length=len(payload))
    handle.append_prepare(ticket,payload);handle.finish_prepare(ticket)
    result=settled_review(handle,previous)
    assert result.phase=='review_ready',result
    return result


def test_actual_inspection_pages_keep_semantic_root_and_rollback_every_owner(monkeypatch):
    payload=payload_rows(43)
    with running(monkeypatch) as (db,handle,catalog):
        original=reviewed(handle,payload);before=snapshot(db)
        pages=[];current=original;after=0
        while True:
            current=inspect(handle,payload,current,after=after)
            wire=route._review_wire(current)['review']['observations']
            assert snapshot(db)==before and review_sha(current)==review_sha(original)
            assert len(wire['items'])<=20
            pages.extend(row['row'] for row in wire['items'])
            if wire['next'] is None:break
            after=wire['next']
        assert pages==list(range(1,44))
        assert not db.receipts and not db.job_rows and not db.keys
        confirm(handle,current,payload)
        assert settled(handle).phase=='completed'


def test_actual_both_counts_raw_date_and_full_chunk_continuation(monkeypatch):
    raw='not-a-resolved-date-'+('x'*1100)
    payload=('path\tplay_count\tplay_count_enhanced\tfirst_played\n/a.flac\t0\t23\t'+raw+'\n').encode()
    with running(monkeypatch) as (db,handle,catalog):
        current=reviewed(handle,payload)
        current=inspect(handle,payload,current)
        row=route._review_wire(current)['review']['observations']['items'][0]
        fields={f['field']:f for f in row['incoming']}
        assert fields['play_count']['count']=='0' and fields['play_count_enhanced']['count']=='23'
        assert fields['first_played']['raw_prefix']==raw[:8]
        assert fields['first_played']['raw_characters']==len(raw)
        chunks=[];offset=0
        while True:
            request=p.observation_preview.RawFieldRequest(1,'incoming','first_played',offset)
            current=inspect(handle,payload,current,raw=request)
            value=route._review_wire(current)['review']['observations']['raw_chunk']
            assert len(value['text'])<=512
            chunks.append(value['text'])
            if value['next_offset'] is None:break
            offset=value['next_offset']
        assert ''.join(chunks)==raw and len(chunks)==3
        assert not db.source_rows and not db.receipts


@pytest.mark.parametrize('after',[1,19,21,40])
def test_inspection_cannot_skip_unreviewed_page_cursor(monkeypatch,after):
    payload=payload_rows(43)
    with running(monkeypatch) as (db,handle,catalog):
        previous=reviewed(handle,payload)
        with pytest.raises(review.SourceStale):
            inspect(handle,payload,previous,after=after)
        assert handle.owner.current is None and not db.receipts


def test_raw_continuation_cannot_skip_characters_or_switch_field_at_nonzero_offset(monkeypatch):
    payload=b'path\tfirst_played\n/a.flac\t'+b'x'*1100+b'\n'
    with running(monkeypatch) as (db,handle,catalog):
        current=inspect(handle,payload,reviewed(handle,payload))
        for field,offset in [('first_played',512),('last_played',512)]:
            with pytest.raises(review.SourceStale):
                inspect(handle,payload,current,raw=p.observation_preview.RawFieldRequest(1,'incoming',field,offset))
        assert not db.receipts


def test_serializer_rejects_chunk_from_other_field_length(monkeypatch):
    payload=b'path\tfirst_played\n/a.flac\tlong raw text\n'
    with running(monkeypatch) as (db,handle,catalog):
        current=inspect(handle,payload,reviewed(handle,payload))
        current=inspect(handle,payload,current,raw=p.observation_preview.RawFieldRequest(1,'incoming','first_played',0))
        proposed=current.result.proposed
        bad=replace(proposed.observation_chunk,total_characters=3,text='bad',next_offset=None)
        progress=replace(current,result=replace(current.result,proposed=replace(proposed,observation_chunk=bad)))
        with pytest.raises(route.SourceUnavailable):route._review_wire(progress)


def test_unavailable_new_original_keeps_previous_effective_count_and_origin(monkeypatch):
    first=b'path\tplay_count\tplay_count_enhanced\n/a.flac\t19\t7\n'
    changed=b'path\tplay_count\tplay_count_enhanced\n/a.flac\tN/A\t0\n'
    with running(monkeypatch) as (db,handle,catalog):
        accepted=reviewed(handle,first);confirm(handle,accepted,first)
        assert settled(handle).phase=='completed'
        fresh=reviewed(handle,changed,job_ref=NEXT_JOB)
        before=snapshot(db)
        inspected=inspect(handle,changed,fresh)
        row=route._review_wire(inspected)['review']['observations']['items'][0]
        incoming={f['field']:f for f in row['incoming']}
        effective={f['field']:f for f in row['effective']}
        assert incoming['play_count']['state']=='unavailable' and incoming['play_count']['count'] is None
        assert effective['play_count']['count']=='19'
        assert effective['play_count']['origin'][0]==accepted.result.command.upload_sha256
        assert incoming['play_count']['origin'][0]==fresh.result.command.upload_sha256
        assert effective['play_count_enhanced']['count']=='0'
        assert snapshot(db)==before and review_sha(inspected)==review_sha(fresh)


def test_changed_source_state_requires_fresh_review_before_inspection(monkeypatch):
    payload=payload_rows(2)
    with running(monkeypatch) as (db,handle,catalog):
        previous=reviewed(handle,payload)
        db.revision+=1
        request=review.FoobarReviewRequest(SOURCE,JOB,None,False,
            previous_review_sha256=review_sha(previous),observation_after=0)
        ticket=handle.begin_review(context=requested_context(None),constraints=PolicyEvaluationConstraints(),
            request=request,length=len(payload))
        handle.append_prepare(ticket,payload);handle.finish_prepare(ticket)
        result=settled_review(handle,previous)
        assert result.phase!='review_ready' and result.result is None
        assert not db.receipts and not db.job_rows
