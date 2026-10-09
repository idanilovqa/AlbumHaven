/* Narrow adapter: React owns Home, existing native components and playback keep their owners. */
const HomeFriendsRuntime = (() => {
  const listeners = new Set();
  let current = null;
  let lastView = null;
  let recent = null;
  let identity = null;
  let scopeGeneration = 0;
  let denied = false;
  let readSequence = 0;
  let recentReadEpoch = 0;
  let actionSequence = 0;
  let profileNavigationSequence = 0;
  let playtablePresentation = null;
  let activityProvider = null, activity = null, activitySourceEpoch = 0;
  const friendActivityEpochs = new Map();
  function eraseActivity() {activity?.nativeRows?.clear(); activity?.resources?.clear(); activity?.rows?.clear(); activity = null;}
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const opaque = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\\/\x00-\x20\x7f]/.test(value);
  const unreadableActivityRow = row => row.source_readable === false || own(row.allowed_actions, 'can_read') && row.allowed_actions.can_read !== true;
  const selectionApi = () => window.AlbumHavenResourceSelection;
  function resourceTarget(value, kind, origin) {
    if (value?.kind !== kind) return null;
    const api = selectionApi(), supplied = api?.projectTarget(value);
    if (!supplied || supplied.origin && JSON.stringify(supplied.origin) !== JSON.stringify(origin)) return null;
    return api.projectTarget({...supplied, origin});
  }
  function privateResourceTarget(value, target) {
    const artist = value?.native_actions?.gallery_target?.artist;
    return target?.kind === 'artist' && typeof artist === 'string' && artist.trim() && !/[\x00-\x1f\x7f]/.test(artist)
      ? Object.freeze({...target, gallery_target: Object.freeze({artist})}) : target;
  }

  const failure = (message, status) => Object.assign(new Error(message), status ? { status } : {});
  const superseded = () => Object.assign(new Error('Home request was superseded.'), { name: 'AbortError' });
  function recentPayload(payload) {
    if (!Array.isArray(payload?.recent_local_albums) || !Array.isArray(payload?.recent_not_local_albums)) return null;
    try {PrivateUITransport.accept(payload);} catch {return null;}
    const copyRows = rows => Object.freeze(rows.map(row => row && typeof row === 'object' && !Array.isArray(row)
      ? Object.freeze({ ...row, allowed_actions: Object.freeze({ ...row.allowed_actions }) }) : null));
    const local = copyRows(payload.recent_local_albums), external = copyRows(payload.recent_not_local_albums);
    return local.includes(null) || external.includes(null) ? null : Object.freeze({
      recent_local_albums: local, recent_not_local_albums: external,
    });
  }
  // History stores presentation choices only, never provider DTOs or profile drafts.
  function presentationValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const choice = (candidate, allowed, fallback) => allowed.includes(candidate) ? candidate : fallback;
    const views = value => Object.freeze({
      albums: choice(value?.albums, ['list', 'cards', 'covers'], 'cards'),
      tracks: choice(value?.tracks, ['grouped', 'history'], 'grouped'),
      artists: choice(value?.artists, ['list', 'cards'], 'list'),
    });
    const position = value => Number.isFinite(value) && value >= 0 && value <= 10000000 ? value : 0;
    const reference = value => typeof value === 'string' && value.length <= 512
      && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
    const comparison = value.comparison;
    const comparisonKind = choice(comparison?.kind, ['albums', 'tracks', 'artists'], null);
    const comparisonPeriod = choice(comparison?.period, ['week', 'month', 'six', 'year', 'all'], null);
    const comparisonFriend = reference(comparison?.friendRef);
    const selection = comparison?.selection;
    const metricSort = comparison?.metricSort;
    const metricKeys = ['listen_count', 'play_count', ...(comparisonKind === 'albums' ? ['full_listen_count'] : []),
      ...(comparisonKind && comparisonKind !== 'artists' ? ['rating'] : [])];
    const metric = metricSort && typeof metricSort === 'object' && !Array.isArray(metricSort)
      && ['side', 'key', 'direction'].every(key => own(metricSort, key))
      && ['yours', 'friend'].includes(metricSort.side) && metricKeys.includes(metricSort.key)
      && ['ascending', 'descending'].includes(metricSort.direction)
      ? Object.freeze({side: metricSort.side, key: metricSort.key, direction: metricSort.direction}) : null;
    const comparisonValue = comparisonFriend && comparisonKind && comparisonPeriod ? Object.freeze({
      friendRef: comparisonFriend, kind: comparisonKind, period: comparisonPeriod,
      commonOnly: typeof comparison.commonOnly === 'boolean' ? comparison.commonOnly : true,
      order: choice(comparison.order, ['general', 'yours', 'friend'], 'general'),
      ascending: comparison.ascending === true,
      view: choice(comparison.view, ['rows', 'covers'], 'rows'),
      ...(own(comparison, 'metricSort') ? {metricSort: metric} : {}),
      selection: reference(selection?.id) && selection.kind === {albums: 'album', tracks: 'track', artists: 'artist'}[comparisonKind]
        ? Object.freeze({id: selection.id, kind: selection.kind}) : null,
    }) : null;
    const selectionPresentation = [], seen = new Set();
    for (const entry of Array.isArray(value.selectionPresentation) ? value.selectionPresentation : []) {
      const query = entry?.query;
      if (!query || !['recent', 'friends'].includes(query.section) || !['albums', 'artists', 'tracks', 'listens'].includes(query.kind)
        || !['week', 'month', 'six', 'year', 'all'].includes(query.period)
        || (query.section === 'friends' ? !reference(query.account_ref) : query.account_ref !== null)) continue;
      const normalizedQuery = Object.freeze({section: query.section, account_ref: query.account_ref, kind: query.kind, period: query.period});
      const key = JSON.stringify(normalizedQuery);
      if (seen.has(key)) continue;
      seen.add(key);
      const selected = entry.selected;
      const normalizedSelection = reference(selected?.rowId) && ['album', 'artist'].includes(selected.targetKind)
        && reference(selected.targetRef) && (selected.snapshotRef == null || reference(selected.snapshotRef))
        ? Object.freeze({rowId: selected.rowId, targetKind: selected.targetKind, targetRef: selected.targetRef,
          snapshotRef: selected.snapshotRef ?? null}) : null;
      const tracks = entry.tracks;
      const normalizedTracks = ['tracks', 'listens'].includes(query.kind) && Array.isArray(tracks?.rowIds)
        && tracks.rowIds.length > 0 && tracks.rowIds.length <= 5000 && tracks.rowIds.every(reference)
        && new Set(tracks.rowIds).size === tracks.rowIds.length
        && (tracks.snapshotRef == null || reference(tracks.snapshotRef))
        ? Object.freeze({rowIds: Object.freeze([...tracks.rowIds]), snapshotRef: tracks.snapshotRef ?? null}) : null;
      selectionPresentation.push(Object.freeze({query: normalizedQuery, selected: normalizedTracks ? null : normalizedSelection, tracks: normalizedTracks,
        childAlbumRef: normalizedSelection?.targetKind === 'artist' || normalizedTracks ? reference(entry.childAlbumRef) : null,
        pane: choice(entry.pane, ['recent', 'artist', 'album'], 'recent'),
        expanded: choice(entry.expanded, ['recent', 'friends', 'artist', 'album'], null),
        scroll: Object.freeze({source: position(entry.scroll?.source), artist: position(entry.scroll?.artist), album: position(entry.scroll?.album)})}));
      if (selectionPresentation.length === 6) break;
    }
    return Object.freeze({
      kind: choice(value.kind, ['albums', 'tracks', 'artists'], 'albums'),
      kindExplicit: ['albums', 'tracks', 'artists'].includes(value.kind) && value.kindExplicit !== false,
      homeSection: choice(value.homeSection, ['recent', 'queue'], 'recent'),
      period: choice(value.period, ['week', 'month', 'six', 'year', 'all'], 'week'),
      views: views(value.views),
      friendKind: choice(value.friendKind, ['albums', 'tracks', 'artists'], 'tracks'),
      friendPeriod: choice(value.friendPeriod, ['week', 'month', 'six', 'year', 'all'], 'week'),
      friendViews: views(value.friendViews),
      friendMode: choice(value.friendMode, ['activity', 'comparison'], 'activity'),
      selectedAlbum: reference(value.selectedAlbum),
      selectionPresentation: Object.freeze(selectionPresentation),
      comparison: comparisonValue,
      expanded: choice(value.expanded, ['recent', 'friends', 'selection', 'artist', 'album'], null),
      scroll: Object.freeze({page: position(value.scroll?.page), recent: position(value.scroll?.recent), friends: position(value.scroll?.friends)}),
    });
  }
  function readPresentation(scopeKey) {
    const saved = window.history.state?.homeFriendsPresentation;
    if (saved?.version !== 1 || saved.scopeKey !== scopeKey) return null;
    const value = presentationValue(saved.value);
    return current && JSON.stringify(current.presentation) === JSON.stringify(value) ? current.presentation : value;
  }
  function sync() {
    const host = document.getElementById('mobile-home');
    const scopeOwner = document.getElementById('app-shell');
    const accountId = scopeOwner?.dataset?.nativeAccountId ?? host?.dataset?.homeAccountId ?? '';
    const nextIdentity = JSON.stringify([accountId, scopeOwner?.dataset?.nativeLibraryId ?? host?.dataset?.homeLibraryId ?? '', PrivateUITransport.generation()]);
    const scopeChanged = identity !== null && identity !== nextIdentity;
    if (scopeChanged) {
      scopeGeneration++;
      friendActivityEpochs.clear();
      recent = null;
      denied = false;
      readSequence++;
      actionSequence++;
      eraseActivity();
    }
    identity = nextIdentity;
    if (lastView !== state.view) {
      lastView = state.view;
      if (!scopeChanged && !denied) {
        recent = recentPayload(lastView);
        readSequence++;
      }
    }
    const url = new URL(window.location.href);
    const section = url.searchParams.get('home_section') === 'friends' ? 'friends' : 'recent';
    const friendTarget = section === 'friends' ? url.searchParams.get('home_friend') || '' : '';
    const profileTarget = section === 'friends' ? url.searchParams.get('home_profile') || '' : '';
    // Conflicting replay identities select no person; neither URL grants access.
    const friendRef = profileTarget ? '' : friendTarget;
    const profileRef = friendTarget ? '' : profileTarget;
    const visible = Boolean(host && shouldShowMobileHome());
    if (current && current.visible !== visible) {
      readSequence++;
      actionSequence++;
      activity = null;
    }
    if (current && (current.section !== section || current.friendRef !== friendRef || current.profileRef !== profileRef)) {
      actionSequence++; activitySourceEpoch++; activity = null;
    }
    const scopeKey = `${identity}:${scopeGeneration}`;
    const position = window.history.state?.albumHavenNavigationPosition;
    if (playtablePresentation && !playtablePresentationCurrent(playtablePresentation, scopeKey)) playtablePresentation = null;
    const next = {
      visible, authenticated: !denied && typeof accountId === 'string' && !!accountId.trim(), accountName: host?.dataset.accountName || 'My music',
      scopeKey, payload: recent, section, friendRef, profileRef,
      entryKey: playtablePresentation ? playtablePresentation.entryKey : Number.isSafeInteger(position) ? position : null,
      presentation: readPresentation(scopeKey),
    };
    if (current && Object.keys(next).every(key => current[key] === next[key])) return current;
    current = Object.freeze(next);
    listeners.forEach(listener => listener());
    return current;
  }
  function playtablePresentationCurrent(owner, scopeKey) {
    if (owner.scopeKey !== scopeKey || owner.view !== state.view) return false;
    const position = window.history.state?.albumHavenNavigationPosition ?? null;
    if (owner.url === window.location.href && owner.position === position) return true;
    if (owner.formUrl !== window.location.href || typeof mobilePageState === 'undefined') return false;
    const form = typeof getActiveAppFormPage === 'function' ? getActiveAppFormPage() : null;
    const page = mobilePageState.pages.find(value => value.kind === 'form' && value.formToken === form?.token);
    if (['playlist-track-destination', 'create-playlist'].includes(form?.pageId) && page?.parentPosition === owner.position) {
      if (!owner.formToken) owner.formToken = form.token;
      return owner.formToken === form.token && window.history.state?.mobilePages?.some(value => value.formToken === form.token);
    }
    return Boolean(owner.formToken && mobilePageState.formReturn?.parent?.formToken === owner.formToken);
  }
  function retainPlaytablePresentation(scopeKey) {
    const start = sync();
    if (!start.visible || start.scopeKey !== scopeKey || playtablePresentation) return null;
    const formUrl = new URL(window.location.href);
    for (const key of ['mobile_page', 'mobile_album', 'utility_tab', 'loop_song', 'loop_filter', 'utility_detail']) formUrl.searchParams.delete(key);
    formUrl.searchParams.set('mobile_page', 'form');
    const owner = {scopeKey, view: state.view, url: window.location.href, formUrl: formUrl.href,
      position: window.history.state?.albumHavenNavigationPosition ?? null, formToken: null, entryKey: start.entryKey};
    playtablePresentation = owner;
    return () => {if (playtablePresentation === owner) {playtablePresentation = null; sync();}};
  }
  async function readRecentSource({ signal } = {}) {
    const start = sync();
    recentReadEpoch++;
    const sequence = ++readSequence;
    const isCurrent = () => {
      const snapshot = sync();
      return sequence === readSequence && start.scopeKey === snapshot.scopeKey;
    };
    try {
      const payload = await PrivateUITransport.request('/home-data', {signal});
      if (signal?.aborted || !isCurrent()) throw superseded();
      const next = recentPayload(payload);
      if (!next) throw failure('Recent listens returned an invalid response.');
      recent = next;
      denied = false;
      sync();
      return {payload, projection: next};
    } catch (error) {
      if (!isCurrent()) throw superseded();
      if (isCurrent() && error.name !== 'AbortError') {
        recent = null;
        if ((error.status === 401 || error.status === 403) && !denied) {
          denied = true;
          scopeGeneration++;
          actionSequence++;
          activity = null;
        }
        sync();
      }
      throw error;
    }
  }
  async function readRecent(options) {return (await readRecentSource(options)).payload;}
  function activityQuery(value) {
    if (!value || !['albums', 'tracks', 'artists', 'listens'].includes(value.kind)
      || !['week', 'month', 'six', 'year', 'all'].includes(value.period)
      || value.account_ref != null && !opaque(value.account_ref)) return null;
    return JSON.stringify([value.account_ref ?? null, value.kind, value.period]);
  }
  function currentActivityTrack(row, context) {
    const snapshot = sync(), owner = activity;
    if (!owner || !snapshot.visible || snapshot.scopeKey !== context?.scopeKey || owner.scopeKey !== snapshot.scopeKey
      || owner.query !== activityQuery(context) || owner.provider !== activityProvider || !opaque(row?.id)
      || !owner.rows.has(row.id) || !['track', 'listen'].includes(owner.rows.get(row.id).kind)
      || owner.rows.get(row.id).source_readable === false) return null;
    const result = resolveActivityTrackSource(row, owner);
    const latest = sync();
    return activity === owner && latest.visible && latest.scopeKey === snapshot.scopeKey ? result : null;
  }
  function resolveActivityTrackSource(row, owner) {
    if (!owner?.rows.has(row?.id) || owner.rows.get(row.id).source_readable === false) return null;
    if (owner.nativeRows?.has(row.id)) return owner.nativeRows.get(row.id);
    if (typeof owner.provider?.resolve !== 'function') return null;
    let source;
    try {source = owner.provider.resolve({...owner.context, rowId: row.id});} catch {return null;}
    if (source && typeof source.then === 'function') {Promise.resolve(source).catch(() => {}); return null;}
    const nativeScope = TrackActionsRuntime.scope();
    if (!source || typeof source !== 'object' || Array.isArray(source) || !['row_id', 'actor_id', 'library_id'].every(key => own(source, key))
      || source.row_id !== row.id || String(source.actor_id) !== nativeScope.actor || String(source.library_id) !== nativeScope.library
      || source.source_readable === false || own(source.allowed_actions, 'can_read') && source.allowed_actions.can_read !== true) return null;
    // Copy only current native authority. No resolver object or private ref is
    // returned to the UI, and a provider cannot change an already checked object.
    const result = {};
    for (const key of ['inventory_track_ref', 'track_ref', 'canonical_track_ref', 'entry_ref', 'playlist_creation_source', 'path', 'title', 'artist', 'secondary_artist', 'album_title', 'duration_seconds']) {
      if (own(source, key)) result[key] = source[key];
    }
    result.playback_state = Object.freeze({can_start_here: own(source, 'playback_state') && own(source.playback_state, 'can_start_here') && source.playback_state.can_start_here === true});
    result.track_preference = owner.context.account_ref == null && own(source, 'track_preference') ? TrackActionsRuntime.overlay(source.track_preference) : null;
    return Object.freeze(result);
  }
  function activityPreference(row, context) {return TrackActionsRuntime.preference(currentActivityTrack(row, context));}
  function createPlaytableSource({rows, context, instance, revision, isCurrent}) {
    const sourceOwner = activity, provider = activityProvider, epoch = activitySourceEpoch;
    const friendEpoch = context?.account_ref == null ? null : friendActivityEpochs.get(context.account_ref);
    return createPrivatePlaytableSource({scopeKey: context?.scopeKey, rows, instance, revision,
      isCurrent: () => isCurrent() && sync().scopeKey === context?.scopeKey && sync().visible
        && activity === sourceOwner && activityProvider === provider,
      canQueueRow: row => row.availability === 'local' && row.source_readable !== false
        && sourceOwner?.rows.get(row.id)?.allowed_actions?.can_resolve_native_play === true && typeof provider?.resolveNative === 'function',
      captureQueueRows: typeof provider?.resolveNative === 'function' && sourceOwner?.snapshotRef ? selectedRows => {
        const scope = context.scopeKey, snapshotRef = sourceOwner.snapshotRef;
        const valid = () => sync().scopeKey === scope && activityProvider === provider
          && (context.account_ref == null || friendActivityEpochs.get(context.account_ref) === friendEpoch);
        return selectedRows.map(row => {
          let inventoryRef = null;
          return {display: {title: row.title, artist: row.artist, album: row.album_title,
          albumTarget: row.album_target, artistTarget: row.artist_target}, isCurrent: valid,
          async resolvePlaylistItem({signal} = {}) {
            // Enqueue already established this inventory identity. It is only
            // a candidate: the Browse-gated Queue source endpoint freshly
            // validates the original activity receipt before any builder/write.
            if (!valid() || signal?.aborted || !inventoryRef) throw superseded();
            return {inventory_track_ref: inventoryRef,
              source_provenance: {kind: 'activity', track_ref: inventoryRef, row_ref: row.id,
                origin: {audience: context.account_ref == null ? 'own' : 'friend', subject_ref: context.account_ref ?? null,
                  kind: context.kind, period: context.period, snapshot_ref: snapshotRef}}};
          },
          async resolveDetails(kind, {signal} = {}) {
            const target = kind === 'album' ? row.album_target : kind === 'artist' ? row.artist_target : null;
            if (!valid() || signal?.aborted || !target?.allowed_actions?.can_view_details) throw superseded();
            const value = await provider.resolveNative({...context, snapshot_ref: snapshotRef, rowId: row.id, intent: 'details', target_kind: kind, signal});
            if (!valid() || signal?.aborted || value.allowed_actions?.can_view_details !== true) throw superseded();
            const native = kind === 'album' ? {album_ref: value.album_ref, allowed_actions: {can_open_album: true, can_play_album: value.allowed_actions.can_play_album === true}}
              : {artist_ref: value.artist_ref, allowed_actions: {can_open_artist_gallery: true}};
            return {target: selectionApi().projectTarget({...target, native_actions: native}),
              data: {kind, ref: target.ref, title: value.title || (kind === 'album' ? row.album_title : row.artist), artist: value.artist || row.artist,
                metadata_state: 'current', source_label: 'Queued from Recent', ...(kind === 'album' ? {tracks: null} : {listened_albums: null, discography: null})},
              ...(kind === 'artist' ? {gallery_target: {artist: value.artist_ref}} : {}),
              subject_ref: null,
              isCurrent: () => valid() && !signal?.aborted};
          },
          async resolve({signal} = {}) {
            if (!valid() || signal?.aborted) throw superseded();
            const value = await provider.resolveNative({...context, snapshot_ref: snapshotRef, rowId: row.id, intent: 'play', signal});
            if (!valid() || signal?.aborted || !/^inventory-track:[1-9]\d*:[1-9]\d*$/.test(value.inventory_track_ref || '')
              || inventoryRef && inventoryRef !== value.inventory_track_ref) throw superseded();
            inventoryRef = value.inventory_track_ref;
            return {...value, source_readable: true, availability: 'local', playback_state: {can_start_here: true}};
          }};
        });
      } : null,
      resolveRow: row => currentActivityTrack(row, context),
      activitySource: selectedRows => sourceOwner?.snapshotRef && selectedRows.every(row => sourceOwner.nativeRows?.get(row.id)?.activity_row_ref)
        ? {origin: {audience: context.account_ref == null ? 'own' : 'friend', subject_ref: context.account_ref ?? null,
          kind: context.kind, period: context.period, snapshot_ref: sourceOwner.snapshotRef}, row_refs: selectedRows.map(row => row.id)} : null,
      creationSource: selectedRows => {
        const sources = selectedRows.map(row => currentActivityTrack(row, context)?.playlist_creation_source);
        return sources.length && sources[0] && sources.every(source => JSON.stringify(source) === JSON.stringify(sources[0])) ? sources[0] : null;
      },
      navigationCurrent: () => Boolean(sourceOwner && sync().scopeKey === context?.scopeKey
        && activitySourceEpoch === epoch && activityProvider === provider
        && (context.account_ref == null || friendActivityEpochs.get(context.account_ref) === friendEpoch)),
      resolveNavigationRow: row => resolveActivityTrackSource(row, sourceOwner),
      subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    });
  }
  function configureActivityProvider({readActivity, resolveActivityTrack, resolveActivityNativeTarget} = {}) {
    eraseActivity(); actionSequence++; activitySourceEpoch++;
    friendActivityEpochs.clear();
    activityProvider = typeof readActivity === 'function' ? {read: readActivity, resolve: typeof resolveActivityTrack === 'function' ? resolveActivityTrack : null, resolveNative: typeof resolveActivityNativeTarget === 'function' ? resolveActivityNativeTarget : null} : null;
    const provider = activityProvider;
    if (!provider) return null;
    return async function readActivityProjection(options = {}) {
      const start = sync(), query = activityQuery(options);
      if (!start.visible || options.scopeKey !== start.scopeKey || provider !== activityProvider || !query) throw superseded();
      activitySourceEpoch++;
      const previous = activity, append = typeof options.cursor === 'string' && Boolean(options.cursor);
      const context = Object.freeze({scopeKey: start.scopeKey, account_ref: options.account_ref ?? null, kind: options.kind, period: options.period});
      if (context.account_ref != null && !friendActivityEpochs.has(context.account_ref)) friendActivityEpochs.set(context.account_ref, 0);
      const owner = {provider, scopeKey: start.scopeKey, query, context,
        snapshotRef: append && previous?.query === query ? previous.snapshotRef : null,
        nativeRows: new Map(append && previous?.query === query ? previous.nativeRows : []),
        rows: new Map(append && previous?.query === query ? previous.rows : []),
        resources: new Map(append && previous?.query === query ? previous.resources : []),
        cursors: new Set(append && previous?.query === query ? previous.cursors : [])};
      activity = owner; actionSequence++;
      const epoch = TrackActionsRuntime.readEpoch();
      const active = () => {const next = sync(); return !options.signal?.aborted && activity === owner && activityProvider === provider && next.visible && next.scopeKey === start.scopeKey;};
      try {
        const result = await provider.read({...options, ...context});
        if (!active()) throw superseded();
        const wrapped = own(result, 'status'), status = wrapped ? result.status : 'ready', data = wrapped ? result.data : result;
        if (['denied', 'unavailable'].includes(status)) {owner.rows.clear(); owner.resources.clear(); owner.nativeRows.clear(); return {status};}
        if (status === 'empty' && data == null) {
          if (options.pagination) throw failure('Activity returned an invalid page.');
          return {status};
        }
        if (!['ready', 'empty'].includes(status) || !Array.isArray(data?.rows)
          || data.rows.some(row => !row || !opaque(row.id) || !['album', 'artist', 'track', 'listen'].includes(row.kind))
          || new Set(data.rows.map(row => row.id)).size !== data.rows.length) {
          throw failure('Activity returned an invalid response.');
        }
        const revocations = new Map(append && previous?.query === query ? data.rows.filter(row => previous.rows.has(row.id) && unreadableActivityRow(row))
          .map(row => [row.id, Object.freeze({id: row.id, kind: previous.rows.get(row.id).kind, source_readable: false})]) : []);
        const page = data.pagination;
        const origin = selectionApi()?.projectOrigin({source: 'activity', account_ref: context.account_ref,
          kind: context.kind, period: context.period, ...(data.snapshot_ref != null ? {snapshot_ref: data.snapshot_ref} : {})});
        owner.snapshotRef = origin?.snapshot_ref ?? null;
        if (!origin) owner.resources.clear();
        const invalidMetadata = status === 'empty' && data.rows.length
          || data.next_cursor != null && (typeof data.next_cursor !== 'string' || !data.next_cursor.trim())
          || page != null && (typeof page !== 'object' || Array.isArray(page) || !['mode', 'page', 'page_size', 'total_rows'].every(key => own(page, key)) || page.mode !== 'numbered' || page.page_size !== 100
          || !Number.isSafeInteger(page.page) || page.page < 1 || !Number.isSafeInteger(page.total_rows) || page.total_rows < 0
          || page.page > Math.max(1, Math.ceil(page.total_rows / 100)) || data.next_cursor != null
          || data.rows.length !== Math.min(100, Math.max(0, page.total_rows - (page.page - 1) * 100)));
        if (invalidMetadata && !revocations.size) throw failure('Activity returned an invalid page.');
        if (options.pagination && (!page || page.page !== options.pagination.page)) throw failure('Activity returned an invalid page.');
        const invalidAppend = append && (invalidMetadata || page || owner.cursors.has(options.cursor) || data.next_cursor === options.cursor || owner.cursors.has(data.next_cursor)
          || data.rows.length && data.rows.every(row => owner.rows.has(row.id)));
        if (invalidAppend && !revocations.size) throw failure('Activity returned an invalid page.');
        if (append && !invalidAppend) owner.cursors.add(options.cursor);
        const rows = data.rows.map(row => {
          const publicRow = {id: row.id, kind: ['album', 'artist', 'track', 'listen'].includes(row.kind) ? row.kind : null};
          for (const key of ['title', 'artist', 'secondary_artist', 'album_title', 'last_listened_at', 'source_label']) {
            if (own(row, key)) publicRow[key] = typeof row[key] === 'string' ? row[key] : '';
          }
          for (const key of ['listen_count', 'duration_seconds', 'rating']) {
            if (own(row, key)) publicRow[key] = typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0 ? row[key] : null;
          }
          if (own(row, 'favorite')) publicRow.favorite = typeof row.favorite === 'boolean' ? row.favorite : null;
          if (own(row, 'taste_state')) publicRow.taste_state = typeof row.taste_state === 'string' ? row.taste_state : null;
          if (own(row, 'availability')) publicRow.availability = ['local', 'missing', 'unresolved'].includes(row.availability) ? row.availability : null;
          if (own(row, 'love_tier')) publicRow.love_tier = ['off', 'loved', 'obsessed'].includes(row.love_tier) ? row.love_tier : null;
          if (unreadableActivityRow(row)) {
            const redacted = Object.freeze({id: row.id, kind: publicRow.kind, source_readable: false});
            owner.rows.set(row.id, redacted); owner.resources.delete(row.id); owner.nativeRows.delete(row.id); return redacted;
          }
          publicRow.source_readable = true;
          publicRow.artwork_url = typeof row.artwork_url === 'string' && row.artwork_url.startsWith('/') && !row.artwork_url.startsWith('//')
            && !/[\\\x00-\x20\x7f]/.test(row.artwork_url) ? row.artwork_url : null;
          publicRow.detail_ref = opaque(row.detail_ref) ? row.detail_ref : null;
          publicRow.allowed_actions = Object.freeze({can_view_details: own(row.allowed_actions, 'can_view_details') && row.allowed_actions.can_view_details === true,
            can_resolve_native_play: own(row.allowed_actions, 'can_resolve_native_play') && row.allowed_actions.can_resolve_native_play === true,
            can_select_for_playlist: own(row.allowed_actions, 'can_select_for_playlist') && row.allowed_actions.can_select_for_playlist === true});
          if (publicRow.allowed_actions.can_select_for_playlist) {
            const inventory = typeof row.inventory_track_ref === 'string' && /^inventory-track:[1-9]\d*:[1-9]\d*$/.test(row.inventory_track_ref) ? row.inventory_track_ref : null;
            owner.nativeRows.set(row.id, Object.freeze({inventory_track_ref: inventory, activity_row_ref: row.id,
              source_readable: true, allowed_actions: {can_read: true}, playback_state: {can_start_here: false}}));
          } else owner.nativeRows.delete(row.id);
          publicRow.album_target = origin ? resourceTarget(row.album_target, 'album', origin) : null;
          publicRow.artist_target = origin ? resourceTarget(row.artist_target, 'artist', origin) : null;
          if (!invalidAppend) {
            owner.rows.set(row.id, publicRow);
            owner.resources.set(row.id, Object.freeze({album: publicRow.album_target,
              artist: privateResourceTarget(row.artist_target, publicRow.artist_target)}));
          }
          const source = invalidAppend ? null : currentActivityTrack(publicRow, context);
          TrackActionsRuntime.acceptRead(source, epoch);
          const preference = TrackActionsRuntime.preference(source);
          if (preference) publicRow.track_preference = preference;
          else if (own(row, 'track_preference')) {
            const overlay = TrackActionsRuntime.overlay(row.track_preference);
            if (overlay) {publicRow.love_tier = overlay.love_tier; publicRow.rating = overlay.rating;}
          }
          return Object.freeze(publicRow);
        });
        if (!active()) throw superseded();
        const projected = {rows: Object.freeze(rows)};
        if (owner.snapshotRef) projected.snapshot_ref = owner.snapshotRef;
        if (own(data, 'total_listens')) projected.total_listens = typeof data.total_listens === 'number' && Number.isFinite(data.total_listens) && data.total_listens >= 0 ? data.total_listens : null;
        for (const key of ['period_label', 'range_label']) if (own(data, key)) projected[key] = typeof data[key] === 'string' ? data[key] : null;
        // Keep a supplied invalid cursor invalid after removing its private
        // structure; null would incorrectly turn the rejected page into EOF.
        if (own(data, 'next_cursor')) projected.next_cursor = data.next_cursor == null ? null : typeof data.next_cursor === 'string' ? data.next_cursor : '';
        if (own(data, 'pagination')) projected.pagination = data.pagination == null ? null : Object.freeze(Object.fromEntries(
          ['mode', 'page', 'page_size', 'total_rows'].filter(key => own(data.pagination, key)).map(key => [key,
            key === 'mode' ? (typeof data.pagination[key] === 'string' ? data.pagination[key] : null) : Number.isSafeInteger(data.pagination[key]) ? data.pagination[key] : null])));
        if (invalidAppend) {
          // The controller must see explicit denial even when its existing
          // no-progress/cursor contract rejects navigation. Retain the old page
          // and cursor privately, but never retain authority for revoked rows.
          for (const [id, row] of revocations) {previous.rows.set(id, row); previous.resources.delete(id); previous.nativeRows.delete(id);}
          activity = previous;
        }
        return Object.freeze(wrapped ? {status, data: Object.freeze(projected)} : projected);
      } catch (error) {
        if (active()) {
          activity = (append || options.pagination) && previous?.query === query && ![401, 403].includes(error.status) ? previous : null;
          if (!activity) owner.resources.clear();
          actionSequence++;
        }
        throw error;
      }
    };
  }
  function sourceResource(selection, context = {}) {
    const snapshot = sync(), api = selectionApi(), target = api?.projectTarget(selection);
    const origin = api?.projectOrigin(context.origin ?? target?.origin);
    if (!snapshot.visible || context.scopeKey !== snapshot.scopeKey || !target || !origin
      || target.origin && JSON.stringify(target.origin) !== JSON.stringify(origin)) return null;
    if (origin.source === 'recent') {
      if (origin.account_ref !== null || origin.kind !== 'albums' || origin.period !== 'week' || origin.snapshot_ref
        || target.kind !== 'album') return null;
      let row;
      try {row = requireGrant('open', target.ref, snapshot.scopeKey);} catch {return null;}
      return recentResourceTarget(target.ref, origin, row);
    }
    const owner = activity;
    if (origin.source !== 'activity' || !owner || owner.provider !== activityProvider || owner.scopeKey !== snapshot.scopeKey
      || owner.query !== activityQuery(origin) || (origin.snapshot_ref ?? null) !== owner.snapshotRef) return null;
    return activityResourceTarget(owner.resources, target, origin);
  }
  function activityResourceTarget(resources, target, origin) {
    const found = [];
    for (const targets of resources.values()) {
      const currentTarget = targets[target.kind];
      if (currentTarget?.ref === target.ref
        && currentTarget.allowed_actions.can_view_details === true
        && JSON.stringify(currentTarget.origin) === JSON.stringify(origin)) found.push(currentTarget);
    }
    return found.length && found.every(value => JSON.stringify(value) === JSON.stringify(found[0])) ? found[0] : null;
  }
  async function resolveActivityResource(selection, context = {}) {
    const target = sourceResource(selection, context), owner = activity;
    if (target?.origin?.source !== 'activity') return target;
    if (!owner) throw failure('This native source is unavailable.', 403);
    if (typeof owner.provider.resolveNative !== 'function') {
      if (target.native_actions) return target;
      throw failure('This native source is unavailable.', 403);
    }
    const row = [...owner.resources.entries()].find(([, targets]) => targets[target.kind]?.ref === target.ref);
    if (!row) throw failure('This native source is unavailable.', 403);
    const value = await owner.provider.resolveNative({...owner.context, snapshot_ref: owner.snapshotRef, rowId: row[0], intent: 'details', target_kind: target.kind, signal: context.signal});
    if (context.signal?.aborted || owner !== activity || !sourceResource(selection, context)) throw superseded();
    let admitted;
    if (target.kind === 'album' && typeof value.album_ref === 'string' && value.allowed_actions?.can_view_details === true) {
      admitted = {...target, native_actions: {album_ref: value.album_ref,
        allowed_actions: {can_open_album: true, can_play_album: value.allowed_actions.can_play_album === true}}};
    } else if (target.kind === 'artist' && typeof value.artist_ref === 'string' && value.allowed_actions?.can_view_details === true) {
      admitted = {...target, native_actions: {artist_ref: value.artist_ref, allowed_actions: {can_open_artist_gallery: true}},
        gallery_target: {artist: value.artist_ref}};
    } else throw failure('This native target is unavailable.');
    admitted = {...admitted, title: typeof value.title === 'string' ? value.title : '', artist: typeof value.artist === 'string' ? value.artist : '',
      subject_taste: target.origin.account_ref != null ? value.subject_taste : null};
    owner.resources.set(row[0], Object.freeze({...row[1], [target.kind]: Object.freeze(admitted)}));
    return admitted;
  }
  function projectSubjectAlbum(album, selection, context = {}) {
    const subject = selection.origin?.account_ref;
    if (selection.origin?.source !== 'activity' || subject == null) return album;
    const supplied = context.subjectTaste || sourceResource(selection, context)?.subject_taste;
    const taste = supplied?.subject_ref === subject && supplied.read_only === true ? supplied : {tracks: [], rating: null, favorite: null};
    const byRef = new Map((Array.isArray(taste.tracks) ? taste.tracks : []).map(row => [row.inventory_track_ref, row]));
    // Clone every container before overlaying subject facts; fetched native album
    // caches and the signed-in listener's preferences must remain untouched.
    const personal = new Set(['love_tier', 'track_rating', 'play_count', 'last_listened_at_ms', 'added_at', 'added_at_ms', 'album_rating', 'rating', 'favorite', 'is_favorite', 'listen_count', 'last_listened_at',
      'track_scrobble_count', 'scrobble_count', 'track_stats', 'listening_progress', 'listen_progress',
      'album_preference', 'album_preference_overlay', 'track_preference', 'track_preference_overlay', 'tag_album_rating', 'tag_album_rating_source']);
    const copy = value => {
      if (Array.isArray(value)) return value.map(copy);
      if (!value || typeof value !== 'object') return value;
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = personal.has(key) ? null : copy(child);
      result.can_edit_preferences = false; result.read_only_subject = subject;
      if (typeof value.inventory_track_ref === 'string') {
        const row = byRef.get(value.inventory_track_ref);
        const rating = Number.isInteger(row?.rating) && row.rating >= 1 && row.rating <= 5 ? row.rating : null;
        const tier = ['off', 'loved', 'obsessed'].includes(row?.love_tier) ? row.love_tier : null;
        result.read_only_subject = subject; result.rating = rating; result.love_tier = tier;
        result.track_preference = result.track_preference_overlay = {rating, love_tier: tier, allowed_actions: {can_set_love_tier: false}};
      }
      return result;
    };
    const result = copy(album);
    result.read_only_subject = subject;
    result.album_rating = Number.isInteger(taste.rating) && taste.rating >= 1 && taste.rating <= 10 ? taste.rating : null;
    result.favorite = typeof taste.favorite === 'boolean' ? taste.favorite : null;
    return result;
  }
  function retainResource(selection, context = {}) {
    if (context.signal?.aborted) return null;
    const target = sourceResource(selection, context), snapshot = sync();
    if (!target) return null;
    const origin = target.origin, payload = recent, recentEpoch = recentReadEpoch;
    const resources = activity?.resources, provider = activity?.provider, activityEpoch = activitySourceEpoch, key = JSON.stringify(target);
    const friendEpoch = origin.account_ref == null ? null : friendActivityEpochs.get(origin.account_ref);
    const isCurrent = () => {
      const current = sync();
      if (!current.authenticated || current.scopeKey !== snapshot.scopeKey) return false;
      if (origin.source === 'recent') return recent === payload && recentReadEpoch === recentEpoch;
      return origin.source === 'activity' && provider === activityProvider && activitySourceEpoch === activityEpoch
        && (origin.account_ref == null || friendActivityEpochs.get(origin.account_ref) === friendEpoch)
        && JSON.stringify(activityResourceTarget(resources, target, origin)) === key;
    };
    return isCurrent() ? Object.freeze({target: selectionApi().projectTarget(target), isCurrent}) : null;
  }
  function retireFriendActivity({scopeKey, friends} = {}) {
    if (scopeKey !== `${identity}:${scopeGeneration}` || !['ready', 'empty', 'denied', 'unavailable', 'error'].includes(friends?.status)) return false;
    const accepted = new Set(['ready', 'empty'].includes(friends.status) && Array.isArray(friends.data?.friends)
      ? friends.data.friends.filter(row => row?.relationship === 'accepted' && own(row.allowed_actions, 'can_view_activity')
        && row.allowed_actions.can_view_activity === true).map(row => row.account_ref) : []);
    let retired = false;
    for (const [accountRef, epoch] of friendActivityEpochs) {
      if (!accepted.has(accountRef)) {friendActivityEpochs.set(accountRef, epoch + 1); retired = true;}
    }
    if (activity?.scopeKey === scopeKey && activity.context.account_ref != null && !accepted.has(activity.context.account_ref)) {
      eraseActivity(); actionSequence++; retired = true;
    }
    return retired;
  }
  function recentResourceTarget(ref, origin, row) {
    return selectionApi().projectTarget({kind: 'album', ref, origin, allowed_actions: {can_view_details: true},
      native_actions: {album_ref: ref, allowed_actions: {can_open_album: true,
        can_play_album: row.allowed_actions.can_play_album === true,
        ...(own(row.allowed_actions, 'can_view_artwork') ? {can_view_artwork: row.allowed_actions.can_view_artwork === true} : {}),
        ...(own(row.allowed_actions, 'can_open_album_page') ? {can_open_album_page: row.allowed_actions.can_open_album_page === true} : {})}}});
  }
  async function revalidateResource(selection, context = {}, {signal} = {}) {
    const api = selectionApi(), target = api?.projectTarget(selection), origin = api?.projectOrigin(context.origin ?? target?.origin);
    if (target?.kind === 'album' && origin?.source === 'activity' && typeof activityProvider?.resolveNative === 'function') {
      const provider = activityProvider, start = sync(), url = window.location.href;
      if (!start.authenticated || start.scopeKey !== context.scopeKey || signal?.aborted) throw superseded();
      const value = await provider.resolveNative({scopeKey: start.scopeKey, account_ref: origin.account_ref, kind: origin.kind,
        period: origin.period, snapshot_ref: origin.snapshot_ref, rowId: target.ref, intent: 'details', target_kind: 'album', signal});
      const isCurrent = () => !signal?.aborted && sync().scopeKey === start.scopeKey && activityProvider === provider;
      if (!isCurrent() || window.location.href !== url || typeof value.album_ref !== 'string' || value.allowed_actions?.can_view_details !== true) throw superseded();
      const prior = target.native_actions?.allowed_actions || {};
      return {target: api.projectTarget({...target, origin, native_actions: {album_ref: value.album_ref,
        allowed_actions: {can_open_album: prior.can_open_album !== false,
          can_play_album: prior.can_play_album !== false && value.allowed_actions.can_play_album === true,
          ...(prior.can_open_album_page === false ? {can_open_album_page: false} : {}),
          ...(prior.can_view_artwork === false ? {can_view_artwork: false} : {})}}}), isCurrent, subjectTaste: value.subject_taste};
    }
    // This reader is the real own-week Recent source. Other origins need their
    // own freshly resolved authority; an expired projection cannot substitute.
    if (!target || target.kind !== 'album' || !origin || origin.source !== 'recent' || origin.account_ref !== null
      || origin.kind !== 'albums' || origin.period !== 'week' || origin.snapshot_ref) return null;
    const start = sync(), sourceUrl = window.location.href, sourceEntry = start.entryKey;
    if (!start.authenticated || context.scopeKey !== start.scopeKey || target.allowed_actions.can_view_details !== true
      || target.origin && JSON.stringify(target.origin) !== JSON.stringify(origin)
      || target.native_actions && target.native_actions.album_ref !== target.ref) throw failure('This Album source is unavailable.', 403);
    if (signal?.aborted) throw superseded();
    const pending = readRecentSource({signal}), epoch = recentReadEpoch;
    const {projection: payload} = await pending;
    const isCurrent = () => {
      const snapshot = sync();
      return !signal?.aborted && snapshot.authenticated && snapshot.scopeKey === start.scopeKey
        && recentReadEpoch === epoch && recent === payload;
    };
    if (!isCurrent() || window.location.href !== sourceUrl || sync().entryKey !== sourceEntry) throw superseded();
    const matches = payload?.recent_local_albums.filter(row => row.album_ref === target.ref) || [];
    const row = matches.length === 1 ? matches[0] : null;
    if (!row || row.row_kind !== 'local_album' || row.local_match_state !== 'matched_local' || row.source_readable === false
      || row.allowed_actions.can_open_album !== true) throw failure('This Album source is unavailable.', 403);
    const fresh = recentResourceTarget(target.ref, origin, row), allowed = {...fresh.native_actions.allowed_actions};
    for (const key of ['can_open_album', 'can_play_album', 'can_view_artwork', 'can_open_album_page']) {
      if (target.native_actions?.allowed_actions[key] === false) allowed[key] = false;
    }
    return Object.freeze({target: api.projectTarget({...fresh, native_actions: {album_ref: target.ref, allowed_actions: allowed}}), isCurrent});
  }
  function canTrackIntent(intent, row, context) {
    if (intent !== 'play') return false;
    const source = currentActivityTrack(row, context), owner = activity;
    return TrackActionsRuntime.canPlay(source) || Boolean(owner && sync().visible && sync().scopeKey === context?.scopeKey
      && owner.query === activityQuery(context) && owner.rows.get(row?.id)?.allowed_actions?.can_resolve_native_play === true
      && typeof owner.provider.resolveNative === 'function');
  }
  async function trackIntent(intent, row, context) {
    const playerToken = typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null;
    let source = currentActivityTrack(row, context);
    const owner = activity, sequence = ++actionSequence;
    if (playerToken !== (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null)) throw superseded();
    if (!canTrackIntent(intent, row, context)) throw failure('This track action is unavailable.', 403);
    if (typeof owner.provider.resolveNative === 'function') {
      const value = await owner.provider.resolveNative({...owner.context, snapshot_ref: owner.snapshotRef, rowId: row.id, intent: 'play', signal: context.signal});
      if (context.signal?.aborted || owner !== activity || sequence !== actionSequence || !sync().visible || sync().scopeKey !== context.scopeKey
        || playerToken !== (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null)) throw superseded();
      if (typeof value?.path !== 'string' || !value.path || typeof value.track_ref !== 'string') throw failure('This track is unavailable.');
      source = Object.freeze({...source, ...value, playback_state: Object.freeze({can_start_here: true})});
      owner.nativeRows.set(row.id, source);
    }
    if (playerToken !== (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null)) throw superseded();
    TrackActionsRuntime.play(source);
  }
  async function setTrackLove({row, context, love_tier, signal} = {}) {
    const source = currentActivityTrack(row, context), owner = activity, sequence = actionSequence;
    if (!source) throw failure('Track love editing is unavailable.', 403);
    return TrackActionsRuntime.setLove({source, love_tier, signal, isCurrent() {
      const latest = currentActivityTrack(row, context);
      return activity === owner && actionSequence === sequence && latest?.track_ref === source.track_ref
        && latest?.track_preference?.allowed_actions.can_set_love_tier === true;
    }});
  }
  function requireGrant(intent, albumRef, scopeKey) {
    const snapshot = sync();
    const matches = recent?.recent_local_albums.filter(row => row.album_ref === albumRef) || [];
    const row = matches.length === 1 ? matches[0] : null;
    if (!snapshot.visible || snapshot.scopeKey !== scopeKey || !row || row.row_kind !== 'local_album' || row.source_readable === false
      || row.local_match_state !== 'matched_local' || row.allowed_actions.can_open_album !== true
      || (intent === 'play' && row.allowed_actions.can_play_album !== true)) {
      throw failure('This album action is no longer available.', 403);
    }
    return row;
  }
  async function albumIntent(intent, albumRef) {
    if (!['open', 'play'].includes(intent) || typeof albumRef !== 'string' || !albumRef.trim()) {
      throw failure('Unsupported Home album action.');
    }
    const scopeKey = sync().scopeKey;
    requireGrant(intent, albumRef, scopeKey);
    const sequence = ++actionSequence;
    const modalToken = Number(state.ui?.pendingTrackModalLoadToken || 0);
    const playerToken = typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null;
    if (typeof fetchTrackModalAlbumDetails !== 'function') throw failure('Album details are unavailable.');
    const album = await fetchTrackModalAlbumDetails(albumRef);
    if (sequence !== actionSequence
      || (intent === 'open' && modalToken !== Number(state.ui?.pendingTrackModalLoadToken || 0))
      || (intent === 'play' && playerToken !== (typeof playerTrackSelectionToken === 'number' ? playerTrackSelectionToken : null))) {
      throw superseded();
    }
    requireGrant(intent, albumRef, scopeKey);
    if (!album || String(album.key || album.album_ref || '') !== albumRef) {
      throw failure('Album details did not match this recent album.');
    }
    if (typeof albumRequiresHydration === 'function' && albumRequiresHydration(album)) {
      throw failure('Album details are incomplete.');
    }
    if (intent === 'open') {
      if (typeof getTrackModalElements === 'function' && !getTrackModalElements()?.overlay) {
        throw failure('Album details are unavailable.');
      }
      if (typeof openTrackModal !== 'function') throw failure('Album details are unavailable.');
      openTrackModal(album, { coverLightboxGallery: false, foreground: true });
      return;
    }
    if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) {
      throw failure('Album playback is no longer available.', 403);
    }
    if (typeof buildAlbumPlaybackQueueState !== 'function' || typeof setAlbumPlaybackQueue !== 'function'
      || typeof playTrackFromPayload !== 'function') throw failure('Album playback is unavailable.');
    const queue = buildAlbumPlaybackQueueState(album);
    const track = queue?.tracks?.[0];
    if (!track?.path || !track.src) throw failure('This album has no playable tracks.');
    const previousQueue = state.player.playbackQueue;
    setAlbumPlaybackQueue(album, track.path);
    const selectedQueue = state.player.playbackQueue;
    try {
      const started = await playTrackFromPayload(track);
      if (started !== true) throw failure('Album playback did not start.');
    } catch (error) {
      if (state.player.playbackQueue === selectedQueue) state.player.playbackQueue = previousQueue;
      throw error;
    }
  }
  function albumDetailSelection(ref, scopeKey) {
    try {
      requireGrant('open', ref, scopeKey);
      return Object.freeze({kind: 'album', ref, allowed_actions: Object.freeze({can_view_details: true})});
    } catch { return null; }
  }
  async function readAlbumProjection({scopeKey, kind, ref, origin: requestedOrigin, signal} = {}) {
    if (requestedOrigin?.source === 'activity') {
      const selection = {kind, ref, origin: requestedOrigin, allowed_actions: {can_view_details: true}};
      const resolvedTarget = await resolveActivityResource(selection, {scopeKey, origin: requestedOrigin, signal});
      const row = activity?.rows.get(ref);
      if (!row) return {status: 'unavailable'};
      return {kind, ref, origin: requestedOrigin, title: resolvedTarget.title || row.title, artist: resolvedTarget.artist || row.artist, metadata_state: 'current',
        source_label: 'Album Haven', ...(kind === 'album' ? {tracks: null} : {listened_albums: null, discography: null})};
    }
    if (kind !== 'album') return {status: 'unavailable'};
    const origin = requestedOrigin == null ? null : selectionApi()?.projectOrigin(requestedOrigin);
    if (requestedOrigin != null && (!origin || origin.source !== 'recent' || origin.account_ref !== null
      || origin.kind !== 'albums' || origin.period !== 'week' || origin.snapshot_ref)) return {status: 'unavailable'};
    requireGrant('open', ref, scopeKey);
    if (signal?.aborted) throw superseded();
    if (typeof fetchTrackModalAlbumDetails !== 'function') return {status: 'unavailable'};
    const album = await fetchTrackModalAlbumDetails(ref, {signal});
    if (signal?.aborted) throw superseded();
    requireGrant('open', ref, scopeKey);
    if (!album || String(album.key || album.album_ref || '') !== ref || !Array.isArray(album.tracks)
      || album.tracks.some(row => !row || typeof row !== 'object')) throw failure('Album details returned an invalid response.');
    const string = value => typeof value === 'string' ? value : '';
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    return {kind: 'album', ref, ...(origin ? {origin} : {}), title: string(album.name || album.title), artist: string(album.album_artist || album.artist),
      year: album.year == null ? '' : String(album.year), release_type: string(album.release_type), artwork_url: null,
      metadata_state: ['current', 'last_known'].includes(album.metadata_state) ? album.metadata_state : 'unknown',
      summary: string(album.summary), source_label: 'Local library', track_count: count(album.track_count), duration_seconds: number(album.duration_seconds),
      tracks: Array.from(album.tracks, (row, index) => ({id: `row:${index}`, title: string(row.title), artist: string(row.artist || row.secondary_artist),
        track_number: count(row.track_number), disc_number: count(row.disc_number), duration_seconds: number(row.duration_seconds)}))};
  }
  function savePresentation(value, expected = sync()) {
    const snapshot = sync();
    if (!snapshot.visible || snapshot.entryKey === null || expected.scopeKey !== snapshot.scopeKey
      || expected.entryKey !== snapshot.entryKey || expected.section !== snapshot.section || expected.friendRef !== snapshot.friendRef
      || expected.profileRef !== snapshot.profileRef) return false;
    const presentation = presentationValue(value);
    if (!presentation) return false;
    if (JSON.stringify(presentation) === JSON.stringify(snapshot.presentation)) return true;
    try {
      window.history.replaceState({...window.history.state,
        homeFriendsPresentation: {version: 1, scopeKey: snapshot.scopeKey, value: presentation},
      }, '');
    } catch (_error) { return false; } // Browser history quotas must not break the live view.
    sync();
    return true;
  }
  function openForm(options) {return openReactFormDialog(options, () => sync().visible);}
  function openFriendRequestForm({scopeKey, isCurrent, ...options} = {}) {
    const available = () => {
      const snapshot = sync(), drawer = document.getElementById('cover-lookup-drawer');
      return snapshot.authenticated && snapshot.scopeKey === scopeKey && options.pageId === 'home-friend-request'
        && options.parentSurface === '#cover-lookup-drawer' && drawer?.isConnected === true && drawer.hidden === false
        && typeof isCurrent === 'function' && isCurrent() === true;
    };
    const {pageId: _requestMarker, ...dialogOptions} = options;
    return openReactFormDialog(dialogOptions, available);
  }
  function navigate({ section = 'recent', friend = '', profile = '' } = {}) {
    if (!sync().visible || !['recent', 'friends'].includes(section) || typeof friend !== 'string'
      || typeof profile !== 'string' || friend && profile) {
      throw failure('This Home destination is unavailable.');
    }
    const url = new URL(window.location.href);
    if (section === 'recent') url.searchParams.delete('home_section');
    else url.searchParams.set('home_section', section);
    if (section === 'friends' && friend) url.searchParams.set('home_friend', friend);
    else url.searchParams.delete('home_friend');
    if (section === 'friends' && profile) url.searchParams.set('home_profile', profile);
    else url.searchParams.delete('home_profile');
    if (url.href === window.location.href) return;
    const snapshot = { ...(window.history.state || {}) };
    const navigation = window.AlbumHavenSettingsNavigation?.instance;
    if (navigation?.pushLibraryHistory) navigation.pushLibraryHistory(url.href, snapshot);
    else window.history.pushState(snapshot, '', url.href);
    sync();
  }
  async function openFriendProfile({scopeKey, accountRef, isCurrent} = {}) {
    const start = sync(), sequence = ++profileNavigationSequence;
    if (!start.authenticated || start.scopeKey !== scopeKey || typeof accountRef !== 'string' || !accountRef.trim()
      || accountRef.length > 512 || /[\x00-\x1f\x7f]/.test(accountRef) || typeof isCurrent !== 'function') return false;
    const sourceUrl = window.location.href, sourceEntry = start.entryKey;
    const currentScope = () => {const value = sync(); return sequence === profileNavigationSequence && value.authenticated && value.scopeKey === scopeKey;};
    const currentSource = () => {try {return currentScope() && isCurrent() === true;} catch {return false;}};
    const run = async () => {
      if (!currentSource() || window.location.href !== sourceUrl || sync().entryKey !== sourceEntry) return false;
      if (sync().visible) {
        navigate({section: 'friends', profile: accountRef});
        return currentScope() && sync().visible && sync().profileRef === accountRef;
      }
      const navigation = window.AlbumHavenSettingsNavigation?.instance;
      if (typeof navigation?.writeLibraryHistory !== 'function' || typeof fetchAndRender !== 'function') return false;
      let returnedFromSettings = false;
      if (document.getElementById('app-shell')?.hidden === true) {
        if (typeof navigation.navigate !== 'function' || !currentSource()) return false;
        const returning = navigation.navigate('/', {historyMode: 'push'});
        const returnUrl = window.location.href, returnEntry = sync().entryKey;
        if (await returning !== true || !currentScope() || window.location.href !== returnUrl || sync().entryKey !== returnEntry) return false;
        returnedFromSettings = true;
      }
      if (!currentScope() || document.getElementById('app-shell')?.hidden === true || new URL(window.location.href).pathname !== '/') return false;
      if (!sync().visible) {
        if (!currentSource()) return false;
        const priorUrl = window.location.href, priorEntry = sync().entryKey, priorView = state.view;
        let requestId = null;
        const pending = fetchAndRender('/home-data', !returnedFromSettings, {source: 'library', shouldApplyResponse(payload) {
          return currentSource() && window.location.href === priorUrl
            && sync().entryKey === priorEntry && state.view === priorView
            && (requestId === null || state.ui.activeViewRequestId === requestId)
            && String(payload?.surface?.active || payload?.surface_request || '').toLowerCase() === 'home';
        }});
        requestId = state.ui.activeViewRequestId;
        if (await pending !== true || !currentScope() || state.ui.activeViewRequestId !== requestId
          || String(state.view?.surface?.active || state.view?.surface_request || '').toLowerCase() !== 'home') return false;
      }
      // Entering Home intentionally hands source ownership to its controller.
      // The URL carries identity only; the new projection independently grants it.
      const url = new URL(typeof buildUrl === 'function' ? buildUrl(state.view) : window.location.href, window.location.href);
      url.searchParams.set('surface', 'home'); url.searchParams.set('home_section', 'friends');
      url.searchParams.set('home_profile', accountRef); url.searchParams.delete('home_friend');
      if (!currentScope()) return false;
      navigation.writeLibraryHistory(url.href, window.history.state, {mode: 'replace'});
      if (typeof syncMobileHome === 'function') syncMobileHome();
      const completed = sync();
      return completed.visible && completed.scopeKey === scopeKey && completed.profileRef === accountRef;
    };
    try {
      if (!currentSource()) return false;
      const deferred = typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(run);
      return await (deferred || run()) === true;
    } catch (error) {
      if (error?.name !== 'AbortError' && currentSource() && typeof showToast === 'function') {
        showToast('This profile could not be opened. Please try again.', 'error');
      }
      return false;
    }
  }
  PrivateUITransport.subscribe(sync);
  window.addEventListener('popstate', sync);
  // Settings retains the library view while hiding its shell. Observe that
  // native owner rather than wrapping its navigation or history methods.
  const shell = document.getElementById('app-shell');
  if (shell && typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(shell, { attributes: true, attributeFilter: ['hidden', 'data-native-account-id', 'data-native-library-id', 'data-private-ui-context'] });
  }
  const resourceSelection = selectionApi()?.create({sourceResource, retainResource, revalidateResource, authorizeResource: resolveActivityResource, projectAlbum: projectSubjectAlbum});
  return {
    sync, snapshot: sync,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Home requires a subscription listener.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readRecent, albumIntent, albumDetailSelection, readAlbumProjection, navigate, savePresentation, openForm, openFriendRequestForm, openFriendProfile,
    configureActivityProvider, canTrackIntent, trackIntent, trackPreference: activityPreference, setTrackLove, createPlaytableSource, retainPlaytablePresentation,
    readPresencePlayback() {
      const playback = typeof getPlayerPlaybackSnapshot === 'function' ? getPlayerPlaybackSnapshot() : null;
      const locked = typeof isPlaybackLockedByAnotherTab !== 'function' || isPlaybackLockedByAnotherTab();
      const track = state.player?.current;
      const activeTrack = typeof streamingEngineState === 'function' ? streamingEngineState().roles?.current?.track : null;
      if (locked || typeof playback?.paused !== 'boolean' || typeof playback?.ended !== 'boolean'
        || !activeTrack || activeTrack.path !== track?.path || activeTrack.inventory_track_ref !== track?.inventory_track_ref
        || String(playback.src || '') !== String(track?.src || '') || !playback?.src || !/^inventory-track:[1-9]\d*:[1-9]\d*$/.test(track?.inventory_track_ref || '')) return null;
      return {track_ref: track.inventory_track_ref, state: playback.ended === true ? 'stopped' : playback.paused === true ? 'paused' : 'playing'};
    },
    createQueueResourceSelection: options => window.AlbumHavenQueueResourceSelection?.create(options),
    explicitQueue: () => window.AlbumHavenExplicitQueue,
    openPlaytableContext: (...args) => window.AlbumHavenPlaytableUI?.context(...args) ?? false,
    openPlaylistAction: (...args) => window.AlbumHavenPlaytableUI?.open(...args) ?? false,
    retireFriendActivity,
    ...resourceSelection,
    mountResourceSelection(host, options) {
      if (options.selection?.origin?.source !== 'activity' || resourceSelection.canResourceIntent('embed', options.selection, options)) return resourceSelection.mountResourceSelection(host, options);
      const request = new AbortController(); let lease = null, disposed = false;
      options.onState?.('loading');
      resolveActivityResource(options.selection, {...options, signal: request.signal}).then(() => {
        if (!disposed && !request.signal.aborted && host?.isConnected) lease = resourceSelection.mountResourceSelection(host, options);
      }).catch(error => {if (!disposed && error.name !== 'AbortError') {options.onState?.('unavailable'); options.onError?.(error);}});
      return {dispose() {disposed = true; request.abort(); lease?.dispose();}};
    },
    subscribeTrackPreferences: listener => TrackActionsRuntime.subscribePreferences(listener),
    trackPlayback: (row, context) => TrackActionsRuntime.playback(currentActivityTrack(row, context)),
    subscribeTrackPlayback: listener => TrackActionsRuntime.subscribePlayback(listener),
    albumTrackRow: (track, index) => buildAlbumTrackTableRow({id: track.id, title: track.title, secondary_artist: track.secondary_artist,
      availability: track.availability, duration: track.duration_display}, index, {readOnly: true}),
    mountRecent: (host, callbacks) => HomeRecent.mount(host, callbacks),
    mountDashboard: (host, options) => Dashboard.mount(host, options),
    openChoice: (trigger, options) => openUtilityChoiceDropdown(trigger, options),
    buttonHtml: config => ButtonComponent.renderButton(config),
    actionHtml: config => ButtonComponent.renderActionButton(config),
    alertHtml: config => buildOnPageAlertHtml(config),
    galleryBarHtml: config => buildGalleryBarHtml(config),
    tableHtml: config => buildCompactDataTable(config),
    galleryCardHtml: config => buildGalleryCardHtml(config),
    navigationItemHtml: config => window.NavigationTree.renderItem(config),
    artboxHtml: config => buildAlbumArtboxHtml(config),
    detailHeaderHtml: config => buildAlbumDetailsHeaderHtml(config),
    artistInfoHtml: config => buildArtistInfoOverlayHtml(config),
    preferredTimeZone: () => typeof getPreferredUserTimeZone === 'function' ? getPreferredUserTimeZone() : undefined,
    openAvatar(value, label) {
      if (typeof value !== 'string' || !value.trim()) throw failure('Profile image is unavailable.');
      const url = new URL(value, window.location.href);
      if (url.username || url.password || !['http:', 'https:', 'blob:'].includes(url.protocol)
        || (url.protocol === 'blob:' && url.origin !== window.location.origin)) throw failure('Profile image is unavailable.');
      if (typeof openImageLightbox !== 'function') throw failure('Image viewer is unavailable.');
      openImageLightbox(url.href, `${String(label || 'Profile')} image`);
    },
    viewChooserHtml: config => window.UnfoldingActionButton.render(config),
    mountViewChooser(host, options) {
      let owner;
      const configure = config => ({...config,
        onOpen() { activateTriggerSurface(host, () => owner.close(), {anchor: host}); config.onOpen?.(); },
        onClose() { clearTriggerAnchor(host); config.onClose?.(); },
      });
      owner = window.UnfoldingActionButton.mount(host, configure(options));
      return { select: value => owner.select(value), configure: value => owner.configure(configure(value)),
        destroy() { owner.close(); clearTriggerAnchor(host); owner.destroy(); } };
    },
    viewIconHtml(mode) {
      if (!['list', 'cards', 'covers'].includes(mode)) return '';
      const mounted = document.querySelector(`[data-gallery-view-choice="${mode}"] svg`);
      if (mounted) return mounted.outerHTML;
      const fallback = document.createElement('div'); fallback.innerHTML = buildGalleryBarHtml({});
      return fallback.querySelector(`[data-gallery-view-choice="${mode}"] svg`)?.outerHTML || '';
    },
    tabsHtml: config => buildInPageTabsHtml(config),
    mountTabs: host => mountInPageTabs(host),
    confirm: (message, options = {}) => showAppConfirmDialog({ message: String(message || ''),
      ...(typeof options?.title === 'string' ? {title: options.title} : {}),
      ...(typeof options?.acceptLabel === 'string' ? {acceptLabel: options.acceptLabel} : {}),
      ...(own(options, 'danger') ? {danger: options.danger === true} : {}) }),
    escapeHtml,
  };
})();
function syncHomeFriendsRuntime() { HomeFriendsRuntime.sync(); }
window.AlbumHavenHomeRuntime = HomeFriendsRuntime;
window.dispatchEvent(new Event('albumhaven:home-runtime-ready'));
