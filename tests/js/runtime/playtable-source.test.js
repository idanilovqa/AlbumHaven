const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/playtable-source.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function setup() {
  let scope = {actor: 'actor', library: 'library', token: {}}, alive = true;
  const events = new Map(), document = {getElementById: () => null};
  const context = vm.createContext({Object, Set, Map, Array, JSON, document, state: {view: {}},
    TrackActionsRuntime: {scope: () => scope},
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name, fn) => {if (events.get(name) === fn) events.delete(name);}});
  context.window = context;
  vm.runInContext(source, context);
  const rows = [{id: 'row:first'}, {id: 'row:repeat'}, {id: 'row:denied', source_readable: false}];
  const raw = new Map(rows.map(row => [row, {inventory_track_ref: 'inventory-track:1:2', track_ref: '/private/actual.flac', canonical_track_ref: 'track:one', entry_ref: `entry:${row.id}`} ]));
  const descriptor = {kind: 'library', ref: 'library:one', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}};
  const adapter = context.createPrivatePlaytableSource({scopeKey: 'scope:one', rows, instance: {}, revision: 'view:one',
    isCurrent: () => alive, resolveRow: row => raw.get(row), creationSource: () => descriptor});
  return {adapter, rows, raw, context, events, descriptor, setAlive: value => {alive = value;}, replaceScope: () => {scope = {...scope, token: {}};}};
}
test('public source snapshot contains only UI row facts; private mappings resolve in requested source order', () => {
  const h = setup(), value = h.adapter.snapshot();
  assert.doesNotMatch(JSON.stringify(value), /private|actual|track_ref|canonical|entry_ref/);
  assert.deepEqual(plain(value.rows), [{rowKey: 'row:first', readable: true, selectable: true},
    {rowKey: 'row:repeat', readable: true, selectable: true}, {rowKey: 'row:denied', readable: false, selectable: false}]);
  const result = h.adapter.resolveRows(['row:repeat', 'row:first']);
  assert.deepEqual(plain(result.rows).map(row => row.rowKey), ['row:repeat', 'row:first']);
  assert.equal(result.rows[0].track_ref, 'inventory-track:1:2');
  assert.equal(result.playlist_creation_source, h.descriptor);
});
test('readable UI-only rows stay selectable while missing mapping prevents an action', () => {
  const h = setup(); h.raw.delete(h.rows[0]);
  assert.equal(h.adapter.snapshot().rows[0].selectable, true);
  assert.equal(h.adapter.resolveRows(['row:first']), null);
});
test('denied, duplicate and unknown row requests never return a partial private action', () => {
  const h = setup();
  for (const keys of [['row:first', 'row:denied'], ['row:first', 'row:first'], ['missing'], ['row:first', 'missing']])
    assert.equal(h.adapter.resolveRows(keys), null);
  h.raw.set(h.rows[0], {track_ref: '/private/ref', allowed_actions: {can_read: false}});
  assert.equal(h.adapter.resolveRows(['row:first']), null);
});
test('same source sorting and filtering preserve instance while hidden rows lose action access', () => {
  const h = setup(), before = h.adapter.snapshot(); let changes = 0;
  h.adapter.subscribe(() => {changes++;});
  assert.equal(h.adapter.updateRows([h.rows[1], h.rows[0]], 'view:two'), true);
  assert.equal(h.adapter.snapshot().instance, before.instance);
  assert.equal(h.adapter.snapshot().revision, 'view:two');
  assert.deepEqual(plain(h.adapter.snapshot().rows).map(row => row.rowKey), ['row:repeat', 'row:first']);
  assert.equal(h.adapter.updateRows([h.rows[0]], 'view:three'), true);
  assert.equal(h.adapter.resolveRows(['row:repeat']), null);
  assert.equal(changes, 2);
});
test('view updates cannot inject an equal-looking row from another source', () => {
  const h = setup(); assert.equal(h.adapter.updateRows([{...h.rows[0]}], 'forged'), false);
  assert.equal(h.adapter.snapshot().revision, 'view:one');
});
test('account/library ABA, source retirement and disposal permanently retire private actions', () => {
  for (const retire of [h => h.replaceScope(), h => h.setAlive(false), h => h.adapter.dispose()]) {
    const h = setup(); let invalidations = 0; h.adapter.subscribe(() => {invalidations++;}); retire(h);
    assert.equal(h.adapter.snapshot(), null); h.setAlive(true);
    assert.equal(h.adapter.snapshot(), null); assert.equal(h.adapter.resolveRows(['row:first']), null);
    assert.ok(invalidations >= 1);
  }
});
test('a resolver that retires its own source cannot return write refs', () => {
  const h = setup(); let alive = true;
  const adapter = h.context.createPrivatePlaytableSource({scopeKey: 'scope', rows: h.rows, instance: {}, isCurrent: () => alive,
    resolveRow: row => {alive = false; return h.raw.get(row);}});
  assert.equal(adapter.resolveRows(['row:first']), null);
});

test('a one-use navigation receipt survives intentional UI disposal but never source, mapping or scope revocation', () => {
  for (const revoke of ['source', 'mapping', 'scope', 'release']) {
    const h = setup(); let current = true;
    const adapter = h.context.createPrivatePlaytableSource({scopeKey: 'scope', rows: h.rows, instance: {}, isCurrent: () => true,
      resolveRow: row => h.raw.get(row), retainNavigationSource: () => () => current});
    const receipt = adapter.retainNavigation(['row:first']); assert.ok(receipt); adapter.dispose();
    assert.equal(receipt.isCurrent(), true, 'retained native source outlives its own view disposal');
    if (revoke === 'source') current = false;
    if (revoke === 'mapping') h.raw.set(h.rows[0], {track_ref: '/private/replaced'});
    if (revoke === 'scope') h.replaceScope();
    if (revoke === 'release') receipt.dispose();
    assert.equal(receipt.isCurrent(), false); current = true; assert.equal(receipt.isCurrent(), false);
  }
});

test('native sections receive opaque occurrence keys and retain actual private identities without persisted item fabrication', () => {
  const h = setup(), native = vm.runInContext('NativePlaytables', h.context), captured = [];
  h.context.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope:native'})};
  h.context.AlbumHavenPlaytableUI = {mount: (_host, options) => {captured.push(options); return {dispose() {}, update() {}};}};
  const groups = [{sectionKey: 'rarity', tracks: [{title: 'First'}, {title: 'Repeated'}]}, {sectionKey: 'interview', tracks: [{title: 'Missing'}]}];
  const privateRows = [{inventory_track_ref: 'inventory-track:1:2', track_ref: '/private/one'}, {inventory_track_ref: 'inventory-track:1:2', track_ref: '/private/one'}, {track_ref: '/private/missing', availability: 'missing'}];
  native.prepare('loose-tracks', h.context.state.view, groups, privateRows, () => true);
  assert.equal(native.mount('loose-tracks', {}), true);
  const adapter = captured[0].sourceAdapter, facts = adapter.snapshot().rows;
  assert.equal(new Set(facts.map(row => row.rowKey)).size, 3);
  assert.doesNotMatch(JSON.stringify(facts), /private|playlist_item_id/);
  assert.deepEqual(plain(facts).map(row => row.sectionKey), ['rarity', 'rarity', 'interview']);
  assert.equal(groups[1].tracks[0].canPlay, false); assert.equal(facts[2].selectable, true);
  assert.deepEqual(plain(adapter.resolveRows(facts.slice(0, 2).map(row => row.rowKey)).rows).map(row => row.track_ref), ['inventory-track:1:2', 'inventory-track:1:2']);
  const rowKey = facts[0].rowKey; h.context.state.view = {};
  assert.equal(adapter.resolveRows([rowKey]), null);
});
test('late React loading mounts a retained native table once; retirement disposes the same source and mount', () => {
  const h = setup(), native = vm.runInContext('NativePlaytables', h.context), host = {};
  h.context.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'scope'})};
  const groups = [{tracks: [{}]}]; native.prepare('album-tracks', {}, groups, [{track_ref: '/private/one'}], () => true);
  assert.equal(native.mount('album-tracks', host), false);
  let mounted = 0, disposed = 0, sourceAdapter;
  h.context.AlbumHavenPlaytableUI = {mount: (node, options) => {assert.equal(node, host); mounted++; sourceAdapter = options.sourceAdapter;
    return {dispose() {disposed++;}, update() {}};}};
  h.events.get('albumhaven:playtable-ui-ready')();
  assert.equal(mounted, 1); native.retire('album-tracks');
  assert.equal(disposed, 1); assert.equal(sourceAdapter.snapshot(), null);
});

// Native playback references are never accepted as Playlist write identities.
test('Add identity requires explicit scoped inventory and never aliases a media path', () => {
  const h = setup();
  h.raw.set(h.rows[0], {track_ref: '/private/path', canonical_track_ref: null});
  assert.equal(h.adapter.resolveRows(['row:first']).rows[0].track_ref, null);
  h.raw.set(h.rows[0], {inventory_track_ref: 'inventory-track:1:2', track_ref: '/private/path', canonical_track_ref: null});
  assert.equal(h.adapter.resolveRows(['row:first']).rows[0].track_ref, 'inventory-track:1:2');
  assert.equal(h.adapter.resolveRows(['row:first']).rows[0].canonical_track_ref, null);
});
