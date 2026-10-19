/* Nonvisual adapter for already-admitted private Search results. The native
 * input/commit/fetch/read/apply pipeline remains the only query owner. */
const SearchResultsRuntime = (() => {
  const listeners = new Set(), sources = new Set();
  let publicationDepth = 0, notificationPending = false, notifying = false;
  let owner = null, serial = 0, rowSerial = 0, detailAliasSerial = 0, pending = null, galleryLease = null, visibilityScope = null;
  let current = Object.freeze({visible: false, status: 'idle', actionable: false, presentation: 'albums',
    result: null, resultId: 0, scopeKey: '', sourceIdentity: null, error: '',
    galleryDisplayMode: normalizeGalleryView(state.view?.gallery_display_mode)});
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum ? value : null;
  const reference = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
  const albumRef = value => typeof value === 'string' && /^inventory-album:[1-9]\d*:[1-9]\d*$/.test(value) ? value : null;
  const trackRef = value => typeof value === 'string' && /^inventory-track:[1-9]\d*:[1-9]\d*$/.test(value) ? value : null;
  const readable = value => value?.allowed_actions?.can_read === true;
  const listenerResult = payload => payload?.contract_version === 'listener-search-v1';
  const listenerRowRef = value => typeof value === 'string' && /^activity_[a-f0-9]{64}$/.test(value);
  const safeCount = value => Number.isSafeInteger(value) && value >= 0;
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
  function retireNativeActions(candidate) {
    if (!candidate) return;
    for (const presentation of [...matchPresentations]) if (presentation.binding.candidate === candidate) presentation.handle.dispose('source');
    retireSearchLifetime(candidate.matchLifetime);
    const requests = [...candidate.nativeRequests]; candidate.nativeRequests.clear();
    candidate.playRequest = null; candidate.playSequence++;
    candidate.bindingsRead = null;
    for (const binding of candidate.nativeAlbums.values()) if (!binding.transferred) binding.revoked = true;
    candidate.nativeAlbums.clear(); candidate.nativeTracks.clear(); candidate.detailAliases?.clear();
    // Owners are already detached before abort observers can publish a successor.
    for (const controller of requests) controller.abort();
    resourceSelection?.invalidateResourceSelections();
  }
  function retireGalleryArtwork() {
    if (!installed()) return;
    // Erase old marked result pixels synchronously before action-owner disposal.
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
      retireNativeActions(previous);
      cleanupSearchMatchNotifications();
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
    if (installed() && state.view === candidate.nativeView) {
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
    if (popularityResult(payload)) return projectPopularity(payload, library, allocateRows);
    if (listenerResult(payload)) return projectListener(payload, library, allocateRows);
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
  function projectListener(payload, library, allocateRows) {
    const nullableText = value => value === null || text(value) !== null;
    const timestamp = value => typeof value === 'string' && value.length <= 128 && Number.isFinite(Date.parse(value));
    if (!exactKeys(payload, ['status', 'private_search', 'contract_version', 'context_ref', 'query', 'criteria',
      'presentation', 'listener', 'tracks', 'page', 'history', 'native']) || payload.status !== 'ready'
      || payload.private_search !== true || payload.presentation !== 'tracks'
      || typeof payload.context_ref !== 'string' || !/^[a-f0-9]{64}$/.test(payload.context_ref)
      || text(payload.query, 200) === null || !payload.query.trim()
      || !privateListenerSearchCriteriaIsValid(payload.criteria)
      || !exactKeys(payload.listener, ['account_ref', 'username', 'display_name'])
      || typeof payload.listener.account_ref !== 'string'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(payload.listener.account_ref)
      || payload.listener.username !== payload.criteria.subject.username || text(payload.listener.display_name) === null
      || !exactKeys(payload.native, ['result_token']) || !text(payload.native.result_token) || !Array.isArray(payload.tracks)
      || payload.tracks.length > 100 || !/^[1-9]\d*$/.test(library)) throw new Error('Invalid Listener Search result.');
    const history = payload.history, coverage = history?.coverage;
    if (!exactKeys(history, ['expires_at', 'total_tracks', 'total_listens', 'period_label', 'range_label', 'coverage'])
      || !timestamp(history.expires_at) || !safeCount(history.total_tracks) || !safeCount(history.total_listens)
      || text(history.period_label) === null || text(history.range_label) === null
      || !exactKeys(coverage, ['requested_start', 'requested_end', 'timezone', 'observed_start', 'observed_end',
        'source_families', 'complete_for_available_snapshot', 'complete_for_requested_period', 'label'])
      || coverage.requested_start !== null || !timestamp(coverage.requested_end)
      || ![coverage.observed_start, coverage.observed_end].every(value => value === null || timestamp(value))
      || text(coverage.timezone, 128) === null || text(coverage.label) === null
      || !Array.isArray(coverage.source_families) || coverage.source_families.length > 100
      || !coverage.source_families.every(value => text(value, 128) !== null)
      || coverage.complete_for_available_snapshot !== true || coverage.complete_for_requested_period !== false) {
      throw new Error('Invalid Listener history coverage.');
    }
    const trackSources = new Map(), seen = new Set();
    const tracks = payload.tracks.map(row => {
      if (!exactKeys(row, ['id', 'kind', 'title', 'artist', 'album_title', 'listen_count', 'last_listened_at',
        'duration_seconds', 'source_label', 'availability', 'source_readable']) || !listenerRowRef(row.id) || seen.has(row.id)
        || row.kind !== 'track' || row.source_readable !== true || !['local', 'unresolved'].includes(row.availability)
        || !['title', 'artist', 'album_title', 'source_label'].every(key => nullableText(row[key]))
        || !safeCount(row.listen_count) || !timestamp(row.last_listened_at)
        || row.duration_seconds !== null && (!Number.isFinite(row.duration_seconds) || row.duration_seconds < 0)) {
        throw new Error('Invalid Listener Search row.');
      }
      seen.add(row.id);
      const rowKey = allocateRows ? `search-row-${++rowSerial}` : '';
      trackSources.set(rowKey, {row_ref: row.id, binding: null, metadata: null});
      return {rowKey, title: row.title || '', artist: row.artist || '', album: row.album_title || '',
        durationSeconds: row.duration_seconds, trackNumber: null, readable: true, selectable: false,
        availability: row.availability, listenCount: row.listen_count, lastListenedAt: row.last_listened_at,
        sourceLabel: row.source_label || ''};
    });
    const page = payload.page;
    if (!exactKeys(page, ['limit', 'returned_count', 'candidates_examined', 'has_more', 'next_cursor', 'total_matches'])
      || !safeCount(page.candidates_examined) || page.candidates_examined > 100 || page.candidates_examined < tracks.length
      || page.total_matches !== null && (!safeCount(page.total_matches) || page.total_matches < tracks.length)
      || history.total_tracks < tracks.length) throw new Error('Invalid Listener page.');
    const projectedPage = {...pageProjection(page, tracks.length), candidatesExamined: page.candidates_examined,
      totalMatches: page.total_matches};
    return {result: freeze({kind: 'listener', listener: {username: payload.listener.username, displayName: payload.listener.display_name},
      albums: [], tracks, page: projectedPage, sidebar: null,
      history: {periodLabel: history.period_label, rangeLabel: history.range_label, coverageLabel: coverage.label}}),
      trackSources, albumSources: new Map()};
  }
  // Popularity is a separate wire and receipt dialect, not a Listener alias.
  const popularityAlbumsResult = payload => payload?.contract_version === 'popularity-search-albums-v1';
  const popularityResult = payload => payload?.contract_version === 'popularity-search-v1' || popularityAlbumsResult(payload);
  const receiptResult = payload => listenerResult(payload) || popularityResult(payload);
  const popularityRowRef = value => typeof value === 'string' && /^popular_[a-f0-9]{64}$/.test(value);
  const popularityText = (value, maximum = 1024) => typeof value === 'string'
    && [...value].length <= maximum && !/[\u0000\uD800-\uDFFF]/u.test(value);
  const popularityASCII = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && /^[\x00-\x7f]+$/.test(value);
  const popularityReference = value => popularityText(value, 16384) && value.length > 0;
  function popularityDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
      && value.slice(0, 4) !== '0000';
  }
  const popularityDateOrder = value => value.slice(0, 19) + '.'
    + ((value.match(/\.(\d+)/) || [])[1] || '').padEnd(6, '0');
  function popularityBody(body, maximum = 16384) {
    // These three command schemas contain ASCII only. JSON length therefore
    // equals UTF-8 bytes, including escaping, under the existing 16 KiB limit.
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > maximum) throw nativeFailure('Popularity action request is too large.', 400);
    return body;
  }
  function popularityErrorMessage(status) {
    return ({400: 'This popularity search request is malformed.',
      422: 'This popularity search combination is not supported.',
      401: 'Sign in again to use Popularity Search.',
      403: 'Popularity Search is not authorized in this context.',
      409: 'Popularity Search has changed or expired. Restart search from page one.',
      503: 'Popularity Search is temporarily unavailable. Try again.'})[status]
      || 'Popularity Search could not be loaded. Try again.';
  }
  function failPopularityRequest({status, location, requestUrl} = {}, {isCurrent} = {}) {
    return transaction(() => {
      if (typeof isCurrent !== 'function' || isCurrent() !== true || owner) return false;
      const before = current, capture = captureGalleryReadScope();
      let family, url;
      try {
        family = popularityRequest(requestUrl); url = new URL(requestUrl, window.location.href);
        if (!url.searchParams.getAll('q').some(isPopularitySearchExpression)) return false;
      } catch {return false;}
      if (!capture.context || !galleryReadScopeIsCurrent(capture) || isCurrent() !== true || owner || current !== before) return false;
      // An invalid raw request is never silently repaired into an allowed one.
      // Only a 409 restart drops its page cursor; all other raw pairs survive.
      if (status === 409) url.searchParams.delete('search_cursor');
      family = freeze({...family, rawRetryUrl: `${url.pathname}${url.search}`});
      const payload = {contract_version: family.presentation === 'albums' ? 'popularity-search-albums-v1' : 'popularity-search-v1', query: family.query, criteria: null,
        presentation: family.presentation, page: {limit: family.limit}};
      const request = {capture, query: family.query, payload, requestFamily: family, requestedArtist: '',
        revision: readViewStateRevision(), queryGeneration: state.ui.gallerySearchGeneration, requestId: null,
        originRequestId: Number(state.ui.activeViewRequestId || 0), url: family.rawRetryUrl, presentation: family.presentation, options: null};
      clearPending();
      if (!galleryReadScopeIsCurrent(capture) || isCurrent() !== true || owner || current !== before) return false;
      pending = request;
      request.unsubscribe = capture.transport.subscribe(() => {
        if (pending === request && !galleryReadScopeIsCurrent(capture)) retireNativePrivateSearchView(() => pending === request, 'context');
      });
      if (!intentCurrent(request) || isCurrent() !== true || owner || current !== before) return false;
      const errorLocation = exactKeys(location, ['start', 'end']) && Number.isInteger(location.start) && Number.isInteger(location.end)
        && location.start >= 0 && location.end >= location.start && location.end <= family.query.length
        ? freeze({start: location.start, end: location.end}) : null;
      visibilityScope = capture;
      publish({...current, visible: true, status: 'error', kind: 'popularity', presentation: family.presentation, actionable: false,
        result: null, sourceIdentity: null, resultId: ++serial, scopeKey: '', error: popularityErrorMessage(status),
        errorLocation, restartRequired: status === 409});
      return pending === request && !owner && intentCurrent(request);
    });
  }

  function popularityRequest(requestUrl) {
    const url = new URL(requestUrl, window.location.href), params = url.searchParams;
    if (url.origin !== window.location.origin || url.pathname !== '/view-data' || !params.has('q')) throw nativeFailure();
    return freeze({query: params.get('q'), presentation: params.get('search_presentation') ?? 'tracks', gallery_scope: params.get('gallery_scope') ?? 'all',
      visible_library_categories: params.getAll('category'), limit: Number(params.get('search_page_size') ?? 100)});
  }
  function projectPopularity(payload, library, allocateRows) {
    const albumPresentation = popularityAlbumsResult(payload);
    if (!exactKeys(payload, ['status', 'private_search', 'contract_version', 'context_ref', 'query', 'criteria',
      'presentation', ...(albumPresentation ? ['albums', 'lifetime'] : ['tracks']), 'page', 'popularity', 'native']) || payload.status !== 'ready'
      || payload.private_search !== true || payload.presentation !== (albumPresentation ? 'albums' : 'tracks')
      || !/^[a-f0-9]{64}$/.test(payload.context_ref) || typeof payload.context_ref !== 'string'
      || !popularityText(payload.query, 200) || !payload.query.trim()
      || !privatePopularitySearchCriteriaIsValid(payload.criteria) || !/^[1-9]\d*$/.test(library)
      || !exactKeys(payload.native, ['result_token']) || !popularityASCII(payload.native.result_token)
      || !Array.isArray(albumPresentation ? payload.albums : payload.tracks)
      || (albumPresentation ? payload.albums : payload.tracks).length > 100
      || albumPresentation && !validSearchLifetime(payload.lifetime)) throw nativeFailure('Invalid popularity result.', 409);
    const trackSources = new Map(), seen = new Set();
    const tracks = (albumPresentation ? [] : payload.tracks).map(row => {
      const metric = row?.popularity;
      if (!exactKeys(row, ['id', 'kind', 'title', 'artist', 'album_title', 'duration_seconds', 'availability', 'popularity'])
        || !popularityRowRef(row.id) || seen.has(row.id) || row.kind !== 'track' || row.availability !== 'local'
        || ['title', 'artist', 'album_title'].some(key => row[key] !== null && !popularityText(row[key]))
        || row.duration_seconds !== null && (!Number.isFinite(row.duration_seconds) || row.duration_seconds < 0)
        || !exactKeys(metric, ['provider', 'metric', 'count', 'observed_at']) || metric.provider !== 'lastfm'
        || metric.metric !== 'overall_scrobbles' || !safeCount(metric.count) || !popularityDate(metric.observed_at)) {
        throw nativeFailure('Invalid popularity row.', 409);
      }
      seen.add(row.id);
      const rowKey = allocateRows ? `search-row-${++rowSerial}` : '';
      trackSources.set(rowKey, {row_ref: row.id, binding: null, metadata: null, identity: {resourceRef: null}, detailIdentity: null});
      return {rowKey, title: row.title || '', artist: row.artist || '', album: row.album_title || '',
        durationSeconds: row.duration_seconds, trackNumber: null, readable: true, selectable: false,
        availability: 'local', popularityCount: metric.count, observedAt: metric.observed_at};
    });
    const albumSources = new Map();
    const albums = (albumPresentation ? payload.albums : []).map(row => {
      if (!exactKeys(row, ['id', 'kind', 'name', 'artist', 'year', 'edition', 'matches_search', 'allowed_actions'])
        || !/^popular_album_[a-f0-9]{64}$/.test(row.id) || seen.has(row.id) || row.kind !== 'album'
        || !['name', 'artist', 'edition'].every(key => popularityText(row[key]))
        || row.year !== null && (!Number.isInteger(row.year) || row.year < 1 || row.year > 9999)
        || row.matches_search !== true || !exactKeys(row.allowed_actions, ['can_read', 'can_view_details'])
        || row.allowed_actions.can_read !== true || row.allowed_actions.can_view_details !== true) throw nativeFailure('Invalid popularity Album.', 409);
      seen.add(row.id);
      const ref = allocateRows ? `search-album-${++detailAliasSerial}` : '';
      const value = {albumRef: ref, name: row.name, artist: row.artist, year: row.year, edition: row.edition, isSearchMatch: true, canOpen: true};
      albumSources.set(ref, {row_ref: row.id, publicRef: ref, nativeRef: null});
      return value;
    });
    const resultCount = albumPresentation ? albums.length : tracks.length;
    const page = payload.page, coverage = payload.popularity;
    if (!exactKeys(page, ['limit', 'returned_count', 'has_more', 'next_cursor', 'total_matches'])
      || !safeCount(page.total_matches) || page.total_matches < resultCount
      || page.has_more && !popularityASCII(page.next_cursor)) throw nativeFailure('Invalid popularity page.', 409);
    const projectedPage = {...pageProjection(page, resultCount), totalMatches: page.total_matches};
    const reasons = ['missing_recording_identity', 'missing_provider_mapping', 'provider_unavailable', 'mapping_mismatch',
      'missing_global_metric', 'ambiguous_attribution', 'missing_canonical_artist'];
    if (!exactKeys(coverage, ['provider', 'metric', 'label', 'genre_basis', 'matched_local_rows', 'selected_recordings',
      'missing_genre_local_rows', 'excluded_local_rows', 'oldest_observed_at', 'newest_observed_at', 'refresh_status'])
      || coverage.provider !== 'lastfm' || coverage.metric !== 'overall_scrobbles'
      || coverage.label !== 'Last.fm global scrobbles' || coverage.genre_basis !== 'stored_local_file_tags'
      || !['matched_local_rows', 'selected_recordings', 'missing_genre_local_rows'].every(key => safeCount(coverage[key]))
      || (albumPresentation ? coverage.selected_recordings < page.total_matches : coverage.selected_recordings !== page.total_matches) || !exactKeys(coverage.excluded_local_rows, reasons)
      || !reasons.every(key => safeCount(coverage.excluded_local_rows[key])) || !popularityText(coverage.refresh_status)
      || (coverage.selected_recordings === 0
        ? coverage.oldest_observed_at !== null || coverage.newest_observed_at !== null
        : !popularityDate(coverage.oldest_observed_at) || !popularityDate(coverage.newest_observed_at)
          || popularityDateOrder(coverage.oldest_observed_at) > popularityDateOrder(coverage.newest_observed_at))
      || tracks.some(row => popularityDateOrder(row.observedAt) < popularityDateOrder(coverage.oldest_observed_at)
        || popularityDateOrder(row.observedAt) > popularityDateOrder(coverage.newest_observed_at))) throw nativeFailure('Invalid popularity coverage.', 409);
    const refreshStatus = ['idle', 'queued', 'running', 'complete', 'blocked', 'cancelled'].includes(coverage.refresh_status)
      ? coverage.refresh_status : 'unknown';
    return {result: freeze({kind: 'popularity', albums, tracks, sidebar: null, page: projectedPage,
      popularity: {label: coverage.label, genreBasis: coverage.genre_basis, matchedLocalRows: coverage.matched_local_rows,
        selectedRecordings: coverage.selected_recordings, missingGenreLocalRows: coverage.missing_genre_local_rows,
        excludedLocalRows: {...coverage.excluded_local_rows}, oldestObservedAt: coverage.oldest_observed_at,
        newestObservedAt: coverage.newest_observed_at, refreshStatus,
        genreFiltered: Boolean(payload.criteria.genre.include.length || payload.criteria.genre.exclude.length),
        perArtist: payload.criteria.per_artist}}), trackSources, albumSources};
  }
  function popularityEnvelope(reply, lease, version) {
    if (!exactKeys(reply, ['status', 'private_search', 'contract_version', 'context_ref', 'result_token', 'data'])
      || reply.status !== 'ready' || reply.private_search !== true || reply.contract_version !== version
      || reply.context_ref !== lease.capture.context || reply.result_token !== lease.resultToken) {
      throw nativeFailure('Invalid popularity action response.', 409);
    }
    return reply.data;
  }
  function popularityLease(candidate, source) {
    return {dialect: 'popularity', capture: candidate.capture, resultToken: candidate.payload.native.result_token,
      rowRef: source.row_ref, identity: source.identity, detailIdentity: source.detailIdentity,
      detailTarget: source.binding?.album_target || null, targetKind: 'album'};
  }
  function receiptLease(candidate, source, kind = 'album') {
    return popularityResult(candidate.payload) ? popularityLease(candidate, source) : listenerLease(candidate, source, kind);
  }
  function projectPopularityTarget(target, lease, intent) {
    if (intent === 'details') {
      const detail = lease.detailTarget, identity = lease.detailIdentity;
      if (!detail || !identity || identity.identityRef !== detail.identity_ref || detail.kind !== 'album' || detail.row_ref !== lease.rowRef
        || !albumRef(detail.identity_ref) || detail.identity_ref.split(':')[1] !== lease.capture.library
        || !exactKeys(target, ['album_ref', 'allowed_actions']) || !popularityReference(target.album_ref)
        || identity.nativeRef !== null && identity.nativeRef !== target.album_ref
        || !exactKeys(target.allowed_actions, ['can_view_details', 'can_play_album'])
        || target.allowed_actions.can_view_details !== true || typeof target.allowed_actions.can_play_album !== 'boolean') {
        throw nativeFailure('Invalid popularity Album target.', 409);
      }
      return freeze({kind: 'album', ref: identity.publicRef, allowed_actions: {can_view_details: true},
        native_actions: {album_ref: target.album_ref, allowed_actions: {can_open_album: true,
          can_play_album: target.allowed_actions.can_play_album}}});
    }
    if (!trackRef(target?.inventory_track_ref) || target.inventory_track_ref.split(':')[1] !== lease.capture.library
      || lease.identity.resourceRef !== null && target.inventory_track_ref !== lease.identity.resourceRef
      || ['title', 'artist', 'album_title'].some(key => target[key] !== null && !popularityText(target[key]))
      || target.duration_seconds !== null && (!Number.isFinite(target.duration_seconds) || target.duration_seconds < 0)) {
      throw nativeFailure('Popularity track identity changed.', 409);
    }
    const labels = {title: target.title || '', artist: target.artist || '', album_title: target.album_title || ''};
    if (intent === 'play') {
      if (!exactKeys(target, ['inventory_track_ref', 'track_ref', 'path', 'title', 'artist', 'album_title', 'duration_seconds'])
        || !popularityReference(target.path) || target.track_ref !== target.path) throw nativeFailure('Invalid popularity play target.', 409);
      return freeze({...target, ...labels, playback_state: {can_start_here: true}});
    }
    const preference = target.track_preference, canonical = target.canonical_track_ref;
    if (intent !== 'metadata' || !exactKeys(target, ['inventory_track_ref', 'track_ref', 'canonical_track_ref', 'source_readable',
      'title', 'artist', 'album_title', 'duration_seconds', 'availability', 'allowed_actions', 'playback_state', 'track_preference'])
      || canonical !== null && !popularityReference(canonical) || target.track_ref !== canonical || target.source_readable !== true
      || !['local', 'unresolved'].includes(target.availability) || !exactKeys(target.allowed_actions, ['can_read', 'can_play'])
      || target.allowed_actions.can_read !== true || typeof target.allowed_actions.can_play !== 'boolean'
      || !exactKeys(target.playback_state, ['can_start_here']) || typeof target.playback_state.can_start_here !== 'boolean'
      || target.playback_state.can_start_here !== target.allowed_actions.can_play
      || preference !== null && (!exactKeys(preference, ['rating', 'love_tier', 'allowed_actions'])
        || preference.rating !== null && (!Number.isInteger(preference.rating) || preference.rating < 1 || preference.rating > 5)
        || !['off', 'loved', 'obsessed'].includes(preference.love_tier)
        || !exactKeys(preference.allowed_actions, ['client_surface_class', 'can_rate', 'can_set_love_tier'])
        || !['cloud_web', 'private_web', 'desktop', 'mobile', 'tv', 'node'].includes(preference.allowed_actions.client_surface_class)
        || typeof preference.allowed_actions.can_rate !== 'boolean' || typeof preference.allowed_actions.can_set_love_tier !== 'boolean')) {
      throw nativeFailure('Invalid popularity metadata target.', 409);
    }
    // Validate the surface BEFORE delegating. Overlay itself is not a surface gate.
    const webPreference = canonical !== null && preference?.allowed_actions.client_surface_class === 'private_web'
      ? preference : null;
    if (webPreference && !TrackActionsRuntime.overlay(webPreference)) throw nativeFailure('Invalid popularity preference.', 409);
    return freeze({...target, ...labels, track_preference: webPreference});
  }
  function popularityItem(item, lease, intent) {
    if (!exactKeys(item, ['row_ref', 'intent', 'target_kind', 'status', 'native_target'])
      || item.row_ref !== lease.rowRef || item.intent !== intent || item.target_kind !== (intent === 'details' ? 'album' : null)) {
      throw nativeFailure('Popularity action identity changed.', 409);
    }
    if (item.status === 'unavailable' && item.native_target === null) return null;
    if (item.status !== 'ready') throw nativeFailure('Invalid popularity action.', 409);
    return projectPopularityTarget(item.native_target, lease, intent);
  }
  function commitPopularityIdentity(lease, target, intent) {
    if (!target) return;
    if (intent === 'details') {
      const identity = lease.detailIdentity, nativeRef = target.native_actions.album_ref;
      if (!identity || identity.publicRef !== target.ref
        || identity.nativeRef !== null && identity.nativeRef !== nativeRef) {
        throw nativeFailure('Popularity Album identity changed.', 409);
      }
      identity.nativeRef = nativeRef;
      return;
    }
    if (lease.identity.resourceRef !== null && lease.identity.resourceRef !== target.inventory_track_ref) {
      throw nativeFailure('Popularity track identity changed.', 409);
    }
    lease.identity.resourceRef = target.inventory_track_ref;
  }
  async function readPopularityAlbumNative(lease, intent, {signal, isCurrent, witnessLifetime = true} = {}) {
    const active = () => !signal?.aborted && nativeScopeCurrent(lease) && isCurrent?.() === true;
    if (intent !== 'details' || !active()) throw nativeStale();
    if (witnessLifetime && !searchLifetimeCurrent(lease.candidate.matchLifetime)) throw nativeFailure('Restart search.', 409);
    const start = searchLifetimeStart();
    const reply = await lease.capture.transport.request('/search/popularity-album-target', {method: 'POST',
      body: popularityBody({result_token: lease.resultToken, album_ref: lease.rowRef}),
      expected: lease.capture.context, signal, isCurrent: active});
    if (!active()) throw nativeStale();
    if (!exactKeys(reply, ['private_search', 'contract_version', 'context_ref', 'result_token', 'data', 'lifetime'])
      || reply.private_search !== true || reply.contract_version !== 'popularity-search-album-native-v1'
      || reply.context_ref !== lease.capture.context || reply.result_token !== lease.resultToken
      || !exactKeys(reply.data, ['album_ref', 'status', 'native_target']) || reply.data.album_ref !== lease.rowRef
      || !['ready', 'unavailable'].includes(reply.data.status) || !validSearchLifetime(reply.lifetime)) throw nativeFailure('Invalid Album target.', 502);
    const target = reply.data.native_target;
    if (reply.data.status === 'unavailable') {
      if (target !== null) throw nativeFailure('Invalid Album target.', 502);
      throw nativeFailure('This Album is unavailable.', 403);
    }
    if (!exactKeys(target, ['album_ref', 'allowed_actions']) || !popularityReference(target.album_ref)
      || !exactKeys(target.allowed_actions, ['can_view_details', 'can_play_album'])
      || target.allowed_actions.can_view_details !== true || typeof target.allowed_actions.can_play_album !== 'boolean'
      || lease.albumIdentity.nativeRef !== null && lease.albumIdentity.nativeRef !== target.album_ref) throw nativeFailure('Invalid Album identity.', 409);
    if (witnessLifetime) admitSearchLifetime(lease.candidate.matchLifetime, reply.lifetime, start);
    if (!active()) throw nativeStale();
    lease.albumIdentity.nativeRef = target.album_ref;
    return freeze({kind: 'album', ref: lease.albumRef, allowed_actions: {can_view_details: true},
      native_actions: {album_ref: target.album_ref, allowed_actions: {can_open_album: true, can_play_album: target.allowed_actions.can_play_album}}});
  }
  async function readPopularityNative(lease, intent, {signal, isCurrent} = {}) {
    const active = () => !signal?.aborted && nativeScopeCurrent(lease) && isCurrent() === true;
    if (!active()) throw nativeStale();
    const body = {result_token: lease.resultToken, row_ref: lease.rowRef, intent};
    if (intent === 'details') body.target_kind = 'album';
    const reply = await lease.capture.transport.request('/search/popularity-native-target', {method: 'POST', body: popularityBody(body),
      expected: lease.capture.context, signal, isCurrent: active});
    if (!active()) throw nativeStale();
    const data = popularityEnvelope(reply, lease, 'popularity-search-native-v1');
    const target = popularityItem(data, lease, intent);
    if (!active()) throw nativeStale();
    if (!target) throw nativeFailure('This popularity source is unavailable.');
    commitPopularityIdentity(lease, target, intent);
    return target;
  }
  function assertPopularityBatch(reply, leases, intent) {
    const data = popularityEnvelope(reply, leases[0], 'popularity-search-native-batch-v1');
    if (!exactKeys(data, ['items']) || !Array.isArray(data.items) || data.items.length !== leases.length) {
      throw nativeFailure('Invalid popularity batch.', 409);
    }
    // No identity mutation or callback until the entire ordered batch validates.
    return data.items.map((item, index) => popularityItem(item, leases[index], intent));
  }
  function projectPopularityBindings(reply, candidate) {
    const data = popularityEnvelope(reply, {capture: candidate.capture, resultToken: candidate.payload.native.result_token},
      'popularity-search-native-bindings-v1'), rows = [...candidate.trackSources.values()];
    if (!exactKeys(data, ['items']) || !Array.isArray(data.items) || data.items.length !== rows.length) {
      throw nativeFailure('Invalid popularity bindings.', 409);
    }
    return data.items.map((item, index) => {
      if (!exactKeys(item, ['row_ref', 'allowed_actions', 'album_target']) || item.row_ref !== rows[index].row_ref
        || !exactKeys(item.allowed_actions, ['can_play', 'can_view_metadata', 'can_view_details'])
        || Object.values(item.allowed_actions).some(value => typeof value !== 'boolean')
        || item.allowed_actions.can_play && !item.allowed_actions.can_view_metadata
        || item.allowed_actions.can_view_details !== (item.album_target !== null)) throw nativeFailure('Invalid popularity binding.', 409);
      const album = item.album_target;
      if (album !== null && (!exactKeys(album, ['kind', 'row_ref', 'identity_ref', 'allowed_actions'])
        || album.kind !== 'album' || album.row_ref !== item.row_ref || !albumRef(album.identity_ref)
        || album.identity_ref.split(':')[1] !== candidate.capture.library
        || !exactKeys(album.allowed_actions, ['can_view_details']) || album.allowed_actions.can_view_details !== true)) {
        throw nativeFailure('Invalid popularity Album binding.', 409);
      }
      return freeze(item);
    });
  }

  function accept(payload, {isCurrent, requestUrl, requestTiming} = {}) {
    return transaction(() => {
      if (typeof isCurrent !== 'function' || isCurrent() !== true) return false;
      const before = current, previous = owner, capture = captureGalleryReadScope();
      if (!capture.context || payload?.context_ref !== capture.context || isCurrent() !== true) return false;
      let projection, requestFamily = null;
      try {
        if (popularityResult(payload)) {
          if (typeof requestUrl !== 'string' || !privatePopularitySearchResponseMatchesRequest(payload, new URL(requestUrl, window.location.href))) return false;
          requestFamily = popularityRequest(requestUrl);
        }
        projection = project(payload, capture.library);
      } catch {return false;}
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
      retireNativeActions(previous);
      for (const source of oldSources) {
        try {source.dispose();} catch { /* Disposal observers cannot restore an old grant. */ }
      }
      if (current !== detached || owner !== null || !galleryReadScopeIsCurrent(capture)
        || isCurrent() !== true || current !== detached || owner !== null) return false;
      // Pending owns only explicit resuming intent. It never creates even an
      // empty private source grant or reuses the previous ready result lease.
      const selectedPending = payload.status === 'pending' || payload.selection_state === 'pending_page';
      const sourceIdentity = selectedPending ? null : Object.freeze({}), resultId = ++serial;
      const next = {payload, ...projection, requestFamily, capture, isCurrent, resultId, sourceIdentity,
        requestedArtist: new URL(state.ui.activeViewRequestUrl, window.location.href).searchParams.get('artist') || '',
        nativeView: state.view, scopeKey, unsubscribe: null, sidebarRead: null,
        sidebarCursor: payload.sidebar?.next_cursor || null, sidebarHasMore: payload.sidebar?.has_more === true,
        sidebarArtists: state.view.artists_sidebar,
        nativeUrl: receiptResult(payload) ? null : nativeRequestUrl(payload, state.view), nativeRequests: new Set(), bindingsRead: null,
        nativeAlbums: new Map(), nativeTracks: new Map(), detailAliases: new Map(), nativeDenied: new Set(), playSequence: 0, playRequest: null};
      next.matchLifetime = {...(pending?.originalLifetime || {}), timer: null, retired: false, onRetire() {
        if (owner === next) publish({...current, status: 'error', actionable: false, restartRequired: true, error: 'Search matches expired. Restart search.'});
      }};
      if (popularityAlbumsResult(payload) && requestTiming) {
        try {admitSearchLifetime(next.matchLifetime, payload.lifetime, requestTiming);} catch {return false;}
      }
      owner = next;
      if (popularityResult(payload)) installSearchMatchNotifications();
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
        kind: popularityResult(payload) ? 'popularity' : listenerResult(payload) ? 'listener' : 'own-love',
        result: projection.result, resultId, scopeKey, sourceIdentity, error: '',
        galleryDisplayMode: normalizeGalleryView(state.view?.gallery_display_mode),
        ...(receiptResult(payload) ? {bindings: Object.freeze({status: payload.tracks?.length ? 'loading' : 'ready', error: ''})} : {}),
        sidebar: Object.freeze({status: selectedPending && next.sidebarHasMore ? 'pending' : 'ready', hasMore: next.sidebarHasMore, error: ''})});
      if (receiptResult(payload) && !popularityAlbumsResult(payload)) Promise.resolve().then(() => readListenerBindings(next));
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
    if (popularityResult(payload)) {
      if (!candidate.requestFamily) throw nativeFailure('Missing popularity request continuity.', 409);
      if (candidate.requestFamily.rawRetryUrl) return candidate.requestFamily.rawRetryUrl;
      const params = buildPopularitySearchParams(payload.query, candidate.requestFamily, {limit: candidate.requestFamily.limit, cursor, presentation});
      params.set('search_presentation', presentation);
      return `/view-data?${params}`;
    }
    if (listenerResult(payload)) {
      const params = buildListenerSearchParams(payload.query);
      params.set('search_page_size', String(payload.page.limit));
      if (cursor) params.set('search_cursor', cursor);
      return `/view-data?${params}`;
    }
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
    if (!canStart || !['albums', 'tracks'].includes(presentation)
      || listenerResult(candidate.payload) && presentation !== 'tracks') return false;
    // An explicit command queued from inside publication retains one intent;
    // a second activation cannot replace its callback identity or native queue.
    if (!restartIntent && pending?.parentResultId === candidate.resultId && intentCurrent(pending)) return false;
    const url = requestState(candidate, presentation, options);
    const request = {capture: candidate.capture, query: candidate.payload.query, payload: candidate.payload,
      requestedArtist: candidate.requestedArtist || '', requestFamily: candidate.requestFamily,
      originalLifetime: options.cursor && candidate.matchLifetime?.deadline ? {
        original: candidate.matchLifetime.original, deadline: {...candidate.matchLifetime.deadline}, last: {...candidate.matchLifetime.last}} : null,
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
        if (popularityResult(candidate.payload)) return active() && popularityResult(data)
          && data.query === request.query && data.presentation === presentation
          && (candidate.payload.criteria === null || JSON.stringify(data.criteria) === JSON.stringify(candidate.payload.criteria));
        if (listenerResult(candidate.payload)) return active() && listenerResult(data)
          && data.query === request.query && data.presentation === 'tracks'
          && JSON.stringify(data.criteria) === JSON.stringify(candidate.payload.criteria)
          && data.listener?.account_ref === candidate.payload.listener.account_ref;
        return active() && data?.private_search === true && data.contract_version === 'own-love-v1'
          && data.query === request.query && data.presentation === presentation
          && JSON.stringify(data.criteria) === JSON.stringify(candidate.payload.criteria)
          && (candidate.payload.selection_state === 'pending_page'
            || (data.selected_artist || '') === (candidate.payload.selected_artist || ''));
      },
      onSettled({applied, error, requestId}) {
        if (!active() || requestId !== request.requestId || applied) return;
        if (error && !popularityResult(candidate.payload)) publish({...current, status: 'error', actionable: false, error: 'Search could not be loaded. Try a fresh search.'});
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
        ? (receiptResult(candidate.payload) ? candidate.trackSources.get(row.rowKey)?.metadata
          : candidate.trackSources.get(row.rowKey)) || null : null,
      canQueueRow: row => active() && queueRowAllowed(candidate, row) && active(),
      captureQueueRows: (selected, options) => active() && selected.length <= 100
        && selected.every(row => queueRowAllowed(candidate, row)) && active()
        ? captureQueueRows(candidate, selected, options) : null,
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
    if (receiptResult(candidate.payload)) return listenerSelectionAction(candidate, method, packet, lifetime, adapter, anchor, options);
    return window.AlbumHavenPlaytableUI?.[method]?.(packet, lifetime, adapter, anchor, options) ?? false;
  }

  // Inventory and listener receipt envelopes remain separate authority dialects.
  const nativeFailure = (message = 'This Search action is unavailable.', status = 403) => Object.assign(new Error(message), {status});
  const nativeStale = () => Object.assign(new Error('Search action was superseded.'), {name: 'AbortError'});
  const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
  function listenerEnvelope(reply, lease, version) {
    if (!exactKeys(reply, ['status', 'contract_version', 'context_ref', 'result_token', 'data'])
      || reply.status !== 'ready' || reply.contract_version !== version || reply.context_ref !== lease.capture.context
      || reply.result_token !== lease.resultToken) throw nativeFailure('Invalid Listener action response.', 409);
    return reply.data;
  }
  function listenerLease(candidate, source, kind = 'album') {
    return {capture: candidate.capture, resultToken: candidate.payload.native.result_token, rowRef: source.row_ref,
      resourceRef: source.binding?.inventory_track_ref, targetKind: kind,
      detailTarget: source.binding?.[`${kind}_target`] || null};
  }
  function listenerTarget(target, lease, intent) {
    if (intent !== 'details') return projectNativeTarget(target, lease.resourceRef, intent);
    const kind = lease.targetKind, detail = lease.detailTarget;
    if (!detail || detail.kind !== kind || detail.row_ref !== lease.rowRef) throw nativeFailure('Listener details are unavailable.');
    if (kind === 'album') {
      if (!exactKeys(target, ['album_ref', 'allowed_actions', 'title', 'artist']) || !reference(target.album_ref)
        || !exactKeys(target.allowed_actions, ['can_view_details', 'can_play_album'])
        || target.allowed_actions.can_view_details !== true || typeof target.allowed_actions.can_play_album !== 'boolean'
        || [target.title, target.artist].some(value => value !== null && text(value) === null)) throw nativeFailure('Invalid Listener Album.', 409);
      return freeze({kind, ref: lease.rowRef, identity_ref: detail.identity_ref, allowed_actions: {can_view_details: true},
        native_actions: {album_ref: target.album_ref, allowed_actions: {can_open_album: true,
          can_play_album: target.allowed_actions.can_play_album}}});
    }
    if (kind !== 'artist' || !exactKeys(target, ['artist_ref', 'title', 'allowed_actions']) || !reference(target.artist_ref)
      || target.title !== null && text(target.title) === null
      || !exactKeys(target.allowed_actions, ['can_view_details']) || target.allowed_actions.can_view_details !== true) {
      throw nativeFailure('Invalid Listener Artist.', 409);
    }
    return freeze({kind, ref: lease.rowRef, identity_ref: detail.identity_ref, allowed_actions: {can_view_details: true},
      native_actions: {artist_ref: target.artist_ref, allowed_actions: {can_open_artist_gallery: true}}});
  }
  async function readListenerNative(lease, intent, {signal, isCurrent} = {}) {
    const active = () => !signal?.aborted && nativeScopeCurrent(lease) && isCurrent() === true;
    if (!active()) throw nativeStale();
    const body = {result_token: lease.resultToken, row_ref: lease.rowRef, intent};
    if (intent === 'details') body.target_kind = lease.targetKind;
    const reply = await lease.capture.transport.request('/search/listener-native-target', {method: 'POST', body,
      expected: lease.capture.context, signal, isCurrent: active});
    if (!active()) throw nativeStale();
    const data = listenerEnvelope(reply, lease, 'listener-search-native-v1');
    if (!exactKeys(data, ['row_ref', 'intent', 'native_target']) || data.row_ref !== lease.rowRef || data.intent !== intent) {
      throw nativeFailure('Listener action identity changed.', 409);
    }
    const result = listenerTarget(data.native_target, lease, intent);
    if (!active()) throw nativeStale();
    return result;
  }
  function assertListenerBatch(reply, leases, intent) {
    const data = listenerEnvelope(reply, leases[0], 'listener-search-native-batch-v1');
    if (!exactKeys(data, ['intent', 'items']) || data.intent !== intent || !Array.isArray(data.items)
      || data.items.length !== leases.length) throw nativeFailure('Invalid Listener batch.', 409);
    return data.items.map((item, index) => {
      if (!exactKeys(item, ['row_ref', 'status', 'native_target']) || item.row_ref !== leases[index].rowRef) {
        throw nativeFailure('Listener batch identity changed.', 409);
      }
      if (item.status === 'unavailable' && item.native_target === null) return null;
      if (item.status !== 'ready') throw nativeFailure('Invalid Listener batch item.', 409);
      return listenerTarget(item.native_target, leases[index], intent);
    });
  }
  function projectListenerBindings(reply, candidate) {
    const data = listenerEnvelope(reply, {capture: candidate.capture, resultToken: candidate.payload.native.result_token},
      'listener-search-native-bindings-v1');
    const sources = [...candidate.trackSources.values()];
    if (!exactKeys(data, ['bindings']) || !Array.isArray(data.bindings) || data.bindings.length !== sources.length) {
      throw nativeFailure('Invalid Listener bindings.', 409);
    }
    return data.bindings.map((binding, index) => {
      const optional = ['album_target', 'artist_target'].filter(key => Object.hasOwn(binding || {}, key));
      if (!exactKeys(binding, ['row_ref', 'allowed_actions', 'inventory_track_ref', 'artwork_url', ...optional])
        || binding.row_ref !== sources[index].row_ref
        || !exactKeys(binding.allowed_actions, ['can_resolve_native_play', 'can_resolve_native_details', 'can_select_for_playlist'])
        || Object.values(binding.allowed_actions).some(value => typeof value !== 'boolean')
        || binding.inventory_track_ref !== null && (!trackRef(binding.inventory_track_ref)
          || binding.inventory_track_ref.split(':')[1] !== candidate.capture.library)
        || binding.artwork_url !== null && text(binding.artwork_url) === null) throw nativeFailure('Invalid Listener binding.', 409);
      for (const key of optional) {
        const target = binding[key], kind = key === 'album_target' ? 'album' : 'artist';
        if (!exactKeys(target, ['kind', 'row_ref', 'identity_ref', 'allowed_actions']) || target.kind !== kind
          || target.row_ref !== binding.row_ref || typeof target.identity_ref !== 'string'
          || !(new RegExp(`^${kind}_[a-f0-9]{64}$`)).test(target.identity_ref)
          || !exactKeys(target.allowed_actions, ['can_view_details']) || target.allowed_actions.can_view_details !== true) {
          throw nativeFailure('Invalid Listener detail binding.', 409);
        }
      }
      if (binding.allowed_actions.can_resolve_native_details !== Boolean(optional.length)
        || binding.allowed_actions.can_resolve_native_play && binding.inventory_track_ref === null) throw nativeFailure('Invalid Listener grants.', 409);
      // Artwork remains with its existing owner; B does not acquire it.
      return freeze({row_ref: binding.row_ref, inventory_track_ref: binding.inventory_track_ref,
        allowed_actions: {...binding.allowed_actions}, ...Object.fromEntries(optional.map(key => [key, binding[key]]))});
    });
  }
  function listenerFailure(candidate, error, force = false) {
    if (!owns(candidate) || error?.name === 'AbortError') return;
    if (!force && ![401, 403, 409].includes(error?.status) && error?.code !== 'stale_context') return;
    const revision = readViewStateRevision(), generation = state.ui.gallerySearchGeneration, requestId = state.ui.activeViewRequestId;
    retireAccepted(candidate, 'context');
    if (!installed() || owner || pending || readViewStateRevision() !== revision
      || state.ui.gallerySearchGeneration !== generation || state.ui.activeViewRequestId !== requestId
      || !galleryReadScopeIsCurrent(candidate.capture)) return;
    const request = {capture: candidate.capture, query: candidate.payload.query, payload: candidate.payload, requestedArtist: '', requestFamily: candidate.requestFamily,
      revision, queryGeneration: generation, requestId: null, originRequestId: Number(requestId || 0),
      url: requestState(candidate, candidate.payload.presentation), presentation: candidate.payload.presentation, options: null};
    pending = request;
    request.unsubscribe = request.capture.transport.subscribe(() => {
      if (pending === request && !galleryReadScopeIsCurrent(request.capture)) retireNativePrivateSearchView(() => pending === request, 'context');
    });
    if (!intentCurrent(request) || owner) return;
    visibilityScope = request.capture;
    publish({...current, visible: true, status: 'error', kind: popularityResult(candidate.payload) ? 'popularity' : 'listener', presentation: candidate.payload.presentation, actionable: false,
      result: null, restartRequired: error?.status === 409, error: popularityResult(candidate.payload) ? popularityErrorMessage(error?.status) : [401, 403, 409].includes(error?.status) || error?.code === 'stale_context'
        ? 'Listener Search has changed or expired. Start a fresh search.'
        : 'Listener Search actions could not be loaded. Start a fresh search.'});
  }
  async function readListenerBindings(candidate) {
    if (!owns(candidate) || !receiptResult(candidate.payload) || candidate.bindingsRead || !candidate.result.tracks.length) return false;
    const request = {controller: new AbortController()}, active = () => candidate.bindingsRead === request
      && !request.controller.signal.aborted && owns(candidate) && candidate.bindingsRead === request;
    candidate.bindingsRead = request; candidate.nativeRequests.add(request.controller);
    publish({...current, bindings: Object.freeze({status: 'loading', error: ''})});
    try {
      if (!active()) return false;
      const reply = await candidate.capture.transport.request(popularityResult(candidate.payload)
        ? '/search/popularity-native-bindings' : '/search/listener-native-bindings', {method: 'POST',
        body: popularityResult(candidate.payload)
          ? popularityBody({result_token: candidate.payload.native.result_token, row_refs: [...candidate.trackSources.values()].map(source => source.row_ref)})
          : {result_token: candidate.payload.native.result_token, row_refs: [...candidate.trackSources.values()].map(source => source.row_ref)},
        expected: candidate.capture.context, signal: request.controller.signal, isCurrent: active});
      if (!active()) return false;
      const bindings = popularityResult(candidate.payload) ? projectPopularityBindings(reply, candidate) : projectListenerBindings(reply, candidate);
      return transaction(() => {
        if (!active()) return false;
        const oldSources = [...sources]; sources.clear();
        candidate.sourceIdentity = null; candidate.resultId = ++serial;
        const detached = current = Object.freeze({...current, actionable: false, result: null,
          resultId: candidate.resultId, sourceIdentity: null});
        retireGalleryArtwork();
        for (const source of oldSources) {try {source.dispose();} catch { /* Finish exact-source retirement. */ }}
        if (!active() || current !== detached) return false;
        const tracks = candidate.result.tracks.map((row, index) => {
          const binding = bindings[index], source = candidate.trackSources.get(row.rowKey);
          source.binding = binding; source.metadata = null;
          if (popularityResult(candidate.payload)) {
            const album = binding.album_target;
            if (album && !candidate.detailAliases.has(album.identity_ref)) {
              // Allocation is independent of private coordinates/digests. Equal
              // Album bindings share one publication-local public alias.
              candidate.detailAliases.set(album.identity_ref,
                {publicRef: `search-album-${++detailAliasSerial}`, identityRef: album.identity_ref, nativeRef: null});
            }
            source.detailIdentity = album ? candidate.detailAliases.get(album.identity_ref) : null;
          }
          return {...row, selectable: popularityResult(candidate.payload)
            ? binding.allowed_actions.can_view_metadata || binding.allowed_actions.can_play
            : binding.inventory_track_ref !== null && (binding.allowed_actions.can_select_for_playlist || binding.allowed_actions.can_resolve_native_play)};
        });
        candidate.result = freeze({...candidate.result, tracks}); candidate.sourceIdentity = Object.freeze({});
        publish({...detached, status: 'ready', actionable: true, result: candidate.result,
          sourceIdentity: candidate.sourceIdentity, bindings: Object.freeze({status: 'ready', error: ''})});
        return active();
      });
    } catch (error) {
      if (!active()) return false;
      listenerFailure(candidate, error);
      if (active()) publish({...current, bindings: Object.freeze({status: 'error', error: 'Track actions could not be loaded. Try again.'})});
      return false;
    } finally {
      candidate.nativeRequests.delete(request.controller);
      if (candidate.bindingsRead === request) candidate.bindingsRead = null;
    }
  }
  function nativeRequestUrl(payload, view) {
    const built = new URL(buildApiUrl({...view, query: payload.query, selected_artist: payload.selected_artist || '',
      all_artists_active: payload.selection_state === 'all_artists', surface: {active: 'albums'}, surface_request: 'albums'}), window.location.href);
    const params = new URLSearchParams();
    for (const [key, value] of built.searchParams) if (['q', 'surface', 'artist', 'all_artists', 'gallery_scope', 'category'].includes(key)) params.append(key, value);
    params.set('search_presentation', payload.presentation);
    return `/search/native-target?${params}`;
  }
  function nativeRow(snapshot, row) {
    const candidate = owner;
    if (!isCurrent(snapshot) || !candidate || !candidate.result.tracks.includes(row)) return null;
    return candidate.trackSources.get(row.rowKey) || null;
  }
  function nativeAlbum(snapshot, row) {
    const candidate = owner;
    if (!isCurrent(snapshot) || !candidate) return null;
    if (popularityAlbumsResult(candidate.payload)) {
      const source = candidate.result.albums.includes(row) && candidate.albumSources.get(row.albumRef);
      return source ? {dialect: 'popularity-albums', capture: candidate.capture, resultToken: candidate.payload.native.result_token,
        rowRef: source.row_ref, resourceRef: source.row_ref, albumRef: source.publicRef, albumIdentity: source, candidate} : null;
    }
    if (receiptResult(candidate.payload)) {
      const source = candidate.result.tracks.includes(row) && candidate.trackSources.get(row.rowKey);
      return source?.binding?.album_target ? {...receiptLease(candidate, source),
        resourceRef: source.row_ref, albumRef: popularityResult(candidate.payload) ? source.detailIdentity?.publicRef : source.row_ref} : null;
    }
    if (candidate.result.tracks.includes(row)) {
      const source = candidate.trackSources.get(row.rowKey), album = candidate.albumSources.get(row.albumRef);
      return source && album?.canOpen === true
        ? {resourceRef: source.inventory_track_ref, albumRef: row.albumRef} : null;
    }
    return candidate.result.albums.includes(row) && row.canOpen === true
      ? {resourceRef: row.albumRef, albumRef: row.albumRef} : null;
  }
  const nativeScopeCurrent = lease => installed() && galleryReadScopeIsCurrent(lease.capture);
  function assertNativeReply(reply, resourceRef, intent, parentRef) {
    if (!exactKeys(reply, ['status', 'contract_version', 'context_ref', 'data']) || reply.status !== 'ready'
      || reply.contract_version !== 'own-love-native-v1') throw nativeFailure('Invalid Search action response.', 409);
    const data = reply.data, trackDetails = intent === 'details' && Boolean(trackRef(resourceRef));
    if (!exactKeys(data, ['resource_ref', 'intent', 'native_target', ...(trackDetails ? ['parent_album_ref'] : [])])
      || data.resource_ref !== resourceRef || data.intent !== intent
      || trackDetails && data.parent_album_ref !== parentRef) throw nativeFailure('Search action identity changed.', 409);
    return projectNativeTarget(data.native_target, resourceRef, intent, parentRef);
  }
  function projectNativeTarget(target, resourceRef, intent, parentRef) {
    if (intent === 'metadata') {
      const preference = target?.track_preference, canonical = target?.canonical_track_ref;
      if (!exactKeys(target, ['inventory_track_ref', 'track_ref', 'canonical_track_ref', 'source_readable',
        'title', 'artist', 'album_title', 'duration_seconds', 'availability', 'allowed_actions', 'playback_state', 'track_preference'])
        || target.inventory_track_ref !== resourceRef || target.source_readable !== true
        || canonical !== null && !reference(canonical) || target.track_ref !== canonical
        || ['title', 'artist', 'album_title'].some(key => target[key] !== null && text(target[key]) === null)
        || target.duration_seconds !== null && (!Number.isFinite(target.duration_seconds) || target.duration_seconds < 0)
        || !['local', 'missing', 'unresolved', 'unknown'].includes(target.availability)
        || !exactKeys(target.allowed_actions, ['can_read', 'can_play']) || target.allowed_actions.can_read !== true
        || typeof target.allowed_actions.can_play !== 'boolean'
        || !exactKeys(target.playback_state, ['can_start_here'])
        || target.playback_state.can_start_here !== target.allowed_actions.can_play
        || target.playback_state.can_start_here && target.availability !== 'local'
        || (canonical === null ? preference !== null
          : !exactKeys(preference, ['love_tier', 'rating', 'allowed_actions'])
            || !TrackActionsRuntime.overlay(preference)
            || !exactKeys(preference.allowed_actions, ['client_surface_class', 'can_rate', 'can_set_love_tier'])
            || preference.allowed_actions.client_surface_class !== 'private_web'
            || typeof preference.allowed_actions.can_rate !== 'boolean'
            || typeof preference.allowed_actions.can_set_love_tier !== 'boolean')) {
        throw nativeFailure('Invalid Search metadata target.', 409);
      }
      return freeze({...target, title: target.title || '', artist: target.artist || '', album_title: target.album_title || ''});
    }
    if (intent === 'play') {
      if (!exactKeys(target, ['inventory_track_ref', 'track_ref', 'path', 'title', 'artist', 'album_title', 'duration_seconds'])
        || target.inventory_track_ref !== resourceRef || text(target.path) === null || !target.path
        || target.track_ref !== target.path || ['title', 'artist', 'album_title'].some(key => target[key] !== null && text(target[key]) === null)
        || target.duration_seconds !== null && (!Number.isFinite(target.duration_seconds) || target.duration_seconds < 0)) {
        throw nativeFailure('Invalid Search playback target.', 409);
      }
      // This grant is derived only from this exact, freshly authorized play
      // response. Browse metadata and local availability never reach this seam.
      return Object.freeze({...target, title: target.title || '', artist: target.artist || '', album_title: target.album_title || '',
        playback_state: Object.freeze({can_start_here: true})});
    }
    if (!exactKeys(target, ['album_ref', 'allowed_actions']) || !reference(target.album_ref)
      || !exactKeys(target.allowed_actions, ['can_view_details', 'can_play_album'])
      || target.allowed_actions.can_view_details !== true || typeof target.allowed_actions.can_play_album !== 'boolean') {
      throw nativeFailure('Invalid Search Album target.', 409);
    }
    return Object.freeze({kind: 'album', ref: parentRef, allowed_actions: Object.freeze({can_view_details: true}),
      native_actions: Object.freeze({album_ref: target.album_ref, allowed_actions: Object.freeze({
        can_open_album: true, can_play_album: target.allowed_actions.can_play_album})})});
  }
  async function readNative(lease, intent, {signal, isCurrent, witnessLifetime = true} = {}) {
    if (lease.dialect === 'popularity-albums') return readPopularityAlbumNative(lease, intent, {signal, isCurrent, witnessLifetime});
    if (lease.dialect === 'popularity') return readPopularityNative(lease, intent, {signal, isCurrent});
    if (lease.resultToken) return readListenerNative(lease, intent, {signal, isCurrent});
    const current = () => !signal?.aborted && nativeScopeCurrent(lease) && isCurrent() === true;
    if (!current()) throw nativeStale();
    const reply = await lease.capture.transport.request(lease.url, {method: 'POST',
      body: {resource_ref: lease.resourceRef, intent}, expected: lease.capture.context, signal, isCurrent: current});
    if (!current()) throw nativeStale();
    const target = assertNativeReply(reply, lease.resourceRef, intent, lease.albumRef);
    if (!current()) throw nativeStale();
    return target;
  }
  function assertNativeBatch(reply, leases, intent) {
    if (!exactKeys(reply, ['status', 'contract_version', 'context_ref', 'data']) || reply.status !== 'ready'
      || reply.contract_version !== 'own-love-native-batch-v1'
      || !exactKeys(reply.data, ['intent', 'results']) || reply.data.intent !== intent
      || !Array.isArray(reply.data.results) || reply.data.results.length !== leases.length) {
      throw nativeFailure('Invalid Search batch response.', 409);
    }
    // Project the entire exact response before releasing any per-row callback.
    // A truncated, reordered or malformed batch cannot partly admit preferences.
    return reply.data.results.map((entry, index) => {
      const lease = leases[index];
      if (entry?.resource_ref !== lease.resourceRef) throw nativeFailure('Search batch identity changed.', 409);
      if (entry.status === 'unavailable' && exactKeys(entry, ['resource_ref', 'status'])) return null;
      if (entry.status !== 'ready' || !exactKeys(entry, ['resource_ref', 'status', 'native_target'])) {
        throw nativeFailure('Invalid Search batch item.', 409);
      }
      return assertNativeReply({status: 'ready', contract_version: 'own-love-native-v1', context_ref: reply.context_ref,
        data: {resource_ref: lease.resourceRef, intent, native_target: entry.native_target}}, lease.resourceRef, intent, lease.albumRef);
    });
  }
  function queueBatchReader(capture, nativeUrl, resultToken = null, popularity = false) {
    const pending = new Map(), base = {capture}, url = resultToken ? (popularity ? '/search/popularity-native-targets' : '/search/listener-native-targets')
      : nativeUrl.replace('/search/native-target?', '/search/native-targets?');
    const live = () => nativeScopeCurrent(base);
    return (lease, intent, {signal} = {}) => {
      if (!live() || signal?.aborted || !['metadata', 'play'].includes(intent)) return Promise.reject(nativeStale());
      // The real Queue gives each admission/refresh/start its own signal. A
      // caller without one cannot accidentally join another operation's batch.
      const requestSignal = signal || new AbortController().signal;
      let modes = pending.get(requestSignal);
      if (!modes) {modes = new Map(); pending.set(requestSignal, modes);}
      let batch = modes.get(intent);
      if (!batch) {
        batch = {entries: new Map(), settled: false}; modes.set(intent, batch);
        const detach = () => {
          if (modes.get(intent) === batch) modes.delete(intent);
          if (!modes.size && pending.get(requestSignal) === modes) pending.delete(requestSignal);
        };
        const current = () => !requestSignal.aborted && live();
        const finish = (error, targets) => {
          if (batch.settled) return;
          batch.settled = true; detach(); requestSignal.removeEventListener('abort', cancel);
          for (const [index, entry] of [...batch.entries.values()].entries()) {
            for (const caller of entry.callers) {
              if (!current()) caller.reject(nativeStale());
              else if (error) caller.reject(error);
              else if (!targets[index]) caller.reject(nativeFailure('This queued Search source is unavailable.'));
              else caller.resolve(targets[index]);
            }
          }
        };
        const cancel = () => finish(nativeStale());
        requestSignal.addEventListener('abort', cancel, {once: true});
        Promise.resolve().then(async () => {
          // Only calls already queued in this turn share this response. Later
          // refreshes cannot consume a settled target or revive removed rows.
          detach();
          if (batch.settled) return;
          if (!current()) {finish(nativeStale()); return;}
          const leases = [...batch.entries.values()].map(entry => entry.lease);
          if (!leases.length || leases.length > 100) {finish(nativeFailure('Invalid Search batch size.', 409)); return;}
          try {
            const reply = await capture.transport.request(url, {method: 'POST',
              body: resultToken ? (popularity
                ? popularityBody({result_token: resultToken, row_refs: leases.map(value => value.rowRef), intent})
                : {result_token: resultToken, row_refs: leases.map(value => value.rowRef), intent})
                : {resource_refs: leases.map(value => value.resourceRef), intent},
              expected: capture.context, signal: requestSignal, isCurrent: current});
            if (!current()) throw nativeStale();
            const targets = resultToken ? (popularity ? assertPopularityBatch(reply, leases, intent) : assertListenerBatch(reply, leases, intent))
              : assertNativeBatch(reply, leases, intent);
            if (!current()) throw nativeStale();
            if (popularity) {
              // Recheck every first identity before committing any, including reentrant overlay callbacks.
              targets.forEach((target, index) => {
                if (target && leases[index].identity.resourceRef !== null && leases[index].identity.resourceRef !== target.inventory_track_ref) {
                  throw nativeFailure('Popularity track identity changed.', 409);
                }
              });
              targets.forEach((target, index) => commitPopularityIdentity(leases[index], target, intent));
            }
            finish(null, targets);
          } catch (error) {finish(current() ? error : nativeStale());}
        });
      }
      return new Promise((resolve, reject) => {
        if (batch.settled || !live() || requestSignal.aborted) {reject(nativeStale()); return;}
        if (resultToken && (lease.resultToken !== resultToken || lease.capture !== capture || (popularity ? lease.dialect !== 'popularity' || !popularityRowRef(lease.rowRef) : !listenerRowRef(lease.rowRef)))) {
          reject(nativeFailure('Invalid Listener batch source.', 409)); return;
        }
        const key = resultToken ? lease.rowRef : lease.resourceRef;
        let entry = batch.entries.get(key);
        if (!entry) {entry = {lease, callers: []}; batch.entries.set(key, entry);}
        entry.callers.push({resolve, reject});
      });
    };
  }
  const listenerQueueBatchReader = (capture, resultToken) => queueBatchReader(capture, null, resultToken);
  const receiptBatchReader = candidate => popularityResult(candidate.payload)
    ? queueBatchReader(candidate.capture, null, candidate.payload.native.result_token, true)
    : listenerQueueBatchReader(candidate.capture, candidate.payload.native.result_token);
  async function listenerSelectionAction(candidate, method, packet, lifetime, adapter, anchor, options) {
    const keys = packet?.row_keys, identity = candidate.sourceIdentity;
    const selected = Array.isArray(keys) && keys.length >= 1 && keys.length <= 100 && new Set(keys).size === keys.length
      ? keys.map(key => candidate.result.tracks.find(row => row.rowKey === key)) : [];
    if (!selected.length || selected.some(row => !row || !row.selectable) || packet.scopeKey !== candidate.scopeKey) return false;
    const controller = new AbortController(); candidate.nativeRequests.add(controller);
    const cancel = () => controller.abort();
    let unsubscribe = null;
    const active = () => {
      try {return !controller.signal.aborted && owns(candidate) && candidate.sourceIdentity === identity
        && lifetime?.isCurrent?.() === true && adapter?.snapshot?.()?.instance === identity && owns(candidate);}
      catch {return false;}
    };
    try {
      lifetime?.signal?.addEventListener('abort', cancel, {once: true});
      unsubscribe = lifetime?.subscribeInvalidation?.(cancel) || null;
      if (!active()) return false;
      const batch = receiptBatchReader(candidate);
      const targets = await Promise.all(selected.map(row => batch(receiptLease(candidate, candidate.trackSources.get(row.rowKey)),
        'metadata', {signal: controller.signal})));
      if (!active()) return false;
      // Nothing reaches the inventory adapter until every selected row has a
      // fresh receipt-authorized metadata result and the same live selection.
      selected.forEach((row, index) => {candidate.trackSources.get(row.rowKey).metadata = targets[index];});
      if (!active()) return false;
      return window.AlbumHavenPlaytableUI?.[method]?.(packet, lifetime, adapter, anchor, options) ?? false;
    } catch (error) {
      if (active()) listenerFailure(candidate, error, true);
      return false;
    } finally {
      lifetime?.signal?.removeEventListener('abort', cancel);
      try {unsubscribe?.();} catch { /* Cleanup cannot grant a retired selection. */ }
      candidate.nativeRequests.delete(controller);
    }
  }
  function sourceReference(candidate, source) {
    return receiptResult(candidate.payload) ? source?.row_ref : source?.inventory_track_ref;
  }
  function queueRowAllowed(candidate, row) {
    return candidate.result.tracks.includes(row) && row.readable === true && row.selectable === true
      && candidate.trackSources.has(row.rowKey)
      && (!receiptResult(candidate.payload) || (popularityResult(candidate.payload)
        ? candidate.trackSources.get(row.rowKey)?.binding?.allowed_actions.can_play === true
        : candidate.trackSources.get(row.rowKey)?.binding?.allowed_actions.can_resolve_native_play === true))
      && !candidate.nativeDenied.has(`${sourceReference(candidate, candidate.trackSources.get(row.rowKey))}:play`)
      && (!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows?.('library.media.read') === true);
  }
  function captureQueueRows(candidate, selected, {signal} = {}) {
    if (!owns(candidate) || signal?.aborted || !selected.length || selected.length > 100
      || new Set(selected).size !== selected.length || !selected.every(row => queueRowAllowed(candidate, row))) return null;
    const capture = candidate.capture, url = candidate.nativeUrl, listener = receiptResult(candidate.payload), popularity = popularityResult(candidate.payload);
    const batch = listener ? receiptBatchReader(candidate) : queueBatchReader(capture, url);
    const captures = selected.map(row => {
      // Keep no visible candidate/source owner in the transferred callbacks.
      // Queue admission itself retains the original selection lifetime until
      // append; a successfully admitted source survives Search navigation.
      const source = candidate.trackSources.get(row.rowKey);
      const lease = Object.freeze(listener ? receiptLease(candidate, source) : {capture, url,
        resourceRef: source.inventory_track_ref, albumRef: row.albumRef});
      const details = listener ? source.binding : null;
      const display = Object.freeze({title: row.title, artist: row.artist, album: row.album});
      const current = () => nativeScopeCurrent(lease);
      return Object.freeze({display, isCurrent: current,
        resolveMetadata: options => batch(lease, 'metadata', options),
        async resolve(options) {
          const target = await batch(lease, 'play', options);
          if (!current() || options?.signal?.aborted) throw nativeStale();
          // These Queue-facing facts derive only from the exact fresh Play
          // response, never from captured labels or a metadata availability bit.
          return Object.freeze({...target, source_readable: true, availability: 'local',
            allowed_actions: Object.freeze({can_read: true, can_play: true})});
        },
        async resolvePlaylistItem(options) {
          const target = await batch(lease, 'metadata', options);
          if (!current() || options?.signal?.aborted) throw nativeStale();
          return Object.freeze({...target,
            source_provenance: Object.freeze({kind: 'inventory', track_ref: popularity ? target.inventory_track_ref : lease.resourceRef})});
        },
        async resolveDetails(kind, {signal: detailSignal} = {}) {
          // Queue probes both resource kinds. Unsupported Artist projection is
          // not evidence that this independently readable track was revoked.
          if (listener ? !(popularity ? ['album'] : ['album', 'artist']).includes(kind) || !details?.[`${kind}_target`] : kind !== 'album') {
            throw new Error('This queued Search source has no authorized detail target.');
          }
          const active = () => !detailSignal?.aborted && current();
          const detailLease = listener ? {...lease, targetKind: kind, detailTarget: details[`${kind}_target`]} : lease;
          const target = await readNative(detailLease, 'details', {signal: detailSignal, isCurrent: active});
          if (!active()) throw nativeStale();
          return Object.freeze({target, data: Object.freeze({kind, ref: popularity ? target.ref : listener ? lease.rowRef : lease.albumRef,
            title: kind === 'album' ? display.album : display.artist, artist: display.artist,
            metadata_state: 'last_known', source_label: 'Local library', tracks: null}),
            isCurrent: current});
        }});
    });
    return owns(candidate) && !signal?.aborted ? Object.freeze(captures) : null;
  }
  function nativeRejected(candidate, resourceRef, intent, error, {presentationOperation = false} = {}) {
    if (!owns(candidate) || error?.name === 'AbortError') return;
    // A failed staged/open/artwork operation admits no new native or witness
    // result. It cannot revoke an independently committed predecessor merely
    // because its own transport failed. Actual authority/source failures still
    // retire the full receipt; all other receipt action paths keep v1 behavior.
    if (presentationOperation && intent === 'details' && popularityResult(candidate.payload)
      && ![401, 403, 409].includes(error?.status) && error?.code !== 'stale_context') return;
    if (receiptResult(candidate.payload)) {listenerFailure(candidate, error, true); return;}
    if (intent === 'play') candidate.nativeTracks.delete(resourceRef);
    if (intent === 'details') {
      const binding = candidate.nativeAlbums.get(resourceRef);
      if (binding) {binding.revoked = true; candidate.nativeAlbums.delete(resourceRef);}
    }
    if ([401, 403, 404].includes(error?.status)) candidate.nativeDenied.add(`${resourceRef}:${intent}`);
    resourceSelection?.invalidateResourceSelections();
    if (error?.status === 401 || error?.code === 'stale_context') retireAccepted(candidate, 'context');
    else if (owns(candidate)) notify();
  }
  function canPlayTrack(snapshot, row) {
    const source = nativeRow(snapshot, row), candidate = owner;
    return Boolean(source && candidate
      && (!receiptResult(candidate.payload) || (popularityResult(candidate.payload) ? source.binding?.allowed_actions.can_play === true
        : source.binding?.allowed_actions.can_resolve_native_play === true))
      && !candidate.nativeDenied.has(`${sourceReference(candidate, source)}:play`)
      && (!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows?.('library.media.read') === true));
  }
  function trackPlayback(snapshot, row) {
    const source = nativeRow(snapshot, row), target = source && owner.nativeTracks.get(sourceReference(owner, source));
    return target ? TrackActionsRuntime.playback(target) : Object.freeze({isCurrent: false, isPlaying: false});
  }
  async function playTrack(snapshot, row) {
    if (!canPlayTrack(snapshot, row)) throw nativeFailure();
    const candidate = owner, source = nativeRow(snapshot, row);
    const playerToken = typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null;
    const sequence = ++candidate.playSequence, controller = new AbortController(), previous = candidate.playRequest;
    candidate.playRequest = controller; candidate.nativeRequests.add(controller); previous?.abort();
    const current = () => owns(candidate) && candidate.playRequest === controller && candidate.playSequence === sequence
      && candidate.result.tracks.includes(row) && !controller.signal.aborted
      && playerToken === (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null);
    try {
      const lease = receiptResult(candidate.payload) ? receiptLease(candidate, source)
        : {capture: candidate.capture, url: candidate.nativeUrl, resourceRef: source.inventory_track_ref, albumRef: row.albumRef};
      const target = await readNative(lease, 'play', {signal: controller.signal, isCurrent: current});
      if (!current() || !TrackActionsRuntime.canPlay(target) || !current()) throw nativeStale();
      candidate.nativeTracks.set(sourceReference(candidate, source), target);
      TrackActionsRuntime.play(target);
      if (owns(candidate)) TrackActionsRuntime.syncPlayback();
      return true;
    } catch (error) {
      if (current()) nativeRejected(candidate, sourceReference(candidate, source), 'play', error);
      throw error;
    } finally {
      candidate.nativeRequests.delete(controller);
      if (candidate.playRequest === controller) candidate.playRequest = null;
    }
  }
  let detailSequence = 0, resourceSelection = null;
  const bindingCurrent = binding => !binding.revoked && owns(binding.candidate)
    && (binding.artworkOnly === true || binding.candidate.nativeAlbums.get(binding.resourceRef) === binding) && nativeScopeCurrent(binding)
    && binding.actionCurrent() === true;
  function bindingSource(selection, context) {
    const binding = context?.searchBinding;
    return binding && context.scopeKey === binding.scopeKey && bindingCurrent(binding)
      && selection?.kind === 'album' && selection.ref === binding.albumRef && selection.origin == null
      ? binding.target : null;
  }
  async function authorizeBinding(selection, context) {
    const binding = context?.searchBinding;
    if (!bindingSource(selection, context)) throw nativeStale();
    const current = () => bindingCurrent(binding) && !context.signal?.aborted;
    try {
      const target = await readNative(binding, 'details', {signal: context.signal, isCurrent: current});
      if (!current()) throw nativeStale();
      if (target.native_actions.album_ref !== binding.target.native_actions.album_ref) throw nativeFailure('Search Album identity changed.', 409);
      binding.target = target;
    } catch (error) {
      if (current()) nativeRejected(binding.candidate, binding.resourceRef, 'details', error, {presentationOperation: true});
      throw error;
    }
  }
  // G1 witnesses are private presentation leases, never native/preference authority.
  let matchAttemptSerial = 0, matchPageSerial = 0, matchSlotSerial = 0, matchFrame = null, matchRequest = null;
  const matchPresentations = new Set(), stagedSearchAttempts = new WeakMap();
  let matchPageSuspended = false, matchNotificationsAttached = false, matchViewport = null;
  const matchClass = 'album-track-table__row--search-match';
  function searchLifetimeStart() {
    try {const mono = window.performance?.now?.(), wall = Date.now();
      return Number.isFinite(mono) && mono >= 0 && Number.isFinite(wall) && wall >= 0 ? {mono, wall} : null;
    } catch {return null;}
  }
  function retireSearchLifetime(holder) {
    if (!holder || holder.retired) return;
    holder.retired = true;
    const timer = holder.timer; holder.timer = null;
    if (timer !== null && timer !== undefined) clearTimeout(timer);
    for (const presentation of [...matchPresentations]) if (presentation.lifetime === holder) presentation.handle.dispose('expiry');
    holder.onRetire?.();
  }
  function searchLifetimeCurrent(holder) {
    if (!holder || holder.retired) return false;
    const now = searchLifetimeStart();
    if (!now) {retireSearchLifetime(holder); return false;}
    if (!holder.deadline) return true; // v1 first-witness bootstrap remains unmarked.
    const prior = holder.last;
    if (now.mono < prior.mono || now.wall < prior.wall
      || Math.abs((now.wall - prior.wall) - (now.mono - prior.mono)) > 1000
      || now.mono >= holder.deadline.mono || now.wall >= holder.deadline.wall) {
      retireSearchLifetime(holder); return false;
    }
    holder.last = now;
    return true;
  }
  function validSearchLifetime(value) {
    return exactKeys(value, ['issued_at', 'expires_at', 'server_now'])
      && [value.issued_at, value.expires_at, value.server_now].every(safeCount)
      && value.expires_at === value.issued_at + 1800 && value.issued_at <= value.server_now && value.server_now < value.expires_at;
  }
  function admitSearchLifetime(holder, value, start) {
    if (!holder || holder.retired || !start || !exactKeys(value, ['issued_at', 'expires_at', 'server_now'])
      || ![value.issued_at, value.expires_at, value.server_now].every(safeCount)
      || value.expires_at !== value.issued_at + 1800 || value.issued_at > value.server_now
      || value.server_now >= value.expires_at) throw nativeFailure('Invalid Search lifetime.', 502);
    if (holder.original && (holder.original[0] !== value.issued_at || holder.original[1] !== value.expires_at)) {
      retireSearchLifetime(holder); throw nativeFailure('Search lifetime changed. Restart search.', 409);
    }
    const budget = Math.max(0, (value.expires_at - value.server_now - 1) * 1000), now = searchLifetimeStart();
    if (!now || now.mono < start.mono || now.wall < start.wall
      || Math.abs((now.wall - start.wall) - (now.mono - start.mono)) > 1000 || !searchLifetimeCurrent(holder)) {
      retireSearchLifetime(holder); throw nativeFailure('Search clock changed. Restart search.', 409);
    }
    const deadline = {mono: Math.min(holder.deadline?.mono ?? Infinity, start.mono + budget),
      wall: Math.min(holder.deadline?.wall ?? Infinity, start.wall + budget)};
    holder.original ||= Object.freeze([value.issued_at, value.expires_at]);
    holder.deadline = deadline; holder.last = now; holder.admitted = true;
    if (!budget || !searchLifetimeCurrent(holder)) {retireSearchLifetime(holder); throw nativeFailure('Restart search.', 409);}
    if (holder.timer != null) clearTimeout(holder.timer);
    const timer = setTimeout(() => {
      if (holder.timer !== timer) return;
      holder.timer = null; retireSearchLifetime(holder);
    }, Math.max(0, Math.min(deadline.mono - now.mono, deadline.wall - now.wall)));
    holder.timer = timer;
  }
  function clearMatchPaint(presentation) {
    for (const node of presentation.render?.nodes || []) {
      node.classList.remove(matchClass); node.removeAttribute('data-track-search-match');
    }
    presentation.status?.remove(); presentation.status = null;
  }
  function cancelMatchRequest(request, reason, failed = false) {
    if (!request || request.control.cancelReason) return;
    request.control.cancelReason = reason;
    if (matchRequest === request) matchRequest = null;
    for (const entry of request.entries) if (entry.state === 'pending' && entry.pendingOwner === request) {
      entry.state = 'unchecked'; entry.pendingOwner = null; entry.failed = failed;
    }
    request.controller.abort();
  }
  function matchVisible(presentation, node) {
    if (document.hidden || matchPageSuspended || !presentation.committed || !presentation.handle.isCurrent()
      || !presentation.render || !node.isConnected || !presentation.render.list.contains(node)
      || presentation.nodes.get(node)?.receipt !== presentation.render) return false;
    const dialog = presentation.render.list.closest('.track-modal-dialog');
    if (!dialog || !dialog.isConnected) return false;
    const embed = typeof getTrackModalSelectionLease === 'function' ? getTrackModalSelectionLease() : null;
    if (embed && (!embed.isCurrent() || embed.dialog !== dialog || !embed.dialog.contains(node))) return false;
    const vv = window.visualViewport;
    const rectangle = vv ? {left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height}
      : {left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight};
    if (!Object.values(rectangle).every(Number.isFinite) || rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top) return false;
    const row = node.getBoundingClientRect();
    let left = Math.max(row.left, rectangle.left), right = Math.min(row.right, rectangle.right),
      top = Math.max(row.top, rectangle.top), bottom = Math.min(row.bottom, rectangle.bottom);
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (ancestor.hidden || ancestor.hasAttribute('inert') || style.display === 'none' || style.visibility === 'hidden') return false;
      if (ancestor !== node && /(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
        const clip = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX}`)) {left = Math.max(left, clip.left); right = Math.min(right, clip.right);}
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) {top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);}
      }
    }
    return right > left && bottom > top;
  }
  function matchEntries(presentation) {
    const list = presentation.render?.list;
    return list ? [...list.querySelectorAll('.album-track-table__row')].map(node => ({node, association: presentation.nodes.get(node)}))
      .filter(row => row.association?.receipt === presentation.render) : [];
  }
  function paintMatches(presentation) {
    clearMatchPaint(presentation);
    if (!presentation.handle.isCurrent() || document.hidden || matchPageSuspended || !presentation.render) return;
    const rows = matchEntries(presentation), visible = rows.filter(row => matchVisible(presentation, row.node));
    if (!visible.length) return;
    let checked = 0, unavailable = 0, matches = 0;
    for (const {node, association} of rows) {
      const entry = association.entry;
      if (presentation.lifetime.admitted && presentation.lifetime.deadline && entry?.state === 'known') {checked++; if (entry.value) {matches++; node.classList.add(matchClass); node.setAttribute('data-track-search-match', 'true');}}
      else if (!entry || entry.state === 'unavailable') unavailable++;
    }
    const status = document.createElement('div'); status.setAttribute('role', 'status');
    const total = presentation.render.rows.length;
    status.textContent = checked === total && !matches && total ? 'No matching tracks'
      : `${matches ? 'Matches among checked tracks' : 'No matches among checked tracks'} · ${checked} of ${total} rendered rows checked · ${unavailable} unavailable`;
    if (visible.every(row => row.association.entry?.state === 'known')) status.textContent += ' · Visible matches checked';
    if (rows.some(row => row.association.entry?.failed)) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry matches';
      retry.addEventListener('click', () => {if (!presentation.handle.isCurrent()) return;
        for (const entry of presentation.entries.values()) entry.failed = false;
        scheduleMatches();}); status.append(retry);
    }
    presentation.render.list.append(status); presentation.status = status;
  }
  function scheduleMatches() {
    if (matchFrame !== null || !matchPresentations.size) return;
    matchFrame = window.requestAnimationFrame(runMatches);
  }
  async function dispatchMatches(presentation, entries) {
    const render = presentation.render, start = searchLifetimeStart();
    if (!start || !presentation.handle.isCurrent() || !entries.length) return;
    const controller = new AbortController(), page = `search-detail-page-${++matchPageSerial}`;
    const rows = entries.map(entry => ({slot: `search-detail-row-${++matchSlotSerial}`, inventory_track_ref: entry.ref}));
    const request = Object.freeze({presentation, render, controller, entries: Object.freeze(entries),
      rows: Object.freeze(rows), page, start: Object.freeze(start), control: {cancelReason: null}});
    matchRequest = request;
    for (const entry of entries) {entry.state = 'pending'; entry.pendingOwner = request;}
    const owned = () => matchRequest === request && !request.control.cancelReason && presentation.handle.isCurrent()
      && presentation.render === render && entries.every(entry => entry.state === 'pending' && entry.pendingOwner === request);
    try {
      const reply = await presentation.binding.capture.transport.request('/search/popularity-album-matches', {
        method: 'POST', body: popularityBody({source: presentation.source, native_album_ref: presentation.nativeKey, page_key: page, rows}, 98304),
        expected: presentation.binding.capture.context, signal: controller.signal, isCurrent: owned});
      if (!owned()) {cancelMatchRequest(request, 'obsolete'); return;}
      if (!exactKeys(reply, ['private_search', 'contract_version', 'context_ref', 'page_key', 'data', 'lifetime'])
        || reply.private_search !== true || reply.contract_version !== 'popularity-search-album-matches-v1'
        || reply.context_ref !== presentation.binding.capture.context || reply.page_key !== page
        || !exactKeys(reply.data, ['items']) || !Array.isArray(reply.data.items) || reply.data.items.length !== rows.length
        || reply.data.items.some((item, index) => !exactKeys(item, ['slot', 'match_state', 'matches_search'])
          || item.slot !== rows[index].slot || !['known', 'unavailable'].includes(item.match_state)
          || (item.match_state === 'known' ? typeof item.matches_search !== 'boolean' : item.matches_search !== null))) {
        throw nativeFailure('Invalid match response.', 502);
      }
      admitSearchLifetime(presentation.lifetime, reply.lifetime, start);
      if (!owned()) {cancelMatchRequest(request, 'obsolete'); return;}
      // Validate the whole vector before atomic publication, then detach R.
      matchRequest = null;
      entries.forEach((entry, index) => {entry.state = reply.data.items[index].match_state;
        entry.value = reply.data.items[index].matches_search; entry.pendingOwner = null; entry.failed = false;});
      paintMatches(presentation); scheduleMatches();
    } catch (failure) {
      if (request.control.cancelReason) return;
      if (!owned()) {cancelMatchRequest(request, 'obsolete'); scheduleMatches(); return;}
      if ([401, 403, 409].includes(failure?.status)) {retireSearchLifetime(presentation.lifetime); return;}
      cancelMatchRequest(request, 'failure', true); paintMatches(presentation);
    } finally {
      // Never detach a successor installed by an abort observer.
      if (matchRequest === request) cancelMatchRequest(request, 'settled');
    }
  }
  function runMatches() {
    matchFrame = null;
    const presentations = [...matchPresentations].reverse();
    for (const presentation of presentations) {
      if (!presentation.handle.isCurrent()) {presentation.handle.dispose('stale'); continue;}
      const rows = matchEntries(presentation), visible = rows.filter(row => matchVisible(presentation, row.node));
      if (!visible.length) {clearMatchPaint(presentation);
        if (matchRequest?.presentation === presentation) cancelMatchRequest(matchRequest, 'hidden'); continue;}
      if (matchRequest) {
        const request = matchRequest;
        if (request.presentation !== presentation || !visible.some(row => request.entries.includes(row.association.entry))) {
          cancelMatchRequest(request, request.presentation !== presentation ? 'foreground' : 'offscreen');
        } else return;
      }
      paintMatches(presentation);
      const entries = [...new Set(visible.map(row => row.association.entry).filter(entry => entry?.state === 'unchecked' && !entry.failed))].slice(0, 100);
      if (entries.length) void dispatchMatches(presentation, entries);
      return; // Foreground presentation alone wins this frame.
    }
  }
  function beginSearchAlbumPresentation(selection, context, {intent, signal, isCurrent} = {}) {
    const binding = context?.searchBinding;
    if (intent === 'artwork' || !['embed', 'open', 'page', 'replay'].includes(intent)
      || !binding || !popularityResult(binding.candidate?.payload)) return null;
    if (!owns(binding.candidate) || binding.candidate.matchLifetime?.retired) return null; // Historical native replay stays unmarked.
    if (intent !== 'replay' && binding.presentationAttempt?.isCurrent() && !binding.presentationAttempt.isCommitted()) {
      stagedSearchAttempts.get(binding.presentationAttempt).guard = isCurrent;
      return binding.presentationAttempt;
    }
    const candidate = binding.candidate;
    const lifetime = candidate.matchLifetime ||= {timer: null, retired: false};
    const presentation = {serial: ++matchAttemptSerial, binding, lifetime, guard: isCurrent, committed: false, disposed: false,
      album: null, nativeKey: null, originals: new WeakSet(), originalSources: new WeakSet(), entries: new Map(), trackEntries: new WeakMap(),
      nodes: new WeakMap(), renderGeneration: 0, render: null, observer: null, status: null,
      source: Object.freeze(binding.dialect === 'popularity-albums'
        ? {kind: 'album-publication', result_token: binding.resultToken, album_ref: binding.rowRef}
        : {kind: 'track-publication', result_token: binding.resultToken, row_ref: binding.rowRef})};
    const currentAttempt = () => !presentation.disposed && installed() && !binding.revoked
      && nativeScopeCurrent(binding) && owns(candidate)
      // An operation serial supersedes staging only. A failed successor cannot
      // revoke an already committed exact presentation and its source receipt.
      && (presentation.committed ? matchPresentations.has(presentation)
        && SearchAlbumPresentationProvenance.attempt(getCurrentTrackModalAlbum()) === handle
        : !signal?.aborted && presentation.guard?.() === true)
      && searchLifetimeCurrent(lifetime);
    const handle = Object.freeze({
      isCurrent: currentAttempt,
      isCommitted: () => presentation.committed && !presentation.disposed,
      async prepare(album) {
        SearchAlbumPresentationProvenance.mark(album);
        try {
          if (!currentAttempt() || !album || String(album.key || album.album_ref || '') !== binding.target?.native_actions?.album_ref) throw nativeStale();
          presentation.album = album; presentation.nativeKey = String(album.key || album.album_ref || '');
          for (const track of Array.isArray(album.tracks) ? album.tracks : []) if (plain(track)) presentation.originals.add(track);
          for (const source of Array.isArray(album.track_rows) ? album.track_rows : []) if (plain(source)) presentation.originalSources.add(source);
          SearchAlbumPresentationProvenance.attach(album, handle);
        } catch (failure) {SearchAlbumPresentationProvenance.detach(album, handle); handle.dispose('prepare'); throw failure;}
      },
      read(track, source) {
        if (!currentAttempt() || !lifetime.admitted || !lifetime.deadline) return {state: 'unchecked', matches_search: null};
        const entry = presentation.trackEntries.get(track);
        return entry && entry.sourceObjects.has(source) ? {state: entry.state, matches_search: entry.state === 'known' ? entry.value : null}
          : {state: 'unavailable', matches_search: null};
      },
      rendered(album, list, receipt) {
        if (!currentAttempt() || SearchAlbumPresentationProvenance.attempt(album) !== handle) return;
        const generation = ++presentation.renderGeneration;
        const oldRender = presentation.render, oldStatus = presentation.status, oldObserver = presentation.observer;
        const oldRequest = matchRequest?.presentation === presentation ? matchRequest : null;
        // Retire all old associations before abort or DOM observers can enter.
        presentation.render = null; presentation.nodes = new WeakMap();
        presentation.status = null; presentation.observer = null;
        for (const node of oldRender?.nodes || []) {
          node.classList.remove(matchClass); node.removeAttribute('data-track-search-match');
        }
        oldStatus?.remove(); oldObserver?.disconnect();
        if (oldRequest) cancelMatchRequest(oldRequest, 'render');
        const ownsRender = () => presentation.renderGeneration === generation && currentAttempt()
          && SearchAlbumPresentationProvenance.attempt(album) === handle;
        if (!ownsRender() || !receipt || receipt.album !== album || receipt.list !== list
          || receipt.rows.length !== receipt.nodes.length) return;
        const associations = [], conflicts = new Set();
        for (const {track, source} of receipt.rows) {
          const ref = trackRef(track?.inventory_track_ref), other = trackRef(source?.inventory_track_ref);
          if (ref && source !== track && other !== ref) conflicts.add(ref);
          if (ref && other && ref !== other) conflicts.add(other);
        }
        for (const ref of conflicts) {const entry = presentation.entries.get(ref);
          if (entry) {entry.state = 'unavailable'; entry.value = null; entry.pendingOwner = null;}}
        for (let index = 0; index < receipt.rows.length; index++) {
          const {track, source} = receipt.rows[index];
          const ref = trackRef(track?.inventory_track_ref), other = trackRef(source?.inventory_track_ref);
          let entry = null;
          if (presentation.originals.has(track) && ref && !conflicts.has(ref)
            && (source === track || presentation.originalSources.has(source) && other === ref)
            && ref.split(':')[1] === binding.capture.library) {
            entry = presentation.entries.get(ref);
            if (!entry) {entry = {ref, state: 'unchecked', value: null, pendingOwner: null, failed: false, sourceObjects: new WeakSet()}; presentation.entries.set(ref, entry);}
            entry.sourceObjects.add(source); presentation.trackEntries.set(track, entry);
          }
          associations.push({entry, receipt});
        }
        if (!ownsRender()) return;
        presentation.render = receipt;
        receipt.nodes.forEach((node, index) => presentation.nodes.set(node, associations[index]));
        if (typeof IntersectionObserver === 'function') {
          presentation.observer = new IntersectionObserver(scheduleMatches, {root: null, rootMargin: '0px', threshold: 0});
          receipt.nodes.forEach(node => presentation.observer.observe(node));
        }
        if (presentation.committed) scheduleMatches();
      },
      commit() {
        if (!currentAttempt() || !presentation.render || !presentation.render.list.isConnected) return false;
        if (presentation.committed) return true;
        presentation.committed = true; matchPresentations.add(presentation); installSearchMatchNotifications();
        // Staging never evicts the old visible owner; only explicit commit can.
        for (const prior of [...matchPresentations]) if (prior !== presentation
          && (prior.render?.list === presentation.render.list || matchPresentations.size > 2)) prior.handle.dispose('replace');
        if (!currentAttempt()) return false;
        scheduleMatches(); return true;
      },
      dispose(reason) {
        if (presentation.disposed) return;
        presentation.disposed = true; matchPresentations.delete(presentation);
        clearMatchPaint(presentation); presentation.render = null; presentation.observer?.disconnect();
        if (matchRequest?.presentation === presentation) cancelMatchRequest(matchRequest, reason || 'dispose');
        if (presentation.album) SearchAlbumPresentationProvenance.detach(presentation.album, handle);
        presentation.entries.clear(); presentation.trackEntries = new WeakMap();
        if (binding.presentationAttempt === handle) binding.presentationAttempt = null;
        cleanupSearchMatchNotifications();
      },
    });
    presentation.handle = handle; stagedSearchAttempts.set(handle, presentation); binding.presentationAttempt = handle;
    return handle;
  }
  function notifySearchMatches() {
    if (owner?.matchLifetime) {searchLifetimeCurrent(owner.matchLifetime); notify();}
    for (const presentation of [...matchPresentations]) {
      if (!presentation.handle.isCurrent()) {presentation.handle.dispose('lifecycle'); continue;}
      if (document.hidden) {clearMatchPaint(presentation);
        if (matchRequest?.presentation === presentation) cancelMatchRequest(matchRequest, 'hidden');}
    }
    scheduleMatches();
  }
  function suspendSearchMatches() {
    matchPageSuspended = true;
    for (const presentation of matchPresentations) clearMatchPaint(presentation);
    if (matchRequest) cancelMatchRequest(matchRequest, 'hidden');
    if (owner?.matchLifetime) notify();
  }
  function resumeSearchMatches() {matchPageSuspended = false; notifySearchMatches();}
  function installSearchMatchNotifications() {
    if (matchNotificationsAttached) return;
    matchNotificationsAttached = true; matchViewport = window.visualViewport;
    document.addEventListener('scroll', notifySearchMatches, {capture: true, passive: true});
    document.addEventListener('visibilitychange', notifySearchMatches);
    for (const event of ['resize', 'focus', 'albumhaven:search-match-layout']) window.addEventListener(event, notifySearchMatches);
    window.addEventListener('pagehide', suspendSearchMatches); window.addEventListener('pageshow', resumeSearchMatches);
    matchViewport?.addEventListener('scroll', notifySearchMatches, {passive: true});
    matchViewport?.addEventListener('resize', notifySearchMatches, {passive: true});
  }
  function cleanupSearchMatchNotifications() {
    if (!matchNotificationsAttached || matchPresentations.size || owner && popularityResult(owner.payload)) return;
    matchNotificationsAttached = false;
    if (matchFrame !== null) {window.cancelAnimationFrame(matchFrame); matchFrame = null;}
    document.removeEventListener('scroll', notifySearchMatches, true);
    document.removeEventListener('visibilitychange', notifySearchMatches);
    for (const event of ['resize', 'focus', 'albumhaven:search-match-layout']) window.removeEventListener(event, notifySearchMatches);
    window.removeEventListener('pagehide', suspendSearchMatches); window.removeEventListener('pageshow', resumeSearchMatches);
    matchViewport?.removeEventListener('scroll', notifySearchMatches); matchViewport?.removeEventListener('resize', notifySearchMatches);
    matchViewport = null;
  }

  function selectionOwner() {
    if (resourceSelection) return resourceSelection;
    const api = window.AlbumHavenResourceSelection;
    if (!api?.create || !api.projectTarget) throw nativeFailure('Native Album details are unavailable.', 503);
    resourceSelection = api.create({sourceResource: bindingSource, authorizeResource: authorizeBinding,
      beginAlbumPresentation: beginSearchAlbumPresentation,
      projectAlbum(album) {SearchAlbumPresentationProvenance.mark(album); return album;},
      retainResource(selection, context) {
        const binding = context?.searchBinding, target = bindingSource(selection, context);
        if (!target || context.signal?.aborted) return null;
        binding.transferred = true;
        return Object.freeze({target: api.projectTarget(target),
          isCurrent: () => !binding.revoked && nativeScopeCurrent(binding)});
      },
      async revalidateResource(selection, context, {signal} = {}) {
        const binding = context?.searchBinding;
        if (!binding || !binding.transferred || binding.revoked || context.scopeKey !== binding.scopeKey
          || selection?.kind !== 'album' || selection.ref !== binding.albumRef || selection.origin != null
          || !nativeScopeCurrent(binding)) throw nativeStale();
        const url = window.location.href, revision = readViewStateRevision(), version = (binding.replayVersion || 0) + 1;
        binding.replayVersion = version;
        const current = () => !signal?.aborted && !binding.revoked && nativeScopeCurrent(binding)
          && binding.replayVersion === version && window.location.href === url && readViewStateRevision() === revision;
        try {
          const target = await readNative(binding, 'details', {signal, isCurrent: current, witnessLifetime: false});
          if (!current()) throw nativeStale();
          if (target.native_actions.album_ref !== selection.native_actions?.album_ref) throw nativeFailure('Search Album identity changed.', 409);
          return Object.freeze({target: api.projectTarget(target), isCurrent: current});
        } catch (error) {
          // A transferred receipt is no longer in the visible result map. Its
          // exact current replay still owns revocation; an obsolete replay does
          // not get to revoke a successor version or another Search result.
          if (current() && error?.name !== 'AbortError') {
            binding.revoked = true;
            resourceSelection?.invalidateResourceSelections();
          }
          throw error;
        }
      }});
    return resourceSelection;
  }
  function canOpenAlbum(snapshot, row) {
    const identity = nativeAlbum(snapshot, row);
    return Boolean(identity && !owner.nativeDenied.has(`${identity.resourceRef}:details`));
  }
  async function openAlbum(snapshot, row, intent = 'open') {
    if (!['open', 'artwork', 'page'].includes(intent) || !canOpenAlbum(snapshot, row)) throw nativeFailure();
    const candidate = owner, identity = nativeAlbum(snapshot, row), sequence = intent === 'artwork' ? detailSequence : ++detailSequence;
    // Capture before the first Search POST, not only inside later native
    // hydration. A newer ordinary Album selection owns that presentation too.
    const modalToken = Number(state.ui?.pendingTrackModalLoadToken || 0);
    const controller = new AbortController(); candidate.nativeRequests.add(controller);
    const current = () => owns(candidate) && detailSequence === sequence && !controller.signal.aborted
      && nativeAlbum(snapshot, row)?.resourceRef === identity.resourceRef
      && modalToken === Number(state.ui?.pendingTrackModalLoadToken || 0);
    let presentationAttempt = null;
    try {
      // Each activation owns a fresh binding. An older reauthorization failure
      // must not revoke another click's binding for the same inventory Album.
      const binding = {candidate, capture: candidate.capture, url: candidate.nativeUrl, ...identity,
        scopeKey: candidate.scopeKey, revoked: false, transferred: false, artworkOnly: intent === 'artwork', actionCurrent: current};
      if (intent !== 'artwork') presentationAttempt = beginSearchAlbumPresentation(null,
        {scopeKey: candidate.scopeKey, searchBinding: binding}, {intent, signal: controller.signal, isCurrent: current});
      binding.target = await readNative(binding, 'details', {signal: controller.signal, isCurrent: current});
      if (!current()) throw nativeStale();
      if (intent !== 'artwork') candidate.nativeAlbums.set(identity.resourceRef, binding);
      if (!current() || !bindingCurrent(binding)) throw nativeStale();
      await selectionOwner().resourceIntent(intent, binding.target,
        {scopeKey: candidate.scopeKey, searchBinding: binding, signal: controller.signal});
      return true;
    } catch (error) {
      if (current()) nativeRejected(candidate, identity.resourceRef, 'details', error, {presentationOperation: true});
      throw error;
    } finally {candidate.nativeRequests.delete(controller);
      if (!presentationAttempt?.isCommitted()) presentationAttempt?.dispose('open-uncommitted');}
  }
  // Native navigation retires sources in the event turn, before consumer cleanup.
  window.addEventListener('albumhaven:search-runtime-ready', () => {
    // A newly installed runtime owns the shell. Release this superseded private
    // owner directly rather than asking the shared dispatcher to retire it.
    if (!installed() && (owner || pending)) retire('runtime');
  });
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
    accept, failPopularityRequest, retire, syncNativeView, syncVisibility, syncPresentation, isCurrent, createPlaytableSource: sourceFor,
    canPlayTrack, playTrack, trackPlayback, canOpenAlbum, openAlbum,
    captureRequestTiming: searchLifetimeStart,
    galleryMatchCurrent(snapshot) {return !document.hidden && !matchPageSuspended && isCurrent(snapshot)
      && (!popularityAlbumsResult(owner?.payload) || Boolean(owner.matchLifetime?.admitted && owner.matchLifetime.deadline && searchLifetimeCurrent(owner.matchLifetime)));},
    subscribeTrackPlayback: listener => TrackActionsRuntime.subscribePlayback(listener),
    checkpointIdentity, identityRevision: readIdentityRevision, sidebarNodeIsCurrent,
    selectPresentation(snapshot, value) {return isCurrent(snapshot) && value !== snapshot.presentation ? readPage(owner, value) : false;},
    continueResults(snapshot) {
      if (!publicationIsCurrent(snapshot)) return false;
      const candidate = owner;
      if (receiptResult(candidate.payload)) return candidate.payload.page.has_more
        ? readPage(candidate, candidate.payload.presentation, {cursor: candidate.payload.page.next_cursor}) : false;
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
    retryBindings(snapshot) {return isCurrent(snapshot) && receiptResult(owner.payload) && current.bindings?.status === 'error'
      ? readListenerBindings(owner) : false;},
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
      return readPage({payload: request.payload, capture: request.capture, requestedArtist: request.requestedArtist, requestFamily: request.requestFamily}, request.presentation, {}, request);
    },
    openPlaylistAction: (...args) => action('open', ...args),
    openPlaytableContext: (...args) => action('context', ...args),
    trackColumns: () => albumTrackTableColumns({showLove: false}),
    albumTrackRow: (track, index) => buildAlbumTrackTableRow(track, index, {readOnly: true, selection: 'multiple'}),
    tableHtml: config => native.tableHtml(config), galleryCardHtml: config => native.galleryCardHtml(config),
    tabsHtml: config => native.tabsHtml(config), mountTabs: host => native.mountTabs(host),
    buttonHtml: config => native.buttonHtml(config), actionHtml: config => native.actionHtml(config),
    iconHtml: (name, options) => ButtonComponent.renderIconSvg(name, options),
    alertHtml: config => native.alertHtml(config), artboxHtml: config => native.artboxHtml(config),
    openChoice: (anchor, options) => native.openChoice(anchor, options), escapeHtml: value => native.escapeHtml(value),
  });
})();
window.AlbumHavenSearchRuntime = SearchResultsRuntime;
window.dispatchEvent(new Event('albumhaven:search-runtime-ready'));
