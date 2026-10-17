const test = require('node:test');
const assert = require('node:assert/strict');
const {filterFixture} = require('./playlist-filter-native-fixture.cjs');
let model, mountPlaylistsView, createPlaylistFilterSession;
test.before(async () => {
  model = await import('../../../music_app/static/js/playlists/model.mjs');
  ({mountPlaylistsView} = await import('../../../music_app/static/js/playlists/native-app.mjs'));
  ({createPlaylistFilterSession} = await import('../../../music_app/static/js/playlists/native-filter-session.mjs'));
});
const payload = id => ({playlist_sidebar: {items: ['A', 'B'].map(playlist_id => ({playlist_id, title: playlist_id,
  allowed_actions: {can_open: true}}))}, playlist_detail: {playlist_id: id, title: id, revision: 'revision',
  description: '', track_rows: [], items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'},
  allowed_actions: {can_open: true, can_edit: true, can_rename: true}}});
const session = (providers = {}) => {
  const controller = model.createPlaylistController({providers}); controller.setScope('actor:library');
  controller.accept(payload('A'), 'A'); return controller;
};
function viewFixture(controller) {
  const env = filterFixture(); let current = controller, providers = {}, owner;
  const props = () => ({runtime: env.runtime, controller: current, state: current.getSnapshot(), integrationProviders: providers, onSelect() {}});
  return {...env,
    render(next = current, nextProviders = providers) {
      current = next; providers = nextProviders;
      if (owner) owner.update(props()); else owner = mountPlaylistsView(env.host, env.runtime, props());
      return env.host;
    },
    surface: () => env.host.querySelector('#playlists-filters'),
    header: () => env.host.querySelector('[data-playlists-action="filters"]'),
    retainChange() {
      const input = env.host.querySelector('#playlists-filter-search'); assert.ok(input);
      const listener = env.listeners().find(entry => entry.type === 'input' && entry.target.classList?.contains('playlists-filter__search'));
      assert.ok(listener, 'retain the actual native Search input listener');
      return patch => {input.value = patch.query; listener.callback({target: input});};
    },
    retainClose() {
      const section = env.host.querySelector('#playlists-filters'); assert.ok(section);
      const listener = section.parentNode.listeners.find(entry => entry.type === 'keydown'); assert.ok(listener);
      return () => listener.callback(new env.context.Event('keydown', {key: 'Escape'}));
    },
    unmount() {owner.dispose();},
  };
}
async function open(view) {
  view.render(); view.click(view.header());
  const surface = view.surface(); assert.ok(surface); return surface;
}

test('actual Playlist controller A to B to A navigation retires the old open session even between native updates', async () => {
  const controller = session(), view = viewFixture(controller); await open(view);
  controller.select('B', {load: false}); controller.accept(payload('B'), 'B');
  view.render(); assert.equal(view.surface(), null);
  controller.select('A', {load: false}); controller.accept(payload('A'), 'A');
  view.render(); assert.equal(view.surface(), null);
  await open(view);
  controller.select('B', {load: false}); controller.accept(payload('B'), 'B');
  controller.select('A', {load: false}); controller.accept(payload('A'), 'A');
  view.render(); assert.equal(view.surface(), null);
  view.unmount(); controller.dispose();
});

test('resource replacement and revoke/regrant cannot resurrect an old filter form or its stale callback', async () => {
  const controller = session(), view = viewFixture(controller);
  await open(view); let stale = view.retainChange();
  controller.accept(payload('A'), 'A'); stale({query: 'obsolete'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  view.render(); assert.equal(view.surface(), null);
  await open(view); stale = view.retainChange();
  controller.accept({status: 'denied'}, 'A'); controller.accept(payload('A'), 'A'); stale({query: 'revived'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  view.render(); assert.equal(view.surface(), null);
  view.unmount(); controller.dispose();
});

test('provider and controller replacement permanently retire open ownership while ordinary value edits keep it', async () => {
  const first = session(), second = session(), view = viewFixture(first);
  const surface = await open(view); view.retainChange()({query: 'current'});
  view.render(); assert.equal(view.surface(), surface);
  assert.equal(model.playlistFilters(first.getSnapshot()).query, 'current');
  const oldProviders = {}, newProviders = {readMatches() {}};
  view.render(first, oldProviders); await open(view);
  view.render(first, newProviders); assert.equal(view.surface(), null);
  view.render(first, oldProviders); assert.equal(view.surface(), null);
  await open(view);
  view.render(second, oldProviders); assert.equal(view.surface(), null);
  view.render(first, oldProviders); assert.equal(view.surface(), null);
  await open(view);
  first.configure({readPlaylists: async () => payload('A')}); first.accept(payload('A'), 'A');
  view.render(); assert.equal(view.surface(), null);
  view.unmount(); first.dispose(); second.dispose();
});

test('a retained filter callback rechecks live mutation status before changing view values', async () => {
  let resolveWrite;
  const controller = session({savePlaylist: () => new Promise(resolve => {resolveWrite = resolve;})}), view = viewFixture(controller);
  await open(view); const change = view.retainChange();
  controller.edit({title: 'Changed'}); const saving = controller.mutate('savePlaylist');
  assert.equal(controller.getSnapshot().mutation.status, 'loading');
  change({query: 'must not apply'}); assert.equal(model.playlistFilters(controller.getSnapshot()).query, '');
  resolveWrite({ok: false}); await saving;
  view.unmount(); controller.dispose();
});

test('a late close from a retired filter surface cannot close a newly opened session', async () => {
  const controller = session(), view = viewFixture(controller); await open(view);
  const oldClose = view.retainClose();
  controller.accept(payload('A'), 'A'); view.render();
  const next = await open(view);
  oldClose(); view.render(); assert.equal(view.surface(), next);
  view.unmount(); controller.dispose();
});

test('unmount retires retained filter changes and cannot reopen ownership through a stale header action', async () => {
  const controller = session(), view = viewFixture(controller); await open(view);
  const change = view.retainChange(), header = view.header();
  const listener = header.parentNode.listeners.find(entry => entry.type === 'click'); assert.ok(listener);
  view.unmount();
  change({query: 'after unmount'}); listener.callback({target: header}); change({query: 'after stale reopen'});
  assert.equal(model.playlistFilters(controller.getSnapshot()).query, ''); assert.equal(view.surface(), null);
  controller.dispose();
});

test('retained live header controls target only current ownership; retired filter sessions reject controller and provider ABA', async () => {
  const first = session(), second = session(), view = viewFixture(first), originalProviders = {}, replacementProviders = {readMatches() {}};
  view.render(first, originalProviders); const header = view.header();
  view.render(second, originalProviders); assert.equal(view.header(), header);
  view.click(header); assert.ok(view.surface()); view.retainChange()({query: 'second only'});
  assert.equal(model.playlistFilters(first.getSnapshot()).query, '');
  assert.equal(model.playlistFilters(second.getSnapshot()).query, 'second only');
  const retiredChange = view.retainChange();
  view.render(second, replacementProviders); retiredChange({query: 'obsolete provider'}); assert.equal(view.surface(), null);
  assert.equal(model.playlistFilters(second.getSnapshot()).query, 'second only');
  view.render(second, originalProviders); retiredChange({query: 'revived provider'}); assert.equal(view.surface(), null);
  assert.equal(model.playlistFilters(second.getSnapshot()).query, 'second only');
  await open(view);
  const identity = state => state.resource.status === 'ready' && state.resource.data?.detail
    ? [state.scopeKey, state.selectedPlaylistId, state.resource.data.detail] : null;
  const filters = createPlaylistFilterSession(first, identity, originalProviders);
  filters.toggle(); const firstOpening = filters.opening; assert.ok(firstOpening);
  filters.update(second, identity, originalProviders);
  assert.equal(filters.current(firstOpening), false); assert.equal(filters.sourceCurrent(firstOpening), false); assert.equal(filters.opening, null);
  filters.toggle(); const secondOpening = filters.opening; assert.ok(secondOpening);
  filters.update(second, identity, replacementProviders);
  assert.equal(filters.current(secondOpening), false); assert.equal(filters.opening, null);
  filters.update(second, identity, originalProviders);
  assert.equal(filters.current(secondOpening), false); assert.equal(filters.sourceCurrent(secondOpening), false); assert.equal(filters.opening, null);
  filters.toggle(); const current = filters.opening; filters.close(secondOpening); assert.equal(filters.opening, current);
  filters.dispose(); view.unmount(); view.click(header); assert.equal(view.surface(), null); first.dispose(); second.dispose();
});
