'use strict';
// Platform and synthetic HTTP responses only. All history owners, native
// transport, CSRF wrapper, button owner and track dispatcher are actual sources.
// The controlled activation boundary records a detached button instead of
// acquiring an audio device, network media, player state, storage or user data.
const assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs');
const N = require('./foobar-account-history-native-fixture.cjs');
const VERSION = 'foobar_account_history_native_v1', NATIVE_CONTEXT = 'c'.repeat(64);
const target = patch => ({track_ref: '/synthetic/library-one/track.flac', path: '/synthetic/library-one/track.flac', title: 'Native title', artist: 'Native artist', album_title: 'Native album', duration_seconds: 123.5, inventory_track_ref: 'inventory-track:1:9', playback_state: {can_start_here: true}, ...patch});
const envelope = (operation, result, context = NATIVE_CONTEXT) => ({protocol: VERSION, operation, context_ref: context, result});
async function platform(t, options = {}) {
  const cleanup = [], f = await N.platform({after(callback) {cleanup.push(callback);}}, options);
  f.view.dispose();
  const {c, document, host} = f;
  const shell = document.createElement('div'); shell.id = 'app-shell';
  shell.dataset.privateUiContext = NATIVE_CONTEXT; shell.dataset.nativeAccountId = 'synthetic-owner'; shell.dataset.nativeLibraryId = '1'; document.body.append(shell);
  c.Headers = Headers; c.location = {href: 'https://albumhaven.invalid/', origin: 'https://albumhaven.invalid'};
  document.cookie = '__Host-album_haven_csrf=synthetic-csrf';
  c.state = {player: {current: null}};
  const activations = [], storage = [];
  c.activateSharedTrackButton = (button, activationOptions) => {
    assert.equal(button.isConnected, false, 'Native dispatcher target stays detached from public history DOM');
    activations.push({button, options: {...activationOptions}});
  };
  for (const name of ['localStorage', 'sessionStorage']) c[name] = {setItem(...args) {storage.push([name, ...args]); throw new Error('Storage forbidden in this slice');}, getItem() {throw new Error('Storage read forbidden in this slice');}};
  let media = true, current = true, capabilityHook = null;
  c.AlbumHavenCapabilities = {allows(action) {capabilityHook?.(action); return action === 'library.media.read' && media;}};
  for (const name of ['session-csrf-fetch.js', 'private-ui-transport.js', 'track-actions.js']) {
    const relative = 'music_app/static/js/runtime/' + name;
    H.vm.runInContext(H.read(relative), c, {filename: relative});
  }
  const transport = c.AlbumHavenPrivateUITransport;
  // Retrieve the genuine classic-script lexical owner, never a window alias.
  const nativeTracks = H.vm.runInContext('TrackActionsRuntime', c);
  assert.equal(c.TrackActionsRuntime, undefined);
  assert.equal(transport, c.AlbumHavenPrivateUITransport);
  const {createFoobarHistoryNativeActions} = await H.load('native-actions.mjs');
  const {mountFoobarHistoryPanel} = await H.load('panel.mjs');
  let actions;
  const props = {owner: f.owner, isCurrent: () => current, createNativeActions: ({controller, isCurrent}) => {
    actions = createFoobarHistoryNativeActions({controller, transport, tracks: nativeTracks,
      isCurrent: () => current && isCurrent() && f.root.isConnected
        && f.root.dataset.accountFoobarContext === H.STAMP && f.root.dataset.accountFoobarScope === H.SCOPE
        && f.root.dataset.accountFoobarHistoryAllowed === 'true'});
    return actions;
  }};
  const view = mountFoobarHistoryPanel(host, {buttonHtml: value => c.ButtonComponent.renderButton(value)}, props);
  await H.settle();
  t.after(() => {
    try {view.dispose(); actions.dispose(); /* Home transport has no disposal API. */ assert.equal(storage.length, 0);}
    finally {for (const callback of cleanup) callback();}
  });
  const row = (index = 0) => f.owner.controller.getSnapshot().page.items[index];
  const nativeCalls = () => f.wire.calls.filter(call => call.route.startsWith('/history/native/'));
  const eligible = (item = row(), allowed = true, context = NATIVE_CONTEXT) => envelope('eligibility', [{observation_ref: item.observation_ref, can_attempt_play: allowed}], context);
  const check = async (item = row(), allowed = true) => {f.wire.enqueue('/history/native/eligibility', eligible(item, allowed)); await actions.check(item);};
  const play = async (value = target(), item = row()) => {f.wire.enqueue('/history/native/play', envelope('play', value)); await actions.play(item);};
  return {...f, view, actions, transport, nativeTracks, shell, activations, storage, row, nativeCalls, eligible, check, play,
    current(value) {current = value;}, media(value) {media = value;}, capabilityHook(value) {capabilityHook = value;},
    update() {view.update(props);}, nativeButtons() {return host.querySelectorAll('.foobar-history__row').map(element => element.querySelector('button'));}};
}
function genuineDispatcher(f) {
  const {c, document} = f;
  c.state.modalReleases = [{key: 'unrelated-modal-album', tracks: [{path: '/synthetic/unrelated/one.flac', title: 'Unrelated', track_number: 1, disc_number: 1, duration_seconds: 60}]}];
  c.state.modalReleaseIndex = 0; c.state.view = {};
  const ownership = {};
  c.capturePlaybackOwnershipScope = () => ownership;
  c.isPlaybackOwnershipScopeCurrent = value => value === ownership;
  c.PLAYBACK_CAPTURE_ENABLED = true;
  f.shell.dataset.listeningSelectionsEnabled = 'true';
  for (const name of ['track-modal-lightbox-helpers.js', 'tag-editor-and-optimistic-updates.js', 'player-loop-playback.js']) {
    const relative = 'music_app/static/js/runtime/' + name;
    H.vm.runInContext(H.read(relative), c, {filename: relative});
  }
  // Everything through activateSharedTrackButton, modal ownership, ordinary
  // Album intent and ordinary queue construction above remains genuine. Only
  // the media-start boundary is replaced; there is no audio or app boot here.
  const starts = [];
  c.playTrackFromPayload = value => {starts.push(value); return Promise.resolve();};
  c.getPlayerPlaybackSnapshot = () => ({src: '', paused: true});
  c.getPlayerElements = () => ({});
  const modal = document.createElement('section'); modal.id = 'track-modal'; modal.hidden = false; document.body.append(modal);
  return {starts, modal, album: c.state.modalReleases[0]};
}
module.exports = {...H, platform, genuineDispatcher, VERSION, NATIVE_CONTEXT, target, envelope};
