const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-renderers-and-actions.js',
);
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const loaderPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-loaders-and-cover-lookup.js',
);
const loaderSource = fs.readFileSync(loaderPath, 'utf8');
const listBuildersPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-list-builders.js',
);
const listBuildersSource = fs.readFileSync(listBuildersPath, 'utf8');

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function loadProblematicLoader(fetch) {
  let now = 0;
  const renders = [];
  const context = {
    Promise,
    fetch,
    window: { performance: { now: () => { now += 5; return now; } } },
    console: { info() {}, error() {} },
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [
          { key: 'album-old', name: 'Old owner', detail_loaded: false },
          { key: 'album-new', name: 'New owner', detail_loaded: false },
        ],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-old',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    renderUtilityModalContent() {
      renders.push(context.state.utility.selectedProblematicKey);
    },
    scheduleBrowserAnimationFrame(callback) {
      callback();
      return 1;
    },
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(loaderSource, context, { filename: loaderPath });
  return { context, renders };
}

test('problematic-file render scrolls the focused track row into view deterministically', () => {
  const trackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem.flac';
  const escapedTrackPath = 'escaped-track-path';
  const cssEscapeCalls = [];
  const selectedAlbum = {
    key: 'album-alpha',
    detail_loaded: true,
  };
  const selectorCalls = [];
  const focusedTrackRow = {
    getBoundingClientRect() {
      return { top: 244, bottom: 276 };
    },
  };
  const focusedTrackMatch = {
    closest(selector) {
      assert.equal(selector, '[role="row"]');
      return focusedTrackRow;
    },
    scrollIntoView() {
      assert.fail('The inner filename element must not own focused-track scrolling.');
    },
  };
  const detail = {
    innerHTML: '',
    scrollTop: 12,
    getBoundingClientRect() {
      return { top: 40, bottom: 200 };
    },
    querySelector(selector) {
      selectorCalls.push(selector);
      return selector === `[data-problematic-track-path="${escapedTrackPath}"]`
        ? focusedTrackMatch
        : null;
    },
  };
  const elements = {
    overlay: {},
    list: { innerHTML: '' },
    detail,
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: trackPath,
        loading: false,
        problemDropdownOpen: false,
        problematicFiles: [selectedAlbum],
        searchQuery: '',
        selectedProblematicKey: 'album-alpha',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() {
      return elements;
    },
    getFilteredProblematicAlbums() {
      return [selectedAlbum];
    },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom() {
      return selectedAlbum;
    },
    buildProblematicAlbumListItem() {
      return '<button>Album Alpha</button>';
    },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail() {
      return `<div data-problematic-track-path="${trackPath}">Late Problem</div>`;
    },
    cssEscape(value) {
      cssEscapeCalls.push(value);
      return escapedTrackPath;
    },
    async loadProblematicAlbumDetail() {},
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();

  assert.deepEqual(cssEscapeCalls, [trackPath]);
  assert.deepEqual(selectorCalls, [`[data-problematic-track-path="${escapedTrackPath}"]`]);
  assert.equal(detail.scrollTop, 88);
});

test('rerender leaves a failed problematic album detail in its terminal state', () => {
  const selectedAlbum = {
    key: 'album-alpha',
    detail_loaded: false,
    detail_load_failed: true,
  };
  const loadCalls = [];
  const elements = {
    overlay: {},
    list: { innerHTML: '' },
    detail: { innerHTML: '' },
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: '',
        loading: false,
        problematicFiles: [selectedAlbum],
        searchQuery: '',
        selectedProblematicKey: 'album-alpha',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() { return elements; },
    getFilteredProblematicAlbums() { return [selectedAlbum]; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom() { return selectedAlbum; },
    buildProblematicAlbumListItem() { return '<button>Album Alpha</button>'; },
    loadProblematicAlbumDetail(albumKey) { loadCalls.push(albumKey); },
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();
  context.renderProblematicFiles();

  assert.deepEqual(loadCalls, []);
  assert.match(elements.detail.innerHTML, /unable to load/i);
});

test('focused-track navigation keeps the matching album selected during a summary refresh', () => {
  const trackPath = 'C:\\Music\\DDT\\Studio Records (Suffix 5)\\05 Track.flac';
  const staleAlbum = { key: 'studio-source', name: 'Studio Records', detail_loaded: true };
  const targetAlbum = {
    key: 'studio-suffix-5',
    name: 'Studio Records (Suffix 5)',
    detail_loaded: true,
    track_paths: [trackPath],
  };
  const elements = {
    overlay: {},
    list: { innerHTML: '', querySelector() { return null; } },
    detail: { innerHTML: '', removeAttribute() {}, querySelector() { return null; } },
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        deferProblematicAutoSelection: false,
        focusedTrackPath: trackPath,
        loading: false,
        problemDropdownOpen: false,
        problematicFiles: [staleAlbum, targetAlbum],
        searchQuery: '',
        selectedProblematicKey: 'obsolete-before-save',
        selectedProblemFilters: [],
        showRepairedDisplay: true,
      },
    },
    getUtilityModalElements() { return elements; },
    getFilteredProblematicAlbums() { return [staleAlbum, targetAlbum]; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom(items) {
      return items.find((item) => item.key === context.state.utility.selectedProblematicKey) || null;
    },
    buildProblematicAlbumListItem(album) { return `<button>${album.name}</button>`; },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail(album) { return `<h2>${album.name}</h2>`; },
    cssEscape(value) { return value; },
    async loadProblematicAlbumDetail() {},
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();

  assert.equal(context.state.utility.selectedProblematicKey, targetAlbum.key);
  assert.match(elements.detail.innerHTML, /Studio Records \(Suffix 5\)/);
});

test('optimistic problematic detail shell defers the ordinary loader to its targeted hydration owner', () => {
  const selectedAlbum = {
    key: 'album-new',
    detail_loaded: false,
    detail_loading_deferred: true,
  };
  const loadCalls = [];
  const elements = {
    overlay: {},
    list: { innerHTML: '' },
    detail: { innerHTML: '' },
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: '',
        loading: false,
        problematicFiles: [selectedAlbum],
        searchQuery: '',
        selectedProblematicKey: 'album-new',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() { return elements; },
    getFilteredProblematicAlbums() { return [selectedAlbum]; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom() { return selectedAlbum; },
    buildProblematicAlbumListItem() { return '<button>New Album</button>'; },
    loadProblematicAlbumDetail(albumKey) { loadCalls.push(albumKey); },
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();

  assert.deepEqual(loadCalls, []);
  assert.match(elements.detail.innerHTML, /Loading selected problematic album/);
});

test('pending tag mutation preserves list and scroll while scrimming only the affected detail', () => {
  const selectedAlbum = {
    key: 'album-alpha',
    detail_loaded: true,
  };
  let listWrites = 0;
  let listMarkup = '<button data-problematic-album-key="album-alpha">Album Alpha</button>';
  const list = {
    scrollTop: 237,
    get innerHTML() { return listMarkup; },
    set innerHTML(value) {
      listWrites += 1;
      listMarkup = value;
    },
  };
  const mountedDetail = '<article data-mounted-problematic-detail="album-alpha">Existing album detail</article>';
  const detail = { innerHTML: mountedDetail, setAttribute() {}, removeAttribute() {} };
  const footer = { innerHTML: '<button>Edit Tags</button>' };
  const elements = {
    overlay: {},
    list,
    detail,
    footer,
    count: { textContent: '1' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: '',
        loading: false,
        problematicFiles: [selectedAlbum],
        problematicMutation: {
          taskId: 'task-17',
          albumKey: 'album-alpha',
          priorKeys: ['album-alpha'],
          priorScrollTop: 237,
        },
        searchQuery: '',
        selectedProblematicKey: 'album-alpha',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() { return elements; },
    getFilteredProblematicAlbums() { return [selectedAlbum]; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom() { return selectedAlbum; },
    buildProblematicAlbumListItem() { return '<button>replacement</button>'; },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail() { return '<div>normal detail</div>'; },
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();

  assert.equal(listWrites, 0);
  assert.equal(list.scrollTop, 237);
  assert.equal(footer.innerHTML, '<button>Edit Tags</button>');
  assert.match(detail.innerHTML, /data-mounted-problematic-detail="album-alpha"/);
  assert.match(detail.innerHTML, /Existing album detail/);
  assert.equal((detail.innerHTML.match(/problematic-mutation-overlay/g) || []).length, 1);
  assert.equal((detail.innerHTML.match(/problematic-mutation-spinner/g) || []).length, 1);
  assert.match(detail.innerHTML, /Hold on\. Your changes are being applied/);
  assert.doesNotMatch(detail.innerHTML, /card|progress|next selection|helper/i);
});

test('removed mutation owner keeps its scrim until the nearest previous survivor detail is hydrated', async () => {
  const detailHydration = createDeferred();
  const previous = { key: 'album-previous', name: 'Previous', detail_loaded: false };
  const next = { key: 'album-next', name: 'Next', detail_loaded: true };
  const list = { innerHTML: '', scrollTop: 237, querySelector() { return null; } };
  const detail = {
    innerHTML: '',
    classList: { remove() {} },
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
  };
  const elements = {
    overlay: { setAttribute() {} },
    list,
    detail,
    footer: { innerHTML: '<button>Edit Tags</button>' },
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    console,
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: '',
        loading: false,
        problematicFiles: [previous, next],
        problematicMutation: {
          taskId: 'task-remove',
          albumKey: 'album-removed',
          priorKeys: ['album-previous', 'album-removed', 'album-next'],
          priorScrollTop: 237,
        },
        searchQuery: '',
        selectedProblematicKey: 'album-removed',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() { return elements; },
    getFilteredProblematicAlbums() { return context.state.utility.problematicFiles; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom(items) {
      return items.find((item) => item.key === context.state.utility.selectedProblematicKey) || null;
    },
    buildProblematicAlbumListItem(album) { return `<button>${album.name}</button>`; },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail(album) { return `<div>Hydrated ${album.name}</div>`; },
    async loadProblematicAlbumDetail(key) {
      assert.equal(key, previous.key);
      await detailHydration.promise;
      previous.detail_loaded = true;
      return previous;
    },
  };
  vm.createContext(context);
  vm.runInContext(listBuildersSource, context, { filename: listBuildersPath });
  Object.assign(context, {
    getFilteredProblematicAlbums() { return context.state.utility.problematicFiles; },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom(items) {
      return items.find((item) => item.key === context.state.utility.selectedProblematicKey) || null;
    },
    buildProblematicAlbumListItem(album) { return `<button>${album.name}</button>`; },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail(album) { return `<div>Hydrated ${album.name}</div>`; },
  });
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();
  assert.match(detail.innerHTML, /Hold on\. Your changes are being applied/);

  const settlement = context.settleProblematicSaveTaskMutation(
    'task-remove',
    { reconcileSelection: true },
  );

  assert.notEqual(context.state.utility.problematicMutation, null);
  assert.match(detail.innerHTML, /Hold on\. Your changes are being applied/);
  assert.doesNotMatch(detail.innerHTML, /Loading selected problematic album/);

  detailHydration.resolve();
  await settlement;

  assert.equal(context.state.utility.problematicMutation, null);
  assert.equal(context.state.utility.selectedProblematicKey, previous.key);
  assert.equal(previous.detail_loaded, true);
  assert.match(detail.innerHTML, /Hydrated Previous/);
  assert.doesNotMatch(detail.innerHTML, /Loading selected problematic album/);
  assert.equal(list.scrollTop, 237);
});

test('late Problematic detail responses are discarded after a newer selection owns the pane', async () => {
  const oldPayload = createDeferred();
  const requestedUrls = [];
  const { context, renders } = loadProblematicLoader(async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('album-old')) {
      return { ok: true, status: 200, json: () => oldPayload.promise };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          key: 'album-new',
          name: 'Fresh new owner',
          detail_loaded: true,
          tracks: [],
          repair_preview_rows: [],
          track_problem_rows: [],
          problematic_track_paths: [],
        };
      },
    };
  });

  const oldLoad = context.loadProblematicAlbumDetail('album-old');
  await Promise.resolve();
  context.state.utility.selectedProblematicKey = 'album-new';
  const newLoad = context.loadProblematicAlbumDetail('album-new');
  await newLoad;
  oldPayload.resolve({
    key: 'album-old',
    name: 'Late old owner',
    detail_loaded: true,
    tracks: [],
    repair_preview_rows: [],
    track_problem_rows: [],
    problematic_track_paths: [],
  });
  assert.equal(await oldLoad, null);

  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files/detail?album_key=album-old',
    '/utilities/problematic-files/detail?album_key=album-new',
  ]);
  assert.equal(context.state.utility.problematicFiles[0].name, 'Old owner');
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, false);
  assert.equal(context.state.utility.problematicFiles[1].name, 'Fresh new owner');
  assert.deepEqual(renders, ['album-new']);
});

function renderFocusedAlbumWithGeometry({
  detailBottom,
  initialDetailScrollTop,
  initialScrollTop,
  listBottom,
  quantizeScrollTop = false,
  rowBottom,
  trackBottom,
}) {
  const trackPath = 'C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem.flac';
  const selectedAlbum = {
    key: 'album-alpha',
    detail_loaded: true,
  };
  const scrollCalls = [];
  const activeAlbumRow = {
    getBoundingClientRect() {
      return { top: rowBottom - 60, bottom: rowBottom, height: 60 };
    },
    scrollIntoView(options) {
      scrollCalls.push({ target: 'album', options });
    },
  };
  let currentScrollTop = initialScrollTop;
  const list = {
    innerHTML: '',
    get scrollTop() {
      return currentScrollTop;
    },
    set scrollTop(value) {
      currentScrollTop = quantizeScrollTop ? Math.floor(value) : value;
    },
    getBoundingClientRect() {
      return { top: listBottom - 200, bottom: listBottom, height: 200 };
    },
    querySelector(selector) {
      return selector === '.utility-list-item.is-active' ? activeAlbumRow : null;
    },
  };
  const focusedTrackRow = {
    getBoundingClientRect() {
      return { top: trackBottom - 32, bottom: trackBottom, height: 32 };
    },
  };
  const focusedTrackMatch = {
    closest(selector) {
      assert.equal(selector, '[role="row"]');
      return focusedTrackRow;
    },
    scrollIntoView() {
      assert.fail('The inner filename element must not own focused-track scrolling.');
    },
  };
  const detail = {
    innerHTML: '',
    scrollTop: initialDetailScrollTop,
    getBoundingClientRect() {
      return { top: detailBottom - 200, bottom: detailBottom, height: 200 };
    },
    querySelector(selector) {
      return selector === '[data-problematic-track-path="escaped-track-path"]'
        ? focusedTrackMatch
        : null;
    },
  };
  const elements = {
    overlay: {},
    list,
    detail,
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'problematic-files',
        focusedTrackPath: trackPath,
        loading: false,
        problemDropdownOpen: false,
        problematicFiles: [selectedAlbum],
        searchQuery: '',
        selectedProblematicKey: 'album-alpha',
        selectedProblemFilters: [],
      },
    },
    getUtilityModalElements() {
      return elements;
    },
    getFilteredProblematicAlbums() {
      return [selectedAlbum];
    },
    renderProblemFilterControls() {},
    getSelectedProblematicAlbumFrom() {
      return selectedAlbum;
    },
    buildProblematicAlbumListItem() {
      return '<button class="utility-list-item is-active">Album Alpha</button>';
    },
    initializeRepairSelections() {},
    buildProblematicAlbumDetail() {
      return `<div data-problematic-track-path="${trackPath}">Late Problem</div>`;
    },
    cssEscape() {
      return 'escaped-track-path';
    },
    async loadProblematicAlbumDetail() {},
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });

  context.renderProblematicFiles();

  return { detail, list, scrollCalls };
}

function assertNearestAlbumScrollCall(scrollCalls) {
  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0]?.target, 'album');
  assert.equal(scrollCalls[0]?.options?.block, 'nearest');
}

test('problematic-file render corrects a focused album row still clipped after nearest scrolling', () => {
  const { detail, list, scrollCalls } = renderFocusedAlbumWithGeometry({
    detailBottom: 240,
    initialDetailScrollTop: 36,
    initialScrollTop: 182,
    listBottom: 300,
    rowBottom: 320,
    trackBottom: 260,
  });

  assertNearestAlbumScrollCall(scrollCalls);
  assert.equal(list.scrollTop, 202);
  assert.equal(detail.scrollTop, 56);
});

test('problematic-file render rounds a fractional focused-album clip up to one scroll pixel', () => {
  const { detail, list, scrollCalls } = renderFocusedAlbumWithGeometry({
    detailBottom: 700,
    initialDetailScrollTop: 37,
    initialScrollTop: 182,
    listBottom: 901.390625,
    quantizeScrollTop: true,
    rowBottom: 901.59375,
    trackBottom: 700.203125,
  });

  assertNearestAlbumScrollCall(scrollCalls);
  assert.equal(list.scrollTop, 183);
  assert.equal(detail.scrollTop, 38);
});

test('empty log history visibly explains session-only storage and keeps export explicit', () => {
  const elements = {
    overlay: {},
    list: { innerHTML: '' },
    detail: { innerHTML: '' },
    count: { textContent: '' },
    search: { disabled: false, placeholder: '', value: '' },
    problemFilterButton: { disabled: false, hidden: false },
    problemFilterMenu: { hidden: false },
    problemFilterChips: { innerHTML: 'old chips' },
    sidebarLabel: { textContent: '' },
    tabs: [],
  };
  const context = {
    state: {
      utility: {
        activeTab: 'log-history',
        logHistory: [],
        logHistoryLoading: false,
        logHistoryStorageStatus: {
          persistent: false,
          storage: 'session',
          message: 'History is available for this session and will be lost on reload.',
        },
        selectedLogHistoryId: '',
      },
    },
    getUtilityModalElements() {
      return elements;
    },
    buildUtilityLogHistoryListItem() {
      return '';
    },
    buildUtilityLogHistoryDetail() {
      return '';
    },
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context, { filename: rendererPath });
  context.renderUtilityLogHistory();
  assert.match(elements.detail.innerHTML, /lost on reload/i);
  assert.match(elements.detail.innerHTML, /scan/i);
  assert.match(elements.detail.innerHTML, /file/i);
  assert.match(elements.detail.innerHTML, /edit/i);
  assert.match(elements.detail.innerHTML, /error/i);
  assert.doesNotMatch(
    elements.detail.innerHTML,
    /Completed tag edits and repairs will appear here/i,
  );
  assert.match(elements.detail.innerHTML, /data-export-log-history="1"/);
  assert.match(elements.detail.innerHTML, />Export Logs</);
});
