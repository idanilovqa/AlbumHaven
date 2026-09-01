import { expect, test } from '../support/baseFixtures.js';
import path from 'node:path';
import {
  buildFixtureManualUrls,
  COVER_LOOKUP_TEST_TARGETS,
  findFixtureCoverBySubtitle,
} from '../helpers/coverLookupFixtureData.js';

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

test('FTC-COVERS-022 cover gallery loading starts before the task list responds', async ({
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
      (candidate) => candidate.source.toLocaleLowerCase() === 'apple music',
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

test('FTC-COVERS-012 fake-album fast cover search appears in the drawer and can be canceled and cleared', async ({
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
    expect(modal.title).toBe(Object.values(CANCEL_CLEAR_TARGET).join(' - '));
  });

  await stepLogger.step('Open the cover lookup gallery for the fake album and capture its random subtitle', async () => {
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = await coverLookupActions.readModalSubtitle();
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

test('FTC-COVERS-007 lookup-start alert does not reposition the cover modal', async ({
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
    taskTitle = await coverLookupActions.readModalSubtitle();
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
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Completed');
    await coverLookupActions.clearTaskAndExpectImmediateRemoval(taskTitle);
    await coverLookupActions.waitForDrawerEmpty();
    await coverLookupActions.setProviderFixtureMode('normal');
  });
});

test('FTC-COVERS-007 notification states and bulk clear preserve active work', async ({
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
    actionedTaskTitle = await coverLookupActions.readModalSubtitle();
    const expectedCover = findFixtureCoverBySubtitle(
      Object.values(MANUAL_PROVIDER_COVER).join(' - '),
    );
    expect(expectedCover).not.toBeNull();
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.enterManualUrls(buildFixtureManualUrls(expectedCover));
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
    await coverLookupActions.waitForRunningTaskElapsedToAdvance(actionedTaskTitle);
  });

  await stepLogger.step('Select the notification card text without opening the modal and verify the completed elapsed pill', async () => {
    await coverLookupActions.waitForTaskStatus(actionedTaskTitle, 'Completed');
    terminalDuration = await coverLookupActions.waitForTerminalTaskElapsed(actionedTaskTitle);
    await coverLookupActions.expectTaskElapsedStable(actionedTaskTitle, terminalDuration);
    const selection = await coverLookupActions.dragSelectTaskTitleWithoutOpeningModal(actionedTaskTitle);
    expect(selection.selectedText).toContain('COVER ART LOOK UP');
    expect(selection.selectedText).toContain(actionedTaskTitle);
    expect(selection.selectedText).toContain('Completed');
    expect(selection.clipboardText).toBe(selection.selectedText);
    expect(selection.cursor).toBe('pointer');
    const elapsedPill = await coverLookupActions.readTaskElapsedPill(actionedTaskTitle);
    expect(elapsedPill.className).toMatch(/\bis-completed\b/);
    expect(elapsedPill.display).toMatch(/^inline/);
    expect(elapsedPill.borderRadius).toBeGreaterThan(0);
    expect(elapsedPill.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(elapsedPill.width).toBeGreaterThan(0);
    expect(elapsedPill.height).toBeGreaterThan(0);
  });

  await stepLogger.step('Choose the returned cover and keep the completed duration frozen', async () => {
    await coverLookupActions.openTask(actionedTaskTitle);
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForModalResultsReady();
    await coverLookupActions.selectFirstRemoteCoverAndSave();
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
    noResultTaskTitle = await coverLookupActions.readModalSubtitle();
    expect(noResultTaskTitle).not.toBe(actionedTaskTitle);
    await coverLookupActions.setProviderFixtureMode('no-results');
    await coverLookupActions.startSearch();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'Completed — no result');
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
    failedTaskTitle = await coverLookupActions.readModalSubtitle();
    expect(failedTaskTitle).not.toBe(actionedTaskTitle);
    expect(failedTaskTitle).not.toBe(noResultTaskTitle);
    await coverLookupActions.setProviderFixtureMode('failed');
    await coverLookupActions.startSearch();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForDrawerOpen();
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Failed');
    await coverLookupActions.waitForTerminalTaskElapsed(failedTaskTitle);
    await coverLookupActions.setProviderFixtureMode('normal');
    await coverLookupActions.closeDrawer();
  });

  await stepLogger.step('Start another lookup and bulk-clear every finished row while it remains active', async () => {
    expect(await galleryActions.selectAlbumDetailsByIdentity(ACTIVE_COVER_LOOKUP_TARGET))
      .toEqual(ACTIVE_COVER_LOOKUP_TARGET);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    activeTaskTitle = await coverLookupActions.readModalSubtitle();
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
    await coverLookupActions.waitForTaskStatus(noResultTaskTitle, 'Completed — no result');
    await coverLookupActions.waitForTaskStatus(failedTaskTitle, 'Failed');
    await coverLookupActions.waitForTaskActive(activeTaskTitle);
    await coverLookupActions.waitForLaterProviderFixtureBlocked();
    const clearResult = await coverLookupActions.clearFinishedTasksAndPreserveActive(
      [actionedTaskTitle, noResultTaskTitle, failedTaskTitle],
      activeTaskTitle,
    );
    expect(clearResult.requestedTaskCount).toBe(3);
    expect(clearResult.removedCount).toBe(3);
  });

  await stepLogger.step('Reload with only active work, then cancel and clear it', async () => {
    await coverLookupActions.reloadAndOpenDrawer();
    await coverLookupActions.waitForTaskActive(activeTaskTitle);
    await coverLookupActions.expectTaskHiddenImmediately(actionedTaskTitle);
    await coverLookupActions.expectTaskHiddenImmediately(noResultTaskTitle);
    await coverLookupActions.expectTaskHiddenImmediately(failedTaskTitle);
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

test('FTC-COVERS-013 partial cover results survive drawer reopen, save cancellation, and reload', async ({
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
    expect(modal.title).toBe(Object.values(PARTIAL_COVER_LOOKUP_TARGET).join(' - '));
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = await coverLookupActions.readModalSubtitle();
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

    expect(modal.subtitle).toBe(taskTitle);
    expect(modal.hasFindBetterButton).toBe(true);
    expect(modal.hasSaveButton).toBe(true);
    expect(modal.hasManualInput).toBe(true);
    expect(modal.hasManualExtractButton).toBe(true);
    expect(modal.localCards).toBeGreaterThan(0);
    expect(modal.serviceCards).toBeGreaterThan(0);
    expect(modal.openLightboxButtons).toBeGreaterThan(1);
    expect(modal.sectionTitles).toEqual(expect.arrayContaining([
      'Local Covers',
      'Remote Cover Art',
      'Possible Matches',
    ]));
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

test('FTC-COVERS-019 Spotify stays linked while a downloadable provider reopens locally', async ({
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
      (candidate) => candidate.source.toLocaleLowerCase() === 'apple music',
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

test('FTC-COVERS-011 selected local art remains authoritative after rescan and app restart', async ({
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
      .toBe('Mastodon - Crack The Skye - 2009');
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

  await stepLogger.step('Save nested Front.jpg over canonical cover.jpg and verify every immediate surface', async () => {
    const saved = await coverLookupActions.selectLocalCoverByNameAndSave(
      selectedLocalCover.name,
      { stableCoverLocator: trackModalActions.trackModal.detailedCoverImage },
    );
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
    const reopenedCandidates = await coverLookupActions.readLocalCoverCandidates();
    const reopenedActiveCover = reopenedCandidates.find((candidate) => candidate.isActive) || null;
    const reopenedExistingCopies = reopenedCandidates.filter((candidate) => (
      /[\\/]cover-existing-\d+\.jpg$/i.test(candidate.sourcePath)
    ));
    const reopenedOriginalSource = reopenedCandidates.find((candidate) => (
      /[\\/]Art[\\/]CD\.JPG$/i.test(candidate.sourcePath)
      && candidate.image.sha256 === originalActiveCover.image.sha256
    )) || null;
    expect(reopenedActiveCover).not.toBeNull();
    expect(reopenedActiveCover.sourcePath).toBe(selectedCoverPath);
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
    expect(activeCover.sourcePath).toBe(selectedCoverPath);
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

test('FTC-COVERS-017 manual lookup progressively retains provider alternatives', async ({
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
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = await coverLookupActions.readModalSubtitle();
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
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Completed');
    await coverLookupActions.closeDrawer();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(PROGRESSIVE_CANDIDATE_TARGET))
      .toEqual(PROGRESSIVE_CANDIDATE_TARGET);
    await trackModalActions.waitForLoadedSummary();
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
  });
});

test('FTC-COVERS-020 provider deadline keeps candidates found by earlier services', async ({
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
    await trackModalActions.waitForLoadedSummary();
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

test('FTC-COVERS-021 artist conjunction differences still publish a visible remote candidate', async ({
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

test('FTC-COVERS-018 automatic lookup applies the first acceptable cover and stops later providers', async ({
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

test('FTC-COVERS-019 automatic improvement preserves a user-owned cover and clears after gallery open', async ({
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
    expect(USER_COVER_LINKED_FIELDS.every((field) => baselineAlbum[field] !== null)).toBe(true);
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

  await stepLogger.step('Keep different automatic artwork suggestion-only and show its indicator', async () => {
    await appBarActions.waitForScanAndCoverRefreshIdle();
    await coverLookupActions.setProviderFixtureMode('automatic-scan');
    await coverLookupActions.resetProviderFixtureEvidence();
    await appBarActions.triggerIncrementalScanAndWait();
    await coverLookupActions.waitForAutomaticProviderSearch(USER_OWNED_IMPROVEMENT_TARGET);
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    const opened = await galleryActions.selectAlbumDetailsByIdentityAndReadPayload(
      USER_OWNED_IMPROVEMENT_TARGET,
    );
    expect(opened.album.cover_selection_origin).toBe('user');
    expect(opened.album.cover_path).toBe(upgradedAlbum.cover_path);
    expect(opened.album.cover_revision).toBe(upgradedAlbum.cover_revision);
    for (const field of USER_COVER_LINKED_FIELDS) {
      expect(opened.album[field]).toBeNull();
    }
    await trackModalActions.waitForLoadedSummary();
    const preservedCover = await coverLookupActions.readDisplayedImageEvidence(
      trackModalActions.trackModal.detailedCoverImage,
      'same-art upgrade after different-art automatic lookup',
      {
        expectedCoverPath: upgradedAlbum.cover_path,
        expectedCoverRevision: upgradedAlbum.cover_revision,
      },
    );
    expect(preservedCover.sha256).toBe(upgradedCover.sha256);
    await trackModalActions.waitForCoverLookupImprovementIndicator(true);
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    await coverLookupActions.waitForRemoteCandidateCountAtLeast(1);
    expect((await coverLookupActions.readRemoteCandidateSummaries())
      .some((candidate) => candidate.imageSrc.includes('user-owned-improvement-primary'))).toBe(true);
    await trackModalActions.waitForCoverLookupImprovementIndicator(false);
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});

test('FTC-COVERS-019 later automatic improvement restores the unseen indicator', async ({
  appBarActions,
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
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

test('FTC-COVERS-019 manual lookup leaves the user-owned cover unchanged before Save', async ({
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
    taskTitle = await coverLookupActions.readModalSubtitle();
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
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Completed');
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
