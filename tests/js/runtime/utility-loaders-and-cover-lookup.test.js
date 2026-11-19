// Request-capture contracts (tests/ci/bounded-interactions.json) for the Utility loaders: the real
// loaders run with a recording fetch; every request must hit its owned endpoint, once per action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequestCapture, jsonResponse, measureInteractionContract } = require('../helpers/request-capture');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');

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
  loadPendingProjectionFetch(context);
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
  await measureInteractionContract(id, {
    setup(problematicAlbums) {
      const items = Array.from({ length: problematicAlbums }, (_, index) => ({ key: `album-${index}`, name: `Album ${index}`, detail_loaded: false }));
      const capture = createRequestCapture(url => jsonResponse(url.endsWith('?limit=50')
        ? { complete: false, items: items.slice(0, 50) }
        : { complete: true, items }));
      return { capture, context: loadUtilityLoaders(capture, utilityState()), problematicAlbums };
    },
    async act({ capture, context, problematicAlbums }) {
      const before = capture.requests.length;
      await Promise.all([context.loadProblematicFiles(true), context.loadProblematicFiles(true)]);
      await context.loadProblematicFiles();
      assert.equal(context.state.utility.problematicFiles.length, problematicAlbums);
      const requests = capture.urls().slice(before);
      assert.deepEqual(requests, ['/utilities/problematic-files?limit=50', '/utilities/problematic-files']);
      return { requests };
    },
  });
});

test('Problematic Files summary and detail repeat a pending answer from a cold server until it loads', async () => {
  const pendingFirst = new Set();
  const capture = createRequestCapture((url) => {
    if (!pendingFirst.has(url)) {
      pendingFirst.add(url);
      return jsonResponse({ ok: false, code: 'gallery_projection_pending' }, { status: 503 });
    }
    if (url.startsWith('/utilities/problematic-files/detail')) return jsonResponse({
      key: 'album-0', detail_loaded: true, tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
    });
    return jsonResponse({ complete: true, items: [{ key: 'album-0', name: 'Album 0', detail_loaded: false }] });
  });
  const timers = [];
  const context = loadUtilityLoaders(capture, utilityState(), {
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {},
  });
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await new Promise(setImmediate); };
  const runTimers = async () => { await settle(); while (timers.length) { timers.shift()(); await settle(); } };

  const summary = context.loadProblematicFiles(true);
  await runTimers();
  await summary;
  assert.equal(context.state.utility.problematicFiles.length, 1);
  context.state.utility.selectedProblematicKey = 'album-0';
  const detail = context.loadProblematicAlbumDetail('album-0', true);
  await runTimers();
  await detail;
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  const detailUrl = '/utilities/problematic-files/detail?album_key=album-0';
  assert.deepEqual(capture.urls(), [
    '/utilities/problematic-files?limit=50', '/utilities/problematic-files?limit=50', detailUrl, detailUrl,
  ], 'each pending answer repeats the same request once');
});

test('request capture: local playlist analysis posts once to the advertised analysis route', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#runLocalPlaylistImportAnalysis';
  const integration = { key: 'local_playlist_import', analyze_route: '/utilities/imports/local-playlists/analyze' };
  await measureInteractionContract(id, {
    setup(clicks) {
      const session = { clicks, capture: createRequestCapture(() => jsonResponse({ ok: true, analysis: { status: { key: 'preview_contract_ready' } } })) };
      const state = utilityState();
      state.utility.localPlaylistImport.selectedFile = { name: 'mix.m3u8' };
      session.context = loadUtilityLoaders(session.capture, state, { getSelectedUtilityIntegration: () => session.integration });
      return session;
    },
    async act(session) {
      const { capture, clicks, context } = session;
      const before = capture.requests.length;
      const clickMany = () => Promise.all(Array.from({ length: clicks }, () => context.runLocalPlaylistImportAnalysis()));
      session.integration = integration;
      await clickMany();
      session.integration = null;
      await clickMany();
      const requests = capture.requests.slice(before).map(({ url, options }) => ({ url, method: options.method }));
      assert.deepEqual(requests, [
        { url: '/utilities/imports/local-playlists/analyze', method: 'POST' }, { url: '/utilities/imports/local-playlists/analyze', method: 'POST' },
      ]);
      return { requests };
    },
  });
});

test('request capture: closing Settings resumes a deferred view on its own endpoint, once', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#resumeDeferredUtilityViewRequest';
  await measureInteractionContract(id, {
    setup(problematicAlbums) {
      // fetchAndRender passes /home-data and /view-data URLs to fetch unchanged; its own contract covers it.
      const capture = createRequestCapture(() => Promise.resolve(true));
      const state = utilityState(Array.from({ length: problematicAlbums }, (_, index) => ({ key: `album-${index}` })));
      return { capture, state, context: loadUtilityLoaders(capture, state, { fetchAndRender: url => capture.fetch(url) }) };
    },
    async act({ capture, state, context }) {
      const before = capture.requests.length;
      state.ui.viewStateRevision = 0;
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
      const requests = capture.urls().slice(before);
      assert.deepEqual(requests, ['/home-data', '/view-data?surface=albums&q=neal&artist=Neal+Morse'], 'Home resumes on /home-data, never /view-data');
      return { requests };
    },
  });
});
