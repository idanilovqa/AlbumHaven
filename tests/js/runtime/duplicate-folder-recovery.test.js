'use strict';
// Whole native owner, shared ButtonComponent, transport and CSRF are real.
// DOM, HTTP responses and confirmation responses are synthetic platform inputs.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {createNativeHomeRuntime, readRepo, buttonNamed} = require('./native-home-harness.cjs');
const STAMP = 'a'.repeat(64);
const cleanups = [];
test.afterEach(async () => {for (const clean of cleanups.splice(0)) clean(); await flush();});
const flush = async () => {for (let n = 0; n < 30; n++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve));};
function environment({enabled = true, allowed = true} = {}) {
  const env = createNativeHomeRuntime(), c = env.context, document = env.document;
  // Browser AbortSignal listener ownership, absent from the base synthetic DOM.
  const addListener = c.Element.prototype.addEventListener;
  c.Element.prototype.addEventListener = function(type, handler, options = {}) {
    const {signal, ...rest} = typeof options === 'object' ? options : {capture: options};
    if (signal?.aborted) return;
    addListener.call(this, type, handler, rest);
    signal?.addEventListener('abort', () => this.removeEventListener(type, handler, rest), {once: true});
  };
  const shell = document.createElement('main'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: '1', nativeLibraryId: '2', privateUiContext: STAMP,
    duplicateRecoveryEnabled: String(enabled)}); document.body.append(shell);
  const host = document.createElement('div'); document.body.append(host);
  const requests = [], toasts = [], confirms = [], invalidations = [];
  let album = {key: 'album', allowed_actions: {'library.inventory.manage': allowed}}, confirm = true;
  Object.assign(c, {AbortController, Headers, TextEncoder, TextDecoder,
    crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000001'},
    location: {href: 'https://albumhaven.invalid/', origin: 'https://albumhaven.invalid'},
    trackModalPresentationRestrictions: {}, getCurrentTrackModalAlbum: () => album,
    showToast: (...args) => toasts.push(args),
    showAppConfirmDialog: options => {confirms.push(options); return Promise.resolve(confirm);},
    invalidateHydratedTrackModalAlbumDetails: value => invalidations.push(value),
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject})),
  });
  document.cookie = '__Host-album_haven_csrf=synthetic-duplicate-csrf';
  for (const name of ['session-csrf-fetch.js', 'private-ui-transport.js', 'track-actions.js', 'tag-editor-and-optimistic-updates.js']) {
    vm.runInContext(readRepo('music_app/static/js/runtime/' + name), c, {filename: name});
  }
  const owner = env.owner('DuplicateFolderRecoveryUI');
  owner.mount(album, host, 'album');
  cleanups.push(() => {owner.mount(null, null, '');
    assert.equal(env.listeners().filter(row => row.target.getAttribute?.('data-duplicate-folder-recovery') !== null
      && row.target.getAttribute?.('data-duplicate-folder-recovery') !== undefined).length, 0);
  });
  return {...env, host, shell, requests, toasts, confirms, invalidations,
    setConfirm: value => {confirm = value;}, navigate: () => {album = {key: 'other'};},
    mount: () => owner.mount(album, host, album.key),
    clickName: pattern => env.click(buttonNamed(host, pattern)),
    reply: (index, data) => requests[index].resolve({ok: true, status: 200,
      headers: new Headers({'Content-Type': 'application/json'}), json: async () => ({data, context_ref: STAMP})}),
  };
}
const choices = () => ({sources: [{id: 1, label: 'Keep'}, {id: 2, label: 'Remove'}], operations: []});
async function loaded(env) {env.clickName(/Manage duplicate/); await flush(); env.reply(0, choices()); await flush();}

test('duplicate owner is disabled by default and never eagerly reads', async () => {
  for (const options of [{enabled: false}, {allowed: false}]) {
    const env = environment(options); await flush();
    assert.equal(env.host.querySelectorAll('button').length, 0); assert.equal(env.requests.length, 0);
  }
  const env = environment(); assert.equal(env.requests.length, 0);
});
test('duplicate read uses genuine context and CSRF transport', async () => {
  const env = environment(); await loaded(env);
  assert.match(env.requests[0].url, /choices$/);
  assert.equal(new Headers(env.requests[0].options.headers).get('X-AlbumHaven-Context'), STAMP);
  assert.equal(new Headers(env.requests[0].options.headers).get('x-album-haven-csrf'), 'synthetic-duplicate-csrf');
  assert.deepEqual(JSON.parse(env.requests[0].options.body), {album_key: 'album'});
});
test('keep selection does not mutate and trash requires a different explicit source', async () => {
  const env = environment(); await loaded(env);
  assert.equal(buttonNamed(env.host, /Trash Remove/).disabled, true);
  env.clickName(/Keep Keep/); assert.equal(env.requests.length, 1);
  assert.equal(buttonNamed(env.host, /Trash Keep/).disabled, true);
  assert.equal(buttonNamed(env.host, /Trash Remove/).disabled, false);
});
test('cancel after exact preview sends no mutation', async () => {
  const env = environment(); await loaded(env); env.setConfirm(false); env.clickName(/Keep Keep/);
  env.clickName(/Trash Remove/); await flush();
  env.reply(1, {fingerprint: 'b'.repeat(64), keep: 'Keep', remove: 'Remove', track_count: 2, file_count: 3}); await flush();
  assert.equal(env.requests.length, 2); assert.match(env.confirms[0].message, /2 tracks, 3 files/);
});
test('accept sends one UUID-bound command and repeated pending click cannot duplicate it', async () => {
  const env = environment(); await loaded(env); env.clickName(/Keep Keep/); env.clickName(/Trash Remove/); await flush();
  env.reply(1, {fingerprint: 'b'.repeat(64), keep: 'Keep', remove: 'Remove', track_count: 2, file_count: 3}); await flush();
  assert.equal(env.requests.length, 3); assert.match(env.requests[2].url, /trash$/);
  assert.equal(JSON.parse(env.requests[2].options.body).operation_id, '00000000-0000-4000-8000-000000000001');
  env.clickName(/Trash Remove/); await flush(); assert.equal(env.requests.length, 3);
});
test('navigation during preview cannot confirm or mutate another album', async () => {
  const env = environment(); await loaded(env); env.clickName(/Keep Keep/); env.clickName(/Trash Remove/); await flush();
  env.navigate(); env.reply(1, {fingerprint: 'b'.repeat(64), keep: 'Keep', remove: 'Remove', track_count: 2, file_count: 3}); await flush();
  assert.equal(env.requests.length, 2); assert.equal(env.confirms.length, 0); assert.equal(env.toasts.length, 0);
});
test('uncertain mutation is not retried automatically', async () => {
  const env = environment(); await loaded(env); env.clickName(/Keep Keep/); env.clickName(/Trash Remove/); await flush();
  env.reply(1, {fingerprint: 'b'.repeat(64), keep: 'Keep', remove: 'Remove', track_count: 2, file_count: 3}); await flush();
  env.requests[2].reject(new Error('Synthetic lost reply')); await flush();
  assert.equal(env.requests.length, 3); assert.match(env.toasts.at(-1)[0], /outcome is not confirmed/);
});
test('same-owner rerender retires delayed response', async () => {
  const env = environment(); env.clickName(/Manage duplicate/); await flush(); env.mount();
  assert.equal(env.requests[0].options.signal.aborted, true);
  env.reply(0, choices()); await flush(); assert.equal(env.toasts.length, 0);
});

test('closing hidden album during preview cannot open a confirmation', async () => {
  const env = environment(); await loaded(env); env.clickName(/Keep Keep/); env.clickName(/Trash Remove/); await flush();
  env.host.hidden = true;
  env.reply(1, {fingerprint: 'b'.repeat(64), keep: 'Keep', remove: 'Remove', track_count: 2, file_count: 3}); await flush();
  assert.equal(env.confirms.length, 0); assert.equal(env.requests.length, 2);
});
