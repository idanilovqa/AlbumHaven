// Persistent Top-mount adapter for the existing bounded native source-page owner.
// There is no parallel history registry and no retained Gallery DOM callback.
const stale = () => Object.assign(new Error('Album Top source was superseded.'), {name: 'AbortError'});
const denied = () => Object.assign(new Error('This Album is unavailable from its original Top.'), {status: 403});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function createAlbumTopSourceReplay({runtime, providers}) {
  let disposed = false, epoch = 0, ui = null, currentBinding = null;
  function project(selection, context) {
    const target = runtime.projectResourceTarget(selection), origin = runtime.projectResourceOrigin(context?.origin ?? target?.origin);
    if (typeof context?.scopeKey !== 'string' || !context.scopeKey || !target || target.kind !== 'album' || !origin || origin.source !== 'album_top'
      || !same(target.origin, origin) || target.allowed_actions.can_view_details !== true
      || target.native_actions?.allowed_actions?.can_open_album !== true
      || target.native_actions.allowed_actions.can_play_album !== false) return null;
    return {target, origin, scopeKey: context?.scopeKey};
  }
  function guard(scopeKey, version, signal) {
    let retired = false;
    return () => {
      if (retired || disposed || version !== epoch || signal?.aborted) {retired = true; return false;}
      const shell = runtime.snapshot();
      const valid = !disposed && version === epoch && !signal?.aborted && shell.authenticated && shell.inLibrary && shell.scopeKey === scopeKey;
      if (!valid) retired = true;
      return valid;
    };
  }
  function retain(selection, context, binding) {
    const value = project(selection, context);
    if (!value || context.signal?.aborted || !binding || binding.top_ref !== value.origin.top_ref
      || binding.revision !== value.origin.revision || binding.item_ref !== value.origin.item_ref
      || binding.album_ref !== value.target.ref || typeof binding.inventory_album_ref !== 'string') return null;
    const version = epoch, isCurrent = guard(value.scopeKey, version);
    if (!isCurrent()) return null;
    currentBinding = {version, source: Object.freeze({...binding})};
    return Object.freeze({target: value.target, isCurrent});
  }
  async function revalidate(selection, context, {signal} = {}) {
    const value = project(selection, context);
    if (!value) throw denied();
    const expected = {top_ref: value.origin.top_ref, revision: value.origin.revision,
      item_ref: value.origin.item_ref, album_ref: value.target.ref};
    const previous = currentBinding?.source;
    if (previous && Object.keys(expected).every(key => previous[key] === expected[key])) expected.inventory_album_ref = previous.inventory_album_ref;
    const version = ++epoch, isCurrent = guard(value.scopeKey, version, signal);
    currentBinding = {version, source: Object.freeze(expected)};
    if (!isCurrent()) throw stale();
    const detail = await providers.read(value.origin.top_ref, {scopeKey: value.scopeKey, signal});
    if (!isCurrent()) throw stale();
    if (detail.top_ref !== value.origin.top_ref || detail.revision !== value.origin.revision
      || detail.allowed_actions?.['library.browse.read'] !== true || detail.allowed_actions?.can_read !== true) throw denied();
    const members = detail.items.filter(row => row.item_ref === value.origin.item_ref && row.album_ref === value.target.ref);
    if (members.length !== 1) throw denied();
    const row = members[0];
    if (row.source_kind === 'remote_summary' || row.native_album?.allowed_actions?.can_view_details !== true) throw denied();
    const binding = Object.freeze({top_ref: detail.top_ref, revision: detail.revision,
      item_ref: row.item_ref, album_ref: row.album_ref, inventory_album_ref: row.native_album.inventory_album_ref});
    currentBinding = {version, source: binding};
    const resolved = await providers.resolveNativeAlbum(binding,
    {scopeKey: value.scopeKey, signal, isCurrent});
    if (!isCurrent()) throw stale();
    if (resolved.native_target.album_ref !== value.target.native_actions.album_ref) throw denied();
    const target = runtime.projectResourceTarget({kind: 'album', ref: row.album_ref, origin: value.origin,
      allowed_actions: {can_view_details: true}, native_actions: {album_ref: resolved.native_target.album_ref,
        allowed_actions: {can_open_album: true, can_play_album: false}}});
    if (!target || !isCurrent()) throw stale();
    currentBinding = {version, source: binding};
    return Object.freeze({target, isCurrent});
  }
  const native = runtime.createResourceSelection({
    sourceResource(target, context) {
      const captured = ui, value = !disposed ? captured?.sourceResource(target, context) : null;
      return !disposed && ui === captured ? value || null : null;
    },
    async authorizeResource(target, context, intent) {
      const captured = ui;
      if (disposed || !captured) throw stale();
      await captured.authorizeResource(target, context, intent);
      if (disposed || ui !== captured) throw stale();
    },
    retainResource(target, context) {
      const captured = ui, source = captured?.sourceResource(target, context);
      if (disposed || !captured || ui !== captured || !source) return null;
      const binding = captured.readSourceBinding(target, context);
      if (disposed || ui !== captured) return null;
      const receipt = retain(source, context, binding);
      return !disposed && ui === captured ? receipt : null;
    },
    revalidateResource: revalidate,
  });
  return {
    createSelection({sourceResource, authorizeResource, readSourceBinding}) {
      if (disposed) throw stale();
      if (![sourceResource, authorizeResource, readSourceBinding].every(value => typeof value === 'function')) throw new TypeError('A current Top source lease is required.');
      const lease = {sourceResource, authorizeResource, readSourceBinding}; ui = lease;
      native.invalidateResourceSelections();
      return {
        beginIntent() {
          if (disposed || ui !== lease) throw stale();
          const version = ++epoch; currentBinding = null;
          return () => !disposed && ui === lease && epoch === version;
        },
        resourceIntent(...args) {if (disposed || ui !== lease) return Promise.reject(stale()); return native.resourceIntent(...args);},
        invalidateResourceSelections() {if (ui === lease) native.invalidateResourceSelections();},
        dispose() {if (ui === lease) {ui = null; native.invalidateResourceSelections();}},
      };
    },
    observeDetail(detail) {
      const binding = currentBinding?.version === epoch ? currentBinding.source : null;
      if (!binding || detail?.top_ref !== binding.top_ref) return;
      const members = detail.items.filter(row => row.item_ref === binding.item_ref && row.album_ref === binding.album_ref);
      if (detail.allowed_actions?.['library.browse.read'] !== true || detail.allowed_actions?.can_read !== true
        || detail.revision !== binding.revision || members.length !== 1 || members[0].source_kind === 'remote_summary'
        || members[0].native_album?.allowed_actions?.can_view_details !== true
        || binding.inventory_album_ref !== undefined && members[0].native_album?.inventory_album_ref !== binding.inventory_album_ref) {epoch++; currentBinding = null;}
    },
    invalidate() {epoch++; currentBinding = null;},
    dispose() {if (!disposed) {disposed = true; epoch++; ui = null; currentBinding = null; native.invalidateResourceSelections();}},
  };
}
