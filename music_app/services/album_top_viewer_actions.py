"""Top collaboration and private copies within the artifact owner's transaction."""
from dataclasses import replace
from uuid import uuid4

from music_app.services.capabilities import grant_keys_for_action
from music_app.services.collection_member_authority import collection_member_context
from music_app.services.owned_album_tops import ACCESS, BROWSE, MAX_TOP_ITEMS, AlbumTopError
from music_app.services.social_cursors import decode_social_cursor, encode_social_cursor


def member_context(connection, context, account_id, *, lock=False):
    member = collection_member_context(connection, context, account_id, lock=lock)
    if member is None:
        raise AlbumTopError('grant_target_unavailable', 404)
    return replace(member, target_account_id=account_id if context.target_account_id is not None else None)


def eligible_member(owner, connection, context, top, account_id, constraints, *, lock=False):
    try:
        member = member_context(connection, context, account_id, lock=lock)
        owner._require(member, (BROWSE,), constraints, {**top, 'editor_grant': True})
        return True
    except AlbumTopError:
        return False


def request_valid(owner, connection, context, top, account_id, constraints, *, lock=False):
    if (top['visibility'] != 'server_shared' or top['deleted_at'] is not None
            or top['owner_account_id'] == account_id):
        return False
    if connection.execute('''select ref from app.album_list_access_grants
            where top_ref=%s and library_id=%s and account_id=%s''',
            (top['ref'], context.library_id, account_id)).fetchone() is not None:
        return False
    return eligible_member(owner, connection, context, top, account_id, constraints, lock=lock)


def invalidate(connection, top_ref, *, account_id=None, status='revoked'):
    connection.execute('''update app.album_list_edit_requests set status=%s,resolved_at=now()
        where top_ref=%s and status='pending'
          and (%s::bigint is null or requester_account_id=%s)''',
        (status, top_ref, account_id, account_id))


def grant_editor(owner, connection, context, top, account_id, constraints):
    if account_id == top['owner_account_id']:
        raise AlbumTopError('invalid_editor', 409)
    if not eligible_member(owner, connection, context, top, account_id, constraints, lock=True):
        raise AlbumTopError('grant_target_unavailable', 404)
    prior = connection.execute('''select ref from app.album_list_access_grants
        where top_ref=%s and account_id=%s''', (top['ref'], account_id)).fetchone()
    ref = str(prior['ref']) if prior else str(uuid4())
    if prior is None:
        connection.execute('''insert into app.album_list_access_grants
            (ref,top_ref,library_id,account_id,role) values(%s,%s,%s,%s,'editor')''',
            (ref, top['ref'], context.library_id, account_id))
    invalidate(connection, top['ref'], account_id=account_id, status='approved')
    return prior is None, {'grant_ref': ref}


def mutate(owner, connection, context, command, top, constraints, *, locked_target=None):
    data = command.data
    if command.action == 'visibility':
        changed = data['visibility'] != top['visibility']
        if changed:
            connection.execute('update app.album_lists set visibility=%s where ref=%s',
                               (data['visibility'], top['ref']))
        return changed, {'visibility': data['visibility']}
    if command.action == 'grant_editor':
        return grant_editor(owner, connection, context, top, data['account_id'], constraints)
    if command.action == 'revoke_editor':
        row = connection.execute('''delete from app.album_list_access_grants
            where ref=%s and top_ref=%s and library_id=%s returning ref''',
            (data['grant_ref'], top['ref'], context.library_id)).fetchone()
        if row is None:
            raise AlbumTopError('grant_unavailable', 404)
        return True, {'grant_ref': str(row['ref'])}
    if command.action == 'request_edit':
        if top['owner_account_id'] == context.actor.account_id or top['editor_grant']:
            raise AlbumTopError('editor_request_not_needed', 409)
        if top['visibility'] != 'server_shared':
            raise AlbumTopError('top_unavailable', 404)
        prior = connection.execute('''select ref from app.album_list_edit_requests
            where top_ref=%s and requester_account_id=%s and status='pending' for update''',
            (top['ref'], context.actor.account_id)).fetchone()
        ref = str(prior['ref']) if prior else str(uuid4())
        if prior is None:
            grants = connection.execute('''select id from app.capabilities
                where account_id=%s and revoked_at is null and capability_key=any(%s)
                  and (scope_kind='global' and scope_id is null or scope_kind='library' and scope_id=%s
                    or scope_kind='account' and scope_id=%s) order by id''',
                (context.actor.account_id, list(grant_keys_for_action(BROWSE)), context.library_id,
                 context.target_account_id)).fetchall()
            connection.execute('''insert into app.album_list_edit_requests
                (ref,top_ref,library_id,requester_account_id,browse_grant_ids)
                values(%s,%s,%s,%s,%s)''',
                (ref, top['ref'], context.library_id, context.actor.account_id, [row['id'] for row in grants]))
        return False, {'request_ref': ref, 'request_status': 'pending', 'request_created': prior is None}
    if command.action == 'decide_edit_request':
        request = connection.execute('''select * from app.album_list_edit_requests
            where ref=%s and top_ref=%s and library_id=%s for update''',
            (data['request_ref'], top['ref'], context.library_id)).fetchone()
        if (request is None or request['status'] != 'pending'
                or request['requester_account_id'] != locked_target
                or not request_valid(owner, connection, context, top,
                                     request['requester_account_id'], constraints, lock=True)):
            raise AlbumTopError('request_unavailable', 404)
        approved = data['decision'] == 'approve'
        counts = {}
        if approved:
            _, counts = grant_editor(owner, connection, context, top, request['requester_account_id'], constraints)
        status = 'approved' if approved else 'declined'
        connection.execute('update app.album_list_edit_requests set status=%s,resolved_at=now() where ref=%s',
                           (status, request['ref']))
        return True, {**counts, 'request_ref': str(request['ref']), 'request_status': status}
    raise AlbumTopError('invalid_command')


def copy_top(connection, context, command, top):
    # The locked artifact is the authorized snapshot. Inventory admission and
    # playback eligibility are unrelated to keeping a personal catalog-only copy.
    rows = connection.execute('''select catalog_ref,original_position,curator_position
        from app.album_list_items where top_ref=%s order by curator_position''', (top['ref'],)).fetchall()
    if len(rows) > MAX_TOP_ITEMS:
        raise AlbumTopError('source_too_large', 413)
    ref = str(uuid4())
    connection.execute('''insert into app.album_lists
        (ref,owner_account_id,library_id,title,description,next_original_position)
        values(%s,%s,%s,%s,%s,%s)''',
        (ref, context.actor.account_id, context.library_id,
         command.data.get('title', top['title'][:93] + ' (copy)'), top['description'], top['next_original_position']))
    connection.execute('''insert into app.album_list_items
        (ref,top_ref,library_id,catalog_ref,original_position,curator_position)
        select gen_random_uuid(),%s,library_id,catalog_ref,original_position,curator_position
        from app.album_list_items where top_ref=%s order by curator_position''', (ref, top['ref']))
    return {'top_ref': ref, 'revision': '1', 'action': command.action, 'request_key': command.request_key,
            'source_top_ref': str(top['ref']), 'source_revision': str(top['revision']), 'added_count': len(rows)}


def page_position(cursor, secret, scope):
    try:
        return decode_social_cursor(cursor, secret=secret, scope=scope)
    except ValueError:
        raise AlbumTopError('invalid_cursor') from None


def pending(owner, connection, context, constraints, *, top_ref=None, after=0, limit=50):
    rows = connection.execute('''select r.*,p.title,s.account_ref::text,a.display_name,a.username_display
        from app.album_list_edit_requests r join app.album_lists p on p.ref=r.top_ref
        join app.accounts a on a.id=r.requester_account_id
        join app.social_profiles s on s.account_id=a.id
        where r.library_id=%s and p.owner_account_id=%s and p.deleted_at is null
          and p.visibility='server_shared' and r.status='pending' and r.id>%s
          and (%s::uuid is null or p.ref=%s) order by r.id limit %s''',
        (context.library_id, context.actor.account_id, after, top_ref, top_ref, limit + 1)).fetchall()
    result = []
    for row in rows[:limit]:
        try:
            top = owner._top(connection, context, str(row['top_ref']))
            owner._require(context, (BROWSE, ACCESS), constraints, top, owner_only=True)
        except AlbumTopError:
            continue
        # No account lock after a parent lock on this read path: owner feeds and
        # requester retries must not invert the mutation account/parent order.
        if request_valid(owner, connection, context, top, row['requester_account_id'], constraints):
            fresh = connection.execute('select status from app.album_list_edit_requests where ref=%s',
                                       (row['ref'],)).fetchone()
            if fresh is not None and fresh['status'] == 'pending':
                result.append({'request_ref': str(row['ref']), 'top_ref': str(row['top_ref']),
                    'title': top['title'], 'account_ref': row['account_ref'], 'display_name': row['display_name'],
                    'username_display': row['username_display'], 'created_at': row['created_at'].isoformat()})
    return result, rows[limit - 1]['id'] if len(rows) > limit else None


def sharing(owner, connection, context, top, constraints, *, cursor_secret, cursor=None):
    actions = owner._actions(context, constraints, top)
    manage = actions['can_share']
    if cursor is not None and not manage:
        raise AlbumTopError('forbidden', 403)
    scope = ['album-top-sharing-requests-v1', context.actor.account_id, context.actor.session_id,
             context.library_id, str(top['ref'])]
    after = page_position(cursor, cursor_secret, scope)
    row = connection.execute('''select status from app.album_list_edit_requests
        where top_ref=%s and requester_account_id=%s order by id desc limit 1''',
        (top['ref'], context.actor.account_id)).fetchone()
    requests, after = pending(owner, connection, context, constraints, top_ref=str(top['ref']),
                             after=after, limit=100) if manage else ([], None)
    status = row['status'] if row else 'none'
    if status == 'revoked' or status == 'approved' and not top['editor_grant']:
        status = 'none'
    return {'top_ref': str(top['ref']), 'revision': str(top['revision']), 'visibility': top['visibility'],
            'can_manage': manage, 'can_request_edit': actions['can_request_edit'], 'can_copy': actions['can_copy'],
            'request_status': status,
            'pending_requests': requests, 'next_pending_cursor': encode_social_cursor(after, secret=cursor_secret, scope=scope)}


def access_directory(owner, connection, context, top, constraints, *, cursor_secret, cursor=None,
                     limit=50, query=None):
    candidates = query is not None
    if candidates and (type(query) is not str or len(query) > 100 or '\0' in query
                       or any('\ud800' <= char <= '\udfff' for char in query)):
        raise AlbumTopError('invalid_query')
    scope = ['album-top-access-candidates-v1' if candidates else 'album-top-access-grants-v1',
             context.actor.account_id, context.actor.session_id, context.library_id, str(top['ref']), query]
    after = page_position(cursor, cursor_secret, scope)
    rows = connection.execute('''select a.id as account_id,s.account_ref::text,a.display_name,a.username_display,
            g.ref as grant_ref,g.role,(a.is_active and a.disabled_at is null) as is_active
        from app.accounts a join app.social_profiles s on s.account_id=a.id
        join library.library_memberships m on m.account_id=a.id and m.library_id=%(library)s
        left join app.album_list_access_grants g on g.account_id=a.id
          and g.library_id=m.library_id and g.top_ref=%(top)s
        where a.id<>%(owner)s and a.id>%(after)s
          and (not %(candidates)s or a.is_active and a.disabled_at is null)
          and (%(candidates)s or g.ref is not null)
          and (%(query)s::text is null or a.display_name ilike %(query)s or a.username_display ilike %(query)s)
        order by a.id limit %(limit)s''',
        {'library': context.library_id, 'top': top['ref'], 'owner': top['owner_account_id'], 'after': after,
         'limit': limit + 1, 'candidates': candidates,
         'query': '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%' if candidates else None}).fetchall()
    projected = []
    for row in rows[:limit]:
        # Existing grants remain visible to the owner when eligibility is lost,
        # so they can be revoked before an account or Browse grant is restored.
        if candidates and not eligible_member(owner, connection, context, top, row['account_id'], constraints):
            continue
        item = {**row, 'grant_ref': str(row['grant_ref']) if row['grant_ref'] else None}
        if candidates:
            del item['is_active']
            item['allowed_actions'] = {'can_grant_editor': row['grant_ref'] is None}
        projected.append(item)
    return {'top_ref': str(top['ref']), 'revision': str(top['revision']),
            **({'visibility': top['visibility']} if not candidates else {}),
            'candidates' if candidates else 'grants': projected,
            'next_cursor': encode_social_cursor(rows[limit - 1]['account_id'] if len(rows) > limit else None,
                                               secret=cursor_secret, scope=scope)}
