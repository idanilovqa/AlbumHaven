const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime',
  'loop-edit-session-expiry.js',
);

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, dueAt: now + Number(delay || 0) });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
      }
      now = target;
    },
    elapseWithoutRunningTimers(milliseconds) {
      now += milliseconds;
    },
    nowFn() {
      return now;
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function loadController(options = {}) {
  const scheduler = createScheduler();
  const context = {
    console,
    Date: { now: () => 0 },
    setTimeout: scheduler.setTimeoutFn,
    clearTimeout: scheduler.clearTimeoutFn,
  };
  vm.createContext(context);
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  vm.runInContext(source, context, { filename: sourcePath });
  assert.equal(
    typeof context.createLoopEditSessionExpiryController,
    'function',
    'the shared loop-edit expiry controller must exist',
  );
  return {
    scheduler,
    context,
    controller: context.createLoopEditSessionExpiryController({
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: scheduler.clearTimeoutFn,
      ...(options.useDefaultNowFn ? {} : { nowFn: scheduler.nowFn }),
    }),
  };
}

function normalizeExpirations(expirations) {
  return expirations.map(({ ownerId, reason }) => ({ ownerId, reason }));
}

test('loop edit session expires after five inactive minutes and a boundary edit renews the full lease', () => {
  const { controller, scheduler } = loadController();
  const expirations = [];
  controller.start({ ownerId: 'global-player', onExpire: (event) => expirations.push(event) });

  scheduler.advance(299999);
  assert.deepEqual(expirations, []);
  assert.equal(controller.has('global-player'), true);

  controller.renewAfterBoundaryEdit('global-player');
  scheduler.advance(299999);
  assert.deepEqual(expirations, []);

  scheduler.advance(1);
  assert.deepEqual(normalizeExpirations(expirations), [{ ownerId: 'global-player', reason: 'inactive' }]);
  assert.equal(controller.has('global-player'), false);
  assert.equal(scheduler.pendingCount(), 0);
});

test('reconciliation expires a session whose wall-clock deadline passed while timers were suspended', () => {
  const { controller, scheduler } = loadController();
  const expirations = [];
  controller.start({ ownerId: 'global-player', onExpire: (event) => expirations.push(event) });

  scheduler.elapseWithoutRunningTimers(300000);
  assert.deepEqual(expirations, []);
  assert.equal(controller.has('global-player'), true);

  assert.equal(controller.reconcile(), 1);
  assert.deepEqual(normalizeExpirations(expirations), [{ ownerId: 'global-player', reason: 'inactive' }]);
  assert.equal(controller.has('global-player'), false);
  assert.equal(scheduler.pendingCount(), 0);
});

test('the default wall clock is resolved dynamically after browser clock installation', () => {
  const { context, controller } = loadController({ useDefaultNowFn: true });
  const expirations = [];
  controller.start({ ownerId: 'global-player', onExpire: (event) => expirations.push(event) });

  context.Date.now = () => 300000;
  assert.equal(controller.reconcile(), 1);
  assert.deepEqual(normalizeExpirations(expirations), [{ ownerId: 'global-player', reason: 'inactive' }]);
});

test('untouched whole range remains active at thirteen seconds and expires at exactly fifteen', () => {
  const { controller, scheduler } = loadController();
  const expirations = [];
  controller.start({ ownerId: 'saved-loop-1', onExpire: (event) => expirations.push(event) });

  assert.equal(controller.noteUntouchedWholeRangeWrap('saved-loop-1'), true);
  assert.equal(controller.noteUntouchedWholeRangeWrap('saved-loop-1'), false);
  scheduler.advance(13000);
  assert.deepEqual(expirations, []);

  scheduler.advance(2000);
  assert.deepEqual(normalizeExpirations(expirations), [{
    ownerId: 'saved-loop-1',
    reason: 'untouched-whole-range',
  }]);
  assert.equal(controller.has('saved-loop-1'), false);
});

test('first boundary edit permanently disables the early whole-range expiry for that session', () => {
  const { controller, scheduler } = loadController();
  const expirations = [];
  controller.start({ ownerId: 'global-player', onExpire: (event) => expirations.push(event) });
  controller.noteUntouchedWholeRangeWrap('global-player');

  controller.renewAfterBoundaryEdit('global-player');
  assert.equal(controller.noteUntouchedWholeRangeWrap('global-player'), false);
  scheduler.advance(15000);
  assert.deepEqual(expirations, []);

  scheduler.advance(285000);
  assert.deepEqual(normalizeExpirations(expirations), [{ ownerId: 'global-player', reason: 'inactive' }]);
});

test('stopped and replaced sessions cannot expire a newer session', () => {
  const { controller, scheduler } = loadController();
  const expirations = [];
  controller.start({ ownerId: 'saved-loop-1', onExpire: () => expirations.push('old') });
  assert.equal(controller.stop('saved-loop-1'), true);
  assert.equal(controller.stop('saved-loop-1'), false);

  controller.start({ ownerId: 'saved-loop-1', onExpire: () => expirations.push('replaced') });
  scheduler.advance(100000);
  controller.start({ ownerId: 'saved-loop-1', onExpire: () => expirations.push('current') });
  scheduler.advance(200000);
  assert.deepEqual(expirations, []);
  scheduler.advance(100000);
  assert.deepEqual(expirations, ['current']);
  assert.equal(scheduler.pendingCount(), 0);
});
