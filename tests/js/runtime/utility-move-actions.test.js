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

function createAlbum(moveOverride = {}) {
  return {
    key: 'arrival-album',
    name: 'Tender Buttons',
    album_artist: 'Broadcast',
    move_availability: {
      available_actions: ['move_to_hoard'],
      actions: {
        move_to_hoard: {
          available: true,
          action: 'move_to_hoard',
          target_category: 'hoard',
          destination_path: 'C:\\Library\\Hoard\\2026 Arrivals\\2004 - Broadcast - Tender Buttons',
          destination_folder_name: '2004 - Broadcast - Tender Buttons',
          blocked_reasons: [],
        },
      },
      ...moveOverride,
    },
  };
}

function loadHelper(overrides = {}) {
  const calls = {
    fetchBodies: [],
    fetchAndRender: [],
    toasts: [],
    problematicRefreshes: [],
    trackModalUpdates: [],
    applyUpdatedCalls: 0,
    confirmMessages: [],
    consoleErrors: [],
    consoleLogs: [],
  };
  const context = {
    console: {
      error(...args) {
        calls.consoleErrors.push(args);
      },
      log(...args) {
        calls.consoleLogs.push(args);
      },
    },
    Promise,
    state: {
      view: {
        gallery_scope: 'new_arrivals',
      },
      utility: {
        loaded: true,
      },
    },
    showToast(message, variant, duration) {
      calls.toasts.push([message, variant, duration]);
    },
    showBrowserConfirm(message) {
      calls.confirmMessages.push(message);
      return true;
    },
    getAlbumMoveActionConfig(album, action) {
      return album?.move_availability?.actions?.[action]
        ? {
          action,
          available: Boolean(album.move_availability.actions[action].available),
          targetLabel: album.move_availability.actions[action].target_category === 'hoard' ? 'Hoard' : 'Main Library',
          blockedReasons: Array.isArray(album.move_availability.actions[action].blocked_reasons)
            ? album.move_availability.actions[action].blocked_reasons
            : [],
        }
        : null;
    },
    buildAlbumMoveConfirmMessage(album, actionConfig) {
      return `Move "${album?.name || ''}" to ${actionConfig?.targetLabel || 'Library'}?`;
    },
    async fetch(url, options = {}) {
      calls.fetchBodies.push([url, options.body ? JSON.parse(options.body) : null]);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            updated_album: { key: 'arrival-album', library_root_category: 'hoard' },
            updated_albums: [{ key: 'arrival-album', library_root_category: 'hoard' }],
            updated_problematic_album: null,
            requires_view_refresh: true,
            move_task: {
              kind: 'move-album',
              status: 'completed',
              requires_view_refresh: true,
            },
          };
        },
      };
    },
    buildApiUrl(view) {
      return `/view-data?scope=${encodeURIComponent(String(view?.gallery_scope || 'all'))}`;
    },
    async fetchAndRender(url, push, options) {
      calls.fetchAndRender.push([url, push, options]);
    },
    updateTrackModalIfStillShowingAlbum(album, updatedAlbums) {
      calls.trackModalUpdates.push([album?.key || '', Array.isArray(updatedAlbums) ? updatedAlbums.length : 0]);
    },
    applyRepairResultToProblematicFiles(originalAlbum, updatedProblematicAlbum) {
      calls.problematicRefreshes.push([originalAlbum?.key || '', updatedProblematicAlbum]);
    },
    applyUpdatedAlbumsToCurrentView() {
      calls.applyUpdatedCalls += 1;
    },
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('performAlbumMove posts only album identity and action, then refreshes without optimistic patching', async () => {
  const { context, calls } = loadHelper();

  const result = await context.performAlbumMove(createAlbum(), 'move_to_hoard');

  assert.equal(result, true);
  assert.deepEqual(calls.fetchBodies, [[
    '/utilities/move-album',
    {
      confirmed: true,
      album_key: 'arrival-album',
      action: 'move_to_hoard',
    },
  ]]);
  assert.equal('tracks' in calls.fetchBodies[0][1], false);
  assert.equal('destination_path' in calls.fetchBodies[0][1], false);
  assert.equal(calls.applyUpdatedCalls, 0);
  assert.deepEqual(calls.trackModalUpdates, [['arrival-album', 1]]);
  assert.deepEqual(calls.problematicRefreshes, [['arrival-album', null]]);
  assert.equal(
    JSON.stringify(calls.fetchAndRender),
    JSON.stringify([[
      '/view-data?scope=new_arrivals',
      false,
      { preserveScroll: true },
    ]]),
  );
  assert.deepEqual(calls.toasts.at(-1), ['Album moved to Hoard.', 'success', 3200]);
});

test('performAlbumMove honors explicit no-refresh follow-up metadata', async () => {
  const { context, calls } = loadHelper({
    async fetch(url, options = {}) {
      calls.fetchBodies.push([url, options.body ? JSON.parse(options.body) : null]);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            updated_album: { key: 'arrival-album', library_root_category: 'hoard' },
            updated_albums: [{ key: 'arrival-album', library_root_category: 'hoard' }],
            updated_problematic_album: null,
            requires_view_refresh: false,
            move_task: {
              kind: 'move-album',
              status: 'completed',
              requires_view_refresh: false,
            },
          };
        },
      };
    },
  });

  const result = await context.performAlbumMove(createAlbum(), 'move_to_hoard');

  assert.equal(result, true);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.problematicRefreshes, [['arrival-album', null]]);
});

test('performAlbumMove fails locally for unavailable actions before any request', async () => {
  const blockedAlbum = createAlbum({
    available_actions: [],
    actions: {
      move_to_hoard: {
        available: false,
        target_category: 'hoard',
        blocked_reasons: ['Missing or invalid year metadata blocks move planning.'],
      },
    },
  });
  const { context, calls } = loadHelper();

  const result = await context.performAlbumMove(blockedAlbum, 'move_to_hoard');

  assert.equal(result, false);
  assert.deepEqual(calls.fetchBodies, []);
  assert.deepEqual(calls.toasts.at(-1), ['Missing or invalid year metadata blocks move planning.', 'error', 3200]);
});

test('performAlbumMove surfaces stale server failures without refreshing or optimistic changes', async () => {
  const { context, calls } = loadHelper({
    async fetch(url, options = {}) {
      calls.fetchBodies.push([url, options.body ? JSON.parse(options.body) : null]);
      return {
        ok: false,
        async json() {
          return {
            ok: false,
            error: 'Album is no longer available for moving',
          };
        },
      };
    },
  });

  const result = await context.performAlbumMove(createAlbum(), 'move_to_hoard');

  assert.equal(result, false);
  assert.equal(calls.applyUpdatedCalls, 0);
  assert.deepEqual(calls.problematicRefreshes, []);
  assert.deepEqual(calls.fetchAndRender, []);
  assert.deepEqual(calls.toasts.at(-1), ['Album is no longer available for moving', 'error', 3200]);
});
