'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('./native-home-harness.cjs');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');

async function fixture(t, {empty = false, inlineNavigation = false, service = N.service()} = {}) {
  const env = actualChoiceEnvironment({inlineNavigation}), c = env.context, mediaCalls = [];
  for (const file of ['loop-range-controls.js', 'playback-control-cluster.js']) vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), c, {filename: file});
  if (!inlineNavigation) N.shell(env);
  const rejectMedia = name => () => {mediaCalls.push(name); assert.fail(`Presentation must not call playback ${name}`);};
  Object.assign(env.runtime, {
    // This presentation suite never crosses the audio admission boundary.
    // Real provider/player/session command coverage is in the session suite.
    playback: {captureScope: rejectMedia('captureScope'), configure: rejectMedia('configure')},
    playbackControlHtml: c.renderPlaybackControlCluster,
    playbackControlElements: c.getPlaybackControlClusterElements,
    mountPlaybackOptions: c.mountLoopEditActionControl,
  });
  service.data.detail = F.detail({...(empty ? {items: [], completion_summary: {completed: 0, total: 0}} : {}),
    ...(inlineNavigation ? {allowed_actions: N.permissions()} : {})});
  const controller = await N.preparedController(service, {scopeKey: env.runtime.snapshot().scopeKey});
  const mounted = await N.connectedView(env, service, controller);
  t.after(async () => {mounted.dispose(); await settle(); env.assertClean();
    // The UI catches failed admission. A swallowed boundary error still fails.
    assert.deepEqual(mediaCalls, [], 'presentation never starts or configures media');});
  return {...env, service, controller, mounted, mediaCalls};
}

test('saved Top reuses the actual capsule, header progress slot and mixed Choice menu', async t => {
  const f = await fixture(t), root = f.host.querySelector('.collection-play-cluster'), play = root.querySelector('[data-playback-control-action="play"]');
  assert.ok(root.closest('.home-header__resource-playback'));
  assert.ok(f.host.querySelector('.home-header__resource-progress .album-progress'));
  assert.equal(play.disabled, false); assert.equal(root.getAttribute('data-collection-resource-kind'), 'album_top');
  assert.match(play.getAttribute('aria-label'), /Play Top from the beginning: Play Top in order/);
  play.focus();
  assert.equal(root.getAttribute('data-loop-action-engaged'), 'true');
  const options = root.querySelector('[data-playback-control-action="options"]'); f.click(options);
  const menu = f.document.querySelector('[role="menu"][aria-label="Top playback options"]');
  assert.ok(menu); const rows = menu.querySelectorAll('[data-foobar-format]');
  assert.deepEqual(rows.map(row => row.getAttribute('data-foobar-format')), ['in_order', 'random_albums', 'random_songs', 'popular_songs', 'stop']);
  assert.equal(rows[3].disabled, false); assert.equal(rows[4].getAttribute('role'), 'menuitemcheckbox');
  assert.equal(rows[0].getAttribute('aria-checked'), 'true'); assert.equal(rows[4].getAttribute('aria-checked'), 'false');
  f.click(rows[1]); assert.equal(root.querySelector('[data-playback-mode-badge]').textContent, 'A');
  f.click(options); f.click(f.document.querySelector('[data-foobar-format="stop"]'));
  assert.match(play.getAttribute('aria-label'), /Random albums, stop after current album/);
  f.click(options);
  assert.equal(f.document.querySelector('[data-foobar-format="random_albums"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.document.querySelector('[data-foobar-format="stop"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.service.count('execute'), 0, 'mode presentation cannot mutate curator membership');
});

test('true-empty Top disables Play and hides its mode disclosure', async t => {
  const f = await fixture(t, {empty: true}), root = f.host.querySelector('.collection-play-cluster');
  assert.ok(root); assert.equal(root.querySelector('[data-playback-control-action="play"]').disabled, true);
  assert.equal(root.querySelector('[data-playback-control-loop-actions]').hidden, true);
  f.click(root.querySelector('[data-playback-control-action="play"]'));
  assert.equal(f.document.querySelector('[role="menu"][aria-label="Top playback options"]'), null);
});

test('directory retires saved Top Play controls and a later saved Top creates a new owner', async t => {
  const f = await fixture(t); f.controller.open(null); await settle();
  assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  assert.equal(f.host.querySelector('.home-header__resource-controls'), null);
  await f.controller.open(N.TOP); await settle();
  assert.ok(f.host.querySelector('.collection-play-cluster'));
});

test('inline Edit retires saved Top Play handlers and discarding restores fresh saved presentation', async t => {
  const f = await fixture(t, {inlineNavigation: true});
  assert.equal(f.runtime.registerDraftNavigation, f.context.AlbumHavenAlbumTopsRuntime.registerDraftNavigation);
  assert.equal(f.runtime.deferDraftNavigation, f.context.AlbumHavenAlbumTopsRuntime.deferDraftNavigation);
  const oldRoot = f.host.querySelector('.collection-play-cluster');
  const play = oldRoot.querySelector('[data-playback-control-action="play"]');
  const options = oldRoot.querySelector('[data-playback-control-action="options"]');
  const retainedHandlers = f.listeners().filter(row => row.type === 'click' && [play, options].includes(row.target));
  assert.equal(retainedHandlers.length, 2, 'retain the actual main Play and options callbacks');
  const choices = [], openChoice = f.runtime.openChoice;
  f.runtime.openChoice = (trigger, config) => {choices.push(config); return openChoice(trigger, config);};
  play.focus(); f.click(options); f.click(f.document.querySelector('[data-foobar-format="random_albums"]'));
  f.click(options); f.click(f.document.querySelector('[data-foobar-format="stop"]'));
  assert.equal(oldRoot.querySelector('[data-playback-mode-badge]').textContent, 'A');
  assert.match(play.getAttribute('aria-label'), /Random albums, stop after current album/);
  f.click(options);
  const oldMenu = f.document.querySelector('[role="menu"][aria-label="Top playback options"]');
  const oldChoice = oldMenu.querySelector('[data-foobar-format="random_songs"]'), oldSelect = choices.at(-1).onSelect;
  f.click(f.button(f.host, 'Edit Album Top'));
  const editor = f.host.querySelector('form.album-top-inline-edit'), name = editor.querySelector('[name="top-name"]');
  assert.equal(name.disabled, false); assert.equal(name.value, 'Saved Top');
  assert.equal(oldRoot.isConnected, false); assert.equal(oldMenu.isConnected, false);
  assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  assert.equal(f.host.querySelector('.home-header__resource-controls'), null);
  assert.equal(f.document.querySelector('[role="menu"][aria-label="Top playback options"]'), null);
  // Detached events and already-retained callbacks must both reject the old owner.
  f.click(play); f.click(options); f.click(oldChoice);
  for (const row of retainedHandlers) await row.callback.call(row.target, new f.context.Event('click'));
  assert.equal(oldSelect('random_songs'), false); assert.equal(oldSelect('stop'), false);
  await settle(); assert.deepEqual(f.mediaCalls, []);
  assert.equal(f.document.querySelector('[role="menu"][aria-label="Top playback options"]'), null);
  f.input(name, 'Unsaved Top'); f.click(f.button(editor, 'Cancel')); await settle();
  assert.equal(f.document.getElementById('app-confirm-modal').hidden, false);
  assert.match(f.document.getElementById('app-confirm-modal').textContent, /Discard these unsaved Album Top changes/);
  f.click(f.document.getElementById('app-confirm-cancel')); await settle();
  assert.equal(editor.isConnected, true); assert.equal(name.value, 'Unsaved Top');
  assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  f.click(f.button(editor, 'Cancel')); await settle();
  assert.equal(f.document.getElementById('app-confirm-modal').hidden, false);
  f.click(f.document.getElementById('app-confirm-accept')); await settle();
  assert.equal(editor.isConnected, false); assert.equal(f.host.querySelector('form.album-top-inline-edit'), null);
  assert.equal(f.host.querySelector('.gallery-bar__title').textContent, 'Saved Top');
  const restored = f.host.querySelector('.collection-play-cluster'); assert.ok(restored); assert.notEqual(restored, oldRoot);
  const restoredPlay = restored.querySelector('[data-playback-control-action="play"]');
  assert.equal(restoredPlay.disabled, false); assert.equal(restored.querySelector('[data-playback-mode-badge]').textContent, '1');
  assert.equal(restoredPlay.getAttribute('aria-label'), 'Play Top from the beginning: Play Top in order');
  assert.equal(f.host.querySelector('.home-header__resource-progress [role="progressbar"]').getAttribute('aria-valuetext'), '1 of 2 albums completed');
  for (const row of retainedHandlers) await row.callback.call(row.target, new f.context.Event('click'));
  assert.equal(oldSelect('random_songs'), false); assert.equal(oldSelect('stop'), false);
  restoredPlay.focus(); f.click(restored.querySelector('[data-playback-control-action="options"]'));
  assert.equal(f.document.querySelector('[data-foobar-format="in_order"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.document.querySelector('[data-foobar-format="stop"]').getAttribute('aria-checked'), 'false');
  f.click(f.document.querySelector('[data-foobar-format="random_songs"]'));
  assert.equal(restored.querySelector('[data-playback-mode-badge]').textContent, 'S');
  assert.equal(f.service.count('execute'), 0); assert.deepEqual(f.mediaCalls, []);
  assert.equal(f.modal().hidden, true); assert.equal(f.opens.length, 0);
  assert.equal(f.runtime.deferDraftNavigation(() => assert.fail('Discarded editor retained navigation')), false);
});

test('inline Save keeps Play absent through write and refresh before restoring the saved Top', async t => {
  const write = N.deferred(), refresh = N.deferred(); let refreshing = false;
  const service = N.service({execute: () => write.promise,
    read: ref => refreshing ? refresh.promise : Promise.resolve({...service.data.detail, top_ref: ref})});
  const f = await fixture(t, {inlineNavigation: true, service});
  const oldRoot = f.host.querySelector('.collection-play-cluster');
  const oldPlay = oldRoot.querySelector('[data-playback-control-action="play"]');
  oldPlay.focus(); f.click(oldRoot.querySelector('[data-playback-control-action="options"]'));
  f.click(f.document.querySelector('[data-foobar-format="random_songs"]'));
  assert.equal(oldRoot.querySelector('[data-playback-mode-badge]').textContent, 'S');
  f.click(f.button(f.host, 'Edit Album Top'));
  const editor = f.host.querySelector('form.album-top-inline-edit');
  assert.equal(oldRoot.isConnected, false); assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  f.input(editor.querySelector('[name="top-name"]'), 'Renamed saved Top');
  assert.equal(f.button(editor, 'Save').disabled, false);
  editor.dispatchEvent(new f.context.Event('submit'));
  assert.equal(service.count('execute'), 1); assert.equal(f.button(editor, 'Save').disabled, true);
  const [action, command] = service.calls.find(call => call.method === 'execute').args;
  assert.equal(action, 'save'); assert.equal(command.top_ref, N.TOP); assert.equal(command.revision, '7');
  assert.equal(command.title, 'Renamed saved Top');
  assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  assert.equal(f.host.querySelector('.home-header__resource-controls'), null);
  f.click(oldPlay); await settle(); assert.deepEqual(f.mediaCalls, []);
  service.data.detail = F.detail({title: command.title, revision: '8', allowed_actions: N.permissions()});
  refreshing = true;
  write.resolve({action, request_key: command.request_key, top_ref: N.TOP, revision: '8'}); await settle();
  assert.equal(f.controller.getSnapshot().mutation.refreshing, true);
  assert.equal(f.controller.getSnapshot().detail.status, 'loading'); assert.equal(editor.isConnected, true);
  assert.equal(f.host.querySelector('.collection-play-cluster'), null);
  assert.equal(f.host.querySelector('.home-header__resource-controls'), null);
  refresh.resolve(service.data.detail); await settle();
  assert.equal(editor.isConnected, false); assert.equal(f.host.querySelector('form.album-top-inline-edit'), null);
  assert.equal(f.controller.getSnapshot().detail.data.revision, '8');
  assert.equal(f.host.querySelector('.gallery-bar__title').textContent, 'Renamed saved Top');
  const restored = f.host.querySelector('.collection-play-cluster'); assert.ok(restored); assert.notEqual(restored, oldRoot);
  const play = restored.querySelector('[data-playback-control-action="play"]');
  assert.equal(play.disabled, false); assert.equal(restored.querySelector('[data-playback-mode-badge]').textContent, '1');
  assert.equal(play.getAttribute('aria-label'), 'Play Top from the beginning: Play Top in order');
  assert.equal(f.host.querySelector('.home-header__resource-progress [role="progressbar"]').getAttribute('aria-valuetext'), '1 of 2 albums completed');
  play.focus(); f.click(restored.querySelector('[data-playback-control-action="options"]'));
  assert.equal(f.document.querySelector('[data-foobar-format="in_order"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.document.querySelector('[data-foobar-format="stop"]').getAttribute('aria-checked'), 'false');
  f.click(f.document.querySelector('[data-foobar-format="random_albums"]'));
  assert.equal(restored.querySelector('[data-playback-mode-badge]').textContent, 'A');
  assert.equal(service.count('execute'), 1); assert.deepEqual(f.mediaCalls, []);
  assert.equal(f.modal().hidden, true); assert.equal(f.opens.length, 0);
  assert.equal(f.runtime.deferDraftNavigation(() => assert.fail('Saved editor retained navigation')), false);
});

test('shared header refuses playback composition for Goals and ordinary widget headers', async t => {
  const f = actualChoiceEnvironment(), {mountSharedHeader} = await N.load('home-friends/shared-header.mjs');
  const header = mountSharedHeader(f.host, f.runtime, {id: 'goal-widget', resourceKind: 'goal'});
  const marker = f.document.createElement('button'); marker.textContent = 'Play'; header.slots.resourcePlayback.append(marker);
  assert.equal(f.host.contains(marker), false);
  header.update({id: 'goal-widget', resourceKind: 'album_top'}); assert.equal(f.host.contains(marker), true);
  header.update({id: 'goal-widget', resourceKind: 'goal'}); assert.equal(f.host.contains(marker), false);
  header.dispose(); await settle(); f.assertClean();
});

test('switching saved Tops retires the old mode menu and resets unstarted presentation', async t => {
  const f = await fixture(t), options = f.host.querySelector('[data-playback-control-action="options"]');
  f.host.querySelector('[data-playback-control-action="play"]').focus(); f.click(options);
  const old = f.document.querySelector('[data-foobar-format="random_songs"]');
  await f.controller.open(N.OTHER); await settle();
  assert.equal(old.isConnected, false); assert.equal(f.document.querySelector('[role="menu"][aria-label="Top playback options"]'), null);
  f.click(old);
  assert.equal(f.host.querySelector('[data-playback-mode-badge]').textContent, '1');
  assert.equal(f.service.count('execute'), 0);
});

test('initial capsule renderer failure retires the allocated native header and view owners', async () => {
  const f = actualChoiceEnvironment(), service = N.service(); service.data.detail = F.detail(); N.shell(f);
  const controller = await N.preparedController(service), {mountAlbumTopsView} = await N.load('album-tops/app.mjs');
  const failure = new Error('Injected renderer boundary failure');
  f.runtime.playback = {captureScope() {assert.fail('Failed renderer must not start media');}};
  f.runtime.playbackControlHtml = () => {throw failure;};
  assert.throws(() => mountAlbumTopsView(f.host, f.runtime, {controller, providers: service.providers,
    state: controller.getSnapshot(), onOpen() {}}), error => error === failure);
  assert.equal(f.host.children.length, 0); controller.dispose(); await settle(); f.assertClean();
});

test('shared collection geometry reserves the upper disclosure row without moving the title or progress', () => {
  const header = readRepo('music_app/static/css/runtime/home-friends.css');
  const capsule = readRepo('music_app/static/css/runtime/non-album-and-player.css');
  assert.match(header, /\.home-header__resource-controls\s*\{[^}]*grid-template-rows:\s*44px 20px/);
  assert.match(header, /\.home-header__resource-playback\s*\{[^}]*grid-row:\s*1 \/ 3/);
  assert.match(header, /\.home-header__resource-progress\s*\{[^}]*grid-row:\s*2/);
  assert.match(capsule, /\.collection-play-cluster::after\s*\{[^}]*position:\s*absolute[^}]*height:\s*44px/);
  assert.match(capsule, /\.collection-play:disabled\s*\{[^}]*background:\s*var\(--app-disabled, var\(--panel-2\)\)/);
  assert.match(capsule, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.collection-play-cluster::after\s*\{\s*transition:\s*none/);
});
