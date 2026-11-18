const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('node:fs');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');
const { applyFixtureAppearance } = require('./appearanceFixture.js');
const { assertMobileRowMenuContinuity } = require('./triggerAnchorSeamFixture.js');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://trigger-anchor-surface.test/';

async function mountVisualAnchor(page, name) {
  const template = file => fs.readFileSync(path.join(repositoryRoot, 'music_app/templates', file), 'utf8');
  const accountTemplate = template('partials/account-menu.html');
  const albumTrigger = template('index.html').match(/<button class="gallery-action-button"[^>]*data-gallery-bar-action="album-types"[\s\S]*?<\/button>/)[0];
  const settingsIcon = accountTemplate.match(/<svg[\s\S]*?<\/svg>/)[0];
  const filterIcon = template('partials/search-input.html').match(/<svg[\s\S]*?<\/svg>/)[0];
  const trigger = name === 'Album Types' ? albumTrigger
    : name === 'Settings' ? renderActionButton({ ariaLabel: 'Settings', attributes: {
      'data-account-menu-trigger': true, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    } }).replace(/<span class="action-button__icon" aria-hidden="true"><\/span>/, settingsIcon)
      : `<button class="search-field-button utility-problem-filter-button" type="button" aria-label="Period">${filterIcon}</button>`;
  const panelClass = name === 'Album Types' ? 'gallery-anchored-menu'
    : name === 'Settings' ? 'account-menu' : 'confirm-modal-dialog';
  const content = name === 'Album Types'
    ? ['Studio', 'EP', 'Live', 'Compilation'].map(label => `<button class="gallery-type-choice" type="button" aria-pressed="true"><span aria-hidden="true">✓</span>${label}</button>`).join('')
    : name === 'Settings' ? accountTemplate.match(/<button class="account-menu-item"[\s\S]*?<\/button>/)[0]
      : '<h2 class="confirm-modal-title">Date range</h2><div id="date-content"></div>';
  await page.setContent(`<!doctype html><html><body>
    <div class="${name === 'Settings' ? 'app-bar' : 'shell-main-surface'} anchor-host"${name === 'Settings' ? ' data-account-menu-component' : ''}>${trigger}
    ${name === 'Log History Period' ? '<div id="app-form-modal" class="app-form-anchored">' : ''}
    <div id="surface" class="${panelClass}" data-anchored-surface="fixture"${name === 'Settings' ? ' data-account-menu role="menu" hidden' : ''}>${content}</div>
    ${name === 'Log History Period' ? '</div>' : ''}</div></body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'runtime/account-menu.css', 'dialog-component.css', 'runtime/utilities.css',
    'app-chrome.css', 'gallery-main.css', 'runtime/trigger-anchor.css', 'appearance-backgrounds.css',
    'button-component.css', 'date-range-picker.css', 'search-input.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await applyFixtureAppearance(page, { palette_id: 'paper', panel_index: 0 });
  await page.locator('html').evaluate(root => {
    root.style.setProperty('--appearance-accent', '#55c7ff');
    root.style.setProperty('--appearance-selected-accent', '#55c7ff');
    root.style.setProperty('--appearance-interaction-outline', '#55c7ff');
  });
  await page.addStyleTag({ content: `
    .anchor-host { position: fixed; left: 40px; top: 20px; padding: 0; width: auto; height: auto; }
    #surface { position: fixed; left: 40px; right: auto; top: 60px; width: 320px; }
  ` });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/button-component.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/date-range-picker.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/account-menu.js') });
  await page.evaluate((surfaceName) => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const dates = document.getElementById('date-content');
    if (dates) dates.innerHTML = buildDateRangePicker({ fromDate: '2026-09-01', toDate: '2026-09-23' });
    const anchor = document.querySelector('.anchor-host button');
    if (surfaceName === 'Settings') {
      attachAccountMenu(document.querySelector('[data-account-menu-component]'));
      anchor.click();
    } else {
      anchor.setAttribute('aria-expanded', 'true');
      syncTriggerAnchor(document.getElementById('surface'), anchor);
    }
  }, name);
  await page.locator('.anchor-host > button').hover();
  if (name === 'Log History Period') {
    for (const selector of ['body', '.confirm-modal-title', '.date-range-picker__field > span']) {
      await expect(page.locator(selector).first()).toHaveCSS('font-family', /system-ui/);
    }
  }
}

async function mountGalleryAnchor(page, name) {
  const artistInfo = name === 'Gallery Header Artist Info' || name === 'Gallery Artist Row Info';
  const artistFamily = name === 'Gallery Artist Family';
  const albumTypesSurface = '<div class="gallery-anchored-menu" id="gallery-album-types-menu" data-anchored-surface="album-types" data-trigger-anchor-context="content" role="group" aria-label="Album types" hidden><span class="gallery-menu-title">Album types</span><button class="gallery-type-choice" type="button" aria-pressed="true"><span aria-hidden="true">✓</span>Studio</button></div>';
  await page.setContent(`<!doctype html><html data-appearance-mode="light" data-appearance-palette="fixture"><body>
    <main class="shell-main-surface"><div class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery"></div>
      <section data-row-fixture></section></main>
    ${albumTypesSurface}
    <div data-surface-host></div>
  </body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'app-chrome.css', 'gallery-main.css',
    'runtime/trigger-anchor.css', 'appearance-backgrounds.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await applyFixtureAppearance(page, { palette_id: 'paper', panel_index: 0 });
  await page.locator('html').evaluate(root => {
    root.style.setProperty('--appearance-accent', '#55c7ff');
    root.style.setProperty('--appearance-selected-accent', '#55c7ff');
    root.style.setProperty('--appearance-interaction-outline', '#55c7ff');
  });
  await page.addStyleTag({ content: `
    body { margin: 0; }
    .shell-main-surface { position: fixed; left: 64px; top: 18px; width: 360px; padding: 0; }
    .gallery-bar { width: 360px; }
    .gallery-bar__context { flex: 0 0 auto; }
    .family-artist-header { width: 360px; }
    [data-artist-info-overlay] { width: 300px; min-height: 120px; }
    .artist-family-panel { bottom: auto; opacity: 1; transform: none; transition: none; }
  ` });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    window.state = { view: { selected_artist: '14 Bis', query: '', surface: { active: 'albums' } } };
    window.ensureGalleryMainState = () => ({ sources: {}, albumTypes: [] });
    window.prefetchGallerySourceTotalsForAllScopes = () => {};
    window.hydrateDeferredNonAlbumTracksForAlbumTypes = () => {};
    window.shouldFocusGalleryMainSurface = () => false;
    window.focusGalleryMainSurface = () => {};
  });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/gallery-main-components.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/gallery-main-interactions.js') });
  await page.evaluate(({ artistInfo, artistFamily, name }) => {
    const bar = document.querySelector('[data-gallery-bar]');
    bar.innerHTML = buildGalleryBarHtml({
      contextKind: 'artist', artist: '14 Bis', albumCount: 4,
      artist_musicbrainz: { country: 'BR', genres: ['MPB'] },
    });
    document.querySelector('[data-row-fixture]').innerHTML = buildFamilyArtistHeaderHtml({ artist: '14 Bis', albumCount: 4 });
    const host = document.querySelector('[data-surface-host]');
    if (artistInfo) {
      host.innerHTML = '<aside class="artist-info-overlay" data-artist-info-overlay role="dialog" aria-label="Artist information" hidden><header><div><span>Artist</span><h2>14 Bis</h2></div></header><div class="artist-info-overlay__body">Controlled artist information.</div></aside>';
    } else if (artistFamily) {
      host.innerHTML = buildArtistFamilyPanelHtml({ title: 'Artist Family', albumTotal: '4 albums', bodyHtml: 'Controlled family.' });
      host.firstElementChild.id = 'artist-family-panel';
    }
    const trigger = name === 'Gallery Header Artist Info'
      ? bar.querySelector('[data-artist-info-trigger]')
      : name === 'Gallery Artist Row Info'
        ? document.querySelector('[data-row-fixture] [data-artist-info-trigger]')
        : bar.querySelector(`[data-gallery-bar-action="${artistFamily ? 'artist-family' : 'album-types'}"]`);
    const surface = artistInfo ? document.querySelector('[data-artist-info-overlay]')
      : artistFamily ? document.querySelector('[data-artist-family-panel]')
        : document.getElementById('gallery-album-types-menu');
    surface.id = 'surface';
    trigger.dataset.fixtureAnchor = '';
    window.fixtureAnchor = trigger;
    window.fixtureSurface = surface;
  }, { artistInfo, artistFamily, name });
  const anchor = page.locator('[data-fixture-anchor]');
  const icon = anchor.locator('svg, .gallery-info-button__glyph');
  const before = { anchor: await anchor.boundingBox(), icon: await icon.boundingBox() };
  await page.evaluate(({ artistInfo, artistFamily }) => openGalleryMainSurface(
    artistInfo ? 'artist:14 Bis' : artistFamily ? 'artist-family' : 'album-types',
    window.fixtureAnchor,
    window.fixtureSurface,
    artistInfo ? 'left' : 'right',
  ), { artistInfo, artistFamily });
  await anchor.hover();
  return { before, anchor, icon, surface: page.locator('#surface') };
}

async function readConnectedOutline(page, anchor, surface) {
  const screenshot = await page.screenshot({ animations: 'disabled' });
  return page.evaluate(async ({ base64, anchorSelector, surfaceSelector }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const trigger = document.querySelector(anchorSelector).getBoundingClientRect();
    const panel = document.querySelector(surfaceSelector).getBoundingClientRect();
    const pixel = (x, y) => [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    const fill = (getComputedStyle(document.querySelector(surfaceSelector)).backgroundColor.match(/[\d.]+/g) || [])
      .slice(0, 3).map(Number);
    const differsFromFill = value => value.slice(0, 3)
      .some((channel, index) => Math.abs(channel - fill[index]) > 10);
    const isAccent = value => value.slice(0, 3)
      .every((channel, index) => Math.abs(channel - [85, 199, 255][index]) <= 16);
    const edgeHasStroke = (x, y) => Array.from({ length: 7 }, (_, index) => pixel(x - 3 + index, y))
      .some(differsFromFill);
    const edgeHasAccent = (x, y) => Array.from({ length: 7 }, (_, index) => pixel(x - 3 + index, y))
      .some(isAccent);
    const connectorStart = Math.ceil(trigger.top + 5);
    const connectorEnd = Math.ceil(panel.top) - 1;
    const connectorGaps = [];
    const connectorAccentGaps = [];
    for (let y = connectorStart; y <= connectorEnd; y += 1) {
      const left = edgeHasStroke(trigger.left, y);
      const right = edgeHasStroke(trigger.right, y);
      if (!left || !right) connectorGaps.push(y);
      if (!edgeHasAccent(trigger.left, y) || !edgeHasAccent(trigger.right, y)) connectorAccentGaps.push(y);
    }
    const topY = Math.round(panel.top);
    const topGaps = [];
    for (let x = Math.ceil(panel.left + 2); x < Math.floor(panel.right - 2); x += 1) {
      if (x >= Math.floor(trigger.left - 1) && x <= Math.ceil(trigger.right + 1)) continue;
      if (![pixel(x, topY - 1), pixel(x, topY), pixel(x, topY + 1)].some(differsFromFill)) topGaps.push(x);
    }
    const topLineSizes = getComputedStyle(document.querySelector(surfaceSelector), '::after').backgroundSize
      .split(',').map(layer => Number.parseFloat(layer.trim()));
    return {
      connectorGaps,
      connectorAccentGaps,
      topGaps,
      topLineSideWidths: { left: topLineSizes[1], right: topLineSizes[2] },
      triggerOffsets: { left: trigger.left - panel.left, right: panel.right - trigger.right },
    };
  }, {
    base64: screenshot.toString('base64'),
    anchorSelector: await anchor.evaluate(element => {
      element.id ||= 'connected-outline-anchor';
      return `#${CSS.escape(element.id)}`;
    }),
    surfaceSelector: await surface.evaluate(element => {
      element.id ||= 'connected-outline-surface';
      return `#${CSS.escape(element.id)}`;
    }),
  });
}

async function mountScrollableArtistInfo(page) {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.setContent(`<!doctype html><html data-appearance-mode="dark"><body>
    <div id="albums-scroll"><div class="scroll-fixture"><section data-row-fixture></section></div></div>
    <div class="global-player" data-shell-slot="bottom_player"></div>
    <aside class="artist-info-overlay" data-artist-info-overlay role="dialog" aria-label="Artist information" hidden>
      <header><div><span>Artist</span><h2>14 Bis</h2></div></header>
      <div class="artist-info-overlay__body">Controlled artist information that must remain fully visible when opened.</div>
    </aside>
  </body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'gallery-main.css', 'runtime/trigger-anchor.css',
    'appearance-backgrounds.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await page.addStyleTag({ content: `
    :root { --appearance-card: #171717; --appearance-panel-background: #171717;
      --appearance-line: #526173; --appearance-selected-accent: #55c7ff; }
    body { margin: 0; background: #090909; }
    #albums-scroll { position: fixed; left: 20px; top: 20px; width: 440px; height: 280px;
      overflow: auto; padding-bottom: var(--artist-info-reveal-space, 0px); box-sizing: border-box; }
    .scroll-fixture { height: 700px; padding-top: 180px; box-sizing: border-box; }
    .family-artist-header { width: 420px; }
    .global-player { position: fixed; left: 0; right: 0; top: 300px; height: 60px; background: #102430; z-index: 200; }
    [data-artist-info-overlay] { width: 360px; height: 160px; }
  ` });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    window.state = {
      gallery: { mainState: { sources: {}, albumTypes: [], view: 'grid' } },
      view: { selected_artist: '14 Bis', query: '', surface: { active: 'albums' } },
    };
    window.ensureGalleryMainState = () => ({ sources: {}, albumTypes: [] });
    window.prefetchGallerySourceTotalsForAllScopes = () => {};
  });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/gallery-main-components.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/gallery-main-interactions.js') });
  await page.evaluate(() => {
    document.querySelector('[data-row-fixture]').innerHTML = buildFamilyArtistHeaderHtml({ artist: '14 Bis', albumCount: 4 });
    window.updateGalleryMainChrome = () => {};
    window.observeArtistFamilyPanelBounds = () => ({ disconnect() {}, refresh() {} });
    initGalleryMain();
    const anchor = document.querySelector('[data-artist-info-trigger]');
    openGalleryMainSurface('artist:14 Bis', anchor, document.querySelector('[data-artist-info-overlay]'), 'left');
  });
  return {
    scroll: page.locator('#albums-scroll'),
    anchor: page.locator('[data-artist-info-trigger]'),
    surface: page.locator('[data-artist-info-overlay]'),
    player: page.locator('[data-shell-slot="bottom_player"]'),
  };
}

 test('open anchors resynchronize after native nested scroll and resize, then clear geometry on close and reopen', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent(`<!doctype html><html><body>
    <div id="scroll-owner" class="shell-main-surface"><div id="scroll-content">
      <button id="anchor" class="action-button" aria-expanded="false">Open menu</button>
    </div></div>
    <div id="surface" class="gallery-anchored-menu" data-anchored-surface="fixture" hidden>Menu content</div>
  </body></html>`);
  for (const stylesheet of ['button-component.css', 'runtime/trigger-anchor.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await page.addStyleTag({ content: `
    #scroll-owner { position: absolute; left: 40px; top: 100px; width: 360px; height: 220px; overflow: auto; }
    #scroll-content { height: 800px; padding-top: 80px; box-sizing: border-box; }
    #anchor { width: 120px; height: 32px; }
    #surface { position: fixed; left: 40px; top: 230px; width: 260px; height: 70px; background: rgb(225, 232, 239); }
    @media (max-width: 650px) { #surface { top: 10px; } }
  ` });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  // Component input wiring only; production code owns synchronization and cleanup.
  await page.evaluate(() => {
    const anchor = document.getElementById('anchor');
    const surface = document.getElementById('surface');
    anchor.addEventListener('click', () => {
      surface.hidden = !surface.hidden;
      anchor.setAttribute('aria-expanded', String(!surface.hidden));
      if (!surface.hidden) syncTriggerAnchor(surface, anchor);
    });
  });
  const anchor = page.locator('#anchor');
  const surface = page.locator('#surface');
  const geometry = () => page.evaluate(() => {
    const trigger = document.getElementById('anchor');
    const panel = document.getElementById('surface');
    const a = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const edge = p.bottom <= a.top ? 'bottom' : 'top';
    const gap = Math.max(0, edge === 'top' ? p.top - a.bottom : a.top - p.bottom);
    return {
      edge: panel.dataset.triggerAnchorEdge,
      gap: Number.parseFloat(panel.style.getPropertyValue('--trigger-anchor-gap')),
      synchronized: panel.dataset.triggerAnchorEdge === edge
        && trigger.dataset.triggerAnchorEdge === edge
        && Number.parseFloat(panel.style.getPropertyValue('--trigger-anchor-gap')) === gap
        && Number.parseFloat(trigger.style.getPropertyValue('--trigger-anchor-gap')) === gap
        && Number.parseFloat(panel.style.getPropertyValue('--trigger-anchor-width')) === a.width,
      scrollTop: document.getElementById('scroll-owner').scrollTop,
    };
  });
  await anchor.click();
  await expect(surface).toBeVisible();
  await expect.poll(async () => (await geometry()).synchronized).toBe(true);
  const before = await geometry();
  expect(before.edge).toBe('top');
  await page.locator('#scroll-owner').hover({ position: { x: 330, y: 40 } });
  await page.mouse.wheel(0, 60);
  await expect.poll(async () => (await geometry()).scrollTop).toBeGreaterThan(0);
  await expect.poll(async () => (await geometry()).synchronized).toBe(true);
  expect((await geometry()).gap).toBeGreaterThan(before.gap);
  await page.setViewportSize({ width: 600, height: 700 });
  await expect.poll(async () => (await geometry()).edge).toBe('bottom');
  await expect.poll(async () => (await geometry()).synchronized).toBe(true);

  await anchor.click();
  await expect(surface).toBeHidden();
  await expect(anchor).not.toHaveClass(/trigger-anchor-open/);
  await expect(surface).not.toHaveClass(/trigger-anchor-surface/);
  await expect(surface).not.toHaveAttribute('data-trigger-anchor-edge');
  await expect(surface).not.toHaveAttribute('data-trigger-anchor-context');
  await expect(anchor).not.toHaveAttribute('data-trigger-anchor-edge');
  await expect.poll(() => anchor.evaluate(element => element.style.getPropertyValue('--trigger-anchor-background'))).toBe('');
  await expect.poll(() => surface.evaluate(element => element.style.getPropertyValue('--trigger-anchor-background'))).toBe('');

  await page.setViewportSize({ width: 900, height: 700 });
  await anchor.click();
  await expect(surface).toBeVisible();
  await expect.poll(async () => (await geometry()).edge).toBe('top');
  await expect.poll(async () => (await geometry()).synchronized).toBe(true);
});

test('Artist Family opening keeps its top shadow clip stationary', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<style>
    :root { --panel: white; --border: #526173; --player-height: 0px; }
    #anchor { position: fixed; right: 12px; top: 30px; width: 34px; height: 34px; }
    .artist-family-panel { top: 80px; }
  </style><button id="anchor"></button><aside class="artist-family-panel" hidden></aside>`);
  for (const stylesheet of ['gallery-main.css', 'runtime/trigger-anchor.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  const frames = await page.evaluate(() => {
    const panel = document.querySelector('aside');
    panel.style.top = '80px';
    panel.hidden = false;
    // Match openGalleryMainSurface: commit the closed style before joining the anchor.
    void panel.offsetWidth;
    panel.classList.add('is-open');
    syncTriggerAnchor(panel, document.getElementById('anchor'));
    const animations = panel.getAnimations();
    for (const animation of animations) animation.pause();
    return animations.flatMap(animation => animation.effect.getKeyframes())
      .filter(frame => frame.clipPath).map(frame => frame.clipPath);
  });
  expect(frames.length).toBeGreaterThan(0);
  for (const clip of frames) expect(clip).toMatch(/^inset\(-1px /);

  const samples = await page.locator('aside').evaluate(panel => {
    const animation = panel.getAnimations().find(item => item.transitionProperty === 'clip-path');
    if (!animation) throw new Error('Artist Family clip transition was not created');
    animation.pause();
    const duration = animation.effect.getComputedTiming().duration;
    return [0, 0.25, 0.5, 0.75, 1].map(progress => {
      animation.currentTime = duration * progress;
      const bounds = panel.getBoundingClientRect();
      const clip = getComputedStyle(panel).clipPath.match(/inset\(([^)]+)\)/)[1].split(/\s+/);
      return { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height,
        clipTop: parseFloat(clip[0]), clipBottom: parseFloat(clip[2]) };
    });
  });
  for (const sample of samples) {
    expect(sample.top).toBe(80);
    expect(sample.left).toBe(samples[0].left);
    expect(sample.width).toBe(samples[0].width);
    expect(sample.height).toBe(samples[0].height);
    expect(sample.clipTop).toBe(-1);
  }
  expect(samples[0].clipBottom).toBe(100);
  expect(samples.at(-1).clipBottom).toBe(0);
  for (let index = 1; index < samples.length; index += 1) {
    expect(samples[index].clipBottom).toBeLessThan(samples[index - 1].clipBottom);
  }

  // The phone drawer deliberately leaves room for its joined edge and shadow.
  // Exercise both sides of the breakpoint without replacing the desktop fold.
  await page.locator('aside').evaluate(panel => {
    for (const animation of panel.getAnimations()) animation.finish();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside')).toHaveCSS('clip-path', 'inset(0px -80px -80px)');
  const seam = await page.locator('aside').evaluate(panel => {
    const style = getComputedStyle(panel, '::after');
    return { top: style.top, height: style.height, width: style.getPropertyValue('--trigger-top-line-width').trim() };
  });
  expect(seam).toEqual({ top: '-1px', height: '2px', width: '2px' });
  await page.setViewportSize({ width: 901, height: 844 });
  await expect(page.locator('aside')).toHaveCSS('clip-path', 'inset(-1px 0px 0px)');
  await page.setViewportSize({ width: 900, height: 844 });
  await expect(page.locator('aside')).toHaveCSS('clip-path', 'inset(0px -80px -80px)');
});

 test('a dropdown extending both sides has mirrored left and right joins', async ({ page, browser }) => {
  await page.setContent(`<style>
    :root { --panel: white; --border: black; --appearance-selected-accent: black; }
    #anchor { position:absolute;left:153px;top:40px;width:34px;height:34px; }
    aside { position:absolute;left:40px;top:80px;width:260px;height:100px;border:1px solid black;box-sizing:border-box; }
  </style><button id="anchor"></button><aside></aside>`);
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/runtime/trigger-anchor.css') });
  await page.addStyleTag({ content: ':root { --appearance-selected-accent: black; }' });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.evaluate(() => syncTriggerAnchor(document.querySelector('aside'), document.querySelector('button')));
  const screenshot = await page.screenshot();
  const corners = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const left = [], right = [];
    for (let y = 78; y < 85; y += 1) {
      for (let offset = -2; offset < 6; offset += 1) {
        left.push([...context.getImageData(153 + offset, y, 1, 1).data]);
        right.push([...context.getImageData(186 - offset, y, 1, 1).data]);
      }
    }
    return { left, right };
  }, screenshot.toString('base64'));
  expect(corners.right).toEqual(corners.left);
  await assertMobileRowMenuContinuity(browser);
});

const cases = [
  ['Artist Info', 'gallery-info-button', 'artist-info-overlay', 'content'],
  ['Album Types', 'gallery-action-button', 'gallery-anchored-menu', 'content'],
  ['Library', 'action-button', 'gallery-anchored-menu status-context-menu', 'chrome'],
  ['Sources', 'action-button', 'gallery-anchored-menu', 'chrome'],
  ['Settings', 'action-button', 'account-menu', 'chrome'],
  ['Search Filter', 'search-field-button', 'utility-problem-filter-menu', 'content'],
  ['Log History Period', 'search-field-button', 'confirm-modal-dialog', 'content'],
];

for (const [name, anchorClass, surfaceClass, context] of cases) {
  test(`${name} open anchor uses its panel surface without a bottom divider`, async ({ page }) => {
    await page.route(componentUrl, route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
        <html data-appearance-mode="light" data-appearance-palette="fixture" style="
          --appearance-card: rgb(255, 247, 229);
          --appearance-panel-background: rgb(225, 232, 239);
          --appearance-main-surface: rgb(242, 245, 247);
          --appearance-control: rgb(232, 237, 241);
          --appearance-item-action-hover-background: rgb(205, 214, 222);
          --appearance-item-action-pressed: rgb(190, 201, 211);
          --appearance-line: rgb(82, 97, 115);
          --appearance-accent: rgb(75, 193, 115);
          --appearance-play: rgb(75, 193, 115);
          --appearance-ink: rgb(25, 31, 38);
          --panel: rgb(23, 23, 23);
          --border: rgb(82, 97, 115);
        ">
          <body>
            <div class="${context === 'content' ? 'shell-main-surface' : 'app-bar'} anchor-host">
              <button id="anchor" class="${anchorClass}" aria-expanded="true">${name}</button>
            </div>
            ${name === 'Log History Period' ? '<div id="app-form-modal" class="app-form-anchored">' : ''}
            <div id="surface" class="${surfaceClass}" data-anchored-surface="fixture">Panel${name === 'Log History Period' ? '<div class="date-range-picker"></div>' : ''}</div>
            ${name === 'Log History Period' ? '</div>' : ''}
          </body>
        </html>`,
    }));
    await page.goto(componentUrl);
    for (const stylesheet of [
      'runtime/account-menu.css',
      'dialog-component.css',
      'runtime/utilities.css',
      'app-chrome.css',
      'gallery-main.css',
      'runtime/trigger-anchor.css',
      'appearance-backgrounds.css',
      'button-component.css',
      'date-range-picker.css',
      'search-input.css',
    ]) {
      await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
    }
    // Fixed fixture coordinates model a real gap; shell padding must not shift
    // the trigger down into the panel's visible text.
    await page.addStyleTag({ content: `
      body { margin: 0; }
      .anchor-host { position: fixed; left: 40px; top: 20px; padding: 0; width: auto; height: auto; }
      #anchor { width: 72px; height: 34px; }
      #surface { position: fixed; left: 40px; right: auto; top: 60px; width: 220px; min-height: 80px; }
    ` });
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
    await page.evaluate(() => syncTriggerAnchor(
      document.getElementById('surface'),
      document.getElementById('anchor'),
    ));
    await page.locator('#anchor').hover();

    const styles = await page.evaluate(() => {
      const anchor = getComputedStyle(document.getElementById('anchor'));
      const surfaceElement = document.getElementById('surface');
      const surface = getComputedStyle(surfaceElement);
      return {
        gap: surfaceElement.getBoundingClientRect().top - document.getElementById('anchor').getBoundingClientRect().bottom,
        anchorBackgroundImage: anchor.backgroundImage,
        anchorSurface: anchor.getPropertyValue('--trigger-anchor-background').trim(),
        bottomBorder: anchor.borderBottomWidth,
        bottomBorderColor: anchor.borderBottomColor,
        edgeFadeBackground: getComputedStyle(surfaceElement, '::before').backgroundImage,
        panelAnimation: surface.animationName,
        panelClipPath: surface.clipPath,
        panelSurface: surface.backgroundColor,
      };
    });

    expect(styles.gap).toBeGreaterThan(0);
    expect(styles.anchorSurface).toBe(styles.panelSurface);
    expect(styles.anchorBackgroundImage).toContain(styles.panelSurface);
    expect(styles.bottomBorderColor).toBe('rgba(0, 0, 0, 0)');
    expect(styles.panelAnimation).toBe('none');
    if (anchorClass === 'search-field-button') {
      await expect(page.locator('#surface')).toHaveCSS('box-shadow', 'none');
    }
    if (styles.edgeFadeBackground !== 'none') {
      expect(styles.edgeFadeBackground).toContain('rgb(75, 193, 115) 5px');
    }

    // Computed colors cannot detect a panel shadow painted over its trigger.
    const screenshot = await page.screenshot();
    const pixels = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const anchor = document.getElementById('anchor').getBoundingClientRect();
      const panel = document.getElementById('surface').getBoundingClientRect();
      const pixel = (x, y) => [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
      return {
        button: pixel(anchor.right - 6, anchor.bottom - 6),
        bridge: pixel(anchor.left + 6, panel.top - 2),
        join: pixel(anchor.left + 6, panel.top + 1),
        panel: pixel(panel.left + 6, panel.top + 60),
      };
    }, screenshot.toString('base64'));
    expect(pixels.button, 'open trigger matches its panel surface').toEqual(pixels.panel);
    for (const [label, pixel] of [['connector', pixels.bridge], ['panel join', pixels.join]]) {
      pixel.forEach((channel, index) => {
        expect(Math.abs(channel - pixels.panel[index]), `${label} matches its panel surface`).toBeLessThanOrEqual(1);
      });
    }
    if (['Album Types', 'Settings', 'Log History Period'].includes(name)) {
      await mountVisualAnchor(page, name);
      // Capture both the hovered trigger and its joined panel across the content,
      // application chrome and date-picker surfaces, including the border glow.
      await expect(page).toHaveScreenshot(`anchor-${name.toLowerCase().replaceAll(' ', '-')}.png`, {
        animations: 'disabled', clip: { x: 20, y: 0, width: 380, height: 360 },
      });
    } else if (['Library', 'Sources', 'Search Filter'].includes(name)) {
      await expect(page).toHaveScreenshot(`anchor-${name.toLowerCase().replaceAll(' ', '-')}.png`, {
        animations: 'disabled', clip: { x: 20, y: 0, width: 380, height: 360 },
      });
    }
    expect(styles.panelClipPath).toBe('inset(0px -80px -80px)');
  });
}

test('nested calendar dates remain clickable beyond the parent panel clipping boundary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountVisualAnchor(page, 'Log History Period');
  await page.evaluate(() => mountDateRangePicker(document.getElementById('date-content')));
  await page.getByRole('button', { name: 'Choose to date', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: 'Choose to date', exact: true });
  await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
  await calendar.getByRole('button', { name: 'Previous month', exact: true }).click();
  await calendar.locator('[data-calendar-date="2026-09-28"]').click();
  await expect(page.getByRole('textbox', { name: 'To date', exact: true })).toHaveValue('2026-09-28');
  await expect(calendar).toHaveCount(0);
  await expect(page.locator('#surface')).toHaveCSS('clip-path', 'inset(0px -80px -80px)');
});

test('artist info opening scrolls only enough to reveal the full panel above the player', async ({ page }) => {
  const fixture = await mountScrollableArtistInfo(page);
  await expect(fixture.surface).toBeVisible();
  await expect.poll(() => fixture.scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const geometry = await page.evaluate(() => ({
    panelBottom: document.querySelector('[data-artist-info-overlay]').getBoundingClientRect().bottom,
    playerTop: document.querySelector('[data-shell-slot="bottom_player"]').getBoundingClientRect().top,
    panelLimit: document.querySelector('[data-artist-info-overlay]').style.getPropertyValue('--artist-info-panel-max-height'),
    bodyLimit: document.querySelector('[data-artist-info-overlay]').style.getPropertyValue('--artist-info-body-max-height'),
  }));
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.playerTop + 1);
  expect(geometry.panelLimit).toBe('');
  expect(geometry.bodyLimit).toBe('');
  await expect(page).toHaveScreenshot('gallery-artist-info-initial-fit.png', {
    animations: 'disabled', clip: { x: 0, y: 0, width: 480, height: 360 },
  });
});

test('artist info follows later gallery scrolling without being squeezed above the player', async ({ page }) => {
  const fixture = await mountScrollableArtistInfo(page);
  await expect.poll(() => fixture.scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await fixture.scroll.evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => fixture.surface.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThan(300);
  await expect(fixture.surface).toBeVisible();
  const limits = await fixture.surface.evaluate(element => ({
    panel: element.style.getPropertyValue('--artist-info-panel-max-height'),
    body: element.style.getPropertyValue('--artist-info-body-max-height'),
  }));
  expect(limits).toEqual({ panel: '', body: '' });
  await expect(page).toHaveScreenshot('gallery-artist-info-after-scroll.png', {
    animations: 'disabled', clip: { x: 0, y: 0, width: 480, height: 360 },
  });
});

for (const name of [
  'Gallery Header Artist Info',
  'Gallery Artist Row Info',
  'Gallery Album Types',
  'Gallery Artist Family',
]) {
  test(`${name} keeps one continuous anchored outline without moving its trigger or icon`, async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 360 });
    const fixture = await mountGalleryAnchor(page, name);
    expect(await fixture.anchor.boundingBox()).toEqual(fixture.before.anchor);
    expect(await fixture.icon.boundingBox()).toEqual(fixture.before.icon);
    await expect(fixture.surface).toBeVisible();
    const outline = await readConnectedOutline(page, fixture.anchor, fixture.surface);
    expect(outline.connectorGaps, 'trigger outline reaches the panel without a detached fragment').toEqual([]);
    expect(outline.connectorAccentGaps, 'the connected trigger-to-panel outline stays blue').toEqual([]);
    expect(outline.topGaps, 'panel top edge is continuous outside the open trigger').toEqual([]);
    expect(outline.topLineSideWidths.left, 'left panel line stops at the trigger corner')
      .toBeLessThanOrEqual(outline.triggerOffsets.left + 0.01);
    expect(outline.topLineSideWidths.right, 'right panel line stops at the trigger corner')
      .toBeLessThanOrEqual(outline.triggerOffsets.right + 0.01);
    await expect(page).toHaveScreenshot(`gallery-${name.toLowerCase().replaceAll(' ', '-')}-anchor.png`, {
      animations: 'disabled',
      clip: { x: 48, y: 0, width: 392, height: 240 },
    });
  });
}
