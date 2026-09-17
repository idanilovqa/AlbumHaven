from pathlib import Path
import re
root=Path.cwd()
helper='''\ndef _authorize_loop_fixture(monkeypatch):
    from music_app.services import current_actor_asgi
    from types import SimpleNamespace
    actor = SimpleNamespace(account_id=7, current_library_id=9, is_authenticated=True,
        library_relationships=(SimpleNamespace(library_id=9, membership_role="owner", is_primary_owner=True),))
    async def resolve_actor(_request): return actor
    monkeypatch.setattr(current_actor_asgi, "current_actor_from_request", resolve_actor)

'''
files={
 'tests/py/test_api_wave_b_asgi_routes.py':['test_asgi_loop_mutations_preserve_validation_and_create_side_effects','test_asgi_pitch_preview_uses_current_root_media_for_legacy_saved_loop_path','test_asgi_create_loop_from_saved_parent_uses_parent_metadata_and_media_path','test_asgi_delete_loop_returns_404_when_loop_dependency_reports_missing'],
 'tests/py/test_web_asgi_routes.py':['test_asgi_track_cover_and_loop_media_preserve_private_file_policy','test_asgi_saved_loop_media_uses_canonical_file_for_legacy_persisted_path'],
 'tests/py/test_playback_stream_asgi.py':['test_waveform_route_resolves_saved_loop_id_through_media_authority_and_bounded_registry','test_waveform_route_rejects_missing_or_invalid_saved_loop_id_without_starting_job']}
for filename,names in files.items():
 p=root/filename;s=p.read_text(encoding='utf-8-sig')
 for name in names:
  match=re.search(r'^def '+name+r'\([^]*',s) if False else re.search(r'^def '+name+r'\([\s\S]*?(?=\n(?:def |@)|\Z)',s,re.M)
  block=match.group(); header=re.search(r'\):\n',block).end();block=block[:header]+'    _authorize_loop_fixture(monkeypatch)\n'+block[header:]
  block=block.replace('lambda config, item:', 'lambda config, item, **scope:').replace('lambda config: list(persisted_loops)', 'lambda config, **scope: list(persisted_loops)').replace('lambda config, loop_id:', 'lambda config, loop_id, **scope:').replace('lambda _config:', 'lambda _config, **scope:')
  block=block.replace('end_seconds, loop_id):','end_seconds, loop_id, **scope):').replace('source_path, semitones):','source_path, semitones, **scope):').replace('loop_id: str):','loop_id: str, **scope):').replace('requested_id: str):','requested_id: str, **scope):')
  if filename.endswith('test_api_wave_b_asgi_routes.py') and ('mutations_preserve' in name or 'from_saved_parent' in name):
   insertion='''    from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter
    monkeypatch.setattr(SavedLoopsPostgresAdapter, "resolve_scoped_source", lambda self, **scope: (11, None))
    monkeypatch.setattr(asgi_routes, "probe_loop_source_duration", lambda path: 100)
'''
   anchor='    from music_app.routes import api_wave_b_asgi_routes as asgi_routes\n';block=block.replace(anchor,anchor+insertion)
   block=block.replace('assert payload["loop"]["cover_path"] == "C:/covers/parent.jpg"','assert payload["loop"]["cover_url"] == "/cover?loop_id=child-loop"\n    assert persisted_loops[0]["cover_path"] == "C:/covers/parent.jpg"')
  if 'pitch_preview_uses_current_root' in name:
   block=block.replace('lambda _config, **scope: [{"id": "legacy-loop", "path": str(legacy_loop)}]', 'lambda _config, **scope: [{"id": "legacy-loop", "path": str(canonical_loop)}]')
   anchor='    captured_sources = []';block=block.replace(anchor,'    monkeypatch.setattr("music_app.services.loops.SavedLoopsPostgresAdapter.is_unique_scoped_artifact", lambda self, **scope: True)\n\n'+anchor)
   block=block.replace(name,'test_asgi_pitch_preview_uses_owned_stored_legacy_artifact')
  if filename.endswith('test_web_asgi_routes.py'):
   block=block.replace('        def save_loops(self, loops):','        def load_scoped_loops(self, **scope):\n            assert scope == {"account_id": 7, "library_id": 9}\n            return list(persisted_loops)\n\n        def is_unique_scoped_artifact(self, **scope):\n            return True\n\n        def save_loops(self, loops):')
   block=block.replace('loop_previews_dir(app.config)', 'loop_previews_dir(app.config, account_id=7, library_id=9)')
   if 'canonical_file' in name:
    block=block.replace('save_loops(app.config, [{"id": "legacy-loop", "path": str(legacy_loop)}])','save_loops(app.config, [{"id": "legacy-loop", "path": str(canonical_loop)}])')
    block=block.replace(name,'test_asgi_saved_loop_media_uses_owned_stored_legacy_artifact')
  s=s[:match.start()]+block+s[match.end():]
 s+=helper
 p.write_text(s,encoding='utf-8')
