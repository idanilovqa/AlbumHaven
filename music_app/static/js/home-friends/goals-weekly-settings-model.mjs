// Draft settings only. Durable settings and authorized preview selection belong to the server.
export const WEEKLY_FILTERS = Object.freeze([['genre', 'Genre'], ['newer', 'Newer albums'], ['older', 'Older albums'], ['decade', 'Decade'], ['year', 'Year']]);
const fail = () => {throw new TypeError('Weekly Goals settings are invalid.');};
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
export function defaultWeeklySettings() {
  return {manual_count: 5, suggestion_count: 1, filters: [], sources: ['tops', 'playthroughs'],
    prefer_preferences: true, discover: false, selection: 'random', prefer_nearly_finished: false, preferred_playthrough_refs: []};
}
export function normalizeWeeklySettings(value) {
  const keys = Object.keys(defaultWeeklySettings());
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || !integer(value.manual_count, 0, 7)
    || !integer(value.suggestion_count, 0, 7) || value.manual_count + value.suggestion_count > 7
    || value.manual_count + value.suggestion_count < 1 || !Array.isArray(value.filters) || value.filters.length > 30
    || !Array.isArray(value.sources) || new Set(value.sources).size !== value.sources.length
    || value.sources.some(source => !['tops', 'playthroughs', 'library'].includes(source))
    || value.suggestion_count > 0 && !value.sources.length
    || ['prefer_preferences', 'discover', 'prefer_nearly_finished'].some(key => typeof value[key] !== 'boolean')
    || !['popular', 'random', 'position'].includes(value.selection)
    || !Array.isArray(value.preferred_playthrough_refs) || value.preferred_playthrough_refs.length > 100
    || new Set(value.preferred_playthrough_refs).size !== value.preferred_playthrough_refs.length
    || value.preferred_playthrough_refs.some(ref => typeof ref !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ref))) fail();
  const filters = value.filters.map(row => {
    if (!row || Object.keys(row).length !== 3 || !['kind', 'value', 'maximum'].every(key => Object.hasOwn(row, key))
      || !WEEKLY_FILTERS.some(([kind]) => kind === row.kind) || !integer(row.maximum, 0, value.manual_count)) fail();
    if (row.kind === 'genre' ? typeof row.value !== 'string' || !row.value.trim() || row.value.length > 120
      : !integer(row.value, 1, 9999) || row.kind === 'decade' && row.value % 10 !== 0) fail();
    return {...row};
  });
  if (new Set(filters.map(row => JSON.stringify([row.kind, typeof row.value === 'string' ? row.value.trim().toLowerCase() : row.value]))).size !== filters.length) fail();
  return {...value, filters, sources: ['tops', 'playthroughs', 'library'].filter(source => value.sources.includes(source)), preferred_playthrough_refs: [...value.preferred_playthrough_refs].sort()};
}
export function changeWeeklyCount(settings, key, value) {
  if (!['manual_count', 'suggestion_count'].includes(key) || !integer(value, 0, 7)) return settings;
  const other = key === 'manual_count' ? 'suggestion_count' : 'manual_count';
  if (value + settings[other] > 7 || value + settings[other] < 1) return settings;
  const next = {...settings, [key]: value};
  return {...next, filters: next.filters.map(row => ({...row, maximum: Math.min(row.maximum, next.manual_count)}))};
}
export function newWeeklyFilter(settings, kind, genres, year = new Date().getFullYear()) {
  if (!WEEKLY_FILTERS.some(([value]) => kind === value) || settings.filters.length >= 30) return null;
  const value = kind === 'genre' ? genres.find(genre => !settings.filters.some(row => row.kind === 'genre' && row.value === genre)) : kind === 'older'
    ? settings.filters.find(row => row.kind === 'newer')?.value ?? year
    : kind === 'decade' ? Math.floor(year / 10) * 10 : year;
  return value === undefined || settings.filters.some(row => row.kind === kind && row.value === value) ? null : {kind, value, maximum: Math.min(3, settings.manual_count)};
}
export function normalizeWeeklyRead(data) {
  if (!data || typeof data.settings_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(data.settings_revision)
    || !Array.isArray(data.genres) || data.genres.length > 1000 || data.genres.some(row => typeof row !== 'string' || !row || row.length > 120)
    || !Array.isArray(data.playthroughs) || data.playthroughs.length > 1000
    || data.playthroughs.some(row => !row || typeof row.top_ref !== 'string' || typeof row.title !== 'string' || !row.title)) fail();
  return {settings_revision: data.settings_revision, settings: normalizeWeeklySettings(data.settings),
    genres: [...data.genres], playthroughs: data.playthroughs.map(row => ({top_ref: row.top_ref, title: row.title}))};
}
export function normalizeWeeklyPreview(data) {
  if (!data || !Array.isArray(data.albums) || data.albums.length > 7 || !Array.isArray(data.summary)
    || data.summary.length > 10 || data.summary.some(row => typeof row !== 'string' || row.length > 1200)) fail();
  const refs = new Set();
  const albums = data.albums.map(row => {
    const candidate = row?.candidate_ref ?? row?.catalog_ref;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const linked = typeof row?.catalog_ref === 'string' && uuid.test(row.catalog_ref) && candidate === row.catalog_ref;
    const inventory = row?.catalog_ref === null && typeof candidate === 'string' && /^inventory-album:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/.test(candidate);
    if (!row || !(linked || inventory) || refs.has(candidate)
      || typeof row.title !== 'string' || typeof row.artist_display !== 'string'
      || !(row.release_year === null || integer(row.release_year, 1, 9999)) || typeof row.suggested !== 'boolean'
      || !(row.cover_url === null || typeof row.cover_url === 'string' && /^\/(?!\/)/.test(row.cover_url) && !/[\\\u0000-\u0020\u007f]/.test(row.cover_url))) fail();
    refs.add(candidate);
    return {...row, candidate_ref: candidate};
  });
  const gaps = data.evidence_gaps ?? [];
  if (!Array.isArray(gaps) || gaps.some(value => !['broad_genres', 'listening_taste', 'album_popularity'].includes(value))) fail();
  return {albums, summary: [...data.summary], evidence_gaps: [...gaps]};
}
