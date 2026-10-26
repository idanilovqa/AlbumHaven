'use strict';
// Source-authored only. These cases require the full pinned native composition.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');
const keys = f => f.host.querySelectorAll('.album-card').map(node => node.getAttribute('data-gallery-card-key'));
function admitted(data = F.detail()) {
  return {...data, top_viewer_overlay: {...data.top_viewer_overlay,
    item_listening_presentation: Object.fromEntries(data.items.map(row => [row.album_ref, {
      protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
      top_ref: data.top_ref, top_revision: data.revision, album_ref: row.album_ref,
      target: 5, target_preference_revision: null,
      predicates: {has_plays: true, listened: true, completed: false, rated: null},
      metrics: {full: {status: 'exact_recorded', value: 2}, partial: {status: 'exact_recorded', value: 12},
        tracks_at_target: {status: 'exact_recorded', value: 4}, uninterrupted_full: {status: 'exact_recorded', value: 1}},
    }]))}};
}
async function connected(t, data = admitted()) {
  const env = actualChoiceEnvironment(); env.context.AbortController = AbortController;
  env.context.innerWidth = 1200;
  env.context.getComputedStyle = () => ({display: 'block', columnGap: '8', overflowY: 'visible', getPropertyValue: () => ''});
  const menus = [];
  // Transparent observation of actual Choice; never substitute its callback logic.
  env.runtime.openChoice = (anchor, options) => {menus.push(options); return env.owner('openUtilityChoiceDropdown')(anchor, options);};
  const service = N.service(); service.data.detail = data;
  const controller = await N.preparedController(service), mounted = await N.connectedView(env, service, controller);
  t.after(() => {mounted.dispose(); env.cleanupChoiceGlobals();});
  const open = () => env.click(env.button(env.host, 'Filter'));
  const search = () => env.document.querySelector('.collection-filter-search input[type="search"]');
  const trigger = label => env.document.querySelectorAll('.ui-choice button').find(node => node.getAttribute('aria-label')?.startsWith(`${label}:`));
  const menu = label => {const button = trigger(label); assert.ok(button); assert.equal(button.disabled, false); env.click(button);
    const result = env.document.querySelector(`[role="menu"][aria-label="${label}"]`); assert.ok(result); return result;};
  const choose = (label, value) => {const option = menu(label).querySelector(`[data-foobar-format="${value}"]`); assert.ok(option); env.click(option);};
  return {...env, service, controller, mounted, menus, open, search, trigger, menu, choose};
}

test('same-Top evidence disappearance keeps Any status usable and preserves every other filter', async t => {
  const f = await connected(t); f.open();
  f.input(f.search(), 'Album 12'); f.choose('Sort', 'album'); f.choose('Direction', 'desc');
  f.choose('Manual completion', 'complete'); f.choose('Status', 'listened');
  assert.deepEqual(keys(f), [F.IB]);
  f.service.data.detail = F.detail({revision: '8'}); await f.controller.open(N.TOP);
  assert.deepEqual(keys(f), [F.IB]); assert.match(f.host.textContent, /Not a confirmed filter match/);
  assert.doesNotMatch(f.host.textContent, /No albums match these filters/);
  f.open(); assert.equal(f.search().value, 'Album 12');
  assert.equal(f.trigger('Status').getAttribute('aria-label'), 'Status: Listened');
  f.choose('Status', 'all');
  assert.deepEqual(keys(f), [F.IB]); assert.equal(f.search().value, 'Album 12');
  for (const label of ['Sort: Album', 'Direction: Descending', 'Manual completion: Manually completed'])
    assert.ok(f.document.querySelectorAll('.ui-choice button').some(button => button.getAttribute('aria-label') === label));
  assert.equal(f.service.count('execute'), 0);
  f.service.data.detail = admitted(F.detail({revision: '9'})); await f.controller.open(N.TOP);
  f.open(); assert.equal(f.trigger('Status').getAttribute('aria-label'), 'Status: Any status');
  f.choose('Status', 'listened'); assert.deepEqual(keys(f), [F.IB]);
});

test('partial predicate availability keeps unknown candidates discoverable and explicitly labels them', async t => {
  const data = admitted(); data.top_viewer_overlay.item_listening_presentation[F.A].predicates.listened = null;
  data.top_viewer_overlay.item_listening_presentation[F.B].predicates.listened = false;
  const f = await connected(t, data); f.open();
  const choices = f.menu('Status');
  assert.notEqual(choices.querySelector('[data-foobar-format="rated"]').getAttribute('aria-disabled'), 'true');
  f.click(choices.querySelector('[data-foobar-format="listened"]'));
  assert.deepEqual(keys(f), [F.IA]); assert.match(f.host.textContent, /Status unavailable from current evidence/);
  f.choose('Status', 'all'); assert.deepEqual(keys(f), [F.IA, F.IB]);
});

test('browse-only users without manual progress keep cards and safe status recovery', async t => {
  const data = F.detail({allowed_actions: {'library.browse.read': true, can_read: true}, top_viewer_overlay: undefined, completion_summary: null});
  const f = await connected(t, data); assert.deepEqual(keys(f), [F.IA, F.IB]);
  assert.equal(f.host.querySelector('[data-gallery-card-intent="complete"]'), null);
  assert.equal(f.host.querySelector('.album-top-listening-status'), null);
  f.open(); const choices = f.menu('Status');
  assert.notEqual(choices.querySelector('[data-foobar-format="all"]').getAttribute('aria-disabled'), 'true');
  for (const key of ['has_plays', 'listened', 'completed', 'rated'])
    assert.notEqual(choices.querySelector(`[data-foobar-format="${key}"]`).getAttribute('aria-disabled'), 'true');
  f.click(choices.querySelector('[data-foobar-format="all"]')); assert.deepEqual(keys(f), [F.IA, F.IB]);
  assert.equal(f.service.count('execute'), 0);
});

for (const permission of ['can_read', 'library.browse.read']) test(`denied ${permission} retires status menus and stale callbacks`, async t => {
  const f = await connected(t); f.open(); f.menu('Status'); const stale = f.menus.at(-1).onSelect;
  f.service.data.detail = F.detail({allowed_actions: {...F.detail().allowed_actions, [permission]: false}});
  await f.controller.open(N.TOP); const before = f.host.innerHTML;
  stale('completed'); assert.equal(f.host.innerHTML, before); assert.equal(f.search(), null);
  assert.equal(f.service.count('execute'), 0);
});

test('replacement Top and provider retire old status callbacks; new Top has default status', async t => {
  const f = await connected(t); f.open(); f.choose('Status', 'listened'); f.menu('Status');
  const stale = f.menus.at(-1).onSelect;
  await f.controller.open(N.OTHER); const before = keys(f); stale('completed'); assert.deepEqual(keys(f), before);
  f.open(); assert.equal(f.trigger('Status').getAttribute('aria-label'), 'Status: Any status');
  f.menu('Status'); const providerStale = f.menus.at(-1).onSelect;
  f.mounted.update({providers: {...f.service.providers}}); const replacement = keys(f);
  providerStale('completed'); assert.deepEqual(keys(f), replacement);
  f.mounted.dispose(); stale('all'); providerStale('all'); f.assertClean();
});

for (const mode of ['cards', 'list', 'covers']) test(`actual ${mode} gallery returns to original no-evidence bytes`, async t => {
  const f = await F.mounted(t, {shell: {galleryDisplayMode: mode}});
  const original = f.cards().map(card => card.outerHTML);
  const replace = data => f.setState({...f.getState(), detail: {status: 'ready', data}});
  replace(admitted()); assert.equal(f.host.querySelectorAll('.album-top-listening-status').length, 2);
  replace(F.detail()); assert.deepEqual(f.cards().map(card => card.outerHTML), original);
});

for (const action of ['open', 'complete']) test(`actual gallery retains focused ${action} while status decoration changes`, async t => {
  const f = await F.mounted(t, {data: admitted()}); const card = f.cards()[0], focused = F.intent(card, action); focused.focus();
  const data = admitted(); data.top_viewer_overlay.item_listening_presentation[F.A].metrics.full.value = 3;
  f.setState({...f.getState(), detail: {status: 'ready', data}});
  assert.equal(f.cards()[0], card); assert.equal(F.intent(card, action), focused); assert.equal(f.document.activeElement, focused);
  assert.match(card.querySelector('.album-top-listening-status').textContent, /^3 full/);
  f.setState({...f.getState(), detail: {status: 'ready', data: F.detail()}});
  assert.equal(F.intent(card, action), focused); assert.equal(f.document.activeElement, focused);
});

test('real provider and controller strip unactivated wire fields, including after refresh', async t => {
  const {createAlbumTopBackendProviders} = await N.load('album-tops/backend-providers.mjs');
  const {createAlbumTopController} = await N.load('album-tops/model.mjs');
  const context = 'a'.repeat(64), scope = JSON.stringify(['1', '2', context, 1]); let denied = false;
  const shaped = admitted(), wire = {...shaped, items: shaped.items.map(row => ({ref: row.item_ref, catalog_ref: row.album_ref,
    title: row.title, artist_display: row.artist, release_year: row.year, original_position: row.original_position, curator_position: row.position}))};
  wire.top_viewer_overlay.completed_target_preference = {status: 'saved', value: 5, revision: '9'};
  const calls = [], providers = createAlbumTopBackendProviders({acceptsScope: value => value === scope,
    transport: {context: () => context, generation: () => 1, async request(path, options) {
      calls.push({path, options}); if (denied) throw Object.assign(new Error('denied'), {status: 403});
      assert.equal(options.method, undefined); assert.equal(options.body, undefined);
      return {status: 'ready', context_ref: context, data: path.startsWith('/album-tops?')
        ? {tops: [wire], allowed_actions: wire.allowed_actions, next_cursor: null} : wire};
    }}});
  const controller = createAlbumTopController({providers}); t.after(() => {controller.dispose(); providers.dispose();});
  controller.setScope(scope); await controller.load(); await controller.open(F.TOP);
  const env = actualChoiceEnvironment(); env.context.AbortController = AbortController;
  const mounted = await N.connectedView(env, {providers}, controller); t.after(() => {mounted.dispose(); env.cleanupChoiceGlobals();});
  const check = () => {const detail = controller.getSnapshot().detail.data;
    assert.equal(detail.top_viewer_overlay.item_listening_presentation, undefined);
    assert.equal(detail.top_viewer_overlay.completed_target_preference, undefined);
    assert.equal(env.host.querySelector('.album-top-listening-status'), null);
    assert.deepEqual(keys(env), [F.IA, F.IB]);};
  check(); await controller.open(F.TOP); check();
  denied = true; await controller.open(F.TOP); assert.equal(controller.getSnapshot().detail.status, 'denied');
  assert.equal(env.host.querySelector('.album-top-listening-status'), null);
  assert.ok(calls.length >= 4);
});

test('target preference revision changes retire Completed while native full counts survive', async t => {
  const data = admitted();
  for (const value of Object.values(data.top_viewer_overlay.item_listening_presentation)) value.predicates.completed = true;
  const f = await connected(t, data); f.open(); f.choose('Status', 'completed');
  assert.deepEqual(keys(f), [F.IA, F.IB]);
  f.service.data.detail = {...data, top_viewer_overlay: {...data.top_viewer_overlay,
    completed_target_preference: {status: 'saved', value: 5, revision: '2'}}};
  await f.controller.open(N.TOP); assert.deepEqual(keys(f), [F.IA, F.IB]);
  assert.match(f.host.textContent, /Not a confirmed filter match/);
  f.open(); f.choose('Status', 'all'); assert.deepEqual(keys(f), [F.IA, F.IB]);
  const status = f.host.querySelector('.album-top-listening-status');
  assert.equal(status.textContent, '2 full · 12 partial · ? tracks at target');
  assert.match(status.getAttribute('aria-label'), /target.*unbound/);
});

test('actor scope change retires pending native status selection', async t => {
  const f = await connected(t); f.open(); f.choose('Status', 'listened'); f.menu('Status');
  const stale = f.menus.at(-1).onSelect;
  f.controller.setScope('replacement-account-session-library');
  await f.controller.load(); await f.controller.open(N.TOP);
  const before = keys(f); stale('completed'); assert.deepEqual(keys(f), before);
  f.open(); assert.equal(f.trigger('Status').getAttribute('aria-label'), 'Status: Any status');
  assert.equal(f.service.count('execute'), 0);
});
