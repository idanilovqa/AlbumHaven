import { expect, test } from '../support/baseFixtures.js';
import {
  defineTimingBudget,
  expectTimingBudget,
  measureAlbumTrackPlaybackStart,
} from '../helpers/index.js';

const CASE_ID = 'FTC-PLAYER-026';
const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
// The browser runs four times slower than the runner, as on a busy laptop.
const CPU_SLOWDOWN = 4;
// The owner's bar: sound well under a second after Play even when the machine is busy.
const CLICK_TO_SOUND_BUDGET = defineTimingBudget({
  metricId: 'playback-start.clickToSoundUnderCpuLoadMs',
  targetMaximum: 1000,
  graceMs: 300,
});

// The selected song is shown, plays on past its start, and keeps rendering real samples.
// Where a start spent its time, for diagnosis: each control and the first audio bytes after the click.
function startStages(playbackEvidence, eventMark, clickedAtEpochMs) {
  const seen = new Set();
  return playbackEvidence.eventsSince(eventMark)
    .filter((event) => ['probe', 'probe-result', 'open', 'metadata', 'rate-mismatch', 'encoded', 'pcm']
      .includes(event.type))
    .map((event) => ({
      label: ['encoded', 'pcm'].includes(event.type)
        ? `first ${event.type} bytes ${event.role}`
        : `${event.type} ${event.role || ''}${event.sampleRate ? ` @${event.sampleRate}` : ''}${
          event.type === 'open' ? (event.codecs ? ' encoded' : ' server-decoded') : ''}`,
      at: event.sentAtEpochMs || event.receivedAtEpochMs,
    }))
    .filter(({ label }) => (seen.has(label) ? false : seen.add(label)))
    .map(({ label, at }) => `${label} +${Math.round(at - clickedAtEpochMs)}`)
    .join(', ');
}

async function measureStart(context, rowIndex, label) {
  const { page, trackModalActions, playbackEvidence } = context;
  const eventMark = playbackEvidence.eventMark();
  const clickedAtEpochMs = Date.now();
  const attempt = await measureAlbumTrackPlaybackStart({
    page, trackModalActions, traffic: playbackEvidence, rowIndex, label,
  });
  attempt.stages = startStages(playbackEvidence, eventMark, clickedAtEpochMs);
  return attempt;
}

async function expectAudibleTrack({ attempt, globalPlayerActions, playbackEvidence }) {
  expect(attempt.diagnostics.currentPath).toBe(attempt.track.path);
  expect(attempt.diagnostics.paused).toBe(false);
  expect(attempt.playbackEvidence.pcmFrames).toBeGreaterThan(0);
  expect(attempt.playbackEvidence.nonZeroSamples).toBeGreaterThan(0);
  expect(attempt.playbackEvidence.renderedFrameDelta).toBeGreaterThan(0);
  const mark = await playbackEvidence.playbackMark();
  await globalPlayerActions.waitForCurrentTrack({
    path: attempt.track.path,
    trackTitle: attempt.track.title,
  });
  await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 1 });
  const sustained = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: attempt.track.path });
  expect(sustained.nonZeroSamples).toBeGreaterThan(0);
  expect(sustained.renderedFrameDelta).toBeGreaterThan(0);
}

test(`${CASE_ID} the first song after the page opens and a switch to another song both sound within a second while the CPU is busy`, { tag: '@area:playback' }, async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}, testInfo) => {
  await stepLogger.step('Open the playback-start album through search and album details', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisible(ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toContain(`${ARTIST} • ${ALBUM}`);
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  try {
    const context = { page, trackModalActions, playbackEvidence };
    const first = await stepLogger.step('Play the first song since the page opened', async () => (
      measureStart(context, 0, 'first song')
    ));
    await expectAudibleTrack({ attempt: first, globalPlayerActions, playbackEvidence });

    const switched = await stepLogger.step('Switch to another song while the first one plays', async () => (
      measureStart(context, 4, 'switch while playing')
    ));
    await expectAudibleTrack({ attempt: switched, globalPlayerActions, playbackEvidence });
    expect(switched.track.path).not.toBe(first.track.path);

    for (const attempt of [first, switched]) {
      testInfo.annotations.push({
        type: `click to sound, ${attempt.label} (ms)`,
        description: `${Math.round(attempt.elapsedMs)} (${attempt.stages})`,
      });
      stepLogger.note(`${attempt.label}: ${Math.round(attempt.elapsedMs)} ms; ${attempt.stages}`, 1);
    }
    expectTimingBudget(expect, first.elapsedMs, CLICK_TO_SOUND_BUDGET, 'First song click to sound');
    expectTimingBudget(expect, switched.elapsedMs, CLICK_TO_SOUND_BUDGET, 'Switch click to sound');
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    await globalPlayerActions.pauseIfPlaying();
  }
});
