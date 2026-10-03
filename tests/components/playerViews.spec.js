const path = require('node:path');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const { renderPlaybackControlCluster } = require(path.join(repositoryRoot, 'music_app/static/js/runtime/playback-control-cluster.js'));
const { renderButton } = require(path.join(repositoryRoot, 'music_app/static/js/button-component.js'));
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

const expandedControls = (loopControlStyle = 'capsule') => `
  <div class="player-controls">
    ${renderButton({ variant: 'icon', size: 'small', className: 'player-collapse-button', ariaLabel: 'Collapse player', label: '‹' })}
    <button class="player-cover-button" type="button" aria-label="Open album details"></button>
    ${renderPlaybackControlCluster({ variant: 'expanded-player', ownerId: 'global-player', loopControlStyle })}
  </div>`;

const compactControls = `
  <div class="compact-player-shell" aria-label="Compact player">
    ${renderButton({ variant: 'icon', size: 'small', className: 'compact-player-expand', ariaLabel: 'Expand player', label: '›' })}
    <button class="compact-player-cover" data-compact-player-cover type="button" aria-label="Open album details"></button>
    <div class="compact-player-metadata"><span class="compact-player-metadata-row" data-compact-player-title><span data-compact-player-title-text>Fixture song</span></span><span class="compact-player-metadata-row" data-compact-player-artist><span data-compact-player-artist-text>Fixture artist</span></span></div>
    ${renderPlaybackControlCluster({ variant: 'compact-player' })}
  </div>`;

async function mountPlayer(page, mode, loopControlStyle = 'capsule') {
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
        .global-player { --compact-docked-left: 0px; --compact-player-width: ${mode === 'floating' ? '96px' : '280px'}; --compact-player-x: 12px; --compact-player-y: 532px; }
        .player-waveform-canvas { display: block; width: 100%; height: 100%; background: linear-gradient(to bottom, transparent 48%, #7cbaa4 49%, #7cbaa4 51%, transparent 52%); }
        *, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }
      </style></head>
      <body>
        <div class="global-player shell-bottom-player ${mode === 'docked' ? 'is-compact is-docked-compact' : mode === 'floating' ? 'is-compact is-floating-compact' : ''}" data-player-view="${mode}" data-compact-presentation="${isExpanded ? 'expanded' : mode}" ${isExpanded ? `data-player-seekbar-presentation="${mode}"` : ''}>
          <div class="player-shell" aria-hidden="${!isExpanded}">${expandedControls(loopControlStyle)}
            <div class="player-main">
              <div class="player-meta"><div class="player-title">Transatlantic - We All Need Some Light</div><button class="player-album-link" type="button">/ SMPTe</button></div>
              <div class="player-time">3:13 / 5:46</div>
              <div class="player-timeline-wrap${isWaveform ? ' is-waveform' : ''}">
                <canvas class="player-waveform-canvas" width="900" height="56" aria-hidden="true"></canvas>
                <input class="player-timeline" type="range" min="0" max="346" value="193" aria-label="Seek">
              </div>
            </div>
          </div>
          ${compactControls}
        </div>
      </body></html>`,
  }));
  await page.goto(componentUrl);
  // Load the actual application theme tokens before component styles.
  await page.addStyleTag({ content: fs.readFileSync(baseLayoutCssPath, 'utf8').replace(/^\uFEFF/, '') });
  await page.addStyleTag({ path: buttonCssPath });
  await page.addStyleTag({ path: playerCssPath });
  if (mode === 'docked') await page.locator('.compact-player-expand').evaluate(element => { element.hidden = true; });
  const theme = await page.locator(':root').evaluate(element => {
    const style = getComputedStyle(element);
    return ['--success', '--panel-2', '--border'].map(name => style.getPropertyValue(name).trim());
  });
  expect(theme, 'component fixture must use the real base theme tokens').toEqual(['#34d399', '#0f172a', '#374151']);
  await page.locator('[data-playback-control-action="play-pause"]').evaluateAll(buttons => {
    for (const button of buttons) { button.setAttribute('aria-label', 'Pause'); const icon = button.querySelector('.compact-player-play-icon path'); if (icon) icon.setAttribute('d', 'M6 5h4v14H6zM14 5h4v14h-4z'); else button.textContent = '⏸'; }
  });
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
  expect(Number.parseFloat(await player.evaluate((element) => getComputedStyle(element).paddingLeft))).toBe(28);
  const expectedCenterline = playerBox.y + 57;

  expect(playerBox.height).toBe(100);
  for (const [name, box] of [['collapse', collapseBox], ['cover', coverBox], ['play', playBox], ['waveform', waveformBox]]) {
    expect.soft(Math.abs(centerY(box) - expectedCenterline), `${name} centerline offset`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(metadataBox.x - (playerBox.x + 28))).toBeLessThanOrEqual(1);
  expect(Math.abs(coverBox.x - (playerBox.x + 28))).toBeLessThanOrEqual(1);
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

  expect(playerBox.height).toBe(76);
  for (const [name, box] of [['collapse', collapseBox], ['cover', coverBox], ['play', playBox], ['timeline', timelineBox]]) {
    expect.soft(Math.abs(centerY(box) - expectedCenterline), `${name} centerline offset`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(metadataBox.x - timelineBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(metadataBox.y - (playerBox.y + 10))).toBeLessThanOrEqual(1);
  expect(Math.abs(timestampBox.y - (playerBox.y + 11))).toBeLessThanOrEqual(1);
  expect(Math.abs((playerBox.y + playerBox.height) - (timelineBox.y + timelineBox.height) - 13)).toBeLessThanOrEqual(1);
  await expect(player).toHaveScreenshot('expanded-regular-player.png', { animations: 'disabled' });
});

test('tree-wide dock shows artwork, metadata, and Play without expanded content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'docked');
  const player = page.locator('[data-player-view="docked"]');
  const cover = player.locator('[data-compact-player-cover]');
  const transport = player.locator('.compact-player-transport');
  const [playerBox, coverBox, transportBox] = await Promise.all([
    player.boundingBox(), cover.boundingBox(), transport.boundingBox(),
  ]);
  expect(playerBox.width).toBe(280);
  expect(playerBox.height).toBe(72);
  for (const box of [coverBox, transportBox]) expect(Math.abs(centerY(box) - centerY(playerBox))).toBeLessThanOrEqual(1);
  expect(coverBox.width).toBe(50);
  expect(coverBox.x + coverBox.width).toBeLessThan(transportBox.x);
  await expect(player.locator('.compact-player-expand')).toBeHidden();
  await expect(player.locator('[data-compact-player-title]')).toHaveText('Fixture song');
  await expect(player.locator('[data-playback-control-action="previous"]')).toBeHidden();
  await expect(player.locator('[data-playback-control-action="next"]')).toBeHidden();
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

for (const style of ['capsule', 'companion']) {
  test(`waveform metadata and Play preserve approved anchors with actual ${style} controls`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await mountPlayer(page, 'waveform', style);
    const player = page.locator('[data-player-view="waveform"]');
    const [box, metadata, play] = await Promise.all([
      player.boundingBox(), player.locator('.player-meta').boundingBox(), player.locator('#player-play').boundingBox(),
    ]);
    const padding = await player.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft));
    expect(Math.abs(metadata.x - box.x - padding)).toBeLessThanOrEqual(1);
    expect(Math.abs(centerY(play) - box.y - 57)).toBeLessThanOrEqual(1);
  });

  for (const owner of ['expanded-player', 'saved-loop']) {
    test(`${owner} ${style} native Play and revealed actions have independent hit targets`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 640 });
      await mountPlayer(page, 'regular', style);
      await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/loop-range-controls.js') });
      await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/playback-control-cluster.js') });
      await page.evaluate(({ owner, style }) => {
        let compound;
        if (owner === 'saved-loop') {
          const host = document.createElement('section');
          host.id = 'saved-control-host'; host.style.cssText = 'position:absolute;left:200px;top:120px';
          host.innerHTML = renderPlaybackControlCluster({ variant: owner, ownerId: 'saved:fixture', loopId: 'fixture', loopControlStyle: style });
          document.body.append(host); compound = host.querySelector('[data-playback-control-cluster]');
        } else {
          compound = document.querySelector('.player-play-cluster');
          compound.querySelector('[data-playback-control-loop-actions]').innerHTML = buildLoopEditActionControl({ ownerId: 'global-player' });
        }
        compound.id = 'native-controls';
        const root = compound.querySelector('.loop-edit-actions');
        const record = name => { compound.dataset.lastAction = name; };
        let controller;
        controller = mountLoopEditActionControl({ root, interactionRoot: compound, enabled: true, canCreate: true,
          onEnter() { record('enter'); controller.update({ active: true }); },
          onCreate() { record('create'); }, onCancel() { record('cancel'); controller.update({ active: false }); },
        });
        compound.querySelector('[data-playback-control-action="play-pause"]').addEventListener('click', () => record('play'));
      }, { owner, style });
      const compound = page.locator('#native-controls');
      const play = compound.locator('[data-playback-control-action="play-pause"]');
      await play.click();
      await expect(compound).toHaveAttribute('data-last-action', 'play');
      await play.hover();
      await expect(compound).toHaveAttribute('data-loop-action-engaged', 'true');
      await compound.locator('[data-loop-action="enter"]').click();
      await expect(compound).toHaveAttribute('data-last-action', 'enter');
      await compound.locator('[data-loop-action="create"]').click();
      await expect(compound).toHaveAttribute('data-last-action', 'create');
      await compound.locator('[data-loop-action="cancel"]').click();
      await expect(compound).toHaveAttribute('data-last-action', 'cancel');
      await page.mouse.move(1100, 100);
      await expect(compound).toHaveAttribute('data-loop-action-engaged', 'false');
      await expect(compound.locator('[data-loop-action="enter"]')).toHaveAttribute('tabindex', '-1');
      await play.click();
      await expect(compound).toHaveAttribute('data-last-action', 'play');
    });
  }
}


test('regular and waveform presentations retain one canvas and gate its paint rather than removing it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mountPlayer(page, 'regular');
  const canvas = page.locator('.player-waveform-canvas');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).not.toHaveAttribute('hidden');
  await expect(canvas).toHaveCSS('opacity', '0');
  await expect(canvas).toHaveCSS('pointer-events', 'none');
  const identity = await canvas.elementHandle();
  // Component-only presentation changes use the same classes as updateWaveformAppearance.
  await page.locator('.player-timeline-wrap').evaluate(element => element.classList.add('is-waveform'));
  await expect(canvas).toHaveCSS('opacity', '1');
  expect(await canvas.evaluate((element, retained) => element === retained, identity)).toBe(true);
  await page.locator('.player-timeline-wrap').evaluate(element => element.classList.remove('is-waveform'));
  await expect(canvas).toHaveCSS('opacity', '0');
  expect(await canvas.evaluate((element, retained) => element === retained, identity)).toBe(true);
  await identity.dispose();
});
