"""Real resolver/guard with modeled read-only database results, no SQL execution."""
from pathlib import Path
from contextlib import contextmanager
import pytest
from music_app.services import duplicate_folder_guard as guard
from music_app.services.library_roots import resolve_configured_media_path


class Cursor:
    def __init__(self, row): self.row, self.closed = row, False
    def __enter__(self): return self
    def __exit__(self, *_): self.closed = True
    def fetchone(self): return self.row


class Connection:
    def __init__(self, *, exists=True, blocked=True):
        self.exists, self.blocked, self.cursors, self.calls = exists, blocked, [], []
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        result = {'name': 'library.duplicate_folder_trash' if self.exists else None, 'guard_ready': True, 'index_ready': True, 'schema_ready': True} if 'to_regclass' in sql else (
            {'operation_id': 'synthetic'} if self.blocked else None)
        cursor = Cursor(result); self.cursors.append(cursor); return cursor


def test_disabled_guard_has_no_database_work():
    assert guard.duplicate_path_unavailable({}, '/synthetic', connect=lambda _: pytest.fail('unexpected query')) is False


@pytest.mark.parametrize('exists,blocked,result', [(False,False,True),(True,True,True),(True,False,False)])
def test_optional_storage_and_owned_path_query_close_cursors(exists, blocked, result):
    connection = Connection(exists=exists, blocked=blocked)
    assert guard.duplicate_path_unavailable({'ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED': True}, '/synthetic',
        connect=lambda _: connection) is result
    assert all(cursor.closed for cursor in connection.cursors)
    if exists:
        assert connection.calls[-1][1] == ('/synthetic',)
        assert "source_paths @> array[%s]" in connection.calls[-1][0]
        assert "state<>'restored'" in connection.calls[-1][0]


def test_database_failure_fails_closed():
    def failed(_): raise RuntimeError('synthetic unavailable')
    assert guard.duplicate_path_unavailable({'ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED': True}, '/synthetic', connect=failed)


def test_real_media_resolver_blocks_existing_original_path_after_intent(tmp_path, monkeypatch):
    track = tmp_path / '1.flac'; track.write_bytes(b'synthetic')
    connection = Connection(blocked=True)
    monkeypatch.setattr(guard, 'pooled_connection', lambda _: connection)
    config = {'ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED': True}
    assert resolve_configured_media_path(config, str(track), configured_root_paths=[tmp_path]) is None
    assert track.exists(), 'This tests pre-move unavailability, not merely missing files'
    connection.blocked = False
    assert resolve_configured_media_path(config, str(track), configured_root_paths=[tmp_path]) == track
    assert all(cursor.closed for cursor in connection.cursors)


def test_original_media_resolver_behavior_unchanged_when_disabled(tmp_path, monkeypatch):
    track = tmp_path / '1.flac'; track.write_bytes(b'synthetic')
    monkeypatch.setattr(guard, 'pooled_connection', lambda _: pytest.fail('unexpected query'))
    assert resolve_configured_media_path({}, str(track), configured_root_paths=[tmp_path]) == track


@pytest.mark.parametrize('missing', ['guard_ready','index_ready','schema_ready'])
def test_half_installed_storage_fails_closed(missing):
    class Half(Connection):
        def execute(self, sql, params=()):
            cursor = super().execute(sql, params)
            if 'to_regclass' in sql:
                cursor.row[missing] = False
            return cursor
    connection = Half(blocked=False)
    assert guard.duplicate_path_unavailable({'ALBUM_HAVEN_DUPLICATE_RECOVERY_ENABLED': True}, '/synthetic',
        connect=lambda _: connection)
    assert len(connection.calls) == 1
    assert all(cursor.closed for cursor in connection.cursors)
