import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {createAlbumTopController} from './model.mjs';
import {createEditRequestNotifications} from '../home-friends/edit-request-notifications.mjs';
import {AlbumTopsView} from './app.jsx';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';

export function mountAlbumTops({host, sidebarHost, runtime, providers}) {
  if (!host || !runtime?.snapshot || !runtime.subscribe) throw new TypeError('A native Album Tops host and runtime are required.');
  const root = createRoot(host), controller = createAlbumTopController({providers});
  let disposed = false, mutationOwner = null, completedOperation = null, shareRequest = null, notifications = null, refreshedOperation = null;
  const mountNotifications = () => {
    if (disposed || notifications || !runtime.notificationRegistry?.()?.registerSource) return;
    notifications = createEditRequestNotifications({runtime, notifications: runtime.notificationRegistry(), providers,
      acceptsScope: runtime.acceptsPrivateScope, onDenied: controller.observeDenial, sourceName: 'album-top-edit-requests', label: 'Album Top edit requests', typeLabel: 'Album Top', resourceKey: 'top_ref',
      async onOpen(row, isCurrent) {
        if (!isCurrent()) return false;
        const opened = await runtime.navigate({top_ref: row.top_ref, isCurrent});
        if (opened === false || !isCurrent() || disposed) return false;
        shareRequest = {row, nativeSnapshot: runtime.snapshot(), isCurrent}; root.render(<Session/>); return true;
      }});
  };
  const unsubscribeNotifications = runtime.subscribeNotificationRegistry?.(mountNotifications);
  mountNotifications();
  const unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot(), mutation = snapshot.mutation;
    if (mutation.status === 'ready' && ['visibility', 'grant_editor', 'revoke_editor', 'decide_edit_request'].includes(mutation.action)
      && refreshedOperation !== mutation.command?.request_key) {
      refreshedOperation = mutation.command.request_key; notifications?.refresh();
    }
    if (mutation.status === 'loading' && (mutation.command?.request_key !== mutationOwner?.requestKey
      || snapshot.scopeKey !== mutationOwner?.scopeKey)) {
      const shell = runtime.snapshot();
      mutationOwner = {requestKey: mutation.command.request_key, scopeKey: shell.scopeKey, viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId};
    }
  });
  function Session() {
    const shell = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    if (shareRequest && (!shareRequest.isCurrent() || !shell.authenticated || !shell.active
      || shell.scopeKey !== shareRequest.nativeSnapshot.scopeKey || shell.viewVersion !== shareRequest.nativeSnapshot.viewVersion
      || shell.viewRequestId !== shareRequest.nativeSnapshot.viewRequestId || shell.topRef !== shareRequest.row.top_ref)) shareRequest = null;
    const [navigationError, setNavigationError] = useState(null);
    const [savedForm, setSavedForm] = useState(null);
    const enabled = shell.authenticated && shell.inLibrary && (shell.active || shell.sidebarMode === 'album_tops');
    useEffect(() => {
      // Presentation changes may hide an uncertain write, but cannot erase its
      // exact operation key. Only the private identity retires that command.
      controller.setScope(shell.authenticated ? shell.scopeKey : null);
      setSavedForm(null);
    }, [shell.authenticated, shell.scopeKey]);
    useEffect(() => {
      if (enabled) controller.load();
    }, [enabled, shell.scopeKey]);
    useEffect(() => {
      setNavigationError(null);
      if (enabled) controller.open(shell.active ? shell.topRef : null);
    }, [enabled, shell.scopeKey, shell.active, shell.topRef, shell.viewVersion]);
    const open = async (top_ref, isCurrent = () => true, expectedViewRequestId) => {
      const scopeKey = shell.scopeKey;
      try {
        const opened = await runtime.navigate({top_ref, isCurrent, expectedViewRequestId});
        if (!disposed && isCurrent() && runtime.snapshot().scopeKey === scopeKey) setNavigationError(opened === false ? {topRef: top_ref} : null);
        return opened;
      } catch (error) {
        if (error?.name !== 'AbortError' && !disposed && isCurrent() && runtime.snapshot().scopeKey === scopeKey) setNavigationError({topRef: top_ref});
        return false;
      }
    };
    useEffect(() => {
      const mutation = state.mutation, owner = mutationOwner;
      const receipt = mutation.data;
      const operation = receipt && JSON.stringify([state.scopeKey, receipt.request_key]);
      if (!enabled || !shell.visible || state.scopeKey !== shell.scopeKey || mutation.status !== 'ready'
        || mutation.refreshing === true || !['create', 'delete', 'copy'].includes(mutation.action) || !owner
        || !receipt || receipt.request_key !== owner.requestKey || completedOperation === operation
        || shell.viewRequestId !== owner.viewRequestId
        || mutation.action === 'copy' && (!Number.isSafeInteger(owner.viewRequestId) || owner.viewRequestId < 0)) return;
      if (mutation.action === 'create' && (savedForm?.scopeKey !== state.scopeKey
        || savedForm.requestKey !== receipt.request_key || savedForm.topRef !== receipt.top_ref || savedForm.revision !== receipt.revision)) return;
      const isCurrent = () => {
        const next = runtime.snapshot(), latest = controller.getSnapshot();
        const acknowledged = latest.mutation;
        return !disposed && latest.scopeKey === owner.scopeKey && acknowledged.status === 'ready'
          && acknowledged.action === mutation.action && acknowledged.data?.request_key === receipt.request_key
          && acknowledged.data?.top_ref === receipt.top_ref && acknowledged.data?.revision === receipt.revision
          && next.authenticated && next.inLibrary && next.scopeKey === owner.scopeKey
          && next.viewVersion === owner.viewVersion && next.active
          && (mutation.action !== 'copy' || next.topRef === mutation.command.top_ref);
      };
      if (isCurrent()) {
        completedOperation = operation;
        open(mutation.action === 'delete' ? null : receipt.top_ref, isCurrent, owner.viewRequestId);
      }
    }, [enabled, shell.visible, shell.scopeKey, shell.viewRequestId, state.scopeKey, state.mutation, savedForm]);
    const formSaved = receipt => {
      const latest = controller.getSnapshot(), native = runtime.snapshot(), acknowledged = latest.mutation;
      if (acknowledged.status !== 'ready' || acknowledged.action !== 'create' || receipt?.action !== 'create'
        || acknowledged.data?.request_key !== receipt.request_key || acknowledged.data?.top_ref !== receipt.top_ref
        || acknowledged.data?.revision !== receipt.revision || latest.scopeKey !== native.scopeKey
        || mutationOwner?.scopeKey !== native.scopeKey || mutationOwner.viewVersion !== native.viewVersion) return;
      setSavedForm({scopeKey: latest.scopeKey, requestKey: receipt.request_key, topRef: receipt.top_ref, revision: receipt.revision});
    };
    const currentScope = enabled && state.scopeKey === shell.scopeKey;
    const awaitingCreateClose = state.mutation.status === 'ready' && state.mutation.action === 'create'
      && mutationOwner?.scopeKey === shell.scopeKey && mutationOwner.viewVersion === shell.viewVersion
      && savedForm?.requestKey !== state.mutation.data?.request_key;
    const sidebar = currentScope && shell.sidebarMode === 'album_tops' && <nav className="collection-sidebar" aria-label="Album Tops">
      <Button runtime={runtime} onClick={() => open(null)}>All Album Tops</Button>
      <Status runtime={runtime} value={state.directory} label="Album Tops" retry={() => controller.load()}/>
      <div className="navigation-tree">{state.directory.data?.tops.map(top => <NativeHtml key={top.top_ref}
        html={runtime.navigationItemHtml({label: top.title, key: top.top_ref, href: `/?surface=album_tops&top_ref=${encodeURIComponent(top.top_ref)}`,
          selected: shell.active && shell.topRef === top.top_ref})}
        onClick={event => {if (event.target.closest('a')) {event.preventDefault(); event.stopPropagation(); open(top.top_ref);}}}/>)}</div>
    </nav>;
    return <>{sidebarHost && createPortal(sidebar, sidebarHost)}
      {currentScope && shell.visible && <>
        {navigationError && <><NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: 'This Album Top could not be opened. Try again.'})}/>
          <Button runtime={runtime} onClick={() => open(navigationError.topRef)}>Retry opening Album Top</Button></>}
        {state.selectedTopRef === shell.topRef || awaitingCreateClose
          ? <AlbumTopsView key={shell.scopeKey} runtime={runtime} controller={controller} state={state} onOpen={open} onFormSaved={formSaved}
              shareRequest={shareRequest} onShareRequestHandled={request => {if (shareRequest === request) shareRequest = null;}}/>
          : !navigationError && <Status runtime={runtime} value={{status: 'loading'}} label="Album Tops"/>}
      </>}
    </>;
  }
  root.render(<Session/>);
  return Object.freeze({
    refresh() {if (!disposed && runtime.acceptsPrivateScope(controller.getSnapshot().scopeKey)) return controller.load();},
    dispose() {if (!disposed) {disposed = true; unsubscribe(); unsubscribeNotifications?.(); notifications?.dispose(); controller.dispose(); providers.dispose?.(); root.unmount();}},
  });
}
