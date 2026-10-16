import {mountButton, mountChoice, mountStatus, mountTabs} from '../home-friends/native-controls.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {mountSharingVisibility, mountSharingMember, mountSharingReaderAccess, mountSharingRequestDecision} from '../home-friends/resource-sharing.mjs';
import {mountCreationSearch} from '../playlists/native-creation.mjs';
import {mountMutationStatus} from '../playlists/native-mutation-status.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {mountAlbumTopPublication} from './publication-panel.mjs';

// Each server directory owns its abort signal, cursor history and response. A
// detail identity, scope or query change invalidates every page from that owner.
function sharingPage(controller, method, changed, onFailure) {
  let detail, scopeKey, query = '', enabled = false, cursor = null, seen = [];
  let request = null, value = {status: 'loading', data: null}, disposed = false;
  const invalidate = () => {request?.abort(); request = null; value = {status: 'loading', data: null};};
  const read = () => {
    invalidate();
    if (disposed || !enabled || !detail) return;
    const owner = {detail, scopeKey, query, cursor}, pending = new AbortController();
    request = pending;
    const current = () => !disposed && request === pending && !pending.signal.aborted
      && enabled && detail === owner.detail && scopeKey === owner.scopeKey && query === owner.query && cursor === owner.cursor
      && controller.getSnapshot().scopeKey === owner.scopeKey && controller.getSnapshot().detail.data === owner.detail;
    Promise.resolve().then(() => {
      if (!current()) return null;
      return controller[method]({signal: pending.signal, cursor: owner.cursor, q: owner.query});
    }).then(result => {if (current()) {value = result || {status: 'error', data: null}; changed();}},
      error => {if (current() && error?.name !== 'AbortError') {value = {status: 'error', data: null}; changed();}})
      .catch(error => {if (!disposed && request === pending && !pending.signal.aborted) onFailure(error);});
  };
  const canNext = next => Boolean(next && next !== cursor && !seen.includes(next) && seen.length < 100);
  return {
    sync(nextDetail, nextScope, nextEnabled, nextQuery = '') {
      if (disposed) return;
      const identityChanged = detail !== nextDetail || scopeKey !== nextScope || query !== nextQuery;
      const enabledChanged = enabled !== nextEnabled;
      if (!identityChanged && !enabledChanged) return;
      detail = nextDetail; scopeKey = nextScope; query = nextQuery; enabled = nextEnabled;
      if (identityChanged) {cursor = null; seen = [];}
      read();
    },
    get value() {return value;}, get cursor() {return cursor;}, canNext,
    retry() {if (!disposed && enabled) {read(); changed();}},
    next(next) {if (!disposed && enabled && canNext(next)) {cursor = next; seen = [...seen, next]; read(); changed();}},
    first() {if (!disposed && enabled) {cursor = null; seen = []; read(); changed();}},
    dispose() {if (disposed) return; disposed = true; invalidate();}
  };
}

export function openShareAlbumTop({runtime, controller, state: initialState, onClose, returnFocus, fallbackHost}) {
  let state = initialState, alive = true, frame = null, dialog = null, root = null, closeDialog = null;
  let visibility = null, decisionsDraft = null, rolesDraft = null, query = '', pane = 'people';
  const records = new Map();
  const superseded = Symbol('superseded sharing render');
  let rendering = false, renderPending = false, revision = 0, mounting = false, failed = false, failure = null, errorCleanup = null;
  const sharing = sharingPage(controller, 'readSharing', () => render(), failContent);
  const grants = sharingPage(controller, 'readAccessGrants', () => render(), failContent);
  const candidates = sharingPage(controller, 'readAccessCandidates', () => render(), failContent);
  const canDismiss = () => {
    if (failed) return true;
    const mutation = controller.getSnapshot().mutation;
    return mutation.refreshing !== true && mutation.status !== 'loading'
      && (mutation.status !== 'uncertain' || !controller.canRetryMutation());
  };
  const options = () => ({title: 'Share Album Top', pageId: 'share-album-top', showCloseButton: true,
    returnFocus, dismissDisabled: !canDismiss(), beforeDismiss: canDismiss});
  function retirePages() {sharing.dispose(); grants.dispose(); candidates.dispose();}
  function releaseRecords() {
    // Detach the registry before native close/focus can reenter this owner.
    const previous = [...records.values()]; records.clear();
    for (const record of previous) {
      const owner = record.owner; record.owner = null;
      try {owner?.dispose();} catch (error) {failure ||= error;}
    }
  }
  function disposeContent() {
    if (!alive) return;
    alive = false; frame = null; revision++; renderPending = false;
    retirePages(); releaseRecords();
    errorCleanup?.(); errorCleanup = null;
    root?.replaceChildren(); root = null; closeDialog = null;
  }
  function failContent(error) {
    if (!alive || failed) return;
    failed = true; failure = error; frame = null; revision++; renderPending = false;
    retirePages(); releaseRecords();
    if (!alive || !root) return;
    // Last-resort native DOM owner deliberately avoids the renderer that failed.
    // No mutation succeeded. Private rows and every page owner are already gone.
    const host = root, doc = host.ownerDocument, alert = doc.createElement('p'), button = doc.createElement('button');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Album Top sharing is not available right now. Close this dialog and try again.';
    button.type = 'button'; button.textContent = 'Close';
    const close = () => {if (alive && failed) closeDialog?.({force: true, reason: 'cancel'});};
    button.addEventListener('click', close);
    errorCleanup = () => button.removeEventListener('click', close);
    host.replaceChildren(alert, button);
    // A presentation failure must not hide the error or strand the forced Close.
    try {dialog?.update(options());} catch (_presentationError) { /* Error state remains visible. */ }
  }
  function render() {
    if (!alive || failed || !root) return;
    revision++; frame = null; renderPending = true;
    if (rendering) return;
    rendering = true;
    try {
      while (renderPending && alive && !failed) {
        renderPending = false;
        const operation = revision;
        try {renderPass(operation);}
        catch (error) {
          if (error === superseded || !alive || operation !== revision) continue;
          if (mounting) throw error;
          failContent(error);
        }
      }
    } finally {rendering = false;}
  }
  function renderPass(operation) {
    const renderRoot = root;
    const current = () => alive && !failed && root === renderRoot && revision === operation;
    const check = () => {if (!current()) throw superseded;};
    check();
    const detail = state.detail.data, scopeKey = state.scopeKey;
    const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
    const allowed = albumTopActionAllowed(state, 'view_sharing');
    // Acknowledged publication writes refresh their owner observation in the
    // controller. Wait for that refresh before loading this pane's complete
    // access DTO, so the two sharing reads cannot supersede each other.
    sharing.sync(detail, scopeKey, allowed && state.mutation.refreshing !== true);
    const data = sharing.value.data;
    const manage = allowed && data?.can_manage === true && albumTopActionAllowed(state, 'visibility');
    if (data && !manage && rolesDraft?.detail === detail) rolesDraft = null;
    grants.sync(detail, scopeKey, manage); candidates.sync(detail, scopeKey, manage, query);
    const conflict = [data, grants.value.data, candidates.value.data].some(value => value && value.revision !== detail?.revision);
    const currentFrame = {detail, scopeKey}; frame = currentFrame;
    const active = () => current() && frame === currentFrame && controller.getSnapshot().scopeKey === scopeKey
      && controller.getSnapshot().detail.data === detail && !['loading', 'uncertain'].includes(controller.getSnapshot().mutation.status)
      && controller.getSnapshot().mutation.refreshing !== true;
    const writable = action => active() && !conflict && albumTopActionAllowed(controller.getSnapshot(), action);
    const mutate = (action, value) => {if (writable(action)) return controller.mutate(action, value);};
    const selectedVisibility = visibility?.detail === detail ? visibility.value : data?.visibility;
    const decisions = decisionsDraft?.detail === detail ? decisionsDraft.values : {};
    const roles = rolesDraft?.detail === detail ? rolesDraft.values : {};
    const retainedCandidates = rolesDraft?.detail === detail ? rolesDraft.people || {} : {};
    const dismissalBlocked = !canDismiss();
    const used = new Set(), children = new Map(), doc = root.ownerDocument;
    // Reconcile keyed hosts without replacing persistent search or retry owners.
    // Native controls keep focus and their own menu/confirmation lifecycle.
    function node(key, parent, tag = 'div') {
      check();
      used.add(key);
      let record = records.get(key);
      if (!record) {record = {node: doc.createElement(tag), owner: null}; records.set(key, record);}
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(record.node);
      return record;
    }
    function section(key, parent, tag = 'div', className = '') {
      const record = node(key, parent, tag); record.node.className = className;
      children.set(record.node, []); return record.node;
    }
    function text(key, parent, message, className = '', role) {
      const record = node(key, parent, 'p'); record.node.textContent = message; record.node.className = className;
      if (role) record.node.setAttribute('role', role); else record.node.removeAttribute('role');
      return record.node;
    }
    function control(key, parent, mount, props, tag = 'div') {
      const record = node(key, parent, tag);
      if (record.owner) {record.owner.update(props); check();}
      else {
        const acquired = mount(record.node, runtime, props);
        if (!current()) {acquired?.dispose(); throw superseded;}
        record.owner = acquired;
      }
      return record.owner;
    }
    const button = (key, parent, label, disabled, onClick, size) => control(key, parent, mountButton, {label, disabled, onClick, ...(size ? {size} : {})}, 'span');
    const status = (key, parent, page, label) => control(key, parent, mountStatus,
      {value: page.value, label, retry: () => {if (active()) page.retry();}});
    function pagination(key, parent, page, next, label) {
      const host = section(key, parent, 'div', 'playlists__actions album-top-share__page-actions');
      if (page.cursor) button(`${key}:first`, host, `First ${label} page`, busy, () => {if (active()) page.first();}, 'small');
      if (next) button(`${key}:next`, host, `More ${label}`, busy || !page.canNext(next), () => {if (active()) page.next(next);}, 'small');
    }
    function member(key, parent, person, candidate = false) {
      const record = node(key, parent);
      if (record.owner) {record.owner.update({person}); check();}
      else {
        const acquired = mountSharingMember(record.node, {person});
        if (!current()) {acquired?.dispose(); throw superseded;}
        record.owner = acquired;
      }
      const host = record.owner.actions;
      host.classList.add('album-top-share__member-actions');
      record.node.firstElementChild?.classList.add('album-top-share__member-label');
      children.set(host, []);
      const role = roles[person.account_ref] || person.role || 'viewer';
      const action = role === 'viewer' ? 'grant_viewer' : 'grant_editor';
      const permitted = role !== person.role && (candidate ? person.allowed_actions?.[`can_${action}`] === true : person.is_active !== false);
      record.node.setAttribute('data-selected-member', String(candidate && Object.hasOwn(roles, person.account_ref)));
      const name = person.display_name || person.username_display || 'Library member';
      control(`${key}:role`, host, mountChoice, {label: `Access for ${name}`, value: role,
        options: [['viewer', 'Viewer'], ['editor', 'Editor']], disabled: busy || conflict || person.is_active === false,
        onChange: value => {
          if (['viewer', 'editor'].includes(value) && writable('visibility') && person.is_active !== false) {
            rolesDraft = {detail, values: {...roles, [person.account_ref]: value},
              people: {...retainedCandidates, ...(candidate ? {[person.account_ref]: {...person}} : {})}}; render();
          }
        }});
      button(`${key}:apply`, host, person.grant_ref ? 'Apply access' : 'Add access', busy || conflict || !permitted,
        () => {if (permitted) mutate(action, {account_id: person.account_id, role});});
      if (!candidate) button(`${key}:remove`, host, 'Remove access', busy || conflict,
        () => mutate('revoke_editor', {grant_ref: person.grant_ref}));
    }
    children.set(root, []);
    status('sharing:status', root, sharing, 'Album Top sharing');
    control('panes:tabs', root, mountTabs, {id: 'album-top-share-panes', label: 'Album Top sharing options', value: pane,
      items: [['people', 'People', {panelId: 'album-top-share-people'}], ['public', 'Public link', {panelId: 'album-top-share-public'}]],
      onChange: value => {
        if (['people', 'public'].includes(value) && alive && !failed && frame === currentFrame
          && controller.getSnapshot().scopeKey === scopeKey && controller.getSnapshot().detail.data === detail) {pane = value; render();}
      }});
    const people = section('panes:people', root, 'section', 'album-top-share__people');
    people.id = 'album-top-share-people'; people.setAttribute('role', 'tabpanel');
    people.setAttribute('aria-labelledby', 'album-top-share-panes-people'); people.hidden = pane !== 'people';
    const publicHost = section('panes:public', root, 'section', 'album-top-share__public');
    publicHost.id = 'album-top-share-public'; publicHost.setAttribute('role', 'tabpanel');
    publicHost.setAttribute('aria-labelledby', 'album-top-share-panes-public'); publicHost.hidden = pane !== 'public';
    control('publication:panel', publicHost, mountAlbumTopPublication, {controller, state, onError: failContent});
    if (conflict) {
      text('conflict:note', root, 'This Album Top changed. Refresh it before editing access.', 'playlists__note', 'alert');
    }
    if (data && !data.can_manage) {
      if (data.publication) text('owner:access-unavailable', people,
        'You own this Album Top. Named access changes are unavailable with your current permissions.', 'playlists__note');
      else control('reader', people, mountSharingReaderAccess, {value: data,
        disabled: busy || conflict || !albumTopActionAllowed(state, 'request_edit'),
        onRequest: () => {if (data.request_status !== 'pending') mutate('request_edit');}});
    }
    if (manage) {
      control('visibility', people, mountSharingVisibility, {label: 'Album Top visibility', visibility: selectedVisibility,
        disabled: busy || conflict, note: 'Private Album Tops are visible to their owner and named viewers and editors. Server-shared Album Tops are visible to authorized members of this library.',
        onChange: value => {if (['private', 'server_shared'].includes(value) && writable('visibility')) {visibility = {detail, value}; render();}}});
      for (const request of data.pending_requests) control(`request:${request.request_ref}`, people, mountSharingRequestDecision,
        {request, role: decisions[request.request_ref] || 'viewer', disabled: busy || conflict,
          onRole: role => {if (['viewer', 'editor'].includes(role) && writable('decide_edit_request')) {
            decisionsDraft = {detail, values: {...decisions, [request.request_ref]: role}}; render();
          }},
          onDecision: decision => {if (decision === 'decline' || (decision === 'approve' && decisions[request.request_ref] === 'editor'))
            mutate('decide_edit_request', {request_ref: request.request_ref, decision});}});
      pagination('requests:pages', people, sharing, data.next_pending_cursor, 'edit requests');
      const fieldset = section('grants:fieldset', people, 'fieldset'); fieldset.disabled = busy || conflict;
      const legend = node('grants:legend', fieldset, 'legend'); legend.node.textContent = 'People with access';
      status('grants:status', fieldset, grants, 'Album Top access');
      for (const person of grants.value.data?.grants || []) member(`grant:${person.grant_ref}`, fieldset, person);
      if (grants.value.data?.grants.length === 0) text('grants:empty', fieldset, 'No named viewers or editors.');
      pagination('grants:pages', people, grants, grants.value.data?.next_cursor, 'people with access');
      control('search', people, mountCreationSearch, {id: 'album-top-sharing-search', label: 'Find library members', value: query,
        maxLength: 100, disabled: busy, onChange: value => {if (active()) {query = value.slice(0, 100); render();}}});
      const memberResults = section('candidates:results', people, 'div', 'album-top-share__member-results gallery-scrollbar');
      memberResults.setAttribute('role', 'region'); memberResults.setAttribute('aria-label', 'Eligible library members');
      status('candidates:status', memberResults, candidates, 'Eligible library members');
      // Keep edited candidates in this same result list while its native search
      // input changes. Current page rows replace retained display/role facts.
      const currentCandidates = candidates.value.data?.candidates || [], byAccount = new Map(currentCandidates.map(person => [person.account_ref, person]));
      const selected = Object.keys(retainedCandidates).filter(ref => Object.hasOwn(roles, ref));
      const displayed = [...selected.map(ref => byAccount.get(ref) || retainedCandidates[ref]),
        ...[...byAccount.values()].filter(person => !selected.includes(person.account_ref))];
      for (const person of displayed) member(`candidate:${person.account_ref}`, memberResults, person, true);
      if (candidates.value.data?.candidates.length === 0 && !displayed.length) text('candidates:empty', memberResults, 'No matching eligible library members.');
      pagination('candidates:pages', memberResults, candidates, candidates.value.data?.next_cursor, 'library members');
      text('sharing:note', people, 'Each access change is saved separately. Personal ratings and listening progress stay private.', 'playlists__note');
      const visibilityActions = section('visibility:actions', people, 'div', 'playlists__actions');
      button('visibility:save', visibilityActions, 'Save visibility', busy || conflict || selectedVisibility === data.visibility,
        () => mutate('visibility', {visibility: selectedVisibility}));
    }
    control('mutation', root, mountMutationStatus, {value: {...state.mutation,
      status: state.mutation.status === 'uncertain' ? 'error' : state.mutation.status}, controller});
    const publicationRecovery = state.mutation.status === 'uncertain'
      && ['enable_external', 'revoke_external'].includes(state.mutation.action);
    if (pane === 'public' || conflict || publicationRecovery || sharing.value.status === 'error' || state.preparation?.status === 'error') {
      const topRef = state.selectedTopRef;
      button('publication:refresh', root, 'Refresh Album Top', !topRef || state.detail.status === 'loading'
        || state.mutation.refreshing === true || state.mutation.status === 'loading'
        || state.mutation.status === 'uncertain' && !publicationRecovery, () => {
        const next = controller.getSnapshot();
        if (alive && !failed && frame === currentFrame && next.scopeKey === scopeKey && next.selectedTopRef === topRef
          && next.detail.status !== 'loading' && next.mutation.status !== 'loading' && next.mutation.refreshing !== true
          && (next.mutation.status !== 'uncertain' || ['enable_external', 'revoke_external'].includes(next.mutation.action))) controller.open(topRef);
      });
    }
    if (state.mutation.status === 'uncertain' && !dismissalBlocked) text('mutation:uncertain', root,
      publicationRecovery ? 'The publication request has an unknown outcome. Refresh this Album Top before retrying the original request.'
        : 'Access changed. You can close this dialog and refresh the Album Top before retrying the original request.', 'playlists__note', 'status');
    const actions = section('actions', root, 'div', 'playlists__actions');
    button('close', actions, 'Close', dismissalBlocked, () => {if (alive && canDismiss()) closeDialog?.();});
    check();
    for (const [key, record] of records) if (!used.has(key)) {
      records.delete(key); const previous = record.owner; record.owner = null;
      previous?.dispose(); check(); record.node.remove();
    }
    for (const [parent, desired] of children) {
      check();
      let cursor = parent.firstChild;
      for (const child of desired) {
        check();
        if (child === cursor) cursor = cursor.nextSibling; else parent.insertBefore(child, cursor);
      }
      while (cursor) {check(); const next = cursor.nextSibling; cursor.remove(); cursor = next;}
    }
    check(); dialog?.update(options()); check();
  }
  try {
    dialog = openNativeDialog(runtime, options(), {onClose, fallbackHost,
      onError(error) {failed = true; failure = error; disposeContent();},
      mount(host, close) {
        root = host.ownerDocument.createElement('div'); root.className = 'playlists__form tag-editor-form album-top-share';
        host.append(root); closeDialog = close; mounting = true;
        try {render(); return {dispose: disposeContent};}
        catch (error) {disposeContent(); throw error;}
        finally {mounting = false;}
      }});
  } catch (error) {disposeContent(); throw error;}
  return {
    get failed() {return failed || dialog?.failed === true;},
    get error() {return failure;},
    update({state: nextState}) {if (!alive) return; state = nextState; render();},
    dispose() {dialog?.dispose(); disposeContent(); dialog = null;}
  };
}
