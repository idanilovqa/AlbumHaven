'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const base = require('./actual-runtime.cjs');

// Additive composition only. Network replies and DOM geometry are synthetic
// inputs. Search, transport, admission, native selection, ResourceSelection,
// modal rendering, TrackActions, player activation and streaming start stay real.
// Audio output is deliberately unavailable at the browser device boundary; the
// playback cases prove command handoff, never an audio device or sound output.
async function actionFixture(t, {media = true, entry = false, mobile = false, ...options} = {}) {
  const h = base.fixture(t, options), {c, document} = h;
  c.Headers = Headers;
  document.cookie = '__Host-album_haven_csrf=synthetic-search-action-csrf';
  const policy = document.createElement('script'); policy.id = 'capability-bootstrap';
  policy.textContent = JSON.stringify({allowed_actions: {'library.browse.read': true, 'library.media.read': media,
    'playlists.read': true, 'playlists.create': true, 'playlists.items.add': true}, available_tabs: [], denied_selectors: []});
  document.body.append(policy);
  vm.runInContext(base.read('music_app/static/js/capability-ui.js'), c, {filename: 'music_app/static/js/capability-ui.js'});
  assert.equal(c.AlbumHavenCapabilities.allows('library.media.read'), media);
  const template = base.read('music_app/templates/partials/primary-modals.html');
  const start = template.indexOf('<div class="track-modal" id="track-modal" hidden>');
  const end = template.indexOf('<div class="cover-lookup-modal"', start);
  assert.ok(start >= 0 && end > start, 'exact served Album modal section exists');
  let buttons = 0;
  const markup = template.slice(start, end).replace(/{% call action_button\(([\s\S]*?)\) %}([\s\S]*?){% endcall %}/g, (_, args, content) => {
    const label = args.match(/^'([^']+)'/)?.[1], id = args.match(/\bid='([^']+)'/)?.[1];
    const className = args.match(/class_name='([^']+)'/)?.[1];
    assert.ok(label && id && className); buttons++;
    // These are the three exact server macro invocations, rendered using the
    // matching production Button component, not a replacement modal owner.
    return c.ButtonComponent.renderActionButton({ariaLabel: label, className,
      disabled: args.includes('disabled=true'), content,
      attributes: {id, ...(id === 'track-modal-close' ? {'data-close-track-modal': '1'} : {})}});
  });
  assert.equal(buttons, 3); assert.doesNotMatch(markup, /{%|{{/);
  assert.equal(document.getElementById('track-modal'), null);
  document.body.insertAdjacentHTML('beforeend', markup);
  const modal = document.getElementById('track-modal');
  assert.ok(modal.querySelector(':scope > .track-modal-dialog > .track-modal-header'));
  const streams = [], activations = [], opens = [], hydrations = [], audioAttempts = [];
  const stream = c.startStreamingTrack, activate = c.activateSharedTrackButton;
  const open = c.openTrackModal, hydrate = c.fetchTrackModalAlbumDetails;
  c.startStreamingTrack = function(...args) {streams.push(args); return stream.apply(this, args);};
  c.activateSharedTrackButton = function(...args) {activations.push(args); return activate.apply(this, args);};
  c.openTrackModal = function(...args) {opens.push(args); return open.apply(this, args);};
  c.fetchTrackModalAlbumDetails = function(...args) {hydrations.push(args); return hydrate.apply(this, args);};
  c.AudioContext = class {
    constructor(settings) {audioAttempts.push(settings); throw new Error('Audio device unavailable in bounded DOM fixture.');}
  };
  if (mobile) c.innerWidth = 390;
  if (entry) await h.entry();
  await h.mount();
  return {...h, modal, streams, activations, opens, hydrations, audioAttempts};
}
function command(h, index) {
  const request = h.requests[index]; assert.ok(request);
  assert.equal(new URL(request.url, h.location).pathname, '/search/native-target');
  assert.equal(request.options.method, 'POST');
  return JSON.parse(request.options.body);
}
function nativeReply(h, index, {albumKey = 'native-album-eleven', parentRef = 'inventory-album:9:11', playAlbum = true, path = '/library/eleven/track.flac'} = {}) {
  const value = command(h, index), play = value.intent === 'play';
  return {status: 'ready', contract_version: 'own-love-native-v1', context_ref: base.A,
    data: {resource_ref: value.resource_ref, intent: value.intent,
      native_target: play ? {inventory_track_ref: value.resource_ref, track_ref: path, path,
        title: 'Authorized title', artist: 'Authorized artist', album_title: 'Authorized Album', duration_seconds: 90}
        : {album_ref: albumKey, allowed_actions: {can_view_details: true, can_play_album: playAlbum}},
      ...(!play && value.resource_ref.startsWith('inventory-track:') ? {parent_album_ref: parentRef} : {})}};
}
const fullAlbum = (key = 'native-album-eleven', patch = {}) => ({key, name: 'Full native Album', album_artist: 'Native Artist',
  year: 2001, tracks: [], track_rows: [], source_readable: true, allowed_actions: {can_read: true}, ...patch});
async function completeDetails(h, index, options = {}) {
  h.reply(index, nativeReply(h, index, options)); await h.flush();
  assert.equal(h.requests.length, index + 2, 'actual ResourceSelection independently reauthorizes before hydration');
  h.reply(index + 1, nativeReply(h, index + 1, options)); await h.flush();
  const request = h.requests[index + 2]; assert.ok(request, 'actual native Album hydration dispatched');
  assert.equal(request.url, '/album-details?album_key=' + encodeURIComponent(options.albumKey || 'native-album-eleven'));
  h.reply(index + 2, {ok: true, album: fullAlbum(options.albumKey, options.album || {})}); await h.flush();
}
function assertPrivateDataAbsent(h, values = ['/library/eleven/track.flac']) {
  for (const value of values) {
    assert.equal(h.host.innerHTML.includes(value), false, 'private action data stays out of Search DOM');
    assert.equal(JSON.stringify(h.runtime().snapshot()).includes(value), false, 'private action data stays out of public result');
    assert.equal(JSON.stringify(h.applications.map(row => row.result)).includes(value), false, 'finite navigation excludes native action data');
    assert.equal(JSON.stringify(h.historyCalls).includes(value), false, 'history excludes native media paths');
  }
}
module.exports = {...base, actionFixture, command, nativeReply, fullAlbum, completeDetails, assertPrivateDataAbsent};
