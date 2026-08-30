import { expect, test } from '../support/baseFixtures.js';
import {
  changedId3Frames,
  readGeneratedMp3TagSnapshots,
} from '../helpers/physicalTagHelpers.js';

const ARTIST = 'E2E Rarity Artist';
const ALBUM = 'Auto Number Selected Fixture';
const YEAR = '2026';
const NATURAL_ORDER_ALBUM = 'Natural Filename Order Fixture';
const NATURAL_ORDER_TRACKS = [
  '02 - Numeric Two.mp3',
  '03 - Numeric Three.mp3',
  '10 - Numeric Ten.mp3',
  'Alpha.mp3',
  'Beta.mp3',
];
const INCOMPLETE_NATURAL_ORDER_REASON =
  'Incomplete track order: Disc 1 missing 1, 4, 5, 6, 7, 8, 9';
const TRACKS = Array.from({ length: 18 }, (_, index) => ({
  filename: `${String(index + 1).padStart(2, '0')} - Auto Number Track ${index + 1}.mp3`,
  title: `Auto Number Track ${index + 1}`,
}));
const DISC_TWO_TRACKS = [TRACKS[2], TRACKS[3], TRACKS[4]];
const SAME_DISC_TRACKS = [TRACKS[0], TRACKS[1]];
const GAPPED_TRACKS = [TRACKS[0], TRACKS[5]];
const CROSS_DISC_TRACKS = [TRACKS[16], TRACKS[17], TRACKS[2], TRACKS[3]];
const EXPECTED_VALUES = new Map([
  [TRACKS[16].filename, { discNumber: '1', trackNumber: '7' }],
  [TRACKS[17].filename, { discNumber: '1', trackNumber: '8' }],
  [TRACKS[2].filename, { discNumber: '2', trackNumber: '7' }],
  [TRACKS[3].filename, { discNumber: '2', trackNumber: '8' }],
  [TRACKS[0].filename, { discNumber: '1', trackNumber: '1' }],
  [TRACKS[5].filename, { discNumber: '1', trackNumber: '6' }],
  [TRACKS[4].filename, { discNumber: '2', trackNumber: '5' }],
]);
const ORIGINAL_CROSS_DISC_VALUES = new Map([
  [TRACKS[16].filename, { discNumber: '1', trackNumber: '17' }],
  [TRACKS[17].filename, { discNumber: '1', trackNumber: '18' }],
  [TRACKS[2].filename, { discNumber: '2', trackNumber: '3' }],
  [TRACKS[3].filename, { discNumber: '2', trackNumber: '4' }],
]);
const INVALID_AUTO_NUMBER_STARTS = ['', '0', '-1', '1.5'];

test('FTC-TAGS-022 derives Start at from filename then deterministic editor position', async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}) => {
  await stepLogger.step('Use a leading filename number for one natural-order consecutive range', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await tagEditorActions.openForAlbum({
      album: NATURAL_ORDER_ALBUM,
      artist: ARTIST,
      expectedTrackCount: NATURAL_ORDER_TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(NATURAL_ORDER_TRACKS);
    await tagEditorActions.selectTracksByFilenames(NATURAL_ORDER_TRACKS.slice(0, 2));
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: 2,
      startAt: 2,
      visible: true,
    });
    await tagEditorActions.close();
    await trackModalActions.close();
  });

  await stepLogger.step('Retain the canonical incomplete-order evidence for the generated album', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(NATURAL_ORDER_ALBUM);
    const detail = await utilityProblematicFilesActions.selectAlbumByTitle(NATURAL_ORDER_ALBUM);
    expect(detail.title).toBe(NATURAL_ORDER_ALBUM);
    expect([...new Set(
      detail.problemReasons.filter((reason) => reason.startsWith('Incomplete track order:')),
    )]).toEqual([INCOMPLETE_NATURAL_ORDER_REASON]);
    await settingsModalAppBarActions.closeSettings();
  });

  await stepLogger.step('Use the deterministic editor position when filenames have no leading number', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await tagEditorActions.openForAlbum({
      album: NATURAL_ORDER_ALBUM,
      artist: ARTIST,
      expectedTrackCount: NATURAL_ORDER_TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.selectTracksByFilenames(NATURAL_ORDER_TRACKS.slice(3));
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: 2,
      startAt: 4,
      visible: true,
    });
  });
});

test('FTC-TAGS-022 restarts one consecutive selection for each disc', async ({
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}, testInfo) => {
  await stepLogger.step('Create a second disc through the production tag-save path', async () => {
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await tagEditorActions.openForAlbum({
      album: ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.selectTracksByFilenames(
      DISC_TWO_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.setDiscNumber(2);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
  });

  const beforeAutoNumber = await readGeneratedMp3TagSnapshots({ artist: ARTIST, album: ALBUM });

  await stepLogger.step('Preserve the editor and hide the exact footer group for one or gapped files', async () => {
    await tagEditorActions.openForAlbum({
      album: ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: 1,
      visible: false,
    });
    await tagEditorActions.expectPendingChanges([]);
    await tagEditorActions.selectTracksByFilenames(
      GAPPED_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: GAPPED_TRACKS.length,
      visible: false,
    });
  });

  await stepLogger.step('Show only Start at and Auto-number for a deterministic adjacent range', async () => {
    await tagEditorActions.dragSelectTracksByFilenames(
      SAME_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: SAME_DISC_TRACKS.length,
      startAt: 1,
      visible: true,
    });
    await tagEditorActions.expectAutoNumberToggleState(false);
    await tagEditorActions.expectPendingChanges([]);

    await tagEditorActions.selectTracksByFilenames(
      SAME_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: SAME_DISC_TRACKS.length,
      startAt: 1,
      visible: true,
    });
    await tagEditorActions.expectApprovedAutoNumberStructure();

    await tagEditorActions.selectTracksByFilenames(
      CROSS_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.expectAutoNumberSelectedState({
      selectedCount: CROSS_DISC_TRACKS.length,
      startAt: 17,
      visible: true,
    });
    await tagEditorActions.expectAutoNumberToggleState(false);
  });

  await stepLogger.step('Reject invalid Start at values without staging track changes', async () => {
    for (const invalidStart of INVALID_AUTO_NUMBER_STARTS) {
      await tagEditorActions.expectAutoNumberStartRejected(invalidStart);
    }
  });

  await stepLogger.step('Preserve the approved footer contract at the mobile breakpoint', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await tagEditorActions.expectApprovedAutoNumberStructure();
    await tagEditorActions.expectAutoNumberResponsiveLayout();
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-022-auto-number-mobile.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Preview per-disc numbering on every pending track, restore it, then stage it again', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await tagEditorActions.setAutoNumberStart(7);
    const inactiveBackground = await tagEditorActions.expectAutoNumberToggleState(false);
    await tagEditorActions.autoNumber();
    const activeBackground = await tagEditorActions.expectAutoNumberToggleState(true);
    expect(activeBackground).not.toBe(inactiveBackground);
    await tagEditorActions.expectPendingChanges(
      CROSS_DISC_TRACKS.map((track) => track.filename),
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-022-auto-number-selected.png'),
      fullPage: true,
    });

    const beforeApply = await readGeneratedMp3TagSnapshots({ artist: ARTIST, album: ALBUM });
    expect(changedId3Frames(beforeAutoNumber, beforeApply).every(
      (entry) => entry.changedFrames.length === 0,
    )).toBe(true);

    for (const [filename, expected] of EXPECTED_VALUES) {
      if (CROSS_DISC_TRACKS.some((track) => track.filename === filename)) {
        expect(await tagEditorActions.readTrackNumberAndDiscByFilename(filename)).toEqual(expected);
        await tagEditorActions.expectPendingChanges(
          CROSS_DISC_TRACKS.map((track) => track.filename),
        );
      }
    }

    await tagEditorActions.selectTracksByFilenames(
      CROSS_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.expectAutoNumberToggleState(true);
    await tagEditorActions.autoNumber();
    expect(await tagEditorActions.expectAutoNumberToggleState(false)).toBe(inactiveBackground);
    await tagEditorActions.expectPendingChanges([]);
    for (const [filename, expected] of ORIGINAL_CROSS_DISC_VALUES) {
      expect(await tagEditorActions.readTrackNumberAndDiscByFilename(filename)).toEqual(expected);
    }
    await tagEditorActions.expectPendingChanges([]);

    await tagEditorActions.selectTracksByFilenames(
      CROSS_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.setAutoNumberStart(7);
    await tagEditorActions.expectAutoNumberToggleState(false);
    await tagEditorActions.autoNumber();
    await tagEditorActions.expectAutoNumberToggleState(true);
    await tagEditorActions.expectPendingChanges(
      CROSS_DISC_TRACKS.map((track) => track.filename),
    );
    await tagEditorActions.applyAndWaitForSavedFiles({
      terminalAlertDismissalTimeout: 3500,
    });
    await trackModalActions.closeIfOpen();
  });

  await stepLogger.step('Persist only selected track numbers in generated file tags', async () => {
    const afterAutoNumber = await readGeneratedMp3TagSnapshots({ artist: ARTIST, album: ALBUM });
    const beforeFramesByFilename = new Map(
      beforeAutoNumber.map((snapshot) => [snapshot.filename, snapshot.frames]),
    );
    const changedFrames = changedId3Frames(beforeAutoNumber, afterAutoNumber);
    expect(changedFrames).toHaveLength(TRACKS.length);
    expect(changedFrames.filter((entry) => entry.changedFrames.length > 0)).toEqual(
      CROSS_DISC_TRACKS
        .map((track) => ({ filename: track.filename, changedFrames: ['TRCK'] }))
        .sort((left, right) => left.filename.localeCompare(right.filename)),
    );
    for (const snapshot of afterAutoNumber) {
      const beforeFrames = beforeFramesByFilename.get(snapshot.filename);
      expect(beforeFrames).toBeDefined();
      expect(snapshot.frames.TPOS).toEqual(beforeFrames.TPOS);
      const selectedExpected = EXPECTED_VALUES.get(snapshot.filename);
      if (CROSS_DISC_TRACKS.some((track) => track.filename === snapshot.filename)) {
        expect(snapshot.frames.TRCK).toEqual([selectedExpected.trackNumber]);
      } else {
        expect(snapshot.frames.TRCK).toEqual(beforeFrames.TRCK);
      }
    }
  });

  await stepLogger.step('Retain staged numbering after reopen and in a fresh browser', async () => {
    await tagEditorActions.openForAlbum({
      album: ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions,
      trackModalActions,
      year: YEAR,
    });
    for (const [filename, expected] of EXPECTED_VALUES) {
      expect(await tagEditorActions.readTrackNumberAndDiscByFilename(filename)).toEqual(expected);
    }
    await tagEditorActions.close();
    await trackModalActions.close();

    const session = await freshBrowserSession.create();
    await session.galleryActions.goto('/');
    await session.galleryActions.waitForGalleryReady();
    await session.tagEditorActions.openForAlbum({
      album: ALBUM,
      artist: ARTIST,
      expectedTrackCount: TRACKS.length,
      galleryActions: session.galleryActions,
      trackModalActions: session.trackModalActions,
      year: YEAR,
    });
    for (const [filename, expected] of EXPECTED_VALUES) {
      expect(
        await session.tagEditorActions.readTrackNumberAndDiscByFilename(filename),
      ).toEqual(expected);
    }
  });
});
