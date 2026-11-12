// MusicBrainz Delivery 1 and 1.1, through the real UI: what an artist's MusicBrainz identity
// shows in the Gallery header, the artist panel and Album Details, and how an Unconfirmed
// match reaches Problematic Files. Acceptance case IDs are in each step name. The matcher's
// own rules are covered at unit and replay level (tests/py/test_musicbrainz_*), not here.
import { expect, test } from '../support/baseFixtures.js';
import { createMusicBrainzIdentityFixture } from '../helpers/musicbrainzIdentityFixture.js';

const GUEST = 'Compilation Signal Guest';
const CREDITED = 'Functional Balance Artist 03';
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

async function openArtist({ galleryActions, searchToolbarActions }, artist, expectedTitle = artist) {
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();
  await searchToolbarActions.search(artist, { submitWithEnter: true });
  if (expectedTitle === artist) await searchToolbarActions.waitForQuery(artist);
  await galleryActions.waitForContextName(expectedTitle);
}

async function albumDetailsTags({ galleryActions, trackModalActions }, artist, album) {
  await galleryActions.clickAlbumDetailsByArtistAndAlbum(artist, album);
  await trackModalActions.waitForInteractiveSummary();
  return trackModalActions.readHeaderTags();
}

test('FTC-MBID-001 a matched artist shows its MusicBrainz name, country, genres and links', { tag: '@area:gallery-search' }, async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  try {
    await fixture.matchArtist(CREDITED, {
      mbid: MBID.credited,
      name: 'Signal Guest Collective',
    }, { creditName: CREDITED });
    await stepLogger.step('MBD1-04, MBD1-06: the sticky header keeps the artist, country and top genres together', async () => {
      await fixture.matchArtist(GUEST, {
        mbid: MBID.guest, name: GUEST, country: { code: 'FI', name: 'Finland' },
        genres: [
          { name: 'progressive rock', voteCount: 12 },
          { name: 'art rock', voteCount: 8 },
          { name: 'doom metal', voteCount: 4 },
          { name: 'folk rock', voteCount: 2 },
          { name: 'melancholy', voteCount: 100, isGenre: false },
        ],
        discogsArtistId: 424242,
      });
      await openArtist({ galleryActions, searchToolbarActions }, GUEST);
      await galleryActions.scrollGalleryToMiddle();
      await expect.poll(async () => (
        await galleryActions.readGalleryScrollState()
      ).scrollTop, { timeout: 60000 }).toBeGreaterThan(0);
      await galleryActions.waitForContextName(GUEST);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['Finland'],
        genres: ['progressive rock', 'art rock', 'doom metal'],
      });
      await expect.poll(() => galleryActions.readArtistContextLayout(), { timeout: 60000 }).toEqual({
        name: GUEST,
        infoLabel: `Information about ${GUEST}`,
        divider: '•',
        albumCount: '12 albums',
        titleLineAligned: true,
        metadataBelowTitle: true,
        unclipped: true,
      });
    });

    await stepLogger.step('MBD1-06: zero-vote MusicBrainz genres remain visible', async () => {
      await fixture.matchArtist(GUEST, {
        mbid: MBID.guest, name: GUEST, country: { code: 'FI', name: 'Finland' },
        genres: [
          { name: 'dark wave', voteCount: 0 },
          { name: 'ambient', voteCount: 0 },
        ],
        discogsArtistId: 424242,
      });
      await openArtist({ galleryActions, searchToolbarActions }, GUEST);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['Finland'],
        genres: ['ambient', 'dark wave'],
      });
    });

    await stepLogger.step('MBD1-19: the artist panel links to MusicBrainz and Discogs', async () => {
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          credit: [],
          countries: ['Finland'],
          genres: ['ambient', 'dark wave'],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.guest}`,
            'https://www.discogs.com/artist/424242',
          ]),
        }),
      );
    });

    await stepLogger.step('MBD1-38: an artist matched under another name shows that name and how it is tagged', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, CREDITED, 'Signal Guest Collective');
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          heading: 'Signal Guest Collective',
          credit: [`Tagged as ${CREDITED} in your files.`],
        }),
      );
    });
  } finally {
    await fixture.restore();
  }
});

test('FTC-MBID-002 a split name lists each MusicBrainz artist; a person and their band stay one artist', { tag: '@area:album-details' }, async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  try {
    await stepLogger.step('MBD1-37: the panel lists both same-named bands with their albums and links', async () => {
      await fixture.splitArtist(LEAD, [
        { mbid: MBID.leadUk, name: LEAD, disambiguation: 'UK band',
          albums: ['Compilation Lead Solo', 'Functional Fixture Album 249'] },
        { mbid: MBID.leadSweden, name: LEAD, disambiguation: 'Swedish band', albums: ['Functional Fixture Album 250'] },
      ]);
      await openArtist({ galleryActions, searchToolbarActions }, LEAD);
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          identities: expect.stringContaining('Your albums belong to 2 MusicBrainz artists:'),
          identityRows: [
            expect.stringMatching(/Compilation Signal Lead \(UK band\) · 2 albums/),
            expect.stringMatching(/Compilation Signal Lead \(Swedish band\) · 1 album/),
          ],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.leadUk}`,
            `https://musicbrainz.org/artist/${MBID.leadSweden}`,
          ]),
        }),
      );
      await galleryActions.closeArtistInfoPanel();
    });

    await stepLogger.step('MBD1-37: Album Details names which band an album belongs to', async () => {
      const tags = await albumDetailsTags({ galleryActions, trackModalActions }, LEAD, 'Functional Fixture Album 250');
      expect(tags).toContain('MusicBrainz: Compilation Signal Lead (Swedish band)');
      await trackModalActions.closeIfOpen();
    });

    await stepLogger.step('Delivery 1.1: a person and the same-named band they belong to are one artist', async () => {
      await fixture.restore();
      await fixture.personWithBand(LEAD,
        { mbid: MBID.person, name: LEAD, kind: 'Person', albums: ['Compilation Lead Solo'] },
        { mbid: MBID.band, name: LEAD, disambiguation: 'the band', albums: ['Functional Fixture Album 249'] });
      await openArtist({ galleryActions, searchToolbarActions }, LEAD);
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          identities: expect.stringContaining('Also on MusicBrainz as:'),
          identityRows: [
            expect.stringMatching(/Compilation Signal Lead \(the band\) · 1 album/),
          ],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.person}`,
            `https://musicbrainz.org/artist/${MBID.band}`,
          ]),
        }),
      );
      await galleryActions.closeArtistInfoPanel();
      const tags = await albumDetailsTags({ galleryActions, trackModalActions }, LEAD, 'Functional Fixture Album 249');
      expect(tags.filter((tag) => tag.startsWith('MusicBrainz:') || tag.startsWith('Tagged as'))).toEqual([]);
      await trackModalActions.closeIfOpen();
    });
  } finally {
    await fixture.restore();
  }
});

test('FTC-MBID-003 an Unconfirmed match and its filter are in the first Problematic Files page', { tag: '@area:problematic-files' }, async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
  const fixture = await createMusicBrainzIdentityFixture();
  try {
    await fixture.unconfirmedArtist(UNCONFIRMED, { mbid: MBID.unconfirmed, name: UNCONFIRMED, disambiguation: 'Finnish band' });
    await stepLogger.step('MBD1-10, MBD1-21: the filter and the Artist row arrive with the first page', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      const boundedPage = utilityProblematicFilesActions.waitForBoundedPageEvidence(
        'MBID: Unconfirmed match',
        UNCONFIRMED,
      );
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.openProblemFilterMenu();
      await boundedPage;
      await utilityProblematicFilesActions.closeProblemFilterMenu();
      await utilityProblematicFilesActions.waitForFirstVisible();
      expect(await utilityProblematicFilesActions.readProblemFilterValues()).toContain('MBID: Unconfirmed match');
      await utilityProblematicFilesActions.waitForAlbumInSidebarList(UNCONFIRMED);
    });

    await stepLogger.step('MBD1-20: the Unconfirmed match suggests its MusicBrainz artist', async () => {
      await utilityProblematicFilesActions.waitForReady();
      await utilityProblematicFilesActions.applySingleProblemFilter('MBID: Unconfirmed match');
      const detail = await utilityProblematicFilesActions.selectAlbumByTitle(UNCONFIRMED);
      expect(detail.title).toBe(UNCONFIRMED);
      expect(detail.problemReasons).toContain('MBID: Unconfirmed match');
      await expect.poll(() => utilityProblematicFilesActions.readSelectedDetailLinks(), { timeout: 60000 })
        .toContain(`https://musicbrainz.org/artist/${MBID.unconfirmed}`);
    });
  } finally {
    await fixture.restore();
  }
});
