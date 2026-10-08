const test = require('node:test');
const assert = require('node:assert/strict');
let inspection, model;
test.before(async () => {
  inspection = await import('../../../music_app/static/js/playlists/missing-inspection.mjs');
  model = await import('../../../music_app/static/js/playlists/model.mjs');
});
const source = {kind: 'playlist', ref: 'playlist:source', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}};
const row = (entry_ref, availability, canonical_track_ref = null) => ({entry_ref, availability, canonical_track_ref,
  title: `Original ${entry_ref}`, artist: 'Original artist', metadata_state: 'unknown', duration_seconds: 0,
  allowed_actions: {can_read: true, can_select: true}, parent_album: {state: 'unknown'}});
const payload = () => ({playlist_sidebar: {items: [{playlist_id: source.ref, title: 'Source', allowed_actions: {can_open: true}}]},
  playlist_actions: {can_create: true}, playlist_detail: {playlist_id: source.ref, title: 'Source', revision: source.revision,
    missing_playlist_creation_source: source, allowed_actions: {can_create_album_top: true},
    track_rows: [{playlist_item_id: 'item:missing', title: 'Original', availability: 'missing', source_readable: true}]}});
const result = (request, entries) => ({status: 'ready', data: {scopeKey: request.scopeKey, mode: 'missing', source: request.source,
  entries_complete: true, allowed_actions: {can_read: true, can_use_for_playlist: true}, entries, retained_parent_albums: []}});
function setup(entries, read) {
  const playlists = model.createPlaylistController(), packets = [], reads = [], writes = [];
  playlists.setScope('scope:one'); playlists.accept(payload(), source.ref);
  const providers = {readPlaylistCreationSource: async request => {reads.push(request); return read ? read(request) : result(request, entries);},
    createPlaylistFromSelection: value => {writes.push(value); assert.fail('Inspect may never persist');}};
  return {playlists, providers, packets, reads, writes, options: {playlists, providers,
    isCurrent: () => true, onPrepareDraft: packet => {packets.push(packet); return true;}}};
}
test('Inspect directly prepares the regular unsaved page with confirmed missing rows and no writer', async () => {
  const f = setup([row('entry:local', 'local', 'track:same'), row('entry:missing', 'missing', 'track:same'),
    row('entry:repeat', 'missing', 'track:same'), row('entry:unknown-one', 'missing'), row('entry:unknown-two', 'missing'),
    row('entry:ambiguous', 'unresolved'), row('entry:unclassified', null)]);
  assert.equal((await inspection.inspectMissingPlaylist(f.options)).status, 'ready');
  assert.equal(f.reads.length, 1); assert.equal(f.packets.length, 1); assert.equal(f.writes.length, 0);
  const packet = f.packets[0]; assert.equal(packet.title, 'Missing tracks · Source');
  assert.deepEqual(packet.entries.map(entry => entry.entry_ref), ['entry:missing', 'entry:unknown-one', 'entry:unknown-two']);
  assert.equal(packet.entries[1].title, 'Original entry:unknown-one'); assert.equal(packet.entries[1].canonical_track_ref, null);
  assert.equal(packet.entries[1].duration_seconds, 0); assert.equal(packet.canCreateAlbumTop, true);
  assert.equal(Object.isFrozen(packet), true); f.playlists.dispose();
});
test('fresh missing inspection never opens an empty page or silently drops an unusable confirmed-missing occurrence', async () => {
  for (const [entries, status] of [[ [row('local', 'local'), row('unknown', 'unresolved')], 'empty'],
    [[row('valid', 'missing'), {...row(null, 'missing'), title: 'No occurrence identity'}], 'unavailable'],
    [[row('valid', 'missing'), {...row('denied-select', 'missing'), allowed_actions: {can_read: true, can_select: false}}], 'denied']]) {
    const f = setup(entries); assert.equal((await inspection.inspectMissingPlaylist(f.options)).status, status);
    assert.deepEqual(f.packets, []); assert.deepEqual(f.writes, []); f.playlists.dispose();
  }
});
test('source/context replacement aborts the read and a late result cannot open its old page', async () => {
  let resolve, request;
  const f = setup([], value => {request = value; return new Promise(done => {resolve = done;});});
  const pending = inspection.inspectMissingPlaylist(f.options);
  f.playlists.setScope('scope:other'); f.playlists.setScope('scope:one'); f.playlists.accept(payload(), source.ref);
  assert.equal(request.signal.aborted, true); resolve(result(request, [row('late', 'missing')]));
  assert.equal((await pending).status, 'retired'); assert.deepEqual(f.packets, []); f.playlists.dispose();
});
test('cancelled inspection and source denial cannot prepare or save a Playlist', async () => {
  const abort = new AbortController(); abort.abort(); const f = setup([row('a', 'missing')]);
  assert.equal((await inspection.inspectMissingPlaylist({...f.options, signal: abort.signal})).status, 'retired');
  assert.equal(f.reads.length, 0); assert.equal(f.packets.length, 0); f.playlists.dispose();
  const denied = setup([], () => ({status: 'denied'}));
  assert.equal((await inspection.inspectMissingPlaylist(denied.options)).status, 'denied');
  assert.equal(denied.packets.length, 0); assert.equal(denied.writes.length, 0); denied.playlists.dispose();
});

test('unreadable missing metadata never enters the direct draft and null canonical identity remains eligible', async () => {
  const f = setup([{...row('private', 'missing'), allowed_actions: {can_read: false, can_select: true}}, row('unknown-music', 'missing')]);
  assert.equal((await inspection.inspectMissingPlaylist(f.options)).status, 'ready');
  assert.deepEqual(f.packets[0].entries.map(value => value.entry_ref), ['unknown-music']);
  f.playlists.dispose();
});
test('reader replacement and source revision or grant changes permanently retire an in-flight inspection', async () => {
  for (const change of ['reader', 'revision', 'grant']) {
    let resolve, request;
    const f = setup([], value => {request = value; return new Promise(done => {resolve = done;});});
    const pending = inspection.inspectMissingPlaylist(f.options);
    if (change === 'reader') f.providers.readPlaylistCreationSource = async () => ({status: 'unavailable'});
    else {
      const changed = payload();
      if (change === 'revision') changed.playlist_detail.missing_playlist_creation_source = {...source, revision: 'new-revision'};
      else changed.playlist_actions.can_create = false;
      f.playlists.accept(changed, source.ref); f.playlists.accept(payload(), source.ref);
    }
    resolve(result(request, [row('late', 'missing')]));
    assert.equal((await pending).status, 'retired'); assert.deepEqual(f.packets, []); f.playlists.dispose();
  }
});
test('incomplete or rejected source reads do not open a draft or call persistence', async () => {
  for (const [read, status] of [
    [request => ({...result(request, [row('a', 'missing')]), data: {...result(request, []).data, entries_complete: false}}), 'incomplete'],
    [() => {throw new Error('read failed');}, 'error'],
  ]) {
    const f = setup([], read); assert.equal((await inspection.inspectMissingPlaylist(f.options)).status, status);
    assert.equal(f.packets.length, 0); assert.equal(f.writes.length, 0); f.playlists.dispose();
  }
});
test('native draft admission refusal and failure never become saved or ready success', async () => {
  const refused = setup([row('a', 'missing')]);
  assert.equal((await inspection.inspectMissingPlaylist({...refused.options, onPrepareDraft: () => false})).status, 'unavailable');
  assert.equal(refused.writes.length, 0); refused.playlists.dispose();
  const failed = setup([row('a', 'missing')]);
  await assert.rejects(inspection.inspectMissingPlaylist({...failed.options, onPrepareDraft: () => {throw new Error('native unavailable');}}), /native unavailable/);
  assert.equal(failed.writes.length, 0); failed.playlists.dispose();
});
