"""Typed, live-authorized Top admission for account-owned weekly bonus draws.

No library FK owns retained Goals. The Top transaction supplies source authority;
source references and display snapshots are never supplied by the client.
"""
from dataclasses import dataclass, replace
from datetime import timezone
import json
from uuid import uuid4

from music_app.services import listening_goals as domain
from music_app.services import album_top_activity_postgres as activity
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.listening_goal_bonus import BonusPool, choose_bonus
from music_app.services.listening_goal_bonus_settings import project_bonus_settings, SELECTION_ALGORITHM
from music_app.services.listening_goals_commands import GoalsError
from music_app.services.owned_album_tops import AlbumTopError, BROWSE
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Tops
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.remote_album_evidence import _text, RemoteAlbumEvidenceError


@dataclass(frozen=True)
class TopAdmission:
    ref: str
    catalog_ref: str
    title: str
    artist_display: str
    first_release_date: str | None
    primary_type: str | None = None


def replay(connection, account, session, command):
    row = connection.execute('''select original_session_id,command_digest,receipt
        from app.listening_goal_operations where account_id=%s and request_key=%s''',
        (account, command.request_key)).fetchone()
    if row is None:
        return None
    if row['original_session_id'] != session:
        raise GoalsError('operation_unavailable', 404)
    if row['command_digest'] != command.digest:
        raise GoalsError('idempotency_key_reused', 409)
    return dict(row['receipt'])


def cycle_bonus(connection, account, state):
    week = state['periods'].get('week')
    if week is None:
        return None
    return connection.execute('''select catalog_ref,admission_ref from app.listening_goal_bonus_draws
        where account_id=%s and cycle_id=%s''', (account, week['current']['cycle_id'])).fetchone()


def sync_after_command(connection, account, before, after, command, now):
    """Current eligibility is mutable; historical marks and admissions are not."""
    if command.action == 'reset' and command.data['period'] == 'week':
        old = cycle_bonus(connection, account, before)
        week = after['periods'].get('week')
        prior = before['periods'].get('week')
        if (old is not None and week is not None and prior is not None
                and week['current']['cycle_id'] != prior['current']['cycle_id']
                and str(old['catalog_ref']) in week['current']['album_refs']):
            connection.execute('''insert into app.listening_goal_bonus_draws
                (account_id,goal_ref,cycle_id,catalog_ref,admission_ref,captured_at)
                values(%s,%s,%s,%s,%s,%s)''', (account, after['top_ref'],
                    week['current']['cycle_id'], old['catalog_ref'], old['admission_ref'], now))
    if command.action not in {'completion', 'reset'}:
        return
    period = command.data['period']
    selected = before['periods'].get(period)
    if selected is None:
        return
    affected = ([command.data['catalog_ref']] if command.action == 'completion'
                else list(selected['current']['album_refs']))
    if not affected:
        return
    known = connection.execute('''select distinct on(catalog_ref) catalog_ref,ref
        from app.listening_goal_top_admissions where account_id=%s and catalog_ref=any(%s::uuid[])
        order by catalog_ref,admitted_at,ref''', (account, affected)).fetchall()
    completed = {ref for value in after['periods'].values()
                 for ref in value['current']['completion'].get(str(account), {})}
    for row in known:
        ref = str(row['catalog_ref'])
        connection.execute('''insert into app.listening_goal_bonus_eligibility
            (account_id,catalog_ref,admission_ref,completed,updated_at) values(%s,%s,%s,%s,%s)
            on conflict(account_id,catalog_ref) do update set completed=excluded.completed,updated_at=excluded.updated_at''',
            (account, ref, row['ref'], ref in completed, now))


def _pools(connection, live, settings, excluded, constraints):
    chosen = settings['selected_top_refs'] if settings['source_mode'] == 'selected' else None
    if chosen == []:
        return (), {}
    # Enumeration fixes a bounded source population; every candidate is locked
    # and reauthorized below. Never sample the first page and call that 'all'.
    rows = connection.execute('''select l.ref from app.album_lists l where l.library_id=%s and l.deleted_at is null
        and (%s::uuid[] is null or l.ref=any(%s::uuid[]))
        and (l.owner_account_id=%s or l.visibility='server_shared' or exists(
            select 1 from app.album_list_access_grants g where g.top_ref=l.ref
              and g.library_id=l.library_id and g.account_id=%s and g.role in ('editor','viewer')))
        order by l.ref limit 1001''', (live.library_id, chosen, chosen,
                                    live.actor.account_id, live.actor.account_id)).fetchall()
    if len(rows) > 1000:
        raise GoalsError('source_pool_too_large', 409)
    pools, facts, total = [], {}, 0
    for row in rows:
        ref = str(row['ref'])
        try:
            top = Tops._top(connection, live, ref)
            Tops._require(live, (BROWSE,), constraints, top)
        except AlbumTopError as error:
            if error.status_code in {403, 404}:
                continue
            raise
        state = activity.read_activity(connection, live, [ref])[ref]
        if not state['active']:
            continue
        items = connection.execute('''select i.ref as item_ref,i.catalog_ref,i.curator_position,
                c.title,c.artist_display,c.release_year,p.manual_completed_at
            from app.album_list_items i join catalog.release_groups c on c.ref=i.catalog_ref
            left join app.album_list_item_progress p on p.account_id=%s and p.library_id=i.library_id
                and p.top_ref=i.top_ref and p.catalog_ref=i.catalog_ref
            where i.top_ref=%s and i.library_id=%s order by i.curator_position
            limit 5001''', (live.actor.account_id, ref, live.library_id)).fetchall()
        total += len(items)
        if len(items) > 5000 or total > 50000:
            raise GoalsError('source_pool_too_large', 409)
        eligible = []
        for item in items:
            catalog = str(item['catalog_ref'])
            if catalog in excluded or item['manual_completed_at'] is not None:
                continue
            eligible.append(catalog)
            facts[(ref, catalog)] = (top, state, item)
        pools.append(BonusPool(ref, ref in settings['preferred_top_refs'], tuple(eligible)))
    return tuple(pools), facts


def draw(service, context, command, *, constraints=None):
    # The caller already completed a short account-authorized replay check.
    # This is a NEW transaction using the existing current-library authority
    # owner, never a second connection nested under an account lock.
    source_context = replace(context, library_id=context.actor.current_library_id)
    try:
        with current_library_transaction(service._url, source_context, constraints=constraints,
                connect=service._connect, clock=service._clock) as (connection, live, now):
            service._require(live, 'account.self.goals.write', constraints)
            account = live.actor.account_id
            prior = replay(connection, account, live.actor.session_id, command)
            if prior is not None:
                result = prior
            else:
                result = _new_draw(service, connection, live, command, now, constraints)
            service._require(live, 'account.self.goals.write', constraints)
            lock_current_actor_session(connection, actor_account_id=account,
                actor_session_id=live.actor.session_id, clock=service._clock)
            return result
    except PrivateLibraryAuthorityError:
        raise GoalsError('source_context_unavailable', 403) from None
    except AlbumTopError as error:
        raise GoalsError(error.code, error.status_code) from None
    except domain.GoalsDomainError as error:
        raise GoalsError(error.code, 409) from None
    except Exception as error:
        if getattr(error, 'sqlstate', None) in {'23505', '23503', '40001', '40P01'}:
            raise GoalsError('concurrent_change', 409) from None
        raise


def _new_draw(service, connection, live, command, now, constraints):
    account = live.actor.account_id
    row = connection.execute('select * from app.listening_goal_bonus_settings where account_id=%s', (account,)).fetchone()
    settings = project_bonus_settings(row)
    if settings['settings_revision'] != command.settings_revision:
        raise GoalsError('settings_revision_conflict', 409)
    if not settings['enabled']:
        raise GoalsError('bonus_disabled', 409)
    aggregate, before, _ = service._load(connection, account)
    revision = aggregate['revision'] if aggregate else 1
    if str(revision) != command.revision:
        raise GoalsError('revision_conflict', 409)
    week = before['periods'].get('week')
    cycle = week['current']['cycle_id'] if week else None
    if cycle != command.expected_cycle_id:
        raise GoalsError('stale_cycle', 409)
    captured = cycle_bonus(connection, account, before)
    catalog, changed, reason = None, False, 'no_eligible_source'
    after = before
    if captured is not None:
        catalog, reason = str(captured['catalog_ref']), 'bonus_already_drawn'
    else:
        if week is not None and len(week['current']['album_refs']) > 5:
            raise GoalsError('weekly_capacity', 409)
        excluded = set(before['album_refs'])
        excluded.update(str(row['catalog_ref']) for row in connection.execute('''select catalog_ref
            from app.listening_goal_bonus_eligibility where account_id=%s and completed''', (account,)).fetchall())
        pools, facts = _pools(connection, live, settings, excluded, constraints)
        # All source waits precede the authoritative command time/session fence.
        now = lock_current_actor_session(connection, actor_account_id=account,
            actor_session_id=live.actor.session_id, clock=service._clock)
        chosen = choose_bonus(pools, album_mode=settings['album_mode'], randbelow=service._bonus_randbelow)
        if chosen is not None:
            if revision == 9223372036854775807:
                raise GoalsError('revision_exhausted', 409)
            top_ref, catalog = chosen
            top, state, item = facts[chosen]
            try:
                title, artist = _text(item['title']), _text(item['artist_display'])
            except RemoteAlbumEvidenceError:
                raise GoalsError('invalid_source_metadata', 409) from None
            year = item['release_year']
            if year is not None and (type(year) is not int or not 1 <= year <= 9999):
                raise GoalsError('invalid_source_metadata', 409)
            admission = TopAdmission(str(uuid4()), catalog, title, artist, f'{year:04d}' if year else None)
            connection.execute('''insert into app.listening_goal_top_admissions
                (ref,account_id,catalog_ref,source_library_id,source_top_ref,source_item_ref,
                 source_top_revision,source_activity_revision,settings_revision,algorithm,
                 title,artist_display,first_release_date,admitted_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (admission.ref,account,catalog,live.library_id,top_ref,item['item_ref'],top['revision'],
                 int(state['activity_revision']),int(command.settings_revision),SELECTION_ALGORITHM,
                 title,artist,admission.first_release_date,now))
            result = domain.add_goal(before, album_ref=catalog, period='week', assignment_id=str(uuid4()),
                occurred_at=now, timezone_name=command.timezone_name,
                cycle_ids={name: str(uuid4()) for name in domain.GOAL_PERIODS})
            if not result['changed']:
                raise RuntimeError('Eligible bonus unexpectedly duplicated an assignment')
            after, changed, reason = result['state'], True, ''
            revision += 1
            service._persist(connection, account, before, after, evidence=None, top_admission=admission,
                             now=now, revision=revision, exists=aggregate is not None)
            cycle = after['periods']['week']['current']['cycle_id']
            connection.execute('''insert into app.listening_goal_bonus_draws
                (account_id,goal_ref,cycle_id,catalog_ref,admission_ref,captured_at)
                values(%s,%s,%s,%s,%s,%s)''', (account,after['top_ref'],cycle,catalog,admission.ref,now))
    receipt = {'ok': True, 'action': 'bonus_draw', 'request_key': command.request_key,
               'changed': changed, 'reason': reason, 'goal_ref': after['top_ref'] if aggregate or changed else None,
               'revision': str(revision), 'period': 'week', 'cycle_id': cycle, 'catalog_ref': catalog}
    connection.execute('''insert into app.listening_goal_operations
        (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
        values(%s,%s,%s,'bonus_draw',%s,%s::jsonb,%s)''',
        (account,command.request_key,live.actor.session_id,command.digest,json.dumps(receipt),now))
    return receipt
