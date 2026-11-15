// Request-capture contracts (tests/ci/bounded-interactions.json) for the Utility loaders: the real
// loaders run with a recording fetch; every request must hit its owned endpoint, once per action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  assertInteractionRequests, createRequestCapture, jsonResponse, measureInteractionContract,
} = require('../helpers/request-capture');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'utility-loaders-and-cover-lookup.js');

function loadUtilityLoaders(capture, state, overrides = {}) {
  const context = vm.createContext({
    Promise, URL, console: { info() {}, error() {}, warn() {} },
    window: { performance: { now: () => 0 }, location: { origin: 'http://localhost' } },
    state,
    fetch: capture.fetch,
    FormData: class FormData { append() {} },
    renderUtilityModalContent() {},
    scheduleBrowserAnimationFrame(callback) { callback(); return 1; },
    showToast() {},
    ...overrides,
  });
  vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  return context;
}

function utilityState(items = []) {
  return {
    ui: { viewStateRevision: 0, pendingViewRequest: null, deferredUtilityViewRequest: null },
    view: {},
    utility: {
      activeTab: 'problematic-files', problematicFiles: items, loaded: false, loading: false, loadPromise: null,
      detailLoadPromises: {}, selectedProblematicKey: '',
      problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      localPlaylistImport: { selectedFile: null, analyzeBusy: false, error: '', lastAnalysis: null },
    },
  };
}

test('request capture: Problematic Files loads one bounded page and one complete summary', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#fetchSummary';
  await measureInteractionContract(id, async (problematicAlbums) => {
    const items = Array.from({ length: problematicAlbums }, (_, index) => ({ key: `album-${index}`, name: `Album ${index}`, detail_loaded: false }));
    const capture = createRequestCapture(url => jsonResponse(url.endsWith('?limit=50')
      ? { complete: false, items: items.slice(0, 50) }
      : { complete: true, items }));
    const context = loadUtilityLoaders(capture, utilityState());
    await Promise.all([context.loadProblematicFiles(true), context.loadProblematicFiles(true)]);
    await context.loadProblematicFiles();
    assert.equal(context.state.utility.problematicFiles.length, problematicAlbums);
    assert.deepEqual(capture.urls(), ['/utilities/problematic-files?limit=50', '/utilities/problematic-files']);
    assertInteractionRequests(id, capture.urls());
    return capture.counter.snapshot();
  });
});

test('request capture: local playlist analysis posts once to the advertised analysis route', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#runLocalPlaylistImportAnalysis';
  await measureInteractionContract(id, async (clicks) => {
    let integration = { key: 'local_playlist_import', analyze_route: '/utilities/imports/local-playlists/analyze' };
    const capture = createRequestCapture(() => jsonResponse({ ok: true, analysis: { status: { key: 'preview_contract_ready' } } }));
    const state = utilityState();
    state.utility.localPlaylistImport.selectedFile = { name: 'mix.m3u8' };
    const context = loadUtilityLoaders(capture, state, { getSelectedUtilityIntegration: () => integration });
    const clickMany = () => Promise.all(Array.from({ length: clicks }, () => context.runLocalPlaylistImportAnalysis()));
    await clickMany();
    integration = null;
    await clickMany();
    assert.deepEqual(capture.urls(), ['/utilities/imports/local-playlists/analyze', '/utilities/imports/local-playlists/analyze']);
    assert.ok(capture.requests.every(({ options }) => options.method === 'POST'));
    assertInteractionRequests(id, capture.urls());
    return capture.counter.snapshot();
  });
});

test('request capture: closing Settings resumes a deferred view on its own endpoint, once', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#resumeDeferredUtilityViewRequest';
  await measureInteractionContract(id, async (problematicAlbums) => {
    // fetchAndRender passes /home-data and /view-data URLs to fetch unchanged; its own contract covers it.
    const capture = createRequestCapture(() => Promise.resolve(true));
    const state = utilityState(Array.from({ length: problematicAlbums }, (_, index) => ({ key: `album-${index}` })));
    const context = loadUtilityLoaders(capture, state, { fetchAndRender: url => capture.fetch(url) });
    const defer = (url, view = {}) => {
      state.view = view;
      state.ui.deferredUtilityViewRequest = { url, push: false, options: { startupRefresh: true }, originatingViewStateRevision: 0 };
    };
    const resumeTwice = async () => {
      assert.equal(context.resumeDeferredUtilityViewRequest(), true);
      await Promise.resolve();
      assert.equal(context.resumeDeferredUtilityViewRequest(), false, 'a resumed request is not resumed again');
    };
    defer('/home-data');
    await resumeTwice();
    defer('/view-data?surface=albums&q=neal', {
      query: 'neal', selected_artist: 'Neal Morse', search_context: { selected_artist_source: 'auto_top_match' },
    });
    await resumeTwice();
    defer('/view-data?surface=albums&artist=Stale');
    state.ui.viewStateRevision = 1;
    assert.equal(context.resumeDeferredUtilityViewRequest(), false, 'a superseded view is dropped');
    assert.deepEqual(capture.urls(), ['/home-data', '/view-data?surface=albums&q=neal&artist=Neal+Morse']);
    assertInteractionRequests(id, capture.urls());
    assert.equal(capture.urls()[0], '/home-data', 'Home resumes on /home-data, never /view-data');
    return capture.counter.snapshot();
  });
});
