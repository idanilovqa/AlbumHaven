"""Exact local album taste on caller-owned authority and source transactions."""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timezone

from music_app.services.album_preferences import (
    AlbumPreferenceCommand, AlbumPreferenceError, BROWSE, MANAGE, MAX_ALBUM_IDS,
    parse_album_preference_command, positive_id,
)
from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.album_top_rating_intent import rating_intent_storage_ready
from music_app.services.policy import ResourceScope
from music_app.services.postgres_connections import pooled_connection
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action, PrivateLibraryAuthorityError,
)


def _ids(values: Iterable[int]) -> list[int]:
    if isinstance(values, (str, bytes, dict)):
        raise AlbumPreferenceError('invalid_album_identity')
    result = []
    for value in values:
        if len(result) == MAX_ALBUM_IDS:
            raise AlbumPreferenceError('too_many_albums')
        result.append(positive_id(value))
    return sorted(set(result))


def _transaction_required(connection):
    # Never silently open an independent connection or run the seam autocommit.
    if getattr(connection, 'autocommit', None) is not False:
        raise RuntimeError('Album preferences require a non-autocommit transaction.')


def _lock_sources(connection, *, library_id, album_ids):
    """Lock canonical album, track and active file witnesses in stable ID order.

    Return the locked identity/witness receipt. Later statements may not admit a
    newly appeared, unlocked witness in place of one that failed admission.
    """
    albums = connection.execute('''select id, album_key from library.local_albums
        where library_id=%s and id=any(%s) order by id for share''',
        (library_id, album_ids)).fetchall()
    ids = [r['id'] for r in albums]
    if not ids:
        return {}, []
    tracks = connection.execute('''select id from library.local_tracks
        where library_id=%s and album_id=any(%s) order by id for share''',
        (library_id, ids)).fetchall()
    track_ids = [r['id'] for r in tracks]
    if not track_ids:
        return {}, []
    files = connection.execute('''select id from library.local_track_files
        where track_id=any(%s) and scan_cache_stale is false order by id for share''',
        (track_ids,)).fetchall()
    return {r['id']: r['album_key'] for r in albums}, [r['id'] for r in files]


def _read_locked(connection, *, account_id, library_id, keys, file_ids):
    if not keys or not file_ids:
        return {}
    rows = connection.execute('''select a.id as album_id, a.library_id, a.album_key,
            p.id as preference_id, p.account_id as preference_account_id,
            p.library_id as preference_library_id, p.album_key as preference_key,
            p.rating, p.favorite as favorite_override, p.preference_revision
        from library.local_albums a
        left join app.album_ratings p on p.account_id=%s
            and p.library_id=a.library_id and p.album_key=a.album_key
        where a.library_id=%s and a.id=any(%s) and exists (
            select 1 from library.local_tracks t
            join library.local_track_files f on f.track_id=t.id
            where t.library_id=a.library_id and t.album_id=a.id
                and f.id=any(%s) and f.scan_cache_stale is false)
        order by a.id''', (account_id, library_id, sorted(keys), file_ids)).fetchall()
    result = {}
    for row in rows:
        if keys.get(row['album_id']) != row['album_key']:
            continue
        exists = row['preference_id'] is not None
        if exists and (row['preference_account_id'] != account_id
                or row['preference_library_id'] != library_id
                or row['preference_key'] != row['album_key']):
            raise AlbumPreferenceError('album_preference_conflict', 409)
        override = row['favorite_override']
        result[row['album_id']] = {
            'album_id': row['album_id'], 'album_key': row['album_key'],
            'library_id': library_id, 'account_id': account_id,
            'preference_id': row['preference_id'], 'rating': row['rating'],
            'favorite': override if override is not None else False,
            'favorite_override': override,
            'favorite_source': 'personal' if override is not None else None,
            'preference_revision': row['preference_revision'] if exists else 0,
            'taste_state': 'available',
        }
    return result


def load_album_preferences_on_connection(connection, *, account_id: int,
        library_id: int, album_ids: Iterable[int]) -> dict[int, dict]:
    """Data seam, NOT authorization. Caller owns policy/session final checks.

    Supply only already admitted IDs. Keep the authority/friend guard through
    consumption, recheck current constraints/session, and buffer until commit.
    Missing/foreign/no-active-source IDs are omitted, never false taste evidence.
    """
    positive_id(account_id)
    positive_id(library_id)
    ids = _ids(album_ids)
    _transaction_required(connection)
    if not ids:
        return {}
    keys, files = _lock_sources(connection, library_id=library_id, album_ids=ids)
    return _read_locked(connection, account_id=account_id, library_id=library_id,
                        keys=keys, file_ids=files)


def _require_manage(context, album_id, constraints):
    for resource in (None, ResourceScope('album', str(album_id))):
        for action in (BROWSE, MANAGE):
            require_private_action(context, action, resource=resource, constraints=constraints)


class PostgresAlbumPreferencesStore:
    def __init__(self, config, *, connect=None, clock=None):
        self._url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '').strip()
        if not self._url:
            raise RuntimeError('PostgreSQL configuration is required for album preferences.')
        self._config = config
        self._connect = connect or pooled_connection
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def patch_preference(self, command: AlbumPreferenceCommand, *, context, constraints=None) -> dict:
        """Commit a strict own CAS. Caller rechecks UI context before serialization."""
        if not isinstance(command, AlbumPreferenceCommand):
            raise AlbumPreferenceError('invalid_album_preference_command')
        # Revalidate even manually constructed commands; mapping can never smuggle SET keys.
        command = parse_album_preference_command({
            'album_ref': f'inventory-album:{command.library_id}:{command.album_id}',
            'expected_revision': command.expected_revision, 'patch': command.patch,
        }, library_id=command.library_id)
        try:
            with current_library_transaction(self._url, context, constraints=constraints,
                    connect=self._connect, clock=self._clock) as (connection, live, _):
                _transaction_required(connection)
                if live.library_id != command.library_id:
                    raise AlbumPreferenceError('album_unavailable', 404)
                account_id = positive_id(live.actor.account_id)
                if live.target_account_id is not None and live.target_account_id != account_id:
                    raise AlbumPreferenceError('forbidden', 403)
                _require_manage(live, command.album_id, constraints)
                keys, files = _lock_sources(connection, library_id=command.library_id,
                                            album_ids=[command.album_id])
                state = _read_locked(connection, account_id=account_id, library_id=command.library_id,
                                     keys=keys, file_ids=files).get(command.album_id)
                if state is None:
                    raise AlbumPreferenceError('album_unavailable', 404)
                identity = (account_id, command.library_id, state['album_key'])
                current = connection.execute('''select id, rating, favorite, provenance, preference_revision
                    from app.album_ratings where account_id=%s and library_id=%s and album_key=%s
                    for update''', identity).fetchone()
                revision = current['preference_revision'] if current else 0
                if revision != command.expected_revision:
                    raise AlbumPreferenceError('album_preference_conflict', 409)
                patch = command.patch
                # Default-off optional listening evidence cannot make ordinary
                # ratings depend on an unapplied schema. No probe for favorites.
                record_intent = ('rating' in patch
                    and self._config.get('ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED') is True
                    and rating_intent_storage_ready(connection))
                if current is None:
                    inserted = connection.execute('''insert into app.album_ratings
                        (account_id, library_id, album_key, rating, favorite, provenance)
                        values (%s,%s,%s,%s,%s,%s)
                        on conflict (account_id,library_id,album_key) do nothing returning id''',
                        (*identity, patch.get('rating'), patch.get('favorite'),
                         'personal_rating' if 'rating' in patch else 'personal_preference')).fetchone()
                    if inserted is None:
                        # A missing-only importer/another writer won. Observe after
                        # the conflict wait, but never overwrite its new revision.
                        connection.execute('''select id, preference_revision from app.album_ratings
                            where account_id=%s and library_id=%s and album_key=%s for update''',
                            identity).fetchone()
                        _read_locked(connection, account_id=account_id, library_id=command.library_id,
                                     keys=keys, file_ids=files)
                        raise AlbumPreferenceError('album_preference_conflict', 409)
                    preference_id = inserted['id']
                else:
                    preference_id = current['id']
                    changed = any(current[key] != value for key, value in patch.items())
                    changed = changed or ('rating' in patch and current['provenance'] != 'personal_rating')
                    changed = changed or record_intent
                    if changed:
                        # SET contains ONLY supplied taste fields. Metadata and creation
                        # time are never rewritten; favorite-only preserves provenance.
                        assignments, values = [], []
                        for key in ('rating', 'favorite'):
                            if key in patch:
                                assignments.append(key + '=%s')
                                values.append(patch[key])
                        if 'rating' in patch:
                            assignments.append("provenance='personal_rating'")
                        assignments.extend(['preference_revision=preference_revision+1',
                                            'updated_at=clock_timestamp()'])
                        updated = connection.execute('update app.album_ratings set '
                            + ', '.join(assignments) + ''' where account_id=%s and library_id=%s
                            and album_key=%s and id=%s and preference_revision=%s returning id''',
                            (*values, *identity, preference_id, command.expected_revision)).fetchone()
                        if updated is None:
                            raise AlbumPreferenceError('album_preference_conflict', 409)
                if record_intent:
                    # The CAS above consumed this explicit mutation, including
                    # same-value rerating. A duplicate expected revision cannot
                    # refresh freshness. Null clears rather than qualifies.
                    connection.execute('''update app.album_ratings set native_rating_intent_at=
                        case when rating is null then null else clock_timestamp() end
                        where account_id=%s and library_id=%s and album_key=%s and id=%s''',
                        (*identity, preference_id))
                # New statement after every source/DML/conflict wait. The exact locked
                # canonical generation and active witnesses must still admit this row.
                result = _read_locked(connection, account_id=account_id, library_id=command.library_id,
                                      keys=keys, file_ids=files).get(command.album_id)
                if result is None or result['preference_id'] != preference_id:
                    raise AlbumPreferenceError('album_preference_conflict', 409)
                _require_manage(live, command.album_id, constraints)
                lock_current_actor_session(connection, actor_account_id=account_id,
                    actor_session_id=live.actor.session_id, clock=self._clock)
            return result
        except PrivateLibraryAuthorityError:
            raise AlbumPreferenceError('forbidden', 403) from None
        except AlbumPreferenceError:
            raise
        except Exception as error:
            if getattr(error, 'sqlstate', None) in {'23505', '23503', '40001', '40P01', '55P03'}:
                raise AlbumPreferenceError('album_preference_conflict', 409) from None
            if getattr(error, 'sqlstate', None) == '22003':
                raise AlbumPreferenceError('album_preference_unavailable', 503) from None
            raise
