/* Native Playlist reads/navigation/media authority. Optional writes live in
   separately supplied providers; reserved mutation routes are never called. */
const PlaylistReactRuntime = (() => {
  const listeners = new Set();
  let current = null, lastView = null, identity = null, generation = 0, denied = false;
  let sequence = 0, playlistReadEpoch = 0, raw = null, projected = null;
  let draft = null, draftConfirmation = null;
  const failure = (message, status) => Object.assign(new Error(message), status ? {status} : {});
  const aborted = () => Object.assign(new Error('Playlist request was superseded.'), {name: 'AbortError'});
  const copy = (source, keys) => Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(source || {}, key)).map(key => [key, source[key]]));
  const immutableCopy = value => Array.isArray(value) ? Object.freeze(Array.from(value, immutableCopy))
    : value && typeof value === 'object' ? Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]))) : value;
  const exactGrant = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key) && value[key] === true;
  const unreadable = row => row?.source_readable === false
    || Object.prototype.hasOwnProperty.call(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true;
  const selectionApi = () => window.AlbumHavenResourceSelection;
  function resourceOrigin(detail) {
    return selectionApi()?.projectOrigin({source: 'playlist', account_ref: null, playlist_ref: detail?.playlist_id,
      ...(detail?.revision != null ? {snapshot_ref: detail.revision} : {})});
  }
  function resourceTarget(value, kind, origin) {
    if (value?.kind !== kind) return null;
    const api = selectionApi(), supplied = api?.projectTarget(value);
    if (!origin || !supplied || supplied.origin && JSON.stringify(supplied.origin) !== JSON.stringify(origin)) return null;
    return api.projectTarget({...supplied, origin});
  }
  function privateResourceTarget(value, target) {
    const artist = value?.native_actions?.gallery_target?.artist;
    return target?.kind === 'artist' && typeof artist === 'string' && artist.trim() && !/[\x00-\x1f\x7f]/.test(artist)
      ? Object.freeze({...target, gallery_target: Object.freeze({artist})}) : target;
  }
  const scopeIdentity = () => {
    const shell = document.getElementById('app-shell'), home = document.getElementById('mobile-home');
    return JSON.stringify([shell?.dataset?.nativeAccountId ?? home?.dataset?.homeAccountId ?? '',
      shell?.dataset?.nativeLibraryId ?? home?.dataset?.homeLibraryId ?? '']);
  };
  const draftCurrent = owner => Boolean(owner && draft === owner && owner.scopeKey === `${scopeIdentity()}:${generation}` && owner.isCurrent() === true);
  function interruptDraftNavigation() {
    state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
    state.ui.pendingViewRequest = null;
    state.ui.activeViewRequestController?.abort();
    if (state.ui.pendingViewTransition && typeof finishPendingViewTransition === 'function') {
      finishPendingViewTransition(state.ui.activeViewRequestId, {restoreCurrentGallery: true});
    }
  }
  function releaseDraft(token) {
    if (!draft || draft.token !== token) return false;
    const owner = draft; draft = null; owner.unregister?.();
    if (draftConfirmation?.owner === owner) {
      if (typeof activeAppConfirmDialog !== 'undefined' && activeAppConfirmDialog?.promise === draftConfirmation.promise) {
        activeAppConfirmDialog.cancel({restoreFocus: false});
      }
      draftConfirmation = null;
    }
    interruptDraftNavigation();
    raw = null; projected = null;
    try {
      if (window.history.state?.playlistDraft?.token === token) {
        const snapshot = {...window.history.state}; delete snapshot.playlistDraft;
        window.AlbumHavenSettingsNavigation?.instance?.writeLibraryHistory(window.location.href, snapshot, {mode: 'replace'});
      }
    } finally {owner.onDiscard();}
    return true;
  }
  function openDraft({token, scopeKey, isCurrent, confirmLeave, onDiscard} = {}) {
    const start = sync(), navigation = window.AlbumHavenSettingsNavigation?.instance;
    if (draft || !start.visible || start.scopeKey !== scopeKey || typeof token !== 'string' || !token || /[\\/\x00-\x1f]/.test(token)
      || typeof isCurrent !== 'function' || typeof confirmLeave !== 'function' || typeof onDiscard !== 'function'
      || !navigation?.setPlaylistDraftOwner || !navigation.writeLibraryHistory) return false;
    if (isCurrent() !== true) return false;
    const owner = {token, scopeKey, isCurrent, onDiscard, parentPosition: start.entryKey};
    draft = owner;
    owner.unregister = navigation.setPlaylistDraftOwner({token, scopeKey, isCurrent: () => draftCurrent(owner),
      confirmLeave: () => {interruptDraftNavigation(); return confirmLeave();}, discard: () => {releaseDraft(token); sync();}});
    if (!owner.unregister) {draft = null; return false;}
    const url = new URL('/', window.location.href); url.searchParams.set('surface', 'playlists');
    interruptDraftNavigation();
    try {navigation.writeLibraryHistory(url.href, {playlistDraft: {token, scopeKey}}, {mode: 'push'});}
    catch {releaseDraft(token); return false;}
    if (window.history.state?.playlistDraft?.token !== token) {releaseDraft(token); return false;}
    sync(); return draftCurrent(owner);
  }
  function retainDraft(token, callback) {
    if (!draftCurrent(draft) || draft.token !== token) return false;
    return window.AlbumHavenSettingsNavigation?.instance?.retainPlaylistDraftNavigation(token, callback) ?? false;
  }
  function closeDraft(token) {
    const owner = draft;
    if (!draftCurrent(owner) || owner.token !== token) return Promise.resolve(false);
    const deferred = window.AlbumHavenSettingsNavigation?.instance?.deferPlaylistDraftNavigation(() => {
      const position = window.history.state?.albumHavenNavigationPosition;
      if (Number.isSafeInteger(owner.parentPosition) && Number.isSafeInteger(position) && position > owner.parentPosition) {
        window.history.go(owner.parentPosition - position); return true;
      }
      return typeof fetchAndRender === 'function' ? fetchAndRender('/view-data?surface=playlists', true) : false;
    });
    return Promise.resolve(deferred || false);
  }
  function restoreDraftFromHistory() {
    const snapshot = sync();
    if (!snapshot.draftToken || document.getElementById('app-shell')?.hidden === true
      || new URL(window.location.href).pathname !== '/') return false;
    interruptDraftNavigation(); sync(); return true;
  }
  function confirmDraft(token, message) {
    if (!draftCurrent(draft) || draft.token !== token || typeof showAppConfirmDialog !== 'function') return Promise.resolve(false);
    const confirmation = {owner: draft, promise: showAppConfirmDialog({title: 'Discard playlist changes', message, acceptLabel: 'Discard', danger: true})};
    draftConfirmation = confirmation;
    return Promise.resolve(confirmation.promise).then(accepted => {
      if (draftConfirmation === confirmation) draftConfirmation = null;
      return accepted;
    });
  }
  function creationSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = Object.prototype.hasOwnProperty.call(value, 'allowed_actions') ? value.allowed_actions : null;
    return {...copy(value, ['kind', 'ref', 'revision']), allowed_actions: {
      can_read: exactGrant(allowed, 'can_read'), can_use_for_playlist: exactGrant(allowed, 'can_use_for_playlist'),
    }};
  }
  function authority(payload) {
    const detail = payload?.playlist_detail;
    if (!detail || !Array.isArray(detail.track_rows)) return null;
    // Denied identities still participate in duplicate checks, without retaining
    // their media path, metadata or playback grant.
    const origin = resourceOrigin(detail);
    return immutableCopy({playlist_creation_source: creationSource(payload.playlist_creation_source), playlist_detail: {playlist_id: detail.playlist_id, origin,
      allowed_actions: {can_play: exactGrant(detail.allowed_actions, 'can_play')},
      track_rows: Array.from(detail.track_rows, row => row && typeof row === 'object' ? unreadable(row)
        ? copy(row, ['playlist_item_id']) : {
        ...copy(row, ['playlist_item_id', 'path', 'track_ref', 'canonical_track_ref', 'entry_ref', 'title', 'artist', 'secondary_artist', 'album_title', 'duration_seconds']),
        album_target: resourceTarget(row.album_target, 'album', origin),
        artist_target: privateResourceTarget(row.artist_target, resourceTarget(row.artist_target, 'artist', origin)),
        track_preference: Object.prototype.hasOwnProperty.call(row, 'track_preference') ? TrackActionsRuntime.overlay(row.track_preference) : null,
        playback_state: {can_start_here: Object.prototype.hasOwnProperty.call(row, 'playback_state') && exactGrant(row.playback_state, 'can_start_here')},
      } : null)}});
  }
  function displayFacts(row) {
    const result = copy(row, ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'artwork_url', 'availability']);
    for (const key of Object.keys(result)) {
      const value = result[key];
      if (key === 'artwork_url') result[key] = typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
        && !/[\\\u0000-\u0020\u007f]/.test(value) ? value : null;
      else if (key === 'availability') result[key] = ['local', 'missing', 'unresolved'].includes(value) ? value : null;
      else result[key] = key === 'love_tier' ? (['off', 'loved', 'obsessed'].includes(value) ? value : null)
        : Number.isSafeInteger(value) && value >= (key === 'track_rating' ? 1 : 0)
          && (key !== 'track_rating' || value <= 5) ? value : null;
    }
    return result;
  }
  function projection(payload, epoch) {
    if (!payload || !Array.isArray(payload.playlist_sidebar?.items)) return null;
    if (payload.playlist_index && !Array.isArray(payload.playlist_index.playlists)) return null;
    if (payload.playlist_detail && !Array.isArray(payload.playlist_detail.track_rows)) return null;
    if (!payload.playlist_index && !payload.playlist_detail) return null;
    const origin = resourceOrigin(payload.playlist_detail);
    const result = {playlist_sidebar: {active_playlist_id: payload.playlist_sidebar.active_playlist_id,
      items: payload.playlist_sidebar.items.map(item => copy(item, ['playlist_id', 'title', 'item_count', 'playlist_kind', 'allowed_actions']))}};
    result.playlist_actions = {can_create: Object.prototype.hasOwnProperty.call(payload, 'playlist_actions') && exactGrant(payload.playlist_actions, 'can_create')};
    result.playlist_creation_source = creationSource(Object.prototype.hasOwnProperty.call(payload, 'playlist_creation_source') ? payload.playlist_creation_source : null);
    if (payload.playlist_index) result.playlist_index = {query: payload.playlist_index.query,
      playlists: payload.playlist_index.playlists.map(item => copy(item, ['playlist_id', 'title', 'description', 'visibility', 'item_count', 'playlist_kind', 'allowed_actions']))};
    if (payload.playlist_detail) result.playlist_detail = {...copy(payload.playlist_detail,
      ['playlist_id', 'title', 'description', 'visibility', 'playlist_kind', 'query', 'active_sort', 'saved_default_sort', 'playback_mode', 'listen_to_suggestions_after_playlist', 'allowed_actions']),
      revision: origin?.snapshot_ref ?? null,
      missing_playlist_creation_source: creationSource(Object.prototype.hasOwnProperty.call(payload.playlist_detail, 'missing_playlist_creation_source') ? payload.playlist_detail.missing_playlist_creation_source : null),
      track_rows: payload.playlist_detail.track_rows.map(row => {
        if (unreadable(row)) return {...copy(row, ['playlist_item_id']), source_readable: false};
        if (epoch !== undefined) TrackActionsRuntime.acceptRead(row, epoch);
        const preference = TrackActionsRuntime.preference(row);
        return {...copy(row, ['playlist_item_id', 'playlist_position', 'album_title', 'title', 'artist', 'secondary_artist',
          'track_number', 'disc_number', 'duration_seconds', 'duration_display']), ...displayFacts(row),
          ...(typeof row.album_ref === 'string' ? {album_ref: row.album_ref} : {}),
          allowed_actions: {can_view_details: exactGrant(row.allowed_actions, 'can_view_details')},
          album_target: resourceTarget(row.album_target, 'album', origin),
          artist_target: resourceTarget(row.artist_target, 'artist', origin),
          ...(preference ? {track_preference: preference} : {}),
          ...(Object.prototype.hasOwnProperty.call(row || {}, 'source_readable') && row.source_readable === true ? {source_readable: true} : {})};
      })};
    return immutableCopy(result);
  }
  function sync() {
    const host = document.getElementById('playlists-root');
    const scopeOwner = document.getElementById('app-shell');
    const nextIdentity = scopeIdentity();
    const scopeChanged = identity !== null && nextIdentity !== identity;
    identity = nextIdentity;
    if (scopeChanged) {generation++; raw = null; projected = null; denied = false; sequence++; if (draft) releaseDraft(draft.token);}
    if (draft && !draftCurrent(draft)) releaseDraft(draft.token);
    const surface = String(state.view?.surface?.active ?? state.view?.surface_request ?? '').toLowerCase();
    const url = new URL(window.location.href), marker = window.history.state?.playlistDraft;
    const draftToken = draft && marker?.token === draft.token && marker.scopeKey === draft.scopeKey ? draft.token : null;
    const draftPage = Boolean(draftToken && url.searchParams.get('surface') === 'playlists' && !url.searchParams.has('playlist_id'));
    const visible = Boolean(host && (draftPage || !marker && surface === 'playlists') && url.pathname === '/'
      && scopeOwner?.hidden !== true && !state.ui?.pendingViewTransition);
    if (lastView !== state.view) {
      lastView = state.view; sequence++;
      const payload = surface === 'playlists' && !denied && !scopeChanged ? lastView : null;
      projected = projection(payload); raw = projected ? authority(payload) : null;
    }
    if (current && current.visible !== visible) sequence++;
    const next = {visible, scopeKey: `${identity}:${generation}`, payload: projected,
      playlistId: draftPage ? null : String(state.view?.playlist_detail?.playlist_id || state.view?.playlist_sidebar?.active_playlist_id || '') || null,
      draftToken: draftPage ? draftToken : null, retainedDraftToken: draft?.token || null,
      entryKey: Number.isSafeInteger(window.history.state?.albumHavenNavigationPosition) ? window.history.state.albumHavenNavigationPosition : null};
    if (host) host.hidden = !visible;
    document.getElementById('shell-main-surface')?.classList.toggle('has-react-playlists', visible);
    if (current && Object.keys(next).every(key => current[key] === next[key])) return current;
    current = Object.freeze(next); listeners.forEach(listener => listener()); return current;
  }
  // The hidden source reader is private to history revalidation. Ordinary UI
  // consumers always enter through the visible-only readPlaylists method.
  async function readPlaylistSource({scopeKey, playlist_id = null, signal} = {}, replay = false) {
    const start = sync();
    if ((!replay && !start.visible) || (replay && start.retainedDraftToken)
      || scopeKey !== undefined && scopeKey !== start.scopeKey) throw failure('Playlist access is unavailable.', 403);
    playlistReadEpoch++;
    const request = ++sequence, params = new URLSearchParams({surface: 'playlists'}), epoch = TrackActionsRuntime.readEpoch();
    if (playlist_id !== null) {
      if (typeof playlist_id !== 'string' || !playlist_id.trim()) throw failure('Invalid playlist identity.');
      params.set('playlist_id', playlist_id);
    }
    const active = () => {const next = sync(); return request === sequence && start.scopeKey === next.scopeKey
      && (replay ? !next.retainedDraftToken : next.visible);};
    try {
      const response = await fetch(`/view-data?${params}`, {headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store', ...(signal ? {signal} : {})});
      if (signal?.aborted || !active()) throw aborted();
      if (!response.ok) throw failure('Playlists could not be loaded.', response.status);
      const payload = await response.json();
      if (signal?.aborted || !active()) throw aborted();
      const result = projection(payload, epoch);
      if (!result) throw failure('Playlists returned an invalid response.');
      if (signal?.aborted || !active()) throw aborted();
      raw = authority(payload); denied = false;
      return {projection: result, authority: raw};
    } catch (error) {
      if (active() && error.name !== 'AbortError') {
        raw = null;
        if ((error.status === 401 || error.status === 403) && !denied) {denied = true; generation++; projected = null; sync();}
      }
      throw error;
    }
  }
  async function readPlaylists(options) {return (await readPlaylistSource(options)).projection;}
  function createPlaytableSource({rows, context, instance, revision, isCurrent}) {
    const source = raw, epoch = playlistReadEpoch;
    return createPrivatePlaytableSource({scopeKey: context?.scopeKey, rows, instance, revision,
      isCurrent: () => isCurrent() && sync().visible && sync().scopeKey === context?.scopeKey
        && raw === source && playlistReadEpoch === epoch && sync().playlistId === context.playlist_id,
      resolveRow: row => currentTrackRow(row, context), creationSource: () => raw?.playlist_creation_source,
      navigationCurrent: () => sync().scopeKey === context?.scopeKey && raw === source && playlistReadEpoch === epoch,
      resolveNavigationRow: row => {
        const matches = source?.playlist_detail?.track_rows.filter(item => item?.playlist_item_id === row.playlist_item_id) || [];
        return matches.length === 1 ? matches[0] : null;
      },
      subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    });
  }
  function currentTrackRow(row, {playlist_id, scopeKey} = {}) {
    const shell = sync(), detail = raw?.playlist_detail;
    if (!shell.visible || scopeKey !== undefined && scopeKey !== shell.scopeKey || !playlist_id || shell.playlistId !== playlist_id
      || detail?.playlist_id !== playlist_id || typeof row?.playlist_item_id !== 'string') return null;
    const matches = Array.isArray(detail.track_rows) ? detail.track_rows.filter(item => item && String(item.playlist_item_id) === row.playlist_item_id) : [];
    return matches.length === 1 ? matches[0] : null;
  }
  function playableRow(intent, row, options) {
    const source = currentTrackRow(row, options);
    return intent === 'play' && raw?.playlist_detail.allowed_actions.can_play === true && TrackActionsRuntime.canPlay(source) ? source : null;
  }
  async function trackIntent(intent, row, options) {
    const playerToken = typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null;
    const source = playableRow(intent, row, options);
    if (playerToken !== (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null)) throw aborted();
    if (!source) throw failure('This track action is unavailable.', 403);
    TrackActionsRuntime.play(source);
  }
  function trackPreference(row, options) {
    if (!options?.scopeKey || options.scopeKey !== sync().scopeKey) return null;
    return TrackActionsRuntime.preference(currentTrackRow(row, options));
  }
  async function setTrackLove({row, context, love_tier, signal} = {}) {
    const source = currentTrackRow(row, context), request = sequence;
    if (!context?.scopeKey || context.scopeKey !== sync().scopeKey || !source) throw failure('Track love editing is unavailable.', 403);
    return TrackActionsRuntime.setLove({source, love_tier, signal,
      isCurrent: () => currentTrackRow(row, context) === source && sequence === request});
  }
  async function navigate({playlist_id = null} = {}) {
    const start = sync();
    if (!start.visible || playlist_id !== null && (typeof playlist_id !== 'string' || !playlist_id.trim())) throw failure('Playlist navigation is unavailable.');
    const open = () => navigateCurrent(playlist_id, start);
    const deferred = typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(open);
    return deferred || open();
  }
  async function navigateFromPlaytable({playlist_id, sourceReceipt, providerCurrent} = {}) {
    // The picker already reread its destination grant. Native navigation still
    // validates the actual returned Playlist and owning account before applying.
    const active = () => sourceReceipt?.isCurrent?.() === true && providerCurrent?.() === true;
    if (typeof playlist_id !== 'string' || !playlist_id.trim() || !active()) return false;
    const start = sync();
    if (start.retainedDraftToken || document.getElementById('app-shell')?.hidden === true) return false;
    await navigateCurrent(playlist_id, start, active); return true;
  }
  async function navigateCurrent(playlist_id, start, sourceCurrent = () => true) {
    if (!sourceCurrent() || sync().scopeKey !== start.scopeKey || document.getElementById('app-shell')?.hidden === true
      || new URL(window.location.href).pathname !== '/') throw aborted();
    const params = new URLSearchParams({surface: 'playlists'}); if (playlist_id) params.set('playlist_id', playlist_id);
    if (typeof fetchAndRender !== 'function') throw failure('Native navigation is unavailable.');
    const priorView = state.view; let rejectedTarget = false, requestId = null;
    const pending = fetchAndRender(`/view-data?${params}`, true, {source: 'library', shouldApplyResponse(payload) {
      const latest = sync();
      // Our own pending transition temporarily hides the surface. Validate its
      // current owner and identity before native code applies any response.
      if (!sourceCurrent() || latest.scopeKey !== start.scopeKey || state.view !== priorView
        || document.getElementById('app-shell')?.hidden === true || new URL(window.location.href).pathname !== '/'
        || requestId !== null && state.ui.activeViewRequestId !== requestId) return false;
      const detail = payload?.playlist_detail, targets = payload?.playlist_sidebar?.items?.filter(item => item?.playlist_id === playlist_id);
      const valid = Boolean(projection(payload) && (playlist_id === null ? payload.playlist_index && !detail
        : detail?.playlist_id === playlist_id && targets?.length === 1 && exactGrant(targets[0].allowed_actions, 'can_open')));
      rejectedTarget = !valid; return valid;
    }});
    requestId = state.ui.activeViewRequestId;
    const applied = await pending, next = sync();
    if (state.ui.activeViewRequestId !== requestId || next.scopeKey !== start.scopeKey || !next.visible
      || applied === false && !rejectedTarget && state.view !== priorView) throw aborted();
    if (rejectedTarget || applied === false || next.playlistId !== playlist_id
      || playlist_id !== null && !next.payload?.playlist_detail) throw failure('This playlist could not be opened.');
  }
  function sourceResource(selection, context = {}) {
    const snapshot = sync(), api = selectionApi(), target = api?.projectTarget(selection);
    const origin = api?.projectOrigin(context.origin ?? target?.origin), detail = raw?.playlist_detail;
    if (!snapshot.visible || context.scopeKey !== snapshot.scopeKey || !target || !origin || !detail
      || origin.source !== 'playlist' || origin.playlist_ref !== snapshot.playlistId
      || JSON.stringify(origin) !== JSON.stringify(detail.origin)
      || target.origin && JSON.stringify(target.origin) !== JSON.stringify(origin)) return null;
    const found = detail.track_rows.map(row => row?.[`${target.kind}_target`]).filter(value =>
      value?.ref === target.ref && value.allowed_actions.can_view_details === true);
    return found.length && found.every(value => JSON.stringify(value) === JSON.stringify(found[0])) ? found[0] : null;
  }
  function retainResource(selection, context = {}) {
    if (context.signal?.aborted) return null;
    const target = sourceResource(selection, context), snapshot = sync(), source = raw, epoch = playlistReadEpoch;
    if (!target || snapshot.retainedDraftToken) return null;
    const isCurrent = () => {
      const current = sync();
      return current.scopeKey === snapshot.scopeKey && !current.retainedDraftToken && raw === source && playlistReadEpoch === epoch;
    };
    return isCurrent() ? Object.freeze({target: selectionApi().projectTarget(target), isCurrent}) : null;
  }
  async function revalidateResource(selection, context = {}, {signal} = {}) {
    const api = selectionApi(), target = api?.projectTarget(selection), origin = api?.projectOrigin(context.origin ?? target?.origin);
    if (!target || target.kind !== 'album' || !origin || origin.source !== 'playlist' || origin.account_ref !== null) return null;
    const start = sync(), sourceUrl = window.location.href, sourceEntry = start.entryKey;
    const nativeScope = TrackActionsRuntime.scope();
    if (!nativeScope.actor || !nativeScope.library || start.scopeKey !== context.scopeKey || start.retainedDraftToken
      || target.allowed_actions.can_view_details !== true
      || target.origin && JSON.stringify(target.origin) !== JSON.stringify(origin)) throw failure('This Playlist source is unavailable.', 403);
    if (signal?.aborted) throw aborted();
    const pending = readPlaylistSource({scopeKey: start.scopeKey, playlist_id: origin.playlist_ref, signal}, true), epoch = playlistReadEpoch;
    const {projection: result, authority: source} = await pending, detail = source?.playlist_detail;
    const isCurrent = () => {
      const snapshot = sync();
      return !signal?.aborted && snapshot.scopeKey === start.scopeKey && !snapshot.retainedDraftToken
        && playlistReadEpoch === epoch && raw === source;
    };
    if (!isCurrent() || window.location.href !== sourceUrl || sync().entryKey !== sourceEntry) throw aborted();
    const owners = result.playlist_sidebar.items.filter(row => row.playlist_id === origin.playlist_ref);
    if (owners.length !== 1 || !exactGrant(owners[0].allowed_actions, 'can_open')
      || detail?.playlist_id !== origin.playlist_ref || JSON.stringify(detail.origin) !== JSON.stringify(origin)) {
      throw failure('This Playlist source is unavailable.', 403);
    }
    const matches = detail.track_rows.map(row => row?.album_target).filter(value => value?.ref === target.ref
      && value.allowed_actions.can_view_details === true);
    if (!matches.length) return null;
    const fresh = matches[0];
    if (!matches.every(value => JSON.stringify(value) === JSON.stringify(fresh))) throw failure('This Album source is unavailable.', 403);
    if (!fresh.native_actions) return null;
    if (!exactGrant(fresh.native_actions.allowed_actions, 'can_open_album')) throw failure('This Album source is unavailable.', 403);
    if (target.native_actions && target.native_actions.album_ref !== fresh.native_actions.album_ref) throw failure('This Album source is unavailable.', 403);
    const allowed = {...fresh.native_actions.allowed_actions};
    for (const key of ['can_open_album', 'can_play_album', 'can_view_artwork', 'can_open_album_page']) {
      if (target.native_actions?.allowed_actions[key] === false) allowed[key] = false;
    }
    return Object.freeze({target: api.projectTarget({...fresh, native_actions: {
      album_ref: fresh.native_actions.album_ref, allowed_actions: allowed,
    }}), isCurrent});
  }
  const components = window.AlbumHavenHomeRuntime;
  window.addEventListener('popstate', sync);
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') new MutationObserver(sync).observe(shell, {attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id']});
  const resourceSelection = selectionApi()?.create({sourceResource, retainResource, revalidateResource});
  return {
    snapshot: sync, sync, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    readPlaylists, navigate, navigateFromPlaytable, createPlaytableSource,
    openPlaylistAction: (...args) => window.AlbumHavenPlaytableUI?.open(...args) ?? false,
    canOpenPlaytableForm: () => !activeAppFormDialog && !(typeof isMobileFormReturning === 'function' && isMobileFormReturning()),
    notifyPlaytableCreation: () => showToast('Playlist saved. Open it from Playlists when access is available.', 'info', 4000),
    playtableFormRuntime(isCurrent) {
      const sourceView = state.view, sourceUrl = window.location.href, sourceScope = TrackActionsRuntime.scope().token;
      const retainParentView = () => state.view === sourceView && window.location.href === sourceUrl
        && TrackActionsRuntime.scope().token === sourceScope && isCurrent();
      return {...PlaylistReactRuntime,
      openForm: options => openReactFormDialog({...options, retainParentView}, isCurrent),
      confirm: message => isCurrent() && typeof showAppConfirmDialog === 'function'
        ? showAppConfirmDialog({title: 'Discard playlist changes', message, acceptLabel: 'Discard', danger: true}) : Promise.resolve(false),
    };},
    openDraft, closeDraft, retainDraft, releaseDraft: token => {const released = releaseDraft(token); sync(); return released;},
    restoreDraftFromHistory, canTrackIntent: (...args) => Boolean(playableRow(...args)), trackIntent, trackPreference, setTrackLove,
    ...resourceSelection,
    subscribeTrackPreferences: listener => TrackActionsRuntime.subscribePreferences(listener),
    trackPlayback: (row, options) => TrackActionsRuntime.playback(currentTrackRow(row, options)),
    subscribeTrackPlayback: listener => TrackActionsRuntime.subscribePlayback(listener),
    openChoice: (trigger, options) => components.openChoice(trigger, options),
    buttonHtml: config => components.buttonHtml(config), actionHtml: config => components.actionHtml(config),
    iconHtml: (name, options) => ButtonComponent.renderIconSvg(name, options),
    ratingHtml: config => buildGalleryRatingHtml(config),
    searchHtml: config => buildSearchInputHtml(config),
    alertHtml: config => components.alertHtml(config), galleryBarHtml: config => components.galleryBarHtml(config),
    tableHtml: config => components.tableHtml(config), artboxHtml: config => components.artboxHtml(config),
    detailHeaderHtml: config => components.detailHeaderHtml(config), tabsHtml: config => components.tabsHtml(config),
    artistInfoHtml: config => components.artistInfoHtml(config),
    mountTabs: host => components.mountTabs(host), navigationItemHtml: config => components.navigationItemHtml(config),
    escapeHtml, albumTrackRow: (track, index) => buildAlbumTrackTableRow({...track, duration: track.duration_display}, index, {readOnly: true}),
    openForm: options => openReactFormDialog(options, () => sync().visible),
    deferFormNavigation: callback => typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(callback),
    confirm: message => sync().visible && typeof showAppConfirmDialog === 'function'
      ? showAppConfirmDialog({title: 'Discard playlist changes', message, acceptLabel: 'Discard', danger: true})
      : Promise.resolve(false),
    confirmDraft,
    downloadText({text: value, filename}) {
      if (!sync().visible || typeof value !== 'string' || value.length > 5 * 1024 * 1024) throw failure('This text export is unavailable.');
      const url = URL.createObjectURL(new Blob([value], {type: 'text/plain;charset=utf-8'}));
      const link = document.createElement('a'); link.href = url;
      link.download = filename === 'playlist-missing.txt' ? filename : 'playlist.txt';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
})();
function syncPlaylistRuntime() {PlaylistReactRuntime.sync();}
window.AlbumHavenPlaylistRuntime = PlaylistReactRuntime;
window.dispatchEvent(new Event('albumhaven:playlist-runtime-ready'));
