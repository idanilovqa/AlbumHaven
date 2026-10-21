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
  queryPersistedAlbumIdentity,
} from '../helpers/postgresAlbumIdentityHelpers.js';
import { effectiveArtistGroups } from '../helpers/rendererReconciliationHelpers.js';
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
const TYPO_SAVED_MESSAGE = `Saved changes to ${TYPO_TRACK_FILENAMES.length} tracks in “${TYPO_ALBUM}”.`;
const MAX_RETAINED_HEAP_GROWTH_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_DOM_NODE_GROWTH = 1_500;
const BUDGETS = Object.freeze(Object.fromEntries([
  'tagEditorOpenMs',
  'searchGalleryReadyMs',
  'treeHighlightMs',
  'treeGalleryReadyMs',
  'albumDetailsShellMs',
  'albumDetailsOpenMs',
  'albumDetailsCoverMs',
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
    artist: TYPO_ARTIST,
    album: TYPO_ALBUM,
    allowedProfiles: ['synthetic-large-library'],
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
    const ok = response.ok();
    return {
      body: ok ? '' : await response.text(),
      durationMs: performance.now() - startedAt,
      name,
      ok,
      status: response.status(),
    };
  }));
  return results;
}

async function observeEditTagPosts(page, operation) {
  const posts = [];
  const observePost = (request) => {
    if (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/utilities/edit-tags'
    ) {
      posts.push({
        payload: request.postDataJSON(),
        url: request.url(),
      });
    }
  };
  page.on('request', observePost);
  try {
    return {
      posts,
      result: await operation(),
    };
  } finally {
    page.off('request', observePost);
  }
}

async function sampleRendererRetention(cdp, phase) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const [heap, dom] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'),
    cdp.send('Memory.getDOMCounters'),
  ]);
  return { phase, heap, dom };
}

test.describe(`${CASE_ID} synthetic-large repeated Edit Tags recovery`, () => {
  test('repeated saves leave navigation responsive', async ({
    appBarActions,
    coverLookupActions,
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
    const editOpenTimingsMs = [];
    const retentionSamples = [];
    const metrics = {};
    let cdp = null;
    let retentionBaseline = null;
    let retentionFinal = null;
    let treeArtist = '';
    let treeAlbum = '';
    let typoAlbumRequest = null;

    try {
      await stepLogger.step('Restore the isolated typo-artist fixture and open its album', async () => {
        await managedAppLifecycle.stop();
        try {
          await restoreDdtStudioRecordsFixture({ typoArtistAlbum: true });
        } finally {
          await managedAppLifecycle.restart();
        }
        await galleryActions.goto('/');
        await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
        await galleryActions.goto(
          `/?surface=albums&artist=${encodeURIComponent(TYPO_ARTIST)}`,
        );
        await galleryActions.waitForSelectedArtistGallery(TYPO_ARTIST, { timeout: 60000 });
        await galleryActions.waitForAlbumVisibleUnderHeading(TYPO_ARTIST, TYPO_ALBUM, {
          timeout: 60000,
        });
        await galleryActions.selectAlbumDetailsByIdentity({
          artist: TYPO_ARTIST,
          album: TYPO_ALBUM,
          year: FIXTURE_YEAR,
        });
        const typoSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
        expect(typoSummary.trackRows).toBe(TYPO_TRACK_FILENAMES.length);
        const typoView = await readRuntimeView(page);
        const typoAlbum = flattenAlbums(typoView.artist_groups)
          .find((album) => String(album?.name || '').trim() === TYPO_ALBUM);
        const typoAlbumRequestKey = String(
          typoAlbum?.request_key || typoAlbum?.identity_key || typoAlbum?.key || '',
        ).trim();
        expect(typoAlbumRequestKey).not.toBe('');
        const detailResponse = await authenticatedPageGet(
          page,
          `/album-details?album_key=${encodeURIComponent(typoAlbumRequestKey)}`,
        );
        expect(detailResponse.ok()).toBe(true);
        const detailPayload = await detailResponse.json();
        expect(detailPayload.ok).toBe(true);
        typoAlbumRequest = detailPayload.album;
        expect(typoAlbumRequest.tracks).toHaveLength(TYPO_TRACK_FILENAMES.length);
      });

      await stepLogger.step('Correct the final typo artist and reconcile to its destination', async () => {
        const typoSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
        expect(typoSummary.trackRows).toBe(TYPO_TRACK_FILENAMES.length);
        const editOpenStartedAt = performance.now();
        await trackModalActions.openTagEditor();
        await tagEditorActions.waitForOpen({ expectedTrackCount: TYPO_TRACK_FILENAMES.length });
        editOpenTimingsMs.push(performance.now() - editOpenStartedAt);
        await tagEditorActions.selectTracksByFilenames(TYPO_TRACK_FILENAMES);
        await tagEditorActions.setArtist(CORRECTED_ARTIST);
        await tagEditorActions.setAlbumArtist(CORRECTED_ARTIST);
        const startedAt = performance.now();
        let exactIncidentProbes = [];
        const exactIncident = await observeEditTagPosts(page, () => (
          tagEditorActions.applyAndWaitForTerminalSavedResponse({
          timeout: 60000,
          async whilePostInFlight() {
            const probes = await probeEditTagsRequestCapacity(page, typoAlbumRequest);
            exactIncidentProbes = probes;
            metrics.exactIncidentProbeMaxMs = Math.max(
              ...probes.map((probe) => probe.durationMs),
            );
            metrics.exactIncidentProbes = probes;
          },
          })
        ));
        expect(exactIncident.posts).toHaveLength(1);
        const result = exactIncident.result;
        const saveTimingMs = performance.now() - startedAt;
        saveTimingsMs.push(saveTimingMs);
        await editTagsPostEditLocalReport.recordTimingCheckpoint({
          key: 'edit-tags-typo-artist-concurrent-probe-diagnostic',
          label: 'Edit Tags concurrent request diagnostic',
          timingMs: metrics.exactIncidentProbeMaxMs,
          details: {
            phaseTimingsMs: result.payload.phase_timings_ms,
            poolLeaseTimingsMs: result.payload.pool_lease_timings_ms,
            poolLeaseCounts: result.payload.pool_lease_counts,
            posts: exactIncident.posts,
            probes: exactIncidentProbes,
          },
        });
        for (const probe of exactIncidentProbes) {
          expect(
            probe.ok,
            `${probe.name} returned HTTP ${probe.status}${probe.body ? `: ${probe.body}` : ''} during Edit Tags.`,
          ).toBe(true);
          expect(
            probe.durationMs,
            `${probe.name} took ${probe.durationMs.toFixed(1)} ms during Edit Tags.`,
          ).toBeLessThanOrEqual(1200);
        }
        const reconciledView = await readRuntimeView(page);
        const [sourceIdentity, destinationIdentity] = await Promise.all([
          queryPersistedAlbumIdentity({
            artist: TYPO_ARTIST,
            album: TYPO_ALBUM,
            year: FIXTURE_YEAR,
          }),
          queryPersistedAlbumIdentity({
            artist: CORRECTED_ARTIST,
            album: TYPO_ALBUM,
            year: FIXTURE_YEAR,
          }),
        ]);
        await editTagsPostEditLocalReport.recordTimingCheckpoint({
        key: 'edit-tags-typo-artist-destination-projection-diagnostic',
        label: 'Edit Tags destination projection diagnostic',
        timingMs: saveTimingMs,
        details: {
          browserArtist: new URL(page.url()).searchParams.get('artist'),
          terminalPayload: result.payload,
          sourceIdentity,
          destinationIdentity,
          destinationRuntime: {
            selectedArtist: reconciledView.selected_artist,
            artistGroups: (reconciledView.artist_groups || []).map((group) => ({
              artist: group.artist,
              albums: (group.albums || []).map((album) => ({
                id: album.album_id || album.id || null,
                key: album.identity_key || album.request_key || album.key || null,
                name: album.name,
                albumArtist: album.album_artist,
                trackCount: Array.isArray(album.tracks) ? album.tracks.length : null,
              })),
            })),
            orderedAlbumRefs: reconciledView.playback_context?.ordered_album_refs || [],
            playbackAlbums: (reconciledView.playback_context?.albums || []).map((album) => ({
              id: album.album_id || album.id || null,
              key: album.identity_key || album.request_key || album.key || null,
              name: album.name,
              albumArtist: album.album_artist,
            })),
          },
        },
      });
        expect({
          browserArtist: new URL(page.url()).searchParams.get('artist'),
          destinationAlbumKey: result.payload.destination_album_key,
          destinationArtist: result.payload.destination_artist,
          selectedArtist: reconciledView.selected_artist,
        }).toMatchObject({
          browserArtist: CORRECTED_ARTIST,
          destinationAlbumKey: expect.any(String),
          destinationArtist: CORRECTED_ARTIST,
          selectedArtist: CORRECTED_ARTIST,
        });
        const visibleSuccessMessages = new Set(
          result.notificationSamples
            .filter((sample) => sample.visible && sample.text === TYPO_SAVED_MESSAGE)
            .map((sample) => sample.text),
        );
        expect([...visibleSuccessMessages]).toHaveLength(1);
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
        cdp = await page.context().newCDPSession(page);
        retentionBaseline = await sampleRendererRetention(cdp, 'before-repeated-edits');
        retentionSamples.push(retentionBaseline);
      });

      for (const [index, destinationAlbum] of [
        TEMPORARY_ALBUM_A,
        TEMPORARY_ALBUM_B,
        ORIGINAL_ALBUM,
      ].entries()) {
        await stepLogger.step(`Save Edit Tags transition ${index + 1}`, async () => {
          const editOpenStartedAt = performance.now();
          await trackModalActions.openTagEditor();
          await tagEditorActions.waitForOpen();
          editOpenTimingsMs.push(performance.now() - editOpenStartedAt);
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
          const navigationAlbum = String(
            flattenAlbums(effectiveArtistGroups(navigationView))[0]?.name || '',
          ).trim();
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
        retentionSamples.push(await sampleRendererRetention(
          cdp,
          `after-edit-cycle-${index + 1}`,
        ));
      }

      const plateauStart = retentionSamples.at(-2);
      const plateauEnd = retentionSamples.at(-1);
      metrics.retainedPlateauHeapGrowthBytes = plateauEnd.heap.usedSize
        - plateauStart.heap.usedSize;
      metrics.retainedPlateauDomNodeGrowth = plateauEnd.dom.nodes - plateauStart.dom.nodes;
      expect(metrics.retainedPlateauHeapGrowthBytes).toBeLessThanOrEqual(
        MAX_RETAINED_HEAP_GROWTH_BYTES,
      );
      expect(metrics.retainedPlateauDomNodeGrowth).toBeLessThanOrEqual(
        MAX_RETAINED_DOM_NODE_GROWTH,
      );

      await stepLogger.step('Exercise Cover Lookup and notifications after repeated edits', async () => {
        await trackModalActions.prepareCoverLookup();
        const galleryResponsePromise = page.waitForResponse((response) => (
          response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/utilities/cover-lookup/gallery'
        ), { timeout: 60000 });
        await trackModalActions.activateCoverLookup();
        const galleryResponse = await galleryResponsePromise;
        expect(galleryResponse.ok(), 'Post-edit Cover Lookup gallery request must succeed.').toBe(true);
        await coverLookupActions.waitForModalReady({ timeout: 60000 });
        await coverLookupActions.waitForModalResultsReady({ timeout: 60000 });
        await coverLookupActions.closeModal();
        await trackModalActions.close();
        await coverLookupActions.openDrawer({ timeout: 60000 });
        await coverLookupActions.closeDrawer({ timeout: 60000 });
      });

      retentionFinal = await sampleRendererRetention(cdp, 'after-complete-long-session');
      retentionSamples.push(retentionFinal);
      metrics.retainedHeapGrowthBytes = retentionFinal.heap.usedSize
        - retentionBaseline.heap.usedSize;
      metrics.retainedDomNodeGrowth = retentionFinal.dom.nodes - retentionBaseline.dom.nodes;
      expect(metrics.retainedHeapGrowthBytes).toBeLessThanOrEqual(
        MAX_RETAINED_HEAP_GROWTH_BYTES,
      );
      expect(metrics.retainedDomNodeGrowth).toBeLessThanOrEqual(
        MAX_RETAINED_DOM_NODE_GROWTH,
      );
      metrics.tagEditorOpenMs = Math.max(...editOpenTimingsMs);

      await stepLogger.step('Confirm the restored gallery after the completed interaction cycle', async () => {
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
      const treeAlbums = flattenAlbums(effectiveArtistGroups(treeView));
      treeAlbum = String(treeAlbums[0]?.name || '').trim();
      expect(treeAlbum, 'Expected the selected Artist Tree gallery to expose an album.').not.toBe('');
      const albumDetailsStartedAt = performance.now();
      await galleryActions.clickAlbumDetailsByAlbumName(treeAlbum);
      await expect(trackModalActions.trackModal.dialog).toBeVisible({ timeout: 60000 });
      metrics.albumDetailsShellMs = performance.now() - albumDetailsStartedAt;
      const trackSummary = await trackModalActions.waitForLoadedSummary({ timeout: 60000 });
      metrics.albumDetailsOpenMs = performance.now() - albumDetailsStartedAt;
      expect(trackSummary.trackRows).toBeGreaterThan(0);
      await trackModalActions.waitForDetailedCoverImageCheckpoint({ timeout: 60000 });
      metrics.albumDetailsCoverMs = performance.now() - albumDetailsStartedAt;
      await trackModalActions.close();
    } finally {
      try {
        if (cdp) await cdp.detach();
      } finally {
        await managedAppLifecycle.stop();
        try {
          await restoreDdtStudioRecordsFixture();
        } finally {
          await managedAppLifecycle.restart();
        }
      }
    }

    for (const [key, label] of [
      ['tagEditorOpenMs', 'Slowest Edit Tags editor open'],
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
    await editTagsPostEditLocalReport.recordTimingCheckpoint({
      key: 'post-edit-album-details-shell',
      label: 'Post-edit Album Details shell visible',
      timingMs: metrics.albumDetailsShellMs,
      details: { album: treeAlbum, artist: treeArtist },
    });
    await editTagsPostEditLocalReport.recordTimingCheckpoint({
      key: 'post-edit-album-details-cover',
      label: 'Post-edit Album Details decoded cover visible',
      timingMs: metrics.albumDetailsCoverMs,
      details: { album: treeAlbum, artist: treeArtist },
    });
    for (const [key, label, timingMs] of [
      ['albumDetailsShellMs', 'Post-edit Album Details shell visible', metrics.albumDetailsShellMs],
      ['albumDetailsCoverMs', 'Post-edit Album Details decoded cover visible', metrics.albumDetailsCoverMs],
    ]) {
      editTagsPostEditLocalReport.recordTerminalTimingOutcome(
        BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, timingMs, BUDGETS[key], label),
      );
    }
    editTagsPostEditLocalReport.recordTextCheckpoint({
      key: 'post-edit-retained-renderer-state',
      label: 'Retained renderer state after repeated Edit Tags',
      valueText: `${metrics.retainedHeapGrowthBytes} bytes / ${metrics.retainedDomNodeGrowth} nodes`,
      details: {
        maximumHeapGrowthBytes: MAX_RETAINED_HEAP_GROWTH_BYTES,
        maximumDomNodeGrowth: MAX_RETAINED_DOM_NODE_GROWTH,
        baseline: retentionBaseline,
        final: retentionFinal,
        samples: retentionSamples,
      },
    });
    editTagsPostEditLocalReport.setMetricsPayload({
      ...metrics,
      editOpenTimingsMs,
      saveTimingsMs,
      retentionSamples,
      treeAlbum,
      treeArtist,
    });
    editTagsPostEditLocalReport.recordContractCompletion();
  });
});
