import { assertCapabilityBoundary } from '../actions/capabilityBoundaryActions.js';
import { assertOwnedLoopBoundary } from '../actions/capabilityLoopBoundaryActions.js';
import { enrollCapabilityMember, openCapabilityFixtureAlbum } from '../actions/capabilityEditorActions.js';
import { authenticatedPageGet } from '../../helpers/authenticatedPageRequest.js';
import { CapabilityPracticePage } from '../poms/capabilityPracticePage.js';
import { CapabilityPage } from '../poms/capabilityPage.js';
import { test, expect } from '../support/baseFixtures.js';

// All mutations use a uniquely named user and the production invitation/editor.
test('FTC-CAP-AUDIT-009 Play implies locked View and repeated saves preserve explicit prerequisites', async ({ page, freshBrowserSession }) => {
  const editor = await enrollCapabilityMember(page, freshBrowserSession, ['Play music']);
  await editor.expectRequired('View library', 'Play music');
  await editor.capability('Change covers').check();
  await editor.saveChangedAccess();
  await editor.capability('Play music').uncheck();
  await editor.capability('Change covers').uncheck();
  await expect(editor.capability('View library')).not.toBeChecked();
  await expect(editor.capability('View library')).toBeEnabled();
  await editor.capability('View library').check();
  await editor.capability('Play music').check();
  await editor.expectRequired('View library', 'Play music');
  await editor.saveChangedAccess();
  await editor.capability('Play music').uncheck();
  await expect(editor.capability('View library')).toBeChecked();
  await expect(editor.capability('View library')).toBeEnabled();
  await editor.saveChangedAccess();
  await editor.page.reload();
  await expect(editor.capability('View library')).toBeChecked();
  await expect(editor.capability('Play music')).not.toBeChecked();
  await assertCapabilityBoundary(page, { visible: [] });
});

for (const capability of ['Play music', 'Edit audio tags', 'Delete covers and missing inventory']) {
test(`FTC-CAP-AUDIT-010 ${capability} alone streams generated music through the production player`, async ({
  page, freshBrowserSession, galleryActions, globalPlayerActions, playbackEvidence, trackModalActions,
}) => {
  await enrollCapabilityMember(page, freshBrowserSession, [capability]);
  await openCapabilityFixtureAlbum(galleryActions);
  const mark = await playbackEvidence.playbackMark();
  const track = await trackModalActions.playTrackAt(0);
  expect(track.title).toBe('Continuous Signal');
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  await expect(globalPlayerActions.globalPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
  expect(playbackEvidence.activeSocketCount()).toBe(1);
  await assertCapabilityBoundary(page, { visible: capability.startsWith('Delete') ? ['play', 'delete'] : ['play'] });
});

}

test('FTC-CAP-AUDIT-011 Repair-only member opens Rules and Logs without playback', async ({ page, freshBrowserSession, utilityRulesActions, utilityLogHistoryActions }) => {
  await enrollCapabilityMember(page, freshBrowserSession, ['Repair files, rules and logs']);
  const ui = new CapabilityPage(page);
  await ui.openSettings();
  await expect(ui.player).toBeHidden();
  await ui.tab('rules').click();
  await expect(ui.tab('rules')).toHaveAttribute('aria-selected', 'true');
  await expect(utilityRulesActions.utilityRulesTab.listItems.first()).toBeVisible();
  await ui.tab('log-history').click();
  await expect(ui.tab('log-history')).toHaveAttribute('aria-selected', 'true');
  await utilityLogHistoryActions.waitForReady();
  await expect(ui.player).toBeHidden();
  await assertCapabilityBoundary(page, { visible: ['repair'] });
});

test('FTC-CAP-AUDIT-012 cover controls follow Change covers and web tag editing also requires Admin', async ({
  page, freshBrowserSession, galleryActions, trackModalActions,
}) => {
  const editor = await enrollCapabilityMember(page, freshBrowserSession, ['Edit audio tags']);
  const ui = new CapabilityPage(page);
  const album = trackModalActions.trackModal;
  await openCapabilityFixtureAlbum(galleryActions);
  await expect(album.editTagsButton).toBeHidden();
  await expect(album.coverLookupButton).toBeHidden();
  await expect(ui.coverLookup).toBeHidden();
  await trackModalActions.close();
  await editor.capability('Change covers').check();
  await editor.saveChangedAccess();
  await page.reload();
  await openCapabilityFixtureAlbum(galleryActions);
  await expect(album.coverLookupButton).toBeVisible();
  await expect(album.editTagsButton).toBeHidden();
  await trackModalActions.close();
  await expect(ui.coverLookup).toBeVisible();
  await editor.capability('Administer users and access').check();
  await editor.saveChangedAccess();
  await page.reload();
  await openCapabilityFixtureAlbum(galleryActions);
  await expect(album.editTagsButton).toBeVisible();
  await expect(album.editTagsButton).toBeEnabled();
  await assertCapabilityBoundary(page, { visible: ['play', 'edit', 'covers', 'admin'] });
});


test('FTC-CAP-AUDIT-013 Practice retains owned loop artwork waveform and playback after Play and Create are removed', async ({
  page, freshBrowserSession, galleryActions, globalPlayerActions, trackModalActions,
  settingsModalAppBarActions, utilityTabBarActions, utilityAppearanceActions, utilityLoopsActions,
}) => {
  const editor = await enrollCapabilityMember(page, freshBrowserSession, ['Play music', 'Create loops', 'Practice with loops']);
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
  const loopName = 'Practice retained after playback revocation';
  expect((await globalPlayerActions.saveLoopWithName(loopName)).requestCount).toBe(1);
  await editor.capability('Play music').uncheck();
  await editor.capability('Create loops').uncheck();
  await editor.saveChangedAccess();
  await page.reload();
  const ui = new CapabilityPracticePage(page);
  await ui.openSettings();
  await expect(ui.player).toBeHidden();
  await ui.tab('loops').click();
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(track.title);
  const { entry, loopId } = await utilityLoopsActions.resolveLoopEntryByName(loopName);
  await ui.expectOwnedArtwork(loopId);
  await utilityLoopsActions.expectPausedLoopWaveformPainted(entry, loopId);
  await utilityLoopsActions.playLoopByName(loopName);
  const evidence = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.frameCount).toBeGreaterThan(0);
  await expect(ui.player).toBeHidden();
  const denied = await authenticatedPageGet(page, `/track?path=${encodeURIComponent(track.path)}`);
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toEqual({ detail: 'Action not permitted.' });
  await assertOwnedLoopBoundary(page, utilityLoopsActions, { visible: ['practice'] }, loopName);
  await assertCapabilityBoundary(page, { visible: ['practice'] });
});
