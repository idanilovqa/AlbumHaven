const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const helperUrl = pathToFileURL(path.join(__dirname, '../e2e/poms/interactionSurfaces.js')).href;

async function observeFrames({ correctedOffset = 0, deliverResize = true, hiddenFrame = -1 } = {}) {
  const { expectAnchorFollowsUnfold } = await import(helperUrl);
  const frames = [];
  let resizeCallback;
  let offset = 12;
  let hidden = false;
  let frameCount = 0;
  let disconnected = false;
  let clicks = 0;
  const trigger = { getBoundingClientRect: () => ({ left: offset }), parentElement: {} };
  const panel = { get hidden() { return hidden; }, getBoundingClientRect: () => ({ left: 0, width: 100, height: 100 }) };
  const browser = {
    document: { querySelector: () => trigger },
    getComputedStyle: () => ({ visibility: 'visible', getPropertyValue: () => '0' }),
    requestAnimationFrame: callback => frames.push(callback),
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  };
  const surfaces = {
    familyPanel: { evaluate: callback => vm.runInNewContext(`(${callback.toString()})`, browser)(panel) },
    viewTrigger: { click: async () => {
      clicks += 1;
      if (clicks > 1) return;
      while (frames.length) {
        offset = 12;
        hidden = frameCount === hiddenFrame;
        frames.shift()();
        frameCount += 1;
        if (!disconnected && deliverResize) {
          offset = correctedOffset;
          resizeCallback();
        }
      }
    } },
  };
  await expectAnchorFollowsUnfold(null, surfaces);
  return { frameCount, disconnected, clicks };
}

test('anchor samples finalize 24 frames after same-render resize correction', async () => {
  assert.deepEqual(await observeFrames(), { frameCount: 25, disconnected: true, clicks: 2 });
});
test('anchor samples reject a nonzero post-layout join instead of replacing it with success', async () => {
  await assert.rejects(observeFrames({ correctedOffset: 4 }), /toBeLessThanOrEqual/);
});
test('anchor samples retain an uncorrected provisional failure when no resize arrives', async () => {
  await assert.rejects(observeFrames({ deliverResize: false }), /toBeLessThanOrEqual/);
});
test('anchor samples reject any hidden rendered frame', async () => {
  await assert.rejects(observeFrames({ hiddenFrame: 7 }), /toBe/);
});
