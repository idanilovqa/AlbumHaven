const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const appearanceUrl = 'http://appearance-component.test/appearance';
const initial = () => ({
  revision: 7, main_surface_color: null, panel_background_color: null,
  palette_id: 'steelblue', panel_index: 0, player_override: null,
  compact_player_style: 'docked', album_details_layout: 'classic_bar',
  album_playing_row_animation: 'enabled', alert_family: 'ember',
  interaction_overrides: { item_hover: '#FF1122', item_selected: '#22FF33',
    button_hover_background: '#3344FF', button_pressed: '#FF55AA',
    item_outline: { source: 'automatic', color: null } },
  selection_accent: { enabled: true, color: '#34CA78' },
  player_style_override: null, player_recent_sets: [],
});

async function mount(page, method, options = {}) {
  const saved = { ...initial(), ...options.saved };
  await page.route(appearanceUrl, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
    .global-player { height: 80px; } .player-play { border: 1px solid; }
    .player-loop-handle::after { content: ''; display: block; height: 10px; }
  </style></head><body><script id="appearance-bootstrap" type="application/json">${JSON.stringify(saved)}</script>
    ${options.utilityShell ? '<div id="utility-modal" class="utility-modal" data-active-tab="appearance"><div class="utility-modal-dialog"><header class="utility-modal-header">Appearance</header><div class="utility-modal-body"><aside class="utility-sidebar"><button class="utility-list-item">Album page</button></aside><main id="editor" class="utility-detail"></main></div></div></div>' : '<main id="editor"></main>'}${options.sharedFooter ? '<footer id="utility-modal-footer"></footer>' : ''}<section class="global-player"><button class="player-play">Play</button><span class="player-loop-handle"></span></section>
  </body></html>` }));
  await page.route('**/account/appearance', route => route.fulfill({ json: { ...saved, csrf_token: 'owned-component-token' } }));
  await page.goto(appearanceUrl);
  const cssFiles = (options.utilityShell || options.appChrome) ? [
    'runtime/base-layout.css', 'runtime/utilities.css', 'runtime/non-album-and-player.css',
    'runtime/shell-persistent-player.css', 'navigation-tree.css', 'appearance-backgrounds.css', 'button-component.css',
  ] : ['button-component.css', 'appearance-backgrounds.css'];
  if (options.appChrome) cssFiles.splice(cssFiles.indexOf('appearance-backgrounds.css'), 0, 'app-chrome.css');
  for (const file of cssFiles) await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  for (const file of ['button-component.js', 'runtime/alert-components.js', 'editor-page.js', 'appearance-palettes.js', 'appearance-backgrounds.js']) await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  await page.evaluate(async method => {
    const instance = window.AlbumHavenAppearance.instance;
    if (!await instance.load()) throw new Error('Component appearance setup must load successfully.');
    const sharedFooter = document.getElementById('utility-modal-footer');
    if (sharedFooter) {
      sharedFooter.style.setProperty('--other-editor-token', '#123456');
      sharedFooter.setAttribute('data-appearance-mode', 'previous-editor');
      sharedFooter.setAttribute('data-alert-family', 'quiet');
      window.appearanceFooterBeforeMount = {
        style: sharedFooter.style.cssText,
        mode: sharedFooter.getAttribute('data-appearance-mode'),
        palette: sharedFooter.getAttribute('data-appearance-palette'),
        alert: sharedFooter.getAttribute('data-alert-family'),
      };
    }
    instance[method](document.getElementById('editor'), { getSeekbarMode: () => 'waveform' });
  }, method);
}

test('native player survives a handle-only save and reload without repainting other components', async ({ page }) => {
  await mount(page, 'mountSeekbar', { utilityShell: true, saved: { palette_id: null, player_style_override: null, player_override: null } });
  await page.route('**/account/appearance', route => {
    const payload = route.request().postDataJSON();
    return route.fulfill({ json: { ...payload, revision: payload.expected_revision + 1 } });
  });
  const result = await page.evaluate(async () => {
    const api = window.AlbumHavenAppearance;
    const root = document.documentElement;
    const player = document.querySelector('.global-player');
    player.insertAdjacentHTML('beforeend', '<button class="loop-play-control-button">Play</button><button class="loop-range-handle is-start"></button><span class="player-title">Title</span>');
    const paint = () => {
      const read = (selector, pseudo) => {
        const style = getComputedStyle(document.querySelector(selector), pseudo);
        return [style.backgroundImage, style.backgroundColor, style.color, style.borderColor, style.boxShadow];
      };
      return { surface: read('.global-player'), controls: read('.loop-play-control-button'), title: read('.player-title'), handle: read('.loop-range-handle', '::after'), waveform: api.getSavedPlayerColors() };
    };
    const before = paint();
    const controller = api.instance.controller;
    controller.setPlayerStyleColor('handles.color', '#123456');
    if (!await controller.save()) throw new Error('Handle save failed');
    api.clearTheme(root);
    const reloaded = api.createController({ initial: controller.getState().saved });
    api.applyTheme(reloaded.getState().saved, root);
    return { before, after: paint() };
  });
  expect(result.before.surface[0]).toContain('radial-gradient');
  for (const component of ['surface', 'controls', 'title', 'waveform']) expect(result.after[component], component).toEqual(result.before[component]);
  expect(result.after.handle[1]).toBe('rgb(18, 52, 86)');
  expect(result.after.handle).not.toEqual(result.before.handle);
});

test('custom controls keep opaque action pods while the player surface remains native', async ({ page }) => {
  await mount(page, 'mountSeekbar', { utilityShell: true, saved: { palette_id: null, player_style_override: null, player_override: null } });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/playback-control-cluster.js') });
  const paint = await page.evaluate(() => {
    const api = window.AlbumHavenAppearance;
    const player = document.querySelector('.global-player');
    for (const loopControlStyle of ['capsule', 'companion']) {
      player.insertAdjacentHTML('beforeend', window.renderPlaybackControlCluster({ variant: 'expanded-player', loopControlStyle }));
    }
    player.querySelectorAll('[data-playback-control-cluster]').forEach(node => {
      node.setAttribute('data-loop-action-engaged', 'true');
      node.setAttribute('data-loop-action-state', 'editing');
    });
    player.insertAdjacentHTML('beforeend', '<button class="player-loop-button is-active">Loop</button><div class="player-timeline-wrap is-idle"></div>');
    const surface = getComputedStyle(player).backgroundImage;
    api.instance.controller.setPlayerStyleColor('controls.fill', '#123456');
    api.applyTheme(api.instance.controller.getState().draft, document.documentElement);
    const pod = document.querySelector('[data-loop-control-style="capsule"]');
    const companion = document.querySelector('[data-loop-control-style="companion"]');
    const idle = document.querySelector('.player-timeline-wrap');
    const idleBackground = getComputedStyle(idle, '::before').backgroundColor;
    const style = structuredClone(api.instance.controller.getState().draft.player_style_override);
    style.native_components.push('waveform');
    api.instance.controller.setPlayerStyle(style);
    api.applyTheme(api.instance.controller.getState().draft, document.documentElement);
    const loop = getComputedStyle(document.querySelector('.player-loop-button'));
    return { surface, after: getComputedStyle(player).backgroundImage, outline: [loop.outlineStyle, loop.outlineWidth, loop.outlineColor],
      pod: getComputedStyle(pod, '::before').backgroundColor, tail: getComputedStyle(companion, '::before').backgroundColor,
      idle: idleBackground };
  });
  expect(paint.after).toBe(paint.surface);
  expect(paint.outline).toEqual(['solid', '2px', 'rgb(73, 73, 80)']);
  for (const component of ['pod', 'tail', 'idle']) expect(paint[component], component).toBe('rgb(7, 24, 39)');
});

test('Appearance detail remains vertical-only when its content fits the available width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, 'mountSeekbar', { utilityShell: true });
  await page.locator('#editor').evaluate(editor => {
    const detail = document.createElement('main');
    detail.className = 'utility-detail';
    editor.classList.remove('utility-detail');
    editor.replaceWith(detail);
    detail.append(editor);
  });
  await expect(page.locator('#utility-modal .utility-detail')).toHaveCSS('overflow-x', 'hidden');
});

for (const width of [900, 901, 1024, 1280]) {
  test(`Album page workspace fits the production Utilities shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, 'mountAlbumPage', { utilityShell: true });
    const detail = page.locator('#editor');
    const workspace = page.locator('.appearance-album-page__workspace');
    const controls = page.locator('.appearance-album-page__controls');
    const preview = page.locator('.appearance-album-page__preview');
    const geometry = await detail.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    const [detailBox, workspaceBox, controlsBox, previewBox] = await Promise.all([detail, workspace, controls, preview].map(item => item.boundingBox()));
    for (const box of [detailBox, workspaceBox, controlsBox, previewBox]) expect(box).not.toBeNull();
    for (const box of [controlsBox, previewBox]) {
      expect(box.x).toBeGreaterThanOrEqual(workspaceBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(detailBox.x + detailBox.width + 1);
    }
    if (width === 900 || width === 1280) expect(previewBox.x).toBeGreaterThan(controlsBox.x);
    else expect(previewBox.y).toBeGreaterThanOrEqual(controlsBox.y + controlsBox.height);
  });
}

test('tables resolve their surface locally inside dark panels on a light page', async ({ page }) => {
  await page.setContent(`<html style="--appearance-card:#fff7e5;--appearance-ink:#202124">
    <div class="compact-data-table" data-cdt-frame="outline">Light content table</div>
    <section style="--appearance-card:#14221b;--appearance-ink:#e8f2eb">
      <div class="compact-data-table" data-cdt-frame="outline">Dark Settings table</div>
      <div class="compact-data-table" data-cdt-frame="inset">Dark inset table</div>
    </section></html>`);
  for (const file of ['runtime/compact-data-table.css', 'appearance-backgrounds.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  const colors = await page.locator('.compact-data-table').evaluateAll(tables => tables.map(table => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.fillStyle = getComputedStyle(table).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }));
  expect(Math.min(...colors[0])).toBeGreaterThan(200);
  for (const dark of colors.slice(1)) expect(Math.max(...dark)).toBeLessThan(65);
});

for (const palette of ['black', 'parchment-pine']) {
  test(`dark ${palette} tables stay close to the panel rather than washed-out grey`, async ({ page }) => {
    await page.setContent(`<html data-appearance-mode="${palette === 'black' ? 'dark' : 'light'}" data-appearance-palette="${palette}"
      style="--appearance-card:#333;--appearance-ink:#eee;--appearance-panel-background:#101814;--appearance-panel-control:#303830;--appearance-panel-ink:#eee;--panel:#101814;--text:#eee">
      <section class="utility-modal-dialog"><div class="album-track-table"><div class="compact-data-table" data-cdt-frame="outline"><div class="compact-data-table-header">Track</div></div></div></section></html>`);
    for (const file of ['runtime/compact-data-table.css', 'runtime/album-track-table.css', 'appearance-backgrounds.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    const colors = await page.locator('.compact-data-table, .compact-data-table-header').evaluateAll(elements => elements.map(element => {
      const context = document.createElement('canvas').getContext('2d');
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }));
    for (const color of colors) expect(Math.max(...color)).toBeLessThan(36);
  });
}

for (const palette of ['black', 'parchment-pine']) {
  test(`dark table bodies and headers exactly match their owning panel in ${palette}`, async ({ page }) => {
    const table = `<div class="compact-data-table" data-cdt-frame="outline"><div class="compact-data-table-header">Header</div><div class="compact-data-table-row">Row</div></div>`;
    await page.setContent(`<html data-appearance-mode="${palette === 'black' ? 'dark' : 'light'}" data-appearance-palette="${palette}" style="--appearance-card:#333;--appearance-ink:#eee;--appearance-panel-background:#101814;--panel:#303030;--text:#eee">
      <section class="utility-modal-dialog">
        <div class="album-track-table">${table}</div>
        <div class="utility-detected-table">${table}</div>
        <div class="utility-problem-exclusions-detail">${table}</div>
      </section></html>`);
    for (const file of ['runtime/compact-data-table.css', 'runtime/album-track-table.css', 'runtime/utilities.css', 'appearance-backgrounds.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await expect(page.locator('.utility-modal-dialog')).toHaveCSS('background-color', 'rgb(16, 24, 20)');
    const surfaces = page.locator('.compact-data-table, .compact-data-table-header');
    for (let index = 0; index < 6; index += 1) {
      await expect(surfaces.nth(index)).toHaveCSS('background-color', 'rgb(16, 24, 20)');
    }
  });
}

test('light Problematic Files tables share the album-details table presentation', async ({ page }) => {
  const table = `<div class="compact-data-table" data-cdt-frame="inset">
    <div class="compact-data-table-header"><span role="columnheader">Track / file</span></div>
    <div class="compact-data-table-row">Example track</div></div>`;
  await page.setContent(`<html data-appearance-mode="light" style="--appearance-card:#f5f0e4;--appearance-ink:#202124;--appearance-muted:#505762;--appearance-line:#9aabbc;--panel:#f5f0e4;--text:#202124;--muted:#505762">
    <div class="album-track-table">${table}</div>
    <div class="utility-detected-table">${table}</div>
    <div class="utility-track-problem-table">${table}</div></html>`);
  for (const file of ['runtime/compact-data-table.css', 'runtime/album-track-table.css', 'runtime/utilities.css', 'appearance-backgrounds.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  const read = element => {
    const table = getComputedStyle(element);
    const header = getComputedStyle(element.querySelector('.compact-data-table-header'));
    const label = getComputedStyle(element.querySelector('[role="columnheader"]'));
    return { background: table.backgroundColor, border: table.borderTopColor, radius: table.borderTopLeftRadius,
      header: header.backgroundColor, headerRadius: header.borderTopLeftRadius, ink: label.color };
  };
  const tables = page.locator('.compact-data-table');
  const reference = await tables.first().evaluate(read);
  for (let index = 1; index < 3; index += 1) {
    expect(await tables.nth(index).evaluate(read)).toEqual(reference);
  }
  const rows = page.locator('.compact-data-table-row');
  await rows.first().hover();
  const hover = await rows.first().evaluate(element => getComputedStyle(element).backgroundColor);
  for (let index = 1; index < 3; index += 1) {
    await rows.nth(index).hover();
    await expect(rows.nth(index)).toHaveCSS('background-color', hover);
  }
  await page.locator('html').evaluate(element => element.dataset.appearanceMode = 'dark');
  await page.mouse.move(0, 0);
  await expect(tables.nth(1)).toHaveCSS('border-top-left-radius', '8px');
  const darkSurface = await tables.nth(1).evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(tables.nth(1).locator('.compact-data-table-header')).toHaveCSS('background-color', darkSurface);
});

async function mountArtistFamilyCards(page, appearanceMode) {
  await page.setContent(`<!doctype html><html data-appearance-palette="fixture" data-appearance-mode="${appearanceMode}"><body>
    <button class="ui-filter-pill artist-family-panel__artist">
      <span class="artist-family-panel__marker"></span>
      <span class="artist-family-panel__name">Default artist</span>
      <span class="artist-family-panel__count">2</span>
    </button>
    <button class="ui-filter-pill artist-family-panel__artist is-active">
      <span class="artist-family-panel__marker"></span>
      <span class="artist-family-panel__name">Active artist</span>
      <span class="artist-family-panel__count">4</span>
    </button>
  </body></html>`);
  for (const file of ['gallery-main.css', 'appearance-backgrounds.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.locator('html').evaluate(element => {
    element.style.setProperty('--appearance-card', 'rgb(17, 17, 17)');
    element.style.setProperty('--appearance-control', 'rgb(20, 80, 45)');
    element.style.setProperty('--appearance-item-hover', 'rgb(24, 110, 55)');
    element.style.setProperty('--appearance-item-selected', 'rgb(28, 130, 65)');
    element.style.setProperty('--appearance-play', 'rgb(75, 193, 115)');
    element.style.setProperty('--appearance-play-ink', 'rgb(8, 56, 32)');
    element.style.setProperty('--appearance-interaction-outline', 'rgb(200, 100, 50)');
  });
}

test('light Artist Family selection uses a translucent green fill through hover and focus', async ({ page }) => {
  await mountArtistFamilyCards(page, 'light');
  await page.locator('html').evaluate(root => root.style.setProperty('--appearance-card', 'rgb(255, 247, 229)'));
  const cards = page.locator('.artist-family-panel__artist');
  const unselected = cards.nth(0);
  const selected = cards.nth(1);
  const selectedName = selected.locator('.artist-family-panel__name');
  const selectedCount = selected.locator('.artist-family-panel__count');

  await expect(unselected).toHaveCSS('background-color', 'rgb(255, 247, 229)');
  await expect(selected).toHaveCSS('background-color', 'color(srgb 0.294118 0.756863 0.45098 / 0.2)');
  await expect(selected).toHaveCSS('border-color', 'rgb(75, 193, 115)');
  await expect(selectedName).toHaveCSS('color', 'rgb(8, 56, 32)');
  await expect(selectedCount).toHaveCSS('background-color', 'color(srgb 0.872941 0.93051 0.817569)');
  await expect(selectedCount).toHaveCSS('color', 'rgb(8, 56, 32)');
  await expect(selected.locator('.artist-family-panel__marker')).toHaveCSS('visibility', 'visible');

  await unselected.hover();
  await expect(unselected).toHaveCSS('background-color', 'rgb(255, 247, 229)');
  await selected.hover();
  await expect(selected).toHaveCSS('background-color', 'color(srgb 0.294118 0.756863 0.45098 / 0.2)');
  await page.mouse.down();
  await expect(selected).toHaveCSS('background-color', 'color(srgb 0.294118 0.756863 0.45098 / 0.2)');
  await page.mouse.up();
  await page.mouse.move(500, 500);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(selected).toBeFocused();
  await expect(selected).toHaveCSS('background-color', 'color(srgb 0.294118 0.756863 0.45098 / 0.2)');
  await expect(selected).toHaveCSS('border-color', 'rgb(200, 100, 50)');
});

test('dark Artist Family selection keeps the border-only treatment', async ({ page }) => {
  await mountArtistFamilyCards(page, 'dark');
  const cards = page.locator('.artist-family-panel__artist');
  const unselected = cards.nth(0);
  const selected = cards.nth(1);

  await expect(unselected).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect(selected).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  await expect(selected).toHaveCSS('border-color', 'rgb(75, 193, 115)');
});

for (const palette of [null, 'steelblue']) {
  test(`Selection swatches retain their own colors during hover and press with palette ${palette}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await mount(page, 'mountSelectionAccent', { saved: { palette_id: palette } });
    for (const selector of ['[data-aggregate-accent-color]', '[data-interaction-color="button_hover_background"]', '[data-item-outline-color]']) {
      const swatch = page.locator(selector).first();
      const hex = await swatch.getAttribute(selector === '[data-aggregate-accent-color]' ? 'data-aggregate-accent-color' : 'data-color');
      const rgb = `rgb(${hex.slice(1).match(/../g).map(part => parseInt(part, 16)).join(', ')})`;
      await swatch.hover();
      await expect.soft(swatch).toHaveCSS('background-color', rgb, { timeout: 800 });
      await expect(swatch).toHaveCSS('border-top-width', '1px');
      await page.mouse.down();
      try { await expect.soft(swatch).toHaveCSS('background-color', rgb, { timeout: 800 }); }
      finally { await page.mouse.up(); }
      await expect(swatch).toHaveAttribute('aria-pressed', 'true');
      await expect(swatch).toHaveCSS('outline-width', '2px');
    }
  });
}

test('every palette paints a valid player gradient, control border, and loop handle', async ({ page }) => {
  await mount(page, 'mount');
  const paints = await page.evaluate(() => window.AlbumHavenAppearance.palettes.map(palette => {
    const api = window.AlbumHavenAppearance;
    api.applyTheme({ ...api.instance.controller.getState().saved, palette_id: palette.id }, document.documentElement);
    return { palette: palette.id,
      background: getComputedStyle(document.querySelector('.global-player')).backgroundImage,
      border: getComputedStyle(document.querySelector('.player-play')).borderColor,
      handle: getComputedStyle(document.querySelector('.player-loop-handle'), '::after').backgroundColor,
      expectedBorder: api.resolveAppearance({ palette_id: palette.id }).player.edge };
  }));
  for (const paint of paints) {
    expect(paint.background, paint.palette).toContain('linear-gradient(');
    expect(paint.handle, paint.palette).not.toBe('rgba(0, 0, 0, 0)');
    const expected = paint.expectedBorder.match(/\w\w/g).map(value => parseInt(value, 16)).join(', ');
    expect(paint.border, paint.palette).toBe(`rgb(${expected})`);
  }
});

for (const action of ['theme', 'reset']) {
  test(`Selection preview ${action} masks saved interaction colors until Save`, async ({ page }) => {
    await mount(page, 'mountSelectionAccent');
    const selectors = ['navigation-hover', 'navigation-selected', 'item-hover-background', 'item-pressed'];
    const before = await page.evaluate(() => document.documentElement.style.cssText);
    await page.evaluate(action => {
      const controller = window.AlbumHavenAppearance.instance.controller;
      if (action === 'theme') controller.useThemeInteractions();
      else controller.resetSection('selection-accent');
    }, action);
    const effective = await page.evaluate(() => {
      const api = window.AlbumHavenAppearance;
      const draft = api.instance.controller.getState().draft;
      const resolved = api.resolveAppearance(draft);
      const tokens = resolved.tokens;
      const actions = api.resolveActionInteractionTokens(draft, resolved);
      const toRgb = value => { const probe = document.createElement('span'); probe.style.backgroundColor = value; document.body.append(probe); const result = getComputedStyle(probe).backgroundColor; probe.remove(); return result; };
      return { hover: toRgb(tokens.hover), selected: toRgb(`color-mix(in srgb, ${tokens.ink} 10%, ${resolved.panel})`),
        actionHover: toRgb(actions.hoverBackground), actionPressed: toRgb(actions.pressedBackground) };
    });
    for (const [index, state] of selectors.entries()) await expect(page.locator(`[data-preview-state="${state}"]`)).toHaveCSS('background-color', [effective.hover, effective.selected, effective.actionHover, effective.actionPressed][index]);
    expect(await page.evaluate(() => document.documentElement.style.cssText)).toBe(before);
    await page.evaluate(() => window.AlbumHavenAppearance.instance.controller.cancel());
    await expect(page.locator('[data-preview-state="navigation-hover"]')).toHaveCSS('background-color', 'rgb(255, 17, 34)');
  });
}

test('structured HEX fields display invalid text and block Save until correction or Cancel', async ({ page }) => {
  await mount(page, 'mountSeekbar');
  for (const [stylePath, tabGroup, tab] of [
    ['surface.start', 'player', 'surface'], ['surface.end', 'player', 'surface'],
    ['controls.fill', 'player', 'controls'], ['controls.border', 'player', 'controls'],
    ['handles.color', 'waveform', 'handles'],
  ]) {
    await page.locator(`[data-player-tab-group="${tabGroup}"][data-player-tab="${tab}"]`).click();
    const input = page.locator(`[data-player-style-hex="${stylePath}"]`);
    await input.fill('#BADHEX');
    await expect(input).toHaveValue('#BADHEX');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('[data-background-save]')).toBeDisabled();
    expect(await page.evaluate(() => window.AlbumHavenAppearance.instance.allowLeave(() => false))).toBe(false);
    await input.fill('#345678');
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await expect(page.locator('[data-background-save]')).toBeEnabled();
    await page.locator('[data-background-cancel]').click();
    await expect(page.locator('[data-background-save]')).toBeDisabled();
  }
});

test('unsaved palette stays in five previews while editor and shared footer retain the saved theme', async ({ page }) => {
  await mount(page, 'mount', { sharedFooter: true });
  const expected = await page.evaluate(() => {
    const api = window.AlbumHavenAppearance;
    const saved = api.instance.controller.getState().saved;
    return { saved: api.resolveAppearance(saved).tokens.control,
      draft: api.resolveAppearance({ ...saved, palette_id: 'silver', panel_index: 0 }).tokens.control };
  });
  expect(expected.draft).not.toBe(expected.saved);
  await page.locator('[data-background-palette="silver"]').click();
  const samples = [];
  for (const [method, previewSelector] of [
    ['mount', '[data-background-preview]'], ['mountAlerts', '[data-alert-live-preview]'],
    ['mountAlbumPage', '[data-album-page-live-preview]'], ['mountSelectionAccent', '.selection-hover-preview'],
    ['mountSeekbar', '[data-player-live-preview]'],
  ]) {
    samples.push(await page.evaluate(({ method, previewSelector }) => {
      window.AlbumHavenAppearance.instance[method](document.getElementById('editor'), { getSeekbarMode: () => 'waveform' });
      const token = element => getComputedStyle(element).getPropertyValue('--appearance-control').trim();
      return { method, editor: token(document.getElementById('editor').firstElementChild),
        footer: token(document.querySelector('#utility-modal-footer [data-background-save]')),
        preview: token(document.querySelector(previewSelector)),
        document: token(document.documentElement) };
    }, { method, previewSelector }));
  }
  expect(samples).toEqual(samples.map(({ method }) => ({ method, editor: expected.saved,
    footer: expected.saved, preview: expected.draft, document: expected.saved })));
  await page.locator('#utility-modal-footer [data-background-cancel]').click();
  expect(await page.evaluate(() => window.AlbumHavenAppearance.instance.controller.getState().dirty)).toBe(false);
  await page.evaluate(() => { window.AlbumHavenAppearance.instance.mount(document.getElementById('editor')); });
  await page.locator('[data-background-palette="silver"]').click();
  await page.route('**/account/appearance', route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const { expected_revision, applied_player_set, waveform_color_updates, ...preferences } = route.request().postDataJSON();
    return route.fulfill({ json: { ...preferences, revision: expected_revision + 1, player_recent_sets: [] } });
  });
  await page.locator('#utility-modal-footer [data-background-save]').click();
  await expect(page.locator('html')).toHaveAttribute('data-appearance-palette', 'silver');
  await expect(page.locator('#utility-modal-footer [data-background-save]')).toBeDisabled();
  expect(await page.evaluate(() => ['.appearance-background-editor', '#utility-modal-footer', '[data-background-preview]']
    .map(selector => getComputedStyle(document.querySelector(selector)).getPropertyValue('--appearance-control').trim())))
    .toEqual([expected.draft, expected.draft, expected.draft]);
});

for (const method of ['mount', 'mountSeekbar']) {
  test(`default account gives ${method} controls and shared footer resolved tokens`, async ({ page }) => {
    await mount(page, method, { saved: { palette_id: null }, sharedFooter: true });
    const expected = await page.evaluate(() => {
      const api = window.AlbumHavenAppearance;
      const tokens = api.resolveAppearance(api.instance.controller.getState().draft).tokens;
      const rgb = value => `rgb(${value.match(/\w\w/g).map(part => parseInt(part, 16)).join(', ')})`;
      return { ink: rgb(tokens.ink), control: rgb(tokens.control), line: rgb(tokens.line) };
    });
    const input = page.locator('.appearance-background-editor input[type=text]').first();
    await expect(input).toHaveCSS('color', expected.ink);
    await expect(input).toHaveCSS('background-color', expected.control);
    await expect(input).toHaveCSS('border-top-color', expected.line);
    await expect(page.locator('#utility-modal-footer [data-background-cancel]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('#utility-modal-footer [data-background-cancel]')).toHaveCSS('color', expected.ink);
    await expect(page.locator('#utility-modal-footer [data-background-save]')).toHaveCSS('background-color', expected.control);
    await expect(page.locator('#utility-modal-footer [data-background-save]')).toHaveCSS('color', expected.ink);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--appearance-ink'))).toBe('');
  });
}

for (const palette of [null, 'steelblue']) {
  test(`saved navigation colors reach live artist rows with palette ${palette}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mount(page, 'mountSelectionAccent', { saved: { palette_id: palette } });
    for (const file of ['base.css', 'app-chrome.css', 'navigation-tree.css']) await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    await page.addStyleTag({ path: path.join(staticRoot, 'css', 'appearance-backgrounds.css') });
    await page.evaluate(() => {
      const template = document.createElement('script'); template.id = 'navigation-tree-item-template'; template.type = 'text/plain';
      template.textContent = '<%s %s>%s<span class="navigation-tree-label artist-name-label">%s</span>%s</%s>';
      document.body.append(template);
    });
    await page.addScriptTag({ path: path.join(staticRoot, 'js', 'navigation-tree.js') });
    await page.evaluate(() => {
      const rail = document.createElement('nav'); rail.className = 'shell-navigation-rail'; rail.id = 'live-artists';
      rail.innerHTML = window.NavigationTree.renderItems([{ label: 'Artist one', key: 'one' }, { label: 'Artist two', key: 'two', selected: true }]);
      document.body.prepend(rail);
    });
    const row = page.locator('#live-artists [data-navigation-tree-key=one]');
    await row.hover();
    await expect(row).toHaveCSS('background-color', 'rgb(255, 17, 34)');
    await expect(page.locator('#live-artists .is-selected')).toHaveCSS('background-color', 'rgb(34, 255, 51)');
  });
}
test('unmount restores the shared footer theme before another editor takes ownership', async ({ page }) => {
  await mount(page, 'mount', { saved: { palette_id: null }, sharedFooter: true });
  const result = await page.evaluate(() => {
    const instance = window.AlbumHavenAppearance.instance;
    instance.controller.setPalette('paper');
    instance.unmount();
    const footer = document.getElementById('utility-modal-footer');
    return {
      before: window.appearanceFooterBeforeMount,
      after: { style: footer.style.cssText, mode: footer.getAttribute('data-appearance-mode'),
        palette: footer.getAttribute('data-appearance-palette'), alert: footer.getAttribute('data-alert-family') },
      hidden: footer.hidden, content: footer.innerHTML,
    };
  });
  expect(result.after).toEqual(result.before);
  expect(result.hidden).toBe(true);
  expect(result.content).toBe('');
});
for (const palette of [null, 'steelblue']) {
  test(`saved independent interactions reach live consumers with palette ${palette}`, async ({ page }) => {
    await mount(page, 'mountSelectionAccent', { saved: { palette_id: palette } });
    for (const file of ['runtime/base-layout.css', 'runtime/utilities.css', 'runtime/account-menu.css', 'runtime/trigger-anchor.css', 'runtime/cover-lookup-drawer-and-related.css', 'button-component.css', 'appearance-backgrounds.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
    }
    await page.evaluate(() => {
      const host = document.createElement('section'); host.id = 'live-consumers';
      document.documentElement.style.setProperty('--dropdown-item-hover-background', 'rgb(36, 36, 36)');
      host.innerHTML = '<button class="utility-list-item" id="utility-hover">List row</button><button class="utility-list-item is-active" id="utility-selected">Selected row</button><a class="account-menu-item" href="#" id="menu-link">Menu link</a><button class="account-menu-item" id="menu-button">Menu button</button><a class="related-chip" href="#" id="related-hover">Related artist</a><a class="related-chip active" href="#" id="related-selected">Selected related artist</a><button class="related-toggle" id="related-toggle">Related artists</button><button class="button" id="legacy-action">Legacy action</button><button class="button ui-button" id="shared-action">Shared action</button><button class="button ui-button ui-button--quiet" id="quiet-action">Cancel</button><input type="checkbox" id="native-check"><input type="radio" id="native-radio">';
      document.body.prepend(host);
    });
    const hoverColors = [
      ['utility-hover', 'rgb(255, 17, 34)'], ['menu-link', 'rgb(36, 36, 36)'],
      ['menu-button', 'rgb(36, 36, 36)'], ['related-hover', 'rgb(255, 17, 34)'],
      ['related-toggle', 'rgb(51, 68, 255)'], ['legacy-action', 'rgb(51, 68, 255)'],
      ['shared-action', 'rgb(51, 68, 255)'],
    ];
    for (const [id, color] of hoverColors) {
      await page.locator('#' + id).hover();
      await expect.soft(page.locator('#' + id), id).toHaveCSS('background-color', color, { timeout: 800 });
    }
    for (const id of ['utility-selected', 'related-selected']) {
      await expect.soft(page.locator('#' + id), id).toHaveCSS('background-color', 'rgb(34, 255, 51)', { timeout: 800 });
      await page.locator('#' + id).hover();
      await expect.soft(page.locator('#' + id), id + ' while hovered').toHaveCSS('background-color', 'rgb(34, 255, 51)', { timeout: 800 });
    }
    for (const id of ['legacy-action', 'shared-action', 'native-check', 'native-radio']) {
      await page.locator('#' + id).hover();
      await page.mouse.down();
      try { await expect.soft(page.locator('#' + id), id).toHaveCSS(id.startsWith('native-') ? 'accent-color' : 'background-color', 'rgb(255, 85, 170)', { timeout: 800 }); }
      finally { await page.mouse.up(); }
    }
    await page.locator('#quiet-action').hover();
    await expect(page.locator('#quiet-action')).not.toHaveCSS('background-color', 'rgb(51, 68, 255)');
    await page.evaluate(() => {
      const api = window.AlbumHavenAppearance;
      const saved = api.instance.controller.getState().saved;
      api.applyTheme({ ...saved, palette_id: null, interaction_overrides: { ...saved.interaction_overrides, item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null } }, document.documentElement);
    });
    await page.locator('#utility-hover').hover();
    await expect(page.locator('#utility-hover')).toHaveCSS('background-color', 'rgba(96, 165, 250, 0.1)');
    await expect(page.locator('#utility-selected')).toHaveCSS('background-color', 'rgba(96, 165, 250, 0.1)');
    await page.locator('#menu-link').hover();
    await expect(page.locator('#menu-link')).toHaveCSS('background-color', 'rgb(36, 36, 36)');
    await expect(page.locator('#menu-link')).toHaveCSS('outline-style', 'none');
    await expect(page.locator('#menu-link')).toHaveCSS('box-shadow', 'none');
    await page.locator('html').evaluate(element => element.style.setProperty('--dropdown-item-hover-background', 'rgb(70, 70, 70)'));
    await expect(page.locator('#menu-link')).toHaveCSS('background-color', 'rgb(70, 70, 70)');
    await page.locator('#legacy-action').hover();
    await expect(page.locator('#legacy-action')).not.toHaveCSS('background-color', 'rgb(51, 68, 255)');
  });
}

for (const field of ['fill', 'edge', 'handles.color']) {
  test(`Default seekbar exposes retained ${field} validation and a correction route`, async ({ page }) => {
    await mount(page, 'mountSeekbar');
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime/bootstrap-utility-event-handlers.js') });
    await page.evaluate(() => {
      window.state = { utility: {}, coverLookup: {}, player: { appearance: { seekbarMode: 'waveform' } } };
      window.normalizePlayerAppearance = value => value;
      window.persistPlayerAppearance = () => {};
      window.updateWaveformAppearance = () => {};
      window.renderUtilityModalContent = () => window.AlbumHavenAppearance.instance.mountSeekbar(document.getElementById('editor'), { getSeekbarMode: () => state.player.appearance.seekbarMode });
      document.addEventListener('click', event => {
        if (event.target.closest('[data-appearance-seekbar-mode]')) void handleUtilityBootstrapClick(event);
      });
    });
    if (field === 'handles.color') await page.locator('[data-player-tab-group="waveform"][data-player-tab="handles"]').click();
    const selector = field === 'handles.color' ? '[data-player-style-hex="handles.color"]' : `[data-player-hex="${field}"]`;
    await page.locator(selector).fill('#BADHEX');
    await page.locator('[data-appearance-seekbar-mode="default"]').check();
    await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.locator('[data-background-save]')).toBeDisabled();
    const explanation = page.locator('[data-background-other-errors]');
    await expect(explanation).toBeVisible();
    await expect(explanation).toContainText(/Waveform seekbar/);
    await page.locator('[data-appearance-seekbar-mode="waveform"]').check();
    if (field === 'handles.color') await page.locator('[data-player-tab-group="waveform"][data-player-tab="handles"]').click();
    await expect(page.locator(selector)).toHaveValue('#BADHEX');
    await expect(page.locator(selector)).toHaveAttribute('aria-invalid', 'true');
    await page.locator(selector).fill('#345678');
    await expect(page.locator('[data-background-save]')).toBeEnabled();
    await page.locator('[data-background-cancel]').click();
    await expect(page.locator('[data-background-save]')).toBeDisabled();
  });
}

test('correcting Player surface start repairs the Main background HEX alias', async ({ page }) => {
  await mount(page, 'mount', { saved: { player_style_override: {
    surface: { mode: 'gradient', angle: 0, start: '#0A2F24', end: '#0A1422' },
    controls: { fill: '#24B86B', border: '#86EFAC' },
    waveform: { fill: '#387F68', edge: '#AFD8C2' },
    handles: { color: '#AFD8C2' },
  } } });
  await page.locator('[data-player-hex="background"]').fill('#BADHEX');
  await expect(page.locator('[data-background-save]')).toBeDisabled();
  await page.evaluate(() => window.AlbumHavenAppearance.instance.mountSeekbar(document.getElementById('editor'), { getSeekbarMode: () => 'waveform' }));
  await page.locator('[data-player-tab-group="player"][data-player-tab="surface"]').click();
  await page.locator('[data-player-style-hex="surface.start"]').fill('#345678');
  await expect(page.locator('[data-background-save]')).toBeEnabled();
  await page.evaluate(() => window.AlbumHavenAppearance.instance.mount(document.getElementById('editor')));
  await expect(page.locator('[data-player-hex="background"]')).toHaveValue('#345678');
  await expect(page.locator('[data-player-hex="background"]')).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('[data-background-save]')).toBeEnabled();
});

test('Mobile and TV device appearance is disabled without an outer pill', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, 'mountSeekbar', { sharedFooter: true });
  const controls = page.locator('.appearance-device-controls');
  const desktop = page.locator('[data-appearance-device="web_desktop"]');
  await expect(page.locator('[data-appearance-device="mobile"]')).toBeDisabled();
  await expect(page.locator('[data-appearance-device="tv"]')).toBeDisabled();
  await expect(page.locator('[data-appearance-device-mode]')).toHaveCount(0);
  await expect(desktop).toHaveAttribute('aria-pressed', 'true');
  await expect(controls).toHaveCSS('border-style', 'none');
  await expect(controls).toHaveCSS('border-radius', '0px');
  await expect(controls).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

for (const method of ['mount', 'mountAlerts', 'mountAlbumPage', 'mountSelectionAccent', 'mountSeekbar']) {
  test(`${method} keeps unavailable devices natively disabled after load save and cancel`, async ({ page }) => {
    await mount(page, method);
    await page.route('**/account/appearance', route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const { expected_revision, ...saved } = route.request().postDataJSON();
      return route.fulfill({ json: { ...saved, revision: expected_revision + 1 } });
    });
    for (const stage of ['load', 'save', 'cancel']) {
      await page.evaluate(async stage => {
        const controller = window.AlbumHavenAppearance.instance.controller;
        if (stage === 'load') await window.AlbumHavenAppearance.instance.load();
        else {
          controller.setColor('main_surface_color', stage === 'save' ? '#123456' : '#654321');
          if (stage === 'save') await controller.save();
          else controller.cancel();
        }
      }, stage);
      for (const device of ['mobile', 'tv']) {
        const button = page.locator(`[data-appearance-device="${device}"]`);
        expect(await button.evaluate(element => element.disabled), `${device} after ${stage}`).toBe(true);
        await button.evaluate(element => element.click());
        expect(await page.evaluate(() => window.AlbumHavenAppearance.instance.controller.getState().activeDeviceProfile)).toBe('web_desktop');
        await expect(button).toHaveAttribute('aria-pressed', 'false');
      }
      await expect(page.locator('[data-appearance-device="web_desktop"]')).toHaveAttribute('aria-pressed', 'true');
    }
  });
}

test('actual Utilities close-button MouseEvent keeps the dirty editor until discard is accepted', async ({ page }) => {
  await mount(page, 'mountSeekbar');
  await page.evaluate(() => {
    window.state = { utility: {}, ui: {} };
    const overlay = document.createElement('section'); overlay.id = 'utility-modal';
    const close = document.createElement('button'); close.textContent = 'Close Utilities'; close.className = 'button ui-button'; close.setAttribute('data-close-utility-modal', '1');
    document.body.append(overlay); overlay.append(close, document.getElementById('editor'));
    window.getUtilityModalElements = () => ({ overlay, close });
    window.bindOverlayPointerOrigin = () => {};
    window.overlayClickStartedOnOverlay = (_overlay, event) => event.target === overlay;
    window.promptCount = 0;
    window.showAppConfirmDialog = () => { window.promptCount += 1; return new Promise(resolve => { window.resolveAppearanceLeave = resolve; }); };
  });
  for (const file of ['utility-loaders-and-cover-lookup.js', 'track-modal-and-gallery.js', 'appearance-backgrounds-bridge.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => { resumeDeferredUtilityViewRequest = () => {}; attachUtilityModalEvents(); });
  await page.locator('[data-player-hex="fill"]').fill('#BADHEX');
  await page.getByRole('button', { name: 'Close Utilities', exact: true }).click();
  await expect(page.locator('#utility-modal')).toBeVisible();
  expect(await page.evaluate(() => window.promptCount)).toBe(1);
  await page.evaluate(() => window.resolveAppearanceLeave(false));
  await expect(page.locator('[data-player-hex="fill"]')).toHaveValue('#BADHEX');
  await page.getByRole('button', { name: 'Close Utilities', exact: true }).click();
  expect(await page.evaluate(() => window.promptCount)).toBe(2);
  await page.evaluate(() => window.resolveAppearanceLeave(true));
  await expect(page.locator('#utility-modal')).toBeHidden();
  expect(await page.evaluate(() => window.AlbumHavenAppearance.instance.controller.getState().dirty)).toBe(false);
});

test('Parchment & Pine renders dark rail controls while preserving the light main theme', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, 'mount', { appChrome: true });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<aside class="shell-navigation-rail"><h2>Artist Tree</h2><a href="#artist" class="artist-link navigation-tree-item">Artist</a><button class="ui-button ui-button--secondary">Tree control</button></aside><section class="shell-main-surface"><h2>Albums</h2></section>');
    const api = window.AlbumHavenAppearance;
    api.applyTheme({ ...api.instance.controller.getState().saved, palette_id: 'parchment-pine', interaction_overrides: {
      ...api.instance.controller.getState().saved.interaction_overrides,
      item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null,
    } }, document.documentElement);
  });
  const rail = page.locator('.shell-navigation-rail');
  const artist = rail.locator('.artist-link');
  await expect(rail).toHaveCSS('background-color', 'rgb(16, 21, 18)');
  await expect(rail.locator('h2')).toHaveCSS('color', 'rgb(226, 240, 229)');
  await expect(rail.locator('.ui-button')).toHaveCSS('background-color', 'rgb(32, 36, 34)');
  await expect(rail.locator('.ui-button')).toHaveCSS('color', 'rgb(226, 240, 229)');
  await expect(page.locator('.shell-main-surface')).toHaveCSS('background-color', 'rgb(232, 224, 207)');
  await expect(page.locator('.shell-main-surface h2')).toHaveCSS('color', 'rgb(57, 60, 50)');
  const contrast = locator => locator.evaluate(element => {
      const style = getComputedStyle(element);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const color = (...layers) => {
        context.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          context.fillStyle = layer;
          context.fillRect(0, 0, 1, 1);
        }
        return '#' + Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
          .map(channel => channel.toString(16).padStart(2, '0')).join('');
      };
      const background = color(getComputedStyle(element.closest('.shell-navigation-rail')).backgroundColor, style.backgroundColor);
      return window.AlbumHavenAppearance.contrastRatio(color(style.color), background);
  });
  for (const selected of [false, true]) {
    await artist.evaluate((element, active) => element.classList.toggle('is-selected', active), selected);
    await artist.hover();
    await expect(artist).toHaveCSS('color', 'rgb(226, 240, 229)');
    await expect.poll(() => contrast(artist)).toBeGreaterThanOrEqual(4.5);
  }
  const control = rail.locator('.ui-button');
  await control.hover();
  await expect.poll(() => contrast(control)).toBeGreaterThanOrEqual(4.5);
  await page.mouse.down();
  try {
    await expect.poll(() => contrast(control)).toBeGreaterThanOrEqual(4.5);
  } finally {
    await page.mouse.up();
  }
  await page.evaluate(() => {
    const api = window.AlbumHavenAppearance;
    const saved = api.instance.controller.getState().saved;
    api.applyTheme({ ...saved, palette_id: 'parchment-pine', interaction_overrides: {
      ...saved.interaction_overrides, button_hover_background: '#123456', button_pressed: '#234567',
    } }, document.documentElement);
  });
  await control.hover();
  await expect(control).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await page.mouse.down();
  try {
    await expect(control).toHaveCSS('background-color', 'rgb(35, 69, 103)');
  } finally {
    await page.mouse.up();
  }
  await page.mouse.move(0, 0);
  for (const source of ['automatic', 'theme', 'custom']) {
    await page.evaluate(source => {
      const api = window.AlbumHavenAppearance;
      const saved = api.instance.controller.getState().saved;
      api.applyTheme({ ...saved, palette_id: 'parchment-pine', interaction_overrides: {
        ...saved.interaction_overrides,
        item_outline: { source, color: source === 'custom' ? '#ABCDEF' : null },
      } }, document.documentElement);
    }, source);
    await page.keyboard.press('Tab');
    await control.focus();
    await expect(control).toHaveCSS('outline-color', source === 'custom' ? 'rgb(171, 205, 239)' : 'rgb(129, 223, 169)');
    await expect(control).not.toHaveCSS('outline-style', 'none');
  }
  await control.evaluate(element => element.blur());
  const colors = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const rail = getComputedStyle(document.querySelector('.shell-navigation-rail'));
    return {
      main: root.getPropertyValue('--appearance-main-surface').trim(),
      mainInk: root.getPropertyValue('--appearance-ink').trim(),
      railInk: rail.getPropertyValue('--appearance-ink').trim(),
      railMuted: rail.getPropertyValue('--appearance-muted').trim(),
      railLine: rail.getPropertyValue('--appearance-line').trim(),
      railControl: rail.getPropertyValue('--appearance-control').trim(),
      scheme: rail.colorScheme,
    };
  });
  expect(colors).toEqual({
    main: '#E8E0CF', mainInk: '#393C32', railInk: '#E2F0E5',
    railMuted: '#98A79B', railLine: '#354237', railControl: '#202422', scheme: 'dark',
  });
  await page.evaluate(() => {
    const api = window.AlbumHavenAppearance;
    api.applyTheme({ ...api.instance.controller.getState().saved, palette_id: 'paper' }, document.documentElement);
  });
  expect(await page.locator('.shell-navigation-rail').evaluate(rail => {
    const root = getComputedStyle(document.documentElement);
    const style = getComputedStyle(rail);
    return ['ink', 'muted', 'line', 'control'].every(role =>
      style.getPropertyValue('--appearance-' + role).trim() === root.getPropertyValue('--appearance-' + role).trim());
  })).toBe(true);
});


test('Player preview surround matches the Settings page surface in light themes', async ({ page }) => {
  await mount(page, 'mountSeekbar', {
    utilityShell: true,
    saved: { palette_id: 'silver', panel_index: 0 },
  });

  const colors = await page.locator('.player-preview-dock').evaluate((dock) => ({
    page: getComputedStyle(document.querySelector('.utility-modal-body')).backgroundColor,
    dock: getComputedStyle(dock).backgroundColor,
    shield: getComputedStyle(dock, '::before').backgroundColor,
  }));

  expect(colors.dock).toBe(colors.page);
  expect(colors.shield).toBe(colors.page);
});

test('docked player regular style checkbox persists and resets with Appearance', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mount(page, 'mountSeekbar', { utilityShell: true });
  const checkbox = page.getByLabel('Keep regular player style when docked');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();

  let persisted;
  await page.route('**/account/appearance', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    persisted = route.request().postDataJSON();
    return route.fulfill({ json: { ...persisted, revision: persisted.expected_revision + 1, player_recent_sets: [] } });
  });
  await page.locator('[data-background-save]').click();
  expect(persisted.docked_compact_player_regular_style).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-docked-compact-player-regular-style', 'true');

  await page.locator('[data-background-reset]').click();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Floating', exact: true }).click();
  await expect(checkbox).toBeDisabled();
});

test('sidebar Appearance controls preview locally and persist through Save reload Cancel and Reset', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await mount(page, 'mountSeekbar', { utilityShell: true, saved: { palette_id: 'parchment-pine' } });
  const root = page.locator('html');
  const preview = page.locator('[data-player-live-preview]');
  const behavior = value => page.locator('button[data-docked-compact-player-behavior="' + value + '"]');
  const motion = value => page.locator('button[data-compact-player-motion="' + value + '"]');
  const source = value => page.locator('button[data-floating-player-edge-source="' + value + '"]');
  const edge = locator => locator.evaluate(element => getComputedStyle(element).getPropertyValue('--compact-floating-edge-color').trim());
  const savedEdge = await edge(root);
  for (const value of ['follow_sidebar', 'float_on_collapse', 'artbox']) {
    await behavior(value).click();
    await expect(behavior(value)).toHaveAttribute('aria-pressed', 'true');
  }
  await motion('slow').click();
  await expect(preview).toHaveAttribute('data-compact-player-motion', 'slow');
  await expect(root).toHaveAttribute('data-compact-player-motion', 'normal');
  await behavior('float_on_collapse').click();
  await source('theme').click();
  expect(await edge(preview)).toBe('#101512');
  await source('player').click();
  expect(await edge(preview)).toBe(savedEdge);
  await source('custom').click();
  const color = page.getByLabel('Custom floating player edge color', { exact: true });
  await expect(color).toBeEnabled();
  await color.evaluate(input => { input.value = '#345678'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(await edge(preview)).toBe('#345678');
  expect(await edge(root)).toBe(savedEdge);
  await page.locator('[data-background-cancel]').click();
  await expect(motion('normal')).toHaveAttribute('aria-pressed', 'true');
  await expect(behavior('follow_sidebar')).toHaveAttribute('aria-pressed', 'true');
  await expect(source('player')).toHaveAttribute('aria-pressed', 'true');
  expect(await edge(preview)).toBe(savedEdge);

  await behavior('float_on_collapse').click();
  await motion('slow').click();
  await source('custom').click();
  await color.evaluate(input => { input.value = '#345678'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await behavior('artbox').click();
  await expect(source('custom')).toBeDisabled();
  await expect(source('custom')).toHaveAttribute('aria-pressed', 'true');
  let persisted;
  const persistRoute = route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const { expected_revision, applied_player_set, waveform_color_updates, ...preferences } = route.request().postDataJSON();
    persisted = { ...preferences, revision: expected_revision + 1, player_recent_sets: [] };
    return route.fulfill({ json: persisted });
  };
  await page.route('**/account/appearance', persistRoute);
  await page.locator('[data-background-save]').click();
  await expect(root).toHaveAttribute('data-docked-compact-player-behavior', 'artbox');
  await expect(root).toHaveAttribute('data-compact-player-motion', 'slow');
  expect(await edge(root)).toBe('#345678');
  await expect(page.locator('[data-background-save]')).toBeDisabled();
  expect(persisted.floating_player_edge).toEqual({ source: 'custom', color: '#345678' });

  await mount(page, 'mountSeekbar', { utilityShell: true, saved: persisted });
  await page.route('**/account/appearance', persistRoute);
  await expect(behavior('artbox')).toHaveAttribute('aria-pressed', 'true');
  await expect(motion('slow')).toHaveAttribute('aria-pressed', 'true');
  await expect(source('custom')).toHaveAttribute('aria-pressed', 'true');
  expect(await edge(root)).toBe('#345678');
  await page.locator('[data-background-reset]').click();
  await expect(behavior('follow_sidebar')).toHaveAttribute('aria-pressed', 'true');
  await expect(motion('normal')).toHaveAttribute('aria-pressed', 'true');
  await expect(source('player')).toHaveAttribute('aria-pressed', 'true');
  await expect(root).toHaveAttribute('data-compact-player-motion', 'slow');
  expect(await edge(root)).toBe('#345678');
  await page.locator('[data-background-save]').click();
  await expect(root).toHaveAttribute('data-compact-player-motion', 'normal');
  await expect(root).toHaveAttribute('data-docked-compact-player-behavior', 'follow_sidebar');
  expect(await edge(root)).toBe(savedEdge);
});
