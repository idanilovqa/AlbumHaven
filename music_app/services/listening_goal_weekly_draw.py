"""Confirmed multi-slot weekly suggestion draw; all writes share one transaction."""
from dataclasses import dataclass, replace
import hashlib
import json
from uuid import uuid4

from music_app.services.listening_goal_bonus import BonusDrawCommand, normalize_bonus_draw
from music_app.services.listening_goal_bonus_postgres import replay, cycle_bonus
from music_app.services.listening_goal_weekly_selection import choose_weekly_suggestions
from music_app.services import listening_goal_weekly_postgres as weekly
from music_app.services import listening_goals as domain
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.owned_album_tops import AlbumTopError, BROWSE
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Tops
from music_app.services import album_top_activity_postgres as activity
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.album_top_browse import project_native_albums
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.remote_album_evidence import _text, RemoteAlbumEvidenceError


@dataclass(frozen=True)
class WeeklyDrawCommand(BonusDrawCommand):
    @property
    def digest(self):
        return hashlib.sha256(json.dumps({'action':'weekly_draw',**self.payload()},
            sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()


def normalize_weekly_draw(payload):
    command=normalize_bonus_draw(payload)
    return WeeklyDrawCommand(**command.payload())


@dataclass(frozen=True)
class WeeklyAdmission:
    ref:str
    catalog_ref:str
    title:str
    artist_display:str
    first_release_date:str|None
    primary_type:str|None=None


def cycle_draws(connection,account,cycle):
    if cycle is None:return []
    return connection.execute('''select catalog_ref,admission_ref,slot,objective from app.listening_goal_weekly_draws
        where account_id=%s and cycle_id=%s order by slot''',(account,cycle)).fetchall()


def _admit(connection,live,pick,settings_revision,now,constraints):
    album=pick.album
    top_revision=activity_revision=None
    item_ref=local_album_id=None
    if pick.source in ('tops','playthroughs'):
        top=Tops._top(connection,live,pick.top_ref)
        Tops._require(live,(BROWSE,),constraints,top)
        state=activity.read_activity(connection,live,[pick.top_ref])[pick.top_ref]
        if not state['active']:raise GoalsError('source_context_unavailable',409)
        item=connection.execute('''select ref from app.album_list_items where library_id=%s
            and top_ref=%s and catalog_ref=%s for share''',
            (live.library_id,pick.top_ref,album.catalog_ref)).fetchone()
        if item is None:raise GoalsError('source_context_unavailable',409)
        item_ref=str(item['ref']);top_revision=top['revision'];activity_revision=int(state['activity_revision'])
    else:
        if album.catalog_ref is None:
            from music_app.services.local_album_catalog_admission import admit_local_album
            ref=admit_local_album(connection,live,album.inventory_album_id,constraints=constraints)
            facts=connection.execute('''select title,artist_display,release_year from catalog.release_groups
                where ref=%s''',(ref,)).fetchone()
            if facts is None:raise GoalsError('source_context_unavailable',409)
            album=replace(album,catalog_ref=ref,title=facts['title'],artist_display=facts['artist_display'],release_year=facts['release_year'])
        # Link/catalog rows are append-only to this role; lock the mutable
        # local album parent only, then re-resolve the exact native binding.
        row=connection.execute('''select l.local_album_id from library.catalog_album_links l
            join library.local_albums a on a.id=l.local_album_id and a.library_id=l.library_id
            where l.library_id=%s and l.catalog_ref=%s for share of a''',
            (live.library_id,album.catalog_ref)).fetchone()
        if row is None:raise GoalsError('source_context_unavailable',409)
        projected=project_native_albums(connection,live,[{'ref':album.catalog_ref,'catalog_ref':album.catalog_ref}],constraints=constraints)
        if not projected[0]['native_album']:raise GoalsError('source_context_unavailable',403)
        local_album_id=row['local_album_id']
    try:title,artist=_text(album.title),_text(album.artist_display)
    except RemoteAlbumEvidenceError:raise GoalsError('invalid_source_metadata',409) from None
    admission=WeeklyAdmission(str(uuid4()),album.catalog_ref,title,artist,
                              f'{album.release_year:04d}' if album.release_year else None)
    connection.execute('''insert into app.listening_goal_weekly_admissions
        (ref,account_id,catalog_ref,source_category,source_library_id,source_top_ref,source_item_ref,
         source_local_album_id,source_top_revision,source_activity_revision,settings_revision,
         title,artist_display,first_release_date,admitted_at)
        values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
        (admission.ref,live.actor.account_id,album.catalog_ref,pick.source,live.library_id,pick.top_ref,
         item_ref,local_album_id,top_revision,activity_revision,int(settings_revision),title,artist,
         admission.first_release_date,now))
    return admission


def draw(service,context,command,*,constraints=None):
    if not isinstance(command,WeeklyDrawCommand):raise GoalsError('invalid_command')
    command=normalize_weekly_draw(command.payload())
    # Replays do not need their old source library to still exist.
    with service._authorized(context,weekly.WRITE,constraints) as (connection,live,_):
        prior=replay(connection,live.actor.account_id,live.actor.session_id,command)
        if prior is not None:return prior
    source_context=replace(context,library_id=context.actor.current_library_id)
    try:
        with current_library_transaction(service._url,source_context,constraints=constraints,
                connect=service._connect,clock=service._clock) as (connection,live,now):
            service._require(live,weekly.WRITE,constraints)
            prior=replay(connection,live.actor.account_id,live.actor.session_id,command)
            if prior is not None:return prior
            result=_draw(service,connection,live,command,now,constraints)
            service._require(live,weekly.WRITE,constraints)
            lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id,clock=service._clock)
            return result
    except PrivateLibraryAuthorityError:raise GoalsError('source_context_unavailable',403) from None
    except AlbumTopError as error:raise GoalsError(error.code,error.status_code) from None
    except domain.GoalsDomainError as error:raise GoalsError(error.code,409) from None
    except Exception as error:
        if getattr(error,'sqlstate',None) in ('23505','23503','40001','40P01'):
            raise GoalsError('concurrent_change',409) from None
        raise


def _draw(service,connection,live,command,now,constraints):
    account=live.actor.account_id
    saved=weekly.read_settings(connection,account)
    if saved['settings_revision']!=command.settings_revision:raise GoalsError('settings_revision_conflict',409)
    settings=saved['settings']
    aggregate,before,_=service._load(connection,account)
    revision=aggregate['revision'] if aggregate else 1
    if str(revision)!=command.revision:raise GoalsError('revision_conflict',409)
    week=before['periods'].get('week')
    cycle=week['current']['cycle_id'] if week else None
    if cycle!=command.expected_cycle_id:raise GoalsError('stale_cycle',409)
    captured=cycle_draws(connection,account,cycle)
    if not captured and cycle_bonus(connection,account,before) is not None:
        captured=[{'legacy':True}]
    after=before
    refs=[]
    reason='already_drawn' if captured else ('no_suggestion_slots' if not settings['suggestion_count'] else 'no_eligible_source')
    changed=False
    if not captured and settings['suggestion_count']:
        members=week['current']['album_refs'] if week else []
        capacity=7-len(members)
        if capacity<settings['suggestion_count'] or len(members)>settings['manual_count']:
            raise GoalsError('weekly_capacity',409)
        sources=weekly.read_sources(connection,live,constraints,include_library='library' in settings['sources'])
        sources,usual,_=weekly.metadata.enrich_sources(connection,live,constraints,sources,
            now=now,profile=settings['discover'],popularity=settings['selection']=='popular')
        excluded=set(before['album_refs'])
        excluded.update(str(row['catalog_ref']) for row in connection.execute('''select catalog_ref
            from app.listening_goal_bonus_eligibility where account_id=%s and completed''',(account,)).fetchall())
        picks,cursor=choose_weekly_suggestions(settings,sources,usual_genres=usual,excluded_refs=excluded,
            allocation_cursor=saved['allocation_cursor'],randbelow=service._bonus_randbelow)
        if picks and revision==weekly.MAX_BIGINT or cursor>weekly.MAX_BIGINT:
            raise GoalsError('revision_exhausted',409)
        now=lock_current_actor_session(connection,actor_account_id=account,
            actor_session_id=live.actor.session_id,clock=service._clock)
        admissions=[]
        for pick in picks:
            admission=_admit(connection,live,pick,command.settings_revision,now,constraints)
            if admission.catalog_ref in after['album_refs']:
                raise GoalsError('source_context_unavailable',409)
            result=domain.add_goal(after,album_ref=admission.catalog_ref,period='week',assignment_id=str(uuid4()),
                occurred_at=now,timezone_name=command.timezone_name,
                cycle_ids={name:str(uuid4()) for name in domain.GOAL_PERIODS})
            if not result['changed']:raise RuntimeError('Eligible weekly suggestion duplicated membership')
            after=result['state'];admissions.append(admission);refs.append(admission.catalog_ref)
        if picks:
            revision+=1
            service._persist(connection,account,before,after,evidence=None,weekly_admissions=admissions,
                now=now,revision=revision,exists=aggregate is not None)
            cycle=after['periods']['week']['current']['cycle_id']
            for slot,(pick,admission) in enumerate(zip(picks,admissions)):
                connection.execute('''insert into app.listening_goal_weekly_draws
                    (account_id,goal_ref,cycle_id,slot,catalog_ref,admission_ref,objective,allocation_cursor_used,captured_at)
                    values(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (account,after['top_ref'],cycle,slot,admission.catalog_ref,admission.ref,pick.objective,
                     saved['allocation_cursor']+slot,now))
        if picks:
            connection.execute('''insert into app.listening_goal_weekly_settings
                (account_id,revision,settings,allocation_cursor,created_at,updated_at)
                values(%s,%s,%s::jsonb,%s,%s,%s) on conflict(account_id) do update set
                allocation_cursor=excluded.allocation_cursor,updated_at=excluded.updated_at''',
                (account,int(saved['settings_revision']),json.dumps(settings),cursor,now,now))
            # Source constraints are rechecked after every admission/persistence
            # wait, not only before the first pick. Top locks retain membership.
            for pick,admission in zip(picks,admissions):
                if pick.top_ref is not None:
                    top=Tops._top(connection,live,pick.top_ref)
                    Tops._require(live,(BROWSE,),constraints,top)
                else:
                    projected=project_native_albums(connection,live,[{'ref':admission.catalog_ref,
                        'catalog_ref':admission.catalog_ref}],constraints=constraints)
                    if not projected[0]['native_album']:raise GoalsError('source_context_unavailable',403)
            changed=True;reason=''
    receipt={'ok':True,'action':'weekly_draw','request_key':command.request_key,'changed':changed,'reason':reason,
        'goal_ref':after['top_ref'] if aggregate or changed else None,'revision':str(revision),
        'period':'week','cycle_id':cycle,'catalog_refs':refs}
    connection.execute('''insert into app.listening_goal_operations
        (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
        values(%s,%s,%s,'weekly_draw',%s,%s::jsonb,%s)''',
        (account,command.request_key,live.actor.session_id,command.digest,json.dumps(receipt),now))
    return receipt


def retain_after_reset(connection,account,before,after,now):
    prior=before['periods'].get('week');current=after['periods'].get('week')
    if not prior or not current or prior['current']['cycle_id']==current['current']['cycle_id']:return
    members=current['current']['album_refs']
    if not members:return
    connection.execute('''insert into app.listening_goal_weekly_draws
        (account_id,goal_ref,cycle_id,slot,catalog_ref,admission_ref,objective,allocation_cursor_used,captured_at)
        select account_id,goal_ref,%s,slot,catalog_ref,admission_ref,objective,allocation_cursor_used,%s
        from app.listening_goal_weekly_draws where account_id=%s and cycle_id=%s and catalog_ref=any(%s::uuid[])''',
        (current['current']['cycle_id'],now,account,prior['current']['cycle_id'],members))
