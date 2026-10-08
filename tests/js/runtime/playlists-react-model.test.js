const test = require('node:test');
const assert = require('node:assert/strict');
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/model.mjs');});
const actions = {can_open: true, can_edit: true, can_rename: true, can_reorder: true, can_play: true, can_share: true, can_add: true, can_export: true};
const track = (id, availability = 'unresolved') => ({playlist_item_id: id, title: `Track ${id}`, artist: 'Artist',
  album_title: 'Album', duration_seconds: 0, duration_display: '0:00', availability, source_ref: `source:${id}`});
const payload = (id = null, patch = {}) => ({playlist_sidebar: {active_playlist_id: id || '', items: [
  {playlist_id: 'one', title: 'First', item_count: 2, allowed_actions: {can_open: true}},
  {playlist_id: 'two', title: 'Second', item_count: 0, allowed_actions: {can_open: true}},
]}, playlist_actions: {can_create: true}, ...(id ? {playlist_detail: {playlist_id: id, title: id === 'one' ? 'First' : 'Second',
  description: '', visibility: 'private', revision: 'r1', items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'}, track_rows: id === 'one' ? [track('a', 'missing'), track('b', 'local')] : [], allowed_actions: actions, ...patch}}
  : {playlist_index: {playlists: [{playlist_id: 'one', title: 'First', allowed_actions: actions}, {playlist_id: 'two', title: 'Second', allowed_actions: actions}]}})});
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const setup = options => {const controller = model.createPlaylistController(options); controller.setScope('account:library'); return controller;};

test('native projections preserve ordered item identities and exact grants', () => {
  const value = model.normalizePlaylistPayload(payload('one'));
  assert.deepEqual(value.detail.track_rows.map(row => row.playlist_item_id), ['a', 'b']);
  assert.equal(value.detail.track_rows[0].source_ref, 'source:a');
  assert.equal(value.detail.track_rows[0].duration_seconds, 0);
  assert.equal(model.granted(value.detail, 'can_share'), true);
  assert.equal(Object.isFrozen(value.detail.track_rows[0]), true);
  const noGrants = model.normalizePlaylistPayload(payload('one', {allowed_actions: Object.create({can_edit: true})}));
  assert.equal(model.granted(noGrants.detail, 'can_edit'), false);
  const badGrants = model.normalizePlaylistPayload(payload('one', {allowed_actions: {can_edit: 1, can_play: 'true'}}));
  assert.equal(model.granted(badGrants.detail, 'can_edit'), false);
  assert.equal(model.granted(badGrants.detail, 'can_play'), false);
});
test('Playlist detail targets preserve supplied canonical identity and redact revoked rows', () => {
  const origin = {source: 'playlist', account_ref: null, playlist_ref: 'one', snapshot_ref: 'r1'};
  const album_target = {kind: 'album', ref: 'album:catalog', origin, allowed_actions: {can_view_details: true},
    native_actions: {album_ref: 'local:album', allowed_actions: {can_open_album: true}, path: '/private'}};
  const artist_target = {kind: 'artist', ref: 'artist:catalog', allowed_actions: {can_view_details: 'true'},
    native_actions: {artist_ref: 'local:artist', gallery_target: {artist: 'private navigation'}, allowed_actions: {can_open_artist_gallery: true}}};
  const result = model.normalizePlaylistPayload(payload('one', {track_rows: [
    {...track('a'), album_target, artist_target}, {...track('b'), source_readable: false, album_target, artist_target},
    {...track('c'), artist: 'Display label', album_target: artist_target},
  ]})).detail.track_rows;
  assert.deepEqual(result[0].album_target.origin, origin); assert.equal(result[0].album_target.ref, 'album:catalog');
  assert.equal(result[0].artist_target.allowed_actions.can_view_details, false);
  assert.equal(result[1].album_target, undefined); assert.equal(result[1].artist_target, undefined);
  assert.equal(result[2].artist_target, null); assert.equal(result[2].album_target, null);
  assert.doesNotMatch(JSON.stringify(result), /private|"path"/);
});
test('duplicate resource/item identities and malformed content fail closed', () => {
  assert.throws(() => model.normalizePlaylistPayload(payload('one', {track_rows: [track('a'), track('a')]})));
  assert.throws(() => model.normalizePlaylistPayload({playlist_sidebar: {items: []}}));
  assert.throws(() => model.normalizePlaylistPayload(payload('one', {track_rows: [null]})));
  assert.throws(() => model.normalizePlaylistPayload({...payload(), playlist_index: {playlists: [{playlist_id: 'x'}, {playlist_id: 'x'}]}}));
});
test('missing provider and reserved APIs produce no fabricated records or writes', async () => {
  const controller = setup();
  assert.equal(await controller.load(), false);
  assert.equal(controller.getSnapshot().resource.status, 'unavailable');
  controller.accept(payload('one'), 'one');
  controller.edit({title: 'A draft'});
  assert.equal(await controller.mutate('savePlaylist'), false);
  assert.equal(controller.getSnapshot().mutation.status, 'unavailable');
  assert.equal(model.playlistDraft(controller.getSnapshot()).title, 'A draft');
  assert.equal((await controller.readSharing()).status, 'unavailable');
});
test('native empty versus malformed/denied/error read states remain distinct', async () => {
  const empty = {playlist_sidebar: {items: []}, playlist_index: {playlists: []}};
  for (const [value, status] of [[empty, 'empty'], [{status: 'denied', data: payload()}, 'denied'], [{status: 'unavailable', data: payload()}, 'unavailable'],
    [{}, 'error'], [{status: 'empty', data: payload()}, 'error']]) {
    const controller = setup({readPlaylists: async () => value}); await controller.load();
    assert.equal(controller.getSnapshot().resource.status, status);
  }
  const controller = setup({readPlaylists: async () => {throw Object.assign(new Error('private diagnostics'), {status: 403});}});
  await controller.load(); assert.equal(controller.getSnapshot().resource.status, 'denied');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('private diagnostics'), false);
});
test('superseded read and new scope cannot restore previous private records', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const controller = setup({readPlaylists: () => (++calls === 1 ? first.promise : second.promise)});
  const a = controller.load(), b = controller.load(); second.resolve(payload()); await b;
  first.resolve({status: 'denied'}); await a;
  assert.equal(controller.getSnapshot().resource.status, 'ready');
  const third = deferred(); controller.configure({readPlaylists: () => third.promise});
  const c = controller.load(); controller.setScope('other'); third.resolve(payload()); await c;
  assert.equal(controller.getSnapshot().scopeKey, 'other');
  assert.equal(controller.getSnapshot().resource.data, null);
});
test('drafts survive switching and read failure but never account/provider changes', () => {
  const controller = setup(); controller.accept(payload('one'), 'one'); controller.edit({title: 'Unsaved'});
  controller.accept(payload('two'), 'two'); controller.edit({description: 'Other draft'});
  controller.accept(payload('one'), 'one');
  assert.equal(model.playlistDraft(controller.getSnapshot()).title, 'Unsaved');
  assert.equal(model.playlistDraft(controller.getSnapshot()).conflict, false);
  controller.accept(payload('one', {revision: 'r2', title: 'Server changed'}), 'one');
  assert.equal(model.playlistDraft(controller.getSnapshot()).title, 'Unsaved');
  assert.equal(model.playlistDraft(controller.getSnapshot()).conflict, true);
  controller.setScope('new'); assert.deepEqual(controller.getSnapshot().drafts, {});
  controller.accept(payload('one'), 'one'); controller.edit({title: 'Changed'}); controller.configure({savePlaylist() {}});
  assert.deepEqual(controller.getSnapshot().drafts, {});
});
test('prototype-named opaque IDs do not inherit drafts or filters', () => {
  const controller = setup(); controller.accept(payload('constructor'), 'constructor');
  assert.equal(model.playlistDraft(controller.getSnapshot()), null);
  assert.equal(model.playlistFilters(controller.getSnapshot()), model.defaultFilters);
  controller.edit({title: 'A real draft'}); assert.equal(model.playlistDraft(controller.getSnapshot()).title, 'A real draft');
});
test('reorder requires exact complete item identities and preserves canonical provenance', () => {
  const controller = setup(); controller.accept(payload('one'), 'one');
  assert.equal(controller.reorder(['b', 'a']), true);
  const state = controller.getSnapshot();
  assert.deepEqual(model.visiblePlaylistRows(state.resource.data.detail, model.playlistDraft(state)).map(row => row.source_ref), ['source:b', 'source:a']);
  assert.equal(controller.reorder(['a', 'a']), false); assert.equal(controller.reorder(['a']), false);
  controller.accept(payload('one', {items_complete: false}), 'one'); assert.equal(controller.reorder(['b', 'a']), false);
  controller.accept(payload('one', {track_rows: [{title: 'No authoritative item ID'}]}), 'one');
  assert.equal(controller.reorder(['projection:0']), false);
});
test('filters and TXT keep order, unresolved originals and immutable source rows', () => {
  const rows = [track('a', 'missing'), track('b', 'local'), track('c')];
  const detail = model.normalizePlaylistPayload(payload('one', {track_rows: rows})).detail;
  const filtered = model.visiblePlaylistRows(detail, {item_order: ['c', 'b', 'a']}, {query: 'Track', availability: 'all'});
  assert.deepEqual(filtered.map(row => row.playlist_item_id), ['c', 'b', 'a']);
  assert.equal(model.playlistText(filtered), 'Artist - Track c [Album]\nArtist - Track b [Album]\nArtist - Track a [Album]');
  assert.equal(model.playlistText(filtered, {missingOnly: true}), 'Artist - Track a [Album]');
  assert.deepEqual(detail.track_rows.map(row => row.playlist_item_id), ['a', 'b', 'c']);
  assert.equal(model.visiblePlaylistRows(detail, null, {query: '', availability: 'missing'}).length, 1);
  assert.equal(model.playlistText([{title: 'a\nb', artist: 'c\td', album_title: 'e\rf'}]), 'c d - a b [e f]');
});
test('metadata writes require current exact permissions and explicit acknowledgement', async () => {
  let calls = 0;
  const controller = setup({providers: {savePlaylist: async () => {calls++; return undefined;}}});
  controller.accept(payload('one'), 'one'); controller.edit({title: 'Changed'});
  assert.equal(await controller.mutate('savePlaylist'), false);
  assert.equal(controller.getSnapshot().mutation.status, 'error');
  assert.equal(model.playlistDraft(controller.getSnapshot()).title, 'Changed');
  controller.accept(payload('one', {allowed_actions: {can_edit: true, can_rename: false}}), 'one');
  assert.equal(await controller.mutate('savePlaylist'), false); assert.equal(calls, 1);
  assert.equal(controller.edit({title: 'No'}), false); assert.equal(controller.edit({description: 'Allowed local draft'}), true);
});
test('write stays busy through authoritative refresh and rejects duplicate writes', async () => {
  const write = deferred(), read = deferred(); let calls = 0, received;
  const controller = setup({readPlaylists: () => read.promise, providers: {savePlaylist: args => {received = args; calls++; return write.promise;}}});
  controller.accept(payload('one'), 'one'); controller.edit({title: ' New title '});
  const pending = controller.mutate('savePlaylist');
  assert.equal(await controller.mutate('savePlaylist'), false); assert.equal(calls, 1);
  assert.equal(received.title, 'New title'); assert.equal(received.revision, 'r1'); assert.equal(received.playlist_id, 'one');
  write.resolve({ok: true}); await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.getSnapshot().mutation.status, 'loading');
  assert.equal(await controller.mutate('savePlaylist'), false);
  read.resolve(payload('one', {title: 'New title', revision: 'r2'})); assert.equal(await pending, true);
  assert.equal(controller.getSnapshot().mutation.status, 'ready');
  assert.equal(model.playlistDraft(controller.getSnapshot()), null);
});
test('scope changes, suspension and native refresh invalidate delayed mutation acknowledgements', async () => {
  for (const invalidate of [controller => controller.setScope('next'), controller => controller.suspend(), controller => controller.accept(payload('two'), 'two')]) {
    const write = deferred(); let reads = 0;
    const controller = setup({readPlaylists: async () => {reads++; return payload();}, providers: {savePlaylist: () => write.promise}});
    controller.accept(payload('one'), 'one'); controller.edit({title: 'Change'}); const pending = controller.mutate('savePlaylist');
    invalidate(controller); write.resolve({ok: true}); assert.equal(await pending, false); assert.equal(reads, 0);
    assert.equal(controller.getSnapshot().mutation.status, 'idle');
  }
});
test('sharing modes/recipients require an authorized current read projection', async () => {
  let calls = 0;
  const share = {mode: 'private', allowed_modes: ['private', 'people'], can_manage: true, people: [
    {account_ref: 'owner', display_name: 'Owner', selected: true, role: 'editor', can_edit: false},
    {account_ref: 'friend', display_name: 'Friend', selected: false, role: 'viewer', can_edit: true},
  ]};
  const controller = setup({providers: {readSharing: async () => share, saveSharing: async () => {calls++; return {ok: true};}}});
  controller.accept(payload('one'), 'one');
  assert.equal(await controller.mutate('saveSharing', {mode: 'people', people: []}), false);
  assert.equal((await controller.readSharing()).status, 'ready');
  assert.equal(await controller.mutate('saveSharing', {mode: 'link', people: [{account_ref: 'owner', role: 'editor'}]}), false);
  assert.equal(await controller.mutate('saveSharing', {mode: 'people', people: [{account_ref: 'stranger', role: 'viewer'}]}), false);
  assert.equal(await controller.mutate('saveSharing', {mode: 'people', people: []}), false);
  assert.equal(await controller.mutate('saveSharing', {mode: 'people', people: [{account_ref: 'owner', role: 'editor'}, {account_ref: 'friend', role: 'viewer'}]}), true);
  assert.equal(calls, 1);
});
test('denied mutation erases protected records and drafts', async () => {
  const controller = setup({providers: {savePlaylist: async () => ({status: 'denied'})}});
  controller.accept(payload('one'), 'one'); controller.edit({title: 'Draft'});
  await controller.mutate('savePlaylist');
  assert.equal(controller.getSnapshot().resource.status, 'denied');
  assert.deepEqual(controller.getSnapshot().drafts, {});
});
test('dispose aborts pending providers and makes controller inert', async () => {
  const read = deferred(); let signal;
  const controller = setup({readPlaylists: args => {signal = args.signal; return read.promise;}});
  const pending = controller.load(); controller.dispose(); assert.equal(signal.aborted, true);
  read.resolve(payload()); await pending; assert.equal(controller.getSnapshot().resource.data, null);
  assert.equal(controller.accept(payload()), false); assert.equal(await controller.load(), false);
});

test('sparse directory/track/provider arrays are rejected instead of skipping missing identities', async () => {
  assert.throws(() => model.normalizePlaylistPayload({...payload(), playlist_index: {playlists: Array(1)}}));
  assert.throws(() => model.normalizePlaylistPayload(payload('one', {track_rows: Array(1)})));
  assert.throws(() => model.normalizeSharing({mode: 'private', allowed_modes: Array(1), people: []}));
  const controller = setup({providers: {addTracks: async () => {throw new Error('must not call');}}});
  controller.accept(payload('one'), 'one'); assert.equal(await controller.mutate('addTracks', Array(1)), false);
});
test('explicit unreadable markers suppress private text and every TXT export', () => {
  const detail = model.normalizePlaylistPayload(payload('one', {track_rows: [
    {...track('a', 'missing'), source_readable: false, title: 'Never expose A'},
    {...track('b'), allowed_actions: {can_read: false}, title: 'Never expose B'}, track('c'),
  ]})).detail;
  assert.equal(JSON.stringify(detail).includes('Never expose'), false);
  assert.equal(model.playlistText(detail.track_rows), 'Artist - Track c [Album]');
  assert.equal(model.playlistText(detail.track_rows, {missingOnly: true}), '');
});
test('sharing rejects unexpected response states and unsupported roles', async () => {
  assert.throws(() => model.normalizeSharing({mode: 'private', allowed_modes: ['private'], people: [{account_ref: 'a', role: 'admin'}]}));
  const controller = setup({providers: {readSharing: async () => ({status: 'error', data: {mode: 'private', allowed_modes: ['private'], people: []}})}});
  controller.accept(payload('one'), 'one'); assert.equal((await controller.readSharing()).status, 'error');
});
test('authoritative immutable rows retain object identity across local edits', () => {
  const controller = setup(); controller.accept(payload('one'), 'one');
  const before = controller.getSnapshot().resource.data.detail;
  controller.edit({description: 'Presentation only'});
  assert.equal(controller.getSnapshot().resource.data.detail, before);
  controller.dispose(); const disposed = controller.getSnapshot(); controller.configure({readPlaylists: () => payload()});
  assert.equal(controller.getSnapshot(), disposed);
});

test('canonical-order authoring requires explicit current native sort and rejects rich-filter views', () => {
  const controller = setup();
  for (const active_sort of [undefined, {key: 'title', direction: 'asc'}, {key: 'playlist_position', direction: 'desc'}]) {
    controller.accept(payload('one', {active_sort}), 'one');
    assert.equal(controller.getSnapshot().resource.data.detail.author_order, false);
    assert.equal(controller.reorder(['b', 'a']), false);
  }
  controller.accept(payload('one'), 'one');
  assert.equal(controller.reorder(['b', 'a']), true);
  controller.filter({love: 'loved'}); assert.equal(controller.reorder(['a', 'b']), false);
  controller.filter(model.defaultFilters); assert.equal(controller.reorder(['a', 'b']), true);
});
test('richer provider facts remain separate from scrobbles and private native media refs', () => {
  const value = model.normalizePlaylistPayload(payload('one', {track_rows: [{...track('a'),
    listen_count: 20, duration_seconds: 179.5, love_tier: 'loved', styles: ['Rock'], added_at: '2026-10-07T12:00:00Z',
    track_stats: {scrobble_count: 900}, path: '/private/source.flac', track_ref: 'private-path',
    allowed_actions: {can_view_details: true, can_review_matches: true, can_accept_match: true}}]}));
  const row = value.detail.track_rows[0];
  assert.equal(row.listen_count, 20); assert.equal(row.duration_seconds, 179.5); assert.equal(row.love_tier, 'loved');
  assert.equal('path' in row, false); assert.equal('track_ref' in row, false); assert.equal('track_stats' in row, false);
  assert.equal(row.allowed_actions.can_review_matches, true);
  assert.equal(model.visiblePlaylistRows(value.detail, null, {...model.defaultFilters, frequency: 'frequent'}).length, 1);
});
test('filtered view never mutates complete draft order or source provenance for export', () => {
  const controller = setup(); controller.accept(payload('one'), 'one'); controller.reorder(['b', 'a']);
  controller.filter({availability: 'missing', query: 'Track a'});
  const state = controller.getSnapshot(), detail = state.resource.data.detail, draft = model.playlistDraft(state);
  assert.deepEqual(model.visiblePlaylistRows(detail, draft, model.playlistFilters(state)).map(row => row.playlist_item_id), ['a']);
  const complete = model.visiblePlaylistRows(detail, draft, model.defaultFilters);
  assert.deepEqual(complete.map(row => row.source_ref), ['source:b', 'source:a']);
  assert.equal(model.playlistText(complete), 'Artist - Track b [Album]\nArtist - Track a [Album]');
  assert.equal(model.playlistText(complete, {missingOnly: true}), 'Artist - Track a [Album]');
});
test('same-ID authoritative replacement revokes a previously read sharing recipient set', async () => {
  let calls = 0;
  const controller = setup({providers: {
    readSharing: async () => ({mode: 'private', allowed_modes: ['private', 'people'], can_manage: true,
      people: [{account_ref: 'friend', role: 'viewer', selected: false, can_edit: true}]}),
    saveSharing: async () => {calls++; return {ok: true};},
  }});
  controller.accept(payload('one'), 'one'); await controller.readSharing();
  controller.accept(payload('one', {revision: 'r2'}), 'one');
  assert.equal(await controller.mutate('saveSharing', {mode: 'people', people: [{account_ref: 'friend', role: 'viewer'}]}), false);
  assert.equal(calls, 0);
});

test('synchronous loading subscribers retire reads before a provider is called', async () => {
  for (const retire of [c => c.setScope('next'), c => c.configure({readPlaylists: async () => payload()}), c => c.dispose()]) {
    let calls = 0; const controller = setup({readPlaylists: async () => {calls++; return payload();}});
    const unsubscribe = controller.subscribe(() => {if (controller.getSnapshot().resource.status === 'loading') {unsubscribe(); retire(controller);}});
    assert.equal(await controller.load(), false); assert.equal(calls, 0);
  }
});
test('synchronous mutation subscribers cannot call old or replacement writers', async () => {
  for (const mode of ['scope', 'configure', 'dispose']) {
    let calls = 0; const writer = async () => {calls++; return {ok: true};};
    const controller = setup({providers: {savePlaylist: writer}}); controller.accept(payload('one'), 'one'); controller.edit({title: 'Draft'});
    const unsubscribe = controller.subscribe(() => {if (controller.getSnapshot().mutation.status === 'loading') {
      unsubscribe(); if (mode === 'scope') controller.setScope('next'); else if (mode === 'configure') controller.configure({savePlaylist: writer, addTracks: writer}); else controller.dispose();
    }});
    assert.equal(await controller.mutate('savePlaylist'), false); assert.equal(calls, 0);
  }
});
test('acknowledgement and denial subscribers cannot refresh or stamp a different scope', async () => {
  for (const response of [{ok: true}, {status: 'denied'}]) {
    let reads = 0; const controller = setup({readPlaylists: async () => {reads++; return payload('one');}, providers: {savePlaylist: async () => response}});
    controller.accept(payload('one'), 'one'); controller.edit({title: 'Draft'});
    const unsubscribe = controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      if (snapshot.mutation.status === 'loading' && (snapshot.resource.status === 'denied' || !model.playlistDraft(snapshot))) {unsubscribe(); controller.setScope('next');}
    });
    assert.equal(await controller.mutate('savePlaylist'), false); assert.equal(reads, 0);
    assert.equal(controller.getSnapshot().scopeKey, 'next'); assert.equal(controller.getSnapshot().mutation.status, 'idle');
  }
});
test('projection acceptance and selection stop after synchronous owner replacement', async () => {
  const controller = setup({readPlaylists: async () => {throw Error('retired reader called');}});
  let unsubscribe = controller.subscribe(() => {unsubscribe(); controller.setScope('next');});
  assert.equal(controller.accept(payload('one'), 'one'), false); assert.equal(controller.getSnapshot().resource.data, null);
  controller.accept(payload());
  unsubscribe = controller.subscribe(() => {if (controller.getSnapshot().selectedPlaylistId) {unsubscribe(); controller.setScope('third');}});
  assert.equal(controller.select('one'), false); assert.equal(controller.getSnapshot().scopeKey, 'third');
});
test('reorder cannot carry a draft into a scope replaced by its first publication', () => {
  const controller = setup(); controller.accept(payload('one'), 'one');
  const unsubscribe = controller.subscribe(() => {unsubscribe(); controller.setScope('next');});
  assert.equal(controller.reorder(['b', 'a']), false); assert.deepEqual(controller.getSnapshot().drafts, {});
});

test('present non-true read markers never become readable Playlist rows or missing export candidates', () => {
  for (const can_read of [false, 0, 'false', undefined, null]) {
    const detail = model.normalizePlaylistPayload(payload('one', {track_rows: [
      {...track('private', 'missing'), title: 'Private metadata', allowed_actions: {can_read, can_play: true}},
      track('legacy', 'missing'), {...track('allowed', 'missing'), allowed_actions: {can_read: true}},
    ]})).detail;
    assert.equal(detail.track_rows[0].source_readable, false);
    assert.doesNotMatch(JSON.stringify(detail), /Private metadata/);
    assert.equal(model.playlistText(detail.track_rows, {missingOnly: true}), 'Artist - Track legacy [Album]\nArtist - Track allowed [Album]');
  }
});
