"""Real duplicate planner/recovery with modeled transactions, synthetic folders.

These tests do not claim Postgres SQL execution or production authority coverage.
"""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from music_app.services.duplicate_folder_recovery import DuplicateFolderRecovery
from music_app.services.duplicate_folder_files import DuplicateFolderError


class Cursor:
    all_cursors = []
    def __init__(self, rows=()):
        self.rows, self.closed, self.rowcount = rows, False, len(rows)
        self.all_cursors.append(self)
    def close(self): self.closed = True
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows


class Connection:
    def __init__(self, rows, root):
        self.rows, self.root, self.journal = rows, root, {}
        self.revision, self.events, self.fail_final = 0, [], False
    @contextmanager
    def transaction(self):
        saved = deepcopy((self.rows, self.journal, self.revision))
        self.events.append('begin')
        try:
            yield self
        except BaseException:
            self.rows, self.journal, self.revision = saved
            self.events.append('rollback')
            raise
        else: self.events.append('commit')
    def execute(self, sql, params=()):
        sql = ' '.join(sql.split())
        self.events.append(sql.split()[0])
        if sql.startswith('select id from library.local_albums'):
            return Cursor([{'id': 30}])
        if 'from library.local_albums a' in sql:
            return Cursor([row for row in self.rows if not row.get('stale')])
        if 'select root_path from library.library_roots' in sql:
            return Cursor([{'root_path': str(self.root)}])
        if 'select id,private_path from library.local_track_files' in sql:
            return Cursor([{'id': row['file_id'], 'private_path': row['private_path']} for row in self.rows])
        if sql.startswith('insert into library.duplicate_folder_trash'):
            import json
            op, library, actor, album, digest, plan, destination, source_paths = params
            self.journal[op] = dict(operation_id=op, library_id=library, actor_account_id=actor,
                album_id=album, request_digest=digest, plan=json.loads(plan), destination=destination, state='pending_trash')
            return Cursor()
        if sql.startswith('select operation_id,state,'):
            assert "plan->>'album_key' as album_key" in sql
            assert "jsonb_array_length(plan->'files') as track_count" in sql
            return Cursor([dict(operation_id=row['operation_id'],state=row['state'],
                album_key=row['plan']['album_key'],track_count=len(row['plan']['files']))
                for row in self.journal.values() if row['library_id'] == params[0]
                and row['album_id'] == params[1] and row['state'] != 'restored'])
        if sql.startswith('select operation_id from library.duplicate_folder_trash') or (sql.startswith('select * from library.duplicate_folder_trash') and 'order by created_at' in sql):
            return Cursor([row for row in self.journal.values() if row['library_id'] == params[0]
                and row['album_id'] == params[1] and row['state'] != 'restored'])
        if sql.startswith('select * from library.duplicate_folder_trash'):
            row = self.journal.get(params[0])
            return Cursor([row] if row and row['library_id'] == params[1]
                and (len(params) < 3 or row['actor_account_id'] == params[2]) else [])
        if sql.startswith('update library.libraries'):
            self.revision += 1
            return Cursor([{'revision': self.revision}])
        if sql.startswith('update library.local_track_files'):
            assert 'set scan_cache_stale' not in sql, 'Generated stale projection is never written'
            assert "jsonb_build_object('stale',%s)" in sql
            stale, ids = params
            for row in self.rows:
                if row['file_id'] in ids: row['stale'] = stale
            return Cursor()
        if sql.startswith('select root_path,is_active'):
            return Cursor([{'root_path': str(self.root), 'is_active': True}])
        if sql.startswith('select id,track_id,private_path'):
            return Cursor([{'id': row['file_id'], 'track_id': row['track_id'], 'private_path': row['private_path'], 'library_root_id': row['library_root_id']}
                           for row in self.rows if row['file_id'] in params[0]
                           and ('scan_cache_stale=false' not in sql or not row.get('stale'))])
        if sql.startswith("update library.duplicate_folder_trash set state='pending_restore'"):
            self.journal[params[0]]['state'] = 'pending_restore'
            return Cursor()
        if sql.startswith('update library.duplicate_folder_trash set state=%s'):
            if self.fail_final:
                self.fail_final = False
                raise RuntimeError('synthetic outcome commit failure')
            self.journal[params[1]]['state'] = params[0]
            return Cursor()
        raise AssertionError(sql)


class Service(DuplicateFolderRecovery):
    def __init__(self, connection):
        super().__init__({'ALBUM_HAVEN_APP_DATABASE_URL': 'synthetic-only', 'SUPPORTED_EXTENSIONS': {'.flac'}})
        self.connection, self.authorizations, self.deny_at = connection, 0, None
    @contextmanager
    def _authorized(self, context, constraints, *, connect=None):
        self.authorizations += 1
        if self.authorizations == self.deny_at:
            raise PermissionError('synthetic revocation')
        with self.connection.transaction():
            yield self.connection, context
    @contextmanager
    def _operation_connection(self): yield self.connection


@pytest.fixture
def fixture(tmp_path):
    Cursor.all_cursors.clear()
    root = tmp_path / 'library'; root.mkdir()
    rows = []
    for number, name in enumerate(('Keep', 'Remove'), start=1):
        folder = root / name; folder.mkdir()
        track = folder / '1.flac'; track.write_bytes(b'synthetic identical fixture')
        rows.append(dict(file_id=number, track_id=10, private_path=str(track), library_root_id=20,
            root_path=str(root), album_id=30, title='Song', disc_number=1, track_number=1,
            duration_seconds=60, metadata={'artist': 'Artist'}, album_title='Album', release_year=2000))
    connection = Connection(rows, root)
    service = Service(connection)
    context = SimpleNamespace(library_id=40, actor=SimpleNamespace(account_id=50))
    yield service, connection, context, root
    assert all(cursor.closed for cursor in Cursor.all_cursors), 'Every database cursor must close'


def command(service, context):
    preview = service.preview(context, None, 'album', 1, 2)
    return dict(album_key='album', keep_id=1, remove_id=2,
                fingerprint=preview['fingerprint'], operation_id=str(uuid4()))


def test_same_folder_rejected_before_mutation(fixture):
    service, db, context, root = fixture
    with pytest.raises(DuplicateFolderError, match='overlapping_folders'):
        service.preview(context, None, 'album', 1, 1)
    assert not db.journal and (root / 'Remove/1.flac').exists()


def test_preview_rejects_other_album_music(fixture):
    service, db, context, root = fixture
    (root / 'Remove/2.flac').write_bytes(b'not in album')
    with pytest.raises(DuplicateFolderError, match='mixed_folder_content'):
        command(service, context)
    assert not db.journal


def test_stale_preview_never_moves(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    (root / 'Remove/cover.jpg').write_bytes(b'new sidecar')
    with pytest.raises(DuplicateFolderError, match='preview_changed'):
        service.trash(context, None, cmd)
    assert not db.journal and (root / 'Remove/1.flac').exists()


def test_trash_restore_retains_ids_and_kept_source(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    original_ids = [(row['file_id'], row['track_id']) for row in db.rows]
    result = service.trash(context, None, cmd)
    assert result['state'] == 'trashed'
    assert db.rows[1]['stale'] is True and not db.rows[0].get('stale', False)
    assert (root / 'Keep/1.flac').exists() and not (root / 'Remove').exists()
    result = service.recover(context, None, cmd['operation_id'], restore=True)
    assert result['state'] == 'restored' and (root / 'Remove/1.flac').exists()
    assert not db.rows[1]['stale']
    assert [(row['file_id'], row['track_id']) for row in db.rows] == original_ids


def test_same_command_replay_never_moves_twice(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    monkeypatch.setattr('music_app.services.duplicate_folder_recovery.move_no_replace',
                        lambda *args, **kwargs: pytest.fail('duplicate move'))
    assert service.trash(context, None, cmd)['state'] == 'trashed'


def test_changed_command_same_id_is_conflict(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    with pytest.raises(DuplicateFolderError, match='operation_conflict'):
        service.trash(context, None, {**cmd, 'keep_id': 100})


def test_crash_after_move_reconciles_without_second_move(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    db.fail_final = True
    with pytest.raises(RuntimeError, match='synthetic outcome'):
        service.trash(context, None, cmd)
    assert db.journal[cmd['operation_id']]['state'] == 'pending_trash'
    assert db.rows[1]['stale'] is True
    assert not (root / 'Remove').exists()
    monkeypatch.setattr('music_app.services.duplicate_folder_recovery.move_no_replace',
                        lambda *args, **kwargs: pytest.fail('second move after crash'))
    assert service.recover(context, None, cmd['operation_id'])['state'] == 'trashed'


def test_revocation_after_intent_stops_move_and_can_cancel(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.deny_at = service.authorizations + 3
    with pytest.raises(PermissionError, match='revocation'):
        service.trash(context, None, cmd)
    assert (root / 'Remove/1.flac').exists()
    assert db.journal[cmd['operation_id']]['state'] == 'pending_trash'
    service.deny_at = None
    assert service.recover(context, None, cmd['operation_id'], restore=True)['state'] == 'restored'
    assert not db.rows[1]['stale']


def test_restore_collision_preserves_both_copies(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    original = root / 'Remove'; original.mkdir()
    (original / 'unrelated.txt').write_text('must stay')
    with pytest.raises(DuplicateFolderError, match='destination_occupied'):
        service.recover(context, None, cmd['operation_id'], restore=True)
    assert (original / 'unrelated.txt').read_text() == 'must stay'
    assert Path(db.journal[cmd['operation_id']]['destination']).exists()


def test_restore_rejects_reassigned_file_identity(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    db.rows[1]['track_id'] = 999
    with pytest.raises(DuplicateFolderError, match='inventory_changed'):
        service.recover(context, None, cmd['operation_id'], restore=True)
    assert not (root / 'Remove').exists()


def test_different_library_cannot_recover(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    other = SimpleNamespace(library_id=999, actor=SimpleNamespace(account_id=999))
    with pytest.raises(DuplicateFolderError, match='operation_not_found'):
        service.recover(other, None, cmd['operation_id'], restore=True)
    assert not (root / 'Remove').exists()


def test_recovery_choices_remain_when_no_live_copy_exists(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    db.rows[0]['stale'] = True
    result = service.choices(context, None, 'album')
    assert result['sources'] == []
    assert result['operations'][0]['state'] == 'trashed'


def test_no_delete_choices_for_nonduplicate_album(fixture):
    service, db, context, root = fixture
    db.rows[1]['title'] = 'Different song'
    assert service.choices(context, None, 'album')['sources'] == []


def test_another_authorized_library_actor_can_restore(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    other = SimpleNamespace(library_id=40, actor=SimpleNamespace(account_id=999))
    assert service.recover(other, None, cmd['operation_id'], restore=True)['state'] == 'restored'
    assert db.journal[cmd['operation_id']]['actor_account_id'] == 50


def test_revoked_current_authority_cannot_restore(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    service.deny_at = service.authorizations + 1
    with pytest.raises(PermissionError, match='revocation'):
        service.recover(context, None, cmd['operation_id'], restore=True)
    assert db.journal[cmd['operation_id']]['state'] == 'trashed'
    assert not (root / 'Remove').exists()


def test_recovery_list_bound_never_hides_new_active_operations(fixture):
    service, db, context, root = fixture
    cmd = command(service, context)
    for i in range(100):
        db.journal[str(i)] = dict(operation_id=str(i), library_id=40, album_id=30, state='trashed')
    with pytest.raises(DuplicateFolderError, match='restore_existing_copies_first'):
        service.trash(context, None, cmd)
    assert len(db.journal) == 100 and (root / 'Remove/1.flac').exists()


def test_root_revoked_between_intent_and_move_stays_pending(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    execute, checks = db.execute, []
    def changing_root(sql, params=()):
        cursor = execute(sql, params)
        if sql.startswith('select root_path,is_active'):
            checks.append(True)
            if len(checks) == 2:
                cursor.rows[0]['is_active'] = False
        return cursor
    monkeypatch.setattr(db, 'execute', changing_root)
    with pytest.raises(DuplicateFolderError, match='root_changed'):
        service.trash(context, None, cmd)
    assert db.journal[cmd['operation_id']]['state'] == 'pending_trash'
    assert (root / 'Remove/1.flac').exists() and db.rows[1]['stale']


@pytest.mark.parametrize('change', ['inactive_root', 'reassigned_file', 'stale_file', 'reassigned_root'])
def test_kept_inventory_rechecked_before_move(fixture, monkeypatch, change):
    service, db, context, root = fixture
    cmd = command(service, context)
    execute, roots = db.execute, []
    def changing_keep(sql, params=()):
        cursor = execute(sql, params)
        if sql.startswith('select root_path,is_active'):
            roots.append(True)
            if len(roots) == 3:
                if change == 'inactive_root': cursor.rows[0]['is_active'] = False
                elif change == 'reassigned_file': db.rows[0]['track_id'] += 1
                elif change == 'reassigned_root': db.rows[0]['library_root_id'] += 1
                else: db.rows[0]['stale'] = True
        return cursor
    monkeypatch.setattr(db, 'execute', changing_keep)
    with pytest.raises(DuplicateFolderError, match='kept_(root|inventory)_changed'):
        service.trash(context, None, cmd)
    assert (root / 'Remove/1.flac').exists()
    assert db.journal[cmd['operation_id']]['state'] == 'pending_trash'


def test_lists_project_summary_and_never_select_full_plan(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    service.trash(context, None, cmd)
    execute, queries = db.execute, []
    def record(sql, params=()):
        if 'from library.duplicate_folder_trash' in sql:
            queries.append(sql)
            assert 'select *' not in sql.lower()
        return execute(sql, params)
    monkeypatch.setattr(db, 'execute', record)
    result = service.choices(context, None, 'album')
    assert queries and result['operations'][0]['track_count'] == 1
    assert set(result['operations'][0]) == {'operation_id','state','album_key','track_count'}


def test_oversize_plan_fails_before_durable_intent_or_move(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    monkeypatch.setattr('music_app.services.duplicate_folder_recovery.MAX_PLAN_BYTES', 128)
    with pytest.raises(DuplicateFolderError, match='plan_metadata_too_large'):
        service.trash(context, None, cmd)
    assert not db.journal and (root / 'Remove/1.flac').exists()
    assert not any(row.get('stale') for row in db.rows)


def test_serialized_plan_exact_utf8_byte_boundary(monkeypatch):
    from music_app.services import duplicate_folder_recovery as module
    plan = {'path': '\u00e9' * 20}
    encoded = module._serialized_plan(plan)
    monkeypatch.setattr(module, 'MAX_PLAN_BYTES', len(encoded.encode('utf-8')))
    assert module._serialized_plan(plan) == encoded
    monkeypatch.setattr(module, 'MAX_PLAN_BYTES', len(encoded.encode('utf-8')) - 1)
    with pytest.raises(DuplicateFolderError, match='plan_metadata_too_large'):
        module._serialized_plan(plan)


def test_oversize_snapshot_fails_before_durable_intent_or_move(fixture, monkeypatch):
    service, db, context, root = fixture
    cmd = command(service, context)
    monkeypatch.setattr('music_app.services.duplicate_folder_files.MAX_SNAPSHOT_BYTES', 128)
    with pytest.raises(DuplicateFolderError, match='snapshot_metadata_too_large'):
        service.trash(context, None, cmd)
    assert not db.journal and (root / 'Remove/1.flac').exists()
    assert not any(row.get('stale') for row in db.rows)
