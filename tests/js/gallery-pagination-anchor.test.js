const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

function createHarness(GalleryRegressions) {
  const frames = new Map();
  const timers = new Map();
  const listeners = new Map();
  let nextId = 0;
  let rendered = false;
  const state = { view: { artist_groups: [{ albums: Array(8).fill({}) }] } };
  const card = {
    isConnected: true,
    getBoundingClientRect: () => rendered
      ? ({ top: 40, bottom: 140 })
      : ({ top: 600, bottom: 700 }),
  };
  const scroll = {
    scrollTop: 120,
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 480 }),
  };
  const context = {
    document: {
      getElementById: () => scroll,
      querySelectorAll: () => [card],
    },
    requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++nextId, callback); return nextId; },
    clearTimeout: id => timers.delete(id),
    state,
  };
  const ui = {
    page: { evaluateHandle: callback => vm.runInNewContext(`(${callback})`, context)() },
  };
  const runNext = (queue, argument) => {
    const entry = queue.entries().next().value;
    assert.ok(entry, 'expected queued callback');
    queue.delete(entry[0]);
    entry[1](argument);
  };
  return {
    card,
    frames,
    listeners,
    state,
    timers,
    capture: () => GalleryRegressions.prototype.captureVisibleGalleryAnchorOnNextScroll.call(ui),
    fireScroll: () => listeners.get('scroll')(),
    renderCard: () => { rendered = true; },
    runFrame: () => runNext(frames, 16),
    runDeadline: () => runNext(timers),
  };
}

async function loadGalleryRegressions() {
  return (await import(pathToFileURL(
    path.join(repoRoot, 'tests/e2e/poms/galleryRegressions.js'),
  ).href)).GalleryRegressions;
}

test('pagination anchor waits for a pre-merge card to render after native scroll', async () => {
  const harness = createHarness(await loadGalleryRegressions());
  const pending = harness.capture();

  harness.fireScroll();
  assert.equal(harness.frames.size, 1, 'the scroll handler must defer until the gallery paints');
  harness.runFrame();
  assert.equal(harness.frames.size, 1, 'the observer must keep waiting while no card intersects');
  harness.renderCard();
  harness.runFrame();

  const anchor = await pending;
  assert.equal(anchor.element, harness.card);
  assert.equal(anchor.loadedCount, 8);
  assert.equal(anchor.top, 40);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.listeners.has('scroll'), false);
});

test('pagination anchor deadline settles and removes the listener without a scroll event', async () => {
  const harness = createHarness(await loadGalleryRegressions());
  const pending = harness.capture();

  assert.equal(harness.timers.size, 1);
  harness.runDeadline();
  await assert.rejects(pending, /Timed out waiting for a pre-merge gallery anchor/);
  assert.equal(harness.listeners.has('scroll'), false);
});

test('pagination anchor deadline cancels a queued animation frame', async () => {
  const harness = createHarness(await loadGalleryRegressions());
  const pending = harness.capture();

  harness.fireScroll();
  assert.equal(harness.frames.size, 1);
  harness.runDeadline();
  await assert.rejects(pending, /Timed out waiting for a pre-merge gallery anchor/);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.listeners.has('scroll'), false);
});

test('pagination anchor rejects when continuation merges before a card renders', async () => {
  const harness = createHarness(await loadGalleryRegressions());
  const pending = harness.capture();

  harness.fireScroll();
  harness.state.view.artist_groups[0].albums.push({});
  harness.runFrame();
  await assert.rejects(pending, /merged before a pre-merge anchor rendered/);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.listeners.has('scroll'), false);
});
