// Saved Top details use the shared native selection owner. Browse hints are not authority.
const stale = () => Object.assign(new Error('Album Top details were superseded.'), {name: 'AbortError'});
export function createAlbumTopDetails({runtime, controller, readOwner, onError, sourceReplay}) {
  let disposed = false, active = null;
  function current(record) {
    if (record.retired || disposed || active !== record || record.abort.signal.aborted || record.intentCurrent && !record.intentCurrent() || readOwner() !== record.owner) {record.retired = true; return false;}
    const state = controller.getSnapshot(), shell = runtime.snapshot();
    const valid = !disposed && active === record && !record.abort.signal.aborted && readOwner() === record.owner
      && state.scopeKey === record.owner.scopeKey && state.directory?.status !== 'denied'
      && state.detail.status === 'ready' && state.detail.refreshing !== true
      && state.detail.data === record.owner.detail && state.selectedTopRef === record.owner.detail.top_ref
      && record.owner.detail.top_ref === record.source.top_ref && record.owner.detail.revision === record.source.revision
      && record.owner.detail.items.includes(record.row) && record.row.item_ref === record.source.item_ref
      && record.row.album_ref === record.source.album_ref && record.row.source_kind !== 'remote_summary'
      && record.row.native_album?.inventory_album_ref === record.source.inventory_album_ref
      && record.row.native_album?.allowed_actions?.can_view_details === true
      && state.mutation.refreshing !== true && !['loading', 'uncertain'].includes(state.mutation.status)
      && shell.authenticated && shell.visible && shell.scopeKey === record.owner.scopeKey
      && shell.topRef === record.owner.detail.top_ref && shell.viewVersion === record.viewVersion
      && shell.viewRequestId === record.viewRequestId && (!record.intentCurrent || record.intentCurrent());
    if (!valid) record.retired = true;
    return valid;
  }
  function matches(record, selection, context) {
    return current(record) && selection?.kind === 'album' && selection.ref === record.row.album_ref
      && context?.scopeKey === record.owner.scopeKey
      && JSON.stringify(context.origin) === JSON.stringify(record.origin)
      && (!selection.origin || JSON.stringify(selection.origin) === JSON.stringify(record.origin));
  }
  async function resolve(record, signal = record.abort.signal) {
    if (!current(record) || signal?.aborted) throw stale();
    const value = await record.owner.providers.resolveNativeAlbum(record.source,
    {scopeKey: record.owner.scopeKey, signal, isCurrent: () => current(record) && !signal?.aborted});
    if (!current(record) || signal?.aborted) throw stale();
    return {kind: 'album', ref: record.row.album_ref, origin: record.origin, allowed_actions: {can_view_details: true},
      native_actions: {album_ref: value.native_target.album_ref, allowed_actions: {can_open_album: true, can_play_album: false}}};
  }
  const callbacks = {
    sourceResource(target, context) {return active?.target && matches(active, target, context) ? active.target : null;},
    async authorizeResource(target, context) {
      const record = active;
      if (!record || !matches(record, target, context)) throw stale();
      const fresh = await resolve(record, context.signal);
      if (JSON.stringify(fresh) !== JSON.stringify(record.target)) {record.retired = true; throw stale();}
    },
    async revalidateResource(target, context, {signal} = {}) {
      const record = active;
      if (!record || !matches(record, target, context)) throw stale();
      const fresh = await resolve(record, signal);
      if (JSON.stringify(fresh) !== JSON.stringify(record.target)) {record.retired = true; throw stale();}
      return {target: fresh, isCurrent: () => current(record) && !signal?.aborted};
    },
  };
  const selection = sourceReplay ? sourceReplay.createSelection({...callbacks,
    readSourceBinding(target, context) {return active && matches(active, target, context) ? active.source : null;},
  }) : runtime.createResourceSelection(callbacks);
  function retire() {const old = active; active = null; old?.abort.abort(); selection.invalidateResourceSelections();}
  return {
    async open(row) {
      retire();
      const owner = readOwner(), shell = runtime.snapshot();
      if (disposed || !owner || !owner.detail.items.includes(row) || row.source_kind === 'remote_summary'
        || row.native_album?.allowed_actions?.can_view_details !== true) return false;
      const record = {owner, row, abort: new AbortController(), viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId,
        source: Object.freeze({top_ref: owner.detail.top_ref, revision: owner.detail.revision, item_ref: row.item_ref,
          album_ref: row.album_ref, inventory_album_ref: row.native_album.inventory_album_ref}),
        origin: Object.freeze({source: 'album_top', top_ref: owner.detail.top_ref, item_ref: row.item_ref, revision: owner.detail.revision})};
      active = record;
      try {
        if (!current(record)) throw stale();
        record.intentCurrent = selection.beginIntent?.();
        record.target = await resolve(record);
        if (!current(record)) throw stale();
        await selection.resourceIntent('open', record.target, {scopeKey: owner.scopeKey, origin: record.origin, signal: record.abort.signal});
        if (!current(record)) throw stale();
        return true;
      } catch (error) {if (current(record) && error?.name !== 'AbortError') onError?.(error); return false;}
    },
    retire,
    dispose() {if (!disposed) {disposed = true; retire(); selection.dispose?.();}},
  };
}
