const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function environment() {
  let entries = ['one', 'two'].map(id => ({id})), enabled = true, visible = true, valid = true;
  const listeners = new Set(), calls = [], opened = [], owners = [];
  const receipt = (id, kind) => ({target: {kind, ref: `${kind}:${id}`, identity_ref: `${kind}:common`,
    allowed_actions: {can_view_details: true}, native_actions: kind === 'album'
      ? {album_ref: 'native:album', allowed_actions: {can_open_album: true, can_play_album: true}}
      : {artist_ref: 'native:artist', allowed_actions: {can_open_artist_gallery: true}}},
    data: {kind, ref: `${kind}:${id}`, title: `${kind} title`, ...(kind === 'album' ? {tracks: null} : {listened_albums: null, discography: null})},
    gallery_target: kind === 'artist' ? {artist: 'native:artist'} : null, isCurrent: () => valid});
  let read = async (id, kind) => receipt(id, kind);
  const queue = {getSnapshot: () => ({entries, enabled}), subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    async details(id, kind, options) {calls.push([id, kind]); const value = await read(id, kind, options);
      return {...value, isCurrent: typeof value.isCurrent === 'function' ? () => !options.signal?.aborted && value.isCurrent() : undefined};}};
  const context = vm.createContext({window: {}, AbortController, console,
    state: {ui: {}}, fetchTrackModalAlbumDetails: async key => ({key, tracks: []}),
    acquireTrackModalSelection() {}, openTrackModal: (album, options) => {opened.push(album); owners.push(options.sourcePageOwner);}, releaseTrackModalSelection() {},
    handleSidebarArtistSelectionClick() {}, document: {createElement: () => ({setAttribute() {}})}});
  for (const file of ['resource-selection.js', 'queue-resource-selection.js']) vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime', file), 'utf8'), context);
  const owner = context.window.AlbumHavenQueueResourceSelection.create({queue, scopeKey: 'actor/library', isCurrent: () => visible});
  const emit = () => {for (const fn of listeners) fn();};
  return {owner, context, calls, opened, owners, receipt, emit, setRead: fn => {read = fn;},
    setEntries: value => {entries = value.map(id => ({id})); emit();}, setVisible: value => {visible = value; emit();},
    setValid: value => {valid = value; emit();}, setEnabled: value => {enabled = value; emit();}};
}
test('strict Queue origin preserves existing source constraints', () => {
  const {context} = environment(), project = context.window.AlbumHavenResourceSelection.projectOrigin;
  assert.deepEqual(plain(project({source: 'queue', occurrence_refs: ['one', 'two']})), {source: 'queue', occurrence_refs: ['one', 'two']});
  for (const origin of [{source: 'queue', occurrence_refs: []}, {source: 'queue', occurrence_refs: ['one', 'one']},
    {source: 'queue', occurrence_refs: ['one'], account_ref: 'friend'}, {source: 'queue', occurrence_refs: ['one'], period: 'week'},
    {source: 'recent', account_ref: 'friend', kind: 'albums', period: 'week'}]) assert.equal(project(origin), null);
});
test('fresh independent canonical consensus does not play or expose native refs', async () => {
  const env = environment();
  env.setRead(async (id, kind) => {const value = env.receipt(id, kind); if (kind === 'artist') {value.target.identity_ref = id; value.target.native_actions.artist_ref = `native:${id}`; value.gallery_target.artist = `native:${id}`;} return value;});
  await env.owner.select(['one', 'two']); const selected = env.owner.getSnapshot();
  assert.equal(selected.album.kind, 'album'); assert.equal(selected.artist, null); assert.equal(selected.album.native_actions, undefined);
  assert.deepEqual(plain(selected.album.origin.occurrence_refs), ['one', 'two']); assert.equal(env.opened.length, 0); assert.equal(env.calls.length, 4);
  assert.equal(env.owner.canResourceIntent('open', selected.album, {scopeKey: 'actor/library', origin: selected.album.origin}), true);
});
test('equal labels never imply canonical consensus', async () => {
  const env = environment(); env.setRead(async (id, kind) => {const value = env.receipt(id, kind); delete value.target.identity_ref; delete value.target.native_actions; return value;});
  await env.owner.select(['one', 'two']); assert.equal(env.owner.getSnapshot().album, null); assert.equal(env.owner.getSnapshot().artist, null);
});
test('later selection wins even when provider ignores abort', async () => {
  const env = environment(), pending = deferred(); env.setRead((id, kind) => id === 'one' ? pending.promise.then(() => env.receipt(id, kind)) : Promise.resolve(env.receipt(id, kind)));
  const old = env.owner.select(['one']); await env.owner.select(['two']); pending.resolve(); await old;
  assert.deepEqual(plain(env.owner.getSnapshot().selectedIds), ['two']); assert.equal(env.owner.getSnapshot().album.ref, 'album:two');
});
test('removal, clear, navigation and revocation retire pending and admitted selection', async () => {
  for (const reason of ['remove', 'clear', 'navigation', 'revocation']) {
    const env = environment(), pending = deferred(); env.setRead((id, kind) => pending.promise.then(() => env.receipt(id, kind)));
    const loading = env.owner.select(['one']);
    if (reason === 'remove') env.setEntries(['two']); else if (reason === 'clear') env.setEntries([]);
    else if (reason === 'navigation') env.setVisible(false); else env.setValid(false);
    pending.resolve(); await loading; assert.equal(env.owner.getSnapshot().album, null, reason);
  }
  const env = environment(); await env.owner.select(['one']); env.setValid(false); assert.equal(env.owner.getSnapshot().album, null);
});
test('reorder and deactivation preserve stable selected occurrence', async () => {
  const env = environment(); await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  env.setEntries(['two', 'one']); env.setEnabled(false);
  assert.equal(env.owner.getSnapshot().album, target); assert.deepEqual(plain(env.owner.getSnapshot().selectedIds), ['one']);
});
test('native action refreshes every selected source and rejects changed authority', async () => {
  const env = environment(); await env.owner.select(['one', 'two']); const target = env.owner.getSnapshot().album;
  env.setRead(async (id, kind) => {const value = env.receipt(id, kind); if (id === 'two') value.target.native_actions.album_ref = 'different'; return value;});
  await assert.rejects(env.owner.resourceIntent('open', target, {scopeKey: 'actor/library', origin: target.origin}));
  assert.equal(env.opened.length, 0); assert.equal(env.owner.getSnapshot().album, null);
});
test('wrong receipt kind, ref or absent authority fail closed per pane', async () => {
  for (const change of [value => {value.target.kind = 'artist';}, value => {value.data.ref = 'wrong';}, value => {delete value.isCurrent;}, value => {value.target.allowed_actions.can_view_details = false;}]) {
    const env = environment(); env.setRead(async (id, kind) => {const value = env.receipt(id, kind); if (kind === 'album') change(value); return value;});
    await env.owner.select(['one']); assert.equal(env.owner.getSnapshot().album, null); assert.equal(env.owner.getSnapshot().artist.kind, 'artist');
  }
});
test('scope mismatch and stale targets cannot use the current native lease', async () => {
  const env = environment(); await env.owner.select(['one']); const old = env.owner.getSnapshot().album; await env.owner.select(['two']);
  assert.equal(env.owner.canResourceIntent('open', old, {scopeKey: 'actor/library', origin: old.origin}), false);
  const target = env.owner.getSnapshot().album;
  assert.equal(env.owner.canResourceIntent('open', target, {scopeKey: 'another', origin: target.origin}), false);
  env.owner.dispose(); assert.equal(env.owner.getSnapshot().album, null);
});
test('projection rechecks origin and strips provider-private fields', async () => {
  const env = environment(); env.setRead(async (id, kind) => ({...env.receipt(id, kind),
    data: {...env.receipt(id, kind).data, path: '/private/music', subject_taste: {rating: 9}, tracks: [{path:'/private/track'}]}}));
  await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  await assert.rejects(env.owner.readAlbumProjection({kind:'album', ref:target.ref, scopeKey:'actor/library', origin:{source:'queue',occurrence_refs:['two']}}));
  const data = await env.owner.readAlbumProjection({...target, scopeKey:'actor/library'});
  assert.equal(data.path, undefined); assert.equal(data.subject_taste, undefined); assert.equal(data.native_actions, undefined); assert.equal(data.tracks, null);
});
test('navigation while native album hydration is pending never opens the album', async () => {
  const env = environment(), pending = deferred(); env.context.fetchTrackModalAlbumDetails = () => pending.promise;
  await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  const action = env.owner.resourceIntent('open', target, {scopeKey:'actor/library', origin:target.origin});
  await new Promise(resolve => setImmediate(resolve)); env.setVisible(false); pending.resolve({key:'native:album',tracks:[]});
  await assert.rejects(action); assert.equal(env.opened.length, 0);
});
test('fresh native action can open only the admitted album without implicit playback', async () => {
  const env = environment(); await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  await env.owner.resourceIntent('open', target, {scopeKey:'actor/library', origin:target.origin});
  assert.equal(env.opened.length, 1); assert.equal(env.opened[0].key, 'native:album'); assert.equal(env.calls.length, 3);
});
test('shared resource origin model and native origin validator remain aligned', async () => {
  const {pathToFileURL} = require('node:url');
  const {detailOrigin} = await import(pathToFileURL(path.join(root, 'music_app/static/js/home-friends/resource-target.mjs')));
  const {context} = environment();
  for (const origin of [{source:'queue',occurrence_refs:['one']}, {source:'queue',occurrence_refs:['one','one']},
    {source:'activity',account_ref:'friend',kind:'tracks',period:'week',snapshot_ref:'snap'},
    {source:'playlist',playlist_ref:'playlist'}, {source:'queue',occurrence_refs:['one'],account_ref:null}]) {
    assert.deepEqual(plain(context.window.AlbumHavenResourceSelection.projectOrigin(origin)), detailOrigin(origin));
  }
});
test('only deliberate native transfer survives UI disposal and remains bound to exact Queue source', async () => {
  const env = environment(); await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  const signalOwner = new AbortController();
  await env.owner.resourceIntent('open', target, {scopeKey:'actor/library', origin:target.origin, signal:signalOwner.signal});
  const transfer = env.owners[0]; assert.equal(transfer.isCurrent(), true);
  signalOwner.abort(); env.owner.dispose(); env.setVisible(false);
  assert.equal(transfer.isCurrent(), true); assert.equal(env.owner.getSnapshot().album, null);
  const replay = await transfer.revalidate({signal:new AbortController().signal, albumKey:'native:album'});
  assert.equal(replay.album.key, 'native:album'); assert.equal(replay.isCurrent(), true);
  env.setEntries(['two']); assert.equal(transfer.isCurrent(), false); assert.equal(replay.isCurrent(), false);
  await assert.rejects(transfer.revalidate({signal:new AbortController().signal, albumKey:'native:album'}));
});
test('new deliberate selection retires old native transfer and Forward rechecks server denial', async () => {
  const env = environment(); await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  await env.owner.resourceIntent('open', target, {scopeKey:'actor/library', origin:target.origin});
  const transfer = env.owners[0]; await env.owner.select(['two']); assert.equal(transfer.isCurrent(), false);
  const next = env.owner.getSnapshot().album;
  await env.owner.resourceIntent('open', next, {scopeKey:'actor/library', origin:next.origin});
  const current = env.owners[1]; env.owner.dispose();
  env.setRead(async () => {throw Object.assign(new Error('Revoked'), {status:403});});
  await assert.rejects(current.revalidate({signal:new AbortController().signal, albumKey:'native:album'}));
  assert.equal(current.isCurrent(), false);
});
test('row details mount the existing native widget without playback and release it on removal', async () => {
  const env = environment(), mounts = [], states = []; let releases = 0;
  env.context.document.getElementById = () => ({hidden:true});
  env.context.window.addEventListener = () => {}; env.context.window.removeEventListener = () => {};
  env.context.acquireTrackModalSelection = (host, album, options) => {mounts.push({host,album,options}); return {release() {releases++;}};};
  const host = {isConnected:true,addEventListener() {},removeEventListener() {}};
  await env.owner.select(['one']); const target = env.owner.getSnapshot().album;
  const lease = env.owner.mountResourceSelection(host, {selection:target,scopeKey:'actor/library',origin:target.origin,onState:state=>states.push(state)});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mounts.length, 1); assert.equal(mounts[0].album.key, 'native:album'); assert.equal(env.opened.length, 0);
  assert.equal(states.at(-1), 'ready'); env.setEntries(['two']); assert.equal(releases, 1); assert.equal(mounts[0].options.isCurrent(), false);
  lease.dispose(); assert.equal(releases, 1);
});

test('fresh private native identity joins snapshot-local aliases across captured sources', async () => {
  const env = environment();
  env.setRead(async (id, kind) => {const value = env.receipt(id, kind); value.target.identity_ref = `${id}:snapshot-alias`; return value;});
  await env.owner.select(['one','two']);
  assert.equal(env.owner.getSnapshot().album.kind,'album'); assert.equal(env.owner.getSnapshot().artist.kind,'artist');
  assert.equal(JSON.stringify(env.owner.getSnapshot()).includes('native:album'),false);
});
