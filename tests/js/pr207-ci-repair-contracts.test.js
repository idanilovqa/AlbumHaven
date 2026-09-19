const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { _private } = require('../../scripts/run-playwright.cjs');

function runHarness() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const timers = [];
  const nonce = 'pr207-output-lifecycle';
  let snapshots = 0;
  const run = _private.runPlaywrightProcess(['test', '-c', 'playwright.performance.config.cjs'], {}, 60000, {
    resultNonce: nonce, processObject: { exitCode: null },
    spawnFn: () => child,
    readProcessTreeIdentitiesFn() { snapshots += 1; return []; },
    reclaimPortFn: () => [],
    setTimeoutFn(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeoutFn(timer) { if (timer) timer.cleared = true; },
    stdout: { write() {} }, stderr: { write() {} },
  });
  const signal = (phase, status = 'passed') => child.stdout.emit('data', Buffer.from(
    '[album-haven-playwright-result] ' + JSON.stringify({ version: 1, phase, nonce, status,
      total: 1, completed: 1, failed: status === 'passed' ? 0 : 1, skipped: 0, errors: 0 }) + '\n',
  ));
  const close = () => { child.emit('exit', 0, null); child.emit('close', 0, null); return run; };
  return { child, timers, signal, close, snapshots: () => snapshots };
}

test('trailing provider logs do not repeat process enumeration or rearm finalization deadlines', async () => {
  const h = runHarness();
  h.signal('tests-complete');
  const snapshotsAfterTests = h.snapshots();
  const timersAfterTests = h.timers.length;
  for (let i = 0; i < 200; i += 1) {
    h.child.stderr.emit('data', Buffer.from(`[WebServer] provider shutdown log ${i}\n`));
    h.child.stdout.emit('data', Buffer.from(`ordinary reporter output ${i}\n`));
  }
  const snapshotsAfterLogs = h.snapshots();
  const timersAfterLogs = h.timers.length;
  h.signal('run-final');
  await Promise.resolve();
  const snapshotsAfterFinal = h.snapshots();
  const timersAfterFinal = h.timers.length;
  const closeDeadline = h.timers.at(-1);
  for (let i = 0; i < 20; i += 1) h.child.stderr.emit('data', Buffer.from('last shutdown output\n'));
  const snapshotsBeforeClose = h.snapshots();
  const timersBeforeClose = h.timers.length;
  const deadlineWasReset = closeDeadline.cleared;
  const result = await h.close();
  assert.equal(result.exitCode, 0);
  assert.equal(snapshotsAfterTests, 1);
  assert.equal(snapshotsAfterLogs, snapshotsAfterTests, 'a cached completion signal is not a new lifecycle transition');
  assert.equal(timersAfterLogs, timersAfterTests);
  assert.equal(snapshotsAfterFinal, snapshotsAfterTests + 1);
  assert.equal(snapshotsBeforeClose, snapshotsAfterFinal);
  assert.equal(timersBeforeClose, timersAfterFinal);
  assert.equal(deadlineWasReset, false, 'ordinary output must not extend the original finalization deadline');
});

test('a late authenticated failure still fails after the first run-final transition', async () => {
  const h = runHarness();
  h.signal('tests-complete');
  h.signal('run-final');
  h.signal('run-final', 'failed');
  const result = await h.close();
  assert.equal(result.exitCode, 1);
});

function loadLoopActions(expect) {
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions/utilityLoopsActions.js'), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class ', 'class ');
  const context = { expect };
  vm.runInNewContext(source + ';globalThis.Actions = UtilityLoopsActions;', context);
  return context.Actions;
}

for (const action of ['cancel', 'create']) {
  test(`saved-loop ${action} reveals the approved folded controls before native activation`, async () => {
    let revealed = false;
    const events = [];
    const entry = {};
    const locator = { click: async () => {
      assert.equal(revealed, true, 'the 500ms-folded action must be revealed through Play before clicking it');
      events.push('native-' + action);
    } };
    const checked = [];
    const Actions = loadLoopActions(() => ({
      toHaveAttribute: async (...args) => checked.push(args),
      toBeVisible: async () => checked.push('visible'),
      toBeHidden: async () => checked.push('hidden'),
    }));
    const entryCard = Object.fromEntries(['loopCancelButtonForEntry', 'loopCreateButtonForEntry',
      'loopActionForEntry', 'savedLoopMainSurfaceForEntry', 'savedLoopEditRangeForEntry',
      'ordinaryTimelineForEntry', 'ordinaryTimeForEntry'].map(name => [name, value => {
        assert.equal(value, entry); return locator;
      }]));
    const instance = new Actions({ loopEntryCard: entryCard, page: {
      on: (name) => events.push('observe-' + name), off: name => events.push('release-' + name),
    } });
    instance.resolveLoopEntryByName = async name => { assert.equal(name, 'Warmup Loop'); return { entry, loopId: 'owned-loop' }; };
    instance.hoverLoopActionByName = async (name, target) => {
      assert.equal(name, 'Warmup Loop'); assert.equal(target, action); revealed = true; events.push('reveal-' + action);
    };
    const result = action === 'cancel'
      ? await instance.cancelCreateAnotherLoopByName('Warmup Loop')
      : await instance.activateCreateAnotherLoopByName('Warmup Loop');
    assert.ok(events.indexOf('reveal-' + action) < events.indexOf('native-' + action));
    if (action === 'cancel') {
      assert.equal(result.requestCount, 0);
      assert.deepEqual(checked, [['data-loop-action-state', 'idle'], 'visible', 'hidden', 'visible', 'visible']);
      assert.equal(events.at(-1), 'release-request');
    } else assert.equal(result, 'owned-loop');
  });
}

test('mobile exclusion tables retain the approved top-right action inset without altering desktop density', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/css/runtime/utilities.css'), 'utf8');
  assert.match(css, /\.utility-problem-exclusions-detail \.compact-data-table\s*\{[^}]*--cdt-row-padding: 10px 14px;/);
  assert.match(css, /@media \(max-width: 720px\)\s*\{\s*\.utility-problem-exclusions-detail \.compact-data-table\[data-cdt-mobile="stack"\]\s*\{\s*--cdt-row-padding: 10px;/);
});
