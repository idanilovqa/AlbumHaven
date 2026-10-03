const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const actionsUrl = pathToFileURL(path.resolve(__dirname, '../e2e/actions/utilityProblematicFilesActions.js')).href;

function fixture({ horizontal = false, target = true, offset = 0 } = {}) {
  const items = Array.from({ length: 20 }, (_, index) => ({ key: String(index), title: 'Other', meta: 'Other · 2026' }));
  items[0] = { key: '0', title: 'Target', meta: 'Wrong artist · 2026' };
  if (target) items[12] = { key: '12', title: 'Target', meta: 'Exact artist · 2026' };
  const wheels = [], waits = [];
  const view = { horizontal, offset, viewport: 200, extent: 1360 };
  const list = { isVisible: async () => true, evaluate: async () => ({ ...view }), boundingBox: async () => ({ x: 10, y: 20, width: 200, height: 200 }) };
  const tab = { sidebar: { list }, sidebarListSelector: '#list',
    page: { mouse: { move: async () => {}, wheel: async (x, y) => {
      wheels.push([x, y]); view.offset = Math.max(0, Math.min(1160, view.offset + (horizontal ? x : y)));
    } } },
    waitForPageCondition: async (predicate, options, selectors) => {
      assert.ok(options.timeout > 0 && options.timeout <= 30000);
      assert.equal(selectors.target, view.offset);
      waits.push({ predicate, selectors });
    },
  };
  return { view, items, wheels, waits, owner: { utilityProblematicFilesTab: tab,
    readVisibleListItems: async () => items.slice(Math.floor(view.offset / 68), Math.ceil((view.offset + 200) / 68)) } };
}

for (const horizontal of [false, true]) {
  test(`native ${horizontal ? 'horizontal' : 'vertical'} traversal reveals only the exact title and artist/year`, async () => {
    const { UtilityProblematicFilesActions } = await import(actionsUrl);
    const { owner, wheels } = fixture({ horizontal, offset: 400 });
    Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
    const found = await UtilityProblematicFilesActions.prototype.revealListItemByIdentity.call(owner,
      { title: 'Target', meta: 'Exact artist · 2026' });
    assert.equal(found.key, '12');
    assert.deepEqual(wheels[0], horizontal ? [-400, 0] : [0, -400]);
    assert.ok(wheels.length > 2);
    assert.ok(wheels.every(([x, y]) => horizontal ? y === 0 : x === 0));
  });
}

test('native traversal reports an absent identity at the real boundary without choosing a similar row', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const { owner, view } = fixture({ target: false });
  Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
  await assert.rejects(UtilityProblematicFilesActions.prototype.revealListItemByIdentity.call(owner,
    { title: 'Target', meta: 'Exact artist · 2026' }), /Exact Problematic Files identity was not found/);
  assert.equal(view.offset, view.extent - view.viewport);
});

test('native traversal readiness requires both delivered scroll and mounted viewport coverage', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const { owner, waits } = fixture();
  Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
  await UtilityProblematicFilesActions.prototype.revealListItemByIdentity.call(owner,
    { title: 'Target', meta: 'Exact artist · 2026' });
  const { predicate, selectors } = waits[0];
  let offset = 0, lastBottom = 100;
  const row = bounds => ({ offsetHeight: 68, getBoundingClientRect: () => bounds });
  const node = { dataset: {}, get scrollTop() { return offset; },
    querySelectorAll: () => [row({ top: 0 }), row({ bottom: lastBottom })],
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }) };
  const run = () => require('node:vm').runInNewContext(`(${predicate.toString()})(selectors)`, {
    selectors, document: { querySelector: () => node },
  });
  assert.equal(run(), false);
  offset = selectors.target;
  assert.equal(run(), false);
  lastBottom = 400;
  assert.equal(run(), true);
});


test('complete native inventory preserves all identities and restores the initial scroll', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const { owner, view, items } = fixture({ offset: 400 });
  Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
  owner.readVisibleResultCount = async () => items.length;
  assert.deepEqual(await owner.readCompleteListItems(), items);
  assert.equal(view.offset, 400);
  owner.readVisibleResultCount = async () => items.length + 1;
  await assert.rejects(owner.readCompleteListItems(), /visible complete result count/);
});

test('native inventory rejects hidden lists rather than reading a hidden fallback', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const { owner, wheels } = fixture();
  Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
  owner.utilityProblematicFilesTab.sidebar.list.isVisible = async () => false;
  await assert.rejects(owner.revealListItemByIdentity({ title: 'Target', meta: 'Exact artist · 2026' }), /visible list/);
  assert.deepEqual(wheels, []);
});

test('navigation render oracle counts root replacements without treating nested updates as replacements', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const child = {};
  const detail = { textContent: 'Exact detail', querySelector: () => ({ textContent: 'Exact title' }), contains: target => target === child };
  const list = { scrollTop: 0, querySelectorAll: () => mountedActive ? [mountedActive] : [] };
  const active = { getAttribute: () => 'exact-key' };
  let mountedActive = active;
  let capture;
  const context = {
    state: { utility: { selectedProblematicKey: 'exact-key' } },
    getSelectedProblematicAlbum: () => ({ key: 'exact-key' }),
    document: { querySelector: selector => ({ '#detail': detail, '#list': list, '#active': mountedActive })[selector] },
    MutationObserver: class { constructor(callback) { capture = callback; } observe() {} },
  };
  const owner = { utilityProblematicFilesTab: { detailScrollerSelector: '#detail', sidebarListSelector: '#list',
    activeListItemSelector: '#active', listItemSelector: '.row', detailTitleSelector: '.title', page: {
      evaluateHandle: async (callback, selectors) => require('node:vm').runInNewContext(`(${callback.toString()})(selectors)`, { ...context, selectors }),
    } } };
  await UtilityProblematicFilesActions.prototype.startNavigationRenderObservation.call(owner);
  capture([{ type: 'childList', target: list }]);
  capture([{ type: 'attributes', target: detail }]);
  assert.equal(owner.navigationObservation.records.filter(row => row.detailRender).length, 0);
  capture([{ type: 'childList', target: detail }]);
  assert.equal(owner.navigationObservation.records.filter(row => row.detailRender).length, 1);
  capture([{ type: 'characterData', target: child }, { type: 'childList', target: child }]);
  assert.equal(owner.navigationObservation.records.filter(row => row.detailRender).length, 1,
    'nested content updates remain diagnostics, not root replacements');
  const { expectProblematicNavigationRecords } = await import('../e2e/helpers/problematicNavigationEvidence.js');
  assert.doesNotThrow(() => expectProblematicNavigationRecords(owner.navigationObservation.records, 'exact-key', 'Exact title'));
  mountedActive = null;
  capture([{ type: 'childList', target: list }]);
  const unmounted = owner.navigationObservation.records.at(-1);
  assert.equal(unmounted.activeKey, '');
  assert.equal(unmounted.selectedKey, 'exact-key');
  assert.equal(unmounted.runtimeKey, 'exact-key');
  assert.equal(unmounted.selectedRowMounted, false);
  assert.equal(unmounted.detailMutation, false);
  capture([{ type: 'attributes', target: detail }]);
  assert.equal(owner.navigationObservation.records.at(-1).detailMutation, false, 'style and attributes are not content replacements');
  assert.doesNotThrow(() => expectProblematicNavigationRecords(owner.navigationObservation.records, 'exact-key', 'Exact title'));
  mountedActive = active;
  const before = owner.navigationObservation.records.length;
  capture([{ type: 'childList', target: detail }, { type: 'childList', target: detail }]);
  const batched = owner.navigationObservation.records.slice(before);
  assert.equal(batched.length, 1);
  assert.equal(batched[0].detailRenderCount, 2, 'two batched replacements cannot collapse into one render');
  assert.throws(() => expectProblematicNavigationRecords(batched, 'exact-key', 'Exact title'));
  assert.throws(() => expectProblematicNavigationRecords(owner.navigationObservation.records, 'exact-key', 'Exact title'));
});


test('continuity observer exposes mutations on the same retained snapshot', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const row = key => ({ getAttribute: () => key, textContent: key,
    querySelector: () => ({ textContent: key }) });
  const previous = row('previous'), active = row('active');
  const items = [previous, active];
  class Element {}
  const list = Object.assign(new Element(), { scrollTop: 4 });
  let capture;
  const owner = { readSearchQuery: async () => '', utilityProblematicFilesTab: {
    waitForSearchProjection: async (_term, options) => assert.equal(options.requireSettledRange, true),
    activeListItem: { count: async () => 1, scrollIntoViewIfNeeded: async () => {} },
    sidebarListSelector: '#list', activeListItemSelector: '#active', listItemSelector: '.row',
    listItemTitleSelector: '.title', listItemMetaSelector: '.meta',
    page: { evaluateHandle: async (callback, selectors) => {
      const snapshot = require('node:vm').runInNewContext(`(${callback.toString()})(selectors)`, {
        selectors, HTMLElement: Element,
        document: { querySelector: selector => selector === '#list' ? list : active, querySelectorAll: () => items },
        MutationObserver: class { constructor(fn) { capture = fn; } observe() {} disconnect() {} },
      });
      return { evaluate: async fn => fn(snapshot) };
    } },
  } };
  await UtilityProblematicFilesActions.prototype.prepareSelectedMutationContinuity.call(owner);
  assert.equal(await owner.mutationObservation.evaluate(snapshot => snapshot.listMutations), 0);
  capture();
  assert.equal(await owner.mutationObservation.evaluate(snapshot => snapshot.listMutations), 1);
  capture();
  assert.equal(await owner.mutationObservation.evaluate(snapshot => snapshot.listMutations), 2);
});


test('complete inventory preserves both native traversal and owned scroll restoration errors', async () => {
  const { UtilityProblematicFilesActions } = await import(actionsUrl);
  const { owner } = fixture({ offset: 400 });
  Object.setPrototypeOf(owner, UtilityProblematicFilesActions.prototype);
  const mouse = owner.utilityProblematicFilesTab.page.mouse;
  const nativeWheel = mouse.wheel;
  const primary = new Error('native traversal failed');
  const cleanup = new Error('native restoration failed');
  let calls = 0;
  mouse.wheel = async (...args) => {
    calls += 1;
    if (calls === 2) throw primary;
    if (calls === 3) throw cleanup;
    return nativeWheel(...args);
  };
  await assert.rejects(owner.readCompleteListItems(), error => (
    error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup
  ));
  assert.equal(calls, 3, 'owned scroll restoration is attempted after the primary failure');
});


test('exact navigation evidence rejects missing replacements and transient wrong identities', async () => {
  const { expectProblematicNavigationRecords } = await import('../e2e/helpers/problematicNavigationEvidence.js');
  const record = { detailRender: true, detailRenderCount: 1, activeKey: 'chosen', selectedKey: 'chosen', runtimeKey: 'chosen', selectedRowMounted: true, detailMutation: true, detailTitle: 'Chosen album', detailText: 'Track' };
  assert.doesNotThrow(() => expectProblematicNavigationRecords([record], 'chosen', 'Chosen album'));
  const offscreen = { ...record, detailRender: false, detailRenderCount: 0, activeKey: '', selectedRowMounted: false, detailMutation: false };
  assert.doesNotThrow(() => expectProblematicNavigationRecords([record, offscreen], 'chosen', 'Chosen album'));
  for (const records of [
    [], [{ ...record, detailRenderCount: 2 }],
    [record, { ...offscreen, selectedRowMounted: true }], [record, { ...offscreen, selectedRowMounted: undefined }],
    [record, { ...offscreen, detailMutation: true }], [record, { ...offscreen, detailMutation: undefined }], [{ ...record, detailTitle: '' }],
    [{ ...record, activeKey: '' }], [{ ...record, detailRenderCount: undefined }],
    [record, { ...offscreen, selectedKey: '' }], [record, { ...offscreen, selectedKey: 'wrong' }],
    [record, { ...offscreen, runtimeKey: '' }], [record, { ...offscreen, runtimeKey: 'wrong' }],
    [record, { ...record, detailRender: false, detailRenderCount: 0, activeKey: 'wrong' }],
    [record, { ...record, detailRender: false, detailRenderCount: 0, detailTitle: 'Wrong album' }],
  ]) assert.throws(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
});
