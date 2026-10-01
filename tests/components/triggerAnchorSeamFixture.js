const path = require('node:path');
const { expect } = require('@playwright/test');
const { renderActionButton } = require('../../music_app/static/js/button-component.js');

const root = path.resolve(__dirname, '../..');

async function mountMobileRowMenu(page, { above, dark }) {
  const trigger = renderActionButton({
    ariaLabel: 'Actions for fixture user', icon: 'more',
    attributes: { 'aria-expanded': 'false', 'aria-haspopup': 'menu',
      'data-account-menu-trigger': true, 'data-member-menu-trigger': 'fixture' },
  });
  await page.setContent(`<!doctype html><html data-appearance-mode="${dark ? 'dark' : 'light'}">
    <meta name="viewport" content="width=device-width, initial-scale=1"><body>
    <main class="settings-host" data-settings-host><div class="settings-outlet">
      <section data-admin-roster><div class="member-actions" data-account-menu-component>
        ${trigger}
        <div class="gallery-anchored-menu member-actions-menu" role="menu" hidden
          data-account-menu data-member-menu="fixture">
          <a class="button ui-button ui-button--secondary ui-button--medium gallery-menu-action"
            role="menuitem" href="#fixture"><span class="ui-button__content">Edit</span></a>
        </div>
      </div></section>
    </div></main></body></html>`);
  for (const name of ['admin-members.css', 'gallery-main.css', 'runtime/trigger-anchor.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', name) });
  }
  // Component inputs: fractional coordinates and a viewport-clamped menu recreate
  // the narrow roster. Production code owns disclosure, placement and painting.
  await page.addStyleTag({ content: `
    :root { --appearance-card: ${dark ? '#18232f' : '#fff7e5'};
      --appearance-ink: ${dark ? '#eeeeee' : '#383e33'}; --appearance-line: #aaa;
      --trigger-anchor-cap: #008060; --appearance-selected-accent: #008060; --appearance-accent: #008060;
      --appearance-interaction-outline: #008060; --appearance-play: #008060;
      --panel: ${dark ? '#18232f' : '#fff7e5'}; --border: #aaa; }
    /* Exclude the browser-only transient tap tint from component paint evidence. */
    body { margin: 0; -webkit-tap-highlight-color: transparent; }
    .settings-outlet { position: absolute; left: 6px; top: 30.296875px;
      width: 400px; height: 680px; padding: 18px; background: ${dark ? '#293441' : '#e8e1ce'}; }
    .member-actions { width: 173.296875px; margin-top: ${above ? '600' : '240'}px; }
  ` });
  for (const name of ['runtime/trigger-anchor.js', 'runtime/account-menu.js', 'admin-members.js']) {
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js', name) });
  }
  await page.evaluate(() => { window.AlbumHavenMountAdmin(document); });
  await page.getByRole('button', { name: 'Actions for fixture user' }).tap();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveAttribute('data-trigger-anchor-edge', above ? 'bottom' : 'top');
}

async function readJoinPixels(page) {
  const imageBytes = await page.screenshot({ animations: 'disabled' });
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const anchor = document.querySelector('[data-account-menu-trigger]').getBoundingClientRect();
    const menu = document.querySelector('[data-account-menu]').getBoundingClientRect();
    const scale = devicePixelRatio;
    const above = menu.bottom <= anchor.top;
    const innerY = Math.floor((above ? anchor.top + 6 : anchor.bottom - 6) * scale);
    const gapY = Math.floor((above ? (menu.bottom + anchor.top) : (anchor.bottom + menu.top)) * scale / 2);
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    const row = (x, y) => Array.from({ length: Math.ceil(6 * scale) }, (_, i) => pixel(Math.floor(x * scale) - 1 + i, y));
    const joinStart = Math.floor((above ? menu.bottom - 2 : anchor.bottom - 2) * scale);
    const joinEnd = Math.ceil((above ? anchor.top + 2 : menu.top + 2) * scale);
    const centerX = Math.floor((anchor.left + anchor.width / 2) * scale);
    return {
      leftButton: row(anchor.left, innerY), leftGap: row(anchor.left, gapY),
      rightButton: row(anchor.right - 4, innerY), rightGap: row(anchor.right - 4, gapY),
      fill: pixel(centerX, Math.floor((above ? menu.bottom - 6 : menu.top + 6) * scale)),
      join: Array.from({ length: joinEnd - joinStart }, (_, i) => pixel(centerX, joinStart + i)),
    };
  }, imageBytes.toString('base64'));
}

async function assertMobileRowMenuContinuity(browser) {
  for (const deviceScaleFactor of [1.25, 1.75, 2.625]) {
    // Native scaling also exercises device-rounded CSS border widths; context
    // emulation alone changes image density but misses the reported edge step.
    const executablePath = String(process.env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim();
    const nativeBrowser = await browser.browserType().launch({
      headless: true,
      ...(executablePath ? { executablePath } : { channel: 'chrome' }),
      args: [`--force-device-scale-factor=${deviceScaleFactor}`],
    });
    try {
      const context = await nativeBrowser.newContext({ viewport: { width: 412, height: 830 },
        deviceScaleFactor, isMobile: true, hasTouch: true });
      for (const dark of [false, true]) for (const above of [false, true]) {
        const page = await context.newPage();
        try {
          await mountMobileRowMenu(page, { above, dark });
          const pixels = await readJoinPixels(page);
          const label = `scale=${deviceScaleFactor}, dark=${dark}, above=${above}`;
          expect(pixels.leftGap, `left edge continuity: ${label}`).toEqual(pixels.leftButton);
          expect(pixels.rightGap, `right edge continuity: ${label}`).toEqual(pixels.rightButton);
          expect(pixels.join, `no horizontal seam: ${label}`).toEqual(pixels.join.map(() => pixels.fill));
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toBeHidden();
          await expect(page.getByRole('button', { name: 'Actions for fixture user' })).toBeFocused();
        } finally { await page.close(); }
      }
    } finally { await nativeBrowser.close(); }
  }
}

module.exports = { assertMobileRowMenuContinuity };
