const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-08): the navigation-tree header stays visible when the user scrolls down the tree.
const root = path.join(__dirname, '..', '..');
const items = Array.from({ length: 120 }, (_, index) => `<a class="artist-link navigation-tree-item" href="#">Artist ${index + 1}</a>`).join('');
const markup = `<div class="shell-layout" id="app-shell" style="display:grid;grid-template-rows:0 600px;grid-template-columns:240px 1fr">
  <aside class="sidebar shell-navigation-rail" id="shell-navigation-rail">
    <div id="artist-tree-expanded">
      <div class="sidebar-top shell-navigation-rail-header"><button class="action-button shell-navigation-rail-toggle" aria-label="Collapse Artist Tree">‹</button><h2 class="desktop-artists-heading">Artists</h2></div>
      <div class="artist-list navigation-tree" id="sidebar-list">${items}</div>
    </div>
  </aside>
  <main class="shell-main-surface"></main>
</div>`;

test('the navigation-tree header stays at the top of the side panel while the tree scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.setContent(`<!doctype html><html><body>${markup}</body></html>`);
  for (const file of ['base.css', 'runtime/base-layout.css', 'app-chrome.css', 'appearance-backgrounds.css', 'button-component.css', 'navigation-tree.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  const read = () => page.evaluate(() => {
    const rail = document.getElementById('shell-navigation-rail');
    const header = rail.querySelector('.shell-navigation-rail-header');
    const heading = header.querySelector('h2').getBoundingClientRect();
    const firstItem = rail.querySelector('#sidebar-list > :first-child').getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    // The element painted at the heading's center must be the heading itself, never a tree row under it.
    const painted = document.elementFromPoint(heading.left + 4, heading.top + heading.height / 2);
    return {
      railTop: rail.getBoundingClientRect().top, headingTop: heading.top, headerBottom: headerBox.bottom,
      firstItemTop: firstItem.top, headingPainted: Boolean(painted?.closest('.shell-navigation-rail-header')),
      background: getComputedStyle(header).backgroundColor,
    };
  });
  const before = await read();
  await page.locator('#shell-navigation-rail').evaluate((rail) => { rail.scrollTop = 900; });
  const after = await read();
  expect(after.headingTop).toBeCloseTo(before.headingTop, 0);
  expect(after.headingPainted).toBe(true);
  expect(after.firstItemTop).toBeLessThan(after.headerBottom);
  expect(after.background).not.toBe('rgba(0, 0, 0, 0)');
});
