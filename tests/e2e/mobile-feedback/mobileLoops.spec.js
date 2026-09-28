import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileLoopsPage } from '../poms/mobileLoopsPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`compact saved-loop players fit phones and operate pitch/speed in ${palette}`, async ({ page, app, snapshot }) => {
    const loops = new MobileLoopsPage(page);
    await loops.usePalette(palette);
    await loops.openFourLoopSong();
    await loops.expectSongPage();
    for (const width of [390, 320, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await loops.expectCompactPlayers();
    }
    await page.setViewportSize({ width: 390, height: 1200 });
    await snapshot(`70-four-mobile-loops-${palette}`);
    await loops.exercisePlaybackAndMenus();
    await loops.speed.tap();
    await loops.expectPickerInsideViewport(loops.speedMenu);
    await snapshot(`71-mobile-loop-speed-${palette}`);
    await page.keyboard.press('Escape');
    await loops.pitch.tap();
    await loops.expectPickerInsideViewport(loops.pitchMenu);
    await snapshot(`72-mobile-loop-pitch-${palette}`);
    await page.keyboard.press('Escape');
    await expect(loops.pitchMenu).not.toBeVisible();
  });
}

test('regular desktop saved-loop blocks retain inline controls and the same four clips', async ({ page, app, snapshot }) => {
  const loops = new MobileLoopsPage(page);
  await loops.openDesktopLoops();
  await snapshot('73-desktop-loop-reference');
});

for (const palette of ['black', 'parchment-pine']) {
  test(`mobile loop index filters before opening a song, and Back retains the list in ${palette}`, async ({ page, app, snapshot }) => {
    const loops = new MobileLoopsPage(page);
    await loops.usePalette(palette);
    await loops.openSettings();
    await loops.selectUtility('loops');
    await loops.expectLoopIndex();
    await snapshot(`74-loop-index-${palette}`);
    await loops.loopSearch.fill('Bridge study');
    await expect(loops.song).toBeVisible();
    await loops.song.click();
    await loops.expectSongPage();
    await snapshot(`75-loop-song-${palette}`);
    // Filtering the index never trims the selected song's four loop players.
    await loops.backButton.click();
    await loops.expectLoopIndex();
    await expect(loops.loopSearch).toHaveValue('Bridge study');
    await page.goForward();
    await loops.expectSongPage();
    await page.reload();
    await loops.expectSongPage();
    await loops.backButton.click();
    await loops.expectLoopIndex();
    await expect(loops.loopSearch).toHaveValue('Bridge study');
    await loops.loopSearch.fill('No such generated loop');
    await expect(loops.loopList).toHaveText('No matching loops.');
    await loops.loopSearch.fill('');
    await expect(loops.song).toBeVisible();
    await loops.backButton.click();
    await expect(loops.galleryContextName).toHaveText('Rendref');
  });
}
