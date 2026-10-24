"""Home8a01 branch source-authored regressions; UNRUN, no product imports performed.

Repository/authority tests adapt accepted Home S1 cases. Playlist doubles patch
the existing inventory reader rather than passing the Tops-only current argument. SQL and source
adapter doubles are explicit. No Tops-only missing-export contract is invented.
"""
from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from music_app.services import lastfm_home_snapshot as owner

class Result:
    def __init__(self,rows):self.rows=rows
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchall(self):return self.rows

def test_genuine_repository_checks_receipt_connection_binding_before_yield(monkeypatch):
    from contextlib import nullcontext
    from datetime import timedelta
    from music_app.services.home_activity import HomeActivityError
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({})
    scope=SimpleNamespace(account_id=1,session_id='session',library_id=2,source_account_id=1,
        audience='own',subject_account_id=None)
    query=SimpleNamespace(snapshot_ref='opaque',kind='listens',period='all')
    now=datetime.now(timezone.utc)
    snapshot=dict(coverage={'_lastfm_history_stamp':{'connected':True,'provider_username':'Old'}},
        ledger_revision=1,inventory_revision=1,authority_fingerprint='authority',expires_at=now+timedelta(minutes=5))
    class DB:
        def execute(self,*args):return Result([snapshot])
    monkeypatch.setattr(repo,'_friend_authority',lambda *args:nullcontext(None))
    monkeypatch.setattr(repo,'_authority',lambda *args:'authority')
    monkeypatch.setattr(repo,'_lastfm_stamp',lambda *args:dict(connected=True,provider_username='New'))
    with pytest.raises(HomeActivityError):
        with repo._validated_snapshot(DB(),scope,query,now,object()):
            pytest.fail('Stale connection receipt must not be yielded')

def test_genuine_repository_rechecks_binding_after_consumer(monkeypatch):
    from contextlib import nullcontext
    from datetime import timedelta
    from music_app.services.home_activity import HomeActivityError
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({})
    scope=SimpleNamespace(account_id=1,session_id='session',library_id=2,source_account_id=1,
        audience='own',subject_account_id=None)
    query=SimpleNamespace(snapshot_ref='opaque',kind='listens',period='all')
    now=datetime.now(timezone.utc);stamp={'connected':True,'provider_username':'Owner'}
    snapshot=dict(coverage={'_lastfm_history_stamp':stamp},ledger_revision=1,inventory_revision=1,
        authority_fingerprint='authority',expires_at=now+timedelta(minutes=5))
    class DB:
        def execute(self,*args):return Result([snapshot])
    monkeypatch.setattr(repo,'_friend_authority',lambda *args:nullcontext(None))
    monkeypatch.setattr(repo,'_authority',lambda *args:'authority')
    states=iter([stamp,{'connected':False}])
    monkeypatch.setattr(repo,'_lastfm_stamp',lambda *args:next(states))
    monkeypatch.setattr(repo,'_revisions',lambda *args,**kwargs:(1,1))
    monkeypatch.setattr(repo,'_validate_policy',lambda *args:None)
    monkeypatch.setattr(repo,'_lock_authority',lambda *args:now)
    with pytest.raises(HomeActivityError):
        with repo._validated_snapshot(DB(),scope,query,now,object()) as result:
            assert result[0] is snapshot

def test_account_remote_denial_preserves_native_only_and_never_reads_provider_binding(monkeypatch):
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    repo=HomeActivityPostgresRepository({'LASTFM_HISTORY_IMPORT_ENABLED':True})
    scope=SimpleNamespace(account_id=1,source_account_id=1,subject_account_id=None,audience='own')
    query=SimpleNamespace(kind='listens')
    def policy(*args):return None
    project=SimpleNamespace(policy=policy)
    assert repo._lastfm_stamp(None,scope,query,project) is None
    policy.lastfm_history_read=lambda:False
    monkeypatch.setattr(repo,'_lock_authority',lambda *args:pytest.fail('Denied optional read must not query remote binding'))
    assert repo._lastfm_stamp(None,scope,query,project) is None

def test_actual_account_policy_checks_fixed_action_constraints_and_current_owner():
    from music_app.services.current_actor import CurrentActor,ActorState
    from music_app.services.policy import PolicyContext,RequestOrigin
    from music_app.services.policy_evaluator import PolicyEvaluationConstraints
    actor=CurrentActor(ActorState.ACTIVE,account_id=1,session_id=2)
    context=PolicyContext.build(actor=actor,action='library.browse.read',library_id=3,
        deployment_mode='self_hosted',request_origin=RequestOrigin('internal','test'),client_surface_class='private_web')
    seen=[]
    def denied(target):
        seen.append(target.action)
        return PolicyEvaluationConstraints(deployment_allowed=False)
    assert not owner.account_read_allowed(context,denied,account_id=1,session_id=2)
    assert seen==['account.self.lastfm.history.read']
    assert owner.account_read_allowed(context,None,account_id=1,session_id=2)
    assert not owner.account_read_allowed(context,None,account_id=9,session_id=2)
    assert not owner.account_read_allowed(context,None,account_id=1,session_id=9)

def test_actual_playlist_owner_rejects_unassociated_remote_receipt_not_fake_track(monkeypatch):
    from music_app.services.playlist_activity_sources import _rows
    monkeypatch.setattr("music_app.services.playlist_creation_sources_postgres.inventory_rows",lambda *args,**kwargs:{})
    from music_app.services.owned_playlists import PlaylistError
    entry=dict(canonical_resource=None,facts=dict(title='Remote',artist='Artist',album_title='Album'),
        row_ref='opaque',lineage={'row_key':'listen:lastfm:'+'a'*64})
    with pytest.raises(PlaylistError):
        _rows(None,SimpleNamespace(library_id=2),[entry],config={},constraints=None)

def test_actual_playlist_owner_preserves_existing_unresolved_native_metadata(monkeypatch):
    from music_app.services.playlist_activity_sources import _rows
    monkeypatch.setattr("music_app.services.playlist_creation_sources_postgres.inventory_rows",lambda *args,**kwargs:{})
    entry=dict(canonical_resource=None,facts=dict(title='Native',artist='Artist',album_title='Album'),
        row_ref='opaque',lineage={'row_key':'listen:event:1'})
    result=_rows(None,SimpleNamespace(library_id=2),[entry],config={},constraints=None)
    assert result[0]['original_local_track_id'] is None
    assert result[0]['availability']=='unresolved'
    assert result[0]['title']=='Native'

def test_home_branch_private_provider_stamp_is_not_public():
    from music_app.services.home_activity_postgres import _external_coverage
    assert _external_coverage({'_lastfm_history_stamp':{'provider_username':'PRIVATE'},
        'lastfm_observations':{'observation_state':'not_imported'}})=={
        'lastfm_observations':{'observation_state':'not_imported'}}


def test_home_branch_exact_registered_route_actions():
    from music_app.services.private_route_boundary import private_action_for_route
    assert private_action_for_route('POST','/home/activity/lastfm/import')=='account.self.lastfm.history.write'
    assert private_action_for_route('POST','/home/activity/lastfm/combined')=='account.self.lastfm.history.read'
    assert private_action_for_route('POST','/home/activity/scrobbles/retry')=='integration.lastfm.scrobbles.submit'
    assert private_action_for_route('GET','/home/activity/lastfm/import') is None
