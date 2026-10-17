const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const test = require('node:test');

const importFile = (file) => import(pathToFileURL(path.resolve(__dirname, '../e2e', file)).href);

function summaryResponsePage() {
  const response = (url) => ({
    url: () => url, ok: () => true, finished: async () => null,
    request: () => ({ failure: () => null, timing: () => ({ startTime: 1000, responseEnd: 25 }) }),
    json: async () => ({ items: [], count: 0 }),
  });
  const responses = [response('http://localhost/utilities/problematic-files?limit=50'),
    response('http://localhost/utilities/problematic-files')];
  return {
    evaluate: async () => ({ sequence: 0, preemptions: [] }),
    waitForResponse: async (predicate) => {
      const selected = responses.find(predicate);
      assert.ok(selected, 'Request predicate must identify a native bounded/full summary response');
      return selected;
    },
  };
}

test('PF first-visible timing shares the click boundary and does not replace full readiness', async (t) => {
  const { measureProblematicFilesSettingsOpenWithNetworkEvidence } = await importFile('helpers/utilityPerformanceHelpers.js');
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const events = [];
  const waitOptions = [];
  let releaseReady;
  const fullReady = new Promise((resolve) => { releaseReady = resolve; });
  const page = {
    ...summaryResponsePage(),
    on: () => events.push('listen'), off: () => events.push('unlisten'),
  };
  const pending = measureProblematicFilesSettingsOpenWithNetworkEvidence(page, {
    prepareToOpenSettings: async () => { now = 1000; },
    openSettings: async () => { events.push('click'); now = 1040; },
  }, {
    waitForFirstVisible: async (options) => {
      waitOptions.push(['visible', options]);
      events.push('visible');
      now = 1060;
    },
    waitForReady: async (options) => {
      waitOptions.push(['full', options]);
      events.push('full');
      await fullReady;
      now = 1400;
    },
  });
  await new Promise(setImmediate);
  try {
    assert.ok(events.includes('visible'), 'Visible evidence must be observed before full readiness settles');
    assert.ok(events.indexOf('click') < events.indexOf('visible'), 'Old pre-click content cannot fulfill the observation');
  } finally {
    releaseReady();
  }
  const result = await pending;
  assert.equal(result.firstVisibleMs, 60);
  assert.equal(result.readyMs, 400);
  assert.deepEqual(waitOptions, [
    ['visible', { timeout: 120000, requirePopulated: true }],
    ['full', { timeout: 120000, requirePopulated: true }],
  ]);
  assert.equal(events.at(-1), 'unlisten');
});

test('PF first-visible evidence is retained when full readiness fails', async () => {
  const { measureProblematicFilesSettingsOpenWithNetworkEvidence } = await importFile('helpers/utilityPerformanceHelpers.js');
  const readyFailure = new Error('Authoritative full readiness failed');
  let retainedFirstVisibleMs;
  const listeners = new Set();
  const page = {
    ...summaryResponsePage(),
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
  };
  await assert.rejects(measureProblematicFilesSettingsOpenWithNetworkEvidence(page, {
    prepareToOpenSettings: async () => {}, openSettings: async () => {},
  }, {
    waitForFirstVisible: async () => {},
    waitForReady: async () => { throw readyFailure; },
  }, {
    onFirstVisible: (elapsed) => { retainedFirstVisibleMs = elapsed; },
  }), (error) => error === readyFailure);
  assert.equal(typeof retainedFirstVisibleMs, 'number');
  assert.equal(listeners.size, 0);
});

test('PF full-ready failure remains authoritative when both readiness checks fail', async () => {
  const { measureProblematicFilesSettingsOpenWithNetworkEvidence } = await importFile('helpers/utilityPerformanceHelpers.js');
  const visibleFailure = new Error('Auxiliary first-visible observation failed');
  const readyFailure = new Error('Authoritative full readiness failed');
  const page = {
    ...summaryResponsePage(),
    on: () => {}, off: () => {},
  };
  await assert.rejects(measureProblematicFilesSettingsOpenWithNetworkEvidence(page, {
    prepareToOpenSettings: async () => {}, openSettings: async () => {},
  }, {
    waitForFirstVisible: async () => { throw visibleFailure; },
    waitForReady: async () => { throw readyFailure; },
  }), (error) => error === readyFailure);
});

test('PF first-visible failure is retained and network listener is removed', async () => {
  const { measureProblematicFilesSettingsOpenWithNetworkEvidence } = await importFile('helpers/utilityPerformanceHelpers.js');
  const failure = new Error('Visible populated PF never appeared');
  const listeners = new Set();
  const page = {
    ...summaryResponsePage(),
    on: (_event, listener) => listeners.add(listener), off: (_event, listener) => listeners.delete(listener),
  };
  await assert.rejects(measureProblematicFilesSettingsOpenWithNetworkEvidence(page, {
    prepareToOpenSettings: async () => {}, openSettings: async () => {},
  }, {
    waitForFirstVisible: async () => { throw failure; }, waitForReady: async () => {},
  }), (error) => error === failure);
  assert.equal(listeners.size, 0);
});

test('PF first-visible predicate rejects hidden, covered, inactive and temporary empty content', async () => {
  const { UtilityProblematicFilesActions } = await importFile('actions/utilityProblematicFilesActions.js');
  const { UtilityProblematicFilesTab } = await importFile('poms/utilityProblematicFilesTab.js');
  const pf = Object.create(UtilityProblematicFilesTab.prototype);
  const selectors = {
    modalSelector: pf.modalSelector,
    activeTabSelector: pf.activeTabSelector,
    listItemSelector: pf.listItemSelector, activeListItemSelector: pf.activeListItemSelector,
    detailTitleSelector: pf.detailTitleSelector, listEmptyStateSelector: pf.listEmptyStateSelector,
    detailEmptyStateSelector: pf.detailEmptyStateSelector,
  };
  let predicate, expected;
  const action = new UtilityProblematicFilesActions({ ...selectors,
    waitForPageCondition: async (callback, _options, argument) => { predicate = callback; expected = argument; },
  });
  assert.equal(typeof action.waitForFirstVisible, 'function');
  await action.waitForFirstVisible({ timeout: 5000 });
  function scenario({ hidden = false, visibility = 'visible', covered = false, active = true, populated = true, loading = true, outsideSurface = false, firstItemOffscreen = false } = {}) {
    const node = (left, text = '') => {
      const element = { textContent: text, hidden: false, parentElement: null,
        style: { display: 'block', visibility: 'visible', opacity: '1' },
        getBoundingClientRect: () => ({ left, top: 20, right: left + 100, bottom: 60, width: 100, height: 40 }),
        getClientRects: () => [1], offsetWidth: 100, offsetHeight: 40,
        getAttribute: (name) => name === 'aria-selected' ? String(active)
          : name === 'data-utility-tab' ? (active ? 'problematic-files' : 'rules') : null,
        classList: { contains: () => active },
        contains: (other) => {
          for (let current = other; current; current = current.parentElement) if (current === element) return true;
          return false;
        },
        checkVisibility: () => !hidden && visibility === 'visible',
      };
      return element;
    };
    const modal = node(0), tab = node(120), row = node(240, 'Album'), title = node(400, 'Album');
    const firstRow = firstItemOffscreen ? node(-200, 'Overscan album') : row;
    modal.hidden = hidden; modal.style.visibility = visibility;
    row.parentElement = title.parentElement = outsideSurface ? null : modal;
    tab.parentElement = modal;
    const listEmpty = node(240, 'No problematic files'), detailEmpty = node(400, 'No problematic files');
    listEmpty.parentElement = detailEmpty.parentElement = modal;
    const lookup = new Map([[selectors.modalSelector, modal], [selectors.activeTabSelector, active ? tab : null],
      [selectors.listItemSelector, populated ? firstRow : null], [selectors.activeListItemSelector, populated ? row : null],
      [selectors.detailTitleSelector, populated ? title : null],
      [selectors.listEmptyStateSelector, populated ? null : listEmpty],
      [selectors.detailEmptyStateSelector, populated ? null : detailEmpty]]);
    const renderedNodes = [modal, tab, ...(populated ? [row, title] : [listEmpty, detailEmpty])];
    const hits = (x) => covered ? [{}] : renderedNodes.filter((element) => {
      const rect = element.getBoundingClientRect(); return x >= rect.left && x < rect.right;
    });
    const document = { querySelector: (selector) => lookup.get(selector) || null,
      elementsFromPoint: (x) => hits(x), elementFromPoint: (x) => hits(x)[0] || null,
      documentElement: { clientWidth: 1000, clientHeight: 800 } };
    modal.querySelector = (selector) => {
      const element = document.querySelector(selector);
      return modal.contains(element) ? element : null;
    };
    modal.querySelectorAll = (selector) => selector === selectors.listItemSelector && populated
      ? [firstRow, row]
      : [];
    return Boolean(vm.runInNewContext(`(${predicate.toString()})(expected)`, {
      expected, document, state: { utility: { loading, activeTab: active ? 'problematic-files' : 'rules' } },
      getComputedStyle: (element) => element.style, innerWidth: 1000, innerHeight: 800,
      window: { innerWidth: 1000, innerHeight: 800 },
    }));
  }
  assert.equal(scenario(), true, 'Populated preview is visible even while full summary is loading');
  assert.equal(scenario({ firstItemOffscreen: true }), true, 'A virtual-list overscan row cannot hide visible populated content');
  assert.equal(scenario({ hidden: true }), false);
  assert.equal(scenario({ visibility: 'hidden' }), false);
  assert.equal(scenario({ covered: true }), false);
  assert.equal(scenario({ active: false }), false);
  assert.equal(scenario({ outsideSurface: true }), false, 'Detached old PF selection/detail cannot satisfy the active modal');
  assert.equal(scenario({ populated: false, loading: true }), false);
  assert.equal(scenario({ populated: false, loading: false }), true);
});
