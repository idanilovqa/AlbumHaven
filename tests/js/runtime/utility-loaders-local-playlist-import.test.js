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
  'utility-loaders-and-cover-lookup.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function createContext(overrides = {}) {
  const calls = {
    fetches: [],
    renders: 0,
  };
  const context = {
    FormData: class FormData {
      constructor() {
        this.fields = [];
      }

      append(key, value) {
        this.fields.push([key, value]);
      }
    },
    state: {
      utility: {
        localPlaylistImport: {
          selectedFile: null,
          selectedFileName: '',
          analyzeBusy: false,
          error: '',
          lastAnalysis: null,
        },
      },
    },
    fetch: async (url, options = {}) => {
      calls.fetches.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            analysis: {
              status: { key: 'preview_contract_ready' },
            },
          };
        },
      };
    },
    getSelectedUtilityIntegration() {
      return {
        key: 'local_playlist_import',
        analyze_route: '/custom/analyze',
      };
    },
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    showToast() {},
    console,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('selecting a local playlist file clears the previous analysis preview', () => {
  const { context } = createContext();
  context.state.utility.localPlaylistImport = {
    selectedFile: { name: 'old.fpl' },
    selectedFileName: 'old.fpl',
    analyzeBusy: false,
    error: 'Previous error',
    lastAnalysis: {
      source: { filename: 'old.fpl' },
    },
  };

  const nextFile = { name: 'next.m3u' };
  context.handleLocalPlaylistImportFileSelection(nextFile);

  assert.equal(context.state.utility.localPlaylistImport.selectedFile, nextFile);
  assert.equal(context.state.utility.localPlaylistImport.selectedFileName, 'next.m3u');
  assert.equal(context.state.utility.localPlaylistImport.error, '');
  assert.equal(context.state.utility.localPlaylistImport.lastAnalysis, null);
});

test('local playlist analysis uses the route advertised by the integration payload', async () => {
  const { context, calls } = createContext();
  const selectedFile = { name: 'next.m3u' };
  context.state.utility.localPlaylistImport = {
    selectedFile,
    selectedFileName: 'next.m3u',
    analyzeBusy: false,
    error: '',
    lastAnalysis: null,
  };

  await context.runLocalPlaylistImportAnalysis();

  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].url, '/custom/analyze');
  assert.equal(calls.fetches[0].options.method, 'POST');
  assert.deepEqual(context.state.utility.localPlaylistImport.lastAnalysis, {
    status: { key: 'preview_contract_ready' },
  });
});

test('tag editor selection render preserves live track buttons during a pointer gesture', () => {
  const paths = ['C:\\Music\\Album\\01.mp3', 'C:\\Music\\Album\\02.mp3'];
  const buttons = paths.map((path) => {
    const classes = new Set();
    const attributes = {
      'data-tag-editor-track': path,
      'aria-pressed': 'false',
    };
    return {
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      getAttribute(name) {
        return attributes[name] || '';
      },
      querySelector() {
        return null;
      },
      setAttribute(name, value) {
        attributes[name] = String(value);
      },
      classes,
      attributes,
    };
  });
  const list = {
    innerHTML: 'unchanged live track buttons',
    querySelectorAll() {
      return buttons;
    },
  };
  const elements = {
    overlay: {},
    list,
    form: {
      querySelectorAll() {
        return [];
      },
    },
    subtitle: { textContent: '' },
    artwork: { innerHTML: '' },
  };
  const { context } = createContext({
    state: {
      tagEditor: {
        album: { name: 'Album' },
        tracks: paths.map((path) => ({ path })),
        selectedPaths: [...paths],
        selectedPath: paths[0],
        values: {},
      },
    },
    escapeHtml(value) {
      return String(value);
    },
    getFilenameFromPath(path) {
      return String(path).split('\\').pop();
    },
    getFileTypeFromPath() {
      return 'MP3';
    },
    getTagEditorElements() {
      return elements;
    },
  });

  context.renderTagEditor({ preserveTrackList: true });

  assert.equal(list.innerHTML, 'unchanged live track buttons');
  assert.equal(elements.subtitle.textContent, 'Album - 2 files in editor - 2 selected');
  assert.deepEqual(buttons.map((button) => button.attributes['aria-pressed']), ['true', 'true']);
  assert.deepEqual(buttons.map((button) => button.classes.has('is-active')), [true, true]);
});

test('failed Last.fm connection marks previously loaded log history stale', async () => {
  const { context } = createContext({
    console: {
      error() {},
      log() {},
      warn() {},
    },
    fetch: async () => ({
      ok: false,
      async json() {
        return {
          ok: false,
          error: 'Invalid username or password (Last.fm error 4)',
        };
      },
    }),
  });
  context.state.utility = {
    integrationDrafts: {
      lastfm: {
        username: 'fixture_listener',
        password: 'fixture-password',
        timezone: 'America/Denver',
      },
    },
    integrations: [],
    integrationsLoaded: true,
    logHistoryLoaded: true,
  };

  await context.saveLastfmIntegration();

  assert.equal(context.state.utility.logHistoryLoaded, false);
});

test('log history loader merges the atomic server snapshot and returns its revision', async () => {
  const serverEntry = {
    id: 'server-entry-1',
    action: 'Scan file error',
  };
  const browserEntry = {
    id: 'browser-entry-1',
    action: 'Earlier browser event',
  };
  const mergedItems = [serverEntry, browserEntry];
  const persistedSnapshots = [];
  const { context, calls } = createContext({
    async requestBrowserLogHistoryPersistentStorage() {
      return true;
    },
    async persistBrowserLogHistoryEntries(items) {
      persistedSnapshots.push(items);
      return {
        items: mergedItems,
        status: { persistent: true, storage: 'indexeddb' },
      };
    },
    fetch: async (url, options = {}) => {
      calls.fetches.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true, items: [serverEntry], revision: 'process-a:7' };
        },
      };
    },
  });
  context.state.utility = {
    logHistory: [],
    logHistoryLoaded: false,
    logHistoryLoading: false,
    logHistoryLoadPromise: null,
    logHistoryRevision: '',
    selectedLogHistoryId: '',
  };

  const revision = await context.loadUtilityLogHistory(true);

  assert.equal(revision.revision, 'process-a:7');
  assert.equal(context.state.utility.logHistoryRevision, 'process-a:7');
  assert.deepEqual(persistedSnapshots, [[serverEntry]]);
  assert.deepEqual(context.state.utility.logHistory, mergedItems);
  assert.equal(context.state.utility.logHistoryLoaded, true);
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].options.cache, 'no-store');
});

test('background log history synchronization does not replace active loop playback controls', async () => {
  const { context, calls } = createContext({
    async requestBrowserLogHistoryPersistentStorage() {
      return true;
    },
    async persistBrowserLogHistoryEntries(items) {
      return {
        items,
        status: { persistent: true, storage: 'indexeddb' },
      };
    },
  });
  context.state.utility = {
    activeTab: 'loops',
    logHistory: [],
    logHistoryLoaded: false,
    logHistoryLoading: false,
    logHistoryLoadPromise: null,
    logHistoryRevision: '',
    selectedLogHistoryId: '',
  };

  await context.loadUtilityLogHistory(true);

  assert.equal(calls.renders, 0);
});


test('log history revision sync follows a newer target queued during an in-flight load', async () => {
  const { context, calls } = createContext();
  const pendingLoads = [];
  context.state.utility = {
    logHistory: [],
    logHistoryLoaded: true,
    logHistoryLoading: false,
    logHistoryLoadPromise: null,
    logHistoryRevision: '',
    logHistoryTargetRevision: '',
    logHistorySyncPromise: null,
  };
  context.loadUtilityLogHistory = (force = false) => {
    calls.fetches.push({ force });
    const requestedRevision = String(context.state.utility.logHistoryTargetRevision || '');
    return new Promise((resolve) => {
      pendingLoads.push({
        requestedRevision,
        resolve() {
          context.state.utility.logHistoryRevision = requestedRevision;
          resolve({ revision: requestedRevision });
        },
      });
    });
  };

  const firstSync = context.syncUtilityLogHistoryRevision('process-a:1');
  await Promise.resolve();
  const secondSync = context.syncUtilityLogHistoryRevision('process-a:2');
  assert.equal(pendingLoads.length, 1);
  assert.equal(pendingLoads[0].requestedRevision, 'process-a:1');

  pendingLoads[0].resolve();
  for (let attempt = 0; attempt < 5 && pendingLoads.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(pendingLoads.length, 2);
  assert.equal(pendingLoads[1].requestedRevision, 'process-a:2');

  pendingLoads[1].resolve();
  await Promise.all([firstSync, secondSync]);

  assert.equal(context.state.utility.logHistoryRevision, 'process-a:2');
  assert.equal(context.state.utility.logHistorySyncPromise, null);
  assert.deepEqual(calls.fetches, [{ force: true }, { force: true }]);
});

test('snapshot failure retains browser-owned history and its persistence status', async () => {
  let persistenceRequests = 0;
  const storedEntry = {
    id: 'browser-entry-1',
    action: 'Earlier browser event',
    source: 'this_browser',
    source_label: 'This browser',
  };
  const storageStatus = {
    persistent: true,
    storage: 'indexeddb',
    message: 'Stored in this browser.',
  };
  const { context, calls } = createContext({
    console: { error() {}, log() {}, warn() {} },
    fetch: async (url, options = {}) => {
      calls.fetches.push({ url, options });
      throw new Error('Transient snapshot unavailable');
    },
    async requestBrowserLogHistoryPersistentStorage() {
      persistenceRequests += 1;
      return false;
    },
    async readBrowserLogHistoryEntries() {
      return { items: [storedEntry], status: storageStatus };
    },
  });
  context.state.utility = {
    logHistory: [],
    logHistoryLoaded: false,
    logHistoryLoading: false,
    logHistoryLoadPromise: null,
    selectedLogHistoryId: '',
  };
  await context.loadUtilityLogHistory(true);
  assert.equal(persistenceRequests, 1);
  assert.equal(calls.fetches.length, 1);
  assert.equal(calls.fetches[0].url, '/utilities/log-history');
  assert.equal(calls.fetches[0].options.cache, 'no-store');
  assert.deepEqual(context.state.utility.logHistory, [storedEntry]);
  assert.equal(context.state.utility.logHistoryLoaded, true);
  assert.deepEqual(context.state.utility.logHistoryStorageStatus, storageStatus);
});
