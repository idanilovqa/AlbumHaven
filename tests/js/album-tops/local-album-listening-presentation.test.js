'use strict';
// AUTHORED ONLY: not executed or qualified. Import the whole production module.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname,
  '../../../music_app/static/js/album-tops/listening-presentation.mjs')).href);
const clone = value => JSON.parse(JSON.stringify(value));
const current = () => ({albumKey: 'album / special & edition', accountId: '7', libraryId: '3', context: 'a'.repeat(64)});
function dto() {
  return {ok: true, version: 'local-album-recorded-metrics-v1', album_key: current().albumKey,
    account_id: '7', library_id: '3', context_ref: current().context,
    membership_revision: 'b'.repeat(64), history_complete: false, window_truncated: false,
    compatibility_policy: 'healthy-local-inventory-version-v1', metrics: {
      status: 'partial', basis: 'local-edition-recorded-v1', history_status: 'partial',
      full: null, listened: 'unknown', recorded_frames: 4320000,
      tracks_with_supported_coverage: 1, unsupported_run_count: 1,
      tracks: [
        {track_id: '11', recorded_frames: 2880000, coverage_status: 'supported_lower_bound', covered_frames: 2400000, extent_frames48: 4800000},
        {track_id: '12', recorded_frames: 1440000, coverage_status: 'unknown', covered_frames: null, extent_frames48: null},
      ],
    }};
}
const unavailable = {available: false, text: 'Recorded listening unavailable.', detail: ''};

test('local DTO labels recorded time as a lower bound without qualifying full or listened', async () => {
  const {projectLocalAlbumRecordedPresentation: present} = await load();
  const value = dto(), before = clone(value), result = present(current(), value);
  assert.deepEqual(result, {available: true,
    text: 'Recorded: at least 1 min · Coverage known: 1/2 tracks',
    detail: 'Your app-reported rendered listening in the retained local-edition window. Older or unsupported history may be missing. '
      + 'Coverage uses compatible healthy local file versions, not equal duration or imported play counts. '
      + 'Full listens are not yet qualified by this view.'});
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(value, before);
  assert.equal(value.metrics.full, null);
  assert.equal(value.metrics.listened, 'unknown');
  assert.doesNotMatch(result.text, /completed|listened|full listens/i);
});

test('zero retained evidence and unknown duration remain partial rather than a known unlistened album', async () => {
  const {projectLocalAlbumRecordedPresentation: present} = await load();
  const value = dto();
  value.metrics.recorded_frames = 0;
  value.metrics.tracks_with_supported_coverage = 0;
  value.metrics.unsupported_run_count = 0;
  for (const track of value.metrics.tracks) Object.assign(track,
    {recorded_frames: 0, coverage_status: 'unknown', covered_frames: null, extent_frames48: null});
  assert.equal(present(current(), value).text, 'Recorded: at least 0 sec · Coverage known: 0/2 tracks');
  assert.match(present(current(), value).detail, /Older or unsupported history may be missing/);
  assert.equal(value.metrics.listened, 'unknown');
});

test('truncated local history explicitly names the bounded window', async () => {
  const {projectLocalAlbumRecordedPresentation: present} = await load();
  const value = dto(); value.window_truncated = true;
  assert.match(present(current(), value).detail, /Only the latest bounded window is shown\./);
  assert.match(present(current(), value).text, /^Recorded: at least /);
});

for (const [field, value] of [
  ['album_key', 'other'], ['account_id', '8'], ['account_id', 7], ['library_id', '4'],
  ['context_ref', 'c'.repeat(64)], ['membership_revision', 'not-a-revision'],
  ['version', 'catalog-lifetime-v1'], ['ok', false], ['history_complete', true],
  ['window_truncated', 'false'], ['compatibility_policy', 'equal-duration'],
]) test(`local DTO rejects wrong ${field} binding or contract (${String(value)})`, async () => {
  const {projectLocalAlbumRecordedPresentation: present} = await load();
  const valueDto = dto(); valueDto[field] = value;
  assert.deepEqual(present(current(), valueDto), unavailable);
});

for (const [name, mutate] of [
  ['exact history claim', m => {m.history_status = 'complete';}],
  ['full-listen claim', m => {m.full = 1;}],
  ['listened claim', m => {m.listened = true;}],
  ['different basis', m => {m.basis = 'lastfm';}],
  ['missing tracks', m => {m.tracks = [];}],
  ['duplicate track', m => {m.tracks[1].track_id = m.tracks[0].track_id;}],
  ['noncanonical track id', m => {m.tracks[0].track_id = '011';}],
  ['negative recorded frames', m => {m.tracks[0].recorded_frames = -1;}],
  ['unsafe total', m => {m.recorded_frames = Number.MAX_SAFE_INTEGER + 1;}],
  ['mismatched total', m => {m.recorded_frames += 1;}],
  ['mismatched covered count', m => {m.tracks_with_supported_coverage = 2;}],
  ['unknown with fabricated extent', m => {m.tracks[1].extent_frames48 = 48000;}],
  ['unknown with fabricated coverage', m => {m.tracks[1].covered_frames = 0;}],
  ['unsupported exact coverage', m => {m.tracks[0].coverage_status = 'exact';}],
  ['coverage past extent', m => {m.tracks[0].covered_frames = 4800001;}],
  ['zero extent', m => {m.tracks[0].extent_frames48 = 0;}],
  ['invalid unsupported count', m => {m.unsupported_run_count = -1;}],
  ['oversized track list', m => {m.tracks = Array.from({length: 513}, (_, i) => ({
    track_id: String(i + 1), recorded_frames: 0, coverage_status: 'unknown', covered_frames: null, extent_frames48: null}));
    m.recorded_frames = 0; m.tracks_with_supported_coverage = 0;}],
]) test(`malformed local metrics fail closed: ${name}`, async () => {
  const {projectLocalAlbumRecordedPresentation: present} = await load();
  const value = dto(); mutate(value.metrics);
  assert.deepEqual(present(current(), value), unavailable);
});

test('local DTO does not become catalog Top taste, manual completion, rating or lifetime evidence', async () => {
  const {projectLocalAlbumRecordedPresentation: local, projectTopListeningPresentation: top} = await load();
  const value = dto();
  assert.equal(local(current(), value).available, true);
  const result = top(current(), {manualProgress: value, lifetimeMetrics: value, candidates: value});
  assert.deepEqual(result.statuses.map(row => [row.key, row.value]), [
    ['has_plays', 'unknown'], ['listened', 'unknown'], ['completed', 'unknown'], ['rated', 'unknown']]);
  assert.deepEqual(result.completion, {manual: 'unknown', automatic: 'unknown'});
  assert.deepEqual(result.sources, []);
  assert.equal(result.candidates.status, 'unavailable');
});
