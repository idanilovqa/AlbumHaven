// Keep this file as a thin registration seam; feature logic belongs in
// feature-owned bootstrap handler files rather than accumulating here.
document.addEventListener('click', (event) => {
  const closeScanPageButton = event.target?.closest?.('[data-close-scan-page]') || null;
  if (closeScanPageButton) {
    event.preventDefault();
    closeScanPage();
    return;
  }
  if (handleGalleryBootstrapSearchClick(event)) return;
  if (handleSidebarArtistSelectionClick(event)) return;
  if (handleArtistsDrawerClick(event)) return;

  const cancelLibraryScanButton = event.target.closest('[data-cancel-library-scan="1"]');
  if (cancelLibraryScanButton && !cancelLibraryScanButton.disabled) {
    event.preventDefault();
    cancelLibraryScan();
    return;
  }

  const browseScannedLibraryButton = event.target.closest('[data-browse-scanned-library="1"]');
  if (browseScannedLibraryButton && !browseScannedLibraryButton.disabled) {
    event.preventDefault();
    browseScannedLibrarySnapshot();
    return;
  }

  handleUtilityBootstrapClick(event);
  if (event.defaultPrevented) return;
  handleGalleryBootstrapClick(event);
});

document.addEventListener('wheel', (event) => {
  handleGalleryBootstrapWheel(event);
}, { passive: false });

document.addEventListener('pointerdown', (event) => {
  handleGalleryBootstrapPointerDown(event);
});

document.addEventListener('pointermove', (event) => {
  handleGalleryBootstrapPointerMove(event);
});

document.addEventListener('pointerup', () => {
  handleGalleryBootstrapPointerUp();
});

document.addEventListener('pointercancel', () => {
  handleGalleryBootstrapPointerCancel();
});

document.getElementById('search-form')?.addEventListener('submit', (event) => {
  handleGalleryBootstrapSearchSubmit(event);
});

document.addEventListener('submit', (event) => {
  handleUtilityBootstrapSubmit(event);
});

document.addEventListener('mousedown', (event) => {
  if (handleGalleryBootstrapSearchMouseDown(event)) return;
  handleUtilityBootstrapMouseDown(event);
});

document.addEventListener('keydown', (event) => {
  handleUtilityBootstrapKeyDown(event);
});

document.addEventListener('mouseover', (event) => {
  if (handleUtilityBootstrapMouseOver(event)) return;
  handleGalleryBootstrapMouseOver(event);
});

document.addEventListener('mouseup', (event) => {
  handleUtilityBootstrapMouseUp(event);
});

document.addEventListener('mouseout', (event) => {
  handleGalleryBootstrapMouseOut(event);
});

document.addEventListener('focusin', (event) => {
  handleGalleryBootstrapFocusIn(event);
});

document.addEventListener('focusout', (event) => {
  handleGalleryBootstrapFocusOut(event);
});

document.getElementById('albums-scroll')?.addEventListener('scroll', () => {
  handleGalleryBootstrapAlbumsScroll();
}, { passive: true });

window.addEventListener('resize', () => {
  handleGalleryBootstrapResize();
});

document.addEventListener('input', (event) => {
  handleUtilityBootstrapInput(event);
});

document.addEventListener('paste', async (event) => {
  await handleUtilityBootstrapPaste(event);
});

document.addEventListener('copy', (event) => {
  handleCoverLookupTaskOpenCopy(event);
});

document.addEventListener('change', (event) => {
  handleUtilityBootstrapChange(event);
});

const searchInput = document.getElementById('search-input');
searchInput?.addEventListener('search', syncSearchClear);
searchInput?.addEventListener('blur', handleGalleryBootstrapSearchBlur);
searchInput?.addEventListener('focus', handleGalleryBootstrapSearchFocus);
searchInput?.addEventListener('keydown', handleGalleryBootstrapSearchKeyDown);
searchInput?.addEventListener('input', () => {
  handleGalleryBootstrapSearchInput(searchInput.value || '');
});

window.addEventListener('popstate', () => {
  handleGalleryBootstrapPopState();
});
