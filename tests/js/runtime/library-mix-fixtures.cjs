'use strict';
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const SCOPE = 'mix:scope';
const ACTOR = {account_id: 4, library_id: 5};
const recipe = patch => ({selection_basis: 'per_artist', songs_per_group: 3, auto_update: false, playback_order: 'regular', ...patch});
const mixMetadata = patch => ({version: 1, source: 'whole_library', provider: 'lastfm', metric: 'overall_scrobbles', ...recipe(patch)});
const row = (index, patch = {}) => ({entry_ref: id(10 + index), title: `Track ${index}`, artist: 'Artist', album_title: 'Album',
  availability: 'local', duration_seconds: 30, popularity_count: 1000 - index,
  allowed_actions: {can_read: true, can_select: true, can_play: true}, ...patch});
function capture(patch = {}) {
  return {status: 'ready', data: {scopeKey: SCOPE, source_protocol: 'library_mix_selection_v1', mode: 'ordinary',
    source: {kind: 'library', ref: id(1), revision: id(2)}, entries_complete: true, actor_scope: {...ACTOR},
    library_mix: mixMetadata(), allowed_actions: {can_read: true, can_use_for_playlist: true, can_play: true},
    entries: [row(1, {play_count: 7}), row(2, {play_count: 0}), row(3)],
    coverage: {selected_count: 3, excluded_count: 2, reasons: {missing_global_metric: 2}},
    expires_at: '2099-01-01T00:00:00Z', ...patch}};
}
const receipt = (key = id(90), patch = {}) => ({status: 'ready', data: {ok: true, action: 'create',
  playlist_id: id(80), revision: '1', request_key: key, changed: true, actor_scope: {...ACTOR}, scopeKey: SCOPE, ...patch}});
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const plain = value => JSON.parse(JSON.stringify(value));
module.exports = {id, SCOPE, ACTOR, recipe, mixMetadata, row, capture, receipt, deferred, plain};
