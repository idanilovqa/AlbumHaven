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
    await page.setViewportSize({ width: 320, height: 568 });
    for (const [trigger, menu, selected] of [[loops.speed, loops.speedMenu, '2x'], [loops.pitch, loops.pitchMenu, '+2 semitones']]) {
      await trigger.scrollIntoViewIfNeeded();
      const anchor = await trigger.boundingBox();
      await trigger.tap();
      await loops.expectPickerInsideViewport(menu);
      await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText(selected);
      await page.touchscreen.tap(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
      await expect(menu).not.toBeVisible();
      await trigger.tap();
      const popup = await menu.boundingBox();
      expect(popup.x).toBeGreaterThan(0);
      await page.touchscreen.tap(popup.x / 2, popup.y + popup.height / 2);
      await expect(menu).not.toBeVisible();
    }
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


test('an unavailable saved-loop deep link returns to the usable mobile index', async ({ page, app }) => {
  const loops = new MobileLoopsPage(page);
  await page.goto('/?mobile_page=utilities&utility_tab=loops&loop_song=removed-review-loop');
  await loops.expectLoopIndex();
  await expect(loops.song).toBeVisible();
  await loops.song.click();
  await loops.expectSongPage();
  await loops.backButton.click();
  await loops.expectLoopIndex();
});
