const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_CONFIGS = Object.freeze([
  'playwright.config.js',
  'playwright.autoplay-allowed.config.js',
  'playwright.cover-rescan.config.js',
  'playwright.lastfm-auto-timezone.config.js',
  'playwright.non-album-rescan.config.js',
]);
const EXPECTED_SHARDS = Object.freeze([
  ['gallery-search-visual', 35],
  ['cover-providers', 18],
  ['metadata-mutations', 13],
  ['playback-utilities', 25],
]);
const OWNER_RUNTIME_ENV_KEYS = Object.freeze([
  'MUSIC_DIR',
  'MUSIC_APP_DATA_DIR',
  'MUSIC_CACHE_PATH',
  'MUSIC_COVER_CACHE_PATH',
  'MUSIC_LIBRARY_ROOTS_PATH',
  'PLAYWRIGHT_REAL_APP_URL',
]);

function normalizeTestPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function comparisonTestPath(value) {
  return normalizeTestPath(value).replace(/^tests\/e2e\/specs\//, '');
}

function caseKey(value) {
  return [value.config, value.project, comparisonTestPath(value.test), value.case]
    .map((part) => String(part || '').trim())
    .join('\u0000');
}

function parseListOutput(output, config) {
  const cases = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s+›\s+(.+?):\d+:\d+\s+›\s+(.+?)\s*$/);
    if (!match) continue;
    cases.push({
      config,
      project: match[1].trim(),
      test: normalizeTestPath(match[2].trim()),
      case: match[3].trim(),
    });
  }
  return cases;
}

function discoverFunctionalCases(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const cliPath = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const discovered = [];
  for (const config of EXPECTED_CONFIGS) {
    const result = spawnSyncFn(
      process.execPath,
      [cliPath, 'test', '--list', '--reporter=line', `--config=${config}`],
      {
        cwd: repoRoot,
        env: { ...process.env, PLAYWRIGHT_MANAGED_APP: '1' },
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    if (result.error || result.signal || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
      throw new Error(`Playwright discovery failed for ${config}${detail ? `: ${detail}` : '.'}`);
    }
    discovered.push(...parseListOutput(result.stdout, config));
  }
  return discovered;
}

function flattenOwnedCases(contract) {
  return (contract.shards || []).flatMap((shard) => (
    (shard.invocations || []).flatMap((invocation) => (
      (invocation.cases || []).map((ownedCase) => ({
        ...ownedCase,
        shard: shard.name,
        invocationConfig: invocation.config,
        invocationProject: invocation.project,
        invocationWorkers: invocation.workers,
      }))
    ))
  ));
}

function duplicateKeys(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    const key = caseKey(value);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

function validateFunctionalShardContract(contract, discoveredCases) {
  const errors = [];
  if (contract?.schemaVersion !== 1) errors.push('functional shard schemaVersion must be 1');
  if (contract?.browser !== 'chrome') errors.push('functional shard browser must be Chrome');
  if (contract?.workersPerInvocation !== 1) errors.push('functional shard workers must be 1');
  if (contract?.approvalGate?.gate !== 6 || contract?.approvalGate?.status !== 'approved') {
    errors.push('functional shard Gate 6 must be approved');
  }

  const shards = Array.isArray(contract?.shards) ? contract.shards : [];
  const expectedNames = EXPECTED_SHARDS.map(([name]) => name);
  if (JSON.stringify(shards.map((shard) => shard.name)) !== JSON.stringify(expectedNames)) {
    errors.push('functional shards must use the exact approved four-shard order');
  }
  for (const [name, expectedCount] of EXPECTED_SHARDS) {
    const shard = shards.find((candidate) => candidate.name === name);
    if (!shard || !Array.isArray(shard.invocations) || shard.invocations.length === 0) {
      errors.push(`functional shard ${name} must not be empty`);
      continue;
    }
    if (shard.fixtureProfile !== 'functional-core') {
      errors.push(`functional shard ${name} must use functional-core`);
    }
    if (!Array.isArray(shard.suitePrerequisites) || shard.suitePrerequisites.length === 0) {
      errors.push(`functional shard ${name} must declare prerequisites`);
    }
    const count = shard.invocations.flatMap((invocation) => invocation.cases || []).length;
    if (count !== expectedCount) {
      errors.push(`functional shard ${name} owns ${count} cases; expected ${expectedCount}`);
    }
  }

  const owned = flattenOwnedCases(contract || {});
  for (const ownedCase of owned) {
    if (!EXPECTED_CONFIGS.includes(ownedCase.invocationConfig)) {
      errors.push(`unknown functional config: ${ownedCase.invocationConfig}`);
    }
    if (
      ownedCase.config !== ownedCase.invocationConfig
      || ownedCase.project !== ownedCase.invocationProject
    ) {
      errors.push(`case and invocation config/project disagree: ${ownedCase.case}`);
    }
    if (ownedCase.invocationWorkers !== 1) {
      errors.push(`functional invocation must use one worker: ${ownedCase.invocationConfig}`);
    }
    if (
      ownedCase.invocationConfig === 'playwright.autoplay-allowed.config.js'
      && ownedCase.shard !== 'playback-utilities'
    ) {
      errors.push('autoplay-allowed coverage must belong only to playback-utilities');
    }
  }

  const ownedDuplicates = duplicateKeys(owned);
  if (ownedDuplicates.size > 0) errors.push('duplicate functional case ownership detected');
  const discovered = Array.isArray(discoveredCases) ? discoveredCases : [];
  const discoveredDuplicates = duplicateKeys(discovered);
  if (discoveredDuplicates.size > 0) errors.push('duplicate Playwright functional discovery detected');

  const ownedKeys = new Set(owned.map(caseKey));
  const discoveredKeys = new Set(discovered.map(caseKey));
  for (const key of discoveredKeys) {
    if (!ownedKeys.has(key)) errors.push(`unassigned discovered functional case: ${key.replaceAll('\u0000', ' | ')}`);
  }
  for (const key of ownedKeys) {
    if (!discoveredKeys.has(key)) errors.push(`orphan or unknown owned functional case: ${key.replaceAll('\u0000', ' | ')}`);
  }
  if (owned.length !== 91) errors.push(`functional contract owns ${owned.length} cases; expected 91`);
  return errors;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertRunnerTempChild(candidatePath, runnerTemp, label) {
  const rawRoot = String(runnerTemp || '').trim();
  const rawCandidate = String(candidatePath || '').trim();
  if (!rawRoot || !rawCandidate) {
    throw new Error(`${label} must be a non-root child of RUNNER_TEMP`);
  }
  const resolvedRoot = path.resolve(rawRoot);
  const resolvedCandidate = path.resolve(rawCandidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === ''
    || relative.startsWith('..')
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a non-root child of RUNNER_TEMP`);
  }
  return resolvedCandidate;
}

function loadFunctionalCaseMatrix(repoRoot) {
  const matrixPath = path.join(repoRoot, 'tests', 'ci', 'test-data-matrix.json');
  const rows = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('functional test-data matrix must be an array');
  return rows;
}

function executionWavesForShard(shard, matrixRows) {
  const matrixByCase = new Map(matrixRows.map((row) => [caseKey(row), row]));
  const waves = new Map();
  for (const invocation of shard.invocations || []) {
    for (const ownedCase of invocation.cases || []) {
      const normalizedCase = {
        ...ownedCase,
        config: invocation.config,
        project: invocation.project,
      };
      const matrixRow = matrixByCase.get(caseKey(normalizedCase));
      if (!matrixRow) {
        throw new Error(`functional case is missing from the test-data matrix: ${ownedCase.case}`);
      }
      const isReadOnly = matrixRow.setupScope === 'suite' && matrixRow.stateMode === 'read-only';
      const isIsolated = matrixRow.setupScope === 'isolated';
      if (!isReadOnly && !isIsolated) {
        throw new Error(
          `functional case must be suite/read-only or isolated: ${ownedCase.case}`,
        );
      }
      const waveNumber = isReadOnly ? 1 : Number(matrixRow.executionWave);
      if (!Number.isInteger(waveNumber) || waveNumber < 1 || waveNumber > 3) {
        throw new Error(
          `isolated functional case requires executionWave 1 through 3: ${ownedCase.case}`,
        );
      }
      let wave = waves.get(waveNumber);
      if (!wave) {
        wave = { wave: waveNumber, invocations: [], invocationByKey: new Map(), rows: [] };
        waves.set(waveNumber, wave);
      }
      const isGlobalMutation = matrixRow.stateMode === 'global-mutation';
      const setupGroup = String(matrixRow.setupGroup || '').trim();
      const appProcessScope = String(matrixRow.appProcessScope || '').trim();
      if (appProcessScope && appProcessScope !== 'isolated') {
        throw new Error(`functional case has an unsupported appProcessScope: ${ownedCase.case}`);
      }
      const isIsolatedAppProcess = appProcessScope === 'isolated';
      const appProcessOrder = String(matrixRow.appProcessOrder || '').trim();
      if (appProcessOrder && !['before-shared', 'after-shared'].includes(appProcessOrder)) {
        throw new Error(`functional case has an unsupported appProcessOrder: ${ownedCase.case}`);
      }
      if (appProcessOrder && !isIsolatedAppProcess) {
        throw new Error(`functional case appProcessOrder requires isolated appProcessScope: ${ownedCase.case}`);
      }
      const invocationKey = [
        invocation.config,
        invocation.project,
        isGlobalMutation
          ? ownedCase.case
          : isIsolatedAppProcess ? setupGroup || ownedCase.case : 'compatible',
      ].join('\0');
      let groupedInvocation = wave.invocationByKey.get(invocationKey);
      if (!groupedInvocation) {
        groupedInvocation = {
          config: invocation.config,
          project: invocation.project,
          workers: 1,
          baselineMode: isGlobalMutation
            ? 'global-mutation'
            : isIsolatedAppProcess ? 'isolated-app-process' : 'shared-setup',
          appProcessOrder: isIsolatedAppProcess ? appProcessOrder || 'before-shared' : null,
          cases: [],
        };
        wave.invocationByKey.set(invocationKey, groupedInvocation);
        wave.invocations.push(groupedInvocation);
      }
      groupedInvocation.cases.push(ownedCase);
      wave.rows.push(matrixRow);
    }
  }

  const orderedWaves = [...waves.values()].sort((left, right) => left.wave - right.wave);
  for (const wave of orderedWaves) {
    const globalMutations = wave.rows.filter((row) => row.stateMode === 'global-mutation');
    if (globalMutations.length > 1) {
      throw new Error(`functional execution wave ${wave.wave} contains multiple global mutations`);
    }
    for (const ownershipField of ['databaseIdentity', 'filesystemCopy']) {
      const identities = wave.rows
        .map((row) => row.mutationOwnership?.[ownershipField])
        .filter(Boolean);
      if (new Set(identities).size !== identities.length) {
        throw new Error(
          `functional execution wave ${wave.wave} reuses mutation ownership ${ownershipField}`,
        );
      }
    }
    const invocationRank = (invocation) => {
      if (invocation.baselineMode === 'isolated-app-process') {
        return invocation.appProcessOrder === 'after-shared' ? 2 : 0;
      }
      return ({
        'shared-setup': 1,
        'global-mutation': 3,
      }[invocation.baselineMode] ?? 4);
    };
    wave.invocations.sort((left, right) => invocationRank(left) - invocationRank(right));
    delete wave.invocationByKey;
    delete wave.rows;
  }
  return orderedWaves;
}

function runFunctionalShard(contract, shardName, options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const env = { ...(options.env || process.env) };
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const ownedShard = (contract.shards || []).find((candidate) => candidate.name === shardName);
  if (!ownedShard) throw new Error(`Unknown functional shard: ${shardName}`);
  const shard = filterFunctionalShardCases(ownedShard, options.focusedCases);
  const caseMatrix = options.caseMatrix || loadFunctionalCaseMatrix(repoRoot);
  const executionWaves = executionWavesForShard(shard, caseMatrix);
  const outputRoot = assertRunnerTempChild(
    env.ALBUM_HAVEN_FUNCTIONAL_OUTPUT_ROOT,
    env.RUNNER_TEMP,
    'functional output root',
  );
  const blobRoot = assertRunnerTempChild(
    env.ALBUM_HAVEN_FUNCTIONAL_BLOB_ROOT,
    env.RUNNER_TEMP,
    'functional blob root',
  );
  const fixtureWorkRoot = assertRunnerTempChild(
    env.ALBUM_HAVEN_FUNCTIONAL_FIXTURE_WORK_ROOT,
    env.RUNNER_TEMP,
    'functional fixture work root',
  );
  const immutableFixtureRoot = assertRunnerTempChild(
    env.ALBUM_HAVEN_FUNCTIONAL_SOURCE_FIXTURE_ROOT,
    env.RUNNER_TEMP,
    'functional source fixture root',
  );
  const sourceFixtureRoot = path.resolve(String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim());
  if (!String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim()
    || !fs.statSync(sourceFixtureRoot, { throwIfNoEntry: false })?.isDirectory()
    || !fs.statSync(path.join(sourceFixtureRoot, 'media'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('functional source fixture root and media directory must exist');
  }
  const expectedFixtureRoot = path.resolve(path.join(fixtureWorkRoot, 'shared'));
  if (sourceFixtureRoot !== expectedFixtureRoot) {
    throw new Error('functional fixture root must be the prepared shared work fixture');
  }
  if (immutableFixtureRoot === sourceFixtureRoot
    || !fs.statSync(path.join(immutableFixtureRoot, 'media'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('functional immutable source fixture must be distinct and contain media');
  }
  const databaseUrl = String(env.DATABASE_MIGRATOR_URL || '').trim();
  const pythonExecutable = String(env.PLAYWRIGHT_PYTHON || '').trim();
  if (!databaseUrl || !pythonExecutable) {
    throw new Error('functional fixture reload requires DATABASE_MIGRATOR_URL and PLAYWRIGHT_PYTHON');
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.mkdirSync(fixtureWorkRoot, { recursive: true });
  const portBase = Number(env.ALBUM_HAVEN_FUNCTIONAL_PORT_BASE);
  if (!Number.isInteger(portBase) || portBase < 1025 || portBase > 65532) {
    throw new Error('ALBUM_HAVEN_FUNCTIONAL_PORT_BASE must be a safe TCP port base');
  }
  const runnerPath = path.join(repoRoot, 'scripts', 'run-playwright.cjs');
  const checkpointPath = path.join(repoRoot, 'scripts', 'ci', 'functional-fixture-checkpoint.py');
  const mediaCheckpointPath = path.join(repoRoot, 'scripts', 'ci', 'restore-functional-media.cjs');
  let failed = false;
  const checkpointEnv = {
    ...env,
    ALBUM_HAVEN_FIXTURE_PROFILE: 'functional-core',
    ALBUM_HAVEN_FIXTURE_ROOT: sourceFixtureRoot,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(sourceFixtureRoot, 'media'),
  };
  const runCheckpoint = (mode) => spawnSyncFn(
    pythonExecutable,
    [
      checkpointPath,
      `--mode=${mode}`,
      `--database-url=${databaseUrl}`,
    ],
    {
      cwd: repoRoot,
      env: checkpointEnv,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const runMediaCheckpoint = (mode) => spawnSyncFn(
    process.execPath,
    [
      mediaCheckpointPath,
      `--mode=${mode}`,
      `--source-media-root=${path.join(immutableFixtureRoot, 'media')}`,
      `--writable-media-root=${path.join(sourceFixtureRoot, 'media')}`,
    ],
    {
      cwd: repoRoot,
      env: checkpointEnv,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const captureResult = runCheckpoint('capture');
  if (captureResult.signal) return { exitCode: 1, signal: captureResult.signal };
  if (captureResult.error || captureResult.status !== 0) {
    return { exitCode: 1, signal: null };
  }

  let invocationIndex = 0;
  for (const [waveIndex, wave] of executionWaves.entries()) {
    if (waveIndex > 0) {
      const mediaRestoreResult = runMediaCheckpoint('restore');
      if (mediaRestoreResult.signal) return { exitCode: 1, signal: mediaRestoreResult.signal };
      if (mediaRestoreResult.error || mediaRestoreResult.status !== 0) {
        failed = true;
        break;
      }
      const restoreResult = runCheckpoint('restore');
      if (restoreResult.signal) return { exitCode: 1, signal: restoreResult.signal };
      if (restoreResult.error || restoreResult.status !== 0) {
        failed = true;
        break;
      }
    }
    for (const invocation of wave.invocations) {
      invocationIndex += 1;
      const invocationName = [
        `wave-${String(wave.wave).padStart(2, '0')}`,
        String(invocationIndex).padStart(2, '0'),
        path.basename(invocation.config).replace(/[^a-z0-9]+/gi, '-'),
      ].join('-');
      const testPaths = [...new Set(invocation.cases.map((ownedCase) => normalizeTestPath(ownedCase.test)))];
      const titlePattern = `(?:${invocation.cases.map((ownedCase) => regexEscape(ownedCase.case)).join('|')})$`;
      const childEnv = {
        ...checkpointEnv,
        ALBUM_HAVEN_FUNCTIONAL_BROWSER_WARMUP: '1',
        PLAYWRIGHT_REAL_APP_PORT: String(portBase),
        PLAYWRIGHT_PORT: String(portBase),
        PLAYWRIGHT_PROVIDER_PORT: String(portBase + 2),
        PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(blobRoot, `${invocationName}.zip`),
      };
      for (const key of OWNER_RUNTIME_ENV_KEYS) childEnv[key] = '';
      delete childEnv.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE;
      if (invocation.config === 'playwright.lastfm-auto-timezone.config.js') {
        childEnv.ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE = 'blank';
      }
      const result = spawnSyncFn(
        process.execPath,
        [
          runnerPath,
          'test',
          ...testPaths,
          '--grep',
          titlePattern,
          `--config=${invocation.config}`,
          `--project=${invocation.project}`,
          '--workers=1',
          '--browser=chrome',
          '--headless',
          `--real-app-port=${portBase}`,
          `--output=${path.join(outputRoot, invocationName)}`,
        ],
        {
          cwd: repoRoot,
          env: childEnv,
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      if (result.signal) return { exitCode: 1, signal: result.signal };
      if (result.error || result.status !== 0) failed = true;
    }
  }
  const mediaRestoreResult = runMediaCheckpoint('restore');
  if (mediaRestoreResult.signal) return { exitCode: 1, signal: mediaRestoreResult.signal };
  if (mediaRestoreResult.error || mediaRestoreResult.status !== 0) failed = true;
  const restoreResult = runCheckpoint('restore');
  if (restoreResult.signal) return { exitCode: 1, signal: restoreResult.signal };
  if (restoreResult.error || restoreResult.status !== 0) failed = true;
  const mediaVerifyResult = runMediaCheckpoint('verify');
  if (mediaVerifyResult.signal) return { exitCode: 1, signal: mediaVerifyResult.signal };
  if (mediaVerifyResult.error || mediaVerifyResult.status !== 0) failed = true;
  const verifyResult = runCheckpoint('verify');
  if (verifyResult.signal) return { exitCode: 1, signal: verifyResult.signal };
  if (verifyResult.error || verifyResult.status !== 0) failed = true;
  return { exitCode: failed ? 1 : 0, signal: null };
}

function filterFunctionalShardCases(shard, focusedCases = []) {
  const requestedCases = [...new Set(
    (Array.isArray(focusedCases) ? focusedCases : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )];
  if (requestedCases.length === 0) return shard;
  const requestedSet = new Set(requestedCases);
  const ownedCases = new Set(
    (shard.invocations || []).flatMap((invocation) => (
      (invocation.cases || []).map((ownedCase) => String(ownedCase.case || '').trim())
    )),
  );
  for (const requestedCase of requestedCases) {
    if (!ownedCases.has(requestedCase)) {
      throw new Error(
        `Focused case ${requestedCase} is not owned by functional shard ${shard.name}.`,
      );
    }
  }
  return {
    ...shard,
    invocations: (shard.invocations || [])
      .map((invocation) => ({
        ...invocation,
        cases: (invocation.cases || []).filter((ownedCase) => (
          requestedSet.has(String(ownedCase.case || '').trim())
        )),
      }))
      .filter((invocation) => invocation.cases.length > 0),
  };
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(path.join(__dirname, '..', '..'));
  const contractPath = path.join(repoRoot, 'tests', 'ci', 'functional-shards.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const discovered = discoverFunctionalCases({ repoRoot });
  const errors = validateFunctionalShardContract(contract, discovered);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`functional-shards: ${error}\n`);
    return 1;
  }
  const shardArgument = argv.find((argument) => String(argument).startsWith('--run-shard='));
  if (shardArgument) {
    const focusedCases = argv
      .filter((argument) => String(argument).startsWith('--run-case='))
      .map((argument) => String(argument).slice('--run-case='.length));
    const result = runFunctionalShard(contract, shardArgument.slice('--run-shard='.length), {
      repoRoot,
      focusedCases,
    });
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return 1;
    }
    return result.exitCode;
  }
  if (argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      cases: discovered.length,
      shards: Object.fromEntries(EXPECTED_SHARDS),
    })}\n`);
  }
  return 0;
}

module.exports = {
  EXPECTED_CONFIGS,
  discoverFunctionalCases,
  executionWavesForShard,
  filterFunctionalShardCases,
  parseListOutput,
  runFunctionalShard,
  validateFunctionalShardContract,
};

if (require.main === module) {
  process.exitCode = main();
}
