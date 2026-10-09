const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/queue-playlist-source.mjs')));
function fixture() {
  let view = true, scope = true, readable = true, calls = 0; const denials = [];
  const aborter = new AbortController(), ids = ['queued:b', 'queued:a'];
  const snapshot = {scopeKey: 'scope:one', instance: {}, revision: 1, rows: ids.map(rowKey => ({rowKey, readable: true, selectable: true}))};
  const rows = ids.map(rowKey => ({rowKey, track_ref: 'inventory-track:1:2', source_provenance: {kind: 'inventory', track_ref: 'inventory-track:1:2'}}));
  const sourceAdapter = {snapshot: () => view ? snapshot : null, subscribe: () => () => {}};
  const options = {queue: {async playlistSelection(keys, options) {calls++; assert.deepEqual(keys, ids);
    return {rows, isCurrent: () => readable && options.isCurrent() && !options.signal.aborted, rejectSourceRead(status) {denials.push(status); readable=false; return true;}};}}, sourceAdapter,
    packet: {scopeKey: snapshot.scopeKey, row_keys: ids}, lifetime: {signal: aborter.signal, isCurrent: () => view}, scopeCurrent: () => scope};
  return {options, ids, rows, denials, calls: () => calls, leave: () => {view = false; aborter.abort();}, revoke: () => {readable = false;}, logout: () => {scope = false;}};
}
test('Queue builder source preserves occurrence order/duplicates and never requests playback', async () => {
  const {prepareQueuePlaylistSource} = await load, f = fixture();
  const source = await prepareQueuePlaylistSource(f.options);
  assert.equal(f.calls(), 1); assert.deepEqual(source.resolveRows(f.ids).rows, f.rows);
  assert.equal(source.resolveRows([...f.ids].reverse()), null);
  const navigation = source.retainNavigation(f.ids); assert.equal(navigation.isCurrent(), true);
  f.leave(); assert.equal(source.snapshot(), null); assert.equal(navigation.isCurrent(), true);
  f.revoke(); assert.equal(navigation.isCurrent(), false);
});
test('Queue preparation aborts on stale action, while successful source still rejects account changes', async () => {
  const {prepareQueuePlaylistSource} = await load, f = fixture();
  let finish; f.options.queue.playlistSelection = async (_, options) => {await new Promise(resolve => {finish = resolve;}); return {rows:f.rows, isCurrent:()=>!options.signal.aborted};};
  const pending = prepareQueuePlaylistSource(f.options); f.leave(); finish(); assert.equal(await pending, null);
  const next = fixture(), source = await prepareQueuePlaylistSource(next.options); next.logout();
  assert.equal(source.resolveRows(next.ids), null); assert.equal(source.retainNavigation(next.ids), null);
});

test('review v4: revoked original Queue source cannot be added after the picker has opened', async () => {
  const {prepareQueuePlaylistSource} = await load;
  const {createPlaylistActionController} = await import('../../../music_app/static/js/playlists/selection-actions.mjs');
  const f = fixture(); let revoked = false, writes = 0;
  f.options.queue.playlistSelection = async () => {
    if (revoked) throw Object.assign(new Error('Original source revoked'), {status: 403});
    return {rows: f.rows, isCurrent: () => true};
  };
  const sourceAdapter = await prepareQueuePlaylistSource(f.options);
  const providers = {readPlaylistDestinations: async request => ({status: 'ready', data: {
    scopeKey: request.scopeKey, destinations: [{playlist_id: 'target:one', revision: 'r1', title: 'Target', allowed_actions: {can_add: true}}],
    allowed_actions: {can_create: true}}}),
    beginPlaylistQueueSource: async request => {assert.equal(request.occurrences.length, 2); return {
      source: {kind:'library',ref:'source:retained',revision:'source:revision',source_protocol:'complete_inventory_selection_v1',allowed_actions:{can_read:true,can_use_for_playlist:true}},entry_refs:['entry:retained']};},
    addTracks: async request => {assert.equal(request.source_guard.source.ref,'source:retained');
      if (revoked) throw Object.assign(new Error('Source revoked in mutation transaction'), {status:403});
      writes++; return {ok:true};}};
  const controller = createPlaylistActionController({sourceAdapter, providers,
    packet: {...f.options.packet, origin: {tableKey: 'home-explicit-queue', target: 'selection'}}, lifetime: f.options.lifetime});
  assert.equal(await controller.load(), true); assert.equal(controller.select('target:one'), true);
  revoked = true;
  assert.equal(await controller.add(), false);
  assert.equal(writes, 0);
  controller.dispose();
});

test('Queue source without explicit original provenance cannot silently become inventory-only', async () => {
  const {prepareQueuePlaylistSource}=await load, f=fixture();
  f.options.queue.playlistSelection=async()=>({rows:f.rows.map(({source_provenance,...row})=>row),isCurrent:()=>true});
  assert.equal(await prepareQueuePlaylistSource(f.options),null);
});

test('Queue source denial delegates only confirmed403/404 to its exact retained runtime receipt', async () => {
  const {prepareQueuePlaylistSource}=await load;
  for(const status of [403,404]) {const f=fixture(), source=await prepareQueuePlaylistSource(f.options);
    assert.equal(source.rejectSourceRead(status),true);assert.deepEqual(f.denials,[status]);
    assert.equal(source.rejectSourceRead(status),false);assert.equal(source.snapshot(),null);}
  for(const status of [401,409,410,500,'403']) {const f=fixture(),source=await prepareQueuePlaylistSource(f.options);
    assert.equal(source.rejectSourceRead(status),false);assert.deepEqual(f.denials,[]);assert.ok(source.snapshot());}
  const f=fixture(),source=await prepareQueuePlaylistSource(f.options);f.logout();
  assert.equal(source.rejectSourceRead(403),false);assert.deepEqual(f.denials,[]);
});
