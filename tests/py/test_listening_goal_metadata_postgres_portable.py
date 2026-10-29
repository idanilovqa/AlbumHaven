"""Metadata transaction seam doubles, not a database integration claim."""
import unittest
from contextlib import ExitStack
from datetime import datetime,timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from music_app.services import listening_goal_metadata_postgres as store
from music_app.services.listening_goal_weekly_selection import WeeklyAlbum,WeeklySource
from music_app.services.listening_goals_commands import GoalsError

NOW=datetime(2026,10,26,tzinfo=timezone.utc)
class Result:
 def __init__(self,rows):self.rows=rows
 def fetchall(self):return self.rows
 def fetchone(self):return next(iter(self.rows),None)
class Connection:
 autocommit=False
 def __init__(self):self.sql=[];self.history=[]
 def execute(self,sql,params=()):
  self.sql.append((sql,params))
  if 'select a.id,l.catalog_ref' in sql:return Result([{'id':i,'catalog_ref':f'catalog-{i}'} for i in range(1,6)])
  if 'select local_album_id,catalog_ref' in sql:return Result([{'local_album_id':i,'catalog_ref':f'catalog-{i}'} for i in range(1,6)])
  if 'select id,album_id,duration_seconds' in sql:return Result([{'id':i,'album_id':i,'duration_seconds':200} for i in range(1,6)])
  if 'from integration.listen_history' in sql:return Result(self.history)
  raise AssertionError(sql)
class Tests(unittest.TestCase):
 def setUp(self):
  self.stack=ExitStack();self.addCleanup(self.stack.close)
  self.live=NS(actor=NS(account_id=7),library_id=3)
  self.connection=Connection()
  self.stack.enter_context(patch.object(store,'pin_context',return_value=self.live))
  self.allowed=self.stack.enter_context(patch.object(store,'_allowed',return_value=True))
  self.fence=self.stack.enter_context(patch.object(store,'require_private_action'))
  self.tags=self.stack.enter_context(patch.object(store,'_styles',return_value={i:(frozenset({'genre-tag:Prog Rock'}),'known') for i in range(1,6)}))
  self.inventory=self.stack.enter_context(patch.object(store,'read_inventory',return_value=[]))
  self.prefs=self.stack.enter_context(patch.object(store,'load_album_preferences_on_connection',return_value={}))
 def load(self,**kw):return store.load_evidence(self.connection,self.live,None,now=NOW,**kw)
 def test_real_tag_aliases_and_unknown_popularity(self):
  facts,usual,evidence=self.load()
  self.assertEqual(facts[1]['genres'],('progressive rock',));self.assertIsNone(facts[1]['popularity'])
  self.assertFalse(usual);self.assertEqual(evidence['taste_state'],'unknown')
  self.assertEqual(self.tags.call_args.args[1],3)
 def test_actual_duration_boundary_and_own_scope(self):
  self.connection.history=[{'track_id':i,'measured_listened_seconds':100} for i in range(1,6)]
  _,usual,evidence=self.load();self.assertEqual(usual,frozenset({'progressive rock'}))
  query,params=next((s,p) for s,p in self.connection.sql if 'from integration.listen_history' in s)
  self.assertEqual(params[:2],(7,3));self.assertIn('h.finalized is true',query)
  self.assertEqual((params[3]-params[2]).days,90)
 def test_skips_and_foreign_identity_do_not_establish_profile(self):
  self.connection.history=[{'track_id':i,'measured_listened_seconds':99} for i in range(1,6)]+[{'track_id':999,'measured_listened_seconds':999}]
  self.assertFalse(self.load()[1])
 def test_positive_own_preferences_are_explicit_seeds(self):
  self.prefs.return_value={i:{'rating':7,'favorite':False} for i in range(1,6)}
  self.assertEqual(self.load()[1],frozenset({'progressive rock'}))
  self.assertEqual(self.prefs.call_args.kwargs['account_id'],7)
 def test_low_ratings_not_liked_style_and_no_filter_input(self):
  self.prefs.return_value={i:{'rating':3,'favorite':False} for i in range(1,6)}
  self.assertFalse(self.load()[1])
 def test_late_resource_denial_fails_instead_of_leaking_profile(self):
  self.allowed.side_effect=lambda live,kind,i,c:self.fence.call_count==0
  with self.assertRaises(GoalsError) as error:self.load()
  self.assertEqual(error.exception.status,403)
 def test_metadata_only_source_stays_unknown_no_fabricated_native_identity(self):
  sources=(WeeklySource('tops','top','Top',(WeeklyAlbum('remote','Remote','Artist'),)),)
  enriched,_,_=store.enrich_sources(self.connection,self.live,None,sources,now=NOW)
  self.assertEqual(enriched[0].albums[0].genres,());self.assertIsNone(enriched[0].albums[0].popularity)
  self.assertIsNone(enriched[0].albums[0].inventory_album_id)
 def test_cached_mapping_normalizer_is_required(self):
  self.inventory.return_value=[{'original_local_track_id':1,'original_album_id':1}]
  cached=NS(observation=NS(attribution_state='resolved',provider='lastfm',source_entity_id='entity',count=42))
  with patch.object(store,'normalize_cached_inventory_row',return_value=(NS(),cached,None)) as normalize:
   facts,_,evidence=self.load(profile=False)
  normalize.assert_called_once();self.assertEqual(facts[1]['popularity'],42)
  self.assertEqual(evidence['popularity_source'],'median_cached_track_scrobbles_proxy')
 def test_reparented_inventory_is_not_credited_to_prior_album(self):
  self.inventory.return_value=[{'original_local_track_id':1,'original_album_id':2}]
  with self.assertRaises(GoalsError) as error:self.load(profile=False)
  self.assertEqual(error.exception.code,'weekly_metadata_changed')
 def test_invalid_or_unresolved_cached_mapping_is_unknown(self):
  self.inventory.return_value=[{'original_local_track_id':1,'original_album_id':1}]
  with patch.object(store,'normalize_cached_inventory_row',side_effect=ValueError):
   self.assertIsNone(self.load(profile=False)[0][1]['popularity'])
 def test_explicit_bound_no_silent_truncation(self):
  with patch.object(store,'MAX_ALBUMS',4):
   with self.assertRaises(GoalsError):self.load()
 def test_disabled_profile_and_popularity_do_not_read_those_sources(self):
  self.load(profile=False,popularity=False)
  self.inventory.assert_not_called();self.prefs.assert_not_called()
  self.assertFalse(any('listen_history' in q for q,p in self.connection.sql))
class PinTests(unittest.TestCase):
 def context(self,library=3,target=None):
  from music_app.services.current_actor import CurrentActor,ActorState
  from music_app.services.policy import PolicyContext
  return PolicyContext(actor=CurrentActor(ActorState.ACTIVE,account_id=7,session_id=2,current_library_id=library),
   action='account.self.goals.read',target_account_id=target,resource=None,library_id=None,
   deployment_mode='local',request_origin=None,client_surface_class='web')
 def test_no_selected_library_is_unknown_without_sql(self):
  connection=Connection()
  self.assertIsNone(store.pin_context(connection,self.context(None),None));self.assertFalse(connection.sql)
 def test_foreign_subject_is_not_silently_rebound(self):
  with self.assertRaises(GoalsError):store.pin_context(Connection(),self.context(target=8),None)
 def test_missing_current_membership_is_unknown(self):
  connection=NS(execute=lambda *args:Result([]))
  self.assertIsNone(store.pin_context(connection,self.context(),None))
 def test_membership_and_grants_are_fresh_locked_rows(self):
  calls=[]
  def execute(sql,params):
   calls.append((sql,params))
   return Result([{'membership_role':'member','is_primary_owner':False}]) if 'library_memberships' in sql else Result([])
  with patch.object(store,'allows',return_value=True):live=store.pin_context(NS(execute=execute),self.context(),None)
  self.assertEqual(live.actor.library_relationships[0].library_id,3)
  self.assertEqual(live.actor.capability_grants,());self.assertIsNone(live.target_account_id)
  self.assertTrue(all('for share' in sql for sql,p in calls))
class AdmissionTests(unittest.TestCase):
 def test_mapped_parent_cap_and_unknown_are_not_confused(self):
  from music_app.services import listening_goal_weekly_postgres as weekly
  from music_app.services.listening_goal_weekly_settings import default_weekly_settings
  from dataclasses import replace
  config={**default_weekly_settings(),'filters':[{'kind':'genre','value':'progressive rock','maximum':1}]}
  class Canonical:
   def execute(self,*args):return Result([{'catalog_ref':i,'title':i,'artist_display':'Artist','release_year':2020} for i in ('a','b')])
  def enrich(c,l,x,sources,**kw):
   return (replace(sources[0],albums=tuple(replace(a,genres=('progressive rock',)) for a in sources[0].albums)),),frozenset(),{}
  with patch.object(weekly,'read_settings',return_value={'settings':config}),patch.object(weekly.metadata,'enrich_sources',side_effect=enrich):
   with self.assertRaises(GoalsError) as error:weekly.require_manual_admission(Canonical(),7,['a'],'b',context=NS(),now=NOW)
   self.assertEqual(error.exception.code,'weekly_capacity')
  with patch.object(weekly,'read_settings',return_value={'settings':config}),patch.object(weekly.metadata,'enrich_sources',side_effect=lambda c,l,x,s,**kw:(s,frozenset(),{})):
   weekly.require_manual_admission(Canonical(),7,['a'],'b',context=NS(),now=NOW)
 def test_bootstrap_authority_is_refreshed_not_erased(self):
  context=PinTests().context()
  def execute(sql,params):
   if 'library_memberships' in sql:return Result([{'membership_role':'member','is_primary_owner':False}])
   if 'bootstrap_owners' in sql:return Result([{'account_id':7}])
   return Result([])
  with patch.object(store,'allows',side_effect=lambda ctx,*args:ctx.actor.is_bootstrap_owner):
   self.assertTrue(store.pin_context(NS(execute=execute),context,None).actor.is_bootstrap_owner)
if __name__=='__main__':unittest.main()
