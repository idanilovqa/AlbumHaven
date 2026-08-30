function problematicAlbumMatchesFilters(album, selectedFilters) {
  const filters = Array.isArray(selectedFilters) ? selectedFilters : [];
  if (!filters.length) return true;
  const reasons = new Set(
    (Array.isArray(album?.problem_reasons) ? album.problem_reasons : [])
      .map((reason) => String(reason || '').trim())
      .filter(Boolean)
  );
  return filters.every((reason) => reasons.has(reason));
}

function reconcileProblematicSelectionForFilters(nextSelectedFilters) {
  const selectedKey = String(state.utility.selectedProblematicKey || '');
  if (!selectedKey) return;
  const selectedAlbum = (state.utility.problematicFiles || []).find((album) => (
    String(album?.key || '') === selectedKey
  )) || null;
  if (selectedAlbum && problematicAlbumMatchesFilters(selectedAlbum, nextSelectedFilters)) {
    return;
  }
  state.utility.selectedProblematicKey = '';
}

function handleProblematicUtilityClick(event) {
  const problemFilterToggle = event.target.closest('[data-toggle-problem-filter="1"]');
  if (problemFilterToggle) {
    event.preventDefault();
    state.utility.problemDropdownOpen = !state.utility.problemDropdownOpen;
    renderUtilityModalContent();
    return true;
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
    }
    return true;
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
    return true;
  }

  const problematicAlbumButton = event.target.closest('[data-problematic-album-key]');
  if (problematicAlbumButton) {
    event.preventDefault();
    state.utility.selectedProblematicKey = problematicAlbumButton.getAttribute('data-problematic-album-key') || '';
    state.utility.deferProblematicAutoSelection = false;
    state.utility.showRepairedDisplay = true;
    state.utility.repairSelections = {};
    state.utility.separateReleaseSelections = {};
    renderUtilityModalContent();
    return true;
  }

  const problematicOpenButton = event.target.closest('[data-open-problematic-album-folder="1"]');
  if (problematicOpenButton) {
    event.preventDefault();
    openAlbumInExplorer(getSelectedProblematicAlbum());
    return true;
  }

  const tagEditorOpenButton = event.target.closest('[data-open-tag-editor="1"]');
  if (tagEditorOpenButton) {
    event.preventDefault();
    openTagEditor(getSelectedProblematicAlbum());
    return true;
  }

  const discogsButton = event.target.closest('[data-find-on-discogs="1"]');
  if (discogsButton) {
    event.preventDefault();
    openAlbumOnDiscogs(getSelectedProblematicAlbum());
    return true;
  }

  const fetchCoverButton = event.target.closest('[data-fetch-problematic-cover="1"]');
  if (fetchCoverButton) {
    event.preventDefault();
    fetchCoverForProblematicAlbum(getSelectedProblematicAlbum());
    return true;
  }

  const displayRepairToggle = event.target.closest('[data-toggle-problematic-display-repair="1"]');
  if (displayRepairToggle) {
    event.preventDefault();
    state.utility.showRepairedDisplay = !state.utility.showRepairedDisplay;
    renderUtilityModalContent();
    return true;
  }

  const utilitySectionToggle = event.target.closest('[data-utility-section-toggle]');
  if (utilitySectionToggle) {
    event.preventDefault();
    const sectionKey = utilitySectionToggle.getAttribute('data-utility-section-toggle') || '';
    if (sectionKey) {
      state.utility.collapsedSections[sectionKey] = !Boolean(state.utility.collapsedSections[sectionKey]);
      renderUtilityModalContent();
    }
    return true;
  }

  const repairChoiceButton = event.target.closest('[data-repair-choice]');
  if (repairChoiceButton) {
    event.preventDefault();
    const choice = repairChoiceButton.getAttribute('data-repair-choice') || 'repair';
    if (state.utility.repairSuppressClick) {
      state.utility.repairSuppressClick = false;
      return true;
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
    return true;
  }

  const separateReleaseCheckbox = event.target.closest('[data-separate-release-key]');
  if (separateReleaseCheckbox) {
    const key = separateReleaseCheckbox.getAttribute('data-separate-release-key') || '';
    if (key) {
      state.utility.separateReleaseSelections[key] = Boolean(separateReleaseCheckbox.checked);
      renderUtilityModalContent();
    }
    return true;
  }

  const repairOpenButton = event.target.closest('[data-open-repair-confirm="1"]');
  if (repairOpenButton) {
    event.preventDefault();
    const album = getSelectedProblematicAlbum();
    if (!album) {
      showToast('No album selected for repair.', 'error', 3200);
      return true;
    }
    state.utility.pendingRepairKey = album.key || '';
    state.utility.pendingRepairAction = repairOpenButton.getAttribute('data-repair-action') || 'repair';
    openRepairConfirmModal();
    return true;
  }

  return false;
}

registerUtilityTab('problematic-files', {
  render: renderProblematicFiles,
  load: loadProblematicFiles,
  shouldLoadOnActivate() {
    return !state.utility.loaded;
  },
  onSearch(value) {
    state.utility.searchQuery = value;
    renderUtilityModalContent();
  },
  handleClick: handleProblematicUtilityClick,
});
