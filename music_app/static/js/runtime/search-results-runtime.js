/* Nonvisual adapter for already-admitted own-subject Search results. The native
 * input/commit/fetch/read/apply pipeline remains the only query owner. */
const SearchResultsRuntime = (() => {
  const listeners = new Set(), sources = new Set();
  let publicationDepth = 0, notificationPending = false, notifying = false;
  let owner = null, serial = 0, rowSerial = 0, pending = null, galleryLease = null, visibilityScope = null;
  let current = Object.freeze({visible: false, status: 'idle', actionable: false, presentation: 'albums',
    result: null, resultId: 0, scopeKey: '', sourceIdentity: null, error: '',
    galleryDisplayMode: normalizeGalleryView(state.view?.gallery_display_mode)});
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum ? value : null;
  const albumRef = value => typeof value === 'string' && /^inventory-album:[1-9]\d*:[1-9]\d*$/.test(value) ? value : null;
  const trackRef = value => typeof value === 'string' && /^inventory-track:[1-9]\d*:[1-9]\d*$/.test(value) ? value : null;
  const readable = value => value?.allowed_actions?.can_read === true;
  const freeze = value => Array.isArray(value) ? Object.freeze(value.map(freeze))
    : plain(value) ? Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)]))) : value;
  const installed = () => window.AlbumHavenSearchRuntime === SearchResultsRuntime;
  function notify() {
    notificationPending = true;
    if (publicationDepth || notifying) return;
    notifying = true;
    try {
      while (notificationPending && !publicationDepth) {
        notificationPending = false;
        const published = current;
        for (const listener of [...listeners]) {
          // Reentrant navigation owns the next publication, never the old one.
          if (current !== published) {notificationPending = true; break;}
          try {listener();} catch { /* Consumer errors cannot grant authority. */ }
        }
      }
    } finally {notifying = false;}
  }
  function transaction(work) {
    publicationDepth++;
    try {return work();}
    finally {publicationDepth--; if (!publicationDepth && notificationPending) notify();}
  }
  function syncVisibility() {
    if (!installed()) return;
    const host = document.getElementById('search-results-root'), gallery = document.getElementById('albums-scroll');
    if (host) host.hidden = !current.visible;
    if (!gallery) return;
    if (current.visible && host) {
      if (!galleryLease || galleryLease.node !== gallery) galleryLease = {node: gallery, hidden: gallery.hidden,
        ariaHidden: gallery.getAttribute('aria-hidden')};
      gallery.hidden = true; gallery.setAttribute('aria-hidden', 'true');
    } else if (galleryLease) {
      const lease = galleryLease; galleryLease = null;
      if (lease.node === gallery && (state.view?.surface?.active || 'albums') === 'albums') {
        gallery.hidden = lease.hidden;
        if (lease.ariaHidden === null) gallery.removeAttribute('aria-hidden');
        else gallery.setAttribute('aria-hidden', lease.ariaHidden);
      }
    }
  }
  function publish(next) {current = Object.freeze(next); syncVisibility(); notify();}
  function owns(candidate) {
    if (!candidate || owner !== candidate) return false;
    try {return candidate.isCurrent() === true && owner === candidate
      && galleryReadScopeIsCurrent(candidate.capture) && owner === candidate;}
    catch {return false;}
  }
  function intentCurrent(request) {
    return Boolean(request && pending === request && readViewStateRevision() === request.revision
      && state.ui.gallerySearchGeneration === request.queryGeneration
      && galleryReadScopeIsCurrent(request.capture) && pending === request);
  }
  function queuedIntent(request) {
    const queued = state.ui.pendingViewRequest;
    return intentCurrent(request) && request.requestId === null && queued?.url === request.url
      && queued.originatingViewStateRevision === request.revision
      && queued.options?.onStart === request.options?.onStart;
  }
  function startingIntent(request) {
    return intentCurrent(request) && request.requestId === null
      && state.ui.activeViewRequestUrl === request.url
      && Number(state.ui.activeViewRequestId) > request.originRequestId;
  }
  function clearPending() {const request = pending; pending = null; request?.unsubscribe?.();}
  function abortSidebar(candidate) {
    if (!candidate) return;
    const request = candidate.sidebarRead;
    candidate.sidebarRead = null; candidate.sidebarCursor = null; candidate.sidebarHasMore = false;
    // Detach before abort listeners can synchronously claim another parent.
    request?.controller.abort();
  }
  function retireGalleryArtwork() {
    if (!installed()) return;
    // This bounded owner does not activate artwork or detail. Still erase old
    // marked result pixels synchronously if a prior consumer left them mounted.
    const host = document.getElementById('search-results-root');
    // Conceal the previous native publication before disposal observers run.
    // The consumer replaces its result subtree only after a fresh admission.
    for (const content of host?.querySelectorAll('[data-search-results-content]') || []) {
      content.hidden = true; content.setAttribute('inert', '');
    }
    for (const image of host?.querySelectorAll('img[data-search-artwork-owner]') || []) {
      if (image.getAttribute('data-search-artwork-owner').startsWith('search-result-artwork-')) {
        image.removeAttribute('src'); image.removeAttribute('srcset'); image.remove();
      }
    }
  }
  function retire(reason = 'context', {beforeObservers, beforeNotify} = {}) {
    return transaction(() => {
      const previous = owner, oldPending = pending, oldSources = [...sources];
      const changed = Boolean(previous || pending || current.visible || current.result || current.actionable);
      owner = null; sources.clear();
      // Detach the readable snapshot before any disposal can call a consumer.
      const next = changed ? Object.freeze(reason === 'replace' && current.visible
        ? {...current, actionable: false, status: 'loading', error: '', result: null,
          resultId: ++serial, scopeKey: '', sourceIdentity: null}
        : {visible: false, status: 'idle', actionable: false, presentation: 'albums',
          result: null, resultId: ++serial, scopeKey: '', sourceIdentity: null, error: '',
          galleryDisplayMode: normalizeGalleryView(state.view?.gallery_display_mode)}) : current;
      current = next;
      // Replacement may have no bridge-issued pending intent (a raw native
      // submit). Keep only continuity for hiding its loading shell on loss;
      // this scope never grants a source, result or request.
      visibilityScope = next.visible ? previous?.capture || visibilityScope : null;
      retireGalleryArtwork(); previous?.unsubscribe?.();
      abortSidebar(previous);
      // The native request captures its existing scope after native erasure and
      // bridge detachment, while any reentrant publication is still batched.
      beforeObservers?.();
      const keepPending = pending === oldPending && reason === 'replace' && startingIntent(oldPending);
      if (!keepPending && pending === oldPending && current === next) clearPending();
      if (installed() && current === next && owner === null) {
        try {window.AlbumHavenSearchDetailUI?.retire?.(reason);} catch { /* Retirement remains fail closed. */ }
      }
      for (const source of oldSources) {
        try {source.dispose();} catch { /* One disposal observer cannot retain other old sources. */ }
      }
      // Native retirement supplies the guarded Sidebar paint. All bridge
      // notifications, including nested ones, wait for this cleanup boundary.
      try {beforeNotify?.();}
      finally {if (current === next && owner === null && changed) {syncVisibility(); notify();}}
      return current === next && owner === null;
    });
  }
  function retireAccepted(candidate, reason) {
    if (owner !== candidate) return;
    if (state.view === candidate.nativeView) {
      retireNativePrivateSearchView(() => owner === candidate && state.view === candidate.nativeView, reason);
    } else retire(reason);
  }
  function reconcileLifetime() {
    const candidate = owner;
    if (candidate && !owns(candidate)) retireAccepted(candidate, 'context');
    const request = pending;
    if (request && !galleryReadScopeIsCurrent(request.capture) && pending === request) {
      retireNativePrivateSearchView(() => pending === request, 'context');
    }
    const scope = visibilityScope, snapshot = current;
    if (!owner && snapshot.visible && scope && !galleryReadScopeIsCurrent(scope)
      && !owner && current === snapshot && visibilityScope === scope) {
      retireNativePrivateSearchView(() => !owner && current === snapshot && visibilityScope === scope, 'context');
    }
  }
  function syncPresentation() {
    reconcileLifetime();
    const snapshot = current, galleryDisplayMode = normalizeGalleryView(state.view?.gallery_display_mode);
    if (snapshot.galleryDisplayMode !== galleryDisplayMode) publish({...snapshot, galleryDisplayMode});
    return current;
  }
  function syncNativeView({isCurrentResponse} = {}) {
    const nativeView = state.view;
    if (nativeView?.private_search !== true) {
      if (owner || pending || current.visible) retire('navigation');
      return;
    }
    // Only the actual guarded native response phase may install a new private
    // navigation projection before bridge admission. Local/history/failure
    // replay can retain intent, but cannot restore retired private Artist rows.
    let responseOwned = false;
    try {responseOwned = typeof isCurrentResponse === 'function' && isCurrentResponse() === true;}
    catch { /* No private projection is admitted by a failed response guard. */ }
    if (!responseOwned) {
      retireNativePrivateSearchView(() => state.view === nativeView, 'navigation');
      return;
    }
    if (state.view !== nativeView) return;
    const candidate = owner;
    if (candidate && !owns(candidate)) retireAccepted(candidate, 'navigation');
  }
  function pageProjection(page, expectedCount) {
    if (!plain(page) || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100
      || !Number.isInteger(page.returned_count) || page.returned_count !== expectedCount
      || expectedCount > page.limit || typeof page.has_more !== 'boolean'
      || page.has_more && (!text(page.next_cursor, 4096) || !page.next_cursor)
      || !page.has_more && page.next_cursor !== null) throw new Error('Invalid Search page.');
    return {limit: page.limit, returnedCount: page.returned_count, hasMore: page.has_more};
  }
  function project(payload, library, allocateRows = true) {
    const selectedPending = payload?.status === 'pending';
    const initialPending = payload?.selection_state === 'pending_page';
    if (payload?.private_search !== true || payload.contract_version !== 'own-love-v1'
      || !['ready', 'pending'].includes(payload.status)
      || (selectedPending ? !privateSearchPendingProgressIsValid(payload, {omitSidebar: payload.sidebar === null})
        : Object.hasOwn(payload, 'selection_pending')) || Object.hasOwn(payload, 'sidebar_only')
      || !['albums', 'tracks'].includes(payload.presentation) || text(payload.query) === null
      || !privateSearchCriteriaIsValid(payload.criteria)
      || !['selected', 'all_artists', 'empty', 'pending_page'].includes(payload.selection_state)
      || initialPending && !privateSearchInitialProgressIsValid(payload)
      || !Array.isArray(payload.artist_groups) || !Array.isArray(payload.tracks)) throw new Error('Invalid Search result.');
    if (payload.selection_state === 'selected'
      ? typeof payload.selected_artist !== 'string' || !payload.selected_artist.trim()
      : payload.selected_artist !== null) throw new Error('Invalid Search selection.');
    if (payload.selection_state === 'empty' && (payload.artist_groups.length || payload.tracks.length
      || payload.page?.has_more || payload.sidebar?.has_more)) throw new Error('Invalid empty Search result.');
    const albums = [], tracks = [], trackSources = new Map(), albumSources = new Map();
    if (payload.artist_groups.length > 100 || payload.tracks.length > 100) throw new Error('Search result exceeds its bound.');
    if (payload.presentation === 'albums' && payload.tracks.length || payload.presentation === 'tracks' && payload.artist_groups.length) {
      throw new Error('Search presentation does not match its result.');
    }
    for (const group of payload.artist_groups) {
      if (!plain(group) || text(group.artist) === null || !Array.isArray(group.albums)) throw new Error('Invalid Search group.');
      for (const row of group.albums) {
        const ref = albumRef(row?.album_ref);
        if (!ref || ref.split(':')[1] !== library || albumSources.has(ref) || !readable(row) || text(row.name) === null
          || row.matches_search !== true || albums.length >= 100) throw new Error('Invalid Search album.');
        const safe = {albumRef: ref, name: row.name, artist: text(group.artist_display) ?? group.artist,
          year: Number.isInteger(row.year) ? row.year : null, edition: text(row.edition) || '',
          isSearchMatch: true,
          canOpen: row.allowed_actions.can_view_details === true};
        albums.push(safe); albumSources.set(ref, safe);
      }
    }
    const seenTracks = new Set();
    for (const row of payload.tracks) {
      const ref = trackRef(row?.inventory_track_ref), parent = row?.parent_album, parentRef = albumRef(parent?.album_ref);
      if (!ref || ref.split(':')[1] !== library || seenTracks.has(ref) || !parentRef || parentRef.split(':')[1] !== library
        || !readable(row) || !readable(parent)
        || text(row.title) === null || text(row.artist) === null || text(row.album) === null || text(parent.name) === null) {
        throw new Error('Invalid Search track.');
      }
      seenTracks.add(ref);
      const rowKey = allocateRows ? `search-row-${++rowSerial}` : '', safe = {rowKey, title: row.title, artist: row.artist, album: row.album,
        durationSeconds: Number.isInteger(row.duration_seconds) && row.duration_seconds >= 0 ? row.duration_seconds : null,
        trackNumber: Number.isInteger(row.track_number) && row.track_number > 0 ? row.track_number : null,
        readable: true, selectable: row.allowed_actions.can_select === true, albumRef: parentRef};
      tracks.push(safe);
      // Only existing inventory identity is resolvable. Browse does not imply
      // playback/edit grants, and arbitrary response properties stay private.
      trackSources.set(rowKey, Object.freeze({inventory_track_ref: ref, source_readable: true,
        allowed_actions: Object.freeze({can_read: true})}));
      if (!albumSources.has(parentRef)) albumSources.set(parentRef, {albumRef: parentRef, name: parent.name,
        artist: row.artist, year: Number.isInteger(parent.year) ? parent.year : null,
        canOpen: parent.allowed_actions.can_view_details === true});
    }
    const count = payload.presentation === 'albums' ? albums.length : tracks.length;
    const page = pageProjection(payload.page, count);
    // First-witness progress is resumed through its bounded foreground cursor.
    // The wire main page may have no cursor while its Sidebar proof advances.
    if (initialPending) page.hasMore = true;
    let sidebar = null;
    if (payload.sidebar !== null && payload.sidebar !== undefined) {
      const value = payload.sidebar;
      if (!plain(value) || !Array.isArray(value.artists) || value.artists.length > 50
        || value.returned_count !== value.artists.length || typeof value.has_more !== 'boolean'
        || value.has_more && (!text(value.next_cursor, 4096) || !value.next_cursor)
        || !value.has_more && value.next_cursor !== null) throw new Error('Invalid Search sidebar.');
      const artists = new Set();
      for (const row of value.artists) {
        if (!plain(row) || text(row.artist) === null || !row.artist.trim() || artists.has(row.artist)
          || Object.hasOwn(row, 'artist_display') && text(row.artist_display) === null
          || Object.hasOwn(row, 'count') && (!Number.isInteger(row.count) || row.count < 0)) throw new Error('Invalid Search artist.');
        artists.add(row.artist);
      }
      sidebar = {hasMore: value.has_more, returnedCount: value.returned_count};
    }
    return {result: freeze({albums, tracks, page, sidebar, selectionState: payload.selection_state}), trackSources, albumSources};
  }
  function accept(payload, {isCurrent} = {}) {
    return transaction(() => {
      if (typeof isCurrent !== 'function' || isCurrent() !== true) return false;
      const before = current, previous = owner, capture = captureGalleryReadScope();
      if (!capture.context || payload?.context_ref !== capture.context || isCurrent() !== true) return false;
      let projection;
      try {projection = project(payload, capture.library);} catch {return false;}
      // Playlist contributes only the existing shell scope identity. Its
      // visibility, feature permission and playback capability do not authorize
      // Search browse. Its snapshot can synchronously notify other consumers.
      const scopeKey = window.AlbumHavenPlaylistRuntime?.snapshot().scopeKey || '';
      if (!scopeKey || current !== before || owner !== previous
        || !galleryReadScopeIsCurrent(capture) || isCurrent() !== true
        || current !== before || owner !== previous) return false;
      const oldSources = [...sources]; sources.clear(); owner = null;
      const detached = Object.freeze({...current, actionable: false, result: null,
        resultId: ++serial, scopeKey: '', sourceIdentity: null});
      current = detached;
      retireGalleryArtwork(); previous?.unsubscribe?.();
      abortSidebar(previous);
      for (const source of oldSources) {
        try {source.dispose();} catch { /* Disposal observers cannot restore an old grant. */ }
      }
      if (current !== detached || owner !== null || !galleryReadScopeIsCurrent(capture)
        || isCurrent() !== true || current !== detached || owner !== null) return false;
      // Pending owns only explicit resuming intent. It never creates even an
      // empty private source grant or reuses the previous ready result lease.
      const selectedPending = payload.status === 'pending' || payload.selection_state === 'pending_page';
      const sourceIdentity = selectedPending ? null : Object.freeze({}), resultId = ++serial;
      const next = {payload, ...projection, capture, isCurrent, resultId, sourceIdentity,
        requestedArtist: new URL(state.ui.activeViewRequestUrl, window.location.href).searchParams.get('artist') || '',
        nativeView: state.view, scopeKey, unsubscribe: null, sidebarRead: null,
        sidebarCursor: payload.sidebar?.next_cursor || null, sidebarHasMore: payload.sidebar?.has_more === true,
        sidebarArtists: state.view.artists_sidebar};
      owner = next;
      next.unsubscribe = capture.transport.subscribe(() => {
        if (owner === next && !owns(next)) retireAccepted(next, 'context');
      });
      if (!owns(next)) {retireAccepted(next, 'context'); return false;}
      // A native-owned queued intent has not started yet; current admission
      // cannot discard the callbacks the native queue will eventually dispatch.
      const oldPending = pending, keepPending = queuedIntent(oldPending);
      if (!owns(next)) return false;
      if (!keepPending && pending === oldPending) clearPending();
      if (!owns(next)) return false;
      visibilityScope = capture;
      publish({visible: true, status: selectedPending ? 'pending' : 'ready', actionable: !selectedPending, presentation: payload.presentation,
        result: projection.result, resultId, scopeKey, sourceIdentity, error: '',
        galleryDisplayMode: normalizeGalleryView(state.view?.gallery_display_mode),
        sidebar: Object.freeze({status: selectedPending && next.sidebarHasMore ? 'pending' : 'ready', hasMore: next.sidebarHasMore, error: ''})});
      return owns(next);
    });
  }
  function isCurrent(snapshot) {
    const next = owner;
    return Boolean(snapshot && snapshot.resultId === next?.resultId && snapshot.sourceIdentity === next.sourceIdentity
      && snapshot.actionable && owns(next));
  }
  function publicationIsCurrent(snapshot) {
    const candidate = owner;
    return Boolean(candidate && snapshot && snapshot.resultId === candidate.resultId
      && snapshot.sourceIdentity === candidate.sourceIdentity && owns(candidate));
  }
  function sidebarNodeIsCurrent(node) {
    const candidate = owner, container = document.getElementById('sidebar-list');
    return Boolean(candidate && node instanceof HTMLElement && node.isConnected
      && node.albumHavenPrivateSearchView === candidate.nativeView
      && node.closest('#sidebar-list') === container && container?.contains(node)
      && owns(candidate) && owner === candidate && state.view === candidate.nativeView
      && node.isConnected && container.contains(node));
  }
  function readSidebar(candidate) {
    if (!owns(candidate) || candidate.sidebarRead || !candidate.sidebarHasMore
      || !['selected', 'all_artists'].includes(candidate.payload.selection_state)
      || !candidate.sidebarCursor) return false;
    const request = {controller: new AbortController(), cursor: candidate.sidebarCursor};
    candidate.sidebarRead = request;
    const active = () => candidate.sidebarRead === request && !request.controller.signal.aborted
      && owns(candidate) && candidate.sidebarRead === request;
    const progress = (status, error = '') => {
      if (owns(candidate)) publish({...current,
        sidebar: Object.freeze({status, hasMore: candidate.sidebarHasMore, error})});
    };
    // HTTP and typed response policy remain with the existing native read owner.
    const work = readPrivateSearchSidebarPage({view: candidate.nativeView, parent: candidate.payload,
      cursor: request.cursor, scope: candidate.capture, signal: request.controller.signal,
      isCurrent: active, retire: reason => {if (active()) retireAccepted(candidate, reason);}});
    if (active()) progress('loading');
    Promise.resolve(work).then(leaf => {
      if (!active()) return;
      candidate.sidebarCursor = leaf.cursor; candidate.sidebarHasMore = leaf.hasMore;
      if (leaf.status === 'ready') {
        const artists = [...candidate.sidebarArtists], seen = new Set(artists.map(row => row.artist));
        for (const row of leaf.artists) if (!seen.has(row.artist)) {artists.push(row); seen.add(row.artist);}
        candidate.sidebarArtists = artists;
        state.gallery.sidebarArtistsOverride = artists;
        state.gallery.sidebarShowAllArtistsOverride = candidate.nativeView.show_all_artists_sidebar_link !== false;
        renderSidebar();
      }
      if (!active()) return;
      candidate.sidebarRead = null;
      progress(leaf.status);
    }).catch(() => {
      if (!active()) return;
      candidate.sidebarRead = null;
      progress('error', 'Sidebar could not be loaded. Try again.');
    }).finally(() => {
      // Old completion cannot unlock a newer child, even under subscriber reentry.
      if (candidate.sidebarRead === request) candidate.sidebarRead = null;
    });
    return true;
  }
  function requestState(candidate, presentation, {cursor = null, sidebarCursor = null} = {}) {
    const payload = candidate.payload;
    // Reuse native URL construction, including category multivalue semantics.
    const url = new URL(buildApiUrl({...state.view, query: payload.query,
      selected_artist: payload.selection_state === 'pending_page' ? candidate.requestedArtist || '' : payload.selected_artist || '',
      all_artists_active: payload.selection_state === 'all_artists', surface: {active: 'albums'}, surface_request: 'albums'}), window.location.href);
    for (const key of ['gallery_cursor', 'gallery_page_size', 'search_cursor', 'search_sidebar_cursor', 'search_sidebar_only', 'search_detail_album_ref']) url.searchParams.delete(key);
    url.searchParams.set('search_presentation', presentation);
    url.searchParams.set('search_page_size', String(payload.page.limit));
    if (cursor) {url.searchParams.set('search_cursor', cursor); url.searchParams.set('omit_sidebar', '1');}
    if (sidebarCursor) url.searchParams.set('search_sidebar_cursor', sidebarCursor);
    return `${url.pathname}${url.search}`;
  }
  function readPage(candidate, presentation, options = {}, restartIntent = null) {
    const canStart = restartIntent
      ? pending === restartIntent && !owner && intentCurrent(restartIntent)
      : owns(candidate);
    if (!canStart || !['albums', 'tracks'].includes(presentation)) return false;
    // An explicit command queued from inside publication retains one intent;
    // a second activation cannot replace its callback identity or native queue.
    if (!restartIntent && pending?.parentResultId === candidate.resultId && intentCurrent(pending)) return false;
    const url = requestState(candidate, presentation, options);
    const request = {capture: candidate.capture, query: candidate.payload.query, payload: candidate.payload,
      requestedArtist: candidate.requestedArtist || '',
      parentResultId: candidate.resultId ?? null,
      revision: readViewStateRevision(), queryGeneration: state.ui.gallerySearchGeneration, requestId: null,
      originRequestId: Number(state.ui.activeViewRequestId || 0), url, presentation, options: null};
    clearPending(); pending = request;
    request.unsubscribe = request.capture.transport.subscribe(() => {
      if (pending === request && !galleryReadScopeIsCurrent(request.capture)) {
        retireNativePrivateSearchView(() => pending === request, 'context');
      }
    });
    const active = () => intentCurrent(request) && request.requestId !== null
      && request.requestId === state.ui.activeViewRequestId;
    request.options = {preserveScroll: true, skipPendingViewTransition: true,
      onStart({requestId}, optionsOrigin) {
        if (optionsOrigin !== request.options || !startingIntent(request)
          || requestId !== state.ui.activeViewRequestId) return false;
        request.requestId = requestId;
        // The existing request owner has already revoked native admission and
        // retired sources. Only now may subscribers observe this loading intent.
        publish({...current, status: 'loading', actionable: false, presentation, error: ''});
        return active();
      },
      shouldApplyResponse(data) {
        return active() && data?.private_search === true && data.contract_version === 'own-love-v1'
          && data.query === request.query && data.presentation === presentation
          && JSON.stringify(data.criteria) === JSON.stringify(candidate.payload.criteria)
          && (candidate.payload.selection_state === 'pending_page'
            || (data.selected_artist || '') === (candidate.payload.selected_artist || ''));
      },
      onSettled({applied, error, requestId}) {
        if (!active() || requestId !== request.requestId || applied) return;
        if (error) publish({...current, status: 'error', actionable: false, error: 'Search could not be loaded. Try a fresh search.'});
      }};
    // Never publish/retire before native fetchAndRender claims its slot. It may
    // defer, queue or refuse this command under its existing navigation policy.
    Promise.resolve(fetchAndRender(url, true, request.options)).then(applied => {
      if (pending !== request || applied || queuedIntent(request)) return;
      // Refusal before onStart has no loading state to undo. A superseded start
      // likewise cannot retain an unused context subscription or retry intent.
      if (request.requestId === null || !active()) clearPending();
    }).catch(() => {
      if (active()) publish({...current, status: 'error', actionable: false, error: 'Search could not be loaded. Try a fresh search.'});
      else if (pending === request && !queuedIntent(request)) clearPending();
    });
    return true;
  }
  function sourceFor({rows, context, instance, revision, isCurrent: consumerCurrent}) {
    const candidate = owner;
    if (!owns(candidate) || candidate.payload.status !== 'ready' || !candidate.sourceIdentity
      || context?.scopeKey !== candidate.scopeKey || context.resultId !== candidate.resultId
      || instance !== candidate.sourceIdentity || revision !== instance || typeof consumerCurrent !== 'function' || !Array.isArray(rows)
      || rows.some(row => !candidate.result.tracks.includes(row))) return null;
    const active = () => {
      try {return owns(candidate) && consumerCurrent() === true && owns(candidate);}
      catch {return false;}
    };
    const source = createPrivatePlaytableSource({scopeKey: context.scopeKey, rows, instance, revision, isCurrent: active,
      resolveRow: row => active() && candidate.result.tracks.includes(row) && row.selectable
        ? candidate.trackSources.get(row.rowKey) || null : null,
      subscribe: listener => {listeners.add(listener); return () => listeners.delete(listener);}});
    if (!active()) {source.dispose(); return null;}
    sources.add(source);
    return Object.freeze({...source, dispose() {sources.delete(source); source.dispose();}});
  }
  function action(method, packet, lifetime, adapter, anchor, options) {
    const candidate = owner;
    try {
      if (!owns(candidate) || candidate.payload.status !== 'ready' || !candidate.sourceIdentity
        || !lifetime?.isCurrent?.() || !owns(candidate)
        || adapter?.snapshot?.()?.scopeKey !== candidate.scopeKey || !owns(candidate)) return false;
    } catch {return false;}
    return window.AlbumHavenPlaytableUI?.[method]?.(packet, lifetime, adapter, anchor, options) ?? false;
  }
  // Native navigation retires sources in the event turn, before consumer cleanup.
  window.addEventListener('popstate', () => {
    if (installed()) retireNativePrivateSearchView(installed, 'navigation');
  }, true);
  const shell = document.getElementById('app-shell');
  const identityAttributes = ['data-native-account-id', 'data-native-library-id', 'data-private-ui-context'];
  let identityObserver = null, identityRevision = 0;
  function rememberIdentityTransitions(records) {
    // Final DOM equality does not erase an A-to-B-to-A boundary. A same-value
    // rewrite has only old values equal to the final value and stays benign.
    if (records.some(record => record.type === 'attributes' && record.target === shell
      && identityAttributes.includes(record.attributeName)
      && record.oldValue !== shell.getAttribute(record.attributeName))) identityRevision++;
  }
  function checkpointIdentity() {
    // A newly claimed native dispatch consumes historical records after old
    // source retirement. Passive revision reads also checkpoint, but explicitly
    // queue reconciliation below. Neither path issues new source authority.
    rememberIdentityTransitions(identityObserver?.takeRecords() || []);
    return identityRevision;
  }
  let identityReconciliationQueued = false;
  function readIdentityRevision() {
    const before = identityRevision;
    checkpointIdentity();
    // Reading continuity must observe same-turn A-B-A transitions too. Taking
    // observer records may suppress its callback, so retain the existing UI
    // retirement path in one queued turn, never synchronously inside a guard.
    if (identityRevision !== before && !identityReconciliationQueued) {
      identityReconciliationQueued = true;
      Promise.resolve().then(() => {
        identityReconciliationQueued = false;
        reconcileLifetime();
      });
    }
    return identityRevision;
  }
  if (shell && typeof MutationObserver === 'function') {
    identityObserver = new MutationObserver(records => {
      rememberIdentityTransitions(records);
      // Existing exact owner/scope checks protect a successor admitted during
      // synchronous retirement callbacks from cleanup for this older batch.
      reconcileLifetime();
    });
    identityObserver.observe(shell,
      {attributes: true, attributeOldValue: true, attributeFilter: identityAttributes});
  }
  const native = window.AlbumHavenHomeRuntime;
  return Object.freeze({snapshot() {reconcileLifetime(); return current;}, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    validate(payload, library) {try {project(payload, library, false); return true;} catch {return false;}},
    accept, retire, syncNativeView, syncVisibility, syncPresentation, isCurrent, createPlaytableSource: sourceFor,
    checkpointIdentity, identityRevision: readIdentityRevision, sidebarNodeIsCurrent,
    selectPresentation(snapshot, value) {return isCurrent(snapshot) && value !== snapshot.presentation ? readPage(owner, value) : false;},
    continueResults(snapshot) {
      if (!publicationIsCurrent(snapshot)) return false;
      const candidate = owner;
      if (candidate.payload.selection_state === 'pending_page') {
        const sidebarCursor = candidate.payload.sidebar?.next_cursor;
        return sidebarCursor ? readPage(candidate, snapshot.presentation, {sidebarCursor})
          : candidate.payload.page.has_more ? readPage(candidate, snapshot.presentation, {cursor: candidate.payload.page.next_cursor}) : false;
      }
      return ['selected', 'all_artists'].includes(candidate.payload.selection_state) && candidate.payload.page.has_more
        ? readPage(candidate, snapshot.presentation, {cursor: candidate.payload.page.next_cursor}) : false;
    },
    // Pending may resume its own bounded progress but can never grant actions.
    // A child owns no foreground slot and cannot renew the main result lease.
    continueSidebar(snapshot) {return publicationIsCurrent(snapshot) ? readSidebar(owner) : false;},
    restart(snapshot) {
      // Native same-URL dedupe cannot protect a bridge intent replaced before
      // onStart. Leave the exact live request and its callbacks untouched.
      if (current.status === 'loading') return false;
      if (publicationIsCurrent(snapshot)) return readPage(owner, snapshot.presentation);
      // An error cannot revive old actions. Restart explicitly returns to the
      // native request owner, which obtains a fresh context and response.
      const request = pending;
      if (snapshot !== current || !intentCurrent(request) || snapshot !== current) return false;
      // Keep the selected Artist, raw query and presentation from this explicit
      // native intent. Restart carries no old result or Sidebar progress token.
      return readPage({payload: request.payload, capture: request.capture, requestedArtist: request.requestedArtist}, request.presentation, {}, request);
    },
    openPlaylistAction: (...args) => action('open', ...args),
    openPlaytableContext: (...args) => action('context', ...args),
    trackColumns: () => albumTrackTableColumns({showLove: false}),
    albumTrackRow: (track, index) => buildAlbumTrackTableRow(track, index, {readOnly: true, selection: 'multiple'}),
    tableHtml: config => native.tableHtml(config), galleryCardHtml: config => native.galleryCardHtml(config),
    tabsHtml: config => native.tabsHtml(config), mountTabs: host => native.mountTabs(host),
    buttonHtml: config => native.buttonHtml(config), actionHtml: config => native.actionHtml(config),
    alertHtml: config => native.alertHtml(config), artboxHtml: config => native.artboxHtml(config),
    openChoice: (anchor, options) => native.openChoice(anchor, options), escapeHtml: value => native.escapeHtml(value),
  });
})();
window.AlbumHavenSearchRuntime = SearchResultsRuntime;
window.dispatchEvent(new Event('albumhaven:search-runtime-ready'));
