// Display-only facts and filter choices. No identity, permission, persistence,
// listening totals or playlist membership is inferred by this module.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const DAY_MS = 86400000;
const unknownFacts = Object.freeze({love_tier: null, styles: null, duration_seconds: null,
  play_count: null, popularity_count: null, track_rating: null,
  added_at_ms: null, listen_count: null, last_listened_at_ms: null, last_listened_known: false});

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const datePart = value.slice(0, 10), date = new Date(`${datePart}T00:00:00Z`);
  // Date.parse otherwise silently repairs invalid calendar days in some engines.
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function styles(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const values = Array.from(value);
  if (values.some(item => typeof item !== 'string' || !item.trim() || item.length > 100 || /[\x00-\x1f\x7f]/.test(item))) return null;
  return Object.freeze([...new Set(values.map(item => item.trim()))]);
}
export function normalizePlaylistFacts(source) {
  if (!object(source) || source.source_readable === false
    || own(source.allowed_actions, 'can_read') && source.allowed_actions.can_read === false) return unknownFacts;
  // These are explicit provider fields, never scrobble_count, a mock catalogue,
  // preference defaults, filenames, genre/title guesses or borrowed album data.
  const last = own(source, 'last_listened_at') ? timestamp(source.last_listened_at) : null;
  return Object.freeze({
    love_tier: own(source, 'love_tier') && ['off', 'loved', 'obsessed'].includes(source.love_tier) ? source.love_tier : null,
    styles: own(source, 'styles') ? styles(source.styles) : null,
    duration_seconds: own(source, 'duration_seconds') ? number(source.duration_seconds) : null,
    play_count: own(source, 'play_count') ? count(source.play_count) : null,
    popularity_count: own(source, 'popularity_count') ? count(source.popularity_count) : null,
    track_rating: own(source, 'track_rating') && Number.isInteger(source.track_rating)
      && source.track_rating >= 1 && source.track_rating <= 5 ? source.track_rating : null,
    added_at_ms: own(source, 'added_at') ? timestamp(source.added_at) : null,
    listen_count: own(source, 'listen_count') ? count(source.listen_count) : null,
    last_listened_at_ms: last,
    last_listened_known: own(source, 'last_listened_known') && source.last_listened_known === true
      && own(source, 'last_listened_at') && (source.last_listened_at === null || last !== null),
  });
}

const lengthPreset = (minDuration, maxDuration, minDurationExclusive = false, maxDurationExclusive = false) =>
  Object.freeze({minDuration, maxDuration, minDurationExclusive, maxDurationExclusive});
export const PLAYLIST_LENGTH_PRESETS = Object.freeze({
  all: lengthPreset(null, null), short: lengthPreset(null, 180, false, true),
  medium: lengthPreset(180, 300), long: lengthPreset(300, null, true), epic: lengthPreset(480, null, true),
});
export const PLAYLIST_LENGTH_RANGES = Object.freeze(Object.fromEntries(Object.entries(PLAYLIST_LENGTH_PRESETS)
  .map(([key, value]) => [key, Object.freeze([value.minDuration, value.maxDuration])])));
export const DEFAULT_PLAYLIST_FILTERS = Object.freeze({love: 'all', style: '', ...PLAYLIST_LENGTH_PRESETS.all,
  addedWithinDays: null, frequency: 'all', frequencyMode: 'only', includeUnknown: true});
export function normalizePlaylistFilters(value = {}) {
  const source = object(value) ? value : {};
  const get = key => own(source, key) ? source[key] : undefined;
  const frequency = ['all', 'frequent', 'mid', 'barely', 'forgotten'].includes(get('frequency')) ? get('frequency') : 'all';
  const min = number(get('minDuration')), max = number(get('maxDuration'));
  const validRange = min === null || max === null || min <= max;
  return Object.freeze({love: ['all', 'loved', 'obsessed'].includes(get('love')) ? get('love') : 'all',
    style: typeof get('style') === 'string' && get('style').length <= 100 && !/[\x00-\x1f\x7f]/.test(get('style')) ? get('style').trim() : '',
    minDuration: validRange ? min : null, maxDuration: validRange ? max : null,
    minDurationExclusive: validRange && min !== null && get('minDurationExclusive') === true,
    maxDurationExclusive: validRange && max !== null && get('maxDurationExclusive') === true,
    addedWithinDays: [1, 7, 30, 90].includes(get('addedWithinDays')) ? get('addedWithinDays') : null,
    frequency, frequencyMode: frequency !== 'all' && get('frequencyMode') === 'exclude' ? 'exclude' : 'only',
    includeUnknown: get('includeUnknown') !== false,
  });
}
export function playlistFiltersActive(value) {
  const filters = normalizePlaylistFilters(value);
  // includeUnknown is a policy for active facts, not a hidden filter by itself.
  return filters.love !== 'all' || Boolean(filters.style) || filters.minDuration !== null
    || filters.maxDuration !== null || filters.addedWithinDays !== null || filters.frequency !== 'all';
}
export function playlistLengthValue(value) {
  const filters = normalizePlaylistFilters(value);
  return Object.keys(PLAYLIST_LENGTH_PRESETS).find(key => Object.entries(PLAYLIST_LENGTH_PRESETS[key])
    .every(([field, expected]) => filters[field] === expected)) || 'custom';
}
function monthsBefore(at, months) {
  if (at === null) return null;
  const date = new Date(at), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(date); lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return date.getTime();
}
function matches(row, filters, at) {
  const value = object(row) ? row : unknownFacts;
  const known = (fact, match) => fact === null ? filters.includeUnknown : match(fact);
  const love = ['off', 'loved', 'obsessed'].includes(value.love_tier) ? value.love_tier : null;
  if (filters.love !== 'all' && !known(love, tier => tier === filters.love || filters.love === 'loved' && tier === 'obsessed')) return false;
  const rowStyles = Array.isArray(value.styles) ? value.styles : null;
  if (filters.style && !known(rowStyles, choices => choices.includes(filters.style))) return false;
  const length = number(value.duration_seconds);
  if ((filters.minDuration !== null || filters.maxDuration !== null) && !known(length,
    duration => (filters.minDuration === null || (filters.minDurationExclusive ? duration > filters.minDuration : duration >= filters.minDuration))
      && (filters.maxDuration === null || (filters.maxDurationExclusive ? duration < filters.maxDuration : duration <= filters.maxDuration)))) return false;
  if (filters.addedWithinDays !== null) {
    const added = timestamp(value.added_at_ms);
    if (!known(added === null || at === null || added > at ? null : added, date => at - date <= filters.addedWithinDays * DAY_MS)) return false;
  }
  if (filters.frequency === 'all') return true;
  const listens = count(value.listen_count);
  let match = null;
  if (filters.frequency === 'frequent' && listens !== null) match = listens >= 20;
  if (filters.frequency === 'mid' && listens !== null) match = listens >= 10 && listens < 20;
  if (filters.frequency === 'barely' && listens !== null) match = listens < 10;
  if (filters.frequency === 'forgotten') {
    const last = timestamp(value.last_listened_at_ms), cutoff = monthsBefore(at, 6);
    if (last !== null && cutoff !== null && last <= at) match = last <= cutoff;
    else if (value.last_listened_known === true && listens === 0 && value.last_listened_at_ms === null) match = false;
  }
  return match === null ? filters.includeUnknown : filters.frequencyMode === 'exclude' ? !match : match;
}
// Predicates consume normalized facts (normally spread onto the row by model.mjs).
// Retain source objects and order; filters never copy, sort or mutate membership.
export function matchesPlaylistFilters(row, value = DEFAULT_PLAYLIST_FILTERS, now = Date.now()) {
  return matches(row, normalizePlaylistFilters(value), timestamp(now));
}
export function filterPlaylistRows(rows, value = DEFAULT_PLAYLIST_FILTERS, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  const filters = normalizePlaylistFilters(value), at = timestamp(now);
  return rows.filter(row => object(row) && matches(row, filters, at));
}
export function groupPlaylists(items) {
  const groups = {autoplaylists: [], manual: [], unclassified: []};
  if (Array.isArray(items)) for (const item of items) {
    if (!object(item) || !own(item, 'playlist_id') || typeof item.playlist_id !== 'string'
      || !item.playlist_id.trim() || /[\x00-\x1f\x7f]/.test(item.playlist_id)) continue;
    const kind = own(item, 'playlist_kind') ? item.playlist_kind : null;
    groups[kind === 'autoplaylist' ? 'autoplaylists' : kind === 'manual' ? 'manual' : 'unclassified'].push(item);
  }
  for (const key of Object.keys(groups)) Object.freeze(groups[key]);
  return Object.freeze(groups);
}
