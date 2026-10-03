/** Fictional, in-memory playlist UI state. No transport, storage or audio. */
import { albums, artists } from './fixture-data.mjs';
import { activity } from './listening-model.mjs';
import { buildRecentListening } from './recent-history.mjs';

export const LOVED_PLAYLIST_ID = 'loved-and-obsessed';
export const LOVE_STATES = Object.freeze(['none', 'loved', 'obsessed']);
export const PLAYLIST_FILTER_EXPIRY_MS = 7 * 86400000;
export const PLAYLIST_FREQUENCY = Object.freeze({ frequentMin: 20, midMin: 10, forgottenMonths: 6 });
export const DEFAULT_PLAYLIST_FILTERS = Object.freeze({
  love: 'all', style: '', minDuration: null, maxDuration: null,
  addedWithinDays: null, minListens: null, maxListens: null,
  frequency: 'all', frequencyMode: 'only', includeUnknown: true,
});
export const DEFAULT_PLAYLIST_MODES = Object.freeze({ shuffle: false, repeat: 'off' });
const DAY_MS = 86400000;
const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const frozen = value => Object.freeze(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const asTime = value => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
const timeValue = value => Number.isFinite(asTime(value)) ? asTime(value) : null;
const repeatValue = value => ['off', 'one', 'all'].includes(value) ? value : 'off';
export const nextLoveState = value => LOVE_STATES[(Math.max(0, LOVE_STATES.indexOf(value)) + 1) % LOVE_STATES.length];
export function trackIdentity(value) {
  return typeof value === 'string' ? value : String(value?.trackId || value?.track_ref || value?.path || value?.id || '');
}
export function loveStateFor(snapshot, track) {
  return snapshot?.preferences?.[trackIdentity(track)]?.state || 'none';
}

const allTimeCounts = new Map(activity('me', 'tracks', 82).map(row => [row.id, row.count]));
const lastListens = new Map(buildRecentListening('me', 'all', { limit: 0 }).tracks.map(row => [row.trackId, row.lastListenedAtMs]));
// Additional metadata is a read-only projection, never a change to the seed arrays.
export const playlistCatalog = frozen(albums.flatMap(album => album.tracks.map(track => {
  const artist = artists.find(value => value.id === album.mock.artist_id);
  const countsKnown = own(album.mock.counts, 'me') && knownNumber(album.mock.counts.me);
  return frozen({
    id: trackIdentity(track), trackId: trackIdentity(track), title: track.title,
    track, album, artist: artist?.name || album.album_artist, artistId: artist?.id || null,
    styles: frozen((artist?.genre || '').split(' · ').filter(Boolean)),
    count: countsKnown ? (allTimeCounts.get(trackIdentity(track)) ?? 0) : null,
    durationSeconds: knownNumber(track.duration_seconds) ? track.duration_seconds : null,
    lastListenedAtMs: lastListens.get(trackIdentity(track)) ?? null,
    lastListenedKnown: countsKnown,
    fictional: true,
  });
})));
const catalogById = new Map(playlistCatalog.map(row => [row.id, row]));
export const playlistTrack = track => catalogById.get(trackIdentity(track)) || null;

function normalizeFilters(value = {}) {
  const next = { ...DEFAULT_PLAYLIST_FILTERS, ...value };
  if (!['all', 'loved', 'obsessed'].includes(next.love)) next.love = 'all';
  next.style = typeof next.style === 'string' ? next.style : '';
  // Retired numeric count ranges cannot silently filter or keep Reset dirty.
  next.minListens = null; next.maxListens = null;
  for (const key of ['minDuration', 'maxDuration', 'addedWithinDays']) {
    if (!knownNumber(next[key])) next[key] = null;
  }
  if (!['all', 'frequent', 'mid', 'barely', 'forgotten'].includes(next.frequency)) next.frequency = 'all';
  next.frequencyMode = next.frequencyMode === 'exclude' ? 'exclude' : 'only';
  next.includeUnknown = next.includeUnknown !== false;
  return frozen(next);
}
const nonePreference = frozen({ state: 'none', addedAt: null, changedAt: null });

/** Stable snapshots and synchronous subscribe notifications support React and native decorators. */
export function createPlaylistController({ now = Date.now, filterExpiryMs = PLAYLIST_FILTER_EXPIRY_MS } = {}) {
  const listeners = new Set();
  let snapshot = frozen({ revision: 0, preferences: frozen({}), filtersByPlaylist: frozen({}), modesByPlaylist: frozen({}) });
  const clock = () => {
    const stamp = timeValue(now());
    if (stamp === null) throw new TypeError('Playlist clock must return a timestamp');
    return stamp;
  };
  const publish = patch => {
    snapshot = frozen({ ...snapshot, ...patch, revision: snapshot.revision + 1 });
    for (const listener of [...listeners]) listener();
    return snapshot;
  };
  const getFilters = (playlistId = LOVED_PLAYLIST_ID, at = clock()) => {
    const entry = snapshot.filtersByPlaylist[playlistId];
    if (!entry || at - entry.lastActiveAt >= filterExpiryMs) return DEFAULT_PLAYLIST_FILTERS;
    return entry.filters.minListens != null || entry.filters.maxListens != null ? normalizeFilters(entry.filters) : entry.filters;
  };
  const touchPlaylist = (playlistId = LOVED_PLAYLIST_ID) => {
    const at = clock();
    const filters = getFilters(playlistId, at);
    publish({ filtersByPlaylist: frozen({ ...snapshot.filtersByPlaylist, [playlistId]: frozen({ filters, lastActiveAt: at }) }) });
    return filters;
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    now: clock,
    getLove: track => loveStateFor(snapshot, track),
    getPreference: track => snapshot.preferences[trackIdentity(track)] || nonePreference,
    cycleLove(track) {
      const id = trackIdentity(track);
      if (!catalogById.has(id)) return null;
      const previous = snapshot.preferences[id] || nonePreference;
      const state = nextLoveState(previous.state), at = clock();
      const preference = frozen({ state, addedAt: state === 'none' ? null : previous.addedAt ?? at, changedAt: at });
      publish({ preferences: frozen({ ...snapshot.preferences, [id]: preference }) });
      return preference;
    },
    getFilters,
    visitPlaylist: touchPlaylist,
    touchPlaylist,
    setFilters(playlistId = LOVED_PLAYLIST_ID, patch = {}) {
      const at = clock(), filters = normalizeFilters({ ...getFilters(playlistId, at), ...patch });
      publish({ filtersByPlaylist: frozen({ ...snapshot.filtersByPlaylist, [playlistId]: frozen({ filters, lastActiveAt: at }) }) });
      return filters;
    },
    resetFilters(playlistId = LOVED_PLAYLIST_ID) { return controller.setFilters(playlistId, DEFAULT_PLAYLIST_FILTERS); },
    getModes: (playlistId = LOVED_PLAYLIST_ID) => snapshot.modesByPlaylist[playlistId] || DEFAULT_PLAYLIST_MODES,
    setModes(playlistId = LOVED_PLAYLIST_ID, patch = {}) {
      const current = controller.getModes(playlistId);
      const modes = frozen({ shuffle: patch.shuffle == null ? current.shuffle : Boolean(patch.shuffle), repeat: repeatValue(patch.repeat ?? current.repeat) });
      publish({ modesByPlaylist: frozen({ ...snapshot.modesByPlaylist, [playlistId]: modes }) });
      touchPlaylist(playlistId);
      return modes;
    },
  };
  return frozen(controller);
}
export const playlistController = createPlaylistController();

/** Oldest-added first, then native catalog order for equal timestamps. */
export function buildPlaylistRows(snapshot, playlistId = LOVED_PLAYLIST_ID) {
  if (playlistId !== LOVED_PLAYLIST_ID) return [];
  return playlistCatalog.filter(row => loveStateFor(snapshot, row.id) !== 'none').map(row => ({
    ...row, love: loveStateFor(snapshot, row.id), addedAt: snapshot.preferences[row.id].addedAt,
    missing: row.count === null,
  })).sort((left, right) => (left.addedAt ?? Infinity) - (right.addedAt ?? Infinity));
}
export function buildPlaylists(snapshot) {
  const rows = buildPlaylistRows(snapshot);
  return {
    autoplaylists: rows.length ? [{ id: LOVED_PLAYLIST_ID, title: 'Loved and Obsessed', count: rows.length, album: rows[0].album, rows }] : [],
    manual: [],
  };
}

/** UTC calendar subtraction keeps filtering independent of the device timezone.
 * Preserve the instant's time of day, clamping a missing target day to month end.
 */
function calendarMonthsBefore(timestamp, months) {
  if (timestamp === null) return null;
  const cutoff = new Date(timestamp), day = cutoff.getUTCDate();
  if (!Number.isFinite(cutoff.getTime())) return null;
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const monthEnd = new Date(cutoff);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  cutoff.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return timeValue(cutoff);
}

/** Unknown values remain visible unless includeUnknown is explicitly false. */
export function filterPlaylistRows(rows, filters = DEFAULT_PLAYLIST_FILTERS, now = Date.now()) {
  const f = normalizeFilters(filters), at = timeValue(now);
  const forgottenCutoff = calendarMonthsBefore(at, PLAYLIST_FREQUENCY.forgottenMonths);
  const range = (value, min, max) => !knownNumber(value) ? f.includeUnknown
    : (min === null || value >= min) && (max === null || value <= max);
  return rows.filter(row => {
    if (f.love !== 'all' && row.love !== f.love) return false;
    if (f.style && (row.styles?.length ? !row.styles.includes(f.style) : !f.includeUnknown)) return false;
    if ((f.minDuration !== null || f.maxDuration !== null) && !range(row.durationSeconds, f.minDuration, f.maxDuration)) return false;
    if (f.addedWithinDays !== null) {
      if (row.addedAt === null || row.addedAt === undefined || at === null) { if (!f.includeUnknown) return false; }
      else if (at - row.addedAt > f.addedWithinDays * DAY_MS) return false;
    }
    if (f.frequency === 'all') return true;
    let matched = null;
    if (f.frequency === 'frequent' && knownNumber(row.count)) matched = row.count >= PLAYLIST_FREQUENCY.frequentMin;
    if (f.frequency === 'mid' && knownNumber(row.count)) matched = row.count >= PLAYLIST_FREQUENCY.midMin && row.count < PLAYLIST_FREQUENCY.frequentMin;
    if (f.frequency === 'barely' && knownNumber(row.count)) matched = row.count < PLAYLIST_FREQUENCY.midMin;
    if (f.frequency === 'forgotten') {
      if (knownNumber(row.lastListenedAtMs) && Number.isFinite(new Date(row.lastListenedAtMs).getTime()) && forgottenCutoff !== null) {
        matched = row.lastListenedAtMs <= forgottenCutoff;
      } else if (row.lastListenedKnown && row.count === 0 && row.lastListenedAtMs == null) {
        // Known never-listened tracks are Barely, not Forgotten: no last listen exists.
        matched = false;
      }
      // Missing/invalid dates otherwise stay unknown; never fabricate a timestamp.
    }
    return matched === null ? f.includeUnknown : f.frequencyMode === 'exclude' ? !matched : matched;
  });
}

function shuffleIds(ids, seed) {
  const result = [...ids];
  let value = (Number(seed) >>> 0) || 0x9e3779b9;
  for (let index = result.length - 1; index > 0; index--) {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    const chosen = (value >>> 0) % (index + 1);
    [result[index], result[chosen]] = [result[chosen], result[index]];
  }
  return result;
}
const freezeQueue = queue => frozen({ ...queue, originalTrackIds: frozen([...queue.originalTrackIds]), trackIds: frozen([...queue.trackIds]) });
export function createQueue({ playlistId = LOVED_PLAYLIST_ID, albumId = null, trackIds = [], currentTrackId = null, shuffle = false, repeat = 'off', seed = 1 } = {}) {
  const originalTrackIds = [...new Set(trackIds.map(trackIdentity).filter(Boolean))];
  let order = shuffle ? shuffleIds(originalTrackIds, seed) : [...originalTrackIds];
  const current = order.includes(currentTrackId) ? currentTrackId : order[0] || null;
  // A selected shuffled track starts the queue; every other row remains reachable.
  if (shuffle && current) order = [current, ...order.filter(id => id !== current)];
  return freezeQueue({ source: albumId ? 'album' : 'playlist', playlistId: albumId ? null : playlistId,
    albumId, originalTrackIds, trackIds: order, cursor: current ? order.indexOf(current) : -1,
    currentTrackId: current, shuffle: Boolean(shuffle), repeat: repeatValue(repeat), seed,
    ended: !current, transition: current ? 'select' : 'stop', reason: 'select' });
}
/** Returns a new queue; never selects native audio, counts a listen, or schedules advancement. */
export function advanceQueue(queue, { reason = 'next', direction = 1 } = {}) {
  if (!queue || !queue.trackIds.length) return queue;
  const fromEnded = reason === 'ended';
  if (fromEnded && queue.ended) return queue;
  if (fromEnded && queue.repeat === 'one') return freezeQueue({ ...queue, ended: false, transition: 'repeat', reason });
  let cursor = queue.cursor + (direction < 0 ? -1 : 1);
  if (cursor >= queue.trackIds.length || cursor < 0) {
    if (queue.repeat === 'all') cursor = (cursor + queue.trackIds.length) % queue.trackIds.length;
    else return freezeQueue({ ...queue, ended: true, transition: 'stop', reason });
  }
  return freezeQueue({ ...queue, cursor, currentTrackId: queue.trackIds[cursor], ended: false, transition: 'select', reason });
}
/** Filter and love edits do not call this helper and cannot rewrite an active queue. */
export function setQueueMode(queue, { shuffle = queue?.shuffle, repeat = queue?.repeat, seed = queue?.seed } = {}) {
  if (!queue) return queue;
  let order = [...queue.trackIds], cursor = queue.cursor;
  if (Boolean(shuffle) !== queue.shuffle || (shuffle && seed !== queue.seed)) {
    if (shuffle) {
      const history = queue.trackIds.slice(0, queue.cursor + 1);
      order = [...history, ...shuffleIds(queue.originalTrackIds.filter(id => !history.includes(id)), seed)];
    } else order = [...queue.originalTrackIds];
    cursor = order.indexOf(queue.currentTrackId);
  }
  return freezeQueue({ ...queue, trackIds: order, cursor, shuffle: Boolean(shuffle), repeat: repeatValue(repeat), seed, transition: 'mode', reason: 'mode' });
}
export function queueOrigin(queue) {
  return queue?.currentTrackId ? frozen({ source: queue.source, playlistId: queue.playlistId,
    albumId: queue.albumId, trackId: queue.currentTrackId }) : null;
}
export function playlistSelection(track, playlistId = LOVED_PLAYLIST_ID) {
  const row = playlistTrack(track);
  return row ? { ...row, playlistId, trackId: row.id, albumId: row.album.id } : null;
}
