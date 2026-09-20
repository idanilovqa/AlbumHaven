const LIBRARY_SETTINGS_ROOT_CATEGORIES = Object.freeze([
  'main_library_roots',
  'hoarding_library_roots',
  'new_arrivals_roots',
]);

const LIBRARY_SETTINGS_LAYOUT_MODES = Object.freeze(['artist', 'genre/artist', 'album-at-root']);

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
    allowedActions: {},
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
    normalized.layout_mode = LIBRARY_SETTINGS_LAYOUT_MODES.includes(layoutMode)
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

function serializeLibrarySettingsDraft(draft) {
  const payload = normalizeLibrarySettingsPayload(draft);
  LIBRARY_SETTINGS_ROOT_CATEGORIES.forEach(category => {
    const blankIds = new Set();
    payload[category] = payload[category].filter(root => {
      if (root.path.trim()) return true;
      blankIds.add(root.id);
      return false;
    });
    const policyKey = category === 'main_library_roots' ? 'preferred_main_write_root' : category === 'hoarding_library_roots' ? 'move_new_arrivals_to' : '';
    if (policyKey && blankIds.has(payload.move_policy[policyKey])) payload.move_policy[policyKey] = '';
  });
  return payload;
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
    ...(Array.isArray(state.utility.integrations) ? state.utility.integrations : []).map(item => item.key === 'lastfm' ? {...item, title: 'Scrobbling'} : item),
  ];
}

async function handleLibrarySettingsIntegrationSelection(integrationKey) {
  if (String(integrationKey || '') !== 'library') return false;
  state.utility.selectedIntegrationKey = 'library';
  await loadUtilityLibrarySettings(!state.utility.librarySettings?.loaded);
  return true;
}

function getLibrarySettingsDraft() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (!librarySettingsState.draft) {
    librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings || {});
  }
  LIBRARY_SETTINGS_ROOT_CATEGORIES.forEach(category => {
    if (!librarySettingsState.draft[category]?.length) librarySettingsState.draft[category] = [normalizeLibrarySettingsRootEntry(category, {}, 0)];
  });
  return librarySettingsState.draft;
}

function buildEmptyLibraryRootDraft(category) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  let nextIndex = roots.length + 1;
  while (roots.some(root => root.id === `${category}-${nextIndex}`)) nextIndex += 1;
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
  if (!draft[category].length) draft[category].push(normalizeLibrarySettingsRootEntry(category, {}, 0));
  if (removed?.id) {
    if (category === 'main_library_roots' && draft.move_policy.preferred_main_write_root === removed.id) {
      draft.move_policy.preferred_main_write_root = '';
    }
    if (category === 'hoarding_library_roots' && draft.move_policy.move_new_arrivals_to === removed.id) {
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
  const toggle = event.target.closest('[id^="library-auto-move-"]');
  if (toggle) {
    event.preventDefault();
    const owner = ensureLibrarySettingsState();
    if (owner.allowedActions?.['library.settings.manage'] !== true || toggle.disabled) return true;
    const field = toggle.id === 'library-auto-move-main' ? 'preferred_main_write_root' : toggle.id === 'library-auto-move-hoard' ? 'move_new_arrivals_to' : '';
    if (!field) return false;
    owner.moveAutomationDraft ||= {};
    owner.moveAutomationDraft[field] = !owner.moveAutomationDraft[field];
    renderUtilityModalContent();
    document.getElementById?.(toggle.id)?.focus({ preventScroll: true });
    return true;
  }
  const policy = event.target.closest('[data-library-policy-trigger]');
  if (policy) {
    event.preventDefault();
    if (ensureLibrarySettingsState().allowedActions?.['library.settings.manage'] !== true) return true;
    const field = policy.getAttribute('data-library-policy-trigger');
    const category = field === 'preferred_main_write_root' ? 'main_library_roots' : field === 'move_new_arrivals_to' ? 'hoarding_library_roots' : '';
    if (!category) return true;
    const draft = getLibrarySettingsDraft();
    openUtilityChoiceDropdown(policy, {
      matchTriggerWidth: true,
      formats: buildLibrarySettingsRootOptions(draft[category]),
      selected: draft.move_policy[field] || buildLibrarySettingsRootOptions(draft[category])[0]?.value, label: field === 'preferred_main_write_root' ? 'Library destination' : 'Move to Hoard',
      onSelect: value => {
        if (ensureLibrarySettingsState().allowedActions?.['library.settings.manage'] !== true) return false;
        updateLibrarySettingsDraftField(field, value);
      },
    });
    return true;
  }
  const browse = event.target.closest('[data-browse-library-root]');
  if (browse) { event.preventDefault(); browseLibraryRootDraft(browse.getAttribute('data-browse-library-root'), Number(browse.getAttribute('data-library-root-index'))); return true; }
  const foobarHelp = event.target.closest('[data-foobar-help]');
  if (foobarHelp) { event.preventDefault(); openUtilityFoobarGuide(); return true; }
  const foobarFormat = event.target.closest('[data-foobar-format-trigger]');
  if (foobarFormat) { event.preventDefault(); openUtilityFoobarFormats(foobarFormat); return true; }
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
  const owner = state.utility;
  const librarySettingsState = ensureLibrarySettingsState();
  const ownsPresentation = () => state.utility === owner && owner.librarySettings === librarySettingsState
    && owner.activeTab === 'integrations' && owner.selectedIntegrationKey === 'library'
    && !getUtilityModalElements()?.overlay?.hidden;
  const renderCurrent = () => { if (ownsPresentation()) renderUtilityModalContent(); };
  if (librarySettingsState.loading) {
    renderCurrent();
    return librarySettingsState.loadPromise;
  }
  if (librarySettingsState.loaded && !force) {
    renderCurrent();
    return librarySettingsState.settings;
  }
  librarySettingsState.loading = true;
  librarySettingsState.error = '';
  renderCurrent();
  librarySettingsState.loadPromise = (async () => {
    try {
      const response = await fetch('/library-settings', { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Unable to load library settings');
      }
      librarySettingsState.allowedActions = data.allowed_actions || {};
      librarySettingsState.settings = normalizeLibrarySettingsPayload(data.settings);
      librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings);
      librarySettingsState.loaded = true;
      return librarySettingsState.settings;
    } catch (error) {
      console.error('[AlbumHaven][LibrarySettings] Failed to load library settings.', error);
      librarySettingsState.error = error.message || 'Unable to load library settings.';
      if (ownsPresentation()) showToast(librarySettingsState.error, 'error', 3200);
      return null;
    } finally {
      librarySettingsState.loading = false;
      librarySettingsState.loadPromise = null;
      renderCurrent();
    }
  })();
  return librarySettingsState.loadPromise;
}

async function saveUtilityLibrarySettings() {
  const owner = state.utility;
  const librarySettingsState = ensureLibrarySettingsState();
  const ownsContext = () => state.utility === owner && owner.librarySettings === librarySettingsState;
  const ownsPresentation = () => ownsContext() && owner.activeTab === 'integrations'
    && owner.selectedIntegrationKey === 'library' && !getUtilityModalElements()?.overlay?.hidden;
  const renderCurrent = () => { if (ownsPresentation()) renderUtilityModalContent(); };
  if (librarySettingsState.saveBusy || librarySettingsState.allowedActions?.['library.settings.manage'] !== true) return false;
  librarySettingsState.saveBusy = true;
  librarySettingsState.error = '';
  renderCurrent();
  try {
    const response = await fetch('/library-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: serializeLibrarySettingsDraft(getLibrarySettingsDraft()) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to save library settings');
    librarySettingsState.settings = normalizeLibrarySettingsPayload(data.settings);
    librarySettingsState.draft = cloneLibrarySettingsDraft(librarySettingsState.settings);
    librarySettingsState.loaded = true;
    owner.loaded = false;
    owner.problematicFiles = [];
    if (ownsContext()) {
      if (data.status) {
        updateStatusIndicator(data.status);
        state.wasPollingBusy = Boolean(data.status.scan_in_progress || data.status.relations_in_progress);
        state.wasCoverPollingBusy = Boolean(data.status.covers_in_progress);
        renderLibraryLoader(state.status);
      }
      scheduleBrowserTimeout(pollStatus, 250);
    }
    if (ownsPresentation()) showToast('Library settings saved. Scan started.', 'success', 3200);
    return true;
  } catch (error) {
    console.error('[AlbumHaven][LibrarySettings] Failed to save library settings.', error);
    librarySettingsState.error = error.message || 'Unable to save library settings.';
    if (ownsPresentation()) showToast(librarySettingsState.error, 'error', 3600);
    return false;
  } finally {
    librarySettingsState.saveBusy = false;
    renderCurrent();
  }
}

function buildLibrarySettingsRootOptions(roots, placeholder) {
  return [...(placeholder ? [{ value: '', label: placeholder }] : []), ...(Array.isArray(roots) ? roots : [])
    .filter(root => String(root?.path || '').trim())
    .map(root => ({ value: String(root.id), label: String(root.path).trim() }))];
}

function buildLibrarySettingsPolicyButton(field, roots, selectedId, label) {
  const choices = buildLibrarySettingsRootOptions(roots);
  if (choices.length <= 1) return `<span data-library-policy-value="${field}">${escapeHtml(choices[0]?.label || 'No library path configured')}</span>`;
  const selectedLabel = choices.find(choice => choice.value === selectedId)?.label || choices[0]?.label;
  return window.ButtonComponent.renderButton({
    label: selectedLabel,
    ariaLabel: label, disabled: ensureLibrarySettingsState().allowedActions?.['library.settings.manage'] !== true,
    attributes: { 'data-library-policy-trigger': field, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
}

function buildLibraryMovePolicyRow(field, roots, selectedId, title, destinationLabel, key) {
  const owner = ensureLibrarySettingsState();
  const enabled = owner.moveAutomationDraft?.[field] === true;
  const hasRoots = buildLibrarySettingsRootOptions(roots).length > 0;
  return `<div class="library-settings-move-policy-row">
    ${buildGallerySwitchHtml({ id: `library-auto-move-${key}`, label: title, checked: enabled, disabled: !hasRoots || owner.allowedActions?.['library.settings.manage'] !== true })}
    ${enabled && hasRoots ? buildLibrarySettingsPolicyButton(field, roots, selectedId, destinationLabel) : ''}
  </div>`;
}

function buildLibrarySettingsRootSection(category, title, description) {
  const draft = getLibrarySettingsDraft();
  const roots = Array.isArray(draft[category]) ? draft[category] : [];
  const canManage = ensureLibrarySettingsState().allowedActions?.['library.settings.manage'] === true;
  const canBrowse = canManage && ensureLibrarySettingsState().allowedActions?.['library.filesystem.browse'] === true && ensureLibrarySettingsState().allowedActions?.['library.paths.read'] === true;
  const rows = roots.map((root, index) => `<div class="library-settings-root-row">
    <div class="library-settings-path-control ui-input-action"><input type="text" value="${escapeHtml(root.path || '')}"
      aria-label="${escapeHtml(title)} path ${index + 1}" placeholder="${escapeHtml(title)} folder"
      data-library-root-field="path" data-library-root-list="${escapeHtml(category)}" data-library-root-index="${index}" ${canManage ? '' : 'disabled'}>
      ${window.ButtonComponent.renderActionButton({ariaLabel: `Choose ${title} folder ${index + 1}`, iconClass: 'album-details-header__action-icon album-details-header__action-icon--folder', disabled: !canBrowse,
        attributes: {'data-browse-library-root': category, 'data-library-root-index': index}})}
      ${window.ButtonComponent.renderActionButton({ariaLabel: `Remove ${title} path ${index + 1}`, icon: 'delete', semantic: 'destructive', disabled: !canManage,
        attributes: {'data-remove-library-root': category, 'data-library-root-index': index}})}</div>
    </div>`).join('');

  return `
    <section class="library-settings-section">
      <div class="library-settings-section-heading">
        <div>
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(description)}</p>
        </div>
        ${window.ButtonComponent.renderButton({label: 'Add path', disabled: !canManage, attributes: {'data-add-library-root': category}})}
      </div>
      <div class="library-settings-root-list">${rows}</div>
    </section>
  `;
}

function buildUtilityLibrarySettingsDetail() {
  const librarySettingsState = ensureLibrarySettingsState();
  if (!librarySettingsState.loaded && !librarySettingsState.error) {
    return '<div class="utility-empty-state">Loading library settings...</div>';
  }
  if (!librarySettingsState.loaded && librarySettingsState.error) {
    return `
      <div class="utility-rule-detail">
        <h3 class="utility-rule-title">Library</h3>
        ${buildOnPageAlertHtml({ severity: 'error', title: 'Library settings unavailable', message: librarySettingsState.error,
          actionsHtml: ButtonComponent.renderButton({ label: 'Retry', attributes: { 'data-reload-library-settings': '1' } }) })}
      </div>
    `;
  }

  const draft = getLibrarySettingsDraft();
  const movePolicy = draft.move_policy || {};
  const importResult = librarySettingsState.albumRatingImportResult;
  return `
    <div class="utility-rule-detail">
      <h3 class="utility-rule-title">Library</h3>
      ${librarySettingsState.error ? buildOnPageAlertHtml({ severity: 'error', title: 'Library settings could not be updated', message: librarySettingsState.error }) : ''}
      ${buildLibrarySettingsRootSection('main_library_roots', 'Main Library', '')}
      ${buildLibrarySettingsRootSection('hoarding_library_roots', 'Hoard', 'Unlistened music.')}
      ${buildLibrarySettingsRootSection('new_arrivals_roots', 'New Arrivals', 'Folders watched for new music.')}
      <section class="library-settings-section">
        <div class="library-settings-section-heading">
          <div>
            <h4>Move policy</h4>
            <p>Choose where albums are moved into your libraries.</p>
          </div>
        </div>
        <div class="library-settings-policy-grid">
          ${buildLibraryMovePolicyRow('preferred_main_write_root', draft.main_library_roots, movePolicy.preferred_main_write_root, 'Auto Move rated albums to Main library', 'Library destination', 'main')}
          ${buildLibraryMovePolicyRow('move_new_arrivals_to', draft.hoarding_library_roots, movePolicy.move_new_arrivals_to, 'Move New Arrivals to Hoard', 'Move to Hoard', 'hoard')}
        </div>
      </section>
      <section class="library-settings-section">
        <div class="library-settings-section-heading">
          <div>
            <h4>Album ratings</h4>
            <p>Copy file-tag ratings into albums that do not already have an app rating. Existing app ratings remain unchanged.</p>
          </div>
          <button class="button button-secondary" type="button" data-import-album-ratings="1" ${librarySettingsState.albumRatingImportBusy ? 'disabled' : ''}>${librarySettingsState.albumRatingImportBusy ? 'Importing ratings...' : 'Import ratings'}</button>
        </div>
        ${importResult ? `<div class="library-settings-import-result" data-album-rating-import-result="1">Created: ${escapeHtml(importResult.created)} \u00b7 Authority skipped: ${escapeHtml(importResult.authority_skipped)} \u00b7 Failed: ${escapeHtml(importResult.failed)}</div>` : ''}
      </section>
      <div class="confirm-modal-actions">
        <button class="button button-secondary" type="button" data-reload-library-settings="1" ${librarySettingsState.saveBusy ? 'disabled' : ''}>Reload</button>
        <button class="button" type="button" data-save-library-settings="1" ${librarySettingsState.saveBusy || librarySettingsState.allowedActions?.['library.settings.manage'] !== true ? 'disabled' : ''}>${librarySettingsState.saveBusy ? 'Saving...' : 'Save library settings'}</button>
      </div>
    </div>
  `;
}


async function browseLibraryRootDraft(category, index) {
  const utility = state.utility, owner = ensureLibrarySettingsState();
  const activeTab = utility.activeTab, selectedKey = utility.selectedIntegrationKey;
  const current = () => state.utility === utility && utility.librarySettings === owner && utility.activeTab === activeTab && utility.selectedIntegrationKey === selectedKey && (typeof document === 'undefined' || !document.getElementById?.('utility-modal')?.hidden);
  if (!LIBRARY_SETTINGS_ROOT_CATEGORIES.includes(category) || owner.allowedActions?.['library.settings.manage'] !== true
      || owner.allowedActions?.['library.filesystem.browse'] !== true || owner.allowedActions?.['library.paths.read'] !== true) return false;
  const root = getLibrarySettingsDraft()[category]?.[index];
  if (!root) return false;
  let selected = '', disposed = false, generation = 0, navigating = false;
  const read = async path => {
    const response = await fetch(`/library-settings/browse?path=${encodeURIComponent(path)}`, {headers: {Accept: 'application/json'}});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to browse folders.');
    return data;
  };
  try {
    const initial = await read('');
    if (!current() || ensureLibrarySettingsState() !== owner) return false;
    const render = data => `<p>${escapeHtml(data.path || 'Choose a configured location')}</p><div class="settings-folder-list">${data.parent_path ? window.ButtonComponent.renderButton({label: 'Parent folder', attributes: {'data-folder-path': data.parent_path}}) : ''}${(data.entries || []).map(entry => window.ButtonComponent.renderButton({label: entry.name, attributes: {'data-folder-path': entry.path}})).join('')}</div>`;
    const result = await showAppFormDialog({ title: 'Choose library folder', contentHtml: render(initial), submitLabel: 'Choose folder', submitEnabled: false,
      onMount: (content, dialog) => {
        const syncNavigation = () => {
          content.setAttribute?.('aria-busy', String(navigating));
          dialog?.setSubmitEnabled(Boolean(selected) && !navigating);
        };
        const navigate = async event => {
          const button = event.target.closest('[data-folder-path]'); if (!button) return;
          event.preventDefault(); const requestGeneration = ++generation;
          selected = ''; navigating = true; syncNavigation();
          try { const data = await read(button.getAttribute('data-folder-path'));
            if (disposed || requestGeneration !== generation || !current()) return;
            selected = String(data.path || ''); content.innerHTML = render(data);
          } catch (error) { if (!disposed && requestGeneration === generation && current()) showToast(error.message, 'error'); }
          finally { if (!disposed && requestGeneration === generation && current()) { navigating = false; syncNavigation(); } }
        };
        content.addEventListener('click', navigate); owner.pickerCleanup = () => content.removeEventListener('click', navigate);
      },
      onClose: () => { disposed = true; owner.pickerCleanup?.(); delete owner.pickerCleanup; },
      onSubmit: () => { if (navigating) throw new Error('Wait for the folder to finish loading.'); if (!selected) throw new Error('Choose a folder first.'); return selected; },
    });
    if (!result || !current() || ensureLibrarySettingsState() !== owner || getLibrarySettingsDraft()[category]?.[index] !== root) return false;
    root.path = result; renderUtilityModalContent(); return true;
  } catch (error) { if (current()) showToast(error.message || 'Folder picker unavailable.', 'error'); return false; }
}


async function openUtilityFoobarGuide() {
  const utility = state.utility, activeTab = state.utility.activeTab, selectedKey = state.utility.selectedIntegrationKey;
  try {
    const response = await fetch('/utilities/integrations/foobar/help', {headers: {Accept: 'application/json'}});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load setup instructions.');
    if (state.utility !== utility || utility.activeTab !== activeTab || utility.selectedIntegrationKey !== selectedKey || (typeof document !== 'undefined' && document.getElementById?.('utility-modal')?.hidden)) return false;
    const sections = (data.sections || []).map(section => `<section><h4>${escapeHtml(section.title)}</h4><div class="settings-guide-copy">${formatUtilityGuideMarkdown(section.body_markdown)}</div></section>`).join('');
    const references = (data.reference_assets || []).filter(asset => String(asset.view_url || '').startsWith('/utilities/integrations/foobar/assets/'))
      .map(asset => `<li><a href="${escapeHtml(asset.view_url)}" target="_blank" rel="noreferrer">${escapeHtml(asset.title)}</a></li>`).join('');
    return await showAppFormDialog({title: 'Foobar2000 setup instructions', mode: 'reading',
      contentHtml: `<article class="settings-reading-guide" tabindex="0" aria-label="Foobar2000 setup instructions">${sections}${references ? `<h4>Reference files</h4><ul>${references}</ul>` : ''}</article>`});
  } catch (error) { if (state.utility === utility) showToast(error.message || 'Unable to load setup instructions.', 'error'); return false; }
}

let utilityFoobarFormatCleanup = null;
let utilityChoiceTrigger = null;
function openUtilityFoobarFormats(trigger) {
  return openUtilityChoiceDropdown(trigger, {
    formats: ['Playback Statistics XML', 'Text Tools — standard', 'Text Tools — enhanced'],
    selected: state.utility.foobarFormat || 'Playback Statistics XML', label: 'Foobar export format',
    onSelect: value => { state.utility.foobarFormat = value; },
  });
}
function resolveUtilityChoiceDropdownVerticalPlacement(triggerRect, menuHeight, viewportBottom) {
  const gap = 4;
  const height = Math.max(80, Number(menuHeight) || 0);
  const below = Math.max(80, Number(viewportBottom) - triggerRect.bottom - 12);
  const above = Math.max(80, triggerRect.top - 12);
  if (height > below && above > below) {
    return { top: Math.max(8, triggerRect.top - gap - Math.min(height, above)), maxHeight: above };
  }
  return { top: triggerRect.bottom + gap, maxHeight: below };
}

function openUtilityChoiceDropdown(trigger, { formats, selected, label, onSelect, matchTriggerWidth = false }) {
  if (utilityFoobarFormatCleanup) {
    const sameTrigger = utilityChoiceTrigger === trigger;
    utilityFoobarFormatCleanup();
    if (sameTrigger) return;
  }
  const choices = formats.map(format => typeof format === 'string' ? { value: format, label: format } : format);
  const menu = document.createElement('div');
  menu.className = 'gallery-anchored-menu settings-foobar-format-menu'; menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.innerHTML = choices.map(choice => window.ButtonComponent.renderButton({label: choice.label, className: 'gallery-menu-action', attributes: {role: 'menuitemradio', 'aria-checked': String(choice.value === selected), 'data-foobar-format': choice.value}})).join('');
  document.body.append(menu);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    clearTriggerAnchor(menu); menu.remove(); trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', position);
    observer?.disconnect(); utilityFoobarFormatCleanup = null; utilityChoiceTrigger = null;
  };
  const position = () => {
    if (!trigger.isConnected) { close(); return; }
    const rect = trigger.getBoundingClientRect(); menu.style.position = 'fixed'; menu.style.zIndex = '130';
    const menuWidth = matchTriggerWidth ? Math.min(rect.width, window.innerWidth - 16) : Math.min(280, window.innerWidth - 16);
    menu.style.width = `${Math.max(0, menuWidth)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))}px`;
    const playerRect = document.querySelector?.('.global-player')?.getBoundingClientRect?.();
    const viewportBottom = playerRect?.height > 0 && playerRect.top < window.innerHeight
      ? Math.max(0, playerRect.top)
      : window.innerHeight;
    const vertical = resolveUtilityChoiceDropdownVerticalPlacement(rect, menu.scrollHeight, viewportBottom);
    menu.style.top = `${vertical.top}px`; menu.style.maxHeight = `${vertical.maxHeight}px`;
    syncTriggerAnchor(menu, trigger);
  };
  const outside = event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(); };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (menu.hidden || !trigger.isConnected) close(); }) : null;
  observer?.observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  utilityFoobarFormatCleanup = close; utilityChoiceTrigger = trigger; trigger.setAttribute('aria-expanded', 'true'); position();
  document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', position);
  menu.addEventListener('click', event => {
    const choice = event.target.closest('[data-foobar-format]'); if (!choice) return;
    const value = choice.getAttribute('data-foobar-format');
    const option = choices.find(item => item.value === value); if (!option) return;
    if (onSelect(value) === false) { close(); return; }
    const label = trigger.querySelector('.ui-button__content'); if (label) label.textContent = option.label;
    close(); trigger.focus({preventScroll:true});
  });
  menu.addEventListener('keydown', event => {
    const buttons = Array.from(menu.querySelectorAll('button')), index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } close(); trigger.focus({preventScroll:true}); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  });
  menu.querySelector('button')?.focus();
}


function formatUtilityGuideMarkdown(value) {
  const inline = text => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) =>
      /^(?:https:\/\/|\/utilities\/integrations\/foobar\/assets\/)/.test(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>` : label);
  const lines = String(value || '').split(/\r?\n/), result = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    if (lines[index].startsWith('```')) {
      const code = []; index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index++; result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    const ordered = /^\d+\.\s+/.test(lines[index]), unordered = /^[-*]\s+/.test(lines[index]);
    if (ordered || unordered) {
      const pattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/, items = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(`<li>${inline(lines[index++].replace(pattern, ''))}</li>`);
      const tag = ordered ? 'ol' : 'ul'; result.push(`<${tag}>${items.join('')}</${tag}>`); continue;
    }
    if (/^#{1,6}\s+/.test(lines[index])) { result.push(`<h5>${inline(lines[index++].replace(/^#{1,6}\s+/, ''))}</h5>`); continue; }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(?:```|\d+\.\s+|[-*]\s+|#{1,6}\s+)/.test(lines[index])) paragraph.push(lines[index++]);
    result.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return result.join('');
}
