const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml');
const contractPath = path.join(repoRoot, 'tests', 'ci', 'performance-targets.json');
const validatorPath = path.join(repoRoot, 'scripts', 'ci', 'validate-performance-matrix.cjs');
const shardRunnerPath = path.join(repoRoot, 'scripts', 'ci', 'run-performance-shard.ps1');
const testDataMatrixPath = path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const testDataMatrix = JSON.parse(fs.readFileSync(testDataMatrixPath, 'utf8'));
const runnerModule = require('../../scripts/run-performance-playwright.cjs');
const validator = require('../../scripts/ci/validate-performance-matrix.cjs');
const { EXPECTED } = require('../../scripts/ci/write-foundation-version-manifest.cjs');

const FIXTURE_RELEASE = 'fixtures-v1.0.19';
const FIXTURE_MANIFEST_SHA256 = 'cb9ed982ec5afd191e77c99f90cc42ecaec228086d9147df4fdd6b1b621b8d51';
const EXPECTED_SHARDS = [
  { shard: 'synthetic-large-library', fixtureProfile: 'synthetic-large-library', fixtureMode: 'preloaded-release', harness: 'managed-app', basePort: '4173', targets: 'idle-memory,all-artists,artist-family,search-all-artists,utility-rules,selected-artist,search-browse,root-album-browse,app-open-all-artists,rules-focused' },
  { shard: 'utility-problematic-files', fixtureProfile: 'utility-problematic-files', fixtureMode: 'preloaded-release', harness: 'managed-app', basePort: '4253', targets: 'utility-problematic-files,problematic-files-focused' },
  { shard: 'playback-media', fixtureProfile: 'playback-media', fixtureMode: 'generated-isolated', harness: 'managed-app', basePort: '4213', targets: 'playback-start,gapless-playback' },
  { shard: 'scan-library', fixtureProfile: 'scan-library', fixtureMode: 'generated-isolated', harness: 'scan', basePort: '4293', targets: 'scan-cold,scan-cached,scan-add-album,scan-metadata,scan-page' },
];

function performanceJobSource(source = workflow) {
  const start = source.indexOf('  e2e_performance_ci:');
  const end = source.indexOf('\n  pr_agent_review:', start);
  assert.notEqual(start, -1, 'pr-gates.yml must define e2e_performance_ci');
  assert.notEqual(end, -1, 'e2e_performance_ci must remain independently bounded');
  return source.slice(start, end);
}

function stepContaining(job, marker) {
  const blocks = job.split(/\n\s{6}- name:/).slice(1);
  const step = blocks.find((block) => block.includes(marker));
  assert.ok(step, `missing workflow step containing ${marker}`);
  return step;
}

test('approved registry keeps 19 independently schedulable targets and 26 cases', () => {
  assert.equal(contract.targets.length, 19);
  assert.equal(contract.targets.flatMap((target) => target.cases).length, 26);
  assert.deepEqual(
    contract.targets.filter((target) => target.defaultMember).map((target) => target.name),
    contract.targets.map((target) => target.name),
  );
  for (const target of contract.targets) {
    assert.equal(target.workers, 1, target.name);
    assert.equal(target.blocking, false, target.name);
  }
});

test('performance validator and shard runner exist', () => {
  assert.equal(fs.existsSync(validatorPath), true);
  assert.equal(fs.existsSync(shardRunnerPath), true, 'Missing scripts/ci/run-performance-shard.ps1');
});

test('workflow has four literal fixture-profile runners owning all 19 targets once', () => {
  const job = performanceJobSource();
  const rows = validator.parseStaticPerformanceMatrix(workflow);
  assert.deepEqual(rows, EXPECTED_SHARDS);
  const owned = rows.flatMap((row) => row.targets.split(','));
  assert.equal(owned.length, 19);
  assert.equal(new Set(owned).size, 19);
  assert.deepEqual(new Set(owned), new Set(contract.targets.map((target) => target.name)));
  assert.doesNotMatch(job, /matrix:\s*\$\{\{/i);
  assert.match(job, /fail-fast:\s*false/);
  assert.match(job, /max-parallel:\s*4/);
  assert.deepEqual(
    rows.map((row) => row.fixtureProfile),
    ['synthetic-large-library', 'utility-problematic-files', 'playback-media', 'scan-library'],
  );
  assert.equal(rows[0].targets.split(',').length, 10, 'synthetic-large-library must own all ten compatible targets');
  assert.doesNotMatch(job, /timeout-minutes:/, 'a multi-target shard must not squeeze later targets into a shared wall-clock budget');
});

test('validator accepts shards and rejects ownership, compatibility, and case drift', () => {
  assert.deepEqual(validator.validateWorkflowContract(workflow, contract, runnerModule, testDataMatrix), []);

  const duplicate = workflow.replace(
    'targets: utility-problematic-files,problematic-files-focused',
    'targets: utility-problematic-files,idle-memory',
  );
  assert.match(validator.validateWorkflowContract(duplicate, contract, runnerModule, testDataMatrix).join('\n'), /owned exactly once|disagree/i);

  const workflowLineEndingVariants = [
    workflow.replace(/\r?\n/g, '\n'),
    workflow.replace(/\r?\n/g, '\r\n'),
  ];
  for (const workflowSource of workflowLineEndingVariants) {
    const mixedProfile = workflowSource.replace(
      /(shard: playback-media\r?\n\s+fixtureProfile:) playback-media/,
      '$1 synthetic-large-library',
    );
    assert.notEqual(mixedProfile, workflowSource, 'fixture compatibility mutation must apply on LF and CRLF checkouts');
    assert.match(validator.validateWorkflowContract(mixedProfile, contract, runnerModule, testDataMatrix).join('\n'), /fixture|compatible/i);

    const mixedHarness = workflowSource.replace(
      /(shard: utility-problematic-files\r?\n(?:\s+[^\r\n]+\r?\n){2}\s+harness:)\s+[^\r\n]+/,
      '$1 scan',
    );
    assert.notEqual(mixedHarness, workflowSource, 'harness-family mutation must apply on LF and CRLF checkouts');
    assert.match(validator.validateWorkflowContract(mixedHarness, contract, runnerModule, testDataMatrix).join('\n'), /harness|compatible/i);
  }

  const missingCaseContract = structuredClone(contract);
  missingCaseContract.targets[0].cases.pop();
  assert.match(validator.validateWorkflowContract(workflow, missingCaseContract, runnerModule, testDataMatrix).join('\n'), /26 cases/);

  const paidCampaign = structuredClone(contract);
  paidCampaign.calibrationPolicy.separateCampaignRequired = true;
  assert.match(
    validator.validateWorkflowContract(workflow, paidCampaign, runnerModule, testDataMatrix).join('\n'),
    /retained cohorts.*central explicit local\/CI environment contracts/i,
  );
});

test('validator compares real Playwright discovery with all approved identities', () => {
  const discovered = contract.targets.flatMap((target) => target.cases.map((ownedCase) => ({
    ...ownedCase,
    test: path.basename(ownedCase.test),
  })));
  assert.deepEqual(validator.validateDiscoveredCases(contract, discovered), []);
  assert.match(validator.validateDiscoveredCases(contract, discovered.slice(1)).join('\n'), /undiscovered owned performance case/);
});

test('profile runners remain PR-only same-repository Windows Chrome jobs capped at four', () => {
  const job = performanceJobSource();
  assert.match(workflow, /^on:\r?\n\s+pull_request:/m);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|schedule|workflow_dispatch|pull_request_target):/m);
  assert.match(job, /name:\s*["']?E2E Performance: \$\{\{\s*matrix\.shard\s*\}\}["']?/);
  assert.match(job, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  assert.match(job, /runs-on:\s*windows-2025/);
  assert.doesNotMatch(job, /continue-on-error:/);
  assert.match(job, /-Browser\s+chrome/);
  assert.match(job, /run-performance-shard\.ps1/);
  assert.match(job, /-Targets\s+["']?\$\{\{\s*matrix\.targets\s*\}\}/);
  assert.match(job, /-BasePort\s+["']?\$\{\{\s*matrix\.basePort\s*\}\}/);
});

test('performance foundations are written only after shared shard PostgreSQL provisioning', () => {
  const job = performanceJobSource();
  const shardRunner = fs.readFileSync(shardRunnerPath, 'utf8');
  assert.doesNotMatch(
    job,
    /name:\s*Write performance foundation version manifest/,
    'the workflow cannot verify a PostgreSQL server before the shard runner provisions it',
  );
  assert.ok(shardRunner.indexOf('& $bootstrap @provisionArguments -SkipFixtureLoad') < shardRunner.indexOf('& $nodePath $foundationWriter'));
  assert.match(shardRunner, /foundation-version-manifest-performance-\$target\.json/);
});

test('Windows jobs and foundation manifests provision one exact cross-platform Chrome build', () => {
  const expectedChrome = '151.0.7922.138';
  assert.equal(EXPECTED.windowsChrome, expectedChrome);
  for (const marker of [
    'Set up pinned Windows Node Chrome for Testing',
    'Set up pinned Python Chrome for Testing',
    'Set up pinned functional Chrome for Testing',
    'Set up pinned performance Chrome for Testing',
  ]) {
    const step = stepContaining(workflow, marker);
    assert.match(step, /uses:\s*browser-actions\/setup-chrome@v2/);
    assert.match(step, new RegExp(`chrome-version:\\s*["']?${expectedChrome.replaceAll('.', '\\.')}["']?`));
  }

  for (const [marker, setupId] of [
    ['Write Windows Node foundation version manifest', 'setup_windows_node_chrome'],
    ['Run Windows JavaScript tests', 'setup_windows_node_chrome'],
    ['Write Python foundation version manifest', 'setup_python_chrome'],
    ['Write functional foundation version manifest', 'setup_functional_chrome'],
    ['Run functional shard', 'setup_functional_chrome'],
    ['Run sequential isolated performance shard', 'setup_performance_chrome'],
  ]) {
    assert.match(
      stepContaining(workflow, marker),
      new RegExp(`PLAYWRIGHT_CHROME_EXECUTABLE:\\s*\\$\\{\\{\\s*steps\\.${setupId}\\.outputs\\.chrome-path\\s*\\}\\}`),
    );
  }
});

test('each shard fetches an immutable profile once before pull-request executable code', () => {
  const job = performanceJobSource();
  const trustedCheckout = stepContaining(job, 'github.event.pull_request.base.sha');
  const fixtureFetch = stepContaining(job, 'fetch-test-fixtures.ps1');
  for (const step of [trustedCheckout, fixtureFetch]) {
    assert.match(step, /matrix\.fixtureMode\s*==\s*['"]preloaded-release['"]/);
  }
  assert.match(trustedCheckout, /persist-credentials:\s*false/);
  assert.match(fixtureFetch, new RegExp(`-Release\\s+${FIXTURE_RELEASE.replaceAll('.', '\\.')}`));
  assert.match(fixtureFetch, new RegExp(`-ManifestSha256\\s+${FIXTURE_MANIFEST_SHA256}`));
  assert.ok(job.indexOf('Fetch preloaded performance fixture') < job.indexOf('Install Node dependencies'));
  assert.ok(job.indexOf('Fetch preloaded performance fixture') < job.indexOf('Validate performance matrix ownership'));
});

test('each target retains individual result, diagnostics, and foundation artifacts', () => {
  const job = performanceJobSource();
  for (let slot = 1; slot <= 10; slot += 1) {
    const expression = `\${{ matrix.target${slot} }}`;
    const result = stepContaining(job, `performance-result-${expression}`);
    const foundation = stepContaining(job, `foundation-versions-performance-${expression}`);
    const diagnostics = stepContaining(job, `performance-diagnostics-${expression}`);
    assert.match(result, /uses:\s*actions\/upload-artifact@v4/);
    assert.match(result, /always\(\)/);
    assert.match(result, /playwright-performance-targets/);
    assert.match(result, /retention-days:\s*14/);
    assert.match(foundation, /retention-days:\s*14/);
    assert.match(diagnostics, /failure\(\)/);
    assert.match(diagnostics, /retention-days:\s*7/);
  }
});

test('functional shards and all-19 authenticated target artifacts remain present without report jobs', () => {
  assert.match(workflow, /^\s{2}e2e_functional:/m);
  assert.match(workflow, /validate-functional-shards\.cjs --run-shard=\$\{\{\s*matrix\.shard\s*\}\}/);
  assert.match(workflow, /name:\s*performance-result-\$\{\{\s*matrix\.target10\s*\}\}/);
  assert.doesNotMatch(workflow, /^  (?:merge_cloud_reports|deploy_cloud_reports):/m);
});
