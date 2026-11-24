const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  countedCollection,
  createInteractionCounter,
  measureScalePair,
} = require('../helpers/bounded-interaction-counter');

const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');

// The real Utility search listener with an instrumented saved-loop list and
// timer seam; the loops tab's filter view is observed, not re-implemented.
function loadUtilitySearch(loopCount, activeTab) {
  const counter = createInteractionCounter();
  const listeners = {};
  const timers = [];
  // Timers armed and not yet cleared: a debounce that clears its pending timer before arming keeps one.
  const live = new Set();
  const peak = { live: 0 };
  const filterRuns = [];
  const loops = Array.from({ length: loopCount }, (_, index) => ({
    id: `loop-${index}`, name: `Loop ${index}`, title: `Song ${index}`, artist: 'Artist', album: 'Album',
  }));
  const els = {
    overlay: { hidden: false, dataset: {}, addEventListener() {} },
    search: { value: '', addEventListener: (name, listener) => { listeners[name] = listener; } },
    list: { scrollTop: 0, querySelectorAll: () => [], querySelector: () => null },
    count: {},
    detail: {},
  };
  const context = vm.createContext({
    state: { utility: { activeTab, loops: countedCollection(loops, counter) } },
    getUtilityModalElements: () => els,
    bindOverlayPointerOrigin() {},
    closeUtilityModal() {},
    renderUtilityModalContent: () => counter.count('renderCommits'),
    setTimeout: (callback) => {
      timers.push(callback);
      live.add(timers.length);
      peak.live = Math.max(peak.live, live.size);
      return timers.length;
    },
    clearTimeout: (id) => { live.delete(id); },
  });
  context.window = { setTimeout: context.setTimeout, clearTimeout: context.clearTimeout };
  // The real Problematic Files search scheduler (the loaders) and the timers it schedules with: the bundle
  // carries both, and the Problematic Files keystroke reaches them.
  for (const name of [
    'browser-scheduling-helpers.js', 'utility-loaders-and-cover-lookup.js',
    'utility-renderers-and-actions.js', 'track-modal-and-gallery.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  }
  context.filterUtilityLoopViews = () => {
    filterRuns.push(context.state.utility.loopsSearchQuery);
    counter.count('renderCommits');
  };
  context.attachUtilityModalEvents();
  return { counter, listeners, els, timers, filterRuns, live, peak };
}

// The registry budget is the Problematic Files tab's two debounces (the shared render debounce and the
// server-search debounce); every other tab keeps one.
const LIVE_TIMERS = { loops: 1, rules: 1, 'problematic-files': 2 };

async function keystroke(activeTab, loopCount) {
  const { counter, listeners, els, live, peak } = loadUtilitySearch(loopCount, activeTab);
  const measured = await counter.measure(() => {
    live.clear();
    peak.live = 0;
    // Three keystrokes: each debounce replaces its pending timer instead of stacking another.
    for (const value of ['lo', 'loop', 'loop 1']) {
      els.search.value = value;
      listeners.input();
    }
    counter.count('timers', peak.live);
  });
  assert.equal(measured.timers, LIVE_TIMERS[activeTab], `${activeTab}: live timers after three keystrokes`);
  return measured;
}

for (const activeTab of ['loops', 'rules', 'problematic-files']) {
  test(`BI Utility search keystroke stores the query without scanning the list (${activeTab})`, async () => {
    await measureScalePair({
      id: 'js:runtime/track-modal-and-gallery.js#attachUtilityModalEvents',
      small: 20,
      large: 1000,
      run: count => keystroke(activeTab, count),
      budgets: { itemsVisited: 0, renderCommits: 0, timers: 2 },
      growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
    });
  });
}

test('typing in the loops search coalesces into one filter run with the last query', async () => {
  const { listeners, els, timers, filterRuns } = loadUtilitySearch(1000, 'loops');
  for (const value of ['l', 'lo', 'loo', 'loop', 'loop 1']) {
    els.search.value = value;
    listeners.input();
  }
  assert.deepEqual(filterRuns, []);
  await timers.at(-1)();
  assert.deepEqual(filterRuns, ['loop 1']);
});
