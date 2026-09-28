import { enrollCapabilityMember, openCapabilityFixtureAlbum } from '../actions/capabilityEditorActions.js';
import { prepareDesktopCoverCandidates, decodedArtworkEvidence } from '../actions/capabilityCoverActions.js';
import { CapabilityCoverLookup } from '../poms/capabilityCoverLookup.js';
import { test, expect } from '../support/baseFixtures.js';

test.use({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 TV Safari/537.36' });

test('FTC-CAP-AUDIT-014 TV selects real provider artwork while hiding retained manual candidates', async ({
  page, freshBrowserSession, galleryActions, trackModalActions, coverLookupActions,
}, testInfo) => {
  const editor = await enrollCapabilityMember(page, freshBrowserSession, ['Change covers'], {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  });
  await coverLookupActions.setProviderFixtureMode('normal');
  const desktop = await prepareDesktopCoverCandidates(editor.page, testInfo);
  await page.reload();
  await galleryActions.waitForGalleryReady();
  await coverLookupActions.openDrawer();
  await coverLookupActions.openTask(desktop.taskTitle);
  await coverLookupActions.waitForModalReady();
  const lookup = coverLookupActions.coverLookup;
  await expect(lookup.remoteCoverCardById(desktop.providerId)).toBeVisible();
  await expect(lookup.remoteCoverCardById(desktop.manualId)).toHaveCount(0);
  await expect(lookup.manualUrlInput).toBeHidden();
  await expect(lookup.manualExtractButton).toBeHidden();
  await expect(lookup.addImageButton).toBeHidden();
  const tvLookup = new CapabilityCoverLookup(page, testInfo);
  const local = tvLookup.localCandidate(desktop.localPath);
  await expect(local).toHaveCount(1);
  await expect(local).toBeHidden();
  const selectedImage = await coverLookupActions.readRemoteCandidateEvidence(desktop.providerId);
  const selected = await decodedArtworkEvidence(page, selectedImage.src);
  const saved = await coverLookupActions.selectRemoteCandidateByIdAndSave(desktop.providerId);
  expect(saved.ok).toBe(true);
  expect(saved.optimistic_cover_path).toBeTruthy();
  await coverLookupActions.openDrawer();
  await coverLookupActions.waitForTaskStatus(desktop.taskTitle, 'Art chosen');
  await coverLookupActions.closeDrawer();
  await page.reload();
  await openCapabilityFixtureAlbum(galleryActions);
  await expect(trackModalActions.trackModal.detailedCoverImage).toBeVisible();
  const artwork = await coverLookupActions.readDisplayedImageEvidence(
    trackModalActions.trackModal.detailedCoverImage, 'TV-selected provider artwork',
    { expectedCoverPath: saved.optimistic_cover_path },
  );
  const persisted = await decodedArtworkEvidence(page, artwork.src);
  expect(persisted).toEqual(selected);
  await desktop.tracks.openCoverLookup();
  await desktop.actions.waitForModalResultsReady();
  await expect(desktop.lookup.remoteCoverCardById(desktop.manualId)).toBeVisible();
});
