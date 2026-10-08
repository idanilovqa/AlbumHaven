const test = require('node:test');
const assert = require('node:assert/strict');
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/creation.mjs');});

// Every test owns synthetic DTOs. These are source-boundary fixtures, never a
// runtime catalog, transport, persistence substitute or musical match.
const descriptor = (mode = 'missing', revision = 'revision:one') => ({
  kind: mode === 'ordinary' ? 'library' : 'playlist', ref: 'fixture:source', revision,
  allowed_actions: {can_read: true, can_use_for_playlist: true},
});
const context = (mode = 'missing') => ({scopeKey: 'fixture:scope', mode, source: descriptor(mode), canCreate: true});
const parent = (album_ref = 'album:one', patch = {}) => ({state: 'known', album_ref, title: 'Same album label',
  artist: 'Supplied artist', year: 2006, availability: 'local', completeness: 'unknown', ...patch});
const row = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null,
  title: 'Original', artist: 'Supplied artist', album_title: 'Same album label',
  availability: 'unresolved', metadata_state: 'unknown', parent_album: parent(),
  allowed_actions: {can_read: true, can_select: true}, ...patch});
const response = (subject, entries = [row('occurrence:missing', {availability: 'missing'})]) => ({status: 'ready', data: {
  scopeKey: subject.scopeKey, mode: subject.mode,
  source: {kind: subject.source.kind, ref: subject.source.ref, revision: subject.source.revision},
  allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, entries,
  retained_parent_albums: [{album_ref: 'retained:parent', title: 'Retained album', availability: 'local',
    allowed_actions: {can_read: true}}],
}});
const state = (subject, input, patch = {}) => ({...subject, sourceResource: model.normalizeCreationResult(input, subject),
  query: '', tab: 'all', selectedKeys: [], title: 'New playlist', description: '', mutation: {status: 'idle'}, ...patch});
const request = (subject, input, selectedKeys, patch = {}) => model.buildCreationRequest(model.normalizeCreationResult(input, subject).data,
  {context: subject, title: 'New playlist', description: '', selectedKeys, request_key: 'operation:one', ...patch});

test('descriptor requires own supported identity and exact own grants', () => {
  assert.deepEqual(model.normalizeCreationDescriptor({...descriptor(), private_path: '/private/music'}), descriptor());
  for (const source of [null, {...descriptor(), kind: 'album'}, {...descriptor(), ref: '/private/music'},
    {...descriptor(), revision: ''}, {...descriptor(), allowed_actions: {can_read: 1, can_use_for_playlist: true}},
    {...descriptor(), allowed_actions: {can_read: true, can_use_for_playlist: 'true'}},
    {...descriptor(), allowed_actions: Object.create({can_read: true, can_use_for_playlist: true})},
    Object.assign(Object.create({allowed_actions: descriptor().allowed_actions}), {kind: 'playlist', ref: 'source', revision: 'r'})]) {
    assert.equal(model.normalizeCreationDescriptor(source), null);
  }
  assert.equal(Object.isFrozen(model.normalizeCreationDescriptor(descriptor()).allowed_actions), true);
});

test('missing keeps unknown identity only when availability is explicitly missing', () => {
  const subject = context(), input = response(subject, [row('local', {availability: 'local'}),
    row('missing', {availability: 'missing', canonical_track_ref: 'canonical:known'}),
    row('unknown-identity:one', {availability: 'missing'}), row('unknown-identity:two', {availability: 'missing'}),
    row('unknown-availability'), row('ambiguous-availability', {availability: 'ambiguous'})]);
  const result = model.projectCreationState(state(subject, input));
  assert.deepEqual(result.entries.map(item => item.entry_ref), ['missing', 'unknown-identity:one', 'unknown-identity:two']);
  assert.equal(result.entries[0].canonical_track_ref, 'canonical:known');
  assert.ok(result.entries.slice(1).every(item => item.canonical_track_ref === null));
  for (const key of ['entry:local', 'entry:unknown-availability', 'entry:ambiguous-availability']) {
    assert.equal(request(subject, input, [key]), null);
  }
  assert.deepEqual(request(subject, input, ['entry:unknown-identity:two', 'entry:missing']).entry_refs,
    ['unknown-identity:two', 'missing']);
});

test('ordinary creation preserves unresolved and ambiguous availability in the selected occurrence order', () => {
  const subject = context('ordinary'), input = response(subject, [row('unknown'), row('ambiguous', {availability: 'ambiguous'}),
    row('local', {availability: 'local'}), row('missing', {availability: 'missing'})]);
  assert.deepEqual(model.projectCreationState(state(subject, input)).entries.map(item => item.entry_ref),
    ['unknown', 'ambiguous', 'local', 'missing']);
  assert.deepEqual(request(subject, input, ['entry:ambiguous', 'entry:unknown']).entry_refs, ['ambiguous', 'unknown']);
});

test('unreadable rows expose no source identity, title, artwork, parent or grant', () => {
  const subject = context(), input = response(subject, [row('secret:identity', {title: 'Secret song', canonical_track_ref: 'secret:canonical',
    artwork_url: '/art/secret', parent_album: parent('secret:album'), allowed_actions: {can_read: false, can_select: true}}),
  row('readonly', {allowed_actions: {can_read: true, can_select: 'true'}})]);
  const normalized = model.normalizeCreationResult(input, subject);
  assert.equal(normalized.status, 'ready');
  const denied = normalized.data.entries[0];
  assert.equal(denied.source_readable, false);
  assert.equal(denied.entry_ref, null);
  assert.equal(denied.parent_album, null);
  assert.equal(JSON.stringify(denied).includes('secret'), false);
  assert.equal(request(subject, input, [denied.row_key]), null);
  assert.equal(request(subject, input, ['entry:readonly']), null);
});

test('source grant denial strips even otherwise valid private facts', () => {
  const subject = context();
  for (const grants of [undefined, {can_read: true}, {can_read: 1, can_use_for_playlist: true},
    Object.create({can_read: true, can_use_for_playlist: true})]) {
    const input = response(subject); input.data.allowed_actions = grants;
    assert.deepEqual(model.normalizeCreationResult(input, subject), {status: 'denied', data: null});
  }
  const input = response(subject), container = input.data.allowed_actions;
  input.data = Object.assign(Object.create({allowed_actions: container}), input.data);
  delete input.data.allowed_actions;
  assert.equal(model.normalizeCreationResult(input, subject).status, 'denied');
  for (const status of ['denied', 'unavailable', 401, 403]) {
    const result = model.normalizeCreationResult({...response(subject), status}, subject);
    assert.equal(result.data, null);
    assert.equal(result.status, status === 'unavailable' ? 'unavailable' : 'denied');
  }
});

test('response identity, revision, completeness and status cannot silently rebase authority', () => {
  const subject = context();
  for (const [patch, expected] of [[{scopeKey: 'different'}, 'error'], [{mode: 'ordinary'}, 'error'],
    [{source: {...subject.source, ref: 'different'}}, 'error'], [{source: {...subject.source, revision: 'new'}}, 'conflict'],
    [{entries_complete: false}, 'incomplete'], [{entries_complete: 'true'}, 'incomplete']]) {
    const input = response(subject); Object.assign(input.data, patch);
    assert.deepEqual(model.normalizeCreationResult(input, subject), {status: expected, data: null});
  }
  for (const invalid of [undefined, {}, {ok: true}, {status: 'empty', data: response(subject).data},
    {...response(subject), ok: false},
    {status: 'empty', data: null}, {status: 'ready', data: []}]) {
    assert.equal(model.normalizeCreationResult(invalid, subject).status, 'error');
  }
});

test('sparse, inherited array slots, malformed and duplicate occurrence input fail closed', () => {
  const subject = context();
  const sparse = [row('a'), row('b')]; delete sparse[0];
  const inherited = [row('a')]; delete inherited[0]; Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {0: row('a')}));
  for (const entries of [sparse, inherited, [null], [row('same'), row('same')], [row({ref: 'object'})], [row('/private/track')]]) {
    assert.deepEqual(model.normalizeCreationResult(response(subject, entries), subject), {status: 'error', data: null});
  }
  const input = response(subject); input.data.retained_parent_albums = Array(1);
  assert.equal(model.normalizeCreationResult(input, subject).status, 'error');
});

test('identity-free rows get distinct display keys without selectable identities or invented facts', () => {
  const subject = context(), input = response(subject, [row(null), row(null)]);
  const data = model.normalizeCreationResult(input, subject).data;
  assert.notEqual(data.entries[0].row_key, data.entries[1].row_key);
  assert.equal(request(subject, input, [data.entries[0].row_key]), null);
  for (const item of data.entries) {
    for (const key of ['entry_ref', 'canonical_track_ref', 'track_number', 'disc_number', 'duration_seconds']) assert.equal(item[key], null);
  }
});

test('whitelisted immutable copies reject unsafe artwork and retain supplied finite facts only', () => {
  const subject = context('ordinary'), input = response(subject, [row('a', {artwork_url: 'file:///private/art',
    media_url: '/raw/audio', local_path: '/private/music', track_number: -1, disc_number: '2', duration_seconds: 0,
    parent_album: parent('album:one', {year: '2006'})}), row('b', {artwork_url: '/art/safe', duration_seconds: 2.5})]);
  const normalized = model.normalizeCreationResult(input, subject).data;
  assert.equal(normalized.entries[0].artwork_url, null);
  assert.equal(normalized.entries[1].artwork_url, '/art/safe');
  assert.equal(normalized.entries[0].duration_seconds, 0);
  assert.equal(normalized.entries[1].duration_seconds, 2.5);
  assert.equal(normalized.entries[0].parent_album.year, null);
  assert.equal(JSON.stringify(normalized).includes('/private'), false);
  assert.equal(JSON.stringify(normalized).includes('/raw'), false);
  input.data.entries[0].title = 'Mutated source';
  assert.equal(normalized.entries[0].title, 'Original');
  assert.equal(Object.isFrozen(normalized.entries[0].parent_album.allowed_actions), true);
});

test('known groups use parent identity while unknown and ambiguous parents remain distinct', () => {
  const subject = context('ordinary'), input = response(subject, [row('a', {availability: 'missing'}),
    row('b', {parent_album: parent('album:two')}), row('c', {parent_album: {state: 'unknown', album_ref: 'ignored', title: 'Same'}}),
    row('d', {parent_album: {state: 'ambiguous', album_ref: 'ignored', title: 'Same'}})]);
  const result = model.projectCreationState(state(subject, input));
  assert.equal(result.groups.length, 4);
  assert.equal(new Set(result.groups.map(group => group.key)).size, 4);
  assert.equal(result.groups[0].completeness, 'incomplete');
  assert.equal(result.groups[0].parent_album.availability, 'local');
  assert.equal(result.groups[1].completeness, 'unknown');
  assert.equal(result.groups[2].parent_album.album_ref, null);
  assert.equal(result.groups[3].parent_album.album_ref, null);
});

test('filtered group completeness includes its hidden confirmed missing member', () => {
  const subject = context('ordinary'), input = response(subject, [row('hidden', {title: 'Absent', availability: 'missing'}),
    row('visible', {title: 'Visible', availability: 'local', parent_album: parent('album:one', {completeness: 'complete'})})]);
  const result = model.projectCreationState(state(subject, input, {query: 'visible'}));
  assert.deepEqual(result.entries.map(item => item.entry_ref), ['visible']);
  assert.equal(result.groups[0].completeness, 'incomplete');
});

test('All prioritizes exact titles then known chronology with unknown years after known', () => {
  const subject = context('ordinary'), input = response(subject, [row('partial', {title: 'Another echo', parent_album: parent('older', {year: 1980})}),
    row('unknown-year', {title: 'Echo survives', parent_album: parent('undated', {year: null})}),
    row('exact', {title: 'Echo', parent_album: parent('newer', {year: 2020})}), row('other', {title: 'Other'})]);
  const result = model.projectCreationState(state(subject, input, {query: '  ECHO  '}));
  assert.deepEqual(result.entries.map(item => item.entry_ref), ['exact', 'partial', 'unknown-year']);
});

test('Selected ignores query, preserves chosen order and never regroups across that order', () => {
  const subject = context('ordinary'), input = response(subject, [row('a'), row('b', {parent_album: parent('album:two')}), row('c')]);
  const result = model.projectCreationState(state(subject, input, {query: 'no match', tab: 'selected', selectedKeys: ['entry:c', 'entry:b', 'entry:a']}));
  assert.deepEqual(result.entries.map(item => item.entry_ref), ['c', 'b', 'a']);
  assert.deepEqual(result.groups.flatMap(group => group.entries).map(item => item.entry_ref), ['c', 'b', 'a']);
  assert.equal(result.selectedCount, 3); assert.equal(result.visibleSelectedCount, 3);
});

test('retained parents are readable evidence only and never search, selection or write items', () => {
  const subject = context(), input = response(subject);
  input.data.retained_parent_albums.push({album_ref: 'secret:parent', title: 'Secret', allowed_actions: {can_read: 'true'}});
  input.data.retained_parent_albums.push({state: 'ambiguous', album_ref: 'uncertain:parent', title: 'Uncertain', allowed_actions: {can_read: true}});
  const data = model.normalizeCreationResult(input, subject).data;
  assert.equal(data.retained_parent_albums.length, 1);
  assert.equal(data.retained_parent_albums[0].album_ref, 'retained:parent');
  assert.equal(model.projectCreationState(state(subject, input, {query: 'Retained album'})).entries.length, 0);
  const payload = request(subject, input, ['entry:occurrence:missing']);
  assert.deepEqual(Object.keys(payload).sort(), ['scopeKey', 'playlist_id', 'mode', 'source', 'title', 'description', 'entry_refs', 'request_key'].sort());
  assert.equal(payload.playlist_id, null);
  assert.deepEqual(payload.source, {kind: 'playlist', ref: 'fixture:source', revision: 'revision:one'});
  assert.equal(JSON.stringify(payload).includes('retained'), false);
  assert.equal(JSON.stringify(payload).includes('canonical_track_ref'), false);
  assert.equal(request(subject, input, ['retained:parent']), null);
});

test('authoritative empty ordinary creation is allowed and missing empty is disabled', () => {
  const ordinary = context('ordinary'), missing = context();
  assert.deepEqual(request(ordinary, response(ordinary, []), []).entry_refs, []);
  assert.equal(request(missing, response(missing, []), []), null);
  assert.equal(model.canSubmitCreation(state(ordinary, response(ordinary, []))), true);
  assert.equal(model.canSubmitCreation(state(missing, response(missing, []))), false);
});

test('request validates metadata, ordered current authority and independent detail grants', () => {
  const subject = context('ordinary'), input = response(subject, [row('a', {parent_album: parent('album:a', {allowed_actions: {can_view_details: true}})}),
    row('b', {parent_album: parent('album:b', {allowed_actions: Object.create({can_view_details: true})})})]);
  const data = model.normalizeCreationResult(input, subject).data;
  assert.equal(data.entries[0].parent_album.allowed_actions.can_view_details, true);
  assert.equal(data.entries[1].parent_album.allowed_actions.can_view_details, false);
  for (const patch of [{title: ' '}, {title: 'x'.repeat(101)}, {description: 'x'.repeat(1001)}, {request_key: ''},
    {context: {...subject, canCreate: 'true'}}, {context: {...subject, source: descriptor('ordinary', 'later')}}]) {
    assert.equal(request(subject, input, ['entry:a'], patch), null);
  }
  assert.equal(request(subject, input, ['entry:a', 'entry:a']), null);
  assert.equal(request(subject, input, ['entry:unknown']), null);
  assert.deepEqual(request(subject, input, ['entry:b', 'entry:a']).entry_refs, ['b', 'a']);
});
