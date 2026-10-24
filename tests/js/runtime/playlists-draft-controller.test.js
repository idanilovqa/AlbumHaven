const test = require('node:test');
const assert = require('node:assert/strict');
let creation, draft;
test.before(async () => {
  creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  draft = await import('../../../music_app/static/js/playlists/draft.mjs');
});
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const context = (patch = {}) => ({scopeKey: 'draft-controller:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
  source: {kind: 'playlist', ref: 'draft-controller:source', revision: 'revision:one',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}, ...patch});
const row = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Synthetic artist',
  album_title: 'Synthetic album', availability: 'unresolved', allowed_actions: {can_read: true, can_select: true},
  parent_album: {state: 'known', album_ref: `parent:${entry_ref}`, title: 'Synthetic album',
    allowed_actions: {can_read: true, can_create_album_top: true}}, ...patch});
const response = (request, rows = [row('a'), row('b'), row('c')]) => ({status: 'ready', data: {
  scopeKey: request.scopeKey, mode: 'missing', source: request.source, allowed_actions: {can_read: true, can_use_for_playlist: true},
  entries_complete: true, entries: rows, retained_parent_albums: [],
}});
const ack = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'persisted:real-playlist', revision: 'persisted:revision'}});
const setup = async (providers = {}, rows) => {
  const supplied = {readPlaylistCreationSource: async request => response(request, rows),
    createPlaylistFromSelection: async request => ack(request), ...providers};
  const form = creation.createPlaylistCreationController({providers: supplied});
  form.setContext(context()); await form.load(); form.edit({title: 'Unsaved draft', description: 'My draft description'});
  const prepared = form.prepareDraft();
  const controller = draft.createMissingPlaylistDraftController({prepared, providers: supplied});
  controller.setContext(context()); return {form, prepared, controller, providers: supplied};
};

test('missing Create prepares one stable unsaved packet with zero writer calls; Save writes once in current retained order', async () => {
  const pending = deferred(); let calls = 0, received;
  const {form, controller} = await setup({createPlaylistFromSelection: request => {calls++; received = request; return pending.promise;}});
  assert.equal(await form.submit(), false); assert.equal(calls, 0);
  assert.equal(form.prepareDraft(), form.prepareDraft());
  assert.equal(controller.getSnapshot().mutation.status, 'idle');
  assert.equal(own(controller.getSnapshot(), 'playlist_id'), false);
  controller.reorder(['entry:c', 'entry:a', 'entry:b']); controller.remove('entry:a');
  controller.edit({title: 'Edited before Save'}); assert.equal(calls, 0);
  const saving = controller.save();
  assert.equal(calls, 1); assert.deepEqual(received.entry_refs, ['c', 'b']);
  assert.equal(received.title, 'Edited before Save'); assert.equal(received.playlist_id, null);
  assert.deepEqual(Object.keys(received).sort(), ['scopeKey', 'mode', 'source', 'playlist_id', 'title', 'description', 'entry_refs', 'request_key', 'signal'].sort());
  for (const forbidden of ['draftToken', 'parent:', 'canonical_track_ref', 'retained_parent_albums']) assert.equal(JSON.stringify(received).includes(forbidden), false);
  assert.equal(await controller.save(), false); assert.equal(controller.edit({title: 'Too late'}), false);
  assert.equal(controller.remove('entry:b'), false); assert.equal(await controller.refresh(), false);
  pending.resolve(ack(received)); assert.deepEqual(await saving, ack(received).data);
  assert.equal(controller.getSnapshot().mutation.status, 'ready'); assert.equal(await controller.save(), false);
  assert.equal(calls, 1);
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test('reader-only missing form can prepare and edit a draft, but Save is unavailable without the item-aware writer', async () => {
  let reads = 0, fallback = 0;
  const providers = {readPlaylistCreationSource: async request => {reads++; return response(request);}, createPlaylist() {fallback++;}};
  const form = creation.createPlaylistCreationController({providers}); form.setContext(context());
  assert.equal(await form.load(), true); form.edit({title: 'Reader only'});
  const prepared = form.prepareDraft(); assert.ok(prepared);
  assert.equal(await form.submit(), false);
  const controller = draft.createMissingPlaylistDraftController({prepared, providers});
  assert.equal(controller.edit({description: 'Still unsaved'}), true);
  assert.equal(controller.canSave(), false); assert.equal(await controller.save(), false);
  assert.equal(reads, 1); assert.equal(fallback, 0);
});

test('empty drafts and invalid metadata cannot save after removing the final original', async () => {
  let writes = 0;
  const {controller} = await setup({createPlaylistFromSelection() {writes++;}}, [row('a')]);
  controller.edit({title: ' '}); assert.equal(controller.canSave(), false);
  controller.edit({title: 'Valid'}); controller.remove('entry:a');
  assert.equal(controller.canSave(), false); assert.equal(await controller.save(), false);
  assert.equal(controller.exportText(), ''); assert.equal(controller.topIntent(), null); assert.equal(writes, 0);
});

test('reorder is an exact full occurrence permutation and selection never authorizes fabricated entries', async () => {
  const {controller} = await setup();
  for (const keys of [[], ['entry:a'], ['entry:a', 'entry:a', 'entry:c'], ['entry:a', 'entry:b', 'entry:invented'], Array(3)]) {
    assert.equal(controller.reorder(keys), false);
  }
  assert.equal(controller.remove('entry:invented'), false); assert.equal(controller.select('entry:invented'), false);
  controller.toggle('entry:c'); controller.setQuery('Original a'); controller.selectVisible(true);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:c', 'entry:a']);
  controller.remove(); assert.deepEqual(controller.getSnapshot().entries.map(item => item.entry_ref), ['b']);
  controller.setQuery(''); assert.equal(controller.exportText(), 'Synthetic artist - Original b [Synthetic album]');
});

test('current source refresh removes confirmed local and unreadable originals without adding removed or new source entries', async () => {
  let fresh = false;
  const {controller} = await setup({readPlaylistCreationSource: async request => response(request, fresh
    ? [row('a', {availability: 'local'}), row('b'), row('c', {title: 'Secret title', allowed_actions: {can_read: false, can_select: true}}), row('d')]
    : [row('a'), row('b'), row('c'), row('e')])});
  controller.reorder(['entry:c', 'entry:e', 'entry:b', 'entry:a']); controller.remove('entry:b');
  fresh = true; assert.equal(await controller.refresh(), true);
  assert.deepEqual(controller.getSnapshot().entries, []); assert.equal(controller.exportText(), '');
  assert.equal(controller.topIntent(), null); assert.equal(JSON.stringify(controller.getSnapshot()).includes('Secret title'), false);
});

test('revision conflict preserves authored order and typed metadata until explicit authorized refresh', async () => {
  const {controller} = await setup();
  controller.reorder(['entry:c', 'entry:a', 'entry:b']); controller.remove('entry:a');
  const revised = context(); revised.source.revision = 'revision:two';
  assert.equal(controller.setContext(revised), true);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.getSnapshot().title, 'Unsaved draft'); assert.deepEqual(controller.getSnapshot().entries, []);
  assert.equal(controller.exportText(), ''); assert.equal(controller.canSave(), false);
  assert.equal(await controller.refresh(), true);
  assert.deepEqual(controller.getSnapshot().entries.map(item => item.entry_ref), ['c', 'b']);
  assert.equal(controller.getSnapshot().source.revision, 'revision:two'); assert.equal(controller.canSave(), true);
});

test('parent pause removes visible source facts and needs live same-owner context before refresh', async () => {
  const {controller} = await setup();
  controller.remove('entry:a'); assert.equal(controller.pauseSource(), true);
  assert.equal(controller.getSnapshot().sourceResource.data, null); assert.equal(controller.exportText(), '');
  assert.equal(await controller.refresh(), false); assert.equal(controller.canSave(), false);
  assert.equal(controller.setContext(context()), true);
  assert.equal(controller.getSnapshot().sourceResource.status, 'refresh_required');
  assert.equal(await controller.refresh(), true);
  assert.deepEqual(controller.getSnapshot().entries.map(item => item.entry_ref), ['b', 'c']);
});

test('exact Top grant revocation takes effect without destroying unsaved edits or invoking any provider', async () => {
  let calls = 0;
  const {controller} = await setup({openAlbumTopDraft() {calls++;}, createAlbumTop() {calls++;}});
  controller.edit({title: 'Retained across Top return'}); controller.remove('entry:a');
  const saved = controller.getSnapshot(); assert.deepEqual(controller.topIntent().album_refs, ['parent:b', 'parent:c']);
  assert.equal(controller.getSnapshot(), saved); assert.equal(calls, 0);
  controller.setContext({...context(), canCreateAlbumTop: false}); assert.equal(controller.topIntent(), null);
  controller.setContext(context()); assert.deepEqual(controller.topIntent().album_refs, ['parent:b', 'parent:c']);
  assert.equal(controller.getSnapshot().title, 'Retained across Top return'); assert.equal(calls, 0);
});

test('later parent grant revocation cannot reuse earlier retained Top evidence', async () => {
  let revoked = false;
  const {controller} = await setup({readPlaylistCreationSource: async request => response(request, [row('a', {
    parent_album: {state: 'known', album_ref: 'parent:a', allowed_actions: {can_read: true, can_create_album_top: !revoked}},
  })])});
  assert.deepEqual(controller.topIntent().album_refs, ['parent:a']); revoked = true;
  await controller.refresh(); assert.equal(controller.topIntent(), null); assert.equal(controller.getSnapshot().entries.length, 1);
});

test('actor, source, grant and provider replacement erase all private draft facts and cannot revive the controller', async () => {
  for (const change of [value => value.setContext(context({scopeKey: 'different:actor'})),
    value => value.setContext(context({source: {...context().source, ref: 'other:source'}})),
    value => value.setContext(context({canCreate: false})),
    value => value.setContext(context({source: {...context().source, allowed_actions: {can_read: false, can_use_for_playlist: true}}})),
    value => value.configure({readPlaylistCreationSource: async request => response(request)})]) {
    const {controller} = await setup(); change(controller);
    assert.equal(controller.getSnapshot().scopeKey, null); assert.equal(controller.getSnapshot().source, null);
    assert.equal(controller.getSnapshot().title, ''); assert.deepEqual(controller.getSnapshot().entries, []);
    assert.equal(controller.getSnapshot().sourceResource.data, null); assert.equal(controller.exportText(), '');
    assert.equal(controller.setContext(context()), false); assert.equal(await controller.refresh(), false);
  }
});

test('reader denial erases private draft facts and suppressed stale responses cannot restore them', async () => {
  let denied = false;
  const {controller} = await setup({readPlaylistCreationSource: async request => denied ? {status: 'denied'} : response(request)});
  denied = true; assert.equal(await controller.refresh(), false); assert.equal(controller.getSnapshot().title, '');
  assert.equal(controller.getSnapshot().sourceResource.status, 'denied');
  const pending = deferred(); let asynchronous = false, signal;
  const later = await setup({readPlaylistCreationSource: request => {
    if (!asynchronous) return response(request); signal = request.signal; return pending.promise;
  }});
  asynchronous = true; const reading = later.controller.refresh(); later.controller.setContext(context({canCreate: false}));
  assert.equal(signal.aborted, true); pending.resolve(response(context())); assert.equal(await reading, false);
  assert.equal(later.controller.getSnapshot().sourceResource.data, null);
});

test('mutating the supplied provider container cannot change a live writer without retiring its owner', async () => {
  const {controller, providers} = await setup();
  let replacementCalls = 0;
  providers.createPlaylistFromSelection = async request => {replacementCalls++; return ack(request);};
  assert.equal(controller.configure(providers), true);
  assert.equal(controller.getSnapshot().sourceResource.status, 'unavailable');
  assert.equal(controller.getSnapshot().title, ''); assert.equal(await controller.save(), false);
  assert.equal(replacementCalls, 0);
});

test('ambiguous failures and inexact acknowledgements retain the submitted operation key and never retry Save', async () => {
  const variants = [() => {throw new Error('Possible commit; private provider diagnostics');}, () => undefined,
    request => ({...ack(request), status: 409}), request => ({...ack(request), ok: false}),
    request => ({status: 'ready', data: {...ack(request).data, request_key: 'other'}}),
    request => ({status: 'ready', data: {...ack(request).data, scopeKey: 'other'}}),
    request => ({status: 'ready', data: {...ack(request).data, playlist_id: 'file:///private'}}),
    request => ({status: 'ready', data: {...ack(request).data, revision: ''}}),
    request => ({status: 'ready', data: Object.create(ack(request).data)})];
  for (const make of variants) {
    let writes = 0, received;
    const {controller} = await setup({createPlaylistFromSelection: async request => {writes++; received = request; return make(request);}});
    assert.equal(await controller.save(), false);
    assert.equal(controller.getSnapshot().mutation.request_key, received.request_key);
    assert.equal(controller.getSnapshot().mutation.data, null); assert.equal(controller.getSnapshot().title, 'Unsaved draft');
    assert.equal(await controller.save(), false); assert.equal(await controller.refresh(), false); assert.equal(writes, 1);
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('private provider diagnostics'), false);
  }
});

test('Save denial clears the draft and keeps its unconfirmed operation token for reconciliation', async () => {
  let requestKey;
  const {controller} = await setup({createPlaylistFromSelection: async request => {requestKey = request.request_key; return {status: 403};}});
  assert.equal(await controller.save(), false);
  assert.deepEqual(controller.getSnapshot().mutation, {status: 'denied', request_key: requestKey, data: null});
  assert.equal(controller.getSnapshot().title, ''); assert.equal(controller.getSnapshot().source, null);
});

test('a provider cannot acknowledge the local presentation token as a persisted playlist identity', async () => {
  let token;
  const {controller, prepared} = await setup({createPlaylistFromSelection: async request => ({status: 'ready',
    data: {...ack(request).data, playlist_id: token}})});
  token = prepared.draftToken;
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().mutation.data, null);
  assert.ok(controller.getSnapshot().mutation.request_key);
});

test('revision or parent invalidation during Save keeps the unknown write key and suppresses late acknowledgement', async () => {
  for (const change of [controller => controller.pauseSource('loading'), controller => {
    const revised = context(); revised.source.revision = 'revision:two'; controller.setContext(revised);
  }]) {
    const pending = deferred(); let received;
    const {controller} = await setup({createPlaylistFromSelection: request => {received = request; return pending.promise;}});
    const saving = controller.save(); change(controller);
    assert.equal(received.signal.aborted, true);
    assert.equal(controller.getSnapshot().mutation.request_key, received.request_key);
    assert.equal(controller.getSnapshot().mutation.status, 'error');
    pending.resolve(ack(received)); assert.equal(await saving, false);
    assert.equal(await controller.save(), false); assert.equal(await controller.refresh(), false);
  }
});

test('subscriber revocation before provider dispatch or at acknowledgement prevents stale completion', async () => {
  let writes = 0;
  const before = await setup({createPlaylistFromSelection: async request => {writes++; return ack(request);}});
  before.controller.subscribe(() => {
    if (before.controller.getSnapshot().mutation.status === 'loading') before.controller.setContext(context({canCreate: false}));
  });
  assert.equal(await before.controller.save(), false); assert.equal(writes, 0);
  const after = await setup();
  after.controller.subscribe(() => {if (after.controller.getSnapshot().mutation.status === 'ready') after.controller.dispose();});
  assert.equal(await after.controller.save(), false); assert.equal(after.controller.getSnapshot().sourceResource.data, null);
});

test('snapshot is immutable and disposal blocks every editor, provider and export command', async () => {
  const {controller, providers} = await setup(); const snapshot = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), snapshot); assert.equal(Object.isFrozen(snapshot.entries), true);
  controller.dispose();
  for (const command of [() => controller.edit({title: 'Later'}), () => controller.setQuery('Later'), () => controller.setFilters({love: 'loved'}),
    () => controller.select(null), () => controller.toggle('entry:a'), () => controller.selectVisible(true), () => controller.remove('entry:a'),
    () => controller.reorder(['entry:a']), () => controller.setContext(context()), () => controller.configure(providers), () => controller.pauseSource()]) {
    assert.equal(command(), false);
  }
  assert.equal(await controller.refresh(), false); assert.equal(await controller.save(), false);
  assert.equal(controller.exportText(), ''); assert.equal(controller.topIntent(), null);
});
