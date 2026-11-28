const path = require('node:path');
const { test, expect } = require('@playwright/test');

// The Loose Tracks page through its real owners (openNonAlbumModal, the mobile page outlet and the status note
// owner) at phone width: only a track Problematic Files lists shows "!" with that entry's reasons, and the
// one-time store build shows "Preparing Loose Tracks… N%" that follows status and leaves when the build is done.
const staticRoot = path.resolve(__dirname, '../../music_app/static');

async function mountLooseTracksPage(page, { tracks, preparation, hydrated }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <main id="shell-main-surface">
      <div id="mobile-page-header" hidden><button id="mobile-back-button" hidden></button>
        <button id="mobile-page-library-button" hidden></button><h1 id="mobile-page-title"></h1><p id="mobile-page-summary"></p>
        <div id="mobile-settings-actions" hidden></div><button id="mobile-settings-button" hidden></button></div>
      <div class="mobile-page-outlet" id="mobile-page-outlet" hidden></div>
      <button id="mobile-library-button"></button>
      <div id="albums-scroll"></div>
    </main>
    <div class="non-album-modal" id="non-album-modal" hidden>
      <div class="non-album-modal-dialog" role="dialog" aria-modal="true">
        <div class="non-album-modal-header gallery-bar page-gallery-bar" id="non-album-modal-header"></div>
        <div class="non-album-modal-table-wrap"><div class="non-album-modal-table" id="non-album-modal-table"></div></div>
      </div>
    </div></body></html>`);
  for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'mobile-layout.css', 'gallery-main.css',
    'runtime/base-layout.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css',
    'runtime/album-details-components.css', 'runtime/non-album-and-player.css', 'runtime/utilities.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.evaluate(({ tracks, preparation }) => {
    window.state = {
      view: { visible_library_categories: ['main_library'], gallery_scope: 'all', query: '', library_non_album_tracks: tracks },
      ui: {}, status: { inventory_mutation_revision: 7, loose_tracks_preparation: preparation },
      player: { current: null }, utility: { activeTab: 'appearance' }, gallery: {}, coverLookup: {},
    };
    window.looseTracksRequests = [];
    window.fetch = async (url) => {
      window.looseTracksRequests.push(String(url));
      return { ok: true, status: 200, json: async () => ({ library_non_album_tracks: [], non_album_tracks_deferred: true }) };
    };
    Object.assign(window, {
      buildUrl: () => '/', getAlbumRequestKey: () => '', closeArtistsDrawer() {}, closeGalleryMainSurface() {},
      renderSidebar() {}, attachSharedPlayer() {}, syncMobileAlbumHeader() {}, syncMobileLoopHeader() {},
      buildProblematicAlbumTrackPathIndex: () => new Map(), getPlayerPlaybackSnapshot: () => ({ paused: true, ended: false }),
      matchesAlbumTrackSearch: () => false, formatTrackDuration: () => '3:00', formatAlbumDuration: () => '6 minutes',
      galleryMainSurfaceController: null,
    });
  }, { tracks, preparation });
  await page.addScriptTag({ path: path.join(staticRoot, 'js/button-component.js') });
  for (const file of ['browser-scheduling-helpers.js', 'markup-format-helpers.js', 'running-line.js', 'compact-data-table.js',
    'album-track-table.js', 'gallery-main-components.js', 'album-details-components.js', 'modal-and-overlay-helpers.js',
    'mobile-navigation.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate((hydrated) => {
    if (hydrated) state.view.library_non_album_tracks_hydrated_scope = getLibraryNonAlbumScopeKey(state.view);
    openNonAlbumModal({ libraryWide: true });
  }, hydrated);
  return errors;
}

test('only a loose track Problematic Files lists shows "!", naming its reasons, at phone width', async ({ page }) => {
  const errors = await mountLooseTracksPage(page, {
    hydrated: true,
    preparation: null,
    tracks: [
      { path: '/fixture/Strays/01.flac', title: 'Stray', duration_seconds: 180, is_problematic: true,
        problem_reasons: ['Missing artist'] },
      { path: '/fixture/Folkstone/goose.mp3', title: 'Goose', artist: 'Folkstone', duration_seconds: 180,
        exception_type: 'Non-album rarity', is_problematic: false },
    ],
  });
  const listed = page.locator('[data-track-row-path="/fixture/Strays/01.flac"]');
  const unlisted = page.locator('[data-track-row-path="/fixture/Folkstone/goose.mp3"]');
  await expect(listed).toBeVisible();
  await expect(unlisted).toBeVisible();

  const problem = listed.locator('[data-open-track-problematic]');
  await expect(problem).toBeVisible();
  await expect(problem).toHaveAttribute('title', 'Missing artist. Open this track in Problematic Files');
  await expect(problem).toHaveAttribute('data-track-path', '/fixture/Strays/01.flac');
  await expect(unlisted.locator('[data-open-track-problematic]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the one-time Loose Tracks build shows "Preparing Loose Tracks… N%" until it is done, at phone width', async ({ page }) => {
  const errors = await mountLooseTracksPage(page, { hydrated: false, preparation: { percent: 42 }, tracks: [] });
  const note = page.locator('[data-loose-tracks-preparation-note]');
  await expect(note).toBeVisible();
  await expect(note).toHaveText('Preparing Loose Tracks… 42%');
  const noteBox = await note.boundingBox();
  const loading = await page.locator('#non-album-modal-table .album-track-table').boundingBox();
  expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(loading.y + 1);
  expect(noteBox.x).toBeGreaterThanOrEqual(0);
  expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(375);
  await expect.poll(() => page.evaluate(() => looseTracksRequests.length)).toBe(1);

  await page.evaluate(() => { state.status.loose_tracks_preparation = { percent: 87 }; syncLooseTracksPreparationNote(); });
  await expect(note).toHaveText('Preparing Loose Tracks… 87%');
  await expect(note).toHaveCount(1);
  expect(await page.evaluate(() => looseTracksRequests.length)).toBe(1);

  await page.evaluate(() => { state.status.loose_tracks_preparation = null; syncLooseTracksPreparationNote(); });
  await expect(note).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => looseTracksRequests.length)).toBe(2);
  expect(errors).toEqual([]);
});
