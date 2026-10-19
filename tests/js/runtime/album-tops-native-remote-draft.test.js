const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
let createAlbumTopDraft;
test.before(async () => {({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));});
const CONTEXT = 'a'.repeat(64), VERSION = 'b'.repeat(64), PARENT = F.id(51), ACQUISITION = F.id(61), RG = F.id(71), ADMISSION = F.id(81);
const summary = (ref = RG) => ({source_kind: 'remote_summary', provider: 'musicbrainz', entity_kind: 'release-group', release_group_id: ref,
  title: 'Remote album', artist_display: 'Remote artist', first_release_date: '2003-02', primary_type: 'Album',
  metadata_coverage: 'album_summary_only', track_metadata_status: 'unavailable', track_count: null});
function mixed({manageOnly = false, published = false} = {}) {
  const data = F.detail();
  data.items[1] = {...data.items[1], ...summary(), artist: 'Remote artist', year: 2003};
  data.edit_draft = {publication_preview_required: published, item_selections: [
    {kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'local', selected_local_album_id: 11, selected_source_ref: F.SOURCE}},
    {kind: 'existing', item_ref: F.IB, album_ref: F.B, source: {kind: 'remote_retained', admission_ref: ADMISSION, evidence_version: VERSION}},
  ]};
  if (manageOnly) {data.allowed_actions[F.ITEMS] = false; for (const key of ['can_add', 'can_remove', 'can_reorder']) data.allowed_actions[key] = false;}
  return F.state({editing: true, data});
}
function setup(t, {initial = F.state(), mode = 'edit', ...overrides} = {}) {
  const c = F.controllerFixture(initial), local = F.providerFixture();
  const calls = [], identity = Object.freeze({context: CONTEXT, generation: 1}); let live = identity;
  const parent = payload => ({version: 2, context_ref: CONTEXT, destination: payload.destination, preparation_ref: PARENT, form_ref: payload.form_ref,
    state: 'ready', created_at: new Date().toISOString(), accepts_until: new Date(Date.now() + 1800000).toISOString(), fully_expires_at: new Date(Date.now() + 3600000).toISOString()});
  const pending = payload => ({version: 2, context_ref: CONTEXT, destination: payload.destination, preparation_ref: payload.preparation_ref,
    request_key: payload.request_key, state: 'pending', acquisition_ref: ACQUISITION, evidence_version: VERSION,
    expires_at: new Date(Date.now() + 1800000).toISOString(), album: summary(payload.release_group_id)});
  const defaults = {
    search: payload => ({context_ref: CONTEXT, destination: payload.destination, limit: 10, candidates: [summary()]}), begin: parent, acquire: pending,
    status: () => ({version: 2, context_ref: CONTEXT, state: 'status', parents: [], capacity: {worst_case_new_acquisitions: 0}, maintenance_required: false}),
    maintain: () => ({version: 2, context_ref: CONTEXT, state: 'progress', branch: 'legacy_initialization', inspected: 1024, more_work: true, capacity: {counts_complete: false}}),
    close: ref => ({version: 2, context_ref: CONTEXT, state: 'closed', preparation_ref: ref}),
  };
  const call = async (kind, payload, options) => {calls.push({kind, payload: payload === undefined ? undefined : F.clone(payload), options}); return (overrides[kind] || defaults[kind])(payload, options, {parent, pending});};
  const providers = {...local.providers, remoteContext: () => live,
    searchRemoteAlbums: (payload, options) => call('search', payload, options), beginRemotePreparation: (payload, options) => call('begin', payload, options),
    acquireRemoteAlbum: (payload, options) => call('acquire', payload, options), readRemotePreparationState: options => call('status', undefined, options),
    maintainRemotePreparations: (payload, options) => call('maintain', payload, options), closeRemotePreparation: (ref, options) => call('close', ref, options)};
  const draft = createAlbumTopDraft({controller: c.controller, providers, mode}); t.after(() => draft.dispose());
  return {...c, mutations: c.calls, calls, localCalls: local.calls, providers, draft, initial, identity, setIdentity(value) {live = value;}, parent, pending};
}
async function search(env) {assert.equal(env.draft.setRemoteTitle('Remote album'), true); await env.draft.searchRemote(); return env.draft.getSnapshot().remote.search.candidates[0];}
async function select(env) {const row = await search(env); return env.draft.selectRemote(row);}
const rejection = (status = 409, code = 'remote_preparation_unavailable', responseRejected = true) => Object.assign(new Error(code), {status, code, responseRejected});

test('ordinary local Create keeps its original payload and performs no remote call', async t => {
  const e = setup(t); e.draft.edit({title: 'Local'}); await e.draft.setQuery('Album'); await e.draft.select(F.album()); await e.draft.submit();
  assert.deepEqual(e.mutations, [{action: 'create', payload: {title: 'Local', description: '', album_refs: [F.A]}}]); assert.deepEqual(e.calls, []);
});
test('typing remote title and optional artist is inert until explicit search', async t => {
  const e = setup(t); assert.equal(e.draft.setPool('remote'), true); e.draft.setRemoteTitle('  Remote album  '); e.draft.setRemoteArtist(' Artist ');
  assert.equal(e.calls.length, 0); await e.draft.searchRemote();
  assert.equal(e.calls.length, 1); assert.equal(e.calls[0].kind, 'search');
  assert.deepEqual(e.calls[0].payload, {destination: {kind: 'create', draft_ref: e.draft.getSnapshot().formRef}, title: 'Remote album', artist: 'Artist'});
  assert.equal(e.calls[0].options.remoteContext, e.identity); assert.equal(e.calls[0].options.isCurrent(), true);
  assert.equal(e.draft.getSnapshot().remote.search.candidates[0].track_count, null); assert.equal(e.mutations.length, 0);
});
test('blank, oversized or control-character remote search cannot dispatch', async t => {
  const e = setup(t); await e.draft.searchRemote(); e.draft.setRemoteTitle('  '); await e.draft.searchRemote();
  assert.equal(e.draft.setRemoteTitle('x'.repeat(101)), false); assert.equal(e.draft.setRemoteArtist('a\n'), false); assert.equal(e.calls.length, 0);
});
test('explicit acquisition binds one form and creates no invented catalog or member identity', async t => {
  const e = setup(t); await select(e); const rows = e.draft.getSnapshot().items, calls = e.calls;
  assert.deepEqual(calls.map(row => row.kind), ['search', 'begin', 'acquire']);
  assert.deepEqual(calls[1].payload, {destination: calls[0].payload.destination, form_ref: calls[0].payload.destination.draft_ref});
  assert.equal(calls[2].payload.version, 2); assert.equal(calls[2].payload.preparation_ref, PARENT); assert.equal(calls[2].payload.release_group_id, RG);
  assert.equal(rows.length, 1); assert.equal(rows[0].album_ref, undefined); assert.equal(rows[0].item_ref, null); assert.equal(rows[0].selection_key, 'remote:' + ACQUISITION);
  assert.deepEqual(rows[0].source, {kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: VERSION}); assert.equal(e.mutations.length, 0);
});
test('mixed Create hands typed selections and exact draft reference to the existing mutation owner', async t => {
  const e = setup(t); e.draft.edit({title: 'Mixed'}); await e.draft.setQuery('Album'); await e.draft.select(F.album()); await select(e); await e.draft.submit();
  assert.deepEqual(e.mutations, [{action: 'create', payload: {title: 'Mixed', description: '', draft_ref: e.draft.getSnapshot().formRef,
    selections: [{kind: 'local_catalog', album_ref: F.A}, {kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: VERSION}]}}]);
  assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 1);
});
test('Add uses captured Top/revision destination and typed selections without metadata writes', async t => {
  const e = setup(t, {initial: F.state({editing: true}), mode: 'add'}); await select(e); await e.draft.submit();
  assert.deepEqual(e.calls[0].payload.destination, {kind: 'top', top_ref: F.TOP, revision: '7'});
  assert.deepEqual(e.mutations, [{action: 'add', payload: {selections: [{kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: VERSION}]}}]);
});
test('genuine Manage-only mixed Top permits metadata Save with membership omitted', async t => {
  const e = setup(t, {initial: mixed({manageOnly: true})}); const before = F.clone(e.initial.detail.data);
  assert.equal(e.draft.canEdit(), true); assert.equal(e.draft.canEditMembership(), false); assert.equal(e.draft.edit({title: 'Metadata only', description: 'Updated'}), true);
  assert.equal(e.draft.remove(F.B), false); assert.equal(e.draft.reorder([F.B, F.A]), false); assert.equal(e.draft.setPool('remote'), false);
  assert.equal(e.draft.setRemoteTitle('No provider'), false); await e.draft.searchRemote(); await e.draft.selectRemote(summary()); await e.draft.submit();
  assert.deepEqual(e.mutations, [{action: 'save', payload: {title: 'Metadata only', description: 'Updated'}}]); assert.deepEqual(e.calls, []); assert.deepEqual(e.initial.detail.data, before);
});
test('mixed Save preserves exact retained sources and curator order', async t => {
  const e = setup(t, {initial: mixed()}); assert.equal(e.draft.reorder([F.B, F.A]), true); await e.draft.submit();
  assert.deepEqual(e.mutations[0], {action: 'save', payload: {title: 'Curated Top', description: 'Subtitle', item_selections: [
    {kind: 'existing', item_ref: F.IB, album_ref: F.B, source: {kind: 'remote_retained', admission_ref: ADMISSION, evidence_version: VERSION}},
    {kind: 'existing', item_ref: F.IA, album_ref: F.A, source: {kind: 'local', selected_local_album_id: 11, selected_source_ref: F.SOURCE}},
  ]}}); assert.equal(e.calls.length, 0);
});
test('removing all remote members restores the original local Save representation', async t => {
  const e = setup(t, {initial: mixed()}); e.draft.remove(F.B); await e.draft.submit();
  assert.deepEqual(e.mutations[0].payload.items, [{item_ref: F.IA, album_ref: F.A, selected_local_album_id: 11, selected_source_ref: F.SOURCE}]);
  assert.equal(Object.hasOwn(e.mutations[0].payload, 'item_selections'), false); assert.equal(e.calls.length, 0);
});
test('enabled-link mixed metadata Save refuses before mutation and preserves the saved observation', async t => {
  const initial = mixed({published: true}); initial.publication = {status: 'ready', data: {url: 'https://example.test/shared', state: 'enabled'}};
  const e = setup(t, {initial}); e.draft.edit({title: 'Keep draft'}); const observed = initial.publication;
  assert.equal(await e.draft.submit(), false); assert.equal(e.draft.getSnapshot().error.code, 'remote_publication_unavailable');
  assert.equal(e.draft.getSnapshot().title, 'Keep draft'); assert.equal(initial.publication, observed); assert.equal(e.mutations.length, 0); assert.equal(e.localCalls.preview.length, 0);
});
test('expired pending evidence cannot be submitted but can be explicitly removed', async t => {
  const e = setup(t, {acquire: (body, _, helpers) => ({...helpers.pending(body), expires_at: '2000-01-01T00:00:00Z'})}); e.draft.edit({title: 'Expired'}); await select(e);
  await e.draft.submit(); assert.equal(e.mutations.length, 0); assert.equal(e.draft.getSnapshot().error.code, 'remote_acquisition_expired');
  e.draft.remove('remote:' + ACQUISITION); await e.draft.submit(); assert.deepEqual(e.mutations[0].payload.album_refs, []);
});
test('unknown begin retries its original form before dispatching exactly one acquisition', async t => {
  let n = 0; const e = setup(t, {begin: (body, _, h) => {if (++n === 1) throw new TypeError('lost begin'); return h.parent(body);}}); await select(e);
  assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); assert.equal(e.draft.edit({title: 'Blocked'}), false); assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 0);
  await e.draft.retryRemoteAcquisition(); const calls = e.calls.filter(row => row.kind === 'begin'); assert.deepEqual(calls[0].payload, calls[1].payload);
  assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 1); assert.equal(e.draft.getSnapshot().items.length, 1);
});
test('unknown acquisition preserves exact request body and key on manual retry', async t => {
  let n = 0; const e = setup(t, {acquire: (body, _, h) => {if (++n === 1) throw new TypeError('lost acquire'); return h.pending(body);}}); await select(e);
  assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); await e.draft.retryRemoteAcquisition(); const calls = e.calls.filter(row => row.kind === 'acquire');
  assert.deepEqual(calls[0].payload, calls[1].payload); assert.equal(e.calls.filter(row => row.kind === 'begin').length, 1); assert.equal(e.draft.getSnapshot().items.length, 1);
});
test('in-flight response waits for explicit retry, with no poll or new acquisition key', async t => {
  let n = 0; const e = setup(t, {acquire: (body, _, h) => ++n === 1 ? {...body, context_ref: CONTEXT, state: 'in_flight', retry_after_seconds: 1} : h.pending(body)}); await select(e);
  await Promise.resolve(); await Promise.resolve(); assert.equal(n, 1); assert.equal(e.draft.canEdit(), false); assert.equal(e.draft.getSnapshot().remote.status, 'in_flight');
  await e.draft.retryRemoteAcquisition(); assert.equal(n, 2); assert.deepEqual(e.calls.filter(row => row.kind === 'acquire').map(row => row.payload.request_key), [e.calls[2].payload.request_key, e.calls[2].payload.request_key]);
});
test('failed and consumed acquisition details never become membership acknowledgments', async t => {
  for (const state of ['failed', 'consumed']) {
    const e = setup(t, {acquire: body => ({...body, context_ref: CONTEXT, state, error: 'provider_unavailable', consumed_top_ref: F.TOP, consumed_revision: '8', operation_request_key: F.id(99)})});
    await select(e); assert.equal(e.draft.getSnapshot().remote.status, state); assert.equal(e.draft.getSnapshot().items.length, 0); assert.equal(e.mutations.length, 0); assert.equal(e.controller.getSnapshot().mutation.status, 'idle');
  }
});
test('capacity and maintenance progress remain explicit bounded operations', async t => {
  const e = setup(t, {begin: () => ({state: 'maintenance_required', resource: 'legacy_initialization', error: 'remote_preparation_maintenance_required', capacity: {counts_complete: false, worst_case_new_acquisitions: 0}})});
  await select(e); assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 0); assert.equal(e.draft.getSnapshot().remote.result.capacity.worst_case_new_acquisitions, 0);
  await e.draft.maintainRemotePreparations(); await Promise.resolve(); assert.equal(e.calls.filter(row => row.kind === 'maintain').length, 1);
  assert.equal(e.draft.getSnapshot().remote.maintenance.more_work, true); assert.equal(e.calls.filter(row => row.kind === 'begin').length, 1);
});
test('opaque other-parent close and legacy discard each require explicit confirmation', async t => {
  const other = F.id(52), e = setup(t, {status: () => ({state: 'status', parents: [{preparation_ref: other}], maintenance_required: false})});
  await e.draft.readRemotePreparationState(); await e.draft.closeRemotePreparation(other); assert.equal(e.calls.filter(row => row.kind === 'close').length, 0);
  await e.draft.closeRemotePreparation(other, {confirmed: true}); assert.equal(e.calls.filter(row => row.kind === 'close').length, 1);
  await e.draft.maintainRemotePreparations({discardLegacy: true}); assert.equal(e.calls.filter(row => row.kind === 'maintain').length, 0);
  await e.draft.maintainRemotePreparations({discardLegacy: true, confirmed: true}); assert.deepEqual(e.calls.at(-1).payload, {mode: 'discard_legacy'});
});
test('natural form disposal never issues cleanup or membership I/O', async t => {
  const e = setup(t); await select(e); const before = e.calls.length; e.draft.dispose(); assert.equal(e.calls.length, before); assert.equal(e.mutations.length, 0);
});
