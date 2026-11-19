import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/performanceFixtures.js';
import {
  DDT_ARTIST,
  REMIXES_ALBUM,
  REMIXES_FILENAMES,
  REMIXES_SPLIT_ALBUM,
  REMIXES_SPLIT_FILENAMES,
  REMIXES_YEAR,
  expectRemixesPhysicalState,
  restoreRemixesMedia,
  restoreRemixesThroughApp,
  snapshotRemixesMedia,
} from '../helpers/ddtRemixesFixture.js';
import {
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';
import { expectComparableTimings } from '../helpers/timingComparability.js';

const CASE_ID = 'FTC-TAGS-031P';
const UNRELATED_SEARCH_ARTIST = 'Ария';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(DDT_ARTIST)}`;
const REPEATED_CYCLES = 4;
const SAVED_MESSAGE = /^Saved changes to 5 tracks in “.+”\.$/u;
const CONFIRM_BUTTON_TEXT = 'Yes, apply tags';
const BUDGET_KEYS = Object.freeze([
  'optimisticCardsMs',
  'confirmedSaveMs',
  'splitSaveMs',
  'mergeSaveMs',
  'cardsReadyMs',
  'albumDetailsOpenMs',
  'tagEditorOpenMs',
  'unrelatedSearchGalleryReadyMs',
  'albumSearchVisibleMs',
]);
const BUDGETS = Object.freeze(Object.fromEntries(BUDGET_KEYS.map((key) => [
  key,
  Object.freeze(performanceTimingBudget(`edit-tags-split-merge.${key}`)),
])));
const albumDetailsTitle = (album) => `${DDT_ARTIST} • ${album} • ${REMIXES_YEAR}`;

test.describe(`${CASE_ID} synthetic-large repeated Edit Tags split and merge`, () => {
  test('every split and merge save stays fast, comparable, and correct', async ({
    editTagsSplitMergeLocalReport,
    galleryActions,
    managedAppLifecycle,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
    tagEditorActions,
    trackModalActions,
  }) => {
    test.setTimeout(20 * 60 * 1000);
    requirePostgresRuntimeEnv('the repeated Edit Tags split-and-merge benchmark');

    const saves = [];
    const samples = Object.fromEntries(BUDGET_KEYS.map((key) => [key, []]));
    const record = (key, timingMs) => {
      samples[key].push(timingMs);
      expectTimingBudget(expect.soft, timingMs, BUDGETS[key], `${key} sample ${samples[key].length}`);
      return timingMs;
    };
    const mediaSnapshot = await snapshotRemixesMedia();

    const openEditor = async (album, trackCount) => {
      const openedAt = performance.now();
      await galleryActions.selectAlbumDetailsByIdentity({ artist: DDT_ARTIST, album, year: REMIXES_YEAR });
      await expect(trackModalActions.trackModal.title).toHaveText(albumDetailsTitle(album), { timeout: 60000 });
      const summary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
      record('albumDetailsOpenMs', performance.now() - openedAt);
      expect(summary.trackRows).toBe(trackCount);
      const editorStartedAt = performance.now();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: trackCount });
      record('tagEditorOpenMs', performance.now() - editorStartedAt);
    };

    const save = async ({ cycle, kind, expectedCards, hiddenAlbum, splitFilenames }) => {
      // Owner (2026-11-19): the cards show the new track counts as soon as the save is confirmed
      // in the editor; the server's answer then only confirms them.
      const cardTimeline = await galleryActions.startAlbumCardTrackCountTimeline({
        startButtonText: CONFIRM_BUTTON_TEXT,
        expectedCounts: Object.fromEntries([
          ...expectedCards.map((card) => [card.album, card.trackCount]),
          ...(hiddenAlbum ? [[hiddenAlbum, null]] : []),
        ]),
      });
      const startedAt = performance.now();
      const result = await tagEditorActions.applyAndWaitForTerminalSavedResponse({ timeout: 120000 });
      const saveMs = record(`${kind}SaveMs`, performance.now() - startedAt);
      const successMessages = result.notificationSamples
        .filter((sample) => sample.visible && SAVED_MESSAGE.test(sample.text));
      expect(successMessages.length, `${kind} ${cycle} shows its success message`).toBeGreaterThan(0);
      await expect(tagEditorActions.tagEditor.overlay).toBeHidden();
      await trackModalActions.closeIfOpen();
      for (const card of expectedCards) {
        await galleryActions.waitForPositiveRenderedAlbumCardTrackCounts({
          artist: DDT_ARTIST,
          album: card.album,
          year: REMIXES_YEAR,
          trackCount: card.trackCount,
        }, { timeout: 60000 });
      }
      if (hiddenAlbum) await galleryActions.waitForAlbumHidden(hiddenAlbum, { timeout: 60000 });
      const cardsReadyMs = record('cardsReadyMs', performance.now() - startedAt);
      const cardCounts = await cardTimeline.finish();
      expect(cardCounts.expectedCardsMs, `${kind} ${cycle} cards show the new track counts`).not.toBeNull();
      expect.soft(cardCounts.changedAfterExpected, `${kind} ${cycle} track counts stay put once shown`).toBe(false);
      record('optimisticCardsMs', cardCounts.expectedCardsMs);
      // The previous save's notice can still be showing when this one is confirmed.
      const confirmedSaveMs = record(
        'confirmedSaveMs',
        Math.min(...successMessages
          .map((sample) => sample.atMs)
          .filter((atMs) => atMs > cardCounts.clickedAtPageMs)) - cardCounts.clickedAtPageMs,
      );
      await expectRemixesPhysicalState(expect, { splitFilenames });
      const entry = {
        cycle,
        kind,
        saveMs,
        cardsReadyMs,
        optimisticCardsMs: cardCounts.expectedCardsMs,
        confirmedSaveMs,
        cardCountChanges: cardCounts.changes,
        postSaveTimeline: result.postSaveTimeline || null,
        saveTaskId: result.saveTaskId,
        phaseTimingsMs: result.payload.phase_timings_ms || null,
      };
      saves.push(entry);
      console.log(`[split-merge-entry] ${JSON.stringify(entry)}`);
      await editTagsSplitMergeLocalReport.recordTimingCheckpoint({
        key: `cycle-${cycle}-${kind}-save`,
        label: `Cycle ${cycle} ${kind}: click to terminal success`,
        timingMs: saveMs,
        details: entry,
      });
    };

    const splitAndMerge = async (cycle) => {
      await stepLogger.step(`Cycle ${cycle}: move five tracks to ${REMIXES_SPLIT_ALBUM}`, async () => {
        await openEditor(REMIXES_ALBUM, REMIXES_FILENAMES.length);
        await tagEditorActions.selectTracksByFilenames(REMIXES_SPLIT_FILENAMES);
        await tagEditorActions.setAlbumName(REMIXES_SPLIT_ALBUM);
        await save({
          cycle,
          kind: 'split',
          splitFilenames: REMIXES_SPLIT_FILENAMES,
          expectedCards: [
            { album: REMIXES_ALBUM, trackCount: 5 },
            { album: REMIXES_SPLIT_ALBUM, trackCount: 5 },
          ],
        });
      });
      await stepLogger.step(`Cycle ${cycle}: merge the five tracks back into ${REMIXES_ALBUM}`, async () => {
        await openEditor(REMIXES_SPLIT_ALBUM, REMIXES_SPLIT_FILENAMES.length);
        expect((await tagEditorActions.readSummary()).trackFilenames.sort())
          .toEqual([...REMIXES_SPLIT_FILENAMES].sort());
        await tagEditorActions.selectAllTracks();
        await tagEditorActions.setAlbumName(REMIXES_ALBUM);
        await save({
          cycle,
          kind: 'merge',
          splitFilenames: [],
          expectedCards: [{ album: REMIXES_ALBUM, trackCount: REMIXES_FILENAMES.length }],
          hiddenAlbum: REMIXES_SPLIT_ALBUM,
        });
      });
    };

    const searchAndMeasure = async (query, key, waitForResult) => {
      let submittedAt = 0;
      await searchToolbarActions.search(query, {
        recordSubmissionBoundary() {
          submittedAt = performance.now();
        },
      });
      await searchToolbarActions.waitForQuery(query, { timeout: 60000 });
      await waitForResult();
      expect(submittedAt, 'Search submission boundary must be recorded.').toBeGreaterThan(0);
      return record(key, performance.now() - submittedAt);
    };
    const searchUnrelatedArtist = () => searchAndMeasure(
      UNRELATED_SEARCH_ARTIST,
      'unrelatedSearchGalleryReadyMs',
      () => galleryActions.waitForSelectedArtistGallery(UNRELATED_SEARCH_ARTIST, {
        queryValue: UNRELATED_SEARCH_ARTIST,
        timeout: 60000,
      }),
    );
    const searchRemixes = () => searchAndMeasure(REMIXES_ALBUM, 'albumSearchVisibleMs', async () => {
      await galleryActions.waitForPositiveRenderedAlbumCardTrackCounts({
        artist: DDT_ARTIST,
        album: REMIXES_ALBUM,
        year: REMIXES_YEAR,
        trackCount: REMIXES_FILENAMES.length,
      }, { timeout: 60000 });
      await galleryActions.waitForAlbumHidden(REMIXES_SPLIT_ALBUM, { timeout: 60000 });
    });

    try {
      await stepLogger.step(`Open the ten-track ${REMIXES_ALBUM} album in the DDT gallery`, async () => {
        await galleryActions.goto('/');
        await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
        await galleryActions.goto(ARTIST_VIEW_URL);
        await galleryActions.waitForSelectedArtistGallery(DDT_ARTIST, { timeout: 60000 });
        await galleryActions.waitForPositiveRenderedAlbumCardTrackCounts({
          artist: DDT_ARTIST,
          album: REMIXES_ALBUM,
          year: REMIXES_YEAR,
          trackCount: REMIXES_FILENAMES.length,
        }, { timeout: 60000 });
        await expectRemixesPhysicalState(expect);
      });

      for (let cycle = 1; cycle <= REPEATED_CYCLES; cycle += 1) {
        await splitAndMerge(cycle);
      }

      await stepLogger.step('Search an unrelated artist, then search the album again', async () => {
        await searchUnrelatedArtist();
        await searchRemixes();
      });

      await splitAndMerge(REPEATED_CYCLES + 1);

      await stepLogger.step('Browse stays quick after the last merge', async () => {
        await searchUnrelatedArtist();
        await searchRemixes();
      });
    } finally {
      try {
        await restoreRemixesThroughApp(page);
      } finally {
        await managedAppLifecycle.stop();
        try {
          await restoreRemixesMedia(mediaSnapshot);
        } finally {
          await managedAppLifecycle.restart();
        }
      }
    }
    await expectRemixesPhysicalState(expect);

    const comparability = Object.fromEntries(['split', 'merge'].flatMap((kind) => {
      const ofKind = saves.filter((entry) => entry.kind === kind);
      return [
        [`${kind}Save`, expectComparableTimings(expect.soft, ofKind.map((entry) => entry.saveMs), `${kind} saves`)],
        [`${kind}CardsReady`, expectComparableTimings(
          expect.soft,
          ofKind.map((entry) => entry.cardsReadyMs),
          `${kind} save to visible cards`,
        )],
      ];
    }));
    const metrics = Object.fromEntries(BUDGET_KEYS.map((key) => [key, Math.max(...samples[key])]));
    for (const key of BUDGET_KEYS) {
      await editTagsSplitMergeLocalReport.recordTimingCheckpoint({
        key,
        label: `Slowest ${key}`,
        timingMs: metrics[key],
        details: { samples: samples[key] },
      });
      editTagsSplitMergeLocalReport.recordTerminalTimingOutcome(
        BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, metrics[key], BUDGETS[key], `Slowest ${key}`),
      );
    }
    editTagsSplitMergeLocalReport.setMetricsPayload({ ...metrics, saves, samples, comparability });
    editTagsSplitMergeLocalReport.recordContractCompletion();
  });
});
