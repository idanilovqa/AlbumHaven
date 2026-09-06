import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-PLAYER-019 / FTC-PLAYER-020 / FTC-PLAYER-021 / FTC-PLAYER-022';
const ALBUM = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
const TRACK_TITLE = 'Fake Loop Source';

test(`${CASE_ID} switches expanded, docked, and floating player views without sharing runner state`, async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  let selectedTrack;

  await stepLogger.step('Start generated playback through the production album flow', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity(ALBUM);
    await trackModalActions.waitForLoadedSummary();
    const playbackMark = await playbackEvidence.playbackMark();
    selectedTrack = await trackModalActions.playTrackByTitle(TRACK_TITLE);
    expect(selectedTrack.title).toBe(TRACK_TITLE);
    await globalPlayerActions.waitForCurrentTrack({ path: selectedTrack.path, trackTitle: TRACK_TITLE });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await trackModalActions.close();
  });

  await stepLogger.step('Apply regular and waveform seekbar geometry without changing playback identity', async () => {
    const playbackBeforeGeometry = await globalPlayerActions.readCurrentPlaybackSummary();

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.saveCompactPlayerStyle('docked');
    await utilityAppearanceActions.selectSeekbarMode('default');
    await settingsModalAppBarActions.closeSettings();
    await globalPlayerActions.expectExpandedGeometry('regular');

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.selectSeekbarMode('waveform');
    await settingsModalAppBarActions.closeSettings();
    await globalPlayerActions.expectExpandedGeometry('waveform');

    const playbackAfterGeometry = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(playbackAfterGeometry.title).toBe(playbackBeforeGeometry.title);
    expect(playbackAfterGeometry.paused).toBe(playbackBeforeGeometry.paused);
  });

  await stepLogger.step('Force waveform geometry during loop editing and restore regular geometry on cancel', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.selectSeekbarMode('default');
    await settingsModalAppBarActions.closeSettings();
    await globalPlayerActions.expectExpandedGeometry('regular');

    const playbackBeforeLoop = await globalPlayerActions.readCurrentPlaybackSummary();
    await globalPlayerActions.openLoopEditor();
    await globalPlayerActions.expectExpandedGeometry('waveform');
    const playbackDuringLoop = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(playbackDuringLoop.title).toBe(playbackBeforeLoop.title);
    expect(playbackDuringLoop.paused).toBe(playbackBeforeLoop.paused);

    expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);
    await globalPlayerActions.expectExpandedGeometry('regular');
    const playbackAfterLoop = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(playbackAfterLoop.title).toBe(playbackBeforeLoop.title);
    expect(playbackAfterLoop.paused).toBe(playbackBeforeLoop.paused);
  });

  await stepLogger.step('Collapse to Docked and expand without changing playback identity', async () => {
    const before = await globalPlayerActions.readCurrentPlaybackSummary();
    const docked = await globalPlayerActions.collapsePlayer('docked');
    expect(docked.player.height).toBe(76);
    expect(docked.player.width).toBeGreaterThan(200);
    expect(docked.rootClasses).toContain('has-docked-compact-player');
    await expect(globalPlayerActions.globalPlayer.compactPlayer.controls.previousButton).toBeDisabled();
    await expect(globalPlayerActions.globalPlayer.compactPlayer.controls.nextButton).toBeEnabled();
    await expect(globalPlayerActions.globalPlayer.compactPlayer.controls.playPauseButton).toBeVisible();
    const during = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(during.title).toBe(before.title);
    expect(during.paused).toBe(before.paused);
    await globalPlayerActions.expandPlayer();
    const after = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(after.title).toBe(before.title);
    expect(after.paused).toBe(before.paused);
  });

  await stepLogger.step('Save Floating in Appearance and collapse into its overlay layout', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.saveCompactPlayerStyle('floating');
    await settingsModalAppBarActions.closeSettings();

    const floating = await globalPlayerActions.collapsePlayer('floating');
    expect(floating.player.width).toBe(96);
    expect(floating.player.height).toBe(96);
    expect(floating.player.x).toBeCloseTo(12, 0);
    expect(page.viewportSize().height - floating.player.y - floating.player.height).toBeCloseTo(4, 0);
    expect(floating.rootClasses).toContain('has-floating-compact-player');
    expect(floating.expandOwnedByCompactShell).toBe(true);
    expect(floating.expand.x).toBeLessThan(floating.player.x);
    await expect(globalPlayerActions.globalPlayer.compactPlayer.controls.previousButton).toBeHidden();
    await expect(globalPlayerActions.globalPlayer.compactPlayer.controls.nextButton).toBeHidden();
    await expect(globalPlayerActions.globalPlayer.compactPlayer.coverButton)
      .toHaveAttribute('aria-label', 'Double-click to open album details');

    const idleAppearance = floating.floatingAppearance;
    await globalPlayerActions.globalPlayer.player.hover();
    const hoverAppearance = (await globalPlayerActions.readViewCheckpoint()).floatingAppearance;
    expect(hoverAppearance.borderColor).not.toBe(idleAppearance.borderColor);
    expect(hoverAppearance.boxShadow).not.toBe(idleAppearance.boxShadow);
    await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height / 2);
    await globalPlayerActions.globalPlayer.compactPlayer.expand.root.focus();
    const focusAppearance = (await globalPlayerActions.readViewCheckpoint()).floatingAppearance;
    expect(focusAppearance.borderColor).not.toBe(idleAppearance.borderColor);
    expect(focusAppearance.coverBoxShadow).not.toBe(idleAppearance.coverBoxShadow);
    await globalPlayerActions.globalPlayer.compactPlayer.expand.root.blur();
  });

  await stepLogger.step('Distinguish Floating artwork activation from a bounded drag', async () => {
    await globalPlayerActions.globalPlayer.compactPlayer.coverButton.click();
    await expect(trackModalActions.trackModal.dialog).toBeHidden();
    await globalPlayerActions.globalPlayer.compactPlayer.coverButton.dblclick();
    const opened = await trackModalActions.waitForLoadedSummary();
    expect(opened.title).toContain(ALBUM.album);
    await trackModalActions.close();

    const drag = await globalPlayerActions.dragFloatingPlayerTo('top-right');
    expect(drag.after.player.x).toBeGreaterThan(drag.before.player.x);
    expect(drag.after.player.x + drag.after.player.width).toBeLessThanOrEqual(drag.viewport.width - 3);
    expect(drag.after.player.y).toBeGreaterThanOrEqual(3);
    await expect(trackModalActions.trackModal.dialog).toBeHidden();
  });

  await stepLogger.step('Persist style across reload and exclude compact mode on narrow web', async () => {
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await expect(globalPlayerActions.globalPlayer.documentRoot).toHaveAttribute('data-compact-player-style', 'floating');
    const restored = await globalPlayerActions.readViewCheckpoint();
    expect(restored.style).toBe('floating');

    await page.setViewportSize({ width: 800, height: 760 });
    await expect(globalPlayerActions.globalPlayer.collapse.root).toBeHidden();
    expect((await globalPlayerActions.readViewCheckpoint()).mode).toBe('expanded');

    await page.setViewportSize({ width: 1280, height: 760 });
    await expect(globalPlayerActions.globalPlayer.player).toHaveClass(/\bis-compact\b/);
    expect((await globalPlayerActions.readViewCheckpoint()).style).toBe('floating');
    await globalPlayerActions.expandPlayer();
  });
});
