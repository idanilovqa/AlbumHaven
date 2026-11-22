const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.join(__dirname, '..', '..', 'music_app', 'static');
const componentUrl = 'http://field-warning-component.test/fields';

async function mountFields(page) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html data-appearance-palette="component-test"><head><style>
      :root { --appearance-primary-button: #2563eb; --appearance-ink: #f3f6fa; --appearance-warning: #f59e0b; }
      body { margin: 40px; background: #111827; }
    </style></head><body>
      <label>Album Name<input id="warned" class="ui-field-warning-glow" value="Absolutoin"></label>
      <label>Year<input id="plain" value="2003"></label>
      <button class="button ui-button ui-button--quiet ui-button--medium" id="hollow">No</button>
      <button class="button ui-button ui-button--tonal ui-button--medium" id="tonal">Continue</button>
      <button class="button ui-button ui-button--tonal ui-button--medium" id="tonal-disabled" disabled>Continue</button>
      <button class="button ui-button ui-button--primary ui-button--medium" id="solid">Continue &amp; Unlink</button>
    </body></html>`,
  }));
  await page.goto(componentUrl);
  for (const name of ['runtime/base-layout.css', 'appearance-backgrounds.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', name) });
  }
}

function shadowAt(page, selector, milliseconds) {
  return page.locator(selector).evaluate((element, time) => {
    for (const animation of element.getAnimations()) {
      if (animation.animationName !== 'ui-field-warning-glow') continue;
      animation.pause();
      animation.currentTime = time;
    }
    return getComputedStyle(element).boxShadow;
  }, milliseconds);
}

for (const focused of [false, true]) {
  test(`a warned field pulses from dim to bright while ${focused ? 'focused' : 'unfocused'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mountFields(page);
    if (focused) await page.locator('#warned').focus();
    await expect(page.locator('#warned')).toHaveCSS('border-color', 'rgb(245, 158, 11)');
    expect(await shadowAt(page, '#warned', 0)).toMatch(/ 4px 1px/);
    expect(await shadowAt(page, '#warned', 800)).toMatch(/ 22px 3px/);
  });
}

test('reduced motion keeps a still glow of medium strength', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mountFields(page);
  await expect(page.locator('#warned')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#warned')).toHaveCSS('box-shadow', / 12px 2px/);
});

test('a field without a warning keeps its plain focus edge', async ({ page }) => {
  await mountFields(page);
  await page.locator('#plain').focus();
  await expect(page.locator('#plain')).toHaveCSS('box-shadow', 'none');
});

test('tonal sits between hollow and solid and looks disabled when it is', async ({ page }) => {
  await mountFields(page);
  const background = (selector) => page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
  const [hollow, tonal, solid] = await Promise.all(['#hollow', '#tonal', '#solid'].map(background));
  expect(hollow).toBe('rgba(0, 0, 0, 0)');
  expect(tonal).toMatch(/0\.18\)$/);
  expect(solid).toBe('rgb(37, 99, 235)');
  await expect(page.locator('#tonal-disabled')).toHaveCSS('opacity', '0.38');
});
