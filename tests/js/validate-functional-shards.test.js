const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const validatorPath = path.join(repoRoot, 'scripts', 'ci', 'validate-functional-shards.cjs');
const shardContractPath = path.join(repoRoot, 'tests', 'ci', 'functional-shards.json');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml');
const runnerPath = path.join(repoRoot, 'scripts', 'run-playwright.cjs');
const isolatedAppPath = path.join(repoRoot, 'tests', 'e2e', 'support', 'isolatedLibraryApp.py');
const baseFixturesPath = path.join(repoRoot, 'tests', 'e2e', 'support', 'baseFixtures.js');
const autoplayConfigPath = path.join(repoRoot, 'playwright.autoplay-allowed.config.js');
const validatorExists = fs.existsSync(validatorPath);
const validatorTest = validatorExists ? test : test.skip;

const EXPECTED_SHARD_COUNTS = new Map([
  ['gallery-search-visual', 35],
  ['cover-providers', 18],
  ['metadata-mutations', 13],
  ['playback-utilities', 25],
]);
const EXPECTED_SHARD_DISPLAY_NAMES = new Map([
  ['gallery-search-visual', 'Gallery, Search & Visual'],
  ['cover-providers', 'Cover Providers'],
  ['metadata-mutations', 'Metadata Mutations'],
  ['playback-utilities', 'Playback & Utilities'],
]);
const EXPECTED_FUNCTIONAL_CONFIGS = [
  'playwright.config.js',
  'playwright.autoplay-allowed.config.js',
  'playwright.cover-rescan.config.js',
  'playwright.lastfm-auto-timezone.config.js',
  'playwright.non-album-rescan.config.js',
];
const FIXTURE_RELEASE = 'fixtures-v1.0.19';
const FIXTURE_MANIFEST_SHA256 = 'cb9ed982ec5afd191e77c99f90cc42ecaec228086d9147df4fdd6b1b621b8d51';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadValidator() {
  return require(validatorPath);
}

function ownedCases(contract) {
  return contract.shards.flatMap((shard) => shard.invocations.flatMap((invocation) => (
    invocation.cases.map((ownedCase) => ({ ...ownedCase }))
  )));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorText(errors) {
  return errors.map((error) => String(error)).join('\n');
}

function functionalJobSource() {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const start = workflow.indexOf('  e2e_functional:');
  const end = workflow.indexOf('\n  e2e_performance_ci:', start);
  assert.notEqual(start, -1, 'pr-gates.yml must define e2e_functional');
  assert.notEqual(end, -1, 'e2e_functional must remain independently bounded');
  return { workflow, job: workflow.slice(start, end) };
}

function parseFunctionalMatrix(job) {
  const matrixMatch = job.match(/\n\s+matrix:\r?\n\s+include:\r?\n([\s\S]*?)\n\s+steps:/);
  assert.ok(matrixMatch, 'e2e_functional must use a static matrix include list');
  return matrixMatch[1]
    .split(/(?:^|\r?\n)\s+- shard:\s*/)
    .slice(1)
    .map((block) => {
      const [name, ...lines] = block.split(/\r?\n/);
      const fields = Object.fromEntries(lines.map((line) => {
        const match = line.trim().match(/^([A-Za-z][A-Za-z0-9]*):\s*["']?(.+?)["']?$/);
        return match ? [match[1], match[2]] : [];
      }).filter((entry) => entry.length === 2));
      return { shard: name.trim(), ...fields };
    });
}

test('functional shard contract pins the approved four-way 91-case assignment', () => {
  const contract = readJson(shardContractPath);
  assert.equal(contract.browser, 'chrome');
  assert.equal(contract.workersPerInvocation, 1);
  assert.deepEqual(contract.shards.map((shard) => shard.name), [...EXPECTED_SHARD_COUNTS.keys()]);

  let total = 0;
  for (const shard of contract.shards) {
    const count = shard.invocations.flatMap((invocation) => invocation.cases).length;
    assert.equal(count, EXPECTED_SHARD_COUNTS.get(shard.name), shard.name);
    total += count;
    assert.ok(shard.invocations.length > 0, `${shard.name} must not be empty`);
    assert.ok(shard.suitePrerequisites.length > 0, `${shard.name} must declare prerequisites`);
  }
  assert.equal(total, 91);

  const autoplayOwners = contract.shards.filter((shard) => shard.invocations.some(
    (invocation) => invocation.config === 'playwright.autoplay-allowed.config.js',
  ));
  assert.deepEqual(autoplayOwners.map((shard) => shard.name), ['playback-utilities']);
  const autoplayInvocation = autoplayOwners[0].invocations.find(
    (invocation) => invocation.config === 'playwright.autoplay-allowed.config.js',
  );
  assert.equal(autoplayInvocation.project, 'reload-autoplay-allowed');
  assert.equal(autoplayInvocation.workers, 1);
  assert.equal(autoplayInvocation.cases.length, 1);
});

test('functional shard validator module exists', () => {
  assert.equal(validatorExists, true, 'Missing scripts/ci/validate-functional-shards.cjs');
});

validatorTest('validator discovers every approved functional config through Playwright --list', () => {
  const calls = [];
  const discovered = loadValidator().discoverFunctionalCases({
    repoRoot,
    spawnSyncFn(executable, args, options) {
      calls.push({ executable, args, options });
      const configArg = args.find((arg) => String(arg).startsWith('--config='));
      const config = configArg.slice('--config='.length);
      return {
        status: 0,
        stdout: `[project] › tests/e2e/specs/${config}.spec.js:1:1 › ${config} case\nTotal: 1 test\n`,
        stderr: '',
      };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.args.find((arg) => String(arg).startsWith('--config=')).slice(9)),
    EXPECTED_FUNCTIONAL_CONFIGS,
  );
  for (const call of calls) {
    assert.match(String(call.executable), /node(?:\.exe)?$/i);
    assert.ok(call.args.includes('test'));
    assert.ok(call.args.includes('--list'));
    assert.match(call.args[0], /node_modules[\\/]@playwright[\\/]test[\\/]cli\.js$/);
    assert.equal(call.options.cwd, repoRoot);
  }
  assert.equal(discovered.length, EXPECTED_FUNCTIONAL_CONFIGS.length);
});

validatorTest('validator accepts the exact approved ownership and rejects every ownership drift class', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const discovered = ownedCases(contract);
  assert.deepEqual(validator.validateFunctionalShardContract(contract, discovered), []);

  const playwrightRelativeDiscovery = discovered.map((discoveredCase) => ({
    ...discoveredCase,
    test: discoveredCase.test.replace(/^tests\/e2e\/specs\//, ''),
  }));
  assert.deepEqual(
    validator.validateFunctionalShardContract(contract, playwrightRelativeDiscovery),
    [],
  );

  const duplicate = clone(contract);
  duplicate.shards[1].invocations[0].cases.push(clone(duplicate.shards[0].invocations[0].cases[0]));
  assert.match(errorText(validator.validateFunctionalShardContract(duplicate, discovered)), /duplicate/i);

  const missing = clone(contract);
  missing.shards[0].invocations[0].cases.pop();
  assert.match(errorText(validator.validateFunctionalShardContract(missing, discovered)), /missing|unassigned/i);

  const orphan = clone(contract);
  orphan.shards[0].invocations[0].cases.push({
    config: 'playwright.config.js',
    project: 'functional',
    test: 'tests/e2e/specs/orphan.spec.js',
    case: 'orphan case',
  });
  assert.match(errorText(validator.validateFunctionalShardContract(orphan, discovered)), /orphan|unknown/i);

  const empty = clone(contract);
  empty.shards[2].invocations = [];
  assert.match(errorText(validator.validateFunctionalShardContract(empty, discovered)), /empty|must not be empty/i);

  const unknownConfig = clone(contract);
  unknownConfig.shards[0].invocations[0].config = 'playwright.unknown.config.js';
  for (const ownedCase of unknownConfig.shards[0].invocations[0].cases) {
    ownedCase.config = 'playwright.unknown.config.js';
  }
  assert.match(errorText(validator.validateFunctionalShardContract(unknownConfig, discovered)), /unknown.*config/i);

  const mismatch = clone(contract);
  mismatch.shards[0].invocations[0].cases[0].project = 'wrong-project';
  assert.match(errorText(validator.validateFunctionalShardContract(mismatch, discovered)), /mismatch|disagree/i);
});

validatorTest('single-wave shard runner executes every invocation with isolated Chrome outputs', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const shard = clone(contract.shards.find((candidate) => candidate.name === 'cover-providers'));
  shard.invocations = shard.invocations.slice(0, 2);
  shard.invocations[0].cases = shard.invocations[0].cases.slice(0, 1);
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-functional-shard-'));
  const fixtureWorkRoot = path.join(runnerTemp, 'fixture-work');
  const fixtureRoot = path.join(fixtureWorkRoot, 'shared');
  const sourceFixtureRoot = path.join(runnerTemp, 'downloaded-fixture');
  fs.mkdirSync(path.join(fixtureRoot, 'media'), { recursive: true });
  fs.mkdirSync(path.join(sourceFixtureRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'manifest.json'), '{}', 'utf8');
  const calls = [];
  try {
    const result = validator.runFunctionalShard({ shards: [shard] }, shard.name, {
      repoRoot,
      env: {
        RUNNER_TEMP: runnerTemp,
        ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT: path.join(runnerTemp, 'output'),
        ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT: path.join(runnerTemp, 'blob'),
        ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT: fixtureWorkRoot,
        ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT: sourceFixtureRoot,
        ALBUM_HAVEN_FUNCTIONAL_PORT_BASE: '5200',
        ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
        ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
        MUSIC_DIR: 'C:\\Users\\owner\\Music',
        MUSIC_APP_DATA_DIR: 'C:\\Users\\owner\\AppData',
        MUSIC_CACHE_PATH: 'C:\\Users\\owner\\cache.json',
        MUSIC_COVER_CACHE_PATH: 'C:\\Users\\owner\\covers.json',
        MUSIC_LIBRARY_ROOTS_PATH: 'C:\\Users\\owner\\roots.json',
        PLAYWRIGHT_REAL_APP_URL: 'https://owner-library.example.test',
        DATABASE_MIGRATOR_URL:
          'postgresql://album_haven_migrator_f_123@localhost/album_haven_ci_f_123',
        PLAYWRIGHT_PYTHON: 'fixture-python',
      },
      spawnSyncFn(executable, args, options) {
        calls.push({ executable, args, options });
        return {
          status: args[0].endsWith('run-playwright.cjs') && calls.length === 2 ? 1 : 0,
          signal: null,
        };
      },
    });

    assert.deepEqual(result, { exitCode: 1, signal: null });
    assert.equal(calls.length, 7, 'one final restore and verification clean both mutation authorities');
    const checkpointCalls = calls.filter((call) => call.executable === 'fixture-python');
    const playwrightCalls = calls.filter((call) => call.args[0].endsWith('run-playwright.cjs'));
    const mediaCalls = calls.filter((call) => call.args[0].endsWith('restore-functional-media.cjs'));
    assert.equal(checkpointCalls.length, 3);
    assert.equal(playwrightCalls.length, 2, 'a failed invocation must not hide later shard failures');
    assert.deepEqual(mediaCalls.map((call) => call.args[1]), ['--mode=restore', '--mode=verify']);
    assert.deepEqual(
      checkpointCalls.map((call) => call.args.find((arg) => arg.startsWith('--mode='))),
      ['--mode=capture', '--mode=restore', '--mode=verify'],
    );
    for (const call of checkpointCalls) {
      assert.match(call.args[0], /scripts[\\/]ci[\\/]functional-fixture-checkpoint\.py$/);
      assert.ok(call.args.some((arg) => arg.includes('album_haven_ci_f_123')));
    }
    for (const call of playwrightCalls) {
      assert.equal(call.executable, process.execPath);
      assert.match(call.args[0], /scripts[\\/]run-playwright\.cjs$/);
      assert.ok(call.args.includes('--workers=1'));
      assert.ok(call.args.includes('--browser=chrome'));
      assert.ok(call.args.includes('--headless'));
      assert.ok(call.args.includes('--real-app-port=5200'));
      assert.equal(call.options.cwd, repoRoot);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.env.ALBUM_HAVEN_FIXTURE_PROFILE, 'functional-core');
      assert.equal(call.options.env.ALBUM_HAVEN_FIXTURE_ROOT, fixtureRoot);
      assert.equal(
        call.options.env.ALBUM_HAVEN_MEDIA_ROOT,
        path.join(call.options.env.ALBUM_HAVEN_FIXTURE_ROOT, 'media'),
      );
      assert.equal(call.options.env.PLAYWRIGHT_REAL_APP_PORT, '5200');
      assert.equal(call.options.env.PLAYWRIGHT_PROVIDER_PORT, '5202');
      for (const key of [
        'MUSIC_DIR',
        'MUSIC_APP_DATA_DIR',
        'MUSIC_CACHE_PATH',
        'MUSIC_COVER_CACHE_PATH',
        'MUSIC_LIBRARY_ROOTS_PATH',
        'PLAYWRIGHT_REAL_APP_URL',
      ]) {
        assert.equal(call.options.env[key], '', `${key} must not reach the managed fixture child`);
      }
      assert.ok(call.options.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.startsWith(path.join(runnerTemp, 'blob')));
    }
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

validatorTest('shard runner can isolate one exact owned case for CI diagnosis', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const shard = clone(contract.shards.find((candidate) => candidate.name === 'gallery-search-visual'));
  const focusedCase = shard.invocations
    .flatMap((invocation) => invocation.cases)
    .find((ownedCase) => ownedCase.case.startsWith('FTC-ALBUM-TRACK-CREDITS-001'));
  assert.ok(focusedCase);

  const filtered = validator.filterFunctionalShardCases(shard, [focusedCase.case]);
  assert.equal(filtered.invocations.length, 1);
  assert.deepEqual(filtered.invocations[0].cases.map((ownedCase) => ownedCase.case), [focusedCase.case]);
  assert.throws(
    () => validator.filterFunctionalShardCases(shard, ['FTC-NOT-OWNED']),
    /not owned by functional shard gallery-search-visual/i,
  );
});

validatorTest('shard runner reuses one prepared fixture across three metadata waves', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const shard = clone(contract.shards.find((candidate) => candidate.name === 'metadata-mutations'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-functional-waves-'));
  const fixtureWorkRoot = path.join(runnerTemp, 'fixture-work');
  const fixtureRoot = path.join(fixtureWorkRoot, 'shared');
  const sourceFixtureRoot = path.join(runnerTemp, 'downloaded-fixture');
  fs.mkdirSync(path.join(fixtureRoot, 'media'), { recursive: true });
  fs.mkdirSync(path.join(sourceFixtureRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'manifest.json'), '{}', 'utf8');
  const calls = [];
  let failedOnePlaywright = false;

  try {
    const result = validator.runFunctionalShard({ shards: [shard] }, shard.name, {
      repoRoot,
      caseMatrix: matrix,
      env: {
        RUNNER_TEMP: runnerTemp,
        ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT: path.join(runnerTemp, 'output'),
        ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT: path.join(runnerTemp, 'blob'),
        ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT: fixtureWorkRoot,
        ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT: sourceFixtureRoot,
        ALBUM_HAVEN_FUNCTIONAL_PORT_BASE: '5200',
        ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
        ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
        MUSIC_DIR: 'C:\\Users\\owner\\Music',
        MUSIC_APP_DATA_DIR: 'C:\\Users\\owner\\AppData',
        MUSIC_CACHE_PATH: 'C:\\Users\\owner\\cache.json',
        MUSIC_COVER_CACHE_PATH: 'C:\\Users\\owner\\covers.json',
        MUSIC_LIBRARY_ROOTS_PATH: 'C:\\Users\\owner\\roots.json',
        PLAYWRIGHT_REAL_APP_URL: 'https://owner-library.example.test',
        DATABASE_MIGRATOR_URL:
          'postgresql://album_haven_migrator_f_123@localhost/album_haven_ci_f_123',
        PLAYWRIGHT_PYTHON: 'fixture-python',
      },
      spawnSyncFn(executable, args, options) {
        calls.push({ executable, args, options });
        if (args[0].endsWith('run-playwright.cjs') && !failedOnePlaywright) {
          failedOnePlaywright = true;
          return { status: 1, signal: null };
        }
        return { status: 0, signal: null };
      },
    });

    assert.deepEqual(result, { exitCode: 1, signal: null });
    const checkpointCalls = calls.filter((call) => call.executable === 'fixture-python');
    const playwrightCalls = calls.filter((call) => call.args[0].endsWith('run-playwright.cjs'));
    const mediaCalls = calls.filter((call) => call.args[0].endsWith('restore-functional-media.cjs'));
    assert.equal(checkpointCalls.length, 5);
    assert.deepEqual(
      checkpointCalls.map((call) => call.args.find((arg) => arg.startsWith('--mode='))),
      ['--mode=capture', '--mode=restore', '--mode=restore', '--mode=restore', '--mode=verify'],
    );
    assert.ok(checkpointCalls.every((call) => (
      call.args[0].endsWith(path.join('scripts', 'ci', 'functional-fixture-checkpoint.py'))
      && call.args.some((arg) => arg.includes('album_haven_ci_f_123'))
    )));
    assert.equal(playwrightCalls.length, 6, 'a failed invocation must not hide later waves');
    assert.deepEqual(
      mediaCalls.map((call) => call.args[1]),
      ['--mode=restore', '--mode=restore', '--mode=restore', '--mode=verify'],
    );
    assert.ok(mediaCalls.every((call) => (
      call.args.includes(`--source-media-root=${path.join(sourceFixtureRoot, 'media')}`)
      && call.args.includes(`--writable-media-root=${path.join(fixtureRoot, 'media')}`)
    )));
    assert.ok(calls.every((call) => (
      !call.args.some((arg) => arg.includes('load-fixture-profile.py'))
    )));
    for (const call of playwrightCalls) {
      assert.equal(call.options.env.ALBUM_HAVEN_FIXTURE_ROOT, fixtureRoot);
      assert.equal(call.options.env.ALBUM_HAVEN_MEDIA_ROOT, path.join(fixtureRoot, 'media'));
      assert.ok(call.args.includes('--workers=1'));
      assert.ok(call.args.includes('--browser=chrome'));
      assert.ok(call.options.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.startsWith(path.join(runnerTemp, 'blob')));
    }
    assert.ok(playwrightCalls.every((call) => (
      call.options.env.ALBUM_HAVEN_FUNCTIONAL_BROWSER_WARMUP === '1'
    )), 'every fresh Playwright browser process must receive the read-only warmup');
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test('functional cold-browser warmup is one read-only worker setup rather than per-test shaping', () => {
  const source = fs.readFileSync(baseFixturesPath, 'utf8');
  const helperSource = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'playwright-functional-browser-warmup.mjs'),
    'utf8',
  );
  assert.match(source, /functionalBrowserWarmupFixtures\s*=\s*\([\s\S]*ALBUM_HAVEN_FUNCTIONAL_BROWSER_WARMUP[\s\S]*functionalBrowserWarmup:\s*\[async\s*\(\{\s*browser,[^}]*startupRelationProjectionReadiness/);
  assert.match(source, /process\.env\.ALBUM_HAVEN_FUNCTIONAL_BROWSER_WARMUP\s*===\s*['"]1['"]/);
  assert.match(source, /warmFunctionalBrowser\(/);
  assert.match(helperSource, /browser\.newContext\(/);
  assert.match(helperSource, /#artist-groups \.album-card/);
  assert.match(helperSource, /__ALBUM_HAVEN_STARTUP_METRICS__/);
  assert.match(source, /\{\s*scope:\s*['"]worker['"],\s*auto:\s*true\s*\}/);
});

validatorTest('metadata shard uses one fixture setup with three effect-compatible waves', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const shard = contract.shards.find((candidate) => candidate.name === 'metadata-mutations');
  const waves = validator.executionWavesForShard(shard, matrix);
  const matrixByCase = new Map(matrix.map((row) => [row.case, row]));
  const waveByCase = new Map();

  assert.equal(waves.length, 3);
  assert.deepEqual(waves.map((wave) => wave.wave), [1, 2, 3]);
  for (const wave of waves) {
    const cases = wave.invocations.flatMap((invocation) => invocation.cases);
    const rows = cases.map((ownedCase) => matrixByCase.get(ownedCase.case));
    const databaseIdentities = rows
      .map((row) => row.mutationOwnership?.databaseIdentity)
      .filter(Boolean);
    const filesystemCopies = rows
      .map((row) => row.mutationOwnership?.filesystemCopy)
      .filter(Boolean);
    const globalMutations = rows.filter((row) => row.stateMode === 'global-mutation');
    assert.equal(new Set(databaseIdentities).size, databaseIdentities.length);
    assert.equal(new Set(filesystemCopies).size, filesystemCopies.length);
    assert.ok(globalMutations.length <= 1);
    for (const ownedCase of cases) waveByCase.set(ownedCase.case, wave.wave);
  }
  assert.equal(waveByCase.size, 13);
  for (const caseName of [
    'FTC-TAGS-009 restores tracks from distinct temporary albums without duplicate cards',
    'FTC-TAGS-010 keeps an album-only edit sparse and retains its optimistic split',
  ]) {
    const invocation = waves
      .flatMap((wave) => wave.invocations)
      .find((candidate) => candidate.cases.some((ownedCase) => ownedCase.case === caseName));
    assert.equal(invocation.baselineMode, 'isolated-app-process');
    assert.deepEqual(invocation.cases.map((ownedCase) => ownedCase.case), [caseName]);
  }
  assert.equal(
    waveByCase.get('FTC-TAGS-009 restores tracks from distinct temporary albums without duplicate cards'),
    1,
  );
  assert.equal(
    waveByCase.get('FTC-TAGS-010 keeps an album-only edit sparse and retains its optimistic split'),
    3,
  );
  assert.equal(
    waves[0].invocations[0].cases[0].case,
    'FTC-TAGS-009 restores tracks from distinct temporary albums without duplicate cards',
  );
  assert.equal(
    waves[2].invocations[0].cases[0].case,
    'FTC-TAGS-010 keeps an album-only edit sparse and retains its optimistic split',
  );
  assert.equal(waves[1].invocations.at(-1).baselineMode, 'global-mutation');
  assert.equal(waves[2].invocations.at(-1).baselineMode, 'global-mutation');
  assert.notEqual(
    waveByCase.get('FTC-TAGS-008 completes an album rename before reporting the save task complete'),
    waveByCase.get('FTC-TAGS-008 returns one terminal saved response after optimistic rename persistence'),
  );
  assert.equal(
    waveByCase.get('FTC-ALBUM-TASTE-013 keeps app ratings authoritative while import and scan seed missing ratings'),
    2,
  );
  assert.equal(
    waveByCase.get('FTC-TAGS-013 keeps a year-only edit sparse and retains its optimistic split'),
    3,
  );
  assert.notEqual(
    waveByCase.get('FTC-TAGS-009 restores tracks from distinct temporary albums without duplicate cards'),
    waveByCase.get('FTC-TAGS-015 / FTC-UTIL-PROBLEMS-012 keeps one stable destination through five selected-track moves and restores'),
  );
  assert.notEqual(
    waveByCase.get('FTC-TAGS-022 derives Start at from filename then deterministic editor position'),
    waveByCase.get('FTC-TAGS-022 restarts one consecutive selection for each disc'),
  );
  assert.notEqual(
    waveByCase.get('FTC-ALBUM-TASTE-013 keeps app ratings authoritative while import and scan seed missing ratings'),
    waveByCase.get('FTC-TAGS-013 keeps a year-only edit sparse and retains its optimistic split'),
  );
});

validatorTest('cover baseline-sensitive cases use fresh app processes after shared cleanup-sensitive cases', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const shard = contract.shards.find((candidate) => candidate.name === 'cover-providers');
  const waves = validator.executionWavesForShard(shard, matrix);
  const firstWave = waves[0];
  const secondWave = waves[1];
  const expectedCases = new Set([
    'FTC-COVERS-019 automatic improvement preserves a user-owned cover and clears after gallery open',
    'FTC-COVERS-019 later automatic improvement restores the unseen indicator',
    'FTC-COVERS-019 manual lookup leaves the user-owned cover unchanged before Save',
    'FTC-COVERS-016 lookup matching rejects larger false Metallica releases before provider autoselection',
  ]);
  const isolatedInvocations = waves.flatMap((wave) => wave.invocations).filter(
    (invocation) => invocation.baselineMode === 'isolated-app-process',
  );

  assert.equal(isolatedInvocations.length, 2);
  assert.deepEqual(
    new Set(isolatedInvocations.flatMap((invocation) => invocation.cases.map(({ case: name }) => name))),
    expectedCases,
  );
  assert.deepEqual(
    isolatedInvocations.map((invocation) => invocation.cases.length),
    [2, 2],
  );
  const sharedIndexes = firstWave.invocations
    .map((invocation, index) => invocation.baselineMode === 'shared-setup' ? index : -1)
    .filter((index) => index >= 0);
  const isolatedIndexes = firstWave.invocations
    .map((invocation, index) => invocation.baselineMode === 'isolated-app-process' ? index : -1)
    .filter((index) => index >= 0);
  const globalIndexes = firstWave.invocations
    .map((invocation, index) => invocation.baselineMode === 'global-mutation' ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(Math.max(...sharedIndexes) < Math.min(...isolatedIndexes));
  assert.ok(Math.max(...isolatedIndexes) < Math.min(...globalIndexes));
  assert.equal(secondWave.invocations[0].baselineMode, 'isolated-app-process');
  assert.deepEqual(
    secondWave.invocations[0].cases.map((ownedCase) => ownedCase.case),
    [
      'FTC-COVERS-019 manual lookup leaves the user-owned cover unchanged before Save',
      'FTC-COVERS-016 lookup matching rejects larger false Metallica releases before provider autoselection',
    ],
  );
  assert.equal(secondWave.invocations.at(-1).baselineMode, 'global-mutation');
});

validatorTest('gallery startup projections share one early app process and DDT Studio runs after shared cases', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const shard = contract.shards.find((candidate) => candidate.name === 'gallery-search-visual');
  const waves = validator.executionWavesForShard(shard, matrix);

  assert.equal(waves.length, 2);
  assert.deepEqual(waves.map((wave) => wave.wave), [1, 2]);
  assert.equal(waves[0].invocations.length, 5);
  assert.deepEqual(
    waves.flatMap((wave) => wave.invocations).map((invocation) => invocation.baselineMode),
    [
      'isolated-app-process',
      'shared-setup',
      'isolated-app-process',
      'isolated-app-process',
      'isolated-app-process',
      'isolated-app-process',
    ],
  );
  assert.deepEqual(
    waves[0].invocations[0].cases.map((ownedCase) => ownedCase.case),
    [
      'FTC-SEARCH-NAV-020 resolves punctuation-credit aliases through startup and keeps both raw credits',
      'FTC-SEARCH-NAV-021 keeps empty normalized artist keys isolated',
      'FTC-SEARCH-NAV-022 starts with a collapsed scan identity and browses its repeated-space artist family',
      'FTC-ARTIST-FAMILY-015 excludes compilation track credits from family relations while keeping ordinary shared releases related',
    ],
  );
  assert.deepEqual(
    waves[0].invocations[2].cases.map((ownedCase) => ownedCase.case),
    ['FTC-COVERS-014 keeps a decoded gallery cover stable across real gallery interactions'],
  );
  assert.deepEqual(
    waves[0].invocations[3].cases.map((ownedCase) => ownedCase.case),
    ['FTC-COVERS-015 shows the exact Joseph 2023 cover decoded in the card, modal, and fullscreen lightbox'],
  );
  assert.deepEqual(
    waves[0].invocations[4].cases.map((ownedCase) => ownedCase.case),
    ['FTC-SEARCH-NAV-002 keeps every projected family artist in the tree for a non-exact best match'],
  );
  assert.deepEqual(
    waves[1].invocations[0].cases.map((ownedCase) => ownedCase.case),
    ['FTC-TAGS-020 keeps the 60-album DDT gallery stable through Studio Records splits and restores'],
  );
});

validatorTest('playback uses three shared baselines and isolates conflicting exclusion mutations', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const shard = contract.shards.find((candidate) => candidate.name === 'playback-utilities');
  const waves = validator.executionWavesForShard(shard, matrix);

  assert.deepEqual(waves.map((wave) => wave.wave), [1, 2, 3]);
  assert.deepEqual(
    waves[0].invocations.flatMap((invocation) => invocation.cases.map(({ case: name }) => name)),
    [
      'FTC-UTIL-PROBLEMS-011 hides dead problem actions for a generated excluded album',
      'FTC-UTIL-PROBLEMS-011 opens the exact problematic track from album details',
      'FTC-UTIL-PROBLEMS-001 scopes exclusions with optimistic persistence and reload',
      'FTC-TAGS-024 completes a verified Album and Exception intent during app restart',
    ],
  );
  assert.deepEqual(
    waves[2].invocations.flatMap((invocation) => invocation.cases.map(({ case: name }) => name)),
    ['FTC-UTIL-PROBLEMS-001 rolls back failed exclusion creation and reversion'],
  );
  const ordinaryInvocationIndex = waves[1].invocations.findIndex(
    (invocation) => invocation.config === 'playwright.config.js'
      && invocation.baselineMode === 'shared-setup',
  );
  const expiryInvocationIndex = waves[1].invocations.findIndex(
    (invocation) => invocation.config === 'playwright.config.js'
      && invocation.baselineMode === 'isolated-app-process'
      && invocation.cases.some(({ case: name }) => name.includes('loop creation expires')),
  );
  assert.ok(ordinaryInvocationIndex >= 0);
  assert.ok(expiryInvocationIndex > ordinaryInvocationIndex);
  assert.deepEqual(
    waves[1].invocations[expiryInvocationIndex].cases.map(({ case: name }) => name),
    [
      'FTC-PLAYER-017 / FTC-UTIL-LOOPS-024 loop creation expires through the shared production session controller',
      'FTC-PLAYER-017 / FTC-UTIL-LOOPS-024 page reload exits bottom-player loop edit mode',
      'FTC-PLAYER-017 / FTC-UTIL-LOOPS-024 returning to a suspended tab reconciles an overdue loop edit lease',
    ],
  );
  const lateNonAlbumInvocation = waves[1].invocations.find(
    (invocation) => invocation.baselineMode === 'isolated-app-process'
      && invocation.cases.some(({ case: name }) => name.includes('clears Album durably')),
  );
  assert.deepEqual(
    lateNonAlbumInvocation?.cases.map(({ case: name }) => name),
    [
      'FTC-NON-ALBUM-012 renders exception groups as the approved compact track table',
      'FTC-NON-ALBUM-011 permits a nonempty Album rename from post-rarity Problematic Files',
      'FTC-NON-ALBUM-014 clears Album durably and refreshes Problematic Files',
      'FTC-TAGS-004 and FTC-NON-ALBUM-014 preserve rapid Album and Exception edits across gallery transitions',
      'FTC-NON-ALBUM-010 / FTC-NON-ALBUM-009 / FTC-NON-ALBUM-008 / FTC-NON-ALBUM-007 / FTC-NON-ALBUM-006 / FTC-TAGS-007 / FTC-NON-ALBUM-005 keeps rarity modal transitions and sibling album state canonical',
    ],
  );
  const failedSaveRetryInvocation = waves[1].invocations.find(
    (invocation) => invocation.baselineMode === 'isolated-app-process'
      && invocation.cases.some(({ case: name }) => name.includes('failed tag saves preserve')),
  );
  assert.deepEqual(
    failedSaveRetryInvocation?.cases.map(({ case: name }) => name),
    ['FTC-TAGS-023 failed tag saves preserve the source modal for a successful retry'],
  );
  const rescanInvocationIndex = waves[1].invocations.findIndex(
    (invocation) => invocation.config === 'playwright.non-album-rescan.config.js',
  );
  assert.ok(rescanInvocationIndex > ordinaryInvocationIndex);
  assert.deepEqual(
    waves[1].invocations[rescanInvocationIndex].cases.map(({ case: name }) => name),
    ['FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details'],
  );
});

validatorTest('all four shards use explicit effect-compatible wave budgets', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const expected = new Map([
    ['gallery-search-visual', { cases: 35, waves: [1, 2] }],
    ['cover-providers', { cases: 18, waves: [1, 2] }],
    ['metadata-mutations', { cases: 13, waves: [1, 2, 3] }],
    ['playback-utilities', { cases: 25, waves: [1, 2, 3] }],
  ]);
  const matrixByCase = new Map(matrix.map((row) => [row.case, row]));

  for (const shard of contract.shards) {
    const budget = expected.get(shard.name);
    const waves = validator.executionWavesForShard(shard, matrix);
    assert.deepEqual(waves.map((wave) => wave.wave), budget.waves);
    assert.equal(
      waves.flatMap((wave) => wave.invocations.flatMap((invocation) => invocation.cases)).length,
      budget.cases,
    );
    for (const wave of waves) {
      const ordered = wave.invocations.flatMap((invocation) => invocation.cases);
      const rows = ordered.map((ownedCase) => matrixByCase.get(ownedCase.case));
      assert.ok(rows.every((row) => (
        row.setupScope !== 'isolated' || Number.isInteger(row.executionWave)
      )));
      assert.ok(rows.filter((row) => row.stateMode === 'global-mutation').length <= 1);
      const globalIndex = rows.findIndex((row) => row.stateMode === 'global-mutation');
      assert.ok(globalIndex === -1 || globalIndex === rows.length - 1);
    }
  }
  assert.doesNotMatch(
    String(validator.runFunctionalShard),
    /hasCompleteWaveAssignment/,
  );
});

validatorTest('read-only shard cases reuse one prepared fixture and restore once after the shard', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const matrix = readJson(path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json'));
  const matrixByCase = new Map(matrix.map((row) => [row.case, row]));
  const sourceShard = contract.shards.find((candidate) => candidate.name === 'gallery-search-visual');
  const readOnlyCases = sourceShard.invocations
    .flatMap((invocation) => invocation.cases.map((ownedCase) => ({ invocation, ownedCase })))
    .filter(({ ownedCase }) => {
      const row = matrixByCase.get(ownedCase.case);
      return row.setupScope === 'suite' && row.stateMode === 'read-only';
    })
    .slice(0, 2);
  const shard = {
    ...sourceShard,
    invocations: readOnlyCases.map(({ invocation, ownedCase }) => ({
      config: invocation.config,
      project: invocation.project,
      workers: 1,
      cases: [ownedCase],
    })),
  };
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-functional-read-only-'));
  const fixtureWorkRoot = path.join(runnerTemp, 'fixture-work');
  const fixtureRoot = path.join(fixtureWorkRoot, 'shared');
  const sourceFixtureRoot = path.join(runnerTemp, 'downloaded-fixture');
  fs.mkdirSync(path.join(fixtureRoot, 'media'), { recursive: true });
  fs.mkdirSync(path.join(sourceFixtureRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'manifest.json'), '{}', 'utf8');
  const calls = [];

  try {
    const result = validator.runFunctionalShard({ shards: [shard] }, shard.name, {
      repoRoot,
      caseMatrix: matrix,
      env: {
        RUNNER_TEMP: runnerTemp,
        ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT: path.join(runnerTemp, 'output'),
        ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT: path.join(runnerTemp, 'blob'),
        ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT: fixtureWorkRoot,
        ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT: sourceFixtureRoot,
        ALBUM_HAVEN_FUNCTIONAL_PORT_BASE: '5300',
        ALBUM_HAVEN_FIXTURE_ROOT: fixtureRoot,
        ALBUM_HAVEN_MEDIA_ROOT: path.join(fixtureRoot, 'media'),
        DATABASE_MIGRATOR_URL:
          'postgresql://album_haven_migrator_f_456@localhost/album_haven_ci_f_456',
        PLAYWRIGHT_PYTHON: 'fixture-python',
      },
      spawnSyncFn(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0, signal: null };
      },
    });

    assert.deepEqual(result, { exitCode: 0, signal: null });
    const checkpointCalls = calls.filter((call) => call.executable === 'fixture-python');
    const playwrightCalls = calls.filter((call) => call.args[0].endsWith('run-playwright.cjs'));
    const mediaCalls = calls.filter((call) => call.args[0].endsWith('restore-functional-media.cjs'));
    assert.deepEqual(
      checkpointCalls.map((call) => call.args.find((arg) => arg.startsWith('--mode='))),
      ['--mode=capture', '--mode=restore', '--mode=verify'],
    );
    assert.equal(playwrightCalls.length, 1);
    assert.deepEqual(
      mediaCalls.map((call) => call.args[1]),
      ['--mode=restore', '--mode=verify'],
    );
    assert.equal(playwrightCalls[0].options.env.ALBUM_HAVEN_FIXTURE_ROOT, fixtureRoot);
    assert.deepEqual(
      playwrightCalls[0].args.filter((arg) => arg.startsWith('tests/e2e/')),
      [...new Set(readOnlyCases.map(({ ownedCase }) => ownedCase.test))],
    );
    const grepIndex = playwrightCalls[0].args.indexOf('--grep');
    assert.notEqual(grepIndex, -1);
    const titlePattern = playwrightCalls[0].args[grepIndex + 1];
    assert.ok(readOnlyCases.every(({ ownedCase }) => new RegExp(titlePattern).test(ownedCase.case)));
  } finally {
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  }
});

validatorTest('shard runner rejects missing or root-level output ownership', () => {
  const validator = loadValidator();
  const contract = readJson(shardContractPath);
  const runnerTemp = path.join(os.tmpdir(), 'album-haven-functional-owner');
  const baseEnv = {
    RUNNER_TEMP: runnerTemp,
    ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT: path.join(runnerTemp, 'output'),
    ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT: path.join(runnerTemp, 'blob'),
    ALBUM_HAVEN_FUNCTIONAL_PORT_BASE: '5200',
  };

  assert.throws(
    () => validator.runFunctionalShard(contract, 'gallery-search-visual', {
      repoRoot,
      env: { ...baseEnv, ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT: '' },
    }),
    /non-root child of RUNNER_TEMP/,
  );
  assert.throws(
    () => validator.runFunctionalShard(contract, 'gallery-search-visual', {
      repoRoot,
      env: { ...baseEnv, ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT: runnerTemp },
    }),
    /non-root child of RUNNER_TEMP/,
  );
});

test('functional workflow uses the approved four-entry Windows matrix with isolated names and ports', () => {
  const { workflow, job } = functionalJobSource();
  assert.match(job, /name:\s*["']E2E:\s*\$\{\{\s*matrix\.displayName\s*\}\}["']/);
  assert.match(workflow, /e2e_production_parity:\s*\r?\n\s+name:\s*["']E2E:\s*Production Parity["']/);
  assert.match(job, /runs-on:\s*windows-2025/);
  assert.match(job, /fail-fast:\s*false/);
  assert.match(job, /max-parallel:\s*([1-4])\b/);
  assert.doesNotMatch(job, /--browser(?:=|\s+)edge\b/i);
  assert.doesNotMatch(job, /if:\s*\$\{\{\s*false\s*\}\}|if:\s*false/);

  const matrix = parseFunctionalMatrix(job);
  assert.deepEqual(matrix.map((entry) => entry.shard), [...EXPECTED_SHARD_COUNTS.keys()]);
  assert.deepEqual(
    matrix.map((entry) => entry.displayName),
    [...EXPECTED_SHARD_DISPLAY_NAMES.values()],
  );
  assert.deepEqual(matrix.map((entry) => Number(entry.expectedCases)), [...EXPECTED_SHARD_COUNTS.values()]);
  for (const field of ['portBase', 'outputDir', 'blobName']) {
    const values = matrix.map((entry) => entry[field]);
    assert.ok(values.every(Boolean), `every functional matrix row must define ${field}`);
    assert.equal(new Set(values).size, 4, `${field} must be unique per functional shard`);
  }
  assert.ok(matrix.every((entry) => Number(entry.portBase) > 1024));
  assert.match(job, /validate-functional-shards\.cjs\s+--run-shard=\$\{\{\s*matrix\.shard\s*\}\}/);
  assert.match(job, /ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT/);
  assert.match(job, /album-haven-e2e-functional-fixtures-/);
  assert.match(job, /playback-utilities/);
});

test('PR gates trigger only for pull requests and never expose heavy jobs to forked code', () => {
  const { workflow, job } = functionalJobSource();
  const triggerSource = workflow.slice(0, workflow.indexOf('\njobs:'));
  assert.match(triggerSource, /^on:\r?\n\s+pull_request:/m);
  assert.doesNotMatch(triggerSource, /^\s+(?:push|schedule|workflow_dispatch):/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(
    job,
    /if:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\s*\}\}/,
  );
});

test('functional workflow pins fixture and toolchain safety before one-worker execution', () => {
  const { workflow, job } = functionalJobSource();
  assert.match(job, new RegExp(FIXTURE_RELEASE.replaceAll('.', '\\.')));
  assert.match(job, new RegExp(FIXTURE_MANIFEST_SHA256));
  assert.match(job, /ExpectedMajorVersion(?:\s+|:\s*)17\b/);
  assert.match(job, /bootstrap-windows-postgres\.ps1[\s\S]*?(?:Provision|-Mode\s+Provision)/i);
  assert.match(
    job,
    /PLAYWRIGHT_PROVIDER_PORT[\s\S]*?matrix\.portBase[\s\S]*?\+\s*2[\s\S]*?bootstrap-windows-postgres\.ps1/i,
    'fixture loading must bind provider snapshot URLs to the job-owned provider port',
  );
  assert.match(job, /load-fixture-profile\.py/);
  assert.match(job, /bootstrap-windows-postgres\.ps1[\s\S]*?(?:Teardown|-Mode\s+Teardown)/i);
  assert.match(job, /validate-functional-shards\.cjs/);
  assert.match(job, /browser-actions\/setup-chrome@v2/);
  assert.match(job, /chrome-version:\s*["']151\.0\.7922\.138["']/);
  assert.match(job, /steps\.setup_functional_chrome\.outputs\.chrome-path/);
  assert.match(job, /PLAYWRIGHT_CHROME_EXECUTABLE/);
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test('functional workflow prepares one writable shared fixture before PostgreSQL projection', () => {
  const { job } = functionalJobSource();
  const prepareStep = job.match(
    /- name:\s*Prepare writable functional fixture[\s\S]*?(?=\n\s+- name:)/i,
  )?.[0] || '';
  assert.ok(prepareStep, 'writable fixture preparation step is required');
  assert.ok(job.indexOf(prepareStep) < job.indexOf('- name: Provision functional PostgreSQL'));
  assert.match(prepareStep, /ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT/);
  assert.match(prepareStep, /ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT=\$sourceRoot/);
  assert.match(prepareStep, /Join-Path\s+\$workRoot\s+["']shared["']/);
  assert.match(prepareStep, /Copy-Item[\s\S]*?-Recurse/);
  assert.match(prepareStep, /manifest\.json/);
  assert.match(prepareStep, /Join-Path\s+\$(?:sourceRoot|sharedRoot)\s+["']database["']/);
  assert.match(prepareStep, /Join-Path\s+\$(?:sourceRoot|sharedRoot)\s+["']media["']/);
  assert.match(prepareStep, /ALBUM_HAVEN_FIXTURE_ROOT=/);
  assert.match(prepareStep, /ALBUM_HAVEN_MEDIA_ROOT=/);
  assert.equal((job.match(/Prepare writable functional fixture/g) || []).length, 1);
});

test('functional workflow fetches the exact read-only fixture through a trusted base-revision downloader', () => {
  const { job } = functionalJobSource();
  const jobHeader = job.split(/\r?\n    steps:/, 1)[0];
  assert.equal((job.match(/secrets\.ALBUM_HAVEN_FIXTURES_TOKEN/g) || []).length, 1);
  assert.doesNotMatch(jobHeader, /ALBUM_HAVEN_FIXTURES_TOKEN/);
  const trustedCheckout = job.match(
    /- name:\s*Checkout trusted fixture downloader[\s\S]*?(?=\n\s+- name:)/i,
  )?.[0] || '';
  assert.match(trustedCheckout, /uses:\s*actions\/checkout@v5/);
  assert.match(trustedCheckout, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
  assert.match(trustedCheckout, /path:\s*\.trusted-ci\b/);
  assert.match(trustedCheckout, /persist-credentials:\s*false/);

  const fetchStep = job.match(/- name:\s*Fetch functional fixture[\s\S]*?(?=\n\s+- name:)/i)?.[0] || '';
  assert.match(fetchStep, /ALBUM_HAVEN_FIXTURES_TOKEN:\s*\$\{\{\s*secrets\.ALBUM_HAVEN_FIXTURES_TOKEN\s*\}\}/);
  assert.match(fetchStep, /\.trusted-ci[\\/]scripts[\\/]ci[\\/]fetch-test-fixtures\.ps1/);
  assert.match(fetchStep, new RegExp(`-Release\\s+['"]?${FIXTURE_RELEASE.replaceAll('.', '\\.')}['"]?`));
  assert.match(fetchStep, /-Profile\s+['"]?functional-core['"]?/);
  assert.match(fetchStep, new RegExp(`-ManifestSha256\\s+['"]?${FIXTURE_MANIFEST_SHA256}['"]?`));
  assert.doesNotMatch(fetchStep, /(?:Invoke-RestMethod|gh\s+api)[^\r\n]*(?:-Method|--method)\s+(?:POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(job.slice(job.indexOf(fetchStep) + fetchStep.length), /ALBUM_HAVEN_FIXTURES_TOKEN/);
});

test('functional workflow teardown consumes the exact provision receipt for its shard', () => {
  const { job } = functionalJobSource();
  const statePaths = [...job.matchAll(/-StatePath\s+([^\r\n]+)/g)].map((match) => match[1].trim());
  assert.equal(statePaths.length, 2, 'Provision and Teardown must each receive the state receipt');
  assert.equal(statePaths[0], statePaths[1]);
  assert.match(statePaths[0], /runner\.temp/);
  assert.match(statePaths[0], /matrix\.shard/);
  assert.match(job, /-Mode\s+Provision[\s\S]*?-StatePath/);
  assert.match(job, /-Mode\s+Teardown[\s\S]*?-StatePath/);
});

test('all functional configs route functional-core through the preloaded preserved baseline', () => {
  const runnerSource = fs.readFileSync(runnerPath, 'utf8');
  const isolatedSource = fs.readFileSync(isolatedAppPath, 'utf8');
  const runner = require(runnerPath)._private;
  const previousProfile = process.env.ALBUM_HAVEN_FIXTURE_PROFILE;
  process.env.ALBUM_HAVEN_FIXTURE_PROFILE = 'functional-core';
  try {
    for (const config of EXPECTED_FUNCTIONAL_CONFIGS) {
      assert.equal(
        runner.resolveManagedFixtureProfile([`--config=${config}`]),
        'functional-core',
        `${config} must select functional-core`,
      );
    }
  } finally {
    if (previousProfile === undefined) {
      delete process.env.ALBUM_HAVEN_FIXTURE_PROFILE;
    } else {
      process.env.ALBUM_HAVEN_FIXTURE_PROFILE = previousProfile;
    }
  }
  assert.match(runnerSource, /preservesPreloadedDatabase:\s*Boolean\(resolveManagedFixtureProfile\(passthroughArgv\)\)/);
  assert.match(isolatedSource, /PRELOADED_FIXTURE_PROFILES\s*=\s*frozenset\([\s\S]{0,180}?["']functional-core["']/);
  assert.match(isolatedSource, /if\s+is_preloaded_fixture:[\s\S]{0,180}?configure_preloaded_fixture\(\)/);
  assert.match(isolatedSource, /if\s+not\s+is_preloaded_fixture\s+and\s+not\s+reuse_state:/);
});

test('allowed-autoplay functional config selects installed Chrome rather than bundled Chromium', () => {
  const source = fs.readFileSync(autoplayConfigPath, 'utf8');
  assert.match(source, /browserName:\s*['"]chromium['"]/);
  assert.match(
    source,
    /channel:\s*baseProject\.use\.launchOptions\?\.executablePath\s*\?\s*undefined\s*:\s*['"]chrome['"]/,
  );
  assert.match(source, /\.\.\.baseProject\.use\.launchOptions/);
});

test('functional workflow retains blobs always and debug evidence only for failed runners', () => {
  const { job } = functionalJobSource();
  const uploads = [...job.matchAll(/- name:\s*Upload functional (blob|debug)[\s\S]*?(?=\n\s+- name:|$)/gi)];
  assert.equal(uploads.length, 2);
  const byKind = Object.fromEntries(uploads.map((match) => [match[1].toLowerCase(), match[0]]));
  for (const source of Object.values(byKind)) {
    assert.match(source, /uses:\s*actions\/upload-artifact@v4/);
    assert.match(source, /if-no-files-found:\s*error/);
    assert.match(source, /\$\{\{\s*matrix\.blobName\s*\}\}|\$\{\{\s*matrix\.shard\s*\}\}/);
  }
  assert.match(byKind.blob, /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/);
  assert.match(byKind.debug, /if:\s*\$\{\{\s*failure\(\)\s*&&\s*!cancelled\(\)\s*\}\}/);
  assert.match(byKind.blob, /retention-days:\s*14\b/);
  assert.match(byKind.debug, /retention-days:\s*7\b/);
});
