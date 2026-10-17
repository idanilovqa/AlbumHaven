'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {id, recipe, mixMetadata, capture, receipt, deferred, plain} = require('./library-mix-fixtures.cjs');
const {payload, row: savedRow} = require('./library-mix-native-fixture.cjs');
function controller(h, providers = {}) {
  const scopeKey = h.runtime.snapshot().scopeKey;
  return h.api.createLibraryMixController({scopeKey, isCurrent: () => true, requestKey: () => id(90), providers: {
    beginLibraryMix: async options => capture({scopeKey, library_mix: mixMetadata(options.recipe)}),
    createPlaylistFromSelection: async options => receipt(options.request_key, {scopeKey}), ...providers}});
}

test('real native setup mounts into shared native form and native Choices send one complete recipe', async t => {
  const h = await nativeMixFixture(t), prepares = [], ready = [];
  const c = controller(h, {beginLibraryMix: async options => {prepares.push(options); return capture({scopeKey: options.scopeKey, library_mix: mixMetadata(options.recipe)});}});
  const mounted = h.mount('setup', {controller: c, onClose() {}, onReady: async close => {ready.push(c.source()); return close({force: true, restoreFocus: false});}});
  await h.settle();
  assert.equal(h.form.hidden, false); assert.equal(mounted.host.textContent, '', 'dialog content belongs to native portal host');
  assert.match(h.form.textContent, /whole server library/); assert.match(h.form.textContent, /Last.fm global plays/);
  assert.equal(h.form.querySelector('select'), null);
  const count = h.form.querySelector('input[aria-label="Songs per group"]');
  assert.equal(count.getAttribute('min'), '1'); assert.equal(count.getAttribute('max'), '5000');
  h.choose('Choose songs', 'per_album'); h.choose('Playback order', 'unplayed_first'); h.choose('Update automatically when saved', 'on');
  h.click(h.named('Create mix', h.form)); await h.settle();
  assert.equal(prepares.length, 1); assert.deepEqual(plain(prepares[0].recipe), recipe({selection_basis: 'per_album', playback_order: 'unplayed_first', auto_update: true}));
  assert.equal(ready.length, 1); assert.equal(h.form.hidden, true);
  assert.equal(h.state.player.current, null, 'creating a preview does not start the player');
});

test('busy setup visibly disables creation and all recipe controls; native Cancel retires late ready work', async t => {
  const h = await nativeMixFixture(t), wait = deferred(); let reads = 0, ready = 0, closed = 0;
  const c = controller(h, {beginLibraryMix: () => {reads++; return wait.promise;}});
  const owner = h.mount('setup', {controller: c, onClose: () => {closed++; c.dispose();}, onReady: () => {ready++;}});
  h.click(h.named('Create mix', h.form)); await h.settle();
  assert.equal(h.named('Create mix', h.form).disabled, true);
  assert.equal(h.form.querySelector('input').disabled, true);
  for (const button of h.form.querySelectorAll('button[aria-haspopup="menu"]')) assert.equal(button.disabled, true);
  h.click(h.named('Cancel', h.form)); await h.settle();
  wait.resolve(capture({scopeKey: c.getSnapshot().scopeKey})); await h.settle();
  assert.equal(reads, 1); assert.equal(ready, 0); assert.equal(closed, 1); assert.equal(h.form.hidden, true);
  owner.unmount();
});

test('real temporary page reuses shared header/table with locked membership and native playback command', async t => {
  const h = await nativeMixFixture(t), c = controller(h); await c.prepare(recipe({auto_update: true}));
  const runtime = h.mixRuntime(c), saved = [];
  const page = h.mount('page', {runtime, controller: c, onSaved: value => saved.push(value), onClose() {}}); await h.settle();
  assert.ok(page.host.querySelector('[data-shared-header="library-mix"]'));
  assert.ok(page.host.querySelector('.compact-data-table')); assert.equal(page.host.querySelectorAll('[data-playlist-row-key]').length, 3);
  assert.equal(page.host.querySelector('[data-playlists-drag]'), null); assert.equal(page.host.querySelector('[data-playlists-move]'), null);
  assert.equal(h.named('Add to playlist', page.host).disabled, true);
  assert.equal(h.named('Create new playlist', page.host).disabled, true);
  assert.match(page.host.textContent, /Auto-updating after save; generated membership is locked/);
  assert.match(page.host.textContent, /2 local tracks excluded/);
  assert.doesNotMatch(page.host.innerHTML, /synthetic-only|data-src=|data-track-path=/);
  h.choose('Playback order', 'unplayed_first'); await h.settle();
  assert.deepEqual(page.host.querySelectorAll('[data-playlist-row-key]').map(node => node.dataset.playlistRowKey), [`item:${id(12)}`, `item:${id(11)}`, `item:${id(13)}`]);
  h.network(); h.click(h.named('Play', page.host)); await h.settle();
  assert.equal(h.calls.starts.length, 1); assert.equal(h.calls.starts[0].playlistItemId, id(12));
  h.click(h.named('Save as playlist', page.host)); await h.settle();
  assert.equal(saved.length, 1); assert.equal(saved[0].playlist_id, id(80));
  assert.equal(h.named('Save as playlist', page.host).disabled, true);
  assert.equal(page.host.querySelector('input[aria-label="Playlist title"]').disabled, true);
});

test('empty/refresh/error temporary states use shared statuses and disable playback without inventing tracks', async t => {
  const h = await nativeMixFixture(t), c = controller(h, {beginLibraryMix: async options => capture({scopeKey: options.scopeKey,
    entries: [], popularity_refresh_status: 'blocked', coverage: {selected_count: 0, excluded_count: 3}})});
  await c.prepare(recipe()); const page = h.mount('page', {runtime: h.mixRuntime(c), controller: c, onSaved() {}, onClose() {}});
  await h.settle(); assert.equal(h.named('Play', page.host).disabled, true);
  assert.equal(page.host.querySelectorAll('[data-playlist-row-key]').length, 0);
  assert.match(page.host.textContent, /No local songs with resolved Last.fm popularity/);
  assert.match(page.host.textContent, /refresh is unavailable/);
  assert.match(page.host.textContent, /3 local tracks excluded/);
});

test('uncertain save locks edits and exposes original-save recovery without a duplicate create', async t => {
  const h = await nativeMixFixture(t); let pending = false, saves = 0, retries = 0;
  const c = controller(h, {hasPendingPlaylistOperation: () => pending,
    createPlaylistFromSelection: async () => {saves++; pending = true; throw new Error('Lost response');},
    retryPlaylistOperation: async () => {retries++; pending = false; return receipt(id(90), {scopeKey: c.getSnapshot().scopeKey});}});
  await c.prepare(recipe()); const saved = [], page = h.mount('page', {runtime: h.mixRuntime(c), controller: c, onSaved: value => saved.push(value), onClose() {}});
  h.click(h.named('Save as playlist', page.host)); await h.settle();
  assert.equal(h.named('Save as playlist', page.host).disabled, true); assert.equal(page.host.querySelector('textarea').disabled, true);
  h.click(h.named('Check original save', page.host)); await h.settle();
  assert.equal(saves, 1); assert.equal(retries, 1); assert.equal(saved.length, 1);
});

test('saved order control reconciles session override on same-ID detail refresh and never rewrites saved default', async t => {
  const h = await nativeMixFixture(t), scopeKey = h.runtime.snapshot().scopeKey;
  const detail = {playlist_id: id(80), library_mix: mixMetadata(), allowed_actions: {can_play: true}, track_rows: []};
  let listener, mode = 'unplayed_first'; const changes = [];
  const projection = () => ({status: 'ready', data: {scopeKey, playlist_id: id(80), library_mix_order: mode}});
  const runtime = {...h.runtime, readPlayback: async () => projection(),
    subscribePlayback(options) {listener = options.onChange; return () => {listener = null;};},
    setLibraryMixOrder(value) {changes.push(value); mode = value.mode; listener?.(projection()); return true;}};
  const mounted = h.mount('order', {runtime, detail, scopeKey}); await h.settle();
  assert.ok(h.named('Playback order: Unplayed first', mounted.host));
  h.choose('Playback order', 'shuffle'); await h.settle();
  mounted.render({runtime, detail: {...detail, title: 'Refreshed saved title'}, scopeKey}); await h.settle();
  assert.equal(h.named('Playback order: Shuffle', mounted.host).disabled, false);
  assert.equal(detail.library_mix.playback_order, 'regular'); assert.equal(changes.length, 1);
  assert.deepEqual(plain(changes[0]), {scopeKey, playlist_id: id(80), mode: 'shuffle'});
});

test('saved order read cannot overwrite a newer playback notification or a newer playlist/scope', async t => {
  const h = await nativeMixFixture(t), wait = deferred(), scopeKey = h.runtime.snapshot().scopeKey;
  const detail = {playlist_id: id(80), library_mix: mixMetadata(), allowed_actions: {can_play: true}, track_rows: []};
  let listener; const projections = [];
  const runtime = {...h.runtime, readPlayback(options) {projections.push(options); return wait.promise;},
    subscribePlayback(options) {listener = options.onChange; return () => {};}, setLibraryMixOrder: () => true};
  const mounted = h.mount('order', {runtime, detail, scopeKey}); await h.settle();
  assert.equal(h.named('Playback order: In order', mounted.host).disabled, true);
  h.flush(() => listener({status: 'ready', data: {scopeKey, playlist_id: id(80), library_mix_order: 'shuffle'}}));
  wait.resolve({status: 'ready', data: {scopeKey, playlist_id: id(80), library_mix_order: 'regular'}}); await h.settle();
  assert.ok(h.named('Playback order: Shuffle', mounted.host));
  const oldListener = listener;
  mounted.render({runtime, detail: {...detail, playlist_id: id(81)}, scopeKey: 'new-scope'}); await h.settle();
  h.flush(() => oldListener({status: 'ready', data: {scopeKey, playlist_id: id(80), library_mix_order: 'unplayed_first'}}));
  assert.equal(h.named('Playback order: In order', mounted.host).disabled, true);
  assert.equal(projections[0].signal.aborted, true);
});

test('actual complete entry dispatches the global action into real setup, native draft history and shared preview', async t => {
  const h = await nativeMixFixture(t), navigation = h.installNavigation(), requests = [];
  h.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}};
  h.c.history.replaceState(h.c.history.state, '', '/?artist=Retained'); h.runtime.sync();
  await h.boot({readPlaylists: async () => ({playlist_sidebar: {items: []}, playlist_index: {playlists: []}}),
    beginLibraryMix: async options => {requests.push(options); return capture({scopeKey: options.scopeKey, library_mix: mixMetadata(options.recipe)});}});
  await h.settle(); assert.equal(typeof h.c.AlbumHavenPlaylistUI.openLibraryMix, 'function');
  const action = h.add('global-mix-action', 'button'); action.setAttribute('data-library-mix-open', '1'); action.disabled = true;
  h.flush(() => action.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true})));
  assert.equal(h.form.hidden, true); action.disabled = false;
  h.click(action); await h.settle(); assert.equal(h.form.hidden, false);
  assert.equal(h.c.AlbumHavenPlaylistUI.openLibraryMix(), false, 'repeat opening cannot replace an active setup');
  h.click(h.named('Create mix', h.form)); await h.settle();
  assert.equal(requests.length, 1); assert.equal(h.form.hidden, true);
  assert.ok(h.host.querySelector('main[aria-label="Temporary Library Mix"]'));
  assert.equal(h.host.querySelectorAll('[data-playlist-row-key]').length, 3);
  assert.equal(navigation.entries.length, 2); assert.equal(h.c.location.search, '?surface=playlists');
  assert.equal(h.c.history.state.playlistDraft.token, id(95));
  assert.doesNotMatch(JSON.stringify(h.c.history.state), /entry_refs|recipe|playback_order|source_ref/);
  h.flush(() => h.c.AlbumHavenPlaylistUI.configureProviders({})); await h.settle();
  assert.equal(h.c.history.state.playlistDraft, undefined);
  assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'), null);
  assert.equal(h.calls.starts.length, 0);
});

test('actual entry retires setup on native scope change or provider replacement without showing a late preview', async t => {
  const h = await nativeMixFixture(t), waiting = deferred(); let signal;
  h.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}}; h.runtime.sync();
  await h.boot({beginLibraryMix: options => {signal = options.signal; return waiting.promise;}});
  h.flush(() => h.c.AlbumHavenPlaylistUI.openLibraryMix()); await h.settle();
  h.click(h.named('Create mix', h.form)); await h.settle();
  const oldScope = h.runtime.snapshot().scopeKey;
  h.flush(() => {h.shell.dataset.nativeAccountId = '9'; h.runtime.sync();}); await h.settle();
  assert.equal(h.form.hidden, true); assert.equal(signal.aborted, true);
  waiting.resolve(capture({scopeKey: oldScope})); await h.settle();
  assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'), null);
  assert.equal(h.calls.starts.length, 0);
});

test('temporary header Play follows the actual shared table sort while Save retains captured membership order', async t => {
  const h = await nativeMixFixture(t), saved = [], c = controller(h, {createPlaylistFromSelection: async options => {
    saved.push(options); return receipt(options.request_key, {scopeKey: options.scopeKey});}});
  await c.prepare(recipe()); const page = h.mount('page', {runtime: h.mixRuntime(c), controller: c, onSaved() {}, onClose() {}}); await h.settle();
  h.click(page.host.querySelector('[data-cdt-sort="popularity_count"]')); await h.settle();
  assert.deepEqual(page.host.querySelectorAll('[data-playlist-row-key]').map(node => node.dataset.playlistRowKey), [`item:${id(13)}`, `item:${id(12)}`, `item:${id(11)}`]);
  h.network(); h.click(h.named('Play', page.host)); await h.settle();
  assert.deepEqual(JSON.parse(h.calls.requests[0].body).entry_refs, [id(13), id(12), id(11)]);
  assert.equal(h.calls.starts[0].playlistItemId, id(13));
  h.click(h.named('Save as playlist', page.host)); await h.settle();
  assert.deepEqual(plain(saved[0].entry_refs), [id(11), id(12), id(13)]);
});

test('saved Play mix receives real sorted and filtered table rows without changing dynamic membership', async t => {
  const h = await nativeMixFixture(t);
  h.state.view = payload({items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'},
    library_mix: mixMetadata({auto_update: true}), track_rows: [savedRow(1, {duration_seconds: 20}), savedRow(2, {duration_seconds: 0}), savedRow(3, {duration_seconds: 40})]});
  h.runtime.sync(); const scopeKey = h.runtime.snapshot().scopeKey;
  const c = h.api.createPlaylistController(); c.setScope(scopeKey); c.accept(h.runtime.snapshot().payload, id(80));
  const integrationProviders = {readPlayback: h.runtime.readPlayback, subscribePlayback: h.runtime.subscribePlayback, playbackIntent: h.runtime.playbackIntent};
  const page = h.mount('saved', {controller: c, integrationProviders, onSelect() {}, onPrepareDraft() {}}); await h.settle();
  assert.equal(h.named('Play mix', page.host).disabled, false);
  assert.equal(page.host.querySelector('[data-playlists-drag]'), null);
  h.click(page.host.querySelector('[data-cdt-sort="duration"]')); await h.settle();
  assert.deepEqual(page.host.querySelectorAll('[data-playlist-row-key]').map(node => node.dataset.playlistRowKey), [`item:${id(12)}`, `item:${id(11)}`, `item:${id(13)}`]);
  h.network({temporary: false}); h.click(h.named('Play mix', page.host)); await h.settle();
  assert.deepEqual(JSON.parse(h.calls.requests[0].body).item_refs, [id(12), id(11), id(13)]);
  assert.equal(h.calls.starts[0].playlistItemId, id(12));
  h.flush(() => c.filter({query: 'Track 1'})); await h.settle();
  assert.equal(page.host.querySelectorAll('[data-playlist-row-key]').length, 1);
  h.click(h.named('Play mix', page.host)); await h.settle();
  assert.deepEqual(JSON.parse(h.calls.requests.at(-1).body).item_refs, [id(11)]);
  assert.equal(c.getSnapshot().resource.data.detail.track_rows.length, 3);
  assert.equal(c.getSnapshot().resource.data.detail.library_mix.auto_update, true);
  assert.equal(h.state.view.playlist_detail.track_rows.length, 3);
});
