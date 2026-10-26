import {isManualProgress} from './progress.mjs';

export const DEFAULT_COMPLETED_TARGET = 5;
export const TOP_STATUS_OPTIONS = Object.freeze([
  ['all', 'Any status'], ['has_plays', 'Has plays'], ['listened', 'Listened'],
  ['completed', 'Completed'], ['rated', 'Rated'],
].map(Object.freeze));
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const owns = (value, keys) => record(value) && keys.every(key => Object.hasOwn(value, key));
const predicate = value => typeof value === 'boolean' ? value : null;

/**
 * @typedef {Object} CompletedTargetPreference
 * @property {'saved'|'default'} status
 * @property {number} value Positive safe integer, acknowledged by the per-user owner.
 * @property {string|null} revision Nonempty opaque persistence revision when saved; '1' for the server default, null only for the legacy unbound default.
 *
 * This is a presentation contract, NOT a preference store or a save receipt.
 * A missing/invalid preference exposes the default as unsaved, never as saved.
 */
export function completedTargetPreference(value) {
  const saved = owns(value, ['status', 'value', 'revision']) && value.status === 'saved' && Number.isSafeInteger(value.value)
    && value.value > 0 && typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 256;
  const acknowledgedDefault = owns(value, ['status', 'value', 'revision']) && value.status === 'default'
    && value.value === DEFAULT_COMPLETED_TARGET && value.revision === '1';
  return Object.freeze(acknowledgedDefault ? {value: DEFAULT_COMPLETED_TARGET, status: 'default', revision: '1'} : saved ? {value: value.value, status: 'saved', revision: value.revision}
    : {value: DEFAULT_COMPLETED_TARGET, status: 'default', revision: null});
}

// The current bounded provider admits exact Top/item/account/library/settings
// scope before constructing this envelope. Candidate metrics and aggregate
// imports still cannot qualify Full or fresh completion.
export function albumTopStatusPresentation(detail, row) {
  const overlay = detail?.top_viewer_overlay;
  const progress = overlay?.item_progress?.[row?.album_ref];
  const manualCompleted = isManualProgress(progress) ? progress.manual_completed_at !== null : null;
  const preference = overlay?.completed_target_preference;
  const target = completedTargetPreference(preference);
  // An unavailable/uncertain/malformed preference is not an acknowledged default.
  const targetAvailable = preference === undefined || target.status === 'saved'
    || owns(preference, ['status', 'value', 'revision']) && preference.status === 'default'
      && preference.value === DEFAULT_COMPLETED_TARGET && (preference.revision === null || preference.revision === '1');
  const input = overlay?.item_listening_presentation?.[row?.album_ref];
  const admitted = owns(input, ['protocol', 'policy_status', 'status', 'top_ref', 'top_revision', 'album_ref', 'target', 'predicates', 'metrics']) && input.protocol === 'album-top-status-presentation-v1'
    && input.policy_status === 'admitted' && input.status === 'ready'
    && typeof detail?.top_ref === 'string' && typeof detail?.revision === 'string'
    && input.top_ref === detail.top_ref && input.top_revision === detail.revision
    && typeof row?.album_ref === 'string' && input.album_ref === row.album_ref
    && record(input.predicates) && record(input.metrics);
  // A target or preference-revision change retires only target-dependent facts.
  // Reusing the same numeric target after an intervening save is not freshness.
  const targetBound = admitted && targetAvailable && input.target === target.value
    && Object.hasOwn(input, 'target_preference_revision') && input.target_preference_revision === target.revision;
  const flags = Object.freeze(Object.fromEntries(TOP_STATUS_OPTIONS.slice(1).map(([key]) =>
    [key, key === 'completed' && admitted && input.manual_completed === true ? true
      : admitted && (key !== 'completed' || targetBound) && Object.hasOwn(input.predicates, key) ? predicate(input.predicates[key]) : null])));
  const metric = key => admitted && (key !== 'tracks_at_target' || targetBound) && Object.hasOwn(input.metrics, key) && owns(input.metrics[key], ['status', 'value']) && (['exact_recorded', 'at_least_recorded'].includes(input.metrics[key]?.status) || key === 'partial' && input.metrics[key]?.status === 'processed_window')
    ? count(input.metrics[key].value) : null;
  const full = metric('full'), partial = metric('partial'), tracks = metric('tracks_at_target');
  const uninterrupted = metric('uninterrupted_full');
  const hasRecordedDetails = admitted && Boolean(input.recorded_details);
  const parts = [[full, 'full'], [partial, hasRecordedDetails ? 'partial stretches' : 'partial'], [tracks, 'tracks at target']]
    .map(([value, label], index) => `${value === null ? '?' : input.metrics[['full','partial','tracks_at_target'][index]]?.status === 'at_least_recorded' ? '≥' + value : value} ${label}`);
  const explanations = [
    full === null ? 'Full listens unavailable.' : `${input.metrics.full?.status === 'at_least_recorded' ? 'At least ' : ''}${full} qualifying full listens, including qualifying overlapping sessions.`,
    partial === null ? 'Partial listens unavailable.' : hasRecordedDetails ? `${partial} unallocated qualifying partial stretches at the processed cutoff.` : `${partial} qualifying partial listens.`,
    tracks === null ? 'Tracks at target unavailable.' : `${tracks} tracks reached the target of ${target.value}.`,
    uninterrupted === null ? 'Uninterrupted sessions unavailable.' : `${uninterrupted} uninterrupted full sessions, reported separately.`,
    'Manual completion is separate from measured listening.',
  ];
  if (admitted && input.recorded_details_reason === 'derived_detail_capacity') explanations.push('Optional detailed coverage exceeded its bounded derived-state budget. Full-listen processing continues; original listening is retained.');
  if (admitted && targetBound && input.recorded_details?.explanation) explanations.push(input.recorded_details.explanation);
  if (admitted && !targetBound) explanations.push('Completion target changed or is unbound; target-dependent progress is unavailable until recomputed.');
  if (admitted && input.reported_evidence?.has_plays === true)
    explanations.push('Foobar reported plays were present at the last import-evidence read. This is not measured Full coverage or a combined play total.'
      + (input.reported_evidence.freshness === 'last-read-not-refreshed-by-advance'
        ? ' The listening update has not refreshed that imported evidence.' : ''));
  if (admitted && input.uneven_track_coverage === true)
    explanations.push('Track coverage is uneven; a lower-played track may limit full listens despite substantial listening elsewhere.');
  return Object.freeze({admitted, targetBound, flags, manualCompleted, target,
    counts: Object.freeze({full, partial, tracks, uninterrupted}),
    // Omit new card decoration entirely when no admitted metrics exist.
    summary: admitted ? parts.join(' · ') : '', explanation: admitted ? explanations.join(' ') : ''});
}
export function topStatusCoverage(detail, status) {
  const rows = Array.isArray(detail?.items) && detail.items.length <= 5000 ? detail.items : [];
  const known = rows.reduce((total, row) => total + (typeof albumTopStatusPresentation(detail, row).flags[status] === 'boolean' ? 1 : 0), 0);
  return Object.freeze({known, unknown: rows.length - known});
}
export function topHasStatusPresentation(detail) {
  return TOP_STATUS_OPTIONS.slice(1).some(([key]) => topStatusCoverage(detail, key).known > 0);
}

// Native DOM, text only. Accessible explanation is not dependent on hover.
export function appendAlbumTopStatus(element, presentation) {
  if (!presentation.summary) return;
  const status = element.ownerDocument.createElement('p');
  status.className = 'album-top-listening-status';
  status.textContent = presentation.summary;
  status.setAttribute('role', 'img');
  status.setAttribute('aria-label', presentation.explanation);
  status.setAttribute('title', presentation.explanation);
  element.append(status);
}
