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
    <main id="editor"></main>${options.sharedFooter ? '<footer id="utility-modal-footer"></footer>' : ''}<section class="global-player"><button class="player-play">Play</button><span class="player-loop-handle"></span></section>
  </body></html>` }));
  await page.route('**/account/appearance', route => route.fulfill({ json: { ...saved, csrf_token: 'owned-component-token' } }));
  await page.goto(appearanceUrl);
  for (const file of ['button-component.css', 'appearance-backgrounds.css']) await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  for (const file of ['button-component.js', 'editor-page.js', 'appearance-palettes.js', 'appearance-backgrounds.js']) await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
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
      const tokens = api.resolveAppearance(api.instance.controller.getState().draft).tokens;
      const toRgb = value => { const probe = document.createElement('span'); probe.style.backgroundColor = value; document.body.append(probe); const result = getComputedStyle(probe).backgroundColor; probe.remove(); return result; };
      return { hover: toRgb(tokens.hover), control: toRgb(tokens.control) };
    });
    for (const [index, state] of selectors.entries()) await expect(page.locator(`[data-preview-state="${state}"]`)).toHaveCSS('background-color', index < 2 ? effective.hover : effective.control);
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
    await expect(page.locator('#utility-modal-footer [data-background-cancel]')).toHaveCSS('background-color', expected.control);
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