// A volatile, detached edit intent. The existing Top controller owns persistence.
import {albumTopActionAllowed} from './model.mjs';
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const wire = row => ({item_ref: row.item_ref ?? null, album_ref: row.album_ref,
  ...(row.selected_source_ref ? {selected_local_album_id: row.selected_local_album_id, selected_source_ref: row.selected_source_ref} : {})});
const busyMutation = value => value?.refreshing === true || ['loading', 'uncertain'].includes(value?.status);
const ITEM_ACTION = 'library.album_tops.items.manage';

export function createAlbumTopDraft({controller, providers = {}}) {
  const parent = controller.getSnapshot(), source = parent.selectedTopRef ? parent.detail.data : null;
  const editing = Boolean(source), scopeKey = parent.scopeKey, topRef = source?.top_ref || null;
  const bindings = new Map();
  for (const item of source?.edit_draft?.items || []) {
    const ref = item.item_ref;
    if (!bindings.has(ref)) bindings.set(ref, item);
  }
  const initialItems = source?.items?.map(row => ({...copy(row), ...copy(bindings.get(row.item_ref) || {})})) || [];
  const baseline = {title: source?.title || '', description: source?.description || '', items: initialItems.map(wire)};
  let state = {scopeKey, topRef, revision: source?.revision || null, title: baseline.title, description: baseline.description,
    items: copy(initialItems), query: '', tab: editing ? 'selected' : 'all', search: {status: 'idle', items: [], next_cursor: null},
    busy: false, stale: false, denied: false, dirty: false, error: null};
  const listeners = new Set(), requests = new Set(), cursors = new Set();
  let disposed = false, retired = false, sequence = 0, searchAbort = null, working = false, results = [];
  const supported = data => !data || (!Object.hasOwn(data, 'type') || data.type === 'manual')
    && (!Object.hasOwn(data, 'source_locked') || data.source_locked === false);
  const metadataAllowed = current => supported(source) && supported(editing ? current.detail.data : null)
    && albumTopActionAllowed(current, editing ? 'save' : 'create', topRef);
  const membersAllowed = current => metadataAllowed(current) && (!editing || Boolean(source.edit_draft)
    && current.detail.data?.allowed_actions?.[ITEM_ACTION] === true
    && ['add', 'remove', 'reorder'].every(action => albumTopActionAllowed(current, action, topRef)));
  const emit = patch => {
    state = {...state, ...patch};
    state.dirty = state.title !== baseline.title || state.description !== baseline.description || !equal(state.items.map(wire), baseline.items);
    for (const fn of [...listeners]) fn();
  };
  const abortAll = () => {sequence++; for (const request of requests) request.abort(); requests.clear();};
  let memberAuthority = membersAllowed(parent);
  function refresh() {
    if (disposed || retired) return false;
    const current = controller.getSnapshot();
    if (current.scopeKey !== scopeKey || (current.selectedTopRef || null) !== topRef
      || current.directory.status === 'denied' || current.detail.status === 'denied') {
      retired = true; abortAll(); results = []; emit({denied: true, busy: false, search: {status: 'denied', items: [], next_cursor: null}}); return false;
    }
    const stale = editing && current.detail.data?.revision !== state.revision;
    const denied = !metadataAllowed(current) && ['ready', 'empty'].includes(editing ? current.detail.status : current.directory.status);
    const busy = working || busyMutation(current.mutation);
    const canManageMembers = membersAllowed(current);
    if (memberAuthority && !canManageMembers) {
      sequence++; searchAbort?.abort(); results = []; cursors.clear();
      emit({search: {status: 'unavailable', items: [], next_cursor: null}});
    }
    memberAuthority = canManageMembers;
    if (stale && !state.stale || denied && !state.denied) abortAll();
    if (state.stale !== Boolean(stale) || state.denied !== denied || state.busy !== busy) emit({stale: Boolean(stale), denied, busy});
    return !state.stale && !state.denied && metadataAllowed(current);
  }
  const allowed = (membership = false) => refresh() && !state.busy && (!membership || membersAllowed(controller.getSnapshot()));
  const options = abort => ({scopeKey, signal: abort.signal, ...(topRef ? {topRef} : {})});
  const begin = () => {const abort = new AbortController(); requests.add(abort); return abort;};
  const excluded = () => new Set([...baseline.items, ...state.items].map(row => row.album_ref));
  const visible = () => {const omit = excluded(); return results.filter(row => !row.album_ref || !omit.has(row.album_ref));};
  const deny = error => {
    if ([401, 403].includes(error?.status)) {controller.observeDenial?.(scopeKey, error); retired = true; abortAll(); emit({denied: true, error, search: {status: 'denied', items: [], next_cursor: null}});}
    else emit({error});
  };
  async function search(query, cursor = null) {
    if (!allowed(true)) return false;
    searchAbort?.abort();
    const version = ++sequence, abort = begin(); searchAbort = abort;
    emit({search: {...state.search, status: 'loading'}, error: null});
    try {
      if (typeof providers.searchAlbums !== 'function') {emit({search: {status: 'unavailable', items: [], next_cursor: null}}); return false;}
      const page = await providers.searchAlbums({...options(abort), q: query, ...(cursor ? {cursor} : {})});
      if (disposed || retired || abort.signal.aborted || version !== sequence || !refresh()
        || !membersAllowed(controller.getSnapshot())) return false;
      if (page.next_cursor && (page.next_cursor === cursor || cursors.has(page.next_cursor))) throw new Error('Album search did not advance. Start the search again.');
      if (cursor) cursors.add(cursor);
      const seen = new Set(cursor ? results.map(row => row.local_album_id) : []);
      results = [...(cursor ? results : []), ...page.albums.filter(row => {if (seen.has(row.local_album_id)) return false; seen.add(row.local_album_id); return true;})].map(copy);
      emit({search: {status: 'ready', items: visible(), next_cursor: page.next_cursor}}); return true;
    } catch (error) {
      if (!disposed && !retired && !abort.signal.aborted && version === sequence) {
        if ([401, 403].includes(error?.status)) deny(error);
        else emit({search: {...state.search, status: 'error'}, error});
      }
      return false;
    } finally {requests.delete(abort);}
  }
  const unsubscribe = controller.subscribe?.(refresh) || (() => {});
  refresh();
  return {
    getSnapshot: () => state,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, refresh,
    canEdit: () => allowed(), canEditMembership: () => allowed(true),
    edit(patch) {
      if (!allowed()) return false;
      const changes = {};
      for (const [key, maximum] of [['title', 100], ['description', 200]]) {
        if (Object.hasOwn(patch, key)) {if (typeof patch[key] !== 'string' || patch[key].length > maximum || patch[key].includes('\0')) return false; changes[key] = patch[key];}
      }
      emit({...changes, error: null}); return true;
    },
    async setQuery(value) {
      if (!allowed(true) || typeof value !== 'string' || value.length > 100) return false;
      emit({query: value, search: {status: 'idle', items: [], next_cursor: null}}); cursors.clear(); results = [];
      if (!value.trim()) {searchAbort?.abort(); sequence++; emit({search: {status: 'idle', items: [], next_cursor: null}}); return true;}
      return search(value.trim());
    },
    setTab(tab) {if (!disposed && !retired && ['all', 'selected'].includes(tab)) emit({tab});},
    loadMore() {return state.query.trim() && state.search.next_cursor && state.search.status !== 'loading' ? search(state.query.trim(), state.search.next_cursor) : Promise.resolve(false);},
    async select(row) {
      if (!allowed(true) || typeof providers.admitAlbum !== 'function' || !results.some(item => item.local_album_id === row.local_album_id)
        || !Number.isSafeInteger(row.local_album_id) || row.local_album_id < 1 || state.items.length >= 5000) return false;
      const candidate = results.find(item => item.local_album_id === row.local_album_id), abort = begin();
      working = true; emit({busy: true, error: null});
      try {
        const admitted = await providers.admitAlbum(candidate.local_album_id, options(abort));
        if (disposed || retired || abort.signal.aborted || !refresh() || !membersAllowed(controller.getSnapshot())) return false;
        results = results.map(item => item.local_album_id === candidate.local_album_id ? {...item, album_ref: admitted.album_ref} : item);
        if (!excluded().has(admitted.album_ref)) emit({items: [...state.items, {...copy(candidate), album_ref: admitted.album_ref, item_ref: null}]});
        emit({search: {...state.search, items: visible()}}); return true;
      } catch (error) {if (!disposed && !retired && !abort.signal.aborted) deny(error); return false;}
      finally {requests.delete(abort); working = false; if (!disposed && !retired) refresh();}
    },
    remove(albumRef) {
      if (!allowed(true)) return false;
      emit({items: state.items.filter(row => row.album_ref !== albumRef), error: null}); emit({search: {...state.search, items: visible()}}); return true;
    },
    reorder(refs) {
      if (!allowed(true) || !Array.isArray(refs) || refs.length !== state.items.length || new Set(refs).size !== refs.length) return false;
      const byRef = new Map(state.items.map(row => [row.album_ref, row]));
      const items = Array.from(refs, ref => byRef.get(ref));
      if (items.some(row => !row)) return false;
      emit({items, error: null}); return true;
    },
    async submit() {
      if (!allowed() || !state.title.trim() || editing && !state.dirty) return false;
      const items = state.items.map(wire), membershipChanged = !equal(items, baseline.items);
      if (membershipChanged && !membersAllowed(controller.getSnapshot())) return false;
      const payload = {title: state.title, description: state.description,
        ...(editing ? membershipChanged ? {items} : {} : {album_refs: state.items.map(row => row.album_ref)})};
      const abort = begin(); working = true; emit({busy: true, error: null});
      try {
        if (editing && source.edit_draft?.publication_preview_required) {
          if (typeof providers.preview !== 'function' || items.some(row => !row.selected_source_ref)) {
            throw new Error('This published Top needs an explicitly selected metadata source for every album. Remove the newly added albums to save these edits; publication source selection is not available here yet. Your draft is preserved.');
          }
          const preview = await providers.preview(topRef, {revision: state.revision, items: copy(items)}, options(abort));
          if (disposed || retired || abort.signal.aborted || !refresh()) return false;
          payload.evidence_revision = preview.evidence_revision;
        }
        if (disposed || retired || abort.signal.aborted || !refresh()
          || membershipChanged && !membersAllowed(controller.getSnapshot())) return false;
        return await controller.mutate(editing ? 'save' : 'create', payload);
      } catch (error) {if (!disposed && !retired && !abort.signal.aborted) deny(error); return false;}
      finally {requests.delete(abort); working = false; if (!disposed && !retired) refresh();}
    },
    dispose() {if (disposed) return; disposed = true; abortAll(); unsubscribe(); listeners.clear();},
  };
}
