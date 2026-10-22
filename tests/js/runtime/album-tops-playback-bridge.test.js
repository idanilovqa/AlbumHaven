'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
function fixture() {
  const f = N.nativeEnvironment(), c = f.context;
  // Ownership scope retirement uses browser timers directly. Retain the
  // existing platform's tracked timer/cancellation pair, not a no-op owner.
  c.setTimeout = c.scheduleBrowserTimeout; c.clearTimeout = c.clearBrowserTimeout;
  const cancelled = c.setTimeout(() => assert.fail('Cancelled browser timer ran'), 1);
  assert.equal(f.timers.has(cancelled), true); c.clearTimeout(cancelled);
  assert.equal(f.timers.has(cancelled), false, 'browser cancellation releases its tracked timer');
  for (const id of ['app-shell', 'album-tops-root', 'shell-main-surface']) {
    const element = f.document.createElement('div'); element.id = id; f.document.body.append(element);
  }
  const shell = f.document.getElementById('app-shell');
  Object.assign(shell.dataset, {nativeAccountId: '1', nativeLibraryId: '2', privateUiContext: 'private-context'});
  c.state.player = {}; c.state.view = {surface: {active: 'album_tops'}, top_ref: N.TOP}; c.state.ui = {activeViewRequestId: 1};
  c.location = new URL('https://albumhaven.test/?surface=album_tops');
  let generation = 3;
  // Identity transport boundary only; no media request or authority is mocked.
  c.PrivateUITransport = {context: () => 'private-context', generation: () => generation, subscribe: () => () => {}};
  c.getLibrarySidebarMode = () => 'album_tops'; c.selectLibrarySidebarMode = () => assert.fail('Scope capture must not navigate');
  c.AlbumHavenHomeRuntime = f.runtime;
  for (const file of ['playback-ownership-helpers.js', 'loop-range-controls.js', 'playback-control-cluster.js', 'album-tops-react-bridge.js']) {
    vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), c, {filename: file});
  }
  const bridge = c.AlbumHavenAlbumTopsRuntime;
  return {...f, shell, bridge, scopeKey: JSON.stringify(['1', '2', 'private-context', 3]), setGeneration(value) {generation = value;}};
}

test('Top bridge captures the actual playback scope while ordinary navigation keeps its source alive', () => {
  const f = fixture(), receipt = f.bridge.playback.captureScope(f.scopeKey);
  assert.ok(receipt); assert.equal(receipt.isCurrent(), true);
  f.context.location = new URL('https://albumhaven.test/settings'); f.shell.hidden = true;
  assert.equal(f.bridge.acceptsPrivateScope(f.scopeKey), false, 'page permission retires away from the library');
  assert.equal(receipt.isCurrent(), true, 'native playback scope is session-owned');
  assert.equal(f.bridge.playback.captureScope(f.scopeKey), null, 'a new Top launch still requires the live library');
  f.setGeneration(4); assert.equal(receipt.isCurrent(), false);
  f.setGeneration(3); assert.equal(receipt.isCurrent(), false, 'retired receipt cannot revive');
});

test('Top bridge rejects caller scope substitution and actual shell context disagreement', () => {
  const f = fixture();
  assert.equal(f.bridge.playback.captureScope(JSON.stringify(['9', '2', 'private-context', 3])), null);
  f.shell.dataset.privateUiContext = 'different-context';
  assert.equal(f.bridge.playback.captureScope(f.scopeKey), null);
});

test('Top bridge forwards actual capsule rendering and denies Goals presentation', () => {
  const f = fixture(), config = {variant: 'collection-play', resourceKind: 'album_top', ownerId: 'real-top', modeBadge: 'A', modeLabel: 'Random albums'};
  assert.equal(f.bridge.playbackControlHtml(config), f.context.renderPlaybackControlCluster(config));
  assert.equal(f.bridge.playbackControlHtml({...config, resourceKind: 'goal'}), '');
  const host = f.document.createElement('div'); host.innerHTML = f.bridge.playbackControlHtml(config); f.document.body.append(host);
  const elements = f.bridge.playbackControlElements(host);
  assert.equal(elements.modeBadge.textContent, 'A'); assert.ok(elements.play); assert.ok(elements.optionsTrigger);
  const owner = f.bridge.mountPlaybackOptions({root: elements.actionRoot, interactionRoot: host.firstElementChild, canCreate: true});
  elements.play.focus(); assert.equal(host.firstElementChild.getAttribute('data-loop-action-engaged'), 'true'); owner.destroy(); host.remove();
});
