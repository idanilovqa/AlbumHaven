const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ratio = value => object(value) && integer(value.numerator) && integer(value.denominator)
  && value.denominator > 0 && value.numerator <= value.denominator;
/** Admit bounded derived details only after the caller's genuine scope envelope. */
export function recordedTrackDetails(value, target) {
  if (!(target === null || integer(target) && target > 0) || !object(value) || value.policy !== 'local-recorded-track-depth-v1' || value.target !== target
    || value.scope !== 'processed-compatible-recorded-evidence' || value.history_complete !== false
    || !(value.cutoff_checkpoint_id === null || typeof value.cutoff_checkpoint_id === 'string' && /^[1-9][0-9]{0,18}$/.test(value.cutoff_checkpoint_id))
    || !(value.recorded_frames === null || integer(value.recorded_frames))
    || !(value.partial_stretches === null || integer(value.partial_stretches))
    || value.partial_incomplete !== true || typeof value.coverage_pruned !== 'boolean'
    || !(value.uneven_track_coverage === null || typeof value.uneven_track_coverage === 'boolean')
    || !integer(value.unsupported_runs) || !Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > 512
    || !(value.target_coverage === null || ratio(value.target_coverage))
    || !(value.tracks_at_target === null || integer(value.tracks_at_target) && value.tracks_at_target <= value.tracks.length)) return null;
  const ids = new Set();let total=0;
  for (const row of value.tracks) {
    if (!object(row) || typeof row.track_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.track_id) || ids.has(row.track_id)
      || !(row.recorded_frames === null || integer(row.recorded_frames)) || typeof row.coverage_pruned !== 'boolean'
      || !(row.extent_frames === null || integer(row.extent_frames) && row.extent_frames > 0)
      || !(row.position_coverage === null || ratio(row.position_coverage) && row.position_coverage.denominator === row.extent_frames)
      || !(row.minimum_position_depth === null || integer(row.minimum_position_depth))
      || !(row.tracks_target_reached === null || typeof row.tracks_target_reached === 'boolean')
      || (row.extent_frames === null) !== (row.position_coverage === null)
      || (row.minimum_position_depth === null) !== (row.position_coverage === null)
      || (row.minimum_position_depth === null || target === null ? row.tracks_target_reached !== null
        : row.tracks_target_reached !== (row.minimum_position_depth >= target))) return null;
    ids.add(row.track_id);
    if(row.recorded_frames===null || total!==null && total>Number.MAX_SAFE_INTEGER-row.recorded_frames)total=null;
    else if(total!==null)total+=row.recorded_frames;
  }
  if (total !== value.recorded_frames || total !== null && !integer(total)) return null;
  const percent = amount => `${Number(BigInt(amount.numerator) * 100n / BigInt(amount.denominator))}%`;
  const minutes = frames => frames >= 2880000 ? `${Math.floor(frames / 2880000)} min` : `${Math.floor(frames / 48000)} sec`;
  const explanation = [
    value.recorded_frames === null ? 'Recorded time unavailable.' : `At least ${minutes(value.recorded_frames)} of supported recorded listening. Replays add time, not unheard positions.`,
    value.target_coverage === null ? 'Duration-weighted target coverage unavailable.' : `Duration-weighted coverage toward ${target} listens: at least ${percent(value.target_coverage)}.`,
    'Partial stretches are unallocated qualifying stretches at this processed cutoff, not lifetime sessions or a monotonic lower bound. Later overlapping evidence can consume them into Full listens.',
    value.coverage_pruned ? 'Some position geometry was conservatively omitted; original listening remains retained.' : 'Older or unsupported listening may still be missing.',
    ...value.tracks.map((row,index) => `Track ${index+1}: ${row.recorded_frames===null?'time unavailable':minutes(row.recorded_frames)}; ${row.position_coverage===null?'position coverage unknown':`${percent(row.position_coverage)} measured position coverage, minimum depth ${row.minimum_position_depth}`}.`),
  ].join(' ');
  return {...value, explanation};
}
