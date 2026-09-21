const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const plain = value => JSON.parse(JSON.stringify(value));
function load(context, ...names) {
  for (const name of names) vm.runInContext(fs.readFileSync(path.join(runtime, `${name}.js`), 'utf8'), context, { filename: `${name}.js` });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function click(selector, attributes) {
  const button = { getAttribute: name => attributes[name] || '' };
  return { preventDefault() {}, target: { closest: query => query === selector ? button : null } };
}
function mountedHarness(utility = {}) {
  const document = { activeElement: null, getElementById: () => null, querySelectorAll: () => [], body: { classList: { add() {} } } };
  let mounted;
  const mount = () => {
    if (mounted) { mounted.row.isConnected = false; mounted.audio.paused = true; document.activeElement = document.body; }
    mounted = { row: { isConnected: true }, detail: {}, audio: { paused: false }, range: { start: 2, end: 8 }, scrollTop: 411 };
  };
  mount(); document.activeElement = mounted.row;
  const els = { overlay: { hidden: false }, detail: {} };
  const c = vm.createContext({ console, Date, Intl, URLSearchParams, document,
    state: { utility: { activeTab: 'appearance', appearanceKey: 'backgrounds', selectedRuleKey: 'problem-exclusions', loops: [], ...utility }, coverLookup: {} },
    getUtilityModalElements: () => els, renderUtilityModalContent: mount,
    loadUtilityRules() {}, loadUtilityLoops() {}, loadUtilityLogHistory() {}, loadUtilityIntegrations() {}, loadProblematicFiles() {},
    disposeMountedLoopActions() {}, hideRepairAlert() {},
  });
  load(c, 'utility-loop-playback', 'bootstrap-utility-event-handlers');
  return { c, document, els, mounted: () => mounted };
}
// The mount adapter models the destructive ownership boundary, including native focus
// and audio disposal. The actual action/transition functions decide whether it runs.
for (const [name, selector, attribute, key, utility] of [
  ['Appearance row', '[data-utility-appearance-key]', 'data-utility-appearance-key', 'backgrounds', {}],
  ['Rules row', '[data-utility-rule-key]', 'data-utility-rule-key', 'problem-exclusions', { activeTab: 'rules' }],
  ['Loops tab', '[data-utility-tab]', 'data-utility-tab', 'loops', { activeTab: 'loops' }],
  ['Appearance tab', '[data-utility-tab]', 'data-utility-tab', 'appearance', {}],
]) {
  test(`R1/R2 repeated ${name} activation retains mounted focus audio and range`, async () => {
    const h = mountedHarness(utility), before = h.mounted();
    await h.c.handleUtilityBootstrapClick(click(selector, { [attribute]: key }));
    assert.equal(h.mounted(), before, 'selection of the current owner must not remount');
    assert.equal(h.document.activeElement, before.row);
    assert.equal(before.row.isConnected, true);
    assert.equal(before.audio.paused, false);
    assert.deepEqual(before.range, { start: 2, end: 8 });
    assert.equal(before.scrollTop, 411);
  });
}
test('R2 deferred Appearance departure retains its mounted draft until acceptance', async () => {
  const h = mountedHarness(), before = h.mounted(); let continuation, loads = 0;
  h.c.confirmBackgroundAppearanceLeave = callback => { continuation = callback; return false; };
  h.c.loadUtilityRules = () => { loads++; };
  await h.c.handleUtilityBootstrapClick(click('[data-utility-tab]', { 'data-utility-tab': 'rules' }));
  assert.equal(typeof continuation, 'function');
  assert.equal(h.c.state.utility.activeTab, 'appearance');
  assert.equal(h.mounted(), before, 'pending/cancelled confirmation must keep the draft owner');
  assert.equal(loads, 0);
  h.c.loadActiveUtilityTab = () => { loads++; };
  continuation();
  assert.equal(h.c.state.utility.activeTab, 'rules');
  assert.equal(loads, 1);
});

function controllerHarness(fetchPage) {
  const c = vm.createContext({ Date, Intl, console }); load(c, 'utility-log-history-query');
  const exports = [];
  return { exports, controller: c.createUtilityLogHistoryQueryController({ contextKey: 'owned-library',
    now: () => new Date('2026-09-09T18:00:00Z'), timeZone: 'America/Denver', fetchPage,
    exportQuery: async query => { exports.push(plain(query)); }, onChange() {},
  }) };
}
const page = (id, snapshot = id, next_cursor = null) => ({ ok: true, items: [{ id }], snapshot, next_cursor, revision: '7', allowed_actions: { 'library.logs.read': true, 'library.logs.export': true } });
const draft = day => ({ preset: 'custom', fromDate: `2026-09-${day}`, toDate: `2026-09-${day}` });
test('R3 failed replacement period and Cancel retain the committed label and export capture', async () => {
  let count = 0;
  const h = controllerHarness(async () => { if (++count === 2) throw new Error('Service unavailable'); return page('a'); });
  h.controller.beginDraft(draft('01')); await h.controller.applyDraft();
  const before = plain(h.controller.getState());
  h.controller.beginDraft(draft('02')); await assert.rejects(h.controller.applyDraft(), /unavailable/);
  h.controller.cancelDraft(); const after = plain(h.controller.getState());
  for (const key of ['periodLabel', 'query', 'snapshot', 'items', 'temporaryRowId']) assert.deepEqual(after[key], before[key], key);
  await h.controller.exportCurrent();
  assert.deepEqual(h.exports[0], { query: before.query, snapshot: before.snapshot });
});

function liveLogs() {
  const h = mountedHarness({ activeTab: 'log-history', logHistory: [] });
  const requests = [];
  h.c.fetch = async (url, options) => {
    const pending = deferred(); requests.push({ url, options, pending }); return pending.promise;
  };
  h.c.renderUtilityLogHistory = () => {};
  load(h.c, 'utility-log-history-query', 'utility-log-history-ui', 'utility-loaders-and-cover-lookup');
  // Startup gallery fetch ownership is outside the Logs opening contract.
  h.c.deferActiveStartupViewForUtilityModal = () => {};
  return { ...h, requests, reply(index, data) { requests[index].pending.resolve({ ok: true, json: async () => data }); } };
}
test('R4 accepted recent-activity continuation retains earlier navigation membership', async () => {
  const h = liveLogs(), controller = h.c.getUtilityLogHistoryController();
  const first = controller.refresh(); h.reply(0, page('a', 'fixed', 'next')); await first;
  const more = controller.loadMore(); h.reply(1, page('b', 'fixed')); await more;
  assert.deepEqual(plain(controller.getState().items).map(item => item.id), ['a', 'b']);
  assert.deepEqual(plain(h.c.state.utility.logHistory).map(item => item.id), ['a', 'b']);
});
test('R4 stale base response cannot overwrite navigation or current export denial', async () => {
  const h = liveLogs(), controller = h.c.getUtilityLogHistoryController();
  h.c.state.utility.logHistory = [{ id: 'retained' }];
  const old = controller.refresh();
  const selected = controller.selectEvent('b');
  h.reply(1, { ...page('b'), allowed_actions: { 'library.logs.read': true, 'library.logs.export': false } }); await selected;
  h.reply(0, page('obsolete')); await old;
  assert.equal(controller.getState().selectedEventId, 'b');
  assert.deepEqual(plain(h.c.state.utility.logHistory), [{ id: 'retained' }]);
  assert.equal(h.c.state.utility.allowedActions['library.logs.export'], false);
});
// One event-loop turn drains the finite promise chains released by our transport.
// This is not a timed sleep or a wait for a render that a broken handler may omit.
const drainReleasedResponses = () => new Promise(resolve => setImmediate(resolve));
for (const previous of ['', 'a']) {
  test(`R5 failure link captures its exact event through the real open owner (${previous || 'first open'})`, async () => {
    const h = liveLogs(), controller = h.c.getUtilityLogHistoryController();
    if (previous) { const selected = controller.selectEvent(previous); h.reply(0, page(previous)); await selected; }
    const targeted = [], exports = [];
    h.c.fetch = async (url, options) => {
      if (url === '/utilities/log-history/export') {
        exports.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, count: 1 }) };
      }
      const params = new URL(url, 'https://local.test').searchParams;
      const ids = params.getAll('event_ids');
      if (ids.includes('b')) {
        const pending = deferred(); targeted.push({ ids, pending }); return pending.promise;
      }
      // Legitimate independent base priming is fulfilled wherever it occurs.
      // It cannot satisfy the targeted-event contract with an empty result.
      return { ok: true, json: async () => page(ids[0] || 'base', 'base-snapshot') };
    };
    await h.c.handleUtilityBootstrapClick(click('[data-open-log-history-alert="1"]', { 'data-log-history-entry-id': 'b' }));
    await drainReleasedResponses();
    assert.ok(targeted.length > 0, 'the open operation must request failure event B after any base priming');
    for (const request of targeted) {
      assert.deepEqual(request.ids, ['b']);
      request.pending.resolve({ ok: true, json: async () => page('b', 'event-b') });
    }
    await drainReleasedResponses();
    const accepted = controller.getState();
    assert.equal(accepted.loading, false);
    assert.equal(accepted.selectedEventId, 'b');
    assert.equal(accepted.snapshot, 'event-b');
    assert.deepEqual(plain(accepted.query), { event_ids: ['b'] });
    assert.deepEqual(plain(accepted.items), [{ id: 'b' }]);
    await controller.exportCurrent();
    assert.deepEqual(exports, [{ query: { event_ids: ['b'] }, snapshot: 'event-b' }]);

    // A response owned by this opening cannot publish into a later library owner.
    const late = deferred(); h.c.fetch = () => late.promise;
    const oldRefresh = controller.refresh();
    const replacement = { activeTab: 'log-history', logHistory: [{ id: 'new-library' }],
      selectedLogHistoryId: 'new-library', allowedActions: { 'library.logs.export': false } };
    h.c.state.utility = replacement;
    late.resolve({ ok: true, json: async () => page('b', 'obsolete-owner') });
    await oldRefresh;
    assert.equal(h.c.state.utility, replacement);
    assert.deepEqual(replacement.logHistory, [{ id: 'new-library' }]);
    assert.equal(replacement.selectedLogHistoryId, 'new-library');
    assert.equal(replacement.allowedActions['library.logs.export'], false);
  });
}
for (const failure of [false, true]) {
  test(`R6 late Library ${failure ? 'failure' : 'success'} cannot replace Foobar or steal focus`, async () => {
    const h = mountedHarness({ activeTab: 'integrations', selectedIntegrationKey: 'library' });
    const pending = deferred(), toasts = [];
    h.c.fetch = () => pending.promise;
    h.c.cloneRuntimeJson = value => plain(value);
    h.c.showToast = message => toasts.push(message);
    h.c.console = { ...console, error() {} };
    load(h.c, 'library-settings');
    const loading = h.c.handleLibrarySettingsIntegrationSelection('library');
    h.c.state.utility.selectedIntegrationKey = 'foobar';
    h.c.renderUtilityModalContent();
    const foobar = h.mounted(); h.document.activeElement = foobar.row;
    if (failure) pending.reject(new Error('Library service unavailable'));
    else pending.resolve({ ok: true, json: async () => ({ ok: true, settings: { main_library_roots: [], hoarding_library_roots: [], new_arrivals_roots: [] } }) });
    await loading;
    assert.equal(h.mounted(), foobar);
    assert.equal(h.document.activeElement, foobar.row);
    assert.deepEqual(toasts, []);
  });
}

test('R6 a completed Library request cannot render or notify a replacement utility owner', async () => {
  const h = mountedHarness({ activeTab: 'integrations', selectedIntegrationKey: 'library' });
  const pending = deferred(), toasts = [];
  h.c.fetch = () => pending.promise;
  h.c.cloneRuntimeJson = value => plain(value);
  h.c.showToast = message => toasts.push(message);
  h.c.console = { ...console, error() {} };
  load(h.c, 'library-settings');
  const oldOwner = h.c.state.utility;
  const loading = h.c.handleLibrarySettingsIntegrationSelection('library');
  h.c.state.utility = { activeTab: 'integrations', selectedIntegrationKey: 'library', librarySettings: { loaded: false } };
  h.c.renderUtilityModalContent(); const current = h.mounted();
  pending.reject(new Error('Old library unavailable'));
  await loading;
  assert.equal(oldOwner.librarySettings.loading, false, 'old promise still settles its owned cache');
  assert.equal(h.c.state.utility.librarySettings.loaded, false);
  assert.equal(h.mounted(), current, 'old completion cannot replace new context presentation');
  assert.deepEqual(toasts, []);
});

function keyedNavigationHarness(kind) {
  const attribute = kind === 'appearance' ? 'data-utility-appearance-key' : 'data-utility-rule-key';
  const keys = kind === 'appearance'
    ? ['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page']
    : ['problem-exclusions', 'version-exclusions'];
  const document = { activeElement: null, body: {}, querySelectorAll: () => [] };
  const empty = { hidden: true };
  let nodes = [], markup = '';
  const detach = row => {
    row.isConnected = false;
    if (document.activeElement === row) document.activeElement = document.body;
  };
  function row(key, selected = false) {
    const attributes = { [attribute]: key, 'aria-current': selected ? 'true' : 'false' };
    const item = {
      isConnected: true, hidden: false, textContent: key,
      getAttribute: name => attributes[name] || null,
      setAttribute: (name, value) => { attributes[name] = String(value); },
      removeAttribute: name => { delete attributes[name]; },
      classList: { toggle() {}, add() {}, remove() {} },
      closest: selector => selector === `[${attribute}]` ? item : null,
      focus() { document.activeElement = item; },
      remove() { detach(item); nodes.splice(nodes.indexOf(item), 1); },
    };
    Object.defineProperty(item, 'nextElementSibling', { get: () => nodes[nodes.indexOf(item) + 1] || null });
    return item;
  }
  const list = {
    dataset: { utilityNavigationOwner: kind }, scrollTop: 0,
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value; nodes.forEach(detach);
      nodes = [...value.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map(match => row(match[1]));
    },
    querySelectorAll: selector => selector.includes(attribute) ? nodes : [],
    querySelector: selector => selector.includes('search-empty') ? empty : null,
    get firstElementChild() { return nodes[0] || null; },
    replaceChildren(...children) { nodes.forEach(detach); nodes = children; },
    insertBefore(item, before) {
      const existing = nodes.indexOf(item); if (existing !== -1) nodes.splice(existing, 1);
      const position = before ? nodes.indexOf(before) : nodes.length;
      nodes.splice(position, 0, item); item.isConnected = true;
    },
  };
  let content;
  const detail = {
    set innerHTML(value) { content = { markup: value }; },
    get innerHTML() { return content?.markup || ''; },
  };
  const els = { overlay: { hidden: false }, list, detail, count: {}, search: {} };
  const c = vm.createContext({ console, document,
    state: { coverLookup: {}, utility: { activeTab: kind, appearanceKey: keys[0], selectedRuleKey: keys[0],
      rules: keys.map(key => ({ key, title: key })), appearanceSearchQuery: '', rulesSearchQuery: '' } },
    getUtilityModalElements: () => els,
    window: { NavigationTree: {
      renderItem: item => `<button ${attribute}="${item.key}">${item.label}</button>`,
      setItemSelected: (item, selected) => item.setAttribute('aria-current', selected ? 'true' : 'false'),
    } },
    mountBackgroundAppearanceEditor: target => { target.innerHTML = '<section>Main elements editor</section>'; },
    mountAlertsAppearanceEditor: target => { target.innerHTML = '<section>Alerts editor</section>'; },
    buildUtilityRuleListItem: item => `<button ${attribute}="${item.key}">${item.title}</button>`,
    buildUtilityRuleDetail: item => `<section>${item.key} detail</section>`,
  });
  load(c, 'utility-renderers-and-actions', 'bootstrap-utility-event-handlers');
  c.getSelectedUtilityRule = () => c.state.utility.rules.find(item => item.key === c.state.utility.selectedRuleKey);
  // Routing and the surface renderer are real; editor contents and shared row markup
  // are narrow component adapters. The DOM model permits keyed updates and models
  // only actual innerHTML replacement as disconnection/focus loss.
  c.renderUtilityModalContent = () => kind === 'appearance' ? c.renderUtilityAppearance() : c.renderUtilityRules();
  c.renderUtilityModalContent();
  return { c, document, list, keys, nodes: () => nodes, content: () => content };
}
for (const kind of ['appearance', 'rules']) {
  test(`R1 different ${kind} selection retains real-renderer navigation while changing detail`, async () => {
    const h = keyedNavigationHarness(kind), rows = [...h.nodes()];
    const nextKey = kind === 'appearance' ? 'alerts' : 'version-exclusions';
    const attribute = kind === 'appearance' ? 'data-utility-appearance-key' : 'data-utility-rule-key';
    const selected = rows.find(item => item.getAttribute(attribute) === nextKey);
    const before = h.content(); h.list.scrollTop = 317; selected.focus();
    await h.c.handleUtilityBootstrapClick({ target: selected, preventDefault() {} });
    assert.notEqual(h.content(), before, 'a genuinely different section receives its own detail');
    assert.match(h.content().markup, kind === 'appearance' ? /Alerts editor/ : /version-exclusions detail/);
    assert.deepEqual(h.nodes(), rows, 'ordinary selection preserves every mounted navigation row');
    assert.ok(rows.every(item => item.isConnected));
    assert.equal(h.document.activeElement, selected);
    assert.equal(h.list.scrollTop, 317);
    assert.equal(selected.getAttribute('aria-current'), 'true');
  });
}

for (const operation of ['refresh', 'loadMore']) {
  test(`R4 older independent navigation cannot replace a newer accepted ordinary ${operation}`, async () => {
    const h = liveLogs(), controller = h.c.getUtilityLogHistoryController();
    const first = controller.refresh(); h.reply(0, page('a', 'initial', 'next')); await first;
    const oldNavigation = controller.refreshNavigation();
    const current = controller[operation]();
    h.reply(2, page('b', operation === 'loadMore' ? 'initial' : 'new-base')); await current;
    const accepted = plain(h.c.state.utility.logHistory);
    h.reply(1, page('old-navigation', 'old')); await oldNavigation;
    assert.deepEqual(plain(h.c.state.utility.logHistory), accepted);
    assert.deepEqual(plain(controller.getState().items), accepted);
  });
}

test('R6 returning to Library during its pending load presents that owner immediately', async () => {
  const h = mountedHarness({ activeTab: 'integrations', selectedIntegrationKey: 'library' });
  const pending = deferred();
  h.c.fetch = () => pending.promise;
  h.c.cloneRuntimeJson = value => plain(value);
  h.c.showToast = () => {};
  load(h.c, 'library-settings');
  const initial = h.c.handleLibrarySettingsIntegrationSelection('library');
  h.c.state.utility.selectedIntegrationKey = 'foobar'; h.c.renderUtilityModalContent();
  const foobar = h.mounted();
  const reopened = h.c.handleLibrarySettingsIntegrationSelection('library');
  const immediate = h.mounted();
  pending.resolve({ ok: true, json: async () => ({ ok: true, settings: {} }) });
  await Promise.all([initial, reopened]);
  assert.notEqual(immediate, foobar, 'Library selection must replace Foobar with its loading presentation before GET completion');
});

function librarySaveHarness() {
  const h = mountedHarness({ activeTab: 'integrations', selectedIntegrationKey: 'library', loaded: true,
    problematicFiles: [{ key: 'owned-problem' }] });
  const pending = deferred(), toasts = [], polls = [], statuses = [];
  h.c.fetch = () => pending.promise;
  h.c.cloneRuntimeJson = value => plain(value);
  h.c.showToast = message => toasts.push(message);
  h.c.scheduleBrowserTimeout = callback => polls.push(callback);
  h.c.pollStatus = () => {};
  h.c.updateStatusIndicator = status => statuses.push(status);
  h.c.renderLibraryLoader = () => {};
  h.c.console = { ...console, error() {} };
  load(h.c, 'library-settings');
  const settings = h.c.ensureLibrarySettingsState();
  settings.allowedActions = { 'library.settings.manage': true };
  settings.draft = h.c.normalizeLibrarySettingsPayload({});
  return { ...h, pending, toasts, polls, statuses };
}
for (const replaceContext of [false, true]) {
  for (const failure of [false, true]) {
    test(`R6 pending Library Save ${failure ? 'failure' : 'success'} cannot publish into ${replaceContext ? 'a replacement library' : 'Foobar detail'}`, async () => {
      const h = librarySaveHarness(), owner = h.c.state.utility;
      const saving = h.c.saveUtilityLibrarySettings();
      if (replaceContext) h.c.state.utility = { activeTab: 'integrations', selectedIntegrationKey: 'library', loaded: true,
        problematicFiles: [{ key: 'replacement-problem' }], librarySettings: { loaded: false } };
      else owner.selectedIntegrationKey = 'foobar';
      h.c.renderUtilityModalContent(); const displayed = h.mounted();
      const current = h.c.state.utility, beforeProblems = current.problematicFiles;
      h.pending.resolve({ ok: !failure, json: async () => failure
        ? { ok: false, error: 'Library save failed' }
        : { ok: true, settings: {}, status: { scan_in_progress: true } } });
      assert.equal(await saving, !failure);
      assert.equal(h.mounted(), displayed, 'a completed save cannot remount an unrelated presentation');
      assert.deepEqual(h.toasts, []);
      assert.equal(owner.librarySettings.saveBusy, false);
      if (replaceContext) {
        assert.equal(current.problematicFiles, beforeProblems, 'replacement library cache remains intact');
        assert.equal(current.loaded, true);
        assert.deepEqual(h.polls, []);
        assert.deepEqual(h.statuses, []);
      } else if (!failure) {
        assert.equal(owner.loaded, false, 'successful mutation invalidates only its own library cache');
        assert.deepEqual(plain(owner.problematicFiles), []);
      }
    });
  }
}
test('R6 current Library Save updates its owned cache and completion presentation exactly once', async () => {
  const h = librarySaveHarness(), owner = h.c.state.utility;
  let clears = 0, problems = owner.problematicFiles, renders = 0;
  Object.defineProperty(owner, 'problematicFiles', { get: () => problems, set: value => { clears++; problems = value; } });
  const render = h.c.renderUtilityModalContent;
  h.c.renderUtilityModalContent = () => { renders++; render(); };
  const saving = h.c.saveUtilityLibrarySettings();
  const initialRenders = renders;
  h.pending.resolve({ ok: true, json: async () => ({ ok: true, settings: {} }) });
  assert.equal(await saving, true);
  assert.equal(clears, 1);
  assert.equal(owner.librarySettings.loaded, true);
  assert.equal(owner.librarySettings.saveBusy, false);
  assert.equal(renders - initialRenders, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.polls.length, 1);
});
