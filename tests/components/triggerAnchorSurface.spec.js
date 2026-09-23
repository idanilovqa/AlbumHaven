const { test, expect } = require('@playwright/test');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '../..');
const componentUrl = 'http://trigger-anchor-surface.test/';

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
    return panel.getAnimations().flatMap(animation => animation.effect.getKeyframes())
      .filter(frame => frame.clipPath).map(frame => frame.clipPath);
  });
  expect(frames.length).toBeGreaterThan(0);
  for (const clip of frames) expect(clip).toMatch(/^inset\(-1px /);
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
    expect(styles.panelClipPath).toBe('inset(0px -80px -80px)');
  });
}
