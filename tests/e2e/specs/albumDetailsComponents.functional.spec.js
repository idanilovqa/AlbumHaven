import { expect, test as base } from '../support/baseFixtures.js';
import { PERFORMANCE_AUTH_USERNAME } from '../support/performanceAuthentication.js';
import { withRestoredAppearanceFixture } from '../helpers/appearanceFixture.js';

const test = base.extend({
  appearanceBaseline: [async ({ context, managedAppLifecycle }, use) => {
    await withRestoredAppearanceFixture({ username: PERFORMANCE_AUTH_USERNAME, context, managedAppLifecycle }, use);
  }, { auto: true }],
});

const MULTI_DISC_ALBUM = 'Ordinary Numeric Disc Control';
const PLAYBACK_ALBUM = 'Featured Signal Collection';
const PLAYBACK_TRACK = 'Clean Signal';
const PROBLEMATIC_ALBUM = 'Neal Morse Plays Pink Floyd';
const PROBLEMATIC_TRACK = 'Comfortably Numb';

async function openAppearanceAlbumPage({
  settingsModalAppBarActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) {
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.openSection('album-page');
}

test('FTC-ALBUM-DETAILS-019 keeps all persisted layouts on the shared compact Album Details components', { tag: '@area:album-details' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();

  for (const layout of ['stacked_bar', 'editorial_canvas', 'classic_bar']) {
    await stepLogger.step(`Save and inspect the ${layout} Album Details layout`, async () => {
      await openAppearanceAlbumPage({
        settingsModalAppBarActions,
        utilityAppearanceActions,
        utilityTabBarActions,
      });
      await utilityAppearanceActions.selectAlbumLayout(layout);
      await utilityAppearanceActions.save();
      await expect(utilityAppearanceActions.utilityAppearanceTab.documentRoot)
        .toHaveAttribute('data-album-details-layout', layout);
      await settingsModalAppBarActions.closeSettings();

      await searchToolbarActions.search(MULTI_DISC_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(MULTI_DISC_ALBUM);
      await galleryActions.waitForAlbumVisible(MULTI_DISC_ALBUM);
      await galleryActions.clickAlbumDetailsByAlbumName(MULTI_DISC_ALBUM);
      await trackModalActions.waitForReady();
      await expect(trackModalActions.trackModal.header).toHaveAttribute('data-album-details-layout', layout);
      await expect(trackModalActions.trackModal.headerActions).toHaveCount(3);
      for (const action of await trackModalActions.trackModal.headerActions.all()) {
        const box = await action.boundingBox();
        expect(box).not.toBeNull();
        expect(box.width).toBeCloseTo(34, 0);
        expect(box.height).toBeCloseTo(34, 0);
      }
      const editAction = trackModalActions.trackModal.editTagsButton;
      await editAction.hover();
      // parity-check: allow-read-only-measurement-evaluate -- compare the real ActionButton hover border and outline
      await expect.poll(async () => editAction.evaluate((button) => {
        const style = getComputedStyle(button);
        return style.outlineWidth === '2px'
          && style.outlineColor === style.borderColor
          && style.outlineColor !== 'rgba(0, 0, 0, 0)';
      })).toBe(true);
      const artbox = trackModalActions.trackModal.artbox;
      const artboxBounds = await artbox.boundingBox();
      expect(artboxBounds).not.toBeNull();
      expect(Math.abs(artboxBounds.width - artboxBounds.height)).toBeLessThanOrEqual(1);
      await expect(trackModalActions.trackModal.albumTrackTable.root).toHaveAttribute('data-playing-animation', /^(enabled|disabled)$/);
      await expect(trackModalActions.trackModal.albumTrackTable.discHeadings).toHaveText(['CD 1', 'CD 2']);
      await expect(trackModalActions.trackModal.albumTrackTable.tables).toHaveCount(2);
      await expect(trackModalActions.trackModal.albumTrackTable.secondTableHeaders).toHaveCount(0);
      await expect(trackModalActions.trackModal.albumTrackTable.total).toHaveText(/Total Length:/);
      await expect(trackModalActions.trackModal.albumTrackTable.discHeadingsInsideTables).toHaveCount(0);
      const edgeHandoff = await trackModalActions.trackModal.albumTrackTable.readFinalEdgeHandoff();
      expect(edgeHandoff.edgeWidth).toBe('1px');
      expect(edgeHandoff.edgeRight).toBe('-1px');
      expect(edgeHandoff.edgeBackground).toContain('linear-gradient');
      expect(edgeHandoff.footerBorderRightWidth).toBe('1px');
      expect(edgeHandoff.footerCornerLayer).toBe('none');
      if (layout === 'editorial_canvas') {
        const alignment = await trackModalActions.trackModal.readEditorialTableAlignment();
        expect(alignment.delta).toBeLessThanOrEqual(1);
      }
      await trackModalActions.close();
    });
  }

  await stepLogger.step('Keep Editorial Canvas usable at a narrow web width', async () => {
    await openAppearanceAlbumPage({
      settingsModalAppBarActions,
      utilityAppearanceActions,
      utilityTabBarActions,
    });
    await utilityAppearanceActions.selectAlbumLayout('editorial_canvas');
    await utilityAppearanceActions.save();
    await settingsModalAppBarActions.closeSettings();
    await page.setViewportSize({ width: 390, height: 844 });
    await galleryActions.waitForAlbumVisible(MULTI_DISC_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(MULTI_DISC_ALBUM);
    await trackModalActions.waitForReady();
    const dialogBounds = await trackModalActions.trackModal.dialog.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds.width).toBeLessThanOrEqual(390);
    await expect(trackModalActions.trackModal.albumTrackTable.rows.first()).toBeVisible();
    await trackModalActions.close();
  });

  await stepLogger.step('Keep problematic status in its unlabeled column before Length', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await searchToolbarActions.search(PROBLEMATIC_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(PROBLEMATIC_ALBUM);
    await galleryActions.waitForAlbumVisible(PROBLEMATIC_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(PROBLEMATIC_ALBUM);
    await trackModalActions.waitForReady();

    const problemCell = trackModalActions.trackModal.problemCellByTrackTitle(PROBLEMATIC_TRACK);
    const durationCell = trackModalActions.trackModal.durationCellByTrackTitle(PROBLEMATIC_TRACK);
    await expect(trackModalActions.trackModal.problemButtonByTrackTitle(PROBLEMATIC_TRACK)).toBeVisible();
    await expect(trackModalActions.trackModal.albumTrackTable.problemHeaders).toHaveCount(1);
    await expect(trackModalActions.trackModal.albumTrackTable.tables.first().getByRole('columnheader', { name: 'Problem' })).toHaveCount(0);
    const [problemBounds, durationBounds] = await Promise.all([
      problemCell.boundingBox(),
      durationCell.boundingBox(),
    ]);
    expect(problemBounds).not.toBeNull();
    expect(durationBounds).not.toBeNull();
    expect(problemBounds.x + problemBounds.width).toBeLessThanOrEqual(durationBounds.x);
    await trackModalActions.close();
  });
});

test('FTC-ALBUM-DETAILS-020 preserves search, hover, playback, and reduced-motion states', { tag: '@area:album-details' }, async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();

  await stepLogger.step('Enable persisted playing-row animation for this owned scenario', async () => {
    await openAppearanceAlbumPage({ settingsModalAppBarActions, utilityAppearanceActions, utilityTabBarActions });
    if (await utilityAppearanceActions.utilityAppearanceTab.albumPlayingRowAnimationButton('enabled').getAttribute('aria-pressed') !== 'true') {
      await utilityAppearanceActions.setAlbumPlayingRowAnimation(true);
      await utilityAppearanceActions.save();
    }
    await settingsModalAppBarActions.closeSettings();
  });

  await stepLogger.step('Open a track search match and keep its persistent accent through hover', async () => {
    await searchToolbarActions.search(PLAYBACK_TRACK, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(PLAYBACK_TRACK);
    await galleryActions.waitForAlbumVisible(PLAYBACK_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(PLAYBACK_ALBUM);
    await trackModalActions.waitForReady();
    const passiveRow = trackModalActions.trackModal.albumTrackTable.rows.nth(1);
    await expect(passiveRow).not.toHaveClass(/album-track-table__row--search-match/);
    // parity-check: allow-read-only-measurement-evaluate -- compare the real passive row surface before and during hover
    const passiveBeforeHover = await passiveRow.evaluate((row) => getComputedStyle(row).backgroundColor);
    await passiveRow.hover();
    // parity-check: allow-read-only-measurement-evaluate -- read the passive row's rendered hover surface and lack of accent
    const passiveDuringHover = await passiveRow.evaluate((row) => ({
      backgroundColor: getComputedStyle(row).backgroundColor,
      boxShadow: getComputedStyle(row).boxShadow,
    }));
    expect(passiveDuringHover.backgroundColor).not.toBe(passiveBeforeHover);
    expect(passiveDuringHover.boxShadow).toBe('none');

    const matchingRow = trackModalActions.trackModal.albumTrackTable.rows.first();
    await expect(trackModalActions.trackModal.trackTitleAt(0)).toContainText(PLAYBACK_TRACK);
    await expect(matchingRow).toHaveAttribute('data-track-search-match', 'true');
    // parity-check: allow-read-only-measurement-evaluate -- read the persistent search accent before hover
    const searchBeforeHover = await matchingRow.evaluate((row) => ({
      backgroundColor: getComputedStyle(row).backgroundColor,
      boxShadow: getComputedStyle(row).boxShadow,
    }));
    await matchingRow.hover();
    await expect(matchingRow).toHaveAttribute('data-track-search-match', 'true');
    // parity-check: allow-read-only-measurement-evaluate -- read the persistent search accent during hover
    const searchDuringHover = await matchingRow.evaluate((row) => ({
      backgroundColor: getComputedStyle(row).backgroundColor,
      boxShadow: getComputedStyle(row).boxShadow,
    }));
    expect(searchBeforeHover.boxShadow).not.toBe('none');
    expect(searchDuringHover.boxShadow).toBe(searchBeforeHover.boxShadow);
    expect(searchDuringHover.backgroundColor).not.toBe(searchBeforeHover.backgroundColor);
  });

  await stepLogger.step('Start real playback and keep the themed playing outline and perimeter motion', async () => {
    const playbackMark = await playbackEvidence.playbackMark();
    const selected = await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForCurrentTrack({ path: selected.path, trackTitle: selected.title });
    const playingRow = trackModalActions.trackModal.albumTrackTable.rows.nth(0);
    await expect(playingRow).toHaveClass(/album-track-table__row--playing/);
    await expect(playingRow).toHaveClass(/album-track-table__row--animated/);
    await expect(trackModalActions.trackModal.albumTrackTable.playButtons.nth(0)).toHaveAttribute('aria-label', 'Pause track');
    const playback = await playbackEvidence.waitForTrackPlaybackEvidence({ after: playbackMark, path: selected.path });
    expect(playback.nonZeroSamples).toBeGreaterThan(0);
    expect(playback.renderedFrameDelta).toBeGreaterThan(0);
    // parity-check: allow-read-only-measurement-evaluate -- inspect the rendered playing outline and pseudo-element animation
    const visualState = await playingRow.evaluate((row) => ({
      outlineColor: getComputedStyle(row).outlineColor,
      beforeAnimation: getComputedStyle(row, '::before').animationName,
      afterAnimation: getComputedStyle(row, '::after').animationName,
    }));
    expect(visualState.outlineColor).not.toBe('rgb(128, 128, 128)');
    expect(visualState.beforeAnimation).toContain('album-track-perimeter-spectrum');
    expect(visualState.afterAnimation).toContain('album-track-perimeter-spectrum');
    await trackModalActions.trackModal.albumTrackTable.playButtons.nth(0).click();
    await globalPlayerActions.waitForPlaybackState({ paused: true });
    await trackModalActions.trackModal.albumTrackTable.playButtons.nth(0).click();
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    await globalPlayerActions.waitForDisplayedPlaybackAdvance(0);
  });

  await stepLogger.step('Disable motion and honor reduced-motion while retaining the static playing outline', async () => {
    await trackModalActions.close();
    await openAppearanceAlbumPage({
      settingsModalAppBarActions,
      utilityAppearanceActions,
      utilityTabBarActions,
    });
    await utilityAppearanceActions.setAlbumPlayingRowAnimation(false);
    await utilityAppearanceActions.save();
    await settingsModalAppBarActions.closeSettings();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await galleryActions.waitForAlbumVisible(PLAYBACK_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(PLAYBACK_ALBUM);
    await trackModalActions.waitForReady();
    const playingRow = trackModalActions.trackModal.albumTrackTable.rows.nth(0);
    await expect(trackModalActions.trackModal.albumTrackTable.root).toHaveAttribute('data-playing-animation', 'disabled');
    await expect(playingRow).toHaveClass(/album-track-table__row--playing/);
    await expect(playingRow).not.toHaveClass(/album-track-table__row--animated/);
    await expect(playingRow).toHaveCSS('outline-style', 'solid');
    await expect(playingRow).toHaveCSS('outline-width', '1px');
    // parity-check: allow-read-only-measurement-evaluate -- reduced motion must remove moving spectra while preserving the real row
    expect(await playingRow.evaluate((row) => getComputedStyle(row, '::before').display)).toBe('none');
  });
});
