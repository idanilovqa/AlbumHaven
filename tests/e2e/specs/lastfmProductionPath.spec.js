import { expect, test } from '../support/baseFixtures.js';
import {
  LASTFM_CONSECUTIVE_PLAYBACK_TRACKS,
  LASTFM_PLAYBACK_TARGET,
  readLastfmProviderRequests,
} from '../helpers/index.js';

const CASE_ID = 'FTC-PLAYBACK-LASTFM-013';
const LASTFM_USER = 'fixture_listener';
const LASTFM_PASSWORD = 'fixture-password';
const SCROBBLE_TRACK = LASTFM_PLAYBACK_TARGET.track;
const FORBIDDEN_HISTORY_VALUES = [
  LASTFM_USER,
  LASTFM_PASSWORD,
  'album-haven-e2e-api-key',
  'album-haven-e2e-api-secret',
  'album-haven-e2e-session-key',
  'api_sig',
  '<lfm',
];

test(`${CASE_ID} production UI connects and scrobbles through the signed Last.fm provider path`, async ({
  galleryActions,
  navigationPanelActions,
  playbackEvidence,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityIntegrationsActions,
  utilityLogHistoryActions,
  utilityTabBarActions,
}, testInfo) => {
  let initialHistoryCount = 0;
  let failedConnectionHistoryId = '';
  await stepLogger.step('Open the real Utilities integration view backed by isolated Postgres', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('log-history');
    await utilityLogHistoryActions.waitForReady();
    initialHistoryCount = (await utilityLogHistoryActions.readSummary()).itemCount;
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
  });

  await stepLogger.step('Reject invalid Last.fm credentials through the production authentication route', async () => {
    const rejected = await utilityIntegrationsActions.submitRejectedLastfmConnection({
      username: LASTFM_USER,
      password: 'not-the-fixture-password',
    });
    expect(rejected.error).toContain('Invalid username or password');
  });

  await stepLogger.step('Persist the credential-safe connection failure in this browser', async () => {
    await utilityTabBarActions.openTab('log-history');
    await utilityLogHistoryActions.waitForReady();
    await utilityLogHistoryActions.waitForItemCount(initialHistoryCount + 1);
    failedConnectionHistoryId = await utilityLogHistoryActions.selectEntryByAction(
      'Last.fm connection failed',
    );
    expect(failedConnectionHistoryId).not.toBe('');
    const historyText = await utilityLogHistoryActions.readVisibleHistoryText();
    expect(historyText).toContain('Last.fm connection failed');
    expect(historyText).toContain('Last.fm');
    expect(historyText).toContain('Invalid username or password.');
    expect(historyText).toContain('This browser');
    for (const forbiddenValue of FORBIDDEN_HISTORY_VALUES) {
      expect(historyText).not.toContain(forbiddenValue);
    }
    const stored = await utilityLogHistoryActions.readBrowserStoredEntry(failedConnectionHistoryId);
    expect(stored.databaseVersion).toBe(1);
    expect(stored.entry).toMatchObject({
      id: failedConnectionHistoryId,
      action: 'Last.fm connection failed',
      source: 'this_browser',
      source_label: 'This browser',
    });
  });

  await stepLogger.step('Reload, reopen browser history, and export the retained entry', async () => {
    await utilityLogHistoryActions.reloadBrowserPage();
    await galleryActions.waitForGalleryReady();
    const retainedBeforeReopen = await utilityLogHistoryActions.readBrowserStoredEntry(
      failedConnectionHistoryId,
    );
    expect(retainedBeforeReopen.databaseVersion).toBe(1);
    expect(retainedBeforeReopen.entry).toMatchObject({
      id: failedConnectionHistoryId,
      action: 'Last.fm connection failed',
      source: 'this_browser',
      source_label: 'This browser',
    });

    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('log-history');
    await utilityLogHistoryActions.waitForReady();
    await utilityLogHistoryActions.waitForItemCount(initialHistoryCount + 1);
    await utilityLogHistoryActions.selectEntryByAction('Last.fm connection failed');
    expect(await utilityLogHistoryActions.readVisibleHistoryText()).toContain('This browser');

    const exported = await utilityLogHistoryActions.exportLogs();
    expect(exported.suggestedFilename).toMatch(/^album-haven-log-history-.+\.json$/);
    expect(exported.document).toMatchObject({
      schema: 'album-haven-log-history',
      version: 1,
      sources: [{ id: 'this_browser', label: 'This browser' }],
    });
    expect(exported.document.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: failedConnectionHistoryId,
        action: 'Last.fm connection failed',
        source: 'this_browser',
        source_label: 'This browser',
      }),
    ]));
    for (const forbiddenValue of FORBIDDEN_HISTORY_VALUES) {
      expect(exported.text).not.toContain(forbiddenValue);
    }

    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
  });

  await stepLogger.step('Connect the fixture account through the production UI and verify visible status', async () => {
    await utilityIntegrationsActions.connectLastfm({
      username: LASTFM_USER,
      password: LASTFM_PASSWORD,
    });
    await utilityIntegrationsActions.waitForScrobbledCount(0);
    await settingsModalAppBarActions.closeSettings();
  });

  await stepLogger.step('Reload the production app and verify the connected account persisted in Postgres', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await utilityIntegrationsActions.waitForConnectedAs(LASTFM_USER);
    await utilityIntegrationsActions.waitForScrobbledCount(0);
    await settingsModalAppBarActions.closeSettings();
  });

  let playbackJourney;
  await stepLogger.step('Play the short fixture track until the production player scrobbles and persists completion', async () => {
    await navigationPanelActions.selectSidebarArtistByName(LASTFM_PLAYBACK_TARGET.artist);
    await navigationPanelActions.waitForSidebarSelection(LASTFM_PLAYBACK_TARGET.artist);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      LASTFM_PLAYBACK_TARGET.artist,
      LASTFM_PLAYBACK_TARGET.album,
    );
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(
      LASTFM_PLAYBACK_TARGET.artist,
      LASTFM_PLAYBACK_TARGET.album,
    );
    const summary = await trackModalActions.waitForInteractiveSummary();
    expect(summary.title).toContain(LASTFM_PLAYBACK_TARGET.artist);
    expect(summary.title).toContain(LASTFM_PLAYBACK_TARGET.album);
    expect(summary.title).toContain(String(LASTFM_PLAYBACK_TARGET.year));
    expect(await trackModalActions.readTrackAt(0)).toMatchObject({
      title: SCROBBLE_TRACK,
    });
    const playbackMark = await playbackEvidence.playbackMark();
    const playbackEvidencePromise = playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: (await trackModalActions.readTrackAt(0)).path,
    });
    playbackJourney = await trackModalActions.playTrackAtAndWaitForLastfmJourney(0, {
      title: SCROBBLE_TRACK,
    });
    const evidence = await playbackEvidencePromise;
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    expect(playbackJourney.scrobble.accepted).toBe(1);
    expect(playbackJourney.completion.entry.scrobbled).toBe(true);
  });

  await stepLogger.step('Read the persisted scrobble count through the same production integration UI', async () => {
    await trackModalActions.close();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await utilityIntegrationsActions.waitForScrobbledCount(1);
  });

  await stepLogger.step('Verify the loopback provider received valid signed production requests', async () => {
    const requests = await readLastfmProviderRequests(testInfo);
    const authenticationRequests = requests.filter((request) => request.method === 'auth.getMobileSession');
    const nowPlayingRequests = requests.filter((request) => (
      request.method === 'track.updateNowPlaying' && request.track === SCROBBLE_TRACK
    ));
    const scrobbleRequests = requests.filter((request) => (
      request.method === 'track.scrobble' && request.track === SCROBBLE_TRACK
    ));
    expect(authenticationRequests).toHaveLength(2);
    expect(authenticationRequests.every((request) => request.signature_valid && request.api_key_valid)).toBe(true);
    expect(nowPlayingRequests).toHaveLength(1);
    expect(nowPlayingRequests[0]).toMatchObject({
      signature_valid: true,
      api_key_valid: true,
      session_key_valid: true,
      track: SCROBBLE_TRACK,
    });
    expect(scrobbleRequests).toHaveLength(1);
    expect(scrobbleRequests[0]).toMatchObject({
      signature_valid: true,
      api_key_valid: true,
      session_key_valid: true,
      track: SCROBBLE_TRACK,
      chosen_by_user: '1',
    });
    expect(Number(scrobbleRequests[0].timestamp)).toBeGreaterThan(0);
    expect(Number(scrobbleRequests[0].duration)).toBeGreaterThan(10);
    expect(playbackJourney.track.title).toBe(SCROBBLE_TRACK);
  });
});

test('FTC-PLAYBACK-LASTFM-016 consecutive tracks each scrobble exactly once in order', async ({
  galleryActions,
  navigationPanelActions,
  playbackEvidence,
  settingsModalAppBarActions,
  stepLogger,
  trackModalActions,
  utilityIntegrationsActions,
  utilityTabBarActions,
}, testInfo) => {
  let providerRequestBaseline = 0;

  await stepLogger.step('Ensure the isolated Postgres app is connected to the loopback Last.fm provider', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await utilityIntegrationsActions.ensureLastfmConnected({
      username: LASTFM_USER,
      password: LASTFM_PASSWORD,
    });
    await settingsModalAppBarActions.closeSettings();
    providerRequestBaseline = (await readLastfmProviderRequests(testInfo)).length;
  });

  let journeys;
  await stepLogger.step('Play three consecutive generated tracks through the production queue', async () => {
    await navigationPanelActions.selectSidebarArtistByName(LASTFM_PLAYBACK_TARGET.artist);
    await navigationPanelActions.waitForSidebarSelection(LASTFM_PLAYBACK_TARGET.artist);
    await galleryActions.waitForAlbumVisibleUnderHeading(
      LASTFM_PLAYBACK_TARGET.artist,
      LASTFM_PLAYBACK_TARGET.album,
    );
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(
      LASTFM_PLAYBACK_TARGET.artist,
      LASTFM_PLAYBACK_TARGET.album,
    );
    await trackModalActions.waitForInteractiveSummary();
    const tracks = await Promise.all(LASTFM_CONSECUTIVE_PLAYBACK_TRACKS.map(
      (_title, offset) => trackModalActions.readTrackAt(offset),
    ));
    const playbackMark = await playbackEvidence.playbackMark();
    const evidencePromises = tracks.map((track) => playbackEvidence.waitForTrackPlaybackEvidence({
      after: playbackMark,
      path: track.path,
    }));
    journeys = await trackModalActions.playTrackAtAndWaitForConsecutiveLastfmJourneys(
      0,
      LASTFM_CONSECUTIVE_PLAYBACK_TRACKS,
    );
    const evidence = await Promise.all(evidencePromises);
    expect(evidence.map((entry) => entry.path)).toEqual(tracks.map((track) => track.path));
    expect(evidence.every((entry) => entry.nonZeroSamples > 0)).toBe(true);
    expect(evidence.every((entry) => entry.renderedFrameDelta > 0)).toBe(true);
    expect(journeys.scrobbles.map((event) => event.request.title)).toEqual(
      LASTFM_CONSECUTIVE_PLAYBACK_TRACKS,
    );
    expect(journeys.completions.map((event) => event.request.title)).toEqual(
      LASTFM_CONSECUTIVE_PLAYBACK_TRACKS,
    );
    expect(journeys.completions).toHaveLength(LASTFM_CONSECUTIVE_PLAYBACK_TRACKS.length);
    const scrobbleStartedAt = journeys.scrobbles.map(
      (event) => String(event.request.started_at || '').trim(),
    );
    const completionStartedAt = journeys.completions.map(
      (event) => String(event.request.started_at || '').trim(),
    );
    expect(completionStartedAt.every((startedAt) => startedAt.length > 0)).toBe(true);
    expect(new Set(completionStartedAt).size).toBe(LASTFM_CONSECUTIVE_PLAYBACK_TRACKS.length);
    expect(completionStartedAt).toEqual(scrobbleStartedAt);
  });

  await stepLogger.step('Verify the provider recorded one signed scrobble for each track in exact order', async () => {
    const requests = (await readLastfmProviderRequests(testInfo)).slice(providerRequestBaseline);
    const scrobbles = requests.filter((request) => request.method === 'track.scrobble');
    expect(scrobbles.map((request) => request.track)).toEqual(
      LASTFM_CONSECUTIVE_PLAYBACK_TRACKS,
    );
    expect(scrobbles).toHaveLength(LASTFM_CONSECUTIVE_PLAYBACK_TRACKS.length);
    expect(scrobbles.every((request) => (
      request.signature_valid
      && request.api_key_valid
      && request.session_key_valid
      && request.chosen_by_user === '1'
      && Number(request.timestamp) > 0
    ))).toBe(true);
    expect(new Set(scrobbles.map((request) => request.timestamp)).size).toBe(
      LASTFM_CONSECUTIVE_PLAYBACK_TRACKS.length,
    );
  });
});
