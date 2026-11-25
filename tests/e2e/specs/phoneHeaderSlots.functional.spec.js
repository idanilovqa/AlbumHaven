import { expect, test } from '../support/baseFixtures.js';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

// Owner rule: every piece of the shared GalleryBar has its own place and order and looks the same on every page.
async function readHeaderSlots(page) {
  // parity-check: allow-read-only-measurement-evaluate -- a zero-size inline probe reads the main-text baseline
  return page.evaluate(() => {
    const shown = (el) => Boolean(el && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const pageHeader = document.getElementById('mobile-page-header');
    const header = shown(pageHeader) ? pageHeader : document.querySelector('[data-gallery-bar-instance="gallery"]');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const menu = [...header.querySelectorAll('#mobile-library-button, #mobile-page-library-button, #mobile-settings-button')].find(shown);
    const back = [...header.querySelectorAll('[data-mobile-back]')].find(shown);
    const title = header.querySelector('#mobile-page-title, [data-gallery-context-name]');
    const textNode = [...title.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim()) || title;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    title.appendChild(probe);
    const baseline = Math.round(probe.getBoundingClientRect().bottom);
    probe.remove();
    return {
      menu: menu ? box(menu) : null,
      menuIcon: menu ? box(menu.querySelector('svg')) : null,
      back: back ? box(back) : null,
      text: title.textContent.trim(),
      textX: Math.round(range.getBoundingClientRect().x),
      baseline,
    };
  });
}

for (const width of [360, 390, 412]) {
  test.describe(`phone header slots at ${width}px`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 844 } });

    test(`FTC-PHONE-HEADER-SLOTS-001 the hamburger and main text keep one place on Home, an artist, Loose Tracks and Settings at ${width}px`, { tag: '@area:gallery-search' }, async ({
      galleryActions,
      page,
      stepLogger,
    }) => {
      const mobileLayout = new MobileLayoutPage(page);
      const slots = {};
      await stepLogger.step('Home', async () => {
        await galleryActions.goto('/');
        await expect(mobileLayout.home).toBeVisible();
        await expect(mobileLayout.libraryButton).toBeVisible();
        slots.home = await readHeaderSlots(page);
      });
      await stepLogger.step('An artist page', async () => {
        await galleryActions.goto('/?surface=albums&artist=Metallica');
        await expect(mobileLayout.galleryContextName).toHaveText('Metallica');
        slots.artist = await readHeaderSlots(page);
      });
      await stepLogger.step('Loose Tracks from the drawer', async () => {
        await mobileLayout.libraryButton.click();
        await mobileLayout.artistRail.locator('[data-navigation-mode="collections"]').click();
        await expect(page.locator('#mobile-page-title')).toHaveText('Loose Tracks');
        slots.looseTracks = await readHeaderSlots(page);
      });
      for (const tab of ['problematic-files', 'rules']) {
        await stepLogger.step(`Settings: ${tab}`, async () => {
          await galleryActions.goto(`/?settings=${tab}`);
          await expect(page.locator('#mobile-settings-button')).toBeVisible();
          await expect(page.locator('#mobile-page-title')).not.toBeEmpty();
          slots[tab] = await readHeaderSlots(page);
        });
      }
      await stepLogger.step('Every page puts each header piece in the same place', async () => {
        const reference = slots.artist;
        const backs = Object.values(slots).filter((entry) => entry.back);
        for (const [name, entry] of Object.entries(slots)) {
          const label = `${name}: ${JSON.stringify(entry)}`;
          expect(entry.menu, label).toEqual(reference.menu);
          expect(entry.menuIcon, label).toEqual(reference.menuIcon);
          expect(entry.baseline, label).toBe(reference.baseline);
          if (entry.back) {
            expect(entry.back, label).toEqual(backs[0].back);
            // The Back slot follows the hamburger; the main text follows the Back slot.
            expect(entry.back.x, label).toBeGreaterThanOrEqual(entry.menu.x + entry.menu.width);
            expect(entry.textX, label).toBe(backs[0].textX);
          } else {
            expect(entry.textX, label).toBe(reference.textX);
          }
        }
      });
    });
  });
}
