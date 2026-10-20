// A volatile, detached edit intent. The existing Top controller owns persistence.
import {albumTopActionAllowed} from './model.mjs';
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const localWire = row => ({item_ref: row.item_ref ?? null, album_ref: row.album_ref,
  ...(row.selected_source_ref ? {selected_local_album_id: row.selected_local_album_id, selected_source_ref: row.selected_source_ref} : {})});
const rowKey = row => row.album_ref || row.selection_key;
const isRemote = row => row.source_kind === 'remote_summary' || row.source?.kind?.startsWith('remote_');
const typedWire = row => ({kind: row.item_ref ? 'existing' : isRemote(row) ? 'new_remote' : 'new_local',
  ...(row.item_ref ? {item_ref: row.item_ref} : {}), ...(row.album_ref ? {album_ref: row.album_ref} : {}),
  source: row.source ? copy(row.source) : row.selected_source_ref ? {kind: 'local', selected_local_album_id: row.selected_local_album_id, selected_source_ref: row.selected_source_ref} : {kind: 'unselected'}});
const wire = row => isRemote(row) ? typedWire(row) : localWire(row);
const remoteError = code => Object.assign(new Error('Album Top remote preparation is unavailable.'), {code, status: 409});
const newRef = () => {const value = globalThis.crypto?.randomUUID?.(); if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw remoteError('remote_context_changed'); return value;};
const busyMutation = value => value?.refreshing === true || ['loading', 'uncertain'].includes(value?.status);
const ITEM_ACTION = 'library.album_tops.items.manage';

// Add follows its own server projection; metadata/remove/reorder are independent.
export function albumTopAddAllowed(state) {
  const source = state?.detail?.data;
  return Boolean(source) && (!Object.hasOwn(source, 'type') || source.type === 'manual')
    && (!Object.hasOwn(source, 'source_locked') || source.source_locked === false)
    && albumTopActionAllowed(state, 'add');
}

export function createAlbumTopDraft({controller, providers = {}, mode = 'edit', sourceJobRef}) {
  const parent = controller.getSnapshot(), sourceMatch = mode === 'source-match';
  if (sourceMatch && (parent.selectedTopRef || typeof sourceJobRef !== 'string' || sourceJobRef.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sourceJobRef)
    || sourceJobRef === '00000000-0000-0000-0000-000000000000')) throw new TypeError('Source matching requires a current create scope and canonical source job.');
  const source = parent.selectedTopRef ? parent.detail.data : null;
  const adding = mode === 'add', editing = Boolean(source), scopeKey = parent.scopeKey, topRef = source?.top_ref || null;
  const bindings = new Map();
  for (const item of source?.edit_draft?.item_selections || source?.edit_draft?.items || []) {
    const ref = item.item_ref;
    if (!bindings.has(ref)) bindings.set(ref, item);
  }
  const initialItems = source?.items?.map(row => {const binding = copy(bindings.get(row.item_ref) || {}); return {...copy(row), ...binding, ...(binding.source?.kind === 'local' ? {selected_local_album_id: binding.source.selected_local_album_id, selected_source_ref: binding.source.selected_source_ref} : {})};}) || [];
  const baseline = {title: source?.title || '', description: source?.description || '', items: initialItems.map(wire)};
  let state = {scopeKey, topRef, sourceMatch, ...(sourceMatch ? {capacity: 1} : {}), revision: source?.revision || null, title: baseline.title, description: baseline.description,
    items: adding ? [] : copy(initialItems), ...(adding ? {capacity: Math.max(0, 5000 - initialItems.length), submittedRequestKey: null} : {}), query: '', tab: editing && !adding ? 'selected' : 'all', search: {status: 'idle', items: [], next_cursor: null},
    busy: false, stale: false, denied: false, dirty: false, error: null, pool: 'local', formRef: sourceMatch ? sourceJobRef : null,
    remote: {status: 'idle', title: '', artist: '', search: {status: 'idle', candidates: []}, preparation: null, operation: null, ownState: null, maintenance: null, retired: false, membershipRetired: false}};
  const listeners = new Set(), requests = new Set(), cursors = new Set();
  let disposed = false, retired = false, sequence = 0, searchAbort = null, working = false, results = [];
  let remoteActive = initialItems.some(isRemote), remoteRetired = false, remoteMembershipRetired = false, remoteOperation = null, remoteSearchVersion = 0, remoteSearchAbort = null;
  let remoteIdentity = null, formRef = sourceMatch ? sourceJobRef : null;
  const remoteContextMethod = providers.remoteContext, ownedParents = new Set(), unavailableParents = new Set();
  try {if (typeof remoteContextMethod === 'function') remoteIdentity = remoteContextMethod.call(providers);} catch { /* Remote entry stays unavailable; local draft is unaffected. */ }
  const supported = data => !data || (!Object.hasOwn(data, 'type') || data.type === 'manual')
    && (!Object.hasOwn(data, 'source_locked') || data.source_locked === false);
  const metadataAllowed = current => supported(source) && supported(editing ? current.detail.data : null)
    && (adding ? editing && albumTopAddAllowed(current) : albumTopActionAllowed(current, editing ? 'save' : 'create', topRef));
  const membersAllowed = current => metadataAllowed(current) && (adding || !editing || Boolean(source.edit_draft)
    && current.detail.data?.allowed_actions?.[ITEM_ACTION] === true
    && ['add', 'remove', 'reorder'].every(action => albumTopActionAllowed(current, action, topRef)));
  const emit = patch => {
    state = {...state, ...patch};
    state.dirty = adding ? state.items.length > 0 : state.title !== baseline.title || state.description !== baseline.description || !equal(state.items.map(wire), baseline.items);
    for (const fn of [...listeners]) fn();
  };
  const abortAll = () => {sequence++; for (const request of requests) request.abort(); requests.clear();};
  let memberAuthority = membersAllowed(parent);
  function refresh() {
    if (disposed || retired && !adding) return false;
    if (remoteActive && !remoteScoped()) retireRemote();
    const current = controller.getSnapshot();
    if (current.scopeKey !== scopeKey || (current.selectedTopRef || null) !== topRef
      || current.directory.status === 'denied' || current.detail.status === 'denied') {
      if (retired && state.denied) return false;
      retired = true; abortAll(); results = []; emit({denied: true, busy: false, ...(adding ? {title: '', description: '', items: [], query: '', submittedRequestKey: null} : {}), search: {status: 'denied', items: [], next_cursor: null}}); return false;
    }
    if (retired) return false;
    if (adding && state.submittedRequestKey && current.mutation.command?.request_key === state.submittedRequestKey
      && ['error', 'denied'].includes(current.mutation.status)) emit({submittedRequestKey: null});
    const stale = editing && current.detail.data?.revision !== state.revision;
    const denied = !metadataAllowed(current) && ['ready', 'empty'].includes(editing ? current.detail.status : current.directory.status);
    const busy = working || Boolean(remoteOperation) || busyMutation(current.mutation);
    // Add is a captured destination revision, not a reusable authoring session.
    // Once authority/revision is lost, an ABA restoration cannot revive it.
    if (adding && (stale || denied)) {
      retired = true; abortAll(); results = []; cursors.clear();
      emit({stale: Boolean(stale), denied, busy: false, query: '', ...(denied ? {title: '', description: '', items: [], submittedRequestKey: null} : {}),
        search: {status: denied ? 'denied' : 'unavailable', items: [], next_cursor: null}}); return false;
    }
    const canManageMembers = membersAllowed(current), lostMemberAuthority = memberAuthority && !canManageMembers;
    memberAuthority = canManageMembers; // Capture before notifications can reenter refresh.
    if (remoteActive && !canManageMembers && !remoteMembershipRetired) {
      remoteMembershipRetired = true; remoteSearchVersion++; remoteSearchAbort?.abort();
      if (remoteOperation && ['begin', 'acquire'].includes(remoteOperation.kind)) {
        const previous = remoteOperation; remoteOperation = null; previous.abort?.abort();
      }
      emit({remote: {...state.remote, membershipRetired: true, operation: remoteOperation ? state.remote.operation : null,
        search: {status: 'unavailable', candidates: []}}});
    }
    if (lostMemberAuthority) {
      sequence++; searchAbort?.abort(); results = []; cursors.clear();
      emit({search: {status: 'unavailable', items: [], next_cursor: null}});
    }
    if (stale && !state.stale || denied && !state.denied) abortAll();
    if (state.stale !== Boolean(stale) || state.denied !== denied || state.busy !== busy) emit({stale: Boolean(stale), denied, busy});
    return !remoteRetired && !state.stale && !state.denied && metadataAllowed(current);
  }
  const allowed = (membership = false) => refresh() && !state.busy && (!membership || !remoteMembershipRetired && membersAllowed(controller.getSnapshot()));
  const options = abort => ({scopeKey, signal: abort.signal, ...(topRef ? {topRef} : {})});
  const begin = () => {const abort = new AbortController(); requests.add(abort); return abort;};
  const excluded = () => new Set([...baseline.items, ...state.items].map(row => row.album_ref));
  const visible = () => {const omit = excluded(); return results.filter(row => !row.album_ref || !omit.has(row.album_ref));};
  const deny = error => {
    if ([401, 403].includes(error?.status)) {controller.observeDenial?.(scopeKey, error); retired = true; abortAll(); if (adding) results = []; emit({denied: true, error, ...(adding ? {busy: false, title: '', description: '', items: [], query: '', submittedRequestKey: null} : {}), search: {status: 'denied', items: [], next_cursor: null}});}
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
  function remoteScoped() {
    if (disposed || retired || remoteRetired || !remoteIdentity || providers.remoteContext !== remoteContextMethod) return false;
    const current = controller.getSnapshot();
    if (current.scopeKey !== scopeKey || (current.selectedTopRef || null) !== topRef
      || current.directory.status === 'denied' || current.detail.status === 'denied'
      || editing && (current.detail.data !== source || source.revision !== state.revision) || !metadataAllowed(current)) return false;
    try {
      const identity = remoteContextMethod.call(providers), after = controller.getSnapshot();
      return identity === remoteIdentity && after === current && !disposed && !retired && !remoteRetired
        && after.scopeKey === scopeKey && (after.selectedTopRef || null) === topRef && metadataAllowed(after)
        && (!editing || after.detail.data === source && source.revision === state.revision)
        && after.directory.status !== 'denied' && after.detail.status !== 'denied';
    } catch {return false;}
  }
  function retireRemote() {
    if (remoteRetired) return;
    remoteRetired = true; remoteMembershipRetired = true; remoteSearchVersion++;
    remoteSearchAbort?.abort(); abortAll();
    emit({remote: {...state.remote, retired: true, membershipRetired: true, status: 'unavailable', search: {status: 'unavailable', candidates: []}}, busy: false});
  }
  function remoteOptions(abort, membership = false) {
    return {...options(abort), remoteContext: remoteIdentity, isCurrent: () => remoteScoped()
      && (!membership || !remoteMembershipRetired && membersAllowed(controller.getSnapshot()))};
  }
  function activateRemote(membership = true) {
    remoteActive = true;
    if (!remoteScoped()) {retireRemote(); return false;}
    if (membership && (!membersAllowed(controller.getSnapshot()) || remoteMembershipRetired)) {
      remoteMembershipRetired = true; emit({remote: {...state.remote, membershipRetired: true}}); return false;
    }
    return true;
  }
  function remoteDestination() {
    if (!formRef) {formRef = newRef(); emit({formRef});}
    return topRef ? {kind: 'top', top_ref: topRef, revision: state.revision} : {kind: 'create', draft_ref: formRef};
  }
  function remotePatch(patch, extra = {}) {emit({...extra, remote: {...state.remote, ...patch, retired: remoteRetired, membershipRetired: remoteMembershipRetired}});}
  function invalidateParent(ref) {
    unavailableParents.add(ref); ownedParents.delete(ref);
    remotePatch({preparation: state.remote.preparation?.preparation_ref === ref ? null : state.remote.preparation});
  }
  function currentRemoteDenial(error) {
    // Request sequence/physical abort is not a grant to ignore a consumed denial
    // within this same form and actor. Navigation/context replacement is.
    if (![401, 403].includes(error?.status) || disposed || retired || remoteRetired) return false;
    const current = controller.getSnapshot();
    if (current.scopeKey !== scopeKey || (current.selectedTopRef || null) !== topRef || editing && current.detail.data !== source) return false;
    // Real transport denies before invalidating its generation. It has already
    // checked old-session isolation; fake/ordinary denials need live context.
    if (providers.remoteContext !== remoteContextMethod) return false;
    try {if (remoteContextMethod.call(providers) !== remoteIdentity) return false;} catch { /* The consumed denial may have retired this exact context. */ }
    if (error.responseRejected !== true && !remoteScoped()) return false;
    remoteRetired = true; remoteMembershipRetired = true; remoteOperation = null;
    controller.observeDenial?.(scopeKey, error); abortAll();
    emit({denied: true, busy: false, error, remote: {...state.remote, retired: true, membershipRetired: true, status: 'denied', search: {status: 'denied', candidates: []}}});
    return true;
  }
  async function searchRemote() {
    if (!allowed(true) || !activateRemote() || !state.remote.title.trim()) return false;
    remoteSearchAbort?.abort();
    const version = ++remoteSearchVersion, abort = begin(); remoteSearchAbort = abort;
    const payload = {destination: remoteDestination(), title: state.remote.title.trim(), artist: state.remote.artist.trim()};
    remotePatch({search: {status: 'loading', candidates: []}});
    try {
      if (!remoteScoped() || typeof providers.searchRemoteAlbums !== 'function') throw remoteError('remote_context_changed');
      const page = await providers.searchRemoteAlbums(copy(payload), remoteOptions(abort, true));
      if (!remoteScoped() || abort.signal.aborted || version !== remoteSearchVersion || !membersAllowed(controller.getSnapshot()) || remoteMembershipRetired) return false;
      remotePatch({search: {status: 'ready', candidates: page.candidates.map(copy)}}); return true;
    } catch (error) {
      if (currentRemoteDenial(error)) return false;
      if (!remoteScoped()) {if (!disposed) retireRemote(); return false;}
      if (!abort.signal.aborted && version === remoteSearchVersion) {remotePatch({search: {status: 'error', candidates: []}}); emit({error});}
      return false;
    } finally {requests.delete(abort);}
  }
  async function runRemoteOperation(operation) {
    if (remoteOperation !== operation) return false;
    // Claim before any currency callback can synchronously request another
    // retry. The private begin-to-acquire continuation transfers this claim.
    const abort = begin(), attempt = {}; operation.abort = abort; operation.attempt = attempt; operation.status = 'loading';
    const ownsAttempt = () => remoteOperation === operation && operation.attempt === attempt && operation.abort === abort;
    try {
      if (!remoteScoped() || !ownsAttempt() || busyMutation(controller.getSnapshot().mutation)) return false;
      if (['begin', 'acquire'].includes(operation.kind) && (remoteMembershipRetired || !membersAllowed(controller.getSnapshot()))) return false;
      remotePatch({status: 'loading', operation: {kind: operation.kind, status: 'loading', ...(operation.ref ? {preparation_ref: operation.ref} : {})}}); refresh();
      if (!remoteScoped() || !ownsAttempt() || abort.signal.aborted || busyMutation(controller.getSnapshot().mutation)) return false;
      let result;
      if (operation.kind === 'begin') result = await providers.beginRemotePreparation(copy(operation.payload), remoteOptions(abort, true));
      else if (operation.kind === 'acquire') result = await providers.acquireRemoteAlbum(copy(operation.payload), remoteOptions(abort, true));
      else if (operation.kind === 'close') result = await providers.closeRemotePreparation(operation.ref, remoteOptions(abort));
      else if (operation.kind === 'status') result = await providers.readRemotePreparationState(remoteOptions(abort));
      else result = await providers.maintainRemotePreparations(copy(operation.payload), remoteOptions(abort));
      if (!remoteScoped() || abort.signal.aborted || !ownsAttempt() || busyMutation(controller.getSnapshot().mutation)) return false;
      if (['begin', 'acquire'].includes(operation.kind) && (remoteMembershipRetired || !membersAllowed(controller.getSnapshot()))) return false;
      if (operation.kind === 'begin' && result.state === 'ready') {
        ownedParents.add(result.preparation_ref); remotePatch({preparation: copy(result)});
        if (!remoteScoped() || !ownsAttempt() || busyMutation(controller.getSnapshot().mutation)) return false;
        operation.kind = 'acquire'; operation.payload = {version: 2, preparation_ref: result.preparation_ref, request_key: operation.requestKey,
          destination: operation.payload.destination, release_group_id: operation.candidate.release_group_id};
        return await runRemoteOperation(operation);
      }
      if (operation.kind === 'acquire' && result.state === 'in_flight') {
        operation.status = 'in_flight'; remotePatch({status: 'in_flight', operation: {kind: 'acquire', status: 'in_flight', retry_after_seconds: result.retry_after_seconds}}); return false;
      }
      if (operation.kind === 'acquire' && result.state === 'pending') {
        const exists = [...initialItems, ...state.items].some(row => row.release_group_id === result.album.release_group_id);
        if (!exists && state.items.length < (state.capacity ?? 5000)) {
          const row = {...copy(result.album), artist: result.album.artist_display, year: result.album.first_release_date ? Number(result.album.first_release_date.slice(0, 4)) : null,
            item_ref: null, selection_key: 'remote:' + result.acquisition_ref, preparation_ref: result.preparation_ref, expires_at: result.expires_at,
            source: {kind: 'remote_acquisition', acquisition_ref: result.acquisition_ref, evidence_version: result.evidence_version}};
          emit({items: [...state.items, row]});
        }
      }
      if (operation.kind === 'close') invalidateParent(operation.ref);
      if (operation.kind === 'status') remotePatch({ownState: copy(result)});
      if (operation.kind === 'maintain') remotePatch({maintenance: copy(result)});
      if (!remoteScoped() || !ownsAttempt() || busyMutation(controller.getSnapshot().mutation)) return false;
      remoteOperation = null;
      remotePatch({status: result.state, operation: null, result: copy(result)});
      // consumed is terminal acquisition detail only. It never settles the
      // controller's independent pending membership command or navigates.
      return remoteScoped() && ['pending', 'closed', 'status', 'progress', 'complete'].includes(result.state);
    } catch (error) {
      if (currentRemoteDenial(error)) return false;
      if (!remoteScoped()) {if (!disposed) retireRemote(); return false;}
      if (abort.signal.aborted || !ownsAttempt()) return false;
      const unavailable = error?.responseRejected === true && error.status === 409 && error.code === 'remote_preparation_unavailable'
        && ['acquire', 'close'].includes(operation.kind);
      if (unavailable) {
        invalidateParent(operation.kind === 'close' ? operation.ref : operation.payload.preparation_ref);
        if (!remoteScoped() || !ownsAttempt()) return false;
        remoteOperation = null; remotePatch({status: 'unavailable', operation: null}, {error});
      } else {
        operation.status = 'unknown'; remotePatch({status: 'unknown', operation: {kind: operation.kind, status: 'unknown', ...(operation.ref ? {preparation_ref: operation.ref} : {})}}, {error});
      }
      return false;
    } finally {
      requests.delete(abort);
      if (ownsAttempt() && operation.status === 'loading' && remoteScoped() && ownsAttempt()) {
        operation.status = 'unknown'; remotePatch({status: 'unknown', operation: {kind: operation.kind, status: 'unknown'}});
      }
      if (!disposed && !retired) refresh();
    }
  }
  function startRemoteOperation(operation) {
    if (!allowed() || !activateRemote(false) || remoteOperation || busyMutation(controller.getSnapshot().mutation)) return Promise.resolve(false);
    remoteOperation = operation;
    return runRemoteOperation(operation);
  }
  const unsubscribe = controller.subscribe?.(refresh) || (() => {});
  refresh();
  return {
    getSnapshot: () => state,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, refresh,
    canEdit: () => allowed(), canEditMembership: () => allowed(true),
    edit(patch) {
      if (adding || !allowed()) return false;
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
        || !Number.isSafeInteger(row.local_album_id) || row.local_album_id < 1 || state.items.length >= (state.capacity ?? 5000)) return false;
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
      emit({items: state.items.filter(row => rowKey(row) !== albumRef), error: null}); emit({search: {...state.search, items: visible()}}); return true;
    },
    reorder(refs) {
      if (!allowed(true) || !Array.isArray(refs) || refs.length !== state.items.length || new Set(refs).size !== refs.length) return false;
      const byRef = new Map(state.items.map(row => [rowKey(row), row]));
      const items = Array.from(refs, ref => byRef.get(ref));
      if (items.some(row => !row)) return false;
      emit({items, error: null}); return true;
    },
    setPool(pool) {
      if (!['local', 'remote'].includes(pool) || !allowed(true) || pool === 'remote' && !activateRemote()) return false;
      emit({pool}); return true;
    },
    setRemoteTitle(title) {
      if (!allowed(true) || !activateRemote() || typeof title !== 'string' || Array.from(title).length > 100 || /[\u0000-\u001f\u007f]/.test(title)) return false;
      remoteSearchVersion++; remoteSearchAbort?.abort(); remotePatch({title, search: {status: 'idle', candidates: []}}); return true;
    },
    setRemoteArtist(artist) {
      if (!allowed(true) || !activateRemote() || typeof artist !== 'string' || Array.from(artist).length > 100 || /[\u0000-\u001f\u007f]/.test(artist)) return false;
      remoteSearchVersion++; remoteSearchAbort?.abort(); remotePatch({artist, search: {status: 'idle', candidates: []}}); return true;
    },
    searchRemote,
    async selectRemote(candidate) {
      if (!allowed(true) || !activateRemote() || !state.remote.search.candidates.includes(candidate)
        || state.items.length >= (state.capacity ?? 5000) || [...initialItems, ...state.items].some(row => row.release_group_id === candidate.release_group_id)) return false;
      const target = remoteDestination(), operation = {kind: 'begin', status: 'new', payload: {destination: target, form_ref: formRef}, candidate: copy(candidate), requestKey: newRef()};
      return startRemoteOperation(operation);
    },
    retryRemoteAcquisition() {
      const operation = remoteOperation;
      if (!operation || !['unknown', 'in_flight'].includes(operation.status) || busyMutation(controller.getSnapshot().mutation)) return Promise.resolve(false);
      return runRemoteOperation(operation);
    },
    readRemotePreparationState() {return startRemoteOperation({kind: 'status', status: 'new'});},
    maintainRemotePreparations({discardLegacy = false, confirmed = false} = {}) {
      if (discardLegacy && confirmed !== true) {remotePatch({status: 'confirmation_required'}); return Promise.resolve(false);}
      return startRemoteOperation({kind: 'maintain', status: 'new', payload: {mode: discardLegacy ? 'discard_legacy' : 'reclaim'}});
    },
    closeRemotePreparation(ref, {confirmed = false} = {}) {
      if (!allowed() || !activateRemote(false) || remoteOperation || busyMutation(controller.getSnapshot().mutation)) return Promise.resolve(false);
      if (!ownedParents.has(ref)) {
        if (!state.remote.ownState?.parents.some(row => row.preparation_ref === ref)) return Promise.resolve(false);
        if (confirmed !== true) {remotePatch({status: 'confirmation_required'}); return Promise.resolve(false);}
      }
      return startRemoteOperation({kind: 'close', status: 'new', ref});
    },
    discardRemote() {
      const ref = ownedParents.values().next().value;
      return ref ? this.closeRemotePreparation(ref) : Promise.resolve(!remoteOperation && !busyMutation(controller.getSnapshot().mutation));
    },
    async submit() {
      if (sourceMatch) return false;
      if (!allowed() || (adding ? !state.items.length : !state.title.trim() || editing && !state.dirty)) return false;
      const items = state.items.map(localWire), membershipChanged = !equal(state.items.map(wire), baseline.items), hasRemote = state.items.some(isRemote);
      if (hasRemote && (!activateRemote(false) || state.items.some(row => row.source?.kind === 'remote_acquisition'
        && (unavailableParents.has(row.preparation_ref) || Date.parse(row.expires_at) <= Date.now())))) {emit({error: remoteError('remote_acquisition_expired')}); return false;}
      if (!adding && editing && hasRemote && source.edit_draft?.publication_preview_required) {emit({error: remoteError('remote_publication_unavailable')}); return false;}
      if (membershipChanged && (remoteMembershipRetired || !membersAllowed(controller.getSnapshot()))) return false;
      const selections = () => state.items.map(row => isRemote(row) ? copy(row.source) : {kind: 'local_catalog', album_ref: row.album_ref});
      const payload = adding ? hasRemote ? {selections: selections()} : {album_refs: state.items.map(row => row.album_ref)}
        : {title: state.title, description: state.description,
          ...(editing ? membershipChanged ? hasRemote ? {item_selections: state.items.map(typedWire)} : {items} : {}
            : hasRemote ? {draft_ref: formRef, selections: selections()} : {album_refs: state.items.map(row => row.album_ref)})};
      const abort = begin(); working = true; emit({busy: true, error: null});
      try {
        if (!adding && editing && source.edit_draft?.publication_preview_required) {
          if (typeof providers.preview !== 'function' || items.some(row => !row.selected_source_ref)) {
            throw new Error('This published Top needs an explicitly selected metadata source for every album. Remove the newly added albums to save these edits; publication source selection is not available here yet. Your draft is preserved.');
          }
          const preview = await providers.preview(topRef, {revision: state.revision, items: copy(items)}, options(abort));
          if (disposed || retired || abort.signal.aborted || !refresh()) return false;
          payload.evidence_revision = preview.evidence_revision;
        }
        if (disposed || retired || abort.signal.aborted || !refresh()
          || membershipChanged && (remoteMembershipRetired || !membersAllowed(controller.getSnapshot()))) return false;
        const beforeMutation = controller.getSnapshot().mutation;
        const attempt = controller.mutate(adding ? 'add' : editing ? 'save' : 'create', payload);
        if (adding || hasRemote) {
          // mutate synchronously acquires its existing request owner before
          // invoking transport. Bind only this invocation's exact add command;
          // another shared-controller write cannot close an unsent selection.
          const mutation = controller.getSnapshot().mutation, command = mutation.command;
          if (mutation !== beforeMutation && ['loading', 'uncertain'].includes(mutation.status)
            && mutation.action === (adding ? 'add' : editing ? 'save' : 'create')
            && (editing ? command?.top_ref === topRef && command.revision === state.revision : command?.draft_ref === formRef)
            && Object.keys(payload).every(key => equal(command[key], payload[key]))) {
            emit({submittedRequestKey: command.request_key});
          }
        }
        return await attempt;
      } catch (error) {if (!disposed && !retired && !abort.signal.aborted) deny(error); return false;}
      finally {requests.delete(abort); working = false; if (!disposed && !retired) refresh();}
    },
    dispose() {if (disposed) return; disposed = true; abortAll(); unsubscribe(); listeners.clear();},
  };
}
