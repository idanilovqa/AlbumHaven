"""Assert the existing isolated runtime identity and effective inherited grants.

This is read-only test support. It cannot connect, provision, grant, SET ROLE,
change configuration or weaken the caller's actual SQL privilege assertions.
"""
from tests.e2e.support import isolatedPostgres


def assert_runtime_role(connection, database):
    # Reuse the real loopback/synthetic-database/paired-role/suffix contract.
    # Persistent Python CI explicitly provisions AppPrivilegeMode Inherited.
    _, runtime_url = isolatedPostgres.resolve_isolated_database_urls({
        isolatedPostgres.SETUP_DATABASE_ENV: database.setup_url,
        isolatedPostgres.RUNTIME_DATABASE_ENV: database.app_url,
    })
    expected = isolatedPostgres._database_role(runtime_url)
    isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
    actual = connection.execute('''select current_database() as database_name,current_user as name,session_user as login,
        rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        pg_has_role(current_user,'album_haven_app','USAGE') as runtime_privileges
        from pg_roles where rolname=current_user''').fetchone()
    assert actual == {'database_name': isolatedPostgres._database_name(runtime_url),
        'name': expected, 'login': expected, 'rolsuper': False,
        'rolcreatedb': False, 'rolcreaterole': False, 'rolreplication': False,
        'rolbypassrls': False, 'runtime_privileges': True}, actual
    return expected
