// MusicBrainz Delivery 1 and 1.1, through the real UI: what an artist's MusicBrainz identity
// shows in the Gallery header, the artist panel and Album Details, and how an Unconfirmed
// match reaches Problematic Files. Acceptance case IDs are in each step name. The matcher's
// own rules are covered at unit and replay level (tests/py/test_musicbrainz_*), not here.
import { expect, test } from '../support/baseFixtures.js';
import { createMusicBrainzIdentityFixture } from '../helpers/musicbrainzIdentityFixture.js';

const GUEST = 'Compilation Signal Guest';
const LEAD = 'Compilation Signal Lead';
// Its own artist, so the Problematic Files case never shares rows with the Gallery cases.
const UNCONFIRMED = 'Album Rating Contract';
const MBID = {
  guest: '0e2e0001-0000-4000-8000-000000000001',
  credited: '0e2e0001-0000-4000-8000-000000000002',
  leadUk: '0e2e0001-0000-4000-8000-000000000003',
  leadSweden: '0e2e0001-0000-4000-8000-000000000004',
  person: '0e2e0001-0000-4000-8000-000000000005',
  band: '0e2e0001-0000-4000-8000-000000000006',
  unconfirmed: '0e2e0001-0000-4000-8000-000000000007',
};

async function openArtist(page, { galleryActions, searchToolbarActions }, artist, expectedTitle = artist) {
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();
  await searchToolbarActions.search(artist, { submitWithEnter: true });
  await searchToolbarActions.waitForQuery(artist);
  await expect(page.locator('[data-gallery-context-name]').first()).toHaveText(expectedTitle, { timeout: 60000 });
}

async function openArtistPanel(page) {
  await page.locator('.gallery-bar__title [data-artist-info-trigger]').first().click();
  const panel = page.locator('[data-artist-info-overlay]');
  await expect(panel).toBeVisible();
  return panel;
}

async function albumDetailsTags(page, { galleryActions, trackModalActions }, artist, album) {
  await galleryActions.clickAlbumDetailsByArtistAndAlbum(artist, album);
  await trackModalActions.waitForInteractiveSummary();
  return page.locator('#track-modal .album-details-header__tag').allInnerTexts();
}

test('FTC-MBID-001 a matched artist shows its MusicBrainz name, country, genres and links', { tag: '@area:gallery-search' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  try {
    await stepLogger.step('MBD1-04, MBD1-06: the header shows the name, then country and genre pills', async () => {
      await fixture.matchArtist(GUEST, {
        mbid: MBID.guest, name: GUEST, country: { code: 'FI', name: 'Finland' },
        genres: ['progressive rock', 'art rock'], discogsArtistId: 424242,
      });
      await openArtist(page, { galleryActions, searchToolbarActions }, GUEST);
      const bar = page.locator('.gallery-bar__context').first();
      await expect(bar.locator('.ui-metadata-pill--country')).toHaveText('Finland');
      await expect(bar.locator('.ui-metadata-pill--genre')).toHaveText(['progressive rock', 'art rock']);
    });

    await stepLogger.step('MBD1-19: the artist panel links to MusicBrainz and Discogs', async () => {
      const panel = await openArtistPanel(page);
      await expect(panel.locator(`a[href="https://musicbrainz.org/artist/${MBID.guest}"]`)).toBeVisible();
      await expect(panel.locator('a[href="https://www.discogs.com/artist/424242"]')).toBeVisible();
      await expect(panel.locator('[data-artist-info-credit]')).toHaveCount(0);
    });

    await stepLogger.step('MBD1-38: an artist matched under another name shows that name and how it is tagged', async () => {
      await fixture.matchArtist(GUEST, { mbid: MBID.credited, name: 'Signal Guest Collective' }, { creditName: GUEST });
      await openArtist(page, { galleryActions, searchToolbarActions }, GUEST, 'Signal Guest Collective');
      const panel = await openArtistPanel(page);
      await expect(panel.locator('h2')).toHaveText('Signal Guest Collective');
      await expect(panel.locator('[data-artist-info-credit]')).toHaveText(`Tagged as ${GUEST} in your files.`);
    });
  } finally {
    await fixture.restore();
  }
});

test('FTC-MBID-002 a split name lists each MusicBrainz artist; a person and their band stay one artist', { tag: '@area:album-details' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  try {
    await stepLogger.step('MBD1-37: the panel lists both same-named bands with their albums and links', async () => {
      await fixture.splitArtist(LEAD, [
        { mbid: MBID.leadUk, name: LEAD, disambiguation: 'UK band',
          albums: ['Functional Fixture Album 248', 'Functional Fixture Album 249'] },
        { mbid: MBID.leadSweden, name: LEAD, disambiguation: 'Swedish band', albums: ['Functional Fixture Album 250'] },
      ]);
      await openArtist(page, { galleryActions, searchToolbarActions }, LEAD);
      const identities = (await openArtistPanel(page)).locator('[data-artist-info-identities]');
      await expect(identities).toContainText('Your albums belong to 2 MusicBrainz artists:');
      await expect(identities.locator('li')).toHaveText([
        /Compilation Signal Lead \(UK band\) · 2 albums/, /Compilation Signal Lead \(Swedish band\) · 1 album/]);
      await expect(identities.locator(`a[href="https://musicbrainz.org/artist/${MBID.leadSweden}"]`)).toBeVisible();
      await page.keyboard.press('Escape');
    });

    await stepLogger.step('MBD1-37: Album Details names which band an album belongs to', async () => {
      const tags = await albumDetailsTags(page, { galleryActions, trackModalActions }, LEAD, 'Functional Fixture Album 250');
      expect(tags).toContain('MusicBrainz: Compilation Signal Lead (Swedish band)');
      await trackModalActions.closeIfOpen();
    });

    await stepLogger.step('Delivery 1.1: a person and the same-named band they belong to are one artist', async () => {
      await fixture.restore();
      await fixture.personWithBand(LEAD,
        { mbid: MBID.person, name: LEAD, kind: 'Person', albums: ['Functional Fixture Album 248'] },
        { mbid: MBID.band, name: LEAD, disambiguation: 'the band', albums: ['Functional Fixture Album 249'] });
      await openArtist(page, { galleryActions, searchToolbarActions }, LEAD);
      const panel = await openArtistPanel(page);
      await expect(panel.locator(`a[href="https://musicbrainz.org/artist/${MBID.person}"]`).first()).toBeVisible();
      const associated = panel.locator('[data-artist-info-identities]');
      await expect(associated).toContainText('Also on MusicBrainz as:');
      await expect(associated.locator('li')).toHaveText([/Compilation Signal Lead \(the band\) · 1 album/]);
      await page.keyboard.press('Escape');
      const tags = await albumDetailsTags(page, { galleryActions, trackModalActions }, LEAD, 'Functional Fixture Album 249');
      expect(tags.filter((tag) => tag.startsWith('MusicBrainz:') || tag.startsWith('Tagged as'))).toEqual([]);
      await trackModalActions.closeIfOpen();
    });
  } finally {
    await fixture.restore();
  }
});

test('FTC-MBID-003 an Unconfirmed match and its filter are in the first Problematic Files page', { tag: '@area:problematic-files' }, async ({
  galleryActions,
  page,
  settingsModalAppBarActions,
  stepLogger,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  let releaseCompleteList;
  try {
    await fixture.unconfirmedArtist(UNCONFIRMED, { mbid: MBID.unconfirmed, name: UNCONFIRMED, disambiguation: 'Finnish band' });
    await stepLogger.step('MBD1-10, MBD1-21: the filter and the Artist row arrive with the first page', async () => {
      // Hold the complete list back: everything asserted here comes from the bounded first page.
      const held = new Promise((resolve) => { releaseCompleteList = resolve; });
      await page.route(/\/utilities\/problematic-files$/, async (route) => { await held; await route.continue(); });
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForFirstVisible();
      expect(await utilityProblematicFilesActions.readProblemFilterValues()).toContain('MBID: Unconfirmed match');
      await utilityProblematicFilesActions.waitForAlbumInSidebarList(UNCONFIRMED);
    });

    await stepLogger.step('MBD1-20: the Unconfirmed match suggests its MusicBrainz artist', async () => {
      releaseCompleteList();
      await utilityProblematicFilesActions.waitForReady();
      await utilityProblematicFilesActions.applySingleProblemFilter('MBID: Unconfirmed match');
      await utilityProblematicFilesActions.selectAlbumByTitle(UNCONFIRMED);
      const detail = page.locator('#utility-problematic-detail');
      await expect(detail).toContainText(UNCONFIRMED);
      await expect(detail.locator(`a[href="https://musicbrainz.org/artist/${MBID.unconfirmed}"]`).first()).toBeVisible();
    });
  } finally {
    releaseCompleteList?.();
    await page.unroute(/\/utilities\/problematic-files$/).catch(() => {});
    await fixture.restore();
  }
});
