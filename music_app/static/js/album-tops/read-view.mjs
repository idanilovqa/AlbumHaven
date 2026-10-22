import {isManualProgress} from './progress.mjs';

// Read-side projection only. Returned rows retain their canonical identities;
// no member, progress evidence, queue or persisted order is written here.
export const DEFAULT_TOP_READ_VIEW = Object.freeze({query: '', completion: 'all', sort: 'curator', direction: 'asc'});
export function normalizeTopReadView(value = {}) {
  return Object.freeze({query: typeof value.query === 'string' ? value.query.slice(0, 200) : '',
    completion: ['all', 'complete', 'incomplete'].includes(value.completion) ? value.completion : 'all',
    sort: ['curator', 'original', 'year', 'artist', 'album'].includes(value.sort) ? value.sort : 'curator',
    direction: value.direction === 'desc' ? 'desc' : 'asc'});
}
export function topReadViewDirty(value) {
  const view = normalizeTopReadView(value);
  return Object.keys(DEFAULT_TOP_READ_VIEW).some(key => view[key] !== DEFAULT_TOP_READ_VIEW[key]);
}
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const known = (a, b, direction = 1) => a === null ? b === null ? 0 : 1 : b === null ? -1 : compare(a, b) * direction;
export function projectTopReadView(detail, value) {
  const view = normalizeTopReadView(value), query = view.query.trim().toLowerCase();
  const field = {curator: 'position', original: 'original_position', year: 'year', artist: 'artist', album: 'title'}[view.sort];
  const scalar = value => view.sort === 'curator' ? value.index
    : ['artist', 'album'].includes(view.sort) ? text(value.row[field]) : number(value.row[field]);
  const direction = view.direction === 'desc' ? -1 : 1;
  return detail.items.map((row, index) => ({row, index})).filter(({row}) => {
    if (query && ![row.artist, row.title].some(value => typeof value === 'string' && value.toLowerCase().includes(query))) return false;
    if (view.completion === 'all') return true;
    const progress = detail.top_viewer_overlay?.item_progress?.[row.album_ref];
    return isManualProgress(progress) && (progress.manual_completed_at !== null) === (view.completion === 'complete');
  }).sort((a, b) => known(scalar(a), scalar(b), direction)
    || known(number(a.row.original_position), number(b.row.original_position)) || a.index - b.index).map(value => value.row);
}
