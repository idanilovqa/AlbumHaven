import {createTopQueuePlan} from './queue-plan.mjs';

const sourceFields = ['revision', 'item_ref', 'catalog_ref', 'inventory_album_ref', 'inventory_track_ref', 'canonical_track_ref'];
const abort = () => Object.assign(new Error('Top playback request is no longer current.'), {name: 'AbortError'});
const invalid = () => Object.assign(new Error('Top playback source changed.'), {status: 502});
const text = value => typeof value === 'string' && value.length > 0;
// No enumerable registry: keep retired provenance while each payload is alive.
const bindings = new WeakMap();

// A session consumes only the validated native-queue provider DTO. Captured
// native_target is deliberately never read: every transition needs fresh authority.
export function createTopPlaybackSource({capture, providers, scopeKey, isCurrent, mode = 'in_order', stopAfterAlbum = false}) {
  const {top_ref: topRef, revision, albums} = capture || {};
  if (!text(topRef) || !text(revision) || !Array.isArray(albums)
    || typeof providers?.resolveNativePlayback !== 'function' || !text(scopeKey) || typeof isCurrent !== 'function') {
    throw new TypeError('Invalid Top playback session.');
  }
  const sources = new Map(), popularity = [];
  const blocks = Array.from(albums, album => {
    if (!album || !text(album.album_ref) || !Array.isArray(album.tracks)) throw new TypeError('Invalid Top playback album.');
    return {id: album.item_ref, tracks: Array.from(album.tracks, track => {
      const original = track?.source;
      const source = Object.freeze(Object.fromEntries(sourceFields.map(key => [key, original?.[key]])));
      if (!sourceFields.every(key => text(source[key])) || source.revision !== revision || source.item_ref !== album.item_ref || source.catalog_ref !== album.catalog_ref
        || source.inventory_album_ref !== album.inventory_album_ref) throw new TypeError('Invalid Top playback binding.');
      sources.set(track.queue_item_ref, Object.freeze({source, albumRef: album.album_ref}));
      if (track.popularity != null) {
        const evidence = track.popularity;
        if (evidence.provider !== 'lastfm' || evidence.metric !== 'overall_scrobbles'
          || !Number.isSafeInteger(evidence.count) || evidence.count < 0) throw new TypeError('Invalid Top popularity.');
        popularity.push({id: track.queue_item_ref, count: evidence.count});
      }
      return track.queue_item_ref;
    })};
  });
  const plan = createTopQueuePlan(blocks, {mode, stopAfterAlbum, popularity}), receipts = new WeakMap(), owner = Object.freeze({});
  let retired = false, checking = false, active = null;

  function stop(request) {
    if (!request || request.cancelled) return;
    request.cancelled = true;
    if (active === request) active = null;
    request.signal?.removeEventListener('abort', request.onAbort);
    request.controller.abort();
  }
  function dispose() {retired = true; stop(active);}
  function current() {
    if (checking || retired) {dispose(); return false;}
    checking = true;
    try {if (isCurrent() !== true) dispose();} catch {dispose();} finally {checking = false;}
    return !retired;
  }
  function requestCurrent(request) {
    const owned = () => !retired && !request.cancelled && active === request
      && !request.controller.signal.aborted && !request.signal?.aborted && plan.snapshot() === request.expected;
    if (request.checking || !owned()) {stop(request); return false;}
    request.checking = true;
    try {
      if (!current() || !owned() || request.isCurrent() !== true || !owned()) stop(request);
    } catch {stop(request);} finally {request.checking = false;}
    return owned();
  }
  function requireCurrent(request) {if (!requestCurrent(request)) throw abort();}
  function candidate(request) {
    const snapshot = plan.snapshot();
    return request.direction === 0 && !snapshot.unavailableIds.includes(snapshot.currentId)
      ? snapshot.currentId : plan.candidate({direction: request.direction || 1, automatic: request.automatic});
  }
  // Only the native player's coverPath decoration may alias a private payload.
  // Recognition survives retirement; recognition is never playback permission.
  function matchesPayload(original, value) {
    if (!value || typeof value !== 'object') return false;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
      return keys.length === Object.keys(original).length + (Object.hasOwn(descriptors, 'coverPath') ? 1 : 0)
        && Object.keys(original).every(key => Object.hasOwn(descriptors[key] || {}, 'value') && descriptors[key].value === original[key])
        && (!Object.hasOwn(descriptors, 'coverPath') || typeof descriptors.coverPath.value === 'string');
    } catch {return false;}
  }
  function isReceiptCurrent(receipt, payload = receipt?.payload) {
    const binding = receipts.get(receipt);
    // A live guard may mutate a coverPath alias; finish with data-only validation.
    return !!binding && bindings.get(payload) === binding && requestCurrent(binding.request)
      && matchesPayload(binding.payload, payload) && requestCurrent(binding.request)
      && matchesPayload(binding.payload, payload);
  }
  return Object.freeze({
    snapshot: plan.snapshot,
    candidate: plan.candidate,
    albumFor: plan.albumFor,
    isCurrent: current,
    hasBinding: payload => bindings.get(payload)?.owner === owner,
    aliasBinding(original, clone) {
      const binding = bindings.get(original);
      if (binding?.owner !== owner || !matchesPayload(binding.payload, original) || !matchesPayload(binding.payload, clone)
        || bindings.has(clone) && bindings.get(clone) !== binding) return false;
      bindings.set(clone, binding); return true;
    },
    // The native owner closes continuity and checks its own edit guards first.
    configure(options, expected = plan.snapshot()) {
      if (retired) return false;
      const before = plan.snapshot(), changed = plan.configure(options, expected);
      if (changed && before !== plan.snapshot()) stop(active);
      return changed;
    },
    async prepare({direction = 0, automatic = false, occurrenceId, signal, isCurrent: intentCurrent = () => true} = {}) {
      if (![0, 1, -1].includes(direction) || typeof automatic !== 'boolean' || typeof intentCurrent !== 'function'
        || occurrenceId !== undefined && !text(occurrenceId)
        || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
        throw new TypeError('Invalid Top playback request.');
      }
      const request = {direction, automatic, signal, isCurrent: intentCurrent, expected: plan.snapshot(),
        controller: new AbortController(), checking: false, cancelled: false};
      request.onAbort = () => stop(request);
      request.current = () => requestCurrent(request);
      const previous = active; active = request; stop(previous);
      if (!request.cancelled) signal?.addEventListener('abort', request.onAbort, {once: true});
      try {
        requireCurrent(request);
        let id = candidate(request);
        if (occurrenceId !== undefined && occurrenceId !== id) throw abort();
        while (id !== null) {
          requireCurrent(request);
          const captured = sources.get(id);
          let fresh;
          try {
            fresh = await providers.resolveNativePlayback({top_ref: topRef, source: captured.source},
              {scopeKey, signal: request.controller.signal, isCurrent: request.current});
          } catch (error) {
            requireCurrent(request);
            const unavailable = error?.status === 404 && error?.responseRejected === true && error?.code === 'item_unavailable';
            requireCurrent(request);
            if (!unavailable) throw error;
            if (!plan.reject(id, request.expected)) throw abort();
            request.expected = plan.snapshot();
            requireCurrent(request);
            id = plan.candidate({direction: direction || 1, automatic});
            continue;
          }
          requireCurrent(request);
          if (fresh?.top_ref !== topRef || !sourceFields.every(key => fresh.source?.[key] === captured.source[key])) throw invalid();
          const target = {...fresh.native_target};
          const payload = Object.freeze({sourceKind: 'album-top', src: `/track?path=${encodeURIComponent(target.path)}`,
            path: target.path, title: target.title, artist: target.artist, album: target.album_title,
            durationSeconds: target.duration_seconds, inventory_track_ref: target.inventory_track_ref, albumRef: captured.albumRef});
          requireCurrent(request);
          const receipt = Object.freeze({snapshot: request.expected, occurrenceId: id, payload});
          const binding = Object.freeze({owner, request, payload, occurrenceId: id});
          bindings.set(payload, binding); receipts.set(receipt, binding);
          return receipt;
        }
        stop(request); return null;
      } catch (error) {stop(request); throw error;}
    },
    isReceiptCurrent,
    commit(receipt, acceptedPayload) {
      if (acceptedPayload === undefined || !isReceiptCurrent(receipt, acceptedPayload)) return false;
      const accepted = plan.commit(receipt.occurrenceId, receipt.snapshot);
      if (accepted) stop(receipts.get(receipt).request);
      return accepted;
    },
    cancel() {stop(active);},
    dispose,
  });
}
