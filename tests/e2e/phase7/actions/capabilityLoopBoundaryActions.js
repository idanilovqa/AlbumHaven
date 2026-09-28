import { expect } from '@playwright/test';
import { signIn } from './authActions.js';
import { GalleryPage } from '../../poms/galleryPage.js';
import { GalleryActions } from '../../actions/galleryActions.js';
import { TrackModal } from '../../poms/trackModal.js';
import { TrackModalActions } from '../../actions/trackModalActions.js';
import { GlobalPlayer } from '../../poms/globalPlayer.js';
import { GlobalPlayerActions } from '../../actions/globalPlayerActions.js';
import { SettingsModalAppBar } from '../../poms/settingsModalAppBar.js';
import { SettingsModalAppBarActions } from '../../actions/settingsModalAppBarActions.js';
import { UtilityTabBar } from '../../poms/utilityTabBar.js';
import { UtilityTabBarActions } from '../../actions/utilityTabBarActions.js';
import { UtilityAppearanceTab } from '../../poms/utilityAppearanceTab.js';
import { UtilityAppearanceActions } from '../../actions/utilityAppearanceActions.js';

import { assignCapabilityProfile, expectExactCapabilityProfile } from './capabilityProfileEnrollment.js';
import { openCapabilityFixtureAlbum } from './capabilityEditorActions.js';
import { CapabilityPracticePage } from '../poms/capabilityPracticePage.js';
import { CapabilityBoundaryPage } from '../poms/capabilityBoundaryPage.js';

export const BOUNDARY_LOOP = 'Capability boundary owned loop';

// Populate ownership through real UI with explicit temporary creation authority,
// then restore the exact tested profile before any permission assertion.
export async function prepareOwnedBoundaryLoop({ page, freshBrowserSession, identity, testInfo }, editor, profile) {
  const desktop = await freshBrowserSession.create({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  });
  const galleryActions = new GalleryActions(new GalleryPage(desktop.page, testInfo));
  const trackModalActions = new TrackModalActions(new TrackModal(desktop.page, testInfo));
  const globalPlayerActions = new GlobalPlayerActions(new GlobalPlayer(desktop.page, testInfo));
  const settingsModalAppBarActions = new SettingsModalAppBarActions(new SettingsModalAppBar(desktop.page, testInfo));
  const utilityTabBarActions = new UtilityTabBarActions(new UtilityTabBar(desktop.page, testInfo));
  const utilityAppearanceActions = new UtilityAppearanceActions(new UtilityAppearanceTab(desktop.page, testInfo));
  await assignCapabilityProfile(editor, { capabilities: ['play', 'create', 'practice'] });
  await editor.saveChangedAccess();
  await signIn(desktop.page, identity);
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.saveSeekbarMode('waveform');
  await settingsModalAppBarActions.closeSettings();
  await openCapabilityFixtureAlbum(galleryActions);
  const track = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.pauseIfPlaying();
  await trackModalActions.close();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(BOUNDARY_LOOP)).requestCount).toBe(1);
  await assignCapabilityProfile(editor, profile);
  await editor.saveChangedAccess();
  await editor.page.reload();
  await expectExactCapabilityProfile(editor, profile);
  await page.reload();
}

export async function assertOwnedLoopBoundary(page, utilityLoopsActions, profile, loopName = BOUNDARY_LOOP) {
  const ui = new CapabilityPracticePage(page);
  const boundary = new CapabilityBoundaryPage(page);
  await page.goto('/');
  await ui.openSettings();
  await ui.tab('loops').click();
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle('Continuous Signal');
  const { entry, loopId } = await utilityLoopsActions.resolveLoopEntryByName(loopName);
  await expect(entry).toBeVisible();
  await ui.expectOwnedArtwork(loopId);
  await utilityLoopsActions.expectPausedLoopWaveformPainted(entry, loopId);
  const card = utilityLoopsActions.utilityLoopsTab.loopEntryCard;
  await card.playButtonForEntry(entry).hover();
  const creation = card.loopScissorsButtonForEntry(entry);
  if (profile.visible.includes('savedCreate')) await expect(creation).toBeVisible();
  else await expect(creation).toBeHidden();
  if (profile.visible.includes('loopManagement')) {
    await expect(card.deleteButtonForEntry(entry)).toBeVisible();
    await expect(boundary.visibleLoopReorder.first()).toBeVisible();
    await expect(entry).toHaveAttribute('draggable', 'true');
  } else {
    await expect(card.deleteButtonForEntry(entry)).toBeHidden();
    await expect(boundary.visibleLoopReorder).toHaveCount(0);
    await expect(entry).toHaveAttribute('draggable', 'false');
  }
  await utilityLoopsActions.playLoopByName(loopName);
  const evidence = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.frameCount).toBeGreaterThan(0);
  if (!profile.visible.includes('play')) await expect(ui.player).toBeHidden();
}
