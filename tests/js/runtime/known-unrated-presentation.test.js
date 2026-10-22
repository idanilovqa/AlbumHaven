const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const {fixture} = require('./playlist-native-review-fixture.cjs');

// Real native owner/DTO contracts. No browser geometry acceptance is claimed.
const env = fixture();
env.host.remove();
let ActivityPanel, ComparisonPanel, ComparisonCards, comparisonTableHtml,
  projectComparisonRows, playlistTableHtml, missingPlaylistDraftTableHtml;
for (const name of ['compact-data-table.js', 'album-track-table.js', 'trigger-anchor.js', 'library-settings.js']) {
  vm.runInContext(readRepo(`music_app/static/js/runtime/${name}`), env.context);
}
vm.runInContext(readRepo('music_app/static/js/unfolding-action-button.js'), env.context);
const runtime = {
  escapeHtml: env.context.escapeHtml,
  buttonHtml: options => env.context.ButtonComponent.renderButton(options),
  actionHtml: options => env.context.ButtonComponent.renderActionButton(options),
  iconHtml: (name, options) => env.context.ButtonComponent.renderIconSvg(name, options),
  tableHtml: env.context.buildCompactDataTable, ratingHtml: env.context.buildGalleryRatingHtml,
  galleryCardHtml: env.context.buildGalleryCardHtml, artboxHtml: env.context.buildAlbumArtboxHtml,
  alertHtml: env.context.buildOnPageAlertHtml, openChoice: env.context.openUtilityChoiceDropdown,
  viewChooserHtml: options => env.context.UnfoldingActionButton.render(options),
  mountViewChooser: (element, options) => env.context.UnfoldingActionButton.mount(element, options),
  viewIconHtml: value => {
    if (!['list', 'cards', 'covers'].includes(value)) return '';
    const holder = env.document.createElement('div');
    holder.innerHTML = env.context.buildGalleryBarHtml({});
    return holder.querySelector(`[data-gallery-view-choice="${value}"] svg`)?.outerHTML || '';
  },
  albumTrackRow: (row, index) => env.context.buildAlbumTrackTableRow(row, index, {readOnly: true}),
  preferredTimeZone: () => 'UTC',
};
const host = html => {const element = env.document.createElement('div'); element.innerHTML = html; return element;};
const ready = rows => ({status: 'ready', data: {rows}});
const mounted = [];
const render = (mount, props) => {
  const element = env.document.createElement('section'); env.document.body.append(element);
  try {
    const owner = mount(element, runtime, {view: 'rows', ...props});
    mounted.push({owner, element});
    return element;
  } catch (error) {element.remove(); throw error;}
};
const baselineListeners = env.listeners().length;
test.afterEach(() => {
  let failure;
  for (const {owner, element} of mounted.splice(0).reverse()) {
    try {owner.dispose(); assert.equal(element.childNodes.length, 0);}
    catch (error) {failure ??= error;} finally {element.remove();}
  }
  assert.equal(env.listeners().length, baselineListeners, 'native owner listeners retire');
  if (failure) throw failure;
});
const ratingCell = (element, key = 'rating') => element.querySelector(`[role="cell"][data-cdt-column="${key}"]`);
function unrated(element, kind) {
  assert.ok(element, 'rating surface exists');
  const stars = element.querySelector('.stars');
  assert.ok(stars, 'known unrated uses the shared rating renderer');
  assert.equal(stars.getAttribute('role'), 'img');
  assert.equal(stars.getAttribute('aria-label'), `${kind === 'album' ? 'Album' : 'Track'} unrated`);
  assert.equal(stars.querySelectorAll('.star').length, kind === 'album' ? 10 : 5);
  assert.equal(stars.querySelectorAll('.filled').length, 0);
  assert.equal(element.querySelector('.rating-text'), null, 'unrated has no numeric zero');
  assert.equal(element.querySelector('button,input,[tabindex],[data-rating-star]'), null, 'display never grants editing');
}
const identity = (kind = 'track', id = 'known-unrated') => ({id, kind, title: 'Subject track', artist: 'Artist', album_title: 'Album'});
const preference = (rating = null) => ({identity: 'native-preference:known-unrated', rating, love_tier: 'off', allowed_actions: {can_set_love_tier: false}});
const friend = {account_ref: 'friend:known-unrated', relationship: 'accepted', display_name: 'Friend', allowed_actions: {can_compare: true}};
let model, metrics, playlists, facts, preferences;
test.before(async () => {
  ({mountActivityPanel: ActivityPanel} = await import('../../../music_app/static/js/home-friends/activity.mjs'));
  ({mountComparisonPanel: ComparisonPanel, mountComparisonCards: ComparisonCards,
    comparisonTableHtml, projectComparisonRows} = await import('../../../music_app/static/js/home-friends/comparison.mjs'));
  ({playlistTableHtml} = await import('../../../music_app/static/js/playlists/native-track-table.mjs'));
  ({missingPlaylistDraftTableHtml} = await import('../../../music_app/static/js/playlists/native-draft.mjs'));
  model = await import('../../../music_app/static/js/home-friends/model.mjs');
  metrics = await import('../../../music_app/static/js/playlists/track-metrics.mjs');
  playlists = await import('../../../music_app/static/js/playlists/model.mjs');
  facts = await import('../../../music_app/static/js/playlists/filters.mjs');
  preferences = await import('../../../music_app/static/js/home-friends/track-preference.mjs');
});
async function activityRows(rows, kind) {
  const c = model.createHomeFriendsController({providers: {readActivity: async () => ({rows})}});
  try {await c.loadActivity({kind}); assert.equal(c.getSnapshot().activity.status, 'ready'); return c.getSnapshot().activity.data.rows;}
  finally {c.dispose();}
}
async function comparisonRows(rows, kind) {
  const c = model.createHomeFriendsController({providers: {
    readFriends: async () => ({friends: [friend], requests: [], profile: null}),
    readComparison: async () => ({rows}),
  }});
  try {
    await c.loadFriends(); assert.equal(c.selectFriend(friend.account_ref), true); await c.loadComparison({kind});
    assert.equal(c.getSnapshot().comparison.status, 'ready'); return c.getSnapshot().comparison.data.rows;
  } finally {c.dispose();}
}
const trackCell = (row, state) => host(metrics.playlistTrackMetricCells(runtime, row, state).track_rating.content);
function playlistRoundTrip(row) {
  const payload = rows => ({playlist_sidebar: {items: []}, playlist_detail: {playlist_id: 'known-unrated', title: 'Unrated', track_rows: rows}});
  const first = playlists.normalizePlaylistPayload(payload([row])).detail.track_rows[0];
  return playlists.normalizePlaylistPayload(payload([first])).detail.track_rows[0];
}

for (const [kind, plural, maximum] of [['track', 'tracks', 5], ['listen', 'listens', 5], ['album', 'albums', 10]]) {
  test(`${plural}: authoritative available null survives model round trips and renders canonical empty stars`, async () => {
    let rows = [{...identity(kind), rating: null, taste_state: 'available'}];
    rows = await activityRows(await activityRows(rows, plural), plural);
    assert.equal(rows[0].rating, null); assert.equal(rows[0].taste_state, 'available');
    unrated(ratingCell(render(ActivityPanel, {kind: plural, value: ready(rows)})), kind);
    const positive = await activityRows([{...identity(kind), rating: maximum, taste_state: 'available'}], plural);
    const cell = ratingCell(render(ActivityPanel, {kind: plural, value: ready(positive)}));
    assert.equal(cell.textContent, String(maximum)); assert.equal(cell.querySelector('.stars'), null);
  });
}

test('activity unavailable, missing, inherited and malformed ratings cannot turn into known-unrated after normalization', async () => {
  const base = identity();
  const inputs = [base, {...base, taste_state: 'available'}, {...base, rating: null},
    {...base, rating: null, taste_state: 'unavailable'}, {...base, rating: null, taste_state: 'denied'},
    {...base, rating: null, taste_state: 'available', source_readable: false},
    Object.assign(Object.create({rating: null}), base, {taste_state: 'available'}),
    Object.assign(Object.create({taste_state: 'available'}), base, {rating: null}),
    ...[undefined, '4', 0, 6, NaN, Infinity, {}, []].map(rating => ({...base, rating, taste_state: 'available'}))];
  for (const input of inputs) {
    const rows = await activityRows(await activityRows([input], 'tracks'), 'tracks');
    const cell = ratingCell(render(ActivityPanel, {kind: 'tracks', value: ready(rows)}));
    assert.equal(cell.textContent, '–'); assert.equal(cell.querySelector('.stars'), null);
    assert.notEqual(rows[0].taste_state, 'available', 'invalid nullable admission must survive the next model pass');
  }
});

test('activity Now Playing renders only authoritative known-null as five stars and loading never flashes unrated', () => {
  const row = {...identity(), rating: null, taste_state: 'available'};
  const nowPlaying = {occurrence_ref: 'occurrence:unrated', row};
  unrated(ratingCell(render(ActivityPanel, {kind: 'tracks', value: ready([]), nowPlaying})), 'track');
  const unknown = render(ActivityPanel, {kind: 'tracks', value: ready([]), nowPlaying: {...nowPlaying, row: identity()}});
  assert.equal(ratingCell(unknown).textContent, '–');
  assert.equal(render(ActivityPanel, {kind: 'tracks', value: {status: 'loading', data: null}}).querySelector('.stars'), null);
});

for (const [kind, plural, maximum] of [['track', 'tracks', 5], ['album', 'albums', 10]]) {
  test(`${plural}: comparison sides retain independent nullable taste authority in table, cards and selected details`, async () => {
    const raw = {...identity(kind), yours: {listen_count: 2, rating: maximum, taste_state: 'available'},
      friend: {listen_count: 1, rating: null, taste_state: 'available'}};
    const rows = await comparisonRows(await comparisonRows([raw], plural), plural);
    assert.equal(rows[0].friend.taste_state, 'available'); assert.equal(rows[0].friend.rating, null);
    const table = host(comparisonTableHtml(runtime, rows, plural, 'Friend'));
    const own = ratingCell(table, 'yours:rating'), theirs = ratingCell(table, 'friend:rating');
    assert.equal(own.querySelector('strong').textContent, String(maximum)); assert.equal(own.querySelector('.stars'), null);
    unrated(theirs, kind); assert.equal(theirs.querySelector('.home-comparison__relation'), null);
    const panel = render(ComparisonPanel, {kind: plural, friendRef: friend.account_ref, value: ready(rows),
      presentation: {friendRef: friend.account_ref, kind: plural, period: 'week', commonOnly: false, selection: {id: raw.id, kind}}});
    const details = panel.querySelector('.home-comparison__details');
    unrated(details.querySelectorAll('dd').find(node => node.querySelector('.stars')), kind);
    if (kind === 'album') {
      const cards = render(ComparisonCards, {rows, kind: plural, friendName: 'Friend', onSelect() {}});
      unrated(cards.querySelector('[data-comparison-side="friend"]').querySelector('[data-comparison-metric="rating"]'), kind);
    }
  });
}

test('comparison absent, inherited, malformed and unavailable side ratings stay unknown without side borrowing', async () => {
  const inputs = [null, {}, {taste_state: 'available'}, {rating: null}, {rating: null, taste_state: 'unavailable'},
    Object.assign(Object.create({rating: null}), {taste_state: 'available'}),
    Object.assign(Object.create({taste_state: 'available'}), {rating: null}),
    ...[undefined, '3', 0, 6, NaN, Infinity, {}, []].map(rating => ({rating, taste_state: 'available'}))];
  for (const value of inputs) {
    const rows = await comparisonRows(await comparisonRows([{...identity(), yours: {listen_count: 4, rating: 5, taste_state: 'available'}, friend: value}], 'tracks'), 'tracks');
    const table = host(comparisonTableHtml(runtime, rows, 'tracks', 'Friend'));
    assert.equal(ratingCell(table, 'friend:rating').querySelector('strong').textContent, '–');
    assert.equal(ratingCell(table, 'friend:rating').querySelector('.stars'), null);
    assert.equal(rows[0].yours.rating, 5);
  }
});

test('unrated comparison stays null for sorting and relations rather than becoming numeric zero', async () => {
  const rows = await comparisonRows([
    {...identity('track', 'unrated'), yours: {listen_count: 8, rating: null, taste_state: 'available'}, friend: {listen_count: 1, rating: 3}},
    {...identity('track', 'rated'), yours: {listen_count: 5, rating: 1, taste_state: 'available'}, friend: {listen_count: 1, rating: 3}},
    {...identity('track', 'unknown'), yours: {listen_count: 2}, friend: null},
  ], 'tracks');
  for (const direction of ['ascending', 'descending']) {
    assert.deepEqual(projectComparisonRows(rows, 'tracks', {commonOnly: false, metricSort: {side: 'yours', key: 'rating', direction}}).map(row => row.id), ['rated', 'unrated', 'unknown']);
  }
  assert.equal(rows[0].yours.rating, null);
  const table = host(comparisonTableHtml(runtime, [rows[0]], 'tracks', 'Friend'));
  assert.equal(ratingCell(table, 'yours:rating').querySelector('.home-comparison__relation'), null);
});

test('playlist known-unrated survives the real native preference, facts and model normalization round trip', () => {
  const raw = {playlist_item_id: 'unrated-item', title: 'Unrated', track_preference: preference()};
  const row = playlistRoundTrip(raw);
  assert.equal(row.track_preference.rating, null); assert.equal(Object.isFrozen(row.track_preference), true);
  const normalized = facts.normalizePlaylistFacts(row);
  assert.equal(normalized.track_preference.rating, null);
  unrated(trackCell(row), 'track');
  let view = {source: row, rows: [row], runtime: {...runtime, trackPreference: () => preference()}, context: {scopeKey: 'unrated:scope'}};
  const controller = preferences.createTrackPreferenceController({getView: () => view});
  unrated(trackCell(row, controller.get(row)), 'track');
  view = {...view, runtime: {...runtime, trackPreference: () => null}};
  assert.equal(trackCell(row, controller.get(row)).textContent, '–', 'current missing receipt suppresses stale row preference');
  controller.cancel();
  assert.equal(metrics.getPlaylistTrackMetricValue(row, 'track_rating'), null);
});

test('playlist missing and malformed native receipts never gain known-null authority during repeated normalization', () => {
  const invalid = [{}, {track_rating: null}, {track_rating: null, taste_state: 'available'},
    {track_preference: {...preference(), rating: undefined}}, {track_preference: {identity: 'native:one', love_tier: 'off'}},
    {track_preference: Object.assign(Object.create({rating: null}), {identity: 'native:one', love_tier: 'off'})},
    {track_preference: Object.assign(Object.create({identity: 'native:one'}), {rating: null, love_tier: 'off'})},
    ...['4', 0, 6, false, NaN, Infinity, {}, []].map(rating => ({track_preference: preference(rating)})),
    {track_preference: preference(), source_readable: false}, {track_preference: preference(), allowed_actions: {can_read: false}}];
  for (const input of invalid) {
    const row = playlistRoundTrip({playlist_item_id: 'unknown-item', ...input});
    assert.equal(trackCell(row).textContent, '–'); assert.equal(trackCell(row).querySelector('.stars'), null);
    const state = {preference: preferences.normalizeTrackPreference(input.track_preference)};
    assert.equal(trackCell(row, state).textContent, '–');
  }
});

test('saved and draft tables agree on admitted unrated receipt while omitted display facts remain unknown', () => {
  const row = playlistRoundTrip({playlist_item_id: 'unrated-item', title: 'Unrated', track_preference: preference()});
  const detail = {playlist_id: 'known-unrated', title: 'Known unrated', allowed_actions: {}};
  unrated(ratingCell(host(playlistTableHtml(runtime, {rows: [row], detail})), 'track_rating'), 'track');
  const state = {selectedKeys: [], title: 'Draft'};
  const entry = {...row, duration_seconds: null, metadata_state: 'unknown'};
  const projection = {entries: [entry], authoredEntries: [entry], canReorder: false};
  unrated(ratingCell(host(missingPlaylistDraftTableHtml(runtime, {id: 'unrated-draft', state, projection})), 'track_rating'), 'track');
  const unknown = playlistRoundTrip({playlist_item_id: 'unknown-item', title: 'Unknown'});
  assert.equal(ratingCell(host(playlistTableHtml(runtime, {rows: [unknown], detail})), 'track_rating').textContent, '–');
  const invalid = {...entry, track_preference: null};
  assert.equal(ratingCell(host(missingPlaylistDraftTableHtml(runtime, {id: 'unknown-draft', state, projection: {...projection, entries: [invalid], authoredEntries: [invalid]}})), 'track_rating').textContent, '–');
  assert.equal(ratingCell(host(playlistTableHtml(runtime, {rows: [row], detail, preferenceFor: () => ({preference: null})})), 'track_rating').textContent, '–');
});

test('playlist positive projected ratings retain exactly their existing five-star and numeric presentation', () => {
  const row = playlistRoundTrip({playlist_item_id: 'rated-item', track_rating: 4, track_preference: preference()});
  const cell = trackCell(row);
  assert.equal(cell.querySelector('.stars').getAttribute('aria-label'), 'Track rating: 4 out of 5');
  assert.equal(cell.querySelectorAll('.star').length, 5); assert.equal(cell.querySelectorAll('.filled').length, 4);
  assert.equal(cell.querySelector('.rating-text').textContent, '4/5');
  assert.equal(metrics.getPlaylistTrackMetricValue(row, 'track_rating'), 4);
  assert.equal(metrics.playlistTrackMetricColumns().find(column => column.key === 'track_rating').hideWhenNarrow, true);
});
