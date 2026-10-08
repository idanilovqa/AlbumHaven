const test = require('node:test');
const assert = require('node:assert/strict');
let actions;
test.before(async () => {actions = await import('../../../music_app/static/js/playlists/selection-actions.mjs');});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const descriptor = (revision = 'source:r1') => ({kind: 'library', ref: 'library:action-test', revision,
  allowed_actions: {can_read: true, can_use_for_playlist: true}});
const mapping = (rowKey, track_ref, canonical_track_ref, entry_ref) => ({rowKey, track_ref, canonical_track_ref, entry_ref});
const defaultRows = () => [mapping('one', '/private/first.flac', 'canonical:first', 'entry:first'),
  mapping('two', '/private/second.flac', 'canonical:second', 'entry:second'),
  mapping('three', '/private/alternate-first.flac', 'canonical:first', 'entry:alternate-first'),
  mapping('four', '/private/third.flac', 'canonical:third', 'entry:third'),
  mapping('five', '/private/second.flac', 'canonical:second', 'entry:second')];
const destination = (patch = {}) => ({playlist_id: 'playlist:target', title: 'Destination', revision: 'target:r1', allowed_actions: {can_add: true, can_open: true}, ...patch});
const destinations = (scopeKey, patch = {}) => ({status: 'ready', data: {scopeKey, allowed_actions: {can_create: true},
  playlist_creation_source: descriptor(), destinations: [destination()], ...patch}});
const sourceResult = request => ({status: 'ready', data: {scopeKey: request.scopeKey, mode: request.mode, source: request.source,
  allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true,
  entries: ['first', 'second', 'third', 'extra'].map(id => ({entry_ref: `entry:${id}`, canonical_track_ref: `canonical:${id}`,
    title: id, allowed_actions: {can_read: true, can_select: true}, availability: 'local', parent_album: {state: 'unknown'}}))}});
function fixture({rows = defaultRows(), providers = {}, source = descriptor(), selected, readable = true} = {}) {
  let current = true, snapshot = {scopeKey: 'scope:action-test', instance: {}, revision: 'view:r1', active: true,
    rows: rows.map(row => ({rowKey: row.rowKey, readable, selectable: true}))};
  const invalidations = new Set(), sourceListeners = new Set(), signal = new AbortController();
  const reads = [], writes = [], creations = [];
  const sourceAdapter = {snapshot: () => snapshot, subscribe(listener) {sourceListeners.add(listener); return () => sourceListeners.delete(listener);},
    resolveRows: keys => ({rows: keys.map(key => rows.find(row => row.rowKey === key)), playlist_creation_source: source})};
  const lifetime = {signal: signal.signal, isCurrent: () => current, subscribeInvalidation(listener) {invalidations.add(listener); return () => invalidations.delete(listener);}};
  const configured = {readPlaylistDestinations: async request => {reads.push(request); return destinations(request.scopeKey);},
    addTracks: async request => {writes.push(request); return {ok: true};},
    readPlaylistCreationSource: async request => sourceResult(request),
    createPlaylistFromSelection: async request => {creations.push(request); return {status: 'ready', data: {scopeKey: request.scopeKey,
      request_key: request.request_key, playlist_id: 'playlist:created', revision: 'created:r1'}};}, ...providers};
  const controller = actions.createPlaylistActionController({packet: {scopeKey: snapshot.scopeKey,
    row_keys: selected || rows.map(row => row.rowKey).reverse(), origin: {tableKey: 'table:action-test', target: 'selection'}}, lifetime, sourceAdapter, providers: configured});
  return {controller, reads, writes, creations, rows, sourceAdapter, configured,
    replace(patch) {snapshot = {...snapshot, ...patch}; sourceListeners.forEach(listener => listener());},
    retire() {current = false; invalidations.forEach(listener => listener());},
    restore() {current = true;}, signal};
}
async function selectedFixture(options) {
  const result = fixture(options); assert.equal(await result.controller.load(), true);
  assert.equal(result.controller.select('playlist:target'), true); return result;
}

test('five selected occurrences use three first-source representatives without exposing private refs', async () => {
  const f = await selectedFixture();
  assert.deepEqual(f.controller.getSnapshot().counts, {selectedRowCount: 5, uniqueTrackCount: 3, duplicateCount: 2});
  assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /private|canonical:|entry:/);
  assert.equal(await f.controller.add(), true);
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 3);
  assert.deepEqual(f.writes[0].track_refs, ['/private/first.flac', '/private/second.flac', '/private/third.flac']);
  assert.deepEqual(Object.keys(f.writes[0]).sort(), ['scopeKey', 'playlist_id', 'track_refs', 'signal'].sort());
  assert.deepEqual(f.controller.getSnapshot().mutation, {status: 'ready', acknowledged: true, refresh: 'ready'});
  assert.equal(await f.controller.add(), false); f.controller.dispose();
});

test('exact write identity is a fallback, and conflicting canonical mappings fail without dropping rows', async () => {
  const f = await selectedFixture({rows: [mapping('a', '/native/same', null, null), mapping('b', '/native/same', null, null)]});
  assert.equal(f.controller.getSnapshot().counts.uniqueTrackCount, 1); assert.equal(f.controller.getSnapshot().canCreate, false);
  await f.controller.add(); assert.deepEqual(f.writes[0].track_refs, ['/native/same']); f.controller.dispose();
  for (const rows of [[mapping('a', '/native/same', 'canonical:a', null), mapping('b', '/native/same', 'canonical:b', null)],
    [mapping('a', '/native/one', null, null), mapping('b', null, null, null)]]) {
    const unavailable = fixture({rows}); assert.equal(await unavailable.controller.load(), false);
    assert.equal(unavailable.controller.getSnapshot().status, 'unavailable'); assert.equal(unavailable.writes.length, 0); unavailable.controller.dispose();
  }
});

test('unknown source occurrences remain separate in seeded Create while Add cannot partially write the resolved subset', async () => {
  const f = fixture({rows: [mapping('known', '/private/first.flac', 'canonical:first', 'entry:first'),
    mapping('unknown', null, null, 'entry:unknown'), mapping('missing', null, null, 'entry:missing')],
    providers: {readPlaylistCreationSource: async request => {
      const result = sourceResult(request);
      result.data.entries.push(...['unknown', 'missing'].map(id => ({entry_ref: `entry:${id}`, canonical_track_ref: null,
        title: id, availability: id === 'missing' ? 'missing' : 'unresolved', metadata_state: 'unknown',
        allowed_actions: {can_read: true, can_select: true}, parent_album: {state: 'unknown'}})));
      return result;
    }}});
  assert.equal(await f.controller.load(), true);
  assert.deepEqual(f.controller.getSnapshot().counts, {selectedRowCount: 3, uniqueTrackCount: 1, duplicateCount: 0, unresolvedSourceCount: 2});
  assert.equal(f.controller.getSnapshot().canAdd, false); assert.equal(f.controller.getSnapshot().canCreate, true);
  f.controller.select('playlist:target'); assert.equal(await f.controller.add(), false); assert.equal(f.writes.length, 0);
  assert.equal(await f.controller.openCreate(), true);
  assert.deepEqual(f.controller.getCreationController().getSnapshot().selectedKeys, ['entry:entry:first', 'entry:entry:unknown', 'entry:entry:missing']);
  f.controller.dispose();
});

test('source grants follow the adapter, while denied targeted rows and missing providers stay unavailable', async () => {
  const granted = await selectedFixture({source: null});
  assert.equal(granted.controller.getSnapshot().canAdd, true); assert.equal(granted.controller.getSnapshot().canCreate, false);
  granted.controller.dispose();
  const denied = fixture({readable: false}); assert.equal(await denied.controller.load(), false);
  assert.equal(denied.controller.getSnapshot().status, 'denied'); assert.equal(denied.reads.length, 0); denied.controller.dispose();
  const missing = fixture({providers: {readPlaylistDestinations: undefined}}); assert.equal(await missing.controller.load(), false);
  assert.equal(missing.controller.getSnapshot().status, 'unavailable'); assert.equal(missing.writes.length, 0); missing.controller.dispose();
});

test('destination authority requires own exact can_add, dense unique scoped records and opaque identity', async () => {
  for (const allowed_actions of [{can_edit: true, can_open: true}, {can_add: 1}, Object.create({can_add: true})]) {
    const f = fixture({providers: {readPlaylistDestinations: async request => destinations(request.scopeKey, {destinations: [destination({allowed_actions})]})}});
    await f.controller.load(); assert.equal(f.controller.select('playlist:target'), false); assert.equal(await f.controller.add(), false); f.controller.dispose();
  }
  for (const patch of [{scopeKey: 'other:scope'}, {destinations: [destination(), destination()]},
    {destinations: new Array(1)}, {destinations: [destination({playlist_id: '/private/playlist'})]}]) {
    assert.equal(actions.normalizePlaylistDestinations(destinations('scope:test', patch), 'scope:test').status, 'error');
  }
});

test('destination revision and revocation are rechecked before dispatch and require reselection', async () => {
  for (const patch of [{revision: 'target:r2'}, {allowed_actions: {can_add: false}}]) {
    let reads = 0, writes = 0;
    const f = await selectedFixture({providers: {readPlaylistDestinations: async request => destinations(request.scopeKey,
      {destinations: [destination(++reads === 1 ? {} : patch)]}), addTracks: async () => {writes++;}}});
    assert.equal(await f.controller.add(), false); assert.equal(writes, 0); assert.equal(f.controller.getSnapshot().selectedId, null);
    assert.equal(f.controller.getSnapshot().mutation.status, patch.revision ? 'conflict' : 'denied'); f.controller.dispose();
  }
});

test('one pending Add spans revalidation, acknowledgement and refresh; refresh failure preserves acknowledgement', async () => {
  const gate = deferred(); let reads = 0, writes = 0;
  const f = await selectedFixture({providers: {readPlaylistDestinations: request => ++reads === 3 ? gate.promise : Promise.resolve(destinations(request.scopeKey)),
    addTracks: async () => {writes++; return {status: 'ready'};}}});
  const pending = f.controller.add();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getSnapshot().busy, true); assert.equal(f.controller.getSnapshot().mutation.acknowledged, true);
  assert.equal(await f.controller.add(), false); assert.equal(await f.controller.openCreate(), false); assert.equal(await f.controller.load(), false);
  gate.reject(new Error('Private transport detail')); assert.equal(await pending, true);
  assert.deepEqual(f.controller.getSnapshot().mutation, {status: 'ready', acknowledged: true, refresh: 'error'});
  assert.equal(f.controller.getSnapshot().busy, false); assert.equal(await f.controller.add(), false); assert.equal(writes, 1); f.controller.dispose();
});

test('malformed, contradictory and rejected acknowledgements never succeed or permit an automatic resend', async () => {
  for (const response of [null, {ok: true, status: 'error'}, {status: 'ready', ok: false}, {status: 'denied'}, {status: 'unavailable'}]) {
    let writes = 0;
    const f = await selectedFixture({providers: {addTracks: async () => {writes++; return response;}}});
    assert.equal(await f.controller.add(), false); assert.equal(f.controller.getSnapshot().mutation.acknowledged, false);
    assert.equal(await f.controller.add(), false); assert.equal(writes, 1); f.controller.dispose();
  }
});

test('source and lifetime retirement during reads cannot revive on an away-and-back round trip', async () => {
  for (const retire of [f => {f.retire(); f.restore();}, f => f.replace({instance: {}}), f => f.replace({revision: 'view:r2'}), f => f.signal.abort()]) {
    const gate = deferred(); const f = fixture({providers: {readPlaylistDestinations: () => gate.promise}});
    const reading = f.controller.load(); retire(f); gate.resolve(destinations('scope:action-test'));
    assert.equal(await reading, false); assert.equal(f.controller.getSnapshot().status, 'retired'); assert.equal(f.controller.getSnapshot().counts, null);
    assert.equal(await f.controller.add(), false); assert.equal(f.writes.length, 0); f.controller.dispose();
  }
});

test('source mapping changes between picker admission and dispatch retire the whole action', async () => {
  const f = await selectedFixture(); f.rows[0].track_ref = '/private/replaced.flac';
  assert.equal(await f.controller.add(), false); assert.equal(f.controller.getSnapshot().status, 'retired'); assert.equal(f.writes.length, 0); f.controller.dispose();
});

test('seeded Create loads the literal full library and selects the same unique representatives in source order', async () => {
  const f = await selectedFixture(); assert.equal(await f.controller.openCreate(), true);
  const creation = f.controller.getCreationController(), state = creation.getSnapshot();
  assert.equal(state.mode, 'ordinary'); assert.equal(state.sourceResource.data.entries.length, 4);
  assert.deepEqual(state.selectedKeys, ['entry:entry:first', 'entry:entry:second', 'entry:entry:third']);
  assert.equal(state.tab, 'selected'); assert.equal(state.dirty, false);
  assert.equal(creation.seed(['entry:extra'], state.sourceResource), false);
  creation.edit({title: 'Created from selection'}); const ack = await creation.submit();
  assert.ok(ack); assert.equal(f.creations.length, 1);
  assert.deepEqual(f.creations[0].entry_refs, ['entry:first', 'entry:second', 'entry:third']);
  assert.equal(f.creations[0].mode, 'ordinary'); assert.equal(f.creations[0].source.kind, 'library');
  assert.equal(f.controller.acknowledgeCreation(ack), true); assert.equal(creation.getSnapshot().sourceResource.data, null); f.controller.dispose();
});

test('seeded Create rejects missing, denied or canonically conflicting occurrences and incomplete source reads', async () => {
  for (const alter of [result => {result.data.entries.pop(); result.data.entries.pop();},
    result => {result.data.entries[0].allowed_actions.can_select = false;}, result => {result.data.entries[0].canonical_track_ref = 'wrong:canonical';},
    result => {result.data.entries_complete = false;}]) {
    const f = await selectedFixture({providers: {readPlaylistCreationSource: async request => {const result = sourceResult(request); alter(result); return result;}}});
    assert.equal(await f.controller.openCreate(), false); assert.equal(f.controller.getCreationController(), null); assert.equal(f.creations.length, 0); f.controller.dispose();
  }
  const other = await selectedFixture({source: descriptor('another:revision')});
  assert.equal(other.controller.getSnapshot().canCreate, false); assert.equal(await other.controller.openCreate(), false); other.controller.dispose();
});

test('Create revalidates its separate current can_create grant before the existing item-aware writer', async () => {
  let reads = 0, writes = 0;
  const f = await selectedFixture({providers: {readPlaylistDestinations: async request => destinations(request.scopeKey,
    {allowed_actions: {can_create: ++reads < 3}}), createPlaylistFromSelection: async () => {writes++;}}});
  assert.equal(await f.controller.openCreate(), true); const creation = f.controller.getCreationController();
  creation.edit({title: 'Pending'}); assert.equal(await creation.submit(), false); assert.equal(writes, 0);
  assert.equal(await creation.submit(), false); f.controller.dispose();
});

test('created navigation waits for native return, fresh can_open and current source authority', async () => {
  for (const revoke of [false, true]) {
    const gate = deferred(); let navigation = 0, closeCalls = 0;
    const f = await selectedFixture({providers: {readPlaylistDestinations: async request => destinations(request.scopeKey,
      {destinations: [destination(), destination({playlist_id: 'playlist:created'})]})}});
    await f.controller.openCreate(); const creation = f.controller.getCreationController(); creation.edit({title: 'Created'});
    const ack = await creation.submit(); assert.equal(f.controller.acknowledgeCreation(ack), true);
    const completion = actions.completeSelectionPlaylistCreation({controller: f.controller, ack,
      close: () => {closeCalls++; return gate.promise;}, navigate: () => {navigation++;}});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closeCalls, 1); assert.equal(navigation, 0);
    if (revoke) {f.retire(); f.restore();}
    gate.resolve(true); assert.equal(await completion, !revoke); assert.equal(navigation, revoke ? 0 : 1); f.controller.dispose();
  }
});

test('late dispatched Add success cannot publish into a retired source, even when the provider ignores abort', async () => {
  const gate = deferred(); let request;
  const f = await selectedFixture({providers: {addTracks: input => {request = input; return gate.promise;}}});
  const pending = f.controller.add(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(request); f.retire(); f.restore(); assert.equal(request.signal.aborted, true);
  gate.resolve({ok: true}); assert.equal(await pending, false);
  assert.equal(f.controller.getSnapshot().status, 'retired'); assert.equal(f.controller.getSnapshot().mutation.acknowledged, false); f.controller.dispose();
});

test('missing Add mapping disables only Add when an authoritative canonical-to-library seed exists', async () => {
  const f = await selectedFixture({rows: [mapping('one', null, 'canonical:first', 'entry:first')]});
  assert.equal(f.controller.getSnapshot().canAdd, false); assert.equal(f.controller.getSnapshot().canCreate, true);
  assert.equal(await f.controller.add(), false); assert.equal(f.writes.length, 0);
  assert.equal(await f.controller.openCreate(), true); assert.deepEqual(f.controller.getCreationController().getSnapshot().selectedKeys, ['entry:entry:first']); f.controller.dispose();
});

test('created destination with no exact can_open keeps creation success and returns to the source', async () => {
  const f = await selectedFixture(); await f.controller.openCreate(); const creation = f.controller.getCreationController();
  creation.edit({title: 'Created without navigation'}); const ack = await creation.submit(); f.controller.acknowledgeCreation(ack);
  let closed, navigated = false, notice;
  assert.equal(await actions.completeSelectionPlaylistCreation({controller: f.controller, ack,
    close: async options => {closed = options; return true;}, navigate: () => {navigated = true;}, notify: value => {notice = value;}}), true);
  assert.equal(navigated, false); assert.equal(closed.restoreFocus, true); assert.match(notice, /created.*not available/); f.controller.dispose();
});

test('derived canonical evidence from a repeated write ref also validates the seeded representative', async () => {
  const f = await selectedFixture({rows: [mapping('one', '/private/same.flac', null, 'entry:first'),
    mapping('two', '/private/same.flac', 'canonical:second', 'entry:second')]});
  assert.equal(f.controller.getSnapshot().counts.uniqueTrackCount, 1);
  assert.equal(await f.controller.openCreate(), false, 'the first occurrence must actually map to the resolved canonical track');
  assert.equal(f.creations.length, 0); f.controller.dispose();
});

test('creation read and write continuations recheck silent source mapping changes before exposing results', async () => {
  const reading = deferred(); let sourceRequest;
  const loading = await selectedFixture({providers: {readPlaylistCreationSource: request => {sourceRequest = request; return reading.promise;}}});
  const open = loading.controller.openCreate(); await new Promise(resolve => setImmediate(resolve));
  loading.rows[0].track_ref = '/private/replaced-during-read.flac'; reading.resolve(sourceResult(sourceRequest));
  assert.equal(await open, false); assert.equal(loading.controller.getSnapshot().status, 'retired');
  assert.equal(loading.controller.getCreationController(), null); loading.controller.dispose();
  const writing = deferred(); let writeRequest;
  const saving = await selectedFixture({providers: {createPlaylistFromSelection: request => {writeRequest = request; return writing.promise;}}});
  await saving.controller.openCreate(); const creation = saving.controller.getCreationController(); creation.edit({title: 'Pending source'});
  const submit = creation.submit(); await new Promise(resolve => setImmediate(resolve));
  saving.rows[0].track_ref = '/private/replaced-during-write.flac';
  writing.resolve({status: 'ready', data: {scopeKey: writeRequest.scopeKey, request_key: writeRequest.request_key,
    playlist_id: 'playlist:late', revision: 'created:r1'}});
  assert.equal(await submit, false); assert.equal(saving.controller.getSnapshot().status, 'retired');
  assert.equal(creation.getSnapshot().mutation.status, 'idle'); saving.controller.dispose();
});

test('replacing a provider in the same configuration object retires the existing action', async () => {
  const f = await selectedFixture(); let replacementWrites = 0;
  f.configured.addTracks = async () => {replacementWrites++; return {ok: true};};
  assert.equal(await f.controller.add(), false); assert.equal(f.controller.getSnapshot().status, 'retired');
  assert.equal(f.writes.length, 0); assert.equal(replacementWrites, 0); f.controller.dispose();
});
