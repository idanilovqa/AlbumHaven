const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pr-gates.yml'), 'utf8');
const bootstrap = fs.readFileSync(
  path.join(root, 'scripts', 'ci', 'bootstrap-windows-postgres.ps1'),
  'utf8',
);

function jobSource(jobName, nextJobName) {
  const start = workflow.indexOf(`  ${jobName}:`);
  const end = workflow.indexOf(`\n  ${nextJobName}:`, start);
  assert.notEqual(start, -1, `${jobName} job must exist`);
  assert.notEqual(end, -1, `${nextJobName} job must follow ${jobName}`);
  // New jobs may be inserted before the historical named neighbor. Every
  // assertion must inspect test_python only, never those intervening jobs.
  const remainder = workflow.slice(start);
  const bodyStart = remainder.indexOf('\n') + 1;
  const nextJob = remainder.slice(bodyStart).search(/^  [A-Za-z_][\w-]*:[ \t]*\r?$/m);
  assert.notEqual(nextJob, -1, `${jobName} must have a next top-level job boundary`);
  return remainder.slice(0, bodyStart + nextJob);
}

test('Python CI provisions and tears down an exact disposable PostgreSQL 17 database', () => {
  const job = jobSource('test_python', 'e2e_production_parity');
  assert.match(job, /runs-on:\s*windows-2025/);
  assert.match(job, /needs:\s*[\s\S]*?- review_scope[\s\S]*?- review_prerequisites[\s\S]*?- pr_agent_review[\s\S]*?- codex_review/);
  assert.match(job, /if:\s*\$\{\{[^\r\n]*!cancelled\(\) && needs\.review_prerequisites\.result == 'success'[^\r\n]*pipeline_mode == 'full'[^\r\n]*github\.event\.pull_request\.head\.repo\.full_name == github\.repository[^\r\n]*\}\}/);
  assert.doesNotMatch(job, /ALBUM_HAVEN_FIXTURES_TOKEN/);
  assert.match(job, /-Mode\s+Provision/);
  assert.match(job, /-Mode\s+Teardown/);
  assert.equal((job.match(/album-haven-python-postgres\.state\.json/g) || []).length, 2);
  assert.match(job, /-DatabaseSuffix\s+["']py_\$\{\{\s*github\.run_id\s*\}\}_\$\{\{\s*github\.run_attempt\s*\}\}["']/);
  assert.match(job, /-ExpectedMajorVersion\s+17/);
  assert.match(job, /-Pgbin\s+\$env:PGBIN/);
  assert.equal((job.match(/-HostName\s+127\.0\.0\.1/g) || []).length, 8);
  assert.match(job, /-SkipFixtureLoad/);
  assert.match(job, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.ok(job.indexOf('-Mode Provision') < job.indexOf('python -m pytest -q'));
  assert.ok(job.indexOf('python -m pytest -q') < job.indexOf('-Mode Teardown'));
  assert.match(job, /\$env:PGPASSWORD\s*=\s*\$null[\s\S]*?python -m pytest -q/);
});

test('schema-only bootstrap skips only fixture loading and preserves migrations and privilege probes', () => {
  assert.match(bootstrap, /Import-Module\s+Microsoft\.PowerShell\.Utility\s+-ErrorAction\s+Stop/);
  assert.match(bootstrap, /\[switch\]\$SkipFixtureLoad/);
  assert.match(
    bootstrap,
    /if\s*\(-not\s+\$SkipFixtureLoad\)\s*\{[\s\S]*?load-fixture-profile|if\s*\(-not\s+\$SkipFixtureLoad\)\s*\{[\s\S]*?\$Contract\.fixtureLoad\.script/,
  );
  assert.ok(bootstrap.indexOf('foreach ($migration in $Contract.migrations)') < bootstrap.indexOf('if (-not $SkipFixtureLoad)'));
  assert.ok(bootstrap.indexOf('$migratorProbeSql') < bootstrap.indexOf('if (-not $SkipFixtureLoad)'));
  assert.ok(bootstrap.indexOf('$appProbeSql') < bootstrap.indexOf('if (-not $SkipFixtureLoad)'));
  assert.ok(bootstrap.indexOf('$readonlyProbeSql') < bootstrap.indexOf('if (-not $SkipFixtureLoad)'));
  assert.match(
    bootstrap,
    /finally\s*\{\s*Clear-AdminAuthentication\s*\}[\s\S]*?\$env:PGPASSFILE\s*=\s*\$Contract\.pgpass\.path/,
  );
  assert.doesNotMatch(bootstrap, /1\s*\/\s*0/);
  assert.match(bootstrap, /raise exception 'migrator role attributes are overbroad'/);
  assert.match(bootstrap, /raise exception 'app privilege boundary is incomplete or overbroad'/);
  assert.match(bootstrap, /raise exception 'readonly privilege boundary is incomplete or overbroad'/);
  assert.match(bootstrap, /grant temporary on database[^;]+to album_haven_app/i);
  assert.match(bootstrap, /create temporary table ci_app_privilege_probe/i);
  assert.match(bootstrap, /create temporary table ci_readonly_privilege_probe/i);
  assert.match(bootstrap, /not has_database_privilege\(current_user,current_database\(\),'temporary'\)/i);
  assert.doesNotMatch(bootstrap, /AppendAllLines/);
  assert.match(bootstrap, /\[IO\.StreamWriter\]::new\([\s\S]*?\$GithubEnv[\s\S]*?\$true/);
});

function trackingDiagnosticsSource() {
  const match = bootstrap.match(
    /^function Write-TrackingMigrationLedgerDiagnostics\b[\s\S]*?(?=^function |$(?![\s\S]))/m,
  );
  assert.ok(match, 'bootstrap must expose the read-only tracking migration diagnostic helper');
  return match[0];
}

test('tracking diagnostics distinguish canonical inventories from raw checkout bytes', () => {
  const diagnostic = trackingDiagnosticsSource();
  assert.match(diagnostic, /inventory_contract/);
  assert.match(diagnostic, /ConvertFrom-Json/);
  assert.match(diagnostic, /\$canonicalInventories\s*=\s*\$inventoryMatch\.Groups\[1\]\.Value\s*\|\s*ConvertFrom-Json\s+-AsHashtable/);
  for (const inventory of ['153', '168']) {
    assert.match(diagnostic, new RegExp(`\\$expected${inventory}\\s*=\\s*\\$canonicalInventories\\[['"]${inventory}['"]\\]`));
    assert.match(diagnostic, new RegExp(`expected${inventory}Sha256\\s*=\\s*\\$expected${inventory}\\[\\$migrationName\\]`));
  }
  assert.match(diagnostic, /Get-FileHash\b[^\r\n]*-Algorithm\s+SHA256/i);
  assert.match(diagnostic, /ReadAllBytes/);
  assert.match(diagnostic, /workingSha256\s*=\s*\(Get-FileHash\s+-LiteralPath\s+\$migrationPath\s+-Algorithm\s+SHA256\)\.Hash\.ToLowerInvariant\(\)/);
  assert.match(diagnostic, /\$migrationPath\s*=\s*Join-Path\s+\$migrationRoot\s+\$migrationName/);
  assert.match(diagnostic, /migration\s*=\s*\$migrationName\b/);
  for (const field of [
    'migration', 'workingSha256', 'expected153Sha256', 'expected168Sha256',
    'lfCount', 'crlfCount', 'bareCrCount',
  ]) {
    assert.match(diagnostic, new RegExp(`\\b${field}\\s*=`), `diagnostic includes ${field}`);
  }
  assert.match(diagnostic, /ConvertTo-Json\b[^\r\n]*-Compress/);
  assert.doesNotMatch(diagnostic, /expected(?:153|168)Sha256\s*=\s*\$migration\.sha256/i);
});

test('tracking diagnostics read the ledger without exposing connection or filesystem details', () => {
  const diagnostic = trackingDiagnosticsSource();
  assert.ok(diagnostic.includes('^[0-9]{4}_[a-z0-9_]+\\.sql$'), 'only public migration basenames enter diagnostics');
  assert.match(diagnostic, /foreach\s*\(\$migration\s+in\s+\$Contract\.migrations\)/);
  assert.match(diagnostic, /\$migrationName\s*=\s*\$migration\.name\b/);
  const guard = diagnostic.match(/if\s*\(\$migrationName\s+-cnotmatch\s+'\^\[0-9\]\{4\}_\[a-z0-9_\]\+\\\.sql\$'\)\s*\{\s*throw\b[^}]*\}/);
  assert.ok(guard, 'invalid migration names must stop diagnostic construction');
  const append = diagnostic.indexOf('$allowedNames += $migrationName');
  assert.ok(append > guard.index, 'only validated names enter the ledger allowlist');
  assert.ok(diagnostic.search(/expected153Sha256\s*=/) > guard.index);
  assert.ok(diagnostic.search(/expected168Sha256\s*=/) > guard.index);
  assert.match(diagnostic, /\$allowedSql\s*=\s*\(?\s*\$allowedNames\s*\|\s*ForEach-Object\s*\{[^}]*\$_.Replace\("'",\s*"''"\)[^}]*\}\s*\)?\s*-join\s*["'],["']/);
  assert.match(diagnostic, /select\s+json_build_object\s*\(/i);
  assert.match(diagnostic, /from\s+ops\.schema_migrations/i);
  assert.match(diagnostic, /order\s+by\s+migration_name/i);
  assert.match(diagnostic, /'migration'\s*,\s*migration_name/i);
  assert.match(diagnostic, /'sha256'\s*,\s*checksum/i);
  assert.match(diagnostic, /'count'\s*,\s*count\(\*\)/i);
  assert.match(diagnostic, /'unexpectedCount'/);
  assert.match(diagnostic, /filter\s*\(\s*where\s+migration_name\s*=\s*any\s*\(/i);
  assert.match(diagnostic, /filter\s*\(\s*where\s+migration_name\s*=\s*any\s*\(\s*array\[\$allowedSql\]/i);
  assert.match(diagnostic, /'unexpectedCount'\s*,\s*count\(\*\)\s*filter\s*\(\s*where\s+not\s+migration_name\s*=\s*any\s*\(\s*array\[\$allowedSql\]/i);
  assert.match(diagnostic, /\$ledgerSql\s*=\s*@"\s*select\s+json_build_object[\s\S]*?from\s+ops\.schema_migrations\s*;\s*"@\s*Invoke-PsqlText\s+\$Psql\s+\$Role\s+\$Database\s+\$ledgerSql/i);
  assert.doesNotMatch(diagnostic, /\b(?:insert\s+into|update\s+ops\.|delete\s+from|truncate|alter\s+table|create\s+table)\b/i);
  assert.doesNotMatch(diagnostic, /\$(?:env:|secrets\b)|PGPASSWORD|PGPASSFILE|postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(diagnostic, /(?:Write-Output|ConvertTo-Json)\s+\$Contract\b/i);
  assert.doesNotMatch(diagnostic, /^\s*(?:path|fullName|sql|connectionString|password|dsn)\s*=/im);
});

test('tracking diagnostics run before migration 0169 without replacing migration execution', () => {
  trackingDiagnosticsSource();
  const start = bootstrap.indexOf('foreach ($migration in $Contract.migrations)');
  const execute = bootstrap.indexOf('Invoke-Checked $psql $migrationArguments', start);
  assert.ok(start >= 0 && execute > start);
  const beforeExecution = bootstrap.slice(start, execute);
  assert.match(
    beforeExecution,
    /if\s*\(\s*\$migration\.name\s+-ceq\s+['"]0169_install_listening_tracking_storage\.sql['"]\s*\)\s*\{\s*Write-TrackingMigrationLedgerDiagnostics\s+\$psql\s+\$names\.Roles\.migrator\s+\$names\.Database\s+\$Contract\s*\}/,
  );
  assert.equal((bootstrap.match(/^\s*Write-TrackingMigrationLedgerDiagnostics\s+\$/gm) || []).length, 1);
  assert.match(beforeExecution, /ON_ERROR_STOP=1/);
  assert.match(beforeExecution, /insert into ops\.schema_migrations \(migration_name, checksum\)/);
  assert.match(beforeExecution, /\$migration\.sha256/);
});

function pythonSteps() {
  const job = jobSource('test_python', 'e2e_production_parity');
  return job.split(/(?=^      - name:)/m).slice(1);
}

function exactlyOneStep(steps, predicate, description) {
  const found = steps.filter(predicate);
  assert.equal(found.length, 1, description);
  return found[0];
}

test('tracking Windows proof is a required explicit gate before cohort execution', () => {
  const steps = pythonSteps();
  const native = exactlyOneStep(steps,
    step => /python -I -B tests\/windows_native\/test_tracking_ci_admission\.py --ci/.test(step),
    'the native tracking suite must run explicitly, outside pytest default testpaths');
  assert.doesNotMatch(native, /^\s+if:|continue-on-error:\s*true/m);
  assert.match(native, /\$LASTEXITCODE/);
  assert.match(native, /(?:throw|exit)\b/);
  const ordinaryExports = exactlyOneStep(steps,
    step => /PGPASSFILE=\$combinedPgpass/.test(step), 'ordinary exports remain installed first');
  const collection = exactlyOneStep(steps,
    step => /python -m pytest --collect-only/.test(step), 'normal collection is retained');
  assert.ok(steps.indexOf(ordinaryExports) < steps.indexOf(native));
  assert.ok(steps.indexOf(native) < steps.indexOf(collection));
  for (const cohort of ['tracking-rollback', 'historical-0153']) {
    const provision = exactlyOneStep(steps,
      step => /-Mode\s+Provision/.test(step) && step.includes(`-TrackingCohort ${cohort}`),
      `${cohort} is provisioned once`);
    assert.ok(steps.indexOf(native) < steps.indexOf(provision));
    assert.ok(steps.indexOf(provision) < steps.indexOf(collection));
  }
});

test('native tracking evidence is uploaded on failure and missing evidence is fatal', () => {
  const upload = exactlyOneStep(pythonSteps(),
    step => /actions\/upload-artifact@/.test(step) && /album-haven-tracking-native-/.test(step),
    'native tracking evidence has an independent upload');
  assert.match(upload, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(upload, /if-no-files-found:\s*error/);
  assert.match(upload, /album-haven-tracking-native-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}[\\/]evidence/);
  assert.doesNotMatch(upload, /continue-on-error:\s*true/);
});

test('tracking cohorts add exact cutoff lifecycle without replacing current databases', () => {
  const steps = pythonSteps();
  const normalRun = exactlyOneStep(steps,
    step => /python -m pytest -q\s+--junitxml/.test(step), 'full ordinary pytest remains required');
  const command = normalRun.match(/^\s*python\s+-m\s+pytest([^\r\n]*)\r?$/m);
  assert.ok(command, 'full-suite pytest command must remain explicit');
  // Inspect pytest arguments, not the interpreter's required -m switch.
  assert.doesNotMatch(command[1], /(?:^|\s)(?:--ignore(?:-glob)?|--deselect|--pyargs|-k|-m)(?:[=\s]|$)/);
  assert.doesNotMatch(normalRun, /continue-on-error:\s*true/);
  const ordinaryTeardowns = steps.filter(step => /-Mode\s+Teardown/.test(step) && !/-TrackingCohort/.test(step));
  assert.equal(ordinaryTeardowns.length, 2);
  const currentProvisions = steps.filter(step => /-Mode\s+Provision/.test(step) && !/-TrackingCohort/.test(step));
  assert.equal(currentProvisions.length, 2);
  for (const current of currentProvisions) {
    assert.doesNotMatch(current, /-MigrationThrough/); // Current install still includes 0169.
  }
  for (const [cohort, suffix] of [['tracking-rollback', 'tr169'], ['historical-0153', 'hist153']]) {
    for (const mode of ['Provision', 'Teardown']) {
      const step = exactlyOneStep(steps,
        value => new RegExp(`-Mode\\s+${mode}`).test(value) && value.includes(`-TrackingCohort ${cohort}`),
        `${cohort} ${mode} has a single lifecycle owner`);
      assert.match(step, /-MigrationThrough\s+153/);
      assert.match(step, /-ExpectedMajorVersion\s+17/);
      assert.match(step, /-HostName\s+127\.0\.0\.1/);
      assert.match(step, new RegExp(`-DatabaseSuffix\\s+["']${suffix}_\\$\\{\\{\\s*github\\.run_id\\s*\\}\\}_\\$\\{\\{\\s*github\\.run_attempt\\s*\\}\\}["']`));
      assert.doesNotMatch(step, /(?:DATABASE_MIGRATOR_URL|DATABASE_APP_URL|PGPASSFILE)=/);
      if (mode === 'Provision') {
        assert.match(step, /-AppPrivilegeMode\s+Inherited/);
        assert.match(step, /-SkipFixtureLoad/);
      } else {
        assert.match(step, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
        assert.match(step, new RegExp(`Assert-TrackingCleanupEvidence\\s+-Cohort\\s+${cohort}`));
        assert.ok(step.indexOf('Assert-TrackingCleanupEvidence') < step.indexOf('-Mode Teardown'),
          'run-bound cleanup safety evidence is checked before any teardown SQL');
        assert.ok(steps.indexOf(normalRun) < steps.indexOf(step));
        for (const ordinary of ordinaryTeardowns) assert.ok(steps.indexOf(step) < steps.indexOf(ordinary));
      }
      assert.doesNotMatch(step, /continue-on-error:\s*true/);
    }
  }
});
