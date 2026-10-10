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
const TOP = id(1), OTHER = id(2), COPY = id(3), KEY = id(90);
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

test('collaboration actions require their own explicit current Top projection', () => {
  const map = {view_sharing: 'can_view_sharing', visibility: 'can_share', grant_editor: 'can_share',
    revoke_editor: 'can_share', decide_edit_request: 'can_share', request_edit: 'can_request_edit', copy: 'can_copy'};
  for (const [action, permission] of Object.entries(map)) {
    const state = {scopeKey: SCOPE, selectedTopRef: TOP, detail: {status: 'ready', data: detail({[permission]: true})}};
    assert.equal(albumTopActionAllowed(state, action), true, action);
    for (const value of [false, 'true', 1, undefined]) {
      assert.equal(albumTopActionAllowed({...state, detail: {status: 'ready', data: detail({[permission]: value})}}, action), false, action);
    }
    assert.equal(albumTopActionAllowed({...state, selectedTopRef: OTHER}, action), false);
    assert.equal(albumTopActionAllowed({...state, scopeKey: null}, action), false);
  }
});

test('copy uncertainty retains the original source revision, authored body and key', async t => {
  let attempt = 0;
  const h = fixture(t, {execute(action, command) {
    if (++attempt === 1) throw error(502);
    return receipt(action, command, {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'});
  }});
  await h.controller.open(TOP);
  assert.equal(await h.controller.mutate('copy', {title: 'My private copy'}), false);
  assert.equal(h.controller.getSnapshot().mutation.status, 'uncertain');
  assert.deepEqual(h.calls.execute[0].command, {title: 'My private copy', request_key: KEY, top_ref: TOP, revision: '7'});
  assert.equal(await h.controller.mutate('copy', {title: 'Changed duplicate'}), false);
  assert.equal(await h.controller.retryMutation(), true);
  assert.equal(h.calls.keys.length, 1);
  assert.deepEqual(h.calls.execute[1].command, h.calls.execute[0].command);
  assert.equal(h.controller.getSnapshot().mutation.data.top_ref, COPY);
});

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
  grant_ref: null, role: null, allowed_actions: {can_grant_editor: true}, ...patch});

test('sharing adapters preserve current revision, bounded cursors and revocable inactive grants without private fields', async t => {
  const privateFields = {email: 'private@example.invalid', password_hash: 'not-public', local_path: '/private/library', capabilities: ['secret']};
  const h = transportFixture(t, path => {
    if (path.includes('/sharing')) return sharing({pending_requests: [{...requester(), ...privateFields}], ...privateFields});
    if (path.includes('/access-grants')) return {top_ref: TOP, revision: '7', visibility: 'server_shared',
      grants: [{...grant(), ...privateFields}], next_cursor: 'grants-page-two', ...privateFields};
    if (path.includes('/access-candidates')) return {top_ref: TOP, revision: '7',
      candidates: [{...candidate(), ...privateFields}], next_cursor: 'candidates-page-two', ...privateFields};
    if (path.startsWith('/album-tops/edit-requests')) return {requests: [{...requester(), ...privateFields}], next_cursor: null, ...privateFields};
    assert.fail(`Unexpected read ${path}`);
  });
  const shared = await h.providers.readSharing(TOP, {...h.options(), cursor: 'requests-next'});
  const grants = await h.providers.readAccessGrants(TOP, {...h.options(), cursor: 'grants-next'});
  const candidates = await h.providers.readAccessCandidates(TOP, {...h.options(), q: 'A & B', cursor: 'candidates-next'});
  const requests = await h.providers.readEditRequests({...h.options(), cursor: 'feed-next'});
  assert.equal(shared.revision, '7'); assert.equal(shared.pending_requests[0].top_ref, TOP);
  assert.equal(grants.grants[0].is_active, false); assert.equal(grants.grants[0].grant_ref, id(30));
  assert.equal(grants.next_cursor, 'grants-page-two');
  assert.equal(candidates.candidates[0].allowed_actions.can_grant_editor, true);
  assert.equal(candidates.next_cursor, 'candidates-page-two');
  assert.equal(requests.requests[0].request_ref, id(10));
  for (const value of [shared, grants, candidates, requests]) assert.doesNotMatch(JSON.stringify(value), /private@example|password_hash|local_path|capabilities|not-public/);
  const urls = h.calls.map(call => new URL(call.path, 'https://album.test'));
  assert.deepEqual(urls.map(url => url.pathname), [`/album-tops/${TOP}/sharing`, `/album-tops/${TOP}/access-grants`,
    `/album-tops/${TOP}/access-candidates`, '/album-tops/edit-requests']);
  assert.deepEqual(urls.map(url => url.searchParams.get('cursor')), ['requests-next', 'grants-next', 'candidates-next', 'feed-next']);
  assert.equal(urls[2].searchParams.get('q'), 'A & B');
  assert.ok(h.calls.every(call => call.options.expected === CONTEXT && call.options.signal instanceof AbortSignal));
});

for (const method of ['readSharing', 'readAccessGrants', 'readAccessCandidates']) {
  test(`${method} rejects wrong resource identities and unsafe revisions`, async t => {
    const payload = method === 'readSharing' ? sharing() : method === 'readAccessGrants'
      ? {top_ref: TOP, revision: '7', visibility: 'private', grants: [grant()], next_cursor: null}
      : {top_ref: TOP, revision: '7', candidates: [candidate()], next_cursor: null};
    let bad = {...payload, top_ref: OTHER};
    const h = transportFixture(t, () => bad);
    await assert.rejects(h.providers[method](TOP, h.options()));
    bad = {...payload, revision: 7};
    await assert.rejects(h.providers[method](TOP, h.options()));
  });
}

test('candidate eligibility is strictly boolean and cannot be recovered from inherited or coarse permissions', async t => {
  let actions = {can_grant_editor: 'true', can_edit: true};
  const h = transportFixture(t, () => ({top_ref: TOP, revision: '7', candidates: [candidate({allowed_actions: actions})], next_cursor: null}));
  await assert.rejects(h.providers.readAccessCandidates(TOP, h.options()));
  actions = Object.create({can_grant_editor: true});
  await assert.rejects(h.providers.readAccessCandidates(TOP, h.options()));
});

test('private sharing requests retire on actor/library context change, caller abort and provider disposal', async t => {
  for (const retire of ['context', 'scope', 'abort', 'dispose']) {
    const pending = deferred(), h = transportFixture(t, () => pending.promise), options = h.options();
    const aborter = new AbortController(); options.signal = aborter.signal;
    const reading = h.providers.readSharing(TOP, options);
    if (retire === 'context') h.context('b'.repeat(64));
    if (retire === 'scope') h.scope('other:actor:library');
    if (retire === 'abort') aborter.abort();
    if (retire === 'dispose') h.providers.dispose();
    pending.resolve(sharing());
    await assert.rejects(reading, {name: 'AbortError'});
  }
});

test('collaboration mutation adapters send exact backend commands and acknowledge only matching actions', async t => {
  const h = transportFixture(t, (path, options) => receipt(path.split('/').at(-1), {...options.body, top_ref: TOP},
    path.endsWith('/request_edit') ? {request_ref: id(10), request_status: 'pending', request_created: false} : {}));
  const commands = {
    visibility: {visibility: 'server_shared'}, grant_editor: {account_id: 42, role: 'editor'},
    revoke_editor: {grant_ref: id(30)}, request_edit: {}, decide_edit_request: {request_ref: id(10), decision: 'decline'},
  };
  for (const [action, data] of Object.entries(commands)) {
    const command = {...data, top_ref: TOP, revision: '7', request_key: KEY};
    const value = await h.providers.execute(action, command, h.options());
    assert.equal(value.top_ref, TOP); assert.equal(value.request_key, KEY); assert.equal(value.action, action);
    assert.equal(h.calls.at(-1).path, `/album-tops/${TOP}/${action}`);
    assert.deepEqual(h.calls.at(-1).options.body, {...data, revision: '7', request_key: KEY});
    assert.equal(h.calls.at(-1).options.method, 'POST');
  }
});

test('copy adapter requires a fresh destination and exact source identity/revision acknowledgement', async t => {
  const command = {top_ref: TOP, revision: '7', request_key: KEY, title: 'My copy'};
  const valid = receipt('copy', command, {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'});
  let payload = valid;
  const h = transportFixture(t, () => payload);
  const result = await h.providers.execute('copy', command, h.options());
  assert.equal(result.top_ref, COPY); assert.equal(result.source_top_ref, TOP); assert.equal(result.source_revision, '7');
  for (const patch of [{top_ref: TOP}, {source_top_ref: OTHER}, {source_revision: '8'},
    {source_revision: undefined}, {request_key: id(91)}, {action: 'create'}, {revision: '0'}]) {
    payload = {...valid, ...patch};
    await assert.rejects(h.providers.execute('copy', command, h.options()), {status: 502});
  }
});

test('copy uncertainty cannot replay after known revocation until a newly initiated authorizing read', async t => {
  let allowed = true, delayedList = null, attempt = 0;
  const h = fixture(t, {
    list: () => delayedList ? delayedList.promise : {tops: [detail({can_copy: allowed})], allowed_actions: {[BROWSE]: true}},
    read: () => detail({can_copy: allowed}),
    execute(action, command) {if (++attempt === 1) throw error(502); return receipt(action, command,
      {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'});},
  });
  await h.controller.open(TOP); await h.controller.mutate('copy', {title: 'Stable copy'});
  delayedList = deferred(); const olderAllowedRead = h.controller.load();
  allowed = false; await h.controller.open(TOP);
  assert.equal(h.controller.canRetryMutation(), false);
  delayedList.resolve({tops: [detail({can_copy: true})], allowed_actions: {[BROWSE]: true}}); await olderAllowedRead;
  assert.equal(h.controller.canRetryMutation(), false, 'pre-revocation reads cannot restore retry authority');
  assert.equal(await h.controller.retryMutation(), false); assert.equal(h.calls.execute.length, 1);
  allowed = true; await h.controller.open(TOP);
  assert.equal(h.controller.canRetryMutation(), true);
  delayedList = null;
  assert.equal(await h.controller.retryMutation(), true);
  assert.deepEqual(h.calls.execute[1].command, h.calls.execute[0].command);
});

test('viewer edit request deduplicates pending submissions and does not invent an Editor grant', async t => {
  const pending = deferred();
  const h = fixture(t, {read: () => detail({can_view_sharing: true, can_request_edit: true, can_edit: false}), execute: () => pending.promise});
  await h.controller.open(TOP);
  const first = h.controller.mutate('request_edit');
  assert.equal(await h.controller.mutate('request_edit'), false);
  assert.equal(h.calls.execute.length, 1);
  pending.resolve(receipt('request_edit', h.calls.execute[0].command, {revision: '7', request_status: 'pending', request_ref: id(10)}));
  assert.equal(await first, true);
  assert.equal(h.controller.getSnapshot().detail.data.allowed_actions.can_edit, false);
  assert.equal(await h.controller.mutate('grant_editor', {account_id: 42, role: 'editor'}), false);
});

test('copy replies after navigation, actor/library reset and disposal never steal the current selection', async t => {
  for (const change of ['navigate', 'actor', 'library', 'dispose']) {
    const pending = deferred(), h = fixture(t, {execute: () => pending.promise});
    await h.controller.open(TOP);
    const copying = h.controller.mutate('copy', {title: 'Copied Top'});
    if (change === 'navigate') await h.controller.open(OTHER);
    if (change === 'actor' || change === 'library') h.controller.setScope(`${change}:replacement`);
    if (change === 'dispose') h.controller.dispose();
    pending.resolve(receipt('copy', h.calls.execute[0].command, {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'}));
    await copying;
    assert.equal(h.controller.getSnapshot().selectedTopRef, change === 'navigate' ? OTHER : null);
    if (change !== 'navigate') assert.equal(h.controller.getSnapshot().mutation.command, null);
  }
});

for (const method of ['readSharing', 'readAccessGrants', 'readAccessCandidates']) {
  test(`${method} rechecks the selected detail, resets and late replies through the real controller`, async t => {
    const pending = deferred(), reads = [];
    const data = method === 'readSharing' ? sharing() : method === 'readAccessGrants'
      ? {top_ref: TOP, revision: '7', visibility: 'server_shared', grants: [grant()], next_cursor: null}
      : {top_ref: TOP, revision: '7', candidates: [candidate()], next_cursor: null};
    const h = fixture(t, {read: ref => detail({can_view_sharing: true, can_share: true}, {top_ref: ref}),
      [method](ref, options) {reads.push({ref, options}); return pending.promise;}});
    await h.controller.open(TOP);
    const request = new AbortController(), reading = h.controller[method]({signal: request.signal, q: 'Member', cursor: 'page-two'});
    assert.equal(reads[0].ref, TOP); assert.equal(reads[0].options.scopeKey, SCOPE);
    assert.equal(reads[0].options.cursor, 'page-two');
    await h.controller.open(OTHER);
    pending.resolve(data); const retired = await reading;
    assert.notEqual(retired.status, 'ready'); assert.equal(retired.data, null);
    h.controller.setScope('different:actor:library');
    assert.notEqual((await h.controller[method]({})).status, 'ready');
    assert.equal(reads.length, 1);
  });
}

test('private anonymous scope cannot read sharing or issue request/copy commands', async t => {
  const h = fixture(t);
  h.controller.setScope(null);
  for (const method of ['readSharing', 'readAccessGrants', 'readAccessCandidates']) {
    assert.notEqual((await h.controller[method]({})).status, 'ready');
  }
  for (const action of ['request_edit', 'copy', 'visibility', 'grant_editor', 'revoke_editor', 'decide_edit_request']) {
    assert.equal(await h.controller.mutate(action), false);
  }
  assert.equal(h.calls.execute.length, 0); assert.equal(h.calls.reads.length, 0);
});

for (const [action, field, data] of [['copy', 'can_copy', {title: 'Exact sharing-gated copy'}],
  ['visibility', 'can_manage', {visibility: 'private'}]]) {
  test(`explicit Sharing ${field} denial blocks uncertain ${action} until a newly initiated authorized read`, async t => {
    const reads = []; let attempt = 0;
    const h = fixture(t, {
      read: () => detail({can_copy: true, can_share: true, can_view_sharing: true}),
      readSharing(_ref, options) {const request = deferred(); reads.push({...request, options}); return request.promise;},
      execute(kind, command) {
        if (++attempt === 1) throw error(502);
        return receipt(kind, command, kind === 'copy' ? {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'} : {});
      },
    });
    await h.controller.open(TOP); await h.controller.mutate(action, data);
    const original = JSON.parse(JSON.stringify(h.controller.getSnapshot().mutation.command));
    assert.equal(h.controller.canRetryMutation(), true);
    const olderAllow = h.controller.readSharing({}), denial = h.controller.readSharing({});
    reads[1].resolve(sharing({[field]: false})); await denial;
    assert.equal(h.controller.canRetryMutation(), false);
    assert.equal(await h.controller.retryMutation(), false); assert.equal(h.calls.execute.length, 1);
    reads[0].resolve(sharing({[field]: true})); await olderAllow;
    assert.equal(h.controller.canRetryMutation(), false, 'an allow already in flight at denial observation cannot restore authority');
    const unknown = h.controller.readSharing({}), incomplete = sharing(); delete incomplete[field];
    reads[2].resolve(incomplete); await unknown;
    assert.equal(h.controller.canRetryMutation(), false, 'missing Sharing evidence is not a new grant');
    assert.deepEqual(h.controller.getSnapshot().mutation.command, original);
    const freshAllow = h.controller.readSharing({}); reads[3].resolve(sharing({[field]: true})); await freshAllow;
    assert.equal(h.controller.canRetryMutation(), true);
    assert.equal(await h.controller.retryMutation(), true);
    assert.equal(h.calls.keys.length, 1);
    assert.deepEqual(h.calls.execute[1].command, original);
  });
}

for (const [action, field, data] of [['copy', 'can_copy', {title: 'New copy'}],
  ['visibility', 'can_manage', {visibility: 'private'}], ['request_edit', 'can_request_edit', {}]]) {
  test(`latest Sharing ${field} denial governs new ${action} commands and cannot be undone by old or unknown evidence`, async t => {
    const reads = [];
    const h = fixture(t, {read: () => detail({can_view_sharing: true, can_copy: true, can_share: true, can_request_edit: true}),
      readSharing() {const request = deferred(); reads.push(request); return request.promise;},
      execute(kind, command) {return receipt(kind, command, kind === 'copy'
        ? {top_ref: COPY, revision: '1', source_top_ref: TOP, source_revision: '7'} : {});}});
    await h.controller.open(TOP);
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), true);
    const oldAllow = h.controller.readSharing({}), newerDeny = h.controller.readSharing({});
    reads[1].resolve(sharing({[field]: false})); await newerDeny;
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), false);
    assert.equal(await h.controller.mutate(action, data), false);
    reads[0].resolve(sharing({[field]: true})); await oldAllow;
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), false, 'a read begun before the denial cannot re-enable controls or commands');
    const unknown = h.controller.readSharing({}), missing = sharing(); delete missing[field];
    reads[2].resolve(missing); await unknown;
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), false);
    assert.equal(await h.controller.mutate(action, data), false);
    assert.equal(h.calls.execute.length, 0); assert.equal(h.calls.keys.length, 0);
    const fresh = h.controller.readSharing({}); reads[3].resolve(sharing({[field]: true})); await fresh;
    assert.equal(albumTopActionAllowed(h.controller.getSnapshot(), action), true);
    assert.equal(await h.controller.mutate(action, data), true);
    assert.equal(h.calls.execute.length, 1); assert.equal(h.calls.keys.length, 1);
  });
}
