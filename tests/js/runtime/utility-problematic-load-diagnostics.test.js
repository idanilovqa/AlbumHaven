const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const helperPath = path.join(
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
const helperSource = fs.readFileSync(helperPath, 'utf8');
const rendererPath = path.join(path.dirname(helperPath), 'utility-renderers-and-actions.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const loopPlaybackPath = path.join(path.dirname(helperPath), 'utility-loop-playback.js');
const loopPlaybackSource = fs.readFileSync(loopPlaybackPath, 'utf8');
const listBuilderPath = path.join(
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
const listBuilderSource = fs.readFileSync(listBuilderPath, 'utf8');
const problematicTrackNavigationSource = listBuilderSource.slice(
  listBuilderSource.indexOf('function getProblematicAlbumForTrackPath('),
  listBuilderSource.indexOf('function getIgnorableProblemRows('),
);

test('closing Settings clears session-only loop Space ownership', () => {
  const closeStart = helperSource.indexOf('function closeUtilityModal(');
  assert.notEqual(closeStart, -1, 'utility runtime must expose closeUtilityModal');
  const closeSource = helperSource.slice(closeStart, closeStart + 1800);
  assert.match(
    closeSource,
    /clearUtilityLoopSpaceOwner\s*\(/,
    'closing Settings must clear the active loop Space owner',
  );
});

test('loading saved loops collapses every returned group before selecting the first group', async () => {
  const events = [];
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loops: [],
        loopsLoaded: false,
        loopsLoadPromise: null,
      },
    },
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            allowed_actions: {},
            loops: [
              { id: 'loop-1', artist: 'Artist', title: 'Song' },
              { id: 'loop-2', artist: 'Artist', title: 'Other Song' },
            ],
          };
        },
      };
    },
    groupUtilityLoops(loops) {
      events.push(['group', loops.map((loop) => loop.id)]);
      return [
        { key: 'artist::song', loops: [loops[0]] },
        { key: 'artist::other-song', loops: [loops[1]] },
      ];
    },
    collapseAllUtilityLoopGroups() {
      events.push(['collapse', context.state.utility.loops.map((loop) => loop.id)]);
      context.state.utility.collapsedLoopGroups = {
        'artist::song': true,
        'artist::other-song': true,
      };
    },
  });

  await context.loadUtilityLoops(true);

  assert.deepEqual(events, [
    ['group', ['loop-1', 'loop-2']],
    ['collapse', ['loop-1', 'loop-2']],
  ]);
  assert.equal(context.state.utility.selectedLoopGroupKey, 'artist::song');
  assert.equal(context.state.utility.selectedLoopId, 'loop-1');
  assert.equal(context.state.utility.selectedLoopDetailMode, 'group');
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.utility.collapsedLoopGroups)), {
    'artist::song': true,
    'artist::other-song': true,
  });
});

test('opening Settings on Loops re-collapses groups before rendering the modal', async () => {
  const events = [];
  const overlay = { hidden: true };
  const { context } = loadHelper({
    state: {
      busy: false,
      ui: {},
      utility: {
        activeTab: 'loops',
        loopsLoaded: true,
        collapsedLoopGroups: { expanded: false },
      },
    },
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return { overlay }; },
    collapseAllUtilityLoopGroups() { events.push('collapse'); },
    renderUtilityModalContent() { events.push('render'); },
    async fetch(url) {
      events.push(`load:${url}`);
      return { async json() { return { loops: [] }; } };
    },
  });

  context.openUtilityModal({ forceLoad: true });
  await context.state.utility.loopsLoadPromise;

  assert.equal(overlay.hidden, false);
  const collapseIndex = events.indexOf('collapse');
  const renderIndex = events.indexOf('render');
  const loadIndex = events.indexOf('load:/utilities/loops');
  assert.ok(collapseIndex >= 0);
  assert.ok(renderIndex > collapseIndex);
  assert.ok(loadIndex > collapseIndex);
});

test('programmatic Log History navigation clears loop Space ownership before return', () => {
  let transitionCalls = 0;
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loopSpaceOwnerId: 'loop-1',
      },
    },
  });
  context.setUtilityActiveTab = (nextTab) => {
    transitionCalls += 1;
    if (context.state.utility.activeTab === 'loops' && nextTab !== 'loops') {
      context.state.utility.loopSpaceOwnerId = '';
    }
    context.state.utility.activeTab = nextTab;
    return nextTab;
  };
  context.openUtilityModal = () => {};

  context.openUtilityLogHistoryTab();
  assert.equal(transitionCalls, 1);
  assert.equal(context.state.utility.activeTab, 'log-history');
  assert.equal(context.state.utility.loopSpaceOwnerId, '');

  context.setUtilityActiveTab('loops');
  assert.equal(context.state.utility.loopSpaceOwnerId, '');
});

function createClock() {
  let current = 0;
  return {
    now() {
      current += 5;
      return current;
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadHelper(overrides = {}) {
  const clock = createClock();
  const calls = {
    renders: 0,
    consoleInfos: [],
    consoleErrors: [],
    toasts: [],
  };
  const context = {
    Promise,
    window: {
      performance: {
        now: () => clock.now(),
      },
    },
    console: {
      info(...args) {
        calls.consoleInfos.push(args);
      },
      error(...args) {
        calls.consoleErrors.push(args);
      },
    },
    getUtilityModalElements() { return { overlay: { hidden: false } }; },
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [],
        loaded: false,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: '',
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    scheduleBrowserAnimationFrame(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    showToast(message, variant, duration) {
      calls.toasts.push([message, variant, duration]);
    },
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('optimistic problematic-file mutations wait through a paint before rollback', async () => {
  const scheduledFrames = [];
  const { context } = loadHelper({
    scheduleBrowserAnimationFrame(callback) {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    },
  });
  let settled = false;

  const completion = context.waitForProblematicUtilityRenderFrame().then(() => {
    settled = true;
  });

  assert.equal(scheduledFrames.length, 1);
  scheduledFrames.shift()();
  await Promise.resolve();
  assert.equal(settled, false, 'the first frame callback runs before that frame is painted');
  assert.equal(scheduledFrames.length, 1);

  scheduledFrames.shift()();
  await Promise.resolve();
  assert.equal(settled, false, 'the second frame callback still runs before its paint');
  assert.equal(scheduledFrames.length, 1);

  scheduledFrames.shift()();
  await completion;
  assert.equal(settled, true);
});

test('closing Utility cancels an in-flight track navigation before it can reopen the modal', async () => {
  const trackPath = 'C:\\Music\\Artist Alpha\\Album Alpha Split\\05 Problem.flac';
  const optimisticAlbum = {
    key: 'album-alpha-split',
    name: 'Album Alpha Split',
    detail_loaded: false,
    track_paths: [trackPath],
    problematic_track_paths: [trackPath],
  };
  const saveTask = createDeferred();
  const overlay = { hidden: true };
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        loaded: true,
        loading: false,
        problematicFiles: [],
        selectedProblematicKey: '',
        problematicNavigationToken: 0,
        pendingProblematicSaveTasks: {
          split: {
            promise: saveTask.promise,
            trackPaths: [trackPath],
            optimisticAlbums: [optimisticAlbum],
          },
        },
      },
    },
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return { overlay }; },
    loadActiveUtilityTab() {},
    setUtilityActiveTab(nextTab) {
      context.state.utility.activeTab = nextTab;
      return nextTab;
    },
    albumsShareTrackPath(album, paths) {
      return (album.track_paths || []).some((pathValue) => paths.has(pathValue));
    },
    async loadProblematicFiles() {
      context.state.utility.problematicFiles = [optimisticAlbum];
      return context.state.utility.problematicFiles;
    },
    async loadProblematicAlbumDetail() {
      optimisticAlbum.detail_loaded = true;
      return optimisticAlbum;
    },
    showToast() {},
  });
  vm.runInContext(problematicTrackNavigationSource, context, { filename: listBuilderPath });

  const navigation = context.openUtilityModalForTrack(trackPath);
  assert.equal(overlay.hidden, false, 'optimistic navigation must open Utility before persistence settles');
  const navigationToken = context.state.utility.problematicNavigationToken;

  context.closeUtilityModal();
  assert.equal(overlay.hidden, true);
  assert.notEqual(
    context.state.utility.problematicNavigationToken,
    navigationToken,
    'closing Utility must invalidate ownership held by pending track navigation',
  );
  assert.equal(
    context.state.utility.problematicNavigationActiveToken,
    0,
    'closing Utility must release active render ownership before pending navigation settles',
  );

  saveTask.resolve();
  await navigation;
  assert.equal(overlay.hidden, true, 'the dismissed Utility modal must stay closed after navigation settles');
});

test('loadProblematicFiles records summary diagnostics after the summary payload renders', async () => {
  const { context, calls } = loadHelper({
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'album-1', name: 'The Lamb Lies Down on Broadway', detail_loaded: false },
              { key: 'album-2', name: 'A Trick of the Tail', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);

  assert.equal(context.state.utility.problematicFiles.length, 2);
  assert.equal(context.state.utility.loaded, true);
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.loadPromise, null);
  assert.ok(calls.renders >= 2);
  assert.equal(calls.consoleErrors.length, 0);

  const summary = context.state.utility.problematicDiagnostics.summaryLoad;
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 200);
  assert.equal(summary.error, null);
  assert.ok(summary.requestMs >= 0);
  assert.ok(summary.parseMs >= 0);
  assert.ok(summary.stateCommitMs >= 0);
  assert.ok(summary.renderMs >= 0);
  assert.ok(summary.totalMs >= summary.requestMs);
});

test('loadProblematicFiles keeps first paint bounded and retains its next cursor', async () => {
  const requestedUrls = [];
  const { context, calls } = loadHelper({
    async fetch(url) {
      requestedUrls.push(String(url));
      assert.equal(String(url), '/utilities/problematic-files?limit=50');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            complete: false,
            total: 2,
            next_cursor: 'page-2',
            items: [{ key: 'first', name: 'First', detail_loaded: false }],
            initial_detail: {
              key: 'first',
              name: 'First detail',
              detail_loaded: true,
              tracks: [],
              repair_preview_rows: [],
              track_problem_rows: [],
              problematic_track_paths: [],
            },
          };
        },
      };
    },
  });

  const result = await context.loadProblematicFiles(true);

  assert.deepEqual(requestedUrls, ['/utilities/problematic-files?limit=50']);
  assert.deepEqual(Array.from(result, (item) => item.key), ['first']);
  assert.equal(context.state.utility.problematicFiles.length, 1);
  assert.equal(context.state.utility.problematicFiles[0].name, 'First detail');
  assert.equal(context.state.utility.problematicFilesTotal, 2);
  assert.equal(context.state.utility.problematicFilesNextCursor, 'page-2');
  assert.equal(context.state.utility.problematicFilesComplete, false);
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.completeLoadPromise, null);
  assert.ok(calls.renders >= 2, 'the bounded response must paint without draining the result');
});

test('loadProblematicFiles sends structured server filters and retains aggregate reason facets', async () => {
  let requestedUrl = '';
  const { context } = loadHelper({
    state: { utility: { searchQuery: '  crimson  ', selectedProblemFilters: ['Missing year'] } },
    async fetch(url) {
      requestedUrl = String(url);
      return { ok: true, status: 200, async json() { return {
        items: [{ key: 'filtered', detail_loaded: false }],
            reason_facets: [
              { reason: 'Missing year', count: 1 },
              { reason: 'Wrong album', count: 1 },
            ],
        next_cursor: null,
        total: 1,
      }; } };
    },
  });

  await context.loadProblematicFiles(true);

  const request = new URL(requestedUrl, 'http://album-haven.test');
  assert.deepEqual(JSON.parse(request.searchParams.get('filter')), {
    query: 'crimson',
    reasons: ['Missing year'],
  });
  assert.deepEqual(Array.from(context.state.utility.problematicReasonFacets), [
    'Missing year', 'Wrong album',
  ]);
});

test('a bounded continuation preserves selected MusicBrainz detail and manual validation', async () => {
  const fullResponse = createDeferred();
  const response = (payload) => ({
    ok: true,
    status: 200,
    async json() { return payload; },
  });
  const artist = {
    key: 'musicbrainz-artist:6',
    entity_kind: 'artist',
    local_artist_id: 6,
    name: 'Functional Balance Artist 03',
    detail_loaded: false,
  };
  const { context } = loadHelper({
    isMusicBrainzArtistProblem: (item) => item?.entity_kind === 'artist',
    async fetch(url) {
      if (String(url).endsWith('?limit=50')) {
        return response({ next_cursor: 'page-2', total: 2, items: [{ ...artist }] });
      }
      return fullResponse.promise;
    },
  });

  await context.loadProblematicFiles(true);
  context.state.utility.selectedProblematicKey = artist.key;
  const selected = context.state.utility.problematicFiles[0];
  selected.musicbrainz_detail = { problem_reason_code: 'musicbrainz_artist_not_found' };
  selected.musicbrainz_ui = {
    manualValue: '0e2e0001-0000-4000-8000-000000000008',
    validated: { canonical_name: artist.name },
  };

  const continuation = context.loadNextProblematicFilesPage();
  fullResponse.resolve(response({ items: [{ ...artist }] }));
  await continuation;

  assert.equal(context.state.utility.problematicFiles[0], selected);
  assert.equal(context.state.utility.problematicFiles[0].musicbrainz_ui.validated.canonical_name, artist.name);
});

test('a render-suppressed bounded refresh paints the refreshed detail that replaced a clicked album request', async () => {
  const fullResponse = createDeferred();
  const clickedDetail = createDeferred();
  const json = (body) => ({ ok: true, status: 200, async json() { return body; } });
  const detailBody = (name) => ({
    key: 'clicked',
    name,
    detail_loaded: true,
    tracks: [],
    repair_preview_rows: [],
    track_problem_rows: [],
    problematic_track_paths: [],
  });
  let detailRequests = 0;
  let summaryRequests = 0;
  const { context, calls } = loadHelper({
    async fetch(url) {
      const target = String(url);
      if (target.endsWith('?limit=50') && summaryRequests++ === 0) {
        return json({ items: [{ key: 'clicked', name: 'Clicked', issue_count: 1, detail_loaded: false }] });
      }
      if (target.includes('/detail?')) {
        detailRequests += 1;
        return detailRequests === 1 ? clickedDetail.promise : json(detailBody('Clicked refreshed detail'));
      }
      return fullResponse.promise;
    },
  });

  await context.loadProblematicFiles(true, { render: false });
  context.state.utility.selectedProblematicKey = 'clicked';
  void context.loadProblematicAlbumDetail('clicked');
  const load = context.loadProblematicFiles(true, { render: false, preserveSelectedDetail: true });
  fullResponse.resolve(json({ items: [{ key: 'clicked', name: 'Clicked', issue_count: 2, detail_loaded: false }] }));
  await load;
  clickedDetail.resolve(json(detailBody('Clicked stale detail')));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(detailRequests, 2);
  assert.equal(context.state.utility.problematicFiles[0].name, 'Clicked refreshed detail');
  assert.ok(calls.renders >= 1, 'the refreshed detail replaced the clicked request, so it must paint');
});

test('loadProblematicFiles reuses one bounded request for a concurrent forced load', async () => {
  const pageResponse = createDeferred();

  const requestedUrls = [];
  const detail = {
    key: 'first',
    name: 'First detail',
    detail_loaded: true,
    tracks: [],
    repair_preview_rows: [],
    track_problem_rows: [],
    problematic_track_paths: [],
  };
  const response = (payload) => ({
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  });
  const { context } = loadHelper({
    async fetch(url) {
      requestedUrls.push(String(url));
      return pageResponse.promise;
    },
  });

  const firstLoad = context.loadProblematicFiles(true);
  const concurrentLoad = context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedUrls, ['/utilities/problematic-files?limit=50']);
  pageResponse.resolve(response({
    complete: false,
    total: 2,
    next_cursor: 'page-2',
    items: [{ key: 'first', name: 'First canonical', detail_loaded: false }],
    initial_detail: detail,
  }));
  await Promise.all([firstLoad, concurrentLoad]);
  assert.deepEqual(requestedUrls, ['/utilities/problematic-files?limit=50']);
});

test('a new filter request starts without waiting for an obsolete bounded response', async () => {
  const oldResponse = createDeferred();
  const newResponse = createDeferred();
  const requestedUrls = [];
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    fetch(url) {
      requestedUrls.push(String(url));
      return requestedUrls.length === 1 ? oldResponse.promise : newResponse.promise;
    },
  });

  const oldLoad = context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));
  context.state.utility.searchQuery = 'current';
  const currentLoad = context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestedUrls.length, 2, 'foreground filtering must not wait for a stale request');
  newResponse.resolve(response({
    items: [{ key: 'current', detail_loaded: false }],
    next_cursor: null,
    total: 1,
  }));
  assert.deepEqual(Array.from(await currentLoad, (item) => item.key), ['current']);
  oldResponse.resolve(response({
    items: [{ key: 'obsolete', detail_loaded: false }],
    next_cursor: null,
    total: 1,
  }));
  await oldLoad;
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['current']);
});

test('bounded refresh retains hydrated off-page selection outside server page order', async () => {
  const selectedDetail = {
    key: 'selected-off-page',
    name: 'Selected detail',
    detail_loaded: true,
    tracks: [],
  };
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [selectedDetail],
        selectedProblematicKey: selectedDetail.key,
        loaded: true,
      },
    },
    async fetch() {
      return { ok: true, status: 200, async json() { return {
        items: [{ key: 'first-page', detail_loaded: false }],
        next_cursor: 'page-2',
        total: 75,
      }; } };
    },
  });

  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });

  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['first-page']);
  assert.equal(context.state.utility.selectedProblematicDetail, selectedDetail);
});

test('loadNextProblematicFilesPage appends once and preserves selected detail', async () => {
  const requestedUrls = [];
  const selectedDetail = {
    key: 'first',
    name: 'First detail',
    detail_loaded: true,
    tracks: [{ path: '/music/first.flac' }],
  };
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [selectedDetail],
        selectedProblematicKey: 'first',
        loaded: true,
        loading: false,
        loadPromise: null,
        completeLoadPromise: null,
        problematicFilesNextCursor: 'page-2',
        problematicFilesTotal: 2,
        problematicReasonFacets: ['Missing year'],
        problematicSummaryRequestToken: 7,
        detailLoadPromises: {},
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch(url) {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'first', name: 'First summary', detail_loaded: false },
              { key: 'second', name: 'Second', detail_loaded: false },
            ],
            reason_facets: [{ reason: 'Wrong album', count: 1 }],
            next_cursor: null,
            total: 2,
          };
        },
      };
    },
  });

  await context.loadNextProblematicFilesPage();

  assert.equal(requestedUrls.length, 1);
  const url = new URL(requestedUrls[0], 'http://album-haven.test');
  assert.equal(url.pathname, '/utilities/problematic-files');
  assert.equal(url.searchParams.get('cursor'), 'page-2');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), [
    'first', 'second',
  ]);
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.deepEqual(Array.from(context.state.utility.problematicReasonFacets), ['Wrong album']);
  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles[0].tracks, (track) => track.path),
    ['/music/first.flac'],
  );
  assert.equal(context.state.utility.problematicFilesNextCursor, null);
  assert.equal(context.state.utility.problematicFilesComplete, true);
});

test('a superseded next page cannot append stale results', async () => {
  const page = createDeferred();
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [{ key: 'current', detail_loaded: false }],
        selectedProblematicKey: 'current',
        loaded: true,
        loading: false,
        loadPromise: null,
        completeLoadPromise: null,
        problematicFilesNextCursor: 'stale-page',
        problematicFilesTotal: 2,
        problematicSummaryRequestToken: 11,
        detailLoadPromises: {},
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() { return page.promise; },
  });

  const load = context.loadNextProblematicFilesPage();
  context.state.utility.problematicSummaryRequestToken += 1;
  page.resolve({
    ok: true,
    status: 200,
    async json() {
      return {
        items: [{ key: 'stale', detail_loaded: false }],
        next_cursor: null,
        total: 2,
      };
    },
  });
  await load;

  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['current']);
});

test('a filter change cannot append an already requested next page', async () => {
  const page = createDeferred();
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        searchQuery: 'old filter',
        problematicFiles: [{ key: 'current', detail_loaded: false }],
        loaded: true,
        loading: false,
        loadPromise: null,
        completeLoadPromise: null,
        problematicFilesNextCursor: 'old-page',
        problematicFilesPageSignature: JSON.stringify({ query: 'old filter', reasons: [] }),
        problematicFilesTotal: 2,
        problematicSummaryRequestToken: 11,
        detailLoadPromises: {},
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() { return page.promise; },
  });

  const load = context.loadNextProblematicFilesPage();
  context.state.utility.searchQuery = 'new filter';
  page.resolve({
    ok: true,
    status: 200,
    async json() {
      return {
        items: [{ key: 'stale', detail_loaded: false }],
        next_cursor: null,
        total: 2,
      };
    },
  });
  await load;

  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['current']);
});

test('a filter change suppresses an obsolete next-page failure toast', async () => {
  const page = createDeferred();
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        searchQuery: 'old filter',
        problematicFiles: [{ key: 'current', detail_loaded: false }],
        loaded: true,
        loading: false,
        loadPromise: null,
        completeLoadPromise: null,
        problematicFilesNextCursor: 'old-page',
        problematicFilesPageSignature: JSON.stringify({ query: 'old filter', reasons: [] }),
        problematicFilesTotal: 2,
        problematicSummaryRequestToken: 11,
        detailLoadPromises: {},
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() { return page.promise; },
  });

  const load = context.loadNextProblematicFilesPage();
  context.state.utility.searchQuery = 'new filter';
  page.reject(new Error('obsolete cursor/filter mismatch'));
  await load;

  assert.deepEqual(calls.toasts, []);
});

test('navigation-owned Problematic Files loading paints the bounded page before completion', async () => {
  const fullResponse = createDeferred();
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicNavigationActiveToken: {},
      },
    },
    async fetch(url) {
      if (String(url).endsWith('?limit=50')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              complete: false,
              items: [{ key: 'first', name: 'First', detail_loaded: false }],
            };
          },
        };
      }
      return fullResponse.promise;
    },
  });

  const load = context.loadProblematicFiles(true, {
    render: false,
    renderInitialPage: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.state.utility.problematicFiles[0]?.key, 'first');
  assert.ok(calls.renders >= 1, 'navigation must paint the bounded page');

  fullResponse.resolve({
    ok: true,
    status: 200,
    async json() { return { items: [{ key: 'first', name: 'First', detail_loaded: false }] }; },
  });
  await load;
});

test('loadProblematicFiles commits a forced canonical summary without initial or final rendering when render is false', async () => {
  const { context, calls } = loadHelper({
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'canonical-album', name: 'Canonical Album', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  const result = await context.loadProblematicFiles(true, { render: false });

  assert.deepEqual(
    Array.from(result, (album) => album.key),
    ['canonical-album'],
    'render suppression must not suppress the canonical state commit',
  );
  assert.equal(context.state.utility.loaded, true);
  assert.equal(calls.renders, 0);
});

test('an existing Problematic Files load defers its final render after track navigation claims ownership', async () => {
  const responseReady = createDeferred();
  const { context, calls } = loadHelper({
    async fetch() {
      await responseReady.promise;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'canonical-album', name: 'Canonical Album', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  const existingLoad = context.loadProblematicFiles(true);
  assert.equal(calls.renders, 1, 'the ordinary load must retain its initial loading render');

  context.state.utility.problematicNavigationActiveToken = 14;
  responseReady.resolve();
  await existingLoad;

  assert.equal(context.state.utility.problematicFiles[0]?.key, 'canonical-album');
  assert.equal(
    calls.renders,
    1,
    'the load finalizer must not repaint stale selection while navigation owns rendering',
  );
});

test('track-navigation ownership suppresses both renders when it predates an ordinary Problematic Files load', async () => {
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [],
        loaded: false,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: '',
        problematicNavigationActiveToken: 21,
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'navigation-target', name: 'Navigation Target', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);

  assert.equal(context.state.utility.problematicFiles[0]?.key, 'navigation-target');
  assert.equal(calls.renders, 0);
});

test('Settings defers an active full startup view request until the modal closes', async () => {
  let abortCalls = 0;
  const resumedRequests = [];
  const overlay = { hidden: true };
  const { context } = loadHelper({
    state: {
      ui: {
        activeViewRequestController: {
          abort() {
            abortCalls += 1;
          },
        },
        activeViewRequestUrl: '/view-data?surface=albums&omit_sidebar=1',
        activeViewRequestPush: false,
        activeViewRequestStartupRefresh: true,
        activeViewRequestStartupHydrationTier: 'full',
        deferredUtilityViewRequest: null,
        utilityViewPreemptionSequence: 0,
        utilityViewPreemptions: [],
        pendingViewRequest: null,
      },
      busy: true,
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: '',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() {
      return { overlay };
    },
    loadActiveUtilityTab() {},
    fetchAndRender(...args) {
      resumedRequests.push(args);
    },
  });

  context.openUtilityModal({ forceLoad: false });
  assert.equal(abortCalls, 1);
  assert.equal(context.state.ui.utilityViewPreemptionSequence, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.utilityViewPreemptions)), [{
    normalizedUrl: '/view-data?surface=albums&omit_sidebar=1',
    reason: 'utility-modal-preemption',
    sequence: 1,
  }]);
  assert.equal(overlay.hidden, false);
  assert.equal(resumedRequests.length, 0);

  context.closeUtilityModal();
  await Promise.resolve();
  assert.equal(resumedRequests.length, 0);
  assert.equal(context.state.ui.deferredUtilityViewRequest, null);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.ui.pendingViewRequest)), {
    url: '/view-data?surface=albums&omit_sidebar=1',
    push: false,
    options: {
      startupRefresh: true,
      startupHydrationTier: 'full',
      preserveScroll: true,
      skipPendingViewTransition: true,
      interruptCurrent: false,
    },
    originatingViewStateRevision: 0,
  });

  const queuedRequest = context.state.ui.pendingViewRequest;
  context.state.ui.pendingViewRequest = null;
  context.state.ui.activeViewRequestUrl = '';
  context.state.busy = false;
  context.fetchAndRender(queuedRequest.url, queuedRequest.push, queuedRequest.options);
  assert.deepEqual(JSON.parse(JSON.stringify(resumedRequests)), [[
    '/view-data?surface=albums&omit_sidebar=1',
    false,
    {
      startupRefresh: true,
      startupHydrationTier: 'full',
      preserveScroll: true,
      skipPendingViewTransition: true,
      interruptCurrent: false,
    },
  ]]);
});

test('utility modal paints its visible shell before rendering and loading', () => {
  const events = [];
  const scheduledFrames = [];
  const overlay = { hidden: true };
  const { context } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    virtualGrid: {
      suspendSelectedArtistCoverLoadsForUserAction() {
        events.push('suspend');
        return 7;
      },
      resumeSelectedArtistCoverLoadsAfterUserAction(token) {
        events.push(`resume:${token}`);
      },
    },
    getUtilityModalElements() { return { overlay }; },
    scheduleBrowserAnimationFrame(callback) {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    },
    clearBrowserTimeout(timerId) { events.push(`clear:${timerId}`); },
    renderUtilityModalContent() { events.push('render'); },
    async fetch() {
      events.push('load');
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    },
  });
  context.state.utility.pendingOpenLoadTimer = 12;

  context.openUtilityModal({ forceLoad: true });
  assert.equal(overlay.hidden, false);
  assert.equal(context.state.utility.pendingOpenLoadTimer, 0);
  assert.deepEqual(events, ['suspend', 'clear:12']);
  assert.equal(scheduledFrames.length, 1);

  scheduledFrames.shift()();
  assert.deepEqual(events, ['suspend', 'clear:12']);
  assert.equal(scheduledFrames.length, 1);

  scheduledFrames.shift()();
  assert.equal(events[0], 'suspend');
  assert.ok(events.indexOf('render') > events.indexOf('clear:12'));
  assert.ok(events.indexOf('load') > events.indexOf('render'));

  context.closeUtilityModal();
  assert.equal(overlay.hidden, true);
  assert.ok(events.indexOf('resume:7') > events.indexOf('load'));
});

test('a stale deferred Settings open cannot render or load after close and reopen', () => {
  const events = [];
  const scheduledFrames = [];
  const overlay = { hidden: true };
  const { context } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return { overlay }; },
    scheduleBrowserAnimationFrame(callback) {
      scheduledFrames.push(callback);
      return scheduledFrames.length;
    },
    renderUtilityModalContent() { events.push('render'); },
    async fetch() {
      events.push('load');
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    },
  });

  context.openUtilityModal({ forceLoad: true });
  context.closeUtilityModal();
  context.openUtilityModal({ forceLoad: false });
  scheduledFrames.shift()();
  scheduledFrames.shift()();
  scheduledFrames.shift()();
  scheduledFrames.shift()();

  assert.deepEqual(events, ['render']);
});

test('utility modal production source is statically tied to scheduler suspension and resume without a test branch', () => {
  const openStart = helperSource.indexOf('function openUtilityModal(');
  const openEnd = helperSource.indexOf('\nfunction openUtilityLogHistoryTab(', openStart);
  const closeStart = helperSource.indexOf('function closeUtilityModal(');
  const closeEnd = helperSource.indexOf('\nfunction openRepairConfirmModal(', closeStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);

  const openSource = helperSource.slice(openStart, openEnd);
  const closeSource = helperSource.slice(closeStart, closeEnd);
  const suspendIndex = openSource.indexOf('virtualGrid.suspendSelectedArtistCoverLoadsForUserAction()');
  const scheduleIndex = openSource.indexOf('scheduleUtilityModalOpenWorkAfterPaint(');
  assert.ok(suspendIndex >= 0);
  assert.ok(suspendIndex < scheduleIndex);
  assert.match(helperSource, /scheduleBrowserAnimationFrame\(\(\) => scheduleBrowserAnimationFrame\(run\)\)/);
  assert.match(closeSource, /virtualGrid\.resumeSelectedArtistCoverLoadsAfterUserAction\(coverLoadSuspensionToken\)/);
  assert.doesNotMatch(`${openSource}\n${closeSource}`, /galleryCoverLoadScheduler\.(?:suspend|resume)/);
  assert.doesNotMatch(`${openSource}\n${closeSource}`, /PLAYWRIGHT|__e2e|E2E_/i);
});

for (const utilityReleasesFirst of [true, false]) {
  test(`utility and navigation cover ownership stays suspended when ${utilityReleasesFirst ? 'utility' : 'navigation'} releases first`, () => {
    const overlay = { hidden: true };
    const activeTokens = new Set();
    let nextToken = 0;
    let schedulerSuspends = 0;
    let schedulerResumes = 0;
    const virtualGrid = {
      suspendSelectedArtistCoverLoadsForUserAction() {
        nextToken += 1;
        if (!activeTokens.size) schedulerSuspends += 1;
        activeTokens.add(nextToken);
        return nextToken;
      },
      resumeSelectedArtistCoverLoadsAfterUserAction(token) {
        if (!activeTokens.delete(Number(token))) return false;
        if (!activeTokens.size) schedulerResumes += 1;
        return true;
      },
    };
    const { context } = loadHelper({
      virtualGrid,
      document: {
        body: { classList: { add() {}, remove() {} } },
        getElementById() { return { hidden: true, classList: { remove() {} } }; },
        querySelectorAll() { return []; },
      },
      getUtilityModalElements() { return { overlay }; },
      loadActiveUtilityTab() {},
    });

    context.openUtilityModal({ forceLoad: false });
    const navigationToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
    assert.equal(schedulerSuspends, 1);
    assert.deepEqual([...activeTokens], [1, 2]);

    if (utilityReleasesFirst) {
      context.closeUtilityModal();
      assert.equal(schedulerResumes, 0);
      virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(navigationToken);
    } else {
      virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(navigationToken);
      assert.equal(schedulerResumes, 0);
      context.closeUtilityModal();
    }

    assert.equal(schedulerResumes, 1);
    assert.equal(activeTokens.size, 0);
  });
}

test('deferred startup resume retains ownership until an idle restart succeeds', async () => {
  const deferredRequest = {
    url: '/view-data?surface=albums&omit_sidebar=1',
    push: false,
    options: { startupRefresh: true, startupHydrationTier: 'full' },
  };
  const restartResults = [false, true];
  const { context } = loadHelper({
    state: {
      busy: false,
      ui: {
        activeViewRequestUrl: '',
        pendingViewRequest: null,
        deferredUtilityViewRequest: deferredRequest,
      },
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: '',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    fetchAndRender() {
      return Promise.resolve(restartResults.shift());
    },
  });

  assert.equal(context.resumeDeferredUtilityViewRequest(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.ui.deferredUtilityViewRequest)),
    deferredRequest,
  );

  assert.equal(context.resumeDeferredUtilityViewRequest(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(context.state.ui.deferredUtilityViewRequest, null);
});

test('summary-provided initial detail avoids a detail request and second render', async () => {
  const requestedUrls = [];
  const { context, calls } = loadHelper({
    async fetch(url) {
      requestedUrls.push(url);
      if (String(url).startsWith('/utilities/problematic-files/detail?')) {
        return {
          ok: true,
          async json() {
            return {
              key: 'album-2',
              name: 'A Trick of the Tail',
              detail_loaded: true,
              tracks: [],
              repair_preview_rows: [],
              track_problem_rows: [{ path: 'track-2.mp3' }],
              problematic_track_paths: ['track-2.mp3'],
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'album-1', name: 'The Lamb Lies Down on Broadway', detail_loaded: false },
              { key: 'album-2', name: 'A Trick of the Tail', detail_loaded: false },
            ],
            initial_detail: {
              key: 'album-1',
              name: 'The Lamb Lies Down on Broadway',
              detail_loaded: true,
              tracks: [],
              repair_preview_rows: [],
              track_problem_rows: [{ path: 'track-1.mp3' }],
              problematic_track_paths: ['track-1.mp3'],
            },
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);
  const rendersAfterSummary = calls.renders;
  const detail = await context.loadProblematicAlbumDetail('album-1');

  assert.equal(detail.detail_loaded, true);
  assert.deepEqual(requestedUrls, ['/utilities/problematic-files?limit=50']);
  assert.equal(calls.renders, rendersAfterSummary);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad, null);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.initialDetailKey, 'album-1');
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.initialDetailMerged, true);

  context.state.utility.selectedProblematicKey = 'album-2';
  const secondDetail = await context.loadProblematicAlbumDetail('album-2');
  assert.equal(secondDetail.detail_loaded, true);
  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files/detail?album_key=album-2',
  ]);
});

test('loadProblematicFiles rejects a JSON HTTP error without committing empty success state', async () => {
  const { context, calls } = loadHelper({
    async fetch() {
      return {
        ok: false,
        status: 503,
        async json() {
          return {
            error: 'Problematic-file projection is temporarily unavailable.',
            items: [],
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);

  assert.equal(context.state.utility.problematicFiles.length, 0);
  assert.equal(context.state.utility.loaded, false);
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.loadPromise, null);
  assert.equal(calls.consoleErrors.length, 1);
  assert.match(String(calls.consoleErrors[0][1]?.message || ''), /temporarily unavailable/);
  assert.deepEqual(calls.toasts, [['Unable to load problematic files.', 'error', 3200]]);

  const summary = context.state.utility.problematicDiagnostics.summaryLoad;
  assert.equal(summary.itemCount, 0);
  assert.equal(summary.ok, false);
  assert.equal(summary.status, 503);
  assert.equal(summary.error, 'Problematic-file projection is temporarily unavailable.');
  assert.equal(summary.stateCommitMs, 0);
});

test('owned projection-pending response retains content and schedules one token-owned retry', async () => {
  const scheduled = [];
  let requestCount = 0;
  const retained = { key: 'album-1', name: 'Foxtrot', detail_loaded: true };
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [retained],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        selectedProblematicDetail: retained,
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    scheduleBrowserTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    async fetch() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '1' : null },
          async json() {
            return {
              error: 'Problematic-file projection is still building.',
              error_code: 'problematic_projection_pending',
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return {
            items: [{ key: 'album-1', name: 'Foxtrot', detail_loaded: false }],
            initial_detail: {
              key: 'album-1',
              name: 'Foxtrot',
              detail_loaded: true,
              tracks: [],
              repair_preview_rows: [],
              track_problem_rows: [],
              problematic_track_paths: [],
            },
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });

  assert.equal(requestCount, 1);
  assert.equal(context.state.utility.problematicFiles[0], retained);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.selectedProblematicDetail, retained);
  assert.deepEqual(calls.toasts, []);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);

  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await context.state.utility.loadPromise;
  assert.equal(requestCount, 2);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(scheduled.length, 1, 'the pending response owns only one automatic retry');
  assert.deepEqual(calls.toasts, []);
});

test('stale projection-pending retry cannot request, mutate, or toast', async () => {
  const scheduled = [];
  let requestCount = 0;
  const retained = { key: 'album-1', name: 'Foxtrot', detail_loaded: true };
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [retained],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    scheduleBrowserTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    async fetch() {
      requestCount += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: () => '1' },
        async json() {
          return {
            error: 'Problematic-file projection is still building.',
            error_code: 'problematic_projection_pending',
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);
  context.state.utility.problematicSummaryRequestToken += 1;
  context.state.utility.problematicFiles = [{ key: 'new-owner', detail_loaded: false }];
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestCount, 1);
  assert.equal(context.state.utility.problematicFiles[0].key, 'new-owner');
  assert.deepEqual(calls.toasts, []);
});

test('projection-pending retry that becomes obsolete in flight cannot commit or toast', async () => {
  const scheduled = [];
  const retryPayload = createDeferred();
  let requestCount = 0;
  const retained = { key: 'album-1', name: 'Foxtrot', detail_loaded: true };
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [retained],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        selectedProblematicDetail: retained,
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    scheduleBrowserTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    async fetch() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => '1' },
          async json() {
            return {
              error: 'Problematic-file projection is still building.',
              error_code: 'problematic_projection_pending',
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json() {
          return retryPayload.promise;
        },
      };
    },
  });

  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });
  scheduled[0].callback();
  await Promise.resolve();
  assert.equal(requestCount, 2, 'the owned retry must start before it becomes obsolete');
  const obsoleteRetry = context.state.utility.loadPromise;

  context.state.utility.problematicSummaryRequestToken += 1;
  context.state.utility.problematicFiles = [{ key: 'new-owner', detail_loaded: false }];
  context.state.utility.selectedProblematicKey = 'new-owner';
  context.state.utility.selectedProblematicDetail = null;
  retryPayload.resolve({
    items: [{ key: 'obsolete-owner', detail_loaded: false }],
  });
  await obsoleteRetry;

  assert.equal(context.state.utility.problematicFiles[0].key, 'new-owner');
  assert.equal(context.state.utility.selectedProblematicKey, 'new-owner');
  assert.equal(context.state.utility.selectedProblematicDetail, null);
  assert.deepEqual(calls.toasts, []);
});

test('projection-pending retry honors an explicit zero-second Retry-After', async () => {
  const scheduled = [];
  const { context } = loadHelper({
    scheduleBrowserTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    async fetch() {
      return {
        ok: false,
        status: 503,
        headers: { get: () => '0' },
        async json() {
          return {
            error: 'Problematic-file projection is still building.',
            error_code: 'problematic_projection_pending',
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 0);
});

function projectionRetryResponse(payload, status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: () => status === 503 ? '1' : null },
    async json() { return payload; },
  };
}

function loadProjectionRetryHelper(responses, utility = {}) {
  const timers = new Map();
  const elements = {
    overlay: { hidden: false },
    list: { innerHTML: '', scrollTop: 0 },
    detail: { innerHTML: '', removeAttribute() {} },
    count: { textContent: '' },
  };
  let timerId = 0;
  let requestCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let maxTimers = 0;
  const { context, calls } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return elements; },
    scheduleBrowserTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      maxTimers = Math.max(maxTimers, timers.size);
      return id;
    },
    clearBrowserTimeout(id) { timers.delete(id); },
    async fetch() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let response;
      try { response = await responses[requestCount++]; }
      catch (error) { inFlight -= 1; throw error; }
      return {
        ...response,
        async json() {
          try { return await response.json(); }
          finally { inFlight -= 1; }
        },
      };
    },
  });
  context.state.ui = {};
  Object.assign(context.state.utility, utility);
  vm.runInContext(loopPlaybackSource, context, { filename: loopPlaybackPath });
  return {
    context, calls, elements, timers,
    get requestCount() { return requestCount; },
    get maxInFlight() { return maxInFlight; },
    get maxTimers() { return maxTimers; },
    takeRetry() {
      assert.equal(timers.size, 1, 'exactly one current retry must be scheduled');
      const [id, retry] = timers.entries().next().value;
      timers.delete(id);
      return retry.callback;
    },
  };
}

function pendingProjectionResponse() {
  return projectionRetryResponse({
    error: 'Problematic Files projection is rebuilding.',
    error_code: 'problematic_projection_pending',
  }, 503);
}

test('initial projection pending keeps actual loading markup until a successful empty response', async () => {
  const h = loadProjectionRetryHelper([
    pendingProjectionResponse(), pendingProjectionResponse(),
    projectionRetryResponse({ items: [], count: 0, total: 0 }),
  ]);
  h.context.getFilteredProblematicAlbums = () => h.context.state.utility.problematicFiles;
  h.context.renderProblemFilterControls = () => {};
  vm.runInContext(rendererSource, h.context, { filename: rendererPath });
  h.context.renderUtilityModalContent = () => {
    h.calls.renders += 1;
    h.context.renderProblematicFiles();
  };

  await h.context.loadProblematicFiles(true);
  for (let pending = 0; pending < 2; pending += 1) {
    assert.match(h.elements.list.innerHTML, />Loading\.\.\.</);
    assert.match(h.elements.detail.innerHTML, /Loading problematic albums/);
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /No matching problematic albums/);
    h.takeRetry()();
    await new Promise((resolve) => setImmediate(resolve));
    await h.context.state.utility.loadPromise;
  }
  assert.equal(h.requestCount, 3);
  assert.equal(h.context.state.utility.loading, false);
  assert.match(h.elements.list.innerHTML, /No matching problematic albums found/);
  assert.match(h.elements.detail.innerHTML, /No matching problematic albums found/);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.toasts, []);
});

test('repeated projection pending keeps one retry and one in-flight request until success', async () => {
  const success = createDeferred();
  const h = loadProjectionRetryHelper([
    pendingProjectionResponse(), pendingProjectionResponse(),
    projectionRetryResponse(success.promise),
  ]);
  await h.context.loadProblematicFiles(true);
  h.takeRetry()();
  await new Promise((resolve) => setImmediate(resolve));
  await h.context.state.utility.loadPromise;
  assert.equal(h.requestCount, 2);
  h.takeRetry()();
  await new Promise((resolve) => setImmediate(resolve));
  const current = h.context.state.utility.loadPromise;
  const duplicate = h.context.loadProblematicFiles(true);
  assert.equal(h.requestCount, 3, 'a matching caller must join the current retry');
  success.resolve({ items: [], count: 0, total: 0 });
  await Promise.all([current, duplicate]);
  assert.equal(h.context.state.utility.loaded, true);
  assert.equal(h.context.state.utility.loading, false);
  assert.equal(h.maxTimers, 1);
  assert.equal(h.maxInFlight, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.toasts, []);
});

test('repeated projection-pending refresh retains content and selection until fresh success', async () => {
  const retained = { key: 'album-1', name: 'Retained Album', detail_loaded: true };
  const h = loadProjectionRetryHelper([
    pendingProjectionResponse(), pendingProjectionResponse(),
    projectionRetryResponse({
      items: [{ key: retained.key, name: 'Fresh Album', detail_loaded: false }],
      initial_detail: {
        key: retained.key, name: 'Fresh Album', detail_loaded: true,
        tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
      },
    }),
  ], { problematicFiles: [retained], loaded: true, selectedProblematicKey: retained.key, selectedProblematicDetail: retained });
  await h.context.loadProblematicFiles(true, { preserveSelectedDetail: true });
  for (let pending = 0; pending < 2; pending += 1) {
    assert.equal(h.context.state.utility.problematicFiles[0], retained);
    assert.equal(h.context.state.utility.selectedProblematicKey, retained.key);
    assert.equal(h.context.state.utility.selectedProblematicDetail, retained);
    h.takeRetry()();
    await new Promise((resolve) => setImmediate(resolve));
    await h.context.state.utility.loadPromise;
  }
  assert.equal(h.context.state.utility.problematicFiles[0].name, 'Fresh Album');
  assert.equal(h.context.state.utility.selectedProblematicKey, retained.key);
  assert.equal(h.context.state.utility.loading, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.toasts, []);
});

test('recognized projection pending retains status diagnostics without console errors', async () => {
  const h = loadProjectionRetryHelper([pendingProjectionResponse(), pendingProjectionResponse()]);
  await h.context.loadProblematicFiles(true);
  h.takeRetry()();
  await new Promise((resolve) => setImmediate(resolve));
  await h.context.state.utility.loadPromise;
  assert.equal(h.requestCount, 2);
  assert.deepEqual(h.calls.consoleErrors, []);
  assert.deepEqual(h.calls.toasts, []);
  const diagnostics = h.context.state.utility.problematicDiagnostics.summaryLoad;
  assert.equal(diagnostics.status, 503);
  assert.equal(diagnostics.ok, false);
  assert.match(diagnostics.error, /projection is rebuilding/);
});

for (const status of [400, 500]) {
  test(`wrong-status projection pending ${status} remains a terminal error`, async () => {
    const h = loadProjectionRetryHelper([projectionRetryResponse({
      error: 'Unexpected projection failure',
      error_code: 'problematic_projection_pending',
    }, status)]);
    await h.context.loadProblematicFiles(true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.context.state.utility.loading, false);
    assert.equal(h.context.state.utility.loaded, false);
    assert.equal(h.calls.consoleErrors.length, 1);
    assert.deepEqual(h.calls.toasts, [['Unable to load problematic files.', 'error', 3200]]);
    assert.equal(h.context.state.utility.problematicDiagnostics.summaryLoad.status, status);
  });
}

test('ordinary pending refresh retains cached paging after a tab switch without retrying', async () => {
  const response = createDeferred();
  const retained = { key: 'retained', name: 'Retained', detail_loaded: true };
  const h = loadProjectionRetryHelper([response.promise], {
    problematicFiles: [retained], loaded: true,
    selectedProblematicKey: retained.key, selectedProblematicDetail: retained,
    problematicFilesNextCursor: 'retained-page', problematicFilesPageSignature: '',
    problematicFilesComplete: false,
  });
  const loading = h.context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));
  h.context.setUtilityActiveTab('rules');
  const renders = h.calls.renders;
  response.resolve(pendingProjectionResponse());
  await loading;
  assert.equal(h.context.state.utility.problematicFiles[0], retained);
  assert.equal(h.context.state.utility.selectedProblematicKey, retained.key);
  assert.equal(h.context.state.utility.problematicFilesNextCursor, 'retained-page');
  assert.equal(h.context.state.utility.problematicFilesPageSignature, '');
  assert.equal(h.context.state.utility.problematicFilesComplete, false);
  assert.equal(h.calls.renders, renders);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls.toasts, []);
});

async function replacePendingRetryOwner(h, transition) {
  if (transition === 'close/reopen') {
    // Keep the new session's deferred open work outside the stale request window.
    const scheduleFrame = h.context.scheduleBrowserAnimationFrame;
    h.context.scheduleBrowserAnimationFrame = () => 1;
    h.context.closeUtilityModal();
    h.context.openUtilityModal({ resetSearch: false, resetSelection: false, forceLoad: false });
    h.context.scheduleBrowserAnimationFrame = scheduleFrame;
  } else if (transition === 'tab') {
    h.context.setUtilityActiveTab('rules');
  } else {
    h.context.state.utility.searchQuery = 'new filter';
    if (transition === 'superseding load') await h.context.loadProblematicFiles(true);
  }
}

function pendingRetryContent(context) {
  const { activeTab, problematicFiles, selectedProblematicKey, selectedProblematicDetail, loaded } = context.state.utility;
  return JSON.parse(JSON.stringify({ activeTab, problematicFiles, selectedProblematicKey, selectedProblematicDetail, loaded }));
}

for (const transition of ['close/reopen', 'tab', 'filter', 'superseding load']) {
  test(`queued projection-pending retry cannot outlive ${transition}`, async () => {
    const h = loadProjectionRetryHelper([
      pendingProjectionResponse(), projectionRetryResponse({ items: [], count: 0, total: 0 }),
    ]);
    await h.context.loadProblematicFiles(true);
    const callback = h.takeRetry();
    await replacePendingRetryOwner(h, transition);
    const content = pendingRetryContent(h.context);
    const requests = h.requestCount;
    const renders = h.calls.renders;
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    await h.context.state.utility.loadPromise;
    assert.equal(h.requestCount, requests);
    assert.deepEqual(pendingRetryContent(h.context), content);
    assert.equal(h.calls.renders, renders);
    assert.deepEqual(h.calls.toasts, []);
    assert.equal(h.timers.size, 0);
  });

  for (const completion of ['success', 'failure', 'pending']) {
    test(`in-flight projection-pending retry cannot commit ${completion} after ${transition}`, async () => {
      const obsolete = createDeferred();
      const retained = { key: 'retained', name: 'Retained', detail_loaded: true };
      const h = loadProjectionRetryHelper([
        pendingProjectionResponse(), obsolete.promise,
        projectionRetryResponse({ items: [], count: 0, total: 0 }),
      ], { problematicFiles: [retained], loaded: true, selectedProblematicKey: retained.key, selectedProblematicDetail: retained });
      await h.context.loadProblematicFiles(true, { preserveSelectedDetail: true });
      h.takeRetry()();
      await new Promise((resolve) => setImmediate(resolve));
      const staleLoad = h.context.state.utility.loadPromise;
      assert.equal(h.requestCount, 2);
      await replacePendingRetryOwner(h, transition);
      const content = pendingRetryContent(h.context);
      const renders = h.calls.renders;
      obsolete.resolve(completion === 'pending' ? pendingProjectionResponse() : projectionRetryResponse(
        completion === 'success'
          ? {
            items: [{ key: 'obsolete', name: 'Obsolete', detail_loaded: false }],
            initial_detail: {
              key: 'obsolete', name: 'Obsolete', detail_loaded: true,
              tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
            },
          }
          : { error: 'Obsolete request failed' },
        completion === 'success' ? 200 : 500,
      ));
      await staleLoad;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(pendingRetryContent(h.context), content);
      assert.equal(h.calls.renders, renders);
      assert.deepEqual(h.calls.toasts, []);
      assert.equal(h.timers.size, 0, 'an obsolete response must not schedule another retry');
    });
  }
}

test('owned expired page cursor performs one bounded first-page restart without duplicates or toast', async () => {
  const requestedUrls = [];
  const retainedSummary = {
    key: 'album-1',
    projection_id: 'h1:old-revision',
    name: 'Foxtrot',
    detail_loaded: true,
    tracks: [{ title: 'Retained detail' }],
  };
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [retainedSummary],
        loaded: true,
        loading: false,
        loadPromise: null,
        completeLoadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        selectedProblematicDetail: retainedSummary,
        problematicFilesNextCursor: 'expired-cursor',
        problematicFilesPageSignature: '',
        problematicSummaryRequestToken: 4,
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    async fetch(url) {
      requestedUrls.push(String(url));
      if (String(url).includes('cursor=')) {
        return {
          ok: false,
          status: 409,
          headers: { get: () => null },
          async json() {
            return {
              error: 'Problematic-file projection cursor expired.',
              error_code: 'problematic_projection_cursor_expired',
            };
          },
        };
      }
      if (String(url).includes('/detail?')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              key: 'album-1',
              name: 'Foxtrot',
              detail_loaded: true,
              tracks: [{ title: 'Fresh detail' }],
              repair_preview_rows: [],
              track_problem_rows: [],
              problematic_track_paths: [],
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return {
            items: [
              {
                key: 'album-1',
                projection_id: 'h1:fresh-revision',
                name: 'Foxtrot',
                detail_loaded: false,
              },
              { key: 'album-2', name: 'Nursery Cryme', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  await context.loadNextProblematicFilesPage();

  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files?limit=50&cursor=expired-cursor',
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files/detail?projection_id=h1%3Afresh-revision',
  ]);
  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles, (item) => item.key),
    ['album-1', 'album-2'],
  );
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.equal(context.state.utility.problematicFiles[0].tracks[0].title, 'Fresh detail');
  assert.deepEqual(calls.toasts, []);
});

test('expired cursor restart retains rendered selection and detail while the first page is unresolved', async () => {
  const restart = createDeferred();
  const retained = {
    key: 'album-1', projection_id: 'h1:old-revision', name: 'Foxtrot',
    detail_loaded: true, tracks: [{ title: 'Retained detail' }],
  };
  const h = loadProjectionRetryHelper([
    projectionRetryResponse({
      error: 'Problematic-file projection cursor expired.',
      error_code: 'problematic_projection_cursor_expired',
    }, 409),
    restart.promise,
    projectionRetryResponse({
      key: retained.key, name: retained.name, detail_loaded: true,
      tracks: [{ title: 'Fresh detail' }],
      repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
    }),
  ], {
    problematicFiles: [
      { key: 'album-2', name: 'Nursery Cryme', detail_loaded: false }, retained,
    ], loaded: true,
    selectedProblematicKey: retained.key, selectedProblematicDetail: retained,
    problematicFilesNextCursor: 'expired-cursor', problematicFilesPageSignature: '',
    problematicFilesComplete: false,
  });
  const requestedUrls = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    requestedUrls.push(String(url));
    return fetch(url, options);
  };
  vm.runInContext(listBuilderSource, h.context, { filename: listBuilderPath });
  vm.runInContext(rendererSource, h.context, { filename: rendererPath });
  Object.assign(h.context, {
    renderProblemFilterControls() {},
    buildProblematicAlbumListItem(album, selected) {
      return `<button data-problematic-album-key="${album.key}" aria-selected="${selected}">${album.name}</button>`;
    },
    buildProblematicAlbumDetail(album) {
      return `<h3>${album.name}</h3><div>${album.tracks.map(track => track.title).join(', ')}</div>`;
    },
    renderUtilityModalContent(options) { h.context.renderProblematicFiles(options); },
  });
  h.context.renderProblematicFiles();
  const priorList = h.elements.list.innerHTML;
  const priorDetail = h.elements.detail.innerHTML;
  assert.match(priorList, /data-problematic-album-key="album-1" aria-selected="true">Foxtrot/);
  assert.match(priorDetail, /Foxtrot.*Retained detail/);

  const loading = h.context.loadNextProblematicFilesPage();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files?limit=50&cursor=expired-cursor',
    '/utilities/problematic-files?limit=50',
  ], 'one expired page must start exactly one first-page restart');
  assert.equal(h.requestCount, 2);
  assert.equal(h.context.state.utility.selectedProblematicKey, retained.key);
  assert.equal(h.context.getSelectedProblematicAlbumFrom(h.context.state.utility.problematicFiles), retained);
  assert.equal(h.context.state.utility.selectedProblematicDetail, retained);
  assert.equal(h.elements.list.innerHTML, priorList);
  assert.equal(h.elements.detail.innerHTML, priorDetail);
  assert.equal((h.elements.list.innerHTML.match(/data-problematic-album-key="album-1"/g) || []).length, 1);
  assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading|No matching problematic albums/);
  assert.deepEqual(h.calls.toasts, []);

  restart.resolve(projectionRetryResponse({ items: [
    { key: retained.key, projection_id: 'h1:fresh-revision', name: retained.name, detail_loaded: false },
    { key: 'album-2', name: 'Nursery Cryme', detail_loaded: false },
  ] }));
  await loading;
  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files?limit=50&cursor=expired-cursor',
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files/detail?projection_id=h1%3Afresh-revision',
  ]);
  assert.deepEqual(Array.from(h.context.state.utility.problematicFiles, item => item.key), ['album-1', 'album-2']);
  assert.equal(h.context.state.utility.selectedProblematicKey, retained.key);
  assert.equal(h.context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.equal(h.context.state.utility.problematicFiles[0].tracks[0].title, 'Fresh detail');
  assert.match(h.elements.list.innerHTML, /data-problematic-album-key="album-1" aria-selected="true">Foxtrot/);
  assert.match(h.elements.detail.innerHTML, /Foxtrot.*Fresh detail/);
  assert.doesNotMatch(h.elements.detail.innerHTML, /Retained detail|Loading|No matching problematic albums/);
  assert.deepEqual(h.calls.toasts, []);
});

test('selected detail uses opaque projection identity while retaining legacy mutation identity', async () => {
  const requestedUrls = [];
  const summary = {
    key: 'legacy-album-key',
    album_ref: 'legacy-album-ref',
    projection_id: 'h1:opaque/detail identity',
    name: 'Foxtrot',
    detail_loaded: false,
  };
  const { context } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [summary],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: summary.key,
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch(url) {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: summary.key,
            name: summary.name,
            detail_loaded: true,
            tracks: [],
            repair_preview_rows: [],
            track_problem_rows: [],
            problematic_track_paths: [],
          };
        },
      };
    },
  });

  const detail = await context.loadProblematicAlbumDetail(summary.key);

  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files/detail?projection_id=h1%3Aopaque%2Fdetail%20identity',
  ]);
  assert.equal(detail.key, summary.key, 'legacy key remains the client selection/mutation identity');
  assert.equal(detail.album_ref, summary.album_ref, 'legacy album_ref remains available to mutation APIs');
  assert.equal(detail.projection_id, summary.projection_id, 'opaque identity remains attached to the summary');
});

test('loadProblematicFiles rejects successful responses that violate the summary contract', async () => {
  const cases = [
    {
      payload: { ok: false, error: 'Projection rejected the request.', items: [] },
      error: /Projection rejected the request/,
    },
    {
      payload: { items: {} },
      error: /items array/,
    },
    {
      payload: { items: [null] },
      error: /items must be JSON objects/,
    },
    ...[
      true,
      1,
      'true',
      undefined,
      null,
    ].map((detailLoaded) => ({
      payload: {
        items: [{
          key: 'album-1',
          ...(detailLoaded === undefined ? {} : { detail_loaded: detailLoaded }),
        }],
      },
      error: /must be marked as not detail loaded/,
    })),
    {
      payload: {
        items: [{ key: 'album-1', detail_loaded: false }],
        initial_detail: { key: 'album-2' },
      },
      error: /key must match a summary item/,
    },
    {
      payload: {
        items: [{ key: 'album-1', detail_loaded: false }],
        initial_detail: {
          key: 'album-1',
          detail_loaded: true,
          tracks: [],
          repair_preview_rows: [],
          track_problem_rows: [],
        },
      },
      error: /problematic_track_paths array/,
    },
  ];

  for (const scenario of cases) {
    const { context, calls } = loadHelper({
      async fetch() {
        return {
          ok: true,
          status: 200,
          async json() {
            return scenario.payload;
          },
        };
      },
    });

    await context.loadProblematicFiles(true);

    assert.equal(context.state.utility.loaded, false);
    assert.equal(context.state.utility.problematicFiles.length, 0);
    assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.ok, false);
    assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.status, 200);
    assert.match(context.state.utility.problematicDiagnostics.summaryLoad.error, scenario.error);
    assert.equal(calls.consoleErrors.length, 1);
    assert.equal(calls.toasts.length, 1);
  }
});

test('loadProblematicFiles keeps malformed successful responses retryable and recovers later', async () => {
  let requestCount = 0;
  const { context, calls } = loadHelper({
    async fetch() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            throw new SyntaxError('Unexpected end of JSON input');
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [
              { key: 'album-1', name: 'Foxtrot', detail_loaded: false },
            ],
          };
        },
      };
    },
  });

  await context.loadProblematicFiles(true);

  assert.equal(context.state.utility.loaded, false);
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.loadPromise, null);
  assert.equal(context.state.utility.problematicFiles.length, 0);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.ok, false);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.status, 200);
  assert.match(context.state.utility.problematicDiagnostics.summaryLoad.error, /Unexpected end of JSON input/);
  assert.ok(context.state.utility.problematicDiagnostics.summaryLoad.parseMs > 0);
  assert.deepEqual(calls.toasts, [['Unable to load problematic files.', 'error', 3200]]);

  await context.loadProblematicFiles();

  assert.equal(requestCount, 2);
  assert.equal(context.state.utility.loaded, true);
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.loadPromise, null);
  assert.equal(context.state.utility.problematicFiles.length, 1);
  assert.equal(context.state.utility.problematicFiles[0].key, 'album-1');
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.ok, true);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.status, 200);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.error, null);
  assert.equal(calls.consoleErrors.length, 1);
  assert.deepEqual(calls.toasts, [['Unable to load problematic files.', 'error', 3200]]);
});

test('loadProblematicAlbumDetail records first-detail diagnostics after the selected album rerenders', async () => {
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [
          { key: 'album-1', name: 'Selling England by the Pound', detail_loaded: false },
        ],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: 'album-1',
            name: 'Selling England by the Pound',
            detail_loaded: true,
            tracks: [],
            repair_preview_rows: [],
            track_problem_rows: [{ path: 'track-1.mp3' }],
            problematic_track_paths: ['track-1.mp3'],
          };
        },
      };
    },
  });

  const detail = await context.loadProblematicAlbumDetail('album-1');

  assert.equal(detail.key, 'album-1');
  assert.equal(detail.detail_loaded, true);
  assert.equal(calls.consoleErrors.length, 0);

  const recorded = context.state.utility.problematicDiagnostics.lastDetailLoad;
  assert.equal(recorded.albumKey, 'album-1');
  assert.equal(recorded.ok, true);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.error, null);
  assert.equal(recorded.detailLoaded, true);
  assert.ok(recorded.requestMs >= 0);
  assert.ok(recorded.parseMs >= 0);
  assert.ok(recorded.stateCommitMs >= 0);
  assert.ok(recorded.renderMs >= 0);
  assert.ok(recorded.totalMs >= recorded.requestMs);
  assert.deepEqual(
    context.state.utility.problematicDiagnostics.detailLoads['album-1'],
    recorded,
  );
});

test('loadProblematicAlbumDetail recovers from malformed success on explicit user retry', async () => {
  let requestCount = 0;
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [
          { key: 'album-1', name: 'Nursery Cryme', detail_loaded: false },
        ],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: {
          summaryLoad: null,
          detailLoads: {},
          lastDetailLoad: null,
        },
      },
    },
    async fetch() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            throw new SyntaxError('Unexpected end of JSON detail');
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: 'album-1',
            name: 'Nursery Cryme',
            detail_loaded: true,
            tracks: [],
            repair_preview_rows: [],
            track_problem_rows: [{ path: 'track-1.mp3' }],
            problematic_track_paths: ['track-1.mp3'],
          };
        },
      };
    },
  });

  const failedDetail = await context.loadProblematicAlbumDetail('album-1');

  assert.equal(failedDetail, null);
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, false);
  assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.detailLoaded, false);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, false);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.status, 200);
  assert.match(context.state.utility.problematicDiagnostics.lastDetailLoad.error, /Unexpected end of JSON detail/);
  assert.ok(context.state.utility.problematicDiagnostics.lastDetailLoad.parseMs > 0);
  assert.equal(calls.consoleErrors.length, 1);
  assert.match(String(calls.consoleErrors[0][1]?.message || ''), /Unexpected end of JSON detail/);
  assert.deepEqual(calls.toasts, [['Unable to load the selected problematic album.', 'error', 3200]]);

  const recoveredDetail = await context.loadProblematicAlbumDetail('album-1', true);

  assert.equal(requestCount, 2);
  assert.equal(recoveredDetail.detail_loaded, true);
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.detailLoaded, true);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, true);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.status, 200);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.error, null);
  assert.equal(calls.consoleErrors.length, 1);
  assert.deepEqual(calls.toasts, [['Unable to load the selected problematic album.', 'error', 3200]]);
});

test('loadProblematicAlbumDetail rejects successful responses that violate the detail contract', async () => {
  const completeDetail = {
    key: 'album-1',
    detail_loaded: true,
    tracks: [],
    repair_preview_rows: [],
    track_problem_rows: [],
    problematic_track_paths: [],
  };
  const cases = [
    {
      payload: { ok: false, error: 'Detail projection rejected the request.' },
      error: /Detail projection rejected the request/,
    },
    {
      payload: null,
      error: /must be a JSON object/,
    },
    {
      payload: [],
      error: /must be a JSON object/,
    },
    {
      payload: { key: 'album-2', detail_loaded: true },
      error: /key does not match the requested album/,
    },
    {
      payload: { ...completeDetail, detail_loaded: false },
      error: /must be marked as detail loaded/,
    },
    ...[
      'tracks',
      'repair_preview_rows',
      'track_problem_rows',
      'problematic_track_paths',
    ].map((field) => ({
      payload: { ...completeDetail, [field]: null },
      error: new RegExp(`${field} array`),
    })),
  ];

  for (const scenario of cases) {
    const { context, calls } = loadHelper({
      state: {
        utility: {
          activeTab: 'problematic-files',
          problematicFiles: [{ key: 'album-1', detail_loaded: false }],
          loaded: true,
          loading: false,
          loadPromise: null,
          detailLoadPromises: {},
          selectedProblematicKey: 'album-1',
          problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
        },
      },
      async fetch() {
        return {
          ok: true,
          status: 200,
          async json() {
            return scenario.payload;
          },
        };
      },
    });

    assert.equal(await context.loadProblematicAlbumDetail('album-1'), null);
    assert.equal(context.state.utility.problematicFiles[0].detail_loaded, false);
    assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);
    assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, false);
    assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.status, 200);
    assert.match(context.state.utility.problematicDiagnostics.lastDetailLoad.error, scenario.error);
    assert.equal(calls.consoleErrors.length, 1);
    assert.equal(calls.toasts.length, 1);
  }
});

test('only literal true suppresses a detail request for preexisting album state', async () => {
  for (const detailLoaded of [1, 'true', undefined, null]) {
    let requestCount = 0;
    const { context, calls } = loadHelper({
      state: {
        utility: {
          activeTab: 'problematic-files',
          problematicFiles: [{
            key: 'album-1',
            ...(detailLoaded === undefined ? {} : { detail_loaded: detailLoaded }),
          }],
          loaded: true,
          loading: false,
          loadPromise: null,
          detailLoadPromises: {},
          selectedProblematicKey: 'album-1',
          problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
        },
      },
      async fetch() {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              key: 'album-1',
              detail_loaded: true,
              tracks: [],
              repair_preview_rows: [],
              track_problem_rows: [],
              problematic_track_paths: [],
            };
          },
        };
      },
    });

    const detail = await context.loadProblematicAlbumDetail('album-1');

    assert.equal(requestCount, 1);
    assert.equal(detail.detail_loaded, true);
    assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, true);
    assert.equal(calls.consoleErrors.length, 0);
    assert.equal(calls.toasts.length, 0);
  }
});

test('forced same-key detail loads coalesce so reverse completion cannot overwrite fresh state', async () => {
  const deferredPayload = createDeferred();
  let requestCount = 0;
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [{ key: 'album-1', name: 'Trespass', detail_loaded: false }],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() {
      requestCount += 1;
      return {
        ok: true,
        status: 200,
        json() {
          return deferredPayload.promise;
        },
      };
    },
  });

  const firstLoad = context.loadProblematicAlbumDetail('album-1');
  await Promise.resolve();
  const forcedLoad = context.loadProblematicAlbumDetail('album-1', true);
  await Promise.resolve();

  assert.equal(requestCount, 1);
  deferredPayload.resolve({
    key: 'album-1',
    name: 'Trespass',
    detail_loaded: true,
    tracks: [],
    repair_preview_rows: [],
    track_problem_rows: [{ path: 'track-1.mp3' }],
    problematic_track_paths: ['track-1.mp3'],
  });
  const [firstDetail, forcedDetail] = await Promise.all([firstLoad, forcedLoad]);

  assert.equal(firstDetail.detail_loaded, true);
  assert.equal(forcedDetail.detail_loaded, true);
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, true);
  assert.equal(calls.consoleErrors.length, 0);
  assert.equal(calls.toasts.length, 0);
});

test('rapid A to B to A detail navigation launches a current A owner and hydrates the reselected album', async () => {
  const responses = [createDeferred(), createDeferred(), createDeferred()];
  const requestedUrls = [];
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [
          { key: 'album-a', name: 'Album A', detail_loaded: false },
          { key: 'album-b', name: 'Album B', detail_loaded: false },
        ],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-a',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch(url) {
      const requestIndex = requestedUrls.length;
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json() {
          return responses[requestIndex].promise;
        },
      };
    },
  });

  const obsoleteA = context.loadProblematicAlbumDetail('album-a');
  await Promise.resolve();
  context.state.utility.selectedProblematicKey = 'album-b';
  const obsoleteB = context.loadProblematicAlbumDetail('album-b');
  await Promise.resolve();
  context.state.utility.selectedProblematicKey = 'album-a';
  const currentA = context.loadProblematicAlbumDetail('album-a');
  await Promise.resolve();

  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files/detail?album_key=album-a',
    '/utilities/problematic-files/detail?album_key=album-b',
    '/utilities/problematic-files/detail?album_key=album-a',
  ]);

  responses[0].resolve({
    key: 'album-a', name: 'Obsolete Album A', detail_loaded: true,
    tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
  });
  responses[1].resolve({
    key: 'album-b', name: 'Obsolete Album B', detail_loaded: true,
    tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
  });
  responses[2].resolve({
    key: 'album-a', name: 'Current Album A', detail_loaded: true,
    tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
  });
  const [firstAResult, bResult, currentAResult] = await Promise.all([obsoleteA, obsoleteB, currentA]);

  assert.equal(firstAResult, null);
  assert.equal(bResult, null);
  assert.equal(currentAResult.name, 'Current Album A');
  assert.equal(context.state.utility.problematicFiles[0].name, 'Current Album A');
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true);
  assert.equal(context.state.utility.detailLoadPromises['album-a'], undefined);
  assert.deepEqual(calls.toasts, []);
});

test('obsolete detail failure cannot poison a fresh same-key summary owner', async () => {
  const oldDetailPayload = createDeferred();
  const requestedUrls = [];
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [{
          key: 'album-1',
          name: 'Old summary owner',
          detail_loaded: false,
        }],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch(url) {
      requestedUrls.push(String(url));
      if (String(url).startsWith('/utilities/problematic-files/detail?')) {
        return {
          ok: true,
          status: 200,
          json() {
            return oldDetailPayload.promise;
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [{
              key: 'album-1',
              name: 'Fresh summary owner',
              detail_loaded: false,
            }],
          };
        },
      };
    },
  });

  const obsoleteDetailLoad = context.loadProblematicAlbumDetail('album-1');
  await Promise.resolve();
  await context.loadProblematicFiles(true);

  assert.equal(context.state.utility.problematicFiles[0].name, 'Fresh summary owner');
  assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);

  oldDetailPayload.reject(new Error('Obsolete detail response failed.'));
  assert.equal(await obsoleteDetailLoad, null);

  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files/detail?album_key=album-1',
    '/utilities/problematic-files?limit=50',
  ]);
  assert.equal(context.state.utility.problematicFiles[0].name, 'Fresh summary owner');
  assert.equal(context.state.utility.problematicFiles[0].detail_loaded, false);
  assert.equal(context.state.utility.problematicFiles[0].detail_load_failed, undefined);
  assert.equal(context.state.utility.detailLoadPromises['album-1'], undefined);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad.ok, false);
  assert.match(
    context.state.utility.problematicDiagnostics.lastDetailLoad.error,
    /Obsolete detail response failed/,
  );
  assert.deepEqual(calls.toasts, []);
});

test('failed detail load becomes terminal until explicit force re-selection retries once', async () => {
  let requestCount = 0;
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [{ key: 'album-1', name: 'Trespass', detail_loaded: false }],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-1',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() {
      requestCount += 1;
      return {
        ok: false,
        status: 503,
        async json() {
          return { error: 'Detail projection unavailable.' };
        },
      };
    },
  });

  await context.loadProblematicAlbumDetail('album-1');
  assert.equal(requestCount, 1);
  assert.equal(context.state.utility.problematicFiles[0].detail_load_failed, true);

  await context.loadProblematicAlbumDetail('album-1');
  assert.equal(requestCount, 1);

  await context.loadProblematicAlbumDetail('album-1', true);
  assert.equal(requestCount, 2);
  assert.equal(calls.toasts.length, 2);
});

test('optimistic detail hydration treats a not-yet-committed Postgres album as retryable', async () => {
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicFiles: [{ key: 'album-new', name: 'New Album', detail_loaded: false }],
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        selectedProblematicKey: 'album-new',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    async fetch() {
      return {
        ok: false,
        status: 404,
        async json() {
          return { error: 'Problematic album not found.' };
        },
      };
    },
  });

  assert.equal(
    await context.loadProblematicAlbumDetail('album-new', true, { allowMissing: true }),
    null,
  );
  assert.equal(context.state.utility.problematicFiles[0].detail_load_failed, undefined);
  assert.deepEqual(calls.toasts, []);
});


function logEntryHarness({ allowed = true, activeTab = 'appearance', entryLoaded = false, mobileAllowed = true } = {}) {
  const events = [];
  const permission = { allowed };
  const { context } = loadHelper({
    window: { AlbumHavenCapabilities: { allowsUtilityTab: tab => tab === 'log-history' && permission.allowed } },
    state: { utility: { activeTab, logHistory: entryLoaded ? [{ id: 'existing' }] : [] } },
    isMobileClient: () => !mobileAllowed,
    mobileUtilityTabAllowed: () => mobileAllowed,
  });
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'utility-loop-playback.js'), 'utf8'), context);
  context.openUtilityModal = options => events.push(['open', options.forceLoad]);
  context.getUtilityLogHistoryController = () => ({
    refreshNavigation: async () => { events.push(['navigation']); },
    selectEvent: async id => { events.push(['event', id]); return id; },
  });
  context.confirmBackgroundAppearanceLeave = () => { events.push(['confirm']); return true; };
  return { context, events, permission };
}

for (const activeTab of ['appearance', 'log-history']) {
  test(`denied failed-tag Log History entry does no navigation or data work from ${activeTab}`, async () => {
    const h = logEntryHarness({ allowed: false, activeTab });
    await h.context.openUtilityLogHistoryTab('owned-failure-event');
    assert.deepEqual(h.events, []);
    assert.equal(h.context.state.utility.activeTab, activeTab);
  });
}

test('allowed Log History entry preserves exact-event selection and one navigation refresh', async () => {
  const h = logEntryHarness();
  assert.equal(await h.context.openUtilityLogHistoryTab('owned-failure-event'), 'owned-failure-event');
  assert.equal(h.context.state.utility.activeTab, 'log-history');
  assert.deepEqual(h.events, [['confirm'], ['open', false], ['navigation'], ['event', 'owned-failure-event']]);
  h.events.length = 0;
  h.context.state.utility.logHistory = [{ id: 'existing' }];
  await h.context.openUtilityLogHistoryTab('another-event');
  assert.deepEqual(h.events, [['open', false], ['event', 'another-event']]);
});

test('allowed general Log History navigation retains its normal forced load without an event request', () => {
  const h = logEntryHarness();
  h.context.openUtilityLogHistoryTab();
  assert.deepEqual(h.events, [['confirm'], ['open', true]]);
});

test('Log History entry stops when the client tab owner rejects the transition', async () => {
  const h = logEntryHarness({ mobileAllowed: false });
  await h.context.openUtilityLogHistoryTab('owned-failure-event');
  assert.equal(h.context.state.utility.activeTab, 'appearance');
  assert.deepEqual(h.events, [['confirm']]);
});

for (const change of ['permission revoked', 'utility owner replaced']) {
  test(`deferred Log History navigation does not resume after ${change}`, async () => {
    const h = logEntryHarness();
    let deferred;
    h.context.confirmBackgroundAppearanceLeave = callback => { deferred = callback; return false; };
    h.context.openUtilityLogHistoryTab('owned-failure-event');
    assert.equal(typeof deferred, 'function');
    if (change === 'permission revoked') h.permission.allowed = false;
    else h.context.state.utility = { activeTab: 'appearance', logHistory: [] };
    await deferred();
    assert.deepEqual(h.events, []);
    assert.equal(h.context.state.utility.activeTab, 'appearance');
  });
}


test('Log History entry stops when its tab owner rejects a newly revoked transition', async () => {
  const h = logEntryHarness();
  const setTab = h.context.setUtilityActiveTab;
  h.context.setUtilityActiveTab = (...args) => {
    h.permission.allowed = false;
    return setTab(...args);
  };
  await h.context.openUtilityLogHistoryTab('owned-failure-event');
  assert.equal(h.context.state.utility.activeTab, 'appearance');
  assert.deepEqual(h.events, [['confirm']]);
});


for (const outcome of ['response', 'error']) {
  test(`invalidated problematic summary ${outcome} releases its owner and gives waiting callers one fresh read`, async () => {
    const oldResponse = createDeferred();
    const currentResponse = createDeferred();
    let requests = 0;
    const { context, calls } = loadHelper({
      fetch() {
        requests += 1;
        return requests === 1 ? oldResponse.promise : currentResponse.promise;
      },
    });
    const original = context.loadProblematicFiles(true);
    context.state.utility.problematicSummaryRequestToken += 1;
    context.state.utility.loaded = false;
    const navigation = context.loadProblematicFiles(true, { render: false });
    const concurrent = context.loadProblematicFiles(true, { render: false });
    if (outcome === 'error') oldResponse.reject(new Error('obsolete failed read'));
    else oldResponse.resolve({ ok: true, status: 200, json: async () => ({ items: [{ key: 'obsolete', name: 'Old', detail_loaded: false }] }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await original, null);
    assert.equal(requests, 2, 'waiting navigation must fetch current data exactly once');
    assert.equal(context.state.utility.loading, true, 'fresh request retains loading ownership');
    assert.equal(context.state.utility.problematicFiles.length, 0, 'obsolete response never commits');
    currentResponse.resolve({ ok: true, status: 200, json: async () => ({ items: [{ key: 'restored', name: 'Restored album', detail_loaded: false }] }) });
    const results = await Promise.all([navigation, concurrent]);
    assert.deepEqual(calls.consoleErrors, [], 'valid fresh summary must not fail payload validation');
    assert.deepEqual(calls.toasts, []);
    for (const result of results) {
      assert.deepEqual(Array.from(result, item => item.key), ['restored']);
    }
    assert.equal(context.state.utility.loaded, true);
    assert.equal(context.state.utility.loading, false);
    assert.equal(context.state.utility.loadPromise, null);
    assert.equal(requests, 2);
  });
}

test('invalidated problematic summary finalizer never clears a newer promise owner', async () => {
  const response = createDeferred();
  const { context } = loadHelper({ fetch: () => response.promise });
  const original = context.loadProblematicFiles(true);
  const replacement = Promise.resolve(['replacement']);
  context.state.utility.problematicSummaryRequestToken += 1;
  context.state.utility.loadPromise = replacement;
  context.state.utility.loading = true;
  response.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) });
  assert.equal(await original, null);
  assert.equal(context.state.utility.loadPromise, replacement);
  assert.equal(context.state.utility.loading, true);
});

for (const completion of ['fresh', 'selection-changed', 'failed']) {
  test(`status summary refresh keeps selected problem controls until detail is ${completion}`, async () => {
    const pendingDetail = createDeferred();
    let detailRequests = 0;
    const detail = { key: 'album-1', name: 'Fresh detail', detail_loaded: true,
      tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [] };
    const { context } = loadHelper({
      async fetch(url) {
        if (String(url).includes('/detail?')) {
          detailRequests += 1;
          return pendingDetail.promise;
        }
        return { ok: true, status: 200, async json() { return { items: [
          { key: 'album-1', name: 'New summary', detail_loaded: false },
          { key: 'album-2', name: 'Other album', detail_loaded: false },
        ] }; } };
      },
    });
    Object.assign(context.state.utility, {
      loaded: true, selectedProblematicKey: 'album-1',
      problematicFiles: [{ ...detail, name: 'Existing detail' }],
      problemExclusionSelections: { 'missing-year': true }, proposalSelections: {},
    });
    const refresh = context.loadProblematicFiles(true, { preserveSelectedDetail: true });
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    assert.equal(context.state.utility.problematicFiles[0].detail_loaded, true,
      'background summary must not replace visible controls with a loading placeholder');
    assert.equal(detailRequests, 1, 'retained detail must still be refreshed');
    context.state.utility.proposalSelections['repair-artist'] = true;
    if (completion === 'selection-changed') context.state.utility.selectedProblematicKey = 'album-2';
    pendingDetail.resolve({ ok: completion !== 'failed', status: completion === 'failed' ? 500 : 200,
      async json() { return completion === 'failed' ? { error: 'Unavailable' } : detail; } });
    await refresh;
    assert.equal(context.state.utility.problemExclusionSelections['missing-year'], true);
    assert.equal(context.state.utility.proposalSelections['repair-artist'], true);
    const refreshed = context.state.utility.problematicFiles[0];
    if (completion === 'fresh') {
      assert.equal(refreshed.name, 'Fresh detail');
      assert.equal(refreshed.detail_loaded, true);
    } else {
      assert.equal(refreshed.detail_loaded, false, 'obsolete or failed detail must not remain usable');
      assert.equal(context.state.utility.selectedProblematicKey, completion === 'selection-changed' ? 'album-2' : 'album-1');
    }
  });
}

test('status summary refresh removes deleted selected albums without fetching obsolete detail', async () => {
  const requested = [];
  const { context } = loadHelper({ async fetch(url) {
    requested.push(url);
    return { ok: true, status: 200, async json() { return { items: [] }; } };
  } });
  Object.assign(context.state.utility, { loaded: true, selectedProblematicKey: 'removed',
    problematicFiles: [{ key: 'removed', detail_loaded: true }] });
  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });
  assert.equal(context.state.utility.problematicFiles.length, 0);
  assert.deepEqual(requested, ['/utilities/problematic-files?limit=50']);
});

for (const freshFirst of [true, false]) {
  test(`obsolete status refresh cannot discard fresh detail after A to B to A (fresh first: ${freshFirst})`, async () => {
    const oldA = createDeferred(), pendingB = createDeferred(), freshA = createDeferred();
    let requestsA = 0;
    const detail = (key, name) => ({ key, name, detail_loaded: true,
      tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [] });
    const response = body => ({ ok: true, status: 200, async json() { return body; } });
    const { context } = loadHelper({ async fetch(url) {
      if (String(url).includes('album_key=album-a')) return ++requestsA === 1 ? oldA.promise : freshA.promise;
      if (String(url).includes('album_key=album-b')) return pendingB.promise;
      return response({ items: [
        { key: 'album-a', detail_loaded: false }, { key: 'album-b', detail_loaded: false },
      ] });
    } });
    Object.assign(context.state.utility, { loaded: true, selectedProblematicKey: 'album-a',
      problematicFiles: [detail('album-a', 'Existing A')] });
    const refresh = context.loadProblematicFiles(true, { preserveSelectedDetail: true });
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    assert.equal(requestsA, 1);
    context.state.utility.selectedProblematicKey = 'album-b';
    const loadB = context.loadProblematicAlbumDetail('album-b', true);
    await Promise.resolve();
    context.state.utility.selectedProblematicKey = 'album-a';
    const loadA = context.loadProblematicAlbumDetail('album-a', true);
    await Promise.resolve();
    if (freshFirst) {
      freshA.resolve(response(detail('album-a', 'Fresh A')));
      await loadA;
    }
    oldA.resolve(response(detail('album-a', 'Obsolete A')));
    await refresh;
    if (!freshFirst) {
      const pending = context.state.utility.problematicFiles.find(item => item.key === 'album-a');
      assert.equal(pending.detail_load_failed, false, 'obsolete failure must not replace the new pending request');
      freshA.resolve(response(detail('album-a', 'Fresh A')));
      await loadA;
    }
    pendingB.resolve(response(detail('album-b', 'Obsolete B')));
    await loadB;
    const current = context.state.utility.problematicFiles.find(item => item.key === 'album-a');
    assert.equal(current.name, 'Fresh A');
    assert.equal(current.detail_loaded, true);
  });
}

test('a pending Problematic Files response cannot rerender a different active tab', async () => {
  const responseReady = createDeferred();
  const { context, calls } = loadHelper({
    async fetch() {
      await responseReady.promise;
      return { ok: true, status: 200, async json() {
        return { items: [{ key: 'late-album', name: 'Late Album', detail_loaded: false }] };
      } };
    },
  });
  const pending = context.loadProblematicFiles(true);
  assert.equal(calls.renders, 1);
  context.state.utility.activeTab = 'loops';
  responseReady.resolve();
  await pending;
  assert.equal(context.state.utility.problematicFiles[0].key, 'late-album');
  assert.equal(context.state.utility.loaded, true);
  assert.equal(calls.renders, 1, 'late completion must not replace the active loop player DOM');
  await context.loadProblematicFiles();
  assert.equal(calls.renders, 1, 'cached background reads must not replace the active loop player DOM');
});

function createTargetNavigationHarness({ previewKeys = ['alpha', 'beta'] } = {}) {
  const preview = createDeferred();
  const requests = [];
  const opens = [];
  const trackPath = (key) => `/synthetic/${key}/track.flac`;
  const summary = (key) => ({ key, name: key, detail_loaded: false,
    track_paths: [trackPath(key)], problematic_track_paths: [trackPath(key)] });
  const detail = (key) => ({ ...summary(key), detail_loaded: true,
    tracks: [{ path: trackPath(key), title: `${key} track` }],
    repair_preview_rows: [], track_problem_rows: [] });
  const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  const { context, calls } = loadHelper({
    fetch(url) {
      requests.push(String(url));
      if (String(url).endsWith('?limit=50')) return preview.promise;
      if (String(url).includes('/detail?track_path=')) {
        const path = new URL(String(url), 'http://synthetic.test').searchParams.get('track_path');
        const key = String(path || '').split('/').filter(Boolean).at(-2) || '';
        return Promise.resolve(response(detail(key)));
      }
      if (String(url).includes('/detail?')) {
        const key = new URL(String(url), 'http://synthetic.test').searchParams.get('album_key');
        return Promise.resolve(response(detail(key)));
      }
      throw new Error(`Unexpected unbounded Problematic Files request: ${url}`);
    },
    albumsShareTrackPath(album, paths) {
      return (album.track_paths || []).some((value) => paths.has(value));
    },
  });
  vm.runInContext(problematicTrackNavigationSource, context, { filename: listBuilderPath });
  context.setUtilityActiveTab = (tab) => { context.state.utility.activeTab = tab; };
  context.openUtilityModal = () => {
    const selected = context.state.utility.problematicFiles.find(
      (item) => item.key === context.state.utility.selectedProblematicKey,
    ) || (context.state.utility.selectedProblematicDetail?.key
      === context.state.utility.selectedProblematicKey
      ? context.state.utility.selectedProblematicDetail : null);
    opens.push({ key: selected?.key, loaded: selected?.detail_loaded,
      track: context.state.utility.focusedTrackPath });
  };
  const finishPreview = () => preview.resolve(response({ complete: false, items: previewKeys.map(summary) }));
  return { context, calls, requests, opens, preview, trackPath, summary, detail,
    response, finishPreview };
}

const settleTargetNavigation = () => new Promise((resolve) => setImmediate(resolve));

test('track navigation opens a hydrated bounded-page target with one detail request', async () => {
  const h = createTargetNavigationHarness();
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
  assert.equal(h.context.state.utility.problematicFilesComplete, true);
  assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1,
    'bounded-page membership must not duplicate target hydration');
});

test('outside-page track uses canonical targeted identity without draining later pages', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('omega'));
  h.finishPreview();
  await navigation;
  assert.equal(h.requests.some((url) => url === '/utilities/problematic-files'), false);
  assert.equal(h.requests.filter((url) => url.includes('/detail?track_path=')).length, 1);
  assert.deepEqual(Array.from(h.context.state.utility.problematicFiles, (item) => item.key), ['alpha']);
  assert.equal(h.context.state.utility.selectedProblematicDetail?.key, 'omega');
  assert.deepEqual(h.opens, [{ key: 'omega', loaded: true, track: h.trackPath('omega') }]);
});

test('outside-page track navigation uses targeted identity instead of draining every page', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const baseFetch = h.context.fetch;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?track_path=')) {
      h.requests.push(String(url));
      return Promise.resolve(h.response(h.detail('omega')));
    }
    return baseFetch(url);
  };

  const navigation = h.context.openUtilityModalForTrack(h.trackPath('omega'));
  h.finishPreview();
  await navigation;

  assert.equal(
    h.requests.some((url) => url === '/utilities/problematic-files'),
    false,
    'track navigation must not drain the complete summary',
  );
  const targeted = h.requests.find((url) => url.includes('/detail?track_path='));
  assert.ok(targeted, 'an unloaded track requires one targeted identity lookup');
  assert.equal(
    new URL(targeted, 'http://album-haven.test').searchParams.get('track_path'),
    h.trackPath('omega'),
  );
  assert.deepEqual(h.opens, [{ key: 'omega', loaded: true, track: h.trackPath('omega') }]);
});

test('concurrent track navigation reuses the bounded summary and opens only the latest target', async () => {
  const h = createTargetNavigationHarness();
  const older = h.context.openUtilityModalForTrack(h.trackPath('alpha'));
  const newer = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await Promise.all([older, newer]);
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
  assert.deepEqual(h.requests.filter((url) => !url.includes('/detail?')), [
    '/utilities/problematic-files?limit=50',
  ]);
});

test('bounded summary navigation completes without a full-list drain', async () => {
  const h = createTargetNavigationHarness();
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.equal(h.context.state.utility.loaded, true);
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
  assert.equal(h.requests.includes('/utilities/problematic-files'), false);
});

for (const cancellation of ['close', 'navigate-away']) {
  test(`${cancellation} before preview arrives prevents delayed track navigation from opening`, async () => {
    const h = createTargetNavigationHarness();
    const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
    h.context.state.utility.problematicNavigationToken += 1;
    h.context.state.utility.problematicNavigationActiveToken = 0;
    if (cancellation === 'navigate-away') h.context.state.utility.activeTab = 'loops';
    h.finishPreview();
    await settleTargetNavigation();
    await navigation;
    assert.deepEqual(h.opens, []);
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
  });
}

test('failed targeted identity leaves the bounded summary usable without opening stale content', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const baseFetch = h.context.fetch;
  h.context.fetch = (url) => String(url).includes('/detail?track_path=')
    ? Promise.resolve(h.response({ error: 'Synthetic targeted failure' }, 503))
    : baseFetch(url);
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.deepEqual(h.opens, []);
  assert.equal(h.context.state.utility.loaded, true);
  assert.equal(h.context.state.utility.problematicFilesComplete, true);
  assert.equal(h.context.state.utility.loading, false);
  assert.equal(h.context.state.utility.problematicFiles[0].key, 'alpha');
});

for (const terminal of ['error', 'superseded']) {
  test(`initial summary ${terminal} settles track navigation without opening stale content`, async () => {
    const h = createTargetNavigationHarness();
    let settled = false;
    const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta')).finally(() => { settled = true; });
    if (terminal === 'superseded') h.context.state.utility.problematicSummaryRequestToken += 1;
    h.preview.resolve(terminal === 'error'
      ? h.response({ error: 'Synthetic preview failure' }, 503)
      : h.response({ complete: false, items: [h.summary('beta')] }));
    await settleTargetNavigation();
    assert.equal(settled, true, 'failed or obsolete initial readiness must never hang');
    await navigation;
    assert.deepEqual(h.opens, []);
    assert.equal(h.context.state.utility.loading, false);
  });
}

test('pending tag save settles before preview navigation uses refreshed canonical identity', async () => {
  const h = createTargetNavigationHarness();
  const save = createDeferred();
  h.context.state.utility.pendingProblematicSaveTasks = {
    edit: { promise: save.promise, trackPaths: [h.trackPath('beta')] },
  };
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  await settleTargetNavigation();
  assert.deepEqual(h.requests, [], 'do not read canonical summary before the owning save settles');
  save.resolve();
  await settleTargetNavigation();
  h.finishPreview();
  try {
    await settleTargetNavigation();
    assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
  } finally {
    await navigation;
    await h.context.state.utility.completeLoadPromise;
  }
});

test('bounded summary retains an in-flight target detail when summary content is unchanged', async () => {
  const h = createTargetNavigationHarness();
  const detailResponse = createDeferred();
  const fetch = h.context.fetch;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      return detailResponse.promise;
    }
    return fetch(url);
  };
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  try {
    await settleTargetNavigation();
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1,
      'target detail must start while complete summary is outstanding');
    await settleTargetNavigation();
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1);
  } finally {
    detailResponse.resolve(h.response(h.detail('beta')));
    await navigation;
    await h.context.state.utility.completeLoadPromise;
  }
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation survives an in-flight summary refresh that retains its target', async () => {
  const h = createTargetNavigationHarness({
    previewKeys: ['alpha'],
  });
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      detailRequests += 1;
      if (detailRequests === 1) return firstDetail.promise;
    }
    return fetch(url);
  };
  h.context.state.utility.problematicFiles = [h.summary('beta')];
  h.context.state.utility.loaded = true;
  h.context.state.utility.problematicFilesComplete = true;

  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  await settleTargetNavigation();
  assert.equal(detailRequests, 1, 'navigation starts from the previously loaded target');

  const refresh = h.context.loadProblematicFiles(true, { render: false });
  firstDetail.resolve(h.response(h.detail('beta')));
  await settleTargetNavigation();
  h.finishPreview();
  await settleTargetNavigation();
  await refresh;
  await navigation;
  await h.context.state.utility.completeLoadPromise;

  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation retries detail superseded by a completed summary refresh', async () => {
  const h = createTargetNavigationHarness();
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      detailRequests += 1;
      if (detailRequests === 1) return firstDetail.promise;
    }
    return fetch(url);
  };
  h.context.state.utility.problematicFiles = [h.summary('beta')];
  h.context.state.utility.loaded = true;
  h.context.state.utility.problematicFilesComplete = true;

  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  await settleTargetNavigation();
  assert.equal(detailRequests, 1, 'navigation starts from the previously loaded target');

  const refresh = h.context.loadProblematicFiles(true, { render: false });
  h.finishPreview();
  await refresh;
  assert.equal(h.context.state.utility.completeLoadPromise, null,
    'the summary refresh completes before the superseded detail response');

  firstDetail.resolve(h.response(h.detail('beta')));
  await navigation;

  assert.equal(detailRequests, 2,
    'navigation must hydrate the retained target after summary ownership changes');
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation uses targeted identity when a bounded refresh supersedes detail outside its page', async () => {
  const h = createTargetNavigationHarness({
    previewKeys: ['alpha'],
  });
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      detailRequests += 1;
      if (detailRequests === 1) return firstDetail.promise;
    }
    return fetch(url);
  };
  h.context.state.utility.problematicFiles = [h.summary('beta')];
  h.context.state.utility.loaded = true;
  h.context.state.utility.problematicFilesComplete = true;

  const refresh = h.context.loadProblematicFiles(true, { render: false });
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  await settleTargetNavigation();
  assert.equal(detailRequests, 1, 'navigation hydrates the target from the prior summary');

  h.finishPreview();
  await settleTargetNavigation();
  firstDetail.resolve(h.response(h.detail('beta')));
  await settleTargetNavigation();

  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }],
    'targeted identity may open without draining later pages');

  await refresh;
  await navigation;

  assert.equal(detailRequests, 2,
    'navigation rehydrates the canonical target after the complete summary arrives');
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation follows a refreshed canonical key for the same track', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  const trackPath = h.trackPath('beta');
  const refreshedSummary = {
    ...h.summary('beta-v2'),
    track_paths: [trackPath],
    problematic_track_paths: [trackPath],
  };
  const refreshedDetail = {
    ...h.detail('beta-v2'),
    ...refreshedSummary,
    detail_loaded: true,
    tracks: [{ path: trackPath, title: 'beta track' }],
  };
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      detailRequests += 1;
      if (detailRequests === 1) return firstDetail.promise;
      return Promise.resolve(h.response(refreshedDetail));
    }
    return fetch(url);
  };
  h.context.state.utility.problematicFiles = [h.summary('beta')];
  h.context.state.utility.loaded = true;
  h.context.state.utility.problematicFilesComplete = true;

  const navigation = h.context.openUtilityModalForTrack(trackPath);
  await settleTargetNavigation();
  const refresh = h.context.loadProblematicFiles(true, { render: false });
  firstDetail.resolve(h.response(h.detail('beta')));
  await settleTargetNavigation();
  h.finishPreview();
  await settleTargetNavigation();
  await refresh;
  await navigation;
  await h.context.state.utility.completeLoadPromise;

  assert.equal(detailRequests, 2);
  assert.deepEqual(h.opens, [{ key: 'beta-v2', loaded: true, track: trackPath }]);
});

test('mutation invalidation during preview-derived detail cannot open obsolete selected content', async () => {
  const h = createTargetNavigationHarness();
  const detailResponse = createDeferred();
  const fetch = h.context.fetch;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      h.requests.push(String(url));
      return detailResponse.promise;
    }
    return fetch(url);
  };
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await settleTargetNavigation();
  // Same invalidation contract used when a problem-exclusion mutation completes.
  h.context.state.utility.problematicSummaryRequestToken += 1;
  h.context.state.utility.loaded = false;
  detailResponse.resolve(h.response(h.detail('beta')));
  await navigation;
  await h.context.state.utility.completeLoadPromise;
  assert.deepEqual(h.opens, [], 'invalidated preview cannot authorize a later modal open');
  assert.equal(h.context.state.utility.loaded, false);
});

for (const previewDetailState of ['loaded', 'in-flight']) {
  test(`changed bounded summary refreshes ${previewDetailState} selected detail`, async () => {
    const h = createTargetNavigationHarness();
    const oldDetail = createDeferred();
    const fetch = h.context.fetch;
    let detailRequests = 0;
    const freshSummary = { ...h.summary('beta'), name: 'Renamed beta', problem_reasons: ['Missing year'] };
    const freshDetail = { ...h.detail('beta'), ...freshSummary, detail_loaded: true,
      tracks: [{ path: h.trackPath('beta'), title: 'Updated track title' }] };
    let refreshActive = false;
    h.context.fetch = (url) => {
      if (refreshActive && String(url).endsWith('?limit=50')) {
        h.requests.push(String(url));
        return Promise.resolve(h.response({ items: [h.summary('alpha'), freshSummary] }));
      }
      if (String(url).includes('/detail?')) {
        h.requests.push(String(url));
        detailRequests += 1;
        if (detailRequests === 1) {
          return previewDetailState === 'in-flight'
            ? oldDetail.promise : Promise.resolve(h.response(h.detail('beta')));
        }
        return Promise.resolve(h.response(freshDetail));
      }
      return fetch(url);
    };
    const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
    h.finishPreview();
    await settleTargetNavigation();
    assert.equal(detailRequests, 1, 'bounded summary must start target hydration');
    refreshActive = true;
    const refresh = h.context.loadProblematicFiles(true, {
      preserveSelectedDetail: true,
    });
    oldDetail.resolve(h.response(h.detail('beta')));
    await Promise.all([refresh, navigation]);
    assert.equal(detailRequests, 2,
      'a changed summary must obtain fresh detail instead of trusting the client generation');
    const selected = h.context.state.utility.problematicFiles.find((item) => item.key === 'beta');
    assert.equal(h.context.state.utility.selectedProblematicKey, 'beta');
    assert.equal(h.context.state.utility.focusedTrackPath, h.trackPath('beta'));
    assert.equal(selected.name, 'Renamed beta');
    assert.equal(selected.tracks[0].title, 'Updated track title');
    assert.deepEqual(Array.from(selected.problem_reasons), ['Missing year']);
    assert.equal(selected.detail_loaded, true);
    if (previewDetailState === 'loaded') {
      assert.ok(h.calls.renders > 0, 'canonical changed content must repaint the already-open target');
    }
  });
}

test('actual closeUtilityModal cancels navigation waiting for initial summary readiness', async () => {
  const h = createTargetNavigationHarness();
  const overlay = { hidden: false };
  h.context.getUtilityModalElements = () => ({ overlay });
  h.context.document = {
    body: { classList: { remove() {} } },
    getElementById() { return { hidden: true }; },
    querySelectorAll() { return []; },
  };
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  const owner = h.context.state.utility.problematicNavigationToken;
  h.context.closeUtilityModal();
  assert.equal(overlay.hidden, true);
  assert.notEqual(h.context.state.utility.problematicNavigationToken, owner);
  h.finishPreview();
  await settleTargetNavigation();
  await navigation;
  await h.context.state.utility.completeLoadPromise;
  assert.deepEqual(h.opens, []);
  assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
});

test('targeted identity returning not found cannot open an off-page album', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const fetch = h.context.fetch;
  h.context.fetch = (url) => String(url).includes('/detail?track_path=')
    ? Promise.resolve(h.response({ error: 'Not found' }, 404))
    : fetch(url);
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.deepEqual(h.opens, []);
});

test('targeted identity cannot open a detail that omits the requested track', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const fetch = h.context.fetch;
  h.context.fetch = (url) => String(url).includes('/detail?track_path=')
    ? Promise.resolve(h.response(h.detail('different')))
    : fetch(url);
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.deepEqual(h.opens, []);
});

test('targeted identity commits the canonical off-page detail', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'] });
  const fetch = h.context.fetch;
  h.context.fetch = (url) => String(url).includes('/detail?track_path=')
    ? Promise.resolve(h.response({ ...h.detail('beta'), name: 'Canonical targeted detail' }))
    : fetch(url);
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  await navigation;
  assert.equal(h.context.state.utility.selectedProblematicDetail?.name,
    'Canonical targeted detail');
});

test('a forced refresh keeps the complete list on screen instead of painting its bounded page', async () => {
  const fullResponse = createDeferred();
  const renderedLengths = [];
  const item = (key) => ({ key, name: key, detail_loaded: false });
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    async fetch(url) {
      if (String(url).endsWith('?limit=50')) {
        return response({ complete: false, items: [item('first')] });
      }
      return fullResponse.promise;
    },
    renderUtilityModalContent() {
      renderedLengths.push(context.state.utility.problematicFiles.length);
    },
  });
  Object.assign(context.state.utility, {
    loaded: true,
    problematicFilesComplete: true,
    problematicFiles: [item('first'), item('second'), item('third')],
  });

  const refresh = context.loadProblematicFiles(true, { preserveSelectedDetail: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state.utility.problematicFilesComplete, false);
  fullResponse.resolve(response({ items: [item('first'), item('third')] }));
  await refresh;

  assert.deepEqual(renderedLengths, [3, 2], 'only the replaced and the complete list paint');
});
