// Pure, inactive presentation of separately admitted owner outputs. This does
// not authenticate evidence, qualify listens, persist a target or wire the UI.
import {isManualProgress} from './progress.mjs';

const freeze = Object.freeze;
const unknown = 'unknown';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) && new TextEncoder().encode(value).length <= 128;
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && (value.length < 19 || value <= '9223372036854775807');
const topFields = ['scopeKey', 'top_ref', 'revision', 'item_ref', 'album_ref'];
const metricFields = ['actor_id', 'library_id', 'local_album_key', 'evidence_revision', 'snapshot_id', 'snapshot_fingerprint'];
const mappingFields = ['actor_id', 'library_id', 'local_album_key', 'catalog_album_ref', 'mapping_id', 'revision', 'authority_ref'];
const sourceLabels = freeze({'native-v2': 'Native', 'legacy-measured-v1': 'Legacy measured',
  'lastfm-scrobble': 'Last.fm', 'foobar-playcount': 'foobar2000', 'manual-reported': 'Reported'});
const candidateFields = freeze([
  freeze(['full', 'Proposed full', false, false]),
  freeze(['partial', 'Proposed partial', false, false]),
  freeze(['uninterrupted_full', 'Proposed uninterrupted', false, false]),
  freeze(['target_coverage', 'Proposed target coverage', true, true]),
  freeze(['tracks_at_target', 'Proposed tracks at target', false, true]),
  freeze(['album_time_equivalents', 'Proposed time equivalents', true, false]),
]);

export function normalizeListeningTarget(value) {
  return freeze(value === undefined ? {value: 5, status: 'default'}
    : positive(value) ? {value, status: 'provided'} : {value: null, status: 'invalid'});
}

function nativeScope(current) {
  if (!record(current) || ![current.top_ref, current.item_ref, current.album_ref].every(uuid)
    || !revision(current.revision) || typeof current.scopeKey !== 'string' || current.scopeKey.length > 256) return null;
  let scope;
  try {scope = JSON.parse(current.scopeKey);} catch {return null;}
  return Array.isArray(scope) && scope.length === 4 && revision(scope[0]) && revision(scope[1])
    && digest(scope[2]) && integer(scope[3]) ? scope : null;
}

const sameFields = (left, right, fields) => record(left) && record(right)
  && fields.every(key => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key]);
const boundTop = (current, observation) => record(observation) && sameFields(current, observation.binding, topFields);
const rational = (value, signed = false) => record(value) && Number.isSafeInteger(value.numerator)
  && (signed || value.numerator >= 0) && positive(value.denominator);
const sameRational = (left, right) => rational(left, true) && rational(right, true)
  && sameFields(left, right, ['numerator', 'denominator']);
const sameTime = (left, right) => record(left) && record(right) && identifier(left.basis)
  && left.basis === right.basis && sameRational(left.value, right.value);

function boundMetrics(current, observation, scope) {
  if (!scope || !boundTop(current, observation)) return false;
  const expected = current.metrics, captured = observation.binding.metrics, value = observation.value;
  if (!record(expected) || !record(captured) || !record(value)
    || !positive(expected.actor_id) || !positive(expected.library_id)
    || String(expected.actor_id) !== scope[0] || String(expected.library_id) !== scope[1]
    || ![expected.local_album_key, expected.evidence_revision, expected.snapshot_id].every(identifier)
    || !digest(expected.snapshot_fingerprint) || !sameFields(expected, captured, metricFields)
    || !sameTime(expected.source_cutoff, captured.source_cutoff)) return false;
  const mapping = expected.mapping;
  if (!record(mapping) || !sameFields(mapping, expected, ['actor_id', 'library_id', 'local_album_key'])
    || mapping.catalog_album_ref !== current.album_ref
    || ![mapping.mapping_id, mapping.revision, mapping.authority_ref].every(identifier)
    || !sameFields(mapping, captured.mapping, mappingFields)) return false;
  return sameFields(value, expected, ['actor_id', 'library_id', 'local_album_key', 'evidence_revision'])
    && record(value.scope) && Object.keys(value.scope).length === 2
    && Object.hasOwn(value.scope, 'kind') && Object.hasOwn(value.scope, 'baseline_id')
    && value.scope.kind === 'lifetime' && value.scope.baseline_id === null;
}

function reasons(value) {
  return Array.isArray(value) && value.length <= 32 && Array.from(value).every(identifier) ? value.slice() : null;
}
const unavailable = reason => freeze({value: null, status: 'unavailable', reasons: freeze([reason])});
function metric(value, isRational = false) {
  const why = reasons(value?.reasons);
  if (!record(value) || why === null) return unavailable('invalid_metric');
  if (value.status === 'unavailable' && value.value === null) {
    return freeze({value: null, status: 'unavailable', reasons: freeze(why)});
  }
  if (!['exact_recorded', 'lower_bound'].includes(value.status)
    || !(isRational ? rational(value.value) : integer(value.value))) return unavailable('unsafe_or_invalid_metric');
  const number = isRational ? freeze({numerator: value.value.numerator, denominator: value.value.denominator}) : value.value;
  return freeze({value: number, status: value.status, reasons: freeze(why)});
}

function stageA(current, observation, scope) {
  if (!boundMetrics(current, observation, scope)) return null;
  const value = observation.value, expected = current.metrics, why = reasons(value.reasons);
  if (value.status !== 'incomplete' || !record(value.snapshot)
    || value.snapshot.snapshot_id !== expected.snapshot_id || value.snapshot.fingerprint !== expected.snapshot_fingerprint
    || !['observed', 'unknown', 'unavailable', 'overflow'].includes(value.snapshot.status)
    || !sameTime(expected.source_cutoff, value.source_cutoff)
    || !['complete_recorded_scope', 'partial', 'unknown'].includes(value.history_status)
    || !['absent', 'proposed', 'approved'].includes(value.policy_status)
    || (value.policy_status === 'absent' ? value.policy_version !== null : !identifier(value.policy_version))
    || !Array.isArray(value.witnesses) || value.witnesses.length !== 0
    || why === null || !why.includes('allocation_not_evaluated')
    || !record(value.predicates) || value.predicates.listened !== unknown
    || ![true, false, unknown].includes(value.predicates.has_plays) || sourceRows(value) === null) return null;
  return value;
}

function sourceRows(value) {
  const rows = value?.metrics?.source_time_totals;
  if (!record(value?.metrics) || !Array.isArray(rows) || rows.length < 1 || rows.length > 5
    || Array.from(rows).some(row => !record(row) || typeof row.source_kind !== 'string' || !Object.hasOwn(sourceLabels, row.source_kind)
      || !Array.isArray(row.buckets) || row.buckets.length > 1024
      || row.source_kind === 'native-v2' && row.buckets.length !== 0)
    || new Set(rows.map(row => row.source_kind)).size !== rows.length
    || !rows.some(row => row.source_kind === 'native-v2')
    || rows.reduce((count, row) => count + row.buckets.length, 0) > 1024) return null;
  return rows;
}

function sourceTimes(value) {
  const rows = sourceRows(value);
  if (rows === null) return freeze([]);
  return freeze(rows.map(row => {
    const measured = ['native-v2', 'legacy-measured-v1'].includes(row.source_kind);
    // Aggregate/scrobble counts cannot supply duration, even if a malformed
    // projection appends seconds. Never synthesize a duration from a count.
    const seconds = measured ? metric(row.seconds, true) : unavailable('source_time_unknown');
    return freeze({source_kind: row.source_kind, label: sourceLabels[row.source_kind], seconds,
      help: measured ? 'Recorded time from this source only, not proof of complete lifetime history.'
        : 'Reported plays from this source do not establish listened time or full sessions.'});
  }));
}

function proposedCandidates(current, observation, scope, target) {
  let value = null;
  if (boundMetrics(current, observation, scope)) {
    const candidate = observation.value, why = reasons(candidate.reasons);
    if (candidate.status === 'incomplete' && candidate.policy_status === 'proposed'
      && candidate.policy_version === 'album-overlap-r3-candidate-v1' && candidate.qualification === unknown
      && record(candidate.predicates) && candidate.predicates.listened === unknown && positive(candidate.target)
      && candidate.snapshot_id === current.metrics.snapshot_id
      && candidate.snapshot_fingerprint === current.metrics.snapshot_fingerprint
      && candidate.required_time_basis === 'native_required_track_frames'
      && Array.isArray(candidate.completion_witnesses) && candidate.completion_witnesses.length === 0
      && Array.isArray(candidate.witnesses)
      && why !== null && why.includes('candidate_only') && why.includes('qualification_pending')
      && record(candidate.metrics)) value = candidate;
  }
  const targetCurrent = value !== null && target.value !== null && value.target === target.value;
  const metrics = candidateFields.map(([key, label, isRational, targetDependent]) => {
    let projected = !value ? unavailable('candidate_unavailable')
      : targetDependent && !targetCurrent ? unavailable('target_not_current') : metric(value.metrics[key], isRational);
    if (projected.status !== 'unavailable' && (projected.status !== 'exact_recorded'
      || !projected.reasons.includes('candidate_only') || !projected.reasons.includes('qualification_pending'))) {
      projected = unavailable('invalid_candidate_metric');
    }
    return freeze({key, label, ...projected});
  });
  return freeze({status: value ? 'proposed' : 'unavailable', label: 'Proposed candidates', target_current: targetCurrent,
    reasons: freeze(value ? value.reasons.slice() : ['candidate_unavailable']),
    help: 'Proposed arithmetic only, not qualified listens or completion. Full includes overlapping candidates; uninterrupted is separate and must not be added to Full.',
    metrics: freeze(metrics)});
}

// current is obtained independently from the current native owner. Each
// observation is {binding, value}; binding captures that exact owner plus its
// metrics admission identity. These are internal arguments, not an HTTP DTO.
// current.progress_revision is independently read from this item's current
// private progress row; the Top revision does not track manual progress edits.
// The provider still owes catalog mapping, cutoff/snapshot freshness and a
// real producer association. Matching fields alone cannot establish authority.
export function projectTopListeningPresentation(current, observations = {}, configuredTarget) {
  const target = normalizeListeningTarget(configuredTarget), scope = nativeScope(current);
  const input = record(observations) ? observations : {};
  const progress = input.manualProgress;
  const manual = scope && boundTop(current, progress) && isManualProgress(progress.value)
    && Object.hasOwn(current, 'progress_revision') && current.progress_revision === progress.value.progress_revision
    ? progress.value.manual_completed_at !== null : unknown;
  const lifetime = stageA(current, input.lifetimeMetrics, scope);
  const hasPlays = lifetime?.predicates.has_plays === true ? true
    : lifetime?.predicates.has_plays === false && lifetime.history_status === 'complete_recorded_scope' ? false : unknown;
  // No current producer joins admitted qualification, membership or rating to
  // these Top rows. Neither candidate counts nor manual marks fill that gap.
  const completed = manual === true ? true : unknown;
  const statuses = [
    ['has_plays', 'Has plays', hasPlays, 'At least one recorded or reported play in the admitted lifetime scope. Counts alone do not establish listened time or full listens.'],
    ['listened', 'Listened', unknown, 'At least one qualifying lifetime full listen, including qualifying overlapping sessions. Qualification is not available here yet.'],
    ['completed', 'Completed', completed, 'A manual completion override or fresh qualifying plays and rating for this Top membership. Automatic completion is not available here yet.'],
    ['rated', 'Rated', unknown, 'Current rating presence, independently of listening or fresh completion evidence. Current rating evidence is not available here yet.'],
  ].map(([key, label, value, help]) => freeze({key, label, value, help}));
  return freeze({target, statuses: freeze(statuses), completion: freeze({manual, automatic: unknown}),
    sources: sourceTimes(lifetime), candidates: proposedCandidates(current, input.candidates, scope, target)});
}
