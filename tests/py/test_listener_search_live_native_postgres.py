"""Real two-phase native locks and separate listener/actor authorization.

Method observers below always call the actual owner. They are barriers and
failure injection at publication boundaries, never substituted authority.
"""
from contextlib import contextmanager
from copy import deepcopy
from threading import Event
import time
import pytest
from music_app.services import activity_native_targets as native_module
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_listener_search_postgres import PostgresListenerSearch, normalize_listener_native_command
from music_app.services.private_search_contract import PrivateSearchError
from tests.py.listener_search_live_support import (
    database_urls,mutable_ledger,social_ledger,native_activity,read,native,service,
    seed_preference,error,Workers,Connections,observe_blocker,runtime_connect,
)


def capture(value, suffix=''):
    state,context,_,_=value
    return read(state,subject=state['peer'],suffix=suffix,context=context)


@pytest.mark.parametrize('operation',['bindings','single','batch'])
def test_actual_native_membership_order_and_exact_contract(native_activity,operation):
    state,context,_,_=native_activity
    result=capture(native_activity)
    selected=[r['id'] for r in reversed(result['tracks'])]
    actual=native(state,result,operation=operation,selected=selected,context=context)
    assert set(actual)=={'status','contract_version','context_ref','result_token','data'}
    assert actual['result_token']==result['native']['result_token']
    assert actual['status']=='ready'
    if operation=='single':assert actual['data']['row_ref']==selected[0]
    else:
        entries=actual['data']['bindings' if operation=='bindings' else 'items']
        assert [r['row_ref'] for r in entries]==selected
    assert 'subject_taste' not in repr(actual)
    assert 'prelock' not in repr(actual) and 'row_hints' not in repr(actual)


@pytest.mark.parametrize('target_kind',['album','artist'])
def test_details_keep_real_actor_native_context(native_activity,target_kind):
    state,context,_,_=native_activity
    result=capture(native_activity)
    seen=[]
    def constraints(ctx):
        seen.append(ctx)
        return PolicyEvaluationConstraints()
    actual=native(state,result,operation='single',intent='details',target_kind=target_kind,
                  context=context,constraints=constraints)
    assert target_kind+'_ref' in actual['data']['native_target']
    for ctx in seen:
        if ctx.action=='library.social.history.read':assert ctx.target_account_id==state['peer']
        elif ctx.action in {'library.media.read','library.playlists.create','library.playlists.items.manage','library.track_preferences.manage'}:
            assert ctx.target_account_id is None
    assert any(c.action=='library.social.history.read' for c in seen)


def test_filtered_listener_taste_and_actor_editable_preference_are_opposed(native_activity,monkeypatch):
    from dataclasses import replace
    from music_app.services.private_search_subject import PostgresListenerSearchSubjects
    freshly_guarded=[]
    original=PostgresListenerSearchSubjects.authorized
    @contextmanager
    def observe_authorized(self,*args,**kwargs):
        with original(self,*args,**kwargs) as value:
            freshly_guarded.append(value[1])
            yield value
    monkeypatch.setattr(PostgresListenerSearchSubjects,'authorized',observe_authorized)
    state,context,_,_=native_activity
    track=state['data']['tracks'][0]
    seed_preference(state,track,love='off',rating=1)
    seed_preference(state,track,account=state['peer'],love='obsessed',rating=5)
    seen=[]
    def constraints(ctx):
        seen.append(ctx)
        # A targeted management permission must not become actor-native authority.
        denied=ctx.action=='library.track_preferences.manage' and ctx.target_account_id is None
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    assert len(result['tracks'])==1
    freshly_guarded.clear()
    seen.clear()
    prelocks=[]
    prelock_original=ActivityNativeTargets.prelock_listener_on_connection
    def observe_prelock(self,con,listener_context,*args,**kwargs):
        assert listener_context is freshly_guarded[-1]
        value=prelock_original(self,con,listener_context,*args,**kwargs)
        assert value.context==replace(listener_context,target_account_id=None)
        prelocks.append(value)
        return value
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',observe_prelock)
    actual=native(state,result,operation='single',context=context,constraints=constraints)
    target=actual['data']['native_target']
    assert target['track_preference']['rating']==1
    assert target['track_preference']['love_tier']=='off'
    assert target['track_preference']['allowed_actions']['can_set_love_tier'] is False
    taste=[c for c in seen if c.action=='library.social.taste.read']
    edit=[c for c in seen if c.action=='library.track_preferences.manage']
    assert taste and all(c.target_account_id==state['peer'] for c in taste)
    assert edit and all(c.target_account_id is None for c in edit)
    assert prelocks and freshly_guarded
    fresh_listener=freshly_guarded[-1]
    fresh_actor_native=replace(fresh_listener,target_account_id=None)
    for ctx in taste:
        assert ctx==replace(fresh_listener,action=ctx.action,resource=ctx.resource)
    for ctx in edit:
        assert ctx==replace(fresh_actor_native,action=ctx.action,resource=ctx.resource)
    browse=[ctx for ctx in seen if ctx.action=='library.browse.read' and ctx.resource is not None and ctx.resource.resource_kind=='track']
    assert browse
    for ctx in browse:
        assert ctx==replace(fresh_actor_native,action=ctx.action,resource=ctx.resource)
    # Equality above retains the complete refreshed actor, including grants,
    # primary-owner membership, session and every non-target context fact.


@pytest.mark.parametrize('action',['library.social.history.read','library.social.taste.read','library.media.read'])
def test_request_policy_narrowing_keeps_actor_native_and_listener_authority_separate(native_activity,action):
    state,context,_,_=native_activity
    seed_preference(state,state['data']['tracks'][0],account=state['peer'])
    seen=[]
    armed=[False]
    def constraints(ctx):
        seen.append(ctx)
        denied=armed[0] and ctx.action==action and (ctx.target_account_id is None if action=='library.media.read' else ctx.target_account_id==state['peer'])
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    armed[0]=True
    error(403,lambda:native(state,result,operation='single',intent='play',context=context,constraints=constraints))
    assert any(c.action==action for c in seen)


@pytest.mark.parametrize('refs',[[],['activity_'+'0'*64]*2,['bad'],['activity_'+'0'*64]*101])
def test_native_selection_shape_is_bounded(refs):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_listener_native_command(refs,operation='batch',intent='metadata')
    assert caught.value.status_code==422


def test_nonmatching_receipt_row_cannot_gain_membership(native_activity):
    state,context,_,_=native_activity
    result=capture(native_activity)
    own=read(state,context=context)
    foreign=next(r['id'] for r in own['tracks'] if r['id'] not in {x['id'] for x in result['tracks']})
    error(403,lambda:native(state,result,selected=[foreign],context=context))


def test_phase_a_closes_before_prelock_and_final_owner_uses_same_connection(native_activity,monkeypatch):
    state,context,_,_=native_activity
    result=capture(native_activity)
    connections=Connections()
    captures=[]
    original=ActivityNativeTargets.prelock_listener_on_connection
    def prelock(self,con,*args,**kwargs):
        # Earlier hint/guard leases must be physically closed already.
        assert all(old.closed for old in connections.items if old is not con)
        item=original(self,con,*args,**kwargs)
        captures.append(item)
        return item
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',prelock)
    project=ActivityNativeTargets.project_listener_on_connection
    def observe(self,con,*args,**kwargs):
        assert con is kwargs['prelock'].connection
        assert con.info.backend_pid==captures[0].connection.info.backend_pid
        count=len(connections.items)
        value=project(self,con,*args,**kwargs)
        assert len(connections.items)==count
        return value
    monkeypatch.setattr(ActivityNativeTargets,'project_listener_on_connection',observe)
    assert native(state,result,context=context,connect=connections)['status']=='ready'
    assert captures and captures[0].active is False
    assert all(con.closed for con in connections.items)


@pytest.mark.parametrize('change',['track','file','insert_file','parent','stale','root'])
def test_reader_first_prelock_blocks_selected_inventory_writer(native_activity,monkeypatch,change):
    state,context,_,_=native_activity
    result=capture(native_activity)
    track=state['data']['tracks'][0]
    original=ActivityNativeTargets.prelock_listener_on_connection
    with Workers() as work:
        reached,release,pause=work.barrier()
        reader_pid=[]
        def prelock(self,con,*args,**kwargs):
            value=original(self,con,*args,**kwargs)
            reader_pid.append(con.info.backend_pid)
            pause()
            return value
        monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',prelock)
        reader=work.start(lambda:native(state,result,context=context,connect=work.connections))
        assert reached.wait(8)
        writer_pid=[]
        def mutate():
            with work.connections(state['db'].app_url) as con:
                writer_pid.append(con.info.backend_pid)
                if change=='track':con.execute("update library.local_tracks set track_key=track_key || '-changed' where id=%s",(track['id'],))
                elif change=='file':con.execute("update library.local_track_files set private_path=private_path || '.changed' where track_id=%s",(track['id'],))
                elif change=='parent':con.execute("update library.local_tracks set album_id=null where id=%s",(track['id'],))
                elif change=='stale':con.execute("update library.local_track_files set metadata=metadata || jsonb_build_object('scan_cache',jsonb_build_object('stale',true)) where track_id=%s",(track['id'],))
                elif change=='root':con.execute("update library.library_roots set is_active=false where id in (select library_root_id from library.local_track_files where track_id=%s)",(track['id'],))
                else:con.execute("insert into library.local_track_files(track_id,private_path) values(%s,%s)",(track['id'],track['path']+'.new'))
        writer=work.start(mutate)
        deadline=time.monotonic()+8
        while not writer_pid and time.monotonic()<deadline:time.sleep(.01)
        assert writer_pid
        observe_blocker(state['db'],writer_pid[0],reader_pid[0])
        release.set()
        assert reader.result(timeout=8)['status']=='ready'
        writer.result(timeout=8)
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',original)
    if change == 'root':
        # Root liveness narrows current play availability, not receipt membership.
        # Preserve the lock assertion above and prove both sides of that contract.
        current=native(state,result,context=context)
        assert current['status']=='ready'
        bindings=current['data']['bindings']
        assert [binding['row_ref'] for binding in bindings]==[row['id'] for row in result['tracks']]
        affected=next(binding for binding in bindings
            if binding['inventory_track_ref']==f"inventory-track:{context.library_id}:{track['id']}")
        assert affected['allowed_actions']['can_resolve_native_play'] is False
        metadata=native(state,result,operation='single',selected=[affected['row_ref']],context=context)
        target=metadata['data']['native_target']
        assert target['inventory_track_ref']==affected['inventory_track_ref']
        assert target['source_readable'] is True and target['allowed_actions']['can_read'] is True
        assert target['availability']!='local'
        assert target['allowed_actions']['can_play'] is False
        assert target['playback_state']['can_start_here'] is False
        error(404,lambda:native(state,result,operation='single',intent='play',
            selected=[affected['row_ref']],context=context),code='item_unavailable')
    else:
        error(409,lambda:native(state,result,context=context))


def test_writer_first_does_not_hold_revision_lock_while_waiting_inventory(native_activity,monkeypatch):
    state,context,_,_=native_activity
    result=capture(native_activity)
    track=state['data']['tracks'][0]
    original=PostgresListenerSearch._listener_native_hints
    with Workers() as work:
        hinted,release,pause=work.barrier()
        def hints(self,*args,**kwargs):
            value=original(self,*args,**kwargs)
            pause()
            return value
        monkeypatch.setattr(PostgresListenerSearch,'_listener_native_hints',hints)
        reader=work.start(lambda:native(state,result,context=context,connect=work.connections))
        assert hinted.wait(8)
        with runtime_connect(state['db'].app_url) as writer:
            writer.execute('select id from library.local_tracks where id=%s for update',(track['id'],))
            writer_pid=writer.info.backend_pid
            release.set()
            deadline=time.monotonic()+8
            reader_pid=None
            while time.monotonic()<deadline:
                for con in tuple(work.connections.items):
                    if not con.closed:
                        with state['db'].connect() as monitor:
                            blockers=monitor.execute('select pg_blocking_pids(%s) as b',(con.info.backend_pid,)).fetchone()['b']
                        if writer_pid in blockers:reader_pid=con.info.backend_pid;break
                if reader_pid is not None:break
                time.sleep(.01)
            assert reader_pid is not None
            # This invalidation must complete while the reader is still blocked.
            # A revision/inventory inversion would block here and fail the harness.
            writer.execute("set local statement_timeout='8s'")
            writer.execute("update library.local_tracks set title=title || ' changed' where id=%s",(track['id'],))
        with pytest.raises(PrivateSearchError) as caught:
            reader.result(timeout=8)
        assert caught.value.status_code==409
    assert all(con.closed for con in work.connections.items)


@pytest.mark.parametrize('change',['epoch','relationship','profile','mapping'])
def test_drift_between_hint_and_prelock_never_returns_output(native_activity,monkeypatch,change):
    state,context,_,_=native_activity
    seed_preference(state,state['data']['tracks'][0],account=state['peer'])
    result=capture(native_activity,' :loved')
    original=PostgresListenerSearch._listener_native_hints
    def hints(self,*args,**kwargs):
        value=original(self,*args,**kwargs)
        with state['db'].connect() as con:
            if change=='epoch':con.execute("update app.track_preferences set love_tier='off' where account_id=%s and library_id=%s",(state['peer'],context.library_id))
            elif change=='relationship':con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
            elif change=='profile':con.execute("update app.accounts set display_name=display_name || ' changed' where id=%s",(state['peer'],))
            else:con.execute('delete from library.local_track_files where track_id=%s',(state['data']['tracks'][0]['id'],))
        return value
    monkeypatch.setattr(PostgresListenerSearch,'_listener_native_hints',hints)
    # A display-name-only edit is current identity and is not an authority change.
    if change=='profile':
        assert native(state,result,context=context)['status']=='ready'
    else:
        status=403 if change=='relationship' else 409
        error(status,lambda:native(state,result,context=context))


@pytest.mark.parametrize('initial',[False,True])
def test_native_dynamic_admission_cannot_add_or_remove_id_after_prelock(native_activity,monkeypatch,initial):
    state,context,_,_=native_activity
    result=capture(native_activity)
    allowed=[initial]
    track=state['data']['tracks'][0]
    original=ActivityNativeTargets.prelock_listener_on_connection
    inventories=[]
    inventory_original=native_module.inventory.inventory_rows
    def inventory(con,library,identities,*args,**kwargs):
        inventories.append(tuple(identities))
        return inventory_original(con,library,identities,*args,**kwargs)
    monkeypatch.setattr(native_module.inventory,'inventory_rows',inventory)
    def prelock(self,*args,**kwargs):
        value=original(self,*args,**kwargs)
        allowed[0]=not initial
        return value
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',prelock)
    def constraints(ctx):
        blocked=(ctx.action=='library.browse.read' and ctx.target_account_id is None and ctx.resource is not None
            and ctx.resource.resource_kind=='track' and ctx.resource.resource_ref==str(track['id']) and not allowed[0])
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)
    error(409,lambda:native(state,result,context=context,constraints=constraints))
    if not initial:assert all(track['id'] not in ids for ids in inventories)


def test_actual_config_only_absent_for_prelock_and_media_uses_real_resolver(native_activity,monkeypatch):
    state,context,fixture_service,probes=native_activity
    result=capture(native_activity)
    config=state['db'].config
    before=deepcopy(config)
    calls=[]
    original=native_module.inventory.inventory_rows
    def observe(con,library,identities,*args,**kwargs):
        calls.append((con,tuple(identities),kwargs.get('config')))
        if kwargs.get('config') is None:assert not probes
        return original(con,library,identities,*args,**kwargs)
    monkeypatch.setattr(native_module.inventory,'inventory_rows',observe)
    init=ActivityNativeTargets.__init__
    def constructor(self,actual,*args,**kwargs):
        assert actual is config
        return init(self,actual,*args,media_resolver=fixture_service.targets.media_resolver,**kwargs)
    monkeypatch.setattr(ActivityNativeTargets,'__init__',constructor)
    actual=native(state,result,operation='single',intent='play',context=context)
    assert actual['data']['native_target']['path'] in probes
    assert calls[0][2] is None and all(item[2] is config for item in calls[1:])
    assert len({id(item[0]) for item in calls})==1 and config==before


@pytest.mark.parametrize('failure',['native','predicate'])
def test_final_failure_after_output_assembly_rolls_back_and_releases(native_activity,monkeypatch,failure):
    state,context,_,_=native_activity
    seed_preference(state,state['data']['tracks'][0],account=state['peer'])
    original=ActivityNativeTargets.project_listener_on_connection
    assembled=[]
    def output(self,*args,**kwargs):
        actual=original(self,*args,**kwargs)
        assembled.append(actual)
        if failure=='native':raise RuntimeError('synthetic-private injected final native failure')
        # The real final predicate recheck sees narrowed account taste authority.
        changed[0]=True
        return actual
    changed=[False]
    def constraints(ctx):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            changed[0] and ctx.action=='library.social.taste.read'))
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    monkeypatch.setattr(ActivityNativeTargets,'project_listener_on_connection',output)
    connections=Connections()
    error(503 if failure=='native' else 403,lambda:native(state,result,context=context,
        constraints=constraints,connect=connections))
    assert assembled and all(con.closed for con in connections.items)
    with runtime_connect(state['db'].app_url) as con:
        con.execute("set local lock_timeout='2s'")
        con.execute("update library.local_tracks set title=title where id=%s",(state['data']['tracks'][0]['id'],))


@pytest.mark.parametrize('replacement',['unknown:unmapped','track:999999999','album:1'])
def test_fixture_inconsistent_receipt_mapping_between_phases_rejects(native_activity,monkeypatch,replacement):
    state,context,_,_=native_activity
    result=capture(native_activity)
    original=PostgresListenerSearch._listener_native_hints
    def hints(self,*args,**kwargs):
        value=original(self,*args,**kwargs)
        # Deliberate fixture-only corruption; there is no production mutation seam.
        with state['db'].connect() as con:
            con.execute("""update app.activity_snapshot_rows set row_key=%s
                where payload->>'id'=%s and snapshot_id in
                (select id from app.activity_snapshots where account_id=%s)""",
                (replacement,result['tracks'][0]['id'],state['actor'].account_id))
        return value
    monkeypatch.setattr(PostgresListenerSearch,'_listener_native_hints',hints)
    error(503 if replacement.startswith('album:') else 409,
          lambda:native(state,result,context=context))


def test_prelock_rejects_other_connection_and_cannot_outlive_transaction(native_activity,monkeypatch):
    from music_app.services.private_native_targets import NativeTargetError
    state,context,_,_=native_activity
    result=capture(native_activity)
    original=ActivityNativeTargets.prelock_listener_on_connection
    retained=[]
    def observe(self,con,listener_context,*args,**kwargs):
        value=original(self,con,listener_context,*args,**kwargs)
        with runtime_connect(state['db'].app_url) as other:
            other.execute('select 1')
            with pytest.raises(NativeTargetError) as caught:
                value.assert_unchanged(other,listener_context,kwargs.get('constraints'))
            assert caught.value.status_code==503
        retained.append((value,con,listener_context,kwargs.get('constraints')))
        return value
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',observe)
    assert native(state,result,context=context)['status']=='ready'
    value,con,listener_context,constraints=retained[0]
    assert value.active is False
    with pytest.raises(NativeTargetError) as caught:
        value.assert_unchanged(con,listener_context,constraints)
    assert caught.value.status_code==503


def test_full_taste_digest_rechecked_after_output_assembly(native_activity,monkeypatch):
    state,context,_,_=native_activity
    for track in state['data']['tracks'][:2]:seed_preference(state,track,account=state['peer'])
    skipped=state['data']['tracks'][1]['id']
    changed=[False]
    def constraints(ctx):
        denied=(not changed[0] and ctx.action=='library.social.taste.read' and ctx.resource is not None
            and ctx.resource.resource_kind=='track' and ctx.resource.resource_ref==str(skipped))
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    assert len(result['tracks'])==1
    original=ActivityNativeTargets.project_listener_on_connection
    def assembled(self,*args,**kwargs):
        value=original(self,*args,**kwargs)
        changed[0]=True
        return value
    monkeypatch.setattr(ActivityNativeTargets,'project_listener_on_connection',assembled)
    error(409,lambda:native(state,result,context=context,constraints=constraints),'search_cursor_restart_required')


def test_null_mapping_is_ordered_unavailable_without_inventory_or_resolver(native_activity,monkeypatch):
    state,context,_,_=native_activity
    result=capture(native_activity)
    selected=[result['tracks'][0]['id']]
    with state['db'].connect() as con:
        con.execute("""update app.activity_snapshot_rows set row_key='fixture:unmapped'
            where payload->>'id'=%s and snapshot_id in
            (select id from app.activity_snapshots where account_id=%s)""",(selected[0],state['actor'].account_id))
    def forbidden(*args,**kwargs):raise AssertionError('Null identity reached native inventory')
    monkeypatch.setattr(native_module.inventory,'inventory_rows',forbidden)
    actual=native(state,result,operation='batch',selected=selected,context=context)
    assert actual['data']['items']==[{'row_ref':selected[0],'status':'unavailable','native_target':None}]
    error(404,lambda:native(state,result,operation='single',selected=selected,context=context))


def test_repeated_canonical_ids_prelock_sorted_unique_and_reconstruct_request_order(native_activity,monkeypatch):
    state,context,_,_=native_activity
    result=capture(native_activity)
    # Deliberate fixture evidence representing two receipt references for one ID.
    first,second=[r['id'] for r in result['tracks']]
    with state['db'].connect() as con:
        row=con.execute("select row_key from app.activity_snapshot_rows where payload->>'id'=%s",(first,)).fetchone()
        identity=int(row['row_key'].split(':')[1])
        con.execute("update app.activity_snapshot_rows set row_key=%s where payload->>'id'=%s",('track:0'+str(identity),second))
    calls=[]
    original=native_module.inventory.inventory_rows
    def observe(con,library,ids,*args,**kwargs):
        calls.append((list(ids),kwargs.get('config')))
        return original(con,library,ids,*args,**kwargs)
    monkeypatch.setattr(native_module.inventory,'inventory_rows',observe)
    selected=[second,first]
    actual=native(state,result,operation='batch',selected=selected,context=context)
    assert calls[0][0]==[identity] and calls[0][1] is None
    assert [item['row_ref'] for item in actual['data']['items']]==selected
    targets=[item['native_target']['inventory_track_ref'] for item in actual['data']['items']]
    assert targets==[f'inventory-track:{context.library_id}:{identity}']*2


def test_durable_listener_media_grant_cannot_authorize_actor_native_and_library_grant_can(native_activity,monkeypatch):
    from dataclasses import replace
    from music_app.services.capabilities import grant_keys_for_action
    from music_app.services.policy import ResourceScope
    from music_app.services.policy_evaluator import PolicyEvaluator
    state,context,fixture_service,probes=native_activity
    account,library=state['actor'].account_id,context.library_id
    track=state['data']['tracks'][0]
    seed_preference(state,track,love='off',rating=1)
    seed_preference(state,track,account=state['peer'],love='obsessed',rating=5)
    with state['db'].connect() as con:
        con.execute('update app.capabilities set revoked_at=clock_timestamp() where account_id=%s and capability_key=any(%s)',
            (account,sorted(grant_keys_for_action('library.media.read'))))
        for action in ('library.media.read','library.track_preferences.manage'):
            con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,%s,'account',%s)",
                (account,action,state['peer']))
        assert con.execute("select count(*) as n from app.capabilities where account_id=%s and capability_key='library.browse.read' and scope_kind='library' and scope_id=%s and revoked_at is null",
            (account,library)).fetchone()['n']==1
    observed=[]
    prelocked=[]
    def constraints(ctx):
        observed.append(ctx)
        return PolicyEvaluationConstraints()
    original=ActivityNativeTargets.prelock_listener_on_connection
    def observe_prelock(self,con,listener_context,*args,**kwargs):
        value=original(self,con,listener_context,*args,**kwargs)
        assert value.context==replace(listener_context,target_account_id=None)
        prelocked.append((listener_context,value.context))
        return value
    monkeypatch.setattr(ActivityNativeTargets,'prelock_listener_on_connection',observe_prelock)
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    negative=native(state,result,operation='single',context=context,constraints=constraints)
    target=negative['data']['native_target']
    assert target['track_preference']['rating']==1 and target['track_preference']['love_tier']=='off'
    assert target['allowed_actions']['can_play'] is False
    # Browse intentionally supplies intrinsic self preference management. A
    # separate account-scoped manage grant must not be mistaken for its source.
    assert target['track_preference']['allowed_actions']=={
        'can_rate':True,'can_set_love_tier':True,'client_surface_class':'private_web'}
    listener_ctx,actor_ctx=prelocked[-1]
    evaluator=PolicyEvaluator()
    media=replace(actor_ctx,action='library.media.read',resource=ResourceScope('track',str(track['id'])))
    assert evaluator.evaluate(media).decision.allowed is False
    assert evaluator.evaluate(replace(media,target_account_id=state['peer'])).decision.allowed is True
    assert any(g.capability_key=='library.media.read' and g.scope_kind=='account' and g.scope_id==state['peer'] for g in actor_ctx.actor.capability_grants)
    assert not any(g.capability_key in grant_keys_for_action('library.media.read') and g.scope_kind in {'global','library'} for g in actor_ctx.actor.capability_grants)
    error(403,lambda:native(state,result,operation='single',intent='play',context=context,constraints=constraints))
    assert probes==[]
    # Positive actor-native permission is an actual durable library grant.
    with state['db'].connect() as con:
        con.execute("insert into app.capabilities(account_id,capability_key,scope_kind,scope_id) values(%s,'library.media.read','library',%s)",
            (account,library))
    # The durable grant changes the receipt authority fingerprint.
    error(409,lambda:native(state,result,operation='single',intent='play',context=context,constraints=constraints))
    assert probes==[]
    result=read(state,subject=state['peer'],suffix=' :loved',context=context,constraints=constraints)
    init=ActivityNativeTargets.__init__
    def constructor(self,config,*args,**kwargs):
        return init(self,config,*args,media_resolver=fixture_service.targets.media_resolver,**kwargs)
    monkeypatch.setattr(ActivityNativeTargets,'__init__',constructor)
    positive=native(state,result,operation='single',intent='play',context=context,constraints=constraints)
    assert positive['data']['native_target']['path'] in probes
    assert any(g.capability_key=='library.media.read' and g.scope_kind=='library' and g.scope_id==library
        for g in prelocked[-1][1].actor.capability_grants)
    native(state,result,operation='bindings',context=context,constraints=constraints)
    for kind in ('album','artist'):
        native(state,result,operation='single',intent='details',target_kind=kind,context=context,constraints=constraints)
    # Observe actual owner inputs, including native Browse and editable taste.
    for action in ('library.browse.read','library.media.read','library.track_preferences.manage'):
        calls=[ctx for ctx in observed if ctx.action==action and ctx.resource is not None and ctx.resource.resource_kind=='track']
        assert calls and all(ctx.target_account_id is None for ctx in calls)
    for action in ('library.social.history.read','library.social.taste.read'):
        calls=[ctx for ctx in observed if ctx.action==action]
        assert calls and all(ctx.target_account_id==state['peer'] for ctx in calls)

    for action in ('library.playlists.create','library.playlists.items.manage'):
        calls=[ctx for ctx in observed if ctx.action==action]
        assert calls and all(ctx.target_account_id is None for ctx in calls)
    for kind in ('album','artist'):
        calls=[ctx for ctx in observed if ctx.action=='library.browse.read' and ctx.resource is not None and ctx.resource.resource_kind==kind]
        assert calls and all(ctx.target_account_id is None for ctx in calls)
    assert all(ctx.target_account_id is None for ctx in observed if ctx.action=='library.artwork.read')
