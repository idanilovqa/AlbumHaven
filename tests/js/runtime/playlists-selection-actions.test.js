const test = require('node:test');
const assert = require('node:assert/strict');
let actions, createBackend;
test.before(async () => {actions = await import('../../../music_app/static/js/playlists/selection-actions.mjs'); ({createPlaylistBackendProviders:createBackend}=await import('../../../music_app/static/js/playlists/backend-providers.mjs'));});
const captureFailure = status => createBackend({runtime:{snapshot:()=>({scopeKey:'scope:action-test'})},transport:{context:()=> 'context:one',request:async path=>{assert.equal(path,'/playlists/creation-source/queue');throw Object.assign(new Error('Capture failed'),{status});}}}).beginPlaylistQueueSource;
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
function fixture({rows = defaultRows(), providers = {}, source = descriptor(), selected, readable = true, activityOrigin = null, queueSource = null} = {}) {
  let current = true, snapshot = {scopeKey: 'scope:action-test', instance: {}, revision: 'view:r1', active: true,
    rows: rows.map(row => ({rowKey: row.rowKey, readable, selectable: true}))};
  const invalidations = new Set(), sourceListeners = new Set(), signal = new AbortController();
  const reads = [], writes = [], creations = [];
  const sourceAdapter = {snapshot: () => snapshot, subscribe(listener) {sourceListeners.add(listener); return () => sourceListeners.delete(listener);},
    resolveRows: keys => ({rows: keys.map(key => rows.find(row => row.rowKey === key)), playlist_creation_source: source,
      ...(queueSource ? {queue_source: {occurrences: keys.map(key => queueSource[rows.findIndex(row => row.rowKey === key)])}} : {}),
      ...(activityOrigin ? {activity_source: {origin: activityOrigin, row_refs: keys.map(key => rows.find(row => row.rowKey === key).activity_row_ref)}} : {})})};
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
  assert.deepEqual(Object.keys(f.writes[0]).sort(), ['scopeKey', 'playlist_id', 'track_refs', 'revision', 'signal'].sort());
  assert.equal(f.writes[0].revision, 'target:r1');
  assert.deepEqual(f.controller.getSnapshot().mutation, {status: 'ready', acknowledged: true, refresh: 'ready'});
  assert.equal(await f.controller.add(), false); f.controller.dispose();
});

test('inventory-only selection starts a complete source and seeds receipts without canonical identity', async () => {
  const selectedSource = {...descriptor(), ref: 'selection:source', source_protocol: 'complete_inventory_selection_v1'};
  const begins = [];
  const f = await selectedFixture({source: null, rows: [mapping('one', 'inventory-track:5:1', null, null),
    mapping('two', 'inventory-track:5:2', null, null)], providers: {
    async beginPlaylistSelectionSource(request) {begins.push(request); return {source: selectedSource, entry_refs: ['receipt:first', 'receipt:second']};},
    async readPlaylistCreationSource(request) {return {status: 'ready', data: {scopeKey: request.scopeKey,
      mode: 'ordinary', source: request.source, source_protocol: 'complete_inventory_selection_v1',
      allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true,
      entries: ['first', 'second'].map(id => ({entry_ref: `receipt:${id}`, canonical_track_ref: null,
        title: id, availability: 'local', allowed_actions: {can_read: true, can_select: true}, parent_album: {state: 'unknown'}}))}};},
  }});
  assert.equal(f.controller.getSnapshot().canCreate, true);
  assert.equal(await f.controller.openCreate(), true);
  assert.deepEqual(begins[0].track_refs, ['inventory-track:5:1', 'inventory-track:5:2']);
  const creation = f.controller.getCreationController();
  assert.deepEqual(creation.getSnapshot().selectedKeys, ['entry:receipt:first', 'entry:receipt:second']);
  creation.edit({title: 'Selected inventory'}); assert.ok(await creation.submit());
  assert.deepEqual(f.creations[0].entry_refs, ['receipt:first', 'receipt:second']);
  assert.equal(f.creations[0].source_protocol, 'complete_inventory_selection_v1');
  assert.equal(f.creations[0].track_refs, undefined); f.controller.dispose();
});

test('selected-source reopen surfaces a retained Create receipt without allocating another form or command', async () => {
  let ready = false, begins = 0;
  const f = await selectedFixture({source: null, rows: [mapping('one', 'inventory-track:5:1', null, null)], providers: {
    async beginPlaylistSelectionSource(request) {
      begins++;
      if (!ready) throw Object.assign(new Error('Still unknown'), {status: 'unknown'});
      return {recovered_creation: {scopeKey: request.scopeKey, request_key: 'original:key', playlist_id: 'created:original', revision: '1'}};
    },
  }});
  assert.equal(await f.controller.openCreate(), false); assert.equal(f.controller.getSnapshot().creationRecovery.status, 'unknown');
  assert.equal(f.controller.getCreationController(), null); ready = true;
  assert.equal(await f.controller.openCreate(), false);
  assert.deepEqual(f.controller.getSnapshot().creationRecovery, {status: 'ready', request_key: 'original:key', playlist_id: 'created:original'});
  assert.equal(f.controller.getCreationController(), null); assert.equal(f.creations.length, 0); assert.equal(begins, 2);
  f.controller.dispose();
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

test('seeded Create shows each selected occurrence in source order and submits existing unique representatives', async () => {
  const f = await selectedFixture(); assert.equal(await f.controller.openCreate(), true);
  const creation = f.controller.getCreationController(), state = creation.getSnapshot();
  assert.equal(state.mode, 'ordinary'); assert.equal(state.sourceResource.data.entries.length, 6);
  assert.equal(state.selectedKeys.length, 5);
  const selectedEntries = state.selectedKeys.map(key => state.sourceResource.data.entries.find(row => row.row_key === key));
  assert.deepEqual(selectedEntries.map(row => row.entry_ref), ['entry:first', 'entry:second', 'entry:first', 'entry:third', 'entry:second']);
  assert.equal(new Set(state.selectedKeys).size, 5);
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

test('activity Create preserves unknown originals and deduplicates only proven inventory identities', async () => {
  const captured = [], source = {kind: 'activity', ref: 'activity-source:one', revision: 'source:r1', source_protocol: 'complete_activity_selection_v1',
    allowed_actions: {can_read: true, can_use_for_playlist: true}};
  const rows = [{rowKey: 'one', track_ref: 'inventory-track:1:2', activity_row_ref: 'activity_first'},
    {rowKey: 'repeat', track_ref: 'inventory-track:1:2', activity_row_ref: 'activity_repeat'},
    {rowKey: 'unknown', track_ref: null, activity_row_ref: 'activity_unknown'}];
  const activityOrigin = {audience: 'own', subject_ref: null, kind: 'listens', period: 'week', snapshot_ref: 'snapshot:one'};
  const f = fixture({rows, source: null, activityOrigin, providers: {
    beginPlaylistActivitySource: async request => {captured.push(request); return {source, entry_refs: ['entry:local', 'entry:original']};},
    readPlaylistCreationSource: async request => ({status: 'ready', data: {scopeKey: request.scopeKey, mode: 'ordinary', source,
      source_protocol: source.source_protocol, entries_complete: true, allowed_actions: source.allowed_actions,
      entries: [{entry_ref: 'entry:local', title: 'Known', availability: 'local', allowed_actions: {can_read: true, can_select: true}},
        {entry_ref: 'entry:original', title: 'Original', availability: 'unresolved', allowed_actions: {can_read: true, can_select: true}}]}}),
  }});
  assert.equal(await f.controller.load(), true); assert.equal(f.controller.getSnapshot().canAdd, false);
  assert.equal(f.controller.getSnapshot().canCreate, true); assert.equal(await f.controller.openCreate(), true);
  assert.deepEqual(captured[0].row_refs, ['activity_first', 'activity_unknown']);
  const creation = f.controller.getCreationController(); assert.equal(creation.getSnapshot().selectedKeys.length, 3);
  assert.deepEqual(creation.getSnapshot().selectedKeys.map(key => creation.getSnapshot().sourceResource.data.entries.find(row => row.row_key === key).entry_ref), ['entry:local', 'entry:local', 'entry:original']);
  assert.equal(creation.getSnapshot().source.kind, 'activity');
  assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /inventory-track|activity_first|snapshot:one/);
});

test('review: occurrence seed uses the same inferred canonical identity as representative dedup', async () => {
  const f = await selectedFixture({rows: [
    mapping('a', '/private/first.flac', 'canonical:first', 'entry:first'),
    mapping('b', '/private/second.flac', null, 'entry:second'),
    mapping('c', '/private/second.flac', 'canonical:first', 'entry:second'),
  ]});
  assert.equal(f.controller.getSnapshot().counts.uniqueTrackCount, 1);
  assert.equal(await f.controller.openCreate(), true);
  const state = f.controller.getCreationController().getSnapshot();
  assert.equal(state.selectedKeys.length, 3);
  assert.deepEqual(state.selectedKeys.map(key => state.sourceResource.data.entries.find(row => row.row_key === key).entry_ref),
    ['entry:first', 'entry:first', 'entry:first']);
  f.controller.dispose();
});

test('Queue source preserves all duplicate origins and Add carries retained guard through final server refusal', async () => {
  const rows = [mapping('first', 'inventory-track:1:2'), mapping('duplicate', 'inventory-track:1:2')];
  const queueSource = [{kind: 'inventory', track_ref: rows[0].track_ref},
    {kind: 'playlist', track_ref: rows[0].track_ref, playlist_ref: 'playlist:source', revision: '3', item_ref: 'item:source'}];
  const begins = [], guards = []; let committed = 0;
  const captured = {source: {...descriptor(), source_protocol: 'complete_inventory_selection_v1'}, entry_refs: ['entry:first']};
  const f = await selectedFixture({rows, queueSource, providers: {
    beginPlaylistQueueSource: async request => {begins.push(request); return captured;},
    beginPlaylistSelectionSource: () => {throw new Error('Queue must not become inventory-only');},
    addTracks: async request => {guards.push(request.source_guard); if (request.source_guard) throw Object.assign(new Error('Source revoked at commit'), {status:403}); committed++; return {ok:true};},
  }});
  assert.equal(await f.controller.add(), false);
  assert.deepEqual(begins[0].occurrences, queueSource, 'every original lineage survives canonical dedup');
  assert.deepEqual(guards[0], {source_protocol: 'complete_inventory_selection_v1', source: {kind:'library',ref:descriptor().ref,revision:descriptor().revision},entry_refs:['entry:first']});
  assert.equal(committed, 0); assert.equal(f.controller.getSnapshot().mutation.status, 'denied'); f.controller.dispose();
});

test('Queue Create retains its server source and cannot fall back when the Queue source provider is unavailable', async () => {
  const rows = [mapping('first', 'inventory-track:1:2')], queueSource = [{kind:'inventory',track_ref:rows[0].track_ref}];
  const denied = await selectedFixture({rows, queueSource, providers: {beginPlaylistSelectionSource: async () => {throw Error('No fallback');}}});
  assert.equal(denied.controller.getSnapshot().canCreate, false); assert.equal(await denied.controller.add(), false); denied.controller.dispose();
  let committed = 0, captured = 0, attempted = 0;
  const f = await selectedFixture({rows, queueSource, providers: {
    beginPlaylistQueueSource: async request => {captured++; assert.equal(request.recoverCreate,true); return {source:{...descriptor(),source_protocol:'complete_inventory_selection_v1'},entry_refs:['entry:first']};},
    readPlaylistCreationSource: async request => {const result=sourceResult(request); result.data.source_protocol='complete_inventory_selection_v1'; return result;},
    createPlaylistFromSelection: async request => {attempted++; assert.equal(request.source.ref, descriptor().ref); throw Object.assign(new Error('Retained source revoked'),{status:403});},
  }});
  assert.equal(await f.controller.openCreate(), true); const creation=f.controller.getCreationController(); creation.edit({title:'Queue selection'});
  assert.equal(await creation.submit(), false); assert.equal(committed,0); assert.equal(captured,1); assert.equal(attempted,1); f.controller.dispose();
});

test('Activity-origin Queue Add needs Browse and destination Add, independently of denied Create', async () => {
  const rows=[mapping('first','inventory-track:1:2')];
  const queueSource=[{kind:'activity',track_ref:rows[0].track_ref,row_ref:'activity:row',origin:{audience:'friend',subject_ref:'friend:one',kind:'tracks',period:'week',snapshot_ref:'snapshot:one'}}];
  const begins=[],writes=[];
  const f=await selectedFixture({rows,queueSource,providers:{
    readPlaylistDestinations: async request=>destinations(request.scopeKey,{allowed_actions:{can_create:false}}),
    beginPlaylistActivitySource: ()=>{throw Error('Create-gated Activity endpoint must not be used');},
    beginPlaylistQueueSource: async request=>{begins.push(request);return {source:{...descriptor(),source_protocol:'complete_inventory_selection_v1'},entry_refs:['entry:first']};},
    addTracks: async request=>{writes.push(request);return {ok:true};},
  }});
  assert.equal(f.controller.getSnapshot().canCreate,false); assert.equal(f.controller.getSnapshot().canAdd,true);
  assert.equal(await f.controller.add(),true); assert.deepEqual(begins[0].occurrences,queueSource);
  assert.equal(writes[0].source_guard.entry_refs[0],'entry:first'); f.controller.dispose();
});

test('only completed Queue source-capture403/404 reports read denial; destination/expiry/transient failures do not', async () => {
  const rows=[mapping('one','inventory-track:1:2')],queueSource=[{kind:'inventory',track_ref:rows[0].track_ref}];
  for(const action of ['add','create'])for(const status of [403,404,401,409,410,500]) {
    const denied=[];const f=await selectedFixture({rows,queueSource,providers:{beginPlaylistQueueSource:captureFailure(status)}});
    f.sourceAdapter.rejectSourceRead=value=>denied.push(value);
    assert.equal(await (action==='add'?f.controller.add():f.controller.openCreate()),false);
    assert.deepEqual(denied,[403,404].includes(status)?[status]:[]);f.controller.dispose();
  }
  const denied=[];const f=await selectedFixture({rows,queueSource,providers:{
    beginPlaylistQueueSource:async()=>({source:{...descriptor(),source_protocol:'complete_inventory_selection_v1'},entry_refs:['entry:first']}),
    addTracks:async()=>{throw Object.assign(new Error('Destination access denied'),{status:403});},
  }});f.sourceAdapter.rejectSourceRead=value=>denied.push(value);
  assert.equal(await f.controller.add(),false);assert.deepEqual(denied,[]);f.controller.dispose();
  const gate=deferred(), late=[];const stale=await selectedFixture({rows,queueSource,providers:{beginPlaylistQueueSource:()=>gate.promise}});
  stale.sourceAdapter.rejectSourceRead=value=>late.push(value);const pending=stale.controller.add();
  await new Promise(resolve=>setImmediate(resolve));stale.retire();gate.reject(Object.assign(new Error('Late source denial'),{status:403}));
  assert.equal(await pending,false);assert.deepEqual(late,[]);stale.controller.dispose();
});

test('generic destination and creation-source reader errors cannot invoke Queue capture denial', async () => {
  const rows=[mapping('one','inventory-track:1:2')],queueSource=[{kind:'inventory',track_ref:rows[0].track_ref}];
  for(const channel of ['destinations','creation-read']) {
    let deny=false;const reports=[];
    const f=await selectedFixture({rows,queueSource,providers:{
      readPlaylistDestinations:async request=>{if(deny&&channel==='destinations')throw Object.assign(new Error('Destination read denied'),{status:403});return destinations(request.scopeKey);},
      beginPlaylistQueueSource:async()=>({source:{...descriptor(),source_protocol:'complete_inventory_selection_v1'},entry_refs:['entry:first']}),
      readPlaylistCreationSource:async()=>{throw Object.assign(new Error('Generic creation source reader failed'),{status:403});},
    }});f.sourceAdapter.rejectSourceRead=status=>reports.push(status);deny=true;
    assert.equal(await(channel==='destinations'?f.controller.add():f.controller.openCreate()),false);
    assert.deepEqual(reports,[]);f.controller.dispose();
  }
});
