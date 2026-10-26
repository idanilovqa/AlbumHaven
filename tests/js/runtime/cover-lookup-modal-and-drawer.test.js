const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

function loadHelper(overrides = {}) {
  const context = {
    document: { getElementById: () => null },
    window: {},
    ButtonComponent: require(path.join(__dirname, '../../../music_app/static/js/button-component.js')),
    state: {
      coverLookup: {
        modal: {
          pastedImages: [],
          localCovers: [],
          otherArt: [],
          album: null,
        },
      },
    },
    URLSearchParams,
    console,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'alert-components.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

for (const [source, label] of [['apple', 'Apple Music'], ['cover_art_archive', 'Cover Art Archive'], ['spotify', 'SPOTIFY']]) {
  require('node:test')(`remote ${source} cover cards separate semantic labels from decorative badges`, () => {
    const context = loadHelper({ escapeHtml: value => String(value ?? '') });
    const markup = context.buildCoverLookupCard({ id: source, source, album: 'Provider fixture' }, 'remote');
    const labelMatch = markup.match(/<span class="cover-lookup-art-source">([^]*?)<\/span>/);
    assert.ok(labelMatch);
    assert.equal(labelMatch[1], label);
    assert.match(markup, /<span class="cover-lookup-art-source-badge [^"]+" aria-hidden="true">/);
    assert.doesNotMatch(labelMatch[1], /<|>/);
    const saved = context.buildCoverLookupCard({ id: source, source, album: 'Provider fixture' }, 'saved-remote');
    assert.equal(saved.match(/<span class="cover-lookup-art-source">([^]*?)<\/span>/)[1], label);
    assert.match(saved, /data-cover-lookup-saved-remote="1"/);
    assert.match(saved, /data-cover-lookup-item-key="saved-remote:/);
  });
}

require('node:test')('completed lookup counts covers while retaining every other artwork alternative', () => {
  const { context, bodyElement } = createDrawerHarness();
  const covers = [{ id: 'cover-default' }, ...['one', 'two', 'three'].map(id => ({ id, art_kind: 'cover' }))];
  const alternatives = ['booklet', 'back', 'disc'].map(art_kind => ({ id: art_kind, art_kind }));
  const matches = [...covers, ...alternatives];
  const before = JSON.stringify(matches);
  context.state.coverLookup.tasks = [{
    id: 'mixed-artwork', status: 'completed', artist: 'Artist', album: 'Album', possible_matches: matches,
  }];
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />4 covers found</);
  assert.doesNotMatch(bodyElement.innerHTML, />7 covers found</);
  assert.equal(JSON.stringify(matches), before);
  assert.strictEqual(context.state.coverLookup.tasks[0].possible_matches, matches);
  for (const alternative of alternatives) {
    assert.match(context.buildCoverLookupCard(alternative, 'remote'), /data-cover-lookup-other-remote-art="1"/);
  }
});

require('node:test')('notification thumbnails defer loading and decoding', () => {
  const { context, bodyElement } = createDrawerHarness({
    buildAlbumDisplayCoverUrl: () => '/images/notification-cover.jpg',
  });
  context.state.coverLookup.tasks = [{
    id: 'thumbnail-task', status: 'completed', artist: 'Artist', album: 'Album',
    current_user_cover_preview_url: '/images/notification-cover.jpg',
  }];

  context.renderCoverLookupDrawer();

  assert.match(
    bodyElement.innerHTML,
    /class="cover-lookup-task-cover"[^>]*loading="lazy"[^>]*decoding="async"/,
  );
});

require('node:test')('notification thumbnails prefer the current user cover over stale lookup artwork', () => {
  const { context, bodyElement } = createDrawerHarness({
    buildAlbumDisplayCoverUrl: () => '/images/stale-lookup-cover.jpg',
  });
  context.state.coverLookup.tasks = [{
    id: 'angels-task',
    status: 'completed',
    artist: 'Чёрный Обелиск',
    album: 'Ангелы',
    album_payload: { cover_preview_url: '/images/stale-lookup-cover.jpg' },
    current_user_cover_preview_url: '/cover?album=angels&v=user-selection',
    best_candidate_preview_url: 'https://images.example/angels-candidate.jpg',
  }];

  context.renderCoverLookupDrawer();

  assert.match(bodyElement.innerHTML, /src="\/cover\?album=angels&v=user-selection"/);
  assert.doesNotMatch(bodyElement.innerHTML, /stale-lookup-cover|angels-candidate/);
});

require('node:test')('notification thumbnails show the best candidate when no user cover exists', () => {
  const { context, bodyElement } = createDrawerHarness({
    buildAlbumDisplayCoverUrl: () => '/images/automatic-or-stale-cover.jpg',
  });
  context.state.coverLookup.tasks = [{
    id: 'revelations-task',
    status: 'completed',
    artist: 'Susanne Sundfør',
    album: 'Revelations of Divine Love',
    album_payload: { cover_preview_url: '/images/automatic-or-stale-cover.jpg' },
    best_candidate_id: 'revelations-best',
    best_candidate_preview_url: 'https://images.example/revelations-best.jpg',
  }];

  context.renderCoverLookupDrawer();

  assert.match(
    bodyElement.innerHTML,
    /src="\/utilities\/cover-lookup\/remote-image\?url=https%3A%2F%2Fimages.example%2Frevelations-best.jpg&key=revelations-best"/,
  );
  assert.doesNotMatch(bodyElement.innerHTML, /automatic-or-stale-cover|is-placeholder/);
});

require('node:test')('cover updates preserve unrelated pathless notification artwork', () => {
  const selectedAlbum = {
    album_id: 41,
    id: 'shared-legacy-id',
    key: 'black-obelisk::angels::2005',
    album_artist: 'Чёрный Обелиск',
    name: 'Ангелы',
  };
  const unrelatedAlbum = {
    key: 'altin-gun::garip::2026',
    album_artist: 'Altın Gün',
    name: 'Garip',
    cover_path: 'C:/music/Altin Gun/Garip/cover.jpg',
  };
  const secondUnrelatedAlbum = {
    key: 'susanne-sundfor::revelations::2026',
    album_artist: 'Susanne Sundfør',
    name: 'Revelations of Divine Love',
    cover_path: 'C:/music/Susanne Sundfor/Revelations/cover.jpg',
  };
  const updatedSelectedAlbum = {
    ...selectedAlbum,
    cover_path: 'C:/music/Black Obelisk/Angels/cover.jpg',
  };
  const conflictingLegacyIdAlbum = {
    album_id: 999,
    id: selectedAlbum.id,
    key: 'unrelated::album::2026',
    cover_path: 'C:/music/Unrelated/cover.jpg',
  };
  const context = loadHelper({ persistCoverLookupNotificationTasks: () => {} });
  context.state.coverLookup.modal = { album: selectedAlbum };
  context.state.coverLookup.tasks = [
    { id: 'angels-task', album_payload: selectedAlbum },
    { id: 'garip-task', album_payload: unrelatedAlbum },
    { id: 'revelations-task', album_payload: secondUnrelatedAlbum },
  ];

  context.syncCoverLookupAlbumReferences([conflictingLegacyIdAlbum, updatedSelectedAlbum]);

  assert.strictEqual(context.state.coverLookup.modal.album, updatedSelectedAlbum);
  assert.strictEqual(context.state.coverLookup.tasks[0].album_payload, updatedSelectedAlbum);
  assert.strictEqual(
    context.state.coverLookup.tasks[1].album_payload,
    unrelatedAlbum,
    'an album without track paths must not match every other pathless notification',
  );
  assert.strictEqual(
    context.state.coverLookup.tasks[2].album_payload,
    secondUnrelatedAlbum,
    'each unrelated pathless notification must retain its own album and artwork',
  );
});

require('node:test')('cover lookup hover icon loads only when requested', () => {
  const hoverIcon = { dataset: { src: '/static/images/cover-lookup-notification-icon.png' }, src: '' };
  const listeners = {};
  const button = {
    addEventListener: (name, callback) => { listeners[name] = callback; },
    querySelector: () => hoverIcon,
  };
  loadHelper({ document: { getElementById: () => button } });

  assert.deepEqual(Object.keys(listeners).sort(), ['focus', 'mouseenter']);
  listeners.mouseenter();

  assert.equal(hoverIcon.src, '/static/images/cover-lookup-notification-icon.png');
  assert.equal('src' in hoverIcon.dataset, false);
});

require('node:test')('interrupted notification stops looking active and remains retryable', () => {
  const { context, bodyElement } = createDrawerHarness();
  context.state.coverLookup.tasks = [{
    id: 'interrupted-task',
    status: 'failed',
    result_kind: 'interrupted',
    artist: 'Perelandra',
    album: 'Eden',
    album_payload: { key: 'perelandra::eden' },
  }];

  context.renderCoverLookupDrawer();

  assert.match(bodyElement.innerHTML, />Lookup interrupted</);
  assert.match(bodyElement.innerHTML, /data-retry-cover-lookup-task="interrupted-task"/);
  assert.doesNotMatch(bodyElement.innerHTML, /data-cancel-cover-lookup-task=/);
});

require('node:test')('polling preserves a pressed task before selection exists and resumes after release', () => {
  const { context, bodyElement } = createDrawerHarness();
  const task = { id: 'pressed-task', status: 'running', artist: 'Artist', album: 'Album' };
  context.state.coverLookup.tasks = [task];
  context.renderCoverLookupDrawer();
  const before = bodyElement.innerHTML;
  const pressedTask = {};
  let pressed = true;
  bodyElement.contains = node => node === pressedTask;
  bodyElement.querySelector = selector => selector === '.cover-lookup-task-open:active' && pressed ? pressedTask : null;
  context.window.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
  task.status = 'completed';
  context.renderCoverLookupDrawer();
  assert.equal(bodyElement.innerHTML, before, 'Polling must not replace the pending text-selection anchor');
  pressed = false;
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />covers found</, 'Polling resumes when the press ends without a selection');

  pressed = true;
  context.state.coverLookup.tasks = [];
  context.renderCoverLookupDrawer({ preserveInteraction: false });
  assert.match(bodyElement.innerHTML, /not looking for anything at the moment/i,
    'Explicit user removal must not be blocked by interaction preservation');
});

require('node:test')('closed drawer releases cards and renders terminal task state when reopened', () => {
  const { context, bodyElement } = createDrawerHarness();
  const task = { id: 'saved-task', status: 'running', artist: 'Artist', album: 'Album' };
  context.state.coverLookup.tasks = [task];
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />Searching</);

  context.state.coverLookup.drawerOpen = false;
  context.hasActiveCoverLookupDrawerAction = () => true;
  task.status = 'completed';
  task.result_kind = 'cover-updated';
  task.notification_action_taken = true;
  context.renderCoverLookupDrawer();

  assert.equal(bodyElement.innerHTML, '');
  context.state.coverLookup.drawerOpen = true;
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />Art chosen</);
});

require('node:test')('accepted remote save keeps its finished card in place without looking like another search', () => {
  const { context, bodyElement } = createDrawerHarness();
  const before = [
    { id: 'newer-finished', status: 'completed', artist: 'Artist', album: 'Newer' },
    { id: 'garip', status: 'completed', artist: 'Altın Gün', album: 'Garip', result_kind: 'matches-found' },
    { id: 'older-finished', status: 'completed', artist: 'Artist', album: 'Older' },
  ];
  context.state.coverLookup.tasks = before;

  const merged = context.mergeCoverLookupTaskSummaries([{
    ...before[1],
    status: 'running',
    progress: 92,
    progress_label: 'Saving selected cover art...',
    job_kind: 'save_remote_selection',
  }], 'active');
  context.state.coverLookup.tasks = merged;
  context.state.coverLookup.notificationCounts = {
    total_count: 3,
    active_count: 0,
    finished_count: 3,
  };
  context.renderCoverLookupDrawer();

  assert.deepEqual(Array.from(merged, (task) => task.id), before.map((task) => task.id));
  assert.match(bodyElement.innerHTML, /Garip[\s\S]*>Saving art…</);
  assert.doesNotMatch(bodyElement.innerHTML, /Garip[\s\S]*>Searching</);
  assert.doesNotMatch(bodyElement.innerHTML, /data-cancel-cover-lookup-task="garip"/);
  assert.equal(context.document.getElementById('cover-lookup-drawer-summary').textContent, '3 finished');
});

for (const interaction of ['focus', 'hover']) {
  const { context, bodyElement } = createDrawerHarness();
  const task = { id: 'cancel-transition', status: 'running', artist: 'Artist', album: 'Album' };
  context.state.coverLookup.tasks = [task];
  context.renderCoverLookupDrawer();
  const cancelButton = {
    closest: (selector) => selector === '.cover-lookup-task-actions' ? {} : cancelButton,
    getAttribute: () => task.id,
  };
  bodyElement.contains = (element) => element === cancelButton;
  bodyElement.querySelector = selector => selector === '.cover-lookup-task-actions :hover' && interaction === 'hover' ? cancelButton : null;
  context.document.activeElement = interaction === 'focus' ? cancelButton : null;
  const runningMarkup = bodyElement.innerHTML;
  task.cancel_requested = true;
  context.renderCoverLookupDrawer();
  assert.equal(bodyElement.innerHTML, runningMarkup, `${interaction}: preserve a still-running Cancel action`);

  task.status = 'canceled';
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />Canceled</, `${interaction}: terminal poll must retire the stale Cancel action`);
  assert.doesNotMatch(bodyElement.innerHTML, /data-cancel-cover-lookup-task=/);
}

require('node:test')('a hovered running task does not hide another task terminal publication', () => {
  const { context, bodyElement } = createDrawerHarness();
  const savedTask = {
    id: 'saved-task', status: 'running', artist: 'Saved Artist', album: 'Saved Album',
  };
  const activeTask = {
    id: 'active-task', status: 'running', artist: 'Active Artist', album: 'Active Album',
  };
  context.state.coverLookup.tasks = [savedTask, activeTask];
  context.renderCoverLookupDrawer();

  const activeCancelButton = {
    closest: (selector) => selector === '.cover-lookup-task-actions' ? {} : activeCancelButton,
    getAttribute: () => activeTask.id,
  };
  bodyElement.contains = (element) => element === activeCancelButton;
  bodyElement.querySelector = selector => (
    selector === '.cover-lookup-task-actions :hover' ? activeCancelButton : null
  );

  savedTask.status = 'completed';
  savedTask.result_kind = 'cover-updated';
  savedTask.notification_action_taken = true;
  context.renderCoverLookupDrawer();

  assert.match(
    bodyElement.innerHTML,
    /Saved Album[\s\S]*>Art chosen</,
    'an unrelated running Cancel action must not freeze a completed save notification',
  );
});

{
  const { context, bodyElement } = createDrawerHarness();
  const task = { id: 'selected-transition', status: 'running', artist: 'Artist', album: 'Album' };
  context.state.coverLookup.tasks = [task];
  context.renderCoverLookupDrawer();
  const selectedMarkup = bodyElement.innerHTML;
  const selectedNode = {};
  bodyElement.contains = (node) => node === selectedNode;
  context.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: selectedNode, focusNode: selectedNode });
  task.status = 'canceled';
  context.renderCoverLookupDrawer();
  assert.equal(bodyElement.innerHTML, selectedMarkup, 'terminal polling must preserve an independent text selection');
  context.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  context.renderCoverLookupDrawer();
  assert.match(bodyElement.innerHTML, />Canceled</);
}

{
  const staleCancel = {
    closest: (selector) => selector === '.cover-lookup-task-actions' ? {} : staleCancel,
    getAttribute: () => 'finished-task',
  };
  const context = loadHelper({ document: { activeElement: staleCancel } });
  context.state.coverLookup.tasks = [{ id: 'finished-task', status: 'canceled' }];
  for (const actionAttribute of ['data-retry-cover-lookup-task', 'data-clear-cover-lookup-task']) {
    const hoveredAction = { closest: (selector) => selector === `[${actionAttribute}]` ? hoveredAction : null };
    const body = { contains: () => true, querySelector: selector => selector === '.cover-lookup-task-actions :hover' ? hoveredAction : null };
    assert.equal(context.hasActiveCoverLookupDrawerAction(body), true,
      `a stale focused Cancel must not override hovered ${actionAttribute}`);
  }
}

{
  const hoveredAction = {};
  const focusedAction = { closest: (selector) => selector === '.cover-lookup-task-actions' ? {} : null };
  const context = loadHelper({ document: { activeElement: null } });
  const body = {
    contains: () => false,
    querySelector: (selector) => (
      selector === '.cover-lookup-task-actions :hover' ? hoveredAction : null
    ),
  };

  assert.equal(context.hasActiveCoverLookupDrawerAction(body), true);

  context.document.activeElement = focusedAction;
  body.contains = (element) => element === focusedAction;
  body.querySelector = () => null;
  assert.equal(context.hasActiveCoverLookupDrawerAction(body), true);
}

function createDrawerHarness(overrides = {}) {
  const drawerClasses = new Set();
  const drawerElement = {
    hidden: false,
    classList: { contains: name => drawerClasses.has(name),
      toggle: (name, enabled) => enabled ? drawerClasses.add(name) : drawerClasses.delete(name) },
  };
  const bodyElement = { innerHTML: '' };
  const badgeElement = { hidden: false, textContent: '' };
  const summaryElement = { textContent: '' };
  const buttonClasses = new Set();
  const buttonElement = {
    classList: {
      toggle: (name, enabled) => enabled ? buttonClasses.add(name) : buttonClasses.delete(name),
      contains: (name) => buttonClasses.has(name),
    },
  };
  const clearElement = {
    hidden: false,
    disabled: false,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
  const modalElement = { hidden: true };
  const intervalCalls = [];
  const clearedIntervals = [];
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    formatCoverLookupTaskElapsedLabel: () => 'Elapsed 1s',
    window: {
      setInterval(callback, delay) {
        intervalCalls.push({ callback, delay });
        return intervalCalls.length;
      },
      clearInterval(timerId) {
        clearedIntervals.push(timerId);
      },
    },
    document: {
      getElementById: (id) => ({
        'cover-lookup-drawer': drawerElement,
        'cover-lookup-drawer-body': bodyElement,
        'cover-lookup-drawer-badge': badgeElement,
        'cover-lookup-drawer-summary': summaryElement,
        'cover-lookup-drawer-button': buttonElement,
        'cover-lookup-drawer-clear': clearElement,
        'cover-lookup-modal': modalElement,
      }[id] || null),
      querySelectorAll: () => [],
    },
    ...overrides,
  });
  context.state.coverLookup.drawerOpen = true;
  context.state.coverLookup.modal = { taskId: '' };
  context.state.coverLookup.tasksHydrated = true;
  context.state.coverLookup.tasksLoadFailed = false;
  context.state.coverLookup.pollingTimer = 0;
  context.state.coverLookup.elapsedTimer = 0;
  return {
    context,
    bodyElement,
    badgeElement,
    clearElement,
    intervalCalls,
    clearedIntervals,
  };
}

;(async () => {
  const task = {
    id: 'stable-task',
    status: 'running',
    artist: 'Artist',
    album: 'Album',
    progress: 25,
    possible_matches: [{ id: 'candidate-1', art_kind: 'cover' }],
  };
  const { context } = createDrawerHarness({
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, tasks: [task] }) }),
  });
  let drawerRenderCount = 0;
  context.renderCoverLookupDrawer = () => {
    drawerRenderCount += 1;
  };

  await context.loadCoverLookupTasks({ toast: false });
  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(drawerRenderCount, 1, 'an unchanged poll must not rebuild the notification drawer');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

require('node:test')('pasted cover updates its notification before the save response settles', async () => {
  const album = {
    key: 'various artists::aladdin',
    album_artist: 'Various Artists',
    name: 'Aladdin',
    tracks: [{ path: 'C:/Music/Aladdin/01.mp3' }],
  };
  const markCalls = [];
  const lifecycleCalls = [];
  let resolveRequest;
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    getAlbumPathSignature: (value) => (value?.tracks || []).map((track) => track.path).join('::'),
    showToast: () => {},
  });
  context.state.coverLookup.optimisticAlbumCovers = {};
  context.state.coverLookup.tasks = [{
    id: 'aladdin-task',
    status: 'completed',
    notification_action_taken: false,
  }];
  context.state.coverLookup.modal = {
    album,
    taskId: 'aladdin-task',
    pastedImages: [{
      id: 'third-cover',
      data_url: 'data:image/jpeg;base64,third-cover',
      mime_type: 'image/jpeg',
      filename: 'third-cover.jpg',
    }],
  };
  context.markAlbumCoverPathsFresh = () => {};
  context.syncCoverLookupAlbumReferences = () => {};
  context.refreshCoverLookupAlbumArtwork = () => {};
  context.clearOptimisticAlbumCovers = () => {};
  context.closeCoverLookupModal = () => lifecycleCalls.push('close');
  context.renderCoverLookupDrawer = () => lifecycleCalls.push('render');
  context.markCoverLookupTaskActionTaken = (taskId, selectedAlbum, options) => {
    markCalls.push({ taskId, selectedAlbum, options });
    const task = context.state.coverLookup.tasks.find((item) => item.id === taskId);
    if (task) task.notification_action_taken = true;
  };
  context.fetch = () => new Promise((resolve) => {
    resolveRequest = resolve;
  });

  const savePromise = context.savePastedCoverFromLookup('third-cover');
  await Promise.resolve();

  assert.equal(markCalls.length, 1);
  assert.equal(markCalls[0].taskId, 'aladdin-task');
  assert.equal(markCalls[0].selectedAlbum.name, 'Aladdin');
  assert.equal(markCalls[0].options.persist, false);
  assert.deepEqual(lifecycleCalls, ['render', 'close']);

  resolveRequest({
    ok: false,
    json: async () => ({ ok: false, error: 'save failed' }),
  });
  await savePromise;
  assert.equal(context.state.coverLookup.tasks[0].notification_action_taken, false);
  assert.deepEqual(lifecycleCalls, ['render', 'close', 'render']);
});

require('node:test')('notification startup loads authoritative counts without loading history', async () => {
  const requestedUrls = [];
  const { context, badgeElement } = createDrawerHarness({
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          total_count: 528,
          active_count: 2,
          finished_count: 526,
        }),
      };
    },
  });
  context.state.coverLookup.drawerOpen = false;

  await context.loadCoverLookupNotificationCounts({ toast: false });

  assert.deepEqual(requestedUrls, ['/utilities/cover-lookup/tasks/counts']);
  assert.equal(context.state.coverLookup.notificationCounts.total_count, 528);
  assert.equal(badgeElement.textContent, '528');
  assert.deepEqual(context.state.coverLookup.tasks || [], []);
});

require('node:test')('open drawer shows a loading card until the first history response succeeds', async () => {
  let resolveRequest;
  const { context, bodyElement } = createDrawerHarness({
    fetch: () => new Promise((resolve) => {
      resolveRequest = () => resolve({
        ok: true,
        json: async () => ({ ok: true, tasks: [], total_count: 0, active_count: 0, finished_count: 0 }),
      });
    }),
  });
  context.state.coverLookup.tasksHydrated = false;

  const request = context.loadCoverLookupTasks({ toast: false });

  assert.match(bodyElement.innerHTML, /cover-lookup-task-card is-loading/);
  assert.match(bodyElement.innerHTML, /Loading notifications/);
  assert.doesNotMatch(bodyElement.innerHTML, /not looking for anything/i);

  resolveRequest();
  await request;

  assert.equal(context.state.coverLookup.tasksHydrated, true);
  assert.equal(context.state.coverLookup.tasksLoadFailed, false);
  assert.match(bodyElement.innerHTML, /not looking for anything/i);
});

require('node:test')('first history response clears loading after an unchanged active poll wins the race', async () => {
  let resolveActiveRequest;
  let resolveHistoryRequest;
  const response = () => ({
    ok: true,
    json: async () => ({ ok: true, tasks: [], total_count: 0, active_count: 0, finished_count: 0 }),
  });
  const { context, bodyElement } = createDrawerHarness({
    fetch: (url) => new Promise((resolve) => {
      if (String(url).includes('active_only=true')) resolveActiveRequest = () => resolve(response());
      else resolveHistoryRequest = () => resolve(response());
    }),
  });
  context.state.coverLookup.tasksHydrated = false;

  const historyRequest = context.loadCoverLookupTasks({ toast: false, mergeFirstPage: true });
  const activeRequest = context.loadCoverLookupTasks({ toast: false, activeOnly: true });
  resolveActiveRequest();
  await activeRequest;
  resolveHistoryRequest();
  await historyRequest;

  assert.equal(context.state.coverLookup.tasksHydrated, true);
  assert.doesNotMatch(bodyElement.innerHTML, /Loading notifications/);
  assert.match(bodyElement.innerHTML, /not looking for anything/i);
});

require('node:test')('failed first history request replaces loading card with a readable error', async () => {
  const { context, bodyElement } = createDrawerHarness({
    fetch: async () => { throw new Error('network unavailable'); },
  });
  context.state.coverLookup.tasksHydrated = false;

  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(context.state.coverLookup.tasksHydrated, false);
  assert.equal(context.state.coverLookup.tasksLoadFailed, true);
  assert.match(bodyElement.innerHTML, /Could not load notifications/);
  assert.doesNotMatch(bodyElement.innerHTML, /not looking for anything/i);
});

require('node:test')('stale notification counts cannot hide a locally accepted lookup', () => {
  const { context, badgeElement } = createDrawerHarness();
  const buttonElement = context.document.getElementById('cover-lookup-drawer-button');
  context.state.coverLookup.notificationCounts = {
    total_count: 0,
    active_count: 0,
    finished_count: 0,
  };
  context.state.coverLookup.tasks = [{ id: 'accepted-task', status: 'pending' }];

  context.renderCoverLookupDrawer();

  assert.equal(badgeElement.textContent, '1');
  assert.equal(badgeElement.hidden, false);
  assert.equal(buttonElement.classList.contains('has-active-lookups'), true);
});

require('node:test')('drawer page loads 50 summaries and retains its next cursor', async () => {
  const requestedUrls = [];
  const { context } = createDrawerHarness({
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [{ id: 'newest', status: 'completed' }],
          next_cursor: 'page-two',
          total_count: 528,
          active_count: 0,
          finished_count: 528,
        }),
      };
    },
  });

  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(requestedUrls[0], '/utilities/cover-lookup/tasks?limit=50');
  assert.equal(context.state.coverLookup.tasks[0].id, 'newest');
  assert.equal(context.state.coverLookup.tasksNextCursor, 'page-two');
});

require('node:test')('first-page refresh retains its next cursor for drawer pagination', async () => {
  const { context } = createDrawerHarness({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{ id: 'newest', status: 'completed' }],
        next_cursor: 'page-two',
        total_count: 528,
        active_count: 0,
        finished_count: 528,
      }),
    }),
  });

  await context.loadCoverLookupTasks({ toast: false, mergeFirstPage: true });

  assert.equal(context.state.coverLookup.tasksNextCursor, 'page-two');
});

require('node:test')('active-only polling merges updates without replacing loaded history', async () => {
  const requestedUrls = [];
  const { context } = createDrawerHarness({
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [{ id: 'active', status: 'running', progress: 25 }],
          next_cursor: null,
          total_count: 2,
          active_count: 1,
          finished_count: 1,
        }),
      };
    },
  });
  context.state.coverLookup.tasks = [{ id: 'history', status: 'completed' }];

  await context.loadCoverLookupTasks({ toast: false, activeOnly: true });

  assert.equal(requestedUrls[0], '/utilities/cover-lookup/tasks?limit=50&active_only=true');
  assert.deepEqual(
    Array.from(context.state.coverLookup.tasks, task => task.id),
    ['active', 'history'],
  );
});

require('node:test')('active-only polling refreshes the modal when partial candidates advance', async () => {
  let galleryRefreshes = 0;
  let pollCount = 0;
  const { context } = createDrawerHarness({
    fetch: async () => {
      pollCount += 1;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [{
            id: 'active',
            status: 'running',
            progress: 62,
            possible_match_count: 1,
            candidate_updated_at: pollCount === 1
              ? '2026-10-23T13:07:20.000Z'
              : '2026-10-23T13:07:23.563Z',
          }],
          next_cursor: null,
          total_count: 1,
          active_count: 1,
          finished_count: 0,
        }),
      };
    },
  });
  context.state.coverLookup.modal.taskId = 'active';
  context.state.coverLookup.modal.candidateSnapshot = {
    search_generation: 'active',
    updated_at: '2026-10-23T13:07:20.000Z',
    candidates: [{ id: 'existing', art_kind: 'cover' }],
  };
  context.refreshCoverLookupGallery = async () => { galleryRefreshes += 1; };

  await context.loadCoverLookupTasks({ toast: false, activeOnly: true });
  await context.loadCoverLookupTasks({ toast: false, activeOnly: true });

  assert.equal(galleryRefreshes, 1);
});

require('node:test')('active-only polling refreshes the first page when a running task disappears', async () => {
  const requestedUrls = [];
  const { context } = createDrawerHarness({
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('active_only=true')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            tasks: [],
            next_cursor: null,
            total_count: 1,
            active_count: 0,
            finished_count: 1,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [{ id: 'finished', status: 'completed' }],
          next_cursor: null,
          total_count: 1,
          active_count: 0,
          finished_count: 1,
        }),
      };
    },
  });
  context.state.coverLookup.tasks = [
    { id: 'finished', status: 'running' },
    { id: 'history', status: 'completed' },
  ];

  await context.loadCoverLookupTasksForPolling({ toast: false });

  assert.deepEqual(requestedUrls, [
    '/utilities/cover-lookup/tasks?limit=50&active_only=true',
    '/utilities/cover-lookup/tasks?limit=50',
  ]);
  assert.equal(context.state.coverLookup.tasks[0].status, 'completed');
  assert.deepEqual(Array.from(context.state.coverLookup.tasks, task => task.id), ['finished', 'history']);
});

require('node:test')('notification history prefetches within two visible drawer heights', async () => {
  let fetchCount = 0;
  const { context, bodyElement } = createDrawerHarness({
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, tasks: [], next_cursor: null }),
      };
    },
  });
  Object.assign(bodyElement, { scrollTop: 800, clientHeight: 500, scrollHeight: 2_000 });
  Object.assign(context.state.coverLookup, {
    tasks: [{ id: 'newest', status: 'completed' }],
    tasksNextCursor: 'page-two',
  });

  await context.handleCoverLookupDrawerScroll({ currentTarget: bodyElement });

  assert.equal(fetchCount, 1);
});

require('node:test')('notification history mounts no more than 60 cards with two spacers', () => {
  const { context, bodyElement } = createDrawerHarness();
  bodyElement.scrollTop = 0;
  bodyElement.clientHeight = 600;
  context.state.coverLookup.tasks = Array.from({ length: 528 }, (_, index) => ({
    id: `task-${index}`,
    status: 'completed',
    artist: `Artist ${index}`,
    album: `Album ${index}`,
  }));

  for (const scrollTop of [0, 12_000, 38_000]) {
    bodyElement.scrollTop = scrollTop;
    context.renderCoverLookupDrawer({ preserveInteraction: false });
    assert.equal((bodyElement.innerHTML.match(/class="cover-lookup-task-card /g) || []).length, 60);
    assert.equal((bodyElement.innerHTML.match(/class="cover-lookup-task-spacer"/g) || []).length, 2);
  }
});

require('node:test')('closing the notification drawer unmounts cards while retaining task summaries', () => {
  const { context, bodyElement } = createDrawerHarness();
  Object.assign(context.state.coverLookup, {
    drawerOpen: true,
    tasks: [{ id: 'completed-task', status: 'completed', artist: 'Artist', album: 'Album' }],
  });
  context.renderCoverLookupDrawer({ preserveInteraction: false });
  assert.match(bodyElement.innerHTML, /class="cover-lookup-task-card /);

  context.state.coverLookup.drawerOpen = false;
  context.renderCoverLookupDrawer({ preserveInteraction: false });

  assert.equal(bodyElement.innerHTML, '');
  assert.equal(context.state.coverLookup.tasks.length, 1);
});

require('node:test')('approaching drawer end serializes the next page request', async () => {
  let resolveRequest;
  let fetchCount = 0;
  const response = {
    ok: true,
    json: async () => ({
      ok: true,
      tasks: [{ id: 'older', status: 'completed' }],
      next_cursor: null,
      total_count: 51,
      active_count: 0,
      finished_count: 51,
    }),
  };
  const { context, bodyElement } = createDrawerHarness({
    fetch: () => {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveRequest = () => resolve(response);
      });
    },
  });
  Object.assign(bodyElement, { scrollTop: 500, clientHeight: 500, scrollHeight: 1_100 });
  Object.assign(context.state.coverLookup, {
    tasks: [{ id: 'newest', status: 'completed' }],
    tasksNextCursor: 'page-two',
  });

  const first = context.handleCoverLookupDrawerScroll({ currentTarget: bodyElement });
  const overlapping = context.handleCoverLookupDrawerScroll({ currentTarget: bodyElement });
  assert.equal(fetchCount, 1);
  resolveRequest();
  await Promise.all([first, overlapping]);
  assert.deepEqual(Array.from(context.state.coverLookup.tasks, task => task.id), ['newest', 'older']);
});

;(async () => {
  let resolveFirstRequest;
  let fetchCount = 0;
  const response = { ok: true, json: async () => ({ ok: true, tasks: [] }) };
  const { context } = createDrawerHarness({
    fetch: () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise((resolve) => {
          resolveFirstRequest = resolve;
        });
      }
      return Promise.resolve(response);
    },
  });

  const firstLoad = context.loadCoverLookupTasksForPolling({ toast: false });
  const overlappingLoad = context.loadCoverLookupTasksForPolling({ toast: false });
  assert.equal(fetchCount, 1, 'polling must not start a second task-list request while one is in flight');
  resolveFirstRequest(response);
  await Promise.all([firstLoad, overlappingLoad]);

  await context.loadCoverLookupTasksForPolling({ toast: false });
  assert.equal(fetchCount, 2, 'polling resumes after the prior request settles');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

require('node:test')('closing cover lookup releases hidden candidate images and polling state', () => {
  class TestButton {}
  const overlay = { hidden: false };
  const modalBody = { innerHTML: '<img src="https://images.example/large-cover.jpg">' };
  const saveButton = new TestButton();
  const context = loadHelper({
    HTMLButtonElement: TestButton,
    document: {
      body: { classList: { remove() {} } },
      getElementById: (id) => ({
        'cover-lookup-modal': overlay,
        'cover-lookup-modal-body': modalBody,
        'cover-lookup-save-remote-button': saveButton,
        'track-modal': { hidden: true },
        'utility-modal': { hidden: true },
      }[id] || null),
    },
  });
  Object.assign(context.state.coverLookup.modal, {
    album: { name: 'Large album' },
    taskId: 'completed-task',
    localCovers: [{ path: 'C:/Music/cover.jpg' }],
    otherArt: [{ path: 'C:/Music/booklet.jpg' }],
    possibleMatches: [{ id: 'remote-cover', url: 'https://images.example/large-cover.jpg' }],
    candidateSnapshot: { search_generation: 'completed-task', candidates: [{ id: 'remote-cover' }] },
  });
  context.state.coverLookup.tasks = [];

  context.closeCoverLookupModal();

  assert.equal(overlay.hidden, true);
  assert.equal(modalBody.innerHTML, '');
  assert.equal(context.state.coverLookup.modal.album, null);
  assert.equal(context.state.coverLookup.modal.taskId, '');
  assert.equal(context.state.coverLookup.modal.localCovers.length, 0);
  assert.equal(context.state.coverLookup.modal.otherArt.length, 0);
  assert.equal(context.state.coverLookup.modal.possibleMatches.length, 0);
  assert.equal(context.state.coverLookup.modal.candidateSnapshot, null);
});

(async () => {
  for (const clearAll of [false, true]) {
    let resolveFetch;
    const { context, bodyElement } = createDrawerHarness({
      fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
      console: { error: () => {} },
    });
    context.state.coverLookup.tasks = [{
      id: 'rollback-task', status: 'completed', artist: 'Artist', album: 'Restored Album',
      notification_action_taken: true,
    }];
    context.renderCoverLookupDrawer();
    context.hasActiveCoverLookupDrawerAction = () => true;
    context.hasActiveCoverLookupDrawerTextSelection = () => true;
    const pending = clearAll
      ? context.clearCompletedCoverLookupTasks()
      : context.clearCoverLookupTaskNotification('rollback-task');
    assert.match(bodyElement.innerHTML, /not looking for anything at the moment/i);
    resolveFetch({ ok: false, json: async () => ({ ok: false, error: 'Delete failed' }) });
    await pending;
    assert.equal(context.state.coverLookup.tasks[0].id, 'rollback-task');
    assert.match(bodyElement.innerHTML, /Restored Album/);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const image = { removeCalled: 0, remove() { this.removeCalled += 1; } };
  const placeholder = { className: '', setAttribute() {} };
  const visual = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === 'img') return image;
      if (selector === '.cover-placeholder') return null;
      return null;
    },
    appendChild(node) { this.appended = node; },
    setAttribute(name, value) { this[name] = value; },
  };
  const trackModal = { hidden: false };
  const context = loadHelper({
    document: {
      getElementById: (id) => (id === 'track-modal' ? trackModal : null),
      querySelector: (selector) => (
        selector === '#track-modal-cover .track-modal-cover-visual' ? visual : null
      ),
      createElement: () => placeholder,
    },
    getAlbumTrackPaths: (album) => album?.tracks?.map((track) => track.path) || [],
  });
  context.state.modalReleases = [{ tracks: [{ path: 'C:/music/Kaipa/01.mp3' }] }];
  context.state.modalReleaseIndex = 0;

  assert.equal(context.markTrackModalCoverTransitionPending({
    tracks: [{ path: 'C:/music/Kaipa/01.mp3' }],
  }), true);
  assert.equal(image.removeCalled, 1);
  assert.equal(visual.appended, placeholder);
  assert.equal(visual['aria-busy'], 'true');
  assert.equal(placeholder.className, 'cover-placeholder');
  assert.equal(context.markTrackModalCoverTransitionPending({
    tracks: [{ path: 'C:/music/Other/01.mp3' }],
  }), false);
}

{
  const {
    context,
    bodyElement,
  } = createDrawerHarness();
  const anchorNode = {};
  const focusNode = {};
  let currentHtml = '<div class="cover-lookup-task-title">Selected notification</div>';
  let bodyWriteCount = 0;
  Object.defineProperty(bodyElement, 'innerHTML', {
    configurable: true,
    get: () => currentHtml,
    set: (value) => {
      bodyWriteCount += 1;
      currentHtml = value;
    },
  });
  bodyElement.contains = (node) => node === anchorNode || node === focusNode;
  const selection = {
    anchorNode,
    focusNode,
    isCollapsed: false,
    rangeCount: 1,
  };
  context.window.getSelection = () => selection;
  context.state.coverLookup.tasks = [{
    id: 'completed-task',
    status: 'completed',
    artist: 'Mastodon',
    album: 'Crack The Skye',
    year: 2009,
  }];

  assert.equal(
    context.hasActiveCoverLookupDrawerTextSelection(bodyElement),
    true,
  );
  context.renderCoverLookupDrawer();
  assert.equal(
    bodyWriteCount,
    0,
    'poll-driven drawer rendering must not replace text while the user is selecting it',
  );
  assert.match(currentHtml, /Selected notification/);

  selection.isCollapsed = true;
  context.renderCoverLookupDrawer();
  assert.equal(bodyWriteCount, 1);
  assert.match(currentHtml, /Crack The Skye/);
}

{
  const taskOpen = {};
  const anchorParent = {
    closest: (selector) => (selector === '.cover-lookup-task-open' ? taskOpen : null),
  };
  const focusParent = {
    closest: (selector) => (selector === '.cover-lookup-task-open' ? taskOpen : null),
  };
  const selection = {
    anchorNode: { parentElement: anchorParent },
    focusNode: { parentElement: focusParent },
    isCollapsed: false,
    rangeCount: 1,
    toString: () => 'COVER ART LOOK UP\nMetallica - Kill Em All - 1983\nCompleted\nElapsed 1s',
  };
  let prevented = 0;
  const clipboardWrites = [];
  const context = loadHelper({
    window: {
      getSelection: () => selection,
    },
  });

  const handled = context.handleCoverLookupTaskOpenCopy({
    clipboardData: {
      setData(type, value) {
        clipboardWrites.push({ type, value });
      },
    },
    preventDefault() {
      prevented += 1;
    },
  });

  assert.equal(handled, true);
  assert.equal(prevented, 1);
  assert.deepEqual(clipboardWrites, [{
    type: 'text/plain',
    value: 'COVER ART LOOK UP\nMetallica - Kill Em All - 1983\nCompleted\nElapsed 1s',
  }]);
}

{
  const context = loadHelper({
    window: {
      getSelection: () => ({
        anchorNode: { parentElement: { closest: () => null } },
        focusNode: { parentElement: { closest: () => null } },
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'Unrelated selection',
      }),
    },
  });
  let prevented = 0;
  let wroteClipboard = false;

  const handled = context.handleCoverLookupTaskOpenCopy({
    clipboardData: {
      setData() {
        wroteClipboard = true;
      },
    },
    preventDefault() {
      prevented += 1;
    },
  });

  assert.equal(handled, false);
  assert.equal(prevented, 0);
  assert.equal(wroteClipboard, false);
}

{
  const {
    context,
    bodyElement,
  } = createDrawerHarness();
  context.state.coverLookup.tasks = [{
    id: 'completed-task',
    status: 'completed',
    artist: 'Metallica',
    album: 'Kill Em All',
    year: 1983,
  }];

  context.renderCoverLookupDrawer();

  assert.match(
    bodyElement.innerHTML,
    /<div class="cover-lookup-task-open" role="button" tabindex="0" aria-label="Open Cover Look Up: Kill Em All — Metallica · 1983" data-open-cover-lookup-task="completed-task">/,
    'the clickable card text should use a default-selectable surface',
  );
  assert.doesNotMatch(
    bodyElement.innerHTML,
    /<button class="cover-lookup-task-open"/,
    'a native button makes text selection depend on a browser override',
  );
}

{
  const context = loadHelper();
  assert.equal(
    context.buildCoverLookupSearchQuery({
      album_artist: 'The Artist',
      name: 'The Album',
      year: 1999,
    }),
    'The Artist The Album 1999 album cover',
  );
}

{
  const context = loadHelper();
  assert.equal(
    context.buildCoverLookupImageSearchUrl('google', {
      album_artist: 'Машина времени',
      name: 'Часы и Знаки',
      year: 1999,
    }),
    'https://www.google.com/search?tbm=isch&q=%D0%9C%D0%B0%D1%88%D0%B8%D0%BD%D0%B0%20%D0%B2%D1%80%D0%B5%D0%BC%D0%B5%D0%BD%D0%B8%20%D0%A7%D0%B0%D1%81%D1%8B%20%D0%B8%20%D0%97%D0%BD%D0%B0%D0%BA%D0%B8%201999%20album%20cover',
  );
  assert.equal(
    context.buildCoverLookupImageSearchUrl('yandex', {
      album_artist: 'Аквариум',
      name: 'Лошадь Белая',
      year: null,
    }),
    'https://yandex.com/images/search?text=%D0%90%D0%BA%D0%B2%D0%B0%D1%80%D0%B8%D1%83%D0%BC%20%D0%9B%D0%BE%D1%88%D0%B0%D0%B4%D1%8C%20%D0%91%D0%B5%D0%BB%D0%B0%D1%8F%20album%20cover',
  );
}

{
  const context = loadHelper();
  assert.equal(
    context.buildCoverLookupImageSearchUrl('google', {
      album_artist: 'The Artist',
      name: 'The Album',
      year: 1999,
    }),
    'https://www.google.com/search?tbm=isch&q=The%20Artist%20The%20Album%201999%20album%20cover',
  );
  assert.equal(
    context.buildCoverLookupImageSearchUrl('yandex', {
      album_artist: 'The Artist',
      name: 'The Album',
      year: 1999,
    }),
    'https://yandex.com/images/search?text=The%20Artist%20The%20Album%201999%20album%20cover',
  );
}

{
  const context = loadHelper();
  assert.equal(
    context.buildRemoteCoverLookupDisplayUrl(
      { source: 'direct_url' },
      'https://images.example/cover.jpg',
      'abc',
    ),
    '/utilities/cover-lookup/remote-image?url=https%3A%2F%2Fimages.example%2Fcover.jpg&key=abc',
  );
  assert.equal(
    context.buildRemoteCoverLookupDisplayUrl(
      { source: 'spotify' },
      'https://images.example/cover.jpg',
      'abc',
    ),
    '/utilities/cover-lookup/remote-image?url=https%3A%2F%2Fimages.example%2Fcover.jpg&key=abc',
  );
}

{
  const context = loadHelper();
  context.state.coverLookup.modal.selectedRemoteId = '';

  const matches = [{
    id: 'metallica-deluxe',
    source: 'apple',
    art_kind: 'cover',
    display_only: false,
  }, {
    id: 'metallica-base-caa',
    source: 'cover_art_archive',
    art_kind: 'cover',
    display_only: false,
  }];

  context.reconcileCoverLookupRemoteSelection(matches);

  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'metallica-deluxe');

  context.state.coverLookup.modal.selectedRemoteId = 'manual-choice';
  context.reconcileCoverLookupRemoteSelection([
    ...matches,
    {
      id: 'manual-choice',
      source: 'direct_url',
      art_kind: 'cover',
      display_only: false,
    },
  ]);
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'manual-choice');
}

{
  const activeCoverPath = 'C:/music/Mastodon/Crack The Skye/cover.jpg';
  const alternateCoverPath = 'C:/music/Mastodon/Crack The Skye/Art/Front.jpg';
  const context = loadHelper({
    document: {
      getElementById: () => ({ hidden: true }),
    },
  });
  context.state.coverLookup.modal = {
    activeLocalSelectionPath: activeCoverPath,
    pendingLocalPath: '',
    pendingPastedImageId: '',
    selectedRemoteId: '',
  };

  context.selectLocalCoverFromLookup(alternateCoverPath);

  assert.equal(context.state.coverLookup.modal.activeLocalSelectionPath, activeCoverPath);
  assert.equal(context.state.coverLookup.modal.pendingLocalPath, alternateCoverPath);
  assert.equal(context.hasPendingLocalCoverSelection(), true);
}

require('node:test')('remote save closes only after the server accepts the queued mutation', async () => {
  const album = {
    key: 'artist::album::2001',
    tracks: [{ path: 'C:/music/Remote/01.flac' }],
  };
  let resolveResponse;
  let closeCount = 0;
  let fetchCount = 0;
  let refreshCount = 0;
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: () => {},
  });
  const advanceModalSession = context.closeCoverLookupModal;
  context.state.coverLookup.modal = {
    album,
    taskId: 'remote-save-acceptance',
    selectedRemoteId: 'candidate-1',
    possibleMatches: [{
      id: 'candidate-1',
      url: 'https://images.example/remote-cover.jpg',
      display_only: false,
    }],
  };
  context.applyOptimisticRemoteCoverSelection = () => {};
  context.closeCoverLookupModal = () => { closeCount += 1; };
  context.markAlbumCoverPathsFresh = () => {};
  context.syncCoverLookupAlbumReferences = () => {};
  context.refreshCoverLookupAlbumArtwork = () => { refreshCount += 1; };
  context.fetch = () => {
    fetchCount += 1;
    return new Promise((resolve) => { resolveResponse = resolve; });
  };
  context.loadCoverLookupTasks = async () => {};
  context.ensureCoverLookupPolling = () => {};
  context.renderCoverLookupDrawer = () => {};

  const pending = context.saveRemoteCoverFromLookup();
  await Promise.resolve();

  assert.equal(closeCount, 0);
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-1');
  const duplicate = context.saveRemoteCoverFromLookup();
  await Promise.resolve();
  assert.equal(fetchCount, 1);
  await duplicate;

  resolveResponse({
    ok: false,
    json: async () => ({ ok: false, error: 'Save was rejected.' }),
  });
  await pending;

  assert.equal(closeCount, 0);
  assert.equal(refreshCount, 0);
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-1');

  const accepted = context.saveRemoteCoverFromLookup();
  await Promise.resolve();
  resolveResponse({
    ok: true,
    json: async () => ({ ok: true, queued: true, task: { id: 'remote-save-acceptance' } }),
  });
  await accepted;

  assert.equal(closeCount, 1);

  const replacementAlbum = {
    key: 'replacement::album::2002',
    tracks: [{ path: 'C:/music/Replacement/01.flac' }],
  };
  context.state.coverLookup.modal = {
    album,
    taskId: 'remote-save-stale-modal',
    selectedRemoteId: 'candidate-1',
    possibleMatches: [{
      id: 'candidate-1',
      url: 'https://images.example/remote-cover.jpg',
      display_only: false,
    }],
    saving: false,
  };
  const staleModalSave = context.saveRemoteCoverFromLookup();
  await Promise.resolve();
  advanceModalSession();
  context.state.coverLookup.modal = {
    album: replacementAlbum,
    selectedRemoteId: 'replacement-candidate',
    saving: false,
  };
  resolveResponse({
    ok: true,
    json: async () => ({ ok: true, queued: true, task: { id: 'remote-save-stale-modal' } }),
  });
  await staleModalSave;

  assert.strictEqual(context.state.coverLookup.modal.album, replacementAlbum);
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'replacement-candidate');
  assert.equal(closeCount, 1);
});

require('node:test')('failed or canceled accepted remote save restores owned artwork state', async () => {
  const album = {
    key: 'artist::album::2001',
    cover_path: 'C:/music/Remote/original.jpg',
    tracks: [{ path: 'C:/music/Remote/01.flac', cover_path: 'C:/music/Remote/original.jpg' }],
  };
  const albumSignature = 'C:/music/Remote/01.flac';
  let terminalStatus = 'failed';
  const toastCalls = [];
  const restoredAlbums = [];
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: (...args) => toastCalls.push(args),
  });
  context.state.coverLookup.modal = {
    album,
    taskId: 'remote-save-failure',
    selectedRemoteId: 'candidate-1',
    possibleMatches: [{
      id: 'candidate-1',
      url: 'https://images.example/remote-cover.jpg',
      display_only: false,
    }],
  };
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.appliedTaskUpdateSignatures = {};
  context.state.coverLookup.optimisticAlbumCovers = {};
  context.applyOptimisticRemoteCoverSelection = (_selectedAlbum, selectedMatch) => {
    context.state.coverLookup.optimisticAlbumCovers[albumSignature] = { src: selectedMatch.url };
  };
  context.closeCoverLookupModal = () => {};
  context.clearOptimisticAlbumCovers = () => {};
  context.markAlbumCoverPathsFresh = () => {};
  context.syncCoverLookupAlbumReferences = () => {};
  context.refreshCoverLookupAlbumArtwork = (_album, updatedAlbums) => {
    restoredAlbums.push(updatedAlbums);
  };
  context.fetch = async (url) => {
    if (url === '/utilities/cover-lookup/save-remote') {
      return {
        ok: true,
        json: async () => ({ ok: true, queued: true, task: { id: 'remote-save-failure' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{
          id: 'remote-save-failure',
          status: terminalStatus,
          progress: 100,
          progress_label: terminalStatus === 'failed' ? 'Save failed' : 'Canceled',
          message: terminalStatus === 'failed' ? 'Remote image could not be saved.' : 'Cover save canceled.',
          notification_action_taken: false,
          job_contract: { job_kind: 'save_remote_selection' },
          album_payload: album,
        }],
      }),
    };
  };
  context.mergeCoverLookupTasksWithNotifications = (tasks) => tasks;
  context.renderCoverLookupDrawer = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};

  await context.saveRemoteCoverFromLookup();

  assert.equal(context.state.coverLookup.tasks[0].notification_action_taken, false);
  assert.deepEqual(JSON.parse(JSON.stringify(restoredAlbums)), [[album]]);
  assert.deepEqual(toastCalls, [['Remote image could not be saved.', 'error', 5000]]);

  terminalStatus = 'canceled';
  context.state.coverLookup.modal.selectedRemoteId = 'candidate-1';
  context.state.coverLookup.modal.possibleMatches = [{
    id: 'candidate-1',
    url: 'https://images.example/remote-cover.jpg',
    display_only: false,
  }];
  await context.saveRemoteCoverFromLookup();

  assert.equal(restoredAlbums.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(restoredAlbums.at(-1))), [album]);
  assert.deepEqual(toastCalls, [['Remote image could not be saved.', 'error', 5000]]);
});

;(async () => {
  class TestButton {
    constructor() {
      this.hidden = false;
      this.disabled = false;
    }
  }
  const firstAlbum = {
    album_artist: 'Mastodon',
    name: 'Leviathan',
    year: 2004,
  };
  const secondAlbum = {
    album_artist: 'Flaming Row',
    name: 'The Pure Shine',
    year: 2019,
  };
  const overlay = { hidden: true };
  const saveButton = new TestButton();
  const fetchCalls = [];
  let taskReloads = 0;
  let galleryReloads = 0;
  let appliedGallery = null;
  const context = loadHelper({
    HTMLButtonElement: TestButton,
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          task: {
            id: 'flaming-row-lookup',
            progress_label: 'Searching...',
          },
        }),
      };
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
  });
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.modal = {
    album: firstAlbum,
    taskId: 'mastodon-lookup',
    pastedImages: [],
    manualUrlText: [
      'https://covers.example/mastodon-front.jpg',
      'https://covers.example/mastodon-back.jpg',
    ].join('\n'),
  };
  context.renderCoverLookupModal = () => {};
  context.ensureCoverLookupPolling = () => {};
  context.loadCoverLookupTasks = async () => { taskReloads += 1; };
  context.refreshCoverLookupGallery = async () => { galleryReloads += 1; };
  context.applyCoverLookupGalleryPayload = (gallery) => { appliedGallery = gallery; };

  await context.openCoverLookupModal(secondAlbum, { taskId: 'flaming-row-lookup' });
  assert.equal(taskReloads, 0, 'opening the modal must not load notification history');
  assert.equal(galleryReloads, 1, 'opening the modal must load its gallery');
  taskReloads = 0;
  galleryReloads = 0;
  await context.startCoverLookupForAlbum(secondAlbum);

  assert.equal(fetchCalls.length, 1);
  assert.equal(taskReloads, 0, 'start response already contains the queued task');
  assert.equal(galleryReloads, 0, 'starting a lookup must retain the gallery already loaded by the open modal');
  assert.equal(appliedGallery, null);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    album: secondAlbum,
    manual_urls: [],
    task_id: 'flaming-row-lookup',
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const buildCoverUrlCalls = [];
  const context = loadHelper({
    buildCoverUrl: (coverPath, options) => {
      const revision = options?.revision;
      const size = options?.size;
      buildCoverUrlCalls.push({ coverPath, revision, size });
      return `/cover?path=${encodeURIComponent(coverPath)}${size ? `&size=${size}` : ''}&v=${revision || 'session-fallback'}`;
    },
    buildRemoteCoverSourceBadge: () => '',
    escapeHtml: (value) => String(value || ''),
    getCoverLookupActiveLocalPath: () => '',
  });
  const localCover = {
    path: 'C:/music/Kaipa/cover.jpg',
    filename: 'cover.jpg',
    cover_revision: 'authoritative-cover-revision',
  };

  context.buildCoverLookupCard(localCover, 'local');

  assert.deepEqual(buildCoverUrlCalls, [
    {
      coverPath: localCover.path,
      revision: localCover.cover_revision,
      size: 480,
    },
    {
      coverPath: localCover.path,
      revision: localCover.cover_revision,
      size: undefined,
    },
  ]);

  buildCoverUrlCalls.length = 0;
  const fallbackHtml = context.buildCoverLookupCard(
    { path: 'C:/music/Kaipa/alternate.jpg', filename: 'alternate.jpg' },
    'local',
  );
  assert.deepEqual(buildCoverUrlCalls, [
    { coverPath: 'C:/music/Kaipa/alternate.jpg', revision: undefined, size: 480 },
    { coverPath: 'C:/music/Kaipa/alternate.jpg', revision: undefined, size: undefined },
  ]);
  assert.match(fallbackHtml, /size=480/);
  assert.match(fallbackHtml, /v=session-fallback/);
}

;(async () => {
  const drawerElement = {
    hidden: false,
    classList: { toggle: () => {} },
  };
  const bodyElement = {
    innerHTML: '',
  };
  const badgeElement = {
    hidden: false,
    textContent: '',
  };
  const buttonElement = {
    classList: { toggle: () => {} },
  };
  const clearElement = {
    hidden: false,
  };
  const context = loadHelper({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{ id: 'task-1', status: 'completed', result_kind: 'cover-updated' }],
      }),
    }),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks.map((task) => ({ ...task, notification_action_taken: true })),
    escapeHtml: (value) => String(value || ''),
    applyCoverLookupTaskUpdates: () => {},
    stopCoverLookupPollingIfIdle: () => {},
    document: {
      getElementById: (id) => ({
        'cover-lookup-drawer': drawerElement,
        'cover-lookup-drawer-body': bodyElement,
        'cover-lookup-drawer-badge': badgeElement,
        'cover-lookup-drawer-button': buttonElement,
        'cover-lookup-drawer-clear': clearElement,
      }[id] || { hidden: true }),
    },
  });
  context.state.coverLookup.drawerOpen = false;
  context.state.coverLookup.modal = { taskId: '' };

  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(context.state.coverLookup.tasks[0].notification_action_taken, true);
  assert.equal(bodyElement.innerHTML, '');
  context.state.coverLookup.drawerOpen = true;
  context.renderCoverLookupDrawer({ preserveInteraction: false });
  assert.match(bodyElement.innerHTML, /data-open-cover-lookup-task="task-1"/);
  assert.match(bodyElement.innerHTML, />Art chosen<\/span>/);
  assert.equal(badgeElement.hidden, false);
  assert.equal(badgeElement.textContent, '1');
  assert.equal(clearElement.disabled, false);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const album = {
    key: 'artist::album::2001',
    album_artist: 'Remote Artist',
    name: 'Remote Album',
    year: 2001,
  };
  const markCalls = [];
  const fetchCalls = [];
  const lifecycleCalls = [];
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: () => {},
  });
  context.state.coverLookup.modal = {
    album,
    taskId: 'remote-save-task',
    selectedRemoteId: 'candidate-1',
    possibleMatches: [{
      id: 'candidate-1',
      url: 'https://images.example/remote-cover.jpg',
      display_only: false,
    }],
  };
  context.state.coverLookup.tasks = [];
  context.applyOptimisticRemoteCoverSelection = () => {};
  context.closeCoverLookupModal = () => {};
  context.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ ok: true, queued: true }),
    };
  };
  context.loadCoverLookupTasks = async () => {
    context.state.coverLookup.tasks = [{
      id: 'remote-save-task',
      status: 'failed',
      progress_label: 'Save failed',
      notification_action_taken: false,
    }];
    lifecycleCalls.push('reload');
  };
  context.markCoverLookupTaskActionTaken = (taskId) => {
    markCalls.push(taskId);
    const task = context.state.coverLookup.tasks.find((item) => item.id === taskId);
    if (task) task.notification_action_taken = true;
  };
  context.ensureCoverLookupPolling = () => lifecycleCalls.push('poll');
  context.renderCoverLookupDrawer = () => lifecycleCalls.push('render');

  await context.saveRemoteCoverFromLookup();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/utilities/cover-lookup/save-remote');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    album,
    task_id: 'remote-save-task',
    candidate_id: 'candidate-1',
  });
  assert.deepEqual(markCalls, []);
  assert.equal(context.state.coverLookup.tasks[0].status, 'failed');
  assert.equal(context.state.coverLookup.tasks[0].notification_action_taken, false);
  assert.deepEqual(lifecycleCalls, ['reload', 'poll', 'render']);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const sourcePath = 'C:/music/Kaipa/Art/Front.jpg';
  const selectedCoverPath = 'C:/music/Kaipa/cover.jpg';
  const album = {
    key: 'kaipa::kaipa::1975',
    album_artist: 'Kaipa',
    name: 'Kaipa',
    year: 1975,
    cover_path: 'C:/music/Kaipa/Art/back.jpg',
    cover_preview_url: '/cover?path=C%3A%2Fmusic%2FKaipa%2FArt%2Fback.jpg&size=480&v=old-revision',
    tracks: [{ path: 'C:/music/Kaipa/01.mp3', cover_path: 'C:/music/Kaipa/Art/back.jpg' }],
  };
  const authoritativeAlbum = {
    ...album,
    cover_path: selectedCoverPath,
    cover_preview_url: '/cover?path=C%3A%2Fmusic%2FKaipa%2Fcover.jpg&size=480&v=selected-front-revision',
    cover_revision: 'selected-front-revision',
    tracks: [{ path: 'C:/music/Kaipa/01.mp3', cover_path: selectedCoverPath }],
  };
  const fetchCalls = [];
  const refreshedAlbums = [];
  const preloadedAlbums = [];
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: () => {},
    buildTrackPathSignature: (value) => (value?.tracks || [])
      .map((track) => String(track?.path || ''))
      .filter(Boolean)
      .sort()
      .join('|'),
    getAlbumPathSignature: (value) => (value?.tracks || [])
      .map((track) => String(track?.path || ''))
      .filter(Boolean)
      .sort()
      .join('|'),
    persistCoverLookupNotificationTasks: () => {},
  });
  context.state.coverLookup = {
    modal: {
      album,
      taskId: 'kaipa-local-cover-task',
      pendingLocalPath: sourcePath,
      selectedRemoteId: '',
      localCovers: [{
        path: sourcePath,
        cover_revision: 'selected-source-revision',
      }],
    },
    tasks: [],
    optimisticAlbumCovers: {},
  };
  context.closeCoverLookupModal = () => {};
  context.markAlbumCoverPathsFresh = () => {};
  context.refreshCoverLookupAlbumArtwork = (_originalAlbum, updatedAlbums, options = {}) => {
    refreshedAlbums.push({
      albums: updatedAlbums,
      options,
      optimisticAlbumCovers: JSON.parse(JSON.stringify(
        context.state.coverLookup.optimisticAlbumCovers,
      )),
    });
  };
  context.buildCoverUrl = (coverPath, options = {}) => (
    `/cover?path=${encodeURIComponent(coverPath)}&size=${options.size || ''}&v=${options.revision || ''}`
  );
  context.preloadCoverLookupAlbumImage = async (updatedAlbum) => {
    preloadedAlbums.push({
      album: updatedAlbum,
      optimisticAlbumCovers: JSON.parse(JSON.stringify(
        context.state.coverLookup.optimisticAlbumCovers,
      )),
    });
    return true;
  };
  context.markCoverLookupTaskActionTaken = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        selected_cover_path: selectedCoverPath,
        updated_albums: [authoritativeAlbum],
        updated_album: authoritativeAlbum,
      }),
    };
  };

  await context.saveLocalCoverFromLookup(sourcePath);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/utilities/cover-lookup/local-select');
  assert.equal(context.state.coverLookup.modal.album.cover_path, selectedCoverPath);
  assert.equal(context.state.coverLookup.modal.album.cover_revision, 'selected-front-revision');
  assert.deepEqual(refreshedAlbums.at(-1).albums, [authoritativeAlbum]);
  assert.equal(refreshedAlbums[0].options.updateTrackModal, false);
  assert.deepEqual(
    refreshedAlbums[0].optimisticAlbumCovers['C:/music/Kaipa/01.mp3'],
    {
      src: '/cover?path=C%3A%2Fmusic%2FKaipa%2FArt%2FFront.jpg&size=480&v=selected-source-revision',
      coverPath: sourcePath,
    },
  );
  assert.equal(preloadedAlbums.length, 1);
  assert.deepEqual(preloadedAlbums[0].album, authoritativeAlbum);
  assert.deepEqual(
    preloadedAlbums[0].optimisticAlbumCovers['C:/music/Kaipa/01.mp3'],
    {
      src: '/cover?path=C%3A%2Fmusic%2FKaipa%2FArt%2FFront.jpg&size=480&v=selected-source-revision',
      coverPath: sourcePath,
    },
  );
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    album,
    source_path: sourcePath,
    task_id: 'kaipa-local-cover-task',
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const oldSnapshot = {
    search_generation: 'old-generation',
    search_kind: 'automatic',
    status: 'completed',
    revision: 5,
    best_candidate_id: 'old-best',
    candidates: [{ id: 'old-best', url: 'https://images.example/old.jpg' }],
  };
  const taskStates = [
    { id: 'new-generation', status: 'running', candidate_revision: 0, possible_matches: [] },
    { id: 'new-generation', status: 'failed', candidate_revision: 0, possible_matches: [] },
    {
      id: 'new-generation',
      status: 'running',
      candidate_revision: 1,
      best_candidate_id: 'new-best',
      possible_matches: [{ id: 'new-best', url: 'https://images.example/new.jpg' }],
    },
  ];
  let responseIndex = 0;
  const context = loadHelper({
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/gallery/mark-seen') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          local_covers: [],
          other_art: [],
          candidate_snapshot: oldSnapshot,
          task: taskStates[responseIndex++],
        }),
      };
    },
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.state.coverLookup.modal = {
    album: { album_id: 41, tracks: [{ path: 'C:/music/old.flac' }] },
    taskId: 'new-generation',
    possibleMatches: [],
    selectedRemoteId: '',
  };
  context.state.coverLookup.tasks = [];

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['old-best'],
    'a new task without valid candidates must retain the prior persisted snapshot',
  );

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['old-best'],
    'a zero-result failed task must keep the prior persisted snapshot visible',
  );

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['new-best'],
    'the new generation replaces the prior snapshot after its first valid candidate',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const requests = [];
  const context = loadHelper({
    fetch: async (...args) => {
      requests.push(args);
      throw new Error('A missing candidate snapshot must not call mark-seen.');
    },
  });
  context.state.coverLookup.modal.album = { id: 41 };

  await context.markCoverLookupAutomaticImprovementSeen(null);

  assert.deepEqual(requests, []);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const album = {
    id: 41,
    key: 'saved-snapshot-album',
    album_artist: 'Candidate Artist',
    name: 'Candidate Album',
    tracks: [{ path: 'C:/music/Candidate Artist/Candidate Album/01.flac' }],
  };
  const requests = [];
  const context = loadHelper({
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/utilities/cover-lookup/gallery/mark-seen') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            candidate_snapshot: {
              search_generation: 'saved-generation',
              search_kind: 'automatic',
              status: 'completed',
              revision: 3,
              best_candidate_id: 'saved-best',
              automatic_improvement_revision: 2,
              seen_automatic_improvement_revision: 2,
              has_unseen_automatic_improvement: false,
              candidates: [{ id: 'saved-best', url: 'https://images.example/saved.jpg' }],
            },
          }),
        };
      }
      assert.equal(url, '/utilities/cover-lookup/gallery');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          local_covers: [],
          other_art: [],
          remote_cover: null,
          task: null,
          candidate_snapshot: {
            search_generation: 'saved-generation',
            search_kind: 'manual',
            status: 'completed',
            revision: 3,
            best_candidate_id: 'saved-best',
            automatic_improvement_revision: 2,
            seen_automatic_improvement_revision: 1,
            has_unseen_automatic_improvement: true,
            candidates: [{ id: 'saved-best', url: 'https://images.example/saved.jpg' }],
          },
        }),
      };
    },
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.state.coverLookup.modal = {
    album,
    taskId: '',
    possibleMatches: [],
    selectedRemoteId: '',
  };
  context.state.coverLookup.tasks = [{
    id: 'manual-notification',
    status: 'completed',
    notification_action_taken: false,
  }];

  await context.refreshCoverLookupGallery(false);

  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['saved-best'],
    'a durable album snapshot must populate the gallery without a lookup task',
  );
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'saved-best');
  assert.equal(context.state.coverLookup.modal.candidateSnapshot.revision, 3);
  assert.equal(
    context.state.coverLookup.tasks[0].notification_action_taken,
    false,
    'opening a saved snapshot must not consume the existing manual-search notification',
  );
  assert.equal(requests.filter((request) => request.url === '/utilities/cover-lookup/gallery/mark-seen').length, 1);
  const markSeenBody = JSON.parse(
    requests.find((request) => request.url === '/utilities/cover-lookup/gallery/mark-seen').options.body,
  );
  assert.equal(markSeenBody.album.id, 41);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const responses = [
    {
      task: {
        id: 'manual-generation',
        status: 'running',
        candidate_updated_at: '2026-08-03T12:00:02.000Z',
        possible_matches: [{ id: 'task-newer', url: 'https://images.example/task.jpg' }],
      },
      candidate_snapshot: {
        search_generation: 'manual-generation',
        search_kind: 'manual',
        status: 'running',
        revision: 700,
        updated_at: '2026-08-03T12:00:01.000Z',
        best_candidate_id: 'snapshot-older',
        candidates: [{ id: 'snapshot-older', url: 'https://images.example/old.jpg' }],
      },
    },
    {
      task: {
        id: 'manual-generation',
        status: 'running',
        candidate_updated_at: '2026-08-03T12:00:03.000Z',
        possible_matches: [{ id: 'task-older', url: 'https://images.example/task-old.jpg' }],
      },
      candidate_snapshot: {
        search_generation: 'manual-generation',
        search_kind: 'manual',
        status: 'running',
        revision: 1,
        updated_at: '2026-08-03T12:00:04.000Z',
        best_candidate_id: 'snapshot-newer',
        candidates: [{ id: 'snapshot-newer', url: 'https://images.example/new.jpg' }],
      },
    },
  ];
  let responseIndex = 0;
  const context = loadHelper({
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/gallery/mark-seen') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, local_covers: [], other_art: [], ...responses[responseIndex++] }),
      };
    },
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.state.coverLookup.modal = {
    album: { id: 42, tracks: [{ path: 'C:/music/revision.flac' }] },
    taskId: 'manual-generation',
    possibleMatches: [],
    selectedRemoteId: '',
  };
  context.state.coverLookup.tasks = [];

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['task-newer'],
    'the live task wins when its candidate publication is newer',
  );

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['snapshot-newer'],
    'the durable snapshot wins when its publication timestamp is newer',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const snapshots = [
    {
      search_generation: 'progressive-generation',
      search_kind: 'manual',
      status: 'running',
      revision: 1,
      best_candidate_id: 'candidate-a',
      candidates: [
        { id: 'candidate-a', score: 0.8, url: 'https://images.example/a.jpg' },
        { id: 'candidate-b', score: 0.7, url: 'https://images.example/b.jpg' },
      ],
    },
    {
      search_generation: 'progressive-generation',
      search_kind: 'manual',
      status: 'running',
      revision: 2,
      best_candidate_id: 'candidate-b',
      candidates: [
        { id: 'candidate-b', score: 0.95, url: 'https://images.example/b.jpg' },
        { id: 'candidate-a', score: 0.8, url: 'https://images.example/a.jpg' },
      ],
    },
    {
      search_generation: 'progressive-generation',
      search_kind: 'manual',
      status: 'running',
      revision: 3,
      best_candidate_id: 'candidate-c',
      candidates: [
        { id: 'candidate-c', score: 0.99, url: 'https://images.example/c.jpg' },
        { id: 'persisted-candidate-a', score: 0.8, url: 'https://images.example/a.jpg' },
        { id: 'candidate-b', score: 0.7, url: 'https://images.example/b.jpg' },
      ],
    },
    {
      search_generation: 'progressive-generation',
      search_kind: 'manual',
      status: 'running',
      revision: 4,
      best_candidate_id: 'candidate-c',
      candidates: [
        { id: 'candidate-c', score: 0.99, url: 'https://images.example/c.jpg' },
        { id: 'candidate-b', score: 0.7, url: 'https://images.example/b.jpg' },
      ],
    },
    {
      search_generation: 'progressive-generation',
      search_kind: 'manual',
      status: 'completed',
      revision: 5,
      best_candidate_id: 'candidate-c',
      candidates: [
        { id: 'candidate-c', score: 0.99, url: 'https://images.example/c.jpg' },
        { id: 'candidate-a', score: 0.8, url: 'https://images.example/a.jpg' },
        { id: 'candidate-b', score: 0.7, url: 'https://images.example/b.jpg' },
      ],
    },
    {
      search_generation: 'next-generation',
      search_kind: 'manual',
      status: 'running',
      revision: 1,
      best_candidate_id: 'candidate-d',
      candidates: [{ id: 'candidate-d', score: 1, url: 'https://images.example/d.jpg' }],
    },
  ];
  let snapshotIndex = 0;
  const context = loadHelper({
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/gallery/mark-seen') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          task: null,
          local_covers: [],
          other_art: [],
          candidate_snapshot: snapshots[snapshotIndex++],
        }),
      };
    },
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.syncCoverLookupSelectionUi = () => {};
  context.state.coverLookup.modal = {
    album: { id: 43, tracks: [{ path: 'C:/music/progressive.flac' }] },
    taskId: '',
    possibleMatches: [],
    selectedRemoteId: '',
  };
  context.state.coverLookup.tasks = [];

  await context.refreshCoverLookupGallery(false);
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-a');

  await context.refreshCoverLookupGallery(false);
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['candidate-b', 'candidate-a'],
    'progressive ranking may reorder cards but must retain their stable candidate IDs',
  );
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'candidate-b',
    'the improving best candidate must remain auto-selected before an explicit override',
  );

  context.selectRemoteCoverFromLookup('candidate-a');
  await context.refreshCoverLookupGallery(false);
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'persisted-candidate-a',
    'the override must remap by normalized URL when the persisted snapshot uses a different candidate ID',
  );

  await context.refreshCoverLookupGallery(false);
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'a disappeared explicit override must remain empty instead of selecting another same-generation candidate',
  );

  await context.refreshCoverLookupGallery(false);
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'candidate-a',
    'a same-generation override must remap again when its normalized URL returns under the live candidate ID',
  );

  await context.refreshCoverLookupGallery(false);
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'candidate-a',
    'a new generation preserves the explicit prior-generation choice instead of auto-selecting its best candidate',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const intervalCalls = [];
  const requestUrls = [];
  let resolveTaskPoll;
  const context = loadHelper({
    window: {
      setInterval(callback, delay) {
        intervalCalls.push({ callback, delay });
        return intervalCalls.length;
      },
      clearInterval() {},
    },
    document: {
      getElementById: (id) => (id === 'cover-lookup-modal' ? { hidden: false } : null),
    },
    fetch: async (url) => {
      requestUrls.push(url);
      if (url.startsWith('/utilities/cover-lookup/tasks?')) {
        return new Promise((resolve) => { resolveTaskPoll = resolve; });
      }
      if (url === '/utilities/cover-lookup/gallery/mark-seen') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          task: null,
          local_covers: [],
          other_art: [],
          candidate_snapshot: {
            search_generation: 'automatic-running',
            search_kind: 'automatic',
            status: 'running',
            revision: 2,
            best_candidate_id: 'automatic-candidate',
            candidates: [{ id: 'automatic-candidate', url: 'https://images.example/auto.jpg' }],
          },
        }),
      };
    },
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};
  context.state.coverLookup.modal = {
    album: { id: 44, tracks: [{ path: 'C:/music/automatic.flac' }] },
    taskId: '',
    possibleMatches: [],
    selectedRemoteId: '',
  };
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';

  await context.refreshCoverLookupGallery(false);
  context.ensureCoverLookupPolling();
  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].delay, 100);
  const firstTick = intervalCalls[0].callback();
  const overlappingTick = intervalCalls[0].callback();
  resolveTaskPoll({ ok: true, json: async () => ({ ok: true, tasks: [] }) });
  await Promise.all([firstTick, overlappingTick]);

  assert.equal(
    requestUrls.filter((url) => url === '/utilities/cover-lookup/gallery').length,
    2,
    'overlapping timer callbacks must share one running-snapshot gallery refresh',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const album = {
    album_id: 41,
    key: 'saved-candidate-album',
    tracks: [{ path: 'C:/music/Saved/01.flac' }],
  };
  const fetchCalls = [];
  const toastCalls = [];
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: (...args) => toastCalls.push(args),
  });
  context.state.coverLookup.modal = {
    album,
    taskId: '',
    selectedRemoteId: 'saved-candidate',
    candidateSnapshot: { search_generation: 'saved-generation' },
    possibleMatches: [{
      id: 'saved-candidate',
      url: 'https://images.example/saved.jpg',
      display_only: false,
    }],
  };
  context.applyOptimisticRemoteCoverSelection = () => {};
  context.closeCoverLookupModal = () => {};
  context.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, queued: true }) };
  };
  context.loadCoverLookupTasks = async () => {};
  context.ensureCoverLookupPolling = () => {};
  context.renderCoverLookupDrawer = () => {};

  await context.saveRemoteCoverFromLookup();

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    album,
    task_id: '',
    candidate_id: 'saved-candidate',
    snapshot_generation: 'saved-generation',
  });
  assert.deepEqual(toastCalls, []);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const sourcePath = 'C:/music/Kaipa/Art/Front.jpg';
  const album = {
    key: 'kaipa::kaipa::1975',
    album_artist: 'Kaipa',
    name: 'Kaipa',
    year: 1975,
    cover_path: 'C:/music/Kaipa/cover.jpg',
    cover_revision: 'original-revision',
    tracks: [{ path: 'C:/music/Kaipa/01.mp3', cover_path: 'C:/music/Kaipa/cover.jpg' }],
  };
  const refreshedAlbums = [];
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: () => {},
    buildTrackPathSignature: (value) => (value?.tracks || [])
      .map((track) => String(track?.path || ''))
      .filter(Boolean)
      .sort()
      .join('|'),
    getAlbumPathSignature: (value) => (value?.tracks || [])
      .map((track) => String(track?.path || ''))
      .filter(Boolean)
      .sort()
      .join('|'),
    persistCoverLookupNotificationTasks: () => {},
    buildCoverUrl: () => '/cover?selected-source',
  });
  context.state.coverLookup = {
    modal: {
      album,
      taskId: '',
      pendingLocalPath: sourcePath,
      selectedRemoteId: '',
      localCovers: [{ path: sourcePath }],
    },
    tasks: [],
    optimisticAlbumCovers: {},
  };
  context.closeCoverLookupModal = () => {};
  context.markAlbumCoverPathsFresh = () => {};
  context.syncCoverLookupAlbumReferences = () => {};
  context.refreshCoverLookupAlbumArtwork = (_originalAlbum, updatedAlbums) => {
    refreshedAlbums.push(updatedAlbums);
  };
  context.fetch = async () => ({
    ok: false,
    json: async () => ({ ok: false, error: 'selection failed' }),
  });

  await context.saveLocalCoverFromLookup(sourcePath);

  assert.equal(
    context.state.coverLookup.optimisticAlbumCovers['C:/music/Kaipa/01.mp3'],
    undefined,
  );
  assert.equal(JSON.stringify(refreshedAlbums.at(-1)), JSON.stringify([album]));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const renderCalls = [];
  let pollIndex = 0;
  const matchingCandidateSnapshots = [
    [
      { id: 'candidate-a', url: 'https://images.example/a.jpg' },
      { id: 'candidate-b', url: 'https://images.example/b.jpg' },
      { id: 'candidate-b', url: 'https://images.example/b.jpg' },
    ],
    [
      { id: 'candidate-a', url: 'https://images.example/a.jpg' },
      { id: 'candidate-d', url: 'https://images.example/d.jpg' },
      { id: 'candidate-d', url: 'https://images.example/d.jpg' },
    ],
  ];
  const context = loadHelper({
    fetch: async () => {
      const possibleMatches = matchingCandidateSnapshots[Math.min(pollIndex, 1)];
      pollIndex += 1;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          tasks: [
            {
              id: 'matching-running-task',
              status: 'running',
              progress: 40,
              progress_label: 'Searching providers...',
              possible_matches: possibleMatches,
            },
            {
              id: 'unrelated-running-task',
              status: 'running',
              progress: 60,
              possible_matches: [
                { id: 'candidate-c', url: 'https://images.example/c.jpg' },
              ],
            },
          ],
        }),
      };
    },
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
  });
  context.applyCoverLookupTaskUpdates = () => {};
  context.logCoverLookupTaskDebug = () => {};
  context.getCoverLookupStatusTone = () => 'info';
  context.stopCoverLookupPollingIfIdle = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => renderCalls.push('modal');
  context.state.coverLookup.modal = {
    taskId: 'matching-running-task',
    selectedRemoteId: 'candidate-a',
    possibleMatches: [
      { id: 'candidate-a', url: 'https://images.example/a.jpg' },
    ],
  };
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';

  await context.loadCoverLookupTasks({ toast: false });

  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['candidate-a', 'candidate-b'],
  );
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-a');
  assert.equal(
    context.state.coverLookup.modal.possibleMatches.some((candidate) => candidate.id === 'candidate-c'),
    false,
  );
  assert.deepEqual(renderCalls, ['modal']);

  await context.loadCoverLookupTasks({ toast: false });

  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['candidate-a', 'candidate-d'],
  );
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-a');
  assert.deepEqual(renderCalls, ['modal', 'modal']);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const context = loadHelper({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{
          id: 'metallica-matching-task',
          status: 'running',
          progress: 70,
          possible_matches: [{
            id: 'metallica-deluxe',
            source: 'apple',
            art_kind: 'cover',
            display_only: false,
          }],
        }],
      }),
    }),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
  });
  context.applyCoverLookupTaskUpdates = () => {};
  context.logCoverLookupTaskDebug = () => {};
  context.getCoverLookupStatusTone = () => 'neutral';
  context.stopCoverLookupPollingIfIdle = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {};
  context.state.coverLookup.modal = {
    taskId: 'metallica-matching-task',
    selectedRemoteId: '',
    possibleMatches: [],
  };
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';

  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'metallica-deluxe');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const context = loadHelper({
    getCoverLookupStatusTone: () => 'neutral',
    logCoverLookupTaskDebug: () => {},
  });
  context.state.coverLookup.modal = {
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    possibleMatches: [],
  };

  context.applyCoverLookupGalleryPayload({
    remote_cover: null,
    local_covers: [{
      path: 'C:/music/Artist/Album/cover.jpg',
      is_active: true,
    }],
    other_art: [],
    task: {
      id: 'completed-apple-save',
      status: 'completed',
      notification_action_taken: true,
      selected_candidate_id: 'apple-downloaded',
      possible_matches: [{
        id: 'apple-downloaded',
        source: 'apple',
        art_kind: 'cover',
        display_only: false,
      }],
    },
  });

  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'a downloaded candidate must reopen with canonical local cover active',
  );
  assert.equal(context.getCoverLookupActiveLocalPath(), 'C:/music/Artist/Album/cover.jpg');
}

{
  const context = loadHelper({
    getCoverLookupStatusTone: () => 'neutral',
    logCoverLookupTaskDebug: () => {},
  });
  context.state.coverLookup.modal = {
    statusText: '',
    statusTone: 'neutral',
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    possibleMatches: [],
  };

  context.applyCoverLookupGalleryPayload({
    remote_cover: null,
    local_covers: [],
    other_art: [],
    task: null,
    candidate_snapshot: {
      search_kind: '',
      status: 'failed',
      diagnostic: 'candidate_snapshot_read_failed',
      candidates: [],
    },
  });

  assert.equal(
    context.state.coverLookup.modal.candidateSnapshot.diagnostic,
    'candidate_snapshot_read_failed',
  );
  assert.equal(context.state.coverLookup.modal.statusText, 'candidate_snapshot_read_failed');
  assert.equal(context.state.coverLookup.modal.statusTone, 'error');
}

{
  const context = loadHelper({
    getCoverLookupStatusTone: () => 'neutral',
    logCoverLookupTaskDebug: () => {},
  });
  context.state.coverLookup.modal = {
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    possibleMatches: [],
  };

  context.applyCoverLookupGalleryPayload({
    remote_cover: {
      id: 'saved-spotify',
      url: 'https://i.scdn.co/image/saved-cover',
      source: 'spotify',
      source_label: 'Spotify',
    },
    local_covers: [],
    other_art: [],
    candidate_snapshot: {
      search_generation: 'spotify-gallery-generation',
      search_kind: 'manual',
      status: 'completed',
      best_candidate_id: 'apple-best',
      candidates: [{
        id: 'apple-best',
        url: 'https://images.example/apple-best.jpg',
        source: 'apple',
        art_kind: 'cover',
        display_only: false,
      }],
    },
  });

  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'an active linked remote cover must stay selected when retained candidates load',
  );
  assert.equal(context.state.coverLookup.modal.remoteCover.source, 'spotify');
}

{
  const context = loadHelper({
    getCoverLookupStatusTone: () => 'neutral',
    logCoverLookupTaskDebug: () => {},
  });
  context.state.coverLookup.modal = {
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    possibleMatches: [],
  };

  context.applyCoverLookupGalleryPayload({
    remote_cover: null,
    local_covers: [{
      path: 'C:/music/Flaming Row/The Pure Shine/cover.jpg',
      width: 4518,
      height: 4518,
      is_active: true,
    }],
    other_art: [],
    candidate_snapshot: {
      search_generation: 'bandcamp-progressive-generation',
      search_kind: 'manual',
      status: 'running',
      best_candidate_id: 'bandcamp-1200',
      candidates: [{
        id: 'bandcamp-1200',
        url: 'https://flamingrow.bandcamp.com/the-pure-shine.jpg',
        source: 'bandcamp',
        width: 1200,
        height: 1200,
        art_kind: 'cover',
        display_only: false,
      }],
    },
  });

  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'a progressive provider candidate must not replace the active local cover selection',
  );
  assert.equal(
    context.getCoverLookupActiveLocalPath(),
    'C:/music/Flaming Row/The Pure Shine/cover.jpg',
  );

  context.state.coverLookup.modal.localCovers[0].is_active = false;
  context.state.coverLookup.modal.remoteCover = {
    id: 'linked-existing-cover',
    url: 'https://images.example/linked-existing-cover.jpg',
  };
  context.state.coverLookup.modal.taskId = 'bandcamp-manual-task';
  context.applyCoverLookupCandidateSource({
    generation: 'bandcamp-progressive-generation',
    status: 'running',
    revision: 2,
    bestCandidateId: 'bandcamp-1200',
    candidates: [{
      id: 'bandcamp-1200',
      url: 'https://flamingrow.bandcamp.com/the-pure-shine.jpg',
      source: 'bandcamp',
      width: 1200,
      height: 1200,
      art_kind: 'cover',
      display_only: false,
    }],
  });

  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'the starting local choice must survive refreshed linked metadata for its search generation',
  );
  assert.equal(
    context.getCoverLookupActiveLocalPath(),
    'C:/music/Flaming Row/The Pure Shine/cover.jpg',
    'the starting local card must remain visibly active for its search generation',
  );
}

{
  const activeLocalPath = 'C:/music/Neal Morse/One/CD 1/cover.jpg';
  const context = loadHelper({
    getCoverLookupStatusTone: () => 'neutral',
    logCoverLookupTaskDebug: () => {},
  });
  context.state.coverLookup.modal = {
    album: {
      album_artist: 'Neal Morse',
      name: 'One',
      year: 2004,
      cover_path: activeLocalPath,
    },
    selectedRemoteId: '',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    activeLocalSelectionPath: '',
    possibleMatches: [],
  };

  context.applyCoverLookupGalleryPayload({
    remote_cover: null,
    local_covers: [{
      path: activeLocalPath,
      width: 2400,
      height: 2400,
      is_active: false,
    }],
    other_art: [],
    candidate_snapshot: {
      search_generation: 'apple-progressive-generation',
      search_kind: 'manual',
      status: 'running',
      best_candidate_id: 'apple-2400',
      candidates: [{
        id: 'apple-2400',
        url: 'https://images.example/neal-morse-one-apple.jpg',
        source: 'apple',
        width: 2400,
        height: 2400,
        art_kind: 'cover',
        display_only: false,
      }],
    },
  });

  assert.equal(
    context.getCoverLookupActiveLocalPath(),
    activeLocalPath,
    'the album path identifies the active local cover when gallery metadata does not',
  );
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    '',
    'an equal-size progressive candidate must not replace an album-path local selection',
  );
}

{
  const album = {
    key: 'kaipa::kaipa::1975',
    album_artist: 'Kaipa',
    name: 'Kaipa',
    year: 1975,
    tracks: [{ path: 'C:/music/Kaipa/01.mp3' }],
  };
  const selectedMatch = {
    id: 'kaipa-candidate',
    url: 'https://images.example/kaipa-full.jpg',
    thumbnail_url: 'https://images.example/kaipa-thumbnail.jpg',
    source: 'apple',
  };
  const context = loadHelper({
    getAlbumPathSignature: (value) => (value?.tracks || [])
      .map((track) => String(track?.path || ''))
      .filter(Boolean)
      .sort()
      .join('|'),
    markAlbumCoverPathsFresh: () => {},
    persistCoverLookupNotificationTasks: () => {},
  });
  context.state.coverLookup = {
    modal: { album },
    tasks: [],
    optimisticAlbumCovers: {},
  };
  context.syncCoverLookupAlbumReferences = () => {};
  context.refreshCoverLookupAlbumArtwork = () => {};

  context.applyOptimisticRemoteCoverSelection(album, selectedMatch, '');

  assert.equal(
    context.state.coverLookup.optimisticAlbumCovers['C:/music/Kaipa/01.mp3'].src,
    '/utilities/cover-lookup/remote-image?url=https%3A%2F%2Fimages.example%2Fkaipa-thumbnail.jpg&key=kaipa-candidate',
    'remote selection should reuse the already-rendered candidate preview instead of refetching a new full image',
  );
}

;(async () => {
  const modalElement = {
    hidden: false,
  };
  const bodyElement = {
    innerHTML: '',
  };
  const subtitleElement = {
    textContent: '',
  };
  const statusElement = {
    textContent: '',
    classList: { toggle: () => {} },
  };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': modalElement,
        'cover-lookup-modal-body': bodyElement,
        'cover-lookup-modal-subtitle': subtitleElement,
        'cover-lookup-modal-status': statusElement,
      }[id] || null),
    },
  });
  context.state.coverLookup.modal = {
    album: {
      album_artist: 'Partial Artist',
      name: 'Partial Album',
      year: 2001,
    },
    taskId: 'running-partial-task',
    possibleMatches: [{
      id: 'partial-candidate',
      url: 'https://images.example/partial.jpg',
      source: 'direct_url',
      source_label: 'Direct link',
      lookup_group: 'services',
      art_kind: 'cover',
      filename: 'Partial candidate',
    }],
  };
  context.state.coverLookup.tasks = [{
    id: 'running-partial-task',
    status: 'running',
    progress: 40,
    progress_label: 'Searching providers...',
  }];

  context.renderCoverLookupModal();

  assert.match(
    bodyElement.innerHTML,
    /class="cover-lookup-search-progress"/,
    'running lookup should keep its progress indicator visible',
  );
  assert.match(
    bodyElement.innerHTML,
    /data-select-remote-cover="partial-candidate"/,
    'running lookup should render its selectable partial candidates',
  );
  context.state.coverLookup.tasks[0].status = 'failed';
  context.state.coverLookup.modal.statusTone = 'error';
  context.state.coverLookup.modal.statusText = 'Lookup unavailable';
  context.renderCoverLookupModal();
  assert.match(statusElement.innerHTML, /data-small-alert="error"/);
  assert.doesNotMatch(statusElement.innerHTML, /data-on-page-alert/);
  assert.match(statusElement.innerHTML, /Lookup unavailable/);
  context.state.coverLookup.modal.statusTone = 'neutral';
  context.state.coverLookup.modal.statusText = 'Clipboard image added.';
  context.renderCoverLookupModal();
  assert.equal(statusElement.textContent, 'Clipboard image added.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const deferredResponses = [];
  const context = loadHelper({
    fetch: () => new Promise((resolve) => {
      deferredResponses.push(resolve);
    }),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
  });
  context.applyCoverLookupTaskUpdates = () => {};
  context.logCoverLookupTaskDebug = () => {};
  context.getCoverLookupStatusTone = () => 'info';
  context.stopCoverLookupPollingIfIdle = () => {};
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {};
  context.state.coverLookup.modal = {
    taskId: 'overlapping-running-task',
    selectedRemoteId: 'candidate-b',
    possibleMatches: [],
  };
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';

  const olderPoll = context.loadCoverLookupTasks({ toast: false });
  const newerPoll = context.loadCoverLookupTasks({ toast: false });

  deferredResponses[1]({
    ok: true,
    json: async () => ({
      ok: true,
      tasks: [{
        id: 'overlapping-running-task',
        status: 'running',
        progress: 60,
        progress_label: 'Newer provider result B',
        possible_matches: [{
          id: 'candidate-b',
          url: 'https://images.example/b.jpg',
        }],
      }],
    }),
  });
  await newerPoll;

  assert.equal(context.state.coverLookup.tasks[0].progress_label, 'Newer provider result B');
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['candidate-b'],
  );
  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'candidate-b');

  deferredResponses[0]({
    ok: true,
    json: async () => ({
      ok: true,
      tasks: [{
        id: 'overlapping-running-task',
        status: 'running',
        progress: 30,
        progress_label: 'Older provider result A',
        possible_matches: [{
          id: 'candidate-a',
          url: 'https://images.example/a.jpg',
        }],
      }],
    }),
  });
  await olderPoll;

  assert.equal(
    context.state.coverLookup.tasks[0].progress_label,
    'Newer provider result B',
    'a stale poll must not replace the newer task snapshot',
  );
  assert.deepEqual(
    context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.id),
    ['candidate-b'],
    'a stale poll must not replace the newer partial candidates',
  );
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'candidate-b',
    'a stale poll must preserve the still-valid selection from the newer snapshot',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  await Promise.resolve();
  const { context, clearElement } = createDrawerHarness();
  context.state.coverLookup.tasks = [
    {
      id: 'unactioned-completed-task',
      status: 'completed',
      notification_action_taken: false,
    },
    {
      id: 'unactioned-failed-task',
      status: 'failed',
      notification_action_taken: false,
    },
    {
      id: 'unactioned-canceled-task',
      status: 'canceled',
      notification_action_taken: false,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.equal(clearElement.hidden, false);
  assert.equal(clearElement.disabled, true);
  assert.equal(clearElement.attributes['aria-disabled'], 'true');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  await Promise.resolve();
  const toastCalls = [];
  const { context, clearElement } = createDrawerHarness({
    showToast: (...args) => toastCalls.push(args),
  });

  context.state.coverLookup.tasks = [];
  context.renderCoverLookupDrawer();

  assert.equal(clearElement.hidden, false);
  assert.equal(clearElement.disabled, true);
  assert.equal(clearElement.attributes['aria-disabled'], 'true');
  await context.clearCompletedCoverLookupTasks();
  assert.deepEqual(toastCalls, []);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  await Promise.resolve();
  const toastCalls = [];
  const { context } = createDrawerHarness({
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, removed_count: 0, tasks: [] }),
    }),
    showToast: (...args) => toastCalls.push(args),
  });
  context.state.coverLookup.tasks = [{
    id: 'completed-task',
    status: 'completed',
    notification_action_taken: true,
  }];

  await context.clearCompletedCoverLookupTasks();

  assert.deepEqual(context.state.coverLookup.tasks, []);
  assert.deepEqual(toastCalls, []);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  let resolveFetch;
  const fetchCalls = [];
  const { context, bodyElement, clearElement } = createDrawerHarness({
    fetch: (url, options = {}) => {
      fetchCalls.push({ url, options });
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });
  context.state.coverLookup.tasks = [
    {
      id: 'completed-no-result-task',
      status: 'completed',
      result_kind: 'no-results',
      artist: 'No Result Artist',
      album: 'No Result Album',
      notification_action_taken: false,
    },
    {
      id: 'selected-cover-task',
      status: 'completed',
      result_kind: 'cover-updated',
      job_kind: 'save_remote_selection',
      artist: 'Selected Artist',
      album: 'Selected Album',
      notification_action_taken: true,
    },
    {
      id: 'canceled-task',
      status: 'canceled',
      artist: 'Canceled Artist',
      album: 'Canceled Album',
      notification_action_taken: false,
    },
    {
      id: 'active-provider-task',
      status: 'running',
      artist: 'Active Artist',
      album: 'Still Searching',
      progress: 30,
    },
    {
      id: 'pending-provider-task',
      status: 'pending',
      artist: 'Pending Artist',
      album: 'Waiting To Search',
      progress: 0,
    },
  ];

  context.renderCoverLookupDrawer();
  assert.equal(clearElement.hidden, false);
  const pending = context.clearCompletedCoverLookupTasks();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/utilities/cover-lookup/tasks/clear-completed');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {});
  assert.deepEqual(
    context.state.coverLookup.tasks.map((task) => task.id),
    ['completed-no-result-task', 'canceled-task', 'active-provider-task', 'pending-provider-task'],
  );
  assert.doesNotMatch(bodyElement.innerHTML, /Selected Album/);
  assert.match(bodyElement.innerHTML, /No Result Album/);
  assert.match(bodyElement.innerHTML, /Canceled Album/);
  assert.match(bodyElement.innerHTML, /Still Searching/);
  assert.match(bodyElement.innerHTML, /Waiting To Search/);

  resolveFetch({
    ok: true,
    json: async () => ({
      ok: true,
      removed_count: 1,
      tasks: context.state.coverLookup.tasks,
    }),
  });
  await pending;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const bodyElement = { innerHTML: '' };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': bodyElement,
        'cover-lookup-modal-subtitle': { textContent: '' },
        'cover-lookup-modal-status': { textContent: '', classList: { toggle: () => {} } },
      }[id] || null),
    },
  });
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.modal = {
    album: { album_artist: 'Neal Morse', name: 'Sola Scriptura', year: 2007 },
    loading: false,
    localCovers: [],
    pastedImages: [],
    otherArt: [],
    possibleMatches: [
      {
        id: 'discogs-front',
        source: 'discogs',
        source_label: 'Discogs',
        lookup_group: 'services',
        art_kind: 'cover',
        art_label: 'Front cover',
        url: 'https://images.example/discogs-front.jpg',
      },
      {
        id: 'discogs-booklet',
        source: 'discogs',
        source_label: 'Discogs',
        lookup_group: 'services',
        art_kind: 'other',
        art_label: 'Booklet image 2',
        display_only: true,
        url: 'https://images.example/discogs-booklet.jpg',
      },
      {
        id: 'caa-front',
        source: 'cover_art_archive',
        source_label: 'Cover Art Archive',
        lookup_group: 'cover_art_archive',
        art_kind: 'cover',
        art_label: 'Front cover',
        url: 'https://images.example/caa-front.jpg',
      },
      {
        id: 'caa-booklet',
        source: 'cover_art_archive',
        source_label: 'Cover Art Archive',
        lookup_group: 'cover_art_archive',
        art_kind: 'other',
        art_label: 'Booklet',
        url: 'https://images.example/caa-booklet.jpg',
      },
    ],
    remoteCover: null,
    statusText: '',
    statusTone: 'neutral',
    manualUrlText: '',
    manualBusy: false,
  };

  context.renderCoverLookupModal();

  const discogsHeading = bodyElement.innerHTML.indexOf('>Discogs<');
  const discogsFront = bodyElement.innerHTML.indexOf('data-select-remote-cover="discogs-front"');
  const discogsBooklet = bodyElement.innerHTML.indexOf('data-select-remote-cover="discogs-booklet"');
  const caaHeading = bodyElement.innerHTML.indexOf('>Cover Art Archive<');
  const caaFront = bodyElement.innerHTML.indexOf('data-select-remote-cover="caa-front"');
  const caaBooklet = bodyElement.innerHTML.indexOf('data-select-remote-cover="caa-booklet"');
  assert.ok(discogsHeading >= 0, 'Discogs should have its own provider heading');
  assert.ok(discogsHeading < discogsFront && discogsFront < discogsBooklet && discogsBooklet < caaHeading);
  assert.ok(caaHeading < caaFront && caaFront < caaBooklet);
  assert.match(bodyElement.innerHTML, /data-cover-lookup-provider-group="discogs"/);
  assert.match(bodyElement.innerHTML, /data-cover-lookup-provider-group="cover_art_archive"/);
  assert.doesNotMatch(bodyElement.innerHTML, /is-preview-only[^>]*data-select-remote-cover="discogs-booklet"/);
  assert.doesNotMatch(bodyElement.innerHTML, /is-preview-only[^>]*data-select-remote-cover="caa-booklet"/);
  assert.equal(
    (bodyElement.innerHTML.match(/data-cover-lookup-other-remote-art="1"/g) || []).length,
    2,
    'selectable secondary art should retain its semantic artwork marker',
  );
  assert.equal(
    (bodyElement.innerHTML.match(/class="cover-lookup-art-preview-image"[^>]*loading="lazy"/g) || []).length,
    4,
    'provider candidate previews must not eagerly decode every full-resolution result',
  );
  assert.doesNotMatch(
    bodyElement.innerHTML,
    /class="cover-lookup-art-preview-image"[^>]*loading="eager"/,
  );
  assert.doesNotMatch(bodyElement.innerHTML, />OTHER COVER ART</);
}

{
  let anchorContentTop = 340;
  const bodyElement = {
    scrollTop: 0,
    _innerHTML: '',
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(value) {
      this._innerHTML = value;
      anchorContentTop = value.includes('data-select-remote-cover="new-result"') ? 540 : 340;
      this.scrollTop = 0;
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    querySelectorAll: () => (bodyElement._innerHTML.includes('data-select-remote-cover="stable-result"')
      ? [{
        getAttribute: (name) => (name === 'data-cover-lookup-item-key' ? 'remote:stable-result' : ''),
        getBoundingClientRect: () => ({
          top: anchorContentTop - bodyElement.scrollTop,
          bottom: anchorContentTop - bodyElement.scrollTop + 180,
        }),
      }]
      : []),
  };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    document: {
      getElementById: (id) => ({
        'cover-lookup-modal': { hidden: false },
        'cover-lookup-modal-body': bodyElement,
        'cover-lookup-modal-subtitle': { textContent: '' },
        'cover-lookup-modal-status': { textContent: '', classList: { toggle: () => {} } },
      }[id] || null),
    },
  });
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.modal = {
    album: { album_artist: 'Neal Morse', name: 'Sola Scriptura', year: 2007 },
    loading: false,
    localCovers: [],
    pastedImages: [],
    otherArt: [],
    possibleMatches: [{
      id: 'stable-result',
      source: 'discogs',
      source_label: 'Discogs',
      lookup_group: 'services',
      art_kind: 'cover',
      area: 100,
      url: 'https://images.example/stable.jpg',
    }],
    remoteCover: null,
    statusText: '',
    statusTone: 'neutral',
    manualUrlText: '',
    manualBusy: false,
  };

  context.renderCoverLookupModal();
  bodyElement.scrollTop = 240;
  context.state.coverLookup.modal.possibleMatches.unshift({
    id: 'new-result',
    source: 'discogs',
    source_label: 'Discogs',
    lookup_group: 'services',
    art_kind: 'cover',
    area: 200,
    url: 'https://images.example/new.jpg',
  });
  context.renderCoverLookupModal();

  assert.equal(
    bodyElement.scrollTop,
    440,
    'a progressive result inserted above the visible card must retain that card at the same viewport offset',
  );
}

;(async () => {
  const warnings = [];
  const context = loadHelper({
    document: { getElementById: () => ({ hidden: true }) },
    console: { ...console, warn: (...args) => warnings.push(args) },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{
          id: 'progressive-generation',
          status: 'running',
          progress: 80,
          candidate_revision: 6,
          best_candidate_id: 'unrelated-best',
          possible_matches: [
            { id: 'unrelated-best', url: 'https://images.example/unrelated.jpg' },
            { id: 'persisted-override-id', url: 'https://images.example/a.jpg' },
          ],
        }],
      }),
    }),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
  });
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';
  context.state.coverLookup.modal = {
    taskId: 'progressive-generation',
    candidateGeneration: 'progressive-generation',
    remoteSelectionOverrideGeneration: 'progressive-generation',
    remoteSelectionOverrideCandidateId: 'live-override-id',
    remoteSelectionOverrideUrl: 'https://images.example/a.jpg',
    selectedRemoteId: 'live-override-id',
    possibleMatches: [{ id: 'live-override-id', url: 'https://images.example/a.jpg' }],
    candidateSnapshot: null,
  };

  await context.loadCoverLookupTasks({ toast: false });

  assert.deepEqual(warnings, [], 'successful task polling must reach idle cleanup without a caught error');
  assert.equal(
    context.state.coverLookup.modal.selectedRemoteId,
    'persisted-override-id',
    'running-task polling must rebind the semantic override instead of selecting an unrelated first candidate',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  let resolveGalleryResponse;
  let markGalleryRequested;
  const galleryRequested = new Promise((resolve) => {
    markGalleryRequested = resolve;
  });
  const completedTask = {
    id: 'terminal-publication-generation',
    status: 'completed',
    progress: 100,
    candidate_revision: 7,
    best_candidate_id: 'discogs-primary',
    possible_matches: [
      {
        id: 'discogs-primary',
        source: 'discogs',
        url: 'https://images.example/discogs-primary.jpg',
      },
      {
        id: 'caa-primary',
        source: 'cover_art_archive',
        url: 'https://images.example/caa-primary.jpg',
      },
      {
        id: 'persisted-user-override',
        source: 'direct_url',
        url: 'https://images.example/user-override.jpg',
      },
    ],
  };
  const context = loadHelper({
    fetch: async (url) => {
      if (url === '/utilities/cover-lookup/tasks?limit=50') {
        return {
          ok: true,
          json: async () => ({ ok: true, tasks: [completedTask] }),
        };
      }
      if (url === '/utilities/cover-lookup/gallery') {
        markGalleryRequested();
        return new Promise((resolve) => {
          resolveGalleryResponse = resolve;
        });
      }
      throw new Error(`Unexpected cover lookup request: ${url}`);
    },
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
  });
  context.renderCoverLookupDrawer = () => {};
  context.renderCoverLookupModal = () => {};
  context.applyCoverLookupTaskUpdates = () => {};
  context.logCoverLookupTaskDebug = () => {};
  context.stopCoverLookupPollingIfIdle = () => {};
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.tasksSnapshot = '';
  context.state.coverLookup.modal = {
    album: { album_artist: 'Terminal Artist', name: 'Terminal Album', year: 2026 },
    taskId: 'terminal-publication-generation',
    candidateGeneration: 'terminal-publication-generation',
    remoteSelectionOverrideGeneration: 'terminal-publication-generation',
    remoteSelectionOverrideCandidateId: 'persisted-user-override',
    remoteSelectionOverrideUrl: 'https://images.example/user-override.jpg',
    selectedRemoteId: 'persisted-user-override',
    possibleMatches: [{
      id: 'persisted-user-override',
      source: 'direct_url',
      url: 'https://images.example/user-override.jpg',
    }],
    candidateSnapshot: null,
  };

  const taskPoll = context.loadCoverLookupTasks({ toast: false });
  await galleryRequested;

  let publicationError = null;
  try {
    assert.deepEqual(
      context.state.coverLookup.modal.possibleMatches.map((candidate) => candidate.source),
      ['discogs', 'cover_art_archive', 'direct_url'],
      'a completed task must publish its final provider candidates before the gallery response arrives',
    );
    assert.equal(
      context.state.coverLookup.modal.selectedRemoteId,
      'persisted-user-override',
      'publishing terminal candidates must preserve the user override for the same generation',
    );
  } catch (error) {
    publicationError = error;
  }

  resolveGalleryResponse({
    ok: true,
    json: async () => ({ ok: true, task: completedTask, local_covers: [], other_art: [] }),
  });
  await taskPoll;
  if (publicationError) throw publicationError;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  let resolveFetch;
  const { context } = createDrawerHarness({
    fetch: () => new Promise((resolve) => {
      resolveFetch = resolve;
    }),
  });
  const originalTasks = [
    {
      id: 'completed-no-result-task',
      status: 'completed',
      result_kind: 'no-results',
      artist: 'No Result Artist',
      album: 'No Result Album',
      notification_action_taken: true,
    },
    {
      id: 'failed-task',
      status: 'failed',
      artist: 'Failed Artist',
      album: 'Failed Album',
      notification_action_taken: true,
    },
    {
      id: 'canceled-task',
      status: 'canceled',
      artist: 'Canceled Artist',
      album: 'Canceled Album',
      notification_action_taken: true,
    },
    {
      id: 'active-provider-task',
      status: 'running',
      artist: 'Active Artist',
      album: 'Still Searching',
    },
    {
      id: 'pending-provider-task',
      status: 'pending',
      artist: 'Pending Artist',
      album: 'Waiting To Search',
    },
  ];
  context.state.coverLookup.tasks = originalTasks.map((task) => ({ ...task }));

  const pending = context.clearCompletedCoverLookupTasks();

  assert.deepEqual(
    context.state.coverLookup.tasks.map((task) => task.id),
    ['active-provider-task', 'pending-provider-task'],
  );

  resolveFetch({
    ok: false,
    json: async () => ({ ok: false, error: 'permission denied for table cover_lookup_tasks' }),
  });
  await pending;

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.coverLookup.tasks)),
    originalTasks,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  await Promise.resolve();
  const { context } = createDrawerHarness();
  assert.notEqual(
    context.getCoverLookupStatusTone({
      status: 'completed',
      result_kind: 'no-results',
    }),
    'error',
  );
  assert.equal(context.getCoverLookupStatusTone({ status: 'failed' }), 'error');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  await Promise.resolve();
  const { context, bodyElement } = createDrawerHarness();
  context.state.coverLookup.tasks = [
    {
      id: 'completed-no-result-task',
      status: 'completed',
      result_kind: 'no-results',
      artist: 'No Result Artist',
      album: 'No Result Album',
      progress: 100,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.match(bodyElement.innerHTML, /No covers found/);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const { context, bodyElement } = createDrawerHarness();
  for (const notificationActionTaken of [false, true]) {
    context.state.coverLookup.tasks = [{
      id: 'canceled-task',
      status: 'canceled',
      album: 'Canceled Album',
      artist: 'Canceled Artist',
      notification_action_taken: notificationActionTaken,
    }];

    context.renderCoverLookupDrawer();

    assert.match(
      bodyElement.innerHTML,
      notificationActionTaken
        ? /cover-lookup-task-status-label[^>]*>Art chosen<\/span>/
        : /cover-lookup-task-status-label[^>]*>Canceled<\/span>/,
    );
    assert.match(bodyElement.innerHTML, /data-clear-cover-lookup-task="canceled-task"/);
    assert.doesNotMatch(bodyElement.innerHTML, /data-cancel-cover-lookup-task=/);
    assert.match(bodyElement.innerHTML, /aria-label="Open Cover Look Up: Canceled Album — Canceled Artist"/);
  }
}

{
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    getCoverLookupActiveLocalPath: () => '',
  });
  const savedCover = { id: 'saved-cover', url: 'https://covers.example/saved.jpg' };
  const stagedCover = { id: 'staged-cover', filename: 'staged.png', object_url: 'blob:staged-cover' };
  assert.match(context.buildCoverLookupCard(savedCover, 'saved-remote'), /cover-lookup-art-card is-active/);

  context.state.coverLookup.modal.pendingPastedImageId = stagedCover.id;
  assert.match(context.buildCoverLookupCard(stagedCover, 'pasted'), /cover-lookup-art-card is-active/);
  assert.doesNotMatch(context.buildCoverLookupCard(savedCover, 'saved-remote'), /cover-lookup-art-card is-active/);

  context.state.coverLookup.modal.pendingPastedImageId = '';
  assert.match(context.buildCoverLookupCard(savedCover, 'saved-remote'), /cover-lookup-art-card is-active/);
}

;(async () => {
  await Promise.resolve();
  const { context, bodyElement } = createDrawerHarness();
  context.state.coverLookup.tasks = [
    {
      id: 'running-task',
      status: 'running',
      artist: 'Active Artist',
      album: 'Still Searching',
      progress: 40,
    },
    {
      id: 'completed-no-result-task',
      status: 'completed',
      result_kind: 'no-results',
      artist: 'No Result Artist',
      album: 'No Result Album',
      progress: 100,
    },
    {
      id: 'failed-task',
      status: 'failed',
      artist: 'Failed Artist',
      album: 'Failed Album',
      progress: 100,
      album_payload: { key: 'failed-album' },
    },
  ];

  context.renderCoverLookupDrawer();

  assert.match(
    bodyElement.innerHTML,
    /cover-lookup-task-elapsed[^"]*\bis-active\b[^"]*"[^>]*data-cover-lookup-task-elapsed="running-task"/,
  );
  assert.match(
    bodyElement.innerHTML,
    /cover-lookup-task-elapsed[^"]*\bis-completed\b[^"]*"[^>]*data-cover-lookup-task-elapsed="completed-no-result-task"/,
  );
  assert.match(
    bodyElement.innerHTML,
    /cover-lookup-task-elapsed[^"]*\bis-failed\b[^"]*"[^>]*data-cover-lookup-task-elapsed="failed-task"/,
  );
  assert.match(bodyElement.innerHTML, /data-retry-cover-lookup-task="failed-task"[^>]*aria-label="Retry lookup"[^]*?<svg/);
  assert.match(bodyElement.innerHTML, /data-clear-cover-lookup-task="failed-task"/);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const { context, intervalCalls, clearedIntervals } = createDrawerHarness();
  context.state.coverLookup.tasks = [
    {
      id: 'active-one',
      status: 'running',
      artist: 'Active Artist',
      album: 'First Search',
      created_at: '2026-07-20T12:00:00.000Z',
    },
    {
      id: 'active-two',
      status: 'pending',
      artist: 'Active Artist',
      album: 'Second Search',
      created_at: '2026-07-20T12:00:01.000Z',
    },
  ];

  context.renderCoverLookupDrawer();
  context.renderCoverLookupDrawer();

  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].delay, 1000);
  assert.equal(context.state.coverLookup.elapsedTimer, 1);

  context.state.coverLookup.drawerOpen = false;
  context.renderCoverLookupDrawer();

  assert.deepEqual(clearedIntervals, [1]);
  assert.equal(context.state.coverLookup.elapsedTimer, 0);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

{
  const drawerElement = {
    hidden: false,
    classList: { toggle: () => {} },
  };
  const bodyElement = {
    innerHTML: '',
  };
  const badgeElement = {
    hidden: false,
    textContent: '',
  };
  const buttonElement = {
    classList: { toggle: () => {} },
  };
  const clearElement = {
    hidden: false,
  };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    document: {
      getElementById: (id) => ({
        'cover-lookup-drawer': drawerElement,
        'cover-lookup-drawer-body': bodyElement,
        'cover-lookup-drawer-badge': badgeElement,
        'cover-lookup-drawer-button': buttonElement,
        'cover-lookup-drawer-clear': clearElement,
      }[id] || { hidden: true }),
    },
  });
  context.state.coverLookup.drawerOpen = true;
  context.state.coverLookup.tasks = [
    {
      id: 'completed-task',
      status: 'completed',
      artist: 'Artist',
      album: 'Album',
      year: 2001,
      progress: 100,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.match(bodyElement.innerHTML, /data-clear-cover-lookup-task="completed-task"/);

  context.state.coverLookup.tasks = [
    {
      id: 'running-task',
      status: 'running',
      artist: 'Artist',
      album: 'Album',
      year: 2001,
      progress: 50,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.match(bodyElement.innerHTML, /data-cancel-cover-lookup-task="running-task"/);
  assert.match(
    bodyElement.innerHTML,
    /class="ui-icon action-button__icon ui-icon--close"/,
    'the running-task stop action must use the shared stroked close icon',
  );
}

{
  const drawerElement = {
    hidden: false,
    classList: { toggle: () => {} },
  };
  const bodyElement = {
    innerHTML: '',
  };
  const badgeElement = {
    hidden: false,
    textContent: '',
  };
  const buttonToggleCalls = [];
  const buttonElement = {
    classList: {
      toggle: (className, enabled) => {
        buttonToggleCalls.push([className, enabled]);
      },
    },
  };
  const clearElement = {
    hidden: false,
  };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    document: {
      getElementById: (id) => ({
        'cover-lookup-drawer': drawerElement,
        'cover-lookup-drawer-body': bodyElement,
        'cover-lookup-drawer-badge': badgeElement,
        'cover-lookup-drawer-button': buttonElement,
        'cover-lookup-drawer-clear': clearElement,
      }[id] || { hidden: true }),
    },
  });
  context.state.coverLookup.drawerOpen = true;
  context.state.coverLookup.tasks = [
    {
      id: 'running-task',
      status: 'running',
      artist: 'Artist',
      album: 'Album',
      progress: 30,
    },
    {
      id: 'needs-attention',
      status: 'failed',
      artist: 'Artist',
      album: 'Album',
      progress: 100,
      notification_action_taken: false,
    },
    {
      id: 'actioned-task',
      status: 'completed',
      artist: 'Artist',
      album: 'Album',
      progress: 100,
      notification_action_taken: true,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.equal(badgeElement.hidden, false);
  assert.equal(badgeElement.textContent, '3');
  assert.deepEqual(buttonToggleCalls.at(-1), ['has-active-lookups', true]);

  context.state.coverLookup.tasks = [
    {
      id: 'actioned-task',
      status: 'completed',
      artist: 'Artist',
      album: 'Album',
      progress: 100,
      notification_action_taken: true,
    },
  ];

  context.renderCoverLookupDrawer();

  assert.equal(badgeElement.hidden, false);
  assert.equal(badgeElement.textContent, '1');
  assert.deepEqual(buttonToggleCalls.at(-1), ['has-active-lookups', true]);
}

;(async () => {
  let resolveFetch;
  const drawerElement = {
    hidden: false,
    classList: { toggle: () => {} },
  };
  const bodyElement = {
    innerHTML: '',
  };
  const badgeElement = {
    hidden: false,
    textContent: '',
  };
  const buttonElement = {
    classList: { toggle: () => {} },
  };
  const clearElement = {
    hidden: false,
  };
  const context = loadHelper({
    escapeHtml: (value) => String(value || ''),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    showToast: () => {},
    stopCoverLookupPollingIfIdle: () => {},
    fetch: () => new Promise((resolve) => {
      resolveFetch = resolve;
    }),
    document: {
      getElementById: (id) => ({
        'cover-lookup-drawer': drawerElement,
        'cover-lookup-drawer-body': bodyElement,
        'cover-lookup-drawer-badge': badgeElement,
        'cover-lookup-drawer-button': buttonElement,
        'cover-lookup-drawer-clear': clearElement,
      }[id] || { hidden: true }),
    },
  });
  context.state.coverLookup.drawerOpen = true;
  context.state.coverLookup.modal = { taskId: 'completed-task' };
  context.state.coverLookup.tasksHydrated = true;
  context.state.coverLookup.tasks = [
    {
      id: 'completed-task',
      status: 'completed',
      artist: 'Artist',
      album: 'Album',
      year: 2001,
      progress: 100,
    },
  ];

  context.renderCoverLookupDrawer();
  context.hasActiveCoverLookupDrawerAction = () => true;
  const pending = context.clearCoverLookupTaskNotification('completed-task');

  assert.equal(context.state.coverLookup.tasks.length, 0);
  assert.match(bodyElement.innerHTML, /not looking for anything at the moment/i);

  resolveFetch({
    ok: true,
    json: async () => ({ ok: true, tasks: [] }),
  });
  await pending;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

require('node:test')('successfully clearing one notification is silent', async () => {
  const toastCalls = [];
  const { context } = createDrawerHarness({
    fetch: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/counts')
        ? { ok: true, total_count: 0, active_count: 0, finished_count: 0 }
        : { ok: true, tasks: [] },
    }),
    showToast: (...args) => toastCalls.push(args),
  });
  context.state.coverLookup.tasks = [{ id: 'cleared-task', status: 'completed' }];

  await context.clearCoverLookupTaskNotification('cleared-task');

  assert.deepEqual(toastCalls, []);
});

require('node:test')('initial cover gallery load finishes before task polling starts', async () => {
  class TestButton {}
  const overlay = { hidden: true, classList: { toggle() {} } };
  const saveButton = new TestButton();
  const order = [];
  let finishGallery;
  const context = loadHelper({
    HTMLButtonElement: TestButton,
    document: {
      body: { classList: { add() {} } },
      getElementById: (id) => ({
        'cover-lookup-modal': overlay,
        'cover-lookup-save-remote-button': saveButton,
      }[id] || null),
    },
    showToast: () => {},
  });
  context.renderCoverLookupModal = () => {};
  context.refreshCoverLookupGallery = () => new Promise((resolve) => {
    order.push('gallery');
    finishGallery = resolve;
  });
  context.ensureCoverLookupPolling = () => order.push('poll');

  const opening = context.openCoverLookupModal({ tracks: [{ path: 'C:/music/01.flac' }] });
  await Promise.resolve();
  assert.deepEqual(order, ['gallery']);
  finishGallery();
  await opening;
  assert.deepEqual(order, ['gallery', 'poll']);

  order.length = 0;
  const closedBeforeReady = context.openCoverLookupModal({ tracks: [{ path: 'C:/music/02.flac' }] });
  await Promise.resolve();
  overlay.hidden = true;
  finishGallery();
  await closedBeforeReady;
  assert.deepEqual(order, ['gallery']);
});

require('node:test')('actioned terminal notifications render source-neutral Art chosen status', () => {
  const { context, bodyElement } = createDrawerHarness();
  context.state.coverLookup.tasks = [
    {
      id: 'pasted-zero', status: 'completed', result_kind: 'no-results',
      notification_action_taken: true, artist: 'Artist', album: 'Pasted cover',
    },
    {
      id: 'local-after-failure', status: 'failed',
      notification_action_taken: true, artist: 'Artist', album: 'Local after failure',
    },
    {
      id: 'local-after-cancel', status: 'canceled',
      notification_action_taken: true, artist: 'Artist', album: 'Local after cancel',
    },
    {
      id: 'unresolved-zero', status: 'completed', result_kind: 'no-results',
      notification_action_taken: false, artist: 'Artist', album: 'Unresolved',
    },
    {
      id: 'early-provider-choice', status: 'completed', result_kind: 'cover-updated',
      notification_action_taken: false, artist: 'Artist', album: 'Early choice',
    },
    {
      id: 'early-provider-save', status: 'running', job_kind: 'save_remote_selection',
      notification_action_taken: false, artist: 'Artist', album: 'Early save',
    },
  ];

  context.renderCoverLookupDrawer();

  assert.equal((bodyElement.innerHTML.match(/Art chosen/g) || []).length, 3);
  assert.equal((bodyElement.innerHTML.match(/No covers found/g) || []).length, 1);
  assert.match(bodyElement.innerHTML, /Early choice/);
  assert.match(bodyElement.innerHTML, /Saving art…/);
  assert.doesNotMatch(bodyElement.innerHTML, /Lookup failed|Canceled/);
});


{
  const { install } = require('../../../music_app/static/js/capability-ui.js');
  const policy = install({ getElementById: () => ({ textContent: JSON.stringify({
    allowed_actions: {}, client_surface: 'tv', denied_selectors: [],
    cover_provider_groups: ['services', 'cover_art_archive'],
  }) }) });
  const context = loadHelper({ window: { AlbumHavenCapabilities: policy } });
  const candidates = [
    { id: 'provider', url: 'https://example.test/provider.jpg', lookup_group: 'services' },
    { id: 'manual', url: 'https://example.test/manual.jpg', lookup_group: 'manual_links', source: 'spotify' },
    { id: 'unknown', url: 'https://example.test/unknown.jpg' },
  ];
  assert.deepEqual(Array.from(context.sanitizeCoverLookupPossibleMatches(candidates), item => item.id), ['provider']);
  const modal = context.state.coverLookup.modal;
  modal.possibleMatches = candidates;
  modal.selectedRemoteId = 'provider';
  modal.pendingLocalPath = '';
  context.selectRemoteCoverFromLookup('manual');
  assert.equal(modal.selectedRemoteId, 'provider', 'TV must reject programmatic manual candidate selection');
  context.selectLocalCoverFromLookup('private-cover.jpg');
  assert.equal(modal.pendingLocalPath, '', 'TV must reject programmatic local selection');
}


function savedSourceRevisionContext({ albumRevision = 'saved-revision', saving = false, sourceToken = 1790000000000 } = {}) {
  const context = loadHelper();
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'modal-and-overlay-helpers.js'), 'utf8'), context);
  context.state.coverRefreshTokens = { '/owned/Art/Front.jpg': sourceToken };
  context.state.coverLookup.modal.album = { cover_path: '/owned/cover.jpg', cover_revision: albumRevision };
  context.state.coverLookup.modal.saving = saving;
  return context;
}

require('node:test')('compact local gallery removes only verified initial duplicates and retains desktop and draft choices', () => {
  const body = { innerHTML: '' };
  let compact = true;
  const context = loadHelper({
    escapeHtml: value => String(value || ''),
    usesMobilePageLayout: () => compact,
    document: { getElementById: id => ({
      'cover-lookup-modal': { hidden: false },
      'cover-lookup-modal-body': body,
      'cover-lookup-modal-subtitle': { textContent: '' },
      'cover-lookup-modal-status': { textContent: '', classList: { toggle() {} } },
    }[id] || null) },
  });
  context.state.coverLookup.tasks = [];
  const modal = context.state.coverLookup.modal;
  modal.album = { name: 'Owned album' };
  const covers = [
    { path: '/owned/alternate.jpg' },
    { path: '/owned/original.jpg', duplicate_of: '/owned/cover.jpg' },
    { path: '/owned/cover.jpg', is_active: true },
  ];
  context.applyCoverLookupGalleryPayload({ active_cover_path: '/owned/cover.jpg',
    selected_source_path: '/owned/cover.jpg', local_covers: covers });
  const observed = [];
  context.buildCoverLookupCard = item => { observed.push(item.path); return item.path; };
  function render() { observed.length = 0; context.renderCoverLookupModal(); return [...observed]; }
  const initial = JSON.stringify(modal.localCovers);
  assert.deepEqual(render(), ['/owned/alternate.jpg', '/owned/cover.jpg']);
  assert.match(body.innerHTML, /LOCAL · 2 images/);
  assert.equal(modal.activeLocalSelectionPath, '/owned/cover.jpg');
  compact = false;
  assert.deepEqual(render(), covers.map(item => item.path));
  assert.match(body.innerHTML, /LOCAL · 3 images/);
  modal.pendingLocalPath = '/owned/original.jpg';
  compact = true;
  assert.deepEqual(render(), covers.map(item => item.path), 'an existing desktop draft remains visible after narrowing');
  assert.equal(modal.pendingLocalPath, '/owned/original.jpg');
  modal.pendingLocalPath = '/owned/alternate.jpg';
  assert.deepEqual(render(), ['/owned/alternate.jpg', '/owned/cover.jpg']);
  assert.equal(modal.pendingLocalPath, '/owned/alternate.jpg');
  assert.equal(JSON.stringify(modal.localCovers), initial, 'rendering never discards the file inventory');
  modal.localCovers = [covers[0], covers[1]];
  assert.deepEqual(render(), ['/owned/alternate.jpg', '/owned/original.jpg'], 'an absent canonical representative cannot hide its remaining source');
});
function savedSourceGallery(revision = 'saved-revision') {
  return { active_cover_path: '/owned/cover.jpg', selected_source_path: '/owned/Art/Front.jpg',
    local_covers: [
      { path: '/owned/cover.jpg', is_active: true, cover_revision: revision },
      { path: '/owned/Art/Front.jpg', is_active: false, cover_revision: revision },
    ] };
}

require('node:test')('confirmed saved source revision replaces its older optimistic URL token', () => {
  const context = savedSourceRevisionContext();
  context.applyCoverLookupGalleryPayload(savedSourceGallery());
  assert.equal(context.state.coverRefreshTokens['/owned/Art/Front.jpg'], 'saved-revision');
  assert.equal(new URL(context.buildCoverUrl('/owned/Art/Front.jpg', { size: 480, revision: 'saved-revision' }),
    'http://localhost').searchParams.get('v'), 'saved-revision');
});

for (const [label, values] of [
  ['new save in progress', { albumRevision: 'saved-revision', saving: true, sourceToken: 1790000000001 }],
  ['new unconfirmed selection', { albumRevision: null, saving: false, sourceToken: 1790000000001 }],
  ['new committed selection', { albumRevision: 'new-revision', sourceToken: 'new-revision' }],
]) {
  require('node:test')(`an older source gallery cannot replace the token of a ${label}`, () => {
    const context = savedSourceRevisionContext(values);
    context.applyCoverLookupGalleryPayload(savedSourceGallery());
    assert.equal(context.state.coverRefreshTokens['/owned/Art/Front.jpg'], values.sourceToken);
    assert.equal(context.state.coverLookup.modal.album.cover_revision, values.albumRevision);
  });
}

require('node:test')('publishing album artwork advances the cover mutation revision', () => {
  const original = { key: 'artist::album', tracks: [{ path: '/album/01.flac' }] };
  const updated = { ...original, cover_path: '/album/cover.jpg' };
  const context = loadHelper({
    state: {
      ui: {},
      coverLookup: { modal: { album: original, pastedImages: [], localCovers: [], otherArt: [] } },
    },
    getAlbumTrackPaths: (album) => (album?.tracks || []).map((track) => track.path),
    getUpdatedAlbumForTrackPaths: (albums) => albums[0],
    patchVisibleAlbumsByTrackPath() {},
    refreshRenderedAlbumCoverOnly() {},
    updateTrackModalIfStillShowingAlbum() {},
  });

  context.refreshCoverLookupAlbumArtwork(original, [updated]);

  assert.equal(context.state.ui.albumCoverMutationRevision, 1);
});

require('node:test')('visible service cover previews receive eager browser priority', () => {
  const context = loadHelper({ escapeHtml: value => String(value ?? '') });
  const candidate = {
    id: 'service-candidate',
    source: 'spotify',
    album: 'Provider fixture',
    thumbnail_url: 'https://images.example/thumbnail.jpg',
  };

  const visible = context.buildCoverLookupCard(candidate, 'remote', true);
  const deferred = context.buildCoverLookupCard(candidate, 'remote', false);

  assert.match(visible, /loading="eager" fetchpriority="high"/);
  assert.match(deferred, /loading="lazy" fetchpriority="low"/);
  const deferredImage = deferred.match(/<img class="cover-lookup-art-preview-image"[^>]*>/)?.[0] || '';
  assert.match(deferredImage, /data-cover-lookup-deferred-src="\/utilities\/cover-lookup\/remote-image\?url=https%3A%2F%2Fimages\.example%2Fthumbnail\.jpg/);
  assert.doesNotMatch(deferredImage, /\ssrc=/);
});

require('node:test')('UUID generation formatting retains a progressive remote override', () => {
  const context = loadHelper();
  const generation = '699803380ccd46e0b1fe89fc61de666a';
  context.state.coverLookup.modal = {
    candidateGeneration: generation,
    remoteSelectionOverrideGeneration: generation,
    remoteSelectionOverrideCandidateId: 'user-choice',
    remoteSelectionOverrideUrl: 'https://images.example/user-choice.jpg',
    selectedRemoteId: 'user-choice',
    pendingLocalPath: '',
    pendingPastedImageId: '',
    activeLocalSelectionPath: '',
    localCovers: [],
  };

  context.applyCoverLookupCandidateSource({
    generation: '69980338-0ccd-46e0-b1fe-89fc61de666a',
    bestCandidateId: 'later-best',
    candidates: [
      { id: 'later-best', url: 'https://images.example/later-best.jpg', art_kind: 'cover' },
      { id: 'user-choice', url: 'https://images.example/user-choice.jpg', art_kind: 'cover' },
    ],
  });

  assert.equal(context.state.coverLookup.modal.selectedRemoteId, 'user-choice');
});

require('node:test')('deferred previews start after the prioritized preview loads and paints', () => {
  const context = loadHelper();
  const callbacks = [];
  const listeners = {};
  const priorityImage = {
    complete: false,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const attributes = { 'data-cover-lookup-deferred-src': '/covers/deferred.jpg' };
  const deferredImage = {
    src: '',
    getAttribute: name => attributes[name] || '',
    removeAttribute: name => { delete attributes[name]; },
  };
  const root = {
    querySelector: () => priorityImage,
    querySelectorAll: () => [deferredImage],
  };
  context.window.requestAnimationFrame = callback => { callbacks.push(callback); };

  context.scheduleDeferredCoverLookupPreviews(root);
  assert.equal(deferredImage.src, '');
  listeners.load();
  callbacks.shift()();
  assert.equal(deferredImage.src, '');
  callbacks.shift()();
  assert.equal(deferredImage.src, '/covers/deferred.jpg');
  assert.equal(attributes['data-cover-lookup-deferred-src'], undefined);
});

require('node:test')('deferred previews have a bounded fallback when the prioritized preview stalls', () => {
  const context = loadHelper();
  const frames = [];
  const timeouts = [];
  const priorityImage = {
    complete: false,
    addEventListener() {},
  };
  const attributes = { 'data-cover-lookup-deferred-src': '/covers/deferred.jpg' };
  const deferredImage = {
    src: '',
    getAttribute: name => attributes[name] || '',
    removeAttribute: name => { delete attributes[name]; },
  };
  const root = {
    querySelector: () => priorityImage,
    querySelectorAll: () => [deferredImage],
  };
  context.window.requestAnimationFrame = callback => { frames.push(callback); };
  context.window.setTimeout = (callback, delay) => {
    timeouts.push({ callback, delay });
    return timeouts.length;
  };

  context.scheduleDeferredCoverLookupPreviews(root);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 500);
  timeouts[0].callback();
  frames.shift()();
  frames.shift()();

  assert.equal(deferredImage.src, '/covers/deferred.jpg');
});

require('node:test')('only the first service cover preview receives eager browser priority', () => {
  const bodyElement = { innerHTML: '', scrollTop: 0 };
  const context = loadHelper({ escapeHtml: value => String(value ?? '') });
  context.getCoverLookupModalElements = () => ({
    overlay: {},
    body: bodyElement,
    subtitle: { textContent: '' },
    status: null,
    saveRemote: null,
  });
  context.captureCoverLookupModalScrollAnchor = () => null;
  context.restoreCoverLookupModalScrollAnchor = () => {};
  context.state.coverLookup.modal = {
    album: { album_artist: 'Artist', name: 'Album' },
    loading: false,
    localCovers: [],
    pastedImages: [],
    otherArt: [],
    possibleMatches: Array.from({ length: 4 }, (_value, index) => ({
      id: `service-${index + 1}`,
      source: 'spotify',
      album: 'Provider fixture',
      thumbnail_url: `https://images.example/service-${index + 1}.jpg`,
    })),
  };

  context.renderCoverLookupModal();

  assert.equal((bodyElement.innerHTML.match(/loading="eager" fetchpriority="high"/g) || []).length, 1);
  assert.equal((bodyElement.innerHTML.match(/loading="lazy" fetchpriority="low"/g) || []).length, 3);
});

require('node:test')('loading Cover Lookup renders gallery card placeholders', () => {
  const bodyElement = { innerHTML: '', scrollTop: 0 };
  const context = loadHelper({ escapeHtml: (value) => String(value ?? '') });
  context.getCoverLookupModalElements = () => ({
    overlay: {},
    body: bodyElement,
    subtitle: { textContent: '' },
    status: null,
    saveRemote: null,
  });
  context.state.coverLookup.modal = {
    album: { album_artist: 'Artist', name: 'Album' },
    loading: true,
    expectedRemoteCount: 4,
    localCovers: [],
    pastedImages: [],
    otherArt: [],
    possibleMatches: [],
  };

  context.renderCoverLookupModal();

  assert.match(bodyElement.innerHTML, /cover-lookup-gallery-loading/);
  assert.match(bodyElement.innerHTML, /cover-lookup-task-loading-line/);
  assert.match(bodyElement.innerHTML, />LOCAL</);
  assert.match(bodyElement.innerHTML, />OTHER ART</);
  assert.match(bodyElement.innerHTML, />REMOTE 4 images</);
  assert.equal(
    (bodyElement.innerHTML.match(/data-cover-lookup-loading-section="remote"/g) || []).length,
    4,
  );
  assert.doesNotMatch(bodyElement.innerHTML, /No images in album folder/);
});

require('node:test')('notification polling rerenders when the selected user cover preview changes', async () => {
  let previewUrl = '/cover?album=temple&v=before';
  let renderCount = 0;
  const context = loadHelper({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        tasks: [{
          id: 'temple-task',
          status: 'completed',
          artist: 'Тампль',
          album: 'Премьера на Зиланте 2000',
          notification_action_taken: true,
          current_user_cover_preview_url: previewUrl,
        }],
      }),
    }),
    mergeCoverLookupTasksWithNotifications: (tasks) => tasks,
    updateCoverLookupNotificationCounts: () => {},
    applyCoverLookupTaskUpdates: () => {},
    stopCoverLookupPollingIfIdle: () => {},
  });
  context.state.coverLookup.tasks = [];
  context.state.coverLookup.modal = { taskId: '' };
  context.renderCoverLookupDrawer = () => { renderCount += 1; };

  await context.loadCoverLookupTasks({ toast: false });
  const initialRenderCount = renderCount;
  assert.ok(initialRenderCount > 0);

  previewUrl = '/cover?album=temple&v=selected';
  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(context.state.coverLookup.tasks[0].current_user_cover_preview_url, previewUrl);
  assert.equal(renderCount, initialRenderCount + 1);
});
