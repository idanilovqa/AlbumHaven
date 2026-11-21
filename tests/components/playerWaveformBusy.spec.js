// The server builds one waveform at a time and answers 429 meanwhile. The shipped peak loader and
// waveform drawing must keep waiting out a busy builder for the current track and then draw it.
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const componentUrl = 'http://player-component.test/player';
const trackPath = 'C:/Music/Fixture/02 Current.flac';
const busyMs = 3000;

function peakPayload(sampleCount = 720) {
  return {
    sampleCount,
    left: Array.from({ length: sampleCount }, (_, index) => 0.3 + ((index % 9) / 20)),
    right: Array.from({ length: sampleCount }, (_, index) => 0.25 + ((index % 7) / 20)),
  };
}

async function mountWaveformPlayer(page) {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><body>
      <div class="global-player" data-player-view="waveform">
        <div class="player-timeline-wrap"><input id="player-timeline" type="range">
          <canvas id="player-waveform-canvas" width="900" height="56" style="width:900px;height:56px"></canvas>
        </div>
      </div></body></html>`,
  }));
  await page.goto(componentUrl);
  await page.evaluate(({ current }) => {
    window.state = {
      player: {
        current: { path: current },
        loopActive: false,
        streaming: { generation: 7 },
        appearance: { seekbarMode: 'waveform', waveformFillColor: '#7cbaa4', waveformEdgeColor: '#d9f99d' },
        waveform: { renderToken: 0, compactPeaks: null },
      },
    };
    window.getStreamingPlaybackSnapshot = () => ({ generation: 7, duration: 200, currentTime: 0 });
  }, { current: trackPath });
  for (const file of ['player-waveform-peaks.js', 'player-and-waveform.js']) {
    await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime', file) });
  }
}

async function drawnPixelCount(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('player-waveform-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let drawn = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) drawn += 1;
    return drawn;
  });
}

test('the current track draws its waveform after another build keeps the server busy for 3 s', async ({ page }) => {
  let busyUntil = 0;
  const answers = [];
  await page.route('**/playback/waveform?*', route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('path')).toBe(trackPath);
    busyUntil ||= Date.now() + busyMs;
    if (Date.now() < busyUntil) {
      answers.push(429);
      return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"waveform peak job already active"}' });
    }
    answers.push(200);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(peakPayload(Number(url.searchParams.get('bins')))) });
  });
  await mountWaveformPlayer(page);
  expect(await drawnPixelCount(page)).toBe(0);

  await page.evaluate(({ current }) => handleStreamingPlaybackWaveformReady({ generation: 7, currentPath: current }), { current: trackPath });

  expect(answers.filter(status => status === 429).length).toBeGreaterThan(5);
  expect(answers.at(-1)).toBe(200);
  await expect.poll(() => page.evaluate(() => state.player.waveform.compactPeaks?.data?.left?.length)).toBe(720);
  expect(await drawnPixelCount(page)).toBeGreaterThan(1000);
});

test('a busy wait stops asking once the player moves to another track', async ({ page }) => {
  let requests = 0;
  await page.route('**/playback/waveform?*', route => {
    requests += 1;
    return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"waveform peak job already active"}' });
  });
  await mountWaveformPlayer(page);

  const pending = page.evaluate(({ current }) => handleStreamingPlaybackWaveformReady({ generation: 7, currentPath: current }), { current: trackPath });
  await expect.poll(() => requests).toBeGreaterThan(5);
  await page.evaluate(() => { state.player.streaming.generation = 8; });
  await pending;
  const settled = requests;
  await page.waitForTimeout(2500);

  expect(requests).toBe(settled);
  expect(await drawnPixelCount(page)).toBe(0);
});
