const test = require('node:test');
const assert = require('node:assert/strict');
let creation, draft, adapters;
test.before(async () => {
  creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  draft = await import('../../../music_app/static/js/playlists/draft.mjs');
  adapters = await import('../../../music_app/static/js/playlists/match-providers.mjs');
});
const source = {kind: 'playlist', ref: '11111111-1111-4111-8111-111111111111', revision: '1',
  allowed_actions: {can_read: true, can_use_for_playlist: true}};
const entryRef = '22222222-2222-4222-8222-222222222222';
const reviewRef = '33333333-3333-4333-8333-333333333333';
const candidateRef = '44444444-4444-4444-8444-444444444444';
const actor = {account_id: 7, library_id: 9};
const original = () => ({entry_ref: entryRef, title: '  Original (Live)  ', artist: 'Original Artist', album_title: 'Original Album',
  availability: 'missing', inventory_track_ref: null, duration_seconds: 42, metadata_state: 'last_known',
  allowed_actions: {can_read: true, can_select: true}, parent_album: {state: 'known', album_ref: 'original-parent',
    title: 'Original Album', artist: 'Original Artist', completeness: 'incomplete', allowed_actions: {can_read: true, can_view_details: true}}});
const candidate = () => ({candidate_ref: candidateRef, inventory_track_ref: 'inventory-track:9:23',
  title: 'Suggested', artist: 'Suggested Artist', album_title: 'Suggested Album', duration_seconds: 43});
const candidates = () => ({status: 'ready', data: {source, entry_ref: entryRef, review_ref: reviewRef,
  candidates: [candidate()], actor_scope: actor, suggestion_scope: 'bounded_local_inventory', suggestions_complete: true}});
const accepted = () => ({status: 'ready', data: {source, entry_ref: entryRef, entry: {...original(),
  availability: 'local', match_state: 'accepted', inventory_track_ref: candidate().inventory_track_ref}, actor_scope: actor}});
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
function providerSetup(request = async path => path.endsWith('accept-match') ? accepted() : candidates()) {
  let context = 'transport-context', listener, activeScope = 'actor-scope'; const calls = [];
  const transport = {context: () => context, subscribe: fn => {listener = fn; return () => {};},
    async request(path, options) {calls.push({path, options}); return request(path, options);}};
  const runtime = {acceptsPrivateScope: scope => scope === activeScope};
  return {providers: adapters.createPlaylistMatchProviders({transport, runtime}), calls,
    options: {scopeKey: activeScope, source, entry_ref: entryRef}, invalidate() {context = 'new-context'; listener();}, leave() {activeScope = 'other';}};
}
async function draftSetup(extra = {}) {
  const options = {scopeKey: 'actor-scope', mode: 'missing', canCreate: true, source};
  const data = {...options, entries_complete: true, source_protocol: 'missing_playlist_selection_v1',
    allowed_actions: source.allowed_actions, entries: [original()]};
  const form = creation.createPlaylistCreationController({providers: {readPlaylistCreationSource: async () => ({status: 'ready', data})}});
  form.setContext(options); await form.load(); form.edit({title: 'My missing tracks'});
  const real = providerSetup();
  const controller = draft.createMissingPlaylistDraftController({prepared: form.prepareDraft(), providers: {
    ...real.providers, createPlaylistFromSelection: async request => ({status: 'ready', data: {scopeKey: request.scopeKey,
      request_key: request.request_key, playlist_id: 'new-playlist', revision: '2'}}), ...extra}});
  return {controller, ...real};
}
test('match adapter keeps candidate, actor, and inventory authority private and accepts only the reviewed choice', async () => {
  const {providers, options, calls} = providerSetup();
  const result = await providers.readPlaylistMatchCandidates(options);
  assert.equal(result.status, 'ready'); assert.equal(result.data.candidates.length, 1);
  for (const secret of [reviewRef, candidateRef, 'inventory-track', 'actor_scope', 'context_ref']) assert.equal(JSON.stringify(result).includes(secret), false);
  await assert.rejects(providers.acceptPlaylistMatch({...options, candidate_key: 'fabricated'}));
  const ack = await providers.acceptPlaylistMatch({...options, candidate_key: result.data.candidates[0].key});
  assert.equal(ack.data.entry.title, original().title);
  assert.equal(ack.data.entry.availability, 'local'); assert.equal(ack.data.entry.match_state, 'accepted');
  assert.equal(JSON.stringify(ack).includes('inventory-track'), false);
  assert.deepEqual(calls[1].options.body, {source: {kind: 'playlist', ref: source.ref, revision: '1'}, entry_ref: entryRef,
    review_ref: reviewRef, candidate_ref: candidateRef});
  assert.equal(calls[1].options.expected, 'transport-context');
});
test('match adapter rejects stale scopes, transport generations, and mismatched accepted inventory', async () => {
  const waiting = deferred(), value = providerSetup(() => waiting.promise);
  const pending = value.providers.readPlaylistMatchCandidates(value.options); value.invalidate(); waiting.resolve(candidates());
  await assert.rejects(pending);
  const wrong = providerSetup(async path => path.endsWith('accept-match')
    ? {...accepted(), data: {...accepted().data, entry: {...accepted().data.entry, inventory_track_ref: 'inventory-track:9:24'}}} : candidates());
  const review = await wrong.providers.readPlaylistMatchCandidates(wrong.options);
  await assert.rejects(wrong.providers.acceptPlaylistMatch({...wrong.options, candidate_key: review.data.candidates[0].key}));
  wrong.leave(); await assert.rejects(wrong.providers.readPlaylistMatchCandidates(wrong.options));
});
test('explicit acceptance retains byte-preserved original row, excludes it from TXT, and saves original occurrence', async () => {
  const {controller} = await draftSetup(); const before = controller.getSnapshot().entries[0];
  assert.equal(controller.localMatch.open(before.row_key), true); await controller.localMatch.load();
  const match = controller.localMatch.getSnapshot();
  assert.equal(await controller.localMatch.accept(), false);
  assert.equal(controller.localMatch.select(match.candidates[0].key), true);
  assert.equal(await controller.localMatch.accept(), true);
  const after = controller.getSnapshot().entries[0];
  assert.equal(after.title, before.title); assert.equal(after.artist, before.artist); assert.equal(after.album_title, before.album_title);
  assert.equal(after.row_key, before.row_key); assert.equal(after.match_state, 'accepted');
  assert.equal(draft.projectMissingPlaylistDraft(controller.getSnapshot()).authoredEntries.length, 1);
  assert.equal(controller.exportText(), ''); assert.equal(controller.canSave(), true);
  const state = controller.getSnapshot();
  assert.equal(creation.buildCreationRequest(state.sourceResource.data, {context: state, title: state.title, description: state.description,
    selectedKeys: [after.row_key], request_key: 'initial-form'}), null);
});
test('late acceptance cannot resurrect removed rows and repeated acceptance writes once', async () => {
  const waiting = deferred(); let writes = 0;
  const {controller} = await draftSetup({acceptPlaylistMatch: async () => {writes++; return waiting.promise;}});
  controller.localMatch.open(controller.getSnapshot().entries[0].row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key);
  const accepting = controller.localMatch.accept(); assert.equal(await controller.localMatch.accept(), false);
  controller.remove(controller.getSnapshot().entries[0].row_key);
  waiting.resolve({status: 'ready', data: {scopeKey: 'actor-scope', source, entry_ref: entryRef, entry: {...original(), availability: 'local', match_state: 'accepted'}}});
  assert.equal(await accepting, false); assert.equal(writes, 1); assert.equal(controller.getSnapshot().entries.length, 0);
});

test('lost acceptance response retains the exact reviewed choice, blocks Save, and explicitly retries once', async () => {
  let attempt = 0; const bodies = [];
  const real = providerSetup(async (path, options) => {
    if (!path.endsWith('accept-match')) return candidates();
    bodies.push(options.body); if (++attempt === 1) throw new Error('lost response');
    return accepted();
  });
  const {controller} = await draftSetup(real.providers);
  controller.localMatch.open(controller.getSnapshot().entries[0].row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key);
  assert.equal(await controller.localMatch.accept(), false);
  assert.equal(controller.localMatch.getSnapshot().status, 'uncertain'); assert.equal(controller.canSave(), false);
  assert.equal(await controller.localMatch.load(), false);
  assert.equal(controller.localMatch.select(controller.localMatch.getSnapshot().selectedKey), false);
  assert.equal(await controller.localMatch.accept(), true); assert.equal(controller.canSave(), true);
  assert.deepEqual(bodies[1], bodies[0]); assert.equal(bodies.length, 2);
});
test('permission rejection erases stale source facts and never enables implicit acceptance', async () => {
  const {controller} = await draftSetup({acceptPlaylistMatch: async () => {throw Object.assign(new Error('denied'), {status: 403, responseRejected: true});}});
  controller.localMatch.open(controller.getSnapshot().entries[0].row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key);
  assert.equal(await controller.localMatch.accept(), false); assert.equal(controller.localMatch.getSnapshot().status, 'closed');
  assert.equal(await controller.localMatch.accept(), false); assert.deepEqual(controller.getSnapshot().entries, []);
  assert.equal(controller.getSnapshot().sourceResource.status, 'denied'); assert.equal(controller.exportText(), '');
});
test('candidate reads cannot complete after dismissal, source replacement, row removal or provider replacement', async () => {
  for (const interrupt of [c => c.localMatch.close(), c => c.remove(c.getSnapshot().entries[0].row_key),
    c => c.setContext({...c.getSnapshot(), source: {...source, revision: '2'}}), c => c.configure({})]) {
    const waiting = deferred(); let options;
    const {controller} = await draftSetup({readPlaylistMatchCandidates: request => {options = request; return waiting.promise;}});
    controller.localMatch.open(controller.getSnapshot().entries[0].row_key);
    const loading = controller.localMatch.load(); interrupt(controller);
    waiting.resolve({status: 'ready', data: {...options, candidates: [{key: 'safe', ...candidate()}], suggestions_complete: true}});
    assert.equal(await loading, false); assert.equal(controller.localMatch.getSnapshot().status, 'closed');
    assert.equal(controller.localMatch.getSnapshot().candidates.length, 0);
  }
});
test('adapter rejects malformed, duplicate, cross-library and over-bound candidate sets without leaking them', async () => {
  for (const rows of [[{...candidate(), inventory_track_ref: '/private/path'}], [{...candidate(), inventory_track_ref: 'inventory-track:8:23'}],
    [candidate(), candidate()], Array(9).fill(candidate()), [{...candidate(), duration_seconds: -1}], [{...candidate(), title: null}]]) {
    const fixture = providerSetup(async () => ({...candidates(), data: {...candidates().data, candidates: rows}}));
    await assert.rejects(fixture.providers.readPlaylistMatchCandidates(fixture.options));
  }
});
test('actor mismatch and superseded candidate review cannot authorize an acceptance', async () => {
  const fixture = providerSetup(async path => path.endsWith('accept-match')
    ? {...accepted(), data: {...accepted().data, actor_scope: {...actor, account_id: 8}}} : candidates());
  const first = await fixture.providers.readPlaylistMatchCandidates(fixture.options);
  const second = await fixture.providers.readPlaylistMatchCandidates(fixture.options);
  await assert.rejects(fixture.providers.acceptPlaylistMatch({...fixture.options, candidate_key: first.data.candidates[0].key}));
  await assert.rejects(fixture.providers.acceptPlaylistMatch({...fixture.options, candidate_key: second.data.candidates[0].key}));
});
test('acceptance with changed source metadata hides stale facts and requires refresh while preserving authored text', async () => {
  const fixture = providerSetup(async path => path.endsWith('accept-match')
    ? {...accepted(), data: {...accepted().data, entry: {...accepted().data.entry, title: 'Substituted candidate title'}}} : candidates());
  const {controller} = await draftSetup(fixture.providers), before = controller.getSnapshot().entries[0];
  controller.localMatch.open(before.row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key);
  assert.equal(await controller.localMatch.accept(), false); assert.deepEqual(controller.getSnapshot().entries, []);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.getSnapshot().title, 'My missing tracks');
  assert.equal(controller.localMatch.getSnapshot().status, 'closed'); assert.equal(controller.canSave(), false);
});
test('matched Save retains the original source protocol and occurrence, with no authority-bearing extra fields', async () => {
  let received;
  const {controller} = await draftSetup({createPlaylistFromSelection: async request => {
    received = request; return {status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key, playlist_id: 'saved', revision: '2'}};
  }});
  controller.localMatch.open(controller.getSnapshot().entries[0].row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key); await controller.localMatch.accept();
  assert.ok(await controller.save()); assert.deepEqual(received.entry_refs, [entryRef]);
  assert.equal(received.source_protocol, 'missing_playlist_selection_v1');
  for (const forbidden of ['inventory-track', 'candidate_ref', 'match_state', 'review_ref', 'draftToken']) assert.equal(JSON.stringify(received).includes(forbidden), false);
});

test('newly redacted parent authority clears stale parent information instead of trapping match retry', async () => {
  const fixture = providerSetup(async path => path.endsWith('accept-match')
    ? {...accepted(), data: {...accepted().data, entry: {...accepted().data.entry, parent_album: {state: 'unknown', allowed_actions: {can_read: false}}}}} : candidates());
  const {controller} = await draftSetup(fixture.providers);
  controller.localMatch.open(controller.getSnapshot().entries[0].row_key); await controller.localMatch.load();
  controller.localMatch.select(controller.localMatch.getSnapshot().candidates[0].key);
  assert.equal(await controller.localMatch.accept(), false);
  assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
  assert.equal(controller.localMatch.getSnapshot().status, 'closed');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('original-parent'), false);
  assert.equal(controller.getSnapshot().title, 'My missing tracks');
});

test('malformed source revisions never leave the adapter', async () => {
  const fixture = providerSetup();
  for (const revision of [1, '', '0', '01', 'revision:one']) {
    await assert.rejects(fixture.providers.readPlaylistMatchCandidates({...fixture.options, source: {...source, revision}}));
  }
  assert.equal(fixture.calls.length, 0);
});
