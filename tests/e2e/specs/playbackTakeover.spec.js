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
