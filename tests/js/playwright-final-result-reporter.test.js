const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PlaywrightFinalResultReporter = require('../../scripts/playwright-final-result-reporter.cjs');
const { FINAL_RESULT_MARKER } = PlaywrightFinalResultReporter;

function parseReporterPayloads(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${FINAL_RESULT_MARKER} `))
    .map((line) => JSON.parse(line.slice(FINAL_RESULT_MARKER.length).trim()));
}

function runBrowserlessPlaywrightProbe(specSource) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-playwright-reporter-probe-'));
  const reporterPath = path.join(repoRoot, 'scripts', 'playwright-final-result-reporter.cjs');
  const configPath = path.join(tempRoot, 'playwright.config.cjs');
  const specPath = path.join(tempRoot, 'probe.spec.mjs');
  fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
  fs.writeFileSync(specPath, specSource, 'utf8');
  fs.writeFileSync(configPath, `
    module.exports = {
      testDir: ${JSON.stringify(tempRoot)},
      testMatch: 'probe.spec.mjs',
      workers: 1,
      retries: 0,
      reporter: [[${JSON.stringify(reporterPath)}, { nonce: 'browserless-probe' }]],
    };
  `, 'utf8');
  try {
    return spawnSync(process.execPath, [
      path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
      'test',
      '--config',
      configPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runReporter({ total = 1, outcomes = [], status = 'passed', errors = 0 } = {}) {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'test-nonce',
    stdout: {
      write(text) {
        writes.push(String(text));
      },
    },
  });
  reporter.onBegin({}, {
    allTests() {
      return Array.from({ length: total }, (_, index) => ({ id: `test-${index}` }));
    },
  });
  for (const outcome of outcomes) {
    reporter.onTestEnd(
      { id: outcome.id, expectedStatus: outcome.expectedStatus },
      { status: outcome.status },
    );
  }
  for (let index = 0; index < errors; index += 1) {
    reporter.onError(new Error('setup or teardown failed'));
  }
  reporter.onEnd({ status });
  const line = writes.join('').trim().split(/\r?\n/).at(-1);
  assert.ok(line.startsWith(`${FINAL_RESULT_MARKER} `));
  return JSON.parse(line.slice(FINAL_RESULT_MARKER.length).trim());
}

test('final result reporter line-frames markers after adjacent reporter output', async () => {
  const writes = ['built-in reporter output without a newline'];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'line-framing-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'only-test' }] });

  reporter.onTestEnd(
    { id: 'only-test', expectedStatus: 'passed', retries: 0 },
    { status: 'passed', retry: 0 },
  );
  await reporter.onEnd({ status: 'passed' });

  const output = writes.join('');
  assert.match(output, /without a newline\r?\n\[album-haven-playwright-result\] /);
  assert.deepEqual(
    parseReporterPayloads(output).map(({ phase }) => phase),
    ['tests-complete', 'run-final'],
  );
});

test('final result reporter emits a complete authoritative pass', () => {
  assert.deepEqual(runReporter({
    total: 2,
    outcomes: [
      { id: 'test-0', status: 'passed' },
      { id: 'test-1', status: 'skipped' },
    ],
  }), {
    version: 1,
    phase: 'run-final',
    nonce: 'test-nonce',
    status: 'passed',
    total: 2,
    completed: 2,
    failed: 0,
    skipped: 1,
    errors: 0,
  });
});

test('final result reporter fails closed when every discovered test is skipped', async () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'all-skipped-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'only-test' }] });

  reporter.onTestEnd(
    { id: 'only-test', expectedStatus: 'skipped', retries: 0 },
    { status: 'skipped', retry: 0 },
  );
  await reporter.onEnd({ status: 'passed' });

  const payloads = parseReporterPayloads(writes.join(''));
  assert.deepEqual(payloads.map(({ phase, status }) => ({ phase, status })), [
    { phase: 'tests-complete', status: 'failed' },
    { phase: 'run-final', status: 'failed' },
  ]);
  assert.ok(payloads.every((payload) => (
    payload.nonce === 'all-skipped-nonce'
    && payload.total === 1
    && payload.completed === 1
    && payload.failed === 0
    && payload.skipped === 1
    && payload.errors === 0
  )));
});

test('mixed pass and skip remains passed without changing expected-failure or retry semantics', async () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'mixed-outcome-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, {
    allTests: () => [
      { id: 'passing' },
      { id: 'skipped' },
      { id: 'expected-failure' },
      { id: 'retrying' },
    ],
  });

  reporter.onTestEnd({ id: 'passing', retries: 0 }, { status: 'passed', retry: 0 });
  reporter.onTestEnd(
    { id: 'skipped', expectedStatus: 'skipped', retries: 0 },
    { status: 'skipped', retry: 0 },
  );
  reporter.onTestEnd(
    { id: 'expected-failure', expectedStatus: 'failed', retries: 0 },
    { status: 'failed', retry: 0 },
  );
  reporter.onTestEnd(
    { id: 'retrying', expectedStatus: 'passed', retries: 1 },
    { status: 'failed', retry: 0 },
  );
  assert.equal(writes.length, 0, 'an available retry must not become a terminal outcome');
  reporter.onTestEnd(
    { id: 'retrying', expectedStatus: 'passed', retries: 1 },
    { status: 'passed', retry: 1 },
  );
  await reporter.onEnd({ status: 'passed' });

  const payloads = parseReporterPayloads(writes.join(''));
  assert.deepEqual(payloads.map(({ phase, status }) => ({ phase, status })), [
    { phase: 'tests-complete', status: 'passed' },
    { phase: 'run-final', status: 'passed' },
  ]);
  assert.ok(payloads.every((payload) => (
    payload.total === 4
    && payload.completed === 4
    && payload.failed === 0
    && payload.skipped === 1
    && payload.errors === 0
  )));
});

test('final result reporter keeps only the terminal retry outcome for each test', () => {
  assert.deepEqual(runReporter({
    outcomes: [
      { id: 'test-0', status: 'failed' },
      { id: 'test-0', status: 'passed' },
    ],
  }), {
    version: 1,
    phase: 'run-final',
    nonce: 'test-nonce',
    status: 'passed',
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    errors: 0,
  });
});

test('final result reporter follows Playwright expectedStatus semantics for test.fail', () => {
  assert.deepEqual(runReporter({
    outcomes: [{ id: 'test-0', status: 'failed', expectedStatus: 'failed' }],
    status: 'passed',
  }), {
    version: 1,
    phase: 'run-final',
    nonce: 'test-nonce',
    status: 'passed',
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    errors: 0,
  });
});

test('final result reporter records setup or teardown errors and incomplete failed runs', () => {
  assert.deepEqual(runReporter({ total: 1, outcomes: [], status: 'failed', errors: 1 }), {
    version: 1,
    phase: 'run-final',
    nonce: 'test-nonce',
    status: 'failed',
    total: 1,
    completed: 0,
    failed: 0,
    skipped: 0,
    errors: 1,
  });
});

test('final result reporter authenticates an empty collected suite failure without claiming tests completed', () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'empty-suite-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });

  reporter.onBegin({}, { allTests: () => [] });
  reporter.onError(new Error('No tests found'));
  reporter.onEnd({ status: 'failed' });

  const payloads = parseReporterPayloads(writes.join(''));
  assert.deepEqual(payloads.map(({ phase }) => phase), ['run-error', 'run-final']);
  assert.ok(payloads.every(({ nonce, status }) => (
    nonce === 'empty-suite-nonce' && status === 'failed'
  )));
});

test('browserless Playwright emits authenticated failure evidence for a valid ESM no-tests suite', () => {
  const probe = runBrowserlessPlaywrightProbe('export {};\n');

  assert.equal(probe.signal, null, probe.stderr);
  assert.equal(probe.status, 1, probe.stderr);
  const payloads = parseReporterPayloads(probe.stdout);
  assert.equal(payloads.at(0)?.phase, 'run-error');
  assert.equal(payloads.at(0)?.status, 'failed');
  assert.equal(payloads.at(-1)?.phase, 'run-final');
  assert.equal(payloads.at(-1)?.status, 'failed');
  assert.ok(payloads.every(({ nonce }) => nonce === 'browserless-probe'));
});

test('browserless Playwright authenticates and exits nonzero for a module-load failure', () => {
  const probe = runBrowserlessPlaywrightProbe("throw new Error('intentional module-load probe failure');\n");

  assert.equal(probe.signal, null, probe.stderr);
  assert.equal(probe.status, 1, probe.stderr);
  const payloads = parseReporterPayloads(probe.stdout);
  assert.equal(payloads.at(0)?.phase, 'run-error');
  assert.equal(payloads.at(-1)?.phase, 'run-final');
  assert.ok(payloads.every(({ nonce, status }) => (
    nonce === 'browserless-probe' && status === 'failed'
  )));
});

test('final result reporter waits for every test and for an exhausted retry before emitting completion', () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'test-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'one' }, { id: 'two' }] });

  reporter.onTestEnd({ id: 'one', retries: 0 }, { status: 'passed', retry: 0 });
  assert.equal(writes.length, 0);
  reporter.onTestEnd({ id: 'two', retries: 1 }, { status: 'failed', retry: 0 });
  assert.equal(writes.length, 0);
  reporter.onTestEnd({ id: 'two', retries: 1 }, { status: 'passed', retry: 1 });

  assert.equal(writes.length, 1);
  assert.deepEqual(
    parseReporterPayloads(writes.join('')).at(0),
    {
      version: 1,
      phase: 'tests-complete',
      nonce: 'test-nonce',
      status: 'passed',
      total: 2,
      completed: 2,
      failed: 0,
      skipped: 0,
      errors: 0,
    },
  );
});

test('a retryable failure cannot become terminal when another test finishes first', () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'test-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'retrying' }, { id: 'other' }] });

  reporter.onTestEnd({ id: 'retrying', retries: 1 }, { status: 'failed', retry: 0 });
  reporter.onTestEnd({ id: 'other', retries: 0 }, { status: 'passed', retry: 0 });
  assert.equal(writes.length, 0);

  reporter.onTestEnd({ id: 'retrying', retries: 1 }, { status: 'passed', retry: 1 });
  assert.equal(writes.length, 1);
  const finalResult = parseReporterPayloads(writes.join('')).at(0);
  assert.equal(finalResult.status, 'passed');
  assert.equal(finalResult.completed, 2);
  assert.equal(finalResult.failed, 0);
});

test('final result reporter overwrites a tests-complete pass when a later global error arrives', () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'test-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'one' }] });
  reporter.onTestEnd({ id: 'one', retries: 0 }, { status: 'passed', retry: 0 });
  reporter.onError(new Error('afterAll failed'));

  assert.equal(writes.length, 2);
  const latest = parseReporterPayloads(writes.join('')).at(-1);
  assert.equal(latest.status, 'failed');
  assert.equal(latest.errors, 1);
});

test('reporter distinguishes terminal-test, global-error, and authoritative final phases with the run nonce', () => {
  const writes = [];
  const reporter = new PlaywrightFinalResultReporter({
    nonce: 'expected-nonce',
    stdout: { write: (text) => writes.push(String(text)) },
  });
  reporter.onBegin({}, { allTests: () => [{ id: 'one' }] });
  reporter.onTestEnd({ id: 'one', retries: 0 }, { status: 'passed', retry: 0 });
  reporter.onError(new Error('afterAll failed'));
  reporter.onEnd({ status: 'failed' });

  const payloads = parseReporterPayloads(writes.join(''));
  assert.deepEqual(payloads.map(({ phase }) => phase), ['tests-complete', 'run-error', 'run-final']);
  assert.deepEqual(payloads.map(({ nonce }) => nonce), [
    'expected-nonce',
    'expected-nonce',
    'expected-nonce',
  ]);
});

test('onEnd waits for the authoritative final marker to flush before process exit', () => {
  const reporterPath = path.resolve(
    __dirname,
    '..',
    '..',
    'scripts',
    'playwright-final-result-reporter.cjs',
  );
  const probe = spawnSync(process.execPath, ['-e', `
    const { Writable } = require('node:stream');
    const Reporter = require(${JSON.stringify(reporterPath)});
    const delayedStdout = new Writable({
      write(chunk, _encoding, callback) {
        setTimeout(() => process.stdout.write(chunk, callback), 50);
      },
    });
    (async () => {
      const reporter = new Reporter({ nonce: 'flush-probe', stdout: delayedStdout });
      reporter.onBegin({}, { allTests: () => [{ id: 'passing-test' }] });
      reporter.onTestEnd(
        { id: 'passing-test', retries: 0 },
        { status: 'passed', retry: 0 },
      );
      await reporter.onEnd({ status: 'passed' });
      await reporter.onExit?.();
      process.exit(0);
    })().catch((error) => {
      process.stderr.write(String(error?.stack || error));
      process.exit(1);
    });
  `], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });

  assert.equal(probe.status, 0, probe.stderr);
  const payloads = probe.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => (
    JSON.parse(line.slice(FINAL_RESULT_MARKER.length).trim())
  ));
  assert.deepEqual(payloads.map(({ phase }) => phase), ['tests-complete', 'run-final']);
  assert.equal(payloads.at(-1).status, 'passed');
});
