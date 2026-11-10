const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-10): "can you do a dot in the middle of radio button selected state, right now only outline selected".
// Every shared RadioOption shows a filled center dot in the theme's play/accent color when selected, in light and
// dark themes, keeps the hand cursor, and takes no hover outline.
const root = path.join(__dirname, '..', '..');

for (const theme of [
  { name: 'dark', background: '#151515', ink: '#eeeeee', play: 'rgb(52, 202, 120)' },
  { name: 'light', background: '#f6f6f6', ink: '#1a1a1a', play: 'rgb(30, 110, 200)' },
]) {
  test(`a selected shared radio shows a filled accent dot (${theme.name} theme)`, async ({ page }) => {
    await page.setContent(`<!doctype html><html data-appearance-palette="test" data-appearance-mode="${theme.name}"><body style="background:${theme.background};color:${theme.ink}">
      <fieldset class="ui-radio-group"><label class="ui-radio-option"><input type="radio" name="mode" value="a" checked><span>Album folders</span></label>
      <label class="ui-radio-option"><input type="radio" name="mode" value="b"><span>Special path</span></label></fieldset></body></html>`);
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/button-component.css') });
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css/appearance-backgrounds.css') });
    await page.addStyleTag({ content: `:root { --appearance-play: ${theme.play}; --appearance-ink: ${theme.ink}; }` });
    const [selected, other] = await page.locator('input[type="radio"]').all();
    // parity-check: allow-read-only-measurement-evaluate -- read the rendered dot and ring of each radio
    const look = (radio) => radio.evaluate((input) => {
      const dot = getComputedStyle(input, '::before');
      const style = getComputedStyle(input);
      return { dotColor: dot.backgroundColor, dotScale: new DOMMatrix(dot.transform === 'none' ? undefined : dot.transform).a,
        ring: style.borderTopColor, cursor: style.cursor, outline: style.outlineStyle };
    });
    await expect.poll(async () => (await look(selected)).dotScale).toBe(1);
    expect(await look(selected)).toMatchObject({ dotColor: theme.play, ring: theme.play, cursor: 'pointer' });
    expect((await look(other)).dotScale).toBe(0);

    await other.hover();
    expect((await look(other)).outline).toBe('none');
    await other.click();
    await expect.poll(async () => (await look(other)).dotScale).toBe(1);
    expect((await look(selected)).dotScale).toBe(0);
    await expect(page.locator('label.ui-radio-option').first()).toHaveCSS('cursor', 'pointer');
  });
}
