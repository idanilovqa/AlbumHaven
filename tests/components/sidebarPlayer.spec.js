const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const { renderPlaybackControlCluster } = require(path.join(root, 'music_app/static/js/runtime/playback-control-cluster.js'));
const { renderButton } = require(path.join(root, 'music_app/static/js/button-component.js'));
const url = 'http://sidebar-player-component.test/';
const player = page => page.locator('.global-player');
const cover = page => page.locator('[data-compact-player-cover]');
const play = page => page.locator('.compact-player-shell [data-playback-control-action="play-pause"]');
const bubble = page => page.locator('[data-compact-player-hover-bubble]');
const rail = page => page.locator('#shell-navigation-rail');

async function mount(page, {
  behavior = 'follow_sidebar', speed = 'normal', reduced = false, forceCompact = true,
  regularStyle = false, appearanceMode = 'dark',
} = {}) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.route(url, route => route.fulfill({
    contentType: 'text/html',
      body: '<!doctype html><html data-appearance-mode="' + appearanceMode + '" data-appearance-player="custom" data-compact-player-style="docked" data-docked-compact-player-behavior="' + behavior
      + '" data-docked-compact-player-regular-style="' + regularStyle + '" data-compact-player-motion="' + speed
        + '" style="--appearance-ink:#202020;--appearance-panel-background:#112233;--appearance-player-surface-start:#445566;--appearance-player-surface-end:#445566;--appearance-player-surface-angle:0deg;--appearance-player-ink:#eef2f0;--appearance-player-control-border:#778899"><body>'
      + '<div class="shell-layout" id="app-shell"><header class="app-bar"></header>'
      + '<aside class="shell-navigation-rail" id="shell-navigation-rail" data-shell-default-collapsed="false">'
      + '<div id="artist-tree-expanded"><div class="shell-navigation-rail-header"><button id="artist-tree-fold-button" data-toggle-artist-tree-fold="1">Collapse Artist Tree</button></div><div id="sidebar-list">Artists</div></div>'
      + '<nav id="shell-navigation-compact" hidden><button class="shell-navigation-compact-action" id="artist-tree-navigation-button" data-toggle-artist-tree-fold="1" aria-label="Expand Artist Tree">Tree</button></nav></aside>'
      + '<main class="shell-main-surface"><button id="outside">Outside player</button></main></div>'
      + '<div class="global-player shell-bottom-player"><div class="player-shell">'
      + renderButton({ variant: 'icon', size: 'small', action: 'player-collapse', className: 'player-collapse-button', ariaLabel: 'Collapse player', label: 'Collapse' })
      + renderPlaybackControlCluster({ variant: 'expanded-player', ownerId: 'global-player' }) + '</div>'
      + '<div class="compact-player-shell" aria-label="Compact player">'
      + renderButton({ variant: 'icon', size: 'small', action: 'player-expand', className: 'compact-player-expand', ariaLabel: 'Expand player', label: 'Expand' })
      + '<button class="compact-player-cover" data-compact-player-cover aria-label="Open album details"></button>'
      + '<div class="compact-player-metadata">'
      + '<span class="compact-player-metadata-row" data-compact-player-title><span data-compact-player-title-text></span></span>'
      + '<span class="compact-player-metadata-row" data-compact-player-artist><span data-compact-player-artist-text></span></span></div>'
      + '<div class="compact-player-hover-bubble" data-compact-player-hover-bubble aria-hidden="true"><span data-compact-player-summary></span><span data-compact-player-album-separator hidden>/</span><button class="player-album-link compact-player-hover-album" data-compact-player-album hidden></button></div>'
      + renderPlaybackControlCluster({ variant: 'compact-player' }) + '</div></div></body></html>',
  }));
  await page.goto(url);
  // Keep application stylesheet order, including the persistent shell and late Appearance overrides.
  for (const file of ['runtime/base-layout.css', 'runtime/non-album-and-player.css',
    'runtime/shell-persistent-player.css', 'app-chrome.css', 'appearance-backgrounds.css',
    'button-component.css']) {
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8').replace(/^\uFEFF/, '') });
  }
  await page.evaluate(() => {
    window.state = {
      view: { shell_layout: { slots: { navigation_rail: { content_kind: 'artists_sidebar' } } } },
      ui: { artistsDrawerOpen: false, artistTreeFolded: null },
      gallery: { combineSimilarArtistsByArtist: {} },
      player: { current: { path: 'fixture-track', title: 'Fixture song', artist: 'Fixture artist', album: 'Fixture album', src: 'fixture-audio' }, playbackQueue: null },
    };
    window.albumOpenCount = 0;
    window.playToggleCount = 0;
    window.getPlayerPlaybackSnapshot = () => ({ src: 'fixture-audio', paused: true });
    window.resolveAlbumForPlayerTrack = () => ({ id: 'fixture-album' });
    window.openTrackModal = () => { window.albumOpenCount += 1; };
    window.togglePlayerPlayback = () => { window.playToggleCount += 1; };
    window.getLocalStorageItem = key => window.localStorage.getItem(key) || '';
    window.setLocalStorageItem = (key, value) => {
      window.localStorage.setItem(key, value);
      return true;
    };
  });
  for (const file of ['client-preferences-helpers.js', 'compact-player-helpers.js', 'playback-control-cluster.js',
    'compact-player-controller.js', 'shell-navigation-drawer.js']) {
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime', file) });
  }
  await page.evaluate((shouldForceCompact) => {
    document.addEventListener('click', handleArtistsDrawerClick);
    restorePersistedClientPreferences();
    initCompactPlayer();
    syncArtistTreeFoldVisibility();
    if (shouldForceCompact) applyCompactPlayerMode('compact', { persist: false });
  }, forceCompact);
  if (forceCompact) {
    await expect(player(page)).toHaveAttribute('data-compact-presentation', 'docked');
    await expect.poll(async () => Math.round((await player(page).boundingBox()).width)).toBe(240);
  }
}

async function fold(page, presentation) {
  await page.getByRole('button', { name: 'Collapse Artist Tree', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-compact-presentation', presentation);
  await expect.poll(async () => Math.round((await rail(page).boundingBox()).width)).toBe(64);
}
test('overlay-detached light docked player restores its pale outline and returns to green on close', async ({ page }) => {
  await mount(page, { regularStyle: true, appearanceMode: 'light' });
  await page.evaluate(() => document.body.classList.add('modal-open'));
  await expect(player(page)).toHaveClass(/is-overlay-detached/);
  await expect(player(page)).toHaveCSS('border-top-width', '0px');
  await expect(player(page)).toHaveCSS('outline-width', '1px');
  await expect(player(page)).toHaveCSS('outline-color', 'color(srgb 0.933333 0.94902 0.941176 / 0.28)');
  await expect(player(page)).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.6) 0px 14px 30px 0px');
  await page.evaluate(() => document.body.classList.remove('modal-open'));
  await expect(player(page)).not.toHaveClass(/is-overlay-detached/);
  await expect(player(page)).toHaveCSS('border-top-color', 'rgb(75, 193, 115)');
});

async function settle(page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.playState !== 'finished')
      .map(animation => animation.finished.catch(() => {})));
  });
}

test('regular style gives only the docked presentation the player surface and separator', async ({ page }) => {
  await mount(page, { regularStyle: true });
  await expect(player(page)).toHaveCSS('background-image', /linear-gradient\([^)]*rgb\(68, 85, 102\)/);
  await expect(player(page)).toHaveCSS('border-top-width', '1px');
  await expect(player(page)).toHaveCSS('border-top-color', 'rgb(238, 242, 240)');

  await fold(page, 'rail_play');
  await expect(player(page)).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(player(page)).toHaveCSS('border-top-width', '0px');
});

test('light themes use one green docked divider with an upward shadow including native surfaces', async ({ page }) => {
  await mount(page, { regularStyle: true, appearanceMode: 'light' });
  await expect(player(page)).toHaveCSS('border-top-width', '1px');
  await expect(player(page)).toHaveCSS('border-top-color', 'rgb(75, 193, 115)');
  await expect(player(page)).toHaveCSS('box-shadow', 'rgba(75, 193, 115, 0.3) 0px -1px 5px 0px, rgba(0, 0, 0, 0.28) 0px -12px 24px 0px');
  await page.locator('html').evaluate(root => root.setAttribute('data-appearance-native-surface', 'true'));
  await expect(player(page)).toHaveCSS('border-top-width', '1px');
  await expect(player(page)).toHaveCSS('border-top-color', 'rgb(75, 193, 115)');
});

test('regular style preserves the rounded collapsed Stay docked frame', async ({ page }) => {
  await mount(page, { behavior: 'stay_docked', regularStyle: true });
  await fold(page, 'docked');
  await expect(player(page)).toHaveCSS('border-radius', '14px');
  await expect(player(page)).toHaveCSS('border-top-width', '1px');
});

test('regular style restores the native player surface when no custom surface is active', async ({ page }) => {
  await mount(page, { regularStyle: true });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.removeAttribute('data-appearance-player');
    root.style.removeProperty('--appearance-player-surface-start');
    root.style.removeProperty('--appearance-player-surface-end');
  });
  await expect(player(page)).toHaveCSS('background-image', /linear-gradient\([^)]*rgba?\(6, 24, 22/);
  await expect(player(page)).toHaveCSS('border-top-width', '1px');
  await expect(player(page)).toHaveCSS('border-top-color', 'rgba(74, 222, 128, 0.24)');
});

test('default docked player keeps the sidebar surface without a separator', async ({ page }) => {
  await mount(page);
  await expect(player(page)).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(player(page)).toHaveCSS('border-top-width', '0px');
});

test('regular style does not change the sidebar artbox surface', async ({ page }) => {
  await mount(page, { behavior: 'artbox', regularStyle: true });
  await fold(page, 'rail_artbox');
  await expect(player(page)).toHaveCSS('background-color', 'rgb(17, 34, 51)');
  await expect(player(page)).toHaveCSS('border-top-width', '0px');
});

test('overlay reassembles sidebar artbox into the transparent rail play player', async ({ page }) => {
  await mount(page, { behavior: 'artbox' });
  await fold(page, 'rail_artbox');
  await settle(page);

  await page.evaluate(() => document.body.classList.add('modal-open'));
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_play');
  await expect(player(page)).toHaveClass(/is-overlay-detached/);
  await settle(page);
  await expect(player(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(player(page)).toHaveCSS('background-image', 'none');
  await expect(cover(page)).toHaveCSS('opacity', '0');

  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await expect(cover(page)).toHaveCSS('opacity', '1');

  await page.evaluate(() => document.body.classList.remove('modal-open'));
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_artbox');
  await expect(player(page)).not.toHaveClass(/is-overlay-detached/);
});

test('shared modal state detaches and restores the same interactive docked player', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { window.originalCompactPlayer = document.querySelector('.global-player'); });

  await page.evaluate(() => document.body.classList.add('modal-open'));
  await expect(player(page)).toHaveClass(/is-overlay-detached/);
  expect(await page.evaluate(() => window.originalCompactPlayer === document.querySelector('.global-player'))).toBe(true);
  await play(page).click();
  expect(await page.evaluate(() => window.playToggleCount)).toBe(1);

  await page.evaluate(() => document.body.classList.remove('modal-open'));
  await expect(player(page)).not.toHaveClass(/is-overlay-detached/);
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'docked');
});

test('overlay-detached rail play keeps a transparent wrapper while revealing artwork', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await page.evaluate(() => document.body.classList.add('modal-open'));
  await expect(player(page)).toHaveClass(/is-overlay-detached/);
  await page.locator('#outside').hover();
  await settle(page);

  const closed = await player(page).boundingBox();
  const control = await play(page).boundingBox();
  expect(Math.abs(closed.width - closed.height)).toBeLessThanOrEqual(1);
  expect(Math.abs((control.x + control.width / 2) - (closed.x + closed.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((control.y + control.height / 2) - (closed.y + closed.height / 2))).toBeLessThanOrEqual(1);
  await expect(player(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(player(page)).toHaveCSS('background-image', 'none');
  await expect(player(page)).toHaveCSS('outline-style', 'none');
  await expect(player(page)).toHaveCSS('box-shadow', 'none');

  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await settle(page);
  const opened = await player(page).boundingBox();
  const art = await cover(page).boundingBox();
  await expect(bubble(page)).toHaveCSS('opacity', '1');
  const revealedControl = await play(page).boundingBox();
  const hoverElement = await bubble(page).boundingBox();
  expect(opened.height).toBeGreaterThan(closed.height);
  expect(art.y).toBeGreaterThanOrEqual(opened.y);
  expect(art.y + art.height).toBeLessThanOrEqual(opened.y + opened.height);
  expect(Math.abs(
    (hoverElement.y + hoverElement.height / 2)
      - (revealedControl.y + revealedControl.height / 2),
  )).toBeLessThanOrEqual(1);
  await expect(player(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(player(page)).toHaveCSS('background-image', 'none');
  await expect(player(page)).toHaveCSS('outline-style', 'none');
  await expect(player(page)).toHaveCSS('box-shadow', 'none');
  await cover(page).click();
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'expanded');
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(0);
});

test('overlay-detached rail play artwork double click opens Album Details without expanding', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await page.evaluate(() => document.body.classList.add('modal-open'));
  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));

  await cover(page).dblclick();
  await page.clock.runFor(400);

  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_play');
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(1);
});

test('rail play button keeps its position when artwork double click opens Album Details', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await settle(page);
  await page.evaluate(() => {
    window.openTrackModal = () => {
      window.albumOpenCount += 1;
      document.body.classList.add('modal-open');
    };
  });
  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await settle(page);
  const before = await play(page).boundingBox();

  await cover(page).dblclick();
  await expect(player(page)).toHaveClass(/is-overlay-detached/);
  await settle(page);
  const after = await play(page).boundingBox();

  expect(Math.abs(
    (before.y + before.height / 2) - (after.y + after.height / 2),
  )).toBeLessThanOrEqual(1);
});

const near = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

test('reload restores the Artist Tree and player compact states for this browser', async ({ page }) => {
  await mount(page, { forceCompact: false });
  await page.evaluate(() => applyCompactPlayerMode('compact'));
  await fold(page, 'rail_play');
  await settle(page);

  await mount(page, { forceCompact: false });

  await expect(page.locator('#app-shell')).toHaveClass(/is-artist-tree-folded/);
  await expect(rail(page)).toHaveClass(/is-folded/);
  await expect(player(page)).toHaveClass(/is-compact/);
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_play');
});

for (const [speed, duration] of [['normal', 420], ['slow', 1400]]) {
  test(speed + ' reassembly shares sidebar width on every intermediate frame', async ({ page }) => {
    await mount(page, { speed });
    await settle(page);
    const result = await page.evaluate(async () => {
      const tree = document.getElementById('shell-navigation-rail');
      const dock = document.querySelector('.global-player');
      const samples = [];
      toggleArtistTreeFold();
      const animations = document.documentElement.getAnimations();
      const durations = animations.map(animation => animation.effect.getTiming().duration);
      const started = performance.now();
      await new Promise(resolve => {
        const sample = () => {
          const a = tree.getBoundingClientRect(), b = dock.getBoundingClientRect();
          samples.push({ tree: a.width, dock: b.width, left: a.left - b.left });
          if (Math.abs(a.width - 64) < 0.1 || performance.now() - started > 2500) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const expansionSamples = [];
      toggleArtistTreeFold();
      const expansionStarted = performance.now();
      await new Promise(resolve => {
        const sample = () => {
          const a = tree.getBoundingClientRect(), b = dock.getBoundingClientRect();
          expansionSamples.push({ tree: a.width, dock: b.width, left: a.left - b.left });
          if (Math.abs(a.width - 240) < 0.1 || performance.now() - expansionStarted > 2500) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      return { samples, expansionSamples, durations };
    });
    expect(result.durations).toContain(duration);
    const middle = result.samples.filter(frame => frame.tree > 65 && frame.tree < 239);
    expect(middle.length).toBeGreaterThan(1);
    for (const frame of result.samples) { near(frame.tree, frame.dock); near(frame.left, 0); }
    near(result.samples.at(-1).tree, 64);
    const expansionMiddle = result.expansionSamples.filter(frame => frame.tree > 65 && frame.tree < 239);
    expect(expansionMiddle.length).toBeGreaterThan(1);
    for (const frame of result.expansionSamples) { near(frame.tree, frame.dock); near(frame.left, 0); }
    near(result.expansionSamples.at(-1).tree, 240);
  });
}

test('reduced motion overrides Slow and preserves the saved preference', async ({ page }) => {
  await mount(page, { speed: 'slow', reduced: true });
  await fold(page, 'rail_play');
  const duration = await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--compact-motion-duration').trim());
  expect(['1ms', '0.001s']).toContain(duration);
  await expect(page.locator('html')).toHaveAttribute('data-compact-player-motion', 'slow');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--compact-motion-duration').trim())).toBe('1400ms');
});

test('docked play is proportionate and preserves centered SVG artwork across playback states', async ({ page }) => {
  await mount(page);
  await settle(page);
  const dock = await player(page).boundingBox(), button = await play(page).boundingBox();
  near(dock.height, 72);
  near(button.width, 44); near(button.height, 44);
  near(button.y + button.height / 2, dock.y + dock.height / 2);
  const icon = play(page).locator('svg');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  await icon.evaluate(element => { window.originalCompactPlayIcon = element; });
  for (const paused of [true, false, true]) {
    await page.evaluate(paused => syncCompactPlayerUi({
      playback: { src: 'fixture-audio', paused },
    }), paused);
    await expect(play(page)).toHaveAttribute('aria-label', paused ? 'Play' : 'Pause');
    const geometry = await icon.evaluate(element => {
      const svg = element.getBoundingClientRect();
      const button = element.closest('button').getBoundingClientRect();
      const path = element.querySelector('path').getBBox();
      return {
        stable: element === window.originalCompactPlayIcon,
        svgX: svg.x + svg.width / 2, svgY: svg.y + svg.height / 2,
        buttonX: button.x + button.width / 2, buttonY: button.y + button.height / 2,
        pathX: path.x, pathY: path.y, pathWidth: path.width, pathHeight: path.height,
      };
    });
    expect(geometry.stable).toBe(true);
    near(geometry.svgX, geometry.buttonX); near(geometry.svgY, geometry.buttonY);
    expect(geometry.pathY + geometry.pathHeight / 2).toBe(12);
    // A triangle's visual center is its centroid; pause bars have symmetric bounds.
    expect(geometry.pathX + geometry.pathWidth / (paused ? 3 : 2)).toBe(12);
  }
  await play(page).click();
  expect(await page.evaluate(() => window.playToggleCount)).toBe(1);
});

test('A is a bottom rail play button with upward art and an unclipped glow', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await page.locator('#outside').hover();
  await settle(page);
  const p = await play(page).boundingBox(), r = await rail(page).boundingBox();
  near(p.width, 40); near(p.height, 40); near(p.x + p.width / 2, r.x + r.width / 2);
  near(800 - p.y - p.height, 16);
  await expect(page.locator('#shell-navigation-compact button')).toHaveCount(1);
  const top = await page.locator('#artist-tree-navigation-button').boundingBox();
  expect(top.y).toBeLessThan(r.y + 70);
  await expect(page.locator('.compact-player-expand')).toBeHidden();
  await expect(cover(page)).toHaveAttribute('tabindex', '-1');
  expect(await cover(page).evaluate(element => element.inert)).toBe(true);
  for (const selector of ['.global-player', '.compact-player-shell']) {
    await expect(page.locator(selector)).toHaveCSS('overflow', 'visible');
  }
  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await settle(page);
  const art = await cover(page).boundingBox();
  near(art.width, 50); near(art.height, 50);
  near(p.y - art.y - art.height, 8);
  await expect(cover(page)).toHaveAttribute('tabindex', '0');
  await cover(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await cover(page).dblclick();
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(1);
  await page.locator('#outside').focus();
  await page.locator('#outside').hover();
  await expect(cover(page)).toHaveAttribute('tabindex', '-1');
  await page.locator('#outside').focus();
  await page.keyboard.press('Tab');
  await expect(play(page)).toBeFocused();
  await expect(cover(page)).toHaveAttribute('tabindex', '0');
});

test('rail play artwork single click expands the regular player', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);

  await cover(page).click();

  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'expanded');
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(0);
});

test('B keeps floating geometry, drag position, and protruding controls inside viewport', async ({ page }) => {
  await mount(page, { behavior: 'float_on_collapse' });
  await fold(page, 'floating');
  await settle(page);
  const shell = await player(page).boundingBox(), art = await cover(page).boundingBox(), button = await play(page).boundingBox();
  near(shell.width, 96); near(shell.height, 96); near(art.width, 70); near(button.width, 34);
  expect(button.x + button.width).toBeGreaterThan(shell.x + shell.width);
  expect(button.y + button.height).toBeGreaterThan(shell.y + shell.height);
  await page.mouse.move(art.x + 25, art.y + 25);
  await page.mouse.down();
  await page.mouse.move(1195, 795, { steps: 8 });
  await page.mouse.up();
  await settle(page);
  const dragged = await player(page).boundingBox(), protruding = await play(page).boundingBox();
  expect(protruding.x + protruding.width).toBeLessThanOrEqual(1200);
  expect(protruding.y + protruding.height).toBeLessThanOrEqual(800);
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(0);
  await page.getByRole('button', { name: 'Expand Artist Tree', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'docked');
  await settle(page);
  await fold(page, 'floating');
  await settle(page);
  const restored = await player(page).boundingBox();
  near(restored.x, dragged.x); near(restored.y, dragged.y);
});

test('A reveals metadata 700ms after artwork motion and reabsorbs it on exit', async ({ page }) => {
  await mount(page);
  await fold(page, 'rail_play');
  await settle(page);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await play(page).hover();
  await expect(player(page)).toHaveClass(/is-compact-art-revealed/);
  await expect.poll(() => cover(page).evaluate(element => {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(',').map(value => value.trim());
    const durations = style.transitionDuration.split(',').map(value => value.trim());
    return durations[properties.indexOf('opacity')];
  })).toBe('0.42s');
  await page.clock.runFor(1119);
  await expect(bubble(page)).toHaveAttribute('aria-hidden', 'true');
  await page.clock.runFor(1);
  await expect(bubble(page)).toHaveAttribute('aria-hidden', 'false');
  await expect(bubble(page)).toHaveText('Fixture artist - Fixture song/Fixture album');
  await page.locator('#outside').hover();
  await expect(bubble(page)).toHaveAttribute('aria-hidden', 'true');
});

test('Stay Docked drags from empty space and resets after expand-collapse', async ({ page }) => {
  await mount(page, { behavior: 'stay_docked' });
  await fold(page, 'docked');
  await settle(page);
  const docked = await player(page).boundingBox();
  const metadata = await page.locator('.compact-player-metadata').boundingBox();

  await page.mouse.move(metadata.x + 12, metadata.y + 12);
  await page.mouse.down();
  await page.mouse.move(metadata.x + 192, metadata.y - 108, { steps: 8 });
  await page.mouse.up();
  const dragged = await player(page).boundingBox();
  expect(dragged.x).toBeGreaterThan(docked.x + 100);
  expect(dragged.y).toBeLessThan(docked.y - 60);

  const beforeControlDrag = await player(page).boundingBox();
  const control = await play(page).boundingBox();
  await page.mouse.move(control.x + control.width / 2, control.y + control.height / 2);
  await page.mouse.down();
  await page.mouse.move(control.x + 80, control.y - 80, { steps: 4 });
  await page.mouse.up();
  const afterControlDrag = await player(page).boundingBox();
  near(afterControlDrag.x, beforeControlDrag.x);
  near(afterControlDrag.y, beforeControlDrag.y);

  await page.getByRole('button', { name: 'Expand Artist Tree', exact: true }).click();
  await settle(page);
  const returned = await player(page).boundingBox();
  near(returned.x, docked.x);
  near(returned.y, docked.y);

  await fold(page, 'docked');
  await settle(page);
  const nextCollapse = await player(page).boundingBox();
  near(nextCollapse.x, docked.x);
  near(nextCollapse.y, docked.y);
});

test('docked title and artist pan independently and recalculate after track and tree changes', async ({ page }) => {
  await mount(page);
  const title = page.locator('[data-compact-player-title]');
  const artist = page.locator('[data-compact-player-artist]');
  await page.evaluate(() => {
    state.player.current = {
      path: 'long-track', src: 'fixture-audio',
      title: 'A very long fixture song title that cannot fit inside the docked player metadata row',
      artist: 'A separately measured fixture artist name that also exceeds its available row width',
    };
    syncCompactPlayerUi();
  });
  await expect(title).toHaveClass(/is-overflowing/);
  await expect(artist).toHaveClass(/is-overflowing/);
  const motion = await Promise.all([title, artist].map(row => row.evaluate(element => ({
    distance: parseFloat(getComputedStyle(element).getPropertyValue('--compact-player-row-pan-distance')),
    animation: getComputedStyle(element.firstElementChild).animationName,
  }))));
  expect(motion[0].distance).toBeGreaterThan(0);
  expect(motion[1].distance).toBeGreaterThan(0);
  expect(motion[0].distance).not.toBe(motion[1].distance);
  expect(motion.every(item => item.animation === 'compact-player-metadata-pan')).toBe(true);
  await expect(title).toHaveCSS('overflow', 'hidden');
  await expect(title).toHaveCSS('white-space', 'nowrap');
  const keyframes = await title.locator('[data-compact-player-title-text]').evaluate(element =>
    element.getAnimations()[0].effect.getKeyframes().map(frame => ({ offset: frame.offset, transform: frame.transform })));
  expect(keyframes.map(frame => frame.offset)).toEqual([0, 0.16, 0.84, 1]);
  expect(keyframes[0].transform).toBe(keyframes[1].transform);
  expect(keyframes[2].transform).toBe(keyframes[3].transform);

  await page.evaluate(() => {
    state.player.current = {
      path: 'changed-track', src: 'fixture-audio',
      title: 'A different long fixture song title that still cannot fit inside this metadata row',
      artist: 'Short artist',
    };
    syncCompactPlayerUi();
  });
  await expect(title).toHaveClass(/is-overflowing/);
  await expect(artist).not.toHaveClass(/is-overflowing/);

  await fold(page, 'rail_play');
  await expect(title).not.toHaveClass(/is-overflowing/);
  await page.getByRole('button', { name: 'Expand Artist Tree', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'docked');
  await expect(title).toHaveClass(/is-overflowing/);
});

test('reduced motion keeps overflowing compact metadata clipped with ellipsis', async ({ page }) => {
  await mount(page, { reduced: true });
  await page.evaluate(() => {
    state.player.current = {
      path: 'reduced-track', src: 'fixture-audio',
      title: 'A very long fixture song title that cannot fit inside the docked player metadata row',
      artist: 'A very long fixture artist name that cannot fit inside the docked player metadata row',
    };
    syncCompactPlayerUi();
  });
  const title = page.locator('[data-compact-player-title]');
  await expect(title).not.toHaveClass(/is-overflowing/);
  await expect(title.locator('[data-compact-player-title-text]')).toHaveCSS('text-overflow', 'ellipsis');
  await expect(title.locator('[data-compact-player-title-text]')).toHaveCSS('animation-name', 'none');
});

test('C positions art and play over the lower-right corner; single click waits 300ms', async ({ page }) => {
  await mount(page, { behavior: 'artbox' });
  await fold(page, 'rail_artbox');
  await settle(page);
  const art = await cover(page).boundingBox(), button = await play(page).boundingBox(), dock = await player(page).boundingBox();
  near(art.width, 44); near(art.height, 44);
  near(button.x + button.width / 2, 64);
  near(button.y - dock.y, 59);
  expect(button.x).toBeLessThan(art.x + art.width);
  expect(button.y).toBeLessThan(art.y + art.height);
  expect(button.y + button.height).toBeGreaterThan(art.y + art.height);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await cover(page).click();
  await page.clock.runFor(299);
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_artbox');
  await page.clock.runFor(1);
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'expanded');
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(0);
});

test('C reveals metadata after 700ms to the right of its edge play button', async ({ page }) => {
  await mount(page, { behavior: 'artbox' });
  await fold(page, 'rail_artbox');
  await settle(page);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await play(page).hover();
  await page.clock.runFor(699);
  await expect(bubble(page)).toHaveAttribute('aria-hidden', 'true');
  await page.clock.runFor(1);
  await expect(bubble(page)).toHaveAttribute('aria-hidden', 'false');
  const metadata = await bubble(page).boundingBox();
  const button = await play(page).boundingBox();
  expect(metadata.x).toBeGreaterThan(button.x + button.width / 2);
});

test('C double click opens details without expanded-player flash', async ({ page }) => {
  await mount(page, { behavior: 'artbox' });
  await fold(page, 'rail_artbox');
  await settle(page);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
  await page.evaluate(() => {
    window.presentations = [];
    new MutationObserver(records => {
      for (const record of records) window.presentations.push(record.oldValue);
    }).observe(document.querySelector('.global-player'), { attributes: true, attributeFilter: ['data-compact-presentation'], attributeOldValue: true });
  });
  await cover(page).dblclick();
  await page.clock.runFor(400);
  await expect(player(page)).toHaveAttribute('data-compact-presentation', 'rail_artbox');
  expect(await page.evaluate(() => window.albumOpenCount)).toBe(1);
  expect(await page.evaluate(() => window.presentations)).not.toContain('expanded');
});

for (const key of ['Enter', 'Space', 'ArrowUp']) {
  test('C keyboard ' + key + ' acts immediately', async ({ page }) => {
    await mount(page, { behavior: 'artbox' });
    await fold(page, 'rail_artbox');
    await settle(page);
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
    await cover(page).focus();
    await cover(page).press(key);
    await expect(player(page)).toHaveAttribute('data-compact-presentation', key === 'ArrowUp' ? 'rail_artbox' : 'expanded');
    expect(await page.evaluate(() => window.albumOpenCount)).toBe(key === 'ArrowUp' ? 1 : 0);
  });
}



for (const behavior of ['follow_sidebar', 'artbox']) {
  test('idle ' + behavior + ' cover still expands the full player', async ({ page }) => {
    await mount(page, { behavior });
    if (behavior === 'artbox') await fold(page, 'rail_artbox');
    await settle(page);
    await page.evaluate(() => {
      state.player.current = null;
      window.getPlayerPlaybackSnapshot = () => ({ src: null, paused: true });
      syncCompactPlayerUi();
    });
    await expect(cover(page)).toBeEnabled();
    await cover(page).click();
    await expect(player(page)).toHaveAttribute('data-compact-presentation', 'expanded');
    expect(await page.evaluate(() => window.albumOpenCount)).toBe(0);
  });
}

for (const gesture of ['single', 'double']) {
  test('tree-wide dock ' + gesture + ' cover gesture preserves expanded vs album semantics', async ({ page }) => {
    await mount(page);
    await settle(page);
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:00Z'));
    if (gesture === 'double') await cover(page).dblclick();
    else await cover(page).click();
    await page.clock.runFor(299);
    await expect(player(page)).toHaveAttribute('data-compact-presentation', 'docked');
    await page.clock.runFor(101);
    await expect(player(page)).toHaveAttribute('data-compact-presentation', gesture === 'single' ? 'expanded' : 'docked');
    expect(await page.evaluate(() => window.albumOpenCount)).toBe(gesture === 'single' ? 0 : 1);
  });
}
test('sidebar mini-player artwork has no dark side frame', async ({ page }) => {
  await mount(page);
  await expect(cover(page)).toHaveCSS('border-left-width', '0px');
  await expect(cover(page)).toHaveCSS('border-right-width', '0px');
});

test('sidebar hover album keeps inherited text styling and displays its full label', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    state.player.current = {
      path: 'long-album-track', src: 'fixture-audio', artist: 'Neal Morse',
      title: 'A Whole Nother Trip', album: 'Neal Morse - A Whole Nother Trip',
    };
    syncCompactPlayerUi();
  });
  const metrics = await page.evaluate(() => {
    const summary = document.querySelector('[data-compact-player-summary]');
    const album = document.querySelector('[data-compact-player-album]');
    const summaryStyle = getComputedStyle(summary);
    const albumStyle = getComputedStyle(album);
    return {
      albumClientWidth: album.clientWidth,
      albumScrollWidth: album.scrollWidth,
      summaryFont: [summaryStyle.fontFamily, summaryStyle.fontSize, summaryStyle.lineHeight],
      albumFont: [albumStyle.fontFamily, albumStyle.fontSize, albumStyle.lineHeight],
    };
  });
  expect(metrics.albumClientWidth).toBeGreaterThanOrEqual(metrics.albumScrollWidth);
  expect(metrics.albumFont).toEqual(metrics.summaryFont);
});
