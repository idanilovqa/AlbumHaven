// Additive currentness regression at the real Queue/native-preference boundary.
// No browser, transport, database or production-app acceptance claim.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');

function fixture() {
  const h = createNativeHomeRuntime();
  const shell = h.document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: '41', nativeLibraryId: '73'});
  h.document.body.appendChild(shell);
  let generation = 1, callerCurrent = true, sourceCurrent = true;
  const controller = new AbortController();
  Object.assign(h.context, {
    AbortController, state: {player: {current: null, playbackQueue: null, loopActive: false}},
    PrivateUITransport: {generation: () => generation, subscribe: () => () => {}},
    AlbumHavenCapabilities: {allows: () => true},
    activateSharedTrackButton() {}, playerTrackSelectionToken: 1,
    getPlayerPlaybackSnapshot: () => ({}), streamingEngineState: () => null,
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
  });
  for (const name of ['track-actions.js', 'explicit-queue-planner.js', 'explicit-queue-runtime.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${name}`), h.context, {filename: name});
  }
  const queue = h.context.AlbumHavenExplicitQueue;
  const captures = [901, 902].map(id => {
    const target = {inventory_track_ref: `inventory-track:73:${id}`, track_ref: `track:key-${id}`,
      canonical_track_ref: `track:key-${id}`, path: `/synthetic/${id}.flac`, title: `Track ${id}`,
      artist: 'Artist', album_title: 'Album', duration_seconds: 120, source_readable: true,
      availability: 'local', allowed_actions: {can_read: true, can_play: true},
      playback_state: {can_start_here: true}, track_preference: {rating: null, love_tier: 'off',
        allowed_actions: {can_set_love_tier: true}}};
    return {display: {title: target.title}, isCurrent: () => sourceCurrent,
      resolveMetadata: async () => target, resolve: async () => target};
  });
  const replace = kind => {
    if (kind === 'signal') controller.abort();
    else if (kind === 'caller') callerCurrent = false;
    else if (kind === 'actor') shell.dataset.nativeAccountId = '42';
    else if (kind === 'transport') generation++;
    else if (kind === 'selection') h.context.playerTrackSelectionToken++;
    else if (kind === 'source') sourceCurrent = false;
  };
  const enqueue = () => queue.enqueue(captures, 'end', {
    signal: controller.signal, isCurrent: () => callerCurrent,
  }).then(ids => ({ids}), error => ({error}));
  return {queue, enqueue, replace};
}

for (const retirement of ['signal', 'caller', 'actor', 'transport', 'selection', 'source']) {
  test(`Queue cannot commit an enqueue retired by a synchronous preference subscriber (${retirement})`, async () => {
    const f = fixture();
    let notifications = 0;
    const unsubscribe = f.queue.subscribeTrackPreferences(() => {
      unsubscribe(); notifications++; f.replace(retirement);
    });
    const result = await f.enqueue();
    assert.equal(notifications, 1, 'retirement occurs inside real read-batch admission, after metadata/play reads');
    assert.equal(f.queue.getSnapshot().entries.length, 0,
      'retired source captures must never be inserted into the retained or replacement planner');
    assert.equal(result.error?.name, 'AbortError', 'the retired enqueue must report supersession, not success');
    assert.equal(result.ids, undefined);
  });
}

test('Queue commits one original batch with passive synchronous preference subscribers', async () => {
  const f = fixture();
  let notifications = 0;
  const unsubscribe = f.queue.subscribeTrackPreferences(() => {notifications++;});
  const result = await f.enqueue(); unsubscribe();
  assert.ifError(result.error);
  assert.equal(notifications, 2, 'each admitted independent track notifies normally');
  assert.equal(result.ids.length, 2);
  const rows = f.queue.getSnapshot().entries;
  assert.deepEqual(Array.from(rows, row => row.id), Array.from(result.ids));
  assert.deepEqual(Array.from(rows, row => row.title), ['Track 901', 'Track 902']);
  assert.ok(rows.every(row => row.sourceReadable && row.track_preference?.allowed_actions.can_set_love_tier));
});
