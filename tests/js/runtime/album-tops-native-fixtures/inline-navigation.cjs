'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {readRepo} = require('../native-home-harness.cjs');

// Same VM, DOM, dialogs and resource accounting as the native view fixture.
// Supply only shell markup and browser history/context prerequisites; the full
// Settings owner, private transport and Top bridge decide whether a draft may
// acquire protection, confirm departure, release, or recover after failure.
function installInlineNavigation(env, runtime, host, opens, topRef) {
  const {context, document} = env;
  const add = (parent, id, attribute) => {
    const node = document.createElement('div');
    if (id) node.id = id;
    if (attribute) node.setAttribute(attribute, '');
    parent.append(node); return node;
  };
  const shell = add(document.body, 'app-shell');
  Object.assign(shell.dataset, {nativeAccountId: 'account:one', nativeLibraryId: 'library:one', privateUiContext: 'a'.repeat(64)});
  add(shell, 'shell-main-surface').append(host); host.id = 'album-tops-root';
  const settings = add(document.body, null, 'data-settings-host'); settings.hidden = true;
  add(settings, null, 'data-settings-outlet'); add(settings, null, 'data-settings-nav');
  const location = new URL(`https://albumhaven.test/?surface=album_tops&top_ref=${topRef}`);
  let historyState = {albumHavenNavigationPosition: 1};
  const history = {...context.history, get state() {return historyState;},
    replaceState(value, _title, url) {historyState = structuredClone(value); location.href = new URL(url || location.href, location).href;}};
  Object.assign(context, {location, history, URLSearchParams, AbortController, structuredClone, crypto: webcrypto,
    CustomEvent: context.Event, AlbumHavenHomeRuntime: runtime,
    setTimeout: context.scheduleBrowserTimeout, clearTimeout: context.clearBrowserTimeout});
  context.state.view = {surface: {active: 'album_tops'}, top_ref: topRef};
  context.state.ui = {activeViewRequestId: 10};
  for (const file of ['settings-navigation.js', 'runtime/shell-navigation-drawer.js',
    'runtime/private-ui-transport.js', 'runtime/track-actions.js', 'runtime/loop-range-controls.js',
    'runtime/playback-control-cluster.js', 'runtime/album-tops-react-bridge.js']) {
    vm.runInContext(readRepo(`music_app/static/js/${file}`), context, {filename: file});
  }
  // The real Top header now mounts the shared Play capsule, even when these
  // navigation cases never start audio. Keep its complete production owners.
  for (const name of ['renderPlaybackControlCluster', 'getPlaybackControlClusterElements', 'mountLoopEditActionControl'])
    assert.equal(typeof env.owner(name), 'function', `actual native playback owner ${name}`);
  assert.ok(context.AlbumHavenSettingsNavigation.instance, 'actual Settings navigation owner mounted');
  const tracks = env.owner('TrackActionsRuntime');
  assert.equal(tracks.scope().actor, shell.dataset.nativeAccountId);
  assert.equal(tracks.scope().library, shell.dataset.nativeLibraryId);
  const bridge = context.AlbumHavenAlbumTopsRuntime;
  Object.assign(runtime, bridge, {openForm(options) {opens.push(options); return bridge.openForm(options);}});
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.authenticated, true); assert.equal(snapshot.visible, true); assert.equal(snapshot.topRef, topRef);
}
module.exports = {installInlineNavigation};
