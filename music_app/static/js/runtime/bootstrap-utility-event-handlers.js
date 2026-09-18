async function handleUtilityBootstrapClick(event) {
  const removeMissingAlbumButton = event.target.closest('#utility-modal [data-remove-missing-album="1"]');
  if (removeMissingAlbumButton) {
    event.preventDefault();
    const album = getSelectedProblematicAlbum();
    const runtimeOptions = typeof album?.constructor === 'function' ? new album.constructor() : {};
    runtimeOptions.source = 'problematic-files';
    void confirmMissingAlbumRemoval(album, runtimeOptions);
    return;
  }
  const repairAlertDismiss = event.target.closest('[data-dismiss-repair-alert="1"]');
  if (repairAlertDismiss) {
    event.preventDefault();
    hideRepairAlert();
    return;
  }

  const openLogHistoryAlertButton = event.target.closest('[data-open-log-history-alert="1"]');
  if (openLogHistoryAlertButton) {
    event.preventDefault();
    const selectedLogHistoryId = openLogHistoryAlertButton.getAttribute('data-log-history-entry-id') || '';
    hideRepairAlert();
    openUtilityLogHistoryTab(selectedLogHistoryId);
    return;
  }
  if (!event.target.closest('.utility-loop-speed-control')) {
    document.querySelectorAll('.utility-loop-speed-menu').forEach((menu) => {
      menu.hidden = true;
    });
  }

  if (!event.target.closest('.utility-problem-filter, .utility-problem-filter-chips') && state.utility.problemDropdownOpen) {
    state.utility.problemDropdownOpen = false;
    renderProblemFilterControls(getUtilityModalElements());
  }
  if (
    !event.target.closest('#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox')
    && state.coverLookup.drawerOpen
  ) {
    state.coverLookup.drawerOpen = false;
    renderCoverLookupDrawer();
    stopCoverLookupPollingIfIdle();
  }
  const utilitiesButton = event.target.closest('[data-open-utilities="1"]');
  if (utilitiesButton) {
    event.preventDefault();
    openUtilityModal();
    return;
  }

  const utilityTabButton = event.target.closest('[data-utility-tab]');
  if (utilityTabButton) {
    event.preventDefault();
    const nextUtilityTab = utilityTabButton.getAttribute('data-utility-tab') || 'problematic-files';
    if (nextUtilityTab === state.utility.activeTab) return;
    setUtilityActiveTab(nextUtilityTab);
    if (state.utility.activeTab !== nextUtilityTab) return;
    if (state.utility.activeTab === 'rules') {
      loadUtilityRules(!state.utility.rulesLoaded);
    } else if (state.utility.activeTab === 'loops') {
      loadUtilityLoops(!state.utility.loopsLoaded);
    } else if (state.utility.activeTab === 'log-history') {
      loadUtilityLogHistory(!state.utility.logHistoryLoaded);
    } else if (state.utility.activeTab === 'integrations') {
      loadUtilityIntegrations(!state.utility.integrationsLoaded);
      if (!state.utility.selectedIntegrationKey || state.utility.selectedIntegrationKey === 'library') {
        loadUtilityLibrarySettings(!state.utility.librarySettings?.loaded);
      }
    } else if (state.utility.activeTab !== 'appearance') {
      loadProblematicFiles(!state.utility.loaded);
    }
    renderUtilityModalContent();
    return;
  }

  const utilityLogHistoryButton = event.target.closest('[data-utility-log-history-id]');
  const logAction = event.target.closest('[data-log-history-action]');
  if (utilityLogHistoryButton || logAction) {
    event.preventDefault();
    try {
      if (utilityLogHistoryButton) await selectUtilityLogHistoryEvent(utilityLogHistoryButton.getAttribute('data-utility-log-history-id'));
      else await handleUtilityLogHistoryAction(logAction.getAttribute('data-log-history-action'));
    } catch (error) { showToast(error.message || 'Unable to load log history.', 'error', 3200); }
    return;
  }

  const appearanceModeRadio = event.target.closest('[data-appearance-seekbar-mode]');
  if (appearanceModeRadio) {
    // The Appearance editor owns the draft and applies this only after Save.
    return;
  }

  const reconcileProblematicSelectionForFilters = (nextSelectedFilters) => {
    const selectedKey = String(state.utility.selectedProblematicKey || '');
    if (!selectedKey) return;
    const selectedAlbum = (state.utility.problematicFiles || []).find((album) => (
      String(album?.key || '') === selectedKey
    )) || null;
    if (selectedAlbum && albumMatchesProblemFilters(selectedAlbum, nextSelectedFilters)) {
      return;
    }
    state.utility.selectedProblematicKey = '';
  };

  const problemFilterToggle = event.target.closest('[data-toggle-problem-filter="1"]');
  if (problemFilterToggle) {
    event.preventDefault();
    if (state.utility.activeTab === 'log-history') { openUtilityLogHistoryQuery(false); return; }
    state.utility.problemDropdownOpen = !state.utility.problemDropdownOpen;
    renderUtilityModalContent();
    return;
  }

  const problemFilterOption = event.target.closest('[data-problem-filter-value]');
  if (problemFilterOption) {
    event.preventDefault();
    const value = problemFilterOption.getAttribute('data-problem-filter-value') || '';
    if (value) {
      const selected = state.utility.selectedProblemFilters || [];
      const nextSelectedFilters = selected.includes(value)
        ? selected.filter((reason) => reason !== value)
        : [...selected, value];
      state.utility.selectedProblemFilters = nextSelectedFilters;
      state.utility.deferProblematicAutoSelection = true;
      reconcileProblematicSelectionForFilters(nextSelectedFilters);
      state.utility.problemDropdownOpen = false;
      state.utility.showRepairedDisplay = true;
      renderUtilityModalContent();
      if (event.detail === 0) getUtilityModalElements().problemFilterButton?.focus();
    }
    return;
  }

  const removeProblemFilter = event.target.closest('[data-remove-problem-filter]');
  if (removeProblemFilter) {
    event.preventDefault();
    const value = removeProblemFilter.getAttribute('data-remove-problem-filter') || '';
    const nextSelectedFilters = (state.utility.selectedProblemFilters || []).filter((reason) => reason !== value);
    state.utility.selectedProblemFilters = nextSelectedFilters;
    state.utility.deferProblematicAutoSelection = true;
    reconcileProblematicSelectionForFilters(nextSelectedFilters);
    state.utility.problemDropdownOpen = false;
    state.utility.showRepairedDisplay = true;
    renderUtilityModalContent();
    return;
  }

  const problematicAlbumButton = event.target.closest('[data-problematic-album-key]');
  if (problematicAlbumButton) {
    event.preventDefault();
    const selectedKey = problematicAlbumButton.getAttribute('data-problematic-album-key') || '';
    if (state.utility.selectedProblematicKey === selectedKey && getSelectedProblematicAlbum()?.detail_loaded
        && !state.utility.focusedTrackPath && state.utility.showRepairedDisplay) return;
    state.utility.selectedProblematicKey = selectedKey;
    state.utility.focusedTrackPath = '';
    state.utility.proposalSelections = {};
    state.utility.deferProblematicAutoSelection = false;
    state.utility.showRepairedDisplay = true;
    state.utility.repairSelections = {};
    state.utility.problemExclusionSelections = {};
    state.utility.separateReleaseSelections = {};
    const selectedAlbum = getSelectedProblematicAlbum();
    if (selectedAlbum && !selectedAlbum.detail_loaded) {
      selectedAlbum.detail_load_failed = false;
      void loadProblematicAlbumDetail(state.utility.selectedProblematicKey, true);
    }
    renderUtilityModalContent({ preserveProblematicTree: true });
    return;
  }

  const utilityRuleButton = event.target.closest('[data-utility-rule-key]');
  if (utilityRuleButton) {
    event.preventDefault();
    const nextRuleKey = utilityRuleButton.getAttribute('data-utility-rule-key') || '';
    if (state.utility.selectedRuleKey === nextRuleKey) return;
    state.utility.selectedRuleKey = nextRuleKey;
    renderUtilityModalContent();
    return;
  }

  const utilityAppearanceButton = event.target.closest('[data-utility-appearance-key]');
  if (utilityAppearanceButton) {
    event.preventDefault();
    const nextAppearanceKey = utilityAppearanceButton.getAttribute('data-utility-appearance-key') || 'seekbar';
    if (nextAppearanceKey === state.utility.appearanceKey) return;
    const sharedAppearanceKeys = ['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'];
    const sharedAppearanceDraft = sharedAppearanceKeys.includes(state.utility.appearanceKey) && sharedAppearanceKeys.includes(nextAppearanceKey);
    if (nextAppearanceKey !== state.utility.appearanceKey && !sharedAppearanceDraft && typeof confirmBackgroundAppearanceLeave === 'function' && !confirmBackgroundAppearanceLeave(() => {
      state.utility.appearanceKey = nextAppearanceKey;
      renderUtilityModalContent();
    })) return;
    state.utility.appearanceKey = nextAppearanceKey;
    renderUtilityModalContent();
    return;
  }

  const utilityIntegrationButton = event.target.closest('[data-utility-integration-key]');
  if (utilityIntegrationButton) {
    event.preventDefault();
    const integrationKey = utilityIntegrationButton.getAttribute('data-utility-integration-key') || 'lastfm';
    if (state.utility.selectedIntegrationKey === integrationKey) return;
    const integrationHandled = handleLibrarySettingsIntegrationSelection(integrationKey);
    if (integrationHandled && typeof integrationHandled.then === 'function') {
      integrationHandled.then((handled) => {
        if (handled) return;
        state.utility.selectedIntegrationKey = integrationKey;
        renderUtilityModalContent();
      });
      return;
    }
    if (integrationHandled) {
      return;
    }
    state.utility.selectedIntegrationKey = integrationKey;
    renderUtilityModalContent();
    return;
  }

  if (handleLibrarySettingsClick(event)) {
    return;
  }

  const analyzeLocalPlaylistButton = event.target.closest('[data-analyze-local-playlist="1"]');
  if (analyzeLocalPlaylistButton) {
    event.preventDefault();
    await runLocalPlaylistImportAnalysis();
    return;
  }

  const saveLastfmButton = event.target.closest('[data-save-lastfm-integration="1"]');
  if (saveLastfmButton) {
    event.preventDefault();
    saveLastfmIntegration();
    return;
  }

  const saveLastfmTimeZoneButton = event.target.closest('[data-save-lastfm-timezone="1"]');
  if (saveLastfmTimeZoneButton) {
    event.preventDefault();
    saveLastfmTimeZone();
    return;
  }

  const disconnectLastfmButton = event.target.closest('[data-disconnect-lastfm-integration="1"]');
  if (disconnectLastfmButton) {
    event.preventDefault();
    disconnectLastfmIntegration();
    return;
  }

  const utilityLoopCollapseButton = event.target.closest('[data-utility-loop-collapse]');
  if (utilityLoopCollapseButton) {
    event.preventDefault();
    state.utility.lastLoopGroupClickKey = '';
    state.utility.lastLoopGroupClickAt = 0;
    toggleUtilityLoopGroupCollapse(utilityLoopCollapseButton.getAttribute('data-utility-loop-collapse') || '');
    return;
  }

  const utilityLoopItemButton = event.target.closest('[data-utility-loop-id]');
  if (utilityLoopItemButton) {
    event.preventDefault();
    state.utility.loopSuppressClick = false;
    return;
  }

  const utilityLoopButton = event.target.closest('[data-utility-loop-group-key]');
  if (utilityLoopButton) {
    event.preventDefault();
    if (state.utility.loopSuppressClick) {
      state.utility.loopSuppressClick = false;
      return;
    }
    const groupKey = utilityLoopButton.getAttribute('data-utility-loop-group-key') || '';
    const sameGroup = groupKey === String(state.utility.selectedLoopGroupKey || '');
    const now = Date.now();
    const isDoubleClickCandidate = String(state.utility.lastLoopGroupClickKey || '') === String(groupKey)
      && (now - Number(state.utility.lastLoopGroupClickAt || 0)) <= 350;
    state.utility.lastLoopGroupClickKey = groupKey;
    state.utility.lastLoopGroupClickAt = now;
    state.utility.selectedLoopGroupKey = groupKey;
    const selectedGroup = getSelectedUtilityLoopGroup();
    if (!sameGroup) state.utility.selectedLoopId = selectedGroup?.loops?.[0]?.id || state.utility.selectedLoopId || '';
    state.utility.selectedLoopDetailMode = 'group';
    if (isDoubleClickCandidate) {
      state.utility.lastLoopGroupClickKey = '';
      state.utility.lastLoopGroupClickAt = 0;
      toggleUtilityLoopGroupCollapse(groupKey);
      return;
    }
    if (!sameGroup) renderUtilityModalContent();
    return;
  }

  const utilityLoopRepeatButton = event.target.closest('[data-toggle-loop-repeat]');
  if (utilityLoopRepeatButton) {
    event.preventDefault();
    const loopId = utilityLoopRepeatButton.getAttribute('data-toggle-loop-repeat') || '';
    if (loopId && String(state.utility.selectedLoopId || '') !== String(loopId)) {
      const nextLoop = (state.utility.loops || []).find((item) => String(item?.id || '') === String(loopId)) || null;
      state.utility.selectedLoopId = loopId;
      state.utility.selectedLoopGroupKey = nextLoop ? buildUtilityLoopGroupKey(nextLoop) : state.utility.selectedLoopGroupKey;
      state.utility.selectedLoopDetailMode = 'loop';
    }
    state.utility.loopRepeatEnabled = !state.utility.loopRepeatEnabled;
    updateUtilityLoopRepeatButton(loopId);
    return;
  }

  const utilityLoopSpeedValueButton = event.target.closest('[data-loop-speed-value-button]');
  if (utilityLoopSpeedValueButton) {
    event.preventDefault();
    const loopId = utilityLoopSpeedValueButton.getAttribute('data-loop-speed-value-button') || '';
    const menu = document.querySelector(`[data-loop-speed-menu="${cssEscape(loopId)}"]`);
    if (menu) {
      updateUtilityLoopAudioRate(loopId);
      const willOpen = menu.hidden;
      document.querySelectorAll('.utility-loop-speed-menu').forEach((item) => {
        item.hidden = true;
        item.style.visibility = '';
      });
      menu.hidden = !willOpen;
      if (willOpen) positionUtilityLoopSpeedMenu(loopId);
    }
    return;
  }

  const utilityLoopSpeedStepButton = event.target.closest('[data-loop-speed-step]');
  if (utilityLoopSpeedStepButton) {
    event.preventDefault();
    const control = utilityLoopSpeedStepButton.closest('[data-loop-speed-control]');
    const loopId = control?.getAttribute('data-loop-speed-control') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const current = Number(audio.dataset.speed || '1') || 1;
      const delta = Number(utilityLoopSpeedStepButton.getAttribute('data-loop-speed-step') || 0) || 0;
      const next = Math.max(0.25, Math.min(2, Math.round((current + delta) * 20) / 20));
      audio.dataset.speed = String(next);
      updateUtilityLoopAudioRate(loopId);
    }
    return;
  }

  const utilityLoopSpeedOptionButton = event.target.closest('[data-loop-speed-option]');
  if (utilityLoopSpeedOptionButton) {
    event.preventDefault();
    const menu = utilityLoopSpeedOptionButton.closest('[data-loop-speed-menu]');
    const loopId = menu?.getAttribute('data-loop-speed-menu') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const next = Math.max(0.25, Math.min(1.5, Math.round((Number(utilityLoopSpeedOptionButton.getAttribute('data-loop-speed-option') || 1) || 1) * 4) / 4));
      audio.dataset.speed = String(next);
      updateUtilityLoopAudioRate(loopId);
    }
    if (menu) menu.hidden = true;
    return;
  }

  const utilityLoopPitchButton = event.target.closest('[data-loop-pitch-step]');
  if (utilityLoopPitchButton) {
    event.preventDefault();
    const control = utilityLoopPitchButton.closest('[data-loop-pitch-control]');
    const loopId = control?.getAttribute('data-loop-pitch-control') || '';
    const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
    if (audio) {
      const next = Math.max(-12, Math.min(12, (Number(audio.dataset.pitch || '0') || 0) + Number(utilityLoopPitchButton.getAttribute('data-loop-pitch-step') || 0)));
      renderUtilityLoopPitchPreview(loopId, next);
    }
    return;
  }

  const savedLoopAction = event.target.closest('[data-loop-action-owner^="saved-loop-"] [data-loop-action]');
  if (savedLoopAction) {
    const actionRoot = savedLoopAction.closest('[data-loop-action-owner^="saved-loop-"]');
    if (actionRoot?.dataset.loopActionsBound === '1') return;
    event.preventDefault();
    const loopId = String(actionRoot?.getAttribute('data-loop-action-owner') || '').replace(/^saved-loop-/, '');
    mountSavedLoopControls(loopId);
    const action = savedLoopAction.getAttribute('data-loop-action');
    if (action === 'cancel') cancelSavedLoopCreation(loopId);
    else if (action === 'create') createLoopFromSavedLoop(loopId);
    else openSavedLoopCreation(loopId);
    return;
  }

  const deleteSavedLoopButton = event.target.closest('[data-delete-saved-loop]');
  if (deleteSavedLoopButton) {
    event.preventDefault();
    openSavedLoopDeleteConfirm(deleteSavedLoopButton.getAttribute('data-delete-saved-loop') || '');
    return;
  }

  const revertVersionExceptionButton = event.target.closest('[data-revert-version-exception]');
  if (revertVersionExceptionButton) {
    event.preventDefault();
    openRuleRevertConfirm({ kind: 'version-exception', key: revertVersionExceptionButton.getAttribute('data-revert-version-exception') || '' });
    return;
  }

  const revertProblemIgnoreButton = event.target.closest('[data-revert-problem-ignore]');
  if (revertProblemIgnoreButton) {
    event.preventDefault();
    const rowKey = revertProblemIgnoreButton.getAttribute('data-revert-problem-ignore') || '';
    const problemRule = (state.utility.rules || []).find((rule) => rule?.key === 'problem-ignores');
    const ruleItem = [
      ...(Array.isArray(problemRule?.items) ? problemRule.items : []),
      ...(Array.isArray(problemRule?.album_items) ? problemRule.album_items : []),
      ...(Array.isArray(problemRule?.file_items) ? problemRule.file_items : []),
    ].find((item) => String(item?.row_key || '') === rowKey);
    if (ruleItem && !ruleItem.pending) openRuleRevertConfirm({ kind: 'problem-exclusion', key: rowKey, item: ruleItem });
    return;
  }

  const problematicOpenButton = event.target.closest('[data-open-problematic-album-folder="1"]');
  if (problematicOpenButton) {
    event.preventDefault();
    openAlbumInExplorer(getSelectedProblematicAlbum());
    return;
  }

  const tagEditorOpenButton = event.target.closest('[data-open-tag-editor="1"]');
  if (tagEditorOpenButton) {
    event.preventDefault();
    openTagEditor(getSelectedProblematicAlbum());
    return;
  }

  const discogsButton = event.target.closest('[data-find-on-discogs="1"]');
  if (discogsButton) {
    event.preventDefault();
    openAlbumOnDiscogs(getSelectedProblematicAlbum());
    return;
  }

  const fetchCoverButton = event.target.closest('[data-fetch-problematic-cover="1"]');
  if (fetchCoverButton) {
    event.preventDefault();
    fetchCoverForProblematicAlbum(getSelectedProblematicAlbum());
    return;
  }

  const moveProblematicAlbumButton = event.target.closest('[data-move-problematic-album]');
  if (moveProblematicAlbumButton) {
    event.preventDefault();
    performAlbumMove(
      getSelectedProblematicAlbum(),
      moveProblematicAlbumButton.getAttribute('data-move-problematic-album') || '',
    );
    return;
  }

  const tagEditorTrackButton = event.target.closest('[data-tag-editor-track]');
  if (tagEditorTrackButton) {
    event.preventDefault();
    return;
  }

  const tagEditorAutoNumberButton = event.target.closest('[data-auto-number-selected="1"]');
  if (tagEditorAutoNumberButton) {
    event.preventDefault();
    if (!tagEditorAutoNumberButton.disabled) {
      autoNumberSelectedTagEditorTracks();
    }
    return;
  }

  const tagEditorCloseButton = event.target.closest('[data-close-tag-editor="1"]');
  if (tagEditorCloseButton) {
    event.preventDefault();
    closeTagEditor();
    return;
  }

  const tagEditorOverlay = document.getElementById?.('tag-editor-modal');
  if (tagEditorOverlay && overlayClickStartedOnOverlay(tagEditorOverlay, event)) {
    const changedUpdates = buildChangedTagEditorUpdates(
      state.tagEditor.album,
      state.tagEditor.tracks || [],
      state.tagEditor.values || {},
    );
    if (!Object.keys(changedUpdates).length) {
      closeTagEditor();
    }
    return;
  }

  const tagEditConfirmOpenButton = event.target.closest('[data-open-tag-edit-confirm="1"]');
  if (tagEditConfirmOpenButton) {
    event.preventDefault();
    openTagEditConfirmModal();
    return;
  }

  const tagEditConfirmCloseButton = event.target.closest('[data-close-tag-edit-confirm="1"]');
  if (tagEditConfirmCloseButton) {
    event.preventDefault();
    closeTagEditConfirmModal();
    return;
  }

  const tagEditConfirmButton = event.target.closest('[data-confirm-tag-edit="1"]');
  if (tagEditConfirmButton) {
    event.preventDefault();
    confirmManualTagEdit();
    return;
  }

  const displayRepairToggle = event.target.closest('[data-toggle-problematic-display-repair="1"]');
  if (displayRepairToggle) {
    event.preventDefault();
    state.utility.showRepairedDisplay = !state.utility.showRepairedDisplay;
    renderUtilityModalContent();
    return;
  }

  const utilitySectionToggle = event.target.closest('[data-utility-section-toggle]');
  if (utilitySectionToggle) {
    event.preventDefault();
    const sectionKey = utilitySectionToggle.getAttribute('data-utility-section-toggle') || '';
    if (sectionKey) {
      state.utility.collapsedSections[sectionKey] = !Boolean(state.utility.collapsedSections[sectionKey]);
      renderUtilityModalContent();
    }
    return;
  }

  const albumProblem = event.target.closest('[data-album-problem-type]');
  if (albumProblem) {
    event.preventDefault();
    if (albumProblem.disabled) return;
    const type = albumProblem.getAttribute('data-album-problem-type');
    const keys = getIgnorableProblemRows(getSelectedProblematicAlbum()).filter(item => normalizeProblemFilterReason(item.reason) === type).map(item => item.row_key);
    const enabled = !keys.every(key => state.utility.problemExclusionSelections?.[key]);
    const selected = { ...(state.utility.problemExclusionSelections || {}) };
    keys.forEach(key => { if (enabled) selected[key] = true; else delete selected[key]; });
    state.utility.problemExclusionSelections = selected;
    syncProblemExclusionSelection();
    return;
  }
  const suggestion = event.target.closest('[data-problem-suggestion-id]');
  if (suggestion) {
    event.preventDefault();
    if (state.utility.proposalSuppressClick) { state.utility.proposalSuppressClick = false; return; }
    if (!suggestion.disabled) toggleProblemSuggestion(suggestion.getAttribute('data-problem-suggestion-id'));
    syncProblemSuggestionSelection();
    return;
  }
  const repairChoiceButton = event.target.closest('[data-repair-choice]');
  if (repairChoiceButton) {
    event.preventDefault();
    const choice = repairChoiceButton.getAttribute('data-repair-choice') || 'repair';
    if (state.utility.repairSuppressClick) {
      state.utility.repairSuppressClick = false;
      return;
    }
    const rowKeys = getRepairRowKeysFromButton(repairChoiceButton);
    if (rowKeys.length) {
      const isNotProblemToggle = repairChoiceButton.classList.contains('utility-problem-not-problem');
      const allAlreadySelected = rowKeys.every((key) => state.utility.repairSelections[key] === choice);
      rowKeys.forEach((key) => {
        state.utility.repairSelections[key] = isNotProblemToggle && allAlreadySelected ? '' : choice;
      });
      renderUtilityModalContent();
    }
    return;
  }

  const problemExclusionPill = event.target.closest('[data-problem-exclusion-row-key]');
  if (problemExclusionPill) {
    event.preventDefault();
    const rowKey = problemExclusionPill.getAttribute('data-problem-exclusion-row-key') || '';
    if (state.utility.problemExclusionSuppressClick) {
      state.utility.problemExclusionSuppressClick = false;
      const clearOnClick = Boolean(state.utility.problemExclusionClearOnClick);
      state.utility.problemExclusionClearOnClick = false;
      if (clearOnClick) {
        selectProblemExclusion(rowKey);
        renderUtilityModalContentAndRestoreProblemExclusionFocus(rowKey);
      }
      return;
    }
    selectProblemExclusion(rowKey);
    renderUtilityModalContentAndRestoreProblemExclusionFocus(rowKey);
    return;
  }

  const separateReleaseCheckbox = event.target.closest('[data-separate-release-key]');
  if (separateReleaseCheckbox) {
    const key = separateReleaseCheckbox.getAttribute('data-separate-release-key') || '';
    if (key) {
      state.utility.separateReleaseSelections[key] = Boolean(separateReleaseCheckbox.checked);
      renderUtilityModalContent();
    }
    return;
  }

  const applySuggestions = event.target.closest('[data-apply-problem-suggestions]');
  if (applySuggestions) { event.preventDefault(); if (!applySuggestions.disabled) openProblemSuggestionsConfirm(); return; }

  const repairOpenButton = event.target.closest('[data-open-repair-confirm="1"]');
  if (repairOpenButton) {
    event.preventDefault();
    const album = getSelectedProblematicAlbum();
    if (!album) {
      showToast('No album selected for repair.', 'error', 3200);
      return;
    }
    state.utility.pendingRepairKey = album.key || '';
    state.utility.pendingRepairAction = repairOpenButton.getAttribute('data-repair-action') || 'repair';
    openRepairConfirmModal();
    return;
  }

  const exclusionOpenButton = event.target.closest('[data-open-exclusion-confirm="1"]');
  if (exclusionOpenButton) {
    event.preventDefault();
    const album = getSelectedProblematicAlbum();
    if (!album || !getIgnoredRepairRowKeys().length) return;
    state.utility.pendingRepairKey = album.key || '';
    state.utility.pendingRepairAction = 'detected';
    openRepairConfirmModal();
    return;
  }

  const separateReleaseOpenButton = event.target.closest('[data-open-separate-release-confirm="1"]');
  if (separateReleaseOpenButton) {
    event.preventDefault();
    const album = getSelectedProblematicAlbum();
    if (!album || !getSelectedSeparateReleaseKeys().length) return;
    state.utility.pendingRepairKey = album.key || '';
    state.utility.pendingRepairAction = 'separate-release';
    openRepairConfirmModal();
    return;
  }

  const repairConfirmButton = event.target.closest('[data-confirm-repair="1"]');
  if (repairConfirmButton) {
    event.preventDefault();
    confirmRepairSelectedAlbum();
    return;
  }

  const trackModalCoverLookupButton = event.target.closest('[data-open-track-modal-cover-lookup="1"]');
  if (trackModalCoverLookupButton) {
    event.preventDefault();
    openCoverLookupModal(resolveTrackModalActionAlbum(trackModalCoverLookupButton));
    return;
  }

  const trackModalFetchCoverButton = event.target.closest('[data-track-modal-fast-cover-fetch="1"], [data-open-track-modal-fetch-cover="1"]');
  if (trackModalFetchCoverButton) {
    event.preventDefault();
    startCoverLookupForAlbum(resolveTrackModalActionAlbum(trackModalFetchCoverButton), { backgroundOnly: true });
    return;
  }

  const toggleCoverLookupDrawerButton = event.target.closest('[data-toggle-cover-lookup-drawer="1"]');
  if (toggleCoverLookupDrawerButton) {
    event.preventDefault();
    state.coverLookup.drawerOpen = !state.coverLookup.drawerOpen;
    ensureCoverLookupPolling();
    loadCoverLookupTasks({ toast: false });
    renderCoverLookupDrawer();
    return;
  }

  if (event.target.closest('[data-close-cover-lookup-drawer="1"]')) {
    event.preventDefault();
    state.coverLookup.drawerOpen = false;
    renderCoverLookupDrawer();
    return;
  }

  if (event.target.closest('[data-clear-cover-lookup-completed="1"]')) {
    event.preventDefault();
    clearCompletedCoverLookupTasks();
    return;
  }

  const clearCoverLookupTaskButton = event.target.closest('[data-clear-cover-lookup-task]');
  if (clearCoverLookupTaskButton) {
    event.preventDefault();
    event.stopPropagation();
    const taskId = clearCoverLookupTaskButton.getAttribute('data-clear-cover-lookup-task') || '';
    clearCoverLookupTaskNotification(taskId);
    return;
  }

  const openCoverLookupTaskButton = event.target.closest('[data-open-cover-lookup-task]');
  if (openCoverLookupTaskButton) {
    const taskId = openCoverLookupTaskButton.getAttribute('data-open-cover-lookup-task') || '';
    const suppressTaskId = String(state.coverLookup.suppressOpenTaskId || '');
    state.coverLookup.suppressOpenTaskId = '';
    if (event.detail !== 0 && suppressTaskId && suppressTaskId === String(taskId)) {
      return;
    }
    event.preventDefault();
    const task = (state.coverLookup.tasks || []).find((item) => String(item?.id || '') === String(taskId));
    if (task?.album_payload) {
      state.coverLookup.drawerOpen = false;
      renderCoverLookupDrawer();
      openCoverLookupModal(task.album_payload, { taskId });
    }
    return;
  }

  const cancelCoverLookupTaskButton = event.target.closest('[data-cancel-cover-lookup-task]');
  if (cancelCoverLookupTaskButton) {
    event.preventDefault();
    const taskId = cancelCoverLookupTaskButton.getAttribute('data-cancel-cover-lookup-task') || '';
    state.coverLookup.tasks = (state.coverLookup.tasks || []).map((task) => (
      String(task?.id || '') === String(taskId)
        ? {
          ...task,
          cancel_requested: true,
          progress_label: 'Canceling...',
          message: 'Cancel requested. Finishing the current step...',
        }
        : task
    ));
    renderCoverLookupDrawer();
    fetch(`/utilities/cover-lookup/task/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).finally(() => loadCoverLookupTasks({ toast: false }));
    return;
  }

  if (event.target.closest('[data-close-cover-lookup-modal="1"]')) {
    event.preventDefault();
    closeCoverLookupModal();
    return;
  }

  if (event.target.closest('[data-start-cover-lookup="1"]')) {
    event.preventDefault();
    startCoverLookupForAlbum(state.coverLookup.modal.album);
    return;
  }

  if (event.target.closest('[data-save-cover-lookup-remote="1"]')) {
    event.preventDefault();
    saveCoverFromLookup();
    return;
  }

  if (event.target.closest('[data-add-cover-lookup-remote="1"]')) {
    event.preventDefault();
    addRemoteCoverLinksFromLookup();
    return;
  }

  const coverLookupExternalButton = event.target.closest('[data-open-cover-lookup-external="1"]');
  if (coverLookupExternalButton) {
    event.preventDefault();
    event.stopPropagation();
    const href = String(coverLookupExternalButton.getAttribute('data-cover-link') || '').trim();
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }

  const coverLookupLightboxButton = event.target.closest('[data-cover-lookup-open-lightbox="1"]');
  if (coverLookupLightboxButton) {
    event.preventDefault();
    event.stopPropagation();
    openImageLightbox(
      coverLookupLightboxButton.getAttribute('data-cover-src'),
      coverLookupLightboxButton.getAttribute('data-cover-alt'),
    );
    return;
  }

  const selectLocalCoverButton = event.target.closest('[data-select-local-cover]');
  if (selectLocalCoverButton && !event.target.closest('[data-delete-local-cover]')) {
    event.preventDefault();
    const sourcePath = selectLocalCoverButton.getAttribute('data-select-local-cover') || '';
    selectLocalCoverFromLookup(sourcePath);
    return;
  }

  const selectPastedCoverButton = event.target.closest('[data-select-pasted-cover]');
  if (selectPastedCoverButton) {
    event.preventDefault();
    const imageId = selectPastedCoverButton.getAttribute('data-select-pasted-cover') || '';
    selectPastedCoverFromLookup(imageId);
    return;
  }

  const deleteLocalCoverButton = event.target.closest('[data-delete-local-cover]');
  if (deleteLocalCoverButton) {
    event.preventDefault();
    openCoverLookupDeleteConfirm(deleteLocalCoverButton.getAttribute('data-delete-local-cover') || '');
    return;
  }

  if (event.target.closest('[data-confirm-cover-lookup-delete="1"]')) {
    event.preventDefault();
    deleteLocalCoverFromLookup(state.coverLookup.modal.pendingDeletePath || '');
    return;
  }

  if (event.target.closest('[data-close-cover-lookup-delete-confirm="1"]')) {
    event.preventDefault();
    closeCoverLookupDeleteConfirm();
    return;
  }

  const selectRemoteCoverButton = event.target.closest('[data-select-remote-cover]');
  if (selectRemoteCoverButton) {
    event.preventDefault();
    const candidateId = selectRemoteCoverButton.getAttribute('data-select-remote-cover') || '';
    selectRemoteCoverFromLookup(candidateId);
    return;
  }

  const trackProblematicButton = event.target.closest('[data-open-track-problematic="1"]');
  if (trackProblematicButton) {
    event.preventDefault();
    openUtilityModalForTrack(trackProblematicButton.getAttribute('data-track-path') || '');
    return;
  }

  return false;
}

function renderUtilityModalContentAndRestoreProblemExclusionFocus(rowKey) {
  const normalizedRowKey = String(rowKey || '');
  syncProblemExclusionSelection();
  if (!normalizedRowKey || typeof document === 'undefined') return;
  const matchingPill = Array.from(
    document.querySelectorAll?.('[data-problem-exclusion-row-key]') || [],
  ).find((pill) => (
    String(pill.getAttribute?.('data-problem-exclusion-row-key') || '') === normalizedRowKey
  ));
  if (matchingPill) {
    matchingPill.focus?.();
    return;
  }
  const escapedRowKey = normalizedRowKey
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  document.querySelector?.(
    `[data-problem-exclusion-row-key="${escapedRowKey}"]`,
  )?.focus?.();
}

function handleUtilityBootstrapInput(event) {
  const localPlaylistFileInput = event.target.closest('[data-local-playlist-import-file]');
  if (localPlaylistFileInput) {
    const file = Array.isArray(localPlaylistFileInput.files)
      ? (localPlaylistFileInput.files[0] || null)
      : (localPlaylistFileInput.files?.[0] || null);
    handleLocalPlaylistImportFileSelection(file);
    return;
  }
  const lastfmInput = event.target.closest('[data-lastfm-field]');
  if (lastfmInput) {
    const field = lastfmInput.getAttribute('data-lastfm-field') || '';
    if (field) {
      state.utility.integrationDrafts.lastfm = {
        ...(state.utility.integrationDrafts.lastfm || { username: '', password: '', timezone: '' }),
        [field]: String(lastfmInput.value || ''),
      };
      if (field === 'timezone') {
        markLastfmTimeZoneDraftDirty();
        renderUtilityModalContent();
      }
    }
    return;
  }
  const manualCoverLookupInput = event.target.closest('#cover-lookup-pasted-urls');
  if (manualCoverLookupInput) {
    state.coverLookup.modal.manualUrlText = String(manualCoverLookupInput.value || '');
    syncCoverLookupManualControlsUi();
    return;
  }
  if (handleLibrarySettingsInput(event)) {
    return;
  }
  const autoNumberStartInput = event.target.closest('#tag-editor-auto-number-start');
  if (autoNumberStartInput) {
    state.tagEditor.autoNumberStartValue = String(autoNumberStartInput.value || '');
    return;
  }
  const input = event.target.closest('#tag-editor-form [data-tag-field]');
  if (!input) return;
  const field = input.getAttribute('data-tag-field') || '';
  if (!field) return;
  const selectedPaths = getSelectedTagEditorPaths(state.tagEditor.tracks || []);
  if (!selectedPaths.length) return;
  selectedPaths.forEach((path) => {
    state.tagEditor.values[path] = {
      ...(state.tagEditor.values[path] || {}),
      [field]: input.value,
    };
  });
  syncTagEditorPendingChanges();
}

function handleUtilityBootstrapSubmit(event) {
  const lastfmForm = event.target.closest('[data-lastfm-integration-form="1"]');
  if (!lastfmForm) return;
  event.preventDefault();
  const submitButton = lastfmForm.querySelector('[data-save-lastfm-integration="1"]');
  if (submitButton instanceof HTMLButtonElement && submitButton.disabled) {
    return;
  }
  saveLastfmIntegration();
}

async function handleUtilityBootstrapPaste(event) {
  const coverLookupModal = document.getElementById('cover-lookup-modal');
  if (!coverLookupModal || coverLookupModal.hidden) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('#cover-lookup-modal')) {
    return;
  }
  try {
    const clipboardItems = Array.from(event.clipboardData?.items || []);
    const hasImageItem = clipboardItems.some((item) => String(item?.type || '').startsWith('image/'));
    if (hasImageItem) {
      event.preventDefault();
    }
    const handled = await handleCoverLookupClipboardPaste(event.clipboardData);
    if (!handled && hasImageItem) {
      showToast('Clipboard image could not be read.', 'error', 2800);
    }
  } catch (error) {
    console.error('[AlbumHaven][CoverLookup] Failed to paste clipboard image.', error);
    showToast(error.message || 'Failed to paste clipboard image.', 'error', 2800);
  }
}

function handleUtilityBootstrapChange(event) {
  if (handleLibrarySettingsChange(event)) {
    return;
  }
  const input = event.target.closest('#tag-editor-form select[data-tag-field]');
  if (!input) return;
  const field = input.getAttribute('data-tag-field') || '';
  if (!field) return;
  const selectedPaths = getSelectedTagEditorPaths(state.tagEditor.tracks || []);
  selectedPaths.forEach((path) => {
    state.tagEditor.values[path] = {
      ...(state.tagEditor.values[path] || {}),
      [field]: input.value,
    };
  });
  syncTagEditorPendingChanges();
}

function getCoverLookupSelectionSignature() {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null;
  const selection = window.getSelection();
  if (!selection) return null;
  return {
    anchorNode: selection.anchorNode || null,
    anchorOffset: Number(selection.anchorOffset || 0),
    focusNode: selection.focusNode || null,
    focusOffset: Number(selection.focusOffset || 0),
    isCollapsed: Boolean(selection.isCollapsed),
    text: String(selection),
  };
}

function coverLookupSelectionChanged(before, after) {
  if (!before || !after) return before !== after;
  return before.anchorNode !== after.anchorNode
    || before.anchorOffset !== after.anchorOffset
    || before.focusNode !== after.focusNode
    || before.focusOffset !== after.focusOffset
    || before.isCollapsed !== after.isCollapsed
    || before.text !== after.text;
}

function handleUtilityBootstrapMouseDown(event) {
  const suggestion = event.target.closest('[data-problem-suggestion-id]');
  if (suggestion && event.button === 0 && !suggestion.disabled) {
    event.preventDefault();
    const id = suggestion.getAttribute('data-problem-suggestion-id');
    const visible = getVisibleProblemSuggestions();
    const index = visible.findIndex(item => item.id === id);
    if (index < 0) return;
    const selected = !state.utility.proposalSelections?.[id];
    state.utility.proposalDrag = { type: visible[index].type, startIndex: index, selected };
    state.utility.proposalSuppressClick = true;
    toggleProblemSuggestion(id, { selected });
    suggestion.focus?.();
    syncProblemSuggestionSelection();
    return;
  }
  const coverLookupTaskButton = event.target.closest('[data-open-cover-lookup-task]');
  state.coverLookup.taskOpenSelectionGesture = coverLookupTaskButton && event.button === 0
    ? {
      button: coverLookupTaskButton,
      taskId: String(coverLookupTaskButton.getAttribute('data-open-cover-lookup-task') || ''),
      startX: Number(event.clientX || 0),
      startY: Number(event.clientY || 0),
      selectionSignature: getCoverLookupSelectionSignature(),
    }
    : null;

  const repairChoiceButton = event.target.closest('[data-repair-choice]');
  if (repairChoiceButton && event.button === 0) {
    event.preventDefault();
    const choice = repairChoiceButton.getAttribute('data-repair-choice') || 'repair';
    const rowKeys = getRepairRowKeysFromButton(repairChoiceButton);
    const isNotProblemToggle = repairChoiceButton.classList.contains('utility-problem-not-problem');
    const allAlreadySelected = rowKeys.length && rowKeys.every((key) => state.utility.repairSelections[key] === choice);
    const nextChoice = isNotProblemToggle && allAlreadySelected ? '' : choice;
    if (applyRepairChoice(repairChoiceButton, nextChoice)) {
      state.utility.repairDragActive = true;
      state.utility.repairDragChoice = nextChoice;
      state.utility.repairDragClearOnClick = Boolean(isNotProblemToggle && allAlreadySelected);
      state.utility.repairSuppressClick = true;
      renderUtilityModalContent();
    }
    return;
  }

  const problemExclusionPill = event.target.closest('[data-problem-exclusion-row-key]');
  if (problemExclusionPill && event.button === 0) {
    event.preventDefault();
    const rowKey = problemExclusionPill.getAttribute('data-problem-exclusion-row-key') || '';
    const scope = problemExclusionPill.getAttribute('data-problem-exclusion-scope') || '';
    const reason = problemExclusionPill.getAttribute('data-problem-exclusion-reason') || '';
    const rowIndex = Number(problemExclusionPill.getAttribute('data-problem-exclusion-row-index'));
    const alreadySelected = Boolean(
      rowKey && state.utility.problemExclusionSelections?.[rowKey],
    );
    state.utility.problemExclusionClearOnClick = alreadySelected;
    if (!alreadySelected) {
      selectProblemExclusion(rowKey, { toggle: false });
    }
    state.utility.problemExclusionDrag = scope === 'file' && Number.isInteger(rowIndex)
      ? { reason, startIndex: rowIndex, lastIndex: rowIndex }
      : null;
    state.utility.problemExclusionSuppressClick = true;
    if (!alreadySelected) {
      renderUtilityModalContentAndRestoreProblemExclusionFocus(rowKey);
    }
    return;
  }

  const trackButton = event.target.closest('[data-tag-editor-track]');
  if (!trackButton || event.button !== 0) return;
  event.preventDefault();
  const path = trackButton.getAttribute('data-tag-editor-track') || '';
  selectTagEditorTrack(path, event);
  if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
    state.tagEditor.dragSelecting = true;
    state.tagEditor.dragAnchorPath = path;
  }
  renderTagEditor({ preserveTrackList: true });
  syncTagEditorAutoNumberControls();
}

function handleUtilityBootstrapKeyDown(event) {
  if (
    !event
    || event.defaultPrevented
    || event.altKey
    || event.ctrlKey
    || event.metaKey
  ) {
    return false;
  }
  const collapse = event.target?.closest?.('[data-utility-loop-collapse]');
  if (collapse && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation?.();
    return toggleUtilityLoopGroupCollapse(collapse.getAttribute('data-utility-loop-collapse'));
  }
  const tab = event.target?.closest?.('[data-utility-tab]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = getUtilityModalElements().tabs.filter(item => !item.disabled && !item.hidden);
    const current = tabs.indexOf(tab);
    if (current < 0 || !tabs.length) return false;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
    tabs[next].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  const filterTarget = event.target?.closest?.('#utility-problem-filter-button, #utility-problem-filter-menu');
  const filterInput = event.target?.matches?.('input, textarea, [contenteditable="true"]');
  if (state.utility.activeTab === 'problematic-files' && filterTarget && !filterInput) {
    const els = getUtilityModalElements();
    if (event.key === 'Escape' && state.utility.problemDropdownOpen) {
      event.preventDefault();
      event.stopPropagation?.();
      state.utility.problemDropdownOpen = false;
      els.problemFilterMenu.hidden = true;
      els.problemFilterButton.setAttribute('aria-expanded', 'false');
      if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(els.problemFilterMenu);
      els.problemFilterButton.focus();
      return true;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !els.problemFilterButton.disabled) {
      event.preventDefault();
      if (!state.utility.problemDropdownOpen) {
        state.utility.problemDropdownOpen = true;
        renderProblemFilterControls(els);
      }
      const options = Array.from(els.problemFilterMenu.querySelectorAll?.('[data-problem-filter-value]') || []);
      const current = options.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : current < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
      return true;
    }
  }
  if (typeof handleSavedLoopEditKeydown === 'function' && handleSavedLoopEditKeydown(event)) {
    return true;
  }
  const coverLookupTaskButton = event.target?.closest?.('[data-open-cover-lookup-task]') || null;
  if (!coverLookupTaskButton) return false;
  const isActivationKey = event.key === 'Enter'
    || event.key === ' '
    || event.key === 'Spacebar'
    || event.code === 'Space';
  if (!isActivationKey) return false;
  event.preventDefault();
  coverLookupTaskButton.click();
  return true;
}

function handleUtilityBootstrapMouseOver(event) {
  if (state.utility.proposalDrag) {
    const suggestion = event.target.closest('[data-problem-suggestion-id]');
    const drag = state.utility.proposalDrag;
    const visible = getVisibleProblemSuggestions();
    const index = visible.findIndex(item => item.id === suggestion?.getAttribute('data-problem-suggestion-id'));
    if (index >= 0 && visible[index].type === drag.type) {
      extendProblemSuggestionRange(drag.type, drag.startIndex, index, drag.selected);
      syncProblemSuggestionSelection();
    }
    return;
  }
  if (state.utility.problemExclusionDrag) {
    const pill = event.target.closest('[data-problem-exclusion-scope="file"]');
    if (!pill) return true;
    const drag = state.utility.problemExclusionDrag;
    const reason = pill.getAttribute('data-problem-exclusion-reason') || '';
    const rowIndex = Number(pill.getAttribute('data-problem-exclusion-row-index'));
    if (Number.isInteger(rowIndex) && rowIndex !== drag.lastIndex) {
      state.utility.problemExclusionClearOnClick = false;
    }
    if (normalizeProblemFilterReason(reason) !== normalizeProblemFilterReason(drag.reason) || !Number.isInteger(rowIndex)) return true;
    if (rowIndex === drag.lastIndex) return true;
    if (extendProblemExclusionRange(reason, drag.startIndex, rowIndex)) {
      drag.lastIndex = rowIndex;
      syncProblemExclusionSelection();
    }
    return true;
  }
  if (state.utility.repairDragActive) {
    const repairChoiceButton = event.target.closest('[data-repair-choice]');
    if (!repairChoiceButton) return true;
    const isNotProblemToggle = repairChoiceButton.classList.contains('utility-problem-not-problem');
    const nextChoice = state.utility.repairDragClearOnClick && isNotProblemToggle
      ? ''
      : state.utility.repairDragChoice;
    if (applyRepairChoice(repairChoiceButton, nextChoice)) {
      renderUtilityModalContent();
    }
    return true;
  }

  if (!state.tagEditor.dragSelecting) return false;
  const trackButton = event.target.closest('[data-tag-editor-track]');
  if (!trackButton) return false;
  const path = trackButton.getAttribute('data-tag-editor-track') || '';
  const rangePaths = getTagEditorRangePaths(state.tagEditor.dragAnchorPath, path);
  setTagEditorSelectedPaths(rangePaths, state.tagEditor.dragAnchorPath);
  renderTagEditor({ preserveTrackList: true });
  syncTagEditorAutoNumberControls();
  return true;
}

function handleUtilityBootstrapMouseUp(event) {
  state.utility.proposalDrag = null;
  if (state.utility.proposalSuppressClick) setTimeout(() => { state.utility.proposalSuppressClick = false; }, 0);
  const selectionGesture = state.coverLookup.taskOpenSelectionGesture;
  state.coverLookup.taskOpenSelectionGesture = null;
  state.coverLookup.suppressOpenTaskId = '';
  const dragDistance = selectionGesture
    ? Math.hypot(
      Number(event?.clientX || 0) - Number(selectionGesture.startX || 0),
      Number(event?.clientY || 0) - Number(selectionGesture.startY || 0),
    )
    : 0;
  const mouseUpTaskButton = event?.target?.closest?.('[data-open-cover-lookup-task]') || null;
  const selection = selectionGesture
    && selectionGesture.button === mouseUpTaskButton
    && typeof window !== 'undefined'
    && typeof window.getSelection === 'function'
    ? window.getSelection()
    : null;
  const selectionTouchesTask = selection
    && !selection.isCollapsed
    && String(selection).trim()
    && typeof selectionGesture.button?.contains === 'function'
    && (
      selectionGesture.button.contains(selection.anchorNode)
      || selectionGesture.button.contains(selection.focusNode)
    );
  const selectionChanged = selectionTouchesTask && coverLookupSelectionChanged(
    selectionGesture?.selectionSignature || null,
    getCoverLookupSelectionSignature(),
  );
  if ((selectionChanged || dragDistance >= 4) && selectionGesture?.taskId) {
    const suppressTaskId = String(selectionGesture.taskId);
    state.coverLookup.suppressOpenTaskId = suppressTaskId;
    scheduleBrowserTimeout(() => {
      if (String(state.coverLookup.suppressOpenTaskId || '') === suppressTaskId) {
        state.coverLookup.suppressOpenTaskId = '';
      }
    }, 0);
  }

  state.utility.repairDragActive = false;
  state.utility.repairDragChoice = 'ignore';
  state.utility.repairDragClearOnClick = false;
  if (state.utility.repairSuppressClick) {
    scheduleBrowserTimeout(() => {
      state.utility.repairSuppressClick = false;
    }, 0);
  }
  state.utility.problemExclusionDrag = null;
  if (state.utility.problemExclusionSuppressClick) {
    scheduleBrowserTimeout(() => {
      state.utility.problemExclusionSuppressClick = false;
      state.utility.problemExclusionClearOnClick = false;
    }, 0);
  }
  state.tagEditor.dragSelecting = false;
  state.tagEditor.dragAnchorPath = '';
}

function toggleUtilityLoopGroupCollapse(groupKey) {
  const normalizedGroupKey = String(groupKey || '');
  if (!normalizedGroupKey) return false;
  state.utility.collapsedLoopGroups ||= {};
  state.utility.collapsedLoopGroups[normalizedGroupKey] = !Boolean(state.utility.collapsedLoopGroups[normalizedGroupKey]);
  if (typeof renderUtilityLoopList === 'function') {
    const els = getUtilityModalElements();
    const scroll = els.list?.scrollTop;
    const focusedToggle = document.activeElement?.closest?.('[data-utility-loop-collapse]');
    const restoreFocus = focusedToggle?.getAttribute('data-utility-loop-collapse') === normalizedGroupKey;
    renderUtilityLoopList(els, getFilteredUtilityLoops());
    if (restoreFocus) {
      const replacement = Array.from(els.list?.querySelectorAll?.('[data-utility-loop-collapse]') || [])
        .find(toggle => toggle.getAttribute('data-utility-loop-collapse') === normalizedGroupKey);
      replacement?.focus({ preventScroll: true });
    }
    if (els.list && Number.isFinite(scroll)) els.list.scrollTop = scroll;
  } else renderUtilityModalContent();
  return true;
}
