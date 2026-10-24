const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const directory = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const trackRef = 'inventory-track:1:17';
const uuid = '11111111-1111-4111-8111-111111111111';
const itemUuid = '22222222-2222-4222-8222-222222222222';
const inventory = () => ({kind: 'inventory', track_ref: trackRef});
const playlist = () => ({kind: 'playlist', track_ref: trackRef, playlist_ref: uuid, revision: '7', item_ref: itemUuid});
const activity = (audience = 'friend') => ({kind: 'activity', track_ref: trackRef,
  origin: {audience, subject_ref: audience === 'own' ? null : uuid, kind: 'tracks', period: 'month', snapshot_ref: 'A'.repeat(43)},
  row_ref: `activity_${'a'.repeat(64)}`});
function setup() {
  const state = {player: {current: null, playbackQueue: null}}, scope = {actor: 'actor', library: 'library', token: 'session'};
  const context = vm.createContext({state, AbortController, Object, Promise, Map, Set, WeakMap,
    window: {AlbumHavenCapabilities: {allows: () => true}}, playerTrackSelectionToken: 0,
    TrackActionsRuntime: {scope: () => ({...scope}), canPlay: row => Boolean(row?.path)},
    PrivateUITransport: {subscribe: () => () => {}}, getPlayerPlaybackSnapshot: () => ({ended: true}),
    streamingEngineState: () => ({roles: {current: null}}),
  });
  for (const name of ['explicit-queue-planner.js', 'explicit-queue-runtime.js'])
    vm.runInContext(fs.readFileSync(path.join(directory, name), 'utf8'), context);
  const target = {path: '/private/lineage.flac', title: 'Track', source_readable: true,
    inventory_track_ref: trackRef, playback_state: {can_start_here: true}};
  const api = context.window.AlbumHavenExplicitQueue;
  const enqueue = async provenance => (await api.enqueue([{display: {title: 'Track'}, isCurrent: () => true,
    resolve: async () => target, resolvePlaylistItem: async () => ({...target, source_provenance: provenance})}], 'end'))[0];
  return {context, target, api, enqueue};
}
for (const [name, factory] of [['inventory', inventory], ['playlist', playlist], ['friend Activity', activity], ['own Activity', () => activity('own')]]) {
  test(`Queue builder retains exact private ${name} provenance without public leakage`, async () => {
    const h = setup(), provenance = factory(), id = await h.enqueue(provenance);
    const receipt = await h.api.playlistSelection([id]), returned = receipt.rows[0].source_provenance;
    assert.deepEqual(JSON.parse(JSON.stringify(returned)), provenance);
    assert.ok(Object.isFrozen(returned)); if (returned.origin) assert.ok(Object.isFrozen(returned.origin));
    assert.notEqual(returned, provenance);
    assert.doesNotMatch(JSON.stringify(h.api.getSnapshot()), /source_provenance|snapshot_ref|playlist_ref|inventory-track|private\/lineage/);
    if (provenance.origin) provenance.origin.period = 'year'; else provenance.track_ref = 'inventory-track:1:99';
    assert.deepEqual(JSON.parse(JSON.stringify(returned)), factory());
  });
}
const invalid = [
  ['absent', () => undefined], ['null', () => null], ['unknown kind', () => ({...inventory(), kind: 'other'})],
  ['mismatched track', () => ({...inventory(), track_ref: 'inventory-track:1:18'})],
  ['raw path key', () => ({...inventory(), path: '/private/source'})],
  ['numeric revision', () => ({...playlist(), revision: 7})], ['noncanonical revision', () => ({...playlist(), revision: '07'})],
  ['zero revision', () => ({...playlist(), revision: '0'})], ['missing item', () => ({...playlist(), item_ref: undefined})],
  ['invalid playlist UUID', () => ({...playlist(), playlist_ref: 'playlist'})],
  ['extra playlist key', () => ({...playlist(), native_actions: {path: '/private/source'}})],
  ['friend without subject', () => ({...activity(), origin: {...activity().origin, subject_ref: null}})],
  ['own with subject', () => ({...activity('own'), origin: {...activity('own').origin, subject_ref: uuid}})],
  ['wrong period', () => ({...activity(), origin: {...activity().origin, period: 'daily'}})],
  ['wrong kind', () => ({...activity(), origin: {...activity().origin, kind: 'albums'}})],
  ['extra origin key', () => ({...activity(), origin: {...activity().origin, path: '/private/source'}})],
  ['missing snapshot', () => ({...activity(), origin: {...activity().origin, snapshot_ref: ''}})],
  ['noncanonical snapshot bits', () => ({...activity(), origin: {...activity().origin, snapshot_ref: 'A'.repeat(42) + 'B'}})],
  ['malformed row receipt', () => ({...activity(), row_ref: 'activity_fake'})],
];
for (const [name, factory] of invalid) test(`Queue builder rejects ${name} provenance instead of laundering inventory identity`, async () => {
  const h = setup(), id = await h.enqueue(factory());
  await assert.rejects(h.api.playlistSelection([id]), /provenance|source|origin/i);
});
test('mixed duplicate Queue inventory retains each original source in displayed selection order', async () => {
  const h = setup(), first = await h.enqueue(playlist()), second = await h.enqueue(activity());
  const receipt = await h.api.playlistSelection([second, first]);
  assert.deepEqual(Array.from(receipt.rows, row => [row.rowKey, row.track_ref, row.source_provenance?.kind]),
    [[second, trackRef, 'activity'], [first, trackRef, 'playlist']]);
});
for (const kind of ['album', 'loose']) test(`native ${kind} capture explicitly supplies inventory provenance after fresh membership read`, async () => {
  const h = setup(); h.context.getAlbumPlaybackQueueRef = album => album.ref;
  vm.runInContext(fs.readFileSync(path.join(directory, 'explicit-queue-sources.js'), 'utf8'), h.context);
  let captures;
  if (kind === 'album') {
    const album = {ref: 'album', track_rows: [h.target]};
    h.context.fetchTrackModalAlbumDetails = async () => album;
    captures = h.context.captureNativeAlbumQueueSources(album, [h.target]);
  } else {
    h.context.buildApiUrl = () => '/view-data?surface=albums';
    h.context.fetch = async () => ({ok: true, json: async () => ({non_album_tracks: [h.target]})});
    captures = h.context.captureNativeLooseQueueSources({}, [h.target]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify((await captures[0].resolvePlaylistItem()).source_provenance)), inventory());
});
