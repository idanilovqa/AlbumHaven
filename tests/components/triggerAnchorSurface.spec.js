const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('node:fs');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');
const { applyFixtureAppearance } = require('./appearanceFixture.js');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://trigger-anchor-surface.test/';

async function mountVisualAnchor(page, name) {
  const template = file => fs.readFileSync(path.join(repositoryRoot, 'music_app/templates', file), 'utf8');
  const accountTemplate = template('partials/account-menu.html');
  const albumTrigger = template('index.html').match(/<button class="gallery-action-button"[^>]*data-gallery-bar-action="album-types"[\s\S]*?<\/button>/)[0];
  const settingsIcon = accountTemplate.match(/<svg[\s\S]*?<\/svg>/)[0];
  const filterIcon = template('partials/search-input.html').match(/<svg[\s\S]*?<\/svg>/)[0];
  const trigger = name === 'Album Types' ? albumTrigger
    : name === 'Settings' ? renderActionButton({ ariaLabel: 'Settings' }).replace(/<span class="action-button__icon" aria-hidden="true"><\/span>/, settingsIcon)
      : `<button class="search-field-button utility-problem-filter-button" type="button" aria-label="Period">${filterIcon}</button>`;
  const panelClass = name === 'Album Types' ? 'gallery-anchored-menu'
    : name === 'Settings' ? 'account-menu' : 'confirm-modal-dialog';
  const content = name === 'Album Types'
    ? ['Studio', 'EP', 'Live', 'Compilation'].map(label => `<button class="gallery-type-choice" type="button" aria-pressed="true"><span aria-hidden="true">✓</span>${label}</button>`).join('')
    : name === 'Settings' ? accountTemplate.match(/<button class="account-menu-item"[\s\S]*?<\/button>/)[0]
      : '<h2 class="confirm-modal-title">Date range</h2><div id="date-content"></div>';
  await page.setContent(`<!doctype html><html><body>
    <div class="${name === 'Settings' ? 'app-bar' : 'shell-main-surface'} anchor-host">${trigger}</div>
    ${name === 'Log History Period' ? '<div id="app-form-modal" class="app-form-anchored">' : ''}
    <div id="surface" class="${panelClass}" data-anchored-surface="fixture">${content}</div>
    ${name === 'Log History Period' ? '</div>' : ''}</body></html>`);
  for (const stylesheet of ['runtime/base-layout.css', 'runtime/account-menu.css', 'runtime/utilities.css',
    'app-chrome.css', 'gallery-main.css', 'runtime/trigger-anchor.css', 'appearance-backgrounds.css',
    'button-component.css', 'date-range-picker.css', 'search-input.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', stylesheet) });
  }
  await applyFixtureAppearance(page, { palette_id: 'paper', panel_index: 0 });
  await page.addStyleTag({ content: `
    .anchor-host { position: fixed; left: 40px; top: 20px; padding: 0; width: auto; height: auto; }
    #surface { position: fixed; left: 40px; right: auto; top: 60px; width: 320px; }
  ` });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/button-component.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/date-range-picker.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const dates = document.getElementById('date-content');
    if (dates) dates.innerHTML = buildDateRangePicker({ fromDate: '2026-09-01', toDate: '2026-09-23' });
    const anchor = document.querySelector('.anchor-host button');
    anchor.setAttribute('aria-expanded', 'true');
    syncTriggerAnchor(document.getElementById('surface'), anchor);
  });
  await page.locator('.anchor-host button').hover();
  if (name === 'Log History Period') {
    for (const selector of ['body', '.confirm-modal-title', '.date-range-picker__field > span']) {
      await expect(page.locator(selector).first()).toHaveCSS('font-family', /system-ui/);
    }
  }
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
});

test('a dropdown extending both sides has mirrored left and right joins', async ({ page }) => {
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
    await page.addStyleTag({ content: `
      body { margin: 0; }
      .anchor-host { position: fixed; left: 40px; top: 20px; }
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
        anchorBackgroundImage: anchor.backgroundImage,
        anchorSurface: anchor.getPropertyValue('--trigger-anchor-background').trim(),
        bottomBorder: anchor.borderBottomWidth,
        edgeFadeBackground: getComputedStyle(surfaceElement, '::before').backgroundImage,
        panelAnimation: surface.animationName,
        panelClipPath: surface.clipPath,
        panelSurface: surface.backgroundColor,
      };
    });

    expect(styles.anchorSurface).toBe(styles.panelSurface);
    expect(styles.anchorBackgroundImage).toContain(styles.panelSurface);
    expect(styles.bottomBorder).toBe('0px');
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
        button: pixel(anchor.left + 6, anchor.bottom - 6),
        bridge: pixel(anchor.left + 6, panel.top - 2),
        join: pixel(anchor.left + 6, panel.top + 1),
        panel: pixel(panel.left + 6, panel.top + 60),
      };
    }, screenshot.toString('base64'));
    expect(pixels.button).toEqual(pixels.panel);
    expect(pixels.bridge).toEqual(pixels.panel);
    expect(pixels.join).toEqual(pixels.panel);
    if (['Album Types', 'Settings', 'Log History Period'].includes(name)) {
      await mountVisualAnchor(page, name);
      // Capture both the hovered trigger and its joined panel across the content,
      // application chrome and date-picker surfaces, including the border glow.
      await expect(page).toHaveScreenshot(`anchor-${name.toLowerCase().replaceAll(' ', '-')}.png`, {
        animations: 'disabled', clip: { x: 20, y: 0, width: 380, height: 360 },
      });
    }
    expect(styles.panelClipPath).toBe('inset(0px -80px -80px)');
  });
}
