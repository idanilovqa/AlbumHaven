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

async function mountSearchInput(page) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html style="--appearance-interaction-outline: rgb(75, 193, 115); --appearance-accent: rgb(75, 193, 115);">
        <body>
          <header class="app-bar">
            <form class="toolbar-left">
              <div class="search-input-wrap search-field">
                <div class="search-field-control">
                  <input
                    type="search"
                    id="search-input"
                    value="transatlantic"
                    aria-label="Search music"
                  >
                  <span class="search-field-action">
                    <button class="search-field-button" type="submit" aria-label="Search">
                      Search
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
  await page.addStyleTag({ path: appChromeCssPath });
  await page.addStyleTag({ path: searchInputCssPath });
  await page.addStyleTag({ path: appearanceCssPath });
}

test('focused search input uses one outline around the shared field boundary', async ({ page }) => {
  await mountSearchInput(page);

  const input = page.getByRole('searchbox', { name: 'Search music' });
  const control = page.locator('.search-field-control');
  const searchButton = page.getByRole('button', { name: 'Search', exact: true });

  await page.keyboard.press('Tab');

  await expect(input).toBeFocused();
  expect(await input.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(input).toHaveCSS('border-style', 'none');
  await expect(input).toHaveCSS('box-shadow', 'none');
  await expect(control).toHaveCSS('outline-style', 'solid');
  await expect(control).toHaveCSS('outline-width', '2px');
  await expect(control).toHaveCSS('outline-offset', '2px');
  await expect(searchButton).toHaveCSS('outline-style', 'none');

  const idleButtonBackground = await searchButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.keyboard.press('Tab');

  await expect(searchButton).toBeFocused();
  await expect(searchButton).toHaveCSS('outline-style', 'none');
  await expect(searchButton).toHaveCSS('border-style', 'none');
  await expect(searchButton).toHaveCSS('box-shadow', 'none');
  await expect(control).toHaveCSS('outline-style', 'solid');
  await expect(control).toHaveCSS('outline-width', '2px');
  expect(await searchButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).not.toBe(idleButtonBackground);
});
