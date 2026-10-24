"""Private native-only targets for authorized persisted Playlist occurrences."""
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import BROWSE, PlaylistError, uuid_ref, playlist_revision
from music_app.services.private_native_targets import PrivateNativeTargets, NativeTargetError


class PlaylistNativeTargets:
    def __init__(self,config,*,playlists,media_resolver=None):
        self._playlists=playlists
        self._targets=PrivateNativeTargets(config,media_resolver=media_resolver)

    def resolve(self,context,*,playlist_ref,item_ref,intent,constraints=None):
        playlist_ref,item_ref=uuid_ref(playlist_ref),uuid_ref(item_ref)
        if not isinstance(intent,str) or intent not in {'play','details'}:raise PlaylistError('invalid_command')
        owner=self._playlists
        with owner._authorized(context,constraints) as (connection,live,_now):
            playlist=owner._playlist(connection,live,playlist_ref)
            owner._require(live,(BROWSE,),constraints,playlist)
            item=connection.execute('''select ref,local_track_id from app.playlist_items
                where playlist_ref=%s and library_id=%s and ref=%s for share''',
                (playlist_ref,live.library_id,item_ref)).fetchone()
            if item is None or item['local_track_id'] is None:raise PlaylistError('item_unavailable',404)
            try:
                target=self._targets.resolve(connection,live,item['local_track_id'],intent=intent,constraints=constraints)
            except NativeTargetError as error:
                raise PlaylistError(error.code,error.status_code) from None
            if intent=='play':target['playlist_item_id']=item_ref
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=owner._clock)
            return {'playlist_id':playlist_ref,'playlist_item_id':item_ref,'revision':str(playlist['revision']),
                'intent':intent,'native_target':target}

    def queue(self,context,*,playlist_ref,revision,item_refs,starting_item_ref,constraints=None):
        playlist_ref=uuid_ref(playlist_ref)
        revision=playlist_revision(revision)
        if not isinstance(item_refs,list) or not 1<=len(item_refs)<=5000:
            raise PlaylistError('invalid_command')
        refs=[uuid_ref(ref) for ref in item_refs]
        starting_item_ref=uuid_ref(starting_item_ref)
        if len(set(refs))!=len(refs) or starting_item_ref not in refs:
            raise PlaylistError('invalid_command')
        owner=self._playlists
        with owner._authorized(context,constraints) as (connection,live,_now):
            playlist=owner._playlist(connection,live,playlist_ref)
            owner._require(live,(BROWSE,),constraints,playlist)
            if str(playlist['revision'])!=revision:raise PlaylistError('revision_conflict',409)
            rows=connection.execute('''select ref,local_track_id from app.playlist_items
                where playlist_ref=%s and library_id=%s and ref=any(%s::uuid[])
                order by ref for share''',(playlist_ref,live.library_id,refs)).fetchall()
            items={str(row['ref']):row for row in rows}
            if set(items)!=set(refs):raise PlaylistError('item_unavailable',404)
            tracks,unavailable=[],[]
            targets=self._targets.resolve_play_queue(connection,live,
                [items[ref]['local_track_id'] for ref in refs],constraints=constraints)
            for ref in refs:
                target=targets.get(items[ref]['local_track_id'])
                if target is None:
                    if ref==starting_item_ref:raise PlaylistError('item_unavailable',404)
                    unavailable.append(ref)
                else:
                    tracks.append({'playlist_item_id':ref,'native_target':{**target,'playlist_item_id':ref}})
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=owner._clock)
            return {'playlist_id':playlist_ref,'revision':revision,'starting_item_ref':starting_item_ref,
                'tracks':tracks,'unavailable_item_refs':unavailable}
