import { expect, test } from '../support/baseFixtures.js';
import {
  readGeneratedMp3AlbumTags,
  temporarilyMakeGeneratedMp3Unavailable,
} from '../helpers/physicalTagHelpers.js';
import { temporarilyRevokeRuntimeDeletePrivileges } from '../helpers/postgresPrivilegeHelpers.js';
import {
  readGeneratedTrackPostgresState,
  readTagEditIntentStatus,
  stageFilesVerifiedAlbumAndExceptionIntent,
} from '../helpers/tagEditIntentHelpers.js';

const RARITY_ARTIST = 'E2E Rarity Artist';
const RARITY_ALBUM = 'Two Track Rarity Fixture';
const RARITY_YEAR = '2026';
const RARITY_TRACK_FILENAME = '01 - Apply Rarity Here.mp3';
const RARITY_TRACK_TITLE = 'Apply Rarity Here';
const SIBLING_TRACK_FILENAME = '02 - Remain Editable.mp3';
const SIBLING_TRACK_TITLE = 'Remain Editable';
const PROBLEMATIC_FILES_RENAME_ALBUM = 'Problematic Files Rename Probe';
const RECOVERED_RARITY_ALBUM = 'Recovered Rarity Album';
const INFERRED_ARTIST = RARITY_ARTIST;
const INFERRED_ALBUM = 'Queued Album Rename Fixture';
const INFERRED_YEAR = '2026';
const INFERRED_TRACK_FILENAME = '02 - Rename Track 2.mp3';
const INFERRED_TRACK_TITLE = 'Rename Track 2';
const INFERRED_TRACK_COUNT = 18;

test('FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details', async ({
  appBarActions,
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  let albumCleared = false;

  const openAlbum = async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(INFERRED_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(INFERRED_ARTIST, INFERRED_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: INFERRED_ARTIST,
      album: INFERRED_ALBUM,
      year: INFERRED_YEAR,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.trackRows).toBe(INFERRED_TRACK_COUNT);
  };

  const expectDualMembership = async () => {
    await trackModalActions.expectProblemLinkVisibleForTrack(INFERRED_TRACK_TITLE);
    await trackModalActions.close();
    if (await navigationPanelActions.readActiveSidebarArtistName() !== INFERRED_ARTIST) {
      await navigationPanelActions.selectSidebarArtistByName(INFERRED_ARTIST);
    }
    await navigationPanelActions.waitForSidebarSelection(INFERRED_ARTIST);
    await artistPageSettingsActions.openNonAlbumTracks(1);
    await artistPageSettingsActions.expectCompactGroupedNonAlbumTable({
      sections: ['Other'],
      tracks: [{
        title: INFERRED_TRACK_TITLE,
        artist: INFERRED_ARTIST,
        pathSuffix: INFERRED_TRACK_FILENAME,
        number: 1,
      }],
    });
    await artistPageSettingsActions.closeNonAlbumTracks();
  };

  try {
    await stepLogger.step('Clear Album on one numbered track without requiring an Exception', async () => {
      await openAlbum();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: INFERRED_TRACK_COUNT });
      await tagEditorActions.selectTrackByFilename(INFERRED_TRACK_FILENAME);
      await tagEditorActions.clearAlbumName();
      await tagEditorActions.expectBlankAlbumCanApply();
      await tagEditorActions.applyAndWaitForSavedFiles();
      albumCleared = true;
    });

    await stepLogger.step('Show the track immediately in both Other and its inferred album', async () => {
      const summary = await trackModalActions.waitForInteractiveSummary();
      expect(summary.trackRows).toBe(INFERRED_TRACK_COUNT);
      await expectDualMembership();
    });

    await stepLogger.step('Preserve dual membership after page reload', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await openAlbum();
      await expectDualMembership();
    });

    await stepLogger.step('Preserve dual membership after a full rescan', async () => {
      await appBarActions.triggerFullRescanAndWait({
        onScanBusy: async () => {
          await artistPageSettingsActions.open();
        },
      });
      await artistPageSettingsActions.expectOpen();
      await openAlbum();
      await expectDualMembership();
    });
  } finally {
    if (albumCleared) {
      await tagEditorActions.dismissTopmostOverlayWithEscape();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(INFERRED_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== INFERRED_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(INFERRED_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(INFERRED_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(INFERRED_TRACK_FILENAME);
      await tagEditorActions.setAlbumName(INFERRED_ALBUM);
      await tagEditorActions.applyAndWaitForSavedFiles();
    }
  }
});

test('FTC-TAGS-005 keeps a failed physical tag write visible and records it in Log History', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityLogHistoryActions,
}) => {
  let failure;
  await stepLogger.step('Open the generated rarity track in the production tag editor', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(RARITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      year: RARITY_YEAR,
    });
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
    await tagEditorActions.setAlbumName('Unwritable Album Probe');
  });

  await stepLogger.step('Surface a compact top-centered error when the generated MP3 disappears during the write', async () => {
    const unavailableTrack = temporarilyMakeGeneratedMp3Unavailable({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      filename: RARITY_TRACK_FILENAME,
    });
    try {
      failure = await tagEditorActions.applyAndWaitForFailure({
        expectedErrorPattern: /^Failed to edit tags\.$/u,
      });
    } finally {
      unavailableTrack.restore();
    }
    expect(failure.status).toBe(500);
    expect(failure.alertText).toBe('Failed to edit tags.');
    expect(failure.payload.error).toContain(RARITY_TRACK_FILENAME);
    const presentation = await tagEditorActions.readFailureAlertPresentation();
    expect(presentation.alertCenterOffsetPx).toBeLessThanOrEqual(2);
    expect(presentation.alertTopPx).toBeGreaterThanOrEqual(0);
    expect(presentation.alertTopPx).toBeLessThanOrEqual(24);
    expect(presentation.linkText).toBe('View details');
    expect(presentation.alertText).not.toContain(failure.payload.error);
    expect(presentation.whiteSpace).toBe('nowrap');
  });

  await stepLogger.step('Open the exact Log History entry and retain the complete failure diagnostic', async () => {
    await tagEditorActions.openLogHistoryFromFailure();
    await utilityLogHistoryActions.waitForReady();
    const entryId = await utilityLogHistoryActions.readSelectedEntryId();
    expect(entryId).not.toBe('');
    expect(await utilityLogHistoryActions.readVisibleHistoryText()).toContain(failure.payload.error);
    const stored = await utilityLogHistoryActions.readBrowserStoredEntry(entryId);
    expect(stored.entry).toMatchObject({
      id: entryId,
      action: 'Tag edit failed',
      error: failure.payload.error,
      file_count: 1,
      source: 'this_browser',
      source_label: 'This browser',
    });
    expect(stored.entry.files).toEqual(expect.arrayContaining([
      expect.stringContaining(RARITY_TRACK_FILENAME),
    ]));
  });
});

test('FTC-TAGS-023 failed tag saves preserve the source modal for a successful retry', async ({
  galleryActions,
  searchToolbarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  const destinationAlbum = 'Permission Failure Destination';
  let initialIdentity = '';
  let initialSummary = null;
  let initialTitles = [];

  await stepLogger.step('Open the generated two-track source album', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(RARITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      year: RARITY_YEAR,
    });
    initialSummary = await trackModalActions.waitForInteractiveSummary();
    initialIdentity = await trackModalActions.readAlbumIdentity();
    initialTitles = await trackModalActions.readTrackTitles();
    expect(initialSummary.trackRows).toBe(2);
    expect(initialIdentity).not.toBe('');
    expect(initialTitles).toEqual([RARITY_TRACK_TITLE, SIBLING_TRACK_TITLE]);
  });

  await stepLogger.step('Preserve the hydrated source modal after the terminal persistence failure', async () => {
    const privilegeGuard = await temporarilyRevokeRuntimeDeletePrivileges([
      'library.ignored_versions',
      'library.manual_versions',
    ]);
    try {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setAlbumName(destinationAlbum);
      const failure = await tagEditorActions.applyAndWaitForAsyncFailure();
      expect(failure.task.error).toContain('ignored_versions');
      expect(failure.alertText).toBe('Failed to edit tags.');
      await trackModalActions.waitForExactAlbumDetails({
        title: initialSummary.title,
        trackTitles: initialTitles,
      });
      expect(await trackModalActions.readAlbumIdentity()).toBe(initialIdentity);
    } finally {
      await privilegeGuard.restore();
    }
  });

  let successfulMoveCompleted = false;
  try {
    await stepLogger.step('Retry the same edit and remove only the moved track from the source modal', async () => {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setAlbumName(destinationAlbum);
      await tagEditorActions.applyAndWaitForSavedFiles({
        onSaveTaskCompleted: () => {
          successfulMoveCompleted = true;
        },
      });
      await trackModalActions.waitForExactAlbumDetails({
        title: initialSummary.title,
        trackTitles: [SIBLING_TRACK_TITLE],
      });
      expect(await trackModalActions.readAlbumIdentity()).toBe(initialIdentity);
    });
  } finally {
    if (successfulMoveCompleted) {
      await stepLogger.step('Restore and verify the generated fixture for the following rarity scenario', async () => {
        await trackModalActions.closeIfOpen();
        await searchToolbarActions.search(destinationAlbum, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(destinationAlbum);
        await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, destinationAlbum);
        await galleryActions.selectAlbumDetailsByIdentity({
          artist: RARITY_ARTIST,
          album: destinationAlbum,
          year: RARITY_YEAR,
        });
        await trackModalActions.waitForInteractiveSummary();
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
        await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
        await tagEditorActions.setAlbumName(RARITY_ALBUM);
        await tagEditorActions.applyAndWaitForSavedFiles();
        await trackModalActions.closeIfOpen();
        await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
        await searchToolbarActions.waitForQuery(RARITY_ALBUM);
        await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
        await galleryActions.selectAlbumDetailsByIdentity({
          artist: RARITY_ARTIST,
          album: RARITY_ALBUM,
          year: RARITY_YEAR,
        });
        await trackModalActions.waitForExactAlbumDetails({
          title: initialSummary.title,
          trackTitles: initialTitles,
        });
        expect(await trackModalActions.readAlbumIdentity()).toBe(initialIdentity);
      });
    }
  }
});

test('FTC-NON-ALBUM-012 renders exception groups as the approved compact track table', async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  page,
  searchToolbarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  let exceptionsApplied = false;
  let fixtureRestored = false;

  try {
    await stepLogger.step('Assign the two supported exception groups to generated tracks', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(RARITY_ALBUM);
      await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setException('Non-album rarity');
      await tagEditorActions.selectTrackByFilename(SIBLING_TRACK_FILENAME);
      await tagEditorActions.setException('Interview');
      await tagEditorActions.applyAndWaitForSavedFiles({
        expectNonAlbumRarityWarning: true,
      });
      exceptionsApplied = true;
    });

    await stepLogger.step('Inspect the widened grouped compact table and row content', async () => {
      await trackModalActions.close();
      await searchToolbarActions.clearSearch({ submitWithEnter: true });
      await searchToolbarActions.waitForQuery('');
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.expectCompactGroupedNonAlbumTable({
        sections: ['Non-album rarity', 'Interviews'],
        tracks: [
          {
            number: 1,
            title: RARITY_TRACK_TITLE,
            artist: RARITY_ARTIST,
            pathSuffix: RARITY_TRACK_FILENAME,
          },
          {
            number: 2,
            title: SIBLING_TRACK_TITLE,
            artist: RARITY_ARTIST,
            pathSuffix: SIBLING_TRACK_FILENAME,
          },
        ],
      });
    });

    await stepLogger.step('Restore both generated exceptions through the shared editor', async () => {
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
      fixtureRestored = true;
    });
  } finally {
    if (exceptionsApplied && !fixtureRestored) {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
    }
  }
});

test('FTC-NON-ALBUM-011 permits a nonempty Album rename from post-rarity Problematic Files', async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
}) => {
  let rarityConverted = false;
  let fixtureRestored = false;

  try {
    await stepLogger.step('Convert the generated track into the reported post-rarity state', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(RARITY_ALBUM);
      await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setException('Non-album rarity');
      await tagEditorActions.applyAndWaitForSavedFiles({
        expectNonAlbumRarityWarning: true,
      });
      rarityConverted = true;
    });

    await stepLogger.step('Rename the non-album track through its Problematic Files edit scope', async () => {
      await trackModalActions.close();
      await settingsModalAppBarActions.openSettings();
      await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
      const problematicItems = await utilityProblematicFilesActions.readVisibleListItems();
      const rarityAlbumIndex = problematicItems.findIndex((item) => (
        item.meta === RARITY_ARTIST && item.title.startsWith(RARITY_ALBUM)
      ));
      expect(rarityAlbumIndex).toBeGreaterThanOrEqual(0);
      await utilityProblematicFilesActions.selectListItemByIndex(rarityAlbumIndex);
      await utilityProblematicFilesActions.expectTrackVisibleInDetail(RARITY_TRACK_TITLE);
      await utilityProblematicFilesActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      expect((await tagEditorActions.readSummary()).exceptionType).toBe('Non-album rarity');
      await tagEditorActions.setAlbumName(PROBLEMATIC_FILES_RENAME_ALBUM);
      await tagEditorActions.applyAndWaitForSavedFiles();
    });

    await stepLogger.step('Read the renamed Album from Loose Tracks and restore the fixture', async () => {
      await settingsModalAppBarActions.closeSettings({ timeout: 10000 });
      await searchToolbarActions.clearSearch({ submitWithEnter: true });
      await searchToolbarActions.waitForQuery('');
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.expectAlbumName(PROBLEMATIC_FILES_RENAME_ALBUM);
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.applyAndWaitForSavedFiles();

      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
      fixtureRestored = true;
    });
  } finally {
    if (rarityConverted && !fixtureRestored) {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
    }
  }
});

test('FTC-NON-ALBUM-014 clears Album durably and refreshes Problematic Files', async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  page,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
}) => {
  let fixtureMutated = false;
  let fixtureRestored = false;

  try {
    await stepLogger.step('Create the reported exception-tagged Problematic Files state', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(RARITY_ALBUM);
      await galleryActions.selectAlbumDetailsByIdentity({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setException('Non-album rarity');
      await tagEditorActions.applyAndWaitForSavedFiles({
        expectNonAlbumRarityWarning: true,
      });
      fixtureMutated = true;

      await trackModalActions.close();
      await settingsModalAppBarActions.openSettings();
      await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
      const sourceItems = await utilityProblematicFilesActions.readVisibleListItems();
      const sourceIndex = sourceItems.findIndex((item) => (
        item.meta === RARITY_ARTIST && item.title.startsWith(RARITY_ALBUM)
      ));
      expect(sourceIndex).toBeGreaterThanOrEqual(0);
      await utilityProblematicFilesActions.selectListItemByIndex(sourceIndex);
      await utilityProblematicFilesActions.expectTrackVisibleInDetail(RARITY_TRACK_TITLE);
    });

    await stepLogger.step('Clear Album and Exception through Problematic Files and refresh the retained source album', async () => {
      await utilityProblematicFilesActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.clearAlbumName();
      await tagEditorActions.clearException();
      await tagEditorActions.expectBlankAlbumCanApply();
      await tagEditorActions.applyAndWaitForSavedFiles();
      await utilityProblematicFilesActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      expect((await tagEditorActions.readSummary()).trackFilenames).toEqual([
        SIBLING_TRACK_FILENAME,
      ]);
      await tagEditorActions.close();
    });

    await stepLogger.step('Persist a blank physical Album tag and expose that blank when reopened', async () => {
      const physicalTags = await readGeneratedMp3AlbumTags({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
      });
      expect(physicalTags.find((item) => item.filename === RARITY_TRACK_FILENAME)?.albumValues).toEqual([]);

      await settingsModalAppBarActions.closeSettings({ timeout: 10000 });
      await searchToolbarActions.clearSearch({ submitWithEnter: true });
      await searchToolbarActions.waitForQuery('');
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.expectCompactGroupedNonAlbumTable({
        sections: ['Other'],
        tracks: [{
          title: RARITY_TRACK_TITLE,
          artist: RARITY_ARTIST,
          pathSuffix: RARITY_TRACK_FILENAME,
          number: 1,
        }],
      });
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.expectAlbumName('');
      expect((await tagEditorActions.readSummary()).exceptionType).toBe('');
    });

    await stepLogger.step('Restore the generated fixture through the same editor', async () => {
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.applyAndWaitForSavedFiles();
      fixtureRestored = true;
    });
  } finally {
    if (fixtureMutated && !fixtureRestored) {
      await tagEditorActions.dismissTopmostOverlayWithEscape();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(1);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
    }
  }
});

test('FTC-TAGS-004 and FTC-NON-ALBUM-014 preserve rapid Album and Exception edits across gallery transitions', async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  test.setTimeout(180000);
  let fixtureMutated = false;
  let fixtureRestored = false;

  try {
    await stepLogger.step('Move both generated tracks out of the gallery as non-album rarities', async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await tagEditorActions.openForAlbum({
        album: RARITY_ALBUM,
        artist: RARITY_ARTIST,
        expectedTrackCount: 2,
        galleryActions,
        trackModalActions,
        year: RARITY_YEAR,
      });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setException('Non-album rarity');
      await tagEditorActions.applyAndWaitForSavedFiles({
        expectNonAlbumRarityWarning: true,
      });
      fixtureMutated = true;
      await trackModalActions.closeIfOpen();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      })).toBe(0);
    });

    await stepLogger.step('Clear one Album tag and reopen the same loose track with a blank value', async () => {
      await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.clearAlbumName();
      await tagEditorActions.expectBlankAlbumCanApply();
      await tagEditorActions.applyAndWaitForSavedFiles();
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.expectAlbumName('');
      expect((await tagEditorActions.readSummary()).exceptionType).toBe('Non-album rarity');
    });

    await stepLogger.step('Restore Album without waiting between edits and retain rarity suppression', async () => {
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.applyAndWaitForSavedFiles();
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
      await tagEditorActions.expectAlbumName(RARITY_ALBUM);
      expect((await tagEditorActions.readSummary()).exceptionType).toBe('Non-album rarity');
      await tagEditorActions.close();
      expect(
        (await readGeneratedMp3AlbumTags({
          artist: RARITY_ARTIST,
          album: RARITY_ALBUM,
        })).find((item) => item.filename === RARITY_TRACK_FILENAME)?.albumValues,
      ).toEqual([RARITY_ALBUM]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      })).toBe(0);
    });

    await stepLogger.step('Clear Exception for every loose track and reopen the canonical album', async () => {
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      })).toBe(1);
      await tagEditorActions.openForAlbum({
        album: RARITY_ALBUM,
        artist: RARITY_ARTIST,
        expectedTrackCount: 2,
        galleryActions,
        trackModalActions,
        year: RARITY_YEAR,
      });
      await tagEditorActions.selectAllTracks();
      expect((await tagEditorActions.readSummary()).exceptionType).toBe('');
      await tagEditorActions.close();
    });

    await stepLogger.step('Apply rarity from Album Details and remove its final gallery card', async () => {
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setException('Non-album rarity');
      await tagEditorActions.applyAndWaitForSavedFiles({
        expectNonAlbumRarityWarning: true,
      });
      await trackModalActions.closeIfOpen();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
        year: RARITY_YEAR,
      })).toBe(0);
    });

    await stepLogger.step('Restore the shared generated fixture through Loose Tracks', async () => {
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
      fixtureRestored = true;
    });
  } finally {
    if (fixtureMutated && !fixtureRestored) {
      await tagEditorActions.dismissTopmostOverlayWithEscape();
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
        await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
      }
      await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
      await artistPageSettingsActions.openNonAlbumTracks(2);
      await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(RARITY_ALBUM);
      await tagEditorActions.clearException();
      await tagEditorActions.applyAndWaitForSavedFiles();
    }
  }
});

test('FTC-NON-ALBUM-010 / FTC-NON-ALBUM-009 / FTC-NON-ALBUM-008 / FTC-NON-ALBUM-007 / FTC-NON-ALBUM-006 / FTC-TAGS-007 / FTC-NON-ALBUM-005 keeps rarity modal transitions and sibling album state canonical', async ({
  artistPageSettingsActions,
  galleryActions,
  navigationPanelActions,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  thirdPartyRequestEvidence,
  trackModalActions,
  utilityProblematicFilesActions,
}) => {
  await stepLogger.step('Open the isolated two-track rarity fixture through the normal gallery', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(RARITY_ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(RARITY_ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      year: RARITY_YEAR,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.trackRows).toBe(2);
    expect((await trackModalActions.readTrackAt(0)).title).toBe(RARITY_TRACK_TITLE);
    expect((await trackModalActions.readTrackAt(1)).title).toBe(SIBLING_TRACK_TITLE);
  });

  await stepLogger.step('Mark only the first generated MP3 as a non-album rarity', async () => {
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual([
      RARITY_TRACK_FILENAME,
      SIBLING_TRACK_FILENAME,
    ]);
    await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
    await tagEditorActions.setException('Non-album rarity');
    await tagEditorActions.expectNonAlbumRarityConfirmationThenCancel();
    await tagEditorActions.clearException();
    await tagEditorActions.clearAlbumName();
    await tagEditorActions.expectBlankAlbumCanApply();
    await tagEditorActions.setException('Non-album rarity');
    await tagEditorActions.expectBlankAlbumCanApply();
    await tagEditorActions.setAlbumName(RARITY_ALBUM);
    await tagEditorActions.applyAndWaitForSavedFiles({
      expectNonAlbumRarityWarning: true,
    });
    const modal = await trackModalActions.waitForInteractiveSummary();
    expect(modal.trackRows).toBe(1);
    expect((await trackModalActions.readTrackAt(0)).title).toBe(SIBLING_TRACK_TITLE);
    await trackModalActions.expectProblemLinkVisibleForTrack(SIBLING_TRACK_TITLE);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    const immediateEditor = await tagEditorActions.readSummary();
    expect(immediateEditor.trackFilenames).toEqual([SIBLING_TRACK_FILENAME]);
    expect(immediateEditor.alertText).not.toContain('No tracks to edit');
    await tagEditorActions.close();
  });

  await stepLogger.step('Keep one canonical album card and remove the phantom album state', async () => {
    await trackModalActions.close();
    await artistPageSettingsActions.openNonAlbumTracks(1);
    expect(await artistPageSettingsActions.readNonAlbumTrackTitles()).toEqual([
      RARITY_TRACK_TITLE,
    ]);
    await artistPageSettingsActions.closeNonAlbumTracks();
    await settingsModalAppBarActions.openSettings();
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    const problematicItems = await utilityProblematicFilesActions.readVisibleListItems();
    const looseProblemIndex = problematicItems.findIndex((item) => (
      item.meta === RARITY_ARTIST && item.title.startsWith(RARITY_ALBUM)
    ));
    expect(looseProblemIndex).toBeGreaterThanOrEqual(0);
    await utilityProblematicFilesActions.selectListItemByIndex(looseProblemIndex);
    await utilityProblematicFilesActions.expectTrackVisibleInDetail(RARITY_TRACK_TITLE);
    await settingsModalAppBarActions.closeSettings();
    await searchToolbarActions.clearSearch({ submitWithEnter: true });
    await searchToolbarActions.waitForQuery('');
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
    const albumNames = await galleryActions.readAlbumNamesByHeading(RARITY_ARTIST);
    expect(albumNames.filter((albumName) => albumName === RARITY_ALBUM)).toEqual([RARITY_ALBUM]);
    expect(new Set(albumNames).size).toBe(albumNames.length);
    await artistPageSettingsActions.openNonAlbumTracks(1);
    expect(await artistPageSettingsActions.readNonAlbumTrackTitles()).toEqual([
      RARITY_TRACK_TITLE,
    ]);
    await artistPageSettingsActions.openProblematicFilesForNonAlbumTrack(RARITY_TRACK_TITLE);
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.expectTrackVisibleInDetail(RARITY_TRACK_TITLE);
    await utilityProblematicFilesActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
    expect((await tagEditorActions.readSummary()).exceptionType).toBe('Non-album rarity');
    await tagEditorActions.close();
    await settingsModalAppBarActions.closeSettings({ timeout: 10000 });
    await artistPageSettingsActions.expectNonAlbumTracksOpen(1);
    await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    const looseTrackEditor = await tagEditorActions.readSummary();
    expect(looseTrackEditor.trackFilenames).toEqual([RARITY_TRACK_FILENAME]);
    expect(looseTrackEditor.exceptionType).toBe('Non-album rarity');
    await tagEditorActions.close();
  });

  await stepLogger.step('Reload through the production app and preserve the one-track album', async () => {
    await searchToolbarActions.reloadCurrentView();
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.waitForQuery('');
    await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
    const albumNames = await galleryActions.readAlbumNamesByHeading(RARITY_ARTIST);
    expect(albumNames.filter((albumName) => albumName === RARITY_ALBUM)).toEqual([RARITY_ALBUM]);
    expect(new Set(albumNames).size).toBe(albumNames.length);
    await artistPageSettingsActions.openNonAlbumTracks(1);
    expect(await artistPageSettingsActions.readNonAlbumTrackTitles()).toEqual([
      RARITY_TRACK_TITLE,
    ]);
    await artistPageSettingsActions.closeNonAlbumTracks();
  });

  await stepLogger.step('Reopen album editing with the remaining sibling track', async () => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      year: RARITY_YEAR,
    });
    const modal = await trackModalActions.waitForInteractiveSummary();
    expect(modal.trackRows).toBe(1);
    expect((await trackModalActions.readTrackAt(0)).title).toBe(SIBLING_TRACK_TITLE);
    await trackModalActions.expectProblemLinkVisibleForTrack(SIBLING_TRACK_TITLE);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    const editor = await tagEditorActions.readSummary();
    expect(editor.trackFilenames).toEqual([SIBLING_TRACK_FILENAME]);
    expect(editor.alertText).not.toContain('No tracks to edit');
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
    await tagEditorActions.close();
  });

  await stepLogger.step('Keep the persisted rarity out of album search results', async () => {
    await trackModalActions.close();
    await searchToolbarActions.search(RARITY_TRACK_TITLE, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(RARITY_TRACK_TITLE);
    await galleryActions.waitForAlbumHidden(RARITY_ALBUM);
  });

  await stepLogger.step('Restore the generated rarity fixture for independent following tests', async () => {
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    if (await navigationPanelActions.readActiveSidebarArtistName() !== RARITY_ARTIST) {
      await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
    }
    await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
    await artistPageSettingsActions.openNonAlbumTracks(1);
    await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    await tagEditorActions.selectTrackByFilename(RARITY_TRACK_FILENAME);
    await tagEditorActions.clearException();
    await tagEditorActions.applyAndWaitForSavedFiles();
  });
});

test('FTC-TAGS-024 completes a verified Album and Exception intent during app restart', async ({
  artistPageSettingsActions,
  galleryActions,
  managedAppLifecycle,
  navigationPanelActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  test.setTimeout(180000);
  let stagedIntent;

  await stepLogger.step('Stage the exact crash boundary after file verification and before Postgres publication', async () => {
    stagedIntent = await stageFilesVerifiedAlbumAndExceptionIntent({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      filename: SIBLING_TRACK_FILENAME,
      requestedAlbum: RECOVERED_RARITY_ALBUM,
    });
    expect(await readTagEditIntentStatus(stagedIntent.intentId)).toEqual({
      status: 'files_verified',
      lastError: null,
    });
  });

  await stepLogger.step('Restart the production app and reconcile the unfinished intent before hydration', async () => {
    await managedAppLifecycle.restart();
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(RARITY_ARTIST, RARITY_ALBUM);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: RARITY_ARTIST,
      album: RECOVERED_RARITY_ALBUM,
      year: RARITY_YEAR,
    })).toBe(0);
    expect(await readTagEditIntentStatus(stagedIntent.intentId)).toEqual({
      status: 'completed',
      lastError: null,
    });
    expect(await readGeneratedTrackPostgresState(stagedIntent.trackPath)).toEqual({
      album: RECOVERED_RARITY_ALBUM,
      exceptionType: 'Non-album rarity',
    });
  });

  await stepLogger.step('Expose the recovered physical Album and app-owned Exception through Loose Tracks', async () => {
    await navigationPanelActions.selectSidebarArtistByName(RARITY_ARTIST);
    await navigationPanelActions.waitForSidebarSelection(RARITY_ARTIST);
    await artistPageSettingsActions.openNonAlbumTracks(1);
    await artistPageSettingsActions.openNonAlbumTracksInTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    await tagEditorActions.selectTrackByFilename(SIBLING_TRACK_FILENAME);
    await tagEditorActions.expectAlbumName(RECOVERED_RARITY_ALBUM);
    expect((await tagEditorActions.readSummary()).exceptionType).toBe('Non-album rarity');
    expect(
      (await readGeneratedMp3AlbumTags({
        artist: RARITY_ARTIST,
        album: RARITY_ALBUM,
      })).find((item) => item.filename === SIBLING_TRACK_FILENAME)?.albumValues,
    ).toEqual([RECOVERED_RARITY_ALBUM]);
  });

  await stepLogger.step('Clear the recovered Exception and publish the recovered album card', async () => {
    await tagEditorActions.clearException();
    await tagEditorActions.applyAndWaitForSavedFiles();
    expect(await readGeneratedTrackPostgresState(stagedIntent.trackPath)).toEqual({
      album: RECOVERED_RARITY_ALBUM,
      exceptionType: '',
    });
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(
      RARITY_ARTIST,
      RECOVERED_RARITY_ALBUM,
    );
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: RARITY_ARTIST,
      album: RECOVERED_RARITY_ALBUM,
      year: RARITY_YEAR,
    })).toBe(1);
  });

  await stepLogger.step('Restore the generated track to its original album through Edit Tags', async () => {
    await tagEditorActions.openForAlbum({
      album: RECOVERED_RARITY_ALBUM,
      artist: RARITY_ARTIST,
      expectedTrackCount: 1,
      galleryActions,
      trackModalActions,
      year: RARITY_YEAR,
    });
    await tagEditorActions.selectTrackByFilename(SIBLING_TRACK_FILENAME);
    await tagEditorActions.setAlbumName(RARITY_ALBUM);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(RARITY_ARTIST)}`);
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: RARITY_ARTIST,
      album: RECOVERED_RARITY_ALBUM,
      year: RARITY_YEAR,
    })).toBe(0);
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: RARITY_ARTIST,
      album: RARITY_ALBUM,
      year: RARITY_YEAR,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(2);
  });
});
