import { expect } from '@playwright/test';

import {
  changedId3Frames,
  readGeneratedMp3TagSnapshots,
} from './physicalTagHelpers.js';

const FIXTURE_ARTIST = 'E2E Rarity Artist';
const ROOT_GALLERY_URL = '/?surface=albums';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(FIXTURE_ARTIST)}`;
const FIXTURE_TRACK_COUNT = 18;

function expectedPhysicalChanges(beforeSnapshots, selectedFilename, changedFrame) {
  return beforeSnapshots.map(({ filename }) => ({
    filename,
    changedFrames: filename === selectedFilename ? [changedFrame] : [],
  }));
}

async function assertAlbumTrackCounts({
  galleryActions,
  trackModalActions,
  identities,
}) {
  for (const identity of identities) {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      album: identity.album,
      year: identity.year,
    });
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toBe(
      `${FIXTURE_ARTIST} - ${identity.album} - ${identity.year}`,
    );
    expect(summary.trackRows).toBe(identity.trackCount);
    await trackModalActions.close();
  }
}

async function assertAlbumTopologyAndTrackCounts({
  galleryActions,
  trackModalActions,
  identities,
}) {
  const topology = await galleryActions.waitForAlbumIdentityTopology(
    FIXTURE_ARTIST,
    identities,
  );
  await assertAlbumTrackCounts({
    galleryActions,
    trackModalActions,
    identities,
  });
  return topology;
}

export async function runSparseTagEditScenario({
  appBarActions,
  field,
  freshBrowserSession,
  galleryActions,
  initialEditorFields,
  initialEditorValues,
  initialYear,
  originalAlbum,
  physicalFrame,
  physicalValue,
  resultIdentities,
  retainedPhysicalFrames = {},
  selectedFilename,
  setEditorValue,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
  updatedValue,
  verifyAfterIncrementalScan = false,
  verifyPendingPresentation = false,
}) {
  const originalIdentity = {
    album: originalAlbum,
    year: String(initialYear),
  };
  let beforeSnapshots = [];
  let scrollBeforeEdit = null;
  let visibleAlbumCountBeforeEdit = null;

  await stepLogger.step('Open the generated album and select one physical file', async () => {
    await galleryActions.goto(ROOT_GALLERY_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumIdentityTopology(
      FIXTURE_ARTIST,
      [originalIdentity],
      { waitAtBoundary: true },
    );
    const visibleObservationBeforeEdit = (
      await galleryActions.readCurrentProductionVisibleAlbumObservation(
        FIXTURE_ARTIST,
        [],
      )
    );
    visibleAlbumCountBeforeEdit = visibleObservationBeforeEdit.albumCount;
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: FIXTURE_ARTIST,
      ...originalIdentity,
    }, {
      waitAtBoundary: true,
    });
    expect((await trackModalActions.waitForInteractiveSummary()).trackRows).toBe(
      FIXTURE_TRACK_COUNT,
    );
    beforeSnapshots = await readGeneratedMp3TagSnapshots({
      artist: FIXTURE_ARTIST,
      album: originalAlbum,
    });
    expect(beforeSnapshots).toHaveLength(FIXTURE_TRACK_COUNT);
    const selectedBeforeSnapshot = beforeSnapshots.find(
      ({ filename }) => filename === selectedFilename,
    );
    for (const [frame, values] of Object.entries(retainedPhysicalFrames)) {
      expect(selectedBeforeSnapshot?.frames?.[frame]).toEqual(values);
    }

    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await tagEditorActions.selectTrackByFilename(selectedFilename);
    expect(await tagEditorActions.readEditableValues(initialEditorFields))
      .toEqual(initialEditorValues);
    if (verifyPendingPresentation) {
      await tagEditorActions.expectPendingChanges([]);
      await setEditorValue(tagEditorActions, updatedValue);
      await tagEditorActions.expectPendingChanges([selectedFilename]);
      await setEditorValue(tagEditorActions, initialEditorValues[field]);
      await tagEditorActions.expectPendingChanges([]);
    }
    await setEditorValue(tagEditorActions, updatedValue);
    if (verifyPendingPresentation) {
      await tagEditorActions.expectPendingChanges([selectedFilename]);
    }
    scrollBeforeEdit = await galleryActions.readGalleryScrollState();
    expect(scrollBeforeEdit.scrollTop).toBeGreaterThan(2);
  });

  let originalModalClosePromise = null;
  const ensureOriginalModalClosed = () => {
    if (!originalModalClosePromise) {
      originalModalClosePromise = trackModalActions.close();
    }
    return originalModalClosePromise;
  };
  const editResult = await stepLogger.step(
    'Apply the exact sparse update and retain the optimistic gallery after the response',
    async () => tagEditorActions.applyAndObserveOptimisticState({
      expectedField: field,
      expectedValue: updatedValue,
      expectedFilename: selectedFilename,
      readOptimisticState: async (stage) => {
        await ensureOriginalModalClosed();
        const topology = await galleryActions.readCurrentProductionVisibleAlbumObservation(
          FIXTURE_ARTIST,
          resultIdentities,
          {
            expectedAlbumCount:
              visibleAlbumCountBeforeEdit + resultIdentities.length - 1,
          },
        );
        const scrollDelta = Math.abs(topology.scroll.scrollTop - scrollBeforeEdit.scrollTop);
        const virtualGridDiagnostics = scrollDelta > 2
          ? await galleryActions.readVirtualGridDiagnostics()
          : null;
        expect(
          scrollDelta,
          `Virtual grid diagnostics: ${JSON.stringify(virtualGridDiagnostics)}`,
        ).toBeLessThanOrEqual(2);
        return { stage, ...topology };
      },
    }),
  );
  expect(Number.isFinite(editResult.clickToOptimisticMs)).toBe(true);
  expect(editResult.clickToOptimisticMs).toBeGreaterThanOrEqual(0);
  testArtifacts.queueJsonAttachment(
    `${field}-click-to-optimistic-diagnostic.json`,
    {
      field,
      clickToOptimisticMs: editResult.clickToOptimisticMs,
      contract: 'Diagnostic only; no retained threshold.',
    },
  );

  await stepLogger.step('Verify only the requested physical ID3 frame changed', async () => {
    const afterSnapshots = await readGeneratedMp3TagSnapshots({
      artist: FIXTURE_ARTIST,
      album: originalAlbum,
    });
    expect(changedId3Frames(beforeSnapshots, afterSnapshots)).toEqual(
      expectedPhysicalChanges(beforeSnapshots, selectedFilename, physicalFrame),
    );
    const selectedSnapshot = afterSnapshots.find(
      ({ filename }) => filename === selectedFilename,
    );
    expect(selectedSnapshot?.frames?.[physicalFrame]).toEqual([physicalValue]);
    for (const [frame, values] of Object.entries(retainedPhysicalFrames)) {
      expect(selectedSnapshot?.frames?.[frame]).toEqual(values);
    }
  });

  await stepLogger.step('Verify the current authoritative gallery state', async () => {
    const currentTopology = await assertAlbumTopologyAndTrackCounts({
      galleryActions,
      trackModalActions,
      identities: resultIdentities,
    });
    expect(Math.abs(currentTopology.scroll.scrollTop - scrollBeforeEdit.scrollTop))
      .toBeLessThanOrEqual(2);
  });

  if (verifyAfterIncrementalScan) {
    await stepLogger.step(
      'Run an incremental scan and retain the exact year-split topology',
      async () => {
        if (!appBarActions) {
          throw new Error(
            'Post-edit incremental-scan verification requires AppBarActions.',
          );
        }
        await appBarActions.triggerIncrementalScanAndWait();
        await assertAlbumTopologyAndTrackCounts({
          galleryActions,
          trackModalActions,
          identities: resultIdentities,
        });
      },
    );
  }

  await stepLogger.step('Verify the authoritative topology in a fresh browser', async () => {
    const freshSession = await freshBrowserSession.create();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    await assertAlbumTopologyAndTrackCounts({
      galleryActions: freshSession.galleryActions,
      trackModalActions: freshSession.trackModalActions,
      identities: resultIdentities,
    });
  });
}
