// Volatile, actor-scoped presentation state. PostgreSQL remains authoritative.
import {isManualProgress, isTopActivity} from './progress.mjs';
import {projectOwnerPublication} from './publication.mjs';

const BROWSE = 'library.browse.read', CREATE = 'library.album_tops.create';
const actionPermissions = Object.freeze({create: 'can_create', save: 'can_edit', delete: 'can_delete',
  add: 'can_add', remove: 'can_remove', reorder: 'can_reorder', view_sharing: 'can_view_sharing',
  visibility: 'can_share', grant_editor: 'can_share', grant_viewer: 'can_share', revoke_editor: 'can_share', decide_edit_request: 'can_share',
  request_edit: 'can_request_edit', copy: 'can_copy', set_manual_completion: 'can_manage_own_progress', set_activity: 'can_set_activity'});
const sharingPermissions = ['can_share', 'can_copy', 'can_request_edit'];
const empty = () => ({status: 'unavailable', data: null, error: null});
const idle = () => ({status: 'idle', action: null, command: null, error: null});
const projection = data => data?.allowed_actions && typeof data.allowed_actions === 'object' && !Array.isArray(data.allowed_actions)
  ? data.allowed_actions : {};
const permitted = (data, action) => Object.hasOwn(projection(data), action) && projection(data)[action] === true;
const required = action => Object.hasOwn(actionPermissions, action) ? actionPermissions[action] : null;
const failure = error => error?.status === 401 || error?.status === 403 ? 'denied' : 'error';
const clone = value => JSON.parse(JSON.stringify(value));
const publicationAction = action => ['enable_external', 'revoke_external'].includes(action);
const remoteItems = detail => Array.isArray(detail?.items) && detail.items.some(row => row.source_kind === 'remote_summary');
const membershipAction = action => ['create', 'save', 'add', 'remove', 'reorder', 'copy'].includes(action);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const sameItems = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function publicationItems(detail, values = detail?.edit_draft?.items) {
  if (!Array.isArray(detail?.items) || !Array.isArray(detail.edit_draft?.items)
    || !Array.isArray(values) || values.length > 5000 || values.length !== detail.items.length
    || detail.edit_draft.items.length !== detail.items.length) return null;
  const items = [];
  for (let index = 0; index < values.length; index++) {
    const row = values[index], saved = detail.items[index], working = detail.edit_draft.items[index];
    if (!row || !uuid(row.item_ref) || !uuid(row.album_ref) || row.item_ref !== saved.item_ref
      || row.album_ref !== saved.album_ref || working?.item_ref !== saved.item_ref || working.album_ref !== saved.album_ref) return null;
    const local = Object.hasOwn(row, 'selected_local_album_id'), source = Object.hasOwn(row, 'selected_source_ref');
    if (local !== source || source && (!Number.isSafeInteger(row.selected_local_album_id)
      || row.selected_local_album_id < 1 || !uuid(row.selected_source_ref))) return null;
    items.push({item_ref: row.item_ref, album_ref: row.album_ref,
      ...(source ? {selected_local_album_id: row.selected_local_album_id, selected_source_ref: row.selected_source_ref} : {})});
  }
  if (new Set(items.map(row => row.item_ref)).size !== items.length || new Set(items.map(row => row.album_ref)).size !== items.length) return null;
  return items;
}
function publicationObserved(state, topRef = state?.selectedTopRef) {
  const observation = state?.publication, detail = state?.detail;
  return Boolean(state?.scopeKey && topRef && detail?.status === 'ready' && detail.data?.top_ref === topRef
    && state.selectedTopRef === topRef && permitted(detail.data, BROWSE) && observation?.status === 'ready'
    && observation.scopeKey === state.scopeKey && observation.top_ref === topRef
    && observation.revision === detail.data.revision && observation.data);
}
const ownProgress = (data, albumRef) => {
  const rows = data?.top_viewer_overlay?.item_progress;
  const row = rows && Object.hasOwn(rows, albumRef) ? rows[albumRef] : null;
  return isManualProgress(row) ? row : null;
};

export function albumTopActionAllowed(state, action, topRef = state?.selectedTopRef) {
  if (publicationAction(action)) return publicationObserved(state, topRef)
    && (action === 'revoke_external' ? state.publication.data.can_revoke_external === true
      : state.publication.data.can_enable_external === true && publicationItems(state.detail.data) !== null);
  const permission = required(action), resource = action === 'create' ? state?.directory : state?.detail;
  if (!state?.scopeKey || !permission || !['ready', 'empty'].includes(resource?.status)) return false;
  if (action !== 'create' && (resource.status !== 'ready' || !topRef || state.selectedTopRef !== topRef
    || resource.data?.top_ref !== topRef)) return false;
  const sharingActions = sharingPermissions.includes(permission) ? resource.sharing_actions || {} : {};
  const allowed = Object.hasOwn(sharingActions, permission) ? sharingActions[permission] === true : permitted(resource.data, permission);
  return permitted(resource.data, BROWSE) && allowed
    && (action !== 'set_activity' || isTopActivity(resource.data?.top_viewer_overlay?.activity))
    && (action !== 'set_manual_completion' || resource.data?.top_viewer_overlay?.activity?.active !== false)
    && (action !== 'create' || permitted(resource.data, CREATE));
}

export function createAlbumTopController({providers, requestKey = () => globalThis.crypto.randomUUID()} = {}) {
  const listeners = new Set(), requests = new Set(), sharingDenials = new Map();
  let state = {scopeKey: null, selectedTopRef: null, directory: empty(), detail: empty(), mutation: idle(),
    publication: empty(), publicationDraft: null, preparation: empty()};
  let disposed = false, epoch = 0, listVersion = 0, detailVersion = 0, readVersion = 0, pending = null, inFlight = null;
  let publicationReadVersion = 0, publicationDenialVersion = 0, preparationVersion = 0, sourceVersion = 0;
  let previewAbort = null, sourceAbort = null, prepared = null, publicationDraft = null;
  const emit = patch => {state = {...state, ...patch}; for (const listener of [...listeners]) listener();};
  const current = token => !disposed && token.epoch === epoch && token.scopeKey === state.scopeKey;
  const begin = () => {
    const abort = new AbortController(); requests.add(abort);
    return {epoch, scopeKey: state.scopeKey, abort, options: {scopeKey: state.scopeKey, signal: abort.signal}};
  };
  function retirePreparation() {
    preparationVersion++; prepared = null; previewAbort?.abort(); previewAbort = null;
  }
  function retireSources() {sourceVersion++; sourceAbort?.abort(); sourceAbort = null;}
  function clearPublication({draft = false} = {}) {
    publicationReadVersion++; retirePreparation(); retireSources();
    if (draft) publicationDraft = null;
    return {publication: empty(), preparation: empty(), publicationDraft: publicationDraft ? clone(publicationDraft) : null};
  }
  function reset() {
    epoch++; for (const request of requests) request.abort(); requests.clear(); sharingDenials.clear();
    clearPublication({draft: true}); publicationDenialVersion = 0; pending = null; inFlight = null;
  }
  function publicationRetryAllowed(owner) {
    return publicationObserved(state, owner.command.top_ref) && (owner.action === 'revoke_external'
      || state.publication.data.can_enable_external === true);
  }
  function recordPublicationAuthority(value, topRef, version, denied = false) {
    if (denied || !value) publicationDenialVersion = Math.max(publicationDenialVersion, readVersion);
    if (!pending || !publicationAction(pending.action) || pending.command.top_ref !== topRef) return;
    const refused = denied || !value || pending.action === 'enable_external' && value.can_enable_external !== true;
    if (refused) {
      pending.retryVersion = readVersion; pending.denialVersion = readVersion; pending.retryDenied = true;
    } else if (version > (pending.retryVersion || 0) && version > publicationDenialVersion) {
      pending.retryVersion = version; pending.retryDenied = false;
    }
  }
  // Consumed denial blocks exact replay until a matching authorized read starts
  // afterward. Unknown reads and grants already in flight cannot erase it.
  function recordRetryAuthority(data, topRef, version, denied = false) {
    if (!pending || !denied && (pending.action === 'create' ? topRef !== null : pending.command.top_ref !== topRef)) return;
    if (publicationAction(pending.action)) {
      const grants = projection(data), gates = [BROWSE, ...(pending.action === 'enable_external'
        ? ['can_edit', 'library.album_tops.manage', 'library.album_tops.items.manage'] : [])];
      if (denied || gates.some(action => Object.hasOwn(grants, action) && grants[action] === false)) {
        recordPublicationAuthority(null, pending.command.top_ref, version, true);
      }
      return; // Only the owner-only sharing projection can restore replay authority.
    }
    const permission = required(pending.action), grants = projection(data);
    const permissions = [BROWSE, permission, ...(pending.action === 'create' ? [CREATE] : []),
      ...(pending.remoteMembership && pending.membershipEdit ? ['library.album_tops.items.manage'] : [])];
    const progress = pending.action === 'set_manual_completion';
    const hasMembers = Array.isArray(data?.items);
    const member = hasMembers && data.items.some(item => item.album_ref === pending.command.album_ref);
    const allowed = !denied && permissions.every(action => permitted(data, action))
      && (!progress || member && ownProgress(data, pending.command.album_ref))
      && (pending.action !== 'set_activity' || isTopActivity(data?.top_viewer_overlay?.activity));
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
    publicationDenialVersion = Math.max(publicationDenialVersion, readVersion);
    emit({...clearPublication({draft: true}), directory: {status: 'denied', data: null, error}, detail: {status: 'denied', data: null, error}});
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
        emit({directory: {status: failure(error), data: null, error}, ...(denied
          ? {...clearPublication({draft: true}), detail: {status: 'denied', data: null, error}} : {})});
      }
      return false;
    } finally {requests.delete(token.abort);}
  }
  async function open(topRef, progressAlbumRef = null) {
    if (disposed || !state.scopeKey) return false;
    const retain = progressAlbumRef && albumTopActionAllowed(state, 'set_manual_completion', topRef)
      && ownProgress(state.detail.data, progressAlbumRef) && state.detail.data.items?.some(item => item.album_ref === progressAlbumRef);
    const version = ++detailVersion; sharingDenials.clear();
    emit({...clearPublication({draft: publicationDraft?.top_ref !== topRef}), selectedTopRef: topRef || null, detail: retain ? {...state.detail, refreshing: true}
      : topRef ? {status: 'loading', data: null, error: null} : empty()});
    if (disposed || version !== detailVersion || state.selectedTopRef !== (topRef || null)) return false;
    if (!topRef) return true;
    const token = begin(), authorityVersion = ++readVersion;
    try {
      const data = await providers.read(topRef, token.options);
      if (!current(token) || version !== detailVersion || state.selectedTopRef !== topRef) return false;
      recordRetryAuthority(data, topRef, authorityVersion);
      const items = publicationItems(data);
      const retained = publicationDraft?.top_ref === topRef && publicationDraft.revision === data.revision
        ? publicationItems(data, publicationDraft.items) : null;
      publicationDraft = items === null ? null : {top_ref: topRef, revision: data.revision, items: retained || items};
      emit({detail: {status: 'ready', data, error: null}, publicationDraft: publicationDraft ? clone(publicationDraft) : null}); return true;
    } catch (error) {
      if (current(token) && version === detailVersion) {
        const denied = failure(error) === 'denied' || pending?.command.top_ref === topRef
          && ['set_manual_completion', 'set_activity', 'enable_external', 'revoke_external'].includes(pending.action) && error?.status === 404;
        recordRetryAuthority(null, topRef, authorityVersion, denied);
        if (error?.status === 401) listVersion++;
        emit({...clearPublication({draft: denied}), detail: {status: failure(error), data: null, error},
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
    const sharing = method === 'readSharing';
    const publicationPatch = sharing ? clearPublication() : null;
    const publicationVersion = publicationReadVersion;
    if (sharing) emit({...publicationPatch, publication: {status: 'loading', data: null, error: null}});
    const scoped = () => current(token) && selectionVersion === detailVersion
      && state.detail.data === subject && state.selectedTopRef === topRef;
    const relevant = () => scoped() && !token.abort.signal.aborted && (!sharing || publicationVersion === publicationReadVersion);
    const cancel = () => token.abort.abort();
    options.signal?.addEventListener('abort', cancel, {once: true});
    if (options.signal?.aborted) cancel();
    try {
      if (!relevant()) return empty();
      const data = await providers[method](topRef, {...options, ...token.options});
      if (!relevant()) return empty();
      if (sharing) {
        if (data.top_ref !== topRef || data.revision !== subject.revision) {
          throw Object.assign(new Error('Album Top sharing revision changed. Refresh this Top.'), {status: 409, code: 'revision_conflict'});
        }
        const publication = Object.hasOwn(data, 'publication') ? projectOwnerPublication(data.publication) : null;
        if (authorityVersion <= publicationDenialVersion) return empty();
        // This endpoint authorizes Browse and returns exact collaboration gates.
        // Other content actions remain unknown; do not infer them from access.
        const allowed_actions = {[BROWSE]: true};
        for (const [field, action] of [['can_manage', 'can_share'], ['can_copy', 'can_copy'], ['can_request_edit', 'can_request_edit']]) {
          if (Object.hasOwn(data, field) && typeof data[field] === 'boolean') allowed_actions[action] = data[field];
        }
        recordRetryAuthority({allowed_actions}, topRef, authorityVersion);
        recordSharingAuthority(allowed_actions, authorityVersion);
        if (!relevant()) return empty();
        recordPublicationAuthority(publication, topRef, authorityVersion);
        if (!publication) {
          publicationDraft = null;
          emit({publication: empty(), publicationDraft: null});
        } else {
          if (!publicationDraft) {
            const items = publicationItems(subject);
            if (items) publicationDraft = {top_ref: topRef, revision: subject.revision, items};
          }
          emit({publicationDraft: publicationDraft ? clone(publicationDraft) : null,
            publication: Object.freeze({status: 'ready', data: Object.freeze(publication), error: null,
              scopeKey: state.scopeKey, top_ref: topRef, revision: subject.revision,
              detailGeneration: selectionVersion, readVersion: authorityVersion})});
        }
        if (!relevant()) return empty();
      }
      return {status: 'ready', data, error: null};
    } catch (error) {
      // A consumed in-scope denial retires even a newer page or write. Page
      // ordering must not turn an authorization failure into a harmless race.
      if (scoped() && failure(error) === 'denied') {
        invalidateAuthority(error, token.abort);
        return {status: 'denied', data: null, error};
      }
      if (!relevant()) return empty();
      if (sharing) {
        recordPublicationAuthority(null, topRef, authorityVersion, true);
        emit({...clearPublication(), publication: {status: failure(error), data: null, error}});
      }
      return {status: failure(error), data: null, error};
    } finally {
      options.signal?.removeEventListener('abort', cancel); requests.delete(token.abort);
      if (sharing && current(token) && token.abort.signal.aborted && selectionVersion === detailVersion
        && publicationVersion === publicationReadVersion && state.publication.status === 'loading') emit({publication: empty()});
    }
  }
  async function send(owner) {
    const token = begin(), denialVersion = owner.denialVersion || 0, recovering = owner.uncertain === true;
    const progress = owner.action === 'set_manual_completion', privateSelf = progress || owner.action === 'set_activity';
    const publication = publicationAction(owner.action);
    // A recovered private attempt owns only the Top selected when it starts.
    const navigationVersion = privateSelf || publication
      ? (state.selectedTopRef === owner.command.top_ref ? detailVersion : null) : owner.navigationVersion;
    emit({...(!privateSelf ? clearPublication() : {preparation: empty()}), mutation: {status: 'loading', action: owner.action, command: clone(owner.command), error: null,
      remoteMembership: owner.remoteMembership, recovered: recovering}});
    try {
      // A subscriber may retire the actor or selected Top while rendering busy state.
      if (!current(token) || pending !== owner) return false;
      if (publication && (navigationVersion !== detailVersion || state.selectedTopRef !== owner.command.top_ref
        || (owner.denialVersion || 0) !== denialVersion)) {
        if (owner.attempted) emit({mutation: {status: 'uncertain', action: owner.action, command: clone(owner.command),
          error: new Error('The original publication request still needs an exact retry.')}});
        else {pending = null; emit({mutation: idle()});}
        return false;
      }
      if (owner.remoteMembership && (token.abort.signal.aborted || (owner.denialVersion || 0) !== denialVersion)) {
        if (owner.attempted) emit({mutation: {status: 'uncertain', action: owner.action, command: clone(owner.command),
          remoteMembership: true, recovered: recovering, error: new Error('The original remote membership request still needs an exact retry.')}});
        else {pending = null; emit({mutation: idle()});}
        return false;
      }
      owner.attempted = true;
      const receipt = await providers.execute(owner.action, clone(owner.command), token.options);
      if (!current(token) || pending !== owner) return false;
      // Restoration may authorize a new retry, never an attempt that began
      // before a consumed denial. Keep its exact recovery identity unpublished.
      if ((privateSelf || publication || owner.remoteMembership) && (token.abort.signal.aborted
        || (owner.denialVersion || 0) !== denialVersion)) throw new Error('Album Top private action authority changed.');
      pending = null;
      emit({mutation: {status: 'ready', refreshing: true, action: owner.action, command: clone(owner.command), error: null, data: receipt,
        remoteMembership: owner.remoteMembership, recovered: recovering}});
      if (!current(token)) return false;
      // Acknowledged writes remain acknowledged even if the following read fails.
      await Promise.all([load(), ...(owner.action !== 'copy' && navigationVersion === detailVersion
        && (!(privateSelf || publication) || state.selectedTopRef === owner.command.top_ref)
        ? [(async () => {
          const opened = await open(owner.action === 'delete' ? null : receipt.top_ref, progress ? owner.command.album_ref : null);
          if (opened && publication && current(token) && state.selectedTopRef === owner.command.top_ref
            && state.detail.status === 'ready') await readAccess('readSharing');
        })()] : [])]);
      return current(token);
    } catch (error) {
      if (!current(token) || pending !== owner) return false;
      const definitive = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
      // Replay rechecks current access, hosting and retained source evidence.
      // A failed replay cannot prove that the original unknown write did not
      // commit. Keep its exact owner until a receipt acknowledges that command.
      const settled = definitive && !((publication || owner.remoteMembership) && recovering);
      if (settled) pending = null;
      else owner.uncertain = true;
      if (publication && recovering && definitive) recordPublicationAuthority(null, owner.command.top_ref, readVersion, true);
      if (owner.remoteMembership && recovering && definitive) recordRetryAuthority(null, owner.command.top_ref || null, readVersion, true);
      const denied = definitive && failure(error) === 'denied';
      const activityConflict = definitive && error.status === 409
        && (owner.action === 'set_activity' && error.code === 'activity_revision_conflict'
          || progress && error.code === 'top_inactive');
      if (denied) {
        listVersion++; detailVersion++;
        for (const request of requests) if (request !== token.abort) request.abort();
      }
      emit({...(denied || publication && (definitive || !publicationObserved(state, owner.command.top_ref))
        ? clearPublication({draft: denied}) : {}), ...(denied ? {directory: {status: 'denied', data: null, error},
        detail: {status: 'denied', data: null, error}} : {}),
        mutation: {status: settled ? failure(error) : 'uncertain', refreshing: activityConflict, action: owner.action,
        command: clone(owner.command), error, remoteMembership: owner.remoteMembership, recovered: recovering}});
      if (activityConflict) await Promise.all([load(), ...(navigationVersion === detailVersion
        && state.selectedTopRef === owner.command.top_ref ? [open(owner.command.top_ref)] : [])]);
      return false;
    } finally {
      requests.delete(token.abort);
      if (current(token)) {
        inFlight = null;
        if (state.mutation.refreshing === true && state.mutation.command?.request_key === owner.command.request_key) {
          emit({mutation: {...state.mutation, refreshing: false}});
        }
      }
    }
  }
  function mutate(action, data = {}) {
    if (disposed || !state.scopeKey || pending || inFlight) return Promise.resolve(false);
    if (['view_sharing', 'enable_external'].includes(action) || !albumTopActionAllowed(state, action)) return Promise.resolve(false);
    if (action === 'revoke_external') return queueMutation(action, {});
    return queueMutation(action, data);
  }
  function queueMutation(action, data = {}) {
    const detail = state.detail.data, capturedEpoch = epoch, capturedScope = state.scopeKey, navigationVersion = detailVersion;
    let command;
    if (action === 'set_activity') {
      const activity = detail?.top_viewer_overlay?.activity;
      if (!isTopActivity(activity) || typeof data.active !== 'boolean') return Promise.resolve(false);
      command = {top_ref: state.selectedTopRef, request_key: requestKey(),
        activity_revision: activity.activity_revision, active: data.active};
    } else if (action === 'set_manual_completion') {
      const row = ownProgress(detail, data.album_ref);
      if (typeof data.completed !== 'boolean' || !row || !detail.items?.some(item => item.album_ref === data.album_ref)) return Promise.resolve(false);
      command = {top_ref: state.selectedTopRef, request_key: requestKey(), album_ref: data.album_ref,
        progress_revision: row.progress_revision, completed: data.completed};
    } else {
      command = {...clone(data), request_key: requestKey(), ...(action === 'create' ? {} : {top_ref: state.selectedTopRef, revision: detail.revision})};
    }
    // Capture before retirement callbacks or busy-state rendering can replace
    // the current detail. Recovery belongs to this exact command, not the view.
    const remoteMembership = membershipAction(action) && (remoteItems(detail)
      || Array.isArray(command.selections) || Array.isArray(command.item_selections));
    const membershipEdit = action === 'save' && (Array.isArray(command.items) || Array.isArray(command.item_selections));
    if (disposed || epoch !== capturedEpoch || state.scopeKey !== capturedScope || detailVersion !== navigationVersion || pending || inFlight) return Promise.resolve(false);
    // Claim the sole membership owner before abort listeners can reenter.
    const owner = {action, command, navigationVersion, remoteMembership, membershipEdit};
    pending = owner;
    retirePreparation(); retireSources();
    if (disposed || epoch !== capturedEpoch || state.scopeKey !== capturedScope || detailVersion !== navigationVersion || pending !== owner || inFlight) {
      if (pending === owner) pending = null;
      return Promise.resolve(false);
    }
    return startSend();
  }
  function startSend() {
    // Own the attempt before invoking providers, which may reject synchronously.
    inFlight = true;
    const promise = send(pending);
    if (inFlight !== null) inFlight = promise;
    return promise;
  }
  const canRetryMutation = () => !disposed && Boolean(pending) && state.mutation.status === 'uncertain'
    && pending.retryDenied !== true && (!publicationAction(pending.action) || publicationRetryAllowed(pending));
  function retryMutation() {
    if (inFlight || !canRetryMutation()) return Promise.resolve(false);
    return startSend();
  }
  function setPublicationSelections(values) {
    if (disposed || pending || inFlight || !albumTopActionAllowed(state, 'enable_external')) return false;
    const items = publicationItems(state.detail.data, values);
    if (items === null) {retirePreparation(); emit({preparation: empty()}); return false;}
    if (publicationDraft?.top_ref === state.selectedTopRef && publicationDraft.revision === state.detail.data.revision
      && sameItems(publicationDraft.items, items)) return true;
    retirePreparation(); retireSources();
    publicationDraft = {top_ref: state.selectedTopRef, revision: state.detail.data.revision, items};
    emit({publicationDraft: clone(publicationDraft), preparation: empty()}); return true;
  }
  function setPublicationSource(itemRef, value) {
    if (!publicationDraft || !publicationDraft.items.some(row => row.item_ref === itemRef)) return false;
    const items = publicationDraft.items.map(row => row.item_ref !== itemRef ? row
      : {item_ref: row.item_ref, album_ref: row.album_ref, ...(value === null ? {}
        : {selected_local_album_id: value?.selected_local_album_id, selected_source_ref: value?.selected_source_ref})});
    return setPublicationSelections(items);
  }
  async function readPublicationSources(itemRef, options = {}) {
    if (disposed || pending || inFlight || !albumTopActionAllowed(state, 'enable_external')
      || typeof providers.readPublicationSources !== 'function') return empty();
    const subject = state.detail.data, topRef = state.selectedTopRef, selectionVersion = detailVersion;
    const item = subject.items.find(row => row.item_ref === itemRef);
    if (!item) return empty();
    retireSources();
    const token = begin(), version = sourceVersion; sourceAbort = token.abort;
    const cancel = () => token.abort.abort();
    options.signal?.addEventListener('abort', cancel, {once: true});
    if (options.signal?.aborted) cancel();
    const scoped = () => current(token) && selectionVersion === detailVersion && state.detail.data === subject && state.selectedTopRef === topRef;
    const relevant = () => scoped() && !token.abort.signal.aborted && version === sourceVersion
      && albumTopActionAllowed(state, 'enable_external') && !pending && !inFlight;
    try {
      if (!relevant()) return empty();
      const data = await providers.readPublicationSources(topRef, itemRef,
        {...options, ...token.options, revision: subject.revision, albumRef: item.album_ref});
      if (!relevant()) return empty();
      if (data.top_ref !== topRef || data.item_ref !== itemRef || data.album_ref !== item.album_ref || data.revision !== subject.revision) {
        throw Object.assign(new Error('Album Top publication sources changed.'), {status: 409, code: 'revision_conflict'});
      }
      return {status: 'ready', data, error: null};
    } catch (error) {
      if (scoped() && failure(error) === 'denied') {
        invalidateAuthority(error, token.abort);
        return {status: 'denied', data: null, error};
      }
      if (!relevant()) return empty();
      retirePreparation(); emit({preparation: empty()});
      return {status: failure(error), data: null, error};
    } finally {options.signal?.removeEventListener('abort', cancel); requests.delete(token.abort); if (sourceAbort === token.abort) sourceAbort = null;}
  }
  async function preparePublication(selections) {
    if (disposed || pending || inFlight || !albumTopActionAllowed(state, 'enable_external')
      || typeof providers.preview !== 'function') return false;
    const initialEpoch = epoch, initialVersion = detailVersion;
    if (selections !== undefined && !setPublicationSelections(selections)) return false;
    if (disposed || initialEpoch !== epoch || initialVersion !== detailVersion || pending || inFlight
      || !albumTopActionAllowed(state, 'enable_external')) return false;
    const subject = state.detail.data, topRef = state.selectedTopRef, selectionVersion = detailVersion;
    const items = publicationItems(subject, publicationDraft?.items);
    retirePreparation();
    if (items === null || items.some(row => !row.selected_source_ref)) {
      emit({preparation: {status: 'error', data: null, error: new Error('Choose a metadata source for every saved album before previewing.')}});
      return false;
    }
    const token = begin(), version = preparationVersion, observation = state.publication;
    previewAbort = token.abort;
    const scoped = () => current(token) && selectionVersion === detailVersion && state.detail.data === subject && state.selectedTopRef === topRef;
    const relevant = () => scoped() && !token.abort.signal.aborted && version === preparationVersion
      && state.publication === observation && albumTopActionAllowed(state, 'enable_external') && !pending && !inFlight;
    emit({preparation: {status: 'loading', data: null, error: null}});
    try {
      if (!relevant()) return false;
      const preview = await providers.preview(topRef, {revision: subject.revision, items: clone(items)}, token.options);
      if (!relevant()) return false;
      if (preview.top_ref !== topRef || preview.revision !== subject.revision
        || typeof preview.evidence_revision !== 'string' || !/^[0-9a-f]{64}$/.test(preview.evidence_revision)
        || !sameItems(publicationItems(subject, preview.items), items)
        || preview.items.some(row => typeof row.title !== 'string' || typeof row.artist !== 'string'
          || row.year !== null && (!Number.isInteger(row.year) || row.year < 1 || row.year > 9999)
          || !Number.isSafeInteger(row.track_count) || row.track_count < 0 || row.track_count > 5000)) {
        throw new Error('Album Top publication preview no longer matches the selected sources.');
      }
      const preparationToken = Object.freeze({});
      prepared = {token: preparationToken, epoch, scopeKey: state.scopeKey, topRef, revision: subject.revision,
        detailVersion: selectionVersion, version, observation, items: clone(items), evidenceRevision: preview.evidence_revision};
      emit({preparation: {status: 'ready', data: clone(preview), error: null, token: preparationToken}});
      return relevant() && prepared?.token === preparationToken ? preparationToken : false;
    } catch (error) {
      if (scoped() && failure(error) === 'denied') {invalidateAuthority(error, token.abort); return false;}
      if (!relevant()) return false;
      retirePreparation(); emit({preparation: {status: 'error', data: null, error}});
      return false;
    } finally {requests.delete(token.abort); if (previewAbort === token.abort) previewAbort = null;}
  }
  function publishPrepared(token) {
    const reviewed = prepared;
    if (disposed || pending || inFlight || !token || reviewed?.token !== token || reviewed.epoch !== epoch
      || reviewed.scopeKey !== state.scopeKey || reviewed.topRef !== state.selectedTopRef
      || reviewed.revision !== state.detail.data?.revision || reviewed.detailVersion !== detailVersion
      || reviewed.version !== preparationVersion || reviewed.observation !== state.publication
      || !albumTopActionAllowed(state, 'enable_external')) return Promise.resolve(false);
    return queueMutation('enable_external', {items: clone(reviewed.items), evidence_revision: reviewed.evidenceRevision});
  }
  function cancelPublicationPreparation() {
    if (disposed) return;
    emit(clearPublication());
  }
  return {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    getSnapshot: () => state,
    setScope(scopeKey) {
      if (disposed || state.scopeKey === scopeKey) return;
      reset(); emit({scopeKey: scopeKey || null, selectedTopRef: null, directory: empty(), detail: empty(), mutation: idle(),
        publication: empty(), publicationDraft: null, preparation: empty()});
    },
    load, open, mutate, retryMutation, canRetryMutation,
    readPublicationSources, setPublicationSelections, setPublicationSource, preparePublication, publishPrepared, cancelPublicationPreparation,
    observeDenial(scopeKey, error) {
      if (disposed || !state.scopeKey || state.scopeKey !== scopeKey || failure(error) !== 'denied') return false;
      invalidateAuthority(error); return true;
    },
    readSharing: options => readAccess('readSharing', options),
    readAccessGrants: options => readAccess('readAccessGrants', options),
    readAccessCandidates: options => readAccess('readAccessCandidates', options),
    dispose() {if (!disposed) {reset(); disposed = true; listeners.clear(); state = {...state, scopeKey: null, selectedTopRef: null,
      directory: empty(), detail: empty(), mutation: idle(), publication: empty(), publicationDraft: null, preparation: empty()};}},
  };
}
