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
  els.search?.addEventListener('input', () => {
    if (state.utility.activeTab !== 'problematic-files') return;
    state.utility.searchQuery = els.search.value || '';
    renderUtilityModalContent();
  });
  els.search?.addEventListener('search', () => {
    if (state.utility.activeTab !== 'problematic-files') return;
    state.utility.searchQuery = els.search.value || '';
    renderUtilityModalContent();
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


