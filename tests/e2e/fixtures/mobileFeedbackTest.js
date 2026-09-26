import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MobileLayoutPage } from '../poms/mobileLayoutPage.js';

export const test = base.extend({
  app: async ({ page }, use) => {
    const response = await fetch(`${process.env.MOBILE_LAYOUT_CONTROL_URL}/reset`, { method: 'POST' });
    expect(response.ok).toBeTruthy();
    const app = new MobileLayoutPage(page);
    await app.signIn('rendref', 'Phase Seven Owner Passphrase 2026!');
    await expect(app.galleryContextName).toHaveText('Rendref');
    await expect(app.homePanel).toHaveText('Nothing to show yet. Work in progress.');
    await use(app);
  },
  snapshot: async ({ page }, use) => {
    const directory = path.resolve('test-results/mobile-screenshots');
    await fs.mkdir(directory, { recursive: true });
    await use(async name => {
      if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError('Invalid screenshot name');
      await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true, animations: 'disabled' });
    });
  },
});
export { expect };
