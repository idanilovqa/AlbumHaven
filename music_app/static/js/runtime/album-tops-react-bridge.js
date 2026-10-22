/* Native shell/navigation adapter. Top data never enters gallery state/history. */
const AlbumTopsRuntime = (() => {
  const listeners = new Set();
  const pendingListeners = new Set();
  const artistListeners = new Set(), retiredArtistLaunches = new WeakSet();
  let artistOrigin = null, artistSyncing = false, artistNotifying = false, artistNotifyAgain = false;
  let artistRuntime = null, releaseArtistRuntime = null;
  let artistHistoryDepth = 0, artistHistoryQueued = false;
  let snapshotDepth = 0, notificationQueued = false;
  let sampleSuspension = null;
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
  function isCurrentSampleScope(scopeKey) {
    if (!current || scopeKey !== current.scopeKey || state.view !== lastView) return false;
    const host = document.getElementById('album-tops-root'), shell = document.getElementById('app-shell');
    if (!host?.isConnected || !shell || shell.hidden || !shell.dataset?.nativeAccountId || !shell.dataset?.nativeLibraryId) return false;
    const transportGeneration = PrivateUITransport.peekGeneration();
    return transportGeneration !== null && JSON.stringify([shell.dataset.nativeAccountId || '', shell.dataset.nativeLibraryId || '',
      shell.dataset.privateUiContext || '', transportGeneration]) === scopeKey;
  }
  const draftCurrent = owner => {
    const identity = privateIdentity();
    try {return Boolean(owner && draftNavigation === owner && identity.authenticated && identity.scopeKey === owner.scopeKey
      && identity.shell?.hidden !== true && document.getElementById('album-tops-root')?.isConnected
      && state.view === owner.sourceView && owner.isCurrent() === true);} catch {return false;}
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
  function samplePresentationCurrent(owner) {
    const identity = privateIdentity();
    return Boolean(owner && owner.host.isConnected && document.getElementById('album-tops-root') === owner.host
      && identity.authenticated && identity.scopeKey === owner.scopeKey && !identity.shell?.hidden
      && state.view === owner.view && (!owner.formOwner || activeAppFormDialog === owner.formOwner && owner.formOwner.isCurrentContext()));
  }
  function captureSampleNavigation(formOwner = null, formSurface = null, formHandle = null) {
    const host = document.getElementById('album-tops-root'), identity = privateIdentity();
    if (!host?.isConnected || host.hidden || sampleSuspension || !identity.authenticated || identity.shell?.hidden
      || !current || current.scopeKey !== identity.scopeKey || !current.visible
      || formOwner && (activeAppFormDialog !== formOwner || !formOwner.isCurrentContext() || !formSurface?.isConnected || formSurface.hidden)) return null;
    const owner = {host, scopeKey: identity.scopeKey, view: state.view, formOwner, phase: 'active'};
    const parentRegistration = formOwner ? null : draftNavigation?.unregister || null;
    let used = false;
    return Object.freeze({parentRegistration, presentation: Object.freeze({suspend() {
      if (used || sampleSuspension || !samplePresentationCurrent(owner) || host.hidden) return null;
      const nativePresentation = formOwner ? formHandle?.suspendPresentation?.() : null;
      if (formOwner && (!nativePresentation || typeof nativePresentation.restore !== 'function' || typeof nativePresentation.retire !== 'function')) return null;
      used = true;
      const focus = document.activeElement, nodes = [host];
      const values = nodes.map(node => ({node, hidden:node.hidden, inert:node.inert, aria:node.getAttribute('aria-hidden')}));
      const block = event => {event.preventDefault();event.stopImmediatePropagation();};
      let settled = false;
      const finish = restore => {
        if (settled) return false; settled = true;
        const ownsPresentation = sampleSuspension === owner;
        let valid = ownsPresentation && samplePresentationCurrent(owner);
        if (restore && valid && nativePresentation) valid = nativePresentation.restore() === true;
        if (sampleSuspension === owner) {
          if (restore && valid) sampleSuspension = null;
          else owner.phase = 'retiring';
        }
        for (const {node,hidden,inert,aria} of values) {
          for (const type of ['click','keydown','submit','pointerdown']) node.removeEventListener(type,block,true);
          if (restore && valid) {node.hidden=hidden;node.inert=inert;aria===null?node.removeAttribute('aria-hidden'):node.setAttribute('aria-hidden',aria);}
          else if (ownsPresentation) {
            // Relinquish our flags without revealing the obsolete source.
            if(node.inert===true)node.inert=inert;
            if(node.getAttribute('aria-hidden')==='true')aria===null?node.removeAttribute('aria-hidden'):node.setAttribute('aria-hidden',aria);
          }
        }
        if (restore && valid) {
          sync(); if(focus?.isConnected)focus.focus?.({preventScroll:true}); return true;
        }
        try {
          if(nativePresentation){nativePresentation.retire();formHandle.close(null,{force:true,restoreFocus:false,returnToParent:false});}
          return false;
        } finally {
          if (sampleSuspension === owner) owner.phase = 'retired';
        }
      };
      owner.retire = () => finish(false); sampleSuspension = owner;
      for(const {node} of values){node.hidden=true;node.inert=true;node.setAttribute('aria-hidden','true');for(const type of ['click','keydown','submit','pointerdown'])node.addEventListener(type,block,true);}
      sync(); return Object.freeze({restore:()=>finish(true),retire:()=>finish(false)});
    }})});
  }
  function captureSampleOriginNavigation() {return captureSampleNavigation();}
  function sync() {
    const {shell, scopeKey, authenticated} = privateIdentity(), host = document.getElementById('album-tops-root');
    if (sampleSuspension?.phase === 'active' && !samplePresentationCurrent(sampleSuspension)) sampleSuspension.retire();
    // A spent source suppresses only its original presentation, including
    // reentrant native cleanup before the accepted destination is installed.
    if (sampleSuspension && sampleSuspension.phase !== 'active'
      && (sampleSuspension.host !== host || sampleSuspension.view !== state.view)) sampleSuspension = null;
    const sampleSuspended = Boolean(sampleSuspension);
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
    const next = {scopeKey, authenticated, inLibrary, active, sampleSuspended, visible: Boolean(host && active && !state.ui?.pendingViewTransition && !sampleSuspended),
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

  // One image owner survives Share/view remounts. No replacement factory can
  // bypass a closing renderer, preparation or preview-decoder barrier.
  let imageCoordinator = null, imageCoordinatorAttempted = false, imageRuntimeClosed = false, imageRuntimeClosing = null;
  const imageAccessOwners = new Set();
  const imageColorOwners = new WeakMap();
  const imageError = code => Object.assign(new Error('Album Top image export is unavailable.'), {code});
  const imageOpaque = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
  const imageFreeze = value => {
    if (value && typeof value === 'object') {for (const child of Object.values(value)) imageFreeze(child); Object.freeze(value);}
    return value;
  };
  function createImageAccess(args) {
    const {controller, providers, attribution, onRetired} = args || {};
    if (imageRuntimeClosed || !controller || typeof controller.getSnapshot !== 'function' || typeof controller.subscribe !== 'function'
      || !providers || typeof providers.resolveNativeAlbum !== 'function' || typeof attribution !== 'string' || !attribution.trim()
      || typeof onRetired !== 'function') throw imageError('unavailable');
    let disposed = false, checking = false;
    const captures = new WeakMap(), liveCaptures = new Set(), ratingResults = new WeakMap(), liveResults = new Set();
    const releases = [];
    function releaseResult(result) {
      const receipt = ratingResults.get(result);
      if (!receipt || receipt.released) return;
      receipt.released = true; receipt.callback = null; liveResults.delete(receipt);
      for (const lease of receipt.leases) {try {lease.release();} catch { /* All remaining leases still release. */ }}
      receipt.leases.length = 0; receipt.values.length = 0;
    }
    function retire(owner, reason = 'source_retired') {
      if (!owner || owner.retired) return;
      owner.retired = true; liveCaptures.delete(owner);
      const callbacks = [];
      for (const receipt of [...liveResults]) if (receipt.owner === owner) {
        if (receipt.callback) callbacks.push(receipt.callback);
        releaseResult(receipt.result);
      }
      for (const task of owner.tasks) {
        task.abort.abort();
        for (const lease of task.leases) {try {lease.release();} catch { /* Continue cleanup. */ }}
        task.leases.length = 0;
      }
      owner.detail = null; owner.items = null; owner.members = null; owner.scope = null;
      try {onRetired(owner.capture, reason);} catch { /* Retirement cannot be undone by presentation. */ }
      for (const callback of callbacks) {try {callback();} catch { /* Notify every retired watcher. */ }}
    }
    function currentCapture(capture) {
      const owner = captures.get(capture);
      if (!owner || owner.retired || disposed || imageRuntimeClosed) return false;
      let valid = false;
      try {
        const value = controller.getSnapshot(), shell = snapshot(), detail = owner.detail;
        valid = runtimeAlbumPreferenceScopeIsCurrent(owner.scope)
          && value.scopeKey === owner.binding.scopeKey && value.detail?.status === 'ready' && value.detail.refreshing !== true
          && value.detail.data === detail && value.directory?.status !== 'denied' && value.selectedTopRef === owner.binding.topRef
          && detail.top_ref === owner.binding.topRef && String(detail.revision) === owner.binding.revision
          && detail.title === owner.title && detail.description === owner.description
          && detail.allowed_actions?.can_read === true && (detail.next_cursor === undefined || detail.next_cursor === null)
          && value.mutation?.refreshing !== true && !['loading', 'uncertain'].includes(value.mutation?.status)
          && shell.visible === true && shell.authenticated === true && shell.scopeKey === owner.binding.scopeKey
          && shell.topRef === owner.binding.topRef && shell.viewVersion === owner.viewVersion && shell.viewRequestId === owner.viewRequestId
          && detail.items === owner.items && detail.items.length === owner.members.length
          && owner.members.every((member, index) => {
            const row = detail.items[index], native = row?.native_album;
            return row === member.row && row.item_ref === member.itemRef && row.album_ref === member.albumRef
              && row.title === member.title && row.artist === member.artist && row.year === member.year
              && row.source_kind === member.sourceKind && native === member.native
              && (native == null || native.inventory_album_ref === member.inventoryRef && native.artwork_url === member.url
                && native.allowed_actions?.can_view_details === true);
          });
        // scope/currentness readers can synchronously notify and retire this owner.
        valid = valid && !owner.retired && !disposed;
      } catch {valid = false;}
      if (!valid) retire(owner);
      return valid;
    }
    function checkCaptures() {
      if (checking || disposed) return;
      checking = true;
      try {for (const owner of [...liveCaptures]) currentCapture(owner.capture);}
      finally {checking = false;}
    }
    function capture({sourceKey} = {}) {
      if (disposed || imageRuntimeClosed || !imageOpaque(sourceKey)) return null;
      try {
        const value = controller.getSnapshot(), shell = snapshot(), detail = value.detail?.data;
        const scope = captureRuntimeAlbumPreferenceScope();
        if (!scope || !runtimeAlbumPreferenceScopeIsCurrent(scope) || !detail || value.detail.status !== 'ready'
          || value.detail.refreshing === true || value.directory?.status === 'denied' || detail.allowed_actions?.can_read !== true
          || value.mutation?.refreshing === true || ['loading', 'uncertain'].includes(value.mutation?.status)
          || !shell.visible || !shell.authenticated || shell.scopeKey !== value.scopeKey || shell.topRef !== detail.top_ref
          || value.selectedTopRef !== detail.top_ref || !imageOpaque(detail.top_ref) || !imageOpaque(String(detail.revision))
          || !Array.isArray(detail.items) || detail.items.length > 5000 || detail.next_cursor != null
          || typeof detail.title !== 'string' || typeof detail.description !== 'string') return null;
        const members = [], items = [], memberRefs = new Set(), albumRefs = new Set();
        for (let index = 0; index < detail.items.length; index++) {
          if (!Object.hasOwn(detail.items, index)) return null;
          const row = detail.items[index];
          if (!row || !imageOpaque(row.item_ref, 256) || !imageOpaque(row.album_ref, 256)
            || memberRefs.has(row.item_ref) || albumRefs.has(row.album_ref) || typeof row.title !== 'string' || typeof row.artist !== 'string'
            || !(row.year === null || Number.isInteger(row.year) && row.year >= 1 && row.year <= 9999)) return null;
          memberRefs.add(row.item_ref); albumRefs.add(row.album_ref);
          const native = row.native_album;
          if (native != null) {
            const ref = native.inventory_album_ref, match = typeof ref === 'string' && /^inventory-album:([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(ref);
            if (!match || !albumTopImageInventoryReference(ref) || match[1] !== scope.library || row.source_kind === 'remote_summary'
              || native.allowed_actions?.can_view_details !== true
              || native.artwork_url !== null && native.artwork_url !== '/library/album-artwork/' + ref) return null;
          }
          members.push({row, itemRef: row.item_ref, albumRef: row.album_ref, title: row.title, artist: row.artist, year: row.year,
            sourceKind: row.source_kind, native, inventoryRef: native?.inventory_album_ref ?? null, url: native?.artwork_url ?? null});
          items.push({item_ref: row.item_ref, album_ref: row.album_ref, title: row.title, artist: row.artist, year: row.year});
        }
        const binding = {scopeKey: value.scopeKey, topRef: detail.top_ref, revision: String(detail.revision), sourceKey};
        const token = imageFreeze({source: {binding, complete: true, total: items.length, title: detail.title,
          description: detail.description, attribution, items}});
        const owner = {capture: token, binding: token.source.binding, detail, title: detail.title, description: detail.description,
          items: detail.items, members, scope,
          viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId, retired: false, tasks: new Set()};
        captures.set(token, owner); liveCaptures.add(owner);
        return currentCapture(token) ? token : null;
      } catch {return null;}
    }
    async function readOwnRatings(token, {signal} = {}) {
      const owner = captures.get(token);
      if (!owner || !currentCapture(token)) throw imageError('source_retired');
      const task = {abort: new AbortController(), leases: [], values: []}; owner.tasks.add(task);
      const abort = () => task.abort.abort(); signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
      const live = () => !task.abort.signal.aborted && currentCapture(token);
      const check = () => {if (!live()) throw imageError('source_retired');};
      let result = null;
      try {
        const members = owner.members;
        for (const member of members) {
          check();
          if (!member.inventoryRef || member.sourceKind === 'remote_summary') throw imageError('own_ratings_unavailable');
          const source = Object.freeze({top_ref: owner.binding.topRef, revision: owner.binding.revision,
            item_ref: member.itemRef, album_ref: member.albumRef, inventory_album_ref: member.inventoryRef});
          const resolved = await providers.resolveNativeAlbum(source, {scopeKey: owner.binding.scopeKey, signal: task.abort.signal, isCurrent: live});
          check();
          if (!resolved || Object.keys(source).some(key => resolved[key] !== source[key])
            || typeof resolved.native_target?.album_ref !== 'string' || !resolved.native_target.album_ref
            || resolved.native_target.allowed_actions?.can_view_details !== true || resolved.native_target.allowed_actions?.can_play_album !== false) {
            throw imageError('own_ratings_unavailable');
          }
          let admitted = null;
          const album = await fetchTrackModalAlbumDetails(resolved.native_target.album_ref, {
            signal: task.abort.signal, isCurrent: live,
            ownPreferenceObservation: {inventoryAlbumRef: member.inventoryRef,
              onAdmitted(lease) {
                admitted = lease; task.leases.push(lease);
                if (!live()) {lease.release(); throw imageError('source_retired');}
              },
              onChange() {retire(owner, 'own_ratings_unavailable');},
            },
          });
          check();
          const observed = admitted?.read(), preference = runtimeAlbumPreferenceForAlbum(album, owner.scope);
          if (!observed || !preference || album?.read_only_subject || album?.source_readable === false || album?.allowed_actions?.can_read === false
            || String(album.key || album.album_ref || '') !== resolved.native_target.album_ref
            || preference.taste_state !== 'available' || preference.album_ref !== member.inventoryRef
            || observed.albumRef !== member.inventoryRef || observed.rating !== preference.rating
            || observed.preferenceRevision !== preference.preference_revision || observed.tasteState !== 'available') {
            throw imageError('own_ratings_unavailable');
          }
          task.values.push(Object.freeze({itemRef: member.itemRef, albumRef: member.albumRef, inventoryRef: member.inventoryRef,
            rating: observed.rating, revision: observed.preferenceRevision, tasteState: observed.tasteState}));
        }
        check();
        if (task.leases.length !== task.values.length || task.leases.some((lease, index) => {
          const value = lease.read(), baseline = task.values[index];
          return !value || value.albumRef !== baseline.inventoryRef || value.rating !== baseline.rating || value.preferenceRevision !== baseline.revision;
        })) throw imageError('own_ratings_unavailable');
        result = imageFreeze({binding: {...owner.binding}, items: task.values.map(value => ({item_ref: value.itemRef, rating: value.rating}))});
        const receipt = {owner, result, leases: task.leases.splice(0), values: task.values.splice(0), callback: null, released: false};
        ratingResults.set(result, receipt); liveResults.add(receipt);
        check(); return result;
      } catch (error) {
        if (result) releaseResult(result);
        if (error?.code === 'source_retired' || !currentCapture(token)) throw imageError('source_retired');
        throw imageError('own_ratings_unavailable');
      } finally {
        signal?.removeEventListener('abort', abort); owner.tasks.delete(task);
        for (const lease of task.leases) {try {lease.release();} catch { /* All remaining observations release. */ }}
        task.leases.length = 0; task.values.length = 0;
      }
    }
    function receiptCurrent(receipt) {
      if (!receipt || receipt.released || !currentCapture(receipt.owner.capture)) return false;
      for (let index = 0; index < receipt.leases.length; index++) {
        const value = receipt.leases[index].read(), baseline = receipt.values[index];
        if (!value || value.albumRef !== baseline.inventoryRef || value.rating !== baseline.rating || value.preferenceRevision !== baseline.revision) {
          retire(receipt.owner, 'own_ratings_unavailable'); return false;
        }
      }
      return !receipt.released;
    }
    function watchOwnRatings(token, result, onChange) {
      const receipt = ratingResults.get(result);
      if (typeof onChange !== 'function' || !receipt || receipt.owner.capture !== token || receipt.callback || !receiptCurrent(receipt)) {
        throw imageError('own_ratings_unavailable');
      }
      receipt.callback = onChange;
      return () => releaseResult(result);
    }
    function sameOwnRatings(previous, next) {
      const a = ratingResults.get(previous), b = ratingResults.get(next);
      // This comparator reads only private captured primitives and committed
      // retirement flags. Native lifetime/observation owners retire these flags;
      // callers separately prove current capture before using an export result.
      if (!a || !b || a.released || b.released || disposed || imageRuntimeClosed || a.owner.retired || b.owner.retired
        || a.owner !== b.owner || a.values.length !== b.values.length) return false;
      return a.values.every((value, index) => Object.keys(value).every(key => value[key] === b.values[index][key]));
    }
    function admittedResource(token, request, kind) {
      const owner = captures.get(token);
      if (!owner || !currentCapture(token)) throw imageError('source_retired');
      if (!request || request.kind !== kind || request.maxEncodedBytes !== 20971520 || request.maxWidth !== 2048 || request.maxHeight !== 2048
        || ['scopeKey', 'topRef', 'revision', 'sourceKey'].some(key => request.binding?.[key] !== owner.binding[key])
        || request.signal?.aborted) throw imageError('resource_unavailable');
      if (kind === 'brand') {
        if (request.itemRef !== null || request.albumRef !== null) throw imageError('resource_unavailable');
        return {owner, member: null};
      }
      const member = owner.members.find(value => value.itemRef === request.itemRef && value.albumRef === request.albumRef);
      if (!member || !member.inventoryRef || member.url !== '/library/album-artwork/' + member.inventoryRef) throw imageError('resource_unavailable');
      return {owner, member};
    }
    async function prepareCover(token, request) {
      const {owner, member} = admittedResource(token, request, 'cover'), scope = owner.scope;
      const prepared = await scope.transport.requestAlbumTopImagePng({inventoryAlbumRef: member.inventoryRef, signal: request.signal,
        expected: scope.context, expectedGeneration: scope.generation, isCurrent: () => currentCapture(token), maxEncodedBytes: 20971520});
      if (request.signal?.aborted || !currentCapture(token)) {prepared.release(); throw imageError('source_retired');}
      return prepared;
    }
    async function prepareBrand(token, request) {
      admittedResource(token, request, 'brand');
      const check = () => {if (request.signal?.aborted || !currentCapture(token)) throw imageError('source_retired');};
      check(); let response;
      try {response = await fetch('/static/images/album-haven-cloud-vinyl.png', {method: 'GET', signal: request.signal,
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: {Accept: 'image/png'}});}
      catch {check(); throw imageError('resource_unavailable');}
      const prepared = await prepareAlbumTopImagePngResponse(response, check);
      try {check();} catch (error) {prepared.release(); throw error;}
      return prepared;
    }
    const access = Object.freeze({capture, isCurrent: currentCapture, readOwnRatings, watchOwnRatings,
      releaseOwnRatings: releaseResult, sameOwnRatings, prepareCover, prepareBrand,
      dispose() {
        if (disposed) return; disposed = true; imageAccessOwners.delete(access);
        for (const release of releases.splice(0)) {try {release();} catch { /* All subscriptions must release. */ }}
        for (const owner of [...liveCaptures]) retire(owner);
      }});
    try {
      releases.push(controller.subscribe(checkCaptures));
      listeners.add(checkCaptures); releases.push(() => {listeners.delete(checkCaptures); pendingListeners.delete(checkCaptures);});
      const transport = window.AlbumHavenPrivateUITransport;
      if (!transport || typeof transport.subscribe !== 'function') throw imageError('unavailable');
      releases.push(transport.subscribe(checkCaptures));
      imageAccessOwners.add(access);
    } catch {access.dispose(); throw imageError('unavailable');}
    return access;
  }
  const imageExport = Object.freeze({
    coordinator(factory) {
      if (imageRuntimeClosed) throw imageError('unavailable');
      if (!imageCoordinatorAttempted) {
        imageCoordinatorAttempted = true;
        try {
          const value = typeof factory === 'function' ? factory() : null;
          if (!value || typeof value.open !== 'function' || typeof value.read !== 'function' || typeof value.dispose !== 'function') throw imageError('unavailable');
          imageCoordinator = value;
        } catch {throw imageError('unavailable');}
      }
      if (!imageCoordinator) throw imageError('unavailable');
      return imageCoordinator;
    },
    createAccess: createImageAccess,
  });
  function closeImageRuntime() {
    if (imageRuntimeClosed) return imageRuntimeClosing;
    imageRuntimeClosed = true;
    for (const access of [...imageAccessOwners]) access.dispose();
    try {imageRuntimeClosing = Promise.resolve(imageCoordinator?.dispose());}
    catch {imageRuntimeClosing = new Promise(() => {});}
    return imageRuntimeClosing;
  }
  window.addEventListener('pagehide', event => {if (event.persisted !== true) closeImageRuntime();});

  const components = window.AlbumHavenHomeRuntime;
  PrivateUITransport.subscribe(sync);
  window.addEventListener('popstate', observeTopHistory);
  window.addEventListener('albumhaven:library-sidebar-change', sync);
  document.addEventListener('album-haven:preferences-sync', sync);
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') new MutationObserver(sync).observe(shell,
    {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  return Object.freeze({
    captureSampleOriginNavigation,
    sampleLibraryRef: () => TrackActionsRuntime.scope().library,
    openSamplePlaylist: input => window.AlbumHavenPlaylistUI?.openSamplePlaylist(input) ?? false,
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
    artistCreation, imageExport,
    bindImageColorSurface(surface, anchor, close) {
      let disposed = false;
      if (typeof close !== 'function' || !activateTriggerSurface(surface, close, {anchor})) throw imageError('unavailable');
      try {syncTriggerAnchor(surface, anchor);} catch (error) {clearTriggerAnchor(surface); throw error;}
      const owner = {anchor, form: activeAppFormDialog}; imageColorOwners.set(surface, owner);
      return () => {
        if (disposed) return; disposed = true;
        if (imageColorOwners.get(surface) !== owner) return;
        imageColorOwners.delete(surface); clearTriggerAnchor(surface);
      };
    },
    imageColorSurfaceCurrent(surface, anchor) {
      const owner = imageColorOwners.get(surface);
      return owner?.anchor === anchor && owner.form === activeAppFormDialog
        && activeTriggerSurface?.surface === surface && isTriggerSurfaceAnchorCurrent(surface, anchor)
        && !activeAppConfirmDialog && (!activeAppFormDialog || document.getElementById('app-form-modal')?.contains(anchor));
    },
    snapshot, sync, isCurrentSampleScope, subscribe(listener) {
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
      const surface = document.getElementById('app-form-modal');
      options.onSampleOriginNavigationCapture?.(() => captureSampleNavigation(formOwner, surface, form));
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
