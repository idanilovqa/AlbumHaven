"""Real Goals/Top authority, SQL, role and concurrency contracts; no provider IO."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from threading import Barrier, Event
from uuid import uuid4

import pytest

from music_app.services.current_actor import CapabilityGrant, LibraryRelationship
from music_app.services.listening_goal_bonus import normalize_bonus_draw
from music_app.services.listening_goal_bonus_settings import normalize_bonus_settings
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService
from music_app.services.owned_album_tops import normalize_top_command, BROWSE, ACCESS, PROGRESS
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from tests.py import test_listening_goals_postgres as base
from tests.py.test_listening_goals_postgres import urls, assert_error
from tests.py.test_listening_goal_bonus_settings import payload as settings_payload
from tests.py.test_listening_goals_manual_postgres import command as manual_command


class BonusDatabase(base.GoalsDatabase):
    def member(self, actor, actions=(BROWSE,)):
        with self.connect() as connection:
            connection.execute('''insert into library.library_memberships(account_id,library_id,membership_role)
                values(%s,%s,'member')''', (actor.account_id,self.library))
            for action in actions:
                connection.execute('''insert into app.capabilities(account_id,capability_key,scope_kind,scope_id)
                    values(%s,%s,'library',%s)''', (actor.account_id,action,self.library))
        return replace(actor,current_library_id=self.library,
            library_relationships=(LibraryRelationship(self.library,'member',False),),
            capability_grants=tuple(CapabilityGrant(action,'library',self.library) for action in actions))

    def source(self, refs=None, *, owner=None, visibility='private'):
        owner = owner or self.owner
        top = str(uuid4())
        with self.connect() as connection:
            if refs is None:
                refs = []
                for number in range(3):
                    ref = str(uuid4())
                    connection.execute('''insert into catalog.release_groups(ref,title,artist_display,release_year)
                        values(%s,%s,'Remote source artist',2001)''', (ref,'Remote source '+str(number)))
                    self.catalog_refs.append(ref)
                    refs.append(ref)
            connection.execute('''insert into app.album_lists(ref,owner_account_id,library_id,title,visibility,next_original_position)
                values(%s,%s,%s,'Synthetic bonus source',%s,%s)''', (top,owner.account_id,self.library,visibility,len(refs)+1))
            for position, ref in enumerate(refs,1):
                connection.execute('''insert into app.album_list_items
                    (ref,top_ref,library_id,catalog_ref,original_position,curator_position)
                    values(%s,%s,%s,%s,%s,%s)''', (str(uuid4()),top,self.library,ref,position,position))
        return top, list(refs)

    def settings(self, **changes):
        current = self.service.read_bonus_settings(self.context())
        values = {key: current[key] for key in ('enabled','source_mode','selected_top_refs',
                  'preferred_top_refs','album_mode','unfinished_policy')}
        return self.service.save_bonus_settings(self.context(),normalize_bonus_settings(settings_payload(
            settings_revision=current['settings_revision'],**{**values,**changes})))

    def draw_command(self, **changes):
        current = self.service.read(self.context())
        settings = self.service.read_bonus_settings(self.context())
        week = current['periods']['week']['cycle']
        return normalize_bonus_draw({'request_key':str(uuid4()),'revision':current['revision'],
            'settings_revision':settings['settings_revision'],'expected_cycle_id':week['cycle_id'] if week else None,
            'timezone_name':'UTC',**changes})

    def draw(self, *, service=None, command=None, actor=None):
        return (service or self.service).draw_bonus(self.context(actor),command or self.draw_command())

    def selected(self, action, album, **options):
        return self.service.execute(self.context(),manual_command(self,action,album,**options))

    def remove_all(self, album):
        for period in base.PERIODS:
            if album in self.service.read(self.context())['periods'][period]['album_refs']:
                self.selected('remove',album,period=period)

    def exclusion(self, album):
        with self.connect() as connection:
            row = connection.execute('''select completed from app.listening_goal_bonus_eligibility
                where account_id=%s and catalog_ref=%s''',(self.owner.account_id,album)).fetchone()
            return row['completed'] if row else False

    def bounded_service(self, *, before=None, after=None, random=None):
        @contextmanager
        def connect(url):
            with self.connector(before=before,after=after)(url) as connection:
                connection.execute("set local lock_timeout='5s'")
                connection.execute("set local statement_timeout='10s'")
                yield connection
        return PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL':self.app_url},
            connect=connect,clock=lambda:self.now,provider=self.provider,user_agent=base.USER_AGENT,
            bonus_randbelow=random or (lambda bound:0))

    def close(self):
        # Reuse the admitted fixture's real retained-history teardown, extending
        # only its dependency order for these new FK tables. No test owner leaks.
        old = base.GOAL_TABLES
        base.GOAL_TABLES = ('listening_goal_bonus_draws','listening_goal_bonus_eligibility',*old,
                           'listening_goal_top_admissions','listening_goal_bonus_settings')
        try:
            with self.connect() as connection:
                connection.execute('delete from app.album_list_operations where actor_account_id=any(%s)',(self.account_ids,))
                connection.execute('delete from app.album_lists where owner_account_id=any(%s)',(self.account_ids,))
            super().close()
        finally:
            base.GOAL_TABLES = old


@pytest.fixture
def bonus_db(urls):
    db = BonusDatabase(urls)
    try:
        with db.connect() as connection:
            actor = db.actor(connection)
            db.library = connection.execute('''insert into library.libraries(owner_account_id,name)
                values(%s,%s) returning id''',(actor.account_id,'Bonus source '+db.token)).fetchone()['id']
            db.library_ids.append(db.library)
        db.owner = db.member(actor)
        db.service = db.bounded_service()
        db.top_service = PostgresOwnedAlbumTopsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},
            connect=db.connector(),clock=lambda:db.now)
        yield db
    finally:
        db.close()


def test_five_manual_plus_one_remote_bonus_exact_receipt_and_no_fabricated_evidence(bonus_db):
    db = bonus_db
    top, refs = db.source()
    for _ in range(5):
        db.add()
    db.settings(enabled=True,album_mode='next')
    command = db.draw_command()
    receipt = db.draw(command=command)
    assert receipt['changed'] and receipt['catalog_ref'] == refs[0]
    assert db.draw(command=command) == receipt
    assert db.service.read_current_bonus(db.context())['manual_count'] == 5
    assert db.service.read(db.context())['periods']['week']['total'] == 6
    extra = db.acquire()
    assert_error(lambda:db.service.execute(db.context(),db.add_command(extra,
        revision=db.service.read(db.context())['revision'])),'weekly_capacity',409)
    with db.connect() as connection:
        row = connection.execute('''select admission_kind,evidence_ref,evidence_version,top_admission_ref
            from app.listening_goal_albums where account_id=%s and catalog_ref=%s''',
            (db.owner.account_id,refs[0])).fetchone()
        assert row['admission_kind']=='album_top' and row['evidence_ref'] is None and row['evidence_version'] is None
        admission = connection.execute('select * from app.listening_goal_top_admissions where ref=%s',
                                       (row['top_admission_ref'],)).fetchone()
        assert str(admission['source_top_ref'])==top and admission['source_library_id']==db.library
        assert connection.execute('select count(*) as n from library.catalog_album_links where catalog_ref=%s',
                                  (refs[0],)).fetchone()['n']==0
        assert connection.execute('select count(*) as n from catalog.release_group_provider_identities where catalog_ref=%s',
                                  (refs[0],)).fetchone()['n']==0


def test_bonus_first_preserves_all_five_manual_slots_and_disable_retains_capture(bonus_db):
    db = bonus_db
    _, refs = db.source()
    db.settings(enabled=True,album_mode='next')
    bonus = db.draw()
    for _ in range(5):
        db.add()
    before, history = db.service.read(db.context()), db.history()
    captured = db.service.read_current_bonus(db.context())
    db.settings(enabled=False)
    assert db.service.read(db.context())==before and db.history()==history
    assert db.service.read_current_bonus(db.context())==captured
    assert_error(lambda:db.draw(),'bonus_disabled',409)
    db.settings(enabled=True)
    assert db.draw()['reason']=='bonus_already_drawn'
    assert bonus['catalog_ref']==refs[0]


def test_replay_and_retained_remote_goal_survive_source_library_removal(bonus_db):
    db = bonus_db
    top, _ = db.source()
    db.settings(enabled=True,album_mode='next')
    command = db.draw_command()
    receipt = db.draw(command=command)
    state = db.service.read(db.context())
    db.service.execute(db.context(),db.reset_command(state))
    current, history = db.service.read(db.context()),db.history()
    with db.connect() as connection:
        connection.execute('delete from app.album_lists where library_id=%s',(db.library,))
        connection.execute('delete from library.library_memberships where library_id=%s',(db.library,))
        connection.execute('delete from library.libraries where id=%s',(db.library,))
    actor = replace(db.owner,current_library_id=None,library_relationships=())
    assert db.draw(actor=actor,command=command)==receipt
    assert db.service.read(db.context(actor))==current
    assert db.history(actor=actor)==history
    assert db.service.read_current_bonus(db.context(actor))['bonus']['catalog_ref']==receipt['catalog_ref']
    assert_error(lambda:db.draw(actor=actor),'source_context_unavailable',403)


def test_duplicate_bonus_add_across_periods_is_noop_but_removed_membership_can_restore(bonus_db):
    db = bonus_db
    evidence = db.acquire()
    first, _ = db.add(evidence)
    album = first['catalog_ref']
    db.remove_all(album)
    db.source([album])
    db.settings(enabled=True,album_mode='next')
    db.draw()
    for period in base.PERIODS:
        before = db.service.read(db.context())
        receipt = db.service.execute(db.context(),db.add_command(evidence,revision=before['revision'],period=period))
        assert not receipt['changed'] and receipt['reason']=='already_added'
        assert db.service.read(db.context())==before
    db.selected('remove',album,period='month')
    state = db.service.read(db.context())
    restored = db.service.execute(db.context(),db.add_command(evidence,revision=state['revision'],period='month'))
    assert restored['changed'] and db.service.read_current_bonus(db.context())['manual_count']==0


def test_reset_carries_bonus_role_and_other_period_completion_keeps_exclusion(bonus_db):
    db = bonus_db
    _, refs = db.source()
    db.settings(enabled=True,album_mode='next')
    db.draw()
    album = refs[0]
    db.selected('completion',album)
    assert db.exclusion(album)
    before = db.service.read(db.context())
    db.service.execute(db.context(),db.reset_command(before))
    assert db.exclusion(album)  # Larger current periods still completed.
    assert db.service.read_current_bonus(db.context())['bonus']['catalog_ref']==album
    assert db.service.read_current_bonus(db.context())['manual_count']==0
    for period in ('month','six-months','year'):
        db.selected('completion',album,period=period,completed=False)
    assert not db.exclusion(album)
    assert db.draw()['reason']=='bonus_already_drawn'
    assert db.history()['cycles'][0]['albums'][0]['manual_completed_at'] is not None


@pytest.mark.parametrize('explicit_clear',['clear','reset'])
def test_remove_completed_preserves_exclusion_and_reset_does_not_sweep_removed_albums(bonus_db,explicit_clear):
    db = bonus_db
    evidence = db.acquire()
    initial, _ = db.add(evidence)
    album = initial['catalog_ref']
    db.remove_all(album)
    db.source([album])
    db.settings(enabled=True,album_mode='next')
    db.draw()
    db.selected('completion',album)
    db.remove_all(album)
    assert db.exclusion(album)
    db.add()  # A retained manual member makes Reset a real new cycle.
    db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    assert db.exclusion(album)
    assert db.draw()['reason']=='no_eligible_source'
    state = db.service.read(db.context())
    db.service.execute(db.context(),db.add_command(evidence,revision=state['revision']))
    assert db.exclusion(album)  # Re-add alone does not erase completion intent.
    if explicit_clear=='clear':
        db.selected('completion',album,completed=False)
    else:
        db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    assert not db.exclusion(album)  # Retained, re-added, unmarked album is affected.
    db.remove_all(album)
    assert db.draw()['catalog_ref']==album


def bonus_snapshot(db):
    with db.connect() as connection:
        return {table: connection.execute('select * from app.'+table+
            ' where account_id=any(%s) order by to_jsonb('+table+')::text',(db.account_ids,)).fetchall()
            for table in ('listening_goal_top_admissions','listening_goal_bonus_draws','listening_goal_bonus_eligibility')}


def test_empty_custom_and_exhausted_top_pool_are_receipted_without_randomness(bonus_db):
    db = bonus_db
    top, refs = db.source()
    db.settings(enabled=True,source_mode='selected',selected_top_refs=[])
    def forbidden(bound):
        raise AssertionError('No eligible source means no random draw')
    service = db.bounded_service(random=forbidden)
    command = db.draw_command()
    result = db.draw(service=service,command=command)
    assert not result['changed'] and result['reason']=='no_eligible_source'
    db.settings(source_mode='all_active')
    assert db.draw(service=service,command=command)==result  # No reroll after recipe changes.
    assert bonus_snapshot(db)['listening_goal_top_admissions']==[]


def test_shared_viewer_sources_use_own_activity_not_owner_and_need_no_edit_grant(bonus_db):
    db = bonus_db
    other = db.member(db.other_actor(),actions=(BROWSE,ACCESS,PROGRESS))
    top, refs = db.source(owner=other)
    grant = normalize_top_command('grant_viewer', {'request_key':str(uuid4()),'revision':'1',
        'account_id':db.owner.account_id,'role':'viewer'},top_ref=top)
    db.top_service.execute(db.context(other),grant)
    db.top_service.execute(db.context(other),normalize_top_command('set_activity',{
        'request_key':str(uuid4()),'active':False,'activity_revision':'0'},top_ref=top))
    db.settings(enabled=True,album_mode='next')
    with db.connect() as connection:
        activity_before = {table: connection.execute('select * from app.'+table+
            ' where top_ref=%s order by account_id, to_jsonb('+table+')::text',(top,)).fetchall()
            for table in ('album_list_activity','album_list_activity_transitions')}
    assert {row['account_id']: (row['active'], row['activity_revision'])
            for row in activity_before['album_list_activity']} == {
        db.owner.account_id: (True, 0), other.account_id: (False, 1)}
    assert {(row['account_id'], row['revision'])
            for row in activity_before['album_list_activity_transitions']} == {
        (db.owner.account_id, 0), (other.account_id, 0), (other.account_id, 1)}
    result = db.draw()
    assert result['catalog_ref']==refs[0]
    assert all(grant.capability_key==BROWSE for grant in db.owner.capability_grants)
    with db.connect() as connection:
        assert connection.execute('''select count(*) as n from app.album_list_item_progress
            where account_id=%s''',(db.owner.account_id,)).fetchone()['n']==0
        activity_after = {table: connection.execute('select * from app.'+table+
            ' where top_ref=%s order by account_id, to_jsonb('+table+')::text',(top,)).fetchall()
            for table in ('album_list_activity','album_list_activity_transitions')}
        assert activity_after == activity_before


@pytest.mark.parametrize('failure',['disabled','session','capability','inactive','deleted'])
def test_current_authority_and_source_status_are_not_replaced_by_saved_settings(bonus_db,failure):
    db = bonus_db
    top, _ = db.source()
    db.settings(enabled=True,source_mode='selected',selected_top_refs=[top])
    if failure=='inactive':
        paused = db.top_service.execute(db.context(),normalize_top_command('set_activity',{
            'request_key':str(uuid4()),'active':False,'activity_revision':'0'},top_ref=top))
        assert paused['active'] is False and paused['activity_revision']=='1'
    with db.connect() as connection:
        if failure=='disabled':
            connection.execute('update app.accounts set is_active=false,disabled_at=%s where id=%s',(db.now,db.owner.account_id))
        elif failure=='session':
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',(db.now,db.owner.session_id))
        elif failure=='capability':
            connection.execute('update app.capabilities set revoked_at=%s where account_id=%s',(db.now,db.owner.account_id))
        elif failure=='deleted':
            connection.execute('update app.album_lists set deleted_at=%s where ref=%s',(db.now,top))
    # Build syntactically known revision inputs without a preparatory denied read.
    command = normalize_bonus_draw({'request_key':str(uuid4()),'revision':'1','settings_revision':'2',
                                   'expected_cycle_id':None,'timezone_name':'UTC'})
    before = bonus_snapshot(db)
    if failure in {'disabled','session','capability'}:
        expected = 'source_context_unavailable' if failure=='capability' else 'forbidden'
        assert_error(lambda:db.draw(command=command),expected,403)
    else:
        assert db.draw(command=command)['reason']=='no_eligible_source'
    assert bonus_snapshot(db)==before


@pytest.mark.parametrize('same_key',[True,False])
def test_concurrent_phase_one_misses_create_only_one_bonus_and_receipt(bonus_db,same_key):
    db = bonus_db
    db.source()
    db.settings(enabled=True,album_mode='next')
    first = db.draw_command()
    second = first if same_key else db.draw_command()
    phase_one = Barrier(2,timeout=5)
    random_calls = []
    @contextmanager
    def connect(url):
        # Each worker gets separate real connections. Synchronize only after the
        # account-only transaction has committed/released its locks.
        with db.connector()(url) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='10s'")
            yield connection
        if not getattr(local,'phase_done',False):
            local.phase_done=True
            phase_one.wait()
    from threading import local as thread_local
    local = thread_local()
    service = PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},
        connect=connect,clock=lambda:db.now,bonus_randbelow=lambda bound:random_calls.append(bound) or 0)
    def draw(command):
        try:
            return service.draw_bonus(db.context(),command)
        except GoalsError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(draw,item) for item in (first,second)]
        results=[future.result(timeout=20) for future in futures]
    if same_key:
        assert results[0]==results[1] and results[0]['changed']
    else:
        assert sum(isinstance(item,dict) for item in results)==1 and 'revision_conflict' in results
    assert random_calls==[1] and len(bonus_snapshot(db)['listening_goal_bonus_draws'])==1


def test_library_loss_between_replay_phase_and_live_source_phase_fails_without_selection(bonus_db):
    db = bonus_db
    db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    phases=[]
    @contextmanager
    def connect(url):
        with db.connector()(url) as connection:
            yield connection
        phases.append(True)
        if len(phases)==1:
            with db.connect() as connection:
                connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                                   (db.owner.account_id,db.library))
    service=PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},connect=connect,
        clock=lambda:db.now,bonus_randbelow=lambda bound:pytest.fail('No entropy after source authority loss'))
    before=bonus_snapshot(db)
    assert_error(lambda:db.draw(service=service,command=command),'source_context_unavailable',403)
    assert bonus_snapshot(db)==before
    assert db.service.read_operation(db.context(),command.request_key)=={'status':'unknown'}


@pytest.mark.parametrize('checkpoint',['admission','album','draw','receipt'])
def test_failure_after_real_sql_rolls_back_entire_bonus_admission(bonus_db,checkpoint):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    targets={'admission':'insert into app.listening_goal_top_admissions',
             'album':'insert into app.listening_goal_albums',
             'draw':'insert into app.listening_goal_bonus_draws',
             'receipt':'insert into app.listening_goal_operations'}
    hit=[]
    def after(sql,params):
        if sql.startswith(targets[checkpoint]):
            hit.append(True)
            raise RuntimeError('synthetic after-SQL failure')
    before=(db.snapshot(),bonus_snapshot(db))
    with pytest.raises(RuntimeError,match='synthetic after-SQL failure'):
        db.draw(service=db.bounded_service(after=after))
    assert hit==[True] and (db.snapshot(),bonus_snapshot(db))==before


def test_ordered_draw_skips_current_goals_and_current_viewer_top_completion(bonus_db):
    db=bonus_db
    top,refs=db.source()
    with db.connect() as connection:
        connection.execute('''insert into app.album_list_item_progress
            (account_id,library_id,top_ref,catalog_ref,revision,manual_completed_at)
            values(%s,%s,%s,%s,1,%s)''',(db.owner.account_id,db.library,top,refs[0],db.now))
    db.settings(enabled=True,album_mode='next')
    first=db.draw()
    assert first['catalog_ref']==refs[1]
    # A reset retains the same bonus; it does not redraw the next source item.
    db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    assert db.draw()['catalog_ref']==refs[1]
    with db.connect() as connection:
        marks=connection.execute('select catalog_ref from app.album_list_item_progress where account_id=%s',
                                 (db.owner.account_id,)).fetchall()
        assert [str(row['catalog_ref']) for row in marks]==[refs[0]]


def test_current_goal_catalog_is_excluded_across_all_source_paths(bonus_db):
    db=bonus_db
    evidence=db.acquire()
    manual,_=db.add(evidence,period='month')
    shared=manual['catalog_ref']
    first,refs=db.source()
    db.source([shared,refs[0]])
    db.settings(enabled=True,source_mode='selected',selected_top_refs=[first],album_mode='next')
    result=db.draw()
    assert result['catalog_ref']!=shared
    # Both source paths for an already active catalog are excluded before weight.
    db.remove_all(result['catalog_ref'])
    db.add()  # Open a retained manual membership to rotate the old bonus cycle.
    db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    db.settings(source_mode='all_active',selected_top_refs=[])
    assert db.draw()['catalog_ref']!=shared


def test_expiry_after_waiting_on_real_source_parent_rolls_back_before_randomness(bonus_db):
    db=bonus_db
    top,_=db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    reached=Event()
    def before(sql,params):
        if 'select * from app.album_lists' in sql and 'for share' in sql:
            reached.set()
    service=db.bounded_service(before=before,random=lambda bound:pytest.fail('Expired wait must not draw'))
    snapshot=(db.snapshot(),bonus_snapshot(db))
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute('select ref from app.album_lists where ref=%s for update',(top,))
            future=pool.submit(db.draw,service=service,command=command)
            assert reached.wait(3)
            db.now+=timedelta(days=2)
        assert_error(lambda:future.result(timeout=15),'source_context_unavailable',403)
    assert (db.snapshot(),bonus_snapshot(db))==snapshot


def test_viewer_grant_loss_during_parent_wait_is_not_admitted_from_stale_enumeration(bonus_db):
    db=bonus_db
    other=db.member(db.other_actor(),actions=(BROWSE,ACCESS))
    top,_=db.source(owner=other)
    granted=db.top_service.execute(db.context(other),normalize_top_command('grant_viewer',{
        'request_key':str(uuid4()),'revision':'1','account_id':db.owner.account_id,'role':'viewer'},top_ref=top))
    db.settings(enabled=True)
    command=db.draw_command()
    reached=Event()
    def before(sql,params):
        if 'select * from app.album_lists' in sql and 'for share' in sql:
            reached.set()
    service=db.bounded_service(before=before,random=lambda bound:pytest.fail('Revoked source must not draw'))
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.connect() as blocker:
            blocker.execute('select ref from app.album_lists where ref=%s for update',(top,))
            future=pool.submit(db.draw,service=service,command=command)
            assert reached.wait(3)
            blocker.execute('delete from app.album_list_access_grants where ref=%s',(granted['grant_ref'],))
        result=future.result(timeout=15)
    assert result['reason']=='no_eligible_source' and not result['changed']
    assert bonus_snapshot(db)['listening_goal_top_admissions']==[]


@pytest.mark.parametrize('mismatch',['account','catalog','mixed_kind'])
def test_typed_admission_constraints_reject_cross_account_catalog_or_mixed_provenance(bonus_db,mismatch):
    import psycopg
    db=bonus_db
    _,refs=db.source()
    db.settings(enabled=True,album_mode='next')
    drawn=db.draw()
    admission=bonus_snapshot(db)['listening_goal_top_admissions'][0]
    account,goal,catalog=db.owner.account_id,drawn['goal_ref'],refs[1]
    evidence_ref=evidence_version=None
    if mismatch=='account':
        other=db.other_actor()
        other_goal,_=db.add(actor=other)
        account,goal,catalog=other.account_id,other_goal['goal_ref'],refs[0]
    elif mismatch=='mixed_kind':
        evidence=db.acquire()
        evidence_ref,evidence_version=evidence['evidence_ref'],evidence['evidence_version']
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute('''insert into app.listening_goal_albums
                (account_id,goal_ref,catalog_ref,original_position,current_position,title,artist_display,
                 admitted_at,admission_kind,top_admission_ref,evidence_ref,evidence_version)
                values(%s,%s,%s,99,99,'Synthetic','Artist',%s,'album_top',%s,%s,%s)''',
                (account,goal,catalog,db.now,admission['ref'],evidence_ref,evidence_version))
    assert caught.value.sqlstate==('23514' if mismatch=='mixed_kind' else '23503')
    assert caught.value.diag.constraint_name==('listening_goal_admission_kind' if mismatch=='mixed_kind'
                                             else 'listening_goal_top_admission_fk')


def test_runtime_new_tables_are_private_and_append_only_except_current_exclusion(bonus_db):
    import psycopg
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    db.draw()
    tables=('listening_goal_top_admissions','listening_goal_bonus_draws','listening_goal_bonus_eligibility')
    with db.connect() as connection:
        for name in tables:
            for privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
                row=connection.execute('''select has_table_privilege('album_haven_app',%s,%s) as app,
                    has_table_privilege('album_haven_readonly',%s,%s) as readonly''',
                    ('app.'+name,privilege,'app.'+name,privilege)).fetchone()
                assert row=={'app':privilege in {'SELECT','INSERT'},'readonly':False}
    for name in tables:
        with pytest.raises(psycopg.Error) as caught:
            with db.connector()(db.app_url) as connection:
                connection.execute('delete from app.'+name+' where account_id=%s',(db.owner.account_id,))
        assert caught.value.sqlstate=='42501'


def test_forged_actor_session_pair_and_new_session_cannot_recover_saved_draw(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    receipt=db.draw(command=command)
    other=db.other_actor()
    for actor in (replace(db.owner,session_id=other.session_id),
                  replace(db.owner,account_id=other.account_id)):
        assert_error(lambda:db.draw(actor=actor,command=command),'forbidden',403)
    renewed=db.renewed_actor()
    assert_error(lambda:db.draw(actor=renewed,command=command),'operation_unavailable',404)
    assert db.draw(command=command)==receipt


def test_final_session_expiry_after_receipt_insert_rolls_back_draw(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    inserted=[]
    def after(sql,params):
        if sql.startswith('insert into app.listening_goal_operations'):
            inserted.append(True)
        if inserted and 'from app.account_sessions' in sql and 'for update' in sql:
            db.now+=timedelta(days=2)
    command=db.draw_command()
    before=(db.snapshot(),bonus_snapshot(db))
    assert_error(lambda:db.draw(service=db.bounded_service(after=after),command=command),
                 'source_context_unavailable',403)
    assert inserted==[True] and (db.snapshot(),bonus_snapshot(db))==before


def test_otherwise_valid_bonus_insert_into_closed_cycle_is_rejected(bonus_db):
    import psycopg
    db=bonus_db
    evidence=db.acquire()
    first,_=db.add(evidence)
    album=first['catalog_ref']
    old_cycle=first['cycle_id']
    db.service.execute(db.context(),db.reset_command(db.service.read(db.context())))
    db.remove_all(album)
    db.source([album])
    db.settings(enabled=True)
    drawn=db.draw()
    admission=bonus_snapshot(db)['listening_goal_top_admissions'][0]
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute('''insert into app.listening_goal_bonus_draws
                (account_id,goal_ref,cycle_id,catalog_ref,admission_ref,captured_at)
                values(%s,%s,%s,%s,%s,%s)''',
                (db.owner.account_id,drawn['goal_ref'],old_cycle,album,admission['ref'],db.now))
    assert caught.value.sqlstate=='23514'
    assert caught.value.diag.constraint_name=='listening_goal_bonus_current_week'


@pytest.mark.parametrize('stale',['settings','goal','cycle'])
def test_stale_draw_identity_rejected_before_entropy(bonus_db,stale):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    if stale=='settings':
        db.settings(album_mode='next')
        expected='settings_revision_conflict'
    elif stale=='goal':
        db.add()
        expected='revision_conflict'
    else:
        command=normalize_bonus_draw({**command.payload(),'expected_cycle_id':str(uuid4())})
        expected='stale_cycle'
    service=db.bounded_service(random=lambda bound:pytest.fail('Stale intent must not select'))
    before=bonus_snapshot(db)
    assert_error(lambda:db.draw(service=service,command=command),expected,409)
    assert bonus_snapshot(db)==before
    assert db.service.read_operation(db.context(),command.request_key)=={'status':'unknown'}


def test_saved_draw_key_rejects_changed_digest_without_reroll(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    receipt=db.draw(command=command)
    changed=normalize_bonus_draw({**command.payload(),'timezone_name':'Europe/Paris'})
    before=bonus_snapshot(db)
    assert_error(lambda:db.draw(command=changed),'idempotency_key_reused',409)
    assert bonus_snapshot(db)==before and db.draw(command=command)==receipt


def test_settings_change_between_phases_is_rechecked_before_selection(bonus_db):
    db=bonus_db
    db.source()
    db.settings(enabled=True)
    command=db.draw_command()
    phases=[]
    @contextmanager
    def connect(url):
        with db.connector()(url) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='10s'")
            yield connection
        phases.append(True)
        if len(phases)==1:
            db.settings(album_mode='next')
    service=PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL':db.app_url},
        connect=connect,clock=lambda:db.now,
        bonus_randbelow=lambda bound:pytest.fail('Settings changed before selection'))
    before=bonus_snapshot(db)
    assert_error(lambda:db.draw(service=service,command=command),'settings_revision_conflict',409)
    assert bonus_snapshot(db)==before
    assert db.service.read_operation(db.context(),command.request_key)=={'status':'unknown'}
