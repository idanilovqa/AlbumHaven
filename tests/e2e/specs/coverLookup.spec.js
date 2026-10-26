import { expect, test } from '../support/baseFixtures.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSameAlbumArtwork, createUndersizedAlbumArtwork } from '../helpers/albumSourceOwnershipFixture.js';
import {
  buildFixtureManualUrls,
  COVER_LOOKUP_TEST_TARGETS,
  findFixtureCoverBySubtitle,
} from '../helpers/coverLookupFixtureData.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

const {
  cancelClear: CANCEL_CLEAR_TARGET,
  canonicalPersistence: COVER_LOOKUP_TARGET,
  manualProviderCover: MANUAL_PROVIDER_COVER,
  notificationActioned: NOTIFICATION_ACTIONED_TARGET,
  notificationActive: ACTIVE_COVER_LOOKUP_TARGET,
  notificationFailed: NOTIFICATION_FAILED_TARGET,
  notificationNoResult: SECOND_COVER_LOOKUP_TARGET,
  partialSave: PARTIAL_COVER_LOOKUP_TARGET,
  progressiveCandidates: PROGRESSIVE_CANDIDATE_TARGET,
  automaticCandidate: AUTOMATIC_CANDIDATE_TARGET,
  userOwnedImprovement: USER_OWNED_IMPROVEMENT_TARGET,
  providerStoragePolicy: PROVIDER_STORAGE_POLICY_TARGET,
} = COVER_LOOKUP_TEST_TARGETS;

const COVER_LOOKUP_FILTERED_URL = `/?surface=albums&q=${encodeURIComponent(COVER_LOOKUP_TARGET.artist.toLowerCase())}&artist=${encodeURIComponent(COVER_LOOKUP_TARGET.artist)}&gallery_scope=all&category=main_library&category=hoard&category=new_arrivals`;
const SPLIT_FIXTURE = Object.freeze({
  artist: 'ДДТ',
  album: 'Студийные записи',
  splitAlbum: 'Студийные записи split release',
  year: '1999',
  filenames: ['14. Студийная запись 14.mp3', '15. Студийная запись 15.mp3', '16. Студийная запись 16.mp3'],
});
const USER_COVER_LINKED_FIELDS = [
  'remote_cover_url',
  'remote_cover_thumbnail_url',
  'remote_cover_source',
  'remote_cover_source_label',
  'remote_cover_album_url',
  'remote_cover_width',
  'remote_cover_height',
];
const ARTIST_CONJUNCTION_TARGET = Object.freeze({
  artist: 'Neal Morse & The Resonance',
  album: 'Cover Lookup Conjunction',
  year: '2006',
});

test('FTC-COVERS-032 current 1200px cover clears stale poor-quality alert', { tag: '@area:cover-providers' }, async ({
  galleryActions,
  settingsModalAppBarActions,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('problematic-files');
  await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
  await utilityProblematicFilesActions.search(MANUAL_PROVIDER_COVER.album);
  await utilityProblematicFilesActions.waitForNoSearchResults(MANUAL_PROVIDER_COVER.album);
});

test('FTC-COVERS-024 manual composer preserves staged images and exclusive choices at narrow width', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  page,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  const lookup = coverLookupActions.coverLookup;
  const pickerName = 'album-haven-cloud-vinyl.png';
  const dropName = 'remote-preview-unavailable.png';
  const pickerPath = path.resolve('music_app', 'static', 'images', pickerName);
  const dropPath = path.resolve('music_app', 'static', 'images', dropName);
  const fixtureCover = findFixtureCoverBySubtitle(Object.values(MANUAL_PROVIDER_COVER).join(' - '));
  expect(fixtureCover).not.toBeNull();
  const albumUrl = new URL(buildFixtureManualUrls(fixtureCover)[0]);
  const imageUrl = new URL(`/covers/${encodeURIComponent(fixtureCover.assetId)}`, albumUrl).href;
  const missingUrl = new URL('/manual/missing-composer-cover', albumUrl).href;

  await stepLogger.step('Open the isolated album and stage images through the picker and native file drop', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(USER_OWNED_IMPROVEMENT_TARGET))
      .toEqual(USER_OWNED_IMPROVEMENT_TARGET);
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalResultsReady();
    await expect(lookup.manualExtractButton).toBeDisabled();
    await expect(lookup.savedRemoteCoverCard).toHaveClass(/\bis-active\b/);
    await coverLookupActions.chooseComposerImages([pickerPath]);
    await expect(lookup.pendingAttachmentByName(pickerName)).toBeVisible();
    await coverLookupActions.dropComposerImage(dropPath);
    await expect(lookup.pendingAttachmentByName(dropName)).toBeVisible();
    await expect(lookup.pendingAttachments).toHaveCount(2);
    await expect(lookup.stagedCoverCards).toHaveCount(0);
    await coverLookupActions.removePendingComposerImage(dropName);
    await expect(lookup.pendingAttachments).toHaveCount(1);
    await expect(lookup.pendingAttachmentByName(pickerName)).toBeVisible();
  });

  await stepLogger.step('Copy artwork on the external fixture page and paste it through the native browser clipboard', async () => {
    await coverLookupActions.pasteComposerImageFromProvider(fixtureCover.assetId);
    await expect(lookup.pendingAttachmentByName('image.png')).toBeVisible();
    await expect(lookup.pendingAttachmentByName(pickerName)).toBeVisible();
    await expect(lookup.pendingAttachments).toHaveCount(2);
    await expect(lookup.manualUrlInput).toHaveValue('');
  });

  await stepLogger.step('Retain the valid image and pasted URL when remote extraction fails', async () => {
    await coverLookupActions.pasteManualUrl(missingUrl);
    const failed = await coverLookupActions.extractComposerLinks();
    expect(failed.status).toBe(400);
    expect(failed.payload.ok).toBe(false);
    expect(failed.payload.error).toBe('No usable cover art could be extracted from those links');
    await expect(lookup.modalStatusTitle).toHaveText('Cover lookup failed');
    await expect(lookup.modalStatusMessage).toHaveText('No usable cover art could be extracted from those links');
    await expect(lookup.manualUrlInput).toHaveValue(missingUrl);
    await expect(lookup.stagedCoverCardByName(pickerName)).toBeVisible();
    await expect(lookup.stagedCoverCardByName('image.png')).toBeVisible();
    await expect(lookup.pendingAttachments).toHaveCount(0);
    await coverLookupActions.selectOnlyCover(lookup.stagedCoverCardByName('image.png'));
    await coverLookupActions.removeExtractedComposerImage('image.png');
    await coverLookupActions.selectOnlyCover(lookup.stagedCoverCardByName(pickerName));
  });

  await stepLogger.step('Hide manual composition on mobile, then extract on desktop without losing the staged choice', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(lookup.manualUrlInput).toBeHidden();
    await expect(lookup.manualExtractButton).toBeHidden();
    await expect(lookup.manualDropZone).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(lookup.manualUrlInput).toBeVisible();
    await coverLookupActions.pasteManualUrl(imageUrl);
    await coverLookupActions.expectComposerFitsViewport();
    const extracted = await coverLookupActions.extractComposerLinks();
    expect(extracted.status).toBe(200);
    expect(extracted.payload.ok).toBe(true);
    await expect(lookup.manualUrlInput).toHaveValue('');
    await expect(lookup.stagedCoverCardByName(pickerName)).toHaveClass(/\bis-active\b/);
    await expect(lookup.selectedCoverCards).toHaveCount(1);
    await expect(lookup.remoteCoverCards).toHaveCount(1);
    const image = await coverLookupActions.readDisplayedImageEvidence(lookup.firstRemoteMatchImage, 'extensionless direct image');
    expect(image.sha256).toBe(fixtureCover.sha256);
  });

  await stepLogger.step('Keep exactly one local, remote, or staged cover selected and remove the staged image', async () => {
    await coverLookupActions.selectOnlyCover(lookup.firstRemoteCoverCard);
    const selectedLocalCover = lookup.localCoverCards.first();
    await lookup.localCoverActionWithin(selectedLocalCover).click();
    await expect(selectedLocalCover).toHaveClass(/\bis-active\b/);
    await expect(lookup.selectedCoverCards).toHaveCount(1);
    await expect(lookup.saveRemoteButton).toBeEnabled();
    await coverLookupActions.selectOnlyCover(lookup.stagedCoverCardByName(pickerName));
    await coverLookupActions.removeExtractedComposerImage(pickerName);
    await expect(lookup.stagedCoverCards).toHaveCount(0);
    await expect(lookup.saveRemoteButton).toBeDisabled();
    await expect(lookup.remoteCoverCards).toHaveCount(1);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-028 pasted cover revision reconciles album details, gallery, and mobile caches', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  page,
  stepLogger,
  trackModalActions,
}) => {
  const lookup = coverLookupActions.coverLookup;
  const mobileLayout = new MobileLayoutPage(page);
  const pickerName = 'album-haven-cloud-vinyl.png';
  const pickerPath = path.resolve('music_app', 'static', 'images', pickerName);
  let savedCoverPath = '';
  let savedCoverRevision = '';
  let savedPreviewHash = '';

  await stepLogger.step('Save a staged image through the visible Cover Lookup controls', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(USER_OWNED_IMPROVEMENT_TARGET))
      .toEqual(USER_OWNED_IMPROVEMENT_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalResultsReady();
    await coverLookupActions.chooseComposerImages([pickerPath]);
    await expect(lookup.pendingAttachmentByName(pickerName)).toBeVisible();
    await lookup.manualExtractButton.click();
    const stagedCover = lookup.stagedCoverCardByName(pickerName);
    await expect(stagedCover).toBeVisible();
    await coverLookupActions.selectOnlyCover(stagedCover);

    const saveResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/cover-lookup/pasted-image-save'
    ));
    await lookup.saveRemoteButton.click();
    const saveResponse = await saveResponsePromise;
    const payload = await saveResponse.json();
    expect(saveResponse.status()).toBe(200);
    expect(payload.ok).toBe(true);
    savedCoverPath = String(payload.selected_cover_path || '').trim();
    savedCoverRevision = String(payload.cover_revision || '').trim();
    expect(savedCoverPath).toMatch(/[\\/]cover\.jpg$/i);
    expect(savedCoverRevision).toMatch(/^[a-f0-9]{64}$/i);
    expect(payload.updated_album?.cover_path).toBe(savedCoverPath);
    expect(payload.updated_album?.cover_revision).toBe(savedCoverRevision);
    await expect(lookup.modal).toBeHidden();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(
      USER_OWNED_IMPROVEMENT_TARGET.album,
      'Art chosen',
    );
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Use one saved revision for Album Details and full-size artwork', async () => {
    await trackModalActions.waitForLoadedSummary();
    const detailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'pasted Album Details cover',
      {
        expectedCoverPath: savedCoverPath,
        expectedCoverRevision: savedCoverRevision,
      },
    );
    savedPreviewHash = detailCover.sha256;
    const fullSizeCover = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: savedCoverPath,
      coverRevision: savedCoverRevision,
      label: 'pasted authoritative cover',
    });
    expect(fullSizeCover.sha256).toBe(savedCoverRevision.toUpperCase());
  });

  await stepLogger.step('Keep Album Details and the gallery card reconciled at mobile width', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileDetailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'mobile pasted Album Details cover',
      {
        expectedCoverPath: savedCoverPath,
        expectedCoverRevision: savedCoverRevision,
      },
    );
    expect(mobileDetailCover.sha256).toBe(savedPreviewHash);
    await trackModalActions.backFromMobilePage();
    await mobileLayout.libraryButton.click();
    await expect(mobileLayout.artistRail).toHaveAttribute('aria-hidden', 'false');
    await mobileLayout.allArtists.click();
    await expect(mobileLayout.home).toBeHidden();
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(
      USER_OWNED_IMPROVEMENT_TARGET.artist,
      USER_OWNED_IMPROVEMENT_TARGET.album,
    );
    const cardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(USER_OWNED_IMPROVEMENT_TARGET.album),
      'mobile pasted gallery cover',
      {
        expectedCoverPath: savedCoverPath,
        expectedCoverRevision: savedCoverRevision,
      },
    );
    expect(cardCover.sha256).toBe(savedPreviewHash);
  });

  await stepLogger.step('Reload the mobile gallery without reviving the prior cached cover', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(
      USER_OWNED_IMPROVEMENT_TARGET.artist,
      USER_OWNED_IMPROVEMENT_TARGET.album,
    );
    const reloadedCardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(USER_OWNED_IMPROVEMENT_TARGET.album),
      'reloaded mobile pasted gallery cover',
      {
        expectedCoverPath: savedCoverPath,
        expectedCoverRevision: savedCoverRevision,
      },
    );
    expect(reloadedCardCover.sha256).toBe(savedPreviewHash);
  });
});

test('FTC-COVERS-022 cover gallery loading starts before the task list responds', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let appleCandidate = null;

  await stepLogger.step('Hold real candidate image bytes at the isolated provider', async () => {
    await coverLookupActions.holdCandidateImageFixture();
  });

  await stepLogger.step('Open seeded candidates through the production album-details control', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROVIDER_STORAGE_POLICY_TARGET))
      .toEqual(PROVIDER_STORAGE_POLICY_TARGET);
    await trackModalActions.waitForLoadedSummary();
    const requestOrder = await trackModalActions.openCoverLookupAndReadRequestOrder();
    expect(requestOrder.indexOf('gallery-request')).toBeGreaterThanOrEqual(0);
    expect(requestOrder.indexOf('gallery-request'))
      .toBeLessThan(requestOrder.indexOf('tasks-response'));
    await coverLookupActions.waitForModalResultsReady();
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    appleCandidate = candidates.find(
      (candidate) => candidate.source === 'Apple Music',
    );
    expect(appleCandidate?.id).toBeTruthy();
    await coverLookupActions.waitForCandidateImageFixtureBlocked();
  });

  await stepLogger.step('Reopen the gallery while candidate image bytes remain blocked', async () => {
    await coverLookupActions.closeModal();
    const requestOrder = await trackModalActions.openCoverLookupAndReadRequestOrder();
    expect(requestOrder).toContain('gallery-request');
    expect(requestOrder).toContain('tasks-response');
    await coverLookupActions.waitForModalResultsReady();
    const heldEvidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(heldEvidence.candidate_image_released).toBe(false);
    expect(Number(heldEvidence.candidate_image_requests || 0)).toBeGreaterThan(0);
  });

  await stepLogger.step('Release the provider and render the actual proxied Apple image', async () => {
    await coverLookupActions.releaseCandidateImageFixture();
    const renderedImage = await coverLookupActions.readRemoteCandidateEvidence(appleCandidate.id);
    expect(renderedImage.sha256).toBeTruthy();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-012 fake-album fast cover search appears in the drawer and can be canceled and cleared', { tag: '@area:cover-providers' }, async ({
  galleryActions,
  coverLookupActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let taskTitle = '';

  await stepLogger.step('Open the fake All Artists gallery and select the exact manifest-backed album', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const selectedAlbum = await galleryActions.selectAlbumDetailsByIdentity(CANCEL_CLEAR_TARGET);
    expect(selectedAlbum).toEqual(CANCEL_CLEAR_TARGET);
    const modal = await trackModalActions.waitForLoadedSummary();
    expect(modal.title).toBe(Object.values(CANCEL_CLEAR_TARGET).join(' • '));
  });

  await stepLogger.step('Open the cover lookup gallery for the fake album and capture its random subtitle', async () => {
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = CANCEL_CLEAR_TARGET.album;
    expect(taskTitle).not.toEqual('');
  });

  await stepLogger.step('Close the gallery and trigger the fast cover search from the track modal', async () => {
    await coverLookupActions.closeModal();
    await trackModalActions.startFastCoverFetch();
    await trackModalActions.close();
  });

  await stepLogger.step('Confirm the notification badge and drawer row appear for the fake search', async () => {
    await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskVisible(taskTitle);
  });

  await stepLogger.step('Cancel the search through the drawer UI and confirm the task becomes canceled', async () => {
    await coverLookupActions.cancelTask(taskTitle);
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Canceled');
  });

  await stepLogger.step('Clear the canceled task from the drawer and confirm no tasks remain', async () => {
    await coverLookupActions.clearTask(taskTitle);
    await coverLookupActions.waitForDrawerEmpty();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-007 lookup-start alert does not reposition the cover modal', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  trackModalActions,
}) => {
  let taskTitle = '';

  await stepLogger.step('Open Cover Look Up and start a no-result provider search', async () => {
    await coverLookupActions.setProviderFixtureMode('no-results');
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(NOTIFICATION_ACTIONED_TARGET))
      .toEqual(NOTIFICATION_ACTIONED_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = NOTIFICATION_ACTIONED_TARGET.album;
    expect(taskTitle).not.toEqual('');
    const expectedCover = findFixtureCoverBySubtitle(
      Object.values(MANUAL_PROVIDER_COVER).join(' - '),
    );
    expect(expectedCover).not.toBeNull();
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(expectedCover));
  });

  await stepLogger.step('Overlay the alert without changing the modal geometry', async () => {
    const toastPlacement = await coverLookupActions.startSearchAndReadToastPlacement();
    expect(toastPlacement.horizontalCenterDelta).toBeLessThanOrEqual(2);
    expect(toastPlacement.finalVisualState).toMatchObject({
      activeAnimationCount: 0,
      isVisibleClass: true,
      opacity: '1',
      transformStable: true,
    });
    expect(toastPlacement.modalGeometryDelta).toEqual({
      height: 0,
      width: 0,
      x: 0,
      y: 0,
    });
    expect(toastPlacement.overlaps.modalActions).toBe(false);
    expect(toastPlacement.overlaps.toolbarRight).toBe(false);
    expect(toastPlacement.pointerEvents).toBe('none');
    expect(toastPlacement.underlyingOverlayId).toBe('cover-lookup-modal');
    expect(toastPlacement.toastLayerZIndex)
      .toBeGreaterThan(toastPlacement.underlyingStackingZIndex);
    expect(toastPlacement.topmostAtCenter).toBe(true);
  });

  await stepLogger.step('Clear the completed lookup and restore the provider fixture', async () => {
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(taskTitle, /^[1-9]\d* covers? found$/);
    await coverLookupActions.clearTaskAndExpectImmediateRemoval(taskTitle);
    await coverLookupActions.waitForDrawerEmpty();
    await coverLookupActions.setProviderFixtureMode('normal');
  });
});

test('FTC-COVERS-007 bulk clear removes chosen covers and preserves unresolved work', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}, testInfo) => {
  testInfo.setTimeout(240000);
  let actionedTaskTitle = '';
  let activeTaskTitle = '';
  let failedTaskTitle = '';
  let noResultTaskTitle = '';
  let terminalDuration = '';

  await stepLogger.step('Start a full lookup with a topmost centered alert that does not move the modal', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(NOTIFICATION_ACTIONED_TARGET))
      .toEqual(NOTIFICATION_ACTIONED_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    actionedTaskTitle = NOTIFICATION_ACTIONED_TARGET.album;
    const expectedCover = findFixtureCoverBySubtitle(
      Object.values(MANUAL_PROVIDER_COVER).join(' - '),
    );
    expect(expectedCover).not.toBeNull();
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(expectedCover).slice(1));
    const toastPlacement = await coverLookupActions.startSearchAndReadToastPlacement();
    expect(toastPlacement.horizontalCenterDelta).toBeLessThanOrEqual(2);
    expect(toastPlacement.finalVisualState).toMatchObject({
      activeAnimationCount: 0,
      isVisibleClass: true,
      opacity: '1',
      transformStable: true,
    });
    expect(toastPlacement.modalGeometryDelta).toEqual({
      height: 0,
      width: 0,
      x: 0,
      y: 0,
    });
    expect(toastPlacement.overlaps.modalActions).toBe(false);
    expect(toastPlacement.overlaps.toolbarRight).toBe(false);
    expect(toastPlacement.pointerEvents).toBe('none');
    expect(toastPlacement.underlyingOverlayId).toBe('cover-lookup-modal');
    expect(toastPlacement.toastLayerZIndex)
      .toBeGreaterThan(toastPlacement.underlyingStackingZIndex);
    expect(toastPlacement.topmostAtCenter).toBe(true);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskVisible(actionedTaskTitle);
    await coverLookupActions.waitForTaskCoverDecoded(actionedTaskTitle);
    await coverLookupActions.waitForRunningTaskElapsedToAdvance(actionedTaskTitle);
  });

  await stepLogger.step('Select the notification card text without opening the modal and verify the completed elapsed pill', async () => {
    await coverLookupActions.waitForTaskStatus(actionedTaskTitle, /^(?:\d+ )?covers found$/u);
    const info=coverLookupActions.coverLookup.taskInfoByTitle(actionedTaskTitle);
    const clear=coverLookupActions.coverLookup.taskClearButtonByTitle(actionedTaskTitle);
    await clear.hover();
    const clearHoverBefore=await coverLookupActions.coverLookup.readTaskClearHoverStyle(actionedTaskTitle);
    await info.hover();
    await expect(info).toHaveCSS('outline-style','none');
    await expect(info).toHaveCSS('cursor','pointer');
    await clear.focus();
    await clear.press('Shift+Tab');
    await expect(info).toBeFocused();
    await expect(info).toHaveJSProperty('tabIndex',0);
    await expect(info).toHaveAttribute(
      'aria-label',
      `Open Cover Look Up: ${NOTIFICATION_ACTIONED_TARGET.album} — ${NOTIFICATION_ACTIONED_TARGET.artist} · ${NOTIFICATION_ACTIONED_TARGET.year}`,
    );
    await info.press('Tab');
    await expect(clear).toBeFocused();
    await clear.press('Tab');
    await clear.hover();
    expect(await coverLookupActions.coverLookup.readTaskClearHoverStyle(actionedTaskTitle)).toEqual(clearHoverBefore);
    terminalDuration = await coverLookupActions.waitForTerminalTaskElapsed(actionedTaskTitle);
    await coverLookupActions.expectTaskElapsedStable(actionedTaskTitle, terminalDuration);
    const selection = await coverLookupActions.dragSelectTaskTitleWithoutOpeningModal(actionedTaskTitle);
    expect(selection.selectedText).toContain(actionedTaskTitle);
    expect(selection.selectedText).toContain(NOTIFICATION_ACTIONED_TARGET.artist);
    expect(selection.selectedText).toContain(String(NOTIFICATION_ACTIONED_TARGET.year));
    expect(selection.selectedText).toMatch(/(?:\d+ )?covers found/u);
    expect(selection.clipboardText).toBe(selection.selectedText);
    expect(selection.cursor).toBe('pointer');
    const elapsedPill = await coverLookupActions.readTaskElapsedPill(actionedTaskTitle);
    expect(elapsedPill.className).toMatch(/\bis-completed\b/);
    expect(elapsedPill.display).toBe('flex');
    expect(elapsedPill.borderRadius).toBeGreaterThan(0);
    expect(elapsedPill.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(elapsedPill.width).toBeGreaterThan(0);
    expect(elapsedPill.height).toBeGreaterThan(0);
  });

  await stepLogger.step('Choose the returned cover and keep the completed duration frozen', async () => {
    // Sequential cover-review workflow: Notifications intentionally stays open behind Cover Look Up,
    // so closing the lookup returns directly to the next notification.
    await coverLookupActions.openTaskWithKeyboard(actionedTaskTitle, 'Enter');
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForModalResultsReady();
    await expect(coverLookupActions.coverLookup.modalSubtitle).toContainText(NOTIFICATION_ACTIONED_TARGET.album);
    await coverLookupActions.coverLookup.waitForDrawerState(true);
    await coverLookupActions.closeModal();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.openTaskWithKeyboard(actionedTaskTitle, 'Space');
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForModalResultsReady();
    await expect(coverLookupActions.coverLookup.modalSubtitle).toContainText(NOTIFICATION_ACTIONED_TARGET.album);
    await coverLookupActions.coverLookup.waitForDrawerState(true);
    await coverLookupActions.selectFirstRemoteCoverAndSave();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(actionedTaskTitle, 'Art chosen');
    expect(await coverLookupActions.readTaskElapsed(actionedTaskTitle)).toBe(terminalDuration);
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Complete a different lookup with no provider result', async () => {
    expect(await galleryActions.selectAlbumDetailsByIdentity(SECOND_COVER_LOOKUP_TARGET, { direction: -1 }))
      .toEqual(SECOND_COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    noResultTaskTitle = SECOND_COVER_LOOKUP_TARGET.album;
    expect(noResultTaskTitle).not.toBe(actionedTaskTitle);
    await coverLookupActions.setProviderFixtureMode('no-results');
    await coverLookupActions.startSearch();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'No covers found');
    await coverLookupActions.waitForTerminalTaskElapsed(noResultTaskTitle);
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Record an actual provider-data failure as failed', async () => {
    expect(await galleryActions.selectAlbumDetailsByIdentity(NOTIFICATION_FAILED_TARGET))
      .toEqual(NOTIFICATION_FAILED_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    failedTaskTitle = NOTIFICATION_FAILED_TARGET.album;
    expect(failedTaskTitle).not.toBe(actionedTaskTitle);
    expect(failedTaskTitle).not.toBe(noResultTaskTitle);
    await coverLookupActions.setProviderFixtureMode('failed');
    await coverLookupActions.startSearch();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Lookup failed');
    await coverLookupActions.waitForTerminalTaskElapsed(failedTaskTitle);
    const retryIcon = coverLookupActions.coverLookup.taskRetryIconByTitle(failedTaskTitle);
    await expect(retryIcon).toBeVisible();
    await expect(retryIcon).toHaveClass(/\bui-icon--refresh\b/);
    const failedTaskCard = coverLookupActions.coverLookup.taskCardByTitle(failedTaskTitle);
    await expect(failedTaskCard).toHaveCount(1);
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.holdLaterProviderFixture();
    await retryIcon.click();
    await expect(failedTaskCard).toHaveCount(1);
    await coverLookupActions.waitForTaskActive(failedTaskTitle);
    await coverLookupActions.waitForLaterProviderFixtureBlocked();
    await coverLookupActions.setProviderFixtureMode('failed');
    await coverLookupActions.releaseLaterProviderFixture();
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Lookup failed');
    await expect(failedTaskCard).toHaveCount(1);
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Start another lookup and bulk-clear every finished row while it remains active', async () => {
    expect(await galleryActions.selectAlbumDetailsByIdentity(ACTIVE_COVER_LOOKUP_TARGET))
      .toEqual(ACTIVE_COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    activeTaskTitle = ACTIVE_COVER_LOOKUP_TARGET.album;
    expect(activeTaskTitle).not.toBe(actionedTaskTitle);
    expect(activeTaskTitle).not.toBe(noResultTaskTitle);
    expect(activeTaskTitle).not.toBe(failedTaskTitle);
    await coverLookupActions.closeModal();
    await coverLookupActions.holdLaterProviderFixture();
    await trackModalActions.startFastCoverFetch();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskVisible(actionedTaskTitle);
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'No covers found');
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Lookup failed');
    await coverLookupActions.waitForTaskActive(activeTaskTitle);
    await coverLookupActions.waitForLaterProviderFixtureBlocked();
    const clearResult = await coverLookupActions.clearFinishedTasksAndPreserveActive(
      [actionedTaskTitle],
      activeTaskTitle,
    );
    expect(clearResult.requestedTaskCount).toBe(0);
    expect(clearResult.removedCount).toBe(1);
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'No covers found');
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Lookup failed');
  });

  await stepLogger.step('Reload with unresolved and active work, then clear each explicitly', async () => {
    await coverLookupActions.reloadAndOpenDrawer();
    await coverLookupActions.waitForTaskActive(activeTaskTitle);
    await coverLookupActions.expectTaskHiddenImmediately(actionedTaskTitle);
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'No covers found');
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Lookup failed');
    await coverLookupActions.clearTaskAndExpectImmediateRemoval(noResultTaskTitle);
    await coverLookupActions.clearTaskAndExpectImmediateRemoval(failedTaskTitle);
    await coverLookupActions.cancelTask(activeTaskTitle);
    await coverLookupActions.releaseLaterProviderFixture();
    await coverLookupActions.waitForTaskStatus(activeTaskTitle, 'Canceled');
    await coverLookupActions.waitForLaterProviderCancellationEvidence();
    const canceledDuration = await coverLookupActions.waitForTerminalTaskElapsed(activeTaskTitle);
    await coverLookupActions.expectTaskElapsedStable(activeTaskTitle, canceledDuration);
    await coverLookupActions.clearTaskAndExpectImmediateRemoval(activeTaskTitle);
    await coverLookupActions.waitForDrawerEmpty();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-036 notification cards keep independent album identity after cover save', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  page,
  trackModalActions,
}, testInfo) => {
  testInfo.setTimeout(240000);
  const targets = [
    NOTIFICATION_ACTIONED_TARGET,
    PARTIAL_COVER_LOOKUP_TARGET,
    COVER_LOOKUP_TARGET,
  ];
  const expectedCover = findFixtureCoverBySubtitle(
    Object.values(MANUAL_PROVIDER_COVER).join(' - '),
  );
  expect(expectedCover).not.toBeNull();

  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  const notifications = [];
  for (const identity of targets) {
    expect(await galleryActions.selectAlbumDetailsByIdentity(identity)).toEqual(identity);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(expectedCover).slice(1));
    const start = await coverLookupActions.startSearch();
    const taskId = String(start.task?.id || '').trim();
    expect(taskId).not.toBe('');
    notifications.push({ taskId, identity });
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatusById(taskId, /^(?:\d+ )?covers found$/u);
    await coverLookupActions.waitForTaskCoverDecodedById(taskId);
    await coverLookupActions.closeDrawer();
  }

  const repeated = notifications[0];
  expect(await galleryActions.selectAlbumDetailsByIdentity(repeated.identity)).toEqual(repeated.identity);
  await trackModalActions.waitForLoadedSummary();
  await trackModalActions.openCoverLookup();
  await coverLookupActions.waitForModalReady();
  await coverLookupActions.setProviderFixtureMode('normal');
  await coverLookupActions.enterManualUrls(buildFixtureManualUrls(expectedCover).slice(1));
  const repeatedStart = await coverLookupActions.startSearch();
  expect(String(repeatedStart.task?.id || '').trim()).toBe(repeated.taskId);
  await coverLookupActions.closeModal();
  await trackModalActions.close();
  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForDrawerOpen();
  await expect(coverLookupActions.coverLookup.taskCardById(repeated.taskId)).toHaveCount(1);
  await coverLookupActions.waitForTaskStatusById(repeated.taskId, /^(?:\d+ )?covers found$/u);
  await coverLookupActions.closeDrawer();

  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForDrawerOpen();
  await page.setViewportSize({ width: 390, height: 844 });
  const drawerScrollTop = await coverLookupActions.scrollDrawerToEnd();
  expect(drawerScrollTop).toBeGreaterThan(0);
  const readCards = async () => Object.fromEntries(await Promise.all(
    notifications.map(async ({ taskId }) => [
      taskId,
      await coverLookupActions.readTaskCardEvidenceById(taskId),
    ]),
  ));
  const before = await readCards();
  const readTargetOrder = async () => page.locator('[data-open-cover-lookup-task]').evaluateAll(
    (elements, taskIds) => elements
      .map((element) => String(element.getAttribute('data-open-cover-lookup-task') || ''))
      .filter((taskId) => taskIds.includes(taskId)),
    notifications.map(({ taskId }) => taskId),
  );
  const orderBeforeSave = await readTargetOrder();
  expect(new Set(Object.values(before).map((evidence) => evidence.taskId)).size).toBe(3);
  expect(new Set(Object.values(before).map((evidence) => evidence.imageSrc)).size).toBe(3);

  const verifyCardDestinations = async ({ swipeFirst = false } = {}) => {
    for (const [index, { taskId, identity }] of notifications.entries()) {
      expect(before[taskId]).toMatchObject({
        taskId,
        title: identity.album,
        byline: [identity.artist, identity.year].filter(Boolean).join(' · '),
      });
      await coverLookupActions.openTaskById(taskId);
      await coverLookupActions.waitForModalReady();
      await coverLookupActions.expectNotificationMobileSheet();
      expect(await coverLookupActions.readDrawerScrollTop()).toBe(drawerScrollTop);
      await expect(coverLookupActions.coverLookup.modalSubtitle).toHaveText([
        identity.artist,
        identity.album,
        identity.year,
      ].filter(Boolean).join(' - '));
      if (index === 1) {
        await coverLookupActions.coverLookup.modalSubtitle.click();
        const details = await trackModalActions.waitForLoadedSummary();
        expect(details.title).toContain(identity.album);
        expect(details.subtitle).toContain(identity.artist);
        await trackModalActions.close();
      } else if (swipeFirst && index === 0) {
        await coverLookupActions.swipeNotificationMobileSheetDown();
      } else {
        await coverLookupActions.closeModal();
      }
      await coverLookupActions.waitForDrawerOpen();
      expect(await coverLookupActions.readDrawerScrollTop()).toBe(drawerScrollTop);
    }
  };

  await verifyCardDestinations({ swipeFirst: true });
  const selected = notifications.at(-1);
  await coverLookupActions.openTaskById(selected.taskId);
  await coverLookupActions.waitForModalReady();
  await coverLookupActions.waitForModalResultsReady();
  await coverLookupActions.selectFirstRemoteCoverAndSave();
  await coverLookupActions.waitForDrawerOpen();
  expect(await coverLookupActions.readDrawerScrollTop()).toBe(drawerScrollTop);
  await coverLookupActions.waitForTaskStatusById(selected.taskId, 'Art chosen');
  expect(await readTargetOrder()).toEqual(orderBeforeSave);
  for (const { taskId } of notifications) {
    await coverLookupActions.waitForTaskCoverDecodedById(taskId);
  }

  const afterSave = await readCards();
  for (const { taskId } of notifications.slice(0, -1)) {
    expect(afterSave[taskId]).toEqual(before[taskId]);
  }
  expect(afterSave[selected.taskId].imageSrc).not.toBe(before[selected.taskId].imageSrc);
  expect({
    ...afterSave[selected.taskId],
    imageSrc: before[selected.taskId].imageSrc,
  }).toEqual(before[selected.taskId]);
  expect(new Set(Object.values(afterSave).map((evidence) => evidence.imageSrc)).size).toBe(3);
  await verifyCardDestinations();

  await coverLookupActions.closeDrawer();
  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForDrawerOpen();
  for (const { taskId } of notifications) {
    await coverLookupActions.waitForTaskCoverDecodedById(taskId);
  }
  expect(await readCards()).toEqual(afterSave);
  expect(await readTargetOrder()).toEqual(orderBeforeSave);
  await verifyCardDestinations();

  await coverLookupActions.closeDrawer();
  await page.reload();
  await galleryActions.waitForGalleryReady();
  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForDrawerOpen();
  expect(await readCards()).toEqual(afterSave);
  expect(await readTargetOrder()).toEqual(orderBeforeSave);
  await verifyCardDestinations();

  const clearResponse = await page.request.post('/utilities/cover-lookup/tasks/clear-completed', {
    data: {},
  });
  expect(clearResponse.ok()).toBe(true);
  await expect(coverLookupActions.coverLookup.taskCardById(selected.taskId)).toHaveCount(0);
  for (const { taskId } of notifications.slice(0, -1)) {
    await expect(coverLookupActions.coverLookup.taskCardById(taskId)).toHaveCount(1);
  }
});

test('FTC-COVERS-013 partial cover results survive drawer reopen, save cancellation, and reload', { tag: '@area:cover-providers' }, async ({
  galleryActions,
  coverLookupActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let taskTitle = '';
  let partialCandidateIds = [];
  let selectedRemoteCandidateId = '';
  let selectedRemoteCover = null;
  let selectedCoverPath = '';

  await stepLogger.step('Open the exact manifest-backed album and then open the full cover lookup gallery', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const selectedAlbum = await galleryActions.selectAlbumDetailsByIdentity(PARTIAL_COVER_LOOKUP_TARGET);
    expect(selectedAlbum).toEqual(PARTIAL_COVER_LOOKUP_TARGET);
    const modal = await trackModalActions.waitForLoadedSummary();
    expect(modal.title).toBe(Object.values(PARTIAL_COVER_LOOKUP_TARGET).join(' • '));
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = PARTIAL_COVER_LOOKUP_TARGET.album;
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.holdLaterProviderFixture();
  });

  await stepLogger.step('Use partial cover results while the deterministic later provider remains active', async () => {
    await stepLogger.substep('Start the lookup and observe the first partial candidate before completion', async () => {
      await coverLookupActions.startSearch();
      await coverLookupActions.waitForLaterProviderFixtureBlocked();
      partialCandidateIds = await coverLookupActions.waitForPartialRemoteCandidates();
      expect(partialCandidateIds.length).toBeGreaterThan(0);
      await coverLookupActions.expectNoPostgresConflictError();
      await coverLookupActions.closeModal();
      await trackModalActions.close();
    });
    await stepLogger.substep('Prove the task remains active and reopen its partial results through the drawer', async () => {
      await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
      await coverLookupActions.openDrawer();
      await coverLookupActions.waitForDrawerOpen();
      await coverLookupActions.waitForTaskActive(taskTitle);
      await coverLookupActions.expectTaskIdentity(taskTitle, PARTIAL_COVER_LOOKUP_TARGET);
      await coverLookupActions.openTask(taskTitle);
      await coverLookupActions.waitForModalReady({ timeout: 10000 });
      await coverLookupActions.waitForModalResultsReady({ timeout: 10000 });
      expect(await coverLookupActions.readRemoteCandidateIds()).toEqual(partialCandidateIds);
      await coverLookupActions.expectNoPostgresConflictError();
      await coverLookupActions.closeModal();
      expect(await galleryActions.selectAlbumDetailsByIdentity(PARTIAL_COVER_LOOKUP_TARGET))
        .toEqual(PARTIAL_COVER_LOOKUP_TARGET);
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady({ timeout: 10000 });
      await coverLookupActions.waitForModalResultsReady({ timeout: 10000 });
      expect(await coverLookupActions.readRemoteCandidateIds()).toEqual(partialCandidateIds);
    });
  });

  await stepLogger.step('Save the partial result and cancel unnecessary remaining fake-provider work', async () => {
    const selection = await coverLookupActions.selectFirstRemoteCoverAndSave({
      stableCoverLocator: trackModalActions.trackModal.detailedCoverImage,
    });
    selectedRemoteCandidateId = selection.candidateId;
    selectedRemoteCover = selection.candidate;
    selectedCoverPath = String(selection.payload?.optimistic_cover_path || '').trim();
    expect(selectedRemoteCover.sha256).toBeTruthy();
    expect(selectedCoverPath).toBeTruthy();
    expect(selection.immediateCoverState).not.toBeNull();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Art chosen', { timeout: 120000 });
    await coverLookupActions.releaseLaterProviderFixture();
    const providerEvidence = await coverLookupActions.waitForLaterProviderCancellationEvidence();
    expect(providerEvidence).toMatchObject({
      cover_art_archive_requests: 0,
      later_provider_released: true,
    });
    expect(providerEvidence.musicbrainz_started).toBeGreaterThanOrEqual(1);
    expect(providerEvidence.musicbrainz_started).toBeLessThanOrEqual(2);
    expect(providerEvidence.musicbrainz_completed).toBeGreaterThanOrEqual(0);
    expect(providerEvidence.musicbrainz_completed).toBeLessThanOrEqual(
      providerEvidence.musicbrainz_started,
    );
  });

  await stepLogger.step('Reload and prove delayed provider work neither appends nor clobbers the saved partial result', async () => {
    await coverLookupActions.reloadAndOpenDrawer();
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Art chosen');
    await coverLookupActions.openTask(taskTitle);
    await coverLookupActions.waitForModalReady({ timeout: 10000 });
    await coverLookupActions.waitForModalResultsReady({ timeout: 10000 });
    expect(await coverLookupActions.readRemoteCandidateIds()).toEqual(partialCandidateIds);
    await coverLookupActions.expectNoPostgresConflictError();

    const persistedSelectedRemoteCover = await coverLookupActions.readRemoteCandidateEvidence(
      selectedRemoteCandidateId,
    );
    const persistedCandidateSummary = (await coverLookupActions.readRemoteCandidateSummaries())
      .find((candidate) => candidate.id === selectedRemoteCandidateId);

    const modal = await coverLookupActions.inspectModalComponents();

    expect(modal.subtitle).toBe(Object.values(PARTIAL_COVER_LOOKUP_TARGET).join(' - '));
    expect(modal.hasFindBetterButton).toBe(true);
    expect(modal.hasSaveButton).toBe(true);
    expect(modal.hasManualInput).toBe(true);
    expect(modal.hasManualExtractButton).toBe(true);
    expect(modal.localCards).toBeGreaterThan(0);
    expect(modal.serviceCards).toBeGreaterThan(0);
    expect(modal.openLightboxButtons).toBeGreaterThan(1);
    expect(modal.savedRemoteCards).toBe(0);
    expect(modal.sectionTitles).toEqual([
      `LOCAL · ${modal.localCards} image${modal.localCards === 1 ? '' : 's'}`,
      `POSSIBLE MATCHES · ${partialCandidateIds.length} image${partialCandidateIds.length === 1 ? '' : 's'}`,
    ]);
    expect(modal.subsectionTitles).toEqual(expect.arrayContaining([
      'From services',
    ]));
    expect(modal.subsectionTitles).not.toContain('MANUAL LINKS');
    expect(modal.subsectionTitles).not.toContain('MANUAL LINKS - OTHER REMOTE ART');
    expect(modal.subsectionTitles).not.toContain('Cover Art Archive');
    expect(modal.subsectionTitles).not.toContain('OTHER COVER ART');

    const googleChip = modal.searchChips.find((chip) => chip.label.includes('Google'));
    const yandexChip = modal.searchChips.find((chip) => chip.label.includes('Yandex'));
    expect(googleChip?.href || '').toContain('google.com/search?tbm=isch');
    expect(yandexChip?.href || '').toContain('yandex.com/images/search?text=');

    expect(modal.activeLocalCover.sha256).toBeTruthy();
    expect(modal.activeLocalCover.coverPath).toBe(selectedCoverPath);
    expect(persistedSelectedRemoteCover.sha256).toBe(selectedRemoteCover.sha256);
    expect(persistedCandidateSummary?.selected).toBe(false);
    expect((await coverLookupActions.readLocalCoverNames())
      .some((name) => /^cover-existing-/i.test(name))).toBe(false);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-040 failed accepted save restores prior art and keeps its notification', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  coverLookupActions,
  galleryActions,
  trackModalActions,
}, testInfo) => {
  testInfo.setTimeout(180000);

  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  expect(await galleryActions.selectAlbumDetailsByIdentity(PARTIAL_COVER_LOOKUP_TARGET))
    .toEqual(PARTIAL_COVER_LOOKUP_TARGET);
  await trackModalActions.waitForLoadedSummary();
  const previousCover = await trackModalActions.trackModal.readDetailedCoverImageCheckpoint();
  expect(previousCover.complete).toBe(true);
  expect(previousCover.naturalWidth).toBeGreaterThan(0);

  await trackModalActions.openCoverLookup();
  await coverLookupActions.waitForModalReady();
  await coverLookupActions.setProviderFixtureMode('normal');
  await coverLookupActions.holdLaterProviderFixture();
  const started = await coverLookupActions.startSearch();
  const taskId = String(started.task?.id || '').trim();
  expect(taskId).not.toBe('');
  await coverLookupActions.waitForLaterProviderFixtureBlocked();
  await coverLookupActions.waitForPartialRemoteCandidates();
  const appleCandidate = (await coverLookupActions.readRemoteCandidateSummaries())
    .find((candidate) => /apple/i.test(candidate.source));
  expect(appleCandidate?.id).toBeTruthy();
  await coverLookupActions.selectRemoteCandidateById(appleCandidate.id);
  await coverLookupActions.setProviderFixtureMode('failed-image');

  const saved = await coverLookupActions.saveSelectedRemoteCandidate({ timeout: 30000 });
  expect(String(saved.payload?.task?.id || '')).toBe(taskId);
  await expect(appBarActions.appBar.errorToasts).toHaveCount(1, { timeout: 30000 });
  await expect(appBarActions.appBar.errorToasts).toContainText(/failed|could not/i);
  await expect.poll(
    async () => (await trackModalActions.trackModal.readDetailedCoverImageCheckpoint()).productionSrc,
    { timeout: 30000 },
  ).toBe(previousCover.productionSrc);

  await trackModalActions.close();
  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForDrawerOpen();
  await coverLookupActions.waitForTaskStatusById(taskId, 'Lookup failed');
  const retainedTask = coverLookupActions.coverLookup.taskCardById(taskId);
  await expect(retainedTask).toHaveCount(1);
  await expect(retainedTask).not.toContainText('Art chosen');
  await coverLookupActions.setProviderFixtureMode('normal');
});

test('FTC-COVERS-035 persisted notification candidates remain visible and save after app restart', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  freshBrowserSession,
  galleryActions,
  managedAppLifecycle,
  page,
  stepLogger,
  trackModalActions,
}) => {
  test.setTimeout(180_000);
  let candidateId = '';
  let taskId = '';

  await stepLogger.step('Complete and persist a provider lookup before restart', async () => {
    await coverLookupActions.setProviderFixtureMode('selection-concurrency-a');
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    const started = await coverLookupActions.startSearch();
    taskId = String(started.task?.id || '').trim();
    expect(taskId).not.toBe('');
    await coverLookupActions.waitForModalSearchCompleted();
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    candidateId = String(candidates[0]?.id || '').trim();
    expect(candidateId).not.toBe('');
    await coverLookupActions.closeModal();
    await trackModalActions.close();
  });

  await stepLogger.step('Restart, show honest drawer loading, and reopen cached candidates', async () => {
    await page.goto('about:blank');
    await managedAppLifecycle.restart();
    const restarted = await freshBrowserSession.create();
    await restarted.galleryActions.goto();
    const loading = await restarted.coverLookupActions.openDrawerAndObserveInitialLoading();
    expect(loading).toMatchObject({ loadingSeen: true, falseEmptySeen: false });
    await restarted.coverLookupActions.waitForTaskStatusById(taskId, /^[1-9]\d* covers? found$/);
    await restarted.coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await restarted.galleryActions.waitForGalleryReady();

    await restarted.coverLookupActions.openTask(PROGRESSIVE_CANDIDATE_TARGET.album);
    await restarted.coverLookupActions.waitForModalReady();
    await restarted.coverLookupActions.coverLookup.waitForDrawerState(true);
    await restarted.coverLookupActions.waitForRemoteCandidateId(candidateId);
    await expect(
      restarted.coverLookupActions.coverLookup.remoteCoverCardById(candidateId),
    ).toBeVisible();

      await restarted.coverLookupActions.selectRemoteCandidateById(candidateId);
      const [findBetterBox, cancelBox, saveBox] = await Promise.all([
        restarted.coverLookupActions.coverLookup.findBetterButton.boundingBox(),
        restarted.coverLookupActions.coverLookup.cancelButton.boundingBox(),
        restarted.coverLookupActions.coverLookup.saveRemoteButton.boundingBox(),
      ]);
      expect(findBetterBox).not.toBeNull();
      expect(cancelBox).not.toBeNull();
      expect(saveBox).not.toBeNull();
      expect(Math.abs(cancelBox.y - findBetterBox.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(saveBox.y - findBetterBox.y)).toBeLessThanOrEqual(1);
      expect(cancelBox.x).toBeGreaterThan(findBetterBox.x + findBetterBox.width);
      expect(saveBox.x).toBeGreaterThan(cancelBox.x + cancelBox.width);
      const saved = await restarted.coverLookupActions.saveSelectedRemoteCandidate();
    expect(saved.requestPayload.candidate_id).toBe(candidateId);
    await restarted.coverLookupActions.waitForTaskStatusById(taskId, 'Art chosen', {
      timeout: 120_000,
    });
    await restarted.coverLookupActions.closeDrawer();
  });
});

test('FTC-COVERS-019 Spotify stays linked while a downloadable provider reopens locally', { tag: '@area:cover-providers' }, async ({
  galleryActions,
  coverLookupActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let spotifyCandidate = null;
  let appleCandidate = null;
  let baselineLocalCover = null;

  await stepLogger.step('Open fixture-seeded provider candidates without starting a search', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROVIDER_STORAGE_POLICY_TARGET))
      .toEqual(PROVIDER_STORAGE_POLICY_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    baselineLocalCover = await coverLookupActions.readActiveLocalCoverEvidence();
    expect(baselineLocalCover.image.sha256).toBeTruthy();
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    spotifyCandidate = candidates.find(
      (candidate) => candidate.source.toLocaleLowerCase() === 'spotify',
    );
    appleCandidate = candidates.find(
      (candidate) => candidate.source === 'Apple Music',
    );
    expect(spotifyCandidate?.id).toBeTruthy();
    expect(appleCandidate?.id).toBeTruthy();
  });

  await stepLogger.step('Save Spotify and retain it as the selected linked remote cover', async () => {
    const payload = await coverLookupActions.selectRemoteCandidateByIdAndSave(spotifyCandidate.id);
    expect(payload.optimistic_cover_path).toBe('');
    expect(payload.optimistic_remote_source).toBe('spotify');
    const reopened = await coverLookupActions.reopenUntilSavedRemoteCoverIsActive(
      () => trackModalActions.openCoverLookup(),
      'SPOTIFY',
      spotifyCandidate.id,
    );
    expect(reopened.source).toBe('SPOTIFY');
    const reopenedSpotify = reopened.remoteCandidates
      .find((candidate) => candidate.id === spotifyCandidate.id);
    expect(reopenedSpotify?.selected).toBe(false);
  });

  await stepLogger.step('Save Apple and reopen canonical local art with no selected remote card', async () => {
    const payload = await coverLookupActions.selectRemoteCandidateByIdAndSave(appleCandidate.id);
    expect(payload.optimistic_cover_path).toMatch(/[\\/]cover\.jpg$/i);
    expect(payload.optimistic_remote_source).toBe('apple');
    const reopened = await coverLookupActions.reopenUntilLocalCoverIsActive(
      () => trackModalActions.openCoverLookup(),
    );
    const activeLocalCover = reopened.activeLocalCover;
    expect(activeLocalCover.sourcePath).toMatch(/[\\/]cover\.jpg$/i);
    const reopenedApple = reopened.remoteCandidates
      .find((candidate) => candidate.id === appleCandidate.id);
    expect(reopenedApple?.selected).toBe(false);
    expect(reopened.remoteCandidates.some((candidate) => candidate.selected)).toBe(false);
    const reserveCover = (await coverLookupActions.readLocalCoverCandidates())
      .find((candidate) => /^cover-existing-/i.test(candidate.name));
    expect(reserveCover?.image.sha256).toBe(baselineLocalCover.image.sha256);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-039 stale split identity stays open and chooses an exact current release', { tag: '@area:cover-providers' }, async ({
  page,
  galleryActions,
  trackModalActions,
  coverLookupActions,
  tagEditorActions,
}) => {
  let splitApplied = false;
  let taskId = '';
  let candidateId = '';
  try {
    const artistUrl = `/?surface=albums&artist=${encodeURIComponent(SPLIT_FIXTURE.artist)}`;
    const sourceIdentity = {
      album: SPLIT_FIXTURE.album,
      artist: SPLIT_FIXTURE.artist,
      year: SPLIT_FIXTURE.year,
    };
    await galleryActions.goto(artistUrl);
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(sourceIdentity))
      .toEqual(sourceIdentity);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalResultsReady();
    await coverLookupActions.setProviderFixtureMode('split-identity');
    const task = await coverLookupActions.startSearch();
    taskId = String(task.task?.id || '').trim();
    expect(taskId).not.toBe('');
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1, { timeout: 120_000 });
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    candidateId = String(candidates[0]?.id || '').trim();
    expect(candidateId).not.toBe('');
    await coverLookupActions.closeModal();
    await trackModalActions.closeIfOpen();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForTaskStatusById(taskId, /^[1-9]\d* covers? found$/);
    await coverLookupActions.closeDrawer();

    await tagEditorActions.openForAlbum({
      album: SPLIT_FIXTURE.album,
      artist: SPLIT_FIXTURE.artist,
      expectedTrackCount: 16,
      galleryActions,
      trackModalActions,
      year: SPLIT_FIXTURE.year,
    });
    await tagEditorActions.selectTracksByFilenames(SPLIT_FIXTURE.filenames);
    await tagEditorActions.setAlbumName(SPLIT_FIXTURE.splitAlbum);
    await tagEditorActions.applyAndWaitForSavedFiles();
    splitApplied = true;
    await trackModalActions.closeIfOpen();

    await coverLookupActions.openDrawer();
    await coverLookupActions.openTaskWithKeyboard(SPLIT_FIXTURE.album, 'Enter');
    const selector = page.getByRole('group', {
      name: 'This album was split—choose the current release',
    });
    await expect(selector).toBeVisible();
    const requestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/utilities/cover-lookup/gallery'
    ));
    await selector.getByRole('button', { name: new RegExp(SPLIT_FIXTURE.splitAlbum) }).click();
    const request = await requestPromise;

    await expect(coverLookupActions.coverLookup.modal).toBeVisible();
    await coverLookupActions.waitForModalResultsReady();
    await expect(selector).toHaveCount(0);
    await expect(coverLookupActions.coverLookup.modalSubtitle).toContainText(SPLIT_FIXTURE.splitAlbum);
    expect(request.postDataJSON()).toMatchObject({
      album: expect.objectContaining({ name: SPLIT_FIXTURE.splitAlbum }),
      task_id: taskId,
    });
    await expect(page.getByText('Lookup task does not belong to this album')).toHaveCount(0);
    await coverLookupActions.waitForRemoteCandidateId(candidateId);
    const saved = await coverLookupActions.selectRemoteCandidateByIdAndSave(candidateId);
    expect(saved.requestPayload).toMatchObject({
      album: expect.objectContaining({ name: SPLIT_FIXTURE.splitAlbum }),
      candidate_id: candidateId,
      task_id: taskId,
    });
  } finally {
    if (await coverLookupActions.coverLookup.modal.isVisible()) {
      await coverLookupActions.closeModal();
    }
    await coverLookupActions.closeDrawer();
    await trackModalActions.closeIfOpen();
    if (splitApplied) {
      await tagEditorActions.openForAlbum({
        album: SPLIT_FIXTURE.splitAlbum,
        artist: SPLIT_FIXTURE.artist,
        expectedTrackCount: SPLIT_FIXTURE.filenames.length,
        galleryActions,
        trackModalActions,
        year: SPLIT_FIXTURE.year,
      });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(SPLIT_FIXTURE.album);
      await tagEditorActions.applyAndWaitForSavedFiles();
      await trackModalActions.closeIfOpen();
    }
    if (taskId) {
      await coverLookupActions.openDrawer();
      await coverLookupActions.clearTask(SPLIT_FIXTURE.album);
      await coverLookupActions.closeDrawer();
    }
  }
});

test('FTC-COVERS-037 local cover deletion stays foreground, works, and persists after reopen', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  page,
  stepLogger,
  trackModalActions,
}) => {
  test.setTimeout(120_000);
  let deletedPath = '';
  let ownedPath = '';

  try {
    await stepLogger.step('Delete an inactive local cover through the foreground confirmation', async () => {
      await galleryActions.goto(COVER_LOOKUP_FILTERED_URL);
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
        .toEqual(COVER_LOOKUP_TARGET);
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady();
      const candidates = await coverLookupActions.readLocalCoverCandidates();
      const sourceCandidate = candidates.find((item) => (
        !item.isActive && /[\\/]Art[\\/]Back\.jpg$/i.test(item.sourcePath)
      ));
      expect(sourceCandidate).not.toBeUndefined();
      ownedPath = path.join(path.dirname(sourceCandidate.sourcePath), `delete-e2e-${process.pid}.jpg`);
      fs.copyFileSync(sourceCandidate.sourcePath, ownedPath);
      await coverLookupActions.closeModal();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady();
      const ownedCandidates = await coverLookupActions.readLocalCoverCandidates();
      const candidate = ownedCandidates.find((item) => item.sourcePath === ownedPath);
      expect(candidate).not.toBeUndefined();
      deletedPath = candidate.sourcePath;
      expect(fs.existsSync(deletedPath)).toBe(true);

      const result = await coverLookupActions.deleteLocalCoverBySourcePath(deletedPath);

      expect(result.stacking.confirmationZIndex).toBeGreaterThan(result.stacking.lookupZIndex);
      expect(result.stacking.confirmationOwnsTopElement).toBe(true);
      expect(fs.existsSync(deletedPath)).toBe(false);
      await expect(coverLookupActions.coverLookup.modal).toBeVisible();
    });

    await stepLogger.step('Reload and prove the deleted local cover does not return', async () => {
      await coverLookupActions.closeModal();
      await trackModalActions.close();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
        .toEqual(COVER_LOOKUP_TARGET);
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady();
      const reopened = await coverLookupActions.readLocalCoverCandidates();
      expect(reopened.map((candidate) => candidate.sourcePath)).not.toContain(deletedPath);
      expect(fs.existsSync(deletedPath)).toBe(false);
    });
  } finally {
    if (ownedPath && fs.existsSync(ownedPath)) fs.unlinkSync(ownedPath);
  }
});

test('FTC-COVERS-011 selected local art remains authoritative after rescan and app restart', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  coverLookupActions,
  freshBrowserSession,
  galleryActions,
  managedAppLifecycle,
  page,
  stepLogger,
  trackModalActions,
}) => {
  test.setTimeout(180_000);

  let originalActiveCover = null;
  let selectedLocalCover = null;
  let initialUnusedCandidatePaths = [];
  let selectedCoverPath = '';
  let originalPreviewHash = '';
  let originalPreviewRevision = '';
  let selectedPreviewHash = '';
  let selectedPreviewRevision = '';
  let selectedSourceFullSizeHash = '';
  let filteredPathAndSearch = '';
  let restartedSession = null;

  await stepLogger.step('Require the managed isolated Postgres app before changing fixture cover files', async () => {
    expect(process.env.PLAYWRIGHT_MANAGED_APP).toBe('1');
    const tempRoot = path.resolve(String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || ''));
    const controlDirectory = path.resolve(
      String(process.env.ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR || ''),
    );
    const relativeControlDirectory = path.relative(tempRoot, controlDirectory);
    expect(String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || '')).not.toBe('');
    expect(String(process.env.ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR || '')).not.toBe('');
    expect(relativeControlDirectory).not.toBe('');
    expect(relativeControlDirectory.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relativeControlDirectory)).toBe(false);
    const databaseUrl = new URL(String(process.env.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL || ''));
    expect(databaseUrl.pathname).toMatch(
      /^\/album_haven_(?:fake_e2e|ci_[a-z0-9]+(?:_[a-z0-9]+)*)$/,
    );
  });

  await stepLogger.step('Open filtered Crack The Skye results with canonical cover.jpg active and record the nested candidates', async () => {
    await galleryActions.goto(COVER_LOOKUP_FILTERED_URL);
    await galleryActions.waitForGalleryReady();
    const filteredLocation = new URL(page.url());
    filteredPathAndSearch = `${filteredLocation.pathname}${filteredLocation.search}`;
    expect(filteredPathAndSearch).toBe(COVER_LOOKUP_FILTERED_URL);
    await galleryActions.scrollToAlbumUnderHeading(
      COVER_LOOKUP_TARGET.artist,
      COVER_LOOKUP_TARGET.album,
    );
    const originalCardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(COVER_LOOKUP_TARGET.album),
      'initial gallery card canonical cover',
    );
    expect(originalCardCover.coverPath).toMatch(/[\\/]cover\.jpg$/i);
    originalPreviewHash = originalCardCover.sha256;
    originalPreviewRevision = originalCardCover.coverRevision;
    expect(originalPreviewHash).not.toBe('');
    expect(originalPreviewRevision).not.toBe('');
    expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
      .toEqual(COVER_LOOKUP_TARGET);
    expect((await trackModalActions.waitForLoadedSummary()).title)
      .toBe('Mastodon • Crack The Skye • 2009');
    const originalDetailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'initial detail canonical cover',
    );
    expect(originalDetailCover.coverPath).toMatch(/[\\/]cover\.jpg$/i);
    expect(originalDetailCover.sha256).toBe(originalPreviewHash);
    expect(originalDetailCover.coverRevision).toBe(originalPreviewRevision);
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await expect(coverLookupActions.coverLookup.saveRemoteButton).toBeDisabled();
    const candidates = await coverLookupActions.readLocalCoverCandidates();
    initialUnusedCandidatePaths = candidates
      .filter((candidate) => !candidate.isActive)
      .map((candidate) => candidate.sourcePath)
      .sort();
    expect(candidates.some((candidate) => (
      /[\\/]album-haven-preview(?:-[^\\/]*)?\.[^.\\/]+$/i.test(candidate.sourcePath)
    ))).toBe(false);
    originalActiveCover = candidates.find((candidate) => candidate.isActive) || null;
    selectedLocalCover = candidates.find((candidate) => (
      !candidate.isActive && /[\\/]Art[\\/]Front\.jpg$/i.test(candidate.sourcePath)
    )) || null;
    const originalBytesDuplicate = candidates.find((candidate) => (
      /[\\/]Art[\\/]CD\.JPG$/i.test(candidate.sourcePath)
    )) || null;
    const competingBackCover = candidates.find((candidate) => (
      /[\\/]Art[\\/]Back\.jpg$/i.test(candidate.sourcePath)
    )) || null;
    expect(originalActiveCover).not.toBeNull();
    expect(originalActiveCover.sourcePath).toMatch(/[\\/]cover\.jpg$/i);
    expect(selectedLocalCover).not.toBeNull();
    expect(originalBytesDuplicate).not.toBeNull();
    expect(competingBackCover).not.toBeNull();
    expect(originalActiveCover.image.sha256).not.toBe('');
    expect(originalActiveCover.image.sha256).toBe(originalPreviewHash);
    expect(originalPreviewRevision.toLowerCase())
      .toBe(originalActiveCover.image.coverRevision.toLowerCase());
    expect(selectedLocalCover.image.sha256).not.toBe('');
    expect(originalBytesDuplicate.image.sha256).toBe(originalActiveCover.image.sha256);
    expect(competingBackCover.image.sha256).not.toBe('');
    expect(selectedLocalCover.image.sha256).not.toBe(originalActiveCover.image.sha256);
    expect(competingBackCover.image.sha256).not.toBe(originalActiveCover.image.sha256);
    expect(competingBackCover.image.sha256).not.toBe(selectedLocalCover.image.sha256);
    expect(selectedLocalCover.sourcePath).not.toBe(originalActiveCover.sourcePath);
  });

  await stepLogger.step('Keep nested local-cover previews in app data', async () => {
    const tempRoot = path.resolve(String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || ''));
    expect(String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || '')).not.toBe('');
    expect(selectedLocalCover.sourcePath).toMatch(/[\\/]Art[\\/]Front\.jpg$/i);
    expect(fs.existsSync(path.join(tempRoot, 'app-data', 'display-cover-cache'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(selectedLocalCover.sourcePath), '.album-haven'))).toBe(false);
  });

  await stepLogger.step('Save nested Front.jpg over canonical cover.jpg and verify every immediate surface', async () => {
    const saved = await coverLookupActions.selectLocalCoverByNameAndSave(
      selectedLocalCover.name,
      { stableCoverLocator: trackModalActions.trackModal.detailedCoverImage },
    );
    await expect(coverLookupActions.coverLookup.modal).toBeHidden();
    expect(saved.immediateCoverState).not.toBeNull();
    expect(saved.candidate.sourcePath).toBe(selectedLocalCover.sourcePath);
    expect(saved.candidate.image.sha256).toBe(selectedLocalCover.image.sha256);
    expect(saved.candidateFullSize.coverPath).toBe(selectedLocalCover.sourcePath);
    expect(saved.candidateFullSize.sha256).toMatch(/^[A-F0-9]{64}$/);
    selectedSourceFullSizeHash = saved.candidateFullSize.sha256;
    selectedCoverPath = saved.selectedCoverPath;
    expect(selectedCoverPath).toMatch(/[\\/]cover\.jpg$/i);
    expect(String(saved.updatedAlbum?.cover_path || '')).toBe(selectedCoverPath);
    selectedPreviewRevision = String(saved.updatedAlbum?.cover_revision || '').trim();
    expect(selectedPreviewRevision).not.toBe('');
    expect(selectedPreviewRevision).not.toBe(originalPreviewRevision);
    expect(selectedPreviewRevision).toMatch(/^[a-f0-9]{64}$/i);
    expect(selectedPreviewRevision.toUpperCase()).toBe(selectedSourceFullSizeHash);
    const persistedCanonicalCover = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: selectedCoverPath,
      coverRevision: selectedPreviewRevision,
      label: 'persisted canonical cover after local selection',
    });
    expect(persistedCanonicalCover.coverPath).toBe(selectedCoverPath);
    expect(persistedCanonicalCover.coverRevision).toBe(selectedPreviewRevision);
    expect(persistedCanonicalCover.sha256).toBe(selectedSourceFullSizeHash);
    await trackModalActions.waitForLoadedSummary();
    const detailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'detail cover after local selection',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    selectedPreviewHash = detailCover.sha256;
    expect(selectedPreviewHash).not.toBe('');
    expect(selectedPreviewHash).toBe(selectedLocalCover.image.sha256);
    expect(selectedPreviewHash).not.toBe(originalPreviewHash);
    expect(detailCover.coverRevision).toBe(selectedPreviewRevision);
    await trackModalActions.close();
    await galleryActions.scrollToAlbumUnderHeading(
      COVER_LOOKUP_TARGET.artist,
      COVER_LOOKUP_TARGET.album,
    );
    const cardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(COVER_LOOKUP_TARGET.album),
      'gallery card cover after local selection',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(cardCover.sha256).toBe(selectedPreviewHash);
    expect(cardCover.coverRevision).toBe(selectedPreviewRevision);

    expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
      .toEqual(COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await expect(coverLookupActions.coverLookup.saveRemoteButton).toHaveText('Save');
    const reopenedCandidates = await coverLookupActions.readLocalCoverCandidates();
    expect(reopenedCandidates.map((candidate) => candidate.sourcePath).sort())
      .toEqual(initialUnusedCandidatePaths);
    const reopenedActiveCover = reopenedCandidates.find((candidate) => candidate.isActive) || null;
    const reopenedExistingCopies = reopenedCandidates.filter((candidate) => (
      /[\\/]cover-existing-\d+\.jpg$/i.test(candidate.sourcePath)
    ));
    const reopenedOriginalSource = reopenedCandidates.find((candidate) => (
      /[\\/]Art[\\/]CD\.JPG$/i.test(candidate.sourcePath)
      && candidate.image.sha256 === originalActiveCover.image.sha256
    )) || null;
    expect(reopenedActiveCover).not.toBeNull();
    expect(reopenedActiveCover.sourcePath).toBe(selectedLocalCover.sourcePath);
    expect(reopenedActiveCover.image.sha256).toBe(selectedLocalCover.image.sha256);
    expect(reopenedActiveCover.image.coverRevision).toBe(selectedPreviewRevision);
    expect(reopenedExistingCopies).toHaveLength(0);
    expect(reopenedOriginalSource).not.toBeNull();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
  });

  await stepLogger.step('Reload the same app process before rescan and retain the selected cover bytes', async () => {
    const beforeReloadLocation = new URL(page.url());
    expect(`${beforeReloadLocation.pathname}${beforeReloadLocation.search}`)
      .toBe(filteredPathAndSearch);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedLocation = new URL(page.url());
    expect(`${reloadedLocation.pathname}${reloadedLocation.search}`)
      .toBe(filteredPathAndSearch);
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(
      COVER_LOOKUP_TARGET.artist,
      COVER_LOOKUP_TARGET.album,
    );
    const cardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(COVER_LOOKUP_TARGET.album),
      'gallery card cover after immediate page reload',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(cardCover.sha256).toBe(selectedPreviewHash);
    expect(cardCover.sha256).not.toBe(originalPreviewHash);
    expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
      .toEqual(COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    const detailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'detail cover after immediate page reload',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(detailCover.sha256).toBe(selectedPreviewHash);
    expect(detailCover.sha256).not.toBe(originalPreviewHash);
    await trackModalActions.close();
  });

  await stepLogger.step('Run a full rescan and confirm the card and detail view still render the selected bytes', async () => {
    await appBarActions.triggerFullRescanAndWait();
    await galleryActions.goto(filteredPathAndSearch);
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(
      COVER_LOOKUP_TARGET.artist,
      COVER_LOOKUP_TARGET.album,
    );
    const cardCover = await coverLookupActions.readDisplayedImageEvidence(
      galleryActions.albumCoverByName(COVER_LOOKUP_TARGET.album),
      'gallery card cover after rescan',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(cardCover.sha256).toBe(selectedPreviewHash);
    expect(await galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
      .toEqual(COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    const detailCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'detail cover after rescan',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(detailCover.sha256).toBe(selectedPreviewHash);
    await trackModalActions.close();
  });

  await stepLogger.step('Restart the real app process and verify fresh card and detail hydration', async () => {
    await page.goto('about:blank');
    await managedAppLifecycle.restart();
    restartedSession = await freshBrowserSession.create();
    expect(restartedSession.context).not.toBe(page.context());
    await restartedSession.galleryActions.goto(filteredPathAndSearch);
    await restartedSession.galleryActions.waitForGalleryReady();
    await restartedSession.galleryActions.scrollToAlbumUnderHeading(
      COVER_LOOKUP_TARGET.artist,
      COVER_LOOKUP_TARGET.album,
    );
    const cardCover = await restartedSession.coverLookupActions.readDisplayedImageEvidence(
      restartedSession.galleryActions.albumCoverByName(COVER_LOOKUP_TARGET.album),
      'gallery card cover after app restart in a fresh browser session',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(cardCover.sha256).toBe(selectedPreviewHash);
    expect(await restartedSession.galleryActions.selectAlbumDetailsByIdentity(COVER_LOOKUP_TARGET))
      .toEqual(COVER_LOOKUP_TARGET);
    await restartedSession.trackModalActions.waitForLoadedSummary();
    const detailCover = await restartedSession.coverLookupActions.readDisplayedImageEvidence(
      restartedSession.trackModalActions.trackModal.detailedCoverImage,
      'detail cover after app restart in a fresh browser session',
      {
        expectedCoverPath: selectedCoverPath,
        expectedCoverRevision: selectedPreviewRevision,
      },
    );
    expect(detailCover.sha256).toBe(selectedPreviewHash);
  });

  await stepLogger.step('Reopen local covers and prove the selected bytes are active without a generated existing-cover copy', async () => {
    await restartedSession.trackModalActions.openCoverLookup();
    await restartedSession.coverLookupActions.waitForModalReady();
    const candidates = await restartedSession.coverLookupActions.readLocalCoverCandidates();
    const activeCover = candidates.find((candidate) => candidate.isActive) || null;
    const existingCopies = candidates.filter((candidate) => (
      /[\\/]cover-existing-\d+\.jpg$/i.test(candidate.sourcePath)
    ));
    const originalSource = candidates.find((candidate) => (
      /[\\/]Art[\\/]CD\.JPG$/i.test(candidate.sourcePath)
      && candidate.image.sha256 === originalActiveCover.image.sha256
    )) || null;
    expect(activeCover).not.toBeNull();
    expect(activeCover.sourcePath).toBe(selectedLocalCover.sourcePath);
    expect(activeCover.image.sha256).toBe(selectedLocalCover.image.sha256);
    expect(activeCover.image.coverRevision).toBe(selectedPreviewRevision);
    expect(existingCopies).toHaveLength(0);
    expect(originalSource).not.toBeNull();
  });

  await stepLogger.step('Select a larger encoding of the active local art without creating another existing-cover copy', async () => {
    const beforeCandidates = await restartedSession.coverLookupActions.readLocalCoverCandidates();
    const existingCopiesBefore = beforeCandidates.filter((candidate) => (
      /[\\/]cover-existing-\d+\.jpg$/i.test(candidate.sourcePath)
    ));
    const largerSameArt = beforeCandidates.find((candidate) => (
      /[\\/]Art[\\/]Front-Larger\.jpg$/i.test(candidate.sourcePath)
    )) || null;
    expect(existingCopiesBefore).toHaveLength(0);
    expect(largerSameArt).not.toBeNull();

    const saved = await restartedSession.coverLookupActions.selectLocalCoverByNameAndSave(
      largerSameArt.name,
      { stableCoverLocator: restartedSession.trackModalActions.trackModal.detailedCoverImage },
    );
    expect(saved.immediateCoverState).not.toBeNull();
    await restartedSession.trackModalActions.waitForLoadedSummary();
    await restartedSession.trackModalActions.openCoverLookup();
    await restartedSession.coverLookupActions.waitForModalReady();
    const afterCandidates = await restartedSession.coverLookupActions.readLocalCoverCandidates();
    const existingCopiesAfter = afterCandidates.filter((candidate) => (
      /[\\/]cover-existing-\d+\.jpg$/i.test(candidate.sourcePath)
    ));
    const activeCover = afterCandidates.find((candidate) => candidate.isActive) || null;
    expect(existingCopiesAfter).toHaveLength(0);
    expect(activeCover).not.toBeNull();
    expect(activeCover.image.sha256).toBe(largerSameArt.image.sha256);
  });
});

test('FTC-COVERS-017 manual lookup progressively retains provider alternatives', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  page,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let taskTitle = '';
  let overrideCandidateId = '';
  let completedCandidateIds = [];
  let completedProviderEvidence = null;

  await stepLogger.step('Open the isolated album and start a staged all-provider lookup', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = PROGRESSIVE_CANDIDATE_TARGET.album;
    const fixtureCover = findFixtureCoverBySubtitle(
      Object.values(MANUAL_PROVIDER_COVER).join(' - '),
    );
    expect(fixtureCover).not.toBeNull();
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(fixtureCover));
    await coverLookupActions.holdLaterProviderFixture();
    await coverLookupActions.startSearch();
    await coverLookupActions.waitForLaterProviderFixtureBlocked();
    await coverLookupActions.waitForDiscogsFixtureStarted();
  });

  await stepLogger.step('Override the best partial candidate before later providers finish', async () => {
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(2);
    const partialCandidates = await coverLookupActions.readRemoteCandidateSummaries();
    const automaticallySelected = partialCandidates.filter((candidate) => candidate.selected);
    expect(automaticallySelected).toHaveLength(1);
    overrideCandidateId = partialCandidates.find(
      (candidate) => candidate.id !== automaticallySelected[0].id,
    )?.id || '';
    expect(overrideCandidateId).not.toBe('');
    await coverLookupActions.selectRemoteCandidateById(overrideCandidateId);
    expect(await coverLookupActions.readSelectedRemoteCandidateId()).toBe(overrideCandidateId);
  });

  await stepLogger.step('Release later providers and preserve the pending user override', async () => {
    await coverLookupActions.releaseLaterProviderFixture();
    await coverLookupActions.waitForModalSearchCompleted();
    await coverLookupActions.waitForRemoteCandidateId(overrideCandidateId);
    await coverLookupActions.waitForSelectedRemoteCandidateId(overrideCandidateId);
    const completedCandidates = await coverLookupActions.readRemoteCandidateSummaries();
    completedCandidateIds = completedCandidates.map((candidate) => candidate.id);
    expect(completedCandidateIds).toContain(overrideCandidateId);
    expect(completedCandidateIds.length).toBeGreaterThanOrEqual(2);
    expect(completedCandidateIds.length).toBeLessThanOrEqual(24);
    expect(completedCandidates.every((candidate) => candidate.source.length > 0)).toBe(true);
    expect(completedCandidates.some((candidate) => candidate.source === 'Discogs')).toBe(true);
    expect(completedCandidates.some((candidate) => candidate.source === 'Cover Art Archive')).toBe(true);
    const discogsGroup = await coverLookupActions.readProviderGroupSummary('discogs');
    const archiveGroup = await coverLookupActions.readProviderGroupSummary('cover_art_archive');
    expect(discogsGroup.cards).toBeGreaterThanOrEqual(1);
    expect(discogsGroup.otherArtCards).toBeGreaterThanOrEqual(1);
    expect(archiveGroup.cards).toBeGreaterThanOrEqual(1);
    expect(archiveGroup.otherArtCards).toBeGreaterThanOrEqual(1);
    completedProviderEvidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(completedProviderEvidence.apple_search_requests).toBeGreaterThan(0);
    expect(completedProviderEvidence.manual_page_requests).toBeGreaterThan(0);
    expect(completedProviderEvidence.musicbrainz_started).toBeGreaterThan(0);
    expect(completedProviderEvidence.cover_art_archive_requests).toBeGreaterThan(0);
    expect(completedProviderEvidence.discogs_search_requests).toBeGreaterThan(0);
    expect(completedProviderEvidence.discogs_detail_requests).toBeGreaterThan(0);
  });

  await stepLogger.step('Reload and reopen saved candidates without another provider search', async () => {
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(taskTitle, `${completedCandidateIds.length} covers found`);
    await coverLookupActions.closeDrawer();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForInteractiveSummary();
    const reopenedGalleryRequests = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/cover-lookup/gallery'
      ) {
        reopenedGalleryRequests.push(request.url());
      }
    });
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(completedCandidateIds.length);
    const restoredCandidates = await coverLookupActions.readRemoteCandidateSummaries();
    expect(reopenedGalleryRequests).toHaveLength(1);
    expect(restoredCandidates.map((candidate) => candidate.id)).toEqual(completedCandidateIds);
    expect(restoredCandidates.length).toBeLessThanOrEqual(24);
    expect(restoredCandidates.every((candidate) => candidate.source.length > 0)).toBe(true);
    const restoredDiscogsGroup = await coverLookupActions.readProviderGroupSummary('discogs');
    const restoredArchiveGroup = await coverLookupActions.readProviderGroupSummary('cover_art_archive');
    expect(restoredDiscogsGroup.cards).toBeGreaterThanOrEqual(1);
    expect(restoredDiscogsGroup.otherArtCards).toBeGreaterThanOrEqual(1);
    expect(restoredArchiveGroup.cards).toBeGreaterThanOrEqual(1);
    expect(restoredArchiveGroup.otherArtCards).toBeGreaterThanOrEqual(1);
    const reopenedEvidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(reopenedEvidence).toMatchObject({
      apple_search_requests: completedProviderEvidence.apple_search_requests,
      manual_page_requests: completedProviderEvidence.manual_page_requests,
      musicbrainz_started: completedProviderEvidence.musicbrainz_started,
      musicbrainz_completed: completedProviderEvidence.musicbrainz_completed,
      cover_art_archive_requests: completedProviderEvidence.cover_art_archive_requests,
      discogs_search_requests: completedProviderEvidence.discogs_search_requests,
      discogs_detail_requests: completedProviderEvidence.discogs_detail_requests,
    });
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);

    const archiveSecondaryCard = coverLookupActions.coverLookup
      .providerOtherArtCards('cover_art_archive')
      .first();
    await expect(archiveSecondaryCard).toBeVisible();
    const archiveSecondaryCandidateId = String(
      await archiveSecondaryCard.getAttribute('data-select-remote-cover') || '',
    ).trim();
    expect(archiveSecondaryCandidateId).not.toBe('');
    const savedSecondary = await coverLookupActions.selectRemoteCandidateByIdAndSave(
      archiveSecondaryCandidateId,
    );
    expect(savedSecondary.payload.optimistic_remote_source).toBe('cover_art_archive');
  });
});

test('FTC-COVERS-031 a prior-generation choice survives a newer active lookup and saves unchanged', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let generationATaskId = '';
  let generationBTaskId = '';
  let generationAChoice = null;
  let generationBCandidate = null;
  let generationBCandidateImage = null;
  let saved = null;
  let savedCoverRevision = '';

  await stepLogger.step('Complete generation A, reset provider evidence, then gate generation B', async () => {
    await coverLookupActions.setProviderFixtureMode('selection-concurrency-a');
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();

    const generationA = await coverLookupActions.startSearch();
    generationATaskId = String(generationA.task?.id || '').trim();
    expect(generationATaskId).not.toBe('');
    await coverLookupActions.waitForModalSearchCompleted();
    const generationACandidates = await coverLookupActions.readRemoteCandidateSummaries();
    expect(generationACandidates.length).toBeGreaterThan(0);
    generationAChoice = await coverLookupActions.readRemoteCandidateEvidence(
      generationACandidates[0].id,
    );
    generationAChoice.id = generationACandidates[0].id;
    expect(generationAChoice.sha256).toBeTruthy();

    await coverLookupActions.resetProviderFixtureEvidence();
    await coverLookupActions.setProviderFixtureMode('selection-concurrency-b');
    await coverLookupActions.holdCandidateImageFixture();
    await coverLookupActions.holdLaterProviderFixture();
    const generationB = await coverLookupActions.startSearch();
    generationBTaskId = String(generationB.task?.id || '').trim();
    expect(generationBTaskId).not.toBe('');
    expect(generationBTaskId).not.toBe(generationATaskId);
    await coverLookupActions.waitForCandidateImageFixtureBlocked();
    await coverLookupActions.waitForLaterProviderFixtureBlocked();
  });

  await stepLogger.step('Select and save A while B remains active after publishing its distinct candidate', async () => {
    await coverLookupActions.selectRemoteCandidateById(generationAChoice.id);
    await coverLookupActions.waitForSelectedRemoteCandidateId(generationAChoice.id);

    await coverLookupActions.releaseCandidateImageFixture();
    await expect.poll(async () => {
      const runningCandidates = await coverLookupActions.readRemoteCandidateSummaries();
      generationBCandidate = runningCandidates.find(
        (candidate) => candidate.imageSrc.includes('selection-concurrency-b'),
      ) || null;
      return generationBCandidate?.id || '';
    }, {
      message: 'Expected generation B to publish its distinct candidate while its later provider remained held.',
      timeout: 30000,
    }).not.toBe('');
    generationBCandidateImage = await coverLookupActions.readRemoteCandidateEvidence(
      generationBCandidate.id,
    );
    expect(generationBCandidateImage.sha256).toBeTruthy();
    expect(generationBCandidateImage.sha256).not.toBe(generationAChoice.sha256);
    expect(await coverLookupActions.readSelectedRemoteCandidateId()).toBe(generationAChoice.id);
    await expect(coverLookupActions.coverLookup.remoteCoverCardById(generationAChoice.id)).toBeVisible();
    await expect(coverLookupActions.coverLookup.saveRemoteButton).toBeEnabled();

    saved = await coverLookupActions.saveSelectedRemoteCandidate();
    expect(saved.requestPayload).toMatchObject({
      task_id: generationATaskId,
      candidate_id: generationAChoice.id,
      snapshot_generation: generationATaskId,
    });
    expect(saved.requestPayload.task_id).not.toBe(generationBTaskId);
    expect(saved.payload.optimistic_cover_path).toMatch(/[\\/]cover\.jpg$/i);
    await coverLookupActions.waitForTaskStatusById(generationATaskId, 'Art chosen', {
      timeout: 120000,
    });
    const savedTask = await coverLookupActions.readTaskById(generationATaskId);
    expect(savedTask?.selected_candidate_id).toBe(generationAChoice.id);
    const persistedGenerationA = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: saved.payload.optimistic_cover_path,
      label: 'persisted generation-A cover before generation-B completion',
    });
    savedCoverRevision = persistedGenerationA.sha256.toLowerCase();
  });

  await stepLogger.step('Release B afterward and prove its terminal publication cannot replace persisted A', async () => {
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.releaseLaterProviderFixture();
    await coverLookupActions.waitForModalSearchCompleted();
    await coverLookupActions.closeModal();

    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const reopened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      PROGRESSIVE_CANDIDATE_TARGET,
    );
    expect(reopened.album.cover_path).toBe(saved.payload.optimistic_cover_path);
    expect(reopened.album.cover_selection_origin).toBe('user');
    expect(reopened.album.cover_revision).toBe(savedCoverRevision);
    await trackModalActions.waitForLoadedSummary();
    const persisted = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: reopened.album.cover_path,
      coverRevision: reopened.album.cover_revision,
      label: 'persisted generation-A cover after generation-B completion',
    });
    expect(persisted.sha256).toBe(savedCoverRevision.toUpperCase());

    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    const active = await coverLookupActions.readActiveLocalCoverEvidence();
    expect(active.sourcePath).toBe(reopened.album.cover_path);
    expect(active.image.coverRevision).toBe(savedCoverRevision);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-020 provider deadline keeps candidates found by earlier services', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open the isolated album and start a lookup with a delayed manual provider', async () => {
    await coverLookupActions.setProviderFixtureMode('service-deadline');
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    const fixtureCover = findFixtureCoverBySubtitle(
      Object.values(MANUAL_PROVIDER_COVER).join(' - '),
    );
    expect(fixtureCover).not.toBeNull();
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(fixtureCover));
    await coverLookupActions.startSearch();
  });

  await stepLogger.step('Keep the Apple candidate when the later provider crosses the shared deadline', async () => {
    await coverLookupActions.waitForModalSearchCompleted();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    expect(candidates.some((candidate) => candidate.source === 'Apple Music')).toBe(true);
    const evidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(evidence.apple_search_requests).toBeGreaterThan(0);
    expect(evidence.manual_page_requests).toBeGreaterThan(0);
  });
});

test('FTC-COVERS-021 artist conjunction differences still publish a visible remote candidate', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open the ampersand-credited album and start the lookup', async () => {
    await coverLookupActions.setProviderFixtureMode('artist-conjunction');
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(ARTIST_CONJUNCTION_TARGET))
      .toEqual(ARTIST_CONJUNCTION_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.startSearch();
  });

  await stepLogger.step('Show the provider candidate despite its separator-free artist credit', async () => {
    await coverLookupActions.waitForModalSearchCompleted();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    expect(candidates.some(
      (candidate) => candidate.imageSrc.includes('morse-cover-to-cover-conjunction'),
    )).toBe(true);
  });
});

test('FTC-COVERS-018 automatic lookup applies the first acceptable cover and stops later providers', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  test.setTimeout(240_000);

  let appliedCover = null;
  let neutralBaselineAlbum = null;
  let neutralBaselineFullSizeCover = null;

  await stepLogger.step('Confirm the isolated automatic-search album starts coverless', async () => {
    await coverLookupActions.setProviderFixtureMode('automatic-coverless');
    await coverLookupActions.resetProviderFixtureEvidence();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      AUTOMATIC_CANDIDATE_TARGET,
    );
    expect(opened.selected).toEqual(AUTOMATIC_CANDIDATE_TARGET);
    expect(opened.album.cover_path).toBeNull();
    expect((await trackModalActions.waitForLoadedSummary()).coverPlaceholderVisible).toBe(true);
    await trackModalActions.close();
  });

  await stepLogger.step('Capture the neutral album user-cover baseline', async () => {
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    neutralBaselineAlbum = opened.album;
    expect(neutralBaselineAlbum.cover_selection_origin).toBe('user');
    expect(neutralBaselineAlbum.local_cover_width).toBe(640);
    expect(neutralBaselineAlbum.local_cover_height).toBe(640);
    expect(USER_COVER_LINKED_FIELDS.every((field) => neutralBaselineAlbum[field] !== null)).toBe(true);
    await trackModalActions.waitForLoadedSummary();
    neutralBaselineFullSizeCover = await coverLookupActions.readFullSizeCoverEvidence({
      coverPath: neutralBaselineAlbum.cover_path,
      coverRevision: neutralBaselineAlbum.cover_revision,
      label: 'neutral user-owned cover before automatic lookup',
    });
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await trackModalActions.close();
  });

  await stepLogger.step('Run a real incremental scan and apply the first acceptable automatic candidate', async () => {
    await appBarActions.triggerIncrementalScanAndWaitForBusy();
    const providerEvidence = await coverLookupActions.waitForAutomaticProviderSearch(
      AUTOMATIC_CANDIDATE_TARGET,
    );
    expect(providerEvidence.musicbrainz_queries.some(
      (query) => String(query || '').includes(AUTOMATIC_CANDIDATE_TARGET.album),
    )).toBe(false);
    expect(providerEvidence.cover_art_archive_release_ids).not.toContain(
      'automatic-candidate-primary',
    );

    await appBarActions.waitForScanAndCoverRefreshIdle();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      AUTOMATIC_CANDIDATE_TARGET,
    );
    expect(opened.album.cover_selection_origin).toBe('automatic');
    expect(opened.album.cover_path).toMatch(/[\\/]cover\.jpg$/i);
    expect(opened.album.remote_cover_url).toBeNull();
    expect(opened.album.remote_cover_thumbnail_url).toBeNull();
    await trackModalActions.waitForLoadedSummary();
    appliedCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'automatically applied album cover',
      {
        expectedCoverPath: opened.album.cover_path,
        expectedCoverRevision: opened.album.cover_revision,
      },
    );
    expect(appliedCover.sha256).not.toBe('');
    await trackModalActions.close();
  });

  await stepLogger.step('Keep the neutral automatic candidate cached without changing its user cover', async () => {
    await coverLookupActions.waitForAutomaticProviderSearch(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    const neutralPreservedAlbum = opened.album;
    expect(neutralPreservedAlbum.cover_selection_origin).toBe(neutralBaselineAlbum.cover_selection_origin);
    expect(neutralPreservedAlbum.cover_path).toBe(neutralBaselineAlbum.cover_path);
    expect(neutralPreservedAlbum.cover_revision).toBe(neutralBaselineAlbum.cover_revision);
    for (const field of USER_COVER_LINKED_FIELDS) {
      expect(neutralPreservedAlbum[field]).toBe(neutralBaselineAlbum[field]);
    }
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);

    const evidenceBeforeOpen = await coverLookupActions.readProviderFixtureEvidence();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    const neutralCandidate = candidates.find(
      (candidate) => candidate.imageSrc.includes('automatic-coverless-neutral'),
    );
    expect(neutralCandidate).toBeTruthy();
    expect(neutralCandidate.resolution).toBe('600x600');
    expect(neutralCandidate.selected).toBe(false);
    const neutralCandidateEvidence = await coverLookupActions.readRemoteCandidateEvidence(neutralCandidate.id);
    expect(neutralCandidateEvidence.naturalWidth).toBe(600);
    expect(neutralCandidateEvidence.naturalHeight).toBe(600);
    expect(neutralCandidateEvidence.src).toContain('automatic-coverless-neutral');
    const providerEvidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(providerEvidence.fixture_neutral_original_source_sha256).toBe(
      neutralBaselineFullSizeCover.sha256.toLowerCase(),
    );
    const evidenceAfterOpen = await coverLookupActions.readProviderFixtureEvidence();
    expect(evidenceAfterOpen).toEqual(evidenceBeforeOpen);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
  });

  await stepLogger.step('Open the gallery and retain the published remote candidate without another search', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity(AUTOMATIC_CANDIDATE_TARGET);
    await trackModalActions.waitForLoadedSummary();
    const evidenceBeforeOpen = await coverLookupActions.readProviderFixtureEvidence();
    expect(evidenceBeforeOpen.musicbrainz_queries.some(
      (query) => String(query || '').includes(AUTOMATIC_CANDIDATE_TARGET.album),
    )).toBe(false);
    expect(evidenceBeforeOpen.cover_art_archive_release_ids).not.toContain(
      'automatic-candidate-primary',
    );
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    const automaticCandidate = candidates.find(
      (candidate) => candidate.imageSrc.includes('automatic-candidate-primary'),
    );
    expect(automaticCandidate).toBeTruthy();
    expect(candidates.every((candidate) => candidate.source.length > 0)).toBe(true);
    expect(await coverLookupActions.readSelectedRemoteCandidateId()).toBe('');
    const evidenceAfterOpen = await coverLookupActions.readProviderFixtureEvidence();
    expect(evidenceAfterOpen).toEqual(evidenceBeforeOpen);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-019 automatic improvement preserves a user-owned cover and clears after gallery open', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  test.setTimeout(240_000);

  let baselineAlbum = null;
  let baselineCover = null;
  let upgradedAlbum = null;
  let upgradedCover = null;

  await stepLogger.step('Explicitly confirm the seeded artwork through the real Save flow', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(USER_OWNED_IMPROVEMENT_TARGET);
    const artwork = await createSameAlbumArtwork(opened.album.cover_path, randomUUID().replaceAll('-', ''));
    try {
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady();
      const selected = await coverLookupActions.selectLocalCoverByNameAndSave(path.basename(artwork.artworkPath));
      expect(selected.updatedAlbum.cover_selection_origin).toBe('user');
      expect(selected.updatedAlbum.local_cover_width).toBe(640);
      expect(selected.updatedAlbum.local_cover_height).toBe(640);
      await trackModalActions.close();
    } finally {
      await artwork.cleanup();
    }
  });

  await stepLogger.step('Capture the smaller user-owned cover and its linked metadata', async () => {
    await coverLookupActions.setProviderFixtureMode('same-art-improvement');
    await coverLookupActions.resetProviderFixtureEvidence();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    baselineAlbum = opened.album;
    expect(baselineAlbum.cover_selection_origin).toBe('user');
    expect(baselineAlbum.local_cover_width).toBe(640);
    expect(baselineAlbum.local_cover_height).toBe(640);
    expect(USER_COVER_LINKED_FIELDS.every((field) => baselineAlbum[field] == null)).toBe(true);
    await trackModalActions.waitForLoadedSummary();
    baselineCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'user-owned cover before automatic lookup',
      {
        expectedCoverPath: baselineAlbum.cover_path,
        expectedCoverRevision: baselineAlbum.cover_revision,
      },
    );
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await trackModalActions.close();
  });

  await stepLogger.step('Keep different artwork suggestion-only while the explicit cover remains undersized', async () => {
    await coverLookupActions.setProviderFixtureMode('automatic-scan');
    await coverLookupActions.resetProviderFixtureEvidence();
    await appBarActions.triggerIncrementalScanAndWait();
    await coverLookupActions.waitForAutomaticProviderSearch(USER_OWNED_IMPROVEMENT_TARGET);
    await appBarActions.waitForScanAndCoverRefreshIdle();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(USER_OWNED_IMPROVEMENT_TARGET);
    expect(opened.album.cover_path).toBe(baselineAlbum.cover_path);
    expect(opened.album.cover_revision).toBe(baselineAlbum.cover_revision);
    expect(opened.album.cover_selection_origin).toBe('user');
    await trackModalActions.waitForLoadedSummary();
    const retained = await coverLookupActions.readDisplayedImageEvidence(trackModalActions.trackModal.detailedCoverImage,
      'undersized selection after different-art lookup', { expectedCoverPath: baselineAlbum.cover_path, expectedCoverRevision: baselineAlbum.cover_revision });
    expect(retained.sha256).toBe(baselineCover.sha256);
    await trackModalActions.waitForCoverLookupImprovementIndicator(true);
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    expect((await coverLookupActions.readRemoteCandidateSummaries())
      .some(candidate => candidate.imageSrc.includes('user-owned-improvement-primary'))).toBe(true);
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await coverLookupActions.closeModal();
    const retainedAfterView = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage, 'explicit selection after viewing a different-art suggestion',
      { expectedCoverPath: baselineAlbum.cover_path, expectedCoverRevision: baselineAlbum.cover_revision },
    );
    expect(retainedAfterView.sha256).toBe(baselineCover.sha256);
    await trackModalActions.close();
    await coverLookupActions.setProviderFixtureMode('same-art-improvement');
    await coverLookupActions.resetProviderFixtureEvidence();
  });

  await stepLogger.step('Apply a better version of the same artwork while preserving user ownership', async () => {
    await appBarActions.triggerIncrementalScanAndWait();
    await coverLookupActions.waitForAutomaticProviderSearch(USER_OWNED_IMPROVEMENT_TARGET);
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    upgradedAlbum = opened.album;
    expect(upgradedAlbum.cover_selection_origin).toBe('user');
    expect(upgradedAlbum.cover_path).toBe(baselineAlbum.cover_path);
    expect(upgradedAlbum.cover_revision).not.toBe(baselineAlbum.cover_revision);
    for (const field of USER_COVER_LINKED_FIELDS) {
      expect(upgradedAlbum[field]).toBeNull();
    }
    await trackModalActions.waitForLoadedSummary();
    upgradedCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'user-owned cover after same-art automatic upgrade',
      {
        expectedCoverPath: upgradedAlbum.cover_path,
        expectedCoverRevision: upgradedAlbum.cover_revision,
      },
    );
    expect(upgradedCover.sha256).not.toBe(baselineCover.sha256);
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    const reopenedUpgrade = await coverLookupActions.inspectModalComponents();
    expect(reopenedUpgrade.activeLocalCover.coverPath).toBe(upgradedAlbum.cover_path);
    expect((await coverLookupActions.readLocalCoverNames())
      .some((name) => /^cover-existing-/i.test(name))).toBe(false);
    expect((await coverLookupActions.readRemoteCandidateSummaries())
      .find((candidate) => candidate.imageSrc.includes('user-owned-same-art-improvement'))
      ?.selected).toBe(false);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
  });

  await stepLogger.step('Skip automatic provider queries once the selected same-art upgrade is adequate', async () => {
    await appBarActions.waitForScanAndCoverRefreshIdle();
    await coverLookupActions.setProviderFixtureMode('automatic-scan');
    await coverLookupActions.resetProviderFixtureEvidence();
    await appBarActions.triggerIncrementalScanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(USER_OWNED_IMPROVEMENT_TARGET);
    expect(opened.album.cover_selection_origin).toBe('user');
    expect(opened.album.cover_path).toBe(upgradedAlbum.cover_path);
    expect(opened.album.cover_revision).toBe(upgradedAlbum.cover_revision);
    expect(opened.album.local_cover_width).toBeGreaterThanOrEqual(1200);
    expect(opened.album.local_cover_height).toBeGreaterThanOrEqual(1200);
    const evidence = await coverLookupActions.readProviderFixtureEvidence();
    expect((evidence.apple_search_terms || []).some(term => String(term).toLowerCase().includes(USER_OWNED_IMPROVEMENT_TARGET.album.toLowerCase()))).toBe(false);
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await trackModalActions.close();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-019 later automatic improvement restores the unseen indicator', { tag: '@area:cover-providers' }, async ({
  appBarActions,
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  await stepLogger.step('Independently select undersized artwork through the real Save flow', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(USER_OWNED_IMPROVEMENT_TARGET);
    const artwork = await createUndersizedAlbumArtwork(opened.album.cover_path, randomUUID().replaceAll('-', ''));
    try {
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openCoverLookup();
      await coverLookupActions.waitForModalReady();
      const selected = await coverLookupActions.selectLocalCoverByNameAndSave(path.basename(artwork.artworkPath));
      expect(selected.updatedAlbum.cover_selection_origin).toBe('user');
      expect(selected.updatedAlbum.local_cover_width).toBe(640);
      expect(selected.updatedAlbum.local_cover_height).toBe(640);
      await trackModalActions.close();
    } finally {
      await artwork.cleanup();
    }
  });
  await stepLogger.step('Prepare a distinct later automatic improvement', async () => {
    await coverLookupActions.setProviderFixtureMode('alternate-improvement');
    await coverLookupActions.resetProviderFixtureEvidence();
  });

  await stepLogger.step('Restore the unseen indicator when a later automatic lookup finds a better result', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await appBarActions.waitForIncrementalScanComplete();
    await appBarActions.triggerIncrementalScanAndWait();
    await coverLookupActions.waitForAutomaticProviderSearch(USER_OWNED_IMPROVEMENT_TARGET);
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    expect(opened.album.cover_selection_origin).toBe('user');
    expect(opened.album.cover_path).toMatch(/[\\/]cover\.jpg$/i);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.waitForCoverLookupImprovementIndicator(true);
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-019 manual lookup leaves the user-owned cover unchanged before Save', { tag: '@area:cover-providers' }, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let baselineAlbum = null;
  let baselineCover = null;
  let taskTitle = '';

  await stepLogger.step('Open the user-owned album and capture its active cover', async () => {
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.resetProviderFixtureEvidence();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    baselineAlbum = opened.album;
    expect(baselineAlbum.cover_selection_origin).toBe('user');
    await trackModalActions.waitForLoadedSummary();
    baselineCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'user-owned cover before manual candidate search',
      {
        expectedCoverPath: baselineAlbum.cover_path,
        expectedCoverRevision: baselineAlbum.cover_revision,
      },
    );
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    expect((await coverLookupActions.selectLocalCoverBySourcePath(
      baselineAlbum.cover_path,
    )).sourcePath).toBe(baselineAlbum.cover_path);
  });

  await stepLogger.step('Complete a manual all-provider lookup without changing the active cover before Save', async () => {
    taskTitle = USER_OWNED_IMPROVEMENT_TARGET.album;
    await coverLookupActions.startSearch();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    expect(await coverLookupActions.readSelectedRemoteCandidateId()).toBe('');
    expect((await coverLookupActions.readActiveLocalCoverEvidence()).sourcePath)
      .toBe(baselineAlbum.cover_path);
    await coverLookupActions.waitForModalSearchCompleted();
    expect(await coverLookupActions.readSelectedRemoteCandidateId()).toBe('');
    await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(taskTitle, /^[1-9]\d* covers? found$/);
    await coverLookupActions.closeDrawer();

    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    expect(opened.album.cover_selection_origin).toBe('user');
    expect(opened.album.cover_path).toBe(baselineAlbum.cover_path);
    expect(opened.album.cover_revision).toBe(baselineAlbum.cover_revision);
    for (const field of USER_COVER_LINKED_FIELDS) {
      expect(opened.album[field]).toBe(baselineAlbum[field]);
    }
    await trackModalActions.waitForLoadedSummary();
    const preservedCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'user-owned cover after manual candidate search',
      {
        expectedCoverPath: baselineAlbum.cover_path,
        expectedCoverRevision: baselineAlbum.cover_revision,
      },
    );
    expect(preservedCover.sha256).toBe(baselineCover.sha256);
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    const evidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(evidence.apple_search_requests).toBeGreaterThan(0);
    expect(evidence.musicbrainz_started).toBeGreaterThan(0);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});
