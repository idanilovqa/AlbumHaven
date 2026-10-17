import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/performanceFixtures.js';
import { restoreDdtStudioRecordsFixture } from '../helpers/ddtStudioRecordsFixture.js';
import {
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import { readGeneratedMp3AlbumTags } from '../helpers/physicalTagHelpers.js';
import {
  flattenAlbums,
  readRuntimeView,
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';

const CASE_ID = 'FTC-TAGS-026P';
const ARTIST = 'ДДТ';
const ORIGINAL_ALBUM = 'Студийные записи';
const TEMPORARY_ALBUM_A = 'Студийные записи — performance A';
const TEMPORARY_ALBUM_B = 'Студийные записи — performance B';
const TRACK_FILENAME = '01. Студийная запись 1.mp3';
const FIXTURE_YEAR = '1999';
const TREE_FILTER_QUERY = 'Ар';
const TREE_ARTIST = 'Ария';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(ARTIST)}`;
const SAVED_MESSAGE = /^Saved changes to \d+ tracks? in “.+”\.$/u;
const BUDGETS = Object.freeze(Object.fromEntries([
  'searchGalleryReadyMs',
  'treeHighlightMs',
  'treeGalleryReadyMs',
  'albumDetailsOpenMs',
].map((key) => [key, Object.freeze(
  performanceTimingBudget(`edit-tags-post-edit.${key}`),
)])));

async function expectPhysicalAlbum(expectedAlbum) {
  const physicalTags = await readGeneratedMp3AlbumTags({
    artist: ARTIST,
    album: ORIGINAL_ALBUM,
    allowedProfiles: ['synthetic-large-library'],
  });
  const editedTrack = physicalTags.find((track) => track.filename === TRACK_FILENAME);
  expect(editedTrack, `Expected physical fixture track ${TRACK_FILENAME}.`).toBeTruthy();
  expect(editedTrack.albumValues).toEqual([expectedAlbum]);
}

test.describe(`${CASE_ID} synthetic-large repeated Edit Tags recovery`, () => {
  test('repeated saves leave navigation responsive', async ({
    editTagsPostEditLocalReport,
    galleryActions,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
    tagEditorActions,
    trackModalActions,
  }) => {
    test.setTimeout(240000);
    requirePostgresRuntimeEnv('the repeated Edit Tags post-edit benchmark');

    const saveTimingsMs = [];
    const metrics = {};
    let treeArtist = '';
    let treeAlbum = '';

    try {
      await stepLogger.step('Restore the private DDT media copy and open the source album', async () => {
        await restoreDdtStudioRecordsFixture();
        await galleryActions.goto('/');
        await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
        await galleryActions.goto(ARTIST_VIEW_URL);
        await galleryActions.waitForSelectedArtistGallery(ARTIST, { timeout: 60000 });
        await galleryActions.selectAlbumDetailsByIdentity({
          artist: ARTIST,
          album: ORIGINAL_ALBUM,
          year: FIXTURE_YEAR,
        });
        await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
      });

      for (const [index, destinationAlbum] of [
        TEMPORARY_ALBUM_A,
        TEMPORARY_ALBUM_B,
        ORIGINAL_ALBUM,
      ].entries()) {
        await stepLogger.step(`Save Edit Tags transition ${index + 1}`, async () => {
          await trackModalActions.openTagEditor();
          await tagEditorActions.waitForOpen();
          await tagEditorActions.selectTrackByFilename(TRACK_FILENAME);
          await tagEditorActions.setAlbumName(destinationAlbum);
          const startedAt = performance.now();
          const result = await tagEditorActions.applyAndWaitForTerminalSavedResponse({
            timeout: 60000,
          });
          const saveTimingMs = performance.now() - startedAt;
          saveTimingsMs.push(saveTimingMs);
          const successMessages = new Set(
            result.notificationSamples
              .filter((sample) => sample.visible && SAVED_MESSAGE.test(sample.text))
              .map((sample) => sample.text),
          );
          expect([...successMessages]).toHaveLength(1);
          await expect(tagEditorActions.tagEditor.overlay).toBeHidden();
          await expect(tagEditorActions.tagEditor.confirmOverlay).toBeHidden();
          await expect(tagEditorActions.tagEditor.repairAlert).toBeHidden({ timeout: 60000 });
          await expectPhysicalAlbum(destinationAlbum);
          await editTagsPostEditLocalReport.recordTimingCheckpoint({
            key: `edit-tags-save-${index + 1}`,
            label: `Edit Tags terminal save ${index + 1}`,
            timingMs: saveTimingMs,
            details: { destinationAlbum, saveTaskId: result.saveTaskId },
          });
          if (destinationAlbum !== ORIGINAL_ALBUM) {
            await trackModalActions.close();
            await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, destinationAlbum, {
              timeout: 60000,
            });
            await galleryActions.clickAlbumDetailsByAlbumName(destinationAlbum);
            await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
          }
        });
      }

      await stepLogger.step('Close Album Details after the restored save', async () => {
        await trackModalActions.close();
        await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ORIGINAL_ALBUM, {
          timeout: 60000,
        });
      });

      let searchSubmittedAt = 0;
      metrics.searchGalleryReadyMs = await stepLogger.step(
        'Measure post-edit search to the restored visible album',
        async () => {
          await searchToolbarActions.search(ARTIST, {
            recordSubmissionBoundary() {
              searchSubmittedAt = performance.now();
            },
          });
          await searchToolbarActions.waitForQuery(ARTIST, { timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(ARTIST, {
            queryValue: ARTIST,
            timeout: 60000,
          });
          await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, ORIGINAL_ALBUM, {
            timeout: 60000,
          });
          return performance.now() - searchSubmittedAt;
        },
      );
      await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
      metrics.searchCoverReadyMs = performance.now() - searchSubmittedAt;

      await stepLogger.step('Filter the Artist Tree to a deterministic covered artist', async () => {
        await searchToolbarActions.search(TREE_FILTER_QUERY);
        await searchToolbarActions.waitForQuery(TREE_FILTER_QUERY, { timeout: 60000 });
        await expect.poll(
          () => navigationPanelActions.readSidebarArtistNameCount(TREE_ARTIST),
          { timeout: 60000 },
        ).toBe(1);
        treeArtist = TREE_ARTIST;
      });

      const refocusGuardBeforeTreeClick = await page.evaluate(() => {
        const now = Date.now();
        const suppressClickSequenceUntil = Number(state.ui?.suppressClickSequenceUntil || 0);
        return {
          pendingAppRefocusSuppression: Boolean(state.ui?.pendingAppRefocusSuppression),
          suppressNextViewportClick: Boolean(state.ui?.suppressNextViewportClick),
          suppressClickSequenceUntil,
          suppressionActive: Boolean(
            state.ui?.suppressNextViewportClick || now <= suppressClickSequenceUntil
          ),
        };
      });
      expect(
        refocusGuardBeforeTreeClick.suppressionActive,
        `Expected deliberate post-edit Artist Tree input to be unsuppressed: ${JSON.stringify(refocusGuardBeforeTreeClick)}`,
      ).toBe(false);

      const treeSelectedAt = performance.now();
      await navigationPanelActions.selectSidebarArtistByName(treeArtist);
      await navigationPanelActions.waitForSidebarSelection(treeArtist, { timeout: 60000 });
      metrics.treeHighlightMs = performance.now() - treeSelectedAt;
      await galleryActions.waitForSelectedArtistGallery(treeArtist, { timeout: 60000 });
      metrics.treeGalleryReadyMs = performance.now() - treeSelectedAt;
      await galleryActions.waitForVisibleGalleryCoversLoaded({ minimumCount: 1, timeout: 60000 });
      metrics.treeCoverReadyMs = performance.now() - treeSelectedAt;

      const treeView = await readRuntimeView(page);
      const treeAlbums = flattenAlbums(treeView?.artist_groups || []);
      treeAlbum = String(treeAlbums[0]?.name || '').trim();
      expect(treeAlbum, 'Expected the selected Artist Tree gallery to expose an album.').not.toBe('');
      const albumDetailsStartedAt = performance.now();
      await galleryActions.clickAlbumDetailsByAlbumName(treeAlbum);
      const trackSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
      metrics.albumDetailsOpenMs = performance.now() - albumDetailsStartedAt;
      expect(trackSummary.trackRows).toBeGreaterThan(0);
      await trackModalActions.close();
    } finally {
      await restoreDdtStudioRecordsFixture();
    }

    for (const [key, label] of [
      ['searchGalleryReadyMs', 'Post-edit exact-artist search gallery'],
      ['treeHighlightMs', 'Post-edit Artist Tree highlight'],
      ['treeGalleryReadyMs', 'Post-edit Artist Tree selected gallery'],
      ['albumDetailsOpenMs', 'Post-edit Album Details readiness'],
    ]) {
      await editTagsPostEditLocalReport.recordTimingCheckpoint({
        key,
        label,
        timingMs: metrics[key],
        details: { treeAlbum, treeArtist },
      });
      editTagsPostEditLocalReport.recordTerminalTimingOutcome(
        BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, metrics[key], BUDGETS[key], label),
      );
    }
    await editTagsPostEditLocalReport.recordTimingCheckpoint({
      key: 'post-edit-search-cover-ready',
      label: 'Post-edit search visible covers',
      timingMs: metrics.searchCoverReadyMs,
      details: { artist: ARTIST },
    });
    await editTagsPostEditLocalReport.recordTimingCheckpoint({
      key: 'post-edit-tree-cover-ready',
      label: 'Post-edit Artist Tree visible covers',
      timingMs: metrics.treeCoverReadyMs,
      details: { treeArtist },
    });
    editTagsPostEditLocalReport.setMetricsPayload({
      ...metrics,
      saveTimingsMs,
      treeAlbum,
      treeArtist,
    });
    editTagsPostEditLocalReport.recordContractCompletion();
  });
});
