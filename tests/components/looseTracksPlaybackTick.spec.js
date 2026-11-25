const path = require('node:path');
const { test, expect } = require('@playwright/test');
const staticRoot = path.resolve(__dirname, '../../music_app/static');
test.use({ trace: 'off', screenshot: 'off' });

// A playback position tick on a 1,000-row Loose Tracks page used to rewrite every row's
// duration cell: thousands of DOM nodes a second on a phone, with stuttering audio.
for (const width of [390, 1000]) {
  test(`a playback tick on 1,000 loose tracks changes only the playing row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent('<style>*{box-sizing:border-box}body{margin:0;font:14px Arial}#non-album-modal{height:600px;overflow:auto}</style><div id="non-album-modal" class="non-album-modal-table"></div>');
    for (const file of ['runtime/compact-data-table.css', 'runtime/album-track-table.css', 'runtime/non-album-and-player.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.evaluate(() => {
      window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
      window.ButtonComponent = { renderIconSvg: name => `<svg class="ui-icon--${name}" width="16" height="16"><path d="M2 2L14 8L2 14Z"/></svg>` };
    });
    for (const file of ['compact-data-table.js', 'album-track-table.js']) {
      await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
    }
    await page.evaluate(() => {
      const page = document.getElementById('non-album-modal');
      page.innerHTML = buildAlbumTrackTableHtml({
        groups: [{ discLabel: 'Loose', tracks: Array.from({ length: 1000 }, (_, i) => ({
          path: `C:\\Music\\Loose "${i}"\\track-${i}.flac`, title: `Loose track ${i}`, duration: '3:00',
        })) }],
        forceGroupLabels: true,
      });
      window.tick = (seconds, trackPath = 'C:\\Music\\Loose "2"\\track-2.flac') => {
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(page, { subtree: true, childList: true, characterData: true, attributes: true });
        syncAlbumTrackTablePlayback(page, { trackPath, playing: true, currentTime: `0:${String(seconds).padStart(2, "0")} / 3:00` });
        records.push(...observer.takeRecords());
        observer.disconnect();
        return records.length;
      };
    });
    const rows = page.locator('[data-track-row-path]');
    await expect(rows).toHaveCount(1000);
    await page.evaluate(() => tick(41));
    const playing = rows.nth(2);
    await expect(playing).toHaveClass(/album-track-table__row--playing/);
    await expect(playing.getByRole('button', { name: 'Pause track', exact: true })).toBeVisible();

    const mutationsPerTick = [];
    for (const seconds of [42, 43, 44, 45]) mutationsPerTick.push(await page.evaluate(value => tick(value), seconds));
    await expect(playing.locator('.track-duration')).toHaveText('0:45 / 3:00');
    await expect(rows.nth(1).locator('.track-duration')).toHaveText('3:00');
    await expect(rows.nth(999).locator('.track-duration')).toHaveText('3:00');
    expect(Math.max(...mutationsPerTick), `mutations per tick: ${mutationsPerTick}`).toBeLessThanOrEqual(1);

    // The next track: the old row is restored and only two rows change.
    const changed = await page.evaluate(() => tick(0, 'C:\\Music\\Loose "999"\\track-999.flac'));
    await expect(playing).not.toHaveClass(/album-track-table__row--(current|playing)/);
    await expect(playing.locator('.track-duration')).toHaveText('3:00');
    await expect(playing.getByRole('button', { name: 'Play track', exact: true })).toBeAttached();
    await expect(rows.nth(999)).toHaveClass(/album-track-table__row--playing/);
    await expect(rows.nth(999).locator('.track-duration')).toHaveText("0:00 / 3:00");
    expect(changed).toBeLessThan(40);
  });
}
