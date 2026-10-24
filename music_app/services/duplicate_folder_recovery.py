"""Library-owned duplicate folder trash. Personal data and identities are untouched."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
from uuid import UUID

from music_app.models.library import Album, Track
from music_app.services.library import get_album_duplicate_sources
from music_app.services.private_library_authority import current_library_transaction, require_private_action
from music_app.services.postgres_connections import pooled_connection
from music_app.services.duplicate_folder_guard import RECOVERY_STORAGE_READY_SQL
from music_app.services.duplicate_folder_files import DuplicateFolderError, snapshot, move_no_replace

ACTION = 'library.inventory.manage'
MAX_TRACKS = 2048
MAX_PLAN_BYTES = 2 * 1024 * 1024


def _uuid(value):
    try:
        result = str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise DuplicateFolderError('invalid_operation', 400) from None
    if result != value:
        raise DuplicateFolderError('invalid_operation', 400)
    return result


def _positive(value):
    if type(value) is not int or value <= 0:
        raise DuplicateFolderError('invalid_source', 400)
    return value


def _serialized_plan(plan):
    value = json.dumps(plan, sort_keys=True, separators=(',', ':'))
    if len(value.encode('utf-8')) > MAX_PLAN_BYTES:
        raise DuplicateFolderError('plan_metadata_too_large')
    return value


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _one(connection, sql, params=()):
    cursor = connection.execute(sql, params)
    try:
        return cursor.fetchone()
    finally:
        cursor.close()


def _all(connection, sql, params=()):
    cursor = connection.execute(sql, params)
    try:
        return cursor.fetchall()
    finally:
        cursor.close()


def _write(connection, sql, params=()):
    cursor = connection.execute(sql, params)
    try:
        return cursor.rowcount
    finally:
        cursor.close()


class DuplicateFolderRecovery:
    def __init__(self, config, *, connect=None):
        self.config = config
        self.url = str(config.get('ALBUM_HAVEN_APP_DATABASE_URL') or '')
        self.connect = connect or pooled_connection
        self.extensions = {str(x).casefold() for x in config.get('SUPPORTED_EXTENSIONS', ())}

    @contextmanager
    def _authorized(self, context, constraints, *, connect=None):
        if self.config.get('ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED') is not True:
            raise DuplicateFolderError('trash_unavailable', 503)
        with current_library_transaction(self.url, context, constraints=constraints,
                                        connect=connect or self.connect) as (connection, live, now):
            require_private_action(live, ACTION, constraints=constraints)
            if live.client_surface_class in ('mobile', 'tv'):
                raise DuplicateFolderError('unsupported_surface', 403)
            ready = _one(connection, RECOVERY_STORAGE_READY_SQL)
            if not ready or not ready['name'] or not ready['guard_ready'] or not ready['index_ready'] or not ready['schema_ready']:
                raise DuplicateFolderError('trash_storage_unavailable', 503)
            yield connection, live

    def _rows(self, connection, library_id, album_key, *, allow_empty=False):
        rows = _all(connection, '''select f.id as file_id,f.track_id,f.private_path,
            f.library_root_id,r.root_path,a.id as album_id,t.title,t.disc_number,t.track_number,
            t.duration_seconds,t.metadata,a.title as album_title,a.release_year
            from library.local_albums a join library.local_tracks t on t.album_id=a.id
            and t.library_id=a.library_id join library.local_track_files f on f.track_id=t.id
            join library.library_roots r on r.id=f.library_root_id and r.library_id=a.library_id
            where a.library_id=%s and a.album_key=%s and r.is_active=true
            and f.scan_cache_stale=false order by f.id limit %s''',
            (library_id, album_key, MAX_TRACKS + 1))
        if (not rows and not allow_empty) or len(rows) > MAX_TRACKS:
            raise DuplicateFolderError('album_unavailable')
        return rows

    @staticmethod
    def _sources(rows, album_key):
        if not rows:
            return []
        tracks = []
        for row in rows:
            metadata = row['metadata'] if isinstance(row['metadata'], dict) else {}
            tracks.append(Track(path=Path(row['private_path']), title=row['title'],
                track_number=row['track_number'], disc_number=row['disc_number'],
                duration_seconds=row['duration_seconds'], artist=metadata.get('artist'),
                album=row['album_title'], album_artist=metadata.get('album_artist'),
                year=row['release_year'], edition=metadata.get('edition')))
        return get_album_duplicate_sources(Album(key=album_key, name=rows[0]['album_title'],
                                                  album_artist='', tracks=tracks))

    def _plan(self, connection, context, album_key, keep_id, remove_id):
        keep_id, remove_id = _positive(keep_id), _positive(remove_id)
        rows = self._rows(connection, context.library_id, album_key)
        sources = self._sources(rows, album_key)
        by_id = {row['file_id']: row for row in rows}
        if keep_id not in by_id or remove_id not in by_id:
            raise DuplicateFolderError('source_changed')
        def source_for(file_id):
            path = by_id[file_id]['private_path']
            matches = [source for source in sources if any(str(track['path']) == path for track in source['tracks'])]
            if len(matches) != 1:
                raise DuplicateFolderError('source_changed')
            return Path(matches[0]['folder_path'])
        keep, remove = source_for(keep_id), source_for(remove_id)
        if keep == remove or keep in remove.parents or remove in keep.parents:
            raise DuplicateFolderError('overlapping_folders')
        moved = [row for row in rows if remove in Path(row['private_path']).parents]
        retained = [row for row in rows if keep in Path(row['private_path']).parents]
        roots = {row['library_root_id'] for row in moved}
        if len(roots) != 1 or not self.extensions:
            raise DuplicateFolderError('source_changed')
        root = Path(moved[0]['root_path'])
        if root not in remove.parents:
            raise DuplicateFolderError('invalid_folder')
        # Trash is outside every active music root, so a scanner cannot import it.
        trash_root = root.parent / ('.albumhaven-trash-' + str(moved[0]['library_root_id']))
        all_roots = _all(connection, 'select root_path from library.library_roots where is_active=true limit 1025')
        if len(all_roots) > 1024:
            raise DuplicateFolderError('too_many_library_roots')
        for item in all_roots:
            other = Path(item['root_path'])
            if other == trash_root or other in trash_root.parents or trash_root in other.parents:
                raise DuplicateFolderError('trash_overlaps_library')
        # private_path is unique in native inventory. The bounded full folder
        # walk rejects every additional audio file, avoiding a root-wide DB scan.
        remove_snapshot = snapshot(remove, expected_music=[row['private_path'] for row in moved], music_extensions=self.extensions)
        keep_snapshot = snapshot(keep, expected_music=[row['private_path'] for row in retained], music_extensions=self.extensions)
        plan = {'album_id': rows[0]['album_id'], 'album_key': album_key,
                'keep_id': keep_id, 'remove_id': remove_id, 'source': str(remove), 'keep': str(keep),
                'root_id': moved[0]['library_root_id'], 'root': str(root), 'trash_root': str(trash_root),
                'files': [{'id': row['file_id'], 'track_id': row['track_id'], 'path': row['private_path']} for row in moved],
                'source_snapshot': remove_snapshot, 'keep_snapshot': keep_snapshot,
                'keep_roots': sorted({(row['library_root_id'], row['root_path']) for row in retained}),
                'keep_files': [{'id': row['file_id'], 'track_id': row['track_id'], 'path': row['private_path'], 'root_id': row['library_root_id']}
                               for row in retained]}
        serialized = _serialized_plan(plan)
        return plan, hashlib.sha256(serialized.encode('utf-8')).hexdigest()

    def preview(self, context, constraints, album_key, keep_id, remove_id):
        with self._authorized(context, constraints) as (connection, live):
            plan, fingerprint = self._plan(connection, live, album_key, keep_id, remove_id)
            return {'fingerprint': fingerprint, 'keep': Path(plan['keep']).name,
                    'remove': Path(plan['source']).name, 'track_count': len(plan['files']),
                    'file_count': plan['source_snapshot']['file_count']}

    def choices(self, context, constraints, album_key):
        with self._authorized(context, constraints) as (connection, live):
            album = _one(connection, 'select id from library.local_albums where library_id=%s and album_key=%s',
                         (live.library_id, album_key))
            if not album:
                raise DuplicateFolderError('album_unavailable')
            rows = self._rows(connection, live.library_id, album_key, allow_empty=True)
            by_path = {row['private_path']: row['file_id'] for row in rows}
            groups = {source['folder_path']: by_path[str(source['tracks'][0]['path'])]
                      for source in self._sources(rows, album_key)}
            operations = _all(connection, """select operation_id,state,
                plan->>'album_key' as album_key,jsonb_array_length(plan->'files') as track_count
                from library.duplicate_folder_trash
                where library_id=%s and album_id=%s and state<>'restored'
                order by created_at desc limit 100""",
                (live.library_id, album['id']))
            return {'sources': [{'id': identifier, 'label': Path(folder).name, 'path': folder}
                                for folder, identifier in sorted(groups.items())],
                    'operations': [{'operation_id': str(row['operation_id']), 'state': row['state'],
                                    'album_key': row['album_key'], 'track_count': row['track_count']}
                                   for row in operations]}

    @contextmanager
    def _operation_connection(self):
        # Existing inventory publication key serializes against scans, including
        # across durable intent and outcome commits. It is released on disconnect.
        with self.connect(self.url) as connection:
            _write(connection, "set lock_timeout='1000ms'")
            _write(connection, "select pg_advisory_lock(hashtext('album-haven:local-inventory-publication'))")
            connection.commit()
            try:
                yield connection
            finally:
                connection.rollback()
                _write(connection, "select pg_advisory_unlock(hashtext('album-haven:local-inventory-publication'))")
                connection.commit()

    def trash(self, context, constraints, command):
        operation_id = _uuid(command.get('operation_id'))
        with self._operation_connection() as connection:
            @contextmanager
            def transaction(_):
                with connection.transaction():
                    yield connection
            with self._authorized(context, constraints, connect=transaction) as (tx, live):
                existing = _one(tx, '''select * from library.duplicate_folder_trash
                    where operation_id=%s and library_id=%s for update''',
                    (operation_id, live.library_id))
                if existing:
                    if existing['actor_account_id'] != live.actor.account_id or existing['request_digest'] != _digest(command):
                        raise DuplicateFolderError('operation_conflict')
                    return self._status(existing)
                plan, fingerprint = self._plan(tx, live, command.get('album_key'),
                                               command.get('keep_id'), command.get('remove_id'))
                if fingerprint != command.get('fingerprint'):
                    raise DuplicateFolderError('preview_changed')
                active = _all(tx, '''select operation_id from library.duplicate_folder_trash
                    where library_id=%s and album_id=%s and state<>'restored' limit 100''',
                    (live.library_id, plan['album_id']))
                if len(active) >= 100:
                    raise DuplicateFolderError('restore_existing_copies_first')
                destination = str(Path(plan['trash_root']) / operation_id)
                _write(tx, '''insert into library.duplicate_folder_trash
                    (operation_id,library_id,actor_account_id,album_id,request_digest,plan,destination,source_paths,state)
                    values (%s,%s,%s,%s,%s,%s::jsonb,%s,%s,'pending_trash')''',
                    (operation_id, live.library_id, live.actor.account_id, plan['album_id'],
                     _digest(command), _serialized_plan(plan), destination, [item['path'] for item in plan['files']]))
                self._set_unavailable(tx, plan, True)
                self._bump_revision(tx, live.library_id)
            # Intent and unavailability are committed before touching the filesystem.
            return self._finish(connection, context, constraints, operation_id, restore=False)

    @staticmethod
    def _set_unavailable(connection, plan, unavailable):
        # scan_cache_stale is GENERATED ALWAYS from this existing JSON input.
        _write(connection, """update library.local_track_files set metadata=jsonb_set(
            coalesce(metadata,'{}'::jsonb), '{scan_cache}',
            coalesce(metadata->'scan_cache','{}'::jsonb) || jsonb_build_object('stale',%s), true)
            where id=any(%s)""", (unavailable, [row['id'] for row in plan['files']]))

    @staticmethod
    def _bump_revision(connection, library_id):
        row = _one(connection, '''update library.libraries set metadata=coalesce(metadata,'{}'::jsonb)
            || jsonb_build_object('inventory_mutation_revision',
                coalesce(nullif(metadata->>'inventory_mutation_revision','')::bigint,0)+1), updated_at=now()
            where id=%s returning (metadata->>'inventory_mutation_revision')::bigint as revision''',
            (library_id,))
        return row['revision']

    @staticmethod
    def _status(row):
        return {'operation_id': str(row['operation_id']), 'state': row['state'],
                'album_key': row['plan']['album_key'], 'track_count': len(row['plan']['files'])}

    def recover(self, context, constraints, operation_id, *, restore=False):
        operation_id = _uuid(operation_id)
        with self._operation_connection() as connection:
            return self._finish(connection, context, constraints, operation_id, restore=restore)

    def _finish(self, connection, context, constraints, operation_id, *, restore):
        @contextmanager
        def transaction(_):
            with connection.transaction():
                yield connection
        with self._authorized(context, constraints, connect=transaction) as (tx, live):
            row = _one(tx, '''select * from library.duplicate_folder_trash
                where operation_id=%s and library_id=%s for update''',
                (operation_id, live.library_id))
            if not row:
                raise DuplicateFolderError('operation_not_found', 404)
            plan = row['plan']
            _serialized_plan(plan)  # Refuse malformed/oversized historical plans before any move.
            if row['state'] == 'pending_restore':
                restore = True
            if row['state'] == 'restored' or not restore and row['state'] == 'trashed':
                return self._status(row)
            if restore and row['state'] not in ('pending_trash', 'trashed', 'pending_restore'):
                raise DuplicateFolderError('reconcile_required')
            if not restore and row['state'] != 'pending_trash':
                raise DuplicateFolderError('reconcile_required')
            root = _one(tx, 'select root_path,is_active from library.library_roots where id=%s and library_id=%s for share',
                              (plan['root_id'], live.library_id))
            if not root or root['is_active'] is not True or root['root_path'] != plan['root']:
                raise DuplicateFolderError('root_changed')
            if restore:
                _write(tx, "update library.duplicate_folder_trash set state='pending_restore' where operation_id=%s", (operation_id,))
        with self._authorized(context, constraints, connect=transaction) as (tx, live):
            # Revalidate current authority and unchanged durable file identities.
            root = _one(tx, 'select root_path,is_active from library.library_roots where id=%s and library_id=%s for share',
                        (plan['root_id'], live.library_id))
            if not root or root['is_active'] is not True or root['root_path'] != plan['root']:
                raise DuplicateFolderError('root_changed')
            current_files = _all(tx, '''select id,track_id,private_path from library.local_track_files
                where id=any(%s) order by id for update''',
                ([item['id'] for item in plan['files']],))
            if [{'id': item['id'], 'track_id': item['track_id'], 'path': item['private_path']}
                    for item in current_files] != sorted(plan['files'], key=lambda item: item['id']):
                raise DuplicateFolderError('inventory_changed')
            if not restore:
                for root_id, root_path in plan['keep_roots']:
                    kept_root = _one(tx, 'select root_path,is_active from library.library_roots where id=%s and library_id=%s for share',
                                     (root_id, live.library_id))
                    if not kept_root or kept_root['is_active'] is not True or kept_root['root_path'] != root_path:
                        raise DuplicateFolderError('kept_root_changed')
                kept_files = _all(tx, '''select id,track_id,private_path,library_root_id from library.local_track_files
                    where id=any(%s) and scan_cache_stale=false order by id for share''',
                    ([item['id'] for item in plan['keep_files']],))
                if [{'id': item['id'], 'track_id': item['track_id'], 'path': item['private_path'], 'root_id': item['library_root_id']}
                        for item in kept_files] != sorted(plan['keep_files'], key=lambda item: item['id']):
                    raise DuplicateFolderError('kept_inventory_changed')
            original, trash = Path(plan['source']), Path(row['destination'])
            source, destination = (trash, original) if restore else (original, trash)
            expected = plan['source_snapshot']['digest']
            music_paths = [str(source / Path(item['path']).relative_to(original)) for item in plan['files']]
            if source.exists() and destination.exists():
                raise DuplicateFolderError('destination_occupied')
            if source.exists():
                if snapshot(source, expected_music=music_paths, music_extensions=self.extensions)['digest'] != expected:
                    raise DuplicateFolderError('source_changed')
                if not restore:
                    kept_paths = [str(Path(plan['keep']) / entry[0]) for entry in plan['keep_snapshot']['entries']
                                  if entry[-1] == 'file' and Path(entry[0]).suffix.casefold() in self.extensions]
                    if snapshot(plan['keep'], expected_music=kept_paths, music_extensions=self.extensions)['digest'] != plan['keep_snapshot']['digest']:
                        raise DuplicateFolderError('kept_source_changed')
                    Path(plan['trash_root']).mkdir(mode=0o700, exist_ok=True)
                move_no_replace(source, destination, expected_identity=plan['source_snapshot']['entries'][0][1:3])
            elif not destination.exists():
                raise DuplicateFolderError('source_unavailable')
            destination_music = [str(destination / Path(item['path']).relative_to(original)) for item in plan['files']]
            if snapshot(destination, expected_music=destination_music, music_extensions=self.extensions)['digest'] != expected:
                raise DuplicateFolderError('outcome_needs_review')
            # Restoration re-enables the same file/track records, never creates IDs.
            state = 'restored' if restore else 'trashed'
            _write(tx, 'update library.duplicate_folder_trash set state=%s,updated_at=now() where operation_id=%s',
                       (state, operation_id))
            self._set_unavailable(tx, plan, not restore)
            revision = self._bump_revision(tx, live.library_id)
            return {**self._status(row), 'state': state, 'requires_view_refresh': True, 'library_revision': revision}
