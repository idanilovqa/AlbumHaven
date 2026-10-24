"""Authored only: genuine authority over controlled SQL and reader boundaries."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from struct import pack
import json
from music_app.services import foobar_account_enhanced_review as owner
from music_app.services import foobar_account_authority as authority
from music_app.services import foobar_enhanced_record_decoder as decoder
from music_app.services import foobar_enhanced_sqlite_reader as reader
from tests.py.foobar_account_history_native_testing import NativeBoundary,NOW,URL,SOURCE
from tests.py.foobar_account_matching_synthetic import context as original_context
REQUEST='55555555-5555-4555-8555-555555555555'
SHA='a'*64

def context():
    value=original_context()
    return replace(value,actor=replace(value.actor,account_id=1,session_id=3,
        current_library_id=None,library_relationships=(),capability_grants=(),is_bootstrap_owner=False),
        target_account_id=1,library_id=None)

def command(**values):
    return replace(owner.EnhancedReviewCommand(SOURCE,1,0,REQUEST),**values)

class Boundary(NativeBoundary):
    def __init__(self):
        super().__init__()
        self.library=None
        self.revision=0
        self.generation=1
        self.retired=0
        self.source_exists=True
    def rows(self,sql,params,kwargs):
        if sql=='select id,is_active,disabled_at from app.accounts where id=%s for update':
            assert params==(self.account,) and not kwargs
            return [dict(id=self.account,is_active=self.active,disabled_at=None)]
        if sql==owner._LOCK_SQL:
            assert kwargs=={'binary':True} and len(params)==1
            frame=json.loads(params[0]); self.frames.append(frame)
            assert frame==[self.account,SOURCE]
            return [dict(revision=self.revision,current_generation=self.generation,
                retired_through=self.retired)] if self.source_exists else []
        return super().rows(sql,params,kwargs)

def install(monkeypatch):
    db=Boundary()
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None): return NOW
    monkeypatch.setattr(authority,'pooled_connection',db.pool)
    monkeypatch.setattr(authority,'datetime',Clock)
    return db

def record(key=1,local=(116444736000000001,),cached=(0,),mapped=False):
    payload=pack('<IIIi',1,len(local),len(cached),0)+b''.join(pack('<Q',n) for n in local+cached)
    decoded=decoder.decode_enhanced_playcount_record(payload,store_guid=decoder.ENHANCED_PLAYCOUNT_STORE_GUID)
    assert decoded.status=='parsed'
    return reader.StoreRecord(reader.StoreIdentity(decoder.ENHANCED_PLAYCOUNT_STORE_GUID,key),
        'parsed','mapped' if mapped else 'unresolved',decoded.record,())

def stream(monkeypatch,events,*,terminal=None,after=None):
    events=tuple(events)
    records=sum(type(value) is reader.StoreRecord for value in events)
    aliases=sum(len(value.filenames) for value in events if type(value) is reader.FilenameAliasPage)
    complete=reader.StoreReadSummary('foobar_enhanced_sqlite_snapshot_v1','complete',None,records,aliases,0,0)
    closed=[]
    @contextmanager
    def opened(path,*,cancelled):
        assert isinstance(path,Path)
        def generate():
            yield from events
            if after: after()
            return complete if terminal is None else terminal
        iterator=generate()
        try: yield iterator
        finally: iterator.close(); closed.append(True)
    monkeypatch.setattr(owner,'open_enhanced_sqlite_snapshot',opened)
    return closed

def invoke(*,cmd=None,ctx=None,cancelled=lambda:False,**kwargs):
    return owner.review_enhanced_artifact(URL,ctx or context(),cmd or command(),
        path=Path('/synthetic/owned.sqlite'),upload_sha256=SHA,
        logical_capacity_bytes=owner.REVIEW_PHASE_BYTES,cancelled=cancelled,**kwargs)
