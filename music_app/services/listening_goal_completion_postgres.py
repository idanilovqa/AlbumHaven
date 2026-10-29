"""Transaction-bound self-only completion for current authorized memberships.

The account Goals owner already holds the real actor/session/account fence. This
module opens no connection and never changes a selected library or another actor.
"""
from dataclasses import replace

from music_app.services.collection_member_authority import collection_member_context
from music_app.services.owned_album_tops import AlbumTopError, AlbumTopCommand, BROWSE, PROGRESS
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Tops
from music_app.services import album_top_progress as progress
from music_app.services import album_top_activity_postgres as activity
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_top_authority import require_goal_top_progress

MAX_COMPLETION_MEMBERSHIPS = 1000
MAX_COMPLETION_LIBRARIES = 100


def propagate_goal_completion(connection, live, catalog_ref, request_key, now, *, constraints=None):
    """Complete the captured current Top memberships atomically with Goals.

    Receipt replay happens before this call. Later added memberships therefore
    never inherit a replayed completion. Only active Tops participate. Activity is checked after the Top lock while
    the actor account lock prevents a concurrent activity change for this account.
    """
    libraries = connection.execute('''select m.library_id from library.library_memberships m
        join library.libraries l on l.id=m.library_id
        where m.account_id=%s order by m.library_id limit 101 for share of m,l''',
        (live.actor.account_id,)).fetchall()
    if len(libraries) > MAX_COMPLETION_LIBRARIES:
        raise GoalsError('completion_scope_too_large', 409)
    contexts = {}
    for library in libraries:
        # This is an eligibility projection for the SAME caller; authenticated
        # identity/session continuity is still owned by the outer transaction.
        scoped = collection_member_context(connection, replace(live, library_id=library['library_id']),
                                           live.actor.account_id, lock=True)
        if scoped is not None:
            contexts[library['library_id']] = scoped
    if not contexts:
        return []
    rows = connection.execute('''select l.ref,l.library_id from app.album_lists l
        join app.album_list_items i on i.top_ref=l.ref and i.library_id=l.library_id
        where i.catalog_ref=%s and l.library_id=any(%s) and l.deleted_at is null
          and (l.owner_account_id=%s or l.visibility='server_shared' or exists(
            select 1 from app.album_list_access_grants g where g.top_ref=l.ref
              and g.library_id=l.library_id and g.account_id=%s and g.role in ('editor','viewer')))
        order by l.library_id,l.ref limit 1001''',
        (catalog_ref, sorted(contexts), live.actor.account_id, live.actor.account_id)).fetchall()
    if len(rows) > MAX_COMPLETION_MEMBERSHIPS:
        raise GoalsError('completion_scope_too_large', 409)
    captured = []
    for row in rows:
        scoped = contexts[row['library_id']]
        try:
            top = Tops._top(connection, scoped, str(row['ref']), write=True)
            require_goal_top_progress(scoped, top, constraints, write=True)
        except AlbumTopError as error:
            if error.status_code in (403,404):
                continue
            raise GoalsError(error.code,error.status_code) from None
        member = connection.execute('''select catalog_ref from app.album_list_items
            where top_ref=%s and library_id=%s and catalog_ref=%s for share''',
            (top['ref'], scoped.library_id, catalog_ref)).fetchone()
        # A removal completed before our parent lock is not a current membership.
        if member is None:
            continue
        state = activity.read_activity(connection, scoped, [str(top['ref'])])[str(top['ref'])]
        if not state['active']:
            continue
        captured.append((scoped,top))
    receipts = []
    for scoped,top in captured:
        row = connection.execute('''select revision from app.album_list_item_progress
            where account_id=%s and library_id=%s and top_ref=%s and catalog_ref=%s for update''',
            (live.actor.account_id,scoped.library_id,top['ref'],catalog_ref)).fetchone()
        command = AlbumTopCommand('set_manual_completion',str(top['ref']),request_key,
            {'album_ref':catalog_ref,'progress_revision':str(row['revision'] if row else 0),'completed':True})
        try:
            receipts.append(progress.set_manual_completion(connection,scoped,command,top,now))
        except AlbumTopError as error:
            raise GoalsError(error.code,error.status_code) from None
    # Dynamic per-resource constraints may have changed during another Top wait.
    for scoped,top in captured:
        try:
            require_goal_top_progress(scoped,top,constraints,write=True)
        except AlbumTopError as error:
            raise GoalsError(error.code,error.status_code) from None
    return receipts
