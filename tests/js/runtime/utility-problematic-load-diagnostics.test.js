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
        async json() {
          return {
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
      getElementById() { return { hidden: true }; },
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
      getElementById() { return { hidden: true }; },
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
      getElementById() { return { hidden: true }; },
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

test('utility modal suspends gallery work synchronously before rendering or loading and resumes on close', () => {
  const events = [];
  const overlay = { hidden: true };
  const { context } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true }; },
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
    renderUtilityModalContent() { events.push('render'); },
    async fetch() {
      events.push('load');
      return { ok: true, status: 200, async json() { return { items: [] }; } };
    },
  });

  context.openUtilityModal({ forceLoad: true });
  assert.equal(overlay.hidden, false);
  assert.equal(events[0], 'suspend');
  assert.ok(events.indexOf('suspend') < events.indexOf('render'));
  assert.ok(events.indexOf('suspend') < events.indexOf('load'));

  context.closeUtilityModal();
  assert.equal(overlay.hidden, true);
  assert.ok(events.indexOf('resume:7') > events.indexOf('load'));
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
  const renderIndex = openSource.indexOf('renderUtilityModalContent()');
  const loadIndex = openSource.indexOf('loadActiveUtilityTab(true)');
  assert.ok(suspendIndex >= 0);
  assert.ok(suspendIndex < renderIndex);
  assert.ok(suspendIndex < loadIndex);
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
        getElementById() { return { hidden: true }; },
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
  assert.deepEqual(requestedUrls, ['/utilities/problematic-files']);
  assert.equal(calls.renders, rendersAfterSummary);
  assert.equal(context.state.utility.problematicDiagnostics.lastDetailLoad, null);
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.initialDetailKey, 'album-1');
  assert.equal(context.state.utility.problematicDiagnostics.summaryLoad.initialDetailMerged, true);

  context.state.utility.selectedProblematicKey = 'album-2';
  const secondDetail = await context.loadProblematicAlbumDetail('album-2');
  assert.equal(secondDetail.detail_loaded, true);
  assert.deepEqual(requestedUrls, [
    '/utilities/problematic-files',
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
    '/utilities/problematic-files',
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
