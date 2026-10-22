'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
let createAlbumTopController;
test.before(async () => {({createAlbumTopController} = await F.load('album-tops/model.mjs'));});
const rejected = (status, code = 'remote_preparation_unavailable') => Object.assign(new Error(code), {status, code});
async function fixture(t, options = {}) {
  const api = F.service(options); let keys = 0;
  const controller = createAlbumTopController({providers: api.providers, requestKey: () => F.id(100 + ++keys)});
  t.after(() => controller.dispose()); controller.setScope(F.SCOPE); await controller.load(); await controller.open(F.TOP);
  return {api, controller, keys: () => keys};
}
const selection = () => ({kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION});
const intent = action => action === 'create' ? {title: 'Remote creation', description: '', draft_ref: F.id(91), selections: [selection()]}
  : action === 'add' ? {selections: [selection()]}
    : action === 'save' ? {title: 'Remote edit', description: '', item_selections: F.mixed().edit_draft.item_selections}
      : action === 'remove' ? {album_refs: [F.B]} : action === 'reorder' ? {album_refs: [F.B, F.A]} : {};

for (const action of ['create', 'add', 'save', 'remove', 'reorder', 'copy']) {
  for (const status of [400, 403, 409]) test(`unknown remote ${action} followed by ${status} retains exact recovery owner until a fresh authorized read`, async t => {
    let attempts = 0;
    const f = await fixture(t, {handlers: {execute: (kind, command) => {
      if (++attempts === 1) throw new TypeError('Acknowledgment lost');
      if (attempts === 2) throw rejected(status);
      return F.receipt(kind, command);
    }}});
    if (action === 'create') await f.controller.open(null);
    const payload = intent(action), original = F.clone(payload);
    assert.equal(await f.controller.mutate(action, payload), false);
    const first = F.clone(f.controller.getSnapshot().mutation.command);
    assert.equal(f.controller.getSnapshot().mutation.remoteMembership, true);
    assert.equal(f.controller.canRetryMutation(), true);
    payload.untrusted_replacement = 'must not enter the original command';
    assert.equal(await f.controller.retryMutation(), false);
    assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
    assert.deepEqual(f.controller.getSnapshot().mutation.command, first);
    assert.equal(f.controller.canRetryMutation(), false);
    assert.equal(await f.controller.retryMutation(), false); assert.equal(f.api.count('execute'), 2);
    await f.controller.load();
    if (action !== 'create') await f.controller.open(F.TOP);
    assert.equal(f.controller.canRetryMutation(), true);
    assert.equal(await f.controller.retryMutation(), true);
    const writes = f.api.calls.filter(row => row.method === 'execute');
    assert.equal(writes.length, 3); assert.equal(f.keys(), 1);
    for (const row of writes) assert.deepEqual(row.args.slice(0, 2), [action, first]);
    assert.equal(f.controller.getSnapshot().mutation.status, 'ready');
    assert.equal(f.controller.getSnapshot().mutation.remoteMembership, true);
    assert.equal(f.controller.getSnapshot().mutation.recovered, true);
    assert.deepEqual({...payload, untrusted_replacement: undefined}, {...original, untrusted_replacement: undefined});
  });
}

test('first definitive remote refusal is an error and never invents an uncertain prior write', async t => {
  const f = await fixture(t, {handlers: {execute: () => {throw rejected(409);}}});
  await f.controller.mutate('add', intent('add'));
  assert.equal(f.controller.getSnapshot().mutation.status, 'error');
  assert.equal(f.controller.canRetryMutation(), false); assert.equal(f.api.count('execute'), 1);
});

test('ordinary local unknown retry preserves existing definitive-refusal behavior', async t => {
  const local = F.detail(); local.allowed_actions.can_copy = true;
  let attempt = 0;
  const f = await fixture(t, {detail: local, handlers: {execute: () => {if (++attempt === 1) throw new Error('Lost reply'); throw rejected(409);}}});
  await f.controller.mutate('save', {title: 'Local title', description: ''}); await f.controller.retryMutation();
  assert.equal(f.controller.getSnapshot().mutation.remoteMembership, false);
  assert.equal(f.controller.getSnapshot().mutation.status, 'error'); assert.equal(f.controller.canRetryMutation(), false);
});

test('remote Save membership retry requires current Items authority but Manage-only metadata retry does not', async t => {
  const f = await fixture(t, {handlers: {execute: () => {throw new TypeError('Lost reply');}}});
  await f.controller.mutate('save', intent('save'));
  f.api.data.detail.allowed_actions[F.ITEMS] = false;
  await f.controller.load(); await f.controller.open(F.TOP);
  assert.equal(f.controller.canRetryMutation(), false);
  f.api.data.detail.allowed_actions[F.ITEMS] = true; await f.controller.open(F.TOP);
  assert.equal(f.controller.canRetryMutation(), true);
  f.controller.setScope('new-metadata-session'); await f.controller.load();
  f.api.data.detail = F.mixed({manageOnly: true}); await f.controller.open(F.TOP);
  await f.controller.mutate('save', {title: 'Metadata only', description: 'Preserved membership'});
  assert.equal(f.controller.getSnapshot().mutation.remoteMembership, true);
  await f.controller.open(F.TOP);
  assert.equal(f.controller.canRetryMutation(), true);
  assert.deepEqual(Object.keys(f.controller.getSnapshot().mutation.command).sort(),
    ['title', 'description', 'request_key', 'top_ref', 'revision'].sort());
});

test('remote classification is captured before synchronous source-retirement callbacks erase current remote evidence', async t => {
  const local = F.detail(); local.allowed_actions.can_copy = true; local.allowed_actions.can_view_sharing = true;
  const gate = F.deferred(); let eraseRemote;
  const f = await fixture(t, {detail: local, handlers: {
    readPublicationSources: (_top, _item, options) => {options.signal.addEventListener('abort', () => eraseRemote(), {once: true}); return gate.promise;},
    execute: () => {throw new TypeError('Lost reply');},
  }});
  await f.controller.readSharing();
  const reading = f.controller.readPublicationSources(F.IA);
  assert.equal(f.api.count('readPublicationSources'), 1);
  const detail = f.controller.getSnapshot().detail.data;
  detail.items[1].source_kind = 'remote_summary';
  let retired = 0;
  eraseRemote = () => {retired++; delete detail.items[1].source_kind;};
  await f.controller.mutate('copy');
  assert.equal(retired, 1); assert.equal(detail.items[1].source_kind, undefined);
  assert.equal(f.controller.getSnapshot().mutation.remoteMembership, true);
  assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
  gate.resolve({}); await reading;
  f.api.control.execute = () => {throw rejected(409);};
  await f.controller.retryMutation();
  assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain', 'captured remote recovery survives mutable source retirement');
});

test('scope change during retirement prevents the captured command from dispatching', async t => {
  const local = F.detail(); local.allowed_actions.can_copy = true; local.allowed_actions.can_view_sharing = true;
  const gate = F.deferred(); let changeScope;
  const f = await fixture(t, {detail: local, handlers: {readPublicationSources: (_top, _item, options) => {
    options.signal.addEventListener('abort', () => changeScope(), {once: true}); return gate.promise;
  }}});
  await f.controller.readSharing(); const reading = f.controller.readPublicationSources(F.IA);
  changeScope = () => f.controller.setScope('replacement-account');
  await f.controller.mutate('copy');
  assert.equal(f.api.count('execute'), 0); assert.equal(f.controller.getSnapshot().scopeKey, 'replacement-account');
  assert.equal(f.controller.getSnapshot().mutation.status, 'idle'); gate.resolve({}); await reading;
});

test('recovered remote Copy refreshes directory only and never opens the copy or replaces a newer selection', async t => {
  let attempt = 0;
  const f = await fixture(t, {handlers: {execute: (action, command) => {
    if (++attempt === 1) throw new TypeError('Lost Copy reply');
    return F.receipt(action, command, {top_ref: F.id(99)});
  }}});
  await f.controller.mutate('copy'); await f.controller.open(F.OTHER);
  const reads = f.api.count('read'), lists = f.api.count('list');
  await f.controller.retryMutation();
  assert.equal(f.api.count('list'), lists + 1); assert.equal(f.api.count('read'), reads);
  assert.equal(f.controller.getSnapshot().selectedTopRef, F.OTHER);
  assert.equal(f.controller.getSnapshot().mutation.data.top_ref, F.id(99));
  assert.equal(f.controller.getSnapshot().mutation.recovered, true);
});

test('synchronous retirement callback cannot enqueue a nested mutation or overwrite the captured recovery owner', async t => {
  const local = F.detail(); local.allowed_actions.can_copy = true; local.allowed_actions.can_view_sharing = true;
  const gate = F.deferred(); let reenter, nested;
  const f = await fixture(t, {detail: local, handlers: {
    readPublicationSources: (_top, _item, options) => {options.signal.addEventListener('abort', () => reenter(), {once: true}); return gate.promise;},
    execute: () => {throw new TypeError('Outer Copy reply lost');},
  }});
  await f.controller.readSharing(); const reading = f.controller.readPublicationSources(F.IA);
  f.controller.getSnapshot().detail.data.items[1].source_kind = 'remote_summary';
  reenter = () => {nested = f.controller.mutate('save', {title: 'Nested replacement', description: ''});};
  await f.controller.mutate('copy');
  assert.equal(await nested, false); assert.equal(f.api.count('execute'), 1); assert.equal(f.keys(), 1);
  assert.equal(f.api.last('execute').args[0], 'copy');
  assert.equal(f.controller.getSnapshot().mutation.action, 'copy');
  assert.equal(f.controller.getSnapshot().mutation.remoteMembership, true);
  assert.equal(f.controller.getSnapshot().mutation.status, 'uncertain');
  gate.resolve({}); await reading;
});
