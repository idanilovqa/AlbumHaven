"""Real Postgres lease, isolation, freshness and revocation checks."""
from dataclasses import replace
from datetime import datetime,timedelta,timezone
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant
from music_app.services.live_activity_postgres import LiveActivityPostgres,PresenceError
from music_app.services.friends_postgres import FriendScopeError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_activity_native_targets_postgres import native_activity
from tests.py.test_friend_home_activity import social_ledger
from tests.py.test_home_activity_postgres_integration import database_urls,mutable_ledger


@pytest.fixture
def presence(native_activity):
    state,ctx,_,_=native_activity
    now=[datetime.now(timezone.utc)]
    service=LiveActivityPostgres(state['db'].config,clock=lambda:now[0])
    command={'track_ref':f"inventory-track:{ctx.library_id}:{state['data']['tracks'][0]['id']}",'player_ref':str(uuid4()),'sequence':1}
    source=service.source(ctx,command)
    return state,ctx,service,now,command,source


def update(value,state='playing',sequence=2):
    _,ctx,service,_,_,source=value
    return service.update(ctx,{'presence_ref':source['presence_ref'],'sequence':sequence,'state':state})


def test_source_never_marks_live_and_play_pause_stop_expiry_never_add_listens(presence):
    state,ctx,service,now,_,_=presence
    with state['db'].connect() as con:
        before=con.execute('select count(*) as n from integration.listen_history where account_id=%s',(ctx.actor.account_id,)).fetchone()['n']
    assert service.read(ctx) is None
    update(presence)
    live=service.read(ctx)
    assert live['state']=='playing' and live['row']['listen_count'] is None
    assert live['row']['title']=='Track 0000'
    assert 'path' not in repr(live) and 'presence_ref' not in live
    update(presence,'paused',3)
    assert service.read(ctx) is None
    update(presence,'playing',4)
    update(presence,'stopped',5)
    assert service.read(ctx) is None
    update(presence,'playing',6)
    now[0]+=timedelta(seconds=16)
    assert service.read(ctx) is None
    with pytest.raises(PresenceError,match='source_expired'):update(presence,'playing',7)
    with state['db'].connect() as con:
        assert con.execute('select count(*) as n from integration.listen_history where account_id=%s',(ctx.actor.account_id,)).fetchone()['n']==before


def test_stale_sequences_tokens_and_other_player_cannot_replace_current_owner(presence):
    _,ctx,service,now,command,source=presence
    update(presence)
    with pytest.raises(PresenceError,match='stale_sequence'):update(presence,'paused',2)
    with pytest.raises(PresenceError,match='publisher_busy'):
        service.source(ctx,{**command,'player_ref':str(uuid4()),'sequence':10})
    with pytest.raises(PresenceError,match='source_unavailable'):
        service.update(ctx,{'presence_ref':'A'*43,'sequence':3,'state':'paused'})
    assert service.read(ctx)['state']=='playing'
    now[0]+=timedelta(seconds=3)
    new=service.source(ctx,{**command,'sequence':4})
    assert new['presence_ref']!=source['presence_ref']
    with pytest.raises(PresenceError,match='source_unavailable'):update(presence,'playing',5)


def test_heartbeat_budget_does_not_prevent_immediate_clear(presence):
    update(presence)
    with pytest.raises(PresenceError,match='refresh_too_soon'):update(presence,'playing',3)
    update(presence,'paused',4)


@pytest.mark.parametrize('change',['logout','media','membership','friendship','social'])
def test_subject_current_authority_and_friendship_are_rechecked(presence,change):
    state,ctx,service,_,_,_=presence
    update(presence)
    with state['db'].session(state['peer'],ctx.library_id) as peer:
        peer=replace(peer,capability_grants=(*peer.capability_grants,CapabilityGrant('capability.social','library',ctx.library_id)))
        peer_context=replace(ctx,actor=peer)
        with state['db'].connect() as con:
            subject_ref=str(con.execute('select account_ref from app.social_profiles where account_id=%s',(ctx.actor.account_id,)).fetchone()['account_ref'])
        assert service.read(peer_context,subject_ref=subject_ref)['state']=='playing'
        with state['db'].connect() as con:
            if change=='logout':con.execute('update app.account_sessions set revoked_at=now() where id=%s',(ctx.actor.session_id,))
            elif change=='media':con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.media.read'",(ctx.actor.account_id,))
            elif change=='membership':con.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(ctx.actor.account_id,ctx.library_id))
            elif change=='friendship':con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
            else:con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='capability.social'",(ctx.actor.account_id,))
        if change in {'membership','friendship','social'}:
            with pytest.raises(FriendScopeError):service.read(peer_context,subject_ref=subject_ref)
        else:assert service.read(peer_context,subject_ref=subject_ref) is None


def test_resource_history_denial_returns_no_live_row(presence):
    state,ctx,service,_,_,_=presence
    update(presence)
    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not(context.resource and context.resource.resource_kind=='track'))
    assert service.read(ctx,constraints=constraints) is None


def test_presence_table_is_not_readable_through_generic_readonly_role(presence):
    state,*_=presence
    with state['db'].connect() as con:
        result=con.execute("select has_table_privilege('album_haven_readonly','app.current_playback_presence','SELECT') as can_read").fetchone()
    assert result['can_read'] is False


def test_deleted_live_track_clears_and_cannot_be_renewed(presence):
    state,ctx,service,now,_,_=presence
    update(presence)
    now[0]+=timedelta(seconds=3)
    with state['db'].connect() as con:
        con.execute('delete from library.local_tracks where id=%s',(state['data']['tracks'][0]['id'],))
    assert service.read(ctx) is None
    with pytest.raises(PresenceError,match='item_unavailable'):update(presence,'playing',3)


def test_source_rejects_foreign_library_inventory_reference(presence):
    _,ctx,service,_,command,_=presence
    with pytest.raises(PresenceError,match='item_unavailable'):
        service.source(ctx,{**command,'track_ref':f'inventory-track:{ctx.library_id+100000}:1','sequence':3})


def test_revocation_requires_new_acquisition_even_after_identical_grant_restore(presence):
    state,ctx,service,now,command,_=presence
    update(presence)
    with state['db'].connect() as con:
        con.execute("update app.capabilities set revoked_at=now() where account_id=%s and capability_key='library.media.read'",(ctx.actor.account_id,))
        con.execute("update app.capabilities set revoked_at=null where account_id=%s and capability_key='library.media.read'",(ctx.actor.account_id,))
    assert service.read(ctx) is None
    with pytest.raises(PresenceError,match='source_expired'):update(presence,'playing',3)
    source=service.source(ctx,{**command,'sequence':4})
    service.update(ctx,{'presence_ref':source['presence_ref'],'sequence':5,'state':'playing'})
    assert service.read(ctx) is not None
