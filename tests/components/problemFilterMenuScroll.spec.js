const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const componentUrl = 'http://problem-filter-menu.test/settings';
const reasons = Array.from({ length: 24 }, (_, index) => `Problem type ${String(index + 1).padStart(2, '0')}`);

// The Problematic Files filter menu with more reasons than it shows at once; a pick re-renders the
// controls the way the Settings click handler does.
async function mountProblemFilterMenu(page) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html><body style="margin:0;background:#111;color:#eee">
        <div class="utility-search-row utility-problem-filter" style="position:relative;margin:16px;display:flex;justify-content:flex-end">
          <button id="utility-problem-filter-button" class="search-field-button utility-problem-filter-button" type="button" aria-label="Filters">F</button>
          <div id="utility-problem-filter-menu" class="utility-problem-filter-menu" hidden></div>
        </div>
      </body></html>`,
  }));
  await page.goto(componentUrl);
  for (const css of ['css/runtime/base-layout.css', 'css/runtime/utilities.css', 'css/runtime/trigger-anchor.css']) {
    await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static', css) });
  }
  for (const script of ['js/runtime/trigger-anchor.js', 'js/runtime/utility-list-builders.js']) {
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static', script) });
  }
  await page.evaluate((reasonTypes) => {
    window.escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    window.state = { utility: {
      problematicAlbums: [], problematicFilesComplete: true, completeProblemReasonTypes: reasonTypes,
      selectedProblemFilters: [], problemDropdownOpen: true,
    } };
    const els = {
      problemFilterButton: document.getElementById('utility-problem-filter-button'),
      problemFilterMenu: document.getElementById('utility-problem-filter-menu'),
    };
    els.problemFilterMenu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-problem-filter-value]');
      if (!option) return;
      const value = option.getAttribute('data-problem-filter-value');
      const selected = window.state.utility.selectedProblemFilters;
      window.state.utility.selectedProblemFilters = selected.includes(value)
        ? selected.filter(reason => reason !== value)
        : [...selected, value];
      window.state.utility.problemDropdownOpen = true;
      renderProblemFilterControls(els);
    });
    renderProblemFilterControls(els);
  }, reasons);
}

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch, isMobile: device.hasTouch });

    test('ticking and unticking a filter low in the scrolled menu keeps the menu open where it was', async ({ page }) => {
      await mountProblemFilterMenu(page);
      const menu = page.locator('#utility-problem-filter-menu');
      const scroller = menu.locator('.trigger-anchor-scroll');
      const target = menu.locator('[data-problem-filter-value="Problem type 20"]');
      await expect(menu).toBeVisible();
      await target.scrollIntoViewIfNeeded();
      const scrollTop = await scroller.evaluate(element => element.scrollTop);
      expect(scrollTop).toBeGreaterThan(0);
      const before = await target.boundingBox();

      for (const picked of ['true', 'false']) {
        if (device.hasTouch) await target.tap();
        else await target.click();
        await expect(target).toHaveAttribute('aria-selected', picked);
        await expect(menu).toBeVisible();
        expect(await scroller.evaluate(element => element.scrollTop)).toBe(scrollTop);
        const after = await target.boundingBox();
        expect(after.y).toBeCloseTo(before.y, 0);
      }
    });
  });
}
