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
const HELD_SAMPLES = 5;
const ROUND_TRIP_SAMPLES = 3;
// Well inside the 12 s pause hold.
const HELD_PAUSE_MS = 5000;
const CONDITIONS = [
  { label: 'normal CPU', cpuSlowdown: 1 },
  // The browser runs four times slower than the runner, as on a busy laptop.
  { label: '4x CPU slowdown', cpuSlowdown: 4 },
];

// Report-only for now: no budget. Each sample must carry its evidence, a held Play may ask nothing before it
// sounds, and held must sound sooner than a Play that pays the claim round trip.
test(`${CASE_ID} Pressing Play within 12 seconds of Pause sounds sooner than pressing Play after those 12 seconds, on a normal and a 4x slower processor`, { tag: '@area:playback' }, async ({
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
    const track = await trackModalActions.playTrackByTitle(TITLE);
    await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
    await trackModalActions.close();
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 1 });
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
      for (let index = 1; index <= HELD_SAMPLES; index += 1) {
        samples.push(await stepLogger.step(`${condition.label}: Play ${HELD_PAUSE_MS / 1000} s into the pause hold (${index})`, async () => {
          await playOnForASecond(page, globalPlayerActions);
          await globalPlayerActions.pauseHoldingPlaybackClaim();
          await page.waitForTimeout(HELD_PAUSE_MS);
          return measureResumeToSound({ ...context, kind: 'held' });
        }));
      }
      for (let index = 1; index <= ROUND_TRIP_SAMPLES; index += 1) {
        samples.push(await stepLogger.step(`${condition.label}: Play after the claim was given back (${index})`, async () => {
          await playOnForASecond(page, globalPlayerActions);
          await globalPlayerActions.pauseToReleasePlaybackClaim();
          return measureResumeToSound({ ...context, kind: 'round-trip' });
        }));
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
      description: `held median ${Math.round(result.heldMedianMs)} [${ms(result.heldMs)}]; `
        + `round trip median ${Math.round(result.roundTripMedianMs)} [${ms(result.roundTripMs)}]`,
    });
    const claimRoundTrips = result.samples.filter((sample) => sample.kind === 'round-trip')
      .map((sample) => sample.claimRoundTripMs);
    stepLogger.note(`${label}: held median ${Math.round(result.heldMedianMs)} ms [${ms(result.heldMs)}]; `
      + `round trip median ${Math.round(result.roundTripMedianMs)} ms [${ms(result.roundTripMs)}], `
      + `claim request ${ms(claimRoundTrips)} ms`, 1);
  }
  for (const [label, result] of Object.entries(results)) {
    expect(result.heldMedianMs, `${label}: held Play sounds sooner than one that asks for the claim`)
      .toBeLessThan(result.roundTripMedianMs);
  }
});
