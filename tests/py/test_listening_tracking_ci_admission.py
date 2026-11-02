"""Logical CI admission contracts, not Windows-native qualification evidence."""
import importlib
import inspect


def test_ci_admission_api_is_registered():
    module = importlib.import_module('tests.py.listening_tracking_ci_admission')
    assert tuple(inspect.signature(module.ci_context).parameters) == ('environ', 'cohort')
    assert tuple(inspect.signature(module.validate_ci_connection).parameters) == ('connection', 'context')

import pytest


class AdmissionReached(Exception):
    """Stops before any driver/DB connection; never accepted as product success."""


@pytest.fixture
def ci_module():
    return importlib.import_module('tests.py.listening_tracking_ci_admission')


@pytest.mark.parametrize('mode,expected', [(None, 'local'), ('local', 'local'), ('windows-ci', 'ci')])
def test_support_selects_only_explicit_ci_mode(monkeypatch, ci_module, mode, expected):
    from tests.py import listening_tracking_migration_support as support
    from tests.py import owned_local_postgres_admission as local
    env = {
        'ALBUM_HAVEN_TRACKING_MIGRATION_TEST': 'exclusive-isolated-rollback',
        'ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY': 'separate-owner',
        'ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER': 'operational-function',
    }
    if mode is not None:
        env['ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION'] = mode
    calls = []
    def local_context(actual):
        assert actual is env
        calls.append('local')
        raise AdmissionReached()
    def ci_context(actual, cohort):
        assert actual is env and cohort == 'tracking-rollback'
        calls.append('ci')
        raise AdmissionReached()
    monkeypatch.setattr(local, 'owned_local_context', local_context)
    monkeypatch.setattr(ci_module, 'ci_context', ci_context)
    with pytest.raises(AdmissionReached):
        with support.pre0169_connection(env):
            pytest.fail('Unexpected DB execution')
    assert calls == [expected]


@pytest.mark.parametrize('change', [
    {'ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION': 'unknown'},
    {'ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER': 'isolated'},
    {'ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY': 'direct-migrator'},
])
def test_invalid_ci_composition_rejects_before_any_admission(monkeypatch, ci_module, change):
    from tests.py import listening_tracking_migration_support as support
    from tests.py import owned_local_postgres_admission as local
    from tests.py import listening_tracking_direct_admission as direct
    env = {
        'ALBUM_HAVEN_TRACKING_MIGRATION_TEST': 'exclusive-isolated-rollback',
        'ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION': 'windows-ci',
        'ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY': 'separate-owner',
        'ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER': 'operational-function',
    }
    env.update(change)
    def forbidden(*args, **kwargs):
        pytest.fail('Invalid CI composition reached an admission adapter')
    monkeypatch.setattr(local, 'owned_local_context', forbidden)
    monkeypatch.setattr(direct, 'direct_context', forbidden)
    monkeypatch.setattr(ci_module, 'ci_context', forbidden)
    with pytest.raises(AssertionError):
        with support.pre0169_connection(env):
            pytest.fail('Unexpected DB execution')


def test_non_windows_host_rejected_even_if_environment_claims_windows(monkeypatch, ci_module):
    # This models the platform-negative branch; only native tests qualify Windows.
    monkeypatch.setattr(ci_module.sys, 'platform', 'linux')
    with pytest.raises(AssertionError):
        ci_module._require_windows()

# These are logical models only. The required Windows-native gate independently
# checks real ACLs, reparse points, retained handles and PostgreSQL identities.
import copy
import json
from pathlib import PureWindowsPath


@pytest.fixture
def ci_case(tmp_path, monkeypatch, ci_module):
    run, attempt = '41173588136', '2'
    workspace = r'D:\a\AlbumHaven\AlbumHaven'
    runner_temp = r'D:\a\_temp'
    env = {
        'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'Windows',
        'GITHUB_REPOSITORY': 'idanilovqa/AlbumHaven', 'GITHUB_JOB': 'test_python',
        'GITHUB_WORKFLOW': 'PR Gates', 'GITHUB_RUN_ID': run, 'GITHUB_RUN_ATTEMPT': attempt,
        'GITHUB_SHA': '1' * 40, 'GITHUB_WORKSPACE': workspace,
        'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_REF': 'refs/pull/35/merge',
        'RUNNER_TEMP': runner_temp, 'PGBIN': r'C:\Program Files\PostgreSQL\17\bin',
        'PGPASSFILE': runner_temp + r'\ordinary.pgpass', 'PGPASSWORD': '',
        'ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION': 'windows-ci',
        'ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY': 'separate-owner',
        'ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER': 'operational-function',
    }
    event = {'number': 35, 'repository': {'full_name': 'idanilovqa/AlbumHaven'},
             'pull_request': {'head': {'sha': '2' * 40, 'repo': {'full_name': 'idanilovqa/AlbumHaven'}},
                              'base': {'sha': '3' * 40, 'repo': {'full_name': 'idanilovqa/AlbumHaven'}}}}
    event_path = tmp_path / 'event.json'
    event_path.write_text(json.dumps(event), encoding='utf-8')
    env['GITHUB_EVENT_PATH'] = str(event_path)
    receipts = {}
    def url(role, database):
        return 'postgresql://' + role + '@127.0.0.1/' + database
    ordinary = {}
    for category, suffix, setup_key, app_key in (
        ('persistent', 'py_contract', 'DATABASE_MIGRATOR_URL', 'DATABASE_APP_URL'),
        ('destructive', 'py', 'PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'PYTEST_DESTRUCTIVE_DATABASE_URL'),
    ):
        suffix += '_' + run + '_' + attempt
        database = 'album_haven_ci_' + suffix
        ordinary[category] = database
        env[setup_key] = url('album_haven_migrator_' + suffix, database)
        env[app_key] = url('album_haven_app_' + suffix, database)
    for cohort, suffix, prefix in (
        ('tracking-rollback', 'tr169', 'ALBUM_HAVEN_TRACKING_MIGRATION_'),
        ('historical-0153', 'hist153', 'ALBUM_HAVEN_TRACKING_HISTORICAL_'),
    ):
        suffix += '_' + run + '_' + attempt
        root = str(PureWindowsPath(runner_temp) / ('album-haven-tracking-' + cohort + '-' + run + '-' + attempt))
        database = 'album_haven_ci_' + suffix
        roles = {kind: {'name': 'album_haven_' + role + '_' + suffix, 'oid': 31001 + i}
                 for i, (kind, role) in enumerate((('setup', 'migrator'), ('app', 'app'), ('readonly', 'readonly')))}
        urls = {kind: url(role['name'], database) for kind, role in roles.items()}
        for kind in ('setup', 'app', 'readonly'):
            env[prefix + kind.upper() + '_URL'] = urls[kind]
        env[prefix + 'PGPASSFILE'] = root + r'\pgpass.conf'
        env[prefix + 'CI_RECEIPT'] = root + r'\receipt.json'
        receipts[cohort] = {
            'schema_version': 1, 'mode': 'windows-ci', 'cohort': cohort,
            'repository': env['GITHUB_REPOSITORY'], 'workflow': env['GITHUB_WORKFLOW'],
            'job': env['GITHUB_JOB'], 'run_id': run, 'run_attempt': attempt,
            'github_sha': env['GITHUB_SHA'], 'checkout_sha': env['GITHUB_SHA'],
            'event_pr_head_sha': '2' * 40, 'event_pr_base_sha': '3' * 40,
            'event_pr_repository': env['GITHUB_REPOSITORY'], 'runner_sid': 'S-1-5-21-1-2-3-1001',
            'root': root, 'receipt_path': env[prefix + 'CI_RECEIPT'],
            'pgpass_path': env[prefix + 'PGPASSFILE'], 'pgbin': env['PGBIN'],
            'ordinary_pgpass_path': env['PGPASSFILE'],
            'powershell_path': r'C:\Program Files\PowerShell\7\pwsh.exe',
            'powershell_sha256': 'a' * 64,
            'inspector_path': workspace + r'\scripts\ci\tracking-postgres-admission.ps1',
            'inspector_sha256': 'b' * 64,
            'baseline': 'aad200d9', 'migration_through': 153, 'migration_count': 147,
            'inventory_sha256': 'd15a9dd4a4b942b0c6ead1494505b6508a711ac630c99bd5ce24eb9ef03953f0',
            'host': '127.0.0.1', 'port': 5432, 'configured_service': 'postgresql-x64-17',
            'server_version_num': 170006, 'server_start_epoch': 1780000000,
            'server_system_identifier': '1234567890123456789',
            'database': database, 'database_oid': 32001,
            'database_owner': roles['setup']['name'], 'roles': roles, 'urls': urls,
            'ordinary_databases': dict(ordinary),
            'pgpass_identity': {'volume_serial': '123', 'file_id': '456', 'size': 180, 'last_write_filetime': '1234567'},
        }
    wire = {cohort: json.dumps(receipt).encode() for cohort, receipt in receipts.items()}
    calls = []
    monkeypatch.setattr(ci_module, '_require_windows', lambda: None)
    def inspect_model(actual, cohort):
        calls.append(cohort)
        return wire[cohort]
    monkeypatch.setattr(ci_module, '_inspect', inspect_model)
    return env, receipts, wire, event_path, calls


@pytest.mark.parametrize('cohort', ['tracking-rollback', 'historical-0153'])
def test_logical_ci_context_binds_separate_cohort_without_environment_mutation(ci_module, ci_case, cohort):
    env, receipts, _, _, calls = ci_case
    before = dict(env)
    context = ci_module.ci_context(env, cohort)
    expected = receipts[cohort]
    assert context['database'] == expected['database']
    assert context['setup'] == expected['urls']['setup']
    assert context['app'] == expected['urls']['app']
    assert str(context['pgpass']) == expected['pgpass_path']
    assert context['setup_role'] == expected['roles']['setup']['name']
    assert context['admission'] == 'windows-ci' and context['cohort'] == cohort
    assert context['topology'] == 'separate-owner'
    assert env == before and calls == [cohort]


@pytest.mark.parametrize('field,value', [
    ('GITHUB_ACTIONS', 'false'), ('RUNNER_OS', 'Linux'),
    ('GITHUB_REPOSITORY', 'elsewhere/AlbumHaven'), ('GITHUB_JOB', 'test_js'),
    ('GITHUB_RUN_ID', '0'), ('GITHUB_RUN_ATTEMPT', '0'),
    ('GITHUB_SHA', 'bad'), ('GITHUB_EVENT_NAME', 'pull_request_target'),
    ('ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION', 'local'),
])
def test_logical_ci_requires_real_job_identity(ci_module, ci_case, field, value):
    env = dict(ci_case[0], **{field: value})
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


@pytest.mark.parametrize('name', [
    'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSERVICE',
    'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE', 'PGSSLKEY', 'PGTARGETSESSIONATTRS',
    'PGFUTUREUNKNOWN', 'pgservice', 'PgOptions',
])
def test_logical_ci_closed_libpq_policy(ci_module, ci_case, name):
    env = dict(ci_case[0], **{name: ''})
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


def test_nonempty_password_is_rejected_without_rendering_it(ci_module, ci_case):
    env = dict(ci_case[0], PGPASSWORD='synthetic-not-a-credential')
    with pytest.raises(AssertionError) as error:
        ci_module.ci_context(env, 'tracking-rollback')
    assert 'synthetic-not-a-credential' not in str(error.value)


@pytest.mark.parametrize('name', ['pgbin', 'github_actions', 'Github_Job'])
def test_case_alias_environment_is_rejected_even_when_values_agree(ci_module, ci_case, name):
    env = dict(ci_case[0])
    env[name] = env[name.upper()]
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


@pytest.mark.parametrize('field,value', [
    ('schema_version', 2), ('schema_version', True), ('mode', 'local'),
    ('cohort', 'historical-0153'), ('repository', 'other/AlbumHaven'),
    ('job', 'other'), ('run_id', '41173588137'), ('run_attempt', '3'),
    ('github_sha', '4' * 40), ('checkout_sha', '2' * 40),
    ('event_pr_head_sha', '1' * 40), ('event_pr_base_sha', '4' * 40),
    ('event_pr_repository', 'other/AlbumHaven'), ('host', 'localhost'),
    ('port', True), ('server_version_num', 180001), ('server_start_epoch', 0),
    ('database_oid', True), ('database_owner', 'album_haven_migrator'),
    ('baseline', '9b29f4e3'), ('migration_through', 168), ('migration_count', 162),
    ('inventory_sha256', '0' * 64), ('powershell_path', r'C:\untrusted\pwsh.exe'),
    ('root', r'D:\a\_temp'), ('receipt_path', r'D:\a\_temp\foreign.json'),
    ('pgpass_path', r'D:\a\_temp\ordinary.pgpass'), ('extra_field', 'forbidden'),
])
def test_logical_receipt_rejects_identity_and_schema_drift(ci_module, ci_case, field, value):
    env, receipts, wire, _, _ = ci_case
    receipt = copy.deepcopy(receipts['tracking-rollback'])
    receipt[field] = value
    wire['tracking-rollback'] = json.dumps(receipt).encode()
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


@pytest.mark.parametrize('wire_kind', ['duplicate-key', 'not-json', 'list', 'oversized', 'missing-key', 'nested-extra'])
def test_logical_inspector_output_is_closed(ci_module, ci_case, wire_kind):
    env, receipts, wire, _, _ = ci_case
    receipt = copy.deepcopy(receipts['tracking-rollback'])
    raw = json.dumps(receipt)
    if wire_kind == 'duplicate-key': raw = raw.replace('"schema_version": 1', '"schema_version": 1, "schema_version": 1', 1)
    elif wire_kind == 'not-json': raw = 'not-json'
    elif wire_kind == 'list': raw = '[]'
    elif wire_kind == 'oversized': raw = ' ' * 131073 + raw
    elif wire_kind == 'missing-key': del receipt['runner_sid']; raw = json.dumps(receipt)
    elif wire_kind == 'nested-extra': receipt['roles']['setup']['safe'] = True; raw = json.dumps(receipt)
    wire['tracking-rollback'] = raw.encode()
    with pytest.raises((AssertionError, ValueError)):
        ci_module.ci_context(env, 'tracking-rollback')


@pytest.mark.parametrize('key', [
    'ALBUM_HAVEN_TRACKING_MIGRATION_SETUP_URL', 'ALBUM_HAVEN_TRACKING_MIGRATION_APP_URL',
    'ALBUM_HAVEN_TRACKING_MIGRATION_READONLY_URL',
])
@pytest.mark.parametrize('suffix', ['?options=-csearch_path%3Dpublic', '?passfile=foreign', '#fragment'])
def test_tracking_dsn_has_no_caller_options(ci_module, ci_case, key, suffix):
    env = dict(ci_case[0])
    env[key] += suffix
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


@pytest.mark.parametrize('destination,source', [
    ('ALBUM_HAVEN_TRACKING_HISTORICAL_SETUP_URL', 'ALBUM_HAVEN_TRACKING_MIGRATION_SETUP_URL'),
    ('DATABASE_MIGRATOR_URL', 'ALBUM_HAVEN_TRACKING_MIGRATION_SETUP_URL'),
    ('PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'ALBUM_HAVEN_TRACKING_MIGRATION_SETUP_URL'),
    ('DATABASE_MIGRATOR_URL', 'ALBUM_HAVEN_TRACKING_HISTORICAL_SETUP_URL'),
    ('PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'ALBUM_HAVEN_TRACKING_HISTORICAL_SETUP_URL'),
    ('PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'DATABASE_MIGRATOR_URL'),
])
def test_all_four_database_pairs_must_be_distinct(ci_module, ci_case, destination, source):
    env = dict(ci_case[0])
    env[destination] = env[source]
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


def test_same_repo_event_is_checked_not_just_environment(ci_module, ci_case):
    env, _, _, path, _ = ci_case
    event = json.loads(path.read_text())
    event['pull_request']['head']['repo']['full_name'] = 'foreign/fork'
    path.write_text(json.dumps(event), encoding='utf-8')
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


class NativeIdentityModel:
    """Read-only SQL model. This never supplies native Windows/PG evidence."""
    def __init__(self, receipt):
        roles = receipt['roles']
        self.identity = {
            key: receipt[key] for key in ('host', 'port', 'server_start_epoch', 'server_version_num',
                                         'database', 'database_oid', 'database_owner')}
        self.identity.update(current_role=roles['setup']['name'], session_role=roles['setup']['name'])
        self.roles = []
        self.memberships = {}
        for index, (kind, base) in enumerate((('setup', 'album_haven_migrator'),
                                            ('app', 'album_haven_app'), ('readonly', 'album_haven_readonly'))):
            for name, oid, login in ((roles[kind]['name'], roles[kind]['oid'], True),
                                     (base, 30001 + index, False)):
                self.roles.append(dict(oid=oid, rolname=name, rolsuper=False, rolcreatedb=False,
                                       rolcreaterole=False, rolreplication=False, rolbypassrls=False,
                                       rolcanlogin=login, rolinherit=True))
            self.memberships[(roles[kind]['name'], base)] = {'member': True, 'usage': True}
        self.statements = []

    def execute(self, sql, parameters=None):
        statement = str(sql).casefold()
        assert statement.lstrip().startswith('select'), 'Admission must never mutate SQL authority'
        self.statements.append((statement, parameters))
        if 'pg_has_role' in statement:
            assert parameters is not None
            # MEMBER and USAGE bind the same pair independently.
            assert tuple(parameters[:2]) == tuple(parameters[2:])
            row = self.memberships.get(tuple(parameters[:2]), {'member': False, 'usage': False})
            return ModelRows([row])
        if 'from pg_roles' in statement:
            return ModelRows(self.roles)
        if 'current_database()' in statement and 'session_user' in statement:
            return ModelRows([self.identity])
        raise AssertionError('Unexpected admission SQL shape')


class ModelRows:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        assert len(self.rows) == 1
        return self.rows[0]

    def fetchall(self):
        return self.rows


def test_logical_runtime_identity_accepts_only_read_only_queries(ci_module, ci_case):
    env, receipts, _, _, _ = ci_case
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipts['tracking-rollback'])
    ci_module.validate_ci_connection(connection, context)
    assert connection.statements
    assert connection.identity['current_role'] == context['setup_role']


@pytest.mark.parametrize('key,value', [
    ('host', '127.0.0.2'), ('port', 5433), ('server_start_epoch', 1780000001),
    ('server_version_num', 180001), ('database', 'foreign'), ('database_oid', 32002),
    ('database_owner', 'album_haven_migrator'), ('current_role', 'album_haven_migrator'),
    ('session_role', 'album_haven_migrator'),
])
def test_actual_connection_facts_must_match_receipt(ci_module, ci_case, key, value):
    env, receipts, _, _, _ = ci_case
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipts['tracking-rollback'])
    connection.identity[key] = value
    with pytest.raises(AssertionError):
        ci_module.validate_ci_connection(connection, context)


@pytest.mark.parametrize('kind', ['setup', 'app', 'readonly'])
@pytest.mark.parametrize('field,value', [
    ('rolsuper', True), ('rolcreatedb', True), ('rolcreaterole', True),
    ('rolreplication', True), ('rolbypassrls', True), ('rolcanlogin', False),
    ('rolinherit', False), ('oid', 99999),
])
def test_generated_logins_and_role_identity_are_checked(ci_module, ci_case, kind, field, value):
    env, receipts, _, _, _ = ci_case
    receipt = receipts['tracking-rollback']
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipt)
    row = next(row for row in connection.roles if row['rolname'] == receipt['roles'][kind]['name'])
    row[field] = value
    with pytest.raises(AssertionError):
        ci_module.validate_ci_connection(connection, context)


@pytest.mark.parametrize('kind,base', [('setup', 'album_haven_migrator'), ('app', 'album_haven_app'), ('readonly', 'album_haven_readonly')])
@pytest.mark.parametrize('field', ['member', 'usage'])
def test_generated_login_really_inherits_its_base(ci_module, ci_case, kind, base, field):
    env, receipts, _, _, _ = ci_case
    receipt = receipts['tracking-rollback']
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipt)
    connection.memberships[(receipt['roles'][kind]['name'], base)][field] = False
    with pytest.raises(AssertionError):
        ci_module.validate_ci_connection(connection, context)


@pytest.mark.parametrize('runtime', ['app', 'readonly', 'album_haven_app', 'album_haven_readonly'])
@pytest.mark.parametrize('owner', ['setup', 'album_haven_migrator'])
def test_runtime_roles_cannot_inherit_setup_authority(ci_module, ci_case, runtime, owner):
    env, receipts, _, _, _ = ci_case
    receipt = receipts['tracking-rollback']
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipt)
    runtime_name = receipt['roles'][runtime]['name'] if runtime in receipt['roles'] else runtime
    owner_name = receipt['roles'][owner]['name'] if owner in receipt['roles'] else owner
    connection.memberships[(runtime_name, owner_name)] = {'member': True, 'usage': True}
    with pytest.raises(AssertionError):
        ci_module.validate_ci_connection(connection, context)


@pytest.mark.parametrize('mutation', ['missing-role', 'duplicate-role', 'base-elevated'])
def test_role_catalog_must_be_complete_and_unprivileged(ci_module, ci_case, mutation):
    env, receipts, _, _, _ = ci_case
    context = ci_module.ci_context(env, 'tracking-rollback')
    connection = NativeIdentityModel(receipts['tracking-rollback'])
    if mutation == 'missing-role': connection.roles.pop()
    elif mutation == 'duplicate-role': connection.roles[-1] = dict(connection.roles[0])
    else:
        next(row for row in connection.roles if row['rolname'] == 'album_haven_app')['rolsuper'] = True
    with pytest.raises(AssertionError):
        ci_module.validate_ci_connection(connection, context)


@pytest.mark.parametrize('cohort', ['', 'ordinary', 'historical', 'tracking-rollback;exit'])
def test_unknown_cohort_never_invokes_inspector(ci_module, ci_case, cohort):
    env, _, _, _, calls = ci_case
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, cohort)
    assert not calls


@pytest.mark.parametrize('field,value', [('workflow', 'Different workflow'), ('runner_sid', 'not-a-sid'),
    ('database_oid', -1), ('roles', {'setup': {'name': 'foreign', 'oid': 1}})])
def test_remaining_receipt_type_identity_boundaries(ci_module, ci_case, field, value):
    env, receipts, wire, _, _ = ci_case
    receipt = copy.deepcopy(receipts['tracking-rollback'])
    receipt[field] = value
    wire['tracking-rollback'] = json.dumps(receipt).encode()
    with pytest.raises(AssertionError):
        ci_module.ci_context(env, 'tracking-rollback')


def test_nondefault_port_is_reconstructed_consistently_not_taken_from_ambient_libpq(ci_module, ci_case):
    env, receipts, wire, _, _ = ci_case
    env = dict(env)
    for key, value in env.items():
        if value.startswith('postgresql://'):
            env[key] = value.replace('@127.0.0.1/', '@127.0.0.1:55432/')
    for cohort, original in receipts.items():
        receipt = copy.deepcopy(original)
        receipt['port'] = 55432
        receipt['urls'] = {key: value.replace('@127.0.0.1/', '@127.0.0.1:55432/') for key, value in receipt['urls'].items()}
        wire[cohort] = json.dumps(receipt).encode()
    assert ci_module.ci_context(env, 'tracking-rollback')['port'] == 55432


@pytest.mark.parametrize('optimization', ['-O', '-OO'])
@pytest.mark.parametrize('api', ['ci_context', 'validate_ci_connection'])
def test_optimized_interpreter_rejects_before_platform_inspector_or_sql(optimization, api):
    # Real optimized child, no fake GITHUB_* values and no live connection.
    # Sentinels fail if reached; they never assert platform/CI authority.
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    code = '''
import sys
sys.path.insert(0, ROOT)
from tests.py import listening_tracking_ci_admission as admission
reached=[]
def forbidden(*args, **kwargs):
    reached.append(True)
    raise RuntimeError('guard boundary was reached before optimization rejection')
admission._inspect=forbidden
class NeverConnect:
    execute=forbidden
try:
    if API == 'ci_context': admission.ci_context({}, 'tracking-rollback')
    else: admission.validate_ci_connection(NeverConnect(), {})
except (AssertionError, RuntimeError) as error:
    if reached or 'assertion' not in str(error).casefold(): raise SystemExit(2)
else:
    raise SystemExit(3)
print('optimization rejected')
'''.replace('ROOT', repr(str(root))).replace('API', repr(api))
    result = subprocess.run([sys.executable, '-I', '-B', optimization, '-c', code],
                            capture_output=True, timeout=15, check=False)
    assert result.returncode == 0, 'Optimized interpreter did not reject at the public boundary'
    assert result.stdout.strip() == b'optimization rejected' and result.stderr == b''
