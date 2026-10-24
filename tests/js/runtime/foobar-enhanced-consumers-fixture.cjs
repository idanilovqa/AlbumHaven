'use strict';
// Synthetic DTOs and platform orchestration only. Every contract, controller,
// renderer, private transport and dispatcher comes from its genuine owner.
const assert = require('node:assert/strict');
const E = require('./foobar-enhanced-v4-fixture.cjs'), {F} = E;
const I = require('./foobar-account-import-native-fixture.cjs');
const P = require('./foobar-account-history-play-fixture.cjs');
const N = require('./foobar-account-history-native-fixture.cjs');
const header = call => JSON.parse(call.init.headers['X-AlbumHaven-Foobar-Command']);
const command = patch => E.command({original_matching_library_id: 23, ...patch});
const proposal = patch => E.proposal({command: command(), proposed_counts: [1, 3, 0, 0, 0, 0, 2], review_counts: [4, 2, 1, 2, 0, 1], ...patch});
const review = patch => E.review({review: proposal(), ...patch});
const job = patch => E.job({command: command(), confirmed_counts: [0, 2, 0, 0, 0, 0, 1], ...patch});
async function ready(f, {value = proposal(), selected = E.file()} = {}) {
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.owner.setMapping(E.IMPORT_MAPPING); f.owner.choose(selected); f.owner.setMatching(true);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', review({review: value}));
  await f.owner.preview(); await f.time.tick(); assert.equal(f.owner.getState().phase, 'review_ready'); return selected;
}
async function nativeReview(f, value = proposal()) {
  f.field('mapping').value = E.IMPORT_MAPPING; f.change(f.field('mapping'));
  f.field('matching').checked = true; f.change(f.field('matching')); await F.settle();
  return I.reviewed(f, {selected: E.file(), proposal: value});
}
const history = (mode = 'individual', patch = {}) => E.history([E.record(9, {
  observation_revision: '3', local_vector_count: '2',
  entry: mode === 'grouped' ? null : E.entry({ordinal: 1}),
})], {source_revision: '8', view: mode === 'grouped' ? 'records' : 'entries',
  ordering: mode === 'grouped' ? 'source_record_identity' : 'resolved_time_then_undated', ...patch});
async function selected(f, mode = 'individual', value = history(mode)) {await E.nativeSelected(f, value, mode);}
function noPublicTarget(f) {
  for (const value of [f.host.outerHTML, JSON.stringify(f.owner.controller.getSnapshot()), JSON.stringify(f.actions.state(f.row()))]) {
    assert.doesNotMatch(value, /synthetic\/library-one|inventory-track:1:9|Native title|Native artist|Native album|data-track-path|data-inventory-track-ref|data-src|albumListeningIntent/);
  }
  assert.equal(f.storage.length, 0);
}
module.exports = {E, F, I, P, N, header, command, proposal, review, job, ready, nativeReview, history, selected, noPublicTarget};
