import { assertCapabilityBoundary } from '../actions/capabilityBoundaryActions.js';
import { enrollCapabilityMember } from '../actions/capabilityEditorActions.js';
import { prepareDesktopCoverCandidates } from '../actions/capabilityCoverActions.js';
import { CapabilityCoverLookup } from '../poms/capabilityCoverLookup.js';
import { test, expect } from '../support/baseFixtures.js';

test.use({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 TV Safari/537.36' });

test('FTC-CAP-AUDIT-014 TV shows provider artwork but never saves a cover', async ({
  page, freshBrowserSession, galleryActions, coverLookupActions,
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
  const local = tvLookup.localCandidate(desktop.localReference);
  await expect(local).toHaveCount(1);
  await expect(local).toBeHidden();
  // Owner 2026-11-17: covers are never edited on TV. Picking a cover offers no Save.
  await coverLookupActions.selectRemoteCandidateById(desktop.providerId);
  await expect(lookup.saveRemoteButton).toBeHidden();
  await coverLookupActions.closeModal();
  await desktop.tracks.openCoverLookup();
  await desktop.actions.waitForModalResultsReady();
  await expect(desktop.lookup.remoteCoverCardById(desktop.manualId)).toBeVisible();
  await assertCapabilityBoundary(page, { visible: ['covers'], providerOnly: true }, testInfo);
});
