/* Native shell/navigation adapter. Top data never enters gallery state/history. */
const AlbumTopsRuntime = (() => {
  const listeners = new Set();
  let current = null, lastView = null, viewVersion = 0, confirmation = null;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const aborted = () => Object.assign(new Error('Album Top navigation was superseded.'), {name: 'AbortError'});
  function sync() {
    const shell = document.getElementById('app-shell'), host = document.getElementById('album-tops-root');
    let context = null;
    try {context = PrivateUITransport.context();} catch { /* A retired context cannot authorize private reads. */ }
    const scopeKey = JSON.stringify([shell?.dataset?.nativeAccountId || '', shell?.dataset?.nativeLibraryId || '', context, PrivateUITransport.generation()]);
    const authenticated = Boolean(context && shell?.dataset?.nativeAccountId && shell?.dataset?.nativeLibraryId);
    const inLibrary = new URL(window.location.href).pathname === '/' && shell?.hidden !== true;
    const active = inLibrary && String(state.view?.surface?.active || state.view?.surface_request || '') === 'album_tops';
    if (lastView !== state.view) {lastView = state.view; viewVersion++;}
    const next = {scopeKey, authenticated, inLibrary, active, visible: Boolean(host && active && !state.ui?.pendingViewTransition),
      topRef: active && typeof state.view.top_ref === 'string' && state.view.top_ref ? state.view.top_ref : null,
      sidebarMode: getLibrarySidebarMode(), viewVersion, viewRequestId: state.ui?.activeViewRequestId || 0};
    if (confirmation && (!authenticated || confirmation.scopeKey !== scopeKey || confirmation.viewVersion !== viewVersion)) {
      if (typeof activeAppConfirmDialog !== 'undefined' && activeAppConfirmDialog?.promise === confirmation.promise) activeAppConfirmDialog.cancel({restoreFocus: false});
      confirmation = null;
    }
    if (host) host.hidden = !next.visible;
    document.getElementById('shell-main-surface')?.classList.toggle('has-react-album-tops', next.visible);
    if (current && Object.keys(next).every(key => current[key] === next[key])) return current;
    current = Object.freeze(next);
    for (const listener of [...listeners]) listener();
    return current;
  }
  const acceptsPrivateScope = scopeKey => {
    const snapshot = sync();
    return snapshot.authenticated && snapshot.inLibrary && snapshot.scopeKey === scopeKey;
  };
  async function navigate({top_ref = null, isCurrent = () => true, expectedViewRequestId} = {}) {
    const start = sync();
    if (!acceptsPrivateScope(start.scopeKey) || top_ref !== null && !uuid(top_ref) || !isCurrent()
      || expectedViewRequestId !== undefined && start.viewRequestId !== expectedViewRequestId) return false;
    const open = async () => {
      if (!isCurrent() || !acceptsPrivateScope(start.scopeKey) || sync().viewVersion !== start.viewVersion
        || sync().viewRequestId !== start.viewRequestId) throw aborted();
      const priorView = state.view, params = new URLSearchParams({surface: 'album_tops'});
      if (top_ref) params.set('top_ref', top_ref);
      let requestId = null;
      const pending = fetchAndRender(`/view-data?${params}`, true, {source: 'library', shouldApplyResponse(payload) {
        if (!isCurrent() || sync().scopeKey !== start.scopeKey || !sync().authenticated || state.view !== priorView
          || !sync().inLibrary || requestId !== null && state.ui.activeViewRequestId !== requestId) return false;
        try {PrivateUITransport.accept(payload);} catch {return false;}
        return payload?.surface?.active === 'album_tops' && (payload.top_ref || null) === top_ref;
      }});
      requestId = state.ui.activeViewRequestId;
      const applied = await pending, next = sync();
      if (requestId !== state.ui.activeViewRequestId || next.scopeKey !== start.scopeKey || !next.authenticated) throw aborted();
      if (applied === false || !next.visible || next.topRef !== top_ref) return false;
      closeArtistsDrawer({restoreFocus: false});
      return true;
    };
    return (typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(open)) || open();
  }
  async function confirm(message, options = {}) {
    const start = sync();
    if (!start.visible || !start.authenticated || typeof showAppConfirmDialog !== 'function' || activeAppConfirmDialog) return false;
    const owner = {scopeKey: start.scopeKey, viewVersion: start.viewVersion,
      promise: showAppConfirmDialog({title: options.title || 'Discard Album Top changes', message,
        acceptLabel: options.acceptLabel || 'Discard', danger: options.danger !== false})};
    confirmation = owner;
    try {
      const accepted = await owner.promise, next = sync();
      return accepted === true && confirmation === owner && next.visible && next.authenticated
        && next.scopeKey === start.scopeKey && next.viewVersion === start.viewVersion;
    } finally {if (confirmation === owner) confirmation = null;}
  }
  const components = window.AlbumHavenHomeRuntime;
  PrivateUITransport.subscribe(sync);
  window.addEventListener('popstate', sync);
  window.addEventListener('albumhaven:library-sidebar-change', sync);
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') new MutationObserver(sync).observe(shell,
    {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  return Object.freeze({
    snapshot: sync, sync, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    acceptsPrivateScope, navigate, selectSidebar: selectLibrarySidebarMode,
    buttonHtml: components.buttonHtml, actionHtml: components.actionHtml, alertHtml: components.alertHtml,
    searchHtml: components.searchHtml,
    notificationRegistry: () => window.AlbumHavenNotifications,
    subscribeNotificationRegistry(listener) {
      window.addEventListener('albumhaven:notifications-ready', listener);
      return () => window.removeEventListener('albumhaven:notifications-ready', listener);
    },
    galleryCardHtml: components.galleryCardHtml, artboxHtml: components.artboxHtml,
    navigationItemHtml: components.navigationItemHtml, openChoice: components.openChoice,
    openForm(options) {
      const start = sync(), sourceView = state.view, sourceUrl = window.location.href;
      let formOwner = null;
      const currentView = () => {
        const next = sync();
        return next.visible && next.authenticated && next.scopeKey === start.scopeKey && next.viewVersion === start.viewVersion
          && state.view === sourceView && window.location.href === sourceUrl;
      };
      const form = openReactFormDialog({...options, retainParentView: () => currentView()
        && formOwner?.isCurrentContext() === true && (!activeAppFormDialog || activeAppFormDialog === formOwner)}, currentView);
      formOwner = activeAppFormDialog;
      return form;
    },
    deferFormNavigation: callback => typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(callback),
    confirm,
    confirmRetryOriginal(scopeKey) {
      if (!acceptsPrivateScope(scopeKey)) return Promise.resolve(false);
      return confirm('Retry the exact original request with its original operation key and unchanged data? This checks the server result without creating a duplicate change.',
        {title: 'Retry original request', acceptLabel: 'Retry', danger: false});
    },
  });
})();
function syncAlbumTopsRuntime() {AlbumTopsRuntime.sync();}
window.AlbumHavenAlbumTopsRuntime = AlbumTopsRuntime;
window.dispatchEvent(new Event('albumhaven:album-tops-runtime-ready'));
