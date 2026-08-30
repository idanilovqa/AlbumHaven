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
  'library-settings.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers(overrides = {}) {
  const calls = {
    fetches: [],
    toasts: [],
    statusUpdates: [],
    renders: 0,
    libraryLoaderRenders: 0,
    scheduledPolls: [],
    viewRefreshes: [],
  };
  const context = {
    console,
    cloneRuntimeJson(value, fallback = null) {
      return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
    },
    escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    },
    state: {
      wasPollingBusy: false,
      wasCoverPollingBusy: false,
      status: {},
      utility: {
        loaded: true,
        problematicFiles: [{ key: 'old-problem' }],
        integrations: [{
          key: 'lastfm',
          title: 'Last.fm',
          description: 'Scrobbling',
          connected: true,
          api_configured: true,
        }],
        librarySettings: {
          settings: null,
          draft: null,
          loaded: false,
          loading: false,
          loadPromise: null,
          saveBusy: false,
          albumRatingImportBusy: false,
          albumRatingImportResult: null,
          error: '',
        },
      },
      view: {
        query: 'Rating Import Candidate',
      },
    },
    buildApiUrl(view) {
      return `/api?query=${encodeURIComponent(String(view?.query || ''))}`;
    },
    async fetchAndRender(url, force, options) {
      calls.viewRefreshes.push([url, force, options]);
    },
    showToast(message, tone, duration) {
      calls.toasts.push([message, tone, duration]);
    },
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    updateStatusIndicator(status) {
      calls.statusUpdates.push(status);
      context.state.status = status;
    },
    renderLibraryLoader(status) {
      calls.libraryLoaderRenders += 1;
      context.state.status = status;
    },
    scheduleBrowserTimeout(callback, delay) {
      calls.scheduledPolls.push(delay);
      if (callback === context.pollStatus) {
        calls.scheduledPolls.push('pollStatus');
      }
    },
    pollStatus() {},
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      if (url === '/library-settings' && (!options.method || options.method === 'GET')) {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              settings: {
                version: 1,
                main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
                hoarding_library_roots: [],
                new_arrivals_roots: [],
                move_policy: {},
              },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            settings: {
              version: 1,
              main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
              hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
              new_arrivals_roots: [],
              move_policy: { preferred_main_write_root: 'main-1', move_new_arrivals_to: 'hoard-1' },
            },
            status: {
              scan_in_progress: true,
              relations_in_progress: false,
              covers_in_progress: false,
              scan_mode: 'library_settings_update',
            },
            refresh_started: true,
          };
        },
      };
    },
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('loadUtilityLibrarySettings stores normalized settings and drafts', async () => {
  const { context, calls } = loadHelpers();

  const settings = await context.loadUtilityLibrarySettings(true);

  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(settings.main_library_roots[0].path, 'C:\\Music');
  assert.equal(context.state.utility.librarySettings.loaded, true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].layout_mode, 'artist');
});

test('saveUtilityLibrarySettings posts draft, clears stale problematic state, and starts polling', async () => {
  const { context, calls } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: 'main-1', move_new_arrivals_to: 'hoard-1' },
  };

  const result = await context.saveUtilityLibrarySettings();

  assert.equal(result, true);
  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(calls.fetches[0][1].method, 'POST');
  assert.equal(
    JSON.stringify(JSON.parse(calls.fetches[0][1].body)),
    JSON.stringify({ settings: context.state.utility.librarySettings.draft }),
  );
  assert.equal(context.state.utility.loaded, false);
  assert.equal(JSON.stringify(context.state.utility.problematicFiles), '[]');
  assert.equal(context.state.wasPollingBusy, true);
  assert.deepEqual(calls.statusUpdates[0], {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
    scan_mode: 'library_settings_update',
  });
  assert.deepEqual(calls.toasts.at(-1), ['Library settings saved. Scan started.', 'success', 3200]);
  assert.ok(calls.scheduledPolls.includes('pollStatus'));
});

test('handleLibrarySettingsIntegrationSelection loads the library settings detail when the library integration is selected', async () => {
  const { context, calls } = loadHelpers();

  const handled = await context.handleLibrarySettingsIntegrationSelection('library');

  assert.equal(handled, true);
  assert.equal(context.state.utility.selectedIntegrationKey, 'library');
  assert.equal(calls.fetches[0][0], '/library-settings');
  assert.equal(context.state.utility.librarySettings.loaded, true);
  assert.ok(calls.renders >= 2);
});

test('handleLibrarySettingsClick routes library settings actions through the feature seam', async () => {
  const { context } = loadHelpers();
  const routedCalls = [];
  context.addLibraryRootDraftEntry = (category) => routedCalls.push(['add', category]);
  context.removeLibraryRootDraftEntry = (category, index) => routedCalls.push(['remove', category, index]);
  context.loadUtilityLibrarySettings = (force) => routedCalls.push(['reload', force]);
  context.saveUtilityLibrarySettings = () => routedCalls.push(['save']);
  context.importAlbumRatingsFromFileTags = () => routedCalls.push(['import-album-ratings']);

  const addEvent = {
    target: {
      closest(selector) {
        if (selector === '[data-add-library-root]') {
          return {
            getAttribute(name) {
              return name === 'data-add-library-root' ? 'main_library_roots' : '';
            },
          };
        }
        return null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'add']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(addEvent), true);

  const removeEvent = {
    target: {
      closest(selector) {
        if (selector === '[data-remove-library-root]') {
          return {
            getAttribute(name) {
              if (name === 'data-remove-library-root') return 'hoarding_library_roots';
              if (name === 'data-library-root-index') return '2';
              return '';
            },
          };
        }
        return null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'remove']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(removeEvent), true);

  const reloadEvent = {
    target: {
      closest(selector) {
        return selector === '[data-reload-library-settings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'reload']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(reloadEvent), true);

  const importAlbumRatingsEvent = {
    target: {
      closest(selector) {
        return selector === '[data-import-album-ratings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'import-album-ratings']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(importAlbumRatingsEvent), true);

  const saveEvent = {
    target: {
      closest(selector) {
        return selector === '[data-save-library-settings="1"]' ? {} : null;
      },
    },
    preventDefault() {
      routedCalls.push(['prevented', 'save']);
    },
  };
  assert.equal(context.handleLibrarySettingsClick(saveEvent), true);

  assert.deepEqual(routedCalls, [
    ['prevented', 'add'],
    ['add', 'main_library_roots'],
    ['prevented', 'remove'],
    ['remove', 'hoarding_library_roots', 2],
    ['prevented', 'reload'],
    ['reload', true],
    ['prevented', 'import-album-ratings'],
    ['import-album-ratings'],
    ['prevented', 'save'],
    ['save'],
  ]);
});

test('handleLibrarySettingsInput updates draft fields for text inputs', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: '', move_new_arrivals_to: '' },
  };

  const rootInputEvent = {
    target: {
      value: 'E:\\Library',
      closest(selector) {
        if (selector === '[data-library-root-field]') {
          return {
            value: 'E:\\Library',
            getAttribute(name) {
              if (name === 'data-library-root-list') return 'main_library_roots';
              if (name === 'data-library-root-index') return '0';
              if (name === 'data-library-root-field') return 'path';
              return '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsInput(rootInputEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].path, 'E:\\Library');

  const policyInputEvent = {
    target: {
      value: 'main-1',
      closest(selector) {
        if (selector === '[data-library-settings-field]') {
          return {
            value: 'main-1',
            getAttribute(name) {
              return name === 'data-library-settings-field' ? 'preferred_main_write_root' : '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsInput(policyInputEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.move_policy.preferred_main_write_root, 'main-1');
});

test('handleLibrarySettingsChange updates draft fields for select inputs', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;
  context.state.utility.librarySettings.draft = {
    version: 1,
    main_library_roots: [{ id: 'main-1', path: 'C:\\Music', layout_mode: 'artist' }],
    hoarding_library_roots: [{ id: 'hoard-1', path: 'D:\\Hoard' }],
    new_arrivals_roots: [],
    move_policy: { preferred_main_write_root: '', move_new_arrivals_to: '' },
  };

  const layoutSelectEvent = {
    target: {
      closest(selector) {
        if (selector === 'select[data-library-root-field]') {
          return {
            value: 'genre/artist',
            getAttribute(name) {
              if (name === 'data-library-root-list') return 'main_library_roots';
              if (name === 'data-library-root-index') return '0';
              if (name === 'data-library-root-field') return 'layout_mode';
              return '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsChange(layoutSelectEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.main_library_roots[0].layout_mode, 'genre/artist');

  const movePolicySelectEvent = {
    target: {
      closest(selector) {
        if (selector === 'select[data-library-settings-field]') {
          return {
            value: 'hoard-1',
            getAttribute(name) {
              return name === 'data-library-settings-field' ? 'move_new_arrivals_to' : '';
            },
          };
        }
        return null;
      },
    },
  };
  assert.equal(context.handleLibrarySettingsChange(movePolicySelectEvent), true);
  assert.equal(context.state.utility.librarySettings.draft.move_policy.move_new_arrivals_to, 'hoard-1');
});

test('buildUtilityLibrarySettingsDetail exposes the explicit album-rating import action', () => {
  const { context } = loadHelpers();
  context.state.utility.librarySettings.loaded = true;

  const markup = context.buildUtilityLibrarySettingsDetail();

  assert.match(markup, /data-import-album-ratings="1"/);
  assert.match(markup, />Import ratings from file tags<\/button>/);
  assert.doesNotMatch(markup, /data-album-rating-import-result="1"/);
});

test('importAlbumRatingsFromFileTags posts to Library Settings and renders exact result counts on repeat actions', async () => {
  const responses = [
    { ok: true, created: 2, authority_skipped: 3, failed: 1 },
    { ok: true, created: 0, authority_skipped: 5, failed: 0 },
  ];
  const { context, calls } = loadHelpers({
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      const payload = responses.shift();
      return {
        ok: true,
        async json() {
          return payload;
        },
      };
    },
  });
  context.state.utility.librarySettings.loaded = true;

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 2, authority_skipped: 3, failed: 1 },
  );
  assert.equal(calls.viewRefreshes.length, 1);
  assert.equal(calls.viewRefreshes[0][0], '/api?query=Rating%20Import%20Candidate');
  assert.equal(calls.viewRefreshes[0][1], false);
  assert.equal(
    JSON.stringify(calls.viewRefreshes[0][2]),
    JSON.stringify({ preserveScroll: true }),
  );
  assert.match(
    context.buildUtilityLibrarySettingsDetail(),
    /data-album-rating-import-result="1">Created: 2 · Authority skipped: 3 · Failed: 1<\/div>/,
  );

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.equal(calls.fetches.length, 2);
  assert.equal(calls.viewRefreshes.length, 1);
  calls.fetches.forEach(([url, options]) => {
    assert.equal(url, '/library-settings/import-album-ratings');
    assert.equal(options.method, 'POST');
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 0, authority_skipped: 5, failed: 0 },
  );
});

test('importAlbumRatingsFromFileTags keeps a successful import authoritative when view refresh fails', async () => {
  const { context, calls } = loadHelpers({
    async fetch() {
      return {
        ok: true,
        async json() {
          return { ok: true, created: 2, authority_skipped: 3, failed: 1 };
        },
      };
    },
    async fetchAndRender() {
      throw new Error('refresh unavailable');
    },
  });

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 2, authority_skipped: 3, failed: 1 },
  );
  assert.equal(context.state.utility.librarySettings.error, '');
  assert.deepEqual(calls.toasts, [
    ['Album ratings were imported, but the current view could not be refreshed.', 'warning', 3600],
  ]);
});

test('importAlbumRatingsFromFileTags guards concurrent clicks and exposes busy state', async () => {
  let releaseResponse;
  const { context, calls } = loadHelpers({
    fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      return new Promise((resolve) => {
        releaseResponse = () => resolve({
          ok: true,
          async json() {
            return { ok: true, created: 1, authority_skipped: 0, failed: 0 };
          },
        });
      });
    },
  });
  context.state.utility.librarySettings.loaded = true;

  const firstImport = context.importAlbumRatingsFromFileTags();
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, true);
  assert.equal(await context.importAlbumRatingsFromFileTags(), false);
  assert.equal(calls.fetches.length, 1);
  const busyMarkup = context.buildUtilityLibrarySettingsDetail();
  const busyButton = busyMarkup.match(/<button[^>]*data-import-album-ratings="1"[^>]*>[^<]*<\/button>/)?.[0] || '';
  assert.match(busyButton, /disabled/);
  assert.match(busyButton, />Importing ratings\.\.\.<\/button>/);

  releaseResponse();
  assert.equal(await firstImport, true);
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, false);
});

test('importAlbumRatingsFromFileTags clears its busy error state so a failed action can be retried', async () => {
  let attempt = 0;
  const { context, calls } = loadHelpers({
    async fetch(url, options = {}) {
      calls.fetches.push([url, options]);
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          async json() {
            return { ok: false, error: 'Album rating import failed.' };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { ok: true, created: 1, authority_skipped: 2, failed: 0 };
        },
      };
    },
  });
  context.state.utility.librarySettings.loaded = true;

  assert.equal(await context.importAlbumRatingsFromFileTags(), false);
  assert.equal(context.state.utility.librarySettings.albumRatingImportBusy, false);
  assert.equal(context.state.utility.librarySettings.error, 'Album rating import failed.');
  assert.deepEqual(calls.toasts.at(-1), ['Album rating import failed.', 'error', 3600]);
  const retryMarkup = context.buildUtilityLibrarySettingsDetail();
  const retryButton = retryMarkup.match(/<button[^>]*data-import-album-ratings="1"[^>]*>[^<]*<\/button>/)?.[0] || '';
  assert.match(retryButton, /data-import-album-ratings="1"/);
  assert.doesNotMatch(retryButton, /disabled/);

  assert.equal(await context.importAlbumRatingsFromFileTags(), true);
  assert.equal(calls.fetches.length, 2);
  assert.equal(context.state.utility.librarySettings.error, '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.librarySettings.albumRatingImportResult)),
    { created: 1, authority_skipped: 2, failed: 0 },
  );
});
