// Volatile, actor-scoped presentation state. PostgreSQL remains authoritative.
import {isManualProgress} from './progress.mjs';

const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create';
const actionPermissions = Object.freeze({create: 'can_create', save: 'can_edit', delete: 'can_delete',
  add: 'can_add', remove: 'can_remove', reorder: 'can_reorder', view_sharing: 'can_view_sharing',
  visibility: 'can_share', grant_editor: 'can_share', revoke_editor: 'can_share', decide_edit_request: 'can_share',
  request_edit: 'can_request_edit', copy: 'can_copy', set_manual_completion: 'can_manage_own_progress'});
const sharingPermissions = ['can_share', 'can_copy', 'can_request_edit'];
const empty = () => ({status: 'unavailable', data: null, error: null});
const idle = () => ({status: 'idle', action: null, command: null, error: null});
const projection = data => data?.allowed_actions && typeof data.allowed_actions === 'object' && !Array.isArray(data.allowed_actions)
  ? data.allowed_actions : {};
const permitted = (data, action) => Object.hasOwn(projection(data), action) && projection(data)[action] === true;
const required = action => Object.hasOwn(actionPermissions, action) ? actionPermissions[action] : null;
const failure = error => error?.status === 401 || error?.status === 403 ? 'denied' : 'error';
const clone = value => JSON.parse(JSON.stringify(value));
const ownProgress = (data, albumRef) => {
  const rows = data?.top_viewer_overlay?.item_progress;
  const row = rows && Object.hasOwn(rows, albumRef) ? rows[albumRef] : null;
  return isManualProgress(row) ? row : null;
};

export function albumTopActionAllowed(state, action, topRef = state?.selectedTopRef) {
  const permission = required(action), resource = action === 'create' ? state?.directory : state?.detail;
  if (!state?.scopeKey || !permission || !['ready', 'empty'].includes(resource?.status)) return false;
  if (action !== 'create' && (resource.status !== 'ready' || !topRef || state.selectedTopRef !== topRef
    || resource.data?.top_ref !== topRef)) return false;
  const sharingActions = sharingPermissions.includes(permission) ? resource.sharing_actions || {} : {};
  const allowed = Object.hasOwn(sharingActions, permission) ? sharingActions[permission] === true : permitted(resource.data, permission);
  return permitted(resource.data, BROWSE) && allowed
    && (action !== 'create' || permitted(resource.data, CREATE));
}

export function createAlbumTopController({providers, requestKey = () => globalThis.crypto.randomUUID()} = {}) {
  const listeners = new Set(), requests = new Set(), sharingDenials = new Map();
  let state = {scopeKey: null, selectedTopRef: null, directory: empty(), detail: empty(), mutation: idle()};
  let disposed = false, epoch = 0, listVersion = 0, detailVersion = 0, readVersion = 0, pending = null, inFlight = null;
  const emit = patch => {state = {...state, ...patch}; for (const listener of [...listeners]) listener();};
  const current = token => !disposed && token.epoch === epoch && token.scopeKey === state.scopeKey;
  const begin = () => {
    const abort = new AbortController(); requests.add(abort);
    return {epoch, scopeKey: state.scopeKey, abort, options: {scopeKey: state.scopeKey, signal: abort.signal}};
  };
  function reset() {epoch++; for (const request of requests) request.abort(); requests.clear(); sharingDenials.clear(); pending = null; inFlight = null;}
  // Consumed denial blocks exact replay until a matching authorized read starts
  // afterward. Unknown reads and grants already in flight cannot erase it.
  function recordRetryAuthority(data, topRef, version, denied = false) {
    if (!pending || !denied && (pending.action === 'create' ? topRef !== null : pending.command.top_ref !== topRef)) return;
    const permission = required(pending.action), grants = projection(data);
    const permissions = [BROWSE, permission, ...(pending.action === 'create' ? [CREATE] : [])];
    const progress = pending.action === 'set_manual_completion';
    const hasMembers = Array.isArray(data?.items);
    const member = hasMembers && data.items.some(item => item.album_ref === pending.command.album_ref);
    const allowed = !denied && permissions.every(action => permitted(data, action))
      && (!progress || member && ownProgress(data, pending.command.album_ref));
    const refused = denied || permissions.some(action => Object.hasOwn(grants, action) && grants[action] === false)
      || progress && hasMembers && !member;
    if (refused) {pending.retryVersion = readVersion; pending.denialVersion = readVersion; pending.retryDenied = true; return;}
    if (!allowed || version <= (pending.retryVersion || 0)) return;
    pending.retryVersion = version;
    pending.retryDenied = false;
  }
  function recordSharingAuthority(allowedActions, version) {
    const next = {...state.detail.sharing_actions}; let changed = false;
    for (const action of sharingPermissions) {
      if (!Object.hasOwn(allowedActions, action)) continue;
      const allowed = allowedActions[action];
      if (!allowed) sharingDenials.set(action, readVersion);
      else if (version <= (sharingDenials.get(action) || 0)) continue;
      if (next[action] !== allowed) {next[action] = allowed; changed = true;}
    }
    // Preserve the DTO identity that owns in-flight sharing pages. Updating
    // these exact gates rerenders actions without refetching the same detail.
    if (changed) emit({detail: {...state.detail, sharing_actions: next}});
  }
  function invalidateAuthority(error, except = null) {
    listVersion++; detailVersion++;
    recordRetryAuthority(null, null, readVersion, true);
    for (const request of requests) if (request !== except) request.abort();
    emit({directory: {status: 'denied', data: null, error}, detail: {status: 'denied', data: null, error}});
  }
  async function load() {
    if (disposed || !state.scopeKey) return false;
    const token = begin(), version = ++listVersion, authorityVersion = ++readVersion;
    emit({directory: {status: 'loading', data: state.directory.data, error: null}});
    try {
      const data = await providers.list(token.options);
      if (!current(token) || version !== listVersion) return false;
      recordRetryAuthority(data, null, authorityVersion);
      if (pending && pending.action !== 'create') recordRetryAuthority(data.tops.find(top => top.top_ref === pending.command.top_ref), pending.command.top_ref, authorityVersion);
      emit({directory: {status: data.tops.length ? 'ready' : 'empty', data, error: null}}); return true;
    } catch (error) {
      if (current(token) && version === listVersion) {
        const denied = failure(error) === 'denied';
        if (denied) {detailVersion++; recordRetryAuthority(null, null, authorityVersion, true);}
        emit({directory: {status: failure(error), data: null, error}, ...(denied ? {detail: {status: 'denied', data: null, error}} : {})});
      }
      return false;
    } finally {requests.delete(token.abort);}
  }
  async function open(topRef, progressAlbumRef = null) {
    if (disposed || !state.scopeKey) return false;
    const retain = progressAlbumRef && albumTopActionAllowed(state, 'set_manual_completion', topRef)
      && ownProgress(state.detail.data, progressAlbumRef) && state.detail.data.items?.some(item => item.album_ref === progressAlbumRef);
    const version = ++detailVersion; sharingDenials.clear();
    emit({selectedTopRef: topRef || null, detail: retain ? {...state.detail, refreshing: true}
      : topRef ? {status: 'loading', data: null, error: null} : empty()});
    if (!topRef) return true;
    const token = begin(), authorityVersion = ++readVersion;
    try {
      const data = await providers.read(topRef, token.options);
      if (!current(token) || version !== detailVersion || state.selectedTopRef !== topRef) return false;
      recordRetryAuthority(data, topRef, authorityVersion);
      emit({detail: {status: 'ready', data, error: null}}); return true;
    } catch (error) {
      if (current(token) && version === detailVersion) {
        const denied = error?.status === 401 || pending?.command.top_ref === topRef
          && (error?.status === 403 || pending.action === 'set_manual_completion' && error?.status === 404);
        recordRetryAuthority(null, topRef, authorityVersion, denied);
        if (error?.status === 401) listVersion++;
        emit({detail: {status: failure(error), data: null, error},
          ...(error?.status === 401 ? {directory: {status: 'denied', data: null, error}} : {})});
      }
      return false;
    } finally {requests.delete(token.abort);}
  }
  async function readAccess(method, options = {}) {
    const subject = state.detail.data, topRef = state.selectedTopRef, selectionVersion = detailVersion;
    const action = method === 'readSharing' ? 'view_sharing' : 'visibility';
    if (!albumTopActionAllowed(state, action) || typeof providers[method] !== 'function') return empty();
    const token = begin(), authorityVersion = ++readVersion;
    const cancel = () => token.abort.abort();
    options.signal?.addEventListener('abort', cancel, {once: true});
    if (options.signal?.aborted) cancel();
    try {
      const data = await providers[method](topRef, {...options, ...token.options});
      if (!current(token) || token.abort.signal.aborted || selectionVersion !== detailVersion || state.detail.data !== subject || state.selectedTopRef !== topRef) return empty();
      if (method === 'readSharing') {
        // This endpoint authorizes Browse and returns exact collaboration gates.
        // Other content actions remain unknown; do not infer them from access.
        const allowed_actions = {[BROWSE]: true};
        for (const [field, action] of [['can_manage', 'can_share'], ['can_copy', 'can_copy'], ['can_request_edit', 'can_request_edit']]) {
          if (Object.hasOwn(data, field) && typeof data[field] === 'boolean') allowed_actions[action] = data[field];
        }
        recordRetryAuthority({allowed_actions}, topRef, authorityVersion);
        recordSharingAuthority(allowed_actions, authorityVersion);
      }
      return {status: 'ready', data, error: null};
    } catch (error) {
      if (!current(token) || token.abort.signal.aborted || selectionVersion !== detailVersion || state.detail.data !== subject || state.selectedTopRef !== topRef) return empty();
      if (failure(error) === 'denied') invalidateAuthority(error, token.abort);
      return {status: failure(error), data: null, error};
    } finally {options.signal?.removeEventListener('abort', cancel); requests.delete(token.abort);}
  }
  async function send(owner) {
    const token = begin(), denialVersion = owner.denialVersion || 0;
    const progress = owner.action === 'set_manual_completion';
    // A recovered progress attempt owns only the Top selected when it starts.
    const navigationVersion = progress
      ? (state.selectedTopRef === owner.command.top_ref ? detailVersion : null) : owner.navigationVersion;
    emit({mutation: {status: 'loading', action: owner.action, command: clone(owner.command), error: null}});
    try {
      const receipt = await providers.execute(owner.action, clone(owner.command), token.options);
      if (!current(token) || pending !== owner) return false;
      // Restoration may authorize a new retry, never an attempt that began
      // before a consumed denial. Keep its exact recovery identity unpublished.
      if (progress && (token.abort.signal.aborted
        || (owner.denialVersion || 0) !== denialVersion)) throw new Error('Album Top progress authority changed.');
      pending = null;
      emit({mutation: {status: 'ready', refreshing: true, action: owner.action, command: clone(owner.command), error: null, data: receipt}});
      // Acknowledged writes remain acknowledged even if the following read fails.
      await Promise.all([load(), ...(owner.action !== 'copy' && navigationVersion === detailVersion
        && (!progress || state.selectedTopRef === owner.command.top_ref)
        ? [open(owner.action === 'delete' ? null : receipt.top_ref,
          progress ? owner.command.album_ref : null)] : [])]);
      return current(token);
    } catch (error) {
      if (!current(token) || pending !== owner) return false;
      const definitive = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
      if (definitive) pending = null;
      const denied = definitive && failure(error) === 'denied';
      if (denied) {
        listVersion++; detailVersion++;
        for (const request of requests) if (request !== token.abort) request.abort();
      }
      emit({...(denied ? {directory: {status: 'denied', data: null, error},
        detail: {status: 'denied', data: null, error}} : {}),
        mutation: {status: definitive ? failure(error) : 'uncertain', action: owner.action,
        command: clone(owner.command), error}});
      return false;
    } finally {
      requests.delete(token.abort);
      if (current(token)) {
        inFlight = null;
        if (state.mutation.status === 'ready' && state.mutation.command?.request_key === owner.command.request_key) {
          emit({mutation: {...state.mutation, refreshing: false}});
        }
      }
    }
  }
  function mutate(action, data = {}) {
    if (disposed || !state.scopeKey || pending || inFlight) return Promise.resolve(false);
    const detail = state.detail.data;
    if (action === 'view_sharing' || !albumTopActionAllowed(state, action)) return Promise.resolve(false);
    let command;
    if (action === 'set_manual_completion') {
      const row = ownProgress(detail, data.album_ref);
      if (typeof data.completed !== 'boolean' || !row || !detail.items?.some(item => item.album_ref === data.album_ref)) return Promise.resolve(false);
      command = {top_ref: state.selectedTopRef, request_key: requestKey(), album_ref: data.album_ref,
        progress_revision: row.progress_revision, completed: data.completed};
    } else {
      command = {...clone(data), request_key: requestKey(), ...(action === 'create' ? {} : {top_ref: state.selectedTopRef, revision: detail.revision})};
    }
    pending = {action, command, navigationVersion: detailVersion}; return startSend();
  }
  function startSend() {
    // Own the attempt before invoking providers, which may reject synchronously.
    inFlight = true;
    const promise = send(pending);
    if (inFlight !== null) inFlight = promise;
    return promise;
  }
  const canRetryMutation = () => !disposed && Boolean(pending) && state.mutation.status === 'uncertain' && pending.retryDenied !== true;
  function retryMutation() {
    if (inFlight || !canRetryMutation()) return Promise.resolve(false);
    return startSend();
  }
  return {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    getSnapshot: () => state,
    setScope(scopeKey) {
      if (disposed || state.scopeKey === scopeKey) return;
      reset(); emit({scopeKey: scopeKey || null, selectedTopRef: null, directory: empty(), detail: empty(), mutation: idle()});
    },
    load, open, mutate, retryMutation, canRetryMutation,
    observeDenial(scopeKey, error) {
      if (disposed || !state.scopeKey || state.scopeKey !== scopeKey || failure(error) !== 'denied') return false;
      invalidateAuthority(error); return true;
    },
    readSharing: options => readAccess('readSharing', options),
    readAccessGrants: options => readAccess('readAccessGrants', options),
    readAccessCandidates: options => readAccess('readAccessCandidates', options),
    dispose() {if (!disposed) {reset(); disposed = true; listeners.clear(); state = {...state, scopeKey: null, selectedTopRef: null, directory: empty(), detail: empty(), mutation: idle()};}},
  };
}
