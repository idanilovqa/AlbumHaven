const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const baseLayoutCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'base-layout.css',
);
const appChromeCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'app-chrome.css',
);
const searchInputCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'search-input.css',
);
const appearanceCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'appearance-backgrounds.css',
);
const componentUrl = 'http://search-input-component.test/search-input';

async function mountSearchInput(page, filter = false) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html style="--muted: rgb(144, 155, 166); --appearance-search-focus: #00f; --appearance-interaction-outline: rgb(75, 193, 115); --appearance-accent: rgb(75, 193, 115); --dropdown-item-hover-background: rgb(41, 43, 47);">
        <body>
          <header class="${filter ? 'utility-sidebar' : 'app-bar'}" ${filter ? 'id="utility-modal"' : ''}>
            <form class="${filter ? 'utility-sidebar-search' : 'toolbar-left'}" onsubmit="event.preventDefault()">
              <div class="search-input-wrap search-field">
                <div class="search-field-control ui-input-action">
                  <input
                    type="search"
                    id="search-input"
                    value="transatlantic"
                    aria-label="Search music"
                  >
                  <span class="search-field-action">
                    <button class="search-field-button${filter ? ' utility-problem-filter-button' : ''}" type="${filter ? 'button' : 'submit'}" aria-label="${filter ? 'Filters' : 'Search'}">
                      ${filter ? 'Filters' : 'Search'}
                    </button>
                  </span>
                </div>
              </div>
            </form>
          </header>
        </body>
      </html>`,
  }));

  await page.goto(componentUrl);
  await page.addStyleTag({ path: baseLayoutCssPath });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/button-component.css') });
  await page.addStyleTag({ path: appChromeCssPath });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/runtime/utilities.css') });
  await page.addStyleTag({ path: searchInputCssPath });
  await page.addStyleTag({ path: appearanceCssPath });
}

for (const filter of [false, true]) {
  const actionName = filter ? 'Filters' : 'Search';

  test(`${actionName}: typing owns the field cue; keyboard action focus owns only its button`, async ({ page }) => {
    await mountSearchInput(page, filter);
    const input = page.getByRole('searchbox');
    const control = page.locator('.search-field-control');
    const button = page.getByRole('button', { name: actionName, exact: true });
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    expect(await input.evaluate(element => element.matches(':focus-visible'))).toBe(true);
    await expect(input).toHaveCSS('outline-style', 'none');
    await expect(input).toHaveCSS('border-style', 'none');
    await expect(input).toHaveCSS('box-shadow', 'none');
    await expect(control).toHaveCSS('outline-style', 'solid');
    await expect(control).toHaveCSS('outline-width', '1px');
    await expect(control).toHaveCSS('outline-color', 'rgb(144, 155, 166)');
    await expect(control).toHaveCSS('box-shadow', 'none');
    await expect(control).toHaveCSS('outline-offset', '-1px');
    await expect(button).toHaveCSS('outline-style', 'none');
    const idleButtonBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor);

    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).toHaveCSS('outline-width', '2px');
    await expect(button).toHaveCSS('outline-offset', '-3px');
    await expect(button).toHaveCSS('border-style', 'none');
    await expect(button).toHaveCSS('box-shadow', 'none');
    if (filter) {
      await expect(button).toHaveCSS('background-color', 'rgb(41, 43, 47)');
    } else {
      expect(await button.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idleButtonBackground);
    }
    await expect(control).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Shift+Tab');
    await expect(input).toBeFocused();
    await expect(control).toHaveCSS('outline-style', 'solid');
  });

  test(`${actionName}: joined suggestions and open anchors retain their own boundary`, async ({ page }) => {
    await mountSearchInput(page, filter);
    const input = page.getByRole('searchbox');
    const control = page.locator('.search-field-control');
    const button = page.getByRole('button', { name: actionName, exact: true });
    await input.click();
    await input.evaluate(element => element.setAttribute('aria-expanded', 'true'));
    await expect(control).toHaveCSS('outline-style', 'none');
    await input.evaluate(element => element.setAttribute('aria-expanded', 'false'));
    await expect(control).toHaveCSS('outline-style', 'solid');
    await button.evaluate(element => element.classList.add('trigger-anchor-open'));
    await expect(control).toHaveCSS('outline-style', 'none');
  });

  for (const typingFirst of [false, true]) {
    test(`${actionName}: pointer-down has no field glow before click after typing=${typingFirst}`, async ({ page }) => {
      await mountSearchInput(page, filter);
      const input = page.getByRole('searchbox');
      const control = page.locator('.search-field-control');
      const button = page.getByRole('button', { name: actionName, exact: true });
      if (typingFirst) {
        await input.click();
        await input.press('End');
        await input.press('a');
        await expect(control).toHaveCSS('outline-style', 'solid');
      }
      await button.hover();
      await page.mouse.down();
      try {
        await expect(button).toBeFocused();
        await expect(control).toHaveCSS('outline-style', 'none');
        await expect(control).toHaveCSS('box-shadow', 'none');
      } finally {
        await page.mouse.up();
      }
      await expect(control).toHaveCSS('outline-style', 'none');
    });
  }

  test(`${actionName}: native clear keeps input focus and its field cue`, async ({ page }) => {
    await mountSearchInput(page, filter);
    const input = page.getByRole('searchbox');
    const box = await input.boundingBox();
    expect(box).not.toBeNull();
    await input.click({ position: { x: box.width - 13, y: box.height / 2 } });
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(page.locator('.search-field-control')).toHaveCSS('outline-style', 'solid');
  });
}

for (const [name, controlClass, stylesheet, shadow] of [
  ['calendar', 'date-range-picker__control', 'date-range-picker.css', false],
  ['library path', 'library-settings-path-control', 'runtime/utilities.css', false],
  ['account password', 'password-control', 'account.css', true],
  ['admin password', 'password-control', 'admin-members.css', true],
]) {
  test(name + ' shares input, action press, and keyboard focus ownership', async ({ page }) => {
    await page.route(componentUrl, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html style="--border:#456;--accent:#79c;--focus-ring:#79c;--muted:#abc;--blue:#79c"><body class="settings-host"><main class="account-main" id="app-form-modal"><div class="${name === 'calendar' ? 'date-range-picker' : ''}"><div class="${controlClass} ui-input-action"><input aria-label="Field" ${shadow ? 'type="password"' : 'type="text"'}><button type="button" class="${shadow ? '' : 'ui-button action-button'}">Action</button></div></div></main></body></html>` }));
    await page.goto(componentUrl);
    for (const css of ['button-component.css', stylesheet, 'appearance-backgrounds.css']) {
      await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', css) });
    }
    const input = page.getByLabel('Field');
    const button = page.getByRole('button', { name: 'Action' });
    const control = page.locator('.ui-input-action');
    await input.click();
    await expect(control).toHaveCSS('outline-style', 'solid');
    await expect(control).toHaveCSS('outline-width', '1px');
    await expect(control).toHaveCSS('outline-color', name === 'admin password' ? 'rgb(145, 162, 184)' : 'rgb(170, 187, 204)');
    await expect(control).toHaveCSS('outline-offset', '-1px');
    await expect(control).toHaveCSS('box-shadow', 'none');
    await button.hover();
    await page.mouse.down();
    try {
      await expect(control).toHaveCSS('outline-style', 'none');
      await expect(control).toHaveCSS('box-shadow', 'none');
    } finally { await page.mouse.up(); }
    await input.click();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).toHaveCSS('outline-offset', '-3px');
    await expect(control).toHaveCSS('outline-style', 'none');
    await expect(control).toHaveCSS('box-shadow', 'none');
  });
}

test('ordinary entry fields share a muted focus edge across themes and page styles', async ({ page }) => {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <div class="login-field"><input aria-label="Login" type="password"></div>
      <div class="recovery-form"><input aria-label="Email" type="email"></div>
      <input aria-label="Cover" class="cover-lookup-manual-input" type="url">
      <input aria-label="Plain">
      <input aria-label="Search" type="search">
      <input aria-label="Count" type="number">
      <textarea aria-label="Notes"></textarea>
    </body></html>`,
  }));
  await page.goto(componentUrl);
  for (const css of ['button-component.css', 'login.css', 'password-recovery.css', 'runtime/cover-lookup-modal.css', 'appearance-backgrounds.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', css) });
  }
  for (const muted of ['rgb(144, 155, 166)', 'rgb(90, 100, 110)']) {
    await page.locator('html').evaluate((element, color) => element.style.setProperty('--muted', color), muted);
    for (const name of ['Login', 'Email', 'Cover', 'Plain', 'Search', 'Count', 'Notes']) {
      const field = page.getByLabel(name, { exact: true });
      await field.click();
      await expect(field).toBeFocused();
      await expect(field).toHaveCSS('outline-style', 'solid');
      await expect(field).toHaveCSS('outline-width', '1px');
      await expect(field).toHaveCSS('outline-offset', '-1px');
      await expect(field).toHaveCSS('outline-color', muted);
      await expect(field).toHaveCSS('border-color', muted);
      await expect(field).toHaveCSS('box-shadow', 'none');
    }
  }
});
