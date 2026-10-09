const test = require('node:test');
const assert = require('node:assert/strict');
let create;
test.before(async () => {({createPlaylistBackendProviders: create} = await import('../../../music_app/static/js/playlists/backend-providers.mjs'));});
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const actor_scope = {account_id: 4, library_id: 5};
const source = {kind: 'library', ref: id(1), revision: id(2)};
const header = {source_protocol: 'library_selection_v1', mode: 'ordinary', source, actor_scope,
  expires_at: '2099-01-01T00:00:00+00:00',
  allowed_actions: {can_read: true, can_use_for_playlist: true}, page_size: 100, max_selected_entries: 5000, max_command_bytes: 524288};
const destinations = {status: 'ready', data: {actor_scope, destinations: [{playlist_id: id(9), title: 'Saved', revision: '3',
  allowed_actions: {can_add: true, can_open: true}}], allowed_actions: {can_create: true}, playlist_creation_protocol: 'library_selection_v1'}};
const fixture = custom => {
  const calls = []; let context = 'context:one', scopeKey = 'scope:one';
  const transport = {context: () => context, query: (path, values) => {
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value != null) params.set(key, value);
    return `${path}?${params}`;
  }, async request(path, options = {}) {
    calls.push({path, ...options});
    if (custom) {const result = await custom(path, options); if (result !== undefined) return result;}
    if (path === '/playlists/destinations') return structuredClone(destinations);
    if (path === '/playlists/creation-source/current') return {status: 'ready', data: structuredClone(header)};
    if (path.startsWith('/playlists/creation-source/entries')) return {status: 'ready', data: {...structuredClone(header), entries_complete: false,
      entries: [{entry_ref: id(3), selection_ref: id(4), inventory_track_ref: 'inventory-track:5:1', canonical_track_ref: null}],
      query: '', search_revision: id(5), limit: 100, has_more: false, next_cursor: null}};
    if (options.method) return {ok: true, action: 'add', request_key: options.body.request_key, playlist_id: id(9), revision: '4', changed: true, actor_scope};
    throw new Error(`Unexpected path: ${path}`);
  }};
  const runtime = {snapshot: () => ({scopeKey}), readPlaylists: async () => ({playlist_actions: {can_create: true}, playlist_creation_protocol: 'library_selection_v1',
    playlist_sidebar: {items: []}, playlist_index: {playlists: []}})};
  return {providers: create({transport, runtime}), calls, runtime, changeScope: () => {scopeKey = 'scope:two'; context = 'context:two';}, changeContext: () => {context = 'context:two';}};
};
const options = {scopeKey: 'scope:one', signal: new AbortController().signal};

test('ordinary source cached within lifecycle and pages retain false completeness without inventory evidence', async () => {
  const {providers, calls, changeContext} = fixture();
  const first = await providers.readPlaylists(options), second = await providers.readPlaylists(options);
  assert.deepEqual(first.playlist_creation_source, second.playlist_creation_source);
  assert.equal(calls.filter(call => call.path === '/playlists/creation-source/current').length, 1);
  const page = await providers.readPlaylistCreationSource({...options, source, mode: 'ordinary'});
  assert.equal(page.data.entries_complete, false); assert.equal(page.data.scopeKey, options.scopeKey);
  assert.equal(page.data.actor_scope, undefined); assert.equal(page.data.entries[0].inventory_track_ref, undefined);
  changeContext(); await providers.readPlaylists(options);
  assert.equal(calls.filter(call => call.path === '/playlists/creation-source/current').length, 2);
});

test('only a deliberate new opening renews an expired source; old source remains pinned for existing forms', async () => {
  let begins = 0;
  const next = {kind: 'library', ref: id(21), revision: id(22)};
  const {providers, calls} = fixture(path => path === '/playlists/creation-source/current' ? {status: 'ready', data: {
    ...header, source: ++begins === 1 ? source : next, expires_at: begins === 1 ? '2000-01-01T00:00:00Z' : header.expires_at}} : undefined);
  const first = await providers.readPlaylists(options);
  const refresh = await providers.readPlaylists(options);
  assert.deepEqual(refresh.playlist_creation_source, first.playlist_creation_source);
  assert.equal(begins, 1, 'background reads cannot replace an existing draft source');
  const renewed = await providers.beginPlaylistCreationSource({...options, renewExpired: true});
  assert.equal(renewed.ref, next.ref); assert.equal(begins, 2);
  await providers.readPlaylistCreationSource({...options, mode: 'ordinary', source});
  assert.match(calls.at(-1).path, new RegExp(`source_ref=${source.ref}`), 'previous source identity was retained, not rebound');
  assert.equal((await providers.readPlaylists(options)).playlist_creation_source.ref, next.ref);
  await providers.beginPlaylistCreationSource({...options, renewExpired: true});
  assert.equal(begins, 2, 'a fresh source is reusable at the next opening');
});

test('server-reported source expiry permits renewal on next opening despite client-clock disagreement', async () => {
  let begins = 0;
  const {providers} = fixture(path => {
    if (path === '/playlists/creation-source/current') {begins++; return {status: 'ready', data: {...header,
      source: begins === 1 ? source : {kind: 'library', ref: id(21), revision: id(22)}}};}
    if (path.startsWith('/playlists/creation-source/entries')) throw Object.assign(new Error('Expired'), {status: 410, code: 'source_expired', responseRejected: true});
  });
  await providers.readPlaylists(options);
  await assert.rejects(providers.readPlaylistCreationSource({...options, mode: 'ordinary', source}));
  await providers.readPlaylists(options); assert.equal(begins, 1);
  const renewed = await providers.beginPlaylistCreationSource({...options, renewExpired: true});
  assert.equal(begins, 2); assert.equal(renewed.ref, id(21));
});

test('expired-source renewal must reconcile the old uncertain Create before another source can begin', async () => {
  let begins = 0, committed = null, resolve = false;
  const {providers, calls} = fixture((path, request) => {
    if (path === '/playlists/creation-source/current') {begins++; return {status: 'ready', data: {...header,
      source: begins === 1 ? source : {kind: 'library', ref: id(21), revision: id(22)}, expires_at: '2000-01-01T00:00:00Z'}};}
    if (path === '/playlists') {
      committed = {ok: true, action: 'create', playlist_id: id(8), revision: '1', changed: true,
        request_key: request.body.request_key, actor_scope};
      throw new Error('Connection lost after commit');
    }
    if (path.startsWith('/playlists/operations/')) return resolve ? {status: 'committed', receipt: committed} : {status: 'unknown'};
  });
  await providers.readPlaylists(options);
  await assert.rejects(providers.createPlaylistFromSelection({...options, mode: 'ordinary', source,
    source_protocol: 'library_selection_v1', title: 'Pending', description: '', entry_refs: [], request_key: id(6)}));
  await assert.rejects(providers.beginPlaylistCreationSource({...options, renewExpired: true}), /still unknown/);
  assert.equal(begins, 1); assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
  resolve = true;
  const recovery = await providers.beginPlaylistCreationSource({...options, renewExpired: true});
  assert.equal(recovery.recovered_creation.request_key, id(6)); assert.equal(recovery.recovered_creation.playlist_id, id(8));
  assert.equal(recovery.ref, source.ref); assert.equal(begins, 1, 'confirming the original Create precedes starting another source');
  assert.equal((await providers.beginPlaylistCreationSource({...options, renewExpired: true})).ref, id(21));
  assert.equal(begins, 2); assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
  assert.ok(calls.filter(call => call.path.startsWith('/playlists/operations/')).every(call => call.path.endsWith(id(6))));
});

test('selected inventory and activity reopen recover original key before creating a replacement source', async () => {
  for (const kind of ['inventory', 'activity']) {
    let committed, resolve = false;
    const {providers, calls} = fixture((path, request) => {
      if (path === '/playlists') {committed = {ok: true, action: 'create', request_key: request.body.request_key,
        playlist_id: id(8), revision: '1', changed: true, actor_scope}; throw new Error('Connection lost');}
      if (path.startsWith('/playlists/operations/')) return resolve ? {status: 'committed', receipt: committed} : {status: 'unknown'};
    });
    await providers.readPlaylists(options);
    await assert.rejects(providers.createPlaylistFromSelection({...options, source, source_protocol: 'library_selection_v1',
      mode: 'ordinary', title: 'Original', description: '', entry_refs: [], request_key: id(6)}));
    const reopen = () => kind === 'inventory' ? providers.beginPlaylistSelectionSource({...options, track_refs: ['inventory-track:5:7']})
      : providers.beginPlaylistActivitySource({...options, row_refs: [`activity_${'a'.repeat(64)}`],
        origin: {audience: 'own', subject_ref: null, kind: 'tracks', period: 'all', snapshot_ref: 'a'.repeat(43)}});
    await assert.rejects(reopen(), /still unknown/); resolve = true;
    const recovered = await reopen();
    assert.equal(recovered.recovered_creation.request_key, id(6)); assert.equal(recovered.source, undefined);
    assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
    assert.equal(calls.filter(call => ['/playlists/creation-source/selection', '/playlists/creation-source/activity'].includes(call.path)).length, 0);
  }
});

test('uncertain Create survives valid Home-to-Playlist scope switch under one authenticated context', async () => {
  let committed, resolved = false;
  const f = fixture((path, request) => {
    if (path === '/playlists/creation-source/selection') return {status: 'ready', data: {...header,
      source_protocol: 'complete_inventory_selection_v1', entries_complete: true,
      entries: [{entry_ref: id(3), inventory_track_ref: 'inventory-track:5:7'}]}};
    if (path === '/playlists') {committed = {ok: true, action: 'create', request_key: request.body.request_key,
      playlist_id: id(8), revision: '1', changed: true, actor_scope}; throw new Error('Connection lost');}
    if (path.startsWith('/playlists/operations/')) return resolved ? {status: 'committed', receipt: committed} : {status: 'unknown'};
  });
  const accepted = new Set(['scope:one', 'home:one']); f.runtime.acceptsPrivateScope = value => accepted.has(value);
  const home = {...options, scopeKey: 'home:one'};
  const selected = await f.providers.beginPlaylistSelectionSource({...home, track_refs: ['inventory-track:5:7']});
  await assert.rejects(f.providers.createPlaylistFromSelection({...home, source: selected.source, source_protocol: 'complete_inventory_selection_v1',
    mode: 'ordinary', title: 'From Home', description: '', entry_refs: selected.entry_refs, request_key: id(6)}));
  accepted.delete('home:one'); await f.providers.readPlaylists(options);
  await assert.rejects(f.providers.beginPlaylistCreationSource({...options, renewExpired: true}), /still unknown/);
  resolved = true;
  const recovery = await f.providers.beginPlaylistCreationSource({...options, renewExpired: true});
  assert.equal(recovery.recovered_creation.request_key, id(6)); assert.equal(recovery.recovered_creation.scopeKey, options.scopeKey);
  assert.equal(f.calls.filter(call => call.path === '/playlists').length, 1);
});

test('same command under a replacement key never receives the original key as its acknowledgement', async () => {
  let committed, resolved = false;
  const {providers, calls} = fixture((path, request) => {
    if (path === '/playlists') {committed = {ok: true, action: 'create', request_key: request.body.request_key,
      playlist_id: id(8), revision: '1', changed: true, actor_scope}; throw new Error('Connection lost');}
    if (path.startsWith('/playlists/operations/')) return resolved ? {status: 'committed', receipt: committed} : {status: 'unknown'};
  });
  await providers.readPlaylists(options);
  const command = {...options, source, source_protocol: 'library_selection_v1', mode: 'ordinary', title: 'Same', description: '', entry_refs: []};
  await assert.rejects(providers.createPlaylistFromSelection({...command, request_key: id(6)})); resolved = true;
  await assert.rejects(providers.createPlaylistFromSelection({...command, request_key: id(7)}), /Previous Playlist change confirmed/);
  assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
});

test('Add sends exact inventory refs and fresh revision, with exact receipt validation before scopeKey', async () => {
  const {providers, calls} = fixture(); await providers.readPlaylistDestinations(options);
  const ack = await providers.addTracks({...options, playlist_id: id(9), track_refs: ['inventory-track:5:7']});
  const call = calls.at(-1);
  assert.equal(call.path, `/playlists/${id(9)}/items`); assert.equal(call.method, 'POST');
  assert.deepEqual(Object.keys(call.body).sort(), ['request_key', 'revision', 'track_refs']);
  assert.equal(call.body.revision, '3'); assert.equal(ack.scopeKey, options.scopeKey); assert.equal(ack.actor_scope, undefined);
  assert.throws(() => providers.addTracks({...options, playlist_id: id(9), track_refs: ['C:\\music\\song.mp3']}));
});

test('ambiguous Create reconciles the same key, never repeats POST or creates a new key', async () => {
  let committed = null, allowReconcile = false;
  const {providers, calls} = fixture(async (path, request) => {
    if (path === '/playlists') {
      committed = {ok: true, action: 'create', playlist_id: id(8), revision: '1', changed: true,
        request_key: request.body.request_key, actor_scope};
      throw new TypeError('Connection lost after commit');
    }
    if (path.startsWith('/playlists/operations/')) return allowReconcile ? {status: 'committed', receipt: committed} : {status: 'unknown'};
  });
  await providers.readPlaylists(options);
  const input = {...options, mode: 'ordinary', source, source_protocol: 'library_selection_v1', title: 'Saved', description: '', entry_refs: [id(3)], request_key: id(6)};
  await assert.rejects(providers.createPlaylistFromSelection(input), /still unknown/);
  allowReconcile = true;
  const ack = await providers.reconcilePlaylistOperation({...options, action: 'create', request_key: id(6)});
  assert.equal(ack.status, 'ready'); assert.equal(ack.data.playlist_id, id(8));
  assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
  assert.ok(calls.filter(call => call.path.startsWith('/playlists/operations/')).every(call => call.path.endsWith(id(6))));
});

test('wrong action, target, key or actor can never become an acknowledged mutation', async () => {
  for (const patch of [{action: 'remove'}, {playlist_id: id(7)}, {request_key: id(6)}, {actor_scope: {account_id: 40, library_id: 5}}]) {
    const {providers} = fixture((path, request) => {
      if (path.startsWith('/playlists/operations/')) return {status: 'unknown'};
      if (request.method === 'POST') return {ok: true, action: 'add', request_key: request.body.request_key, playlist_id: id(9), revision: '4', changed: true, actor_scope, ...patch};
    });
    await providers.readPlaylistDestinations(options);
    await assert.rejects(providers.addTracks({...options, playlist_id: id(9), track_refs: ['inventory-track:5:7']}));
  }
});

test('selected inventory begins distinct complete protocol and Create does not send inventory refs', async () => {
  const selectedHeader = {...header, source_protocol: 'complete_inventory_selection_v1', entries_complete: true,
    entries: [{entry_ref: id(3), inventory_track_ref: 'inventory-track:5:7', canonical_track_ref: null}], retained_parent_albums: []};
  const {providers, calls} = fixture((path, request) => {
    if (path === '/playlists/creation-source/selection' || path.startsWith('/playlists/creation-source/complete?')) return {status: 'ready', data: selectedHeader};
    if (path === '/playlists') return {status: 'ready', data: {ok: true, action: 'create', request_key: request.body.request_key,
      playlist_id: id(8), revision: '1', changed: true, actor_scope}};
  });
  const selected = await providers.beginPlaylistSelectionSource({...options, track_refs: ['inventory-track:5:7']});
  const read = await providers.readPlaylistCreationSource({...options, source: selected.source, mode: 'ordinary'});
  assert.equal(read.data.entries_complete, true); assert.equal(read.data.source_protocol, 'complete_inventory_selection_v1');
  const ack = await providers.createPlaylistFromSelection({...options, source: selected.source, source_protocol: read.data.source_protocol,
    mode: 'ordinary', title: 'Selected', description: '', entry_refs: selected.entry_refs, request_key: id(6)});
  assert.equal(ack.data.scopeKey, options.scopeKey);
  assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['description', 'entry_refs', 'mode', 'request_key', 'source', 'source_protocol', 'title']);
});

test('missing source keeps its Playlist identity and protocol through the unsaved page Save', async () => {
  const {createPlaylistCreationController} = await import('../../../music_app/static/js/playlists/creation.mjs');
  const {createMissingPlaylistDraftController} = await import('../../../music_app/static/js/playlists/draft.mjs');
  const missingSource = {kind: 'playlist', ref: id(9), revision: '3', allowed_actions: header.allowed_actions};
  const {providers, calls} = fixture((path, request) => {
    if (path.startsWith(`/playlists/${id(9)}/missing-source?`)) return {status: 'ready', data: {
      ...header, capture_ref: id(90), source: missingSource, mode: 'missing', source_protocol: 'missing_playlist_selection_v1', entries_complete: true,
      entries: [{entry_ref: id(3), title: 'Missing original', availability: 'missing', allowed_actions: {can_read: true, can_select: true},
        parent_album: {state: 'unknown'}}], retained_parent_albums: []}};
    if (path === '/playlists') return {status: 'ready', data: {ok: true, action: 'create', request_key: request.body.request_key,
      playlist_id: id(8), revision: '1', changed: true, actor_scope}};
  });
  const controller = createPlaylistCreationController({providers});
  controller.setContext({...options, canCreate: true, mode: 'missing', source: missingSource});
  assert.equal(await controller.load(), true); controller.edit({title: 'Missing'});
  const prepared = controller.prepareDraft();
  assert.equal(prepared.source_protocol, 'missing_playlist_selection_v1');
  assert.equal(calls.some(call => call.path === '/playlists'), false);
  const draft = createMissingPlaylistDraftController({prepared, providers});
  assert.equal(draft.canSave(), true); assert.ok(await draft.save());
  assert.equal(calls.at(-1).body.mode, 'missing');
  assert.equal(calls.at(-1).body.source_protocol, 'missing_playlist_selection_v1');
  assert.deepEqual(calls.at(-1).body.source, {kind: 'playlist', ref: id(9), revision: '3'});
  controller.dispose(); draft.dispose();
});

test('default sort uses authenticated Playlist CAS and is verified like other receipts', async () => {
  const {providers, calls} = fixture((path, request) => {
    if (path.endsWith('/default-sort')) return {ok: true, action: 'default_sort', request_key: request.body.request_key,
      playlist_id: id(9), revision: '4', changed: true, actor_scope, saved_default_sort: request.body.sort};
  });
  await providers.readPlaylistDestinations(options);
  const result = await providers.saveDefaultSort({...options, playlist_id: id(9), revision: '3', sort: {key: 'duration', direction: 'desc'}});
  assert.equal(result.action, 'default_sort'); assert.equal(result.scopeKey, options.scopeKey);
  assert.deepEqual(calls.at(-1).body.sort, {key: 'duration', direction: 'desc'});
  assert.equal(calls.at(-1).body.revision, '3');
});

test('a local stale-context error after dispatch remains ambiguous and cannot dispatch a second write', async () => {
  const {providers, calls} = fixture((path, request) => {
    if (path.startsWith('/playlists/operations/')) return {status: 'unknown'};
    if (request.method === 'POST') throw Object.assign(new Error('Local context mismatch'), {status: 409, code: 'stale_context'});
  });
  await providers.readPlaylistDestinations(options);
  const request = {...options, playlist_id: id(9), revision: '3', track_refs: ['inventory-track:5:7']};
  await assert.rejects(providers.addTracks(request)); await assert.rejects(providers.addTracks(request));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('unknown missing-page Save reconciles its retained key without creating again', async () => {
  const {createPlaylistCreationController} = await import('../../../music_app/static/js/playlists/creation.mjs');
  const {createMissingPlaylistDraftController} = await import('../../../music_app/static/js/playlists/draft.mjs');
  const missingSource = {kind: 'playlist', ref: id(9), revision: '3', allowed_actions: header.allowed_actions};
  let committed, resolved = false;
  const {providers, calls} = fixture((path, request) => {
    if (path.startsWith(`/playlists/${id(9)}/missing-source?`)) return {status: 'ready', data: {
      ...header, capture_ref: id(90), source: missingSource, mode: 'missing', source_protocol: 'missing_playlist_selection_v1', entries_complete: true,
      entries: [{entry_ref: id(3), title: 'Missing original', availability: 'missing', allowed_actions: {can_read: true, can_select: true},
        parent_album: {state: 'unknown'}}], retained_parent_albums: []}};
    if (path === '/playlists') {
      committed = {ok: true, action: 'create', request_key: request.body.request_key, playlist_id: id(8), revision: '1', changed: true, actor_scope};
      throw new Error('Connection lost');
    }
    if (path.startsWith('/playlists/operations/')) return resolved ? {status: 'committed', receipt: committed} : {status: 'unknown'};
  });
  const form = createPlaylistCreationController({providers});
  form.setContext({...options, canCreate: true, mode: 'missing', source: missingSource});
  assert.equal(await form.load(), true); form.edit({title: 'Missing'});
  const draft = createMissingPlaylistDraftController({prepared: form.prepareDraft(), providers});
  assert.equal(await draft.save(), false); assert.equal(draft.canSave(), false); assert.equal(draft.canReconcile(), true);
  const key = draft.getSnapshot().mutation.request_key;
  resolved = true; assert.ok(await draft.reconcile());
  assert.equal(draft.getSnapshot().mutation.request_key, key);
  assert.equal(calls.filter(call => call.path === '/playlists').length, 1);
  draft.dispose(); form.dispose();
});

test('old scope cannot read or write as a replacement actor, and writes carry their captured context', async () => {
  const f = fixture(); await f.providers.readPlaylistDestinations(options);
  await f.providers.addTracks({...options, playlist_id: id(9), track_refs: ['inventory-track:5:1']});
  assert.equal(f.calls.at(-1).expected, 'context:one');
  const before = f.calls.length; f.changeScope();
  assert.throws(() => f.providers.deletePlaylist({...options, playlist_id: id(9), revision: '4'}), /context unavailable/);
  await assert.rejects(f.providers.readSharing({...options, playlist_id: id(9)}), /context unavailable/);
  assert.equal(f.calls.length, before);
});
const sharingFixture = custom => fixture((path, request) => {
  if (custom) {const result = custom(path, request); if (result !== undefined) return result;}
  if (path.endsWith('/access-grants') && !request.method) return {playlist_id: id(9), revision: '3', visibility: 'private', actor_scope,
    grants: [{grant_ref: id(10), account_ref: id(12), account_id: 12, display_name: 'Existing', username_display: 'existing', is_active: false, role: 'editor'}]};
  if (path.includes('/access-candidates?')) return {playlist_id: id(9), revision: '3', actor_scope, next_cursor: 'opaque-next',
    candidates: [{account_ref: id(13), account_id: 13, display_name: '<Member>', username_display: 'member', grant_ref: null, role: null, allowed_actions: {can_grant_editor: true}}]};
  if (request.method) return {ok: true, action: path.endsWith('/visibility') ? 'visibility' : request.method === 'DELETE' ? 'revoke_editor' : 'grant_editor',
    request_key: request.body.request_key, playlist_id: id(9), revision: '4', changed: true, actor_scope};
});
test('sharing projects named editor candidates without numeric identity, and privately writes exact grant/revoke commands', async () => {
  for (const selected of [true, false]) {
    const f = sharingFixture(), result = await f.providers.readSharing({...options, playlist_id: id(9), q: 'M'});
    assert.equal(result.data.visibility, 'private'); assert.equal(result.data.next_cursor, 'opaque-next');
    assert.equal(result.data.people[0].account_id, undefined); assert.equal(result.data.people[1].display_name, 'Existing');
    assert.equal(result.data.people[1].is_active, false); assert.equal(result.data.actor_scope, undefined);
    await f.providers.setPlaylistEditor({...options, playlist_id: id(9), revision: '3', account_ref: id(selected ? 13 : 12), selected});
    const call = f.calls.at(-1);
    assert.equal(call.method, selected ? 'POST' : 'DELETE');
    assert.equal(call.path, `/playlists/${id(9)}/access-grants${selected ? '' : `/${id(10)}`}`);
    assert.deepEqual(Object.keys(call.body).sort(), selected ? ['account_id', 'request_key', 'revision', 'role'] : ['request_key', 'revision']);
    if (selected) {assert.equal(call.body.account_id, 13); assert.equal(call.body.role, 'editor');}
  }
});
test('sharing fails closed for legacy mode remapping, unknown recipients and changing revisions', async () => {
  const f = sharingFixture(); await f.providers.readSharing({...options, playlist_id: id(9)});
  for (const visibility of ['people', 'link', 'public']) assert.throws(() => f.providers.saveSharing({...options, playlist_id: id(9), revision: '3', visibility}));
  assert.throws(() => f.providers.setPlaylistEditor({...options, playlist_id: id(9), revision: '3', account_ref: id(99), selected: true}));
  assert.throws(() => f.providers.setPlaylistEditor({...options, playlist_id: id(9), revision: '2', account_ref: id(13), selected: true}));
  const changed = sharingFixture(path => path.includes('/access-candidates?') ? {playlist_id: id(9), revision: '4', actor_scope, next_cursor: null, candidates: []} : undefined);
  await assert.rejects(changed.providers.readSharing({...options, playlist_id: id(9)}), /recipients/);
});
test('visibility and delete use distinct exact receipt actions and request bodies', async () => {
  const f = sharingFixture(); await f.providers.readSharing({...options, playlist_id: id(9)});
  await f.providers.saveSharing({...options, playlist_id: id(9), revision: '3', visibility: 'server_shared'});
  assert.deepEqual(Object.keys(f.calls.at(-1).body).sort(), ['request_key', 'revision', 'visibility']);
  assert.equal(f.calls.at(-1).method, 'PATCH');
  const deletion = fixture((path, request) => request.method === 'DELETE' ? {ok: true, action: 'delete', playlist_id: id(9), revision: '4', changed: true, request_key: request.body.request_key, actor_scope} : undefined);
  await deletion.providers.readPlaylistDestinations(options);
  await deletion.providers.deletePlaylist({...options, playlist_id: id(9), revision: '3'});
  assert.deepEqual(Object.keys(deletion.calls.at(-1).body).sort(), ['request_key', 'revision']);
});
test('account preference writes reconcile their exact account operation and never repeat an ambiguous PUT', async () => {
  let receipt, resolve = false, notified;
  const f = fixture((path, request) => {
    if (path === '/account/playlist-preferences' && !request.method) return {preferences: {remember_order_mode: true, last_order_mode: 'shuffle', effective_order_mode: 'shuffle', revision: '1'}};
    if (request.method === 'PUT') {
      receipt = {ok: true, action: 'playlist_preferences', request_key: request.body.request_key, changed: true,
        preferences: {remember_order_mode: false, last_order_mode: 'shuffle', effective_order_mode: 'regular', revision: '2'}};
      throw new TypeError('Lost preference response');
    }
    if (path.startsWith('/account/playlist-preferences/operations/')) return resolve ? {status: 'committed', receipt} : {status: 'unknown'};
  });
  f.runtime.acceptPlaylistPreferences = value => {notified = value;};
  const read = await f.providers.readPlaylistPreferences(options); assert.equal(read.preferences.effective_order_mode, 'shuffle');
  const input = {...options, revision: '1', remember_order_mode: false};
  await assert.rejects(f.providers.savePlaylistPreferences(input), /still unknown/); assert.equal(notified, undefined);
  resolve = true; const result = await f.providers.savePlaylistPreferences(input);
  assert.equal(result.preferences.effective_order_mode, 'regular'); assert.equal(notified, result);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  await assert.rejects(f.providers.savePlaylistPreferences({...options, revision: '2', last_order_mode: 'repeat'}), /Invalid/);
});

test('activity selections use their own complete protocol, exact row receipts and complete reader query', async () => {
  const refs = ['activity_' + 'a'.repeat(64), 'activity_' + 'b'.repeat(64)], activity = {kind: 'activity', ref: id(20), revision: id(21)};
  const f = fixture(path => path === '/playlists/creation-source/activity' || path.startsWith('/playlists/creation-source/complete?')
    ? {status: 'ready', data: {...header, source: activity, source_protocol: 'complete_activity_selection_v1', entries_complete: true,
      entries: refs.map((source_row_ref, index) => ({source_row_ref, entry_ref: id(30 + index), inventory_track_ref: index ? null : 'inventory-track:5:2'}))}} : undefined);
  const origin = {audience: 'own', subject_ref: null, kind: 'tracks', period: 'month', snapshot_ref: 'A'.repeat(43)};
  const selected = await f.providers.beginPlaylistActivitySource({...options, origin, row_refs: refs});
  assert.equal(selected.source.kind, 'activity'); assert.deepEqual(selected.entry_refs, [id(30), id(31)]);
  assert.deepEqual(f.calls.at(-1).body, {origin, row_refs: refs}); assert.equal(f.calls.at(-1).expected, 'context:one');
  const read = await f.providers.readPlaylistCreationSource({...options, source: selected.source, mode: 'ordinary'});
  assert.equal(read.data.entries_complete, true); assert.equal(read.data.entries[0].inventory_track_ref, undefined);
  assert.match(f.calls.at(-1).path, /source_protocol=complete_activity_selection_v1/);
  await assert.rejects(f.providers.beginPlaylistActivitySource({...options, origin: {...origin, audience: 'comparison'}, row_refs: refs}));
  await assert.rejects(f.providers.beginPlaylistActivitySource({...options, origin, row_refs: [refs[0], refs[0]]}));
});

test('invalid account preference acknowledgements remain unconfirmed and cannot update the native preference cache', async () => {
  for (const change of [receipt => ({...receipt, action: 'save'}), receipt => ({...receipt, request_key: id(99)}),
    receipt => ({...receipt, preferences: {...receipt.preferences, effective_order_mode: 'shuffle'}})]) {
    let updates = 0;
    const f = fixture((path, request) => {
      if (path.includes('/playlist-preferences/operations/')) return {status: 'unknown'};
      if (request.method === 'PUT') return change({ok: true, action: 'playlist_preferences', changed: true, request_key: request.body.request_key,
        preferences: {remember_order_mode: false, last_order_mode: 'shuffle', effective_order_mode: 'regular', revision: '2'}});
    });
    f.runtime.acceptPlaylistPreferences = () => {updates++;};
    await assert.rejects(f.providers.savePlaylistPreferences({...options, revision: '1', remember_order_mode: false}), /still unknown/);
    assert.equal(updates, 0); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  }
});

test('explicit retry after lost-before-server Create reuses the immutable original key and payload', async () => {
  const posts = []; let committed = null;
  const f = fixture((path, request) => {
    if (path.includes('/operations/')) return committed ? {status: 'committed', receipt: committed} : {status: 'unknown'};
    if (path === '/playlists' && request.method === 'POST') {
      posts.push(structuredClone(request.body));
      if (posts.length === 1) throw new TypeError('Connection lost before server');
      committed = {ok: true, action: 'create', request_key: request.body.request_key, playlist_id: id(88), revision: '1', changed: true, actor_scope};
      return {status: 'ready', data: committed};
    }
  });
  await f.providers.readPlaylists(options);
  const original = {...options, mode: 'ordinary', source_protocol: 'library_selection_v1', source, title: 'Original title', description: '', entry_refs: [], request_key: id(70)};
  await assert.rejects(f.providers.createPlaylistFromSelection(original), /still unknown/);
  original.title = 'Later unsubmitted edit';
  assert.equal(f.providers.hasPendingPlaylistOperation({...options, action: 'create'}), true);
  const result = await f.providers.retryPlaylistOperation({...options, action: 'create'});
  assert.equal(result.data.request_key, id(70)); assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0]);
  assert.equal(posts[1].title, 'Original title'); assert.equal(f.providers.hasPendingPlaylistOperation({...options, action: 'create'}), false);
});
test('explicit retry reads a landed original receipt without sending another POST', async () => {
  let posts = 0, reads = 0, receipt;
  const f = fixture((path, request) => {
    if (path.includes('/operations/')) return ++reads === 1 ? {status: 'unknown'} : {status: 'committed', receipt};
    if (path === '/playlists' && request.method === 'POST') {
      posts++; receipt = {ok: true, action: 'create', request_key: request.body.request_key, playlist_id: id(88), revision: '1', changed: true, actor_scope};
      throw new TypeError('Response lost after landing');
    }
  });
  await f.providers.readPlaylists(options);
  await assert.rejects(f.providers.createPlaylistFromSelection({...options, mode: 'ordinary', source_protocol: 'library_selection_v1', source, title: 'Once', description: '', entry_refs: [], request_key: id(71)}));
  const result = await f.providers.retryPlaylistOperation({...options, action: 'create'});
  assert.equal(result.data.request_key, id(71)); assert.equal(posts, 1); assert.equal(reads, 2);
});
test('explicit retry cannot dispatch after session rotation during its unknown check', async () => {
  let posts = 0, reads = 0, rotate;
  const f = fixture((path, request) => {
    if (path.includes('/operations/')) {if (++reads === 2) rotate(); return {status: 'unknown'};}
    if (path === '/playlists' && request.method === 'POST') {posts++; throw new TypeError('Lost');}
  });
  rotate = f.changeContext; await f.providers.readPlaylists(options);
  await assert.rejects(f.providers.createPlaylistFromSelection({...options, mode: 'ordinary', source_protocol: 'library_selection_v1', source, title: 'Once', description: '', entry_refs: [], request_key: id(72)}));
  await assert.rejects(f.providers.retryPlaylistOperation({...options, action: 'create'})); assert.equal(posts, 1);
});
test('a malformed operation response is never treated as authoritative unknown for retry', async () => {
  let posts = 0, reads = 0;
  const f = fixture((path, request) => {
    if (path.includes('/operations/')) return {status: ++reads === 1 ? 'unknown' : 'unexpected'};
    if (request.method === 'POST') {posts++; throw new TypeError('Lost');}
  });
  await f.providers.readPlaylistDestinations(options);
  await assert.rejects(f.providers.addTracks({...options, playlist_id: id(9), track_refs: ['inventory-track:5:1']}));
  await assert.rejects(f.providers.retryPlaylistOperation({...options, playlist_id: id(9), action: 'addTracks'}), /could not be verified/);
  assert.equal(posts, 1);
});

test('committed preference retry refreshes native revision before the next order write', async () => {
  let writes = 0, reads = 0, original; const revisions = [], accepted = [];
  const f = fixture((path, request) => {
    if (path.includes('/playlist-preferences/operations/')) return ++reads === 1 ? {status: 'unknown'} : {status: 'committed', receipt: original};
    if (request.method === 'PUT') {
      writes++; revisions.push(request.body.revision);
      const receipt = {ok: true, action: 'playlist_preferences', changed: true, request_key: request.body.request_key,
        preferences: {remember_order_mode: true, last_order_mode: request.body.last_order_mode,
          effective_order_mode: request.body.last_order_mode, revision: String(writes + 1)}};
      if (writes === 1) {original = receipt; throw new TypeError('Response lost after commit');}
      return receipt;
    }
  });
  f.runtime.acceptPlaylistPreferences = value => accepted.push(value.preferences);
  await assert.rejects(f.providers.savePlaylistPreferences({...options, revision: '1', last_order_mode: 'shuffle'}));
  await f.providers.retryPlaylistOperation({...options, action: 'playlist_preferences'});
  assert.equal(writes, 1); assert.equal(accepted.at(-1).revision, '2');
  await f.providers.savePlaylistPreferences({...options, revision: accepted.at(-1).revision, last_order_mode: 'regular'});
  assert.deepEqual(revisions, ['1', '2']); assert.equal(accepted.at(-1).revision, '3');
});

test('Missing Reload revalidates one retained capture and preserves removals, accepted matches and empty authorship', async () => {
  const {createPlaylistCreationController} = await import('../../../music_app/static/js/playlists/creation.mjs');
  const {createMissingPlaylistDraftController} = await import('../../../music_app/static/js/playlists/draft.mjs');
  const missingSource = {kind: 'playlist', ref: id(9), revision: '3', allowed_actions: header.allowed_actions};
  let captures = 0, accepted = false;
  const f = fixture((path) => {
    if (!path.includes('/missing-source?')) return;
    const params = new URL(path, 'https://fixture.invalid').searchParams;
    if (!params.has('capture_ref')) captures++;
    else assert.equal(params.get('capture_ref'), id(90));
    return {status: 'ready', data: {...header, source: missingSource, capture_ref: id(90), mode: 'missing',
      source_protocol: 'missing_playlist_selection_v1', entries_complete: true, entries: [1, 2].map(value => ({
        entry_ref: id(value + 20), title: `Original ${value}`, availability: accepted && value === 2 ? 'local' : 'missing',
        ...(accepted && value === 2 ? {match_state: 'accepted'} : {}),
        allowed_actions: {can_read: true, can_select: true}, parent_album: {state: 'unknown'}}))}};
  });
  const picker = createPlaylistCreationController({providers: f.providers});
  picker.setContext({...options, mode: 'missing', source: missingSource, canCreate: true});
  assert.equal(await picker.load(), true); picker.edit({title: 'Retained', description: ''});
  const packet = picker.prepareDraft(), draft = createMissingPlaylistDraftController({prepared: packet, providers: f.providers});
  const rows = draft.getSnapshot().entries; draft.remove(rows[0].row_key); accepted = true;
  assert.equal(await draft.refresh(), true); assert.equal(captures, 1);
  assert.deepEqual(draft.getSnapshot().entries.map(row => row.entry_ref), [id(22)]);
  assert.equal(draft.getSnapshot().entries[0].availability, 'local'); assert.doesNotMatch(draft.exportText(), /Original 2/);
  draft.remove(draft.getSnapshot().entries[0].row_key); assert.equal(await draft.refresh(), true);
  assert.equal(draft.getSnapshot().entries.length, 0); assert.equal(captures, 1);
  assert.doesNotMatch(JSON.stringify(draft.getSnapshot()), /capture_ref/);
});
