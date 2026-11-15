import { expect, test } from '../support/baseFixtures.js';
import { readLastfmProviderRequests } from '../helpers/lastfmProviderHelpers.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const FIRST_TITLE = 'Eager Neighbour 09';
const SECOND_TITLE = 'Medium Cold Signal 07';

test('FTC-PLAYBACK-LASTFM-010 two browsers hand off playback without duplicate paused listens', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, lastfmProviderFixture, stepLogger }, testInfo) => {
  const [first, second] = playbackOwnershipSessions;
  let baseline, providerBaseline, firstTrack, secondTrack, firstPause, secondPause, completed;
  let silentSecond, silentFirst;

  await stepLogger.step('Connect Last.fm and read existing visible playback totals', async () => {
    await first.galleryActions.goto();
    await first.galleryActions.waitForGalleryReady();
    await first.settingsModalAppBarActions.openSettings();
    await first.utilityTabBarActions.openTab('integrations');
    await first.utilityIntegrationsActions.waitForReady();
    await first.utilityIntegrationsActions.ensureLastfmConnected({
      username: 'fixture_listener', password: 'fixture-password',
    });
    baseline = await first.utilityIntegrationsActions.readPersistedPlaybackStatistics();
    await first.utilityIntegrationsActions.expectPlaybackStatistics(
      baseline.local_playcount, baseline.total_listening_seconds,
    );
    providerBaseline = await first.utilityIntegrationsActions.readLastfmSummary();
    expect((await lastfmProviderFixture.readState()).scrobble_mode).toBe('accept');
    await first.settingsModalAppBarActions.closeSettings();
    await second.galleryActions.goto();
    await second.galleryActions.waitForGalleryReady();
    for (const session of [first, second]) {
      await session.navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await session.navigationPanelActions.waitForSidebarSelection(ARTIST);
      await session.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await session.trackModalActions.waitForInteractiveSummary();
    }
    firstTrack = await first.trackModalActions.readTrackAt(17);
    secondTrack = await second.trackModalActions.readTrackAt(16);
    expect(firstTrack.title).toBe(FIRST_TITLE);
    expect(secondTrack.title).toBe(SECOND_TITLE);
    silentSecond = await second.playbackEvidence.playbackMark();
  });

  await stepLogger.step('First browser plays audible PCM; second cannot start and shows readable mirrored metadata', async () => {
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackAt(17);
    await first.trackModalActions.close();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: firstTrack.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(first.globalPlayerActions.globalPlayer.time).not.toHaveText(/^0:00\s*\//u);
    await second.trackModalActions.playTrackAt(16);
    await expect(second.globalPlayerActions.globalPlayer.blockedStartToast).toBeVisible();
    await second.trackModalActions.close();
    await second.globalPlayerActions.expectOwnershipBlocked({ artist: ARTIST, album: ALBUM, title: FIRST_TITLE });
    await expect.poll(() => first.listenJourney.scrobbles.filter(event => event.response?.entry?.scrobbled).length,
      { timeout: 60000 }).toBe(1);
    expect((await second.playbackEvidence.playbackMark()).renderedFrame).toBe(silentSecond.renderedFrame);
    expect(second.listenJourney.scrobbles).toHaveLength(0);
    expect(second.listenJourney.completions).toHaveLength(0);
    expect(second.listenJourney.nowPlaying).toHaveLength(0);
    expect((await readLastfmProviderRequests(testInfo)).filter(request => request.method === 'track.scrobble')
      .map(request => request.track)).toEqual([FIRST_TITLE]);
    firstPause = await first.globalPlayerActions.pauseAndReadListenCheckpoint();
    expect(firstPause.entry.id).toBeTruthy();
    expect(firstPause.request.session_id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
    expect(firstPause.request.clientId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
    expect(firstPause.entry.scrobbled).toBe(true);
    silentFirst = await first.playbackEvidence.playbackMark();
  });

  await stepLogger.step('Pause persists one listen; second browser takes over while first stays silent and blocked', async () => {
    await first.settingsModalAppBarActions.openSettings();
    await first.utilityTabBarActions.openTab('integrations');
    await first.utilityIntegrationsActions.waitForReady();
    await first.utilityIntegrationsActions.expectPlaybackStatistics(
      baseline.local_playcount + 1, baseline.total_listening_seconds + firstPause.entry.measured_listened_seconds,
    );
    await first.settingsModalAppBarActions.closeSettings();
    await second.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await second.trackModalActions.waitForInteractiveSummary();
    const mark = await second.playbackEvidence.playbackMark();
    await second.trackModalActions.playTrackAt(16);
    await second.trackModalActions.close();
    const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: secondTrack.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(second.globalPlayerActions.globalPlayer.time).not.toHaveText(/^0:00\s*\//u);
    await first.globalPlayerActions.expectOwnershipBlocked({ artist: ARTIST, album: ALBUM, title: SECOND_TITLE });
    await expect.poll(() => second.listenJourney.scrobbles.filter(event => event.response?.entry?.scrobbled).length,
      { timeout: 60000 }).toBe(1);
    expect((await first.playbackEvidence.playbackMark()).renderedFrame).toBe(silentFirst.renderedFrame);
    expect(first.listenJourney.scrobbles).toHaveLength(1);
    expect(first.listenJourney.completions).toHaveLength(1);
    expect(first.listenJourney.nowPlaying).toHaveLength(1);
    secondPause = await second.globalPlayerActions.pauseAndReadListenCheckpoint();
    expect(secondPause.entry.scrobbled).toBe(true);
    expect(secondPause.request.clientId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
    expect(secondPause.request.clientId).not.toBe(firstPause.request.clientId);
    silentSecond = await second.playbackEvidence.playbackMark();
  });

  await stepLogger.step('First browser resumes its same paused listen and finishes without another scrobble', async () => {
    const mark = await first.playbackEvidence.playbackMark();
    await expect(first.globalPlayerActions.globalPlayer.playButton).toBeEnabled({ timeout: 15000 });
    await expect(first.globalPlayerActions.globalPlayer.playButton).toHaveAttribute('aria-label', 'Play');
    await first.globalPlayerActions.resumeIfPaused();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: firstTrack.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await second.globalPlayerActions.expectOwnershipBlocked({ artist: ARTIST, album: ALBUM, title: FIRST_TITLE });
    await expect.poll(() => first.listenJourney.completions.filter(event => event.response?.entry?.finished_fully).length,
      { timeout: 60000 }).toBe(1);
    completed = first.listenJourney.completions.find(event => event.response?.entry?.finished_fully);
    expect(completed.status).toBe(200);
    expect(completed.response.entry.id).toBe(firstPause.entry.id);
    expect(completed.request.session_id).toBe(firstPause.request.session_id);
    expect(completed.response.entry.measured_listened_seconds).toBeGreaterThan(firstPause.entry.measured_listened_seconds);
    expect(completed.response.entry.finalized).toBe(true);
    await first.globalPlayerActions.waitForPlaybackState({ paused: true });
    expect((await second.playbackEvidence.playbackMark()).renderedFrame).toBe(silentSecond.renderedFrame);
    expect(second.listenJourney.nowPlaying).toHaveLength(1);
    await first.listenJourney.waitForStableExactJourneys({ scrobbleTitles: [FIRST_TITLE], completionTitles: [FIRST_TITLE, FIRST_TITLE] });
    await second.listenJourney.waitForStableExactJourneys({ scrobbleTitles: [SECOND_TITLE], completionTitles: [SECOND_TITLE] });
  });

  await stepLogger.step('Reload retains two visible listens and two provider submissions', async () => {
    for (const reload of [false, true]) {
      if (reload) {
        await first.galleryActions.goto();
        await first.galleryActions.waitForGalleryReady();
      }
      await first.settingsModalAppBarActions.openSettings();
      await first.utilityTabBarActions.openTab('integrations');
      await first.utilityIntegrationsActions.waitForReady();
      await first.utilityIntegrationsActions.expectPlaybackStatistics(baseline.local_playcount + 2,
        baseline.total_listening_seconds + completed.response.entry.measured_listened_seconds + secondPause.entry.measured_listened_seconds);
      await first.utilityIntegrationsActions.waitForLastfmSummary({
        scrobbled: providerBaseline.scrobbled + 2, pending: providerBaseline.pending,
        lastfmTotal: providerBaseline.lastfmTotal + 2,
      });
      await first.settingsModalAppBarActions.closeSettings();
    }
    const submissions = (await readLastfmProviderRequests(testInfo)).filter(request => request.method === 'track.scrobble');
    expect(submissions.map(request => request.track)).toEqual([FIRST_TITLE, SECOND_TITLE]);
    expect(submissions.every(request => request.signature_valid && request.api_key_valid && request.session_key_valid)).toBe(true);
  });
});
