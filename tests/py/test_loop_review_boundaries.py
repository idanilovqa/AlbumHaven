from pathlib import Path
from music_app.services import loops


def test_scoped_preview_checks_canonical_target_before_returning_file(tmp_path, monkeypatch):
    root=tmp_path/'loop_previews'/'account-7'/'library-9'
    root.mkdir(parents=True)
    preview=root/'same-id_pplus2.mp3'
    preview.write_bytes(b'preview-placeholder')
    outside=tmp_path/'foreign-account.mp3'
    outside.write_bytes(b'private')
    original_resolve=Path.resolve
    # Model the OS canonical target at the filesystem seam; this covers junction/
    # symlink escape without needing Windows symlink-creation privileges.
    def canonical(path, *args, **kwargs):
        if path==preview: return outside
        return original_resolve(path,*args,**kwargs)
    monkeypatch.setattr(Path,'resolve',canonical)
    monkeypatch.setattr(loops,'get_loop',lambda *_args,**_kwargs:{'id':'same-id'})
    assert loops.resolve_loop_preview_path({'DATA_DIR':tmp_path},'same-id_pplus2',account_id=7,library_id=9) is None

def test_scoped_source_without_cached_cover_uses_its_authorized_track_artwork(tmp_path, monkeypatch):
    from music_app.routes.api_loop_helpers import resolve_loop_creation_source
    from music_app.services.saved_loops_postgres import SavedLoopsPostgresAdapter
    source=(tmp_path/'owned.flac').resolve()
    monkeypatch.setattr(SavedLoopsPostgresAdapter,'resolve_scoped_source',lambda self,**scope:(11,None))
    calls=[]
    def cover(self,**scope):
        assert scope=={'account_id':7,'library_id':9,'track_id':11}
        calls.append(scope)
        return 'C:/owned/album/art.jpg'
    monkeypatch.setattr(SavedLoopsPostgresAdapter,'get_scoped_track_cover',cover,raising=False)
    result,error=resolve_loop_creation_source({'source_path':str(source),'start_seconds':0,'end_seconds':1,'cover_path':'C:/foreign/art.jpg'},
        config={},get_loop=lambda *_args:None,resolve_loop_media_path=lambda *_args:None,
        normalize_music_file_path=lambda _path:source,file_cache={},scope={'account_id':7,'library_id':9})
    assert error is None and calls
    assert result['cover_path']=='C:/owned/album/art.jpg'
