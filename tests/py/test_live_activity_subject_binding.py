"""Portable owner-call regression, not SQL/session/middleware authority evidence."""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest

from music_app.services import live_activity_postgres as live
from music_app.services import subject_home_taste as taste

SUBJECT_REF='83fb43bd-a7d8-4854-9095-e72127942691'
OCCURRENCE=UUID('63778d01-90c5-431e-a2f6-8060529501cf')
NOW=datetime(2026,10,25,tzinfo=timezone.utc)


@dataclass(frozen=True)
class UnitContext:
    actor: object
    library_id: int=3
    target_account_id: int|None=None


class Result:
    def __init__(self,row):self.row=row
    def fetchone(self):return self.row


class ReadSeam:
    """Finite read-only SQL-shaped results; unexpected queries fail closed."""
    def __init__(self,friend,changed):
        self.friend=friend;self.changed=changed;self.events=[];self.loaded=[]
        self.subject=1 if friend else 2
        self.row={'account_id':self.subject,'library_id':3,'session_id':11 if friend else 22,
            'track_id':7,'state':'playing','expires_at':NOW+timedelta(seconds=15),
            'observed_at':NOW,'occurrence_ref':OCCURRENCE,'token_digest':b'opaque-digest',
            'authority_fingerprint':'unit-authority'}

    def execute(self,sql,params):
        query=' '.join(sql.split())
        if query=='select account_id from app.social_profiles where account_ref=%s':
            assert params==(SUBJECT_REF,);self.events.append('resolve')
            return Result({'account_id':1})
        if query=='select account_id from app.social_profiles where account_ref=%s and account_id=%s':
            assert params==(SUBJECT_REF,1);self.events.append('binding')
            return Result(None if self.changed else {'account_id':1})
        if query=="select * from app.current_playback_presence where account_id=%s and library_id=%s and state='playing' and expires_at>greatest(%s,clock_timestamp())":
            assert params==(self.subject,3,NOW);self.events.append('presence')
            return Result(dict(self.row))
        if query=='select album_id,artist_id from library.local_tracks where library_id=%s and id=%s for share':
            assert params==(3,7);self.events.append('track')
            return Result({'album_id':8,'artist_id':9})
        if query=="select 1 from app.current_playback_presence where account_id=%s and library_id=%s and session_id=%s and occurrence_ref=%s and token_digest=%s and track_id=%s and state='playing' and expires_at>greatest(%s,clock_timestamp())":
            assert params==(self.subject,3,self.row['session_id'],OCCURRENCE,b'opaque-digest',7,NOW)
            self.events.append('final-presence');return Result({'?column?':1})
        raise AssertionError(('Unexpected unit SQL',query,params))


def setup_read(monkeypatch,*,friend,changed=False):
    seam=ReadSeam(friend,changed)
    context=UnitContext(SimpleNamespace(account_id=2,session_id=22))
    @contextmanager
    def connect(url):
        assert url=='unit-only';yield seam
    @contextmanager
    def transaction(url,ctx,**kwargs):
        assert url=='unit-only' and ctx is context
        assert kwargs['target_account_id']==seam.subject and kwargs['read_only'] is True
        seam.events.append('initial-subject-lock');yield seam,context,NOW
    @contextmanager
    def friend_guard(connection,**kwargs):
        assert connection is seam
        assert kwargs=={'account_id':2,'library_id':3,'target_account_id':1}
        seam.events.append('friend-guard');yield
    def authorize(ctx,action,*,resource,constraints):
        assert ctx.target_account_id==(1 if friend else None)
        assert action==('library.social.history.read' if friend else 'library.browse.read')
        assert resource.resource_ref==str(seam.subject)
    def inventory(connection,library,ids,**kwargs):
        assert connection is seam and library==3 and ids==[7]
        return {7:{'availability':'local','title':'Unit track','artist':'Unit artist',
            'album_title':'Unit album','duration_seconds':240}}
    def load_taste(connection,*,account_id,library_id,track_ids):
        assert connection is seam and library_id==3 and track_ids==[7]
        seam.loaded.append(account_id)
        return {7:{'rating':1 if account_id==1 else 5,
            'love_tier':'loved' if account_id==1 else 'obsessed','taste_state':'available'}}
    monkeypatch.setattr(live,'current_library_transaction',transaction)
    monkeypatch.setattr(live,'authorized_friend_read',friend_guard)
    monkeypatch.setattr(live,'require_private_action',authorize)
    monkeypatch.setattr(live,'allows',lambda *args:True)
    monkeypatch.setattr(taste,'allows',lambda *args:True)
    monkeypatch.setattr(live.inventory,'inventory_rows',inventory)
    monkeypatch.setattr(live,'album_artwork_url',lambda *args,**kwargs:'/unit-artwork')
    monkeypatch.setattr(taste,'load_subject_track_taste',load_taste)
    def fingerprint(connection,account,session,library,now):
        assert connection is seam and (account,session,library,now)==(seam.subject,seam.row['session_id'],3,NOW)
        return 'unit-authority'
    monkeypatch.setattr(live.LiveActivityPostgres,'_fingerprint',staticmethod(fingerprint))
    assert live.project_subject_taste is taste.project_subject_taste
    return seam,context,live.LiveActivityPostgres({'ALBUM_HAVEN_APP_DATABASE_URL':'unit-only'},connect=connect)


def test_friend_live_passes_initially_locked_subject_to_real_projector(monkeypatch):
    seam,context,owner=setup_read(monkeypatch,friend=True)
    result=owner.read(context,subject_ref=SUBJECT_REF)
    assert result['subject_ref']==SUBJECT_REF and result['state']=='playing'
    assert result['occurrence_ref']==str(OCCURRENCE)
    assert (result['row']['rating'],result['row']['love_tier'],result['row']['taste_state'])==(1,'loved','available')
    assert seam.loaded==[1]  # not the viewer2 with5/obsessed
    assert seam.events==['resolve','initial-subject-lock','friend-guard','presence','track','binding','binding','final-presence']


def test_own_live_keeps_viewer_taste_without_friend_binding(monkeypatch):
    seam,context,owner=setup_read(monkeypatch,friend=False)
    result=owner.read(context)
    assert result['subject_ref'] is None and result['state']=='playing'
    assert (result['row']['rating'],result['row']['love_tier'],result['row']['taste_state'])==(5,'obsessed','available')
    assert seam.loaded==[2]
    assert seam.events==['initial-subject-lock','presence','track','final-presence']


def test_friend_live_rebinding_rejected_before_taste_load(monkeypatch):
    seam,context,owner=setup_read(monkeypatch,friend=True,changed=True)
    with pytest.raises(ValueError,match=r'^Subject binding changed\.$'):
        owner.read(context,subject_ref=SUBJECT_REF)
    assert seam.loaded==[]
    assert seam.events==['resolve','initial-subject-lock','friend-guard','presence','track','binding']
