import { expect, test } from '../support/baseFixtures.js';
import { createAppearancePreferenceIsolation } from '../helpers/appearancePreferenceIsolation.js';

const ARTIST = 'Playback Start Signals';
const ALBUM = 'Length And Repetition';
const TITLE = 'Long Cold Signal';

// Every painted frame for four seconds (through the switch and the new song's first second): the player's
// title and time, whether the title names [title], and the browser's own
// timing of the press inside it (Event Timing: when the pointer went down, when the click's handlers
// ended). Start it, press, then await it.
function samplePressPaint(titleAndTimeLocator, title) {
  // parity-check: allow-read-only-measurement-evaluate -- frame-by-frame timing of the visible title after a press
  return titleAndTimeLocator.evaluateAll(([titleElement, timeElement], expected) => new Promise((resolve) => {
    const frames = [];
    const events = [];
    const started = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (['pointerdown', 'mousedown', 'click'].includes(entry.name)) {
          events.push({ name: entry.name, startTime: entry.startTime, processingEnd: entry.processingEnd });
        }
      }
    });
    observer.observe({ type: 'event', durationThreshold: 16 });
    const sample = () => {
      const text = String(titleElement.textContent || '');
      frames.push({ at: performance.now(), title: text, time: String(timeElement.textContent || ''), shows: text.includes(expected) });
      if (performance.now() - started < 4000) {
        requestAnimationFrame(sample);
        return;
      }
      observer.disconnect();
      resolve({ started, frames, events });
    };
    requestAnimationFrame(sample);
  }), title);
}

const displayedSeconds = (text) => {
  const match = String(text || '').match(/^(\d+):(\d{2})/u);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

// Once "Playing in another tab" shows, Play stays actionable: dimmed, it would not look pressable. Play
// takes playback over (playback.claim.takeover): the other device's song continues here from where
// it was, the other device stops and shows "Playing in another tab".
test('FTC-PLAYBACK-TAKEOVER-001 Play on the playing-elsewhere overlay continues the other device\'s song here at its place and stops the other device', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  const appearance = createAppearancePreferenceIsolation(second.page);
  let track;
  let heardAt = 0;
  let idleInk = '';

  try {
    await stepLogger.step('The first device plays a long song well past its start', async () => {
      for (const session of [first, second]) {
        await session.galleryActions.goto();
        await session.galleryActions.waitForGalleryReady();
      }
      // "Playing in another tab" keeps its golden tint: a player palette inked that label but not
      // "Nothing is playing"; the second device uses one.
      await appearance.capture();
      await second.settingsModalAppBarActions.openSettings();
      await second.utilityTabBarActions.openTab('appearance');
      await second.utilityAppearanceActions.waitForReady();
      await second.utilityAppearanceActions.choosePalette('harbor-mint');
      await second.utilityAppearanceActions.save();
      await second.settingsModalAppBarActions.closeSettings();
      expect((await second.utilityAppearanceActions.readAppliedStyleSnapshot()).palette).toBe('harbor-mint');
      const idle = second.globalPlayerActions.globalPlayer.timelineWrap;
      await expect(idle).toHaveAttribute('data-idle-label', 'Nothing is playing');
      // parity-check: allow-read-only-measurement-evaluate -- read the visible idle label's rendered ink (a ::after)
      idleInk = await idle.evaluate((element) => getComputedStyle(element, '::after').color);
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

    // "Playing in another tab" is slightly golden, like "Nothing is playing", and larger; Play's hover
    // says "Play in this tab instead".
    await stepLogger.step('The second device shows the song under a larger golden status, and hovering Play says it plays here instead', async () => {
      await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
      const secondPlayer = second.globalPlayerActions.globalPlayer;
      const label = secondPlayer.elsewhereOverlay.getByText('Playing in another tab');
      await expect(label).toBeVisible();
      await expect(label).toHaveCSS('color', 'rgb(217, 249, 157)');
      await expect(label, 'the same golden ink as "Nothing is playing" in the same palette').toHaveCSS('color', idleInk);
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
  } finally {
    await appearance.restore();
  }
});

// Closing a browser tab that was playing and pressing Play in another browser right after was refused
// (409, "Playback unavailable", then "Playing in another tab") for 15-30 s: the closed tab's claim
// waited for its reload. Closing a playing tab and playing elsewhere is an ordinary way to switch.
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

  await stepLogger.step('The playing tab closes', async () => {
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

// Seen twice at the same step: after a song played, navigating to another artist
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

// Pressing a new song never shows the playing song's title again before the pressed one's.
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
    // Well into the song, so its running time cannot pass for the pressed song's.
    await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 8 });
    await expect(player.title).toContainText(TITLE);
  });

  // Every part of the player switches with the title. The time is read right after each title: one
  // redraw sets both.
  await stepLogger.step('Read continuously from the press until the other song has played a second, the title never goes back and the time switches with it', async () => {
    // Title and time are read together in every painted frame: a flicker a listener sees cannot fall
    // between two reads, and neither can be read a frame later than the other.
    const mark = await playbackEvidence.playbackMark();
    const pressPaint = samplePressPaint(player.titleAndTime, OTHER_TITLE);
    await trackModalActions.playTrackByTitle(OTHER_TITLE);
    const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[OTHER_TITLE] });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    const { frames } = await pressPaint;
    const samples = frames.map(({ title, time }) => ({ title, seconds: displayedSeconds(time) }));
    // The title changes when the pressed song sounds, not at the press.
    expect(frames.find(({ shows }) => shows), 'the pressed title is painted').toBeTruthy();
    expect(samples.length, 'read often enough to see a flicker').toBeGreaterThan(50);
    const firstPressed = samples.findIndex(({ title }) => title.includes(OTHER_TITLE));
    expect(firstPressed, 'the pressed song shows').toBeGreaterThanOrEqual(0);
    expect(samples.slice(firstPressed).filter(({ title }) => !title.includes(OTHER_TITLE)), 'never the playing song again').toEqual([]);
    // From its first frame the pressed song shows its own time, from its start: never the old song's
    // running time (8 s and more) under the new title.
    expect(samples.slice(firstPressed).filter(({ seconds }) => !(seconds < 5)), 'the time switches with the title').toEqual([]);
    await trackModalActions.close();
    await globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});

// A browser that closed without a word (a crash, a killed process) kept its claim,
// and the first press in another browser started the song and stopped it 6 ms later on the refusal.
// A holder that stopped renewing gives way: the press plays, with no stop and no refused claim.
test('FTC-PLAYBACK-TAKEOVER-004 after a playing browser closes without a word, the first press in another browser plays the song and never stops it', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  const OTHER_TITLE = 'Medium Cold Signal 07';
  // The server takes a browser that has not renewed for 10 s as gone.
  const SILENT_HOLDER_MS = 11_000;
  const paths = {};
  let closedAt = 0;

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
    }
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackByTitle(TITLE);
    await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[TITLE] });
    await first.globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: 3 });
  });

  await stepLogger.step('The first browser closes without a word, as a crash does', async () => {
    await first.page.context().close();
    closedAt = Date.now();
  });

  await stepLogger.step('Once the closed browser has gone silent, one press in the other browser plays the song and keeps playing', async () => {
    const page = second.page;
    const player = second.globalPlayerActions.globalPlayer;
    const refused = [];
    const record = (response) => {
      if (new URL(response.url()).pathname === '/playback/state' && response.request().method() === 'PUT'
          && response.status() !== 200) refused.push(response.status());
    };
    page.on('response', record);
    await page.waitForTimeout(Math.max(0, SILENT_HOLDER_MS - (Date.now() - closedAt)));
    const mark = await second.playbackEvidence.playbackMark();
    await second.trackModalActions.playTrackByTitle(OTHER_TITLE);
    const evidence = await second.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[OTHER_TITLE] }, { timeout: 8000 });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    await second.trackModalActions.close();
    // It keeps playing: a late refusal would stop it.
    for (let read = 0; read < 6; read += 1) {
      await page.waitForTimeout(500);
      await expect(player.playButton).toHaveAttribute('aria-label', 'Pause');
    }
    const still = await second.playbackEvidence.playbackMark();
    await page.waitForTimeout(1000);
    expect((await second.playbackEvidence.playbackMark()).renderedFrame, 'still sounding').toBeGreaterThan(still.renderedFrame);
    page.off('response', record);
    expect(refused, 'no claim was refused').toEqual([]);
    await expect(player.elsewhereOverlay).toBeHidden();
    await second.globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});

// The same press while the other browser really plays: it never starts and stops; the player shows
// "Playing in another tab" at once, with Play here, and the other browser plays on.
test('FTC-PLAYBACK-TAKEOVER-005 while another browser really plays, a press on a song shows the playing-elsewhere overlay at once and never starts the song here', {
  tag: '@area:playback',
}, async ({ playbackOwnershipSessions, stepLogger }) => {
  const [first, second] = playbackOwnershipSessions;
  const OTHER_TITLE = 'Medium Cold Signal 07';
  const paths = {};

  await stepLogger.step('The first browser plays a song; the second shows it playing elsewhere', async () => {
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
    }
    const mark = await first.playbackEvidence.playbackMark();
    await first.trackModalActions.playTrackByTitle(TITLE);
    await first.playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: paths[TITLE] });
    await first.trackModalActions.close();
    await second.trackModalActions.close();
    await second.globalPlayerActions.expectPlayingElsewhereOverlay({ artist: ARTIST, album: ALBUM, title: TITLE });
  });

  await stepLogger.step('One press on another song: the overlay stays with Play here, nothing sounds here, the first browser plays on', async () => {
    const player = second.globalPlayerActions.globalPlayer;
    await second.galleryActions.clickAlbumDetailsByArtistAndAlbum(ARTIST, ALBUM);
    await second.trackModalActions.waitForInteractiveSummary();
    const silentFrom = await second.playbackEvidence.playbackMark();
    const firstFrom = await first.playbackEvidence.playbackMark();
    await second.trackModalActions.playTrackByTitle(OTHER_TITLE);
    await second.trackModalActions.close();
    await expect(player.elsewhereOverlay).toBeVisible({ timeout: 2000 });
    await expect(player.playButton).toHaveAttribute('aria-label', 'Play here');
    await second.page.waitForTimeout(3000);
    expect((await second.playbackEvidence.playbackMark()).renderedFrame, 'nothing started here').toBe(silentFrom.renderedFrame);
    expect((await first.playbackEvidence.playbackMark()).renderedFrame, 'the first browser plays on')
      .toBeGreaterThan(firstFrom.renderedFrame);
    await first.globalPlayerActions.pauseToReleasePlaybackClaim();
  });
});
