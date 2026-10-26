// Genuine native Album capture + fetch + Queue ownership, with inert HTTP DTOs.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const row = (id, editable, tier) => ({path: `/synthetic/queue-album/${id}.flac`, track_ref: `track:${id}`,
  canonical_track_ref: `track:${id}`, inventory_track_ref: `inventory-track:9:${id}`,
  title: `Track ${id}`, artist: 'Artist', album_title: 'Album', duration_seconds: 150,
  source_readable: true, availability: 'local', allowed_actions: {can_read: true, can_play: true},
  playback_state: {can_start_here: true}, track_preference_state: 'available',
  track_preference: {rating: null, love_tier: tier, allowed_actions: {can_set_love_tier: editable}}});
function fixture(initial) {
  let tracks = initial;
  const h = createNativeHomeRuntime(), context = h.context;
  const shell = h.document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: '7', nativeLibraryId: '9', privateUiContext: 'a'.repeat(64)});
  h.document.body.appendChild(shell);
  const requests = [], responses = [];
  const album = () => ({key: 'queue-album', name: 'Album', album_artist: 'Artist',
    tracks: tracks.map(value => ({...value})), track_rows: tracks.map(value => ({...value}))});
  Object.assign(context, {AbortController, AlbumHavenCapabilities: {allows: () => true},
    activateSharedTrackButton() {throw new Error('Queue fixture must use its explicit playback boundary');}, playerTrackSelectionToken: 1,
    getAlbumPlaybackQueueRef: value => value?.key,
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    playTrackFromPayload: async () => {throw new Error('Metadata read must not start playback');},
    fetch: async (url, options) => {
      requests.push({url, options});
      assert.equal(url, '/album-details?album_key=queue-album', 'no write or playback HTTP expected');
      const value = album(); responses.push(value);
      return {ok: true, status: 200, json: async () => ({ok: true, album: value})};
    }});
  // Match complete served state, modal, transport and preference owners.
  for (const file of ['bootstrap-state.js', 'response-state-helpers.js', 'core-state-and-helpers.js', 'player-streaming-engine.js',
    'track-modal-lightbox-helpers.js', 'private-ui-transport.js', 'track-actions.js', 'explicit-queue-planner.js',
    'explicit-queue-runtime.js', 'explicit-queue-sources.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  context.getPlayerPlaybackSnapshot = context.getStreamingPlaybackSnapshot;
  h.owner('state').status = {inventory_mutation_revision: 1};
  assert.equal(context.streamingEngineState(), h.owner('state').player.streaming);
  assert.equal(context.streamingEngineState().roles.current, null);
  const queue = context.window.AlbumHavenExplicitQueue;
  return {context, queue, requests, responses, album, replace: values => {tracks = values;},
    captures: () => context.captureNativeAlbumQueueSources(album(), tracks)};
}

for (const grants of [[false, true, false], [true, false, true]]) {
  test(`Native Album-backed Queue first admission retains every row with grants ${grants}`, async () => {
    const tiers = ['loved', 'obsessed', 'off'];
    const f = fixture(grants.map((grant, index) => row(11 + index, grant, tiers[index])));
    await f.queue.enqueue(f.captures());
    const values = Array.from(f.queue.getSnapshot().entries, entry => entry.track_preference);
    assert.ok(values.every(Boolean), 'Album transport must not consume Queue captured read epoch');
    assert.deepEqual(values.map(value => value.love_tier), tiers);
    assert.deepEqual(values.map(value => value.allowed_actions.can_set_love_tier), grants);
    for (const response of f.responses) {
      assert.equal(f.context.getTrackModalPreferenceSource(response.tracks[0]), null,
        'Queue-owned reads do not mint Album UI admission provenance');
    }
  });
}

test('Native Album-backed Queue refresh admits all sibling changes after first grant denial', async () => {
  const f = fixture([11, 12, 13].map(id => row(id, true, 'off')));
  const ids = await f.queue.enqueue(f.captures());
  f.replace([row(11, false, 'loved'), row(12, true, 'obsessed'), row(13, false, 'loved')]);
  await f.queue.refresh();
  const entries = Array.from(f.queue.getSnapshot().entries);
  assert.deepEqual(entries.map(entry => entry.id), Array.from(ids));
  assert.ok(entries.every(entry => entry.track_preference));
  assert.deepEqual(entries.map(entry => entry.track_preference.love_tier), ['loved', 'obsessed', 'loved']);
  assert.deepEqual(entries.map(entry => entry.track_preference.allowed_actions.can_set_love_tier), [false, true, false]);
});
