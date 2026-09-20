const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function setup() {
  const calls = [], changes = [];
  const context = vm.createContext({ Date, Intl, URLSearchParams, console, state: { utility: { activeTab: 'log-history', logHistory: [] } },
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    window: { ButtonComponent: { renderButton: config => `<button>${config.label}</button>`, renderActionButton: config => `<button aria-label="${config.ariaLabel}"></button>` } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, items: [{ id: 'a', action: 'Saved' }], snapshot: 'fixed', revision: '4', next_cursor: null, allowed_actions: { 'library.logs.read': true, 'library.logs.export': true } }) }; },
    renderUtilityLogHistory: () => changes.push('render'), renderUtilityModalContent() {}, getUtilityModalElements: () => ({ overlay: { hidden: false } }),
  });
  vm.runInContext(fs.readFileSync(path.resolve(dir, '../button-component.js'), 'utf8'), context);
  for (const name of ['alert-components', 'date-range-picker', 'utility-log-history-query', 'utility-log-history-ui', 'utility-loaders-and-cover-lookup', 'utility-list-builders']) {
    const file = path.join(dir, `${name}.js`); if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  context.renderUtilityLogHistory = () => changes.push('render');
  return { context, calls, changes };
}

test('shared calendar handles leap years, selected dates and range limits without native date inputs', () => {
  const { context } = setup();
  const html = context.buildCalendarMonth({ year: 2024, month: 1, selected: '2024-02-15', min: '2024-02-10', max: '2024-02-20' });
  assert.equal((html.match(/data-calendar-date=/g) || []).length, 29);
  assert.match(html, /data-calendar-date="2024-02-15" aria-pressed="true"/);
  assert.match(html, /data-calendar-date="2024-02-09"[^>]*disabled/);
  assert.match(html, /data-calendar-date="2024-02-21"[^>]*disabled/);
  assert.doesNotMatch(context.buildDateRangePicker(), /type="date"/);
  assert.equal((context.buildDateRangePicker().match(/placeholder="mm\/dd\/yyyy"/g) || []).length, 2);
  assert.match(context.buildDateRangePicker(), /date-range-picker__control ui-input-action/);
  assert.match(context.buildDateRangePicker(), /data-calendar-trigger="fromDate"/);
  assert.equal((context.buildCalendarMonth({ year: 2025, month: 1 }).match(/data-calendar-date=/g) || []).length, 28);
});
test('live loader delegates to captured server query and keeps authoritative navigation separate from detail', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  assert.match(h.calls[0].url, /^\/utilities\/log-history\?page_size=500/);
  assert.equal(h.context.getUtilityLogHistoryController().getState().snapshot, 'fixed');
  assert.equal(h.context.state.utility.logHistory[0].id, 'a');
});
test('live revision and mutation callbacks only mark the captured console stale', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory(); const before = h.calls.length;
  await h.context.syncUtilityLogHistoryRevision('5'); await h.context.prependUtilityLogHistoryEntry({ id: 'secret', files: ['C:/private'] });
  assert.equal(h.calls.length, before);
  assert.equal(h.context.getUtilityLogHistoryController().getState().stale, true);
  assert.equal(h.context.state.utility.logHistory.length, 1);
});
test('live export checks both current grants before dispatch', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  h.context.state.utility.allowedActions['library.logs.export'] = false;
  await assert.rejects(() => h.context.getUtilityLogHistoryController().exportCurrent());
  assert.equal(h.calls.length, 1);
  h.context.state.utility.allowedActions['library.logs.export'] = true;
  h.context.state.utility.allowedActions['library.logs.read'] = false;
  await assert.rejects(() => h.context.getUtilityLogHistoryController().exportCurrent());
  assert.equal(h.calls.length, 1);
});

test('ConsoleLog shows sanitized outcome metadata and a shared Copy log action', () => {
  const h = setup();
  const html = h.context.buildConsoleLog([{ id: 'a', action: 'Tags edited', timestamp: '2026-09-09', processed: 5, failed: 1, file_count: 6, message: '<safe text>' }]);
  assert.match(html, /Processed: 5/); assert.match(html, /Failed: 1/); assert.match(html, /Files: 6/);
  assert.match(html, /&lt;safe text>/); assert.match(html, /aria-label="Copy log"/);
});

test('copy action writes the displayed captured console without fetching or exporting', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  const copied = []; h.context.navigator = { clipboard: { writeText: async value => copied.push(value) } };
  const before = h.calls.length; await h.context.handleUtilityLogHistoryAction('copy');
  assert.equal(h.calls.length, before); assert.equal(copied.length, 1); assert.match(copied[0], /Saved/);
});

test('export query uses the shared form-modal owner and approved preset/type controls', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  let options; h.context.showAppFormDialog = value => { options = value; return Promise.resolve(null); };
  h.context.openUtilityLogHistoryQuery(true);
  assert.ok(options); assert.equal(options.title, 'Export all logs');
  assert.match(options.contentHtml, /data-log-preset="7-days"/);
  assert.match(options.contentHtml, /type="checkbox"/);
  assert.match(options.contentHtml, /data-date-range-picker/);
  assert.doesNotMatch(options.contentHtml, /type="date"/);
  assert.doesNotMatch(options.contentHtml, /<select|comma/i);
 assert.doesNotMatch(options.contentHtml, /data-log-source|All sources|<label>Source/);
});

test('export custom calendar retains dates across presets and disposes its listeners', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  let options, mounts = 0, disposals = 0, cancelled = 0, downloaded = 0;
  const drafts = [];
  h.context.showAppFormDialog = value => { options = value; };
  h.context.getUtilityLogHistoryController = () => ({
    beginDraft: value => drafts.push(value), applyDraft: async () => {}, cancelDraft: () => { cancelled += 1; },
  });
  h.context.downloadUtilityLogHistory = async () => { downloaded += 1; };
  h.context.clearTriggerAnchor = () => {};
  const from = { value: '2026-09-01' }, to = { value: '2026-09-19' };
  const calendarButtons = [{}, {}];
  const dates = { hidden: true, querySelectorAll: () => [from, to, ...calendarButtons] };
  h.context.mountDateRangePicker = root => {
    assert.equal(root, dates); mounts += 1;
    return () => { disposals += 1; };
  };
  const buttons = ['today', '7-days', '30-days', 'custom'].map(preset => ({
    getAttribute: () => preset, setAttribute() {}, addEventListener(type, callback) { this[type] = callback; },
  }));
  const content = {
    querySelector: selector => ({
      '[data-log-custom-dates]': dates,
      '[name="fromDate"]': from, '[name="toDate"]': to, '[name="text"]': { value: 'saved' },
    })[selector],
    querySelectorAll: selector => selector === '[data-log-preset]' ? buttons : selector === '[name="eventType"]' ? [{ checked: true, value: 'Saved' }] : [],
  };
  h.context.openUtilityLogHistoryQuery(true);
  options.onMount(content);
  assert.equal(mounts, 0); assert.equal(from.disabled, true); assert.equal(to.disabled, true);
  assert.ok(calendarButtons.every(button => button.disabled));
  buttons[3].click();
  assert.equal(dates.hidden, false); assert.equal(from.disabled, false); assert.equal(to.disabled, false); assert.equal(mounts, 1);
  assert.ok(calendarButtons.every(button => !button.disabled));
  buttons[1].click();
  assert.equal(dates.hidden, true); assert.equal(from.disabled, true); assert.equal(disposals, 1);
  assert.equal(from.value, '2026-09-01'); assert.equal(to.value, '2026-09-19');
  buttons[3].click();
  assert.equal(mounts, 2);
  await options.onSubmit(content);
  assert.equal(drafts.at(-1).preset, 'custom'); assert.equal(drafts.at(-1).fromDate, from.value); assert.equal(drafts.at(-1).toDate, to.value);
  assert.equal(drafts.at(-1).sources.length, 0);
  assert.equal(downloaded, 1);
  options.onClose(content);
  assert.equal(disposals, 2); assert.equal(cancelled, 1);
});

test('ordinary tree selection and a changed period label retain exact nodes and ordering', () => {
  const h = setup(); const nodes = [], updates = [];
  for (const id of ['period', 'a', 'b']) nodes.push({ id, getAttribute: () => id, get nextElementSibling() { return nodes[nodes.indexOf(this) + 1] || null; }, remove() { nodes.splice(nodes.indexOf(this), 1); } });
  const original = nodes.slice();
  const list = { dataset: { utilityNavigationOwner: 'log-history' }, get firstElementChild() { return nodes[0] || null; }, querySelectorAll: () => nodes, insertBefore() { throw new Error('Unchanged nodes must not move'); }, scrollTop: 700 };
  h.context.window.NavigationTree = { setItemSelected: (node, selected) => { node.selected = selected; }, updateItem: (node, options) => updates.push({ node, options }) };
  h.context.state.utility.logHistory = [{ id: 'a' }, { id: 'b' }];
  h.context.reconcileUtilityLogHistoryTree({ list, count: {} }, { temporaryRowId: 'period', selectedEventId: 'a', periodLabel: 'Sep 3 – Sep 9 · America/Denver' });
  assert.deepEqual(nodes, original); assert.equal(nodes[1].selected, true); assert.equal(list.scrollTop, 700);
  assert.match(updates[0].options.subtitle, /Sep 3 – Sep 9/);
  h.context.reconcileUtilityLogHistoryTree({ list, count: {} }, { temporaryRowId: null, selectedEventId: 'a' });
  assert.equal(nodes.length, 2); assert.equal(nodes[0], original[1]); assert.equal(nodes[1], original[2]);
});

test('actual download owner cannot create a file from a prior library export', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  let resolve; const pendingResponse = new Promise(done => { resolve = done; });
  const created = [];
  h.context.fetch = () => pendingResponse;
  h.context.URL = { createObjectURL: () => { created.push('file'); return 'blob:owned'; }, revokeObjectURL() {} };
  h.context.Blob = class {};
  h.context.document = { createElement: () => ({ click: () => created.push('download') }) };
  const pending = h.context.downloadUtilityLogHistory();
  h.context.state.utility = { activeTab: 'rules' };
  resolve({ ok: true, json: async () => ({ items: [{ id: 'prior-library' }] }) });
  await assert.rejects(() => pending); assert.deepEqual(created, []);
});

test('period query uses the SearchInput anchored variant of the shared form owner', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  const anchor = {}; h.context.getUtilityModalElements = () => ({ problemFilterButton: anchor });
  let options; h.context.showAppFormDialog = value => { options = value; return Promise.resolve(null); };
  const requestsBefore = h.calls.length;
  h.context.openUtilityLogHistoryQuery(false);
  assert.equal(options.anchor, anchor);
  assert.equal(h.calls.length, requestsBefore, 'opening the date picker does not fetch results');
  assert.match(options.contentHtml, /data-date-range-picker/);
  assert.match(options.contentHtml, /name="fromDate"/);
  assert.match(options.contentHtml, /name="toDate"/);
  assert.doesNotMatch(options.contentHtml, /eventType|log-source|name="text"/);
});

test('opening and cancelling a draft does not rebuild the underlying console or its focused export trigger', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory(); const before = h.changes.length;
  const controller = h.context.getUtilityLogHistoryController(); controller.beginDraft({ preset: 'today' }); controller.cancelDraft();
  assert.equal(h.changes.length, before);
});

test('missing current export projection removes a previously granted export action', async () => {
  const h = setup(); await h.context.loadUtilityLogHistory();
  h.context.fetch = async () => ({ ok: true, json: async () => ({ items: [], snapshot: 'new', allowed_actions: { 'library.logs.read': true } }) });
  await h.context.getUtilityLogHistoryController().refresh();
  assert.equal(h.context.canExportUtilityLogHistory(), false);
});

test('entering empty Log History clears another tab navigation exactly once', () => {
  const h = setup(); let children = [{ album: 'Previous Problems row' }], clears = 0;
  const list = { dataset: { utilityNavigationOwner: 'problematic-files' }, get firstElementChild() { return children[0] || null; }, querySelectorAll: () => [], replaceChildren() { children = []; clears++; } };
  h.context.reconcileUtilityLogHistoryTree({ list, count: {} }, {});
  assert.deepEqual(children, []); assert.equal(clears, 1);
  h.context.reconcileUtilityLogHistoryTree({ list, count: {} }, {});
  assert.equal(clears, 1);
});
