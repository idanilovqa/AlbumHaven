import { performance } from 'node:perf_hooks';

import { expect, test } from '../support/performanceFixtures.js';
import { restoreDdtStudioRecordsFixture } from '../helpers/ddtStudioRecordsFixture.js';
import {
  authenticatedPageGet,
  authenticatedPagePost,
} from '../helpers/authenticatedPageRequest.js';
import {
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  readGeneratedMp3AlbumTags,
  readGeneratedMp3TagSnapshots,
} from '../helpers/physicalTagHelpers.js';
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
const TRACK_TITLE = 'Студийная запись 1';
const FIXTURE_YEAR = '1999';
const TYPO_ARTIST = 'Ovderhead';
const CORRECTED_ARTIST = 'Overhead';
const TYPO_ALBUM = 'Telepathic Minds';
const TYPO_TRACK_FILENAMES = Object.freeze([
  '05. Студийная запись 5.mp3',
  '06. Студийная запись 6.mp3',
  '07. Студийная запись 7.mp3',
  '08. Студийная запись 8.mp3',
  '12. Студийная запись 12.mp3',
]);
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

async function expectPhysicalStructuralRename() {
  const snapshots = await readGeneratedMp3TagSnapshots({
    artist: ARTIST,
    album: ORIGINAL_ALBUM,
  });
  for (const filename of TYPO_TRACK_FILENAMES) {
    const track = snapshots.find((candidate) => candidate.filename === filename);
    expect(track, `Expected physical fixture track ${filename}.`).toBeTruthy();
    expect(track.frames.TALB).toEqual([TYPO_ALBUM]);
    expect(track.frames.TPE1).toEqual([CORRECTED_ARTIST]);
    expect(track.frames.TPE2).toEqual([CORRECTED_ARTIST]);
  }
}

async function probeEditTagsRequestCapacity(page, album) {
  const albumKey = String(
    album?.request_key || album?.identity_key || album?.key || '',
  ).trim();
  const requests = [
    { name: 'status', url: '/status' },
    { name: 'search', url: `/view-data?surface=albums&q=${encodeURIComponent(TYPO_ARTIST)}` },
    { name: 'home', url: '/view-data?surface=albums' },
    { name: 'artist-tree', url: `/view-data?surface=albums&artist=${encodeURIComponent(TREE_ARTIST)}` },
    { name: 'album-details', url: `/album-details?album_key=${encodeURIComponent(albumKey)}` },
    { name: 'notifications', url: '/utilities/cover-lookup/tasks/counts' },
    {
      name: 'cover-lookup',
      url: '/utilities/cover-lookup/start',
      method: 'post',
      data: { album, manual_urls: [] },
    },
  ];
  const results = await Promise.all(requests.map(async ({ name, url, method = 'get', data }) => {
    const startedAt = performance.now();
    const response = method === 'post'
      ? await authenticatedPagePost(page, url, { data, timeout: 30000 })
      : await authenticatedPageGet(page, url, { timeout: 30000 });
    return {
      durationMs: performance.now() - startedAt,
      name,
      ok: response.ok(),
      status: response.status(),
    };
  }));
  for (const result of results) {
    expect(result.ok, `${result.name} returned HTTP ${result.status} during Edit Tags.`).toBe(true);
    expect(
      result.durationMs,
      `${result.name} took ${result.durationMs.toFixed(1)} ms during Edit Tags.`,
    ).toBeLessThanOrEqual(1200);
  }
  return results;
}

test.describe(`${CASE_ID} synthetic-large repeated Edit Tags recovery`, () => {
  test('repeated saves leave navigation responsive', async ({
    appBarActions,
    editTagsPostEditLocalReport,
    galleryActions,
    managedAppLifecycle,
    navigationPanelActions,
    page,
    searchToolbarActions,
    stepLogger,
    tagEditorActions,
    trackModalActions,
  }) => {
    requirePostgresRuntimeEnv('the repeated Edit Tags post-edit benchmark');

    const saveTimingsMs = [];
    const metrics = {};
    let treeArtist = '';
    let treeAlbum = '';
    let typoAlbumRequest = null;

    try {
      await stepLogger.step('Restore the private DDT media copy and open the source album', async () => {
        await managedAppLifecycle.stop();
        try {
          await restoreDdtStudioRecordsFixture();
        } finally {
          await managedAppLifecycle.restart();
        }
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

      await stepLogger.step('Create the isolated five-track typo-artist fixture', async () => {
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: 16 });
        await tagEditorActions.selectTracksByFilenames(TYPO_TRACK_FILENAMES);
        await tagEditorActions.setArtist(TYPO_ARTIST);
        await tagEditorActions.setAlbumArtist(TYPO_ARTIST);
        await tagEditorActions.setAlbumName(TYPO_ALBUM);
        await tagEditorActions.applyAndWaitForTerminalSavedResponse({ timeout: 60000 });
        await trackModalActions.close();
        await galleryActions.waitForSelectedArtistGallery(TYPO_ARTIST, { timeout: 60000 });
        await galleryActions.waitForAlbumVisibleUnderHeading(TYPO_ARTIST, TYPO_ALBUM, {
          timeout: 60000,
        });
        const typoView = await readRuntimeView(page);
        const typoAlbum = flattenAlbums(typoView.artist_groups)
          .find((album) => String(album?.name || '').trim() === TYPO_ALBUM);
        typoAlbumRequest = typoAlbum;
        const typoAlbumRequestKey = String(
          typoAlbum?.request_key || typoAlbum?.identity_key || typoAlbum?.key || '',
        ).trim();
        expect(typoAlbumRequestKey).not.toBe('');
      });

      await stepLogger.step('Correct the final typo artist and reconcile to its destination', async () => {
        await galleryActions.clickAlbumDetailsByAlbumName(TYPO_ALBUM);
        const typoSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
        expect(typoSummary.trackRows).toBe(TYPO_TRACK_FILENAMES.length);
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: TYPO_TRACK_FILENAMES.length });
        await tagEditorActions.selectTracksByFilenames(TYPO_TRACK_FILENAMES);
        await tagEditorActions.setArtist(CORRECTED_ARTIST);
        await tagEditorActions.setAlbumArtist(CORRECTED_ARTIST);
        const startedAt = performance.now();
        const result = await tagEditorActions.applyAndWaitForTerminalSavedResponse({
          timeout: 60000,
          async whilePostInFlight() {
            const probes = await probeEditTagsRequestCapacity(page, typoAlbumRequest);
            metrics.exactIncidentProbeMaxMs = Math.max(
              ...probes.map((probe) => probe.durationMs),
            );
            metrics.exactIncidentProbes = probes;
          },
        });
        const saveTimingMs = performance.now() - startedAt;
        saveTimingsMs.push(saveTimingMs);
        const visibleSuccessMessages = result.notificationSamples
          .filter((sample) => sample.visible && SAVED_MESSAGE.test(sample.text));
        expect(visibleSuccessMessages).toHaveLength(1);
        expect(result.notificationSamples.some((sample) => (
          sample.error || /Failed (?:to )?edit tags\./u.test(sample.text)
        ))).toBe(false);
        await expect(tagEditorActions.tagEditor.overlay).toBeHidden();
        await expect(tagEditorActions.tagEditor.confirmOverlay).toBeHidden();
        await expect(tagEditorActions.tagEditor.repairAlert).toBeHidden({ timeout: 60000 });
        await trackModalActions.close();

        await galleryActions.waitForSelectedArtistGallery(CORRECTED_ARTIST, { timeout: 60000 });
        await galleryActions.waitForAlbumVisibleUnderHeading(CORRECTED_ARTIST, TYPO_ALBUM, {
          timeout: 60000,
        });
        const destinationView = await readRuntimeView(page);
        expect(destinationView.selected_artist).toBe(CORRECTED_ARTIST);
        const sidebarArtists = await navigationPanelActions.readRuntimeSidebarArtistNames();
        expect(sidebarArtists).toContain(CORRECTED_ARTIST);
        expect(sidebarArtists).not.toContain(TYPO_ARTIST);
        await expectPhysicalStructuralRename();
        await editTagsPostEditLocalReport.recordTimingCheckpoint({
          key: 'edit-tags-typo-artist-save',
          label: 'Edit Tags typo-artist terminal save',
          timingMs: saveTimingMs,
          details: { destinationArtist: CORRECTED_ARTIST, saveTaskId: result.saveTaskId },
        });
        await editTagsPostEditLocalReport.recordTimingCheckpoint({
          key: 'edit-tags-typo-artist-concurrent-probe-max',
          label: 'Edit Tags typo-artist concurrent request maximum',
          timingMs: metrics.exactIncidentProbeMaxMs,
          details: { probes: metrics.exactIncidentProbes },
        });
      });

      await stepLogger.step('Return to the DDT source album for repeated-save coverage', async () => {
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
          await trackModalActions.close();
        });

        await stepLogger.step(`Verify navigation after Edit Tags transition ${index + 1}`, async () => {
          await searchToolbarActions.search(ARTIST);
          await searchToolbarActions.waitForQuery(ARTIST, { timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(ARTIST, {
            queryValue: ARTIST,
            timeout: 60000,
          });
          await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, destinationAlbum, {
            timeout: 60000,
          });

          await searchToolbarActions.clearSearch({ submitWithEnter: true });
          await searchToolbarActions.waitForQuery('', { timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(ARTIST, { timeout: 60000 });
          await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, destinationAlbum, {
            timeout: 60000,
          });

          await searchToolbarActions.search(destinationAlbum);
          await searchToolbarActions.waitForQuery(destinationAlbum, { timeout: 60000 });
          await galleryActions.waitForAlbumVisible(destinationAlbum, { timeout: 60000 });

          await searchToolbarActions.search(TRACK_TITLE);
          await searchToolbarActions.waitForQuery(TRACK_TITLE, { timeout: 60000 });
          await galleryActions.waitForAlbumVisible(destinationAlbum, { timeout: 60000 });
          await galleryActions.clickAlbumDetailsByAlbumName(destinationAlbum);
          await trackModalActions.waitForReady();
          const matchingRow = trackModalActions.trackModal.albumTrackTable.rows
            .filter({ hasText: TRACK_TITLE })
            .first();
          await expect(matchingRow).toBeVisible({ timeout: 60000 });
          await expect(matchingRow).toHaveAttribute('data-track-search-match', 'true', {
            timeout: 60000,
          });
          await trackModalActions.close();

          await appBarActions.openLibraryHome();
          await searchToolbarActions.waitForQuery('', { timeout: 60000 });
          await navigationPanelActions.waitForAllArtistsVisibility(true, { timeout: 60000 });
          await galleryActions.waitForGalleryReady({ timeout: 60000 });
          await expect.poll(
            async () => (
              await navigationPanelActions.readRuntimeSidebarArtistNames()
            ).includes(TREE_ARTIST),
            { timeout: 60000 },
          ).toBe(true);

          await searchToolbarActions.search(TREE_FILTER_QUERY);
          await searchToolbarActions.waitForQuery(TREE_FILTER_QUERY, { timeout: 60000 });
          await expect.poll(
            () => navigationPanelActions.readSidebarArtistNameCount(TREE_ARTIST),
            { timeout: 60000 },
          ).toBe(1);
          await navigationPanelActions.selectSidebarArtistByName(TREE_ARTIST);
          await navigationPanelActions.waitForSidebarSelection(TREE_ARTIST, { timeout: 60000 });
          await galleryActions.waitForSelectedArtistGallery(TREE_ARTIST, { timeout: 60000 });
          const navigationView = await readRuntimeView(page);
          const navigationAlbum = String(flattenAlbums(navigationView.artist_groups)[0]?.name || '').trim();
          expect(navigationAlbum, 'Artist Tree navigation must expose an album.').not.toBe('');
          await galleryActions.clickAlbumDetailsByAlbumName(navigationAlbum);
          const navigationSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
          expect(navigationSummary.trackRows).toBeGreaterThan(0);
          await trackModalActions.close();

          await galleryActions.goto(ARTIST_VIEW_URL);
          await galleryActions.waitForSelectedArtistGallery(ARTIST, { timeout: 60000 });
          await galleryActions.waitForAlbumVisibleUnderHeading(ARTIST, destinationAlbum, {
            timeout: 60000,
          });
          await galleryActions.clickAlbumDetailsByAlbumName(destinationAlbum);
          await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
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
          const responsePromise = page.waitForResponse((response) => {
            if (response.request().method() !== 'GET') return false;
            const url = new URL(response.url());
            return url.pathname === '/view-data'
              && String(url.searchParams.get('q') || '').trim() === ARTIST;
          });
          await searchToolbarActions.search(ARTIST, {
            recordSubmissionBoundary() {
              searchSubmittedAt = performance.now();
            },
          });
          const response = await responsePromise;
          metrics.searchResponseMs = performance.now() - searchSubmittedAt;
          expect(response.ok(), 'Post-edit artist search response must succeed.').toBe(true);
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
      await managedAppLifecycle.stop();
      try {
        await restoreDdtStudioRecordsFixture();
      } finally {
        await managedAppLifecycle.restart();
      }
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
        key: 'post-edit-search-response',
        label: 'Post-edit exact-artist search response',
        timingMs: metrics.searchResponseMs,
        details: { artist: ARTIST },
      });
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
