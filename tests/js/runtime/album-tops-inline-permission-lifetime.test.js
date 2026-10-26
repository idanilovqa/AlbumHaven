'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const PRIVATE_TITLE = 'Unsaved private title', PRIVATE_SUBTITLE = 'Unsaved private subtitle';

async function fixture(t) {
  const env = actualChoiceEnvironment({inlineNavigation: true}), reads = {gate: null, error: null};
  const backend = N.service({read: async ref => {
    if (reads.error) throw reads.error;
    if (reads.gate) return reads.gate.promise;
    return {...backend.data.detail, top_ref: ref};
  }});
  const controller = await N.preparedController(backend, {scopeKey: env.runtime.snapshot().scopeKey});
  // This observer precedes both the parent view and its detached draft listener.
  const notificationProbe = {observe: null};
  const unsubscribeProbe = controller.subscribe(() => notificationProbe.observe?.(controller.getSnapshot()));
  const registrations = [], actualRegister = env.runtime.registerDraftNavigation;
  env.runtime.registerDraftNavigation = options => {
    const release = actualRegister(options), record = {options, release, releases: 0}; registrations.push(record);
    if (typeof release !== 'function') return release;
    return () => {record.releases++; return release();};
  };
  const owner = await N.connectedView(env, backend, controller);
  t.after(async () => {unsubscribeProbe(); owner.dispose(); await settle(); env.assertClean();
    assert.ok(registrations.every(record => record.releases === 1), 'each genuine draft lease released exactly once');});
  env.click(env.button(env.host, 'Edit Album Top'));
  const form = env.host.querySelector('form.album-top-inline-edit'); assert.ok(form);
  const title = form.querySelector('[name="top-name"]'), subtitle = form.querySelector('[name="top-subtitle"]');
  env.input(title, PRIVATE_TITLE); env.input(subtitle, PRIVATE_SUBTITLE);
  const submit = form.listeners.find(row => row.type === 'submit').callback;
  assert.equal(registrations.length, 1); assert.equal(registrations[0].options.isCurrent(), true);
  return {...env, backend, controller, owner, reads, registrations, notificationProbe, form, title, subtitle, submit,
    async noStaleWrite() {await submit({preventDefault() {}}); await settle(); assert.equal(backend.count('execute'), 0);},
    assertPrivateGone() {assert.equal(form.isConnected, false); assert.doesNotMatch(env.document.body.textContent, /Unsaved private (title|subtitle)/);
      assert.equal(registrations[0].releases, 1); assert.equal(registrations[0].options.isCurrent(), false);},
  };
}
async function declineDeparture(f) {
  let departures = 0;
  const pending = f.runtime.deferDraftNavigation(() => {departures++; return true;}); await settle();
  assert.equal(f.document.getElementById('app-confirm-modal').hidden, false);
  assert.equal(departures, 0); f.click(f.document.getElementById('app-confirm-cancel'));
  assert.equal(await pending, false); await settle();
  assert.equal(departures, 0); assert.equal(f.form.isConnected, true); assert.equal(f.title.value, PRIVATE_TITLE);
  assert.equal(f.registrations[0].releases, 0); assert.equal(f.backend.count('execute'), 0);
}

test('readable edit-permission loss retains exact disabled fields and the same dirty navigation lease through fresh restoration', async t => {
  const f = await fixture(t), lease = f.registrations[0];
  f.reads.gate = N.deferred(); const refreshing = f.controller.open(N.TOP);
  assert.equal(f.form.isConnected, true); assert.equal(f.title.disabled, true);
  assert.equal(lease.releases, 0); assert.equal(lease.options.isCurrent(), true);
  await f.noStaleWrite();
  f.backend.data.detail = N.detail({allowed_actions: {...N.permissions(), can_edit: false}});
  f.reads.gate.resolve(f.backend.data.detail); await refreshing; f.reads.gate = null; await settle();
  assert.equal(f.host.querySelector('form.album-top-inline-edit'), f.form);
  assert.equal(f.form.querySelector('[name="top-name"]'), f.title); assert.equal(f.subtitle.value, PRIVATE_SUBTITLE);
  assert.equal(f.title.value, PRIVATE_TITLE); assert.equal(f.title.disabled, true); assert.equal(f.subtitle.disabled, true);
  assert.equal(f.button(f.form, 'Save').disabled, true); assert.equal(f.button(f.form, 'Cancel').disabled, false);
  assert.equal(lease.options.isCurrent(), true); assert.equal(lease.releases, 0); await f.noStaleWrite();
  await declineDeparture(f);
  f.backend.data.detail = N.detail(); await f.controller.open(N.TOP); await settle();
  assert.equal(f.form.isConnected, true); assert.equal(f.title.value, PRIVATE_TITLE); assert.equal(f.subtitle.value, PRIVATE_SUBTITLE);
  assert.equal(f.title.disabled, false); assert.equal(f.button(f.form, 'Save').disabled, false);
  assert.equal(f.registrations.length, 1); assert.equal(lease.releases, 0); assert.equal(lease.options.isCurrent(), true);
  assert.equal(f.backend.count('execute'), 0);
});

for (const permitted of [false, true]) test(`native snapshot before draft refresh preserves the same-revision navigation lease with can_edit:${permitted}`, async t => {
  const f = await fixture(t), lease = f.registrations[0], observed = [];
  f.reads.gate = N.deferred(); const refreshing = f.controller.open(N.TOP);
  assert.equal(f.title.disabled, true); assert.equal(lease.releases, 0);
  f.notificationProbe.observe = current => {
    if (current.detail.status !== 'ready') return;
    // The previous loading render is still painted: neither parent nor draft
    // has consumed this ready notification. Query the real global owner now.
    assert.equal(f.title.disabled, true);
    assert.equal(lease.options.isCurrent(), true);
    f.runtime.snapshot();
    observed.push({revision: current.detail.data.revision, releases: lease.releases});
  };
  f.reads.gate.resolve(N.detail({allowed_actions: {...N.permissions(), can_edit: permitted}}));
  await refreshing; f.reads.gate = null; f.notificationProbe.observe = null; await settle();
  assert.deepEqual(observed, [{revision: '7', releases: 0}]);
  assert.equal(f.form.isConnected, true); assert.equal(f.title.value, PRIVATE_TITLE);
  assert.equal(f.title.disabled, !permitted); assert.equal(f.button(f.form, 'Save').disabled, !permitted);
  assert.equal(f.registrations.length, 1); assert.equal(lease.releases, 0);
  await declineDeparture(f);
});

test('permission-revoked readable dirty Edit uses genuine decline then accepted discard without a write', async t => {
  const f = await fixture(t);
  f.backend.data.detail = N.detail({allowed_actions: {...N.permissions(), can_edit: false}});
  await f.controller.open(N.TOP); await settle(); await declineDeparture(f);
  f.click(f.button(f.form, 'Cancel')); await settle();
  assert.equal(f.document.getElementById('app-confirm-modal').hidden, false);
  f.click(f.document.getElementById('app-confirm-accept')); await settle();
  f.assertPrivateGone(); await f.noStaleWrite(); assert.equal(f.backend.count('execute'), 0);
});

test('fresh readable edit restoration saves the retained text once and releases only after the acknowledged refresh', async t => {
  const f = await fixture(t), lease = f.registrations[0];
  f.backend.data.detail = N.detail({allowed_actions: {...N.permissions(), can_edit: false}});
  await f.controller.open(N.TOP); await settle(); await f.noStaleWrite();
  f.backend.data.detail = N.detail(); await f.controller.open(N.TOP); await settle();
  assert.equal(f.title.value, PRIVATE_TITLE); assert.equal(f.button(f.form, 'Save').disabled, false);
  f.reads.gate = N.deferred(); f.form.dispatchEvent(new f.context.Event('submit')); await settle();
  const writes = f.backend.calls.filter(call => call.method === 'execute'); assert.equal(writes.length, 1);
  const [action, command] = writes[0].args;
  assert.equal(action, 'save'); assert.equal(command.top_ref, N.TOP); assert.equal(command.revision, '7');
  assert.equal(command.title, PRIVATE_TITLE); assert.equal(command.description, PRIVATE_SUBTITLE);
  assert.equal(f.controller.getSnapshot().mutation.status, 'ready');
  assert.equal(f.controller.getSnapshot().mutation.refreshing, true);
  assert.equal(f.form.isConnected, true); assert.equal(f.title.disabled, true); assert.equal(f.button(f.form, 'Save').disabled, true);
  assert.equal(lease.releases, 0); assert.equal(lease.options.isCurrent(), true); f.runtime.snapshot();
  assert.equal(await f.runtime.deferDraftNavigation(() => assert.fail('Acknowledged refresh must finish first')), false);
  assert.equal(f.document.getElementById('app-confirm-modal').hidden, true);
  f.reads.gate.resolve(N.detail({revision: '8', title: PRIVATE_TITLE, description: PRIVATE_SUBTITLE}));
  await settle(); f.reads.gate = null;
  assert.equal(f.form.isConnected, false); assert.equal(lease.releases, 1); assert.equal(lease.options.isCurrent(), false);
  assert.equal(f.host.querySelector('.gallery-bar__title').textContent, PRIVATE_TITLE);
  await f.submit({preventDefault() {}}); await settle(); assert.equal(f.backend.count('execute'), 1);
  assert.equal(f.runtime.deferDraftNavigation(() => assert.fail('Saved owner cannot replay')), false);
});

for (const permission of ['library.browse.read', 'can_read']) test(`ready same-revision ${permission} denial removes private Edit and cannot revive automatically`, async t => {
  const f = await fixture(t);
  f.backend.data.detail = N.detail({allowed_actions: {...N.permissions(), [permission]: false}});
  await f.controller.open(N.TOP); await settle();
  assert.equal(f.controller.getSnapshot().detail.status, 'ready');
  assert.equal(f.controller.getSnapshot().detail.data.revision, '7'); f.assertPrivateGone(); await f.noStaleWrite();
  f.backend.data.detail = N.detail(); await f.controller.open(N.TOP); await settle();
  assert.equal(f.host.querySelector('form.album-top-inline-edit'), null); await f.noStaleWrite();
  f.click(f.button(f.host, 'Edit Album Top')); await settle();
  const reopened = f.host.querySelector('form.album-top-inline-edit'); assert.ok(reopened); assert.notEqual(reopened, f.form);
  assert.equal(reopened.querySelector('[name="top-name"]').value, 'Curated Top');
});

for (const status of [401, 403]) test(`actual ${status} read denial removes private Edit and old callbacks cannot revive after reauthorization`, async t => {
  const f = await fixture(t); f.reads.error = Object.assign(new Error('Synthetic read denial'), {status});
  assert.equal(await f.controller.open(N.TOP), false); await settle();
  assert.equal(f.controller.getSnapshot().detail.status, 'denied'); f.assertPrivateGone(); await f.noStaleWrite();
  f.reads.error = null; await f.controller.load(); await f.controller.open(N.TOP); await settle();
  assert.equal(f.host.querySelector('form.album-top-inline-edit'), null); await f.noStaleWrite();
});

test('ordinary read error is not a terminal denial and cannot authorize a stale Save', async t => {
  const f = await fixture(t); f.reads.error = new TypeError('Synthetic network failure');
  assert.equal(await f.controller.open(N.TOP), false); await settle();
  assert.equal(f.controller.getSnapshot().detail.status, 'error'); assert.equal(f.form.isConnected, true);
  assert.equal(f.title.value, PRIVATE_TITLE); assert.equal(f.title.disabled, true);
  assert.equal(f.registrations[0].options.isCurrent(), true); assert.equal(f.registrations[0].releases, 0);
  await f.noStaleWrite(); await declineDeparture(f);
  f.reads.error = null; await f.controller.open(N.TOP); await settle();
  assert.equal(f.title.disabled, false); assert.equal(f.button(f.form, 'Save').disabled, false);
});

for (const boundary of ['actor-scope', 'selected-Top', 'provider']) test(`${boundary} replacement destroys private Edit and stale submit stays inert after restoration`, async t => {
  const f = await fixture(t), scope = f.controller.getSnapshot().scopeKey;
  if (boundary === 'actor-scope') {
    f.document.getElementById('app-shell').dataset.nativeAccountId = 'other-account';
    f.runtime.sync(); f.controller.setScope(f.runtime.snapshot().scopeKey);
  } else if (boundary === 'selected-Top') await f.controller.open(N.OTHER);
  else f.owner.update({providers: N.service().providers});
  await settle(); f.assertPrivateGone(); await f.noStaleWrite();
  if (boundary === 'actor-scope') {
    f.document.getElementById('app-shell').dataset.nativeAccountId = 'account:one'; f.runtime.sync(); f.controller.setScope(scope); await f.controller.load();
  } else if (boundary === 'provider') f.owner.update({providers: f.backend.providers});
  await f.controller.open(N.TOP); await settle();
  assert.equal(f.host.querySelector('form.album-top-inline-edit'), null); await f.noStaleWrite();
});

test('confirmed different revision remains stale and cannot restore its spent Save lease through revision ABA', async t => {
  const f = await fixture(t); f.backend.data.detail = N.detail({revision: '8'});
  await f.controller.open(N.TOP); await settle();
  assert.equal(f.form.isConnected, true); assert.equal(f.title.value, PRIVATE_TITLE); assert.equal(f.title.disabled, true);
  assert.equal(f.button(f.form, 'Save').disabled, true); assert.equal(f.registrations[0].releases, 1); await f.noStaleWrite();
  f.backend.data.detail = N.detail(); await f.controller.open(N.TOP); await settle();
  assert.equal(f.form.isConnected, true); assert.equal(f.title.disabled, true); assert.equal(f.button(f.form, 'Save').disabled, true);
  await f.noStaleWrite(); assert.equal(f.registrations.length, 1);
  assert.equal(f.registrations[0].releases, 1);
  assert.equal(f.runtime.deferDraftNavigation(() => assert.fail('Spent revision lease cannot return')), false);
});

for (const boundary of ['library.browse.read', 'can_read', 'scope', 'Top', 401, 403]) test(`actual draft model ${boundary} retirement scrubs authored state and cannot recover by ABA`, async () => {
  const {createAlbumTopDraft} = await N.load('album-tops/draft.mjs');
  const f = F.controllerFixture(F.state({editing: true})), draft = createAlbumTopDraft({controller: f.controller});
  try {
    draft.edit({title: PRIVATE_TITLE, description: PRIVATE_SUBTITLE}); const before = f.controller.getSnapshot();
    if (typeof boundary === 'number') f.controller.observeDenial(F.SCOPE, Object.assign(new Error('Synthetic denial'), {status: boundary}));
    else if (boundary === 'scope') f.replace({...before, scopeKey: 'another-scope'});
    else if (boundary === 'Top') f.replace({...before, selectedTopRef: F.OTHER});
    else f.replace({...before, detail: {...before.detail, data: {...before.detail.data,
      allowed_actions: {...before.detail.data.allowed_actions, [boundary]: false}}}});
    assert.equal(draft.isRetired(), true); assert.equal(draft.getSnapshot().denied, true);
    assert.equal(draft.getSnapshot().title, ''); assert.equal(draft.getSnapshot().description, '');
    assert.deepEqual(draft.getSnapshot().items, []); assert.equal(draft.getSnapshot().query, '');
    f.replace(before); assert.equal(draft.isRetired(), true); assert.equal(draft.edit({title: 'Replay'}), false);
    assert.equal(await draft.submit(), false); assert.deepEqual(f.calls, []); assert.equal(draft.getSnapshot().title, '');
  } finally {draft.dispose();}
});
