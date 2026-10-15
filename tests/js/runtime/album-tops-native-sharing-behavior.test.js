'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {id, TOP, SCOPE, deferred, drain, sharing, service, preparedController, nativeEnvironment, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

async function opened(backend) {
  const env = nativeEnvironment(), controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  env.click(env.button(env.host, 'Share')); await drain(); return {...env, controller, owner};
}

test('actual sharing query ownership aborts and rejects an older candidate page', async () => {
  const old = deferred(), next = deferred(), backend = service({readAccessCandidates: (_ref, options) => options.q ? next.promise : old.promise});
  const env = await opened(backend);
  try {
    const input = env.content().querySelector('input[type="search"]'); assert.ok(input); env.input(input, 'Ada'); await drain();
    const reads = backend.calls.filter(row => row.method === 'readAccessCandidates'); assert.equal(reads.length, 2); assert.equal(reads[0].args[1].signal.aborted, true);
    const candidate = name => ({account_ref: id(40), account_id: 40, display_name: name, username_display: null, grant_ref: null, role: null, allowed_actions: {can_grant_viewer: true, can_grant_editor: true}});
    next.resolve({top_ref: TOP, revision: '7', candidates: [candidate('Current Ada')], next_cursor: null}); await drain();
    old.resolve({top_ref: TOP, revision: '7', candidates: [candidate('Stale private member')], next_cursor: null}); await drain();
    assert.match(env.content().textContent, /Current Ada/); assert.doesNotMatch(env.content().textContent, /Stale private member/);
    assert.equal(env.content().querySelector('input[type="search"]'), input);
    env.click(env.button(env.content(), 'Add access')); await drain();
    const write = backend.calls.find(row => row.method === 'execute'); assert.equal(write.args[0], 'grant_viewer'); assert.equal(write.args[1].account_id, 40); assert.equal(write.args[1].role, 'viewer');
  } finally {env.owner.dispose();}
  env.assertClean();
});

test('sharing page cursor uses the actual reader and repeated next cursor is disabled', async () => {
  const backend = service({readSharing: (_ref, options) => Promise.resolve(sharing({next_pending_cursor: 'page-2'}))});
  const env = await opened(backend);
  try {
    env.click(env.button(env.content(), 'More edit requests')); await drain();
    const reads = backend.calls.filter(row => row.method === 'readSharing'); assert.equal(reads.length, 2); assert.equal(reads[1].args[1].cursor, 'page-2');
    const more = env.button(env.content(), 'More edit requests'); assert.equal(more.disabled, true); env.click(more); await drain(); assert.equal(backend.count('readSharing'), 2);
    env.click(env.button(env.content(), 'First edit requests page')); await drain();
    assert.equal(backend.calls.filter(row => row.method === 'readSharing')[2].args[1].cursor, null);
  } finally {env.owner.dispose();}
  env.assertClean();
});

test('a conflicting actual access page disables access writes and offers authoritative refresh', async () => {
  const backend = service({readAccessCandidates: () => Promise.resolve({top_ref: TOP, revision: '6', next_cursor: null,
    candidates: [{account_ref: id(40), account_id: 40, display_name: 'Member', username_display: null, grant_ref: null, role: null, allowed_actions: {can_grant_viewer: true, can_grant_editor: true}}]})});
  const env = await opened(backend);
  try {
    assert.match(env.content().textContent, /changed. Refresh it before editing access/);
    const add = env.button(env.content(), 'Add access'); assert.equal(add.disabled, true); env.click(add); assert.equal(backend.count('execute'), 0);
    const before = backend.count('read'); env.click(env.button(env.content(), 'Refresh Album Top')); await drain(); assert.equal(backend.count('read'), before + 1);
    assert.equal(backend.count('execute'), 0);
  } finally {env.owner.dispose();}
  env.assertClean();
});

test('denied actual sharing read closes private content and late candidate data cannot return', async () => {
  const candidates = deferred(), grants = deferred(), backend = service({readAccessCandidates: () => candidates.promise, readAccessGrants: () => grants.promise});
  const env = await opened(backend);
  try {
    grants.reject(Object.assign(new Error('Access denied'), {status: 403})); await drain();
    assert.equal(env.controller.getSnapshot().directory.status, 'denied'); assert.equal(env.controller.getSnapshot().detail.status, 'denied');
    assert.equal(env.modal().hidden, true); assert.equal(env.content().textContent, '');
    const signal = backend.calls.find(row => row.method === 'readAccessCandidates').args[1].signal; assert.equal(signal.aborted, true);
    candidates.resolve({top_ref: TOP, revision: '7', candidates: [{display_name: 'Late private name'}], next_cursor: null}); await drain();
    assert.doesNotMatch(env.document.body.textContent, /Late private name/); assert.equal(env.opens.length, 1);
  } finally {env.owner.dispose();}
  env.assertClean();
});

test('scope retirement closes actual sharing owner and aborts all outstanding page requests', async () => {
  const gate = deferred(), backend = service({readSharing: () => gate.promise}), env = await opened(backend);
  try {
    env.controller.setScope(`${SCOPE}:new`); await drain(); assert.equal(env.modal().hidden, true);
    assert.equal(backend.calls.find(row => row.method === 'readSharing').args[1].signal.aborted, true);
    gate.resolve(sharing()); await drain(); assert.equal(env.content().textContent, ''); assert.equal(env.opens.length, 1);
  } finally {env.owner.dispose();}
  env.assertClean();
});
