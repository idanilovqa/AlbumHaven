// Shared steps of the instant-return browser specs (IAR-W cases): the copy is read from the
// browser's own storage, never from an internal API.
import { expect } from '../support/baseFixtures.js';
import { coverLookupFixtureEndpoint, readJsonResponse } from './coverLookupProviderHelpers.js';

export const LIBRARY_PATH = '/?surface=albums';

export async function workerReady(page) {
  // parity-check: allow-read-only-measurement-evaluate: reads which worker controls the origin.
  const scriptURL = await page.evaluate(async () => (await navigator.serviceWorker.ready).active.scriptURL);
  expect(scriptURL).toMatch(/\/app-copy-worker\.js\?mode=web$/);
}

// The pages in the copy, read from the browser's own storage.
export async function keptPages(page) {
  // parity-check: allow-read-only-measurement-evaluate: lists the copy's pages without changing the storage.
  return page.evaluate(async () => {
    const pages = [];
    for (const name of (await caches.keys()).filter(key => key.startsWith('album-haven-app-copy-'))) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.pathname === '/') pages.push({ key: `${url.pathname}${url.search}`, html: await (await cache.match(request)).text() });
      }
    }
    return pages;
  });
}

// Opens the library twice (the first visit installs the worker, the second is kept as the worker
// passes it on) and waits until the copy holds the library page.
export async function primeCopy(page, galleryActions) {
  await galleryActions.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await workerReady(page);
  await galleryActions.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await expect(galleryActions.galleryPage.appCopyMarker).toHaveAttribute('content', 'network');
  await expect.poll(async () => (await keptPages(page)).map(kept => kept.key)).toContain(LIBRARY_PATH);
}

// A slow but working connection for the page and the copy's worker: Chrome's own network
// throttling, so every request still reaches the real server unchanged. Throttling the page alone
// does not reach the worker's requests, so its target is throttled too. Returns the undo.
export async function slowConnection(page, latency) {
  const conditions = ms => ({ offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });
  const pageSession = await page.context().newCDPSession(page);
  const browserSession = await page.context().browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const worker = targetInfos.find(info => info.type === 'service_worker' && info.url.includes('/app-copy-worker.js'));
  expect(worker, 'the copy worker runs').toBeTruthy();
  // Chrome answers commands for an attached target as events on the browser session.
  const replies = new Map();
  browserSession.on('Target.receivedMessageFromTarget', ({ message }) => {
    const reply = JSON.parse(message);
    replies.get(reply.id)?.(reply);
  });
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
  let lastId = 0;
  const sendToWorker = (method, params) => new Promise((resolve) => {
    lastId += 1;
    replies.set(lastId, resolve);
    void browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: lastId, method, params }) });
  });
  const apply = async (ms) => {
    await pageSession.send('Network.emulateNetworkConditions', conditions(ms));
    const reply = await sendToWorker('Network.emulateNetworkConditions', conditions(ms));
    expect(reply.error, 'the worker accepts the throttling').toBeUndefined();
  };
  await pageSession.send('Network.enable');
  await sendToWorker('Network.enable', {});
  await apply(latency);
  return async () => {
    await apply(0);
    await pageSession.detach();
    await browserSession.detach();
  };
}

// The /static/ paths the copy keeps, read from the browser's own storage.
export async function keptStaticPaths(page) {
  // parity-check: allow-read-only-measurement-evaluate: lists the copy's static files without changing the storage.
  return page.evaluate(async () => {
    const paths = [];
    for (const name of (await caches.keys()).filter(key => key.startsWith('album-haven-app-copy-'))) {
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/static/')) paths.push(url.pathname);
      }
    }
    return paths;
  });
}

// On the fixture-owned app process: 'hold' or 'release' the app page and the copy's account check,
// as a tunnel holds requests for its stopped server (FTC-IAR-W14); 'down' answers every request but
// static files with a gateway's 502, as a tunnel does for its stopped server, and 'up' ends that
// (FTC-IAR-W16).
export async function setAppPageHold(testInfo, action) {
  const response = await fetch(coverLookupFixtureEndpoint(testInfo, '/app-page-fixture/control'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  });
  return readJsonResponse(response, `App page ${action}`);
}

// Same-origin /static/ requests of [page] that fail from now on, by path.
export function failedStaticRequests(page) {
  const failed = [];
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/static/')) failed.push(url.pathname);
  });
  return failed;
}

// The album titles inside the window, as the gallery POM finds them.
export async function visibleAlbumNames(galleryPage) {
  // parity-check: allow-read-only-measurement-evaluate: reads which album titles are inside the window.
  return galleryPage.albumCard.visibleTitles.evaluateAll(titles => titles
    .filter((title) => {
      const box = title.getBoundingClientRect();
      return box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
    })
    .map(title => title.textContent.trim()));
}

// The album keys whose details [page] asks the server for from now on, counted when each request
// starts (a click or the gallery's prewarm of visible albums), whether or not it is answered.
export function requestedAlbumKeys(page) {
  const keys = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    const key = url.pathname === '/album-details' ? url.searchParams.get('album_key') : null;
    if (key) keys.add(key);
  });
  return keys;
}

// The first album inside the window whose details were never asked for, so nothing keeps them.
export async function albumNeverRequested(galleryActions, requested) {
  for (const name of await visibleAlbumNames(galleryActions.galleryPage)) {
    if (name && !requested.has(await galleryActions.readAlbumKeyByName(name))) return name;
  }
  throw new Error('every album in the window had its details asked for');
}

// The library data kept on the device, by address, read from the browser's own storage.
export async function keptDataKeys(page) {
  // parity-check: allow-read-only-measurement-evaluate: lists the copy's data entries without changing the storage.
  return page.evaluate(async () => {
    const keys = [];
    for (const name of (await caches.keys()).filter(key => key.startsWith('album-haven-app-copy-'))) {
      for (const request of await (await caches.open(name)).keys()) {
        const url = new URL(request.url);
        if (['/view-data', '/album-details', '/home-data'].includes(url.pathname)) keys.push(`${url.pathname}${url.search}`);
      }
    }
    return keys;
  });
}

// Scrolls the gallery down, as a person does, until [artist]'s heading is rendered.
export async function scrollToArtistHeading(galleryActions, artist, { timeout = 45_000 } = {}) {
  await expect.poll(async () => {
    if ((await galleryActions.readArtistHeadings()).some(heading => heading.trim() === artist)) return true;
    await galleryActions.scrollGalleryBy(900);
    return false;
  }, { timeout, intervals: [300] }).toBe(true);
}
