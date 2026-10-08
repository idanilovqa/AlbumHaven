import {dispatchPlaylistAdd, playlistWriteAcknowledged} from './model.mjs';
import {createPlaylistCreationController, normalizeCreationDescriptor} from './creation.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ref = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const opaque = value => ref(value) && !/[\\/]|^(?:file|https?):/i.test(value) ? value : null;
const grant = (value, key) => own(value, 'allowed_actions') && own(value.allowed_actions, key) && value.allowed_actions[key] === true;
const dense = value => Array.isArray(value) && Array.from(value).every((row, index) => own(value, index) && record(row));
const sameSource = (a, b) => Boolean(a && b && a.kind === b.kind && a.ref === b.ref && a.revision === b.revision);
const failure = error => [401, 403].includes(error?.status) || error?.status === 'denied' ? 'denied'
  : error?.status === 'conflict' ? 'conflict' : error?.status === 'unavailable' ? 'unavailable' : 'error';
const fail = status => {throw Object.assign(new Error('Playlist action unavailable.'), {status});};
const freeze = value => {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
};

// Private native refs remain in this callback boundary. Only counts, status and
// authorized destination display facts leave the controller via getSnapshot().
function resolveSelection(packet, sourceAdapter) {
  const snapshot = sourceAdapter?.snapshot?.();
  if (!snapshot || snapshot.active === false || !ref(packet?.scopeKey) || snapshot.scopeKey !== packet.scopeKey || !snapshot.instance
    || !opaque(packet?.origin?.tableKey) || !['selection', 'section'].includes(packet.origin.target)
    || packet.origin.target === 'section' && !opaque(packet.origin.sectionKey)
    || !dense(snapshot.rows) || !Array.isArray(packet.row_keys) || !packet.row_keys.length
    || Array.from(packet.row_keys).some(key => !opaque(key)) || new Set(packet.row_keys).size !== packet.row_keys.length) fail('unavailable');
  const keys = new Set(packet.row_keys), sourceKeys = new Set();
  for (const row of snapshot.rows) {
    if (!opaque(row.rowKey) || sourceKeys.has(row.rowKey)) fail('unavailable');
    sourceKeys.add(row.rowKey);
  }
  const targets = snapshot.rows.filter(row => keys.has(row.rowKey));
  if (targets.length !== keys.size) fail('unavailable');
  if (targets.some(row => !own(row, 'readable') || row.readable !== true || !own(row, 'selectable') || row.selectable !== true)) fail('denied');
  if (packet.origin.target === 'section' && (targets.some(row => row.sectionKey !== packet.origin.sectionKey)
    || snapshot.rows.filter(row => row.sectionKey === packet.origin.sectionKey).length !== targets.length)) fail('unavailable');
  const resolved = sourceAdapter.resolveRows(targets.map(row => row.rowKey));
  const rows = Array.isArray(resolved) ? resolved : resolved?.rows;
  if (!dense(rows) || rows.length !== targets.length || rows.some((row, index) => row.rowKey !== targets[index].rowKey)) fail('unavailable');
  const byRef = new Map();
  const mapping = rows.map(row => {
    if (row.readable === false || row.selectable === false) fail('denied');
    const track = ref(row.track_ref), canonical = opaque(row.canonical_track_ref), entry = opaque(row.entry_ref);
    if (row.canonical_track_ref != null && !canonical || row.entry_ref != null && !entry || !track && !canonical && !entry) fail('unavailable');
    if (track && canonical && byRef.has(track) && byRef.get(track) !== canonical) fail('unavailable');
    if (track && canonical) byRef.set(track, canonical);
    return {rowKey: row.rowKey, track_ref: track, canonical_track_ref: canonical, entry_ref: entry};
  });
  const seen = new Set(), representatives = [];
  for (const row of mapping) {
    const canonical = row.canonical_track_ref || byRef.get(row.track_ref);
    const key = canonical ? `canonical:${canonical}` : row.track_ref ? `write:${row.track_ref}` : `entry:${row.entry_ref}`;
    if (!seen.has(key)) {seen.add(key); representatives.push({...row, canonical_track_ref: canonical || null});}
  }
  const refs = representatives.map(row => row.track_ref), entries = representatives.map(row => row.entry_ref);
  const source = normalizeCreationDescriptor(resolved?.playlist_creation_source);
  return {instance: snapshot.instance, revision: snapshot.revision, mapping,
    representatives, source, refs, entries,
    canAdd: refs.every(Boolean) && new Set(refs).size === refs.length,
    canSeed: source?.kind === 'library' && entries.every(Boolean) && new Set(entries).size === entries.length,
    counts: {selectedRowCount: targets.length, uniqueTrackCount: representatives.filter(row => row.track_ref || row.canonical_track_ref).length,
      duplicateCount: targets.length - representatives.length,
      ...(representatives.some(row => !row.track_ref && !row.canonical_track_ref)
        ? {unresolvedSourceCount: representatives.filter(row => !row.track_ref && !row.canonical_track_ref).length} : {})}};
}
function sameSelection(left, right) {
  return left.instance === right.instance && left.revision === right.revision
    && JSON.stringify(left.mapping) === JSON.stringify(right.mapping)
    && (left.source === null && right.source === null || sameSource(left.source, right.source));
}
export function normalizePlaylistDestinations(value, scopeKey) {
  if (['denied', 'unavailable', 'error'].includes(value?.status)) return {status: value.status, data: null};
  if (!['ready', 'empty'].includes(value?.status) || value.ok === false || !record(value.data)
    || !ref(scopeKey) || !own(value.data, 'scopeKey') || value.data.scopeKey !== scopeKey || !dense(value.data.destinations)) return {status: 'error', data: null};
  const ids = new Set(), destinations = [];
  for (const row of value.data.destinations) {
    if (!opaque(row.playlist_id) || ids.has(row.playlist_id) || own(row, 'revision') && !opaque(row.revision)) return {status: 'error', data: null};
    ids.add(row.playlist_id);
    destinations.push({playlist_id: row.playlist_id, title: typeof row.title === 'string' ? row.title : '',
      revision: own(row, 'revision') ? row.revision : null, canAdd: grant(row, 'can_add'), canOpen: grant(row, 'can_open')});
  }
  if (value.status === 'empty' && destinations.length) return {status: 'error', data: null};
  return {status: destinations.length ? 'ready' : 'empty', data: {destinations, canCreate: grant(value.data, 'can_create'),
    source: normalizeCreationDescriptor(value.data.playlist_creation_source)}};
}
const initial = () => freeze({status: 'unavailable', counts: null, destinations: [], canCreate: false, canAdd: false,
  selectedId: null, mode: 'destinations', busy: false, writeStarted: false, mutation: {status: 'idle', acknowledged: false, refresh: null}});

export function createPlaylistActionController({packet, lifetime, sourceAdapter, providers = {}} = {}) {
  const configured = {...providers};
  const providerKeys = ['readPlaylistDestinations', 'addTracks', 'readPlaylistCreationSource', 'createPlaylistFromSelection'];
  let state = initial(), disposed = false, retired = false, baseline = null, directory = null,
    pending = null, generation = 0, creation = null, createdAck = null, dispatched = false, listening = false;
  const listeners = new Set(), unsubscriptions = [];
  const publish = patch => {if (!disposed) {state = freeze({...state, ...patch}); for (const listener of [...listeners]) listener();}};
  const retire = () => {
    if (retired || disposed) return;
    retired = true; generation++; pending?.abort(); pending = null; baseline = null; directory = null; createdAck = null; creation?.dispose();
    publish({...initial(), status: 'retired'});
  };
  const current = () => {
    if (disposed || retired) return false;
    try {
      if (providerKeys.some(key => configured[key] !== providers?.[key])) {retire(); return false;}
      if (!lifetime || lifetime.signal?.aborted || lifetime.isCurrent?.() !== true) {retire(); return false;}
      const resolved = resolveSelection(packet, sourceAdapter);
      if (disposed || retired) return false;
      if (!baseline || !sameSelection(baseline, resolved)) {retire(); return false;}
      return true;
    } catch {retire(); return false;}
  };
  const start = () => {pending?.abort(); const request = new AbortController(); pending = request; return {request, version: ++generation};};
  const active = operation => current() && !operation.request.signal.aborted && pending === operation.request && generation === operation.version;
  const read = async signal => {
    if (typeof configured.readPlaylistDestinations !== 'function') return {status: 'unavailable', data: null};
    return normalizePlaylistDestinations(await configured.readPlaylistDestinations({scopeKey: packet.scopeKey, signal}), packet.scopeKey);
  };
  const canCreate = data => Boolean(data?.canCreate && baseline?.canSeed && sameSource(data.source, baseline.source)
    && typeof configured.readPlaylistCreationSource === 'function' && typeof configured.createPlaylistFromSelection === 'function');
  const present = result => {
    directory = result.data;
    publish({status: result.status, destinations: (result.data?.destinations || []).filter(row => row.canAdd),
      canCreate: canCreate(result.data), canAdd: Boolean(baseline?.canAdd && typeof configured.addTracks === 'function'), counts: baseline?.counts || null});
  };
  const listen = () => {
    if (listening || disposed || retired) return;
    listening = true;
    if (typeof lifetime.subscribeInvalidation === 'function') unsubscriptions.push(lifetime.subscribeInvalidation(retire));
    if (typeof sourceAdapter.subscribe === 'function') unsubscriptions.push(sourceAdapter.subscribe(() => current()));
    lifetime.signal?.addEventListener('abort', retire, {once: true});
    unsubscriptions.push(() => lifetime.signal?.removeEventListener('abort', retire));
  };
  const controller = {
    getSnapshot: () => state,
    getCreationController: () => creation,
    isCurrent: current,
    retire,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    async load() {
      if (!current() || state.busy || dispatched || state.mode === 'create') return false;
      listen();
      if (!current()) return false;
      const operation = start(); publish({status: 'loading', destinations: [], selectedId: null, canCreate: false, busy: true});
      try {
        if (!active(operation)) return false;
        const result = await read(operation.request.signal);
        if (!active(operation)) return false;
        present(result); return ['ready', 'empty'].includes(result.status);
      } catch (error) {if (active(operation)) present({status: failure(error), data: null}); return false;}
      finally {if (active(operation)) {pending = null; publish({busy: false});}}
    },
    select(playlistId) {
      if (!current() || state.busy || dispatched || state.mode !== 'destinations'
        || !directory?.destinations.some(row => row.playlist_id === playlistId && row.canAdd)) return false;
      publish({selectedId: playlistId, mutation: {status: 'idle', acknowledged: false, refresh: null}}); return true;
    },
    async add() {
      if (!current() || state.busy || dispatched || state.mode !== 'destinations') return false;
      const target = directory?.destinations.find(row => row.playlist_id === state.selectedId && row.canAdd);
      if (!target) return false;
      if (!baseline.canAdd || typeof configured.addTracks !== 'function') {
        publish({mutation: {status: 'unavailable', acknowledged: false, refresh: null}}); return false;
      }
      const operation = start(); publish({busy: true, mutation: {status: 'loading', acknowledged: false, refresh: null}});
      try {
        if (!active(operation)) return false;
        const fresh = await read(operation.request.signal);
        if (!active(operation)) return false;
        const next = fresh.data?.destinations.find(row => row.playlist_id === target.playlist_id);
        present(fresh);
        if (!active(operation)) return false;
        if (!next?.canAdd || next.revision !== target.revision) {
          publish({selectedId: null, mutation: {status: next?.canAdd ? 'conflict'
            : ['error', 'unavailable'].includes(fresh.status) ? fresh.status : 'denied', acknowledged: false, refresh: null}});
          return false;
        }
        if (!active(operation)) return false;
        dispatched = true;
        publish({writeStarted: true});
        if (!active(operation)) return false;
        const response = await dispatchPlaylistAdd(configured.addTracks, {scopeKey: packet.scopeKey, playlist_id: target.playlist_id,
          track_refs: baseline.refs, signal: operation.request.signal});
        if (!active(operation)) return false;
        if (!playlistWriteAcknowledged(response)) {
          publish({mutation: {status: failure(response), acknowledged: false, refresh: null}}); return false;
        }
        publish({mutation: {status: 'ready', acknowledged: true, refresh: 'loading'}});
        if (!active(operation)) return false;
        // Refresh this picker's authorized destination projection. Destination
        // item detail remains with its own visible owner, never private replay.
        let refresh;
        try {
          const result = await read(operation.request.signal);
          if (!active(operation)) return false;
          present(result); refresh = ['ready', 'empty'].includes(result.status) ? 'ready' : result.status;
        } catch (error) {refresh = failure(error);}
        if (!active(operation)) return false;
        publish({mutation: {status: 'ready', acknowledged: true, refresh}}); return true;
      } catch (error) {
        if (active(operation)) publish({mutation: {status: failure(error), acknowledged: false, refresh: null}});
        return false;
      } finally {if (active(operation)) {pending = null; publish({busy: false});}}
    },
    async openCreate() {
      if (!current() || state.busy || dispatched || creation || !canCreate(directory)) return false;
      const operation = start(); publish({busy: true});
      try {
        if (!active(operation)) return false;
        const fresh = await read(operation.request.signal);
        if (!active(operation)) return false;
        present(fresh);
        if (!canCreate(fresh.data)) return false;
        const context = {scopeKey: packet.scopeKey, mode: 'ordinary', canCreate: true, source: fresh.data.source};
        creation = createPlaylistCreationController({providers: {
          readPlaylistCreationSource: async request => {
            if (!current() || request.signal.aborted) fail('unavailable');
            const result = await configured.readPlaylistCreationSource(request);
            if (!current() || request.signal.aborted) fail('unavailable');
            return result;
          },
          createPlaylistFromSelection: async request => {
            if (!current() || request.signal.aborted) fail('unavailable');
            const latest = await read(request.signal);
            if (!current() || request.signal.aborted) fail('unavailable');
            present(latest);
            if (!current() || request.signal.aborted) fail('unavailable');
            if (!canCreate(latest.data)) fail(latest.status === 'denied' ? 'denied' : 'unavailable');
            if (!sameSource(context.source, latest.data.source)) fail('conflict');
            publish({writeStarted: true});
            if (!current() || request.signal.aborted) fail('unavailable');
            const result = await configured.createPlaylistFromSelection(request);
            if (!current() || request.signal.aborted) fail('unavailable');
            return result;
          },
        }});
        creation.setContext(context);
        if (!await creation.load() || !active(operation)) {
          if (active(operation)) {
            const status = creation.getSnapshot().sourceResource.status;
            publish({mutation: {status: ['denied', 'error', 'conflict'].includes(status) ? status : 'unavailable', acknowledged: false, refresh: null}});
          }
          creation?.dispose(); creation = null; return false;
        }
        const sourceResource = creation.getSnapshot().sourceResource;
        const entries = new Map(sourceResource.data.entries.map(row => [row.entry_ref, row]));
        if (baseline.representatives.some(row => row.canonical_track_ref
          && entries.get(row.entry_ref)?.canonical_track_ref !== row.canonical_track_ref)
          || !creation.seed(baseline.entries, sourceResource)) {
          creation.dispose(); creation = null; publish({canCreate: false, mutation: {status: 'unavailable', acknowledged: false, refresh: null}}); return false;
        }
        publish({mode: 'create'}); return true;
      } catch (error) {
        creation?.dispose(); creation = null;
        if (active(operation)) publish({mutation: {status: failure(error), acknowledged: false, refresh: null}});
        return false;
      } finally {if (active(operation)) {pending = null; publish({busy: false});}}
    },
    acknowledgeCreation(ack) {
      if (!current() || creation?.getSnapshot().mutation.data !== ack || ack.scopeKey !== packet.scopeKey) return false;
      createdAck = ack; creation.dispose(); return true;
    },
    async refreshCreated(ack) {
      if (!current() || createdAck !== ack) return null;
      const operation = start(); publish({busy: true});
      try {
        if (!active(operation)) return null;
        const result = await read(operation.request.signal);
        if (!active(operation)) return null;
        if (!['ready', 'empty'].includes(result.status)) throw new Error('Created playlist refresh failed.');
        present(result);
        return result.data.destinations.find(row => row.playlist_id === ack.playlist_id && row.canOpen) || false;
      } finally {if (active(operation)) {pending = null; publish({busy: false});}}
    },
    canOpenCreated(playlistId) {return current() && Boolean(directory?.destinations.some(row => row.playlist_id === playlistId && row.canOpen));},
    dispose() {
      if (disposed) return;
      pending?.abort(); creation?.dispose(); disposed = true; baseline = null; directory = null; createdAck = null;
      for (const unsubscribe of unsubscriptions) unsubscribe?.();
      listeners.clear(); state = initial();
    },
  };
  try {
    if (!lifetime || lifetime.signal?.aborted || lifetime.isCurrent?.() !== true) fail('unavailable');
    baseline = resolveSelection(packet, sourceAdapter);
    state = freeze({...state, counts: baseline.counts});
  } catch (error) {retired = true; state = freeze({...state, status: failure(error)});}
  return Object.freeze(controller);
}

// Native close can finish asynchronously. The owning session stays alive until
// this continuation settles, so source retirement during return still wins.
export async function completeSelectionPlaylistCreation({controller, ack, close, navigate, notify}) {
  const target = await controller.refreshCreated(ack);
  if (!controller.isCurrent() || target === null) return false;
  if (await close({force: true, restoreFocus: !target}) !== true || !controller.isCurrent()) return false;
  const canNavigate = target && controller.canOpenCreated(ack.playlist_id) && typeof navigate === 'function';
  if (!controller.isCurrent()) return false;
  if (canNavigate) await navigate(ack.playlist_id);
  else notify?.('Playlist created. Opening it is not available yet.');
  return true;
}
