import { expect, test } from '../support/performanceFixtures.js';

import fixture from '../fixtures/idleMemoryBudget.json' with { type: 'json' };
import {
  formatMegabytes,
  observeProductionAppLiveness,
  sampleIdleMemory,
} from '../helpers/index.js';

test.setTimeout(240000);

test('FTC-OPS-019 production app stays responsive throughout a sustained status and view observation window', async ({
  galleryActions,
  page,
  stepLogger,
}) => {
  await stepLogger.step('Open the production app and wait for the gallery to settle', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
  });

  const evidence = await stepLogger.step(
    'Probe normal status and Postgres sidebar-view routes throughout the bounded liveness window',
    async () => observeProductionAppLiveness(page),
  );

  expect(evidence.samples).toHaveLength(5);
  expect(evidence.observationWindowMs).toBeGreaterThanOrEqual(2000);
});

test('FTC-GALLERY-STARTUP-005 idle gallery memory stays under the budget once startup settles', async ({
  galleryActions,
  idleMemoryReport,
  stepLogger,
  page,
  trackModalActions,
}) => {

  await stepLogger.step('Open All Artists and wait for the gallery to settle', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
  });

  await stepLogger.step('Scroll to the middle of the gallery and wait for visible covers', async () => {
    await galleryActions.scrollGalleryToMiddle();
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: fixture.detailModalOpenCount,
    });
  });

  const scrolledIdleSamples = await stepLogger.step('Sample idle memory from the scrolled gallery state', async () => {
    const samples = await sampleIdleMemory(page, {
      sampleCount: fixture.idleSampleCount,
      delayMs: fixture.idleSampleDelayMs,
    });
    idleMemoryReport.recordScrolledGallerySamples(samples);
    return samples;
  });

  const visibleIndexes = await stepLogger.step('Collect visible album detail targets from the current viewport', async () => (
    galleryActions.readVisibleAlbumDetailButtonIndexes()
  ));
  expect(visibleIndexes.length, 'Expected at least three visible albums after scrolling to the middle of All Artists.').toBeGreaterThanOrEqual(fixture.detailModalOpenCount);

  const detailRuns = [];
  await stepLogger.step('Cycle album-detail open and close flows while sampling idle-memory drift', async () => {
    for (const [runIndex, index] of visibleIndexes.slice(0, fixture.detailModalOpenCount).entries()) {
      await stepLogger.substep(`Open and close visible album button ${index} (cycle ${runIndex + 1})`, async () => {
        await galleryActions.clickAlbumDetailsAt(index);
        await trackModalActions.waitForReady();
        await trackModalActions.close();
        await galleryActions.waitForVisibleGalleryCoversLoaded({
          minimumCount: fixture.detailModalOpenCount,
        });
      });
      const samples = await stepLogger.substep(`Collect post-close idle samples for visible album button ${index} (cycle ${runIndex + 1})`, async () => (
        sampleIdleMemory(page, {
          sampleCount: fixture.idleSampleCount,
          delayMs: fixture.idleSampleDelayMs,
        })
      ));
      detailRuns.push({
        visibleAlbumButtonIndex: index,
        samples,
      });
    }
  });

  idleMemoryReport.recordDetailRuns(detailRuns);

  const {
    allSamples,
    peakBytes,
    driftBytes,
    sourceSet,
    expectedPeakBytes,
    expectedDriftBytes,
  } = await stepLogger.step('Summarize the captured memory samples against the configured budget', async () => (
    idleMemoryReport.summarizeBudget({
      fixture,
      scrolledIdleSamples,
      detailRuns,
    })
  ));

  await stepLogger.step('Assert the peak and drift memory budgets', async () => {
    expect(
      peakBytes,
      `Peak idle memory from ${sourceSet} should stay under ${fixture.maxIdleMemoryMb} MB. Samples: ${allSamples.map((sample) => `${sample.phase}:${formatMegabytes(sample.bytes)}`).join(', ')}`,
    ).toBeLessThanOrEqual(expectedPeakBytes);
    expect(
      driftBytes,
      `Idle memory drift should stay under ${fixture.maxIdleDriftMb} MB after startup settles. Samples: ${allSamples.map((sample) => `${sample.phase}:${formatMegabytes(sample.bytes)}`).join(', ')}`,
    ).toBeLessThanOrEqual(expectedDriftBytes);
  });
});
