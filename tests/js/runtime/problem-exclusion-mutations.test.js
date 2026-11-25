const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
);
const listBuildersPath = path.join(runtimeRoot, 'utility-list-builders.js');
const mutationPath = path.join(runtimeRoot, 'problem-exclusion-mutations.js');
const loaderPath = path.join(runtimeRoot, 'utility-loaders-and-cover-lookup.js');
const listBuildersSource = fs.readFileSync(listBuildersPath, 'utf8');
const mutationSource = fs.readFileSync(mutationPath, 'utf8');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function albumFixture() {
  return {
    key: 'neal-morse-question-2005',
    name: '?',
    album_artist: 'Neal Morse',
    year: 2005,
    issue_count: 2,
    problem_reasons: ['Undecoded characters', 'Missing year'],
    album_problem_rows: [{
      row_key: 'album::neal-morse-question-2005::undecoded-characters',
      reason: 'Undecoded characters',
      display_reason: 'Undecoded characters ("?" in Album)',
    }],
    track_problem_rows: [{
      path: 'C:\\Music\\Neal Morse\\?\\01 The Temple.flac',
      filename: '01 The Temple.flac',
      reasons: ['Undecoded characters', 'Missing year'],
      ignorable_reasons: [
        {
          row_key: 'file::temple::undecoded-characters',
          reason: 'Undecoded characters',
        },
        {
          row_key: 'file::temple::missing-year',
          reason: 'Missing year',
        },
      ],
    }, {
      path: 'C:\\Music\\Neal Morse\\?\\02 Another World.flac',
      filename: '02 Another World.flac',
      reasons: ['Undecoded characters'],
      ignorable_reasons: [{
        row_key: 'file::another-world::undecoded-characters',
        reason: 'Undecoded characters',
      }],
    }],
  };
}

function albumItem() {
  return {
    row_key: 'album::neal-morse-question-2005::undecoded-characters',
    scope: 'album',
    album_key: 'neal-morse-question-2005',
    artist: 'Neal Morse',
    album: '?',
    year: '2005',
    problem_reason: 'Undecoded characters',
  };
}

function fileItem() {
  return {
    row_key: 'file::temple::missing-year',
    scope: 'file',
    path: 'C:\\Music\\Neal Morse\\?\\01 The Temple.flac',
    filename: '01 The Temple.flac',
    album: '?',
    problem_reason: 'Missing year',
  };
}

function emptyProblemIgnoreRule() {
  return {
    key: 'problem-ignores',
    title: 'Problem exclusions',
    count: 0,
    items: [],
    album_items: [],
    file_items: [],
  };
}

function loadMutationHelpers(overrides = {}) {
  const renders = [];
  const toasts = [];
  const closes = [];
  const context = {
    console,
    Map,
    Promise,
    Set,
    clearTimeout,
    setTimeout,
    structuredClone,
    state: {
      utility: {
        problematicFiles: [],
        selectedProblematicKey: '',
        problemExclusionSelections: {},
        rulesLoaded: true,
        rules: [emptyProblemIgnoreRule()],
        problemExclusionMutations: {
          nextOperationId: 1,
          revision: 0,
          latestByRowKey: {},
          pendingByOperationId: {},
        },
        loaded: true,
        loading: false,
        loadPromise: null,
        detailLoadPromises: {},
        problematicSummaryRequestToken: 0,
        problematicDiagnostics: {},
      },
    },
    escapeHtml(value) { return String(value ?? ''); },
    getFilenameFromPath(value) { return String(value || '').split('\\').pop() || ''; },
    getIgnoredRepairRowKeys() { return []; },
    buildCompactDataTable() { return ''; },
    renderUtilityModalContent() { renders.push(clone(context.state.utility)); },
    closeRepairConfirmModal() { closes.push(true); },
    showToast(...args) { toasts.push(args); },
    getProblematicUtilityNow() { return 0; },
    roundProblematicUtilityMs(value) { return value; },
    validateProblematicSummaryPayload(data) {
      return {
        summaryItems: Array.isArray(data?.problematic_files) ? data.problematic_files : [],
        initialDetail: null,
      };
    },
    readProblematicPayloadError(_data, fallback) { return fallback; },
    waitForProblematicUtilityRenderFrame() { return Promise.resolve(); },
    recordProblematicUtilityDiagnostics() {},
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(listBuildersSource, context, { filename: listBuildersPath });
  vm.runInContext(mutationSource, context, { filename: mutationPath });
  vm.runInContext(loaderSource, context, { filename: loaderPath });
  Object.assign(context, {
    closeRepairConfirmModal() { closes.push(true); },
    getProblematicUtilityNow() { return 0; },
    roundProblematicUtilityMs(value) { return value; },
    validateProblematicSummaryPayload(data) {
      return {
        summaryItems: Array.isArray(data?.problematic_files) ? data.problematic_files : [],
        initialDetail: null,
      };
    },
    readProblematicPayloadError(_data, fallback) { return fallback; },
    waitForProblematicUtilityRenderFrame() { return Promise.resolve(); },
    recordProblematicUtilityDiagnostics() {},
  });
  Object.assign(context, overrides);
  return { context, closes, renders, toasts };
}

function problemIgnoreRule(context) {
  return context.state.utility.rules.find((rule) => rule.key === 'problem-ignores');
}

test('album exclusion removes the matching album and track reasons and drops an empty card', () => {
  const { context } = loadMutationHelpers();
  const album = albumFixture();
  album.problem_reasons = ['Undecoded characters'];
  album.issue_count = 1;
  album.track_problem_rows[0].reasons = ['Undecoded characters'];
  album.track_problem_rows[0].ignorable_reasons = [
    album.track_problem_rows[0].ignorable_reasons[0],
  ];

  const result = context.projectProblemExclusionFromAlbum(album, [albumItem()]);

  assert.equal(result.updatedAlbum, null);
  assert.deepEqual(
    Array.from(result.optimisticRuleItems, (item) => item.row_key),
    [albumItem().row_key],
  );
});

test('an excluded card leaves the search results as well as the loaded pages', () => {
  // The list is paged (BUGFIX-14): a searched card may be listed by the search results alone.
  const { context } = loadMutationHelpers();
  const album = albumFixture();
  context.state.utility.problematicFiles = [];
  context.state.utility.problematicServerSearchItems = [album, { key: 'other' }];

  context.applyOptimisticProblemExclusionCard(album, null);

  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems, (item) => item.key), ['other']);
});

test('searching again after an exclusion does not list the excluded album', () => {
  const { context } = loadMutationHelpers({
    clearBrowserTimeout() {},
    isUtilityModalOpen() { return false; },
  });
  const album = albumFixture();
  const other = { ...albumFixture(), key: 'other' };
  context.state.utility.searchQuery = 'Album';
  const { key } = context.problematicServerQuery();
  context.state.utility.problematicServerSearchSettledQuery = key;
  context.state.utility.problematicServerSearchItems = [album, other];
  context.state.utility.problematicServerSearchCache = {
    [key]: { items: [album, other], hasMore: false, nextCursor: '' },
  };

  context.applyOptimisticProblemExclusionCard(album, null);
  context.state.utility.searchQuery = '';
  context.scheduleProblematicServerSearch();
  context.state.utility.searchQuery = 'Album';
  context.scheduleProblematicServerSearch();

  assert.equal(context.state.utility.problematicServerSearchSettledQuery, key);
  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems, (item) => item.key), ['other']);
});

test('album exclusion preserves unrelated reasons on the same card', () => {
  const { context } = loadMutationHelpers();

  const result = context.projectProblemExclusionFromAlbum(albumFixture(), [albumItem()]);

  assert.deepEqual(Array.from(result.updatedAlbum.problem_reasons), ['Missing year']);
  assert.equal(result.updatedAlbum.issue_count, 1);
  assert.deepEqual(Array.from(result.updatedAlbum.album_problem_rows), []);
  assert.equal(result.updatedAlbum.track_problem_rows.length, 1);
  assert.deepEqual(Array.from(result.updatedAlbum.track_problem_rows[0].reasons), ['Missing year']);
  assert.deepEqual(
    Array.from(result.updatedAlbum.track_problem_rows[0].ignorable_reasons, (item) => item.row_key),
    ['file::temple::missing-year'],
  );
});

test('file exclusion removes only the selected file and reason instance', () => {
  const { context } = loadMutationHelpers();

  const result = context.projectProblemExclusionFromAlbum(albumFixture(), [fileItem()]);

  assert.deepEqual(Array.from(result.updatedAlbum.problem_reasons), [
    'Undecoded characters',
  ]);
  assert.equal(result.updatedAlbum.issue_count, 1);
  assert.deepEqual(Array.from(result.updatedAlbum.track_problem_rows[0].reasons), [
    'Undecoded characters',
  ]);
  assert.equal(result.updatedAlbum.track_problem_rows.length, 2);
  assert.deepEqual(Array.from(result.updatedAlbum.album_problem_rows, (item) => item.row_key), [
    albumItem().row_key,
  ]);
});

test('a stale Rules fetch preserves a pending create and suppresses a pending revert', () => {
  const { context } = loadMutationHelpers();
  const createItem = { ...albumItem(), pending: true };
  const revertedItem = fileItem();
  context.state.utility.problemExclusionMutations.pendingByOperationId = {
    1: { id: 1, kind: 'create', items: [createItem] },
    2: { id: 2, kind: 'revert', items: [revertedItem] },
  };
  context.state.utility.problemExclusionMutations.latestByRowKey = {
    [createItem.row_key]: 1,
    [revertedItem.row_key]: 2,
  };
  const staleRules = [{
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [revertedItem],
    album_items: [],
    file_items: [revertedItem],
  }];

  const merged = context.mergePendingProblemExclusionRules(staleRules);
  const rule = merged.find((item) => item.key === 'problem-ignores');

  assert.equal(rule.count, 1);
  assert.deepEqual(Array.from(rule.items, (item) => item.row_key), [createItem.row_key]);
  assert.deepEqual(Array.from(rule.album_items, (item) => item.row_key), [createItem.row_key]);
  assert.deepEqual(Array.from(rule.file_items), []);
});

test('create is visible on both Utilities surfaces before its fetch resolves', async () => {
  const request = deferred();
  const album = albumFixture();
  album.problem_reasons = ['Undecoded characters'];
  album.issue_count = 1;
  album.track_problem_rows[0].reasons = ['Undecoded characters'];
  album.track_problem_rows[0].ignorable_reasons = [
    album.track_problem_rows[0].ignorable_reasons[0],
  ];
  let requestUrl = '';
  let requestPayload = null;
  const { context, closes, toasts } = loadMutationHelpers({
    fetch(url, options) {
      requestUrl = url;
      requestPayload = JSON.parse(options.body);
      return request.promise;
    },
  });
  context.state.utility.problematicFiles = [album];
  context.state.utility.selectedProblematicKey = album.key;

  const completion = context.queueProblemExclusionCreate({ album, items: [albumItem()] });

  assert.equal(context.state.utility.problematicFiles.length, 0);
  assert.equal(context.state.utility.selectedProblematicKey, '');
  assert.equal(problemIgnoreRule(context).count, 1);
  assert.equal(problemIgnoreRule(context).album_items[0].row_key, albumItem().row_key);
  assert.equal(problemIgnoreRule(context).album_items[0].pending, true);
  assert.equal(closes.length, 1);
  assert.deepEqual(toasts.map((args) => args[0]), ['Problem exclusion queued.']);
  assert.equal(requestUrl, '/utilities/rules/problem-ignores');
  assert.deepEqual(Object.keys(requestPayload).sort(), ['items']);
  assert.equal(Object.hasOwn(requestPayload, 'album'), false);
  assert.equal(Object.hasOwn(requestPayload, 'selected_rows'), false);
  assert.equal(Object.hasOwn(requestPayload, 'confirmed'), false);

  const canonical = {
    ...albumItem(),
    group_key: 'neal-morse-question-2005',
    pending: false,
  };
  request.resolve({
    ok: true,
    async json() {
      return { ok: true, applied_items: [canonical], removed_legacy_row_keys: [] };
    },
  });
  await completion;

  assert.deepEqual(clone(problemIgnoreRule(context).album_items[0]), canonical);
  assert.equal(toasts.length, 1, 'acknowledgement must not show a second success toast');
});

test('album exclusion request preserves the durable album key from the problem row', async () => {
  const album = albumFixture();
  album.key = 'durable-album::year::1988';
  album.album_problem_rows[0].album_key = 'durable-album';
  let requestPayload = null;
  const { context } = loadMutationHelpers({
    async fetch(_url, options) {
      requestPayload = JSON.parse(options.body);
      return {
        ok: true,
        async json() { return { ok: true, applied_items: [], removed_legacy_row_keys: [] }; },
      };
    },
  });
  context.state.utility.problematicFiles = [album];
  const item = context.buildProblemExclusionItemFromAlbum(
    album,
    album.album_problem_rows[0].row_key,
  );

  await context.queueProblemExclusionCreate({ album, items: [item] });

  assert.equal(requestPayload.items[0].album_key, 'durable-album');
});

test('a rejected create restores both surfaces and uses exclusion-specific copy', async () => {
  const album = albumFixture();
  const priorRule = emptyProblemIgnoreRule();
  const { context, toasts } = loadMutationHelpers({
    async fetch() {
      return {
        ok: false,
        async json() { return { error: 'database unavailable' }; },
      };
    },
  });
  context.state.utility.problematicFiles = [album];
  context.state.utility.selectedProblematicKey = album.key;
  context.state.utility.rules = [priorRule];

  await context.queueProblemExclusionCreate({ album, items: [albumItem()] });

  assert.deepEqual(context.state.utility.problematicFiles, [album]);
  assert.equal(context.state.utility.selectedProblematicKey, album.key);
  assert.deepEqual(clone(context.state.utility.rules), clone([priorRule]));
  assert.equal(toasts.at(-1)[0], 'Failed to save problem exclusion');
  assert.equal(toasts.at(-1)[1], 'error');
});

test('a rejected create puts a searched album back into the search results where it was', async () => {
  const album = albumFixture();
  const { context } = loadMutationHelpers({
    async fetch() {
      return { ok: false, async json() { return { error: 'database unavailable' }; } };
    },
  });
  const first = { key: 'first' };
  const loaded = { key: 'loaded' };
  context.state.utility.problematicFiles = [loaded];
  context.state.utility.problematicServerSearchItems = [first, album];
  context.state.utility.selectedProblematicKey = album.key;

  await context.queueProblemExclusionCreate({ album, items: [albumItem()] });

  assert.deepEqual(Array.from(context.state.utility.problematicServerSearchItems, (item) => item.key), ['first', album.key]);
  assert.deepEqual(Array.from(context.state.utility.problematicFiles, (item) => item.key), ['loaded']);
  assert.equal(context.state.utility.selectedProblematicKey, album.key);
});

test('an older failure cannot roll back a newer mutation for the same row key', () => {
  const { context } = loadMutationHelpers();
  const original = albumFixture();
  const older = context.beginProblemExclusionMutation({
    kind: 'create',
    items: [albumItem()],
    snapshot: { problematicFiles: [original] },
  });
  const newer = context.beginProblemExclusionMutation({
    kind: 'revert',
    items: [albumItem()],
    snapshot: { problematicFiles: [] },
  });
  context.state.utility.problematicFiles = [];

  const restored = context.rollbackProblemExclusionMutation(older);

  assert.equal(restored, false);
  assert.deepEqual(context.state.utility.problematicFiles, []);
  assert.equal(context.isLatestProblemExclusionMutation(older), false);
  assert.equal(context.isLatestProblemExclusionMutation(newer), true);
  assert.equal(
    Object.hasOwn(
      context.state.utility.problemExclusionMutations.pendingByOperationId,
      older.id,
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      context.state.utility.problemExclusionMutations.pendingByOperationId,
      newer.id,
    ),
    true,
  );
});

test('revert removes the rule immediately and restores it on rejection', async () => {
  const request = deferred();
  const item = albumItem();
  const { context, toasts } = loadMutationHelpers({
    fetch() { return request.promise; },
  });
  context.state.utility.rules = [{
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [item],
    album_items: [item],
  }];
  context.state.utility.loaded = true;

  const completion = context.queueProblemExclusionRevert(item);

  assert.equal(problemIgnoreRule(context).count, 0);
  assert.deepEqual(Array.from(problemIgnoreRule(context).album_items), []);
  assert.deepEqual(toasts.map((args) => args[0]), ['Problem exclusion revert queued.']);
  assert.equal(
    context.mergePendingProblemExclusionRules(context.state.utility.rules)[0].count,
    0,
    'a stale Rules merge must not re-add the pending revert',
  );

  request.resolve({
    ok: false,
    async json() { return { error: 'database unavailable' }; },
  });
  await completion;

  assert.equal(problemIgnoreRule(context).count, 1);
  assert.equal(problemIgnoreRule(context).album_items[0].row_key, item.row_key);
  assert.equal(context.state.utility.loaded, true);
  assert.equal(toasts.at(-1)[0], 'Failed to revert problem exclusion');
  assert.equal(toasts.at(-1)[1], 'error');
});

test('create closes confirmation after the optimistic Utilities render replaces its focus target', async () => {
  const events = [];
  const request = deferred();
  const album = albumFixture();
  const { context } = loadMutationHelpers({
    renderUtilityModalContent() { events.push('render'); },
    closeRepairConfirmModal() { events.push('close'); },
    fetch() { return request.promise; },
  });
  context.state.utility.problematicFiles = [album];

  const completion = context.queueProblemExclusionCreate({ album, items: [albumItem()] });

  assert.deepEqual(events, ['render', 'close']);
  request.resolve({
    ok: true,
    async json() { return { ok: true, applied_items: [albumItem()] }; },
  });
  await completion;
});

test('revert keeps the optimistic removal painted until a fast rejection can roll back', async () => {
  const paint = deferred();
  const item = albumItem();
  let requestCount = 0;
  const { context } = loadMutationHelpers({
    fetch() {
      requestCount += 1;
      return Promise.resolve({
        ok: false,
        async json() { return { error: 'database unavailable' }; },
      });
    },
  });
  context.waitForProblematicUtilityRenderFrame = () => paint.promise;
  context.state.utility.rules = [{
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [item],
    album_items: [item],
  }];

  const completion = context.queueProblemExclusionRevert(item);

  assert.equal(problemIgnoreRule(context).count, 0);
  assert.equal(requestCount, 0, 'the browser must paint the optimistic removal before request work begins');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(problemIgnoreRule(context).count, 0);
  assert.equal(requestCount, 0);

  paint.resolve();
  await completion;

  assert.equal(requestCount, 1);
  assert.equal(problemIgnoreRule(context).count, 1);
});

test('revert keeps the optimistic removal after compact acknowledgement', async () => {
  const request = deferred();
  const item = albumItem();
  let requestUrl = '';
  let requestPayload = null;
  const { context, toasts } = loadMutationHelpers({
    fetch(url, options) {
      requestUrl = url;
      requestPayload = JSON.parse(options.body);
      return request.promise;
    },
  });
  context.state.utility.rules = [{
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [item],
    album_items: [item],
  }];
  context.state.utility.loaded = true;

  const completion = context.queueProblemExclusionRevert(item);

  assert.equal(problemIgnoreRule(context).count, 0);
  assert.equal(context.state.utility.loaded, true, 'pending revert must not invalidate the list');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestUrl, '/utilities/rules/problem-ignores/revert');
  assert.deepEqual(requestPayload, { row_key: item.row_key });

  request.resolve({
    ok: true,
    async json() { return { ok: true, reverted_row_key: item.row_key }; },
  });
  await completion;

  assert.equal(problemIgnoreRule(context).count, 0);
  assert.equal(
    context.state.utility.loaded,
    false,
    'acknowledged revert must reload Problematic Files when the user switches tabs',
  );
  assert.deepEqual(
    Object.keys(context.state.utility.problemExclusionMutations.pendingByOperationId),
    [],
  );
  assert.deepEqual(
    toasts.map((args) => args[0]),
    ['Problem exclusion revert queued.'],
    'acknowledgement must not show a second success toast',
  );
});

test('a later acknowledged exclusion remains projected when an earlier sibling fails', async () => {
  const firstRequest = deferred();
  const secondRequest = deferred();
  const album = albumFixture();
  const { context } = loadMutationHelpers({
    fetch(_url, options) {
      const payload = JSON.parse(options.body);
      return payload.items[0].row_key === albumItem().row_key
        ? firstRequest.promise
        : secondRequest.promise;
    },
  });
  context.state.utility.problematicFiles = [album];
  context.state.utility.selectedProblematicKey = album.key;

  const firstCompletion = context.queueProblemExclusionCreate({ album, items: [albumItem()] });
  const projectedAlbum = context.state.utility.problematicFiles[0];
  const secondCompletion = context.queueProblemExclusionCreate({
    album: projectedAlbum,
    items: [fileItem()],
  });

  secondRequest.resolve({
    ok: true,
    async json() { return { ok: true, applied_items: [fileItem()] }; },
  });
  await secondCompletion;
  firstRequest.resolve({
    ok: false,
    async json() { return { error: 'first mutation rejected' }; },
  });
  await firstCompletion;

  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles[0].problem_reasons),
    ['Undecoded characters'],
  );
  assert.deepEqual(
    Array.from(problemIgnoreRule(context).items, (item) => item.row_key),
    [fileItem().row_key],
  );
});

test('an earlier acknowledged exclusion remains projected when a later sibling fails', async () => {
  const firstRequest = deferred();
  const secondRequest = deferred();
  const album = albumFixture();
  const { context } = loadMutationHelpers({
    fetch(_url, options) {
      const payload = JSON.parse(options.body);
      return payload.items[0].row_key === albumItem().row_key
        ? firstRequest.promise
        : secondRequest.promise;
    },
  });
  context.state.utility.problematicFiles = [album];
  context.state.utility.selectedProblematicKey = album.key;

  const firstCompletion = context.queueProblemExclusionCreate({ album, items: [albumItem()] });
  const secondCompletion = context.queueProblemExclusionCreate({
    album: context.state.utility.problematicFiles[0],
    items: [fileItem()],
  });

  firstRequest.resolve({
    ok: true,
    async json() { return { ok: true, applied_items: [albumItem()] }; },
  });
  await firstCompletion;
  secondRequest.resolve({
    ok: false,
    async json() { return { error: 'second mutation rejected' }; },
  });
  await secondCompletion;

  assert.deepEqual(
    Array.from(context.state.utility.problematicFiles[0].problem_reasons),
    ['Missing year'],
  );
  assert.deepEqual(
    Array.from(problemIgnoreRule(context).items, (item) => item.row_key),
    [albumItem().row_key],
  );
});

test('Rules GET started before create cannot overwrite its acknowledgement', async () => {
  const rulesRequest = deferred();
  const album = albumFixture();
  const { context } = loadMutationHelpers({
    fetch(url) {
      if (url === '/utilities/rules') return rulesRequest.promise;
      return Promise.resolve({
        ok: true,
        async json() { return { ok: true, applied_items: [albumItem()] }; },
      });
    },
  });
  context.state.utility.problematicFiles = [album];

  const rulesCompletion = context.loadUtilityRules(true);
  await context.queueProblemExclusionCreate({ album, items: [albumItem()] });
  rulesRequest.resolve({
    ok: true,
    async json() { return { ok: true, rules: [emptyProblemIgnoreRule()] }; },
  });
  await rulesCompletion;

  assert.deepEqual(
    Array.from(problemIgnoreRule(context).items, (item) => item.row_key),
    [albumItem().row_key],
  );
});

test('Rules GET started before revert cannot restore its acknowledged row', async () => {
  const rulesRequest = deferred();
  const item = albumItem();
  const staleRule = {
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [item],
    album_items: [item],
  };
  const { context } = loadMutationHelpers({
    fetch(url) {
      if (url === '/utilities/rules') return rulesRequest.promise;
      return Promise.resolve({
        ok: true,
        async json() { return { ok: true, reverted_row_key: item.row_key }; },
      });
    },
  });
  context.state.utility.rules = [staleRule];

  const rulesCompletion = context.loadUtilityRules(true);
  await context.queueProblemExclusionRevert(item);
  rulesRequest.resolve({
    ok: true,
    async json() { return { ok: true, rules: [staleRule] }; },
  });
  await rulesCompletion;

  assert.equal(problemIgnoreRule(context).count, 0);
});

test('stale Problematic Files GET cannot defeat acknowledged revert invalidation', async () => {
  const summaryRequest = deferred();
  const item = albumItem();
  const { context } = loadMutationHelpers({
    fetch(url) {
      if (url === '/utilities/problematic-files') return summaryRequest.promise;
      return Promise.resolve({
        ok: true,
        async json() { return { ok: true, reverted_row_key: item.row_key }; },
      });
    },
  });
  context.state.utility.rules = [{
    ...emptyProblemIgnoreRule(),
    count: 1,
    items: [item],
    album_items: [item],
  }];

  const summaryCompletion = context.loadProblematicFiles(true);
  await context.queueProblemExclusionRevert(item);
  summaryRequest.resolve({
    ok: true,
    status: 200,
    async json() { return { ok: true, problematic_files: [] }; },
  });
  await summaryCompletion;

  assert.equal(context.state.utility.loaded, false);
});

for (const selectAlbum of [false, true]) {
  test(`bulk matching-file selection ${selectAlbum ? 'under an album exclusion persists no redundant child rules' : 'without an album exclusion preserves every file rule'}`, async () => {
    const album = albumFixture();
    const reason = 'Undecoded characters';
    album.track_problem_rows = Array.from({ length: 18 }, (_, index) => ({
      path: `C:\\Music\\fixture\\${index}.flac`, filename: `${index}.flac`,
      reasons: [reason], ignorable_reasons: [{ row_key: `file::${index}::undecoded`, reason }],
    }));
    album.track_problem_rows[0].reasons.push('Missing year');
    album.track_problem_rows[0].ignorable_reasons.push({ row_key: 'file::0::year', reason: 'Missing year' });
    const persisted = new Map();
    const requests = [];
    const { context } = loadMutationHelpers({
      async fetch(url, options) {
        const payload = JSON.parse(options.body);
        requests.push({ url, payload });
        if (url.endsWith('/revert')) persisted.delete(payload.row_key);
        else for (const item of payload.items) persisted.set(item.row_key, item);
        return { ok: true, async json() { return { ok: true, applied_items: payload.items || [] }; } };
      },
    });
    context.state.utility.problematicFiles = [album];
    context.state.utility.selectedProblematicKey = album.key;
    const rowKeys = [
      ...(selectAlbum ? [album.album_problem_rows[0].row_key] : []),
      ...album.track_problem_rows.flatMap(row => row.ignorable_reasons.map(item => item.row_key)),
    ];
    const items = rowKeys.map(rowKey => context.buildProblemExclusionItemFromAlbum(album, rowKey));
    await context.queueProblemExclusionCreate({ album, items });
    assert.equal(requests[0].payload.items.length, selectAlbum ? 2 : 19);
    assert.equal(problemIgnoreRule(context).count, selectAlbum ? 2 : 19);
    assert.equal(persisted.has('file::0::year'), true, 'different file-level reasons remain independently selected');
    if (selectAlbum) {
      await context.queueProblemExclusionRevert(items[0]);
      assert.deepEqual([...persisted.keys()], ['file::0::year'],
        'reverting the single album exclusion restores all 18 undecoded-file problems');
      assert.equal(problemIgnoreRule(context).count, 1);
    } else {
      assert.equal([...persisted.keys()].filter(key => key.endsWith('::undecoded')).length, 18);
    }
  });
}

test('album selection canonicalization retains foreign or unknown file identities for server validation', () => {
  const album = albumFixture();
  const { context } = loadMutationHelpers();
  const ownedKey = album.track_problem_rows[0].ignorable_reasons[0].row_key;
  const foreign = { row_key: ownedKey, scope: 'file', path: 'C:\\Other\\foreign.flac', problem_reason: 'Undecoded characters' };
  const unknown = { row_key: 'unknown::undecoded', scope: 'file', path: album.track_problem_rows[0].path, problem_reason: 'Undecoded characters' };
  const missingPath = { row_key: 'unknown::without-path', scope: 'file', problem_reason: 'Undecoded characters' };
  const selected = [albumItem(), foreign, unknown, missingPath];
  assert.deepEqual(clone(context.effectiveProblemExclusionItems(album, selected)), selected);
});

// The Rules payload lists problem exclusions in Python sorted() order of row_key (code points), so a
// reload shows them in that order. These keys, in exactly that order, include case, accents, Cyrillic,
// a full-width letter and an astral character, where code-unit or locale order would differ.
const SERVER_ORDERED_FILE_KEYS = [
  'Abba/Gold/01 Dancing Queen.flac::problem-file::missing-year',
  'Moby/Play/01 Honey.flac::problem-file::missing-year',
  'Zeta/Zero/01 Start.flac::problem-file::missing-year',
  'abba/gold/02 Waterloo.flac::problem-file::missing-year',
  'Émile/Encore/01 Bis.flac::problem-file::missing-year',
  'émile/encore/02 Bis.flac::problem-file::missing-year',
  'Алиса/Энергия/01 Пачка.flac::problem-file::missing-year',
  'Ярослав/Альбом/01 Песня.flac::problem-file::missing-year',
  'Ａ Wide/Album/01 Track.flac::problem-file::missing-year',
  '\u{1d11e} Clef/Album/01 Track.flac::problem-file::missing-year',
];

function orderedFileItem(rowKey, extra = {}) {
  const filePath = rowKey.split('::')[0];
  return {
    row_key: rowKey,
    scope: 'file',
    path: filePath,
    filename: filePath.split('/').pop(),
    problem_reason: 'Missing year',
    ...extra,
  };
}

function seedServerOrderedRule(context, keys) {
  const items = keys.map((key) => orderedFileItem(key));
  context.state.utility.rules = [{
    ...emptyProblemIgnoreRule(),
    count: items.length,
    items,
    file_items: items,
  }];
}

function ruleFileKeys(context) {
  return Array.from(problemIgnoreRule(context).file_items, (item) => item.row_key);
}

test('queued, acknowledged and rolled-back rules take their server position without a reload', () => {
  const { context } = loadMutationHelpers();
  const existing = [SERVER_ORDERED_FILE_KEYS[1], SERVER_ORDERED_FILE_KEYS[6]];
  const added = SERVER_ORDERED_FILE_KEYS.filter((key) => !existing.includes(key));
  seedServerOrderedRule(context, existing);

  const operation = context.beginProblemExclusionMutation({
    kind: 'create',
    items: added.map((key) => orderedFileItem(key, { pending: true })),
    snapshot: { ruleItems: [] },
  });
  context.state.utility.rules = context.mergePendingProblemExclusionRules(context.state.utility.rules);
  assert.deepEqual(ruleFileKeys(context), SERVER_ORDERED_FILE_KEYS, 'queued rows');
  assert.deepEqual(
    Array.from(problemIgnoreRule(context).items, (item) => item.row_key),
    SERVER_ORDERED_FILE_KEYS,
  );

  context.settleProblemExclusionMutation(operation, added.map((key) => orderedFileItem(key)));
  assert.deepEqual(ruleFileKeys(context), SERVER_ORDERED_FILE_KEYS, 'acknowledged rows');

  const revert = context.beginProblemExclusionMutation({
    kind: 'revert',
    items: [orderedFileItem(SERVER_ORDERED_FILE_KEYS[0])],
    snapshot: { ruleItems: [orderedFileItem(SERVER_ORDERED_FILE_KEYS[0])] },
  });
  context.state.utility.rules = context.mergePendingProblemExclusionRules(context.state.utility.rules);
  assert.deepEqual(ruleFileKeys(context), SERVER_ORDERED_FILE_KEYS.slice(1), 'reverted row removed');
  context.rollbackProblemExclusionMutation(revert);
  assert.deepEqual(ruleFileKeys(context), SERVER_ORDERED_FILE_KEYS, 'rolled-back revert');
});

test('a Rules load merged with a queued rule keeps the server order', () => {
  const { context } = loadMutationHelpers();
  const pendingKey = SERVER_ORDERED_FILE_KEYS[4];
  context.beginProblemExclusionMutation({
    kind: 'create',
    items: [orderedFileItem(pendingKey, { pending: true })],
    snapshot: { ruleItems: [] },
  });
  const loaded = SERVER_ORDERED_FILE_KEYS.filter((key) => key !== pendingKey).map((key) => orderedFileItem(key));

  const merged = context.mergePendingProblemExclusionRules([{
    ...emptyProblemIgnoreRule(), count: loaded.length, items: loaded, file_items: loaded,
  }]);

  const rule = merged.find((item) => item.key === 'problem-ignores');
  assert.deepEqual(Array.from(rule.file_items, (item) => item.row_key), SERVER_ORDERED_FILE_KEYS);
  assert.equal(rule.file_items[4].pending, true);
});
