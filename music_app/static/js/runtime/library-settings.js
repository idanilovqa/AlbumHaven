const LIBRARY_SETTINGS_ROOT_CATEGORIES = Object.freeze([
  'main_library_roots',
  'hoarding_library_roots',
  'new_arrivals_roots',
]);

const LIBRARY_SETTINGS_LAYOUT_OPTIONS = Object.freeze([
  { value: 'artist', label: 'Artist folders' },
  { value: 'genre/artist', label: 'Genre / artist folders' },
  { value: 'album-at-root', label: 'Albums at root' },
]);

function getDefaultLibrarySettingsState() {
  return {
    settings: null,
    draft: null,
    loaded: false,
    loading: false,
    loadPromise: null,
    saveBusy: false,
    albumRatingImportBusy: false,
    albumRatingImportResult: null,
    error: '',
  };
}

function ensureLibrarySettingsState() {
  if (!state.utility.librarySettings || typeof state.utility.librarySettings !== 'object') {
    state.utility.librarySettings = getDefaultLibrarySettingsState();
  }
  if (typeof state.utility.librarySettings.albumRatingImportBusy !== 'boolean') {
    state.utility.librarySettings.albumRatingImportBusy = false;
  }
  if (!Object.prototype.hasOwnProperty.call(state.utility.librarySettings, 'albumRatingImportResult')) {
    state.utility.librarySettings.albumRatingImportResult = null;
  }
  return state.utility.librarySettings;
}

function normalizeLibrarySettingsRootEntry(category, entry, index) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const normalized = {
    id: String(source.id || `${category}-${index + 1}`).trim() || `${category}-${index + 1}`,
    path: String(source.path || ''),
  };
  if (category === 'main_library_roots') {
    const layoutMode = String(source.layout_mode || 'artist').trim();
    normalized.layout_mode = LIBRARY_SETTINGS_LAYOUT_OPTIONS.some((option) => option.value === layoutMode)
      ? layoutMode
      : 'artist';
  }
  return normalized;
}

function normalizeLibrarySettingsPayload(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const normalized = {
    version: Number(source.version || 1) || 1,
    main_library_roots: [],
    hoarding_library_roots: [],
    new_arrivals_roots: [],
    move_policy: {
      preferred_main_write_root: '',
      move_new_arrivals_to: '',
    },
  };
  LIBRARY_SETTINGS_ROOT_CATEGORIES.forEach((category) => {
    const roots = Array.isArray(source[category]) ? source[category] : [];
    normalized[category] = roots.map((entry, index) => normalizeLibrarySettingsRootEntry(category, entry, index));
  });
  const movePolicy = source.move_policy && typeof source.move_policy === 'object' ? source.move_policy : {};
  normalized.move_policy.preferred_main_write_root = String(movePolicy.preferred_main_write_root || '').trim();
  normalized.move_policy.move_new_arrivals_to = String(movePolicy.move_new_arrivals_to || '').trim();
  return normalized;
}

function cloneLibrarySettingsDraft(settings) {
  return normalizeLibrarySettingsPayload(cloneRuntimeJson(settings, {}));
}

function countConfiguredLibraryRoots(settings) {
  const normalized = normalizeLibrarySettingsPayload(settings);
  return LIBRARY_SETTINGS_ROOT_CATEGORIES.reduce(
    (total, category) => total + normalized[category].filter((root) => String(root.path || '').trim()).length,
    0,
  );
}

function buildUtilityLibraryIntegrationItem() {
  const librarySettingsState = ensureLibrarySettingsState();
  const configuredRoots = countConfiguredLibraryRoots(librarySettingsState.settings || librarySettingsState.draft || {});
  let statusLabel = 'Configure library roots';
  if (librarySettingsState.loading) {
    statusLabel = 'Loading settings';
  } else if (librarySettingsState.loaded) {
    statusLabel = configuredRoots === 1
      ? '1 root configured'
      : `${configuredRoots} roots configured`;
  }
  return {
    key: 'library',
    title: 'Library',
    description: 'Configure Main Library, Hoard, and New Arrivals roots.',
    status_label: statusLabel,
  };
}

function buildUtilityIntegrationItems() {
  return [
    buildUtilityLibraryIntegrationItem(),
    ...(Array.isArray(state.utility.integrations) ? state.utility.integrations : []),
  ];
}

async function handleLibrarySettingsIntegrationSelection(integrationKey) {
  if (String(integrationKey || '') !== 'library') return false;
  state.utility.selectedIntegrationKey = 'library';
  await loadUtilityLibrarySettings(!state.utility.librarySettings?.loaded);
  renderUtilityModalContent();
  return true;
}

function getLibrarySettingsDraft() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (!librarySettingsState.draft) {
    librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings || {});
  }
  return librarySettingsState.draft;
}

function buildEmptyLibraryRootDraft(category) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  const nextIndex = roots.length + 1;
  return normalizeLibrarySettingsRootEntry(category, { id: `${category}-${nextIndex}` }, nextIndex - 1);
}

function addLibraryRootDraftEntry(category) {
  const draft = getLibrarySettingsDraft();
  draft[category] = [...(Array.isArray(draft[category]) ? draft[category] : []), buildEmptyLibraryRootDraft(category)];
  renderUtilityModalContent();
}

function removeLibraryRootDraftEntry(category, index) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  const removed = roots[index];
  draft[category] = roots.filter((_, itemIndex) => itemIndex !== index);
  if (removed?.id) {
    if (draft.move_policy.preferred_main_write_root === removed.id) {
      draft.move_policy.preferred_main_write_root = '';
    }
    if (draft.move_policy.move_new_arrivals_to === removed.id) {
      draft.move_policy.move_new_arrivals_to = '';
    }
  }
  renderUtilityModalContent();
}

function updateLibraryRootDraftField(category, index, field, value) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  if (!roots[index]) return;
  roots[index] = {
    ...roots[index],
    [field]: String(value || ''),
  };
}

function updateLibrarySettingsDraftField(field, value) {
  const draft = getLibrarySettingsDraft();
  draft.move_policy = {
    ...(draft.move_policy || {}),
    [field]: String(value || ''),
  };
}

function applyLibrarySettingsRootFieldTarget(target) {
  if (!target) return false;
  updateLibraryRootDraftField(
    target.getAttribute('data-library-root-list') || '',
    Number(target.getAttribute('data-library-root-index') || -1),
    target.getAttribute('data-library-root-field') || '',
    target.value,
  );
  return true;
}

function applyLibrarySettingsFieldTarget(target) {
  if (!target) return false;
  updateLibrarySettingsDraftField(
    target.getAttribute('data-library-settings-field') || '',
    target.value,
  );
  return true;
}

function handleLibrarySettingsClick(event) {
  const addLibraryRootButton = event.target.closest('[data-add-library-root]');
  if (addLibraryRootButton) {
    event.preventDefault();
    addLibraryRootDraftEntry(addLibraryRootButton.getAttribute('data-add-library-root') || '');
    return true;
  }

  const removeLibraryRootButton = event.target.closest('[data-remove-library-root]');
  if (removeLibraryRootButton) {
    event.preventDefault();
    removeLibraryRootDraftEntry(
      removeLibraryRootButton.getAttribute('data-remove-library-root') || '',
      Number(removeLibraryRootButton.getAttribute('data-library-root-index') || -1),
    );
    return true;
  }

  const reloadLibrarySettingsButton = event.target.closest('[data-reload-library-settings="1"]');
  if (reloadLibrarySettingsButton) {
    event.preventDefault();
    loadUtilityLibrarySettings(true);
    return true;
  }

  const importAlbumRatingsButton = event.target.closest('[data-import-album-ratings="1"]');
  if (importAlbumRatingsButton) {
    event.preventDefault();
    importAlbumRatingsFromFileTags();
    return true;
  }

  const saveLibrarySettingsButton = event.target.closest('[data-save-library-settings="1"]');
  if (saveLibrarySettingsButton) {
    event.preventDefault();
    saveUtilityLibrarySettings();
    return true;
  }

  return false;
}

async function importAlbumRatingsFromFileTags() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (librarySettingsState.albumRatingImportBusy) return false;
  librarySettingsState.albumRatingImportBusy = true;
  librarySettingsState.albumRatingImportResult = null;
  librarySettingsState.error = '';
  renderUtilityModalContent();
  try {
    const response = await fetch('/library-settings/import-album-ratings', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Unable to import album ratings.');
    }
    librarySettingsState.albumRatingImportResult = {
      created: Number(data.created || 0),
      authority_skipped: Number(data.authority_skipped || 0),
      failed: Number(data.failed || 0),
    };
    if (librarySettingsState.albumRatingImportResult.created > 0) {
      try {
        await fetchAndRender(buildApiUrl(state.view), false, { preserveScroll: true });
      } catch (refreshError) {
        console.warn('[AlbumHaven][LibrarySettings] Ratings imported, but failed to refresh the view.', refreshError);
        showToast('Album ratings were imported, but the current view could not be refreshed.', 'warning', 3600);
      }
    }
    renderUtilityModalContent();
    return true;
  } catch (error) {
    console.error('[AlbumHaven][LibrarySettings] Failed to import album ratings.', error);
    librarySettingsState.error = error.message || 'Unable to import album ratings.';
    showToast(librarySettingsState.error, 'error', 3600);
    renderUtilityModalContent();
    return false;
  } finally {
    librarySettingsState.albumRatingImportBusy = false;
    renderUtilityModalContent();
  }
}

function handleLibrarySettingsInput(event) {
  const libraryRootInput = event.target.closest('[data-library-root-field]');
  if (applyLibrarySettingsRootFieldTarget(libraryRootInput)) {
    return true;
  }
  const librarySettingsInput = event.target.closest('[data-library-settings-field]');
  if (applyLibrarySettingsFieldTarget(librarySettingsInput)) {
    return true;
  }
  return false;
}

function handleLibrarySettingsChange(event) {
  const libraryRootSelect = event.target.closest('select[data-library-root-field]');
  if (applyLibrarySettingsRootFieldTarget(libraryRootSelect)) {
    return true;
  }
  const librarySettingsSelect = event.target.closest('select[data-library-settings-field]');
  if (applyLibrarySettingsFieldTarget(librarySettingsSelect)) {
    return true;
  }
  return false;
}

async function loadUtilityLibrarySettings(force = false) {
  const librarySettingsState = ensureLibrarySettingsState();
  if (librarySettingsState.loading) return librarySettingsState.loadPromise;
  if (librarySettingsState.loaded && !force) {
    renderUtilityModalContent();
    return librarySettingsState.settings;
  }
  librarySettingsState.loading = true;
  librarySettingsState.error = '';
  renderUtilityModalContent();
  librarySettingsState.loadPromise = (async () => {
    try {
      const response = await fetch('/library-settings', { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Unable to load library settings');
      }
      librarySettingsState.settings = normalizeLibrarySettingsPayload(data.settings);
      librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings);
      librarySettingsState.loaded = true;
      return librarySettingsState.settings;
    } catch (error) {
      console.error('[AlbumHaven][LibrarySettings] Failed to load library settings.', error);
      librarySettingsState.error = error.message || 'Unable to load library settings.';
      showToast(librarySettingsState.error, 'error', 3200);
      return null;
    } finally {
      librarySettingsState.loading = false;
      librarySettingsState.loadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return librarySettingsState.loadPromise;
}

async function saveUtilityLibrarySettings() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (librarySettingsState.saveBusy) return false;
  librarySettingsState.saveBusy = true;
  librarySettingsState.error = '';
  renderUtilityModalContent();
  try {
    const response = await fetch('/library-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: cloneLibrarySettingsDraft(getLibrarySettingsDraft()),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Unable to save library settings');
    }
    librarySettingsState.settings = normalizeLibrarySettingsPayload(data.settings);
    librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings);
    librarySettingsState.loaded = true;
    state.utility.loaded = false;
    state.utility.problematicFiles = [];
    if (data.status) {
      updateStatusIndicator(data.status);
      state.wasPollingBusy = Boolean(data.status.scan_in_progress || data.status.relations_in_progress);
      state.wasCoverPollingBusy = Boolean(data.status.covers_in_progress);
      renderLibraryLoader(state.status);
    }
    scheduleBrowserTimeout(pollStatus, 250);
    showToast('Library settings saved. Scan started.', 'success', 3200);
    renderUtilityModalContent();
    return true;
  } catch (error) {
    console.error('[AlbumHaven][LibrarySettings] Failed to save library settings.', error);
    librarySettingsState.error = error.message || 'Unable to save library settings.';
    showToast(librarySettingsState.error, 'error', 3600);
    renderUtilityModalContent();
    return false;
  } finally {
    librarySettingsState.saveBusy = false;
    renderUtilityModalContent();
  }
}

function buildLibrarySettingsRootOptions(roots, selectedId, placeholder) {
  const items = Array.isArray(roots) ? roots : [];
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  items.forEach((root, index) => {
    const rootId = String(root?.id || '');
    const rootPath = String(root?.path || '').trim();
    const label = rootPath || `Root ${index + 1}`;
    options.push(
      `<option value="${escapeHtml(rootId)}" ${rootId === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`,
    );
  });
  return options.join('');
}

function buildLibrarySettingsRootSection(category, title, description) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  const rows = roots.length
    ? roots.map((root, index) => `
        <div class="library-settings-root-row">
          <input
            type="text"
            value="${escapeHtml(root.path || '')}"
            placeholder="C:\\Music\\${escapeHtml(title.replaceAll(' ', ''))}"
            data-library-root-field="path"
            data-library-root-list="${escapeHtml(category)}"
            data-library-root-index="${index}"
          >
          ${category === 'main_library_roots'
            ? `<select
                data-library-root-field="layout_mode"
                data-library-root-list="${escapeHtml(category)}"
                data-library-root-index="${index}"
              >
                ${LIBRARY_SETTINGS_LAYOUT_OPTIONS.map((option) => `
                  <option value="${escapeHtml(option.value)}" ${option.value === root.layout_mode ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                `).join('')}
              </select>`
            : ''}
          <button class="button button-secondary library-settings-root-remove" type="button" data-remove-library-root="${escapeHtml(category)}" data-library-root-index="${index}">Remove</button>
        </div>
      `).join('')
    : '<div class="utility-empty-state compact">No roots added yet.</div>';

  return `
    <section class="library-settings-section">
      <div class="library-settings-section-heading">
        <div>
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(description)}</p>
        </div>
        <button class="button button-secondary" type="button" data-add-library-root="${escapeHtml(category)}">Add root</button>
      </div>
      <div class="library-settings-root-list">${rows}</div>
    </section>
  `;
}

function buildUtilityLibrarySettingsDetail() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (librarySettingsState.loading && !librarySettingsState.loaded) {
    return '<div class="utility-empty-state">Loading library settings...</div>';
  }
  if (!librarySettingsState.loaded && librarySettingsState.error) {
    return `
      <div class="utility-rule-detail">
        <h3 class="utility-rule-title">Library</h3>
        <p class="utility-rule-description">${escapeHtml(librarySettingsState.error)}</p>
        <div class="confirm-modal-actions">
          <button class="button" type="button" data-reload-library-settings="1">Retry</button>
        </div>
      </div>
    `;
  }

  const draft = getLibrarySettingsDraft();
  const movePolicy = draft.move_policy || {};
  const importResult = librarySettingsState.albumRatingImportResult;
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">Library</h3>
      <p class="utility-rule-description">Save root settings for Main Library, Hoard, and New Arrivals. Saving starts a full rescan and queues the normal post-scan cover refresh.</p>
      ${librarySettingsState.error ? `<div class="library-settings-error">${escapeHtml(librarySettingsState.error)}</div>` : ''}
      ${buildLibrarySettingsRootSection('main_library_roots', 'Main Library', 'Roots used for primary browsing and library moves.')}
      ${buildLibrarySettingsRootSection('hoarding_library_roots', 'Hoard', 'Roots used for long-term arrivals storage and hoard-only browsing.')}
      ${buildLibrarySettingsRootSection('new_arrivals_roots', 'New Arrivals', 'Roots used for arrivals-only browsing and move planning.')}
      <section class="library-settings-section">
        <div class="library-settings-section-heading">
          <div>
            <h4>Move policy</h4>
            <p>Choose the preferred write targets that the server-owned move planner should use.</p>
          </div>
        </div>
        <div class="lastfm-credentials-grid library-settings-policy-grid">
          <label class="lastfm-inline-field library-settings-inline-field">
            <span>Library writes</span>
            <select data-library-settings-field="preferred_main_write_root">
              ${buildLibrarySettingsRootOptions(draft.main_library_roots, movePolicy.preferred_main_write_root, 'Choose a Main Library root')}
            </select>
          </label>
          <label class="lastfm-inline-field library-settings-inline-field">
            <span>Move to Hoard</span>
            <select data-library-settings-field="move_new_arrivals_to">
              ${buildLibrarySettingsRootOptions(draft.hoarding_library_roots, movePolicy.move_new_arrivals_to, 'Choose a Hoard root')}
            </select>
          </label>
        </div>
      </section>
      <section class="library-settings-section">
        <div class="library-settings-section-heading">
          <div>
            <h4>Album ratings</h4>
            <p>Copy file-tag ratings into albums that do not already have an app rating. Existing app ratings remain unchanged.</p>
          </div>
          <button class="button button-secondary" type="button" data-import-album-ratings="1" ${librarySettingsState.albumRatingImportBusy ? 'disabled' : ''}>${librarySettingsState.albumRatingImportBusy ? 'Importing ratings...' : 'Import ratings from file tags'}</button>
        </div>
        ${importResult ? `<div class="library-settings-import-result" data-album-rating-import-result="1">Created: ${escapeHtml(importResult.created)} \u00b7 Authority skipped: ${escapeHtml(importResult.authority_skipped)} \u00b7 Failed: ${escapeHtml(importResult.failed)}</div>` : ''}
      </section>
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-reload-library-settings="1" ${librarySettingsState.saveBusy ? 'disabled' : ''}>Reload</button>
        <button class="button" type="button" data-save-library-settings="1" ${librarySettingsState.saveBusy ? 'disabled' : ''}>${librarySettingsState.saveBusy ? 'Saving...' : 'Save library settings'}</button>
      </div>
    </div>
  `;
}
