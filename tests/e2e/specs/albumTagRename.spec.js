import { expect, test } from '../support/baseFixtures.js';
import {
  readGeneratedMp3AlbumTags,
  readGeneratedMp3TagSnapshots,
} from '../helpers/physicalTagHelpers.js';
import { temporarilyRevokeRuntimeDeletePrivileges } from '../helpers/postgresPrivilegeHelpers.js';
import { holdStructuralSavePersistence } from '../helpers/structuralSavePollWindowHelpers.js';

const FIXTURE_ARTIST = 'E2E Rarity Artist';
const ORIGINAL_ALBUM = 'Queued Album Rename Fixture';
const RENAMED_ALBUM = 'Durable Album Rename Fixture';
const POLL_WINDOW_ALBUM = 'Poll Window Album Rename Fixture';
const FIXTURE_YEAR = '2026';
const RENAMED_YEAR = '2027';
const FAILURE_FIXTURE_ALBUM = 'Two Track Rarity Fixture';
const FAILURE_FIXTURE_TRACK = '01 - Apply Rarity Here.mp3';
const FIXTURE_TRACK_COUNT = 18;
const EXPECTED_FIXTURE_FILENAMES = Array.from(
  { length: FIXTURE_TRACK_COUNT },
  (_, index) => `${String(index + 1).padStart(2, '0')} - Rename Track ${index + 1}.mp3`,
);
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(FIXTURE_ARTIST)}`;
const albumDetailsTitle = (albumName, year = FIXTURE_YEAR) => (
  `${FIXTURE_ARTIST} - ${albumName} - ${year}`
);
const SPLIT_ORIGINAL_ALBUM = 'Selected Track Split Fixture';
const SPLIT_RENAMED_ALBUM = 'Selected Track Split Fixture 2';
const SPLIT_SECOND_RENAMED_ALBUM = 'Selected Track Split Result B';
const SPLIT_SELECTED_FILENAME = '01 - Split Track 1.mp3';
const SPLIT_SECOND_SELECTED_FILENAME = '02 - Split Track 2.mp3';
const NAVIGATION_FIXTURE_ARTIST = 'Neal Morse';
const NAVIGATION_FIXTURE_ALBUM = 'Neal Morse Plays Pink Floyd';
const NAVIGATION_FIXTURE_TRACK = 'Comfortably Numb';
const EXPECTED_SPLIT_TRACK_TITLES = Array.from(
  { length: FIXTURE_TRACK_COUNT },
  (_, index) => `Split Track ${index + 1}`,
);

test('FTC-TAGS-008 completes an album rename before reporting the save task complete', async ({
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  let freshSession = null;
  await stepLogger.step('Open the generated MP3 album from its selected-artist gallery', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, ORIGINAL_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(albumDetailsTitle(ORIGINAL_ALBUM));
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
  });

  await stepLogger.step('Rename and re-year every file through one task notification lifecycle', async () => {
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(RENAMED_ALBUM);
    await tagEditorActions.setYear(RENAMED_YEAR);
    const { result } = await tagEditorActions.observeTaskNotificationLifecycleDuring(
      () => tagEditorActions.applyAndWaitForSavedFiles(),
    );
    expect(String(result.save_task_id || '').trim()).not.toBe('');
    expect(result.save_task_status).toBe('completed');
    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
    });
    const sortedPhysicalTags = [...physicalTags].sort((left, right) => (
      left.filename.localeCompare(right.filename)
    ));
    expect(sortedPhysicalTags.map((track) => track.filename)).toEqual(EXPECTED_FIXTURE_FILENAMES);
    for (const track of sortedPhysicalTags) {
      expect(track.albumValues).toEqual([RENAMED_ALBUM]);
    }
    const physicalSnapshots = await readGeneratedMp3TagSnapshots({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
    });
    for (const snapshot of physicalSnapshots) {
      expect(snapshot.frames.TDRC).toEqual([RENAMED_YEAR]);
    }
    const summary = await trackModalActions.waitForTitle(
      albumDetailsTitle(RENAMED_ALBUM, RENAMED_YEAR),
    );
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
  });

  await stepLogger.step('Show the renamed album in the current gallery and Album Details', async () => {
    await trackModalActions.close();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, RENAMED_ALBUM);
    await galleryActions.waitForAlbumHidden(ORIGINAL_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: RENAMED_ALBUM,
      year: RENAMED_YEAR,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(albumDetailsTitle(RENAMED_ALBUM, RENAMED_YEAR));
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
    await trackModalActions.close();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(0);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: RENAMED_ALBUM,
      year: RENAMED_YEAR,
    })).toBe(1);
  });

  await stepLogger.step('Reload and open a fresh browser on the renamed Postgres state', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, RENAMED_ALBUM);
    await galleryActions.waitForAlbumHidden(ORIGINAL_ALBUM);
    freshSession = await freshBrowserSession.create();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    await freshSession.galleryActions.waitForAlbumVisibleUnderHeading(
      FIXTURE_ARTIST,
      RENAMED_ALBUM,
    );
    await freshSession.galleryActions.waitForAlbumHidden(ORIGINAL_ALBUM);
    await freshSession.galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: RENAMED_ALBUM,
      year: RENAMED_YEAR,
    });
    const summary = await freshSession.trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(albumDetailsTitle(RENAMED_ALBUM, RENAMED_YEAR));
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
  });

  await stepLogger.step('Reverse the album name and year through a second task lifecycle', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: RENAMED_ALBUM,
      year: RENAMED_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(RENAMED_ALBUM, RENAMED_YEAR),
      trackTitles: Array.from(
        { length: FIXTURE_TRACK_COUNT },
        (_, index) => `Rename Track ${index + 1}`,
      ),
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(ORIGINAL_ALBUM);
    await tagEditorActions.setYear(FIXTURE_YEAR);
    const { result } = await tagEditorActions.observeTaskNotificationLifecycleDuring(
      () => tagEditorActions.applyAndWaitForSavedFiles(),
    );
    expect(String(result.save_task_id || '').trim()).not.toBe('');
    expect(result.save_task_status).toBe('completed');
    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
    });
    expect(physicalTags.map((track) => track.filename)).toEqual(EXPECTED_FIXTURE_FILENAMES);
    for (const track of physicalTags) expect(track.albumValues).toEqual([ORIGINAL_ALBUM]);
    const physicalSnapshots = await readGeneratedMp3TagSnapshots({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
    });
    for (const snapshot of physicalSnapshots) {
      expect(snapshot.frames.TDRC).toEqual([FIXTURE_YEAR]);
    }
    const summary = await trackModalActions.waitForTitle(albumDetailsTitle(ORIGINAL_ALBUM));
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
  });

  await stepLogger.step('Reject the forward alias after reverse in current, reload, and fresh views', async () => {
    await trackModalActions.close();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, ORIGINAL_ALBUM);
    await galleryActions.waitForAlbumHidden(RENAMED_ALBUM);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: RENAMED_ALBUM,
      year: RENAMED_YEAR,
    })).toBe(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, ORIGINAL_ALBUM);
    await galleryActions.waitForAlbumHidden(RENAMED_ALBUM);
    expect(freshSession).not.toBeNull();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    await freshSession.galleryActions.waitForAlbumHidden(RENAMED_ALBUM);
    await freshSession.galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await freshSession.trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(ORIGINAL_ALBUM),
      trackTitles: Array.from(
        { length: FIXTURE_TRACK_COUNT },
        (_, index) => `Rename Track ${index + 1}`,
      ),
    });
  });
});

test('FTC-TAGS-008 returns one terminal saved response after optimistic rename persistence', async ({
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  let acceptedSaveTaskId = '';
  let persistenceGate = null;
  try {
    await stepLogger.step('Open the generated album and hold only structural persistence', async () => {
      await galleryActions.goto(ARTIST_VIEW_URL);
      await galleryActions.waitForGalleryReady();
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(ORIGINAL_ALBUM),
        trackTitles: Array.from(
          { length: FIXTURE_TRACK_COUNT },
          (_, index) => `Rename Track ${index + 1}`,
        ),
      });
      persistenceGate = await holdStructuralSavePersistence();
    });

    await stepLogger.step('Keep the optimistic rename visible while the authoritative POST remains pending', async () => {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(POLL_WINDOW_ALBUM);
      const result = await tagEditorActions.applyAndWaitForTerminalSavedResponse({
        whilePostInFlight: async ({ isPostSettled }) => {
          expect(isPostSettled()).toBe(false);
          expect(await galleryActions.readAlbumIdentityCardCount({
            artist: FIXTURE_ARTIST,
            album: ORIGINAL_ALBUM,
            year: FIXTURE_YEAR,
          })).toBe(0);
          expect(await galleryActions.readAlbumIdentityCardCount({
            artist: FIXTURE_ARTIST,
            album: POLL_WINDOW_ALBUM,
            year: FIXTURE_YEAR,
          })).toBe(1);
          const summary = await trackModalActions.waitForTitle(
            albumDetailsTitle(POLL_WINDOW_ALBUM),
          );
          expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
          expect(isPostSettled()).toBe(false);
          await persistenceGate.release();
          persistenceGate = null;
        },
      });
      acceptedSaveTaskId = result.saveTaskId;
      expect(acceptedSaveTaskId).not.toBe('');
    });

    await stepLogger.step('Reload onto the authoritative renamed topology', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, POLL_WINDOW_ALBUM);
      await galleryActions.waitForAlbumHidden(ORIGINAL_ALBUM);
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: POLL_WINDOW_ALBUM,
        year: FIXTURE_YEAR,
      });
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.title).toBe(albumDetailsTitle(POLL_WINDOW_ALBUM));
      expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
    });
  } finally {
    if (persistenceGate) {
      await persistenceGate.release();
      persistenceGate = null;
    }
    if (acceptedSaveTaskId) {
      await stepLogger.step('Reverse the terminal-response rename through the normal Edit Tags UI', async () => {
        await galleryActions.goto(ARTIST_VIEW_URL);
        await galleryActions.waitForGalleryReady();
        await galleryActions.waitForAlbumVisibleUnderHeading(
          FIXTURE_ARTIST,
          POLL_WINDOW_ALBUM,
        );
        await galleryActions.selectAlbumDetailsByIdentity({
          artist: FIXTURE_ARTIST,
          album: POLL_WINDOW_ALBUM,
          year: FIXTURE_YEAR,
        });
        await trackModalActions.waitForInteractiveSummary();
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
        await tagEditorActions.selectAllTracks();
        await tagEditorActions.setAlbumName(ORIGINAL_ALBUM);
        const result = await tagEditorActions.applyAndWaitForSavedFiles();
        expect(String(result.save_task_id || '').trim()).not.toBe('');
        await trackModalActions.closeIfOpen();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await galleryActions.waitForGalleryReady();
        await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, ORIGINAL_ALBUM);
        await galleryActions.waitForAlbumHidden(POLL_WINDOW_ALBUM);
      });
    }
  }
});

test('FTC-TAGS-008 keeps an accepted terminal failure readable without false success', async ({
  galleryActions,
  page,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityLogHistoryActions,
}) => {
  await stepLogger.step('Open the generated two-track failure-control album', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: FAILURE_FIXTURE_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(FAILURE_FIXTURE_ALBUM),
      trackTitles: ['Apply Rarity Here', 'Remain Editable'],
    });
  });

  await stepLogger.step('Keep the failed task readable after compensation', async () => {
    const privilegeGuard = await temporarilyRevokeRuntimeDeletePrivileges([
      'library.ignored_versions',
      'library.manual_versions',
    ]);
    try {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(FAILURE_FIXTURE_TRACK);
      await tagEditorActions.setAlbumName('Rejected Album Rename Fixture');
      const failure = await tagEditorActions.applyAndWaitForAsyncFailure();
      expect(failure.task.error).toContain('ignored_versions');
      expect(failure.alertText).toBe('Failed to edit tags.');
      await tagEditorActions.expectTerminalFailureRemainsReadable('Failed to edit tags.');
      await tagEditorActions.openLogHistoryFromFailure();
      await utilityLogHistoryActions.waitForReady();
      expect(await utilityLogHistoryActions.readVisibleHistoryText()).toContain(failure.task.error);
      await settingsModalAppBarActions.closeSettings();
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(FAILURE_FIXTURE_ALBUM),
        trackTitles: ['Apply Rarity Here', 'Remain Editable'],
      });
    } finally {
      await privilegeGuard.restore();
    }
  });

  await stepLogger.step('Reload the compensated rarity fixture as one exact two-track album', async () => {
    await trackModalActions.closeIfOpen();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(
      FIXTURE_ARTIST,
      FAILURE_FIXTURE_ALBUM,
    );
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: FAILURE_FIXTURE_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: FAILURE_FIXTURE_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(FAILURE_FIXTURE_ALBUM),
      trackTitles: ['Apply Rarity Here', 'Remain Editable'],
    });
    await trackModalActions.close();
  });
});

test('FTC-TAGS-009 restores tracks from distinct temporary albums without duplicate cards', async ({
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}, testInfo) => {
  let originalCoverSrc = '';
  let destinationCoverSrc = '';
  let secondDestinationCoverSrc = '';
  let visibleAlbumCountBeforeSplit = null;
  await stepLogger.step('Open the generated split fixture and retain its local cover', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    visibleAlbumCountBeforeSplit = (
      await galleryActions.readCurrentProductionVisibleAlbumObservation(
        FIXTURE_ARTIST,
        [{
          album: SPLIT_ORIGINAL_ALBUM,
          year: FIXTURE_YEAR,
        }],
      )
    ).albumCount;
    originalCoverSrc = (
      await galleryActions.waitForAlbumCoverReadyUnderHeading(
        FIXTURE_ARTIST,
        SPLIT_ORIGINAL_ALBUM,
      )
    ).productionSrc;
    expect(originalCoverSrc).not.toBe('');
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(albumDetailsTitle(SPLIT_ORIGINAL_ALBUM));
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
  });

  await stepLogger.step('Rename only the selected generated MP3 and wait for durable save completion', async () => {
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await tagEditorActions.selectTrackByFilename(SPLIT_SELECTED_FILENAME);
    await tagEditorActions.setAlbumName(SPLIT_RENAMED_ALBUM);
    const result = await tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_RENAMED_ALBUM,
      expectedFilename: SPLIT_SELECTED_FILENAME,
      readOptimisticState: async (stage) => ({
        stage,
        ...await galleryActions.readCurrentProductionVisibleAlbumObservation(
          FIXTURE_ARTIST,
          [
            {
              album: SPLIT_ORIGINAL_ALBUM,
              year: FIXTURE_YEAR,
            },
            {
              album: SPLIT_RENAMED_ALBUM,
              year: FIXTURE_YEAR,
            },
          ],
          { expectedAlbumCount: visibleAlbumCountBeforeSplit + 1 },
        ),
      }),
      readCompletedState: (stage) => (
        galleryActions.inspectExactAlbumDetailsAfterClosingCurrentModal(
          trackModalActions,
          {
            artist: FIXTURE_ARTIST,
            album: SPLIT_ORIGINAL_ALBUM,
            year: FIXTURE_YEAR,
            title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
            trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(1),
          },
        ).then((summary) => ({ stage, summary }))
      ),
    });
    expect(String(result.payload?.save_task_id || '').trim()).not.toBe('');
    expect(result.completedState).toEqual({
      stage: 'after-save-completion',
      summary: expect.objectContaining({
        title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
        trackRows: FIXTURE_TRACK_COUNT - 1,
      }),
    });
    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
    });
    expect(physicalTags).toHaveLength(FIXTURE_TRACK_COUNT);
    const selectedTrack = physicalTags.find((track) => (
      track.filename === SPLIT_SELECTED_FILENAME
    ));
    expect(selectedTrack?.albumValues).toEqual([SPLIT_RENAMED_ALBUM]);
    for (const sibling of physicalTags.filter((track) => (
      track.filename !== SPLIT_SELECTED_FILENAME
    ))) {
      expect(sibling.albumValues).toEqual([SPLIT_ORIGINAL_ALBUM]);
    }

  });

  await stepLogger.step('Verify both covered albums and exact track counts in the current gallery', async () => {
    const sourceCover = await galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
    );
    const destinationCover = await galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
    );
    expect(sourceCover.productionSrc).toBe(originalCoverSrc);
    destinationCoverSrc = destinationCover.productionSrc;
    expect(destinationCoverSrc).toBe(originalCoverSrc);

    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_RENAMED_ALBUM),
      trackTitles: [EXPECTED_SPLIT_TRACK_TITLES[0]],
      displayedTrackNumbers: [1],
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-009-first-move-destination-details.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      [SPLIT_SELECTED_FILENAME],
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-009-first-move-destination-editor.png'),
      fullPage: true,
    });
    await tagEditorActions.close();
    await trackModalActions.close();
  });

  await stepLogger.step('Move a second source track into a distinct destination album', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(
      FIXTURE_TRACK_COUNT - 1,
    );
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT - 1 });
    await tagEditorActions.selectTrackByFilename(SPLIT_SECOND_SELECTED_FILENAME);
    await tagEditorActions.setAlbumName(SPLIT_SECOND_RENAMED_ALBUM);
    const result = await tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_SECOND_RENAMED_ALBUM,
      expectedFilename: SPLIT_SECOND_SELECTED_FILENAME,
      readOptimisticState: async (stage) => {
        const visibleState = await galleryActions.readCurrentProductionVisibleAlbumObservation(
          FIXTURE_ARTIST,
          [
            {
              album: SPLIT_ORIGINAL_ALBUM,
              year: FIXTURE_YEAR,
            },
            {
              album: SPLIT_RENAMED_ALBUM,
              year: FIXTURE_YEAR,
            },
            {
              album: SPLIT_SECOND_RENAMED_ALBUM,
              year: FIXTURE_YEAR,
            },
          ],
          { expectedAlbumCount: visibleAlbumCountBeforeSplit + 2 },
        );
        const originalSummary = stage === 'before-edit-response'
          ? await galleryActions.inspectExactAlbumDetailsAfterClosingCurrentModal(
            trackModalActions,
            {
              artist: FIXTURE_ARTIST,
              album: SPLIT_ORIGINAL_ALBUM,
              year: FIXTURE_YEAR,
              title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
              trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(2),
            },
          )
          : null;
        return {
          stage,
          ...visibleState,
          originalSummary,
        };
      },
      readCompletedState: (stage) => (
        galleryActions.inspectExactAlbumDetailsAfterClosingCurrentModal(
          trackModalActions,
          {
            artist: FIXTURE_ARTIST,
            album: SPLIT_ORIGINAL_ALBUM,
            year: FIXTURE_YEAR,
            title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
            trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(2),
          },
        ).then((summary) => ({ stage, summary }))
      ),
    });
    expect(String(result.payload?.save_task_id || '').trim()).not.toBe('');
    expect(result.completedState).toEqual({
      stage: 'after-save-completion',
      summary: expect.objectContaining({
        title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
        trackRows: FIXTURE_TRACK_COUNT - 2,
      }),
    });
    expect(result.optimisticState.originalSummary).toEqual(expect.objectContaining({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackRows: FIXTURE_TRACK_COUNT - 2,
    }));

    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
    });
    expect(physicalTags).toHaveLength(FIXTURE_TRACK_COUNT);
    expect(
      physicalTags.find((track) => track.filename === SPLIT_SELECTED_FILENAME)?.albumValues,
    ).toEqual([SPLIT_RENAMED_ALBUM]);
    expect(
      physicalTags.find(
        (track) => track.filename === SPLIT_SECOND_SELECTED_FILENAME,
      )?.albumValues,
    ).toEqual([SPLIT_SECOND_RENAMED_ALBUM]);
    for (const sibling of physicalTags.filter((track) => ![
      SPLIT_SELECTED_FILENAME,
      SPLIT_SECOND_SELECTED_FILENAME,
    ].includes(track.filename))) {
      expect(sibling.albumValues).toEqual([SPLIT_ORIGINAL_ALBUM]);
    }

  });

  await stepLogger.step('Verify both one-track destination albums and their cover authority', async () => {
    const sourceCover = await galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
    );
    const destinationCover = await galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
    );
    const secondDestinationCover = await galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_SECOND_RENAMED_ALBUM,
    );
    expect(sourceCover.productionSrc).toBe(originalCoverSrc);
    expect(destinationCover.productionSrc).toBe(destinationCoverSrc);
    secondDestinationCoverSrc = secondDestinationCover.productionSrc;
    expect(secondDestinationCoverSrc).toBe(originalCoverSrc);

    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(1);
    await trackModalActions.close();
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_SECOND_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(1);
    await trackModalActions.close();
  });

  await stepLogger.step('Restore the first moved track without duplicating the original album', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(1);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(SPLIT_ORIGINAL_ALBUM);
    const {
      actionResult: result,
      observation: mergeBackMultiplicity,
    } = await galleryActions.observeAlbumCardMultiplicityDuring({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_ORIGINAL_ALBUM,
      expectedFilename: SPLIT_SELECTED_FILENAME,
      readOptimisticState: checkpoint,
      readCompletedState: checkpoint,
    }));
    expect(String(result.payload?.save_task_id || '').trim()).not.toBe('');
    expect(mergeBackMultiplicity.mutationRecordCount).toBeGreaterThan(0);
    expect(mergeBackMultiplicity.maxCount).toBeLessThanOrEqual(1);

    const summary = await trackModalActions.waitForTitle(
      albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
    );
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT - 1);
    await trackModalActions.close();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(0);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_SECOND_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(mergeBackMultiplicity.finalCount).toBe(1);
    expect((
      await galleryActions.waitForAlbumCoverReadyUnderHeading(
        FIXTURE_ARTIST,
        SPLIT_ORIGINAL_ALBUM,
      )
    ).productionSrc).toBe(originalCoverSrc);
    await galleryActions.waitForAlbumHidden(SPLIT_RENAMED_ALBUM);
  });

  await stepLogger.step('Restore the second moved track without duplicating the original album', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_SECOND_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(1);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(SPLIT_ORIGINAL_ALBUM);
    const {
      actionResult: result,
      observation: mergeBackMultiplicity,
    } = await galleryActions.observeAlbumCardMultiplicityDuring({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_ORIGINAL_ALBUM,
      expectedFilename: SPLIT_SECOND_SELECTED_FILENAME,
      readOptimisticState: checkpoint,
      readCompletedState: checkpoint,
    }));
    expect(String(result.payload?.save_task_id || '').trim()).not.toBe('');
    expect(mergeBackMultiplicity.mutationRecordCount).toBeGreaterThan(0);
    expect(mergeBackMultiplicity.maxCount).toBeLessThanOrEqual(1);

    const summary = await trackModalActions.waitForTitle(
      albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
    );
    expect(summary.trackRows).toBe(FIXTURE_TRACK_COUNT);
    await trackModalActions.close();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_SECOND_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(0);
    expect(mergeBackMultiplicity.finalCount).toBe(1);
    expect((
      await galleryActions.waitForAlbumCoverReadyUnderHeading(
        FIXTURE_ARTIST,
        SPLIT_ORIGINAL_ALBUM,
      )
    ).productionSrc).toBe(originalCoverSrc);
    await galleryActions.waitForAlbumHidden(SPLIT_SECOND_RENAMED_ALBUM);

    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
    });
    expect(physicalTags).toHaveLength(FIXTURE_TRACK_COUNT);
    for (const track of physicalTags) {
      expect(track.albumValues).toEqual([SPLIT_ORIGINAL_ALBUM]);
    }
    await page.screenshot({
      path: testInfo.outputPath('restored-single-album-card.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Verify both independent merges from a fresh browser context', async () => {
    const freshSession = await freshBrowserSession.create();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    const freshSourceCover = await freshSession.galleryActions.waitForAlbumCoverReadyUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
    );
    expect(freshSourceCover.productionSrc).toBe(originalCoverSrc);
    await freshSession.galleryActions.waitForAlbumHidden(SPLIT_RENAMED_ALBUM);
    await freshSession.galleryActions.waitForAlbumHidden(SPLIT_SECOND_RENAMED_ALBUM);
    await freshSession.galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    expect(
      (await freshSession.trackModalActions.waitForInteractiveSummary()).trackRows,
    ).toBe(FIXTURE_TRACK_COUNT);
    await freshSession.page.screenshot({
      path: testInfo.outputPath('restored-album-details.png'),
      fullPage: true,
    });
  });
});

test('FTC-TAGS-015 / FTC-UTIL-PROBLEMS-012 keeps one stable destination through five selected-track moves and restores', async ({
  freshBrowserSession,
  galleryActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
  utilityProblematicFilesActions,
  utilityTabBarActions,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const repeatedMoveCount = 5;
  const sourceTrackTitlesAfterFirstMove = EXPECTED_SPLIT_TRACK_TITLES.slice(1);
  const sourceTrackTitlesAfterSecondMove = EXPECTED_SPLIT_TRACK_TITLES.slice(2);
  const destinationTrackTitlesAfterSecondMove = EXPECTED_SPLIT_TRACK_TITLES.slice(0, 2);
  const sourceTrackTitlesAfterRepeatedMoves = EXPECTED_SPLIT_TRACK_TITLES.slice(
    repeatedMoveCount,
  );
  const sourceTrackTitlesAfterFirstRestore = [
    EXPECTED_SPLIT_TRACK_TITLES[0],
    ...EXPECTED_SPLIT_TRACK_TITLES.slice(repeatedMoveCount),
  ];
  const sourceFilenamesAfterFirstMove = Array.from(
    { length: FIXTURE_TRACK_COUNT - 1 },
    (_, index) => `${String(index + 2).padStart(2, '0')} - Split Track ${index + 2}.mp3`,
  );
  const sourceFilenamesAfterRepeatedMoves = sourceFilenamesAfterFirstMove.slice(
    repeatedMoveCount - 1,
  );
  const sourceFilenamesAfterSecondMove = sourceFilenamesAfterFirstMove.slice(1);
  const destinationFilenamesAfterSecondMove = EXPECTED_SPLIT_TRACK_TITLES
    .slice(0, 2)
    .map(
      (title, index) => `${String(index + 1).padStart(2, '0')} - ${title}.mp3`,
    );
  const destinationFilenamesAfterRepeatedMoves = EXPECTED_SPLIT_TRACK_TITLES
    .slice(0, repeatedMoveCount)
    .map(
      (title, index) => `${String(index + 1).padStart(2, '0')} - ${title}.mp3`,
    );
  const sourceFilenamesAfterFirstRestore = [
    destinationFilenamesAfterRepeatedMoves[0],
    ...sourceFilenamesAfterRepeatedMoves,
  ];
  let firstMoveCompletionPromise = null;
  let firstMoveCompletionSettled = false;
  let firstMovePersistenceGate = null;
  const topologyObservations = [];

  await stepLogger.step('Open the source album and verify its exact track order', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: EXPECTED_SPLIT_TRACK_TITLES,
      displayedTrackNumbers: Array.from(
        { length: FIXTURE_TRACK_COUNT },
        (_, index) => index + 1,
      ),
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-source-details-initial.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      EXPECTED_SPLIT_TRACK_TITLES.map(
        (title, index) => `${String(index + 1).padStart(2, '0')} - ${title}.mp3`,
      ),
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-source-editor-initial.png'),
      fullPage: true,
    });
    await tagEditorActions.close();
    await trackModalActions.closeIfOpen();
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
      { year: FIXTURE_YEAR },
    );
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
  });

  try {
    await stepLogger.step('Move the first track into the destination album', async () => {
      firstMovePersistenceGate = await holdStructuralSavePersistence();
      await tagEditorActions.selectTrackByFilename(SPLIT_SELECTED_FILENAME);
      await tagEditorActions.setAlbumName(SPLIT_RENAMED_ALBUM);
      const { observation: firstMoveObservation } =
        await galleryActions.expectStableAlbumTopologyTransitionDuring({
          artist: FIXTURE_ARTIST,
          identities: [
            {
              album: SPLIT_ORIGINAL_ALBUM,
              trackCount: '17 tracks',
              year: FIXTURE_YEAR,
            },
            {
              album: SPLIT_RENAMED_ALBUM,
              trackCount: '1 track',
              year: FIXTURE_YEAR,
            },
          ],
        }, async (checkpoint) => {
          let releaseFirstMoveStartCheckpoint;
          let rejectFirstMoveStartCheckpoint;
          const firstMoveStartCheckpoint = new Promise((resolve, reject) => {
            releaseFirstMoveStartCheckpoint = resolve;
            rejectFirstMoveStartCheckpoint = reject;
          });
          let firstMoveStartState = null;
          firstMoveCompletionPromise = tagEditorActions.applyAndObserveOptimisticState({
            expectedField: 'album',
            expectedValue: SPLIT_RENAMED_ALBUM,
            expectedFilename: SPLIT_SELECTED_FILENAME,
            readOptimisticState: async (stage) => {
              if (stage === 'before-edit-response') {
                firstMoveStartState = await checkpoint(stage, { arm: true });
                releaseFirstMoveStartCheckpoint(firstMoveStartState);
                return firstMoveStartState;
              }
              if (!firstMoveStartState) {
                throw new Error('Expected edit 1 to retain its before-response topology snapshot.');
              }
              return firstMoveStartState;
            },
          });
          void firstMoveCompletionPromise.then(
            () => {
              firstMoveCompletionSettled = true;
            },
            (error) => {
              firstMoveCompletionSettled = true;
              rejectFirstMoveStartCheckpoint(error);
            },
          );
          return firstMoveStartCheckpoint;
        });
      topologyObservations.push({
        transition: 'move-1',
        ...firstMoveObservation,
      });
      await trackModalActions.closeIfOpen();
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      })).toBe(1);
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: FIXTURE_ARTIST,
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      })).toBe(1);
    });

    await stepLogger.step('Move the second track into the same destination album', async () => {
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
        trackTitles: sourceTrackTitlesAfterFirstMove,
        displayedTrackNumbers: Array.from(
          { length: FIXTURE_TRACK_COUNT - 1 },
          (_, index) => index + 2,
        ),
      });
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT - 1 });
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
        sourceFilenamesAfterFirstMove,
      );
      await tagEditorActions.selectTrackByFilename(SPLIT_SECOND_SELECTED_FILENAME);
      await tagEditorActions.setAlbumName(SPLIT_RENAMED_ALBUM);
      let firstMoveCompletionSettledBeforeSecondEditResponse = null;
      const { actionResult, observation: secondMoveObservation } =
        await galleryActions.expectStableAlbumTopologyTransitionDuring({
          artist: FIXTURE_ARTIST,
          identities: [
            {
              album: SPLIT_ORIGINAL_ALBUM,
              trackCount: '16 tracks',
              year: FIXTURE_YEAR,
            },
            {
              album: SPLIT_RENAMED_ALBUM,
              trackCount: '2 tracks',
              year: FIXTURE_YEAR,
            },
          ],
        }, async (checkpoint) => {
          const secondMoveResult = await tagEditorActions.applyAndObserveOptimisticState({
            expectedField: 'album',
            expectedValue: SPLIT_RENAMED_ALBUM,
            expectedFilename: SPLIT_SECOND_SELECTED_FILENAME,
            readOptimisticState: async (stage) => {
              const optimisticState = await checkpoint(stage, { arm: true });
              if (stage === 'before-edit-response') {
                firstMoveCompletionSettledBeforeSecondEditResponse = firstMoveCompletionSettled;
                if (!firstMovePersistenceGate) {
                  throw new Error('Expected edit 1 persistence to remain gated before edit 2 settled.');
                }
                await firstMovePersistenceGate.release();
                firstMovePersistenceGate = null;
              }
              return optimisticState;
            },
            readCompletedState: (stage) => checkpoint(stage),
          });
          const firstMoveResult = await firstMoveCompletionPromise;
          return {
            firstMoveResult,
            secondMoveResult,
          };
        });
      expect(
        firstMoveCompletionSettledBeforeSecondEditResponse,
        'Expected edit 2 to claim and render before edit 1 reconciled.',
      ).toBe(false);
      const { firstMoveResult, secondMoveResult: result } = actionResult;
      expect(String(firstMoveResult.payload?.save_task_id || '').trim()).not.toBe('');
      expect(String(result.payload?.save_task_id || '').trim()).not.toBe('');
      topologyObservations.push({
        transition: 'move-2-overlapping-saves',
        ...secondMoveObservation,
      });
      await trackModalActions.closeIfOpen();
      expect(await galleryActions.readAlbumCardSummaryByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      })).toEqual({
        subtitle: FIXTURE_ARTIST,
        trackCount: '16 tracks',
      });
      expect(await galleryActions.readAlbumCardSummaryByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      })).toEqual({
        subtitle: FIXTURE_ARTIST,
        trackCount: '2 tracks',
      });
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      })).toBe(1);
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: FIXTURE_ARTIST,
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      })).toBe(1);
    });
  } finally {
    if (firstMovePersistenceGate) {
      await firstMovePersistenceGate.dispose();
      firstMovePersistenceGate = null;
    }
  }

  await stepLogger.step('Prove exact source and destination contents after the overlapping second move', async () => {
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-second-move-gallery.png'),
      fullPage: true,
    });
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: sourceTrackTitlesAfterSecondMove,
      displayedTrackNumbers: Array.from(
        { length: FIXTURE_TRACK_COUNT - 2 },
        (_, index) => index + 3,
      ),
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-second-move-source-details.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT - 2 });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      sourceFilenamesAfterSecondMove,
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-second-move-source-editor.png'),
      fullPage: true,
    });
    await tagEditorActions.close();
    await trackModalActions.close();

    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_RENAMED_ALBUM),
      trackTitles: destinationTrackTitlesAfterSecondMove,
      displayedTrackNumbers: [1, 2],
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-second-move-destination-details.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      destinationFilenamesAfterSecondMove,
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-second-move-destination-editor.png'),
      fullPage: true,
    });
    await tagEditorActions.close();
    await trackModalActions.close();
  });

  await stepLogger.step('Verify effective source numbering and the incomplete-order diagnosis', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(SPLIT_ORIGINAL_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(SPLIT_ORIGINAL_ALBUM);
    const detail = await utilityProblematicFilesActions.readSelectedDetailSummary();
    expect(detail.title).toBe(SPLIT_ORIGINAL_ALBUM);
    expect([...new Set(detail.problemReasons)]).toEqual([
      'Incomplete track order: Disc 1 missing 1, 2',
    ]);
    await settingsModalAppBarActions.closeSettings();
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
      { year: FIXTURE_YEAR },
    );
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
      { year: FIXTURE_YEAR },
    );
  });

  await stepLogger.step('Repeat the same destination move through the owner-reported fifth edit', async () => {
    for (let movedTrackCount = 3; movedTrackCount <= repeatedMoveCount; movedTrackCount += 1) {
      const selectedFilename = destinationFilenamesAfterRepeatedMoves[movedTrackCount - 1];
      const expectedSourceTitles = EXPECTED_SPLIT_TRACK_TITLES.slice(movedTrackCount);
      const expectedSourceFilenames = destinationFilenamesAfterRepeatedMoves
        .slice(movedTrackCount)
        .concat(sourceFilenamesAfterRepeatedMoves);
      const expectedDestinationTitles = EXPECTED_SPLIT_TRACK_TITLES.slice(
        0,
        movedTrackCount,
      );
      const expectedDestinationFilenames = destinationFilenamesAfterRepeatedMoves.slice(
        0,
        movedTrackCount,
      );

      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
        trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(movedTrackCount - 1),
        displayedTrackNumbers: Array.from(
          { length: FIXTURE_TRACK_COUNT - movedTrackCount + 1 },
          (_, index) => index + movedTrackCount,
        ),
      });
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({
        expectedTrackCount: FIXTURE_TRACK_COUNT - movedTrackCount + 1,
      });
      await tagEditorActions.selectTrackByFilename(selectedFilename);
      await tagEditorActions.setAlbumName(SPLIT_RENAMED_ALBUM);
      const result = await tagEditorActions.applyAndWaitForSavedFiles();
      expect(String(result.save_task_id || '').trim()).not.toBe('');
      await trackModalActions.closeIfOpen();
      await galleryActions.scrollToAlbumUnderHeading(
        FIXTURE_ARTIST,
        SPLIT_ORIGINAL_ALBUM,
        { year: FIXTURE_YEAR },
      );
      const sourceCardSummary = await galleryActions.readAlbumCardSummaryByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      });
      await galleryActions.scrollToAlbumUnderHeading(
        FIXTURE_ARTIST,
        SPLIT_RENAMED_ALBUM,
        { year: FIXTURE_YEAR },
      );
      const destinationCardSummary = await galleryActions.readAlbumCardSummaryByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      });
      expect(sourceCardSummary).toEqual({
        subtitle: FIXTURE_ARTIST,
        trackCount: `${FIXTURE_TRACK_COUNT - movedTrackCount} tracks`,
      });
      expect(destinationCardSummary).toEqual({
        subtitle: FIXTURE_ARTIST,
        trackCount: `${movedTrackCount} tracks`,
      });

      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_ORIGINAL_ALBUM,
        year: FIXTURE_YEAR,
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
        trackTitles: expectedSourceTitles,
        displayedTrackNumbers: Array.from(
          { length: FIXTURE_TRACK_COUNT - movedTrackCount },
          (_, index) => index + movedTrackCount + 1,
        ),
      });
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({
        expectedTrackCount: FIXTURE_TRACK_COUNT - movedTrackCount,
      });
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
        expectedSourceFilenames,
      );
      await tagEditorActions.close();
      await trackModalActions.close();

      await galleryActions.selectAlbumDetailsByIdentity({
        artist: FIXTURE_ARTIST,
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(SPLIT_RENAMED_ALBUM),
        trackTitles: expectedDestinationTitles,
      });
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: movedTrackCount });
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
        expectedDestinationFilenames,
      );
      await tagEditorActions.close();
      await trackModalActions.close();
    }
  });

  await stepLogger.step('Verify exact five-edit source and destination contents', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: sourceTrackTitlesAfterRepeatedMoves,
      displayedTrackNumbers: Array.from(
        { length: FIXTURE_TRACK_COUNT - repeatedMoveCount },
        (_, index) => index + repeatedMoveCount + 1,
      ),
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({
      expectedTrackCount: FIXTURE_TRACK_COUNT - repeatedMoveCount,
    });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      sourceFilenamesAfterRepeatedMoves,
    );
    await tagEditorActions.close();
    await trackModalActions.close();

    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_RENAMED_ALBUM),
      trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(0, repeatedMoveCount),
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: repeatedMoveCount });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      destinationFilenamesAfterRepeatedMoves,
    );
    await tagEditorActions.close();
    await trackModalActions.close();
  });

  await stepLogger.step('Open a real problematic track after the five structural edits without repeated errors', async () => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(NAVIGATION_FIXTURE_ALBUM, {
      submitWithEnter: true,
    });
    await searchToolbarActions.waitForQuery(NAVIGATION_FIXTURE_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      NAVIGATION_FIXTURE_ARTIST,
      NAVIGATION_FIXTURE_ALBUM,
    );
    await galleryActions.clickAlbumDetailsByAlbumName(NAVIGATION_FIXTURE_ALBUM);
    await trackModalActions.waitForLoadedSummary();
    await trackModalActions.expectProblemLinkVisibleForTrack(NAVIGATION_FIXTURE_TRACK);
    const problematicTrackPath = await trackModalActions.readTrackPathByTitle(
      NAVIGATION_FIXTURE_TRACK,
    );
    await trackModalActions.openProblematicFilesForTrack(NAVIGATION_FIXTURE_TRACK);
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.waitForSelectedDetailSelection({
      expectedTitle: NAVIGATION_FIXTURE_ALBUM,
    });
    expect(
      await utilityProblematicFilesActions.waitForProblematicTrackInDetailViewport(
        problematicTrackPath,
      ),
    ).toBe(problematicTrackPath);
    expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);

    const detail = await utilityProblematicFilesActions.selectAlbumByTitle(
      NAVIGATION_FIXTURE_ALBUM,
    );
    expect(detail.title).toBe(NAVIGATION_FIXTURE_ALBUM);
    expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);
    await settingsModalAppBarActions.closeSettings();
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
    );
    await galleryActions.waitForAlbumVisibleUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
    );
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  await stepLogger.step('Capture the verified stable gallery, details, and editors', async () => {
    await page.setViewportSize({ width: 1280, height: 960 });
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_ORIGINAL_ALBUM,
      { year: FIXTURE_YEAR },
    );
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
      { year: FIXTURE_YEAR },
    );
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-stable-gallery.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await galleryActions.scrollToAlbumUnderHeading(
      FIXTURE_ARTIST,
      SPLIT_RENAMED_ALBUM,
      { year: FIXTURE_YEAR },
    );
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-source-details.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-source-editor.png'),
      fullPage: true,
    });
    await tagEditorActions.close();
    await trackModalActions.close();
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-destination-details.png'),
      fullPage: true,
    });
    await trackModalActions.openTagEditor();
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-destination-editor.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Restore one track and then merge every remaining track into one source card', async () => {
    await tagEditorActions.selectTrackByFilename(SPLIT_SELECTED_FILENAME);
    await tagEditorActions.setAlbumName(SPLIT_ORIGINAL_ALBUM);
    const { observation: firstRestoreObservation } =
      await galleryActions.expectStableAlbumTopologyTransitionDuring({
      artist: FIXTURE_ARTIST,
      identities: [
        {
          album: SPLIT_ORIGINAL_ALBUM,
          trackCount: '14 tracks',
          year: FIXTURE_YEAR,
        },
        {
          album: SPLIT_RENAMED_ALBUM,
          trackCount: '4 tracks',
          year: FIXTURE_YEAR,
        },
      ],
    }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_ORIGINAL_ALBUM,
      expectedFilename: SPLIT_SELECTED_FILENAME,
      readOptimisticState: (stage) => checkpoint(stage, { arm: true }),
      readCompletedState: (stage) => checkpoint(stage),
    }));
    topologyObservations.push({
      transition: 'restore-1',
      ...firstRestoreObservation,
    });
    await trackModalActions.closeIfOpen();
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-after-first-restore-gallery.png'),
      fullPage: true,
    });
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: sourceTrackTitlesAfterFirstRestore,
      displayedTrackNumbers: [
        1,
        ...Array.from(
          { length: FIXTURE_TRACK_COUNT - repeatedMoveCount },
          (_, index) => index + repeatedMoveCount + 1,
        ),
      ],
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({
      expectedTrackCount: FIXTURE_TRACK_COUNT - repeatedMoveCount + 1,
    });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      sourceFilenamesAfterFirstRestore,
    );
    await tagEditorActions.close();
    await trackModalActions.close();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_RENAMED_ALBUM,
      year: FIXTURE_YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_RENAMED_ALBUM),
      trackTitles: EXPECTED_SPLIT_TRACK_TITLES.slice(1, repeatedMoveCount),
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: repeatedMoveCount - 1 });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      destinationFilenamesAfterRepeatedMoves.slice(1),
    );
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(SPLIT_ORIGINAL_ALBUM);
    const { observation: finalRestoreObservation } =
      await galleryActions.expectStableAlbumTopologyTransitionDuring({
      artist: FIXTURE_ARTIST,
      identities: [{
        album: SPLIT_ORIGINAL_ALBUM,
        trackCount: '18 tracks',
        year: FIXTURE_YEAR,
      }],
      absentIdentities: [{
        album: SPLIT_RENAMED_ALBUM,
        year: FIXTURE_YEAR,
      }],
    }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
      expectedField: 'album',
      expectedValue: SPLIT_ORIGINAL_ALBUM,
      expectedFilenames: destinationFilenamesAfterRepeatedMoves.slice(1),
      readOptimisticState: (stage) => checkpoint(stage, { arm: true }),
      readCompletedState: (stage) => checkpoint(stage),
    }));
    topologyObservations.push({
      transition: 'restore-final-merge',
      ...finalRestoreObservation,
    });
    testArtifacts.queueJsonAttachment(
      'ftc-tags-015-topology-observations',
      topologyObservations,
    );
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: EXPECTED_SPLIT_TRACK_TITLES,
      displayedTrackNumbers: Array.from(
        { length: FIXTURE_TRACK_COUNT },
        (_, index) => index + 1,
      ),
    });
    await trackModalActions.close();
    await galleryActions.waitForAlbumHidden(SPLIT_RENAMED_ALBUM);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    })).toBe(1);
    await settingsModalAppBarActions.openSettings();
    await utilityProblematicFilesActions.waitForReady();
    await utilityProblematicFilesActions.search(SPLIT_RENAMED_ALBUM);
    await utilityProblematicFilesActions.waitForNoSearchResults(SPLIT_RENAMED_ALBUM);
    expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);
    await utilityProblematicFilesActions.search(SPLIT_ORIGINAL_ALBUM);
    await utilityProblematicFilesActions.waitForNoSearchResults(SPLIT_ORIGINAL_ALBUM);
    expect(await utilityProblematicFilesActions.readErrorToastCount()).toBe(0);
    await settingsModalAppBarActions.closeSettings();
    await page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-final-restored-gallery.png'),
      fullPage: true,
    });
  });

  await stepLogger.step('Verify physical tags and fresh-browser restored state', async () => {
    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
    });
    expect(physicalTags).toHaveLength(FIXTURE_TRACK_COUNT);
    for (const track of physicalTags) {
      expect(track.albumValues).toEqual([SPLIT_ORIGINAL_ALBUM]);
    }
    const freshSession = await freshBrowserSession.create();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    await freshSession.galleryActions.waitForAlbumHidden(SPLIT_RENAMED_ALBUM);
    await freshSession.galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: SPLIT_ORIGINAL_ALBUM,
      year: FIXTURE_YEAR,
    });
    await freshSession.trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SPLIT_ORIGINAL_ALBUM),
      trackTitles: EXPECTED_SPLIT_TRACK_TITLES,
      displayedTrackNumbers: Array.from(
        { length: FIXTURE_TRACK_COUNT },
        (_, index) => index + 1,
      ),
    });
    await freshSession.page.screenshot({
      path: testInfo.outputPath('ftc-tags-015-final-restored-details.png'),
      fullPage: true,
    });
  });
});
