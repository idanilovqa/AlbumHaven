/* Admitted Artist presentation. The existing view, scope, navigation and grid
   owners retain data authority; this bridge never admits URL intent as data. */
const ArtistPageRuntime = (() => {
  const listeners = new Set();
  let session = null, attachment = null, serial = 0, reconciliation = 0, disposed = false, notifying = false, notifyAgain = false;
  let sheetReplay = null;
  const empty = Object.freeze({status: 'inactive', visible: false, actionable: false, sessionId: null});
  const text = value => typeof value === 'string' ? value.trim() : '';
  const groups = value => Array.isArray(value) ? value : [];
  const position = () => Number.isSafeInteger(window.history.state?.albumHavenNavigationPosition)
    ? window.history.state.albumHavenNavigationPosition : null;
  const url = value => {try {const result = new URL(value, window.location.href); result.hash = ''; result.search = result.searchParams.toString(); return result.href;} catch {return '';}};
  const allowed = check => {try {return check?.() === true;} catch {return false;}};
  const installed = () => !disposed && window.AlbumHavenArtistPageRuntime === api;
  const scopeCurrent = owner => Boolean(owner && installed() && session === owner && galleryReadScopeIsCurrent(owner.scope) && installed() && session === owner);
  const admitted = view => Boolean(view && resolveViewSurface(view) === 'albums' && view.private_search !== true
    && text(view.selected_artist) && view.artist_page?.artist_ref === text(view.selected_artist)
    && view.artist_page.active_page_mode === 'info');
  function notify() {
    if (notifying) {notifyAgain = true; return;}
    notifying = true;
    try {do {notifyAgain = false; for (const listener of [...listeners]) {try {listener();} catch { /* Other owners still receive retirement. */ }}} while (notifyAgain && !disposed);}
    finally {notifying = false;}
  }
  function detach(owned = attachment) {
    if (!owned) return;
    if (attachment === owned) attachment = null;
    // The grid must dock its viewport before native disclosure disposal.
    owned.lease?.release();
    if (attachment?.host !== owned.host) owned.host.classList.remove('is-artist-page-active');
  }
  function retire(owner = session) {
    if (!owner || session !== owner) return false;
    session = null;
    if (typeof retireMobileArtistSheetFocus === 'function') retireMobileArtistSheetFocus(owner.id, api);
    detach();
    notify();
    return true;
  }
  function facts(view) {
    const primary = groups(view.primary_artist_groups), family = groups(view.family_artist_groups), fallback = groups(view.artist_groups);
    const artist = text(view.selected_artist), actual = [...primary, ...family, ...fallback];
    const infoGroup = [...primary, ...fallback].find(group => group?.artist === artist) || {};
    const image = text(infoGroup.artist_image_url) || text(infoGroup.image_url);
    const info = Object.freeze({artist, summary: text(infoGroup.artist_summary) || text(infoGroup.summary),
      imageUrl: /^\/(?!\/)/.test(image) || /^https:\/\//i.test(image) ? image : '', metadata: '', sourceLabel: ''});
    // A matching name/query cache has no independent scope receipt. Count only
    // actual admitted candidates; panel synthetic placeholders are not facts.
    const candidates = [...groups(view.related_filter_base_primary_groups), ...groups(view.related_filter_base_family_groups), ...actual];
    const panel = getGalleryFamilyPanelGroups();
    const refs = [...new Set([artist, ...groups(view.related_artists).map(text), ...primary.map(group => text(group.artist)),
      ...family.map(group => text(group.artist))].filter(Boolean))];
    const familyMembers = refs.map(artistRef => {
      // The panel helper synthesizes empty placeholders. Only object identity
      // in actual admitted/scope-current candidate groups proves count facts.
      const panelFact = panel.find(group => group?.artist === artistRef && candidates.includes(group));
      const fact = panelFact || actual.find(group => group?.artist === artistRef);
      return Object.freeze({artistRef, label: text(fact?.artist_display) || artistRef,
        ...(fact && Array.isArray(fact.albums) ? {albumCount: fact.albums.length} : {}), artworkHtml: ''});
    });
    return {info, familyMembers: Object.freeze(familyMembers)};
  }
  function pageIdentity(page) {return page?.kind === 'form' ? `form:${page.formToken || ''}` : `${page?.kind || ''}:${page?.albumKey || ''}:${page?.sourcePageToken || ''}:${page?.presentation || ''}:${page?.artistRef || ''}`;}
  function atParentEntry(owner) {
    return !owner.provisional && Boolean(owner.entryUrl)
      && position() === owner.entryKey && url(window.location.href) === owner.entryUrl;
  }
  function liveChildRoot(owner) {
    const root = typeof mobilePageState === 'undefined' ? null : mobilePageState.pages[0];
    if (owner.provisional || !root || root.parentPosition !== owner.entryKey) return false;
    const route = url(root.parentViewUrl);
    // The live mobile owner captures a canonical request route, whereas the
    // browser parent may omit defaults or predate a local display preference.
    // Once bound, an existing child keeps its own route through parent refresh.
    if (owner.childRoot === root && owner.childParentUrl === route) return true;
    if (route !== url(buildUrl(owner.view))) return false;
    owner.childRoot = root; owner.childParentUrl = route;
    return true;
  }
  function ownsChild(owner) {
    if (!liveChildRoot(owner)) return false;
    const pages = mobilePageState.pages;
    const history = window.history.state?.mobilePages;
    // Presentation is reconciled once before its history push. That midpoint
    // is still rooted in this actual parent, not authority supplied by a URL.
    const atParent = atParentEntry(owner);
    return atParent || Array.isArray(history) && pages.length === history.length
      && pages.every((page, index) => pageIdentity(page) === pageIdentity(history[index]));
  }
  function retainedSheetHistory(owner, receipt = undefined) {
    const saved = typeof currentMobileArtistSheetFocus === 'function' ? currentMobileArtistSheetFocus() : null;
    return Boolean(saved && (receipt === undefined || saved === receipt) && owner && !owner.provisional
      && saved.sessionId === owner.id && saved.artistRef === owner.artistRef
      && saved.entryKey === owner.entryKey && saved.parentViewUrl === owner.parentViewUrl
      && owner.view === state.view && !state.busy && !state.ui?.pendingViewTransition
      && owner.requestId === Number(state.ui?.activeViewRequestId || 0) && scopeCurrent(owner)
      && owner.view === state.view && !state.busy && !state.ui?.pendingViewTransition
      && owner.requestId === Number(state.ui?.activeViewRequestId || 0) && currentMobileArtistSheetFocus() === saved);
  }
  function presentation(owner, {passive = false} = {}) {
    if (!installed() || !scopeCurrent(owner)) return 'retired';
    if (state.view !== owner.view || !admitted(state.view) || text(state.view.selected_artist) !== owner.artistRef) return 'retired';
    const returning = typeof mobilePageState === 'undefined' ? null : mobilePageState.formReturn;
    const traversal = typeof mobilePageState === 'undefined' ? null : mobilePageState.formTraversal;
    const presenting = typeof mobilePageState === 'undefined' ? null : mobilePageState.presentationTransition;
    for (const operation of [returning, traversal, presenting]) {
      if (operation?.artistParent?.sessionId === owner.id && allowed(operation.artistParent.isCurrent)) return 'held';
    }
    if (admittedSheetReplay(owner) || sheetReplay?.holdsPresentation?.(owner) === true) return 'held';
    if (ownsChild(owner)) return 'child';
    if (owner.provisional && owner.requestId === Number(state.ui?.activeViewRequestId || 0)) return 'held';
    const direct = atParentEntry(owner);
    // The popstate listener runs before navigation. Hold only its already-owned
    // child or exact saved live receipt for this synchronous handoff.
    if (!direct && passive && (liveChildRoot(owner) || retainedSheetHistory(owner))) return 'held';
    if (!direct || document.getElementById('app-shell')?.hidden === true) return 'retired';
    return state.ui?.pendingViewTransition || owner.requestId !== Number(state.ui?.activeViewRequestId || 0) ? 'held' : 'parent';
  }
  function read(owner, stateOfPresentation) {
    if (!owner || session !== owner) return empty;
    const mounted = attachment?.sessionId === owner.id;
    return Object.freeze({status: owner.unavailable ? 'unavailable' : 'ready', sessionId: owner.id, artistRef: owner.artistRef, mode: 'info',
      entryKey: owner.entryKey, entryUrl: owner.entryUrl, parentViewUrl: owner.parentViewUrl, viewRevision: owner.revision,
      visible: mounted && stateOfPresentation === 'parent', actionable: mounted && stateOfPresentation === 'parent',
      retained: stateOfPresentation !== 'retired', mounted, info: owner.info, familyMembers: owner.familyMembers,
      discography: owner.model, scopeGroups: owner.model.scopeGroups});
  }
  function syncPresentation(options = {}) {
    const owner = session;
    if (!owner) return empty;
    const next = presentation(owner, options);
    if (session !== owner) return empty;
    if (next === 'retired') {retire(owner); return empty;}
    const changed = owner.presentation !== next;
    owner.presentation = next;
    if (attachment?.sessionId === owner.id) {
      attachment.host.inert = next !== 'parent';
      attachment.lease.suspend(next !== 'parent', {discardRows: false});
    }
    if (session !== owner) return empty;
    // This listener precedes the navigation owner. Do not notify subscribers
    // into a non-passive snapshot of the old live chain at this midpoint.
    if (changed && !(options.passive && next === 'held')) notify();
    return read(owner, next);
  }
  function reconcileAdmittedView({view, requestId, revision, isCurrent}) {
    const generation = ++reconciliation;
    const current = () => generation === reconciliation && installed() && allowed(isCurrent)
      && generation === reconciliation && installed() && view === state.view;
    if (!current()) return {requiresGalleryRender: false};
    if (!admitted(view)) return {requiresGalleryRender: retire()};
    const artistRef = text(view.selected_artist), parentViewUrl = url(buildUrl(view));
    const replay = sheetReplay;
    const replayAdmission = replay && replay.current() && replay.request?.id === requestId
      && replay.artistRef === artistRef && replay.parentViewUrl === parentViewUrl;
    const previous = session;
    const sameAdmission = previous?.view === view && previous.requestId === requestId;
    // An actual push gets a fresh provisional session even at the same URL.
    // Reentrant renders of that same admission may retain its provisional or
    // just-committed owner; they are not another browser-history operation.
    const provisional = Boolean(state.ui?.activeViewRequestPush) && !(sameAdmission && !previous.provisional);
    const retained = previous && scopeCurrent(previous) && previous.artistRef === artistRef
      && (provisional ? sameAdmission && previous.provisional && previous.parentViewUrl === parentViewUrl
        : atParentEntry(previous) || ownsChild(previous) || admittedSheetReplay(previous)
          || typeof mobilePageState !== 'undefined' && mobilePageState.formReturn?.artistParent?.sessionId === previous.id
            && allowed(mobilePageState.formReturn.artistParent.isCurrent));
    if (previous && !retained) retire(previous);
    if (!current()) return {requiresGalleryRender: false};
    const scope = retained ? previous.scope : captureGalleryReadScope();
    if (!galleryReadScopeIsCurrent(scope) || !current()) return {requiresGalleryRender: false};
    const supplied = facts(view), model = getFilteredGalleryMainModel();
    if (!galleryReadScopeIsCurrent(scope) || !current()) return {requiresGalleryRender: false};
    const owner = retained ? previous : {id: ++serial, scope, artistRef,
      entryUrl: provisional ? '' : url(window.location.href), entryKey: provisional ? null : position(), presentation: 'held',
      childRoot: null, childParentUrl: ''};
    Object.assign(owner, supplied, {view, requestId, revision, model, parentViewUrl, unavailable: false, provisional});
    session = owner;
    if (replayAdmission && sheetReplay === replay && replay.current() && current()) {
      owner.entryUrl = replay.parentViewUrl; owner.entryKey = replay.parentPosition;
      owner.provisional = false; owner.childRoot = null; owner.childParentUrl = '';
      replay.owner = owner;
      // This receipt comes only from this request's live-controller admission.
      // It can preserve presentation during Gallery's slot-release midpoint,
      // but is not a successful terminal receipt and cannot resolve a replay.
      replay.presentationReceipt = Object.freeze({owner, view, revision, request: replay.request,
        entryKey: owner.entryKey, entryUrl: owner.entryUrl, parentViewUrl: owner.parentViewUrl});
    }
    owner.presentation = presentation(owner);
    if (owner.presentation === 'retired') {retire(owner); return {requiresGalleryRender: current()};}
    notify();
    if (!current() || session !== owner) return {requiresGalleryRender: false};
    return {requiresGalleryRender: true};
  }
  function commitAdmittedNavigation(view, isCurrent, accepted = true) {
    const owner = session;
    const current = () => owner && owner.view === view && allowed(isCurrent)
      && installed() && session === owner && owner.view === state.view && scopeCurrent(owner);
    if (!current()) return false;
    if (!accepted) {retire(owner); return false;}
    // No-history refreshes already captured an actually admitted entry. Only
    // this owned post-commit hook can assign a pushed entry's new position.
    if (!owner.provisional) {syncPresentation(); return current();}
    const committedUrl = url(window.location.href), committedPosition = position();
    if (!current()) return false;
    if (committedUrl !== owner.parentViewUrl || committedUrl !== url(window.location.href)
      || committedPosition !== position()) {retire(owner); return false;}
    owner.entryKey = committedPosition; owner.entryUrl = committedUrl; owner.provisional = false;
    owner.childRoot = null; owner.childParentUrl = '';
    syncPresentation();
    return current();
  }
  function captureRequestSettlement({view, requestId, isCurrent}) {
    const owner = session;
    const entryKey = owner?.entryKey, entryUrl = owner?.entryUrl;
    const sameParent = () => installed() && session === owner && owner?.view === view && state.view === view
      && admitted(view) && text(view.selected_artist) === owner.artistRef && !owner.provisional
      && owner.entryKey === entryKey && owner.entryUrl === entryUrl;
    const ownsOperation = () => Number(state.ui?.activeViewRequestId || 0) === requestId;
    if (!sameParent() || !ownsOperation() || !allowed(isCurrent) || !sameParent()
      || !scopeCurrent(owner) || !sameParent() || !ownsOperation()
      || !(atParentEntry(owner) || ownsChild(owner))) return null;
    return Object.freeze({settle(isCurrentTerminal) {
      const terminal = () => ownsOperation() && !state.busy && state.ui.activeViewRequestController === null
        && state.ui.activeViewRequestUrl === '' && !state.ui.pendingViewRequest && !state.ui.pendingViewTransition;
      const current = () => sameParent() && terminal() && allowed(isCurrentTerminal)
        && sameParent() && terminal() && scopeCurrent(owner) && sameParent() && terminal()
        && (atParentEntry(owner) || ownsChild(owner));
      if (!current()) return false;
      // Only the surviving admission gets this settled request receipt. No
      // response data, URL intent or unrelated entry is admitted here.
      owner.requestId = requestId;
      syncPresentation();
      return current();
    }});
  }
  function attach({host, sections, mountReleaseDisclosure}) {
    const owner = session;
    if (!owner || !scopeCurrent(owner) || host !== document.getElementById('artist-page-root')) return null;
    if (attachment?.sessionId === owner.id && attachment.host === host) return attachment.handle;
    detach();
    if (session !== owner || !scopeCurrent(owner)) return null;
    const mounted = {sessionId: owner.id, host, sections, lease: null, handle: null};
    attachment = mounted;
    const current = () => attachment === mounted && session === owner && scopeCurrent(owner);
    try {
      mounted.lease = virtualGrid.acquireArtistPagePresentation({sessionId: owner.id, panel: sections.discography.slots.panel,
        isCurrent: current, mountReleaseDisclosure, onReleaseToggle: () => {if (current()) updateGalleryMainChrome();}});
      if (!mounted.lease || !current()) throw new Error('Artist grid is unavailable.');
      host.classList.add('is-artist-page-active');
      mounted.handle = {update: options => {if (current()) mounted.lease.update(options);},
        release: () => {if (attachment === mounted) detach(mounted);}};
      syncPresentation();
      return mounted.handle;
    } catch (_error) {
      detach(mounted);
      if (session === owner) {owner.unavailable = true; notify();}
      return null;
    }
  }
  function renderDiscography({model, layoutConfig, options = {}}) {
    const owner = session, mounted = attachment;
    if (options.isCurrentResponse && !allowed(options.isCurrentResponse)) return false;
    if (!owner || !mounted || mounted.sessionId !== owner.id || owner.view !== state.view || !scopeCurrent(owner)) return false;
    owner.model = model; owner.parentViewUrl = url(buildUrl(owner.view));
    const preserve = options.resetScrollForUserArtistSelection !== true;
    virtualGrid.setGroups(model.primaryGroups, model.familyGroups, model.fallbackGroups,
      {...options, preserveScroll: preserve, preserveMountedGalleryChildren: preserve}, layoutConfig);
    if (session === owner && attachment === mounted) notify();
    return true;
  }
  function navigateFamily(artistRef) {
    const snapshot = syncPresentation(), owner = session;
    if (!owner || snapshot.sessionId !== owner.id || !snapshot.actionable || !owner.familyMembers.some(member => member.artistRef === artistRef)) return false;
    const request = {...owner.view, selected_artist: artistRef, page_mode: 'info', all_artists_active: false,
      related_filter_artists: [], primary_filter_active: false};
    delete request.artist_page;
    return fetchAndRender(buildApiUrl(request, {omitSidebar: true}), true);
  }
  function currentContextFor(element) {
    const snapshot = syncPresentation(), owner = session, mounted = attachment;
    if (!owner || snapshot.sessionId !== owner.id || !snapshot.actionable || !mounted
      || mounted.sessionId !== owner.id || !mounted.sections.discography.slots.panel.contains(element)) return null;
    return Object.freeze({sessionId: owner.id, artistRef: owner.artistRef, entryKey: owner.entryKey, entryUrl: owner.entryUrl,
      parentViewUrl: owner.parentViewUrl, header: document.querySelector('[data-gallery-bar-instance="gallery"]'),
      scroll: virtualGrid.scrollEl, opener: element, isCurrent: () => session === owner && syncPresentation().actionable,
      restoreFocus: token => {
        const current = syncPresentation();
        if (session === owner && attachment === mounted && current.sessionId === owner.id && current.actionable) mounted.lease.restoreFocus(token);
      }});
  }
  function sheetMembership(owner, token) {
    if (!scopeCurrent(owner) || attachment?.sessionId !== owner.id || !token) return null;
    const section = virtualGrid.sections.find(item => item.sectionKey === token.sectionKey);
    const album = section?.group?.albums?.find(item => String(getAlbumRequestKey(item)) === token.albumKey
      && getAlbumCardVersionKey(item) === token.versionKey);
    const modelGroups = [...groups(owner.model?.primaryGroups), ...groups(owner.model?.familyGroups), ...groups(owner.model?.fallbackGroups)];
    const admittedAlbum = album && modelGroups.flatMap(group => groups(group?.albums)).find(item =>
      String(getAlbumRequestKey(item)) === token.albumKey && getAlbumCardVersionKey(item) === token.versionKey
      && (!section.artistPageRelease || classifyGalleryReleaseType(item) === section.releaseType));
    return admittedAlbum && scopeCurrent(owner) && attachment?.sessionId === owner.id ? album : null;
  }
  function sheetOrigin(owner, token, focusToken = token) {
    const mounted = attachment, entryKey = owner.entryKey, parentViewUrl = owner.parentViewUrl;
    let active = true;
    const current = () => active && installed() && session === owner && attachment === mounted
      && owner.entryKey === entryKey && scopeCurrent(owner)
      && state.view === owner.view && admitted(owner.view) && Boolean(sheetMembership(owner, token));
    const parent = () => current() && syncPresentation().actionable && current();
    const retained = descriptor => current() && descriptor?.kind === 'album'
      && descriptor.albumKey === token.albumKey && descriptor.presentation === 'artist-discography-sheet'
      && descriptor.artistRef === owner.artistRef && descriptor.parentPosition === entryKey
      && url(descriptor.parentViewUrl) === parentViewUrl
      && (ownsChild(owner) || presentation(owner) === 'held' || atParentEntry(owner)) && current();
    return Object.freeze({sessionId: owner.id, artistRef: owner.artistRef, entryKey, parentViewUrl,
      readHeader() {
        if (!current()) return null;
        const header = document.querySelector('[data-gallery-bar-instance="gallery"]');
        return current() && header?.isConnected ? header : null;
      },
      readScroll: () => current() ? virtualGrid.scrollEl : null,
      isParentCurrent: parent, isRetainedCurrent: retained,
      retarget(album) {
        if (!current()) return null;
        const next = Object.freeze({...token, albumKey: String(getAlbumRequestKey(album) || ''), versionKey: getAlbumCardVersionKey(album)});
        return sheetMembership(owner, next) && current() ? sheetOrigin(owner, next, focusToken) : null;
      },
      restoreFocus() {return parent() && mounted.lease.restoreFocus(focusToken, {preserveViewport: true});},
      captureReturn() {return current() ? Object.freeze({sessionId: owner.id, artistRef: owner.artistRef, entryKey, parentViewUrl,
        token: Object.freeze({...focusToken})}) : null;},
      release() {active = false;},
    });
  }
  function captureAlbumSheetOrigin(element, album) {
    const context = currentContextFor(element), owner = session, mounted = attachment;
    if (!element?.isConnected || element.closest('[hidden],[inert]') || !context || !context.isCurrent()
      || !owner || !mounted || Number(window.innerWidth) > 900
      || typeof getTrackModalPresentationRestrictions === 'function' && getTrackModalPresentationRestrictions()?.can_open_album_page === false) return null;
    const trigger = element.closest?.('[data-album-key]');
    const renderedKey = element.closest?.('[data-virtual-section-key]')?.getAttribute('data-virtual-section-key');
    const section = virtualGrid.sections.find(item => virtualGrid.getRenderedSectionKey(item) === renderedKey);
    const albumKey = String(getAlbumRequestKey(album) || '');
    const versionKey = getAlbumCardVersionKey(album);
    if (!trigger || !(trigger.classList.contains('cover')
      || trigger.classList.contains('album-title-button') && trigger.getAttribute('data-open-tracklist') === '1')
      || trigger.getAttribute('data-album-key') !== albumKey
      || trigger.getAttribute('data-album-version-key') !== versionKey || !section) return null;
    const token = Object.freeze({sessionId: owner.id, albumKey, versionKey, sectionKey: section.sectionKey,
      trigger: trigger.classList.contains('cover') ? 'cover' : 'tracklist'});
    if (!sheetMembership(owner, token) || !context.isCurrent() || session !== owner || attachment !== mounted) return null;
    return sheetOrigin(owner, token);
  }
  function beginAlbumSheetReplay(descriptor, isCurrent, focusReceipt = null) {
    descriptor = typeof normalizeArtistSheetDescriptor === 'function' ? normalizeArtistSheetDescriptor(descriptor) : null;
    if (!installed() || !allowed(isCurrent) || descriptor?.presentation !== 'artist-discography-sheet') return null;
    const pending = {artistRef: descriptor.artistRef, parentViewUrl: url(descriptor.parentViewUrl),
      parentPosition: descriptor.parentPosition, requestId: Number(state.ui?.activeViewRequestId || 0), isCurrent, owner: null,
      scope: captureGalleryReadScope(), request: null, settled: null, current: null,
      historyHref: window.location.href, historyPosition: position(),
      historyPages: JSON.stringify(window.history.state?.mobilePages || []),
      presentationReceipt: null, holdsPresentation: null};
    const owner = session;
    if (owner && scopeCurrent(owner) && owner.artistRef === pending.artistRef
      && owner.entryKey === pending.parentPosition && owner.parentViewUrl === pending.parentViewUrl
      && (liveChildRoot(owner) || atParentEntry(owner) || retainedSheetHistory(owner, focusReceipt))) pending.owner = owner;
    sheetReplay = pending;
    let active = true;
    const baseCurrent = () => active && sheetReplay === pending && installed() && allowed(isCurrent)
      && active && sheetReplay === pending && galleryReadScopeIsCurrent(pending.scope)
      && active && sheetReplay === pending;
    const current = () => {
      if (!baseCurrent()) return false;
      const request = pending.request;
      if (!request) return Number(state.ui?.activeViewRequestId || 0) === pending.requestId;
      if (request.controller.signal.aborted || Number(state.ui?.activeViewRequestId || 0) !== request.id) return false;
      return pending.settled ? state.ui?.activeViewRequestController === null && !state.busy
        : state.ui?.activeViewRequestController === request.controller && state.ui?.activeViewRequestPush !== true;
    };
    pending.current = current;
    pending.holdsPresentation = admittedOwner => {
      const receipt = pending.presentationReceipt;
      if (!receipt || !baseCurrent()) return false;
      const ownsReleasedPresentation = () => active && sheetReplay === pending && installed()
        && pending.presentationReceipt === receipt && !pending.settled
        && pending.owner === admittedOwner && session === admittedOwner && receipt.owner === admittedOwner
        && pending.request === receipt.request && receipt.request !== null
        && !receipt.request.controller.signal.aborted
        && state.ui?.activeViewRequestId === receipt.request.id && admittedOwner.requestId === receipt.request.id
        && state.ui?.activeViewRequestController === null && !state.busy
        && state.ui?.activeViewRequestUrl === '' && state.ui?.activeViewRequestPush === false
        && !state.ui?.pendingViewRequest && !state.ui?.pendingViewTransition
        && admittedOwner.view === receipt.view && state.view === receipt.view && admitted(receipt.view)
        && admittedOwner.revision === receipt.revision && Number(state.ui?.viewStateRevision || 0) === receipt.revision
        && !admittedOwner.provisional && admittedOwner.artistRef === pending.artistRef
        && text(receipt.view.selected_artist) === pending.artistRef
        && admittedOwner.entryKey === receipt.entryKey && receipt.entryKey === pending.parentPosition
        && admittedOwner.entryUrl === receipt.entryUrl && receipt.entryUrl === pending.parentViewUrl
        && admittedOwner.parentViewUrl === receipt.parentViewUrl && receipt.parentViewUrl === pending.parentViewUrl
        && window.location.href === pending.historyHref && position() === pending.historyPosition
        && JSON.stringify(window.history.state?.mobilePages || []) === pending.historyPages;
      // Recheck exact identities after scope/history observers; released slots
      // alone confer no authority. The public current/resolve gates stay strict.
      return ownsReleasedPresentation() && scopeCurrent(admittedOwner)
        && ownsReleasedPresentation() && baseCurrent() && ownsReleasedPresentation();
    };
    return Object.freeze({
      isCurrent: current,
      bindRequest(id, controller) {
        // Bind the actual synchronously-started normal Gallery request, never
        // an arbitrary later same-URL admission or a successor controller.
        if (!baseCurrent() || pending.request || !controller?.signal || controller.signal.aborted
          || !Number.isSafeInteger(id) || state.ui?.activeViewRequestId !== id
          || state.ui?.activeViewRequestController !== controller || state.ui?.activeViewRequestPush === true) return false;
        pending.request = Object.freeze({id, controller});
        return current();
      },
      settleRequest(result) {
        const request = pending.request;
        if (!baseCurrent() || !request || request.controller.signal.aborted || result?.requestId !== request.id
          || state.ui?.activeViewRequestId !== request.id || state.ui?.activeViewRequestController !== null || state.busy) return false;
        pending.settled = Object.freeze({applied: result.applied === true, error: Boolean(result.error)});
        return current();
      },
      hasParent: () => current() && Boolean(pending.owner) && scopeCurrent(pending.owner),
      resolve() {
        const admittedOwner = pending.owner;
        if (!current() || pending.request && (!pending.settled?.applied || pending.settled.error)
          || !admittedOwner || !scopeCurrent(admittedOwner) || state.busy
          || state.ui?.pendingViewTransition || admittedOwner.view !== state.view) return null;
        const requestId = Number(state.ui?.activeViewRequestId || 0);
        const indexed = getIndexedAlbum(descriptor.albumKey);
        if (!indexed || !current()) return null;
        const versionKey = getAlbumCardVersionKey(indexed);
        const section = virtualGrid.sections.find(item => item.group?.albums?.some(album =>
          String(getAlbumRequestKey(album)) === descriptor.albumKey && getAlbumCardVersionKey(album) === versionKey));
        if (!section || !current() || !scopeCurrent(admittedOwner)) return null;
        const token = Object.freeze({sessionId: admittedOwner.id, albumKey: descriptor.albumKey, versionKey,
          sectionKey: section.sectionKey, trigger: 'tracklist'});
        if (!sheetMembership(admittedOwner, token) || !current() || state.busy || state.ui?.pendingViewTransition
          || requestId !== Number(state.ui?.activeViewRequestId || 0)) return null;
        const remembered = focusReceipt?.sessionId === admittedOwner.id && focusReceipt.artistRef === admittedOwner.artistRef
          && focusReceipt.entryKey === admittedOwner.entryKey && focusReceipt.parentViewUrl === descriptor.parentViewUrl
          ? focusReceipt.token : token;
        return {album: indexed, origin: sheetOrigin(admittedOwner, token, remembered)};
      },
      release() {active = false; if (sheetReplay === pending) sheetReplay = null;},
    });
  }
  function restoreAlbumSheetFocus(receipt, isCurrent) {
    const owner = session, mounted = attachment;
    const current = () => allowed(isCurrent) && owner && installed() && session === owner && attachment === mounted
      && scopeCurrent(owner) && owner.id === receipt?.sessionId && owner.artistRef === receipt?.artistRef && owner.entryKey === receipt.entryKey
      && owner.parentViewUrl === receipt.parentViewUrl && syncPresentation().actionable && allowed(isCurrent);
    if (!current()) return false;
    return mounted.lease.restoreFocus({...receipt.token, sessionId: owner.id}, {preserveViewport: true}) && current();
  }
  function admittedSheetReplay(owner) {
    const pending = sheetReplay;
    return pending?.owner === owner && pending.current?.() === true
      && sheetReplay === pending && pending.owner === owner && scopeCurrent(owner);
  }
  function captureChildPresentation(isCurrentOperation) {
    const owner = session, view = owner?.view;
    if (!owner) return null;
    // An existing but invalid admission must abort this presentation rather
    // than silently fall through as a gallery with no Artist owner.
    const rejected = Object.freeze({sessionId: owner.id, isCurrent: () => false,
      isOwnerCurrent: () => false, release() {}});
    if (!scopeCurrent(owner) || owner.provisional || state.view !== view
      || !admitted(view) || text(view.selected_artist) !== owner.artistRef
      || !(atParentEntry(owner) || ownsChild(owner) || admittedSheetReplay(owner))) return rejected;
    const requestId = Number(state.ui?.activeViewRequestId || 0), entryKey = owner.entryKey, entryUrl = owner.entryUrl;
    const originPosition = position(), originUrl = url(window.location.href);
    const historyReceipt = () => JSON.stringify((Array.isArray(window.history.state?.mobilePages)
      ? window.history.state.mobilePages : []).map(pageIdentity));
    const originHistory = historyReceipt();
    let active = true;
    const sameOwner = () => active && installed() && session === owner && owner.view === view && state.view === view
      && admitted(view) && text(view.selected_artist) === owner.artistRef
      && owner.entryKey === entryKey && owner.entryUrl === entryUrl && !owner.provisional
      && requestId === Number(state.ui?.activeViewRequestId || 0);
    const currentOwner = () => sameOwner() && allowed(isCurrentOperation) && sameOwner()
      && scopeCurrent(owner) && sameOwner();
    if (!currentOwner()) return rejected;
    return Object.freeze({sessionId: owner.id,
      isCurrent: () => currentOwner() && position() === originPosition && url(window.location.href) === originUrl
        && historyReceipt() === originHistory,
      isOwnerCurrent: currentOwner,
      release() {active = false;},
    });
  }
  function captureFormReturn(isCurrent) {
    const owner = session;
    if (!owner || !scopeCurrent(owner) || owner.provisional
      || (!liveChildRoot(owner) && presentation(owner) !== 'parent')) return null;
    const originPosition = position(), requestId = Number(state.ui?.activeViewRequestId || 0);
    const current = () => installed() && session === owner && scopeCurrent(owner) && allowed(isCurrent)
      && session === owner && owner.view === state.view && requestId === Number(state.ui?.activeViewRequestId || 0)
      && scopeCurrent(owner);
    return Object.freeze({sessionId: owner.id,
      isCurrent: () => current() && (position() === originPosition || position() === owner.entryKey),
      settle() {
        if (!current()) return false;
        const nextPosition = position(), nextUrl = url(window.location.href);
        if (!current()) return false;
        if (nextUrl === owner.entryUrl) owner.entryKey = nextPosition;
        return true;
      }});
  }
  const api = {reconcileAdmittedView, commitAdmittedNavigation, captureRequestSettlement, snapshot: syncPresentation, syncPresentation, attach, renderDiscography,
    currentContextFor, captureAlbumSheetOrigin, beginAlbumSheetReplay, restoreAlbumSheetFocus, captureChildPresentation, captureFormReturn, navigateFamily,
    requestRender() {if (session && scopeCurrent(session) && session.view === state.view && attachment) renderArtistGroups({preserveScroll: true});},
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    buttonHtml: options => ButtonComponent.renderButton(options), actionHtml: options => ButtonComponent.renderActionButton(options),
    createIntrinsicDisclosure: options => createIntrinsicDisclosure(options),
    artistInfoHtml: options => buildArtistInfoOverlayHtml({...options, presentation: 'embedded'}),
    artistFamilyHtml: options => buildArtistFamilyPanelHtml({...options, presentation: 'navigation'}),
    dispose() {if (disposed) return; disposed = true; retire(); unsubscribeTransport?.(); observer?.disconnect();
      window.removeEventListener('popstate', onPopState); listeners.clear();},
  };
  const onPopState = () => {syncPresentation({passive: true});};
  const unsubscribeTransport = window.AlbumHavenPrivateUITransport?.subscribe(() => syncPresentation());
  const shell = document.getElementById('app-shell');
  const observer = shell && typeof MutationObserver === 'function' ? new MutationObserver(() => syncPresentation()) : null;
  observer?.observe(shell, {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id', 'data-private-ui-context']});
  window.addEventListener('popstate', onPopState);
  return Object.freeze(api);
})();
window.AlbumHavenArtistPageRuntime?.dispose();
window.AlbumHavenArtistPageRuntime = ArtistPageRuntime;
window.dispatchEvent(new Event('albumhaven:artist-page-runtime-ready'));
