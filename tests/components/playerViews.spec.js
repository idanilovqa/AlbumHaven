const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const playerCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'non-album-and-player.css',
);
const baseLayoutCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'base-layout.css',
);
const buttonCssPath = path.join(repositoryRoot, 'music_app', 'static', 'css', 'button-component.css');
const componentUrl = 'http://player-component.test/player';

const expandedControls = `
  <div class="player-controls">
    <button class="button ui-button ui-button--icon ui-button--small player-collapse-button" type="button" aria-label="Collapse player"><span class="ui-button__content">‹</span></button>
    <button class="player-cover-button" type="button" aria-label="Open album details"></button>
    <div class="playback-control-cluster playback-control-cluster--expanded player-play-cluster" data-playback-control-cluster data-playback-control-variant="expanded-player">
      <div class="loop-play-control-cluster">
        <button class="loop-play-control-button" type="button" aria-label="Pause">⏸</button>
        <div class="loop-play-control-actions" aria-hidden="true"></div>
      </div>
    </div>
  </div>`;

const compactControls = `
  <div class="compact-player-shell" aria-label="Compact player">
    <button class="button ui-button ui-button--icon ui-button--small compact-player-expand" type="button" aria-label="Expand player"><span class="ui-button__content">›</span></button>
    <button class="compact-player-cover" data-compact-player-cover type="button" aria-label="Open album details"></button>
    <div class="playback-control-cluster playback-control-cluster--compact compact-player-transport" data-playback-control-cluster data-playback-control-variant="compact-player">
      <button class="compact-player-skip" type="button" data-compact-player-previous aria-label="Previous track">‹</button>
      <button class="compact-player-play" type="button" data-compact-player-play aria-label="Pause">⏸</button>
      <button class="compact-player-skip" type="button" data-compact-player-next aria-label="Next track">›</button>
    </div>
  </div>`;

async function mountPlayer(page, mode) {
  const isExpanded = mode === 'waveform' || mode === 'regular';
  const isWaveform = mode === 'waveform';
  const rootClasses = mode === 'docked'
    ? 'has-compact-player has-docked-compact-player'
    : mode === 'floating'
      ? 'has-compact-player has-floating-compact-player'
      : isWaveform
        ? 'has-waveform-player'
        : '';
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html class="${rootClasses}">
      <head><style>
        * { box-sizing: border-box; }
        :root { --app-sidebar-width: 280px; color-scheme: dark; }
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        body { background: #08101d; color: #f0fdf4; font-family: Arial, sans-serif; }
        .global-player { --compact-docked-left: 0px; --compact-docked-width: 280px; --compact-player-x: 12px; --compact-player-y: 532px; }
        .player-waveform-canvas { display: block; width: 100%; height: 100%; background: linear-gradient(to bottom, transparent 48%, #7cbaa4 49%, #7cbaa4 51%, transparent 52%); }
        *, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }
      </style></head>
      <body>
        <div class="global-player shell-bottom-player ${mode === 'docked' ? 'is-compact is-docked-compact' : mode === 'floating' ? 'is-compact is-floating-compact' : ''}" data-player-view="${mode}" ${isExpanded ? `data-player-seekbar-presentation="${mode}"` : ''}>
          <div class="player-shell" aria-hidden="${!isExpanded}">${expandedControls}
            <div class="player-main">
              <div class="player-meta"><div class="player-title">Transatlantic - We All Need Some Light</div><button class="player-album-link" type="button">/ SMPTe</button></div>
              <div class="player-time">3:13 / 5:46</div>
              <div class="player-timeline-wrap${isWaveform ? ' is-waveform' : ''}">
                <canvas class="player-waveform-canvas" width="900" height="56" aria-hidden="true"${isWaveform ? '' : ' hidden'}></canvas>
                <input class="player-timeline" type="range" min="0" max="346" value="193" aria-label="Seek">
              </div>
            </div>
          </div>
          ${compactControls}
        </div>
      </body></html>`,
  }));
  await page.goto(componentUrl);
  await page.addStyleTag({ path: baseLayoutCssPath });
  await page.addStyleTag({ path: buttonCssPath });
  await page.addStyleTag({ path: playerCssPath });
}

for (const mode of ['docked', 'floating']) {
  test(`compact cover CSS accepts quoted paths in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    const requestedPaths = [];
    await page.route('**/cover?*', route => {
      requestedPaths.push(new URL(route.request().url()).searchParams.get('path'));
      return route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="green"/></svg>' });
    });
    await mountPlayer(page, mode);
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/playback-control-cluster.js') });
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/compact-player-helpers.js') });
    await page.addScriptTag({ content: 'var state = { player: { current: null, playbackQueue: { tracks: [] } } }; function currentQueueIndex() { return -1; }' });
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/compact-player-controller.js') });
    await page.evaluate(value => { compactPlayerStyle = value; }, mode);
    const cover = page.locator('[data-compact-player-cover]');
    for (const coverPath of ['Album/Previous cover.jpg', 'Artist/It\'s a "live" album (2026)/cover.jpg']) {
      await page.evaluate(value => {
        syncCompactPlayerUi({ playback: { paused: true }, displayTrack: { coverPath: value, src: '/audio' }, lockedByAnotherTab: false });
      }, coverPath);
      await expect(cover).toHaveCSS('background-image', `url("${new URL(`/cover?path=${encodeURIComponent(coverPath)}`, componentUrl).href}")`);
      await expect.poll(() => requestedPaths).toContain(coverPath);
    }
    await page.evaluate(() => { state.player.current = null; syncCompactPlayerUi({ playback: { paused: true }, lockedByAnotherTab: false }); });
    await expect(cover).toHaveCSS('background-image', 'none');
  });
}

function centerY(box) {
  return box.y + (box.height / 2);
}

test('expanded waveform player uses the approved centerline and player-edge metadata anchor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'waveform');

  const player = page.locator('[data-player-view="waveform"]');
  const collapse = player.getByRole('button', { name: 'Collapse player' });
  const cover = player.getByRole('button', { name: 'Open album details' }).first();
  const play = player.getByRole('button', { name: 'Pause' }).first();
  const waveform = player.locator('.player-timeline-wrap');
  const metadata = player.locator('.player-meta');
  const [playerBox, collapseBox, coverBox, playBox, waveformBox, metadataBox] = await Promise.all([
    player.boundingBox(), collapse.boundingBox(), cover.boundingBox(), play.boundingBox(),
    waveform.boundingBox(), metadata.boundingBox(),
  ]);
  const paddingLeft = Number.parseFloat(await player.evaluate((element) => getComputedStyle(element).paddingLeft));
  const expectedCenterline = playerBox.y + 57;

  expect(playerBox.height).toBe(92);
  for (const [name, box] of [['collapse', collapseBox], ['cover', coverBox], ['play', playBox], ['waveform', waveformBox]]) {
    expect.soft(Math.abs(centerY(box) - expectedCenterline), `${name} centerline offset`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(metadataBox.x - (playerBox.x + paddingLeft))).toBeLessThanOrEqual(1);
  await expect(player).toHaveScreenshot('expanded-waveform-player.png', { animations: 'disabled' });
});

test('expanded regular player uses the approved centerline and seekbar-edge text anchors', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'regular');

  const player = page.locator('[data-player-view="regular"]');
  const collapse = player.getByRole('button', { name: 'Collapse player' });
  const cover = player.getByRole('button', { name: 'Open album details' }).first();
  const play = player.getByRole('button', { name: 'Pause' }).first();
  const timeline = player.getByRole('slider', { name: 'Seek' });
  const metadata = player.locator('.player-meta');
  const timestamp = player.locator('.player-time');
  const [playerBox, collapseBox, coverBox, playBox, timelineBox, metadataBox, timestampBox] = await Promise.all([
    player.boundingBox(), collapse.boundingBox(), cover.boundingBox(), play.boundingBox(),
    timeline.boundingBox(), metadata.boundingBox(), timestamp.boundingBox(),
  ]);
  const expectedCenterline = playerBox.y + 39;

  expect(playerBox.height).toBe(68);
  for (const [name, box] of [['collapse', collapseBox], ['cover', coverBox], ['play', playBox], ['timeline', timelineBox]]) {
    expect.soft(Math.abs(centerY(box) - expectedCenterline), `${name} centerline offset`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(metadataBox.x - timelineBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(metadataBox.y - (playerBox.y + 10))).toBeLessThanOrEqual(1);
  expect(Math.abs(timestampBox.y - (playerBox.y + 11))).toBeLessThanOrEqual(1);
  expect(Math.abs((playerBox.y + playerBox.height) - (timelineBox.y + timelineBox.height) - 5)).toBeLessThanOrEqual(1);
  await expect(player).toHaveScreenshot('expanded-regular-player.png', { animations: 'disabled' });
});

test('docked compact player balances expand, artwork, and transport without exposing expanded content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'docked');

  const player = page.locator('[data-player-view="docked"]');
  const shell = player.locator('.compact-player-shell');
  const expand = player.getByRole('button', { name: 'Expand player' });
  const cover = player.getByRole('button', { name: 'Open album details' }).last();
  const transport = player.locator('.compact-player-transport');
  const [playerBox, shellBox, expandBox, coverBox, transportBox] = await Promise.all([
    player.boundingBox(), shell.boundingBox(), expand.boundingBox(), cover.boundingBox(), transport.boundingBox(),
  ]);

  expect(playerBox.width).toBe(280);
  expect(playerBox.height).toBe(76);
  for (const box of [shellBox, expandBox, coverBox, transportBox]) {
    expect(Math.abs(centerY(box) - centerY(playerBox))).toBeLessThanOrEqual(1);
  }
  expect(expandBox.x).toBeLessThan(coverBox.x);
  expect(coverBox.x + coverBox.width).toBeLessThan(transportBox.x);
  await expect(player.locator('.player-shell')).toHaveCSS('pointer-events', 'none');
  await expect(player).toHaveScreenshot('docked-compact-player.png', { animations: 'disabled' });
});

test('floating compact player retains its overlap, glow, and compact-only controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'floating');

  const player = page.locator('[data-player-view="floating"]');
  const expand = player.getByRole('button', { name: 'Expand player' });
  const cover = player.getByRole('button', { name: 'Open album details' }).last();
  const previous = player.getByRole('button', { name: 'Previous track' });
  const next = player.getByRole('button', { name: 'Next track' });
  const [playerBox, expandBox, coverBox] = await Promise.all([
    player.boundingBox(), expand.boundingBox(), cover.boundingBox(),
  ]);

  expect(playerBox.width).toBe(96);
  expect(playerBox.height).toBe(96);
  expect(expandBox.x).toBeLessThan(coverBox.x);
  expect(expandBox.y).toBeLessThan(coverBox.y);
  await expect(player).toHaveCSS('border-radius', '22px');
  expect(await player.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  await expect(previous).toBeHidden();
  await expect(next).toBeHidden();
  await expect(player.getByRole('button', { name: 'Pause' }).last()).toBeVisible();
  await expect(player).toHaveScreenshot('floating-compact-player.png', { animations: 'disabled' });
});
