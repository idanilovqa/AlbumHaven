// Shared steps of the instant-return browser specs (IAR-W cases): the copy is read from the
// browser's own storage, never from an internal API.
import { expect } from '../support/baseFixtures.js';

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
