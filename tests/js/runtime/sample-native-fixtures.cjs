'use strict';
// Bounded unit/native-owner fixtures, never a real-app E2E or media decoder.
const {id, deferred, plain} = require('./library-mix-fixtures.cjs');
const {nativeFixture} = require('./library-mix-native-fixture.cjs');
const PROTOCOL = 'sample_playlist_selection_v1';
const parent = () => ({playlist_ref: id(70), revision: '3'});
const options = (selection_method = 'random', patch = {}) => ({selection_basis: 'per_album', songs_per_group: 2,
  unknown_facets: 'include', selection_method, length: null, styles: null, countries: null, ...patch});
const refs = ['inventory-track:5:9007199254740993', 'inventory-track:5:9223372036854775807', 'inventory-track:5:3'];
const entries = () => [11, 12, 13].map(n => ({entry_ref: id(n), title: `Track ${n}`, artist: 'Artist', album_title: 'Album',
  availability: 'local', duration_seconds: 30, inventory_track_ref: refs[n - 11], parent_album: {album_ref: String(100 + n)}, allowed_actions: {can_read: true, can_select: false, can_play: false},
  native_actions: {can_play: true}}));
function captured(scopeKey, patch = {}) {
  return {status: 'ready', data: {scopeKey, source_protocol: PROTOCOL, mode: 'ordinary',
    source: {kind: 'playlist', ref: id(1), revision: id(2)}, entries_complete: true,
    actor_scope: {account_id: 4, library_id: 5}, options: options(), diagnostics: [], source_diagnostics: [], group_counts: [['111', 1], ['112', 1], ['113', 1]],
    allowed_actions: {can_read: true, can_use_for_playlist: false, can_play: false},
    native_actions: {can_save: true, can_play: true}, entries: entries(), expires_at: '2099-01-01T00:00:00Z', ...patch}};
}
// Capture identity is the submitted request key; standalone tuple reads retain
// their requested ref/revision. Never fabricate a second capture identity.
function captureResult(input, patch = {}) {
  return captured(input.scopeKey, {options: input.options || options(),
    source: {kind: 'playlist', ref: input.request_key, revision: id(2)}, ...patch});
}
function readResult(input, patch = {}) {
  return captured(input.scopeKey, {source: {kind: 'playlist',
    ref: input.request_key || input.source_ref, revision: input.source_revision || id(2)}, ...patch});
}
const representatives = (scopeKey, patch = {}) => ({status: 'ready', data: {scopeKey, parent: parent(), options: options(),
  actor_scope: {account_id: 4, library_id: 5}, representative_refs: [...refs], ...patch}});
async function controllerFixture(overrides = {}, extra = {}) {
  const {createSamplePlaylistController} = await import('../../../music_app/static/js/playlists/sample-playlist.mjs');
  const native = nativeFixture();
  const calls = {representatives: [], capture: [], read: [], save: [], recover: []};
  let current = true, sequence = 90, draws = 0;
  const scopeKey = extra.scopeKey || 'sample:scope';
  const providers = {
    readSamplePlaylistRepresentatives: async input => {calls.representatives.push(input); return representatives(scopeKey, {parent: {playlist_ref: input.playlist_ref, revision: input.revision}, options: input.options});},
    captureSamplePlaylist: async input => {calls.capture.push(input); return captureResult(input);},
    readSamplePlaylist: async input => {calls.read.push(input); return readResult(input);},
    createPlaylistFromSelection: async input => {calls.save.push(input); return {status: 'ready', data: {
      ok: true, action: 'create', request_key: input.request_key, playlist_id: id(80), revision: '1', changed: true, scopeKey}};},
    hasPendingPlaylistOperation: () => false,
    recoverPlaylistCreation: async input => {calls.recover.push(input); return null;}, ...overrides};
  const controller = createSamplePlaylistController({providers, scopeKey, isCurrent: () => current,
    requestKey: () => id(sequence++), random: () => {draws++; return 0;},
    shuffleCopy: (values, random) => Array.from(native.c.playlistQueueShuffleCopy(values, random)), ...extra});
  return {controller, providers, calls, scopeKey, draws: () => draws, keys: () => sequence - 90,
    retire() {current = false;}, generate: (value = {}) => controller.generate({parent: parent(), options: options(), ...value})};
}
module.exports = {id, deferred, plain, PROTOCOL, parent, options, refs, entries, captured, captureResult, readResult, representatives, controllerFixture};
