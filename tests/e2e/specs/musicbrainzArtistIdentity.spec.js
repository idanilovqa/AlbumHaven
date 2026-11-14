// MusicBrainz Delivery 1 and 1.1, through the real UI: what an artist's MusicBrainz identity
// shows in the Gallery header, the artist panel and Album Details, and how an Unconfirmed
// match reaches Problematic Files. Acceptance case IDs are in each step name. The matcher's
// own rules are covered at unit and replay level (tests/py/test_musicbrainz_*), not here.
import { expect, test } from '../support/baseFixtures.js';
import {
  releaseMusicBrainzHydration,
  waitForMusicBrainzHydrationRequest,
} from '../helpers/musicbrainzProviderHelpers.js';
import { createMusicBrainzIdentityFixture } from '../helpers/musicbrainzIdentityFixture.js';

const GUEST = 'Compilation Signal Guest';
const CREDITED = 'Functional Balance Artist 03';
const LEAD = 'Compilation Signal Lead';
const PERSON_BAND = 'Control Signal Lead';
const NATIVE_ARTISTS = ['ДДТ', 'Ария'];
const HYDRATING = 'Compilation Signal Guest';
const ZERO_VOTE = 'Zero Vote Artist';
const SHAMAANI = 'Shamaani Duo';
const OUTAGE = 'Provider Outage Artist';
const CONFLICT_ASSIGN = 'Control Signal Partner';
// Its own artist, so the Problematic Files case never shares rows with the Gallery cases.
const UNCONFIRMED = 'Album Rating Contract';
const MBID = {
  leadUk: '0e2e0001-0000-4000-8000-000000000003',
  leadSweden: '0e2e0001-0000-4000-8000-000000000004',
  person: '0e2e0001-0000-4000-8000-000000000005',
  band: '0e2e0001-0000-4000-8000-000000000006',
  unconfirmed: '0e2e0001-0000-4000-8000-000000000007',
  manual: '0e2e0001-0000-4000-8000-000000000008',
  guestNorth: '0e2e0001-0000-4000-8000-000000000009',
  guestSouth: '0e2e0001-0000-4000-8000-000000000010',
  nativeDdt: '0e2e0001-0000-4000-8000-000000000011',
  nativeAria: '0e2e0001-0000-4000-8000-000000000012',
  hydrating: '0e2e0001-0000-4000-8000-000000000013',
  zeroVote: '0e2e0001-0000-4000-8000-000000000016',
  conflictAssign: '0e2e0001-0000-4000-8000-000000000018',
  korpiklaani: 'd6b3e0a2-7c1d-4f7c-90bc-73c8bd2ac431',
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

async function openMusicBrainzProblem({
  galleryActions,
  settingsModalAppBarActions,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}, filter, artist) {
  await galleryActions.goto('/?surface=albums');
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('problematic-files');
  await utilityProblematicFilesActions.waitForReady();
  await utilityProblematicFilesActions.applySingleProblemFilter(filter);
  return utilityProblematicFilesActions.selectAlbumByTitle(artist);
}

test('FTC-MBID-001 a matched artist shows its MusicBrainz name, country, genres and links', { tag: '@area:gallery-search' }, async ({
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}, testInfo) => {
    const fixture = await createMusicBrainzIdentityFixture();
    await stepLogger.step('MBD1-07: native-script names stay canonical while Latin forms remain stored only', async () => {
      const nativeCases = [
        { name: NATIVE_ARTISTS[0], mbid: MBID.nativeDdt, latin: 'DDT' },
        { name: NATIVE_ARTISTS[1], mbid: MBID.nativeAria, latin: 'Aria' },
      ];
      for (const nativeCase of nativeCases) {
        expect(await fixture.readStoredArtist(nativeCase.mbid)).toEqual({
          aliases: [nativeCase.latin],
          canonicalName: nativeCase.name,
          nativeName: nativeCase.name,
          sortName: nativeCase.latin,
        });
        await openArtist({ galleryActions, searchToolbarActions }, nativeCase.name);
        expect(await navigationPanelActions.readSidebarArtistLabel(nativeCase.name)).toBe(nativeCase.name);
        const headings = await galleryActions.readArtistHeadings();
        expect(headings).toContain(nativeCase.name);
        expect(headings).not.toContain(nativeCase.latin);
        await galleryActions.openArtistInfoPanel();
        await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
          expect.objectContaining({
            heading: nativeCase.name,
            credit: [],
            identityRows: [],
          }),
        );
        await galleryActions.closeArtistInfoPanel();
      }
    });

    await stepLogger.step('MBD1-04: the open artist information panel survives delayed metadata hydration', async () => {
      await waitForMusicBrainzHydrationRequest(testInfo);
      let hydrationReleased = false;
      try {
        await openArtist({ galleryActions, searchToolbarActions }, HYDRATING);
        await galleryActions.scrollGalleryToMiddle();
        await galleryActions.waitForContextName(HYDRATING);
        expect((await galleryActions.readArtistContextLayout()).infoLabel).toBe(`Information about ${HYDRATING}`);
        await galleryActions.openArtistInfoPanel();
        await releaseMusicBrainzHydration(testInfo);
        hydrationReleased = true;
        await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
          expect.objectContaining({
            heading: HYDRATING,
            countries: ['Finland'],
            genres: ['progressive rock', 'art rock', 'doom metal'],
            links: expect.arrayContaining([`https://musicbrainz.org/artist/${MBID.hydrating}`]),
          }),
        );
        await galleryActions.closeArtistInfoPanel();
      } finally {
        if (!hydrationReleased) await releaseMusicBrainzHydration(testInfo);
      }
    });

    await stepLogger.step('MBD1-06: the sticky header keeps the artist, country and top genres together', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, LEAD);
      await galleryActions.scrollGalleryToMiddle();
      await expect.poll(async () => (
        await galleryActions.readGalleryScrollState()
      ).scrollTop, { timeout: 60000 }).toBeGreaterThan(0);
      await galleryActions.waitForContextName(LEAD);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['Finland'],
        genres: ['progressive rock', 'art rock', 'doom metal'],
      });
      await expect.poll(() => galleryActions.readArtistContextLayout(), { timeout: 60000 }).toEqual({
        name: LEAD,
        infoLabel: `Information about ${LEAD}`,
        divider: '•',
        albumCount: '21 albums',
        titleLineAligned: true,
        metadataBelowTitle: true,
        unclipped: true,
      });
    });

    await stepLogger.step('MBD1-06: zero-vote MusicBrainz genres remain visible', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, ZERO_VOTE);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['Finland'],
        genres: ['ambient', 'dark wave'],
      });
    });

    await stepLogger.step('MBD1-19: the artist panel links to MusicBrainz and Discogs', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, ZERO_VOTE);
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          credit: [],
          countries: ['Finland'],
          genres: ['ambient', 'dark wave'],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.zeroVote}`,
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

    await stepLogger.step('MBD1-40: Shamaani Duo resolves through Hunka lunka to Korpiklaani', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, SHAMAANI, 'Korpiklaani');
      await galleryActions.openArtistInfoPanel();
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          heading: 'Korpiklaani',
          credit: [`Tagged as ${SHAMAANI} in your files.`],
          links: expect.arrayContaining([`https://musicbrainz.org/artist/${MBID.korpiklaani}`]),
        }),
      );
      await galleryActions.closeArtistInfoPanel();
      expect(await albumDetailsTags({ galleryActions, trackModalActions }, 'Korpiklaani', 'Hunka lunka'))
        .toContain('Tagged as Shamaani Duo');
      await trackModalActions.closeIfOpen();
    });
});

test('FTC-MBID-002 a split name lists each MusicBrainz artist; a person and their band stay one artist', { tag: '@area:album-details' }, async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
    await stepLogger.step('MBD1-37: the panel lists both same-named bands with their albums and links', async () => {
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
      await openArtist({ galleryActions, searchToolbarActions }, PERSON_BAND, `${PERSON_BAND} family`);
      await galleryActions.openArtistInfoPanel(PERSON_BAND);
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          identities: expect.stringContaining('Also on MusicBrainz as:'),
          identityRows: [
            expect.stringMatching(/Control Signal Lead \(the band\) · 1 album/),
          ],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.person}`,
            `https://musicbrainz.org/artist/${MBID.band}`,
          ]),
        }),
      );
      await galleryActions.closeArtistInfoPanel();
      const tags = await albumDetailsTags({ galleryActions, trackModalActions }, 'Control Signal Lead / Control Signal Partner', 'Non-Compilation Cross-Credits');
      expect(tags.filter((tag) => tag.startsWith('MusicBrainz:') || tag.startsWith('Tagged as'))).toEqual([]);
      await trackModalActions.closeIfOpen();
    });
});

test('FTC-MBID-003 an Unconfirmed match and its filter are in the first Problematic Files page', { tag: '@area:problematic-files' }, async ({
  galleryActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
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
      expect(await utilityProblematicFilesActions.readMusicBrainzIdentityTable()).toEqual({
        frame: 'outline',
        headers: ['Candidate artist / MBID', 'Local evidence', 'Actions'],
        rows: [expect.stringMatching(new RegExp(
          `${UNCONFIRMED}.*Finland.*Group.*Finnish band.*${MBID.unconfirmed}.*0 of 1 album agree`, 's',
        ))],
      });
      await utilityProblematicFilesActions.openMusicBrainzCandidate(
        UNCONFIRMED,
        `https://musicbrainz.org/artist/${MBID.unconfirmed}`,
      );
      await utilityProblematicFilesActions.selectMusicBrainzCandidate(`Select ${UNCONFIRMED}`);
      await utilityProblematicFilesActions.assignSelectedMusicBrainzIdentity(UNCONFIRMED);
      await settingsModalAppBarActions.closeSettings();
      await openArtist({ galleryActions, searchToolbarActions }, UNCONFIRMED);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['Finland'],
        genres: ['Genre unavailable'],
      });
    });

    await stepLogger.step('MBD1-11: an invalid manual value stays disabled and a verified artist can be assigned', async () => {
      await openMusicBrainzProblem({ galleryActions, settingsModalAppBarActions, utilityProblematicFilesActions, utilityTabBarActions },
        'MBID: Not found', CREDITED);
      await utilityProblematicFilesActions.openMusicBrainzManualSearch(
        `https://musicbrainz.org/search?query=${encodeURIComponent(CREDITED)}&type=artist&method=indexed`,
      );
      expect(await utilityProblematicFilesActions.enterManualArtistReference(
        'https://musicbrainz.org/release/0e2e0001-0000-4000-8000-000000000008',
      )).toEqual({ assignEnabled: false, openEnabled: false });
      const artistUrl = `https://musicbrainz.org/artist/${MBID.manual}`;
      await utilityProblematicFilesActions.enterManualArtistReference(artistUrl);
      await utilityProblematicFilesActions.waitForVerifiedManualArtist(CREDITED);
      await utilityProblematicFilesActions.openEnteredMusicBrainzArtist(artistUrl);
      await utilityProblematicFilesActions.assignSelectedMusicBrainzIdentity(CREDITED);
      await settingsModalAppBarActions.closeSettings();
      await openArtist({ galleryActions, searchToolbarActions }, CREDITED);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['United States'],
        genres: ['Genre unavailable'],
      });
    });

    await stepLogger.step('MBD1-12: a candidate stays unassigned until its radio is selected', async () => {
      await openMusicBrainzProblem({ galleryActions, settingsModalAppBarActions, utilityProblematicFilesActions, utilityTabBarActions },
        'MBID: Multiple matches', GUEST);
      expect(await utilityProblematicFilesActions.readMusicBrainzIdentityTable()).toEqual({
        frame: 'outline',
        headers: ['Candidate artist / MBID', 'Local evidence', 'Actions'],
        rows: [
          expect.stringMatching(new RegExp(`Compilation Signal Guest North.*Canada.*Group.*Canadian studio project.*${MBID.guestNorth}.*1 of 1 album agree`, 's')),
          expect.stringMatching(new RegExp(`Compilation Signal Guest South.*Finland.*Group.*Finnish live act.*${MBID.guestSouth}.*1 of 1 album agree`, 's')),
        ],
      });
      const expectedPresentation = {
        selection: 'single',
        mobile: 'preserve',
        rows: [
          { cellCount: 3, cellLines: true, radioInIdentity: true, iconOnlyAction: true, fullHeightAction: true },
          { cellCount: 3, cellLines: true, radioInIdentity: true, iconOnlyAction: true, fullHeightAction: true },
        ],
        assignBelowTable: true,
        assignPrimary: true,
        keepCurrentHollow: null,
      };
      expect(await utilityProblematicFilesActions.readMusicBrainzIdentityPresentation()).toEqual(expectedPresentation);
      const originalViewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      await utilityProblematicFilesActions.selectAlbumByTitle(GUEST);
      await expect.poll(
        () => utilityProblematicFilesActions.readMusicBrainzIdentityPresentation(),
      ).toEqual(expectedPresentation);
      if (originalViewport) await page.setViewportSize(originalViewport);
      await utilityProblematicFilesActions.expectMusicBrainzAssignmentDisabled();
      await utilityProblematicFilesActions.openMusicBrainzCandidate(
        'Compilation Signal Guest South',
        `https://musicbrainz.org/artist/${MBID.guestSouth}`,
      );
      await utilityProblematicFilesActions.selectMusicBrainzCandidate('Select Compilation Signal Guest South');
      await utilityProblematicFilesActions.assignSelectedMusicBrainzIdentity(GUEST);
      await settingsModalAppBarActions.closeSettings();
    });

    await stepLogger.step('MBD1-13: a metadata conflict can keep its current MBID', async () => {
      await openMusicBrainzProblem({ galleryActions, settingsModalAppBarActions, utilityProblematicFilesActions, utilityTabBarActions },
        'MBID: Metadata conflict', LEAD);
      expect(await utilityProblematicFilesActions.readMusicBrainzIdentityTable()).toEqual({
        frame: 'outline',
        headers: ['Artist identity / MBID', 'Local evidence', 'Actions'],
        rows: [
          expect.stringMatching(new RegExp(`Currently assigned: Compilation Signal Lead.*United Kingdom.*Group.*UK group.*${MBID.leadUk}`, 's')),
          expect.stringMatching(new RegExp(`Suggested: Compilation Signal Lead.*Sweden.*Group.*Swedish group.*${MBID.leadSweden}`, 's')),
        ],
      });
      expect(await utilityProblematicFilesActions.readMusicBrainzIdentityPresentation()).toEqual({
        selection: 'single',
        mobile: 'preserve',
        rows: [
          { cellCount: 3, cellLines: true, radioInIdentity: true, iconOnlyAction: true, fullHeightAction: true },
          { cellCount: 3, cellLines: true, radioInIdentity: true, iconOnlyAction: true, fullHeightAction: true },
        ],
        assignBelowTable: true,
        assignPrimary: true,
        keepCurrentHollow: true,
      });
      await utilityProblematicFilesActions.keepCurrentMusicBrainzIdentity(LEAD);
      await settingsModalAppBarActions.closeSettings();
      await openArtist({ galleryActions, searchToolbarActions }, LEAD);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['United Kingdom'],
        genres: ['Genre unavailable'],
      });
    });

    await stepLogger.step('MBD1-13: a metadata conflict can assign its suggested MBID and keep it after reload', async () => {
      await openMusicBrainzProblem({ galleryActions, settingsModalAppBarActions, utilityProblematicFilesActions, utilityTabBarActions },
        'MBID: Metadata conflict', CONFLICT_ASSIGN);
      await utilityProblematicFilesActions.selectMusicBrainzCandidate(`Select Suggested: ${CONFLICT_ASSIGN}`);
      await utilityProblematicFilesActions.assignSelectedMusicBrainzIdentity(CONFLICT_ASSIGN);
      await settingsModalAppBarActions.closeSettings();
      await openArtist({ galleryActions, searchToolbarActions }, CONFLICT_ASSIGN, `${CONFLICT_ASSIGN} family`);
      await page.reload();
      await galleryActions.waitForGalleryReady();
      await openArtist({ galleryActions, searchToolbarActions }, CONFLICT_ASSIGN, `${CONFLICT_ASSIGN} family`);
      await galleryActions.openArtistInfoPanel(CONFLICT_ASSIGN);
      await expect.poll(() => galleryActions.readArtistInfoSnapshot(), { timeout: 60000 }).toEqual(
        expect.objectContaining({
          heading: CONFLICT_ASSIGN,
          countries: ['Finland'],
          genres: ['Genre unavailable'],
          links: expect.arrayContaining([
            `https://musicbrainz.org/artist/${MBID.conflictAssign}`,
          ]),
        }),
      );
      await galleryActions.closeArtistInfoPanel();
    });

    await stepLogger.step('MBD1-14, MBD1-39: provider outage keeps local data and Retry now resolves and removes the row', async () => {
      await openArtist({ galleryActions, searchToolbarActions }, OUTAGE);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['United States'],
        genres: ['rock'],
      });
      const detail = await openMusicBrainzProblem({ galleryActions, settingsModalAppBarActions, utilityProblematicFilesActions, utilityTabBarActions },
        'MusicBrainz: Provider unavailable', OUTAGE);
      expect(detail.problemReasons).toContain('MusicBrainz: Provider unavailable');
      const retryStatus = await utilityProblematicFilesActions.readMusicBrainzRetryStatus();
      expect(retryStatus).toMatch(/Last attempt .+ Next retry .+ Configured provider Local metadata service Local library Unaffected/);
      await utilityProblematicFilesActions.retryMusicBrainzIdentity(OUTAGE);
      await utilityProblematicFilesActions.clearProblemFilter('MusicBrainz: Provider unavailable');
      await utilityProblematicFilesActions.search(OUTAGE);
      await utilityProblematicFilesActions.waitForNoSearchResults(OUTAGE);
      await settingsModalAppBarActions.closeSettings();
      await openArtist({ galleryActions, searchToolbarActions }, OUTAGE);
      await expect.poll(() => galleryActions.readArtistContextMetadata(), { timeout: 60000 }).toEqual({
        countries: ['United States'],
        genres: ['rock'],
      });
    });

    await stepLogger.step('MBD1-39: a manually resolved Unconfirmed row stays absent after the re-check projection reloads', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady();
      await utilityProblematicFilesActions.search(UNCONFIRMED);
      await utilityProblematicFilesActions.waitForSearchResults(UNCONFIRMED);
      expect(await utilityProblematicFilesActions.readVisibleListItems()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({
          title: UNCONFIRMED,
          issues: 'Artist · MBID: Unconfirmed match',
        })]),
      );
      await settingsModalAppBarActions.closeSettings();
    });

    await stepLogger.step('MBD1-43: File rating mismatch filters exact rows without changing app ratings', async () => {
      const ratingCases = [
        { artist: 'Arcade Fire', album: 'Reflektor', rating: 6 },
        { artist: 'Orphaned Land', album: 'Mabool: the Story of the Three Sons of Seven', rating: 10 },
      ];
      const before = [];
      for (const ratingCase of ratingCases) {
        await openArtist({ galleryActions, searchToolbarActions }, ratingCase.artist);
        let rating;
        await expect.poll(async () => {
          rating = await galleryActions.readAlbumRatingSurface(ratingCase.artist, ratingCase.album);
          return {
            filledStarCount: rating.filledStarCount,
            colorsReady: Boolean(rating.filledColor && (rating.emptyStarCount === 0 || rating.emptyColor)),
          };
        }, { timeout: 60000 }).toEqual({ filledStarCount: ratingCase.rating, colorsReady: true });
        before.push(rating);
      }
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady();
      await utilityProblematicFilesActions.applySingleProblemFilter('File rating mismatch');
      for (const ratingCase of ratingCases) {
        const detail = await utilityProblematicFilesActions.selectAlbumByTitle(ratingCase.album);
        expect(detail.artist).toBe(ratingCase.artist);
        expect(detail.problemReasons).toContain('File rating mismatch');
      }
      await settingsModalAppBarActions.closeSettings();
      for (let index = 0; index < ratingCases.length; index += 1) {
        const ratingCase = ratingCases[index];
        await openArtist({ galleryActions, searchToolbarActions }, ratingCase.artist);
        await expect.poll(
          () => galleryActions.readAlbumRatingSurface(ratingCase.artist, ratingCase.album),
          { timeout: 60000 },
        ).toEqual(before[index]);
      }
    });
});
