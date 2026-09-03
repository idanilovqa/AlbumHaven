import { authenticateProductionContext } from '../tests/e2e/support/performanceAuthentication.js';

const SESSION_COOKIE_NAMES = [
  '__Host-album_haven_session',
  '__Host-album_haven_csrf',
];

// Keep genuine login state in worker memory only. Each consumer receives a copy
// containing authentication cookies, never the login context's application caches.
export function createWorkerAuthentication({
  browser,
  baseURL,
  viewport,
  authenticate = authenticateProductionContext,
}) {
  let storageStatePromise;

  async function captureStorageState() {
    const context = await browser.newContext({
      baseURL,
      viewport: viewport || { width: 1440, height: 960 },
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      try {
        await authenticate(page);
      } catch {
        throw new Error('Production E2E worker authentication failed.');
      }
      const state = await context.storageState();
      const cookies = state.cookies.filter((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name));
      if (!SESSION_COOKIE_NAMES.every((name) => cookies.some((cookie) => cookie.name === name && cookie.value))) {
        throw new Error('Production E2E authentication did not issue the required session cookies.');
      }
      return { cookies, origins: [] };
    } finally {
      await context.close();
    }
  }

  return {
    async getStorageState() {
      // Cache rejection as well as success: a failed prerequisite must surface,
      // rather than repeatedly submitting login for subsequent consumers.
      storageStatePromise ??= captureStorageState();
      return structuredClone(await storageStatePromise);
    },
  };
}
