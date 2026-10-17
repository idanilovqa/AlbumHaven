const test = require('node:test');
const assert = require('node:assert/strict');
const {actionFixture, flush} = require('./playlist-native-actions-fixture.cjs');
let model, settings;
test.before(async () => {
  model = await import('../../../music_app/static/js/playlists/model.mjs');
  settings = await import('../../../music_app/static/js/playlists/native-settings.mjs');
});
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
  assert.equal(await settings.confirmPlaylistDelete(runtime, controller), true);
  assert.equal(config.title, 'Delete playlist'); assert.equal(config.acceptLabel, 'Delete'); assert.equal(config.danger, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].revision, '2'); assert.equal(controller.getSnapshot().selectedPlaylistId, null); controller.dispose();
});
test('Delete is owner-only and stale confirmation never acts on a replacement resource or actor', async () => {
  for (const replace of [controller => controller.accept(payload(), 'p'), controller => controller.setScope('other'), controller => controller.accept(payload(false), 'p')]) {
    let resolve, calls = 0; const controller = create({deletePlaylist: async () => {calls++; return {ok: true};}});
    const pending = settings.confirmPlaylistDelete({confirm: () => new Promise(done => {resolve = done;})}, controller);
    replace(controller); resolve(true); assert.equal(await pending, false); assert.equal(calls, 0); controller.dispose();
  }
  const controller = create({deletePlaylist: async () => {throw Error('Must not write');}}); controller.accept(payload(false), 'p');
  assert.equal(await settings.confirmPlaylistDelete({confirm: () => {throw Error('Must not confirm');}}, controller), false); controller.dispose();
});

test('native Delete refusal or failure leaves the current playlist untouched', async () => {
  let calls = 0; const controller = create({deletePlaylist: async () => {calls++; return {ok: true};}});
  assert.equal(await settings.confirmPlaylistDelete({confirm: async () => false}, controller), false);
  assert.equal(await settings.confirmPlaylistDelete({confirm: async () => {throw Error('Native confirmation failed');}}, controller), false);
  assert.equal(calls, 0); assert.equal(controller.getSnapshot().selectedPlaylistId, 'p'); controller.dispose();
});

const preference = {remember_order_mode: true, last_order_mode: 'shuffle', effective_order_mode: 'shuffle', revision: '1'};
function settingsFixture(t, controller, initialProviders) {
  const env = actionFixture(); let providers = initialProviders, owner;
  const render = (next = providers) => {
    providers = next;
    const props = {controller, state: controller.getSnapshot(), providers, onClose() {}};
    if (owner) owner.update(props); else owner = settings.mountPlaylistSettings(env.host, env.runtime, props);
    return env.document.body;
  };
  let disposed = false;
  const unmount = () => {if (!disposed) {disposed = true; owner?.dispose();}};
  t.after(unmount);
  return {...env, render, unmount};
}
test('settings native controls block stale provider ABA handlers and unmount aborts preference writes', async t => {
  let writes = 0, signal, finish;
  const providers = {readPlaylistPreferences: async () => ({scopeKey: 'scope', preferences: preference}),
    savePlaylistPreferences: input => {writes++; signal = input.signal; return new Promise(resolve => {finish = resolve;});}};
  const controller = create({}); let f = settingsFixture(t, controller, providers); f.render(); await flush();
  f.choose('Remember Regular or Shuffle', 'off');
  const stale = f.button('Save playback preference');
  f.render({...providers}); f.render(providers); await flush();
  f.click(stale); assert.equal(writes, 0);
  f.unmount(); await flush(); f = settingsFixture(t, controller, providers); f.render(); await flush();
  f.choose('Remember Regular or Shuffle', 'off');
  f.click(stale); assert.equal(writes, 0); // Retired owner cannot write even when the replacement can.
  const save = f.button('Save playback preference'); f.click(save);
  f.click(save); assert.equal(writes, 1); f.unmount(); assert.equal(signal.aborted, true);
  await flush(); const retired = f.document.body.innerHTML;
  const mutations = f.mutations.length, attributes = f.attributeMutations.length;
  finish({scopeKey: 'scope', preferences: {...preference, remember_order_mode: false, effective_order_mode: 'regular', revision: '2'}});
  await flush(); assert.equal(f.document.body.innerHTML, retired);
  assert.equal(f.mutations.length, mutations); assert.equal(f.attributeMutations.length, attributes);
  f.click(save); assert.equal(writes, 1); controller.dispose();
});
test('obsolete settings effects do not begin reads after replacement and unsaved metadata prevents sort conflicts', async t => {
  let oldReads = 0, newReads = 0, oldSignal, resolveOld;
  const events = [];
  const old = {readPlaylistPreferences: ({signal}) => {oldReads++; oldSignal = signal; events.push('old-read');
    signal.addEventListener('abort', () => events.push('old-abort'));
    return new Promise(resolve => {resolveOld = resolve;});}};
  const next = {readPlaylistPreferences: async () => {assert.equal(oldSignal.aborted, true); newReads++; events.push('new-read');
    return {scopeKey: 'scope', preferences: preference};}};
  const controller = create({saveDefaultSort() {}}), f = settingsFixture(t, controller, old);
  f.render(); f.render(next); await flush();
  // Native acquisition is synchronous; the replaced read must retire before the
  // new one starts and its completion cannot overwrite the current preference.
  assert.equal(oldReads, 1); assert.equal(newReads, 1);
  assert.deepEqual(events, ['old-read', 'old-abort', 'new-read']);
  resolveOld({scopeKey: 'scope', preferences: {...preference, remember_order_mode: false}}); await flush();
  assert.match(f.choice('Remember Regular or Shuffle').getAttribute('aria-label'), /On/);
  assert.equal(oldReads, 1); assert.equal(newReads, 1);
  controller.edit({description: 'Unsaved text'}); f.render();
  assert.equal(f.choice('Saved default sort').disabled, true);
  assert.equal(f.button('Save default sort').disabled, true); f.unmount(); controller.dispose();
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
