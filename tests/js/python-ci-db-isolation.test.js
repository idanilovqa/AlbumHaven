const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/pr-gates.yml'), 'utf8');
const job = workflow.slice(workflow.indexOf('  test_python:'), workflow.indexOf('\n  e2e_production_parity:'));

test('Python CI keeps destructive and persistent contract stores in distinct owned databases', () => {
  assert.equal((job.match(/-Mode Provision/g) || []).length, 2);
  assert.equal((job.match(/-Mode Teardown/g) || []).length, 2);
  assert.match(job, /-DatabaseSuffix "py_contract_\$\{\{ github\.run_id \}\}_\$\{\{ github\.run_attempt \}\}"/);
  assert.match(job, /ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL=\$env:PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL/);
  assert.match(job, /ALBUM_HAVEN_FAKE_E2E_DATABASE_URL=\$env:PYTEST_DESTRUCTIVE_DATABASE_URL/);
  assert.match(job, /ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL=\$env:PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL/);
  assert.match(job, /ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL=\$env:PYTEST_DESTRUCTIVE_DATABASE_URL/);
  assert.match(job, /ALBUM_HAVEN_POSTGRES_CONTRACT_DATABASE_URL=\$env:DATABASE_APP_URL/);
});

test('Python CI retains both protected credentials while the second bootstrap replaces its exports', () => {
  const capture = job.indexOf('PYTEST_DESTRUCTIVE_PGPASSFILE=$env:PGPASSFILE');
  const secondProvision = job.indexOf('-DatabaseSuffix "py_contract_');
  assert.ok(capture >= 0 && capture < secondProvision);
  assert.match(job, /Get-Content -LiteralPath \$env:PYTEST_DESTRUCTIVE_PGPASSFILE/);
  assert.match(job, /Get-Content -LiteralPath \$env:PGPASSFILE/);
  assert.match(job, /\[IO\.File\]::WriteAllLines\(\$combinedPgpass/);
  assert.match(job, /PGPASSFILE=\$combinedPgpass/);
  assert.match(job, /Remove-Item -LiteralPath \$combinedPgpass -Force/);
  assert.doesNotMatch(job, /Write-(?:Host|Output)\s+\$(?:combinedPgpassLines|pgpassLines)/);
});
