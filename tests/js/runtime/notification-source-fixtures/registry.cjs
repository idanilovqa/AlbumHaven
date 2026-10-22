'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('../native-home-harness.cjs');
const {installTemplateFragmentPlatform} = require('../template-fragment-platform.cjs');
const SCOPE = 'notification-tests:actor:library:context', TIME = '2026-10-19T12:00:00Z';
const row = (id = 'one', patch = {}) => ({id, title: `Title ${id}`, byline: 'Ready for review',
  typeLabel: 'Album Top import', createdAt: TIME, read: false, ...patch});
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const env = createNativeHomeRuntime(), handles = [], nodes = [], calls = [];
  installTemplateFragmentPlatform(env.document);
  env.context.state = {coverLookup: {tasks: [], drawerOpen: false, elapsedTimer: 0}};
  vm.runInContext(readRepo('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js'), env.context,
    {filename: 'cover-lookup-modal-and-drawer.js'});
  const registry = env.context.AlbumHavenNotifications, baseline = env.listeners().filter(item => item.target.isConnected).length;
  function register(patch = {}) {
    const options = {name: `source-${handles.length}`, label: 'Album Top imports', scopeKey: SCOPE,
      isCurrent: () => true, onOpen: (...args) => {calls.push(args); return true;}, ...patch};
    const handle = registry.registerSource(options); handles.push(handle); return handle;
  }
  const all = () => env.owner('getRequestNotificationCards')();
  const cards = () => Array.from(all()).filter(card => !card.status);
  const statuses = () => Array.from(all()).filter(card => card.status);
  function mountDrawer() {
    assert.equal(nodes.length, 0, 'each focused test mounts one actual drawer');
    const add = (tag, id, parent = env.document.body) => {
      const node = env.document.createElement(tag); node.id = id; parent.append(node); nodes.push(node); return node;
    };
    const drawer = add('aside', 'cover-lookup-drawer'), body = add('div', 'cover-lookup-drawer-body', drawer);
    const button = add('button', 'cover-lookup-drawer-button'), badge = add('span', 'cover-lookup-drawer-badge', button);
    const summary = add('div', 'cover-lookup-drawer-summary', drawer);
    env.context.state.coverLookup.drawerOpen = true;
    // No selection/pressed pointer interaction is active. This is the existing
    // renderer option, not a replacement renderer or suppressed DOM error.
    env.owner('renderCoverLookupDrawer')({preserveInteraction: false});
    return {drawer, body, button, badge, summary};
  }
  t.after(() => {
    for (const node of nodes) node.remove();
    env.document.dispatchEvent(new env.context.Event('selectionchange'));
    for (const handle of handles) handle.dispose();
    assert.equal(cards().length, 0); assert.equal(statuses().length, 0);
    assert.equal(env.listeners().filter(item => item.target.isConnected).length, baseline);
    assert.deepEqual(env.forbiddenCalls, [], 'registry creates no fetch, timer, navigation or playback side effect');
  });
  return {...env, registry, register, all, cards, statuses, calls, mountDrawer};
}
module.exports = {SCOPE, TIME, row, plain, fixture};
