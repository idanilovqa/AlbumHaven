"""Transaction-owner orchestration doubles: no database, provider, or app startup."""
import unittest
from contextlib import ExitStack
from datetime import datetime,timezone
from types import SimpleNamespace
from unittest.mock import patch,Mock

from music_app.services import listening_goals as domain
from music_app.services import listening_goal_weekly_draw as draw
from music_app.services import listening_goal_rating_progress as rating
from music_app.services import listening_goal_weekly_postgres as store
from music_app.services.listening_goal_membership_sources import sync_sources
from music_app.services.listening_goal_weekly_settings import default_weekly_settings
from music_app.services.listening_goal_weekly_selection import WeeklyAlbum,WeeklyPick
from music_app.services.listening_goals_commands import GoalsError

REFS=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']
NOW=datetime(2026,10,26,tzinfo=timezone.utc)
class Result:
    def __init__(self,rows=()):self.rows=rows
    def fetchall(self):return self.rows
    def fetchone(self):return self.rows[0] if self.rows else None
class Connection:
    def __init__(self):self.sql=[]
    def execute(self,sql,params=()):self.sql.append((sql,params));return Result()
class DrawTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.connection=Connection();self.live=SimpleNamespace(actor=SimpleNamespace(account_id=1,session_id=2),library_id=3)
        self.state=domain.create_goal_state(top_ref='20000000-0000-4000-8000-000000000001')
        self.service=SimpleNamespace(_load=Mock(return_value=(None,self.state,[])),_persist=Mock(),_clock=lambda:NOW,_bonus_randbelow=lambda n:0)
        self.settings={**default_weekly_settings(),'manual_count':5,'suggestion_count':2}
        self.stack.enter_context(patch.object(store,'read_settings',return_value={'settings_revision':'1','settings':self.settings,'allocation_cursor':4}))
        self.stack.enter_context(patch.object(store,'read_sources',return_value=()))
        self.stack.enter_context(patch.object(store.metadata,'enrich_sources',return_value=((),frozenset({'metal'}),{})))
        self.stack.enter_context(patch.object(draw.Tops,'_top',return_value={'ref':'top'}))
        self.stack.enter_context(patch.object(draw.Tops,'_require'))
        self.picks=tuple(WeeklyPick(WeeklyAlbum(ref,'Title','Artist',2025),'tops','30000000-0000-4000-8000-000000000001',True,'preferences') for ref in REFS)
        self.choose=self.stack.enter_context(patch.object(draw,'choose_weekly_suggestions',return_value=(self.picks,6)))
        self.admit=self.stack.enter_context(patch.object(draw,'_admit',side_effect=lambda c,l,p,r,n,x:draw.WeeklyAdmission(p.album.catalog_ref,p.album.catalog_ref,'Title','Artist','2025')))
        self.captured=self.stack.enter_context(patch.object(draw,'cycle_draws',return_value=[]))
        self.stack.enter_context(patch.object(draw,'cycle_bonus',return_value=None))
        self.stack.enter_context(patch.object(draw,'lock_current_actor_session',return_value=NOW))
        self.command=draw.WeeklyDrawCommand('40000000-0000-4000-8000-000000000001','1','1',None,'UTC')
    def call(self):return draw._draw(self.service,self.connection,self.live,self.command,NOW,None)
    def test_two_picks_one_revision_one_atomic_persist_and_cursor(self):
        result=self.call()
        self.assertEqual(result['catalog_refs'],REFS);self.assertEqual(result['revision'],'2')
        self.assertTrue(result['changed']);self.service._persist.assert_called_once()
        self.assertEqual(self.choose.call_args.kwargs['usual_genres'],frozenset({'metal'}))
        args=self.service._persist.call_args
        self.assertEqual(len(args.kwargs['weekly_admissions']),2)
        for period in domain.GOAL_PERIODS:self.assertEqual(args.args[3]['periods'][period]['current']['album_refs'],REFS)
        updates=[params for sql,params in self.connection.sql if 'insert into app.listening_goal_weekly_settings' in sql]
        self.assertEqual(len(updates),1);self.assertEqual(updates[0][3],6)
        self.assertEqual(sum('insert into app.listening_goal_weekly_draws' in sql for sql,_ in self.connection.sql),2)
    def test_existing_draw_does_not_reroll_or_advance_cursor(self):
        self.captured.return_value=[{'catalog_ref':REFS[0]}]
        result=self.call()
        self.assertFalse(result['changed']);self.assertEqual(result['reason'],'already_drawn');self.assertEqual(result['catalog_refs'],[])
        self.choose.assert_not_called();self.service._persist.assert_not_called()
        self.assertFalse(any('weekly_settings' in sql for sql,_ in self.connection.sql))
    def test_exhausted_sources_do_not_advance_cursor(self):
        self.choose.return_value=((),4)
        result=self.call();self.assertEqual(result['reason'],'no_eligible_source')
        self.admit.assert_not_called();self.service._persist.assert_not_called()
        self.assertFalse(any('weekly_settings' in sql for sql,_ in self.connection.sql))
    def test_zero_suggestion_slots_do_not_select(self):
        self.settings['suggestion_count']=0
        self.assertEqual(self.call()['reason'],'no_suggestion_slots');self.choose.assert_not_called()
    def test_revision_conflict_never_selects(self):
        self.service._load.return_value=({'revision':2},self.state,[])
        with self.assertRaisesRegex(GoalsError,'revision_conflict'):self.call()
        self.choose.assert_not_called()

class RatingConnection(Connection):
    def __init__(self,event=True):super().__init__();self.event=event
    def execute(self,sql,params=()):
        self.sql.append((sql,params))
        if 'to_regclass' in sql:return Result([{'ready':True}])
        if 'from library.catalog_album_links' in sql:return Result([{'catalog_ref':REFS[0]}])
        if 'select rs.admission_ref' in sql:return Result([{'admission_ref':'admission'}])
        if 'select c.goal_ref' in sql:return Result([{'goal_ref':'goal','cycle_id':'cycle','position':1}])
        if 'insert into app.listening_goal_rating_progress' in sql:return Result([{'catalog_ref':REFS[0]}] if self.event else [])
        if 'update app.listening_goals' in sql:return Result([{'revision':2}])
        raise AssertionError(sql)
class RatingTests(unittest.TestCase):
    def setUp(self):
        mocked=patch.object(rating,'require_goal_write');mocked.start();self.addCleanup(mocked.stop)
    def test_rating_records_goal_progress_not_top_or_manual_completion(self):
        connection=RatingConnection();live=SimpleNamespace(actor=SimpleNamespace(account_id=1),library_id=3)
        with patch.object(rating,'has_active_top',return_value=False):rating.record_rating(connection,live,4,5,6)
        writes=[sql for sql,_ in connection.sql if 'insert into' in sql or 'update ' in sql]
        self.assertEqual(len(writes),2)
        self.assertFalse(any('album_list_item_progress' in sql or 'manual_completed_at' in sql for sql in writes))
    def test_qualifying_library_rating_advances_all_current_periods_without_changing_sources(self):
        class MixedConnection(RatingConnection):
            def execute(self,sql,params=()):
                if 'select c.goal_ref' in sql:
                    self.sql.append((sql,params))
                    return Result([{'goal_ref':'goal','cycle_id':period,'position':index+1}
                                   for index,period in enumerate(('week','month','six-months','year'))])
                return super().execute(sql,params)
        connection=MixedConnection();live=SimpleNamespace(actor=SimpleNamespace(account_id=1),library_id=3)
        with patch.object(rating,'has_active_top',return_value=False):rating.record_rating(connection,live,4,5,6)
        events=[params for sql,params in connection.sql if 'insert into app.listening_goal_rating_progress' in sql]
        self.assertEqual([params[2] for params in events],['week','month','six-months','year'])
        self.assertEqual([params[5] for params in events],[1,2,3,4])
        self.assertFalse(any(('update app.listening_goal_cycle_sources' in sql or 'manual_completed_at=' in sql) for sql,_ in connection.sql))
        self.assertEqual(sum('update app.listening_goals' in sql for sql,_ in connection.sql),1)

    def test_existing_rating_event_is_idempotent(self):
        connection=RatingConnection(event=False);live=SimpleNamespace(actor=SimpleNamespace(account_id=1),library_id=3)
        with patch.object(rating,'has_active_top',return_value=False):rating.record_rating(connection,live,4,5,6)
        self.assertFalse(any('update app.listening_goals' in sql for sql,_ in connection.sql))
    def test_album_with_active_top_does_not_gain_library_rating_progress(self):
        connection=RatingConnection();live=SimpleNamespace(actor=SimpleNamespace(account_id=1),library_id=3)
        with patch.object(rating,'has_active_top',return_value=True):rating.record_rating(connection,live,4,5,6)
        self.assertFalse(any('insert into' in sql for sql,_ in connection.sql))
    def test_rating_overlay_preserves_manual_marks_and_counts_union(self):
        connection=Connection();connection.execute=lambda sql,params:Result([{'cycle_id':'cycle','catalog_ref':REFS[0],'rated_at':NOW}])
        periods={'week':{'cycle':{'cycle_id':'cycle'},'album_refs':REFS,'manual_completed_at':{REFS[0]:None,REFS[1]:'manual'},'total':2}}
        with patch.object(rating,'storage_ready',return_value=True):rating.overlay(connection,SimpleNamespace(actor=SimpleNamespace(account_id=1)),periods,[])
        self.assertIsNone(periods['week']['manual_completed_at'][REFS[0]])
        self.assertEqual(periods['week']['completed'],2)
        self.assertEqual(periods['week']['rated_at'][REFS[0]],NOW.isoformat())

class MembershipSourceTests(unittest.TestCase):
    def state(self,cycle,members):
        return {'top_ref':'goal','periods':{'week':{'current':{'cycle_id':cycle,'album_refs':members}}}}
    def test_new_library_draw_uses_current_admission_not_lifetime_origin(self):
        connection=Connection()
        sync_sources(connection,1,self.state('week',[]),self.state('week',['album']),
                     [SimpleNamespace(catalog_ref='album',ref='new-library-admission')])
        params=[p for sql,p in connection.sql if 'insert into' in sql][0]
        self.assertEqual(params[-1],'new-library-admission')
    def test_manual_readmission_does_not_reuse_old_rating_source(self):
        connection=Connection()
        sync_sources(connection,1,self.state('week',[]),self.state('week',['album']),[])
        self.assertTrue(any('delete from' in sql for sql,_ in connection.sql))
        self.assertFalse(any('insert into' in sql for sql,_ in connection.sql))
    def test_new_cycle_carries_source_without_copying_rating_event(self):
        connection=Connection()
        def execute(sql,params=()):
            connection.sql.append((sql,params))
            return Result([{'cycle_id':'old','catalog_ref':'album','admission_ref':'source'}]) if sql.lstrip().startswith('select') else Result()
        connection.execute=execute
        sync_sources(connection,1,self.state('old',['album']),self.state('new',['album']),[])
        inserts=[p for sql,p in connection.sql if 'insert into' in sql]
        self.assertEqual(inserts,[ (1,'goal','new','album','source') ])
        self.assertFalse(any('rating_progress' in sql for sql,_ in connection.sql))
    def test_reset_preserves_draw_provenance_without_cursor_update(self):
        connection=Connection()
        draw.retain_after_reset(connection,1,self.state('old',['album']),self.state('new',['album']),NOW)
        self.assertEqual(len(connection.sql),1)
        self.assertIn('insert into app.listening_goal_weekly_draws',connection.sql[0][0])
        self.assertNotIn('allocation_cursor=',connection.sql[0][0])

if __name__=='__main__':unittest.main()
