"""Read-only admission for one supplemental database in an owned disposable PG17.

This is historical fixture-capture admission, not production-installer qualification.
The original randomized database manifest and all original environment bindings
remain mandatory and unchanged. No grants, provisioning, credential reads,
SET ROLE, identity bypasses or migration execution occur here.
"""
from contextlib import contextmanager
import hashlib
import json
import sys

DIRECT_DATABASE = 'album_haven_fake_e2e'
DIRECT_SETUP_ROLE = 'album_haven_migrator'
DIRECT_APP_ROLE = 'album_haven_app'
DIRECT_READONLY_ROLE = 'album_haven_readonly'
RECEIPT_FIELDS = {
    'schema_version', 'database', 'setup_role', 'app_role',
    'original_manifest_sha256', 'token', 'system_identifier', 'server_start_epoch',
}
SETUP_URL_ENV = 'ALBUM_HAVEN_TRACKING_DIRECT_SETUP_URL'
APP_URL_ENV = 'ALBUM_HAVEN_TRACKING_DIRECT_APP_URL'


def direct_context(environ):
    """Validate both ownership receipts without relaxing original admission."""
    assert not sys.flags.optimize and sys.dont_write_bytecode, 'Unoptimized Python -B required'
    from tests.py.owned_local_postgres_admission import owned_local_context, private_file
    anchor = owned_local_context(environ)
    original_path = anchor['root'] / 'ownership.json'
    # Re-read only ownership metadata, never the metadata-checked passfile.
    original_bytes = private_file(original_path).read_bytes()
    original = json.loads(original_bytes)
    path = anchor['root'] / 'direct-profile.json'
    private_file(path)
    assert path.stat().st_size <= 4096
    receipt = json.loads(path.read_text())
    assert type(receipt) is dict and set(receipt) == RECEIPT_FIELDS
    assert type(receipt['schema_version']) is int and receipt['schema_version'] == 1
    assert receipt['database'] == DIRECT_DATABASE
    assert receipt['setup_role'] == DIRECT_SETUP_ROLE
    assert receipt['app_role'] == DIRECT_APP_ROLE
    assert receipt['original_manifest_sha256'] == hashlib.sha256(original_bytes).hexdigest()
    assert receipt['token'] == original['token']
    assert receipt['system_identifier'] == original['system_identifier']
    assert type(receipt['server_start_epoch']) is int
    assert receipt['server_start_epoch'] == anchor['server_start_epoch']
    setup = f"postgresql://{DIRECT_SETUP_ROLE}@127.0.0.1:{anchor['port']}/{DIRECT_DATABASE}"
    app = f"postgresql://{DIRECT_APP_ROLE}@127.0.0.1:{anchor['port']}/{DIRECT_DATABASE}"
    # No caller-controlled host, database, username, password or query overrides.
    assert environ.get(SETUP_URL_ENV) == setup, 'Direct setup URL does not match owned target'
    assert environ.get(APP_URL_ENV) == app, 'Direct app URL does not match owned target'
    return dict(anchor, database=DIRECT_DATABASE, setup_role=DIRECT_SETUP_ROLE,
                app_role=DIRECT_APP_ROLE, readonly_role=DIRECT_READONLY_ROLE,
                setup=setup, app=app, anchor=anchor,
                topology='direct-migrator', receipt_path=path)


def validate_direct_connection(connection, context, role='setup'):
    """Actual server, login, owner and privilege facts; never inferred from names."""
    from tests.py.owned_local_postgres_admission import assert_owned_local_server
    assert role in ('setup', 'app')
    expected_login = DIRECT_SETUP_ROLE if role == 'setup' else DIRECT_APP_ROLE
    assert context['topology'] == 'direct-migrator'
    assert context['database'] == DIRECT_DATABASE
    assert context['setup_role'] == DIRECT_SETUP_ROLE
    assert_owned_local_server(connection, context)
    actual = connection.execute("""select current_database() as database,
        current_user as current_role, session_user as session_role,
        (select pg_get_userbyid(datdba) from pg_database
         where datname=current_database()) as database_owner""").fetchone()
    assert actual == dict(database=DIRECT_DATABASE, current_role=expected_login,
                         session_role=expected_login, database_owner=DIRECT_SETUP_ROLE)
    anchor = context['anchor']
    roles = [DIRECT_SETUP_ROLE, DIRECT_APP_ROLE, DIRECT_READONLY_ROLE,
             anchor['setup_role'], anchor['app_role'], anchor['readonly_role']]
    rows = connection.execute("""select rolname, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolcanlogin from pg_roles
        where rolname=any(%s::text[]) order by rolname""", (roles,)).fetchall()
    assert {row['rolname'] for row in rows} == set(roles)
    for row in rows:
        assert not any(row[key] for key in
            ('rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'))
        if row['rolname'] in (DIRECT_SETUP_ROLE, DIRECT_APP_ROLE):
            assert row['rolcanlogin']
        if row['rolname'] == DIRECT_READONLY_ROLE:
            assert not row['rolcanlogin']
    for runtime in (DIRECT_APP_ROLE, DIRECT_READONLY_ROLE,
                    anchor['app_role'], anchor['readonly_role']):
        for owner in (DIRECT_SETUP_ROLE, anchor['setup_role']):
            membership = connection.execute('select pg_has_role(%s,%s,\'MEMBER\') as member',
                                            (runtime, owner)).fetchone()
            assert membership == {'member': False}


@contextmanager
def direct_connection(environ, role='setup'):
    """Real named login on the exact supplemental owned target; rollback only."""
    import psycopg
    from psycopg.rows import dict_row
    context = direct_context(environ)
    assert role in ('setup', 'app')
    connection = psycopg.connect(context[role], passfile=str(context['pgpass']),
        row_factory=dict_row, connect_timeout=5,
        options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000')
    try:
        validate_direct_connection(connection, context, role=role)
        yield connection, context
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()
