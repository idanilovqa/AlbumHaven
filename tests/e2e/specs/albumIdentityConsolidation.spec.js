import { expect, test } from '../support/baseFixtures.js';
import { restoreDdtStudioRecordsFixture } from '../helpers/ddtStudioRecordsFixture.js';
import { readGeneratedMp3TagSnapshots } from '../helpers/physicalTagHelpers.js';
import { queryPersistedAlbumIdentity } from '../helpers/postgresAlbumIdentityHelpers.js';
import { prepareConsolidatedProblematicRelease } from '../actions/albumIdentityProblemSetupActions.js';
import {
  captureRendererCheckpoint,
  findLogicalAlbum,
  waitForPositiveLogicalAlbumTrackCounts,
} from '../helpers/rendererReconciliationHelpers.js';

const ARTIST = 'ДДТ';
const SOURCE_ALBUM = 'Студийные записи';
const TEMPORARY_ALBUM = 'Студийные записи merge candidate';
const FIXTURE_YEAR = '1999';
const YEAR = '1988';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(ARTIST)}`;
const TRACKS = Array.from({ length: 16 }, (_, index) => ({
  filename: `${String(index + 1).padStart(2, '0')}. Студийная запись ${index + 1}.mp3`,
  title: `Студийная запись ${index + 1}`,
}));
const SPLIT_TRACKS = TRACKS.slice(13);
const EXPECTED_MISSING_ORDER_REASON = 'Incomplete track order: Disc 1 missing 14, 17';
const EXPECTED_MISSING_NUMBER_REASON = 'Missing track number';
const EXPECTED_MISSING_COVER_REASON = 'Missing cover art';
const EXPECTED_PROBLEM_REASONS = [
  EXPECTED_MISSING_COVER_REASON,
  EXPECTED_MISSING_ORDER_REASON,
  EXPECTED_MISSING_NUMBER_REASON,
].sort();
const EXPECTED_TRACK_PROBLEM_REASONS = [
  EXPECTED_MISSING_ORDER_REASON,
  EXPECTED_MISSING_NUMBER_REASON,
].sort();
const EXPECTED_NUMBER_ORDER = [
  ...TRACKS.slice(0, 13),
  TRACKS[15],
  TRACKS[13],
  TRACKS[14],
];

test.afterEach(async ({ managedAppLifecycle }) => {
  await restoreDdtStudioRecordsFixture();
  await managedAppLifecycle.restart();
});

test('FTC-TAGS-021 and FTC-ALBUM-DETAILS-018 consolidate one logical release', async ({
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}, testInfo) => {
  test.setTimeout(240000);
  const checkpoints = [];

  await stepLogger.step('Set the reported release year on the complete source album', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await tagEditorActions.openForAlbum({
      album: SOURCE_ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions,
      trackModalActions,
      year: FIXTURE_YEAR,
    });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setYear(YEAR);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(ARTIST, SOURCE_ALBUM, { year: YEAR });
  });

  await stepLogger.step('Create a second durable release identity through the normal tag editor', async () => {
    await tagEditorActions.openForAlbum({
      album: SOURCE_ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.selectTracksByFilenames(SPLIT_TRACKS.map((track) => track.filename));
    await tagEditorActions.setAlbumName(TEMPORARY_ALBUM);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: ARTIST,
      album: SOURCE_ALBUM,
      year: YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: ARTIST,
      album: TEMPORARY_ALBUM,
      year: YEAR,
    })).toBe(1);
  });

  await stepLogger.step('Create a numbering gap and a distinct missing-number problem', async () => {
    await tagEditorActions.openForAlbum({
      album: TEMPORARY_ALBUM,
      artist: ARTIST,
      expectedTrackCount: SPLIT_TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.selectTrackByFilename(SPLIT_TRACKS[0].filename);
    await tagEditorActions.setTrackNumber(18);
    await tagEditorActions.selectTrackByFilename(SPLIT_TRACKS[1].filename);
    await tagEditorActions.setTrackNumber('');
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
  });

  await stepLogger.step('Merge the split identity back and capture the complete immediate gallery', async () => {
    await tagEditorActions.openForAlbum({
      album: TEMPORARY_ALBUM,
      artist: ARTIST,
      expectedTrackCount: SPLIT_TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(SOURCE_ALBUM);
    const accepted = await tagEditorActions.applyAndReturnAcceptedEdit();
    await trackModalActions.closeIfOpen();
    const immediate = await captureRendererCheckpoint({
      artist: ARTIST,
      galleryActions,
      page,
      screenshotPath: testInfo.outputPath('ftc-tags-021-immediate-gallery.png'),
    });
    checkpoints.push({ phase: 'immediate', ...immediate });
    expect(
      immediate.logical.filter((album) => album.name === SOURCE_ALBUM),
    ).toHaveLength(1);
    expect(findLogicalAlbum(immediate, SOURCE_ALBUM)?.trackCount).toBe(TRACKS.length);
    expect(
      immediate.mounted.filter((album) => (
        album.album === SOURCE_ALBUM && String(album.year) === YEAR
      )),
    ).toHaveLength(1);
    await page.waitForTimeout(20000);
    const delayed = await captureRendererCheckpoint({
      artist: ARTIST,
      galleryActions,
      page,
      screenshotPath: testInfo.outputPath('ftc-tags-021-after-20-seconds-gallery.png'),
    });
    checkpoints.push({ phase: 'after-20-seconds', ...delayed });
    expect(
      delayed.logical.filter((album) => album.name === SOURCE_ALBUM),
    ).toHaveLength(1);
    expect(findLogicalAlbum(delayed, SOURCE_ALBUM)?.trackCount).toBe(TRACKS.length);
    expect(
      delayed.mounted.filter((album) => (
        album.album === SOURCE_ALBUM && String(album.year) === YEAR
      )),
    ).toHaveLength(1);
    expect(delayed.logical).toEqual(immediate.logical);
    expect(delayed.mounted).toEqual(immediate.mounted);
    await accepted.waitForCompletion({ timeout: 90000 });
    const postgresIdentity = await queryPersistedAlbumIdentity({
      album: SOURCE_ALBUM,
      artist: ARTIST,
      year: YEAR,
    });
    expect(postgresIdentity.album_ids).toHaveLength(1);
    expect(postgresIdentity.album_ids[0]).toEqual(expect.any(Number));
    expect(postgresIdentity.album_keys).toHaveLength(1);
    expect(postgresIdentity.track_counts).toEqual([TRACKS.length]);
  });

  await stepLogger.step('Show one 16-track release without a redundant Original tab', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: ARTIST,
      album: SOURCE_ALBUM,
      year: YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(TRACKS.length);
    const labels = await trackModalActions.readReleaseTabLabels();
    expect(labels).not.toContain(`Original - ${YEAR}`);
    expect(labels).toEqual([]);
    expect(await trackModalActions.readTrackTitles()).toEqual(
      EXPECTED_NUMBER_ORDER.map((track) => track.title),
    );
    await trackModalActions.close();
  });

  await stepLogger.step('Retain the consolidated release in a fresh browser', async () => {
    const session = await freshBrowserSession.create();
    await session.galleryActions.goto(ARTIST_VIEW_URL);
    await session.galleryActions.waitForGalleryReady();
    await waitForPositiveLogicalAlbumTrackCounts({
      artist: ARTIST,
      expectedAlbum: {
        artist: ARTIST,
        album: SOURCE_ALBUM,
        year: YEAR,
        trackCount: TRACKS.length,
      },
      expectedLogicalCount: 60,
      galleryActions: session.galleryActions,
      page: session.page,
    });
    await session.galleryActions.selectAlbumDetailsByIdentity({
      artist: ARTIST,
      album: SOURCE_ALBUM,
      year: YEAR,
    });
    expect((await session.trackModalActions.waitForInteractiveSummary()).trackRows)
      .toBe(TRACKS.length);
    expect(await session.trackModalActions.readReleaseTabLabels()).toEqual([]);

    await session.trackModalActions.openTagEditor();
    await session.tagEditorActions.waitForOpen({ expectedTrackCount: TRACKS.length });
    await session.tagEditorActions.selectAllTracks();
    await session.tagEditorActions.setYear(FIXTURE_YEAR);
    await session.tagEditorActions.selectTrackByFilename(TRACKS[13].filename);
    await session.tagEditorActions.setTrackNumber(14);
    await session.tagEditorActions.selectTrackByFilename(TRACKS[14].filename);
    await session.tagEditorActions.setTrackNumber(15);
    await session.tagEditorActions.applyAndWaitForSavedFiles();
    await session.trackModalActions.waitForExactAlbumDetails({
      title: `${ARTIST} - ${SOURCE_ALBUM} - ${FIXTURE_YEAR}`,
      trackTitles: TRACKS.map((track) => track.title),
      displayedTrackNumbers: TRACKS.map((_track, index) => index + 1),
    });
    const physicalTags = await readGeneratedMp3TagSnapshots({
      artist: ARTIST,
      album: SOURCE_ALBUM,
    });
    expect(
      physicalTags.find((track) => track.filename === TRACKS[13].filename)?.frames.TRCK,
    ).toEqual(['14']);
    expect(
      physicalTags.find((track) => track.filename === TRACKS[14].filename)?.frames.TRCK,
    ).toEqual(['15']);
  });

  testArtifacts.queueJsonAttachment(
    'ftc-tags-021-logical-release-checkpoints',
    checkpoints,
  );
});

test('FTC-UTIL-PROBLEMS-013 shows one logical album with exact scoped reasons and tracks', async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  await prepareConsolidatedProblematicRelease({
    artist: ARTIST,
    artistViewUrl: ARTIST_VIEW_URL,
    fixtureYear: FIXTURE_YEAR,
    galleryActions,
    sourceAlbum: SOURCE_ALBUM,
    splitTracks: SPLIT_TRACKS,
    stepLogger,
    tagEditorActions,
    temporaryAlbum: TEMPORARY_ALBUM,
    trackModalActions,
    tracks: TRACKS,
    year: YEAR,
  });

  await stepLogger.step('Inspect the logical album problem layout and complete Edit Tags order', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(SOURCE_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(SOURCE_ALBUM);
    expect(await utilityProblematicFilesActions.readVisibleResultCount()).toBe(1);
    const summary = await utilityProblematicFilesActions.selectAlbumByTitle(SOURCE_ALBUM);
    expect([...new Set(summary.problemReasons)].sort()).toEqual(EXPECTED_PROBLEM_REASONS);
    expect(summary.issueCount).toBe(EXPECTED_PROBLEM_REASONS.length);
    const approvedLayout = await utilityProblematicFilesActions.readApprovedDetectedProblemsLayout();
    expect(approvedLayout.albumHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(approvedLayout.trackHeadingIndex).toBeGreaterThan(approvedLayout.albumHeadingIndex);
    expect(approvedLayout.trackRowCount).toBe(TRACKS.length);
    expect([...new Set(approvedLayout.albumReasons)].sort()).toEqual([
      EXPECTED_MISSING_COVER_REASON,
    ]);
    expect(approvedLayout.headers).toEqual(['Filename', 'Reason']);
    expect(approvedLayout.rows).toHaveLength(TRACKS.length);
    expect(approvedLayout.rows.every((row) => (
      row.cells.length === 2
      && row.cells[0].column === 'filename'
      && row.cells[1].column === 'reason'
    ))).toBe(true);
    expect(new Set(approvedLayout.reasonOrigins).size).toBe(1);
    expect(approvedLayout.forbiddenCount).toBe(0);
    expect(approvedLayout.pageOverflow).toBeLessThanOrEqual(0);
    const detectedRows = await utilityProblematicFilesActions.readDetectedTrackRows();
    expect(detectedRows).toHaveLength(TRACKS.length);
    expect(detectedRows.map((row) => row.filename)).toEqual(
      EXPECTED_NUMBER_ORDER.map((track) => track.filename),
    );
    expect(detectedRows.every((row) => row.path && row.reasons.length > 0)).toBe(true);
    expect(
      detectedRows
        .filter((row) => row.reasons.includes(EXPECTED_MISSING_NUMBER_REASON))
        .map((row) => row.filename),
    ).toEqual([SPLIT_TRACKS[1].filename]);
    expect([...new Set(detectedRows.flatMap((row) => row.reasons))].sort())
      .toEqual(EXPECTED_TRACK_PROBLEM_REASONS);
    await utilityProblematicFilesActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: TRACKS.length });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      EXPECTED_NUMBER_ORDER.map((track) => track.filename),
    );
  });
});

test('FTC-UTIL-PROBLEMS-007 preserves the selected list during mutation and removes stale identity', async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
  utilityRulesActions,
  utilityTabBarActions,
}) => {
  test.setTimeout(240000);
  await prepareConsolidatedProblematicRelease({
    artist: ARTIST,
    artistViewUrl: ARTIST_VIEW_URL,
    fixtureYear: FIXTURE_YEAR,
    galleryActions,
    sourceAlbum: SOURCE_ALBUM,
    splitTracks: SPLIT_TRACKS,
    stepLogger,
    tagEditorActions,
    temporaryAlbum: TEMPORARY_ALBUM,
    trackModalActions,
    tracks: TRACKS,
    year: YEAR,
  });

  await stepLogger.step('Repair the selected album through the approved detail-only mutation state', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(SOURCE_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(SOURCE_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(SOURCE_ALBUM);
    await utilityProblematicFilesActions.selectAlbumProblem(EXPECTED_MISSING_COVER_REASON);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    await utilityProblematicFilesActions.confirmExclusion();
    await utilityProblematicFilesActions.clearSearch();
    await utilityProblematicFilesActions.waitForSelectedDetailSelection({ expectedTitle: SOURCE_ALBUM });
    const mutationTarget = await utilityProblematicFilesActions.prepareSelectedMutationContinuity();
    await utilityProblematicFilesActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: TRACKS.length });
    await tagEditorActions.selectTrackByFilename(TRACKS[13].filename);
    await tagEditorActions.setTrackNumber(14);
    await tagEditorActions.selectTrackByFilename(TRACKS[14].filename);
    await tagEditorActions.setTrackNumber(15);
    const pendingContinuityPromise = utilityProblematicFilesActions
      .waitForMutationOverlayAndReadContinuity();
    const acceptedRepair = await tagEditorActions.applyAndReturnAcceptedEdit();
    const pendingContinuity = await pendingContinuityPromise;
    expect(pendingContinuity).toMatchObject({
      listMutations: 0,
      sameNodes: true,
      sameOrder: true,
      sameText: true,
      overlayText: 'Hold on. Your changes are being applied',
      spinnerCount: 1,
      detailBusy: 'true',
    });
    expect(Math.abs(pendingContinuity.scrollTop - pendingContinuity.expectedScrollTop))
      .toBeLessThanOrEqual(1);
    await acceptedRepair.waitForCompletion({ timeout: 90000 });
    const previousSelection = await utilityProblematicFilesActions
      .waitForMutationRemovalAndPreviousSelection(mutationTarget);
    expect(previousSelection).toEqual({
      key: mutationTarget.previousKey,
      title: mutationTarget.previousTitle,
    });
    expect(await utilityProblematicFilesActions.readVisibleListItems()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: mutationTarget.removedKey })]),
    );
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    await utilityRulesActions.revertRuleContaining(SOURCE_ALBUM);
    await settingsModalAppBarActions.closeSettings();
  });
});
