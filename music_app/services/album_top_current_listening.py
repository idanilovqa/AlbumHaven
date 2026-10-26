"""Bounded current Top projection over the existing local derived accumulator.

Four requested current item incarnations maximum. Reads never initialize state,
scan raw history or perform a per-card calculation. Explicit advance processes
one existing accumulator page inside this same authorized transaction.
"""
from datetime import datetime,timezone
from music_app.services.owned_album_tops import AlbumTopError,BROWSE,PROGRESS,top_uuid
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.private_library_authority import current_library_transaction,require_private_action,PrivateLibraryAuthorityError
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.policy import ResourceScope
from music_app.services.album_preferences_postgres import load_album_preferences_on_connection
from music_app.services.playback_decoder_observation import _bounded_connection
from music_app.services.playback_capture import CaptureError
from music_app.services.playback_capture_postgres import _selector,_final_authority
from music_app.services.playback_capture_history_revision import _read_history_revision
from music_app.services.playback_position_transport import require_position_storage
from music_app.services.local_album_listening import _edition,_versions,_require_local_metrics_indexes
from music_app.services.local_album_full_state import read_full_state,advance_local_album_full_on_connection,FRESH_PLAY_POLICY
from music_app.services.album_top_listening_baseline import require_baseline_storage,read_baseline
from music_app.services.album_top_rating_intent import rating_intent_storage_ready
from music_app.services.album_top_listening_settings import project_settings
from music_app.services.album_top_listening_settings_postgres import PostgresAlbumTopListeningSettings,READ as SETTINGS_READ
from music_app.services.album_top_browse import project_native_albums

from music_app.services.album_top_fresh_scope import current_top_listening_scope,FreshTrackScope
from music_app.services.foobar_account_matched_evidence import optional_matched_foobar_evidence_on_connection

MAX_ITEMS=4


def _refs(values):
    if type(values) is not list or not 1<=len(values)<=MAX_ITEMS:
        raise CaptureError('invalid_top_metrics',422)
    result=[top_uuid(value) for value in values]
    if len(set(result))!=len(result):raise CaptureError('invalid_top_metrics',422)
    return result


def _after(value,baseline):
    if baseline is None or value is None:return None
    if isinstance(value,str):
        try:value=datetime.fromisoformat(value)
        except ValueError:return None
    if not isinstance(value,datetime) or value.tzinfo is None:return None
    return value>baseline


class PostgresTopCurrentListening(PostgresOwnedAlbumTopsService):
    def __init__(self,config,*,connect=None,clock=None):
        super().__init__(config,connect=connect or _bounded_connection,clock=clock)

    def project(self,context,*,top_ref,top_revision,item_refs,advance=None,constraints=None,enabled=lambda:False):
        ref=top_uuid(top_ref);refs=_refs(item_refs)
        if (type(top_revision) is not str or not top_revision.isascii() or not top_revision.isdecimal()
            or not 0<int(top_revision)<2**63 or str(int(top_revision))!=top_revision):
            raise CaptureError('invalid_top_metrics',422)
        if advance is not None and (len(refs)!=1 or type(advance) is not int or not 0<=advance<2**53-1):
            raise CaptureError('invalid_top_metrics',422)
        if enabled() is not True:raise CaptureError('capture_unavailable',503)
        with current_library_transaction(self._url,context,constraints=constraints,connect=self._connect,
                clock=self._clock,inventory_publication_first=True) as (connection,live,now):
            if enabled() is not True:raise CaptureError('capture_unavailable',503)
            top=self._top(connection,live,ref)
            self._require(live,(BROWSE,PROGRESS) if advance is not None else (BROWSE,),constraints,top)
            if str(top['revision'])!=top_revision:raise CaptureError('capture_scope_changed',409)
            require_baseline_storage(connection)
            measured=self._config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
            try:
                require_private_action(live,'library.media.read',constraints=constraints)
            except PrivateLibraryAuthorityError:
                measured=False
            if measured:
                try:
                    _selector(connection,live);require_position_storage(connection)
                    _require_local_metrics_indexes(connection)
                except CaptureError as error:
                    if error.status!=503:raise
                    measured=False
            rows=connection.execute('''select ref,catalog_ref,listening_baseline_at from app.album_list_items
                where top_ref=%s and library_id=%s and ref=any(%s::uuid[]) order by ref for share''',
                (ref,live.library_id,refs)).fetchall()
            if len(rows)!=len(refs):raise CaptureError('capture_scope_changed',409)
            items=[{**row,'ref':str(row['ref']),'catalog_ref':str(row['catalog_ref'])} for row in rows]
            remote=connection.execute('''select item_ref from app.album_list_item_remote_sources
                where item_ref=any(%s::uuid[])''',(refs,)).fetchall()
            remote_refs=[str(row['item_ref']) for row in remote]
            mapped=project_native_albums(connection,live,items,remote_item_refs=remote_refs,constraints=constraints)
            # Settings have their own account-self policy, not an ambient Top grant.
            PostgresAlbumTopListeningSettings._require(live,SETTINGS_READ,constraints)
            settings=project_settings(PostgresAlbumTopListeningSettings._load(connection,live.actor.account_id))
            intent_ready=rating_intent_storage_ready(connection)
            present=connection.execute('''select 1 as present from integration.playback_capture_history_revision
                where account_id=%s''',(live.actor.account_id,)).fetchone() if measured else None
            # Absence is not zero history and does not create quota/history on GET.
            # Malformed/existing history still goes through the genuine strict reader.
            history=_read_history_revision(connection,live.actor.account_id) if present else None
            # Optional reported evidence is read once on GET, never on every
            # 1.5s measured advance. Cap the whole request at100 native targets.
            import_tracks={};import_overflow=set();remaining=100;reported=None
            if advance is None:
                for item in mapped:
                    native=item['native_album']
                    if native is None:continue
                    album_id=int(native['inventory_album_ref'].rsplit(':',1)[1])
                    rows=connection.execute('''select id from library.local_tracks
                        where library_id=%s and album_id=%s order by id limit %s for share''',
                        (live.library_id,album_id,remaining+1)).fetchall()
                    if len(rows)>remaining:import_overflow.add(item['ref'])
                    chosen=rows[:remaining];remaining-=len(chosen);ids=[]
                    for row in chosen:
                        try:require_private_action(live,'library.browse.read',resource=ResourceScope('track',str(row['id'])),constraints=constraints)
                        except PrivateLibraryAuthorityError:
                            import_overflow.add(item['ref']);continue
                        ids.append(row['id'])
                    import_tracks[item['ref']]=ids
                wanted=tuple(sorted({track for ids in import_tracks.values() for track in ids}))
                if wanted:
                    reported=optional_matched_foobar_evidence_on_connection(connection,live,
                        track_ids=wanted,count_family='standard',constraints=constraints)
            result=[];selected_facts=[]
            for item in mapped:
                base=read_baseline(connection,live,top,item,start_legacy=advance is not None)
                native=item['native_album']
                if native is None:
                    result.append(dict(item_ref=item['ref'],album_ref=item['catalog_ref'],status='unavailable',
                        manual_completed=base['manual_completed'],baseline_changed=base['baseline_changed']))
                    continue
                album_id=int(native['inventory_album_ref'].rsplit(':',1)[1])
                album=connection.execute('''select album_key from library.local_albums
                    where library_id=%s and id=%s for share''',(live.library_id,album_id)).fetchone()
                if album is None:raise CaptureError('capture_scope_changed',409)
                selected=None;versions=None
                full=dict(available=True,state_revision='0',status='not_started',continuation=False,
                    reason='no_capture_history' if measured else 'measured_evidence_unavailable')
                if advance is not None and not base['active']:raise CaptureError('top_inactive',409)
                if measured:
                    try:
                        selected,members=current_top_listening_scope(connection,live,album['album_key'],constraints)
                        if selected.album_id!=album_id:raise CaptureError('capture_scope_changed',409)
                        versions=_versions(connection,live,selected,members)
                    except PrivateLibraryAuthorityError:
                        selected=None;versions=None
                    except CaptureError as error:
                        if error.status not in (403,404,503):raise
                        selected=None;versions=None
                    if selected is not None and history is not None:
                        if advance is not None:
                            full=advance_local_album_full_on_connection(connection,live,now,album['album_key'],advance,
                                constraints=constraints,clock=self._clock,
                                enabled=lambda:enabled() is True and self._config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True,top_freshness=True,target=settings['completed_target'])['full_progress']
                        else:full=read_full_state(connection,live,selected,versions,history,allow_fresh_only=True,target=settings['completed_target'])
                # Reuse native taste admission, including exact active-source locks.
                preference=load_album_preferences_on_connection(connection,account_id=live.actor.account_id,
                    library_id=live.library_id,album_ids=[album_id]).get(album_id)
                rated=preference['rating'] is not None if preference is not None else None
                intent=None
                if intent_ready and rated and preference['preference_id'] is not None:
                    intent=connection.execute("""select native_rating_intent_at from app.album_ratings
                        where id=%s and account_id=%s and library_id=%s and album_key=%s
                        and preference_revision=%s and provenance='personal_rating'""",
                        (preference['preference_id'],live.actor.account_id,live.library_id,
                         preference['album_key'],preference['preference_revision'])).fetchone()
                fresh_rating=_after(intent['native_rating_intent_at'],base['baseline']) if intent else None
                fresh=full.get('fresh_play',{})
                fresh_play=(_after(fresh.get('server_open_lower_bound'),base['baseline'])
                    if fresh.get('policy')==FRESH_PLAY_POLICY and fresh.get('status')=='supported' else None)
                imported=bool(reported and set(import_tracks.get(item['ref'],())) & set(reported.positive_track_ids))
                import_incomplete=(advance is not None or reported is None or reported.availability!='available'
                    or item['ref'] in import_overflow or bool(set(import_tracks.get(item['ref'],())) & set(reported.incomplete_track_ids)))
                count=full.get('full');count=count if type(count) is int and count>=0 else None
                automatic=(base['active'] and fresh_rating is True and fresh_play is True
                    and count is not None and count>=settings['completed_target'])
                completed=True if base['manual_completed'] or automatic else (False if not base['active'] else None)
                result.append(dict(item_ref=item['ref'],album_ref=item['catalog_ref'],status='ready',
                    local_album_ref=native['inventory_album_ref'],membership_revision=selected.membership_revision if selected and not isinstance(selected,FreshTrackScope) else None,
                    full_progress=full,manual_completed=base['manual_completed'],automatic_completed=automatic,
                    baseline_status='ready' if base['baseline'] is not None else 'needs_explicit_start',
                    baseline_changed=base['baseline_changed'],
                    reported_evidence=dict(has_plays=True if imported else None,count_family='standard',
                        provenance='own_account_foobar_reported_evidence',incomplete=import_incomplete,
                        status='not_requested' if advance is not None else 'available' if reported and reported.availability=='available' else 'unavailable'),
                    predicates=dict(has_plays=True if imported or count and count>0 or fresh.get('status')=='supported' else None,
                        listened=True if count and count>0 else None,completed=completed,rated=rated),
                    fresh_rating=fresh_rating,fresh_play=fresh_play))
                if selected is not None:selected_facts.append((album['album_key'],selected,versions))
            for key,selected,versions in selected_facts:
                final,members=current_top_listening_scope(connection,live,key,constraints)
                if final!=selected or _versions(connection,live,final,members)!=versions:
                    raise CaptureError('capture_scope_changed',409)
            final_mapped=project_native_albums(connection,live,items,remote_item_refs=remote_refs,constraints=constraints)
            if [row['native_album'] for row in mapped]!=[row['native_album'] for row in final_mapped]:
                raise CaptureError('capture_scope_changed',409)
            self._require(live,(BROWSE,PROGRESS) if advance is not None else (BROWSE,),constraints,top)
            PostgresAlbumTopListeningSettings._require(live,SETTINGS_READ,constraints)
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=self._clock)
            if measured:
                _final_authority(connection,live,constraints,self._clock)
                if self._config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True:raise CaptureError('capture_scope_changed',409)
            if enabled() is not True:raise CaptureError('capture_unavailable',503)
            return dict(version='current-top-listening-v1',top_ref=ref,top_revision=top_revision,
                account_id=str(live.actor.account_id),library_id=str(live.library_id),
                settings=settings,items=result,scope='requested-current-items',whole_top_complete=False)
