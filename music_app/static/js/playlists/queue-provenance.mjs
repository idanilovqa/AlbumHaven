const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\/\u0000-\u001f\u007f]/.test(value);
const inventory = value => typeof value === 'string' && /^inventory-track:[1-9]\d*:[1-9]\d*$/.test(value);
// This is transport shape validation, never authorization. The authenticated
// source endpoint validates each receipt and retains every contributing origin.
export function queueProvenance(value) {
  if (!value || !inventory(value.track_ref)) return null;
  const common = {kind: value.kind, track_ref: value.track_ref};
  if (value.kind === 'inventory') return common;
  if (value.kind === 'playlist' && text(value.playlist_ref) && text(value.revision) && text(value.item_ref))
    return {...common, playlist_ref: value.playlist_ref, revision: value.revision, item_ref: value.item_ref};
  const origin = value.origin;
  if (value.kind !== 'activity' || !text(value.row_ref) || !origin || !['own', 'friend'].includes(origin.audience)
    || (origin.audience === 'own' ? origin.subject_ref !== null : !text(origin.subject_ref))
    || !['tracks', 'listens'].includes(origin.kind) || !['week', 'month', 'six', 'year', 'all'].includes(origin.period) || !text(origin.snapshot_ref)) return null;
  return {...common, row_ref: value.row_ref, origin: {audience: origin.audience, subject_ref: origin.subject_ref,
    kind: origin.kind, period: origin.period, snapshot_ref: origin.snapshot_ref}};
}
export function queueOccurrences(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5000) return null;
  const result = Array.from(values, queueProvenance);
  return result.every(Boolean) ? result : null;
}
