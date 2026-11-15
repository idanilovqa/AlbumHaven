const path = require('node:path');
const { test, expect } = require('@playwright/test');

// INT-028 (owner, 11-08): a suggested cover that is also selected shows both frames — the blue selection and the
// green suggestion ring. Selecting it never hides the green one.
const root = path.join(__dirname, '..', '..');

test('a selected suggested cover keeps the green suggestion ring around the blue selection', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<!doctype html><html><body style="padding:40px">
    <div class="cover-lookup-gallery" style="display:flex;gap:24px">
      <button class="cover-lookup-art-card is-suggested" id="suggested">Suggested</button>
      <button class="cover-lookup-art-card is-active" id="selected">Selected</button>
      <button class="cover-lookup-art-card is-suggested is-active" id="both">Both</button>
    </div></body></html>`);
  await page.addStyleTag({ path: path.join(root, 'music_app/static/css/runtime/cover-lookup-modal.css') });
  const frames = await page.evaluate(() => Object.fromEntries(['suggested', 'selected', 'both'].map((id) => {
    const style = getComputedStyle(document.getElementById(id));
    return [id, { outline: style.outlineColor, shadow: style.boxShadow }];
  })));
  const blue = 'rgb(96, 165, 250)';
  const green = 'rgb(82, 215, 170)';
  expect(frames.selected.outline).toBe(blue);
  expect(frames.suggested.outline).toBe(green);
  expect(frames.both.outline).toBe(blue);
  expect(frames.both.shadow).toContain(green);
});
