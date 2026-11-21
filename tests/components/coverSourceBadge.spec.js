const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const runtimeSource = fs.readFileSync(path.join(staticRoot, 'js/runtime/cover-lookup-modal-and-drawer.js'), 'utf8');
// The CoverSourceBadge component, exactly as the runtime ships it.
const badgeSource = runtimeSource.slice(
  runtimeSource.indexOf('// CoverSourceBadge:'),
  runtimeSource.indexOf('function coverLookupHasManualLinks()'),
);

const solidImage = (hex) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${hex}"/></svg>`,
).toString('base64')}`;

async function mount(page, { theme = 'dark' } = {}) {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.setContent(`<!doctype html><html data-appearance-mode="${theme}"><body style="margin:24px">
    <div id="root"></div></body></html>`);
  for (const css of ['css/runtime/base-layout.css', 'css/runtime/track-modal-and-lightbox.css', 'css/runtime/cover-lookup-modal.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, css) });
  }
  await page.addScriptTag({
    content: `const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    ${badgeSource}
    window.cardClicks = 0;
    document.addEventListener('click', (event) => {
      if (handleCoverSourceBadgeClick(event)) return;
      if (event.target.closest('[data-select-remote-cover]')) window.cardClicks += 1;
    });
    document.addEventListener('keydown', (event) => handleCoverSourceBadgeKeyDown(event));
    window.renderAlbumDetails = (source, imageUrl, context = {}) => {
      const badge = buildTrackModalCoverSourceBadge(source, context);
      const beneath = badge.includes('cover-source-badge--beneath');
      document.getElementById('root').innerHTML = \`<div class="track-modal-cover" style="width:260px">
        <div class="track-modal-cover-shell"><span class="track-modal-cover-visual" style="display:block;width:260px;height:260px">
          <img src="\${imageUrl}" alt="cover" style="width:260px;height:260px;display:block"></span>\${beneath ? '' : badge}</div>
        \${beneath ? \`<div class="track-modal-cover-source-beneath">\${badge}</div>\` : ''}</div>\`;
      return new Promise((resolve) => {
        const image = document.querySelector('.track-modal-cover-visual img');
        const done = () => { applyCoverSourceBadgeTone(document.getElementById('root')); resolve(); };
        if (image.complete) done(); else image.addEventListener('load', done, { once: true });
      });
    };
    window.renderCard = (source) => {
      document.getElementById('root').innerHTML = \`<div class="cover-lookup-art-card" role="button" tabindex="0" data-select-remote-cover="1" style="width:180px">
        <span class="cover-lookup-art-meta"><span class="cover-lookup-art-source-row">\${buildCoverSourceBadgeHtml({
          source, placement: 'inline', albumUrl: 'https://open.spotify.com/album/fixture' })}<span class="cover-lookup-art-source">\${getRemoteCoverSourceLabel(source)}</span></span></span></div>\`;
    };`,
  });
}

test('an over-art badge is the bare mark on the cover corner and shows its legal line and link on hover', async ({ page }) => {
  await mount(page);
  await page.evaluate((image) => window.renderAlbumDetails('apple', image, {
    albumUrl: 'https://music.apple.com/us/album/fixture/1', artist: 'A', album: 'B',
  }), solidImage('#335577'));
  const badge = page.locator('.cover-source-badge--over.is-apple');
  const trigger = badge.locator('.cover-source-badge__trigger');
  const popover = badge.locator('.cover-source-badge__popover');
  await expect(badge).toHaveCSS('opacity', '0');
  await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(trigger).toHaveCSS('border-top-width', '0px');

  await page.locator('.track-modal-cover-shell').hover({ position: { x: 200, y: 200 } });
  await expect(badge).toHaveCSS('opacity', '1');
  const cover = await page.locator('.track-modal-cover-visual').boundingBox();
  const mark = await badge.locator('.cover-source-badge__mark').boundingBox();
  expect(mark.width).toBe(24);
  expect(mark.x - cover.x).toBeCloseTo(10, 0);
  expect(mark.y - cover.y).toBeCloseTo(10, 0);
  await expect(popover).toBeHidden();

  await trigger.hover();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Cover art from Apple Music.');
  await expect(popover).toContainText('Apple and Apple Music are trademarks of Apple Inc.');
  const link = popover.locator('a');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', 'https://music.apple.com/us/album/fixture/1');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveText('Listen on Apple Music ↗');
});

for (const [where, source] of [['over the art', 'apple'], ['beneath the art', 'spotify']]) {
  test(`the pointer can travel from the ${where} icon onto its popover and click the link`, async ({ page, context }) => {
    await context.route('https://**/*', (route) => route.fulfill({ contentType: 'text/html', body: 'release page' }));
    await mount(page);
    await page.evaluate(([image, provider]) => window.renderAlbumDetails(provider, image, {
      albumUrl: `https://example.test/${provider}/release/1`,
    }), [solidImage('#335577'), source]);
    const badge = page.locator(`.cover-source-badge.is-${source}`);
    const popover = badge.locator('.cover-source-badge__popover');
    const link = popover.locator('.cover-source-badge__link');
    const mark = await badge.locator('.cover-source-badge__mark').boundingBox();
    await page.mouse.move(mark.x + (mark.width / 2), mark.y + (mark.height / 2));
    await expect(popover).toBeVisible();
    const target = await link.boundingBox();
    const box = await popover.boundingBox();
    // Resting in the gap between icon and popover, longer than the close delay, keeps it open.
    await page.mouse.move(mark.x + (mark.width / 2), (mark.y + mark.height + box.y) / 2);
    await page.waitForTimeout(600);
    await expect(popover).toBeVisible();
    // Straight down onto the popover, then across to the link.
    await page.mouse.move(mark.x + (mark.width / 2), target.y + (target.height / 2), { steps: 12 });
    await page.mouse.move(target.x + (target.width / 2), target.y + (target.height / 2), { steps: 8 });
    await expect(popover).toBeVisible();
    const [releasePage] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await releasePage.waitForLoadState();
    expect(releasePage.url()).toBe(`https://example.test/${source}/release/1`);
  });
}

test('the popover waits briefly after the pointer leaves, stays open with focus inside, and Escape closes it', async ({ page }) => {
  await mount(page);
  await page.evaluate((image) => window.renderAlbumDetails('apple', image), solidImage('#335577'));
  const badge = page.locator('.cover-source-badge.is-apple');
  const popover = badge.locator('.cover-source-badge__popover');
  await badge.locator('.cover-source-badge__trigger').hover();
  await expect(popover).toBeVisible();
  // Freeze the closing transitions the moment the browser starts them, so the check reads the popover at
  // fixed points on the transition timeline instead of racing the wall clock.
  await popover.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    window.coverSourceBadgeClosing = new Promise((resolve) => {
      element.addEventListener('transitionrun', () => {
        const transitions = element.getAnimations();
        transitions.forEach((animation) => animation.pause());
        resolve(transitions.length);
      }, { once: true });
    });
  });
  await page.mouse.move(860, 740);
  expect(await page.evaluate(() => window.coverSourceBadgeClosing)).toBeGreaterThan(0);
  const at = (ms) => popover.evaluate((element, time) => {
    element.getAnimations().forEach((animation) => { animation.currentTime = time; });
    const style = getComputedStyle(element);
    return { visibility: style.visibility, opacity: Number(style.opacity) };
  }, ms);
  expect(await at(240)).toEqual({ visibility: 'visible', opacity: 1 });
  expect((await at(390)).visibility).toBe('hidden');
  await popover.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()));
  await expect(popover).toBeHidden();

  await badge.locator('.cover-source-badge__trigger').focus();
  await page.keyboard.press('Tab');
  await expect(popover.locator('.cover-source-badge__link')).toBeFocused();
  await expect(popover).toBeVisible();
  await badge.locator('.cover-source-badge__trigger').click();
  await expect(badge).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(badge).not.toHaveClass(/is-open/);
});

test('Spotify sits centred beneath the cover, never on it', async ({ page }) => {
  await mount(page);
  await page.evaluate((image) => window.renderAlbumDetails('spotify', image, { artist: '10cc', album: 'Sheet Music' }), solidImage('#ddaa22'));
  const badge = page.locator('.cover-source-badge.is-spotify');
  await expect(badge).toHaveClass(/cover-source-badge--beneath/);
  await expect(badge).toBeVisible();
  const cover = await page.locator('.track-modal-cover-visual').boundingBox();
  const mark = await badge.locator('.cover-source-badge__mark').boundingBox();
  expect(mark.y).toBeGreaterThanOrEqual(cover.y + cover.height);
  expect(mark.x + (mark.width / 2)).toBeCloseTo(cover.x + (cover.width / 2), 0);
  await badge.locator('.cover-source-badge__trigger').focus();
  await expect(badge.locator('.cover-source-badge__link'))
    .toHaveAttribute('href', 'https://open.spotify.com/search/10cc%20Sheet%20Music');
  const popover = await badge.locator('.cover-source-badge__popover').boundingBox();
  expect(popover.y).toBeGreaterThan(mark.y + mark.height);
});

for (const [hex, tone, filter] of [['#f5efe2', 'light', 'none'], ['#14151a', 'dark', 'invert(1)']]) {
  test(`the Discogs record over a ${tone} cover is ${filter === 'none' ? 'black' : 'white'}`, async ({ page }) => {
    await mount(page);
    await page.evaluate((image) => window.renderAlbumDetails('discogs', image), solidImage(hex));
    const badge = page.locator('.cover-source-badge--over.is-discogs');
    await expect(badge).toHaveAttribute('data-cover-source-tone', tone);
    await expect(badge.locator('img')).toHaveCSS('filter', filter);
  });
}

for (const [theme, filter] of [['light', 'none'], ['dark', 'invert(1)']]) {
  test(`a Discogs card badge is ${filter === 'none' ? 'black' : 'white'} in the ${theme} theme`, async ({ page }) => {
    await mount(page, { theme });
    await page.evaluate(() => window.renderCard('discogs'));
    await expect(page.locator('.cover-source-badge.is-discogs img')).toHaveCSS('filter', filter);
  });
}

test('a tap on a card badge opens its popover without selecting the card; Escape and a tap elsewhere close it', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.renderCard('spotify'));
  await expect(page.locator('.cover-lookup-art-source')).toHaveText('SPOTIFY');
  const badge = page.locator('.cover-source-badge--inline');
  const popover = badge.locator('.cover-source-badge__popover');
  await badge.locator('.cover-source-badge__trigger').click();
  await page.mouse.move(800, 700);
  await expect(popover).toBeVisible();
  await expect(badge.locator('.cover-source-badge__trigger')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.cardClicks)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(badge).not.toHaveClass(/is-open/);
  await badge.locator('.cover-source-badge__trigger').click();
  await page.mouse.click(800, 700);
  await expect(badge).not.toHaveClass(/is-open/);

  await page.locator('.cover-lookup-art-card').click({ position: { x: 150, y: 5 } });
  expect(await page.evaluate(() => window.cardClicks)).toBe(1);
});

test('the popover follows the content palette in light and dark themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await mount(page, { theme });
    await page.evaluate(() => window.renderCard('genius'));
    const badge = page.locator('.cover-source-badge.is-genius');
    await expect(badge).toHaveClass(/is-neutral/);
    await badge.locator('.cover-source-badge__trigger').focus();
    const popover = badge.locator('.cover-source-badge__popover');
    await expect(popover).toBeVisible();
    const colors = await popover.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(colors.background).not.toBe(colors.color);
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
  }
});
