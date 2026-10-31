"""Strict separately provisioned 0153 fixture for the unchanged legacy cascade test.

No migration execution, downgrade, role change or global environment mutation.
The external owner provisions/destroys this distinct disposable historical DB.
"""
import os
from urllib.parse import quote

import pytest

from tests.py.listening_tracking_migration_support import pre0169_connection
from tests.py.test_playback_capture_postgres import CaptureDatabase


@pytest.fixture
def historical_capture_db():
    prefix = 'ALBUM_HAVEN_TRACKING_HISTORICAL_'
    assert os.environ.get(prefix + 'COHORT') == '0153-aad200d9'
    # Admission validates the separately provided owned manifest, exact URLs,
    # role names, server identity and passfile metadata through the unchanged
    # shared admission contract. The process environment is never repointed.
    env = dict(os.environ)
    for destination, suffix in (
        ('ALBUM_HAVEN_OWNED_POSTGRES_MANIFEST', 'OWNERSHIP_MANIFEST'),
        ('DATABASE_MIGRATOR_URL', 'SETUP_URL'),
        ('DATABASE_APP_URL', 'APP_URL'),
        ('ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL', 'APP_URL'),
        ('PGPASSFILE', 'PGPASSFILE'),
    ):
        value = os.environ.get(prefix + suffix)
        assert value, 'Explicit historical owned fixture binding required: ' + suffix
        env[destination] = value
    assert env['DATABASE_MIGRATOR_URL'] != os.environ.get('DATABASE_MIGRATOR_URL'), 'Historical DB must be separate from the current target'
    env.update(ALBUM_HAVEN_TRACKING_MIGRATION_TEST='exclusive-isolated-rollback',
               ALBUM_HAVEN_TRACKING_MIGRATION_BASELINE='aad200d9',
               ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY='separate-owner',
               ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER='isolated')
    with pre0169_connection(env) as (connection, ownership):
        # The historical ledger is exactly the independent 147-file 0153
        # inventory. Reject private column-only upgrades as well as new tables.
        for relation, column in (
            ('app.album_ratings', 'native_rating_intent_at'),
            ('app.album_list_items', 'listening_baseline_at'),
            ('app.album_list_item_progress', 'listening_item_ref'),
            ('app.album_list_item_progress', 'listening_baseline_at'),
        ):
            assert connection.execute('''select count(*) as n from pg_attribute
                where attrelid=to_regclass(%s) and attname=%s and not attisdropped''',
                (relation, column)).fetchone()['n'] == 0
        foreign_keys = connection.execute('''select confdeltype from pg_constraint
            where conrelid='integration.playback_capture_session'::regclass
              and confrelid='library.libraries'::regclass and contype='f' ''').fetchall()
        assert foreign_keys == [{'confdeltype': 'c'}]
    # Only the already metadata-checked path is appended; no credential bytes
    # enter a DSN or log. Normal CaptureDatabase connections remain unmodified.
    passfile = '?passfile=' + quote(str(ownership['pgpass']), safe='')
    db = CaptureDatabase((ownership['app'] + passfile, ownership['setup'] + passfile))
    try:
        db.setup()
        yield db
    finally:
        db.cleanup()
