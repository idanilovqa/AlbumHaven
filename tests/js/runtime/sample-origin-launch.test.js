'use strict';
// Bounded actual native mount tests, not browser/E2E acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {installMouseEventDetail} = require('./sample-browser-platform.cjs');
const F = require('./sample-origin-fixtures.cjs');
const {retainedPresentation} = require('./sample-origin-presentation-fixtures.cjs');
async function mounted(t, kind, overrides = {}) {
  const h = await nativeMixFixture(t); h.installNavigation(); installMouseEventDetail(h.c); let sequence = 2000, current = true;
  h.c.crypto.randomUUID = () => F.id(sequence++);
  const {mountPlaylists} = await import('../../../music_app/static/js/playlists/native.mjs');
  const calls = {capture: [], save: [], back: []};
  // No saved Playlist is available: a v2 launch must use the real origin lease,
  // never fabricate a saved Playlist parent to pass the legacy launch guard.
  const payload = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: null, items: []}, playlist_detail: null};
  h.state.view = payload; h.runtime.sync();
  const providers = {readPlaylists: async () => payload,
    readSamplePlaylistRepresentatives: async input => F.v2Representatives(input),
    captureSamplePlaylist: async input => {calls.capture.push(input); return F.v2Capture(input);},
    readSamplePlaylist: async input => F.v2Capture({...input, options: F.options()}),
    hasPendingPlaylistOperation: () => false,
    createPlaylistFromSelection: async input => {calls.save.push(input); return {status: 'ready', data: {scopeKey: input.scopeKey,
      ok: true, action: 'create', playlist_id: F.id(80), revision: '1', request_key: input.request_key}};}, ...overrides};
  const createRuntime = h.runtime.createSamplePlaylistRuntime;
  h.runtime.createSamplePlaylistRuntime = input => {
    const runtime = createRuntime(input);
    for (const key of ['buttonHtml', 'actionHtml', 'iconHtml', 'tableHtml', 'artboxHtml', 'albumTrackRow', 'escapeHtml', 'alertHtml', 'navigationItemHtml', 'openChoice']) runtime[key] = h.runtime[key];
    return runtime;
  };
  h.c.AlbumHavenPlaylistRuntime = h.runtime;
  const owner = mountPlaylists({host: h.host, runtime: h.runtime, providers, isRuntimeCurrent: () => h.c.AlbumHavenPlaylistRuntime === h.runtime});
  t.after(() => owner.dispose()); await h.settle();
  const presentation = retainedPresentation(t, h, () => current, 'direct-mount-origin-source');
  const originOwner = Object.freeze({scopeKey: h.runtime.snapshot().scopeKey, origin: F.origins[kind](), isCurrent: () => current,
    back: async () => {if (!current) return false; calls.back.push(originOwner); presentation.restore(); return true;}});
  return {...h, owner, calls, originOwner, retire: () => {current = false;},
    open: patch => owner.openSamplePlaylist({originOwner, options: F.options(), originNavigation: presentation.navigation, ...patch}),
    async generate() {h.click(h.named('Generate')); await h.settle();}};
}
for (const kind of Object.keys(F.origins)) {
  test(`${kind}: existing native Sample page opens from actual origin lease without a saved Playlist`, async t => {
    const h = await mounted(t, kind); assert.equal(h.open(), true); await h.settle();
    assert.ok(h.named('Generate')); assert.equal(h.calls.capture.length, 0); assert.equal(h.calls.save.length, 0);
    await h.generate(); assert.equal(h.calls.capture.length, 1); assert.deepEqual(h.calls.capture[0].origin, h.originOwner.origin);
    assert.equal(Object.hasOwn(h.calls.capture[0], 'playlist_ref'), false); assert.ok(h.host.querySelector('#playlist-tracks[role="table"]'));
    assert.equal(h.host.querySelectorAll('[data-playlists-play]').length, 3);
    assert.equal(h.named('Save as playlist').disabled, false);
    h.click(h.named('Back')); await h.settle();
    assert.equal(h.calls.back.length, 1); assert.equal(h.calls.back[0], h.originOwner); assert.equal(h.calls.save.length, 0);
  });
}
test('typed launch rejects stale, foreign-scope, mixed-parent and malformed origin leases before acquiring a form', async t => {
  const h = await mounted(t, 'album_set');
  for (const originOwner of [{...h.originOwner, isCurrent: () => false}, {...h.originOwner, scopeKey: 'foreign:scope'},
    {...h.originOwner, origin: {kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: 3}]}}]) {
    assert.equal(h.open({originOwner}), false); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  }
  assert.equal(h.open({parent: F.parent()}), false); assert.equal(h.calls.capture.length, 0); assert.equal(h.calls.save.length, 0);
});
test('typed native presentation sort changes neither clicked-start queue author order nor explicit Save order', async t => {
  const h = await mounted(t, 'album_details', {captureSamplePlaylist: async input => F.v2Capture(input, {
    entries: F.entries().map((entry, index) => ({...entry, duration_seconds: 90 - index * 30}))})});
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  h.click(h.host.querySelector('[data-cdt-sort="duration"]')); await h.settle();
  const buttons = [...h.host.querySelectorAll('[data-playlists-play]')];
  assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), ['Play Track 13', 'Play Track 12', 'Play Track 11']);
  const requests = []; h.c.fetch = async (url, input) => {
    assert.equal(url, '/playlists/creation-source/sample/native-queue'); requests.push(JSON.parse(input.body));
    return h.reply(JSON.parse(input.body), {mutate: value => {value.data.source_protocol = F.PROTOCOL; value.data.source.kind = 'library'; return value;}});
  };
  h.click(buttons[0]); await h.settle(); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].entry_refs, [F.id(11), F.id(12), F.id(13)]); assert.equal(requests[0].starting_entry_ref, F.id(13));
  h.c.fetchAndRender = async () => false;
  h.click(h.named('Save as playlist')); await h.settle(); assert.equal(h.calls.save.length, 1);
  assert.deepEqual(h.calls.save[0].entry_refs, requests[0].entry_refs); assert.equal(h.calls.save[0].source.kind, 'library');
  h.click(h.named('Open saved playlist')); await h.settle(); assert.equal(h.calls.save.length, 1); assert.equal(h.calls.back.length, 0);
});
test('stale native origin blocks Back reconstruction and a late capture cannot populate a replacement', async t => {
  const waiting = F.deferred(), entered = F.deferred(); let input;
  const h = await mounted(t, 'album_top', {captureSamplePlaylist: async value => {input = value; entered.resolve(); return waiting.promise;}});
  assert.equal(h.open(), true); await h.settle(); h.click(h.named('Generate'));
  await entered.promise; h.retire(); waiting.resolve(F.v2Capture(input)); await h.settle();
  assert.equal(h.calls.save.length, 0); assert.equal(h.calls.back.length, 0);
  assert.equal(h.host.querySelector('#playlist-tracks[role="table"]'), null); assert.equal(h.named('Save as playlist')?.disabled !== false, true);
});
