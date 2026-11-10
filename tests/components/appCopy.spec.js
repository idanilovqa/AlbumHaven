// The Android app's copy of the last view in a real browser: the shipped service worker and page
// client on a real origin, with a small server standing in for Album Haven and a fake shell port.
// IAR-001 (a start from the copy), IAR-005 (offline read-only and recovery without a reload),
// IAR-006 (signed out deletes the copy) and IAR-007 (the seven-day limit).
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const client = fs.readFileSync(path.join(root, 'music_app/static/js/app-copy.js'));
const worker = fs.readFileSync(path.join(root, 'music_app/static/js/app-copy-worker.js'));

function startServer() {
  const server = { renders: 0, signedIn: true, account: 'acct-a' };
  server.http = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      if (!server.signedIn) {
        response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      server.renders += 1;
      const copy = request.headers['x-album-haven-app-copy'] === '1';
      const marker = copy ? `<meta name="album-haven-app-copy" content="network" data-account="${server.account}">` : '';
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(copy
          ? { 'Cache-Control': 'private, no-cache', 'X-Album-Haven-App-Copy': server.account, 'X-Album-Haven-Asset-Version': 't1' }
          : { 'Cache-Control': 'no-store, max-age=0' }),
      });
      response.end(`<!doctype html><html><head>${marker}<script src="/static/js/app-copy.js?v=t1"></script></head>
        <body><h1 data-render>Render ${server.renders}</h1>
        <section id="app-copy-offline-notice" class="on-page-alert" role="status" hidden>Offline</section></body></html>`);
      return;
    }
    if (url.pathname === '/static/js/app-copy.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=31536000, immutable' });
      response.end(client);
      return;
    }
    if (url.pathname === '/app-copy-worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      response.end(worker);
      return;
    }
    if (url.pathname === '/app-copy/account') {
      response.writeHead(server.signedIn ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(server.signedIn ? { account: server.account } : { detail: 'Authentication required.' }));
      return;
    }
    if (url.pathname === '/login') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><title>Sign in</title><form aria-label="Album Haven sign in"><label>Username <input></label></form>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.http.listen(0, '127.0.0.1', () => {
      server.origin = `http://localhost:${server.http.address().port}`;
      resolve(server);
    });
  });
}

const renderHeading = page => page.locator('[data-render]');

// The runtime's bridge client calls adoptShell after its handshake; this stands in for it.
async function adoptShell(page) {
  await page.evaluate(async () => {
    window.reports = [];
    window.AlbumHavenAppCopy.adoptShell({ forget: false }, { report: async (stored) => { window.reports.push(stored); } });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function copyCount(page) {
  return page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('album-haven-app-copy-v1:')).length);
}

test.describe('app copy service worker', () => {
  let server;
  test.beforeEach(async () => { server = await startServer(); });
  test.afterEach(async () => {
    server.http.closeAllConnections();
    await new Promise(resolve => server.http.close(resolve));
  });

  test('IAR-001: once kept, a start shows the copy at once without asking the server for the page', async ({ page }) => {
    await page.goto(`${server.origin}/`);
    await adoptShell(page);
    // The first page under the worker is fetched as a copy request and kept.
    await page.reload();
    await expect(renderHeading(page)).toHaveText('Render 2');
    expect(await copyCount(page)).toBe(1);

    await page.reload();
    await expect(renderHeading(page)).toHaveText('Render 2');
    expect(server.renders).toBe(2);
    await expect(page.locator('meta[name="album-haven-app-copy"]')).toHaveAttribute('content', 'cache');
    await expect(page.locator('#app-copy-offline-notice')).toBeHidden();
  });

  test('IAR-005: offline, the copy is read-only with its notice, and recovers without a reload', async ({ page, context }) => {
    await page.goto(`${server.origin}/`);
    await adoptShell(page);
    await page.reload();
    await context.setOffline(true);

    await page.reload();
    await expect(renderHeading(page)).toHaveText('Render 2');
    await expect(page.locator('#app-copy-offline-notice')).toBeVisible();
    expect(await page.evaluate(() => window.AlbumHavenAppCopy.isReadOnly())).toBe(true);

    const navigations = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await context.setOffline(false);
    await expect(page.locator('#app-copy-offline-notice')).toBeHidden({ timeout: 15000 });
    expect(await page.evaluate(() => window.AlbumHavenAppCopy.isReadOnly())).toBe(false);
    await expect(renderHeading(page)).toHaveText('Render 2');
    expect(navigations).toEqual([]);
  });

  test('IAR-006: a copy whose session ended is deleted and the sign-in page replaces it', async ({ page }) => {
    await page.goto(`${server.origin}/`);
    await adoptShell(page);
    await page.reload();
    server.signedIn = false;

    await page.reload();
    await expect(page.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(await copyCount(page)).toBe(0);
  });

  test('IAR-006: another account\'s copy is never left on screen', async ({ page }) => {
    await page.goto(`${server.origin}/`);
    await adoptShell(page);
    await page.reload();
    server.account = 'acct-b';

    await page.reload();
    await expect(renderHeading(page)).toHaveText('Render 3');
    await expect(page.locator('meta[name="album-haven-app-copy"]')).toHaveAttribute('data-account', 'acct-b');
    expect(await page.evaluate(async () => caches.keys())).toEqual(['album-haven-app-copy-v1:acct-b']);
  });

  test('IAR-007: a copy older than seven days is not shown', async ({ page }) => {
    await page.goto(`${server.origin}/`);
    await adoptShell(page);
    await page.reload();
    // allow-read-only-measurement-evaluate: ages the kept copy's record by eight days.
    await page.evaluate(async () => {
      const cache = await caches.open('album-haven-app-copy-v1:acct-a');
      const metaUrl = new URL('/__app-copy__/meta', location.origin).href;
      const meta = await (await cache.match(metaUrl)).json();
      for (const kept of Object.values(meta.pages)) kept.savedAt -= 8 * 24 * 60 * 60 * 1000;
      await cache.put(metaUrl, new Response(JSON.stringify(meta)));
    });

    await page.reload();
    await expect(renderHeading(page)).toHaveText('Render 3');
    await expect(page.locator('meta[name="album-haven-app-copy"]')).toHaveAttribute('content', 'network');
  });
});
