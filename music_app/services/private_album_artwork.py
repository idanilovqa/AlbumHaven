"""ID-scoped existing Album artwork; no path enters the surface DTO."""
from datetime import datetime, timezone
from pathlib import Path
import re

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.capability_artwork import render_browse_artwork
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import current_library_transaction, require_private_action
from music_app.services.private_native_targets import allows, NativeTargetError

_REF=re.compile(r'inventory-album:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})\Z')


def album_artwork_url(context,album_id,*,constraints=None):
    if type(album_id) is not int or album_id<=0:return None
    resource=ResourceScope('album',str(album_id))
    if not all(allows(context,action,resource,constraints) for action in ('library.browse.read','library.artwork.read')):
        return None
    return f'/library/album-artwork/inventory-album:{context.library_id}:{album_id}'


class PrivateAlbumArtwork:
    def __init__(self,config,*,connect=None,clock=None,resolver=None,renderer=None):
        self.config=config
        self.url=str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        self.connect,self.clock=connect,clock
        self.resolver=resolver or resolve_configured_media_path
        self.renderer=renderer or render_browse_artwork

    def read(self,context,album_ref,*,constraints=None):
        match=_REF.fullmatch(album_ref) if isinstance(album_ref,str) else None
        if match is None:raise NativeTargetError('invalid_command',422)
        library,album_id=map(int,match.groups())
        if library!=context.library_id or max(library,album_id)>9223372036854775807:
            raise NativeTargetError('item_unavailable',404)
        with current_library_transaction(self.url,context,constraints=constraints,connect=self.connect,
                clock=self.clock,read_only=True) as (connection,live,_now):
            resource=ResourceScope('album',str(album_id))
            for action in ('library.browse.read','library.artwork.read'):
                require_private_action(live,action,resource=resource,constraints=constraints)
            album=connection.execute('select cover_path from library.local_albums where id=%s and library_id=%s for share',
                (album_id,library)).fetchone()
            if album is None or not album['cover_path']:raise NativeTargetError('item_unavailable',404)
            roots=connection.execute('select root_path from library.library_roots where library_id=%s and is_active is true order by id for share',
                (library,)).fetchall()
            if not roots:raise NativeTargetError('item_unavailable',404)
            path=self.resolver(self.config,album['cover_path'])
            scoped=self.resolver(self.config,album['cover_path'],configured_root_paths=tuple(Path(row['root_path']) for row in roots))
            if path is None or path!=scoped:raise NativeTargetError('item_unavailable',404)
            response=self.renderer(path)
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=self.clock or (lambda:datetime.now(timezone.utc)))
            return response
