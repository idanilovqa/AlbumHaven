"""Default-off fence changes neither ordinary callers nor authority ordering."""
from contextlib import contextmanager

import pytest

from music_app.services import private_library_authority as authority
from tests.py.test_playback_capture_postgres import capture_db, urls


def test_inventory_fence_is_default_off(capture_db):
    db=capture_db
    with authority.current_library_transaction(db.app_url,db.context,connect=db.connector(),clock=lambda:db.now):
        pass
    assert not any('local-inventory-publication' in s or 'lock_timeout' in s for s in db.sql)


def test_inventory_fence_timeouts_precede_any_authority_query(capture_db):
    db=capture_db
    with authority.current_library_transaction(db.app_url,db.context,connect=db.connector(),clock=lambda:db.now,
                                                inventory_publication_first=True):
        pass
    assert db.sql[:4]==['set transaction isolation level read committed',"set local lock_timeout = '250ms'",
        "set local statement_timeout = '1000ms'", "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"]
    assert any('app.accounts' in sql for sql in db.sql[4:])
