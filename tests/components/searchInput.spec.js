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
      <html style="--muted: rgb(144, 155, 166); --appearance-line: rgb(82, 97, 115); --appearance-search-focus: #00f; --appearance-interaction-outline: rgb(75, 193, 115); --appearance-accent: rgb(75, 193, 115); --dropdown-item-hover-background: rgb(41, 43, 47);">
        <body>
          <header class="${filter ? 'utility-sidebar' : 'app-bar'}" ${filter ? 'id="utility-modal" style="width:320px"' : ''}>
            <form class="${filter ? 'utility-sidebar-search' : 'toolbar-left'}" onsubmit="event.preventDefault();document.body.dataset.submitted='true'">
              ${filter ? '<div class="utility-search-row utility-problem-filter">' : ''}
              <div class="search-input-wrap search-field">
                <div class="search-field-control ui-input-action">
                  <input
                    type="search"
                    id="search-input"
                    value="transatlantic"
                    aria-label="Search music"
                  >
                  <span class="search-field-action">
                    <button class="search-field-button" type="button" aria-label="Clear search" data-search-clear>Clear</button>
                    <button class="search-field-button" type="submit" aria-label="Search" data-search-submit>Search</button>
                    ${filter ? '<button class="search-field-button utility-problem-filter-button" type="button" aria-label="Filters">Filters</button>' : ''}
                  </span>
                </div>
              </div>
              ${filter ? '</div>' : ''}
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
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/search-input.js') });
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
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeFocused();
    await page.keyboard.press('Tab');
    if (filter) {
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
    }
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
    if (filter) await page.keyboard.press('Shift+Tab');
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

  test(`${actionName}: explicit clear is leftmost, empties the field, and restores input focus`, async ({ page }) => {
    await mountSearchInput(page, filter);
    const input = page.getByRole('searchbox');
    const actions = page.locator('.search-field-action > button');
    await expect(actions).toHaveCount(filter ? 3 : 2);
    await expect(actions.first()).toHaveAttribute('data-search-clear', '');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(page.locator('.search-field-control')).toHaveCSS('outline-style', 'solid');
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeHidden();
  });
}

test('Settings hides Search on desktop, keeps Enter submission, and shows Search on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await mountSearchInput(page, true);
  const input = page.getByRole('searchbox');
  const search = page.getByRole('button', { name: 'Search', exact: true });
  await expect(search).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
  await input.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-submitted', 'true');
  await page.setViewportSize({ width: 720, height: 700 });
  await expect(search).toBeVisible();
});

test('Settings filter dropdown right edge joins its anchor button', async ({ page }) => {
  await mountSearchInput(page, true);
  // Match the non-overlay scrollbar used by the desktop browser.
  await page.addStyleTag({ content: '.utility-problem-filter-menu { scrollbar-gutter: stable; } .utility-problem-filter-menu::-webkit-scrollbar { width: 11px; height: 11px; }' });
  await page.locator('html').evaluate((root) => {
    root.dataset.appearanceMode = 'light';
    root.dataset.appearancePalette = 'fixture';
    root.style.setProperty('--appearance-panel-background', 'rgb(255, 247, 229)');
    root.style.setProperty('--appearance-card', 'rgb(255, 247, 229)');
  });
  await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css/runtime/trigger-anchor.css') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime/trigger-anchor.js') });
  await page.locator('.utility-search-row').evaluate((row) => {
    const menu = document.createElement('div');
    menu.className = 'utility-problem-filter-menu';
    for (let index = 0; index < 20; index += 1) {
      const option = document.createElement('button');
      option.className = 'utility-problem-filter-option';
      option.textContent = `Filter option ${index + 1}`;
      menu.append(option);
    }
    row.append(menu);
    syncTriggerAnchor(menu, row.querySelector('.utility-problem-filter-button'));
  });
  await page.locator('.utility-sidebar').evaluate(element => {
    element.style.transform = 'translateY(0.296875px)';
  });
  const geometry = await page.evaluate(() => {
    const button = document.querySelector('.utility-problem-filter-button').getBoundingClientRect();
    const field = document.querySelector('.search-field').getBoundingClientRect();
    const menu = document.querySelector('.utility-problem-filter-menu').getBoundingClientRect();
    const sidebar = document.querySelector('.utility-sidebar').getBoundingClientRect();
    return {
      buttonRight: button.right,
      fieldLeft: field.left,
      menuLeft: menu.left,
      menuRight: menu.right,
      sidebarRight: sidebar.right,
    };
  });
  expect(geometry.menuLeft).toBeCloseTo(geometry.fieldLeft - 4, 0);
  expect(geometry.menuRight).toBeCloseTo(geometry.buttonRight, 0);
  await expect(page.locator('.utility-problem-filter-menu')).toHaveAttribute('data-trigger-anchor-side', 'right');
  await expect(page.locator('.search-field-control')).toHaveCSS('border-bottom-right-radius', '0px');
  const edgeColors = await page.evaluate(() => {
    const button = document.querySelector('.utility-problem-filter-button');
    const menu = document.querySelector('.utility-problem-filter-menu');
    return {
      connectorLeftColor: getComputedStyle(button, '::after').borderLeftColor,
      connectorRightColor: getComputedStyle(button, '::after').borderRightColor,
      connectorLeft: getComputedStyle(button, '::after').left,
      connectorRight: getComputedStyle(button, '::after').right,
      edgeOverlay: getComputedStyle(menu, '::before').display,
      topEdgeOverlay: getComputedStyle(menu, '::after').display,
      buttonSurface: getComputedStyle(button).getPropertyValue('--trigger-anchor-background').trim(),
      buttonBottomBorder: getComputedStyle(button).borderBottomWidth,
      menuSurface: getComputedStyle(menu).backgroundColor,
      menu: getComputedStyle(menu).borderRightColor,
    };
  });
  expect(edgeColors.connectorRight).toBe(edgeColors.connectorLeft);
  expect(edgeColors.connectorRightColor).toBe(edgeColors.connectorLeftColor);
  expect(edgeColors.edgeOverlay).toBe('none');
  expect(edgeColors.topEdgeOverlay).toBe('none');
  expect(edgeColors.buttonSurface).toBe(edgeColors.menuSurface);
  expect(edgeColors.buttonBottomBorder).toBe('0px');
  expect(await page.locator('.utility-problem-filter-menu').evaluate(menu => menu.scrollWidth <= menu.clientWidth)).toBe(true);
  const screenshot = await page.screenshot();
  const seam = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const button = document.querySelector('.utility-problem-filter-button').getBoundingClientRect();
    const menu = document.querySelector('.utility-problem-filter-menu').getBoundingClientRect();
    const pixel = (y, x = button.left + 6) => [...context.getImageData(Math.floor(x), y, 1, 1).data];
    return {
      panel: pixel(Math.ceil(menu.top + 6)),
      join: Array.from({ length: Math.ceil(menu.top + 3) - Math.floor(button.bottom - 2) },
        (_, index) => pixel(Math.floor(button.bottom - 2) + index)),
      acrossJoin: Array.from({ length: Math.floor(button.width) - 8 },
        (_, index) => pixel(Math.ceil(menu.top), button.left + 4 + index)),
    };
  }, screenshot.toString('base64'));
  for (const pixel of seam.join) expect(pixel).toEqual(seam.panel);
  for (const pixel of seam.acrossJoin) expect(pixel).toEqual(seam.panel);
  const scrollEdge = await page.locator('.utility-problem-filter-menu').evaluate(menu => {
    const before = getComputedStyle(menu).backgroundImage;
    menu.scrollTop = 100;
    return { before, after: getComputedStyle(menu).backgroundImage, scrollTop: menu.scrollTop };
  });
  expect(scrollEdge.scrollTop).toBe(100);
  expect(scrollEdge.after).toBe(scrollEdge.before);
  expect(scrollEdge.after).toContain('210px');
});

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
