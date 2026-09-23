const path = require('node:path');
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.setContent(`<button id="before">Before</button>
    <div id="list" style="height:340px;width:320px;overflow:auto"></div>
    <button id="after">After</button>
    <style>#list button { display:block; height:68px; width:100%; box-sizing:border-box; }</style>`);
  await page.addScriptTag({ path: path.resolve(__dirname, '../../music_app/static/js/runtime/problematic-files-virtual-list.js') });
  await page.evaluate(() => {
    window.virtualList = window.ProblematicFilesVirtualList.create({
      list: document.getElementById('list'),
      renderRow: item => `<button data-problematic-album-key="${item.key}">${item.key}</button>`,
    });
    window.virtualList.render(Array.from({ length: 40 }, (_, index) => ({ key: `album-${index}` })), 'album-0');
  });
});

test('scroll and resize retain focused row identity within unchanged and overlapping windows', async ({ page }) => {
  const row = page.locator('[data-problematic-album-key="album-3"]');
  await row.focus();
  const original = await row.elementHandle();
  for (const offset of [1, 68]) {
    await page.locator('#list').evaluate(async (list, offset) => {
      list.scrollTop = offset;
      list.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, offset);
    await expect(row).toBeFocused();
    expect(await original.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
  }
  await page.setViewportSize({ width: 1020, height: 800 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(row).toBeFocused();
  expect(await original.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
});

test('native Tab and ShiftTab traverse past the initial window and leave at the true ends', async ({ page }) => {
  await page.locator('#before').focus();
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab');
    await expect(page.locator(`[data-problematic-album-key="album-${index}"]`)).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(page.locator('#after')).toBeFocused();
  for (let index = 39; index >= 0; index -= 1) {
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator(`[data-problematic-album-key="album-${index}"]`)).toBeFocused();
  }
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#before')).toBeFocused();
});
