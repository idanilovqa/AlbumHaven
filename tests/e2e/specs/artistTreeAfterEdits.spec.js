import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/baseFixtures.js';
import { createArtistTreeFixture, removeArtistTreeFixture } from '../helpers/artistTreeEditFixture.js';
import { holdSaveBeforeMediaWrite } from '../helpers/structuralSavePollWindowHelpers.js';

const SAVE_PATH = '/utilities/edit-tags';
let ownedFixture;
let saveGate;

function ownerName() {
  return `E2E Artist Tree ${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function albumTracks(albumArtist, album, titles, { artist = albumArtist, folder, fileName } = {}) {
  return titles.map((title, index) => ({
    path: `${folder || album}/${fileName?.(index, title) || `${String(index + 1).padStart(2, '0')}. ${title}.mp3`}`,
    album,
    albumArtist,
    artist: typeof artist === 'function' ? artist(index) : artist,
    title,
    number: index + 1,
  }));
}

async function openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, tracks) {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createArtistTreeFixture(ownerName(), tracks);
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
}

async function openArtist(galleryActions, artist) {
  await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(artist)}`);
  await galleryActions.waitForSelectedArtistGallery(artist, { requireExclusiveView: true });
}

test.afterEach(async ({ galleryActions, appBarActions }) => {
  await saveGate?.dispose();
  saveGate = null;
  try {
    if (ownedFixture) await removeArtistTreeFixture(ownedFixture);
  } finally {
    ownedFixture = null;
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.describe('Artist tree after searches and Album Artist edits', () => {
  test.describe.configure({ timeout: 300000 });

  test('FTC-SEARCH-NAV-003 a reloaded exact-artist search shows the same tree as the typed search when only another artist\'s file name matches', { tag: '@area:gallery-search' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, navigationPanelActions, searchToolbarActions,
  }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const band = `Moorvale ${suffix}`;
    const other = `Infinity Vale ${suffix}`;
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [
      ...albumTracks(band, 'Shadow Vale', ['Shadow Vale', 'North Gate']),
      // The other band's first track is a guest's, and only its file name names the searched band.
      ...albumTracks(other, 'Open Orbit', ['Stone Hall', 'Open Orbit'], {
        artist: index => (index === 0 ? `Guest Voice ${suffix}` : other),
        fileName: (index, title) => (index === 0
          ? `01. ${title} [feat. members of '${band}'].mp3`
          : `0${index + 1}. ${title}.mp3`),
      }),
    ]);

    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(band, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(band);
    await navigationPanelActions.waitForSidebarSelection(band);
    await galleryActions.waitForSelectedArtistGallery(band, { queryValue: band });
    const typedTree = await navigationPanelActions.readSidebarArtistNames();
    expect(typedTree, 'The typed search tree shows only the searched band.').toEqual([band]);

    await page.reload();
    await searchToolbarActions.waitForQuery(band);
    await navigationPanelActions.waitForSidebarSelection(band);
    await galleryActions.waitForSelectedArtistGallery(band, { queryValue: band });
    await expect.poll(() => navigationPanelActions.readSidebarArtistNames(), {
      message: 'The reloaded search tree must equal the typed search tree.',
      timeout: 30000,
    }).toEqual(typedTree);
    await expect(galleryActions.galleryPage.albumCard.cardByAlbumName('Shadow Vale')).toHaveCount(1);
  });

  test('FTC-GALLERY-034 an album whose Album Artist repeats one artist is that artist\'s own album, never Featured On', { tag: '@area:gallery-search' }, async ({
    managedAppLifecycle, galleryActions, appBarActions, navigationPanelActions,
  }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const band = `Quartzline ${suffix}`;
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, [
      ...albumTracks(band, 'Paper Lines', ['Market Step', 'Quiet Song']),
      // The tag names the band twice, as a joint credit of the band with itself.
      ...albumTracks(`${band} / ${band}`, 'Night Score', ['City Lights', "Low Tide"], { artist: band }),
    ]);

    await openArtist(galleryActions, band);
    await expect.poll(() => galleryActions.readArtistDiscographySections(band).then(sections => (
      sections.map(({ title, albums }) => ({ title, names: albums.map(({ name }) => name).sort() }))
    )), { message: 'Both albums are the band\'s own, with no Featured On section.', timeout: 30000 }).toEqual([
      { title: null, names: ['Night Score', 'Paper Lines'] },
    ]);
    expect(await navigationPanelActions.readSidebarArtistAlbumCount(band), 'The band\'s count includes the album.').toBe(2);
    expect(await navigationPanelActions.readHydratedSidebarArtistNames()).not.toContain(`${band} / ${band}`);
  });

  test('FTC-TAGS-045 an Album Artist edit of some tracks shows the new artist with its album, and restoring it leaves no empty artist behind', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, navigationPanelActions, tagEditorActions,
  }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const band = `Duskmoor ${suffix}`;
    const renamed = `Duskmoor2 ${suffix}`;
    const album = 'Grey Shore';
    const titles = ['Grey Shore', 'North Gate', 'Glass Field', 'Last Signal'];
    const moved = ['02. North Gate.mp3', '03. Glass Field.mp3'];
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions }, albumTracks(band, album, titles));

    await openArtist(galleryActions, band);
    await galleryActions.openAlbumTagEditorFromContextMenu(album);
    await tagEditorActions.waitForOpen({ expectedTrackCount: 4 });
    await tagEditorActions.selectTracksByFilenames(moved);
    await tagEditorActions.setAlbumArtist(renamed);
    await tagEditorActions.applyAndWaitForSavedFiles();

    await openArtist(galleryActions, renamed);
    await navigationPanelActions.waitForSidebarSelection(renamed);
    expect(await navigationPanelActions.readSidebarArtistAlbumCount(renamed), 'The new album artist owns one album.').toBe(1);
    await expect(galleryActions.galleryPage.albumCard.cardByAlbumName(album)).toHaveCount(1);
    await expect(galleryActions.galleryPage.albumCard.trackCountByAlbumName(album)).toContainText('2');

    // Restore the moved tracks from the new artist's album.
    await openArtist(galleryActions, renamed);
    await galleryActions.openAlbumTagEditorFromContextMenu(album);
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumArtist(band);
    await tagEditorActions.applyAndWaitForSavedFiles();

    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await openArtist(galleryActions, band);
      await expect.poll(() => navigationPanelActions.readHydratedSidebarArtistNames(), {
        message: `After the restore${reload ? ' and a reload' : ''} the tree has no ${renamed} row.`,
        timeout: 30000,
      }).not.toContain(renamed);
      expect(await navigationPanelActions.readSidebarArtistAlbumCount(band)).toBe(1);
      await expect(galleryActions.galleryPage.albumCard.cardByAlbumName(album)).toHaveCount(1);
      await expect(galleryActions.galleryPage.albumCard.trackCountByAlbumName(album)).toContainText('4');
    }
  });

  test('FTC-TAGS-046 a save made while an earlier save of the same tracks is still running writes its change instead of reporting success without one', { tag: '@area:tag-edit' }, async ({
    page, managedAppLifecycle, galleryActions, appBarActions, navigationPanelActions, tagEditorActions,
  }) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const band = `Duskmoor ${suffix}`;
    const renamed = `Duskmoor2 ${suffix}`;
    const album = 'Grey Shore';
    await openLibrary({ managedAppLifecycle, galleryActions, appBarActions },
      albumTracks(band, album, ['Grey Shore', 'North Gate']));
    const { tagEditor } = tagEditorActions;
    const saveSetting = albumArtist => page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === SAVE_PATH
      && Object.values(JSON.parse(response.request().postData() || '{}').updates || {})
        .every(values => values.album_artist === albumArtist)
    ), { timeout: 120000 });

    await openArtist(galleryActions, band);
    await galleryActions.openAlbumTagEditorFromContextMenu(album);
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumArtist(renamed);
    // The first save is held before it records or writes anything, as a slow save is.
    saveGate = await holdSaveBeforeMediaWrite();
    const firstSave = saveSetting(renamed);
    await tagEditor.applyButton.click();
    await tagEditor.confirmButton.click();
    await expect(tagEditor.overlay).toBeHidden();

    // While it runs, the album is given its old album artist back.
    await navigationPanelActions.selectSidebarArtistByName(renamed);
    await galleryActions.waitForSelectedArtistGallery(renamed);
    await galleryActions.openAlbumTagEditorFromContextMenu(album);
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumArtist(band);
    const secondSave = saveSetting(band);
    await tagEditor.applyButton.click();
    await tagEditor.confirmButton.click();
    // The second save reaches the server while the first still holds the tracks.
    await Promise.race([secondSave, new Promise(resolve => { setTimeout(resolve, 3000); })]);
    await saveGate.release();
    saveGate = null;
    expect((await (await firstSave).json()).ok).toBe(true);
    const second = await (await secondSave).json();
    expect(second.ok, 'The second save reports success.').toBe(true);
    expect(second.changed_count, 'A save that reports success has written its change.').toBe(2);

    await expect.poll(async () => {
      await page.reload();
      await openArtist(galleryActions, band);
      return navigationPanelActions.readHydratedSidebarArtistNames();
    }, { message: `The last save gave the album back to ${band}.`, timeout: 60000 }).not.toContain(renamed);
    await expect(galleryActions.galleryPage.albumCard.cardByAlbumName(album)).toHaveCount(1);
    await expect(galleryActions.galleryPage.albumCard.trackCountByAlbumName(album)).toContainText('2');
  });
});
