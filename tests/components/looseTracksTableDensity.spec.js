const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const cssRoot = path.join(root, 'music_app', 'static', 'css');
const jsRoot = path.join(root, 'music_app', 'static', 'js', 'runtime');

// Loose Tracks renders its rows through the shared track table; Album Details keeps the approved compact table.
async function mountTables(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`<!doctype html><html><head><style>
    :root { --appearance-ink: #f3f6fa; --appearance-muted: #9aa9bc; --appearance-card: #101a29; --text: #f3f6fa; --muted: #9aa9bc; }
    body { margin: 0; padding: 24px; background: #080d16; color: var(--text); font: 15px "Segoe UI", Arial, sans-serif; }
  </style></head><body>
    <div class="non-album-modal non-album-modal--page"><div class="non-album-modal-dialog"><div class="non-album-modal-table-wrap"><div id="loose" class="non-album-modal-table"></div></div></div></div>
    <div id="album"></div>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css', 'runtime/running-line.css', 'runtime/non-album-and-player.css']) {
    await page.addStyleTag({ path: path.join(cssRoot, file) });
  }
  await page.evaluate(() => {
    window.escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    window.ButtonComponent = { renderIconSvg: () => '', renderActionButton: () => '' };
    window.state = { player: { current: null }, view: { query: '' } };
    window.getPlayerPlaybackSnapshot = () => ({ paused: true, ended: false });
    window.formatTrackDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    window.formatAlbumDuration = window.formatTrackDuration;
    window.buildProblematicAlbumTrackPathIndex = () => new Map();
  });
  for (const file of ['running-line.js', 'compact-data-table.js', 'album-track-table.js', 'modal-and-overlay-helpers.js']) {
    await page.addScriptTag({ path: path.join(jsRoot, file) });
  }
  await page.evaluate(() => {
    document.getElementById('loose').innerHTML = buildNonAlbumTrackSectionsMarkup([
      { path: 'C:/Music/one.mp3', title: 'Loose title one', artist: 'ДДТ', year_label: '1997', duration_seconds: 241 },
      { path: 'C:/Music/two.mp3', title: 'Loose title two', artist: 'Neal Morse', year_label: '2004', duration_seconds: 187 },
    ]);
    document.getElementById('album').innerHTML = buildAlbumTrackTableHtml({ groups: [{ tracks: [
      { title: 'Album title one', secondaryArtist: 'Guest', duration: '3:42' },
    ] }] });
  });
}

async function rowGeometry(page, scope) {
  return page.locator(`${scope} .album-track-table__row--secondary`).first().evaluate((row) => {
    const title = row.querySelector('.album-track-table__title');
    const secondary = row.querySelector('.album-track-table__secondary > span');
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title.firstChild);
    const secondaryRange = document.createRange();
    secondaryRange.selectNodeContents(secondary);
    return {
      density: row.closest('.compact-data-table').dataset.cdtDensity,
      rowHeight: row.getBoundingClientRect().height,
      titleFontSize: parseFloat(getComputedStyle(title).fontSize),
      secondaryFontSize: parseFloat(getComputedStyle(secondary).fontSize),
      gap: secondaryRange.getBoundingClientRect().top - titleRange.getBoundingClientRect().bottom,
    };
  });
}

for (const width of [1440, 390]) {
  test(`Loose Tracks rows use the larger table density with a gap under the title at ${width}px`, async ({ page }) => {
    await mountTables(page, width);
    const loose = await rowGeometry(page, '#loose');
    const album = await rowGeometry(page, '#album');
    // Album Details stays on the approved compact table.
    expect(album.density).toBe('compact');
    expect(loose.density).toBe('default');
    await expect(page.locator('#loose .compact-data-table[data-cdt-density="compact"]')).toHaveCount(0);
    expect(loose.titleFontSize).toBeGreaterThan(album.titleFontSize);
    expect(loose.secondaryFontSize).toBeGreaterThan(album.secondaryFontSize);
    expect(loose.rowHeight).toBeGreaterThan(album.rowHeight);
    // The second line sits clearly below the title instead of touching it.
    expect(loose.gap, JSON.stringify(loose)).toBeGreaterThanOrEqual(4);
  });
}
