'use strict';
// UNRUN source proposal. Actual index-native bootstrap, bridge, controller,
// view, panel, providers and private transport; only browser/network inputs fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {readRepo} = require('./native-home-harness.cjs');
const {setup} = require('./recent-scrobble-delivery-fixture.cjs');
const {entryEnvironment, deferred, drain, load} = require('./native-entry-fixtures/actual-native-runtime.cjs');
const ROW = 'activity_' + 'c'.repeat(64), SNAP = 'b'.repeat(43);
let sequence = 0;
const row = (state = 'not_sent', next_step = 'retry_check') => ({id: ROW, kind: 'listen', title: 'Measured song',
  availability: 'local', source_readable: true, scrobble_delivery: {state, next_step, show_status: true}});
async function settle() {await drain(); await drain(); await drain();}
async function bootstrap(t) {
  const restores = [], ui = entryEnvironment({after: callback => restores.push(callback)}), native = setup();
  const host = ui.add('home-friends-root'), providers = [];
  const h = {ui, native, host, calls: [], command: deferred(), snapshot: SNAP, rows: [row()], historyFailure: null, historyWait: null};
  native.shell.hidden = true; native.bridge.sync();
  native.window.AlbumHavenCapabilities = {allows: action => action === 'integration.lastfm.scrobbles.submit'};
  // Browser History behavior only. The bridge owns normalization and routing.
  native.window.history.replaceState = value => {native.window.history.state = value;};
  native.window.history.state.homeFriendsPresentation = {version: 1, scopeKey: native.bridge.snapshot().scopeKey,
    value: {kind: 'tracks', kindExplicit: true, period: 'all', views: {tracks: 'history'}, homeSection: 'recent'}};
  const response = (payload, stamp = native.shell.dataset.privateUiContext) => ({ok: true, status: 200,
    json: async () => ({...payload, context_ref: stamp})});
  native.context.fetch = async (url, config) => {
    const call = {url: String(url), config}; h.calls.push(call);
    const parsed = new URL(String(url), 'https://albumhaven.test');
    if (config.method === 'POST') {
      assert.equal(parsed.pathname, '/home/activity/scrobbles/retry');
      h.commandStamp = native.shell.dataset.privateUiContext;
      return h.command.promise;
    }
    if (parsed.pathname === '/home-data') return response({recent_local_albums: [], recent_not_local_albums: []});
    if (parsed.pathname === '/friends') return response({members: [], current_user: null, allowed_actions: {}, next_cursor: null});
    assert.equal(parsed.pathname, '/home/activity', 'no unrelated provider endpoint');
    assert.equal(parsed.searchParams.get('kind'), 'listens');
    if (h.historyFailure) throw h.historyFailure;
    if (h.historyWait) return h.historyWait.promise;
    return response({status: 'ready', data: {snapshot_ref: h.snapshot, rows: h.rows, next_cursor: null}});
  };
  vm.runInContext(readRepo('music_app/static/js/unfolding-action-button.js'), ui.context);
  // Use genuine native component owners, not replacement render algorithms.
  const runtime = {...native.bridge, ...ui.runtime,
    viewChooserHtml: options => ui.context.UnfoldingActionButton.render(options),
    mountViewChooser: (node, options) => ui.context.UnfoldingActionButton.mount(node, options),
    viewIconHtml: value => {const node = ui.document.createElement('div'); node.innerHTML = ui.owner('buildGalleryBarHtml')({});
      return node.querySelector(`[data-gallery-view-choice="${value}"] svg`)?.outerHTML || '';}};
  ui.context.AlbumHavenHomeRuntime = runtime;
  // Public configureProviders is the existing entry seam. Its input below is
  // the actual backend adapter with the actual private transport, not a mock.
  // No global goals/presence transport is installed in this focused fixture.
  const {createHomeBackendProviders} = await load('home-friends/backend-providers.mjs');
  const newProviders = () => {const value = createHomeBackendProviders(native.window.AlbumHavenPrivateUITransport, {runtime}); providers.push(value); return value;};
  t.after(() => {
    native.shell.hidden = true; native.bridge.sync();
    for (const provider of providers) provider.dispose();
    for (const restore of restores.reverse()) restore();
  });
  await import(`${pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/index-native.mjs')).href}?recent-retry-bootstrap=${++sequence}`);
  const api = ui.context.AlbumHavenHomeUI;
  api.configureProviders(newProviders());
  native.shell.hidden = false; native.bridge.sync(); await settle();
  const posts = () => h.calls.filter(call => call.config.method === 'POST');
  const reads = () => h.calls.filter(call => new URL(call.url, 'https://albumhaven.test').pathname === '/home/activity');
  const button = () => host.querySelector('[data-recent-scrobble-retry]');
  const finish = (state = 'accepted', step = 'none') => {
    h.snapshot = 'd'.repeat(43); h.rows = [row(state, step)];
    h.command.resolve(response({status: 'ready', refresh_required: true, data: {attempted: true, result: 'attempted'}}, h.commandStamp));
  };
  const hide = () => {native.shell.hidden = true; native.bridge.sync();};
  const show = () => {native.shell.hidden = false; native.bridge.sync();};
  const entry = () => {native.window.history.state = {...native.window.history.state,
    albumHavenNavigationPosition: native.window.history.state.albumHavenNavigationPosition + 1}; native.bridge.sync();};
  assert.ok(button(), 'real bootstrap mounted the eligible history row');
  return Object.assign(h, {runtime, api, newProviders, posts, reads, button, finish, hide, show, entry, response});
}
function assertFreshRead(call) {
  const url = new URL(call.url, 'https://albumhaven.test');
  assert.equal(url.searchParams.get('kind'), 'listens'); assert.equal(url.searchParams.get('period'), 'all');
  for (const key of ['cursor', 'snapshot_ref', 'page']) assert.equal(url.searchParams.has(key), false);
}
function assertAccepted(h) {
  assert.equal(h.host.querySelector('[data-recent-scrobble-delivery]')?.getAttribute('data-recent-scrobble-delivery'), 'accepted');
  assert.equal(h.button(), null);
}

test('actual entry subscription refreshes exactly once after native dispatch and duplicate ready events do not multiply it', async t => {
  const h = await bootstrap(t), before = h.reads().length, button = h.button();
  h.ui.context.dispatchEvent(new h.ui.context.Event('albumhaven:home-runtime-ready'));
  h.ui.context.dispatchEvent(new h.ui.context.Event('albumhaven:home-runtime-ready'));
  h.ui.click(button); h.ui.click(button);
  assert.equal(h.posts().length, 1); assert.equal(button.disabled, true);
  assert.deepEqual(JSON.parse(h.posts()[0].config.body), {origin: {audience: 'own', subject_ref: null, kind: 'listens', period: 'all', snapshot_ref: SNAP}, row_ref: ROW});
  h.finish(); await settle();
  assert.equal(h.reads().length, before + 1); assertFreshRead(h.reads().at(-1)); assertAccepted(h);
});
test('failed post-outcome refresh retires old source and a native read Retry obtains new authority without another POST', async t => {
  const h = await bootstrap(t), button = h.button(), before = h.reads().length;
  h.ui.click(button); h.historyFailure = new TypeError('synthetic history unavailable'); h.finish(); await settle();
  assert.equal(h.reads().length, before + 1); assert.equal(h.button(), null);
  assert.match(h.host.textContent, /could not be loaded/i);
  h.ui.click(button); assert.equal(h.posts().length, 1, 'detached old row cannot dispatch');
  h.historyFailure = null; h.ui.click(h.ui.button(h.host, 'Retry')); await settle();
  assert.equal(h.posts().length, 1); assertFreshRead(h.reads().at(-1)); assertAccepted(h);
});
test('network outcome failure still reaches the actual entry refresh and uncertain server state cannot resend', async t => {
  const h = await bootstrap(t), before = h.reads().length;
  h.ui.click(h.button()); h.snapshot = 'e'.repeat(43); h.rows = [row('delivery_unconfirmed', 'check_delivery')];
  h.command.reject(new TypeError('synthetic command connection lost')); await settle();
  assert.equal(h.posts().length, 1); assert.equal(h.reads().length, before + 1); assert.equal(h.button(), null);
  assert.equal(h.host.querySelector('[data-recent-scrobble-delivery]')?.getAttribute('data-recent-scrobble-delivery'), 'delivery_unconfirmed');
});
test('leaving Home retires actual session; late command does not reacquire it and returning reads current state', async t => {
  const h = await bootstrap(t), button = h.button(), before = h.reads().length;
  h.ui.click(button); h.hide(); assert.equal(h.host.childNodes.length, 0);
  h.finish(); await settle(); assert.equal(h.host.childNodes.length, 0); assert.equal(h.reads().length, before);
  h.ui.click(button); assert.equal(h.posts().length, 1);
  h.show(); await settle(); assert.equal(h.reads().length, before + 1); assertAccepted(h);
});
test('a recreated Home session cannot resend an outstanding command and its own entry listener refreshes on settlement', async t => {
  const h = await bootstrap(t), old = h.button(), before = h.reads().length;
  h.ui.click(old); h.hide(); h.show(); await settle();
  assert.equal(old.isConnected, false); assert.equal(h.button(), null); assert.equal(h.posts().length, 1);
  h.finish(); await settle(); assert.equal(h.reads().length, before + 1); assertAccepted(h);
});
test('a new native history entry remounts the real panel while retaining the outstanding-command fence', async t => {
  const h = await bootstrap(t), header = h.host.querySelector('[data-shared-header]'), old = h.button();
  h.ui.click(old); h.entry(); await settle();
  assert.equal(header.isConnected, false); assert.equal(old.isConnected, false); assert.equal(h.button(), null);
  h.ui.click(old); assert.equal(h.posts().length, 1);
  h.finish(); await settle(); assertAccepted(h); assert.equal(h.posts().length, 1);
});
test('public provider replacement cannot expose a second command; old settlement refreshes the current provider instead of painting its receipt', async t => {
  const h = await bootstrap(t), header = h.host.querySelector('[data-shared-header]'), old = h.button();
  h.ui.click(old); h.api.configureProviders(h.newProviders()); await settle();
  assert.equal(header.isConnected, false); assert.equal(h.button(), null, 'bridge fence survives fresh adapter pending/spent maps');
  h.ui.click(old); assert.equal(h.posts().length, 1);
  const before = h.reads().length;
  h.finish(); await settle(); assert.equal(h.reads().length, before + 1); assertFreshRead(h.reads().at(-1)); assertAccepted(h);
});
test('a replacement provider read begun before settlement cannot overwrite the mandatory fresh snapshot when it completes late', async t => {
  const h = await bootstrap(t), stale = deferred();
  h.ui.click(h.button()); h.historyWait = stale; h.api.configureProviders(h.newProviders()); await settle();
  const before = h.reads().length; h.historyWait = null; h.finish(); await settle();
  assert.equal(h.reads().length, before + 1); assertAccepted(h);
  stale.resolve(h.response({status: 'ready', data: {snapshot_ref: 'f'.repeat(43), rows: [row()], next_cursor: null}}));
  await settle(); assertAccepted(h); assert.equal(h.posts().length, 1);
});
test('cancelled old read cannot delete the fresh known-not-sent receipt used by a subsequent explicitly requested check', async t => {
  const h = await bootstrap(t), stale = deferred();
  h.ui.click(h.button()); h.historyWait = stale; h.api.configureProviders(h.newProviders()); await settle();
  h.historyWait = null; h.finish('not_sent', 'retry_check'); await settle();
  assert.ok(h.button(), 'new server snapshot, not the command receipt, allows an explicit later check');
  stale.resolve(h.response({status: 'ready', data: {snapshot_ref: 'f'.repeat(43), rows: [row()], next_cursor: null}}));
  await settle();
  h.command = deferred(); h.ui.click(h.button());
  assert.equal(h.posts().length, 2, 'fresh authority survived the stale read catch');
  assert.equal(JSON.parse(h.posts()[1].config.body).origin.snapshot_ref, 'd'.repeat(43));
  h.finish(); await settle(); assertAccepted(h);
});
test('old command settlement cannot refresh a replacement private context', async t => {
  const h = await bootstrap(t), old = h.button(); h.ui.click(old);
  h.native.shell.dataset.privateUiContext = 'f'.repeat(64); h.native.bridge.sync(); await settle();
  const before = h.reads().length; h.finish(); await settle();
  assert.equal(old.isConnected, false); assert.equal(h.reads().length, before);
  assert.equal(h.posts().length, 1); assert.equal(h.button(), null);
  assert.equal(h.host.querySelector('[data-recent-scrobble-delivery]'), null, 'old-context receipt cannot repaint delivery');
});
