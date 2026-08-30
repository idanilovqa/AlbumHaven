const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBrowserProjectUse,
  resolveRuntimeFlags,
} = require('../../scripts/playwright-runtime-flags.cjs');

test('resolveBrowserProjectUse uses the verified Chrome executable without changing snapshot identity', () => {
  assert.deepEqual(
    resolveBrowserProjectUse('chrome', {
      PLAYWRIGHT_CHROME_EXECUTABLE: 'C:\\runner-tools\\chrome-win64\\chrome.exe',
    }),
    {
      browserName: 'chromium',
      launchOptions: {
        executablePath: 'C:\\runner-tools\\chrome-win64\\chrome.exe',
      },
    },
  );
  assert.deepEqual(
    resolveBrowserProjectUse('chrome', {}),
    { browserName: 'chromium', channel: 'chrome' },
  );
});

test('resolveRuntimeFlags parses run-timeout-ms and removes it from Playwright passthrough args', () => {
  const flags = resolveRuntimeFlags([
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '--run-timeout-ms=120000',
    '--workers=1',
    '--headless',
  ], {});

  assert.equal(flags.runTimeoutMs, 120000);
  assert.equal(flags.headlessOverride, true);
  assert.deepEqual(flags.passthroughArgv, [
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '--workers=1',
  ]);
});

test('resolveRuntimeFlags falls back to PLAYWRIGHT_RUN_TIMEOUT_MS when the CLI flag is omitted', () => {
  const flags = resolveRuntimeFlags([
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
  ], {
    PLAYWRIGHT_RUN_TIMEOUT_MS: '90000',
  });

  assert.equal(flags.runTimeoutMs, 90000);
  assert.deepEqual(flags.passthroughArgv, [
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
  ]);
});

test('resolveRuntimeFlags keeps isolated-app spec args in Playwright passthrough output', () => {
  const flags = resolveRuntimeFlags([
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
    '--workers=1',
  ], {});

  assert.equal(flags.supportAppPort, 4173);
  assert.equal(flags.providerPort, 4175);
  assert.deepEqual(flags.passthroughArgv, [
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
    '--workers=1',
  ]);
});

test('resolveRuntimeFlags reads the managed support-app port without changing passthrough args', () => {
  const flags = resolveRuntimeFlags([
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
  ], {
    PLAYWRIGHT_PORT: '4183',
  });

  assert.equal(flags.supportAppPort, 4183);
  assert.equal(flags.providerPort, 4185);
  assert.equal(flags.fakeAppPort, undefined);
  assert.deepEqual(flags.passthroughArgv, [
    'test',
    'tests/e2e/performance/idleMemory.spec.js',
  ]);
});

test('resolveRuntimeFlags preserves an explicit provider port override', () => {
  const flags = resolveRuntimeFlags(['test'], {
    PLAYWRIGHT_PORT: '4183',
    PLAYWRIGHT_PROVIDER_PORT: '5199',
  });

  assert.equal(flags.supportAppPort, 4183);
  assert.equal(flags.providerPort, 5199);
});

test('resolveRuntimeFlags parses --headed and removes it from Playwright passthrough args', () => {
  const flags = resolveRuntimeFlags([
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '--headed',
    '--workers=1',
  ], {});

  assert.equal(flags.headlessOverride, false);
  assert.deepEqual(flags.passthroughArgv, [
    'test',
    'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    '--workers=1',
  ]);
});

test('resolveRuntimeFlags defaults browser selection to Playwright-managed Chromium', () => {
  const flags = resolveRuntimeFlags(['test'], {});

  assert.equal(flags.browser, 'chromium');
});

test('resolveRuntimeFlags supports managed Chromium, branded Chrome, and branded Edge explicitly', () => {
  for (const [requestedBrowser, expectedBrowser] of [
    ['chromium', 'chromium'],
    ['chrome', 'chrome'],
    ['edge', 'edge'],
    ['msedge', 'edge'],
  ]) {
    const flags = resolveRuntimeFlags([
      'test',
      `--browser=${requestedBrowser}`,
      '--workers=1',
    ], {});

    assert.equal(flags.browser, expectedBrowser, requestedBrowser);
    assert.deepEqual(flags.passthroughArgv, ['test', '--workers=1'], requestedBrowser);
  }
});

test('resolveRuntimeFlags browser error advertises managed Chromium as the default selection', () => {
  assert.throws(
    () => resolveRuntimeFlags(['test', '--browser=firefox'], {}),
    /Use --browser=chromium \(default, Playwright-managed\), --browser=chrome, or --browser=edge/,
  );
});
