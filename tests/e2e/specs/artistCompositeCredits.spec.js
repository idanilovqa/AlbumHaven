import { expect, test } from '../support/baseFixtures.js';
import { expectPostgresBrowse } from '../helpers/artistAliasParityHelpers.js';

const DISPLAY_ARTIST = 'Frank Churchill / Leigh Harline / Larry Morey';
const ALBUM_KEY = 'frank churchill / leigh harline / larry morey::snow white and the seven dwarfs';
const RAW_REPEATED_ARTIST = 'Frank Churchill / Leigh Harline / Larry Morey / Frank Churchill / Larry Morey';
const ALBUM = 'Snow White And The Seven Dwarfs';
const YEAR = '1937';

test('FTC-ARTIST-FAMILY-014 deduplicates the Snow White display credit without changing its click identity', async ({
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open the production app against the isolated Postgres library', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Select the merged composite artist row through its clean tree label', async () => {
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    expect(await navigationPanelActions.readSidebarArtistNameCount(DISPLAY_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistNameCount(RAW_REPEATED_ARTIST)).toBe(0);
    expect(await navigationPanelActions.readSidebarArtistLabelCount(DISPLAY_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistAlbumCount(DISPLAY_ARTIST)).toBe(1);
    expect(await navigationPanelActions.readSidebarArtistLabel(DISPLAY_ARTIST)).toBe(DISPLAY_ARTIST);
    await navigationPanelActions.selectSidebarArtistByName(DISPLAY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(DISPLAY_ARTIST);
    expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(DISPLAY_ARTIST);
    await galleryActions.waitForArtistHeadings([DISPLAY_ARTIST]);
    await galleryActions.waitForAlbumVisible(ALBUM);
    await expectPostgresBrowse(expect, galleryActions);
  });

  await stepLogger.step('Verify the deduplicated display credit and normalized durable album key', async () => {
    const headings = await galleryActions.readArtistHeadings();
    const displayedCredit = await galleryActions.readAlbumCreditByName(ALBUM);
    const displayedMembers = displayedCredit.split('/').map((member) => member.trim());

    expect(headings).toEqual([DISPLAY_ARTIST]);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: DISPLAY_ARTIST,
      album: ALBUM,
      year: YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: RAW_REPEATED_ARTIST,
      album: ALBUM,
      year: YEAR,
    })).toBe(0);
    expect(displayedCredit).toBe(DISPLAY_ARTIST);
    expect(displayedMembers).toEqual(['Frank Churchill', 'Leigh Harline', 'Larry Morey']);
    expect(new Set(displayedMembers).size).toBe(displayedMembers.length);
    expect(await galleryActions.readAlbumYearByName(ALBUM)).toBe(YEAR);
    expect(await galleryActions.readAlbumKeyByName(ALBUM)).toBe(ALBUM_KEY);
    const labels = await galleryActions.readVisibleAlbumLabelsByName(ALBUM);
    expect(labels.titleText).toBe(ALBUM);
    expect(labels.titleVisible).toBe(true);
    expect(labels.artistText).toBe(DISPLAY_ARTIST);
    expect(labels.artistVisible).toBe(true);
    expect(labels.artistLineClamp).toBe('2');
    expect(labels.artistOverflow).toBe('hidden');
    expect(labels.artistRenderedLineCount).toBeLessThanOrEqual(2);
  });

  await stepLogger.step('Open the album through its visible title and retain the legitimate composite identity', async () => {
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(DISPLAY_ARTIST, ALBUM);
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(`${DISPLAY_ARTIST} - ${ALBUM} - ${YEAR}`);
    await trackModalActions.close();
  });
});
