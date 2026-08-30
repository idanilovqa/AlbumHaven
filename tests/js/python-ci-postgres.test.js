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
  return workflow.slice(start, end);
}

test('Python CI provisions and tears down an exact disposable PostgreSQL 17 database', () => {
  const job = jobSource('test_python', 'e2e_production_parity');
  assert.match(job, /runs-on:\s*windows-2025/);
  assert.match(
    job,
    /if:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\s*\}\}/,
  );
  assert.doesNotMatch(job, /ALBUM_HAVEN_FIXTURES_TOKEN/);
  assert.match(job, /-Mode\s+Provision/);
  assert.match(job, /-Mode\s+Teardown/);
  assert.equal((job.match(/album-haven-python-postgres\.state\.json/g) || []).length, 2);
  assert.match(job, /-DatabaseSuffix\s+["']py_\$\{\{\s*github\.run_id\s*\}\}_\$\{\{\s*github\.run_attempt\s*\}\}["']/);
  assert.match(job, /-ExpectedMajorVersion\s+17/);
  assert.match(job, /-Pgbin\s+\$env:PGBIN/);
  assert.equal((job.match(/-HostName\s+127\.0\.0\.1/g) || []).length, 2);
  assert.match(job, /-SkipFixtureLoad/);
  assert.match(job, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.ok(job.indexOf('-Mode Provision') < job.indexOf('python -m pytest -q'));
  assert.ok(job.indexOf('python -m pytest -q') < job.indexOf('-Mode Teardown'));
  assert.match(job, /\$env:PGPASSWORD\s*=\s*\$null[\s\S]*?python -m pytest -q/);
});

test('schema-only bootstrap skips only fixture loading and preserves migrations and privilege probes', () => {
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
