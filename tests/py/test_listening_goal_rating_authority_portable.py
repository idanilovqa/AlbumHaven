"""Final mutation fences and locked eligibility, no database startup."""
import unittest
from contextlib import contextmanager,ExitStack
from types import SimpleNamespace
from dataclasses import dataclass
from unittest.mock import patch
from music_app.services import listening_goal_rating_progress as rating
from music_app.services import album_preferences_postgres as preferences
from music_app.services.album_preferences import AlbumPreferenceCommand,AlbumPreferenceError
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.listening_goals_commands import GoalsError
class Result:
 def __init__(self,rows=()):self.rows=rows
 def fetchone(self):return self.rows[0] if self.rows else None
 def fetchall(self):return self.rows
class HookConnection:
 def __init__(self):self.writes=[]
 def execute(self,sql,params=()):
  if 'to_regclass' in sql:return Result([{'ready':True}])
  if 'from library.catalog_album_links' in sql:return Result([{'catalog_ref':'album'}])
  if 'select rs.admission_ref' in sql:return Result([{'admission_ref':'admission'}])
  if 'select c.goal_ref' in sql:return Result([{'goal_ref':'goal','cycle_id':'cycle','position':1}])
  self.writes.append(sql)
  if 'returning catalog_ref' in sql:return Result([{'catalog_ref':'album'}])
  if 'returning revision' in sql:return Result([{'revision':2}])
  raise AssertionError(sql)
@dataclass(frozen=True)
class Context:
 actor:object
 library_id:int=3
 target_account_id:int=1
class RatingAuthorityTests(unittest.TestCase):
 def live(self):return Context(SimpleNamespace(account_id=1,session_id=2))
 def test_denied_at_entry_skips_without_writes(self):
  c=HookConnection()
  with patch.object(rating,'require_goal_write',side_effect=AlbumTopError('forbidden',403)):
   self.assertIsNone(rating.record_rating(c,self.live(),4,5,1))
  self.assertEqual(c.writes,[])
 def test_late_goal_denial_raises_for_outer_rollback(self):
  c=HookConnection()
  with patch.object(rating,'require_goal_write',side_effect=[None,AlbumTopError('forbidden',403)]),patch.object(rating,'has_active_top',return_value=False):
   with self.assertRaisesRegex(GoalsError,'forbidden'):rating.record_rating(c,self.live(),4,5,1)
  self.assertTrue(any('insert into' in sql for sql in c.writes))
 def test_new_active_top_during_hook_rolls_back(self):
  c=HookConnection()
  with patch.object(rating,'require_goal_write'),patch.object(rating,'has_active_top',side_effect=[False,True]):
   with self.assertRaisesRegex(GoalsError,'goal_source_changed'):rating.record_rating(c,self.live(),4,5,1)
 def test_rating_owner_rechecks_manage_after_hook(self):
  c=SimpleNamespace(execute=lambda sql,params:Result([{'id':5,'rating':1,'favorite':False,'provenance':'personal_rating','preference_revision':1}]))
  state={'album_key':'key','preference_id':5,'preference_revision':2};retired=[False]
  @contextmanager
  def transaction(*a,**k):yield c,self.live(),None
  def require(*a):
   if retired[0]:raise AlbumPreferenceError('forbidden',403)
  def hook(*a,**k):retired[0]=True;return True
  with ExitStack() as stack:
   for name,value in (('current_library_transaction',transaction),('_transaction_required',lambda c:None),('_lock_sources',lambda *a,**k:({},[])),('_read_locked',lambda *a,**k:{4:state}),('_require_manage',require),('lock_current_actor_session',lambda *a,**k:None)):
    stack.enter_context(patch.object(preferences,name,value))
   stack.enter_context(patch.object(rating,'record_rating',hook))
   store=preferences.PostgresAlbumPreferencesStore({'ALBUM_HAVEN_APP_DATABASE_URL':'unit-double'})
   with self.assertRaisesRegex(AlbumPreferenceError,'forbidden'):
    store.patch_preference(AlbumPreferenceCommand(3,4,1,{'rating':2}),context=self.live())
 def test_discovered_membership_rechecked_under_parent_lock(self):
  calls=[]
  class Connection:
   def execute(self,sql,params=()):
    calls.append(sql)
    return Result([{'ref':'top','library_id':3}]) if 'select l.ref' in sql else Result([])
  with patch.object(rating,'collection_member_context',return_value=self.live()),patch.object(rating.Tops,'_top',return_value={'ref':'top'}) as top,patch.object(rating,'require_goal_top_progress') as authority:
   self.assertFalse(rating.has_active_top(Connection(),self.live(),'album',None))
   top.assert_called_once();authority.assert_not_called()
  self.assertTrue(any('for share' in sql for sql in calls))
 def test_reserved_deleted_owner_rejection_preserved(self):
  c=SimpleNamespace(execute=lambda *a:Result([{'ref':'top','library_id':3}]))
  with patch.object(rating,'collection_member_context',return_value=self.live()),patch.object(rating.Tops,'_top',side_effect=AlbumTopError('top_unavailable',404)):
   self.assertFalse(rating.has_active_top(c,self.live(),'album',None))
if __name__=='__main__':unittest.main()
