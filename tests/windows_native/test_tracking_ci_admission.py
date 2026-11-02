"""Real hosted-Windows qualification; no mocked platform, ACL or SQL authority.

Run explicitly: python -I -B tests/windows_native/test_tracking_ci_admission.py --ci
This directory is deliberately outside ordinary pytest testpaths.
"""
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
POWERSHELL = Path(r'C:\Program Files\PowerShell\7\pwsh.exe')
HELPER = ROOT / 'scripts/ci/tracking-postgres-admission.ps1'
BOOTSTRAP = ROOT / 'scripts/ci/bootstrap-windows-postgres.ps1'
COHORTS = ('tracking-rollback', 'historical-0153')
FAILPOINTS = ('before-roles', 'after-roles-commit', 'after-roles-record',
              'before-database', 'after-database-create', 'after-database-record',
              'before-seal', 'after-seal')


class NativeEnvironment(dict):
    # Preserve mapping behavior while preventing fixture argument reprs from
    # rendering unrelated tokens carried by the real runner environment.
    def __repr__(self):
        return '<native CI environment: values redacted>'


def ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def native_requirements():
    assert os.name == 'nt' and sys.platform == 'win32', 'Actual Windows is required'
    assert sys.flags.isolated and sys.dont_write_bytecode, 'Use the isolated native entrypoint'
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_OS') == 'Windows'
    assert os.environ.get('GITHUB_JOB') == 'test_python'
    assert os.environ.get('GITHUB_REPOSITORY') == 'idanilovqa/AlbumHaven'
    assert not os.environ.get('PYTEST_ADDOPTS') and not os.environ.get('PYTEST_PLUGINS')
    if sys.flags.optimize:
        raise RuntimeError('Native proof requires assertions enabled')
    assert POWERSHELL.is_file() and HELPER.is_file() and BOOTSTRAP.is_file()
    assert Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True) == ROOT.resolve(strict=True)


_native_safe = True


def creation_identity(process):
    """Read the original HANDLE, not a PID that could have been reused."""
    import ctypes
    from ctypes import wintypes
    from datetime import datetime
    get_times = ctypes.WinDLL('kernel32', use_last_error=True).GetProcessTimes
    get_times.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    get_times.restype = wintypes.BOOL
    values = [wintypes.FILETIME() for _ in range(4)]
    if not get_times(wintypes.HANDLE(int(process._handle)), *(ctypes.byref(value) for value in values)):
        raise RuntimeError('Native process creation identity unavailable')
    created = (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
    # The existing repository supervisor uses .NET DateTime ticks, not FILETIME.
    epoch_ticks = (datetime(1601, 1, 1) - datetime(1, 1, 1)).days * 864000000000
    return str(created + epoch_ticks)


def stop_owned_tree(process, identity):
    """Reuse repository PID/creation-identity guarded Windows tree cleanup."""
    if process.poll() is not None:
        raise RuntimeError('Native root already exited; descendant outcome uncertain')
    node_value = shutil.which('node')
    if not node_value:
        raise RuntimeError('Repository process-tree supervisor prerequisite unavailable')
    node = Path(node_value).resolve(strict=True)
    code = """
const helper = require(process.argv[1])._private;
const pid = Number(process.argv[2]);
const identity = process.argv[3];
if (helper.readProcessCreationIdentity(pid) !== identity) process.exit(2);
const before = helper.readProcessTreeIdentities(pid);
const root = before.find(item => item.pid === pid && item.depth === 0);
if (!root || root.creationIdentity !== identity) process.exit(3);
helper.stopProcessTree(pid, { expectedCreationIdentity: identity });
for (const item of before) {
  if (helper.readProcessCreationIdentity(item.pid) === item.creationIdentity) process.exit(4);
}
"""
    result = subprocess.run([str(node), '-e', code, str(ROOT / 'scripts/run-playwright.cjs'),
                             str(process.pid), identity],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=45, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0:
        raise RuntimeError('Native process-tree termination unconfirmed')
    process.wait(timeout=10)


def run_ps(body, env=None, timeout=180):
    global _native_safe
    if not _native_safe:
        raise RuntimeError('Further native mutation is blocked after uncertain process outcome')
    # Bootstrap emits secret-bearing add-mask directives. Do not capture them:
    # pytest assertion rewriting or subprocess exception reprs could expose an
    # otherwise hidden buffer. Both child streams are discarded, never stored.
    command = [str(POWERSHELL), '-NoLogo', '-NoProfile', '-NonInteractive',
               '-Command', "$ErrorActionPreference='Stop'; " + body]
    # Set quarantine BEFORE launch: even an interrupted Popen constructor must
    # not leave a safe cleanup receipt when no child handle was returned.
    _native_safe = False
    try:
        process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   shell=False, creationflags=subprocess.CREATE_NO_WINDOW)
    except BaseException as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        pytest.exit('Native launch outcome uncertain; dependent work stopped', returncode=1)
    identity = None
    completed = False
    try:
        identity = creation_identity(process)
        returncode = process.wait(timeout=timeout)
        completed = True
    except BaseException as error:
        # No following test or fixture teardown may race a surviving descendant.
        _native_safe = False
        try:
            if identity is not None:
                stop_owned_tree(process, identity)
            elif process.poll() is None:
                process.kill()  # Original HANDLE only; no claimed tree cleanup.
                process.wait(timeout=10)
        except BaseException:
            # Never publish cleanup-safe after an interrupted supervisor.
            pass
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        pytest.exit('Native process outcome uncertain; dependent native work stopped', returncode=1)
    finally:
        if not completed:
            _native_safe = False
    if returncode != 0:
        _native_safe = False
        pytest.exit('Native operation failed; child output discarded and dependent work stopped', returncode=1)
    _native_safe = True


def cohort_parameters(cohort, exports):
    run, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    suffix = ('tr169_' if cohort == 'tracking-rollback' else 'hist153_') + run + '_' + attempt
    root = Path(os.environ['RUNNER_TEMP']) / ('album-haven-tracking-' + cohort + '-' + run + '-' + attempt)
    return ('-TrackingCohort ' + ps_literal(cohort) + ' -MigrationThrough 153 -DatabaseSuffix ' + ps_literal(suffix)
            + ' -StatePath ' + ps_literal(root / 'state.json') + ' -GithubEnv ' + ps_literal(exports)
            + ' -HostName 127.0.0.1 -AppPrivilegeMode Inherited -SkipFixtureLoad -ExpectedMajorVersion 17'
            + ' -Pgbin ' + ps_literal(os.environ['PGBIN']))


def read_exports(path, env):
    # Only passwordless metadata exports; never open the referenced pgpass.
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        key, separator, value = line.partition('=')
        assert separator and key.startswith(('ALBUM_HAVEN_TRACKING_MIGRATION_', 'ALBUM_HAVEN_TRACKING_HISTORICAL_'))
        assert key not in ('PGPASSWORD', 'PGPASSFILE')
        env[key] = value


@pytest.fixture(scope='class')
def native_cohorts(tmp_path_factory):
    native_requirements()
    directory = tmp_path_factory.mktemp('tracking-native-exports')
    # Begin with no cohort exports; provisioner must create/seal independently.
    env = NativeEnvironment({key: value for key, value in os.environ.items()
           if not key.startswith(('ALBUM_HAVEN_TRACKING_MIGRATION_', 'ALBUM_HAVEN_TRACKING_HISTORICAL_'))})
    provisioned = []
    try:
        for cohort in COHORTS:
            owned_root = Path(env['RUNNER_TEMP']) / ('album-haven-tracking-' + cohort + '-' + env['GITHUB_RUN_ID'] + '-' + env['GITHUB_RUN_ATTEMPT'])
            assert not owned_root.exists() and not owned_root.is_symlink(), 'Native fixture target already exists'
            exports = directory / (cohort + '.env')
            params = cohort_parameters(cohort, exports)
            # An intent alone never grants the fixture authority to DROP. Only
            # production Teardown may interpret its protected confirmed state.
            provisioned.append((cohort, params))
            run_ps('& ' + ps_literal(BOOTSTRAP) + ' -Mode Provision ' + params, env, timeout=900)
            read_exports(exports, env)
        yield env
    finally:
        for cohort, params in reversed(provisioned):
            run_ps('& ' + ps_literal(BOOTSTRAP) + ' -Mode Teardown ' + params, env, timeout=180)


class TestNativeProtectedReceipt:
    @pytest.mark.parametrize('cohort', COHORTS)
    def test_real_inspector_and_sql_endpoint(self, native_cohorts, cohort):
        # Imports occur only after genuine Windows/CI admission and owned setup.
        from tests.py.listening_tracking_ci_admission import ci_context, validate_ci_connection
        import psycopg
        from psycopg.rows import dict_row
        context = ci_context(native_cohorts, cohort)
        with psycopg.connect(context['setup'], passfile=str(context['pgpass']),
                              row_factory=dict_row, connect_timeout=5,
                              options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000') as connection:
            validate_ci_connection(connection, context)
            row = connection.execute('select count(*) as n from ops.schema_migrations').fetchone()
            assert row == {'n': 147}
            assert connection.execute("select to_regclass('integration.playback_capture_owner') as name").fetchone() == {'name': None}

    @pytest.mark.parametrize('leaf', ['ReceiptPath', 'PassfilePath'])
    def test_open_handles_block_write_and_replacement(self, native_cohorts, leaf):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$target=$null; $held=$false;
With-TrackingProtectedFiles -Cohort tracking-rollback -Body {
    param($files)
    $script:target=$files.LEAF; $deniedWrite=$false; $deniedRename=$false;
    try { $s=[IO.File]::Open($script:target,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $s.Dispose() } catch [IO.IOException] { $deniedWrite=$true }
    try { [IO.File]::Move($script:target,($script:target+'.substitution')); [IO.File]::Move(($script:target+'.substitution'),$script:target) } catch [IO.IOException] { $deniedRename=$true }
    if (-not $deniedWrite -or -not $deniedRename) { throw 'retained handle failed to exclude modification' }
    $script:held=$true;
};
if (-not $held) { throw 'protected callback did not run' }
# Independent release control, restoring the owned file before returning.
[IO.File]::Move($target,($target+'.release-control'));
[IO.File]::Move(($target+'.release-control'),$target);
'''.replace('LEAF', leaf)
        run_ps(body, native_cohorts)

    @pytest.mark.parametrize('rights', ['Read', 'Write'])
    def test_actual_broad_acl_is_rejected(self, native_cohorts, rights):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_PGPASSFILE;
$original=Get-Acl -LiteralPath $path;
try {
  $acl=Get-Acl -LiteralPath $path;
  $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::RIGHTS,[Security.AccessControl.AccessControlType]::Allow);
  $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;
  $rejected=$false; $script:reached=$false; try { With-TrackingProtectedFiles -Cohort tracking-rollback -Body { $script:reached=$true } } catch { $rejected=$true }
  if (-not $rejected -or $script:reached) { throw 'actual broad ACL was admitted' }
} finally { Set-Acl -LiteralPath $path -AclObject $original }
With-TrackingProtectedFiles -Cohort tracking-rollback -Body { param($files) };
'''.replace('RIGHTS', rights)
        run_ps(body, native_cohorts)

    def test_actual_hardlink_is_rejected(self, native_cohorts):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_PGPASSFILE;
$link=$path+'.native-hardlink';
try {
  New-Item -ItemType HardLink -Path $link -Target $path | Out-Null;
  $rejected=$false; $script:reached=$false; try { With-TrackingProtectedFiles -Cohort tracking-rollback -Body { $script:reached=$true } } catch { $rejected=$true }
  if (-not $rejected -or $script:reached) { throw 'actual hardlink was admitted' }
} finally { if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force } }
With-TrackingProtectedFiles -Cohort tracking-rollback -Body { param($files) };
'''
        run_ps(body, native_cohorts)

    def test_actual_root_junction_is_rejected(self, native_cohorts):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$root=Split-Path -Parent $env:ALBUM_HAVEN_TRACKING_MIGRATION_PGPASSFILE;
$backup=$root+'.native-junction-target'; $moved=$false; $linked=$false;
try {
  [IO.Directory]::Move($root,$backup); $moved=$true;
  New-Item -ItemType Junction -Path $root -Target $backup | Out-Null; $linked=$true;
  $rejected=$false; $script:reached=$false; try { With-TrackingProtectedFiles -Cohort tracking-rollback -Body { $script:reached=$true } } catch { $rejected=$true }
  if (-not $rejected -or $script:reached) { throw 'actual junction was admitted' }
} finally {
  if ($linked) { [IO.Directory]::Delete($root) }
  if ($moved) { [IO.Directory]::Move($backup,$root) }
}
With-TrackingProtectedFiles -Cohort tracking-rollback -Body { param($files) };
'''
        run_ps(body, native_cohorts)


    def test_actual_wrong_file_owner_is_rejected(self, native_cohorts):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_PGPASSFILE;
$original=Get-Acl -LiteralPath $path;
try {
  $acl=Get-Acl -LiteralPath $path;
  $differentOwner=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent();
  $principal=[Security.Principal.WindowsPrincipal]::new($identity);
  if ($identity.User.Value -ceq $differentOwner.Value -or -not $principal.IsInRole($differentOwner)) { throw 'enabled alternate owner group is unavailable' }
  # Assign only the already-enabled Administrators group; never enable token
  # privileges or attempt to assume SYSTEM ownership.
  $acl.SetOwner($differentOwner);
  Set-Acl -LiteralPath $path -AclObject $acl;
  $owner=(Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value;
  if ($owner -cne $differentOwner.Value) { throw 'wrong-owner fixture not established' }
  $rejected=$false; $script:reached=$false;
  try { With-TrackingProtectedFiles -Cohort tracking-rollback -Body { $script:reached=$true } } catch { $rejected=$true }
  if (-not $rejected -or $script:reached) { throw 'wrong actual owner admitted' }
} finally { Set-Acl -LiteralPath $path -AclObject $original }
With-TrackingProtectedFiles -Cohort tracking-rollback -Body { param($files) };
'''
        run_ps(body, native_cohorts)

    def test_actual_leaf_symlink_is_rejected(self, native_cohorts):
        body = '. ' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_PGPASSFILE;
$backup=(Split-Path -Parent $path)+'.native-passfile-target'; $moved=$false; $linked=$false;
try {
  [IO.File]::Move($path,$backup); $moved=$true;
  New-Item -ItemType SymbolicLink -Path $path -Target $backup | Out-Null; $linked=$true;
  $rejected=$false; $script:reached=$false;
  try { With-TrackingProtectedFiles -Cohort tracking-rollback -Body { $script:reached=$true } } catch { $rejected=$true }
  if (-not $rejected -or $script:reached) { throw 'actual leaf symlink admitted' }
} finally {
  if ($linked) { [IO.File]::Delete($path) }
  if ($moved) { [IO.File]::Move($backup,$path) }
}
With-TrackingProtectedFiles -Cohort tracking-rollback -Body { param($files) };
'''
        run_ps(body, native_cohorts)

    @pytest.mark.parametrize('field', ['run_id', 'run_attempt', 'job', 'checkout_sha', 'event_pr_head_sha'])
    def test_actual_receipt_identity_tampering_is_rejected(self, native_cohorts, field):
        body = '$field=' + ps_literal(field) + '; $helper=' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_CI_RECEIPT;
$original=[IO.File]::ReadAllBytes($path);
try {
  $receipt=[Text.Encoding]::UTF8.GetString($original) | ConvertFrom-Json -AsHashtable;
  if ($field -eq 'checkout_sha') { $receipt[$field]=$receipt.event_pr_head_sha }
  elseif ($field -eq 'event_pr_head_sha') { $receipt[$field]=$receipt.checkout_sha }
  elseif ($field -eq 'job') { $receipt[$field]='other_job' }
  else { $receipt[$field]=[string]([long]$receipt[$field]+1) }
  [IO.File]::WriteAllText($path,($receipt | ConvertTo-Json -Depth 20 -Compress),[Text.UTF8Encoding]::new($false));
'''
        body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File $helper -Mode Inspect -Cohort tracking-rollback *> $null; if ($LASTEXITCODE -eq 0) { throw "tampered receipt admitted" }; '
        body += '''
} finally { [IO.File]::WriteAllBytes($path,$original) }
'''
        body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File $helper -Mode Inspect -Cohort tracking-rollback *> $null; if ($LASTEXITCODE -ne 0) { throw "restored receipt did not validate" }; '
        run_ps(body, native_cohorts)


    def test_ordinary_databases_still_have_current_migration(self, native_cohorts):
        from tests.py.listening_tracking_ci_admission import ci_context
        import psycopg
        from psycopg.rows import dict_row
        # Admission checks all four exact DSNs before these read-only probes.
        ci_context(native_cohorts, 'tracking-rollback')
        for key, prefix in (('DATABASE_MIGRATOR_URL', 'py_contract'),
                            ('PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL', 'py')):
            expected = 'album_haven_ci_' + prefix + '_' + native_cohorts['GITHUB_RUN_ID'] + '_' + native_cohorts['GITHUB_RUN_ATTEMPT']
            with psycopg.connect(native_cohorts[key], passfile=native_cohorts['PGPASSFILE'],
                                  row_factory=dict_row, connect_timeout=5,
                                  options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000') as connection:
                assert connection.execute('select current_database() as db').fetchone() == {'db': expected}
                assert connection.execute('select count(*) as n from ops.schema_migrations').fetchone() == {'n': 148}
                assert connection.execute("select count(*) as n from ops.schema_migrations where migration_name='0169_install_listening_tracking_storage.sql'").fetchone() == {'n': 1}

    def test_tracking_migration_rollback_leaves_historical_cohort_untouched(self, native_cohorts):
        from tests.py.listening_tracking_migration_support import pre0169_connection, run_migration
        from tests.py.listening_tracking_ci_admission import ci_context, validate_ci_connection
        import psycopg
        from psycopg.rows import dict_row
        env = NativeEnvironment(native_cohorts)
        env.update(ALBUM_HAVEN_TRACKING_MIGRATION_TEST='exclusive-isolated-rollback',
                   ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION='windows-ci',
                   ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY='separate-owner',
                   ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER='operational-function',
                   ALBUM_HAVEN_TRACKING_MIGRATION_BASELINE='aad200d9')
        with pre0169_connection(env) as (connection, ownership):
            run_migration(connection, ownership)
            assert connection.execute('select count(*) as n from ops.schema_migrations').fetchone() == {'n': 148}
        for cohort in COHORTS:
            context = ci_context(env, cohort)
            with psycopg.connect(context['setup'], passfile=str(context['pgpass']),
                                  row_factory=dict_row, connect_timeout=5,
                                  options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000') as connection:
                validate_ci_connection(connection, context)
                assert connection.execute('select count(*) as n from ops.schema_migrations').fetchone() == {'n': 147}
                assert connection.execute("select to_regclass('integration.playback_capture_owner') as name").fetchone() == {'name': None}


    @pytest.mark.parametrize('field,kind', [('schema_version', 'bool'), ('schema_version', 'string'),
                                          ('port', 'string'), ('database_oid', 'string')])
    def test_native_receipt_does_not_coerce_scalar_types(self, native_cohorts, field, kind):
        body = '$field=' + ps_literal(field) + '; $kind=' + ps_literal(kind) + '; $helper=' + ps_literal(HELPER) + '; '
        body += '''$path=$env:ALBUM_HAVEN_TRACKING_MIGRATION_CI_RECEIPT;
$original=[IO.File]::ReadAllBytes($path);
try {
  $receipt=[Text.Encoding]::UTF8.GetString($original) | ConvertFrom-Json -AsHashtable;
  $receipt[$field]=if ($kind -eq 'bool') { $true } else { [string]$receipt[$field] };
  [IO.File]::WriteAllText($path,($receipt | ConvertTo-Json -Depth 20 -Compress),[Text.UTF8Encoding]::new($false));
'''
        body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File $helper -Mode Inspect -Cohort tracking-rollback *> $null; if ($LASTEXITCODE -eq 0) { throw "coercible receipt scalar admitted" }; '
        body += '''
} finally { [IO.File]::WriteAllBytes($path,$original) }
'''
        body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File $helper -Mode Inspect -Cohort tracking-rollback *> $null; if ($LASTEXITCODE -ne 0) { throw "restored receipt did not validate" }; '
        run_ps(body, native_cohorts)

    @pytest.mark.parametrize('field', ['schema-bool', 'schema-string', 'port-string', 'database-oid-string', 'role-oid-string'])
    def test_native_teardown_rejects_coercible_state_without_touching_resources(self, native_cohorts, tmp_path, field):
        params = cohort_parameters('tracking-rollback', tmp_path / 'state-scalar.env')
        body = '$field=' + ps_literal(field) + '; '
        body += '''$path=Join-Path (Split-Path -Parent $env:ALBUM_HAVEN_TRACKING_MIGRATION_CI_RECEIPT) 'state.json';
$original=[IO.File]::ReadAllBytes($path);
try {
  $state=[Text.Encoding]::UTF8.GetString($original) | ConvertFrom-Json -AsHashtable;
  switch ($field) {
    'schema-bool' { $state.schema_version=$true }
    'schema-string' { $state.schema_version='2' }
    'port-string' { $state.identity.port=[string]$state.identity.port }
    'database-oid-string' { $state.database.oid=[string]$state.database.oid }
    'role-oid-string' { $state.roles.setup.oid=[string]$state.roles.setup.oid }
  }
  [IO.File]::WriteAllText($path,($state | ConvertTo-Json -Depth 20 -Compress),[Text.UTF8Encoding]::new($false));
'''
        body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File ' + ps_literal(BOOTSTRAP) + ' -Mode Teardown ' + params + ' *> $null; if ($LASTEXITCODE -eq 0) { throw "coercible state authorized teardown" }; '
        body += '''
} finally { [IO.File]::WriteAllBytes($path,$original) }
'''
        run_ps(body, native_cohorts)
        # Existing receipt binds exact original OIDs, not merely reused names.
        from tests.py.listening_tracking_ci_admission import ci_context, validate_ci_connection
        import psycopg
        from psycopg.rows import dict_row
        context = ci_context(native_cohorts, 'tracking-rollback')
        with psycopg.connect(context['setup'], passfile=str(context['pgpass']), row_factory=dict_row,
                              connect_timeout=5, options='-c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000') as connection:
            validate_ci_connection(connection, context)


    def test_actual_intermediate_ancestor_junction_is_rejected(self, native_cohorts, tmp_path):
        body = '. ' + ps_literal(HELPER) + '; $owned=' + ps_literal(tmp_path) + '; '
        body += '''$target=Join-Path $owned 'plain'; $alias=Join-Path $owned 'junction';
[IO.Directory]::CreateDirectory((Join-Path $target 'nested')) | Out-Null;
$leaf=Join-Path $target 'nested\\metadata.txt'; [IO.File]::WriteAllText($leaf,'synthetic');
$control=Open-TrackingAncestors $leaf; foreach ($handle in $control) { $handle.Dispose() }
try {
  New-Item -ItemType Junction -Path $alias -Target $target | Out-Null;
  $rejected=$false; $handles=$null;
  try { $handles=Open-TrackingAncestors (Join-Path $alias 'nested\\metadata.txt') } catch { $rejected=$true }
  finally { if ($handles) { foreach ($handle in $handles) { $handle.Dispose() } } }
  if (-not $rejected) { throw 'actual intermediate junction admitted' }
} finally { if (Test-Path -LiteralPath $alias) { [IO.Directory]::Delete($alias) } }
'''
        run_ps(body, native_cohorts)


    @pytest.mark.parametrize('kind', ['missing', 'malformed', 'unsafe'])
    def test_cleanup_evidence_rejects_missing_malformed_or_unsafe(self, native_cohorts, kind):
        body = '. ' + ps_literal(HELPER) + '; $kind=' + ps_literal(kind) + '; '
        body += '''$directory=Join-Path $env:RUNNER_TEMP ('album-haven-tracking-native-'+$env:GITHUB_RUN_ID+'-'+$env:GITHUB_RUN_ATTEMPT+'\\evidence');
$path=Join-Path $directory 'result.json';
if (Test-Path -LiteralPath $path) { throw 'native proof already exists before suite completion' }
try {
  if ($kind -eq 'malformed') { [IO.File]::WriteAllText($path,'{not-json') }
  elseif ($kind -eq 'unsafe') {
    $proof=@{ schema_version=1; repository='idanilovqa/AlbumHaven'; run_id=$env:GITHUB_RUN_ID;
      run_attempt=$env:GITHUB_RUN_ATTEMPT; github_sha=$env:GITHUB_SHA; exit_code=1;
      results=@(); native_windows=$true; credential_output=$false;
      unsafe_process_tree=$true; cleanup_safe=$false };
    [IO.File]::WriteAllText($path,($proof | ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false));
  }
  $rejected=$false;
  try { Assert-TrackingCleanupEvidence -Cohort tracking-rollback } catch { $rejected=$true }
  if (-not $rejected) { throw 'missing or unsafe native proof authorized cleanup' }
} finally {
  # Never create a synthetic safe proof. Cancellation can leave only absent,
  # malformed or explicitly unsafe metadata; main writes real evidence last.
  if (Test-Path -LiteralPath $path) { [IO.File]::Delete($path) }
}
'''
        run_ps(body, native_cohorts)


    @pytest.mark.parametrize('kind', ['safe-failed-run', 'schema-bool', 'wrong-run', 'wrong-attempt',
                                     'wrong-sha', 'wrong-repository', 'unsafe', 'not-safe',
                                     'not-native', 'credential-output', 'extra-key', 'missing-key', 'exit-bool'])
    def test_cleanup_payload_identity_and_safety_without_publishing_a_proof(self, native_cohorts, kind):
        body = '. ' + ps_literal(HELPER) + '; $kind=' + ps_literal(kind) + '; '
        body += '''$context=Get-TrackingContext tracking-rollback;
$proof=@{ schema_version=1; repository='idanilovqa/AlbumHaven'; run_id=$env:GITHUB_RUN_ID;
  run_attempt=$env:GITHUB_RUN_ATTEMPT; github_sha=$env:GITHUB_SHA; exit_code=1;
  results=@(); native_windows=$true; credential_output=$false;
  unsafe_process_tree=$false; cleanup_safe=$true };
# Pure in-memory validator only. A failed assertion run may authorize cleanup
# when its process tree is proven safe, but it never becomes a passing run.
Assert-TrackingCleanupPayload $proof $context;
if ($proof.exit_code -ne 1) { throw 'cleanup validator changed a failure to success' }
if ($kind -ne 'safe-failed-run') {
  switch ($kind) {
    'schema-bool' { $proof.schema_version=$true }
    'wrong-run' { $proof.run_id=[string]([long]$env:GITHUB_RUN_ID+1) }
    'wrong-attempt' { $proof.run_attempt=[string]([long]$env:GITHUB_RUN_ATTEMPT+1) }
    'wrong-sha' { $proof.github_sha=('0'*40) }
    'wrong-repository' { $proof.repository='foreign/AlbumHaven' }
    'unsafe' { $proof.unsafe_process_tree=$true }
    'not-safe' { $proof.cleanup_safe=$false }
    'not-native' { $proof.native_windows=$false }
    'credential-output' { $proof.credential_output=$true }
    'extra-key' { $proof.unreviewed='extra' }
    'missing-key' { $proof.Remove('cleanup_safe') }
    'exit-bool' { $proof.exit_code=$false }
  }
  $rejected=$false; try { Assert-TrackingCleanupPayload $proof $context } catch { $rejected=$true }
  if (-not $rejected) { throw 'unsafe cleanup payload was admitted' }
}
'''
        run_ps(body, native_cohorts)


# Native-only administrative observations/cleanup, always bound to identities
# returned from a successful create in this same dot-sourced process. No name-
# prefix, prior-absence observation, or intent authorizes deletion.
CONFIRMED_CLEANUP = r'''
function Native-Scalar([string]$Sql) {
  $answer=@(& (Join-Path $Pgbin 'psql.exe') -X -w -h 127.0.0.1 -p $Port -U $AdminRole -d postgres -qAt -c $Sql 2>$null);
  if ($LASTEXITCODE -ne 0 -or $answer.Count -gt 1) { throw 'native observation failed' }
  if ($answer.Count -eq 0) { return '' }; return [string]$answer[0];
}
function Native-RoleOid([string]$Name) {
  if ($Name -cnotmatch '^album_haven_(migrator|app|readonly)_[a-z0-9_]+$') { throw 'unsafe native role identity' }
  return Native-Scalar "select oid from pg_roles where rolname='$Name'";
}
function Native-DatabaseOid([string]$Name) {
  if ($Name -cnotmatch '^album_haven_ci_[a-z0-9_]+$') { throw 'unsafe native database identity' }
  return Native-Scalar "select oid from pg_database where datname='$Name'";
}
function Native-CleanupConfirmed($Record) {
  # Validate the complete surviving identity set before deleting any resource.
  if ($Record.database_status -eq 'created') {
    $current=Native-DatabaseOid $Record.database.name;
    if ($current -and $current -ne [string]$Record.database.oid) { throw 'replacement database retained' }
    if ($current) {
      $owner=Native-Scalar "select pg_get_userbyid(datdba) from pg_database where oid=$($Record.database.oid)";
      if ($owner -cne $Record.database.owner) { throw 'changed database owner retained' }
    }
  }
  if ($Record.roles_status -eq 'created') {
    foreach ($kind in @('setup','app','readonly')) {
      $role=$Record.roles.$kind; $oid=Native-RoleOid $role.name;
      if ($oid -and $oid -ne [string]$role.oid) { throw 'replacement role retained' }
    }
  }
  if ($Record.database_status -eq 'created' -and (Native-DatabaseOid $Record.database.name)) {
    Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop database $($Record.database.name);";
  }
  if ($Record.roles_status -eq 'created') {
    foreach ($kind in @('readonly','app','setup')) {
      $role=$Record.roles.$kind;
      if (Native-RoleOid $role.name) { Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop role $($role.name);" }
    }
  }
}
'''


@pytest.mark.parametrize('point', FAILPOINTS)
def test_native_partial_creation_uses_only_confirmed_ownership(tmp_path, point):
    native_requirements()
    exports = tmp_path / 'native-lifecycle.env'
    params = cohort_parameters('tracking-rollback', exports)
    body = '. ' + ps_literal(BOOTSTRAP) + ' ' + params + ' -TrackingFailurePoint ' + ps_literal(point) + '; '
    body += CONFIRMED_CLEANUP
    body += '$expected=' + ps_literal(point) + '; $confirmed=$null; $caught=$false; '
    body += r'''
try {
  try { Assert-ContractInputs; $contract=Get-Contract; Invoke-Provision $contract } catch {
    if ($_.Exception.Message -cne ('tracking-native-failpoint:'+$expected)) { throw 'unexpected provisioning failure' }
    $caught=$true;
  }
  if (-not $caught) { throw 'requested failure point was not reached' }
  $confirmed=Get-TrackingConfirmedCreation;
  $old=Set-AdminAuthentication;
  try {
    $beforeRoles=@{};
    if ($confirmed.roles_status -eq 'created') {
      foreach ($kind in @('setup','app','readonly')) {
        $role=$confirmed.roles.$kind;
        if ((Native-RoleOid $role.name) -cne [string]$role.oid) { throw 'confirmed role mismatch before teardown' }
        $beforeRoles[$kind]=[string]$role.oid;
      }
    }
    if ($confirmed.database_status -eq 'created' -and (Native-DatabaseOid $confirmed.database.name) -cne [string]$confirmed.database.oid) { throw 'confirmed database mismatch before teardown' }
  } finally { Restore-AdminAuthentication $old }
'''
    # A separate process cannot see Get-TrackingConfirmedCreation memory.
    body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File ' + ps_literal(BOOTSTRAP) + ' -Mode Teardown ' + params + ' *> $null; $teardownExit=$LASTEXITCODE; '
    body += r'''
  $old=Set-AdminAuthentication;
  try {
    if ($expected -eq 'after-roles-commit') {
      if ($teardownExit -eq 0) { throw 'ambiguous role creation reported cleaned' }
      foreach ($kind in @('setup','app','readonly')) {
        $role=$confirmed.roles.$kind;
        if ((Native-RoleOid $role.name) -cne [string]$role.oid) { throw 'unrecorded role was removed' }
      }
    } elseif ($expected -eq 'after-database-create') {
      if ($teardownExit -eq 0) { throw 'ambiguous database creation reported cleaned' }
      if ((Native-DatabaseOid $confirmed.database.name) -cne [string]$confirmed.database.oid) { throw 'unrecorded database was removed' }
    } else {
      if ($teardownExit -ne 0) { throw 'recorded owned resource cleanup failed' }
      if ($confirmed.database_status -eq 'created' -and (Native-DatabaseOid $confirmed.database.name)) { throw 'recorded database leaked' }
      if ($confirmed.roles_status -eq 'created') {
        foreach ($kind in @('setup','app','readonly')) { if (Native-RoleOid $confirmed.roles.$kind.name) { throw 'recorded role leaked' } }
      }
    }
  } finally { Restore-AdminAuthentication $old }
} finally {
  $confirmed=Get-TrackingConfirmedCreation;
  if ($null -ne $confirmed) {
    $old=Set-AdminAuthentication;
    try { Native-CleanupConfirmed $confirmed } finally { Restore-AdminAuthentication $old }
    if (Test-Path -LiteralPath $StatePath) { Remove-TrackingFiles -Cohort tracking-rollback }
  }
}
'''
    run_ps(body, timeout=900)


@pytest.mark.parametrize('kind', ['role', 'database'])
def test_native_preexisting_collision_never_authorizes_cleanup(tmp_path, kind):
    native_requirements()
    params = cohort_parameters('tracking-rollback', tmp_path / 'collision.env')
    body = '. ' + ps_literal(BOOTSTRAP) + ' ' + params + '; ' + CONFIRMED_CLEANUP
    body += '$kind=' + ps_literal(kind) + '; '
    body += r'''
Assert-ContractInputs; $contract=Get-Contract; $createdOid=$null; $createdOwner=$null;
$old=Set-AdminAuthentication;
try {
  if ((Native-DatabaseOid $contract.database) -or (Native-RoleOid $contract.roles.migrator)) { throw 'native collision fixture target not empty' }
  if ($kind -eq 'role') {
    $createdOid=Native-Scalar "create role $($contract.roles.migrator) nologin; select oid from pg_roles where rolname='$($contract.roles.migrator)'";
  } else {
    Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "create database $($contract.database) owner $AdminRole;";
    $createdOid=Native-DatabaseOid $contract.database; $createdOwner=$AdminRole;
  }
  if ($createdOid -cnotmatch '^[1-9][0-9]*$') { throw 'native create lacks confirmed OID' }
} finally { Restore-AdminAuthentication $old }
try {
  $rejected=$false; try { Invoke-Provision $contract } catch { $rejected=$true }
  if (-not $rejected) { throw 'preexisting target admitted' }
  if (Test-Path -LiteralPath $StatePath) { throw 'collision wrote cleanup authorization' }
  $old=Set-AdminAuthentication;
  try {
    $actual=if ($kind -eq 'role') { Native-RoleOid $contract.roles.migrator } else { Native-DatabaseOid $contract.database };
    if ($actual -cne $createdOid) { throw 'preexisting collision changed' }
    if ((Native-RoleOid $contract.roles.app) -or (Native-RoleOid $contract.roles.readonly)) { throw 'preflight collision created unrelated cohort roles' }
  } finally { Restore-AdminAuthentication $old }
} finally {
  $old=Set-AdminAuthentication;
  try {
    if ($null -ne $createdOid) {
      if ($kind -eq 'role') {
        if ((Native-RoleOid $contract.roles.migrator) -cne $createdOid) { throw 'replacement collision role retained' }
        Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop role $($contract.roles.migrator);";
      } else {
        if ((Native-DatabaseOid $contract.database) -cne $createdOid) { throw 'replacement collision database retained' }
        if ((Native-Scalar "select pg_get_userbyid(datdba) from pg_database where oid=$createdOid") -cne $createdOwner) { throw 'changed collision database owner retained' }
        Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop database $($contract.database);";
      }
    }
  } finally { Restore-AdminAuthentication $old }
}
'''
    run_ps(body, timeout=180)


def test_native_stale_state_does_not_delete_replacement_database(tmp_path):
    native_requirements()
    params = cohort_parameters('tracking-rollback', tmp_path / 'replacement.env')
    body = '. ' + ps_literal(BOOTSTRAP) + ' ' + params + ' -TrackingFailurePoint after-database-record; ' + CONFIRMED_CLEANUP
    body += r'''
$confirmed=$null; $replacementOid=$null;
try {
  Assert-ContractInputs; $contract=Get-Contract; $caught=$false;
  try { Invoke-Provision $contract } catch {
    if ($_.Exception.Message -cne 'tracking-native-failpoint:after-database-record') { throw 'unexpected replacement setup failure' }
    $caught=$true;
  }
  if (-not $caught) { throw 'replacement setup failpoint not reached' }
  $confirmed=Get-TrackingConfirmedCreation;
  if ($confirmed.database_status -cne 'created') { throw 'replacement setup not confirmed' }
  $old=Set-AdminAuthentication;
  try {
    if ((Native-DatabaseOid $confirmed.database.name) -cne [string]$confirmed.database.oid) { throw 'original database identity changed' }
    Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop database $($confirmed.database.name);";
    Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "create database $($confirmed.database.name) owner $($confirmed.database.owner);";
    $replacementOid=Native-DatabaseOid $confirmed.database.name;
    if (-not $replacementOid -or $replacementOid -ceq [string]$confirmed.database.oid) { throw 'replacement OID not distinct' }
  } finally { Restore-AdminAuthentication $old }
'''
    body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File ' + ps_literal(BOOTSTRAP) + ' -Mode Teardown ' + params + ' *> $null; if ($LASTEXITCODE -eq 0) { throw "stale state reported cleanup success" }; '
    body += r'''
  $old=Set-AdminAuthentication;
  try {
    if ((Native-DatabaseOid $confirmed.database.name) -cne $replacementOid) { throw 'stale state removed replacement database' }
  } finally { Restore-AdminAuthentication $old }
} finally {
  if ($null -eq $confirmed) { $confirmed=Get-TrackingConfirmedCreation }
  if ($null -ne $confirmed) {
    # The new identity belongs only to this test's successful replacement create;
    # never write it into production's stale ownership state.
    if ($replacementOid) { $confirmed.database.oid=[int]$replacementOid }
    $old=Set-AdminAuthentication;
    try { Native-CleanupConfirmed $confirmed } finally { Restore-AdminAuthentication $old }
    if (Test-Path -LiteralPath $StatePath) { Remove-TrackingFiles -Cohort tracking-rollback }
  }
}
'''
    run_ps(body, timeout=180)


def test_native_role_race_is_atomic_and_never_cleaned_as_owned(tmp_path):
    native_requirements()
    params = cohort_parameters('tracking-rollback', tmp_path / 'race.env')
    body = '. ' + ps_literal(BOOTSTRAP) + ' ' + params + '; ' + CONFIRMED_CLEANUP
    body += r'''
Assert-ContractInputs; $contract=Get-Contract; $script:raceOid=$null; $script:raceName=$contract.roles.readonly;
# Only scheduling is injected. Preflight, role transaction, SQL endpoint and
# protected-state admission remain real. Collision is the last generated role,
# so earlier role creates must roll back atomically.
function Invoke-TrackingFailurePoint([string]$Point) {
  if ($Point -eq 'before-roles') {
    $old=Set-AdminAuthentication;
    try {
      $script:raceOid=Native-Scalar "create role $script:raceName nologin; select oid from pg_roles where rolname='$script:raceName'";
      if ($script:raceOid -cnotmatch '^[1-9][0-9]*$') { throw 'race fixture lacks creation OID' }
    } finally { Restore-AdminAuthentication $old }
  }
}
try {
  $rejected=$false; try { Invoke-Provision $contract } catch { $rejected=$true }
  if (-not $rejected -or -not $script:raceOid) { throw 'real scheduled collision not observed' }
  $old=Set-AdminAuthentication;
  try {
    if ((Native-RoleOid $script:raceName) -cne $script:raceOid) { throw 'racing role changed' }
    if ((Native-RoleOid $contract.roles.migrator) -or (Native-RoleOid $contract.roles.app)) { throw 'role transaction was not atomic' }
    if (Native-DatabaseOid $contract.database) { throw 'database created after racing role collision' }
  } finally { Restore-AdminAuthentication $old }
'''
    body += '& ' + ps_literal(POWERSHELL) + ' -NoLogo -NoProfile -NonInteractive -File ' + ps_literal(BOOTSTRAP) + ' -Mode Teardown ' + params + ' *> $null; if ($LASTEXITCODE -eq 0) { throw "racing unowned role reported cleaned" }; '
    body += r'''
  $old=Set-AdminAuthentication;
  try { if ((Native-RoleOid $script:raceName) -cne $script:raceOid) { throw 'teardown deleted unowned racing role' } }
  finally { Restore-AdminAuthentication $old }
} finally {
  if ($script:raceOid) {
    $old=Set-AdminAuthentication;
    try {
      if ((Native-RoleOid $script:raceName) -cne $script:raceOid) { throw 'replacement racing role retained' }
      Invoke-PsqlText (Join-Path $Pgbin 'psql.exe') $AdminRole postgres "drop role $script:raceName;";
    } finally { Restore-AdminAuthentication $old }
    if (Test-Path -LiteralPath $StatePath) { Remove-TrackingFiles -Cohort tracking-rollback }
  }
}
'''
    run_ps(body, timeout=180)


class Evidence:
    def __init__(self):
        self.rows = []
        self.collected = []

    def pytest_collection_finish(self, session):
        self.collected = [item.nodeid for item in session.items]

    def pytest_runtest_logreport(self, report):
        if report.when == 'call' or report.failed or report.skipped:
            self.rows.append({'node': report.nodeid, 'stage': report.when, 'outcome': report.outcome})


def main():
    assert sys.argv[1:] == ['--ci'], 'Only the required --ci entrypoint is supported'
    native_requirements()
    run, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    assert run.isdecimal() and attempt.isdecimal()
    directory = Path(os.environ['RUNNER_TEMP']) / ('album-haven-tracking-native-' + run + '-' + attempt) / 'evidence'
    directory.mkdir(parents=True, exist_ok=False)
    evidence = Evidence()
    code = 1
    try:
        sys.path.insert(0, str(ROOT))
        os.environ['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
        code = pytest.main([str(Path(__file__)), '-q', '--tb=line', '-p', 'no:cacheprovider'], plugins=[evidence])
        if any(row['outcome'] != 'passed' for row in evidence.rows):
            code = 1
        passed = {row['node'] for row in evidence.rows if row['stage'] == 'call' and row['outcome'] == 'passed'}
        if not evidence.collected or passed != set(evidence.collected):
            code = 1
        return int(code)
    finally:
        (directory / 'result.json').write_text(json.dumps({
            'schema_version': 1, 'repository': 'idanilovqa/AlbumHaven',
            'run_id': run, 'run_attempt': attempt, 'github_sha': os.environ['GITHUB_SHA'],
            'exit_code': int(code), 'results': evidence.rows,
            'native_windows': True, 'credential_output': False,
            'unsafe_process_tree': not _native_safe, 'cleanup_safe': _native_safe,
        }, indent=2), encoding='utf-8')


if __name__ == '__main__':
    raise SystemExit(main())
