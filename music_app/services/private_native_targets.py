"""Existing native player/Album Details targets for proven library inventory IDs."""
from pathlib import Path

from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.policy import ResourceScope
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services import playlist_creation_sources_postgres as inventory


class NativeTargetError(ValueError):
    def __init__(self,code='item_unavailable',status_code=404):
        self.code,self.status_code=code,status_code
        super().__init__(code)


def allows(context,action,resource,constraints):
    try:
        require_private_action(context,action,resource=resource,constraints=constraints)
        return True
    except PrivateLibraryAuthorityError:
        return False


class PrivateNativeTargets:
    def __init__(self,config,*,media_resolver=None):
        self.config=config
        self.media_resolver=media_resolver or resolve_configured_media_path

    def resolve(self,connection,context,track_id,*,intent,constraints=None):
        if type(track_id) is not int or track_id<=0 or not isinstance(intent,str) or intent not in {'play','details'}:
            raise NativeTargetError('invalid_command',422)
        track=ResourceScope('track',str(track_id))
        if not allows(context,'library.browse.read',track,constraints):raise NativeTargetError('forbidden',403)
        if intent=='play' and not allows(context,'library.media.read',track,constraints):raise NativeTargetError('forbidden',403)
        rows=inventory.inventory_rows(connection,context.library_id,[track_id],lock=True,config=self.config)
        if track_id not in rows:raise NativeTargetError()
        row=rows[track_id]
        if intent=='details':
            album_id=row.get('original_album_id')
            if album_id is None:raise NativeTargetError()
            return self.resolve_album(connection,context,album_id,constraints=constraints)
        if row['availability']!='local':raise NativeTargetError()
        files=connection.execute('''select f.private_path,r.root_path from library.local_track_files f
            join library.library_roots r on r.id=f.library_root_id
            where f.track_id=%s and r.library_id=%s and r.is_active is true
              and f.scan_cache_stale is false order by f.id''',(track_id,context.library_id)).fetchall()
        return {**self._play_target(row,files),
            'inventory_track_ref':f'inventory-track:{context.library_id}:{track_id}'}

    def _play_target(self,row,files):
        for file in files:
            candidate=self.media_resolver(self.config,file['private_path'])
            if candidate is None:continue
            scoped=self.media_resolver(self.config,file['private_path'],configured_root_paths=(Path(file['root_path']),))
            if scoped is not None and candidate==scoped:
                path=str(candidate)
                return {'track_ref':path,'path':path,'title':row['title'],'artist':row['artist'],
                    'album_title':row['album_title'],'duration_seconds':row['duration_seconds']}
        raise NativeTargetError()

    def resolve_play_queue(self,connection,context,track_ids,*,constraints=None):
        # All candidates originate in the locked Playlist membership query. Batch
        # inventory and file reads, then retain per-resource media authorization.
        ids=sorted({identity for identity in track_ids if type(identity) is int and identity>0
            and all(allows(context,action,ResourceScope('track',str(identity)),constraints)
                for action in ('library.browse.read','library.media.read'))})
        if not ids:return {}
        rows=inventory.inventory_rows(connection,context.library_id,ids,lock=True,config=self.config)
        files=connection.execute('''select f.track_id,f.private_path,r.root_path from library.local_track_files f
            join library.library_roots r on r.id=f.library_root_id
            where f.track_id=any(%s) and r.library_id=%s and r.is_active is true
              and f.scan_cache_stale is false order by f.track_id,f.id''',(ids,context.library_id)).fetchall()
        by_track={}
        for file in files:by_track.setdefault(file['track_id'],[]).append(file)
        result={}
        for identity,row in rows.items():
            if row['availability']!='local':continue
            try:
                result[identity]={**self._play_target(row,by_track.get(identity,[])),
                    'inventory_track_ref':f'inventory-track:{context.library_id}:{identity}'}
            except NativeTargetError:pass
        return result

    def resolve_album(self,connection,context,album_id,*,constraints=None):
        if type(album_id) is not int or album_id<=0:raise NativeTargetError('invalid_command',422)
        resource=ResourceScope('album',str(album_id))
        if not allows(context,'library.browse.read',resource,constraints):raise NativeTargetError('forbidden',403)
        album=connection.execute('select id,album_key from library.local_albums where id=%s and library_id=%s for share',
            (album_id,context.library_id)).fetchone()
        if album is None or not album['album_key']:raise NativeTargetError()
        media=allows(context,'library.media.read',resource,constraints)
        if media:
            tracks=connection.execute('select id from library.local_tracks where library_id=%s and album_id=%s order by id',
                (context.library_id,album_id)).fetchall()
            media=bool(tracks) and all(allows(context,action,ResourceScope('track',str(item['id'])),constraints)
                for item in tracks for action in ('library.browse.read','library.media.read'))
        return {'album_ref':album['album_key'],'allowed_actions':{'can_view_details':True,'can_play_album':media}}
