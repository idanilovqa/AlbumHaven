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
const rendererSource = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'utility-renderers-and-actions.js',
), 'utf8');
const problematicTrackNavigationSource = listBuilderSource.slice(
  listBuilderSource.indexOf('function compareProblematicItems('),
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

test('an empty filtered window advances the bounded owner before declaring no matches', () => {
  const pagination = rendererSource.indexOf('void loadNextProblematicFilesPage();');
  const emptyState = rendererSource.indexOf('No matching problematic albums found.');
  assert.ok(pagination >= 0 && pagination < emptyState);
  assert.match(rendererSource, /!items\.length[\s\S]{0,240}problematicServerSearchHasMore[\s\S]{0,160}loadNextProblematicServerSearchPage/);
});

test('virtual paging advances server, album, and Artist owners for settled searches', () => {
  const nearEndStart = rendererSource.indexOf('onNearEnd: () => {');
  const nearEndSource = rendererSource.slice(nearEndStart, nearEndStart + 500);
  assert.match(
    nearEndSource,
    /if \(query\.length >= 2\) void loadNextProblematicServerSearchPage\(\);\s*void loadNextProblematicFilesPage\(\);\s*void loadNextProblematicArtistPage\(\);/,
  );
  assert.doesNotMatch(
    rendererSource,
    /!items\.length && activeSearchQuery\.length < 2\s*&& \(state\.utility\.problematicHasMore \|\| state\.utility\.problematicArtistHasMore\)/,
    'settled searches must keep filling matching rows from the album and Artist owners',
  );
});

test('selected Problematic Files actions resolve a search-only row', () => {
  const context = {
    state: {
      utility: {
        problematicFiles: [{ key: 'base', name: 'Base' }],
        problematicArtistItems: [],
        problematicServerSearchItems: [{ key: 'search-only', name: 'Search only' }],
        selectedProblematicKey: 'search-only',
      },
    },
  };
  vm.createContext(context);
  const helpersStart = listBuilderSource.indexOf('function compareProblematicItems(');
  const helpersEnd = listBuilderSource.indexOf('function getAlbumProblemFilterReasons(');
  vm.runInContext(listBuilderSource.slice(helpersStart, helpersEnd), context, { filename: listBuilderPath });
  const selectedStart = listBuilderSource.indexOf('function getSelectedProblematicAlbum()');
  const selectedEnd = listBuilderSource.indexOf('function getAlbumTrackPaths(', selectedStart);
  vm.runInContext(listBuilderSource.slice(selectedStart, selectedEnd), context, { filename: listBuilderPath });

  assert.equal(context.getSelectedProblematicAlbum()?.key, 'search-only');
});

test('album and Artist feeds merge by the canonical Problematic Files sort key', () => {
  const context = {
    state: {
      utility: {
        problematicFiles: [
          { key: 'album-z', name: 'Zed', album_artist: 'Alpha', year: 2000 },
          { key: 'album-a', name: 'Same', album_artist: 'Beta', year: 2000 },
        ],
        problematicArtistItems: [
          { key: 'artist-a', name: 'Alpha', album_artist: '', year: '' },
          { key: 'artist-z', name: 'Same', album_artist: 'Alpha', year: 2000 },
        ],
        problematicServerSearchItems: [],
      },
    },
  };
  vm.createContext(context);
  const helpersStart = listBuilderSource.indexOf('function compareProblematicItems(');
  const helpersEnd = listBuilderSource.indexOf('function getAlbumProblemFilterReasons(');
  vm.runInContext(listBuilderSource.slice(helpersStart, helpersEnd), context, { filename: listBuilderPath });

  assert.deepEqual(
    Array.from(context.getProblematicBaseItems(), (item) => item.key),
    ['artist-a', 'artist-z', 'album-a', 'album-z'],
  );
});

test('settled search merges every loaded owner once in canonical Problematic Files order', () => {
  const context = {
    state: {
      utility: {
        searchQuery: 'needle',
        problematicServerSearchSettledQuery: 'needle',
        problematicFiles: [
          { key: 'missing', entity_kind: 'missing', name: 'Delta Needle' },
          { key: 'loose', entity_kind: 'loose', name: 'Bravo Needle' },
          { key: 'duplicate', entity_kind: 'album', name: 'Charlie Needle' },
        ],
        problematicArtistItems: [
          { key: 'artist', entity_kind: 'artist', name: 'Alpha Needle' },
        ],
        problematicServerSearchItems: [
          { key: 'server-album', entity_kind: 'album', name: 'Echo Needle' },
          { key: 'duplicate', entity_kind: 'album', name: 'Ignored duplicate Needle' },
        ],
      },
    },
  };
  vm.createContext(context);
  const helpersStart = listBuilderSource.indexOf('function compareProblematicItems(');
  const helpersEnd = listBuilderSource.indexOf('function getProblematicAlbumIssueLabel(');
  vm.runInContext(listBuilderSource.slice(helpersStart, helpersEnd), context, { filename: listBuilderPath });

  assert.deepEqual(
    Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
    ['artist', 'loose', 'duplicate', 'missing', 'server-album'],
  );
});

test('loading saved loops collapses every returned group before selecting the first group', async () => {
  const events = [];
  const { context, calls } = loadHelper({
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
      warn() {},
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
    // Debounced work (the server-side search) stays pending unless a test runs it.
    scheduleBrowserTimeout() { return 0; },
    clearBrowserTimeout() { return true; },
    showToast(message, variant, duration) {
      calls.toasts.push([message, variant, duration]);
    },
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('reopening Problematic Files preserves the current query', () => {
  const overlay = { hidden: true };
  const { context } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return { overlay }; },
  });
  context.state.utility.searchQuery = 'art';

  context.openUtilityModal({ forceLoad: false });

  assert.equal(context.state.utility.searchQuery, 'art');
});

test('only an opened Problematic Files tab reconciles with the complete list; a background list completes on open', async () => {
  const overlay = { hidden: true };
  const requested = [];
  const json = (body) => ({ ok: true, status: 200, async json() { return body; } });
  const { context } = loadHelper({
    getUtilityModalElements() { return { overlay }; },
    async fetch(url) {
      requested.push(String(url));
      const bounded = String(url).endsWith('?limit=50');
      return json({
        complete: !bounded, has_more: false, projection_cache_status: bounded ? 'stale' : 'hit',
        items: [{ key: 'a', name: 'A', detail_loaded: false }],
      });
    },
  });

  // A background reload (after a tag edit) with Settings closed reads only the bounded page.
  await context.loadProblematicFiles(true, { render: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, ['/utilities/problematic-files?limit=50']);
  assert.equal(context.state.utility.problematicListOutdated, true);

  // Opening the tab adds only the complete list; the bounded page is reused.
  overlay.hidden = false;
  await context.loadActiveUtilityTab(false);
  assert.deepEqual(requested.slice(1), ['/utilities/problematic-files']);
  assert.equal(context.state.utility.problematicListOutdated, false);
  const count = requested.length;
  await context.loadActiveUtilityTab(false);
  assert.equal(requested.length, count, 'a reconciled list is not reloaded again on reopen');
});

test('opening the account menu prefetches Problematic Files and Settings reuses it', async () => {
  const overlay = { hidden: true };
  const requested = [];
  const json = (body) => ({ ok: true, status: 200, async json() { return body; } });
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay }; },
    async fetch(url) {
      requested.push(String(url));
      return json({ complete: !String(url).endsWith('?limit=50'), items: [{ key: 'a', name: 'A', detail_loaded: false }] });
    },
  });

  context.prefetchProblematicFilesForSettingsIntent();
  await context.state.utility.completeLoadPromise;
  await new Promise((resolve) => setImmediate(resolve));
  // A closed Settings modal only prefetches the bounded page; the whole-library read waits for the open tab.
  assert.deepEqual(requested, ['/utilities/problematic-files?limit=50']);
  assert.equal(calls.renders, 0, 'a closed Settings modal is not painted');

  overlay.hidden = false;
  await context.loadActiveUtilityTab(true);
  assert.deepEqual(
    requested,
    ['/utilities/problematic-files?limit=50', '/utilities/problematic-files'],
    'Settings reuses the prefetched page and adds only the complete list',
  );
  assert.ok(calls.renders >= 1);
});

function loadSearchHelper(searchBody) {
  const overlay = { hidden: false };
  const timers = [];
  const requested = [];
  const loaded = loadHelper({
    getUtilityModalElements() { return { overlay }; },
    scheduleBrowserTimeout(callback) { timers.push(callback); return timers.length; },
    clearBrowserTimeout(id) { timers[id - 1] = null; },
    async fetch(url) {
      requested.push(String(url));
      return { ok: true, status: 200, async json() { return searchBody; } };
    },
  });
  Object.assign(loaded.context.state.utility, {
    loaded: true,
    problematicFilesComplete: false,
    problematicSummaryRequestToken: 3,
    problematicFiles: [{ key: 'first-page', name: 'First Page Album' }],
  });
  const runTimers = async () => {
    const pending = timers.splice(0).filter(Boolean);
    pending.forEach((callback) => callback());
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...loaded, requested, runTimers };
}

test('a search before the complete list arrives adds the server matches beyond the first page', async () => {
  const { context, calls, requested, runTimers } = loadSearchHelper({
    complete: false,
    items: [{ key: 'first-page', name: 'First Page Album' }, { key: 'album-097', name: 'Needle Album' }],
  });

  context.state.utility.searchQuery = 'needle';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = '  Needle album ';
  context.scheduleProblematicServerSearch();
  await runTimers();

  assert.deepEqual(requested, ['/utilities/problematic-files?q=Needle%20album&limit=50'], 'only the settled query is sent');
  assert.deepEqual([...context.state.utility.problematicFiles].map((item) => item.key), ['first-page']);
  assert.deepEqual([...context.state.utility.problematicServerSearchItems].map((item) => item.key), ['first-page', 'album-097']);
  assert.equal(calls.renders, 1);
});

test('a settled zero-result server search stops the pending state', async () => {
  const { context, calls, runTimers } = loadSearchHelper({
    complete: true,
    has_more: false,
    items: [],
  });
  context.state.utility.searchQuery = 'art zoyd';
  context.scheduleProblematicServerSearch();
  assert.equal(context.state.utility.problematicServerSearchPendingQuery, 'art zoyd');

  await runTimers();

  assert.equal(context.state.utility.problematicServerSearchPendingQuery, '');
  assert.equal(context.state.utility.problematicServerSearchSettledQuery, 'art zoyd');
  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems), []);
  assert.equal(calls.renders, 1, 'the empty state must repaint after the request settles');
});

test('repeating a settled server search reuses its warm result without another request', async () => {
  const { context, requested, runTimers } = loadSearchHelper({
    complete: true,
    has_more: false,
    items: [{ key: 'art-zoyd', name: 'Art Zoyd' }],
  });
  context.state.utility.searchQuery = 'art zoyd';
  context.scheduleProblematicServerSearch();
  await runTimers();

  context.state.utility.searchQuery = '';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = 'art zoyd';
  context.scheduleProblematicServerSearch();
  await runTimers();

  assert.deepEqual(requested, ['/utilities/problematic-files?q=art%20zoyd&limit=50']);
  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems, item => item.key), ['art-zoyd']);
  assert.equal(context.state.utility.problematicServerSearchSettledQuery, 'art zoyd');
});

test('a pending server search does not present matching first-page rows as the complete result', () => {
  const { context } = loadSearchHelper({ items: [] });
  const filterSource = listBuilderSource.slice(
    listBuilderSource.indexOf('function normalizeProblemFilterReason('),
    listBuilderSource.indexOf('function getProblematicAlbumIssueLabel('),
  );
  vm.runInContext(filterSource, context, { filename: listBuilderPath });
  context.state.utility.problematicFiles = [
    { key: 'partial-art-zoyd', name: 'Art Zoyd' },
    { key: 'unrelated', name: 'Unrelated' },
  ];
  context.state.utility.searchQuery = 'art zoyd';
  context.scheduleProblematicServerSearch();

  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums()), []);
});

test('server search page two appends in stable order without duplicates', async () => {
  const { context, requested, runTimers } = loadSearchHelper({
    complete: false,
    has_more: true,
    next_cursor: '97',
    items: [{ key: 'match-1', name: 'Art Zoyd' }],
  });
  context.state.utility.searchQuery = 'art zoyd';
  context.scheduleProblematicServerSearch();
  await runTimers();
  context.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          complete: true,
          has_more: false,
          next_offset: 100,
          items: [{ key: 'match-1', name: 'Art Zoyd' }, { key: 'match-2', name: 'Art Zoyd 2' }],
        };
      },
    };
  };

  await context.loadNextProblematicServerSearchPage();

  assert.deepEqual(requested, [
    '/utilities/problematic-files?q=art%20zoyd&limit=50',
    '/utilities/problematic-files?q=art%20zoyd&limit=50&cursor=97',
  ]);
  assert.deepEqual(
    Array.from(context.state.utility.problematicServerSearchItems, (item) => item.key),
    ['match-1', 'match-2'],
  );
  assert.equal(context.state.utility.problematicServerSearchHasMore, false);
});

test('a newer query or a reload discards a server search answer', async () => {
  for (const supersede of [
    (utility) => { utility.searchQuery = 'other'; },
    (utility) => { utility.problematicSummaryRequestToken = 4; },
  ]) {
    const { context, calls } = loadSearchHelper({ items: [{ key: 'late', name: 'Late' }] });
    context.state.utility.searchQuery = 'late';
    const search = context.searchProblematicFilesOnServer('late');
    supersede(context.state.utility);
    await search;
    assert.deepEqual([...context.state.utility.problematicFiles].map((item) => item.key), ['first-page']);
    assert.equal(calls.renders, 0);
  }
});

test('same-query search generations reject an old ab response after ab to ac to ab', async () => {
  const responses = [createDeferred(), createDeferred()];
  let requestIndex = 0;
  const { context } = loadSearchHelper({ items: [] });
  context.fetch = () => responses[requestIndex++].promise;

  context.state.utility.searchQuery = 'ab';
  context.scheduleProblematicServerSearch();
  const oldAb = context.searchProblematicFilesOnServer('ab');
  context.state.utility.searchQuery = 'ac';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = 'ab';
  context.scheduleProblematicServerSearch();
  const freshAb = context.searchProblematicFilesOnServer('ab');

  responses[1].resolve({ ok: true, async json() { return { items: [{ key: 'fresh-ab' }] }; } });
  await freshAb;
  responses[0].resolve({ ok: true, async json() { return { items: [{ key: 'stale-ab' }] }; } });
  await oldAb;

  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems, (item) => item.key), ['fresh-ab']);
});

test('clearing server search restores the canonical base page order', async () => {
  const { context, runTimers } = loadSearchHelper({
    items: [{ key: 'search-only', name: 'Needle' }],
  });
  context.state.utility.problematicFiles = [
    { key: 'base-b', name: 'Base B' },
    { key: 'base-a', name: 'Base A' },
  ];
  const filterSource = listBuilderSource.slice(
    listBuilderSource.indexOf('function normalizeProblemFilterReason('),
    listBuilderSource.indexOf('function getProblematicAlbumIssueLabel('),
  );
  vm.runInContext(filterSource, context, { filename: listBuilderPath });

  context.state.utility.searchQuery = 'needle';
  context.scheduleProblematicServerSearch();
  await runTimers();
  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums(), (item) => item.key), ['search-only']);

  context.state.utility.searchQuery = '';
  context.scheduleProblematicServerSearch();
  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums(), (item) => item.key), ['base-a', 'base-b']);
});

test('server search preserves selected problem filters and returns only matching rows', async () => {
  const { context, runTimers } = loadSearchHelper({
    items: [
      { key: 'matching', name: 'Art Zoyd Match', problem_reasons: ['Missing year'] },
      { key: 'outside-filter', name: 'Art Zoyd Other', problem_reasons: ['Poor art quality'] },
    ],
  });
  const filterSource = listBuilderSource.slice(
    listBuilderSource.indexOf('function normalizeProblemFilterReason('),
    listBuilderSource.indexOf('function getProblematicAlbumIssueLabel('),
  );
  vm.runInContext(filterSource, context, { filename: listBuilderPath });
  context.state.utility.problematicFiles = [
    { key: 'base-match', name: 'Base Match', problem_reasons: ['Missing year'] },
    { key: 'base-other', name: 'Base Other', problem_reasons: ['Poor art quality'] },
  ];
  context.state.utility.selectedProblemFilters = ['Missing year'];
  context.state.utility.searchQuery = 'art zoyd';

  context.scheduleProblematicServerSearch();
  await runTimers();

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Missing year']);
  assert.deepEqual(
    Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
    ['matching'],
  );

  context.state.utility.searchQuery = '';
  context.scheduleProblematicServerSearch();
  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Missing year']);
  assert.deepEqual(
    Array.from(context.getFilteredProblematicAlbums(), (item) => item.key),
    ['base-match'],
  );
});

test('clearing server search retains its selected result for mutation continuity', async () => {
  const { context, runTimers } = loadSearchHelper({
    items: [{ key: 'search-only', name: 'Needle', detail_loaded: true }],
  });
  context.state.utility.searchQuery = 'needle';
  context.scheduleProblematicServerSearch();
  await runTimers();
  context.state.utility.selectedProblematicKey = 'search-only';

  context.state.utility.searchQuery = '';
  context.scheduleProblematicServerSearch();

  assert.equal(context.state.utility.problematicFiles.at(-1).key, 'search-only');
  assert.equal(context.state.utility.pinnedProblematicKey, 'search-only');
});

test('empty and one-character queries skip server search, but a complete local list does not', async () => {
  const { context, requested, runTimers } = loadSearchHelper({ items: [] });
  context.state.utility.searchQuery = '   ';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = ' x ';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = 'xy';
  context.state.utility.problematicFilesComplete = true;
  context.scheduleProblematicServerSearch();
  await runTimers();
  assert.deepEqual(requested, ['/utilities/problematic-files?q=xy&limit=50']);
});

test('the Settings-intent prefetch skips other tabs and an already open modal', () => {
  const overlay = { hidden: true };
  const requested = [];
  const { context } = loadHelper({
    getUtilityModalElements() { return { overlay }; },
    async fetch(url) { requested.push(String(url)); return new Promise(() => {}); },
  });

  context.state.utility.activeTab = 'appearance';
  context.prefetchProblematicFilesForSettingsIntent();
  context.state.utility.activeTab = 'problematic-files';
  overlay.hidden = false;
  context.prefetchProblematicFilesForSettingsIntent();

  assert.deepEqual(requested, []);
});

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

test('loadProblematicFiles publishes the bounded page without starting an unbounded request', async () => {
  const requestedUrls = [];
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: true } }; },
    async fetch(url) {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            complete: false,
            has_more: true,
            next_offset: 50,
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
  assert.equal(context.state.utility.problematicFilesComplete, false);
  assert.equal(context.state.utility.problematicHasMore, true);
  assert.equal(context.state.utility.problematicNextCursor, '');
  assert.equal(context.state.utility.loading, false);
  assert.equal(context.state.utility.completeLoadPromise, null);
  assert.ok(calls.renders >= 1);
});

test('a bounded continuation preserves selected MusicBrainz detail and manual validation', async () => {
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
        return response({ complete: false, has_more: true, next_cursor: 'page-2', items: [{ ...artist }] });
      }
      return response({ complete: false, has_more: false, next_cursor: '', items: [{ key: 'later', detail_loaded: false }] });
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

  await context.loadNextProblematicFilesPage();

  assert.equal(context.state.utility.problematicFiles[0], selected);
  assert.equal(context.state.utility.problematicFiles[0].musicbrainz_ui.validated.canonical_name, artist.name);
});

test('bounded page schedules a separate nonblocking owner Artist page', async () => {
  const timers = [];
  const requested = [];
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    scheduleBrowserTimeout(callback) { timers.push(callback); return timers.length; },
    getUtilityModalElements() { return { overlay: { hidden: true } }; },
    async fetch(url) {
      requested.push(String(url));
      if (String(url).includes('artists=true')) {
        return response({ complete: true, has_more: false, next_cursor: '', items: [{
          key: 'musicbrainz-artist:7', entity_kind: 'artist', name: 'Unresolved Artist', detail_loaded: false,
        }] });
      }
      return response({ complete: false, has_more: true, next_cursor: 'album-page-2', items: [{ key: 'album', detail_loaded: false }] });
    },
  });

  await context.loadProblematicFiles(true);
  assert.deepEqual(requested, ['/utilities/problematic-files?limit=50']);
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requested, [
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files?artists=true&limit=50&cursor=',
  ]);
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['album']);
  assert.deepEqual(Array.from(context.state.utility.problematicArtistItems, (item) => item.key), ['musicbrainz-artist:7']);
});

test('Artist paging reaches rows beyond fifty and a refresh rejects the prior generation', async () => {
  const firstArtistPage = createDeferred();
  let artistRequestCount = 0;
  const requested = [];
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: true } }; },
    async fetch(url) {
      requested.push(String(url));
      if (String(url).includes('artists=true')) {
        artistRequestCount += 1;
        if (artistRequestCount === 1) return firstArtistPage.promise;
        return response({
          has_more: true,
          next_cursor: 'artist-page-2',
          items: [{ key: 'artist-fresh', detail_loaded: false }],
        });
      }
      return response({ complete: false, has_more: true, next_cursor: 'album-page-2', items: [{ key: 'album', detail_loaded: false }] });
    },
  });
  await context.loadProblematicFiles(true);
  const staleArtistLoad = context.loadNextProblematicArtistPage();
  context.state.utility.problematicSummaryRequestToken += 1;
  context.state.utility.problematicArtistItems = [];
  context.state.utility.problematicArtistNextCursor = '';
  const freshArtistLoad = context.loadNextProblematicArtistPage();
  assert.notStrictEqual(freshArtistLoad, staleArtistLoad);
  await freshArtistLoad;
  firstArtistPage.resolve(response({
    has_more: true,
    next_cursor: 'artist-page-2',
    items: Array.from({ length: 50 }, (_, index) => ({ key: `artist-${index}`, detail_loaded: false })),
  }));
  await staleArtistLoad;
  assert.deepEqual(Array.from(context.state.utility.problematicArtistItems, (item) => item.key), ['artist-fresh']);

  context.fetch = async (url) => {
    requested.push(String(url));
    return response({ has_more: false, next_cursor: '', items: [{ key: 'artist-51', detail_loaded: false }] });
  };
  context.state.utility.problematicArtistHasMore = true;
  await context.loadNextProblematicArtistPage();
  assert.equal(requested.at(-1), '/utilities/problematic-files?artists=true&limit=50&cursor=artist-page-2');
  assert.deepEqual(
    Array.from(context.state.utility.problematicArtistItems, (item) => item.key),
    ['artist-fresh', 'artist-51'],
  );
});

test('Artist cursor restart removes stale later rows and rerenders unchanged page-one keys', async () => {
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: false } }; },
    async fetch() {
      return response({
        cursor_restarted: true,
        has_more: false,
        next_cursor: '',
        items: [{ key: 'artist-1', name: 'Artist One', detail_loaded: false }],
      });
    },
  });
  Object.assign(context.state.utility, {
    problematicArtistItems: [
      { key: 'artist-1', name: 'Artist One', detail_loaded: false },
      { key: 'stale-artist-51', name: 'Stale Artist', detail_loaded: false },
    ],
    problematicArtistHasMore: true,
    problematicArtistNextCursor: 'stale-cursor',
  });

  await context.loadNextProblematicArtistPage();

  assert.deepEqual(
    Array.from(context.state.utility.problematicArtistItems, (item) => item.key),
    ['artist-1'],
  );
  assert.equal(calls.renders, 1, 'cursor restart must repaint after truncating stale later rows');
});

test('one-character search continues album and Artist owners until a later match appears', async () => {
  const requested = [];
  // Loaded in the background (Settings closed), so the album list stays paged; an open
  // tab would reconcile with the complete list instead.
  const overlay = { hidden: true };
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay }; },
    getFilteredProblematicAlbums() {
      const query = String(context.state.utility.searchQuery || '').toLowerCase();
      return [
        ...(context.state.utility.problematicFiles || []),
        ...(context.state.utility.problematicArtistItems || []),
      ].filter((item) => String(item.name || '').toLowerCase().includes(query));
    },
    async fetch(url) {
      requested.push(String(url));
      if (String(url).includes('artists=true')) {
        return response({ has_more: false, next_cursor: '', items: [{ key: 'later-x', name: 'Xylophone Artist', detail_loaded: false }] });
      }
      if (String(url).includes('cursor=page-2')) {
        return response({ has_more: false, next_cursor: '', items: [{ key: 'later-b', name: 'Beta', detail_loaded: false }] });
      }
      return response({ complete: false, has_more: true, next_cursor: 'page-2', items: [{ key: 'first', name: 'Alpha', detail_loaded: false }] });
    },
  });
  await context.loadProblematicFiles(true);
  overlay.hidden = false;
  Object.assign(context.state.utility, {
    problematicArtistItems: [{ key: 'artist-first', name: 'Gamma Artist', detail_loaded: false }],
    problematicArtistHasMore: true,
    problematicArtistNextCursor: 'artist-page-2',
  });
  context.state.utility.searchQuery = 'x';
  const rendersBeforeContinuation = calls.renders;

  await context.loadProblematicPagesUntilLocalQueryMatch('x');

  assert.deepEqual(requested, [
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files?limit=50&cursor=page-2',
    '/utilities/problematic-files?artists=true&limit=50&cursor=artist-page-2',
  ]);
  assert.equal(context.state.utility.problematicArtistItems.at(-1).key, 'later-x');
  assert.equal(context.state.utility.problematicHasMore, false);
  assert.equal(context.state.utility.problematicArtistHasMore, false);
  assert.ok(calls.renders > rendersBeforeContinuation, 'settled continuation must replace the loading state');
});

test('one-character Artist-only exhaustion repaints the terminal no-match state', async () => {
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: false } }; },
    getFilteredProblematicAlbums() { return []; },
    async fetch() {
      return response({ has_more: false, next_cursor: '', items: [] });
    },
  });
  Object.assign(context.state.utility, {
    searchQuery: 'x',
    problematicHasMore: false,
    problematicArtistHasMore: true,
    problematicArtistNextCursor: 'artist-page-2',
  });

  await context.loadProblematicPagesUntilLocalQueryMatch('x');

  assert.equal(context.state.utility.problematicArtistHasMore, false);
  assert.equal(calls.renders, 1, 'exhaustion must replace Loading more with the terminal empty state');
});

test('a settled two-character search can continue the album owner independently', async () => {
  const requested = [];
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: true } }; },
    async fetch(url) {
      requested.push(String(url));
      return response({
        has_more: false,
        next_cursor: '',
        items: [{ key: 'needle-51', name: 'Needle 51', detail_loaded: false }],
      });
    },
  });
  Object.assign(context.state.utility, {
    searchQuery: 'needle',
    problematicFiles: [{ key: 'first', name: 'First' }],
    problematicHasMore: true,
    problematicNextCursor: 'page-2',
  });

  await context.loadNextProblematicFilesPage();

  assert.deepEqual(requested, ['/utilities/problematic-files?limit=50&cursor=page-2']);
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['first', 'needle-51']);
});

test('the next bounded Problematic Files page appends once without duplicates or selection churn', async () => {
  const requested = [];
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context, calls } = loadHelper({
    getUtilityModalElements() { return { overlay: { hidden: true } }; },
    async fetch(url) {
      requested.push(String(url));
      if (String(url).includes('cursor=page-2')) {
        return response({
          complete: false,
          has_more: false,
          next_cursor: '',
          items: [{ key: 'first', detail_loaded: false }, { key: 'second', detail_loaded: false }],
        });
      }
      return response({ complete: false, has_more: true, next_cursor: 'page-2', items: [{ key: 'first', detail_loaded: false }] });
    },
  });
  await context.loadProblematicFiles(true);
  context.state.utility.selectedProblematicKey = 'first';
  assert.deepEqual(calls.consoleErrors, []);
  assert.equal(context.state.utility.problematicHasMore, true);
  assert.equal(context.state.utility.problematicNextCursor, 'page-2');
  assert.equal(Boolean(context.state.utility.problematicPageLoadPromise), false);
  assert.equal(String(context.state.utility.searchQuery || ''), '');

  const [first, reused] = await Promise.all([
    context.loadNextProblematicFilesPage(),
    context.loadNextProblematicFilesPage(),
  ]);

  assert.deepEqual(requested, [
    '/utilities/problematic-files?limit=50',
    '/utilities/problematic-files?limit=50&cursor=page-2',
  ]);
  assert.deepEqual(Array.from(first, (item) => item.key), ['second']);
  assert.deepEqual(Array.from(reused, (item) => item.key), ['second']);
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['first', 'second']);
  assert.equal(context.state.utility.selectedProblematicKey, 'first');
  assert.equal(context.state.utility.problematicHasMore, false);
});

test('the first bounded Problematic Files page opens its filter metadata after reopen', async () => {
  const response = (payload) => ({
    ok: true,
    status: 200,
    async json() { return payload; },
  });
  const { context } = loadHelper({
    async fetch(url) {
      if (String(url).endsWith('?limit=50')) {
        return response({
          complete: false,
          problem_reason_types: ['Missing year', 'Poor art quality'],
          items: [{
            key: 'first',
            name: 'First',
            problem_reasons: ['Missing year'],
            detail_loaded: false,
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    escapeHtml(value) { return String(value); },
    syncTriggerAnchor() {},
    clearTriggerAnchor() {},
  });
  const filterSource = listBuilderSource.slice(
    listBuilderSource.indexOf('function normalizeProblemFilterReason('),
    listBuilderSource.indexOf('function getFilteredProblematicAlbums('),
  );
  vm.runInContext(filterSource, context, { filename: listBuilderPath });
  const attributes = new Map();
  const elements = {
    problemFilterButton: {
      disabled: true,
      hidden: false,
      classList: { toggle() {} },
      setAttribute(name, value) { attributes.set(name, value); },
    },
    problemFilterMenu: { hidden: true, innerHTML: '' },
    problemFilterChips: { innerHTML: '' },
  };
  const clickFilter = () => {
    context.state.utility.problemDropdownOpen = !context.state.utility.problemDropdownOpen;
    context.renderProblemFilterControls(elements);
  };

  await context.loadProblematicFiles(true);
    assert.equal(context.state.utility.problematicFilesComplete, false);
    assert.deepEqual(
      Array.from(context.state.utility.completeProblemReasonTypes || []),
      ['Missing year', 'Poor art quality'],
      'the bounded response must carry complete filter metadata independently of the full album inventory',
    );

    context.renderProblemFilterControls(elements);
    assert.equal(elements.problemFilterButton.disabled, false);
    clickFilter();
    assert.equal(elements.problemFilterMenu.hidden, false, 'the first click on a cold PF open must open the filter');
    assert.match(elements.problemFilterMenu.innerHTML, /Missing year/);
    assert.match(elements.problemFilterMenu.innerHTML, /Poor art quality/);
    assert.equal(attributes.get('aria-expanded'), 'true');

    // Closing Settings tears down the visible surface, but not the bounded
    // response's complete filter metadata. A fresh PF render must still open.
    context.state.utility.problemDropdownOpen = false;
    context.renderProblemFilterControls(elements);
    assert.equal(elements.problemFilterMenu.hidden, true);
    clickFilter();
    assert.equal(elements.problemFilterMenu.hidden, false, 'the filter must also open after Settings is closed and reopened');
    assert.equal(attributes.get('aria-expanded'), 'true');
  context.state.utility.problemDropdownOpen = false;
  context.renderProblemFilterControls(elements);
  assert.match(elements.problemFilterMenu.innerHTML, /Missing year/);
  assert.match(elements.problemFilterMenu.innerHTML, /Poor art quality/);
});
test('loadProblematicFiles reuses its owned bounded request for a concurrent forced load', async () => {
  const boundedResponse = createDeferred();
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
      return boundedResponse.promise;
    },
  });

  const firstLoad = context.loadProblematicFiles(true);
  const concurrentLoad = context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedUrls, ['/utilities/problematic-files?limit=50']);

  boundedResponse.resolve(response({
    complete: false,
    has_more: true,
    next_offset: 50,
    items: [{ key: 'first', name: 'First', detail_loaded: false }],
    initial_detail: detail,
  }));
  await Promise.all([firstLoad, concurrentLoad]);
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

test('navigation-owned Problematic Files loading paints active-query matches before completion', async () => {
  const fullResponse = createDeferred();
  const { context, calls } = loadHelper({
    state: {
      utility: {
        activeTab: 'problematic-files',
        problematicNavigationActiveToken: {},
        searchQuery: 'First',
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

function createTargetNavigationHarness({ previewKeys = ['alpha', 'beta'], fullKeys = previewKeys, directKeys = [] } = {}) {
  const preview = createDeferred();
  const full = createDeferred();
  const requests = [];
  const trackLookups = [];
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
      const lookup = new URL(String(url), 'http://synthetic.test').searchParams.get('track_path');
      if (lookup) {
        // Album Details' direct track lookup; 404 unless the test opts in.
        trackLookups.push(lookup);
        const key = directKeys.find((candidate) => trackPath(candidate) === lookup);
        return Promise.resolve(key ? response(detail(key)) : response({ ok: false }, 404));
      }
      requests.push(String(url));
      if (String(url).endsWith('?limit=50')) return preview.promise;
      if (String(url).includes('/detail?')) {
        const key = new URL(String(url), 'http://synthetic.test').searchParams.get('album_key');
        return Promise.resolve(response(detail(key)));
      }
      return full.promise;
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
    );
    opens.push({ key: selected?.key, loaded: selected?.detail_loaded,
      track: context.state.utility.focusedTrackPath });
  };
  const finishPreview = () => preview.resolve(response({ complete: false, items: previewKeys.map(summary) }));
  const finishFull = () => full.resolve(response({ items: fullKeys.map(summary) }));
  return { context, calls, requests, trackLookups, opens, preview, full, trackPath, summary, detail,
    response, finishPreview, finishFull };
}

const settleTargetNavigation = () => new Promise((resolve) => setImmediate(resolve));

test('track navigation opens hydrated preview target before full summary and keeps one detail request', async () => {
  const h = createTargetNavigationHarness();
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  try {
    await settleTargetNavigation();
    assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
    assert.equal(h.context.state.utility.problematicFilesComplete, false);
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1);
  } finally {
    h.finishFull();
    await navigation;
    await h.context.state.utility.completeLoadPromise;
  }
  assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1,
    'same-summary continuation must not duplicate target hydration');
});

test('outside-page track opens its server-resolved album and remains pinned across a bounded refresh', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'], fullKeys: ['alpha', 'omega'], directKeys: ['omega'] });
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('omega'));
  try {
    await navigation;
    assert.deepEqual(h.trackLookups, [h.trackPath('omega')]);
    assert.deepEqual(h.opens, [{ key: 'omega', loaded: true, track: h.trackPath('omega') }]);
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
    h.finishPreview();
    await settleTargetNavigation();
    assert.deepEqual(h.context.state.utility.problematicFiles.map((item) => item.key), ['alpha', 'omega'],
      'the bounded page must keep the opened album');
    assert.equal(h.context.state.utility.selectedProblematicKey, 'omega');
  } finally {
    h.finishPreview();
    h.finishFull();
    await h.context.state.utility.completeLoadPromise;
  }
  assert.deepEqual(h.context.state.utility.problematicFiles.map((item) => item.key), ['alpha', 'omega']);
  assert.equal(h.context.state.utility.pinnedProblematicKey, 'omega');
});

test('outside-page track without a direct server match never guesses an identity', async () => {
  const h = createTargetNavigationHarness({ previewKeys: ['alpha'], fullKeys: ['alpha', 'omega'] });
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('omega'));
  h.finishPreview();
  await navigation;
  assert.deepEqual(h.opens, []);
  assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
  assert.equal(h.calls.toasts.at(-1)?.[0], 'This track is not currently listed in Problematic Files.');
  h.finishFull();
});

test('concurrent track navigation reuses the bounded summary and opens only the latest target', async () => {
  const h = createTargetNavigationHarness();
  const older = h.context.openUtilityModalForTrack(h.trackPath('alpha'));
  const newer = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  try {
    await settleTargetNavigation();
    assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
    assert.deepEqual(h.requests.filter((url) => !url.includes('/detail?')), [
      '/utilities/problematic-files?limit=50',
    ]);
  } finally {
    h.finishFull();
    await Promise.all([older, newer]);
    await h.context.state.utility.completeLoadPromise;
  }
});

test('bounded navigation reports incomplete while more pages remain', async () => {
  const h = createTargetNavigationHarness();
  const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta'));
  h.finishPreview();
  let complete = false;
  try {
    await settleTargetNavigation();
    const readiness = h.context.waitForProblematicFilesComplete().then((value) => { complete = value; });
    await settleTargetNavigation();
    assert.equal(complete, false);
    assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
    await readiness;
    assert.equal(complete, false);
  } finally {
    h.finishFull();
    await navigation;
  }
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
    h.finishFull();
    await navigation;
    assert.deepEqual(h.opens, []);
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
  });
}

for (const terminal of ['error', 'superseded']) {
  test(`initial summary ${terminal} settles track navigation without opening stale content`, async () => {
    const h = createTargetNavigationHarness();
    let settled = false;
    const navigation = h.context.openUtilityModalForTrack(h.trackPath('beta')).finally(() => { settled = true; });
    // The direct track lookup misses first; supersede the summary load it then starts.
    await settleTargetNavigation();
    assert.deepEqual(h.trackLookups, [h.trackPath('beta')]);
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
    h.finishFull();
    await navigation;
    await h.context.state.utility.completeLoadPromise;
  }
});

test('full summary continuation retains an in-flight target detail when summary content is unchanged', async () => {
  const h = createTargetNavigationHarness();
  const detailResponse = createDeferred();
  const fetch = h.context.fetch;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?album_key')) {
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
    h.finishFull();
    await settleTargetNavigation();
    assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 1);
  } finally {
    h.finishFull();
    detailResponse.resolve(h.response(h.detail('beta')));
    await navigation;
    await h.context.state.utility.completeLoadPromise;
  }
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation survives an in-flight summary refresh that retains its target', async () => {
  const h = createTargetNavigationHarness({
    previewKeys: ['alpha'],
    fullKeys: ['alpha', 'beta'],
  });
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?album_key')) {
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
  h.finishFull();
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
    if (String(url).includes('/detail?album_key')) {
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
  h.finishFull();
  await refresh;
  assert.equal(h.context.state.utility.completeLoadPromise, null,
    'the summary refresh completes before the superseded detail response');

  firstDetail.resolve(h.response(h.detail('beta')));
  await navigation;

  assert.equal(detailRequests, 1,
    'the bounded refresh retains the owned target instead of forcing duplicate hydration');
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('track navigation keeps the selected detail while a bounded refresh omits it', async () => {
  const h = createTargetNavigationHarness({
    previewKeys: ['alpha'],
    fullKeys: ['alpha', 'beta'],
  });
  const firstDetail = createDeferred();
  const fetch = h.context.fetch;
  let detailRequests = 0;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?album_key')) {
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
    'navigation must not fall back to the first bounded item while selected detail ownership settles');

  h.finishFull();
  await refresh;
  await navigation;

  assert.equal(detailRequests, 1,
    'the bounded refresh must not invalidate an unchanged selected detail');
  assert.deepEqual(h.opens, [{ key: 'beta', loaded: true, track: h.trackPath('beta') }]);
});

test('mutation invalidation during preview-derived detail cannot open obsolete selected content', async () => {
  const h = createTargetNavigationHarness();
  const detailResponse = createDeferred();
  const fetch = h.context.fetch;
  h.context.fetch = (url) => {
    if (String(url).includes('/detail?album_key')) {
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
  h.finishFull();
  await navigation;
  await h.context.state.utility.completeLoadPromise;
  assert.deepEqual(h.opens, [], 'invalidated preview cannot authorize a later modal open');
  assert.equal(h.context.state.utility.loaded, false);
});

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
  h.finishFull();
  await navigation;
  await h.context.state.utility.completeLoadPromise;
  assert.deepEqual(h.opens, []);
  assert.equal(h.requests.filter((url) => url.includes('/detail?')).length, 0);
});

test('Settings keeps its body hidden until the requested section renders (no Problematic Files flash)', () => {
  const attributes = new Map([['data-active-tab', 'problematic-files']]);
  const overlay = {
    hidden: true,
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    toggleAttribute: (name, force) => { if (force) attributes.set(name, ''); else attributes.delete(name); },
  };
  const { context } = loadHelper({
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById() { return { hidden: true, classList: { remove() {} } }; },
      querySelectorAll() { return []; },
    },
    getUtilityModalElements() { return { overlay }; },
    scheduleBrowserAnimationFrame() { return 1; },
    renderUtilityModalContent() {},
  });
  context.state.utility.activeTab = 'appearance';
  context.openUtilityModal({ forceLoad: false });
  assert.equal(overlay.hidden, false, 'the shell still paints first');
  assert.equal(attributes.has('data-utility-tab-pending'), true, 'the stale section is not shown');

  attributes.set('data-active-tab', 'appearance');
  context.closeUtilityModal();
  context.openUtilityModal({ forceLoad: false });
  assert.equal(attributes.has('data-utility-tab-pending'), false, 'reopening the same section shows it at once');

  const runtime = require('node:path').join(__dirname, '../../../music_app');
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require('node:path').join(runtime, 'static/js/runtime/utility-renderers-and-actions.js'), 'utf8'),
    /setAttribute\('data-active-tab', activeTab\);\s*els\.overlay\?\.removeAttribute\?\.\('data-utility-tab-pending'\)/);
  assert.match(fs.readFileSync(require('node:path').join(runtime, 'static/css/runtime/utilities.css'), 'utf8'),
    /#utility-modal\[data-utility-tab-pending\] \.utility-modal-body \{ visibility: hidden; \}/);
});

test('a mutation refresh may remove its selected stale bounded identity', async () => {
  const item = (key, detailLoaded = false) => ({ key, name: key, detail_loaded: detailLoaded });
  const { context } = loadHelper({
    async fetch() {
      return { ok: true, async json() { return { complete: false, has_more: true, items: [item('survivor')] }; } };
    },
    renderUtilityModalContent() {},
  });
  Object.assign(context.state.utility, {
    loaded: true,
    problematicFilesComplete: true,
    problematicFiles: [item('stale', true), item('survivor', true)],
    selectedProblematicKey: 'stale',
    problematicMutation: { albumKey: 'stale' },
  });

  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });

  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (album) => album.key), ['survivor']);
});

test('a forced refresh keeps the prior list on screen until the bounded replacement arrives', async () => {
  const renderedLengths = [];
  const item = (key) => ({ key, name: key, detail_loaded: false });
  const response = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
  const { context } = loadHelper({
    async fetch(url) {
      return response({ complete: false, has_more: true, next_offset: 50, items: [item('first')] });
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

  await context.loadProblematicFiles(true, { preserveSelectedDetail: true });
  assert.equal(context.state.utility.problematicFilesComplete, false);

  assert.deepEqual(renderedLengths, [3, 1], 'the old list paints first, then the bounded replacement');
});
