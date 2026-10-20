/* Native shell/navigation adapter. Top data never enters gallery state/history. */
const AlbumTopsRuntime = (() => {
  const listeners = new Set();
  const pendingListeners = new Set();
  const artistListeners = new Set(), retiredArtistLaunches = new WeakSet();
  let artistOrigin = null, artistSyncing = false, artistNotifying = false, artistNotifyAgain = false;
  let artistRuntime = null, releaseArtistRuntime = null;
  let artistHistoryDepth = 0, artistHistoryQueued = false;
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
    syncArtistCreation();
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
  async function navigateOwned({top_ref = null, isCurrent = () => true, expectedViewRequestId, onStart, onSettled} = {}, artistHandoff = null) {
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
        if (artistHandoff) {
          // The native owner has advanced its request slot. The old child
          // receipt cannot be consulted until this exact reservation transfers.
          const exactDispatch = () => acceptsPrivateScope(start.scopeKey)
            && sync().viewVersion === start.viewVersion && state.view === priorView
            && state.ui.activeViewRequestId === actualRequestId;
          if (requestId !== null || !exactDispatch() || artistHandoff.offerRequest(actualRequestId) !== true
            || !exactDispatch() || !artistHandoff.isCurrent() || !ownsDispatch()) {
            artistHandoff.retire(); return false;
          }
        } else if (requestId !== null || !ownsDispatch()) return false;
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
  const navigate = options => navigateOwned(options, null);
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

  // Artist creation has one presentation lease. Server mutation authority stays
  // with the existing Top controller and provider; this owns only native UI.
  function notifyArtistCreation() {
    if (artistNotifying) {artistNotifyAgain = true; return;}
    artistNotifying = true;
    try {do {
      artistNotifyAgain = false;
      for (const listener of [...artistListeners]) if (artistListeners.has(listener)) {
        try {listener();} catch { /* A consumer cannot suppress retirement. */ }
      }
    } while (artistNotifyAgain);} finally {artistNotifying = false;}
  }
  const artistRequest = () => Number(state.ui?.activeViewRequestId || 0);
  const artistRevision = () => Number(state.ui?.viewStateRevision || 0);
  const safeArtistCheck = check => {try {return check?.() === true;} catch {return false;}};
  function artistAdmission() {
    if (state.busy || state.ui?.pendingViewTransition || activeAppFormDialog
      || typeof galleryArtistLovedHeaderContext !== 'function'
      || typeof artistListenThroughLaunchIsCurrent !== 'function') return null;
    const view = state.view, revision = artistRevision(), requestId = artistRequest();
    const identity = privateIdentity(), context = galleryArtistLovedHeaderContext();
    const header = document.querySelector('[data-gallery-bar-instance="gallery"]');
    if (!identity.authenticated || identity.shell?.hidden === true || !header || header.hidden
      || view.private_search || !context) return null;
    const runtime = window.AlbumHavenArtistPageRuntime, host = runtime?.snapshot();
    let page = null, group = null, launch = null;
    if (host?.sessionId) {
      if (!host.mounted || !host.actionable || context.kind !== 'artist-page') return null;
      page = view.artist_page; launch = page?.artist_listen_through_launch;
      if (host.artistRef !== page?.artist_ref) return null;
    } else if (context.kind === 'family' || context.kind === 'single-artist') {
      page = view.artist_page;
      if (page?.artist_ref !== view.selected_artist) return null;
      launch = page?.artist_listen_through_launch;
    } else if (context.kind === 'artist') {
      group = context.sourceSection?.group; launch = group?.artist_listen_through_launch;
      if (!group || group.artist !== launch?.artist_ref || group.display_artist_key && group.display_artist_key !== group.artist) return null;
    } else return null;
    if (!launch || retiredArtistLaunches.has(launch) || launch.context_ref !== view.artist_listen_through_context_ref
      || launch.artist_scope?.mode !== 'artist' || !artistListenThroughLaunchIsCurrent(launch)) return null;
    if (state.view !== view || artistRevision() !== revision || artistRequest() !== requestId
      || privateIdentity().scopeKey !== identity.scopeKey) return null;
    return {view, revision, requestId, scopeKey: identity.scopeKey, header, runtime,
      sessionId: host?.sessionId ?? null, artistEntryKey: host?.entryKey, artistEntryUrl: host?.entryUrl,
      page, group, launch, stamp: view.artist_listen_through_context_ref, kind: context.kind,
      entryKey: window.history.state?.albumHavenNavigationPosition, entryUrl: window.location.href};
  }
  function createArtistOrigin(captured) {
    let phase = 'idle', form = null, nativeForm = null, child = null, attempt = null, acknowledged = null;
    let continuityRequest = captured.requestId, origin;
    const fixed = () => phase !== 'retired' && artistOrigin === origin
      && window.AlbumHavenAlbumTopsRuntime === AlbumTopsRuntime && state.view === captured.view
      && artistRevision() === captured.revision && captured.header.isConnected !== false
      && document.querySelector('[data-gallery-bar-instance="gallery"]') === captured.header
      && window.AlbumHavenArtistPageRuntime === captured.runtime;
    const base = () => {
      if (!fixed()) return false;
      const identity = privateIdentity(), host = captured.runtime?.snapshot();
      const finalIdentity = privateIdentity();
      return fixed() && finalIdentity.scopeKey === identity.scopeKey && finalIdentity.authenticated && identity.authenticated && identity.shell?.hidden !== true && identity.scopeKey === captured.scopeKey
        && (captured.sessionId ? host?.sessionId === captured.sessionId && host.retained === true
          && host.entryKey === captured.artistEntryKey && host.entryUrl === captured.artistEntryUrl : !host?.sessionId);
    };
    const parent = () => {
      if (!base() || artistRequest() !== continuityRequest || state.busy || state.ui?.pendingViewTransition) return false;
      if (captured.sessionId) {
        const host = captured.runtime.snapshot();
        return fixed() && host.sessionId === captured.sessionId && host.actionable === true && artistRequest() === continuityRequest;
      }
      return window.location.href === captured.entryUrl
        && window.history.state?.albumHavenNavigationPosition === captured.entryKey;
    };
    const strict = () => {
      if (phase !== 'idle' || !parent() || !artistListenThroughLaunchIsCurrent(captured.launch)) return false;
      const now = galleryArtistLovedHeaderContext();
      return base() && fixed() && artistRequest() === captured.requestId && captured.view.artist_listen_through_context_ref === captured.stamp
        && now?.kind === captured.kind && (captured.group ? now.sourceSection?.group === captured.group
          && captured.group.artist_listen_through_launch === captured.launch
          : captured.view.artist_page === captured.page && captured.page.artist_listen_through_launch === captured.launch);
    };
    const ownerCurrent = () => {
      if (!base()) return false;
      if (phase === 'idle') return strict();
      if (phase === 'recovery') return parent() && (!child || safeArtistCheck(child.isCurrent));
      if (phase === 'child') return artistRequest() === continuityRequest && (!child || safeArtistCheck(child.isOwnerCurrent))
        && (!nativeForm || activeAppFormDialog === nativeForm || nativeForm.isCurrentContext());
      if (phase === 'opening') {
        if (!attempt || attempt.retired) return false;
        // A reserved origin stays observable during the native onStart midpoint;
        // only offerRequest can make the new request actionable for response use.
        return attempt.requestId === null || artistRequest() === attempt.requestId;
      }
      return false;
    };
    function retire(reason = 'disposed') {
      if (phase === 'retired') return;
      phase = 'retired';
      // Ordinary pre-ack presentation departure does not revoke independently
      // registered response evidence. Explicit dismissal and acknowledged
      // retirement still require a fresh response before another Create.
      if (acknowledged || !['cancelled', 'replaced'].includes(reason)) retiredArtistLaunches.add(captured.launch);
      if (attempt) {attempt.retired = true; attempt.retiredReason = reason;}
      child?.release(); child = null;
      const ownedForm = form, ownedNative = nativeForm; form = null; nativeForm = null;
      if (artistOrigin === origin) artistOrigin = null;
      if (confirmation?.artistOrigin === origin) {
        if (activeAppConfirmDialog?.promise === confirmation.promise) activeAppConfirmDialog.cancel({restoreFocus: false});
        confirmation = null;
      }
      if (ownedNative && activeAppFormDialog === ownedNative) (ownedForm || ownedNative).close(null, {force: true, restoreFocus: false, returnToParent: false});
      notifyArtistCreation();
    }
    function setPhase(next) {if (phase !== next && phase !== 'retired') {phase = next; notifyArtistCreation();}}
    function openForm(options = {}) {
      if (!strict() || activeAppFormDialog || typeof openReactFormDialog !== 'function') return false;
      child = captured.runtime?.captureChildPresentation(() => base()) || null;
      if (captured.sessionId && (!child || child.sessionId !== captured.sessionId || !safeArtistCheck(child.isCurrent))) {child?.release(); child = null; return false;}
      // Reserve before any native mount callback can re-enter this facade.
      phase = 'child';
      try {
        form = openReactFormDialog({...options,
          onMount(host, close) {
            nativeForm = activeAppFormDialog;
            if (!ownerCurrent()) return;
            options.onMount?.(host, close);
          },
          retainParentView: () => ownerCurrent() && (!nativeForm || nativeForm.isCurrentContext()),
          onClose(host, closeOptions) {
            if (phase !== 'opening') retire('cancelled');
            options.onClose?.(host, closeOptions);
          }}, () => ownerCurrent());
        if (!ownerCurrent()) {retire(); return false;}
        nativeForm = activeAppFormDialog;
        const result = form; notifyArtistCreation();
        if (!ownerCurrent()) {retire(); return false;}
        return result;
      } catch {retire(); return false;}
    }
    async function confirmArtist(message, options = {}) {
      if (phase !== 'child' || !ownerCurrent() || !nativeForm || activeAppFormDialog !== nativeForm || activeAppConfirmDialog) return false;
      const pending = {artistOrigin: origin, scopeKey: captured.scopeKey, viewVersion,
        promise: showAppConfirmDialog({title: options.title || 'Discard Listen-through changes', message,
          acceptLabel: options.acceptLabel || 'Discard', danger: options.danger !== false})};
      confirmation = pending;
      try {return await pending.promise === true && confirmation === pending && phase === 'child' && ownerCurrent()
        && activeAppFormDialog === nativeForm;} finally {if (confirmation === pending) confirmation = null;}
    }
    const receiptCopy = value => value && value.action === 'create'
      && typeof value.request_key === 'string' && value.request_key.length === 36 && uuid(value.request_key)
      && typeof value.top_ref === 'string' && value.top_ref.length === 36 && uuid(value.top_ref)
      && typeof value.revision === 'string' && value.revision.length <= 19 && /^[1-9][0-9]*$/.test(value.revision)
      && String(BigInt(value.revision)) === value.revision && BigInt(value.revision) <= 9223372036854775807n
      ? Object.freeze({action: 'create', request_key: value.request_key, top_ref: value.top_ref, revision: value.revision}) : null;
    async function openCreatedTop(value, options = {}) {
      const receipt = receiptCopy(value), startingPhase = phase;
      if (!receipt || !['child', 'recovery'].includes(phase) || !ownerCurrent()
        || !safeArtistCheck(options.isCurrent) || phase !== startingPhase || !ownerCurrent()) return false;
      if (acknowledged && Object.keys(acknowledged).some(key => acknowledged[key] !== receipt[key])) return false;
      if (!acknowledged) acknowledged = receipt;
      const operation = {requestId: null, retired: false, offered: false}; attempt = operation;
      const owns = () => attempt === operation && !operation.retired && phase === 'opening' && base();
      const beforeDispatch = () => owns() && artistRequest() === continuityRequest
        && (!child || safeArtistCheck(child.isOwnerCurrent));
      const currentAttempt = () => owns() && (operation.requestId === null ? beforeDispatch() : artistRequest() === operation.requestId);
      const handoff = {
        offerRequest(requestId) {
          if (operation.offered) {operation.retired = true; return false;}
          operation.offered = true;
          if (!Number.isSafeInteger(requestId) || requestId <= continuityRequest || !owns() || artistRequest() !== requestId) return false;
          operation.requestId = requestId;
          return currentAttempt();
        },
        isCurrent: currentAttempt,
        retire() {operation.retired = true;},
      };
      setPhase('opening');
      if (!beforeDispatch()) {retire(); return false;}
      let settled = false;
      try {
        const opened = await navigateOwned({top_ref: acknowledged.top_ref, isCurrent: currentAttempt,
          expectedViewRequestId: continuityRequest,
          onSettled(result) {
            if (settled || operation.requestId === null || artistRequest() !== operation.requestId) return;
            // Applying the accepted Top legitimately replaces the source view
            // before native settlement. Only that native success may complete
            // an automatically replaced origin; explicit retirement stays inert.
            if (result.opened && (!operation.retired || operation.retiredReason === 'replaced')
              && privateIdentity().scopeKey === captured.scopeKey) {
              settled = true;
              retire();
              try {options.onSettled?.({...result, recoverable: false});} catch { /* Observers cannot change navigation. */ }
              return;
            }
            if (!owns()) return;
            settled = true;
            const terminal = () => !state.busy && !state.ui.activeViewRequestController && !state.ui.activeViewRequestUrl
              && !state.ui.pendingViewRequest && !state.ui.pendingViewTransition && artistRequest() === operation.requestId;
            let recoverable = result.error?.name !== 'AbortError' && terminal() && base();
            if (recoverable && captured.sessionId) {
              const host = captured.runtime.snapshot();
              recoverable = host.sessionId === captured.sessionId && host.actionable === true && terminal() && base();
            }
            if (recoverable) {
              continuityRequest = operation.requestId;
              child?.release(); child = captured.runtime?.captureChildPresentation(() => base()) || null;
              recoverable = (!captured.sessionId || child?.sessionId === captured.sessionId && safeArtistCheck(child.isCurrent))
                && terminal() && base();
            }
            operation.retired = true; attempt = null; form = null; nativeForm = null;
            if (recoverable) setPhase('recovery'); else retire();
            try {options.onSettled?.({...result, recoverable: recoverable && phase === 'recovery' && ownerCurrent()});}
            catch { /* Observers cannot change the sealed receipt. */ }
          }}, handoff);
        if (opened) {retire(); return true;}
        if (!settled && phase !== 'retired' && attempt === operation) {
          // A veto leaves the same native editor owned. A dispatched failure
          // without genuine terminal settlement cannot expose Open recovery.
          operation.retired = true; attempt = null;
          if (!operation.offered && activeAppFormDialog === nativeForm && base()) setPhase('child'); else retire();
        }
        return false;
      } catch {if (attempt === operation) retire(); return false;}
    }
    origin = Object.freeze({headerRoot: captured.header, artistLabel: captured.launch.artist_ref,
      artistScope: Object.freeze({...captured.launch.artist_scope}), scopeKey: captured.scopeKey,
      phase: () => phase, canCreate: () => safeArtistCheck(strict), isCurrent: () => safeArtistCheck(strict),
      isOwnerCurrent: () => safeArtistCheck(ownerCurrent), openForm, confirm: confirmArtist, openCreatedTop, dispose: () => retire()});
    return {origin, current: ownerCurrent, retire};
  }
  let artistLease = null;
  function queueArtistHistoryObservation() {
    if (artistHistoryQueued) return;
    artistHistoryQueued = true;
    Promise.resolve().then(() => {
      artistHistoryQueued = false;
      syncArtistCreation();
    });
  }
  function observeTopHistory() {
    // Native history has advanced before the mobile owner reconciles its live
    // child chain. Keep Top state current, but use its existing snapshot queue
    // so consumers cannot take a non-passive Artist snapshot at this midpoint.
    artistHistoryDepth++;
    try {snapshot();}
    finally {
      artistHistoryDepth--;
      queueArtistHistoryObservation();
    }
  }
  function syncArtistCreation() {
    if (artistHistoryDepth) return artistOrigin;
    if (artistSyncing) return artistOrigin;
    artistSyncing = true;
    try {
      const runtime = window.AlbumHavenArtistPageRuntime;
      if (runtime !== artistRuntime) {
        releaseArtistRuntime?.(); artistRuntime = runtime;
        releaseArtistRuntime = runtime?.subscribe?.(() => syncArtistCreation()) || null;
      }
      if (artistOrigin && !safeArtistCheck(artistLease?.current)) artistLease.retire('replaced');
      if (!artistOrigin) {
        const admission = artistAdmission();
        if (admission) {
          const lease = createArtistOrigin(admission); artistLease = lease; artistOrigin = lease.origin;
          if (!safeArtistCheck(lease.current)) lease.origin.dispose(); else notifyArtistCreation();
        }
      }
      return artistOrigin;
    } finally {artistSyncing = false;}
  }
  const artistCreation = Object.freeze({snapshot: syncArtistCreation, subscribe(listener) {
    artistListeners.add(listener); return () => artistListeners.delete(listener);
  }});

  const components = window.AlbumHavenHomeRuntime;
  PrivateUITransport.subscribe(sync);
  window.addEventListener('popstate', observeTopHistory);
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
    artistCreation,
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
    artistSeparatorHtml: options => buildFamilyArtistHeaderHtml(options),
    galleryRatingHtml: options => buildGalleryRatingHtml(options),
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
function syncAlbumTopArtistCreationContext() {return AlbumTopsRuntime.artistCreation.snapshot();}
function syncAlbumTopsRuntime() {AlbumTopsRuntime.sync();}
window.AlbumHavenAlbumTopsRuntime = AlbumTopsRuntime;
window.dispatchEvent(new Event('albumhaven:album-tops-runtime-ready'));
