'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/album-tops/', name)).href);
function fixture() {
  const row = {album_ref: 'album:1', item_ref: 'item:1', title: 'Album', artist: 'Artist'};
  const input = {protocol: 'album-top-status-presentation-v1', policy_status: 'admitted', status: 'ready',
    top_ref: 'top:1', top_revision: '2', album_ref: row.album_ref, target: 5, target_preference_revision: null,
    predicates: {has_plays: true, listened: true, completed: false, rated: null},
    metrics: {full: {status: 'exact_recorded', value: 2}, partial: {status: 'exact_recorded', value: 12},
      tracks_at_target: {status: 'exact_recorded', value: 4}, uninterrupted_full: {status: 'exact_recorded', value: 1}},
    uneven_track_coverage: true};
  const detail = {top_ref: 'top:1', revision: '2', items: [row], top_viewer_overlay: {
    item_progress: {[row.album_ref]: {progress_revision: '1', manual_completed_at: '2026-10-01T00:00:00Z'}},
    item_listening_presentation: {[row.album_ref]: input}}};
  return {row, input, detail};
}
test('manual completion never establishes measured status; legacy projection still works', async () => {
  const {albumTopStatusPresentation: present} = await load('status-presentation.mjs');
  const {projectTopReadView: project} = await load('read-view.mjs');
  const {row, detail} = fixture(); delete detail.top_viewer_overlay.item_listening_presentation;
  const result = present(detail, row);
  assert.equal(result.manualCompleted, true); assert.equal(result.flags.completed, null);
  assert.equal(result.flags.listened, null); assert.equal(result.summary, '');
  assert.deepEqual(project(detail, {completion: 'complete'}), [row]);
  assert.deepEqual(project(detail, {status: 'completed'}), [row]);
  delete detail.top_viewer_overlay;
  assert.deepEqual(project(detail, {}), [row]);
  assert.deepEqual(project(detail, {completion: 'incomplete'}), []);
});
test('short filters distinguish explicit false from discoverable unknown without inventing true', async () => {
  const {projectTopReadView: project, normalizeTopReadView: normalize} = await load('read-view.mjs');
  const {row, input, detail} = fixture();
  assert.deepEqual(project(detail, {status: 'listened'}), [row]);
  assert.deepEqual(project(detail, {status: 'completed'}), []);
  input.metrics.full.value = 20; input.predicates.listened = 'true';
  assert.deepEqual(project(detail, {status: 'listened'}), [row]);
  input.predicates.rated = true; assert.deepEqual(project(detail, {status: 'rated'}), [row]);
  assert.equal(normalize({status: 'constructor'}).status, 'all');
});
test('candidate, stale and wrong-album envelopes remain unknown', async () => {
  const {albumTopStatusPresentation: present} = await load('status-presentation.mjs');
  for (const patch of [{policy_status: 'proposed'}, {status: 'incomplete'}, {top_revision: '3'},
    {top_ref: 'other'}, {album_ref: 'other'}, {protocol: 'other'}]) {
    const {row, input, detail} = fixture(); Object.assign(input, patch);
    const result = present(detail, row);
    assert.equal(result.admitted, false); assert.equal(result.flags.completed, null); assert.equal(result.summary, '');
  }
  const {row, input, detail} = fixture();
  detail.top_viewer_overlay.item_listening_presentation[row.album_ref] = Object.create(input);
  assert.equal(present(detail, row).admitted, false);
});
test('metric unknown differs from exact zero and counts do not alter predicates', async () => {
  const {albumTopStatusPresentation: present} = await load('status-presentation.mjs');
  for (const value of [null, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const {row, input, detail} = fixture(); input.metrics.full.value = value;
    assert.equal(present(detail, row).counts.full, null);
  }
  const {row, input, detail} = fixture(); input.metrics.full.value = 0;
  input.metrics.partial.status = 'unavailable'; delete input.predicates.completed;
  const result = present(detail, row);
  assert.equal(result.summary, '0 full · ? partial · 4 tracks at target');
  assert.equal(result.flags.completed, null); assert.equal(result.counts.uninterrupted, 1);
});
test('default target is explicitly unsaved and saved preference requires a valid receipt shape', async () => {
  const {completedTargetPreference: normalize, albumTopStatusPresentation: present} = await load('status-presentation.mjs');
  for (const value of [undefined, {}, {status: 'saved', value: 0, revision: '1'}, {status: 'saved', value: 5}])
    assert.deepEqual(normalize(value), {value: 5, status: 'default', revision: null});
  assert.deepEqual(normalize({status: 'saved', value: 7, revision: '2'}), {value: 7, status: 'saved', revision: '2'});
  const {row, detail} = fixture(); detail.top_viewer_overlay.completed_target_preference = {status: 'saved', value: 7, revision: '2'};
  const changed = present(detail, row);
  assert.equal(changed.admitted, true); assert.equal(changed.targetBound, false);
  assert.equal(changed.flags.completed, null); assert.equal(changed.counts.tracks, null);
  assert.equal(changed.counts.full, 2); assert.equal(changed.flags.listened, true);
});
test('native card decoration exposes concise counts plus accessible overlapping and caveat explanation', async () => {
  const {albumTopStatusPresentation: present, appendAlbumTopStatus: append} = await load('status-presentation.mjs');
  const {document} = createNativeHomeRuntime(); const card = document.createElement('section');
  const {row, detail} = fixture(); append(card, present(detail, row));
  const status = card.querySelector('[role="img"]');
  assert.equal(status.textContent, '2 full · 12 partial · 4 tracks at target');
  assert.match(status.getAttribute('aria-label'), /overlapping sessions/);
  assert.match(status.getAttribute('aria-label'), /Track coverage is uneven/);
  assert.match(status.getAttribute('aria-label'), /Manual completion is separate/);
  assert.equal(status.getAttribute('title'), status.getAttribute('aria-label'));
  assert.equal(card.querySelectorAll('button, input, a').length, 0);
  const unchanged = document.createElement('section'); delete detail.top_viewer_overlay;
  append(unchanged, present(detail, row)); assert.equal(unchanged.children.length, 0);
});

test('same numeric target with new revision, uncertain preference and missing binding retire target facts only', async () => {
  const {albumTopStatusPresentation: present} = await load('status-presentation.mjs');
  for (const preference of [{status: 'saved', value: 5, revision: '2'}, {status: 'uncertain'}, null]) {
    const {row, input, detail} = fixture(); input.predicates.completed = true;
    detail.top_viewer_overlay.completed_target_preference = preference;
    const result = present(detail, row);
    assert.equal(result.targetBound, false); assert.equal(result.flags.completed, null);
    assert.equal(result.counts.tracks, null); assert.equal(result.counts.full, 2); assert.equal(result.flags.listened, true);
  }
  const {row, input, detail} = fixture(); delete input.target_preference_revision;
  assert.equal(present(detail, row).flags.completed, null);
});
