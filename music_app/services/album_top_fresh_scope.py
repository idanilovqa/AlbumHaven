"""Current permitted track scope for ordinary freshness, never a full edition.

Only used by the Top owner when full-edition admission cannot succeed. It shares
bounded capture accumulation but does not invent track order or admit siblings.
"""
from dataclasses import dataclass
import hashlib
import json
from music_app.services.playback_capture import CaptureError
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import require_private_action,PrivateLibraryAuthorityError


@dataclass(frozen=True)
class FreshTrackScope:
    album_id:int
    track_ids:tuple
    membership_revision:str
    canonical_membership:str


def current_fresh_track_scope(connection,live,key,constraints):
    albums=connection.execute('''select id from library.local_albums
        where library_id=%s and album_key=%s order by id limit 2 for share''',(live.library_id,key)).fetchall()
    if len(albums)!=1:raise CaptureError('source_unavailable',404)
    album_id=albums[0]['id']
    require_private_action(live,'library.browse.read',resource=ResourceScope('album',str(album_id)),constraints=constraints)
    rows=connection.execute('''select id,album_id,track_key,disc_number,track_number from library.local_tracks
        where library_id=%s and album_id=%s order by id limit 513 for share''',(live.library_id,album_id)).fetchall()
    if len(rows)>512:raise CaptureError('capture_unavailable',503)
    admitted=[]
    for row in rows:
        try:
            for action in ('library.browse.read','library.media.read'):
                require_private_action(live,action,resource=ResourceScope('track',str(row['id'])),constraints=constraints)
        except PrivateLibraryAuthorityError:
            continue
        admitted.append(row)
    if not admitted:raise CaptureError('source_unavailable',404)
    # Explicitly NOT the complete-edition selection serialization or digest.
    payload=json.dumps(dict(kind='permitted-track-freshness-v1',library_id=live.library_id,
        album_id=album_id,order_status='unavailable',members=[dict(track_id=row['id']) for row in admitted]),
        sort_keys=True,separators=(',',':'))
    return FreshTrackScope(album_id,tuple(row['id'] for row in admitted),
        hashlib.sha256(payload.encode()).hexdigest(),payload),admitted


def current_top_listening_scope(connection,live,key,constraints):
    from music_app.services.local_album_listening import _edition
    try:return _edition(connection,live,key,constraints)
    except PrivateLibraryAuthorityError:pass
    except CaptureError as error:
        if error.status not in (403,503):raise
    return current_fresh_track_scope(connection,live,key,constraints)
