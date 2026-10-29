"""Separate rating progress for Library-source Goals; never fake Top completion.

Called only by the committed own-album preference transaction after its CAS.
"""
from dataclasses import replace

from music_app.services.collection_member_authority import collection_member_context
from music_app.services.owned_album_tops import AlbumTopError,BROWSE,PROGRESS
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Tops
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_top_authority import require_goal_top_progress,require_goal_write
from music_app.services import album_top_activity_postgres as activity


def storage_ready(connection):
    row=connection.execute("select to_regclass('app.listening_goal_rating_progress') is not null as ready").fetchone()
    return bool(row and row['ready'])


def has_active_top(connection,live,catalog_ref,constraints):
    rows=connection.execute('''select l.ref,l.library_id from app.album_lists l
        join app.album_list_items i on i.top_ref=l.ref and i.library_id=l.library_id
        join library.library_memberships m on m.library_id=l.library_id and m.account_id=%s
        where i.catalog_ref=%s and l.deleted_at is null
        order by l.library_id,l.ref limit 1001''',(live.actor.account_id,catalog_ref)).fetchall()
    if len(rows)>1000:raise GoalsError('completion_scope_too_large',409)
    contexts={}
    for row in rows:
        library=row['library_id']
        if library not in contexts:
            contexts[library]=collection_member_context(connection,replace(live,library_id=library),live.actor.account_id,lock=True)
        context=contexts[library]
        if context is None:continue
        try:
            # Discovery rows are only IDs, not authority. Parent lock serializes
            # deletion, visibility, reserved collection access and membership.
            top=Tops._top(connection,context,str(row['ref']))
            member=connection.execute('''select catalog_ref from app.album_list_items
                where library_id=%s and top_ref=%s and catalog_ref=%s for share''',
                (library,top['ref'],catalog_ref)).fetchone()
            if member is None:continue
            state=activity.read_activity(connection,context,[str(top['ref'])])[str(top['ref'])]
            if not state['active']:continue
            require_goal_top_progress(context,top,constraints)
        except AlbumTopError as error:
            if error.status_code in (403,404):continue
            raise
        return True
    return False


def record_rating(connection,live,album_id,preference_id,preference_revision,*,constraints=None):
    """Capture a fresh explicit non-null rating only; same-value rerating qualifies.

    Removing a rating does not erase an already-earned weekly progress event.
    New cycles require a new rating action, not a historical existing rating.
    """
    try:require_goal_write(live,constraints)
    except AlbumTopError:return
    if not storage_ready(connection):return
    link=connection.execute('''select catalog_ref from library.catalog_album_links
        where library_id=%s and local_album_id=%s''',(live.library_id,album_id)).fetchone()
    if link is None:return
    catalog=str(link['catalog_ref'])
    qualification=connection.execute('''select rs.admission_ref from app.listening_goal_cycle_sources rs
        join app.listening_goal_cycles c on c.account_id=rs.account_id and c.cycle_id=rs.cycle_id and c.closed_at is null
        join app.listening_goal_weekly_admissions wa on wa.ref=rs.admission_ref and wa.account_id=rs.account_id
            and wa.catalog_ref=rs.catalog_ref
        where rs.account_id=%s and rs.catalog_ref=%s and wa.source_category='library'
        order by wa.admitted_at,wa.ref limit 1''',(live.actor.account_id,catalog)).fetchone()
    if qualification is None:return
    candidates=connection.execute('''select c.goal_ref,c.cycle_id,i.position from app.listening_goal_cycles c
        join app.listening_goal_cycle_items i on i.account_id=c.account_id and i.goal_ref=c.goal_ref
            and i.cycle_id=c.cycle_id and i.removed_at is null
        where c.account_id=%s and c.closed_at is null and i.catalog_ref=%s order by c.period''',
        (live.actor.account_id,catalog)).fetchall()
    if not candidates or has_active_top(connection,live,catalog,constraints):return
    inserted=False
    for row in candidates:
        event=connection.execute('''insert into app.listening_goal_rating_progress
            (account_id,goal_ref,cycle_id,catalog_ref,admission_ref,membership_position,preference_id,preference_revision,rated_at)
            values(%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp()) on conflict do nothing returning catalog_ref''',
            (live.actor.account_id,row['goal_ref'],row['cycle_id'],catalog,qualification['admission_ref'],row['position'],preference_id,preference_revision)).fetchone()
        inserted = inserted or event is not None
    if not inserted:return
    # The actor account lock serializes Goal edits. An independent progress event
    # still invalidates stale Goal mutation revisions and is included on readback.
    changed=connection.execute('''update app.listening_goals set revision=revision+1,updated_at=clock_timestamp()
        where account_id=%s and revision<9223372036854775807 returning revision''',
        (live.actor.account_id,)).fetchone()
    if changed is None:raise GoalsError('revision_exhausted',409)
    # Catch a source becoming eligible during hook waits; all writes roll back.
    if has_active_top(connection,live,catalog,constraints):
        raise GoalsError('goal_source_changed',409)
    try:require_goal_write(live,constraints)
    except AlbumTopError as error:raise GoalsError(error.code,error.status_code) from None
    return True


def overlay(connection,live,periods,albums,*,constraints=None):
    if not storage_ready(connection):return {}
    rows=connection.execute('''select rp.cycle_id,rp.catalog_ref,rp.rated_at from app.listening_goal_rating_progress rp
        join app.listening_goal_cycle_items rs on rs.account_id=rp.account_id and rs.cycle_id=rp.cycle_id
            and rs.catalog_ref=rp.catalog_ref and rs.position=rp.membership_position and rs.removed_at is null
        where rp.account_id=%s and rp.cycle_id=any(%s::uuid[])''',
        (live.actor.account_id,[v['cycle']['cycle_id'] for v in periods.values() if v['cycle']])).fetchall()
    by_cycle={}
    for row in rows:by_cycle.setdefault(str(row['cycle_id']),{})[str(row['catalog_ref'])]=row['rated_at'].isoformat()
    for value in periods.values():
        cycle=value['cycle'];marks=by_cycle.get(cycle['cycle_id'],{}) if cycle else {}
        value['rated_at']={ref:marks.get(ref) for ref in value['album_refs']}
        value['completed']=sum(value['manual_completed_at'][ref] is not None or value['rated_at'][ref] is not None for ref in value['album_refs'])
        total=value['total'];value['percent']=(200*value['completed']+total)//(2*total) if total else 0
    refs=[str(row['catalog_ref']) for row in albums]
    if not refs:return {}
    kinds=connection.execute('''select rs.cycle_id,rs.catalog_ref from app.listening_goal_cycle_sources rs
        join app.listening_goal_cycles c on c.account_id=rs.account_id and c.cycle_id=rs.cycle_id and c.closed_at is null
        join app.listening_goal_weekly_admissions wa on wa.ref=rs.admission_ref and wa.account_id=rs.account_id
            and wa.catalog_ref=rs.catalog_ref
        where rs.account_id=%s and rs.catalog_ref=any(%s::uuid[]) and wa.source_category='library' ''',
        (live.actor.account_id,refs)).fetchall()
    eligible={ref for ref in {str(row['catalog_ref']) for row in kinds}
              if not has_active_top(connection,live,ref,constraints)}
    # One qualifying Library occurrence makes this logical album rating-only
    # in all CURRENT Goal periods; no manual/Top completion is fabricated.
    modes={}
    for value in periods.values():
        cycle=value['cycle']['cycle_id'] if value['cycle'] else None
        value['completion_modes']={ref:'rating' if ref in eligible else 'manual' for ref in value['album_refs']}
        for ref,mode in value['completion_modes'].items():modes.setdefault(ref,[]).append(mode)
    return {ref:'rating' for ref,values in modes.items() if all(mode=='rating' for mode in values)}


def requires_rating(connection,live,catalog_ref,cycle_id,*,constraints=None):
    row=connection.execute('''select wa.source_category from app.listening_goal_cycle_sources rs
        join app.listening_goal_cycles c on c.account_id=rs.account_id and c.cycle_id=rs.cycle_id and c.closed_at is null
        join app.listening_goal_weekly_admissions wa on wa.ref=rs.admission_ref
          and wa.account_id=rs.account_id and wa.catalog_ref=rs.catalog_ref
        where rs.account_id=%s and rs.catalog_ref=%s and wa.source_category='library' limit 1''',
        (live.actor.account_id,catalog_ref)).fetchone()
    return bool(row and not has_active_top(connection,live,catalog_ref,constraints))
