const path = require('node:path');
const { test, expect } = require('@playwright/test');
const staticRoot = path.resolve(__dirname, '../../music_app/static');

// On a phone the tapped row kept its hover tint and play circle after playback moved on:
// a tap leaves :hover and focus on the row, which touch screens never clear.
test.use({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function mountAlbum(page) {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:0;background:#101a29;color:#e6eef6;font:14px Arial}</style><div id="track-modal"></div>');
  for (const file of ['button-component.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.evaluate(() => { window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); });
  for (const file of ['button-component.js', 'runtime/compact-data-table.js', 'runtime/album-track-table.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  }
  await page.evaluate(() => {
    const album = document.getElementById('track-modal');
    album.innerHTML = buildAlbumTrackTableHtml({
      groups: [{ tracks: Array.from({ length: 8 }, (_, i) => ({ path: `/album/${i + 1}.flac`, title: `Track ${i + 1}`, trackNumber: i + 1, duration: '3:00' })) }],
    });
    window.playTrack = trackPath => syncAlbumTrackTablePlayback(album, { trackPath, playing: true, currentTime: '0:01 / 3:00' });
    // The shared player starts the tapped track.
    album.querySelectorAll('.play-track-button').forEach(button => button.addEventListener('click', () => playTrack(button.dataset.trackPath)));
  });
}

const look = row => row.evaluate((element) => {
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    outline: style.outlineStyle,
    number: getComputedStyle(element.querySelector('.album-track-table__number')).visibility,
    play: getComputedStyle(element.querySelector('.album-track-table__play')).opacity,
  };
});

test('after playback moves on, the tapped track looks exactly like an idle track on a phone', async ({ page }) => {
  await mountAlbum(page);
  const rows = page.locator('[data-track-row-path]');
  const idle = await look(rows.nth(7));
  expect(idle.number).toBe('visible');
  expect(idle.play).toBe('0');

  await rows.nth(4).locator('.album-track-table__play').tap();
  await expect(rows.nth(4)).toHaveClass(/album-track-table__row--playing/);
  await expect(rows.nth(4).getByRole('button', { name: 'Pause track', exact: true })).toBeVisible();

  // The track ends and the next one plays.
  await page.evaluate(() => playTrack('/album/6.flac'));
  await expect(rows.nth(5)).toHaveClass(/album-track-table__row--playing/);
  await expect(rows.nth(4)).not.toHaveClass(/album-track-table__row--(current|playing)/);
  await expect(rows.nth(4).locator('.album-track-table__number')).toBeVisible();
  expect(await look(rows.nth(4))).toEqual(idle);
  await expect(page.locator('.album-track-table__row--playing')).toHaveCount(1);
});

test('keyboard focus still reveals a track\'s play button where the device can hover', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 960, height: 700 } });
  const page = await context.newPage();
  await mountAlbum(page);
  const row = page.locator('[data-track-row-path]').nth(2);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(row.locator('.album-track-table__play')).toBeFocused();
  expect((await look(row)).play).toBe('1');
  expect((await look(row)).number).toBe('hidden');
  await context.close();
});
