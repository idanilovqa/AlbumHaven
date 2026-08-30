import { expect, test } from '../support/baseFixtures.js';
import {
  changedId3Frames,
  readGeneratedMp3TagSnapshots,
} from '../helpers/physicalTagHelpers.js';
import { queryPersistedAlbumTrackMetadata } from '../helpers/postgresAlbumIdentityHelpers.js';
import { holdProblemExclusionPersistence } from '../helpers/problemExclusionPersistenceGate.js';
import {
  temporarilyRevokeRuntimeDeletePrivileges,
  temporarilyRevokeRuntimeInsertPrivileges,
} from '../helpers/postgresPrivilegeHelpers.js';

const ALBUM_ARTIST = 'Neal Morse';
const ALBUM = 'Neal Morse Plays Pink Floyd';
const ALBUM_YEAR = '2023';
const PROBLEMATIC_TRACK = 'Comfortably Numb';
const HEALTHY_TRACK = 'Breathe';
const ALBUM_EXCLUSION_REASON = 'Missing cover art';
const LEGACY_IGNORED_ARTIST = 'Generated Problem Fixture';
const LEGACY_IGNORED_ALBUM = '?';
const LEGACY_IGNORED_YEAR = '2005';
const LEGACY_IGNORED_REASON = 'Undecoded characters';
const LEGACY_IGNORED_DISPLAY_REASON = 'Undecoded characters ("?" in Album)';
const LEGACY_IGNORED_RULE_TARGET = `${LEGACY_IGNORED_ARTIST} - ${LEGACY_IGNORED_ALBUM} - ${LEGACY_IGNORED_YEAR}`;
const PARTIAL_LEGACY_IGNORED_ALBUM = 'Partial \uFFFD Metadata And Cover';
const PARTIAL_LEGACY_IGNORED_TRACK_COUNT = 17;
const SUGGESTED_EDIT_ALBUM = 'Encoding And Missing Metadata';
const SUGGESTED_EDIT_ARTIST = 'Generated Problem Fixture';
const EXPECTED_EDIT_TAG_FILENAMES = Array.from({ length: 17 }, (_, index) => {
  const trackNumber = index + 2;
  return trackNumber === 18
    ? '18 - Comfortably Numb.mp3'
    : `${String(trackNumber).padStart(2, '0')} - Track ${trackNumber}.mp3`;
});

test('FTC-UTIL-PROBLEMS-011 hides dead problem actions for a generated excluded album', async ({
  galleryActions,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityProblematicFilesActions,
  utilityRulesActions,
  utilityTabBarActions,
}) => {
  await stepLogger.step('Hide Problematic Files actions before that utility has loaded', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(LEGACY_IGNORED_ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(LEGACY_IGNORED_ARTIST);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      LEGACY_IGNORED_ARTIST,
      LEGACY_IGNORED_ALBUM,
    );
    await galleryActions.clickAlbumDetailsByAlbumName(LEGACY_IGNORED_ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${LEGACY_IGNORED_ARTIST} - ${LEGACY_IGNORED_ALBUM}`);
    await trackModalActions.expectProblemLinksAbsent();
    await trackModalActions.close();
  });

  await stepLogger.step('Prove the generated album has one persisted album exclusion', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    const exclusionTables = await utilityRulesActions.readProblemExclusionTables();
    expect(exclusionTables.album.rows).toEqual([
      expect.stringContaining(`${LEGACY_IGNORED_RULE_TARGET}${LEGACY_IGNORED_REASON}`),
    ]);
  });

  await stepLogger.step('Keep the generated excluded album out of Problematic Files', async () => {
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.waitForNoSearchResults(LEGACY_IGNORED_ALBUM);
  });
});

test('FTC-UTIL-PROBLEMS-011 opens the exact problematic track from album details', async ({
  galleryActions,
  searchToolbarActions,
  settingsModalAppBarActions,
  stepLogger,
  tagEditorActions,
  trackModalActions,
  utilityProblematicFilesActions,
}) => {
  let fullProblematicAlbumCount = 0;
  let unrelatedAlbumTitle = '';
  let targetTrackPath = '';

  await stepLogger.step('Open the persisted album directly without loading Settings first', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisibleUnderHeading(ALBUM_ARTIST, ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    const summary = await trackModalActions.waitForLoadedSummary();
    expect(summary.title).toContain(`${ALBUM_ARTIST} - ${ALBUM}`);
  });

  await stepLogger.step('Show the server-owned Problematic Files action on the late problematic track', async () => {
    await trackModalActions.expectProblemLinkAbsentForTrack(HEALTHY_TRACK);
    await trackModalActions.expectProblemLinkVisibleForTrack(PROBLEMATIC_TRACK);
    targetTrackPath = await trackModalActions.readTrackPathByTitle(PROBLEMATIC_TRACK);
    expect(targetTrackPath).not.toBe('');
  });

  await stepLogger.step('Establish a real filtered sidebar with the target initially below its viewport', async () => {
    await trackModalActions.close();
    await settingsModalAppBarActions.openSettings();
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    const fullProblematicAlbums = await utilityProblematicFilesActions.readVisibleListItems();
    fullProblematicAlbumCount = fullProblematicAlbums.length;
    expect(fullProblematicAlbumCount).toBeGreaterThan(9);
    await utilityProblematicFilesActions.search(PROBLEMATIC_TRACK);
    await utilityProblematicFilesActions.waitForSearchResults(PROBLEMATIC_TRACK);
    const filteredProblematicAlbums = await utilityProblematicFilesActions.readVisibleListItems();
    expect(filteredProblematicAlbums.length).toBeLessThan(fullProblematicAlbumCount);
    expect(filteredProblematicAlbums.find((album) => (
      album.meta === ALBUM_ARTIST
      && (album.title === ALBUM || album.title.startsWith(`${ALBUM} / `))
    ))).toMatchObject({
      title: `${ALBUM} / ${ALBUM_YEAR}`,
      meta: ALBUM_ARTIST,
    });
    const filteredKeys = new Set(filteredProblematicAlbums.map((album) => album.key));
    unrelatedAlbumTitle = fullProblematicAlbums.find((album) => !filteredKeys.has(album.key))?.title || '';
    expect(unrelatedAlbumTitle).not.toBe('');
    await utilityProblematicFilesActions.waitForTargetAlbumBelowSidebarViewport(ALBUM, {
      minimumResultCount: 9,
    });
    await settingsModalAppBarActions.closeSettings();
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    await trackModalActions.waitForReady();
    expect(await trackModalActions.readTrackPathByTitle(PROBLEMATIC_TRACK)).toBe(targetTrackPath);
  });

  await stepLogger.step('Open Problematic Files from that exact track and scroll the matching album into view', async () => {
    await utilityProblematicFilesActions.startNavigationRenderObservation();
    await trackModalActions.openProblematicFilesForTrack(PROBLEMATIC_TRACK);
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.waitForSelectedDetailSelection({ expectedTitle: ALBUM });
    await utilityProblematicFilesActions.waitForActiveAlbumInSidebarViewport(ALBUM);
    expect(await utilityProblematicFilesActions.readSearchQuery()).toBe('');
    expect(await utilityProblematicFilesActions.readVisibleResultCount()).toBe(fullProblematicAlbumCount);
    expect(await utilityProblematicFilesActions.waitForAlbumInSidebarList(unrelatedAlbumTitle)).toBe(
      unrelatedAlbumTitle,
    );
    const detail = await utilityProblematicFilesActions.readSelectedDetailSummary();
    expect(detail.title).toBe(ALBUM);
    const navigationRecords = await utilityProblematicFilesActions.finishNavigationRenderObservation();
    const meaningfulDetailRenders = navigationRecords.filter((record) => record.detailTitle || record.detailText);
    expect(meaningfulDetailRenders).toHaveLength(1);
    expect(meaningfulDetailRenders[0]).toMatchObject({
      detailTitle: ALBUM,
    });
    expect(meaningfulDetailRenders[0].activeKey).not.toBe('');
  });

  await stepLogger.step('Keep the exact target track row inside the visible detail viewport', async () => {
    const detailTrackPath = await utilityProblematicFilesActions.waitForProblematicTrackInDetailViewport(targetTrackPath);
    expect(detailTrackPath).toBe(targetTrackPath);
  });

  await stepLogger.step('Show Problematic Files tracks in deterministic Edit Tags order', async () => {
    await utilityProblematicFilesActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: EXPECTED_EDIT_TAG_FILENAMES.length });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      EXPECTED_EDIT_TAG_FILENAMES,
    );
    await tagEditorActions.close();
  });

});

test('FTC-UTIL-PROBLEMS-001 scopes exclusions with optimistic persistence and reload', async ({
  galleryActions,
  page,
  settingsModalAppBarActions,
  stepLogger,
  testArtifacts,
  utilityProblematicFilesActions,
  utilityRulesActions,
  utilityTabBarActions,
}) => {
  let consecutiveRows = [];
  let createdFileExclusionKeys = [];
  let initialProblemCount = 0;
  let sharedReason = '';

  try {
  await stepLogger.step('Apply an album exclusion optimistically over matching legacy file-field rules', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    const startupExclusionTables = await utilityRulesActions.readProblemExclusionTables();
    expect(startupExclusionTables.album.headers).toEqual(['Artist / Album', 'Reason', 'Actions']);
    expect(startupExclusionTables.album.rows).toEqual([
      expect.stringContaining(`${LEGACY_IGNORED_RULE_TARGET}${LEGACY_IGNORED_REASON}`),
    ]);
    expect(startupExclusionTables.album.rows.join('\n')).not.toContain(PARTIAL_LEGACY_IGNORED_ALBUM);
    const startupPartialRows = startupExclusionTables.file.rows.filter(
      (row) => row.includes(PARTIAL_LEGACY_IGNORED_ALBUM),
    );
    expect(startupPartialRows).toHaveLength(PARTIAL_LEGACY_IGNORED_TRACK_COUNT);

    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.waitForNoSearchResults(LEGACY_IGNORED_ALBUM);

    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    let revertGate = await holdProblemExclusionPersistence();
    try {
      const revertMutation = await utilityRulesActions.beginRevertRuleContaining(
        LEGACY_IGNORED_REASON,
      );
      expect((await utilityRulesActions.readProblemExclusionRows()).album).toEqual([]);
      expect(await utilityProblematicFilesActions.readRepairProgressOverlayVisible()).toBe(false);
      expect(revertMutation.isAcknowledgementSettled()).toBe(false);
      await revertGate.release();
      revertGate = null;
      await revertMutation.waitForAcknowledgement();
    } finally {
      await revertGate?.dispose();
    }

    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(LEGACY_IGNORED_ALBUM);
    expect(await utilityProblematicFilesActions.readAlbumProblemReasons()).toEqual([
      LEGACY_IGNORED_DISPLAY_REASON,
    ]);
    expect(await utilityProblematicFilesActions.readDetectedTrackRows()).toHaveLength(18);
    expect(await utilityProblematicFilesActions.readDetectedProblemsLayout()).toEqual({
      actionCount: 1,
      hasTrackSection: true,
      actionAfterAlbum: true,
      actionAfterTrack: true,
    });
    await utilityProblematicFilesActions.selectAlbumProblem(LEGACY_IGNORED_REASON);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    let createGate = await holdProblemExclusionPersistence();
    try {
      const createMutation = await utilityProblematicFilesActions.beginConfirmExclusion();
      await utilityProblematicFilesActions.waitForOptimisticAlbumRemoval(LEGACY_IGNORED_ALBUM);
      await utilityProblematicFilesActions.waitForNoSearchResults(LEGACY_IGNORED_ALBUM);
      expect(await utilityProblematicFilesActions.readRepairProgressOverlayVisible()).toBe(false);

      await utilityTabBarActions.openTab('rules');
      await utilityRulesActions.waitForReady();
      await utilityRulesActions.openProblemExclusions();
      expect(await utilityRulesActions.waitForPendingAlbumExclusion(LEGACY_IGNORED_RULE_TARGET))
        .toEqual({
          ariaBusy: 'true',
          revertDisabled: true,
          text: expect.stringContaining(
            `${LEGACY_IGNORED_RULE_TARGET}${LEGACY_IGNORED_REASON}`,
          ),
        });

      await createGate.release();
      createGate = null;
      await createMutation.waitForAcknowledgement();
      await utilityRulesActions.waitForExclusionAcknowledged(LEGACY_IGNORED_RULE_TARGET);

      await settingsModalAppBarActions.closeSettings();
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
      await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
      await utilityProblematicFilesActions.waitForNoSearchResults(LEGACY_IGNORED_ALBUM);
      await utilityTabBarActions.openTab('rules');
      await utilityRulesActions.waitForReady();
      await utilityRulesActions.openProblemExclusions();
      await utilityRulesActions.waitForExclusionAcknowledged(LEGACY_IGNORED_RULE_TARGET);
    } finally {
      await createGate?.dispose();
    }
    expect(await utilityProblematicFilesActions.readTagRepairErrorToastCount()).toBe(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    const exclusionTables = await utilityRulesActions.readProblemExclusionTables();
    expect(exclusionTables.album.headers).toEqual(['Artist / Album', 'Reason', 'Actions']);
    expect(exclusionTables.album.rows).toEqual([
      expect.stringContaining(`${LEGACY_IGNORED_RULE_TARGET}${LEGACY_IGNORED_REASON}`),
    ]);
    expect(exclusionTables.file.rows.filter(
      (row) => row.includes(PARTIAL_LEGACY_IGNORED_ALBUM),
    )).toHaveLength(PARTIAL_LEGACY_IGNORED_TRACK_COUNT);

    revertGate = await holdProblemExclusionPersistence();
    try {
      const revertMutation = await utilityRulesActions.beginRevertRuleContaining(
        LEGACY_IGNORED_REASON,
      );
      expect((await utilityRulesActions.readProblemExclusionRows()).album).toEqual([]);
      expect(await utilityProblematicFilesActions.readRepairProgressOverlayVisible()).toBe(false);
      expect(revertMutation.isAcknowledgementSettled()).toBe(false);
      await revertGate.release();
      revertGate = null;
      await revertMutation.waitForAcknowledgement();
    } finally {
      await revertGate?.dispose();
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();

    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(LEGACY_IGNORED_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(LEGACY_IGNORED_ALBUM);
    expect(await utilityProblematicFilesActions.readAlbumProblemReasons()).toEqual([
      LEGACY_IGNORED_DISPLAY_REASON,
    ]);
    expect(await utilityProblematicFilesActions.readDetectedTrackRows()).toHaveLength(18);
    expect(await utilityProblematicFilesActions.readTagRepairErrorToastCount()).toBe(0);
  });

  await stepLogger.step('Open the target Problematic Files album and establish its detected rows', async () => {
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(ALBUM);
    const rows = await utilityProblematicFilesActions.readDetectedTrackRows();
    consecutiveRows = rows.slice(0, 3);
    expect(consecutiveRows).toHaveLength(3);
    sharedReason = consecutiveRows[0].reasons.find((reason) => (
      consecutiveRows.every((row) => row.reasons.includes(reason))
    ));
    expect(sharedReason).toBeTruthy();
    expect(await utilityProblematicFilesActions.readAlbumProblemReasons())
      .toContain(ALBUM_EXCLUSION_REASON);
    initialProblemCount = await utilityProblematicFilesActions.readVisibleProblemReasonCount();
  });

  await stepLogger.step('Create, persist, inspect, and reverse exact album and file exclusions', async () => {
    const rows = await utilityProblematicFilesActions.readDetectedTrackRows();

    const siblingRow = rows.find((row) => row.reasons.length > 1);
    expect(siblingRow).toBeTruthy();
    await utilityProblematicFilesActions.selectFileProblem(siblingRow.filename, siblingRow.reasons[0]);
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toEqual([
      expect.objectContaining({ reason: siblingRow.reasons[0] }),
    ]);
    await utilityProblematicFilesActions.unselectFileProblem(siblingRow.filename, siblingRow.reasons[0]);
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toEqual([]);
    expect(await utilityProblematicFilesActions.readExcludeProblemEnabled()).toBe(false);

    const differentBoundaryIndex = rows.findIndex((row, index) => (
      index < rows.length - 1
      && row.reasons.some((reason) => !rows[index + 1].reasons.includes(reason))
      && rows[index + 1].reasons.length > 0
    ));
    expect(differentBoundaryIndex).toBeGreaterThanOrEqual(0);
    const boundaryReason = rows[differentBoundaryIndex].reasons.find(
      (reason) => !rows[differentBoundaryIndex + 1].reasons.includes(reason),
    );
    await utilityProblematicFilesActions.dragBetweenProblemPills(
      { filename: rows[differentBoundaryIndex].filename, reason: boundaryReason },
      { filename: rows[differentBoundaryIndex + 1].filename, reason: rows[differentBoundaryIndex + 1].reasons[0] },
    );
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toEqual([
      expect.objectContaining({ reason: boundaryReason }),
    ]);

    const gapStartIndex = rows.findIndex((row, index) => (
      index < rows.length - 2
      && row.reasons.some((reason) => (
        !rows[index + 1].reasons.includes(reason)
        && rows.slice(index + 2).some((later) => later.reasons.includes(reason))
      ))
    ));
    expect(gapStartIndex).toBeGreaterThanOrEqual(0);
    const gapReason = rows[gapStartIndex].reasons.find((reason) => (
      !rows[gapStartIndex + 1].reasons.includes(reason)
      && rows.slice(gapStartIndex + 2).some((later) => later.reasons.includes(reason))
    ));
    const nonconsecutiveRow = rows.slice(gapStartIndex + 2).find((row) => row.reasons.includes(gapReason));
    await utilityProblematicFilesActions.dragBetweenProblemPills(
      { filename: rows[gapStartIndex].filename, reason: gapReason },
      { filename: nonconsecutiveRow.filename, reason: gapReason },
    );
    const selectedAcrossGap = await utilityProblematicFilesActions.readSelectedProblemInstances();
    expect(selectedAcrossGap).toHaveLength(2);
    expect(selectedAcrossGap.every((item) => item.scope === 'file' && item.reason === gapReason)).toBe(true);
    expect(new Set(selectedAcrossGap.map((item) => item.key)).size).toBe(2);

    await utilityProblematicFilesActions.search(SUGGESTED_EDIT_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(SUGGESTED_EDIT_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(SUGGESTED_EDIT_ALBUM);
    const suggestionAlbumReasons = await utilityProblematicFilesActions.readAlbumProblemReasons();
    expect(suggestionAlbumReasons.length).toBeGreaterThan(0);
    await utilityProblematicFilesActions.selectAlbumProblem(suggestionAlbumReasons[0]);
    expect(await utilityProblematicFilesActions.readSuggestedEditsApplyEnabled()).toBe(true);
    expect(await utilityProblematicFilesActions.chooseFirstSuggestedEditWithoutApplying()).toEqual([
      expect.objectContaining({ scope: 'album', reason: suggestionAlbumReasons[0] }),
    ]);

    await utilityProblematicFilesActions.search(ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(ALBUM);
    await utilityProblematicFilesActions.selectAlbumProblem(ALBUM_EXCLUSION_REASON);
    await utilityProblematicFilesActions.unselectAlbumProblem(ALBUM_EXCLUSION_REASON);
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toEqual([]);
    expect(await utilityProblematicFilesActions.readExcludeProblemEnabled()).toBe(false);
    await utilityProblematicFilesActions.selectAlbumProblem(ALBUM_EXCLUSION_REASON);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    await utilityProblematicFilesActions.cancelExclusion();
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toHaveLength(1);

    await utilityProblematicFilesActions.selectFileProblem(consecutiveRows[0].filename, sharedReason);
    expect(await utilityProblematicFilesActions.readSelectedProblemInstances()).toEqual([
      expect.objectContaining({ scope: 'file', reason: sharedReason }),
    ]);
    await utilityProblematicFilesActions.dragFileProblemRange(
      consecutiveRows.map((row) => row.filename),
      sharedReason,
    );
    const selectedFiles = await utilityProblematicFilesActions.readSelectedProblemInstances();
    expect(selectedFiles).toHaveLength(3);
    expect(selectedFiles.every((item) => item.scope === 'file' && item.reason === sharedReason)).toBe(true);
    expect(new Set(selectedFiles.map((item) => item.key)).size).toBe(3);
    createdFileExclusionKeys = selectedFiles.map((item) => item.key);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    await utilityProblematicFilesActions.confirmExclusion();
    const rowsAfterFileExclusions = await utilityProblematicFilesActions.readDetectedTrackRows();
    expect(rowsAfterFileExclusions.some((row) => (
      !consecutiveRows.some((excluded) => excluded.filename === row.filename)
      && row.reasons.includes(sharedReason)
    ))).toBe(true);
    expect(await utilityProblematicFilesActions.readVisibleProblemReasonCount()).toBe(
      initialProblemCount - consecutiveRows.length,
    );

    await utilityProblematicFilesActions.selectAlbumProblem(ALBUM_EXCLUSION_REASON);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    await utilityProblematicFilesActions.confirmExclusion();
    expect(await utilityProblematicFilesActions.readAlbumProblemReasons())
      .not.toContain(ALBUM_EXCLUSION_REASON);
    expect(await utilityProblematicFilesActions.readVisibleProblemReasonCount()).toBe(
      initialProblemCount - consecutiveRows.length,
    );

    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    let tables = await utilityRulesActions.readProblemExclusionTables();
    expect(tables.album.headers).toEqual(['Artist / Album', 'Reason', 'Actions']);
    expect(tables.file.headers).toEqual(['Filename', 'Reason', 'Actions']);
    expect(tables.album.rows).toHaveLength(1);
    const createdFileExclusions = tables.file.rows.filter((row) => row.includes(ALBUM));
    expect(createdFileExclusions).toHaveLength(3);
    expect(tables.album.actionTrack).toBe('88px');
    expect(tables.file.actionTrack).toBe('88px');
    expect(new Set([...tables.album.reasonOrigins, ...tables.file.reasonOrigins]).size).toBe(1);

    const exclusionRulesBeforeSuggestedRepair = {
      album: tables.album.rows,
      file: tables.file.rows,
    };
    const physicalBeforeSuggestedRepair = await readGeneratedMp3TagSnapshots({
      artist: SUGGESTED_EDIT_ARTIST,
      album: SUGGESTED_EDIT_ALBUM,
    });
    const postgresBeforeSuggestedRepair = await queryPersistedAlbumTrackMetadata({
      artist: SUGGESTED_EDIT_ARTIST,
      album: SUGGESTED_EDIT_ALBUM,
    });

    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(SUGGESTED_EDIT_ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(SUGGESTED_EDIT_ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(SUGGESTED_EDIT_ALBUM);
    const suggestedRows = await utilityProblematicFilesActions.readSuggestedEditRows();
    const selectedTitleRepair = suggestedRows.find((row) => row.field === 'title');
    expect(selectedTitleRepair).toBeTruthy();
    expect(suggestedRows.length).toBeGreaterThan(1);
    await utilityProblematicFilesActions.applySuggestedEditSubset(selectedTitleRepair.rowKey);

    const physicalAfterSuggestedRepair = await readGeneratedMp3TagSnapshots({
      artist: SUGGESTED_EDIT_ARTIST,
      album: SUGGESTED_EDIT_ALBUM,
    });
    expect(
      changedId3Frames(physicalBeforeSuggestedRepair, physicalAfterSuggestedRepair)
        .filter((track) => track.changedFrames.length),
    ).toEqual([{
      filename: selectedTitleRepair.filename,
      changedFrames: ['TIT2'],
    }]);
    const postgresAfterSuggestedRepair = await queryPersistedAlbumTrackMetadata({
      artist: SUGGESTED_EDIT_ARTIST,
      album: SUGGESTED_EDIT_ALBUM,
    });
    const normalizedSelectedPath = selectedTitleRepair.path.toLowerCase();
    expect(postgresAfterSuggestedRepair).toEqual(postgresBeforeSuggestedRepair.map((row) => (
      String(row.path || '').toLowerCase() === normalizedSelectedPath
        ? { ...row, title: selectedTitleRepair.repaired }
        : row
    )));

    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    tables = await utilityRulesActions.readProblemExclusionTables();
    expect({ album: tables.album.rows, file: tables.file.rows }).toEqual(
      exclusionRulesBeforeSuggestedRepair,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await utilityRulesActions.readProblemExclusionMobileLayout();
    expect(mobileLayout.album).toEqual(expect.objectContaining({
      reasonColumn: 'reason',
      reasonBelowTarget: true,
      revertTopRight: true,
      visibleReasonLabelCount: 0,
    }));
    expect(mobileLayout.file).toEqual(expect.objectContaining({
      reasonColumn: 'reason',
      reasonBelowTarget: true,
      revertTopRight: true,
      visibleReasonLabelCount: 0,
    }));
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    tables = await utilityRulesActions.readProblemExclusionTables();
    expect(tables.album.rows).toHaveLength(1);
    expect(tables.file.rows.filter((row) => row.includes(ALBUM))).toHaveLength(3);

    for (const rowKey of createdFileExclusionKeys) {
      await utilityRulesActions.revertRuleByKey(rowKey);
    }
    await utilityRulesActions.revertRuleContaining(ALBUM);
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
    const restored = await utilityProblematicFilesActions.selectAlbumByTitle(ALBUM);
    expect(restored.problemReasons).toEqual(
      expect.arrayContaining([ALBUM_EXCLUSION_REASON, sharedReason]),
    );
  });

  expect(testArtifacts.getRuntimeLogs().filter((entry) => entry.kind === 'pageerror')).toEqual([]);
  expect(await utilityProblematicFilesActions.readTagRepairErrorToastCount()).toBe(0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    const persistedRows = await utilityRulesActions.readProblemExclusionRows();
    const legacyExclusionPresent = persistedRows.album.some((row) => (
      row.includes(LEGACY_IGNORED_RULE_TARGET)
      && row.includes(LEGACY_IGNORED_REASON)
    ));
    if (!legacyExclusionPresent) {
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
      await utilityProblematicFilesActions.search(LEGACY_IGNORED_ALBUM);
      await utilityProblematicFilesActions.waitForSearchResults(LEGACY_IGNORED_ALBUM);
      await utilityProblematicFilesActions.selectAlbumByTitle(LEGACY_IGNORED_ALBUM);
      await utilityProblematicFilesActions.selectAlbumProblem(LEGACY_IGNORED_REASON);
      expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
        'Are you sure? This will create an exclusion rule',
      );
      await utilityProblematicFilesActions.confirmExclusion();
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    expect((await utilityRulesActions.readProblemExclusionRows()).album).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${LEGACY_IGNORED_RULE_TARGET}${LEGACY_IGNORED_REASON}`),
      ]),
    );
  }
});

test('FTC-UTIL-PROBLEMS-001 rolls back failed exclusion creation and reversion', async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  utilityProblematicFilesActions,
  utilityRulesActions,
  utilityTabBarActions,
}) => {
  await stepLogger.step('Restore an optimistically removed album after a real create failure', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
    await utilityProblematicFilesActions.selectAlbumByTitle(ALBUM);
    await utilityProblematicFilesActions.selectAlbumProblem(ALBUM_EXCLUSION_REASON);
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );

    const privilegeGuard = await temporarilyRevokeRuntimeInsertPrivileges([
      'library.ignored_repairs',
    ]);
    try {
      const mutation = await utilityProblematicFilesActions.beginConfirmExclusion();
      await expect(mutation.waitForAcknowledgement()).rejects.toThrow(
        /Problem Exclusion creation returned HTTP 500/u,
      );
      expect(await utilityProblematicFilesActions.waitForErrorToast(
        'Failed to save problem exclusion',
      )).toContain('Failed to save problem exclusion');
      await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
      expect(await utilityProblematicFilesActions.readAlbumProblemReasons())
        .toContain(ALBUM_EXCLUSION_REASON);
    } finally {
      await privilegeGuard.restore();
    }
  });

  await stepLogger.step('Restore an optimistically removed Rules row after a real revert failure', async () => {
    const restoredSelection = await utilityProblematicFilesActions.readSelectedProblemInstances();
    if (restoredSelection.length === 0) {
      await utilityProblematicFilesActions.selectAlbumProblem(ALBUM_EXCLUSION_REASON);
    } else {
      expect(restoredSelection).toEqual([
        expect.objectContaining({
          scope: 'album',
          reason: ALBUM_EXCLUSION_REASON,
        }),
      ]);
    }
    expect(await utilityProblematicFilesActions.openExclusionConfirmation()).toBe(
      'Are you sure? This will create an exclusion rule',
    );
    await utilityProblematicFilesActions.confirmExclusion();
    await utilityTabBarActions.openTab('rules');
    await utilityRulesActions.waitForReady();
    await utilityRulesActions.openProblemExclusions();
    await utilityRulesActions.waitForExclusionAcknowledged(ALBUM);

    const privilegeGuard = await temporarilyRevokeRuntimeDeletePrivileges([
      'library.ignored_repairs',
    ]);
    try {
      const mutation = await utilityRulesActions.beginRevertRuleContaining(ALBUM);
      await expect(mutation.waitForAcknowledgement()).rejects.toThrow(
        /Problem Exclusion revert returned HTTP 500/u,
      );
      expect(await utilityProblematicFilesActions.waitForErrorToast(
        'Failed to revert problem exclusion',
      )).toContain('Failed to revert problem exclusion');
      await utilityRulesActions.waitForExclusionAcknowledged(ALBUM);
    } finally {
      await privilegeGuard.restore();
    }

    await utilityRulesActions.revertRuleContaining(ALBUM);
    await utilityTabBarActions.openTab('problematic-files');
    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(ALBUM);
    await utilityProblematicFilesActions.waitForSearchResults(ALBUM);
    expect(await utilityProblematicFilesActions.readAlbumProblemReasons())
      .toContain(ALBUM_EXCLUSION_REASON);
  });
});
