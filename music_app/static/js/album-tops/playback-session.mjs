import {createAlbumTopBackendProviders} from './backend-providers.mjs';
import {createTopPlaybackSource} from './playback-source.mjs';

const sessions = new WeakMap();
const abort = () => Object.assign(new Error('Album Top playback was superseded.'), {name: 'AbortError'});
const modes = new Set(['in_order', 'random_albums', 'random_songs', 'popular_songs']);
// One admission owner per native shell, independent of any mounted Top view.
// Providers and source receipts live only as long as their native queue does.
export function getAlbumTopPlaybackSession(runtime) {
  if (sessions.has(runtime)) return sessions.get(runtime);
  const native = runtime.playback;
  if (!native) throw new TypeError('Native Top playback is unavailable.');
  const retained = new Set();
  let pending = null, active = null, intent = 0;
  function retire(entry) {
    if (!entry || entry.retired) return;
    entry.retired = true;
    entry.unsubscribe?.(); entry.unsubscribe = null;
    entry.signal?.removeEventListener('abort', entry.cancel);
    entry.controller.abort();
    if (pending === entry) pending = null;
    if (active === entry) active = null;
    retained.delete(entry);
    if (entry.queue) native.dispose(entry.queue);
    entry.provider?.dispose();
  }
  function scopeCurrent(entry) {
    if (entry.retired) return false;
    try {if (entry.scope.isCurrent() === true && !entry.retired) return true;} catch {}
    retire(entry); return false;
  }
  function admissionCurrent(entry) {
    const owned = () => !entry.retired && pending === entry && !entry.signal?.aborted;
    if (!owned() || !scopeCurrent(entry)) return false;
    try {return entry.isCurrent() === true && owned() && scopeCurrent(entry);} catch {return false;}
  }
  function current(topRef, scopeKey) {
    for (const owned of [...retained]) if (owned !== pending && owned.queue && scopeCurrent(owned)) native.describe(owned.queue);
    const entry = active;
    if (!entry || entry.topRef !== topRef || entry.scopeKey !== scopeKey || !scopeCurrent(entry)) return null;
    const value = native.describe(entry.queue);
    if (!value || value.ended || entry.retired || active !== entry) return null;
    return entry;
  }
  const api = Object.freeze({
    snapshot(topRef, scopeKey) {
      const entry = current(topRef, scopeKey);
      if (!entry) return null;
      const value = entry.source.snapshot();
      return Object.freeze({topRef, revision: entry.revision, mode: value.mode,
        stopAfterAlbum: value.stopAfterAlbum, unavailable: entry.capture.unavailable_items.length});
    },
    configure(topRef, scopeKey, options) {
      const entry = current(topRef, scopeKey);
      return Boolean(entry && native.configure(entry.queue, options));
    },
    async start({top_ref: topRef, revision}, {scopeKey, mode = 'in_order', stopAfterAlbum = false, signal, isCurrent} = {}) {
      if (!modes.has(mode) || typeof stopAfterAlbum !== 'boolean' || typeof isCurrent !== 'function') throw new TypeError('Invalid Top playback options.');
      const admitted = ++intent;
      const scope = native.captureScope(scopeKey);
      if (!scope || signal?.aborted || isCurrent() !== true || admitted !== intent) throw abort();
      for (const owned of [...retained]) if (owned !== pending && owned.queue && scopeCurrent(owned)) native.describe(owned.queue);
      if (admitted !== intent) throw abort();
      retire(pending);
      if (admitted !== intent) throw abort();
      const entry = {topRef, revision, scopeKey, scope, signal, isCurrent, controller: new AbortController(), retired: false,
        provider: null, queue: null, source: null, unsubscribe: null, cancel: null};
      entry.cancel = () => {if (pending === entry) retire(entry);};
      pending = entry;
      retained.add(entry);
      try {
        entry.provider = createAlbumTopBackendProviders({transport: native.transport,
          acceptsScope: key => key === scopeKey && scopeCurrent(entry)});
        signal?.addEventListener('abort', entry.cancel, {once: true});
        entry.unsubscribe = runtime.subscribe(() => {
          if (scopeCurrent(entry) && entry.queue && pending !== entry) native.describe(entry.queue);
        });
        if (!admissionCurrent(entry)) throw abort();
        const capture = await entry.provider.captureNativeQueue({top_ref: topRef, revision},
          {scopeKey, signal: entry.controller.signal, isCurrent: () => admissionCurrent(entry)});
        if (!admissionCurrent(entry)) throw abort();
        entry.capture = capture;
        if (!capture.albums.length) {retire(entry); return Object.freeze({started: false, unavailable: capture.unavailable_items.length});}
        entry.queue = native.create({capture, isCurrent: () => scopeCurrent(entry), onRetire: () => retire(entry),
          createSource: owned => (entry.source = createTopPlaybackSource({capture, providers: entry.provider, scopeKey, isCurrent: owned, mode, stopAfterAlbum}))});
        if (!admissionCurrent(entry)) throw abort();
        const started = await native.start(entry.queue, {signal: entry.controller.signal});
        if (!started) throw new Error('Top playback could not start.');
        if (!admissionCurrent(entry)) throw abort();
        const previous = active;
        pending = null; active = entry;
        signal?.removeEventListener('abort', entry.cancel);
        if (previous && previous !== entry && !previous.retired) native.describe(previous.queue);
        return Object.freeze({started: true, unavailable: capture.unavailable_items.length});
      } catch (error) {retire(entry); throw error;}
    },
  });
  sessions.set(runtime, api);
  return api;
}
