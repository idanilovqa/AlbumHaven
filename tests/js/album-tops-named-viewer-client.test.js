const test = require('node:test');
const assert = require('node:assert/strict');

let createAlbumTopController, createAlbumTopBackendProviders, albumTopActionAllowed;
test.before(async () => {
  ({createAlbumTopController, albumTopActionAllowed} = await import('../../music_app/static/js/album-tops/model.mjs'));
  ({createAlbumTopBackendProviders} = await import('../../music_app/static/js/album-tops/backend-providers.mjs'));
});

// Synthetic transport replies exercise production client boundaries, not durable
// authorization or Postgres persistence. Those remain backend integration tests.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), KEY = id(90);
const SCOPE = 'top-sharing:actor:library', CONTEXT = 'a'.repeat(64);
const BROWSE = 'library.browse.read';
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const error = status => Object.assign(new Error('Request failed'), {status});
const detail = (allowed = {}, patch = {}) => ({top_ref: TOP, title: 'Shared Top', description: 'Source subtitle',
  revision: '7', visibility: 'server_shared', allowed_actions: {[BROWSE]: true, can_read: true, ...allowed}, items: [], ...patch});
const receipt = (action, command, patch = {}) => ({action, request_key: command.request_key, top_ref: command.top_ref,
  revision: '8', ...patch});
function fixture(t, overrides = {}) {
  const calls = {execute: [], keys: [], reads: []};
  const providers = {
    list: async () => ({tops: [detail({can_copy: true})], allowed_actions: {[BROWSE]: true}, next_cursor: null}),
    read: async (ref, options) => {calls.reads.push({ref, options}); return detail({can_copy: true}, {top_ref: ref});},
    ...overrides,
    execute: async (action, command, options) => {calls.execute.push({action, command, options});
      return overrides.execute ? overrides.execute(action, command, options) : receipt(action, command);},
  };
  const controller = createAlbumTopController({providers, requestKey: () => {calls.keys.push(KEY); return KEY;}});
  controller.setScope(SCOPE); t.after(() => controller.dispose());
  return {controller, providers, calls};
}

function transportFixture(t, reply) {
  let context = CONTEXT, scope = SCOPE;
  const calls = [];
  const providers = createAlbumTopBackendProviders({acceptsScope: value => value === scope,
    transport: {context: () => context, async request(path, options) {
      calls.push({path, options});
      return {status: 'ready', context_ref: context, data: await reply(path, options)};
    }}});
  t.after(() => providers.dispose());
  return {providers, calls, options: () => ({scopeKey: SCOPE, signal: new AbortController().signal}),
    context(value) {context = value;}, scope(value) {scope = value;}};
}
const requester = patch => ({request_ref: id(10), top_ref: TOP, title: 'Shared Top', account_ref: id(20),
  display_name: 'Reader', username_display: 'reader', created_at: '2026-10-09T00:00:00+00:00', ...patch});
const sharing = patch => ({top_ref: TOP, revision: '7', visibility: 'server_shared', can_manage: true,
  can_request_edit: false, can_copy: true, request_status: 'none', pending_requests: [requester()], next_pending_cursor: null, ...patch});
const grant = patch => ({account_id: 41, account_ref: id(20), display_name: 'Inactive Editor', username_display: 'editor',
  grant_ref: id(30), role: 'editor', is_active: false, ...patch});
const candidate = patch => ({account_id: 42, account_ref: id(21), display_name: 'Candidate', username_display: 'candidate',
  grant_ref: null, role: null, allowed_actions: {can_grant_editor: true, can_grant_viewer: true}, ...patch});


test('named Viewer grant is gated only by current explicit owner sharing authority', () => {
  const state = {scopeKey: SCOPE, selectedTopRef: TOP, detail: {status: 'ready', data: detail({can_share: true})}};
  assert.equal(albumTopActionAllowed(state, 'grant_viewer'), true);
  for (const can_share of [false, 'true', 1, undefined]) {
    assert.equal(albumTopActionAllowed({...state, detail: {status: 'ready', data: detail({can_share, can_read: true, can_copy: true, can_view_sharing: true})}}, 'grant_viewer'), false);
  }
  assert.equal(albumTopActionAllowed({...state, scopeKey: null}, 'grant_viewer'), false);
  assert.equal(albumTopActionAllowed({...state, selectedTopRef: OTHER}, 'grant_viewer'), false);
});

for (const role of ['viewer', 'editor']) test(`typed access pages preserve named ${role}, stable grant identity and independent eligibility`, async t => {
  const allowed_actions = {can_grant_viewer: role !== 'viewer', can_grant_editor: role !== 'editor'};
  const extra = {email: 'private@example.invalid', local_path: '/private/library', capabilities: ['secret']};
  const h = transportFixture(t, path => path.includes('/access-grants')
    ? {top_ref: TOP, revision: '7', visibility: 'private', grants: [grant({role, ...extra})], next_cursor: null}
    : {top_ref: TOP, revision: '7', candidates: [candidate({role, grant_ref: id(30), allowed_actions: {...allowed_actions, can_delete: true}, ...extra})], next_cursor: null});
  const g = await h.providers.readAccessGrants(TOP, h.options());
  const c = await h.providers.readAccessCandidates(TOP, h.options());
  assert.equal(g.grants[0].role, role); assert.equal(g.grants[0].grant_ref, id(30));
  assert.equal(g.grants[0].is_active, false); assert.equal(g.grants[0].account_id, 41);
  assert.equal(c.candidates[0].role, role); assert.equal(c.candidates[0].grant_ref, id(30));
  assert.deepEqual(c.candidates[0].allowed_actions, allowed_actions);
  assert.doesNotMatch(JSON.stringify([g, c]), /private@example|local_path|capabilities|can_delete/);
});

for (const field of ['can_grant_viewer', 'can_grant_editor']) test(`access candidate ${field} requires an own strict boolean`, async t => {
  let allowed_actions;
  const h = transportFixture(t, () => ({top_ref: TOP, revision: '7', candidates: [candidate({allowed_actions})], next_cursor: null}));
  for (const bad of [undefined, null, 'true', 1, {}]) {
    allowed_actions = {can_grant_viewer: true, can_grant_editor: true, [field]: bad};
    await assert.rejects(h.providers.readAccessCandidates(TOP, h.options()));
  }
  allowed_actions = Object.assign(Object.create({[field]: true}), {[field === 'can_grant_viewer' ? 'can_grant_editor' : 'can_grant_viewer']: true});
  await assert.rejects(h.providers.readAccessCandidates(TOP, h.options()));
});

for (const role of ['owner', 'admin', 'Viewer', '', false]) test(`access adapters reject unrecognized role ${String(role)}`, async t => {
  const h = transportFixture(t, path => path.includes('/access-grants')
    ? {top_ref: TOP, revision: '7', visibility: 'private', grants: [grant({role})], next_cursor: null}
    : {top_ref: TOP, revision: '7', candidates: [candidate({role, grant_ref: id(30)})], next_cursor: null});
  await assert.rejects(h.providers.readAccessGrants(TOP, h.options()));
  await assert.rejects(h.providers.readAccessCandidates(TOP, h.options()));
});

test('grant_viewer adapter sends exact command and rejects a mismatched acknowledgement', async t => {
  let acknowledged = 'grant_viewer';
  const h = transportFixture(t, (_path, options) => receipt(acknowledged, {...options.body, top_ref: TOP}));
  const command = {top_ref: TOP, revision: '7', request_key: KEY, account_id: 42, role: 'viewer'};
  const result = await h.providers.execute('grant_viewer', command, h.options());
  assert.equal(result.action, 'grant_viewer');
  assert.equal(h.calls[0].path, `/album-tops/${TOP}/grant_viewer`);
  assert.deepEqual(h.calls[0].options.body, {revision: '7', request_key: KEY, account_id: 42, role: 'viewer'});
  acknowledged = 'grant_editor';
  await assert.rejects(h.providers.execute('grant_viewer', command, h.options()), {status: 502});
});

test('grant_viewer uncertainty preserves exact downgrade command and key across authorized retry', async t => {
  let attempt = 0;
  const h = fixture(t, {read: () => detail({can_share: true}), execute(action, command) {
    if (++attempt === 1) throw error(502);
    return receipt(action, command);
  }});
  await h.controller.open(TOP);
  assert.equal(await h.controller.mutate('grant_viewer', {account_id: 42, role: 'viewer'}), false);
  assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
  assert.equal(await h.controller.mutate('grant_editor', {account_id: 42, role: 'editor'}), false);
  assert.equal(await h.controller.retryMutation(), true);
  assert.equal(h.calls.keys.length, 1);
  assert.deepEqual(h.calls.execute[1].command, h.calls.execute[0].command);
  assert.equal(h.calls.execute[1].action, 'grant_viewer');
});

test('sharing denial prevents named grants and older positive sharing responses cannot restore authority', async t => {
  const reads = [];
  const h = fixture(t, {read: () => detail({can_share: true, can_view_sharing: true}),
    readSharing() {const pending = deferred(); reads.push(pending); return pending.promise;}});
  await h.controller.open(TOP);
  const old = h.controller.readSharing({}), current = h.controller.readSharing({});
  reads[1].resolve(sharing({can_manage: false})); await current;
  assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), 'grant_viewer'), false);
  reads[0].resolve(sharing({can_manage: true})); await old;
  assert.equal(await h.controller.mutate('grant_viewer', {account_id: 42, role: 'viewer'}), false);
  assert.equal(h.calls.execute.length, 0); assert.equal(h.calls.keys.length, 0);
});

test('private named Viewer can request access and copy but cannot gain source editing, grant or delete authority', async t => {
  const h = fixture(t, {read: () => detail({can_read: true, can_view_sharing: true, can_copy: true,
    can_request_edit: true, can_manage_own_progress: true, can_share: false, can_edit: false, can_delete: false}, {visibility: 'private'})});
  await h.controller.open(TOP);
  for (const action of ['view_sharing', 'copy', 'request_edit', 'set_manual_completion']) assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), true, action);
  for (const action of ['save', 'add', 'remove', 'reorder', 'delete', 'visibility', 'grant_viewer', 'grant_editor', 'revoke_editor', 'decide_edit_request']) {
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), false, action);
    assert.equal(await h.controller.mutate(action, {}), false, action);
  }
  assert.equal(h.calls.execute.length, 0);
});

test('grant rows require a safe target account ID before they can own a role-change control', async t => {
  let account_id;
  const h = transportFixture(t, () => ({top_ref: TOP, revision: '7', visibility: 'private', grants: [grant({role: 'viewer', account_id})], next_cursor: null}));
  for (account_id of [undefined, null, 0, -1, '41', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(h.providers.readAccessGrants(TOP, h.options()));
  }
});
