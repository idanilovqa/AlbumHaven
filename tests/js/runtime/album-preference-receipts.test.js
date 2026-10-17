// Whole native source units. Synthetic DTOs; no browser, server or E2E claim.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const resultOf = promise => promise.then(value => ({value}), error => ({error}));
const copy = value => JSON.parse(JSON.stringify(value));
const overlay = (editable = true, tier = 'off') => ({rating: null, love_tier: tier,
  allowed_actions: {can_rate: editable, can_set_love_tier: editable}});
const row = (patch = {}) => ({track_id: 11, path: '/synthetic/receipt/one.flac',
  track_ref: '/synthetic/receipt/one.flac', canonical_track_ref: 'track:receipt-one',
  inventory_track_ref: 'inventory-track:9:11', track_preference_state: 'available',
  track_preference: overlay(), source_readable: true, allowed_actions: {can_read: true}, ...patch});
const album = (track = row()) => ({key: 'receipt-album', name: 'Album', album_artist: 'Artist', tracks: [track],
  track_rows: [copy(track)]});

function fixture() {
  const shell = {dataset: {nativeAccountId: '7', nativeLibraryId: '9'}}, requests = [];
  const state = {ui: {}, status: {inventory_mutation_revision: 1}, gallery: {albumIndex: new Map()}, view: {}, player: {}};
  let generation = 1;
  const context = vm.createContext({window: {addEventListener() {}, removeEventListener() {}},
    document: {getElementById: id => id === 'app-shell' ? shell : null}, state,
    PrivateUITransport: {generation: () => generation}, AbortController,
    getAlbumRequestKey: value => value?.key || '', getAlbumIdentity: value => value?.key || '',
    getIndexedAlbum: key => state.gallery.albumIndex.get(key) || null,
    albumRequiresHydration: value => Boolean(value && !Array.isArray(value.tracks)),
    fetch: (url, options) => {const response = deferred(); requests.push({url, options, response}); return response.promise;}});
  for (const name of ['track-actions.js', 'track-modal-lightbox-helpers.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, {filename: name});
  }
  const runtime = vm.runInContext('TrackActionsRuntime', context);
  const receipts = {source: value => context.getTrackModalPreferenceSource(value)};
  const fetchAlbum = options => context.fetchTrackModalAlbumDetails('receipt-album', options);
  function respond(index, value, {status = 200, ok = true} = {}) {
    requests[index].response.resolve({ok, status, json: async () => ({ok, album: value})});
  }
  const projection = value => {const source = receipts.source(value); return source && runtime.preference(source);};
  return {context, runtime, receipts, requests, shell, state, fetchAlbum, respond, projection,
    changeSession: () => {generation++;}};
}

async function read(f, value = album()) {
  const index = f.requests.length, pending = f.fetchAlbum(); f.respond(index, value); return pending;
}

test('Only a successful own-actor request admits exact available rows; unknown defaults remain unavailable', async () => {
  const f = fixture(), data = album();
  assert.equal(f.receipts.source(data.tracks[0]), null, 'DTO fields alone are not read provenance');
  const returned = await read(f, data);
  assert.equal(f.projection(returned.tracks[0]).love_tier, 'off');
  assert.equal(f.projection(returned.track_rows[0]).identity, f.projection(returned.tracks[0]).identity);
  assert.equal(f.projection(returned.tracks[0]).allowed_actions.can_set_love_tier, true);
  assert.equal(f.receipts.source(copy(returned.tracks[0])), null, 'ordinary JSON clones cannot mint provenance');
  const unknown = await read(f, album(row({track_preference_state: 'unavailable'})));
  assert.equal(f.receipts.source(unknown.tracks[0]), null);
  const legacyRow = row(); delete legacyRow.track_preference_state;
  const legacy = await read(f, album(legacyRow));
  assert.equal(f.receipts.source(legacy.tracks[0]), null);
});

for (const grants of [[false, true], [true, false]]) {
  test(`All raw/row/duplicate aliases share one deny-dominant response batch (${grants})`, async () => {
    const f = fixture(), data = album(row({track_preference: overlay(grants[0], 'loved')}));
    data.track_rows = [row({track_ref: 'track:receipt-one', track_preference: overlay(grants[1], 'loved')})];
    data.duplicate_sources = [{tracks: [row({track_preference: overlay(true, 'loved')})]}];
    const result = await read(f, data);
    const views = [result.tracks[0], result.track_rows[0], result.duplicate_sources[0].tracks[0]].map(f.projection);
    assert.ok(views.every(Boolean));
    assert.equal(new Set(views.map(value => value.identity)).size, 1);
    assert.deepEqual(views.map(value => value.allowed_actions.can_set_love_tier), [false, false, false]);
  });
}

test('Request captures its epoch before fetch and cannot admit a grant after an intervening denial', async () => {
  const f = fixture();
  const current = await read(f);
  const pending = f.fetchAlbum();
  f.runtime.acceptRead({...f.receipts.source(current.tracks[0]), track_preference: overlay(false, 'loved')}, f.runtime.readEpoch());
  const stale = album(); f.respond(1, stale); await pending;
  assert.equal(f.receipts.source(stale.tracks[0]), null, 'rejected epoch must not gain an exact-row receipt');
  assert.equal(f.projection(current.tracks[0]).allowed_actions.can_set_love_tier, false);
});

for (const changed of ['actor', 'session', 'inventory', 'abort']) {
  test(`In-flight ${changed} change prevents Album response preference admission`, async () => {
    const f = fixture(), controller = new AbortController();
    const pending = resultOf(f.fetchAlbum({signal: controller.signal}));
    if (changed === 'actor') f.shell.dataset.nativeAccountId = '8';
    if (changed === 'session') f.changeSession();
    if (changed === 'inventory') f.state.status.inventory_mutation_revision++;
    if (changed === 'abort') controller.abort();
    const data = album(); f.respond(0, data); await pending;
    assert.equal(f.receipts.source(data.tracks[0]), null);
    assert.equal(f.receipts.source(data.track_rows[0]), null);
  });
}

test('Cache insertion and cache hits never admit fabricated or previously denied grants', async () => {
  const f = fixture(), fabricated = album();
  f.context.cacheHydratedTrackModalAlbum('receipt-album', fabricated);
  const cached = await f.context.loadTrackModalAlbumDetails('receipt-album');
  assert.equal(f.requests.length, 0);
  assert.equal(f.receipts.source(cached.tracks[0]), null);
  const live = await read(f);
  f.context.cacheHydratedTrackModalAlbum('receipt-album', live);
  f.runtime.acceptRead({...f.receipts.source(live.tracks[0]), track_preference: overlay(false, 'loved')}, f.runtime.readEpoch());
  const denied = await f.context.loadTrackModalAlbumDetails('receipt-album');
  assert.equal(f.requests.length, 1);
  assert.equal(f.projection(denied.tracks[0]).love_tier, 'loved');
  assert.equal(f.projection(denied.tracks[0]).allowed_actions.can_set_love_tier, false);
});

test('Subject DTOs cannot acquire own-actor read provenance despite copied private fields', async () => {
  const f = fixture(), data = album(row({read_only_subject: 'subject-account'}));
  data.read_only_subject = 'subject-account';
  await read(f, data);
  assert.equal(f.receipts.source(data.tracks[0]), null);
  assert.equal(f.receipts.source(data.track_rows[0]), null);
});

test('Missing media remains distinct from an available read-only preference receipt', async () => {
  const f = fixture(), data = await read(f, album(row({availability: 'missing',
    playback_state: {can_start_here: false}, track_preference: overlay(false, 'obsessed')})));
  const value = f.projection(data.tracks[0]);
  assert.equal(value.love_tier, 'obsessed');
  assert.equal(value.allowed_actions.can_set_love_tier, false);
});

test('Private row receipt invalidates when identity, grant, availability or readability is rewritten', async () => {
  for (const mutate of [value => {value.canonical_track_ref = 'track:other';},
    value => {value.inventory_track_ref = 'inventory-track:9:12';},
    value => {value.track_preference_state = 'unavailable';},
    value => {value.source_readable = false;},
    value => {value.track_preference = overlay(false);}]) {
    const f = fixture(), data = await read(f);
    mutate(data.tracks[0]);
    assert.equal(f.receipts.source(data.tracks[0]), null, 'same object does not authorize changed facts');
  }
});

test('Explicit subject hydration cannot admit an ordinary own-actor DTO returned by the endpoint', async () => {
  const f = fixture(), data = album();
  const pending = f.fetchAlbum({readOnlySubject: true}); f.respond(0, data); await pending;
  assert.equal(f.receipts.source(data.tracks[0]), null);
  assert.equal(f.receipts.source(data.track_rows[0]), null);
});

test('Gallery-list rows and nested duplicate rows receive guarded exact-object provenance', async () => {
  const f = fixture(), data = album();
  data.gallery_list_block = {track_rows: [row()]};
  data.duplicate_sources = [{tracks: [row()], track_rows: [row()], gallery_list_block: {track_rows: [row()]},
    duplicate_sources: [{tracks: [row()]}]}];
  await read(f, data);
  const all = [data.tracks[0], data.track_rows[0], data.gallery_list_block.track_rows[0],
    data.duplicate_sources[0].tracks[0], data.duplicate_sources[0].track_rows[0],
    data.duplicate_sources[0].gallery_list_block.track_rows[0], data.duplicate_sources[0].duplicate_sources[0].tracks[0]];
  const projections = all.map(f.projection);
  assert.ok(projections.every(Boolean));
  assert.equal(new Set(projections.map(value => value.identity)).size, 1);
});

test('Read begun before stale write settlement cannot restore authority; a post-settlement request can', async () => {
  const f = fixture(), data = await read(f), source = f.receipts.source(data.tracks[0]);
  let current = true;
  const writing = resultOf(f.runtime.setLove({source, love_tier: 'loved', isCurrent: () => current}));
  assert.equal(f.requests.length, 2);
  current = false;
  const duringWrite = f.fetchAlbum();
  f.respond(1, null); // The stale transport settles; its acknowledgement cannot publish.
  assert.ok((await writing).error);
  const stale = album(); f.respond(2, stale); await duringWrite;
  assert.equal(f.receipts.source(stale.tracks[0]), null);
  assert.equal(f.projection(data.tracks[0]), null);
  const fresh = await read(f, album(row({track_preference: overlay(true, 'loved')})));
  assert.equal(f.projection(fresh.tracks[0]).love_tier, 'loved');
  assert.equal(f.projection(fresh.tracks[0]).allowed_actions.can_set_love_tier, true);
});

function mountAlbum(f, data) {
  let mounted = null, current = true;
  f.context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope:album-receipt'})};
  f.context.window.AlbumHavenPlaytableUI = {mount: (_host, options) => {
    mounted = options; return {dispose() {}, update() {}};
  }};
  vm.runInContext(fs.readFileSync(path.join(root, 'playtable-source.js'), 'utf8'), f.context, {filename: 'playtable-source.js'});
  const native = vm.runInContext('NativePlaytables', f.context);
  const groups = [{tracks: [{title: 'One'}]}];
  native.prepare('album-tracks', data, groups, [data.tracks[0]], () => current);
  assert.equal(native.mount('album-tracks', {querySelectorAll: () => []}), true);
  assert.ok(mounted.trackPreferences, 'native Album mount must provide its existing React preference boundary');
  const {rows, context, runtime} = mounted.trackPreferences;
  assert.equal(rows.length, 1);
  return {native, row: rows[0], context, runtime, retireOwner: () => {current = false;}};
}

test('Native Album preference bridge exposes only opaque facts and rejects forged public row/context', async () => {
  const f = fixture(), data = await read(f), mounted = mountAlbum(f, data);
  const {row: publicRow, context, runtime} = mounted;
  const value = runtime.trackPreference(publicRow, context);
  assert.equal(value.love_tier, 'off');
  assert.match(value.identity, /^native-track:/);
  assert.equal(runtime.trackPreference({...publicRow}, context), null);
  assert.equal(runtime.trackPreference(publicRow, {...context, scopeKey: 'foreign'}), null);
  const serialized = JSON.stringify({publicRow, value});
  for (const privateValue of ['/synthetic/', 'inventory-track:', 'track:receipt-one']) {
    assert.equal(serialized.includes(privateValue), false, 'private identities never enter React display rows');
  }
  mounted.retireOwner();
  assert.equal(runtime.trackPreference(publicRow, context), null);
});

test('Native Album Love write uses canonical authority, blocks duplicate transport, and retires with its source', async () => {
  const f = fixture(), data = await read(f), mounted = mountAlbum(f, data);
  const command = {row: mounted.row, context: mounted.context, love_tier: 'loved'};
  const first = resultOf(mounted.runtime.setTrackLove(command));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, '/track-preferences');
  assert.equal(JSON.parse(f.requests[1].options.body).track_ref, 'track:receipt-one');
  const duplicate = await resultOf(mounted.runtime.setTrackLove(command));
  assert.ok(duplicate.error);
  assert.equal(f.requests.length, 2);
  mounted.native.retire('album-tracks');
  f.requests[1].response.resolve({ok: true, status: 200, json: async () => ({ok: true,
    actor_id: '7', library_id: 9, track_ref: 'track:receipt-one', track_preference: overlay(true, 'loved')})});
  assert.ok((await first).error, 'retired owner cannot publish a write acknowledgement');
  assert.equal(mounted.runtime.trackPreference(mounted.row, mounted.context), null);
});

test('Raw tracks without shared track_ref normalize their path only behind admitted private provenance', async () => {
  const f = fixture(), raw = row(); delete raw.track_ref;
  const data = await read(f, album(raw));
  const value = f.projection(data.tracks[0]);
  assert.equal(value.love_tier, 'off');
  assert.equal(value.allowed_actions.can_set_love_tier, true);
});

for (const patch of [{canonical_track_ref: null}, {inventory_track_ref: null},
  {inventory_track_ref: 'inventory-track:10:11'}, {source_readable: false},
  {allowed_actions: {can_read: false}}]) {
  test(`Available label alone cannot authorize invalid identity or unreadable source ${JSON.stringify(patch)}`, async () => {
    const f = fixture(), data = await read(f, album(row(patch)));
    assert.equal(f.receipts.source(data.tracks[0]), null);
  });
}
