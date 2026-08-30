import { expect, test } from '../support/baseFixtures.js';
import { restoreDdtStudioRecordsFixture } from '../helpers/ddtStudioRecordsFixture.js';
import {
  readGeneratedMp3AlbumTags,
  readGeneratedMp3TagSnapshots,
} from '../helpers/physicalTagHelpers.js';
import {
  captureRendererCheckpoint,
  findLogicalAlbum,
  logicalAlbumNames,
  recordRendererViolation,
} from '../helpers/rendererReconciliationHelpers.js';

const ARTIST = 'ДДТ';
const PUBLICATION_ALBUM = 'Публикация';
const SOURCE_ALBUM = 'Студийные записи';
const YEAR = '1999';
const TOUCHED_TRACK_YEAR = '1990';
const TOUCHED_TRACK_NUMBERS = new Set([1, 2, 3, 4]);
const YEARLESS_TRACK_NUMBERS = new Set([9, 10, 11, 16]);
const PROBLEMATIC_TRACK_NUMBERS = new Set([
  ...TOUCHED_TRACK_NUMBERS,
  ...YEARLESS_TRACK_NUMBERS,
]);
const TRACKS = Array.from({ length: 16 }, (_, index) => ({
  number: index + 1,
  filename: `${String(index + 1).padStart(2, '0')}. Студийная запись ${index + 1}.mp3`,
  title: `Студийная запись ${index + 1}`,
}));
const SUFFIXES = [2, 3, 4, 5];
const albumDetailsTitle = (album) => `${ARTIST} - ${album} - ${YEAR}`;

test.beforeEach(async ({ managedAppLifecycle }) => {
  await restoreDdtStudioRecordsFixture();
  // Load the exact canonical fixture, including its intentionally mixed raw
  // track years, into the replacement application's runtime state.
  await managedAppLifecycle.restart();
});

test.afterEach(async ({ managedAppLifecycle }) => {
  await restoreDdtStudioRecordsFixture();
  // Keep the following spec on the same canonical runtime projection.
  await managedAppLifecycle.restart();
});

function expectedNames(initialNames, suffixes) {
  const suffixNames = suffixes.map((suffix) => `${SOURCE_ALBUM}${suffix}`);
  const withoutTargets = initialNames.filter(
    (name) => name !== SOURCE_ALBUM && !suffixNames.includes(name),
  );
  const publicationIndex = withoutTargets.indexOf(PUBLICATION_ALBUM);
  return [
    ...withoutTargets.slice(0, publicationIndex + 1),
    SOURCE_ALBUM,
    ...suffixNames,
    ...withoutTargets.slice(publicationIndex + 1),
  ];
}

test('FTC-TAGS-020 keeps the 60-album DDT gallery stable through Studio Records splits and restores', async ({
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
}, testInfo) => {
  test.setTimeout(420000);
  const violations = [];
  const observations = [];
  const checkpoints = [];
  const timingEvidence = [];
  const recoveryNavigations = [];
  const movedSuffixes = new Set();
  const acceptedEdits = [];
  let initialNames = [];

  const openAlbumDetails = async (album) => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: ARTIST,
      album,
      year: YEAR,
    });
    const detailsSummary = await trackModalActions.waitForInteractiveSummary();
    const detailsTitles = await trackModalActions.readTrackTitles();
    return { detailsSummary, detailsTitles };
  };

  const openAlbumEditor = async (album, expectedTrackCount = null) => {
    const { detailsSummary, detailsTitles } = await openAlbumDetails(album);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen(
      expectedTrackCount === null ? {} : { expectedTrackCount },
    );
    return {
      detailsSummary,
      detailsTitles,
      editorSummary: await tagEditorActions.readSummary(),
    };
  };

  const recoverCanonicalGallery = async (reason) => {
    recoveryNavigations.push({ reason, recordedAt: new Date().toISOString() });
    violations.push({
      message: `Test recovery navigation was required: ${reason}.`,
      evidence: { reason },
    });
    await trackModalActions.closeIfOpen();
    await galleryActions.goto('/');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ARTIST);
    await galleryActions.waitForSelectedArtistGallery(ARTIST, { queryValue: ARTIST });
    await page.screenshot({
      path: testInfo.outputPath(`recovery-${recoveryNavigations.length}.png`),
      fullPage: true,
    });
  };

  const settle = async (accepted) => {
    await accepted.waitForCompletion({ timeout: 90000 });
    acceptedEdits.splice(acceptedEdits.indexOf(accepted), 1);
  };

  const verifySplitProblemState = async (suffix) => {
    const suffixAlbum = `${SOURCE_ALBUM}${suffix}`;
    const movedTrack = TRACKS[suffix - 2];
    const remainingSourceTracks = TRACKS.slice(suffix - 1);

    await openAlbumDetails(suffixAlbum);
    await trackModalActions.expectProblemLinkVisibleForTrack(movedTrack.title);
    const movedTrackPath = await trackModalActions.readTrackPathByTitle(movedTrack.title);
    expect(movedTrackPath).not.toBe('');
    await trackModalActions.close();

    await openAlbumDetails(SOURCE_ALBUM);
    for (const track of remainingSourceTracks) {
      await trackModalActions.expectProblemLinkVisibleForTrack(track.title);
    }
    await trackModalActions.openProblematicFilesForTrack(
      remainingSourceTracks[0].title,
    );

    await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
    await utilityProblematicFilesActions.search(suffixAlbum);
    await utilityProblematicFilesActions.waitForSearchResults(suffixAlbum);
    const problematicSummary = await utilityProblematicFilesActions.selectAlbumByTitle(
      suffixAlbum,
    );
    expect(problematicSummary.title).toBe(suffixAlbum);
    const problematicRows = await utilityProblematicFilesActions.readDetectedTrackRows();
    const problematicTrack = problematicRows.find((row) => row.path === movedTrackPath);
    expect(problematicTrack).toEqual(expect.objectContaining({
      path: movedTrackPath,
    }));
    expect(problematicTrack.reasons.length).toBeGreaterThan(0);
    expect(problematicTrack.reasons).not.toContain('Missing year');

    await settingsModalAppBarActions.closeSettings();
    const returnedSummary = await trackModalActions.waitForInteractiveSummary();
    expect(returnedSummary.title).toBe(albumDetailsTitle(SOURCE_ALBUM));
    for (const track of remainingSourceTracks) {
      await trackModalActions.expectProblemLinkVisibleForTrack(track.title);
    }
    await trackModalActions.close();
  };

  const restoreSuffix = async (suffix, collectEvidence = true) => {
    await trackModalActions.closeIfOpen();
    const suffixAlbum = `${SOURCE_ALBUM}${suffix}`;
    const expectedSuffixFilename = TRACKS[suffix - 2].filename;
    let suffixOpen = null;
    let suffixOpenError = null;
    try {
      suffixOpen = await openAlbumEditor(suffixAlbum);
    } catch (error) {
      suffixOpenError = error;
    }
    recordRendererViolation(
      violations,
      JSON.stringify(suffixOpen?.editorSummary.trackFilenames)
        === JSON.stringify([expectedSuffixFilename]),
      `Restore ${suffix} destination must contain only ${expectedSuffixFilename}.`,
      suffixOpen?.editorSummary || suffixOpenError?.message || String(suffixOpenError),
    );
    const suffixOpenValid = (
      !suffixOpenError
      && suffixOpen?.detailsSummary.title === albumDetailsTitle(suffixAlbum)
      && JSON.stringify(suffixOpen?.editorSummary.trackFilenames)
        === JSON.stringify([expectedSuffixFilename])
    );
    if (!suffixOpenValid) {
      violations.push({
        message: `Restore ${suffix} opened stale suffix identity/membership before editing.`,
        evidence: suffixOpen || suffixOpenError?.message || String(suffixOpenError),
      });
      await page.screenshot({
        path: testInfo.outputPath(`restore-${suffix}-stale-suffix-open.png`),
        fullPage: true,
      });
      if (suffixOpen) await tagEditorActions.close();
      await trackModalActions.closeIfOpen();
      await recoverCanonicalGallery(`restore-${suffix}-stale-suffix-open`);
      suffixOpen = await openAlbumEditor(suffixAlbum, 1);
      expect(suffixOpen.detailsSummary.title).toBe(albumDetailsTitle(suffixAlbum));
      expect(suffixOpen.editorSummary.trackFilenames).toEqual([expectedSuffixFilename]);
    }
    const preEditScrollTop = (
      await galleryActions.readGalleryScrollState()
    ).scrollTop;
    await tagEditorActions.setAlbumName(SOURCE_ALBUM);
    const accepted = await tagEditorActions.applyAndReturnAcceptedEdit();
    timingEvidence.push({
      acceptedAt: accepted.acceptedAt,
      clickToAcceptedMs: accepted.clickToAcceptedMs,
      observedAt: new Date().toISOString(),
      transition: `restore-${suffix}`,
    });
    acceptedEdits.push(accepted);
    movedSuffixes.delete(suffix);
    await trackModalActions.closeIfOpen();
    let immediateSourceValid = true;
    if (collectEvidence) {
      const expectedTitles = TRACKS.slice(suffix - 2).map((track) => track.title);
      let summary = null;
      let titles = [];
      try {
        await galleryActions.galleryPage.albumCard.clickDetailsByIdentity(
          ARTIST,
          SOURCE_ALBUM,
          YEAR,
        );
        summary = await trackModalActions.waitForInteractiveSummary({ timeout: 3000 });
        titles = await trackModalActions.readTrackTitles();
      } catch (error) {
        violations.push({
          message: `Restore ${suffix} did not leave an immediately clickable source card.`,
          evidence: error?.message || String(error),
        });
      }
      recordRendererViolation(
        violations,
        summary?.title === albumDetailsTitle(SOURCE_ALBUM)
          && JSON.stringify(titles) === JSON.stringify(expectedTitles),
        `Restore ${suffix} must immediately expose ${expectedTitles.length} ordered source tracks.`,
        { summary, titles },
      );
      recordRendererViolation(
        violations,
        summary?.trackRows === expectedTitles.length,
        `Restore ${suffix} must immediately render ${expectedTitles.length} source track rows.`,
        summary,
      );
      immediateSourceValid = (
        summary?.title === albumDetailsTitle(SOURCE_ALBUM)
        && JSON.stringify(titles) === JSON.stringify(expectedTitles)
      );
      await page.screenshot({
        path: testInfo.outputPath(`restore-${suffix}-immediate-source.png`),
        fullPage: true,
      });
      await trackModalActions.closeIfOpen();
      const immediateGallery = await captureRendererCheckpoint({
        artist: ARTIST,
        galleryActions,
        page,
        screenshotPath: testInfo.outputPath(
          `ftc-tags-020-restore-${suffix}-immediate-gallery.png`,
        ),
      });
      checkpoints.push({
        phase: `restore-${suffix}-immediate-gallery`,
        ...immediateGallery,
      });
      const remainingSuffixes = SUFFIXES.filter(
        (candidate) => movedSuffixes.has(candidate),
      );
      const immediateNames = logicalAlbumNames(immediateGallery);
      const targetNames = expectedNames(initialNames, remainingSuffixes);
      recordRendererViolation(
        violations,
        initialNames.every((name) => immediateNames.includes(name))
          && immediateNames.length === initialNames.length + remainingSuffixes.length,
        `Restore ${suffix} immediate gallery must retain all 60 baseline albums and every still-split suffix.`,
        immediateNames,
      );
      recordRendererViolation(
        violations,
        JSON.stringify(immediateNames) === JSON.stringify(targetNames),
        `Restore ${suffix} immediate gallery logical order was not final.`,
        immediateNames,
      );
      recordRendererViolation(
        violations,
        immediateGallery.loaderHidden
          && immediateGallery.visualNonblank
          && immediateGallery.logicalReady,
        `Restore ${suffix} immediate gallery must stay populated without a loader.`,
        immediateGallery,
      );
      recordRendererViolation(
        violations,
        findLogicalAlbum(immediateGallery, SOURCE_ALBUM)?.trackCount === 18 - suffix,
        `Restore ${suffix} immediate gallery must show ${18 - suffix} source tracks.`,
        immediateGallery.logical,
      );
      recordRendererViolation(
        violations,
        findLogicalAlbum(immediateGallery, suffixAlbum) === null,
        `Restore ${suffix} immediate gallery must remove the restored suffix.`,
        immediateGallery.logical,
      );
      recordRendererViolation(
        violations,
        Math.abs(immediateGallery.scroll.scrollTop - preEditScrollTop) <= 2,
        `Restore ${suffix} immediate gallery must preserve scroll position.`,
        { inventory: immediateGallery.scroll, preEditScrollTop },
      );
    }
    await settle(accepted);
    if (!immediateSourceValid) {
      await recoverCanonicalGallery(`restore-${suffix}-stale-immediate-source`);
    }
    if (suffix === 3) {
      const restoredTrack = TRACKS[suffix - 2];
      await openAlbumDetails(SOURCE_ALBUM);
      await trackModalActions.expectProblemLinkVisibleForTrack(restoredTrack.title);
      await utilityProblematicFilesActions.startNavigationRenderObservation();
      const navigationStartedAt = Date.now();
      await trackModalActions.openProblematicFilesForTrack(restoredTrack.title);
      await utilityProblematicFilesActions.waitForReady({
        requirePopulated: true,
        timeout: 5000,
      });
      const mergedSummary = await utilityProblematicFilesActions.readSelectedDetailSummary();
      expect(mergedSummary.title).toBe(SOURCE_ALBUM);
      expect(Date.now() - navigationStartedAt).toBeLessThanOrEqual(5000);
      await utilityProblematicFilesActions.waitForActiveAlbumInSidebarViewport(
        SOURCE_ALBUM,
        { timeout: 5000 },
      );
      expect(await utilityProblematicFilesActions.readVisibleListItems()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ title: suffixAlbum })]),
      );
      const navigationRecords = (
        await utilityProblematicFilesActions.finishNavigationRenderObservation()
      );
      expect(navigationRecords.some((record) => (
        record.detailText.includes('Hold on. Your changes are being applied')
        || record.detailTitle === suffixAlbum
      ))).toBe(false);
      await settingsModalAppBarActions.closeSettings();
      expect((await trackModalActions.waitForInteractiveSummary()).title).toBe(
        albumDetailsTitle(SOURCE_ALBUM),
      );
      await trackModalActions.close();
    }
  };

  try {
    await stepLogger.step('Open the 16-track Studio Records fixture after Publication', async () => {
      await galleryActions.goto('/');
      await galleryActions.waitForGalleryReady();
      await searchToolbarActions.search(ARTIST, { submitWithEnter: true });
      await searchToolbarActions.waitForQuery(ARTIST);
      await galleryActions.waitForSelectedArtistGallery(ARTIST, { queryValue: ARTIST });
      await galleryActions.scrollGalleryBy(600);
      await page.waitForTimeout(1500);
      const baseline = await captureRendererCheckpoint({
        artist: ARTIST,
        galleryActions,
        page,
        screenshotPath: testInfo.outputPath('ftc-tags-020-studio-records-baseline.png'),
      });
      initialNames = logicalAlbumNames(baseline);
      checkpoints.push({ phase: 'baseline', ...baseline });
      expect(baseline.logical).toHaveLength(60);
      expect(
        baseline.logical.filter((album) => album.name === SOURCE_ALBUM),
      ).toHaveLength(1);
      for (const suffix of SUFFIXES) {
        expect(findLogicalAlbum(baseline, `${SOURCE_ALBUM}${suffix}`)).toBeNull();
      }
      expect(findLogicalAlbum(baseline, SOURCE_ALBUM)?.trackCount).toBe(16);
      expect(initialNames.indexOf(SOURCE_ALBUM)).toBe(initialNames.indexOf(PUBLICATION_ALBUM) + 1);
      await galleryActions.restoreGalleryScrollPosition(
        baseline.scroll.scrollTop + Math.round(baseline.scroll.clientHeight * 0.75),
      );
      const initialOpen = await openAlbumEditor(SOURCE_ALBUM, 16);
      expect(initialOpen.detailsSummary.title).toBe(albumDetailsTitle(SOURCE_ALBUM));
      expect(initialOpen.detailsSummary.trackRows).toBe(16);
      expect(initialOpen.detailsTitles).toEqual(TRACKS.map((track) => track.title));
    });

    for (const suffix of SUFFIXES) {
      await stepLogger.step(`Move the first remaining source track to suffix ${suffix}`, async () => {
        if (suffix !== SUFFIXES[0]) {
          await openAlbumEditor(SOURCE_ALBUM, 18 - suffix);
        }
        const editor = await tagEditorActions.readSummary();
        expect(editor.activeTrackCount).toBe(1);
        await tagEditorActions.setAlbumName(`${SOURCE_ALBUM}${suffix}`);
        const preEditScrollTop = (
          await galleryActions.readGalleryScrollState()
        ).scrollTop;
        const topology = await galleryActions.observeStableAlbumTopologyDuring({
          artist: ARTIST,
          identities: [
            { album: SOURCE_ALBUM, trackCount: `${17 - suffix} tracks`, year: YEAR },
            { album: `${SOURCE_ALBUM}${suffix}`, trackCount: '1 track', year: YEAR },
          ],
        }, async (checkpoint) => {
          let optimisticNavigationStartedAt = null;
          let optimisticNavigationRecordsStarted = false;
          const accepted = await tagEditorActions.applyAndReturnAcceptedEdit({
            onBeforeResponse: suffix === 5 ? async () => {
              const suffixAlbum = `${SOURCE_ALBUM}${suffix}`;
              const movedTrack = TRACKS[suffix - 2];
              await trackModalActions.closeIfOpen();
              await openAlbumDetails(suffixAlbum);
              await trackModalActions.expectProblemLinkVisibleForTrack(movedTrack.title);
              await utilityProblematicFilesActions.startNavigationRenderObservation();
              optimisticNavigationRecordsStarted = true;
              optimisticNavigationStartedAt = Date.now();
              await trackModalActions.openProblematicFilesForTrack(movedTrack.title);
              await utilityProblematicFilesActions.waitForAlbumInSidebarList(
                suffixAlbum,
                { timeout: 5000 },
              );
              await utilityProblematicFilesActions.waitForActiveAlbumInSidebarViewport(
                suffixAlbum,
                { timeout: 5000 },
              );
            } : undefined,
          });
          acceptedEdits.push(accepted);
          movedSuffixes.add(suffix);
          if (suffix === 5) {
            const suffixAlbum = `${SOURCE_ALBUM}${suffix}`;
            const movedTrack = TRACKS[suffix - 2];
            expect(optimisticNavigationRecordsStarted).toBe(true);
            await utilityProblematicFilesActions.waitForReady({
              requirePopulated: true,
              timeout: 5000,
            });
            const splitProblematicSummary = (
              await utilityProblematicFilesActions.readSelectedDetailSummary()
            );
            expect(splitProblematicSummary.title).toBe(suffixAlbum);
            expect(Date.now() - optimisticNavigationStartedAt).toBeLessThanOrEqual(5000);
            await utilityProblematicFilesActions.waitForAlbumInSidebarList(
              suffixAlbum,
              { timeout: 5000 },
            );
            await utilityProblematicFilesActions.waitForActiveAlbumInSidebarViewport(
              suffixAlbum,
              { timeout: 5000 },
            );
            const navigationRecords = (
              await utilityProblematicFilesActions.finishNavigationRenderObservation()
            );
            expect(navigationRecords.some((record) => (
              record.detailText.includes('Hold on. Your changes are being applied')
            ))).toBe(false);
            expect(
              navigationRecords
                .map((record) => record.detailTitle)
                .filter(Boolean)
                .every((title) => title === suffixAlbum),
            ).toBe(true);
            await settingsModalAppBarActions.closeSettings();
            expect((await trackModalActions.waitForInteractiveSummary()).title).toBe(
              albumDetailsTitle(suffixAlbum),
            );
            await trackModalActions.close();
            await galleryActions.restoreGalleryScrollPosition(preEditScrollTop);
            await openAlbumDetails(SOURCE_ALBUM);
          }
          const summary = await trackModalActions.waitForInteractiveSummary({ timeout: 3000 });
          const titles = await trackModalActions.readTrackTitles();
          recordRendererViolation(
            violations,
            summary.title === albumDetailsTitle(SOURCE_ALBUM)
              && JSON.stringify(titles)
                === JSON.stringify(TRACKS.slice(suffix - 1).map((track) => track.title)),
            `Split ${suffix} must keep the open modal on the remaining source tracks.`,
            { summary, titles },
          );
          recordRendererViolation(
            violations,
            summary.trackRows === 17 - suffix,
            `Split ${suffix} must immediately render ${17 - suffix} source track rows.`,
            summary,
          );
          if (suffix === 5) {
            await trackModalActions.waitForExactAlbumDetails({
              title: albumDetailsTitle(SOURCE_ALBUM),
              trackTitles: TRACKS.slice(4).map((track) => track.title),
              displayedTrackNumbers: Array.from(
                { length: 12 },
                (_, index) => index + 5,
              ),
            });
          }
          await page.screenshot({
            path: testInfo.outputPath(
              `ftc-tags-020-split-${suffix}-immediate-source-details.png`,
            ),
            fullPage: true,
          });
          await trackModalActions.closeIfOpen();
          const immediate = await captureRendererCheckpoint({
            artist: ARTIST,
            galleryActions,
            page,
            screenshotPath: testInfo.outputPath(`ftc-tags-020-split-${suffix}-immediate.png`),
          });
          const arm = await checkpoint('immediate', { arm: true, strict: false });
          if (arm.armFailure) {
            violations.push({
              message: `Split ${suffix} immediate mounted topology was not final.`,
              evidence: arm,
            });
          }
          await Promise.all([
            settle(accepted),
            page.waitForTimeout(15000),
          ]);
          const delayed = await captureRendererCheckpoint({
            artist: ARTIST,
            galleryActions,
            page,
            screenshotPath: testInfo.outputPath(`ftc-tags-020-split-${suffix}-settled.png`),
          });
          await checkpoint('settled');
          checkpoints.push(
            { phase: `split-${suffix}-immediate`, ...immediate },
            { phase: `split-${suffix}-delayed`, ...delayed },
          );
          timingEvidence.push({
            acceptedAt: accepted.acceptedAt,
            clickToAcceptedMs: accepted.clickToAcceptedMs,
            delayedAt: delayed.recordedAt,
            immediateAt: immediate.recordedAt,
            immediateToDelayedMs:
              Date.parse(delayed.recordedAt) - Date.parse(immediate.recordedAt),
            transition: `split-${suffix}`,
          });
          return { delayed, immediate };
        });
        observations.push({ transition: `split-${suffix}`, ...topology.observation });
        const targetNames = expectedNames(
          initialNames,
          SUFFIXES.filter((candidate) => candidate <= suffix),
        );
        recordRendererViolation(
          violations,
          JSON.stringify(logicalAlbumNames(topology.actionResult.immediate))
            === JSON.stringify(targetNames),
          `Split ${suffix} immediate logical order was not final.`,
          logicalAlbumNames(topology.actionResult.immediate),
        );
        for (const [timing, inventory] of [
          ['immediate', topology.actionResult.immediate],
          ['delayed', topology.actionResult.delayed],
        ]) {
          recordRendererViolation(
            violations,
            inventory.loaderHidden && inventory.visualNonblank,
            `Split ${suffix} ${timing} screenshot must keep a populated mounted gallery without a loader.`,
            inventory,
          );
          recordRendererViolation(
            violations,
            inventory.logicalReady,
            `Split ${suffix} ${timing} inventory must retain populated logical gallery state.`,
            inventory,
          );
          recordRendererViolation(
            violations,
            Math.abs(inventory.scroll.scrollTop - preEditScrollTop) <= 2,
            `Split ${suffix} ${timing} capture must preserve scroll position.`,
            { inventory: inventory.scroll, preEditScrollTop },
          );
        }
        if (suffix === 5) {
          recordRendererViolation(
            violations,
            findLogicalAlbum(topology.actionResult.immediate, SOURCE_ALBUM)?.trackCount === 12,
            'Split 5 must leave the source at 12 tracks immediately.',
            topology.actionResult.immediate.logical,
          );
        }
        recordRendererViolation(
          violations,
          JSON.stringify(logicalAlbumNames(topology.actionResult.delayed))
            === JSON.stringify(targetNames),
          `Split ${suffix} settled logical order changed.`,
          logicalAlbumNames(topology.actionResult.delayed),
        );
        recordRendererViolation(
          violations,
          topology.observation.violations.length === 0
            && topology.observation.samples.every((sample) => sample.galleryRootConnected),
          `Split ${suffix} remounted or displaced mounted cards after the immediate frame.`,
          topology.observation,
        );
        await verifySplitProblemState(suffix);
      });
    }

    for (const suffix of [...SUFFIXES].reverse()) {
      await stepLogger.step(`Restore suffix ${suffix} into Studio Records`, async () => {
        await restoreSuffix(suffix);
      });
    }

    await stepLogger.step('Verify the final same-session gallery after all restores', async () => {
      const finalGallery = await captureRendererCheckpoint({
        artist: ARTIST,
        galleryActions,
        page,
        screenshotPath: testInfo.outputPath(
          'ftc-tags-020-restores-final-same-session-gallery.png',
        ),
      });
      checkpoints.push({ phase: 'restores-final-same-session-gallery', ...finalGallery });
      recordRendererViolation(
        violations,
        JSON.stringify(logicalAlbumNames(finalGallery)) === JSON.stringify(initialNames),
        'Final same-session gallery must restore the exact 60-album baseline order.',
        logicalAlbumNames(finalGallery),
      );
      recordRendererViolation(
        violations,
        findLogicalAlbum(finalGallery, SOURCE_ALBUM)?.trackCount === 16,
        'Final same-session gallery must show 16 source tracks.',
        finalGallery.logical,
      );
      recordRendererViolation(
        violations,
        SUFFIXES.every(
          (suffix) => findLogicalAlbum(finalGallery, `${SOURCE_ALBUM}${suffix}`) === null,
        ),
        'Final same-session gallery must not retain any restored suffix album.',
        finalGallery.logical,
      );
      recordRendererViolation(
        violations,
        finalGallery.loaderHidden
          && finalGallery.visualNonblank
          && finalGallery.logicalReady,
        'Final same-session gallery must stay populated without a loader.',
        finalGallery,
      );
    });

    await stepLogger.step('Verify physical tags and a fresh-browser 16-track source', async () => {
      const physicalTags = await readGeneratedMp3AlbumTags({
        artist: ARTIST,
        album: SOURCE_ALBUM,
      });
      expect(physicalTags).toHaveLength(16);
      for (const track of physicalTags) expect(track.albumValues).toEqual([SOURCE_ALBUM]);
      const physicalSnapshots = await readGeneratedMp3TagSnapshots({
        artist: ARTIST,
        album: SOURCE_ALBUM,
      });
      expect(physicalSnapshots).toHaveLength(16);
      for (const [index, snapshot] of physicalSnapshots.entries()) {
        const trackNumber = index + 1;
        if (YEARLESS_TRACK_NUMBERS.has(trackNumber)) {
          expect(snapshot.frames.TDRC).toBeUndefined();
        } else if (trackNumber <= 4) {
          expect(snapshot.frames.TDRC).toEqual([TOUCHED_TRACK_YEAR]);
        } else {
          expect(snapshot.frames.TDRC).toEqual([YEAR]);
        }
      }
      const fresh = await freshBrowserSession.create();
      await fresh.galleryActions.goto('/');
      await fresh.galleryActions.waitForGalleryReady();
      await fresh.searchToolbarActions.search(ARTIST, { submitWithEnter: true });
      await fresh.searchToolbarActions.waitForQuery(ARTIST);
      await fresh.galleryActions.waitForSelectedArtistGallery(ARTIST, { queryValue: ARTIST });
      for (const suffix of SUFFIXES) {
        await fresh.galleryActions.waitForAlbumHidden(`${SOURCE_ALBUM}${suffix}`);
      }
      await fresh.galleryActions.selectAlbumDetailsByIdentity({
        artist: ARTIST,
        album: SOURCE_ALBUM,
        year: YEAR,
      });
      await fresh.trackModalActions.waitForExactAlbumDetails({
        title: albumDetailsTitle(SOURCE_ALBUM),
        trackTitles: TRACKS.map((track) => track.title),
      });
      for (const track of TRACKS) {
        if (PROBLEMATIC_TRACK_NUMBERS.has(track.number)) {
          await fresh.trackModalActions.expectProblemLinkVisibleForTrack(track.title);
        } else {
          await fresh.trackModalActions.expectProblemLinkAbsentForTrack(track.title);
        }
      }
    });
  } finally {
    for (const suffix of [...movedSuffixes].sort((left, right) => right - left)) {
      try {
        await restoreSuffix(suffix, false);
      } catch (error) {
        violations.push({
          message: `Isolated fixture cleanup failed for suffix ${suffix}.`,
          evidence: error?.stack || error?.message || String(error),
        });
      }
    }
    for (const accepted of acceptedEdits) {
      try {
        await accepted.waitForCompletion({ timeout: 90000 });
      } catch (error) {
        violations.push({
          message: 'An isolated fixture save task did not complete during cleanup.',
          evidence: error?.message || String(error),
        });
      }
    }
    testArtifacts.queueJsonAttachment('ftc-tags-020-studio-records-observations', observations);
    testArtifacts.queueJsonAttachment('ftc-tags-020-studio-records-checkpoints', checkpoints);
    testArtifacts.queueJsonAttachment('ftc-tags-020-studio-records-timing-evidence', timingEvidence);
    testArtifacts.queueJsonAttachment(
      'ftc-tags-020-studio-records-recovery-navigations',
      recoveryNavigations,
    );
    testArtifacts.queueJsonAttachment('ftc-tags-020-studio-records-violations', violations);
  }

  expect(violations).toEqual([]);
});
