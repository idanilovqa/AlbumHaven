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
      counter.count('timers');
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  for (const name of ['utility-renderers-and-actions.js', 'track-modal-and-gallery.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
  }
  context.filterUtilityLoopViews = () => {
    filterRuns.push(context.state.utility.loopsSearchQuery);
    counter.count('renderCommits');
  };
  context.attachUtilityModalEvents();
  return { counter, listeners, els, timers, filterRuns };
}

async function keystroke(activeTab, loopCount) {
  const { counter, listeners, els } = loadUtilitySearch(loopCount, activeTab);
  return counter.measure(() => {
    els.search.value = 'loop 1';
    listeners.input();
  });
}

for (const activeTab of ['loops', 'rules', 'problematic-files']) {
  test(`BI Utility search keystroke stores the query without scanning the list (${activeTab})`, async () => {
    await measureScalePair({
      id: 'js:runtime/track-modal-and-gallery.js#attachUtilityModalEvents',
      small: 20,
      large: 1000,
      run: count => keystroke(activeTab, count),
      budgets: { itemsVisited: 0, renderCommits: 0, timers: 1 },
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
