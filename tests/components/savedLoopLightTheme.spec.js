const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const componentUrl = 'http://saved-loop-component.test/loop';

async function mount(page, mode) {
  await page.route(componentUrl, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html data-appearance-mode="${mode}" data-appearance-palette="fixture">
        <body>
          <section class="utility-loop-entry is-active" draggable="true">
            <div class="utility-loop-heading">
              <span class="utility-loop-drag-handle">⋮⋮</span>
              <h3 class="utility-detail-title">Chorus loop</h3>
              <span class="utility-loop-original-times"><span>Original timestamps</span><strong>0:42 – 1:08</strong></span>
            </div>
            <div class="utility-loop-shell">
              <div class="utility-loop-main">
                <div class="utility-loop-player-top-row">
                  <div class="utility-loop-control utility-loop-pitch-control">
                    <button type="button">−</button><span>0 pst</span><button type="button">+</button>
                  </div>
                  <div class="utility-loop-time">0:06 / 0:26</div>
                </div>
                <div class="utility-loop-timeline-wrap">
                  <input class="utility-loop-timeline" type="range" min="0" max="100" value="24">
                <div class="loop-range-surface" hidden>
                    <div class="loop-range-selection"></div>
                    <button class="loop-range-handle is-start" type="button"></button>
                    <button class="loop-range-handle is-end" type="button"></button>
                  </div>
                </div>
              </div>
              <button class="utility-loop-repeat" type="button">↻</button>
              <div class="utility-loop-speed-control">
                <button class="utility-loop-speed-step" type="button">−</button>
                <button class="utility-loop-speed-value" type="button">1x</button>
                <button class="utility-loop-speed-step" type="button">+</button>
              </div>
            </div>
          </section>
        </body>
      </html>`,
  }));
  await page.goto(componentUrl);
  await page.locator(':root').evaluate((root) => {
    const tokens = {
      '--appearance-ink': '#202124',
      '--appearance-muted': '#505762',
      '--appearance-card': '#ffffff',
      '--appearance-control': '#eceff2',
      '--appearance-line': '#b8bdc5',
      '--appearance-play': '#4bc173',
      '--appearance-play-ink': '#10201a',
      '--appearance-waveform-fill': '#dadde2',
      '--appearance-waveform-edge': '#494950',
    };
    Object.entries(tokens).forEach(([name, value]) => root.style.setProperty(name, value));
  });
  for (const file of [
    'css/runtime/base-layout.css',
    'css/runtime/non-album-and-player.css',
    'css/runtime/utilities.css',
    'css/appearance-backgrounds.css',
  ]) await page.addStyleTag({ path: path.join(staticRoot, file) });
}

function rgbChannels(value) {
  const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number);
  return value.startsWith('color(srgb ') ? channels.map(channel => channel * 255) : channels;
}

function relativeLuminance(value) {
  const channels = rgbChannels(value).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrast(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('light themes give saved-loop cards a neutral readable surface and unboxed pitch controls', async ({ page }) => {
  await mount(page, 'light');

  const colors = await page.locator('.utility-loop-entry').evaluate((entry) => {
    const read = (selector, pseudo = null) => {
      const style = getComputedStyle(entry.querySelector(selector), pseudo);
      return { background: style.backgroundColor, color: style.color, border: style.borderColor };
    };
    const style = getComputedStyle(entry);
    return {
      card: { background: style.backgroundColor, border: style.borderColor },
      title: read('.utility-detail-title'),
      time: read('.utility-loop-time'),
      timeline: read('.utility-loop-timeline-wrap'),
      repeat: read('.utility-loop-repeat'),
      speed: read('.utility-loop-speed-value'),
      pitch: read('.utility-loop-pitch-control button'),
      handleBackground: getComputedStyle(entry.querySelector('.loop-range-handle'), '::after').backgroundImage,
    };
  });

  expect(colors.card.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(relativeLuminance(colors.card.background)).toBeGreaterThan(0.6);
  expect(contrast(colors.title.color, colors.card.background)).toBeGreaterThanOrEqual(7);
  expect(contrast(colors.time.color, colors.card.background)).toBeGreaterThanOrEqual(4.5);
  expect(colors.timeline.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(relativeLuminance(colors.timeline.background)).toBeGreaterThan(0.4);
  expect(colors.pitch.background).toBe('rgba(0, 0, 0, 0)');
  expect(colors.repeat.color).toBe('rgb(75, 193, 115)');
  for (const control of [colors.speed]) {
    expect(contrast(control.color, control.background)).toBeGreaterThanOrEqual(4.5);
    expect(control.border).not.toBe(colors.card.background);
  }
  expect(colors.handleBackground).not.toBe('none');
});

test('dark themes use translucent accent controls', async ({ page }) => {
  await mount(page, 'dark');

  await expect(page.locator('.utility-loop-speed-value')).toHaveCSS('background-color', 'color(srgb 0.294118 0.756863 0.45098 / 0.14)');
});

for (const theme of ['light', 'charcoal', 'black']) {
  test(`four saved loops preserve clear gaps in ${theme}`, async ({ page }) => {
    await mount(page, theme === 'light' ? 'light' : 'dark');
    await page.setViewportSize({ width: 1100, height: 850 });
    for (const file of ['css/button-component.css', 'css/runtime/trigger-anchor.css']) {
      await page.addStyleTag({ path: path.join(staticRoot, file) });
    }
    for (const file of ['js/button-component.js', 'js/runtime/loop-range-controls.js', 'js/runtime/playback-control-cluster.js']) {
      await page.addScriptTag({ path: path.join(staticRoot, file) });
    }
    await page.evaluate(theme => {
      const root = document.documentElement;
      const dark = theme !== 'light';
      const pageColor = theme === 'black' ? '#111111' : dark ? '#191c1f' : '#ffffff';
      // The Loops panel can differ from both the page and card palette surfaces.
      root.style.setProperty('--appearance-main-surface', '#000000');
      root.style.setProperty('--appearance-panel-background', pageColor);
      if (dark) {
        root.style.setProperty('--appearance-card', theme === 'black' ? '#050706' : '#222728');
        root.style.setProperty('--appearance-ink', '#edf0f4');
        root.style.setProperty('--appearance-muted', '#aab4bd');
        root.style.setProperty('--appearance-line', '#35423d');
      }
      document.body.style.cssText = `margin:0;padding:32px;background:${pageColor}`;
      const entry = document.querySelector('.utility-loop-entry');
      entry.querySelector('.utility-loop-heading').insertAdjacentHTML('beforeend',
        ButtonComponent.renderActionButton({ icon: 'delete', semantic: 'destructive', ariaLabel: 'Delete loop', className: 'utility-loop-remove' }));
      entry.querySelector('.utility-loop-shell').insertAdjacentHTML('afterbegin',
        renderPlaybackControlCluster({ variant: 'saved-loop', ownerId: 'saved:fixture', loopId: 'fixture', loopControlStyle: 'capsule' }));
      const list = document.createElement('div');
      list.className = 'utility-loop-entry-list';
      entry.replaceWith(list);
      for (const title of ['Intro', 'Main riff', 'Chorus', 'Solo']) {
        const card = entry.cloneNode(true);
        card.querySelector('.utility-detail-title').textContent = `Through The Never · ${title}`;
        list.append(card);
      }
    }, theme);
    await expect(page.locator('.utility-loop-entry')).toHaveCount(4);
    if (theme !== 'light') {
      await page.locator(':root').evaluate(root => {
        root.setAttribute('data-appearance-player', 'fixture');
        root.style.setProperty('--appearance-player', '#123127');
        root.style.setProperty('--appearance-player-ink', '#e2f5eb');
        root.style.setProperty('--appearance-waveform-edge', '#88cca9');
      });
      const cluster = page.locator('.utility-loop-play-cluster').first();
      const surface = await cluster.evaluate(element => {
        const style = getComputedStyle(element, '::before');
        return { background: style.backgroundColor, border: style.borderTopColor };
      });
      expect(surface.background).toBe('rgb(18, 49, 39)');
      expect(surface.border).toBe('rgb(136, 204, 169)');
    }
    if (theme !== 'light') {
      await expect(page.locator('.utility-loop-entry').first()).toHaveCSS('background-color', theme === 'black' ? 'rgb(17, 17, 17)' : 'rgb(25, 28, 31)');
    }
    await expect(page.locator('.utility-loop-remove').first()).toHaveClass(/action-button--destructive/);
    await expect(page.locator('.loop-play-control-button').first()).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.utility-loop-timeline-wrap').first()).toHaveCSS('height', '44px');
    await expect(page.locator('.utility-loop-timeline-wrap').first()).toHaveCSS('border-top-width', '0px');
    await expect(page.locator('.utility-loop-repeat').first()).toHaveCSS('color', 'rgb(75, 193, 115)');
    const playBox = await page.locator('.loop-play-control-button').first().boundingBox();
    expect(playBox.width).toBeLessThan(40);
    const screenshot = await page.screenshot();
    const gaps = await page.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const cards = [...document.querySelectorAll('.utility-loop-entry')].map(card => card.getBoundingClientRect());
      return cards.slice(0, -1).map((card, index) => {
        const next = cards[index + 1];
        const y = Math.floor((card.bottom + next.top) / 2);
        return { gap: next.top - card.bottom, pixels: [0.1, 0.5, 0.9].map(fraction =>
          [...context.getImageData(Math.floor(card.left + card.width * fraction), y, 1, 1).data]) };
      });
    }, screenshot.toString('base64'));
    for (const row of gaps) {
      expect(row.gap).toBe(12);
      if (theme === 'black') for (const pixel of row.pixels) expect(pixel).toEqual([17, 17, 17, 255]);
    }
    await page.locator('.utility-loop-timeline-wrap').first().evaluate(element => element.classList.add('is-stereo-waveform'));
    await expect(page.locator('.utility-loop-timeline').first()).toHaveCSS('height', '44px');
  });
}
