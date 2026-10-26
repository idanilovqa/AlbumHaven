// Additive review-regression unit dependencies. Original frozen harness is copied
// byte-for-byte alongside this file; actual admission/dispatch owners stay real.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome, settle} = require('./loose-authority-harness.cjs');

function fixture() {
  const f = createLooseAuthorityFixture();
  // Response state is already bootstrapped before the request owners.
  assert.equal(f.responseStateOwner.captureScope, f.context.captureRuntimeAlbumPreferenceScope);
  f.loadRuntime('view-state-helpers.js');
  f.context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'loose-review-ui-scope'})};
  f.context.window.AlbumHavenPlaytableUI = {mount(_host, options) {
    mounted = options; return {dispose() {}, update(next) {if (next) mounted = next;}};
  }};
  let mounted;
  f.loadRuntime('playtable-source.js');
  const native = vm.runInContext('NativePlaytables', f.context);
  const mount = (payload = f.state.view, host = {querySelectorAll: () => []}) => {
    const rows = payload.non_album_tracks;
    native.prepare('loose-tracks', payload, [{tracks: rows.map(row => ({title: row.title}))}], rows, () => true);
    assert.equal(native.mount('loose-tracks', host), true);
    assert.ok(mounted.trackPreferences, 'Existing Loose preference adapter is an admitted baseline prerequisite');
    return mounted.trackPreferences;
  };
  const value = (adapter, index = 0) => adapter.runtime.trackPreference(adapter.rows[index], adapter.context);
  const url = view => f.context.buildApiUrl(view, {payloadTier: 'full'});
  return {...f, native, mount, value, url};
}
async function albumRead(f, row = looseRow(901, {track_preference: overlay('obsessed')}), key = 'unrelated-album') {
  const index = f.requests.length, pending = f.context.fetchTrackModalAlbumDetails(key);
  f.respond(index, {ok: true, album: {key, tracks: [row]}}); await pending;
  assert.ok(f.source(row)); return row;
}
async function readKnown(f, payload, url = f.url(payload)) {
  await f.load(payload, url);
  assert.ok(f.source(payload.non_album_tracks[0]), 'Baseline genuine read must establish its exact receipt');
  return payload;
}
const unavailable = (id, patch = {}) => looseRow(id, {track_preference_state: 'unavailable',
  track_preference: overlay('off', false), canonical_track_ref: null, inventory_track_ref: null, ...patch});
module.exports = {fixture, albumRead, readKnown, unavailable, looseRow, browsePayload, overlay, outcome, settle};
