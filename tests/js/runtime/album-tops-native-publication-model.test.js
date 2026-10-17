'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// Only the real controller is imported. Providers below are controlled DTO
// boundaries, not replacements for controller, native runtime, or server code.
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
let createAlbumTopController, albumTopActionAllowed;
test.before(async () => {
  ({createAlbumTopController, albumTopActionAllowed} = await import(pathToFileURL(
    path.join(ROOT, 'music_app/static/js/album-tops/model.mjs')).href));
});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), A = id(11), B = id(12), IA = id(21), IB = id(22);
const SOURCE_A = id(31), SOURCE_B = id(32), SHARE = id(41), PUBLICATION = id(42);
const SCOPE = 'publication-model:account:session:library', BROWSE = 'library.browse.read';
const EVIDENCE = 'a'.repeat(64), OTHER_EVIDENCE = 'b'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
const denied = () => Object.assign(new Error('Browse was withdrawn'), {status: 403});
const rejected = (status, code) => Object.assign(new Error(code), {status, code});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
// Bounded microtasks only. Every delayed request has an explicitly settled gate.
async function drain() {for (let count = 0; count < 20; count++) await Promise.resolve();}
const permissions = patch => ({[BROWSE]: true, 'library.album_tops.create': true,
  'library.album_tops.manage': true, 'library.album_tops.items.manage': true,
  can_create: true, can_read: true, can_edit: true, can_delete: true, can_add: true,
  can_remove: true, can_reorder: true, can_view_sharing: true, can_share: true,
  can_copy: true, can_request_edit: false, ...patch});
const identities = () => [{item_ref: IA, album_ref: A}, {item_ref: IB, album_ref: B}];
const selections = () => identities().map((row, index) => ({...row,
  selected_local_album_id: 101 + index, selected_source_ref: index ? SOURCE_B : SOURCE_A}));
function detail(patch = {}) {
  return {top_ref: TOP, revision: '7', title: 'Saved Top', description: 'Saved description',
    visibility: 'private', allowed_actions: permissions(),
    items: identities().map((row, index) => ({...row, title: `Saved album ${index + 1}`,
      artist: 'Saved artist', year: 2001, original_position: index + 3, position: index + 1})),
    edit_draft: {items: identities(), publication_preview_required: false}, ...patch};
}
function ownerPublication(state = 'unpublished', patch = {}) {
  const enabled = state === 'enabled';
  const publicPath = enabled ? `/public/album-tops/${SHARE}` : null;
  return {state, share_ref: state === 'unpublished' ? null : SHARE,
    link_revision: state === 'unpublished' ? null : enabled ? '2' : '3',
    publication_ref: enabled ? PUBLICATION : null, publication_revision: enabled ? '1' : null,
    public_path: publicPath, public_url: publicPath ? 'https://public.example.test' + publicPath : null,
    deployment_available: true, can_enable_external: true, can_revoke_external: enabled, ...patch};
}
function sharing(publication = ownerPublication(), patch = {}) {
  return {top_ref: TOP, revision: '7', visibility: 'private', can_manage: true,
    can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: [],
    next_pending_cursor: null, ...(publication === undefined ? {} : {publication}), ...patch};
}
function preview(topRef, payload, patch = {}) {
  return {top_ref: topRef, revision: payload.revision, evidence_revision: EVIDENCE,
    items: payload.items.map((item, index) => ({...item, title: `Approved album ${index + 1}`,
      artist: 'Approved artist', year: null, track_count: 4 + index})), ...patch};
}
function sourcePage(itemRef = IA, patch = {}) {
  return {top_ref: TOP, revision: '7', item_ref: itemRef, album_ref: itemRef === IA ? A : B,
    sources: [{selected_local_album_id: 101, selected_source_ref: SOURCE_A,
      title: 'Same album', artist: 'Same artist', year: 2001},
    {selected_local_album_id: 103, selected_source_ref: id(33),
      title: 'Same album', artist: 'Same artist', year: 2001}], next_cursor: null, ...patch};
}
function receipt(action, command, publication = ownerPublication(action === 'revoke_external' ? 'revoked' : 'enabled')) {
  const {state, share_ref, link_revision, publication_ref, publication_revision} = publication;
  return {action, top_ref: command.top_ref, request_key: command.request_key,
    revision: String(BigInt(command.revision) + 1n),
    publication: {state, share_ref, link_revision, publication_ref, publication_revision}};
}
async function fixture(t, {handlers = {}, row = detail(), publication = ownerPublication(), observe = true} = {}) {
  const calls = [], live = {detail: row, publication}, control = {...handlers};
  let key = 100, keys = 0;
  const summary = row => {
    const {top_ref, revision, title, description, visibility, allowed_actions} = row;
    return {top_ref, revision, title, description, visibility, allowed_actions};
  };
  const defaults = {
    list: () => ({tops: [summary(live.detail)], allowed_actions: permissions(), next_cursor: null}),
    read: topRef => clone({...live.detail, top_ref: topRef}),
    readSharing: topRef => sharing(clone(live.publication), {top_ref: topRef, revision: live.detail.revision}),
    readAccessGrants: topRef => ({top_ref: topRef, revision: live.detail.revision, visibility: 'private', grants: [], next_cursor: null}),
    readPublicationSources: (topRef, itemRef) => sourcePage(itemRef, {top_ref: topRef, revision: live.detail.revision}),
    preview: (topRef, payload) => preview(topRef, payload),
    execute: (action, command) => {
      const result = receipt(action, command);
      live.detail = {...live.detail, revision: result.revision};
      if (action === 'enable_external' || action === 'revoke_external') {
        live.publication = ownerPublication(action === 'revoke_external' ? 'revoked' : 'enabled');
      }
      return result;
    },
  };
  const providers = Object.fromEntries(Object.keys(defaults).map(method => [method, (...args) => {
    calls.push({method, args});
    return (control[method] || defaults[method])(...args);
  }]));
  const controller = createAlbumTopController({providers, requestKey: () => {keys++; return id(++key);}});
  t.after(() => controller.dispose());
  controller.setScope(SCOPE);
  assert.equal(await controller.load(), true);
  assert.equal(await controller.open(TOP), true);
  if (observe) await controller.readSharing();
  return {controller, calls, live, control, count: method => calls.filter(call => call.method === method).length,
    last: method => calls.filter(call => call.method === method).at(-1), keyCount: () => keys};
}
async function prepare(env, items = selections()) {
  const token = await env.controller.preparePublication(items);
  assert.ok(token && typeof token === 'object', 'real preview produces an opaque token');
  assert.equal(env.controller.getSnapshot().preparation.token, token);
  return token;
}
function assertNoPublicationAuthority(controller) {
  const state = controller.getSnapshot();
  assert.notEqual(state.publication.status, 'ready');
  assert.equal(state.publication.data, null);
  assert.equal(albumTopActionAllowed(state, 'enable_external'), false);
  assert.equal(albumTopActionAllowed(state, 'revoke_external'), false);
}

test('owner sharing observation is separate from detail identity and bound to scope, Top, revision, and read generation', async t => {
  const env = await fixture(t, {observe: false});
  const subject = env.controller.getSnapshot().detail.data;
  assertNoPublicationAuthority(env.controller);
  assert.equal((await env.controller.readSharing()).status, 'ready');
  const state = env.controller.getSnapshot(), observation = state.publication;
  assert.equal(state.detail.data, subject);
  assert.equal(observation.status, 'ready');
  assert.deepEqual(observation.data, ownerPublication());
  assert.equal(observation.scopeKey, SCOPE); assert.equal(observation.top_ref, TOP);
  assert.equal(observation.revision, '7');
  assert.ok(Number.isInteger(observation.detailGeneration));
  assert.ok(Number.isInteger(observation.readVersion) && observation.readVersion > 0);
  assert.equal(albumTopActionAllowed(state, 'enable_external'), true);
  assert.equal(albumTopActionAllowed(state, 'enable_external', OTHER), false);
  assert.equal(env.count('read'), 1, 'sharing update does not recursively refetch detail');
  await env.controller.readSharing();
  assert.equal(env.controller.getSnapshot().detail.data, subject);
  assert.ok(env.controller.getSnapshot().publication.readVersion > observation.readVersion);
});

for (const kind of ['absent', 'null', 'malformed', 'wrong-top', 'old-revision']) {
  test(`${kind} owner projection clears prior saved URL and never synthesizes unpublished authority`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')});
    assert.ok(env.controller.getSnapshot().publication.data.public_url);
    env.control.readSharing = () => {
      const value = sharing(ownerPublication('enabled'));
      if (kind === 'absent') delete value.publication;
      if (kind === 'null') value.publication = null;
      if (kind === 'malformed') value.publication.can_enable_external = 'true';
      if (kind === 'wrong-top') value.top_ref = OTHER;
      if (kind === 'old-revision') value.revision = '6';
      return value;
    };
    await env.controller.readSharing();
    assertNoPublicationAuthority(env.controller);
    assert.equal(await env.controller.preparePublication(selections()), false);
    assert.equal(await env.controller.mutate('revoke_external'), false);
    assert.equal(env.count('preview'), 0); assert.equal(env.count('execute'), 0);
  });
}

test('sharing loading and failure immediately remove actionable saved URL without replacing detail identity', async t => {
  const env = await fixture(t, {publication: ownerPublication('enabled')}), gate = deferred();
  const subject = env.controller.getSnapshot().detail.data;
  env.control.readSharing = () => gate.promise;
  const waiting = env.controller.readSharing();
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.controller.getSnapshot().detail.data, subject);
  gate.reject(new Error('sharing offline'));
  await waiting;
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.controller.getSnapshot().detail.data, subject);
});

test('newer owner observation wins even when an older read settles last', async t => {
  const env = await fixture(t), old = deferred(), fresh = deferred(); let reads = 0;
  env.control.readSharing = () => (++reads === 1 ? old : fresh).promise;
  const oldRead = env.controller.readSharing(), freshRead = env.controller.readSharing();
  fresh.resolve(sharing(ownerPublication('revoked'))); await freshRead;
  const observation = env.controller.getSnapshot().publication;
  old.resolve(sharing(ownerPublication('enabled'))); await oldRead;
  assert.equal(env.controller.getSnapshot().publication, observation);
  assert.equal(observation.data.state, 'revoked'); assert.equal(observation.data.public_url, null);
});

test('reentrant sharing-start listener gives the nested newer read sole dispatch and saved-link authority', async t => {
  const env = await fixture(t, {observe: false}), gate = deferred();
  let started = false, nested;
  env.control.readSharing = () => gate.promise;
  const unsubscribe = env.controller.subscribe(() => {
    if (!started && env.controller.getSnapshot().publication.status === 'loading') {
      started = true; nested = env.controller.readSharing();
    }
  });
  t.after(unsubscribe);
  const outer = env.controller.readSharing();
  assert.equal(started, true);
  assert.equal(env.count('readSharing'), 1, 'superseded outer read never invokes its provider');
  const saved = ownerPublication('enabled', {public_url: `https://nested.public.example.test/public/album-tops/${SHARE}`});
  gate.resolve(sharing(saved));
  assert.equal((await nested).status, 'ready');
  assert.notEqual((await outer).status, 'ready');
  assert.deepEqual(env.controller.getSnapshot().publication.data, saved);
  assert.equal(env.count('readSharing'), 1);
});

test('an older in-scope sharing denial retires a newer successful owner observation', async t => {
  const env = await fixture(t), old = deferred(); let reads = 0;
  env.control.readSharing = () => ++reads === 1 ? old.promise : sharing(ownerPublication('enabled'));
  const waiting = env.controller.readSharing();
  await env.controller.readSharing();
  assert.ok(env.controller.getSnapshot().publication.data.public_url);
  old.reject(denied());
  assert.equal((await waiting).status, 'denied');
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.controller.getSnapshot().detail.status, 'denied');
});

test('saved nonempty membership with missing sources never falls back to an empty preview', async t => {
  const env = await fixture(t);
  assert.deepEqual(env.controller.getSnapshot().publicationDraft, {top_ref: TOP, revision: '7', items: identities()});
  assert.equal(await env.controller.preparePublication(), false);
  assert.equal(await env.controller.preparePublication([]), false);
  assert.equal(env.controller.setPublicationSource(IA, selections()[0]), true);
  assert.equal(await env.controller.preparePublication(), false);
  assert.equal(env.count('preview'), 0); assert.equal(env.count('execute'), 0);
});

for (const change of ['missing', 'extra', 'reordered', 'foreign-item', 'foreign-album', 'half-source', 'invalid-local', 'invalid-source']) {
  test(`${change} selection cannot change saved publication membership or order`, async t => {
    const env = await fixture(t), items = selections(), before = clone(env.controller.getSnapshot().publicationDraft);
    if (change === 'missing') items.pop();
    if (change === 'extra') items.push({item_ref: id(23), album_ref: id(13), selected_local_album_id: 104, selected_source_ref: id(34)});
    if (change === 'reordered') items.reverse();
    if (change === 'foreign-item') items[0].item_ref = id(23);
    if (change === 'foreign-album') items[0].album_ref = B;
    if (change === 'half-source') delete items[0].selected_local_album_id;
    if (change === 'invalid-local') items[0].selected_local_album_id = '101';
    if (change === 'invalid-source') items[0].selected_source_ref = 'physical-path';
    assert.equal(env.controller.setPublicationSelections(items), false);
    assert.deepEqual(env.controller.getSnapshot().publicationDraft, before);
    assert.equal(await env.controller.preparePublication(items), false);
    assert.equal(env.count('preview'), 0);
  });
}

test('source selections are detached and preview carries only the saved ordered identities and explicit source pairs', async t => {
  const env = await fixture(t), items = selections();
  items[0].title = 'Unapproved title'; items[0].position = 99;
  assert.equal(env.controller.setPublicationSelections(items), true);
  items[0].selected_source_ref = id(99); items.reverse();
  assert.deepEqual(env.controller.getSnapshot().publicationDraft.items, selections());
  const token = await prepare(env, selections());
  const call = env.last('preview');
  assert.equal(call.args[0], TOP);
  assert.deepEqual(call.args[1], {revision: '7', items: selections()});
  assert.equal(call.args[2].scopeKey, SCOPE); assert.ok(call.args[2].signal instanceof AbortSignal);
  const state = env.controller.getSnapshot();
  assert.equal(state.detail.data.title, 'Saved Top');
  assert.equal(state.detail.data.description, 'Saved description');
  assert.deepEqual(state.preparation.data, preview(TOP, call.args[1]));
  assert.equal(state.preparation.status, 'ready'); assert.equal(state.preparation.token, token);
  assert.equal(env.count('execute'), 0, 'preview success alone never publishes');
  assert.equal(env.keyCount(), 0, 'request identity belongs to explicit Publish');
});

test('real empty-Top preview is required before explicit empty publication', async t => {
  const env = await fixture(t, {row: detail({items: [], edit_draft: {items: [], publication_preview_required: false}})});
  assert.equal(await env.controller.mutate('enable_external', {items: [], evidence_revision: EVIDENCE}), false);
  const token = await prepare(env, []);
  assert.equal(env.count('preview'), 1); assert.deepEqual(env.last('preview').args[1], {revision: '7', items: []});
  assert.equal(env.count('execute'), 0);
  assert.equal(await env.controller.publishPrepared(token), true);
  assert.deepEqual(env.last('execute').args[1].items, []);
});

for (const editDraft of [undefined, null, {items: [], publication_preview_required: false},
  {items: identities().reverse(), publication_preview_required: false}]) {
  test('absent or incoherent saved edit draft cannot authorize publication', async t => {
    const row = detail();
    if (editDraft === undefined) delete row.edit_draft; else row.edit_draft = editDraft;
    const env = await fixture(t, {row});
    assert.equal(env.controller.getSnapshot().publicationDraft, null);
    assert.equal(albumTopActionAllowed(env.controller.getSnapshot(), 'enable_external'), false);
    assert.equal(await env.controller.preparePublication(selections()), false);
    assert.equal(env.count('preview'), 0);
  });
}

test('source browsing is focused, bounded, abortable, and does not auto-select equal-label physical copies', async t => {
  const env = await fixture(t);
  assert.equal(env.count('readPublicationSources'), 0);
  const before = clone(env.controller.getSnapshot().publicationDraft), abort = new AbortController();
  const result = await env.controller.readPublicationSources(IA, {cursor: 'opaque-page', limit: 2, signal: abort.signal});
  assert.equal(result.status, 'ready'); assert.deepEqual(result.data, sourcePage());
  const call = env.last('readPublicationSources');
  assert.equal(call.args[0], TOP); assert.equal(call.args[1], IA);
  assert.equal(call.args[2].revision, '7'); assert.equal(call.args[2].cursor, 'opaque-page');
  assert.equal(call.args[2].limit, 2); assert.equal(call.args[2].scopeKey, SCOPE);
  assert.equal(call.args[2].albumRef, A);
  assert.ok(call.args[2].signal instanceof AbortSignal);
  assert.equal(result.data.sources.length, 2);
  assert.notEqual(result.data.sources[0].selected_source_ref, result.data.sources[1].selected_source_ref);
  assert.deepEqual(env.controller.getSnapshot().publicationDraft, before);
  assert.equal((await env.controller.readPublicationSources(id(99))).status, 'unavailable');
  assert.equal(env.count('readPublicationSources'), 1);
});

test('synchronous source failure does not trap the focused source reader', async t => {
  const env = await fixture(t);
  env.control.readPublicationSources = () => {throw new Error('source page offline');};
  const failed = await env.controller.readPublicationSources(IA);
  assert.equal(failed.status, 'error'); assert.equal(failed.data, null);
  delete env.control.readPublicationSources;
  assert.equal((await env.controller.readPublicationSources(IA)).status, 'ready');
  assert.equal(env.count('readPublicationSources'), 2);
  assert.deepEqual(env.controller.getSnapshot().publicationDraft.items, identities());
});

for (const retirement of ['abort', 'cancel', 'scope', 'navigation', 'dispose']) {
  test(`source reply retired by ${retirement} cannot leak candidates into the current view`, async t => {
    const env = await fixture(t), gate = deferred(), abort = new AbortController();
    env.control.readPublicationSources = () => gate.promise;
    const waiting = env.controller.readPublicationSources(IA, {signal: abort.signal});
    const requestSignal = env.last('readPublicationSources').args[2].signal;
    if (retirement === 'abort') abort.abort();
    if (retirement === 'cancel') env.controller.cancelPublicationPreparation();
    if (retirement === 'scope') env.controller.setScope('different:actor:library');
    if (retirement === 'navigation') await env.controller.open(OTHER);
    if (retirement === 'dispose') env.controller.dispose();
    assert.equal(requestSignal.aborted, true);
    gate.resolve(sourcePage());
    const result = await waiting;
    assert.equal(result.data, null); assert.notEqual(result.status, 'ready');
  });
}

for (const change of ['top', 'revision', 'item', 'album']) {
  test(`source page with mismatched ${change} never becomes a selectable result`, async t => {
    const env = await fixture(t);
    env.control.readPublicationSources = () => sourcePage(IA, change === 'top' ? {top_ref: OTHER}
      : change === 'revision' ? {revision: '8'} : change === 'item' ? {item_ref: IB} : {album_ref: B});
    const result = await env.controller.readPublicationSources(IA);
    assert.notEqual(result.status, 'ready'); assert.equal(result.data, null);
  });
}

test('explicit Publish requires the exact active opaque token and uses the existing single command owner', async t => {
  const env = await fixture(t), token = await prepare(env), gate = deferred();
  env.control.execute = () => gate.promise;
  assert.equal(await env.controller.mutate('enable_external', {items: selections(), evidence_revision: EVIDENCE}), false);
  assert.equal(await env.controller.publishPrepared({...token}), false);
  assert.equal(await env.controller.publishPrepared(null), false);
  const sending = env.controller.publishPrepared(token);
  assert.equal(env.count('execute'), 1); assert.equal(env.keyCount(), 1);
  assert.deepEqual(env.last('execute').args.slice(0, 2), ['enable_external',
    {top_ref: TOP, revision: '7', request_key: id(101), items: selections(), evidence_revision: EVIDENCE}]);
  assert.equal(await env.controller.publishPrepared(token), false);
  assert.equal(await env.controller.mutate('save', {title: 'Competing edit'}), false);
  assert.equal(await env.controller.mutate('revoke_external'), false);
  assert.equal(env.count('execute'), 1); assert.equal(env.keyCount(), 1);
  env.live.detail = detail({revision: '8'}); env.live.publication = ownerPublication('enabled');
  gate.resolve(receipt('enable_external', env.last('execute').args[1])); await sending;
  assert.equal(await env.controller.publishPrepared(token), false);
  assert.equal(env.count('execute'), 1);
});

test('pre-preview and post-preview source changes invalidate previous authority while retaining the saved membership', async t => {
  const env = await fixture(t), gate = deferred();
  env.control.preview = () => gate.promise;
  const waiting = env.controller.preparePublication(selections());
  const oldSignal = env.last('preview').args[2].signal;
  assert.equal(env.controller.setPublicationSource(IA, {selected_local_album_id: 103, selected_source_ref: id(33)}), true);
  assert.equal(oldSignal.aborted, true);
  gate.resolve(preview(TOP, {revision: '7', items: selections()}));
  assert.equal(await waiting, false);
  assert.notEqual(env.controller.getSnapshot().preparation.status, 'ready');
  delete env.control.preview;
  const token = await env.controller.preparePublication(); assert.ok(token);
  assert.equal(env.controller.setPublicationSource(IB, null), true);
  assert.equal(await env.controller.publishPrepared(token), false);
  assert.equal(await env.controller.preparePublication(), false);
  assert.deepEqual(env.controller.getSnapshot().publicationDraft.items.map(({item_ref, album_ref}) => ({item_ref, album_ref})), identities());
  assert.equal(env.count('execute'), 0);
});

test('a newer preview owns the review even when the previous provider ignores its abort', async t => {
  const env = await fixture(t), old = deferred(), fresh = deferred(); let count = 0;
  env.control.preview = () => (++count === 1 ? old : fresh).promise;
  const oldPreview = env.controller.preparePublication(selections());
  const oldSignal = env.last('preview').args[2].signal;
  const freshPreview = env.controller.preparePublication(selections());
  assert.equal(oldSignal.aborted, true);
  fresh.resolve(preview(TOP, {revision: '7', items: selections()}, {evidence_revision: OTHER_EVIDENCE}));
  const token = await freshPreview; assert.ok(token);
  old.resolve(preview(TOP, {revision: '7', items: selections()}));
  assert.equal(await oldPreview, false);
  assert.equal(env.controller.getSnapshot().preparation.token, token);
  assert.equal(env.controller.getSnapshot().preparation.data.evidence_revision, OTHER_EVIDENCE);
  assert.equal(env.count('execute'), 0);
});

for (const retirement of ['cancel', 'revision', 'navigation', 'scope', 'dispose']) {
  test(`${retirement} retires both pending and reviewed publication previews`, async t => {
    const env = await fixture(t), gate = deferred();
    const reviewed = await prepare(env);
    env.control.preview = () => gate.promise;
    const pending = env.controller.preparePublication(selections());
    const signal = env.last('preview').args[2].signal;
    if (retirement === 'cancel') env.controller.cancelPublicationPreparation();
    if (retirement === 'revision') {env.live.detail = detail({revision: '8'}); await env.controller.open(TOP);}
    if (retirement === 'navigation') await env.controller.open(OTHER);
    if (retirement === 'scope') env.controller.setScope('next:actor:session:library');
    if (retirement === 'dispose') env.controller.dispose();
    assert.equal(signal.aborted, true);
    gate.resolve(preview(TOP, {revision: '7', items: selections()}));
    assert.equal(await pending, false);
    assert.equal(await env.controller.publishPrepared(reviewed), false);
    assertNoPublicationAuthority(env.controller);
    assert.notEqual(env.controller.getSnapshot().preparation.status, 'ready');
    assert.equal(env.count('execute'), 0);
  });
}

for (const change of ['top', 'revision', 'membership', 'source', 'evidence', 'metadata']) {
  test(`preview with mismatched ${change} cannot create a Publish token`, async t => {
    const env = await fixture(t);
    env.control.preview = (ref, payload) => {
      const value = preview(ref, payload);
      if (change === 'top') value.top_ref = OTHER;
      if (change === 'revision') value.revision = '8';
      if (change === 'membership') value.items.reverse();
      if (change === 'source') value.items[0].selected_source_ref = id(99);
      if (change === 'evidence') value.evidence_revision = 'not-evidence';
      if (change === 'metadata') value.items[0].track_count = -1;
      return value;
    };
    assert.equal(await env.controller.preparePublication(selections()), false);
    assert.notEqual(env.controller.getSnapshot().preparation.status, 'ready');
    assert.equal(env.count('execute'), 0);
  });
}

test('synchronous preview rejection releases its owner and preserves same-revision choices for a new review', async t => {
  const env = await fixture(t);
  env.control.preview = () => {throw new Error('synchronous preview failure');};
  assert.equal(await env.controller.preparePublication(selections()), false);
  assert.deepEqual(env.controller.getSnapshot().publicationDraft.items, selections());
  assert.notEqual(env.controller.getSnapshot().preparation.status, 'loading');
  delete env.control.preview;
  await prepare(env);
  assert.equal(env.count('preview'), 2); assert.equal(env.count('execute'), 0);
});

for (const owner of ['preview', 'write']) {
  test(`reentrant listener scope switch at ${owner} start prevents stale provider dispatch`, async t => {
    const env = await fixture(t);
    const token = owner === 'write' ? await prepare(env) : null;
    let switched = false;
    const unsubscribe = env.controller.subscribe(() => {
      const state = env.controller.getSnapshot();
      if (!switched && (owner === 'preview' ? state.preparation.status : state.mutation.status) === 'loading') {
        switched = true; env.controller.setScope('replacement:account:session:library');
      }
    });
    t.after(unsubscribe);
    const result = owner === 'preview'
      ? await env.controller.preparePublication(selections()) : await env.controller.publishPrepared(token);
    assert.equal(result, false); assert.equal(switched, true);
    assert.equal(env.count(owner === 'preview' ? 'preview' : 'execute'), 0);
    assert.equal(env.controller.getSnapshot().scopeKey, 'replacement:account:session:library');
    assert.equal(env.controller.getSnapshot().mutation.status, 'idle');
    assertNoPublicationAuthority(env.controller);
  });
}

test('sharing denial defeats an old preview even after a later eligible owner observation', async t => {
  const env = await fixture(t), gate = deferred();
  env.control.preview = () => gate.promise;
  const pendingPreview = env.controller.preparePublication(selections());
  env.control.readSharing = () => {throw denied();};
  assert.equal((await env.controller.readSharing()).status, 'denied');
  assertNoPublicationAuthority(env.controller);
  delete env.control.readSharing;
  await env.controller.open(TOP); await env.controller.readSharing();
  assert.equal(albumTopActionAllowed(env.controller.getSnapshot(), 'enable_external'), true);
  gate.resolve(preview(TOP, {revision: '7', items: selections()}));
  assert.equal(await pendingPreview, false);
  assert.notEqual(env.controller.getSnapshot().preparation.status, 'ready');
  assert.equal(env.count('execute'), 0);
});

for (const kind of ['source', 'preview']) for (const status of [401, 403]) {
  test(`superseded same-Top ${kind} ${status} denial retires newer successful publication authority`, async t => {
    const env = await fixture(t), old = deferred(); let requests = 0;
    if (kind === 'source') {
      env.control.readPublicationSources = () => ++requests === 1 ? old.promise : sourcePage();
    } else {
      env.control.preview = (ref, payload) => ++requests === 1 ? old.promise
        : preview(ref, payload, {evidence_revision: OTHER_EVIDENCE});
    }
    const waiting = kind === 'source'
      ? env.controller.readPublicationSources(IA) : env.controller.preparePublication(selections());
    const signal = env.last(kind === 'source' ? 'readPublicationSources' : 'preview').args[2].signal;
    const fresh = kind === 'source'
      ? await env.controller.readPublicationSources(IA) : await env.controller.preparePublication(selections());
    assert.equal(signal.aborted, true, 'the newer request already superseded the older one');
    if (kind === 'source') assert.equal(fresh.status, 'ready');
    else {assert.ok(fresh); assert.equal(env.controller.getSnapshot().preparation.token, fresh);}
    assert.equal(env.controller.getSnapshot().publication.status, 'ready');
    old.reject(rejected(status, 'access_denied'));
    const oldResult = await waiting;
    if (kind === 'source') assert.equal(oldResult.status, 'denied');
    else assert.equal(oldResult, false);
    assert.equal(env.controller.getSnapshot().detail.status, 'denied');
    assertNoPublicationAuthority(env.controller);
    assert.notEqual(env.controller.getSnapshot().preparation.status, 'ready');
    assert.equal(await env.controller.preparePublication(selections()), false);
    if (kind === 'preview') assert.equal(await env.controller.publishPrepared(fresh), false);
    assert.equal(env.count('execute'), 0);
  });
}

for (const kind of ['source', 'preview']) for (const status of [401, 403]) for (const retirement of ['navigation', 'scope']) {
  test(`old ${kind} ${status} denial after ${retirement} cannot poison the new owner's reviewed preview`, async t => {
    const env = await fixture(t), old = deferred(); let requests = 0;
    if (kind === 'source') env.control.readPublicationSources = () => old.promise;
    else env.control.preview = (ref, payload) => ++requests === 1 ? old.promise : preview(ref, payload);
    const waiting = kind === 'source'
      ? env.controller.readPublicationSources(IA) : env.controller.preparePublication(selections());
    const signal = env.last(kind === 'source' ? 'readPublicationSources' : 'preview').args[2].signal;
    if (retirement === 'scope') {
      env.controller.setScope('replacement:account:session:library');
      await env.controller.load();
    }
    await env.controller.open(retirement === 'navigation' ? OTHER : TOP);
    await env.controller.readSharing();
    const token = await prepare(env), current = env.controller.getSnapshot();
    assert.equal(signal.aborted, true);
    old.reject(rejected(status, 'old_owner_access_denied')); await waiting;
    const state = env.controller.getSnapshot();
    assert.equal(state.detail, current.detail);
    assert.equal(state.publication, current.publication);
    assert.equal(state.preparation.token, token);
    assert.equal(state.detail.status, 'ready');
    assert.equal(state.publication.status, 'ready');
    assert.equal(state.preparation.status, 'ready');
    assert.equal(env.count('execute'), 0);
  });
}

test('a sharing read begun before consumed denial cannot restore authority or enable exact replay', async t => {
  const env = await fixture(t), old = deferred();
  env.control.execute = () => {throw new Error('lost publication response');};
  await env.controller.publishPrepared(await prepare(env));
  env.control.readSharing = () => old.promise;
  const waiting = env.controller.readSharing();
  assert.equal(env.controller.observeDenial(SCOPE, denied()), true);
  assert.equal(env.controller.canRetryMutation(), false);
  await env.controller.open(TOP);
  old.resolve(sharing(ownerPublication())); await waiting;
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.controller.canRetryMutation(), false);
  assert.equal(await env.controller.retryMutation(), false);
  delete env.control.readSharing; await env.controller.readSharing();
  assert.equal(env.controller.canRetryMutation(), true);
  assert.equal(env.count('execute'), 1, 'fresh authority is not an automatic retry');
});

for (const action of ['enable_external', 'revoke_external']) {
  test(`consumed sharing denial blocks an older ${action} response despite later authority restoration`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')}), gate = deferred();
    env.control.execute = () => gate.promise;
    const sending = action === 'enable_external'
      ? env.controller.publishPrepared(await prepare(env)) : env.controller.mutate('revoke_external');
    const command = clone(env.last('execute').args[1]);
    env.control.readSharing = () => {throw denied();};
    await env.controller.readSharing();
    assertNoPublicationAuthority(env.controller);
    delete env.control.readSharing;
    await env.controller.open(TOP); await env.controller.readSharing();
    gate.resolve(receipt(action, command));
    assert.equal(await sending, false);
    assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
    assert.deepEqual(env.controller.getSnapshot().mutation.command, command);
    assert.equal(env.count('execute'), 1);
    assert.equal(env.controller.canRetryMutation(), true, 'restored current observation remains sufficient after rejecting the old attempt');
    env.control.execute = (nextAction, nextCommand) => receipt(nextAction, nextCommand);
    assert.equal(await env.controller.retryMutation(), true);
    assert.deepEqual(env.last('execute').args[1], command); assert.equal(env.keyCount(), 1);
  });
}

for (const gateName of ['can_edit', BROWSE]) {
  test(`explicit ${gateName}=false detail gate consumes in-flight Publish authority until fresh owner recovery`, async t => {
    const env = await fixture(t), gate = deferred();
    env.control.execute = () => gate.promise;
    const sending = env.controller.publishPrepared(await prepare(env));
    const command = clone(env.last('execute').args[1]);
    env.live.detail = detail({allowed_actions: permissions({[gateName]: false})});
    await env.controller.open(TOP);
    assert.equal(env.controller.canRetryMutation(), false);
    env.live.detail = detail(); await env.controller.open(TOP); await env.controller.load();
    assertNoPublicationAuthority(env.controller);
    assert.equal(env.controller.canRetryMutation(), false, 'restored detail and directory are not owner publication authority');
    await env.controller.readSharing();
    gate.resolve(receipt('enable_external', command));
    assert.equal(await sending, false);
    assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
    assert.deepEqual(env.controller.getSnapshot().mutation.command, command);
    assert.equal(env.controller.canRetryMutation(), true);
    assert.equal(env.count('execute'), 1);
    env.control.execute = (action, exact) => receipt(action, exact);
    assert.equal(await env.controller.retryMutation(), true);
    assert.deepEqual(env.last('execute').args[1], command); assert.equal(env.keyCount(), 1);
  });
}

test('edit denial alone does not consume an already-sent revoke when Browse remains current', async t => {
  const env = await fixture(t, {publication: ownerPublication('enabled')}), gate = deferred();
  env.control.execute = () => gate.promise;
  const sending = env.controller.mutate('revoke_external');
  const command = clone(env.last('execute').args[1]);
  env.live.detail = detail({allowed_actions: permissions({can_edit: false, can_share: false})});
  env.live.publication = ownerPublication('enabled', {can_enable_external: false});
  await env.controller.open(TOP); await env.controller.readSharing();
  gate.resolve(receipt('revoke_external', command));
  assert.equal(await sending, true);
  assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  assert.equal(env.controller.canRetryMutation(), false); assert.equal(env.count('execute'), 1);
});

test('uncertain Publish retries the exact original request, source vector, revision, and evidence without another preview', async t => {
  const env = await fixture(t); let attempts = 0;
  env.control.execute = (action, command) => {
    if (++attempts === 1) throw new Error('response lost after possible commit');
    return receipt(action, command);
  };
  const token = await prepare(env);
  assert.equal(await env.controller.publishPrepared(token), false);
  const original = clone(env.last('execute').args[1]);
  assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(await env.controller.publishPrepared(token), false);
  assert.equal(await env.controller.mutate('save', {title: 'Competing save'}), false);
  env.live.detail = detail({revision: '8', edit_draft: {items: selections(), publication_preview_required: true}});
  env.live.publication = ownerPublication('enabled');
  await env.controller.open(TOP); await env.controller.readSharing();
  assert.equal(env.controller.canRetryMutation(), true);
  assert.equal(await env.controller.preparePublication(selections()), false);
  assert.equal(await env.controller.retryMutation(), true);
  assert.deepEqual(env.last('execute').args[1], original);
  assert.equal(env.keyCount(), 1); assert.equal(env.count('preview'), 1);
  assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  assert.equal(await env.controller.retryMutation(), false); assert.equal(env.count('execute'), 2);
});

test('lost revoke response followed by saved revoked state permits only exact original recovery', async t => {
  const env = await fixture(t, {publication: ownerPublication('enabled')}); let attempts = 0;
  env.control.execute = (action, command) => {
    if (++attempts === 1) {
      env.live.detail = detail({revision: '8', allowed_actions: permissions({can_edit: false, can_share: false})});
      env.live.publication = ownerPublication('revoked', {deployment_available: false, can_enable_external: false});
      throw new Error('committed revoke response lost');
    }
    return receipt(action, command);
  };
  assert.equal(await env.controller.mutate('revoke_external'), false);
  const original = clone(env.last('execute').args[1]);
  assert.deepEqual(original, {request_key: id(101), top_ref: TOP, revision: '7'});
  await env.controller.open(TOP); await env.controller.readSharing();
  const state = env.controller.getSnapshot();
  assert.equal(state.publication.data.state, 'revoked');
  assert.equal(state.publication.data.can_revoke_external, false);
  assert.equal(state.publication.data.deployment_available, false);
  assert.equal(state.mutation.status, 'uncertain', 'observed revoked state is not an acknowledgment of this operation');
  assert.equal(albumTopActionAllowed(state, 'revoke_external'), false);
  assert.equal(env.controller.canRetryMutation(), true);
  assert.equal(await env.controller.mutate('revoke_external'), false);
  assert.equal(await env.controller.retryMutation(), true);
  assert.deepEqual(env.last('execute').args[1], original); assert.equal(env.keyCount(), 1);
  assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
});

for (const retirement of ['navigation', 'denial']) {
  test(`reentrant ${retirement} before exact revoke retry dispatch preserves its original uncertain owner`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')});
    env.control.execute = () => {throw new Error('original response unknown');};
    await env.controller.mutate('revoke_external');
    const original = clone(env.last('execute').args[1]);
    await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    env.control.execute = (action, command) => receipt(action, command);
    let retired = false, navigation;
    const unsubscribe = env.controller.subscribe(() => {
      if (!retired && env.controller.getSnapshot().mutation.status === 'loading') {
        retired = true;
        if (retirement === 'navigation') navigation = env.controller.open(OTHER);
        else env.controller.observeDenial(SCOPE, denied());
      }
    });
    t.after(unsubscribe);
    assert.equal(await env.controller.retryMutation(), false);
    if (navigation) await navigation;
    assert.equal(retired, true);
    assert.equal(env.count('execute'), 1, 'retired recovery did not dispatch a second command');
    assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
    assert.deepEqual(env.controller.getSnapshot().mutation.command, original);
    assert.equal(env.keyCount(), 1);
    await env.controller.open(TOP); await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    assert.equal(await env.controller.retryMutation(), true);
    assert.equal(env.count('execute'), 2);
    assert.deepEqual(env.last('execute').args[1], original); assert.equal(env.keyCount(), 1);
  });
}

for (const constraint of ['hosting-off', 'editing-denied', 'sharing-management-denied', 'no-edit-draft']) {
  test(`new revoke stays available with ${constraint} when current owner Browse and revoke authority remain`, async t => {
    const row = detail(), publication = ownerPublication('enabled');
    if (constraint === 'hosting-off') Object.assign(publication, {deployment_available: false, can_enable_external: false, public_url: null});
    if (constraint === 'editing-denied') {row.allowed_actions.can_edit = false; publication.can_enable_external = false;}
    if (constraint === 'sharing-management-denied') {row.allowed_actions.can_share = false; publication.can_enable_external = false;}
    if (constraint === 'no-edit-draft') {delete row.edit_draft; row.allowed_actions.can_edit = false; publication.can_enable_external = false;}
    const env = await fixture(t, {row, publication});
    if (constraint === 'sharing-management-denied') {
      env.control.readSharing = () => sharing(publication, {can_manage: false});
      await env.controller.readSharing();
    }
    assert.equal(albumTopActionAllowed(env.controller.getSnapshot(), 'revoke_external'), true);
    assert.equal(await env.controller.mutate('revoke_external'), true);
    assert.equal(env.last('execute').args[0], 'revoke_external');
    assert.equal(env.count('preview'), 0);
  });
}

test('Browse denial blocks both public actions despite owner flags in an otherwise valid DTO', async t => {
  const env = await fixture(t, {row: detail({allowed_actions: permissions({[BROWSE]: false})}),
    publication: ownerPublication('enabled')});
  assertNoPublicationAuthority(env.controller);
  assert.equal(await env.controller.preparePublication(selections()), false);
  assert.equal(await env.controller.mutate('revoke_external'), false);
  assert.equal(env.count('readSharing'), 0); assert.equal(env.count('execute'), 0);
});

for (const observed of ['unpublished', 'enabled', 'revoked']) {
  test(`exact pending revoke can recover from fresh ${observed} owner state with publishing disabled`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')});
    env.control.execute = () => {throw new Error('uncertain revoke');};
    await env.controller.mutate('revoke_external');
    const original = clone(env.last('execute').args[1]);
    assert.equal(env.controller.canRetryMutation(), false, 'the send retired its pre-send observation');
    env.live.publication = ownerPublication(observed, {deployment_available: false, can_enable_external: false, public_url: null});
    await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    env.control.execute = (action, command) => receipt(action, command);
    assert.equal(await env.controller.retryMutation(), true);
    assert.deepEqual(env.last('execute').args[1], original); assert.equal(env.keyCount(), 1);
  });
}

for (const action of ['enable_external', 'revoke_external']) {
  test(`${action} recovery requires fresh owner projection; Browse-only detail cannot restore it`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')});
    env.control.execute = () => {throw new Error('uncertain write');};
    if (action === 'enable_external') await env.controller.publishPrepared(await prepare(env));
    else await env.controller.mutate(action);
    assert.equal(env.controller.observeDenial(SCOPE, denied()), true);
    await env.controller.open(TOP); await env.controller.load();
    assert.equal(env.controller.canRetryMutation(), false);
    env.control.readSharing = () => {const value = sharing(); delete value.publication; return value;};
    await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), false);
    assert.equal(await env.controller.retryMutation(), false);
    delete env.control.readSharing; await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    assert.equal(env.count('execute'), 1);
  });
}

test('pending Publish cannot replay under hosting loss but later eligible observation restores only the exact request', async t => {
  const env = await fixture(t);
  env.control.execute = () => {throw new Error('lost response');};
  await env.controller.publishPrepared(await prepare(env));
  const original = clone(env.last('execute').args[1]);
  env.live.publication = ownerPublication('enabled', {deployment_available: false, can_enable_external: false, public_url: null});
  await env.controller.readSharing();
  assert.equal(env.controller.canRetryMutation(), false);
  assert.equal(await env.controller.retryMutation(), false);
  env.live.publication = ownerPublication('enabled'); await env.controller.readSharing();
  assert.equal(env.controller.canRetryMutation(), true);
  env.control.execute = (action, command) => receipt(action, command);
  assert.equal(await env.controller.retryMutation(), true);
  assert.deepEqual(env.last('execute').args[1], original); assert.equal(env.keyCount(), 1);
});

for (const action of ['enable_external', 'revoke_external']) {
  test(`definitive ${action} denial cannot be resurrected as an uncertain retry by later reads`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')});
    env.control.execute = () => {throw denied();};
    const token = action === 'enable_external' ? await prepare(env) : null;
    const result = action === 'enable_external'
      ? await env.controller.publishPrepared(token) : await env.controller.mutate(action);
    assert.equal(result, false);
    assert.equal(env.controller.getSnapshot().mutation.status, 'denied');
    assertNoPublicationAuthority(env.controller);
    await env.controller.open(TOP); await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), false);
    assert.equal(await env.controller.retryMutation(), false);
    if (token) assert.equal(await env.controller.publishPrepared(token), false);
    assert.equal(env.count('execute'), 1); assert.equal(env.keyCount(), 1);
  });
}

for (const action of ['enable_external', 'revoke_external']) for (const status of [403, 409]) {
  test(`unknown ${action} original survives replay ${status} and later recovers with the same exact command`, async t => {
    const env = await fixture(t, {publication: ownerPublication('enabled')}); let attempts = 0;
    env.control.execute = (nextAction, command) => {
      attempts++;
      if (attempts === 1) throw new Error('original may have committed but its response was lost');
      if (attempts === 2) throw rejected(status, status === 403 ? 'access_denied' : 'evidence_stale');
      return receipt(nextAction, command);
    };
    const token = action === 'enable_external' ? await prepare(env) : null;
    if (token) assert.equal(await env.controller.publishPrepared(token), false);
    else assert.equal(await env.controller.mutate(action), false);
    const original = clone(env.last('execute').args[1]);
    await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    assert.equal(await env.controller.retryMutation(), false);
    assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
    assert.equal(env.controller.getSnapshot().mutation.error.status, status);
    assert.deepEqual(env.controller.getSnapshot().mutation.command, original);
    assert.equal(env.controller.canRetryMutation(), false);
    assert.equal(await env.controller.retryMutation(), false);
    assert.equal(await env.controller.mutate('revoke_external'), false);
    assert.equal(await env.controller.mutate('save', {title: 'New competing request'}), false);
    assert.equal(await env.controller.preparePublication(selections()), false);
    if (token) assert.equal(await env.controller.publishPrepared(token), false);
    assert.equal(env.count('execute'), 2); assert.equal(env.keyCount(), 1);
    await env.controller.open(TOP); await env.controller.readSharing();
    assert.equal(env.controller.canRetryMutation(), true);
    assert.equal(env.count('execute'), 2, 'fresh owner restoration does not automatically resend');
    assert.equal(await env.controller.retryMutation(), true);
    const commands = env.calls.filter(call => call.method === 'execute').map(call => call.args[1]);
    assert.deepEqual(commands, [original, original, original]);
    assert.equal(env.keyCount(), 1); assert.equal(env.count('preview'), token ? 1 : 0);
    assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
    assert.equal(env.controller.canRetryMutation(), false);
  });
}

for (const code of ['revision_conflict', 'evidence_stale']) {
  test(`${code} requires a new preview and explicit Publish while keeping same-scope source choices for review`, async t => {
    const env = await fixture(t);
    env.control.execute = () => {throw rejected(409, code);};
    const token = await prepare(env);
    assert.equal(await env.controller.publishPrepared(token), false);
    assert.equal(env.controller.getSnapshot().mutation.status, 'error');
    assert.equal(env.controller.getSnapshot().mutation.error.code, code);
    assert.equal(env.controller.canRetryMutation(), false);
    assert.equal(await env.controller.publishPrepared(token), false);
    assert.deepEqual(env.controller.getSnapshot().publicationDraft.items, selections());
    await env.controller.open(TOP); await env.controller.readSharing();
    assert.deepEqual(env.controller.getSnapshot().publicationDraft.items, selections());
    delete env.control.execute;
    const freshToken = await env.controller.preparePublication();
    assert.ok(freshToken); assert.notEqual(freshToken, token);
    assert.equal(env.count('execute'), 1, 'new preview still requires an explicit click');
    assert.equal(await env.controller.publishPrepared(freshToken), true);
    assert.equal(env.keyCount(), 2); assert.equal(env.count('preview'), 2);
  });
}

test('acknowledgment refreshes detail before sharing; only fresh sharing supplies the saved URL', async t => {
  const env = await fixture(t), detailGate = deferred(), sharingGate = deferred();
  const token = await prepare(env); let acknowledged = false;
  env.control.execute = (action, command) => {acknowledged = true; return receipt(action, command);};
  env.control.read = ref => acknowledged ? detailGate.promise : detail({top_ref: ref});
  env.control.readSharing = () => sharingGate.promise;
  const sending = env.controller.publishPrepared(token); await drain();
  assert.equal(env.controller.getSnapshot().mutation.status, 'ready');
  assert.equal(env.controller.getSnapshot().mutation.refreshing, true);
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.count('readSharing'), 1, 'sharing refresh waits for current detail');
  detailGate.resolve(detail({revision: '8'})); await drain();
  assert.equal(env.count('readSharing'), 2);
  assertNoPublicationAuthority(env.controller);
  const saved = ownerPublication('enabled', {public_url: `https://saved.public.example.test/public/album-tops/${SHARE}`});
  sharingGate.resolve(sharing(saved, {revision: '8'}));
  assert.equal(await sending, true);
  assert.equal(env.controller.getSnapshot().publication.data.public_url, saved.public_url);
  assert.equal(env.controller.getSnapshot().mutation.refreshing, false);
  assert.equal(env.controller.getSnapshot().mutation.data.publication.public_url, undefined);
});

for (const broken of ['detail', 'sharing', 'directory']) {
  test(`acknowledged publication survives failed ${broken} refresh without resend or receipt-derived link`, async t => {
    const env = await fixture(t), token = await prepare(env);
    env.control.execute = (action, command) => receipt(action, command);
    env.control[broken === 'detail' ? 'read' : broken === 'directory' ? 'list' : 'readSharing'] = () => {throw new Error(`${broken} unavailable`);};
    env.live.detail = detail({revision: '8'}); env.live.publication = ownerPublication('enabled');
    assert.equal(await env.controller.publishPrepared(token), true);
    const state = env.controller.getSnapshot();
    assert.equal(state.mutation.status, 'ready'); assert.equal(state.mutation.refreshing, false);
    assert.equal(state.mutation.data.publication.state, 'enabled');
    assert.equal(env.controller.canRetryMutation(), false);
    assert.equal(await env.controller.retryMutation(), false); assert.equal(env.count('execute'), 1);
    if (broken !== 'directory') assertNoPublicationAuthority(env.controller);
    else assert.equal(state.publication.data.public_url, env.live.publication.public_url);
  });
}

for (const currentState of ['revoked', 'enabled']) {
  test(`historical enabled replay receipt cannot override fresh ${currentState} link observation`, async t => {
    const env = await fixture(t); let calls = 0;
    env.control.execute = (action, command) => {
      if (++calls === 1) throw new Error('original acknowledgment lost');
      return receipt(action, command);
    };
    await env.controller.publishPrepared(await prepare(env));
    const original = clone(env.last('execute').args[1]);
    env.live.detail = detail({revision: '12'});
    env.live.publication = ownerPublication(currentState, currentState === 'enabled'
      ? {share_ref: id(51), link_revision: '9', publication_ref: id(52), publication_revision: '6',
        public_path: `/public/album-tops/${id(51)}`, public_url: `https://new.public.example.test/public/album-tops/${id(51)}`}
      : {link_revision: '9'});
    await env.controller.open(TOP); await env.controller.readSharing();
    assert.equal(await env.controller.retryMutation(), true);
    const state = env.controller.getSnapshot();
    assert.deepEqual(env.last('execute').args[1], original);
    assert.equal(state.mutation.data.publication.state, 'enabled', 'historical receipt remains acknowledged as history');
    assert.equal(state.mutation.data.publication.share_ref, SHARE);
    assert.deepEqual(state.publication.data, env.live.publication);
    assert.equal(state.publication.revision, '12');
    assert.equal(state.publication.data.public_url, currentState === 'revoked' ? null : env.live.publication.public_url);
  });
}

test('cancel and reopen retain exact uncertain recovery identity without automatically retrying or reviving the preview', async t => {
  const env = await fixture(t);
  env.control.execute = () => {throw new Error('network outcome unknown');};
  const token = await prepare(env); await env.controller.publishPrepared(token);
  const command = clone(env.controller.getSnapshot().mutation.command);
  env.controller.cancelPublicationPreparation();
  assertNoPublicationAuthority(env.controller);
  assert.equal(await env.controller.publishPrepared(token), false);
  assert.deepEqual(env.controller.getSnapshot().mutation.command, command);
  await env.controller.open(TOP); await env.controller.readSharing();
  assert.equal(env.controller.getSnapshot().mutation.status, 'uncertain');
  assert.deepEqual(env.controller.getSnapshot().mutation.command, command);
  assert.equal(env.count('execute'), 1); assert.equal(env.count('preview'), 1);
  assert.equal(env.keyCount(), 1); assert.equal(env.controller.canRetryMutation(), true);
});

test('scope retirement drops uncertain recovery and old public URL rather than carrying them into another actor', async t => {
  const env = await fixture(t, {publication: ownerPublication('enabled')});
  env.control.execute = () => {throw new Error('lost revoke response');};
  await env.controller.mutate('revoke_external');
  env.controller.setScope('other:account:session:library');
  assert.equal(env.controller.getSnapshot().mutation.status, 'idle');
  assert.equal(env.controller.getSnapshot().publicationDraft, null);
  assertNoPublicationAuthority(env.controller);
  assert.equal(env.controller.canRetryMutation(), false);
  assert.equal(await env.controller.retryMutation(), false);
  assert.equal(env.count('execute'), 1);
});
