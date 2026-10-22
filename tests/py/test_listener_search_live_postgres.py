"""Real LS-B1 protected reads, sparse traversal, revision and policy evidence."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import pytest
from music_app.services import private_listener_search_predicate as predicate_module
from music_app.services.home_activity import ActivityQuery, read_home_activity
from music_app.services.private_listener_search_cursor import decode_listener_search_token
from music_app.services.private_search_contract import PrivateSearchError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.listener_search_live_support import (
    CONTEXT_REF, SECRET, NOW, database_urls, mutable_ledger, social_ledger,
    read, request, service, error, profile, context_for, add_history_rows,
    seed_preference, revision, deny, assert_wire, expire_session_with_database_clock,
    runtime_connect,
)


@pytest.mark.parametrize('friend',[False,True])
def test_runtime_listener_read_keeps_social_profile_mutation_denied(social_ledger,friend):
    state = social_ledger
    subject = state['peer'] if friend else state['actor'].account_id
    identity = profile(state['db'],subject)
    checked = []

    @contextmanager
    def guarded_runtime_connect(url):
        assert url == state['db'].app_url
        with runtime_connect(url) as connection:
            permissions = connection.execute("""select
                pg_has_role(current_user,'album_haven_app','MEMBER') as app_role,
                pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator_role,
                has_table_privilege(current_user,'app.social_profiles','SELECT') as can_select,
                has_table_privilege(current_user,'app.social_profiles','UPDATE') as can_update,
                has_any_column_privilege(current_user,'app.social_profiles','UPDATE') as can_update_column,
                has_table_privilege(current_user,'app.social_profiles','DELETE') as can_delete
                """).fetchone()
            assert permissions == {'app_role':True,'migrator_role':False,'can_select':True,
                'can_update':False,'can_update_column':False,'can_delete':False}
            # Finish the privilege probe before the service chooses isolation.
            connection.commit()
            checked.append(connection.info.backend_pid)
            yield connection

    value = read(state,subject=subject,connect=guarded_runtime_connect)
    assert checked
    assert_wire(value)
    assert value['listener'] == {'account_ref':identity['account_ref'],
        'username':identity['username_display'],'display_name':identity['display_name']}
    assert value['page']['total_matches'] == (2 if friend else 3)


@pytest.mark.parametrize('friend',[False,True])
def test_actual_identity_bare_and_explicit_whitespace_same_membership(social_ledger,friend):
    state = social_ledger
    subject = state['peer'] if friend else state['actor'].account_id
    identity = profile(state['db'],subject)
    query = '  @' + identity['username_normalized'].upper() + '  :TRACKS listened:all  '
    explicit = read(state,query=query)
    bare = read(state,subject=subject)
    for value in (explicit,bare):
        assert_wire(value)
        assert value['listener'] == {'account_ref':identity['account_ref'],
            'username':identity['username_display'],'display_name':identity['display_name']}
        assert value['page']['total_matches'] == (2 if friend else 3)
    assert explicit['query'] == query
    assert [r['title'] for r in explicit['tracks']] == [r['title'] for r in bare['tracks']]


@pytest.mark.parametrize('suffix,expected', [(' :loved',{0,1}),(' :obsessed',{1}),
    (' :loved -:obsessed',{0}),(' -:loved',{2}),(' :loved -:loved',set())])
def test_same_subject_love_expansion_and_known_default_off(mutable_ledger,suffix,expected):
    state = mutable_ledger
    seed_preference(state,state['data']['tracks'][0],love='loved')
    seed_preference(state,state['data']['tracks'][1],love='obsessed')
    result = read(state,suffix=suffix)
    assert_wire(result)
    assert {r['title'] for r in result['tracks']} == {f'Track {i:04}' for i in expected}
    assert result['page']['total_matches'] == len(expected)
    assert result['history']['total_tracks'] == result['history']['total_listens'] == 3


def test_friend_love_is_not_viewer_love_or_rating(social_ledger):
    state = social_ledger
    one,two = state['data']['tracks'][:2]
    seed_preference(state,one,love='off',rating=1)
    seed_preference(state,two,love='obsessed',rating=5)
    seed_preference(state,one,account=state['peer'],love='loved',rating=5)
    seed_preference(state,two,account=state['peer'],love='off',rating=1)
    result = read(state,subject=state['peer'],suffix=' :loved')
    assert [r['title'] for r in result['tracks']] == ['Track 0000']
    assert_wire(result)


def test_history_permission_does_not_grant_taste_and_history_does_not_load_preferences(social_ledger,monkeypatch):
    state = social_ledger
    def forbidden(*args,**kwargs):
        raise AssertionError('history-only loaded preferences')
    monkeypatch.setattr(predicate_module,'load_track_preferences_on_connection',forbidden)
    constraints = deny('library.social.taste.read')
    assert len(read(state,subject=state['peer'],constraints=constraints)['tracks']) == 2
    error(403,lambda: read(state,subject=state['peer'],suffix=' :loved',constraints=constraints))


def test_denied_track_is_not_off_and_is_excluded_before_preference_loader(social_ledger,monkeypatch):
    state = social_ledger
    denied = state['data']['tracks'][0]
    calls = []
    original = predicate_module.load_track_preferences_on_connection
    def observe(con,refs,**kwargs):
        calls.append((list(refs),kwargs))
        return original(con,refs,**kwargs)
    monkeypatch.setattr(predicate_module,'load_track_preferences_on_connection',observe)
    result = read(state,subject=state['peer'],suffix=' -:loved',
                  constraints=deny('library.social.taste.read',track=denied['id']))
    assert [r['title'] for r in result['tracks']] == ['Track 0001']
    assert calls and all(denied['key'] not in refs for refs,_ in calls)
    assert all(args['account_id'] == state['peer'] for _,args in calls)


@pytest.mark.parametrize('conflict',['alias','wrong_id','unknown'])
def test_unknown_or_conflicting_identity_never_passes_exclusion(mutable_ledger,conflict):
    state = mutable_ledger
    track,other = state['data']['tracks'][:2]
    if conflict == 'alias':
        seed_preference(state,track,love='off')
        seed_preference(state,track,key=track['path'],love='off')
    elif conflict == 'wrong_id':
        seed_preference(state,track,love='off',track_id=other['id'])
    else:
        with state['db'].connect() as con:
            con.execute('delete from library.local_track_files where track_id=%s',(track['id'],))
    result = read(state,suffix=' -:loved')
    assert 'Track 0000' not in {r['title'] for r in result['tracks']}


def test_sparse_250_history_two_progress_pages_then_exact_total(mutable_ledger):
    state = mutable_ledger
    add_history_rows(state,count=250)
    # Order is established from the unfiltered receipt; it is not assumed from IDs.
    unfiltered, cursor = [], None
    while True:
        page = read(state,cursor=cursor)
        unfiltered.extend(page['tracks'])
        cursor = page['page']['next_cursor']
        if cursor is None:break
    by_title = {t.get('title',f'Listener {i:04}'):t for i,t in enumerate(state['data']['tracks'])}
    selected_titles = {r['title'] for r in unfiltered[200:]}
    for title in selected_titles:
        seed_preference(state,by_title[title])
    first = read(state,suffix=' :loved')
    second = read(state,suffix=' :loved',cursor=first['page']['next_cursor'])
    third = read(state,suffix=' :loved',cursor=second['page']['next_cursor'])
    for value,ordinal in ((first,100),(second,200)):
        assert_wire(value)
        assert value['tracks'] == [] and value['page']['has_more'] is True
        assert value['page']['candidates_examined'] == 100 and value['page']['total_matches'] is None
        token = decode_listener_search_token(value['page']['next_cursor'],secret=SECRET,purpose='cursor')
        assert token['position'] == {'after_ordinal':ordinal,'matched_before':0}
    assert {r['title'] for r in third['tracks']} == selected_titles
    assert third['page']['total_matches'] == 50 and third['page']['next_cursor'] is None
    assert third['history']['total_tracks'] == 250
    replay = read(state,suffix=' :loved',cursor=first['page']['next_cursor'])
    assert replay['tracks'] == second['tracks'] and replay['page']['candidates_examined'] == 100


def test_small_page_resume_neither_loses_nor_duplicates_matching_rows(mutable_ledger):
    state = mutable_ledger
    for track in state['data']['tracks']:
        seed_preference(state,track,love='obsessed')
    pages, cursor = [],None
    while True:
        page = read(state,suffix=' :loved',limit=1,cursor=cursor)
        pages.append(page)
        cursor = page['page']['next_cursor']
        if cursor is None:break
    assert len(pages) == 3
    assert len({r['id'] for p in pages for r in p['tracks']}) == 3
    assert all(p['page']['candidates_examined']==1 for p in pages)
    assert [p['page']['total_matches'] for p in pages] == [None,None,3]


@pytest.mark.parametrize('change',['love','insert','delete','key','rating','noop'])
def test_filtered_cursor_epoch_and_history_receipt_independence(mutable_ledger,change):
    state = mutable_ledger
    track = state['data']['tracks'][0]
    pref = seed_preference(state,track)
    first = read(state,suffix=' -:obsessed',limit=1)
    raw = read(state,limit=1)
    before = revision(state)
    with state['db'].connect() as con:
        if change == 'insert':
            con.execute("insert into app.track_preferences(account_id,library_id,track_key,rating) values(%s,%s,%s,4)",
                (state['actor'].account_id,state['data']['library'],state['data']['tracks'][1]['key']))
        elif change == 'delete':
            con.execute('delete from app.track_preferences where id=%s',(pref,))
        else:
            sql = {'love':"love_tier='obsessed'",'key':"track_key=track_key || '-alias'",'rating':'rating=4','noop':'love_tier=love_tier'}[change]
            con.execute('update app.track_preferences set '+sql+' where id=%s',(pref,))
    changed = change not in {'rating','noop'}
    assert revision(state)['love_revision'] == before['love_revision'] + int(changed)
    assert revision(state)['revision'] == before['revision']
    if changed:
        error(409,lambda:read(state,suffix=' -:obsessed',limit=1,cursor=first['page']['next_cursor']), 'search_cursor_restart_required')
    else:
        assert_wire(read(state,suffix=' -:obsessed',limit=1,cursor=first['page']['next_cursor']))
    assert_wire(read(state,limit=1,cursor=raw['page']['next_cursor']))


def test_callable_policy_rechecks_previously_excluded_row(social_ledger):
    state = social_ledger
    for track in state['data']['tracks'][:2]:
        seed_preference(state,track,account=state['peer'])
    changed = [False]
    denied = state['data']['tracks'][1]['id']
    def constraints(ctx):
        block = (not changed[0] and ctx.action=='library.social.taste.read' and ctx.resource is not None
                 and ctx.resource.resource_kind=='track' and ctx.resource.resource_ref==str(denied))
        return PolicyEvaluationConstraints(request_origin_allowed=not block)
    first = read(state,subject=state['peer'],suffix=' :loved',limit=1,constraints=constraints)
    assert first['page']['next_cursor']
    changed[0] = True
    error(409,lambda:read(state,subject=state['peer'],suffix=' :loved',limit=1,
        cursor=first['page']['next_cursor'],constraints=constraints),'search_cursor_restart_required')


@pytest.mark.parametrize('change',['friendship','membership','disabled','session','renamed'])
def test_current_subject_and_actor_denial_not_hidden_by_token(social_ledger,change):
    state = social_ledger
    first = read(state,subject=state['peer'],limit=1)
    query = first['query']
    with state['db'].connect() as con:
        if change=='friendship':con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
        elif change=='membership':con.execute('delete from library.library_memberships where account_id=%s and library_id=%s',(state['peer'],state['data']['library']))
        elif change=='disabled':con.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',(state['peer'],))
        elif change=='session':con.execute('update app.account_sessions set idle_expires_at=clock_timestamp()-interval \'1 second\' where id=%s',(state['actor'].session_id,))
        else:con.execute("update app.accounts set username_normalized=username_normalized || '-new',username_display=username_display || '-new' where id=%s",(state['peer'],))
    error(403,lambda:read(state,query=query,limit=1,cursor=first['page']['next_cursor']))


@pytest.mark.parametrize('change',['query','limit','context','session','library','actor'])
def test_token_scope_change_restarts_before_private_receipt(mutable_ledger,change,monkeypatch):
    state = mutable_ledger
    first = read(state,limit=1)
    args = dict(limit=1,cursor=first['page']['next_cursor'])
    context = context_for(state['actor'])
    if change=='query':args['suffix']=' :loved'
    elif change=='limit':args['limit']=2
    elif change=='context':args['context_ref']='b'*64
    elif change=='session':args['context']=replace(context,actor=replace(context.actor,session_id=context.actor.session_id+1))
    elif change=='library':args['context']=replace(context,library_id=context.library_id+1)
    else:args['context']=replace(context,actor=replace(context.actor,account_id=context.actor.account_id+1))
    def forbidden(*args,**kwargs):raise AssertionError('scope mismatch reached private receipt')
    monkeypatch.setattr(type(service(state)),'_history_receipt',forbidden)
    error(409,lambda:read(state,**args),'search_cursor_restart_required')


def test_receipt_expiry_is_restart_and_does_not_capture_again(mutable_ledger):
    state = mutable_ledger
    first = read(state,limit=1)
    owner = service(state)
    owner.clock = lambda: NOW + timedelta(hours=2)
    error(409,lambda:owner.read_live(context_for(state['actor']),
        request=request(state,limit=1,cursor=first['page']['next_cursor']),context_ref=CONTEXT_REF,cursor_secret=SECRET))


def test_borrowed_receipt_cannot_be_used_after_guard_exit(mutable_ledger,monkeypatch):
    from music_app.services.home_activity import HomeActivityError
    state=mutable_ledger
    owner=type(service(state))
    original=owner._history_receipt
    retained=[]
    @contextmanager
    def observe(self,*args,**kwargs):
        with original(self,*args,**kwargs) as receipt:
            retained.append(receipt)
            yield receipt
    monkeypatch.setattr(owner,'_history_receipt',observe)
    assert_wire(read(state))
    receipt=retained[0]
    for operation in (lambda:receipt.summary,lambda:receipt.window(0),
                      lambda:receipt.selection(['activity_'+'0'*64]),
                      lambda:list(receipt.iter_canonical_track_refs())):
        with pytest.raises(HomeActivityError) as caught:operation()
        assert caught.value.status_code==503


def test_initial_capture_then_revoked_history_leaks_no_result(social_ledger,monkeypatch):
    state=social_ledger
    owner=type(service(state))
    original=owner.read
    def capture_then_revoke(self,*args,**kwargs):
        value=original(self,*args,**kwargs)
        with state['db'].connect() as con:
            con.execute("update app.friend_connections set state='removed',revision=revision+1 where library_id=%s and low_account_id=%s and high_account_id=%s",state['pair'])
        return value
    monkeypatch.setattr(owner,'read',capture_then_revoke)
    error(403,lambda:read(state,subject=state['peer']))
