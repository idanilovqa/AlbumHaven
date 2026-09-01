const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_TARGET_COUNT = 19;
const EXPECTED_CASE_COUNT = 26;
const MATRIX_FIELDS = ['shard', 'fixtureProfile', 'fixtureMode', 'harness', 'basePort', 'targets'];
const CALIBRATION_POLICY = Object.freeze({
  evidenceMode: 'retained-cohorts',
  separateCampaignRequired: false,
  thresholdAuthority: 'central-performance-times-registry',
  localAndCiThresholds: 'environment-contracts',
  timingAuthority: 'tests/ci/performance-times.json',
  approvedCiOverrideCount: 5,
  fingerprintFields: [
    'runnerImage', 'chromeVersion', 'fixtureRelease',
    'fixtureSchemaVersion', 'postgresMajor', 'measurementContract',
  ],
  partitionBySourceRevision: true,
  minimumSamples: { median: 1, variance: 2, p90: 10, p95: 20 },
  exceptionsRequireOwnerApproval: true,
});
const SHARD_DEFINITIONS = Object.freeze([
  { shard: 'synthetic-large-library', fixtureProfile: 'synthetic-large-library', fixtureMode: 'preloaded-release', harness: 'managed-app', basePort: '4173', targets: 'idle-memory,all-artists,artist-family,search-all-artists,utility-rules,selected-artist,search-browse,root-album-browse,app-open-all-artists,rules-focused' },
  { shard: 'utility-problematic-files', fixtureProfile: 'utility-problematic-files', fixtureMode: 'preloaded-release', harness: 'managed-app', basePort: '4253', targets: 'utility-problematic-files,problematic-files-focused' },
  { shard: 'playback-media', fixtureProfile: 'playback-media', fixtureMode: 'generated-isolated', harness: 'managed-app', basePort: '4213', targets: 'playback-start,gapless-playback' },
  { shard: 'scan-library', fixtureProfile: 'scan-library', fixtureMode: 'generated-isolated', harness: 'scan', basePort: '4293', targets: 'scan-cold,scan-cached,scan-add-album,scan-metadata,scan-page' },
]);
const FIXTURE_DOWNLOAD_PROFILES = Object.freeze({
  'synthetic-large-library': 'synthetic-large-library',
  'utility-problematic-files': 'utility-problematic-files',
  'playback-media': 'synthetic-large-library',
  'scan-library': 'synthetic-large-library',
});

function normalizeTestPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function caseKey(value) {
  return [value.config, value.project, path.posix.basename(normalizeTestPath(value.test)), value.case]
    .map((part) => String(part || '').trim()).join('\0');
}

function performanceJobSource(workflow) {
  const start = workflow.indexOf('  e2e_performance_ci:');
  const end = workflow.indexOf('\n  pr_agent_review:', start);
  if (start === -1 || end === -1) throw new Error('pr-gates.yml must contain a bounded e2e_performance_ci job');
  return workflow.slice(start, end);
}

function parseStaticPerformanceMatrixRaw(workflow) {
  const job = performanceJobSource(workflow);
  if (/matrix:\s*\$\{\{/i.test(job)) throw new Error('performance matrix must be a literal checked-in include list');
  const match = job.match(/\n\s+matrix:\r?\n\s+include:\r?\n([\s\S]*?)\n\s+steps:/);
  if (!match) throw new Error('performance matrix must use a literal include list');
  return match[1].split(/(?:^|\r?\n)\s+- shard:\s*/).slice(1).map((block) => {
    const [shard, ...lines] = block.split(/\r?\n/);
    const fields = Object.fromEntries(lines.map((line) => {
      const field = line.trim().match(/^([A-Za-z][A-Za-z0-9]*):\s*["']?(.+?)["']?$/);
      return field ? [field[1], field[2]] : [];
    }).filter((entry) => entry.length === 2));
    return { shard: shard.trim().replace(/["']$/u, ''), ...fields };
  });
}

function parseStaticPerformanceMatrix(workflow) {
  return parseStaticPerformanceMatrixRaw(workflow).map((row) => Object.fromEntries(
    MATRIX_FIELDS.map((field) => [field, row[field]]),
  ));
}

function expectedRows() {
  return SHARD_DEFINITIONS.map((row) => ({ ...row }));
}

function namedWorkflowStep(job, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return job.match(new RegExp(`\\n\\s{6}- name:\\s*${escapedName}\\r?\\n([\\s\\S]*?)(?=\\n\\s{6}- name:|$)`))?.[0] || '';
}

function validateRegistry(errors, contract, runnerModule, testDataMatrix) {
  if (contract?.schemaVersion !== 1) errors.push('performance target schemaVersion must be 1');
  if (contract?.approvalGate?.gate !== 7 || contract?.approvalGate?.status !== 'approved') {
    errors.push('performance target Gate 7 must be approved');
  }
  if (JSON.stringify(contract?.calibrationPolicy) !== JSON.stringify(CALIBRATION_POLICY)) {
    errors.push('performance calibration must use retained cohorts and the central explicit local/CI environment contracts');
  }
  const targets = Array.isArray(contract?.targets) ? contract.targets : [];
  const cases = targets.flatMap((target) => target.cases || []);
  if (targets.length !== EXPECTED_TARGET_COUNT) errors.push(`performance registry must contain ${EXPECTED_TARGET_COUNT} targets`);
  if (cases.length !== EXPECTED_CASE_COUNT) errors.push(`performance registry must contain ${EXPECTED_CASE_COUNT} cases`);
  const names = targets.map((target) => target.name);
  if (new Set(names).size !== names.length) errors.push('duplicate performance target registration');
  for (const target of targets) {
    if (target.workers !== 1) errors.push(`performance target ${target.name} must use one worker`);
    if (!target.defaultMember) errors.push(`performance target ${target.name} must be a default member`);
    if (target.calibrationState === 'uncalibrated' && target.blocking !== false) {
      errors.push(`uncalibrated performance target ${target.name} must remain nonblocking`);
    }
  }
  const runnerTargets = runnerModule?.PERFORMANCE_TARGETS || {};
  if (JSON.stringify(Object.keys(runnerTargets)) !== JSON.stringify(names)) {
    errors.push('performance runner registry disagrees with the reviewed target contract');
  }
  const defaultNames = runnerModule?._private?.listDefaultPerformanceTargets?.()
    .map((target) => target.aliasNames?.[0] || target.specPath) || [];
  if (JSON.stringify(defaultNames) !== JSON.stringify(names)) {
    errors.push('performance runner default group disagrees with the reviewed target contract');
  }
  const ownedKeys = cases.map(caseKey);
  if (new Set(ownedKeys).size !== ownedKeys.length) errors.push('duplicate performance case ownership');
  const matrixKeys = new Set((testDataMatrix || []).map(caseKey));
  for (const key of ownedKeys) if (!matrixKeys.has(key)) errors.push(`performance case is missing from the test-data matrix: ${key}`);
}

function validateShardRows(errors, rawRows, contract) {
  const rows = rawRows.map((row) => Object.fromEntries(MATRIX_FIELDS.map((field) => [field, row[field]])));
  if (rows.length !== SHARD_DEFINITIONS.length) errors.push('performance matrix must contain exactly four profile runners');
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows())) errors.push('performance shard rows disagree with the reviewed compatible allocation');
  const targetsByName = new Map((contract.targets || []).map((target) => [target.name, target]));
  const owned = [];
  for (const row of rawRows) {
    if (row.fixtureDownloadProfile !== FIXTURE_DOWNLOAD_PROFILES[row.shard]) {
      errors.push(`performance shard ${row.shard} has the wrong immutable fixture download profile`);
    }
    const names = String(row.targets || '').split(',').filter(Boolean);
    owned.push(...names);
    for (const [index, name] of names.entries()) {
      if (row[`target${index + 1}`] !== name) errors.push(`performance shard ${row.shard} artifact slots disagree with targets`);
      const target = targetsByName.get(name);
      if (!target) continue;
      const compatibleHarness = row.harness === 'managed-app'
        ? ['isolated', 'synthetic'].includes(target.runnerClass)
        : target.runnerClass === row.harness;
      if (target.fixtureProfile !== row.fixtureProfile || target.fixtureMode !== row.fixtureMode || !compatibleHarness) {
        errors.push(`performance shard ${row.shard} contains incompatible fixture or harness target ${name}`);
      }
    }
    for (let slot = names.length + 1; slot <= 10; slot += 1) {
      if (row[`target${slot}`] !== 'none') errors.push(`performance shard ${row.shard} must fill unused artifact slots with none`);
    }
  }
  const registered = (contract.targets || []).map((target) => target.name);
  if (owned.length !== registered.length || new Set(owned).size !== registered.length
    || registered.some((name) => !owned.includes(name))) {
    errors.push('all 19 performance targets must be owned exactly once across four profile runners');
  }
}

function validateWorkflowContract(workflow, contract, runnerModule, testDataMatrix) {
  const errors = [];
  let rawRows;
  let job;
  try {
    rawRows = parseStaticPerformanceMatrixRaw(workflow);
    job = performanceJobSource(workflow);
  } catch (error) {
    return [error.message];
  }
  validateRegistry(errors, contract, runnerModule, testDataMatrix);
  validateShardRows(errors, rawRows, contract);

  const patterns = [
    [/name:\s*["']E2E Performance: \$\{\{\s*matrix\.shard\s*\}\}["']/, 'visible shard job name'],
    [/runs-on:\s*windows-2025/, 'Windows 2025 runner'],
    [/fail-fast:\s*false/, 'fail-fast false'],
    [/max-parallel:\s*4/, 'maximum parallel four'],
    [/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/, 'same-repository guard'],
    [/run-performance-shard\.ps1/, 'sequential shard runner'],
    [/-Targets\s+["']?\$\{\{\s*matrix\.targets\s*\}\}/, 'literal shard targets'],
    [/-BasePort\s+["']?\$\{\{\s*matrix\.basePort\s*\}\}/, 'target-owned port base'],
    [/-Browser\s+chrome/, 'Chrome selection'],
    [/node scripts\/ci\/validate-performance-matrix\.cjs --list/, 'matrix validation step'],
  ];
  for (const [pattern, label] of patterns) if (!pattern.test(job)) errors.push(`performance workflow is missing ${label}`);
  if (/continue-on-error:/.test(job)) errors.push('performance process failures must not be hidden');
  const trustedCheckout = namedWorkflowStep(job, 'Checkout trusted fixture downloader');
  const fixtureFetch = namedWorkflowStep(job, 'Fetch immutable performance fixture');
  if (/\n\s+if:/.test(trustedCheckout) || /\n\s+if:/.test(fixtureFetch)) errors.push('trusted fixture seed must be fetched for every performance shard');
  if (!/github\.event\.pull_request\.base\.sha/.test(job) || !/path:\s*\.trusted-ci/.test(job)) errors.push('performance shards must use a trusted base checkout');
  if (!/-Profile\s+\$\{\{\s*matrix\.fixtureDownloadProfile\s*\}\}/.test(fixtureFetch)) errors.push('performance fixture fetch must use the reviewed download profile');
  if (!/generated-isolated[\s\S]*ALBUM_HAVEN_APPROVED_COVER_ROOT[\s\S]*ALBUM_HAVEN_FIXTURE_ROOT[\s\S]*ALBUM_HAVEN_MEDIA_ROOT/.test(job)) errors.push('generated shards must isolate a verified released cover seed from runtime fixture roots');
  if (job.indexOf('Fetch immutable performance fixture') > job.indexOf('Install Node dependencies')
    || job.indexOf('Fetch immutable performance fixture') > job.indexOf('Validate performance matrix ownership')) {
    errors.push('secret-bearing fixture fetch must precede pull-request executable code');
  }
  for (let slot = 1; slot <= 10; slot += 1) {
    const expression = `\\$\\{\\{\\s*matrix\\.target${slot}\\s*\\}\\}`;
    const resultPattern = new RegExp(`name:\\s*performance-result-${expression}-\\$\\{\\{\\s*github\\.run_attempt\\s*\\}\\}`);
    const diagnosticsPattern = new RegExp(`name:\\s*performance-diagnostics-${expression}-\\$\\{\\{\\s*github\\.run_attempt\\s*\\}\\}`);
    const foundationPattern = new RegExp(`name:\\s*foundation-versions-performance-${expression}-\\$\\{\\{\\s*github\\.run_attempt\\s*\\}\\}`);
    if (!resultPattern.test(job)) errors.push(`performance result artifact slot ${slot} is missing`);
    if (!diagnosticsPattern.test(job)) errors.push(`performance diagnostics artifact slot ${slot} is missing`);
    if (!foundationPattern.test(job)) errors.push(`performance foundation artifact slot ${slot} is missing`);
  }
  if (/^\s{2}(?:push|schedule|workflow_dispatch|pull_request_target):/m.test(workflow)) errors.push('PR gates workflow must remain pull-request-only');
  return errors;
}

function parseListOutput(output, config) {
  const cases = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s+›\s+(.+?):\d+:\d+\s+›\s+(.+?)\s*$/);
    if (match) cases.push({ config, project: match[1].trim(), test: match[2].trim(), case: match[3].trim() });
  }
  return cases;
}

function discoverPerformanceCases(contract, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const configs = [...new Set((contract.targets || []).flatMap((target) => (target.cases || []).map((ownedCase) => ownedCase.config)))];
  const cliPath = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  return configs.flatMap((config) => {
    const result = spawnSyncFn(process.execPath, [cliPath, 'test', '--list', '--reporter=line', `--config=${config}`], {
      cwd: repoRoot,
      env: { ...process.env, ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY: '1', PLAYWRIGHT_MANAGED_APP: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
      throw new Error(`Playwright performance discovery failed for ${config}${detail ? `: ${detail}` : ''}`);
    }
    return parseListOutput(result.stdout, config);
  });
}

function validateDiscoveredCases(contract, discoveredCases) {
  const ownedKeys = (contract.targets || []).flatMap((target) => target.cases || []).map(caseKey);
  const discoveredKeys = (discoveredCases || []).map(caseKey);
  const errors = [];
  if (new Set(discoveredKeys).size !== discoveredKeys.length) errors.push('duplicate performance discovery');
  const ownedSet = new Set(ownedKeys);
  const discoveredSet = new Set(discoveredKeys);
  for (const key of discoveredSet) if (!ownedSet.has(key)) errors.push(`unowned discovered performance case: ${key}`);
  for (const key of ownedSet) if (!discoveredSet.has(key)) errors.push(`undiscovered owned performance case: ${key}`);
  return errors;
}

function loadInputs(repoRoot) {
  return {
    workflow: fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml'), 'utf8'),
    contract: JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'ci', 'performance-targets.json'), 'utf8')),
    testDataMatrix: JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'), 'utf8')),
    runnerModule: require(path.join(repoRoot, 'scripts', 'run-performance-playwright.cjs')),
  };
}

module.exports = {
  SHARD_DEFINITIONS,
  caseKey,
  discoverPerformanceCases,
  expectedRows,
  namedWorkflowStep,
  parseListOutput,
  parseStaticPerformanceMatrix,
  performanceJobSource,
  validateDiscoveredCases,
  validateWorkflowContract,
};

if (require.main === module) {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const inputs = loadInputs(repoRoot);
    const errors = validateWorkflowContract(inputs.workflow, inputs.contract, inputs.runnerModule, inputs.testDataMatrix);
    if (process.argv.includes('--list')) errors.push(...validateDiscoveredCases(inputs.contract, discoverPerformanceCases(inputs.contract, { repoRoot })));
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`performance matrix: 4 profile runners, ${EXPECTED_TARGET_COUNT} targets, ${EXPECTED_CASE_COUNT} cases\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
