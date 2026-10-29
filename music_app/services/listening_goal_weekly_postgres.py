"""Weekly settings and read-only preview on the existing account/library owners.

The schema contract is versioned separately. Never bootstrap it from a request.
Derived local-tag genres and cached-track popularity retain explicit provenance.
"""
from dataclasses import replace
from music_app.services import listening_goal_metadata_postgres as metadata
import json

from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goal_weekly_settings import (
    WeeklySettingsCommand, normalize_weekly_settings_command, normalize_weekly_settings,
    default_weekly_settings)
from music_app.services.listening_goal_weekly_selection import WeeklyAlbum, WeeklySource, preview_week
from music_app.services import album_top_activity_postgres as activity
from music_app.services.album_top_browse import project_native_albums
from music_app.services.owned_album_tops import AlbumTopError, BROWSE
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Tops
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.private_native_targets import allows
from music_app.services.private_album_artwork import album_artwork_url
from music_app.services.policy import ResourceScope

READ = 'account.self.goals.read'
WRITE = 'account.self.goals.write'
MAX_BIGINT = 9223372036854775807


def read_settings(connection, account):
    row = connection.execute('''select revision,settings,allocation_cursor
        from app.listening_goal_weekly_settings where account_id=%s''', (account,)).fetchone()
    return {'settings_revision': str(row['revision']) if row else '1',
            'settings': normalize_weekly_settings(dict(row['settings'])) if row else default_weekly_settings(),
            'allocation_cursor': row['allocation_cursor'] if row else 0}


def save_settings(service, context, command, *, constraints=None):
    if not isinstance(command, WeeklySettingsCommand):
        raise GoalsError('invalid_command')
    command = normalize_weekly_settings_command(command.payload())
    with service._authorized(context, WRITE, constraints) as (connection, live, now):
        account = live.actor.account_id
        prior = connection.execute('''select original_session_id,command_digest,receipt
            from app.listening_goal_operations where account_id=%s and request_key=%s''',
            (account, command.request_key)).fetchone()
        if prior is not None:
            if prior['original_session_id'] != live.actor.session_id:
                raise GoalsError('operation_unavailable', 404)
            if prior['command_digest'] != command.digest:
                raise GoalsError('idempotency_key_reused', 409)
            return dict(prior['receipt'])
        before = read_settings(connection, account)
        if before['settings_revision'] != command.settings_revision:
            raise GoalsError('settings_revision_conflict', 409)
        changed = before['settings'] != command.settings
        current = int(before['settings_revision'])
        if changed:
            if current == MAX_BIGINT:
                raise GoalsError('revision_exhausted', 409)
            current += 1
            connection.execute('''insert into app.listening_goal_weekly_settings
                (account_id,revision,settings,allocation_cursor,created_at,updated_at)
                values(%s,%s,%s::jsonb,0,%s,%s)
                on conflict(account_id) do update set revision=excluded.revision,
                settings=excluded.settings,updated_at=excluded.updated_at''',
                (account, current, json.dumps(command.settings), now, now))
        receipt = {'ok': True, 'action': 'weekly_settings', 'request_key': command.request_key,
                   'changed': changed, 'settings_revision': str(current), 'settings': command.settings}
        connection.execute('''insert into app.listening_goal_operations
            (account_id,request_key,original_session_id,action,command_digest,receipt,committed_at)
            values(%s,%s,%s,'weekly_settings',%s,%s::jsonb,%s)''',
            (account, command.request_key, live.actor.session_id, command.digest, json.dumps(receipt), now))
        return receipt


def _album(row, cover=None, inventory_ref=None, inventory_album_id=None):
    ref=str(row['catalog_ref']) if row['catalog_ref'] is not None else None
    return WeeklyAlbum(ref,row['title'],row['artist_display'],row['release_year'],cover_url=cover,
                       inventory_ref=inventory_ref,inventory_album_id=inventory_album_id)


def read_sources(connection, live, constraints, *, include_library=False):
    rows = connection.execute('''select l.ref from app.album_lists l
        where l.library_id=%s and l.deleted_at is null
          and (l.owner_account_id=%s or l.visibility='server_shared' or exists(
            select 1 from app.album_list_access_grants g where g.top_ref=l.ref
            and g.library_id=l.library_id and g.account_id=%s and g.role in ('editor','viewer')))
        order by l.ref limit 1001''',
        (live.library_id, live.actor.account_id, live.actor.account_id)).fetchall()
    if len(rows) > 1000:
        raise GoalsError('source_pool_too_large', 409)
    sources, total = [], 0
    for row in rows:
        try:
            top = Tops._top(connection, live, str(row['ref']))
            Tops._require(live, (BROWSE,), constraints, top)
        except AlbumTopError as error:
            if error.status_code in (403, 404):
                continue
            raise
        ref = str(top['ref'])
        if not activity.read_activity(connection, live, [ref])[ref]['active']:
            continue
        items = connection.execute('''select i.ref,i.catalog_ref,c.title,c.artist_display,c.release_year,
                p.manual_completed_at
            from app.album_list_items i join catalog.release_groups c on c.ref=i.catalog_ref
            left join app.album_list_item_progress p on p.account_id=%s and p.library_id=i.library_id
                and p.top_ref=i.top_ref and p.catalog_ref=i.catalog_ref
            where i.top_ref=%s and i.library_id=%s order by i.curator_position limit 5001''',
            (live.actor.account_id, ref, live.library_id)).fetchall()
        total += len(items)
        if len(items) > 5000 or total > 50000:
            raise GoalsError('source_pool_too_large', 409)
        native = project_native_albums(connection, live,
            [{'ref':str(i['ref']), 'catalog_ref':str(i['catalog_ref'])} for i in items], constraints=constraints)
        covers = {i['catalog_ref']: i['native_album']['artwork_url'] if i['native_album'] else None for i in native}
        sources.append(WeeklySource('playthroughs' if top.get('listen_through_artist_id') else 'tops',
            ref, top['title'], tuple(_album(i,covers[str(i['catalog_ref'])]) for i in items),
            frozenset(str(i['catalog_ref']) for i in items if i['manual_completed_at'] is not None)))
        # Recheck deployment authority after all awaited source projection work.
        Tops._require(live, (BROWSE,), constraints, top)
    if include_library:
        items=connection.execute('''select a.id as local_album_id,l.catalog_ref,
            coalesce(c.title,a.title) as title,coalesce(c.artist_display,ar.name) as artist_display,
            coalesce(c.release_year,a.release_year) as release_year
            from library.local_albums a join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
            left join library.catalog_album_links l on l.library_id=a.library_id and l.local_album_id=a.id
            left join catalog.release_groups c on c.ref=l.catalog_ref
            where a.library_id=%s and a.album_key is not null and a.album_key<>'' order by a.id limit 50001''',
            (live.library_id,)).fetchall()
        if len(items)>50000:raise GoalsError('source_pool_too_large',409)
        albums=[]
        for item in items:
            identity=item['local_album_id']
            if not allows(live,BROWSE,ResourceScope('album',str(identity)),constraints):continue
            if any(type(item[key]) is not str or not item[key].strip() or len(item[key])>1000 for key in ('title','artist_display')):continue
            year=item['release_year']
            if year is not None and (type(year) is not int or not 1<=year<=9999):item={**item,'release_year':None}
            albums.append(_album(item,album_artwork_url(live,identity,constraints=constraints),
                f'inventory-album:{live.library_id}:{identity}',identity))
        sources.append(WeeklySource('library',None,'Library',tuple(albums)))
    for source in sources:
        if source.top_ref is not None:
            top=Tops._top(connection,live,source.top_ref)
            Tops._require(live,(BROWSE,),constraints,top)
    sources=[replace(source,albums=tuple(replace(album,
        cover_url=album_artwork_url(live,album.inventory_album_id,constraints=constraints))
        for album in source.albums if allows(live,BROWSE,ResourceScope('album',str(album.inventory_album_id)),constraints)))
        if source.source=='library' else source for source in sources]
    return tuple(sources)


def source_snapshot(service, context, *, settings=None, constraints=None):
    source_context = replace(context, library_id=context.actor.current_library_id)
    try:
        with current_library_transaction(service._url, source_context, constraints=constraints,
                connect=service._connect, clock=service._clock, read_only=True) as (connection, live, now):
            service._require(live, READ, constraints)
            saved = read_settings(connection, live.actor.account_id)
            chosen = saved['settings'] if settings is None else normalize_weekly_settings(settings)
            sources = read_sources(connection, live, constraints, include_library='library' in chosen['sources'])
            sources, usual, evidence = metadata.enrich_sources(connection, live, constraints, sources,
                now=now, profile=chosen['discover'], popularity=chosen['selection']=='popular')
            retained = connection.execute('''select catalog_ref from app.listening_goal_albums
                where account_id=%s and current_position is not null limit 50001''',
                (live.actor.account_id,)).fetchall()
            if len(retained) > 50000:
                raise GoalsError('source_pool_too_large', 409)
            excluded = {str(row['catalog_ref']) for row in retained}
            excluded.update(str(row['catalog_ref']) for row in connection.execute('''select catalog_ref
                from app.listening_goal_bonus_eligibility where account_id=%s and completed''',
                (live.actor.account_id,)).fetchall())
            picks = preview_week(chosen, sources, usual_genres=usual, excluded_refs=excluded,
                allocation_cursor=saved['allocation_cursor'], randbelow=service._bonus_randbelow)
            service._require(live, READ, constraints)
            lock_current_actor_session(connection, actor_account_id=live.actor.account_id,
                actor_session_id=live.actor.session_id, clock=service._clock)
            return {'settings_revision':saved['settings_revision'], 'settings':chosen,
                'genres':sorted({g for s in sources for a in s.albums for g in a.genres}),
                'playthroughs':[{'top_ref':s.top_ref,'title':s.title} for s in sources if s.source=='playthroughs'],
                'albums':[{'candidate_ref':p.album.candidate_ref,'catalog_ref':p.album.catalog_ref,'title':p.album.title,
                    'artist_display':p.album.artist_display,'release_year':p.album.release_year,
                    'cover_url':p.album.cover_url,'suggested':p.suggested} for p in picks],
                'summary': summary(chosen),
                'evidence':evidence,
                'evidence_gaps':[key for key,known in (('broad_genres',evidence['known_genre_albums']),
                    ('listening_taste',evidence['taste_state']=='inferred'),
                    ('album_popularity',evidence['known_popularity_albums'])) if not known]}
    except PrivateLibraryAuthorityError:
        raise GoalsError('source_context_unavailable', 403) from None
    except AlbumTopError as error:
        raise GoalsError(error.code,error.status_code) from None


def summary(settings):
    labels=[]
    for rule in settings['filters']:
        kind,value=rule['kind'],rule['value']
        label = value if kind=='genre' else (f'from {value}' if kind=='newer' else
            f'through {value}' if kind=='older' else f'{value}s' if kind=='decade' else str(value))
        labels.append(f'{label}: at most {rule["maximum"]}')
    rows = [f"Your picks: up to {settings['manual_count']} albums." + (' ' + '; '.join(labels[:6]) + ('; more filters applied' if len(labels)>6 else '') + '.' if labels else ''),
            f"Suggestions: {settings['suggestion_count']}; " +
            {'popular':'prefer popular albums (cached track popularity).','random':'random albums.','position':'Position in Top.'}[settings['selection']]]
    if settings['discover']:
        rows.append('Discovery: outside your usual genres; no genre or year preferences.')
    if 'playthroughs' in settings['sources']:
        rows.append('Playthroughs: next unplayed album; balanced with discovery across weeks.' if settings['discover']
                    else 'Playthroughs: next unplayed album.')
    return rows


def require_manual_admission(connection, account, current_refs, catalog_ref, *, context=None, constraints=None, now=None):
    """Validate a new manual member from canonical facts under the account lock."""
    from music_app.services.listening_goal_weekly_settings import manual_admission_allowed
    settings = read_settings(connection, account)['settings']
    refs = sorted(set(current_refs) | {catalog_ref})
    # Canonical facts are SELECT/INSERT-only for runtime; no UPDATE grant is
    # needed merely to read admission facts. Account membership remains locked.
    rows = connection.execute('''select ref as catalog_ref,title,artist_display,release_year
        from catalog.release_groups where ref=any(%s::uuid[]) order by ref''', (refs,)).fetchall()
    facts = {str(row['catalog_ref']):_album(row) for row in rows}
    if set(facts) != set(refs):
        raise GoalsError('album_unavailable', 409)
    if any(rule['kind']=='genre' for rule in settings['filters']):
        if context is None:
            raise GoalsError('weekly_genre_evidence_unavailable',409)
        source = WeeklySource('library',None,'Manual admission',tuple(facts.values()))
        enriched, _, _ = metadata.enrich_sources(connection, context, constraints, (source,),
            now=now, profile=False, popularity=False)
        facts = {album.catalog_ref:album for album in enriched[0].albums}
    if not manual_admission_allowed(settings,[facts[ref] for ref in current_refs],facts[catalog_ref]):
        raise GoalsError('weekly_capacity', 409)
