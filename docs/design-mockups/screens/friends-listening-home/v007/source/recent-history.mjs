/**
 * Fictional v007 presentation projection. Copy beside fixture-data.mjs and
 * listening-model.mjs before importing. This is neither event storage nor an
 * authorization layer: the caller retains its existing readable-person gate.
 */
import { albums, artists, people, periods } from './fixture-data.mjs';
import { activity } from './listening-model.mjs';

export const FICTIONAL_LISTENING_ANCHOR = '2026-10-01T18:00:00.000Z';
export const DEFAULT_HISTORY_LIMIT = 80;
export const MAX_HISTORY_LIMIT = 200;
const ANCHOR_MS = Date.parse(FICTIONAL_LISTENING_ANCHOR);
const DAY_MS = 86400000;
const MODEL_VERSION = 'fictional-listen-projection-v007';

// These are deliberately fixed preview windows, not calendar arithmetic.
// The cumulative factors exactly match the existing activity() fixtures.
const BANDS = Object.freeze([
  { id: 'week', startDay: 0, endDay: 7, factor: 1 },
  { id: 'month', startDay: 7, endDay: 30, factor: 4 },
  { id: 'six', startDay: 30, endDay: 183, factor: 19 },
  { id: 'year', startDay: 183, endDay: 365, factor: 37 },
  { id: 'all', startDay: 365, endDay: 730, factor: 82 },
].map((band, index, all) => Object.freeze({
  ...band, additionalFactor: band.factor - (all[index - 1]?.factor || 0),
})));

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const hasCount = (album, personId) =>
  Object.prototype.hasOwnProperty.call(album.mock?.counts || {}, personId)
    && validCount(album.mock.counts[personId]);
const sumCounts = rows => rows.reduce((total, row) => total + row.count, 0);

function historyLimit(value) {
  return Number.isFinite(value)
    ? Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.floor(value)))
    : DEFAULT_HISTORY_LIMIT;
}

function scopeFor(personId, periodId, options = {}) {
  const bandIndex = BANDS.findIndex(band => band.id === periodId);
  const period = periods.find(value => value.id === periodId);
  const result = {
    personId, periodId, factor: period?.factor ?? null, bandIndex,
    status: 'ready', reason: null, missingAlbumIds: [], unknownAlbumIds: [],
    albumIds: [], knownAlbumIds: new Set(),
    fixture: {
      fictional: true, provenance: MODEL_VERSION,
      anchor: FICTIONAL_LISTENING_ANCHOR,
      coverageStart: new Date(ANCHOR_MS - 730 * DAY_MS).toISOString(),
      periodStart: bandIndex < 0 ? null
        : new Date(ANCHOR_MS - BANDS[bandIndex].endDay * DAY_MS).toISOString(),
      timeZone: 'UTC', timestamps: 'synthetic-from-aggregate-counts',
      authorization: 'caller-owned', storedEvents: false,
    },
  };
  const unavailable = reason => ({ ...result, status: 'unavailable', reason });
  if (!people.some(person => person.id === personId)) return unavailable('unknown-person');
  if (!period || bandIndex < 0) return unavailable('unknown-period');
  if (period.factor !== BANDS[bandIndex].factor) return unavailable('unsupported-period-factor');
  if (!albums.some(album => hasCount(album, personId))) return unavailable('missing-person-counts');
  if (options.albumIds != null && !Array.isArray(options.albumIds)
      && !(options.albumIds instanceof Set)) return unavailable('invalid-album-scope');

  const requested = options.albumIds == null ? null : new Set(options.albumIds);
  const scoped = albums.filter(album => !requested || requested.has(album.id) || requested.has(album.key));
  result.albumIds = scoped.map(album => album.id);
  result.missingAlbumIds = scoped.filter(album => !hasCount(album, personId)).map(album => album.id);
  result.unknownAlbumIds = requested ? [...requested]
    .filter(id => !albums.some(album => album.id === id || album.key === id)) : [];
  result.knownAlbumIds = new Set(scoped.filter(album => hasCount(album, personId)).map(album => album.id));
  if (result.missingAlbumIds.length || result.unknownAlbumIds.length) {
    result.status = result.knownAlbumIds.size ? 'partial' : 'unavailable';
    result.reason = 'incomplete-album-counts';
  }
  return result;
}

function publicScope(scope) {
  const { knownAlbumIds, bandIndex, ...metadata } = scope;
  return metadata;
}

// A stable per-person/per-track phase separates timestamps without random or
// clock reads. Neither album selection nor period changes can alter the phase.
function phaseFor(personId, trackId) {
  let hash = 2166136261;
  for (const character of `${personId}\u0000${trackId}`) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  }
  return ((hash % 65535) + 1) / 65536;
}

function listenAt(row, personId, band, baseCount, index) {
  const count = baseCount * band.additionalFactor;
  const width = (band.endDay - band.startDay) * DAY_MS;
  const offset = band.startDay * DAY_MS + 1
    + Math.floor(((index + phaseFor(personId, row.id)) / count) * (width - 1));
  const listenedAtMs = ANCHOR_MS - offset;
  const listenId = `${MODEL_VERSION}:${encodeURIComponent(personId)}:${encodeURIComponent(row.id)}:${band.id}:${index + 1}`;
  return {
    ...row,
    id: listenId, listenId, trackId: row.id, personId,
    count: 1, aggregateCount: row.count,
    listenedAt: new Date(listenedAtMs).toISOString(), listenedAtMs,
    synthetic: true,
  };
}

const compareListens = (left, right) => right.listenedAtMs - left.listenedAtMs
  || compareText(left.listenId, right.listenId);

/**
 * Return grouped recent tracks and a bounded newest-first repeated-track view.
 * options.albumIds is an optional array/Set of fixture album IDs or keys.
 * options.limit defaults to 80, is clamped to 0..200, and affects history only.
 * Positive counts remain exactly activity(personId, 'tracks', period.factor).
 */
export function buildRecentListening(personId = 'me', periodId = 'week', options = {}) {
  const scope = scopeFor(personId, periodId, options);
  const limit = historyLimit(options.limit);
  const result = {
    ...publicScope(scope), tracks: [], history: [], limit,
    totalPlays: null, shownPlays: 0, truncated: false,
    totalComplete: scope.status === 'ready',
  };
  if (scope.status === 'unavailable') return result;
  const rows = activity(personId, 'tracks', scope.factor)
    .filter(row => scope.knownAlbumIds.has(row.album.id));
  result.totalPlays = sumCounts(rows);
  result.tracks = rows.map(row => {
    const latest = listenAt(row, personId, BANDS[0], row.count / scope.factor, 0);
    return {
      ...row, trackId: row.id, personId,
      lastListenedAt: latest.listenedAt, lastListenedAtMs: latest.listenedAtMs,
      lastListenId: latest.listenId, synthetic: true,
    };
  }).sort((left, right) => right.lastListenedAtMs - left.lastListenedAtMs
    || compareText(left.id, right.id));

  // One cursor per positive track/band. Expand only the requested newest slice;
  // All time never allocates one object for every aggregate play.
  const cursors = rows.flatMap(row => BANDS.slice(0, scope.bandIndex + 1).map(band => {
    const baseCount = row.count / scope.factor;
    return {
      row, band, baseCount, index: 0, count: baseCount * band.additionalFactor,
      next: listenAt(row, personId, band, baseCount, 0),
    };
  }));
  while (result.history.length < limit && cursors.length) {
    let newest = 0;
    for (let index = 1; index < cursors.length; index++) {
      if (compareListens(cursors[index].next, cursors[newest].next) < 0) newest = index;
    }
    const cursor = cursors[newest];
    result.history.push(cursor.next);
    cursor.index++;
    if (cursor.index === cursor.count) cursors.splice(newest, 1);
    else cursor.next = listenAt(cursor.row, personId, cursor.band, cursor.baseCount, cursor.index);
  }
  result.shownPlays = result.history.length;
  result.truncated = result.shownPlays < result.totalPlays;
  if (!result.totalPlays && scope.status === 'ready') result.status = 'empty';
  return result;
}

/**
 * Owner item 10: selected artist's listened albums for the same person, period,
 * and optional album scope. No selection means no album list. This must not be
 * reused as full discography: unheard and unavailable albums remain absent.
 */
export function recentArtistAlbums(artistId, personId = 'me', periodId = 'week', options = {}) {
  const scope = scopeFor(personId, periodId, options);
  const result = { ...publicScope(scope), artistId: artistId || null, rows: [], totalPlays: null };
  if (scope.status === 'unavailable') return result;
  if (!artistId) return { ...result, status: 'unselected', reason: 'select-artist' };
  const artist = artists.find(value => value.id === artistId || value.name === artistId);
  if (!artist) return { ...result, status: 'unavailable', reason: 'unknown-artist' };
  result.artistId = artist.id;
  result.rows = activity(personId, 'albums', scope.factor)
    .filter(row => scope.knownAlbumIds.has(row.album.id) && row.album.mock.artist_id === artist.id)
    .sort((left, right) => left.album.mock.recent - right.album.mock.recent
      || compareText(left.id, right.id));
  result.totalPlays = sumCounts(result.rows);
  if (!result.rows.length && scope.status === 'ready') result.status = 'empty';
  return result;
}
