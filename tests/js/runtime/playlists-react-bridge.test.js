const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const runtimePath = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const source = fs.readFileSync(path.join(runtimePath, 'playlists-react-bridge.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const response = (data, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => data});
const track = (id = 'item:one', patch = {}) => ({playlist_item_id: id, playlist_position: 1,
  path: '/test-only/private/song #1.flac', track_ref: '/test-only/private/song #1.flac', title: 'Song', artist: 'Artist',
  album_title: 'Album', duration_seconds: 0, duration_display: '0:00', playback_state: {can_start_here: true}, ...patch});
const payload = (id = 'playlist:one', patch = {}) => ({surface: {active: 'playlists'},
  playlist_sidebar: {active_playlist_id: id || '', items: ['playlist:one', 'playlist:two'].map(playlist_id => ({playlist_id, title: playlist_id, allowed_actions: {can_open: true}}))},
  ...(id ? {playlist_detail: {playlist_id: id, title: 'Playlist', description: '', allowed_actions: {can_play: true}, track_rows: [track()], ...patch}}
    : {playlist_index: {query: '', playlists: [{playlist_id: 'playlist:one', title: 'Playlist', allowed_actions: {can_open: true}}]}})});

function setup(data = payload(), {captureResourceRevalidator = false} = {}) {
  const native = createNativeHomeRuntime(), {context, document} = native, events = new Map(), observers = [], calls = {activations: [], reads: [], navigation: [], artists: []};
  const add = id => {const node = document.createElement('div'); node.id = id; document.body.appendChild(node); return node;};
  const shell = add('app-shell'), host = add('playlists-root'), home = add('mobile-home'), main = add('shell-main-surface');
  shell.dataset.nativeAccountId = 'account:one'; shell.dataset.nativeLibraryId = 'library:one';
  home.dataset.homeAccountId = 'fallback-account'; home.dataset.homeLibraryId = 'fallback-library';
  const state = {view: data, ui: {activeViewRequestId: 0}, player: {playbackQueue: {owner: 'native'}}};
  Object.assign(context, {state, URL, URLSearchParams, location: new URL('https://albumhaven.test/?surface=playlists&playlist_id=playlist%3Aone'),
    history: {state: {albumHavenNavigationPosition: 3}, pushState() {throw new Error('Adapter must use native navigation');}, replaceState() {throw new Error('Adapter must use native navigation');}},
    addEventListener: (name, listener) => events.set(name, listener), dispatchEvent() {},
    MutationObserver: class {constructor(callback) {this.callback = callback; observers.push(this);} observe(target, options) {this.target = target; this.options = options;}},
    AlbumHavenHomeRuntime: {}, AlbumHavenCapabilities: {allows: capability => capability === 'library.media.read'},
    activateSharedTrackButton: (button, options) => calls.activations.push([button, options]),
    fetchTrackModalAlbumDetails: async ref => ({key: ref, tracks: []}), releaseTrackModalSelection() {},
    handleSidebarArtistSelectionClick: event => calls.artists.push(event.target.getAttribute('data-sidebar-artist')),
    fetch: async (...args) => {calls.reads.push(args); throw new Error('Unexpected Playlist network request');},
  });
  vm.runInContext(fs.readFileSync(path.join(runtimePath, 'album-track-table.js'), 'utf8'), context, {filename: 'album-track-table.js'});
  vm.runInContext(fs.readFileSync(path.join(runtimePath, 'track-actions.js'), 'utf8'), context, {filename: 'track-actions.js'});
  vm.runInContext(fs.readFileSync(path.join(runtimePath, 'resource-selection.js'), 'utf8'), context, {filename: 'resource-selection.js'});
  let revalidateResource, retainResource;
  if (captureResourceRevalidator) {
    const nativeSelection = context.AlbumHavenResourceSelection;
    context.AlbumHavenResourceSelection = Object.freeze({...nativeSelection, create(options) {
      revalidateResource = options.revalidateResource;
      retainResource = options.retainResource;
      return nativeSelection.create(options);
    }});
  }
  vm.runInContext(source, context, {filename: 'playlists-react-bridge.js'});
  return {...native, bridge: context.AlbumHavenPlaylistRuntime, revalidateResource, retainResource, state, shell, host, home, main, events, observers, calls};
}

test('Playlist snapshot is immutable presentation data without private native media authority', () => {
  const input = payload(), h = setup(input), first = h.bridge.snapshot();
  assert.strictEqual(h.bridge.snapshot(), first); assert.equal(first.visible, true); assert.equal(h.host.hidden, false);
  assert.equal(h.main.classList.contains('has-react-playlists'), true);
  assert.equal(first.playlistId, 'playlist:one');
  assert.doesNotMatch(JSON.stringify(first.payload), /test-only|track_ref|playback_state|"path"/);
  assert.equal(Object.isFrozen(first.payload.playlist_detail.track_rows[0]), true);
  assert.equal(Object.isFrozen(first.payload.playlist_detail.allowed_actions), true);
  assert.notStrictEqual(first.payload.playlist_detail, input.playlist_detail);
  input.playlist_detail.track_rows[0].title = 'Modified outside the adapter';
  input.playlist_detail.allowed_actions.can_play = false;
  assert.equal(first.payload.playlist_detail.track_rows[0].title, 'Song');
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), true);
});

test('Playlist canonical targets are explicit, origin-bound, and separate from private Artist navigation', async () => {
  const albumTarget = {kind: 'album', ref: 'catalog:album', allowed_actions: {can_view_details: true},
    native_actions: {album_ref: 'local:album', allowed_actions: {can_open_album: true}}, secret: 'omit'};
  const artistTarget = {kind: 'artist', ref: 'catalog:artist', allowed_actions: {can_view_details: true},
    native_actions: {artist_ref: 'local:artist', allowed_actions: {can_open_artist_gallery: true},
      gallery_target: {artist: 'Explicit Gallery Target'}, private_path: '/test-only/private'}};
  const h = setup(payload('playlist:one', {revision: 'revision:one', track_rows: [track('item:one', {
    album_ref: 'catalog:legacy', allowed_actions: {can_view_details: true}, album_target: albumTarget, artist_target: artistTarget})]}));
  const snapshot = h.bridge.snapshot(), row = snapshot.payload.playlist_detail.track_rows[0];
  const origin = {source: 'playlist', account_ref: null, playlist_ref: 'playlist:one', snapshot_ref: 'revision:one'};
  assert.deepEqual(plain(row.album_target.origin), origin); assert.equal(row.album_ref, 'catalog:legacy');
  assert.equal(row.allowed_actions.can_view_details, true);
  assert.doesNotMatch(JSON.stringify(snapshot.payload), /Explicit Gallery Target|private_path|test-only|secret/);
  const context = {scopeKey: snapshot.scopeKey, origin};
  assert.equal(h.bridge.canResourceIntent('artist_gallery', row.artist_target, context), true);
  assert.equal(h.bridge.canResourceIntent('open', row.album_target, {...context, origin: {...origin, snapshot_ref: 'old'}}), false);
  artistTarget.native_actions.gallery_target.artist = 'Forged by later mutation';
  await h.bridge.resourceIntent('artist_gallery', row.artist_target, context);
  assert.deepEqual(h.calls.artists, ['Explicit Gallery Target']);
  h.state.view = payload('playlist:one', {revision: 'revision:two', track_rows: [track('item:one', {source_readable: false, album_target: albumTarget})]});
  h.bridge.sync(); assert.equal(h.bridge.canResourceIntent('open', row.album_target, context), false);
});

test('repeated Playlist targets agree on native identity; conflicting mappings fail closed', () => {
  const target = album_ref => ({kind: 'album', ref: 'catalog:album', allowed_actions: {can_view_details: true},
    native_actions: {album_ref, allowed_actions: {can_open_album: true}}});
  for (const second of ['local:album', 'local:other']) {
    const h = setup(payload('playlist:one', {track_rows: [track('a', {album_target: target('local:album')}), track('b', {album_target: target(second)})]}));
    const snapshot = h.bridge.snapshot(), selection = snapshot.payload.playlist_detail.track_rows[0].album_target;
    const actual = h.bridge.canResourceIntent('open', selection, {scopeKey: snapshot.scopeKey, origin: selection.origin});
    assert.equal(actual, second === 'local:album');
  }
  const malformed = setup(payload('playlist:one', {revision: {private: '/test-only/revision'},
    track_rows: [track('a', {album_target: target('local:album')})]})).bridge.snapshot().payload;
  assert.equal(malformed.playlist_detail.revision, null);
  assert.equal(malformed.playlist_detail.track_rows[0].album_target, null);
  assert.doesNotMatch(JSON.stringify(malformed), /test-only|"private"/);
});

test('Playlist bridge preserves only explicit display metrics and leaves media authority private', async () => {
  const value = track('item:one', {love_tier: 'obsessed', track_rating: 4, play_count: 0, popularity_count: 20000,
    listen_count: 66, scrobble_count: 777, preference: {rating: 5}, source_readable: true});
  const inherited = Object.assign(Object.create({love_tier: 'loved', track_rating: 5, play_count: 8, popularity_count: 600}), track('item:two'));
  const data = payload('playlist:one', {track_rows: [value, inherited]}), h = setup(data);
  const check = projected => {
    const [known, unknown] = projected.playlist_detail.track_rows;
    assert.equal(known.love_tier, 'obsessed'); assert.equal(known.track_rating, 4);
    assert.equal(known.play_count, 0); assert.equal(known.popularity_count, 20000);
    assert.equal(known.source_readable, true);
    for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count']) assert.equal(Object.hasOwn(unknown, key), false, key);
    assert.doesNotMatch(JSON.stringify(projected), /test-only|track_ref|playback_state|"path"|listen_count|scrobble_count|preference/);
  };
  check(h.bridge.snapshot().payload);
  h.context.fetch = async () => response(data);
  check(await h.bridge.readPlaylists({playlist_id: 'playlist:one'}));
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), true);
  const malformed = setup(payload('playlist:one', {track_rows: [track('item:one', {
    love_tier: {path: '/test-only/private'}, track_rating: 6, play_count: '3',
    popularity_count: {private_total: 999}, source_readable: {private_grant: true},
  })]})).bridge.snapshot().payload.playlist_detail.track_rows[0];
  for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count']) assert.equal(malformed[key], null, key);
  assert.equal(Object.hasOwn(malformed, 'source_readable'), false);
  assert.doesNotMatch(JSON.stringify(malformed), /test-only|private_total|private_grant/);
});

test('unreadable Playlist rows redact both native display facts and private playback authority', async () => {
  const {normalizePlaylistPayload} = await import('../../../music_app/static/js/playlists/model.mjs');
  for (const denial of [{source_readable: false}, {allowed_actions: {can_read: false}}]) {
    const data = payload('playlist:one', {track_rows: [track('item:one', {...denial,
      title: 'Secret track title', love_tier: 'obsessed', track_rating: 5, play_count: 77, popularity_count: 88888,
      artwork_url: '/artwork/secret-cover', availability: 'local'})]});
    const h = setup(data), row = {playlist_item_id: 'item:one'};
    const check = projected => {
      assert.deepEqual(plain(projected.playlist_detail.track_rows[0]), {playlist_item_id: 'item:one', source_readable: false});
      assert.doesNotMatch(JSON.stringify(projected), /Secret track|test-only|obsessed|88888|secret-cover|"availability"/);
      const normalized = normalizePlaylistPayload(projected).detail.track_rows[0];
      assert.equal(normalized.title, 'Unavailable track'); assert.equal(normalized.source_readable, false);
      assert.equal(h.bridge.canTrackIntent('play', row, {playlist_id: 'playlist:one'}), false);
    };
    check(h.bridge.snapshot().payload);
    h.context.fetch = async () => response(data);
    check(await h.bridge.readPlaylists({playlist_id: 'playlist:one'}));
    await assert.rejects(h.bridge.trackIntent('play', row, {playlist_id: 'playlist:one'}), {status: 403});
    assert.equal(h.calls.activations.length, 0);
  }
});

test('native snapshot and reads retain own safe artwork and explicit availability without inference', async () => {
  const {safeServerArtworkUrl} = await import('../../../music_app/static/js/home-friends/model.mjs');
  const {normalizePlaylistPayload} = await import('../../../music_app/static/js/playlists/model.mjs');
  const urls = ['/artwork/cover-one?size=48', '/artwork/cover%20two', '//outside.example/cover',
    'https://outside.example/cover', 'data:image/png;base64,abc', 'file:///private/cover',
    '/artwork\\cover', '/artwork/white space', '/artwork/control\u0001', '/artwork/delete\u007f', {path: '/private/cover'}];
  const known = urls.map((artwork_url, index) => track(`item:artwork:${index}`, {artwork_url,
    availability: ['local', 'missing', 'unresolved'][index % 3]}));
  const inherited = Object.assign(Object.create({artwork_url: '/artwork/inherited', availability: 'missing'}), track('item:inherited'));
  const absent = track('item:absent', {playback_state: {can_start_here: false}});
  const invalid = track('item:invalid', {availability: {private_state: 'missing'}});
  const data = payload('playlist:one', {track_rows: [...known, inherited, absent, invalid]}), h = setup(data);
  const check = projected => {
    const rows = projected.playlist_detail.track_rows;
    for (const [index, artwork_url] of urls.entries()) {
      assert.equal(rows[index].artwork_url, safeServerArtworkUrl(artwork_url));
      assert.equal(rows[index].availability, known[index].availability);
    }
    for (const row of rows.slice(known.length, known.length + 2)) {
      assert.equal(Object.hasOwn(row, 'artwork_url'), false);
      assert.equal(Object.hasOwn(row, 'availability'), false);
    }
    assert.equal(rows.at(-1).availability, null);
    assert.doesNotMatch(JSON.stringify(projected), /test-only|track_ref|playback_state|"path"|private_state|artwork\/inherited/);
    const normalized = normalizePlaylistPayload(projected).detail.track_rows;
    assert.equal(normalized[0].artwork_url, urls[0]); assert.equal(normalized[1].availability, 'missing');
  };
  check(h.bridge.snapshot().payload);
  h.context.fetch = async () => response(data);
  check(await h.bridge.readPlaylists({playlist_id: 'playlist:one'}));
});

test('Playlist playback resolves the exact private item and delegates to the existing player owner', async () => {
  const h = setup(), queue = h.state.player.playbackQueue;
  const forged = {playlist_item_id: 'item:one', path: '/forged/file', src: 'https://forged.test', title: 'Forged', playback_state: {can_start_here: true}};
  await h.bridge.trackIntent('play', forged, {playlist_id: 'playlist:one'});
  const [button, options] = h.calls.activations[0];
  assert.equal(button.getAttribute('data-track-path'), '/test-only/private/song #1.flac');
  assert.equal(button.getAttribute('data-src'), '/track?path=%2Ftest-only%2Fprivate%2Fsong%20%231.flac');
  assert.equal(button.getAttribute('data-track-title'), 'Song'); assert.equal(button.getAttribute('data-track-duration-seconds'), '0');
  assert.deepEqual(plain(options), {focusTimeline: true});
  assert.equal(button.isConnected, false, 'private media attributes exist only on the transient native activation handle');
  assert.strictEqual(h.state.player.playbackQueue, queue, 'the adapter does not create or replace a playback queue');
});

test('missing, duplicate, inherited and nonboolean Playlist grants fail closed', async () => {
  for (const patch of [
    {allowed_actions: {}}, {allowed_actions: {can_play: 'true'}}, {allowed_actions: Object.create({can_play: true})},
    {track_rows: [track(), track()]}, {track_rows: [track('other')]},
    {track_rows: [track(), track('item:one', {source_readable: false})]},
    {track_rows: [track(), track('item:one', {allowed_actions: {can_read: false}})]},
    {track_rows: [track('item:one', {playback_state: {can_start_here: 1}})]},
    {track_rows: [track('item:one', {playback_state: Object.create({can_start_here: true})})]},
    {track_rows: [track('item:one', {path: ' '})]},
  ]) {
    const h = setup(payload('playlist:one', patch)), row = {playlist_item_id: 'item:one'};
    assert.equal(h.bridge.canTrackIntent('play', row, {playlist_id: 'playlist:one'}), false);
    await assert.rejects(h.bridge.trackIntent('play', row, {playlist_id: 'playlist:one'}), {status: 403});
    assert.equal(h.calls.activations.length, 0);
  }
  const h = setup();
  for (const [intent, row, options] of [['select', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}],
    ['play', {playlist_item_id: 1}, {playlist_id: 'playlist:one'}], ['play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:two'}]]) {
    assert.equal(h.bridge.canTrackIntent(intent, row, options), false);
  }
});

test('Playlist playback is revoked by native scope, capabilities, current surface and in-flight navigation', async () => {
  for (const invalidate of [h => {h.shell.dataset.nativeAccountId = 'other';}, h => {h.shell.dataset.nativeLibraryId = 'other';},
    h => {h.shell.hidden = true;}, h => {h.state.ui.pendingViewTransition = true;}, h => {h.context.location.pathname = '/account';},
    h => {h.state.view = {surface: {active: 'home'}};}, h => {h.context.AlbumHavenCapabilities = {allows: () => false};},
    h => {h.context.AlbumHavenCapabilities = {};}]) {
    const h = setup(); h.bridge.snapshot(); invalidate(h);
    assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), false);
    await assert.rejects(h.bridge.trackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), {status: 403});
    assert.equal(h.calls.activations.length, 0);
  }
});

test('simultaneous actor and native view replacement cannot seed private Playlist authority in the new scope', async () => {
  const h = setup(), before = h.bridge.snapshot();
  h.shell.dataset.nativeAccountId = 'account:two';
  h.state.view = payload('playlist:one', {track_rows: [track('item:stale', {path: '/test-only/previous-account.flac'})]});
  const changed = h.bridge.sync();
  assert.notEqual(changed.scopeKey, before.scopeKey); assert.equal(changed.payload, null);
  assert.equal(h.bridge.snapshot().payload, null);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:stale'}, {playlist_id: 'playlist:one'}), false);
  h.context.fetch = async () => response(payload('playlist:one', {track_rows: [track('item:new-scope')]}));
  const fresh = await h.bridge.readPlaylists({scopeKey: changed.scopeKey, playlist_id: 'playlist:one'});
  assert.equal(fresh.playlist_detail.track_rows[0].playlist_item_id, 'item:new-scope');
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:new-scope'}, {playlist_id: 'playlist:one'}), true);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:stale'}, {playlist_id: 'playlist:one'}), false);
});

test('native Playlist rows render read-only through the actual AlbumTrackTable owner', () => {
  const h = setup(), value = h.bridge.albumTrackRow({...track(), isCurrent: true, isPlaying: true, isProblematic: true,
    displayPath: '/test-only/private/display', secondary_artist: '<Guest>'}, 2);
  const markup = JSON.stringify(value);
  assert.equal(value.key, '3'); assert.deepEqual(plain(value.dataAttributes), {});
  assert.match(markup, /album-track-table__title/); assert.match(markup, /&lt;Guest&gt;/); assert.match(markup, /0:00/);
  assert.doesNotMatch(markup, /test-only|data-src|data-track-|play-track-button|track-problem-link|row--current|row--playing|row--animated/);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('Playlist reads use only the native read route and return a separate immutable projection', async () => {
  const h = setup(), start = h.bridge.snapshot(), controller = new AbortController(); let request, notifications = 0;
  h.bridge.subscribe(() => {notifications++;});
  const fresh = payload('playlist:one', {track_rows: [track('item:new', {path: '/test-only/new.flac'})]});
  h.context.fetch = async (...args) => {request = args; return response(fresh);};
  const result = await h.bridge.readPlaylists({scopeKey: start.scopeKey, playlist_id: 'playlist:one', signal: controller.signal});
  assert.equal(request[0], '/view-data?surface=playlists&playlist_id=playlist%3Aone');
  assert.equal(request[1].credentials, 'same-origin'); assert.equal(request[1].cache, 'no-store');
  assert.equal(request[1].headers.Accept, 'application/json'); assert.strictEqual(request[1].signal, controller.signal);
  assert.equal(Object.isFrozen(result.playlist_detail.track_rows[0]), true);
  assert.doesNotMatch(JSON.stringify(result), /test-only|track_ref|playback_state|"path"/);
  assert.strictEqual(h.bridge.snapshot(), start, 'a controller-owned refresh must not emit a replacement native snapshot');
  assert.equal(notifications, 0);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), false);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:new'}, {playlist_id: 'playlist:one'}), true);
  fresh.playlist_detail.track_rows[0].path = '/forged';
  await h.bridge.trackIntent('play', {playlist_item_id: 'item:new'}, {playlist_id: 'playlist:one'});
  assert.equal(h.calls.activations[0][0].getAttribute('data-track-path'), '/test-only/new.flac');
});

test('Playlist reads reject wrong scope and hidden surfaces before transport', async () => {
  for (const options of [{scopeKey: 'wrong'}, {playlist_id: ''}, {playlist_id: 1}]) {
    const h = setup(); await assert.rejects(h.bridge.readPlaylists(options)); assert.equal(h.calls.reads.length, 0);
  }
  const h = setup(); h.shell.hidden = true;
  await assert.rejects(h.bridge.readPlaylists(), {status: 403}); assert.equal(h.calls.reads.length, 0);
});

test('superseded Playlist reads cannot restore private playback or revoke a newer successful result', async () => {
  const h = setup(), a = deferred(), b = deferred(); let calls = 0;
  h.context.fetch = () => (++calls === 1 ? a.promise : b.promise);
  const first = h.bridge.readPlaylists(), rejected = assert.rejects(first, {name: 'AbortError'}), second = h.bridge.readPlaylists();
  b.resolve(response(payload('playlist:one', {track_rows: [track('item:new')]}))); await second;
  const scope = h.bridge.snapshot().scopeKey;
  a.resolve(response(null, 403)); await rejected;
  assert.equal(h.bridge.snapshot().scopeKey, scope);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:new'}, {playlist_id: 'playlist:one'}), true);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), false);
});

test('late Playlist JSON is rejected after abort, scope, visibility or native view replacement', async () => {
  for (const invalidate of [h => h.controller.abort(), h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.shell.hidden = true;}, h => {h.state.view = payload('playlist:two');}]) {
    const h = setup(), json = deferred(), entered = deferred(); h.controller = new AbortController();
    h.context.fetch = async () => ({ok: true, status: 200, json() {entered.resolve(); return json.promise;}});
    const pending = h.bridge.readPlaylists({signal: h.controller.signal}), rejected = assert.rejects(pending, {name: 'AbortError'});
    await entered.promise; invalidate(h); json.resolve(payload('playlist:one', {track_rows: [track('item:stale')]})); await rejected;
    assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:stale'}, {playlist_id: 'playlist:one'}), false);
  }
});

test('Playlist denial erases its presentation and private authority until a fresh allowed read', async () => {
  const h = setup(), before = h.bridge.snapshot(); h.context.fetch = async () => response(payload(), 401);
  await assert.rejects(h.bridge.readPlaylists(), {status: 401});
  assert.notEqual(h.bridge.snapshot().scopeKey, before.scopeKey); assert.equal(h.bridge.snapshot().payload, null);
  h.state.view = payload(); h.bridge.sync(); assert.equal(h.bridge.snapshot().payload, null);
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), false);
  h.context.fetch = async () => response(payload('playlist:one', {track_rows: [track('item:fresh')]}));
  await h.bridge.readPlaylists();
  assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:fresh'}, {playlist_id: 'playlist:one'}), true);
});

test('account round trips cannot revive an earlier Playlist resource scope', () => {
  const h = setup(), first = h.bridge.snapshot().scopeKey;
  h.shell.dataset.nativeAccountId = 'account:two'; h.bridge.sync();
  h.shell.dataset.nativeAccountId = 'account:one'; h.bridge.sync();
  assert.notEqual(h.bridge.snapshot().scopeKey, first); assert.equal(h.bridge.snapshot().payload, null);
});

test('malformed or failed Playlist refresh revokes private playback authority', async () => {
  for (const result of [response({playlist_sidebar: {items: []}}), response(null, 500)]) {
    const h = setup(); h.context.fetch = async () => result;
    await assert.rejects(h.bridge.readPlaylists());
    assert.equal(h.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'}, {playlist_id: 'playlist:one'}), false);
  }
});

function nativeNavigation(h) {
  h.context.fetchAndRender = (url, push, options) => {
    const result = deferred(), id = ++h.state.ui.activeViewRequestId;
    const request = {url, push, options, finish(data) {
      if (id !== h.state.ui.activeViewRequestId) {result.resolve(false); return;}
      if (!options.shouldApplyResponse(data)) {result.resolve(false); return;}
      h.state.view = data; result.resolve(true);
    }, resolve: result.resolve};
    h.calls.navigation.push(request); return result.promise;
  };
}

test('Playlist navigation asks the native owner to apply only the exact granted target', async () => {
  const h = setup(); nativeNavigation(h);
  const pending = h.bridge.navigate({playlist_id: 'playlist:two'}), request = h.calls.navigation[0];
  assert.equal(request.url, '/view-data?surface=playlists&playlist_id=playlist%3Atwo');
  assert.equal(request.push, true); assert.equal(request.options.source, 'library');
  request.finish(payload('playlist:two')); await pending;
  assert.equal(h.bridge.snapshot().playlistId, 'playlist:two');
  const back = h.bridge.navigate(), directory = h.calls.navigation[1]; directory.finish(payload(null)); await back;
  assert.equal(h.bridge.snapshot().playlistId, null);
});

test('invalid Playlist navigation cannot commit a different, duplicate or ungranted target', async () => {
  const wrong = payload('playlist:one'), inherited = payload('playlist:two'), duplicate = payload('playlist:two'), truthy = payload('playlist:two');
  inherited.playlist_sidebar.items[1].allowed_actions = Object.create({can_open: true});
  duplicate.playlist_sidebar.items.push({...duplicate.playlist_sidebar.items[1]});
  truthy.playlist_sidebar.items[1].allowed_actions.can_open = 'true';
  for (const candidate of [wrong, inherited, duplicate, truthy, payload(null)]) {
    const h = setup(), oldView = h.state.view; nativeNavigation(h);
    const pending = h.bridge.navigate({playlist_id: 'playlist:two'}), rejected = assert.rejects(pending, /could not be opened/);
    h.calls.navigation[0].finish(candidate); await rejected;
    assert.strictEqual(h.state.view, oldView); assert.equal(h.bridge.snapshot().playlistId, 'playlist:one');
  }
});

test('older Playlist navigation yields to a newer native request even when both complete', async () => {
  const h = setup(); nativeNavigation(h);
  const first = h.bridge.navigate({playlist_id: 'playlist:two'}), rejected = assert.rejects(first, {name: 'AbortError'});
  const second = h.bridge.navigate(); h.calls.navigation[1].finish(payload(null)); await second;
  h.calls.navigation[0].finish(payload('playlist:two')); await rejected;
  assert.equal(h.bridge.snapshot().playlistId, null);
});

test('Playlist navigation cannot report success after scope or shell visibility changes', async () => {
  for (const invalidate of [h => {h.shell.hidden = true;}, h => {h.shell.dataset.nativeLibraryId = 'other';}]) {
    const h = setup(); nativeNavigation(h);
    const pending = h.bridge.navigate({playlist_id: 'playlist:two'}), rejected = assert.rejects(pending, {name: 'AbortError'});
    invalidate(h); h.calls.navigation[0].resolve(false); await rejected;
  }
});

test('Playlist navigation rejects a stale scope at the native pre-apply boundary', async () => {
  for (const invalidate of [h => {h.shell.hidden = true;}, h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.shell.dataset.nativeLibraryId = 'other';}]) {
    const h = setup(), previous = h.state.view; nativeNavigation(h);
    const pending = h.bridge.navigate({playlist_id: 'playlist:two'}), rejected = assert.rejects(pending, {name: 'AbortError'});
    invalidate(h); h.calls.navigation[0].finish(payload('playlist:two')); await rejected;
    assert.strictEqual(h.state.view, previous, 'old private response must be rejected before the native owner commits it');
  }
});

test('native pre-apply guard allows its own pending transition but rejects a replaced native view', async () => {
  const h = setup(); nativeNavigation(h);
  const pending = h.bridge.navigate({playlist_id: 'playlist:two'}), request = h.calls.navigation[0];
  h.state.ui.pendingViewTransition = true;
  assert.equal(request.options.shouldApplyResponse(payload('playlist:two')), true);
  h.state.ui.pendingViewTransition = false; request.finish(payload('playlist:two')); await pending;
  assert.equal(h.bridge.snapshot().playlistId, 'playlist:two');

  const stale = setup(); nativeNavigation(stale);
  const old = stale.bridge.navigate({playlist_id: 'playlist:two'}), rejected = assert.rejects(old, {name: 'AbortError'});
  const replacement = payload('playlist:one', {title: 'New native response'}); stale.state.view = replacement;
  stale.calls.navigation[0].finish(payload('playlist:two')); await rejected;
  assert.strictEqual(stale.state.view, replacement);
});

const replayAlbumTarget = overrides => ({kind: 'album', ref: 'catalog:album', allowed_actions: {can_view_details: true},
  native_actions: {album_ref: 'local:album', allowed_actions: {can_open_album: true, can_play_album: false}}, ...overrides});
const replayPayload = overrides => payload('playlist:one', {revision: 'revision:one',
  track_rows: [track('item:one', {album_target: replayAlbumTarget()})], ...overrides});
function playlistReplay() {
  const h = setup(replayPayload(), {captureResourceRevalidator: true}), snapshot = h.bridge.snapshot();
  return {...h, scopeKey: snapshot.scopeKey, selection: snapshot.payload.playlist_detail.track_rows[0].album_target};
}
function openReplayDraft(h) {
  h.context.AlbumHavenSettingsNavigation = {instance: {setPlaylistDraftOwner: () => () => {},
    writeLibraryHistory(url, value) {h.context.history.state = value; h.context.location.href = new URL(url, h.context.location).href;}}};
  return h.bridge.openDraft({token: 'replay:draft', scopeKey: h.scopeKey, isCurrent: () => true,
    confirmLeave: async () => true, onDiscard() {}});
}

test('private Playlist replay rereads its actual source while ordinary hidden reads/actions remain denied', async () => {
  const h = playlistReplay(), abort = new AbortController(); h.shell.hidden = true; h.bridge.sync();
  const context = {scopeKey: h.scopeKey, origin: h.selection.origin};
  await assert.rejects(h.bridge.readPlaylists({scopeKey: h.scopeKey, playlist_id: 'playlist:one'}), {status: 403});
  await assert.rejects(h.bridge.readPlaylists({scopeKey: h.scopeKey, playlist_id: 'playlist:one', replay: true}, true), {status: 403});
  assert.equal(h.calls.reads.length, 0);
  h.context.fetch = async (...args) => {h.calls.reads.push(args); return response(replayPayload({track_rows: [track('item:one', {
    album_target: replayAlbumTarget({native_actions: {album_ref: 'local:album', allowed_actions: {
      can_open_album: true, can_play_album: true, can_view_artwork: false,
    }}}),
  })]}));};
  const fresh = await h.revalidateResource(h.selection, context, {signal: abort.signal});
  assert.equal(h.calls.reads.length, 1);
  assert.equal(h.calls.reads[0][0], '/view-data?surface=playlists&playlist_id=playlist%3Aone');
  assert.equal(h.calls.reads[0][1].credentials, 'same-origin'); assert.equal(h.calls.reads[0][1].cache, 'no-store');
  assert.equal(h.calls.reads[0][1].signal, abort.signal);
  assert.equal(fresh.target.native_actions.album_ref, 'local:album');
  assert.equal(fresh.target.native_actions.allowed_actions.can_play_album, false, 'original play restriction remains');
  assert.equal(fresh.target.native_actions.allowed_actions.can_view_artwork, false, 'fresh source restriction applies');
  assert.deepEqual(plain(fresh.target.origin), plain(h.selection.origin)); assert.ok(Object.isFrozen(fresh));
  assert.equal(fresh.isCurrent(), true); assert.equal(h.bridge.revalidateResource, undefined);
  assert.equal(h.bridge.canResourceIntent('open', h.selection, context), false);
  h.shell.hidden = false; h.bridge.sync(); assert.equal(fresh.isCurrent(), true);
  const responsePending = deferred(); h.context.fetch = () => responsePending.promise;
  const reading = h.bridge.readPlaylists({playlist_id: 'playlist:one'});
  assert.equal(fresh.isCurrent(), false, 'a newer source read retires the old replay grant before completion');
  responsePending.resolve(response(replayPayload())); await reading;
});

test('Playlist replay needs current exact source access, identity, revision and an unambiguous canonical mapping', async () => {
  const unreadable = replayPayload(); unreadable.playlist_sidebar.items[0].allowed_actions.can_open = false;
  const duplicate = replayPayload(); duplicate.playlist_sidebar.items.push({...duplicate.playlist_sidebar.items[0]});
  for (const candidate of [unreadable, duplicate, payload('playlist:two'), replayPayload({revision: 'revision:two'}),
    replayPayload({track_rows: [track('a', {album_target: replayAlbumTarget()}), track('b', {album_target: replayAlbumTarget({
      native_actions: {album_ref: 'other:local', allowed_actions: {can_open_album: true}},
    })})]}),
    replayPayload({track_rows: [track('a', {album_target: replayAlbumTarget({native_actions: {album_ref: 'other:local',
      allowed_actions: {can_open_album: true}}})})]}),
    replayPayload({track_rows: [track('a', {album_target: replayAlbumTarget({native_actions: {album_ref: 'local:album',
      allowed_actions: {can_open_album: false}}})})]})]) {
    const h = playlistReplay(); h.context.fetch = async () => response(candidate);
    await assert.rejects(h.revalidateResource(h.selection, {scopeKey: h.scopeKey, origin: h.selection.origin}), {status: 403});
  }
  for (const candidate of [replayPayload({track_rows: [track()]}),
    replayPayload({track_rows: [track('a', {source_readable: false, album_target: replayAlbumTarget()})]}),
    replayPayload({track_rows: [track('a', {album_target: replayAlbumTarget({native_actions: undefined})})]})]) {
    const h = playlistReplay(); h.context.fetch = async () => response(candidate);
    assert.equal(await h.revalidateResource(h.selection, {scopeKey: h.scopeKey, origin: h.selection.origin}), null);
  }
});

test('Playlist replay rejects stale scope or canceled input before reading and unknown source kinds stay unavailable', async () => {
  const h = playlistReplay(), context = {scopeKey: h.scopeKey, origin: h.selection.origin};
  await assert.rejects(h.revalidateResource(h.selection, {...context, scopeKey: 'foreign'}), {status: 403});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.revalidateResource(h.selection, context, {signal: abort.signal}), {name: 'AbortError'});
  const origin = {source: 'activity', account_ref: null, kind: 'albums', period: 'week'};
  assert.equal(await h.revalidateResource({...h.selection, origin}, {...context, origin}), null);
  assert.equal(h.calls.reads.length, 0);
});

test('Playlist replay neither bypasses nor overwrites a current unsaved draft', async () => {
  const h = playlistReplay(); assert.equal(openReplayDraft(h), true);
  await assert.rejects(h.revalidateResource(h.selection, {scopeKey: h.scopeKey, origin: h.selection.origin}), {status: 403});
  assert.equal(h.calls.reads.length, 0); assert.equal(h.bridge.snapshot().draftToken, 'replay:draft');
  const pending = playlistReplay(), json = deferred(), entered = deferred();
  const savedPayload = pending.bridge.snapshot().payload, nativeView = pending.state.view;
  pending.context.fetch = async () => ({ok: true, json() {entered.resolve(); return json.promise;}});
  const reading = pending.revalidateResource(pending.selection, {scopeKey: pending.scopeKey, origin: pending.selection.origin});
  const rejected = assert.rejects(reading, {name: 'AbortError'}); await entered.promise;
  assert.equal(openReplayDraft(pending), true);
  json.resolve(replayPayload({title: 'Late replay result', revision: 'revision:late'})); await rejected;
  const snapshot = pending.bridge.snapshot(), context = {scopeKey: pending.scopeKey, origin: pending.selection.origin};
  assert.equal(snapshot.draftToken, 'replay:draft'); assert.equal(snapshot.retainedDraftToken, 'replay:draft');
  assert.equal(snapshot.playlistId, null);
  assert.strictEqual(snapshot.payload, savedPayload, 'the draft retains its saved display baseline without accepting the late replay');
  assert.strictEqual(pending.state.view, nativeView);
  assert.equal(pending.bridge.canResourceIntent('open', pending.selection, context), false);
  assert.equal(pending.retainResource(pending.selection, context), null);
  assert.equal(pending.bridge.canTrackIntent('play', {playlist_item_id: 'item:one'},
    {scopeKey: pending.scopeKey, playlist_id: 'playlist:one'}), false);
});

test('Playlist replay cannot complete across navigation, scope, cancellation or newer source reads', async () => {
  for (const invalidate of [h => h.abort.abort(), h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.shell.dataset.nativeLibraryId = 'other';}, h => {h.context.location.searchParams.set('playlist_id', 'other');},
    h => {h.context.history.state = {albumHavenNavigationPosition: 9};},
    async h => {h.context.fetch = async () => response(replayPayload()); await h.bridge.readPlaylists({playlist_id: 'playlist:one'});}]) {
    const h = playlistReplay(), json = deferred(), entered = deferred(); h.abort = new AbortController();
    h.context.fetch = async () => ({ok: true, json() {entered.resolve(); return json.promise;}});
    const pending = h.revalidateResource(h.selection, {scopeKey: h.scopeKey, origin: h.selection.origin}, {signal: h.abort.signal});
    const rejected = assert.rejects(pending, {name: 'AbortError'}); await entered.promise;
    await invalidate(h); json.resolve(replayPayload()); await rejected;
  }
});

test('returned Playlist replay grants expire with source replacement, scope or replay cancellation', async () => {
  for (const invalidate of [h => h.abort.abort(), h => {h.shell.dataset.nativeAccountId = 'other';},
    h => {h.state.view = replayPayload({track_rows: []}); h.bridge.sync();}]) {
    const h = playlistReplay(); h.abort = new AbortController(); h.context.fetch = async () => response(replayPayload());
    const result = await h.revalidateResource(h.selection, {scopeKey: h.scopeKey, origin: h.selection.origin}, {signal: h.abort.signal});
    assert.equal(result.isCurrent(), true); invalidate(h); assert.equal(result.isCurrent(), false);
  }
});

test('initial Playlist source transfers survive UI cleanup but retire with reads, replacements and drafts', async () => {
  const h = playlistReplay(), abort = new AbortController();
  const context = {scopeKey: h.scopeKey, origin: h.selection.origin, signal: abort.signal};
  const receipt = h.retainResource(h.selection, context); assert.ok(receipt);
  assert.equal(h.bridge.retainResource, undefined); abort.abort(); h.shell.hidden = true; h.bridge.sync();
  assert.equal(receipt.isCurrent(), true);
  assert.equal(h.retainResource(h.selection, context), null);
  assert.equal(h.bridge.canResourceIntent('open', h.selection, context), false);
  h.shell.hidden = false; h.bridge.sync(); h.context.fetch = async () => response(replayPayload());
  const reading = h.bridge.readPlaylists({playlist_id: 'playlist:one'}); assert.equal(receipt.isCurrent(), false); await reading;
  const fresh = h.retainResource(h.selection, {...context, signal: undefined});
  assert.ok(fresh); assert.equal(openReplayDraft(h), true); assert.equal(fresh.isCurrent(), false);
  const replaced = playlistReplay(), current = replaced.retainResource(replaced.selection, {scopeKey: replaced.scopeKey, origin: replaced.selection.origin});
  replaced.state.view = replayPayload({track_rows: []}); replaced.bridge.sync(); assert.equal(current.isCurrent(), false);
});
