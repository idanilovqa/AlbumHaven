const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (sandbox2): a staged pasted image is removed with the same delete control as a local art card: the
// hollow red delete icon, shown only while the card is hovered or holds keyboard focus.
const root = path.join(__dirname, '..', '..');

test('a pasted image card uses the art card delete control, shown on hover and focus only', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body style="background:#101a29;padding:24px">
    <section id="cover-lookup-modal"><div class="cover-lookup-gallery" id="gallery"
      style="display:grid;grid-template-columns:repeat(2,180px);gap:24px"></div></section>
  </body></html>`);
  for (const file of ['runtime/base-layout.css', 'appearance-backgrounds.css', 'button-component.css',
    'runtime/cover-lookup-modal.css', 'runtime/cover-lookup-drawer-and-related.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ content: `
    var state = { coverLookup: { tasks: [], modal: { possibleMatches: [], album: null } } };
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }
    function buildCoverUrl() { return 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; }
  ` });
  await page.addScriptTag({ path: path.join(root, 'music_app/static/js/runtime/cover-lookup-modal-and-drawer.js') });
  await page.evaluate(() => {
    document.getElementById('gallery').innerHTML = buildCoverLookupCard({ candidate_cover_ref: 'local-ref', filename: 'front.jpg' }, 'local')
      + buildCoverLookupCard({ id: 'pasted-1', object_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', filename: 'Pasted' }, 'pasted');
  });
  const local = page.locator('[data-delete-local-cover]');
  const pasted = page.locator('[data-remove-pasted-cover="pasted-1"]');
  const iconMarkup = (button) => button.evaluate((element) => element.querySelector('svg')?.outerHTML || element.innerHTML.trim());
  expect(await iconMarkup(pasted)).toBe(await iconMarkup(local));
  expect(await pasted.getAttribute('class')).toBe(await local.getAttribute('class'));

  await page.mouse.move(2, 2);
  await expect(pasted).toHaveCSS('opacity', '0');
  await page.locator('[data-select-pasted-cover="pasted-1"]').hover();
  await expect(pasted).toHaveCSS('opacity', '1');
  await page.mouse.move(2, 2);
  await expect(pasted).toHaveCSS('opacity', '0');
  await pasted.focus();
  await expect(pasted).toHaveCSS('opacity', '1');
});
