import { expect, test } from '../support/baseFixtures.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';

const displayedSeconds = (text) => {
  const match = String(text || '').match(/^(\d+):(\d{2})/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

// Owner, 2026-11-17: "Once that message playing in another tab is shown the play button should be
// actionable, because if it would be dim it is not clear to the user that it can be pressed." Play
// takes playback over (playback.claim.takeover): the other device's song continues here from where
// it was, the other device stops and shows "Playing in another tab".
test('FTC-PLAYBACK-TAKEOVER-001 Play on the playing-elsewhere overlay continues the other device\'s song here at its place and stops the other device', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  let track;
  let heardAt = 0;

  await stepLogger.step('The first device plays a long song well past its start', async () => {
    for (const session of [first, second]) {
      await session.galleryActions.goto();
      await session.galleryActions.waitForGalleryReady();
    }
    await first.navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await first.navigationPanelActions.waitForSidebarSelection(ARTIST);
    await first.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await first.trackModalActions.waitForInteractiveSummary();
    const row = first.trackModalActions.trackModal.trackRowByTitle(TITLE);
    track = { path: String(await row.getAttribute('data-track-row-path') || '') };
    expect(track.path).not.toBe('');
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackByTitle(TITLE);
    await first.trackModalActions.close();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    const player = first.globalPlayerActions.globalPlayer;
    const bounds = await player.timeline.boundingBox();
    await player.timeline.click({ position: { x: bounds.width * 0.3, y: bounds.height / 2 } });
    await first.globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 60 });
  });

  // Owner, round 7 (2026-11-18): "Make Playing in another tab slightly golden in shade, like NOTHING
  // IS PLAYING. And increase the font size. Add hover on play button \"Play in this tab instead\"".
  await stepLogger.step('The second device shows the song under a larger golden status, and hovering Play says it plays here instead', async () => {
    await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
    const secondPlayer = second.globalPlayerActions.globalPlayer;
    const label = secondPlayer.elsewhereOverlay.getByText('Playing in another tab');
    await expect(label).toBeVisible();
    await expect(label).toHaveCSS('color', 'rgb(217, 249, 157)');
    // parity-check: allow-read-only-measurement-evaluate -- read the visible status label's rendered font size
    const fontSize = Number.parseFloat(await label.evaluate((element) => getComputedStyle(element).fontSize));
    expect(fontSize, 'larger than the 0.68rem idle label').toBeGreaterThanOrEqual(15);
    await secondPlayer.playButton.hover();
    await expect(secondPlayer.playButton).toHaveAttribute('title', 'Play in this tab instead');
  });

  await stepLogger.step('One Play press continues the song here at about its place; the first device stops', async () => {
    const firstPlayer = first.globalPlayerActions.globalPlayer;
    const secondPlayer = second.globalPlayerActions.globalPlayer;
    const mark = await second.playbackEvidence.playbackMark();
    heardAt = displayedSeconds(await firstPlayer.time.textContent());
    await secondPlayer.playButton.click();

    const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await expect(secondPlayer.elsewhereOverlay).toBeHidden();
    await expect(secondPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(secondPlayer.playButton).toHaveAttribute('title', '');
    await expect(secondPlayer.title).toContainText(TITLE);
    const startedAt = displayedSeconds(await secondPlayer.time.textContent());
    expect(startedAt, 'continues where the first device was, not from the start').toBeGreaterThanOrEqual(heardAt - 3);
    expect(startedAt).toBeLessThanOrEqual(heardAt + 15);

    // The first device hears nothing more and shows the second device's song as playing elsewhere.
    await first.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
    const silent = await first.playbackEvidence.playbackMark();
    await first.page.waitForTimeout(3000);
    expect((await first.playbackEvidence.playbackMark()).renderedFrame).toBe(silent.renderedFrame);
  });

  await stepLogger.step('The first device takes it back the same way', async () => {
    const mark = await first.playbackEvidence.playbackMark();
    await first.globalPlayerActions.globalPlayer.playButton.click();
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
  });
});

// sandbox5 (2026-11-18): closing a browser tab that was playing and pressing Play in another browser
// right after was refused (409, "Playback unavailable", then "Playing in another tab") for 15-30 s:
// the closed tab's claim waited for its reload. The owner closes playing tabs and plays elsewhere.
test('FTC-PLAYBACK-TAKEOVER-003 after a playing tab closes, one press on a song in another browser plays it within seconds', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  const OTHER_TITLE = 'Medium Cold Signal 07';
  const PLAYS_WITHIN_MS = 5000;
  const paths = {};

  await stepLogger.step('The first browser plays a song; the second has the album open', async () => {
    for (const session of [first, second]) {
      await session.galleryActions.goto();
      await session.galleryActions.waitForGalleryReady();
      await session.navigationPanelActions.selectSidebarArtistByName(ARTIST);
      await session.navigationPanelActions.waitForSidebarSelection(ARTIST);
      await session.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
      await session.trackModalActions.waitForInteractiveSummary();
    }
    for (const title of [TITLE, OTHER_TITLE]) {
      paths[title] = String(await second.trackModalActions.trackModal.trackRowByTitle(title).getAttribute('data-track-row-path') || '');
      expect(paths[title]).not.toBe('');
    }
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackByTitle(TITLE);
    const evidence = await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[TITLE] });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await first.globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
  });

  await stepLogger.step('The playing tab closes, as the owner closes it', async () => {
    const closed = first.page.waitForEvent('close');
    await first.page.close({ runBeforeUnload: true });
    await closed;
  });

  await stepLogger.step('Right after, one press on a song in the second browser plays it within seconds', async () => {
    const player = second.globalPlayerActions.globalPlayer;
    const mark = await second.playbackEvidence.playbackMark();
    const pressedAt = Date.now();
    await second.trackModalActions.playTrackByTitle(OTHER_TITLE);
    const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence(
      { after: mark, path: paths[OTHER_TITLE] }, { timeout: PLAYS_WITHIN_MS });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    expect(Date.now() - pressedAt, 'one press plays it within seconds').toBeLessThan(PLAYS_WITHIN_MS);
    await second.trackModalActions.close();
    await expect(player.elsewhereOverlay).toBeHidden();
    await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(player.title).toContainText(OTHER_TITLE);
    await expect(second.page.getByText('Playback is active in another tab.')).toHaveCount(0);
    await second.globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});

// sandbox5 r13 (2026-11-19), twice at the same step: after a song played, navigating to another artist
// and pressing Play on a song gave no audio for 30 s; the next song pressed played at once. The page
// load left the playing page's claim waiting for a reload for 15 s, and the press was refused.
test('FTC-PLAYBACK-NAV-001 play, open another artist in a new page load, and one press on a song plays it at once', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }) => {
  const OTHER_TITLE = 'Medium Cold Signal 07';
  const OTHER_ARTIST = 'Neal Morse';
  const PLAYS_WITHIN_MS = 5000;
  const openAlbum = async () => {
    await navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await navigationPanelActions.waitForSidebarSelection(ARTIST);
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await trackModalActions.waitForInteractiveSummary();
  };
  let otherPath = '';

  await stepLogger.step('A song plays', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await openAlbum();
    const path = String(await trackModalActions.trackModal.trackRowByTitle(TITLE).getAttribute('data-track-row-path') || '');
    otherPath = String(await trackModalActions.trackModal.trackRowByTitle(OTHER_TITLE).getAttribute('data-track-row-path') || '');
    const mark = await playbackEvidence.playbackMark();
    await trackModalActions.playTrackByTitle(TITLE);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await trackModalActions.close();
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
  });

  await stepLogger.step('Another artist opens in a new page load; then one press on a song plays it at once', async () => {
    const claimAnswers = [];
    const recordClaim = (response) => {
      if (new URL(response.url()).pathname === '/playback/state' && response.request().method() === 'PUT') claimAnswers.push(response.status());
    };
    page.on('response', recordClaim);
    await page.goto(`/?surface=albums&artist=${encodeURIComponent(OTHER_ARTIST)}&gallery_scope=all`);
    await galleryActions.waitForGalleryReady();
    await openAlbum();
    const mark = await playbackEvidence.playbackMark();
    const pressedAt = Date.now();
    await trackModalActions.playTrackByTitle(OTHER_TITLE);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: otherPath }, { timeout: PLAYS_WITHIN_MS });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
    expect(Date.now() - pressedAt, 'the first press plays it').toBeLessThan(PLAYS_WITHIN_MS);
    page.off('response', recordClaim);
    expect(claimAnswers.length, 'the press asked for playback').toBeGreaterThan(0);
    expect(claimAnswers.filter((status) => status !== 200), 'no claim was refused after the page load').toEqual([]);
    await trackModalActions.close();
    const player = globalPlayerActions.globalPlayer;
    await expect(player.title).toContainText(OTHER_TITLE);
    await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    await expect(page.getByText('Playback is active in another tab.')).toHaveCount(0);
    await globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});

// Owner, 2026-11-19, verbatim: "When I click play on a new song, in the player name of the song blinks
// and return to the currently playing befoire changing again to the one that I started."
test('FTC-PLAYBACK-TITLE-001 pressing another song while one plays never shows the playing song again once the pressed one shows', {
  tag: '@area:playback',
}, async ({ page, galleryActions, globalPlayerActions, navigationPanelActions, playbackEvidence, stepLogger, trackModalActions }) => {
  const OTHER_TITLE = 'Medium Cold Signal 07';
  const player = globalPlayerActions.globalPlayer;
  const paths = {};

  await stepLogger.step('A song plays', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await navigationPanelActions.selectSidebarArtistByName(ARTIST);
    await navigationPanelActions.waitForSidebarSelection(ARTIST);
    await galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await trackModalActions.waitForInteractiveSummary();
    for (const title of [TITLE, OTHER_TITLE]) {
      paths[title] = String(await trackModalActions.trackModal.trackRowByTitle(title).getAttribute('data-track-row-path') || '');
    }
    const mark = await playbackEvidence.playbackMark();
    await trackModalActions.playTrackByTitle(TITLE);
    await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[TITLE] });
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
    await expect(player.title).toContainText(TITLE);
  });

  await stepLogger.step('Read continuously from the press until the other song has played a second, the title never goes back', async () => {
    // The visible title is read back to back, a few milliseconds apart: a flicker a listener sees
    // lasts several frames, so it cannot fall between two reads.
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) samples.push(String(await player.title.textContent() || ''));
    })();
    const mark = await playbackEvidence.playbackMark();
    await trackModalActions.playTrackByTitle(OTHER_TITLE);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[OTHER_TITLE] });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    sampling = false;
    await sampler;
    expect(samples.length, 'read often enough to see a flicker').toBeGreaterThan(50);
    const firstPressed = samples.findIndex((text) => text.includes(OTHER_TITLE));
    expect(firstPressed, 'the pressed song shows').toBeGreaterThanOrEqual(0);
    expect(samples.slice(firstPressed).filter((text) => !text.includes(OTHER_TITLE)), 'never the playing song again').toEqual([]);
    await trackModalActions.close();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});
