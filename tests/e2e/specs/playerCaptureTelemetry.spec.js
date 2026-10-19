import { expect, test } from '../support/baseFixtures.js';
import { LASTFM_PLAYBACK_TARGET } from '../helpers/lastfmProviderHelpers.js';
import { PERFORMANCE_AUTH_USERNAME } from '../support/performanceAuthentication.js';
import {
  captureForPath, observePlaybackCapture, waitForCaptureAdmission,
  inspectPlaybackCapture, repeatedSourceFrames, waitForCaptureTerminal,
} from '../helpers/playbackCaptureReadHelpers.js';

// Requires the separately approved real served capture activation and migration.
// Absence is a failed prerequisite, never an injected runtime or a skipped test.
test('short audible playback survives reload as positive private capture', { tag: '@area:playback' }, async ({
  galleryActions, navigationPanelActions, trackModalActions, globalPlayerActions, page, playbackEvidence,
}) => {
  const observer = observePlaybackCapture(page);
  try {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(LASTFM_PLAYBACK_TARGET.artist);
    await navigationPanelActions.waitForSidebarSelection(LASTFM_PLAYBACK_TARGET.artist);
    await galleryActions.waitForAlbumVisibleUnderHeading(LASTFM_PLAYBACK_TARGET.artist, LASTFM_PLAYBACK_TARGET.album);
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(LASTFM_PLAYBACK_TARGET.artist, LASTFM_PLAYBACK_TARGET.album);
    await trackModalActions.waitForInteractiveSummary();
    const track = await trackModalActions.readTrackAt(0);
    expect(track.title).toBe(LASTFM_PLAYBACK_TARGET.track);
    const mark = await playbackEvidence.playbackMark();
    await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 0.5 });
    await globalPlayerActions.togglePlaybackWithSpace({ paused: true });
    const audible = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(audible.nonZeroSamples).toBeGreaterThan(0);
    expect(audible.renderedFrameDelta).toBeGreaterThan(0);
    const identity = await waitForCaptureAdmission(expect, observer, track.path);
    const before = await inspectPlaybackCapture(expect, observer, identity, PERFORMANCE_AUTH_USERNAME);
    expect(before.known_frames).toBeLessThan(10 * 48000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    const after = await inspectPlaybackCapture(expect, observer, identity, PERFORMANCE_AUTH_USERNAME);
    expect(after.known_frames).toBeGreaterThanOrEqual(before.known_frames);
    expect(after.known_frames).toBeLessThan(10 * 48000);
    expect(after.batches.slice(0, before.batches.length)).toEqual(before.batches);
  } finally {
    observer.stop();
  }
});

test('visible backward seek retains repeated consumed positions in one capture', { tag: '@area:playback' }, async ({
  galleryActions, navigationPanelActions, trackModalActions, globalPlayerActions, page, playbackEvidence,
}) => {
  const observer = observePlaybackCapture(page);
  try {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(LASTFM_PLAYBACK_TARGET.artist);
    await navigationPanelActions.waitForSidebarSelection(LASTFM_PLAYBACK_TARGET.artist);
    await galleryActions.waitForAlbumVisibleUnderHeading(LASTFM_PLAYBACK_TARGET.artist, LASTFM_PLAYBACK_TARGET.album);
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(LASTFM_PLAYBACK_TARGET.artist, LASTFM_PLAYBACK_TARGET.album);
    await trackModalActions.waitForInteractiveSummary();
    const track = await trackModalActions.readTrackAt(0);
    expect(track.title).toBe(LASTFM_PLAYBACK_TARGET.track);
    await trackModalActions.playTrackAt(0);
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 2 });
    const identity = await waitForCaptureAdmission(expect, observer, track.path);
    const mark = await playbackEvidence.playbackMark();
    await globalPlayerActions.seekToSeconds(0.5, { toleranceSeconds: 0.25 });
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 1.5 });
    const replay = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(replay.nonZeroSamples).toBeGreaterThan(0);
    expect(replay.renderedFrameDelta).toBeGreaterThan(0);
    // Visible replacement drains the old binding and freezes its terminal checkpoint.
    await trackModalActions.playTrackAt(1);
    await waitForCaptureTerminal(expect, observer, identity);
    const stored = await inspectPlaybackCapture(expect, observer, identity, PERFORMANCE_AUTH_USERNAME);
    expect(stored.terminal_reason).toBe('track_change');
    expect(captureForPath(await observer.snapshot(), track.path).body.capture_uuid).toBe(identity.body.capture_uuid);
    expect(repeatedSourceFrames(stored.runs)).toBeGreaterThan(0);
    // A new source run after the seek must move backward; endpoint subtraction
    // or a union-of-source-ranges approximation cannot satisfy the stored total.
    expect(stored.runs.some((run, index) => index > 0
      && run.source_start48 < stored.runs[index - 1].source_start48)).toBe(true);
  } finally {
    observer.stop();
  }
});
