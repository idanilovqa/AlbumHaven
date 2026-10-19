'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const {id, plain, deferred} = require('./library-mix-fixtures.cjs');
const {nativeFixture, temporaryFixture, payload, row, response} = require('./library-mix-native-fixture.cjs');
const ids = tracks => Array.from(tracks, row => row.playlistItemId);

test('temporary regular start validates one captured queue, follows displayed order and never invents a saved Playlist ID', async () => {
  const h = await temporaryFixture(); h.network();
  await h.mix.trackIntent('play', h.rows[2], {displayedItemIds: [id(13), id(11), id(12)]});
  const queue = h.state.player.playbackQueue;
  assert.deepEqual(ids(queue.tracks), [id(13), id(11), id(12)]); assert.equal(queue.currentIndex, 0);
  assert.equal(queue.playlistId, null); assert.equal(queue.libraryMixRef, id(1)); assert.equal(queue.playlistRevision, id(2));
  assert.deepEqual(plain(queue.sourceEntryRefs), [id(11), id(12), id(13)]);
  assert.equal(queue.albumSnapshot, null); assert.equal(queue.playbackContext, null);
  assert.equal(h.calls.starts.length, 1); assert.equal(h.calls.requests.length, 1);
  assert.deepEqual(JSON.parse(h.calls.requests[0].body), {source_ref: id(1), source_revision: id(2),
    entry_refs: [id(13), id(11), id(12)], starting_entry_ref: id(13)});
  assert.doesNotMatch(JSON.stringify(h.controller.getSnapshot()), /synthetic-only|track_ref|"path"/);
});

test('temporary unplayed-first starts known zero; unknown remains unknown and follows the stable played/unknown remainder', async () => {
  const h = await temporaryFixture({playback_order: 'unplayed_first'}); h.network();
  await h.mix.trackIntent('play', h.rows[0], {fromStart: true});
  const queue = h.state.player.playbackQueue;
  assert.deepEqual(ids(queue.tracks), [id(12), id(11), id(13)]);
  assert.equal(h.calls.starts[0].playlistItemId, id(12)); assert.equal(queue.currentIndex, 0);
  assert.deepEqual(Array.from(queue.tracks, row => row.personalPlayCount), [0, 9, null]);
  assert.deepEqual(plain(h.controller.source().entry_refs), [id(11), id(12), id(13)]);
});

test('temporary shuffle uses actual queue order utility, preserves exact membership and anchors explicit row starts', async () => {
  for (const fromStart of [true, false]) {
    const h = await temporaryFixture({playback_order: 'shuffle'}); h.network();
    vm.runInContext('Math.random = () => 0;', h.c);
    await h.mix.trackIntent('play', h.rows[2], {fromStart});
    const queue = h.state.player.playbackQueue;
    assert.equal(queue.shuffle, true); assert.deepEqual(ids(queue.tracks).sort(), [id(11), id(12), id(13)]);
    assert.deepEqual(ids(queue.regularTracks), [id(11), id(12), id(13)]);
    assert.deepEqual(ids(queue.tracks), fromStart ? [id(12), id(13), id(11)] : [id(13), id(12), id(11)]);
    assert.equal(h.calls.starts[0], queue.tracks[0]);
  }
});

test('temporary play grants bind the original row and exact membership before any network or native activation', async () => {
  const h = await temporaryFixture(); h.network();
  assert.equal(h.mix.canTrackIntent('play', {...h.rows[0]}), false);
  assert.equal(h.mix.canTrackIntent('download', h.rows[0]), false);
  await assert.rejects(h.mix.trackIntent('play', {...h.rows[0]}), {status: 403});
  for (const displayedItemIds of [[id(11)], [id(11), id(12), id(12)], [id(11), id(12), id(99)]])
    await assert.rejects(h.mix.trackIntent('play', h.rows[0], {displayedItemIds}), {status: 409});
  assert.equal(h.calls.requests.length, 0); assert.equal(h.calls.starts.length, 0);
});

test('temporary native replies reject wrong source/protocol/revision/start, duplicate/omitted/foreign/reordered membership and malformed targets', async () => {
  const changes = [reply => {reply.data.source.ref = id(99);}, reply => {reply.data.source.revision = id(99);},
    reply => {reply.data.source.kind = 'playlist';}, reply => {reply.data.source_protocol = 'library_selection_v1';},
    reply => {reply.data.starting_item_ref = id(12);}, reply => {reply.data.tracks.pop();},
    reply => {reply.data.tracks.push(reply.data.tracks[0]);}, reply => {reply.data.tracks.reverse();},
    reply => {reply.data.unavailable_item_refs.push(id(99));},
    reply => {reply.data.tracks[0].native_target.playlist_item_id = id(99);},
    reply => {reply.data.tracks[0].native_target.path = '';},
  ];
  for (const change of changes) {
    const h = await temporaryFixture(), prior = h.state.player.playbackQueue;
    h.network({mutate: reply => {change(reply); return reply;}});
    await assert.rejects(h.mix.trackIntent('play', h.rows[0]));
    assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.activations.length, 0);
  }
});

test('native media capability denial cannot be bypassed by a temporary capture play grant', async () => {
  const h = await temporaryFixture(), prior = h.state.player.playbackQueue; h.network();
  h.c.AlbumHavenCapabilities = {allows: () => false};
  await assert.rejects(h.mix.trackIntent('play', h.rows[0]));
  assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0);
});

test('explicitly unavailable nonstarting members are accounted once without fabricated playback', async () => {
  const h = await temporaryFixture(); h.network({missing: [id(13)]});
  await h.mix.trackIntent('play', h.rows[0]);
  assert.deepEqual(ids(h.state.player.playbackQueue.tracks), [id(11), id(12)]);
  const denied = await temporaryFixture(); denied.network({missing: [id(11)]});
  await assert.rejects(denied.mix.trackIntent('play', denied.rows[0])); assert.equal(denied.calls.starts.length, 0);
});

test('deferred mix replies cannot overwrite newer player activation, retired source, changed scope, abort or later mix activation', async () => {
  for (const invalidate of [h => {h.c.playerTrackSelectionToken++;}, h => h.retire(),
    h => {h.shell.dataset.nativeAccountId = '9';}, h => h.abort.abort()]) {
    const h = await temporaryFixture(), waiting = deferred(), entered = deferred(), prior = h.state.player.playbackQueue;
    h.abort = new AbortController(); let body;
    h.c.fetch = async (_url, options) => {body = JSON.parse(options.body); entered.resolve(); return waiting.promise;};
    const pending = h.mix.trackIntent('play', h.rows[0], {signal: h.abort.signal}); await entered.promise;
    invalidate(h); waiting.resolve(h.reply(body)); await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0);
  }
  const h = await temporaryFixture(), wait = deferred(), entered = deferred(); let body;
  h.c.fetch = async (_url, options) => {body = JSON.parse(options.body); entered.resolve(); return wait.promise;};
  const old = h.mix.trackIntent('play', h.rows[0]); await entered.promise;
  h.network(); await h.mix.trackIntent('play', h.rows[2]); const newer = h.state.player.playbackQueue;
  wait.resolve(h.reply(body)); await assert.rejects(old, {name: 'AbortError'});
  assert.equal(h.state.player.playbackQueue, newer); assert.equal(h.calls.starts.length, 1);
});

test('failed player start restores only this mix queue and preserves a newer queue owner', async () => {
  for (const replace of [false, true]) {
    const h = await temporaryFixture(), prior = h.state.player.playbackQueue, newer = {owner: 'newer'}; h.network();
    h.c.playTrackFromPayload = async () => {if (replace) h.state.player.playbackQueue = newer; return false;};
    await assert.rejects(h.mix.trackIntent('play', h.rows[0]), /did not start/);
    assert.equal(h.state.player.playbackQueue, replace ? newer : prior);
  }
});

test('same-current temporary start delegates continuity replacement to the existing clock owner and guards pending promotion', async () => {
  for (const promotion of [false, true]) {
    const h = await temporaryFixture(), prior = h.state.player.playbackQueue; h.network();
    h.state.player.current = {path: `/synthetic-only/${id(11)}.flac`};
    const engine = {pendingPromotion: promotion ? {} : null, roles: {current: {}, continuity: {owner: 'old-next'}}, pendingContinuityTrack: {old: true}};
    h.c.streamingEngineState = () => engine;
    h.c.closeStreamingContinuityRole = () => {engine.roles.continuity = null; return true;};
    h.c.scheduleStreamingContinuity = value => {h.calls.prepared.push(value); return Promise.resolve();};
    const command = h.mix.trackIntent('play', h.rows[0]);
    if (promotion) {await assert.rejects(command, /transition/); assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.activations.length, 0);}
    else {await command; assert.equal(h.calls.prepared[0].playlistItemId, id(12)); assert.equal(h.calls.activations.length, 1);}
    assert.equal(h.calls.starts.length, 0);
  }
});

test('explicit queue return revalidates temporary capture through its own endpoint and rejects a changed native file', async () => {
  const h = await temporaryFixture(); h.network(); await h.mix.trackIntent('play', h.rows[0]);
  const nativeQueue = h.state.player.playbackQueue, selected = nativeQueue.tracks[0];
  h.calls.requests.length = 0;
  const fresh = await h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected);
  assert.equal(fresh.playlistItemId, selected.playlistItemId); assert.equal(fresh.path, selected.path);
  assert.equal(h.calls.requests.length, 1); assert.equal(h.calls.requests[0].url, '/playlists/creation-source/library-mix/native-queue');
  h.network({mutate: reply => {reply.data.tracks[0].native_target.path = '/synthetic-only/replaced.flac'; return reply;}});
  await assert.rejects(h.c.refreshExplicitQueueReturnTrack({nativeQueue}, selected), /context is unavailable/);
});

test('saved Library Mix owns its saved default and session override without reading or writing ordinary order preference', async () => {
  const h = nativeFixture(payload({library_mix: {...payload().playlist_detail.library_mix, playback_order: 'unplayed_first'}}));
  const scopeKey = h.runtime.snapshot().scopeKey, options = {scopeKey, playlist_id: id(80)};
  let preferenceReads = 0, preferenceWrites = 0;
  h.runtime.configurePlaybackPreferences({read() {preferenceReads++;}, write() {preferenceWrites++;}});
  assert.equal((await h.runtime.readPlayback(options)).data.library_mix_order, 'unplayed_first');
  assert.equal(h.runtime.setLibraryMixOrder({...options, mode: 'shuffle'}), true);
  assert.equal((await h.runtime.readPlayback(options)).data.library_mix_order, 'shuffle');
  assert.equal(h.runtime.setLibraryMixOrder({...options, scopeKey: 'foreign', mode: 'regular'}), false);
  assert.equal(h.runtime.setLibraryMixOrder({...options, mode: 'repeat_one'}), false);
  assert.equal(h.state.view.playlist_detail.library_mix.playback_order, 'unplayed_first');
  assert.equal(preferenceReads, 0); assert.equal(preferenceWrites, 0);
  h.network({temporary: false}); await h.runtime.trackIntent('play', row(1), options);
  assert.equal(h.state.player.playbackQueue.shuffle, true); assert.equal(h.state.player.playbackQueue.playlistId, id(80));
});

test('saved unplayed-first orders fresh personal counts while preserving the explicit selected occurrence', async () => {
  const h = nativeFixture(payload({library_mix: {...payload().playlist_detail.library_mix, playback_order: 'unplayed_first'}}));
  h.network({temporary: false}); const options = {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80)};
  await h.runtime.trackIntent('play', row(2), options);
  assert.deepEqual(ids(h.state.player.playbackQueue.tracks), [id(12), id(11), id(13)]);
  assert.equal(h.state.player.playbackQueue.currentIndex, 0);
  assert.deepEqual(Array.from(h.state.player.playbackQueue.tracks, x => x.personalPlayCount), [0, 9, null]);
});

test('ordinary Playlist retains ordinary preference and queue endpoint; temporary identity never leaks into it', async () => {
  const h = nativeFixture(payload({playlist_kind: 'ordinary', library_mix: null}));
  let reads = 0;
  h.runtime.configurePlaybackPreferences({read: async () => {reads++; return {preferences: {effective_order_mode: 'regular'}};}});
  h.network({temporary: false}); const options = {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80), displayedItemIds: [id(13), id(11), id(12)]};
  await h.runtime.trackIntent('play', row(1), options);
  assert.equal(reads, 1); assert.deepEqual(ids(h.state.player.playbackQueue.tracks), [id(13), id(11), id(12)]);
  assert.equal(h.state.player.playbackQueue.currentIndex, 1); assert.equal(h.state.player.playbackQueue.libraryMixRef, undefined);
  assert.equal(h.runtime.setLibraryMixOrder({...options, mode: 'unplayed_first'}), false);
  assert.equal((await h.runtime.readPlayback(options)).data.library_mix_order, undefined);
});

test('saved Play mix starts first of regular, full shuffle and known-zero-first order rather than pinning the initiating row', async () => {
  for (const mode of ['regular', 'shuffle', 'unplayed_first']) {
    const h = nativeFixture(payload({library_mix: {...payload().playlist_detail.library_mix, playback_order: mode}}));
    h.network({temporary: false}); vm.runInContext('Math.random = () => 0;', h.c);
    await h.runtime.trackIntent('play', row(1), {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80), fromStart: true});
    const expected = mode === 'regular' ? [id(11), id(12), id(13)] : mode === 'shuffle' ? [id(12), id(13), id(11)] : [id(12), id(11), id(13)];
    assert.deepEqual(ids(h.state.player.playbackQueue.tracks), expected);
    assert.equal(h.state.player.playbackQueue.currentIndex, 0); assert.equal(h.calls.starts[0].playlistItemId, expected[0]);
  }
});

test('saved Play mix rebuilds a current queue after session-order override instead of taking the current-item toggle shortcut', async () => {
  const h = nativeFixture(); h.network({temporary: false});
  const options = {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80), fromStart: true};
  await h.runtime.trackIntent('play', row(1), options);
  assert.equal(h.runtime.setLibraryMixOrder({...options, mode: 'unplayed_first'}), true);
  await h.runtime.trackIntent('play', row(1), options);
  assert.equal(h.calls.requests.length, 2); assert.ok(h.calls.requests.every(x => x.url.endsWith('/native-queue')));
  assert.equal(h.calls.starts.at(-1).playlistItemId, id(12)); assert.equal(h.state.player.playbackQueue.currentIndex, 0);
});

test('saved Mix start cannot activate after its playback subscriber replaces the player choice', async () => {
  for (const samePath of [false, true]) for (const replace of [false, true]) {
    const h = nativeFixture(), options = {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80), fromStart: true};
    h.network({temporary: false}); await h.runtime.readPlayback(options);
    if (samePath) h.state.player.current = {path: `/synthetic-only/${id(11)}.flac`};
    const prior = h.state.player.playbackQueue, newer = {owner: 'newer-from-subscriber'};
    const unsubscribe = h.runtime.subscribePlayback({...options, onChange: () => {h.c.playerTrackSelectionToken++; if (replace) h.state.player.playbackQueue = newer;}});
    await assert.rejects(h.runtime.trackIntent('play', row(1), options), {name: 'AbortError'});
    assert.equal(h.state.player.playbackQueue, replace ? newer : prior); assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.activations.length, 0);
    unsubscribe();
  }
});

test('temporary Mix rechecks synchronous playback notifications and restores only its still-owned queue', async () => {
  for (const samePath of [false, true]) for (const replace of [false, true]) {
    const h = await temporaryFixture(); h.network();
    if (samePath) h.state.player.current = {path: `/synthetic-only/${id(11)}.flac`};
    const prior = h.state.player.playbackQueue, newer = {owner: 'newer-from-subscriber'};
    const unsubscribe = h.runtime.subscribePlayback({scopeKey: h.scopeKey, playlist_id: id(80), onChange: () => {
      h.c.playerTrackSelectionToken++; if (replace) h.state.player.playbackQueue = newer;
    }});
    await assert.rejects(h.mix.trackIntent('play', h.rows[0], {fromStart: true}), {name: 'AbortError'});
    assert.equal(h.state.player.playbackQueue, replace ? newer : prior);
    assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.activations.length, 0);
    unsubscribe();
  }
});

// The unchanged native fixture loads the real queue and playlist-runtime owners.
async function lovedTemporary({empty = false} = {}) {
  const {createLibraryMixController} = await import('../../../music_app/static/js/playlists/library-mix.mjs');
  const {capture} = require('./library-mix-fixtures.cjs');
  const h = nativeFixture(), scopeKey = h.runtime.snapshot().scopeKey;
  const descriptor = {version: 1, root_artist_id: '9223372036854775807', scope_mode: 'family'};
  let active = true;
  const controller = createLibraryMixController({scopeKey, artistLovedDescriptor: descriptor, isCurrent: () => active,
    providers: {beginArtistLoved: async () => {
      const result = capture({scopeKey, source_protocol: 'artist_loved_selection_v1',
        artist_loved: {...descriptor, source: 'artist_loved', auto_update: true, playback_order: 'regular'}, ...(empty ? {entries: []} : {})});
      delete result.data.library_mix; delete result.data.coverage; return result;
    }}});
  const automaticPlayCurrent = h.runtime.captureLibraryMixPlaybackIntent();
  await controller.prepare();
  const mix = h.runtime.createLibraryMixRuntime({scopeKey, source: () => controller.source(),
    order: () => controller.getSnapshot().playbackOrder, isCurrent: () => active, automaticPlayCurrent});
  const reply = (body, mutate = value => value) => h.reply(body, {mutate: value => {
    value.data.source_protocol = 'artist_loved_selection_v1'; return mutate(value);
  }});
  const network = (mutate = value => value) => {h.c.fetch = async (url, options) => {
    h.calls.requests.push({url, ...options});
    assert.equal(url, '/playlists/creation-source/artist-loved/native-queue');
    return reply(JSON.parse(options.body), mutate);
  };};
  return {...h, scopeKey, controller, mix, rows: controller.source().detail.track_rows, reply, network,
    retire() {active = false; controller.dispose();}};
}
test('Loved temporary queue and queue return use exact artist-loved route with complete captured ordered membership', async () => {
  const h = await lovedTemporary(); h.network();
  await h.mix.trackIntent('play', h.rows[2], {displayedItemIds: [id(13), id(11), id(12)]});
  const queue = h.state.player.playbackQueue;
  assert.equal(queue.playlistId, null); assert.equal(queue.libraryMixRef, id(1));
  assert.equal(queue.libraryMixProtocol, 'artist_loved_selection_v1');
  assert.deepEqual(ids(queue.tracks), [id(13), id(11), id(12)]);
  assert.deepEqual(plain(queue.sourceEntryRefs), [id(11), id(12), id(13)]);
  const returned = await h.c.refreshExplicitQueueReturnTrack({nativeQueue: queue}, queue.tracks[0]);
  assert.equal(returned.playlistItemId, id(13)); assert.equal(h.calls.requests.length, 2);
  assert.ok(h.calls.requests.every(x => x.url === '/playlists/creation-source/artist-loved/native-queue'));
  h.retire();
});
test('Loved automatic intent captured before admission cannot overwrite newer player intent, but later explicit play remains possible', async () => {
  const h = await lovedTemporary(), prior = h.state.player.playbackQueue; h.network();
  h.c.playerTrackSelectionToken++;
  await assert.rejects(h.mix.trackIntent('play', h.rows[0], {automatic: true, fromStart: true}), {status: 403});
  assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.requests.length, 0); assert.equal(h.calls.starts.length, 0);
  await h.mix.trackIntent('play', h.rows[0], {fromStart: true}); assert.equal(h.calls.starts.length, 1); h.retire();
});
test('Loved native validation rejects Popular reply, missing membership and changed return target without queue publication', async () => {
  for (const mutate of [value => {value.data.source_protocol = 'artist_popular_selection_v1'; return value;},
    value => {value.data.tracks.pop(); return value;}, value => {value.data.source.revision = id(99); return value;}]) {
    const h = await lovedTemporary(), prior = h.state.player.playbackQueue; h.network(mutate);
    await assert.rejects(h.mix.trackIntent('play', h.rows[0]));
    assert.equal(h.state.player.playbackQueue, prior); assert.equal(h.calls.starts.length, 0); h.retire();
  }
  const h = await lovedTemporary(); h.network(); await h.mix.trackIntent('play', h.rows[0]);
  const queue = h.state.player.playbackQueue;
  h.network(value => {value.data.tracks[0].native_target.path = '/changed.flac'; return value;});
  await assert.rejects(h.c.refreshExplicitQueueReturnTrack({nativeQueue: queue}, queue.tracks[0])); h.retire();
});
test('Loved empty capture cannot publish or request native queue', async () => {
  const h = await lovedTemporary({empty: true}), prior = h.state.player.playbackQueue; h.network();
  assert.equal(h.mix.canTrackIntent('play', null), false); await assert.rejects(h.mix.trackIntent('play', null));
  assert.equal(h.calls.requests.length, 0); assert.equal(h.state.player.playbackQueue, prior); h.retire();
});
test('Loved deferred queue retires on actor, library, intent, abort and original owner loss', async () => {
  for (const invalidate of [h => {h.shell.dataset.nativeAccountId = '99';}, h => {h.shell.dataset.nativeLibraryId = '99';},
    h => {h.c.playerTrackSelectionToken++;}, h => h.retire(), (h, abort) => abort.abort()]) {
    const h = await lovedTemporary(), wait = deferred(), entered = deferred(), abort = new AbortController(), prior = h.state.player.playbackQueue;
    let body; h.c.fetch = async (_url, options) => {body = JSON.parse(options.body); entered.resolve(); return wait.promise;};
    const pending = h.mix.trackIntent('play', h.rows[0], {signal: abort.signal, automatic: true});
    await entered.promise; invalidate(h, abort); wait.resolve(h.reply(body));
    await assert.rejects(pending, {name: 'AbortError'}); assert.equal(h.state.player.playbackQueue, prior);
    assert.equal(h.calls.starts.length, 0); h.retire();
  }
});
test('saved Loved default and session order use actual saved runtime without ordinary preference reads or source recapture', async t => {
  const artist_loved = {version: 1, source: 'artist_loved', root_artist_id: '7', scope_mode: 'artist', auto_update: true,
    playback_order: 'unplayed_first', last_evaluated_at: '2026-10-18T00:00:00Z', root_state: 'present', refresh_status: 'current'};
  const data = payload({playlist_kind: 'artist_loved', artist_loved}); delete data.playlist_detail.library_mix;
  // Boot the actual native entry so the bridge consumes the production saved
  // recipe normalizer exported by AlbumHavenPlaylistUI, never a permissive stub.
  const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
  const h = await nativeMixFixture(t);
  // Reply only to the exact native entry hydration. Every other startup URL
  // remains a failure; there is no catch-all successful network response.
  h.c.fetch = async (url, options = {}) => {
    h.calls.requests.push({url, ...options});
    assert.equal(url, `/view-data?surface=playlists&playlist_id=${id(80)}`);
    assert.equal(options.method || 'GET', 'GET');
    assert.equal(h.calls.requests.length, 1, 'one bounded native entry hydration');
    return response(h.state.view);
  };
  await h.boot({}); await h.settle();
  assert.deepEqual(h.calls.requests.map(request => request.url ?? request[0]), [`/view-data?surface=playlists&playlist_id=${id(80)}`],
    'actual native entry performs exactly its selected saved playlist hydration before custom providers are configured');
  const startupRequests = h.calls.requests.length;
  h.state.view = data; h.runtime.sync(); await h.settle();
  const actualRecipe = await import('../../../music_app/static/js/playlists/artist-loved-recipe.mjs');
  assert.equal(h.c.AlbumHavenPlaylistUI.normalizeSavedArtistLovedRecipe, actualRecipe.normalizeSavedArtistLovedRecipe);
  assert.equal(h.c.AlbumHavenPlaylistUI.normalizeSavedArtistLovedRecipe({...artist_loved, root_artist_id: '07'}), null,
    'actual entry keeps strict malformed-recipe denial');
  assert.equal(h.calls.requests.length, startupRequests, 'saved Loved sync adds no ordinary preference or source reads');
  const options = {scopeKey: h.runtime.snapshot().scopeKey, playlist_id: id(80), fromStart: true};
  let reads = 0, writes = 0; h.runtime.configurePlaybackPreferences({read() {reads++;}, write() {writes++;}});
  const initial = await h.runtime.readPlayback(options);
  assert.equal(initial.status, 'ready', 'real entry admits valid saved Loved recipe');
  assert.equal(initial.data.library_mix_order, 'unplayed_first');
  assert.equal(h.runtime.setLibraryMixOrder({...options, mode: 'shuffle'}), true);
  const changed = await h.runtime.readPlayback(options); assert.equal(changed.status, 'ready');
  assert.equal(changed.data.library_mix_order, 'shuffle');
  h.network({temporary: false}); await h.runtime.trackIntent('play', row(1), options);
  assert.equal(h.state.player.playbackQueue.playlistId, id(80)); assert.equal(h.state.player.playbackQueue.shuffle, true);
  assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(data.playlist_detail.artist_loved.playback_order, 'unplayed_first');
  assert.ok(h.calls.requests.slice(startupRequests).every(x => x.url === `/playlists/${id(80)}/native-queue`));
});
