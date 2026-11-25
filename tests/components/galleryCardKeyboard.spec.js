const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');
const TITLES = ['First Album', 'Second Album', 'Third Album'];

// Three production cards that carry every hover control: Hoard, New Arrivals and the duplicate warning.
async function mountCards(page, displayMode) {
  const url = 'http://gallery-card-keyboard.test/';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html data-appearance-mode="dark" data-library-source-icons="true">
    <body style="margin:20px;--panel:#203040;--text:#fff;--muted:#888;--border:#64748b">
      <button id="before-gallery">Before</button>
      <main class="album-row" style="display:grid;grid-template-columns:repeat(3, 200px);gap:12px"></main>
      <button id="after-gallery">After</button>
    </body></html>` }));
  await page.goto(url);
  for (const file of ['runtime/non-album-and-player.css', 'runtime/album-artbox-and-gallery-card.css', 'gallery-main.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: 'function escapeHtml(value) { return String(value ?? ""); }' });
  for (const file of ['gallery-main-components.js', 'gallery-card-component.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(({ titles, displayMode }) => {
    document.querySelector('main').innerHTML = titles.map((title, index) => buildGalleryCardHtml({
      identity: `card-${index}`, renderKey: `card-${index}`, albumKey: `album-${index}`,
      title, artist: 'Artist', year: '2026', trackCount: 2, lengthDisplay: '4m', displayMode,
      sourceCategories: ['main', 'hoard', 'new_arrivals'], hasDuplicateFiles: true,
      artboxHtml: '<span class="album-artbox album-artbox--ready">Album artwork</span>',
    })).join('');
    // The app's own delegated entry points: activation opens the tracklist, contextmenu opens actions.
    window.opened = [];
    window.contextMenus = [];
    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-open-tracklist="1"]');
      if (trigger) opened.push(trigger.getAttribute('data-album-key'));
    });
    document.addEventListener('contextmenu', event => {
      const card = event.target.closest('.album-card');
      if (!card) return;
      event.preventDefault();
      contextMenus.push(card.getAttribute('data-gallery-card-key'));
    });
  }, { titles: TITLES, displayMode });
}

const focusedCardStop = page => page.evaluate(() => {
  const active = document.activeElement;
  return {
    card: active?.closest('.album-card')?.getAttribute('data-gallery-card-key') || active?.id || '',
    isCardTrigger: Boolean(active?.matches('.album-card__artbox-trigger')),
    label: active?.getAttribute('aria-label') || active?.textContent.trim() || '',
  };
});

for (const displayMode of ['cards', 'covers']) {
  test(`Tab moves card to card in ${displayMode} view without stopping on hover controls`, async ({ page }) => {
    await mountCards(page, displayMode);
    // The hover controls exist and are rendered on every card.
    await expect(page.locator('.gallery-source-action--hoard')).not.toHaveCount(0);
    await expect(page.locator('.gallery-source-action--new_arrivals')).not.toHaveCount(0);
    await expect(page.locator('.gallery-source-action--duplicate')).toHaveCount(3);

    await page.locator('#before-gallery').focus();
    const stops = [];
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press('Tab');
      stops.push(await focusedCardStop(page));
    }
    expect(stops).toEqual([
      ...TITLES.map((title, index) => ({ card: `card-${index}`, isCardTrigger: true, label: `Open ${title} tracklist` })),
      { card: 'after-gallery', isCardTrigger: false, label: 'After' },
    ]);

    // Shift+Tab walks the same three stops back.
    const reverse = [];
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press('Shift+Tab');
      reverse.push((await focusedCardStop(page)).card);
    }
    expect(reverse).toEqual(['card-2', 'card-1', 'card-0']);
  });
}

test('a keyboard-focused card still reveals its markers, opens with Enter and offers actions with Shift+F10', async ({ page }) => {
  await mountCards(page, 'cards');
  await page.locator('#before-gallery').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const second = page.locator('.album-card').nth(1);
  await expect(second.locator('.album-card__artbox-trigger')).toBeFocused();
  // Focus inside the card shows the same markers a pointer hover shows.
  await expect(second.locator('.gallery-card__source-actions--artwork .gallery-source-action--hoard')).toHaveCSS('opacity', '1');
  await expect(second.locator('.gallery-source-action--duplicate')).toHaveCSS('opacity', '1');

  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => opened)).toEqual(['album-1']);
  await page.keyboard.press('Shift+F10');
  await expect.poll(() => page.evaluate(() => contextMenus)).toEqual(['card-1']);

  // Pointer users keep the hover controls.
  await second.hover();
  await second.locator('.gallery-card__source-actions--artwork .gallery-source-action--hoard').click();
  await expect.poll(() => page.evaluate(() => opened)).toEqual(['album-1', 'album-1']);
});
