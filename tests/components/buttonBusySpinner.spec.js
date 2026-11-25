const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// A busy Button spins on every page that loads the component, not only inside the library document.
const root = path.join(__dirname, '..', '..');
const templates = path.join(root, 'music_app', 'templates');

// The stylesheets a template links, in its order, following its includes.
function stylesheets(template) {
  const source = fs.readFileSync(path.join(templates, template), 'utf8');
  const found = [];
  const pattern = /\{%\s*include\s+["']([^"']+)["']\s*%\}|<link[^>]+rel="stylesheet"[^>]*>/g;
  for (const [tag, include] of source.matchAll(pattern)) {
    if (include) { found.push(...stylesheets(include)); continue; }
    const href = tag.match(/filename='(css\/[^']+)'/)?.[1] || tag.match(/href="\/static\/(css\/[^"?{]+)/)?.[1];
    if (href) found.push(href);
  }
  return found;
}

const hosts = ['account.html', 'admin-members.html', 'admin-account-detail.html', 'admin-server.html', 'index.html'];

test('a busy text Button spins on every page that hosts the component', async ({ browser }) => {
  for (const template of hosts) {
    const page = await browser.newPage({ reducedMotion: 'no-preference' });
    await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>');
    for (const file of stylesheets(template)) {
      await page.addStyleTag({ path: path.join(root, 'music_app', 'static', file) });
    }
    await page.addScriptTag({ path: path.join(root, 'music_app/static/js/button-component.js') });
    await page.evaluate(() => {
      const host = document.getElementById('host');
      host.innerHTML = window.ButtonComponent.renderButton({ label: 'Save', variant: 'primary' });
      window.ButtonComponent.setBusy(host.querySelector('button'), true);
    });
    const button = page.getByRole('button', { name: 'Save' });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-busy', 'true');

    const turn = () => button.evaluate((node) => getComputedStyle(node.querySelector('.ui-button__content'), '::before').transform);
    const first = await turn();
    await page.waitForTimeout(150);
    const second = await turn();
    expect.soft(first, `${template}: the spinner is drawn and rotated`).not.toBe('none');
    expect.soft(second, `${template}: the spinner keeps turning`).not.toBe(first);
    await page.close();
  }
});
