const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const {
  PAIRED_SEARCH_CASES,
  buildCombinedArtifact,
  runPairedSearchCalibration,
  validatePhaseArtifact,
} = require('../../scripts/run-paired-search-calibration.cjs');

const RUN_ID = 'paired-search-20261004-120000-12345678';
const productionCases = PAIRED_SEARCH_CASES.map((scenario, index) => ({
  ...scenario,
  caseId: 'FTC-GALLERY-STARTUP-005P',
  classification: index === 0 ? 'target-met' : 'grace-used',
  budget: { targetMs: 800, graceMs: 400, hardCeilingMs: 1200 },
  submitToFirstVisibleMs: index === 0 ? 600 : 900,
}));
const syntheticCases = PAIRED_SEARCH_CASES.map((scenario, index) => ({
  ...scenario,
  caseId: 'FTC-GALLERY-STARTUP-005U',
  submitToFirstVisibleMs: index === 0 ? 750 : 990,
}));

function phaseArtifact(source, cases) {
  return { schemaVersion: 1, runId: RUN_ID, source, cases };
}

test('phase artifacts require one sanitized record for each paired search case', () => {
  assert.deepEqual(
    validatePhaseArtifact(phaseArtifact('production', productionCases), {
      runId: RUN_ID,
      source: 'production',
    }).cases,
    productionCases,
  );
  assert.deepEqual(
    validatePhaseArtifact(phaseArtifact('synthetic', syntheticCases), {
      runId: RUN_ID,
      source: 'synthetic',
    }).cases,
    syntheticCases,
  );

  for (const forbidden of [
    { password: 'secret' },
    { localPath: 'C:\\Music\\Album' },
    { responsePayload: { artist_groups: [] } },
    { databaseIdentitySha256: 'a'.repeat(64) },
    { databaseIdentityProof: { proof: 'a'.repeat(64) } },
    { extra: true },
  ]) {
    assert.throws(
      () => validatePhaseArtifact({
        ...phaseArtifact('synthetic', syntheticCases),
        ...forbidden,
      }, { runId: RUN_ID, source: 'synthetic' }),
      /unexpected field/u,
    );
  }
  assert.throws(
    () => validatePhaseArtifact(phaseArtifact('synthetic', syntheticCases.slice(0, 1)), {
      runId: RUN_ID,
      source: 'synthetic',
    }),
    /exactly two cases/u,
  );
});

test('combined artifact keeps the production and synthetic contracts', () => {
  const combined = buildCombinedArtifact({
    runId: RUN_ID,
    production: phaseArtifact('production', productionCases),
    synthetic: phaseArtifact('synthetic', syntheticCases),
    generatedAt: '2026-10-04T12:00:00.000Z',
  });

  assert.equal(combined.runId, RUN_ID);
  assert.equal(combined.cases.length, 2);
  assert.deepEqual(combined.productionBudget, {
    targetMs: 800,
    graceMs: 400,
    hardCeilingMs: 1200,
  });
  assert.deepEqual(combined.cases[0].synthetic, { submitToFirstVisibleMs: 750 });
  assert.equal(combined.cases[0].syntheticToProductionRatio, 1.25);
  assert.doesNotMatch(JSON.stringify(combined.cases[0].synthetic), /budget|target|grace|ceiling|classification/iu);
});

test('orchestrator always runs synthetic after production and shares one run ID', () => {
  const calls = [];
  const writes = [];
  const dependencies = {
    mkdirSync() {},
    removeFile() {},
    randomUUID: () => '12345678-1234-1234-1234-123456789abc',
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    readJson(filePath) {
      return filePath.endsWith('production.json')
        ? phaseArtifact('production', productionCases)
        : phaseArtifact('synthetic', syntheticCases);
    },
    spawnSync(command, args, options) {
      calls.push({ command, args, env: options.env });
      return { status: 0 };
    },
    writeJson(filePath, value) {
      writes.push({ filePath, value });
    },
  };

  const result = runPairedSearchCalibration({ repoRoot: root, baseEnv: {} }, dependencies);

  assert.equal(result.status, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.join(' '), /playwright\.production-search-benchmark\.config\.cjs/u);
  assert.match(calls[1].args.join(' '), /run-performance-playwright\.cjs --test paired-search-calibration/u);
  assert.equal(calls[1].env.PLAYWRIGHT_REAL_APP_PORT, '5011');
  assert.equal(
    calls[1].env.ALBUM_HAVEN_FIXTURE_PROFILE,
    'synthetic-large-library',
  );
  assert.equal(calls[1].env.PLAYWRIGHT_REAL_APP_URL, '');
  assert.equal(calls[0].env.ALBUM_HAVEN_PAIRED_SEARCH_RUN_ID, RUN_ID);
  assert.equal(calls[1].env.ALBUM_HAVEN_PAIRED_SEARCH_RUN_ID, RUN_ID);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.runId, RUN_ID);

  calls.length = 0;
  writes.length = 0;
  dependencies.spawnSync = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { status: 23 };
  };
  const failed = runPairedSearchCalibration({ repoRoot: root, baseEnv: {} }, dependencies);
  assert.equal(failed.status, 1);
  assert.equal(calls.length, 2);
  assert.equal(writes.length, 1);
});

for (const elapsedMs of [350, 550]) {
  test(`paired search publishes native metrics before enforcing ${elapsedMs} ms timing`, async () => {
    const timing = await import(pathToFileURL(path.join(root, 'tests/e2e/helpers/timingBudget.js')));
    const scenarios = [];
    const register = (title, run) => scenarios.push({ title, run });
    register.describe = (_title, define) => define();
    const source = fs.readFileSync(path.join(root,
      'tests/e2e/syntheticLargeLibrary/searchPreviewPairedCalibration.spec.js'), 'utf8');
    vm.runInNewContext(source.replace(/^import .*?;\r?\n/gmu, ''), {
      ...timing, Buffer, test: register,
      expect: (actual, message) => actual === page
        ? { not: { toHaveURL: async () => {} } }
        : expect(actual, message),
    });
    const page = {};
    assert.equal(scenarios.length, 2);
    for (const scenario of scenarios) {
      const reports = [];
      const attachments = [];
      const syntheticSearchInventory = {
        Devin: ['seed-devin-primary', 'seed-devin-family'],
        'Neal Morse': Array.from({ length: 13 }, (_, index) => `seed-neal-${index}`),
      };
      const operation = scenario.run({
        page,
        syntheticSearchInventory,
        performanceReport: { publishRun: (payload) => reports.push(payload) },
        searchToolbarActions: { waitForVisible: async () => {} },
        galleryActions: {
          goto: async () => {}, waitForGalleryReady: async () => {},
          measureSyntheticSearchFirstVisible: async (_toolbar, query, options) => {
            assert.deepEqual(Array.from(options.expectedAlbumKeys || []), syntheticSearchInventory[query],
              'The benchmark must supply the independent seeded inventory before measuring');
            return {
              elapsedMs, directSearchMatch: true,
              generationBefore: { requestGeneration: 1, renderGeneration: 1 },
              generationAfter: { requestGeneration: 2, renderGeneration: 2 },
            };
          },
        },
      }, { attach: async (name, payload) => attachments.push({ name, ...payload }) });
      if (elapsedMs > 500) await assert.rejects(operation, /HARD FAIL/u);
      else await operation;
      assert.equal(reports.length, 1, 'native reporter needs a standard metrics payload');
      assert.equal(reports[0].reportId, 'pairedSearchCalibrationLocal');
      const validation = reports[0].rawMetrics.benchmarkValidation;
      assert.equal(validation.functionalChecksComplete, true);
      assert.equal(validation.nonTimingChecksComplete, true);
      assert.deepEqual(Array.from(validation.expectedMetricIds), ['search-preview.syntheticFirstVisibleMs']);
      assert.equal(validation.results.length, 1);
      const metric = validation.results[0];
      assert.equal(metric.actual, elapsedMs);
      assert.equal(metric.targetMaximum, 400);
      assert.equal(metric.graceMs, 100);
      assert.equal(metric.hardCeiling, 500);
      assert.equal(metric.passed, elapsedMs <= 500);
      assert.equal(attachments.length, 1);
      assert.equal(attachments[0].name, 'synthetic-paired-search-metrics');
      assert.equal(JSON.parse(attachments[0].body).submitToFirstVisibleMs, elapsedMs);
    }
  });
}
