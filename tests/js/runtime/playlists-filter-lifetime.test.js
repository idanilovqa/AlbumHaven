const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/app.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/model.mjs');});
const payload = id => ({playlist_sidebar: {items: ['A', 'B'].map(playlist_id => ({playlist_id, title: playlist_id,
  allowed_actions: {can_open: true}}))}, playlist_detail: {playlist_id: id, title: id, revision: 'revision',
  description: '', track_rows: [], items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'},
  allowed_actions: {can_open: true, can_edit: true, can_rename: true}}});
const session = (providers = {}) => {
  const controller = model.createPlaylistController({providers}); controller.setScope('actor:library');
  controller.accept(payload('A'), 'A'); return controller;
};
const elements = tree => React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(element => element.type?.name === name);
function viewFixture(controller) {
  const slots = []; let cursor = 0, effects = [], current = controller, providers = {};
  const hooks = {...React,
    useRef(value) {return slots[cursor++] ||= {current: value};},
    useState(initial) {const slot = slots[cursor++] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useMemo(factory, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = {deps, value: factory()};
      return slots[index].value;},
    useSyncExternalStore(_subscribe, getSnapshot) {return getSnapshot();},
  };
  hooks.useEffect = hooks.useLayoutEffect = (effect, deps) => {
    const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {
      old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};
    });
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : require(name),
    AbortController, document: {activeElement: null}, console});
  const runtime = {alertHtml: () => '', downloadText() {}};
  return {render(next = current, nextProviders = providers) {
    current = next; providers = nextProviders; cursor = 0; effects = [];
    const tree = loaded.exports.PlaylistsView({runtime, controller: current, state: current.getSnapshot(),
      integrationProviders: providers, onSelect() {}});
    for (const effect of effects) effect(); return tree;
  }, unmount() {for (const slot of slots) slot.cleanup?.();}};
}
async function open(view) {
  await component(view.render(), 'PlaylistHeader').props.onAction('filters');
  const tree = view.render(); assert.ok(component(tree, 'PlaylistFilterSurface')); return tree;
}

test('actual Playlist controller A to B to A navigation retires the old open session even between React commits', async () => {
  const controller = session(), view = viewFixture(controller); await open(view);
  controller.select('B', {load: false}); controller.accept(payload('B'), 'B');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  controller.select('A', {load: false}); controller.accept(payload('A'), 'A');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  await open(view);
  controller.select('B', {load: false}); controller.accept(payload('B'), 'B');
  controller.select('A', {load: false}); controller.accept(payload('A'), 'A');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  view.unmount(); controller.dispose();
});

test('resource replacement and revoke/regrant cannot resurrect an old filter form or its stale callback', async () => {
  const controller = session(), view = viewFixture(controller);
  let tree = await open(view), stale = component(tree, 'PlaylistFilters').props.onChange;
  controller.accept(payload('A'), 'A'); stale({query: 'obsolete'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  tree = await open(view); stale = component(tree, 'PlaylistFilters').props.onChange;
  controller.accept({status: 'denied'}, 'A'); controller.accept(payload('A'), 'A'); stale({query: 'revived'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  view.unmount(); controller.dispose();
});

test('provider and controller replacement permanently retire open ownership while ordinary value edits keep it', async () => {
  const first = session(), second = session(), view = viewFixture(first);
  let tree = await open(view), surface = component(tree, 'PlaylistFilterSurface');
  component(tree, 'PlaylistFilters').props.onChange({query: 'current'});
  assert.equal(component(view.render(), 'PlaylistFilterSurface').key, surface.key);
  assert.equal(model.playlistFilters(first.getSnapshot()).query, 'current');
  const oldProviders = {}, newProviders = {readMatches() {}};
  view.render(first, oldProviders); await open(view);
  assert.equal(component(view.render(first, newProviders), 'PlaylistFilterSurface'), undefined);
  assert.equal(component(view.render(first, oldProviders), 'PlaylistFilterSurface'), undefined);
  await open(view);
  assert.equal(component(view.render(second, oldProviders), 'PlaylistFilterSurface'), undefined);
  assert.equal(component(view.render(first, oldProviders), 'PlaylistFilterSurface'), undefined);
  await open(view);
  first.configure({readPlaylists: async () => payload('A')}); first.accept(payload('A'), 'A');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  view.unmount(); first.dispose(); second.dispose();
});

test('a retained filter callback rechecks live mutation status before changing view values', async () => {
  let resolveWrite;
  const controller = session({savePlaylist: () => new Promise(resolve => {resolveWrite = resolve;})}), view = viewFixture(controller);
  const tree = await open(view), change = component(tree, 'PlaylistFilters').props.onChange;
  controller.edit({title: 'Changed'}); const saving = controller.mutate('savePlaylist');
  assert.equal(controller.getSnapshot().mutation.status, 'loading');
  change({query: 'must not apply'}); assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  resolveWrite({ok: false}); await saving;
  view.unmount(); controller.dispose();
});

test('a late close from a retired filter surface cannot close a newly opened session', async () => {
  const controller = session(), view = viewFixture(controller), first = await open(view);
  const oldClose = component(first, 'PlaylistFilterSurface').props.onClose;
  controller.accept(payload('A'), 'A'); view.render();
  const next = await open(view), key = component(next, 'PlaylistFilterSurface').key;
  oldClose(); assert.equal(component(view.render(), 'PlaylistFilterSurface').key, key);
  view.unmount(); controller.dispose();
});


test('unmount retires retained filter changes and cannot reopen ownership through a stale header action', async () => {
  const controller = session(), view = viewFixture(controller), tree = await open(view);
  const change = component(tree, 'PlaylistFilters').props.onChange;
  const reopen = component(tree, 'PlaylistHeader').props.onAction;
  view.unmount();
  change({query: 'after unmount'}); await reopen('filters'); change({query: 'after stale reopen'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  controller.dispose();
});


test('retained header callbacks cannot open a replacement controller or provider session, including provider ABA', async () => {
  const first = session(), second = session(), view = viewFixture(first), originalProviders = {}, replacementProviders = {readMatches() {}};
  const firstHeader = component(view.render(first, originalProviders), 'PlaylistHeader').props.onAction;
  view.render(second, originalProviders); await firstHeader('filters');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  const secondHeader = component(view.render(), 'PlaylistHeader').props.onAction;
  view.render(second, replacementProviders); await secondHeader('filters');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  view.render(second, originalProviders); await secondHeader('filters');
  assert.equal(component(view.render(), 'PlaylistFilterSurface'), undefined);
  await open(view); view.unmount(); first.dispose(); second.dispose();
});
