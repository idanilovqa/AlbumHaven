import { expect, test } from '../support/baseFixtures.js';
import {
  measureResumeToSound,
  observePlaybackClaimRequests,
  playOnForASecond,
  readResumeCheckpoint,
  summarizeResumeSamples,
} from '../helpers/playbackResumeHelpers.js';

const CASE_ID = 'FTC-PLAYER-030';
const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';
const SAMPLES = 5;
const CONDITIONS = [
  { label: 'normal CPU', cpuSlowdown: 1 },
  // The browser runs four times slower than the runner, as on a busy laptop.
  { label: '4x CPU slowdown', cpuSlowdown: 4 },
];

// Report-only for now: no budget. Each sample must carry its evidence, and its claim request is answered
// before it sounds: a pause gives the claim back, so Play asks the server first.
test(`${CASE_ID} Pressing Play after Pause asks the server and plays the paused song on from its place, on a normal and a 4x slower processor`, { tag: '@area:playback' }, async ({
  galleryActions,
  globalPlayerActions,
  page,
  playbackEvidence,
  searchToolbarActions,
  stepLogger,
  trackModalActions,
}, testInfo) => {
  test.setTimeout(10 * 60 * 1000);
  await stepLogger.step('Open the playback-start album and play its long song', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await searchToolbarActions.search(ALBUM, { submitWithEnter: true });
    await searchToolbarActions.waitForQuery(ALBUM);
    await galleryActions.waitForAlbumVisible(ALBUM);
    await galleryActions.clickAlbumDetailsByAlbumName(ALBUM);
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toContain(`${ARTIST} • ${ALBUM}`);
    const startMark = await playbackEvidence.playbackMark();
    const track = await trackModalActions.playTrackByTitle(TITLE);
    await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
    await trackModalActions.close();
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 1 });
    const started = await playbackEvidence.waitForTrackPlaybackEvidence({ after: startMark, path: track.path });
    expect(started.nonZeroSamples, 'the song itself sounds').toBeGreaterThan(0);
    expect(started.renderedFrameDelta).toBeGreaterThan(0);
    expect((await readResumeCheckpoint(page)).duration, 'room for every sample in one song').toBeGreaterThan(60);
  });

  const claimRequests = observePlaybackClaimRequests(page);
  const cdp = await page.context().newCDPSession(page);
  const results = {};
  try {
    for (const condition of CONDITIONS) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: condition.cpuSlowdown });
      const context = { page, globalPlayerActions, playbackEvidence, claimRequests };
      const samples = [];
      for (let index = 1; index <= SAMPLES; index += 1) {
        samples.push(await stepLogger.step(`${condition.label}: Play after Pause (${index})`, async () => {
          await playOnForASecond(page, globalPlayerActions);
          await globalPlayerActions.pauseToReleasePlaybackClaim();
          return measureResumeToSound(context);
        }));
      }
      for (const sample of samples) {
        // Each resume rendered the paused song's own non-silent audio (waitForTrackPlaybackEvidence in the helper).
        expect(sample.evidence.nonZeroSamples, `${condition.label}: the resume sounds`).toBeGreaterThan(0);
        expect(sample.evidence.renderedFrameDelta).toBeGreaterThan(0);
      }
      results[condition.label] = summarizeResumeSamples(samples);
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    claimRequests.stop();
    await globalPlayerActions.pauseIfPlaying();
  }

  await testInfo.attach('play-after-pause-timing.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  for (const [label, result] of Object.entries(results)) {
    const ms = (values) => values.map((value) => Math.round(value)).join(', ');
    testInfo.annotations.push({
      type: `Play after Pause, ${label} (ms)`,
      description: `median ${Math.round(result.medianMs)} [${ms(result.pressToSoundMs)}]`,
    });
    stepLogger.note(`${label}: median ${Math.round(result.medianMs)} ms [${ms(result.pressToSoundMs)}], `
      + `claim request ${ms(result.samples.map((sample) => sample.claimRoundTripMs))} ms`, 1);
  }
});
