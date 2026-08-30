const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const ciContractRoot = path.join(repoRoot, 'tests', 'ci');
const manifestSchemaPath = path.join(ciContractRoot, 'fixture-manifest.schema.json');
const testDataMatrixPath = path.join(ciContractRoot, 'test-data-matrix.json');
const functionalShardsPath = path.join(ciContractRoot, 'functional-shards.json');
const performanceTargetsPath = path.join(ciContractRoot, 'performance-targets.json');
const inventoryCommandPath = path.join(repoRoot, 'scripts', 'ci', 'list-playwright-inventory.cjs');

const fixtureProfiles = [
  'functional-core',
  'synthetic-large-library',
  'utility-problematic-files',
  'scan-library',
  'playback-media',
];

const configuredPlaywrightSurfaces = [
  'playwright.config.js',
  'playwright.autoplay-allowed.config.js',
  'playwright.component.config.js',
  'playwright.cover-rescan.config.js',
  'playwright.lastfm-auto-timezone.config.js',
  'playwright.synthetic-large-library.config.cjs',
  'playwright.utility-problematic-files.config.cjs',
  'playwright.non-album-rescan.config.js',
  'playwright.performance.config.cjs',
  'playwright.scan-performance.config.cjs',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function caseIdentity(entry) {
  return [entry.config, entry.project, entry.test, entry.case].join('::');
}

function validateTestDataMatrix(matrix, options = {}) {
  const expectedCases = options.expectedCases || null;
  const expectedConfigs = options.expectedConfigs || [];
  const errors = [];

  if (!Array.isArray(matrix)) return ['matrix must be an array'];

  const identities = new Set();
  const mutationOwners = new Set();
  const seenConfigs = new Set();

  for (const [index, entry] of matrix.entries()) {
    const location = `entry ${index}`;
    const requiredStrings = ['config', 'test', 'case'];
    for (const field of requiredStrings) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`${location} must declare ${field}`);
      }
    }
    if (
      typeof entry.project !== 'string'
      || (entry.project.trim() === '' && entry.config !== 'playwright.component.config.js')
    ) {
      errors.push(`${location} must declare project`);
    }

    const identity = caseIdentity(entry);
    if (identities.has(identity)) errors.push(`duplicate test ownership: ${identity}`);
    identities.add(identity);
    seenConfigs.add(entry.config);

    if (entry.profile !== null && !fixtureProfiles.includes(entry.profile)) {
      errors.push(`${identity} uses unknown fixture profile: ${entry.profile}`);
    }
    if (!['suite', 'isolated'].includes(entry.setupScope)) {
      errors.push(`${identity} has invalid setupScope`);
    }
    if (!['read-only', 'owned-mutation', 'global-mutation'].includes(entry.stateMode)) {
      errors.push(`${identity} has invalid stateMode`);
    }
    if (!['pending', 'approved'].includes(entry.ownerApproval)) {
      errors.push(`${identity} has invalid ownerApproval`);
    }
    for (const field of ['databaseScenarios', 'filesystemScenarios', 'expectedContracts']) {
      if (!Array.isArray(entry[field])) errors.push(`${identity} must declare ${field}`);
    }
    if (Array.isArray(entry.expectedContracts) && entry.expectedContracts.length === 0) {
      errors.push(`${identity} must declare at least one expected contract`);
    }
    if (Object.hasOwn(entry, 'dependsOn') || Object.hasOwn(entry, 'runAfter')) {
      errors.push(`${identity} declares a test-order dependency`);
    }

    if (entry.stateMode === 'read-only' && entry.mutationOwnership !== undefined) {
      errors.push(`${identity} assigns mutation data to shared read-only state`);
    }
    if (entry.stateMode === 'owned-mutation') {
      if (entry.setupScope !== 'isolated') {
        errors.push(`${identity} assigns owned mutation to shared suite setup`);
      }
      const databaseIdentity = entry.mutationOwnership?.databaseIdentity;
      const filesystemCopy = entry.mutationOwnership?.filesystemCopy;
      if (!databaseIdentity || !filesystemCopy) {
        errors.push(`${identity} must name its database identity and writable filesystem copy`);
      } else {
        const owner = `${databaseIdentity}::${filesystemCopy}`;
        if (mutationOwners.has(owner)) errors.push(`duplicate mutation ownership: ${owner}`);
        mutationOwners.add(owner);
      }
    }
    if (entry.stateMode === 'global-mutation') {
      if (entry.setupScope !== 'isolated' || !entry.globalMutationReason) {
        errors.push(`${identity} must isolate and explain global mutation`);
      }
    }
  }

  for (const config of expectedConfigs) {
    if (!seenConfigs.has(config)) errors.push(`missing configured Playwright surface: ${config}`);
  }
  if (expectedCases) {
    for (const identity of expectedCases) {
      if (!identities.has(identity)) errors.push(`missing discovered test: ${identity}`);
    }
  }

  return errors;
}

function validEntry(overrides = {}) {
  return {
    config: 'playwright.config.js',
    project: 'functional',
    test: 'tests/e2e/specs/example.spec.js',
    case: 'shows the example album',
    profile: 'functional-core',
    setupScope: 'suite',
    stateMode: 'read-only',
    databaseScenarios: ['album:example'],
    filesystemScenarios: ['covers:existing-approved-pool'],
    expectedContracts: ['example-album-visible'],
    ownerApproval: 'pending',
    ...overrides,
  };
}

function validateFunctionalShards(contract, expectedCases) {
  const errors = [];
  if (contract?.schemaVersion !== 1) errors.push('functional shard contract must use schemaVersion 1');
  if (contract?.browser !== 'chrome') errors.push('functional shards must use Chrome');
  if (contract?.workersPerInvocation !== 1) errors.push('functional shard invocations must use one worker');
  if (!Array.isArray(contract?.shards) || contract.shards.length !== 4) {
    errors.push('functional contract must declare exactly four shards');
    return errors;
  }

  const owners = new Set();
  const shardNames = new Set();
  for (const shard of contract.shards) {
    if (typeof shard.name !== 'string' || shard.name.trim() === '') {
      errors.push('functional shard must have a name');
    } else if (shardNames.has(shard.name)) {
      errors.push(`duplicate functional shard name: ${shard.name}`);
    } else {
      shardNames.add(shard.name);
    }
    if (shard.fixtureProfile !== 'functional-core') {
      errors.push(`functional shard ${shard.name || '<unnamed>'} must use functional-core`);
    }
    if (!Array.isArray(shard.suitePrerequisites) || shard.suitePrerequisites.length === 0) {
      errors.push(`functional shard ${shard.name || '<unnamed>'} must declare suite prerequisites`);
    }
    if (shard.dependsOn || shard.runAfter) {
      errors.push(`functional shard ${shard.name || '<unnamed>'} declares a test-order dependency`);
    }
    if (!Array.isArray(shard.invocations) || shard.invocations.length === 0) {
      errors.push(`functional shard ${shard.name || '<unnamed>'} must not be empty`);
      continue;
    }
    for (const invocation of shard.invocations) {
      if (invocation.workers !== undefined && invocation.workers !== 1) {
        errors.push(`${shard.name} invocation must use one worker`);
      }
      if (invocation.dependsOn || invocation.runAfter) {
        errors.push(`${shard.name} invocation declares a test-order dependency`);
      }
      if (!Array.isArray(invocation.cases) || invocation.cases.length === 0) {
        errors.push(`${shard.name} invocation must not be empty`);
        continue;
      }
      for (const entry of invocation.cases) {
        const identity = caseIdentity(entry);
        if (entry.config !== invocation.config || entry.project !== invocation.project) {
          errors.push(`${identity} disagrees with its functional invocation`);
        }
        if (entry.dependsOn || entry.runAfter) {
          errors.push(`${identity} declares a test-order dependency`);
        }
        if (owners.has(identity)) errors.push(`duplicate functional ownership: ${identity}`);
        owners.add(identity);
      }
    }
  }

  for (const identity of expectedCases) {
    if (!owners.has(identity)) errors.push(`missing functional test: ${identity}`);
  }
  for (const identity of owners) {
    if (!expectedCases.has(identity)) errors.push(`unknown functional test: ${identity}`);
  }
  return errors;
}

function validatePerformanceTargets(contract, expectedCases, expectedNames) {
  const errors = [];
  if (contract?.schemaVersion !== 1) errors.push('performance target contract must use schemaVersion 1');
  if (!Array.isArray(contract?.targets)) return [...errors, 'performance targets must be an array'];

  const names = new Set();
  const owners = new Set();
  for (const target of contract.targets) {
    const name = target?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push('performance target must have a name');
      continue;
    }
    if (names.has(name)) errors.push(`duplicate performance target: ${name}`);
    names.add(name);
    if (!fixtureProfiles.includes(target.fixtureProfile)) {
      errors.push(`${name} uses unknown fixture profile: ${target.fixtureProfile}`);
    }
    if (!['isolated', 'real', 'scan', 'synthetic'].includes(target.runnerClass)) {
      errors.push(`${name} uses unknown runner class: ${target.runnerClass}`);
    }
    if (target.workers !== 1) errors.push(`${name} must use one worker`);
    if (!['uncalibrated', 'calibrating', 'approved'].includes(target.calibrationState)) {
      errors.push(`${name} has invalid calibration state`);
    }
    if (!Array.isArray(target.cases) || target.cases.length === 0) {
      errors.push(`${name} must own at least one case`);
    } else {
      for (const entry of target.cases) {
        const identity = caseIdentity(entry);
        if (owners.has(identity)) errors.push(`duplicate performance ownership: ${identity}`);
        owners.add(identity);
      }
    }

    const thresholds = [target.targetMs, target.graceMs, target.ceilingMs];
    if (target.calibrationState !== 'approved') {
      if (thresholds.some((value) => value !== null)) {
        errors.push(`${name} must keep unapproved thresholds null`);
      }
      if (target.blocking !== false) errors.push(`${name} must remain nonblocking until approved`);
    } else {
      if (!Number.isFinite(target.targetMs) || target.targetMs <= 0) {
        errors.push(`${name} must declare a positive target`);
      }
      if (!Number.isFinite(target.graceMs) || target.graceMs < 200 || target.graceMs > 400) {
        errors.push(`${name} must declare grace from 200 through 400 ms`);
      }
      if (target.ceilingMs !== target.targetMs + target.graceMs) {
        errors.push(`${name} ceiling must equal target plus grace`);
      }
    }
  }

  for (const name of expectedNames) {
    if (!names.has(name)) errors.push(`missing performance target: ${name}`);
  }
  for (const name of names) {
    if (!expectedNames.has(name)) errors.push(`unknown performance target: ${name}`);
  }
  for (const identity of expectedCases) {
    if (!owners.has(identity)) errors.push(`orphaned performance case: ${identity}`);
  }
  for (const identity of owners) {
    if (!expectedCases.has(identity)) errors.push(`unknown performance case: ${identity}`);
  }

  const defaults = contract.targets.filter((target) => target.defaultMember === true);
  const omissions = contract.targets.filter((target) => target.defaultMember === false);
  if (defaults.length !== 19) errors.push('default performance group must expose all 19 targets');
  if (omissions.length !== 0) errors.push('default performance group must not omit a reviewed target');
  return errors;
}

function validPerformanceTarget(overrides = {}) {
  return {
    name: 'example-performance',
    cases: [{
      config: 'playwright.performance.config.cjs',
      project: 'idle-memory',
      test: 'example.spec.js',
      case: 'example case',
    }],
    fixtureProfile: 'playback-media',
    runnerClass: 'isolated',
    workers: 1,
    defaultMember: true,
    calibrationState: 'uncalibrated',
    blocking: false,
    targetMs: null,
    graceMs: null,
    ceilingMs: null,
    ...overrides,
  };
}

test('fixture manifest schema pins v1 and all five fixture profiles', () => {
  const schema = readJson(manifestSchemaPath);
  const profiles = schema.properties?.profiles;
  const profileContract = schema.$defs?.profile;

  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.manifestVersion?.const, 1);
  assert.deepEqual([...(profiles?.required || [])].sort(), [...fixtureProfiles].sort());
  assert.equal(profiles?.additionalProperties, false);
  assert.deepEqual(Object.keys(profiles?.properties || {}).sort(), [...fixtureProfiles].sort());
  for (const profile of fixtureProfiles) {
    assert.deepEqual(profiles.properties[profile], { $ref: '#/$defs/profile' });
  }

  assert.deepEqual(
    [...(profileContract?.required || [])].sort(),
    [
      'archive',
      'counts',
      'databaseSeed',
      'mediaRoot',
      'namedScenarioAssertions',
      'schemaVersion',
      'sha256',
    ],
  );
  assert.equal(profileContract?.properties?.schemaVersion?.const, 1);
  assert.equal(schema.$defs?.sha256?.pattern, '^[a-f0-9]{64}$');
  assert.equal(schema.$defs?.safeRelativePath?.type, 'string');
  assert.match(schema.$defs?.safeRelativePath?.pattern || '', /\\\.\\\./);
  assert.equal(schema.$defs?.counts?.minProperties, 1);
  assert.equal(schema.$defs?.counts?.additionalProperties?.type, 'integer');
  assert.equal(schema.$defs?.counts?.additionalProperties?.minimum, 0);
  assert.equal(schema.$defs?.namedScenarioAssertions?.minProperties, 1);
});

test('approved test-data matrix records every discovered case', () => {
  const matrix = readJson(testDataMatrixPath);
  const errors = validateTestDataMatrix(matrix, {
    expectedConfigs: configuredPlaywrightSurfaces,
  });

  assert.deepEqual(errors, []);
  assert.equal(matrix.length, 122);
  assert.equal(new Set(matrix.map(caseIdentity)).size, 122);
  assert.equal(matrix.every((entry) => entry.ownerApproval === 'approved'), true);
});

test('problematic-files cases exclusively use the dedicated fixture surface while Rules stays synthetic-large', () => {
  const matrix = readJson(testDataMatrixPath);
  const problematicCases = matrix.filter((entry) =>
    /FTC-UTIL-PROBLEMS-(009|010)/.test(entry.case));

  assert.equal(problematicCases.length, 2);
  assert.deepEqual(
    new Set(problematicCases.map((entry) => entry.case.match(/FTC-UTIL-PROBLEMS-(?:009|010)/)[0])),
    new Set(['FTC-UTIL-PROBLEMS-009', 'FTC-UTIL-PROBLEMS-010']),
  );
  for (const entry of problematicCases) {
    assert.equal(entry.config, 'playwright.utility-problematic-files.config.cjs');
    assert.equal(entry.project, 'utility-problematic-files');
    assert.equal(entry.profile, 'utility-problematic-files');
    assert.match(entry.test, /^tests\/e2e\/utilityProblematicFiles\//);
    assert.equal(entry.databaseScenarios.length > 0, true);
    assert.equal(
      entry.databaseScenarios.every((scenario) => scenario.startsWith('utility-problematic-files:')),
      true,
    );
    assert.deepEqual(entry.filesystemScenarios, ['media:utility-problematic-files']);
    assert.doesNotMatch(entry.case, /synthetic-large/i);
  }
  assert.equal(
    matrix.some((entry) => /FTC-UTIL-PROBLEMS-(009|010)/.test(entry.case)
      && !entry.test.startsWith('tests/e2e/utilityProblematicFiles/')),
    false,
  );

  const rulesCases = matrix.filter((entry) => /FTC-UTIL-RULES-/.test(entry.case));
  assert.equal(rulesCases.length > 0, true);
  for (const entry of rulesCases) {
    assert.equal(entry.config, 'playwright.synthetic-large-library.config.cjs');
    assert.equal(entry.project, 'synthetic-large-library');
    assert.equal(entry.profile, 'synthetic-large-library');
  }
});

test('problematic-files performance targets use only the dedicated profile and surface', () => {
  const targets = readJson(performanceTargetsPath).targets;
  for (const name of ['utility-problematic-files', 'problematic-files-focused']) {
    const target = targets.find((entry) => entry.name === name);
    assert.ok(target, name);
    assert.equal(target.fixtureProfile, 'utility-problematic-files', name);
    assert.equal(target.workers, 1, name);
    assert.equal(target.cases.length, 1, name);
    assert.equal(target.cases[0].config, 'playwright.utility-problematic-files.config.cjs', name);
    assert.equal(target.cases[0].project, 'utility-problematic-files', name);
    assert.match(target.cases[0].test, /^tests\/e2e\/utilityProblematicFiles\//, name);
  }
});

test('matrix validation rejects duplicate and missing test ownership', () => {
  const entry = validEntry();
  const expectedCases = new Set([caseIdentity(entry), 'config::project::missing.spec.js::missing case']);
  const errors = validateTestDataMatrix([entry, { ...entry }], { expectedCases });

  assert.equal(errors.some((error) => error.startsWith('duplicate test ownership:')), true);
  assert.equal(errors.includes('missing discovered test: config::project::missing.spec.js::missing case'), true);
});

test('matrix validation rejects omitted special Playwright configurations', () => {
  const errors = validateTestDataMatrix([validEntry()], {
    expectedConfigs: ['playwright.config.js', 'playwright.autoplay-allowed.config.js'],
  });

  assert.equal(
    errors.includes('missing configured Playwright surface: playwright.autoplay-allowed.config.js'),
    true,
  );
});

test('matrix validation permits an implicit empty project only for component cases', () => {
  const componentEntry = validEntry({
    config: 'playwright.component.config.js',
    project: '',
    profile: null,
  });
  assert.deepEqual(validateTestDataMatrix([componentEntry]), []);

  const errors = validateTestDataMatrix([validEntry({ project: '' })]);
  assert.equal(errors.includes('entry 0 must declare project'), true);
});

test('matrix validation rejects order dependencies and unknown fixture profiles', () => {
  const errors = validateTestDataMatrix([
    validEntry({ profile: 'owner-library', dependsOn: 'another test' }),
  ]);

  assert.equal(errors.some((error) => error.includes('unknown fixture profile: owner-library')), true);
  assert.equal(errors.some((error) => error.includes('test-order dependency')), true);
});

test('matrix validation rejects mutation assigned to shared or duplicate data', () => {
  const ownership = {
    databaseIdentity: 'album:mutable-example',
    filesystemCopy: 'media/mutable-example',
  };
  const errors = validateTestDataMatrix([
    validEntry({
      case: 'mutates shared data',
      stateMode: 'owned-mutation',
      mutationOwnership: ownership,
    }),
    validEntry({
      case: 'reuses mutation data',
      setupScope: 'isolated',
      stateMode: 'owned-mutation',
      mutationOwnership: ownership,
    }),
  ]);

  assert.equal(errors.some((error) => error.includes('owned mutation to shared suite setup')), true);
  assert.equal(errors.includes('duplicate mutation ownership: album:mutable-example::media/mutable-example'), true);
});

test('functional shard contract owns all 91 browser-functional cases exactly once', () => {
  const matrix = readJson(testDataMatrixPath);
  const expectedCases = new Set(
    matrix
      .filter((entry) => [
        'playwright.config.js',
        'playwright.autoplay-allowed.config.js',
        'playwright.cover-rescan.config.js',
        'playwright.lastfm-auto-timezone.config.js',
        'playwright.non-album-rescan.config.js',
      ].includes(entry.config))
      .map(caseIdentity),
  );
  const contract = readJson(functionalShardsPath);
  const errors = validateFunctionalShards(contract, expectedCases);

  assert.equal(expectedCases.size, 91);
  assert.deepEqual(errors, []);
  assert.equal(contract.shards.length, 4);
  assert.equal(contract.shards.every((shard) => shard.invocations.length > 0), true);
  assert.equal(contract.workersPerInvocation, 1);
});

test('performance target contract owns all 26 performance cases across 19 targets', () => {
  const matrix = readJson(testDataMatrixPath);
  const expectedCases = new Set(
    matrix
      .filter((entry) => [
        'playwright.synthetic-large-library.config.cjs',
        'playwright.utility-problematic-files.config.cjs',
        'playwright.performance.config.cjs',
        'playwright.scan-performance.config.cjs',
      ].includes(entry.config))
      .map(caseIdentity),
  );
  const expectedNames = new Set([
    'idle-memory',
    'playback-start',
    'gapless-playback',
    'all-artists',
    'artist-family',
    'search-all-artists',
    'utility-problematic-files',
    'utility-rules',
    'selected-artist',
    'search-browse',
    'root-album-browse',
    'app-open-all-artists',
    'problematic-files-focused',
    'rules-focused',
    'scan-cold',
    'scan-cached',
    'scan-add-album',
    'scan-metadata',
    'scan-page',
  ]);
  const contract = readJson(performanceTargetsPath);
  const errors = validatePerformanceTargets(contract, expectedCases, expectedNames);

  assert.equal(expectedCases.size, 26);
  assert.deepEqual(errors, []);
  assert.equal(contract.targets.length, 19);
  assert.equal(contract.targets.filter((target) => target.defaultMember).length, 19);
  assert.equal(
    contract.targets
      .filter((target) => target.calibrationState !== 'approved')
      .every((target) => [target.targetMs, target.graceMs, target.ceilingMs].every((value) => value === null)),
    true,
  );
});

test('functional shard validation rejects duplicate, missing, and empty ownership', () => {
  const first = validEntry();
  const second = validEntry({ case: 'second functional case' });
  const expectedCases = new Set([caseIdentity(first), caseIdentity(second)]);
  const contract = {
    schemaVersion: 1,
    browser: 'chrome',
    workersPerInvocation: 1,
    shards: [
      {
        name: 'duplicate-owner',
        fixtureProfile: 'functional-core',
        suitePrerequisites: ['fixture seed'],
        invocations: [{ config: first.config, project: first.project, workers: 1, cases: [first, first] }],
      },
      {
        name: 'empty-owner',
        fixtureProfile: 'functional-core',
        suitePrerequisites: ['fixture seed'],
        invocations: [],
      },
      {
        name: 'third-shard',
        fixtureProfile: 'functional-core',
        suitePrerequisites: ['fixture seed'],
        invocations: [{ config: first.config, project: first.project, workers: 1, cases: [first] }],
      },
      {
        name: 'fourth-shard',
        fixtureProfile: 'functional-core',
        suitePrerequisites: ['fixture seed'],
        invocations: [{ config: first.config, project: first.project, workers: 1, cases: [first] }],
      },
    ],
  };
  const errors = validateFunctionalShards(contract, expectedCases);

  assert.equal(errors.some((error) => error.startsWith('duplicate functional ownership:')), true);
  assert.equal(errors.includes(`missing functional test: ${caseIdentity(second)}`), true);
  assert.equal(errors.includes('functional shard empty-owner must not be empty'), true);
});

test('performance validation rejects orphaned cases and invalid target contracts', () => {
  const ownedCase = validPerformanceTarget().cases[0];
  const orphanedIdentity = 'playwright.performance.config.cjs::idle-memory::missing.spec.js::missing case';
  const expectedCases = new Set([caseIdentity(ownedCase), orphanedIdentity]);
  const target = validPerformanceTarget({
    fixtureProfile: 'owner-library',
    calibrationState: 'approved',
    blocking: true,
    targetMs: 1000,
    graceMs: 199,
    ceilingMs: 1500,
    defaultMember: false,
  });
  const errors = validatePerformanceTargets(
    { schemaVersion: 1, targets: [target] },
    expectedCases,
    new Set([target.name]),
  );

  assert.equal(errors.includes(`orphaned performance case: ${orphanedIdentity}`), true);
  assert.equal(errors.some((error) => error.includes('unknown fixture profile: owner-library')), true);
  assert.equal(errors.some((error) => error.includes('grace from 200 through 400 ms')), true);
  assert.equal(errors.some((error) => error.includes('ceiling must equal target plus grace')), true);
});

test('tracked E2E fixture sources contain only approved images and intentional path-safe data', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
  const approvedImages = new Map();
  const intentionalDataFiles = new Map([
    ['tests/e2e/fixtures/idleMemoryBudget.json', [
      'tests/e2e/performance/idleMemory.spec.js',
      'tests/e2e/support/isolatedLibraryApp.py',
    ]],
    ['tests/e2e/fixtures/approvedCoverFixtures.json', [
      'tests/e2e/helpers/coverLookupFixtureData.js',
      'tests/e2e/support/isolatedLibraryApp.py',
      'tests/e2e/support/scanPerformanceApp.py',
    ]],
  ]);
  const trackedFiles = execFileSync('git', ['ls-files', 'tests/e2e/fixtures'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll('\\', '/'))
    .filter((file) => fs.existsSync(path.join(repoRoot, ...file.split('/'))))
    .sort();
  const imageFiles = trackedFiles.filter((file) => /\.(?:gif|jpe?g|png|webp)$/i.test(file));
  const dataFiles = trackedFiles.filter((file) => !imageFiles.includes(file));
  const errors = [];

  if (JSON.stringify(imageFiles) !== JSON.stringify([...approvedImages.keys()].sort())) {
    errors.push(`unexpected tracked fixture images: ${imageFiles.join(', ')}`);
  }
  for (const [relativePath, expectedHash] of approvedImages) {
    const bytes = fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')));
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) errors.push(`approved fixture image hash changed: ${relativePath}`);
  }
  if (JSON.stringify(dataFiles) !== JSON.stringify([...intentionalDataFiles.keys()].sort())) {
    errors.push(`unexpected or orphaned tracked fixture data: ${dataFiles.join(', ')}`);
  }
  for (const relativePath of dataFiles) {
    const contents = fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
    if (/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/m.test(contents)
      || /\\\\[^\\\s]+\\/m.test(contents)
      || /(?:^|["'\s])\/(?:Users|home|private|Volumes|mnt)\//im.test(contents)) {
      errors.push(`owner/private absolute path marker in tracked fixture data: ${relativePath}`);
    }
  }
  for (const [relativePath, consumers] of intentionalDataFiles) {
    const fixtureName = path.basename(relativePath);
    if (!consumers.some((consumer) => (
      fs.readFileSync(path.join(repoRoot, ...consumer.split('/')), 'utf8').includes(fixtureName)
    ))) {
      errors.push(`intentional fixture data has no source consumer: ${relativePath}`);
    }
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'approvedCoverFixtures.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.covers.length, 8);
  assert.equal(new Set(manifest.covers.map((cover) => cover.assetId)).size, 8);
  assert.equal(manifest.covers.every((cover) => /^[a-f0-9]{64}$/.test(cover.sha256)), true);
  assert.equal(manifest.covers.every((cover) => !('fileName' in cover) && !('repoPath' in cover)), true);
  assert.deepEqual(errors, []);
});

test('idle-memory fixture uses the owner-approved shared local and CI limits', () => {
  const budget = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/fixtures/idleMemoryBudget.json'),
    'utf8',
  ));
  assert.equal(budget.maxIdleMemoryMb, 15);
  assert.equal(budget.maxIdleDriftMb, 2);
});

test('read-only inventory command reports complete discovery and ownership totals', () => {
  const output = execFileSync(process.execPath, [inventoryCommandPath, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const inventory = JSON.parse(output);

  assert.equal(inventory.configuredSurfaces, 10);
  assert.deepEqual(inventory.categories, {
    browserFunctional: 91,
    component: 5,
    performance: 26,
    total: 122,
  });
  assert.deepEqual(inventory.ownership, {
    testDataMatrix: 122,
    functionalShards: 91,
    performanceTargets: 26,
  });
});
