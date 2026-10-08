const test = require('node:test');
const assert = require('node:assert/strict');
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/creation.mjs');});

const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const subject = (mode = 'ordinary', patch = {}) => ({scopeKey: 'controller:scope', mode, canCreate: true,
  source: {kind: mode === 'ordinary' ? 'library' : 'playlist', ref: 'controller:source', revision: 'revision:one',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}, ...patch});
const row = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Track ${entry_ref}`, artist: 'Fixture artist',
  album_title: 'Album', availability: 'unresolved', allowed_actions: {can_read: true, can_select: true},
  parent_album: {state: 'unknown', album_ref: null, title: ''}, ...patch});
const source = (request, rows = [row('a', {availability: request.mode === 'missing' ? 'missing' : 'unresolved'}),
  row('b', {availability: request.mode === 'missing' ? 'missing' : 'unresolved'}), row('local', {availability: 'local'})]) => ({status: 'ready', data: {
  scopeKey: request.scopeKey, mode: request.mode, source: {...request.source},
  allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, entries: rows,
  retained_parent_albums: [{album_ref: 'retained:only', title: 'Parent only', allowed_actions: {can_read: true}}],
}});
const ack = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'persisted:playlist', revision: 'persisted:revision'}});
const setup = (providers = {}, context = subject()) => {
  const controller = model.createPlaylistCreationController({providers: {readPlaylistCreationSource: async request => source(request),
    createPlaylistFromSelection: async request => ack(request), ...providers}});
  controller.setContext(context); return controller;
};
const ready = async (providers, context) => {const controller = setup(providers, context); await controller.load(); controller.edit({title: 'My playlist'}); return controller;};

test('provider functions and exact context grants are necessary; legacy create is never adapted', async () => {
  let fallbackCalls = 0, reads = 0;
  const controller = model.createPlaylistCreationController({providers: {createPlaylist() {fallbackCalls++;},
    readPlaylistCreationSource() {reads++; return source(subject());}}});
  controller.setContext(subject());
  assert.equal(await controller.load(), false);
  assert.equal(controller.getSnapshot().sourceResource.status, 'unavailable');
  assert.equal(await controller.submit(), false);
  assert.equal(fallbackCalls, 0); assert.equal(reads, 0);
  for (const canCreate of [undefined, 1, 'true', false]) {
    const denied = setup({readPlaylistCreationSource() {reads++;}}, subject('ordinary', {canCreate}));
    assert.equal(await denied.load(), false);
    assert.equal(denied.getSnapshot().sourceResource.status, 'denied');
  }
  assert.equal(reads, 0);
  const invalidMode = setup({readPlaylistCreationSource() {reads++;}}, subject('ordinary', {mode: 'album'}));
  assert.equal(await invalidMode.load(), false);
  assert.equal(reads, 0);
});

test('reader receives only current source identity and missing initially selects eligible occurrences', async () => {
  let received;
  const controller = setup({readPlaylistCreationSource: async request => {received = request; return source(request, [
    row('missing', {availability: 'missing'}), row('unknown-identity', {availability: 'missing'}),
    row('unknown-availability'), row('ambiguous', {availability: 'ambiguous'}), row('local', {availability: 'local'}),
    row(null, {availability: 'missing'}), row('readonly', {availability: 'missing', allowed_actions: {can_read: true, can_select: false}}),
  ]);}}, subject('missing'));
  assert.equal(await controller.load(), true);
  assert.deepEqual(Object.keys(received).sort(), ['scopeKey', 'mode', 'source', 'signal'].sort());
  assert.deepEqual(received.source, {kind: 'playlist', ref: 'controller:source', revision: 'revision:one'});
  assert.equal(received.signal.aborted, false);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:missing', 'entry:unknown-identity']);
  assert.equal(controller.getSnapshot().dirty, false);
  for (const key of ['entry:local', 'entry:unknown-availability', 'entry:ambiguous']) assert.equal(controller.toggle(key), false);
});

test('missing draft preparation is read-only and can never invoke ordinary persistence', async () => {
  let writes = 0;
  const controller = await ready({createPlaylistFromSelection() {writes++;}}, subject('missing'));
  assert.equal(await controller.submit(), false);
  const prepared = controller.prepareDraft();
  assert.ok(prepared); assert.equal(controller.prepareDraft(), prepared);
  assert.deepEqual(prepared.entries.map(item => item.entry_ref), ['a', 'b']);
  assert.equal(prepared.playlist_id, undefined); assert.equal(writes, 0);
  controller.pauseSource(); assert.equal(controller.prepareDraft(), null);
  const reader = model.createPlaylistCreationController({providers: {readPlaylistCreationSource: async request => source(request)}});
  reader.setContext(subject('missing')); assert.equal(await reader.load(), true); reader.edit({title: 'Unsaved'});
  assert.ok(reader.prepareDraft()); assert.equal(await reader.submit(), false);
  reader.setContext(subject('ordinary')); assert.equal(await reader.load(), false);
});

test('independent Top grant updates preserve missing selections and invalidate only the prepared presentation packet', async () => {
  const controller = await ready({}, subject('missing', {canCreateAlbumTop: true}));
  const first = controller.prepareDraft(); assert.equal(first.canCreateAlbumTop, true);
  controller.setContext(subject('missing', {canCreateAlbumTop: false}));
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:a', 'entry:b']);
  const next = controller.prepareDraft();
  assert.equal(next.canCreateAlbumTop, false); assert.notEqual(next, first);
  assert.notEqual(next.draftToken, first.draftToken);
  assert.equal(controller.getSnapshot().title, 'My playlist');
});

test('read supersession ignores old success and denial even when a provider ignores AbortSignal', async () => {
  const first = deferred(), second = deferred(); let calls = 0, oldSignal;
  const controller = setup({readPlaylistCreationSource(request) {if (++calls === 1) {oldSignal = request.signal; return first.promise;} return second.promise;}});
  const a = controller.load(), b = controller.load();
  second.resolve(source(subject(), [row('new')])); await b;
  first.resolve({status: 'denied', data: source(subject()).data}); await a;
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(controller.getSnapshot().sourceResource.data.entries.map(item => item.entry_ref), ['new']);
});

test('scope, mode and source identity changes erase drafts and ignore late source results', async () => {
  for (const next of [subject('ordinary', {scopeKey: 'another:scope'}), subject('missing'),
    subject('ordinary', {source: {...subject().source, ref: 'another:source'}})]) {
    const pending = deferred();
    const controller = setup({readPlaylistCreationSource: () => pending.promise});
    controller.edit({title: 'Private draft'}); const loading = controller.load();
    controller.setContext(next); pending.resolve(source(subject())); await loading;
    assert.equal(controller.getSnapshot().title, '');
    assert.equal(controller.getSnapshot().sourceResource.data, null);
    assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  }
});

test('revision-only conflict preserves metadata but explicit reload requires a new selection', async () => {
  const controller = await ready({}, subject('missing'));
  controller.edit({description: 'Typed description'});
  const next = subject('missing'); next.source.revision = 'revision:two';
  controller.setContext(next);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.getSnapshot().title, 'My playlist');
  assert.equal(controller.getSnapshot().description, 'Typed description');
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(await controller.submit(), false);
  await controller.load();
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(model.canSubmitCreation(controller.getSnapshot()), false);
  assert.equal(controller.toggle('entry:a'), true);
  assert.equal(model.canSubmitCreation(controller.getSnapshot()), true);
});

test('explicit source reload invalidates old selections even without a new revision', async () => {
  const controller = await ready({}, subject('missing'));
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:a', 'entry:b']);
  await controller.load();
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(controller.getSnapshot().title, 'My playlist');
});

test('parent refresh pauses source authority until fresh same-context approval and explicit reload', async () => {
  let reads = 0, writes = 0;
  const controller = await ready({readPlaylistCreationSource: async request => {reads++; return source(request);},
    createPlaylistFromSelection: async request => {writes++; return ack(request);}}, subject('missing'));
  controller.edit({description: 'Typed detail'}); controller.review('entry:a');
  const originalSource = controller.getSnapshot().source;
  assert.equal(controller.pauseSource(), true);
  const paused = controller.getSnapshot();
  assert.equal(paused.source, originalSource);
  assert.equal(paused.sourceResource.status, 'loading');
  assert.equal(paused.sourceResource.data, null);
  assert.deepEqual(paused.selectedKeys, []);
  assert.equal(paused.reviewKey, null);
  assert.equal(paused.title, 'My playlist');
  assert.equal(paused.description, 'Typed detail');
  assert.equal(model.canSubmitCreation(paused), false);
  assert.equal(await controller.load(), false);
  assert.equal(await controller.submit(), false);
  assert.equal(reads, 1); assert.equal(writes, 0);
  assert.equal(controller.edit({description: 'Edited while waiting'}), true);
  assert.equal(controller.setContext(subject('missing')), true);
  assert.equal(controller.getSnapshot().sourceResource.status, 'refresh_required');
  assert.equal(await controller.submit(), false);
  assert.equal(await controller.load(), true);
  assert.equal(reads, 2);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(controller.getSnapshot().description, 'Edited while waiting');
  controller.toggle('entry:a');
  assert.equal(model.canSubmitCreation(controller.getSnapshot()), true);
});

test('paused parent refresh preserves revision conflict metadata and never restores initial selections', async () => {
  const controller = await ready({}, subject('missing'));
  controller.edit({description: 'Keep this'}); controller.pauseSource('error');
  const revised = subject('missing'); revised.source.revision = 'revision:two';
  controller.setContext(revised);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.getSnapshot().title, 'My playlist');
  assert.equal(controller.getSnapshot().description, 'Keep this');
  assert.equal(await controller.load(), true);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(model.canSubmitCreation(controller.getSnapshot()), false);
});

test('pausing an unfinished first read retires its result and missing-mode auto-selection', async () => {
  const old = deferred(); let reads = 0, oldSignal;
  const controller = setup({readPlaylistCreationSource: request => {
    reads++;
    if (reads === 1) {oldSignal = request.signal; return old.promise;}
    return Promise.resolve(source(request, [row('fresh')]));
  }}, subject('missing'));
  controller.edit({title: 'Typed before source'});
  const pending = controller.load(); controller.pauseSource('unavailable');
  assert.equal(oldSignal.aborted, true);
  assert.equal(await controller.load(), false);
  controller.setContext(subject('missing')); await controller.load();
  old.resolve(source(subject('missing'), [row('retired')]));
  assert.equal(await pending, false);
  assert.deepEqual(controller.getSnapshot().sourceResource.data.entries.map(item => item.entry_ref), ['fresh']);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  assert.equal(controller.getSnapshot().title, 'Typed before source');
});

test('paused pending write retains its operation lock across same and revised source context', async () => {
  const pending = deferred(); let received, writes = 0;
  const controller = await ready({createPlaylistFromSelection: request => {writes++; received = request; return pending.promise;}});
  controller.toggle('entry:a');
  const writing = controller.submit(), requestKey = received.request_key;
  controller.pauseSource('loading');
  assert.equal(received.signal.aborted, true);
  assert.deepEqual(controller.getSnapshot().mutation, {status: 'error', request_key: requestKey, data: null});
  assert.equal(controller.getSnapshot().title, 'My playlist');
  assert.equal(controller.getSnapshot().sourceResource.data, null);
  controller.setContext(subject());
  assert.equal(controller.getSnapshot().sourceResource.status, 'refresh_required');
  assert.equal(await controller.submit(), false);
  assert.equal(await controller.load(), false);
  const revised = subject(); revised.source.revision = 'revision:two'; controller.setContext(revised);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.getSnapshot().mutation.request_key, requestKey);
  assert.equal(await controller.submit(), false);
  pending.resolve(ack(received));
  assert.equal(await writing, false);
  assert.equal(controller.getSnapshot().mutation.status, 'error');
  assert.equal(controller.getSnapshot().mutation.data, null);
  assert.equal(writes, 1);
});

test('revision-only invalidation of an in-flight write also retains its unconfirmed operation key', async () => {
  const pending = deferred(); let received;
  const controller = await ready({createPlaylistFromSelection: request => {received = request; return pending.promise;}});
  const writing = controller.submit();
  const revised = subject(); revised.source.revision = 'revision:two'; controller.setContext(revised);
  assert.equal(received.signal.aborted, true);
  assert.deepEqual(controller.getSnapshot().mutation, {status: 'error', request_key: received.request_key, data: null});
  assert.equal(controller.getSnapshot().title, 'My playlist');
  assert.equal(await controller.submit(), false);
  pending.resolve(ack(received)); assert.equal(await writing, false);
  assert.equal(controller.getSnapshot().mutation.status, 'error');
});

test('pause statuses are bounded and repeated pauses cannot revoke denial or revive disposed state', async () => {
  const controller = await ready();
  for (const status of ['loading', 'error', 'unavailable', 'refresh_required']) {
    assert.equal(controller.pauseSource(status), true);
    const paused = controller.getSnapshot();
    assert.equal(controller.pauseSource(status), false);
    assert.equal(controller.getSnapshot(), paused);
    assert.equal(await controller.load(), false);
    assert.equal(await controller.submit(), false);
  }
  const paused = controller.getSnapshot();
  assert.equal(controller.pauseSource('ready'), false);
  assert.equal(controller.pauseSource('denied'), false);
  assert.equal(controller.getSnapshot(), paused);
  controller.setContext(subject('ordinary', {canCreate: false}));
  assert.equal(controller.getSnapshot().title, '');
  assert.equal(controller.getSnapshot().sourceResource.status, 'denied');
  assert.equal(controller.pauseSource(), false);
  controller.dispose(); assert.equal(controller.pauseSource(), false);
});

test('new actor after a pause erases the retained draft instead of releasing old source authority', async () => {
  const controller = await ready(); controller.pauseSource('error');
  controller.setContext(subject('ordinary', {scopeKey: 'another:actor'}));
  assert.equal(controller.getSnapshot().title, '');
  assert.equal(controller.getSnapshot().description, '');
  assert.equal(controller.getSnapshot().sourceResource.data, null);
  assert.equal(controller.getSnapshot().sourceResource.status, 'unavailable');
  assert.equal(controller.getSnapshot().mutation.request_key, null);
});

test('reentrant pause during source loading aborts before invoking the reader', async () => {
  let reads = 0;
  const controller = setup({readPlaylistCreationSource: async request => {reads++; return source(request);}});
  controller.subscribe(() => {if (controller.getSnapshot().sourceResource.status === 'loading') controller.pauseSource();});
  assert.equal(await controller.load(), false);
  assert.equal(reads, 0);
  assert.equal(controller.getSnapshot().sourceResource.data, null);
});

test('grant revocation, provider disposal and denied reads remove all draft source facts', async () => {
  const controller = await ready({}, subject('missing'));
  controller.review('entry:a'); controller.setContext(subject('missing', {canCreate: false}));
  assert.equal(controller.getSnapshot().title, '');
  assert.equal(controller.getSnapshot().reviewKey, null);
  assert.equal(controller.getSnapshot().sourceResource.data, null);
  const old = deferred(), retiring = setup({readPlaylistCreationSource: () => old.promise});
  const pending = retiring.load(); retiring.dispose(); old.resolve(source(subject())); await pending;
  assert.equal(retiring.getSnapshot().scopeKey, null);
  assert.equal(retiring.getSnapshot().sourceResource.data, null);
  const replacement = await ready(); assert.equal(replacement.getSnapshot().title, 'My playlist');
  let denied = false;
  const reader = setup({readPlaylistCreationSource: async request => {
    if (denied) throw Object.assign(new Error('private diagnostics'), {status: 403});
    return source(request);
  }});
  await reader.load(); reader.edit({title: 'Private draft'}); reader.toggle('entry:a'); denied = true; await reader.load();
  assert.equal(reader.getSnapshot().sourceResource.status, 'denied');
  assert.equal(reader.getSnapshot().title, '');
  assert.equal(JSON.stringify(reader.getSnapshot()).includes('private diagnostics'), false);
});

test('search and visible bulk selection preserve hidden choices and actual Selected order', async () => {
  const controller = await ready();
  controller.toggle('entry:b'); controller.setQuery('Track a'); controller.selectVisible(true);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:b', 'entry:a']);
  assert.equal(model.projectCreationState(controller.getSnapshot()).visibleSelectedCount, 1);
  controller.setTab('selected');
  assert.deepEqual(model.projectCreationState(controller.getSnapshot()).entries.map(item => item.entry_ref), ['b', 'a']);
  controller.toggle('entry:b');
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:a']);
  controller.setQuery('Track local');
  assert.equal(controller.getSnapshot().tab, 'all');
  controller.selectVisible(false);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:a']);
});

test('Review accepts readable source rows only and invokes no persisted item integrations', async () => {
  let forbidden = 0;
  const controller = await ready({readMatches() {forbidden++;}, acceptMatch() {forbidden++;}, playPlaylist() {forbidden++;},
    readPlaylistCreationSource: async request => source(request, [row('unknown'), row(null), row('denied', {allowed_actions: {can_read: false}})])});
  assert.equal(controller.review('entry:unknown'), true);
  assert.equal(controller.getSnapshot().reviewKey, 'entry:unknown');
  assert.equal(controller.review('projection:1'), true);
  assert.equal(controller.review('projection:2'), false);
  assert.equal(controller.review('entry:absent'), false);
  assert.equal(controller.review(null), true);
  assert.equal(forbidden, 0);
});

test('repeated Create sends exactly one whitelisted ordered request and stays busy until acknowledgement', async () => {
  const pending = deferred(); let calls = 0, received;
  const controller = await ready({createPlaylistFromSelection(request) {calls++; received = request; return pending.promise;}});
  controller.toggle('entry:b'); controller.toggle('entry:a');
  const writing = controller.submit();
  assert.equal(controller.getSnapshot().mutation.status, 'loading');
  assert.equal(await controller.submit(), false);
  assert.equal(controller.edit({title: 'Changed while writing'}), false);
  assert.equal(controller.toggle('entry:a'), false);
  assert.equal(await controller.load(), false);
  assert.equal(calls, 1);
  assert.deepEqual(received.entry_refs, ['b', 'a']);
  assert.deepEqual(Object.keys(received).sort(), ['scopeKey', 'playlist_id', 'mode', 'source', 'title', 'description', 'entry_refs', 'request_key', 'signal'].sort());
  assert.equal(typeof received.request_key, 'string');
  assert.ok(received.request_key.length > 0);
  assert.equal(JSON.stringify(received).includes('retained'), false);
  pending.resolve(ack(received));
  assert.deepEqual(await writing, ack(received).data);
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(await controller.submit(), false);
  assert.equal(calls, 1);
});

test('invalid and negative acknowledgements never report a confirmed creation or retry the write', async () => {
  const variants = [() => undefined, () => ({}), () => ({ok: true}), () => false,
    request => ({...ack(request), ok: false}),
    request => ({...ack(request), status: 'unavailable'}), request => ({...ack(request), status: 409}),
    request => ({status: 'ready', data: {...ack(request).data, request_key: 'other'}}),
    request => ({status: 'ready', data: {...ack(request).data, scopeKey: 'other'}}),
    request => ({status: 'ready', data: {...ack(request).data, playlist_id: ''}}),
    request => ({status: 'ready', data: {...ack(request).data, revision: undefined}}),
    request => ({status: 'ready', data: Object.create(ack(request).data)})];
  for (const make of variants) {
    let calls = 0;
    const controller = await ready({createPlaylistFromSelection: async request => {calls++; return make(request);}});
    assert.equal(await controller.submit(), false);
    assert.notEqual(controller.getSnapshot().mutation.status, 'ready');
    assert.ok(controller.getSnapshot().mutation.request_key);
    assert.equal(await controller.submit(), false); assert.equal(calls, 1);
  }
});

test('ambiguous provider timeout preserves the operation key and draft without any retry', async () => {
  let calls = 0, requestKey;
  const controller = await ready({createPlaylistFromSelection: async request => {
    calls++; requestKey = request.request_key; throw new Error('Timeout after possible commit');
  }});
  controller.toggle('entry:a');
  assert.equal(await controller.submit(), false);
  assert.equal(controller.getSnapshot().mutation.status, 'error');
  assert.equal(controller.getSnapshot().mutation.request_key, requestKey);
  assert.equal(controller.getSnapshot().title, 'My playlist');
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:a']);
  assert.equal(await controller.submit(), false);
  assert.equal(calls, 1);
});

test('write denial erases draft and private source data while retaining unconfirmed operation identity', async () => {
  const controller = await ready({createPlaylistFromSelection: async request => ({status: 'denied', data: ack(request).data})});
  controller.toggle('entry:a');
  assert.equal(await controller.submit(), false);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.mutation.status, 'denied');
  assert.ok(snapshot.mutation.request_key);
  assert.equal(snapshot.mutation.data, null);
  assert.equal(snapshot.title, '');
  assert.equal(snapshot.sourceResource.data, null);
  assert.deepEqual(snapshot.selectedKeys, []);
});

test('late acknowledged write cannot complete a revoked, replaced or disposed session', async () => {
  for (const invalidate of [controller => controller.setContext(subject('ordinary', {scopeKey: 'different'})),
    controller => controller.setContext(subject('ordinary', {canCreate: false})), controller => controller.dispose()]) {
    const pending = deferred(); let received;
    const controller = await ready({createPlaylistFromSelection: request => {received = request; return pending.promise;}});
    const writing = controller.submit(); invalidate(controller);
    assert.equal(received.signal.aborted, true);
    pending.resolve(ack(received));
    assert.equal(await writing, false);
    assert.notEqual(controller.getSnapshot().mutation.status, 'ready');
    assert.equal(controller.getSnapshot().sourceResource.data, null);
  }
});

test('subscriber invalidation during loading prevents unauthorized read or write invocation', async () => {
  let reads = 0, writes = 0;
  const controller = setup({readPlaylistCreationSource: async request => {reads++; return source(request);}});
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().sourceResource.status === 'loading') controller.setContext(subject('ordinary', {canCreate: false}));
  });
  assert.equal(await controller.load(), false); assert.equal(reads, 0); unsubscribe();
  const writer = await ready({createPlaylistFromSelection: async request => {writes++; return ack(request);}});
  writer.subscribe(() => {if (writer.getSnapshot().mutation.status === 'loading') writer.dispose();});
  assert.equal(await writer.submit(), false); assert.equal(writes, 0);
});

test('subscriber invalidation at acknowledgement suppresses completion for the retired owner', async () => {
  const controller = await ready();
  controller.subscribe(() => {if (controller.getSnapshot().mutation.status === 'ready') controller.setContext(subject('ordinary', {scopeKey: 'next:scope'}));});
  assert.equal(await controller.submit(), false);
  assert.equal(controller.getSnapshot().scopeKey, 'next:scope');
  assert.equal(controller.getSnapshot().mutation.status, 'idle');
});

test('snapshots remain stable until a change and disposal prevents every public mutation', async () => {
  const controller = await ready();
  const snapshot = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(Object.isFrozen(snapshot.selectedKeys), true);
  controller.dispose();
  assert.equal(controller.pauseSource(), false);
  assert.equal(controller.setContext(subject()), false);
  assert.equal(controller.edit({title: 'Later'}), false);
  assert.equal(controller.setQuery('Later'), false);
  assert.equal(controller.setTab('selected'), false);
  assert.equal(controller.toggle('entry:a'), false);
  assert.equal(controller.selectVisible(true), false);
  assert.equal(controller.review(null), false);
  assert.equal(await controller.load(), false);
  assert.equal(await controller.submit(), false);
  assert.equal(controller.getSnapshot().sourceResource.data, null);
});

test('ordinary initial seed requires the exact complete read receipt and cannot revive after reload or user choice', async () => {
  const controller = setup(); await controller.load();
  const read = controller.getSnapshot().sourceResource;
  assert.equal(controller.seed(['b', 'a'], {...read}), false);
  assert.equal(controller.seed(['missing'], read), false);
  assert.equal(controller.seed(['a', 'a'], read), false);
  assert.equal(controller.seed(['b', 'a'], read), true);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:b', 'entry:a']);
  assert.equal(controller.getSnapshot().dirty, false);
  assert.equal(controller.seed(['a'], read), false);
  await controller.load(); assert.equal(controller.seed(['b'], read), false);
  assert.equal(controller.seed(['b'], controller.getSnapshot().sourceResource), false);
  controller.dispose();
  const chosen = setup(); await chosen.load(); chosen.toggle('entry:a');
  assert.equal(chosen.seed(['b'], chosen.getSnapshot().sourceResource), false); chosen.dispose();
  const missing = setup({}, subject('missing')); await missing.load();
  assert.equal(missing.seed(['a'], missing.getSnapshot().sourceResource), false); missing.dispose();
});
