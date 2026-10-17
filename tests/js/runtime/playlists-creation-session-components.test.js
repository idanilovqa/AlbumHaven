const test = require('node:test');
const assert = require('node:assert/strict');
const {sessionDom, deferred, settle} = require('./playlist-native-session-migration-fixture.cjs');
let model, mountSession, mountAction;
test.before(async t => {
  model = await import('../../../music_app/static/js/playlists/model.mjs');
  ({mountPlaylistCreationSession: mountSession} = await import('../../../music_app/static/js/playlists/native-creation-session.mjs'));
  ({mountPlaylistActionSession: mountAction} = await import('../../../music_app/static/js/playlists/native-selection-actions.mjs'));
});
const plain = value => JSON.parse(JSON.stringify(value));
const descriptor = (revision = 'source-r1') => ({kind: 'library', ref: 'catalog:session-test', revision,
  allowed_actions: {can_read: true, can_use_for_playlist: true}});
const directory = ({revision = 'source-r1', created = false} = {}) => ({playlist_sidebar: {items: []},
  playlist_index: {playlists: created ? [{playlist_id: 'created:session-test', title: 'Authoritative created playlist',
    allowed_actions: {can_open: true}}] : []},
  playlist_actions: {can_create: true}, playlist_creation_source: descriptor(revision)});
const missingPlaylistId = 'source:session-test';
const missingDirectory = ({revision = 'source-r1', sourceRef = missingPlaylistId, canCreate = true, canUse = true} = {}) => ({
  playlist_sidebar: {items: [{playlist_id: missingPlaylistId, title: 'Source playlist', allowed_actions: {can_open: true}}]},
  playlist_actions: {can_create: canCreate},
  playlist_detail: {playlist_id: missingPlaylistId, title: 'Source playlist', revision, track_rows: [], items_complete: true,
    allowed_actions: {can_open: true, can_create_album_top: true},
    missing_playlist_creation_source: {kind: 'playlist', ref: sourceRef, revision,
      allowed_actions: {can_read: true, can_use_for_playlist: canUse}}},
});
const sourceResult = request => ({status: 'ready', data: {scopeKey: request.scopeKey, mode: request.mode,
  source: request.source, allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true,
  entries: [{entry_ref: 'occurrence:private', canonical_track_ref: null, title: 'Private source title', artist: 'Private source artist',
    metadata_state: 'unknown', availability: 'missing', allowed_actions: {can_read: true, can_select: true},
    parent_album: {state: 'known', album_ref: 'album:private', title: 'Private album', allowed_actions: {can_view_details: true}}}],
  retained_parent_albums: []}});
const acknowledgement = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'created:session-test', revision: 'created-r1'}});

function sessionFixture(t, {mode = 'ordinary', playlists, readSource, write, refresh, onClose, onPrepareDraft, confirm} = {}) {
  const h = sessionDom(), reads = [], writes = [], refreshes = [], navigations = [], drafts = [], notices = [];
  const refreshEntered = deferred();
  const ownsParent = !playlists;
  let owner, disposed = false;
  const dispose = () => {if (!disposed) {disposed = true; owner?.dispose();}};
  // Register before model/native acquisition and before the first await.
  t.after(async () => {
    try {dispose();}
    finally {
      try {if (ownsParent) playlists?.dispose();}
      finally {h.closing.resolve(false); await settle();}
    }
  });
  if (!playlists) {
    playlists = model.createPlaylistController({readPlaylists: request => {
      refreshes.push(request); refreshEntered.resolve();
      return refresh ? refresh(request) : mode === 'missing' ? missingDirectory() : directory({created: true});
    }});
    playlists.setScope('account:session-test');
    playlists.accept(mode === 'missing' ? missingDirectory() : directory(), mode === 'missing' ? missingPlaylistId : null);
  }
  const providers = {
    readPlaylistCreationSource: request => {reads.push(request); return readSource ? readSource(request) : sourceResult(request);},
    createPlaylistFromSelection: request => {writes.push(request); return write ? write(request) : acknowledgement(request);},
  };
  h.runtime.confirm = confirm;
  const props = () => ({controller: playlists, state: playlists.getSnapshot(), mode, providers, onClose,
    onNavigate: id => navigations.push(id), onNotice: text => notices.push(text),
    onPrepareDraft: packet => {drafts.push(packet); return onPrepareDraft ? onPrepareDraft(packet) : true;}});
  owner = mountSession(h.host, h.runtime, props());
  return {...h, playlists, reads, writes, refreshes, navigations, drafts, notices, refreshEntered, owners: h.forms,
    render() {assert.equal(disposed, false); owner.update(props()); return h.form();},
    dispose,
  };
}
function fill(f) {
  f.edit('Keep my title', 'Keep my description');
  assert.equal(f.field('Playlist name').value, 'Keep my title');
  assert.equal(f.field('Playlist description').value, 'Keep my description');
  // Ordinary search is explicit before selecting the real source checkbox.
  f.input(f.body().querySelector('input[type="search"]'), 'Private source');
  const row = f.picks()[0]; assert.ok(row);
  if (!f.selected().includes(row.dataset.creationPick)) f.toggle(row.dataset.creationPick);
  f.click(f.body().querySelector('[data-creation-review]'));
  assert.match(f.body().textContent, /Private source title/);
}
function metadata(f) {
  assert.equal(f.field('Playlist name').value, 'Keep my title');
  assert.equal(f.field('Playlist description').value, 'Keep my description');
}
function noPrivateRows(f, expectedQuery = '') {
  f.zeroSelection();
  assert.equal(f.picks().length, 0);
  assert.equal(f.body().querySelector('.playlists__selection')?.textContent || '', '');
  assert.equal(f.body().querySelector('.playlists__selection button'), null);
  assert.doesNotMatch(f.body().textContent, /Private source title|Private source artist|Private album/);
  assert.equal(f.body().querySelector('input[type="search"]')?.value || '', expectedQuery);
}
const retirements = [
  ['provider replacement', playlists => playlists.configure({readPlaylists: () => directory()})],
  ['scope round trip', playlists => {playlists.setScope('account:other'); playlists.setScope('account:session-test');}],
  ['suspension', playlists => playlists.suspend()],
];
for (const [label, retire] of retirements) {
  test(`${label} immediately retires a pending source read even if the original context returns before rendering`, async t => {
    const read = deferred(), f = sessionFixture(t, {readSource: () => read.promise});
    const oldVersion = f.playlists.getLifecycleVersion();
    assert.equal(f.reads.length, 1); assert.equal(f.reads[0].signal.aborted, false);
    retire(f.playlists); f.playlists.accept(directory());
    assert.ok(f.playlists.getLifecycleVersion() > oldVersion);
    assert.equal(f.reads[0].signal.aborted, true); f.retired();
    read.resolve(sourceResult(f.reads[0])); await settle(); f.render(); f.retired();
    f.click(f.button('Reload tracks')); await settle();
    await f.submit(); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0);
    f.dispose(); f.playlists.dispose();
  });
  test(`${label} aborts an in-flight write before rendering and ignores its late acknowledgement`, async t => {
    const write = deferred(), f = sessionFixture(t, {write: () => write.promise}); await settle(); fill(f);
    f.submit(); assert.equal(f.writes.length, 1); assert.equal(await f.beforeDismiss(), false);
    retire(f.playlists); f.playlists.accept(directory());
    assert.equal(f.writes[0].signal.aborted, true); f.retired();
    write.resolve(acknowledgement(f.writes[0])); await settle(); f.render(); await f.submit();
    assert.equal(f.writes.length, 1); assert.equal(f.refreshes.length, 0); assert.equal(f.owners[0].attempts.length, 0);
    assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []); f.retired(); f.dispose(); f.playlists.dispose();
  });
}
test('revision-only invalidation preserves metadata and requires explicit source reload and a new selection', async t => {
  const f = sessionFixture(t); await settle(); fill(f);
  f.playlists.accept(directory({revision: 'source-r2'}));
  assert.match(f.body().textContent, /This source changed/); noPrivateRows(f); metadata(f);
  assert.equal(await f.beforeDismiss(), false, 'retained dirty metadata still requires a decision');
  assert.equal(f.reads.length, 1, 'a revision change does not silently reload');
  f.render(); await f.submit(); assert.equal(f.writes.length, 0);
  await f.reload(); f.render();
  assert.equal(f.reads.length, 2); assert.equal(f.reads[1].source.revision, 'source-r2');
  assert.equal(f.body().querySelector('input[type="search"]').disabled, false);
  assert.deepEqual(f.selected(), []); metadata(f);
  assert.doesNotMatch(f.body().textContent, /This source changed/);
  f.dispose(); f.playlists.dispose();
});
for (const [revision, expected] of [['source-r1', /Source access was refreshed/], ['source-r2', /This source changed/]]) {
  test(`parent refresh to ${revision} pauses source authority, preserves metadata, and requires explicit reload`, async t => {
    const refresh = deferred(), f = sessionFixture(t, {refresh: () => refresh.promise}); await settle(); fill(f);
    const form = f.form(), pending = f.playlists.load();
    assert.match(f.body().textContent, /Loading tracks/); noPrivateRows(f, 'Private source'); metadata(f); await f.submit();
    assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 0);
    refresh.resolve(directory({revision})); assert.equal(await pending, true);
    assert.match(f.body().textContent, expected); noPrivateRows(f, revision === 'source-r1' ? 'Private source' : ''); metadata(f);
    assert.equal(f.reads.length, 1, 'parent refresh must not silently reselect or reload private source rows');
    assert.equal(f.render(), form, 'native form ownership remains stable');
    await f.reload(); f.render();
    assert.equal(f.reads.length, 2); assert.equal(f.refreshes.length, 1); assert.equal(f.reads[1].source.revision, revision); assert.equal(f.reads[1].source.ref, 'catalog:session-test');
    assert.equal(f.body().querySelector('input[type="search"]').disabled, false);
  assert.deepEqual(f.selected(), []); metadata(f); f.dispose(); f.playlists.dispose();
  });
}
test('Reload tracks after a parent read error waits for renewed authority before reading source rows', async t => {
  const failedRefresh = deferred(), retryRefresh = deferred(); let refreshCount = 0;
  const f = sessionFixture(t, {refresh: () => (++refreshCount === 1 ? failedRefresh : retryRefresh).promise}); await settle(); fill(f);
  const pending = f.playlists.load(); failedRefresh.reject(new Error('Directory read failed')); assert.equal(await pending, false);
  assert.match(f.body().textContent, /source tracks could not be loaded/); noPrivateRows(f, 'Private source'); metadata(f);
  f.reload(); assert.equal(f.refreshes.length, 2); assert.equal(f.reads.length, 1, 'source is not readable until parent authority returns');
  assert.match(f.body().textContent, /Loading tracks/);
  retryRefresh.resolve(directory({revision: 'source-r2'})); await settle(); f.render();
  assert.equal(f.reads.length, 2); assert.equal(f.reads[1].source.revision, 'source-r2');
  assert.equal(f.body().querySelector('input[type="search"]').disabled, false);
  assert.deepEqual(f.selected(), []); metadata(f); assert.equal(f.writes.length, 0); f.dispose(); f.playlists.dispose();
});
test('acknowledgement retires private source data, awaits authoritative refresh and native close, then navigates after form cleanup', async t => {
  const refresh = deferred(); let f;
  f = sessionFixture(t, {refresh: () => refresh.promise, onClose: () => f.dispose()}); await settle(); fill(f);
  f.submit(); await f.refreshEntered.promise; f.render(); noPrivateRows(f);
  assert.match(f.body().textContent, /Playlist created/); assert.equal(f.form().getAttribute('aria-busy'), 'true');
  assert.equal(await f.beforeDismiss(), false); assert.equal(f.owners[0].attempts.length, 0); assert.deepEqual(f.navigations, []);
  await f.submit(); assert.equal(f.writes.length, 1);
  refresh.resolve(directory({created: true})); await f.closeEntered.promise;
  assert.deepEqual(plain(f.owners[0].attempts[0]), {force: true, restoreFocus: false, reason: 'cancel'});
  assert.deepEqual(f.navigations, [], 'navigation waits for the native owner to complete');
  f.nativeClosed(); const mutations = f.mutationsNow(); f.closing.resolve(true); await settle();
  assert.deepEqual(f.navigations, ['created:session-test']); assert.deepEqual(f.notices, []); assert.deepEqual(f.drafts, []);
  assert.equal(f.writes.length, 1); assert.equal(f.refreshes.length, 1); assert.deepEqual(f.mutationsNow(), mutations);
  f.playlists.dispose();
});
test('refresh failure keeps a truthful confirmed-create state and cannot issue another write', async t => {
  const refresh = deferred(), f = sessionFixture(t, {refresh: () => refresh.promise}); await settle(); fill(f);
  f.submit(); await f.refreshEntered.promise; noPrivateRows(f);
  refresh.reject(new Error('Private refresh transport detail')); await settle(); f.render();
  assert.match(f.body().textContent, /Playlist created, but the playlist list could not be refreshed\./);
  assert.ok(f.writes[0].request_key); noPrivateRows(f); metadata(f);
  assert.equal(f.form().getAttribute('aria-busy'), 'false'); assert.equal(f.button('Create playlist').disabled, true);
  await f.submit(); await f.submit(); assert.equal(f.writes.length, 1); assert.equal(f.refreshes.length, 1);
  assert.equal(f.owners[0].attempts.length, 0); assert.deepEqual(f.navigations, []); assert.equal(await f.beforeDismiss(), true);
  f.dispose(); f.playlists.dispose();
});
for (const [label, retire] of retirements) test(`${label} during refresh cannot revive an acknowledged session after the context returns`, async t => {
  const refresh = deferred(), f = sessionFixture(t, {refresh: () => refresh.promise}); await settle(); fill(f);
  f.submit(); await f.refreshEntered.promise; retire(f.playlists); f.playlists.accept(directory({created: true}));
  assert.equal(f.refreshes[0].signal.aborted, true); refresh.resolve(directory({created: true})); await settle(); f.render();
  f.retired(); assert.doesNotMatch(f.body().textContent, /Playlist created/);
  assert.equal(f.owners[0].attempts.length, 0); assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []);
  assert.equal(f.writes.length, 1); f.dispose(); f.playlists.dispose();
});
for (const [label, retire] of retirements) test(`${label} during native return prevents stale navigation after the same context returns`, async t => {
  const f = sessionFixture(t); await settle(); fill(f); f.submit(); await f.closeEntered.promise;
  assert.equal(f.owners[0].attempts.length, 1); assert.deepEqual(f.navigations, []);
  retire(f.playlists); f.playlists.accept(directory({created: true})); f.closing.resolve(true); await settle();
  assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []); assert.equal(f.owners[0].attempts.length, 1);
  f.dispose(); f.playlists.dispose();
});
test('source-change fallback notice cannot escape a replaced lifecycle while native close is pending', async t => {
  const f = sessionFixture(t, {refresh: () => directory({revision: 'source-r2', created: true})}); await settle(); fill(f);
  f.submit(); await f.closeEntered.promise;
  f.playlists.configure({readPlaylists: () => directory({revision: 'source-r2', created: true})}); f.playlists.accept(directory({revision: 'source-r2', created: true}));
  f.closing.resolve(true); await settle(); assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []);
  f.dispose(); f.playlists.dispose();
});
test('late cleanup and source completion from an old session cannot clear or unsubscribe its replacement', async t => {
  const oldRead = deferred(), old = sessionFixture(t, {readSource: () => oldRead.promise});
  old.playlists.configure({readPlaylists: () => directory()}); old.playlists.accept(directory());
  const f = sessionFixture(t, {playlists: old.playlists}); await settle(); fill(f);
  const form = f.form(), html = f.body().innerHTML, signal = f.reads[0].signal;
  old.dispose(); oldRead.resolve(sourceResult(old.reads[0])); await settle();
  assert.equal(f.form(), form); assert.equal(f.body().innerHTML, html); metadata(f); assert.equal(signal.aborted, false);
  assert.equal(f.owners[0].attempts.length, 0); assert.equal(old.reads[0].signal.aborted, true); old.retired();
  old.playlists.accept(directory({revision: 'source-r2'})); assert.match(f.body().textContent, /This source changed/); metadata(f);
  f.dispose(); old.playlists.dispose();
});
test('missing Create transfers its immutable draft exactly once after native close and form cleanup, without persistence or refresh', async t => {
  let f; f = sessionFixture(t, {mode: 'missing', onClose: () => f.dispose()}); await settle(); fill(f);
  const form = f.form(), selection = f.selected(); f.submit(); await f.closeEntered.promise;
  assert.equal(f.reads[0].mode, 'missing'); assert.equal(f.reads[0].source.kind, 'playlist');
  assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0); metadata(f); assert.deepEqual(f.selected(), selection);
  assert.deepEqual(f.drafts, []); assert.equal(await f.beforeDismiss(), false); assert.equal(f.render().getAttribute('aria-busy'), 'true');
  await f.submit(form); assert.equal(f.owners[0].attempts.length, 1);
  assert.deepEqual(plain(f.owners[0].attempts[0]), {force: true, restoreFocus: false, reason: 'cancel'});
  f.nativeClosed(); f.retired(); assert.deepEqual(f.drafts, [], 'native teardown alone does not complete its awaited close');
  const mutations = f.mutationsNow(); f.closing.resolve(true); await settle();
  assert.equal(f.drafts.length, 1); const packet = f.drafts[0];
  assert.equal(packet.title, 'Keep my title'); assert.equal(packet.description, 'Keep my description');
  assert.equal(packet.source.revision, 'source-r1'); assert.equal(packet.canCreateAlbumTop, true);
  assert.deepEqual(plain(packet.entries.map(row => row.entry_ref)), ['occurrence:private']);
  for (const value of [packet, packet.source, packet.entries, packet.entries[0], packet.entries[0].parent_album]) assert.equal(Object.isFrozen(value), true);
  assert.equal(Reflect.set(packet.entries[0], 'title', 'Changed after teardown'), false);
  await f.submit(form); assert.equal(f.drafts.length, 1); assert.equal(f.drafts[0], packet);
  assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0); assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []);
  assert.deepEqual(f.mutationsNow(), mutations); f.playlists.dispose();
});
test('a refused native close keeps the missing selection in its form and never transfers or saves it', async t => {
  const f = sessionFixture(t, {mode: 'missing'}); await settle(); fill(f);
  const selection = f.selected(), form = f.form(); f.submit(); await f.closeEntered.promise;
  f.closing.resolve(false); await settle(); f.render();
  assert.equal(f.form(), form); assert.deepEqual(f.selected(), selection); metadata(f); assert.equal(f.form().getAttribute('aria-busy'), 'false');
  assert.match(f.body().textContent, /unsaved playlist could not be opened.*selection has not been saved/);
  assert.deepEqual(f.drafts, []); assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0); f.dispose(); f.playlists.dispose();
});
test('a missing source revision changed before Create preserves metadata and blocks transfer until explicit reload and selection', async t => {
  const f = sessionFixture(t, {mode: 'missing'}); await settle(); fill(f);
  f.playlists.accept(missingDirectory({revision: 'source-r2'}), missingPlaylistId); f.render(); await f.submit();
  assert.match(f.body().textContent, /This source changed/); noPrivateRows(f); metadata(f); assert.equal(f.button('Create playlist').disabled, true);
  assert.equal(f.reads.length, 1); assert.equal(f.owners[0].attempts.length, 0); assert.deepEqual(f.drafts, []);
  assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0); await f.reload(); f.render();
  assert.equal(f.reads.length, 2); assert.equal(f.reads[1].source.revision, 'source-r2'); assert.deepEqual(f.selected(), []);
  await f.submit(); assert.equal(f.owners[0].attempts.length, 0);
  const key = f.picks()[0].dataset.creationPick; f.toggle(key); assert.deepEqual(f.selected(), [key]); metadata(f);
  f.submit(); await f.closeEntered.promise; await f.finishClose();
  assert.equal(f.drafts[0].source.revision, 'source-r2'); f.dispose(); f.playlists.dispose();
});
test('a same-source revision change during close preserves the original draft packet for the destination owner conflict', async t => {
  let f, destinationRevision;
  f = sessionFixture(t, {mode: 'missing', onClose: () => f.dispose(), onPrepareDraft: () => {
    destinationRevision = f.playlists.getSnapshot().resource.data.detail.missing_playlist_creation_source.revision; return true;
  }}); await settle(); fill(f); f.submit(); await f.closeEntered.promise;
  f.playlists.accept(missingDirectory({revision: 'source-r2'}), missingPlaylistId);
  assert.match(f.body().textContent, /This source changed/); assert.deepEqual(f.drafts, []);
  f.nativeClosed(); const mutations = f.mutationsNow(); f.closing.resolve(true); await settle();
  assert.equal(f.drafts.length, 1); const packet = f.drafts[0];
  assert.equal(packet.source.revision, 'source-r1'); assert.equal(destinationRevision, 'source-r2');
  assert.equal(packet.title, 'Keep my title'); assert.equal(packet.description, 'Keep my description');
  assert.equal(packet.entries[0].title, 'Private source title'); assert.equal(Object.isFrozen(packet), true);
  assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.mutationsNow(), mutations); f.playlists.dispose();
});
const missingTransferRetirements = [
  ...retirements,
  ['navigation round trip', playlists => playlists.select(null, {load: false, fromNavigation: true})],
  ['source identity round trip', playlists => playlists.accept(missingDirectory({sourceRef: 'other:source'}), missingPlaylistId)],
  ['creation permission round trip', playlists => playlists.accept(missingDirectory({canCreate: false}), missingPlaylistId)],
  ['source permission round trip', playlists => playlists.accept(missingDirectory({canUse: false}), missingPlaylistId)],
  ['denial round trip', playlists => playlists.accept({status: 'denied'}, missingPlaylistId)],
];
for (const [label, retire] of missingTransferRetirements) for (const afterCleanup of [false, true]) {
  test(`${label} ${afterCleanup ? 'after' : 'before'} form cleanup prevents late missing transfer when the original context returns`, async t => {
    let f; f = sessionFixture(t, {mode: 'missing', onClose: () => f.dispose()}); await settle(); fill(f);
    f.submit(); await f.closeEntered.promise; const owner = f.owners[0];
    assert.equal(owner.attempts.length, 1); assert.deepEqual(f.drafts, []);
    if (afterCleanup) f.nativeClosed();
    const closeAttempts = owner.attempts.length;
    retire(f.playlists); f.playlists.accept(missingDirectory(), missingPlaylistId);
    const mutations = f.mutationsNow(); f.closing.resolve(true); await settle();
    assert.deepEqual(f.drafts, []); assert.equal(f.writes.length, 0); assert.equal(f.refreshes.length, 0);
    assert.deepEqual(f.navigations, []); assert.deepEqual(f.notices, []); assert.equal(owner.attempts.length, closeAttempts);
    if (afterCleanup) assert.deepEqual(f.mutationsNow(), mutations);
    else {f.retired(); assert.equal(f.button('Create playlist').disabled, true);}
    f.dispose(); f.playlists.dispose();
  });
}
function selectedActionFixture(t, {refreshFails = false, readDestinations, initialMode} = {}) {
  const h = sessionDom(), writes = [], addWrites = [], navigations = [], closed = [], destinationReads = [];
  const invalidations = new Set(); let current = true;
  const source = {scopeKey: 'scope:selected-session', instance: {}, revision: 'view:r1', rows: [{rowKey: 'row:selected', readable: true, selectable: true}]};
  const sourceAdapter = {snapshot: () => source, subscribe: () => () => {}, resolveRows: () => ({
    rows: [{rowKey: 'row:selected', track_ref: '/private/selected.flac', entry_ref: 'occurrence:private'}], playlist_creation_source: descriptor()})};
  const lifetime = {signal: new AbortController().signal, isCurrent: () => current,
    subscribeInvalidation(listener) {invalidations.add(listener); return () => invalidations.delete(listener);}};
  const providers = {readPlaylistDestinations: async request => {
    destinationReads.push(request); if (readDestinations) return readDestinations(request);
    if (refreshFails && writes.length) throw new Error('Refresh failed');
    return {status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: true}, playlist_creation_source: descriptor(),
      destinations: [{playlist_id: 'created:session-test', title: 'Created destination', allowed_actions: {can_add: true, can_open: true}}]}};
  }, addTracks: async request => {addWrites.push(request); return {ok: true};}, readPlaylistCreationSource: async request => sourceResult(request),
  createPlaylistFromSelection: async request => {writes.push(request); return acknowledgement(request);}};
  h.runtime.confirm = async () => true;
  const props = {runtime: h.runtime, sourceAdapter, lifetime, providers, initialMode,
    packet: {scopeKey: source.scopeKey, row_keys: ['row:selected'], origin: {tableKey: 'table:selected', target: 'selection'}},
    onClose: value => closed.push(value), onNavigate: id => navigations.push(id)};
  let owner;
  t.after(async () => {
    try {owner?.dispose();}
    finally {h.closing.resolve(false); await settle();}
  });
  owner = mountAction(h.host, props);
  return {...h, owners: h.forms, writes, addWrites, navigations, closed, destinationReads,
    render: () => owner.update(props),
    async openCreate() {const button = h.button('Create new playlist'); assert.ok(button); assert.equal(button.disabled, false); h.click(button); await settle();},
    retire() {current = false; invalidations.forEach(listener => listener());},
    // React effect replay has no native counterpart. Exercise explicit owner
    // retirement and fresh acquisition; each owner has its own actual form.
    reacquire() {owner.dispose(); h.forms.at(-1).nativeClosed(); owner = mountAction(h.host, props);},
    dispose: () => owner.dispose(),
  };
}
function seeded(f) {
  assert.equal(f.owners.at(-1).config.title, 'Create playlist'); assert.equal(f.owners.at(-1).config.pageId, 'create-playlist');
  assert.equal(f.body().querySelector('[role="tab"][aria-selected="true"]').dataset.inPageTab, 'selected');
  assert.deepEqual(f.selected(), ['entry:occurrence:private']);
}
test('selected-track picker switches to real seeded CreationForm in one native form and awaits native return before navigation', async t => {
  const f = selectedActionFixture(t); await settle(); await f.openCreate();
  assert.equal(f.owners.length, 1, 'Create retains one native form owner'); seeded(f); assert.equal(f.writes.length, 0);
  f.edit('Selection playlist'); assert.equal(f.field('Playlist name').value, 'Selection playlist');
  f.submit(); await f.closeEntered.promise; f.render();
  assert.match(f.body().textContent, /Playlist created/); noPrivateRows(f);
  assert.equal(await f.beforeDismiss(), false); assert.deepEqual(f.navigations, []);
  f.nativeClosed(); assert.equal(f.closed.length, 0, 'native teardown retains the source receipt until return settles');
  f.closing.resolve(true); await settle(); assert.deepEqual(f.navigations, ['created:session-test']); assert.equal(f.closed.length, 1);
  assert.equal(f.writes.length, 1); assert.deepEqual(plain(f.writes[0].entry_refs), ['occurrence:private']); f.dispose();
});
test('selected-track session reacquires its disposed controller after layout effect replay', async t => {
  const f = selectedActionFixture(t); await settle(); const first = f.owners[0], oldCancel = f.button('Cancel');
  f.reacquire(); await settle(); await f.openCreate();
  assert.equal(f.destinationReads.length, 3, 'initial, replacement, and deliberate Create authority reads');
  assert.equal(f.owners.length, 2, 'explicit native reacquisition owns a distinct form');
  assert.equal(first.closed, true); f.click(oldCancel); assert.equal(f.owners[1].attempts.length, 0);
  seeded(f); f.edit('After effect replay'); assert.equal(f.field('Playlist name').value, 'After effect replay'); f.dispose();
});
test('a pending read-only destination lookup can be cancelled and a late response cannot reopen the native form', async t => {
  const pending = deferred(), f = selectedActionFixture(t, {readDestinations: () => pending.promise}); f.render();
  const cancel = f.button('Cancel'); assert.ok(cancel); assert.equal(cancel.disabled, false); assert.equal(await f.beforeDismiss(), true);
  f.click(cancel); f.nativeClosed(); f.dispose(); f.closing.resolve(true);
  assert.equal(f.destinationReads[0].signal.aborted, true); const mutations = f.mutationsNow();
  pending.resolve({status: 'empty', data: {scopeKey: 'scope:selected-session', allowed_actions: {can_create: false}, destinations: []}});
  await settle(); assert.equal(f.owners.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.closed.length, 1);
  assert.deepEqual(f.mutationsNow(), mutations);
});
test('accepted native dismissal aborts a pre-Add read before its late response can dispatch in the teardown window', async t => {
  const pending = deferred(); let reads = 0;
  const result = request => ({status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: false},
    destinations: [{playlist_id: 'created:session-test', allowed_actions: {can_add: true}}]}});
  const f = selectedActionFixture(t, {readDestinations: request => ++reads === 1 ? result(request) : pending.promise}); await settle(); f.render();
  f.choose('Playlist', 'created:session-test'); f.event(f.body().querySelector('form[aria-label="Add selected tracks to playlist"]'), 'submit');
  assert.equal(f.destinationReads.length, 2); const accepted = f.beforeDismiss(); pending.resolve(result(f.destinationReads[1]));
  assert.equal(await accepted, true); await settle(); assert.equal(f.destinationReads[1].signal.aborted, true); assert.equal(f.addWrites.length, 0); f.dispose();
});
test('selected-track Create completion keeps acknowledged success on refresh failure and blocks retired-source navigation', async t => {
  const failed = selectedActionFixture(t, {refreshFails: true}); await settle(); await failed.openCreate(); failed.edit('Confirmed');
  await failed.submit(); failed.render(); assert.match(failed.body().textContent, /created.*could not be refreshed/); noPrivateRows(failed);
  assert.equal(await failed.beforeDismiss(), true); await failed.submit(); assert.equal(failed.writes.length, 1); failed.dispose();
  const f = selectedActionFixture(t); await settle(); await f.openCreate(); f.edit('Created');
  f.submit(); await f.closeEntered.promise; f.retire(); f.nativeClosed(); f.closing.resolve(true); await settle();
  assert.deepEqual(f.navigations, []); assert.equal(f.closed.length, 1); assert.equal(f.writes.length, 1); f.dispose();
});
test('direct Create enters the standard builder with Selected prefilled and no chooser or write', async t => {
  const f = selectedActionFixture(t, {initialMode: 'create'}); await settle(); await settle(); f.render();
  assert.equal(f.owners.length, 1); seeded(f); assert.equal(f.writes.length, 0); assert.equal(f.addWrites.length, 0); f.dispose();
});
test('review v2: direct Create can recover a failed initial destination read in its retained dialog', async t => {
  let reads = 0;
  const f = selectedActionFixture(t, {initialMode: 'create', readDestinations: async request => {
    if (++reads === 1) throw new Error('temporary read failure');
    return {status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: true}, playlist_creation_source: descriptor(), destinations: []}};
  }}); await settle(); f.render();
  const retry = [...f.body().querySelectorAll('button')].find(button => !button.disabled && !button.closest('[hidden]') && /retry|reload/i.test(button.textContent));
  assert.ok(retry, 'a recoverable read error must expose an enabled retry'); f.click(retry); await settle(); await settle(); f.render();
  seeded(f); assert.equal(f.owners.length, 1); assert.equal(f.writes.length, 0); f.dispose();
});
