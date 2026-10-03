import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { authenticatedPageGet } from '../../helpers/authenticatedPageRequest.js';
import { expect } from '@playwright/test';
import { GalleryPage } from '../../poms/galleryPage.js';
import { GalleryActions } from '../../actions/galleryActions.js';
import { TrackModal } from '../../poms/trackModal.js';
import { TrackModalActions } from '../../actions/trackModalActions.js';
import { CoverLookupActions } from '../../actions/coverLookupActions.js';
import { CapabilityCoverLookup } from '../poms/capabilityCoverLookup.js';
import { openCapabilityFixtureAlbum } from './capabilityEditorActions.js';

export async function prepareDesktopCoverCandidates(page, testInfo) {
  const gallery = new GalleryActions(new GalleryPage(page, testInfo));
  const tracks = new TrackModalActions(new TrackModal(page, testInfo));
  const lookup = new CapabilityCoverLookup(page, testInfo);
  const actions = new CoverLookupActions(lookup);
  await page.goto('/');
  await openCapabilityFixtureAlbum(gallery);
  await tracks.openCoverLookup();
  await expect(lookup.activeLocalCoverCard).toBeVisible();
  const localPath = await lookup.activeLocalCoverCard.getAttribute('data-select-local-cover');
  expect(localPath).toBeTruthy();
  const providerUrl = new URL(testInfo.config.metadata.providerBaseURL);
  providerUrl.hostname = 'cover-fixture.example';
  await actions.enterManualUrls([new URL('/manual/phase7-manual/cover.jpg', providerUrl).href]);
  await actions.startSearch();
  await actions.waitForModalSearchCompleted();
  await expect(lookup.providerCandidates.first()).toBeVisible();
  await expect(lookup.manualCandidates.first()).toBeVisible();
  const providerId = await lookup.providerCandidates.first().getAttribute('data-select-remote-cover');
  const manualId = await lookup.manualCandidates.first().getAttribute('data-select-remote-cover');
  const taskTitle = 'Uninterrupted Session';
  await actions.closeModal();
  return { actions, lookup, tracks, providerId, manualId, taskTitle, localPath };
}


export async function decodedArtworkEvidence(page, displayedSource) {
  const response = await authenticatedPageGet(page, displayedSource);
  expect(response.ok()).toBe(true);
  const { resolvePlaywrightPython } = createRequire(import.meta.url)('../../../../scripts/playwright-python.cjs');
  const result = spawnSync(resolvePlaywrightPython(process.env),
    [fileURLToPath(new URL('../../support/decode_image_evidence.py', import.meta.url))],
    { input: await response.body(), encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Artwork decode failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
