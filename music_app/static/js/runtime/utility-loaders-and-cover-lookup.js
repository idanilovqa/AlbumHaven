async function loadProblematicFiles(force = false, options = {}) {
  const shouldRender = options.render !== false;
  const navigationOwnsRendering = () => Boolean(
    state.utility.problematicNavigationActiveToken,
  );
  if (state.utility.loading) return state.utility.loadPromise;
  if (state.utility.loaded && !force) {
    if (shouldRender && !navigationOwnsRendering()) renderUtilityModalContent();
    return;
  }
  state.utility.loading = true;
  const requestToken = Number(state.utility.problematicSummaryRequestToken || 0) + 1;
  state.utility.problematicSummaryRequestToken = requestToken;
  if (shouldRender && !navigationOwnsRendering()) renderUtilityModalContent();
  state.utility.loadPromise = (async () => {
    const startedAt = getProblematicUtilityNow();
    let requestMs = 0;
    let parseMs = 0;
    let stateCommitMs = 0;
    let initialDetailKey = '';
    let initialDetailMerged = false;
    let responseStatus = 0;
    let loadSucceeded = false;
    let loadError = '';
    try {
      const requestStartedAt = getProblematicUtilityNow();
      const response = await fetch('/utilities/problematic-files', { headers: { Accept: 'application/json' } });
      requestMs = roundProblematicUtilityMs(getProblematicUtilityNow() - requestStartedAt);
      responseStatus = Number(response.status || 0);
      const parseStartedAt = getProblematicUtilityNow();
      let data;
      try {
        data = await response.json();
      } finally {
        parseMs = roundProblematicUtilityMs(getProblematicUtilityNow() - parseStartedAt);
      }
      if (!response.ok) {
        throw new Error(readProblematicPayloadError(data, 'Unable to load problematic files.'));
      }
      if (Number(state.utility.problematicSummaryRequestToken || 0) !== requestToken) return null;
      const { summaryItems, initialDetail } = validateProblematicSummaryPayload(data);
      const stateCommitStartedAt = getProblematicUtilityNow();
      initialDetailKey = String(initialDetail?.key || '').trim();
      state.utility.problematicFiles = summaryItems.map((item) => {
        if (!initialDetailKey || String(item?.key || '').trim() !== initialDetailKey) return item;
        initialDetailMerged = true;
        return { ...item, ...initialDetail, detail_loaded: true };
      });
      state.utility.detailLoadPromises = {};
      state.utility.loaded = true;
      loadSucceeded = true;
      stateCommitMs = roundProblematicUtilityMs(getProblematicUtilityNow() - stateCommitStartedAt);
      return state.utility.problematicFiles;
    } catch (error) {
      if (Number(state.utility.problematicSummaryRequestToken || 0) !== requestToken) return null;
      loadError = String(error?.message || error || 'Unable to load problematic files.');
      console.error('[AlbumHaven][Utilities] Failed to load problematic files.', error);
      state.utility.problematicFiles = [];
      state.utility.detailLoadPromises = {};
      state.utility.loaded = false;
      showToast('Unable to load problematic files.', 'error', 3200);
      return null;
    } finally {
      const stillOwner = Number(state.utility.problematicSummaryRequestToken || 0) === requestToken;
      if (stillOwner) {
        state.utility.loading = false;
        state.utility.loadPromise = null;
        const renderStartedAt = getProblematicUtilityNow();
        if (shouldRender && !navigationOwnsRendering()) {
          renderUtilityModalContent();
          await waitForProblematicUtilityRenderFrame();
        }
        recordProblematicUtilityDiagnostics('summary', {
          itemCount: Array.isArray(state.utility.problematicFiles) ? state.utility.problematicFiles.length : 0,
          ok: loadSucceeded,
          status: responseStatus,
          error: loadError || null,
          initialDetailKey,
          initialDetailMerged,
          requestMs,
          parseMs,
          stateCommitMs,
          renderMs: roundProblematicUtilityMs(getProblematicUtilityNow() - renderStartedAt),
          totalMs: roundProblematicUtilityMs(getProblematicUtilityNow() - startedAt),
        });
      }
    }
  })();
  return state.utility.loadPromise;
}

async function loadProblematicAlbumDetail(albumKey, force = false, options = {}) {
  const normalizedKey = String(albumKey || '').trim();
  if (!normalizedKey) return null;
  const currentAlbum = (state.utility.problematicFiles || []).find((item) => String(item?.key || '') === normalizedKey) || null;
  if (currentAlbum?.detail_loaded === true && !force) {
    return currentAlbum;
  }
  if (currentAlbum?.detail_load_failed === true && !force) {
    return null;
  }
  const existingPromise = state.utility.detailLoadPromises?.[normalizedKey];
  if (
    existingPromise
    && Number(existingPromise.problematicDetailRequestToken || 0)
      === Number(state.utility.problematicDetailRequestToken || 0)
  ) {
    return existingPromise;
  }
  const requestToken = Number(state.utility.problematicDetailRequestToken || 0) + 1;
  state.utility.problematicDetailRequestToken = requestToken;
  const nextPromise = Promise.resolve().then(async () => {
    const startedAt = getProblematicUtilityNow();
    let requestMs = 0;
    let parseMs = 0;
    let stateCommitMs = 0;
    let responseStatus = 0;
    let loadSucceeded = false;
    let loadError = '';
    try {
      const requestStartedAt = getProblematicUtilityNow();
      const response = await fetch(`/utilities/problematic-files/detail?album_key=${encodeURIComponent(normalizedKey)}`, {
        headers: { Accept: 'application/json' },
      });
      requestMs = roundProblematicUtilityMs(getProblematicUtilityNow() - requestStartedAt);
      responseStatus = Number(response.status || 0);
      const parseStartedAt = getProblematicUtilityNow();
      let data;
      try {
        data = await response.json();
      } finally {
        parseMs = roundProblematicUtilityMs(getProblematicUtilityNow() - parseStartedAt);
      }
      if (!response.ok && options.allowMissing === true && responseStatus === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(readProblematicPayloadError(data, 'Unable to load problematic album detail.'));
      }
      const detail = validateProblematicDetailPayload(data, normalizedKey);
      if (
        state.utility.detailLoadPromises?.[normalizedKey] !== nextPromise
        || Number(state.utility.problematicDetailRequestToken || 0) !== requestToken
        || String(state.utility.selectedProblematicKey || '') !== normalizedKey
      ) return null;
      const stateCommitStartedAt = getProblematicUtilityNow();
      state.utility.problematicFiles = (state.utility.problematicFiles || []).map((item) => (
        String(item?.key || '') === normalizedKey
          ? {
            ...item,
            ...detail,
            detail_loaded: true,
            detail_load_failed: false,
          }
          : item
      ));
      loadSucceeded = true;
      stateCommitMs = roundProblematicUtilityMs(getProblematicUtilityNow() - stateCommitStartedAt);
      return (state.utility.problematicFiles || []).find((item) => String(item?.key || '') === normalizedKey) || null;
    } catch (error) {
      if (Number(state.utility.problematicDetailRequestToken || 0) !== requestToken) return null;
      loadError = String(error?.message || error || 'Unable to load problematic album detail.');
      console.error('[AlbumHaven][Utilities] Failed to load problematic album detail.', error);
      if (state.utility.detailLoadPromises?.[normalizedKey] === nextPromise) {
        state.utility.problematicFiles = (state.utility.problematicFiles || []).map((item) => (
          String(item?.key || '') === normalizedKey
            ? { ...item, detail_load_failed: true }
            : item
        ));
        showToast('Unable to load the selected problematic album.', 'error', 3200);
      }
      return null;
    } finally {
      if (state.utility.detailLoadPromises?.[normalizedKey] === nextPromise) {
        delete state.utility.detailLoadPromises[normalizedKey];
      }
      let renderMs = 0;
      if (
        Number(state.utility.problematicDetailRequestToken || 0) === requestToken
        &&
        options.render !== false
        &&
        state.utility.activeTab === 'problematic-files'
        && String(state.utility.selectedProblematicKey || '') === normalizedKey
      ) {
        const renderStartedAt = getProblematicUtilityNow();
        renderUtilityModalContent();
        await waitForProblematicUtilityRenderFrame();
        renderMs = roundProblematicUtilityMs(getProblematicUtilityNow() - renderStartedAt);
      }
      recordProblematicUtilityDiagnostics('detail', {
        albumKey: normalizedKey,
        ok: loadSucceeded,
        status: responseStatus,
        error: loadError || null,
        requestMs,
        parseMs,
        stateCommitMs,
        renderMs,
        totalMs: roundProblematicUtilityMs(getProblematicUtilityNow() - startedAt),
        detailLoaded: Boolean((state.utility.problematicFiles || []).find((item) => String(item?.key || '') === normalizedKey)?.detail_loaded),
      });
    }
  });
  nextPromise.problematicDetailRequestToken = requestToken;
  state.utility.detailLoadPromises[normalizedKey] = nextPromise;
  return nextPromise;
}

function isProblematicPayloadObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readProblematicPayloadError(payload, fallback) {
  return isProblematicPayloadObject(payload) && String(payload.error || '').trim()
    ? String(payload.error).trim()
    : fallback;
}

function validateProblematicSummaryPayload(payload) {
  if (!isProblematicPayloadObject(payload)) {
    throw new Error('Problematic Files summary response must be a JSON object.');
  }
  if (payload.ok === false) {
    throw new Error(readProblematicPayloadError(payload, 'Unable to load problematic files.'));
  }
  if (!Array.isArray(payload.items)) {
    throw new Error('Problematic Files summary response must include an items array.');
  }
  if (payload.items.some((item) => !isProblematicPayloadObject(item))) {
    throw new Error('Problematic Files summary items must be JSON objects.');
  }
  if (payload.items.some((item) => item.detail_loaded !== false)) {
    throw new Error('Problematic Files summary items must be marked as not detail loaded.');
  }
  const itemKeys = new Set(payload.items.map((item) => String(item.key || '').trim()));
  if (itemKeys.has('')) {
    throw new Error('Problematic Files summary items must include non-empty keys.');
  }
  const initialDetailValue = payload.initial_detail;
  if (initialDetailValue === undefined || initialDetailValue === null) {
    return { summaryItems: payload.items, initialDetail: null };
  }
  if (!isProblematicPayloadObject(initialDetailValue)) {
    throw new Error('Problematic Files initial detail must be a JSON object or null.');
  }
  const initialDetailKey = String(initialDetailValue.key || '').trim();
  if (!initialDetailKey || !itemKeys.has(initialDetailKey)) {
    throw new Error('Problematic Files initial detail key must match a summary item.');
  }
  return {
    summaryItems: payload.items,
    initialDetail: validateProblematicDetailPayload(initialDetailValue, initialDetailKey),
  };
}

function validateProblematicDetailPayload(payload, requestedKey) {
  if (!isProblematicPayloadObject(payload)) {
    throw new Error('Problematic Files detail response must be a JSON object.');
  }
  if (payload.ok === false) {
    throw new Error(readProblematicPayloadError(payload, 'Unable to load problematic album detail.'));
  }
  const responseKey = String(payload.key || '').trim();
  if (!responseKey || responseKey !== requestedKey) {
    throw new Error('Problematic Files detail response key does not match the requested album.');
  }
  if (payload.detail_loaded !== true) {
    throw new Error('Problematic Files detail response must be marked as detail loaded.');
  }
  const requiredArrayFields = [
    'tracks',
    'repair_preview_rows',
    'track_problem_rows',
    'problematic_track_paths',
  ];
  const invalidArrayField = requiredArrayFields.find((field) => !Array.isArray(payload[field]));
  if (invalidArrayField) {
    throw new Error(`Problematic Files detail response must include a ${invalidArrayField} array.`);
  }
  return payload;
}

function getProblematicUtilityNow() {
  if (typeof window?.performance?.now === 'function') {
    return window.performance.now();
  }
  return Date.now();
}

function roundProblematicUtilityMs(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildProblematicUtilityDiagnosticsStore() {
  const existing = state.utility.problematicDiagnostics;
  if (existing && typeof existing === 'object') {
    if (!existing.detailLoads || typeof existing.detailLoads !== 'object') {
      existing.detailLoads = {};
    }
    return existing;
  }
  state.utility.problematicDiagnostics = {
    summaryLoad: null,
    detailLoads: {},
    lastDetailLoad: null,
  };
  return state.utility.problematicDiagnostics;
}

function recordProblematicUtilityDiagnostics(kind, payload) {
  const diagnostics = buildProblematicUtilityDiagnosticsStore();
  const normalizedPayload = {
    ...payload,
    recordedAt: new Date().toISOString(),
  };
  if (kind === 'summary') {
    diagnostics.summaryLoad = normalizedPayload;
  } else if (kind === 'detail') {
    const albumKey = String(normalizedPayload.albumKey || '');
    if (albumKey) {
      diagnostics.detailLoads[albumKey] = normalizedPayload;
    }
    diagnostics.lastDetailLoad = normalizedPayload;
  }
  console.info('[AlbumHaven][Utilities][Diagnostics]', {
    kind,
    ...normalizedPayload,
  });
  return normalizedPayload;
}

function waitForProblematicUtilityRenderFrame() {
  return new Promise((resolve) => {
    scheduleBrowserAnimationFrame(() => {
      scheduleBrowserAnimationFrame(() => {
        scheduleBrowserAnimationFrame(resolve);
      });
    });
  });
}

async function fetchCoverForAlbum(album, options = {}) {
  if (!album) {
    showToast('No album selected for cover fetch.', 'error', 3200);
    return;
  }
  try {
    console.log('[AlbumHaven][Covers] Starting manual single cover fetch.', {
      albumArtist: album.album_artist || '',
      albumName: album.name || album.album || '',
      year: album.year || null,
      trackCount: Array.isArray(album.tracks) ? album.tracks.length : 0,
      options,
    });
    const response = await fetch('/utilities/fetch-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ album }),
    });
    const data = await response.json().catch(() => ({}));
    console.log('[AlbumHaven][Covers] Manual single cover fetch HTTP response.', {
      status: response.status,
      ok: response.ok,
      body: data,
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to fetch cover art');
    }
    console.log('[AlbumHaven][Covers] Manual single cover fetch response:', data);
    const updatedAlbums = Array.isArray(data.updated_albums)
      ? data.updated_albums
      : [data.updated_album].filter(Boolean);
    if (Number(data.downloaded_count || 0) > 0) {
      markAlbumCoverPathsFresh(updatedAlbums);
    }
    applyUpdatedAlbumsToCurrentView(updatedAlbums, { originalAlbum: album, preserveScroll: true, preserveGrouping: true });
    updateTrackModalIfStillShowingAlbum(album, updatedAlbums);
    if (options.refreshProblematicFiles !== false) {
      await loadProblematicFiles(true);
    }
    showToast(
      Number(data.downloaded_count || 0) > 0
        ? 'Cover art updated.'
        : `Cover was not updated${data.job_result?.reason ? `: ${String(data.job_result.reason).replaceAll('_', ' ')}` : ''}.`,
      Number(data.downloaded_count || 0) > 0 ? 'success' : 'error',
      3200,
    );
  } catch (error) {
    console.error('[AlbumHaven][Utilities] Failed to fetch cover art.', error);
    showToast(error.message || 'Failed to fetch cover art.', 'error', 3200);
  }
}

async function fetchCoverForProblematicAlbum(album) {
  await fetchCoverForAlbum(album, { refreshProblematicFiles: true });
}

async function performAlbumMove(album, action, options = {}) {
  if (!album) {
    showToast('No album selected for move.', 'error', 3200);
    return false;
  }
  const actionConfig = getAlbumMoveActionConfig(album, action);
  if (!actionConfig?.available) {
    const blockedReason = actionConfig?.blockedReasons?.[0] || 'This move action is no longer available.';
    showToast(blockedReason, 'error', 3200);
    return false;
  }
  if (!options.skipConfirm && !showBrowserConfirm(buildAlbumMoveConfirmMessage(album, actionConfig))) {
    return false;
  }

  try {
    const response = await fetch('/utilities/move-album', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmed: true,
        album_key: String(album.key || ''),
        action: actionConfig.action,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to move album');
    }

    const updatedAlbums = Array.isArray(data.updated_albums)
      ? data.updated_albums.filter(Boolean)
      : [data.updated_album].filter(Boolean);
    updateTrackModalIfStillShowingAlbum(album, updatedAlbums);
    if (state.utility.loaded || data.updated_problematic_album !== undefined) {
      applyRepairResultToProblematicFiles(album, data.updated_problematic_album || null);
    }
    const requiresViewRefresh = data.requires_view_refresh !== undefined
      ? Boolean(data.requires_view_refresh)
      : Boolean(data.move_task?.requires_view_refresh ?? true);
    if (requiresViewRefresh) {
      await fetchAndRender(buildApiUrl(state.view), false, { preserveScroll: true });
    }
    showToast(`Album moved to ${actionConfig.targetLabel}.`, 'success', 3200);
    return true;
  } catch (error) {
    console.error('[AlbumHaven][Utilities] Failed to move album.', error);
    showToast(error.message || 'Failed to move album.', 'error', 3200);
    return false;
  }
}

async function fetchUnsuccessfulAlbumCovers() {
  const previousStatus = { ...state.status };
  try {
    console.log('[AlbumHaven][Covers] Starting manual bulk cover fetch.');
    startStatusIndicatorImmediately({
      covers_in_progress: true,
      covers_processed: 0,
      covers_total: 0,
      covers_downloaded: 0,
      covers_current_folder: '',
    });
    const response = await fetch('/utilities/fetch-covers-unsuccessful', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force_search: true }),
    });
    const data = await response.json().catch(() => ({}));
    console.log('[AlbumHaven][Covers] Manual bulk cover fetch HTTP response.', {
      status: response.status,
      ok: response.ok,
      queuedCount: data.queued_count,
      currentFolder: data.current_folder,
      queuedAfterIndexing: data.queued_after_indexing,
      processed: data.processed_count,
      downloaded: data.downloaded_count,
      failed: data.failed_count,
      mode: data.mode,
      started: data.started,
      alreadyRunning: data.already_running,
      forceSearchUsed: data.force_search_used,
      sampleJobResults: Array.isArray(data.job_results) ? data.job_results.slice(0, 10) : [],
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to fetch album covers');
    }
    if (data.queued_after_indexing) {
      updateStatusIndicator({
        ...state.status,
        scan_in_progress: true,
        scan_processed: Number(state.status?.scan_processed || 0),
        scan_total: Number(state.status?.scan_total || 0),
        covers_in_progress: false,
        covers_processed: 0,
        covers_total: 0,
        covers_downloaded: 0,
        covers_current_folder: '',
        pending_cover_refresh_after_scan: true,
      });
      state.wasPollingBusy = true;
      scheduleBrowserTimeout(pollStatus, 250);
      return;
    }
    updateStatusIndicator({
      ...state.status,
      covers_in_progress: true,
      covers_processed: 0,
      covers_total: Number(data.queued_count || 0),
      covers_downloaded: 0,
      covers_current_folder: String(data.current_folder || ''),
      pending_cover_refresh_after_scan: false,
    });
    if (data.already_running) {
      state.wasCoverPollingBusy = true;
      scheduleBrowserTimeout(pollStatus, 250);
      return;
    }
    state.wasCoverPollingBusy = true;
    scheduleBrowserTimeout(pollStatus, 250);
  } catch (error) {
    updateStatusIndicator(previousStatus);
    console.error('[AlbumHaven][Utilities] Failed to fetch unresolved album covers.', error);
    showToast(error.message || 'Failed to fetch album covers.', 'error', 3200);
  }
}

async function cancelAlbumCoverScan() {
  const previousStatus = { ...state.status };
  try {
    console.log('[AlbumHaven][Covers] Cancelling bulk cover fetch.');
    updateStatusIndicator({
      ...state.status,
      covers_in_progress: false,
      covers_current_folder: '',
      pending_cover_refresh_after_scan: false,
    });
    const response = await fetch('/utilities/cancel-cover-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    console.log('[AlbumHaven][Covers] Cancel bulk cover fetch response.', {
      status: response.status,
      ok: response.ok,
      cancelled: data.cancelled,
      coversInProgress: data.covers_in_progress,
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to cancel album cover scan');
    }
  } catch (error) {
    updateStatusIndicator(previousStatus);
    console.error('[AlbumHaven][Utilities] Failed to cancel album cover scan.', error);
    showToast(error.message || 'Failed to cancel album cover scan.', 'error', 3200);
  }
}


async function loadUtilityRules(force = false) {
  if (state.utility.rulesLoading) return state.utility.rulesLoadPromise;
  if (state.utility.rulesLoaded && !force) {
    renderUtilityModalContent();
    return;
  }
  const mutationRevision = typeof readProblemExclusionMutationRevision === 'function'
    ? readProblemExclusionMutationRevision()
    : 0;
  state.utility.rulesLoading = true;
  renderUtilityModalContent();
  state.utility.rulesLoadPromise = (async () => {
    try {
      const response = await fetch('/utilities/rules', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (
        typeof readProblemExclusionMutationRevision === 'function'
        && readProblemExclusionMutationRevision() !== mutationRevision
      ) return;
      state.utility.rules = mergePendingProblemExclusionRules(
        Array.isArray(data.rules) ? data.rules : [],
      );
      if (Array.isArray(data.ignored_version_keys)) {
        mergeViewPayload({
          ignored_version_keys: data.ignored_version_keys,
        }, { trackSidebarReveal: false });
      }
      state.utility.rulesLoaded = true;
    } catch (error) {
      console.error('[AlbumHaven][Utilities] Failed to load rules.', error);
      state.utility.rules = mergePendingProblemExclusionRules([]);
      showToast('Unable to load utility rules.', 'error', 3200);
    } finally {
      state.utility.rulesLoading = false;
      state.utility.rulesLoadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.rulesLoadPromise;
}

async function loadUtilityLoops(force = false) {
  if (state.utility.loopsLoading) return state.utility.loopsLoadPromise;
  if (state.utility.loopsLoaded && !force) {
    renderUtilityModalContent();
    return;
  }
  state.utility.loopsLoading = true;
  renderUtilityModalContent();
  state.utility.loopsLoadPromise = (async () => {
    try {
      const response = await fetch('/utilities/loops', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      state.utility.loops = Array.isArray(data.loops) ? data.loops : [];
      state.utility.loopsLoaded = true;
      const groupedLoops = groupUtilityLoops(state.utility.loops || []);
      collapseAllUtilityLoopGroups();
      state.utility.selectedLoopGroupKey = String(groupedLoops[0]?.key || '');
      state.utility.selectedLoopId = String(groupedLoops[0]?.loops?.[0]?.id || '');
      state.utility.selectedLoopDetailMode = 'group';
    } catch (error) {
      console.error('[AlbumHaven][Loops] Failed to load loops.', error);
      state.utility.loops = [];
      showToast('Unable to load saved loops.', 'error', 3200);
    } finally {
      state.utility.loopsLoading = false;
      state.utility.loopsLoadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.loopsLoadPromise;
}

function normalizeUtilityLogHistoryRevision(value) {
  return String(value ?? '').trim();
}

async function loadUtilityLogHistory(force = false) {
  if (state.utility.logHistoryLoading) return state.utility.logHistoryLoadPromise;
  if (state.utility.logHistoryLoaded && !force) {
    if (state.utility.activeTab === 'log-history') renderUtilityModalContent();
    return {
      revision: normalizeUtilityLogHistoryRevision(state.utility.logHistoryRevision),
    };
  }
  state.utility.logHistoryLoading = true;
  if (state.utility.activeTab === 'log-history') renderUtilityModalContent();
  state.utility.logHistoryLoadPromise = (async () => {
    try {
      await requestBrowserLogHistoryPersistentStorage();
    } catch (_error) {
      // The browser may deny or omit persistent-storage requests; IndexedDB still remains usable.
    }
    try {
      const response = await fetch('/utilities/log-history', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || 'Unable to load transient log history.');
      }
      const stored = await persistBrowserLogHistoryEntries(
        Array.isArray(data.items) ? data.items : [],
      );
      const revision = normalizeUtilityLogHistoryRevision(data.revision);
      state.utility.logHistory = Array.isArray(stored?.items) ? stored.items : [];
      state.utility.logHistoryRevision = revision;
      if (!state.utility.logHistorySyncPromise) {
        state.utility.logHistoryTargetRevision = revision;
      }
      if (stored?.status) state.utility.logHistoryStorageStatus = stored.status;
      state.utility.logHistoryLoaded = true;
      return { revision };
    } catch (error) {
      console.error('[AlbumHaven][History] Failed to load the transient history snapshot.', error);
      try {
        const stored = await readBrowserLogHistoryEntries();
        state.utility.logHistory = Array.isArray(stored?.items)
          ? stored.items
          : (Array.isArray(state.utility.logHistory) ? state.utility.logHistory : []);
        if (stored?.status) state.utility.logHistoryStorageStatus = stored.status;
        state.utility.logHistoryLoaded = true;
      } catch (storageError) {
        console.error('[AlbumHaven][History] Failed to read browser-owned history.', storageError);
        state.utility.logHistory = Array.isArray(state.utility.logHistory) ? state.utility.logHistory : [];
        state.utility.logHistoryLoaded = true;
        state.utility.logHistoryStorageStatus = {
          persistent: false,
          storage: 'session',
          message: 'History is available for this session and will be lost on reload.',
        };
      }
      return null;
    } finally {
      state.utility.logHistoryLoading = false;
      state.utility.logHistoryLoadPromise = null;
      if (state.utility.activeTab === 'log-history') renderUtilityModalContent();
    }
  })();
  return state.utility.logHistoryLoadPromise;
}

async function syncUtilityLogHistoryRevision(revision) {
  const targetRevision = normalizeUtilityLogHistoryRevision(revision);
  if (!targetRevision) return null;
  state.utility.logHistoryTargetRevision = targetRevision;
  if (
    normalizeUtilityLogHistoryRevision(state.utility.logHistoryRevision) === targetRevision
    && !state.utility.logHistorySyncPromise
  ) {
    return { revision: targetRevision };
  }
  if (state.utility.logHistorySyncPromise) {
    return state.utility.logHistorySyncPromise;
  }

  const syncPromise = (async () => {
    while (
      normalizeUtilityLogHistoryRevision(state.utility.logHistoryRevision)
      !== normalizeUtilityLogHistoryRevision(state.utility.logHistoryTargetRevision)
    ) {
      const requestedRevision = normalizeUtilityLogHistoryRevision(
        state.utility.logHistoryTargetRevision,
      );
      const result = await loadUtilityLogHistory(true);
      if (!result) break;
      const loadedRevision = normalizeUtilityLogHistoryRevision(result.revision);
      if (
        normalizeUtilityLogHistoryRevision(state.utility.logHistoryTargetRevision)
          === requestedRevision
        && loadedRevision !== requestedRevision
      ) {
        state.utility.logHistoryTargetRevision = loadedRevision;
      }
    }
    return {
      revision: normalizeUtilityLogHistoryRevision(state.utility.logHistoryRevision),
    };
  })();
  state.utility.logHistorySyncPromise = syncPromise;
  try {
    return await syncPromise;
  } finally {
    if (state.utility.logHistorySyncPromise === syncPromise) {
      state.utility.logHistorySyncPromise = null;
    }
  }
}
async function loadUtilityIntegrations(force = false) {
  if (state.utility.integrationsLoading) return state.utility.integrationsLoadPromise;
  if (state.utility.integrationsLoaded && !force) {
    renderUtilityModalContent();
    return;
  }
  state.utility.integrationsLoading = true;
  renderUtilityModalContent();
  state.utility.integrationsLoadPromise = (async () => {
    try {
      const response = await fetch('/utilities/integrations', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      state.utility.integrations = Array.isArray(data.integrations) ? data.integrations : [];
      state.utility.integrationsLoaded = true;
      const lastfm = state.utility.integrations.find((item) => String(item?.key || '') === 'lastfm');
      if (lastfm && !String(state.utility.integrationDrafts?.lastfm?.username || '').trim()) {
        state.utility.integrationDrafts.lastfm.username = String(lastfm.username || '');
      }
      await reconcileLastfmTimeZoneDraft(lastfm);
    } catch (error) {
      console.error('[AlbumHaven][Integrations] Failed to load integrations.', error);
      state.utility.integrations = [];
      showToast('Unable to load integrations.', 'error', 3200);
    } finally {
      state.utility.integrationsLoading = false;
      state.utility.integrationsLoadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.integrationsLoadPromise;
}

function getLastfmTimeZoneDraftProvenance() {
  state.utility.integrationDraftProvenance = state.utility.integrationDraftProvenance || {};
  const existing = state.utility.integrationDraftProvenance.lastfmTimezone;
  if (existing) return existing;
  const draftValue = String(state.utility.integrationDrafts?.lastfm?.timezone || '').trim();
  const provenance = {
    source: draftValue ? 'dirty' : '',
    value: draftValue,
  };
  state.utility.integrationDraftProvenance.lastfmTimezone = provenance;
  return provenance;
}

function markLastfmTimeZoneDraftDirty() {
  const provenance = getLastfmTimeZoneDraftProvenance();
  provenance.source = 'dirty';
  provenance.value = String(state.utility.integrationDrafts?.lastfm?.timezone || '').trim();
}

function markLastfmTimeZoneDraftSaved(timezone) {
  const provenance = getLastfmTimeZoneDraftProvenance();
  provenance.source = 'saved';
  provenance.value = String(timezone || '').trim();
}

async function persistDetectedLastfmTimeZone(timezone, provenance) {
  try {
    const response = await fetch('/utilities/integrations/lastfm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timezone,
        save_timezone_only: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save detected timezone');
    }
    state.utility.integrations = (state.utility.integrations || [])
      .filter((item) => String(item?.key || '') !== 'lastfm');
    state.utility.integrations.unshift(data.integration);
    const currentDraft = String(state.utility.integrationDrafts?.lastfm?.timezone || '').trim();
    if (provenance.source === 'detected' && currentDraft === timezone) {
      const savedTimeZone = String(data.integration?.user_timezone || timezone).trim();
      state.utility.integrationDrafts.lastfm.timezone = savedTimeZone;
      provenance.source = 'saved';
      provenance.value = savedTimeZone;
    }
  } catch (error) {
    console.warn('[AlbumHaven][Integrations] Failed to save detected timezone.', error);
  }
}

async function reconcileLastfmTimeZoneDraft(lastfm) {
  const draft = state.utility.integrationDrafts.lastfm;
  const provenance = getLastfmTimeZoneDraftProvenance();
  const currentDraft = String(draft.timezone || '').trim();
  if (
    provenance.source !== 'dirty'
    && provenance.value
    && currentDraft !== provenance.value
  ) {
    provenance.source = 'dirty';
    provenance.value = currentDraft;
  }
  if (provenance.source === 'dirty') return;

  const savedTimeZone = String(lastfm?.user_timezone || '').trim();
  if (savedTimeZone) {
    draft.timezone = savedTimeZone;
    provenance.source = 'saved';
    provenance.value = savedTimeZone;
    return;
  }

  const detectedTimeZone = String(getDetectedBrowserTimeZone() || 'UTC').trim() || 'UTC';
  draft.timezone = detectedTimeZone;
  provenance.source = 'detected';
  provenance.value = detectedTimeZone;
  await persistDetectedLastfmTimeZone(detectedTimeZone, provenance);
}

function handleLocalPlaylistImportFileSelection(file) {
  state.utility.localPlaylistImport = {
    ...(state.utility.localPlaylistImport || {}),
    selectedFile: file || null,
    selectedFileName: file?.name || '',
    error: '',
    lastAnalysis: null,
  };
  renderUtilityModalContent();
}

async function runLocalPlaylistImportAnalysis() {
  const importState = state.utility.localPlaylistImport || {};
  if (importState.analyzeBusy) return;
  const selectedFile = importState.selectedFile || null;
  if (!selectedFile) {
    state.utility.localPlaylistImport = {
      ...importState,
      error: 'Select a local playlist file before running analysis.',
      lastAnalysis: null,
    };
    renderUtilityModalContent();
    return;
  }
  state.utility.localPlaylistImport = {
    ...importState,
    analyzeBusy: true,
    error: '',
  };
  renderUtilityModalContent();
  try {
    const formData = new FormData();
    formData.append('playlist_file', selectedFile);
    const selectedIntegration = typeof getSelectedUtilityIntegration === 'function'
      ? getSelectedUtilityIntegration()
      : null;
    const analyzeRoute = String(selectedIntegration?.analyze_route || '/utilities/imports/local-playlists/analyze');
    const response = await fetch(analyzeRoute, {
      method: 'POST',
      body: formData,
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(String(data?.error || 'Unable to analyze the selected local playlist.'));
    }
    state.utility.localPlaylistImport = {
      ...state.utility.localPlaylistImport,
      selectedFile,
      selectedFileName: selectedFile?.name || '',
      analyzeBusy: false,
      error: '',
      lastAnalysis: data.analysis || null,
    };
  } catch (error) {
    console.error('[AlbumHaven][LocalPlaylistImport] Failed to analyze playlist.', error);
    state.utility.localPlaylistImport = {
      ...state.utility.localPlaylistImport,
      selectedFile,
      selectedFileName: selectedFile?.name || '',
      analyzeBusy: false,
      error: String(error?.message || 'Unable to analyze the selected local playlist.'),
      lastAnalysis: null,
    };
    showToast('Unable to analyze the selected local playlist.', 'error', 3200);
  } finally {
    renderUtilityModalContent();
  }
}

function loadActiveUtilityTab(force = false) {
  if (state.utility.activeTab === 'rules') {
    return loadUtilityRules(force);
  }
  if (state.utility.activeTab === 'loops') {
    return loadUtilityLoops(force);
  }
  if (state.utility.activeTab === 'log-history') {
    return loadUtilityLogHistory(force);
  }
  if (state.utility.activeTab === 'integrations') {
    loadUtilityIntegrations(force);
    if (state.utility.selectedIntegrationKey === 'library') {
      loadUtilityLibrarySettings(force);
    }
    return null;
  }
  if (state.utility.activeTab === 'appearance') {
    renderUtilityModalContent();
    return null;
  }
  return loadProblematicFiles(force);
}

function scheduleUtilityOpenLoad(force = false, delay = 0) {
  if (state.utility.pendingOpenLoadTimer) {
    clearBrowserTimeout(state.utility.pendingOpenLoadTimer);
    state.utility.pendingOpenLoadTimer = 0;
  }
  state.utility.pendingOpenLoadTimer = scheduleBrowserTimeout(() => {
    state.utility.pendingOpenLoadTimer = 0;
    loadActiveUtilityTab(force);
  }, delay);
}

function deferActiveStartupViewForUtilityModal() {
  const ui = state.ui;
  const controller = ui?.activeViewRequestController;
  const hydrationTier = String(ui?.activeViewRequestStartupHydrationTier || '');
  if (
    !ui?.activeViewRequestStartupRefresh
    || hydrationTier === 'sidebar'
    || !String(ui.activeViewRequestUrl || '').trim()
    || !controller
    || typeof controller.abort !== 'function'
  ) {
    return false;
  }
  ui.deferredUtilityViewRequest = {
    url: ui.activeViewRequestUrl,
    push: Boolean(ui.activeViewRequestPush),
    originatingViewStateRevision: Number(ui.viewStateRevision || 0),
    options: {
      startupRefresh: true,
      startupHydrationTier: hydrationTier || 'full',
      preserveScroll: true,
      skipPendingViewTransition: true,
    },
  };
  const sequence = Number(ui.utilityViewPreemptionSequence || 0) + 1;
  ui.utilityViewPreemptionSequence = sequence;
  ui.utilityViewPreemptions = [
    ...(Array.isArray(ui.utilityViewPreemptions) ? ui.utilityViewPreemptions : []),
    Object.freeze({
      normalizedUrl: ui.activeViewRequestUrl,
      reason: 'utility-modal-preemption',
      sequence,
    }),
  ].slice(-24);
  controller.abort();
  return true;
}

function resumeDeferredUtilityViewRequest() {
  const deferredRequest = state.ui?.deferredUtilityViewRequest;
  if (!deferredRequest?.url) return false;
  const originatingViewStateRevision = Number(
    deferredRequest.originatingViewStateRevision || 0,
  );
  if (originatingViewStateRevision !== Number(state.ui.viewStateRevision || 0)) {
    if (state.ui.deferredUtilityViewRequest === deferredRequest) {
      state.ui.deferredUtilityViewRequest = null;
    }
    return false;
  }
  const resumeOptions = {
    ...(deferredRequest.options || {}),
    interruptCurrent: false,
  };
  if (state.busy || String(state.ui.activeViewRequestUrl || '').trim()) {
    if (state.ui.pendingViewRequest) return false;
    state.ui.pendingViewRequest = {
      url: deferredRequest.url,
      push: deferredRequest.push,
      options: resumeOptions,
      originatingViewStateRevision,
    };
    if (state.ui.deferredUtilityViewRequest === deferredRequest) {
      state.ui.deferredUtilityViewRequest = null;
    }
    return true;
  }
  const restartPromise = fetchAndRender(
    deferredRequest.url,
    deferredRequest.push,
    resumeOptions,
  );
  Promise.resolve(restartPromise).then((acquiredAndRendered) => {
    if (
      acquiredAndRendered
      && state.ui.deferredUtilityViewRequest === deferredRequest
    ) {
      state.ui.deferredUtilityViewRequest = null;
    }
  }).catch(() => {
    // Retain the deferred request so a later close or released request slot can retry it.
  });
  return true;
}

let utilityCoverLoadSuspensionToken = 0;

function openUtilityModal({ resetSearch = true, resetSelection = true, forceLoad = true } = {}) {
  const els = getUtilityModalElements();
  if (!els.overlay) return;
  if (
    !utilityCoverLoadSuspensionToken
    && typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction === 'function'
  ) {
    utilityCoverLoadSuspensionToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  }
  deferActiveStartupViewForUtilityModal();
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (state.utility.activeTab === 'loops') {
    collapseAllUtilityLoopGroups();
  }
  if (resetSelection) {
    state.utility.selectedProblematicKey = '';
    state.utility.pendingRepairKey = '';
    state.utility.pendingRepairAction = '';
    state.utility.focusedTrackPath = '';
    state.utility.showRepairedDisplay = true;
    state.utility.repairSelections = {};
    state.utility.problemExclusionSelections = {};
    state.utility.separateReleaseSelections = {};
    state.utility.selectedProblemFilters = [];
    state.utility.problemDropdownOpen = false;
    state.utility.collapsedSections = {
      detected: false,
      suggested: false,
      details: false,
    };
  }
  if (resetSearch) {
    state.utility.searchQuery = '';
  }
  renderUtilityModalContent();
  if (forceLoad) {
    if (state.utility.pendingOpenLoadTimer) {
      clearBrowserTimeout(state.utility.pendingOpenLoadTimer);
      state.utility.pendingOpenLoadTimer = 0;
    }
    loadActiveUtilityTab(true);
  }
}

function openUtilityLogHistoryTab() {
  setUtilityActiveTab('log-history');
  openUtilityModal({ resetSearch: false, resetSelection: false, forceLoad: true });
}

async function saveLastfmIntegration() {
  const draft = state.utility.integrationDrafts?.lastfm || { username: '', password: '', timezone: '' };
  try {
    const response = await fetch('/utilities/integrations/lastfm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(draft.username || '').trim(),
        password: String(draft.password || ''),
        timezone: String(draft.timezone || '').trim(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      state.utility.logHistoryLoaded = false;
      throw new Error(data.error || 'Failed to connect Last.fm');
    }
    state.utility.integrations = (state.utility.integrations || []).filter((item) => String(item?.key || '') !== 'lastfm');
    state.utility.integrations.unshift(data.integration);
    state.utility.integrationsLoaded = true;
    state.utility.selectedIntegrationKey = 'lastfm';
    state.utility.integrationDrafts.lastfm = {
      username: String(data.integration?.username || draft.username || '').trim(),
      password: '',
      timezone: String(data.integration?.user_timezone || draft.timezone || getDetectedBrowserTimeZone() || 'UTC'),
    };
    markLastfmTimeZoneDraftSaved(state.utility.integrationDrafts.lastfm.timezone);
    renderUtilityModalContent();
    showToast('Last.fm connected.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Integrations] Failed to connect Last.fm.', error);
    showToast(error.message || 'Failed to connect Last.fm.', 'error', 3600);
  }
}

async function saveLastfmTimeZone() {
  const draft = state.utility.integrationDrafts?.lastfm || { username: '', password: '', timezone: '' };
  const timezone = String(draft.timezone || '').trim();
  if (!timezone) {
    showToast('Choose a timezone first.', 'error', 2600);
    return;
  }
  try {
    const response = await fetch('/utilities/integrations/lastfm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timezone,
        save_timezone_only: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save timezone');
    }
    state.utility.integrations = (state.utility.integrations || []).filter((item) => String(item?.key || '') !== 'lastfm');
    state.utility.integrations.unshift(data.integration);
    state.utility.integrationsLoaded = true;
    state.utility.selectedIntegrationKey = 'lastfm';
    state.utility.integrationDrafts.lastfm = {
      ...(state.utility.integrationDrafts.lastfm || {}),
      username: String(data.integration?.username || draft.username || '').trim(),
      password: '',
      timezone: String(data.integration?.user_timezone || timezone),
    };
    markLastfmTimeZoneDraftSaved(state.utility.integrationDrafts.lastfm.timezone);
    renderUtilityModalContent();
    showToast('Timezone saved.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Integrations] Failed to save timezone.', error);
    showToast(error.message || 'Failed to save timezone.', 'error', 3600);
  }
}

async function disconnectLastfmIntegration() {
  try {
    const response = await fetch('/utilities/integrations/lastfm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disconnect: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to disconnect Last.fm');
    }
    state.utility.integrations = (state.utility.integrations || []).filter((item) => String(item?.key || '') !== 'lastfm');
    state.utility.integrations.unshift(data.integration);
    state.utility.integrationsLoaded = true;
    state.utility.integrationDrafts.lastfm = {
      ...(state.utility.integrationDrafts.lastfm || {}),
      username: String(data.integration?.username || ''),
      password: '',
      timezone: String(data.integration?.user_timezone || state.utility.integrationDrafts?.lastfm?.timezone || getDetectedBrowserTimeZone() || 'UTC'),
    };
    markLastfmTimeZoneDraftSaved(state.utility.integrationDrafts.lastfm.timezone);
    renderUtilityModalContent();
    showToast('Last.fm disconnected.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Integrations] Failed to disconnect Last.fm.', error);
    showToast(error.message || 'Failed to disconnect Last.fm.', 'error', 3600);
  }
}

function closeUtilityModal() {
  const els = getUtilityModalElements();
  if (!els.overlay) return;
  state.utility.problematicNavigationToken = Number(state.utility.problematicNavigationToken || 0) + 1;
  state.utility.problematicNavigationActiveToken = 0;
  if (typeof clearUtilityLoopSpaceOwner === 'function') {
    clearUtilityLoopSpaceOwner();
  }
  document.querySelectorAll('.utility-loop-audio').forEach((audio) => {
    audio.pause();
  });
  els.overlay.hidden = true;
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  if (!trackModalOpen && !lightboxOpen) {
    document.body.classList.remove('modal-open');
  }
  resumeDeferredUtilityViewRequest();
  const coverLoadSuspensionToken = utilityCoverLoadSuspensionToken;
  utilityCoverLoadSuspensionToken = 0;
  if (
    coverLoadSuspensionToken
    && typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
  ) {
    virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(coverLoadSuspensionToken);
  }
}

let repairConfirmReturnFocus = null;

function openRepairConfirmModal() {
  const els = getRepairConfirmElements();
  if (!els.overlay) return;
  const action = state.utility.pendingRepairAction || 'repair';
  const selectedRows = action === 'repair' ? getSelectedRepairRowKeys() : [];
  const ignoredRows = action === 'detected' ? getIgnoredRepairRowKeys() : [];
  const separateRows = action === 'separate-release' ? getSelectedSeparateReleaseKeys() : [];
  const actionPaths = new Set([...selectedRows, ...ignoredRows].map((value) => String(value).split('::')[0]).filter(Boolean));
  const isExclusionConfirmation = action === 'detected' && ignoredRows.length > 0;
  if (isExclusionConfirmation) {
    els.overlay.setAttribute?.('data-confirm-mode', 'exclusion');
  } else {
    els.overlay.removeAttribute?.('data-confirm-mode');
  }
  if (els.dialog) {
    els.dialog.setAttribute('aria-labelledby', isExclusionConfirmation ? 'repair-confirm-text' : 'repair-confirm-title');
    if (isExclusionConfirmation) {
      els.dialog.removeAttribute('aria-describedby');
    } else {
      els.dialog.setAttribute('aria-describedby', 'repair-confirm-text');
    }
  }
  if (els.title) {
    els.title.hidden = isExclusionConfirmation;
    els.title.textContent = isExclusionConfirmation ? '' : 'Repair local files';
  }
  if (els.cancel) els.cancel.textContent = 'Cancel';
  if (els.text) {
    if (selectedRows.length) {
      els.text.textContent = actionPaths.size > 1
        ? `This will try to repair ${actionPaths.size} local files with the selected fixes. Are you sure?`
        : 'This will try to repair your local file with the selected fix. Are you sure?';
      if (els.accept) els.accept.textContent = 'Yes, repair files';
    } else if (separateRows.length) {
      els.text.textContent = 'This will treat the selected year mismatch as separate releases and rebuild the album list. Are you sure?';
      if (els.accept) els.accept.textContent = 'Yes, apply';
    } else if (isExclusionConfirmation) {
      els.text.textContent = 'Are you sure? This will create an exclusion rule';
      if (els.accept) els.accept.textContent = 'Exclude';
    } else {
      els.text.textContent = 'No problem exclusions are selected.';
      if (els.accept) els.accept.textContent = 'Yes, apply';
    }
  }
  repairConfirmReturnFocus = document.activeElement?.focus
    ? document.activeElement
    : null;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
}

function closeRepairConfirmModal() {
  const els = getRepairConfirmElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  state.utility.pendingRepairKey = '';
  state.utility.pendingRepairAction = '';
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!trackModalOpen && !lightboxOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
  const returnFocus = repairConfirmReturnFocus;
  repairConfirmReturnFocus = null;
  returnFocus?.focus?.();
}

function showRepairProgressOverlay(fileCount = 0, title = 'Repairing tags') {
  const els = getRepairProgressElements();
  if (!els.overlay) return;
  if (els.title) {
    els.title.textContent = title;
  }
  if (els.text) {
    els.text.textContent = fileCount > 1
      ? `Applying selected changes to ${fileCount} local files...`
      : 'Applying selected changes...';
  }
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
}

function hideRepairProgressOverlay() {
  const els = getRepairProgressElements();
  if (!els.overlay) return;
  els.overlay.hidden = true;
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  const repairConfirmOpen = !document.getElementById('repair-confirm-modal')?.hidden;
  const tagEditorOpen = !document.getElementById('tag-editor-modal')?.hidden;
  const tagEditConfirmOpen = !document.getElementById('tag-edit-confirm-modal')?.hidden;
  if (!trackModalOpen && !lightboxOpen && !utilityModalOpen && !repairConfirmOpen && !tagEditorOpen && !tagEditConfirmOpen) {
    document.body.classList.remove('modal-open');
  }
}

function getTagEditorTracks(album, mode = 'problematic') {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  if (mode === 'all') return tracks;
  const problemPaths = new Set((Array.isArray(album?.track_problem_rows) ? album.track_problem_rows : [])
    .map((row) => String(row.path || ''))
    .filter(Boolean));
  if (!problemPaths.size) return tracks;
  return tracks.filter((track) => problemPaths.has(String(track.path || '')));
}

function getTrackTagInitialValues(track, album) {
  const usesTrackOwnedIdentity = album?.tag_editor_collection === true;
  return {
    artist: usesTrackOwnedIdentity
      ? String(track?.tag_artist ?? track?.artist ?? '')
      : String(track?.tag_artist || track?.artist || album?.album_artist || ''),
    album_artist: usesTrackOwnedIdentity
      ? String(track?.album_artist ?? '')
      : String(track?.album_artist || album?.raw_album_artist || album?.album_artist || track?.artist || ''),
    album: usesTrackOwnedIdentity || Object.prototype.hasOwnProperty.call(track || {}, 'album')
      ? String(track?.album ?? '')
      : String(album?.raw_name || album?.name || ''),
    title: String(track?.title || ''),
    genre: String(track?.genre || ''),
    year: String(track?.year ?? album?.year ?? ''),
    track_number: String(track?.track_number ?? ''),
    disc_number: String(track?.disc_number ?? ''),
    exception_type: String(track?.exception_type || ''),
    edition: String(track?.edition || album?.edition || ''),
    album_rating: String(track?.album_rating ?? album?.album_rating ?? ''),
  };
}

function buildChangedTagEditorUpdates(album, tracks, valuesByPath) {
  const updates = {};
  (tracks || []).forEach((track) => {
    const path = String(track?.path || '');
    if (!path) return;
    const currentValues = valuesByPath?.[path];
    if (!currentValues || typeof currentValues !== 'object') return;
    const initialValues = getTrackTagInitialValues(track, album);
    const changedFields = {};
    Object.keys(initialValues).forEach((field) => {
      const nextValue = String(currentValues[field] ?? '');
      const initialValue = String(initialValues[field] ?? '');
      if (nextValue !== initialValue) {
        changedFields[field] = nextValue;
      }
    });
    if (Object.keys(changedFields).length) {
      updates[path] = changedFields;
    }
  });
  return updates;
}

function applyTagEditsToNonAlbumView(album, updates) {
  const view = state.view || (state.view = {});
  const currentTracks = Array.isArray(view.non_album_tracks)
    ? view.non_album_tracks.slice()
    : [];
  const tracksByPath = new Map(
    (Array.isArray(album?.tracks) ? album.tracks : [])
      .map((track) => [String(track?.path || ''), track])
      .filter(([path]) => path),
  );
  const nextByPath = new Map(
    currentTracks
      .map((track) => [String(track?.path || ''), track])
      .filter(([path]) => path),
  );
  Object.entries(updates || {}).forEach(([path, edits]) => {
    const hasAlbumEdit = Object.prototype.hasOwnProperty.call(edits || {}, 'album');
    const hasExceptionEdit = Object.prototype.hasOwnProperty.call(edits || {}, 'exception_type');
    if (!hasAlbumEdit && !hasExceptionEdit) return;
    const normalizedPath = String(path || '');
    if (!normalizedPath) return;
    const track = tracksByPath.get(normalizedPath) || nextByPath.get(normalizedPath) || {};
    const albumName = hasAlbumEdit
      ? String(edits.album || '').trim()
      : String(
        Object.prototype.hasOwnProperty.call(track, 'album')
          ? track.album || ''
          : album?.raw_name || album?.name || '',
      ).trim();
    const exceptionType = hasExceptionEdit
      ? String(edits.exception_type || '').trim()
      : String(track?.exception_type || '').trim();
    if (albumName && !exceptionType) {
      nextByPath.delete(normalizedPath);
      return;
    }
    nextByPath.set(normalizedPath, {
      ...track,
      ...edits,
      path: normalizedPath,
      artist: String(track?.artist || album?.album_artist || 'Unknown Artist'),
      title: String(edits.title || track?.title || 'Unknown track'),
      album: albumName,
      exception_type: exceptionType,
      reason_label: exceptionType,
      display_path: String(track?.display_path || normalizedPath),
    });
  });
  view.non_album_tracks = Array.from(nextByPath.values());
  return view.non_album_tracks;
}

function normalizeCommittedTrackTagValues(values) {
  const nextValues = { ...(values || {}) };
  ['year', 'track_number', 'disc_number', 'album_rating'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(nextValues, field)) {
      nextValues[field] = parseOptionalInteger(nextValues[field]);
    }
  });
  if (Object.prototype.hasOwnProperty.call(nextValues, 'exception_type')) {
    nextValues.exception_type = String(nextValues.exception_type || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(nextValues, 'edition')) {
    nextValues.edition = String(nextValues.edition || '').trim();
  }
  return nextValues;
}

function installCommittedTagValues(album, committedValues) {
  if (!committedValues || typeof committedValues !== 'object' || Array.isArray(committedValues)) {
    return;
  }
  const tagEditor = state.tagEditor || (state.tagEditor = {});
  const editorValues = tagEditor.values || (tagEditor.values = {});
  const trackCollections = [
    Array.isArray(album?.tracks) ? album.tracks : [],
    Array.isArray(tagEditor.tracks) ? tagEditor.tracks : [],
    Array.isArray(tagEditor.album?.tracks) ? tagEditor.album.tracks : [],
  ];
  const currentNonAlbumTracks = Array.isArray(state.view?.non_album_tracks)
    ? state.view.non_album_tracks
    : [];
  trackCollections.push(currentNonAlbumTracks);

  Object.entries(committedValues).forEach(([path, values]) => {
    const normalizedPath = String(path || '');
    if (!normalizedPath || !values || typeof values !== 'object' || Array.isArray(values)) return;
    editorValues[normalizedPath] = {
      ...(editorValues[normalizedPath] || {}),
      ...Object.fromEntries(
        Object.entries(values).map(([field, value]) => [field, String(value ?? '')]),
      ),
    };
    const normalizedValues = normalizeCommittedTrackTagValues(values);
    const seen = new Set();
    trackCollections.forEach((tracks) => {
      tracks.forEach((track) => {
        if (!track || seen.has(track) || String(track.path || '') !== normalizedPath) return;
        seen.add(track);
        Object.assign(track, normalizedValues);
      });
    });
  });

  applyTagEditsToNonAlbumView(album, committedValues);
}

function getTagEditorPendingIconMarkup() {
  return `
    <span class="tag-editor-track-pending" data-tag-editor-pending="1" role="img" aria-label="Pending changes" title="Pending changes">
      <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <path d="M4 1h8M4 15h8M5 2v2.2c0 1.1.6 2.1 1.6 2.6L8 7.5l1.4-.7c1-.5 1.6-1.5 1.6-2.6V2M5 14v-2.2c0-1.1.6-2.1 1.6-2.6L8 8.5l1.4.7c1 .5 1.6 1.5 1.6 2.6V14"/>
      </svg>
    </span>`;
}

function syncTagEditorPendingChanges() {
  const els = getTagEditorElements();
  const pending = buildChangedTagEditorUpdates(
    state.tagEditor.album,
    state.tagEditor.tracks || [],
    state.tagEditor.values || {},
  );
  const pendingPaths = new Set(Object.keys(pending));
  if (els.albumInput) {
    els.albumInput.removeAttribute('aria-invalid');
    els.albumInput.removeAttribute('aria-describedby');
  }
  if (els.applyButton) {
    els.applyButton.disabled = pendingPaths.size === 0;
  }
  els.list?.querySelectorAll('[data-tag-editor-track]').forEach((button) => {
    const path = String(button.getAttribute('data-tag-editor-track') || '');
    const marker = button.querySelector('[data-tag-editor-pending="1"]');
    if (pendingPaths.has(path) && !marker) {
      button.insertAdjacentHTML('beforeend', getTagEditorPendingIconMarkup());
    } else if (!pendingPaths.has(path) && marker) {
      marker.remove();
    }
  });
  return pending;
}

function parseOptionalInteger(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOptimisticUpdatedAlbumsFromEdits(album, updates) {
  const sourceTracks = deepCloneJson(Array.isArray(album?.tracks) ? album.tracks : []) || [];
  if (!sourceTracks.length) return [];
  const sourceTrackRows = Array.isArray(album?.track_rows) ? album.track_rows : null;
  const sourceTrackRowByPath = new Map(
    (sourceTrackRows || [])
      .map((row) => {
        const path = String(row?.path || row?.track_ref || '').trim();
        return path ? [path, row] : null;
      })
      .filter(Boolean),
  );
  const sourceTrackPaths = new Set(
    sourceTracks.map((track) => String(track?.path || '')).filter(Boolean),
  );
  const visibleSourceAlbum = findVisibleAlbumByTrackPaths(sourceTrackPaths);
  const sourceAlbumPreference = album?.album_preference
    || visibleSourceAlbum?.album_preference
    || null;
  const sourceKey = String(album?.key || '').trim().toLowerCase();
  const sourceSeparateReleaseMarkerIndex = sourceKey.indexOf('::year::');
  const sourceSeparateReleaseBaseKey = sourceSeparateReleaseMarkerIndex >= 0
    ? sourceKey.slice(0, sourceSeparateReleaseMarkerIndex)
    : '';
  const updatedTracks = sourceTracks.map((track) => {
    const path = String(track?.path || '');
    const edits = updates?.[path];
    const inheritedEdition = String(track?.edition || album?.edition || '').trim();
    if (!edits || typeof edits !== 'object') {
      return {
        ...track,
        edition: inheritedEdition || null,
      };
    }
    const hasYearEdit = Object.prototype.hasOwnProperty.call(edits, 'year');
    return {
      ...track,
      ...edits,
      year: hasYearEdit ? parseOptionalInteger(edits.year) : parseOptionalInteger(track?.year ?? album?.year),
      track_number: Object.prototype.hasOwnProperty.call(edits, 'track_number') ? parseOptionalInteger(edits.track_number) : track.track_number,
      disc_number: Object.prototype.hasOwnProperty.call(edits, 'disc_number') ? parseOptionalInteger(edits.disc_number) : track.disc_number,
      album_rating: Object.prototype.hasOwnProperty.call(edits, 'album_rating') ? parseOptionalInteger(edits.album_rating) : track.album_rating,
      edition: Object.prototype.hasOwnProperty.call(edits, 'edition')
        ? String(edits.edition || '').trim()
        : (inheritedEdition || null),
      exception_type: Object.prototype.hasOwnProperty.call(edits, 'exception_type') ? String(edits.exception_type || '').trim() : track.exception_type,
    };
  });

  const grouped = new Map();
  updatedTracks.forEach((track) => {
    if (String(track?.exception_type || '').trim()) return;
    const albumArtist = String(track?.album_artist || album?.album_artist || '').trim();
    const albumName = String(track?.album ?? album?.name ?? '').trim();
    if (!albumName) return;
    const edits = updates?.[String(track?.path || '')];
    const hasEditionEdit = Boolean(
      edits
      && typeof edits === 'object'
      && Object.prototype.hasOwnProperty.call(edits, 'edition')
    );
    const edition = String(
      hasEditionEdit ? track?.edition : (track?.edition || album?.edition || ''),
    ).trim();
    const hasYearEdit = Boolean(
      edits
      && typeof edits === 'object'
      && Object.prototype.hasOwnProperty.call(edits, 'year')
    );
    const year = parseOptionalInteger(hasYearEdit ? track?.year : (album?.year ?? track?.year));
    const groupingKey = [
      albumArtist.toLowerCase(),
      albumName.toLowerCase(),
      edition.toLowerCase(),
      year != null ? String(year) : '',
    ].join('::');
    const canonicalKeyParts = [
      albumArtist.toLowerCase(),
      albumName.toLowerCase(),
    ];
    if (edition) canonicalKeyParts.push(edition.toLowerCase());
    const canonicalBaseKey = canonicalKeyParts.join('::');
    if (sourceSeparateReleaseBaseKey === canonicalBaseKey && year != null) {
      canonicalKeyParts.push('year', String(year).toLowerCase());
    }
    if (!grouped.has(groupingKey)) {
      let albumPreference = deepCloneJson(sourceAlbumPreference);
      const preferenceRating = parseOptionalInteger(albumPreference?.rating);
      const visiblePreferenceRating = parseOptionalInteger(
        visibleSourceAlbum?.album_preference?.rating,
      );
      const legacyRating = parseOptionalInteger(track?.album_rating)
        ?? parseOptionalInteger(album?.album_rating)
        ?? parseOptionalInteger(visibleSourceAlbum?.album_rating);
      const normalizedRating = preferenceRating ?? visiblePreferenceRating ?? legacyRating;
      if (normalizedRating != null) {
        if (!albumPreference || typeof albumPreference !== 'object' || Array.isArray(albumPreference)) {
          albumPreference = {};
        }
        albumPreference.rating = normalizedRating;
      }
      grouped.set(groupingKey, {
        key: canonicalKeyParts.join('::'),
        name: albumName,
        album_artist: albumArtist,
        cover_path: track?.cover_path || album?.cover_path || null,
        remote_cover_url: track?.remote_cover_url || album?.remote_cover_url || null,
        remote_cover_thumbnail_url: track?.remote_cover_thumbnail_url || album?.remote_cover_thumbnail_url || null,
        remote_cover_source: track?.remote_cover_source || album?.remote_cover_source || null,
        remote_cover_source_label: track?.remote_cover_source_label || album?.remote_cover_source_label || null,
        remote_cover_album_url: track?.remote_cover_album_url || album?.remote_cover_album_url || null,
        remote_cover_width: track?.remote_cover_width || album?.remote_cover_width || null,
        remote_cover_height: track?.remote_cover_height || album?.remote_cover_height || null,
        year,
        release_date: String(album?.release_date || '').trim(),
        edition: edition || null,
        album_rating: normalizedRating ?? 0,
        album_preference: albumPreference,
        total_duration_seconds: 0,
        total_duration_display: '',
        tracks: [],
        ...(sourceTrackRows ? { track_rows: [] } : {}),
      });
    }
    const bucket = grouped.get(groupingKey);
    bucket.tracks.push(track);
    const sourceTrackRow = sourceTrackRowByPath.get(String(track?.path || '').trim());
    const invalidatesServerTrackRow = Boolean(
      edits
      && ['artist', 'album_artist', 'title'].some((field) => (
        Object.prototype.hasOwnProperty.call(edits, field)
      )),
    );
    if (sourceTrackRow && !invalidatesServerTrackRow && Array.isArray(bucket.track_rows)) {
      bucket.track_rows.push(deepCloneJson(sourceTrackRow));
    }
    bucket.total_duration_seconds += Number(track?.duration_seconds || 0);
    if (!bucket.cover_path && track?.cover_path) bucket.cover_path = track.cover_path;
    if (!bucket.remote_cover_url && track?.remote_cover_url) {
      bucket.remote_cover_url = track.remote_cover_url;
      bucket.remote_cover_thumbnail_url = track?.remote_cover_thumbnail_url || track.remote_cover_url;
      bucket.remote_cover_source = track?.remote_cover_source || null;
      bucket.remote_cover_source_label = track?.remote_cover_source_label || null;
      bucket.remote_cover_album_url = track?.remote_cover_album_url || null;
      bucket.remote_cover_width = track?.remote_cover_width || null;
      bucket.remote_cover_height = track?.remote_cover_height || null;
    }
    if (!bucket.album_rating) bucket.album_rating = parseOptionalInteger(track?.album_rating) || 0;
  });

  return Array.from(grouped.values())
    .map((bucket) => {
      const tracks = bucket.tracks.slice().sort((left, right) => {
        const discCompare = Number(left?.disc_number ?? 999) - Number(right?.disc_number ?? 999);
        if (discCompare) return discCompare;
        const trackCompare = Number(left?.track_number ?? 999) - Number(right?.track_number ?? 999);
        if (trackCompare) return trackCompare;
        return String(left?.title || '').localeCompare(String(right?.title || ''), undefined, { sensitivity: 'base' });
      });
      return {
        ...bucket,
        preview_only: false,
        track_count_preview: tracks.length,
        track_paths: tracks.map((track) => String(track?.path || '')).filter(Boolean),
        total_duration_display: formatCanonicalAlbumDuration(bucket.total_duration_seconds),
        tracks,
      };
    })
    .sort((left, right) => String(left.album_artist || '').localeCompare(String(right.album_artist || ''), undefined, { sensitivity: 'base' }));
}

function getSelectedTagEditorPaths(tracks) {
  const validPaths = new Set((tracks || []).map((track) => String(track.path || '')).filter(Boolean));
  let selectedPaths = Array.isArray(state.tagEditor.selectedPaths)
    ? state.tagEditor.selectedPaths.map((path) => String(path || '')).filter((path) => validPaths.has(path))
    : [];
  if (!selectedPaths.length && state.tagEditor.selectedPath && validPaths.has(String(state.tagEditor.selectedPath))) {
    selectedPaths = [String(state.tagEditor.selectedPath)];
  }
  if (!selectedPaths.length && tracks.length) {
    selectedPaths = [String(tracks[0].path || '')].filter(Boolean);
  }
  state.tagEditor.selectedPaths = selectedPaths;
  state.tagEditor.selectedPath = selectedPaths[0] || '';
  return selectedPaths;
}

function getTagEditorTrackPathAt(index) {
  const track = (state.tagEditor.tracks || [])[index];
  return String(track?.path || '');
}

function getTagEditorTrackIndex(path) {
  return (state.tagEditor.tracks || []).findIndex((track) => String(track.path || '') === String(path || ''));
}

function getTagEditorRangePaths(startPath, endPath) {
  const startIndex = getTagEditorTrackIndex(startPath);
  const endIndex = getTagEditorTrackIndex(endPath);
  if (startIndex < 0 || endIndex < 0) return [String(endPath || '')].filter(Boolean);
  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  const paths = [];
  for (let index = first; index <= last; index += 1) {
    const path = getTagEditorTrackPathAt(index);
    if (path) paths.push(path);
  }
  return paths;
}

function setTagEditorSelectedPaths(paths, anchorPath = '') {
  const seen = new Set();
  const validPaths = new Set((state.tagEditor.tracks || []).map((track) => String(track.path || '')).filter(Boolean));
  const selectedPaths = (paths || [])
    .map((path) => String(path || ''))
    .filter((path) => path && validPaths.has(path) && !seen.has(path) && seen.add(path));
  state.tagEditor.selectedPaths = selectedPaths.length ? selectedPaths : [getTagEditorTrackPathAt(0)].filter(Boolean);
  state.tagEditor.selectedPath = state.tagEditor.selectedPaths[0] || '';
  state.tagEditor.anchorPath = anchorPath || state.tagEditor.anchorPath || state.tagEditor.selectedPath;
  state.tagEditor.autoNumberStatus = '';
}

function selectTagEditorTrack(path, event = {}) {
  const normalizedPath = String(path || '');
  if (!normalizedPath) return;
  const selectedPaths = getSelectedTagEditorPaths(state.tagEditor.tracks || []);
  const anchorPath = state.tagEditor.anchorPath || selectedPaths[0] || normalizedPath;
  if (event.shiftKey) {
    const rangePaths = getTagEditorRangePaths(anchorPath, normalizedPath);
    setTagEditorSelectedPaths(event.ctrlKey || event.metaKey ? [...selectedPaths, ...rangePaths] : rangePaths, anchorPath);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    const alreadySelected = selectedPaths.includes(normalizedPath);
    const nextPaths = alreadySelected && selectedPaths.length > 1
      ? selectedPaths.filter((selectedPath) => selectedPath !== normalizedPath)
      : [...selectedPaths, normalizedPath];
    setTagEditorSelectedPaths(nextPaths, normalizedPath);
    return;
  }
  setTagEditorSelectedPaths([normalizedPath], normalizedPath);
}

function getTagEditorFieldDisplayValue(field, selectedPaths) {
  const valuesByPath = state.tagEditor.values || {};
  const selectedValues = selectedPaths.map((path) => String(valuesByPath[path]?.[field] ?? ''));
  if (!selectedValues.length) return { value: '', mixed: false };
  const firstValue = selectedValues[0];
  const mixed = selectedValues.some((value) => value !== firstValue);
  return { value: mixed ? '' : firstValue, mixed };
}

function renderTagEditorArtwork(selectedPaths) {
  const els = getTagEditorElements();
  if (!els.artwork) return;
  const firstSelectedPath = selectedPaths[0] || '';
  const track = (state.tagEditor.tracks || []).find((item) => String(item.path || '') === firstSelectedPath);
  const coverPath = track?.cover_path || state.tagEditor.album?.cover_path || '';
  const label = getFilenameFromPath(firstSelectedPath) || track?.title || 'selected track';
  els.artwork.innerHTML = coverPath
    ? `<img src="/cover?path=${encodeURIComponent(coverPath)}" alt="Artwork for ${escapeHtml(label)}">`
    : '<div class="tag-editor-artwork-placeholder">No artwork</div>';
}

function renderTagEditor(options = {}) {
  const els = getTagEditorElements();
  if (!els.overlay || !els.list || !els.form) return;
  const album = state.tagEditor.album;
  const tracks = state.tagEditor.tracks || [];
  if (!album || !tracks.length) return;

  const selectedPaths = getSelectedTagEditorPaths(tracks);
  const selectedPathSet = new Set(selectedPaths);

  if (els.subtitle) {
    els.subtitle.textContent = `${album.tag_editor_title || album.name || 'Album'} - ${tracks.length} file${tracks.length === 1 ? '' : 's'} in editor - ${selectedPaths.length} selected`;
  }
  renderTagEditorArtwork(selectedPaths);
  if (els.autoNumberButton) {
    els.autoNumberButton.disabled = selectedPaths.length < 2;
  }
  if (els.autoNumberStatus) {
    els.autoNumberStatus.textContent = String(state.tagEditor.autoNumberStatus || '');
  }

  const existingTrackButtons = options.preserveTrackList
    ? Array.from(els.list.querySelectorAll('[data-tag-editor-track]'))
    : [];
  const canPreserveTrackList = existingTrackButtons.length === tracks.length
    && tracks.every((track, index) => (
      String(existingTrackButtons[index]?.getAttribute('data-tag-editor-track') || '')
      === String(track.path || '')
    ));
  if (canPreserveTrackList) {
    existingTrackButtons.forEach((button) => {
      const path = String(button.getAttribute('data-tag-editor-track') || '');
      const isSelected = selectedPathSet.has(path);
      button.classList.toggle('is-active', isSelected);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
  } else {
    els.list.innerHTML = tracks.map((track) => {
      const path = String(track.path || '');
      const fileType = getFileTypeFromPath(path);
      const filename = getFilenameFromPath(path) || track.title || path;
      return `
        <button class="tag-editor-track ${selectedPathSet.has(path) ? 'is-active' : ''}" type="button" data-tag-editor-track="${escapeHtml(path)}" aria-pressed="${selectedPathSet.has(path) ? 'true' : 'false'}" title="${escapeHtml(path)}">
          <span class="tag-editor-track-title">${escapeHtml(filename)}</span>
          ${fileType ? `<span class="utility-repair-file-type">${escapeHtml(fileType)}</span>` : ''}
        </button>
      `;
    }).join('');
  }

  els.form.querySelectorAll('[data-tag-field]').forEach((input) => {
    const field = input.getAttribute('data-tag-field') || '';
    const displayValue = getTagEditorFieldDisplayValue(field, selectedPaths);
    input.value = displayValue.value;
    input.placeholder = displayValue.mixed ? 'Mixed values' : '';
  });
  syncTagEditorPendingChanges();
}
