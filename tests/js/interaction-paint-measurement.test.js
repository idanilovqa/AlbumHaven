const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

function browserFixture() {
  let now = 10;
  const observers = [];
  const handles = [];
  const browser = vm.createContext({
    performance: { now: () => now },
    requestAnimationFrame(callback) { now += 16; callback(); },
    PerformanceObserver: class {
      static supportedEntryTypes = ['longtask'];
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      takeRecords() { return [{ duration: 25 }]; }
      disconnect() { this.disconnected = true; }
    },
  });
  const page = {
    evaluate() { throw new Error('measurement must not use page globals'); },
    async evaluateHandle(callback) {
      const value = vm.runInContext(`(${callback.toString()})()`, browser);
      const handle = {
        async evaluate(read) {
          return vm.runInContext(`(${read.toString()})`, browser)(value);
        },
        async dispose() { this.disposed = true; },
      };
      handles.push(handle);
      return handle;
    },
  };
  return { page, observers, handles, advance(ms) { now += ms; } };
}

test('interaction timing uses an isolated handle and includes action, readiness, and paint', async () => {
  const { measureInteractionToPaint } = await import('../e2e/helpers/performanceHelpers.js');
  const f = browserFixture();
  const result = await measureInteractionToPaint(f.page, () => {
    f.advance(10);
    f.observers[0].callback({ getEntries: () => [{ duration: 70 }] });
  }, () => f.advance(5));
  assert.equal(result.durationMs, 47);
  assert.equal(result.longTaskCount, 2);
  assert.equal(result.maxLongTaskMs, 70);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.handles[0].disposed, true);
});

test('overlapping interaction measurements retain separate samples and cleanup', async () => {
  const { measureInteractionToPaint } = await import('../e2e/helpers/performanceHelpers.js');
  const f = browserFixture();
  let releaseFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const first = measureInteractionToPaint(f.page, () => {
    f.observers[0].callback({ getEntries: () => [{ duration: 90 }] });
    firstStarted();
    return held;
  });
  await started;
  const second = await measureInteractionToPaint(f.page, () => {
    f.observers[1].callback({ getEntries: () => [{ duration: 45 }] });
  });
  assert.equal(second.maxLongTaskMs, 45);
  assert.equal(f.observers[0].disconnected, undefined);
  assert.equal(f.handles[0].disposed, undefined);
  assert.equal(f.observers[1].disconnected, true);
  releaseFirst();
  assert.equal((await first).maxLongTaskMs, 90);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.handles.every(handle => handle.disposed), true);
});

for (const failingPhase of ['action', 'readiness']) {
  test(`interaction timing preserves ${failingPhase} failure and releases its observer`, async () => {
    const { measureInteractionToPaint } = await import('../e2e/helpers/performanceHelpers.js');
    const f = browserFixture();
    const failure = new Error(failingPhase);
    const fail = () => { throw failure; };
    await assert.rejects(measureInteractionToPaint(
      f.page,
      failingPhase === 'action' ? fail : () => {},
      failingPhase === 'readiness' ? fail : null,
    ), error => error === failure);
    assert.equal(f.observers[0].disconnected, true);
    assert.equal(f.handles[0].disposed, true);
  });
}
