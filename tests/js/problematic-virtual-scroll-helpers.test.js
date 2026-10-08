const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const vm = require('node:vm');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../e2e/helpers/problematicVirtualScrollHelpers.js')).href);

function payload() {
  return { key: 'artist::album', name: 'Original album', tracks: [{ path: '/one' }, { path: '/two' }],
    track_problem_rows: [{ path: '/one', reasons: ['Missing track title'] }],
    album_problem_rows: [{ reason: 'Missing year', display_reason: 'Other label' }],
    suggested_edits: [{ id: 'proposal-two', path: '/two', eligible: true }] };
}
function actual(expected) {
  return { activeKey: expected.key, selectedKey: expected.key, runtimeKey: expected.key,
    title: expected.title, headingVisible: true, trackPaths: [...expected.trackPaths],
    renderedPaths: [...expected.renderedPaths], visibleRenderedPaths: [...expected.renderedPaths],
    albumReasons: [...expected.albumReasons], emptyText: expected.emptyText,
    convertedText: 'Converted tags', convertedPressed: 'true' };
}

test('problem oracle includes eligible proposal-only rows and leaves response bytes untouched', async () => {
  const { problemDetailExpectation } = await load();
  const response = payload();
  response.track_problem_rows.push({ path: '/cover-only', reasons: ['Missing cover art'] });
  response.suggested_edits.push({ id: 'ineligible', path: '/excluded', eligible: false });
  const before = JSON.stringify(response);
  const expected = problemDetailExpectation(response);
  assert.deepEqual(expected.renderedPaths, ['/one', '/two']);
  assert.deepEqual(expected.trackPaths, ['/one', '/two']);
  assert.deepEqual(expected.albumReasons, ['Missing year']);
  assert.equal(JSON.stringify(response), before);
});

test('Converted tags uses repaired title while an unrepaired detail keeps its original title', async () => {
  const { problemDetailExpectation, expectProblematicRenderedIdentity } = await load();
  const response = payload();
  response.has_encoding_repairs = true;
  response.repair_preview_rows = [{ field: 'album', original: 'Original album', repaired: 'Repaired album' }];
  const expected = problemDetailExpectation(response);
  assert.equal(expected.title, 'Repaired album');
  assert.equal(expected.hasEncodingRepairs, true);
  assert.doesNotThrow(() => expectProblematicRenderedIdentity(actual(expected), response, expected));
  assert.throws(() => expectProblematicRenderedIdentity({ ...actual(expected), convertedPressed: 'false' }, response, expected));
  assert.throws(() => expectProblematicRenderedIdentity({ ...actual(expected), convertedText: 'Original tags' }, response, expected));
  const unchanged = problemDetailExpectation(payload());
  assert.equal(unchanged.title, 'Original album');
  assert.equal(unchanged.hasEncodingRepairs, false);
});

for (const [label, change] of [
  ['empty rendered rows', value => { value.renderedPaths = []; }],
  ['hidden rendered rows', value => { value.visibleRenderedPaths = []; }],
  ['hidden heading', value => { value.headingVisible = false; }],
  ['missing track', value => { value.trackPaths = ['/one']; }],
  ['wrong track', value => { value.renderedPaths = ['/one', '/wrong']; }],
  ['duplicate rendered track', value => { value.renderedPaths = ['/one', '/two', '/one']; }],
  ['duplicate visible track', value => { value.visibleRenderedPaths = ['/one', '/one']; }],
  ['foreign visible track', value => { value.visibleRenderedPaths = ['/one', '/wrong']; }],
  ['wrong active key', value => { value.activeKey = 'wrong'; }],
  ['blank selected key', value => { value.selectedKey = ''; }],
  ['wrong runtime key', value => { value.runtimeKey = 'wrong'; }],
  ['wrong title', value => { value.title = 'Other album'; }],
]) {
  test(`problem identity rejects ${label} without choosing an easier expected window`, async () => {
    const { problemDetailExpectation, expectProblematicRenderedIdentity } = await load();
    const response = payload();
    const expected = problemDetailExpectation(response);
    assert.doesNotThrow(() => expectProblematicRenderedIdentity(actual(expected), response, expected));
    const observed = actual(expected);
    change(observed);
    assert.throws(() => expectProblematicRenderedIdentity(observed, response, expected));
  });
}

test('album-only empty state requires its predetermined reasons and excludes visible phantom paths', async () => {
  const { problemDetailExpectation, expectProblematicRenderedIdentity } = await load();
  const response = { key: 'folder-only', name: 'Folder only', tracks: [], problem_reasons: ['Missing cover art'] };
  const expected = problemDetailExpectation(response);
  assert.doesNotThrow(() => expectProblematicRenderedIdentity(actual(expected), response, expected, false));
  assert.throws(() => expectProblematicRenderedIdentity(actual(expected), response, expected, true));
  for (const change of [{ emptyText: '' }, { albumReasons: [] }, { visibleRenderedPaths: ['/wrong'] }]) {
    assert.throws(() => expectProblematicRenderedIdentity({ ...actual(expected), ...change }, response, expected, false));
  }
});

function capturePage() {
  let listener;
  return { on(event, callback) { assert.equal(event, 'response'); listener = callback; },
    off(event, callback) { assert.equal(event, 'response'); assert.equal(callback, listener); listener = null; },
    emit(url, value, ok = true) { assert.ok(listener); listener({ url: () => `https://app.test${url}`, ok: () => ok, json: async () => value }); },
    listening: () => Boolean(listener) };
}

test('normal response snapshots are independent immutable copies across cached revisits', async () => {
  const { observeProblematicDetails } = await load();
  const page = capturePage();
  const capture = observeProblematicDetails(page);
  const original = payload();
  const summary = { items: [{ key: original.key, track_paths: ['/one', '/two'] }], initial_detail: original };
  page.emit('/utilities/problematic-files', summary);
  const first = await capture.detail(original.key);
  original.name = 'Later mutation';
  first.name = 'Consumer mutation';
  first.tracks.length = 0;
  summary.items[0].key = 'Mutated summary';
  assert.equal((await capture.detail('artist::album')).name, 'Original album');
  assert.deepEqual((await capture.detail('artist::album')).tracks.map(row => row.path), ['/one', '/two']);
  assert.equal((await capture.summary())[0].key, 'artist::album');
  assert.equal(await capture.detail('unknown'), null);
  await capture.dispose();
  assert.equal(page.listening(), false);
});

for (const [label, url, response, ok] of [
  ['wrong detail key', '/utilities/problematic-files/detail?album_key=expected', payload(), true],
  ['failed response', '/utilities/problematic-files', { items: [] }, false],
]) {
  test(`capture rejects ${label} rather than replacing missing authority`, async () => {
    const { observeProblematicDetails } = await load();
    const page = capturePage(); const capture = observeProblematicDetails(page);
    page.emit(url, response, ok);
    await assert.rejects(capture.summary(), /evidence capture failed/);
    await assert.rejects(capture.dispose(), /evidence capture failed/);
    assert.equal(page.listening(), false);
  });
}

function navigationRecords() {
  return [{ detailRender: false, detailRenderCount: 0, activeKey: 'chosen', detailTitle: '', detailText: '', mutation: 'list spacers' },
    { detailRender: true, detailRenderCount: 1, activeKey: 'chosen', selectedKey: 'chosen', runtimeKey: 'chosen', selectedRowMounted: true, detailMutation: false, detailTitle: 'Chosen album', detailText: 'Track' },
    { detailRender: false, detailRenderCount: 0, activeKey: 'chosen', selectedKey: 'chosen', runtimeKey: 'chosen', selectedRowMounted: true, detailMutation: false, detailTitle: 'Chosen album', detailText: 'Track', mutation: 'mounted window' }];
}

test('list-only spacers do not count as detail renders and raw records remain unchanged', async () => {
  const { expectProblematicNavigationRecords } = await load();
  const records = navigationRecords(); const before = JSON.stringify(records);
  assert.doesNotThrow(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
  assert.equal(JSON.stringify(records), before);
});

for (const [label, change] of [
  ['no detail render', records => records.filter(row => !row.detailRender)],
  ['two real renders', records => [...records, { ...records[1] }]],
  ['two batched root writes', records => records.map(row => row.detailRender ? { ...row, detailRenderCount: 2 } : row)],
  ['missing instrumentation count', records => records.map(({ detailRenderCount, ...row }) => row)],
  ['empty real render', records => [...records, { detailRender: true, detailRenderCount: 1, activeKey: '', detailTitle: '', detailText: '' }]],
  ['wrong list-only key', records => [...records, { detailRender: false, detailRenderCount: 0, activeKey: 'other', detailTitle: '' }]],
  ['wrong list-only title', records => [...records, { detailRender: false, detailRenderCount: 0, activeKey: 'chosen', detailTitle: 'Other' }]],
  ['missing selected model key', records => [...records, { ...records[2], activeKey: '', selectedKey: '' }]],
  ['wrong selected model key', records => [...records, { ...records[2], activeKey: '', selectedKey: 'other' }]],
  ['missing detail model key', records => [...records, { ...records[2], activeKey: '', runtimeKey: '' }]],
  ['wrong detail model key', records => [...records, { ...records[2], activeKey: '', runtimeKey: 'other' }]],
  ['wrong mounted row with correct models', records => [...records, { ...records[2], activeKey: 'other' }]],
  ['missing active styling on mounted target', records => [...records, { ...records[2], activeKey: '' }]],
  ['detail subtree change with absent target', records => [...records, { ...records[2], activeKey: '', selectedRowMounted: false, detailMutation: true }]],
  ['missing list-only evidence', records => [...records, { ...records[2], activeKey: '', selectedRowMounted: false, detailMutation: undefined }]],
  ['unmounted row at root detail render', records => records.map(record => record.detailRender ? { ...record, activeKey: '' } : record)],
]) {
  test(`navigation rejects ${label}`, async () => {
    const { expectProblematicNavigationRecords } = await load();
    assert.throws(() => expectProblematicNavigationRecords(change(navigationRecords()), 'chosen', 'Chosen album'));
  });
}

test('initial detail can belong to any summary member but never an unknown key', async () => {
  const { observeProblematicDetails } = await load();
  const original = payload();
  const page = capturePage(); const capture = observeProblematicDetails(page);
  page.emit('/utilities/problematic-files', { items: [{ key: 'first' }, { key: original.key }], initial_detail: original });
  assert.equal((await capture.detail(original.key)).name, original.name);
  await capture.dispose();
  const invalidPage = capturePage(); const invalid = observeProblematicDetails(invalidPage);
  invalidPage.emit('/utilities/problematic-files', { items: [{ key: 'first' }], initial_detail: original });
  await assert.rejects(invalid.summary(), /evidence capture failed/);
  await assert.rejects(invalid.dispose(), /evidence capture failed/);
});

function renderedProblemDom() {
  const bounds = { left: 20, top: 20, right: 220, bottom: 60, width: 200, height: 40 };
  const node = (textContent = '') => ({ textContent, hidden: false, parentElement: null,
    style: { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' },
    bounds: { ...bounds }, getBoundingClientRect() { return this.bounds; },
    getAttribute(name) { return this.attributes?.[name] || ''; } });
  const parent = node(); parent.bounds = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 };
  const heading = node('Original album'); heading.parentElement = parent;
  const rows = ['/one', '/two'].map(path => Object.assign(node(), { parentElement: parent,
    attributes: { 'data-problematic-track-path': path } }));
  const reason = node('Missing year'); reason.parentElement = parent;
  const hiddenReason = node('Wrong hidden reason'); hiddenReason.hidden = true;
  const empty = node('Only album-level problems found. No per-track problems.');
  const converted = node('Converted tags'); converted.attributes = { 'aria-pressed': 'true' };
  const detail = {
    querySelector: selector => selector === '.utility-detail-title' ? heading : selector === '.converted' ? converted : null,
    querySelectorAll: selector => selector === '.tracks' ? rows
      : selector === '[data-album-problem-type]' ? [reason, hiddenReason] : selector === '.utility-detail-meta' ? [empty] : [],
  };
  const active = node(); active.attributes = { 'data-problematic-album-key': 'artist::album' };
  return { parent, heading, rows, reason, empty,
    globals: { innerWidth: 800, innerHeight: 600,
      document: { querySelector: selector => selector === '.detail' ? detail : selector === '.active' ? active : null },
      getComputedStyle: element => element.style,
      state: { utility: { selectedProblematicKey: 'artist::album', searchQuery: '', selectedProblemFilters: [] } },
      getSelectedProblematicAlbum: () => payload(),
    } };
}
async function readRenderedProblem(dom) {
  const module = await import(pathToFileURL(path.resolve(__dirname, '../e2e/poms/settingsRefactorShell.js')).href);
  return vm.runInNewContext(`(${module.readProblematicSelectionEvidence.toString()})(selectors)`, {
    ...dom.globals, selectors: { detail: '.detail', active: '.active', trackRows: '.tracks', converted: '.converted' },
  });
}

test('real POM callback includes visible tracks and excludes hidden reason text', async () => {
  const result = await readRenderedProblem(renderedProblemDom());
  assert.equal(result.headingVisible, true);
  assert.deepEqual(Array.from(result.visibleRenderedPaths), ['/one', '/two']);
  assert.deepEqual(Array.from(result.albumReasons), ['Missing year']);
});

for (const [label, hide] of [
  ['display none', dom => { dom.parent.style.display = 'none'; }],
  ['ancestor opacity zero', dom => { dom.parent.style.opacity = '0'; }],
  ['ancestor visibility hidden', dom => { dom.parent.style.visibility = 'hidden'; }],
  ['ancestor clipping', dom => { dom.parent.style.overflowX = 'hidden'; dom.parent.bounds.right = 10; }],
  ['outside viewport', dom => { for (const node of [dom.heading, ...dom.rows]) { node.bounds.left = 900; node.bounds.right = 1000; } }],
  ['zero width', dom => { for (const node of [dom.heading, ...dom.rows]) node.bounds.width = 0; }],
]) {
  test(`real POM callback rejects ${label} as visible track evidence`, async () => {
    const dom = renderedProblemDom(); hide(dom);
    const result = await readRenderedProblem(dom);
    assert.deepEqual(Array.from(result.renderedPaths), ['/one', '/two']);
    assert.deepEqual(Array.from(result.visibleRenderedPaths), []);
    assert.equal(result.headingVisible, false);
    const { problemDetailExpectation, expectProblematicRenderedIdentity } = await load();
    const expected = problemDetailExpectation(payload());
    assert.throws(() => expectProblematicRenderedIdentity(result, payload(), expected));
  });
}

async function navigationObserverHarness() {
  const { UtilityProblematicFilesActions } = await import(pathToFileURL(path.resolve(__dirname, '../e2e/actions/utilityProblematicFilesActions.js')).href);
  let deliver, disconnected = false;
  const textNode = {};
  const detail = { textContent: 'Chosen album Track', contains: node => node === textNode,
    querySelector: () => ({ textContent: 'Chosen album' }) };
  const list = { scrollTop: 321, querySelectorAll: () => [active] };
  const active = { getAttribute: () => 'chosen' };
  let captured;
  const owner = { utilityProblematicFilesTab: {
    detailScrollerSelector: '.detail', detailTitleSelector: '.title', activeListItemSelector: '.active', sidebarListSelector: '.list',
    page: { async evaluateHandle(callback, selectors) {
      captured = vm.runInNewContext(`(${callback.toString()})(selectors)`, { selectors,
        state: { utility: { selectedProblematicKey: 'chosen' } },
        getSelectedProblematicAlbum: () => ({ key: 'chosen' }),
        document: { querySelector: selector => selector === '.detail' ? detail : selector === '.active' ? active : list },
        MutationObserver: class {
          constructor(callback) { deliver = callback; }
          observe(target, config) { assert.ok([detail, list].includes(target)); assert.equal(config.subtree, true); }
          disconnect() { disconnected = true; }
        },
      });
      return { evaluate: async callback => callback(captured), dispose: async () => {} };
    } },
  } };
  await UtilityProblematicFilesActions.prototype.startNavigationRenderObservation.call(owner);
  return { detail, list, textNode, deliver: mutations => deliver(mutations),
    finish: () => UtilityProblematicFilesActions.prototype.finishNavigationRenderObservation.call(owner),
    disconnected: () => disconnected };
}

test('actual observer counts one root replacement while retaining nested and list-only diagnostics', async () => {
  const { expectProblematicNavigationRecords } = await load();
  const h = await navigationObserverHarness();
  h.deliver([{ type: 'childList', target: h.list }, { type: 'attributes', target: h.detail }]);
  h.deliver([{ type: 'childList', target: h.detail }, { type: 'characterData', target: h.textNode },
    { type: 'childList', target: h.textNode }]);
  const records = await h.finish();
  assert.deepEqual(Array.from(records, record => record.detailRenderCount), [0, 1]);
  assert.equal(records.length, 2, 'List-only diagnostics must not be discarded');
  assert.equal(records[0].listScrollTop, 321);
  assert.equal(h.disconnected(), true);
  assert.doesNotThrow(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
});

test('actual observer detects two batched root writes even when final snapshot hides the empty intermediate', async () => {
  const { expectProblematicNavigationRecords } = await load();
  const h = await navigationObserverHarness();
  h.deliver([{ type: 'childList', target: h.detail, removedNodes: [{}], addedNodes: [] },
    { type: 'childList', target: h.detail, removedNodes: [], addedNodes: [{}] }]);
  const records = await h.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0].detailRenderCount, 2);
  assert.equal(records[0].detailTitle, 'Chosen album');
  assert.throws(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
});


test('pure nested and text changes cannot claim a completed detail replacement', async () => {
  const { expectProblematicNavigationRecords } = await load();
  const h = await navigationObserverHarness();
  h.deliver([{ type: 'characterData', target: h.textNode }, { type: 'childList', target: h.textNode }]);
  const records = await h.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0].detailRenderCount, 0);
  assert.throws(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
});


test('virtualized offscreen active row may unmount while exact model and detail identity remain', async () => {
  const { expectProblematicNavigationRecords } = await load();
  const records = navigationRecords();
  records.splice(2, 0, { ...records[2], activeKey: '', selectedRowMounted: false, listScrollTop: 0 });
  assert.doesNotThrow(() => expectProblematicNavigationRecords(records, 'chosen', 'Chosen album'));
});

test('navigation observer samples production selected and detail keys independently of mounted rows', async () => {
  const { UtilityProblematicFilesActions } = await import(pathToFileURL(
    path.resolve(__dirname, '../e2e/actions/utilityProblematicFilesActions.js'),
  ).href);
  let capture;
  const model = { utility: { selectedProblematicKey: 'chosen' } };
  const selected = { key: 'chosen' };
  const detail = { contains: () => false, textContent: 'Chosen album Track', querySelector: () => ({ textContent: 'Chosen album' }) };
  const sidebar = { scrollTop: 0, querySelectorAll: () => [] };
  const tab = {
    detailScrollerSelector: 'detail', detailTitleSelector: 'title', activeListItemSelector: 'active', sidebarListSelector: 'list',
    page: { evaluateHandle: async (callback, selectors) => vm.runInNewContext(`(${callback.toString()})(selectors)`, {
      selectors, state: model, getSelectedProblematicAlbum: () => selected,
      document: { querySelector: selector => ({ detail, list: sidebar })[selector] || null },
      MutationObserver: class { constructor(callback) { capture = callback; } observe() {} },
    }) },
  };
  const actions = new UtilityProblematicFilesActions(tab);
  await actions.startNavigationRenderObservation();
  capture([{ type: 'childList', target: sidebar }]);
  const record = actions.navigationObservation.records[0];
  assert.equal(record.activeKey, '');
  assert.equal(record.selectedRowMounted, false);
  assert.equal(record.detailMutation, false);
  assert.equal(record.selectedKey, 'chosen');
  assert.equal(record.runtimeKey, 'chosen');
  capture([{ type: 'attributes', target: detail }]);
  assert.equal(actions.navigationObservation.records[1].detailMutation, false, 'Style/attribute updates are not detail content mutations');
  capture([{ type: 'characterData', target: detail }]);
  assert.equal(actions.navigationObservation.records[2].detailMutation, true);
  model.utility.selectedProblematicKey = 'changed';
  selected.key = 'changed';
  assert.equal(record.selectedKey, 'chosen', 'the observation must retain its original selected key');
  assert.equal(record.runtimeKey, 'chosen', 'the observation must retain its original detail key');
});
