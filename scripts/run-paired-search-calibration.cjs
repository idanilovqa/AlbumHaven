const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUN_ID_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_RUN_ID';
const PHASE_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_PHASE';
const OUTPUT_ENV = 'ALBUM_HAVEN_PAIRED_SEARCH_PHASE_OUTPUT';
const PRODUCTION_BUDGET = Object.freeze({ targetMs: 800, graceMs: 400, hardCeilingMs: 1200 });
const PAIRED_SEARCH_CASES = Object.freeze([
  Object.freeze({ query: 'Devin', expectedArtist: 'Devin Townsend' }),
  Object.freeze({ query: 'Neal Morse', expectedArtist: 'Neal Morse' }),
]);

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unexpected.length) throw new Error(`${label} has unexpected field: ${unexpected.join(', ')}.`);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label} is missing field: ${missing.join(', ')}.`);
}

function validateRunId(runId) {
  const normalized = String(runId || '');
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/u.test(normalized)) {
    throw new Error('Paired search run ID is invalid.');
  }
  return normalized;
}

function validateTiming(value, label) {
  const timing = Number(value);
  if (!Number.isFinite(timing) || timing <= 0) throw new Error(`${label} must be a positive number.`);
  return timing;
}

function validatePhaseArtifact(artifact, expected) {
  assertExactKeys(artifact, ['schemaVersion', 'runId', 'source', 'cases'], 'Phase artifact');
  if (artifact.schemaVersion !== 1) throw new Error('Phase artifact schema version must be 1.');
  if (validateRunId(artifact.runId) !== expected.runId) throw new Error('Phase artifact run ID mismatch.');
  if (artifact.source !== expected.source) throw new Error('Phase artifact source mismatch.');
  if (!Array.isArray(artifact.cases) || artifact.cases.length !== PAIRED_SEARCH_CASES.length) {
    throw new Error('Phase artifact must contain exactly two cases.');
  }

  const caseKeys = expected.source === 'production'
    ? ['caseId', 'query', 'expectedArtist', 'classification', 'budget', 'submitToFirstVisibleMs']
    : ['caseId', 'query', 'expectedArtist', 'submitToFirstVisibleMs'];
  const byQuery = new Map();
  for (const record of artifact.cases) {
    assertExactKeys(record, caseKeys, `${expected.source} case`);
    const scenario = PAIRED_SEARCH_CASES.find((entry) => entry.query === record.query);
    if (!scenario || scenario.expectedArtist !== record.expectedArtist || byQuery.has(record.query)) {
      throw new Error(`${expected.source} phase has an unknown, mismatched, or duplicate case.`);
    }
    validateTiming(record.submitToFirstVisibleMs, `${record.query} timing`);
    if (expected.source === 'production') {
      assertExactKeys(record.budget, ['targetMs', 'graceMs', 'hardCeilingMs'], 'Production budget');
      if (JSON.stringify(record.budget) !== JSON.stringify(PRODUCTION_BUDGET)) {
        throw new Error('Production budget must remain 800 ms plus 400 ms grace.');
      }
      if (!['target-met', 'grace-used'].includes(record.classification)) {
        throw new Error('Production calibration accepts only passing budget classifications.');
      }
    }
    byQuery.set(record.query, record);
  }
  return {
    schemaVersion: 1,
    runId: artifact.runId,
    source: artifact.source,
    cases: PAIRED_SEARCH_CASES.map((scenario) => byQuery.get(scenario.query)),
  };
}

function buildCombinedArtifact({ runId, production, synthetic, generatedAt }) {
  const normalizedRunId = validateRunId(runId);
  const productionArtifact = validatePhaseArtifact(production, {
    runId: normalizedRunId,
    source: 'production',
  });
  const syntheticArtifact = validatePhaseArtifact(synthetic, {
    runId: normalizedRunId,
    source: 'synthetic',
  });
  return {
    schemaVersion: 1,
    runId: normalizedRunId,
    generatedAt,
    productionBudget: { ...PRODUCTION_BUDGET },
    syntheticThresholdStatus: 'unthresholded-pending-paired-samples',
    cases: PAIRED_SEARCH_CASES.map((scenario, index) => {
      const productionCase = productionArtifact.cases[index];
      const syntheticCase = syntheticArtifact.cases[index];
      return {
        query: scenario.query,
        expectedArtist: scenario.expectedArtist,
        production: {
          classification: productionCase.classification,
          submitToFirstVisibleMs: productionCase.submitToFirstVisibleMs,
        },
        synthetic: { submitToFirstVisibleMs: syntheticCase.submitToFirstVisibleMs },
        syntheticToProductionRatio: Number(
          (syntheticCase.submitToFirstVisibleMs / productionCase.submitToFirstVisibleMs).toFixed(6),
        ),
      };
    }),
  };
}

function createRunId(now, randomUUID) {
  const timestamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '').replace('T', '-');
  return `paired-search-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function runPairedSearchCalibration(options = {}, dependencies = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const baseEnv = options.baseEnv || process.env;
  const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
  const mkdirSync = dependencies.mkdirSync || fs.mkdirSync;
  const readJson = dependencies.readJson || ((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const writeJson = dependencies.writeJson || ((filePath, value) => (
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  ));
  const removeFile = dependencies.removeFile || ((filePath) => fs.rmSync(filePath, { force: true }));
  const now = (dependencies.now || (() => new Date()))();
  const runId = createRunId(now, dependencies.randomUUID || crypto.randomUUID);
  const artifactDirectory = path.join(repoRoot, 'test-results', 'paired-search-calibration', runId);
  const productionPath = path.join(artifactDirectory, 'production.json');
  const syntheticPath = path.join(artifactDirectory, 'synthetic.json');
  const combinedPath = path.join(artifactDirectory, 'paired-search-calibration.json');
  mkdirSync(artifactDirectory, { recursive: true });

  const phaseEnv = (source, outputPath) => ({
    ...baseEnv,
    [RUN_ID_ENV]: runId,
    [PHASE_ENV]: source,
    [OUTPUT_ENV]: outputPath,
    ...(source === 'synthetic' ? {
      ALBUM_HAVEN_FIXTURE_PROFILE: 'synthetic-large-library',
      MUSIC_APP_DATA_DIR: '',
      MUSIC_CACHE_PATH: '',
      MUSIC_COVER_CACHE_PATH: '',
      MUSIC_DIR: '',
      MUSIC_LIBRARY_ROOTS_PATH: '',
      PLAYWRIGHT_REAL_APP: '',
      PLAYWRIGHT_REAL_APP_PORT: '5011',
      PLAYWRIGHT_REAL_APP_URL: '',
    } : {}),
  });
  const productionResult = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test',
    '--config=playwright.production-search-benchmark.config.cjs',
  ], {
    cwd: repoRoot,
    env: phaseEnv('production', productionPath),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (productionResult.error) throw productionResult.error;
  if (productionResult.status !== 0) return { status: productionResult.status ?? 1, runId };

  const syntheticResult = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'run-performance-playwright.cjs'),
    '--test',
    'paired-search-calibration',
  ], {
    cwd: repoRoot,
    env: phaseEnv('synthetic', syntheticPath),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (syntheticResult.error) throw syntheticResult.error;
  if (syntheticResult.status !== 0) return { status: syntheticResult.status ?? 1, runId };

  const combined = buildCombinedArtifact({
    runId,
    production: readJson(productionPath),
    synthetic: readJson(syntheticPath),
    generatedAt: now.toISOString(),
  });
  writeJson(combinedPath, combined);
  removeFile(productionPath);
  removeFile(syntheticPath);
  return { status: 0, runId, artifactPath: combinedPath };
}

module.exports = {
  PAIRED_SEARCH_CASES,
  PRODUCTION_BUDGET,
  buildCombinedArtifact,
  runPairedSearchCalibration,
  validatePhaseArtifact,
};

if (require.main === module) {
  try {
    const result = runPairedSearchCalibration();
    if (result.artifactPath) process.stdout.write(`${result.artifactPath}\n`);
    process.exitCode = result.status;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
