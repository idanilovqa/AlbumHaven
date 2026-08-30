const utilityTabRegistry = {};

function registerUtilityTab(key, config) {
  if (!key) return;
  utilityTabRegistry[key] = config || {};
}

function getUtilityTabConfig(key = state.utility.activeTab || 'problematic-files') {
  return utilityTabRegistry[key] || utilityTabRegistry['problematic-files'] || null;
}

function setUtilitySearchState({ enabled = false, placeholder = '', value = '' } = {}) {
  const els = getUtilityModalElements();
  if (!els.search) return;
  els.search.disabled = !enabled;
  els.search.placeholder = placeholder;
  els.search.value = value;
}

function setUtilityProblemFilterState({ enabled = false, hidden = true, chipsHtml = '' } = {}) {
  const els = getUtilityModalElements();
  if (els.problemFilterButton) els.problemFilterButton.disabled = !enabled;
  if (els.problemFilterButton) els.problemFilterButton.hidden = hidden;
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = hidden;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = chipsHtml;
}

function renderUtilityModalContent() {
  const els = getUtilityModalElements();
  const activeTab = state.utility.activeTab || 'problematic-files';
  els.tabs.forEach((tab) => {
    const selected = tab.getAttribute('data-utility-tab') === activeTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  const config = getUtilityTabConfig(activeTab);
  if (config?.render) {
    config.render();
  }
}

function ensureUtilityTabLoaded(tabKey = state.utility.activeTab || 'problematic-files', force = false) {
  const config = getUtilityTabConfig(tabKey);
  if (!config?.load) {
    renderUtilityModalContent();
    return null;
  }
  return config.load(force);
}

function activateUtilityTab(tabKey, { forceLoad = false } = {}) {
  state.utility.activeTab = tabKey || 'problematic-files';
  if (forceLoad) {
    return ensureUtilityTabLoaded(state.utility.activeTab, true);
  }
  const config = getUtilityTabConfig(state.utility.activeTab);
  if (config?.shouldLoadOnActivate && config.shouldLoadOnActivate()) {
    return ensureUtilityTabLoaded(state.utility.activeTab, false);
  }
  renderUtilityModalContent();
  return null;
}

function handleUtilitySearchInput() {
  const els = getUtilityModalElements();
  const config = getUtilityTabConfig();
  if (!config?.onSearch || !els.search) return false;
  config.onSearch(els.search.value || '');
  return true;
}

function openUtilityModal({ resetSearch = true, resetSelection = true, forceLoad = true } = {}) {
  const els = getUtilityModalElements();
  if (!els.overlay) return;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (resetSelection) {
    state.utility.selectedProblematicKey = '';
    state.utility.pendingRepairKey = '';
    state.utility.pendingRepairAction = '';
    state.utility.focusedTrackPath = '';
    state.utility.showRepairedDisplay = true;
    state.utility.repairSelections = {};
    state.utility.separateReleaseSelections = {};
    state.utility.deferProblematicAutoSelection = false;
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
  if (forceLoad) {
    ensureUtilityTabLoaded(state.utility.activeTab || 'problematic-files', true);
    return;
  }
  renderUtilityModalContent();
}

function openUtilityLogHistoryTab() {
  state.utility.activeTab = 'log-history';
  openUtilityModal({ resetSearch: false, resetSelection: false, forceLoad: true });
}

function closeUtilityModal() {
  const els = getUtilityModalElements();
  if (!els.overlay) return;
  document.querySelectorAll('.utility-loop-audio').forEach((audio) => {
    audio.pause();
  });
  els.overlay.hidden = true;
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  if (!trackModalOpen && !lightboxOpen) {
    document.body.classList.remove('modal-open');
  }
}

function handleUtilityModalClick(event) {
  const utilityTabButton = event.target.closest('[data-utility-tab]');
  if (utilityTabButton) {
    event.preventDefault();
    activateUtilityTab(utilityTabButton.getAttribute('data-utility-tab') || 'problematic-files');
    return true;
  }
  const config = getUtilityTabConfig();
  if (config?.handleClick) {
    return Boolean(config.handleClick(event));
  }
  return false;
}

function handleUtilityModalInput(event) {
  const config = getUtilityTabConfig();
  if (config?.handleInput) {
    return Boolean(config.handleInput(event));
  }
  return false;
}

function handleUtilityModalChange(event) {
  const config = getUtilityTabConfig();
  if (config?.handleChange) {
    return Boolean(config.handleChange(event));
  }
  return false;
}

async function loadProblematicFiles(force = false) {
  if (state.utility.loading) return state.utility.loadPromise;
  if (state.utility.loaded && !force) {
    renderUtilityModalContent();
    return null;
  }
  state.utility.loading = true;
  renderUtilityModalContent();
  state.utility.loadPromise = (async () => {
    try {
      const response = await fetch('/utilities/problematic-files', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      state.utility.problematicFiles = Array.isArray(data.items) ? data.items : [];
      state.utility.loaded = true;
    } catch (error) {
      console.error('[AlbumHaven][Utilities] Failed to load problematic files.', error);
      state.utility.problematicFiles = [];
      showToast('Unable to load problematic files.', 'error', 3200);
    } finally {
      state.utility.loading = false;
      state.utility.loadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.loadPromise;
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
    applyUpdatedAlbumsToCurrentView(updatedAlbums, { originalAlbum: album });
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
    state.wasCoverPollingBusy = true;
    const response = await fetch('/utilities/fetch-covers-unsuccessful', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    console.log('[AlbumHaven][Covers] Manual bulk cover fetch HTTP response.', {
      status: response.status,
      ok: response.ok,
      processed: data.processed_count,
      downloaded: data.downloaded_count,
      failed: data.failed_count,
      mode: data.mode,
      forceSearchUsed: data.force_search_used,
      sampleJobResults: Array.isArray(data.job_results) ? data.job_results.slice(0, 10) : [],
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to fetch album covers');
    }
    await fetchAndRender(buildApiUrl(state.view), false);
    if (state.utility.loaded) {
      await loadProblematicFiles(true);
    }
    showToast(
      Number(data.downloaded_count || 0) > 0
        ? `Updated ${Number(data.downloaded_count || 0)} album covers.`
        : 'Cover fetch finished with no new covers saved.',
      Number(data.downloaded_count || 0) > 0 ? 'success' : 'error',
      3200,
    );
  } catch (error) {
    updateStatusIndicator(previousStatus);
    console.error('[AlbumHaven][Utilities] Failed to fetch unresolved album covers.', error);
    showToast(error.message || 'Failed to fetch album covers.', 'error', 3200);
  }
}

function openRepairConfirmModal() {
  const els = getRepairConfirmElements();
  if (!els.overlay) return;
  const action = state.utility.pendingRepairAction || 'repair';
  const selectedRows = action === 'repair' ? getSelectedRepairRowKeys() : [];
  const ignoredRows = action === 'detected' ? getIgnoredRepairRowKeys() : [];
  const separateRows = action === 'detected' ? getSelectedSeparateReleaseKeys() : [];
  const actionPaths = new Set([...selectedRows, ...ignoredRows].map((value) => String(value).split('::')[0]).filter(Boolean));
  if (els.text) {
    if (selectedRows.length) {
      els.text.textContent = actionPaths.size > 1
        ? `This will try to repair ${actionPaths.size} local files with the selected fixes. Are you sure?`
        : 'This will try to repair your local file with the selected fix. Are you sure?';
      if (els.accept) els.accept.textContent = 'Yes, repair files';
    } else if (separateRows.length) {
      els.text.textContent = ignoredRows.length
        ? 'This will apply the selected problem ignores, treat the year mismatch as separate releases, and rebuild the album list. Are you sure?'
        : 'This will treat the selected year mismatch as separate releases and rebuild the album list. Are you sure?';
      if (els.accept) els.accept.textContent = 'Yes, apply';
    } else {
      els.text.textContent = actionPaths.size > 1
        ? `This will mark the selected problems as not a problem for ${actionPaths.size} local files. Are you sure?`
        : 'This will mark the selected problem as not a problem for this local file. Are you sure?';
      if (els.accept) els.accept.textContent = 'Yes, apply';
    }
  }
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
