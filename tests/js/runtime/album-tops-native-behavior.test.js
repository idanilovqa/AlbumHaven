'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, id, TOP, OTHER, SCOPE, deferred, drain, detail, sharing, service, preparedController,
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
  env.assertClean();
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
  env.assertClean();
});

test('a current share notification replaces a metadata-only editor with the actual sharing owner', async () => {
  const backend = service(), env = nativeEnvironment(), controller = await preparedController(backend);
  let handled = 0; const owner = await connectedView(env, backend, controller, {onShareRequestHandled: () => handled++});
  try {
    env.click(env.button(env.host, 'Edit Album Top'));
    const old = env.content().querySelector('form'); assert.equal(old.getAttribute('aria-label'), 'Edit Album Top');
    owner.update({shareRequest: {row: {top_ref: TOP}, isCurrent: () => true}}); await drain();
    assert.equal(old.isConnected, false); assert.equal(env.content().querySelector('form'), null);
    assert.equal(env.document.getElementById('app-form-title').textContent, 'Share Album Top');
    assert.equal(env.opens.length, 2); assert.equal(handled, 1);
    assert.ok(env.button(env.content(), 'Save visibility'));
  } finally {owner.dispose();}
  env.assertClean();
});

for (const [label, selected] of [['Create Album Top', null], ['Edit Album Top', TOP], ['Share', TOP]]) {
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
  env.assertClean();
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
