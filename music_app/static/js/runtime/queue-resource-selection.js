/* Queue is an independent detail authority. Captured Activity/Playlist contexts
   are refreshed by their source owner, never replayed as a live Home selection. */
(() => {
'use strict';
const freeze = Object.freeze;
const key = value => JSON.stringify(value);
const stale = () => Object.assign(new Error('Queue selection was superseded.'), {name: 'AbortError'});
const denied = () => Object.assign(new Error('Queued resource details are unavailable.'), {status: 403});
const currentReceipt = receipt => {try {return typeof receipt?.isCurrent === 'function' && receipt.isCurrent() === true;} catch {return false;}};
function create({queue, scopeKey, isCurrent} = {}) {
  const api = window.AlbumHavenResourceSelection;
  if (!api || typeof queue?.details !== 'function' || typeof queue?.subscribe !== 'function'
    || typeof queue?.getSnapshot !== 'function' || typeof isCurrent !== 'function'
    || typeof scopeKey !== 'string' || !scopeKey.trim()) throw new TypeError('Queue details require a current source owner.');
  let disposed = false, request = null, sequence = 0;
  let state = freeze({selectedIds: freeze([]), album: null, artist: null, status: 'unavailable'});
  const records = new Map(), listeners = new Set(), mounts = new Set(), transfers = new Set();
  const visible = () => {try {return !disposed && isCurrent() === true;} catch {return false;}};
  const queued = ids => {
    try {
      const counts = new Map();
      for (const row of queue.getSnapshot().entries) counts.set(row.id, (counts.get(row.id) || 0) + 1);
      return ids.every(id => counts.get(id) === 1);
    } catch {return false;}
  };
  const contains = ids => visible() && queued(ids);
  const releaseMounts = kind => {for (const mounted of [...mounts]) if (!kind || mounted.kind === kind) mounted.dispose();};
  function publish(patch) {state = freeze({...state, ...patch}); for (const listener of listeners) listener();}
  function reset(preserveTransfers = false) {
    for (const record of [...records.values(), ...transfers]) {
      if (!preserveTransfers || !transfers.has(record)) record.retired = true;
    }
    if (!preserveTransfers) transfers.clear();
    sequence++; const pending = request; request = null; pending?.abort(); records.clear(); releaseMounts();
    publish({selectedIds: freeze([]), album: null, artist: null, status: 'unavailable'});
  }
  const clear = () => reset();
  function retire(kind) {const record = records.get(kind); if (record) record.retired = true; records.delete(kind); releaseMounts(kind); publish({[kind]: null});}
  function durable(record) {return !!record && !record.retired && queued(record.ids) && record.receipts.every(currentReceipt);}
  function valid(record) {return durable(record) && record.sequence === sequence && visible();}
  function normalize(receipt, kind, origin) {
    const target = api.projectTarget(receipt?.target);
    if (!target || target.kind !== kind || !target.allowed_actions.can_view_details || !currentReceipt(receipt)
      || receipt.data?.kind !== kind || receipt.data.ref !== target.ref) return null;
    return {...receipt, target: api.projectTarget({...target, origin})};
  }
  function consensus(receipts, kind, origin, ids, token) {
    if (!receipts.length || receipts.some(value => !value)) return null;
    const first = receipts[0], identity = first.target.identity_ref || first.target.ref;
    const {native_actions, ...publicTarget} = first.target;
    const nativeRef = kind === 'album' ? 'album_ref' : 'artist_ref';
    const sameNative = native_actions && receipts.every(value => value.target.native_actions?.[nativeRef] === native_actions[nativeRef]
      && (value.subject_ref ?? null) === (first.subject_ref ?? null));
    // Activity identity aliases are snapshot-local. Independently refreshed
    // private native references can prove the same resource across snapshots
    // and source families without exposing those references to React.
    if (!sameNative && !receipts.every(value => (value.target.identity_ref || value.target.ref) === identity)) return null;
    let actions = native_actions;
    if (!actions || !receipts.every(value => value.target.native_actions?.[nativeRef] === actions[nativeRef]
      && (value.subject_ref ?? null) === (first.subject_ref ?? null)
      && (kind !== 'artist' || value.gallery_target?.artist === actions.artist_ref))) actions = null;
    else {
      const names = kind === 'album' ? ['can_open_album', 'can_play_album', 'can_view_artwork', 'can_open_album_page'] : ['can_open_artist_gallery'];
      const grants = {};
      for (const name of names) grants[name] = receipts.every(value => {
        const allowed = value.target.native_actions.allowed_actions;
        return allowed[name] === true || ['can_view_artwork', 'can_open_album_page'].includes(name)
          && !Object.hasOwn(allowed, name) && allowed.can_open_album === true;
      });
      actions = freeze({[nativeRef]: actions[nativeRef], allowed_actions: freeze(grants)});
    }
    const target = freeze({...publicTarget, origin});
    const nativeTarget = freeze({...target, ...(actions ? {native_actions: actions} : {}),
      ...(kind === 'artist' && typeof first.gallery_target?.artist === 'string' ? {gallery_target: freeze({artist: first.gallery_target.artist})} : {})});
    return {sequence: token, ids, receipts, target, nativeTarget};
  }
  async function read(ids, kind, origin, signal, token, retained = null) {
    // A completed source receipt must survive the UI request's later cleanup
    // only when native navigation explicitly retains it. Pending work still
    // follows the caller's abort signal and always rechecks its current owner.
    const pending = new AbortController(), cancel = () => pending.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      if (signal?.aborted) throw stale();
      const receipts = await Promise.all(ids.map(async id => {
        try {return normalize(await queue.details(id, kind, {signal: pending.signal}), kind, origin);}
        catch {return null;}
      }));
      if (pending.signal.aborted || (retained ? !durable(retained) : token !== sequence || !contains(ids))) throw stale();
      return consensus(receipts, kind, origin, ids, token);
    } finally {signal?.removeEventListener('abort', cancel);}
  }
  async function select(ids) {
    clear();
    const origin = api.projectOrigin({source: 'queue', occurrence_refs: ids});
    if (disposed || !origin || !contains(origin.occurrence_refs)) return state;
    const token = sequence, pending = new AbortController(); request = pending;
    publish({selectedIds: origin.occurrence_refs, status: 'loading'});
    const result = await Promise.all(['album', 'artist'].map(async kind => {
      try {return [kind, await read(origin.occurrence_refs, kind, origin, pending.signal, token)];} catch {return [kind, null];}
    }));
    if (disposed || request !== pending || token !== sequence || pending.signal.aborted || !contains(origin.occurrence_refs)) return state;
    request = null;
    for (const [kind, record] of result) if (record && valid(record)) records.set(kind, record);
    publish({album: records.get('album')?.target || null, artist: records.get('artist')?.target || null, status: 'ready'});
    return state;
  }
  function recordFor(selection, context = {}) {
    const target = api.projectTarget(selection), record = records.get(target?.kind);
    return context.scopeKey === scopeKey && !context.signal?.aborted && valid(record)
      && key(target) === key(record.target) && (!context.origin || key(api.projectOrigin(context.origin)) === key(record.target.origin)) ? record : null;
  }
  async function refresh(selection, context) {
    const before = recordFor(selection, context);
    if (!before) throw denied();
    const next = await read(before.ids, selection.kind, before.target.origin, context.signal, before.sequence);
    if (!recordFor(selection, context)) throw stale();
    if (!next || key(next.nativeTarget) !== key(before.nativeTarget)) {retire(selection.kind); throw denied();}
    records.set(selection.kind, next); return next;
  }
  function transferred(selection, context = {}) {
    const target = api.projectTarget(selection);
    return context.scopeKey === scopeKey ? [...transfers].find(record => durable(record)
      && key(record.target) === key(target) && (!context.origin || key(api.projectOrigin(context.origin)) === key(target.origin))) : null;
  }
  const native = api.create({
    sourceResource(selection, context) {return recordFor(selection, context)?.nativeTarget || null;},
    authorizeResource: refresh,
    retainResource(selection, context) {
      const record = recordFor(selection, context);
      if (!record) return null;
      transfers.add(record);
      return {target: record.nativeTarget, isCurrent: () => durable(record)};
    },
    async revalidateResource(selection, context, {signal} = {}) {
      const record = transferred(selection, context);
      if (!record || signal?.aborted) throw denied();
      const fresh = await read(record.ids, selection.kind, record.target.origin, signal, record.sequence, record);
      if (!fresh || !durable(record) || key(fresh.target) !== key(record.target)
        || fresh.nativeTarget.native_actions?.album_ref !== record.nativeTarget.native_actions?.album_ref) {record.retired = true; throw denied();}
      return {target: fresh.nativeTarget, isCurrent: () => !signal?.aborted && durable(record) && durable(fresh)};
    },
    projectAlbum(album, selection, context) {
      const record = recordFor(selection, context) || transferred(selection, context);
      if (!record) throw stale();
      const project = record.receipts[0].projectAlbum;
      return typeof project === 'function' ? project(album) : album;
    },
  });
  const unsubscribe = queue.subscribe(() => {
    if (!queued(state.selectedIds)) {clear(); return;}
    if (!visible()) {reset(true); return;}
    for (const [kind, record] of records) if (!valid(record)) retire(kind);
  });
  return freeze({
    select, clear,
    getSnapshot: () => state,
    subscribe(listener) {if (typeof listener !== 'function') throw new TypeError('Queue details subscription requires a listener.');
      if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener);},
    async readAlbumProjection({kind, ref, origin, signal, scopeKey: requestedScope} = {}) {
      const target = records.get(kind)?.target;
      if (!target || target.ref !== ref) throw denied();
      const record = await refresh(target, {scopeKey: requestedScope, origin, signal});
      const data = record.receipts[0].data, result = {kind, ref, origin: target.origin};
      for (const field of ['title', 'artist', 'year', 'release_type', 'summary', 'source_label', 'metadata_state']) if (typeof data[field] === 'string') result[field] = data[field];
      for (const field of ['duration_seconds', 'track_count', 'release_count']) if (typeof data[field] === 'number' && Number.isFinite(data[field]) && data[field] >= 0) result[field] = data[field];
      // Native Album owns its full hydrated track table. No private source DTO,
      // path, subject taste or action receipt crosses this display boundary.
      return kind === 'album' ? {...result, tracks: null} : {...result, listened_albums: null, discography: null};
    },
    canResourceIntent: native.canResourceIntent,
    resourceIntent: native.resourceIntent,
    mountResourceSelection(host, options = {}) {
      const lease = native.mountResourceSelection(host, options);
      const mounted = {kind: options.selection?.kind, dispose() {mounts.delete(mounted); lease?.dispose();}};
      mounts.add(mounted); return mounted;
    },
    dispose() {if (disposed) return; reset(true); disposed = true; unsubscribe?.(); listeners.clear();},
  });
}
window.AlbumHavenQueueResourceSelection = freeze({create});
})();
