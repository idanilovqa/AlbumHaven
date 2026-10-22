'use strict';
// Synthetic producer-shaped values, not authenticated evidence or Python output.
// No production code is loaded by this fixture; the literal values below are
// intentionally independent of the presentation implementation.
const TOP = '10000000-0000-4000-8000-000000000001';
const ITEM = '20000000-0000-4000-8000-000000000002';
const ALBUM = '30000000-0000-4000-8000-000000000003';
const OTHER = '40000000-0000-4000-8000-000000000004';
const CONTEXT = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const TIME = '2026-10-20T12:34:56.123456Z';
const CANDIDATE_REASONS = ['candidate_only', 'qualification_pending'];
const clone = value => structuredClone(value);
const exact = value => ({value, status: 'exact_recorded', reasons: []});
const missing = reason => ({value: null, status: 'unavailable', reasons: [reason]});
const proposed = value => ({value, status: 'exact_recorded', reasons: [...CANDIDATE_REASONS]});

function current() {
  return {scopeKey: JSON.stringify(['17', '29', CONTEXT, 4]), top_ref: TOP,
    revision: '13', item_ref: ITEM, album_ref: ALBUM, progress_revision: '7',
    metrics: {actor_id: 17, library_id: 29, local_album_key: 'local-album-a',
      evidence_revision: 'evidence-11', snapshot_id: 'snapshot-7', snapshot_fingerprint: FINGERPRINT,
      source_cutoff: {basis: 'utc-ns', value: {numerator: 123, denominator: 2}},
      mapping: {actor_id: 17, library_id: 29, local_album_key: 'local-album-a',
        catalog_album_ref: ALBUM, mapping_id: 'mapping-3', revision: 'mapping-revision-5',
        authority_ref: 'catalog-authority-1'}}};
}
function binding(owner) {
  return {scopeKey: owner.scopeKey, top_ref: owner.top_ref, revision: owner.revision,
    item_ref: owner.item_ref, album_ref: owner.album_ref, metrics: clone(owner.metrics)};
}
function bucket(id, count = 19, seconds = null) {
  return {source_record_id: id, revision: 'source-revision-1', track_id: 101,
    reported_plays: count === null ? missing('source_count_unknown') : exact(count),
    seconds: seconds === null ? missing('source_time_unknown') : exact(seconds)};
}
function stage(owner) {
  return {actor_id: owner.metrics.actor_id, library_id: owner.metrics.library_id,
    local_album_key: owner.metrics.local_album_key, source_cutoff: clone(owner.metrics.source_cutoff),
    evidence_revision: owner.metrics.evidence_revision, scope: {kind: 'lifetime', baseline_id: null},
    status: 'incomplete', snapshot: {snapshot_id: owner.metrics.snapshot_id,
      fingerprint: owner.metrics.snapshot_fingerprint, status: 'observed'},
    history_status: 'complete_recorded_scope', policy_version: null, policy_status: 'absent', target: 5,
    metrics: {known_position_frames: exact(48000), reported_lost_frames: exact(0),
      native_recorded_frames: exact(120000),
      source_time_totals: [{source_kind: 'native-v2', seconds: exact({numerator: 5, denominator: 2}), buckets: []}],
      track_coverage: [{track_id: 101, source_intervals: [[0, 48000]], known_position_frames: exact(48000)}],
      target_coverage: missing('allocation_not_evaluated'),
      tracks_at_target: missing('allocation_not_evaluated'), full: missing('allocation_not_evaluated'),
      uninterrupted_full: missing('allocation_not_evaluated'), partial: missing('allocation_not_evaluated'),
      album_time_equivalents: missing('allocation_not_evaluated')},
    witnesses: [], reasons: ['allocation_not_evaluated'], predicates: {has_plays: true, listened: 'unknown'}};
}
function candidate(owner) {
  return {actor_id: owner.metrics.actor_id, library_id: owner.metrics.library_id,
    local_album_key: owner.metrics.local_album_key, evidence_revision: owner.metrics.evidence_revision,
    scope: {kind: 'lifetime', baseline_id: null}, status: 'incomplete',
    policy_version: 'album-overlap-r3-candidate-v1', policy_status: 'proposed',
    snapshot_id: owner.metrics.snapshot_id, snapshot_fingerprint: owner.metrics.snapshot_fingerprint,
    target: 5, qualification: 'unknown', predicates: {listened: 'unknown'}, completion_witnesses: [],
    metrics: {full: proposed(2), partial: proposed(1), uninterrupted_full: proposed(1),
      target_coverage: proposed({numerator: 1, denominator: 2}), tracks_at_target: proposed(0),
      album_time_equivalents: proposed({numerator: 5, denominator: 2})},
    required_time_basis: 'native_required_track_frames',
    witnesses: [{tokens: [[{capture_parent_uuid: '50000000-0000-4000-8000-000000000005',
      checkpoint_sequence: 1, run_index: 0}]], uninterrupted: true},
      {tokens: [[{capture_parent_uuid: '50000000-0000-4000-8000-000000000006', checkpoint_sequence: 1, run_index: 0}],
        [{capture_parent_uuid: '50000000-0000-4000-8000-000000000007', checkpoint_sequence: 1, run_index: 0}]], uninterrupted: false}],
    reasons: [...CANDIDATE_REASONS]};
}
function fixture() {
  const owner = current();
  return {current: owner, observations: {
    manualProgress: {binding: binding(owner), value: {progress_revision: '7', manual_completed_at: TIME}},
    lifetimeMetrics: {binding: binding(owner), value: stage(owner)},
    candidates: {binding: binding(owner), value: candidate(owner)}}};
}
function allSources() {
  return [
    {source_kind: 'foobar-playcount', seconds: missing('source_time_unknown'), buckets: [bucket('foobar-record', 23)]},
    {source_kind: 'lastfm-scrobble', seconds: missing('source_time_unknown'), buckets: [bucket('lastfm-record', 7)]},
    {source_kind: 'legacy-measured-v1', seconds: exact({numerator: 7, denominator: 3}),
      buckets: [bucket('legacy-record', 3, {numerator: 7, denominator: 3})]},
    {source_kind: 'manual-reported', seconds: missing('source_time_unknown'), buckets: [bucket('manual-record', 42)]},
    {source_kind: 'native-v2', seconds: exact({numerator: 5, denominator: 2}), buckets: []},
  ];
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function objectReferences(value, result = new Set()) {
  if (value && typeof value === 'object' && !result.has(value)) {
    result.add(value);
    for (const child of Object.values(value)) objectReferences(child, result);
  }
  return result;
}
module.exports = {TOP, ITEM, ALBUM, OTHER, CONTEXT, FINGERPRINT, TIME, CANDIDATE_REASONS,
  clone, exact, missing, proposed, current, binding, bucket, stage, candidate, fixture, allSources,
  deepFreeze, objectReferences};
