import { test, expect } from '../fixtures/mobileFeedbackTest.js';
import { MobileLoopsPage } from '../poms/mobileLoopsPage.js';

for (const palette of ['black', 'parchment-pine']) {
  test(`compact saved-loop players fit phones and operate pitch/speed in ${palette}`, async ({ page, app, snapshot }) => {
    const loops = new MobileLoopsPage(page);
    await loops.usePalette(palette);
    await loops.openFourLoopSong();
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
