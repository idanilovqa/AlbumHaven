// Shared steps of the instant-return browser specs (IAR-W cases): the copy is read from the
// browser's own storage, never from an internal API.
import { expect } from '../support/baseFixtures.js';

export const LIBRARY_PATH = '/?surface=albums';
export const OFFLINE_NOTICE = '#app-copy-offline-notice';
export const COPY_MARKER = 'meta[name="album-haven-app-copy"]';

async function workerReady(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active.scriptURL.endsWith('/app-copy-worker.js?mode=web')) {
      throw new Error(`unexpected worker ${registration.active.scriptURL}`);
    }
  });
}

// The page names in the copy, read from the browser's own storage.
export async function keptPages(page) {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('album-haven-app-copy-'));
    const pages = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.pathname === '/') pages.push({ key: `${url.pathname}${url.search}`, html: await (await cache.match(request)).text() });
      }
    }
    return pages;
  });
}

// Opens the library twice (the first visit installs the worker, the second is kept as the
// worker passes it on) and waits until the copy holds the library page.
export async function primeCopy(page, galleryActions) {
  await galleryActions.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await workerReady(page);
  await galleryActions.goto(LIBRARY_PATH);
  await galleryActions.waitForGalleryReady();
  await expect(page.locator(COPY_MARKER)).toHaveAttribute('content', 'network');
  await expect.poll(async () => (await keptPages(page)).map(kept => kept.key)).toContain(LIBRARY_PATH);
}

// The album titles inside the window, as the gallery POM finds them.
export async function visibleAlbumNames(galleryPage) {
  return galleryPage.albumCard.visibleTitles.evaluateAll(titles => titles
    .filter((title) => {
      const box = title.getBoundingClientRect();
      return box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
    })
    .map(title => title.textContent.trim()));
}
