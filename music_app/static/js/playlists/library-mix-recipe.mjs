const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const frozen = value => Object.freeze(value);
export const MIX_ORDER_OPTIONS = frozen([['regular', 'In order'], ['shuffle', 'Shuffle'], ['unplayed_first', 'Unplayed first']].map(frozen));
export const mixOrder = value => MIX_ORDER_OPTIONS.some(([key]) => key === value);
export const mixRefreshStatus = value => ['idle', 'queued', 'running', 'complete', 'blocked', 'cancelled'].includes(value) ? value : 'idle';
export const mixRefreshError = value => ['not_configured', 'enqueue_unavailable', 'status_unavailable'].includes(value) ? value : null;

export function normalizeMixCoverage(value) {
  if (!record(value) || !Number.isSafeInteger(value.excluded_count) || value.excluded_count < 0
    || !Number.isSafeInteger(value.selected_count) || value.selected_count < 0) return frozen({});
  return frozen({selected_count: value.selected_count, excluded_count: value.excluded_count,
    reasons: frozen(Object.fromEntries(Object.entries(record(value.reasons) ? value.reasons : {})
      .filter(([key, count]) => ['missing_global_metric', 'mapping_mismatch', 'ambiguous_attribution', 'missing_group_identity',
        'missing_recording_identity', 'missing_provider_mapping', 'provider_unavailable'].includes(key)
        && Number.isSafeInteger(count) && count >= 0)))});
}

export function normalizeMixRecipe(value) {
  if (!record(value) || !['per_artist', 'per_album'].includes(value.selection_basis)
    || !Number.isSafeInteger(value.songs_per_group) || value.songs_per_group < 1 || value.songs_per_group > 5000
    || typeof value.auto_update !== 'boolean' || !mixOrder(value.playback_order ?? 'regular')) return null;
  return frozen({selection_basis: value.selection_basis, songs_per_group: value.songs_per_group,
    auto_update: value.auto_update, playback_order: value.playback_order ?? 'regular'});
}

