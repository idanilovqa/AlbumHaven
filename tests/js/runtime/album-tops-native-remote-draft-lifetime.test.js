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
  const calls = [], identity = Object.freeze({context: CONTEXT, generation: 1}); let live = identity, contextHook = null;
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
  const providers = {...local.providers, remoteContext: () => {contextHook?.(); return live;},
    searchRemoteAlbums: (payload, options) => call('search', payload, options), beginRemotePreparation: (payload, options) => call('begin', payload, options),
    acquireRemoteAlbum: (payload, options) => call('acquire', payload, options), readRemotePreparationState: options => call('status', undefined, options),
    maintainRemotePreparations: (payload, options) => call('maintain', payload, options), closeRemotePreparation: (ref, options) => call('close', ref, options)};
  const draft = createAlbumTopDraft({controller: c.controller, providers, mode}); t.after(() => draft.dispose());
  return {...c, mutations: c.calls, calls, localCalls: local.calls, providers, draft, initial, identity, setIdentity(value) {live = value;}, setContextHook(fn) {contextHook = fn;}, parent, pending};
}
async function search(env) {assert.equal(env.draft.setRemoteTitle('Remote album'), true); await env.draft.searchRemote(); return env.draft.getSnapshot().remote.search.candidates[0];}
async function select(env) {const row = await search(env); return env.draft.selectRemote(row);}
const rejection = (status = 409, code = 'remote_preparation_unavailable', responseRejected = true) => Object.assign(new Error(code), {status, code, responseRejected});

for (const change of ['scope', 'navigation', 'source-object', 'revision', 'context-ABA', 'provider-method', 'dispose']) {
  test(`remote form permanently retires after ${change}, including return to old values`, async t => {
    const gate = F.deferred(), e = setup(t, {initial: mixed(), search: () => gate.promise}); const before = e.controller.getSnapshot(), source = before.detail.data;
    e.draft.setRemoteTitle('New remote'); const pending = e.draft.searchRemote();
    if (change === 'scope') e.replace({...before, scopeKey: 'other'});
    if (change === 'navigation') e.replace({...before, selectedTopRef: F.OTHER});
    if (change === 'source-object') e.replace({...before, detail: {...before.detail, data: F.clone(source)}});
    if (change === 'revision') {source.revision = '8'; e.replace({...before});}
    if (change === 'context-ABA') {e.setIdentity({context: 'c'.repeat(64), generation: 2}); e.draft.refresh(); e.setIdentity({context: CONTEXT, generation: 3});}
    if (change === 'provider-method') {const original = e.providers.remoteContext; e.providers.remoteContext = () => e.identity; e.draft.refresh(); e.providers.remoteContext = original;}
    if (change === 'dispose') e.draft.dispose();
    e.draft.refresh(); source.revision = '7'; e.replace(before);
    gate.resolve({candidates: [summary()]}); await pending;
    assert.equal(e.draft.canEdit(), false); assert.equal(e.draft.canEditMembership(), false); assert.equal(e.draft.getSnapshot().remote.search.candidates.length, 0);
    assert.equal(e.calls.length, 1); assert.equal(e.calls[0].options.signal.aborted, true); assert.equal(e.mutations.length, 0);
  });
}
for (const status of [401, 403]) test(`consumed in-scope remote ${status} after a newer search starts still retires the form`, async t => {
  const first = F.deferred(), second = F.deferred(); let n = 0;
  const e = setup(t, {search: () => ++n === 1 ? first.promise : second.promise}); e.draft.setRemoteTitle('First'); const old = e.draft.searchRemote();
  e.draft.setRemoteTitle('Second'); const current = e.draft.searchRemote(); assert.equal(e.calls[0].options.signal.aborted, true);
  second.resolve({candidates: [summary(F.id(72))]}); await current; first.reject(rejection(status, 'forbidden')); await old;
  assert.equal(e.draft.getSnapshot().denied, true); assert.equal(e.controller.getSnapshot().directory.status, 'denied'); assert.equal(e.draft.getSnapshot().remote.search.candidates.length, 0);
});
for (const change of ['navigation', 'account', 'context']) test(`old consumed denial cannot poison replacement ${change}`, async t => {
  const gate = F.deferred(), e = setup(t, {search: () => gate.promise}); e.draft.setRemoteTitle('Old'); const waiting = e.draft.searchRemote();
  if (change === 'navigation') e.replace({...e.initial, selectedTopRef: F.OTHER});
  if (change === 'account') e.replace({...e.initial, scopeKey: 'new-account'});
  if (change === 'context') e.setIdentity({context: 'c'.repeat(64), generation: 2});
  gate.reject(rejection(403, 'forbidden')); await waiting;
  assert.notEqual(e.controller.getSnapshot().directory.status, 'denied'); assert.equal(e.draft.getSnapshot().remote.retired, true);
});
test('membership authority ABA retires remote membership but leaves current Manage metadata editable', async t => {
  const e = setup(t, {initial: mixed()}), current = e.controller.getSnapshot();
  current.detail.data.allowed_actions[F.ITEMS] = false; current.detail.data.allowed_actions.can_add = false; e.replace({...current});
  current.detail.data.allowed_actions[F.ITEMS] = true; current.detail.data.allowed_actions.can_add = true; e.replace({...current});
  assert.equal(e.draft.canEdit(), true); assert.equal(e.draft.canEditMembership(), false); assert.equal(e.draft.getSnapshot().remote.membershipRetired, true);
  e.draft.edit({title: 'Metadata survives'}); await e.draft.submit(); assert.deepEqual(e.mutations[0].payload, {title: 'Metadata survives', description: 'Subtitle'});
});
test('current policy loss during remote-context callback cannot dispatch', async t => {
  const e = setup(t, {initial: mixed()}), original = e.providers.remoteContext;
  e.setContextHook(() => {e.initial.detail.data.allowed_actions.can_edit = false;});
  e.draft.setRemoteTitle('No lookup'); await e.draft.searchRemote();
  assert.equal(e.providers.remoteContext, original, 'The actual captured method reenters policy without being replaced');
  assert.equal(e.calls.length, 0); assert.equal(e.draft.canEdit(), false);
});
test('search callbacks cannot smuggle a stale candidate across query replacement', async t => {
  const e = setup(t), old = await search(e); e.draft.setRemoteTitle('New title'); await e.draft.searchRemote();
  assert.equal(await e.draft.selectRemote(old), false); assert.equal(e.calls.filter(row => row.kind === 'begin').length, 0);
});
test('loading emission reentry can retire a preparation before provider dispatch', async t => {
  const e = setup(t); const candidate = await search(e);
  e.draft.subscribe(() => {if (e.draft.getSnapshot().remote.operation?.kind === 'begin') e.replace({...e.initial, scopeKey: 'new-session'});});
  await e.draft.selectRemote(candidate); assert.deepEqual(e.calls.map(row => row.kind), ['search']); assert.equal(e.mutations.length, 0);
});
test('begin acknowledgment reentry cannot dispatch acquisition under a new source', async t => {
  const e = setup(t, {initial: mixed()}); e.draft.setRemoteTitle('Different');
  e.providers.searchRemoteAlbums = async () => ({candidates: [summary(F.id(72))]}); await e.draft.searchRemote();
  e.draft.subscribe(() => {if (e.draft.getSnapshot().remote.preparation) e.replace({...e.initial, detail: {...e.initial.detail, data: F.clone(e.initial.detail.data)}});});
  await e.draft.selectRemote(e.draft.getSnapshot().remote.search.candidates[0]); assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 0);
});
test('exact unavailable acquisition refusal releases only its preparation owner and never fabricates an acknowledgment', async t => {
  const e = setup(t, {acquire: () => {throw rejection();}}); e.draft.edit({title: 'Still private'}); await select(e);
  assert.equal(e.draft.getSnapshot().remote.status, 'unavailable'); assert.equal(e.draft.getSnapshot().remote.operation, null); assert.equal(e.draft.canEdit(), true);
  assert.equal(e.draft.getSnapshot().items.length, 0); assert.equal(e.controller.getSnapshot().mutation.status, 'idle');
  const count = e.calls.length; await e.draft.retryRemoteAcquisition(); assert.equal(e.calls.length, count);
  await e.draft.submit(); assert.deepEqual(e.mutations, [{action: 'create', payload: {title: 'Still private', description: '', album_refs: []}}]);
});
for (const error of [rejection(409, 'remote_preparation_unavailable', false), rejection(409, 'request_key_conflict'), rejection(503, 'remote_acquisition_unavailable')]) {
  test(`unproven or unrelated ${error.code}/${error.responseRejected} refusal retains exact unknown retry`, async t => {
    const e = setup(t, {acquire: () => {throw error;}}); await select(e); assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); assert.equal(e.draft.canEdit(), false);
    await e.draft.retryRemoteAcquisition(); const calls = e.calls.filter(row => row.kind === 'acquire'); assert.deepEqual(calls[0].payload, calls[1].payload); assert.equal(e.mutations.length, 0);
  });
}
test('lost successful close followed by actual unavailable retry retires selectors without removing selected rows', async t => {
  let closed = false; const e = setup(t, {close: () => {if (!closed) {closed = true; throw new TypeError('response lost after delete');} throw rejection();}});
  e.draft.edit({title: 'Preserved'}); await select(e); const selected = F.clone(e.draft.getSnapshot().items);
  await e.draft.closeRemotePreparation(PARENT); assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); assert.equal(e.draft.canEdit(), false);
  await e.draft.retryRemoteAcquisition(); assert.equal(e.draft.getSnapshot().remote.status, 'unavailable'); assert.equal(e.draft.canEdit(), true);
  assert.deepEqual(e.calls.filter(row => row.kind === 'close').map(row => row.payload), [PARENT, PARENT]); assert.deepEqual(e.draft.getSnapshot().items, selected);
  await e.draft.submit(); assert.equal(e.mutations.length, 0); assert.equal(e.draft.getSnapshot().error.code, 'remote_acquisition_expired');
  e.draft.remove('remote:' + ACQUISITION); await e.draft.submit(); assert.deepEqual(e.mutations[0].payload.album_refs, []);
});
test('shared uncertain membership blocks close, status and maintenance independently of preparation availability', async t => {
  const e = setup(t); await select(e); const command = {request_key: F.id(91), draft_ref: e.draft.getSnapshot().formRef, selections: [{kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: VERSION}]};
  e.replace({...e.initial, mutation: {status: 'uncertain', action: 'create', command}}); const before = e.calls.length;
  await e.draft.closeRemotePreparation(PARENT); await e.draft.readRemotePreparationState(); await e.draft.maintainRemotePreparations(); await e.draft.discardRemote(); await e.draft.submit();
  assert.equal(e.calls.length, before); assert.equal(e.controller.getSnapshot().mutation.command, command); assert.equal(e.controller.getSnapshot().mutation.status, 'uncertain'); assert.equal(e.mutations.length, 0);
});
test('late acquisition while another membership owner is uncertain remains exact retryable without selection or settlement', async t => {
  const gate = F.deferred(), entered = F.deferred(), e = setup(t, {acquire: () => {entered.resolve(); return gate.promise;}});
  const candidate = await search(e); const waiting = e.draft.selectRemote(candidate);
  await entered.promise;
  assert.equal(e.calls.filter(row => row.kind === 'acquire').length, 1); const request = e.calls.find(row => row.kind === 'acquire').payload;
  const command = {request_key: F.id(92)}; e.replace({...e.initial, mutation: {status: 'uncertain', action: 'create', command}});
  gate.resolve(e.pending(request)); await waiting;
  assert.equal(e.draft.getSnapshot().items.length, 0); assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); assert.equal(e.controller.getSnapshot().mutation.command, command);
  const count = e.calls.length; await e.draft.retryRemoteAcquisition(); assert.equal(e.calls.length, count);
  e.replace({...e.initial, mutation: {status: 'idle'}}); await e.draft.retryRemoteAcquisition();
  assert.deepEqual(e.calls.filter(row => row.kind === 'acquire').map(row => row.payload), [request, request]); assert.equal(e.draft.getSnapshot().items.length, 1);
});
test('terminal close affects only its pending preparation and does not erase a second parent or retained member', async t => {
  let n = 0; const otherParent = F.id(52), otherAcquisition = F.id(62), otherRG = F.id(72);
  const e = setup(t, {initial: mixed(), search: () => ({candidates: [summary(otherRG), summary(F.id(73))]}),
    begin: (body, _, h) => ({...h.parent(body), preparation_ref: ++n === 1 ? PARENT : otherParent}),
    acquire: (body, _, h) => ({...h.pending(body), acquisition_ref: body.preparation_ref === PARENT ? ACQUISITION : otherAcquisition}),
    close: () => {throw rejection();}});
  e.draft.setRemoteTitle('New'); await e.draft.searchRemote(); const candidates = e.draft.getSnapshot().remote.search.candidates;
  await e.draft.selectRemote(candidates[0]); await e.draft.selectRemote(candidates[1]); await e.draft.closeRemotePreparation(PARENT);
  assert.equal(e.draft.getSnapshot().items.length, 4); e.draft.remove('remote:' + ACQUISITION); await e.draft.submit();
  const sources = e.mutations[0].payload.item_selections.map(row => row.source); assert.ok(sources.some(row => row.admission_ref === ADMISSION)); assert.ok(sources.some(row => row.acquisition_ref === otherAcquisition));
});
test('Items loss retires an outstanding acquisition but preserves genuine Manage-only metadata Save', async t => {
  const gate = F.deferred(), entered = F.deferred(), e = setup(t, {initial: mixed(), search: () => ({candidates: [summary(F.id(72))]}),
    acquire: () => {entered.resolve(); return gate.promise;}});
  e.draft.setRemoteTitle('Additional'); await e.draft.searchRemote(); const waiting = e.draft.selectRemote(e.draft.getSnapshot().remote.search.candidates[0]);
  await entered.promise;
  const sent = e.calls.find(row => row.kind === 'acquire'); assert.ok(sent);
  const current = e.controller.getSnapshot(); current.detail.data.allowed_actions[F.ITEMS] = false; current.detail.data.allowed_actions.can_add = false;
  e.replace({...current}); gate.resolve(e.pending(sent.payload)); await waiting;
  assert.equal(sent.options.signal.aborted, true); assert.equal(e.draft.getSnapshot().items.length, 2); assert.equal(e.draft.canEditMembership(), false);
  assert.equal(e.draft.edit({title: 'Still metadata'}), true); await e.draft.submit(); assert.deepEqual(e.mutations[0].payload, {title: 'Still metadata', description: 'Subtitle'});
});

// R2: synchronous subscribers may explicitly retry while the older invocation
// is still unwinding. Its finally/error owner must not touch the replacement.
for (const entry of ['begin-unknown', 'acquire-unknown', 'acquire-in-flight']) {
  for (const finish of ['pending', 'unknown', 'denied', 'retired']) {
    test(`reentrant ${entry} preserves exactly one replacement attempt through ${finish}`, async t => {
      const gate = F.deferred(), entered = F.deferred(), kind = entry.startsWith('begin') ? 'begin' : 'acquire';
      let attempts = 0;
      const override = (body, options, helpers) => {
        attempts++;
        if (attempts === 1) {
          if (entry === 'acquire-in-flight') return {...body, state: 'in_flight', retry_after_seconds: 1};
          throw new TypeError('first response lost');
        }
        if (attempts === 2) {entered.resolve(); return gate.promise;}
        return kind === 'begin' ? helpers.parent(body) : helpers.pending(body);
      };
      const e = setup(t, {[kind]: override}), candidate = await search(e), notifications = [];
      let retried = false, replacement;
      const unsubscribe = e.draft.subscribe(() => {
        const current = e.draft.getSnapshot().remote;
        notifications.push(current.operation?.status || current.status);
        if (!retried && current.operation?.kind === kind && ['unknown', 'in_flight'].includes(current.operation.status)) {
          retried = true;
          replacement = e.draft.retryRemoteAcquisition();
        }
      });
      t.after(unsubscribe);
      const initial = e.draft.selectRemote(candidate);
      await entered.promise; await initial;
      assert.equal(retried, true); assert.equal(attempts, 2);
      assert.equal(e.draft.getSnapshot().remote.status, 'loading', 'Older catch/finally cannot rewrite the running retry');
      assert.equal(e.draft.getSnapshot().remote.operation.status, 'loading'); assert.equal(e.draft.canEdit(), false);
      const afterInitial = notifications.length, beforeCalls = e.calls.length;
      assert.equal(await e.draft.retryRemoteAcquisition(), false);
      assert.equal(e.calls.length, beforeCalls); assert.equal(attempts, 2, 'No third request while replacement is running');
      assert.equal(notifications.slice(afterInitial).includes('unknown'), false);
      const issued = e.calls.filter(row => row.kind === kind);
      assert.deepEqual(issued[0].payload, issued[1].payload);
      assert.notEqual(issued[0].options.signal, issued[1].options.signal, 'Each invocation has an independent physical lifetime');
      const reply = kind === 'begin' ? e.parent(issued[1].payload) : e.pending(issued[1].payload);
      if (finish === 'retired') e.replace({...e.initial, scopeKey: 'replacement-session'});
      if (finish === 'unknown') gate.reject(new TypeError('retry response lost'));
      else if (finish === 'denied') gate.reject(rejection(403, 'forbidden'));
      else gate.resolve(reply);
      await replacement;
      if (finish === 'pending') {
        assert.equal(e.draft.getSnapshot().remote.status, 'pending'); assert.equal(e.draft.getSnapshot().items.length, 1);
      } else if (finish === 'unknown') {
        assert.equal(e.draft.getSnapshot().remote.status, 'unknown'); assert.equal(e.draft.canEdit(), false);
        assert.equal(await e.draft.retryRemoteAcquisition(), true);
        assert.equal(attempts, 3); assert.deepEqual(e.calls.filter(row => row.kind === kind)[2].payload, issued[0].payload);
        assert.equal(e.draft.getSnapshot().items.length, 1);
      } else if (finish === 'denied') {
        assert.equal(e.draft.getSnapshot().denied, true); assert.equal(e.controller.getSnapshot().directory.status, 'denied');
        assert.equal(e.draft.getSnapshot().items.length, 0);
        assert.equal(await e.draft.retryRemoteAcquisition(), false); assert.equal(attempts, 2);
      } else {
        assert.equal(e.draft.getSnapshot().remote.retired, true); assert.equal(issued[1].options.signal.aborted, true);
        assert.equal(e.draft.getSnapshot().items.length, 0); assert.equal(await e.draft.retryRemoteAcquisition(), false);
      }
      assert.equal(e.mutations.length, 0, 'Acquisition attempts never acknowledge or replace membership writes');
    });
  }
}

for (const kind of ['begin', 'acquire']) {
  test('retry claims ' + kind + ' before its first current-context callback can reenter', async t => {
    const gate = F.deferred(), entered = F.deferred(); let attempts = 0;
    const e = setup(t, {[kind]: (body, options, helpers) => {
      if (++attempts === 1) throw new TypeError('first response lost');
      if (attempts === 2) {entered.resolve(); return gate.promise;}
      return kind === 'begin' ? helpers.parent(body) : helpers.pending(body);
    }});
    await select(e); assert.equal(e.draft.getSnapshot().remote.status, 'unknown');
    let reentered = false, nested;
    e.setContextHook(() => {
      if (!reentered) {reentered = true; nested = e.draft.retryRemoteAcquisition();}
    });
    const current = e.draft.retryRemoteAcquisition(); await entered.promise;
    assert.equal(reentered, true); assert.equal(await nested, false);
    assert.equal(attempts, 2, 'Currency notification cannot claim an overlapping retry');
    assert.equal(e.draft.getSnapshot().remote.operation.status, 'loading');
    e.setContextHook(null);
    const payload = e.calls.filter(row => row.kind === kind)[1].payload;
    gate.resolve(kind === 'begin' ? e.parent(payload) : e.pending(payload));
    await current; assert.equal(e.draft.getSnapshot().items.length, 1); assert.equal(e.mutations.length, 0);
  });
}
