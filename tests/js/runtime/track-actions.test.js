const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const root = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const response = (data, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => data});
const overlay = (love_tier = 'off', allowed_actions = {can_set_love_tier: true}) => ({love_tier, rating: null, allowed_actions});
const media = (row_id = 'listen:one', patch = {}) => ({row_id, actor_id: '1', library_id: 2,
  track_ref: '/fixture/private/song.flac', path: '/fixture/private/song.flac', title: 'Native song', artist: 'Native artist',
  album_title: 'Native album', duration_seconds: 120, track_preference: overlay(), playback_state: {can_start_here: true}, ...patch});
const activityRow = (id = 'listen:one', patch = {}) => ({id, kind: 'listen', title: 'Song', artist: 'Artist',
  source_label: 'Display label does not grant playback', ...patch});
const acknowledgement = (love_tier, patch = {}) => ({ok: true, actor_id: '1', library_id: 2,
  track_ref: '/fixture/private/song.flac', track_preference: overlay(love_tier), ...patch});
function harness() {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = id => {const node = document.createElement('div'); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('app-shell'); shell.dataset.nativeAccountId = '1'; shell.dataset.nativeLibraryId = '2';
  for (const id of ['mobile-home', 'playlists-root', 'shell-main-surface']) add(id);
  const nativeRow = {playlist_item_id: 'item:one', ...media()}, calls = {writes: [], plays: [], resolves: []};
  const playlistPayload = () => ({surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'playlist:one', items: []},
    playlist_detail: {playlist_id: 'playlist:one', allowed_actions: {can_play: true}, track_rows: [nativeRow]}});
  const state = {view: playlistPayload(), ui: {}, player: {current: null, playbackQueue: {owner: 'native'}}};
  let transport = async (_url, init) => response(acknowledgement(JSON.parse(init.body).track_preference.love_tier));
  const playback = {src: '', paused: true, ended: false};
  Object.assign(context, {URL, URLSearchParams, AbortController, Headers, state, playerTrackSelectionToken: 0,
    location: new URL('https://albumhaven.test/?surface=home'), history: {state: {albumHavenNavigationPosition: 1}},
    shouldShowMobileHome: () => !shell.hidden, addEventListener() {}, dispatchEvent() {},
    fetch: (...args) => {calls.writes.push(args); return transport(...args);},
    activateSharedTrackButton: (button, options) => {calls.plays.push([button, options]);},
    getPlayerPlaybackSnapshot: () => playback, isPlaybackLockedByAnotherTab: () => false,
    AlbumHavenCapabilities: {allows: () => true},
  });
  document.cookie = '__Host-album_haven_csrf=fixture-csrf';
  for (const name of ['session-csrf-fetch.js', 'album-track-table.js', 'track-actions.js', 'home-friends-bridge.js', 'playlists-react-bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, {filename: name});
  }
  const home = context.AlbumHavenHomeRuntime, playlists = context.AlbumHavenPlaylistRuntime;
  let rows = [activityRow()], resolver = request => media(request.rowId), reader = async () => ({rows});
  const options = () => ({scopeKey: home.snapshot().scopeKey, account_ref: null, kind: 'listens', period: 'week'});
  const configure = () => home.configureActivityProvider({readActivity: request => reader(request), resolveActivityTrack: request => {calls.resolves.push(request); return resolver(request);}});
  return {...native, home, playlists, shell, state, calls, nativeRow, playlistPayload, playback, options, configure,
    playlistOptions: () => ({scopeKey: playlists.snapshot().scopeKey, playlist_id: 'playlist:one'}),
    rows: value => {rows = value;}, resolver: value => {resolver = value;}, reader: value => {reader = value;},
    transport: value => {transport = value;}};
}

test('the live Love request uses the CSRF owner, exact native ref and scalar-only acknowledgement', async () => {
  const h = harness(), read = h.configure(), projected = await read(h.options()), row = projected.rows[0];
  const initial = h.home.trackPreference(row, h.options());
  assert.match(initial.identity, /^native-track:\d+$/);
  assert.doesNotMatch(JSON.stringify(projected), /fixture|track_ref|playback_state|actor_id|library_id/);
  let notifications = 0; const unsubscribe = h.home.subscribeTrackPreferences(() => {notifications++;});
  h.home.subscribeTrackPreferences(() => {throw new Error('Broken paint listener');});
  const result = await h.home.setTrackLove({row: {...row, track_ref: '/forged', path: '/forged'}, context: h.options(), love_tier: 'loved'});
  const [url, init] = h.calls.writes[0];
  assert.equal(url, '/track-preferences'); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers.get('X-Album-Haven-CSRF'), 'fixture-csrf');
  assert.deepEqual(JSON.parse(init.body), {track_ref: '/fixture/private/song.flac', track_preference: {love_tier: 'loved'}});
  assert.equal(result.identity, initial.identity); assert.equal(result.love_tier, 'loved'); assert.equal(notifications, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture|track_ref|actor_id|library_id|request_key|revision/);
  assert.equal(h.home.trackPreference(row, h.options()).love_tier, 'loved');
  assert.equal(h.playlists.trackPreference({playlist_item_id: 'item:one'}, h.playlistOptions()).identity, result.identity);
  assert.equal(h.playlists.trackPreference({playlist_item_id: 'item:one'}, h.playlistOptions()).love_tier, 'loved');
  unsubscribe(); await h.home.setTrackLove({row, context: h.options(), love_tier: 'obsessed'}); assert.equal(notifications, 1);
});

test('missing, inherited and nonboolean actual overlay grants cannot be replaced by display Love or row grants', async () => {
  for (const patch of [
    {track_preference: null}, {track_preference: overlay('off', {})}, {track_preference: overlay('off', {can_set_love_tier: 'true'})},
    {track_preference: overlay('off', Object.create({can_set_love_tier: true}))}, {track_ref: null},
    {actor_id: 'other'}, {library_id: 3}, {row_id: 'other'}, {source_readable: false},
  ]) {
    const h = harness(); h.resolver(request => media(request.rowId, patch));
    h.rows([activityRow('listen:one', {love_tier: 'loved', can_edit_preferences: true, allowed_actions: {can_set_love_tier: true}})]);
    await h.configure()(h.options());
    await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}));
    assert.equal(h.calls.writes.length, 0);
  }
});

test('malformed, wrong-scope, wrong-track and wrong-tier acknowledgements never confirm Love', async () => {
  for (const patch of [{ok: false}, {actor_id: '2'}, {library_id: 3}, {track_ref: '/wrong'},
    {track_preference: overlay('obsessed')}, {track_preference: overlay('loved', {can_set_love_tier: false})},
    {track_preference: {love_tier: 'loved', rating: 8, allowed_actions: {can_set_love_tier: true}}}]) {
    const h = harness(); await h.configure()(h.options()); h.transport(async () => response(acknowledgement('loved', patch)));
    await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}), /invalid acknowledgement/);
    assert.equal(h.home.trackPreference({id: 'listen:one'}, h.options()).love_tier, 'off');
  }
});

test('same native track writes are serialized across repeated Home listens and Playlist', async () => {
  const h = harness(), pending = deferred(); h.rows([activityRow(), activityRow('listen:two')]);
  await h.configure()(h.options()); h.transport(() => pending.promise);
  const first = h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'});
  await assert.rejects(h.home.setTrackLove({row: {id: 'listen:two'}, context: h.options(), love_tier: 'obsessed'}), {status: 409});
  await assert.rejects(h.playlists.setTrackLove({row: {playlist_item_id: 'item:one'}, context: h.playlistOptions(), love_tier: 'obsessed'}), {status: 409});
  assert.equal(h.calls.writes.length, 1); pending.resolve(response(acknowledgement('loved'))); await first;
  assert.equal(h.home.trackPreference({id: 'listen:two'}, h.options()).love_tier, 'loved');
});

test('pending Home Love cannot publish across actor, library, query, provider, row or cancellation changes', async () => {
  for (const invalidate of [
    h => {h.shell.dataset.nativeAccountId = '2';}, h => {h.shell.dataset.nativeLibraryId = '3';}, h => {h.shell.hidden = true;},
    h => h.configure(), h => {h.resolver(request => media(request.rowId, {track_ref: '/replacement'}));},
    h => h.controller.abort(), h => h.read({...h.options(), kind: 'tracks'}),
    h => {h.rows([activityRow('listen:replacement')]); return h.read(h.options());},
  ]) {
    const h = harness(), pending = deferred(); h.controller = new AbortController(); h.read = h.configure(); await h.read(h.options());
    h.transport(() => pending.promise);
    const saving = h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved', signal: h.controller.signal});
    const rejected = assert.rejects(saving, {name: 'AbortError'}); await invalidate(h);
    pending.resolve(response(acknowledgement('loved'))); await rejected;
  }
});

test('denial blocks further writes until fresh authority, while ambiguous transport failures never retry', async () => {
  const h = harness(), read = h.configure(); await read(h.options());
  h.transport(async () => response(null, 403));
  await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}), {status: 403});
  assert.equal(h.home.trackPreference({id: 'listen:one'}, h.options()).allowed_actions.can_set_love_tier, false);
  await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}), {status: 403});
  assert.equal(h.calls.writes.length, 1);
  await read(h.options()); h.transport(async () => {throw new TypeError('Network failure');});
  await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}), /Network failure/);
  assert.equal(h.calls.writes.length, 2);
});

test('unsupported activity readers and native resolvers leave track actions unavailable', async () => {
  const h = harness(); assert.equal(h.home.configureActivityProvider(), null);
  const read = h.home.configureActivityProvider({readActivity: async () => ({rows: [activityRow('listen:one', {love_tier: 'loved', availability: 'local'})]})});
  const projected = await read(h.options());
  assert.equal(projected.rows[0].love_tier, 'loved'); assert.equal(projected.rows[0].track_preference, undefined);
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, h.options()), false);
  assert.equal(h.home.trackPreference({id: 'listen:one'}, h.options()), null);
  await assert.rejects(h.home.trackIntent('play', {id: 'listen:one'}, h.options()), {status: 403});
  assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.plays.length, 0);
});

test('safe activity projection redacts unreadable rows and refuses private identity or nested display data', async () => {
  const h = harness(); h.rows([activityRow('listen:one', {title: {private_path: '/fixture/private'},
    track_ref: '/fixture/private', path: '/fixture/private', artwork_url: 'file:///fixture/private',
    track_preference: {...overlay(), token: 'secret'}, playback_state: {path: '/fixture/private'}}),
  activityRow('listen:denied', {source_readable: false, title: 'Secret title', track_preference: overlay('obsessed')})]);
  const result = await h.configure()(h.options());
  assert.equal(result.rows[0].title, ''); assert.equal(result.rows[0].artwork_url, null);
  assert.deepEqual(plain(result.rows[1]), {id: 'listen:denied', kind: 'listen', source_readable: false});
  assert.doesNotMatch(JSON.stringify(result), /fixture|private_path|track_ref|playback_state|secret|Secret title/);
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:denied'}, h.options()), false);
  h.rows([activityRow('/fixture/private')]); await assert.rejects(h.configure()(h.options()), /invalid response/);
});

test('progressive pages retain authorized rows; replacement, denial and stale providers retire them', async () => {
  const h = harness(), read = h.configure(); await read(h.options());
  h.rows([activityRow('listen:two')]); await read({...h.options(), cursor: 'next:one'});
  for (const id of ['listen:one', 'listen:two']) assert.equal(h.home.canTrackIntent('play', {id}, h.options()), true);
  h.reader(async () => {throw new Error('Transient page failure');});
  await assert.rejects(read({...h.options(), cursor: 'next:two'}));
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, h.options()), true);
  h.reader(async () => ({rows: [activityRow('listen:three')], pagination: {mode: 'numbered', page: 2, page_size: 100, total_rows: 101}})); await read({...h.options(), pagination: {mode: 'numbered', page: 2, page_size: 100}});
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, h.options()), false);
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:three'}, h.options()), true);
  h.reader(async () => ({status: 'denied'})); await read({...h.options(), cursor: 'next:three'});
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:three'}, h.options()), false);
  h.configure(); await assert.rejects(read(h.options()), {name: 'AbortError'});
});

test('superseded activity completion cannot restore rows or revoke a newer projection', async () => {
  const h = harness(), first = deferred(), second = deferred(); let count = 0;
  h.reader(() => (++count === 1 ? first.promise : second.promise)); const read = h.configure();
  const stale = read(h.options()), rejected = assert.rejects(stale, {name: 'AbortError'}), current = read({...h.options(), kind: 'tracks'});
  second.resolve({rows: [activityRow('listen:new')]}); await current;
  first.resolve({status: 'denied'}); await rejected;
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:new'}, {...h.options(), kind: 'tracks'}), true);
});

test('playback delegates only the current private resolver match and never plays selection', async () => {
  const h = harness(); await h.configure()(h.options()); const queue = h.state.player.playbackQueue;
  const forged = {id: 'listen:one', path: '/forged', title: 'Forged', playback_state: {can_start_here: true}};
  assert.equal(h.home.canTrackIntent('select', forged, h.options()), false);
  await assert.rejects(h.home.trackIntent('select', forged, h.options()), {status: 403});
  await h.home.trackIntent('play', forged, h.options());
  const [button, options] = h.calls.plays[0];
  assert.equal(button.getAttribute('data-track-path'), '/fixture/private/song.flac');
  assert.equal(button.getAttribute('data-track-title'), 'Native song'); assert.equal(button.isConnected, false);
  assert.deepEqual(plain(options), {focusTimeline: true}); assert.strictEqual(h.state.player.playbackQueue, queue);
  h.resolver(request => media(request.rowId, {playback_state: {can_start_here: 'true'}}));
  assert.equal(h.home.canTrackIntent('play', forged, h.options()), false);
  h.resolver(request => {h.context.playerTrackSelectionToken++; return media(request.rowId);});
  await assert.rejects(h.home.trackIntent('play', forged, h.options()), {name: 'AbortError'});
  assert.equal(h.calls.plays.length, 1);
});

test('friend display Love stays read-only even when resolver returns an editable owner overlay', async () => {
  const h = harness(), context = {...h.options(), account_ref: 'friend:one'};
  h.rows([activityRow('listen:one', {track_preference: overlay('obsessed')})]);
  const result = await h.configure()(context);
  assert.equal(result.rows[0].love_tier, 'obsessed'); assert.equal(result.rows[0].track_preference, undefined);
  assert.equal(h.home.trackPreference({id: 'listen:one'}, context), null);
  await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context, love_tier: 'off'}));
  assert.equal(h.calls.writes.length, 0);
});

test('player paint is stable, scoped and change-only; listener failures and cleanup cannot affect the player', async () => {
  const h = harness(); await h.configure()(h.options()); const row = {id: 'listen:one'};
  let notifications = 0; const remove = h.home.subscribeTrackPlayback(() => {notifications++;});
  h.home.subscribeTrackPlayback(() => {throw new Error('Failed paint');});
  const empty = h.home.trackPlayback(row, h.options());
  assert.strictEqual(h.home.trackPlayback(row, h.options()), empty);
  h.context.AlbumHavenTrackPlayback.sync(); h.context.AlbumHavenTrackPlayback.sync(); assert.equal(notifications, 1);
  h.state.player.current = {path: '/fixture/private/song.flac'}; Object.assign(h.playback, {src: '/track?fixture', paused: false});
  h.context.AlbumHavenTrackPlayback.sync(); assert.equal(notifications, 2);
  assert.deepEqual(plain(h.home.trackPlayback(row, h.options())), {isCurrent: true, isPlaying: true});
  h.context.isPlaybackLockedByAnotherTab = () => true; h.context.AlbumHavenTrackPlayback.sync();
  assert.deepEqual(plain(h.home.trackPlayback(row, h.options())), {isCurrent: true, isPlaying: false});
  h.playback.src = ''; assert.strictEqual(h.home.trackPlayback(row, h.options()), empty);
  h.shell.dataset.nativeAccountId = 'other'; assert.strictEqual(h.home.trackPlayback(row, h.options()), empty);
  remove(); h.context.AlbumHavenTrackPlayback.sync(); assert.equal(notifications, 3);
});

test('fresh Playlist reads refresh confirmed preference while older reads cannot erase a newer acknowledgement', async () => {
  const h = harness(), read = h.configure(); await read(h.options());
  const delayed = deferred(); h.transport((url, init) => init?.method === 'POST'
    ? Promise.resolve(response(acknowledgement(JSON.parse(init.body).track_preference.love_tier))) : delayed.promise);
  const pendingRead = h.playlists.readPlaylists(h.playlistOptions());
  await h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'});
  delayed.resolve(response(h.playlistPayload())); const result = await pendingRead;
  assert.equal(result.playlist_detail.track_rows[0].track_preference.love_tier, 'loved');
  h.transport(async () => response(h.playlistPayload()));
  const fresh = await h.playlists.readPlaylists(h.playlistOptions());
  assert.equal(fresh.playlist_detail.track_rows[0].track_preference.love_tier, 'off');
});

test('a native scope round trip cannot revive a pending write or evade its in-flight guard', async () => {
  const h = harness(), native = h.owner('TrackActionsRuntime'), older = deferred(), newer = deferred(); let count = 0;
  h.transport(() => (++count === 1 ? older.promise : newer.promise));
  const first = native.setLove({source: media(), love_tier: 'loved', isCurrent: () => true});
  const rejected = assert.rejects(first, {name: 'AbortError'});
  h.shell.dataset.nativeAccountId = '2'; native.scope(); h.shell.dataset.nativeAccountId = '1'; native.scope();
  await assert.rejects(native.setLove({source: media(), love_tier: 'obsessed', isCurrent: () => true}), {status: 409});
  older.resolve(response(acknowledgement('loved'))); await rejected;
  const second = native.setLove({source: media(), love_tier: 'obsessed', isCurrent: () => true});
  assert.equal(h.calls.writes.length, 2);
  newer.resolve(response(acknowledgement('obsessed'))); await second;
});

test('a cancelled UI write holds its native guard until transport settles', async () => {
  const h = harness(), native = h.owner('TrackActionsRuntime'), pending = deferred(), controller = new AbortController();
  h.transport(() => pending.promise);
  const first = native.setLove({source: media(), love_tier: 'loved', signal: controller.signal, isCurrent: () => true});
  const rejected = assert.rejects(first, {name: 'AbortError'}); controller.abort();
  assert.equal(h.calls.writes[0][1].signal, undefined, 'UI cancellation cannot cancel server-side persistence');
  await assert.rejects(native.setLove({source: media(), love_tier: 'obsessed', isCurrent: () => true}), {status: 409});
  assert.equal(h.calls.writes.length, 1); pending.resolve(response(acknowledgement('loved'))); await rejected;
});

test('a retired actor request cannot release the current actor same-ref guard', async () => {
  const h = harness(), native = h.owner('TrackActionsRuntime'), older = deferred(), newer = deferred(); let count = 0;
  h.transport(() => (++count === 1 ? older.promise : newer.promise));
  const first = native.setLove({source: media(), love_tier: 'loved', isCurrent: () => true});
  const rejected = assert.rejects(first, {name: 'AbortError'});
  h.shell.dataset.nativeAccountId = '2'; native.scope();
  const second = native.setLove({source: media(), love_tier: 'obsessed', isCurrent: () => true});
  older.resolve(response(acknowledgement('loved'))); await rejected;
  await assert.rejects(native.setLove({source: media(), love_tier: 'off', isCurrent: () => true}), {status: 409});
  assert.equal(h.calls.writes.length, 2);
  newer.resolve(response(acknowledgement('obsessed', {actor_id: '2'}))); await second;
});


test('an empty final progressive page retains committed native row authority', async () => {
  const h = harness(), read = h.configure(); await read(h.options());
  h.reader(async () => ({status: 'empty'}));
  await read({...h.options(), cursor: 'last:page'});
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, h.options()), true);
});

test('invalid page echoes do not replace authority for the committed page', async () => {
  const h = harness(), read = h.configure(); await read(h.options());
  h.reader(async () => ({rows: [activityRow('listen:wrong')], pagination: {mode: 'numbered', page: 3, page_size: 100, total_rows: 201}}));
  await assert.rejects(read({...h.options(), pagination: {mode: 'numbered', page: 2, page_size: 100}}), /invalid page/);
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, h.options()), true);
  assert.equal(h.home.canTrackIntent('play', {id: 'listen:wrong'}, h.options()), false);
});

test('asynchronous or inherited provider authority cannot activate native track actions', async () => {
  for (const resolve of [
    async () => {throw new Error('Unsupported asynchronous resolver');},
    request => {const source = media(request.rowId); delete source.actor_id; return Object.assign(Object.create({actor_id: '1'}), source);},
    request => media(request.rowId, {track_preference: Object.assign(Object.create({allowed_actions: {can_set_love_tier: true}}), {love_tier: 'off', rating: null})}),
  ]) {
    const h = harness(); h.resolver(resolve); await h.configure()(h.options());
    await assert.rejects(h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'}));
    assert.equal(h.calls.writes.length, 0);
  }
});


test('malformed Playlist responses cannot overwrite the shared validated Love acknowledgement', async () => {
  const h = harness(); await h.configure()(h.options());
  await h.home.setTrackLove({row: {id: 'listen:one'}, context: h.options(), love_tier: 'loved'});
  h.transport(async () => response({playlist_detail: {track_rows: [h.nativeRow]}}));
  await assert.rejects(h.playlists.readPlaylists(h.playlistOptions()), /invalid response/);
  assert.equal(h.home.trackPreference({id: 'listen:one'}, h.options()).love_tier, 'loved');
});

test('native progressive revocations match the public controller on successful and rejected pages', async () => {
  const {createHomeFriendsController} = await import('../../../music_app/static/js/home-friends/model.mjs');
  for (const kind of ['listen', 'track', 'album', 'artist']) for (const variant of ['append', 'denial-only', 'cursor-cycle', 'malformed-pagination', 'malformed-cursor']) {
    const h = harness(), queryKind = {listen: 'listens', track: 'tracks', album: 'albums', artist: 'artists'}[kind];
    const context = {...h.options(), kind: queryKind}, playable = ['listen', 'track'].includes(kind);
    h.reader(async () => ({rows: [activityRow('listen:one', {kind, title: 'Private old title'}), activityRow('listen:kept', {kind})], next_cursor: 'page:two'}));
    const read = h.configure(), controller = createHomeFriendsController({providers: {readActivity: read}});
    controller.setScope(h.options().scopeKey);
    await controller.loadActivity({kind: queryKind, period: 'week'});
    const incoming = [activityRow('listen:one', {kind, source_readable: false, title: 'Must not survive denial'})];
    if (variant !== 'denial-only') incoming.push(activityRow('listen:new', {kind}));
    h.reader(async () => ({rows: incoming, next_cursor: variant === 'cursor-cycle' ? 'page:two' : variant === 'malformed-cursor' ? {private_cursor: 'secret'} : 'page:three',
      ...(variant === 'malformed-pagination' ? {pagination: {mode: 'numbered', page: 0, page_size: '100', total_rows: {private_count: 999}}} : {})}));
    const result = await controller.loadMoreActivity(), state = controller.getSnapshot();
    assert.equal(result.status, variant === 'append' ? 'ready' : 'error');
    assert.deepEqual(state.activity.data.rows.map(row => row.id), variant === 'append'
      ? ['listen:one', 'listen:kept', 'listen:new'] : ['listen:one', 'listen:kept']);
    assert.equal(state.activity.data.rows[0].source_readable, false);
    assert.equal(state.activity.data.rows[0].title, `Unavailable ${kind === 'listen' ? 'track' : kind}`);
    assert.equal(state.activity.data.next_cursor, variant === 'append' ? 'page:three' : 'page:two');
    assert.doesNotMatch(JSON.stringify(state.activity.data.rows[0]), /Private old title|Must not survive denial/);
    assert.equal(h.home.canTrackIntent('play', {id: 'listen:one'}, context), false);
    assert.equal(h.home.trackPreference({id: 'listen:one'}, context), null);
    assert.equal(h.home.canTrackIntent('play', {id: 'listen:kept'}, context), playable);
    assert.equal(h.home.canTrackIntent('play', {id: 'listen:new'}, context), playable && variant === 'append');
    controller.dispose();
  }
});

test('Playlist source resolution cannot displace a newer native player selection', async () => {
  const h = harness(); let grants = 0;
  h.context.AlbumHavenCapabilities.allows = () => {if (++grants === 1) h.context.playerTrackSelectionToken++; return true;};
  await assert.rejects(h.playlists.trackIntent('play', {playlist_item_id: 'item:one'}, h.playlistOptions()), {name: 'AbortError'});
  assert.equal(h.calls.plays.length, 0);
});
