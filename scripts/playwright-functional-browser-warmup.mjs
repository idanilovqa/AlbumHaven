export async function warmFunctionalBrowser({ browser, baseURL, viewport }) {
  const context = await browser.newContext({
    baseURL,
    viewport: viewport || { width: 1440, height: 960 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/?surface=albums');
    await page.locator('#artist-groups .album-card').first().waitFor({
      state: 'visible',
      timeout: 110000,
    });
    await page.waitForFunction(() => {
      const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
      const refreshFinished = Boolean(metrics.initialRefreshCompleted)
        || Boolean(metrics.marks?.initial_refresh_complete);
      const loader = document.querySelector('#library-loader');
      const loaderHidden = !(loader instanceof HTMLElement) || loader.hidden;
      return refreshFinished && loaderHidden;
    }, null, { timeout: 110000 });
  } finally {
    await context.close();
  }
}
