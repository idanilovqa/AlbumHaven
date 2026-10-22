'use strict';
// Additive unit fixtures. These responses are transport stubs, not server authority.
const F = require('./sample-native-fixtures.cjs');
const albumRefs = ['inventory-album:5:9007199254740993', 'inventory-album:5:9223372036854775807'];
const origins = {
  album_top: () => ({kind: 'album_top', top_ref: F.id(501), revision: '9223372036854775807'}),
  album_set: () => ({kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: albumRefs[0]}, {kind: 'unavailable'}]}),
  album_details: () => ({kind: 'album_details', track_refs: [...F.refs]}),
};
function v2Capture(input, patch = {}) {
  return F.captureResult(input, {source: {kind: 'library', ref: input.request_key, revision: F.id(2)},
    origin_diagnostics: [], ...patch});
}
function v2Representatives(input, patch = {}) {
  const value = F.representatives(input.scopeKey, {options: input.options, origin: F.plain(input.origin), ...patch});
  delete value.data.parent; return value;
}
async function typedController(kind = 'album_set', overrides = {}, extra = {}) {
  const calls = {representatives: [], capture: [], read: [], save: []};
  const h = await F.controllerFixture({
    readSamplePlaylistRepresentatives: async input => {calls.representatives.push(input); return v2Representatives(input);},
    captureSamplePlaylist: async input => {calls.capture.push(input); return v2Capture(input);},
    readSamplePlaylist: async input => {calls.read.push(input); return v2Capture({...input, options: F.options()});},
    createPlaylistFromSelection: async input => {calls.save.push(input); return {status: 'ready', data: {scopeKey: input.scopeKey,
      ok: true, action: 'create', playlist_id: F.id(80), revision: '1', request_key: input.request_key}};}, ...overrides}, extra);
  return {...h, typedCalls: calls, generateOrigin: (patch = {}) => h.controller.generate({origin: origins[kind](), options: F.options(), ...patch})};
}
function topState(patch = {}) {
  return {scopeKey: 'sample:scope', selectedTopRef: F.id(501), directory: {status: 'ready', data: {}},
    detail: {status: 'ready', data: {top_ref: F.id(501), revision: '9223372036854775807', source_locked: true, type: 'source_imported',
      allowed_actions: {'library.browse.read': true, can_edit: false, can_play: false}, items: [{item_ref: F.id(510), album_ref: F.id(520)}]}},
    mutation: {status: 'idle'}, ...patch};
}
function draftState(items, patch = {}) {
  return {scopeKey: 'sample:scope', topRef: null, revision: null, busy: false, stale: false, denied: false,
    dirty: true, items, remote: {retired: false}, ...patch};
}
module.exports = {...F, albumRefs, origins, v2Capture, v2Representatives, typedController, topState, draftState};
