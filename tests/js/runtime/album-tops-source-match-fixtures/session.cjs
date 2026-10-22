'use strict';
const assert = require('node:assert/strict');
const F = require('../album-tops-native-remote-fixtures/picker-fixtures.cjs');
const JOB = 'a7191ce0-2ef6-41c5-8fb5-926fc9a3d12c', OTHER_JOB = 'c1e40f9d-4249-4d42-bc3c-cf9ae98741a8';
const REQUEST = F.id(931), SAVED_TOP = F.id(932), TIME = '2026-10-19T12:00:00Z';
const SOURCE = {request_key: REQUEST, title: 'Review source', description: 'Preserve every original row', kind: 'pasted_html',
  filename: null, content: '<script>inertEvidence()</script>\n3. Third source\n2. Second source\n1. First source'};
const sourceRow = (ref, rank) => ({row_ref: ref, candidate_line: Number(ref) + 1, raw_text: `${rank}. <b>Original source ${ref}</b>`,
  explicit_rank: rank, catalog_ref: null, match_state: 'unresolved'});
const review = () => ({parser_version: 2, state: 'review_required', rows: [sourceRow('1', 3), sourceRow('2', 2), sourceRow('3', 1)],
  ordered_row_refs: ['3', '2', '1'], issues: ['Original private parser observation']});
const job = (patch = {}) => ({job_ref: JOB, request_key: REQUEST, status: 'completed', revision: '4', title: SOURCE.title,
  kind: SOURCE.kind, created_at: TIME, updated_at: TIME, phase: 'review_evidence', error: null, top_ref: null,
  source: F.clone(SOURCE), review: review(), ...patch});
const local = album_ref => ({kind: 'local_catalog', album_ref});
const remote = () => ({kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION});
function receipt(command) {
  const first = new Map(), ranks = new Map(review().rows.map(row => [row.row_ref, row.explicit_rank]));
  return {action: 'create', request_key: command.request_key, top_ref: SAVED_TOP, revision: '1',
    source_job_ref: command.source_review.job_ref, source_locked: true, source_derived: true,
    source_report: command.source_review.rows.map((row, index) => {
      const canonical = row.selection === null ? null : row.selection.kind === 'local_catalog' ? row.selection.album_ref : F.C;
      const retained = canonical && first.get(canonical);
      if (canonical && !retained) first.set(canonical, row.row_ref);
      return {row_ref: row.row_ref, position: index + 1, original_explicit_rank: ranks.get(row.row_ref),
        catalog_ref: canonical, outcome: canonical === null ? 'unresolved' : retained ? 'duplicate' : 'matched', retained_row_ref: retained || null};
    })};
}
let createAlbumTopController, createSourceImportController, createSourceImportProviders, createSourceImportMatchSession, mountAlbumPicker;
async function load() {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: require('node:crypto').webcrypto, configurable: true});
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
  ({createSourceImportController} = await F.load('album-tops/source-import-controller.mjs'));
  ({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));
  ({createSourceImportMatchSession} = await F.load('album-tops/source-import-match-session.mjs'));
  ({mountAlbumPicker} = await F.load('album-tops/builder.mjs'));
}
async function fixture(t, {wire = job(), opened = true, handlers = {}, directoryReady = true} = {}) {
  const api = F.service({handlers}), transport = [], controls = new Map(), sessions = [], calls = [];
  const subscriptions = {topStarted: 0, topLive: 0, importStarted: 0, importLive: 0}, live = {current: true};
  const sourceProviders = createSourceImportProviders({request: async (path, options, body) => {
    transport.push({path, options, body: body === undefined ? undefined : F.clone(body)});
    const method = path === '/album-tops' ? 'finalize' : path.endsWith('/cancel') ? 'cancel'
      : path.endsWith('/process') ? 'process' : 'read';
    const queue = controls.get(method) || [];
    if (queue.length) {const reply = queue.shift(); return typeof reply === 'function' ? reply(path, options, body) : reply;}
    assert.equal(method, 'read', `unexpected implicit source ${method}`); return F.clone(wire);
  }});
  const providers = {...api.providers, ...sourceProviders};
  const topController = createAlbumTopController({providers, requestKey: () => F.id(933)});
  const topSubscribe = topController.subscribe, topMutate = topController.mutate;
  topController.subscribe = listener => {
    subscriptions.topStarted++; subscriptions.topLive++; const off = topSubscribe(listener); let active = true;
    return () => {if (active) {active = false; subscriptions.topLive--; off();}};
  };
  topController.mutate = (...args) => {calls.push({method: 'mutate', args: F.clone(args)}); return topMutate(...args);};
  topController.setScope(F.SCOPE); if (directoryReady) assert.equal(await topController.load(), true);
  const actualImport = createSourceImportController({providers, scopeKey: F.SCOPE,
    isCurrent: () => live.current && topController.getSnapshot().scopeKey === F.SCOPE, key: () => REQUEST});
  // Observation delegates every call to the frozen real import owner. No grant,
  // snapshot, selector, acknowledgment or persistence behavior is substituted.
  const importController = Object.freeze({...actualImport,
    subscribe(listener) {
      subscriptions.importStarted++; subscriptions.importLive++; const off = actualImport.subscribe(listener); let active = true;
      return () => {if (active) {active = false; subscriptions.importLive--; off();}};
    },
    select(...args) {calls.push({method: 'select', args: F.clone(args)}); return actualImport.select(...args);},
    finalize(...args) {calls.push({method: 'finalize', args}); return actualImport.finalize(...args);},
  });
  t.after(() => {
    for (const session of sessions.reverse()) session.dispose();
    assert.equal(subscriptions.topLive, 0); assert.equal(subscriptions.importLive, 0);
    actualImport.dispose(); topController.dispose();
  });
  if (opened) assert.equal(await actualImport.open(wire.job_ref), true);
  const options = extra => ({topController, providers, importController, rowRef: '2', ...extra});
  const construct = input => createSourceImportMatchSession(input);
  function create(extra = {}) {const session = construct(options(extra)); sessions.push(session); return session;}
  return {api, providers, topController, importController, actualImport, calls, transport, subscriptions, live, options, construct, create,
    own(session) {sessions.push(session); return session;},
    reply(method, value) {if (!controls.has(method)) controls.set(method, []); controls.get(method).push(value);}};
}
async function selectLocal(session) {
  assert.equal(await session.draft.setQuery('Found'), true);
  const [row] = session.draft.getSnapshot().search.items; assert.ok(row);
  assert.equal(await session.draft.select(row), true); return session.draft.getSnapshot().items[0];
}
async function remoteCandidate(session) {
  assert.equal(session.draft.setPool('remote'), true); assert.equal(session.draft.setRemoteTitle('Remote album'), true);
  assert.equal(await session.draft.searchRemote(), true); return session.draft.getSnapshot().remote.search.candidates[0];
}
async function selectRemote(session) {
  assert.equal(await session.draft.selectRemote(await remoteCandidate(session)), true); return session.draft.getSnapshot().items[0];
}
const selections = h => h.calls.filter(row => row.method === 'select');
function noImplicitSave(h) {
  assert.equal(h.calls.filter(row => ['mutate', 'finalize'].includes(row.method)).length, 0);
  assert.equal(h.transport.filter(row => row.path === '/album-tops').length, 0);
  assert.equal(h.api.count('execute'), 0); assert.equal(h.api.count('closeRemotePreparation'), 0);
  assert.equal(h.api.count('maintainRemotePreparations'), 0);
  assert.equal(h.topController.getSnapshot().selectedTopRef, null);
}
module.exports = {F, JOB, OTHER_JOB, REQUEST, SAVED_TOP, SOURCE, review, job, local, remote, receipt,
  load, fixture, selectLocal, remoteCandidate, selectRemote, selections, noImplicitSave,
  mount: (...args) => mountAlbumPicker(...args)};
