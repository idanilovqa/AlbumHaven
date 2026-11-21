const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const origin = 'http://album-details-front-cover.test';
// A 2x2 opaque PNG: every cover answers with real, decodable bytes.
const coverPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

async function mountAlbumDetails(page) {
  await page.setViewportSize({ width: 1100, height: 800 });
  // Anything the runtime asks for besides the page and its covers (live events, settings) is simply absent.
  await page.route(`${origin}/**`, (route) => route.fulfill({ status: 404, body: '' }));
  await page.route(`${origin}/`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head></head><body>
      <div id="albums-scroll"><div id="albums-spacer-top"></div><div id="artist-groups"></div><div id="albums-spacer-bottom"></div></div>
      <div class="track-modal" id="track-modal" hidden>
        <div class="track-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="track-modal-title">
          <div class="track-modal-header">
            <div class="track-modal-title-wrap"><h3 id="track-modal-title">Album</h3><div class="track-modal-subtitle" id="track-modal-subtitle"></div></div>
          </div>
          <div class="track-modal-tabs" id="track-modal-tabs" hidden></div>
          <div class="track-modal-body">
            <div class="track-modal-cover" id="track-modal-cover"></div>
            <div class="track-modal-main">
              <div class="track-modal-missing-warning" id="track-modal-missing-warning" hidden></div>
              <div class="track-modal-duplicate-warning" id="track-modal-duplicate-warning" hidden></div>
              <div class="track-modal-duplicate-tabs" id="track-modal-duplicate-tabs" hidden></div>
              <div class="track-modal-list" id="track-modal-list"></div>
              <div class="track-modal-footer" id="track-modal-footer"></div>
            </div>
          </div>
        </div>
      </div>
    </body></html>`,
  }));
  await page.goto(`${origin}/`);
}

// The front cover the owner saw as an empty box (2026-11-18, 2026-11-21): the details answer, already cached, arrived
// while the loading shell's card cover was still downloading, and Album Details reused that image unfinished.
async function loadRuntime(page) {
  for (const css of [
    'css/button-component.css',
    'css/runtime/base-layout.css',
    'css/runtime/album-artbox-and-gallery-card.css',
    'css/runtime/album-details-components.css',
    'css/runtime/track-modal-and-lightbox.css',
    'css/runtime/cover-lookup-modal.css',
  ]) await page.addStyleTag({ path: path.join(staticRoot, css) });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
  // The real runtime bundle: its start-up needs only the gallery scroller above; its later requests get 404s.
  await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime-bundle.js') });
}

const selectedCovers = ['first', 'second', 'third'].map((name) => ({
  selectionId: `selection-${name}`,
  kind: 'local',
  imageUrl: `/cover/selected-${name}`,
}));
const cardAlbum = {
  key: 'dragonland::holy-war',
  name: 'Holy War',
  album_artist: 'Dragonland',
  year: '2002',
  cover_ref: 'front-ref',
  track_count: 2,
  tracks: [],
  selected_covers_loaded: true,
  selected_covers: selectedCovers,
};
const detailsAlbum = {
  ...cardAlbum,
  tracks: [
    { path_ref: 'track-1', title: 'Hundred Years Have Passed', track_number: 1, duration: 144 },
    { path_ref: 'track-2', title: 'Majesty of The Mithrill Mountains', track_number: 2, duration: 328 },
  ],
};

// Holds every request for the album's own card cover until released, so the shell's image is still loading.
async function holdCardCover(page) {
  const held = [];
  await page.route(`${origin}/cover/**`, (route) => {
    const fulfil = () => route.fulfill({ contentType: 'image/png', body: coverPng, headers: { 'cache-control': 'no-store' } });
    if (new URL(route.request().url()).pathname.includes('front-ref')) held.push(fulfil);
    else fulfil();
  });
  return {
    async release() {
      await expect.poll(() => held.length).toBeGreaterThan(0);
      held.splice(0).forEach((fulfil) => fulfil());
    },
  };
}

// The shell shows the card's cover; the cached details render before that image has arrived. Each open uses a new
// cover revision, so the browser cannot answer the card cover from its memory cache.
async function openWithCachedDetails(page, coverRevision) {
  await page.evaluate(({ card, details }) => {
    openTrackModalShell(card);
    openTrackModal(details);
  }, {
    card: { ...cardAlbum, cover_revision: coverRevision },
    details: { ...detailsAlbum, cover_revision: coverRevision },
  });
}

async function expectFrontCoverShown(page) {
  const front = page.locator('#track-modal-cover .album-details-cover-stack__front .track-modal-cover-visual');
  const image = front.locator('img');
  await expect(image).toHaveCount(1);
  await expect(front).not.toHaveClass(/\bis-loading\b/);
  await expect(image).toBeVisible();
  await expect(front.locator('.cover-placeholder')).toBeHidden();
  // Decoded, painted, and the topmost thing at the cover's centre.
  await expect.poll(() => image.evaluate(async (element) => {
    await element.decode();
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const atCentre = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return element.complete && element.naturalWidth > 0 && style.visibility === 'visible'
      && Number(style.opacity) > 0 && atCentre === element;
  })).toBe(true);
}

test('the front cover of a 3-cover stack shows on first open, after reopening and after shuffling', async ({ page }) => {
  await mountAlbumDetails(page);
  await loadRuntime(page);
  const cardCover = await holdCardCover(page);

  await openWithCachedDetails(page, '7');
  await expect(page.locator('#track-modal-cover .album-details-cover-stack__rear img')).toHaveCount(2);
  await cardCover.release();
  await expectFrontCoverShown(page);

  await page.evaluate(() => closeTrackModal());
  await expect(page.locator('#track-modal')).toBeHidden();
  await openWithCachedDetails(page, '8');
  await cardCover.release();
  await expectFrontCoverShown(page);

  await page.locator('.album-details-cover-nav--next').click();
  await expect(page.locator('.album-details-cover-stack')).toHaveAttribute('data-album-details-cover-active-index', '1');
  await expect(page.locator('.album-details-cover-stack')).not.toHaveClass(/\bis-shuffling\b/, { timeout: 5000 });
  await expectFrontCoverShown(page);

  await page.locator('.album-details-cover-nav--previous').click();
  await expect(page.locator('.album-details-cover-stack')).toHaveAttribute('data-album-details-cover-active-index', '0');
  await expect(page.locator('.album-details-cover-stack')).not.toHaveClass(/\bis-shuffling\b/, { timeout: 5000 });
  await expectFrontCoverShown(page);
});
