const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '../..');
const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
const loaderStart = template.indexOf('<section class="library-loader');
const loaderMarkup = template.slice(
  loaderStart,
  template.indexOf('<div class="albums-scroll"', loaderStart),
).replace(/{%[\s\S]*?%}/g, '');

async function mountStatusComponent(page, status) {
  // Component-only inputs: no production app, API, scanner, or database is replaced.
  await page.setContent(`<!doctype html><html><body>
    <button id="open-status">Open status component</button>
    <main>
      <section data-gallery-bar-instance="gallery" aria-label="Library controls">Retained library</section>
      ${loaderMarkup}
      <div id="albums-scroll">Previously scanned album</div>
    </main>
  </body></html>`);
  for (const file of [
    'app-chrome.css', 'button-component.css',
    'runtime/cover-lookup-drawer-and-related.css', 'runtime/alert-components.css',
  ]) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.evaluate(() => {
    window.appBootstrap = {
      getInitialView: () => ({ album_count: 1, query: '', selected_artist: '' }),
    };
  });
  for (const file of [
    'core-state-and-helpers.js', 'view-value-helpers.js', 'loader-status-helpers.js',
    'markup-format-helpers.js', 'alert-components.js',
  ]) {
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime', file) });
  }
  await page.evaluate((input) => {
    state.status = input;
    renderLibraryLoader(input, { scanPageVisible: false });
    document.getElementById('open-status').addEventListener('click', () => {
      renderLibraryLoader(input, { scanPageVisible: true });
    });
    // The component host owns navigation. Exercise the production mount/unmount
    // functions rather than duplicating their GalleryBar replacement logic.
    document.addEventListener('click', (event) => {
      if (!event.target.closest('[data-close-scan-page]')) return;
      unmountLibraryStatusBar();
      renderLibraryLoader(input, { scanPageVisible: false });
    });
  }, status);
}

test('gallery resize and search updates preserve the Library Status bar', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mountStatusComponent(page, {
    scan_in_progress: false, covers_in_progress: false, relations_in_progress: false,
    scan_outcome: 'failed', scan_total: 10, scan_processed: 4, last_error: 'Scan interrupted',
  });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/gallery-main-interactions.js') });
  await page.evaluate(() => {
    // Supply the retained gallery model; exercise the real chrome and status-bar owners together.
    window.updateGalleryMainControls = () => {};
    window.getFilteredGalleryMainModel = () => ({ totals: { artistCount: 1, albumCount: 1 }, groups: [] });
    window.getGalleryMainContextSections = () => [];
    window.hasGalleryArtistFamily = () => false;
    window.resolveGallerySummaryTotals = (_view, totals) => totals;
    window.resolveGalleryBarContext = () => ({ kind: 'gallery', artistCount: 1, albumCount: 1 });
    window.addEventListener('resize', updateGalleryMainChrome);
  });
  await page.getByRole('button', { name: 'Open status component', exact: true }).click();
  const status = page.getByRole('region', { name: 'Library Status Page controls', exact: true });
  await expect(status).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    state.ui.searchDraftQuery = 'retained search';
    state.view.query = 'retained search';
    syncGalleryBarSearchVisibility();
  });
  await expect(status).toBeVisible();
  await expect(page.locator('[data-close-scan-page]')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const outcome of ['failed', 'cancelled']) {
  test(`Library Status component retains a usable catalog after a ${outcome} scan`, async ({ page }) => {
    const diagnostic = 'Cannot publish <img src=x onerror="window.scanErrorExecuted=true"> & retry';
    await mountStatusComponent(page, {
      scan_in_progress: false,
      covers_in_progress: false,
      relations_in_progress: false,
      scan_outcome: outcome,
      scan_total: 10,
      scan_processed: 4,
      last_error: outcome === 'failed' ? diagnostic : null,
    });
    const galleryBar = page.getByRole('region', { name: 'Library controls', exact: true });
    const retainedBar = await galleryBar.elementHandle();
    const statusBar = page.getByRole('region', { name: 'Library Status Page controls', exact: true });
    await expect(galleryBar).toBeVisible();
    await expect(statusBar).toHaveCount(0);
    await page.getByRole('button', { name: 'Open status component', exact: true }).click();
    await expect(statusBar).toBeVisible();
    await expect(galleryBar).toHaveCount(0);
    await expect(page.locator('#library-loader-title')).toHaveText('Your local library is ready.');
    await expect(page.getByRole('button', { name: /^Cancel (?:Full )?Scan$/ })).toBeHidden();
    await expect(page.locator('[data-scan-stage="discover"]')).toHaveClass(/is-complete/);
    for (const stage of ['metadata', 'covers', 'relations']) {
      await expect(page.locator(`[data-scan-stage="${stage}"]`)).toHaveClass(/is-future/);
    }
    await page.getByRole('button', { name: 'Back to previous library view', exact: true }).click();
    await expect(statusBar).toHaveCount(0);
    await expect(galleryBar).toBeVisible();
    // Read-only identity observation proves restoration, not a lookalike header.
    expect(await retainedBar.evaluate(node => node.isConnected)).toBe(true);
    await retainedBar.dispose();
    await expect(page.locator('#albums-scroll')).toBeVisible();
    await page.getByRole('button', { name: 'Open status component', exact: true }).click();
    const error = page.locator('#library-loader .on-page-alert--error');
    if (outcome === 'failed') {
      // RED until the latest scan failure has durable component presentation.
      await expect(error).toBeVisible();
      await expect(error).toContainText('Last scan error');
      await expect(error).toContainText(diagnostic);
      await expect(error.locator('img')).toHaveCount(0);
      expect(await page.evaluate(() => window.scanErrorExecuted)).toBeUndefined();
      // Explicit component inputs exercise replacement of a previous failure,
      // including a new scan whose status still carries the old diagnostic.
      await page.evaluate(() => {
        state.status = { ...state.status, scan_in_progress: true, scan_outcome: 'running' };
        renderLibraryLoader(state.status, { scanPageVisible: true });
      });
      await expect(error).toHaveCount(0);
      await page.evaluate(() => {
        state.status = { ...state.status, scan_in_progress: false, scan_outcome: 'completed', last_error: null };
        renderLibraryLoader(state.status, { scanPageVisible: true });
      });
      await expect(error).toHaveCount(0);
      await page.evaluate((message) => {
        state.view.album_count = 0;
        state.status = { ...state.status, scan_outcome: 'failed', last_error: message };
        renderLibraryLoader(state.status, { scanPageVisible: true });
      }, diagnostic);
      await expect(error).toBeVisible();
      await expect(error).toContainText(diagnostic);
    } else {
      await expect(error).toHaveCount(0);
    }
  });
}
