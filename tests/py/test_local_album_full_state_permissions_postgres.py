"""Runtime derived-state access must not require cleanup-role DELETE privileges."""
import pytest
import psycopg
from psycopg.rows import dict_row

from music_app.services import local_album_full_state as full
from tests.py.test_playback_capture_postgres import capture_db, urls
from tests.py.test_local_album_reader_boundaries_postgres import (
    inventory_ready, source, append, advance, finish_pass, stored, read,
)


@pytest.mark.asyncio
async def test_runtime_without_delete_can_insert_update_read_but_not_delete_derived_state(capture_db):
    db = capture_db
    inventory_ready(db)
    with psycopg.connect(db.app_url, row_factory=dict_row) as connection:
        acl = connection.execute("""select
            has_table_privilege('integration.playback_album_metrics_state','SELECT') as can_select,
            has_table_privilege('integration.playback_album_metrics_state','INSERT') as can_insert,
            has_table_privilege('integration.playback_album_metrics_state','UPDATE') as can_update,
            has_table_privilege('integration.playback_album_metrics_state','DELETE') as can_delete,
            pg_has_role(current_user,'album_haven_migrator','MEMBER') as migrator""").fetchone()
        assert acl == {'can_select': True, 'can_insert': True, 'can_update': True, 'can_delete': False, 'migrator': False}
        assert full.state_storage_ready(connection)
    captured = await source(db, 2)
    try:
        append(db, captured, [(0, 0, 2)])
        assert stored(db) is None
        advance(db, 0)
        inserted = stored(db)
        assert inserted['state_revision'] == 1
        completed = finish_pass(db)
        assert completed['state_revision'] > inserted['state_revision']
        assert read(db)['full_progress']['full'] == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with psycopg.connect(db.app_url, row_factory=dict_row) as connection:
                connection.execute('''delete from integration.playback_album_metrics_state
                    where account_id=%s and original_library_id=%s and original_album_id=%s''',
                    (db.account, db.library, db.album))
        assert stored(db) == completed
        assert read(db)['full_progress']['full'] == 1
    finally:
        await captured.decoder.cancel()
