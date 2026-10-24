"""Authored only; genuine account owner and normalizer, synthetic read driver."""
import pytest
from tests.py.foobar_enhanced_review_testing import *
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

def test_real_account_only_guards_and_separate_lane_evidence(monkeypatch):
    db=install(monkeypatch)
    closed=stream(monkeypatch,[record(-2**63,local=(116444736000000001,0,116444736000000001),cached=(2**64-1,))])
    result=invoke()
    assert (result.records,result.parsed_records,result.local_entries,result.cached_lastfm_entries)==(1,1,3,1)
    assert (result.unresolved_local,result.unresolved_cached_lastfm)==(1,1)
    assert result.items[0].store_key==str(-2**63)
    assert result.items[0].local_provenance=='incomplete_possibly_seeded'
    assert result.next_offset is None and closed==[True]
    assert db.checkouts==db.exits==db.commits==2
    assert db.frames==[[1,SOURCE],[1,SOURCE]] and not db.driver_errors
    assert not any('library.' in sql for sql in db.calls)

def test_null_record_is_unavailable_not_zero_or_clear(monkeypatch):
    install(monkeypatch)
    row=reader.StoreRecord(record().identity,'null','unresolved',None,
        (decoder.RecordDiagnostic('unavailable','null_value'),))
    stream(monkeypatch,[row]); result=invoke(); item=result.items[0]
    assert result.unavailable_records==1 and result.parsed_records==0
    assert item.local_entries is item.cached_lastfm_entries is None
    assert item.unresolved_local is item.unresolved_cached_lastfm is None
    assert item.local_provenance is None and item.diagnostics==( ('unavailable','null_value'), )

def test_alias_pages_do_not_fan_out_record_or_local_count(monkeypatch):
    install(monkeypatch); row=record(mapped=True)
    pages=[reader.FilenameAliasPage(row.identity,('one.flac','two.flac'),False),
        reader.FilenameAliasPage(row.identity,('three.flac',),True)]
    stream(monkeypatch,[row,*pages]); result=invoke()
    assert result.records==1 and result.aliases==3 and result.local_entries==1
    assert result.items[0].aliases==3 and 'one.flac' not in repr(result)

@pytest.mark.parametrize('change',['alias','key','local_order','cached'])
def test_digest_binds_exact_source_evidence_not_aggregate_counts(monkeypatch,change):
    install(monkeypatch); first=record(local=(1,2),cached=(3,),mapped=True)
    stream(monkeypatch,[first,reader.FilenameAliasPage(first.identity,('a.flac',),True)])
    baseline=invoke().evidence_sha256
    second=record(2 if change=='key' else 1,local=(2,1) if change=='local_order' else (1,2),
        cached=(4,) if change=='cached' else (3,),mapped=True)
    stream(monkeypatch,[second,reader.FilenameAliasPage(second.identity,
        ('b.flac' if change=='alias' else 'a.flac',),True)])
    assert invoke().evidence_sha256!=baseline

def test_bounded_pages_exhaust_records_and_bind_identical_upload(monkeypatch):
    db=install(monkeypatch); events=[record(i) for i in range(43)]
    stream(monkeypatch,events); first=invoke()
    assert len(first.items)==20 and first.next_offset==20 and first.records==43
    stream(monkeypatch,events); second=invoke(cmd=command(offset=20,previous_upload_sha256=SHA))
    assert [x.ordinal for x in second.items]==list(range(20,40)) and second.next_offset==40
    stream(monkeypatch,events); last=invoke(cmd=command(offset=40,previous_upload_sha256=SHA))
    assert [x.ordinal for x in last.items]==[40,41,42] and last.next_offset is None
    assert first.evidence_sha256==second.evidence_sha256==last.evidence_sha256
    count=db.checkouts
    with pytest.raises(owner.SourceStale): invoke(cmd=command(offset=20,previous_upload_sha256='b'*64))
    assert db.checkouts==count

@pytest.mark.parametrize('field,value',[('revision',1),('generation',2),('source_exists',False),('session_live',False)])
def test_source_or_session_drift_after_scan_discards_tentative_rows(monkeypatch,field,value):
    db=install(monkeypatch); closed=stream(monkeypatch,[record()],after=lambda:setattr(db,field,value))
    with pytest.raises(owner.SourceStale): invoke()
    assert closed==[True] and db.checkouts==db.exits==2

def test_current_policy_denial_precedes_reader(monkeypatch):
    db=install(monkeypatch)
    def forbidden(*args,**kwargs): raise AssertionError('reader entered')
    monkeypatch.setattr(owner,'open_enhanced_sqlite_snapshot',forbidden)
    with pytest.raises(owner.SourceStale): invoke(constraints=PolicyEvaluationConstraints(request_origin_allowed=False))
    assert db.checkouts==0

@pytest.mark.parametrize('terminal',[reader.StoreReadSummary('foobar_enhanced_sqlite_snapshot_v1',
    'rejected','database_integrity_failed',1,0,0,0),object()])
def test_noncomplete_outer_terminal_never_returns_review(monkeypatch,terminal):
    install(monkeypatch); closed=stream(monkeypatch,[record()],terminal=terminal)
    with pytest.raises(owner.EnhancedReviewRejected): invoke()
    assert closed==[True]

def test_missing_inner_terminal_is_rejected(monkeypatch):
    install(monkeypatch); stream(monkeypatch,[record()]); original=owner.iter_enhanced_record_timestamp_chunks
    def truncated(decoded):
        for part in original(decoded):
            if type(part) is not owner.EnhancedTimestampStreamSummary: yield part
    monkeypatch.setattr(owner,'iter_enhanced_record_timestamp_chunks',truncated)
    with pytest.raises(owner.SourceUnavailable): invoke()

def test_record_limit_rejects_instead_of_truncating(monkeypatch):
    install(monkeypatch); stream(monkeypatch,[record(i) for i in range(3)])
    monkeypatch.setattr(owner,'MAX_SOURCE_RECORDS',2)
    with pytest.raises(owner.EnhancedReviewRejected) as error: invoke()
    assert error.value.reason=='source_record_limit_exceeded'

def test_fixed_logical_phase_admission_before_database(monkeypatch):
    db=install(monkeypatch)
    with pytest.raises(owner.EnhancedReviewInvalid):
        owner.review_enhanced_artifact(URL,context(),command(),path=Path('/synthetic/owned.sqlite'),
            upload_sha256=SHA,logical_capacity_bytes=owner.REVIEW_PHASE_BYTES-1,cancelled=lambda:False)
    assert db.checkouts==0

def test_cancellation_and_missing_alias_final_close_reader(monkeypatch):
    install(monkeypatch); row=record(mapped=True)
    closed=stream(monkeypatch,[row,reader.FilenameAliasPage(row.identity,('a.flac',),False)])
    with pytest.raises(owner.SourceUnavailable): invoke()
    assert closed==[True]
    stream(monkeypatch,[record()])
    with pytest.raises(owner.EnhancedReviewRejected) as error: invoke(cancelled=lambda:True)
    assert error.value.reason=='cancelled'

@pytest.mark.parametrize('mutation',['another_account','retired','missing_source'])
def test_genuine_preguard_rejects_foreign_or_invalidated_source(monkeypatch,mutation):
    from dataclasses import replace
    db=install(monkeypatch); ctx=context()
    if mutation=='another_account': ctx=replace(ctx,target_account_id=2)
    elif mutation=='retired': db.generation=2; db.retired=1
    else: db.source_exists=False
    with pytest.raises(owner.SourceStale):
        owner.validate_enhanced_review_context(URL,ctx,command())
    assert db.checkouts==db.exits


def test_full_max_record_uses_genuine_chunk_iterator_not_full_normalizer(monkeypatch):
    db=install(monkeypatch); row=record(local=(116444736000000001,)*32766,cached=())
    stream(monkeypatch,[row]); original=owner.iter_enhanced_record_timestamp_chunks; sizes=[]
    def tracked(decoded):
        for part in original(decoded):
            if type(part) is owner.EnhancedTimestampChunk: sizes.append(len(part.timestamps))
            yield part
    monkeypatch.setattr(owner,'iter_enhanced_record_timestamp_chunks',tracked)
    result=invoke()
    assert result.local_entries==32766 and result.cached_lastfm_entries==0
    assert len(sizes)==256 and max(sizes)==128 and sum(sizes)==32766
    assert result.items[0].local_provenance=='incomplete_possibly_seeded'
