import {DEFAULT_PLAYLIST_FILTERS, normalizePlaylistFilters} from './filters.mjs';

export const DEFAULT_SAVED_FILTERS = Object.freeze({query: '', availability: 'all', ...DEFAULT_PLAYLIST_FILTERS});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => Object.assign(new Error('Playlist filter preferences are unavailable.'), {status: 502});
export const filterRef = value => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const filterRevision = value => typeof value === 'string' && value.length <= 19
  && !/[^0-9]/.test(value) && /^[1-9]/.test(value) && BigInt(value) <= 9223372036854775807n;
function validString(value, max) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function savedFilters(value) {
  if (value === null) return null;
  if (!object(value) || Object.keys(value).length !== Object.keys(DEFAULT_SAVED_FILTERS).length
    || Object.keys(DEFAULT_SAVED_FILTERS).some(key => !own(value, key))
    || !validString(value.query, 200) || !validString(value.style, 100)
    || !['all', 'local', 'missing', 'unresolved'].includes(value.availability)) throw invalid();
  const result = {query: value.query, availability: value.availability, ...normalizePlaylistFilters(value)};
  if (Object.keys(result).some(key => !Object.is(result[key], value[key]))) throw invalid();
  return Object.freeze(result);
}
function serverDate(value) {
  if (typeof value !== 'string' || value.length > 32
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
    || /[\r\n]/.test(value)) throw invalid();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid();
  return ms;
}
export function filterProjection(value, ref) {
  if (!object(value) || !filterRef(ref) || value.playlist_ref !== ref || !filterRevision(value.revision)) throw invalid();
  const filters = savedFilters(value.filters), now = serverDate(value.server_time);
  const expiry = value.expires_at === null ? null : serverDate(value.expires_at);
  if ((filters === null) !== (expiry === null) || expiry !== null && (expiry < now || expiry - now > 7 * 86400000)) throw invalid();
  return Object.freeze({playlist_ref: ref, revision: value.revision, filters,
    // This is a scheduling hint only. The server read determines actual expiry.
    remainingMs: expiry === null ? null : Math.max(1, expiry - now)});
}

export function createFilterPreferenceProviders({request}) {
  return Object.freeze({
    async readFilterPreferences(options) {
      if (!filterRef(options.playlist_id)) throw invalid();
      return filterProjection(await request(`/playlists/${options.playlist_id}/filter-preferences`, options), options.playlist_id);
    },
    async saveFilterPreferences(options) {
      if (!filterRef(options.playlist_id) || !filterRef(options.request_key) || !filterRevision(options.revision)) throw invalid();
      const filters = savedFilters(options.filters);
      const value = await request(`/playlists/${options.playlist_id}/filter-preferences`, options, 'PUT',
        {revision: options.revision, request_key: options.request_key, filters});
      if (value?.ok !== true || value.action !== 'playlist_filter_preferences' || value.playlist_ref !== options.playlist_id
        || value.request_key !== options.request_key || !filterRevision(value.revision) || typeof value.changed !== 'boolean') throw invalid();
      return Object.freeze({revision: value.revision, changed: value.changed});
    },
  });
}

export function createPlaylistFilterMemory({providers, onRestore, onStatus,
  key = () => globalThis.crypto.randomUUID(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id)}) {
  const entries = new Map(); let active = null, disposed = false;
  const current = entry => !disposed && active === entry;
  const status = (entry, value) => {entry.status = value; if (current(entry)) onStatus(value);};
  const stopTimer = entry => {if (entry.timer !== null) cancel(entry.timer); entry.timer = null;};
  function announce(entry, projection) {
    if (!current(entry)) return;
    stopTimer(entry);
    if (entry.desired === undefined && !entry.invalid) onRestore(projection.filters || DEFAULT_SAVED_FILTERS);
    if (!current(entry)) return;
    if (entry.desired === undefined && !entry.invalid && projection.remainingMs !== null) entry.timer = schedule(() => {
      entry.timer = null;
      if (current(entry)) void drive(entry);
    }, projection.remainingMs);
  }
  async function drive(entry) {
    if (!current(entry) || entry.running) return;
    entry.running = true; status(entry, 'loading');
    const abort = new AbortController(); entry.abort = abort;
    const options = {scopeKey: entry.scope, playlist_id: entry.ref, signal: abort.signal};
    const live = () => current(entry) && entry.abort === abort && !abort.signal.aborted;
    try {
      while (live()) {
        if (entry.operation) {
          const operation = entry.operation;
          await providers().saveFilterPreferences({...options, ...operation});
          if (!live()) return;
          entry.operation = null;
          if (entry.version === operation.localVersion) entry.desired = undefined;
        }
        const projection = await providers().readFilterPreferences(options);
        if (!live()) return;
        if (projection?.playlist_ref !== entry.ref || !filterRevision(projection.revision)) throw invalid();
        entry.revision = projection.revision;
        if (entry.invalid) {
          status(entry, 'unsaved');
          if (live() && !entry.invalid && entry.desired !== undefined) continue;
          return;
        }
        if (entry.desired === undefined) {
          announce(entry, projection);
          if (live() && (entry.desired !== undefined || entry.invalid)) continue;
          if (live()) status(entry, 'saved');
          if (live() && (entry.desired !== undefined || entry.invalid)) continue;
          return;
        }
        // Serialize explicit changes; an uncertain previous operation is always
        // recovered using its original key before this new intent can be sent.
        entry.operation = {request_key: key(), revision: entry.revision,
          filters: entry.desired, localVersion: entry.version};
      }
    } catch (error) {
      if (!live()) return;
      if (error?.status === 409 && error?.code === 'revision_conflict' && error?.responseRejected === true && entry.operation) {
        // Explicit Retry will reread current revision before reapplying intent.
        // Do not silently merge a conflicting old write.
        entry.operation = null;
      }
      status(entry, error?.status === 403 || error?.status === 404 ? 'denied' : 'unsaved');
    } finally {
      entry.running = false;
      if (entry.abort === abort) entry.abort = null;
      if (current(entry) && abort.signal.aborted) void drive(entry);
    }
  }
  function suspend() {
    if (!active) return;
    stopTimer(active); active.abort?.abort(); active = null;
  }
  return Object.freeze({
    open(scope, ref, {defer = false} = {}) {
      if (disposed || !scope || !filterRef(ref)) {suspend(); return;}
      if (active?.scope === scope && active.ref === ref) return;
      suspend(); const id = JSON.stringify([scope, ref]);
      let entry = entries.get(id);
      if (!entry) {entry = {scope, ref, desired: undefined, invalid: false, version: 0, operation: null, running: false,
        timer: null, abort: null, status: 'loading'}; entries.set(id, entry);}
      active = entry; if (!defer) void drive(entry);
    },
    change(value, {defer = false} = {}) {
      if (!active || disposed) return;
      const entry = active;
      entry.version++; stopTimer(entry);
      let filters;
      try {filters = savedFilters(value);} catch {
        entry.invalid = true; entry.desired = undefined;
        if (!defer) status(entry, 'unsaved');
        return;
      }
      entry.invalid = false;
      active.desired = equal(filters, DEFAULT_SAVED_FILTERS) ? null : filters;
      if (!defer) void drive(active);
    },
    retry() {if (active && !disposed) void drive(active);},
    suspend,
    reset() {suspend(); entries.clear();},
    dispose() {suspend(); entries.clear(); disposed = true;},
  });
}
