'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {webcrypto} = require('node:crypto');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./album-tops-source-replay-fixture.cjs');
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});

async function mounted(t, overrides = {}) {
  const env = N.nativeEnvironment(); env.context.AbortController = AbortController;
  const native = F.installNative(env.context), shell = N.shell(env), service = N.service(overrides);
  service.data.detail = N.detail({items: [F.row()],
    top_viewer_overlay: {activity: {active: true, activity_revision: '1'},
      item_progress: {[F.ALBUM]: {progress_revision: '1', manual_completed_at: null}}}});
  const resolutions = [], owners = [], create = env.runtime.createResourceSelection;
  service.providers.resolveNativeAlbum = async (payload, options) => {resolutions.push({payload, options}); return F.reply(payload);};
  env.runtime.createResourceSelection = hooks => {const owner = create(hooks); owners.push(owner); return owner;};
  const {mountAlbumTops} = await F.load('album-tops/index.mjs');
  const owner = mountAlbumTops({host: env.host, runtime: env.runtime, providers: service.providers});
  t.after(() => {owner.dispose(); assert.equal(shell.listeners.size, 0); assert.deepEqual(native.boundaryErrors, []);});
  await N.drain();
  const open = async () => {const button = env.host.querySelector('[data-gallery-card-intent="open"]');
    assert.ok(button, 'actual saved-Top Gallery exposes Open'); env.click(button); await N.drain();};
  return {...env, ...native, shell, service, owner, resolutions, owners, open};
}

test('Top mount keeps one native selection through actual Gallery disposal, replay and remount', async t => {
  const f = await mounted(t); assert.equal(f.owners.length, 1);
  await f.open(); assert.equal(f.presentations.length, 1);
  const descriptor = f.descriptor(), retained = f.presentations[0].owner;
  f.shell.change({visible: false, active: false, sidebarMode: 'artists', viewVersion: 2, viewRequestId: 11});
  await N.drain(); assert.equal(f.host.querySelector('[data-gallery-card-intent="open"]'), null);
  assert.equal(f.resolutions[0].options.signal.aborted, true); assert.equal(retained.isCurrent(), true);
  assert.equal(await f.restore(descriptor), true); assert.equal(f.presentations.length, 2);
  f.shell.change({visible: true, active: true, sidebarMode: 'album_tops', viewVersion: 3, viewRequestId: 12});
  await N.drain(); await f.open();
  assert.equal(f.presentations.length, 3); assert.equal(f.owners.length, 1);
  f.owner.dispose(); assert.equal(f.presentations[2].owner.isCurrent(), false);
  const reads = f.service.count('read');
  await assert.rejects(f.restore(), {name: 'AbortError'}); assert.equal(f.service.count('read'), reads);
});

test('index observes away-and-back session transitions without needing the old receipt to be polled', async t => {
  const f = await mounted(t); await f.open(); const retained = f.presentations[0].owner;
  f.shell.change({scopeKey: 'other-session'});
  f.shell.change({scopeKey: N.SCOPE}); await N.drain();
  assert.equal(retained.isCurrent(), false); assert.equal(f.owners.length, 1);
});

test('actual Gallery completion mutation retires native source authority before its write settles', async t => {
  const gate = N.deferred(), entered = N.deferred();
  const f = await mounted(t, {execute(action, command) {entered.resolve({action, command}); return gate.promise;}});
  await f.open(); const retained = f.presentations[0].owner;
  const button = f.host.querySelector('[data-gallery-card-intent="complete"]'); assert.ok(button);
  f.click(button); await N.drain();
  assert.equal(f.service.count('execute'), 1); assert.equal((await entered.promise).action, 'set_manual_completion');
  assert.equal(retained.isCurrent(), false);
  gate.reject(Object.assign(new Error('Mutation conflict fixture'), {status: 409})); await N.drain();
  assert.equal(retained.isCurrent(), false);
});

for (const [name, changed, expected] of [
  ['same exact source', value => value, true],
  ['changed saved-Top revision', value => ({...value, revision: '8'}), false],
  ['removed original member', value => ({...value, items: []}), false],
]) test(`index ready detail observation handles ${name} after native source retention`, async t => {
  const f = await mounted(t); await f.open(); const retained = f.presentations[0].owner;
  f.service.data.detail = changed(structuredClone(f.service.data.detail));
  f.shell.change({viewVersion: 2, viewRequestId: 11}); await N.drain();
  assert.equal(retained.isCurrent(), expected); assert.equal(f.owners.length, 1);
});

test('an unrelated selected Top does not invalidate the original retained source', async t => {
  const f = await mounted(t); await f.open(); const retained = f.presentations[0].owner;
  f.service.data.detail = N.detail({top_ref: N.OTHER, revision: '9', items: []});
  f.shell.change({topRef: N.OTHER, viewVersion: 2, viewRequestId: 11}); await N.drain();
  assert.equal(retained.isCurrent(), true); assert.equal(f.owners.length, 1);
});

test('index directory denial retires the retained source after the Gallery has gone', async t => {
  const f = await mounted(t); await f.open(); const retained = f.presentations[0].owner;
  f.shell.change({visible: false}); await N.drain();
  f.service.providers.list = async () => {throw Object.assign(new Error('Read denied'), {status: 403});};
  await f.owner.refresh(); await N.drain(); assert.equal(retained.isCurrent(), false);
});

test('native bridge exposes the actual projector contracts needed by the persistent adapter', () => {
  const f = N.nativeEnvironment(), c = f.context;
  for (const id of ['app-shell', 'album-tops-root', 'shell-main-surface']) {
    const element = f.document.createElement('div'); element.id = id; f.document.body.append(element);
  }
  const shell = f.document.getElementById('app-shell'); shell.dataset.nativeAccountId = '1'; shell.dataset.nativeLibraryId = '2';
  c.state.view = {surface: {active: 'album_tops'}, top_ref: F.TOP}; c.state.ui = {activeViewRequestId: 1};
  c.location = new URL('https://albumhaven.test/?surface=album_tops');
  c.PrivateUITransport = {context: () => 'private-context', generation: () => 3, subscribe: () => () => {}};
  c.getLibrarySidebarMode = () => 'album_tops'; c.selectLibrarySidebarMode = () => assert.fail('Projection must not navigate');
  c.AlbumHavenHomeRuntime = f.runtime;
  delete c.AlbumHavenHomeRuntime.searchHtml; // The actual Home bridge does not export Search.
  let readyEvents = 0;
  const onReady = () => {readyEvents++;};
  c.addEventListener('albumhaven:album-tops-runtime-ready', onReady);
  F.script(c, 'album-tops-react-bridge.js');
  assert.equal(readyEvents, 1, 'Actual bridge dispatches its native readiness event');
  c.removeEventListener('albumhaven:album-tops-runtime-ready', onReady);
  const bridge = c.AlbumHavenAlbumTopsRuntime, native = c.AlbumHavenResourceSelection;
  const searchConfig = {id: 'top-bridge-filter-search', value: 'Album', label: 'Search albums', disabled: true};
  const html = bridge.searchHtml(searchConfig);
  assert.equal(html, f.owner('buildSearchInputHtml')(searchConfig), 'Top uses the actual shared Search owner and template');
  const searchHost = f.document.createElement('div'); searchHost.innerHTML = html;
  const searchInput = searchHost.querySelector('input[type="search"]');
  assert.equal(searchInput.id, searchConfig.id); assert.equal(searchInput.value, searchConfig.value);
  assert.equal(searchInput.disabled, true); assert.equal(searchInput.getAttribute('aria-label'), searchConfig.label);
  assert.deepEqual(F.plain(bridge.projectResourceTarget(F.target())), F.plain(native.projectTarget(F.target())));
  assert.deepEqual(F.plain(bridge.projectResourceOrigin(F.origin())), F.origin());
  assert.equal(bridge.projectResourceOrigin({...F.origin(), inventory_album_ref: 'private-hint'}), null);
  assert.equal(bridge.projectResourceTarget({...F.target(), origin: {...F.origin(), revision: '0'}}), null);
});

test('index observes library departure even when the old source receipt is not polled until return', async t => {
  const f = await mounted(t); await f.open();
  const retained = f.presentations[0].owner, descriptor = f.descriptor();
  const scope = f.runtime.snapshot().scopeKey;
  // Do not poll retained.isCurrent() while away. Only the mounted index sees
  // these shell notifications; the same session and source return unchanged.
  f.shell.change({inLibrary: false});
  f.shell.change({inLibrary: true}); await N.drain();
  assert.equal(f.runtime.snapshot().scopeKey, scope);
  assert.equal(retained.isCurrent(), false, 'Returning cannot revive the unpolled pre-departure receipt');
  assert.equal(f.owners.length, 1); assert.equal(f.presentations.length, 1);
  const reads = f.service.count('read');
  assert.equal(await f.restore(descriptor), true);
  assert.equal(f.service.count('read'), reads + 1, 'A new replay freshly authorizes after returning');
  assert.equal(f.presentations.length, 2); assert.equal(f.presentations[1].owner.isCurrent(), true);
});

for (const stage of ['Top read', 'native resolution']) {
  test(`index library away-and-back retires replay waiting on ${stage} without polling its guard`, async t => {
    const f = await mounted(t); await f.open();
    const gate = F.deferred(), entered = F.deferred(), abort = new AbortController();
    const descriptor = f.descriptor(), scope = f.runtime.snapshot().scopeKey;
    const read = f.service.providers.read, resolve = f.service.providers.resolveNativeAlbum;
    let pendingCalls = 0;
    if (stage === 'Top read') {
      f.service.providers.read = (ref, options) => {
        if (options.signal !== abort.signal) return read(ref, options);
        pendingCalls++; entered.resolve({ref, options}); return gate.promise;
      };
    } else {
      f.service.providers.resolveNativeAlbum = (payload, options) => {
        if (options.signal !== abort.signal) return resolve(payload, options);
        pendingCalls++; entered.resolve({payload, options}); return gate.promise;
      };
    }
    const operation = f.restore(descriptor, {signal: abort.signal});
    const observed = await F.atBoundary(entered, operation), rejection = assert.rejects(operation, {name: 'AbortError'});
    assert.equal(observed.options.signal, abort.signal); assert.equal(pendingCalls, 1);
    // Leave both receipt.isCurrent and the resolver's isCurrent untouched until
    // the old shell has returned, so guard polling cannot hide an index bug.
    f.shell.change({inLibrary: false});
    f.shell.change({inLibrary: true}); await N.drain();
    assert.equal(f.runtime.snapshot().scopeKey, scope);
    assert.equal(abort.signal.aborted, false, 'The caller did not cancel this replay');
    gate.resolve(stage === 'Top read' ? structuredClone(f.service.data.detail) : F.reply(observed.payload));
    await rejection;
    assert.equal(pendingCalls, 1); assert.equal(f.hydrations.length, 1);
    assert.equal(f.presentations.length, 1); assert.equal(f.owners.length, 1);
    if (stage === 'native resolution') assert.equal(observed.options.isCurrent(), false);
  });
}
