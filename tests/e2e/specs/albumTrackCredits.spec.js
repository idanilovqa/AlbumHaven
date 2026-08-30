import { expect, test } from '../support/baseFixtures.js';
import { holdStructuralSavePersistence } from '../helpers/structuralSavePollWindowHelpers.js';

const ALBUM_ARTIST = 'Various Artists';
const ALBUM = 'Featured Signal Collection';
const TRACK_CREDIT_TRACK_COUNT = 18;
const EXPECTED_TRACK_CREDITS = [
  {
    rawTitle: 'Clean Signal (feat. Featured Voice)',
    rawArtist: 'Solo Voice',
    title: 'Clean Signal',
    secondaryArtist: 'Solo Voice / feat. Featured Voice',
  },
  {
    rawTitle: 'Bright Signal featured Guest Two',
    rawArtist: 'Ensemble Two',
    title: 'Bright Signal',
    secondaryArtist: 'Ensemble Two / feat. Guest Two',
  },
  {
    rawTitle: 'Deep Signal featuring Guest Three',
    rawArtist: 'Ensemble Three',
    title: 'Deep Signal',
    secondaryArtist: 'Ensemble Three / feat. Guest Three',
  },
  {
    rawTitle: 'Open Signal feature Guest Four',
    rawArtist: 'Ensemble Four',
    title: 'Open Signal',
    secondaryArtist: 'Ensemble Four / feat. Guest Four',
  },
  {
    rawTitle: 'Man and Machine',
    rawArtist: 'U.D.O.',
    title: 'Man and Machine',
    secondaryArtist: 'U.D.O.',
  },
];
const ORDINARY_ALBUM_ARTIST = 'Ария';
const ORDINARY_ALBUM = 'Штиль Feature Credit';
const ORDINARY_TRACK_CREDITS = [
  {
    rawTitle: 'Штиль (feat. U.D.O.)',
    rawArtist: ORDINARY_ALBUM_ARTIST,
    title: 'Штиль',
    secondaryArtist: 'feat. U.D.O.',
  },
  {
    rawTitle: 'Штиль',
    rawArtist: `${ORDINARY_ALBUM_ARTIST}, U.D.O.`,
    title: 'Штиль',
    secondaryArtist: `${ORDINARY_ALBUM_ARTIST}, U.D.O.`,
  },
];
const DUPLICATE_HEADER_ALBUM = 'Snow White And The Seven Dwarfs';
const DUPLICATE_HEADER_YEAR = '1937';
const DISTINCT_HEADER_ARTISTS = [
  'Frank Churchill',
  'Leigh Harline',
  'Larry Morey',
];
const DISTINCT_HEADER_ARTIST_DISPLAY = DISTINCT_HEADER_ARTISTS.join(' / ');
const TRACK_ORDER_ALBUM_ARTIST = 'E2E Rarity Artist';
const TRACK_ORDER_ALBUM = 'Natural Filename Order Fixture';
const TRACK_ORDER_EXPECTED_TITLES = [
  'Numeric Two',
  'Numeric Three',
  'Numeric Ten',
  'Alpha',
  'Beta',
];
const BONUS_DURATION_FALSE_POSITIVE_ALBUM = 'Rarity Outtakes Archive';
const BONUS_DURATION_CONTROL_ALBUM = 'Explicit Disc Label Control';
const BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM = 'Ordinary Numeric Disc Control';
const OPTIMISTIC_SPLIT_ALBUM = `${ALBUM} Split Credit`;
const FIRST_TRACK_FILENAME = '01 - Credit Signal 1.mp3';

test('FTC-ALBUM-TRACK-CREDITS-001 shows clean titles and per-track credits on a Various Artists release', async ({
  artistFamilyActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Find the persisted Various Artists fixture through normal album search', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisible(ALBUM);
    expect(await galleryActions.readAlbumCreditByName(ALBUM)).toBe(ALBUM_ARTIST);
  });

  await stepLogger.step('Open album details and verify the server-owned track-row presentation', async () => {
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ALBUM_ARTIST} - ${ALBUM}`);
    expect(summary.trackRows).toBeGreaterThanOrEqual(EXPECTED_TRACK_CREDITS.length);
    const credits = await trackModalActions.readTrackCredits(EXPECTED_TRACK_CREDITS.length);
    expect(credits).toEqual(EXPECTED_TRACK_CREDITS);
    const colors = await trackModalActions.readTrackCreditColorsAt(0);
    expect(colors.title).toBe('rgb(245, 247, 251)');
    expect(colors.title).not.toBe(colors.secondaryArtist);
    expect(colors.secondaryArtist).toBe('rgb(121, 191, 232)');
    await trackModalActions.close();
  });

  await stepLogger.step('Verify an ordinary album labels title and artist guest markers without changing playback metadata', async () => {
    await searchToolbarActions.search(ORDINARY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ORDINARY_ALBUM);
    await galleryActions.waitForAlbumVisible(ORDINARY_ALBUM);
    expect(await galleryActions.readAlbumCreditByName(ORDINARY_ALBUM)).toBe(ORDINARY_ALBUM_ARTIST);
    await galleryActions.clickAlbumDetailsByAlbumName(ORDINARY_ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ORDINARY_ALBUM_ARTIST} - ${ORDINARY_ALBUM}`);
    const credits = await trackModalActions.readTrackCredits(ORDINARY_TRACK_CREDITS.length);
    expect(credits).toEqual(ORDINARY_TRACK_CREDITS);
    await trackModalActions.close();
  });

  await stepLogger.step('Keep title-derived guests and composite credits out of Artist Family', async () => {
    await navigationPanelActions.selectSidebarArtistByName(ORDINARY_ALBUM_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(ORDINARY_ALBUM_ARTIST);
    const familyPanel = await artistFamilyActions.readPanelState();
    expect(familyPanel.chipTexts).not.toContain('U.D.O.');
    expect(familyPanel.chipTexts).not.toContain(`${ORDINARY_ALBUM_ARTIST} feat. U.D.O.`);
    expect(familyPanel.chipTexts).not.toContain(`${ORDINARY_ALBUM_ARTIST}, U.D.O.`);
  });
});

test('FTC-ALBUM-DETAILS-006 preserves mixed credits through an optimistic album-only split', async ({
  galleryActions,
  page,
  searchToolbarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  let persistenceGate = null;
  let splitMayHaveBeenAccepted = false;
  const expected = {
    destination: {
      credits: [EXPECTED_TRACK_CREDITS[0]],
      trackRows: 1,
    },
    source: {
      credits: EXPECTED_TRACK_CREDITS.slice(1),
      trackRows: TRACK_CREDIT_TRACK_COUNT - 1,
    },
  };
  const readSplitCredits = () => trackModalActions.readAlbumSplitCredits({
    destinationCreditCount: 1,
    destinationAlbum: OPTIMISTIC_SPLIT_ALBUM,
    destinationTrackCount: 1,
    galleryActions,
    sourceCreditCount: EXPECTED_TRACK_CREDITS.length - 1,
    sourceAlbum: ALBUM,
    sourceTrackCount: TRACK_CREDIT_TRACK_COUNT - 1,
  });

  try {
    await stepLogger.step('Stage one album-only split through the visible Edit Tags controls', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(ALBUM);
      await galleryActions.waitForAlbumVisible(ALBUM);
      await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
      await trackModalActions.waitForLoadedSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: TRACK_CREDIT_TRACK_COUNT });
      expect(await tagEditorActions.readSelectedTrackFilenames()).toEqual([
        FIRST_TRACK_FILENAME,
      ]);
      await tagEditorActions.setAlbumName(OPTIMISTIC_SPLIT_ALBUM);
      persistenceGate = await holdStructuralSavePersistence();
    });

    await stepLogger.step('Keep source and destination server-owned credits before save completion', async () => {
      splitMayHaveBeenAccepted = true;
      const accepted = await tagEditorActions.applyAndWaitForTerminalSavedResponse({
        whilePostInFlight: async ({ isPostSettled }) => {
          expect(isPostSettled()).toBe(false);
          expect(await readSplitCredits()).toEqual(expected);
          expect(isPostSettled()).toBe(false);
          await persistenceGate.release();
          persistenceGate = null;
        },
      });
      expect(accepted.saveTaskId).not.toBe('');
      expect(await readSplitCredits()).toEqual(expected);
    });

    await stepLogger.step('Retain the same credits after authoritative save completion', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      expect(await readSplitCredits()).toEqual(expected);
    });
  } finally {
    if (persistenceGate) {
      await persistenceGate.release();
      persistenceGate = null;
    }
    if (splitMayHaveBeenAccepted) {
      await trackModalActions.restoreAlbumSplitIfVisible({
        destinationAlbum: OPTIMISTIC_SPLIT_ALBUM,
        galleryActions,
        sourceAlbum: ALBUM,
        tagEditorActions,
      });
    }
  }
});

test('FTC-PLAYER-012 reopens a Various Artists album from player artwork after playing a credited track', async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  let playedTrack;

  await stepLogger.step('Start the Solo Voice track from the generated Various Artists album', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisible(ALBUM);
    expect(await galleryActions.readAlbumCreditByName(ALBUM)).toBe(ALBUM_ARTIST);
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ALBUM_ARTIST} - ${ALBUM}`);
    const playbackMark = await playbackEvidence.playbackMark();
    playedTrack = await trackModalActions.playTrackAt(0);
    expect(playedTrack.artist).toBe('Solo Voice');
    await globalPlayerActions.waitForCurrentTrack({
      path: playedTrack.path,
      trackTitle: playedTrack.title,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: playedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Close album details and reopen the same Various Artists album from player artwork', async () => {
    await trackModalActions.close();
    await globalPlayerActions.openCurrentAlbumFromCover();
    const reopened = await trackModalActions.waitForLoadedSummary();
    expect(reopened.title).toContain(`${ALBUM_ARTIST} - ${ALBUM}`);
    expect((await trackModalActions.readTrackAt(0)).path).toBe(playedTrack.path);
  });
});

test('FTC-ALBUM-TRACK-CREDITS-002 shows each normalized album-header artist once', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Find the Postgres album whose stored display credit repeats artists', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(DUPLICATE_HEADER_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(DUPLICATE_HEADER_ALBUM);
    await galleryActions.waitForAlbumVisible(DUPLICATE_HEADER_ALBUM);
  });

  await stepLogger.step('Open Album Details without repeating the album credit on each track', async () => {
    await galleryActions.clickAlbumDetailsByAlbumName(DUPLICATE_HEADER_ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toBe(
      `${DISTINCT_HEADER_ARTIST_DISPLAY} - ${DUPLICATE_HEADER_ALBUM} - ${DUPLICATE_HEADER_YEAR}`,
    );
    const [rawTrack, visibleCredit] = await Promise.all([
      trackModalActions.readTrackAt(0),
      trackModalActions.readTrackCreditAt(0),
    ]);
    expect(rawTrack.artist).toBe(DISTINCT_HEADER_ARTIST_DISPLAY);
    expect(visibleCredit.secondaryArtist).toBe('');
  });
});

test('FTC-ALBUM-DETAILS-017 orders missing track numbers by natural filename', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open the generated missing-track-number album through normal search', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(TRACK_ORDER_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(TRACK_ORDER_ALBUM);
    await galleryActions.waitForAlbumVisible(TRACK_ORDER_ALBUM);
    expect(await galleryActions.readAlbumCreditByName(TRACK_ORDER_ALBUM))
      .toBe(TRACK_ORDER_ALBUM_ARTIST);
    await galleryActions.clickAlbumDetailsByAlbumName(TRACK_ORDER_ALBUM);
  });

  await stepLogger.step('Verify natural filename order when positive track numbers are absent', async () => {
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${TRACK_ORDER_ALBUM_ARTIST} - ${TRACK_ORDER_ALBUM}`);
    const titles = await Promise.all(
      Array.from({ length: summary.trackRows }, (_, index) => (
        trackModalActions.readTrackAt(index).then((track) => track.title)
      )),
    );
    expect(titles).toEqual(TRACK_ORDER_EXPECTED_TITLES);
  });
});

test('FTC-ALBUM-DETAILS-005 shows bonus duration only for an explicit bonus-disc label', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open a mixed album with an explicit raw bonus-disc label', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(BONUS_DURATION_CONTROL_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(BONUS_DURATION_CONTROL_ALBUM);
    await galleryActions.waitForAlbumVisible(BONUS_DURATION_CONTROL_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(BONUS_DURATION_CONTROL_ALBUM);
    await trackModalActions.waitForLoadedSummary();
  });

  await stepLogger.step('Show the exact main-album and bonus-disc durations', async () => {
    const groups = await trackModalActions.readDiscGroupPresentation();
    expect(groups.headers).toHaveLength(2);
    expect(groups.headers[0]).toBe('CD1');
    expect(groups.headers[1]).toContain('Bonus Disc');
    expect(groups.totals).toEqual([
      'Total Length: 3:00',
      'Bonus Disc Length: 22:30',
    ]);
    expect(await trackModalActions.readFooterLines()).toEqual([
      'Total Main Album Length: 3:00',
      'Bonus Disc Length: 22:30',
    ]);
  });
});

test('FTC-ALBUM-DETAILS-005 ignores bonus-like album and path words', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open an ordinary album whose title and path contain bonus-like words', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(BONUS_DURATION_FALSE_POSITIVE_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(BONUS_DURATION_FALSE_POSITIVE_ALBUM);
    await galleryActions.waitForAlbumVisible(BONUS_DURATION_FALSE_POSITIVE_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(BONUS_DURATION_FALSE_POSITIVE_ALBUM);
    await trackModalActions.waitForLoadedSummary();
  });

  await stepLogger.step('Show only the ordinary album total', async () => {
    expect(await trackModalActions.readDiscGroupPresentation()).toEqual({
      headers: [],
      totals: [],
    });
    expect(await trackModalActions.readFooterLines()).toEqual([
      'Total Length: 18m 00s',
    ]);
  });
});

test('FTC-ALBUM-DETAILS-005 infers CD1 beside an ordinary numeric CD2', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}) => {
  await stepLogger.step('Open a numeric two-disc album whose first tracks omit disc tags', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(
      BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM,
      { submitWithEnter: true },
    );
    await searchToolbarActions.waitForQuery(BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM);
    await galleryActions.waitForAlbumVisible(BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(BONUS_DURATION_NUMERIC_MULTIDISC_ALBUM);
    await trackModalActions.waitForLoadedSummary();
  });

  await stepLogger.step('Render inferred CD1 and numeric CD2 without bonus semantics', async () => {
    expect(await trackModalActions.readDiscGroupPresentation()).toEqual({
      headers: ['CD1', 'CD2'],
      totals: ['Total Length: 3:00', 'Total Length: 15:00'],
    });
    expect(await trackModalActions.readFooterLines()).toEqual([
      'Total Length: 18m 00s',
    ]);
  });
});
