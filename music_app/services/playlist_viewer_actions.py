"""Playlist reader requests and private copies within the existing transaction."""
from dataclasses import replace
from uuid import uuid4

from music_app.services.capabilities import grant_keys_for_action
from music_app.services.collection_member_authority import collection_member_context
from music_app.services.owned_playlists import BROWSE, CREATE, ACCESS, MAX_PLAYLIST_ITEMS_PER_COMMAND, PlaylistError
from music_app.services.policy import ResourceScope
from music_app.services import playlist_creation_sources_postgres as sources


def requester_context(connection, context, account_id, *, lock=False):
    actor_context = collection_member_context(connection, context, account_id, lock=lock)
    if actor_context is None:
        raise PlaylistError('request_unavailable',404)
    return actor_context


def request_valid(owner, connection, context, playlist, account_id, constraints, *, lock=False):
    if playlist['visibility'] != 'server_shared' or playlist['deleted_at'] is not None:
        return False
    if connection.execute('select ref from app.playlist_access_grants where playlist_ref=%s and account_id=%s',
        (playlist['ref'],account_id)).fetchone() is not None:
        return False
    try:
        requester = requester_context(connection,context,account_id,lock=lock)
        owner._require(requester,(BROWSE,),constraints,{**playlist,'editor_grant':False})
        return True
    except PlaylistError:
        return False


def request_edit(owner, connection, context, command, playlist, constraints):
    if playlist['owner_account_id'] == context.actor.account_id or playlist['editor_grant']:
        raise PlaylistError('editor_request_not_needed',409)
    prior = connection.execute('''select ref from app.playlist_edit_requests
        where playlist_ref=%s and requester_account_id=%s and status='pending' for update''',
        (command.playlist_ref,context.actor.account_id)).fetchone()
    ref = str(prior['ref']) if prior else str(uuid4())
    if prior is None:
        grants = connection.execute("""select id from app.capabilities
            where account_id=%s and revoked_at is null and capability_key=any(%s)
              and (scope_kind='global' and scope_id is null or scope_kind='library' and scope_id=%s)
            order by id""",(context.actor.account_id,list(grant_keys_for_action(BROWSE)),context.library_id)).fetchall()
        connection.execute("""insert into app.playlist_edit_requests
            (ref,playlist_ref,library_id,requester_account_id,browse_grant_ids)
            values(%s,%s,%s,%s,%s)""",(ref,command.playlist_ref,context.library_id,context.actor.account_id,
            [row['id'] for row in grants]))
    return False, {'request_ref':ref,'request_status':'pending','request_created':prior is None}


def decide(owner, connection, context, command, playlist, constraints):
    request = connection.execute('''select * from app.playlist_edit_requests
        where ref=%s and playlist_ref=%s and library_id=%s for update''',
        (command.data['request_ref'],command.playlist_ref,context.library_id)).fetchone()
    if request is None or request['status'] != 'pending' or not request_valid(
            owner,connection,context,playlist,request['requester_account_id'],constraints,lock=True):
        raise PlaylistError('request_unavailable',404)
    approved = command.data['decision'] == 'approve'
    counts = {}
    if approved:
        grant_command = replace(command,action='grant_editor',data={
            'account_id':request['requester_account_id'],'role':'editor','revision':command.data['revision']})
        _, counts = owner._mutate(connection,context,grant_command,playlist,[],[],constraints=constraints)
    status = 'approved' if approved else 'declined'
    connection.execute('''update app.playlist_edit_requests set status=%s,resolved_at=now()
        where ref=%s''',(status,request['ref']))
    return True, {**counts,'request_ref':str(request['ref']),'request_status':status}


def copy_playlist(owner, connection, context, command, playlist, constraints):
    owner._require(context,(BROWSE,CREATE),constraints)
    rows = connection.execute('select * from app.playlist_items where playlist_ref=%s order by position',
        (command.playlist_ref,)).fetchall()
    if len(rows) > MAX_PLAYLIST_ITEMS_PER_COMMAND:
        raise PlaylistError('source_too_large',413)
    ids = [row['local_track_id'] for row in rows if row['local_track_id'] is not None]
    if any(not owner._resource_allowed(context,BROWSE,ResourceScope('track',str(track)),constraints) for track in ids):
        raise PlaylistError('item_unavailable',409)
    current = sources.inventory_rows(connection,context.library_id,ids,lock=True,config=owner._config)
    if any(track not in current for track in ids):
        raise PlaylistError('source_changed',409)
    # Copy only authored public item facts and current same-library links. Never
    # inherit the source owner's private activity lineage, ACL or listening state.
    ref = str(uuid4())
    title = command.data.get('title', (playlist['title'][:93] + ' (copy)'))
    connection.execute('''insert into app.playlists(ref,owner_account_id,library_id,title,description,visibility)
        values(%s,%s,%s,%s,%s,'private')''',(ref,context.actor.account_id,context.library_id,title,playlist['description']))
    connection.execute("""insert into app.playlist_items
        (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
         title,artist,album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,source_kind,source_protocol,source_lineage)
        select gen_random_uuid(),%s,library_id,position,original_local_track_id,local_track_id,
         title,artist,album_title,original_album_id,release_year,disc_number,track_number,duration_seconds,'playlist','playlist_copy_v1',
         jsonb_build_object('playlist_ref',playlist_ref::text,'playlist_item_ref',ref::text,'playlist_revision',%s::text)
        from app.playlist_items where playlist_ref=%s order by position""",(ref,command.data['revision'],command.playlist_ref))
    return owner._receipt(context,command,ref,1,True,source_playlist_id=command.playlist_ref,
        source_revision=command.data['revision'],added_count=len(rows))


def invalidate(connection, playlist_ref, *, account_id=None, status='revoked'):
    connection.execute('''update app.playlist_edit_requests set status=%s,resolved_at=now()
        where playlist_ref=%s and status='pending' and (%s::bigint is null or requester_account_id=%s)''',
        (status,playlist_ref,account_id,account_id))


def project_request(row):
    return {key: str(row[key]) if key in ('request_ref','playlist_id') else row[key].isoformat() if key=='created_at' else row[key]
        for key in ('request_ref','playlist_id','title','account_ref','display_name','username_display','created_at')}


_REQUEST_SELECT = '''select r.*,r.ref as request_ref,p.ref as playlist_id,p.title,
    sp.account_ref::text,a.display_name,a.username_display,r.created_at as created_at
    from app.playlist_edit_requests r join app.playlists p on p.ref=r.playlist_ref
    join app.accounts a on a.id=r.requester_account_id
    join app.social_profiles sp on sp.account_id=a.id'''


def pending(owner, connection, context, constraints, *, playlist_ref=None, after=0, limit=50):
    rows = connection.execute(_REQUEST_SELECT + '''
        where r.library_id=%s and p.owner_account_id=%s and p.deleted_at is null
          and p.visibility='server_shared' and r.status='pending' and r.id>%s
          and (%s::uuid is null or p.ref=%s) order by r.id limit %s''',
        (context.library_id,context.actor.account_id,after,playlist_ref,playlist_ref,limit+1)).fetchall()
    result = []
    for row in rows[:limit]:
        playlist = owner._playlist(connection,context,str(row['playlist_id']))
        if owner._allows(context,(BROWSE,ACCESS),constraints,playlist,owner_only=True) and request_valid(
                owner,connection,context,playlist,row['requester_account_id'],constraints):
            fresh = connection.execute("select status from app.playlist_edit_requests where ref=%s",(row['ref'],)).fetchone()
            if fresh is not None and fresh['status']=='pending':
                result.append(project_request(row))
    return result, rows[limit-1]['id'] if len(rows)>limit else None
