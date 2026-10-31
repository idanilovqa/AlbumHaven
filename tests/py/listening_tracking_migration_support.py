"""Independent tracking-schema oracle and disposable pre-0169 admission.

Private historical SQL is supplied by a reviewed fixture package, never loaded
from the migration under test. No provisioning, credential reads or grants.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat

from tests.e2e.support import isolatedPostgres as isolated

ROOT = Path(__file__).resolve().parents[2]
NAME = '0169_install_listening_tracking_storage.sql'
# Independent 9b29f4e predecessor inventory, captured before candidate authoring.
BASELINES = {
    'aad200d9': (153, 147, 'd15a9dd4a4b942b0c6ead1494505b6508a711ac630c99bd5ce24eb9ef03953f0'),
    '9b29f4e3': (168, 162, '07c838040a79d22bfcfe83e036d514a2c0ee6ce08b3917ff76eb3d56a36a22de'),
}
INPUT_HASHES = {
    'position-v2': '917977e64a6d69c6bf536a2b4c3c054a53b7bb988b54e715e97edde4cf6e18e5',
    'history-revision': '5aa8fc86c032db5ee964575b40de8997c0305c3857b904d94d10e51fc484540a',
    'raw-survival': '35ca8e03feb90256d1b793f5da126c0957dcc46001591f01979528bc3f11e2b5',
    'edition-selection': '2f3c8659fde033c9f131575a226f793e5e6f0ca4bb1de8489f3ab979756b6dc2',
    'decoder-observation': 'f88489a4cfc6066b0d77ba563f2b2f49d151b58ec56e485c182a36dfdc61aef1',
    'derived-state': '3af0896935ff82142d4c74cfa05bd8e220702925093e8c13623073fc86e4ff08',
    'settings': 'c7d3e4eef247ead193686b5f7ee58b1443720816fb331f1d9ad32f1f8f319c8e',
    'native-rating-intent': '6d9c316833644143f2eedc65a589d58e09c1f27857528459af936860549eb057',
    'top-baselines': '59f2fe748d1f8fe8e58a910b1af0b82774454f21e832137cc124f85686648e06',
    'absolute-coordinates': 'f9d91fa276494da4eabc1ad7b1a34220c5f4648236577fc5ced63762581db164',
    'converted-coordinates': 'f84072f7b3b32970ac850a3cd7398d625666c842a726da73cc6a2760e303c1f4',
}
COHORTS = {'nine-spec': 9, 'absolute': 10, 'converted': 11}
NEW_TABLES = (
    'integration.playback_capture_owner', 'integration.playback_capture_loss',
    'integration.playback_capture_history_revision',
    'integration.playback_edition_selection', 'integration.playback_edition_capture',
    'integration.playback_decoder_observation', 'integration.playback_album_metrics_state',
    'app.album_top_listening_settings',
)
TABLES = NEW_TABLES + tuple('integration.playback_capture_' + n for n in (
    'budget', 'session', 'checkpoint', 'anchor', 'run')) + (
    'app.album_ratings', 'app.album_list_items', 'app.album_list_item_progress')


def decode_inputs(raw):
    payload = json.loads(raw)
    assert type(payload) is dict and set(payload) == {'schemaVersion', 'inputs'}
    assert type(payload['schemaVersion']) is int and payload['schemaVersion'] == 1
    assert type(payload['inputs']) is list and len(payload['inputs']) == len(INPUT_HASHES)
    result = {}
    for item in payload['inputs']:
        assert type(item) is dict and set(item) == {'id', 'sql'}
        key, sql = item['id'], item['sql']
        assert key in INPUT_HASHES and key not in result
        assert type(sql) is str
        assert hashlib.sha256(sql.encode('utf-8')).hexdigest() == INPUT_HASHES[key], key
        result[key] = sql
    assert set(result) == set(INPUT_HASHES)
    return result


def proposal_inputs(environ):
    value = environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_INPUTS', '')
    assert value, 'Supply independently sealed eleven-input tracking fixture JSON'
    path = Path(value)
    assert path.is_absolute() and path == path.resolve(strict=True)
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1
    assert info.st_size <= 262144
    return decode_inputs(path.read_text(encoding='utf-8'))


def flush_deferred(connection):
    """Check a complete graph while keeping later mutations normally deferred."""
    connection.execute('set constraints all immediate')
    connection.execute('set constraints all deferred')


def install_oracle(connection, inputs, cohort='converted'):
    assert cohort in COHORTS
    for key in tuple(INPUT_HASHES)[:COHORTS[cohort]]:
        connection.execute(inputs[key])
    flush_deferred(connection)


def finish_oracle(connection, inputs, cohort):
    assert cohort in COHORTS
    for key in tuple(INPUT_HASHES)[COHORTS[cohort]:]:
        connection.execute(inputs[key])
    flush_deferred(connection)


@contextmanager
def pre0169_connection(environ):
    assert environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_TEST') == 'exclusive-isolated-rollback'
    from tests.py.owned_local_postgres_admission import owned_local_context, assert_owned_local_server
    topology = environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY', 'separate-owner')
    assert topology in ('separate-owner', 'direct-migrator')
    runner = environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER', 'isolated')
    assert runner in ('isolated', 'operational-function')
    if topology == 'direct-migrator':
        assert runner == 'operational-function', 'Direct qualification requires the operational function'
        from tests.py.listening_tracking_direct_admission import direct_context, validate_direct_connection
        ownership = direct_context(environ)
    else:
        ownership = owned_local_context(environ)
    ownership = dict(ownership, migration_runner=runner,
                     migration_baseline=environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_BASELINE', ''))
    import psycopg
    from psycopg.rows import dict_row
    connection = psycopg.connect(ownership['setup'], passfile=str(ownership['pgpass']),
        row_factory=dict_row, connect_timeout=5,
        options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000')
    try:
        assert_owned_local_server(connection, ownership)
        if topology == 'direct-migrator':
            validate_direct_connection(connection, ownership)
        else:
            isolated._assert_connected_role(connection, isolated.SETUP_ROLE)
            flags = connection.execute('''select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
                from pg_roles where rolname=current_user''').fetchone()
            assert flags is not None and not any(flags.values())
            for runtime in (ownership['app_role'], ownership['readonly_role'],
                            'album_haven_app', 'album_haven_readonly'):
                for owner in (ownership['setup_role'], 'album_haven_migrator'):
                    assert connection.execute("select pg_has_role(%s,%s,'MEMBER') as member",
                                              (runtime, owner)).fetchone() == {'member': False}
        identity = connection.execute('select current_database() as db,current_user as role,session_user as session_role').fetchone()
        assert identity == {'db': ownership['database'], 'role': ownership['setup_role'],
                            'session_role': ownership['setup_role']}
        paths = sorted((ROOT / 'migrations/postgres').glob('[0-9][0-9][0-9][0-9]_*.sql'))
        baseline = environ.get('ALBUM_HAVEN_TRACKING_MIGRATION_BASELINE', '')
        assert baseline in BASELINES, 'Explicit independently sealed baseline required'
        cutoff, count, digest = BASELINES[baseline]
        predecessors = [p for p in paths if int(p.name[:4]) <= cutoff]
        assert predecessors and int(predecessors[-1].name[:4]) == cutoff
        expected = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in predecessors}
        assert len(expected) == count
        assert hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == digest
        rows = connection.execute('select migration_name,checksum from ops.schema_migrations').fetchall()
        assert len(rows) == len(expected)
        assert {r['migration_name']: r['checksum'] for r in rows} == expected
        assert all(connection.execute('select to_regclass(%s) as r', (name,)).fetchone()['r'] is None
                   for name in NEW_TABLES)
        yield connection, ownership
        flush_deferred(connection)
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def bind_runner(monkeypatch, connection):
    @contextmanager
    def connect(_url):
        with connection.transaction():
            yield connection
            flush_deferred(connection)
    monkeypatch.setattr(isolated, '_connect', connect)


def run_migration(connection, ownership):
    path = ROOT / 'migrations/postgres' / NAME
    assert path.is_file(), 'Normal tracking migration is not delivered'
    runner = ownership.get('migration_runner', 'isolated')
    assert runner in ('isolated', 'operational-function')
    if runner == 'isolated':
        isolated.apply_migrations(ownership['setup'], [path])
        return
    # This exercises the operational function within the owned rollback case.
    # A separate autocommit lifecycle must prove actual committed installation.
    from scripts import render_capabilities_demo as operational
    from psycopg.rows import tuple_row
    assert operational.ROOT.resolve() == ROOT.resolve()
    baseline = ownership['migration_baseline']
    assert baseline in BASELINES
    cutoff, count, digest = BASELINES[baseline]
    paths = sorted((ROOT / 'migrations/postgres').glob('*.sql'))
    predecessors = [p for p in paths if p.name != NAME]
    inventory = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in predecessors}
    assert len(inventory) == count
    assert max(int(name[:4]) for name in inventory) == cutoff
    assert hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == digest
    assert len(paths) == count + 1 and path in paths
    original_factory = connection.row_factory
    try:
        connection.row_factory = tuple_row
        with connection.transaction():
            operational.migrate(connection)
            flush_deferred(connection)
    finally:
        connection.row_factory = original_factory


def catalog(connection):
    """Complete affected object definitions; no hardcoded PostgreSQL OIDs."""
    scoped = connection.execute("""select n.nspname || '.' || c.relname as name
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','p','v','m','f') and
        ((n.nspname='integration' and starts_with(c.relname,'playback_'))
         or (n.nspname='app' and starts_with(c.relname,'album_top_listening_')))
        order by name""").fetchall()
    tables = sorted(set(TABLES) | {row['name'] for row in scoped})
    queries = {
        'relations': "select c.oid,c.oid::regclass::text as name,c.relkind,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c where c.oid=any(select to_regclass(x) from unnest(%s::text[]) x) order by name",
        'columns': "select a.attrelid::regclass::text as name,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) as default_expr from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=any(select to_regclass(x) from unnest(%s::text[]) x) and a.attnum>0 and not a.attisdropped order by name,a.attnum",
        'constraints': "select k.oid,k.conrelid::regclass::text as name,k.conname,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) as definition from pg_constraint k where k.conrelid=any(select to_regclass(x) from unnest(%s::text[]) x) order by name,k.conname",
        'indexes': "select i.indexrelid as oid,i.indrelid::regclass::text as name,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) as definition from pg_index i where i.indrelid=any(select to_regclass(x) from unnest(%s::text[]) x) order by name,definition",
        'triggers': "select t.oid,t.tgrelid::regclass::text as name,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t where t.tgrelid=any(select to_regclass(x) from unnest(%s::text[]) x) and not t.tgisinternal order by name,t.tgname",
    }
    result = {key: connection.execute(query, (tables,)).fetchall() for key, query in queries.items()}
    result['functions'] = connection.execute("""select p.oid,n.nspname,p.proname,
        pg_get_function_identity_arguments(p.oid) as args,p.prosrc,p.proowner,p.proacl::text,
        p.prosecdef,p.provolatile,p.proconfig
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='integration' and p.proname like 'playback_%')
           or (n.nspname='app' and p.proname='guard_album_top_listening_settings')
        order by n.nspname,p.proname,args""").fetchall()
    result['sequences'] = connection.execute("""select c.oid,n.nspname,c.relname,c.relowner,c.relacl::text,
        s.seqtypid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,
        d.refobjid::regclass::text as owner_table,d.refobjsubid as owner_column,d.deptype
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        join pg_sequence s on s.seqrelid=c.oid
        left join pg_depend d on d.classid='pg_class'::regclass and d.objid=c.oid and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
        where c.relkind='S' and ((n.nspname='integration' and starts_with(c.relname,'playback_'))
          or d.refobjid=any(select to_regclass(x) from unnest(%s::text[]) x))
        order by n.nspname,c.relname""", (tables,)).fetchall()
    result['policies'] = connection.execute("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname || '.' || tablename=any(%s) order by schemaname,tablename,policyname", (tables,)).fetchall()
    result['default_acls'] = connection.execute("select d.defaclrole,n.nspname,d.defaclobjtype,d.defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where n.nspname in ('app','integration') or d.defaclnamespace=0 order by d.defaclrole,n.nspname,d.defaclobjtype").fetchall()
    return result


def sequence_state(connection):
    from psycopg import sql
    sequences = catalog(connection)['sequences']
    return {row['nspname'] + '.' + row['relname']: connection.execute(sql.SQL(
        'select last_value,is_called from {}.{}').format(
            sql.Identifier(row['nspname']), sql.Identifier(row['relname']))).fetchone()
        for row in sequences}


def semantic_catalog(value):
    return {key: [{k: v for k, v in row.items() if k != 'oid'} for row in rows]
            for key, rows in value.items()}


def rows_snapshot(connection):
    from psycopg import sql
    result = {}
    for name in TABLES:
        if connection.execute('select to_regclass(%s) as r', (name,)).fetchone()['r']:
            schema, table = name.split('.')
            result[name] = connection.execute(sql.SQL(
                'select to_jsonb(t) as row from {}.{} t order by to_jsonb(t)::text'
            ).format(sql.Identifier(schema), sql.Identifier(table))).fetchall()
    return result


def assert_adoption_rejection(error):
    assert error.sqlstate == 'P0001', f'Incidental failure is not admission rejection: {error}'
    assert error.diag.message_primary.startswith('Incompatible listening tracking'), str(error)
