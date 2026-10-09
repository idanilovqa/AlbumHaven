"""Native target routing tests; durable authority remains independently SQL-tested."""
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant
from music_app.services.owned_playlists import PlaylistError
from music_app.services import playlist_native_targets as targets
from music_app.services import private_native_targets as native
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.owned_playlist_testing import context, NOW, ACCOUNT, SESSION, LIBRARY, PLAYLIST, ITEM_A, inventory_row


class Connection:
    def __init__(self, *, item=True, album=True, files=True):
        self.item,self.album,self.files=item,album,files
        self.queries=[]
    def execute(self,sql,params):
        self.queries.append((sql,params))
        if "from app.playlist_items" in sql:
            assert params==(PLAYLIST,LIBRARY,ITEM_A)
            row={"ref":ITEM_A,"local_track_id":901} if self.item else None
            return SimpleNamespace(fetchone=lambda:row)
        if "from library.local_albums" in sql:
            row={"id":501,"album_key":"real-album"} if self.album else None
            return SimpleNamespace(fetchone=lambda:row)
        if "from library.local_tracks" in sql:
            return SimpleNamespace(fetchall=lambda:[{"id":901}])
        assert "from library.local_track_files" in sql
        rows=[{"track_id":901,"private_path":"/private/track.flac","root_path":"/private"}] if self.files else []
        return SimpleNamespace(fetchall=lambda:rows)


class Playlists:
    def __init__(self,connection):
        self.connection=connection
        self.events=[]
        self._clock=lambda:NOW
    @contextmanager
    def _authorized(self,ctx,constraints):
        self.events.append("actor")
        yield self.connection,ctx,NOW
    def _playlist(self,connection,ctx,ref):
        assert connection is self.connection and ref==PLAYLIST
        self.events.append("playlist")
        return {"ref":ref,"revision":7}
    def _require(self,ctx,actions,constraints,playlist):
        self.events.append("playlist-policy")


@pytest.fixture
def fixture(monkeypatch):
    from dataclasses import replace
    ctx=context()
    ctx=replace(ctx,actor=replace(ctx.actor,capability_grants=(*ctx.actor.capability_grants,
        CapabilityGrant("library.media.read","library",LIBRARY))))
    connection=Connection()
    playlists=Playlists(connection)
    observed=[]
    def inventory(connection,library,ids,lock,config=None):
        assert library==LIBRARY and ids==[901] and lock is True
        return {901:inventory_row()}
    monkeypatch.setattr(native.inventory,"inventory_rows",inventory)
    def session(connection,*,actor_account_id,actor_session_id,clock):
        assert (actor_account_id,actor_session_id)==(ACCOUNT,SESSION)
        observed.append("fresh-session")
        return clock()
    monkeypatch.setattr(targets,"lock_current_actor_session",session)
    def media(config,path,**kwargs):
        observed.append((path,kwargs))
        return Path(path)
    service=targets.PlaylistNativeTargets({},playlists=playlists,media_resolver=media)
    return ctx,connection,playlists,service,observed


def run(fixture,intent="play",**overrides):
    ctx,_,_,service,_=fixture
    return service.resolve(ctx,playlist_ref=PLAYLIST,item_ref=ITEM_A,intent=intent,**overrides)


def test_play_resolves_only_after_playlist_and_media_authority(fixture):
    result=run(fixture)
    assert fixture[2].events==["actor","playlist","playlist-policy"]
    assert result["playlist_id"]==PLAYLIST and result["playlist_item_id"]==ITEM_A
    assert result["revision"]=="7" and result["intent"]=="play"
    assert result["native_target"]["track_ref"]=="/private/track.flac"
    assert fixture[4][-1]=="fresh-session"
    assert fixture[4][1][1]=={"configured_root_paths":(Path("/private"),)}


def test_playlist_read_never_grants_media(fixture):
    from dataclasses import replace
    ctx,*_=fixture
    fixture=(replace(ctx,actor=replace(ctx.actor,capability_grants=tuple(g for g in ctx.actor.capability_grants if g.capability_key!="library.media.read"))),*fixture[1:])
    with pytest.raises(PlaylistError,match="forbidden"):
        run(fixture)
    assert not fixture[4]


def test_details_use_separate_album_resource_grant_and_no_media_target(fixture):
    from dataclasses import replace
    ctx,*_=fixture
    ctx=replace(ctx,actor=replace(ctx.actor,capability_grants=tuple(g for g in ctx.actor.capability_grants if g.capability_key!="library.media.read")))
    fixture=(ctx,*fixture[1:])
    seen=[]
    def constraints(value):
        seen.append((value.action,value.resource.resource_kind,value.resource.resource_ref))
        return PolicyEvaluationConstraints()
    result=run(fixture,intent="details",constraints=constraints)
    assert result["native_target"]=={"album_ref":"real-album","allowed_actions":{"can_view_details":True,"can_play_album":False}}
    assert ("library.browse.read","album","501") in seen
    assert fixture[4]==["fresh-session"]


@pytest.mark.parametrize("kind",["track","album"])
def test_narrowed_resource_constraints_are_preserved(fixture,kind):
    def constraints(value):
        return PolicyEvaluationConstraints(request_origin_allowed=value.resource.resource_kind!=kind)
    with pytest.raises(PlaylistError,match="forbidden"):
        run(fixture,intent="details",constraints=constraints)
    assert not fixture[4]


@pytest.mark.parametrize("missing",["item","album","files"])
def test_unavailable_current_target_never_falls_back_to_labels(fixture,missing):
    setattr(fixture[1],missing,False)
    with pytest.raises(PlaylistError,match="item_unavailable"):
        run(fixture,intent="details" if missing=="album" else "play")


def test_media_must_match_both_current_library_root_and_native_config(fixture):
    calls=[]
    def resolver(config,path,**kwargs):
        calls.append(kwargs)
        return Path("/other/track.flac") if kwargs else Path("/private/track.flac")
    fixture[3]._targets.media_resolver=resolver
    with pytest.raises(PlaylistError,match="item_unavailable"):
        run(fixture)
    assert len(calls)==2


def test_unknown_intent_is_rejected_before_any_repository_access(fixture):
    with pytest.raises(PlaylistError,match="invalid_command"):
        run(fixture,intent="download")
    assert fixture[2].events==[]


def test_native_album_media_permission_is_explicit_and_narrowed_per_track(fixture):
    result=run(fixture,intent="details")
    assert result["native_target"]["allowed_actions"]["can_play_album"] is True
    def constraints(ctx):
        deny=ctx.action=="library.media.read" and ctx.resource.resource_kind=="track"
        return PolicyEvaluationConstraints(request_origin_allowed=not deny)
    narrowed=run(fixture,intent="details",constraints=constraints)
    assert narrowed["native_target"]["allowed_actions"]["can_play_album"] is False


def test_queue_preserves_requested_occurrences_and_rechecks_session(fixture):
    ctx,connection,_,service,observed=fixture
    other=str(uuid4())
    original=connection.execute
    def execute(sql,params):
        if 'from app.playlist_items' in sql and 'any(' in sql:
            assert params==(PLAYLIST,LIBRARY,[other,ITEM_A])
            return SimpleNamespace(fetchall=lambda:[{'ref':ITEM_A,'local_track_id':901},{'ref':other,'local_track_id':901}])
        return original(sql,params)
    connection.execute=execute
    result=service.queue(ctx,playlist_ref=PLAYLIST,revision='7',item_refs=[other,ITEM_A],starting_item_ref=ITEM_A)
    assert [row['playlist_item_id'] for row in result['tracks']]==[other,ITEM_A]
    assert result['unavailable_item_refs']==[] and observed[-1]=='fresh-session'
    assert len([value for value in observed if isinstance(value,tuple)])==2


@pytest.mark.parametrize('change',['stale','duplicate','outside','selected_missing','unselected_missing'])
def test_queue_rejects_stale_or_foreign_occurrences_and_never_skips_selected(fixture,change):
    ctx,connection,_,service,_=fixture
    other=str(uuid4())
    def execute(sql,params):
        assert 'from app.playlist_items' in sql
        rows=[{'ref':ITEM_A,'local_track_id':None},{'ref':other,'local_track_id':None}]
        if change=='outside':rows.pop()
        return SimpleNamespace(fetchall=lambda:rows)
    connection.execute=execute
    refs=[ITEM_A,ITEM_A] if change=='duplicate' else [ITEM_A,other]
    if change=='unselected_missing':
        service._targets.resolve_play_queue=lambda *args,**kwargs:{901:{'path':'/private/track.flac'}}
        connection.execute=lambda *args:SimpleNamespace(fetchall=lambda:[{'ref':ITEM_A,'local_track_id':901},{'ref':other,'local_track_id':None}])
        result=service.queue(ctx,playlist_ref=PLAYLIST,revision='7',item_refs=refs,starting_item_ref=ITEM_A)
        assert result['unavailable_item_refs']==[other]
        assert [row['playlist_item_id'] for row in result['tracks']]==[ITEM_A]
    else:
        with pytest.raises(PlaylistError):
            service.queue(ctx,playlist_ref=PLAYLIST,revision='6' if change=='stale' else '7',item_refs=refs,starting_item_ref=ITEM_A)
