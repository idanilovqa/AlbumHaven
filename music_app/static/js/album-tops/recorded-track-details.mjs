const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const ratio = value => object(value) && integer(value.numerator) && integer(value.denominator)
  && value.denominator > 0 && value.numerator <= value.denominator;
/** Admit bounded derived details only after the caller's genuine scope envelope. */
export function recordedTrackDetails(value, target) {
  if(object(value)&&value.policy==='rate-recorded-track-depth-v1')return rateTrackDetails(value,target);
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
  const seconds=value.recorded_frames===null?null:[BigInt(value.recorded_frames),48000n];
  const divisor=seconds===null?null:gcd(...seconds);
  return {...value, explanation, recorded_seconds:seconds===null?null:seconds.map(v=>(v/divisor).toString())};
}

const MAX_EXACT = (1n << 127n) - 1n;
const gcd = (a,b) => { while(b) [a,b]=[b,a%b]; return a; };
function exact(value) {
  if(!Array.isArray(value)||value.length!==2||value.some(v=>typeof v!=='string'||! /^(0|[1-9][0-9]{0,38})$/.test(v)))return null;
  const [n,d]=value.map(BigInt);
  return n<=MAX_EXACT&&d>0n&&d<=MAX_EXACT&&gcd(n,d)===1n ? [n,d] : null;
}
function sumExact(a,b) {
  const n=a[0]*b[1]+b[0]*a[1],d=a[1]*b[1],g=gcd(n,d),v=[n/g,d/g];
  return v[0]<=MAX_EXACT&&v[1]<=MAX_EXACT?v:null;
}
export function recordedSecondsLabel(value) {
  const time=exact(value);
  if(time===null)return null;
  const seconds=time[0]/time[1];
  return seconds>=60n?`${seconds/60n} min`:`${seconds} sec`;
}
function rateTrackDetails(value,target) {
  const probability = v => { const p=exact(v);return p!==null&&p[0]<=p[1]; };
  if(!(target===null||integer(target)&&target>0)||value.target!==target
    ||value.scope!=='processed-compatible-recorded-evidence'||value.history_complete!==false
    ||typeof value.legacy_details_available!=='boolean'
    ||!(value.cutoff_checkpoint_id===null||typeof value.cutoff_checkpoint_id==='string'&&/^[1-9][0-9]{0,18}$/.test(value.cutoff_checkpoint_id))
    ||!(value.recorded_seconds===null||exact(value.recorded_seconds))
    ||!(value.partial_stretches===null||integer(value.partial_stretches))||value.partial_incomplete!==true
    ||typeof value.coverage_pruned!=='boolean'||!integer(value.unsupported_runs)
    ||!(value.uneven_track_coverage===null||typeof value.uneven_track_coverage==='boolean')
    ||!Array.isArray(value.tracks)||!value.tracks.length||value.tracks.length>512
    ||!(value.target_coverage===null||probability(value.target_coverage))
    ||!(value.tracks_at_target===null||integer(value.tracks_at_target)&&value.tracks_at_target<=value.tracks.length))return null;
  let total=[0n,1n];const ids=new Set();
  for(const row of value.tracks){
    if(!object(row)||typeof row.track_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(row.track_id)||ids.has(row.track_id)
      ||!(row.recorded_seconds===null||exact(row.recorded_seconds))||typeof row.coverage_pruned!=='boolean'
      ||!(row.extent_seconds===null||exact(row.extent_seconds)?.[0]>0n)
      ||!(row.position_coverage===null||probability(row.position_coverage))
      ||!(row.minimum_position_depth===null||integer(row.minimum_position_depth))
      ||(row.extent_seconds===null)!==(row.position_coverage===null)
      ||(row.minimum_position_depth===null)!==(row.position_coverage===null)
      ||(row.minimum_position_depth===null||target===null ? row.tracks_target_reached!==null
         : row.tracks_target_reached!==(row.minimum_position_depth>=target)))return null;
    ids.add(row.track_id);
    if(row.recorded_seconds===null)total=null;
    else if(total!==null){ total=sumExact(total,exact(row.recorded_seconds));if(total===null)return null; }
  }
  const declared=value.recorded_seconds===null?null:exact(value.recorded_seconds);
  if((total===null)!==(declared===null)||total!==null&&(total[0]!==declared[0]||total[1]!==declared[1]))return null;
  const percent = value => {const [n,d]=exact(value);return `${n*100n/d}%`;};
  const explanation=[
    value.recorded_seconds===null?'Recorded time unavailable.':`At least ${recordedSecondsLabel(value.recorded_seconds)} of supported recorded listening. Replays add time, not unheard positions.`,
    value.target_coverage===null?'Duration-weighted target coverage unavailable.':`Duration-weighted coverage toward ${target} listens: at least ${percent(value.target_coverage)}.`,
    value.legacy_details_available?'Position depth uses one supported source cohort per track; incompatible partial histories are not combined.':'Legacy detail is unavailable at this cutoff; displayed time and coverage include only supported rate-tagged evidence, not zero legacy listening.',
    'Partial stretches are unallocated qualifying stretches at this processed cutoff, not lifetime sessions or a monotonic lower bound.',
    value.coverage_pruned?'Some position geometry was conservatively omitted; original listening remains retained.':'Older or unsupported listening may still be missing.',
    ...value.tracks.map((row,index)=>`Track ${index+1}: ${row.recorded_seconds===null?'time unavailable':recordedSecondsLabel(row.recorded_seconds)}; ${row.position_coverage===null?'position coverage unknown':`${percent(row.position_coverage)} measured position coverage, minimum depth ${row.minimum_position_depth}`}.`),
  ].join(' ');
  return {...value,explanation};
}
