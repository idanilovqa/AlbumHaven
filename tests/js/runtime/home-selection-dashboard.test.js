const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {requireOwner, buttonNamed} = require('./native-home-harness.cjs');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends');
const helpers = import(pathToFileURL(path.join(source, 'selection-presentation.mjs')));
const query = {section: 'recent', account_ref: null, kind: 'artists', period: 'week'};
const origin = extra => ({source: 'activity', account_ref: null, kind: 'artists', period: 'week', ...extra});
const target = (kind = 'artist', ref = 'artist:one', extra = {}) => ({kind, ref,
  allowed_actions: {can_view_details: true}, origin: origin(), ...extra});
const row = (extra = {}) => ({id: 'row:one', kind: 'artist', title: 'Visible artist', source_readable: true,
  artist_target: target(), allowed_actions: {can_view_details: true}, ...extra});
const ready = rows => ({status: 'ready', data: {rows, snapshot_ref: null}});
const snapshot = (rows = [row()], extra = {}) => ({scopeKey: 'scope:one', selectedFriendRef: null,
  friends: {status: 'ready', data: {friends: [], requests: [], profile: null}}, members: {status: 'unavailable', data: null},
  recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
  activity: ready(rows), activityNavigation: {query: {account_ref: null, kind: 'artists', period: 'week'}},
  comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}, ...extra});

test('history keeps bounded opaque descriptors and independent kind, person, pane and scroll choices', async () => {
  const {selectionPresentation, selectionEntry, updateSelectionEntry} = await helpers;
  const selected = {rowId: 'row:one', targetKind: 'artist', targetRef: 'artist:one', snapshotRef: 'snapshot:one',
    allowed_actions: {can_view_details: true}, private_media_path: '/private/file'};
  let entries = updateSelectionEntry([], query, {selected, childAlbumRef: 'album:one', pane: 'album', expanded: 'artist',
    scroll: {source: 120, artist: 40, album: 90}, detail: {summary: 'Must not persist'}});
  const other = {...query, section: 'friends', account_ref: 'person:one', kind: 'albums'};
  entries = updateSelectionEntry(entries, other, {selected: {...selected, targetKind: 'album', targetRef: 'album:other'}, pane: 'album'});
  assert.equal(selectionEntry(entries, query).childAlbumRef, 'album:one');
  assert.deepEqual(selectionEntry(entries, query).scroll, {source: 120, artist: 40, album: 90});
  assert.equal(selectionEntry(entries, other).selected.targetRef, 'album:other');
  assert.doesNotMatch(JSON.stringify(entries), /private_media_path|allowed_actions|Must not persist/);
  assert.equal(selectionPresentation([...entries, ...entries]).length, 2);
  assert.equal(selectionPresentation(Array.from({length: 10}, (_, index) => ({query: {...other, account_ref: `person:${index}`}}))).length, 6);
  assert.deepEqual(selectionPresentation([{query: {...query, account_ref: 'forged'}}, {query: {...query, period: 'tomorrow'}}]), []);
});

test('stored selections resolve exact current row, kind, period, friend, origin and explicit grant', async () => {
  const {selectionDescriptor, resolveActivitySelection, activitySelectionTarget} = await helpers;
  const currentRow = row(), state = snapshot([currentRow]);
  const descriptor = selectionDescriptor(currentRow, currentRow.artist_target, state.activity);
  assert.equal(resolveActivitySelection(state, query, descriptor).row, currentRow);
  for (const changed of [row({id: 'other'}), row({source_readable: false}), row({artist_target: target('artist', 'artist:other')}),
    row({artist_target: target('artist', 'artist:one', {allowed_actions: {can_view_details: false}})}),
    row({artist_target: target('artist', 'artist:one', {origin: origin({period: 'month'})})})]) {
    assert.equal(resolveActivitySelection(snapshot([changed]), query, descriptor), null);
  }
  assert.equal(resolveActivitySelection(snapshot([currentRow, currentRow]), query, descriptor), null);
  assert.equal(resolveActivitySelection(state, {...query, period: 'month'}, descriptor), null);
  assert.equal(resolveActivitySelection(state, {...query, section: 'friends', account_ref: 'person:one'}, descriptor), null);
  const inherited = Object.create({can_view_details: true});
  assert.equal(activitySelectionTarget(row({artist_target: target('artist', 'artist:one', {allowed_actions: inherited})}), 'artist', query, state.activity), null);
  assert.equal(activitySelectionTarget(row({artist_target: null, detail_ref: null}), 'artist', query, state.activity), null,
    'a display label is not a catalog identity');
});

test('legacy explicit detail refs stay exact and supplied origins are preserved', async () => {
  const {activitySelectionTarget, selectionDescriptor, resolveActivitySelection} = await helpers;
  const legacy = row({artist_target: null, detail_ref: 'artist:legacy'}), state = snapshot([legacy]);
  const selected = activitySelectionTarget(legacy, 'artist', query, state.activity);
  assert.equal(selected.ref, 'artist:legacy'); assert.deepEqual(selected.origin, origin());
  const bound = row({artist_target: target('artist', 'artist:one', {origin: origin({snapshot_ref: 'snapshot:one'})})});
  state.activity = {status: 'ready', data: {rows: [bound], snapshot_ref: 'snapshot:one'}};
  const saved = selectionDescriptor(bound, bound.artist_target, state.activity);
  assert.deepEqual(resolveActivitySelection(state, query, saved).target.origin, bound.artist_target.origin);
  state.activity = {status: 'ready', data: {rows: [row({artist_target: target('artist', 'artist:one', {origin: origin({snapshot_ref: 'snapshot:two'})})})], snapshot_ref: 'snapshot:two'}};
  assert.equal(resolveActivitySelection(state, query, saved), null, 'same row and resource cannot cross a source snapshot');
});

test('listened Album resolution uses only the current ready Artist result and exact supplied child', async () => {
  const {resolveListenedAlbum} = await helpers;
  const artist = target(), album = target('album', 'album:one');
  const value = {status: 'ready', data: {kind: 'artist', ref: artist.ref, origin: artist.origin,
    listened_albums: [{id: 'child:one', detail_target: album}], discography: [{id: 'album:invented'}]}};
  assert.deepEqual(resolveListenedAlbum(value, artist, album.ref), album);
  for (const changed of [null, {...value, status: 'loading'}, {...value, status: 'denied'},
    {...value, data: {...value.data, origin: origin({period: 'month'})}},
    {...value, data: {...value.data, listened_albums: null}}, {...value, data: {...value.data, listened_albums: []}},
    {...value, data: {...value.data, listened_albums: [{detail_target: {...album, allowed_actions: {can_view_details: false}}}]}}]) {
    assert.equal(resolveListenedAlbum(changed, artist, album.ref), null);
  }
  assert.equal(resolveListenedAlbum(value, artist, 'album:invented'), null);
});

test('live source leases retire recreated Track targets but allow explicit query reentry', async () => {
  const {reconcileSelectionLease} = await helpers;
  const descriptor = {rowId: 'track:one', targetKind: 'album', targetRef: 'album:one', snapshotRef: null};
  const options = {queryKey: 'tracks:week', descriptor, source: ready([row()]), target: target('album', 'album:one'), runtime: {}, provider() {}};
  const held = reconcileSelectionLease(null, options);
  assert.equal(reconcileSelectionLease(held, options), held);
  for (const changed of [{source: ready([row()])}, {source: {status: 'loading', data: null}},
    {runtime: {}}, {provider() {}}, {target: target('album', 'album:other')}]) {
    const retired = reconcileSelectionLease(held, {...options, ...changed});
    assert.equal(retired.retired, true);
    assert.equal(reconcileSelectionLease(retired, options).retired, true, 'restoring old data is not another gesture');
    assert.equal(reconcileSelectionLease(retired, {...options, queryKey: 'artists:week'}).retired, false);
  }
  const pending = reconcileSelectionLease(null, {...options, source: {status: 'loading', data: null}, target: null});
  assert.equal(reconcileSelectionLease(pending, options).retired, false, 'history restoration can await its first current result');
});

test('revoked Friend grants retire inactive cached selections before later reauthorization', async () => {
  const {retireFriendSelections, updateSelectionEntry} = await helpers;
  const friendQuery = {...query, section: 'friends', account_ref: 'person:one'};
  const entries = updateSelectionEntry([], friendQuery, {selected: {rowId: 'row:one', targetKind: 'artist', targetRef: 'artist:one'}, childAlbumRef: 'album:one'});
  const allowed = {status: 'ready', data: {friends: [{account_ref: 'person:one', relationship: 'accepted', allowed_actions: {can_view_activity: true}}]}};
  assert.equal(retireFriendSelections(entries, allowed), entries);
  assert.equal(retireFriendSelections(entries, {status: 'loading'}), entries);
  for (const denied of [{status: 'denied'}, {status: 'ready', data: {friends: []}},
    {status: 'ready', data: {friends: [{account_ref: 'person:one', relationship: 'accepted', allowed_actions: {can_view_activity: false}}]}}]) {
    const retired = retireFriendSelections(entries, denied);
    assert.equal(retired[0].selected, null); assert.equal(retired[0].childAlbumRef, null);
    assert.equal(retireFriendSelections(retired, allowed)[0].selected, null);
  }
});

// Real native mounts and canonical DOM controls. Only provider/bridge boundaries
// are controlled, exactly as in the approved native app fixture.
async function dashboardFixture(t, initial = snapshot(), presentation = {kind: 'artists'}) {
  const {fixture, load, deferred, settle, plain} = require('./home-friends-native-app-fixture.cjs');
  const env = fixture(t), {mountHomeFriendsView} = await load('app.mjs');
  vm.runInContext(require('node:fs').readFileSync(path.join(source, '../runtime/home-recent.js'), 'utf8'), env.context);
  const recent = requireOwner(env, 'HomeRecent');
  const reads = [], leases = [], saves = [], navigation = [];
  let state = initial;
  const listeners = new Set(), subscriptions = [];
  const publication = {count: 0, deliveries: 0};
  const h = {shell: {section: 'recent', friendRef: null, presentation}, env, reads, leases, saves, navigation, listeners, subscriptions, publication};
  // Assignment is the controlled provider publication seam, not an inert store.
  // Publish the complete current snapshot synchronously to each live subscriber.
  Object.defineProperty(h, 'state', {get: () => state, set(next) {
    if (Object.is(next, state)) return;
    state = next; publication.count++;
    const expected = listeners.size, before = publication.deliveries;
    for (const listener of listeners) {publication.deliveries++; listener();}
    assert.equal(publication.deliveries - before, expected, 'each live subscriber receives the complete publication exactly once');
  }});
  h.readDetail = request => {const pending = deferred(); reads.push({request, ...pending}); return pending.promise;};
  h.controller = {getSnapshot: () => h.state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A snapshot listener is required.');
      assert.equal(listeners.has(listener), false, 'native owner acquires one distinct subscription');
      listeners.add(listener); const entry = {listener, releases: 0}; subscriptions.push(entry);
      return () => {entry.releases++; assert.equal(entry.releases, 1, 'each acquired owner subscription retires exactly once'); assert.equal(listeners.delete(listener), true);};
    }, selectFriend: () => true, loadActivity() {}, loadFriends() {}, loadRecent() {}, selectProfile: () => true, loadProfile() {}};
  h.runtime = {...env.runtime, snapshot: () => ({scopeKey: h.state.scopeKey}),
    artistInfoHtml: value => env.context.buildArtistInfoOverlayHtml(value),
    mountRecent: (host, options) => recent.mount(host, options),
    savePresentation: value => saves.push(plain(value)), navigate: value => navigation.push(value),
    mountResourceSelection(node, options) {const lease = {node, options, disposed: false}; leases.push(lease);
      options.onState('unavailable'); return {dispose() {assert.equal(lease.disposed, false); lease.disposed = true;}};},
  };
  let owner, mountedRuntime;
  h.publish = () => {
    const props = {runtime: h.runtime, controller: h.controller, state: h.state, shell: h.shell, readDetail: h.readDetail};
    if (!owner || mountedRuntime !== h.runtime) {
      owner?.dispose(); assert.equal(listeners.size, 0, 'all previous native subscriptions retire before replacement mount');
      mountedRuntime = h.runtime; owner = mountHomeFriendsView(env.host, props);
    } else owner.update(props);
    assert.equal(listeners.size, env.host.querySelectorAll('[data-home-friends-directory]').length, 'exactly one subscription per live directory, including hidden owned directories');
    return env.host;
  };
  h.render = async () => {h.publish(); await settle(); env.drain(); await settle(); return env.host;};
  h.dispose = () => {
    owner?.dispose(); owner = null;
    assert.equal(listeners.size, 0, 'native owner cleanup removes every controller subscription');
    assert.ok(subscriptions.every(entry => entry.releases === 1), 'all acquired subscriptions released exactly once');
    const before = publication.deliveries; h.state = {...h.state};
    assert.equal(publication.deliveries, before, 'post-disposal publication reaches no retired owner');
    env.host.remove();
  }; t.after(h.dispose);
  h.page = env.host;
  h.widget = key => h.page.querySelector(`[data-home-widget="${key}"]`);
  h.keys = () => h.page.querySelectorAll('[data-home-widget]').filter(node => !node.hidden).map(node => node.dataset.homeWidget);
  h.detail = kind => leases.filter(lease => !lease.disposed && lease.options.selection.kind === kind).at(-1);
  h.read = kind => reads.filter(read => read.request.kind === kind && !read.request.signal.aborted).at(-1);
  h.tab = (id, value) => {const node = h.page.querySelector(`#${id} [data-in-page-tab="${value}"]`); assert.ok(node, `${id}: ${value}`); env.click(node);};
  h.rowControl = id => h.page.querySelector(`[data-home-artist-select="${id}"]`) || h.page.querySelector(`[data-home-activity-row="${id}"]`);
  h.choose = (id = 'row:one', toggle = false) => {const node = h.rowControl(id); assert.ok(node, `current row ${id}`); h.click(node, toggle);};
  h.click = (node, toggle = false) => {assert.ok(node); const event = new env.c.Event('click', {bubbles: true}); Object.assign(event, {detail: 1, ctrlKey: toggle, metaKey: false, altKey: false, shiftKey: false}); node.dispatchEvent(event);};
  h.childControl = id => h.page.querySelector(`[data-listened-album-id="${id}"] [data-gallery-card-intent="select"]`);
  h.complete = async (read, children = [], title) => {assert.ok(read, 'actual detail provider request'); read.resolve({status: 'ready', data: {
    kind: read.request.kind, ref: read.request.ref, origin: read.request.origin, title: title || read.request.ref, metadata_state: 'current',
    ...(read.request.kind === 'artist' ? {discography: [], listened_albums: children.map((detail_target, i) => ({id: `child:${i}`, title: detail_target.ref, detail_target}))} : {tracks: []}),
  }}); await settle(); env.drain(); await settle();};
  h.expand = key => env.click(buttonNamed(h.widget(key), /full size/i));
  h.expanded = () => h.page.querySelector('[data-dashboard]').getAttribute('data-dashboard-expanded-key');
  return h;
}

test('deliberate Artist and supplied child Album selection retains three native panes and separate phone tabs', async t => {
  const h = await dashboardFixture(t); await h.render();
  assert.deepEqual(h.keys(), ['recent']); assert.equal(h.detail('artist'), undefined);
  h.choose(); await h.render();
  const artist = h.detail('artist'), read = h.read('artist'), album = target('album', 'album:one');
  assert.ok(artist); assert.equal(h.page.dataset.homePane, 'artist');
  await h.complete(read, [album]);
  const child = h.childControl('child:0'); assert.ok(child); assert.equal(h.widget('recent').contains(child), true, 'Artist detail shares its current read with the source-list outlet');
  h.click(child); await h.render();
  assert.deepEqual(h.keys(), ['recent', 'artist', 'album']);
  assert.equal(h.detail('artist'), artist, 'opening an Album does not replace the Artist controller');
  assert.equal(h.read('artist'), read); assert.equal(h.detail('album').options.selection.ref, 'album:one');
  assert.equal(h.page.dataset.homePane, 'album');
  assert.deepEqual(h.page.querySelectorAll('#home-selected-sections [data-in-page-tab]').map(node => node.dataset.inPageTab), ['recent', 'artist', 'album']);
  h.expand('artist'); await h.render(); assert.equal(h.expanded(), 'artist');
  assert.deepEqual(h.keys(), ['recent', 'artist', 'album']);
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /listened_albums|allowed_actions|Visible artist/);
});

test('kind roundtrips restore opaque identity and expansion only against the current source', async t => {
  const h = await dashboardFixture(t); await h.render(); h.choose(); await h.render(); h.expand('artist'); await h.render();
  h.tab('home-recent-kinds', 'tracks'); await h.render(); assert.equal(h.detail('artist'), undefined);
  h.tab('home-recent-kinds', 'artists'); await h.render(); assert.equal(h.detail('artist').options.selection.ref, 'artist:one');
  assert.equal(h.expanded(), 'artist');
});

test('source removal permanently retires selection before an identically recreated row can return', async t => {
  const h = await dashboardFixture(t); await h.render(); h.choose(); await h.render();
  const stale = h.detail('artist'), pending = h.read('artist'), staleRow = h.rowControl('row:one');
  h.state = {...h.state, activity: ready([])}; h.click(staleRow); h.publish();
  assert.equal(h.detail('artist'), undefined, 'revoked synchronously before queued work'); await h.render();
  assert.equal(h.detail('artist'), undefined); assert.equal(stale.disposed, true); assert.equal(pending.request.signal.aborted, true);
  await h.complete(pending); stale.options.onState('ready'); stale.options.onError(new Error('Stale Artist error'));
  h.state = {...h.state, activity: ready([row()])}; await h.render(); assert.equal(h.detail('artist'), undefined);
  h.click(staleRow); await h.render(); assert.equal(h.detail('artist'), undefined);
  h.choose(); await h.render(); assert.ok(h.detail('artist'), 'a fresh deliberate selection can use the recreated current row');
});

// Category B substitution: the former test injected a private React callback.
// Domain revocation and native callback retirement are exercised separately;
// no ready-state refresh event exists in either delivered resource owner.
test('current Artist refresh revokes a held child and old callbacks cannot recreate it', async t => {
  const {resolveListenedAlbum} = await helpers;
  const {fixture, load} = require('./home-friends-native-app-fixture.cjs');
  const h = fixture(t), {mountDetailProjectionPanel} = await load('detail-projection-ui.mjs');
  const {normalizeDetailResult} = await load('detail-projection.mjs');
  const artist = target(), album = target('album', 'album:one'), chosen = [];
  const value = albums => normalizeDetailResult({kind: 'artist', ref: artist.ref, origin: artist.origin, title: 'Artist', discography: [], listened_albums: albums}, artist);
  const supplied = value([{id: 'child:one', detail_target: album}]), refreshed = value([]);
  const props = {selection: artist, value: supplied, onSelectAlbum: selected => chosen.push(selected)};
  const owner = h.own(mountDetailProjectionPanel(h.host, h.runtime, props));
  const staleChild = h.host.querySelector('[data-gallery-card-intent="select"]'); assert.ok(staleChild);
  h.click(staleChild); assert.deepEqual(chosen, [album]);
  assert.deepEqual(resolveListenedAlbum(supplied, artist, album.ref), album);
  owner.update({...props, value: refreshed});
  assert.equal(resolveListenedAlbum(refreshed, artist, album.ref), null);
  assert.match(h.host.textContent, /No albums listened to/); assert.equal(h.host.dataset.detailKind, 'artist');
  h.click(staleChild); assert.equal(chosen.length, 1);
  assert.equal(resolveListenedAlbum(refreshed, artist, album.ref), null);
});

test('changed period, runtime, detail provider and account reject stale detail and row callbacks', async t => {
  for (const change of ['period', 'runtime', 'provider', 'scope']) {
    const h = await dashboardFixture(t); await h.render(); h.choose(); await h.render();
    const old = h.detail('artist'), pending = h.read('artist'), choose = h.rowControl('row:one');
    if (change === 'period') {h.env.click(buttonNamed(h.widget('recent'), /^Period:/)); h.env.click(buttonNamed(h.env.document, /Last month/));}
    if (change === 'runtime') h.runtime = {...h.runtime};
    if (change === 'provider') h.readDetail = () => new Promise(() => {});
    if (change === 'scope') h.state = {...h.state, scopeKey: 'scope:two', activity: ready([])};
    await h.render(); const album = target('album', 'album:old');
    await h.complete(pending, [album]); old.options.onState('ready'); old.options.onError(new Error('Stale detail'));
    if (!choose.isConnected) h.click(choose); // A retained current node is a new deliberate gesture, not an obsolete callback.
    await h.render();
    assert.equal(h.detail('album'), undefined, change);
    assert.equal(h.saves.at(-1).selectionPresentation.some(entry => entry.childAlbumRef === album.ref), false, change);
    assert.equal(old.disposed, true, change); assert.equal(pending.request.signal.aborted, true, change);
  }
});

test('Track target selection stays separate from playback and retires on replacement source', async t => {
  const album = target('album', 'album:one', {origin: origin({kind: 'tracks'})});
  const track = row({id: 'track:one', kind: 'track', artist_target: null, album_target: album});
  const state = snapshot([track], {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = await dashboardFixture(t, state, {kind: 'tracks'}); h.runtime.trackIntent = () => {throw new Error('Selection cannot invoke playback');};
  await h.render(); h.choose(track.id); await h.render(); assert.equal(h.detail('album').options.selection.ref, album.ref);
  assert.equal(h.page.querySelector('#home-recent-kinds [aria-selected="true"]').dataset.inPageTab, 'tracks');
  h.state = {...h.state, activity: ready([{...track}])}; h.publish(); assert.equal(h.detail('album'), undefined); await h.render(); assert.equal(h.detail('album'), undefined);
  await h.render(); assert.equal(h.detail('album'), undefined);
});

test('own-week Recent keeps its guarded native selection seam and rejects removed callback rows', async t => {
  const recentRow = {album_ref: 'album:local', row_kind: 'local_album', local_match_state: 'matched_local', allowed_actions: {can_open_album: true, can_view_details: true}, listen_event_count: 2};
  const state = snapshot([], {recent: {status: 'ready', data: {recent_local_albums: [recentRow], recent_not_local_albums: []}}});
  const h = await dashboardFixture(t, state, {kind: 'albums'}); h.readDetail = undefined;
  h.runtime.albumDetailSelection = (ref, scopeKey) => scopeKey === h.state.scopeKey && h.state.recent.data?.recent_local_albums.includes(recentRow) && ref === recentRow.album_ref ? {kind: 'album', ref, allowed_actions: {can_view_details: true}} : null;
  await h.render(); const recent = h.widget('recent'), control = recent.querySelector('[data-gallery-card-intent="select"]'); assert.ok(control);
  assert.equal(control.getAttribute('aria-pressed'), 'false');
  const ref = control.getAttribute('data-gallery-card-ref'); control.setAttribute('data-gallery-card-ref', 'album:invented'); h.click(control); await h.render(); assert.equal(h.detail('album'), undefined); control.setAttribute('data-gallery-card-ref', ref);
  h.click(control); await h.render(); assert.equal(h.detail('album').options.selection.ref, recentRow.album_ref); assert.equal(h.detail('album').options.selection.origin.source, 'recent');
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}}}; h.click(control); await h.render(); assert.equal(h.detail('album'), undefined);
  h.state = {...h.state, recent: state.recent}; await h.render(); assert.equal(h.saves.at(-1).selectedAlbum, null);
});

// Category B: native shared Button retains the DOM node and uses current props.
// The obsolete private React callback identity is not a native event surface;
// activate the retained live control to prove current Album ownership instead.
test('a previous child Album cannot close or report errors on the newly selected Album', async t => {
  const h = await dashboardFixture(t); await h.render(); h.choose(); await h.render();
  const first = target('album', 'album:first'), second = target('album', 'album:second');
  await h.complete(h.read('artist'), [first, second]); h.click(h.childControl('child:0')); await h.render();
  const oldAlbum = h.detail('album'), oldRead = h.read('album'), oldClose = buttonNamed(h.widget('album'), /Close Album Info/);
  h.click(h.childControl('child:1')); await h.render();
  oldAlbum.options.onError(new Error('Stale album error')); oldAlbum.options.onState('ready');
  assert.equal(oldAlbum.disposed, true); assert.equal(h.detail('album').options.selection.ref, second.ref);
  assert.doesNotMatch(h.page.textContent, /Stale album error/);
  assert.equal(buttonNamed(h.widget('album'), /Close Album Info/), oldClose, 'native control retains identity and current callback; old React callback is not an event surface');
  const currentAlbum = h.detail('album'), parentArtist = h.detail('artist');
  h.click(oldClose); await h.render();
  assert.equal(currentAlbum.disposed, true, 'retained live Close control closes the current second Album');
  assert.equal(h.detail('album'), undefined);
  assert.equal(h.detail('artist'), parentArtist, 'closing the child retains its parent Artist owner');
  assert.deepEqual(h.keys(), ['recent', 'artist']); assert.equal(h.page.dataset.homePane, 'artist');
  assert.equal(h.saves.at(-1).selectionPresentation.some(entry => entry.childAlbumRef), false);
  await h.complete(oldRead, [], 'Retired first Album');
  oldAlbum.options.onState('ready'); oldAlbum.options.onError(new Error('Stale album error'));
  h.click(oldClose); await h.render();
  assert.equal(h.detail('album'), undefined, 'old Album completion and retired Close cannot restore the old Album');
  assert.equal(h.detail('artist'), parentArtist);
  assert.doesNotMatch(h.page.textContent, /Stale album error|Retired first Album/);
});

test('cold history restoration waits for current source and Artist results without saving either DTO', async t => {
  const unavailable = {status: 'unavailable', data: null}, album = target('album', 'album:saved');
  const saved = {kind: 'artists', selectionPresentation: [{query, selected: {rowId: 'row:one', targetKind: 'artist', targetRef: 'artist:one', snapshotRef: null}, childAlbumRef: album.ref, pane: 'album', expanded: 'artist', scroll: {source: 40, artist: 60, album: 80}}]};
  const h = await dashboardFixture(t, snapshot([], {activity: unavailable, friends: unavailable, recent: unavailable}), saved); await h.render();
  assert.equal(h.detail('artist'), undefined); assert.equal(h.saves.at(-1).selectionPresentation[0].childAlbumRef, album.ref);
  h.state = snapshot(); await h.render(); assert.ok(h.detail('artist')); assert.equal(h.detail('album'), undefined);
  // The actual controller begins unavailable/loading; neither revokes cold history.
  assert.equal(h.saves.at(-1).selectionPresentation[0].childAlbumRef, album.ref, 'initial unavailable is not a revoked grant');
  await h.complete(h.read('artist'), [album]); await h.render(); assert.equal(h.detail('album').options.selection.ref, album.ref);
  assert.equal(h.widget('artist').querySelector('.home-friends__widget-body').scrollTop, 60);
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /listened_albums|allowed_actions/);
});

test('saved native Recent selection waits through initial unavailability and retires an explicit open denial', async t => {
  const recentRow = {album_ref: 'album:local', row_kind: 'local_album', local_match_state: 'matched_local', allowed_actions: {can_open_album: true, can_view_details: true}};
  const h = await dashboardFixture(t, snapshot([], {recent: {status: 'unavailable', data: null}}), {kind: 'albums', selectedAlbum: recentRow.album_ref});
  await h.render(); assert.equal(h.saves.at(-1).selectedAlbum, recentRow.album_ref); assert.equal(h.detail('album'), undefined);
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [recentRow], recent_not_local_albums: []}}}; await h.render(); assert.equal(h.detail('album').options.selection.ref, recentRow.album_ref);
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [{...recentRow, allowed_actions: {can_open_album: false}}], recent_not_local_albums: []}}};
  await h.render(); assert.equal(h.saves.at(-1).selectedAlbum, null); assert.equal(h.detail('album'), undefined);
});

test('Friend revocation hides both private activity and selected panes before effects and cannot revive them', async t => {
  const friend = {account_ref: 'person:one', relationship: 'accepted', display_name: 'Friend', allowed_actions: {can_view_activity: true}};
  const friendRow = row({artist_target: target('artist', 'artist:one', {origin: origin({account_ref: friend.account_ref})})});
  const friends = {status: 'ready', data: {friends: [friend], requests: [], profile: null}};
  const h = await dashboardFixture(t, snapshot([friendRow], {friends, selectedFriendRef: friend.account_ref, activityNavigation: {query: {account_ref: friend.account_ref, kind: 'artists', period: 'week'}}}), {kind: 'artists', friendKind: 'artists'});
  h.shell = {...h.shell, section: 'friends', friendRef: friend.account_ref}; await h.render(); h.choose(); await h.render();
  assert.equal(h.detail('artist').options.selection.origin.account_ref, friend.account_ref);
  h.state = {...h.state, friends: {status: 'ready', data: {...friends.data, friends: [{...friend, allowed_actions: {can_view_activity: false}}]}}};
  h.publish(); assert.equal(h.rowControl('row:one'), null); assert.equal(h.detail('artist'), undefined); await h.render(); assert.doesNotMatch(h.widget('friends').textContent, /Visible artist/);
  h.state = {...h.state, friends}; await h.render(); assert.ok(h.rowControl('row:one')); assert.equal(h.detail('artist'), undefined);
});

test('track selection resolves Album and Artist consensus independently using canonical identities', async () => {
  const {resolveActivityTrackSelection} = await helpers;
  const q = {...query, kind: 'tracks'}, o = {...origin(), kind: 'tracks'};
  const track = (id, album, artist) => row({id, kind: 'track', availability: id === 'a' ? 'missing' : 'local',
    album_target: target('album', id, {origin: o, identity_ref: album}),
    artist_target: target('artist', id, {origin: o, identity_ref: artist})});
  const rows = [track('a', 'album:1', 'artist:1'), track('b', 'album:2', 'artist:1'), track('c', 'album:1', 'artist:2')];
  const state = snapshot(rows, {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const selected = ids => resolveActivityTrackSelection(state, q, {rowIds: ids, snapshotRef: null});
  assert.equal(selected(['a', 'b']).album, null);
  assert.equal(selected(['a', 'b']).artist.identity_ref, 'artist:1');
  assert.equal(selected(['a', 'c']).album.identity_ref, 'album:1');
  assert.equal(selected(['a', 'c']).artist, null);
  assert.deepEqual(selected(['b', 'a']).rows.map(row => row.id), ['a', 'b']);
  assert.equal(selected(['a', 'a']), null); assert.equal(selected(['stale']), null);
  assert.equal(resolveActivityTrackSelection(state, q, {rowIds: ['a'], snapshotRef: 'wrong'}), null);
  rows[0].source_readable = false; assert.equal(selected(['a']), null);
});

test('Recent track sets restore widgets with independent mixed panes and retire on source replacement', async t => {
  const o = origin({kind: 'tracks'});
  const tracks = ['a', 'b'].map((id, index) => row({id, kind: 'track', availability: index ? 'local' : 'missing', album_target: target('album', id, {origin: o, identity_ref: `album:${index}`}), artist_target: target('artist', id, {origin: o, identity_ref: 'artist:common'})}));
  const state = snapshot(tracks, {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = await dashboardFixture(t, state, {kind: 'tracks'}); h.runtime.trackIntent = () => {throw new Error('Selection must not play');};
  await h.render(); assert.deepEqual(h.keys(), ['recent']); h.choose('a'); h.choose('b', true); await h.render();
  assert.deepEqual(h.keys(), ['recent', 'artist', 'album']); assert.equal(h.expanded(), null); assert.equal(h.detail('album'), undefined);
  assert.equal(h.detail('artist').options.selection.identity_ref, 'artist:common'); assert.equal(h.page.dataset.homePane, 'recent');
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /artist:common|allowed_actions|Visible artist/);
  const stale = h.rowControl('a'); h.state = {...h.state, activity: ready(tracks.map(row => ({...row})))};
  await h.render(); assert.deepEqual(h.keys(), ['recent']);
  if (!stale.isConnected) h.click(stale);
  await h.render(); assert.deepEqual(h.keys(), ['recent']);
  assert.equal(h.saves.at(-1).selectionPresentation.some(entry => entry.tracks?.rowIds?.length), false, 'source replacement retired the old row-set authority');
  h.choose('a'); await h.render(); assert.deepEqual(h.keys(), ['recent', 'artist', 'album']);
});

test('Queue is nested only in own Home and suppresses gallery controls and selected detail panes', async t => {
  const h = await dashboardFixture(t, snapshot([]), {kind: 'tracks'}); await h.render();
  assert.ok(h.page.querySelector('#home-recent-sections [data-in-page-tab="queue"]'));
  h.tab('home-recent-sections', 'queue'); await h.render();
  assert.ok(h.page.querySelector('[aria-label="Queued tracks"]')); assert.equal(h.page.querySelector('[data-home-activity-row]'), null);
  assert.equal(buttonNamed(h.widget('recent'), /^Period:/, false), null);
  assert.equal(h.page.querySelector('.home-friends__catalog-controls'), null);
  assert.equal(h.page.querySelector('#home-recent-kinds'), null, 'Queue owns no gallery-kind controls');
  assert.deepEqual(h.keys(), ['recent']);
  h.shell = {...h.shell, section: 'friends'}; await h.render(); assert.equal(h.widget('recent').hidden, true);
});

test('review: track Artist selection can open its admitted child Album', async t => {
  const o = origin({kind: 'tracks'}), artist = target('artist', 'row:a', {origin: o, identity_ref: 'artist:a'});
  const state = snapshot([row({id: 'a', kind: 'track', artist_target: artist, album_target: null})], {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = await dashboardFixture(t, state, {kind: 'tracks'}); await h.render(); h.choose('a'); await h.render();
  const child = target('album', 'child:album', {origin: o}); await h.complete(h.read('artist'), [child]);
  h.click(h.childControl('child:0')); await h.render(); assert.equal(h.detail('album')?.options.selection.ref, child.ref);
});

test('review: deliberate inspect of the same selected track restores Recent widgets', async t => {
  const o = origin({kind: 'tracks'});
  const h = await dashboardFixture(t, snapshot([row({id: 'a', kind: 'track', artist_target: target('artist', 'a', {origin: o})})], {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}}), {kind: 'tracks'});
  await h.render(); h.choose('a'); await h.render(); h.expand('recent'); await h.render(); assert.equal(h.expanded(), 'recent');
  h.choose('a'); await h.render(); assert.equal(h.expanded(), null);
});

test('Queue occurrences use the existing three-widget dashboard and preserve deactivated selection', async t => {
  const queueListeners = new Set(), detailListeners = new Set();
  let queue = {enabled: true, revision: 1, entries: [{id: 'queue:1', sourceReadable: true, title: 'Track'}]}, selected = {selectedIds: [], album: null, artist: null, status: 'empty'}, disposed = 0;
  const api = {getSnapshot: () => queue, subscribe(fn) {queueListeners.add(fn); return () => queueListeners.delete(fn);}};
  const origin = {source: 'queue', occurrence_refs: ['queue:1']};
  const adapter = {getSnapshot: () => selected, subscribe(fn) {detailListeners.add(fn); return () => detailListeners.delete(fn);}, readAlbumProjection: async () => ({status: 'unavailable'}), dispose() {disposed++;},
    select(ids) {selected = {selectedIds: ids, status: 'ready', album: target('album', 'queue:album', {origin}), artist: target('artist', 'queue:artist', {origin})}; detailListeners.forEach(fn => fn()); return Promise.resolve(selected);},
    clear() {selected = {selectedIds: [], album: null, artist: null, status: 'empty'}; detailListeners.forEach(fn => fn());}};
  const h = await dashboardFixture(t, snapshot([]), {kind: 'tracks'}); h.runtime.explicitQueue = () => api; h.runtime.createQueueResourceSelection = () => adapter;
  await h.render(); h.tab('home-recent-sections', 'queue'); await h.render(); h.click(h.page.querySelector('[data-queue-row="queue:1"]')); await h.render();
  assert.deepEqual(h.keys(), ['recent', 'artist', 'album']); assert.equal(h.detail('album').options.selection.ref, 'queue:album'); assert.equal(h.detail('artist').options.selection.ref, 'queue:artist');
  h.expand('recent'); await h.render(); h.click(h.page.querySelector('[data-queue-row="queue:1"]')); await h.render(); assert.equal(h.expanded(), null);
  const retiredAlbum = h.detail('album'), retiredSelect = h.page.querySelector('[data-queue-row="queue:1"]');
  queue = {...queue, enabled: false, revision: 2}; queueListeners.forEach(fn => fn()); await h.render(); assert.deepEqual(h.keys(), ['recent', 'artist', 'album']);
  h.shell = {...h.shell, section: 'friends'}; await h.render();
  assert.equal(h.page.querySelector('[data-queue-row="queue:1"]'), null); assert.equal(h.detail('album'), undefined); assert.equal(disposed, 1);
  const before = selected; retiredAlbum.options.onError(new Error('Retired detail must not report')); h.click(retiredSelect);
  assert.equal(selected, before, 'retired Queue callbacks cannot recreate selection after navigation');
  await h.render(); assert.doesNotMatch(h.page.textContent, /Retired detail must not report/);
});

// Additive fixture-contract check: actual directory rendering observes publication
// before the parent Home view receives its explicit update.
test('snapshot publication updates native Friends authority once and retires all subscriptions', async t => {
  const friend = {account_ref: 'person:publication', relationship: 'accepted', display_name: 'Publication Friend', allowed_actions: {can_view_activity: true}};
  const friends = {status: 'ready', data: {friends: [friend], requests: [], profile: null}};
  const h = await dashboardFixture(t, snapshot([], {friends})); await h.render();
  const directory = h.page.querySelector('[data-home-friends-directory]'); assert.ok(directory);
  assert.equal(h.listeners.size, 1); assert.equal(h.subscriptions.length, 1);
  assert.match(directory.textContent, /Publication Friend/);
  const before = h.publication.deliveries;
  h.state = {...h.state, friends: {status: 'ready', data: {...friends.data, friends: []}}};
  assert.equal(h.controller.getSnapshot(), h.state);
  assert.equal(h.publication.deliveries, before + 1);
  assert.doesNotMatch(directory.textContent, /Publication Friend/, 'subscription renders current authority before parent update');
  await h.render(); assert.equal(h.listeners.size, 1); assert.equal(h.subscriptions.length, 1);
  h.dispose(); assert.equal(h.listeners.size, 0); assert.equal(h.subscriptions[0].releases, 1);
});
