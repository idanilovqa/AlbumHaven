const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const importRepoModule = (relativePath) => import(pathToFileURL(path.join(repoRoot, relativePath)).href);
const helpers = importRepoModule('tests/e2e/syntheticLargeLibrary/projectionPendingWindows.js');
const timing = importRepoModule('tests/e2e/helpers/timingBudget.js');

const SCOPE = '/view-data&surface=albums&artist=Synthetic Artist&root_sidebar=1';
const pending = (atMs, scope = SCOPE) => ({ atMs, kind: 'pending', scope, code: 'gallery_projection_pending' });
const success = (atMs, scope = SCOPE) => ({ atMs, kind: 'success', scope });
const ready = (atMs) => ({ atMs, kind: 'ready' });

async function windowBudget() {
  const { PROJECTION_PENDING_WINDOW_METRIC_ID } = await helpers;
  return (await timing).performanceTimingBudget(PROJECTION_PENDING_WINDOW_METRIC_ID, {});
}

async function evaluate(events) {
  const budget = await windowBudget();
  return { budget, result: (await helpers).evaluateProjectionPendingTimeline(events, budget) };
}

function recordingExpect() {
  const failures = [];
  const expect = (actual, message) => ({
    toBeGreaterThanOrEqual: (bound) => { if (!(actual >= bound)) failures.push(message); },
    toBeLessThanOrEqual: (bound) => { if (!(actual <= bound)) failures.push(message); },
  });
  return { expect, failures };
}

test('the window budget is the selected-artist API budget', async () => {
  const { budget } = await evaluate([]);
  assert.equal(budget.metricId, 'selected-artist.selectedArtistApiMs');
});

test('scope identity ignores pagination and presentation params', async () => {
  const { projectionReadScope } = await helpers;
  assert.equal(
    projectionReadScope('http://h/view-data?artist=A&surface=albums&cursor=9&payload_tier=full'),
    projectionReadScope('http://h/view-data?surface=albums&artist=A'),
  );
  assert.notEqual(
    projectionReadScope('http://h/view-data?surface=albums&artist=A'),
    projectionReadScope('http://h/view-data?surface=albums&artist=B'),
  );
});

test('pending answers before readiness are counted and never fail', async () => {
  const { result } = await evaluate([pending(100), pending(200), success(300), ready(5000), success(5200)]);
  assert.equal(result.readyAtMs, 5000);
  assert.equal(result.preReadyPendingCount, 2);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.violations, []);
});

test('without any ready status every pending answer stays pre-ready', async () => {
  const { result } = await evaluate([pending(100), pending(900)]);
  assert.equal(result.readyAtMs, null);
  assert.equal(result.preReadyPendingCount, 2);
  assert.deepEqual(result.violations, []);
});

test('one post-ready window within target passes', async () => {
  const { result, budget } = await evaluate([ready(1000), pending(2000), pending(2300), success(2500)]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].durationMs, 500);
  assert.ok(result.windows[0].durationMs <= budget.targetMaximum);
  assert.equal(result.windows[0].outcome.status, (await timing).TIMING_BUDGET_STATUS.TARGET_MET);
  const { expect, failures } = recordingExpect();
  (await timing).expectTimingBudgetOutcome(expect, result.windows[0].outcome, 'window');
  assert.deepEqual(failures, []);
});

test('a window between target and ceiling is a soft miss', async () => {
  const budget = await windowBudget();
  const { result } = await evaluate([ready(0), pending(1000), success(1000 + budget.targetMaximum + 1)]);
  assert.deepEqual(result.violations, []);
  const { outcome } = result.windows[0];
  assert.equal(outcome.status, (await timing).TIMING_BUDGET_STATUS.GRACE_USED);
  assert.equal(outcome.graceUsed, true);
  const { expect, failures } = recordingExpect();
  (await timing).expectTimingBudgetOutcome(expect, outcome, 'window');
  assert.deepEqual(failures, []);
});

test('a window over the hard ceiling fails', async () => {
  const budget = await windowBudget();
  const { result } = await evaluate([ready(0), pending(1000), success(1000 + budget.hardCeiling + 1)]);
  const { outcome } = result.windows[0];
  assert.equal(outcome.passed, false);
  const { expect, failures } = recordingExpect();
  (await timing).expectTimingBudgetOutcome(expect, outcome, 'window');
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^HARD FAIL: window took/);
});

test('a second window for the same scope fails whatever its timing', async () => {
  const { result } = await evaluate([ready(0), pending(10), success(20), pending(30), success(40)]);
  assert.equal(result.windows.length, 1);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /after it had already served/);
});

test('a scope served before readiness may not answer pending after it', async () => {
  const { result } = await evaluate([success(10), ready(100), pending(200), success(210)]);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /after it had already served/);
});

test('a post-ready pending answer that never serves fails', async () => {
  const { result } = await evaluate([ready(0), pending(10)]);
  assert.deepEqual(result.windows, []);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /never served/);
});

test('scopes get independent windows and events are judged in time order', async () => {
  const other = '/search&q=x';
  const { result } = await evaluate([success(60, other), pending(50, other), success(40), pending(30), ready(20)]);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.windows.map(({ scope, durationMs }) => [scope, durationMs]), [[SCOPE, 10], [other, 10]]);
});
