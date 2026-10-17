const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/explicit-queue-sources.js'), 'utf8');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function fixture(kind) {
  let token = {}, generation = 1;
  const row = {inventory_track_ref: 'inventory-track:1:11', track_ref: 'track:one', canonical_track_ref: 'track:one',
    path: '/private/song.flac', title: 'Song', artist: 'Artist', album_title: 'Album', duration_seconds: 133,
    source_readable: true, availability: 'local', allowed_actions: {can_read: true, can_play: true},
    playback_state: {can_start_here: true}, track_preference: {rating: null, love_tier: 'loved', allowed_actions: {can_set_love_tier: true}}};
  const album = {album_ref: 'album:one', name: 'Album', album_artist: 'Artist', source_readable: true,
    allowed_actions: {can_read: true, can_play_album: true}, tracks: [row], track_rows: [row]};
  let fresh = album, loose = {ok: true, source_readable: true, non_album_tracks: [row]}, pending = null;
  const calls = [];
  const scope = () => ({actor: 'actor', library: '1', token});
  const context = vm.createContext({window: {}, AbortController, Promise, Object, JSON,
    TrackActionsRuntime: {scope}, PrivateUITransport: {generation: () => generation},
    getAlbumPlaybackQueueRef: value => value?.album_ref,
    fetchTrackModalAlbumDetails: async (ref, options) => {calls.push({ref, options}); return pending ? pending.promise : fresh;},
    buildApiUrl: () => '/view-data?view=loose&payloadTier=full',
    fetch: async (url, options) => {calls.push({url, options}); const value = pending ? await pending.promise : loose; return {ok: true, json: async () => value};}});
  vm.runInContext(source, context);
  const capture = kind === 'album' ? context.captureNativeAlbumQueueSources(album, [row])[0]
    : context.captureNativeLooseQueueSources({kind: 'loose'}, [row])[0];
  assert.equal(typeof capture.resolveMetadata, 'function', `${kind} capture requires the metadata API before starting a read`);
  return {capture, row, calls, context,
    update(next) {fresh = {...album, tracks: [next], track_rows: [next]}; loose = {...loose, non_album_tracks: [next]};},
    missing() {const next = {...row, path: null, availability: 'missing', duration_seconds: null,
      allowed_actions: {can_read: true, can_play: false}, playback_state: {can_start_here: false}};
      fresh = {...album, allowed_actions: {can_read: true, can_play_album: false}, tracks: [next], track_rows: [next]};
      loose = {...loose, non_album_tracks: [next]}; return next;},
    deny() {fresh = {...album, source_readable: false}; loose = {...loose, source_readable: false};},
    pause() {pending = deferred(); return pending;},
    replace() {token = {}; generation++;}, album, loose: () => loose};
}
for (const kind of ['album', 'loose']) {
  test(`${kind} retained Queue capture reads missing metadata without play authority`, async () => {
    const f = fixture(kind); f.missing();
    assert.equal(typeof f.capture.resolveMetadata, 'function');
    const value = await f.capture.resolveMetadata({signal: new AbortController().signal});
    assert.equal(value.inventory_track_ref, f.row.inventory_track_ref); assert.equal(value.availability, 'missing');
    assert.equal(value.duration_seconds, null); assert.equal(value.track_preference.love_tier, 'loved');
    assert.equal(value.title, 'Song'); assert.equal(value.source_readable, true);
    await assert.rejects(f.capture.resolve({signal: new AbortController().signal}));
  });
  test(`${kind} metadata rejects source denial and an inventory remap rather than matching title`, async () => {
    const f = fixture(kind); f.deny(); await assert.rejects(f.capture.resolveMetadata(), error => error.status === 403);
    const g = fixture(kind); g.update({...g.row, inventory_track_ref: 'inventory-track:1:22'});
    await assert.rejects(g.capture.resolveMetadata());
  });
  test(`${kind} metadata refuses canonical remapping of an already captured occurrence`, async () => {
    const f = fixture(kind); f.update({...f.row, track_ref: 'track:different', canonical_track_ref: 'track:different'});
    await assert.rejects(f.capture.resolveMetadata());
  });
  test(`${kind} late metadata is suppressed after actor/library/transport scope replacement`, async () => {
    const f = fixture(kind), deferredRead = f.pause();
    const read = f.capture.resolveMetadata(); const denied = assert.rejects(read);
    f.replace(); deferredRead.resolve(kind === 'album' ? f.album : f.loose()); await denied;
  });
  test(`${kind} aborted metadata read cannot publish fresh private rows`, async () => {
    const f = fixture(kind), deferredRead = f.pause(), controller = new AbortController();
    const read = f.capture.resolveMetadata({signal: controller.signal}); const denied = assert.rejects(read);
    controller.abort(); deferredRead.resolve(kind === 'album' ? f.album : f.loose()); await denied;
  });
}
