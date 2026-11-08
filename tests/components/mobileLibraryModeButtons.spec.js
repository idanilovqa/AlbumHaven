const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { renderActionButton } = require(path.join(__dirname, '..', '..', 'music_app/static/js/button-component.js'));

// Owner (11-08): in the mobile library drawer only the selected mode (Artists or Loose Tracks) is expanded with
// its label; the other is an icon button. Markup mirrors index.html's .mobile-artists-mode group.
const root = path.join(__dirname, '..', '..');
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13"/></svg>';
const mode = (label, value, pressed) => renderActionButton({
  ariaLabel: label, title: label, className: 'mobile-artists-mode-button',
  attributes: { 'aria-pressed': String(pressed), 'data-navigation-mode': value },
}).replace('</span></button>', `${icon}<span>${label}</span></span></button>`);

for (const selected of ['artists', 'collections']) {
  test(`mobile library drawer expands only the selected mode (${selected})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(`<!doctype html><html><body><div class="shell-layout"><aside class="sidebar shell-navigation-rail"><div id="artist-tree-expanded">
      <div class="sidebar-top shell-navigation-rail-header"><div class="mobile-artists-mode" role="group" aria-label="Library navigation">${mode('Artists', 'artists', selected === 'artists')}${mode('Loose Tracks', 'collections', selected === 'collections')}</div></div>
    </div></aside></div></body></html>`);
    for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
    }
    const buttons = await page.locator('[data-navigation-mode]').evaluateAll((nodes) => nodes.map((node) => ({
      mode: node.dataset.navigationMode, width: node.getBoundingClientRect().width,
      labelShown: getComputedStyle(node.querySelector('span > span')).display !== 'none',
      name: node.getAttribute('aria-label'),
    })));
    for (const button of buttons) {
      const isSelected = button.mode === selected;
      expect(button.labelShown, button.mode).toBe(isSelected);
      if (isSelected) expect(button.width).toBeGreaterThan(60);
      else expect(Math.round(button.width)).toBe(40);
      expect(button.name).toBeTruthy();
    }
  });
}
