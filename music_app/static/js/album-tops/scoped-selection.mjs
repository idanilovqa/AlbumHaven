// Pure bounded selection calculations. The existing draft owns all lifetimes.
const types = ['studio', 'ep', 'live', 'demo', 'compilation', 'single'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const scopedRowKey = row => row.album_ref || row.selection_key;
export function captureArtistScope(value) {
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'root_artist_id') || !Object.hasOwn(value, 'mode')) throw new TypeError('Invalid Artist scope.');
  const {root_artist_id: id, mode} = value;
  if (typeof id !== 'string' || id.trim() !== id || !/^[1-9][0-9]{0,18}$/.test(id)
    || id.length === 19 && id > '9223372036854775807' || !['artist', 'family'].includes(mode)) throw new TypeError('Invalid Artist scope.');
  return Object.freeze({root_artist_id: id, mode});
}
export const initialArtistFilters = () => ({releaseTypes: null, minYear: null, maxYear: null, minRating: null, maxRating: null, includeRated: true});
export function applyArtistFilters(previous, patch) {
  if (!object(patch) || Object.keys(patch).some(key => !Object.hasOwn(previous, key))) return null;
  const next = {...previous, ...patch};
  if (typeof next.includeRated !== 'boolean') return null;
  if (next.releaseTypes !== null && (!Array.isArray(next.releaseTypes)
    || Array.from(next.releaseTypes).some(type => !types.includes(type)) || new Set(next.releaseTypes).size !== next.releaseTypes.length)) return null;
  for (const [name, maximum] of [['minYear',9999],['maxYear',9999],['minRating',10],['maxRating',10]])
    if (next[name] !== null && (!Number.isInteger(next[name]) || next[name] < 1 || next[name] > maximum)) return null;
  if (next.minYear !== null && next.maxYear !== null && next.minYear > next.maxYear
    || next.minRating !== null && next.maxRating !== null && next.minRating > next.maxRating) return null;
  return {...next, releaseTypes: next.releaseTypes === null ? null : [...next.releaseTypes]};
}
export function artistRowMatches(row, filter) {
  const metadata = row.creation_metadata, rating = metadata?.rating, year = row.year;
  if (filter.releaseTypes !== null && !filter.releaseTypes.includes(metadata?.release_type)) return false;
  if ((filter.minYear !== null || filter.maxYear !== null) && (!Number.isInteger(year) || year < 1 || year > 9999
    || filter.minYear !== null && year < filter.minYear || filter.maxYear !== null && year > filter.maxYear)) return false;
  if (!filter.includeRated && (metadata?.rating_state !== 'available' || rating !== null)) return false;
  if ((filter.minRating !== null || filter.maxRating !== null) && (metadata?.rating_state !== 'available' || !Number.isInteger(rating)
    || rating < 1 || rating > 10 || filter.minRating !== null && rating < filter.minRating || filter.maxRating !== null && rating > filter.maxRating)) return false;
  return true;
}
export function captureArtistRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Invalid Artist population.');
  const seen = new Set();
  return Array.from(rows, row => {
    if (!object(row) || !Number.isSafeInteger(row.local_album_id) || row.local_album_id < 1 || seen.has(row.local_album_id)
      || typeof row.title !== 'string' || typeof row.artist !== 'string'
      || row.album_ref !== null && (typeof row.album_ref !== 'string' || row.album_ref.length !== 36
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.album_ref))) throw new TypeError('Invalid Artist population row.');
    seen.add(row.local_album_id);
    return {...JSON.parse(JSON.stringify(row)), item_ref: null, ...(row.album_ref === null ? {selection_key: `inventory:${row.local_album_id}`} : {})};
  });
}
export function extendArtistOrder(order, rows, exclusions) {
  const next = [...order], known = new Set([...order, ...exclusions]);
  for (const row of rows) {const key = scopedRowKey(row); if (!known.has(key)) {known.add(key); next.push(key);}}
  if (known.size > 5000) throw new RangeError('This Artist draft exceeds its 5,000-identity limit. Start a new draft.');
  return next;
}
export function selectedArtistRows(order, rows, exclusions, filters) {
  const byKey = new Map();
  for (const row of rows) if (!byKey.has(scopedRowKey(row))) byKey.set(scopedRowKey(row), row);
  return order.map(key => byKey.get(key)).filter(row => row && !exclusions.has(scopedRowKey(row)) && !exclusions.has(`inventory:${row.local_album_id}`) && artistRowMatches(row, filters));
}
export function captureArtistRemote(result, scope) {
  const preview = result?.artist_scope_preview, album = result?.album;
  if (!preview || !object(preview) || Object.keys(preview).length !== 3
    || !['artist_scope','evidence_version','main_artist_match'].every(key => Object.hasOwn(preview,key))
    || typeof preview.evidence_version !== 'string' || preview.evidence_version.length !== 64 || !/^[0-9a-f]{64}$/.test(preview.evidence_version)
    || preview.evidence_version !== result.evidence_version || ![true,false,null].includes(preview.main_artist_match)) throw new TypeError('Artist acquisition scope evidence is unavailable.');
  const descriptor = captureArtistScope(preview.artist_scope);
  if (descriptor.root_artist_id !== scope.root_artist_id || descriptor.mode !== scope.mode) throw new TypeError('Artist acquisition scope changed.');
  if (!object(album) || ![null,'Album','Single','EP','Broadcast','Other'].includes(album.primary_type)) throw new TypeError('Invalid acquired album type.');
  const date = album.first_release_date;
  let year = null;
  if (date !== null) {
    if (typeof date !== 'string' || ![4,7,10].includes(date.length) || !/^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$/.test(date)) throw new TypeError('Invalid acquired album date.');
    year = Number(date.slice(0,4)); const month = date.length >= 7 ? Number(date.slice(5,7)) : 1, day = date.length === 10 ? Number(date.slice(8,10)) : 1;
    const parsed = new Date(0); parsed.setUTCFullYear(year,month-1,day); parsed.setUTCHours(0,0,0,0);
    if (year < 1 || year > 9999 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month-1 || parsed.getUTCDate() !== day) throw new TypeError('Invalid acquired album date.');
  }
  return {year, artist_scope_preview: {artist_scope: descriptor, evidence_version: preview.evidence_version, main_artist_match: preview.main_artist_match},
    creation_metadata: {release_type: album.primary_type === 'EP' ? 'ep' : album.primary_type === 'Single' ? 'single' : null,
      rating_state: 'unavailable', rating: null, artwork_url: null}};
}
