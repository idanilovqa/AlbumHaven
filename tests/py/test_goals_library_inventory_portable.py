"""Inventory identity and transaction-local admission owner, no DB/bootstrap."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch,Mock
from music_app.services import local_album_catalog_admission as admission
from music_app.services.listening_goal_weekly_selection import WeeklyAlbum,WeeklySource,preview_week
from music_app.services.listening_goal_weekly_settings import default_weekly_settings
from music_app.services.owned_album_tops import AlbumTopError
class Result:
 def __init__(self,row=None):self.row=row
 def fetchone(self):return self.row
class Connection:
 def __init__(self,linked=None):self.linked=linked;self.sql=[]
 def execute(self,sql,params=()):
  self.sql.append((sql,params))
  if 'from library.local_albums' in sql:return Result({'title':'Album','artist_display':'Artist','release_year':2026})
  if 'select catalog_ref' in sql:return Result({'catalog_ref':self.linked} if self.linked else None)
  return Result()
class InventoryTests(unittest.TestCase):
 def test_unlinked_album_has_read_only_stable_preview_identity(self):
  album=WeeklyAlbum(None,'Album','Artist',2026,inventory_ref='inventory-album:3:4',inventory_album_id=4)
  settings={**default_weekly_settings(),'manual_count':0,'suggestion_count':1,'sources':['library']}
  picks=preview_week(settings,[WeeklySource('library',None,'Library',(album,))],usual_genres=(),randbelow=lambda n:0)
  self.assertEqual(len(picks),1);self.assertIsNone(picks[0].album.catalog_ref)
  self.assertEqual(picks[0].album.candidate_ref,'inventory-album:3:4')
 def test_real_source_reader_includes_unlinked_inventory_without_catalog_writes(self):
  from music_app.services import listening_goal_weekly_postgres as store
  queries=[]
  class Rows:
   def __init__(self,rows):self.rows=rows
   def fetchall(self):return self.rows
  class ReadConnection:
   def execute(self,sql,params=()):
    queries.append(sql)
    if 'select l.ref' in sql:return Rows([])
    if 'select a.id as local_album_id' in sql:return Rows([{'local_album_id':4,'catalog_ref':None,'title':'Real inventory','artist_display':'Artist','release_year':2026}])
    raise AssertionError(sql)
  live=SimpleNamespace(actor=SimpleNamespace(account_id=1),library_id=3)
  with patch.object(store,'allows',return_value=True),patch.object(store,'album_artwork_url',return_value='/library/album-artwork/inventory-album:3:4'):
   sources=store.read_sources(ReadConnection(),live,None,include_library=True)
  self.assertEqual(sources[0].albums[0].candidate_ref,'inventory-album:3:4')
  self.assertIsNone(sources[0].albums[0].catalog_ref)
  self.assertTrue(all(query.lstrip().startswith('select') for query in queries))

 def test_confirmation_binds_once_on_same_connection_with_browse_not_top_create(self):
  c=Connection();live=SimpleNamespace(library_id=3)
  with patch.object(admission,'require_private_action') as require:
   ref=admission.admit_local_album(c,live,4)
  self.assertEqual(len(ref),36)
  self.assertEqual(sum('insert into library.catalog_album_links' in sql for sql,_ in c.sql),1)
  self.assertTrue(all(call.args[1]=='library.browse.read' for call in require.call_args_list))
  self.assertTrue(any('for update of a' in sql for sql,_ in c.sql))
 def test_existing_link_reused_without_catalog_writes(self):
  c=Connection('existing')
  with patch.object(admission,'require_private_action'):
   self.assertEqual(admission.admit_local_album(c,SimpleNamespace(library_id=3),4),'existing')
  self.assertFalse(any('insert into' in sql for sql,_ in c.sql))
 def test_scope_witness_checked_after_album_lock_before_catalog_write(self):
  c=Connection()
  def witness():
   self.assertIn('for update of a',c.sql[-1][0]);raise AlbumTopError('scope_changed',409)
  with patch.object(admission,'require_private_action'),self.assertRaises(AlbumTopError):
   admission.admit_local_album(c,SimpleNamespace(library_id=3),4,validate_locked=witness)
  self.assertFalse(any('insert into' in sql for sql,_ in c.sql))
 def test_late_album_denial_is_not_hidden_by_existing_link(self):
  c=Connection('existing')
  with patch.object(admission,'require_private_action',side_effect=[None,None,AlbumTopError('forbidden',403)]):
   with self.assertRaises(AlbumTopError):admission.admit_local_album(c,SimpleNamespace(library_id=3),4)
 def test_invalid_inventory_identity_never_queries(self):
  c=Connection()
  with self.assertRaises(AlbumTopError):admission.admit_local_album(c,SimpleNamespace(library_id=3),True)
  self.assertEqual(c.sql,[])
if __name__=='__main__':unittest.main()
