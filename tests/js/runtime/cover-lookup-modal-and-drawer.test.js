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
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function createDrawerHarness(overrides = {}) {
  const drawerElement = {
    hidden: false,
    classList: { toggle: () => {} },
  };
  const bodyElement = { innerHTML: '' };
  const badgeElement = { hidden: false, textContent: '' };
  const buttonElement = { classList: { toggle: () => {} } };
  const clearElement = { hidden: false };
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
  context.state.coverLookup.pollingTimer = 0;
  context.state.coverLookup.elapsedTimer = 0;
  return {
    context,
    bodyElement,
    clearElement,
    intervalCalls,
    clearedIntervals,
  };
}

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
    /<div class="cover-lookup-task-open" role="button" tabindex="0" data-open-cover-lookup-task="completed-task">/,
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
  context.loadCoverLookupTasks = async () => {};
  context.refreshCoverLookupGallery = async () => {};

  await context.openCoverLookupModal(secondAlbum, { taskId: 'flaming-row-lookup' });
  await context.startCoverLookupForAlbum(secondAlbum);

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    album: secondAlbum,
    manual_urls: [],
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
        tasks: [{ id: 'task-1', status: 'failed' }],
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
  context.state.coverLookup.drawerOpen = true;
  context.state.coverLookup.modal = { taskId: '' };

  await context.loadCoverLookupTasks({ toast: false });

  assert.equal(context.state.coverLookup.tasks[0].notification_action_taken, true);
  assert.match(bodyElement.innerHTML, /Art chosen/);
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
    'candidate-d',
    'a new generation resets the pending override and auto-selects its best candidate',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

;(async () => {
  const intervalCalls = [];
  const requestUrls = [];
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
      if (url === '/utilities/cover-lookup/tasks') {
        return { ok: true, json: async () => ({ ok: true, tasks: [] }) };
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
  await Promise.resolve(intervalCalls[0].callback());
  await Promise.resolve();

  assert.equal(
    requestUrls.filter((url) => url === '/utilities/cover-lookup/gallery').length,
    2,
    'a running automatic snapshot must keep refreshing the open gallery without a task',
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
  const context = loadHelper({
    deepCloneJson: (value) => JSON.parse(JSON.stringify(value)),
    showToast: () => {},
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
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    task_ids: ['completed-no-result-task', 'failed-task', 'canceled-task'],
  });
  assert.deepEqual(
    context.state.coverLookup.tasks.map((task) => task.id),
    ['active-provider-task', 'pending-provider-task'],
  );
  assert.doesNotMatch(bodyElement.innerHTML, /No Result Album|Failed Album|Canceled Album/);
  assert.match(bodyElement.innerHTML, /Still Searching/);
  assert.match(bodyElement.innerHTML, /Waiting To Search/);

  resolveFetch({
    ok: true,
    json: async () => ({
      ok: true,
      removed_count: 3,
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
  const discogsBooklet = bodyElement.innerHTML.indexOf('data-cover-lookup-other-remote-art="1"', discogsFront);
  const caaHeading = bodyElement.innerHTML.indexOf('>Cover Art Archive<');
  const caaFront = bodyElement.innerHTML.indexOf('data-select-remote-cover="caa-front"');
  const caaBookletUrl = bodyElement.innerHTML.indexOf('caa-booklet.jpg');
  assert.ok(discogsHeading >= 0, 'Discogs should have its own provider heading');
  assert.ok(discogsHeading < discogsFront && discogsFront < discogsBooklet && discogsBooklet < caaHeading);
  assert.ok(caaHeading < caaFront && caaFront < caaBookletUrl);
  assert.match(bodyElement.innerHTML, /data-cover-lookup-provider-group="discogs"/);
  assert.match(bodyElement.innerHTML, /data-cover-lookup-provider-group="cover_art_archive"/);
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
  const context = loadHelper({
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
      if (url === '/utilities/cover-lookup/tasks') {
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

  assert.match(bodyElement.innerHTML, /Completed — no result/);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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
  assert.equal(badgeElement.textContent, '2');
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

  assert.equal(badgeElement.hidden, true);
  assert.equal(badgeElement.textContent, '');
  assert.deepEqual(buttonToggleCalls.at(-1), ['has-active-lookups', false]);
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
