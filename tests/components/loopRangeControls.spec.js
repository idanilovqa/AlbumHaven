const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const loopRangeControlsPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'js',
  'runtime',
  'loop-range-controls.js',
);
const componentOrigin = 'http://127.0.0.1:4399';

async function mountLoopControlsPage(page) {
  await page.route(`${componentOrigin}/loop-editing-controls`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html>
        <head>
          <style>
            body { margin: 40px; background: #111827; color: white; }
            #range { position: relative; width: 400px; height: 80px; }
            [data-loop-range-surface] { position: absolute; inset: 0; }
            [data-loop-range-handle] {
              position: absolute;
              top: 0;
              width: 16px;
              height: 80px;
              transform: translateX(-8px);
            }
            canvas { width: 400px; height: 80px; }
          </style>
        </head>
        <body>
          <div id="action-host"></div>
          <div id="range" data-loop-range-owner="component">
            <div data-loop-range-surface>
              <canvas data-loop-range-waveform width="400" height="80"></canvas>
              <div data-loop-range-handle="start" role="slider" aria-label="Loop start" tabindex="0"></div>
              <div data-loop-range-handle="end" role="slider" aria-label="Loop end" tabindex="0"></div>
            </div>
            <output data-loop-range-time="start"></output>
            <output data-loop-range-time="end"></output>
          </div>
        </body>
      </html>`,
  }));
  await page.goto(`${componentOrigin}/loop-editing-controls`);
  await page.evaluate(() => {
    window.formatLoopTime = (seconds) => `time:${Number(seconds).toFixed(3)}`;
    window.state = {
      player: {
        appearance: {
          waveformFillColor: '#16a34a',
          waveformEdgeColor: '#f97316',
        },
      },
    };
  });
  await page.addScriptTag({ path: loopRangeControlsPath });
}

test.beforeEach(async ({ page }) => {
  await mountLoopControlsPage(page);
});

test('shared loop action preserves disabled, busy, focus, and callback contracts', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.getElementById('action-host');
    host.innerHTML = buildLoopEditActionControl({
      ownerId: 'track\"<&',
      enterLabel: 'Edit <loop>',
      createLabel: 'Create loop',
      cancelLabel: 'Cancel loop creation',
    });
    const root = host.querySelector('[data-loop-action-owner]');
    window.actionEvents = [];
    window.actionController = mountLoopEditActionControl({
      root,
      enabled: false,
      disabledLabel: 'Start playback first',
      onEnter: () => {
        window.actionEvents.push('enter');
        window.actionController.update({ active: true });
      },
      onCreate: () => window.actionEvents.push('create'),
      onCancel: () => {
        window.actionEvents.push('cancel');
        window.actionController.update({ active: false });
      },
    });
  });

  const root = page.locator('[data-loop-action-owner]');
  const enter = page.getByRole('button', { name: 'Edit <loop>', exact: true });
  const create = page.getByRole('button', { name: 'Create loop', exact: true });
  const cancel = page.getByRole('button', { name: 'Cancel loop creation', exact: true });

  await expect(root).toHaveAttribute('data-loop-action-owner', 'track"<&');
  await expect(root).toHaveAttribute('data-loop-action-state', 'disabled');
  await expect(enter).toBeDisabled();
  await expect(enter).toHaveAttribute('title', 'Start playback first');

  await page.evaluate(() => window.actionController.update({ enabled: true }));
  await enter.click();
  await expect(root).toHaveAttribute('data-loop-action-state', 'editing');
  await expect(enter).toBeHidden();
  await expect(create).toBeVisible();
  await expect(cancel).toBeVisible();

  await create.focus();
  await expect(create).toBeFocused();
  await expect(root).toHaveAttribute('data-loop-action-engaged', 'true');
  await page.mouse.move(470, 620);
  await expect(root).toHaveAttribute('data-loop-action-engaged', 'true');

  await page.evaluate(() => window.actionController.update({ busy: true }));
  await expect(create).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(root).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.actionController.update({ busy: false }));
  await create.click();
  await cancel.click();
  await expect(root).toHaveAttribute('data-loop-action-state', 'idle');
  await expect(enter).toBeVisible();
  expect(await page.evaluate(() => window.actionEvents)).toEqual(['enter', 'create', 'cancel']);

  await page.evaluate(() => window.actionController.destroy());
  await enter.click();
  expect(await page.evaluate(() => window.actionEvents)).toEqual(['enter', 'create', 'cancel']);
});

test('range control separates surface seeking from dragging and supports handle crossing', async ({ page }) => {
  await page.evaluate(() => {
    window.rangeEvents = { previews: [], commits: [], seeks: [], cancels: 0 };
    window.rangeController = createLoopRangeController({
      root: document.getElementById('range'),
      getDuration: () => 10,
      getRange: () => ({ startSeconds: 2, endSeconds: 8 }),
      onRangePreview: (range) => window.rangeEvents.previews.push(range),
      onRangeCommit: (range) => window.rangeEvents.commits.push(range),
      onSeek: (seconds) => window.rangeEvents.seeks.push(seconds),
      onCancel: () => { window.rangeEvents.cancels += 1; },
    });
  });

  const surface = page.locator('[data-loop-range-surface]');
  const start = page.getByRole('slider', { name: 'Loop start', exact: true });
  const end = page.getByRole('slider', { name: 'Loop end', exact: true });
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  await page.mouse.click(
    surfaceBox.x + (surfaceBox.width * 0.5),
    surfaceBox.y + (surfaceBox.height * 0.5),
  );
  const afterSeek = await page.evaluate(() => ({
    events: window.rangeEvents,
    range: window.rangeController.getRange(),
  }));
  expect(afterSeek.events.seeks).toHaveLength(1);
  expect(afterSeek.events.seeks[0]).toBeCloseTo(5, 1);
  expect(afterSeek.events.commits).toEqual([]);
  expect(afterSeek.range).toEqual({ startSeconds: 2, endSeconds: 8 });

  await page.mouse.move(
    surfaceBox.x + (surfaceBox.width * 0.6),
    surfaceBox.y + (surfaceBox.height * 0.5),
  );
  await page.mouse.down();
  await page.mouse.move(
    surfaceBox.x + (surfaceBox.width * 0.6) + 2,
    surfaceBox.y + (surfaceBox.height * 0.5),
  );
  await page.mouse.up();
  const afterJitter = await page.evaluate(() => ({
    events: window.rangeEvents,
    range: window.rangeController.getRange(),
  }));
  expect(afterJitter.events.seeks).toHaveLength(2);
  expect(afterJitter.events.seeks[1]).toBeCloseTo(6, 1);
  expect(afterJitter.events.commits).toEqual([]);
  expect(afterJitter.range).toEqual({ startSeconds: 2, endSeconds: 8 });

  await page.mouse.move(
    surfaceBox.x + (surfaceBox.width * 0.25),
    surfaceBox.y + (surfaceBox.height * 0.5),
  );
  await page.mouse.down();
  await page.mouse.move(
    surfaceBox.x + (surfaceBox.width * 0.4),
    surfaceBox.y + (surfaceBox.height * 0.5),
    { steps: 6 },
  );
  await page.mouse.up();
  const afterSurfaceDrag = await page.evaluate(() => ({
    events: window.rangeEvents,
    range: window.rangeController.getRange(),
  }));
  expect(afterSurfaceDrag.events.seeks).toHaveLength(2);
  expect(afterSurfaceDrag.events.commits).toEqual([{ startSeconds: 4, endSeconds: 8 }]);
  expect(afterSurfaceDrag.range).toEqual({ startSeconds: 4, endSeconds: 8 });

  const startBox = await start.boundingBox();
  expect(startBox).not.toBeNull();
  await page.mouse.move(startBox.x + (startBox.width / 2), startBox.y + (startBox.height / 2));
  await page.mouse.down();
  await page.mouse.move(
    surfaceBox.x + (surfaceBox.width * 0.9),
    surfaceBox.y + (surfaceBox.height / 2),
    { steps: 8 },
  );
  await page.mouse.up();

  await expect(start).toHaveAttribute('aria-valuenow', '8');
  await expect(end).toHaveAttribute('aria-valuenow', '9');
  await expect(page.locator('#range')).toHaveAttribute('data-loop-range-front', 'end');
  const afterDrag = await page.evaluate(() => ({
    events: window.rangeEvents,
    range: window.rangeController.getRange(),
  }));
  expect(afterDrag.events.seeks).toHaveLength(2);
  expect(afterDrag.events.previews.length).toBeGreaterThan(0);
  expect(afterDrag.events.commits).toEqual([
    { startSeconds: 4, endSeconds: 8 },
    { startSeconds: 8, endSeconds: 9 },
  ]);
  expect(afterDrag.range).toEqual({ startSeconds: 8, endSeconds: 9 });
});

test('range keyboard controls commit precise steps, cancel once, and expose formatted values', async ({ page }) => {
  await page.evaluate(() => {
    window.rangeEvents = { previews: [], commits: [], seeks: [], cancels: 0 };
    window.rangeController = createLoopRangeController({
      root: document.getElementById('range'),
      getDuration: () => 10,
      getRange: () => ({ startSeconds: 2, endSeconds: 8 }),
      onRangePreview: (range) => window.rangeEvents.previews.push(range),
      onRangeCommit: (range) => window.rangeEvents.commits.push(range),
      onSeek: (seconds) => window.rangeEvents.seeks.push(seconds),
      onCancel: () => { window.rangeEvents.cancels += 1; },
    });
  });

  const start = page.getByRole('slider', { name: 'Loop start', exact: true });
  await start.focus();
  await start.press('ArrowRight');
  await start.press('Shift+ArrowRight');
  await expect(start).toHaveAttribute('aria-valuenow', '2.55');
  await expect(start).toHaveAttribute('aria-valuetext', 'Loop start time:2.550');
  await expect(page.locator('[data-loop-range-time="start"]')).toHaveText('time:2.550');
  await start.press('Escape');

  const events = await page.evaluate(() => window.rangeEvents);
  expect(events.previews).toEqual([
    { startSeconds: 2.05, endSeconds: 8 },
    { startSeconds: 2.55, endSeconds: 8 },
  ]);
  expect(events.commits).toEqual(events.previews);
  expect(events.cancels).toBe(1);
});

test('combined waveform paints both channels and a full-height progress marker', async ({ page }) => {
  const evidence = await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-loop-range-waveform]');
    drawCombinedLoopWaveform(canvas, {
      left: [0.2, 0.8, 0.4, 1],
      right: [0.6, 0.1, 0.9, 0.3],
    }, 0.5);
    const context = canvas.getContext('2d');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const midpoint = Math.floor(canvas.height / 2);
    const playheadX = Math.round(canvas.width * 0.5);
    let upperPixels = 0;
    let lowerPixels = 0;
    let playheadRows = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[((y * canvas.width + x) * 4) + 3] === 0) continue;
        if (y < midpoint) upperPixels += 1;
        if (y > midpoint) lowerPixels += 1;
      }
      if (pixels[((y * canvas.width + playheadX) * 4) + 3] > 0) playheadRows += 1;
    }
    return { upperPixels, lowerPixels, playheadRows, height: canvas.height };
  });

  expect(evidence.upperPixels).toBeGreaterThan(0);
  expect(evidence.lowerPixels).toBeGreaterThan(0);
  expect(evidence.playheadRows / evidence.height).toBeGreaterThan(0.9);
});
