const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/home-friends-bridge.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const response = (payload, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => payload});
const local = (ref = 'album:one', patch = {}) => ({album_ref: ref, name: 'Album', row_kind: 'local_album',
  local_match_state: 'matched_local', allowed_actions: {can_open_album: true, can_play_album: true}, ...patch});
const recent = (rows = [local()]) => ({recent_local_albums: rows, recent_not_local_albums: []});
const album = (key = 'album:one') => ({key, name: 'Album', tracks: [{path: '/test-only/music/song.flac', src: '/track?test-only', title: 'Song'}]});
function setup(payload = recent(), {captureResourceRevalidator = false} = {}) {
  const home = {dataset: {homeAccountId: 'fallback-account', homeLibraryId: 'fallback-library', accountName: 'Listener'}};
  const shell = {dataset: {nativeAccountId: 'account:one', nativeLibraryId: 'library:one'}, hidden: false};
  const nodes = new Map([['mobile-home', home], ['app-shell', shell]]), events = new Map(), observers = [];
  const calls = {reads: [], details: [], opens: [], builds: [], queues: [], plays: [], confirms: []};
  const state = {view: payload, ui: {pendingTrackModalLoadToken: 0}, player: {playbackQueue: {owner: 'previous'}}};
  const window = {location: new URL('https://albumhaven.test/?surface=home'), history: {state: {albumHavenNavigationPosition: 4}},
    addEventListener: (name, listener) => events.set(name, listener), dispatchEvent() {},
    AlbumHavenCapabilities: {allows: capability => capability === 'library.media.read'}};
  const context = vm.createContext({window, document: {getElementById: id => nodes.get(id)}, state, URL, Event,
    AbortController,
    shouldShowMobileHome: () => !shell.hidden && !state.ui.pendingViewTransition,
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe(target, options) {this.target = target; this.options = options;}},
    fetch: async (...args) => {calls.reads.push(args); throw new Error('Unexpected Home network request');},
    fetchTrackModalAlbumDetails: async (...args) => {calls.details.push(args); return album(args[0]);},
    albumRequiresHydration: () => false, getTrackModalElements: () => ({overlay: {}}),
    openTrackModal: (...args) => calls.opens.push(args), playerTrackSelectionToken: 0,
    releaseTrackModalSelection() {},
    buildAlbumPlaybackQueueState: value => {calls.builds.push(value); return {tracks: value.tracks};},
    setAlbumPlaybackQueue: (value, selected) => {calls.queues.push([value, selected]); state.player.playbackQueue = {album: value, selected};},
    playTrackFromPayload: async value => {calls.plays.push(value); return true;},
    showAppConfirmDialog: value => {calls.confirms.push(value); return Promise.resolve(false);},
    escapeHtml: String,
  });
  for (const name of ['track-actions.js', 'resource-selection.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', name), 'utf8'), context, {filename: name});
  }
  let revalidateResource, retainResource;
  if (captureResourceRevalidator) {
    const nativeSelection = window.AlbumHavenResourceSelection;
    window.AlbumHavenResourceSelection = Object.freeze({...nativeSelection, create(options) {
      revalidateResource = options.revalidateResource;
      retainResource = options.retainResource;
      return nativeSelection.create(options);
    }});
  }
  vm.runInContext(source, context, {filename: 'home-friends-bridge.js'});
  return {bridge: window.AlbumHavenHomeRuntime, revalidateResource, retainResource, context, window, state, home, shell, nodes, observers, events, calls};
}

test('notification request form has a bounded authenticated drawer entry while ordinary forms require Home', () => {
  const h = setup(), opened = [];
  h.context.openReactFormDialog = (options, available) => {
    if (!available()) throw new Error('The form dialog is unavailable.');
    opened.push({options, available}); return {close() {}};
  };
  const drawer = {isConnected: true, hidden: false}; h.nodes.set('cover-lookup-drawer', drawer);
  h.shell.hidden = true;
  const scopeKey = h.bridge.snapshot().scopeKey;
  assert.equal(h.bridge.snapshot().authenticated, true);
  assert.throws(() => h.bridge.openForm({pageId: 'own-profile'}), /unavailable/);
  let current = true;
  const options = {scopeKey, isCurrent: () => current, pageId: 'home-friend-request', parentSurface: '#cover-lookup-drawer'};
  h.bridge.openFriendRequestForm(options); assert.equal(opened.length, 1);
  assert.equal(Object.hasOwn(opened[0].options, 'pageId'), false, 'request dialogs stay content-sized on phones');
  for (const patch of [{scopeKey: 'foreign'}, {pageId: 'own-profile'}, {parentSurface: '#other'}, {isCurrent: null}]) {
    assert.throws(() => h.bridge.openFriendRequestForm({...options, ...patch}), /unavailable/);
  }
  drawer.hidden = true; assert.equal(opened[0].available(), false); drawer.hidden = false;
  current = false; assert.equal(opened[0].available(), false); current = true;
  h.shell.dataset.nativeAccountId = ''; assert.equal(h.bridge.snapshot().authenticated, false);
  assert.equal(opened[0].available(), false);
});

test('confirmation retains existing string callers and explicit destructive presentation options', async () => {
  const h = setup(); await h.bridge.confirm('Existing confirmation');
  assert.equal(h.calls.confirms[0].message, 'Existing confirmation');
  await h.bridge.confirm('Unfriend this person?', {title: 'Unfriend', acceptLabel: 'Unfriend', danger: true, private: 'omit'});
  assert.deepEqual(plain(h.calls.confirms[1]), {message: 'Unfriend this person?', title: 'Unfriend', acceptLabel: 'Unfriend', danger: true});
});

test('Home snapshot copies grants and stays stable until a native change', async () => {
  const input = recent(), h = setup(input), first = h.bridge.snapshot();
  let notifications = 0; const unsubscribe = h.bridge.subscribe(() => {notifications++;});
  assert.strictEqual(h.bridge.snapshot(), first);
  assert.equal(first.accountName, 'Listener');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.payload.recent_local_albums), true);
  assert.equal(Object.isFrozen(first.payload.recent_local_albums[0].allowed_actions), true);
  input.recent_local_albums[0].album_ref = 'forged';
  input.recent_local_albums[0].allowed_actions.can_play_album = false;
  assert.equal(first.payload.recent_local_albums[0].album_ref, 'album:one');
  await h.bridge.albumIntent('play', 'album:one');
  assert.equal(h.calls.plays.length, 1);
  assert.equal(notifications, 0);
  h.state.view = recent([local('album:two')]); h.bridge.sync();
  assert.equal(notifications, 1);
  unsubscribe(); h.state.view = recent([]); h.bridge.sync(); assert.equal(notifications, 1);
  assert.throws(() => h.bridge.subscribe(null), /listener/);
});

test('Home grants require an exact unique current local match before reading native details', async () => {
  const denied = [
    recent([]), recent([local(), local()]),
    recent([local('album:one', {row_kind: 'external_album'})]),
    recent([local('album:one', {local_match_state: 'unresolved'})]),
    recent([local('album:one', {allowed_actions: {can_open_album: 'true', can_play_album: true}})]),
    recent([local('album:one', {allowed_actions: Object.create({can_open_album: true, can_play_album: true})})]),
    {recent_local_albums: [], recent_not_local_albums: [local()]},
  ];
  for (const payload of denied) {
    const h = setup(payload);
    await assert.rejects(h.bridge.albumIntent('open', 'album:one'), {status: 403});
    await assert.rejects(h.bridge.albumIntent('play', 'album:one'), {status: 403});
    assert.equal(h.calls.details.length, 0);
  }
  const h = setup(recent([local('album:one', {allowed_actions: {can_open_album: true, can_play_album: 1}})]));
  await h.bridge.albumIntent('open', 'album:one');
  await assert.rejects(h.bridge.albumIntent('play', 'album:one'), {status: 403});
  await assert.rejects(h.bridge.albumIntent('delete', 'album:one'), /Unsupported/);
  await assert.rejects(h.bridge.albumIntent('open', {album_ref: 'album:one'}), /Unsupported/);
  assert.equal(h.calls.details.length, 1);
});

test('the native shell owns scope and revokes cached Home grants without republishing the old view', async () => {
  for (const field of ['nativeAccountId', 'nativeLibraryId']) {
    const h = setup(), before = h.bridge.snapshot();
    h.shell.dataset[field] = 'new-owner';
    h.observers[0].callback();
    const after = h.bridge.snapshot();
    assert.notEqual(after.scopeKey, before.scopeKey);
    assert.equal(after.payload, null);
    await assert.rejects(h.bridge.albumIntent('play', 'album:one'), {status: 403});
    assert.equal(h.calls.details.length, 0);
  }
});

test('Recent reads use the native read route, credentials, no-store and supplied cancellation', async () => {
  const h = setup(recent([])), controller = new AbortController(), data = recent(); let request;
  h.context.fetch = async (...args) => {request = args; return response(data);};
  await h.bridge.readRecent({signal: controller.signal});
  assert.equal(request[0], '/home-data');
  assert.equal(request[1].credentials, 'same-origin'); assert.equal(request[1].cache, 'no-store');
  assert.equal(request[1].headers.Accept, 'application/json'); assert.strictEqual(request[1].signal, controller.signal);
  data.recent_local_albums[0].allowed_actions.can_open_album = false;
  await h.bridge.albumIntent('open', 'album:one');
  assert.equal(h.calls.opens.length, 1, 'a returned transport object cannot rewrite the copied native authority');
});

test('a superseded Recent rejection cannot erase a newer successful read', async () => {
  const h = setup(), older = deferred(), newer = deferred(); let count = 0;
  h.context.fetch = () => (++count === 1 ? older.promise : newer.promise);
  const a = h.bridge.readRecent(), aRejected = assert.rejects(a, {name: 'AbortError'}), b = h.bridge.readRecent();
  newer.resolve(response(recent([local('album:new')]))); await b;
  const scope = h.bridge.snapshot().scopeKey;
  older.resolve(response(null, 403)); await aRejected;
  assert.equal(h.bridge.snapshot().scopeKey, scope);
  assert.equal(h.bridge.snapshot().payload.recent_local_albums[0].album_ref, 'album:new');
});

test('Recent JSON completion cannot cross cancellation, hidden Home, view replacement or account scope', async () => {
  for (const invalidate of [
    h => h.controller.abort(), h => {h.shell.hidden = true;},
    h => {h.state.view = recent([local('album:new')]);}, h => {h.shell.dataset.nativeAccountId = 'other';},
  ]) {
    const h = setup(), json = deferred(), entered = deferred(); h.controller = new AbortController();
    h.context.fetch = async () => ({ok: true, status: 200, json() {entered.resolve(); return json.promise;}});
    const pending = h.bridge.readRecent({signal: h.controller.signal});
    const rejected = assert.rejects(pending, {name: 'AbortError'}); await entered.promise;
    invalidate(h); json.resolve(recent([local('album:stale')])); await rejected;
    assert.equal(h.bridge.snapshot().payload?.recent_local_albums.some(row => row.album_ref === 'album:stale') || false, false);
  }
});

test('access denial changes Home scope, erases grants and cannot be undone by cached native data', async () => {
  const h = setup(), before = h.bridge.snapshot();
  h.context.fetch = async () => response(recent(), 403);
  await assert.rejects(h.bridge.readRecent(), {status: 403});
  assert.notEqual(h.bridge.snapshot().scopeKey, before.scopeKey);
  assert.equal(h.bridge.snapshot().payload, null);
  h.state.view = recent(); h.bridge.sync();
  assert.equal(h.bridge.snapshot().payload, null);
  await assert.rejects(h.bridge.albumIntent('open', 'album:one'), {status: 403});
  h.context.fetch = async () => response(recent([local('album:fresh')])); await h.bridge.readRecent();
  await h.bridge.albumIntent('open', 'album:fresh'); assert.equal(h.calls.opens.length, 1);
});

test('malformed Recent reads erase obsolete grants without inventing an empty successful view', async () => {
  const h = setup();
  h.context.fetch = async () => response({recent_local_albums: [null], recent_not_local_albums: []});
  await assert.rejects(h.bridge.readRecent(), /invalid response/);
  assert.equal(h.bridge.snapshot().payload, null);
  await assert.rejects(h.bridge.albumIntent('open', 'album:one'), {status: 403});
});

test('album opening delegates the hydrated authoritative album to the native foreground modal', async () => {
  const h = setup(), value = album(); h.context.fetchTrackModalAlbumDetails = async () => value;
  await h.bridge.albumIntent('open', 'album:one');
  assert.strictEqual(h.calls.opens[0][0], value);
  assert.deepEqual(plain(h.calls.opens[0][1]), {coverLightboxGallery: false, foreground: true});
  assert.equal(h.calls.plays.length, 0);
  for (const fail of [h => {h.context.fetchTrackModalAlbumDetails = async () => album('wrong');},
    h => {h.context.albumRequiresHydration = () => true;}, h => {h.context.getTrackModalElements = () => ({});}]) {
    const invalid = setup(); fail(invalid);
    await assert.rejects(invalid.bridge.albumIntent('open', 'album:one'));
    assert.equal(invalid.calls.opens.length, 0);
  }
});

test('pending album actions yield to native modal/player choices, navigation, visibility and grant revocation', async () => {
  for (const [intent, invalidate, expected] of [
    ['open', h => {h.state.ui.pendingTrackModalLoadToken++;}, 'AbortError'],
    ['play', h => {h.context.playerTrackSelectionToken++;}, 'AbortError'],
    ['open', h => {h.window.location.href = 'https://albumhaven.test/?surface=home&home_section=friends';}, 'AbortError'],
    ['play', h => {h.shell.hidden = true;}, 'AbortError'],
    ['open', h => {h.shell.dataset.nativeLibraryId = 'other';}, 'AbortError'],
    ['play', h => {h.state.view = recent([local('album:one', {allowed_actions: {}})]);}, null],
  ]) {
    const h = setup(), result = deferred(); h.bridge.snapshot(); h.context.fetchTrackModalAlbumDetails = () => result.promise;
    const pending = h.bridge.albumIntent(intent, 'album:one');
    const rejected = assert.rejects(pending, expected ? {name: expected} : {status: 403});
    invalidate(h); h.bridge.sync(); result.resolve(album()); await rejected;
    assert.equal(h.calls.opens.length, 0); assert.equal(h.calls.plays.length, 0);
  }
});

test('the latest album intent owns the native action even if an earlier detail read resolves last', async () => {
  const h = setup(recent([local(), local('album:two')])), first = deferred(), second = deferred();
  h.context.fetchTrackModalAlbumDetails = ref => ref === 'album:one' ? first.promise : second.promise;
  const a = h.bridge.albumIntent('open', 'album:one'), rejected = assert.rejects(a, {name: 'AbortError'});
  const b = h.bridge.albumIntent('open', 'album:two'); second.resolve(album('album:two')); await b;
  first.resolve(album()); await rejected;
  assert.equal(h.calls.opens.length, 1); assert.equal(h.calls.opens[0][0].key, 'album:two');
});

test('native playback alone owns queue selection and requires an explicit successful start', async () => {
  const h = setup(), value = album(); h.context.fetchTrackModalAlbumDetails = async () => value;
  await h.bridge.albumIntent('play', 'album:one');
  assert.strictEqual(h.calls.builds[0], value); assert.strictEqual(h.calls.queues[0][0], value);
  assert.equal(h.calls.queues[0][1], value.tracks[0].path); assert.strictEqual(h.calls.plays[0], value.tracks[0]);
  for (const started of [false, undefined, 'true']) {
    const failed = setup(), previous = failed.state.player.playbackQueue;
    failed.context.playTrackFromPayload = async () => started;
    await assert.rejects(failed.bridge.albumIntent('play', 'album:one'), /did not start/);
    assert.strictEqual(failed.state.player.playbackQueue, previous);
  }
  const denied = setup(); denied.window.AlbumHavenCapabilities.allows = () => false;
  await assert.rejects(denied.bridge.albumIntent('play', 'album:one'), {status: 403});
  assert.equal(denied.calls.builds.length, 0); assert.equal(denied.calls.queues.length, 0);
});

test('failed native playback never rolls back a queue selected by a newer player action', async () => {
  const h = setup(), result = deferred(), entered = deferred(), replacement = {owner: 'newer-native-action'};
  h.context.playTrackFromPayload = () => {entered.resolve(); return result.promise;};
  const pending = h.bridge.albumIntent('play', 'album:one'), rejected = assert.rejects(pending, /Player failed/);
  await entered.promise; h.state.player.playbackQueue = replacement; result.reject(new Error('Player failed')); await rejected;
  assert.strictEqual(h.state.player.playbackQueue, replacement);
});

test('album detail projection forwards cancellation and includes only read-only display facts', async () => {
  const h = setup(recent([local('album:one', {allowed_actions: {can_open_album: true}})])), controller = new AbortController();
  const value = {...album(), album_artist: 'Artist', year: 2025, metadata_state: 'last_known', track_count: 0,
    duration_seconds: 0, cover_path: '/test-only/private-cover', account_ref: 'private-account', native_actions: {play: true},
    tracks: [{title: 'Song', secondary_artist: 'Guest', track_number: 0, disc_number: -1, duration_seconds: 1.5,
      path: '/test-only/private-track', track_ref: 'private-ref', playback_state: {can_start_here: true}}]};
  let request; h.context.fetchTrackModalAlbumDetails = async (...args) => {request = args; return value;};
  const result = await h.bridge.readAlbumProjection({scopeKey: h.bridge.snapshot().scopeKey, kind: 'album', ref: 'album:one', signal: controller.signal});
  assert.equal(request[0], 'album:one'); assert.strictEqual(request[1].signal, controller.signal);
  assert.equal(result.track_count, 0); assert.equal(result.duration_seconds, 0); assert.equal(result.artwork_url, null);
  assert.deepEqual(plain(result.tracks), [{id: 'row:0', title: 'Song', artist: 'Guest', track_number: 0, disc_number: null, duration_seconds: 1.5}]);
  assert.doesNotMatch(JSON.stringify(result), /test-only|private-|path|track_ref|playback_state|native_actions|account_ref/);
  assert.equal(h.calls.opens.length, 0); assert.equal(h.calls.plays.length, 0);
  assert.deepEqual(plain(await h.bridge.readAlbumProjection({kind: 'artist', ref: 'artist:one'})), {status: 'unavailable'});
});

test('only the native Home owner can map a current exact album-open grant into detail selection', () => {
  const h = setup(recent([local('album:one', {allowed_actions: {can_open_album: true, can_play_album: false}})]));
  const scope = h.bridge.snapshot().scopeKey, selected = h.bridge.albumDetailSelection('album:one', scope);
  assert.deepEqual(plain(selected), {kind: 'album', ref: 'album:one', allowed_actions: {can_view_details: true}});
  assert.equal(Object.isFrozen(selected), true); assert.equal(Object.isFrozen(selected.allowed_actions), true);
  assert.equal(h.bridge.albumDetailSelection('album:other', scope), null);
  assert.equal(h.bridge.albumDetailSelection('album:one', 'stale-scope'), null);
  assert.equal(h.bridge.albumDetailSelection('album:one'), null);
  h.shell.dataset.nativeLibraryId = 'other'; assert.equal(h.bridge.albumDetailSelection('album:one', scope), null);
  const hidden = setup(), hiddenScope = hidden.bridge.snapshot().scopeKey; hidden.shell.hidden = true;
  assert.equal(hidden.bridge.albumDetailSelection('album:one', hiddenScope), null);
  for (const input of [recent([]), recent([local(), local()]),
    recent([local('album:one', {local_match_state: 'unresolved'})]),
    recent([local('album:one', {allowed_actions: {can_open_album: 'true', can_view_details: true}})]),
    recent([local('album:one', {allowed_actions: Object.create({can_open_album: true})})])]) {
    const denied = setup(input);
    assert.equal(denied.bridge.albumDetailSelection('album:one', denied.bridge.snapshot().scopeKey), null);
    assert.equal(denied.calls.details.length, 0);
  }
});

test('read-only album projection rechecks scope and grant after the native reader returns', async () => {
  for (const invalidate of [h => {h.shell.dataset.nativeLibraryId = 'other';}, h => {h.shell.hidden = true;},
    h => {h.state.view = recent([]);}, h => h.controller.abort()]) {
    const h = setup(), result = deferred(); h.controller = new AbortController();
    h.context.fetchTrackModalAlbumDetails = () => result.promise;
    const pending = h.bridge.readAlbumProjection({scopeKey: h.bridge.snapshot().scopeKey, kind: 'album', ref: 'album:one', signal: h.controller.signal});
    const rejected = assert.rejects(pending); invalidate(h); result.resolve(album()); await rejected;
    assert.equal(h.calls.opens.length, 0); assert.equal(h.calls.plays.length, 0);
  }
});

test('read-only album projection rejects mismatched identities and malformed native tracks', async () => {
  for (const value of [album('album:wrong'), {...album(), tracks: null}, {...album(), tracks: [null]}]) {
    const h = setup(); h.context.fetchTrackModalAlbumDetails = async () => value;
    await assert.rejects(h.bridge.readAlbumProjection({scopeKey: h.bridge.snapshot().scopeKey, kind: 'album', ref: 'album:one'}), /invalid response/);
    assert.equal(h.calls.opens.length, 0); assert.equal(h.calls.plays.length, 0);
  }
  const h = setup(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.bridge.readAlbumProjection({scopeKey: h.bridge.snapshot().scopeKey, kind: 'album', ref: 'album:one', signal: controller.signal}), {name: 'AbortError'});
  assert.equal(h.calls.details.length, 0);
});

test('Home confirmation uses the shared native asynchronous confirmation owner', async () => {
  const h = setup(), result = deferred();
  h.context.showAppConfirmDialog = options => {h.calls.confirms.push(options); return result.promise;};
  const pending = h.bridge.confirm('Discard this draft?');
  assert.deepEqual(plain(h.calls.confirms[0]), {message: 'Discard this draft?'});
  result.resolve(true); assert.equal(await pending, true);
});

test('native account round trips cannot revive an earlier Home scope lease', () => {
  const h = setup(), first = h.bridge.snapshot();
  h.shell.dataset.nativeAccountId = 'account:two'; h.bridge.sync();
  h.shell.dataset.nativeAccountId = 'account:one'; h.bridge.sync();
  assert.notEqual(h.bridge.snapshot().scopeKey, first.scopeKey);
  assert.equal(h.bridge.albumDetailSelection('album:one', first.scopeKey), null);
});

const canonicalAlbum = (patch = {}) => ({kind: 'album', ref: 'catalog:album', allowed_actions: {can_view_details: true},
  native_actions: {album_ref: 'album:one', allowed_actions: {can_open_album: true, can_view_artwork: true}}, ...patch});

test('activity resource targets retain exact current origin and strip private target metadata', async () => {
  const h = setup(), scopeKey = h.bridge.snapshot().scopeKey;
  const target = canonicalAlbum({private_path: '/test-only/private', token: 'secret'});
  const origin = {source: 'activity', account_ref: 'account:friend', kind: 'albums', period: 'month', snapshot_ref: 'snapshot:one'};
  let data = {snapshot_ref: 'snapshot:one', rows: [{id: 'row:one', kind: 'album', title: 'Album', album_target: target}], next_cursor: 'cursor:one'};
  const read = h.bridge.configureActivityProvider({readActivity: async () => data});
  const options = {scopeKey, account_ref: origin.account_ref, kind: origin.kind, period: origin.period};
  const projection = await read(options), selection = projection.rows[0].album_target;
  assert.deepEqual(plain(selection.origin), origin);
  assert.doesNotMatch(JSON.stringify(projection), /private_path|test-only|secret/);
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), true);
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin: {...origin, period: 'year'}}), false);
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin: {...origin, account_ref: null}}), false);
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin: {...origin, snapshot_ref: 'other'}}), false);
  assert.equal(h.calls.details.length, 0, 'selecting a target does not hydrate or play it');
  target.native_actions.album_ref = 'forged';
  await h.bridge.resourceIntent('open', selection, {scopeKey, origin});
  assert.equal(h.calls.details[0][0], 'album:one');
  data = {snapshot_ref: 'snapshot:one', rows: [{id: 'row:one', kind: 'album', source_readable: false, album_target: target}], next_cursor: 'cursor:one'};
  const revoked = await read({...options, cursor: 'cursor:one'});
  assert.deepEqual(plain(revoked.rows[0]), {id: 'row:one', kind: 'album', source_readable: false});
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), false, 'malformed no-progress append still revokes held resource authority');
});

test('activity native hydration rechecks current source and cannot open an external detail object', async () => {
  const h = setup(), pending = deferred(), scopeKey = h.bridge.snapshot().scopeKey;
  const origin = {source: 'activity', account_ref: null, kind: 'albums', period: 'week'};
  let data = {rows: [{id: 'row:one', kind: 'album', album_target: canonicalAlbum()}]};
  const read = h.bridge.configureActivityProvider({readActivity: async () => data});
  const options = {scopeKey, account_ref: null, kind: 'albums', period: 'week'};
  const selection = (await read(options)).rows[0].album_target;
  h.context.fetchTrackModalAlbumDetails = () => pending.promise;
  const action = h.bridge.resourceIntent('open', selection, {scopeKey, origin});
  const rejection = assert.rejects(action, {status: 403});
  data = {status: 'denied'}; await read(options); pending.resolve(album()); await rejection;
  assert.equal(h.calls.opens.length, 0);
  assert.equal(h.bridge.canResourceIntent('open', canonicalAlbum(), {scopeKey, origin}), false);
});

test('append keeps the held snapshot while pending and cannot relabel its targets as a new snapshot', async () => {
  const h = setup(), next = deferred(), scopeKey = h.bridge.snapshot().scopeKey;
  let reads = 0;
  const read = h.bridge.configureActivityProvider({readActivity: () => ++reads === 1 ? {
    rows: [{id: 'row:one', kind: 'album', album_target: canonicalAlbum()}], snapshot_ref: 'snapshot:one', next_cursor: 'cursor:one',
  } : next.promise});
  const options = {scopeKey, account_ref: null, kind: 'albums', period: 'month'};
  const selection = (await read(options)).rows[0].album_target, origin = selection.origin;
  const append = read({...options, cursor: 'cursor:one'});
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), true);
  next.resolve({rows: [{id: 'row:two', kind: 'album'}], snapshot_ref: 'snapshot:two', next_cursor: null}); await append;
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), false);
  const forgedOrigin = {...origin, snapshot_ref: 'snapshot:two'};
  assert.equal(h.bridge.canResourceIntent('open', {...selection, origin: forgedOrigin}, {scopeKey, origin: forgedOrigin}), false);
});

test('native own-week projection fallback never hydrates a Friend, Playlist or another period', async () => {
  const h = setup(), scopeKey = h.bridge.snapshot().scopeKey;
  for (const origin of [{source: 'activity', account_ref: 'friend', kind: 'albums', period: 'week'},
    {source: 'recent', account_ref: null, kind: 'albums', period: 'month'},
    {source: 'playlist', account_ref: null, playlist_ref: 'playlist:one'}]) {
    assert.deepEqual(plain(await h.bridge.readAlbumProjection({scopeKey, kind: 'album', ref: 'album:one', origin})), {status: 'unavailable'});
  }
  assert.equal(h.calls.details.length, 0);
  const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  const result = await h.bridge.readAlbumProjection({scopeKey, kind: 'album', ref: 'album:one', origin});
  assert.deepEqual(plain(result.origin), origin); assert.equal(h.calls.details.length, 1);
});

test('native Album browse authority includes existing artwork/page presentation while explicit denials remain', () => {
  const origin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
  const h = setup(), scopeKey = h.bridge.snapshot().scopeKey;
  h.context.usesMobilePageLayout = () => true; h.context.presentMobileAlbumPage = () => true;
  const selection = {...h.bridge.albumDetailSelection('album:one', scopeKey), origin};
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), true);
  assert.equal(h.bridge.canResourceIntent('artwork', selection, {scopeKey, origin}), true);
  assert.equal(h.bridge.canResourceIntent('page', selection, {scopeKey, origin}), true);
  h.state.view = recent([local('album:one', {allowed_actions: {can_open_album: true, can_view_artwork: false, can_open_album_page: false}})]);
  h.bridge.sync();
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), false, 'mobile Open uses the explicitly denied page owner');
  assert.equal(h.bridge.canResourceIntent('artwork', selection, {scopeKey, origin}), false);
  assert.equal(h.bridge.canResourceIntent('page', selection, {scopeKey, origin}), false);
  h.context.usesMobilePageLayout = () => false;
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin}), true, 'desktop Album browsing remains authorized');
  assert.equal(h.bridge.canResourceIntent('artwork', selection, {scopeKey, origin}), false);
  assert.equal(h.bridge.canResourceIntent('page', selection, {scopeKey, origin}), false);
});

const recentOrigin = {source: 'recent', account_ref: null, kind: 'albums', period: 'week'};
const replaySelection = patch => ({kind: 'album', ref: 'album:one', origin: recentOrigin,
  allowed_actions: {can_view_details: true}, ...patch});

test('private Recent page revalidation freshly reads hidden Home authority and preserves both current and original restrictions', async () => {
  const h = setup(recent(), {captureResourceRevalidator: true}), abort = new AbortController();
  h.shell.hidden = true;
  const scopeKey = h.bridge.snapshot().scopeKey;
  h.context.fetch = async (...args) => {h.calls.reads.push(args); return response(recent([local('album:one', {
    allowed_actions: {can_open_album: true, can_play_album: true, can_view_artwork: false},
  })]));};
  const selection = replaySelection({native_actions: {album_ref: 'album:one', allowed_actions: {
    can_open_album: true, can_play_album: false, can_open_album_page: false,
  }}});
  const result = await h.revalidateResource(selection, {scopeKey, origin: recentOrigin}, {signal: abort.signal});
  assert.equal(h.calls.reads.length, 1); assert.equal(h.calls.reads[0][0], '/home-data');
  assert.equal(h.calls.reads[0][1].credentials, 'same-origin'); assert.equal(h.calls.reads[0][1].cache, 'no-store');
  assert.equal(h.calls.reads[0][1].signal, abort.signal);
  assert.deepEqual(plain(result.target.native_actions.allowed_actions), {
    can_open_album: true, can_play_album: false, can_view_artwork: false, can_open_album_page: false,
  });
  assert.equal(result.target.ref, 'album:one'); assert.deepEqual(plain(result.target.origin), recentOrigin);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.target));
  assert.equal(result.isCurrent(), true);
  assert.equal(h.bridge.revalidateResource, undefined, 'hidden revalidation is not a general public action');
  assert.equal(h.bridge.canResourceIntent('open', selection, {scopeKey, origin: recentOrigin}), false);
  h.shell.hidden = false; h.bridge.sync(); assert.equal(result.isCurrent(), true, 'visibility alone does not revoke fresh source authority');
  h.shell.hidden = true; h.bridge.sync(); assert.equal(result.isCurrent(), true);
  const next = deferred(); h.context.fetch = () => next.promise;
  const reading = h.bridge.readRecent(); assert.equal(result.isCurrent(), false, 'a new native read starts a new source epoch');
  next.resolve(response(recent())); await reading;
});

test('Recent revalidation cannot borrow source authority for other origins, scopes or native identities', async () => {
  const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
  for (const origin of [{...recentOrigin, period: 'month'}, {...recentOrigin, snapshot_ref: 'unproven'},
    {source: 'activity', account_ref: null, kind: 'albums', period: 'week'},
    {source: 'playlist', account_ref: null, playlist_ref: 'playlist:one'}]) {
    assert.equal(await h.revalidateResource(replaySelection({origin}), {scopeKey, origin}), null);
  }
  await assert.rejects(h.revalidateResource(replaySelection(), {scopeKey: 'foreign', origin: recentOrigin}), {status: 403});
  await assert.rejects(h.revalidateResource(replaySelection({native_actions: {album_ref: 'different', allowed_actions: {can_open_album: true}}}),
    {scopeKey, origin: recentOrigin}), {status: 403});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.revalidateResource(replaySelection(), {scopeKey, origin: recentOrigin}, {signal: abort.signal}), {name: 'AbortError'});
  assert.equal(h.calls.reads.length, 0);
});

test('fresh Recent response must identify exactly one current readable local match before replay hydration', async () => {
  for (const rows of [[], [local(), local()], [local('other')], [local('album:one', {row_kind: 'external_album'})],
    [local('album:one', {local_match_state: 'unresolved'})], [local('album:one', {source_readable: false})],
    [local('album:one', {allowed_actions: {can_open_album: 'true'}})],
    [local('album:one', {allowed_actions: Object.create({can_open_album: true})})]]) {
    const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
    h.context.fetch = async () => response(recent(rows));
    await assert.rejects(h.revalidateResource(replaySelection(), {scopeKey, origin: recentOrigin}), {status: 403});
    assert.equal(h.calls.details.length, 0);
  }
});

test('Recent revalidation rejects navigation, scope, cancellation and newer reads while its response is pending', async () => {
  for (const invalidate of [h => h.abort.abort(), h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.shell.dataset.nativeLibraryId = 'other';}, h => {h.window.location.searchParams.set('home_profile', 'other');},
    h => {h.window.history.state = {albumHavenNavigationPosition: 9};},
    async h => {h.context.fetch = async () => response(recent([local('newer')])); await h.bridge.readRecent();}]) {
    const h = setup(recent(), {captureResourceRevalidator: true}), json = deferred(), entered = deferred();
    h.abort = new AbortController(); const scopeKey = h.bridge.snapshot().scopeKey;
    h.context.fetch = async () => ({ok: true, json() {entered.resolve(); return json.promise;}});
    const pending = h.revalidateResource(replaySelection(), {scopeKey, origin: recentOrigin}, {signal: h.abort.signal});
    const rejected = assert.rejects(pending, {name: 'AbortError'}); await entered.promise;
    await invalidate(h); json.resolve(recent()); await rejected;
    assert.equal(h.calls.details.length, 0);
  }
});

test('a returned replay grant remains tied to its scope, signal and exact fresh projection', async () => {
  for (const invalidate of [h => h.abort.abort(), h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.state.view = recent([]); h.bridge.sync();}]) {
    const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
    h.abort = new AbortController(); h.context.fetch = async () => response(recent());
    const result = await h.revalidateResource(replaySelection(), {scopeKey, origin: recentOrigin}, {signal: h.abort.signal});
    assert.equal(result.isCurrent(), true); invalidate(h); assert.equal(result.isCurrent(), false);
  }
});

test('replay validation cannot mistake a reentrant native projection replacement for its fresh response', async () => {
  const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
  let replaced = false;
  h.bridge.subscribe(() => {
    if (!replaced && h.bridge.snapshot().payload?.recent_local_albums[0]?.name === 'Fresh response') {
      replaced = true;
      h.state.view = recent([local('album:one', {name: 'Other cached view'})]); h.bridge.sync();
    }
  });
  h.context.fetch = async () => response(recent([local('album:one', {name: 'Fresh response'})]));
  await assert.rejects(h.revalidateResource(replaySelection(), {scopeKey, origin: recentOrigin}), {name: 'AbortError'});
  assert.equal(replaced, true); assert.equal(h.calls.details.length, 0);
});

test('initial Recent native transfer survives UI retirement but retains its source epoch and scope fences', async () => {
  const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey, abort = new AbortController();
  const selection = replaySelection(), context = {scopeKey, origin: recentOrigin, signal: abort.signal};
  const receipt = h.retainResource(selection, context);
  assert.ok(receipt); assert.equal(receipt.isCurrent(), true); assert.equal(h.bridge.retainResource, undefined);
  abort.abort(); h.shell.hidden = true; h.bridge.sync();
  assert.equal(receipt.isCurrent(), true, 'UI cleanup transfers ownership without withdrawing source authority');
  assert.equal(h.bridge.canResourceIntent('open', selection, context), false, 'ordinary hidden actions remain unavailable');
  h.context.fetch = async () => response(recent());
  const reading = h.bridge.readRecent(); assert.equal(receipt.isCurrent(), false); await reading;
  h.shell.hidden = false; h.bridge.sync();
  const next = h.retainResource(selection, {scopeKey, origin: recentOrigin});
  h.shell.dataset.nativeAccountId = 'other'; assert.equal(next.isCurrent(), false);
});

test('initial Activity and Artist-parent transfers remain bound to exact source epoch and provider', async () => {
  for (const kind of ['album', 'artist']) {
    const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
    const origin = {source: 'activity', account_ref: null, kind: `${kind}s`, period: 'month'};
    const canonical = {kind, ref: `catalog:${kind}`, allowed_actions: {can_view_details: true},
      native_actions: kind === 'album' ? {album_ref: 'local:album', allowed_actions: {can_open_album: true}}
        : {artist_ref: 'local:artist', allowed_actions: {can_open_artist_gallery: true}, gallery_target: {artist: 'Explicit native artist'}}};
    let rows = [{id: 'row:one', kind, [`${kind}_target`]: canonical}];
    const providers = {readActivity: async () => ({rows})}, reader = h.bridge.configureActivityProvider(providers);
    const options = {scopeKey, account_ref: null, kind: origin.kind, period: origin.period};
    const selection = (await reader(options)).rows[0][`${kind}_target`];
    const receipt = h.retainResource(selection, {scopeKey, origin, signal: new AbortController().signal});
    assert.ok(receipt); h.shell.hidden = true; h.bridge.sync(); assert.equal(receipt.isCurrent(), true);
    assert.equal(h.retainResource(selection, {scopeKey, origin}), null, 'new hidden transfers cannot borrow a held receipt');
    h.shell.hidden = false; h.bridge.sync(); rows = [{id: 'row:one', kind, source_readable: false}];
    const reading = reader(options); assert.equal(receipt.isCurrent(), false); await reading;
    assert.equal(h.retainResource(selection, {scopeKey, origin}), null);
    rows = [{id: 'row:one', kind, [`${kind}_target`]: canonical}];
    await reader(options); const current = h.retainResource(selection, {scopeKey, origin});
    h.bridge.configureActivityProvider(providers); assert.equal(current.isCurrent(), false);
  }
});

test('person-route retirement and a denied pending Activity read invalidate transferred native authority', async () => {
  const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
  const origin = {source: 'activity', account_ref: null, kind: 'albums', period: 'week'};
  const page = {rows: [{id: 'row:one', kind: 'album', album_target: canonicalAlbum()}], next_cursor: 'cursor:one'};
  const pending = deferred(); let reads = 0;
  const reader = h.bridge.configureActivityProvider({readActivity: () => ++reads === 1 ? page : pending.promise});
  const options = {scopeKey, account_ref: null, kind: 'albums', period: 'week'};
  const selection = (await reader(options)).rows[0].album_target;
  const reading = reader({...options, cursor: 'cursor:one'});
  const receipt = h.retainResource(selection, {scopeKey, origin}); assert.ok(receipt);
  pending.reject(Object.assign(new Error('Source denied'), {status: 403})); await assert.rejects(reading, {status: 403});
  assert.equal(receipt.isCurrent(), false);
  const again = h.bridge.configureActivityProvider({readActivity: async () => page}); await again(options);
  const current = h.retainResource(selection, {scopeKey, origin});
  h.window.location.searchParams.set('home_section', 'friends'); h.window.location.searchParams.set('home_friend', 'another');
  h.bridge.sync(); assert.equal(current.isCurrent(), false);
});

test('completed Friends results retire only the exact transferred friend source and cannot restore expired authority', async () => {
  const {createHomeFriendsController} = await import('../../../music_app/static/js/home-friends/model.mjs');
  const accepted = {friends: [{account_ref: 'friend:one', relationship: 'accepted', allowed_actions: {can_view_activity: true}}], requests: [], profile: null};
  const revoked = [{...accepted, friends: []}, {...accepted, friends: [{...accepted.friends[0], allowed_actions: {can_view_activity: false}}]},
    {status: 'denied'}, {status: 'unavailable'}, {status: 'error'}];
  for (const value of revoked) {
    const h = setup(recent(), {captureResourceRevalidator: true}), scopeKey = h.bridge.snapshot().scopeKey;
    let next = accepted;
    const reader = h.bridge.configureActivityProvider({readActivity: async () => ({rows: [{id: 'row:one', kind: 'album', album_target: canonicalAlbum()}]})});
    const controller = createHomeFriendsController({providers: {readFriends: async () => {
      if (next.status === 'error') throw new Error('Friends unavailable'); return next;
    }, readActivity: reader}, onFriendsAuthority: h.bridge.retireFriendActivity});
    controller.setScope(scopeKey); await controller.loadFriends(); controller.selectFriend('friend:one'); await controller.loadActivity();
    const selection = controller.getSnapshot().activity.data.rows[0].album_target;
    const receipt = h.retainResource(selection, {scopeKey, origin: selection.origin}); assert.ok(receipt);
    h.shell.hidden = true; h.bridge.sync();
    const unchanged = controller.loadFriends(); assert.equal(receipt.isCurrent(), true); await unchanged;
    assert.equal(receipt.isCurrent(), true, 'a fresh unchanged accepted projection preserves the transferred page');
    assert.equal(h.bridge.retireFriendActivity({scopeKey: 'foreign', friends: {status: 'denied'}}), false);
    assert.equal(receipt.isCurrent(), true);
    next = value; const refresh = controller.loadFriends(); assert.equal(receipt.isCurrent(), true); await refresh;
    assert.equal(receipt.isCurrent(), false);
    next = accepted; await controller.loadFriends(); assert.equal(receipt.isCurrent(), false, 'a positive Friends projection grants no native source authority');
    controller.dispose();
  }
  const own = setup(recent(), {captureResourceRevalidator: true}), scopeKey = own.bridge.snapshot().scopeKey;
  const receipt = own.retainResource(replaySelection(), {scopeKey, origin: recentOrigin});
  own.bridge.retireFriendActivity({scopeKey, friends: {status: 'denied'}}); assert.equal(receipt.isCurrent(), true);
});
