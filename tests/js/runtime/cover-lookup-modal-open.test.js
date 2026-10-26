const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'cover-lookup-modal-and-drawer.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

test('opening Cover Lookup starts one gallery request without loading notification history', async () => {
  class TestButton {
    constructor() {
      this.hidden = false;
      this.disabled = false;
    }
  }
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  const overlay = { hidden: true };
  const saveButton = new TestButton();
  let galleryRequestCount = 0;
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: { pastedImages: [] },
      },
    },
    HTMLButtonElement: TestButton,
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/gallery') {
        galleryRequestCount += 1;
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      body: {
        classList: { add: () => {} },
      },
      getElementById: (id) => ({
        'cover-lookup-modal': overlay,
        'cover-lookup-save-remote-button': saveButton,
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderCoverLookupModal = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.applyCoverLookupGalleryPayload = () => {};
  context.markCoverLookupAutomaticImprovementSeen = async () => {};

  const openPromise = context.openCoverLookupModal(album, { taskId: 'sola-scriptura-lookup' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(galleryRequestCount, 1);

  await openPromise;

  assert.equal(galleryRequestCount, 1);
});

test('notification Cover Lookup uses a sheet on mobile without presenting a mobile page', async () => {
  class TestButton {}
  const classes = new Set();
  const overlay = {
    hidden: true,
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
    },
    querySelector: () => null,
  };
  let mobilePagePresentations = 0;
  const context = {
    window: { innerWidth: 390 },
    state: { coverLookup: { tasks: [], modal: { pastedImages: [] } } },
    HTMLButtonElement: TestButton,
    URLSearchParams,
    console,
    buildTrackPathSignature: () => '',
    sanitizeCoverLookupPossibleMatches: () => [],
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById: id => (id === 'cover-lookup-modal' ? overlay : null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.presentMobileCoverLookupPage = () => { mobilePagePresentations += 1; };
  context.renderCoverLookupModal = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.refreshCoverLookupGallery = async () => {};

  await context.openCoverLookupModal({ name: 'Album' }, { mobileSheet: true });

  assert.equal(mobilePagePresentations, 0);
  assert.equal(classes.has('is-mobile-sheet'), true);
  context.closeCoverLookupModal();
  assert.equal(classes.has('is-mobile-sheet'), false);
});

test('ordinary mobile Cover Lookup keeps the existing mobile-page presentation', async () => {
  class TestButton {}
  const classes = new Set();
  const overlay = {
    hidden: true,
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
    },
    querySelector: () => null,
  };
  let mobilePagePresentations = 0;
  const context = {
    window: { innerWidth: 390 },
    state: { coverLookup: { tasks: [], modal: { pastedImages: [] } } },
    HTMLButtonElement: TestButton,
    URLSearchParams,
    console,
    buildTrackPathSignature: () => '',
    sanitizeCoverLookupPossibleMatches: () => [],
    document: {
      body: { classList: { add() {}, remove() {} } },
      getElementById: id => (id === 'cover-lookup-modal' ? overlay : null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.presentMobileCoverLookupPage = () => { mobilePagePresentations += 1; };
  context.renderCoverLookupModal = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.refreshCoverLookupGallery = async () => {};

  await context.openCoverLookupModal({ name: 'Album' });

  assert.equal(mobilePagePresentations, 1);
  assert.equal(classes.has('is-mobile-sheet'), false);
});

test('mobile sheet swipe dismisses only after a downward threshold', () => {
  const listeners = {};
  const properties = new Map();
  const header = {
    dataset: {},
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const overlay = {
    classList: { contains: value => value === 'is-mobile-sheet' },
    querySelector: () => header,
    style: {
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
    },
  };
  const context = { window: {}, document: { getElementById: () => null }, state: { coverLookup: { modal: {} } }, console };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  let closeCount = 0;
  context.closeCoverLookupModal = () => { closeCount += 1; };
  context.bindCoverLookupMobileSheetSwipe(overlay);

  const touch = (x, y) => ({ clientX: x, clientY: y });
  listeners.touchstart({ touches: [touch(20, 20)] });
  listeners.touchmove({ touches: [touch(22, 70)], preventDefault() {} });
  listeners.touchend();
  assert.equal(closeCount, 0);

  listeners.touchstart({ touches: [touch(20, 20)] });
  listeners.touchmove({ touches: [touch(22, 110)], preventDefault() {} });
  listeners.touchmove({ touches: [touch(140, 110)], preventDefault() {} });
  listeners.touchend();
  assert.equal(closeCount, 0);

  listeners.touchstart({ touches: [touch(20, 20)] });
  listeners.touchmove({ touches: [touch(22, 120)], preventDefault() {} });
  assert.equal(properties.get('--cover-lookup-sheet-drag-y'), '100px');
  listeners.touchend();
  assert.equal(closeCount, 1);
  assert.equal(properties.has('--cover-lookup-sheet-drag-y'), false);
});

test('opening a persisted notification renders usable cached art and loads unresolved candidates', async () => {
  class TestButton {
    constructor() {
      this.hidden = false;
      this.disabled = false;
    }
  }
  const album = {
    album_artist: 'Altın Gün',
    name: 'Garip',
    year: 2026,
  };
  const candidate = {
    id: 'youtube-candidate',
    source: 'youtube',
    url: 'https://images.example/youtube.jpg',
  };
  const task = {
    id: 'persisted-generation',
    status: 'completed',
    album_payload: album,
    possible_matches: [candidate],
    best_candidate_id: candidate.id,
  };
  const idOnlyTask = {
    ...task,
    id: 'id-only-generation',
    possible_match_count: 4,
    possible_matches: [{ id: 'candidate-without-preview' }],
    best_candidate_id: 'candidate-without-preview',
  };
  let resolveGallery;
  const galleryResponse = new Promise((resolve) => { resolveGallery = resolve; });
  const overlay = { hidden: true };
  const renderSnapshots = [];
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [task],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: { pastedImages: [] },
      },
    },
    HTMLButtonElement: TestButton,
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/gallery') return galleryResponse;
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      body: { classList: { add: () => {} } },
      getElementById: (id) => ({
        'cover-lookup-modal': overlay,
        'cover-lookup-save-remote-button': new TestButton(),
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderCoverLookupModal = () => {
    renderSnapshots.push({
      loading: context.state.coverLookup.modal.loading,
      candidates: [...context.state.coverLookup.modal.possibleMatches],
      expectedRemoteCount: context.state.coverLookup.modal.expectedRemoteCount,
    });
  };
  context.renderCoverLookupDrawer = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.applyCoverLookupGalleryPayload = () => {};
  context.markCoverLookupAutomaticImprovementSeen = async () => {};

  const openPromise = context.openCoverLookupModal(album, { taskId: task.id });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(renderSnapshots.some((snapshot) => (
    snapshot.loading === false
    && snapshot.candidates.some((item) => item.id === candidate.id)
  )));

  context.state.coverLookup.tasks = [idOnlyTask];
  const idOnlyOpenPromise = context.openCoverLookupModal(album, { taskId: idOnlyTask.id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renderSnapshots.at(-1).loading, true);
  assert.equal(renderSnapshots.at(-1).expectedRemoteCount, 4);

  resolveGallery({ ok: true, json: async () => ({ ok: true }) });
  await openPromise;
  await idOnlyOpenPromise;
});

test('starting lookup publishes visible feedback before the start request settles', async () => {
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  let resolveStart;
  const startResponse = new Promise((resolve) => { resolveStart = resolve; });
  const toastCalls = [];
  const renderSnapshots = [];
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: {
          album,
          manualBusy: false,
          statusText: '',
          pastedImages: [],
          selectedRemoteId: '',
          pendingPastedImageId: '',
        },
      },
    },
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: (...args) => toastCalls.push(args),
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/start') return startResponse;
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': { querySelector: () => null },
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.collectManualCoverLookupUrls = () => [];
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {
    renderSnapshots.push({
      manualBusy: context.state.coverLookup.modal.manualBusy,
      statusText: context.state.coverLookup.modal.statusText,
    });
  };

  const startPromise = context.startCoverLookupForAlbum(album);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(renderSnapshots.some((snapshot) => (
    snapshot.manualBusy === true && snapshot.statusText === 'Starting cover search…'
  )));
  assert.equal(toastCalls[0]?.[0], 'Starting cover search…');

  resolveStart({
    ok: true,
    json: async () => ({
      ok: true,
      task: { id: 'accepted-task', status: 'running', album_payload: album },
    }),
  });
  await startPromise;
});

test('accepted lookup renders running feedback before follow-up reads settle', async () => {
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  const acceptedTask = {
    id: 'sola-scriptura-lookup',
    status: 'running',
    progress: 5,
    progress_label: 'Searching providers...',
    album_payload: album,
  };
  let resolveTasksRequest;
  const tasksResponse = new Promise((resolve) => {
    resolveTasksRequest = resolve;
  });
  const toastCalls = [];
  const renderSnapshots = [];
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: {
          album,
          manualBusy: false,
          pastedImages: [],
          selectedRemoteId: '',
          pendingPastedImageId: '',
        },
      },
    },
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: (...args) => toastCalls.push(args),
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/start') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            task: acceptedTask,
            gallery: {
              local_covers: [],
              other_art: [],
              task: acceptedTask,
            },
          }),
        };
      }
      if (url === '/utilities/cover-lookup/tasks') {
        return tasksResponse;
      }
      if (url === '/utilities/cover-lookup/gallery') {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': { querySelector: () => null },
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.collectManualCoverLookupUrls = () => [];
  context.applyCoverLookupGalleryPayload = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {
    renderSnapshots.push({
      manualBusy: context.state.coverLookup.modal.manualBusy,
      taskId: context.state.coverLookup.modal.taskId,
      tasks: context.state.coverLookup.tasks.map((task) => ({
        id: task.id,
        status: task.status,
      })),
    });
  };
  context.stopCoverLookupPollingIfIdle = () => {};

  const startPromise = context.startCoverLookupForAlbum(album);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    toastCalls.map((call) => call[0]),
    ['Starting cover search…', 'Cover art lookup started.'],
  );
  const acceptedToast = toastCalls[1];
  assert.equal(acceptedToast[1], 'success');
  assert.equal(
    acceptedToast[2],
    5000,
    'the lookup-start notification must remain readable while the accepted task begins rendering',
  );
  assert.equal(acceptedToast[3]?.placement, 'top-center');
  assert.ok(renderSnapshots.some((snapshot) => (
    snapshot.manualBusy === false
    && snapshot.taskId === acceptedTask.id
    && snapshot.tasks.some((task) => task.id === acceptedTask.id && task.status === 'running')
  )));

  resolveTasksRequest({
    ok: true,
    json: async () => ({ ok: true, tasks: [acceptedTask] }),
  });
  await startPromise;
});

test('start response cannot hydrate a later Cover Lookup modal session', async () => {
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  let resolveStartRequest;
  const startResponse = new Promise((resolve) => { resolveStartRequest = resolve; });
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [],
        modal: { album, pastedImages: [], manualBusy: false },
      },
    },
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/start') return startResponse;
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': { querySelector: () => null },
      }[id] || null),
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.collectManualCoverLookupUrls = () => [];
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {};
  let appliedGalleries = 0;
  context.applyCoverLookupGalleryPayload = () => { appliedGalleries += 1; };

  const pending = context.startCoverLookupForAlbum(album);
  vm.runInContext('coverLookupModalSession += 1', context);
  resolveStartRequest({
    ok: true,
    json: async () => ({
      ok: true,
      task: { id: 'stale-lookup', status: 'running', album_payload: album },
      gallery: { local_covers: [], other_art: [] },
    }),
  });
  await pending;

  assert.equal(appliedGalleries, 0);
});

test('background lookup marks its trigger busy before the start request settles', async () => {
  const album = {
    album_artist: 'Neal Morse',
    name: 'Sola Scriptura',
    year: 2007,
  };
  let resolveStartRequest;
  const startResponse = new Promise((resolve) => {
    resolveStartRequest = resolve;
  });
  const attributes = new Map();
  const triggerButton = {
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const context = {
    window: {},
    state: {
      coverLookup: {
        tasks: [],
        tasksSnapshot: '',
        appliedTaskUpdateSignatures: {},
        modal: { pastedImages: [] },
      },
    },
    URLSearchParams,
    console,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/start') return startResponse;
      if (url === '/utilities/cover-lookup/tasks') {
        return { ok: true, json: async () => ({ ok: true, tasks: [] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    document: {
      getElementById: () => null,
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.renderCoverLookupDrawer = () => {};
  context.ensureCoverLookupPolling = () => {};
  let taskReloads = 0;
  let taskReloadOptions = null;
  context.loadCoverLookupTasks = async (options) => {
    taskReloads += 1;
    taskReloadOptions = options;
  };

  const startPromise = context.startCoverLookupForAlbum(album, {
    backgroundOnly: true,
    triggerButton,
  });

  assert.equal(triggerButton.disabled, true);
  assert.equal(attributes.get('aria-busy'), 'true');

  resolveStartRequest({
    ok: true,
    json: async () => ({
      ok: true,
      task: {
        id: 'sola-scriptura-lookup',
        status: 'running',
        album_payload: album,
      },
    }),
  });
  await startPromise;

  assert.equal(triggerButton.disabled, false);
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(taskReloads, 1, 'background lookup keeps its immediate status refresh');
  assert.equal(
    taskReloadOptions?.mergeFirstPage,
    true,
    'the status refresh must retain the accepted task until persistence catches up',
  );
});


test('gallery responses cannot overwrite another album or a newer gallery request', async () => {
  const requests = [], applied = [];
  const context = vm.createContext({
    document: { getElementById: () => null },
    state: { coverLookup: { modal: { album: { key: 'first' } } } }, console,
    fetch: () => new Promise(resolve => requests.push(resolve)),
    showToast: () => { throw new Error('Stale requests must not notify'); },
  });
  vm.runInContext(helperSource, context);
  context.renderCoverLookupModal = () => {};
  context.applyCoverLookupGalleryPayload = data => applied.push(data.id);
  context.markCoverLookupAutomaticImprovementSeen = () => new Promise(() => {});
  const first = context.refreshCoverLookupGallery();
  context.state.coverLookup.modal.album = { key: 'second' };
  const second = context.refreshCoverLookupGallery();
  requests[1]({ ok: true, json: async () => ({ ok: true, id: 'second' }) });
  await second;
  assert.equal(context.state.coverLookup.modal.loading, false, 'mark-seen must not delay gallery display');
  requests[0]({ ok: true, json: async () => ({ ok: true, id: 'first' }) });
  await first;
  assert.deepEqual(applied, ['second']);
  const older = context.refreshCoverLookupGallery();
  const newer = context.refreshCoverLookupGallery();
  requests[3]({ ok: true, json: async () => ({ ok: true, id: 'newer' }) });
  await newer;
  requests[2]({ ok: true, json: async () => ({ ok: true, id: 'older' }) });
  await older;
  assert.deepEqual(applied, ['second', 'newer']);
});

function loadCapabilityCoverRoute(actions, { initial = false, parent = false } = {}) {
  const effects = [];
  const album = { key: 'one', name: 'Album', album_artist: 'Artist' };
  const overlay = { hidden: true };
  const descriptor = { kind: 'cover-lookup', albumKey: 'one', title: 'Album' };
  const parentPage = { kind: 'album', albumKey: 'one', title: 'Album' };
  const location = { href: 'https://example.test/?surface=albums&mobile_page=cover-lookup&mobile_album=one' };
  const history = {
    state: { mobilePages: parent ? [parentPage, descriptor] : [descriptor], albumHavenNavigationPosition: 3 },
    replaceState(value, _title, url) { this.state = value; location.href = String(url); effects.push('history'); },
    pushState() { assert.fail('restoration must not push a new history entry'); },
  };
  const document = {
    readyState: 'loading', addEventListener() {}, createComment: () => ({}),
    documentElement: { dataset: {}, style: { setProperty() {} } },
    body: { classList: { add: () => effects.push('body'), remove() {} } },
    getElementById: id => ({
      'mobile-navigation': {}, 'cover-lookup-modal': overlay,
      'capability-bootstrap': { textContent: JSON.stringify({ allowed_actions: actions,
        denied_selectors: ['#cover-lookup-modal'] }) },
    }[id] || null),
  };
  const context = vm.createContext({
    window: { document, innerWidth: 390, location, history, addEventListener() {},
      matchMedia: () => ({ addEventListener() {} }) },
    document, URL, console, HTMLButtonElement: class {},
    state: { utility: { activeTab: 'appearance' }, coverLookup: { tasks: [], modal: { pastedImages: [], retained: true } } },
    getIndexedAlbum: () => album, buildTrackPathSignature: () => 'one',
  });
  if (actions !== undefined) vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/capability-ui.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/mobile-navigation.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.promoteVisibleMobileDialogs = () => {};
  context.syncMobilePageShell = () => {};
  context.presentMobileCoverLookupPage = () => {
    effects.push('present');
    vm.runInContext("mobilePageState.pages.push({ kind: 'cover-lookup', albumKey: 'one' })", context);
  };
  context.renderCoverLookupModal = () => effects.push('render');
  context.ensureCoverLookupPolling = () => effects.push('poll');
  context.loadCoverLookupTasks = async () => effects.push('tasks');
  context.refreshCoverLookupGallery = async () => effects.push('gallery');
  if (parent) vm.runInContext("mobilePageState.pages.push({ kind: 'album', albumKey: 'one', title: 'Album' })", context);
  const restore = () => initial ? context.initMobileNavigation() : context.handleMobilePagePopState();
  return { context, effects, overlay, history, location, restore };
}

for (const initial of [true, false]) {
  test(`denied Cover Lookup ${initial ? 'initial URL' : 'history child'} preserves parent without page, session, polling or request effects`, async () => {
    const f = loadCapabilityCoverRoute({ 'library.covers.lookup': false }, { initial, parent: !initial });
    const before = JSON.stringify(f.context.state.coverLookup);
    const session = vm.runInContext('coverLookupModalSession', f.context);
    f.restore();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, ['history']);
    assert.equal(JSON.stringify(f.context.state.coverLookup), before);
    assert.equal(vm.runInContext('coverLookupModalSession', f.context), session);
    assert.equal(f.overlay.hidden, true);
    assert.deepEqual(Array.from(f.history.state.mobilePages, page => page.kind), initial ? [] : ['album']);
    const url = new URL(f.location.href);
    assert.equal(url.searchParams.get('mobile_page'), initial ? null : 'album');
    assert.equal(url.searchParams.get('surface'), 'albums');
    assert.equal(f.history.state.albumHavenNavigationPosition, 3);
  });
}

for (const actions of [{ 'library.covers.lookup': true }, undefined]) {
  test(`allowed Cover Lookup restoration opens its page and starts existing loaders (${actions ? 'granted' : 'legacy'})`, async () => {
    const f = loadCapabilityCoverRoute(actions, { initial: true });
    f.restore();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, ['present', 'body', 'render', 'poll', 'gallery', 'history']);
    assert.equal(f.overlay.hidden, false);
    assert.equal(f.context.state.coverLookup.modal.album.key, 'one');
    assert.equal(vm.runInContext('coverLookupModalSession', f.context), 1);
    assert.deepEqual(Array.from(f.history.state.mobilePages, page => page.kind), ['cover-lookup']);
    assert.equal(new URL(f.location.href).searchParams.get('mobile_page'), 'cover-lookup');
  });
}
