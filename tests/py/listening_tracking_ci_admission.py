"""Read-only, explicit admission for the two disposable Windows CI cohorts.

The fixed inspector owns native ACL/handle checks. This is wrong-target
protection, not a sandbox against arbitrary malicious code in the same job.
No credentials are read, no roles changed, and no databases provisioned here.
"""
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = r'C:\Program Files\PowerShell\7\pwsh.exe'
INSPECTOR = 'scripts/ci/tracking-postgres-admission.ps1'
REPOSITORY = 'idanilovqa/AlbumHaven'
INVENTORY = 'd15a9dd4a4b942b0c6ead1494505b6508a711ac630c99bd5ce24eb9ef03953f0'
PREFIXES = {'tracking-rollback': 'ALBUM_HAVEN_TRACKING_MIGRATION_',
            'historical-0153': 'ALBUM_HAVEN_TRACKING_HISTORICAL_'}
SUFFIXES = {'tracking-rollback': 'tr169', 'historical-0153': 'hist153',
            'persistent': 'py_contract', 'destructive': 'py'}
FIELDS = set('''schema_version mode cohort repository workflow job run_id run_attempt
    github_sha checkout_sha event_pr_head_sha event_pr_base_sha event_pr_repository
    runner_sid root receipt_path pgpass_path pgbin ordinary_pgpass_path
    powershell_path powershell_sha256 inspector_path inspector_sha256 baseline
    migration_through migration_count inventory_sha256 host port configured_service
    server_version_num server_start_epoch server_system_identifier database
    database_oid database_owner roles urls ordinary_databases pgpass_identity'''.split())
INT_FIELDS = {'schema_version', 'migration_through', 'migration_count', 'port',
              'server_version_num', 'server_start_epoch', 'database_oid'}
OBJECT_FIELDS = {'roles', 'urls', 'ordinary_databases', 'pgpass_identity'}
LIMIT = 131072


def _require_assertions():
    if sys.flags.optimize:
        raise AssertionError('Admission assertions must remain enabled')


def _require_windows():
    _require_assertions()
    assert sys.platform == 'win32' and os.name == 'nt', 'Windows CI requires a real Windows host'


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, 'Duplicate admission JSON key'
        result[key] = value
    return result


def _json(raw):
    assert type(raw) is bytes and len(raw) <= LIMIT, 'Invalid inspector response size'
    return json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object)


def _winpath(value):
    assert type(value) is str and value and not any(c in value for c in '\x00\r\n')
    path = PureWindowsPath(value)
    assert path.is_absolute() and re.fullmatch(r'[A-Za-z]:', path.drive)
    assert all(part not in ('.', '..') and not part.endswith((' ', '.'))
               and ':' not in part for part in re.split(r'[\\/]', value[3:]) if part)
    return path


def _inspect(environ, cohort):
    """Bounded fixed subprocess; verify actual artifact identities, never PATH."""
    executable, script = Path(POWERSHELL), ROOT / INSPECTOR
    assert executable.is_file() and executable.resolve(strict=True) == executable
    assert script.is_file() and script.resolve(strict=True) == script
    assert Path(environ['GITHUB_WORKSPACE']).resolve(strict=True) == ROOT
    hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (executable, script)]
    command = [str(executable), '-NoLogo', '-NoProfile', '-NonInteractive',
               '-File', str(script), '-Mode', 'Inspect', '-Cohort', cohort]
    # Limit memory even on malformed output; a full pipe cannot deadlock wait.
    output = {}
    process = subprocess.Popen(command, cwd=ROOT, env=dict(environ), shell=False,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW)
    def read(name, stream, limit):
        try:
            output[name] = stream.read(limit + 1)
            if len(output[name]) > limit:
                process.kill()
        finally:
            stream.close()
    readers = [threading.Thread(target=read, args=(name, stream, limit), daemon=True)
               for name, stream, limit in (('out', process.stdout, LIMIT),
                                           ('err', process.stderr, 4096))]
    for reader in readers:
        reader.start()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise AssertionError('Tracking inspector timed out') from None
    finally:
        for reader in readers:
            reader.join(timeout=1)
    assert all(not reader.is_alive() for reader in readers), 'Inspector output did not close'
    assert process.returncode == 0 and output.get('err') == b'', 'Tracking inspector failed'
    raw = output.get('out')
    receipt = _json(raw)
    assert type(receipt) is dict
    assert receipt.get('powershell_sha256') == hashes[0]
    assert receipt.get('inspector_sha256') == hashes[1]
    assert _winpath(receipt.get('powershell_path')) == _winpath(str(executable))
    assert _winpath(receipt.get('inspector_path')) == _winpath(str(script))
    return raw


def _url(role, database, port):
    port_text = '' if port == 5432 else ':' + str(port)
    return f'postgresql://{role}@127.0.0.1{port_text}/{database}'


def ci_context(environ, cohort):
    _require_windows()
    assert cohort in PREFIXES, 'Unknown CI cohort'
    env = {}
    for key, value in environ.items():
        assert type(key) is str and type(value) is str
        canonical = key.upper()
        assert canonical not in env, 'Ambiguous case-insensitive environment'
        env[canonical] = value
    assert env.get('GITHUB_ACTIONS') == 'true' and env.get('RUNNER_OS') == 'Windows'
    assert env.get('GITHUB_REPOSITORY') == REPOSITORY and env.get('GITHUB_JOB') == 'test_python'
    assert env.get('ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION') == 'windows-ci'
    assert env.get('ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY') == 'separate-owner'
    assert env.get('ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER') == 'operational-function'
    assert env.get('GITHUB_EVENT_NAME') == 'pull_request'
    for key in env:
        if key.startswith('PG'):
            assert key in ('PGBIN', 'PGPASSFILE', 'PGPASSWORD'), 'Unexpected libpq environment override'
    assert not env.get('PGPASSWORD'), 'Ambient database password is forbidden'
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        assert re.fullmatch(r'[1-9][0-9]{0,19}', env.get(key, ''))
    assert re.fullmatch(r'[0-9a-f]{40}', env.get('GITHUB_SHA', ''))
    assert env.get('GITHUB_WORKFLOW')
    event_path = Path(env.get('GITHUB_EVENT_PATH', ''))
    assert event_path.is_absolute() and event_path.is_file() and not event_path.is_symlink()
    with event_path.open('rb') as stream:
        event_raw = stream.read(2097153)
    assert len(event_raw) <= 2097152
    event = json.loads(event_raw, object_pairs_hook=_unique_object)
    assert type(event) is dict and type(event.get('number')) is int and event['number'] > 0
    assert env.get('GITHUB_REF') == f"refs/pull/{event['number']}/merge"
    assert event['repository']['full_name'] == REPOSITORY
    pr = event['pull_request']
    for side in ('head', 'base'):
        assert pr[side]['repo']['full_name'] == REPOSITORY
        assert re.fullmatch(r'[0-9a-f]{40}', pr[side]['sha'])
    receipt = _json(_inspect(env, cohort))
    assert type(receipt) is dict and set(receipt) == FIELDS
    for key in FIELDS - OBJECT_FIELDS:
        assert type(receipt[key]) is (int if key in INT_FIELDS else str), 'Invalid receipt field type'
    expected = dict(schema_version=1, mode='windows-ci', cohort=cohort,
        repository=REPOSITORY, workflow=env['GITHUB_WORKFLOW'], job='test_python',
        run_id=env['GITHUB_RUN_ID'], run_attempt=env['GITHUB_RUN_ATTEMPT'],
        github_sha=env['GITHUB_SHA'], checkout_sha=env['GITHUB_SHA'],
        event_pr_head_sha=pr['head']['sha'], event_pr_base_sha=pr['base']['sha'],
        event_pr_repository=REPOSITORY, baseline='aad200d9', migration_through=153,
        migration_count=147, inventory_sha256=INVENTORY, host='127.0.0.1',
        configured_service='postgresql-x64-17')
    assert all(receipt[key] == value for key, value in expected.items()), 'CI receipt identity mismatch'
    assert re.fullmatch(r'S-1-[0-9]+(?:-[0-9]+)+', receipt['runner_sid'])
    assert re.fullmatch(r'[1-9][0-9]*', receipt['server_system_identifier'])
    for key in ('powershell_sha256', 'inspector_sha256'):
        assert re.fullmatch(r'[0-9a-f]{64}', receipt[key])
    port = receipt['port']
    assert 1024 <= port <= 65535 and 170000 <= receipt['server_version_num'] < 180000
    assert receipt['server_start_epoch'] > 0 and receipt['database_oid'] > 0
    prefix = PREFIXES[cohort]
    root = _winpath(env.get('RUNNER_TEMP')) / (
        f"album-haven-tracking-{cohort}-{env['GITHUB_RUN_ID']}-{env['GITHUB_RUN_ATTEMPT']}")
    paths = {'root': root, 'receipt_path': root / 'receipt.json',
             'pgpass_path': root / 'pgpass.conf', 'powershell_path': _winpath(POWERSHELL),
             'inspector_path': _winpath(env.get('GITHUB_WORKSPACE')) / INSPECTOR,
             'pgbin': _winpath(env.get('PGBIN')),
             'ordinary_pgpass_path': _winpath(env.get('PGPASSFILE'))}
    assert all(_winpath(receipt[key]) == path for key, path in paths.items())
    assert _winpath(env.get(prefix + 'CI_RECEIPT')) == paths['receipt_path']
    assert _winpath(env.get(prefix + 'PGPASSFILE')) == paths['pgpass_path']
    assert paths['ordinary_pgpass_path'] != paths['pgpass_path']
    identity = receipt['pgpass_identity']
    assert type(identity) is dict and set(identity) == {'volume_serial', 'file_id', 'size', 'last_write_filetime'}
    assert type(identity['size']) is int and 0 < identity['size'] <= 65536
    for key in ('volume_serial', 'file_id', 'last_write_filetime'):
        assert type(identity[key]) is str and re.fullmatch(r'[0-9]+', identity[key])
    databases, names = {}, {}
    for category, suffix in SUFFIXES.items():
        suffix += '_' + env['GITHUB_RUN_ID'] + '_' + env['GITHUB_RUN_ATTEMPT']
        database = 'album_haven_ci_' + suffix
        roles = {kind: 'album_haven_' + base + '_' + suffix
                 for kind, base in (('setup', 'migrator'), ('app', 'app'), ('readonly', 'readonly'))}
        assert max(map(len, (database, *roles.values()))) <= 63
        databases[category], names[category] = database, roles
        if category in PREFIXES:
            bindings = {kind: PREFIXES[category] + kind.upper() + '_URL' for kind in roles}
        elif category == 'persistent':
            bindings = {'setup': 'DATABASE_MIGRATOR_URL', 'app': 'DATABASE_APP_URL'}
        else:
            bindings = {'setup': 'PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'app': 'PYTEST_DESTRUCTIVE_DATABASE_URL'}
        for kind, key in bindings.items():
            assert env.get(key) == _url(roles[kind], database, port), 'CI database binding mismatch'
    assert len(set(databases.values())) == 4
    assert receipt['ordinary_databases'] == {key: databases[key] for key in ('persistent', 'destructive')}
    assert receipt['database'] == databases[cohort] and receipt['database_owner'] == names[cohort]['setup']
    roles, urls = receipt['roles'], receipt['urls']
    assert type(roles) is dict and set(roles) == set(names[cohort])
    assert type(urls) is dict and set(urls) == set(roles)
    for kind, role in roles.items():
        assert type(role) is dict and set(role) == {'name', 'oid'}
        assert role['name'] == names[cohort][kind] and type(role['oid']) is int and role['oid'] > 0
        assert urls[kind] == _url(role['name'], databases[cohort], port)
    assert len({role['oid'] for role in roles.values()}) == 3
    return dict(admission='windows-ci', cohort=cohort, topology='separate-owner',
        setup=urls['setup'], app=urls['app'], pgpass=paths['pgpass_path'],
        database=receipt['database'], database_oid=receipt['database_oid'],
        setup_role=roles['setup']['name'], app_role=roles['app']['name'],
        readonly_role=roles['readonly']['name'], role_oids={kind: role['oid'] for kind, role in roles.items()},
        host=receipt['host'], port=port, server_start_epoch=receipt['server_start_epoch'],
        server_version_num=receipt['server_version_num'])


def validate_ci_connection(connection, context):
    """Observe actual SQL endpoint and privileges before any fixture mutation."""
    _require_assertions()
    assert context['admission'] == 'windows-ci' and context['topology'] == 'separate-owner'
    actual = connection.execute('''select host(inet_server_addr()) as host,
        inet_server_port() as port,
        floor(extract(epoch from pg_postmaster_start_time()))::bigint as server_start_epoch,
        current_setting('server_version_num')::integer as server_version_num,
        current_database() as database, current_user as current_role,
        session_user as session_role, d.oid as database_oid,
        pg_get_userbyid(d.datdba) as database_owner
        from pg_database d where d.datname=current_database()''').fetchone()
    expected = {key: context[key] for key in ('host', 'port', 'server_start_epoch',
                'server_version_num', 'database', 'database_oid')}
    expected.update(current_role=context['setup_role'], session_role=context['setup_role'],
                    database_owner=context['setup_role'])
    assert actual == expected, 'Connected CI database identity mismatch'
    generated = {context[kind + '_role']: context['role_oids'][kind] for kind in ('setup', 'app', 'readonly')}
    bases = {'setup': 'album_haven_migrator', 'app': 'album_haven_app', 'readonly': 'album_haven_readonly'}
    rows = connection.execute('''select oid,rolname,rolsuper,rolcreatedb,rolcreaterole,
        rolreplication,rolbypassrls,rolcanlogin,rolinherit from pg_roles
        where rolname=any(%s::text[]) order by rolname''', (list(generated) + list(bases.values()),)).fetchall()
    assert len(rows) == 6 and {row['rolname'] for row in rows} == set(generated) | set(bases.values())
    for row in rows:
        assert not any(row[key] for key in ('rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'))
        if row['rolname'] in generated:
            assert row['oid'] == generated[row['rolname']] and row['rolcanlogin'] and row['rolinherit']
    def membership(role, parent, expected):
        row = connection.execute("select pg_has_role(%s,%s,'MEMBER') as member, pg_has_role(%s,%s,'USAGE') as usage",
                                 (role, parent, role, parent)).fetchone()
        assert row == {'member': expected, 'usage': expected}, 'CI role membership mismatch'
    for kind, base in bases.items():
        membership(context[kind + '_role'], base, True)
    for runtime in (context['app_role'], context['readonly_role'], bases['app'], bases['readonly']):
        for owner in (context['setup_role'], bases['setup']):
            membership(runtime, owner, False)
