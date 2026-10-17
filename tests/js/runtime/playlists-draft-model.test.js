const test = require('node:test');
const assert = require('node:assert/strict');
let creation, draft;
test.before(async () => {
  creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  draft = await import('../../../music_app/static/js/playlists/draft.mjs');
});

// Independent source DTOs, never a catalog or persistence fallback.
const context = () => ({scopeKey: 'draft-model:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
  source: {kind: 'playlist', ref: 'draft-model:source', revision: 'version:one',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}});
const parent = (album_ref, patch = {}) => ({state: 'known', album_ref, title: 'Identical title',
  allowed_actions: {can_read: true, can_create_album_top: true}, ...patch});
const row = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Original artist',
  album_title: 'Original album', availability: 'unresolved', duration_seconds: 241,
  allowed_actions: {can_read: true, can_select: true}, parent_album: parent('parent:one'), ...patch});
const response = (subject, rows) => ({status: 'ready', data: {scopeKey: subject.scopeKey, mode: 'missing', source: subject.source,
  entries_complete: true, allowed_actions: {can_read: true, can_use_for_playlist: true}, entries: rows,
  retained_parent_albums: [{album_ref: 'retained:other', title: 'Must not leak into Top',
    allowed_actions: {can_read: true, can_create_album_top: true}}]}});
const prepare = (rows, keys) => {
  const subject = context(), sourceResource = creation.normalizeCreationResult(response(subject, rows), subject);
  return creation.prepareMissingDraft({...subject, sourceResource, selectedKeys: keys || sourceResource.data.entries.filter(value => value.entry_ref).map(value => value.row_key),
    title: 'Unsaved originals', description: 'Typed description', mutation: {status: 'idle'}}, {draftToken: 'presentation:one'});
};
const controller = rows => {
  const value = draft.createMissingPlaylistDraftController({prepared: prepare(rows)});
  value.setContext(context()); return value;
};

test('prepared packet preserves ordered occurrence refs and unknown originals without saved identity or private media', () => {
  const packet = prepare([row('a', {canonical_track_ref: null, private_path: '/private/music', media_url: 'file:///raw'}),
    row('b', {canonical_track_ref: null})], ['entry:b', 'entry:a']);
  assert.deepEqual(packet.entries.map(value => value.entry_ref), ['b', 'a']);
  assert.ok(packet.entries.every(value => value.canonical_track_ref === null));
  assert.equal(packet.draftToken, 'presentation:one');
  for (const forbidden of ['playlist_id', 'playlist_item_id', 'request_key', 'private_path', 'media_url']) {
    assert.equal(JSON.stringify(packet).includes(`"${forbidden}"`), false);
  }
  assert.equal(JSON.stringify(packet).includes('/private'), false);
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.entries[0].parent_album.allowed_actions), true);
});

test('missing preparation rejects wrong mode, incomplete source, revoked grants, invalid metadata and local selections', () => {
  const subject = context(), sourceResource = creation.normalizeCreationResult(response(subject, [row('a')]), subject);
  const state = {...subject, sourceResource, selectedKeys: ['entry:a'], title: 'Valid', description: '', mutation: {status: 'idle'}};
  for (const patch of [{mode: 'ordinary'}, {canCreate: false}, {title: ''}, {selectedKeys: []}, {selectedKeys: ['entry:invented']},
    {sourceResource: {status: 'loading', data: null}}, {mutation: {status: 'loading'}}]) {
    assert.equal(creation.prepareMissingDraft({...state, ...patch}), null);
  }
  assert.equal(prepare([row('local', {availability: 'local'})]), null);
  assert.equal(creation.prepareMissingDraft(state, {draftToken: '/private/local'}), null);
});

test('filters and selection do not rewrite retained order or the complete original text export', () => {
  const value = controller([row('a', {title: 'First', availability: 'missing'}), row('b', {title: 'Unknown original'})]);
  value.reorder(['entry:b', 'entry:a']);
  value.setQuery('First'); value.select('entry:a');
  const view = draft.projectMissingPlaylistDraft(value.getSnapshot());
  assert.deepEqual(view.entries.map(item => item.entry_ref), ['a']);
  assert.deepEqual(view.authoredEntries.map(item => item.entry_ref), ['b', 'a']);
  assert.equal(view.canReorder, false);
  assert.equal(value.reorder(['entry:a', 'entry:b']), false);
  assert.equal(value.exportText(), 'Original artist - Unknown original [Original album]\nOriginal artist - First [Original album]');
  value.remove('entry:a');
  assert.equal(value.exportText(), 'Original artist - Unknown original [Original album]');
  assert.equal(value.getSnapshot().entries[0].canonical_track_ref, null);
});

test('safe facts support shared native filters and retain unknown facts without inferring listening history', () => {
  const packet = prepare([row('known', {styles: ['ambient'], love_tier: 'loved', added_at: 1700000000000,
    listen_count: 25, last_listened_at: 1700000000000, last_listened_known: true}), row('unknown', {duration_seconds: null})]);
  const value = draft.createMissingPlaylistDraftController({prepared: packet});
  assert.equal(value.getSnapshot().entries[0].added_at_ms, 1700000000000);
  assert.equal(value.getSnapshot().entries[0].last_listened_at_ms, 1700000000000);
  value.setFilters({love: 'loved', includeUnknown: true});
  assert.equal(draft.projectMissingPlaylistDraft(value.getSnapshot()).entries.length, 2);
  value.setFilters({includeUnknown: false});
  assert.deepEqual(draft.projectMissingPlaylistDraft(value.getSnapshot()).entries.map(item => item.entry_ref), ['known']);
});

test('Top uses only exact authorized known parents still represented by retained occurrences', () => {
  const value = controller([row('a'), row('a-again'), row('b', {parent_album: parent('parent:two')}),
    row('unknown', {parent_album: {state: 'unknown', album_ref: 'invented', title: 'Identical title'}}),
    row('ambiguous', {parent_album: parent('ambiguous', {state: 'ambiguous'})}),
    row('denied', {parent_album: parent('parent:denied', {allowed_actions: {can_read: true, can_create_album_top: 'true'}})})]);
  assert.deepEqual(value.topIntent().album_refs, ['parent:one', 'parent:two']);
  assert.deepEqual(Object.keys(value.topIntent()).sort(), ['scopeKey', 'source', 'album_refs'].sort());
  value.remove(['entry:a', 'entry:a-again']);
  assert.deepEqual(value.topIntent().album_refs, ['parent:two']);
  value.remove('entry:b'); assert.equal(value.topIntent(), null);
  value.setContext({...context(), canCreateAlbumTop: false}); assert.equal(value.topIntent(), null);
});

test('retained parent evidence is independently granted and narrowed by explicit occurrence associations', () => {
  const packet = prepare([row('a', {parent_album: parent('parent:one', {allowed_actions: {can_read: true}})}),
    row('b', {parent_album: parent('parent:one', {allowed_actions: {can_read: true}})})]);
  const prepared = {...packet, retained_parent_albums: [{album_ref: 'parent:one', state: 'known', entry_refs: ['a'],
    allowed_actions: {can_read: true, can_create_album_top: true}}]};
  const value = draft.createMissingPlaylistDraftController({prepared}); value.setContext(context());
  assert.deepEqual(value.topIntent().album_refs, ['parent:one']);
  value.remove('entry:a');
  assert.equal(value.topIntent(), null);
  for (const entry_refs of [[], ['not-retained'], 'invalid']) {
    const blocked = draft.createMissingPlaylistDraftController({prepared: {...packet,
      retained_parent_albums: [{...prepared.retained_parent_albums[0], entry_refs}]}});
    blocked.setContext(context()); assert.equal(blocked.topIntent(), null);
  }
});

test('retained evidence cannot override a denied parent read grant', () => {
  const packet = prepare([row('a', {parent_album: parent('parent:denied', {allowed_actions: {can_read: false, can_create_album_top: true}})})]);
  const value = draft.createMissingPlaylistDraftController({prepared: {...packet, retained_parent_albums: [
    {album_ref: 'parent:denied', allowed_actions: {can_read: true, can_create_album_top: true}},
  ]}});
  value.setContext(context()); assert.equal(value.topIntent(), null);
});

test('forged, sparse, malformed, or unauthorized packets cannot create a usable draft', () => {
  const packet = prepare([row('a')]), sparse = [packet.entries[0]]; delete sparse[0];
  for (const invalid of [null, {...packet, mode: 'ordinary'}, {...packet, canCreate: 'true'}, {...packet, entries: sparse},
    {...packet, entries: [packet.entries[0], packet.entries[0]]}, {...packet, source: {...packet.source, allowed_actions: {can_read: true}}}]) {
    const value = draft.createMissingPlaylistDraftController({prepared: invalid});
    assert.equal(value.getSnapshot().draftToken, null);
    assert.equal(value.canSave(), false); assert.equal(value.exportText(), ''); assert.equal(value.topIntent(), null);
  }
});
