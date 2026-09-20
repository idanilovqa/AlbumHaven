import { existsSync, globSync, renameSync } from 'node:fs';
import path from 'node:path';
import { InteractionSurfaces, expectCombinedLoopWaveform, expectLoopPauseFirstClick, expectStableButtonHover } from '../poms/interactionSurfaces.js';
import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-UTIL-LOOPS-021 / FTC-UTIL-LOOPS-023 / FTC-UTIL-LOOPS-024 / FTC-UTIL-LOOPS-026 / FTC-PLAYER-017 / FTC-PLAYER-011';
const LOOP_ALBUM_TARGET = {
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  year: '2026',
};
const LOOP_TRACK_TITLE = 'Fake Loop Source';
const LOOP_PLAYER_TITLE = 'Album Haven Last.fm Fixture - Fake Loop Source /';
const MEDIA_DURATION_TOLERANCE_SECONDS = 0.15;
const HANDLE_POSITION_TOLERANCE_SECONDS = 0.25;

function resolveOwnedLoopFixtureMedia(loopId) {
  const tempRoot = String(process.env.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
  if (!tempRoot) throw new Error('The isolated loop E2E requires ALBUM_HAVEN_E2E_TEMP_ROOT.');
  const loopRoot = path.resolve(tempRoot, 'app-data', 'loops');
  const pattern = path.join(loopRoot, 'account-*', 'library-*', `${loopId}.mp3`).replaceAll('\\', '/');
  const matches = globSync(pattern).map(candidate => path.resolve(candidate));
  if (matches.length !== 1 || path.relative(loopRoot, matches[0]).startsWith('..')) {
    throw new Error(`Expected one fixture-owned saved-loop artifact for ${loopId}, found ${matches.length}.`);
  }
  return matches[0];
}

test('FTC-UTIL-LOOPS-028 five paused saved loops render waveforms after a cold reload', { tag: '@area:loops' }, async ({
  page, galleryActions, globalPlayerActions, playbackEvidence, settingsModalAppBarActions,
  trackModalActions, utilityAppearanceActions, utilityLoopsActions, utilityTabBarActions,
}) => {
  const names = Array.from({ length: 5 }, (_, index) => `Waveform ${Date.now()} ${test.info().workerIndex} ${index + 1}`);
  const created = [];
  let repairMediaPath = '';
  let repairBackupPath = '';
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.saveSeekbarMode('waveform');
  await settingsModalAppBarActions.closeSettings();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const playbackMark = await playbackEvidence.playbackMark();
  const track = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: LOOP_TRACK_TITLE, visibleTitle: LOOP_PLAYER_TITLE });
  await globalPlayerActions.waitForFullTrackTiming();
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: playbackMark, path: track.path });
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  await globalPlayerActions.pauseIfPlaying();
  await trackModalActions.close();
  try {
    for (const name of names) {
      await globalPlayerActions.openLoopEditor();
      expect((await globalPlayerActions.saveLoopWithName(name)).requestCount).toBe(1);
      created.push(name);
    }
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    for (const name of [...names].reverse()) {
      const { entry, loopId } = await utilityLoopsActions.resolveLoopEntryByName(name);
      await utilityLoopsActions.expectPausedLoopWaveformPainted(entry, loopId);
    }
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    const waveformLoadFrames = utilityLoopsActions.observeGroupWaveformLoad(LOOP_TRACK_TITLE, names);
    const entries = await Promise.all(names.map(name => utilityLoopsActions.resolveLoopEntryByName(name)));
    expect(new Set(entries.map(item => item.loopId)).size).toBe(5);
    for (const { entry, loopId } of entries) {
      await utilityLoopsActions.expectPausedLoopWaveformPainted(entry, loopId);
    }
    const observedFrames = await waveformLoadFrames;
    expect(observedFrames.length).toBeGreaterThan(0);
    expect(observedFrames.flat().every(frame => (
      frame.waveformMode && frame.waveformVisible && !frame.regularVisible
    )), 'saved-loop rows must never expose the regular seekbar while waveform peaks load').toBe(true);

    const first = entries[0];
    const firstEntry = first.entry;
    const firstTimeline = utilityLoopsActions.utilityLoopsTab.loopEntryCard.ordinaryTimelineForEntry(firstEntry);
    const firstWrap = utilityLoopsActions.utilityLoopsTab.loopEntryCard.timelineWrapForEntry(firstEntry);
    await utilityLoopsActions.utilityLoopsTab.loopEntryCard.playButtonForEntry(firstEntry).click();
    await utilityLoopsActions.waitForLoopPlayback(first.loopId);
    const firstStarted = await utilityLoopsActions.readLoopPlaybackSnapshot(first.loopId);
    await utilityLoopsActions.waitForLoopProgress(first.loopId, {
      afterCurrentTime: firstStarted.currentTime,
      allowWrap: false,
    });
    await expect(firstWrap).toHaveCSS('outline-style', 'none');
    const timelineBounds = await firstTimeline.boundingBox();
    if (!timelineBounds) throw new Error('Expected saved-loop timeline bounds.');
    await firstTimeline.click({ position: { x: timelineBounds.width * 0.6, y: timelineBounds.height / 2 } });
    await expect(firstWrap).toHaveCSS('outline-style', 'none');
    const brightness = await utilityLoopsActions.utilityLoopsTab.loopEntryCard
      .readWaveformBrightnessBalance(firstEntry);
    expect(brightness.progressRatio).toBeGreaterThan(0.5);
    expect(brightness.played.paintedPixels).toBeGreaterThan(0);
    expect(brightness.unplayed.paintedPixels).toBeGreaterThan(0);
    expect(
      brightness.played.strongAlpha - brightness.unplayed.strongAlpha,
      'played saved-loop waveform pixels must remain visibly brighter than unplayed pixels',
    ).toBeGreaterThan(50);

    const second = entries[1];
    await utilityLoopsActions.startLoopAndExpectExclusive(first.loopId, second);

    await utilityLoopsActions.utilityLoopsTab.loopEntryCard.playButtonForEntry(second.entry).click();
    await utilityLoopsActions.waitForLoopPlaybackState(second.loopId, { paused: true });
    const repairTarget = entries[2];
    repairMediaPath = resolveOwnedLoopFixtureMedia(repairTarget.loopId);
    repairBackupPath = `${repairMediaPath}.e2e-repair`;
    renameSync(repairMediaPath, repairBackupPath);

    await page.reload();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const missing = await utilityLoopsActions.resolveLoopEntryByName(names[2]);
    const missingCard = utilityLoopsActions.utilityLoopsTab.loopEntryCard;
    await expect(missingCard.ordinaryWaveformForEntry(missing.entry)).toBeHidden();
    await expect(missingCard.ordinaryTimelineForEntry(missing.entry)).toBeVisible();
    await missingCard.playButtonForEntry(missing.entry).click();
    await expect(missingCard.errorToastByText(
      'Unable to start loop playback. Please try again.',
    )).toBeVisible();
    await utilityLoopsActions.hoverLoopActionByName(names[2], 'enter');
    await missingCard.loopScissorsButtonForEntry(missing.entry).click();
    await expect(missingCard.errorToastByText(
      'Failed to load saved loop waveform.',
    )).toBeVisible();

    renameSync(repairBackupPath, repairMediaPath);
    repairBackupPath = '';
    await page.reload();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const repaired = await utilityLoopsActions.resolveLoopEntryByName(names[2]);
    await utilityLoopsActions.expectPausedLoopWaveformPainted(repaired.entry, repaired.loopId);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName(names[2]);
    await utilityLoopsActions.cancelCreateAnotherLoopByName(names[2]);
    await missingCard.playButtonForEntry(repaired.entry).click();
    await utilityLoopsActions.waitForLoopPlayback(repaired.loopId);
    const decoded = await utilityLoopsActions.readDecodedLoopSampleEvidence(repaired.loopId);
    expect(decoded.nonZeroSamples).toBeGreaterThan(0);
  } finally {
    if (repairBackupPath && existsSync(repairBackupPath) && repairMediaPath) {
      renameSync(repairBackupPath, repairMediaPath);
    }
    if (!await settingsModalAppBarActions.settingsModalAppBar.modal.isVisible()) {
      await settingsModalAppBarActions.openSettings();
    }
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    if (created.length) await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    for (const name of created) {
      await utilityLoopsActions.openDeleteConfirmationByName(name);
      expect((await utilityLoopsActions.confirmDeleteByName(name)).requestCount).toBe(1);
    }
  }
});

test('FTC-SETTINGS-H03 real log download matches the displayed captured snapshot', { tag: '@area:log-history' }, async ({
  galleryActions, globalPlayerActions, page, settingsModalAppBarActions,
  trackModalActions, utilityLogHistoryActions, utilityLoopsActions, utilityTabBarActions,
}, testInfo) => {
  const name = `Export snapshot ${testInfo.workerIndex}-${Date.now()}`;
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const track = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: LOOP_TRACK_TITLE, visibleTitle: LOOP_PLAYER_TITLE });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(name)).requestCount).toBe(1);
  await settingsModalAppBarActions.openSettings();
  const [response] = await Promise.all([
    page.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === '/utilities/log-history'),
    utilityTabBarActions.openTab('log-history'),
  ]);
  expect(response.status()).toBe(200);
  const captured = await response.json();
  expect(captured.items.length).toBeGreaterThan(0);
  expect(captured.next_cursor).toBeFalsy();
  await expect(utilityLogHistoryActions.utilityLogHistoryTab.consoleLines).toHaveCount(captured.items.length);
  const downloaded = await utilityLogHistoryActions.exportLogs();
  expect(downloaded.suggestedFilename).toMatch(/^album-haven-logs-.*\.json$/);
  expect(downloaded.document.snapshot).toBe(captured.snapshot);
  expect(downloaded.document.items).toEqual(captured.items);
  expect(downloaded.document.count).toBe(captured.items.length);
  const history = utilityLogHistoryActions.utilityLogHistoryTab;
  await history.exportAllButton.click();
  await history.exportCustomButton.click();
  for (const [field, input] of [['from', history.exportFrom], ['to', history.exportTo]]) {
    await expect(input).toHaveAttribute('readonly', '');
    await expect(input).toHaveAttribute('placeholder', 'mm/dd/yyyy');
    await input.click();
    await expect(input).toBeFocused();
    expect(await history.readDateFocusOutline(input)).toEqual({ painted: true, unclipped: true, horizontalOverflow: false });
    await history.exportDateButton(field).hover();
    await page.mouse.down();
    try {
      await expect.poll(async () => (await history.readDateFocusOutline(input)).painted).toBe(false);
    } finally {
      await page.mouse.up();
    }
    const calendar = history.exportCalendar(field);
    await expect(calendar).toBeVisible();
    await utilityLogHistoryActions.selectCurrentExportDate(field);
  }
  await expect(history.exportTo).toHaveValue(await history.exportFrom.inputValue());
  await history.exportCancel.click();
  await expect(history.exportDialog).toBeHidden();
  await history.periodButton.click();
  // The shared calendar opens with today's start/end; presets belong to Export all logs.
  await expect(history.periodFrom).toHaveValue(/^\d{4}-\d{2}-\d{2}$/u);
  await expect(history.periodTo).toHaveValue(await history.periodFrom.inputValue());
  const [periodResponse] = await Promise.all([
    page.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === '/utilities/log-history'),
    history.periodDialog.getByRole('button', { name: 'Apply', exact: true }).click(),
  ]);
  const periodCapture = await periodResponse.json();
  await expect(history.periodRow).toHaveCount(1);
  await utilityLogHistoryActions.selectEntryByAction('Loop created');
  await expect(history.periodRow).toHaveCount(1);
  await history.periodRow.click();
  const periodExport = await utilityLogHistoryActions.exportLogs();
  expect(periodExport.document.snapshot).toBe(periodCapture.snapshot);
  expect(periodExport.document.items).toEqual(periodCapture.items);
  await history.clearPeriodButton.click();
  await expect(history.periodRow).toHaveCount(0);
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  await utilityLoopsActions.openDeleteConfirmationByName(name);
  expect((await utilityLoopsActions.confirmDeleteByName(name)).requestCount).toBe(1);
});

test.describe(() => {
  test.use({ timezoneId: 'America/Santiago' });

  test('FTC-SETTINGS-H04 Period includes complete local dates across skipped midnight', { tag: '@area:log-history' }, async ({
    galleryActions, page, settingsModalAppBarActions, utilityLogHistoryActions, utilityTabBarActions,
  }) => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('log-history');
    await utilityLogHistoryActions.waitForReady();
    const history = utilityLogHistoryActions.utilityLogHistoryTab;
    for (const [date, start, end] of [
      ['2026-09-05', '2026-09-05T04:00:00.000Z', '2026-09-06T04:00:00.000Z'],
      ['2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z'],
    ]) {
      await history.periodButton.click();
      await utilityLogHistoryActions.selectPeriodDay(date);
      const [response] = await Promise.all([
        page.waitForResponse(value => value.request().method() === 'GET'
          && new URL(value.url()).pathname === '/utilities/log-history'
          && new URL(value.url()).searchParams.get('from_utc') === start),
        history.periodDialog.getByRole('button', { name: 'Apply', exact: true }).click(),
      ]);
      expect(response.status()).toBe(200);
      const params = new URL(response.url()).searchParams;
      expect(params.get('from_utc')).toBe(start);
      expect(params.get('to_utc')).toBe(end);
      const captured = await response.json();
      expect(captured.snapshot).toBeTruthy();
      await expect(history.periodDialog).toBeHidden();
      await expect(history.periodRow).toHaveCount(1);
      await expect(history.periodRow).toContainText('America/Santiago');
      await expect(history.console).toBeVisible();
      await expect(history.consoleLines).toHaveCount(captured.items.length);
      await history.clearPeriodButton.click();
      await expect(history.periodRow).toHaveCount(0);
    }
  });
});

test('FTC-SETTINGS-L02 native panel drag persists order while another loop retains playback and its pending range', { tag: '@area:loops' }, async ({
  galleryActions, globalPlayerActions, page, settingsModalAppBarActions,
  trackModalActions, utilityLoopsActions, utilityTabBarActions,
}, testInfo) => {
  const names = ['Playing', 'Move', 'Target'].map(label => `${label} native reorder ${testInfo.workerIndex}-${Date.now()}`);
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const track = await trackModalActions.playTrackAt(0);
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: LOOP_TRACK_TITLE, visibleTitle: LOOP_PLAYER_TITLE });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  for (const name of names) {
    await globalPlayerActions.openLoopEditor();
    expect((await globalPlayerActions.saveLoopWithName(name)).requestCount).toBe(1);
  }
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  const card = utilityLoopsActions.utilityLoopsTab.loopEntryCard;
  const before = await card.readPanelOrder();
  const playingId = await utilityLoopsActions.playLoopByName(names[0]);
  await utilityLoopsActions.enableRepeatByName(names[0]);
  await utilityLoopsActions.revealCreateAnotherLoopEditorByName(names[0]);
  await utilityLoopsActions.adjustLoopBoundaryWithKeyboard(names[0], 'start', 'ArrowRight');
  await utilityLoopsActions.adjustLoopBoundaryWithKeyboard(names[0], 'end', 'ArrowLeft');
  const rangeBefore = await utilityLoopsActions.readLoopEditorStateByName(names[0]);
  expect(rangeBefore.startSeconds).toBeGreaterThan(0);
  const audio = await utilityLoopsActions.captureLoopAudioHandle(playingId);
  const moveEntry = await utilityLoopsActions.resolveLoopEntryByName(names[1]);
  const targetEntry = await utilityLoopsActions.resolveLoopEntryByName(names[2]);
  const moveIsEarlier = before.indexOf(moveEntry.loopId) < before.indexOf(targetEntry.loopId);
  await utilityLoopsActions.verifyLoopInsertionCues();
  const result = await utilityLoopsActions.dragLoopAfterByName(
    moveIsEarlier ? names[1] : names[2],
    moveIsEarlier ? names[2] : names[1],
  );
  expect(result.ordered_ids).not.toEqual(before);
  await utilityLoopsActions.expandGroupByTitle(LOOP_TRACK_TITLE);
  expect(await utilityLoopsActions.utilityLoopsTab.loopTree.readSongChildOrder(result.song_key)).toEqual(result.ordered_ids);
  const continuity = await utilityLoopsActions.readLoopContinuity(audio, playingId);
  expect(continuity.sameNode).toBe(true);
  expect(continuity.snapshot.paused).toBe(false);
  await utilityLoopsActions.waitForLoopProgress(playingId, { afterCurrentTime: continuity.snapshot.currentTime, minimumDelta: 0.2, allowWrap: true });
  const rangeAfter = await utilityLoopsActions.readLoopEditorStateByName(names[0]);
  expect([rangeAfter.startSeconds, rangeAfter.endSeconds]).toEqual([rangeBefore.startSeconds, rangeBefore.endSeconds]);
  await utilityLoopsActions.expectCreateAnotherLoopEditorActiveByName(names[0]);
  const tree = utilityLoopsActions.utilityLoopsTab.loopTree;
  const search = utilityLoopsActions.utilityLoopsTab.sidebar.search;
  await search.fill(names[0]);
  const toggle = tree.collapseToggleForGroup(tree.groupButtonByTitle(LOOP_TRACK_TITLE));
  for (const expanded of ['false', 'true', 'false', 'true']) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', expanded);
    await expect(search).toHaveValue(names[0]);
    await expect(tree.childButtons.filter({ hasText: names[1] })).toHaveCount(0);
    await expect(tree.childButtons.filter({ hasText: names[2] })).toHaveCount(0);
    if (expanded === 'true') {
      await expect(tree.childButtons).toHaveCount(1);
      await expect(tree.childButtons).toContainText(names[0]);
    }
  }
  const filteredContinuity = await utilityLoopsActions.readLoopContinuity(audio, playingId);
  expect(filteredContinuity.sameNode).toBe(true);
  expect(filteredContinuity.snapshot.paused).toBe(false);
  const filteredRange = await utilityLoopsActions.readLoopEditorStateByName(names[0]);
  expect([filteredRange.startSeconds, filteredRange.endSeconds]).toEqual([rangeBefore.startSeconds, rangeBefore.endSeconds]);
  await utilityLoopsActions.expectCreateAnotherLoopEditorActiveByName(names[0]);
  await search.fill('');
  await page.reload();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  expect(await card.readPanelOrder()).toEqual(result.ordered_ids);
  for (const name of names) {
    await utilityLoopsActions.openDeleteConfirmationByName(name);
    expect((await utilityLoopsActions.confirmDeleteByName(name)).requestCount).toBe(1);
  }
});

test(`${CASE_ID} fake-data bottom-player loop save and Utility Loops playback stay grouped under one track`, { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  page,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityAppearanceActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  const surfaces = new InteractionSurfaces(page);
  let nestedLoopDurationSeconds = 0;
  let fullTrackDurationSeconds = 0;
  let warmupLoopId = '';
  let warmupAudioHandle = null;
  let warmupIdleAction = null;
  let playingPlayerLayout = null;
  let selectedTrack;
  // Approved B02: 48px Play centered in a 56px Capsule, then the shared 8px column gap.
  const approvedCapsulePlayGap = 8 + ((56 - 48) / 2);
  const expectApprovedCapsuleSpacing = visual => {
    expect(Math.abs(visual.playBounds.width - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(visual.clusterBounds.width - 56)).toBeLessThanOrEqual(1);
    expect(Math.abs(visual.timelineLeftGapFromPlay - approvedCapsulePlayGap)).toBeLessThanOrEqual(1);
  };

  await stepLogger.step('Open the fake-data gallery and wait for the initial view to settle', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
  });

  await stepLogger.step('Prove the no-track scissors is natively disabled without a busy cursor or callback', async () => {
    const unavailable = await globalPlayerActions.expectUnavailableLoopAction();
    expect(unavailable.requestCount).toBe(0);
    expect(unavailable.visual.styles.state).toBe('disabled');
    expect(unavailable.visual.styles.enterDisabled).toBe(true);
    expect(unavailable.visual.styles.enterTitle).toBe('Start playing the track to edit the loop');
    expect(unavailable.visual.styles.enter.cursor).toBe('not-allowed');
    expect(unavailable.visual.coverCenterY).not.toBeNull();
    expect(Math.abs(unavailable.visual.coverCenterY - unavailable.visual.playCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(unavailable.visual.timelineCenterY - unavailable.visual.playCenterY))
      .toBeLessThanOrEqual(1);
    expectApprovedCapsuleSpacing(unavailable.visual);
    const hovered = await globalPlayerActions.hoverLoopAction();
    expect(hovered.styles.state).toBe('disabled');
    expect(hovered.podBounds).toEqual(unavailable.visual.podBounds);
  });

  await stepLogger.step('Select the exact signed journey album and start its fake loop source track', async () => {
    const selectedAlbum = await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
    expect(selectedAlbum).toEqual(LOOP_ALBUM_TARGET);
    const modal = await trackModalActions.waitForLoadedSummary();
    expect(modal.title).toContain(LOOP_ALBUM_TARGET.album);
    expect(`${modal.title} ${modal.subtitle}`).toContain(LOOP_ALBUM_TARGET.artist);
    expect(`${modal.title} ${modal.subtitle}`).toContain(LOOP_ALBUM_TARGET.year);
    const playbackMark = await playbackEvidence.playbackMark();
    selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
    expect(selectedTrack.title).toBe(LOOP_TRACK_TITLE);
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0 });
    const playback = await globalPlayerActions.readCurrentPlaybackSummary();
    expect(playback).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await trackModalActions.close();
  });

  await stepLogger.step('Select the owner-approved waveform seekbar through Appearance and return to the gallery', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('appearance');
    await utilityAppearanceActions.waitForReady();
    await utilityAppearanceActions.saveSeekbarMode('waveform');
    await settingsModalAppBarActions.closeSettings();
    playingPlayerLayout = await globalPlayerActions.readLoopActionVisualState();
    expect(playingPlayerLayout.coverCenterY).not.toBeNull();
    expect(Math.abs(playingPlayerLayout.coverCenterY - playingPlayerLayout.playCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(playingPlayerLayout.timelineCenterY - playingPlayerLayout.playCenterY))
      .toBeLessThanOrEqual(1);
    expectApprovedCapsuleSpacing(playingPlayerLayout);
    expect(playingPlayerLayout.playerBounds.height).toBe(100);
    expect(playingPlayerLayout.titleTopGap).toBeGreaterThanOrEqual(6);
  });

  await stepLogger.step('Pause and resume the same bottom-player track with the app-body Space shortcut', async () => {
    const paused = await globalPlayerActions.togglePlaybackWithSpace({ paused: true });
    expect(paused).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Play',
      paused: true,
    });
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    const pausedAt = await globalPlayerActions.readDisplayedCurrentTimeSeconds();

    const playbackMark = await playbackEvidence.playbackMark();
    const resumed = await globalPlayerActions.togglePlaybackWithSpace({ paused: false });
    expect(resumed).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    await globalPlayerActions.waitForCurrentTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
      visibleTitle: LOOP_PLAYER_TITLE,
    });
    expect(await globalPlayerActions.waitForDisplayedPlaybackAdvance(pausedAt)).toBeGreaterThan(pausedAt);
    expect((await playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: selectedTrack.path,
    })).renderedFrameDelta).toBeGreaterThan(0);
  });

  await stepLogger.step('Reload with the full track duration and keep loop editing inactive', async () => {
    const beforeReload = await globalPlayerActions.waitForFullTrackTiming();
    fullTrackDurationSeconds = beforeReload.duration;
    expect(fullTrackDurationSeconds).toBeGreaterThan(0);

    const reloadPlaybackMark = await playbackEvidence.playbackMark();
    const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
      path: selectedTrack.path,
      trackTitle: LOOP_TRACK_TITLE,
    });
    expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
    expect(restoredPlayback.paused).toBe(false);
    expect(restoredPlayback.initialRestore.path).toBe(selectedTrack.path);
    const playbackEvidenceAfterReload = await playbackEvidence.waitForTrackPlaybackEvidence({
      after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
      path: selectedTrack.path,
    });
    expect(playbackEvidenceAfterReload.nonZeroSamples).toBeGreaterThan(0);
    expect(playbackEvidenceAfterReload.renderedFrameDelta).toBeGreaterThan(0);
    await globalPlayerActions.expectLoopEditorInactive();
    const restoredEditor = await globalPlayerActions.openLoopEditor();
    expect(restoredEditor.duration).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect(restoredEditor.startSeconds).toBe(0);
    expect(restoredEditor.endSeconds).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);

    const afterEscape = await globalPlayerActions.waitForFullTrackTiming();
    expect(afterEscape.duration).toBeCloseTo(fullTrackDurationSeconds, 2);
    expect(afterEscape.currentTime).toBeGreaterThanOrEqual(0);
    expect(afterEscape.currentTime <= afterEscape.duration).toBe(true);
  });

  await stepLogger.step('Use the compact bottom-player scissors, shared range, cancellation, and naming workflow', async () => {
    const stereoBeforeEdit = await globalPlayerActions.waitForRenderedWaveform({ path: selectedTrack.path });
    expect(stereoBeforeEdit.leftBins).toBeGreaterThan(0);
    expect(stereoBeforeEdit.rightBins).toBe(stereoBeforeEdit.leftBins);
    expect(stereoBeforeEdit.leftPeaks).not.toEqual(stereoBeforeEdit.rightPeaks);
    await globalPlayerActions.pauseIfPlaying();
    const idle = await globalPlayerActions.moveAwayFromLoopAction();
    expect(idle.styles.state).toBe('idle');
    expect(idle.styles.engaged).toBe('false');
    expect(Math.abs(idle.coverCenterY - idle.playCenterY)).toBeLessThanOrEqual(1);
    expect(Math.abs(idle.timelineCenterY - idle.playCenterY)).toBeLessThanOrEqual(1);
    expect(Math.abs(idle.timelineCenterY - playingPlayerLayout.timelineCenterY))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(idle.mainAreaBounds.x - playingPlayerLayout.mainAreaBounds.x))
      .toBeLessThanOrEqual(1);
    expectApprovedCapsuleSpacing(idle);
    const idleHovered = await globalPlayerActions.hoverLoopAction();
    expect(idleHovered.styles.state).toBe('idle');
    expect(idleHovered.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(idleHovered.waveformBounds).toEqual(idle.waveformBounds);

    const opened = await globalPlayerActions.openLoopEditor();
    expect(opened.mainAreaBounds.width / opened.playerBounds.width).toBeGreaterThan(0.5);
    expect(opened.cursors.surface).toBe('default');
    expect(opened.cursors.selection).toBe('default');
    expect(opened.cursors.startHandle).toBe('grab');
    expect(opened.cursors.endHandle).toBe('grab');
    expect(opened.timeWaveformOverlap).toBe(false);
    expect(opened.metadataWaveformGap).toBeGreaterThanOrEqual(3);
    expect(Math.abs(opened.playerHeight - 100)).toBeLessThanOrEqual(1);
    expect(opened.waveformHeight).toBe(56);
    expect(opened.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(opened.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    const keyboardDialog = await globalPlayerActions.openLoopNameDialogWithEnter();
    expect(keyboardDialog).toEqual({ visible: true, focused: true, error: '' });
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
    const createHovered = await globalPlayerActions.hoverLoopAction('create');
    expect(createHovered.styles.state).toBe('editing');
    expect(createHovered.styles.engaged).toBe('true');
    expect(createHovered.styles.divider.display).not.toBe('none');
    expect(createHovered.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(createHovered.waveformBounds).toEqual(idle.waveformBounds);
    const cancelHovered = await globalPlayerActions.hoverLoopAction('cancel');
    expect(cancelHovered.styles.cancel.color).not.toBe(createHovered.styles.cancel.color);
    const collapsed = await globalPlayerActions.moveAwayFromLoopAction();
    expect(collapsed.styles.engaged).toBe('false');
    expect(collapsed.podBounds).toEqual(createHovered.podBounds);
    expect(collapsed.styles.create.color).not.toBe(createHovered.styles.create.color);
    expect(collapsed.styles.create.glyphFilter).not.toBe(createHovered.styles.create.glyphFilter);
    expect(collapsed.mainAreaBounds).toEqual(idle.mainAreaBounds);
    expect(collapsed.waveformBounds).toEqual(idle.waveformBounds);
    await globalPlayerActions.pauseIfPlaying();
    const keyboardExpanded = await globalPlayerActions.focusLoopAction('create');
    expect(keyboardExpanded.styles.engaged).toBe('true');

    const waveformSeek = await globalPlayerActions.clickLoopRangeAt(0.2);
    expect(waveformSeek.after.startSeconds).toBeCloseTo(waveformSeek.before.startSeconds, 3);
    expect(waveformSeek.after.endSeconds).toBeCloseTo(waveformSeek.before.endSeconds, 3);
    expect(waveformSeek.timing.currentTime).toBeCloseTo(waveformSeek.targetSeconds, 0);

    await globalPlayerActions.dragLoopBoundary('end', 0.45);
    const outsideSelectionSeek = await globalPlayerActions.clickLoopRangeAt(0.8);
    expect(outsideSelectionSeek.after.startSeconds)
      .toBeCloseTo(outsideSelectionSeek.before.startSeconds, 3);
    expect(outsideSelectionSeek.after.endSeconds)
      .toBeCloseTo(outsideSelectionSeek.before.endSeconds, 3);
    expect(outsideSelectionSeek.timing.currentTime)
      .toBeCloseTo(outsideSelectionSeek.targetSeconds, 0);
    const emptySpaceDrag = await globalPlayerActions.dragLoopRangeFromTo(0.7, 0.65);
    expect(emptySpaceDrag.after.startHandleFraction).toBeCloseTo(0, 1);
    expect(emptySpaceDrag.after.endHandleFraction).toBeCloseTo(0.65, 1);
    const startCrossedRight = await globalPlayerActions.dragLoopBoundary('start', 0.85);
    expect(startCrossedRight.startValueNow).toBeLessThan(startCrossedRight.endValueNow);
    expect(startCrossedRight.startSeconds).toBeLessThan(startCrossedRight.endSeconds);
    expect(startCrossedRight.startHandleFraction).toBeLessThan(startCrossedRight.endHandleFraction);
    expect(startCrossedRight.dragSnapshot.cursors.startHandle).toBe('grabbing');
    expect(startCrossedRight.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.startHandleFraction, 3);
    expect(startCrossedRight.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.endHandleFraction, 3);
    expect(startCrossedRight.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    const endCrossedLeft = await globalPlayerActions.dragLoopBoundary('end', 0.1);
    expect(endCrossedLeft.startValueNow).toBeLessThan(endCrossedLeft.endValueNow);
    expect(endCrossedLeft.startSeconds).toBeLessThan(endCrossedLeft.endSeconds);
    expect(endCrossedLeft.startHandleFraction).toBeLessThan(endCrossedLeft.endHandleFraction);
    expect(endCrossedLeft.dragSnapshot.cursors.endHandle).toBe('grabbing');
    expect(endCrossedLeft.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.startHandleFraction, 3);
    expect(endCrossedLeft.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.endHandleFraction, 3);
    expect(endCrossedLeft.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.selectionEndErrorPixels).toBeLessThanOrEqual(1);

    expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    await globalPlayerActions.openLoopEditor();
    expect((await globalPlayerActions.disableStreamingLoop({ waitForStreaming: false })).requestCount)
      .toBe(0);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const selectedRange = await globalPlayerActions.openLoopEditor();
    const mainVisual = await globalPlayerActions.readMainLoopVisualState();
    expect(mainVisual.canvas.upperPixels).toBeGreaterThan(0);
    expect(mainVisual.canvas.lowerPixels).toBeGreaterThan(0);
    expect(mainVisual.timeline.visible).toBe(true);
    expect(mainVisual.timeline.opacity).toBeGreaterThanOrEqual(0.4);
    expect(Math.abs(mainVisual.selectionTopOvershoot - mainVisual.selectionBottomOvershoot))
      .toBeLessThanOrEqual(1);
    expect(selectedRange.legacyBoundaryTimeCount).toBe(0);
    expect(selectedRange.timeSlotCount).toBe(1);
    const dialog = await globalPlayerActions.openLoopNameDialog();
    expect(dialog).toEqual({ visible: true, focused: true, error: '' });
    expect(await globalPlayerActions.submitBlankLoopName()).not.toBe('');
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    const cancelledSummary = await utilityLoopsActions.readSummary();
    expect(cancelledSummary.groupCount).toBe(0);
    expect(cancelledSummary.entryCount).toBe(0);
    expect(cancelledSummary.emptyState).toContain('Create a loop from the bottom player');
    await settingsModalAppBarActions.closeSettings();

    const save = await globalPlayerActions.saveLoopWithName('Warmup Loop', { submitWithEnter: true });
    expect(save.requestCount).toBe(1);
    await globalPlayerActions.pauseIfPlaying();
  });

  await stepLogger.step('Open Utility Loops and confirm the first loop plays back', async () => {
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 0,
      childLoopCount: 0,
    });
    await utilityLoopsActions.expandGroupByTitle(LOOP_TRACK_TITLE);
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 1,
      childLoopCount: 1,
    });
    await settingsModalAppBarActions.closeSettings();
    await settingsModalAppBarActions.openSettings();
    await utilityLoopsActions.waitForReady();
    expect(await utilityLoopsActions.readSidebarExpansionSummary()).toEqual({
      groupCount: 1,
      expandedGroupCount: 0,
      childLoopCount: 0,
    });
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    await utilityLoopsActions.verifySongArtworkAndYear(LOOP_TRACK_TITLE, LOOP_ALBUM_TARGET.year);
    await expectCombinedLoopWaveform(page);
    await expectStableButtonHover(page, surfaces.loopPlay);
    const detail = await utilityLoopsActions.readDetailSummary();
    expect(detail.title).toBe(LOOP_TRACK_TITLE);
    expect(detail.entryCount).toBe(1);
    expect(detail.meta.some((value) => value.includes('1 saved loop'))).toBe(true);
    const initialEditor = await utilityLoopsActions.readLoopEditorStateByName('Warmup Loop');
    expect(initialEditor.visibility).toEqual({
      editor: false,
      waveform: false,
      timeSlot: true,
      startHandle: false,
      endHandle: false,
    });
    const compactLayout = await utilityLoopsActions.readCompactLoopLayoutByName('Warmup Loop');
    // L03 adds Original timestamps; L04/B03 reserves the approved bottom glow padding.
    // Keep the card exactly fitted to its two rows instead of the superseded 140px cap.
    expect(compactLayout.cardInsets).toEqual({ top: 16, right: 18, bottom: 24, left: 18, rowGap: 7, border: 1 });
    const { entryBounds, headingBounds, shellBounds } = compactLayout;
    expect(Math.abs(headingBounds.y - entryBounds.y - 17)).toBeLessThanOrEqual(1);
    expect(Math.abs(shellBounds.y - headingBounds.y - headingBounds.height - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(entryBounds.y + entryBounds.height - shellBounds.y - shellBounds.height - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(entryBounds.height - headingBounds.height - shellBounds.height - 49)).toBeLessThanOrEqual(1);
    expect(compactLayout.pitchBounds.y).toBeGreaterThanOrEqual(compactLayout.topRowBounds.y);
    expect(compactLayout.pitchBounds.y + compactLayout.pitchBounds.height)
      .toBeLessThanOrEqual(compactLayout.topRowBounds.y + compactLayout.topRowBounds.height + 1);
    expect(compactLayout.pitchText).toBe('- 0 pst +');
    expect(compactLayout.timeSlotCount).toBe(1);
    expect(compactLayout.legacyBoundaryTimeCount).toBe(0);
    expect(
      compactLayout.timelineBounds.y,
      'approved saved-loop two-row layout keeps the timeline below the timestamp row',
    )
      .toBeGreaterThanOrEqual(compactLayout.topRowBounds.y + compactLayout.topRowBounds.height);
    expect(
      compactLayout.timeBounds.y + compactLayout.timeBounds.height,
      'saved-loop timestamp row must finish before the waveform timeline begins',
    )
      .toBeLessThanOrEqual(compactLayout.timelineBounds.y);
    expect(
      compactLayout.timelineBounds.y + compactLayout.timelineBounds.height,
      'lowering the saved-loop timeline must keep it inside the compact player main area',
    )
      .toBeLessThanOrEqual(compactLayout.mainBounds.y + compactLayout.mainBounds.height + 1);
    const savedLoopTimelineCenterY = compactLayout.timelineBounds.y + (compactLayout.timelineBounds.height / 2);
    [compactLayout.playBounds, compactLayout.repeatBounds, compactLayout.speedBounds].forEach((bounds) => {
      const controlCenterY = bounds.y + (bounds.height / 2);
      expect(Math.abs(controlCenterY - savedLoopTimelineCenterY)).toBeLessThanOrEqual(1);
    });
    expect(compactLayout.firstEntryGap).toBeGreaterThanOrEqual(0);
    expect(compactLayout.firstEntryGap).toBeLessThanOrEqual(16);
    expect(compactLayout.scissorsBounds.x).toBeGreaterThan(compactLayout.playBounds.x);
    expect(compactLayout.scissorsBounds.y).toBeGreaterThan(compactLayout.playBounds.y);
    warmupIdleAction = await utilityLoopsActions.readLoopActionVisualStateByName('Warmup Loop');
    expect(warmupIdleAction.styles.state).toBe('idle');
    await utilityLoopsActions.pressSpaceBeforeLoopOwnership(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: false }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: LOOP_PLAYER_TITLE,
      playbackControl: 'Pause',
      paused: false,
    });
    await utilityLoopsActions.pressSpaceBeforeLoopOwnership(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }),
    });
    await expectLoopPauseFirstClick(page);
    const ownedStart = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: false },
    );
    const loopId = ownedStart.loopId;
    expect(ownedStart.snapshot.paused).toBe(false);
    const ownedPause = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: true },
    );
    expect(ownedPause.snapshot.paused).toBe(true);
    const neutralResume = await utilityLoopsActions.pressNeutralSpaceForOwnedLoop(
      LOOP_TRACK_TITLE,
      loopId,
      { paused: false },
    );
    expect(neutralResume.paused).toBe(false);
    const loopSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(loopSamples.frameCount).toBeGreaterThan(0);
    expect(loopSamples.finiteSamples).toBeGreaterThan(0);
    expect(loopSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(loopSamples.peakSample).toBeGreaterThan(0);
    await utilityLoopsActions.waitForLoopProgress(loopId, {
      afterCurrentTime: neutralResume.currentTime,
      minimumDelta: 0.2,
      allowWrap: false,
    });
    await globalPlayerActions.resumeIfPaused();
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(false);
    expect((await utilityLoopsActions.readLoopPlaybackSnapshot(loopId)).paused).toBe(false);
    const playerSurfaceClick = await globalPlayerActions.clickOwnershipSurface();
    expect(playerSurfaceClick.after).toEqual(playerSurfaceClick.before);
    const loopAfterGlobalReclaim = await utilityLoopsActions.pressNeutralSpaceAfterGlobalReclaim(
      LOOP_TRACK_TITLE,
      loopId,
      { paused: false },
      { afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: true }) },
    );
    expect(loopAfterGlobalReclaim.paused).toBe(false);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const loopAfterFocusReclaim = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: true },
    );
    expect(loopAfterFocusReclaim.snapshot.paused).toBe(true);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const loopResumeAfterReclaim = await utilityLoopsActions.pressSpaceForOwnedLoopByName(
      'Warmup Loop',
      { paused: false },
    );
    expect(loopResumeAfterReclaim.snapshot.paused).toBe(false);
    expect((await globalPlayerActions.readCurrentPlaybackSummary()).paused).toBe(true);
    const audioHandle = await utilityLoopsActions.captureLoopAudioHandle(loopId);
    warmupLoopId = loopId;
    warmupAudioHandle = audioHandle;
    await utilityLoopsActions.enableRepeatByName('Warmup Loop');
    const repeated = await utilityLoopsActions.waitForRepeatCycle(loopId);
    expect(repeated.paused).toBe(false);
    expect(repeated.currentTime).toBeGreaterThanOrEqual(0.2);
    const slowed = await utilityLoopsActions.setSpeedByName('Warmup Loop', 0.75);
    expect(slowed.paused).toBe(false);
    expect(slowed.playbackRate).toBeCloseTo(0.75, 2);
    const pitched = await utilityLoopsActions.stepPitchByName(
      'Warmup Loop',
      1,
      '+1 pst',
    );
    expect(pitched.progressed.paused).toBe(false);
    expect(pitched.progressed.pitch).toBe(1);
    expect(pitched.progressed.speed).toBeCloseTo(0.75, 2);
    expect(pitched.progressed.playbackRate).toBeCloseTo(0.75, 2);
    const pitchedSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(pitchedSamples.frameCount).toBeGreaterThan(0);
    expect(pitchedSamples.finiteSamples).toBeGreaterThan(0);
    expect(pitchedSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(await utilityLoopsActions.readRepeatPressedByName('Warmup Loop')).toBe(true);
    const repeatedAfterPitch = await utilityLoopsActions.waitForRepeatCycle(loopId);
    expect(repeatedAfterPitch.paused).toBe(false);
    expect(repeatedAfterPitch.currentTime).toBeGreaterThanOrEqual(0.2);
    const continuity = await utilityLoopsActions.readLoopContinuity(audioHandle, loopId);
    expect(continuity.sameNode).toBe(true);
    expect(continuity.snapshot.connected).toBe(true);
    expect(continuity.snapshot.paused).toBe(false);
  });

  await stepLogger.step('Use the inline combined waveform, crossing handles, cancellation, and nested naming workflow', async () => {
    const revealed = await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect(revealed.counts.waveform).toBe(1);
    expect(revealed.counts.startHandle).toBe(1);
    expect(revealed.counts.endHandle).toBe(1);
    expect(revealed.visibility.waveform).toBe(true);
    expect(revealed.visibility.timeSlot).toBe(true);
    expect(revealed.counts.legacyBoundaryTimes).toBe(0);
    expect(revealed.duration).toBeGreaterThan(0);
    expect(revealed.waveformPixels).toBeGreaterThan(0);
    expect(revealed.pitchVisible).toBe(false);
    expect(revealed.timestampVisible).toBe(true);
    expect(revealed.timeWaveformOverlap).toBe(false);
    expect(revealed.cursors.surfaceCursor).toBe('default');
    expect(revealed.cursors.selectionCursor).toBe('default');
    expect(revealed.cursors.startHandleCursor).toBe('grab');
    expect(revealed.cursors.endHandleCursor).toBe('grab');
    expect(revealed.playerHeight).toBeGreaterThan(revealed.waveformHeight);
    expect(revealed.waveformHeight).toBeGreaterThanOrEqual(32);
    expect(revealed.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(revealed.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(revealed.startHandleOverlapsEditControl).toBe(true);
    expect(revealed.editControlPaintsAboveStartHandle).toBe(true);
    expect((await utilityLoopsActions.escapeCreateAnotherLoopByName('Warmup Loop', {
      focusTarget: 'repeat',
    })).requestCount).toBe(0);
    const continuityAfterUntouchedEscape = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterUntouchedEscape.sameNode).toBe(true);
    expect(continuityAfterUntouchedEscape.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect((await utilityLoopsActions.readCompactLoopLayoutByName('Warmup Loop')).ordinaryTimelineVisible)
      .toBe(true);
    const savedCreateHovered = await utilityLoopsActions.hoverLoopActionByName('Warmup Loop', 'create');
    expect(savedCreateHovered.styles.state).toBe('editing');
    expect(savedCreateHovered.mainBounds).toEqual(warmupIdleAction.mainBounds);
    expect(savedCreateHovered.timelineBounds).toEqual(warmupIdleAction.timelineBounds);
    const savedCollapsed = await utilityLoopsActions.moveAwayFromLoopActionByName('Warmup Loop');
    expect(savedCollapsed.podBounds).toEqual(savedCreateHovered.podBounds);
    expect(savedCollapsed.mainBounds).toEqual(warmupIdleAction.mainBounds);
    expect(savedCollapsed.timelineBounds).toEqual(warmupIdleAction.timelineBounds);
    await utilityLoopsActions.hoverLoopActionByName('Warmup Loop', 'create');
    const savedLoopVisual = await utilityLoopsActions.readSavedLoopVisualStateByName('Warmup Loop');
    expect(savedLoopVisual.canvas.upperPixels).toBeGreaterThan(0);
    expect(savedLoopVisual.canvas.lowerPixels).toBeGreaterThan(0);
    expect(
      Math.abs(savedLoopVisual.canvas.upperPixels - savedLoopVisual.canvas.lowerPixels)
      / Math.max(savedLoopVisual.canvas.upperPixels, savedLoopVisual.canvas.lowerPixels),
    ).toBeLessThanOrEqual(0.1);
    expect(savedLoopVisual.timeline.visible).toBe(true);
    expect(savedLoopVisual.timeline.opacity).toBeGreaterThan(0);
    expect(savedLoopVisual.timeline.appearance).toBe('none');
    expect(savedLoopVisual.timeline.trackBackground).toBe('rgba(0, 0, 0, 0)');
    expect(savedLoopVisual.playhead.paintedRowRatio).toBeGreaterThanOrEqual(0.9);
    const progressedLoop = await utilityLoopsActions.waitForLoopProgress(revealed.loopId, {
      afterCurrentTime: savedLoopVisual.timeline.value,
      minimumDelta: 0.1,
    });
    const progressedVisual = await utilityLoopsActions.readSavedLoopVisualStateByName('Warmup Loop');
    expect(progressedVisual.timeline.value).toBeCloseTo(progressedLoop.currentTime, 0);

    const waveformSeek = await utilityLoopsActions.clickLoopRangeByName('Warmup Loop', 0.2);
    expect(waveformSeek.after.startSeconds).toBeCloseTo(waveformSeek.before.startSeconds, 3);
    expect(waveformSeek.after.endSeconds).toBeCloseTo(waveformSeek.before.endSeconds, 3);
    expect(waveformSeek.playback.currentTime).toBeCloseTo(waveformSeek.targetSeconds, 0);

    await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.45);
    const startCrossedRight = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'start', 0.85);
    expect(startCrossedRight.startSeconds).toBeLessThan(startCrossedRight.endSeconds);
    expect(startCrossedRight.startValueNow).toBeLessThan(startCrossedRight.endValueNow);
    expect(startCrossedRight.dragSnapshot.cursors.startHandleCursor).toBe('grabbing');
    expect(startCrossedRight.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(startCrossedRight.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.startHandleFraction, 3);
    expect(startCrossedRight.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(startCrossedRight.dragSnapshot.endHandleFraction, 3);
    const endCrossedLeft = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.1);
    expect(endCrossedLeft.startSeconds).toBeLessThan(endCrossedLeft.endSeconds);
    expect(endCrossedLeft.startValueNow).toBeLessThan(endCrossedLeft.endValueNow);
    expect(endCrossedLeft.dragSnapshot.cursors.endHandleCursor).toBe('grabbing');
    expect(endCrossedLeft.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(endCrossedLeft.dragSnapshot.selectionLeftFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.startHandleFraction, 3);
    expect(endCrossedLeft.dragSnapshot.selectionRightFraction)
      .toBeCloseTo(endCrossedLeft.dragSnapshot.endHandleFraction, 3);

    expect((await utilityLoopsActions.cancelCreateAnotherLoopByName('Warmup Loop')).requestCount).toBe(0);
    const continuityAfterRedCancel = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterRedCancel.sameNode).toBe(true);
    expect(continuityAfterRedCancel.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');
    expect((await utilityLoopsActions.escapeCreateAnotherLoopByName('Warmup Loop')).requestCount).toBe(0);
    const continuityAfterEscape = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterEscape.sameNode).toBe(true);
    expect(continuityAfterEscape.snapshot.paused).toBe(false);
    await utilityLoopsActions.revealCreateAnotherLoopEditorByName('Warmup Loop');

    const afterStartDrag = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'start', 0.25);
    expect(afterStartDrag.startSeconds).toBeGreaterThan(0);
    expect(afterStartDrag.startSeconds).toBeLessThan(afterStartDrag.endSeconds);
    const startHandleAlignmentErrorSeconds = Math.abs(
      afterStartDrag.startSeconds
      - (afterStartDrag.startHandleFraction * afterStartDrag.duration)
    );
    expect(startHandleAlignmentErrorSeconds)
      .toBeLessThanOrEqual(HANDLE_POSITION_TOLERANCE_SECONDS);
    expect(afterStartDrag.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterStartDrag.selectionEndErrorPixels).toBeLessThanOrEqual(1);

    const afterEndDrag = await utilityLoopsActions.dragLoopBoundaryByName('Warmup Loop', 'end', 0.75);
    expect(afterEndDrag.endSeconds).toBeGreaterThan(afterEndDrag.startSeconds);
    expect(afterEndDrag.endSeconds).toBeLessThanOrEqual(afterEndDrag.duration);
    const endHandleAlignmentErrorSeconds = Math.abs(
      afterEndDrag.endSeconds
      - (afterEndDrag.endHandleFraction * afterEndDrag.duration)
    );
    expect(endHandleAlignmentErrorSeconds)
      .toBeLessThanOrEqual(HANDLE_POSITION_TOLERANCE_SECONDS);
    expect(afterEndDrag.dragSnapshot.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.dragSnapshot.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.selectionStartErrorPixels).toBeLessThanOrEqual(1);
    expect(afterEndDrag.selectionEndErrorPixels).toBeLessThanOrEqual(1);
    nestedLoopDurationSeconds = afterEndDrag.endSeconds - afterEndDrag.startSeconds;
    expect(nestedLoopDurationSeconds).toBeGreaterThan(0);

    await utilityLoopsActions.activateCreateAnotherLoopByName('Warmup Loop');
    expect(await globalPlayerActions.waitForLoopNameDialog()).toEqual({
      visible: true,
      focused: true,
      error: '',
    });
    expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
    expect((await utilityLoopsActions.readDetailSummary()).entryCount).toBe(1);
    const continuityAfterCancel = await utilityLoopsActions.readLoopContinuity(
      warmupAudioHandle,
      warmupLoopId,
    );
    expect(continuityAfterCancel.sameNode).toBe(true);
    expect(continuityAfterCancel.snapshot.connected).toBe(true);
    expect(continuityAfterCancel.snapshot.paused).toBe(false);

    await utilityLoopsActions.activateCreateAnotherLoopByName('Warmup Loop');
    await globalPlayerActions.waitForLoopNameDialog();
    const nestedSave = await globalPlayerActions.submitLoopName('Transition Loop');
    expect(nestedSave.requestCount).toBe(1);
    const immediateGroup = await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE);
    expect(immediateGroup.count).toBe(2);
    const immediateDetail = await utilityLoopsActions.readDetailSummary();
    expect(immediateDetail.title).toBe(LOOP_TRACK_TITLE);
    expect(immediateDetail.entryCount).toBe(2);
    expect(immediateDetail.meta.some((value) => value.includes('2 saved loops'))).toBe(true);
    const immediateWarmup = await utilityLoopsActions.resolveLoopEntryByName('Warmup Loop');
    const immediateTransition = await utilityLoopsActions.resolveLoopEntryByName('Transition Loop');
    expect(immediateWarmup.loopId).toBe(warmupLoopId);
    expect(immediateTransition.loopId).not.toBe('');
  });

  await stepLogger.step('Verify Utility Loops groups both saved loops under the same track with a loop count of two', async () => {
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const groupSummary = await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE);
    expect(groupSummary.count).toBe(2);
    const detail = await utilityLoopsActions.readDetailSummary();
    expect(detail.title).toBe(LOOP_TRACK_TITLE);
    expect(detail.entryCount).toBe(2);
    expect(detail.meta.some((value) => value.includes('2 saved loops'))).toBe(true);
    const loopId = await utilityLoopsActions.playLoopByName('Transition Loop');
    const audioHandle = await utilityLoopsActions.captureLoopAudioHandle(loopId);
    await utilityLoopsActions.waitForLoopProgress(loopId, {
      afterCurrentTime: 0,
      minimumDelta: 0.75,
      allowWrap: false,
    });
    const pitched = await utilityLoopsActions.stepPitchByName(
      'Transition Loop',
      1,
      '+1 pst',
    );
    expect(Math.abs(pitched.requested.duration - nestedLoopDurationSeconds))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(Math.abs(pitched.restored.duration - pitched.requested.duration))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(Math.abs(pitched.progressed.duration - pitched.requested.duration))
      .toBeLessThanOrEqual(MEDIA_DURATION_TOLERANCE_SECONDS);
    expect(pitched.requested.currentTime).toBeGreaterThanOrEqual(0.75);
    expect(pitched.restored.currentTime).toBeGreaterThanOrEqual(0);
    expect(pitched.restored.currentTime).toBeLessThanOrEqual(pitched.restored.duration);
    expect(pitched.restored.currentTime).toBeGreaterThanOrEqual(
      Math.max(0, pitched.requested.currentTime - 0.25),
    );
    expect(pitched.progressed.paused).toBe(false);
    expect(pitched.progressed.pitch).toBe(1);
    const transitionSamples = await utilityLoopsActions.readDecodedLoopSampleEvidence(loopId);
    expect(transitionSamples.frameCount).toBeGreaterThan(0);
    expect(transitionSamples.nonZeroSamples).toBeGreaterThan(0);
    expect(transitionSamples.peakSample).toBeGreaterThan(0);
    const spedUp = await utilityLoopsActions.setSpeedByName('Transition Loop', 1.25);
    expect(spedUp.paused).toBe(false);
    expect(spedUp.pitch).toBe(1);
    expect(spedUp.speed).toBeCloseTo(1.25, 2);
    expect(spedUp.playbackRate).toBeCloseTo(1.25, 2);
    const continuity = await utilityLoopsActions.readLoopContinuity(audioHandle, loopId);
    expect(continuity.sameNode).toBe(true);
    expect(continuity.snapshot.connected).toBe(true);
    expect(continuity.snapshot.paused).toBe(false);
  });

  await stepLogger.step('Reset loop Space priority after leaving and returning to Loops', async () => {
    await utilityTabBarActions.openTab('rules');
    await utilityTabBarActions.openTab('loops');
    await utilityLoopsActions.waitForReady();
    await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
    const resetStart = await globalPlayerActions.readCurrentPlaybackSummary();
    const firstExpectedPaused = !resetStart.paused;
    await utilityLoopsActions.pressSpaceAfterLoopOwnershipReset(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: firstExpectedPaused }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: resetStart.title,
      playbackControl: firstExpectedPaused ? 'Play' : 'Pause',
      paused: firstExpectedPaused,
    });
    await utilityLoopsActions.pressSpaceAfterLoopOwnershipReset(LOOP_TRACK_TITLE, {
      afterSpace: () => globalPlayerActions.waitForPlaybackState({ paused: resetStart.paused }),
    });
    expect(await globalPlayerActions.readCurrentPlaybackSummary()).toEqual({
      title: resetStart.title,
      playbackControl: resetStart.paused ? 'Play' : 'Pause',
      paused: resetStart.paused,
    });
  });

  await stepLogger.step('Delete a saved loop through the app-owned No and Yes confirmation', async () => {
    const firstOpen = await utilityLoopsActions.openDeleteConfirmationByName('Transition Loop');
    expect(firstOpen.nativeDialogs).toEqual([]);
    expect(firstOpen.text).toBe('Delete “Transition Loop”? The saved loop will be removed.');
    expect(firstOpen.stacking.deleteZIndex).toBeGreaterThan(firstOpen.stacking.utilityZIndex);
    expect(firstOpen.stacking.deleteOwnsTopElement).toBe(true);
    expect((await utilityLoopsActions.cancelDeleteConfirmationByName('Transition Loop')).requestCount)
      .toBe(0);

    const secondOpen = await utilityLoopsActions.openDeleteConfirmationByName('Transition Loop');
    expect(secondOpen.nativeDialogs).toEqual([]);
    expect((await utilityLoopsActions.confirmDeleteByName('Transition Loop')).requestCount).toBe(1);
    expect((await utilityLoopsActions.readDetailSummary()).entryCount).toBe(1);
    expect((await utilityLoopsActions.readGroupSummaryByTitle(LOOP_TRACK_TITLE)).count).toBe(1);

    const consecutiveOpen = await utilityLoopsActions.openDeleteConfirmationByName('Warmup Loop');
    expect(consecutiveOpen.nativeDialogs).toEqual([]);
    expect(consecutiveOpen.text).toBe('Delete “Warmup Loop”? The saved loop will be removed.');
    expect((await utilityLoopsActions.cancelDeleteConfirmationByName('Warmup Loop')).requestCount)
      .toBe(0);
  });

});

test('FTC-UTIL-LOOPS-026 delete confirmation foregrounds the open Utility modal', { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  const loopName = 'Foreground Delete Confirmation Loop';
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(loopName)).requestCount).toBe(1);

  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  const opened = await utilityLoopsActions.openDeleteConfirmationByName(loopName);
  expect(opened.nativeDialogs).toEqual([]);
  expect(opened.stacking.deleteZIndex).toBeGreaterThan(opened.stacking.utilityZIndex);
  expect(opened.stacking.deleteOwnsTopElement).toBe(true);
  expect(await utilityLoopsActions.selectDeleteConfirmationTextOutsideDialog())
    .toBe(`Delete “${loopName}”? The saved loop will be removed.`);
  expect((await utilityLoopsActions.confirmDeleteByName(loopName)).requestCount).toBe(1);
});

test('FTC-UTIL-LOOPS-024 Enter opens naming from the active saved-loop editor', { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityLoopsActions,
  utilityTabBarActions,
}) => {
  const loopName = 'Saved Loop Enter Shortcut';
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName(loopName)).requestCount).toBe(1);

  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('loops');
  await utilityLoopsActions.waitForReady();
  await utilityLoopsActions.selectGroupByTitle(LOOP_TRACK_TITLE);
  await utilityLoopsActions.revealCreateAnotherLoopEditorByName(loopName);
  expect((await utilityLoopsActions.activateCreateAnotherLoopWithEnterByName(loopName)).requestCount)
    .toBe(0);
  expect(await globalPlayerActions.waitForLoopNameDialog()).toEqual({
    visible: true,
    focused: true,
    error: '',
  });
  expect((await globalPlayerActions.cancelLoopNameDialog()).requestCount).toBe(0);
  await utilityLoopsActions.expectCreateAnotherLoopEditorActiveByName(loopName);
  expect((await utilityLoopsActions.escapeCreateAnotherLoopByName(loopName)).requestCount).toBe(0);
  await utilityLoopsActions.openDeleteConfirmationByName(loopName);
  expect((await utilityLoopsActions.confirmDeleteByName(loopName)).requestCount).toBe(1);
});

test('FTC-PLAYER-017 scissors remains available after saving a loop', { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  trackModalActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.saveLoopWithName('Reusable Scissors Loop')).requestCount).toBe(1);

  await globalPlayerActions.expectAvailableLoopAction();
  await globalPlayerActions.openLoopEditor();
  expect((await globalPlayerActions.cancelLoopEditorWithEscape()).requestCount).toBe(0);
});

test('FTC-PLAYER-017 loop-edit reload restores the active playhead', { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  playbackEvidence,
  trackModalActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await trackModalActions.close();
  await globalPlayerActions.waitForFullTrackTiming();
  await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 2 });
  await globalPlayerActions.openLoopEditor();
  const beforeReload = await globalPlayerActions.waitForFullTrackTiming();
  expect(beforeReload.currentTime).toBeGreaterThan(1);

  const reloadPlaybackMark = await playbackEvidence.playbackMark();
  const restoredPlayback = await globalPlayerActions.reloadAndWaitForRestoredTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
  });
  expect(['autoplay', 'blocked-resumed']).toContain(restoredPlayback.reloadOutcome);
  expect(restoredPlayback.paused).toBe(false);
  expect(restoredPlayback.initialRestore.path).toBe(selectedTrack.path);

  await globalPlayerActions.expectLoopEditorInactive();
  const restored = await globalPlayerActions.waitForFullTrackTiming();
  expect(restored.currentTime).toBeGreaterThanOrEqual(beforeReload.currentTime - 1);
  expect(restored.currentTime).toBeLessThanOrEqual(restored.duration);
  const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({
    after: { ...reloadPlaybackMark, renderedFrame: 0, path: '', streamId: 0, generation: 0 },
    path: selectedTrack.path,
  });
  expect(evidence.nonZeroSamples).toBeGreaterThan(0);
  expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
});

test('FTC-PLAYER-017 paused reload restores the current waveform', { tag: '@area:loops' }, async ({
  galleryActions,
  globalPlayerActions,
  settingsModalAppBarActions,
  trackModalActions,
  utilityAppearanceActions,
  utilityTabBarActions,
}) => {
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('appearance');
  await utilityAppearanceActions.waitForReady();
  await utilityAppearanceActions.saveSeekbarMode('waveform');
  await settingsModalAppBarActions.closeSettings();

  await galleryActions.selectAlbumDetailsByIdentity(LOOP_ALBUM_TARGET);
  const selectedTrack = await trackModalActions.playTrackByTitle(LOOP_TRACK_TITLE);
  await globalPlayerActions.waitForCurrentTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
    visibleTitle: LOOP_PLAYER_TITLE,
  });
  await globalPlayerActions.pauseIfPlaying();
  await trackModalActions.close();

  await globalPlayerActions.reloadAndWaitForRestoredTrack({
    path: selectedTrack.path,
    trackTitle: LOOP_TRACK_TITLE,
  }, { paused: true });

  const waveform = await globalPlayerActions.waitForRenderedWaveform({ path: selectedTrack.path });
  expect(waveform.nonPlayheadPixels).toBeGreaterThan(0);
  expect(waveform.leftBins).toBe(720);
  expect(waveform.rightBins).toBe(720);
});
