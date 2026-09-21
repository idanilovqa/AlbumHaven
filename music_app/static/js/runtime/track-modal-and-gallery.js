function attachCoverLookupModalEvents() {
  const els = getCoverLookupModalElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.overlay.addEventListener('click', (event) => {
    if (overlayClickStartedOnOverlay(els.overlay, event)) {
      closeCoverLookupModal();
    }
  });
}

function attachCoverLookupDeleteConfirmEvents() {
  const els = getCoverLookupDeleteConfirmElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.overlay.addEventListener('click', (event) => {
    if (overlayClickStartedOnOverlay(els.overlay, event) || event.target.closest('[data-close-cover-lookup-delete-confirm="1"]')) {
      closeCoverLookupDeleteConfirm();
    }
  });
}

function attachUtilityModalEvents() {
  const els = getUtilityModalElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.close?.addEventListener('click', closeUtilityModal);
  let searchRenderTimer = null;
  const scheduleSearchRender = () => {
    clearTimeout(searchRenderTimer);
    const owner = state.utility;
    const tab = owner.activeTab;
    searchRenderTimer = setTimeout(() => {
      searchRenderTimer = null;
      if (state.utility === owner && owner.activeTab === tab && !els.overlay.hidden) renderUtilityModalContent();
    }, 80);
  };
  els.search?.addEventListener('input', () => {
    if (state.utility.activeTab === 'integrations') {
      state.utility.integrationsSearchQuery = els.search.value || '';
      filterUtilityIntegrationNavigation();
      return;
    }
    if (state.utility.activeTab === 'appearance') {
      state.utility.appearanceSearchQuery = els.search.value || '';
      filterUtilityAppearanceNavigation();
      return;
    }
    if (state.utility.activeTab === 'loops') {
      state.utility.loopsSearchQuery = els.search.value || '';
      filterUtilityLoopViews();
      return;
    }
    if (state.utility.activeTab === 'rules') state.utility.rulesSearchQuery = els.search.value || '';
    else if (state.utility.activeTab === 'problematic-files') state.utility.searchQuery = els.search.value || '';
    else return;
    scheduleSearchRender();
  });
  els.search?.addEventListener('search', () => {
    if (state.utility.activeTab === 'integrations') {
      state.utility.integrationsSearchQuery = els.search.value || '';
      filterUtilityIntegrationNavigation();
      return;
    }
    if (state.utility.activeTab === 'appearance') {
      state.utility.appearanceSearchQuery = els.search.value || '';
      filterUtilityAppearanceNavigation();
      return;
    }
    if (state.utility.activeTab === 'loops') {
      state.utility.loopsSearchQuery = els.search.value || '';
      filterUtilityLoopViews();
      return;
    }
    if (state.utility.activeTab === 'rules') state.utility.rulesSearchQuery = els.search.value || '';
    else if (state.utility.activeTab === 'problematic-files') state.utility.searchQuery = els.search.value || '';
    else return;
    scheduleSearchRender();
  });
  els.overlay.addEventListener('click', (event) => {
    if (overlayClickStartedOnOverlay(els.overlay, event) || event.target.closest('[data-close-utility-modal="1"]')) {
      closeUtilityModal();
    }
  });
}

function attachRepairConfirmEvents() {
  const els = getRepairConfirmElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.overlay.addEventListener('click', (event) => {
    if (overlayClickStartedOnOverlay(els.overlay, event) || event.target.closest('[data-close-repair-confirm="1"]')) {
      closeRepairConfirmModal();
    }
  });
}
