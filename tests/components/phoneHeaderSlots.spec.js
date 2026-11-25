const path = require('node:path');
const { test, expect } = require('@playwright/test');

const cssRoot = path.join(__dirname, '..', '..', 'music_app', 'static', 'css');
const STYLES = ['appearance-backgrounds.css', 'button-component.css', 'runtime/base-layout.css', 'runtime/utilities.css',
  'runtime/non-album-and-player.css', 'app-chrome.css', 'gallery-main.css', 'mobile-layout.css'];
const MENU_ICON = '<span class="ui-button__content action-button__content"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>';
const BUTTON = 'button ui-button ui-button--icon ui-button--medium action-button action-button--bare mobile-bar-action';

// The GalleryBar markup the templates render (partials/gallery-bar.html): the Gallery instance (Home and artist pages)
// and the mobile page instance (Loose Tracks, collections, Settings).
const galleryBar = (title, summary) => `<header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary">
  <button type="button" class="${BUTTON}" id="mobile-library-button" aria-label="Open library navigation">${MENU_ICON}</button>
  <div class="gallery-bar__context"><div class="gallery-bar__title"><span data-gallery-context-name>${title}</span></div><span class="gallery-bar__summary" data-gallery-context-summary>${summary}</span></div>
  <div class="gallery-bar__actions"><button type="button" class="button ui-button ui-button--icon ui-button--medium action-button gallery-action-button" aria-label="Artist family">F</button></div>
</header>`;
const pageHeader = ({ menu, back = false, title, summary = '' }) => `<header id="mobile-page-header" class="gallery-bar mobile-page-header" data-gallery-bar data-gallery-bar-instance="page" data-gallery-bar-layout="mobile-primary">
  <button type="button" class="${BUTTON}" id="mobile-settings-button" aria-label="Settings sections"${menu === 'settings' ? '' : ' hidden'}>${MENU_ICON}</button>
  <button type="button" class="${BUTTON}" id="mobile-page-library-button" aria-label="Open library navigation"${menu === 'library' ? '' : ' hidden'}>${MENU_ICON}</button>
  <button type="button" class="${BUTTON} page-gallery-bar__back" id="mobile-back-button" aria-label="Back" data-mobile-back="1"${back ? '' : ' hidden'}><span class="ui-button__content action-button__content"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg></span></button>
  <div class="gallery-bar__context"><h1 class="gallery-bar__title" id="mobile-page-title">${title}</h1><p class="gallery-bar__summary" id="mobile-page-summary">${summary}</p></div>
</header>`;

const PAGES = {
  home: `<main id="shell-main-surface" class="shell-main-surface has-mobile-home"><section id="mobile-home" class="mobile-home">${galleryBar('Listener', '')}</section></main>`,
  artist: `<main id="shell-main-surface" class="shell-main-surface">${galleryBar('Metallica', '10 albums')}</main>`,
  looseTracks: `<main id="shell-main-surface" class="shell-main-surface has-mobile-page">${pageHeader({ menu: 'library', title: 'Loose Tracks', summary: '18 tracks' })}<div id="mobile-page-outlet" data-mobile-page-kind="non-album"></div></main>`,
  settings: `<main id="shell-main-surface" class="shell-main-surface has-mobile-page">${pageHeader({ menu: 'settings', title: 'Problematic Files' })}<div id="mobile-page-outlet" data-mobile-page-kind="utilities"></div></main>`,
};

async function measure(page, width, markup) {
  await page.setViewportSize({ width, height: 700 });
  await page.setContent(`<!doctype html><html data-client-profile="mobile"><body><div class="shell-layout">${markup}</div></body></html>`);
  for (const file of STYLES) await page.addStyleTag({ path: path.join(cssRoot, file) });
  return page.evaluate(() => {
    const shown = (el) => Boolean(el && !el.hidden && el.getClientRects().length && getComputedStyle(el).display !== 'none');
    const pageHeaderNode = document.getElementById('mobile-page-header');
    const header = pageHeaderNode || document.querySelector('[data-gallery-bar-instance="gallery"]');
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const menu = [...header.querySelectorAll('#mobile-library-button, #mobile-page-library-button, #mobile-settings-button')].find(shown);
    const title = header.querySelector('#mobile-page-title, [data-gallery-context-name]');
    const range = document.createRange();
    range.selectNodeContents(title);
    return { menu: box(menu), menuIcon: box(menu.querySelector('svg')), textX: range.getBoundingClientRect().x };
  });
}

for (const width of [360, 390, 412]) {
  test(`phone GalleryBar keeps the hamburger and the main text in the same place on every page at ${width}px`, async ({ page }) => {
    const measured = {};
    for (const [name, markup] of Object.entries(PAGES)) measured[name] = await measure(page, width, markup);
    const reference = measured.artist;
    for (const [name, slots] of Object.entries(measured)) {
      expect(slots.menu, `${name} hamburger`).toEqual(reference.menu);
      expect(slots.menuIcon, `${name} hamburger icon`).toEqual(reference.menuIcon);
      expect(slots.textX, `${name} main text start`).toBe(reference.textX);
    }
  });
}
