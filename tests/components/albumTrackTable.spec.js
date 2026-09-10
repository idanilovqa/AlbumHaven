const path = require('node:path');
const { test, expect } = require('@playwright/test');

const repositoryRoot = path.join(__dirname, '..', '..');
const baseLayoutCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'base-layout.css',
);
const albumTrackTableCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'album-track-table.css',
);
const compactDataTableCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'compact-data-table.css',
);
const albumDetailsComponentsCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'album-details-components.css',
);
const trackModalCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'runtime',
  'track-modal-and-lightbox.css',
);
const buttonComponentCssPath = path.join(
  repositoryRoot,
  'music_app',
  'static',
  'css',
  'button-component.css',
);
const componentUrl = 'http://album-track-table-component.test/album-track-table';
const detailsComponentUrl = 'http://album-track-table-component.test/album-details';

async function mountAlbumTrackTable(page) {
  await page.route(componentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html>
        <head>
          <style>
            :root {
              --appearance-play: #34ca78;
              --appearance-player-accent: #55c7ff;
              --accent: #60a5fa;
              --appearance-card: #101a29;
              --appearance-ink: #f8fafc;
            }
            body { margin: 40px; background: #080d16; }
          </style>
        </head>
        <body>
          <div class="album-track-table">
            <button
              class="play-track-button album-track-table__play"
              type="button"
              aria-label="Play track"
            >
              <span aria-hidden="true">▶</span>
            </button>
          </div>
        </body>
      </html>`,
  }));

  await page.goto(componentUrl);
  await page.addStyleTag({ path: baseLayoutCssPath });
  await page.addStyleTag({ path: albumTrackTableCssPath });
}

async function mountAlbumDetailsComponents(page) {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.route(detailsComponentUrl, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
      <html>
        <head>
          <style>
            :root {
              --appearance-interaction-outline: #72baff;
              --appearance-waveform-edge: #55c7ff;
              --appearance-accent: #55c7ff;
              --appearance-line: #526172;
              --appearance-control: #182231;
              --appearance-hover: #293a50;
              --appearance-card: #101a29;
              --appearance-ink: #f3f6fa;
              --appearance-muted: #9aa9bc;
              --panel: #101a29;
              --text: #f3f6fa;
              --muted: #9aa9bc;
              --border: #526172;
            }
            * { box-sizing: border-box; }
            body { margin: 0; padding: 32px; background: #080d16; color: var(--text); font: 14px Arial, sans-serif; }
            .track-modal-cover { min-height: 360px; border-radius: 10px; background: #182231; }
            .play-track-button { width: 28px; height: 28px; border: 1px solid #748399; border-radius: 50%; background: transparent; color: white; }
          </style>
        </head>
        <body>
          <div class="track-modal-dialog">
            <header class="track-modal-header">
              <div class="album-details-header" data-album-details-layout="editorial_canvas">
                <div class="album-details-header__identity">
                  <h2 id="album-title" class="album-details-header__primary">The Whirlwind</h2>
                  <div class="album-details-header__secondary">Transatlantic · 2009 · ALBUM</div>
                </div>
                <div class="album-details-header__actions">
                  <button class="ui-button ui-button--icon action-button" type="button" aria-label="Edit album tags"><span class="action-button__content">◇</span></button>
                  <button class="ui-button ui-button--icon action-button" type="button" aria-label="Open album folder"><span class="action-button__content">□</span></button>
                  <button class="ui-button ui-button--icon action-button" type="button" aria-label="Close"><span class="action-button__content">×</span></button>
                </div>
              </div>
            </header>
            <div class="track-modal-body">
              <div class="track-modal-cover" aria-hidden="true"></div>
              <main class="track-modal-main"><div class="track-modal-list" id="table-host"></div></main>
            </div>
          </div>
        </body>
      </html>`,
  }));

  await page.goto(detailsComponentUrl);
  for (const cssPath of [
    baseLayoutCssPath,
    buttonComponentCssPath,
    compactDataTableCssPath,
    albumTrackTableCssPath,
    albumDetailsComponentsCssPath,
    trackModalCssPath,
  ]) await page.addStyleTag({ path: cssPath });
  await page.addScriptTag({
    content: `function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }`,
  });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'js', 'runtime', 'compact-data-table.js') });
  await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app', 'static', 'js', 'runtime', 'album-track-table.js') });
  await page.locator('#table-host').evaluate((host) => {
    host.innerHTML = buildAlbumTrackTableHtml({
      groups: [{ discNumber: 1, tracks: [
        { path: 'one.flac', title: 'Overture', trackNumber: 1, duration: '8:11' },
        { path: 'two.flac', title: 'Heart Like a Whirlwind', trackNumber: 2, duration: '5:11', isProblematic: true },
        { path: 'three.flac', title: 'Higher Than the Morning', trackNumber: 3, duration: '5:29' },
        { path: 'four.flac', title: 'The Darkness in the Light', trackNumber: 4, duration: '5:43' },
        { path: 'five.flac', title: 'Swing High, Swing Low', trackNumber: 5, duration: '3:48' },
      ] }],
      totalLength: '2h 14m',
    });
  });
}

for (const width of [960, 390]) {
  test(`explicit bonus duration summaries remain visible in the shared frame at ${width}px`, async ({ page }, testInfo) => {
    await mountAlbumDetailsComponents(page);
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#table-host').evaluate((host) => {
      host.innerHTML = buildAlbumTrackTableHtml({
        groups: [
          { discNumber: 1, discLabel: 'CD 1', isBonus: false, tracks: [{ path: 'main', title: 'Main track', duration: '3:00' }] },
          { discNumber: 2, discLabel: 'Bonus Disc', isBonus: true, tracks: [{ path: 'bonus', title: 'Bonus track', duration: '22:30' }] },
        ],
        totalLength: '25m 30s', mainLength: '3:00', bonusLength: '22:30',
      });
    });
    const frame = page.locator('.album-track-table__frame');
    for (const text of ['Total Length: 25m 30s', 'Total Main Album Length: 3:00', 'Bonus Disc Length: 22:30']) {
      const summary = frame.getByText(text, { exact: true });
      await expect(summary).toBeVisible();
      const bounds = await summary.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const textBox = range.getBoundingClientRect();
        const frameBox = element.closest('.album-track-table__frame').getBoundingClientRect();
        return { left: textBox.left, right: textBox.right, frameLeft: frameBox.left, frameRight: frameBox.right };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(bounds.frameLeft);
      expect(bounds.right).toBeLessThanOrEqual(bounds.frameRight);
      const masks = await summary.evaluate(element => {
        const values = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          values.push(getComputedStyle(ancestor).maskImage);
          if (ancestor.classList.contains('album-track-table__frame')) break;
        }
        return values;
      });
      expect(masks.every(mask => mask === 'none')).toBe(true);
    }
    const decoration = await frame.locator('.album-track-table__total').evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return { mask: style.maskImage, pointerEvents: style.pointerEvents };
    });
    expect(decoration.mask).toContain('linear-gradient');
    expect(decoration.pointerEvents).toBe('none');
    await expect(frame.getByRole('table')).toHaveCount(2);
    await expect(frame.locator('.compact-data-table-header')).toHaveCount(1);
    await expect(frame.getByRole('heading')).toHaveText(['Bonus Disc']);
    await frame.screenshot({ path: testInfo.outputPath('duration-summaries.png') });
  });
}

for (const scenario of [
  { setting: false, motion: 'no-preference' },
  { setting: true, motion: 'reduce' },
  { setting: false, motion: 'reduce' },
  { setting: true, motion: 'no-preference' },
]) {
  test(`playing motion independently honors setting ${scenario.setting} and OS ${scenario.motion}`, async ({ page }) => {
    await mountAlbumDetailsComponents(page);
    await page.emulateMedia({ reducedMotion: scenario.motion });
    await page.locator('#table-host').evaluate((host, setting) => {
      host.innerHTML = buildAlbumTrackTableHtml({
        groups: [{ tracks: [{ path: 'playing', title: 'Playing track', isCurrent: true, isPlaying: true }] }],
        playingAnimation: setting,
      });
    }, scenario.setting);
    const row = page.locator('.album-track-table__row');
    await expect(row).toHaveClass(/album-track-table__row--playing/);
    await expect(row).toHaveCSS('outline-style', 'solid');
    await expect(row).toHaveCSS('outline-width', '1px');
    const spectra = await row.evaluate(element => ['::before', '::after'].map(pseudo => {
      const style = getComputedStyle(element, pseudo);
      return { animation: style.animationName, display: style.display, opacity: style.opacity };
    }));
    for (const spectrum of spectra) {
      if (scenario.setting && scenario.motion === 'no-preference') {
        expect(spectrum.animation).toContain('album-track-perimeter-spectrum');
      } else {
        if (scenario.motion === 'reduce') expect(spectrum.display).toBe('none');
        else {
          expect(spectrum.animation).toBe('none');
          expect(spectrum.opacity).toBe('0');
        }
      }
    }
    if (!scenario.setting || scenario.motion === 'reduce') {
      expect(await row.evaluate(element => element.getAnimations({ subtree: true })
        .filter(animation => animation.playState === 'running').length)).toBe(0);
    }
  });
}

test('long album track titles preserve all five usable columns inside a narrow dialog', async ({ page }) => {
  await mountAlbumDetailsComponents(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.locator('[data-track-row-path="two.flac"]');
  await row.locator('.album-track-table__title').evaluate(element => { element.textContent = 'A very long album track title that must yield to the duration and problem controls '.repeat(4); });
  const table = page.getByRole('table', { name: /Album tracks/ });
  const dialog = page.locator('.track-modal-dialog');
  const [tableBox, dialogBox, rowBox] = await Promise.all([table.boundingBox(), dialog.boundingBox(), row.boundingBox()]);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
  await expect(row.locator('[role="cell"]')).toHaveCount(5);
  for (const name of ['Play track', 'Open this track in Problematic Files']) {
    const button = row.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
    await button.click();
  }
  const duration = await row.locator('[data-cdt-column="duration"]').boundingBox();
  expect(duration.x + duration.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
  const title = row.locator('.album-track-table__title');
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
});

test('search-match hover retains its accent treatment through the table cascade', async ({ page }) => {
  await mountAlbumDetailsComponents(page);
  const row = page.locator('[data-track-row-path="two.flac"]');
  await row.evaluate(element => {
    element.classList.add('album-track-table__row--search-match');
    const expected = document.createElement('div');
    expected.id = 'expected-match-hover';
    expected.style.background = 'color-mix(in srgb, var(--album-track-accent) 15%, transparent)';
    element.parentElement.appendChild(expected);
  });
  const expected = await page.locator('#expected-match-hover').evaluate(element => getComputedStyle(element).backgroundColor);
  await row.hover();
  await expect(row).toHaveCSS('background-color', expected);
});

test('per-track Play hover uses the player Play color without shifting layout', async ({ page }) => {
  await mountAlbumTrackTable(page);

  const playButton = page.getByRole('button', { name: 'Play track', exact: true });
  await expect(playButton).toBeVisible();
  await expect(playButton).toHaveCSS('outline-style', 'none');

  const beforeHoverBox = await playButton.boundingBox();
  expect(beforeHoverBox).not.toBeNull();

  await playButton.hover();

  await expect(playButton).toHaveCSS('outline-style', 'solid');
  await expect(playButton).toHaveCSS('outline-width', '2px');
  await expect(playButton).toHaveCSS('outline-offset', '2px');
  await expect(playButton).toHaveCSS('outline-color', 'rgb(52, 202, 120)');

  const afterHoverBox = await playButton.boundingBox();
  expect(afterHoverBox).toEqual(beforeHoverBox);
});

test('ActionButton hover and keyboard focus share the same outline without shifting layout', async ({ page }) => {
  await mountAlbumDetailsComponents(page);

  const action = page.getByRole('button', { name: 'Edit album tags', exact: true });
  const restingBox = await action.boundingBox();
  expect(restingBox).not.toBeNull();

  await action.hover();
  await expect(action).toHaveCSS('outline-width', '2px');
  await expect(action).toHaveCSS('outline-color', 'rgb(114, 186, 255)');
  const hoverOutline = await action.evaluate((element) => getComputedStyle(element).outlineColor);
  expect(await action.boundingBox()).toEqual(restingBox);

  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await expect(action).toHaveCSS('outline-width', '2px');
  await expect(action).toHaveCSS('outline-color', hoverOutline);
  expect(await action.boundingBox()).toEqual(restingBox);
});

test('problem status uses a hidden header track immediately before Length', async ({ page }) => {
  await mountAlbumDetailsComponents(page);

  const table = page.getByRole('table', { name: /Album tracks/ });
  const problemHeader = table.locator('[data-cdt-column="problem"][aria-hidden="true"]');
  const problemRow = table.locator('[data-cdt-row-key="two.flac"]');
  const cleanRow = table.locator('[data-cdt-row-key="one.flac"]');
  const problemCell = problemRow.locator('[data-cdt-column="problem"]');
  const problemButton = problemCell.getByRole('button', { name: 'Open this track in Problematic Files', exact: true });
  const problemDuration = problemRow.locator('[data-cdt-column="duration"]');
  const cleanDuration = cleanRow.locator('[data-cdt-column="duration"]');

  await expect(problemHeader).toHaveCount(1);
  await expect(table.getByRole('columnheader', { name: 'Problem' })).toHaveCount(0);
  await expect(problemButton).toBeVisible();
  const [problemBox, durationBox, cleanDurationBox] = await Promise.all([
    problemCell.boundingBox(),
    problemDuration.boundingBox(),
    cleanDuration.boundingBox(),
  ]);
  expect(problemBox).not.toBeNull();
  expect(durationBox).not.toBeNull();
  expect(cleanDurationBox).not.toBeNull();
  expect(problemBox.x + problemBox.width).toBeLessThanOrEqual(durationBox.x);
  expect(durationBox.x).toBeCloseTo(cleanDurationBox.x, 1);
});

test('Editorial table aligns left while its final 1px outline fades into the original footer', async ({ page }) => {
  await mountAlbumDetailsComponents(page);

  const title = page.getByRole('heading', { name: 'The Whirlwind', exact: true });
  const table = page.getByRole('table', { name: /Album tracks/ });
  const total = page.locator('.album-track-table__total');
  const [titleBox, tableBox] = await Promise.all([title.boundingBox(), table.boundingBox()]);
  expect(titleBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(tableBox.x).toBeCloseTo(titleBox.x, 1);

  const edge = await table.evaluate((element) => {
    const tableEdge = getComputedStyle(element, '::after');
    return {
      width: tableEdge.width,
      right: tableEdge.right,
      backgroundImage: tableEdge.backgroundImage,
    };
  });
  expect(edge.width).toBe('1px');
  expect(edge.right).toBe('-1px');
  expect(edge.backgroundImage).toContain('linear-gradient');
  expect(edge.backgroundImage).toContain('/ 0.75)');
  await expect(total).toHaveCSS('border-right-width', '1px');
  expect(await total.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
});
