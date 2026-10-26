const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');

// Runs complete native boundary/component sources in the established bounded DOM
// fixture. Supplied DTOs are unit data, not live application or browser injection.
function setup() {
  const env = createNativeHomeRuntime(), {context, document} = env;
  vm.runInContext(readRepo('music_app/static/js/runtime/track-modal-lightbox-helpers.js'), context,
    {filename: 'track-modal-lightbox-helpers.js'});
  const shell = document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: 'account:actor', nativeLibraryId: 'library:one', privateUiContext: 'a'.repeat(64)});
  const home = document.createElement('div'); home.id = 'mobile-home'; home.dataset.accountName = 'Actor';
  document.body.append(shell, home);
  const opens = [], fetches = [], listeners = new Map();
  const cached = {key: 'album:one', name: 'Native Album', album_artist: 'Artist', album_rating: 9, favorite: true,
    taste_state: 'available', album_preference: {rating: 9},
    tracks: [{inventory_track_ref: 'inventory-track:1:1', path: '/fixture-only/unrated-one.flac', title: 'One', track_number: 1, duration_seconds: 70,
      rating: 5, taste_state: 'available', love_tier: 'obsessed', track_scrobble_count: 7, track_preference: {rating: 5, love_tier: 'obsessed'}},
      {inventory_track_ref: 'inventory-track:1:2', path: '/fixture-only/unmapped-two.flac', title: 'Two', track_number: 2, duration_seconds: 80,
        rating: 4, taste_state: 'available', love_tier: 'loved'}]};
  Object.assign(context, {
    state: {view: {context_ref: 'a'.repeat(64), recent_local_albums: [], recent_not_local_albums: []},
      ui: {pendingTrackModalLoadToken: 0}, player: {current: null, playbackQueue: null}},
    location: new URL('https://albumhaven.test/?surface=home'),
    history: {state: {albumHavenNavigationPosition: 1}}, URL, URLSearchParams, AbortController,
    addEventListener: (name, callback) => listeners.set(name, callback), dispatchEvent() {},
    MutationObserver: class {observe() {}},
    AlbumHavenCapabilities: {allows: value => value === 'library.media.read'},
    shouldShowMobileHome: () => !shell.hidden,
    fetchTrackModalAlbumDetails: async key => {fetches.push(key); return cached;},
    albumRequiresHydration: () => false, getTrackModalElements: () => ({overlay: {}}),
    openTrackModal: (album, options) => opens.push({album, options}), releaseTrackModalSelection() {},
    playerTrackSelectionToken: 0,
  });
  for (const name of ['private-ui-transport.js', 'track-actions.js', 'resource-selection.js', 'playtable-source.js', 'home-friends-bridge.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${name}`), context, {filename: name});
  }
  return {...env, shell, cached, opens, fetches, bridge: context.AlbumHavenHomeRuntime};
}
const baseTaste = () => ({subject_ref: 'account:friend', read_only: true, complete: true, rating: null,
  favorite: false, taste_state: 'available', tracks: [
    {inventory_track_ref: 'inventory-track:1:1', rating: null, taste_state: 'available', love_tier: 'off'},
  ]});
async function openSubject(env, taste, account_ref = 'account:friend') {
  const options = {scopeKey: env.bridge.snapshot().scopeKey, account_ref, kind: 'albums', period: 'week'};
  const reader = env.bridge.configureActivityProvider({
    readActivity: async () => ({snapshot_ref: 'snapshot:unrated', rows: [{id: 'album:activity', kind: 'album', title: 'Album',
      album_target: {kind: 'album', ref: 'album:activity', allowed_actions: {can_view_details: true},
        native_actions: {album_ref: 'album:one', allowed_actions: {can_open_album: true, can_play_album: false}}}}]}),
    resolveActivityNativeTarget: async () => ({album_ref: 'album:one', allowed_actions: {can_view_details: true, can_play_album: false}, subject_taste: taste}),
  });
  const result = await reader(options), selection = result.rows[0].album_target;
  await env.bridge.resourceIntent('open', selection, {scopeKey: options.scopeKey, origin: selection.origin});
  return {album: env.opens.at(-1).album, options, selection};
}
function nativeDetails(env, album) {
  const {document, context} = env;
  for (const name of ['compact-data-table.js', 'album-track-table.js', 'tag-editor-and-optimistic-updates.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${name}`), context, {filename: name});
  }
  const els = Object.fromEntries(['overlay', 'header', 'cover', 'list'].map(key => [key, document.createElement('div')]));
  Object.assign(context, {getTrackModalElements: () => els, albumHasDisplayCover: () => false,
    getPlayerPlaybackSnapshot: () => ({paused: true, ended: false, currentTime: 0}),
    formatTrackDuration: value => value == null ? '' : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`,
    formatAlbumDuration: () => ''});
  context.renderTrackModalRelease(album);
  assert.equal(album.read_only_subject, 'account:friend');
  assert.equal(album.can_edit_preferences, false);
  assert.equal(Object.hasOwn(album, 'album_preference'), false);
  assert.equal(context.getTrackModalAlbumPreferenceLease(), null, 'subject summary never acquires an own-preference lease');
  assert.equal(els.header.querySelectorAll('[data-album-preference-action]').length, 0);
  assert.doesNotMatch(els.header.textContent, /Your (?:album|rating|favorite)/);
  assert.equal(env.forbiddenCalls.includes('fetch'), false, 'subject presentation must not dispatch a preference POST or read');
  return els;
}
const cell = (element, index = 0) => element.querySelectorAll('[role="cell"][data-cdt-column="rating"]')[index];
function assertUnrated(element, kind) {
  const stars = element.querySelector('.stars'); assert.ok(stars, 'canonical shared stars must be present');
  assert.equal(element.querySelectorAll('.stars').length, 1);
  assert.equal(stars.getAttribute('role'), 'img');
  assert.equal(stars.getAttribute('aria-label'), `${kind === 'album' ? 'Subject album' : 'Track'} unrated`);
  assert.equal(stars.querySelectorAll('.star').length, kind === 'album' ? 10 : 5);
  assert.equal(stars.querySelectorAll('.filled').length, 0);
  assert.equal(element.querySelector('.rating-text'), null);
}

test('Home exposes its existing shared rating renderer to React consumers', () => {
  const env = setup(); assert.equal(typeof env.bridge.ratingHtml, 'function');
  const element = env.document.createElement('div'); element.innerHTML = env.bridge.ratingHtml({value: 0, maximum: 5, label: 'Track unrated'});
  assertUnrated(element, 'track');
});

test('authorized subject Album header and tracks show empty stars while actor cache and unmapped subject stay independent', async () => {
  const env = setup(), before = JSON.stringify(env.cached);
  const {album} = await openSubject(env, baseTaste());
  assert.notStrictEqual(album, env.cached);
  assert.equal(album.album_rating, null); assert.equal(album.tracks[0].rating, null);
  assert.equal(album.tracks[1].rating, null); assert.equal(album.tracks[0].can_edit_preferences, false);
  assert.equal(album.tracks[0].track_preference.allowed_actions.can_set_love_tier, false);
  const details = nativeDetails(env, album);
  assertUnrated(details.header, 'album'); assertUnrated(cell(details.list), 'track');
  assert.equal(cell(details.list, 1).textContent, '–'); assert.equal(cell(details.list, 1).querySelector('.stars'), null);
  assert.equal(JSON.stringify(env.cached), before, 'viewing the friend never mutates actor cache');
  assert.equal(env.opens.at(-1).options.presentationRestrictions.can_play_album, false);
});

test('positive subject Album uses shared ten-point stars while track numeric presentation and return to actor remain untouched', async () => {
  const env = setup(), taste = baseTaste(); taste.rating = 7; taste.tracks[0].rating = 2;
  const {album} = await openSubject(env, taste);
  const details = nativeDetails(env, album);
  const stars = details.header.querySelector('.stars');
  assert.ok(stars); assert.equal(details.header.querySelectorAll('.stars').length, 1);
  assert.equal(stars.getAttribute('role'), 'img');
  assert.equal(stars.getAttribute('aria-label'), 'Subject album rating 7/10');
  assert.equal(stars.querySelectorAll('.star').length, 10);
  assert.equal(stars.querySelectorAll('.filled').length, 7);
  assert.equal(details.header.querySelector('.rating-text').textContent, '7/10');
  assert.equal(cell(details.list).textContent, '2'); assert.equal(cell(details.list).querySelector('.stars'), null);
  const own = await openSubject(env, taste, null);
  assert.strictEqual(own.album, env.cached); assert.equal(own.album.album_rating, 9); assert.equal(own.album.tracks[0].rating, 5);
});

test('subject missing, mismatched, inherited, unavailable and malformed nullable facts do not masquerade as unrated', async () => {
  const variants = [null, {...baseTaste(), subject_ref: 'account:another'}, {...baseTaste(), read_only: false},
    {...baseTaste(), taste_state: 'unavailable', tracks: [{inventory_track_ref: 'inventory-track:1:1', rating: null, taste_state: 'unavailable'}]},
    {...baseTaste(), rating: undefined, tracks: [{inventory_track_ref: 'inventory-track:1:1', taste_state: 'available'}]},
    {...baseTaste(), rating: '7', tracks: [{inventory_track_ref: 'inventory-track:1:1', rating: '2', taste_state: 'available'}]},
    {...baseTaste(), rating: 0, tracks: [{inventory_track_ref: 'inventory-track:1:1', rating: 0, taste_state: 'available'}]},
    Object.assign(Object.create({rating: null}), {subject_ref: 'account:friend', read_only: true, taste_state: 'available', tracks: [
      Object.assign(Object.create({rating: null}), {inventory_track_ref: 'inventory-track:1:1', taste_state: 'available'})]}),
    Object.assign(Object.create({taste_state: 'available'}), {subject_ref: 'account:friend', read_only: true, rating: null, tracks: [
      Object.assign(Object.create({taste_state: 'available'}), {inventory_track_ref: 'inventory-track:1:1', rating: null})]}),
  ];
  for (const taste of variants) {
    const env = setup(), {album} = await openSubject(env, taste);
    const details = nativeDetails(env, album);
    assert.equal(album.taste_state, 'unavailable'); assert.equal(album.album_rating, null);
    assert.equal(details.header.querySelector('.stars'), null); assert.equal(details.header.querySelector('.rating-text'), null);
    assert.equal(details.header.querySelector('.playlists__note').textContent, 'Rating: Unavailable · Favorite: Unavailable');
    assert.equal(cell(details.list).textContent, '–'); assert.equal(cell(details.list).querySelector('.stars'), null);
    assert.equal(env.cached.album_rating, 9); assert.equal(env.cached.tracks[0].rating, 5);
  }
});

test('subject preference revocation removes the old known-null projection on the next authorized open', async () => {
  const env = setup(), first = await openSubject(env, baseTaste());
  assert.equal(first.album.album_rating, null);
  env.bridge.retireFriendActivity({scopeKey: first.options.scopeKey, friends: {status: 'ready', data: {friends: []}}});
  await assert.rejects(env.bridge.resourceIntent('open', first.selection, {scopeKey: first.options.scopeKey, origin: first.selection.origin}));
  assert.equal(env.opens.length, 1);
  const second = await openSubject(env, {...baseTaste(), taste_state: 'unavailable', tracks: []});
  const details = nativeDetails(env, second.album);
  assert.equal(details.header.querySelector('.stars'), null); assert.equal(cell(details.list).querySelector('.stars'), null);
  assert.equal(cell(details.list).textContent, '–');
});

test('activity bridge does not bless missing or malformed values by first collapsing them to null', async () => {
  const {createHomeFriendsController} = await import('../../../music_app/static/js/home-friends/model.mjs');
  const variants = [{rating: null, taste_state: 'available'}, {taste_state: 'available'},
    ...[undefined, '4', 0, 6, NaN, Infinity].map(rating => ({rating, taste_state: 'available'})),
    Object.assign(Object.create({rating: null}), {taste_state: 'available'}),
    Object.assign(Object.create({taste_state: 'available'}), {rating: null})];
  for (const [index, taste] of variants.entries()) {
    const env = setup(), source = Object.assign(Object.create(Object.getPrototypeOf(taste)), taste,
      {id: 'activity:unrated', kind: 'track', title: 'Track'});
    const reader = env.bridge.configureActivityProvider({readActivity: async () => ({rows: [source]})});
    const projected = await reader({scopeKey: env.bridge.snapshot().scopeKey, account_ref: null, kind: 'tracks', period: 'week'});
    const controller = createHomeFriendsController({providers: {readActivity: async () => projected}});
    try {
      await controller.loadActivity({kind: 'tracks'});
      assert.equal(controller.getSnapshot().activity.status, 'ready');
      const row = controller.getSnapshot().activity.data.rows[0];
      assert.equal(row.rating, null);
      assert.equal(row.taste_state === 'available', index === 0, 'only raw explicit nullable rating with explicit available taste is admitted');
    } finally {controller.dispose();}
  }
});

test('actual Playlist native receipt survives public projection and model round trips without projected track_rating', async () => {
  const env = setup(), {context, document} = env;
  for (const id of ['playlists-root', 'shell-main-surface']) {
    const node = document.createElement('div'); node.id = id; document.body.appendChild(node);
  }
  context.location = new URL('https://albumhaven.test/?surface=playlists');
  const rawRow = {playlist_item_id: 'item:unrated', inventory_track_ref: 'inventory-track:1:1',
    track_ref: '/fixture-only/unrated-one.flac', title: 'Unrated track', source_readable: true,
    track_preference: {rating: null, love_tier: 'off', allowed_actions: {can_set_love_tier: false}}};
  context.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: 'playlist:unrated', items: []},
    playlist_detail: {playlist_id: 'playlist:unrated', revision: '1', title: 'Unrated playlist', track_rows: [rawRow]}};
  vm.runInContext(readRepo('music_app/static/js/runtime/playlists-react-bridge.js'), context);
  const bridge = context.AlbumHavenPlaylistRuntime, snapshot = bridge.snapshot();
  const {normalizePlaylistPayload} = await import('../../../music_app/static/js/playlists/model.mjs');
  const {playlistTrackMetricCells} = await import('../../../music_app/static/js/playlists/track-metrics.mjs');
  const {createTrackPreferenceController} = await import('../../../music_app/static/js/home-friends/track-preference.mjs');
  let payload = snapshot.payload;
  for (let pass = 0; pass < 2; pass++) {
    const normalized = normalizePlaylistPayload(payload);
    payload = {playlist_sidebar: {items: []}, playlist_detail: {...normalized.detail, track_rows: normalized.detail.track_rows}};
  }
  const row = payload.playlist_detail.track_rows[0], options = {scopeKey: snapshot.scopeKey, playlist_id: snapshot.playlistId};
  assert.equal(rawRow.track_rating, undefined, 'native receipt is the only rating evidence');
  assert.equal(row.track_rating, null); assert.equal(row.track_preference.rating, null);
  assert.doesNotMatch(JSON.stringify(row), /fixture-only|track_ref/);
  const view = {source: snapshot.payload, rows: [row], runtime: bridge, context: options};
  const controller = createTrackPreferenceController({getView: () => view});
  const state = controller.get(row), host = document.createElement('div');
  assert.equal(state.preference.rating, null);
  host.innerHTML = playlistTrackMetricCells(bridge, row, state).track_rating.content;
  assertUnrated(host, 'track');
  env.shell.dataset.nativeAccountId = 'account:replacement'; bridge.sync();
  host.innerHTML = playlistTrackMetricCells(bridge, row, controller.get(row)).track_rating.content;
  assert.equal(host.textContent, '–'); assert.equal(host.querySelector('.stars'), null);
  controller.cancel();
});

test('inherited subject track mappings cannot authorize known-unrated even when the album taste is available', async () => {
  const env = setup(), supplied = baseTaste();
  const taste = Object.assign(Object.create({tracks: supplied.tracks}), {
    subject_ref: supplied.subject_ref, read_only: true, complete: true,
    rating: null, favorite: false, taste_state: 'available',
  });
  assert.equal(Object.hasOwn(taste, 'tracks'), false);
  const {album} = await openSubject(env, taste), details = nativeDetails(env, album);
  assertUnrated(details.header, 'album');
  assert.equal(cell(details.list).textContent, '–');
  assert.equal(cell(details.list).querySelector('.stars'), null);
  assert.equal(env.cached.tracks[0].rating, 5);
});

test('inherited native inventory identity cannot join subject taste to a track', async () => {
  const env = setup(), track = env.cached.tracks[0], inheritedRef = track.inventory_track_ref;
  delete track.inventory_track_ref;
  Object.setPrototypeOf(track, {inventory_track_ref: inheritedRef});
  assert.equal(Object.hasOwn(track, 'inventory_track_ref'), false);
  const {album} = await openSubject(env, baseTaste()), details = nativeDetails(env, album);
  assertUnrated(details.header, 'album');
  assert.equal(cell(details.list).textContent, '–');
  assert.equal(cell(details.list).querySelector('.stars'), null);
  assert.equal(env.cached.tracks[0].rating, 5);
});
