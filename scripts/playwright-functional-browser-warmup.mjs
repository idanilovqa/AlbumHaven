import { authenticateProductionContext } from '../tests/e2e/support/performanceAuthentication.js';
import { readStartupRelationProjectionReadiness } from '../tests/e2e/helpers/startupRelationProjectionReadiness.js';

export async function readAuthenticatedStartupRelationProjectionReadiness({
  browser,
  baseURL,
  viewport,
}) {
  const context = await browser.newContext({
    baseURL,
    viewport: viewport || { width: 1440, height: 960 },
  });
  try {
    const page = await context.newPage();
    await authenticateProductionContext(page);
    return await readStartupRelationProjectionReadiness({
      baseURL,
      async fetchFn(url, options) {
        if (options?.method !== 'GET') {
          throw new Error('Startup readiness browser probe only supports GET.');
        }
        const response = await page.goto(url.toString(), { waitUntil: 'commit' });
        if (!response) {
          throw new Error('Startup readiness browser probe received no response.');
        }
        return {
          ok: response.ok(),
          status: response.status(),
          json: () => response.json(),
        };
      },
    });
  } finally {
    await context.close();
  }
}

export async function warmFunctionalBrowser({ browser, baseURL, viewport }) {
  const context = await browser.newContext({
    baseURL,
    viewport: viewport || { width: 1440, height: 960 },
  });
  try {
    const page = await context.newPage();
    await authenticateProductionContext(page);
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
