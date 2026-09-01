const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml');
const requirementsPath = path.join(repoRoot, 'requirements.txt');
const packagePath = path.join(repoRoot, 'package.json');
const allowedSkipsPath = path.join(repoRoot, 'tests', 'ci', 'pytest-allowed-skips.json');
const validatorPath = path.join(repoRoot, 'scripts', 'ci', 'validate-foundation-gates.cjs');

function recursivelyDiscoverNodeTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return recursivelyDiscoverNodeTests(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
    })
    .map((entryPath) => path.relative(repoRoot, entryPath).replaceAll('\\', '/'))
    .sort();
}

function replaceInJob(workflow, jobName, pattern, replacement) {
  const start = workflow.indexOf(`  ${jobName}:`);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.match(/\n {2}[A-Za-z_][A-Za-z0-9_]*:\r?\n/);
  const end = nextJob ? start + 1 + nextJob.index : workflow.length;
  const job = workflow.slice(start, end);
  assert.match(job, pattern, `${jobName} lacks expected mutation target`);
  return `${workflow.slice(0, start)}${job.replace(pattern, replacement)}${workflow.slice(end)}`;
}

function assertWorkflowDrift(validator, workflow, changedWorkflow, expectedError) {
  assert.notEqual(changedWorkflow, workflow, 'workflow mutation must change the source');
  assert.match(validator.validateWorkflowContract(changedWorkflow).join('\n'), expectedError);
}

test('foundation workflow uses a published Linux Chrome pin and clears inherited admin passwords before Windows probes', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const jobName of ['test_js', 'test_components']) {
    const start = workflow.indexOf(`  ${jobName}:`);
    const next = workflow.slice(start + 1).match(/\n {2}[A-Za-z_][A-Za-z0-9_]*:\r?\n/);
    const job = workflow.slice(start, next ? start + 1 + next.index : workflow.length);
    assert.match(job, /chrome-version:\s*["']151\.0\.7922\.138["']/);
  }
  for (const jobName of ['test_node_windows', 'test_python', 'e2e_functional']) {
    const start = workflow.indexOf(`  ${jobName}:`);
    const next = workflow.slice(start + 1).match(/\n {2}[A-Za-z_][A-Za-z0-9_]*:\r?\n/);
    const job = workflow.slice(start, next ? start + 1 + next.index : workflow.length);
    assert.match(job, /name:\s*Write .*foundation version manifest[\s\S]*?run:\s*\|\r?\n\s+\$env:PGPASSWORD = \$null/);
  }
  const performanceStart = workflow.indexOf('  e2e_performance_ci:');
  const performanceEnd = workflow.indexOf('\n  pr_agent_review:', performanceStart);
  const performanceJob = workflow.slice(performanceStart, performanceEnd);
  assert.match(performanceJob, /run-performance-shard\.ps1/);
  assert.doesNotMatch(performanceJob, /name:\s*Write performance foundation version manifest/);
});

test('dedicated Phase 7 jobs select their pinned Chrome executable', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const jobName of ['e2e_phase7_auth', 'e2e_phase7_admin']) {
    const start = workflow.indexOf(`  ${jobName}:`);
    const next = workflow.slice(start + 1).match(/\n {2}[A-Za-z_][A-Za-z0-9_]*:\r?\n/);
    const job = workflow.slice(start, next ? start + 1 + next.index : workflow.length);
    assert.match(job, /PLAYWRIGHT_BROWSER:\s*chrome/);
    assert.match(job, /PLAYWRIGHT_CHROME_EXECUTABLE/);
  }
  for (const configName of ['playwright.phase7-auth.config.js', 'playwright.phase7-admin.config.js']) {
    const config = fs.readFileSync(path.join(repoRoot, configName), 'utf8');
    assert.match(config, /resolveBrowserProjectUse\(process\.env\.PLAYWRIGHT_BROWSER \|\| 'chromium'\)/);
  }
});

test('foundation validator enforces the approved portable and Windows gate contract', () => {
  assert.equal(
    fs.existsSync(validatorPath),
    true,
    'Missing scripts/ci/validate-foundation-gates.cjs',
  );

  const validator = require(validatorPath);
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const requirements = fs.readFileSync(requirementsPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  assert.deepEqual(validator.validateWorkflowContract(workflow), []);
  assert.deepEqual(validator.validateDependencyContract(requirements), []);
  assert.equal(
    packageJson.scripts['test:js:all'],
    'node scripts/ci/validate-foundation-gates.cjs --run-node-tests',
    'the complete Node suite must execute the validator\'s recursive discovery result',
  );

  const expectedNodeTests = recursivelyDiscoverNodeTests(path.join(repoRoot, 'tests', 'js'));
  assert.ok(expectedNodeTests.length > 0);
  assert.deepEqual(validator.discoverNodeTestFiles(repoRoot), expectedNodeTests);
  let nodeInvocation;
  assert.equal(validator.runNodeTests(repoRoot, {
    spawnSyncFn(executable, args, options) {
      nodeInvocation = { executable, args, options };
      return { status: 0 };
    },
  }), 0);
  assert.equal(nodeInvocation.executable, process.execPath);
  assert.deepEqual(nodeInvocation.args.slice(0, 2), ['--test', '--test-concurrency=1']);
  assert.deepEqual(nodeInvocation.args.slice(2), expectedNodeTests);
  assert.equal(nodeInvocation.options.cwd, repoRoot);
  assert.equal(validator.parsePlaywrightList([
    'Listing tests:',
    '  coverLookupTaskCard.spec.js:30:1 › first component case',
    '  [chromium] › loopRangeControls.spec.js:68:1 › second component case',
    'Total: 2 tests in 2 files',
  ].join('\n')).length, 2);
  assert.equal(validator.discoverComponentCases(repoRoot).length, 5);

  assert.deepEqual(
    validator.validatePytestCollection(
      { collectedCases: 3037, collectedModules: 147, skipped: [] },
      { allowedSkips: [] },
    ),
    [],
  );
  const liveProviderJunit = [
    '<testsuites><testsuite>',
    '<testcase classname="tests.py.test_cover_lookup_live_provider_smoke" ',
    'name="test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[apple-Apple Music]">',
    '<skipped message="Set ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1 to run live provider smoke tests."/>',
    '</testcase></testsuite></testsuites>',
  ].join('');
  assert.deepEqual(
    validator.validatePytestCollection(
      {
        collectedCases: 3037,
        collectedModules: 147,
        skipped: validator.parsePytestJunit(liveProviderJunit),
      },
      { allowedSkips: JSON.parse(fs.readFileSync(allowedSkipsPath, 'utf8')) },
    ),
    [],
  );
  const junitWithLeadingSelfClosingPass = liveProviderJunit.replace(
    '<testsuites><testsuite>',
    '<testsuites><testsuite><testcase classname="tests.py.test_passing" name="test_passes" time="0.1" />',
  );
  assert.deepEqual(validator.parsePytestJunit(junitWithLeadingSelfClosingPass), [{
    nodeId: 'tests.py.test_cover_lookup_live_provider_smoke::test_live_music_service_cover_lookup_smoke_logs_duration_and_returns_candidates[apple-Apple Music]',
    reason: 'Set ALBUM_HAVEN_RUN_LIVE_PROVIDER_TESTS=1 to run live provider smoke tests.',
  }]);
  assert.deepEqual(
    validator.validatePytestCollection(
      { collectedCases: 3100, collectedModules: 150, skipped: [] },
      { allowedSkips: [] },
    ),
    [],
  );
  assert.match(
    validator.validatePytestCollection(
      { collectedCases: 3036, collectedModules: 146, skipped: [] },
      { allowedSkips: [] },
    ).join('\n'),
    /3,?037 cases.*147 modules/i,
  );
  const parsedCollection = validator.parsePytestCollectionOutput([
    'tests/py/test_alpha.py::test_one',
    'tests\\py\\test_alpha.py::test_two',
    'tests/py/test_beta.py::test_three',
    '3037 tests collected in 1.00s',
  ].join('\n'), repoRoot);
  assert.equal(parsedCollection.collectedCases, 3037);
  assert.equal(parsedCollection.collectedModules, 2);
  assert.match(
    validator.validatePytestCollection(parsedCollection, { allowedSkips: [] }).join('\n'),
    /147 modules/i,
  );
  assert.match(
    validator.validatePytestCollection(
      {
        collectedCases: 3037,
        collectedModules: 147,
        skipped: [{ nodeId: 'tests/py/test_example.py::test_requires_postgres', reason: 'missing database' }],
      },
      { allowedSkips: [] },
    ).join('\n'),
    /unexpected skip/i,
  );
  assert.deepEqual(
    validator.validatePytestCollection(
      {
        collectedCases: 3037,
        collectedModules: 147,
        skipped: [{ nodeId: 'tests/py/test_example.py::test_platform_only', reason: 'approved platform limit' }],
      },
      { allowedSkips: ['tests/py/test_example.py::test_platform_only'] },
    ),
    [],
  );

  const triggerDrift = workflow.replace(/^on:\r?\n\s+pull_request:/m, 'on:\n  push:\n  pull_request:');
  assert.match(validator.validateWorkflowContract(triggerDrift).join('\n'), /pull_request-only/i);

  const unguardedWindows = workflow.replace(
    /if:\s*\$\{\{[^\n]*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository[^\n]*\}\}/,
    'if: ${{ always() }}',
  );
  assert.match(
    validator.validateWorkflowContract(unguardedWindows).join('\n'),
    /same-repository pull request/i,
  );

  const missingFunctional = workflow.replace(/^\s{2}e2e_functional:/m, '  removed_e2e_functional:');
  assert.match(validator.validateWorkflowContract(missingFunctional).join('\n'), /functional job/i);

  const missingPerformance = workflow.replace(/^\s{2}e2e_performance_ci:/m, '  removed_e2e_performance_ci:');
  assert.match(validator.validateWorkflowContract(missingPerformance).join('\n'), /performance job/i);

  const workflowMutations = [
    [
      replaceInJob(workflow, 'test_js', /runs-on:\s*ubuntu-latest/, 'runs-on: windows-2025'),
      /portable.*ubuntu/i,
    ],
    [
      replaceInJob(workflow, 'e2e_production_parity', /runs-on:\s*ubuntu-latest/, 'runs-on: windows-2025'),
      /production parity.*ubuntu/i,
    ],
    [
      replaceInJob(workflow, 'test_node_windows', /runs-on:\s*windows-2025/, 'runs-on: ubuntu-latest'),
      /Windows Node.*windows-2025/i,
    ],
    [
      replaceInJob(workflow, 'test_python', /runs-on:\s*windows-2025/, 'runs-on: ubuntu-latest'),
      /Windows Python.*windows-2025/i,
    ],
    [workflow.replaceAll('node-version: "22"', 'node-version: "20"'), /Node(?:\.js)? 22/i],
    [workflow.replaceAll('python-version: "3.11"', 'python-version: "3.12"'), /Python 3\.11/i],
    [workflow.replaceAll('151.0.7922.138', '151.0.7922.139'), /Chrome 151\.0\.7922\.138/i],
    [workflow.replaceAll('ExpectedMajorVersion 17', 'ExpectedMajorVersion 16'), /PostgreSQL 17/i],
    [
      workflow.replaceAll('7.1-essentials_build-www.gyan.dev', '7.2-essentials_build-www.gyan.dev'),
      /FFmpeg 7\.1-essentials_build-www\.gyan\.dev/i,
    ],
    [
      replaceInJob(workflow, 'test_js', /cache:\s*npm/, 'cache: false'),
      /npm cache/i,
    ],
    [
      replaceInJob(workflow, 'test_js', /cache-dependency-path:\s*package-lock\.json/, 'cache-dependency-path: package.json'),
      /package-lock\.json/i,
    ],
    [
      replaceInJob(workflow, 'test_python', /cache:\s*pip/, 'cache: false'),
      /pip cache/i,
    ],
    [
      replaceInJob(workflow, 'test_python', /cache-dependency-path:\s*requirements\.txt/, 'cache-dependency-path: requirements.lock'),
      /requirements\.txt/i,
    ],
    [
      replaceInJob(workflow, 'test_js', /^\s+timeout-minutes:.*\r?\n/m, ''),
      /timeout/i,
    ],
    [workflow.replaceAll('--allowed-skips', '--ignore-skips'), /allowed skips/i],
    [workflow.replaceAll('--pytest-collection', '--ignore-collection'), /pytest collection/i],
    [
      replaceInJob(workflow, 'test_js', /if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'if: ${{ success() }}'),
      /version manifest.*always/i,
    ],
    [
      replaceInJob(workflow, 'test_js', /version-manifest/g, 'tool-versions'),
      /version manifest/i,
    ],
    [
      replaceInJob(workflow, 'test_js', /steps:/, 'env:\n      LEAKED_TOKEN: ${{ secrets.ALBUM_HAVEN_FIXTURES_TOKEN }}\n    steps:'),
      /portable.*secret|fork.*secret/i,
    ],
  ];
  for (const [changedWorkflow, expectedError] of workflowMutations) {
    assertWorkflowDrift(validator, workflow, changedWorkflow, expectedError);
  }

  const unpinnedFfmpeg = requirements.replace('imageio-ffmpeg==0.6.0', 'imageio-ffmpeg');
  assert.match(
    validator.validateDependencyContract(unpinnedFfmpeg).join('\n'),
    /imageio-ffmpeg 0\.6\.0/i,
  );
});
