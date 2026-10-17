'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installPrivateContext} = require('./private-context-harness.cjs');
const {id, mixMetadata} = require('./library-mix-fixtures.cjs');
const root = path.resolve(__dirname, '../../..');
const response = data => ({ok: true, status: 200, json: async () => data});
const row = (index, patch = {}) => ({playlist_item_id: id(10 + index), title: `Track ${index}`, artist: 'Artist', album_title: 'Album',
  availability: 'local', source_readable: true, allowed_actions: {can_read: true, can_play: true}, ...patch});
function payload(patch = {}) {
  return {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: id(80), items: [{playlist_id: id(80), title: 'Saved mix', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: id(80), revision: '1', playlist_kind: 'library_mix', library_mix: mixMetadata(),
      allowed_actions: {can_play: true}, track_rows: [row(1, {play_count: 9}), row(2, {play_count: 0}), row(3)], ...patch}};
}
function nativeFixture(data = payload()) {
  const native = createNativeHomeRuntime(), {context: c, document} = native;
  const calls = {requests: [], starts: [], activations: [], prepared: []};
  const add = (id, tag = 'div') => {const node = document.createElement(tag); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('app-shell'); shell.dataset.nativeAccountId = '4'; shell.dataset.nativeLibraryId = '5';
  const host = add('playlists-root'); add('shell-main-surface'); add('mobile-home');
  const state = {view: data, ui: {activeViewRequestId: 0}, player: {playbackQueue: {owner: 'prior'}, current: null}};
  const listeners = new Map();
  Object.assign(c, {state, URL, URLSearchParams, AbortController, queueMicrotask,
    location: new URL(`https://albumhaven.test/?surface=playlists&playlist_id=${id(80)}`),
    history: {state: {albumHavenNavigationPosition: 1}},
    addEventListener(name, fn) {const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list);},
    removeEventListener(name, fn) {listeners.set(name, (listeners.get(name) || []).filter(value => value !== fn));}, dispatchEvent() {},
    AlbumHavenHomeRuntime: {}, AlbumHavenCapabilities: {allows: value => value === 'library.media.read'},
    playerTrackSelectionToken: 1,
    activateSharedTrackButton(button, options) {calls.activations.push({button, options});},
    playTrackFromPayload: async value => {calls.starts.push(value); state.player.current = value; return true;},
    fetch: async (...args) => {calls.requests.push(args); throw new Error('Unexpected native request');},
  });
  installPrivateContext(c);
  const load = file => vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8'), c, {filename: file});
  for (const name of ['playlist-queue.js', 'album-track-table.js', 'track-actions.js', 'resource-selection.js', 'playtable-source.js',
    'explicit-queue-sources.js', 'playlists-react-bridge.js']) load(`runtime/${name}`);
  const runtime = c.AlbumHavenPlaylistRuntime;
  function reply(body, {temporary = true, mutate = value => value, missing = []} = {}) {
    const ids = body.entry_refs || body.item_refs, starting = body.starting_entry_ref || body.starting_item_ref;
    const counts = new Map([[id(11), 9], [id(12), 0]]);
    return response(mutate({status: 'ready', data: {
      ...(temporary ? {source_protocol: 'library_mix_selection_v1', source: {kind: 'library', ref: body.source_ref, revision: body.source_revision}}
        : {playlist_id: id(80), revision: body.revision}), starting_item_ref: starting, unavailable_item_refs: [...missing],
      tracks: ids.filter(ref => !missing.includes(ref)).map(ref => ({playlist_item_id: ref,
        ...(counts.has(ref) ? {play_count: counts.get(ref)} : {}), native_target: {playlist_item_id: ref,
          track_ref: `/synthetic-only/${ref}.flac`, path: `/synthetic-only/${ref}.flac`, title: ref,
          artist: 'Artist', album_title: 'Album', duration_seconds: 30, inventory_track_ref: `inventory-track:5:${Number(ref.slice(-3))}`}})),
    }}));
  }
  function network({temporary = true, mutate, missing} = {}) {
    c.fetch = async (url, options = {}) => {
      calls.requests.push({url, ...options});
      const expected = temporary ? '/playlists/creation-source/library-mix/native-queue' : `/playlists/${id(80)}/native-queue`;
      if (url !== expected) throw new Error(`Unexpected native path ${url}`);
      return reply(JSON.parse(options.body), {temporary, mutate, missing});
    };
  }
  return {...native, c, root, add, shell, host, state, calls, load, runtime, reply, network};
}
async function temporaryFixture(options = {}) {
  const {createLibraryMixController} = await import('../../../music_app/static/js/playlists/library-mix.mjs');
  const {capture, recipe} = require('./library-mix-fixtures.cjs');
  const h = nativeFixture(), scopeKey = h.runtime.snapshot().scopeKey;
  let active = true;
  const controller = createLibraryMixController({scopeKey, isCurrent: () => active,
    providers: {beginLibraryMix: async () => capture({scopeKey, library_mix: mixMetadata(options), ...options.capture})}});
  await controller.prepare(recipe(options));
  const runtime = h.runtime.createLibraryMixRuntime({scopeKey, isCurrent: () => active,
    source: () => controller.source(), order: () => controller.getSnapshot().playbackOrder});
  return {...h, controller, mix: runtime, scopeKey, rows: controller.source().detail.track_rows,
    retire() {active = false; controller.dispose();}};
}
module.exports = {nativeFixture, temporaryFixture, payload, row, response};
