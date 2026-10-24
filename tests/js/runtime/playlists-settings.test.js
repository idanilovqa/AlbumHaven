const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {buildSync} = require('esbuild');
const built = buildSync({entryPoints: [path.resolve(__dirname, '../../../music_app/static/js/playlists/settings.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const loaded = {exports: {}}; vm.runInNewContext(built, {module: loaded, exports: loaded.exports, require, AbortController});
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/model.mjs');});
const payload = (grant = true) => ({playlist_sidebar: {items: [{playlist_id: 'p', title: 'P', allowed_actions: {can_open: true}}]},
  playlist_detail: {playlist_id: 'p', revision: '2', title: 'P', description: '', track_rows: [], items_complete: true,
    active_sort: {key: 'playlist_position', direction: 'asc'}, allowed_actions: {can_open: true, can_edit: true, can_delete: grant, can_save_default_sort: grant}}});
const create = providers => {const controller = model.createPlaylistController({providers}); controller.setScope('scope'); controller.accept(payload(), 'p'); return controller;};
test('saved default is an exact granted mutation and unsupported sorts cannot dispatch', async () => {
  const calls = [], controller = create({saveDefaultSort: async input => {calls.push(input); return {ok: true};}});
  assert.equal(await controller.mutate('saveDefaultSort', {sort: {key: 'title', direction: 'asc'}}), false);
  assert.equal(await controller.mutate('saveDefaultSort', {sort: {key: 'play_count', direction: 'desc'}}), true);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].sort, {key: 'play_count', direction: 'desc'}); assert.equal(calls[0].revision, '2');
  controller.accept(payload(false), 'p'); assert.equal(await controller.mutate('saveDefaultSort', {sort: null}), false);
  assert.equal(calls.length, 1); controller.dispose();
});
test('Delete uses a destructive native confirm and clears saved selection only after acknowledgement', async () => {
  const calls = [], controller = create({deletePlaylist: async input => {calls.push(input); return {ok: true};},
    readPlaylists: async () => ({playlist_sidebar: {items: []}, playlist_index: {playlists: []}})});
  let config;
  const runtime = {confirm: async (message, options) => {assert.match(message, /music files will remain/); config = options; return true;}};
  assert.equal(await loaded.exports.confirmPlaylistDelete(runtime, controller), true);
  assert.equal(config.title, 'Delete playlist'); assert.equal(config.acceptLabel, 'Delete'); assert.equal(config.danger, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].revision, '2'); assert.equal(controller.getSnapshot().selectedPlaylistId, null); controller.dispose();
});
test('Delete is owner-only and stale confirmation never acts on a replacement resource or actor', async () => {
  for (const replace of [controller => controller.accept(payload(), 'p'), controller => controller.setScope('other'), controller => controller.accept(payload(false), 'p')]) {
    let resolve, calls = 0; const controller = create({deletePlaylist: async () => {calls++; return {ok: true};}});
    const pending = loaded.exports.confirmPlaylistDelete({confirm: () => new Promise(done => {resolve = done;})}, controller);
    replace(controller); resolve(true); assert.equal(await pending, false); assert.equal(calls, 0); controller.dispose();
  }
  const controller = create({deletePlaylist: async () => {throw Error('Must not write');}}); controller.accept(payload(false), 'p');
  assert.equal(await loaded.exports.confirmPlaylistDelete({confirm: () => {throw Error('Must not confirm');}}, controller), false); controller.dispose();
});

test('native Delete refusal or failure leaves the current playlist untouched', async () => {
  let calls = 0; const controller = create({deletePlaylist: async () => {calls++; return {ok: true};}});
  assert.equal(await loaded.exports.confirmPlaylistDelete({confirm: async () => false}, controller), false);
  assert.equal(await loaded.exports.confirmPlaylistDelete({confirm: async () => {throw Error('Native confirmation failed');}}, controller), false);
  assert.equal(calls, 0); assert.equal(controller.getSnapshot().selectedPlaylistId, 'p'); controller.dispose();
});

const React = require('react');
const elements = tree => React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : [];
const button = (tree, name) => elements(tree).find(node => node.type?.name === 'Button' && node.props.children === name);
const choice = (tree, label) => elements(tree).find(node => node.type?.name === 'NativeChoice' && node.props.label === label);
const preference = {remember_order_mode: true, last_order_mode: 'shuffle', effective_order_mode: 'shuffle', revision: '1'};
const flush = async () => {for (let index = 0; index < 5; index++) await Promise.resolve();};
function settingsFixture(controller, initialProviders) {
  const slots = []; let cursor = 0, effects = [], disposed = false, late = 0, providers = initialProviders;
  const hooks = {...React,
    useRef(value) {return slots[cursor++] ||= {current: value};},
    useState(initial) {const slot = slots[cursor++] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, next => {if (disposed) late++; slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
  };
  hooks.useEffect = hooks.useLayoutEffect = (effect, deps) => {
    const index = cursor++, old = slots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});
  };
  const component = {exports: {}}; vm.runInNewContext(built, {module: component, exports: component.exports,
    require: name => name === 'react' ? hooks : require(name), AbortController});
  return {render(next = providers) {providers = next; cursor = 0; effects = [];
    const tree = component.exports.PlaylistSettings({runtime: {}, controller, state: controller.getSnapshot(), providers, onClose() {}});
    for (const effect of effects) effect(); return tree.props.children(() => {});
  }, unmount() {disposed = true; for (const slot of slots) slot.cleanup?.();}, late: () => late};
}
test('settings native controls block stale provider ABA handlers and unmount aborts preference writes', async () => {
  let writes = 0, signal, finish;
  const providers = {readPlaylistPreferences: async () => ({scopeKey: 'scope', preferences: preference}),
    savePlaylistPreferences: input => {writes++; signal = input.signal; return new Promise(resolve => {finish = resolve;});}};
  const controller = create({}), f = settingsFixture(controller, providers); f.render(); await flush();
  choice(f.render(), 'Remember Regular or Shuffle').props.onChange('off');
  const stale = button(f.render(), 'Save playback preference').props.onClick;
  f.render({...providers}); f.render(providers); await flush();
  await stale(); assert.equal(writes, 0);
  choice(f.render(), 'Remember Regular or Shuffle').props.onChange('off');
  const save = button(f.render(), 'Save playback preference').props.onClick, pending = save();
  await save(); assert.equal(writes, 1); f.unmount(); assert.equal(signal.aborted, true);
  finish({scopeKey: 'scope', preferences: {...preference, remember_order_mode: false, effective_order_mode: 'regular', revision: '2'}});
  await pending; assert.equal(f.late(), 0); controller.dispose();
});
test('obsolete settings effects do not begin reads after replacement and unsaved metadata prevents sort conflicts', async () => {
  let oldReads = 0, newReads = 0;
  const old = {readPlaylistPreferences: async () => {oldReads++; return {scopeKey: 'scope', preferences: preference};}};
  const next = {readPlaylistPreferences: async () => {newReads++; return {scopeKey: 'scope', preferences: preference};}};
  const controller = create({saveDefaultSort() {}}), f = settingsFixture(controller, old);
  f.render(); f.render(next); await flush(); assert.equal(oldReads, 0); assert.equal(newReads, 1);
  controller.edit({description: 'Unsaved text'});
  const tree = f.render(); assert.equal(choice(tree, 'Saved default sort').props.disabled, true);
  assert.equal(button(tree, 'Save default sort').props.disabled, true); f.unmount(); controller.dispose();
});

test('an unchanged metadata draft cannot become a conflict after this account saves settings', async () => {
  const controller = create({saveDefaultSort: async () => ({ok: true}), readPlaylists: async () => {
    const value = payload(); value.playlist_detail.revision = '3'; value.playlist_detail.saved_default_sort = {key: 'duration', direction: 'asc'}; return value;
  }});
  controller.edit({description: ''}); assert.ok(model.playlistDraft(controller.getSnapshot()));
  assert.equal(model.draftDirty(controller.getSnapshot().resource.data.detail, model.playlistDraft(controller.getSnapshot())), false);
  assert.equal(await controller.mutate('saveDefaultSort', {sort: {key: 'duration', direction: 'asc'}}), true);
  assert.equal(model.playlistDraft(controller.getSnapshot()), null); assert.equal(controller.getSnapshot().resource.data.detail.revision, '3'); controller.dispose();
});
