'use strict';
// Synthetic protocol fixtures only. Actual product ESM and native owners remain unchanged.
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const N = require('./foobar-account-import-native-fixture.cjs');
const LABELS = {source_artist: 'Source artist', source_title: 'Source song', source_album: 'Source album'};
const RATING = {row: 1, field: 'rating', existing: 2, proposed: 5, consequence: 'replace_personal_rating', eligible: true, reason: null, ...LABELS};
const FAVORITE = {row: 1, field: 'favorite', existing: 'off', proposed: 'loved', consequence: 'set_personal_favorite', eligible: true, reason: null, ...LABELS};
const DISABLED = {row: 2, field: 'rating', existing: null, proposed: 3, consequence: 'replace_personal_rating', eligible: false, reason: 'provenance_requires_review', ...LABELS, source_title: 'Another source song'};
const rating = patch => ({...RATING, ...patch});
const favorite = patch => ({...FAVORITE, ...patch});
const disabled = patch => ({...DISABLED, ...patch});
const proposal = patch => F.proposal({command: F.command({original_matching_library_id: 23}), conflicts: [rating(), favorite(), disabled()], conflict_count: 3, ...patch});
const page = (second = false, patch = {}) => proposal({command: F.command({original_matching_library_id: 23, total_rows: 40}), checked_rows: 40,
  proposed_counts: [40, 0, 0, 0, 0, 0, 0], review_counts: [40, 0, 0, 0, 40, 0], problems: [],
  conflicts: Array.from({length: second ? 8 : 32}, (_, index) => rating({row: index + (second ? 33 : 1),
    ...(index === 2 ? {eligible: false, reason: 'provenance_requires_review'} : {})})),
  conflict_count: 40, conflict_after: second ? 64 : 0, conflict_next: second ? null : 64, conflict_remaining: second ? 0 : 8, ...patch});
const choices = items => items.map(({row, field}) => ({row, field}));
const changed = items => items.map(({row, field, existing, proposed}) => ({row, field, existing, proposed}));
const receipt = (items = [rating()], patch = {}) => F.envelope(F.REVIEW, 'personal-changes', {phase: 'personal_changes_applied', changed_fields: changed(items), import_started: false, ...patch});
const rejection = code => ({protocol: F.REVIEW, error: code, context_ref: F.STAMP, context_scope: F.SCOPE});
async function startReview(f, value = proposal(), method = 'preview') {
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: value}));
  await f.owner[method](); await f.time.tick();
  assert.equal(f.owner.getState().phase, 'review_ready');
}
async function ready(t, {value = proposal(), transport = F.wire()} = {}) {
  const f = await F.controller(t, transport, {library: '23'});
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  const selected = F.file(); f.owner.choose(selected); f.owner.setMatching(true);
  await startReview(f, value); return {...f, selected};
}
async function native(t, value = proposal(), transport = F.wire()) {
  const f = await N.native(t, transport, {library: '23'});
  f.field('matching').checked = true; f.change(f.field('matching')); await F.settle();
  const selected = await N.reviewed(f, {proposal: value}); return {...f, selected};
}
const fields = f => f.host.querySelectorAll('input').filter(node => /-personal-field-\d+$/.test(node.id));
function select(f, index, selected = true) {const node = f.field('personal-field-' + index); node.checked = selected; f.change(node); return node;}
function acknowledge(f) {const node = f.field('personal-confirmation'); node.checked = true; f.change(node); return node;}
module.exports = {F, N, rating, favorite, disabled, proposal, page, choices, changed, receipt, rejection, startReview, ready, native, fields, select, acknowledge};
