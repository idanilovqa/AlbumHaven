'use strict';
// Home-specific fixture: retain document-lifetime transport observer; only per-owner observers retire.
// Synthetic DOM/HTTP and asset loading only. Complete product transport, CSRF,
// decoder, detail owner, modal renderer, table and native dispatcher stay real.
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const H = require('./foobar-account-history-fixture.cjs');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const VERSION = 'foobar_account_track_evidence_v1', CONTEXT = 'c'.repeat(64);
const scope = patch => ({context: CONTEXT, accountId: '7', libraryId: '3', trackId: '11', family: 'standard', cursor: null, ...patch});
const item = (n = 1, patch = {}) => ({source_ref: H.id(n), source_created_at: '2026-10-23T00:00:00.000001Z', observation_ref: H.id(1000+n), source_revision: '8', association_version: '3', evidence_kind: 'tsv_snapshot', count_state: 'valid', count: '12', status: 'ready', reason: null, ...patch});
const cursor = (row, patch = {}) => ({account_id: '7', library_id: '3', track_id: '11', track_sha256: 'b'.repeat(64), family: 'standard', source_ref: row.source_ref, observation_ref: row.observation_ref, ...patch});
const payload = (items = [item()], patch = {}) => ({protocol: VERSION, context_ref: CONTEXT, result: {track_id: '11', family: 'standard', items, next_cursor: null, consistency: 'current_page_refresh_to_restart', ...patch}});
const page = (start = 1, count = 20, more = true, patch = {}) => {
  const items = Array.from({length: count}, (_, n) => item(start+n));
  return payload(items, {next_cursor: more ? cursor(items.at(-1)) : null, ...patch});
};
const track = (n = 11, patch = {}) => ({path: '/synthetic/album/' + n + '.flac', title: 'Track ' + n, artist: 'Artist', album: 'Album', track_number: n, disc_number: 1, duration_seconds: 60, inventory_track_ref: 'inventory-track:3:' + n, allowed_actions: {can_read: true}, ...patch});
const album = (patch = {}) => ({key: 'synthetic-album', name: 'Album', album_artist: 'Artist', tracks: [track()], source_readable: true, allowed_actions: {can_read: true}, ...patch});
async function platform(t) {
  const env = createNativeHomeRuntime(), {document, context: c} = env;
  const requests = [], observers = [], moduleLoads = [], imports = [], playback = [];
  const time = F.clock();
  document.defaultView = c;
  c.Element.prototype.focus = function () {if (this.isConnected && !this.disabled) document.activeElement = this;};
  Object.defineProperty(c.Element.prototype, 'value', {configurable: true, get() {return this._value || '';}, set(value) {this._value = String(value);}});
  c.MutationObserver = class {
    constructor(callback) {this.callback = callback; this.targets = []; this.active = true; observers.push(this);}
    observe(target) {this.targets.push(target);}
    disconnect() {this.active = false;}
  };
  const add = (tag, id, parent = document.body) => {const n = document.createElement(tag); if (id) n.id = id; parent.append(n); return n;};
  const shell = add('main', 'app-shell');
  Object.assign(shell.dataset, {nativeAccountId: '7', nativeLibraryId: '3', privateUiContext: CONTEXT, accountFoobarHistoryAllowed: 'true', positionCaptureEnabled: 'false', listeningSelectionsEnabled: 'true'});
  c.Headers = Headers; c.AbortController = AbortController; c.TextEncoder = TextEncoder; c.TextDecoder = TextDecoder;
  c.location = {href: 'https://albumhaven.invalid/', origin: 'https://albumhaven.invalid'};
  c.setTimeout = globalThis.setTimeout; c.clearTimeout = globalThis.clearTimeout;
  document.cookie = '__Host-album_haven_csrf=synthetic-evidence-csrf';
  c.fetch = (url, options) => {const d = F.deferred(); requests.push({url, options, ...d}); return d.promise;};
  const run = name => F.vm.runInContext(F.read('music_app/static/js/runtime/' + name), c, {filename: name});
  for (const name of ['session-csrf-fetch.js', 'private-ui-transport.js', 'track-actions.js']) run(name);
  const transport = c.AlbumHavenPrivateUITransport;
  const pageLifetimeObservers = new Set(observers);
  let ownedPanel = null, current = true, importGate = null, importFailure = false;
  const module = await H.load('track-evidence.mjs');
  const host = add('section', 'evidence-test-host');
  const mount = (patch = {}) => {
    ownedPanel = module.mountFoobarTrackEvidence(host, {transport, isCurrent: () => current, trackId: '11', libraryId: '3', accountId: '7', ...patch});
    return ownedPanel;
  };
  const modal = () => {
    const overlay = add('section', 'track-modal'); overlay.hidden = false;
    const header = add('header', null, overlay), list = add('div', null, overlay), cover = add('div', null, overlay);
    Object.assign(c, {
      state: {player: {current: null}, view: {}, ui: {pendingTrackModalLoadToken: 0}, modalReleases: [], modalReleaseIndex: 0},
      getTrackModalElements: () => ({overlay, header, list, cover}), getAlbumRequestKey: a => a?.key || '',
      albumHasDisplayCover: () => false, formatAlbumDuration: () => '1:00', formatTrackDuration: () => '1:00',
      getPlayerPlaybackSnapshot: () => ({paused: true, currentTime: 0, duration: 0}), getPlayerElements: () => ({}),
      attachSharedPlayer: () => playback.push('attached'),
      // Independent preference receipt input is unavailable, never fabricated.
      captureRuntimeAlbumPreferenceScope: () => null, runtimeAlbumPreferenceForAlbum: () => null,
      AlbumHavenCapabilities: {allows: action => ['library.browse.read', 'library.media.read'].includes(action)},
    });
    for (const name of ['compact-data-table.js', 'album-track-table.js', 'tag-editor-and-optimistic-updates.js', 'track-modal-lightbox-helpers.js', 'player-loop-playback.js']) run(name);
    // Same declared asset-loader seam as the accepted S3 modal tests. Native
    // import loads the whole genuine ESM; URL/version behavior is source-checked.
    assert.equal(typeof c.loadFoobarTrackEvidencePresenter, 'function');
    c.loadFoobarTrackEvidencePresenter = () => {
      imports.push('track-evidence.mjs');
      const promise = importFailure ? Promise.reject(Error('Synthetic asset failure')) : importGate ? importGate.promise.then(() => module) : Promise.resolve(module);
      moduleLoads.push(promise); return promise;
    };
    const starts = [], ownership = {};
    c.capturePlaybackOwnershipScope = () => ownership; c.isPlaybackOwnershipScopeCurrent = x => x === ownership;
    c.PLAYBACK_CAPTURE_ENABLED = true;
    c.playTrackFromPayload = value => {starts.push(value); return Promise.resolve();};
    const render = value => {c.state.modalReleases = [value]; c.state.modalReleaseIndex = 0; c.renderTrackModalRelease(value); return value;};
    return {overlay, header, list, cover, render, starts, owner: () => F.vm.runInContext('trackModalFoobarEvidence', c), controls: () => list.querySelectorAll('button').filter(b => b.textContent === 'Foobar evidence')};
  };
  t.after(async () => {
    try {
      ownedPanel?.dispose(); c.disposeTrackModalFoobarEvidence?.(); c.disposeTrackModalLocalListening?.(); c.disposeTrackModalAlbumPreferences?.(); /* Home transport belongs to the document lifetime; no dispose API. */
      for (const request of requests) request.reject(Object.assign(Error('Synthetic cleanup'), {name: 'AbortError'}));
      importGate?.resolve(); await Promise.allSettled(moduleLoads); await F.settle();
      assert.equal(time.tasks.size, 0); assert.ok(observers.every(o => pageLifetimeObservers.has(o) || !o.active)); assert.equal(env.forbiddenCalls.length, 0);
    } finally {time.restore();}
  });
  return {...env, c, host, shell, transport, requests, observers, time, imports, module, mount, modal, playback,
    async flush() {await F.settle();},
    reply(index, value, status = 200) {assert.ok(requests[index], 'Explicit request exists'); requests[index].resolve(F.response(value, status));},
    reject(index) {requests[index].reject(Error('Synthetic transport failure'));},
    mutate(target) {for (const observer of [...observers]) if (observer.active && observer.targets.includes(target)) observer.callback([]);},
    current(value) {current = value;},
    holdImport() {importGate = F.deferred(); return importGate;}, failImport() {importFailure = true;},
    button(text, root = host) {const result = root.querySelectorAll('button').find(n => n.textContent === text); assert.ok(result, 'Actual button ' + text); return result;},
    change(value, root = host) {const select = root.querySelector('select'); assert.ok(select); select.value = value; select.dispatchEvent(new c.Event('change'));},
  };
}
const body = call => JSON.parse(call.options.body);
const noPrivate = root => assert.doesNotMatch(root.outerHTML, /data-track-path|data-inventory-track-ref|data-src|\/synthetic\/|inventory-track:|track_sha256|albumListeningIntent|<img|<audio/);
module.exports = {...F, VERSION, CONTEXT, scope, item, cursor, payload, page, track, album, platform, body, noPrivate};
