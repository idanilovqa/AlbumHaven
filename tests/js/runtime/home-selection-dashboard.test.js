const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, requireOwner, buttonNamed} = require('./native-home-harness.cjs');

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

let bundled;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(element => element.type?.name === name);
const detail = (tree, kind) => elements(tree).find(element => element.type?.name === 'ResourceDetail' && element.props.selection?.kind === kind);
const widgetKeys = tree => elements(tree).filter(element => element.props['data-home-widget'] && !element.props.hidden).map(element => element.props['data-home-widget']);

// This bounded hook/DOM driver runs Home's real effects and native Dashboard.
// Detail controllers are handed ready/current results explicitly at their
// public callback seam. It does not claim React hydration or painted geometry.
function dashboardFixture(initial = snapshot(), presentation = {kind: 'artists'}) {
  bundled ||= buildSync({entryPoints: [path.join(source, 'app.jsx')], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const env = createNativeHomeRuntime({dashboard: true}), native = requireOwner(env, 'Dashboard');
  const page = env.document.createElement('div'), dashboard = env.document.createElement('div');
  page.append(dashboard); env.document.body.append(page);
  const nodes = new Map(), slots = [], saves = [], mounts = [], navigation = [];
  let cursor = 0, effects = [], dirty = false, tree;
  const h = {state: initial, shell: {section: 'recent', friendRef: null, presentation}, readDetail() {}};
  const controller = {getSnapshot: () => h.state, selectFriend: () => true, loadActivity() {}, loadFriends() {}, loadRecent() {}, selectProfile: () => true, loadProfile() {}};
  const runtime = {mountDashboard(root, options) {mounts.push(Array.from(options.widgets, widget => widget.key)); return native.mount(root, options);},
    savePresentation(value) {saves.push(value);}, navigate(value) {navigation.push(value);}};
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const effect = (run, deps) => {const index = cursor++, old = slots[index];
    if (changed(old, deps)) effects.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: run()};});};
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(value) {const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) {slots[index].value = value; dirty = true;}}];},
    useMemo(factory, deps) {const index = cursor++, old = slots[index];
      if (changed(old, deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useEffect: effect, useLayoutEffect: effect,
  };
  const fixture = {exports: {}};
  vm.runInNewContext(bundled, {module: fixture, exports: fixture.exports, console, document: env.document,
    clearTimeout, setTimeout, require: name => name === 'react' ? hooks : require(name)});
  function scoped(node) {
    const original = node.querySelector.bind(node);
    node.querySelector = selector => selector.startsWith(':scope > ')
      ? node.children.find(child => child.matches(selector.slice(9))) ?? null : original(selector);
    return node;
  }
  function connect() {
    const current = new Set();
    tree.props.ref.current = page;
    for (const element of elements(tree)) {
      if (element.props.className === 'home-friends__dashboard') element.props.ref.current = dashboard;
      const key = element.props['data-home-widget'];
      if (!key) continue;
      current.add(key);
      if (!nodes.has(key)) {
        const node = scoped(env.document.createElement('section'));
        node.innerHTML = '<header class="gallery-bar"><div class="gallery-bar__actions"></div></header><div class="home-friends__widget-body"><div class="home-friends__scroll"></div></div>';
        nodes.set(key, node); dashboard.append(node);
      }
      element.props.ref.current = nodes.get(key); nodes.get(key).hidden = element.props.hidden === true;
    }
    for (const [key, node] of nodes) if (!current.has(key)) {node.remove(); nodes.delete(key);}
  }
  h.render = ({beforeEffects = false} = {}) => {
    let attempts = 0;
    do {
      assert.ok(++attempts < 15, 'the source lifecycle must settle');
      cursor = 0; effects = []; dirty = false;
      tree = fixture.exports.HomeFriendsView({runtime: h.runtime, controller, state: h.state, shell: h.shell, readDetail: h.readDetail});
      connect();
      if (beforeEffects) return tree;
      for (const run of effects) run();
    } while (dirty);
    return tree;
  };
  h.dispose = () => {for (const slot of slots) slot?.cleanup?.(); page.remove();};
  return Object.assign(h, {runtime, controller, env, page, dashboard, nodes, saves, mounts, navigation});
}

test('deliberate Artist and supplied child Album selection retains three native panes and separate phone tabs', t => {
  const h = dashboardFixture(); t.after(h.dispose);
  let tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent']); assert.equal(detail(tree, 'artist'), undefined);
  const outlet = h.env.document.createElement('div'); h.nodes.get('recent').querySelector('.home-friends__scroll').append(outlet);
  component(tree, 'ActivityPanel').props.listenedAlbumsRef(outlet); tree = h.render();
  component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist');
  tree = h.render();
  const artist = detail(tree, 'artist'), album = target('album', 'album:one');
  assert.ok(artist); assert.equal(tree.props['data-home-pane'], 'artist');
  assert.equal(artist.props.listenedAlbumsHost, outlet, 'Artist detail shares its current read with the source-list outlet');
  const supplied = {status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(), listened_albums: [{id: 'child:one', detail_target: album}]}};
  artist.props.onDetailChange(supplied, artist.props.selection); tree = h.render();
  const retained = detail(tree, 'artist'); retained.props.onSelectAlbum(album); tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent', 'artist', 'album']);
  assert.equal(detail(tree, 'artist').key, retained.key, 'opening an Album does not replace the Artist controller');
  assert.equal(detail(tree, 'album').props.selection.ref, 'album:one');
  assert.equal(tree.props['data-home-pane'], 'album');
  const tabs = elements(tree).find(element => element.type?.name === 'Tabs' && element.props.id === 'home-selected-sections');
  assert.deepEqual(Array.from(tabs.props.items, item => item[0]), ['recent', 'artist', 'album']);
  const full = buttonNamed(h.nodes.get('artist'), /full size/i); h.env.click(full); tree = h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'artist');
  assert.deepEqual(h.mounts.at(-1), ['recent', 'artist', 'album']);
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /listened_albums|allowed_actions|Visible artist/);
});

test('kind roundtrips restore opaque identity and expansion only against the current source', t => {
  const h = dashboardFixture(); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
  h.env.click(buttonNamed(h.nodes.get('artist'), /full size/i)); tree = h.render();
  const changeKind = value => elements(tree).find(element => element.type?.name === 'Tabs' && element.props.id === 'home-recent-kinds').props.onChange(value);
  changeKind('tracks'); tree = h.render(); assert.equal(detail(tree, 'artist'), undefined);
  changeKind('artists'); tree = h.render(); assert.equal(detail(tree, 'artist').props.selection.ref, 'artist:one');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'artist');
});

test('source removal permanently retires selection before an identically recreated row can return', t => {
  const h = dashboardFixture(); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
  const stale = detail(tree, 'artist'), staleRowSelect = component(tree, 'ActivityPanel').props.onResourceSelect;
  h.state = {...h.state, activity: ready([])};
  staleRowSelect(row(), 'artist');
  stale.props.onDetailChange({status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(), listened_albums: []}}, stale.props.selection);
  tree = h.render({beforeEffects: true}); assert.equal(detail(tree, 'artist'), undefined);
  h.render(); h.state = {...h.state, activity: ready([row()])}; tree = h.render();
  assert.equal(detail(tree, 'artist'), undefined);
  component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
  assert.ok(detail(tree, 'artist'), 'a fresh deliberate selection can use the recreated current row');
});

test('current Artist refresh revokes a held child and old callbacks cannot recreate it', t => {
  const h = dashboardFixture(); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
  const album = target('album', 'album:one'), value = albums => ({status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(), listened_albums: albums}});
  let artist = detail(tree, 'artist'); artist.props.onDetailChange(value([{detail_target: album}]), artist.props.selection); tree = h.render();
  artist = detail(tree, 'artist'); const staleChild = artist.props.onSelectAlbum; staleChild(album); tree = h.render(); assert.ok(detail(tree, 'album'));
  detail(tree, 'artist').props.onDetailChange(value([]), artist.props.selection); tree = h.render();
  assert.equal(detail(tree, 'album'), undefined); assert.ok(detail(tree, 'artist'));
  staleChild(album); tree = h.render(); assert.equal(detail(tree, 'album'), undefined);
});

test('changed period, runtime, detail provider and account reject stale detail and row callbacks', t => {
  for (const change of ['period', 'runtime', 'provider', 'scope']) {
    const h = dashboardFixture(); t.after(h.dispose);
    let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
    const old = detail(tree, 'artist'), choose = component(tree, 'ActivityPanel').props.onResourceSelect;
    if (change === 'period') component(tree, 'Period').props.onChange('month');
    if (change === 'runtime') h.runtime = {...h.runtime};
    if (change === 'provider') h.readDetail = () => {};
    if (change === 'scope') h.state = {...h.state, scopeKey: 'scope:two', activity: ready([])};
    tree = h.render();
    const album = target('album', 'album:old');
    old.props.onDetailChange({status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(), listened_albums: [{detail_target: album}]}}, old.props.selection);
    old.props.onSelectAlbum(album); choose(row(), 'artist'); tree = h.render();
    assert.equal(detail(tree, 'album'), undefined, change);
    assert.equal(h.saves.at(-1).selectionPresentation.some(entry => entry.childAlbumRef === album.ref), false, change);
  }
});

test('Track target selection stays separate from playback and retires on replacement source', t => {
  const album = target('album', 'album:one', {origin: origin({kind: 'tracks'})});
  const track = row({id: 'track:one', kind: 'track', artist_target: null, album_target: album});
  const state = snapshot([track], {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = dashboardFixture(state, {kind: 'tracks'}); t.after(h.dispose);
  h.runtime.trackIntent = () => {throw new Error('Selection cannot invoke playback');};
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(track, 'album'); tree = h.render();
  assert.equal(detail(tree, 'album').props.selection.ref, album.ref);
  assert.equal(component(tree, 'ActivityPanel').props.kind, 'tracks');
  h.state = {...h.state, activity: ready([{...track}])}; tree = h.render({beforeEffects: true});
  assert.equal(detail(tree, 'album'), undefined);
  tree = h.render(); assert.equal(detail(tree, 'album'), undefined);
});

test('own-week Recent keeps its guarded native selection seam and rejects removed callback rows', t => {
  const recentRow = {album_ref: 'album:local', row_kind: 'local_album', local_match_state: 'matched_local',
    allowed_actions: {can_open_album: true, can_view_details: true}, listen_event_count: 2};
  const state = snapshot([], {recent: {status: 'ready', data: {recent_local_albums: [recentRow], recent_not_local_albums: []}}});
  const h = dashboardFixture(state, {kind: 'albums'}); t.after(h.dispose);
  h.readDetail = undefined;
  h.runtime.albumDetailSelection = (ref, scopeKey) => scopeKey === h.state.scopeKey
    && h.state.recent.data?.recent_local_albums.includes(recentRow) && ref === recentRow.album_ref
    ? {kind: 'album', ref, allowed_actions: {can_view_details: true}} : null;
  let tree = h.render(); const recent = component(tree, 'RecentAlbums');
  assert.equal(recent.props.selected, null); recent.props.onSelect('album:invented'); tree = h.render();
  assert.equal(detail(tree, 'album'), undefined);
  component(tree, 'RecentAlbums').props.onSelect(recentRow.album_ref); tree = h.render();
  assert.equal(detail(tree, 'album').props.selection.ref, recentRow.album_ref);
  assert.equal(detail(tree, 'album').props.selection.origin.source, 'recent');
  const old = component(tree, 'RecentAlbums').props.onSelect;
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}}};
  old(recentRow.album_ref); tree = h.render(); assert.equal(detail(tree, 'album'), undefined);
  h.state = {...h.state, recent: state.recent}; tree = h.render();
  assert.equal(component(tree, 'RecentAlbums').props.selected, null);
});

test('a previous child Album cannot close or report errors on the newly selected Album', t => {
  const h = dashboardFixture(); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(h.state.activity.data.rows[0], 'artist'); tree = h.render();
  const first = target('album', 'album:first'), second = target('album', 'album:second');
  detail(tree, 'artist').props.onDetailChange({status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(),
    listened_albums: [first, second].map(detail_target => ({detail_target}))}}, detail(tree, 'artist').props.selection);
  tree = h.render(); detail(tree, 'artist').props.onSelectAlbum(first); tree = h.render();
  const oldAlbum = detail(tree, 'album'), oldClose = elements(tree).find(element => element.type?.name === 'Button' && element.props.children === 'Close Album Info');
  detail(tree, 'artist').props.onSelectAlbum(second);
  oldClose.props.onClick(); oldAlbum.props.onError('Stale album error'); tree = h.render();
  assert.equal(detail(tree, 'album').props.selection.ref, second.ref);
  assert.equal(elements(tree).some(element => element.type?.name === 'NativeHtml' && /Stale album error/.test(element.props.html)), false);
});

test('cold history restoration waits for current source and Artist results without saving either DTO', t => {
  const unavailable = {status: 'unavailable', data: null}, album = target('album', 'album:saved');
  const saved = {kind: 'artists', selectionPresentation: [{query,
    selected: {rowId: 'row:one', targetKind: 'artist', targetRef: 'artist:one', snapshotRef: null},
    childAlbumRef: album.ref, pane: 'album', expanded: 'artist', scroll: {source: 40, artist: 60, album: 80}}]};
  const h = dashboardFixture(snapshot([], {activity: unavailable, friends: unavailable, recent: unavailable}), saved); t.after(h.dispose);
  let tree = h.render(); assert.equal(detail(tree, 'artist'), undefined);
  assert.equal(h.saves.at(-1).selectionPresentation[0].childAlbumRef, album.ref);
  h.state = snapshot(); tree = h.render(); assert.ok(detail(tree, 'artist')); assert.equal(detail(tree, 'album'), undefined);
  let artist = detail(tree, 'artist'); artist.props.onDetailChange(unavailable, artist.props.selection); tree = h.render();
  assert.equal(h.saves.at(-1).selectionPresentation[0].childAlbumRef, album.ref, 'initial unavailable is not a revoked grant');
  artist = detail(tree, 'artist'); artist.props.onDetailChange({status: 'ready', data: {kind: 'artist', ref: 'artist:one', origin: origin(),
    listened_albums: [{detail_target: album}]}}, artist.props.selection); tree = h.render();
  assert.equal(detail(tree, 'album').props.selection.ref, album.ref);
  assert.equal(h.nodes.get('artist').querySelector('.home-friends__widget-body').scrollTop, 60);
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /listened_albums|allowed_actions/);
});

test('saved native Recent selection waits through initial unavailability and retires an explicit open denial', t => {
  const row = {album_ref: 'album:local', row_kind: 'local_album', local_match_state: 'matched_local', allowed_actions: {can_open_album: true, can_view_details: true}};
  const h = dashboardFixture(snapshot([], {recent: {status: 'unavailable', data: null}}), {kind: 'albums', selectedAlbum: row.album_ref}); t.after(h.dispose);
  let tree = h.render(); assert.equal(component(tree, 'RecentAlbums').props.selected, row.album_ref); assert.equal(detail(tree, 'album'), undefined);
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [row], recent_not_local_albums: []}}}; tree = h.render();
  assert.equal(detail(tree, 'album').props.selection.ref, row.album_ref);
  h.state = {...h.state, recent: {status: 'ready', data: {recent_local_albums: [{...row, allowed_actions: {can_open_album: false}}], recent_not_local_albums: []}}};
  tree = h.render(); assert.equal(component(tree, 'RecentAlbums').props.selected, null); assert.equal(detail(tree, 'album'), undefined);
});

test('Friend revocation hides both private activity and selected panes before effects and cannot revive them', t => {
  const friend = {account_ref: 'person:one', relationship: 'accepted', display_name: 'Friend', allowed_actions: {can_view_activity: true}};
  const friendRow = row({artist_target: target('artist', 'artist:one', {origin: origin({account_ref: friend.account_ref})})});
  const friends = {status: 'ready', data: {friends: [friend], requests: [], profile: null}};
  const h = dashboardFixture(snapshot([friendRow], {friends, selectedFriendRef: friend.account_ref,
    activityNavigation: {query: {account_ref: friend.account_ref, kind: 'artists', period: 'week'}}}), {kind: 'artists', friendKind: 'artists'});
  t.after(h.dispose); h.shell = {...h.shell, section: 'friends', friendRef: friend.account_ref};
  let tree = h.render(); component(tree, 'ActivityPanel').props.onResourceSelect(friendRow, 'artist'); tree = h.render();
  assert.equal(detail(tree, 'artist').props.selection.origin.account_ref, friend.account_ref);
  h.state = {...h.state, friends: {status: 'ready', data: {...friends.data,
    friends: [{...friend, allowed_actions: {can_view_activity: false}}]}}};
  tree = h.render({beforeEffects: true}); assert.equal(component(tree, 'ActivityPanel'), undefined); assert.equal(detail(tree, 'artist'), undefined);
  h.render(); h.state = {...h.state, friends}; tree = h.render();
  assert.ok(component(tree, 'ActivityPanel')); assert.equal(detail(tree, 'artist'), undefined);
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

test('Recent track sets restore widgets with independent mixed panes and retire on source replacement', t => {
  const o = origin({kind: 'tracks'});
  const tracks = ['a', 'b'].map((id, index) => row({id, kind: 'track', availability: index ? 'local' : 'missing',
    album_target: target('album', id, {origin: o, identity_ref: `album:${index}`}),
    artist_target: target('artist', id, {origin: o, identity_ref: 'artist:common'})}));
  const state = snapshot(tracks, {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = dashboardFixture(state, {kind: 'tracks'}); t.after(h.dispose);
  h.runtime.trackIntent = () => {throw new Error('Selection must not play');};
  let tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent']);
  component(tree, 'ActivityPanel').props.onTracksSelect(['a', 'b']); tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent', 'artist', 'album']);
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null);
  assert.equal(detail(tree, 'album'), undefined);
  assert.equal(detail(tree, 'artist').props.selection.identity_ref, 'artist:common');
  assert.equal(tree.props['data-home-pane'], 'recent');
  assert.doesNotMatch(JSON.stringify(h.saves.at(-1)), /artist:common|allowed_actions|Visible artist/);
  const stale = component(tree, 'ActivityPanel').props.onTracksSelect;
  h.state = {...h.state, activity: ready(tracks.map(row => ({...row})))};
  tree = h.render(); assert.deepEqual(widgetKeys(tree), ['recent']);
  stale(['a']); tree = h.render(); assert.deepEqual(widgetKeys(tree), ['recent']);
  component(tree, 'ActivityPanel').props.onTracksSelect(['a']); tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent', 'artist', 'album']);
});

test('Queue is nested only in own Home and suppresses gallery controls and selected detail panes', t => {
  const h = dashboardFixture(snapshot([]), {kind: 'tracks'}); t.after(h.dispose);
  let tree = h.render();
  const tabs = elements(tree).find(node => node.props.id === 'home-recent-sections');
  assert.ok(tabs.props.items.some(([key]) => key === 'queue'));
  tabs.props.onChange('queue'); tree = h.render();
  assert.ok(component(tree, 'QueuePanel')); assert.equal(component(tree, 'ActivityPanel'), undefined);
  assert.equal(component(tree, 'Period'), undefined);
  assert.equal(elements(tree).find(node => node.props.className === 'home-friends__catalog-controls'), undefined);
  assert.deepEqual(widgetKeys(tree), ['recent']);
  h.shell = {...h.shell, section: 'friends'}; tree = h.render();
  assert.equal(elements(tree).find(node => node.props['data-home-widget'] === 'recent').props.hidden, true);
});

test('review: track Artist selection can open its admitted child Album', t => {
  const o = origin({kind: 'tracks'}), artist = target('artist', 'row:a', {origin: o, identity_ref: 'artist:a'});
  const state = snapshot([row({id: 'a', kind: 'track', artist_target: artist, album_target: null})],
    {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}});
  const h = dashboardFixture(state, {kind: 'tracks'}); t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onTracksSelect(['a']); tree = h.render();
  const child = target('album', 'child:album', {origin: o});
  detail(tree, 'artist').props.onDetailChange({status: 'ready', data: {kind: 'artist', ref: artist.ref, origin: o,
    listened_albums: [{id: 'child:row', detail_target: child}]}}, detail(tree, 'artist').props.selection);
  tree = h.render(); detail(tree, 'artist').props.onSelectAlbum(child); tree = h.render();
  assert.equal(detail(tree, 'album')?.props.selection.ref, child.ref);
});


test('review: deliberate inspect of the same selected track restores Recent widgets', t => {
  const o = origin({kind: 'tracks'});
  const h = dashboardFixture(snapshot([row({id: 'a', kind: 'track', artist_target: target('artist', 'a', {origin: o})})],
    {activityNavigation: {query: {account_ref: null, kind: 'tracks', period: 'week'}}}), {kind: 'tracks'});
  t.after(h.dispose);
  let tree = h.render(); component(tree, 'ActivityPanel').props.onTracksSelect(['a']); tree = h.render();
  h.env.click(buttonNamed(h.nodes.get('recent'), /full size/i)); tree = h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), 'recent');
  component(tree, 'ActivityPanel').props.onTracksSelect(['a'], {inspect: true}); tree = h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null);
});

test('Queue occurrences use the existing three-widget dashboard and preserve deactivated selection', t => {
  const queueListeners = new Set(), detailListeners = new Set();
  let queue = {enabled: true, revision: 1, entries: [{id: 'queue:1', sourceReadable: true, title: 'Track'}]},
    selected = {selectedIds: [], album: null, artist: null, status: 'empty'}, disposed = 0;
  const api = {getSnapshot: () => queue, subscribe(fn) {queueListeners.add(fn); return () => queueListeners.delete(fn);}};
  const origin = {source: 'queue', occurrence_refs: ['queue:1']};
  const adapter = {getSnapshot: () => selected, subscribe(fn) {detailListeners.add(fn); return () => detailListeners.delete(fn);},
    readAlbumProjection: async () => ({status: 'unavailable'}), dispose() {disposed++;},
    select(ids) {selected = {selectedIds: ids, status: 'ready', album: target('album', 'queue:album', {origin}), artist: target('artist', 'queue:artist', {origin})};
      detailListeners.forEach(fn => fn()); return Promise.resolve(selected);},
    clear() {selected = {selectedIds: [], album: null, artist: null, status: 'empty'}; detailListeners.forEach(fn => fn());}};
  const h = dashboardFixture(snapshot([]), {kind: 'tracks'}); t.after(h.dispose);
  h.runtime.explicitQueue = () => api; h.runtime.createQueueResourceSelection = () => adapter;
  let tree = h.render(); elements(tree).find(node => node.props.id === 'home-recent-sections').props.onChange('queue');
  tree = h.render(); tree = h.render(); component(tree, 'QueuePanel').props.onSelect(['queue:1']); tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent', 'artist', 'album']);
  assert.equal(detail(tree, 'album').props.selection.ref, 'queue:album');
  assert.equal(detail(tree, 'artist').props.selection.ref, 'queue:artist');
  h.env.click(buttonNamed(h.nodes.get('recent'), /full size/i)); tree = h.render();
  component(tree, 'QueuePanel').props.onSelect(['queue:1'], {inspect: true}); tree = h.render();
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'), null);
  const retiredAlbum = detail(tree, 'album'), retiredSelect = component(tree, 'QueuePanel').props.onSelect;
  queue = {...queue, enabled: false, revision: 2}; queueListeners.forEach(fn => fn()); tree = h.render();
  assert.deepEqual(widgetKeys(tree), ['recent', 'artist', 'album']);
  h.shell = {...h.shell, section: 'friends'}; tree = h.render();
  assert.equal(component(tree, 'QueuePanel'), undefined); assert.equal(detail(tree, 'album'), undefined);
  assert.equal(disposed, 1);
  const before = selected;
  retiredAlbum.props.onError('Retired detail must not report'); retiredSelect(['queue:1']);
  assert.equal(selected, before, 'retired Queue callbacks cannot recreate selection after navigation');
  assert.equal(elements(h.render()).some(node => node.props.children === 'Retired detail must not report'), false);
});
