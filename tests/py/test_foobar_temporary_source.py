"""Synthetic repository contract tests; not real PostgreSQL proof."""
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from music_app.services import foobar_account_temporary_source as m

SOURCE='00000000-0000-4000-8000-000000000001'
JOB='00000000-0000-4000-8000-000000000002'
NOW=datetime(2026,10,24,tzinfo=timezone.utc)
PAYLOAD=b'private synthetic source bytes'


def identity(payload=PAYLOAD):
    return m.TemporarySourceIdentity(SOURCE,JOB,m.gate.MAPPING,sha256(payload).hexdigest(),len(payload))


class Cursor:
    def __init__(self, rows): self.rows=rows; self.closed=False
    def fetchmany(self,n): return self.rows[:n]
    def close(self): self.closed=True


class Connection:
    def __init__(self):
        self.metadata={}; self.chunks={}; self.completed=set(); self.calls=[]; self.cursors=[]
    def execute(self,sql,params=()):
        self.calls.append((sql,params)); result=[]
        if sql.startswith('select id '): result=[{'id':1}]
        elif sql.startswith('delete from integration.foobar_temporary_sources_v1 where account_id in'):
            expired=sorted((row['expires_at'],account) for account,row in self.metadata.items() if row['expires_at']<=params[0])
            if expired:self._delete(expired[0][1])
        elif sql.startswith('delete from integration.foobar_temporary_sources_v1 where account_id'): self._delete(params[0])
        elif sql.startswith('select source_ref::text source_ref,job_ref::text'):
            row=self.metadata.get(params[0]); result=[dict(row)] if row else []
        elif sql.startswith('select count(*)'):
            result=[{'copies':len(self.metadata),'bytes':sum(r['byte_length'] for r in self.metadata.values())}]
        elif sql.startswith('select source_ref::text source_ref from integration.foobar_import_streams_v2'):
            result=[{'source_ref':params[1]}]
        elif sql.startswith('insert into integration.foobar_temporary_sources_v1'):
            account,*values=params
            self.metadata[account]=dict(zip(('source_ref','job_ref','mapping_name','upload_sha256','byte_length','created_at','expires_at'),values))
        elif sql.startswith('insert into integration.foobar_temporary_source_chunks_v1'):
            self.chunks[params[:2]]=params[2]
        elif sql.startswith('select payload'):
            payload=self.chunks.get(params);result=[{'payload':payload}] if payload is not None else []
        elif sql.startswith('select chunk_no'):
            result=[{'chunk_no':n} for a,n in self.chunks if a==params[0] and n>=params[1]][:1]
        elif sql.startswith('select job_ref::text job_ref'):
            result=[({'job_ref':params[2],'upload_sha256':identity().upload_sha256,'mapping_name':m.gate.MAPPING}
                if 'encode(upload_sha256' in sql else {'job_ref':params[2]})] if params in self.completed else []
        else: raise AssertionError(sql)
        cursor=Cursor(result);self.cursors.append(cursor);return cursor
    def _delete(self,account):
        self.metadata.pop(account,None)
        for key in list(self.chunks):
            if key[0]==account: del self.chunks[key]


@pytest.fixture
def repository(monkeypatch):
    c=Connection(); actor=SimpleNamespace(account_id=1,session_id=10)
    @contextmanager
    def transaction(url,context,*,constraints=None):
        old_metadata={k:dict(v) for k,v in c.metadata.items()};old_chunks=dict(c.chunks)
        try: yield c,SimpleNamespace(actor=actor),NOW
        except BaseException:
            c.metadata=old_metadata;c.chunks=old_chunks;raise
    monkeypatch.setattr(m,'current_foobar_account_transaction',transaction)
    return c,actor


def save(chunks=None,ident=None,**kwargs):
    return m.save_temporary_source('synthetic',object(),identity=ident or identity(),chunks=[PAYLOAD] if chunks is None else chunks,**kwargs)


def test_save_atomic_fixed_expiry_and_readback(repository):
    c,_=repository; assert save()==NOW+timedelta(hours=24)
    assert c.chunks[(1,0)]==PAYLOAD
    with m.materialize_temporary_source('synthetic',object(),identity=identity()) as artifact:
        path=artifact.path;assert path.read_bytes()==PAYLOAD;assert artifact.sha256==identity().upload_sha256
    assert not path.exists();assert all(cursor.closed for cursor in c.cursors)


def test_equal_copy_does_not_extend_ttl_or_rewrite(repository):
    c,_=repository;save();expiry=c.metadata[1]['expires_at'];c.calls.clear();assert save()==expiry
    assert not any(sql.startswith('insert') for sql,_ in c.calls)


def test_different_copy_rejected_without_replacing(repository):
    c,_=repository;save();other=identity(b'other')
    with pytest.raises(m.TemporarySourceCapacity):save([b'other'],other)
    assert c.chunks[(1,0)]==PAYLOAD


@pytest.mark.parametrize('chunks',[[],[b'wrong'],[PAYLOAD,b'extra'],[bytearray(PAYLOAD)],[b''],[b'a'*(m.CHUNK_BYTES+1)]])
def test_invalid_content_rolls_back(repository,chunks):
    c,_=repository
    with pytest.raises(m.gate.PrepareInvalid):save(chunks)
    assert not c.metadata and not c.chunks


def test_cancel_rolls_back(repository):
    c,_=repository
    with pytest.raises(m.SourceUnavailable):save(cancelled=lambda:True)
    assert not c.metadata and not c.chunks


def test_expiry_denies_read_without_ttl_extension(repository):
    c,_=repository;save();c.metadata[1]['expires_at']=NOW;c.metadata[1]['created_at']=NOW-m.TTL
    with pytest.raises(m.TemporarySourceMissing):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pass
    assert c.metadata[1]['expires_at']==NOW


def test_other_account_cannot_read_raw_copy(repository):
    c,actor=repository;save();actor.account_id=2
    with pytest.raises(m.TemporarySourceMissing):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pass
    assert c.chunks[(1,0)]==PAYLOAD


@pytest.mark.parametrize('change',['missing','corrupt','extra'])
def test_corrupt_or_incomplete_copy_cannot_materialize(repository,change):
    c,_=repository;save()
    if change=='missing':c.chunks.clear()
    if change=='corrupt':c.chunks[(1,0)]=b'x'*len(PAYLOAD)
    if change=='extra':c.chunks[(1,1)]=b'extra'
    with pytest.raises(m.TemporarySourceMissing):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pass


def test_completion_must_be_durable_and_matching(repository):
    c,_=repository;save()
    with pytest.raises(m.SourceStale):m.remove_completed_temporary_source('synthetic',object(),source_ref=SOURCE,job_ref=JOB)
    assert c.chunks
    c.completed.add((1,SOURCE,JOB))
    m.remove_completed_temporary_source('synthetic',object(),source_ref=SOURCE,job_ref=JOB)
    assert not c.chunks and not c.metadata


def test_expired_copy_removed_on_save_without_changing_other_account(repository):
    c,actor=repository;save();c.metadata[1]['expires_at']=NOW;c.metadata[1]['created_at']=NOW-m.TTL;actor.account_id=2;save()
    assert set(c.metadata)=={2} and set(c.chunks)=={(2,0)}


def test_invalid_identity_rejected_before_transaction(repository):
    c,_=repository
    with pytest.raises(m.gate.PrepareInvalid):save(ident=object())
    assert c.calls==[]


def test_completion_never_deletes_other_job_copy(repository):
    c,_=repository;save();other='00000000-0000-4000-8000-000000000003'
    c.completed.add((1,SOURCE,other))
    m.remove_completed_temporary_source('synthetic',object(),source_ref=SOURCE,job_ref=other)
    assert c.chunks[(1,0)]==PAYLOAD


def test_completion_never_deletes_mismatched_artifact(repository):
    c,_=repository;save();c.metadata[1]['upload_sha256']='f'*64;c.completed.add((1,SOURCE,JOB))
    m.remove_completed_temporary_source('synthetic',object(),source_ref=SOURCE,job_ref=JOB)
    assert c.chunks[(1,0)]==PAYLOAD


def test_completed_job_cannot_store_new_raw_copy(repository):
    c,_=repository;c.completed.add((1,SOURCE,JOB))
    with pytest.raises(m.TemporarySourceMissing):save()
    assert not c.metadata and not c.chunks


def test_completed_copy_unreadable_even_if_cleanup_failed(repository):
    c,_=repository;save();c.completed.add((1,SOURCE,JOB))
    with pytest.raises(m.TemporarySourceMissing):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pass
    assert m.temporary_source_status('synthetic',object(),source_ref=SOURCE,job_ref=JOB).identity is None


@pytest.mark.parametrize('limit',['copies','bytes'])
def test_global_quota_rejects_without_adding_copy(repository,limit,monkeypatch):
    c,actor=repository;actor.account_id=500
    original=c.execute
    def execute(sql,params=()):
        if sql.startswith('select count(*)'):
            return Cursor([{'copies':m.MAX_ACTIVE_COPIES if limit=='copies' else 1,
                            'bytes':m.MAX_TOTAL_BYTES if limit=='bytes' else 1}])
        return original(sql,params)
    monkeypatch.setattr(c,'execute',execute)
    with pytest.raises(m.TemporarySourceCapacity):save()
    assert not c.metadata and not c.chunks


def test_database_failure_has_no_unchecked_memory_fallback(repository,monkeypatch):
    c,_=repository
    def fail(*args):raise OSError('synthetic database unavailable')
    monkeypatch.setattr(c,'execute',fail)
    with pytest.raises(OSError):save()
    assert not c.metadata and not c.chunks


def test_optional_worker_retention_failure_preserves_normal_payload(monkeypatch):
    from music_app.services import foobar_account_import_service as service
    owner=SimpleNamespace(retain_raw_enabled=True,database_url='synthetic')
    command=SimpleNamespace(source_ref=SOURCE,job_ref=JOB,mapping_name=m.gate.MAPPING)
    operation=SimpleNamespace(retain_source=True,retained_identity=None,retention_attempted=False,
        command=command,kind=service._Kind.REVIEW,context=object(),constraints=None,
        job_cancel=SimpleNamespace(is_set=lambda:False))
    def fail(*args,**kwargs):raise m.TemporarySourceCapacity()
    monkeypatch.setattr(m,'save_temporary_source',fail)
    assert service._retain_raw_source(owner,operation,payload=PAYLOAD) is None
    assert operation.retention_attempted is True
    assert PAYLOAD==b'private synthetic source bytes'


def test_no_raw_storage_without_both_deployment_and_user_opt_in(monkeypatch):
    from music_app.services import foobar_account_import_service as service
    def forbidden(*args,**kwargs):raise AssertionError('retention not authorized')
    monkeypatch.setattr(m,'save_temporary_source',forbidden)
    for enabled,consent in [(False,False),(False,True),(True,False)]:
        owner=SimpleNamespace(retain_raw_enabled=enabled)
        op=SimpleNamespace(retain_source=consent,retained_identity=None,retention_attempted=False)
        service._retain_raw_source(owner,op,payload=PAYLOAD)
        assert op.retention_attempted is False


def test_expiry_crossing_during_read_fails_before_artifact_delivery(repository,monkeypatch):
    c,_=repository;save();c.metadata[1]['expires_at']=NOW+timedelta(seconds=1)
    c.metadata[1]['created_at']=c.metadata[1]['expires_at']-m.TTL
    values=iter([0,0,2])
    monkeypatch.setattr(m.time,'monotonic',lambda:next(values))
    with pytest.raises(m.SourceUnavailable):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pytest.fail('expired file delivered')


def test_expiry_during_transaction_exit_denies_artifact(repository,monkeypatch):
    c,_=repository;save();c.metadata[1]['expires_at']=NOW+timedelta(seconds=1)
    c.metadata[1]['created_at']=c.metadata[1]['expires_at']-m.TTL
    values=iter([0,0,0,2])
    monkeypatch.setattr(m.time,'monotonic',lambda:next(values))
    with pytest.raises(m.SourceUnavailable):
        with m.materialize_temporary_source('synthetic',object(),identity=identity()):pytest.fail('expired file delivered')


def test_save_sweeps_only_one_expired_copy(repository):
    c,actor=repository;save();actor.account_id=2;save()
    for row in c.metadata.values():row['expires_at']=NOW;row['created_at']=NOW-m.TTL
    actor.account_id=3;save()
    assert set(c.metadata)=={2,3}
    sql=next(sql for sql,_ in reversed(c.calls) if sql.startswith('delete'))
    assert 'limit 1' in sql
