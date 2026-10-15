import {createAlbumTopController} from './model.mjs';
import {createEditRequestNotifications} from '../home-friends/edit-request-notifications.mjs';
import {mountAlbumTopsView} from './app.mjs';
import {mountButton, mountStatus} from '../home-friends/native-controls.mjs';
export function mountAlbumTops({host, sidebarHost, runtime, providers}) {
  if (!host || !runtime?.snapshot || !runtime.subscribe) throw new TypeError('A native Album Tops host and runtime are required.');
  const controller = createAlbumTopController({providers});
  let disposed = false, mutationOwner = null, completedOperation = null, shareRequest = null, notifications = null, refreshedOperation = null,
    navigationError = null, savedForm = null, previousScope = Symbol('initial'), previousEnabled = null, previousNavigation = null,
    view = null, viewScope = null, running = false, queued = false;
  const make = (parent, tag = 'div') => {const node = parent.ownerDocument.createElement(tag); parent.append(node); return node;};
  const errorHost = make(host), retryHost = make(host), loadingHost = make(host), viewHost = make(host);
  const retry = mountButton(retryHost, runtime, {label: 'Retry opening Album Top', onClick: () => open(navigationError?.topRef)});
  const loading = mountStatus(loadingHost, runtime, {value: {status: 'loading'}, label: 'Album Tops'});
  const sidebar = sidebarHost ? make(sidebarHost, 'nav') : null;
  if (sidebar) {sidebar.className = 'collection-sidebar'; sidebar.setAttribute('aria-label', 'Album Tops');}
  const all = sidebar ? mountButton(make(sidebar), runtime, {label: 'All Album Tops', onClick: () => open(null)}) : null;
  const directory = sidebar ? mountStatus(make(sidebar), runtime, {value: controller.getSnapshot().directory, label: 'Album Tops', retry: () => controller.load()}) : null;
  const tree = sidebar ? make(sidebar) : null; if (tree) tree.className = 'navigation-tree';
  const sidebarRows = new Map();
  function schedule() {if (disposed) return; queued = true; if (running) return; running = true; try {while (queued && !disposed) {queued = false; render();}} finally {running = false;}}
  const mountNotifications = () => {
    if (disposed || notifications || !runtime.notificationRegistry?.()?.registerSource) return;
    notifications = createEditRequestNotifications({runtime, notifications: runtime.notificationRegistry(), providers,
      acceptsScope: runtime.acceptsPrivateScope, onDenied: controller.observeDenial, sourceName: 'album-top-edit-requests', label: 'Album Top edit requests', typeLabel: 'Album Top', resourceKey: 'top_ref',
      async onOpen(row, isCurrent) {if (!isCurrent()) return false; const opened = await runtime.navigate({top_ref: row.top_ref, isCurrent});
        if (opened === false || !isCurrent() || disposed) return false; shareRequest = {row, nativeSnapshot: runtime.snapshot(), isCurrent}; schedule(); return true;}});
  };
  const unsubscribeNotifications = runtime.subscribeNotificationRegistry?.(mountNotifications);
  const unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot(), mutation = snapshot.mutation;
    if (mutation.status === 'ready' && ['visibility', 'grant_editor', 'grant_viewer', 'revoke_editor', 'decide_edit_request'].includes(mutation.action) && refreshedOperation !== mutation.command?.request_key) {refreshedOperation = mutation.command.request_key; notifications?.refresh();}
    if (mutation.status === 'loading' && (mutation.command?.request_key !== mutationOwner?.requestKey || snapshot.scopeKey !== mutationOwner?.scopeKey)) {const shell = runtime.snapshot(); mutationOwner = {requestKey: mutation.command.request_key, scopeKey: shell.scopeKey, viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId};}
    schedule();
  });
  const unsubscribeShell = runtime.subscribe(schedule);
  async function open(top_ref, isCurrent = () => true, expectedViewRequestId) {
    const scopeKey = runtime.snapshot().scopeKey; let started = false, settled = false;
    const complete = ({opened, error}) => {settled = true; if (!disposed && isCurrent() && runtime.snapshot().scopeKey === scopeKey && error?.name !== 'AbortError') {navigationError = error || opened === false ? {topRef: top_ref} : null; schedule();}};
    try {const opened = await runtime.navigate({top_ref, isCurrent, expectedViewRequestId, onStart: () => {started = true;}, onSettled: complete});
      if (!settled && !started && !disposed && isCurrent() && runtime.snapshot().scopeKey === scopeKey) {navigationError = null; schedule();} return opened;
    } catch (error) {if (!settled && !started && error?.name !== 'AbortError' && !disposed && isCurrent() && runtime.snapshot().scopeKey === scopeKey) {navigationError = {topRef: top_ref}; schedule();} return false;}
  }
  function formSaved(receipt) {
    const latest = controller.getSnapshot(), native = runtime.snapshot(), acknowledged = latest.mutation;
    if (acknowledged.status !== 'ready' || acknowledged.action !== 'create' || receipt?.action !== 'create' || acknowledged.data?.request_key !== receipt.request_key
      || acknowledged.data?.top_ref !== receipt.top_ref || acknowledged.data?.revision !== receipt.revision || latest.scopeKey !== native.scopeKey
      || mutationOwner?.scopeKey !== native.scopeKey || mutationOwner.viewVersion !== native.viewVersion) return;
    savedForm = {scopeKey: latest.scopeKey, requestKey: receipt.request_key, topRef: receipt.top_ref, revision: receipt.revision}; schedule();
  }
  function render() {
    const shell = runtime.snapshot(), scope = shell.authenticated ? shell.scopeKey : null;
    const enabled = shell.authenticated && shell.inLibrary && (shell.active || shell.sidebarMode === 'album_tops');
    if (previousScope !== scope) {previousScope = scope; savedForm = null; controller.setScope(scope);}
    const enabledKey = JSON.stringify([enabled, shell.scopeKey]);
    if (enabledKey !== previousEnabled) {previousEnabled = enabledKey; if (enabled) controller.load();}
    const navigationKey = JSON.stringify([enabled, shell.scopeKey, shell.active, shell.topRef, shell.viewVersion]);
    if (navigationKey !== previousNavigation) {previousNavigation = navigationKey; navigationError = null; if (enabled) controller.open(shell.active ? shell.topRef : null);}
    const state = controller.getSnapshot();
    if (shareRequest && (!shareRequest.isCurrent() || !shell.authenticated || !shell.active || shell.scopeKey !== shareRequest.nativeSnapshot.scopeKey
      || shell.viewVersion !== shareRequest.nativeSnapshot.viewVersion || shell.viewRequestId !== shareRequest.nativeSnapshot.viewRequestId || shell.topRef !== shareRequest.row.top_ref)) shareRequest = null;
    const currentScope = enabled && state.scopeKey === shell.scopeKey;
    if (sidebar) {
      sidebar.hidden = !(currentScope && shell.sidebarMode === 'album_tops');
      directory.update({value: state.directory, label: 'Album Tops', retry: () => controller.load()});
      const wanted = new Set();
      for (const [index, top] of (sidebar.hidden ? [] : state.directory.data?.tops || []).entries()) {
        wanted.add(top.top_ref); let row = sidebarRows.get(top.top_ref);
        if (!row) {const element = make(tree), listener = event => {if (event.target.closest('a')) {event.preventDefault(); event.stopPropagation(); open(top.top_ref);}}; element.addEventListener('click', listener); row = {element, listener, html: null}; sidebarRows.set(top.top_ref, row);}
        const html = runtime.navigationItemHtml({label: top.title, key: top.top_ref, href: `/?surface=album_tops&top_ref=${encodeURIComponent(top.top_ref)}`, selected: shell.active && shell.topRef === top.top_ref});
        if (html !== row.html) {const focused = row.element.contains(row.element.ownerDocument.activeElement); row.element.innerHTML = html; row.html = html; if (focused) row.element.querySelector('a')?.focus({preventScroll: true});}
        if (tree.children[index] !== row.element) tree.insertBefore(row.element, tree.children[index] || null);
      }
      for (const [key, row] of sidebarRows) if (!wanted.has(key)) {row.element.removeEventListener('click', row.listener); row.element.remove(); sidebarRows.delete(key);}
    }
    const awaitingCreateClose = state.mutation.status === 'ready' && state.mutation.action === 'create' && mutationOwner?.scopeKey === shell.scopeKey && mutationOwner.viewVersion === shell.viewVersion && savedForm?.requestKey !== state.mutation.data?.request_key;
    const visible = currentScope && shell.visible, showView = visible && (state.selectedTopRef === shell.topRef || awaitingCreateClose);
    errorHost.hidden = retryHost.hidden = !(visible && navigationError);
    if (!errorHost.hidden) errorHost.innerHTML = runtime.alertHtml({severity: 'error', role: 'alert', message: 'This Album Top could not be opened. Try again.'});
    loadingHost.hidden = !visible || showView || Boolean(navigationError);
    if (!showView || viewScope !== shell.scopeKey) {view?.dispose(); view = null; viewScope = null;}
    if (showView) {const options = {runtime, controller, state, providers, onOpen: open, onFormSaved: formSaved, shareRequest, onShareRequestHandled: request => {if (shareRequest === request) shareRequest = null;}};
      if (view) view.update(options); else {viewScope = shell.scopeKey; view = mountAlbumTopsView(viewHost, runtime, options);}}
    const mutation = state.mutation, owner = mutationOwner, receipt = mutation.data, operation = receipt && JSON.stringify([state.scopeKey, receipt.request_key]);
    if (!enabled || !shell.visible || state.scopeKey !== shell.scopeKey || mutation.status !== 'ready' || mutation.refreshing === true
      || !['create', 'delete', 'copy'].includes(mutation.action) || !owner || !receipt || receipt.request_key !== owner.requestKey || completedOperation === operation
      || shell.viewRequestId !== owner.viewRequestId || mutation.action === 'copy' && (!Number.isSafeInteger(owner.viewRequestId) || owner.viewRequestId < 0)) return;
    if (mutation.action === 'create' && (savedForm?.scopeKey !== state.scopeKey || savedForm.requestKey !== receipt.request_key || savedForm.topRef !== receipt.top_ref || savedForm.revision !== receipt.revision)) return;
    const isCurrent = () => {const next = runtime.snapshot(), latest = controller.getSnapshot(), acknowledged = latest.mutation;
      return !disposed && latest.scopeKey === owner.scopeKey && acknowledged.status === 'ready' && acknowledged.action === mutation.action
        && acknowledged.data?.request_key === receipt.request_key && acknowledged.data?.top_ref === receipt.top_ref && acknowledged.data?.revision === receipt.revision
        && next.authenticated && next.inLibrary && next.scopeKey === owner.scopeKey && next.viewVersion === owner.viewVersion && next.active
        && (mutation.action !== 'copy' || next.topRef === mutation.command.top_ref);};
    if (isCurrent()) {completedOperation = operation; open(mutation.action === 'delete' ? null : receipt.top_ref, isCurrent, owner.viewRequestId);}
  }
  mountNotifications(); schedule();
  return Object.freeze({refresh() {if (!disposed && runtime.acceptsPrivateScope(controller.getSnapshot().scopeKey)) return controller.load();},
    dispose() {if (disposed) return; disposed = true; unsubscribe(); unsubscribeShell(); unsubscribeNotifications?.(); notifications?.dispose(); view?.dispose(); all?.dispose(); directory?.dispose(); retry.dispose(); loading.dispose();
      for (const row of sidebarRows.values()) row.element.removeEventListener('click', row.listener); sidebarRows.clear(); sidebar?.remove(); controller.dispose(); providers.dispose?.(); errorHost.remove(); retryHost.remove(); loadingHost.remove(); viewHost.remove();}});
}
