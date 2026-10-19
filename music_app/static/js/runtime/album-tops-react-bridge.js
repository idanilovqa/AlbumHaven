/* Native shell/navigation adapter. Top data never enters gallery state/history. */
const AlbumTopsRuntime = (() => {
  const listeners = new Set();
  const pendingListeners = new Set();
  let snapshotDepth = 0, notificationQueued = false;
  let current = null, lastView = null, viewVersion = 0, confirmation = null, draftNavigation = null;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const aborted = () => Object.assign(new Error('Album Top navigation was superseded.'), {name: 'AbortError'});
  function privateIdentity() {
    const shell = document.getElementById('app-shell');
    let context = null;
    try {context = PrivateUITransport.context();} catch { /* A retired context cannot authorize private reads. */ }
    const scopeKey = JSON.stringify([shell?.dataset?.nativeAccountId || '', shell?.dataset?.nativeLibraryId || '', context, PrivateUITransport.generation()]);
    const authenticated = Boolean(context && shell?.dataset?.nativeAccountId && shell?.dataset?.nativeLibraryId);
    return {shell, scopeKey, authenticated};
  }
  const draftCurrent = owner => {
    const identity = privateIdentity();
    try {return Boolean(owner && draftNavigation === owner && identity.authenticated && identity.scopeKey === owner.scopeKey
      && identity.shell?.hidden !== true && state.view === owner.sourceView && owner.isCurrent() === true);} catch {return false;}
  };
  function releaseDraftNavigation(owner, discard = false, deferNotification = false) {
    if (!owner || draftNavigation !== owner) return;
    draftNavigation = null; owner.unregister?.();
    if (confirmation?.draftOwner === owner) {
      if (typeof activeAppConfirmDialog !== 'undefined' && activeAppConfirmDialog?.promise === confirmation.promise) activeAppConfirmDialog.cancel({restoreFocus: false});
      confirmation = null;
    }
    if (discard && deferNotification) {
      owner.pendingDiscard = true;
      Promise.resolve().then(() => {
        if (owner.pendingDiscard) {owner.pendingDiscard = false; owner.onDiscard();}
      });
    } else if (discard) owner.onDiscard();
  }
  async function confirmDraftDeparture(owner, message, options = {}) {
    if (!draftCurrent(owner) || typeof showAppConfirmDialog !== 'function' || activeAppConfirmDialog) return false;
    const pending = {draftOwner: owner, scopeKey: owner.scopeKey, viewVersion,
      promise: showAppConfirmDialog({title: options.title || 'Discard Album Top changes', message,
        acceptLabel: options.acceptLabel || 'Discard', danger: options.danger !== false})};
    confirmation = pending;
    try {return await pending.promise === true && confirmation === pending && draftCurrent(owner);}
    finally {if (confirmation === pending) confirmation = null;}
  }
  function registerDraftNavigation({isCurrent, confirmLeave, onDiscard} = {}) {
    const start = sync(), navigation = window.AlbumHavenSettingsNavigation?.instance;
    const position = window.history.state?.albumHavenNavigationPosition, url = window.location.href;
    if (draftNavigation || !start.visible || !start.authenticated || !Number.isSafeInteger(position)
      || typeof isCurrent !== 'function' || typeof confirmLeave !== 'function' || typeof onDiscard !== 'function'
      || typeof navigation?.setCollectionDraftOwner !== 'function' || typeof window.crypto?.randomUUID !== 'function') return false;
    const owner = {token: window.crypto.randomUUID(), scopeKey: start.scopeKey, sourceView: state.view, isCurrent, onDiscard};
    draftNavigation = owner;
    if (!draftCurrent(owner)) {draftNavigation = null; return false;}
    owner.unregister = navigation.setCollectionDraftOwner({token: owner.token, scopeKey: owner.scopeKey,
      isCurrent: () => draftCurrent(owner),
      ownsHistoryEntry: (snapshot, destination) => Number.isSafeInteger(snapshot?.albumHavenNavigationPosition)
        && snapshot.albumHavenNavigationPosition === position && destination === url,
      confirmLeave: () => confirmLeave((message, options) => confirmDraftDeparture(owner, message, options)),
      discard: () => releaseDraftNavigation(owner, true)});
    if (!owner.unregister) {draftNavigation = null; return false;}
    return () => {owner.pendingDiscard = false; releaseDraftNavigation(owner);};
  }
  function sync() {
    const {shell, scopeKey, authenticated} = privateIdentity(), host = document.getElementById('album-tops-root');
    // A snapshot may run during a React render. Retire authority immediately,
    // but notify its consumer after that render; cleanup cancels stale notices.
    if (draftNavigation && !draftCurrent(draftNavigation)) releaseDraftNavigation(draftNavigation, true, true);
    // The shared history owner keeps the source painted while it confirms or
    // restores a traversal. Live private identity and source view still govern.
    const retainedDeparture = Boolean(draftNavigation) && window.AlbumHavenSettingsNavigation?.instance
      ?.isCollectionDraftDeparturePending?.(draftNavigation.token) === true;
    const inLibrary = (new URL(window.location.href).pathname === '/' || retainedDeparture) && shell?.hidden !== true;
    const active = inLibrary && String(state.view?.surface?.active || state.view?.surface_request || '') === 'album_tops';
    if (lastView !== state.view) {lastView = state.view; viewVersion++;}
    const galleryPreferences = getSavedGalleryDisplayPreferences();
    const next = {scopeKey, authenticated, inLibrary, active, visible: Boolean(host && active && !state.ui?.pendingViewTransition),
      galleryDisplayMode: galleryPreferences.defaultGalleryDisplayMode,
      galleryScalePercent: galleryPreferences.defaultGalleryScalePercent,
      mobileGalleryColumns: window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3) ?? 3,
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
    if (snapshotDepth) {
      for (const listener of listeners) pendingListeners.add(listener);
      if (pendingListeners.size && !notificationQueued) {
        notificationQueued = true;
        Promise.resolve().then(() => {
          notificationQueued = false;
          const pending = [...pendingListeners]; pendingListeners.clear();
          for (const listener of pending) if (listeners.has(listener)) listener();
        });
      }
    } else {
      for (const listener of [...listeners]) {
        pendingListeners.delete(listener);
        if (listeners.has(listener)) listener();
      }
    }
    return current;
  }
  function snapshot() {
    snapshotDepth++;
    try {return sync();} finally {snapshotDepth--;}
  }
  const acceptsPrivateScope = scopeKey => {
    const snapshot = sync();
    return snapshot.authenticated && snapshot.inLibrary && snapshot.scopeKey === scopeKey;
  };
  async function navigate({top_ref = null, isCurrent = () => true, expectedViewRequestId, onStart, onSettled} = {}) {
    const start = sync();
    if (!acceptsPrivateScope(start.scopeKey) || top_ref !== null && !uuid(top_ref) || !isCurrent()
      || expectedViewRequestId !== undefined && start.viewRequestId !== expectedViewRequestId) return false;
    const open = async () => {
      const currentIntent = () => isCurrent() && acceptsPrivateScope(start.scopeKey) && sync().viewVersion === start.viewVersion
        && sync().viewRequestId === start.viewRequestId;
      if (!currentIntent()) throw aborted();
      const priorView = state.view, params = new URLSearchParams({surface: 'album_tops'});
      if (top_ref) params.set('top_ref', top_ref);
      let requestId = null, settlement = null;
      const pending = fetchAndRender(`/view-data?${params}`, true, {source: 'library', onStart({requestId: actualRequestId}) {
        const ownsDispatch = () => isCurrent() && acceptsPrivateScope(start.scopeKey)
          && sync().viewVersion === start.viewVersion && state.view === priorView
          && sync().viewRequestId === actualRequestId;
        if (requestId !== null || !ownsDispatch()) return false;
        requestId = actualRequestId;
        onStart?.();
        return ownsDispatch();
      }, onSettled({requestId: completedRequestId, applied, error}) {
        if (settlement || requestId === null || completedRequestId !== requestId) return;
        const next = sync();
        if (requestId !== state.ui.activeViewRequestId || next.scopeKey !== start.scopeKey
          || !next.authenticated || !next.inLibrary || error?.name === 'AbortError') return;
        const opened = applied === true && next.visible && next.topRef === top_ref;
        if (!opened && (!isCurrent() || state.view !== priorView || next.viewVersion !== start.viewVersion)) return;
        settlement = {opened, error};
        if (opened) closeArtistsDrawer({restoreFocus: false});
        try {onSettled?.(settlement);} catch (_error) { /* Completion observers do not own navigation. */ }
      }, shouldApplyResponse(payload) {
        if (!isCurrent() || sync().scopeKey !== start.scopeKey || !sync().authenticated || state.view !== priorView
          || !sync().inLibrary || requestId !== null && state.ui.activeViewRequestId !== requestId) return false;
        try {PrivateUITransport.accept(payload);} catch {return false;}
        return payload?.surface?.active === 'album_tops' && (payload.top_ref || null) === top_ref;
      }});
      const applied = await pending, next = sync();
      if (requestId === null) return false;
      if (requestId !== state.ui.activeViewRequestId || next.scopeKey !== start.scopeKey || !next.authenticated) throw aborted();
      return settlement?.opened === true && applied !== false;
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
  document.addEventListener('album-haven:preferences-sync', sync);
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') new MutationObserver(sync).observe(shell,
    {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  return Object.freeze({
    playbackControlHtml: options => renderPlaybackControlCluster(options),
    playbackControlElements: host => getPlaybackControlClusterElements(host),
    mountPlaybackOptions: options => mountLoopEditActionControl(options),
    playback: Object.freeze({
      transport: PrivateUITransport,
      captureScope(scopeKey) {
        if (!acceptsPrivateScope(scopeKey)) return null;
        const scope = capturePlaybackOwnershipScope();
        if (!scope || JSON.stringify([scope.actor, scope.library, scope.context, scope.generation]) !== scopeKey) return null;
        let retired = false;
        return Object.freeze({isCurrent() {
          if (!retired && !isPlaybackOwnershipScopeCurrent(scope)) retired = true;
          return !retired;
        }});
      },
      create: options => TopPlaybackRuntime.create(options),
      start: (queue, options) => TopPlaybackRuntime.start(queue, options),
      configure: (queue, options) => TopPlaybackRuntime.configure(queue, options),
      describe: queue => TopPlaybackRuntime.describe(queue),
      dispose: queue => TopPlaybackRuntime.dispose(queue),
    }),
    snapshot, sync, subscribe(listener) {
      listeners.add(listener);
      return () => {listeners.delete(listener); pendingListeners.delete(listener);};
    },
    acceptsPrivateScope, navigate, selectSidebar: selectLibrarySidebarMode,
    registerDraftNavigation,
    deferDraftNavigation(callback) {
      if (!draftCurrent(draftNavigation)) return false;
      return window.AlbumHavenSettingsNavigation?.instance?.deferCollectionDraftNavigation(callback) || false;
    },
    buttonHtml: components.buttonHtml, actionHtml: components.actionHtml, alertHtml: components.alertHtml,
    searchHtml: config => buildSearchInputHtml(config),
    tabsHtml: components.tabsHtml, mountTabs: components.mountTabs,
    notificationRegistry: () => window.AlbumHavenNotifications,
    subscribeNotificationRegistry(listener) {
      window.addEventListener('albumhaven:notifications-ready', listener);
      return () => window.removeEventListener('albumhaven:notifications-ready', listener);
    },
    galleryCardHtml: components.galleryCardHtml, artboxHtml: components.artboxHtml,
    escapeHtml: components.escapeHtml,
    viewChooserHtml: components.viewChooserHtml, mountViewChooser: components.mountViewChooser, viewIconHtml: components.viewIconHtml,
    createGalleryHost: options => new ResourceGalleryHost(options),
    createGalleryMetadataOwner: options => createGalleryCardMetadataMotion(options),
    createGalleryFocusOwner: options => createGalleryFocusGlowOwner(options),
    createResourceSelection: options => window.AlbumHavenResourceSelection.create(options),
    projectResourceTarget: value => window.AlbumHavenResourceSelection.projectTarget(value),
    projectResourceOrigin: value => window.AlbumHavenResourceSelection.projectOrigin(value),
    setGalleryDisplayMode(mode) {
      if (!['list', 'cards', 'covers'].includes(mode) || !sync().visible || !sync().authenticated) return false;
      const preferences = getSavedGalleryDisplayPreferences();
      persistCurrentGalleryDisplayPreferences({gallery_display_mode: mode, gallery_scale_percent: preferences.defaultGalleryScalePercent});
      sync(); return true;
    },
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
