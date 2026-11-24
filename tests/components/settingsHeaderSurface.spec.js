const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (2026-11-22): Settings headers work as the Gallery's does. The bar is outside the scrolling body, so
// nothing shows above, beside or behind it, and its title starts where the Gallery's does.
const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, 'music_app', file), 'utf8');

const bar = (backClass) => `<header class="gallery-bar page-gallery-bar" data-gallery-bar data-gallery-bar-instance="page" data-gallery-bar-layout="mobile-primary">
  <button class="action-button action-button--bare mobile-bar-action" data-settings-nav-toggle="1" aria-label="Account navigation"></button>
  <a class="action-button action-button--bare page-gallery-bar__back ${backClass}" href="/" aria-label="Back">B</a>
  <div class="gallery-bar__context"><h1 class="gallery-bar__title">Password</h1><p class="gallery-bar__summary">Account</p></div>
  <div class="gallery-bar__actions"></div></header>`;

// The page's own outlet markup, so the test follows the template and can't keep a structure the app doesn't have.
function settingsPage() {
  const template = read('templates/account.html');
  const start = template.indexOf('<div class="settings-outlet');
  const end = template.indexOf('</main>', start);
  const rows = Array.from({ length: 60 }, (_, index) => `<p data-row>Row ${index}</p>`).join('');
  const outlet = template.slice(start, end)
    .replace(/\{\{\s*page_gallery_bar\([^\n]*\}\}/, bar('page-gallery-bar__back--narrow-only'))
    .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, '')
    .replace('<section class="account-section" id="active-sessions"', `${rows}$&`);
  return `<!doctype html><html><body style="margin:0"><main class="settings-host settings-shell" data-settings-host>
    <header class="shell-app-bar"></header><nav class="settings-nav"></nav>${outlet}</main></body></html>`;
}

async function mount(page, width, html) {
  await page.setViewportSize({ width, height: 700 });
  await page.setContent(html);
  // The order account.html loads them in.
  for (const file of ['account', 'admin-members', 'settings-navigation', 'app-chrome', 'button-component', 'gallery-main', 'mobile-layout']) {
    await page.addStyleTag({ path: path.join(root, `music_app/static/css/${file}.css`) });
  }
}

for (const width of [360, 412, 900, 901, 1280]) {
  test(`the Settings bar stays above its scrolling body, with no gap showing it (${width}px)`, async ({ page }) => {
    await mount(page, width, settingsPage());
    const seen = await page.evaluate(async () => {
      const header = document.querySelector('[data-gallery-bar]');
      const before = header.getBoundingClientRect();
      const scroller = [...document.querySelectorAll('.settings-outlet, .settings-outlet *')]
        .find((node) => node.scrollHeight > node.clientHeight + 100 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
      scroller.scrollTop = 400;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = header.getBoundingClientRect();
      const body = scroller.getBoundingClientRect();
      const surface = document.querySelector('.settings-outlet').getBoundingClientRect();
      // Every point from the surface's top to the body's top, including the gutters and the bar's corners.
      const leaks = [];
      for (let y = Math.ceil(surface.top) + 1; y < after.bottom - 1; y += 2) {
        for (let x = Math.ceil(surface.left) + 1; x < surface.right - 1; x += 8) {
          if (document.elementsFromPoint(x, y).some((node) => node.matches('[data-row], .account-section, .account-section *'))) leaks.push([x, y]);
        }
      }
      return {
        scrolled: scroller.scrollTop,
        barInsideScroller: scroller.contains(header),
        moved: Math.abs(after.top - before.top),
        bodyStartsBelowBar: body.top >= after.bottom - 0.5,
        leaks: leaks.slice(0, 5),
      };
    });
    expect(seen.scrolled).toBeGreaterThan(300);
    expect(seen).toMatchObject({ barInsideScroller: false, bodyStartsBelowBar: true, leaks: [] });
    expect(seen.moved).toBeLessThanOrEqual(0.5);
  });
}

test('on desktop a hidden Back reserves no space before the title; a visible Back still does', async ({ page }) => {
  await mount(page, 1280, `<!doctype html><html><body><main class="settings-host">${bar('page-gallery-bar__back--narrow-only')}${bar('')}</main></body></html>`);
  const offsets = await page.locator('[data-gallery-bar]').evaluateAll((bars) => bars.map((node) => (
    node.querySelector('.gallery-bar__title').getBoundingClientRect().left - node.getBoundingClientRect().left
  )));
  expect(offsets[0]).toBeLessThanOrEqual(1);
  expect(offsets[1]).toBeGreaterThanOrEqual(40);
});
