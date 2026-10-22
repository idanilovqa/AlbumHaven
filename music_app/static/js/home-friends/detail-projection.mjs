import {resource, safeServerArtworkUrl} from './model.mjs';
import {detailSelection, detailSelectionKey, matchingDetail, nativeActions} from './resource-target.mjs';
export {detailOrigin, detailSelection, detailSelectionKey, matchingDetail} from './resource-target.mjs';

// Display-only boundary. Neither history access nor these DTOs authorize media
// reads, native navigation, or playback. The host supplies current source grants.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const text = value => typeof value === 'string' ? value : '';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const freshness = value => ['current', 'last_known', 'unknown'].includes(value) ? value : 'unknown';
const freeze = Object.freeze;
const invalid = () => { throw new TypeError('Invalid Home detail projection.'); };

function rows(value, normalize) {
  if (value == null) return null; // Not supplied is different from a known empty collection.
  if (!Array.isArray(value)) invalid();
  const result = Array.from(value, row => {
    if (!object(row) || !reference(row.id)) invalid();
    return freeze(normalize(row));
  });
  if (new Set(result.map(row => row.id)).size !== result.length) invalid();
  return freeze(result);
}
function identity(value) {
  return {title: text(value.title), artwork_url: safeServerArtworkUrl(value.artwork_url),
    metadata_state: freshness(value.metadata_state)};
}

export function normalizeDetailResult(result, selection) {
  let status = 'ready', data = result;
  if (object(result) && Object.hasOwn(result, 'status')) {
    ({status, data} = result);
    if (!['ready', 'empty', 'denied', 'unavailable'].includes(status)) invalid();
    if (status !== 'ready') {
      if (status === 'empty' && data != null) invalid();
      return resource(status);
    }
  }
  const target = detailSelection(selection);
  if (!object(data) || !target || !matchingDetail(data, target)) invalid();
  const normalized = {
    kind: data.kind, ref: data.ref, ...identity(data), artist: text(data.artist),
    year: text(data.year), release_type: text(data.release_type),
    summary: text(data.summary), source_label: text(data.source_label),
    duration_seconds: number(data.duration_seconds), track_count: integer(data.track_count),
    release_count: integer(data.release_count), native_actions: nativeActions(data.native_actions, data.kind),
    ...(target.origin ? {origin: target.origin} : {}),
  };
  if (data.kind === 'album') {
    normalized.tracks = rows(data.tracks, row => ({id: row.id, title: text(row.title), artist: text(row.artist),
      track_number: integer(row.track_number), disc_number: integer(row.disc_number), duration_seconds: number(row.duration_seconds)}));
  } else {
    normalized.listened_albums = rows(data.listened_albums, row => {
      const detail_target = row.detail_target == null ? null : detailSelection(row.detail_target);
      if (row.detail_target != null && (!detail_target || detail_target.kind !== 'album')) invalid();
      if (detail_target?.origin && target.origin
        && JSON.stringify(detail_target.origin) !== JSON.stringify(target.origin)) invalid();
      return {id: row.id, ...identity(row), year: text(row.year), release_type: text(row.release_type),
        detail_target: detail_target && target.origin ? detailSelection({...detail_target, origin: target.origin}) : detail_target,
        native_actions: nativeActions(row.native_actions)};
    });
    normalized.discography = rows(data.discography, row => ({id: row.id, ...identity(row),
      year: text(row.year), release_type: text(row.release_type), native_actions: nativeActions(row.native_actions)}));
  }
  return resource('ready', freeze(normalized));
}

export function createDetailProjectionController({readDetail} = {}) {
  let provider = typeof readDetail === 'function' ? readDetail : null;
  let state = freeze({scopeKey: null, selection: null, detail: resource()}), request = null, disposed = false;
  const listeners = new Set();
  function publish(patch) {
    if (disposed) return;
    state = freeze({...state, ...patch});
    for (const listener of listeners) listener();
  }
  function abort() {
    const previous = request; request = null; previous?.abort();
  }
  function clear() {
    if (disposed) return;
    abort(); publish({selection: null, detail: resource()});
  }
  function select(value) {
    if (disposed) return false;
    const selection = detailSelection(value);
    if (selection && detailSelectionKey(state.selection) === detailSelectionKey(selection)) {
      return selection.allowed_actions.can_view_details;
    }
    abort();
    publish({selection, detail: resource(selection && !selection.allowed_actions.can_view_details ? 'denied' : 'unavailable')});
    return selection?.allowed_actions.can_view_details === true;
  }
  function load() {
    if (disposed) return Promise.resolve(resource());
    abort();
    const {scopeKey, selection} = state;
    const status = selection && !selection.allowed_actions.can_view_details ? 'denied'
      : !selection || !reference(scopeKey) || !provider ? 'unavailable' : null;
    if (status) {
      const next = resource(status); publish({detail: next}); return Promise.resolve(next);
    }
    const pending = new AbortController(); request = pending;
    const active = () => !disposed && request === pending && !pending.signal.aborted;
    publish({detail: resource('loading')});
    if (!active()) return Promise.resolve(state.detail);
    let result;
    try { result = provider({scopeKey, kind: selection.kind, ref: selection.ref,
      ...(selection.origin ? {origin: selection.origin} : {}), signal: pending.signal}); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(value => {
      if (!active()) return state.detail;
      const next = normalizeDetailResult(value, selection);
      request = null; publish({detail: next}); return next;
    }).catch(error => {
      if (!active()) return state.detail;
      request = null;
      const next = resource(error?.status === 401 || error?.status === 403 ? 'denied'
        : error?.name === 'AbortError' ? 'unavailable' : 'error');
      publish({detail: next}); return next;
    });
  }
  return freeze({
    getSnapshot: () => state,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Detail subscription requires a listener.');
      if (disposed) return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    },
    setScope(scopeKey) {
      if (disposed || state.scopeKey === scopeKey) return;
      abort(); publish({scopeKey, selection: null, detail: resource()});
    },
    configure({readDetail} = {}) {
      const next = typeof readDetail === 'function' ? readDetail : null;
      if (disposed || provider === next) return;
      provider = next; clear();
    },
    select, load, clear,
    dispose() {
      if (disposed) return;
      abort(); disposed = true; listeners.clear(); provider = null;
      state = freeze({scopeKey: null, selection: null, detail: resource()});
    },
  });
}
