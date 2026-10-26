'use strict';
// Source-authored, unrun. Native controls/app/index and real setting provider +
// controller are exercised through a fixture HTTP boundary, not a live service.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const {readRepo} = require('./native-home-harness.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');
const marker = 'a'.repeat(64), path = '/account/album-top-listening-settings';
const data = (target = 5, revision = '1') => ({completed_target: target, settings_revision: revision, preference_status: revision === '1' ? 'default' : 'saved'});
const response = (value = data(), context = marker) => ({ok: true, status: 200, json: async () => ({status: 'ready', data: value, context_ref: context, context_scope: 'album-top-settings-v1'})});
const rejection = (status, error) => ({ok: false, status, json: async () => ({ok: false, error})});
function http(...steps) {
  const calls = [], queue = [...steps];
  return {calls, queue, fetch(url, options) {
    calls.push({url, options}); assert.equal(url, path); assert.ok(queue.length, 'explicit fixture response for each request');
    const value = queue.shift(); return typeof value === 'function' ? value(url, options) : Promise.resolve(value);
  }};
}
async function control(t, wire, {current = () => true} = {}) {
  const env = N.nativeEnvironment();
  const {createListeningSettingsProvider} = await N.load('album-tops/listening-settings-provider.mjs');
  const {createListeningSettingsController} = await N.load('album-tops/listening-settings-model.mjs');
  const {mountListeningSettingsControl} = await N.load('album-tops/listening-settings-control.mjs');
  const provider = createListeningSettingsProvider({fetch: wire.fetch, isCurrent: current});
  const controller = createListeningSettingsController({provider, isCurrent: current});
  const owner = mountListeningSettingsControl(env.host, env.runtime, controller);
  t.after(() => {owner.dispose(); controller.dispose(); env.assertClean();});
  return {...env, controller, wire, owner, inputTarget: () => env.host.querySelector('input')};
}

test('native target loading and acknowledged save use exact account wire without fake metrics', async t => {
  const pending = N.deferred(), saved = N.deferred(), wire = http(() => pending.promise, () => saved.promise);
  const f = await control(t, wire), loading = f.controller.load();
  assert.equal(f.inputTarget().disabled, true); assert.match(f.host.textContent, /Loading listening target/);
  pending.resolve(response()); await loading;
  assert.equal(f.inputTarget().value, '5'); assert.equal(f.inputTarget().disabled, false);
  assert.deepEqual(f.controller.presentation(), {status: 'default', value: 5, revision: '1'});
  assert.equal(wire.calls[0].options.headers['X-AlbumHaven-Context'], undefined);
  assert.equal(wire.calls[0].options.headers['X-AlbumHaven-Account-Context'], undefined);
  f.input(f.inputTarget(), '7'); f.click(f.button(f.host, 'Save target'));
  assert.equal(f.inputTarget().disabled, true); assert.equal(f.controller.presentation().status, 'unavailable');
  assert.deepEqual(JSON.parse(wire.calls[1].options.body), {completed_target: 7, settings_revision: '1'});
  assert.equal(wire.calls[1].options.headers['X-AlbumHaven-Account-Context'], marker);
  assert.equal(wire.calls[1].options.headers['X-AlbumHaven-Context'], undefined);
  assert.equal(wire.calls[1].options.credentials, 'same-origin'); assert.equal(wire.calls[1].options.redirect, 'error');
  saved.resolve(response(data(7, '2'))); await settle();
  assert.deepEqual(f.controller.presentation(), {status: 'saved', value: 7, revision: '2'});
  assert.match(f.host.textContent, /Listening target saved/); assert.equal(f.inputTarget().disabled, false);
  assert.equal(f.host.querySelector('.album-top-listening-status'), null);
});

test('native invalid target never saves and discard restores acknowledged preference', async t => {
  const f = await control(t, http(response())); await f.controller.load();
  for (const value of ['', '0', '-1', '1.5', '01', '9007199254740992']) {
    f.input(f.inputTarget(), value); assert.equal(f.button(f.host, 'Save target').disabled, true);
    assert.equal(f.inputTarget().getAttribute('aria-invalid'), 'true'); assert.equal(await f.controller.save(), false);
  }
  assert.equal(f.wire.calls.length, 1); f.click(f.button(f.host, 'Discard target edit'));
  assert.equal(f.inputTarget().value, '5'); assert.equal(f.controller.presentation().revision, '1');
});

test('native GET failure is recoverable without claiming a default receipt', async t => {
  const f = await control(t, http(() => Promise.reject(new TypeError('offline')), response()));
  await f.controller.load(); assert.equal(f.controller.presentation().status, 'unavailable');
  assert.match(f.host.textContent, /could not be loaded/); f.click(f.button(f.host, 'Retry loading target')); await settle();
  assert.equal(f.inputTarget().value, '5'); assert.equal(f.controller.getSnapshot().status, 'ready');
});

test('lost PUT plus same-revision GET remains unknown, explicit retry reads then CAS saves', async t => {
  const wire = http(response(data(5, '2')), () => Promise.reject(new TypeError('lost')), response(data(5, '2')),
    response(data(5, '2')), response(data(7, '3')));
  const f = await control(t, wire); await f.controller.load(); f.input(f.inputTarget(), '7');
  await f.controller.save();
  assert.equal(f.controller.getSnapshot().status, 'uncertain'); assert.equal(f.controller.presentation().status, 'unavailable');
  assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(f.button(f.host, 'Save target').disabled, true);
  f.click(f.button(f.host, 'Retry same target')); await settle();
  assert.deepEqual(wire.calls.map(call => call.options.method), ['GET', 'PUT', 'GET', 'GET', 'PUT']);
  assert.deepEqual(JSON.parse(wire.calls[4].options.body), {completed_target: 7, settings_revision: '2'});
  assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.controller.presentation().revision, '3');
});

test('a newer GET settles lost-write recovery without overwriting another acknowledged target', async t => {
  const wire = http(response(data(5, '2')), () => Promise.reject(new TypeError('lost')), response(data(5, '2')), response(data(9, '3')));
  const f = await control(t, wire); await f.controller.load(); f.input(f.inputTarget(), '7'); await f.controller.save();
  f.click(f.button(f.host, 'Retry same target')); await settle();
  assert.equal(f.inputTarget().value, '9'); assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(f.controller.presentation().value, 9); assert.match(f.host.textContent, /Review it/);
});

test('observing an unchanged no-op revision cannot fence an older different-target write', async t => {
  const wire = http(response(data(5, '2')), () => Promise.reject(new TypeError('lost')), response(data(5, '2')), response(data(5, '2')));
  const f = await control(t, wire); await f.controller.load(); f.input(f.inputTarget(), '7'); await f.controller.save();
  // A concurrent PUT of the existing 5 can return revision 2 without advancing
  // it. The next GET sees precisely that shape; it cannot prove our 7 failed.
  f.click(f.button(f.host, 'Check saved target')); await settle();
  assert.equal(f.controller.getSnapshot().status, 'uncertain'); assert.equal(f.controller.presentation().status, 'unavailable');
  f.controller.setDraft('5'); f.controller.resetDraft(); assert.equal(f.controller.getSnapshot().draft, '7');
  assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('conflict GET refreshes the real target, never retries a stale PUT', async t => {
  const f = await control(t, http(response(data(5, '2')), rejection(409, 'settings_revision_conflict'), response(data(8, '3'))));
  await f.controller.load(); f.input(f.inputTarget(), '7'); await f.controller.save();
  assert.equal(f.inputTarget().value, '8'); assert.equal(f.controller.presentation().revision, '3');
  assert.equal(f.wire.calls.length, 3); assert.equal(f.button(f.host, 'Save target').disabled, true);
});

for (const phase of ['read', 'save']) test(`native ${phase} permission denial retires setting values and actions`, async t => {
  const deny = {ok: false, status: 403, json() {assert.fail('denial body is not decoded');}};
  const f = await control(t, phase === 'read' ? http(deny) : http(response(data(5, '2')), deny));
  await f.controller.load(); if (phase === 'save') {f.input(f.inputTarget(), '7'); await f.controller.save();}
  assert.equal(f.controller.getSnapshot().status, 'denied'); assert.equal(f.inputTarget().value, '');
  assert.equal(f.inputTarget().disabled, true); assert.equal(f.controller.getSnapshot().data, null);
  assert.equal(f.controller.presentation().status, 'unavailable'); assert.equal(f.button(f.host, 'Check saved target').disabled, true);
});

test('teardown aborts pending save and late receipt cannot restore private controls', async t => {
  const late = N.deferred(), wire = http(response(), () => late.promise);
  const f = await control(t, wire); await f.controller.load(); f.input(f.inputTarget(), '7'); const saving = f.controller.save();
  f.owner.dispose(); f.controller.dispose(); assert.equal(wire.calls[1].options.signal.aborted, true);
  late.resolve(response(data(7, '2'))); await saving;
  assert.equal(f.host.textContent, ''); assert.equal(f.controller.getSnapshot().data, null);
});

test('native index owns target scope across account replacement and guest transition', async t => {
  const {mountAlbumTops} = await N.load('album-tops/index.mjs');
  const env = actualChoiceEnvironment(), shell = N.shell(env), service = N.service(), late = N.deferred();
  service.data.detail = F.detail();
  const wire = http(() => late.promise, response(data(8, '3'), 'b'.repeat(64))); env.context.fetch = wire.fetch;
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: service.providers});
  t.after(() => {owner.dispose(); env.assertClean();}); await settle();
  shell.change({scopeKey: 'another-account:session:library'}); await settle();
  assert.equal(wire.calls[0].options.signal.aborted, true);
  assert.equal(env.host.querySelector('input').value, '8');
  late.resolve(response(data(99, '4'))); await settle(); assert.equal(env.host.querySelector('input').value, '8');
  shell.change({authenticated: false, visible: false}); await settle();
  assert.equal(env.host.querySelector('input'), null); assert.equal(wire.calls.length, 2);
});

test('native index scope retirement during PUT ignores its later acknowledged value', async t => {
  const {mountAlbumTops} = await N.load('album-tops/index.mjs');
  const env = actualChoiceEnvironment(), shell = N.shell(env), service = N.service(), late = N.deferred();
  service.data.detail = F.detail(); const wire = http(response(), () => late.promise, response(data(8, '3'), 'b'.repeat(64))); env.context.fetch = wire.fetch;
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: service.providers});
  t.after(() => {owner.dispose(); env.assertClean();}); await settle();
  env.input(env.host.querySelector('input'), '7'); env.click(env.button(env.host, 'Save target'));
  shell.change({scopeKey: 'same-account:new-session:generation-2'}); await settle();
  assert.equal(wire.calls[1].options.signal.aborted, true);
  late.resolve(response(data(7, '2'))); await settle(); assert.equal(env.host.querySelector('input').value, '8');
});

test('real session-CSRF wrapper supplies PUT header without replaying an uncertain write', async t => {
  const env = N.nativeEnvironment(), calls = [];
  env.context.location = {href: 'https://albumhaven.example/', origin: 'https://albumhaven.example'};
  env.context.URL = URL; env.context.Headers = Headers; env.document.cookie = '__Host-album_haven_csrf=fixture-csrf-only';
  env.context.fetch = (url, options) => {calls.push({url, options}); return options.method === 'PUT'
    ? Promise.reject(new TypeError('lost')) : Promise.resolve(response(data(5, '2')));};
  vm.runInContext(readRepo('music_app/static/js/runtime/session-csrf-fetch.js'), env.context, {filename: 'session-csrf-fetch.js'});
  const {createListeningSettingsProvider} = await N.load('album-tops/listening-settings-provider.mjs');
  const provider = createListeningSettingsProvider({fetch: (...args) => env.context.fetch(...args), isCurrent: () => true});
  t.after(() => {provider.dispose(); env.assertClean();}); await provider.read();
  await assert.rejects(provider.save({completed_target: 7, settings_revision: '2'}), TypeError);
  const put = calls.filter(call => call.options.method === 'PUT'); assert.equal(put.length, 1);
  assert.equal(put[0].options.headers.get('X-Album-Haven-CSRF'), 'fixture-csrf-only');
  assert.equal(put[0].options.headers.get('X-AlbumHaven-Account-Context'), marker);
  assert.equal(put[0].options.headers.get('X-AlbumHaven-Context'), null);
});

function admitted(target, revision, source = F.detail()) {
  // Only synthetic admitted evidence, never produced by the live adapter.
  return {...source, top_viewer_overlay: {...source.top_viewer_overlay,
    item_listening_presentation: Object.fromEntries(source.items.map(row => [row.album_ref, {
      protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
      top_ref: source.top_ref, top_revision: source.revision, album_ref: row.album_ref,
      target, target_preference_revision: revision,
      predicates: {has_plays: true, listened: true, completed: true, rated: null},
      metrics: {full: {status: 'exact_recorded', value: 12}, partial: {status: 'exact_recorded', value: 3},
        tracks_at_target: {status: 'exact_recorded', value: 8}, uninterrupted_full: {status: 'exact_recorded', value: 2}},
    }]))}};
}

test('native saved-target rebind requires matching admitted value AND revision, independent counts survive', async t => {
  const env = actualChoiceEnvironment(), wire = http(response(data(5, '2')), response(data(7, '3')));
  const {createListeningSettingsProvider} = await N.load('album-tops/listening-settings-provider.mjs');
  const {createListeningSettingsController} = await N.load('album-tops/listening-settings-model.mjs');
  const settings = createListeningSettingsController({provider: createListeningSettingsProvider({fetch: wire.fetch, isCurrent: () => true}), isCurrent: () => true});
  const service = N.service(); service.data.detail = admitted(5, '2');
  const controller = await N.preparedController(service);
  const mounted = await N.connectedView(env, service, controller, {listeningSettingsController: settings});
  const release = settings.subscribe(() => mounted.update({}));
  t.after(() => {release(); mounted.dispose(); settings.dispose(); env.assertClean();}); await settings.load();
  const status = () => env.host.querySelector('.album-top-listening-status');
  const choose = value => {
    let trigger = env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith('Status:'));
    if (!trigger) {env.click(env.button(env.host, 'Filter')); trigger = env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith('Status:'));}
    env.click(trigger); env.click(env.document.querySelector(`[role="menu"][aria-label="Status"] [data-foobar-format="${value}"]`));
  };
  assert.equal(status().textContent, '12 full · 3 partial · 8 tracks at target'); choose('completed');
  assert.equal(env.host.querySelectorAll('.album-card').length, 2);
  env.input(env.host.querySelector('input'), '7');
  assert.equal(env.host.querySelectorAll('.album-card').length, 2); assert.match(env.host.textContent, /Not a confirmed filter match/);
  choose('all'); assert.equal(status().textContent, '12 full · 3 partial · ? tracks at target');
  await settings.save(); assert.equal(status().textContent, '12 full · 3 partial · ? tracks at target');
  service.data.detail = admitted(7, '2', F.detail({revision: '8'})); await controller.open(N.TOP);
  assert.equal(status().textContent, '12 full · 3 partial · ? tracks at target');
  service.data.detail = admitted(7, '3', F.detail({revision: '9'})); await controller.open(N.TOP);
  assert.equal(status().textContent, '12 full · 3 partial · 8 tracks at target'); choose('completed');
  assert.equal(env.host.querySelectorAll('.album-card').length, 2); assert.equal(service.count('execute'), 0);
});

test('browse-only Top viewer edits only their account setting and keeps manual progress separate', async t => {
  const {mountAlbumTops} = await N.load('album-tops/index.mjs');
  const env = actualChoiceEnvironment(); N.shell(env); const service = N.service();
  service.data.detail = F.detail({allowed_actions: {'library.browse.read': true, can_read: true, can_manage_own_progress: false},
    top_viewer_overlay: {item_progress: {}}});
  const wire = http(response(), response(data(7, '2'))); env.context.fetch = wire.fetch;
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: service.providers});
  t.after(() => {owner.dispose(); env.assertClean();}); await settle();
  env.input(env.host.querySelector('input'), '7'); env.click(env.button(env.host, 'Save target')); await settle();
  assert.equal(env.host.querySelector('input').value, '7'); assert.equal(service.count('execute'), 0);
  assert.equal(env.host.querySelector('.album-top-listening-status'), null);
  assert.equal(JSON.parse(wire.calls[1].options.body).account_id, undefined);
  assert.equal(env.host.querySelector('[data-gallery-card-intent="complete"]'), null);
});

test('provider rejects wrong domain, regressing revisions and false changed-target receipts', async t => {
  const {createListeningSettingsProvider} = await N.load('album-tops/listening-settings-provider.mjs');
  for (const bad of [
    {ok: true, status: 200, json: async () => ({status: 'ready', data: data(), context_ref: marker, context_scope: 'account-goals-v1'})},
    response(data(5, '2'), 'not-a-marker'),
  ]) {
    const provider = createListeningSettingsProvider({fetch: http(bad).fetch, isCurrent: () => true});
    await assert.rejects(provider.read(), error => error.code === 'stale_context'); provider.dispose();
  }
  const wire = http(response(data(5, '3')), response(data(5, '2')), response(data(7, '3')));
  const provider = createListeningSettingsProvider({fetch: wire.fetch, isCurrent: () => true}); t.after(() => provider.dispose());
  await provider.read(); await assert.rejects(provider.read(), error => error.code === 'invalid_settings_response');
  await assert.rejects(provider.save({completed_target: 7, settings_revision: '3'}), error => error.code === 'invalid_settings_response');
});

test('late JSON body from a previous account cannot publish into the native replacement view', async t => {
  const {mountAlbumTops} = await N.load('album-tops/index.mjs');
  const env = actualChoiceEnvironment(), shell = N.shell(env), service = N.service(), body = N.deferred();
  service.data.detail = F.detail(); const first = {ok: true, status: 200, json: () => body.promise};
  const wire = http(first, response(data(8, '3'), 'b'.repeat(64))); env.context.fetch = wire.fetch;
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: service.providers});
  t.after(() => {owner.dispose(); env.assertClean();}); await settle();
  shell.change({scopeKey: 'replacement-account-session-generation'}); await settle();
  body.resolve(await response(data(99, '9')).json()); await settle();
  assert.equal(env.host.querySelector('input').value, '8');
  assert.doesNotMatch(env.host.textContent, /Saved target: 99/);
});

test('explicit retry losing CAS to the original write reconciles once, with no third PUT', async t => {
  const wire = http(response(data(5, '2')), () => Promise.reject(new TypeError('lost')), response(data(5, '2')),
    response(data(5, '2')), rejection(409, 'settings_revision_conflict'), response(data(7, '3')));
  const f = await control(t, wire); await f.controller.load(); f.input(f.inputTarget(), '7'); await f.controller.save();
  await f.controller.retrySave();
  assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.inputTarget().value, '7');
  assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 2);
  assert.deepEqual(wire.calls.filter(call => call.options.method === 'PUT').map(call => JSON.parse(call.options.body)),
    [{completed_target: 7, settings_revision: '2'}, {completed_target: 7, settings_revision: '2'}]);
});


for (const recovery of ['newer receipt', 'deliberate retry']) test(`rejected retry preserves original uncertainty until ${recovery}`, async t => {
  const wire = http(response(data(5, '2')), () => Promise.reject(new TypeError('original response lost')),
    response(data(5, '2')), response(data(5, '2')), rejection(409, 'concurrent_change'), response(data(5, '2')));
  const f = await control(t, wire); await f.controller.load();
  f.input(f.inputTarget(), '7'); await f.controller.save();
  f.click(f.button(f.host, 'Retry same target')); await settle();
  assert.deepEqual(wire.calls.map(call => call.options.method), ['GET', 'PUT', 'GET', 'GET', 'PUT', 'GET']);
  assert.equal(f.controller.getSnapshot().status, 'uncertain');
  assert.equal(f.controller.getSnapshot().data.settings_revision, '2');
  assert.equal(f.controller.getSnapshot().draft, '7');
  assert.equal(f.controller.presentation().status, 'unavailable');
  assert.equal(f.inputTarget().disabled, true);
  assert.equal(f.button(f.host, 'Save target').disabled, true);
  assert.equal(f.button(f.host, 'Discard target edit').disabled, true);
  assert.equal(f.button(f.host, 'Retry same target').disabled, false);
  f.controller.setDraft('5'); f.controller.resetDraft();
  assert.equal(f.controller.getSnapshot().draft, '7');
  assert.equal(await f.controller.save(), false);
  assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 2);
  if (recovery === 'newer receipt') {
    // This can be the delayed original or another writer. It fences the old
    // CAS, but does not establish attribution to our original request.
    wire.queue.push(response(data(7, '3')));
    f.click(f.button(f.host, 'Check saved target')); await settle();
    assert.equal(wire.calls.filter(call => call.options.method === 'PUT').length, 2);
    assert.match(f.host.textContent, /Current saved target refreshed/);
    assert.doesNotMatch(f.host.textContent, /Listening target saved/);
  } else {
    wire.queue.push(response(data(5, '2')), response(data(7, '3')));
    f.click(f.button(f.host, 'Retry same target')); await settle();
    const writes = wire.calls.filter(call => call.options.method === 'PUT');
    assert.equal(writes.length, 3);
    for (const call of writes) assert.deepEqual(JSON.parse(call.options.body), {completed_target: 7, settings_revision: '2'});
    assert.match(f.host.textContent, /Listening target saved/);
  }
  assert.equal(f.controller.getSnapshot().status, 'ready');
  assert.equal(f.inputTarget().value, '7'); assert.equal(f.inputTarget().disabled, false);
  assert.deepEqual(f.controller.presentation(), {status: 'saved', value: 7, revision: '3'});
  f.input(f.inputTarget(), '8'); assert.equal(f.button(f.host, 'Save target').disabled, false);
});

test('a first-attempt definitive rejection may settle at the same acknowledged revision', async t => {
  const f = await control(t, http(response(data(5, '2')), rejection(409, 'concurrent_change'), response(data(5, '2'))));
  await f.controller.load(); f.input(f.inputTarget(), '7'); await f.controller.save();
  assert.equal(f.controller.getSnapshot().status, 'ready'); assert.equal(f.inputTarget().value, '5');
  assert.equal(f.inputTarget().disabled, false);
  assert.deepEqual(f.controller.presentation(), {status: 'saved', value: 5, revision: '2'});
  assert.equal(f.wire.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('hidden settings owner aborts a pending PUT and reentry only reconciles its uncertain outcome', async t => {
  const {createListeningSettingsSession}=await N.load('album-tops/listening-settings-session.mjs');
  const pending=N.deferred(), wire=http(response(data(5,'2')),()=>pending.promise,response(data(5,'2')),response(data(7,'3')));
  const runtime={snapshot:()=>({authenticated:true,scopeKey:'same-account-session'})};
  const session=createListeningSettingsSession({runtime,fetch:wire.fetch,onChange:()=>{}});
  t.after(()=>session.dispose()); session.update({enabled:true}); await settle();
  const controller=session.getController(); controller.setDraft('7');const saving=controller.save();
  assert.equal(wire.calls.length,2);session.update({enabled:false});
  assert.equal(wire.calls[1].options.signal.aborted,true);
  pending.resolve(response(data(7,'3')));await saving;
  assert.equal(controller.presentation().status,'unavailable');assert.equal(wire.calls.length,2);
  session.update({enabled:true});await settle();
  assert.equal(controller.getSnapshot().status,'uncertain');assert.equal(wire.calls.length,3);
  assert.equal(wire.calls.filter(x=>x.options.method==='PUT').length,1);
  await controller.load();assert.deepEqual(controller.presentation(),{status:'saved',value:7,revision:'3'});
  assert.equal(wire.calls.filter(x=>x.options.method==='PUT').length,1);
});
