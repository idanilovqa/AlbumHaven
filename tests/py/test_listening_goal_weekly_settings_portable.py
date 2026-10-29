"""Standalone pure contracts: run directly; no application bootstrap or database."""
import unittest
from datetime import datetime,timezone
from music_app.services import listening_goals as domain
from music_app.services.listening_goal_transition import transition_goal_period
from dataclasses import replace
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_weekly_settings import (
    default_weekly_settings, normalize_weekly_settings, matches_filter, manual_admission_allowed)
from music_app.services.listening_goal_weekly_selection import (
    WeeklyAlbum, WeeklySource, choose_weekly_suggestions, preview_week, nearly_finished)

A = WeeklyAlbum('a', 'First', 'Band', 2025, ('progressive rock',), 9)
B = WeeklyAlbum('b', 'Second', 'Band', 1974, ('world/folk',), 3)
C = WeeklyAlbum('c', 'Third', 'Band', 2020, ('metal',), 7)

def settings(**changes):
    return normalize_weekly_settings({**default_weekly_settings(), **changes})

class WeeklySettingsTests(unittest.TestCase):
    def test_defaults_are_detached_five_plus_one_and_random(self):
        one = default_weekly_settings(); one['sources'].clear()
        self.assertEqual(settings()['sources'], ['tops', 'playthroughs'])
        self.assertEqual((settings()['manual_count'], settings()['suggestion_count']), (5, 1))
        self.assertEqual(settings()['selection'], 'random')

    def test_invalid_counts_and_types(self):
        for change in ({'manual_count':7,'suggestion_count':1}, {'manual_count':True},
                {'suggestion_count':-1}, {'manual_count':0,'suggestion_count':0}, {'sources':[]},
                {'discover':1}, {'selection':'anything'}, {'sources':['tops','tops']}):
            with self.subTest(change=change), self.assertRaises(GoalsError): settings(**change)

    def test_boundary_year_inclusive_and_decade(self):
        for kind in ('newer','older','year'):
            self.assertTrue(matches_filter(A, {'kind':kind,'value':2025}))
        self.assertTrue(matches_filter(A, {'kind':'decade','value':2020}))
        self.assertFalse(matches_filter(A, {'kind':'older','value':2024}))
        self.assertFalse(matches_filter(replace(A, release_year=None), {'kind':'year','value':2025}))

    def test_maximum_is_not_quota_and_overlap_independent(self):
        config = settings(filters=[{'kind':'genre','value':' Progressive Rock ','maximum':1},
            {'kind':'newer','value':2020,'maximum':2}])
        self.assertTrue(manual_admission_allowed(config, [], B))
        self.assertFalse(manual_admission_allowed(config, [A], replace(A,catalog_ref='other')))
        self.assertTrue(manual_admission_allowed(config, [A], C))
        self.assertFalse(manual_admission_allowed(config, [A,C], replace(C,catalog_ref='other')))

    def test_filter_validation(self):
        for rule in ({'kind':'type','value':'studio','maximum':1}, {'kind':'newer','value':True,'maximum':1},
                     {'kind':'decade','value':2025,'maximum':1}, {'kind':'year','value':2020,'maximum':6}):
            with self.subTest(rule=rule), self.assertRaises(GoalsError): settings(filters=[rule])
        with self.assertRaises(GoalsError):
            settings(filters=[{'kind':'genre','value':'Rock','maximum':1},
                              {'kind':'genre','value':'rock','maximum':2}])

    def test_playthrough_never_skips_next_when_already_excluded(self):
        board=WeeklySource('playthroughs','p','Band',(A,B,C),frozenset({'a'}))
        picks,_=choose_weekly_suggestions(settings(),[board],usual_genres=(),excluded_refs={'b'},randbelow=lambda n:0)
        self.assertEqual(picks,())

    def test_two_slots_balance_familiar_playthrough_and_discovery_ignore_year(self):
        config=settings(manual_count=4,suggestion_count=2,discover=True,
            filters=[{'kind':'newer','value':2025,'maximum':3},{'kind':'genre','value':'progressive rock','maximum':3}])
        sources=[WeeklySource('playthroughs','p','Band',(A,C)),WeeklySource('tops','t','Top',(B,C))]
        picks,cursor=choose_weekly_suggestions(config,sources,usual_genres=('progressive rock',),randbelow=lambda n:0)
        self.assertEqual([p.album.catalog_ref for p in picks],['a','b'])
        self.assertEqual([p.objective for p in picks],['playthrough','discovery'])
        self.assertEqual(cursor,2)

    def test_one_slot_rotates_across_confirmed_weeks(self):
        sources=[WeeklySource('playthroughs','p','Band',(A,)),WeeklySource('tops','t','Top',(B,))]
        config=settings(discover=True)
        a,cursor=choose_weekly_suggestions(config,sources,usual_genres=('progressive rock',),randbelow=lambda n:0)
        b,_=choose_weekly_suggestions(config,sources,usual_genres=('progressive rock',),allocation_cursor=cursor,randbelow=lambda n:0)
        self.assertEqual((a[0].album.catalog_ref,b[0].album.catalog_ref),('a','b'))

    def test_relaxes_genre_year_but_keeps_source_and_popularity(self):
        config=settings(selection='popular',sources=['tops'], filters=[{'kind':'year','value':1920,'maximum':1}])
        sources=[WeeklySource('tops','t','Top',(B,C)),WeeklySource('library',None,'Library',(A,))]
        picks,_=choose_weekly_suggestions(config,sources,usual_genres=(),randbelow=lambda n:0)
        self.assertEqual(picks[0].album.catalog_ref,'c')

    def test_completed_album_cannot_reenter_through_another_selected_source(self):
        sources=[WeeklySource('tops','t','Top',(A,),frozenset({'a'})),
                 WeeklySource('library',None,'Library',(A,B))]
        config=settings(sources=['tops','library'])
        picks,_=choose_weekly_suggestions(config,sources,usual_genres=(),randbelow=lambda n:0)
        self.assertEqual([p.album.catalog_ref for p in picks],['b'])

    def test_default_category_equal_ticket_not_board_count(self):
        sources=[WeeklySource('tops',str(i),'Top',(B,)) for i in range(5)] + [WeeklySource('playthroughs','p','Band',(A,))]
        bounds=[]
        def random(n): bounds.append(n); return 0
        choose_weekly_suggestions(settings(),sources,usual_genres=(),randbelow=random)
        self.assertEqual(bounds[0],2)

    def test_preview_is_unique_bounded_and_represents_newer_boundary(self):
        config=settings(manual_count=2,suggestion_count=1,filters=[{'kind':'newer','value':2025,'maximum':1}])
        picks=preview_week(config,[WeeklySource('tops','t','Top',(A,B,C))],usual_genres=(),randbelow=lambda n:0)
        self.assertEqual(len({p.album.catalog_ref for p in picks}),len(picks))
        self.assertLessEqual(len(picks),3)
        self.assertIn(2025,[p.album.release_year for p in picks])

    def test_nearly_finished_approved_edges(self):
        albums=tuple(replace(A,catalog_ref=str(i)) for i in range(100))
        self.assertTrue(nearly_finished(WeeklySource('tops','t','Top',albums[:20],frozenset(str(i) for i in range(15)))))
        self.assertFalse(nearly_finished(WeeklySource('tops','t','Top',albums,frozenset(str(i) for i in range(75)))))
        self.assertTrue(nearly_finished(WeeklySource('tops','t','Top',albums,frozenset(str(i) for i in range(90)))))
        self.assertFalse(nearly_finished(WeeklySource('tops','t','Top',albums,frozenset(str(i) for i in range(100)))))

    def test_rollover_excludes_rating_progress_without_fabricating_manual_marks(self):
        state=domain.create_goal_state(top_ref='goals')
        for ref in ('rated','unplayed'):
            state=domain.add_goal(state,album_ref=ref,period='week',assignment_id='assignment-'+ref,
                occurred_at=datetime(2026,10,19,tzinfo=timezone.utc),timezone_name='UTC',
                cycle_ids={period:'cycle-'+period for period in domain.GOAL_PERIODS})['state']
        after=transition_goal_period(state,period='week',expected_cycle_id='cycle-week',new_cycle_id='next',
            occurred_at=datetime(2026,10,26,tzinfo=timezone.utc),timezone_name='UTC',viewer_ref='user',
            bonus_origin_refs=frozenset({'unplayed'}),captured_bonus_ref=None,unfinished_policy='carry',
            rated_refs=frozenset({'rated'}))
        self.assertEqual(after['periods']['week']['current']['album_refs'],['unplayed'])
        self.assertEqual(after['periods']['week']['history'][0]['completion'],{})

    def test_bad_entropy_rejected(self):
        with self.assertRaises(GoalsError):
            choose_weekly_suggestions(settings(),[WeeklySource('tops','t','Top',(A,))],usual_genres=(),randbelow=lambda n:True)

if __name__ == '__main__': unittest.main()
