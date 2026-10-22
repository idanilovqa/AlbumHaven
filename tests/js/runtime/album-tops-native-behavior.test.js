'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, id, TOP, OTHER, SCOPE, deferred, drain, nextTask, detail, sharing, service, preparedController,
  nativeEnvironment, connectedView, shell} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

test('notification sharing Close before the read settles consumes one request and never reopens it', async () => {
  const gate = deferred(), backend = service({readSharing: () => gate.promise}), env = nativeEnvironment();
  const controller = await preparedController(backend); let handled = 0;
  const request = {row: {top_ref: TOP}, isCurrent: () => true};
  const owner = await connectedView(env, backend, controller, {shareRequest: request, onShareRequestHandled: () => handled++});
  try {
    await drain(); assert.equal(env.opens.length, 1); assert.equal(handled, 1);
    env.click(env.button(env.content(), 'Close')); await drain();
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 1); assert.equal(handled, 1);
    assert.equal(backend.calls.find(call => call.method === 'readSharing').args[1].signal.aborted, true);
    owner.update({shareRequest: request}); gate.resolve(sharing()); await drain();
    assert.equal(env.opens.length, 1); assert.equal(env.modal().hidden, true);
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});

test('notification already-projected sharing authority also consumes once across close and repeated props', async () => {
  const backend = service(), env = nativeEnvironment(), controller = await preparedController(backend);
  await controller.readSharing(); // Real authority emission occurs before mounting this view.
  let handled = 0; const request = {row: {top_ref: TOP}, isCurrent: () => true};
  const owner = await connectedView(env, backend, controller, {shareRequest: request, onShareRequestHandled: () => handled++});
  try {
    await drain(); env.click(env.button(env.content(), 'Close')); await drain();
    owner.update({shareRequest: request}); await drain();
    assert.equal(env.opens.length, 1); assert.equal(handled, 1); assert.equal(env.modal().hidden, true);
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});

test('a current share notification replaces inline Edit only after its real draft departure is accepted', async () => {
  const backend = service(), env = nativeEnvironment({inlineNavigation: true});
  const controller = await preparedController(backend, {scopeKey: env.runtime.snapshot().scopeKey});
  let handled = 0; const owner = await connectedView(env, backend, controller, {onShareRequestHandled: () => handled++});
  try {
    env.click(env.button(env.host, 'Edit Album Top'));
    const old = env.host.querySelector('form.album-top-inline-edit'), name = old.querySelector('[name="top-name"]');
    assert.equal(old.getAttribute('aria-label'), 'Edit Album Top'); assert.equal(name.disabled, false);
    env.input(name, 'Unsaved title'); assert.equal(env.button(old, 'Save').disabled, false);
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0);
    const request = {row: {top_ref: TOP}, isCurrent: () => true}; let arrivals = 0;
    // Notifications publish their share request after guarded navigation. Keep
    // that ordering and exercise the actual Settings/Top departure owner.
    const arrive = () => {arrivals++; owner.update({shareRequest: request}); return true;};
    const declined = env.runtime.deferDraftNavigation(arrive); await drain();
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    assert.equal(arrivals, 0); assert.equal(handled, 0);
    env.click(env.document.getElementById('app-confirm-cancel')); assert.equal(await declined, false);
    assert.equal(old.isConnected, true); assert.equal(name.value, 'Unsaved title');
    assert.equal(env.opens.length, 0); assert.equal(handled, 0); assert.equal(backend.count('execute'), 0);
    const accepted = env.runtime.deferDraftNavigation(arrive); await drain();
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    env.click(env.document.getElementById('app-confirm-accept')); assert.equal(await accepted, true); await drain();
    assert.equal(old.isConnected, false); assert.equal(env.host.querySelector('form.album-top-inline-edit'), null);
    assert.equal(env.content().querySelector('form'), null); assert.equal(arrivals, 1);
    assert.equal(env.document.getElementById('app-form-title').textContent, 'Share Album Top');
    assert.equal(env.opens.length, 1); assert.equal(handled, 1);
    assert.ok(env.button(env.content(), 'Save visibility'));
    owner.update({shareRequest: request}); await drain(); assert.equal(env.opens.length, 1); assert.equal(handled, 1);
    env.click(env.button(env.content(), 'Close')); await drain(); owner.update({shareRequest: request}); await drain();
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 1); assert.equal(handled, 1);
    assert.equal(backend.count('execute'), 0); assert.equal(controller.getSnapshot().detail.data.title, 'Curated Top');
    assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Retired editor replayed a departure')), false);
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});

for (const [label, selected] of [['Create Album Top', null], ['Share', TOP]]) {
  test(`${label} reports native open failure, closes fallback, and permits an explicit reopen`, async () => {
    const backend = service(), env = nativeEnvironment(), controller = await preparedController(backend, {selected});
    const owner = await connectedView(env, backend, controller), actualOpen = env.runtime.openForm;
    try {
      env.runtime.openForm = () => {throw new Error('Injected native service unavailable');};
      env.click(env.button(env.host, label));
      const fallback = env.host.querySelector('[data-album-top-dialog-fallback]');
      assert.match(fallback.textContent, /dialog is not available/); assert.equal(env.modal().hidden, true);
      env.click(env.button(fallback, 'Close')); await drain(); assert.equal(fallback.textContent, '');
      env.runtime.openForm = actualOpen; env.click(env.button(env.host, label)); await drain();
      assert.equal(env.modal().hidden, false); assert.equal(env.opens.length, 1);
    } finally {env.runtime.openForm = actualOpen; owner.dispose();}
    env.assertClean();
  });
}

test('inline Edit reports real navigation protection failure, cancels, and saves after an explicit reopen', async () => {
  const write = deferred(), backend = service({execute: () => write.promise}), env = nativeEnvironment({inlineNavigation: true});
  const controller = await preparedController(backend, {scopeKey: env.runtime.snapshot().scopeKey});
  const owner = await connectedView(env, backend, controller), {history, location} = env.context;
  const originalHistory = structuredClone(history.state), originalUrl = location.href;
  try {
    history.replaceState({...originalHistory, albumHavenNavigationPosition: '1'}, '', originalUrl);
    env.click(env.button(env.host, 'Edit Album Top'));
    const failed = env.host.querySelector('form.album-top-inline-edit');
    assert.match(failed.textContent, /navigation protection could not be started.*Cancel and reopen this Top/);
    assert.equal(failed.querySelector('[name="top-name"]').disabled, true);
    assert.equal(env.button(failed, 'Save').disabled, true); assert.equal(env.button(failed, 'Cancel').disabled, false);
    failed.dispatchEvent(new env.context.Event('submit')); assert.equal(backend.count('execute'), 0);
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0);
    assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Failed guard authorized a departure')), false);
    env.click(env.button(failed, 'Cancel')); await drain();
    assert.equal(failed.isConnected, false); assert.doesNotMatch(env.host.textContent, /navigation protection could not be started/);
    history.replaceState(originalHistory, '', originalUrl);
    env.click(env.button(env.host, 'Edit Album Top'));
    const reopened = env.host.querySelector('form.album-top-inline-edit'), name = reopened.querySelector('[name="top-name"]');
    assert.notEqual(reopened, failed); assert.equal(name.disabled, false); assert.equal(name.value, 'Curated Top');
    assert.doesNotMatch(reopened.textContent, /navigation protection could not be started/);
    env.input(name, 'Recovered Top'); assert.equal(env.button(reopened, 'Save').disabled, false);
    reopened.dispatchEvent(new env.context.Event('submit'));
    assert.equal(backend.count('execute'), 1);
    const [action, command] = backend.calls.find(call => call.method === 'execute').args;
    assert.equal(action, 'save'); assert.equal(command.top_ref, TOP); assert.equal(command.revision, '7');
    assert.equal(command.title, 'Recovered Top'); assert.equal(command.description, 'Subtitle');
    backend.data.detail = detail({title: command.title, revision: '8'});
    write.resolve({action, request_key: command.request_key, top_ref: TOP, revision: '8'}); await drain();
    assert.equal(reopened.isConnected, false); assert.equal(env.host.querySelector('form.album-top-inline-edit'), null);
    assert.equal(env.host.querySelector('.gallery-bar__title').textContent, 'Recovered Top');
    assert.equal(env.button(env.host, 'Edit Album Top').disabled, false); assert.equal(backend.count('execute'), 1);
    assert.equal(env.modal().hidden, true); assert.equal(env.opens.length, 0);
    assert.deepEqual(history.state, originalHistory); assert.equal(location.href, originalUrl);
    assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('Saved editor retained its guard')), false);
  } finally {owner.dispose();}
  env.assertClean();
});

test('partial builder mount failure retires real draft subscription and native form before recovery', async () => {
  const backend = service(), env = nativeEnvironment(), controller = await preparedController(backend, {selected: null});
  const subscribe = controller.subscribe; let subscriptions = 0;
  controller.subscribe = fn => {subscriptions++; const stop = subscribe(fn); let stopped = false; return () => {if (!stopped) {stopped = true; subscriptions--; stop();}};};
  const owner = await connectedView(env, backend, controller), baseline = subscriptions, actualButton = env.runtime.buttonHtml;
  try {
    env.runtime.buttonHtml = config => {if (config.label === 'Find albums') throw new Error('Injected post-draft native renderer failure'); return actualButton(config);};
    env.click(env.button(env.host, 'Create Album Top'));
    assert.equal(subscriptions, baseline, 'failed editor releases its actual draft subscription');
    assert.equal(env.modal().hidden, true); assert.equal(env.content().childNodes.length, 0);
    const fallback = env.host.querySelector('[data-album-top-dialog-fallback]'); assert.match(fallback.textContent, /not available/);
    env.click(env.button(fallback, 'Close')); env.runtime.buttonHtml = actualButton;
    env.click(env.button(env.host, 'Create Album Top')); assert.equal(env.modal().hidden, false);
    assert.equal(subscriptions, baseline + 1);
  } finally {env.runtime.buttonHtml = actualButton; owner.dispose();}
  assert.equal(subscriptions, 0); env.assertClean();
});

test('normal long title retains the canonical span across unrelated controller updates', async () => {
  const backend = service(), env = nativeEnvironment(); backend.data.detail = detail({title: '<Long & literal> '.repeat(6)});
  const controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    const title = env.host.querySelector('.gallery-bar__title'), span = title.firstElementChild;
    assert.equal(span?.tagName, 'SPAN'); assert.equal(span.textContent, backend.data.detail.title); assert.equal(span.children.length, 0);
    await controller.load(); assert.equal(title.firstElementChild, span); assert.equal(span.textContent, backend.data.detail.title);
  } finally {owner.dispose();}
  env.assertClean();
});

test('entry waits for acknowledged create form return before receipt navigation and routes once', async () => {
  const write = deferred(), returned = deferred(), backend = service({execute: () => write.promise});
  const env = nativeEnvironment(), nativeShell = shell(env, {topRef: null});
  env.context.retireMobileAppFormPage = () => returned.promise; // External history boundary; actual modal close remains in use.
  const {mountAlbumTops} = await load('album-tops/index.mjs');
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: backend.providers});
  try {
    await drain(); env.click(env.button(env.host, 'Create Album Top'));
    env.input(env.content().querySelector('[name="top-name"]'), 'New Top');
    const form = env.content().querySelector('form'); form.dispatchEvent(new env.context.Event('submit'));
    assert.equal(backend.count('execute'), 1); const command = backend.calls.find(call => call.method === 'execute').args[1];
    backend.data.detail = detail({top_ref: OTHER, revision: '8', title: 'New Top'});
    write.resolve({action: 'create', request_key: command.request_key, top_ref: OTHER, revision: '8'}); await drain();
    assert.equal(nativeShell.navigations.length, 0, 'native parent-return acknowledgment still outstanding');
    returned.resolve(true); await drain();
    assert.equal(nativeShell.navigations.length, 1); assert.equal(nativeShell.navigations[0].top_ref, OTHER);
    assert.equal(nativeShell.navigations[0].expectedViewRequestId, 10); assert.equal(nativeShell.navigations[0].isCurrent(), true);
    nativeShell.change({}); await drain(); assert.equal(nativeShell.navigations.length, 1);
  } finally {owner.dispose();}
  assert.equal(nativeShell.listeners.size, 0); env.assertClean();
});

test('copy receipt cannot navigate after the native view request changes', async () => {
  const write = deferred(), backend = service({execute: () => write.promise}), env = nativeEnvironment(), nativeShell = shell(env);
  const {mountAlbumTops} = await load('album-tops/index.mjs'); const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: backend.providers});
  try {
    await drain(); env.click(env.button(env.host, 'Save a copy'));
    const command = backend.calls.find(call => call.method === 'execute').args[1];
    nativeShell.change({viewRequestId: 11});
    write.resolve({action: 'copy', request_key: command.request_key, top_ref: OTHER, revision: '1', source_top_ref: TOP, source_revision: command.revision});
    await drain(); assert.equal(nativeShell.navigations.length, 0); assert.equal(backend.count('execute'), 1);
  } finally {owner.dispose();}
  env.assertClean();
});

test('delete native confirmation rechecks the actual controller snapshot before writing', async () => {
  const backend = service(), env = nativeEnvironment(), controller = await preparedController(backend), owner = await connectedView(env, backend, controller);
  try {
    env.click(env.button(env.host, 'Delete Album Top'));
    assert.equal(env.document.getElementById('app-confirm-modal').hidden, false);
    await controller.open(OTHER); env.click(env.document.getElementById('app-confirm-accept')); await drain();
    assert.equal(backend.count('execute'), 0);
  } finally {owner.dispose();}
  await nextTask(); env.assertClean();
});

test('backend receipt mismatch stays uncertain in the actual controller without publishing a ready receipt', async () => {
  const {createAlbumTopBackendProviders} = await load('album-tops/backend-providers.mjs');
  const {createAlbumTopController} = await load('album-tops/model.mjs');
  const context = {}, requests = [], wireTop = {...detail(), items: []};
  const transport = {context: () => context, async request(path, options) {
    requests.push({path, options});
    const data = options.method === 'POST' ? {action: 'copy', request_key: id(999), top_ref: OTHER, revision: '1', source_top_ref: TOP, source_revision: '7'}
      : path.startsWith('/album-tops?') ? {tops: [wireTop], next_cursor: null, allowed_actions: wireTop.allowed_actions} : wireTop;
    return {status: 'ready', context_ref: context, data};
  }};
  const providers = createAlbumTopBackendProviders({transport, acceptsScope: value => value === SCOPE});
  const controller = createAlbumTopController({providers, requestKey: () => id(100)});
  try {
    controller.setScope(SCOPE); await controller.load(); await controller.open(TOP); await controller.mutate('copy');
    assert.equal(controller.getSnapshot().mutation.status, 'uncertain'); assert.equal(controller.getSnapshot().mutation.data, undefined);
    assert.equal(controller.getSnapshot().mutation.command.request_key, id(100)); assert.equal(controller.canRetryMutation(), true);
    assert.equal(requests.filter(row => row.options.method === 'POST').length, 1);
  } finally {controller.dispose(); providers.dispose();}
});
