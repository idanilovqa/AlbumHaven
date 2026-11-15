const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');

async function mountGallery(page, { artist, albums, singleArtist = false }) {
  await page.setContent('<main id="gallery-fixture"></main>');
  await page.evaluate(() => {
    window.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  });
  for (const filename of ['alert-components.js', 'album-artbox.js', 'gallery-main-components.js', 'gallery-card-component.js']) {
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime', filename) });
  }
  await page.evaluate(({ artist, albums, singleArtist }) => {
    const cards = albums.map((album, index) => buildGalleryCardHtml({
      identity: `card-${index}`, renderKey: `card-${index}`, albumKey: `album-${index}`,
      albumVersionKey: `version-${index}`, albumFallback: '{}',
      title: album.title, artist: album.artist ?? artist, year: album.year,
      trackCount: 2, lengthDisplay: '4m', artboxHtml: '<div class="album-artbox">Cover</div>',
    })).join('');
    const header = singleArtist
      ? `<header data-gallery-bar-instance="gallery" data-gallery-context-kind="single-artist">${buildGalleryBarHtml({ contextKind: 'single-artist', artist, albumCount: albums.length })}</header>`
      : '';
    const heading = singleArtist ? '' : buildFamilyArtistHeaderHtml({ artist, albumCount: albums.length });
    document.getElementById('gallery-fixture').innerHTML = `${header}<div id="artist-groups"><section class="artist-section">${heading}<div class="album-row">${cards}</div></section></div>`;
  }, { artist, albums, singleArtist });
  const { GalleryPage } = await import(pathToFileURL(path.join(repositoryRoot, 'tests/e2e/poms/galleryPage.js')).href);
  return new GalleryPage(page);
}

for (const singleArtist of [false, true]) {
  test(`production card identities keep exact years with ${singleArtist ? 'gallery header' : 'artist section'}`, async ({ page }) => {
    const artist = 'A · B Ensemble';
    const title = 'Two Track Rarity Fixture';
    const gallery = await mountGallery(page, {
      artist, singleArtist,
      albums: [{ title, year: '2026' }, { title, year: '2025' }],
    });
    const card = gallery.albumCard.cardByIdentity(artist, title, '2026');
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expect(card.locator('.album-title-button')).toHaveText(title);
    expect(await gallery.albumCard.readVisibleMetadata(card)).toEqual({ artist, year: '2026' });
    await expect(gallery.albumCard.cardByIdentity(artist, title, '202')).toHaveCount(0);
    await expect(gallery.albumCard.cardByIdentity(artist, title, '20260')).toHaveCount(0);
    await expect(gallery.albumCard.cardByIdentity('B Ensemble', title, '2026')).toHaveCount(0);
    expect(await gallery.readRenderedAlbumIdentities(artist, [title])).toEqual([
      { album: title, key: 'card-0', year: '2026' },
      { album: title, key: 'card-1', year: '2025' },
    ]);
    expect((await gallery.readMountedAlbumInventory()).map(({ year }) => year)).toEqual(['2026', '2025']);
    expect((await gallery.readProductionVisibleAlbumObservation(artist, [title])).renderedIdentities)
      .toEqual([{ album: title, year: '2026' }, { album: title, year: '2025' }]);
  });
}

test('production card metadata distinguishes numeric artists, unknown years, and absent artists', async ({ page }) => {
  const gallery = await mountGallery(page, {
    artist: '1966',
    albums: [
      { title: 'Undated', year: '' },
      { title: 'Dated', year: '1997' },
      { title: 'No credit', artist: '', year: '2000' },
    ],
  });
  const undated = gallery.albumCard.cardsByArtistAndAlbum('1966', 'Undated');
  expect(await gallery.albumCard.readVisibleMetadata(undated)).toEqual({ artist: '1966', year: '' });
  await expect(gallery.albumCard.cardByIdentity('1966', 'Undated', '1966')).toHaveCount(0);
  expect(await gallery.albumCard.readMetadataByAlbumName('Dated')).toEqual({ artist: '1966', year: '1997' });
  expect(await gallery.albumCard.readMetadataByAlbumName('No credit')).toEqual({ artist: '', year: '2000' });
  await expect(gallery.albumCard.cardByIdentity('1966', 'No credit', '2000')).toHaveCount(1);
  expect((await gallery.readRenderedAlbumIdentities('1966', ['Undated', 'Dated', 'No credit']))
    .map(({ year }) => year)).toEqual(['', '1997', '2000']);
});
