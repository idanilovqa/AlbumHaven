export async function waitForScanDrivenGalleryReady({
  galleryActions,
  navigationPanelActions,
  sidebarHydration = 'preview',
  minimumSidebarCount = 40,
  minimumVisibleCoverCount,
}) {
  const requiredSidebarCount = sidebarHydration === 'full'
    ? Number(minimumSidebarCount || 40)
    : 1;
  if (sidebarHydration === 'full') {
    await navigationPanelActions.waitForSidebarFullyHydrated({
      timeout: 60000,
      minimumSidebarCount: Math.max(0, requiredSidebarCount - 1),
    });
  } else {
    await navigationPanelActions.navigationPanel.allArtistsLink.waitFor({
      state: 'visible',
      timeout: 60000,
    });
  }
  await galleryActions.galleryPage.albumCards.first().waitFor({
    state: 'visible',
    timeout: 60000,
  });
  await galleryActions.waitForVisibleGalleryCoversLoaded({
    minimumCount: Number(minimumVisibleCoverCount || 6),
    timeout: 60000,
  });
}
