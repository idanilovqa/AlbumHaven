const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');
const { countedCollection, createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter');
const { createRequestCapture, jsonResponse, assertInteractionRequests } = require('../helpers/request-capture');

const root = path.resolve(__dirname, '../../..');
const tabs = ['problematic-files', 'rules', 'loops', 'log-history', 'integrations', 'appearance'];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function element(attributes = {}) {
  return {
    attributes, hidden: false, disabled: false, innerHTML: '', textContent: '',
    classList: { toggle() {}, remove() {}, contains() { return false; } },
    getAttribute(name) { return attributes[name] || ''; },
    setAttribute(name, value) { attributes[name] = value; },
    focus() { this.focused = true; },
  };
}

function harness({ fullProblematicRendering = false } = {}) {
  const els = {
    tabs: tabs.map((name) => element({ 'data-utility-tab': name })),
    problemFilterButton: element(), problemFilterMenu: element(), problemFilterChips: element(),
  };
  const context = {
    closeTagEditorExceptionMenu() {},
    getTagEditorElements: () => ({ form: null }),
    state: {
      utility: { activeTab: tabs[0], loaded: true, problemDropdownOpen: false, problematicFiles: [], selectedProblemFilters: [], repairSelections: {}, loops: [] },
      coverLookup: { drawerOpen: false }, tagEditor: {},
    },
    document: {
      createElement: () => element(),
      querySelectorAll(selector) { return selector.includes('data-utility-tab') ? els.tabs : []; },
      getElementById(id) {
        if (id === 'navigation-tree-item-template') return { textContent: read('music_app/templates/components/navigation-tree-item.html') };
        return id === 'utility-problem-filter-button' ? els.problemFilterButton : id === 'utility-problem-filter-menu' ? els.problemFilterMenu : null;
      },
    },
    getUtilityModalElements: () => els,
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    renderUtilityModalContent() {}, loadProblematicFiles() {}, loadUtilityRules() {}, loadUtilityLibrarySettings() {}, loadUtilityLoops() {}, loadUtilityLogHistory() {}, loadUtilityIntegrations() {},
    openMobileUtilityDetail() {},
    getAvailableAlbumMoveActions: () => [],
    buildAlbumDisplayCoverUrl: (album) => album.cover_ref ? `/cover/${encodeURIComponent(album.cover_ref)}` : '',
    buildAlbumLightboxCoverUrl: (album) => album.cover_ref ? `/cover/${encodeURIComponent(album.cover_ref)}?size=original` : (album.remote_cover_url || album.remote_cover_thumbnail_url || ''),
    formatLoopTime: (value) => String(value),
  };
  context.window = context;
  vm.createContext(context);
  loadPendingProjectionFetch(context);
  vm.runInContext(read('music_app/static/js/button-component.js'), context);
  vm.runInContext(read('music_app/static/js/runtime/alert-components.js'), context);
  vm.runInContext(read('music_app/static/js/navigation-tree.js'), context, { filename: 'navigation-tree.js' });
  for (const file of ['album-artbox', 'problematic-album-helpers', 'loop-range-controls', 'playback-control-cluster', 'player-and-waveform', 'utility-list-builders', 'utility-loop-playback', 'bootstrap-utility-event-handlers']) {
    vm.runInContext(read(`music_app/static/js/runtime/${file}.js`), context, { filename: `${file}.js` });
  }
  // Artwork-only cases omit table internals; runtime contracts keep the real builders.
  if (!fullProblematicRendering) {
    context.buildDetectedProblemsHtml = () => '';
    context.getProblematicAlbumIssueLabel = () => 'Missing year';
  }
  els.tabs.forEach((tab) => {
    tab.closest = (selector) => selector.includes('data-utility-tab') ? tab : null;
    tab.click = () => context.handleUtilityBootstrapClick({ target: tab, preventDefault() {} });
  });
  return { context, els };
}

test('S01 all six Settings tabs route through the live click handler', async () => {
  const { context, els } = harness();
  for (const tab of els.tabs) {
    await tab.click();
    assert.equal(context.state.utility.activeTab, tab.getAttribute('data-utility-tab'));
  }
});

for (const [key, start, expected] of [['ArrowRight', 5, 0], ['ArrowLeft', 0, 5], ['Home', 3, 0], ['End', 2, 5]]) {
  test(`S01 tab ${key} focuses and activates the correct tab`, () => {
    const { context, els } = harness();
    context.state.utility.activeTab = tabs[start];
    let prevented = false;
    context.handleUtilityBootstrapKeyDown({ key, target: els.tabs[start], preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'consume only the handled navigation key');
    assert.equal(els.tabs[expected].focused, true, 'focus follows the selected tab');
    assert.equal(context.state.utility.activeTab, tabs[expected]);
  });
}

test('S03 Escape closes the filter dropdown and restores its anchor focus', () => {
  const { context, els } = harness();
  context.state.utility.problemDropdownOpen = true;
  const modal = {
    id: 'utility-modal', classList: { contains: () => false },
    closest: selector => selector.includes('[hidden]') ? null : modal,
    getClientRects: () => [{}],
  };
  const listeners = [];
  context.document.querySelectorAll = () => [modal];
  context.document.addEventListener = (type, listener, capture) => listeners.push({ type, listener, capture });
  context.getComputedStyle = () => ({ zIndex: '100', position: 'fixed', opacity: '1', visibility: 'visible' });
  context.getTrackModalElements = () => ({ overlay: { dataset: {}, addEventListener() {} } });
  context.bindOverlayPointerOrigin = () => {};
  vm.runInContext(read('music_app/static/js/runtime/track-modal-lightbox-helpers.js'), context);
  context.attachModalEvents();
  const target = { closest: selector => selector.includes('problem-filter') ? els.problemFilterMenu : null };
  let prevented = false;
  const capture = listeners.find(entry => entry.type === 'keydown' && entry.capture === true);
  capture.listener({ key: 'Escape', target, preventDefault() { prevented = true; } });
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(els.problemFilterButton.focused, true);
  assert.equal(prevented, true);
});

test('mobile Settings filter Escape closes its page-owned dropdown and restores focus without closing the page', () => {
  const { context, els } = harness();
  context.state.utility.problemDropdownOpen = true;
  context.closeUtilityModal = () => { throw new Error('Filter Escape must not close Settings'); };
  const target = { closest: selector => selector.includes('problem-filter') ? els.problemFilterMenu : null };
  let prevented = false;
  assert.equal(context.handleUtilityBootstrapKeyDown({ key: 'Escape', target,
    preventDefault() { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(els.problemFilterMenu.hidden, true);
  assert.equal(els.problemFilterButton.getAttribute('aria-expanded'), 'false');
  assert.equal(els.problemFilterButton.focused, true);
});

test('S01 ordinary typing and modified shortcuts do not change the active tab', () => {
  const { context, els } = harness();
  for (const properties of [{ key: 'a' }, { key: 'ArrowRight', ctrlKey: true }, { key: 'End', defaultPrevented: true }]) {
    let prevented = false;
    context.handleUtilityBootstrapKeyDown({ ...properties, target: els.tabs[0], preventDefault() { prevented = true; } });
    assert.equal(context.state.utility.activeTab, tabs[0]);
    assert.equal(prevented, false);
  }
});

test('S03 ArrowDown opens Filters and focuses its first option', () => {
  const { context, els } = harness();
  const option = element({ 'data-problem-filter-value': 'Missing year' });
  els.problemFilterButton.closest = (selector) => selector.includes('problem-filter') ? els.problemFilterButton : null;
  els.problemFilterMenu.querySelectorAll = () => [option];
  els.problemFilterMenu.querySelector = () => option;
  let prevented = false;
  context.handleUtilityBootstrapKeyDown({ key: 'ArrowDown', target: els.problemFilterButton, preventDefault() { prevented = true; } });
  assert.equal(context.state.utility.problemDropdownOpen, true);
  assert.equal(option.focused, true);
  assert.equal(prevented, true);
});

for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
  for (const hasProblems of [false, true]) {
    test(`Logs Period ${key} never opens Problems filters (${hasProblems ? 'with' : 'without'} problems)`, () => {
      const { context, els } = harness();
      context.state.utility.activeTab = 'log-history';
      context.state.utility.problematicFiles = hasProblems ? [{ problem_reasons: ['Missing year'] }] : [];
      els.problemFilterMenu.hidden = true;
      els.problemFilterMenu.querySelectorAll = () => [];
      els.problemFilterButton.setAttribute('aria-label', 'Period');
      els.problemFilterButton.closest = selector => selector.includes('problem-filter') ? els.problemFilterButton : null;
      context.handleUtilityBootstrapKeyDown({ key, target: els.problemFilterButton, preventDefault() {} });
      assert.equal(context.state.utility.problemDropdownOpen, false);
      assert.equal(els.problemFilterMenu.hidden, true);
      assert.equal(els.problemFilterButton.disabled, false);
      assert.equal(els.problemFilterButton.getAttribute('aria-label'), 'Period');
      assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), []);
    });
  }
}

test('S03 search editing keys inside the filter wrapper keep native input behavior', () => {
  const { context, els } = harness();
  const wrapper = element();
  const input = {
    tagName: 'INPUT', type: 'search',
    closest(selector) { return selector.split(',').map(value => value.trim()).includes('.utility-problem-filter') ? wrapper : null; },
  };
  for (const key of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
    let prevented = false;
    context.handleUtilityBootstrapKeyDown({ key, target: input, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, `${key} belongs to the search input`);
    assert.equal(context.state.utility.problemDropdownOpen, false);
    assert.notEqual(els.problemFilterButton.focused, true);
  }
});

test('S03 disabled Filters does not activate through keyboard navigation', () => {
  const { context, els } = harness();
  els.problemFilterButton.disabled = true;
  els.problemFilterButton.closest = (selector) => selector.includes('problem-filter') ? els.problemFilterButton : null;
  let prevented = false;
  context.handleUtilityBootstrapKeyDown({ key: 'ArrowDown', target: els.problemFilterButton, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(context.state.utility.problemDropdownOpen, false);
});

test('S03 filter menu uses the shared trigger anchor and clears it when closed', () => {
  const { context, els } = harness();
  const anchored = [];
  const cleared = [];
  context.getProblemReasonTypes = () => ['Missing year', 'Encoding'];
  context.syncTriggerAnchor = (menu, anchor) => anchored.push([menu, anchor]);
  context.clearTriggerAnchor = (menu) => cleared.push(menu);
  context.state.utility.problemDropdownOpen = true;
  context.renderProblemFilterControls(els);
  assert.deepEqual(anchored, [[els.problemFilterMenu, els.problemFilterButton]]);
  assert.equal(els.problemFilterMenu.hidden, false);
  assert.equal(els.problemFilterButton.getAttribute('aria-expanded'), 'true');
  context.state.utility.problemDropdownOpen = false;
  context.renderProblemFilterControls(els);
  assert.deepEqual(cleared, [els.problemFilterMenu]);
  assert.equal(els.problemFilterMenu.hidden, true);
});

test('S03 the integrated search control labels Filters without replacing its shared icon', () => {
  const { context, els } = harness();
  context.getProblemReasonTypes = () => ['Missing year'];
  Object.defineProperty(els.problemFilterButton, 'textContent', {
    set() { assert.fail('Filters must preserve the shared search-filter icon'); },
  });
  context.renderProblemFilterControls(els);
  assert.equal(els.problemFilterButton.getAttribute('aria-label'), 'Filters');
  context.state.utility.selectedProblemFilters = ['Missing year'];
  context.renderProblemFilterControls(els);
  assert.equal(els.problemFilterButton.getAttribute('aria-label'), 'Filters (1)');
});

const album = { key: 'test-album', album: 'Test album', name: 'Test album', album_artist: 'Test artist', artist: 'Test artist', year: 2024, tracks: [], problem_reasons: [] };
const loop = { id: 'test-loop', name: 'Test loop', title: 'Test song', artist: 'Test artist', album: 'Test album', year: 2024 };

for (const kind of ['problematic', 'loops']) {
  for (const available of [true, false]) {
    test(`S05 ${kind} header ${available ? 'available' : 'missing'} artwork has the shared Artbox activation contract`, () => {
      const { context } = harness();
      const cover_ref = available ? 'test-cover.jpg' : '';
      const item = { ...loop, cover_ref };
      const html = kind === 'problematic'
        ? context.buildProblematicAlbumDetail({ ...album, cover_ref })
        : context.buildUtilityLoopDetail({ key: 'song', loops: [item], representativeLoop: item });
      assert.match(html, new RegExp(`data-album-artbox-state="${available ? 'ready' : 'missing'}"`));
      if (available) {
        assert.match(html, /<button\b[^>]*data-open-lightbox="1"[^>]*>/);
        assert.match(html, /data-cover-src="\/cover\/test-cover.jpg(?:\?size=original)?"/);
      } else {
        assert.match(html, /album-artbox__missing-slash/);
        assert.doesNotMatch(html, /data-open-lightbox="1"/);
      }
    });
  }
}

test('S04 wide NavigationTree keeps its count in a hidden secondary column', () => {
  const { context } = harness();
  const html = context.window.NavigationTree.renderItem({
    variant: 'wide', action: true, label: 'Test album', subtitle: 'Test artist', year: 2024,
    count: 12, countHidden: true,
    artworkHtml: context.buildAlbumArtboxHtml({ state: 'missing' }),
  });
  assert.match(html, /<span\b[^>]*class="[^"]*navigation-tree-count[^"]*"[^>]*\bhidden\b[^>]*>12<\/span>/);
  assert.match(html, /Test artist/);
  assert.match(html, /2024/);
  assert.match(html, /data-album-artbox-state="missing"/);
  assert.match(html, /type="button"/);
});

test('S04 the wide extension preserves default NavigationTree escaping and link semantics', () => {
  const { context } = harness();
  const html = context.window.NavigationTree.renderItem({
    label: '<Artist & band>', href: 'javascript:alert(1)', key: 'quoted"key', count: 12, selected: true,
  });
  assert.match(html, /^<a\b/);
  assert.match(html, /href="#"/);
  assert.match(html, /&lt;Artist &amp; band&gt;/);
  assert.match(html, /data-navigation-tree-key="quoted&quot;key"/);
  assert.match(html, /data-navigation-tree-item="artists"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /<span class="navigation-tree-count artist-count">12<\/span>/);
  assert.doesNotMatch(html, /\bhidden\b/);
});

for (const kind of ['problematic', 'loops']) {
  test(`S04 ${kind} tree row shows shared artwork and real title artist and year`, () => {
    const { context } = harness();
    const html = kind === 'problematic'
      ? context.buildProblematicAlbumListItem({ ...album, cover_ref: 'test-cover.jpg' }, true)
      : context.buildUtilityLoopTree({ key: 'song', loops: [loop], representativeLoop: { ...loop, cover_ref: 'test-cover.jpg' } }, 'song', '');
    assert.match(html, /data-album-artbox-state="ready"/);
    assert.match(html, kind === 'problematic' ? /Test album/ : /Test song/);
    assert.match(html, /Test artist/);
    assert.match(html, /2024/);
  });

  test(`S04 ${kind} tree row without art or year does not invent either`, () => {
    const { context } = harness();
    const unknown = { ...loop, year: null };
    const html = kind === 'problematic'
      ? context.buildProblematicAlbumListItem({ ...album, year: null }, false)
      : context.buildUtilityLoopTree({ key: 'song', loops: [unknown], representativeLoop: unknown }, '', '');
    assert.match(html, /data-album-artbox-state="missing"/);
    assert.match(html, /album-artbox__missing-slash/);
    assert.doesNotMatch(html, /Unknown year|2024|data-open-lightbox/);
  });
}

test('S01/S03 live Settings template removes redundant visible shell and sidebar headings', () => {
  const template = read('music_app/templates/partials/primary-modals.html').split('<div class="tag-editor-modal"')[0];
  assert.doesNotMatch(template, /<h2[^>]*>Utilities<\/h2>/);
  assert.doesNotMatch(template, /class="utility-modal-subtitle"/);
  assert.doesNotMatch(template, /class="utility-sidebar-title"/);
  assert.match(template, /role="tablist"/);
  assert.equal((template.match(/data-utility-tab="/g) || []).length, 7);
});

test('S05 remote thumbnail keeps the original remote artwork as its enlargement source', () => {
  const { context } = harness();
  const remote = {
    remote_cover_thumbnail_url: 'https://example.test/thumbnail.jpg',
    remote_cover_url: 'https://example.test/original.jpg',
  };
  context.buildAlbumDisplayCoverUrl = (value) => value.remote_cover_thumbnail_url;
  const html = context.buildUtilityAlbumArtbox(remote, { interactive: true });
  assert.match(html, /src="https:\/\/example.test\/thumbnail.jpg"/);
  assert.match(html, /data-cover-src="https:\/\/example.test\/original.jpg"/);
});

test('S04 tree artwork uses native lazy loading and asynchronous image decoding', () => {
  const { context } = harness();
  const html = context.buildUtilityAlbumArtbox({ cover_ref: 'test-cover.jpg' });
  assert.match(html, /<img\b[^>]*loading="lazy"/);
  assert.match(html, /<img\b[^>]*decoding="async"/);
});

test('S05 selected header artwork loads eagerly with asynchronous image decoding', () => {
  const { context } = harness();
  const html = context.buildUtilityAlbumArtbox({ cover_ref: 'test-cover.jpg' }, { interactive: true });
  assert.match(html, /<img\b[^>]*loading="eager"/);
  assert.match(html, /<img\b[^>]*decoding="async"/);
});

function failedArtwork({ remote = '', interactive = true } = {}) {
  const trigger = interactive ? element({ 'data-cover-src': '/cover/local.jpg' }) : null;
  const artbox = element({ 'aria-label': 'Test album artwork' });
  artbox.closest = () => trigger;
  const image = element({ 'data-remote-cover-url': remote });
  image.dataset = {};
  image.src = '/cover/local.jpg';
  image.closest = (selector) => selector === '.album-artbox' ? artbox : trigger;
  return { image, artbox, trigger };
}

test('S05 exhausted local artwork replaces the entire enlargement trigger with missing Artbox', () => {
  const { context } = harness();
  const { image, trigger } = failedArtwork();
  context.handleUtilityAlbumArtboxError(image);
  assert.match(trigger.outerHTML, /data-album-artbox-state="missing"/);
  assert.match(trigger.outerHTML, /album-artbox__missing-slash/);
  assert.match(trigger.outerHTML, /aria-label="Test album artwork"/);
  assert.doesNotMatch(trigger.outerHTML, /<button|data-open-lightbox|data-cover-src/);
});

test('S05 local artwork tries the full remote fallback once then removes enlargement on failure', () => {
  const { context } = harness();
  const original = 'https://example.test/original.jpg';
  const { image, trigger } = failedArtwork({ remote: original });
  context.handleUtilityAlbumArtboxError(image);
  assert.equal(image.src, original);
  assert.equal(trigger.getAttribute('data-cover-src'), original);
  assert.equal(trigger.outerHTML, undefined, 'first failure leaves the fallback eligible to load');
  context.handleUtilityAlbumArtboxError(image);
  assert.match(trigger.outerHTML, /data-album-artbox-state="missing"/);
  assert.doesNotMatch(trigger.outerHTML, /<button|data-open-lightbox/);
});

test('S05 failed noninteractive tree artwork becomes missing without adding an enlargement', () => {
  const { context } = harness();
  const { image, artbox } = failedArtwork({ interactive: false });
  context.handleUtilityAlbumArtboxError(image);
  assert.match(artbox.outerHTML, /data-album-artbox-state="missing"/);
  assert.doesNotMatch(artbox.outerHTML, /<button|data-open-lightbox/);
});

test('S02 tab alignment observers and scroll listeners are disposed on close and recreated once on reopen', () => {
  const { context, els } = harness();
  const observers = [];
  const listeners = new Set();
  const header = { style: { setProperty() {} }, getBoundingClientRect: () => ({ left: 10, width: 500 }) };
  const strip = {
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 20, right: 110 }) }),
    addEventListener(name, listener) { if (name === 'scroll') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'scroll') listeners.delete(listener); },
  };
  els.overlay = { hidden: false, querySelector: (selector) => selector === '.utility-modal-tabs' ? strip : header };
  context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  context.document.body = { classList: { remove() {} } };
  context.resumeDeferredUtilityViewRequest = () => {};
  vm.runInContext(read('music_app/static/js/runtime/utility-renderers-and-actions.js'), context);
  let problematicListDisposals = 0;
  context.disposeProblematicFilesVirtualList = () => { problematicListDisposals += 1; };
  // Load the real close boundary without unrelated network loader initialization.
  const loaders = read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js');
  const close = loaders.slice(loaders.indexOf('function closeUtilityModal('), loaders.indexOf('let repairConfirmReturnFocus'));
  vm.runInContext(`let utilityCoverLoadSuspensionToken = 0; let utilityOpenGeneration = 0;\n${close}`, context);
  context.syncUtilityTabAlignment(els);
  context.syncUtilityTabAlignment(els);
  assert.equal(observers.length, 1, 'repeated rendering reuses one observer');
  assert.equal(listeners.size, 1);
  els.list = { scrollTop: 720 };
  context.closeUtilityModal(true);
  assert.equal(els.overlay.hidden, true);
  assert.equal(problematicListDisposals, 1, 'closing Settings disposes the retained Problematic Files window');
  assert.equal(els.list.scrollTop, 0, 'closing Settings clears the retained Problematic Files window');
  assert.equal(observers[0].disconnected, true, 'hidden Settings releases its resize observer');
  assert.equal(listeners.size, 0, 'hidden Settings releases its scrolling listener');
  els.overlay.hidden = false;
  context.syncUtilityTabAlignment(els);
  context.syncUtilityTabAlignment(els);
  assert.equal(observers.length, 2);
  assert.equal(listeners.size, 1);
  assert.equal(observers[1].disconnected, false);
});

test('S02 resize reveals the selected tab inside its strip while manual scrolling remains free', () => {
  const { context, els } = harness();
  const observers = [];
  const scrollListeners = new Set();
  let stripWidth = 800;
  const selected = {
    getBoundingClientRect: () => ({ left: 610 - strip.scrollLeft, right: 710 - strip.scrollLeft, width: 100 }),
    scrollIntoView() { assert.fail('revealing a Settings tab must not scroll the outer document'); },
  };
  const strip = {
    scrollLeft: 0, scrollWidth: 800,
    get clientWidth() { return stripWidth; },
    getBoundingClientRect: () => ({ left: 10, right: 10 + stripWidth, width: stripWidth }),
    querySelector: () => selected,
    addEventListener(name, callback) { if (name === 'scroll') scrollListeners.add(callback); },
    removeEventListener(name, callback) { if (name === 'scroll') scrollListeners.delete(callback); },
  };
  const header = { style: { setProperty() {} }, getBoundingClientRect: () => ({ left: 10, right: 10 + stripWidth, width: stripWidth }) };
  els.overlay = { hidden: false, querySelector: (selector) => selector === '.utility-modal-tabs' ? strip : header };
  context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  vm.runInContext(read('music_app/static/js/runtime/utility-renderers-and-actions.js'), context);
  context.syncUtilityTabAlignment(els);
  assert.equal(strip.scrollLeft, 0, 'an already visible selected tab does not move');
  stripWidth = 300;
  observers[0].callback();
  assert.ok(selected.getBoundingClientRect().right <= strip.getBoundingClientRect().right, 'resize reveals the selected right edge');
  assert.ok(selected.getBoundingClientRect().left >= strip.getBoundingClientRect().left, 'resize keeps the full selected tab visible');
  const revealedScroll = strip.scrollLeft;
  observers[0].callback();
  assert.equal(strip.scrollLeft, revealedScroll, 'repeated resize delivery does not drift');
  strip.scrollLeft = 0;
  for (const listener of scrollListeners) listener();
  assert.equal(strip.scrollLeft, 0, 'manual scroll can inspect other tabs without snapping back');
  assert.equal(observers.length, 1);
  assert.equal(scrollListeners.size, 1);
});

function problematicSelectionHarness({ detailLoaded = true } = {}) {
  const { context, els } = harness();
  const albums = ['alpha', 'beta'].map(key => ({
    key, name: key, album: key, album_artist: 'Artist', tracks: [], repair_preview_rows: [],
    track_problem_rows: [], problematic_track_paths: [], cover_ref: `${key}.jpg`, detail_loaded: key === 'alpha' || detailLoaded,
  }));
  Object.assign(context.state.utility, { problematicFiles: albums, selectedProblematicKey: 'alpha', detailLoadPromises: {} });
  els.overlay = { hidden: false, setAttribute() {} };
  els.count = element();
  els.detail = element();
  els.detail.removeAttribute = () => {};
  let detailWrites = 0;
  let detailHtml = '';
  Object.defineProperty(els.detail, 'innerHTML', {
    get: () => detailHtml,
    set(value) { detailWrites++; detailHtml = value; },
  });
  let listHtml = '';
  let writes = 0;
  let forcedScrolls = 0;
  let rows = [];
  els.list = {
    scrollTop: 420,
    get children() { return rows; },
    get innerHTML() { return listHtml; },
    set innerHTML(value) {
      writes++;
      listHtml = value;
      rows = Array.from(value.matchAll(/data-problematic-album-key="([^"]+)"/g), match => {
        const row = element({ 'data-problematic-album-key': match[1], 'data-navigation-tree-item': 'wide' });
        const classes = new Set();
        row.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) };
        row.removeAttribute = name => delete row.attributes[name];
        row.closest = selector => selector.includes('[data-problematic-album-key]') ? row : null;
        row.focus = () => { context.document.activeElement = row; };
        row.scrollIntoView = () => { forcedScrolls++; };
        const album = context.state.utility.problematicFiles.find(item => item.key === match[1]);
        const title = { textContent: album.name };
        const metadata = {
          children: [],
          get firstChild() { return this.children[0] || null; },
          querySelector(selector) { return this.children.find(child => `.${child.className}` === selector) || null; },
          insertBefore(child, reference) {
            const index = reference ? this.children.indexOf(reference) : this.children.length;
            this.children.splice(index, 0, child);
            child.remove = () => this.children.splice(this.children.indexOf(child), 1);
          },
        };
        for (const [className, value] of [['utility-list-item-subtitle', album.album_artist], ['utility-list-item-year', album.year]]) {
          if (value) metadata.insertBefore({ className, textContent: String(value) }, null);
        }
        const count = { textContent: String(album.track_count ?? album.tracks.length) };
        let artworkHtml = context.buildUtilityAlbumArtbox(album, { label: `Artwork for ${album.name}` });
        let image = element({ src: `/cover/${album.cover_ref}` });
        image.src = image.getAttribute('src');
        const artwork = {
          get innerHTML() { return artworkHtml; },
          set innerHTML(value) { artworkHtml = value; image = element(); },
          querySelector: selector => selector === 'img' ? image : null,
        };
        row.querySelector = selector => ({
          '.utility-list-item-title': title, '.utility-list-item-meta': metadata,
          '.navigation-tree-count': count, '.navigation-tree-artwork': artwork, 'img': image,
        })[selector] || null;
        return row;
      });
    },
    querySelectorAll: () => rows,
    querySelector: selector => selector.includes('.is-active')
      ? rows.find(row => row.getAttribute('data-problematic-album-key') === context.state.utility.selectedProblematicKey)
      : rows.find(row => selector.includes(row.getAttribute('data-problematic-album-key'))) || null,
  };
  vm.runInContext(read('music_app/static/js/runtime/utility-renderers-and-actions.js'), context);
  vm.runInContext(read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), context);
  context.getFilteredProblematicAlbums = () => context.state.utility.problematicFiles;
  context.buildProblematicAlbumDetail = value => `Details for ${value.key}`;
  context.renderProblemFilterControls = () => {};
  context.getProblematicUtilityNow = () => 0;
  context.roundProblematicUtilityMs = value => value;
  context.waitForProblematicUtilityRenderFrame = async () => {};
  context.recordProblematicUtilityDiagnostics = () => {};
  context.showToast = () => {};
  context.console = { error() {} };
  context.syncUtilityTabAlignment = () => {};
  context.cssEscape = value => value;
  context.renderUtilityModalContent();
  const originalRows = rows.slice();
  const originalWrites = writes;
  originalRows[1].focus();
  return {
    context, els, originalRows,
    get forcedScrolls() { return forcedScrolls; },
    get detailWrites() { return detailWrites; },
    click: () => context.handleUtilityBootstrapClick({ target: originalRows[1], preventDefault() {} }),
    assertStable() {
      assert.equal(writes, originalWrites, 'selection must not replace the navigation list HTML');
      assert.equal(rows[1], originalRows[1]);
      assert.equal(context.document.activeElement, originalRows[1]);
      assert.equal(els.list.scrollTop, 420);
      assert.equal(originalRows[1].classList.contains('is-selected'), true);
    },
  };
}

test('S04 clicking cached Problematic album retains tree identity scroll and focus', async () => {
  const runtime = problematicSelectionHarness();
  await runtime.click();
  assert.equal(runtime.els.detail.innerHTML, 'Details for beta');
  runtime.assertStable();
  const detailWrites = runtime.detailWrites;
  await runtime.click();
  runtime.assertStable();
  assert.equal(runtime.detailWrites, detailWrites, 'clicking the current cached album does not rebuild its detail');
});

test('S04 hydration updates title year and count while retaining its mounted row and unchanged image', async () => {
  const runtime = problematicSelectionHarness({ detailLoaded: false });
  const row = runtime.originalRows[1];
  const image = row.querySelector('img');
  let respond;
  runtime.context.fetch = () => new Promise(resolve => { respond = resolve; });
  await runtime.click();
  const request = runtime.context.state.utility.detailLoadPromises.beta;
  respond({ ok: true, status: 200, json: async () => ({
    ...runtime.context.state.utility.problematicFiles[1],
    name: 'Hydrated title', album: 'Hydrated title', album_artist: 'Hydrated artist', year: 2025, track_count: 12,
    detail_loaded: true,
  }) });
  await request;
  assert.equal(row.querySelector('.utility-list-item-title').textContent, 'Hydrated title');
  const metadata = row.querySelector('.utility-list-item-meta');
  assert.equal(metadata.querySelector('.utility-list-item-subtitle').textContent, 'Hydrated artist');
  assert.equal(metadata.querySelector('.utility-list-item-year').textContent, '2025');
  assert.equal(row.querySelector('.navigation-tree-count').textContent, '12');
  assert.equal(row.querySelector('img'), image, 'metadata changes must not restart an unchanged artwork request');
  runtime.assertStable();
});

test('S04 clicking the current cached album does not rebuild the detail panel', async () => {
  const runtime = problematicSelectionHarness();
  await runtime.click();
  const detailWrites = runtime.detailWrites;
  await runtime.click();
  assert.equal(runtime.detailWrites, detailWrites);
});

test('S04 closing an open Filters menu by clicking an album preserves the clicked tree row', async () => {
  const runtime = problematicSelectionHarness();
  runtime.context.state.utility.problemDropdownOpen = true;
  await runtime.click();
  assert.equal(runtime.context.state.utility.problemDropdownOpen, false);
  assert.equal(runtime.els.detail.innerHTML, 'Details for beta');
  runtime.assertStable();
});

test('S04 explicit album selection clears an older track-navigation scroll target', async () => {
  const runtime = problematicSelectionHarness();
  runtime.context.state.utility.focusedTrackPath = 'old-album/old-track.flac';
  await runtime.click();
  assert.equal(runtime.context.state.utility.focusedTrackPath, '');
  assert.equal(runtime.forcedScrolls, 0);
  runtime.assertStable();
});

test('S04 a changed problematic collection still rebuilds its navigation rows', () => {
  const runtime = problematicSelectionHarness();
  runtime.context.state.utility.problematicFiles = [runtime.context.state.utility.problematicFiles[0]];
  runtime.context.renderUtilityModalContent();
  assert.equal(runtime.els.list.children.length, 1);
  assert.notEqual(runtime.els.list.children[0], runtime.originalRows[0]);
  assert.equal(runtime.els.list.children[0].getAttribute('data-problematic-album-key'), 'alpha');
});

for (const success of [true, false]) {
  test(`S04 async Problematic detail ${success ? 'success' : 'failure'} preserves clicked tree row`, async () => {
    const runtime = problematicSelectionHarness({ detailLoaded: false });
    let respond;
    runtime.context.fetch = () => new Promise(resolve => { respond = resolve; });
    await runtime.click();
    const request = runtime.context.state.utility.detailLoadPromises.beta;
    assert.ok(request, 'click starts its real detail request');
    const pendingDetail = runtime.els.detail.innerHTML;
    respond({
      ok: success, status: success ? 200 : 503,
      json: async () => success ? {
        ...runtime.context.state.utility.problematicFiles[1], detail_loaded: true,
      } : { error: 'Unavailable' },
    });
    await request;
    assert.match(runtime.els.detail.innerHTML, success ? /Details for beta/ : /Unable to load/);
    runtime.assertStable();
    assert.match(pendingDetail, /Loading selected problematic album/);
  });
}


// This measures the supported HTML fallback with the real loader, renderers,
// NavigationTree markup and detail builders. Virtualized DOM/layout keeps its
// separate component and measured-browser gates.
test('BI Problematic Files loader renders one cursor page and selected detail after an owned pending retry at production scale (HTML fallback)', async (t) => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#loadProblematicFiles';
  const run = async (remoteAlbumCount) => {
    const { context, els } = harness({ fullProblematicRendering: true });
    const counter = createInteractionCounter();
    let measuring = false;
    const count = (field, amount = 1) => { if (measuring) counter.count(field, amount); };
    const timers = new Map();
    let timerId = 0;
    let frameId = 0;
    const errors = [];
    const toasts = [];
    const renderStages = [];
    Object.assign(els, {
      overlay: element(), list: element(), detail: element(), count: element(),
      search: element(), sidebarLabel: element(),
    });
    els.list.dataset = new Proxy({}, {
      set(target, key, value) { count('domMutations'); target[key] = value; return true; },
    });
    els.list.scrollTop = 0;
    els.detail.scrollTop = 0;
    for (const target of [...els.tabs, ...Object.values(els).filter(value => !Array.isArray(value))]) {
      for (const field of ['innerHTML', 'textContent', 'value', 'disabled', 'hidden', 'readOnly']) {
        let value = target[field];
        Object.defineProperty(target, field, {
          configurable: true,
          get: () => value,
          set(next) { count('domMutations'); value = next; },
        });
      }
      const setAttribute = target.setAttribute.bind(target);
      target.setAttribute = (...args) => { count('domMutations'); return setAttribute(...args); };
      target.removeAttribute = name => { count('domMutations'); delete target.attributes[name]; };
      for (const method of ['toggle', 'remove']) {
        const mutate = target.classList[method].bind(target.classList);
        target.classList[method] = (...args) => { count('domMutations'); return mutate(...args); };
      }
      target.querySelector = () => null;
      target.querySelectorAll = () => [];
      target.addEventListener = () => count('listeners');
    }
    const countedArrays = new WeakSet();
    const pageArray = value => {
      if (!Array.isArray(value) || countedArrays.has(value)) return value;
      const observed = countedCollection(value, counter);
      countedArrays.add(observed);
      return observed;
    };
    let loadedPage = pageArray([]);
    Object.defineProperty(context.state.utility, 'problematicFiles', {
      configurable: true,
      get: () => loadedPage,
      set: value => { loadedPage = pageArray(value); },
    });
    const unrelatedCounter = createInteractionCounter();
    context.state.view = {
      artist_groups: countedCollection(Array.from({ length: remoteAlbumCount }, (_, index) => ({ artist: `Unrelated ${index}`, albums: [] })), unrelatedCounter),
    };
    Object.assign(context.state.utility, {
      activeTab: 'problematic-files', loaded: false, loading: false, loadPromise: null,
      detailLoadPromises: {}, selectedProblematicKey: '', selectedProblemFilters: [],
      problemDropdownOpen: false, searchQuery: '',
      loops: countedCollection(Array.from({ length: remoteAlbumCount }, (_, index) => ({ id: `unrelated-loop-${index}` })), unrelatedCounter),
    });
    context.state.ui = { viewStateRevision: 0 };
    context.performance = { now: () => 0 };
    context.console = { info() {}, warn() {}, error: (...args) => errors.push(args) };
    context.showToast = (...args) => toasts.push(args);
    context.scheduleBrowserAnimationFrame = callback => { count('animationFrames'); callback(); return ++frameId; };
    context.scheduleBrowserTimeout = (callback, delay) => {
      count('timers');
      timers.set(++timerId, { callback, delay });
      return timerId;
    };
    context.clearBrowserTimeout = token => timers.delete(token);
    const items = Array.from({ length: 50 }, (_, index) => ({
      key: `album-${index}`, projection_id: `h1:album-${index}`, name: `Album ${index}`,
      album_artist: 'Artist', inventory_status: 'missing', problem_reasons: ['Album not found'],
      tracks: [], track_count: 0, detail_loaded: false,
    }));
    let summaryRequests = 0;
    const capture = createRequestCapture(url => {
      if (url === '/utilities/problematic-files?limit=50') {
        summaryRequests += 1;
        if (summaryRequests === 1) {
          return jsonResponse({ error: 'Projection pending.', error_code: 'problematic_projection_pending' }, { status: 503 });
        }
        assert.equal(summaryRequests, 2, 'one owned retry replaces the pending request');
        count('responseRows', items.length);
        return jsonResponse({ items: pageArray(items), total: remoteAlbumCount, next_cursor: remoteAlbumCount > 50 ? 'next-50' : null,
          reason_facets: [{ reason: 'Album not found', count: remoteAlbumCount }] });
      }
      assert.equal(url, '/utilities/problematic-files/detail?projection_id=h1%3Aalbum-0');
      count('responseRows');
      return jsonResponse({ ...items[0], detail_loaded: true, tracks: [], repair_preview_rows: [], track_problem_rows: [],
        problematic_track_paths: [], track_paths: [], allowed_actions: {} });
    });
    context.fetch = capture.fetch;
    vm.runInContext(read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), context);
    vm.runInContext(read('music_app/static/js/runtime/utility-renderers-and-actions.js'), context);
    const render = context.renderUtilityModalContent;
    context.renderUtilityModalContent = (...args) => {
      count('renderCommits');
      renderStages.push({
        requestCount: capture.requests.length,
        token: context.state.utility.problematicSummaryRequestToken,
        loaded: context.state.utility.loaded,
        loading: context.state.utility.loading,
      });
      return render(...args);
    };
    const loadDetail = context.loadProblematicAlbumDetail;
    let detailCompletion;
    context.loadProblematicAlbumDetail = (...args) => {
      detailCompletion = loadDetail(...args);
      return detailCompletion;
    };
    measuring = true;
    await Promise.all([context.loadProblematicFiles(true), context.loadProblematicFiles(true)]);
    assert.equal(context.state.utility.loading, true);
    assert.match(els.list.innerHTML, />Loading\.\.\.</);
    assert.match(els.detail.innerHTML, /Loading problematic albums/);
    assert.doesNotMatch(els.list.innerHTML + els.detail.innerHTML, /No matching problematic albums/);
    assert.equal(timers.size, 1);
    const [token, retry] = timers.entries().next().value;
    assert.equal(retry.delay, 1000);
    timers.delete(token);
    retry.callback();
    await context.state.utility.loadPromise;
    assert.ok(detailCompletion, 'the real summary renderer requests its selected detail');
    await detailCompletion;
    assert.deepEqual(renderStages, [
      { requestCount: 0, token: 1, loaded: false, loading: true },
      { requestCount: 1, token: 1, loaded: false, loading: true },
      { requestCount: 2, token: 2, loaded: true, loading: false },
      { requestCount: 3, token: 2, loaded: true, loading: false },
    ]);
    assert.equal(context.state.utility.selectedProblematicKey, 'album-0');
    assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
    assert.equal(context.state.utility.problematicFiles.length, 50);
    assert.equal(context.state.utility.problematicFilesTotal, remoteAlbumCount);
    assert.equal(context.state.utility.problematicFilesNextCursor, remoteAlbumCount > 50 ? 'next-50' : null);
    assert.equal(els.count.textContent, String(remoteAlbumCount));
    assert.match(els.detail.innerHTML, /Album 0/);
    assert.match(els.detail.innerHTML, /Album not found/);
    assert.equal((els.list.innerHTML.match(/data-problematic-album-key=/g) || []).length, 50);
    assert.match(els.list.innerHTML, /data-problematic-album-key="album-0"/);
    assert.equal(timers.size, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(toasts, []);
    assert.equal(unrelatedCounter.snapshot().itemsVisited, 0, 'PF rendering never visits unrelated library or loop collections');
    assert.deepEqual(capture.urls(), [
      '/utilities/problematic-files?limit=50', '/utilities/problematic-files?limit=50',
      '/utilities/problematic-files/detail?projection_id=h1%3Aalbum-0',
    ]);
    assertInteractionRequests(id, capture.urls());
    const counts = counter.snapshot();
    counts.requests = capture.counter.snapshot().requests;
    return counts;
  };
  const samples = await measureScalePair({
    id, small: 50, large: 5000, run,
    // Loading, pending, summary and detail each render once. The three
    // completion waits each cross three animation frames. One 50-row page
    // permits sixteen collection passes, and six tabs plus fixed controls
    // permit at most 256 sink writes across the four commits.
    budgets: { requests: 3, responseRows: 51, renderCommits: 4, timers: 1, animationFrames: 9,
      itemsVisited: 800, domMutations: 256, listeners: 8 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  });
  t.diagnostic(JSON.stringify({ cardinalities: { small: 50, large: 5000 }, samples }));
});
